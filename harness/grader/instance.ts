// Drawing a beacon-drawn instance: run a competition's generator (contracts/competition.ts
// ProgramHarness.generator) in the sandbox on one seed, twice, and keep what it drew. The seed, the
// sidecar and the draw record are server/competitions/instance.ts's; this is the part that runs code.
//
//   /bot      the generator directory (the one harness.generator_sha256 seals), read-only. The script
//             is the entrypoint's last segment, as grader/program.ts runs a scorer.
//   /input    a read-only directory (0555) holding seed.json (instanceSeedFile's text) and, given
//             GeneratorOptions.inputs, those files beside it (a scored draw's sealed input:
//             server/competitions/instance.ts checkSealedInput), each written once (wx) 0444 as UTF-8
//             before the directory is locked: the seed and they reach the generator there and nowhere
//             else. Without inputs it holds seed.json alone. An input's name is a plain segment (the
//             instance's own naming rule) and never seed.json, at most MAX_GENERATOR_INPUTS of them
//             holding MAX_GENERATOR_INPUT_BYTES together (RangeError before anything runs). Its
//             environment is SANDBOX_ENV, as every entry's.
//   /output   writable (0777 for the sandbox user, as program.ts's): the generator writes the instance
//             as /output/input/** (what entries will read at /input) and /output/reference/** (what
//             the scorer will read at /reference), both directories, and nothing else.
//
// stdin is closed, stdout captured (at most MAX_PROGRAM_STDOUT_BYTES) and stderr capped as an entry's,
// under limits.wall_budget_sec. The instance is held to program outputs' caps: INSTANCE_MAX_FILES
// entries (every inode, input/ and reference/ themselves too) and INSTANCE_MAX_BYTES bytes (apparent
// or allocated, whichever total is larger) across both directories, program.ts's MAX_OUTPUT_DEPTH
// and MAX_OUTPUT_PATH_BYTES (relative to /output, so a tree nested past PATH_MAX stays the
// generator's fault), and their names (plain segments, no dot-files). The caps are also watched while
// it runs, every OUTPUT_WATCH_MS, as program.ts watches an entry's: by this process over what it can
// read, and by the sandbox's meter where it has one (Sandbox.meterTree: docker's meter container over
// all of /output, whatever modes the generator left there; the k8s pod's `watch`, whose directories it
// cannot read are a limit once kept so for the grace, program.ts outputReadingBroken and
// OUTPUT_UNREAD_KEPT, as an entry's). The process sandbox has only this process's watch, as before; a
// meter that fails is a SandboxError. A run that does not draw is a GeneratorError: `failed` (a non-zero exit or a signal,
// stdout or stderr over its cap), `timeout` (the wall budget ran out), `output` (anything under
// /output but the two directories, a symbolic link, a special file, an unreadable, unreachable or
// ill-named path, a cap broken, or something there the sandbox could not delete after the run).
//
// Twice: each run gets fresh directories, and the two runs' tree digests (input_sha256,
// reference_sha256: the sealed-path digest, server/competitions/load.ts treeSha256) must be equal, or
// it is a GeneratorError `nondeterministic` naming the first file that differs. The first run's files
// are copied, as they were hashed, to the instance directory (this process's own: files 0444,
// directories 0755); each run's directories are deleted once it is read, /output through
// sandbox.removeTree (what the sandbox user wrote may not be this process's to delete; a directory the
// generator left read-only is unlocked first, by this process for its own and, on docker, by the
// reclaim container for the sandbox user's; on k8s every tree the generator wrote came back as this
// process's own, so removeTree is this process's unlockOwn and rm, no pod; a tree nested past
// PATH_MAX goes too: grade.ts removeWritable). On any
// failure the instance directory is removed too.
//
// It returns GeneratedInstance (server/competitions/instance.ts), what makeInstanceDraw records: the
// tree digests, instance_sha256 (program.ts programDataSha256 over the two trees, so a run's
// dataset_sha256 on the instance equals it), the file counts and bytes, and both runs'
// {exit_code, wall_ms, stdout_sha256, stderr_sha256}. A sandbox fault is a SandboxError, never the
// generator's; a malformed argument is a RangeError.

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Limits, scorerDirOf } from '../contracts/competition.ts';
import {
  GeneratedInstance,
  INSTANCE_MAX_BYTES,
  INSTANCE_MAX_FILES,
  INSTANCE_SEED_FILE,
  INSTANCE_SEED_SCHEMA,
  InstanceSeedFile,
  MAX_SEALED_INPUT_BYTES,
  type GeneratedInstanceT,
  type InstanceRunT,
} from '../server/competitions/instance.ts';
import { comparePaths } from '../server/repos/index-tar.ts';
import { canonicalSha256, compareCodeUnits } from '../sim/canonical.ts';
import { removeOwnTree, removeWritable } from './grade.ts';
import {
  MAX_OUTPUT_DEPTH,
  MAX_OUTPUT_PATH_BYTES,
  MAX_PROGRAM_STDOUT_BYTES,
  OUTPUT_WATCH_MS,
  outputPathBroken,
  outputReadingBroken,
  outputUnreachable,
  PROGRAM_DATA_FORMAT,
  sealStaged,
  shownPath,
  STAGED_OWNER_DIRS,
} from './program.ts';
import { driverFailure, MAX_STDERR_BYTES, stderrTail, type LimitsT } from './run.ts';
import { describeExit, Stopped, Supervisor, type StopReason } from './sandbox/io.ts';
import { UnreadGrace } from './sandbox/k8s-watch.ts';
import { LeftoverError, SandboxError, type Runtime, type Sandbox, type SandboxExit, type SandboxReturns, type SandboxSpec, type TreeMeter, type TreeMeterOptions, type TreeUsage } from './sandbox/types.ts';
import { unlockOwn } from './sandbox/unlock.ts';

/** The two directories a generator writes under /output: the instance's input data and its reference data. */
export const INSTANCE_DIRS = ['input', 'reference'] as const;
export type InstanceDirName = (typeof INSTANCE_DIRS)[number];

/** How many times the generator runs on one seed; every run must draw the same instance. */
export const GENERATOR_RUNS = 2;

/** The default container name stem. */
export const GENERATOR_LABEL = 'generator';

/** A path segment an instance may hold (program.ts's output rule): no dot-files, nothing a shell or a mount spec reads. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** The most files GeneratorOptions.inputs puts beside /input/seed.json. */
export const MAX_GENERATOR_INPUTS = 8;

/** The most UTF-8 bytes GeneratorOptions.inputs holds together: one sealed input's cap (server/competitions/instance.ts MAX_SEALED_INPUT_BYTES). */
export const MAX_GENERATOR_INPUT_BYTES = MAX_SEALED_INPUT_BYTES;

/** The longest input file name, in bytes (a host's NAME_MAX). */
const MAX_INPUT_NAME_BYTES = 255;

/**
 * How much of the generator's /output may come back from its sandbox (SandboxMount.returns): exactly the instance's
 * caps. A copying driver returns the one entry past a cap as well, so the breach is still seen in the returned tree and
 * judged the generator's, in today's words (program.ts OUTPUT_RETURNS).
 */
export const INSTANCE_RETURNS: SandboxReturns = Object.freeze({ maxEntries: INSTANCE_MAX_FILES, maxBytes: INSTANCE_MAX_BYTES });

const TOO_MANY_FILES = `the instance holds more than ${INSTANCE_MAX_FILES} files and directories`;
const TOO_MANY_BYTES = `the instance holds more than ${INSTANCE_MAX_BYTES} bytes`;
const TOO_DEEP = `the instance is nested more than ${MAX_OUTPUT_DEPTH} levels deep`;
const TOO_LONG = `the instance holds a path longer than ${MAX_OUTPUT_PATH_BYTES} bytes`;
const NOT_REGULAR = 'is not a regular file (a symbolic link or a special file)';

// ---------------------------------------------------------------- errors

/** Why a generator drew no instance; each names one thing the generator did. */
export const GENERATOR_ERROR_CODES = [
  /** A run exited non-zero or on a signal, or broke its stdout or stderr cap. */
  'failed',
  /** A run's wall budget (limits.wall_budget_sec) ran out. */
  'timeout',
  /** A run's /output broke the instance rules: the two directories only, regular files only, plain names, the caps; or held what the sandbox could not delete after the run. */
  'output',
  /** The two runs on one seed drew different instances. */
  'nondeterministic',
] as const;
export type GeneratorErrorCode = (typeof GENERATOR_ERROR_CODES)[number];

/** The generator's fault (never the sandbox's): a stable code, a message fit to show, and the facts behind it. */
export class GeneratorError extends Error {
  readonly code: GeneratorErrorCode;
  readonly detail: Readonly<Record<string, string | number | null>>;

  constructor(code: GeneratorErrorCode, message: string, detail: Record<string, string | number | null> = {}) {
    super(message);
    this.name = 'GeneratorError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

export function isGeneratorError(err: unknown, code?: GeneratorErrorCode): err is GeneratorError {
  return err instanceof GeneratorError && (code === undefined || err.code === code);
}

// ---------------------------------------------------------------- the runner

/** A file the generator reads at /input/<name> beside seed.json: a scored draw's sealed input (server/competitions/instance.ts checkSealedInput's answer). */
export interface GeneratorInput {
  /** A plain segment (letters, digits, '.', '_', '-', not starting with '.' or '-'), never seed.json. */
  name: string;
  /** Its text, written as UTF-8. */
  text: string;
}

export interface GeneratorOptions {
  sandbox: Sandbox;
  /** The generator's runtime (harness.generator.runtime). */
  runtime: Runtime;
  /** Absolute host directory mounted read-only at /bot: the generator directory (scorerDirOf of the entrypoint, or a copy of it). */
  generatorDir: string;
  /** harness.generator.entrypoint, e.g. generator/draw.ts; the script run is its last segment, inside generatorDir. */
  entrypoint: string;
  /** /input/seed.json's text: instanceSeedFile(...).text. */
  seedJson: string;
  /** Files written beside /input/seed.json, each 0444 (a scored draw's sealed input; never a practice draw's). Absent or empty: /input holds seed.json alone. */
  inputs?: readonly GeneratorInput[];
  /** The generator's sandbox limits (the sidecar's `limits`). */
  limits: LimitsT;
  /** An existing directory this runner may use: the run directories come and go under it. */
  workDir: string;
  /** Where the instance lands: a path that does not exist yet, under an existing directory. Default <workDir>/instance. */
  instanceDir?: string;
  /** Run this image digest instead of the pinned one (a re-run of a recorded draw). */
  imageDigest?: string | null;
  /** Container name stem (default GENERATOR_LABEL). */
  label?: string;
}

export interface GeneratorResult {
  /** What the two runs drew: makeInstanceDraw's `instance`, and the sidecar's practice digests. */
  instance: GeneratedInstanceT;
  /** The image the generator ran in (the one asked for, else the sandbox's pinned one); null on the process driver. */
  imageDigest: string | null;
  /** The instance directory, holding input/ and reference/: the first run's files, as hashed. */
  dir: string;
  /** <dir>/input: the instance's input data (an entry's /input). */
  inputDir: string;
  /** <dir>/reference: the instance's reference data (the scorer's /reference). */
  referenceDir: string;
}

/**
 * Run the generator twice on one seed and keep the instance it drew (see the header). Throws
 * GeneratorError for the generator's fault, SandboxError for the sandbox's, RangeError for a
 * malformed argument (before anything runs). Each run's directories are deleted once it ends,
 * however it ends; on any throw the instance directory is deleted too.
 */
export async function runGenerator(opts: GeneratorOptions): Promise<GeneratorResult> {
  const script = generatorScript(opts.entrypoint);
  checkSeedJson(opts.seedJson);
  const inputs = checkInputs(opts.inputs);
  const limits = Limits.safeParse(opts.limits);
  if (!limits.success) throw new RangeError(`the generator's limits are not sandbox limits: ${limits.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const instanceDir = opts.instanceDir ?? join(opts.workDir, 'instance');
  await mustBeDirectory(opts.workDir, 'workDir');
  await mustBeDirectory(dirname(instanceDir), "instanceDir's parent");
  await mustNotExist(instanceDir, 'instanceDir');
  const imageDigest = opts.imageDigest ?? opts.sandbox.imageDigest(opts.runtime);
  await opts.sandbox.preflight(opts.runtime, opts.imageDigest ?? null);

  try {
    const drawn: Drawn[] = [];
    for (let n = 1; n <= GENERATOR_RUNS; n++) {
      const runDir = join(opts.workDir, `run-${n}`);
      drawn.push(await afterwards(() => runOnce({ ...opts, inputs, limits: limits.data }, script, n, runDir, n === 1 ? instanceDir : null), () => removeRun(opts.sandbox, runDir, n)));
    }
    const first = drawn[0]!;
    const digests = drawn.map((d) => ({ input: treeDigest(d.tree.input), reference: treeDigest(d.tree.reference) }));
    const [a, b] = [digests[0]!, digests[1]!];
    if (a.input !== b.input || a.reference !== b.reference) {
      const where = firstDifference(first.tree, drawn[1]!.tree) ?? 'their tree digests differ';
      throw new GeneratorError('nondeterministic', `the generator is not deterministic: two runs on one seed drew different instances (${where})`, {
        input_sha256_1: a.input,
        input_sha256_2: b.input,
        reference_sha256_1: a.reference,
        reference_sha256_2: b.reference,
      });
    }
    const instance = GeneratedInstance.parse({
      input_sha256: a.input,
      reference_sha256: a.reference,
      instance_sha256: canonicalSha256({ format: PROGRAM_DATA_FORMAT, input: manifest(first.tree.input), reference: manifest(first.tree.reference) }),
      files: { input: first.tree.input.length, reference: first.tree.reference.length },
      bytes: first.tree.bytes,
      runs: drawn.map((d) => d.run),
    });
    return { instance, imageDigest, dir: instanceDir, inputDir: join(instanceDir, 'input'), referenceDir: join(instanceDir, 'reference') };
  } catch (err) {
    await rm(instanceDir, { recursive: true, force: true });
    throw err;
  }
}

/** The script a generator entrypoint runs inside its directory: the entrypoint's last segment. */
export function generatorScript(entrypoint: string): string {
  if (typeof entrypoint !== 'string' || entrypoint === '') throw new RangeError('the generator entrypoint is a bundle path, e.g. generator/draw.ts');
  const dir = scorerDirOf(entrypoint);
  const script = dir === '.' ? entrypoint : entrypoint.slice(dir.length + 1);
  if (!SEGMENT.test(script)) throw new RangeError(`the generator entrypoint ${JSON.stringify(entrypoint)} does not end in a script name`);
  return script;
}

// ---------------------------------------------------------------- one run

interface TreeFile {
  /** Relative to its directory (input/ or reference/), POSIX. */
  path: string;
  size: number;
  sha256: string;
}

/** What one run drew: each directory's files, and the bytes of both. */
interface DrawnTree {
  input: TreeFile[];
  reference: TreeFile[];
  bytes: number;
}

interface Drawn {
  tree: DrawnTree;
  run: InstanceRunT;
}

/** One run in fresh directories under runDir; with copyTo, its files are copied there as they are read. */
async function runOnce(opts: GeneratorOptions, script: string, n: number, runDir: string, copyTo: string | null): Promise<Drawn> {
  const seedDir = join(runDir, 'seed');
  const outputDir = join(runDir, 'output');
  await mkdir(runDir, { mode: 0o700 });
  await mkdir(seedDir, { mode: 0o700 });
  await writeFile(join(seedDir, INSTANCE_SEED_FILE), opts.seedJson, { flag: 'wx', mode: 0o600 });
  // The inputs beside the seed (a scored draw's sealed input), checked by runGenerator: plain names, none of them seed.json.
  for (const input of opts.inputs ?? []) await writeFile(join(seedDir, input.name), input.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  // Readable by the sandbox user (65534), writable by no one, whatever the mount says or the umask (program.ts sealStaged).
  await sealStaged(seedDir);
  await mkdir(outputDir, { mode: 0o700 });
  // The sandbox user writes here; the run directory above stays private to this process.
  await chmod(outputDir, 0o777);

  const spec: SandboxSpec = {
    runtime: opts.runtime,
    codeDir: opts.generatorDir,
    script,
    mounts: [
      { host: seedDir, at: '/input', readOnly: true },
      { host: outputDir, at: '/output', readOnly: false, returns: INSTANCE_RETURNS },
    ],
    limits: opts.limits,
    label: opts.label ?? GENERATOR_LABEL,
    imageDigest: opts.imageDigest ?? null,
  };
  // The cap the watcher or the meter stopped the run for (a violation of the instance, not of stdout or stderr).
  const watch: { broken: string | null; busy: boolean } = { broken: null, busy: false };
  // The sandbox's own count of /output (docker's whatever its modes, k8s's with its unread directories); null on the process driver.
  let meter: TreeMeter | null = null;
  // Its fault: the sandbox's, never the generator's (a SandboxError).
  const metered: { fault: string | null } = { fault: null };
  const grace = new UnreadGrace(OUTPUT_WATCH_MS);
  // What the meter reports goes to the generator's supervisor, made as soon as the generator is: a driver reports from
  // its meter's output, never inside the call that starts it, so `live.sup` is set by the time a report arrives.
  const live: { sup: Supervisor | null } = { sup: null };
  const meterOpts: TreeMeterOptions = {
    runtime: opts.runtime,
    imageDigest: opts.imageDigest ?? null,
    label: opts.label ?? GENERATOR_LABEL,
    budgetMs: opts.limits.wall_budget_sec * 1000,
    intervalMs: OUTPUT_WATCH_MS,
    maxEntries: INSTANCE_MAX_FILES,
    maxBytes: INSTANCE_MAX_BYTES,
    maxDepth: MAX_OUTPUT_DEPTH,
    maxPathBytes: MAX_OUTPUT_PATH_BYTES,
    onUsage: (u) => {
      const running = live.sup;
      const why = outputReadingBroken(u, grace, usageBroken);
      if (running === null || why === null || running.exit !== null || running.stopped !== null) return;
      watch.broken = why;
      running.violate(why);
    },
    onFault: (why) => {
      const running = live.sup;
      if (running === null || running.exit !== null || running.stopped !== null) return;
      metered.fault = why;
      void running.kill();
    },
  };
  // The generator, then (below) its meter.
  const proc = opts.sandbox.spawn(spec);
  const sup = new Supervisor(proc, {
    budgetMs: opts.limits.wall_budget_sec * 1000,
    maxStderrBytes: MAX_STDERR_BYTES,
    stdout: { mode: 'capture', maxBytes: MAX_PROGRAM_STDOUT_BYTES },
  });
  live.sup = sup;
  sup.closeStdin();
  // The host walker judges only while the generator runs (program.ts executeIn's watcher): from its end (sup.endedAt,
  // the process's `finished` where the driver has one) the replica k8s returns is readTree's to judge.
  const watcher = setInterval(() => {
    if (watch.busy || sup.endedAt !== null || sup.stopped !== null) return;
    watch.busy = true;
    void capsBroken(outputDir)
      .then((why) => {
        if (why === null || sup.endedAt !== null || sup.stopped !== null) return;
        watch.broken = why;
        sup.violate(why);
      })
      .catch(() => undefined)
      .finally(() => {
        watch.busy = false;
      });
  }, OUTPUT_WATCH_MS);

  let outcome: SandboxExit | StopReason | 'grace';
  try {
    meter = opts.sandbox.meterTree?.(outputDir, meterOpts) ?? null;
    outcome = await sup.waitExit(Math.max(0, sup.remainingMs()));
  } catch (err) {
    await sup.kill();
    if (!(err instanceof Stopped)) throw err;
    outcome = err.reason;
  } finally {
    clearInterval(watcher);
    await meter?.stop();
  }
  if (metered.fault !== null) throw new SandboxError(`the sandbox could not meter the generator's /output: ${metered.fault}`);

  const fail = (code: GeneratorErrorCode, message: string) => new GeneratorError(code, `generator run ${n} of ${GENERATOR_RUNS}: ${message}`, { run: n });
  const tail = () => {
    const t = stderrTail(sup.stderr());
    return t === '' ? '' : `: ${t}`;
  };
  const timeout = () => fail('timeout', `the wall budget of ${opts.limits.wall_budget_sec} s ran out`);
  let exit: SandboxExit;
  if (outcome === 'grace') {
    await sup.kill();
    throw timeout();
  } else if ('kind' in outcome) {
    if (outcome.kind === 'timeout') throw timeout();
    if (outcome.kind === 'violation') {
      if (outcome.message === watch.broken) throw fail('output', outcome.message);
      throw fail('failed', `${outcome.message}${tail()}`);
    }
    exit = outcome.exit;
  } else {
    exit = outcome;
  }
  if (opts.sandbox.isDriverFailure(exit)) throw driverFailure(proc, `the sandbox failed running the generator (${describeExit(exit)})${tail()}`);
  if (exit.code !== 0) throw fail('failed', `the generator exited with ${describeExit(exit)}${tail()}`);

  const tree = await readTree(outputDir, copyTo);
  if ('violation' in tree) throw fail('output', tree.violation);
  return {
    tree,
    run: { exit_code: 0, wall_ms: Math.round(sup.elapsedMs()), stdout_sha256: sha256(sup.stdoutCapture()), stderr_sha256: sha256(sup.stderr()) },
  };
}

/**
 * Delete run n's directories: /output through the sandbox (its user's files may not be this
 * process's to delete), then the rest, which is this process's own. Before that, this process's own
 * directories under /output get their owner's rwx back (/output stays 0777): where the generator runs
 * as this process's user (the process driver) a directory it left read-only is this process's to
 * unlock; under docker the sandbox's user unlocks its own (docker.ts RECLAIM_SCRIPT), and under k8s
 * what the generator wrote came back as this process's own (k8s.ts removeTree: unlockOwn, then rm,
 * no pod); a tree nested past PATH_MAX is deleted all the same (grade.ts removeWritable). What the
 * sandbox still cannot delete is what the generator left: a GeneratorError `output`; the sandbox
 * failing to delete (docker unreachable; on k8s, another uid's scratch an older pod shape left)
 * stays the sandbox's error. Either way this process's own seed directory goes.
 */
async function removeRun(sandbox: Sandbox, runDir: string, n: number): Promise<void> {
  const outputDir = join(runDir, 'output');
  const seedDir = join(runDir, 'seed');
  await unlockOwn(outputDir);
  try {
    await removeWritable(sandbox, outputDir);
  } catch (err) {
    await chmod(seedDir, 0o700).catch(() => undefined);
    await rm(seedDir, { recursive: true, force: true }).catch(() => undefined);
    if (!leftByProgram(err)) throw err;
    const why = (err instanceof Error ? err.message : String(err)).split('\n')[0];
    throw new GeneratorError('output', `generator run ${n} of ${GENERATOR_RUNS}: what it left under /output could not be deleted (${why})`, { run: n });
  }
  try {
    await chmod(seedDir, 0o700);
  } catch (err) {
    if (errno(err) !== 'ENOENT') throw err;
  }
  await removeOwnTree(runDir);
}

/**
 * removeTree's failure that is what the program left, not the sandbox failing: docker's reclaim ran
 * as the sandbox user and could not delete it, or the process driver's own rm was refused (it runs the
 * program as this process's user, so nothing there is another user's). The k8s driver's refused rm
 * is a SandboxError (another uid's scratch, never the program's), so it is not this.
 */
function leftByProgram(err: unknown): boolean {
  if (err instanceof LeftoverError) return true;
  if (err instanceof SandboxError) return false;
  const code = errno(err);
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOTEMPTY';
}

/** `body`, then `cleanup` whatever happened; body's error wins over cleanup's. */
async function afterwards<T>(body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let value: T;
  try {
    value = await body();
  } catch (err) {
    await cleanup().catch(() => undefined);
    throw err;
  }
  await cleanup();
  return value;
}

// ---------------------------------------------------------------- reading what a run drew

/** The first cap a meter reading of a run's /output breaks, or null. */
function usageBroken(u: TreeUsage): string | null {
  if (u.entries > INSTANCE_MAX_FILES) return TOO_MANY_FILES;
  if (u.bytes > INSTANCE_MAX_BYTES) return TOO_MANY_BYTES;
  if (u.depth > MAX_OUTPUT_DEPTH) return TOO_DEEP;
  if (u.longPaths > 0) return TOO_LONG;
  return null;
}

/** The violation of a path under /output (`relPath` relative to it) too deep or too long, or null. */
function shapeBroken(relPath: string): string | null {
  const broken = outputPathBroken(relPath);
  if (broken === 'depth') return `${shownPath(`/output/${relPath}`)} is nested more than ${MAX_OUTPUT_DEPTH} levels deep`;
  if (broken === 'length') return `the path ${shownPath(`/output/${relPath}`)} is longer than ${MAX_OUTPUT_PATH_BYTES} bytes`;
  return null;
}

/**
 * While a run runs: the first cap its /output breaks, or null. Never follows a link, never descends
 * past the depth and path caps, and skips what it cannot read.
 */
async function capsBroken(outputDir: string): Promise<string | null> {
  let count = 0;
  let bytes = 0;
  let allocated = 0;
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = await readdir(join(outputDir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
      const shape = shapeBroken(relPath);
      if (shape !== null) return shape;
      count += 1;
      if (count > INSTANCE_MAX_FILES) return TOO_MANY_FILES;
      if (e.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try {
        st = await lstat(join(outputDir, relPath));
      } catch {
        continue;
      }
      bytes += st.size;
      allocated += st.blocks * 512;
      if (bytes > INSTANCE_MAX_BYTES || allocated > INSTANCE_MAX_BYTES) return TOO_MANY_BYTES;
    }
  }
  return null;
}

/**
 * After a run exits 0: its /output checked against the instance rules and every file read and hashed
 * once (copied to copyTo as read, when given), or the first rule it breaks.
 */
async function readTree(outputDir: string, copyTo: string | null): Promise<DrawnTree | { violation: string }> {
  let top: string[];
  try {
    top = (await readdir(outputDir)).sort(compareCodeUnits);
  } catch (err) {
    if (isAccess(err)) return { violation: '/output is not readable' };
    throw err;
  }
  const stray = top.find((name) => !(INSTANCE_DIRS as readonly string[]).includes(name));
  if (stray !== undefined) return { violation: `/output/${stray}: a generator writes only /output/input/ and /output/reference/` };
  if (copyTo !== null) await mkdir(copyTo, { mode: 0o755 });

  const tree: DrawnTree = { input: [], reference: [], bytes: 0 };
  // Every entry under /output, directories (input/ and reference/ too) as well as files.
  let count = 0;
  // The files' allocated total (tree.bytes is their apparent one): the cap holds the larger.
  let allocated = 0;
  for (const dir of INSTANCE_DIRS) {
    const root = join(outputDir, dir);
    let st;
    try {
      st = await lstat(root);
    } catch (err) {
      if (errno(err) === 'ENOENT') return { violation: `the generator wrote no /output/${dir}/ directory` };
      throw err;
    }
    if (!st.isDirectory()) return { violation: `/output/${dir} is not a directory` };
    count += 1;
    if (count > INSTANCE_MAX_FILES) return { violation: TOO_MANY_FILES };
    if (copyTo !== null) await mkdir(join(copyTo, dir), { mode: 0o755 });
    const stack = [''];
    while (stack.length > 0) {
      const rel = stack.pop()!;
      const shownDir = shownPath(`/output/${dir}${rel === '' ? '' : `/${rel}`}`);
      let names: string[];
      try {
        names = (await readdir(join(root, rel))).sort(compareCodeUnits);
      } catch (err) {
        const why = outputUnreachable(err);
        if (why !== null) return { violation: `${shownDir} ${why}` };
        if (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR') return { violation: `${shownDir} changed while it was read` };
        throw err;
      }
      for (const name of names) {
        const relPath = rel === '' ? name : `${rel}/${name}`;
        const shown = shownPath(`/output/${dir}/${relPath}`);
        if (!SEGMENT.test(name)) return { violation: `${shown} is not a plain name (letters, digits, '.', '_' and '-', not starting with '.' or '-')` };
        const shape = shapeBroken(`${dir}/${relPath}`);
        if (shape !== null) return { violation: shape };
        const abs = join(root, relPath);
        let est;
        try {
          est = await lstat(abs);
        } catch (err) {
          if (errno(err) === 'ENOENT') return { violation: `${shown} changed while it was read` };
          const why = outputUnreachable(err);
          if (why !== null) return { violation: `${shown} ${why}` };
          throw err;
        }
        count += 1;
        if (count > INSTANCE_MAX_FILES) return { violation: TOO_MANY_FILES };
        if (est.isDirectory()) {
          if (copyTo !== null) await mkdir(join(copyTo, dir, relPath), { mode: 0o755 });
          stack.push(relPath);
          continue;
        }
        if (!est.isFile()) return { violation: `${shown} ${NOT_REGULAR}` };
        allocated += est.blocks * 512;
        if (allocated > INSTANCE_MAX_BYTES) return { violation: TOO_MANY_BYTES };
        const read = await readRegular(abs, INSTANCE_MAX_BYTES - tree.bytes);
        if ('violation' in read) return { violation: read.violation === TOO_MANY_BYTES ? TOO_MANY_BYTES : `${shown} ${read.violation}` };
        tree.bytes += read.bytes.length;
        tree[dir].push({ path: relPath, size: read.bytes.length, sha256: sha256(read.bytes) });
        if (copyTo !== null) await writeFile(join(copyTo, dir, relPath), read.bytes, { flag: 'wx', mode: 0o600 });
      }
    }
  }
  // The copy readable by the sandbox user whatever the umask (program.ts sealStaged): files 0444, directories 0755.
  if (copyTo !== null) await sealStaged(copyTo, STAGED_OWNER_DIRS);
  return tree;
}

/** A regular file's bytes, at most `room` of them; never through a link, never blocking on a FIFO. */
async function readRegular(abs: string, room: number): Promise<{ bytes: Buffer } | { violation: string }> {
  let fh;
  try {
    fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = errno(err);
    if (code === 'ELOOP' || code === 'EMLINK') return { violation: NOT_REGULAR };
    if (code === 'ENOENT') return { violation: 'changed while it was read' };
    const why = outputUnreachable(err);
    if (why !== null) return { violation: why };
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { violation: NOT_REGULAR };
    if (st.size > room) return { violation: TOO_MANY_BYTES };
    const bytes = await fh.readFile();
    if (bytes.length > room) return { violation: TOO_MANY_BYTES };
    return { bytes };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- digests

/** The tree digest of one directory's files: sha256 over `<path>\0<sha256>\n` in code-unit order (load.ts treeSha256). */
function treeDigest(files: readonly TreeFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((x, y) => compareCodeUnits(x.path, y.path))) h.update(`${f.path}\0${f.sha256}\n`);
  return h.digest('hex');
}

/** One directory's files as program.ts directoryManifest lists them: [{path, size, sha256}] in UTF-8 path order. */
function manifest(files: readonly TreeFile[]): Array<{ path: string; size: number; sha256: string }> {
  return files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })).sort((x, y) => comparePaths(x.path, y.path));
}

/** The first file two runs drew differently, input/ before reference/, by path; null when their files agree. */
function firstDifference(one: DrawnTree, two: DrawnTree): string | null {
  for (const dir of INSTANCE_DIRS) {
    const a = new Map(one[dir].map((f) => [f.path, f.sha256]));
    const b = new Map(two[dir].map((f) => [f.path, f.sha256]));
    for (const path of [...new Set([...a.keys(), ...b.keys()])].sort(compareCodeUnits)) {
      const x = a.get(path);
      const y = b.get(path);
      if (x === y) continue;
      const shown = `/output/${dir}/${path}`;
      if (x === undefined) return `${shown} was drawn by run 2 only`;
      if (y === undefined) return `${shown} was drawn by run 1 only`;
      return `${shown} differs`;
    }
  }
  return null;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------- arguments

function checkSeedJson(text: string): void {
  if (typeof text !== 'string') throw new RangeError(`seedJson is the text of /input/${INSTANCE_SEED_FILE}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RangeError(`seedJson is not JSON: /input/${INSTANCE_SEED_FILE} is instanceSeedFile's text`);
  }
  const parsed = InstanceSeedFile.safeParse(value);
  if (!parsed.success) {
    throw new RangeError(`seedJson is not an instance seed (${INSTANCE_SEED_SCHEMA}): ${parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ')}`);
  }
}

/**
 * GeneratorOptions.inputs checked before anything runs (RangeError): a list of at most
 * MAX_GENERATOR_INPUTS {name, text}, each name a plain segment of at most 255 bytes, never seed.json
 * and never another input's, the texts MAX_GENERATOR_INPUT_BYTES of UTF-8 together. Returns a copy.
 */
function checkInputs(inputs: readonly GeneratorInput[] | undefined): GeneratorInput[] {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs)) throw new RangeError(`inputs is a list of {name, text}: the files beside /input/${INSTANCE_SEED_FILE}`);
  if (inputs.length > MAX_GENERATOR_INPUTS) throw new RangeError(`inputs holds ${inputs.length} files: at most ${MAX_GENERATOR_INPUTS} go beside /input/${INSTANCE_SEED_FILE}`);
  const names = new Set<string>();
  let bytes = 0;
  return inputs.map((input: unknown, i) => {
    const { name, text } = (typeof input === 'object' && input !== null ? input : {}) as { name?: unknown; text?: unknown };
    if (typeof name !== 'string' || typeof text !== 'string') throw new RangeError(`inputs[${i}] is not {name, text}: a file name and its text`);
    if (!SEGMENT.test(name) || Buffer.byteLength(name, 'utf8') > MAX_INPUT_NAME_BYTES) {
      throw new RangeError(`inputs[${i}] is named ${JSON.stringify(name)}: an input is a plain name (letters, digits, '.', '_' and '-', not starting with '.' or '-'), at most ${MAX_INPUT_NAME_BYTES} bytes`);
    }
    if (name === INSTANCE_SEED_FILE) throw new RangeError(`inputs[${i}] is named ${INSTANCE_SEED_FILE}: that is the seed's own file, from seedJson`);
    if (names.has(name)) throw new RangeError(`inputs[${i}] is named ${JSON.stringify(name)}, as an input before it is: each file is written once`);
    names.add(name);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_GENERATOR_INPUT_BYTES) throw new RangeError(`inputs hold more than ${MAX_GENERATOR_INPUT_BYTES} bytes of UTF-8 text together`);
    return { name, text };
  });
}

async function mustBeDirectory(path: string, name: string): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    throw new RangeError(`${name} ${path} does not exist`);
  }
  if (!st.isDirectory()) throw new RangeError(`${name} ${path} is not a directory`);
}

async function mustNotExist(path: string, name: string): Promise<void> {
  try {
    await lstat(path);
  } catch (err) {
    if (errno(err) === 'ENOENT') return;
    throw err;
  }
  throw new RangeError(`${name} ${path} already exists: the instance lands in a fresh directory`);
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function isAccess(err: unknown): boolean {
  const code = errno(err);
  return code === 'EACCES' || code === 'EPERM';
}
