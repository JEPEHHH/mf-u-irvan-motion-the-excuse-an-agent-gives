// The scrape gateway's process: what grader/scrape/bundle.ts bundles into scrape-gateway.mjs and the
// gateway container runs (`node /bot/scrape-gateway.mjs` in the pinned node22 image, the bundle's
// directory mounted read-only at /bot). It reads its config, starts grader/scrape/gateway.ts, says it
// is ready, and on SIGTERM (or SIGINT) ends the trial: nothing new is taken, what is open is settled
// as it stands, the record is written, and it exits.
//
// The container runs with `--log-driver none`, so everything the harness learns is in files:
//   /config/gateway.json     the config (ScrapeGatewayConfig, agent-fun/scrape-gateway-config/v1),
//                            read-only; a file group or others can write is refused, since it holds
//                            the leaves' keys. It never holds the heat CA's key (grader/scrape/ca.ts)
//   /record/ready.json       {"port": n}, written once listening, after the warm upstreams are open
//                            when `upstream` is "warm". The cassette's t_us count from here
//   /record/bodies/<sha256>  each distinct decoded upstream body the cassette names, written first
//   /record/cassette.json    the cassette's canonical JSON (agent-fun/scrape-cassette/v1), no trailing
//                            newline, written last and whole (renamed into place)
//   /record/error.json       {"error": message} when the gateway could not start, or crashed
// Exit: 0 once the record is written after SIGTERM or SIGINT; 1 when the trial crashed or the record
// could not be written; 2 when it could not start (its environment, its config, its port, or a warm
// upstream).
//
// The environment:
//   MAKEFUN_CONFIG_DIR     default /config
//   MAKEFUN_RECORD_DIR     default /record
//   MAKEFUN_GATEWAY_HOST   the bind address, default 0.0.0.0 (a test's 127.0.0.1); the port is the
//                           config's listen_port

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cassetteJson, createScrapeGateway, parseScrapeGatewayConfig, ScrapeGatewayConfigError, type ScrapeGateway, type ScrapeGatewayConfig, type ScrapeRecording } from './gateway.ts';

export {
  canonicalJson,
  cassetteJson,
  cassetteTotals,
  parseScrapeGatewayConfig,
  SCRAPE_CASSETTE_FORMAT,
  SCRAPE_GATEWAY_CONFIG_FORMAT,
  ScrapeGatewayConfigError,
  type ScrapeCassette,
  type ScrapeCassetteConnection,
  type ScrapeCassetteEntry,
  type ScrapeCassetteTotals,
  type ScrapeGatewayConfig,
  type ScrapeHostConfig,
  type ScrapeOutcome,
  type ScrapeRecording,
  type ScrapeRoute,
} from './gateway.ts';

export const CONFIG_FILE = 'gateway.json';
export const READY_FILE = 'ready.json';
export const CASSETTE_FILE = 'cassette.json';
export const BODIES_DIR = 'bodies';
export const ERROR_FILE = 'error.json';

export class ScrapeGatewayStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrapeGatewayStartError';
  }
}

export interface ScrapeGatewayPaths {
  configDir: string;
  recordDir: string;
  /** The bind address. */
  host: string;
}

/** Where the process reads and writes, and what it binds (see the header). */
export function scrapeGatewayPaths(env: Readonly<Record<string, string | undefined>>): ScrapeGatewayPaths {
  const host = env.MAKEFUN_GATEWAY_HOST || '0.0.0.0';
  if (isIP(host) === 0) throw new ScrapeGatewayStartError(`MAKEFUN_GATEWAY_HOST ${JSON.stringify(host)} is not an IP address`);
  return { configDir: env.MAKEFUN_CONFIG_DIR || '/config', recordDir: env.MAKEFUN_RECORD_DIR || '/record', host };
}

/** Read and check <configDir>/gateway.json: a file group and others cannot write, JSON, a ScrapeGatewayConfig. */
export function loadScrapeGatewayConfig(configDir: string, now: number = Date.now()): ScrapeGatewayConfig {
  const file = join(configDir, CONFIG_FILE);
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new ScrapeGatewayStartError(`${file} is not a file`);
    if ((st.mode & 0o022) !== 0) {
      throw new ScrapeGatewayStartError(`${file} is mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}: it holds the leaves' keys, so group and others may not write it`);
    }
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof ScrapeGatewayStartError) throw err;
    throw new ScrapeGatewayStartError(`cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ScrapeGatewayStartError(`${file} is not JSON`);
  }
  try {
    return parseScrapeGatewayConfig(raw, now);
  } catch (err) {
    if (err instanceof ScrapeGatewayConfigError) throw new ScrapeGatewayStartError(`${file} is not a scrape gateway config: ${err.message}`);
    throw err;
  }
}

/** Write a file whole or not at all. */
function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode: 0o644 });
  renameSync(tmp, file);
}

/** Write a trial's record into `recordDir`: every body under bodies/, then cassette.json. */
export function writeRecording(recordDir: string, recording: ScrapeRecording): void {
  const bodies = join(recordDir, BODIES_DIR);
  mkdirSync(bodies, { recursive: true });
  for (const [sha256, body] of recording.bodies) writeAtomic(join(bodies, sha256), body);
  writeAtomic(join(recordDir, CASSETTE_FILE), cassetteJson(recording.cassette));
}

function writeError(recordDir: string, message: string): void {
  try {
    mkdirSync(recordDir, { recursive: true });
    writeAtomic(join(recordDir, ERROR_FILE), `${JSON.stringify({ error: message })}\n`);
  } catch {
    // Nowhere left to say it: the exit code does.
  }
}

export interface RunningScrapeGateway {
  gateway: ScrapeGateway;
  port: number;
  /** End the trial and write its record (see the header): the record. */
  stop(): Promise<ScrapeRecording>;
}

/** Start the gateway a config describes and write the ready file (see the header). */
export async function startScrapeGateway(cfg: ScrapeGatewayConfig, paths: ScrapeGatewayPaths): Promise<RunningScrapeGateway> {
  mkdirSync(paths.recordDir, { recursive: true });
  const gateway = createScrapeGateway(cfg);
  let port: number;
  try {
    port = await gateway.start(paths.host);
  } catch (err) {
    throw new ScrapeGatewayStartError(`cannot start on ${paths.host}:${cfg.listen_port}: ${(err as Error).message}`);
  }
  writeAtomic(join(paths.recordDir, READY_FILE), `${JSON.stringify({ port })}\n`);
  let stopping: Promise<ScrapeRecording> | null = null;
  return {
    gateway,
    port,
    stop() {
      stopping ??= gateway.stop().then((recording) => {
        writeRecording(paths.recordDir, recording);
        return recording;
      });
      return stopping;
    },
  };
}

/** The process (see the header): resolves with its exit code. */
export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  let stopAsked = false;
  let wake: (() => void) | null = null;
  const onSignal = (): void => {
    stopAsked = true;
    wake?.();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  let paths: ScrapeGatewayPaths;
  try {
    paths = scrapeGatewayPaths(env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const failed = (message: string): void => {
    process.stderr.write(`${message}\n`);
    writeError(paths.recordDir, message);
  };
  let running: RunningScrapeGateway;
  try {
    running = await startScrapeGateway(loadScrapeGatewayConfig(paths.configDir), paths);
  } catch (err) {
    failed(err instanceof ScrapeGatewayStartError ? err.message : `the gateway could not start: ${(err as Error).name}: ${(err as Error).message}`);
    return 2;
  }
  const crashed = (err: unknown): void => {
    failed(`the gateway crashed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    process.exit(1);
  };
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);
  await new Promise<void>((done) => {
    if (stopAsked) done();
    else wake = done;
  });
  try {
    await running.stop();
  } catch (err) {
    failed(`the gateway could not write its record: ${(err as Error).message}`);
    return 1;
  }
  return 0;
}

function invokedAsMain(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(2),
  );
}
