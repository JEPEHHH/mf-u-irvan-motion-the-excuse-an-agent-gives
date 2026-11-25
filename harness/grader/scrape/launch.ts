// The house launcher: PID 1 of a scrape/v1 entry's container, and the clock that times the entry.
// The docker driver runs it for a spec with a `launcher` (grader/sandbox/docker.ts): root with only
// SETUID, SETGID and KILL, no-new-privileges, a read-only root, everything else docker.ts's hardened
// set, the house read-only at /house. It ships twice, one protocol, because the python3.13 image has
// no node and the node22 image no python:
//
//   node22       node /house/launch.ts       this file, as it is (node: imports only; Node 22.23.4
//                                            strips its types by default)
//   python3.13   python3 /house/launch.py    PYTHON_LAUNCHER_SOURCE below, stdlib only
//
// houseFor makes a house for a runtime: {launch.ts | launch.py, launch.json, ca.pem} plus the
// launcher argv; writeHouse writes it. Both twins read launch.json beside themselves (LaunchConfig):
//
//   {"argv": ["node","/bot/main.ts"] | ["python3","/bot/main.py"], "cwd": "/bot",
//    "uid": 65534 | null, "gid": 65534 | null, "cap_ms": 5000, "env": {...}, "tail_bytes": 65536,
//    "secret_names": ["API_TOKEN", ...]}
//
// secret_names is there only for an entry that runs with entry secrets (its entrant's env-lane ones,
// contracts/entry-secrets.ts): their NAMEs, sorted, never a value. The values never touch the disk:
// the grader writes them on the launcher's stdin as one line before `ready` (the secrets line,
// launchSecretsLine: {"NAME":"value",...}, exactly secret_names), and the launcher holds them in its
// memory alone, for the entry's environment. And then, in order:
//   1. a launch.json that does not check (checkLaunchConfig), or a uid while the launcher is not root:
//      prints {"error": "..."} and exits 1;
//   2. with secret_names, reads the secrets line on stdin: EOF first exits 2 with nothing printed; a
//      line longer than MAX_SECRETS_LINE, not a JSON object, or not exactly secret_names to non-empty
//      strings without NUL prints {"error": "..."} and exits 1. No error quotes the line or a value
//      (a JSON parser's own message would), only launch.json's names;
//   3. idles SETTLE_MS, so its own start is spent before the entry's clock runs, then prints
//      {"ready":true};
//   4. reads one line on stdin: EOF first exits 2 with nothing printed; anything but `go` prints
//      {"error": "..."} and exits 1;
//   5. t0 = the monotonic clock in ns (process.hrtime.bigint / time.monotonic_ns), immediately
//      before the spawn;
//   6. spawns argv in cwd with exactly env and the secrets (nothing inherited), in a session of its
//      own, as uid:gid with no supplementary group when they are set; its stdin /dev/null, its stdout
//      and stderr piped and drained, each keeping its last tail_bytes;
//   7. SIGKILLs it at cap_ms (timed_out);
//   8. t1 at its exit: the process's, never its pipes' close (a daemon it left may hold them);
//   9. with a uid, every live (not zombie) process of that uid in /proc but itself is SIGKILLed, in
//      rounds until none is left, and counted: leftover; without, its process group is SIGKILLed and
//      leftover is null;
//  10. prints ONE line {"wall_ns":"<decimal>","exit":int|null,"signal":string|null,"timed_out":bool,
//      "leftover":int|null,"stdout_tail":"<base64>","stderr_tail":"<base64>"} and exits 0. A failure
//      on the launcher's side (the runtime will not spawn, a leftover will not die) is
//      {"error": "..."} instead, exit 1: the trial runner voids the trial.
//
// uid null is a launcher on the host: the kit's process driver and the unit tests, which run this
// file as the program itself. A uid is the docker driver's: launch.json from houseFor drops the
// entry to 65534:65534.
//
// The privilege model, measured by #2208 on Docker Desktop 4.96.3 (Engine 29.9.2, runc 1.5.2,
// linux/arm64) in the pinned node22 image, with and without `--init`: the launcher's effective
// capabilities are exactly KILL, SETGID and SETUID (CapEff 0xe0) with NoNewPrivs; its child runs as
// 65534:65534 with no supplementary group and no capability; the child gets EACCES on the launcher's
// /proc/<pid>/fd (list, readlink, open for read or write), mem (read, write), environ and maps, and on
// a root-owned 0700 directory; EPERM signalling the launcher (SIGKILL, SIGSTOP); EROFS on / and /house.
// The launcher SIGKILLed all three sleepers the child left (one setsid'd, one double-forked, one
// plain): without --init they stay zombies under PID 1 until the container goes, which the sweep
// skips, so the docker driver runs no --init. The launcher's clock over 100 `node -e 0` spawns as
// 65534: median 12.07 ms, p5 10.80, p95 16.08, p99 18.58 (SD 1.67); the same no-op timed on the host
// around `docker exec`: median 42.04, p5 39.69, p95 53.10, p99 63.20 (SD 5.20). So the launcher's
// clock is the trial's, and no exec-clock fallback is built. In a fresh container, as a trial runs,
// the clock needs the launcher's own start spent first (SETTLE_MS).
//
// Entry secrets reach the entry by stdin rather than a file because the house is read-only to the
// launcher (EROFS on /house): a secrets file there could not be deleted once read, and launch.json is
// readable by the entry itself (0644). The child cannot read them back out of the launcher either: as
// #2208 measured, /proc/<pid>/mem and environ of the launcher are EACCES to it, and the secrets were
// never in the launcher's own environment.
//
// LauncherSession is the grader's end: it reads the launcher's lines off an attached container's
// stdout (docker run -i, Sandbox.spawn), writes the secrets line (when it has secrets) and `go` to its
// stdin.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Runtime } from '../sandbox/types.ts';

/** Where the house sits in the entry's container. */
export const HOUSE_DIR = '/house';
/** The launcher's config, beside it. */
export const LAUNCH_CONFIG = 'launch.json';
/** The heat CA's certificate, in the house. */
export const CA_FILE = 'ca.pem';
/** Each runtime's launcher file in the house. */
export const LAUNCHER_FILES: Readonly<Record<Runtime, string>> = Object.freeze({ node22: 'launch.ts', 'python3.13': 'launch.py' });
/** Each runtime's launcher command: the container's entrypoint and its arguments. */
export const LAUNCHER_ARGV: Readonly<Record<Runtime, readonly string[]>> = Object.freeze({
  node22: Object.freeze(['node', `${HOUSE_DIR}/launch.ts`]),
  'python3.13': Object.freeze(['python3', `${HOUSE_DIR}/launch.py`]),
});
/** Each runtime's interpreter and entry script (relative to the code directory). */
export const ENTRY_COMMANDS: Readonly<Record<Runtime, readonly [string, string]>> = Object.freeze({
  node22: Object.freeze(['node', 'main.ts'] as const),
  'python3.13': Object.freeze(['python3', 'main.py'] as const),
});
/** Where the entry's code sits in its container, and its cwd. */
export const CODE_DIR = '/bot';
/** The sandbox user and group the docker driver's launcher drops the entry to. */
export const SANDBOX_UID = 65534;
/** The images' PATH (node:22-slim's; python:3.13-slim's holds the same directories). */
export const ENTRY_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** The entry's HOME: the container's one writable place. */
export const ENTRY_HOME = '/tmp';
/** The variables every sandboxed program gets (grader/sandbox/types.ts SANDBOX_ENV; a test holds them equal). */
export const LAUNCH_BASE_ENV: Readonly<Record<string, string>> = Object.freeze({ TZ: 'UTC', PYTHONHASHSEED: '0', LANG: 'C.UTF-8' });
/** How much of each of the entry's streams the result keeps, by default. */
export const TAIL_BYTES = 65_536;
export const MAX_TAIL_BYTES = 16 * 1024 * 1024;
export const MAX_CAP_MS = 3_600_000;
/** The largest uid or gid a config may name. */
export const MAX_ID = 4_294_967_294;
/** The keys of launch.json, exactly, but SECRET_NAMES_KEY. */
export const CONFIG_KEYS = Object.freeze(['argv', 'cwd', 'uid', 'gid', 'cap_ms', 'env', 'tail_bytes'] as const);
/** The one key launch.json may hold besides CONFIG_KEYS: the entry secrets' names, there only when it has some (the header). */
export const SECRET_NAMES_KEY = 'secret_names';
/** A secret's NAME (contracts/entry-secrets.ts ENTRY_SECRET_NAME_RE; a test holds them equal: this file imports nothing but node:). */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** The most secrets one entry runs with (contracts/entry-secrets.ts ENTRY_SECRET_MAX_COUNT; a test holds them equal). */
export const MAX_SECRETS = 16;
/**
 * The longest secrets line the launcher reads, in bytes: the contract's 32 KiB of names and values, each byte of them
 * at most six once JSON escapes it, and room.
 */
export const MAX_SECRETS_LINE = 1024 * 1024;
/** The keys of the result line, in order. */
export const RESULT_KEYS = Object.freeze(['wall_ns', 'exit', 'signal', 'timed_out', 'leftover', 'stdout_tail', 'stderr_tail'] as const);
/** Exit codes: an error line, and stdin closed before `go`. */
export const EXIT_ERROR = 1;
export const EXIT_NO_GO = 2;
/** The sweep's rounds and the pause between them; a process of the uid still alive after them is the launcher's failure. */
export const SWEEP_ROUNDS = 50;
export const SWEEP_PAUSE_MS = 10;
/** How long the launcher waits for the entry's pipes to close after its exit and the sweep. */
export const CLOSE_GRACE_MS = 2_000;
/**
 * How long the launcher idles between checking its config and printing `ready`, so its own start
 * (node's background compile and GC threads) is spent before the entry's clock runs. #2208 measured
 * a no-op entry over 30 fresh node22 containers at --cpus 1 with `go` sent at once on `ready`: median
 * 20.19 ms, p95 62.71, SD 17.93; with 300 ms between them: median 16.10, p95 20.38, SD 1.92 (python3.13:
 * median 11.64 and 10.31, SD 1.88 and 1.87 either way; its twin idles the same, so `ready` means one
 * thing).
 */
export const SETTLE_MS = 300;
/** The longest line the launcher reads on stdin for `go` (two bytes). */
const MAX_GO_LINE = 1024;
/**
 * How much of a line that is not `go` its error quotes: enough to tell `GO` or `go\r` from `go`, too little to hold a value
 * (a secrets line's own `{"N":"` takes six of the eight).
 */
const GO_QUOTE = 8;

/** launch.json, checked (checkLaunchConfig). */
export interface LaunchConfig {
  argv: string[];
  cwd: string;
  uid: number | null;
  gid: number | null;
  cap_ms: number;
  env: Record<string, string>;
  tail_bytes: number;
  /** The entry secrets' NAMEs, sorted (the header): present only when it runs with some, their values on the launcher's stdin. */
  secret_names?: string[];
}

/** A launch.json that does not check. */
export class LaunchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchConfigError';
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const noNul = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');

/**
 * A launch.json value, checked: exactly CONFIG_KEYS, and SECRET_NAMES_KEY besides when the entry runs
 * with secrets; argv a non-empty list of non-empty strings; cwd absolute; uid and gid both null or both
 * integers 1..MAX_ID; cap_ms 1..MAX_CAP_MS; tail_bytes 0..MAX_TAIL_BYTES; env names (no `=`) to strings,
 * no NUL anywhere; secret_names 1..MAX_SECRETS distinct NAMEs (SECRET_NAME_RE) in code-unit order, none
 * of them in env. The Python twin checks the same.
 */
export function checkLaunchConfig(raw: unknown): LaunchConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new LaunchConfigError('launch.json is not an object');
  const c = raw as Record<string, unknown>;
  const named = Object.hasOwn(c, SECRET_NAMES_KEY);
  const keys = Object.keys(c).sort();
  const want = [...CONFIG_KEYS, ...(named ? [SECRET_NAMES_KEY] : [])].sort();
  if (JSON.stringify(keys) !== JSON.stringify(want)) throw new LaunchConfigError(`launch.json keys are ${JSON.stringify(keys)}, not ${JSON.stringify(want)}`);
  const { argv, cwd, uid, gid, cap_ms, env, tail_bytes } = c;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => noNul(a) && a !== '')) throw new LaunchConfigError('argv must be a non-empty list of non-empty strings');
  if (!noNul(cwd) || !cwd.startsWith('/')) throw new LaunchConfigError('cwd must be an absolute path');
  if ((uid === null) !== (gid === null)) throw new LaunchConfigError('uid and gid are both set or both null');
  if (uid !== null && !(isInt(uid) && isInt(gid) && uid >= 1 && uid <= MAX_ID && gid >= 1 && gid <= MAX_ID)) throw new LaunchConfigError(`uid and gid must be integers from 1 to ${MAX_ID}`);
  if (!isInt(cap_ms) || cap_ms < 1 || cap_ms > MAX_CAP_MS) throw new LaunchConfigError(`cap_ms must be an integer from 1 to ${MAX_CAP_MS}`);
  if (!isInt(tail_bytes) || tail_bytes < 0 || tail_bytes > MAX_TAIL_BYTES) throw new LaunchConfigError(`tail_bytes must be an integer from 0 to ${MAX_TAIL_BYTES}`);
  if (typeof env !== 'object' || env === null || Array.isArray(env) || !Object.entries(env).every(([k, v]) => noNul(k) && k !== '' && !k.includes('=') && noNul(v))) {
    throw new LaunchConfigError('env must map names to strings, without = in a name or NUL anywhere');
  }
  const config: LaunchConfig = { argv: [...(argv as string[])], cwd, uid: uid as number | null, gid: gid as number | null, cap_ms, env: { ...(env as Record<string, string>) }, tail_bytes };
  if (named) config.secret_names = checkSecretNames(c[SECRET_NAMES_KEY], config.env);
  return config;
}

/**
 * launch.json's secret_names, checked (checkLaunchConfig): 1..MAX_SECRETS distinct NAMEs in code-unit order, none in `env`,
 * and never `__proto__` (the contract reserves it; as a key it would set an object's prototype rather than a variable).
 */
function checkSecretNames(names: unknown, env: Readonly<Record<string, string>>): string[] {
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_SECRETS || !names.every((n) => typeof n === 'string' && SECRET_NAME_RE.test(n) && n !== '__proto__')) {
    throw new LaunchConfigError(`secret_names must list 1 to ${MAX_SECRETS} secret names`);
  }
  const list = names as string[];
  for (let i = 1; i < list.length; i++) if (!(list[i - 1]! < list[i]!)) throw new LaunchConfigError('secret_names must be distinct and sorted');
  const clash = list.find((n) => Object.hasOwn(env, n));
  if (clash !== undefined) throw new LaunchConfigError(`secret ${clash} is also in env`);
  return [...list];
}

/**
 * The secrets line (the header's step 2), checked against launch.json's names: a JSON object holding exactly `names`, each
 * a non-empty string without NUL. A LaunchConfigError names what is wrong by launch.json's names alone: never the line,
 * an unlisted key or a value (JSON.parse's own message quotes the text, so it is never passed on).
 */
export function checkSecretsLine(line: string, names: readonly string[]): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new LaunchConfigError('the secrets line is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new LaunchConfigError('the secrets line is not a JSON object');
  const o = raw as Record<string, unknown>;
  const missing = names.filter((n) => !Object.hasOwn(o, n));
  if (missing.length > 0) throw new LaunchConfigError(`the secrets line lacks ${missing.join(', ')}`);
  const extra = Object.keys(o).filter((k) => !names.includes(k)).length;
  if (extra > 0) throw new LaunchConfigError(`the secrets line holds ${extra} name${extra === 1 ? '' : 's'} launch.json does not list`);
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = o[n];
    if (!noNul(v) || v === '') throw new LaunchConfigError(`secret ${n}'s value is not a non-empty string without NUL`);
    out[n] = v;
  }
  return out;
}

// ---------------------------------------------------------------- the launcher

/** What the launcher touches, so a test can hand in its own (an injected spawn, a fake /proc). */
export interface LauncherDeps {
  /** launch.json's text; throws when it cannot be read. */
  readConfig(): string;
  /** Where `go` arrives. */
  stdin: Readable;
  /** Write one line (the newline added); resolves once it is handed to the OS. */
  write(line: string): Promise<void>;
  spawn: typeof nodeSpawn;
  /** The monotonic clock in ns. */
  now(): bigint;
  /** The launcher's effective uid. */
  euid(): number;
  /** The launcher's own pid, which the sweep passes over. */
  selfPid: number;
  /** Where the sweep lists processes (`/proc`). */
  procDir: string;
  /** Signal a process (a negative pid: its group); throws as process.kill does. */
  kill(pid: number, signal: NodeJS.Signals): void;
  /** How long to wait for the entry's pipes to close after its exit and the sweep. */
  closeGraceMs: number;
  /** How long to idle before `ready` (SETTLE_MS). */
  settleMs: number;
}

/** The launcher's real surroundings: launch.json beside this file, the process's stdio and clock. */
export function launcherDeps(): LauncherDeps {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    readConfig: () => readFileSync(join(here, LAUNCH_CONFIG), 'utf8'),
    stdin: process.stdin,
    write: (line) =>
      new Promise<void>((resolve) => {
        process.stdout.write(`${line}\n`, () => resolve());
      }),
    spawn: nodeSpawn,
    now: () => process.hrtime.bigint(),
    euid: () => process.geteuid?.() ?? -1,
    selfPid: process.pid,
    procDir: '/proc',
    kill: (pid, signal) => process.kill(pid, signal),
    closeGraceMs: CLOSE_GRACE_MS,
    settleMs: SETTLE_MS,
  };
}

/** A failure on the launcher's side once the entry ran: an error line, not a result. */
class LauncherFault extends Error {}

/** The last `limit` bytes of a stream, drained as it comes. */
class Tail {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(b: Buffer): void {
    if (this.#limit === 0) return;
    this.#chunks.push(b);
    this.#size += b.length;
    while (this.#chunks.length > 1 && this.#size - this.#chunks[0]!.length >= this.#limit) this.#size -= this.#chunks.shift()!.length;
  }

  value(): Buffer {
    const all = Buffer.concat(this.#chunks);
    return all.subarray(Math.max(0, all.length - this.#limit));
  }
}

/** One line read on stdin (StdinLines.next): its text without the newline, and whether it ran past the limit (its first `limit` bytes). */
interface ReadLine {
  text: string;
  cut: boolean;
}

/**
 * Lines on the launcher's stdin, one after another: the bytes past a line's newline are kept for the next (the grader may
 * write the secrets line and `go` in one write), and stdin is paused between reads.
 */
class StdinLines {
  readonly #stdin: Readable;
  #buf: Buffer = Buffer.alloc(0);
  #ended = false;
  #error: { e: unknown } | null = null;
  #wake: (() => void) | null = null;

  constructor(stdin: Readable) {
    this.#stdin = stdin;
    stdin.on('data', (b: Buffer | string) => {
      this.#buf = Buffer.concat([this.#buf, typeof b === 'string' ? Buffer.from(b) : b]);
      this.#poke();
    });
    stdin.once('end', () => {
      this.#ended = true;
      this.#poke();
    });
    stdin.once('error', (e: unknown) => {
      this.#error ??= { e };
      this.#poke();
    });
  }

  /**
   * The next line, without its newline: the rest up to EOF when there is none, its first `limit` bytes (cut) when it runs
   * past them; null at EOF with nothing left. Rejects with what stdin failed with.
   */
  async next(limit: number): Promise<ReadLine | null> {
    this.#stdin.resume();
    try {
      for (;;) {
        const nl = this.#buf.indexOf(10);
        if (nl >= 0 && nl <= limit) {
          const text = this.#buf.subarray(0, nl).toString('utf8');
          this.#buf = this.#buf.subarray(nl + 1);
          return { text, cut: false };
        }
        if (this.#buf.length > limit) return { text: this.#buf.subarray(0, limit).toString('utf8'), cut: true };
        if (this.#error !== null) throw this.#error.e;
        if (this.#ended) {
          if (this.#buf.length === 0) return null;
          const text = this.#buf.toString('utf8');
          this.#buf = Buffer.alloc(0);
          return { text, cut: false };
        }
        await new Promise<void>((resolve) => (this.#wake = resolve));
      }
    } finally {
      this.#stdin.pause();
    }
  }

  #poke(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

/** Signal a process or group; true when it was sent, false when there was none (ESRCH). EPERM and the rest throw. */
function signal(deps: LauncherDeps, pid: number, sig: NodeJS.Signals): boolean {
  try {
    deps.kill(pid, sig);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
}

/** The live (not zombie, not dead) processes of `uid` under procDir, but `self`: by real or effective uid. */
export function liveProcesses(procDir: string, uid: number, self: number): number[] {
  const pids: number[] = [];
  for (const name of readdirSync(procDir)) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const pid = Number(name);
    if (pid === self) continue;
    let status: string;
    try {
      status = readFileSync(join(procDir, name, 'status'), 'utf8');
    } catch {
      continue; // gone meanwhile
    }
    const state = /^State:\s+(\S)/m.exec(status)?.[1];
    const ids = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
    if (state === 'Z' || state === 'X' || ids === null) continue;
    if (Number(ids[1]) === uid || Number(ids[2]) === uid) pids.push(pid);
  }
  return pids.sort((a, b) => a - b);
}

/** Step 8 with a uid: SIGKILL every live process of it, round after round, until none is left; how many there were. */
async function sweep(deps: LauncherDeps, uid: number): Promise<number> {
  const list = (): number[] => {
    try {
      return liveProcesses(deps.procDir, uid, deps.selfPid);
    } catch (e) {
      throw new LauncherFault(`cannot list the processes in ${deps.procDir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  };
  const killed = new Set<number>();
  for (let round = 0; round < SWEEP_ROUNDS; round++) {
    const live = list();
    if (live.length === 0) return killed.size;
    for (const pid of live) {
      killed.add(pid);
      try {
        signal(deps, pid, 'SIGKILL');
      } catch (e) {
        throw new LauncherFault(`cannot kill process ${pid} of uid ${uid}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, SWEEP_PAUSE_MS));
  }
  const left = list();
  if (left.length === 0) return killed.size;
  throw new LauncherFault(`${left.length} processes of uid ${uid} outlived ${SWEEP_ROUNDS} SIGKILL rounds`);
}

/** The launcher, steps 1 to 10 of the header; resolves to its exit code. */
export async function runLauncher(deps: LauncherDeps): Promise<number> {
  const fail = async (message: string): Promise<number> => {
    await deps.write(JSON.stringify({ error: message }));
    return EXIT_ERROR;
  };
  // Listening from the start, so a stdin that fails while launch.json is read is this launcher's to tell.
  const lines = new StdinLines(deps.stdin);

  let cfg: LaunchConfig;
  try {
    let text: string;
    try {
      text = deps.readConfig();
    } catch (e) {
      return await fail(`${LAUNCH_CONFIG}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new LaunchConfigError(`${LAUNCH_CONFIG} is not JSON: ${(e as Error).message}`);
    }
    cfg = checkLaunchConfig(raw);
    if (cfg.uid !== null && deps.euid() !== 0) throw new LaunchConfigError(`${LAUNCH_CONFIG} sets uid ${cfg.uid} but the launcher is not root`);
  } catch (e) {
    if (e instanceof LaunchConfigError) return await fail(e.message);
    throw e;
  }

  // Step 2: the secrets line, held in this process's memory alone.
  let secrets: Record<string, string> = {};
  if (cfg.secret_names !== undefined) {
    const line = await lines.next(MAX_SECRETS_LINE);
    if (line === null) return EXIT_NO_GO;
    if (line.cut) return await fail(`the secrets line is longer than ${MAX_SECRETS_LINE} bytes`);
    try {
      secrets = checkSecretsLine(line.text, cfg.secret_names);
    } catch (e) {
      if (e instanceof LaunchConfigError) return await fail(e.message);
      throw e;
    }
  }

  if (deps.settleMs > 0) await new Promise((r) => setTimeout(r, deps.settleMs));
  await deps.write(JSON.stringify({ ready: true }));
  const got = await lines.next(MAX_GO_LINE);
  if (got === null) return EXIT_NO_GO;
  // At most GO_QUOTE bytes of what came instead are quoted: a secrets line sent where `go` belongs never shows a value.
  if (got.text !== 'go') return await fail(`expected go, got ${JSON.stringify(got.text.slice(0, GO_QUOTE))}`);

  const opts: SpawnOptions = { cwd: cfg.cwd, env: { ...cfg.env, ...secrets }, stdio: ['ignore', 'pipe', 'pipe'], detached: true };
  if (cfg.uid !== null) {
    opts.uid = cfg.uid;
    opts.gid = cfg.gid!;
  }
  const [file, ...args] = cfg.argv as [string, ...string[]];
  let child: ChildProcess;
  const t0 = deps.now();
  try {
    child = deps.spawn(file, args, opts);
  } catch (e) {
    return await fail(`spawn ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  const out = new Tail(cfg.tail_bytes);
  const err = new Tail(cfg.tail_bytes);
  child.stdout?.on('data', (b: Buffer) => out.add(b));
  child.stderr?.on('data', (b: Buffer) => err.add(b));
  child.stdout?.on('error', () => undefined);
  child.stderr?.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let timedOut = false;
  const ended = await new Promise<{ t1: bigint; code: number | null; sig: NodeJS.Signals | null } | { error: Error }>((resolve) => {
    let capped: NodeJS.Timeout | undefined;
    child.once('exit', (code, sig) => {
      const t1 = deps.now();
      clearTimeout(capped);
      resolve({ t1, code, sig });
    });
    // A spawn that failed (ENOENT, a bad cwd, a uid refused) has no pid and emits only this.
    child.once('error', (e) => {
      if (child.pid === undefined) resolve({ error: e });
    });
    if (child.pid !== undefined) {
      capped = setTimeout(() => {
        timedOut = true;
        try {
          signal(deps, child.pid!, 'SIGKILL');
        } catch {
          // Its exit, or the sweep's fault below, tells.
        }
      }, cfg.cap_ms);
    }
  });
  if ('error' in ended) return await fail(`spawn ${file}: ${(ended.error as NodeJS.ErrnoException).code ?? ended.error.message}`);

  let leftover: number | null = null;
  try {
    if (cfg.uid !== null) leftover = await sweep(deps, cfg.uid);
  } catch (e) {
    if (e instanceof LauncherFault) return await fail(e.message);
    throw e;
  }
  // Its process group: what is left of it under a launcher with no uid (the sweep took the rest). On
  // the host a group member out of this user's reach is the host's business, not the entry's result.
  try {
    signal(deps, -child.pid!, 'SIGKILL');
  } catch (e) {
    if (cfg.uid !== null) return await fail(`cannot kill the entry's process group: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  let grace: NodeJS.Timeout | undefined;
  await Promise.race([closed, new Promise<void>((r) => (grace = setTimeout(r, deps.closeGraceMs)))]);
  clearTimeout(grace);
  child.stdout?.destroy();
  child.stderr?.destroy();

  const result = {
    wall_ns: (ended.t1 - t0).toString(),
    exit: ended.code,
    signal: ended.sig,
    timed_out: timedOut && ended.sig === 'SIGKILL',
    leftover,
    stdout_tail: out.value().toString('base64'),
    stderr_tail: err.value().toString('base64'),
  };
  await deps.write(JSON.stringify(result));
  return 0;
}

// ---------------------------------------------------------------- the Python twin

/**
 * launch.py, the python3.13 image's launcher: the protocol of the header, stdlib only, run as
 * `python3 /house/launch.py`. It waits on the entry from a thread (a blocking waitpid, so t1 is the
 * exit's), kills it at the cap through a pidfd where the kernel has one, and passes extra_groups=[]
 * so the entry keeps no supplementary group of root's (Popen sets none unless asked; Node's spawn
 * clears them itself). Its behaviour is proven in Docker (#2208 by hand; #2220 commits it): the host
 * runs no Python.
 */
export const PYTHON_LAUNCHER_SOURCE = String.raw`# The house launcher's Python twin (grader/scrape/launch.ts PYTHON_LAUNCHER_SOURCE): PID 1 of a
# python3.13 scrape entry's container, run as python3 /house/launch.py. Stdlib only; the protocol and
# the checks are launch.ts's.
import base64
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

CONFIG_KEYS = ("argv", "cwd", "uid", "gid", "cap_ms", "env", "tail_bytes")
SECRET_NAMES_KEY = "secret_names"
SECRET_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
MAX_SECRETS = 16
MAX_SECRETS_LINE = 1048576
MAX_CAP_MS = 3600000
MAX_TAIL_BYTES = 16777216
MAX_ID = 4294967294
SWEEP_ROUNDS = 50
SWEEP_PAUSE_S = 0.01
CLOSE_GRACE_S = 2.0
SETTLE_S = 0.3
MAX_GO_LINE = 1024
GO_QUOTE = 8
EXIT_ERROR = 1
EXIT_NO_GO = 2


class ConfigError(Exception):
    pass


class Fault(Exception):
    pass


def say(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def no_nul(v):
    return isinstance(v, str) and "\0" not in v


def check_config(c):
    if not isinstance(c, dict):
        raise ConfigError("launch.json is not an object")
    keys = sorted(c.keys())
    want = sorted(CONFIG_KEYS + ((SECRET_NAMES_KEY,) if SECRET_NAMES_KEY in c else ()))
    if keys != want:
        raise ConfigError("launch.json keys are " + json.dumps(keys, separators=(",", ":")) + ", not " + json.dumps(want, separators=(",", ":")))
    argv = c["argv"]
    if not isinstance(argv, list) or len(argv) == 0 or not all(no_nul(a) and a != "" for a in argv):
        raise ConfigError("argv must be a non-empty list of non-empty strings")
    if not no_nul(c["cwd"]) or not c["cwd"].startswith("/"):
        raise ConfigError("cwd must be an absolute path")
    uid, gid = c["uid"], c["gid"]
    if (uid is None) != (gid is None):
        raise ConfigError("uid and gid are both set or both null")
    if uid is not None and not (is_int(uid) and is_int(gid) and 1 <= uid <= MAX_ID and 1 <= gid <= MAX_ID):
        raise ConfigError("uid and gid must be integers from 1 to " + str(MAX_ID))
    if not is_int(c["cap_ms"]) or not 1 <= c["cap_ms"] <= MAX_CAP_MS:
        raise ConfigError("cap_ms must be an integer from 1 to " + str(MAX_CAP_MS))
    if not is_int(c["tail_bytes"]) or not 0 <= c["tail_bytes"] <= MAX_TAIL_BYTES:
        raise ConfigError("tail_bytes must be an integer from 0 to " + str(MAX_TAIL_BYTES))
    env = c["env"]
    if not isinstance(env, dict) or not all(no_nul(k) and k != "" and "=" not in k and no_nul(v) for k, v in env.items()):
        raise ConfigError("env must map names to strings, without = in a name or NUL anywhere")
    if SECRET_NAMES_KEY in c:
        names = c[SECRET_NAMES_KEY]
        if not isinstance(names, list) or not 1 <= len(names) <= MAX_SECRETS or not all(isinstance(n, str) and SECRET_NAME_RE.fullmatch(n) and n != "__proto__" for n in names):
            raise ConfigError("secret_names must list 1 to " + str(MAX_SECRETS) + " secret names")
        if any(names[i - 1] >= names[i] for i in range(1, len(names))):
            raise ConfigError("secret_names must be distinct and sorted")
        for n in names:
            if n in env:
                raise ConfigError("secret " + n + " is also in env")
    return c


def check_secrets(raw, names):
    # Never quotes the line, an unlisted key or a value: only launch.json's names.
    try:
        s = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise ConfigError("the secrets line is not JSON") from None
    if not isinstance(s, dict):
        raise ConfigError("the secrets line is not a JSON object")
    missing = [n for n in names if n not in s]
    if missing:
        raise ConfigError("the secrets line lacks " + ", ".join(missing))
    extra = len([k for k in s if k not in names])
    if extra:
        raise ConfigError("the secrets line holds " + str(extra) + " name" + ("" if extra == 1 else "s") + " launch.json does not list")
    for n in names:
        if not no_nul(s[n]) or s[n] == "":
            raise ConfigError("secret " + n + "'s value is not a non-empty string without NUL")
    return {n: s[n] for n in names}


class Tail:
    def __init__(self, limit):
        self.limit = limit
        self.buf = bytearray()

    def add(self, b):
        if self.limit == 0:
            return
        self.buf += b
        if len(self.buf) > self.limit:
            del self.buf[: len(self.buf) - self.limit]

    def value(self):
        return bytes(self.buf)


def drain(fd, tail):
    try:
        while True:
            b = os.read(fd, 65536)
            if not b:
                return
            tail.add(b)
    except OSError:
        return


def live(uid):
    me = os.getpid()
    pids = []
    for name in os.listdir("/proc"):
        if not name.isdigit() or name.startswith("0"):
            continue
        pid = int(name)
        if pid == me:
            continue
        try:
            with open("/proc/" + name + "/status", "r", encoding="utf-8", errors="replace") as f:
                status = f.read()
        except OSError:
            continue
        state = None
        ids = None
        for line in status.split("\n"):
            parts = line.split()
            if line.startswith("State:") and len(parts) > 1:
                state = parts[1]
            elif line.startswith("Uid:") and len(parts) > 2:
                ids = parts[1:3]
        if state in ("Z", "X") or ids is None:
            continue
        if str(uid) in ids:
            pids.append(pid)
    return sorted(pids)


def sweep(uid):
    killed = set()
    for _ in range(SWEEP_ROUNDS):
        pids = live(uid)
        if not pids:
            return len(killed)
        for pid in pids:
            killed.add(pid)
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError as e:
                raise Fault("cannot kill process " + str(pid) + " of uid " + str(uid) + ": " + (e.strerror or str(e)))
        time.sleep(SWEEP_PAUSE_S)
    left = live(uid)
    if not left:
        return len(killed)
    raise Fault(str(len(left)) + " processes of uid " + str(uid) + " outlived " + str(SWEEP_ROUNDS) + " SIGKILL rounds")


def signal_name(n):
    try:
        return signal.Signals(n).name
    except ValueError:
        return "SIG" + str(n)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        try:
            with open(os.path.join(here, "launch.json"), "rb") as f:
                text = f.read()
        except OSError as e:
            say({"error": "launch.json: " + (e.strerror or str(e))})
            return EXIT_ERROR
        try:
            c = json.loads(text)
        except ValueError as e:
            raise ConfigError("launch.json is not JSON: " + str(e))
        check_config(c)
        if c["uid"] is not None and os.geteuid() != 0:
            raise ConfigError("launch.json sets uid " + str(c["uid"]) + " but the launcher is not root")
    except ConfigError as e:
        say({"error": str(e)})
        return EXIT_ERROR

    # The secrets line, held in this process's memory alone.
    secrets = {}
    if SECRET_NAMES_KEY in c:
        line = sys.stdin.buffer.readline(MAX_SECRETS_LINE + 1)
        if line == b"":
            return EXIT_NO_GO
        if line.endswith(b"\n"):
            line = line[:-1]
        elif len(line) > MAX_SECRETS_LINE:
            say({"error": "the secrets line is longer than " + str(MAX_SECRETS_LINE) + " bytes"})
            return EXIT_ERROR
        try:
            secrets = check_secrets(line, c[SECRET_NAMES_KEY])
        except ConfigError as e:
            say({"error": str(e)})
            return EXIT_ERROR

    time.sleep(SETTLE_S)
    say({"ready": True})
    line = sys.stdin.buffer.readline(MAX_GO_LINE + 1)
    if line == b"":
        return EXIT_NO_GO
    if line.endswith(b"\n"):
        line = line[:-1]
    if line != b"go":
        say({"error": "expected go, got " + json.dumps(line[:GO_QUOTE].decode("utf-8", "replace"))})
        return EXIT_ERROR

    uid, gid = c["uid"], c["gid"]
    env = dict(c["env"])
    env.update(secrets)
    kw = dict(cwd=c["cwd"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
    if uid is not None:
        kw.update(user=uid, group=gid, extra_groups=[])
    t0 = time.monotonic_ns()
    try:
        proc = subprocess.Popen(c["argv"], **kw)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        say({"error": "spawn " + c["argv"][0] + ": " + (getattr(e, "strerror", None) or str(e))})
        return EXIT_ERROR
    pidfd = None
    try:
        pidfd = os.pidfd_open(proc.pid)
    except (AttributeError, OSError):
        pidfd = None
    out_tail = Tail(c["tail_bytes"])
    err_tail = Tail(c["tail_bytes"])
    readers = [
        threading.Thread(target=drain, args=(proc.stdout.fileno(), out_tail), daemon=True),
        threading.Thread(target=drain, args=(proc.stderr.fileno(), err_tail), daemon=True),
    ]
    for r in readers:
        r.start()
    exited = threading.Event()
    ended = {}

    def wait():
        rc = proc.wait()
        ended["t1"] = time.monotonic_ns()
        ended["rc"] = rc
        exited.set()

    threading.Thread(target=wait, daemon=True).start()
    capped = False
    if not exited.wait(c["cap_ms"] / 1000):
        capped = True
        try:
            if pidfd is not None:
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            elif not exited.is_set():
                os.kill(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        exited.wait()
    rc = ended["rc"]

    leftover = None
    try:
        if uid is not None:
            leftover = sweep(uid)
    except Fault as e:
        say({"error": str(e)})
        return EXIT_ERROR
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        pass
    deadline = time.monotonic() + CLOSE_GRACE_S
    for r in readers:
        r.join(max(0.0, deadline - time.monotonic()))

    say({
        "wall_ns": str(ended["t1"] - t0),
        "exit": rc if rc >= 0 else None,
        "signal": signal_name(-rc) if rc < 0 else None,
        "timed_out": capped and rc == -signal.SIGKILL,
        "leftover": leftover,
        "stdout_tail": base64.b64encode(out_tail.value()).decode("ascii"),
        "stderr_tail": base64.b64encode(err_tail.value()).decode("ascii"),
    })
    return 0


def launcher_main():
    try:
        return main()
    except Exception as e:
        say({"error": "launcher: " + type(e).__name__ + ": " + str(e)})
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(launcher_main())
`;

// ---------------------------------------------------------------- the house

/** What launchConfig builds launch.json from. */
export interface LaunchOptions {
  /** The entry's wall cap: SIGKILL after this many ms. */
  capMs: number;
  /** How much of each stream the result keeps (default TAIL_BYTES). */
  tailBytes?: number;
  /**
   * The uid and gid the launcher drops the entry to (default SANDBOX_UID, the docker driver's
   * launcher, root with SETUID/SETGID/KILL); null: no switch (a launcher on the host).
   */
  user?: number | null;
  /** The entry's code directory and cwd (default CODE_DIR). */
  codeDir?: string;
  /** Where the house sits, for the CA path in the entry's env (default HOUSE_DIR). */
  houseDir?: string;
  /** The interpreter (default the runtime's, `node` or `python3`, found on ENTRY_PATH). */
  interpreter?: string;
  /**
   * More variables for the entry: MAKEFUN_* names only. A container caller passes a mount's stand-in
   * here (scrape/trial.ts's MAKEFUN_OUTPUT_DIR): the entry gets launch.json's env alone, never its
   * container's, so the driver's own copy of the mount variable never reaches it.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * The entry's env-lane entry secrets, NAME to value (contracts/entry-secrets.ts; grader/worker.ts opens them): their
   * NAMEs go into launch.json's secret_names, their values never. The grader hands the same map to LauncherSession,
   * which writes it on the launcher's stdin (the header). Absent or empty: none, and launch.json is what it always was.
   */
  secrets?: Readonly<Record<string, string>>;
}

const EXTRA_ENV_RE = /^MAKEFUN_[A-Z0-9_]+$/;

/** An English ordinal: 1st, 2nd, 3rd, 4th, 11th, 21st. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * The names of `secrets` for launch.json, sorted, each checked against the entry's `env` (`[]` with none): at most
 * MAX_SECRETS, each a NAME (SECRET_NAME_RE, never `__proto__`), no MAKEFUN_* one (the house's) and none `env` sets, every
 * value a non-empty string without NUL. A refusal names a secret by its NAME, or by its place when its name is no NAME
 * (which may be a value pasted where its name belongs), and never quotes a value.
 */
export function launchSecretNames(secrets: Readonly<Record<string, string>> | undefined, env: Readonly<Record<string, string>>): string[] {
  if (secrets === undefined) return [];
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) throw new LaunchConfigError('secrets must map names to values');
  const entries = Object.entries(secrets);
  if (entries.length > MAX_SECRETS) throw new LaunchConfigError(`an entry runs with at most ${MAX_SECRETS} secrets, not ${entries.length}`);
  for (const [i, [name, value]] of entries.entries()) {
    if (!SECRET_NAME_RE.test(name) || name === '__proto__') throw new LaunchConfigError(`the ${ordinal(i + 1)} secret's name is not a secret name`);
    if (EXTRA_ENV_RE.test(name) || Object.hasOwn(env, name)) throw new LaunchConfigError(`secret ${name} is a variable the house sets`);
    if (!noNul(value) || value === '') throw new LaunchConfigError(`secret ${name}'s value is not a non-empty string without NUL`);
  }
  return entries.map(([name]) => name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * launch.json for a runtime's entry: `<interpreter> <codeDir>/<main.ts|main.py>` in codeDir; the env
 * LAUNCH_BASE_ENV, PATH, HOME=/tmp, NODE_EXTRA_CA_CERTS and SSL_CERT_FILE at the house's ca.pem (both
 * runtimes: Node's fetch, https and http2 trust it through the first, Python's urllib through the
 * second, measured by #2208), then the MAKEFUN_* extras; the sandbox user unless `user` says; and,
 * with secrets, their NAMEs as secret_names (launchSecretNames), never a value.
 */
export function launchConfig(runtime: Runtime, o: LaunchOptions): LaunchConfig {
  const [interpreter, script] = ENTRY_COMMANDS[runtime];
  const codeDir = o.codeDir ?? CODE_DIR;
  const ca = `${o.houseDir ?? HOUSE_DIR}/${CA_FILE}`;
  const user = o.user === undefined ? SANDBOX_UID : o.user;
  const env: Record<string, string> = { ...LAUNCH_BASE_ENV, PATH: ENTRY_PATH, HOME: ENTRY_HOME, NODE_EXTRA_CA_CERTS: ca, SSL_CERT_FILE: ca };
  for (const [k, v] of Object.entries(o.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!EXTRA_ENV_RE.test(k)) throw new LaunchConfigError(`entry variable ${JSON.stringify(k)} is not a MAKEFUN_* name`);
    env[k] = v;
  }
  const names = launchSecretNames(o.secrets, env);
  return checkLaunchConfig({
    argv: [o.interpreter ?? interpreter, `${codeDir}/${script}`],
    cwd: codeDir,
    uid: user,
    gid: user,
    cap_ms: o.capMs,
    env,
    tail_bytes: o.tailBytes ?? TAIL_BYTES,
    ...(names.length === 0 ? {} : { [SECRET_NAMES_KEY]: names }),
  });
}

/**
 * The secrets line the grader writes on the launcher's stdin before `ready` (the header's step 2): `secrets` as one line
 * of JSON, its keys in code-unit order, ending in a newline. Null with none (nothing is written).
 */
export function launchSecretsLine(secrets: Readonly<Record<string, string>> | null | undefined): string | null {
  if (secrets === undefined || secrets === null) return null;
  const names = Object.keys(secrets).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names.length === 0) return null;
  const sorted: Record<string, string> = {};
  for (const n of names) sorted[n] = secrets[n]!;
  return `${JSON.stringify(sorted)}\n`;
}

/** A house for one entry: its files by name, and the command that runs its launcher in the container. */
export interface House {
  files: Record<string, string>;
  argv: readonly string[];
  config: LaunchConfig;
}

let ownSource: string | null = null;

/** This file's own text: the node22 house's launch.ts. */
export function launcherSource(): string {
  ownSource ??= readFileSync(fileURLToPath(import.meta.url), 'utf8');
  return ownSource;
}

const CERT_PEM_RE = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/;

/**
 * The house for a runtime's entry: the runtime's launcher (this file, or PYTHON_LAUNCHER_SOURCE),
 * launch.json (launchConfig) and ca.pem, the heat CA's certificate: one PEM certificate and nothing
 * else (a private key in it is refused: the CA key never reaches an entry). Entry secrets put their
 * NAMEs in launch.json and no value in any file: the caller hands their values to LauncherSession.
 */
export function houseFor(runtime: Runtime, o: LaunchOptions & { caPem: string }): House {
  if (typeof o.caPem !== 'string' || !CERT_PEM_RE.test(o.caPem)) throw new LaunchConfigError('caPem must be one PEM certificate and nothing else');
  const config = launchConfig(runtime, o);
  const files: Record<string, string> = {
    [LAUNCHER_FILES[runtime]]: runtime === 'node22' ? launcherSource() : PYTHON_LAUNCHER_SOURCE,
    [LAUNCH_CONFIG]: `${JSON.stringify(config, null, 2)}\n`,
    [CA_FILE]: o.caPem.endsWith('\n') ? o.caPem : `${o.caPem}\n`,
  };
  return { files, argv: LAUNCHER_ARGV[runtime], config };
}

/**
 * Write a house into `dir`, an existing directory: each file 0644 and the directory 0755, since the
 * launcher reads them as a root that holds no CAP_DAC_OVERRIDE (and a mkdtemp directory is 0700).
 */
export function writeHouse(dir: string, house: Pick<House, 'files'>): void {
  for (const [name, text] of Object.entries(house.files)) {
    if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw new LaunchConfigError(`house file ${JSON.stringify(name)} is not a plain name`);
    const path = join(dir, name);
    writeFileSync(path, text, { mode: 0o644 });
    chmodSync(path, 0o644);
  }
  chmodSync(dir, 0o755);
}

// ---------------------------------------------------------------- the grader's end

/** One launch's result, as the launcher printed it. */
export interface LaunchResult {
  /** t1 - t0 in ns: the spawn to the exit. */
  wallNs: bigint;
  exit: number | null;
  signal: string | null;
  /** The launcher killed it at cap_ms. */
  timedOut: boolean;
  /** The processes of the sandbox user left after its exit, all killed; null without a uid. */
  leftover: number | null;
  stdoutTail: Buffer;
  stderrTail: Buffer;
}

/** One line from the launcher, parsed. */
export type LauncherLine = { kind: 'ready' } | { kind: 'error'; error: string } | { kind: 'result'; result: LaunchResult };

/** The launcher printed something that is not its protocol, refused, or went: the trial runner's void. */
export class LauncherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LauncherError';
  }
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SIGNAL_RE = /^SIG[A-Z0-9]+$/;

/** A launcher line, checked exactly: `{"ready":true}`, `{"error": string}`, or a result with exactly RESULT_KEYS. */
export function parseLauncherLine(line: string): LauncherLine {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new LauncherError(`the launcher printed ${JSON.stringify(line.slice(0, 120))}, not JSON`);
  }
  const bad = (why: string) => new LauncherError(`the launcher printed ${JSON.stringify(line.slice(0, 120))}: ${why}`);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad('not an object');
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && o.ready === true) return { kind: 'ready' };
  if (keys.length === 1 && typeof o.error === 'string') return { kind: 'error', error: o.error };
  if (JSON.stringify(keys) !== JSON.stringify(RESULT_KEYS)) throw bad(`keys ${JSON.stringify(keys)} are not ${JSON.stringify(RESULT_KEYS)}`);
  const { wall_ns, exit, signal: sig, timed_out, leftover, stdout_tail, stderr_tail } = o;
  if (typeof wall_ns !== 'string' || !/^(0|[1-9]\d{0,24})$/.test(wall_ns)) throw bad('wall_ns is not a decimal string');
  if (!(exit === null || (isInt(exit) && exit >= 0 && exit <= 255))) throw bad('exit is not 0..255 or null');
  if (!(sig === null || (typeof sig === 'string' && SIGNAL_RE.test(sig)))) throw bad('signal is not a signal name or null');
  if ((exit === null) === (sig === null)) throw bad('exactly one of exit and signal is set');
  if (typeof timed_out !== 'boolean') throw bad('timed_out is not a boolean');
  if (!(leftover === null || (isInt(leftover) && leftover >= 0))) throw bad('leftover is not a count or null');
  if (typeof stdout_tail !== 'string' || !BASE64_RE.test(stdout_tail) || typeof stderr_tail !== 'string' || !BASE64_RE.test(stderr_tail)) throw bad('a tail is not base64');
  return {
    kind: 'result',
    result: {
      wallNs: BigInt(wall_ns),
      exit: exit as number | null,
      signal: sig as string | null,
      timedOut: timed_out,
      leftover: leftover as number | null,
      stdoutTail: Buffer.from(stdout_tail, 'base64'),
      stderrTail: Buffer.from(stderr_tail, 'base64'),
    },
  };
}

/** The longest launcher line a session reads (two 16 MiB tails in base64, and room). */
export const MAX_LAUNCHER_LINE = 48 * 1024 * 1024;

/**
 * The grader's end of one launcher, over an attached container's stdio (Sandbox.spawn of a
 * `launcher` spec: `docker run -i`, stdin and stdout held here) or a launcher on the host: ready(),
 * then go(). Each rejects with LauncherError when the launcher refuses ({"error"}), prints anything
 * but the next step of its protocol, or closes its stdout first. No clock of its own: the caller
 * races each step against its deadline and kills the sandbox. With `secrets` (the same map whose
 * NAMEs launch.json lists: launchConfig's LaunchOptions.secrets), ready() first writes the secrets
 * line (launchSecretsLine) and the session lets go of the map.
 */
export class LauncherSession {
  readonly #stdin: Writable;
  readonly #lines: string[] = [];
  readonly #maxLine: number;
  #secrets: string | null;
  #partial: Buffer[] = [];
  #partialSize = 0;
  #ended: string | null = null;
  #wake: (() => void) | null = null;
  #state: 'new' | 'ready' | 'going' | 'done' = 'new';

  constructor(proc: { stdin: Writable; stdout: Readable }, opts: { maxLineBytes?: number; secrets?: Readonly<Record<string, string>> | null } = {}) {
    this.#stdin = proc.stdin;
    this.#maxLine = opts.maxLineBytes ?? MAX_LAUNCHER_LINE;
    this.#secrets = launchSecretsLine(opts.secrets);
    proc.stdin.on('error', () => undefined);
    proc.stdout.on('data', (b: Buffer | string) => this.#onData(typeof b === 'string' ? Buffer.from(b) : b));
    proc.stdout.once('end', () => this.#end('the launcher closed its stdout'));
    proc.stdout.once('close', () => this.#end('the launcher closed its stdout'));
    proc.stdout.once('error', (e: Error) => this.#end(`the launcher's stdout failed: ${e.message}`));
  }

  /** Writes the secrets line when there is one, then resolves on `{"ready":true}`. */
  async ready(): Promise<void> {
    if (this.#state !== 'new') throw new LauncherError('ready() was already called');
    this.#state = 'ready';
    if (this.#secrets !== null) {
      this.#stdin.write(this.#secrets);
      this.#secrets = null;
    }
    const line = await this.#next('before ready');
    if (line.kind === 'error') throw new LauncherError(`the launcher refused: ${line.error}`);
    if (line.kind !== 'ready') throw new LauncherError('the launcher printed a result before ready');
  }

  /** Sends `go` and resolves on the result line. */
  async go(): Promise<LaunchResult> {
    if (this.#state !== 'ready') throw new LauncherError('go() comes once, after ready()');
    this.#state = 'going';
    this.#stdin.write('go\n');
    const line = await this.#next('before its result');
    this.#state = 'done';
    if (line.kind === 'error') throw new LauncherError(`the launcher failed: ${line.error}`);
    if (line.kind !== 'result') throw new LauncherError('the launcher printed ready twice');
    return line.result;
  }

  async #next(when: string): Promise<LauncherLine> {
    while (this.#lines.length === 0) {
      if (this.#ended !== null) throw new LauncherError(`${this.#ended} ${when}`);
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
    return parseLauncherLine(this.#lines.shift()!);
  }

  #onData(b: Buffer): void {
    if (this.#ended !== null) return;
    let rest = b;
    for (let nl = rest.indexOf(10); nl >= 0; nl = rest.indexOf(10)) {
      this.#partial.push(rest.subarray(0, nl));
      this.#lines.push(Buffer.concat(this.#partial).toString('utf8'));
      this.#partial = [];
      this.#partialSize = 0;
      rest = rest.subarray(nl + 1);
    }
    if (rest.length > 0) {
      this.#partial.push(rest);
      this.#partialSize += rest.length;
      if (this.#partialSize > this.#maxLine) this.#end(`the launcher printed a line longer than ${this.#maxLine} bytes`);
    }
    this.#poke();
  }

  #end(why: string): void {
    this.#ended ??= why;
    this.#poke();
  }

  #poke(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

/** runLauncher, with anything it did not foresee (a stdin that broke) as an error line rather than a stack trace alone. */
export async function launcherMain(deps: LauncherDeps): Promise<number> {
  try {
    return await runLauncher(deps);
  } catch (e) {
    await deps.write(JSON.stringify({ error: `launcher: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` }));
    return EXIT_ERROR;
  }
}

// No top-level await: docker.ts imports this module, and a module that holds one is async for every importer.
if (import.meta.main) {
  // The grader went (its end of stdout closed): nobody is left to read a result.
  process.stdout.on('error', () => process.exit(EXIT_ERROR));
  void launcherMain(launcherDeps()).then((code) => process.exit(code));
}
