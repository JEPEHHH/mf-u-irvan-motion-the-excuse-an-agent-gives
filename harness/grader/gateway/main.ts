// The gateway forwarder's process: what grader/gateway/bundle.ts bundles into gateway.mjs and the
// forwarder container runs (`node /bot/gateway.mjs`, the bundle's directory mounted read-only). It
// reads its config, starts grader/gateway/server.ts, says it is ready, and on SIGTERM (or SIGINT) ends
// the trial: every exchange settled, the result written, exit.
//
// The container runs with `--log-driver none`, so everything the harness learns is in files:
//   /config/gateway.json        the config (GatewayConfig), read-only: a config group or others can
//                               write is refused. grader/agent.ts writeGatewayConfig writes it 0444
//                               in a 0711 directory under a 0700 host one, so the forwarder, uid
//                               65534, can read it and no other host user can reach it (0400 under the
//                               process driver, where the forwarder is the harness's own user;
//                               tests/integration/docker-reclaim.test.ts forwarder-config proves the
//                               docker case). LIVE it names masq's origin (a house-paid trial's
//                               upstream, upstream.ts; a test's fake instead) and holds the trial's
//                               masq key in `key`; or, on the `router` adapter (the house lane of a
//                               target whose models superbot-router serves, upstream.ts
//                               routerUpstream), the router's origin, speed and user, and the house
//                               lane's router key in `key`, held and masked as a masq key is; or, on
//                               the `provider` adapter (an entry lane on
//                               its entrant's own keys), the entrant's keys by provider in `keys`
//                               (its provider-lane entry secrets), its env-lane entry secrets and
//                               the org and project ids their key check learned in `mask`, and its
//                               env-lane entry secrets again in `request_mask`, no `key`
//                               (LiveGatewayConfig). REPLAY it may hold `request_mask`, the same
//                               env-lane secrets the live pass's held. The keys and secrets are here
//                               and nowhere else: never in the environment or argv, and never
//                               written out; every form of each (upstream.ts secretFormSet) is
//                               masked out of every answer and redacted out of every message
//                               (configSecrets), and `request_mask`'s out of each request before it
//                               is keyed (server.ts requestSecrets). The provider adapter runs on
//                               credential `entrant` (server.ts), never on lane `house`. Either mode
//                               may name `client`, the lane and its credential the model routes
//                               want (server.ts GatewayClient), never written out either
//   /config/blobs/              REPLAY: the blob store (server/blobstore.ts layout) holding the cassette
//                               cassette_sha256 names and every response body it lists: what LIVE
//                               left in /record/blobs
//   /record/ready               written once listening: {"schema":"agent-fun/gateway-ready/v1", mode,
//                               host, port, token, pid}. GET /__ready answers 200 only with `token`
//                               in x-makefun-ready-token
//   /record/blobs/              LIVE: the response bodies and the cassette, stored by sha256, and the
//                               request log (requests.ts) beside them. REPLAY: the request log too, when
//                               `capture_requests` is on (the default: ReplayGatewayConfig), put back in
//                               seq order from the entries the replayed requests consumed (server.ts
//                               ReplayGatewayOptions.captureRequests), so a replay of a trial recorded
//                               before its live pass kept one recovers the bytes it sent
//   /record/cassette.json       LIVE: the cassette's canonical JSON (its sha256 is cassette_sha256)
//   /record/replay-miss.json    REPLAY: written at the first miss ({route, request_key}), so the harness
//                               stops the entry
//   /record/result.json         written last (RESULT_FORMAT): mode, ok, faults, cassette_sha256 and the
//                               totals, the meter's account (LIVE) or the replay verdict (REPLAY), and
//                               requests_sha256 (the request log's blob, null when none was stored) with
//                               requests_fault (why a kept one was not; never a fault, never moves ok).
//                               A config or start-up failure writes it too, with ok false
// Exit: 0 once the result is written with no fault (a replay verdict, nondeterministic or not, is the
// file's to tell), 1 with a fault, 2 when it could not start.
//
// The environment (as grader/sandbox/types.ts MOUNT_POINTS names the mounts):
//   MAKEFUN_CONFIG_DIR     default /config
//   MAKEFUN_RECORD_DIR     default /record; set, it also means the process driver
//   MAKEFUN_GATEWAY_HOST   the bind address: 0.0.0.0 in a container, 127.0.0.1 under the process driver
//   MAKEFUN_GATEWAY_PORT   default 8080; 0 takes a free port (the ready file names it)

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Sha256Hex } from '../../contracts/primitives.ts';
import { BlobStore } from '../../server/blobstore.ts';
import { readCassette } from './cassette.ts';
import { GatewayPolicy } from './policy.ts';
import { createGateway, GATEWAY_PORT, redact, type Gateway, type GatewayResult } from './server.ts';
import { MaskValues, ProviderKeysConfig, UpstreamConfig, upstreamFromConfig, UpstreamKey, type Upstream } from './upstream.ts';

export const GATEWAY_CONFIG_FORMAT = 'agent-fun/gateway-config/v1';
export const GATEWAY_READY_SCHEMA = 'agent-fun/gateway-ready/v1';
export const GATEWAY_RESULT_FORMAT = 'agent-fun/gateway-result/v1';
export const CONFIG_FILE = 'gateway.json';
export const BLOBS_DIR = 'blobs';
export const READY_FILE = 'ready';
export const CASSETTE_FILE = 'cassette.json';
export const MISS_FILE = 'replay-miss.json';
export const RESULT_FILE = 'result.json';

const Trial = z.strictObject({ index: z.int().min(0), instance_sha256: Sha256Hex });

/** The lane's caller (server.ts GatewayClient): its token visible ASCII with no space, as a header carries it. */
export const GatewayClientConfig = z.strictObject({
  lane: z.enum(['entry', 'house']),
  token: z.string().regex(/^[\x21-\x7e]{16,256}$/, 'a client token is 16 to 256 visible ASCII characters'),
});

/**
 * LIVE: forward to `upstream` and record. On masq (a test's fake; none) it runs on `key`, the trial's
 * masq key, and on the router on `key`, the house lane's router key, and either holds no `keys`, `mask` or
 * `request_mask`; on `provider` it runs on `keys`, the
 * entrant's own keys by provider (an empty object: none pushed, every call answered 401), with `mask`,
 * the values masked with them (upstream.ts MaskValue: the entrant's env-lane entry secrets and the ids
 * their key check learned), and `request_mask` when the entrant holds env-lane secrets (masked out of
 * each request before it is keyed), holds no `key`, and serves no lane `house` (an entrant's key never
 * pays for a house target).
 */
export const LiveGatewayConfig = z
  .strictObject({
    format: z.literal(GATEWAY_CONFIG_FORMAT),
    mode: z.literal('live'),
    trial: Trial,
    policy: GatewayPolicy,
    upstream: UpstreamConfig,
    key: UpstreamKey.optional(),
    keys: ProviderKeysConfig.optional(),
    mask: MaskValues.optional(),
    request_mask: MaskValues.optional(),
    client: GatewayClientConfig.optional(),
  })
  .superRefine((cfg, ctx) => {
    const issue = (path: string, message: string): void => ctx.addIssue({ code: 'custom', path: [path], message });
    if (cfg.upstream.adapter === 'provider') {
      if (cfg.key !== undefined) issue('key', "the provider adapter runs on the entrant's keys by provider in `keys`, not on one `key`");
      if (cfg.keys === undefined) issue('keys', "the provider adapter needs `keys`, the entrant's own keys by provider (an empty object when none is pushed)");
      if (cfg.mask === undefined) issue('mask', 'the provider adapter needs `mask`, the values masked with its keys (an empty list when there are none)');
      if (cfg.client?.lane === 'house') issue('client', "the house lane runs on the house's key (masq, or superbot-router for a target the router serves): an entrant's own key never pays for it");
    } else {
      if (cfg.key === undefined) issue('key', `the ${cfg.upstream.adapter} adapter needs its key`);
      if (cfg.keys !== undefined) issue('keys', `the ${cfg.upstream.adapter} adapter runs on one \`key\`, not on keys by provider`);
      if (cfg.mask !== undefined) issue('mask', `the ${cfg.upstream.adapter} adapter takes no \`mask\`: its key is masked by itself`);
      if (cfg.request_mask !== undefined) issue('request_mask', `the ${cfg.upstream.adapter} adapter takes no \`request_mask\`: an entrant's entry secrets ride the provider adapter alone`);
    }
  });

/**
 * REPLAY: serve the cassette cassette_sha256 names from /config/blobs. No upstream, no key; `request_mask` the env-lane
 * entry secrets its live pass's forwarder masked out of each request before it keyed it, so this one keys each alike.
 * `capture_requests` (default true) keeps the requests the replay sends as its request log, in /record/blobs: the bytes
 * its live pass sent, recovered by replaying it (the log is stored only when the replay is the recording: no miss and
 * every entry consumed). false keeps none, as every replay did before the switch.
 */
export const ReplayGatewayConfig = z.strictObject({
  format: z.literal(GATEWAY_CONFIG_FORMAT),
  mode: z.literal('replay'),
  trial: Trial,
  policy: GatewayPolicy,
  cassette_sha256: Sha256Hex,
  request_mask: MaskValues.optional(),
  client: GatewayClientConfig.optional(),
  capture_requests: z.boolean().optional(),
});

export const GatewayConfig = z.discriminatedUnion('mode', [LiveGatewayConfig, ReplayGatewayConfig]);
export type GatewayConfigT = z.infer<typeof GatewayConfig>;

export class GatewayStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayStartError';
  }
}

export interface GatewayPaths {
  configDir: string;
  recordDir: string;
  host: string;
  port: number;
}

/** Where the process reads and writes, and where it listens (see the header). */
export function gatewayPaths(env: Readonly<Record<string, string | undefined>>): GatewayPaths {
  const processDriver = env.MAKEFUN_RECORD_DIR !== undefined && env.MAKEFUN_RECORD_DIR !== '';
  const portText = env.MAKEFUN_GATEWAY_PORT || String(GATEWAY_PORT);
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) throw new GatewayStartError(`MAKEFUN_GATEWAY_PORT ${JSON.stringify(portText)} is not a port`);
  return {
    configDir: env.MAKEFUN_CONFIG_DIR || '/config',
    recordDir: processDriver ? env.MAKEFUN_RECORD_DIR! : '/record',
    host: env.MAKEFUN_GATEWAY_HOST || (processDriver ? '127.0.0.1' : '0.0.0.0'),
    port: Number(portText),
  };
}

/** Every string in `v`: itself, or those its values hold (an object's or an array's, two levels down). */
function stringsIn(v: unknown, depth = 2): string[] {
  if (typeof v === 'string') return [v];
  if (v === null || typeof v !== 'object' || depth === 0) return [];
  return Object.values(v as Record<string, unknown>).flatMap((x) => stringsIn(x, depth - 1));
}

/**
 * The strings a config's `key`, `keys`, `mask`, `request_mask` and `client.token` hold, read off the raw JSON whatever
 * its shape (a malformed config may hold several keys, one per vendor, a key list, or them inside its `upstream`): what
 * a refusal to parse it must not repeat, in any form.
 */
function rawSecrets(raw: unknown): string[] {
  const doc = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const upstream = doc.upstream !== null && typeof doc.upstream === 'object' ? (doc.upstream as Record<string, unknown>) : {};
  const out: string[] = [];
  for (const held of [doc, upstream]) for (const field of ['key', 'keys', 'mask', 'request_mask']) out.push(...stringsIn(held[field]));
  const client = doc.client;
  if (client !== null && typeof client === 'object' && typeof (client as Record<string, unknown>).token === 'string') out.push((client as Record<string, string>).token);
  return out;
}

/** What a live config's adapter runs on and masks (upstream.ts upstreamFromConfig): its one key, or the entrant's keys with the mask values. */
function liveSecrets(cfg: Extract<GatewayConfigT, { mode: 'live' }>): string[] {
  if (cfg.upstream.adapter !== 'provider') return cfg.key === undefined ? [] : [cfg.key];
  return [...Object.values(cfg.keys ?? {}).filter((k): k is string => typeof k === 'string'), ...(cfg.mask ?? [])];
}

/** The secrets a config holds: its key, or keys and mask values (LIVE), its request_mask, and its client's token. */
function configSecrets(cfg: GatewayConfigT): string[] {
  return [...(cfg.mode === 'live' ? liveSecrets(cfg) : []), ...(cfg.request_mask ?? []), ...(cfg.client === undefined ? [] : [cfg.client.token])];
}

/** Read and check <configDir>/gateway.json: a file group and others cannot write (0444 at most), JSON, a GatewayConfig. */
export function loadGatewayConfig(configDir: string): GatewayConfigT {
  const file = join(configDir, CONFIG_FILE);
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new GatewayStartError(`${file} is not a file`);
    if ((st.mode & 0o022) !== 0) throw new GatewayStartError(`${file} is mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}: the config holds the key, so group and others may not write it (0444 at most)`);
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof GatewayStartError) throw err;
    throw new GatewayStartError(`cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GatewayStartError(`${file} is not JSON`);
  }
  const checked = GatewayConfig.safeParse(raw);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
    throw new GatewayStartError(redact(`${file} is not a gateway config: ${issues}`, rawSecrets(raw)));
  }
  return checked.data;
}

/** Write a file whole or not at all. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, file);
}

/** result.json's document. */
export function resultDocument(r: GatewayResult): Record<string, unknown> {
  return {
    format: GATEWAY_RESULT_FORMAT,
    mode: r.mode,
    ok: r.ok,
    faults: r.faults,
    cassette_sha256: r.cassette?.sha256 ?? null,
    totals: r.cassette?.cassette.totals ?? r.meter?.totals ?? null,
    meter: r.meter,
    replay: r.replay,
    // The request log (server.ts GatewayResult.requests): its blob in /record/blobs, or why none was stored (redacted
    // there, never a fault: `ok` and `faults` are the same with it or without it).
    requests_sha256: r.requests?.sha256 ?? null,
    requests_fault: r.requests_fault,
  };
}

function failureDocument(mode: 'live' | 'replay' | null, message: string): Record<string, unknown> {
  return { format: GATEWAY_RESULT_FORMAT, mode, ok: false, faults: [message], cassette_sha256: null, totals: null, meter: null, replay: null, requests_sha256: null, requests_fault: null };
}

export interface RunningGateway {
  gateway: Gateway;
  host: string;
  port: number;
  /** The ready file's token. */
  token: string;
  /** End the trial: close the forwarder and write result.json. */
  stop(): Promise<GatewayResult>;
}

export interface StartOptions {
  /** LIVE: use this adapter instead of the config's (tests). */
  upstream?: Upstream;
}

/** Start the forwarder a config describes and write the ready file (see the header). */
export async function startGateway(cfg: GatewayConfigT, paths: GatewayPaths, opts: StartOptions = {}): Promise<RunningGateway> {
  mkdirSync(paths.recordDir, { recursive: true });
  const token = randomBytes(16).toString('hex');
  let gateway: Gateway;
  const client = cfg.client === undefined ? {} : { client: cfg.client };
  const requestSecrets = cfg.request_mask === undefined || cfg.request_mask.length === 0 ? {} : { requestSecrets: cfg.request_mask };
  if (cfg.mode === 'live') {
    // A config built in code (not read by loadGatewayConfig) is held to the same: one key, or keys.
    const entrant = cfg.upstream.adapter === 'provider';
    if (!entrant && cfg.key === undefined) throw new GatewayStartError(`the ${cfg.upstream.adapter} adapter needs its key`);
    if (entrant && cfg.key !== undefined) throw new GatewayStartError("the provider adapter runs on the entrant's keys by provider in `keys`, not on one `key`");
    if (!entrant && cfg.request_mask !== undefined) throw new GatewayStartError(`the ${cfg.upstream.adapter} adapter takes no \`request_mask\`: an entrant's entry secrets ride the provider adapter alone`);
    const secrets = liveSecrets(cfg);
    let upstream: Upstream;
    try {
      upstream = opts.upstream ?? upstreamFromConfig(cfg.upstream, entrant ? { keys: cfg.keys ?? {}, mask: [...(cfg.mask ?? []), ...(cfg.request_mask ?? [])] } : cfg.key!);
    } catch (err) {
      throw new GatewayStartError(redact((err as Error).message, [...secrets, ...(cfg.request_mask ?? [])]));
    }
    gateway = createGateway({
      mode: 'live',
      policy: cfg.policy,
      trial: cfg.trial,
      upstream,
      credential: entrant ? 'entrant' : 'house',
      blobs: new BlobStore(join(paths.recordDir, BLOBS_DIR)),
      secrets,
      ...requestSecrets,
      readyToken: token,
      ...client,
      cassettePath: join(paths.recordDir, CASSETTE_FILE),
    });
  } else {
    const blobs = new BlobStore(join(paths.configDir, BLOBS_DIR));
    let cassette;
    try {
      cassette = await readCassette(blobs, cfg.cassette_sha256);
    } catch (err) {
      throw new GatewayStartError(`cannot read the cassette to replay: ${(err as Error).message}`);
    }
    if (cassette.trial.index !== cfg.trial.index || cassette.trial.instance_sha256 !== cfg.trial.instance_sha256) {
      throw new GatewayStartError(`the cassette was recorded on trial ${cassette.trial.index} (${cassette.trial.instance_sha256}), not trial ${cfg.trial.index} (${cfg.trial.instance_sha256})`);
    }
    let missed = false;
    gateway = createGateway({
      mode: 'replay',
      policy: cfg.policy,
      cassette,
      blobs,
      ...requestSecrets,
      // The replayed trial's request log (server.ts ReplayGatewayOptions.captureRequests), in /record/blobs where the
      // harness copies it from (agent.ts storeRequestLog): on by default, so a replay of a trial whose live pass kept
      // none recovers the bytes it sent; a config may keep none with `capture_requests: false`.
      ...(cfg.capture_requests === false ? {} : { captureRequests: new BlobStore(join(paths.recordDir, BLOBS_DIR)) }),
      readyToken: token,
      ...client,
      onMiss: (miss) => {
        if (missed) return;
        missed = true;
        writeAtomic(join(paths.recordDir, MISS_FILE), `${JSON.stringify({ route: miss.route, request_key: miss.request_key })}\n`);
      },
    });
  }
  let address;
  try {
    address = await gateway.listen(paths.port, paths.host);
  } catch (err) {
    await gateway.close();
    throw new GatewayStartError(`cannot listen on ${paths.host}:${paths.port}: ${(err as Error).message}`);
  }
  writeAtomic(join(paths.recordDir, READY_FILE), `${JSON.stringify({ schema: GATEWAY_READY_SCHEMA, mode: cfg.mode, host: paths.host, port: address.port, token, pid: process.pid })}\n`);
  let stopping: Promise<GatewayResult> | null = null;
  return {
    gateway,
    host: paths.host,
    port: address.port,
    token,
    stop() {
      stopping ??= gateway.close().then((r) => {
        writeAtomic(join(paths.recordDir, RESULT_FILE), `${JSON.stringify(resultDocument(r))}\n`);
        return r;
      });
      return stopping;
    },
  };
}

/** The process (see the header): resolves with its exit code. */
export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  let paths: GatewayPaths;
  try {
    paths = gatewayPaths(env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const fail = (mode: 'live' | 'replay' | null, message: string): void => {
    try {
      mkdirSync(paths.recordDir, { recursive: true });
      writeAtomic(join(paths.recordDir, RESULT_FILE), `${JSON.stringify(failureDocument(mode, message))}\n`);
    } catch {
      // Nowhere left to say it: the exit code does.
    }
  };
  let cfg: GatewayConfigT;
  try {
    cfg = loadGatewayConfig(paths.configDir);
  } catch (err) {
    fail(null, err instanceof GatewayStartError ? err.message : `the gateway could not read its config: ${(err as Error).name}`);
    return 2;
  }
  const secrets = configSecrets(cfg);
  let running: RunningGateway;
  try {
    running = await startGateway(cfg, paths);
  } catch (err) {
    fail(cfg.mode, redact(err instanceof GatewayStartError ? err.message : `the gateway could not start: ${(err as Error).name}: ${(err as Error).message}`, secrets));
    return 2;
  }
  const crashed = (err: unknown): void => {
    fail(cfg.mode, redact(`the gateway crashed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`, secrets));
    process.exit(1);
  };
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);
  await new Promise<void>((done) => {
    process.once('SIGTERM', () => done());
    process.once('SIGINT', () => done());
  });
  const result = await running.stop();
  return result.faults.length === 0 ? 0 : 1;
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
