// The test sandbox: runs a program directly on the host, `node <codeDir>/<script>` (a node22 program) or `python3.13 -P -s
// <codeDir>/<script>` (a python3.13 one, where the caller named the host's python3.13), with the
// same explicit environment the containers get (TZ=UTC, PYTHONHASHSEED=0, LANG=C.UTF-8) and the
// mounts passed as their types.ts MOUNT_POINTS variables (program/v1's MAKEFUN_INPUT_DIR /
// MAKEFUN_OUTPUT_DIR / MAKEFUN_REFERENCE_DIR / MAKEFUN_SCORES_DIR, an agent trial's
// MAKEFUN_ENV_DIR, MAKEFUN_STATE_DIR and the rest). It isolates nothing (no network, memory, CPU or filesystem limits), so it
// refuses to exist unless asked for explicitly: NODE_ENV=test or MAKEFUN_ALLOW_PROCESS_SANDBOX=1
// (server/config.ts's admission for MAKEFUN_SANDBOX=process; `makefun grade-local --driver process`
// sets it), and never under NODE_ENV=production. Dev login (MAKEFUN_DEV_AUTH) admits nothing here.
// A spec with a `launcher`
// (types.ts, a scrape trial's entry) is refused: the house launcher's clock and privilege split are the docker
// driver's alone, and running the spec's code here without them would time and isolate nothing.
// On the host the launcher runs as the program itself instead (grader/scrape/launch.ts, uid null).
// Its image digest is null (contracts/score.ts: "null for the process driver used in tests").
//
// Node: the node a program runs under strips TypeScript's types, as the grader's node22 image does (a .ts script is the
// usual entry and scorer). With no `node` given, hostNode picks one on first need: this process's node when it strips
// types by default (process.features.typescript); else this node with --experimental-strip-types (Node 22.6 to 22.17);
// else MAKEFUN_NODE, then each `node` on PATH, that runs a TypeScript probe (alone or with the flag). A node built without
// type stripping (a distribution's build: ERR_NO_TYPESCRIPT) with none other found runs a .js or .mjs script still, and
// refuses a .ts, .mts or .cts one before it starts, naming the fix (NO_TYPESCRIPT_FIX).
//
// Python: a python3.13 program runs under the host's python3.13 (the owner's ruling, 2026-11-23: grade-local's process
// driver runs a Python entry with the host's python3.13 when present), with the image's flags (types.ts RUNTIME_COMMANDS:
// -P -s), only where the caller says which: ProcessSandboxOptions.python, a path (hostPython313 finds it on PATH without
// running it) or null when the host has none, which refuses the program naming what to install (PYTHON_MISSING). With no
// `python` given (a server's dev sandbox, the tests) Python runs only inside Docker, as before.
//
// An agent trial's spec gets the same environment as in its container: the spec's `env` after the
// three variables, checked by the same allowlist (types.ts checkSandboxEnv), then the mount variables,
// then its `secrets` (types.ts checkSandboxSecrets, which refuses any name of the others, so none
// overrides another), in the child's environment alone: never its argv. Its `network` is
// checked the same way and joins nothing: every program shares the host's loopback, so a trial's
// services listen on 127.0.0.1 ports the harness picks and the others reach them there
// (network.ts serviceEndpoint), where in containers they listen on 0.0.0.0:8080 behind an alias.
//
// A patch/v1 run's spec (its `image`, types.ts's header) runs `/bin/sh <codeDir>/<script>` on the host
// in place of the image's argv, whatever its runtime, so such a spec names its script; its image is
// checked as the docker driver checks it (checkSandboxImage), then never pulled nor run. Its
// /base and /tests come as MAKEFUN_BASE_DIR and MAKEFUN_TESTS_DIR like any mount. A spec's `work`
// (image or not) gets a fresh scratch directory under the host's tmpdir as MAKEFUN_WORK_DIR (types.ts
// WORK_DIR_ENV), held to no size, and removed once the program has exited.
//
// It runs on Windows as well (a kit's grade-local on Node 22 there): its code directory and every mount's host path
// pass types.ts checkProcessHostPath, which on win32 also takes a drive-letter path (C:\Users\…\Temp\…), since this
// driver names one only in the child's cwd and environment, never in a mount spec. Every other driver keeps checkHostPath.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  checkProcessHostPath,
  checkSandboxEnv,
  checkSandboxImage,
  checkSandboxNetwork,
  checkSandboxSecrets,
  checkSandboxWork,
  MOUNT_POINTS,
  RUNTIME_COMMANDS,
  SANDBOX_ENV,
  SandboxError,
  scriptOf,
  WORK_DIR_ENV,
  type Runtime,
  type Sandbox,
  type SandboxExit,
  type SandboxMount,
  type SandboxProcess,
  type SandboxSpec,
} from './types.ts';
import { checkSandboxMounts } from './mounts.ts';

/** The host shell an image spec's script runs under. */
export const HOST_SH = '/bin/sh';

/** The flag a Node 22.6 to 22.17 needs to run a .ts script (server/kit/node-runtime.ts STRIP_TYPES_FLAG, repeated: the sandbox imports nothing of the kit's). */
export const STRIP_TYPES_FLAG = '--experimental-strip-types';
/** Names a node (its path) for the process driver's TypeScript programs, tried before those on PATH (the header's Node). */
export const HOST_NODE_ENV = 'MAKEFUN_NODE';
/** A script node runs as TypeScript. */
const TS_SCRIPT_RE = /\.[cm]?ts$/i;

/** The python3.13 a python3.13 program runs under, and the interpreter's flags after it (the image's: types.ts RUNTIME_COMMANDS). */
const PYTHON_FLAGS: readonly string[] = RUNTIME_COMMANDS['python3.13'].slice(1);

/** What a host with no python3.13 is told (the header's Python). */
export const PYTHON_MISSING =
  'the process driver runs a python3.13 program with this machine\'s python3.13, and none is on PATH: install Python 3.13 (python.org\'s installer, brew install python@3.13, or your distribution\'s python3.13 package) so that `python3.13` is on PATH, then run it again; or grade with --driver docker, which runs the pinned python3.13 image';

/** The fix a node that strips no types is told (the header's Node), after what it is. */
export const NO_TYPESCRIPT_FIX = `install Node 22.18 or later from nodejs.org (or nvm install 22; a distribution's node package may be built without TypeScript), and run it again with that node, or name it with ${HOST_NODE_ENV}=<path to node>; or grade with --driver docker, which runs the pinned node22 image`;

export interface ProcessSandboxOptions {
  /** The environment the guard reads (default process.env). Nothing of it reaches the program. */
  env?: Record<string, string | undefined>;
  /** The node binary (default: hostNode's pick, on first need). */
  node?: string;
  /** The arguments before a node program's script (with `node`; default none). */
  nodeArgs?: readonly string[];
  /** Why `node` cannot run a TypeScript script, or null (with `node`; default null): a .ts, .mts or .cts script is then refused with it. */
  noTypeScript?: string | null;
  /**
   * The python3.13 a python3.13 program runs under (the header's Python): a path, or null when the host has none (the
   * program refused with PYTHON_MISSING). Absent: Python runs only inside Docker.
   */
  python?: string | null;
  /** The host platform its host paths are checked for (default process.platform): win32 also takes drive-letter paths. */
  platform?: string;
  /** Starts a program (default node:child_process spawn; tests record the command and its argv). */
  spawn?: (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams;
  /** hostNode's options when no `node` is given (tests). */
  hostNode?: HostNodeOptions;
}

/** The node a program runs under, its arguments before the script, and why it cannot run TypeScript (null: it can). */
export interface HostNode {
  node: string;
  args: readonly string[];
  noTypeScript: string | null;
}

export interface HostNodeOptions {
  /** This process's node (default process.execPath). */
  execPath?: string;
  /** Whether it strips types by default (default process.features.typescript). */
  typescript?: boolean;
  /** Its version, as `node --version` prints it (default process.version). */
  version?: string;
  /** PATH and HOST_NODE_ENV are read from it (default process.env). */
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Whether `node` with `args` runs a TypeScript file (default: it runs a probe .mts file, which must print what it says). */
  runsTypeScript?: (node: string, args: readonly string[]) => boolean;
  /** Whether `file` is a regular file (default statSync). */
  isFile?: (file: string) => boolean;
}

/** Each existing regular file named `name` (on win32, `name`.exe) in a directory of `pathVar`, in order, once each by its real path. */
export function onPath(name: string, pathVar: string | undefined, platform: string = process.platform, isFile: (file: string) => boolean = isRegularFile): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const file = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (pathVar ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue;
    const at = platform === 'win32' ? `${dir.replace(/[\\/]+$/, '')}\\${file}` : `${dir.replace(/\/+$/, '')}/${file}`;
    if (!isFile(at)) continue;
    const real = realOrSelf(at);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(at);
  }
  return out;
}

function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The host's python3.13 (the header's Python), found without running anything: the first `python3.13` on PATH, else a
 * `python3` on PATH whose real file is named python3.13 (Homebrew's python3 link); null when there is none.
 */
export function hostPython313(env: Record<string, string | undefined> = process.env, platform: string = process.platform, isFile: (file: string) => boolean = isRegularFile): string | null {
  const exact = onPath('python3.13', env.PATH ?? env.Path, platform, isFile)[0];
  if (exact !== undefined) return exact;
  for (const p of onPath('python3', env.PATH ?? env.Path, platform, isFile)) if (basename(realOrSelf(p)).replace(/\.exe$/i, '') === 'python3.13') return p;
  return null;
}

/** A probe .mts file run under a node with given arguments (the default HostNodeOptions.runsTypeScript), and its folder removed. */
function typeScriptProbe(): { runs: (node: string, args: readonly string[]) => boolean; dispose: () => void } {
  let dir: string | null = null;
  return {
    runs: (node, args) => {
      if (dir === null) {
        dir = mkdtempSync(join(tmpdir(), 'makefun-ts-probe-'));
        writeFileSync(join(dir, 'probe.mts'), "const n: number = 6 * 7;\nprocess.stdout.write(`makefun-ts-probe ${n}`);\n");
      }
      const { NODE_OPTIONS: _options, ...env } = process.env;
      try {
        const r = spawnSync(node, [...args, join(dir, 'probe.mts')], { encoding: 'utf8', timeout: 15_000, windowsHide: true, env });
        return r.status === 0 && r.stdout === 'makefun-ts-probe 42';
      } catch {
        return false;
      }
    },
    dispose: () => {
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
      dir = null;
    },
  };
}

/**
 * The node a process-driver program runs under (the header's Node): this one when it strips types by default; else this
 * one with STRIP_TYPES_FLAG, then HOST_NODE_ENV's, then each `node` on PATH, alone then with the flag, the first that
 * runs a TypeScript probe; else this node, with why it runs no TypeScript and the fix.
 */
export function hostNode(o: HostNodeOptions = {}): HostNode {
  const execPath = o.execPath ?? process.execPath;
  const typescript = o.typescript ?? Boolean((process.features as { typescript?: unknown }).typescript);
  if (typescript) return { node: execPath, args: [], noTypeScript: null };
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const isFile = o.isFile ?? isRegularFile;
  const probe = o.runsTypeScript === undefined ? typeScriptProbe() : null;
  const runs = o.runsTypeScript ?? probe!.runs;
  const tried = new Set<string>();
  const attempt = (node: string, flagOnly: boolean): HostNode | null => {
    const key = realOrSelf(node);
    if (tried.has(`${key}\0${flagOnly}`)) return null;
    tried.add(`${key}\0${flagOnly}`);
    if (!flagOnly && runs(node, [])) return { node, args: [], noTypeScript: null };
    if (runs(node, [STRIP_TYPES_FLAG])) return { node, args: [STRIP_TYPES_FLAG], noTypeScript: null };
    return null;
  };
  // This node first with the flag alone (it strips nothing by default), then the one named, then PATH's.
  const named = env[HOST_NODE_ENV];
  const candidates: Array<[string, boolean]> = [[execPath, true], ...(named !== undefined && named !== '' ? [[named, false] as [string, boolean]] : []), ...onPath('node', env.PATH ?? env.Path, platform, isFile).map((p): [string, boolean] => [p, false])];
  try {
    for (const [node, flagOnly] of candidates) {
      if (!flagOnly && realOrSelf(node) === realOrSelf(execPath)) continue;
      const found = attempt(node, flagOnly);
      if (found !== null) return found;
    }
  } finally {
    probe?.dispose();
  }
  const version = o.version ?? process.version;
  return {
    node: execPath,
    args: [],
    noTypeScript: `this node (${version}, ${execPath}) runs no TypeScript, even with ${STRIP_TYPES_FLAG} (a build without type stripping, ERR_NO_TYPESCRIPT, or a Node before 22.6), so the process driver cannot run a .ts program (the kit's score.ts, a node22 entry's main.ts)${named !== undefined && named !== '' ? `, nor can ${HOST_NODE_ENV}'s ${named}` : ''}, and no node on PATH strips types: ${NO_TYPESCRIPT_FIX}`,
  };
}

/**
 * The spec's mounts, checked as mounts.ts checkSandboxMounts checks them, each host path by checkProcessHostPath for
 * `platform`: on win32 a drive-letter host passes here and only here (the header).
 */
function processMounts(mounts: readonly SandboxMount[] | undefined, platform: string): readonly SandboxMount[] {
  return checkSandboxMounts(mounts, (path) => checkProcessHostPath(path, platform));
}

/**
 * Throws unless the environment allows the unisolated process driver: NODE_ENV=test, or
 * MAKEFUN_ALLOW_PROCESS_SANDBOX=1 (or `true`, as server/config.ts reads the flag); never under
 * NODE_ENV=production, whatever else is set.
 */
export function assertProcessSandboxAllowed(env: Record<string, string | undefined> = process.env): void {
  const nodeEnv = env.NODE_ENV ?? '';
  const allow = (env.MAKEFUN_ALLOW_PROCESS_SANDBOX ?? '').toLowerCase();
  if (nodeEnv === 'production') throw new SandboxError('the process sandbox is refused under NODE_ENV=production');
  if (nodeEnv !== 'test' && allow !== '1' && allow !== 'true') {
    throw new SandboxError('the process sandbox runs only under NODE_ENV=test or with MAKEFUN_ALLOW_PROCESS_SANDBOX=1 (it isolates nothing)');
  }
}

export class ProcessSandbox implements Sandbox {
  readonly kind = 'process' as const;
  readonly platform: string;
  /** The python3.13 a python3.13 program runs under: a path, null (none on this host), or undefined (Python only inside Docker). */
  readonly python: string | null | undefined;
  readonly #given: HostNode | null;
  readonly #hostNode: HostNodeOptions;
  #picked: HostNode | null = null;
  readonly #spawn: NonNullable<ProcessSandboxOptions['spawn']>;

  constructor(opts: ProcessSandboxOptions = {}) {
    assertProcessSandboxAllowed(opts.env ?? process.env);
    this.#given = opts.node === undefined ? null : { node: opts.node, args: [...(opts.nodeArgs ?? [])], noTypeScript: opts.noTypeScript ?? null };
    this.#hostNode = opts.hostNode ?? {};
    this.python = opts.python;
    this.platform = opts.platform ?? process.platform;
    this.#spawn = opts.spawn ?? ((command, args, options) => spawn(command, [...args], options));
  }

  /** The node a node22 program runs under (the header's Node): the one given, else hostNode's pick, made once on first need. */
  hostNode(): HostNode {
    if (this.#given !== null) return this.#given;
    this.#picked ??= hostNode(this.#hostNode);
    return this.#picked;
  }

  /** The node a node22 program runs under (hostNode). */
  get node(): string {
    return this.hostNode().node;
  }

  /** The python3.13 a python3.13 program runs under (the header's Python), or a SandboxError saying why there is none. */
  #python(): string {
    if (this.python === undefined) throw new SandboxError('the process sandbox runs node22 only (python3.13 runs only inside Docker)');
    if (this.python === null) throw new SandboxError(PYTHON_MISSING);
    return this.python;
  }

  imageDigest(_runtime: Runtime): null {
    return null;
  }

  async preflight(runtime: Runtime, imageDigest: string | null = null): Promise<void> {
    if (runtime === 'python3.13') this.#python();
    else if (runtime !== 'node22') throw new SandboxError(`the process sandbox runs node22 and python3.13 only (${runtime as string} runs only inside Docker)`);
    if (imageDigest !== null) throw new SandboxError(`the process sandbox has no image; cannot run digest ${imageDigest}`);
  }

  isDriverFailure(exit: SandboxExit): boolean {
    return exit.error !== undefined;
  }

  async removeTree(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }

  spawn(spec: SandboxSpec): SandboxProcess {
    // A spec is a launcher spec whenever it carries the key, as docker.ts dockerRunArgs reads it.
    if (spec.launcher !== undefined) {
      throw new SandboxError('the process sandbox runs no launcher (a launcher spec runs only inside Docker: there is no root here to drop the entry from)');
    }
    // An image spec runs its script under the host's sh (the header), never the runtime's interpreter.
    const image = spec.image === undefined ? null : checkSandboxImage(spec);
    if (image !== null && spec.script === undefined) throw new SandboxError(`the process sandbox runs an image spec as ${HOST_SH} <codeDir>/<script>, so the spec names its script`);
    if (spec.imageDigest !== undefined && spec.imageDigest !== null) throw new SandboxError(`the process sandbox has no image; cannot run digest ${spec.imageDigest}`);
    const codeDir = checkProcessHostPath(spec.codeDir, this.platform);
    const script = join(codeDir, scriptOf(spec));
    // The program's command (the header): an image spec's script under the host's sh; a python3.13 one under the host's
    // python3.13 with the image's flags; a node22 one under a node that strips types, or refused when it is TypeScript and
    // none here does, before anything runs.
    let command: string;
    let args: string[];
    if (image !== null) [command, args] = [HOST_SH, [script]];
    else if (spec.runtime === 'python3.13') [command, args] = [this.#python(), [...PYTHON_FLAGS, script]];
    else if (spec.runtime === 'node22') {
      const node = this.hostNode();
      if (node.noTypeScript !== null && TS_SCRIPT_RE.test(script)) throw new SandboxError(node.noTypeScript);
      [command, args] = [node.node, [...node.args, script]];
    } else throw new SandboxError(`the process sandbox runs node22 and python3.13 only (${spec.runtime as string} runs only inside Docker)`);
    if (spec.network !== undefined) checkSandboxNetwork(spec.network);
    const secrets = checkSandboxSecrets(spec);
    const work = spec.work === undefined ? null : checkSandboxWork(spec.work);
    const env: Record<string, string> = { ...SANDBOX_ENV };
    for (const [k, v] of checkSandboxEnv(spec.env)) env[k] = v;
    // The program reads and writes the host directory itself: every file of a writable mount is live and all of it is
    // back at the exit (types.ts's Mounts), so `live` and `returns` are checked and need nothing more.
    for (const m of processMounts(spec.mounts, this.platform)) env[MOUNT_POINTS[m.at]] = m.host;
    for (const [k, v] of secrets) env[k] = v;
    const workDir = work === null ? null : mkdtempSync(join(tmpdir(), 'makefun-work-'));
    if (workDir !== null) env[WORK_DIR_ENV] = workDir;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawn(command, args, { cwd: codeDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      if (workDir !== null) rmSync(workDir, { recursive: true, force: true });
      throw err;
    }
    return new HostProcess(child, workDir);
  }
}

class HostProcess implements SandboxProcess {
  readonly stdin;
  readonly stdout;
  readonly stderr;
  readonly exited: Promise<SandboxExit>;
  readonly #child: ChildProcessWithoutNullStreams;

  /** `workDir`, a spec's scratch /work, is removed once the program has exited, before `exited` settles. */
  constructor(child: ChildProcessWithoutNullStreams, workDir: string | null = null) {
    this.#child = child;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    const ended = new Promise<SandboxExit>((resolve) => {
      child.once('error', (err) => resolve({ code: null, signal: null, error: `spawn: ${err.message}` }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    // What rm cannot take (a directory the program left 0555) stays under the host's tmpdir: this driver isolates nothing.
    this.exited = workDir === null ? ended : ended.then(async (exit) => rm(workDir, { recursive: true, force: true }).then(() => exit, () => exit));
  }

  async kill(): Promise<void> {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
    await this.exited;
  }
}
