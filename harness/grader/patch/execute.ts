// One patch/v1 run: the entrant's patch.diff applied to the sealed upstream tree and the phase's ratified
// tests run against it, in the competition's own test image (contracts/patch.ts PatchImage) by the house
// runner (grader/patch/runner/run.sh). Its action log is the run log (junit.ts PatchRunLog): whether the
// patch applied (or why it was refused), one status per ratified test id, and how the tests' exit status
// read against their report (exit_check).
//
//   executePatch      the entry's run: parsePatch (diff.ts) first, then the base tree's own check (a path
//                     the base holds as a symlink, or one beyond such a link), each refusal a run log with
//                     no container; an accepted patch is applied and the tests run (unless git apply reads
//                     other paths in it than diff.ts did: refused `unsafe_path` in the container, never
//                     applied); a missing patch.diff is refused `missing`
//   executePatchBase  the base as sealed, no patch (the pack check's base runs): its log applied, never refused
//   patchTreeDir      a sealed tree (the base, a phase tree: one snapshot format, server/repos/index-tar.ts)
//                     materialized read-only under a cache root, <cacheRoot>/<digest>/, re-verified
//                     against its index every time it is asked for; made into a scratch name renamed into
//                     place, so a reader never sees half a tree and two makers of one digest leave one
//   readPatchLists    a materialized phase tree's lists.json (contracts/patch.ts PatchLists)
//
// The container (an image spec, grader/sandbox/types.ts: the docker driver's; the process driver runs
// run.sh under the host's sh) mounts, all read-only: /bot, a scratch directory holding run.sh's bytes and
// test.sh (the test argv as the shell function makefun_test, the report path and the caps: testScript),
// and with a patch what git apply --numstat -z must print of it, forward and with -R (diff.ts patchNumstat:
// the paths diff.ts read, which run.sh holds git to before it applies anything, a patch git reads other
// paths in refused unsafe_path); /input, a scratch directory holding patch.diff alone (nothing of the
// entry besides); /base; /tests, the phase tree's overlay/ alone (testsMount), never its lists.json nor the
// final's salt: the code under test writes the report the grade reads, so a run that could read which ids
// are the canaries could forge one that passes them (score.ts patchTampered). /work is its tmpfs of
// work_mb. Nothing it runs writes a host directory: what reaches the grader is the frame run.sh writes on
// stdout once the tests have exited (readFrame), held to MAX_FRAME_BYTES by the Supervisor, and stderr to
// MAX_STDERR_BYTES.
//
// Reading the frame, fail closed: the report is parsed (junit.ts parseJunit) only from a run the tests ran
// in; none, or one parseJunit refuses, is no report (every status M, the patch unresolved), its reason kept
// on the execution (report_issue), never in the log. The report is the run's own, but the exit code (and
// the signal, a code over 128) is what run.sh saw the test argv end with: score.ts patchExitCheck holds
// the one to the other into the log's exit_check (a signal, exit 0 beside a failed testcase, or a non-zero
// exit beside none is tampered), so a report the code under test forged must also end the run as the
// report implies, by an exit of its own. test.log comes back (test_log) only when the caller
// keeps it (keepTestLog: the pack check, the dev phase), never for the final phase.
//
// Outcomes: a refusal or a run the tests ran in is `ok` with its log; the wall budget running out is
// `timeout`; the runner exiting non-zero after its setup (the code under test can starve it), a frame
// that does not parse, or a stdout or stderr cap broken is `failed`; the runner's own setup failing (exit
// SETUP_FAILED_EXIT: the base would not copy, the work tree would not take it) and a runner that saw no
// patch where one was given (or one where none was) are harness faults, thrown (PatchRunnerError), as is a
// sandbox driver failure (SandboxError; a NodeRoomError when the node had no room for its pod: run.ts driverFailure).

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { PATCH_LISTS_FILE, PATCH_OVERLAY_DIR, PatchLists, type PatchHarnessT, type PatchListsT, type PatchRefusalT, type PatchTestT } from '../../contracts/patch.ts';
import type { BlobStore } from '../../server/blobstore.ts';
import { materializeSnapshot, readSnapshotIndex, removeMaterialized, type SnapshotIndex } from '../../server/repos/index-tar.ts';
import { canonicalJson, sha256Hex } from '../../sim/canonical.ts';
import type { ExecuteContext } from '../harnesses.ts';
import { driverFailure, executionOf, MAX_STDERR_BYTES, stderrTail, type Execution } from '../run.ts';
import { describeExit, describeStop, Stopped, Supervisor } from '../sandbox/io.ts';
import type { SandboxSpec } from '../sandbox/types.ts';
import { PATCH_DIFF_FILE, parsePatch, patchNumstat, type PatchFile } from './diff.ts';
import { MAX_JUNIT_BYTES, parseJunit, patchRunLog, type JunitRefusalT, type JunitReport, type PatchRunLogT } from './junit.ts';
import { patchExitCheck } from './score.ts';

/** The house runner's directory and script (a HARNESS_SOURCES file: grader/version.ts). */
export const PATCH_RUNNER_DIR = fileURLToPath(new URL('./runner/', import.meta.url)).replace(/[\\/]$/, '');
export const PATCH_RUNNER_SCRIPT = 'run.sh';
/** What run.sh reads its test command, report path and caps from, beside it in /bot (testScript). */
export const PATCH_TEST_SCRIPT = 'test.sh';
/** What git apply --numstat -z -p1 must print of the patch, and with -R (diff.ts patchNumstat), beside run.sh in /bot. */
export const PATCH_NUMSTAT_FILE = 'patch.numstat';
export const PATCH_NUMSTAT_REVERSE_FILE = 'patch.numstat-R';
/** The container's command: the image's own sh running the house runner. */
export const PATCH_RUNNER_ARGV: readonly string[] = Object.freeze(['/bin/sh', `/bot/${PATCH_RUNNER_SCRIPT}`]);
/** run.sh's exit when its own setup failed, before the patch was looked at. */
export const SETUP_FAILED_EXIT = 3;

/** The most of test.log a run keeps (run.sh's `head -c`). */
export const PATCH_TEST_LOG_MAX_BYTES = 1_048_576;
/** The most of git apply's own stderr a run keeps: the detail of an apply_failed refusal. */
export const PATCH_APPLY_LOG_MAX_BYTES = 4096;
/** The most of a report run.sh sends: one byte past parseJunit's cap, so an oversized report is refused too_large. */
export const PATCH_REPORT_MAX_BYTES = MAX_JUNIT_BYTES + 1;
/** The frame's cap: its header lines and the three payloads at their caps. */
export const MAX_FRAME_BYTES = PATCH_REPORT_MAX_BYTES + PATCH_APPLY_LOG_MAX_BYTES + PATCH_TEST_LOG_MAX_BYTES + 4096;

/** The cache roots (under a grader's work root) the base trees and the phase trees are materialized in. */
export const PATCH_BASE_CACHE = 'patch-base';
export const PATCH_PHASE_CACHE = 'patch-phase';
/** A maker's scratch name older than this is a dead maker's. */
const STALE_TREE_SCRATCH_MS = 6 * 60 * 60 * 1000;
/** The most of lists.json readPatchLists reads: four lists of at most 10 000 ids of at most 512 bytes, JSON-escaped. */
const MAX_LISTS_BYTES = 256 * 1024 * 1024;

/** A harness fault in a patch run: the house runner failed, or ran other than it was asked to. Never the entry's. */
export class PatchRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchRunnerError';
  }
}

// ---------------------------------------------------------------- the trees

/** A sealed tree, materialized read-only (patchTreeDir), and the snapshot index it was made from. */
export interface PatchTree {
  dir: string;
  index: SnapshotIndex;
}

/** Whether anything is at `path` (never following a link). */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

const sha256OfFile = async (path: string): Promise<string> => {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
};

/**
 * Whether `dir` holds exactly what materializeSnapshot makes of `index`: each file and symlink, nothing else
 * but their directories, each file's bytes and mode (0444, 0555 when any execute bit is set), each symlink's
 * target, every directory 0555. False for anything it cannot read.
 */
export async function treeMatches(dir: string, index: SnapshotIndex): Promise<boolean> {
  const expected = new Map(index.files.map((f) => [f.path, f]));
  const dirs = new Set<string>(['']);
  for (const f of index.files) for (let at = f.path.indexOf('/'); at !== -1; at = f.path.indexOf('/', at + 1)) dirs.add(f.path.slice(0, at));
  let seenFiles = 0;
  let seenDirs = 0;
  const walk = async (rel: string): Promise<boolean> => {
    const abs = rel === '' ? dir : join(dir, rel);
    const st = await lstat(abs);
    if (!st.isDirectory() || (st.mode & 0o777) !== 0o555 || !dirs.has(rel)) return false;
    seenDirs += 1;
    for (const name of await readdir(abs)) {
      const path = rel === '' ? name : `${rel}/${name}`;
      const s = await lstat(join(dir, path));
      if (s.isDirectory()) {
        if (!(await walk(path))) return false;
        continue;
      }
      const f = expected.get(path);
      if (f === undefined) return false;
      seenFiles += 1;
      if (f.kind === 'symlink') {
        if (!s.isSymbolicLink()) return false;
        const target = await readlink(join(dir, path), { encoding: 'buffer' });
        if (target.length !== f.size || sha256Hex(target) !== f.sha256) return false;
      } else {
        if (!s.isFile() || s.size !== f.size || (s.mode & 0o777) !== (f.mode & 0o111 ? 0o555 : 0o444)) return false;
        if ((await sha256OfFile(join(dir, path))) !== f.sha256) return false;
      }
    }
    return true;
  };
  try {
    return (await walk('')) && seenFiles === expected.size && seenDirs === dirs.size;
  } catch (err) {
    if (typeof (err as NodeJS.ErrnoException).code === 'string') return false;
    throw err;
  }
}

/**
 * The sealed tree `digest` (a snapshot index digest: repo.base_tree_sha256, a pack's dev or final tree_sha256)
 * materialized read-only under `cacheRoot` (created on demand), <cacheRoot>/<digest>/, with its index: the index
 * read from `blobs` (readSnapshotIndex, verified), the directory used only when it holds exactly that index
 * (treeMatches), else removed and made again, into a scratch name renamed into place. Throws (index-tar.ts
 * RepoIntakeError) when the index or a blob it names is missing or corrupt, and PatchRunnerError when what was
 * made does not match.
 */
export async function patchTreeDir(o: { blobs: BlobStore; digest: string; cacheRoot: string }): Promise<PatchTree> {
  if (!/^[0-9a-f]{64}$/.test(o.digest)) throw new RangeError(`${JSON.stringify(o.digest)} is not a snapshot digest`);
  const index = await readSnapshotIndex(o.blobs, o.digest);
  const dest = join(o.cacheRoot, o.digest);
  if (await treeMatches(dest, index)) return { dir: dest, index };
  // Damaged, or a dead maker's: made again. Looked at once more first, so a tree another maker has just put in
  // place (a rename only ever lands where nothing is) is used, never removed under its reader.
  if (await present(dest)) {
    if (await treeMatches(dest, index)) return { dir: dest, index };
    await removeMaterialized(dest);
  }
  await mkdir(o.cacheRoot, { recursive: true, mode: 0o755 });
  for (const name of await readdir(o.cacheRoot)) {
    if (!name.startsWith(`.${o.digest}-`)) continue;
    const abs = join(o.cacheRoot, name);
    try {
      if (Date.now() - (await lstat(abs)).mtimeMs > STALE_TREE_SCRATCH_MS) await removeMaterialized(abs);
    } catch {
      // removed meanwhile
    }
  }
  const scratch = join(o.cacheRoot, `.${o.digest}-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await materializeSnapshot(index, o.blobs, scratch);
    try {
      await rename(scratch, dest);
    } catch (err) {
      // Another maker placed it first.
      if (!(await treeMatches(dest, index))) throw err;
    }
  } finally {
    await removeMaterialized(scratch);
  }
  if (!(await treeMatches(dest, index))) throw new PatchRunnerError(`tree ${o.digest} does not match its index where it was materialized (${dest})`);
  return { dir: dest, index };
}

/** A materialized phase tree's lists.json, validated (PatchLists). Throws on one that is missing, not a regular file, or invalid. */
export async function readPatchLists(phaseTreeDir: string): Promise<PatchListsT> {
  const path = join(phaseTreeDir, PATCH_LISTS_FILE);
  const st = await lstat(path);
  if (!st.isFile()) throw new PatchRunnerError(`${path} is not a regular file`);
  if (st.size > MAX_LISTS_BYTES) throw new PatchRunnerError(`${path} is ${st.size} bytes, over ${MAX_LISTS_BYTES}`);
  return PatchLists.parse(JSON.parse(await readFile(path, 'utf8')));
}

/**
 * What /tests mounts of a materialized phase tree: its overlay/ alone, or `empty`, made, when the tree holds
 * none. Throws on a phase tree, or an overlay, that is not a directory.
 */
async function testsMount(phaseTreeDir: string, empty: string): Promise<string> {
  if (!(await lstat(phaseTreeDir)).isDirectory()) throw new PatchRunnerError(`${phaseTreeDir} is not a directory`);
  const overlay = join(phaseTreeDir, PATCH_OVERLAY_DIR);
  const st = await lstat(overlay).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (st === null) {
    await mkdir(empty);
    await chmod(empty, 0o755);
    return empty;
  }
  if (!st.isDirectory()) throw new PatchRunnerError(`${overlay} is not a directory`);
  return overlay;
}

// ---------------------------------------------------------------- the run

/**
 * What a run reads of a patch/v1 harness: never its pack, so the pack build and the witness, which run
 * before the pack's oracle and witness digests exist, pass their manifest's fields alone.
 */
export type PatchRunHarness = Pick<PatchHarnessT, 'image' | 'test' | 'protected_paths' | 'work_mb' | 'max_patch_bytes'>;

export interface PatchExecutionOptions {
  harness: PatchRunHarness;
  /** The sealed base tree (patchTreeDir of repo.base_tree_sha256). */
  base: PatchTree;
  /** The phase's tree, materialized (patchTreeDir of its pack tree_sha256): overlay/ and lists.json. Only overlay/ is mounted. */
  phaseTreeDir: string;
  /** The phase's lists (readPatchLists of phaseTreeDir). */
  lists: PatchListsT;
  /** Return test.log (the pack check, the dev phase); never for the final phase. */
  keepTestLog: boolean;
}

/** What a patch run needs of a harness's execute context (harnesses.ts ExecuteContext). */
export type PatchExecuteContext = Pick<ExecuteContext, 'sandbox' | 'runtime' | 'limits' | 'workDir' | 'label'>;

/** Why a run read no report (every status M), never in the log: `missing`, `overlay_failed`, or a JUnit refusal. */
export type PatchReportIssue = 'missing' | 'overlay_failed' | JunitRefusalT;

export interface PatchExecution extends Execution<PatchRunLogT> {
  /** A refusal's detail (diff.ts's, or git apply's own stderr): the entrant's own feedback, never a public log. */
  refusal_detail: string | null;
  /** Why the run read no report, when the patch applied and none was read. */
  report_issue: PatchReportIssue | null;
  /** test.log as run.sh kept it (at most PATCH_TEST_LOG_MAX_BYTES), only with keepTestLog and a run the tests ran in. */
  test_log: Buffer | null;
  /** The tests' exit code, when they ran. */
  test_exit: number | null;
}

/** An execution with no more said of it than its record: no refusal, no report read, no test log. */
function patchExecution(e: Execution<PatchRunLogT>, more: Partial<Pick<PatchExecution, 'refusal_detail' | 'report_issue' | 'test_log' | 'test_exit'>> = {}): PatchExecution {
  return { ...e, refusal_detail: null, report_issue: null, test_log: null, test_exit: null, ...more };
}

/** A run that never reached a container: its patch refused. */
function refusedExecution(lists: PatchListsT, refused: PatchRefusalT, detail: string): PatchExecution {
  const log = patchRunLog(lists, { applied: false, refused }, null);
  const json = canonicalJson(log);
  const e: Execution<PatchRunLogT> = { status: 'ok', error: null, log, log_json: json, log_sha256: sha256Hex(json), wall_ms: 0, flags: [], stderr: Buffer.alloc(0), exit: null };
  return patchExecution(e, { refusal_detail: detail });
}

/**
 * Why a parsed patch may not touch the base tree (the header), or null: a path the base holds as a symlink is
 * refused `mode` (a diff naming no mode would have git apply write through the link, or move it), a path beyond
 * one (a symlinked directory) `unsafe_path`.
 */
export function baseTreeIssue(files: readonly PatchFile[], index: SnapshotIndex): { refused: 'mode' | 'unsafe_path'; detail: string } | null {
  const links = new Set(index.files.filter((f) => f.kind === 'symlink').map((f) => f.path));
  if (links.size === 0) return null;
  for (const f of files) {
    for (const p of [f.old, f.new]) {
      if (p === null) continue;
      if (links.has(p)) return { refused: 'mode', detail: `${p}: the base tree holds a symlink there, and a patch changes regular files only` };
      for (let at = p.indexOf('/'); at !== -1; at = p.indexOf('/', at + 1)) {
        if (links.has(p.slice(0, at))) return { refused: 'unsafe_path', detail: `${p}: beyond the symlink ${p.slice(0, at)} the base tree holds` };
      }
    }
  }
  return null;
}

/** A single-quoted sh word: every byte literal (an argument holds no NUL: PatchTest). */
const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** test.sh: what run.sh sources beside it (the header). */
export function testScript(test: PatchTestT): string {
  return [
    `makefun_report=${shQuote(test.report_path)}`,
    `makefun_report_max=${PATCH_REPORT_MAX_BYTES}`,
    `makefun_apply_log_max=${PATCH_APPLY_LOG_MAX_BYTES}`,
    `makefun_log_max=${PATCH_TEST_LOG_MAX_BYTES}`,
    // exec: the argv as is, its first word found on PATH, never a shell builtin or function.
    'makefun_test() {',
    `  exec ${test.argv.map(shQuote).join(' ')}`,
    '}',
    '',
  ].join('\n');
}

/** What run.sh's frame says (the header). */
export interface RunnerFrame {
  /** unsafe: git apply --numstat named other paths than diff.ts read (patchNumstat), so nothing was applied. */
  apply: 'none' | 'ok' | 'failed' | 'unsafe';
  overlay: 'none' | 'ok' | 'failed';
  /** The tests' exit code; null when they did not run. */
  exit: number | null;
  /** The signal that ended the tests (the code is 128 + it: run.sh's step 4); null when none did, or they did not run. */
  signal: number | null;
  report: Buffer | null;
  applyLog: Buffer | null;
  log: Buffer | null;
}

const FRAME_MAGIC = 'makefun-patch-run/v1';

/** run.sh's frame, read strictly (every line, every length, nothing after `end`), or why it does not parse. */
export function readFrame(buf: Buffer): { ok: true; frame: RunnerFrame } | { ok: false; why: string } {
  let at = 0;
  const line = (): string | null => {
    const nl = buf.indexOf(0x0a, at);
    if (nl === -1 || nl - at > 64) return null;
    const text = buf.toString('latin1', at, nl);
    at = nl + 1;
    return text;
  };
  const word = <T extends string>(name: string, values: readonly T[]): T | null => {
    const l = line();
    if (l === null || !l.startsWith(`${name} `)) return null;
    const v = l.slice(name.length + 1);
    return (values as readonly string[]).includes(v) ? (v as T) : null;
  };
  const blob = (name: string, cap: number): Buffer | null | undefined => {
    const l = line();
    if (l === null || !l.startsWith(`${name} `)) return undefined;
    const v = l.slice(name.length + 1);
    if (v === 'none') return null;
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(v) || Number(v) > cap) return undefined;
    const n = Number(v);
    if (at + n + 1 > buf.length || buf[at + n] !== 0x0a) return undefined;
    const bytes = buf.subarray(at, at + n);
    at += n + 1;
    return bytes;
  };
  if (line() !== FRAME_MAGIC) return { ok: false, why: `it does not open with ${FRAME_MAGIC}` };
  const apply = word('apply', ['none', 'ok', 'failed', 'unsafe'] as const);
  if (apply === null) return { ok: false, why: 'no apply line' };
  const overlay = word('overlay', ['none', 'ok', 'failed'] as const);
  if (overlay === null) return { ok: false, why: 'no overlay line' };
  const exitLine = line();
  const code = exitLine === null ? null : /^exit (none|0|[1-9][0-9]{0,2})$/.exec(exitLine);
  if (code === null) return { ok: false, why: 'no exit line' };
  const signalLine = line();
  const sig = signalLine === null ? null : /^signal (none|[1-9][0-9]{0,2})$/.exec(signalLine);
  if (sig === null) return { ok: false, why: 'no signal line' };
  const report = blob('report', PATCH_REPORT_MAX_BYTES);
  if (report === undefined) return { ok: false, why: 'no report section' };
  const applyLog = blob('apply_log', PATCH_APPLY_LOG_MAX_BYTES);
  if (applyLog === undefined) return { ok: false, why: 'no apply_log section' };
  const log = blob('log', PATCH_TEST_LOG_MAX_BYTES);
  if (log === undefined) return { ok: false, why: 'no log section' };
  if (line() !== 'end' || at !== buf.length) return { ok: false, why: 'it does not close with end' };
  const exit = code[1] === 'none' ? null : Number(code[1]);
  if (exit !== null && exit > 255) return { ok: false, why: 'an exit code over 255' };
  const signal = sig[1] === 'none' ? null : Number(sig[1]);
  // run.sh reads a code above 128 as 128 + a signal, and only that: any other pairing is no frame of its.
  if (signal !== (exit !== null && exit > 128 ? exit - 128 : null)) return { ok: false, why: 'a signal line its exit line does not imply' };
  // The tests run only on a patch that applied (or none) and an overlay that landed; a report only from a run they ran in.
  if (exit !== null && (apply === 'failed' || apply === 'unsafe' || overlay === 'failed')) return { ok: false, why: 'tests ran where none could' };
  if (exit === null && report !== null) return { ok: false, why: 'a report from a run no test ran in' };
  return { ok: true, frame: { apply, overlay, exit, signal, report, applyLog, log } };
}

/**
 * Run the entry's patch (null: the entry holds no patch.diff, refused `missing`) against the phase's tests (the
 * header): its run log, or why the run failed or timed out.
 */
export async function executePatch(opts: PatchExecutionOptions, patch: Buffer | null, ctx: PatchExecuteContext): Promise<PatchExecution> {
  if (patch === null) return refusedExecution(opts.lists, 'missing', `the entry holds no ${PATCH_DIFF_FILE}`);
  const parsed = parsePatch(patch, { maxBytes: opts.harness.max_patch_bytes, protectedPaths: opts.harness.protected_paths });
  if (!parsed.ok) return refusedExecution(opts.lists, parsed.refused, parsed.detail);
  const issue = baseTreeIssue(parsed.files, opts.base.index);
  if (issue !== null) return refusedExecution(opts.lists, issue.refused, issue.detail);
  const numstat = patchNumstat(patch, { maxBytes: opts.harness.max_patch_bytes, protectedPaths: opts.harness.protected_paths });
  return runPatch(opts, { bytes: patch, numstat }, ctx);
}

/** Run the phase's tests against the base as sealed, no patch (the pack check's base runs): its log applied, never refused. */
export async function executePatchBase(opts: PatchExecutionOptions, ctx: PatchExecuteContext): Promise<PatchExecution> {
  return runPatch(opts, null, ctx);
}

/** An accepted patch as runPatch hands it to run.sh: its bytes, and what git apply --numstat must print of it. */
interface RunnerPatch {
  bytes: Buffer;
  numstat: { forward: Uint8Array; reverse: Uint8Array };
}

async function runPatch(opts: PatchExecutionOptions, patch: RunnerPatch | null, ctx: PatchExecuteContext): Promise<PatchExecution> {
  const h = opts.harness;
  const botDir = join(ctx.workDir, 'patch-runner');
  const inputDir = join(ctx.workDir, 'patch-input');
  const emptyTestsDir = join(ctx.workDir, 'patch-tests');
  try {
    const testsDir = await testsMount(opts.phaseTreeDir, emptyTestsDir);
    // Readable by the sandbox user (docker runs it as nobody); nothing here is the entry's but patch.diff.
    await mkdir(botDir);
    await writeFile(join(botDir, PATCH_RUNNER_SCRIPT), await readFile(join(PATCH_RUNNER_DIR, PATCH_RUNNER_SCRIPT)), { mode: 0o644 });
    await writeFile(join(botDir, PATCH_TEST_SCRIPT), testScript(h.test), { mode: 0o644 });
    await mkdir(inputDir);
    if (patch !== null) {
      await writeFile(join(botDir, PATCH_NUMSTAT_FILE), patch.numstat.forward, { mode: 0o644 });
      await writeFile(join(botDir, PATCH_NUMSTAT_REVERSE_FILE), patch.numstat.reverse, { mode: 0o644 });
      await writeFile(join(inputDir, PATCH_DIFF_FILE), patch.bytes, { mode: 0o644 });
    }
    for (const d of [botDir, inputDir]) await chmod(d, 0o755);
    const spec: SandboxSpec = {
      runtime: ctx.runtime,
      codeDir: botDir,
      script: PATCH_RUNNER_SCRIPT,
      mounts: [
        { host: inputDir, at: '/input', readOnly: true },
        { host: opts.base.dir, at: '/base', readOnly: true },
        { host: testsDir, at: '/tests', readOnly: true },
      ],
      limits: ctx.limits,
      label: ctx.label,
      image: { repository: h.image.repository, digest: h.image.digest, argv: PATCH_RUNNER_ARGV },
      work: { mb: h.work_mb },
    };
    const proc = ctx.sandbox.spawn(spec);
    const sup = new Supervisor(proc, {
      budgetMs: ctx.limits.wall_budget_sec * 1000,
      maxStderrBytes: MAX_STDERR_BYTES,
      stdout: { mode: 'capture', maxBytes: MAX_FRAME_BYTES },
    });
    sup.closeStdin();
    const failed = (error: string): PatchExecution => patchExecution(executionOf<PatchRunLogT>('failed', error, null, sup, []));
    const timedOut = (): PatchExecution => patchExecution(executionOf<PatchRunLogT>('timeout', 'the wall budget ran out', null, sup, []));
    try {
      const exit = await sup.waitExit(Math.max(0, sup.remainingMs()));
      if (exit === 'grace') {
        await sup.kill();
        return timedOut();
      }
      if (ctx.sandbox.isDriverFailure(exit)) throw driverFailure(proc, `the sandbox failed (${describeExit(exit)}): ${stderrTail(sup.stderr())}`);
      if (exit.code === SETUP_FAILED_EXIT) throw new PatchRunnerError(`the house runner's setup failed: ${stderrTail(sup.stderr())}`);
      if (exit.code !== 0) return failed(`the house runner exited with ${describeExit(exit)}`);
      const read = readFrame(sup.stdoutCapture());
      if (!read.ok) return failed(`the house runner's frame does not parse: ${read.why}`);
      const frame = read.frame;
      if ((patch === null) !== (frame.apply === 'none')) {
        throw new PatchRunnerError(patch === null ? 'the house runner applied a patch it was not given' : `the house runner saw no ${PATCH_DIFF_FILE}`);
      }
      if (frame.apply === 'failed') {
        const why = frame.applyLog === null ? '' : frame.applyLog.toString('utf8').trim();
        const log = patchRunLog(opts.lists, { applied: false, refused: 'apply_failed' }, null);
        return patchExecution(executionOf('ok', null, log, sup, []), { refusal_detail: why === '' ? 'git apply refused the patch' : why });
      }
      if (frame.apply === 'unsafe') {
        const log = patchRunLog(opts.lists, { applied: false, refused: 'unsafe_path' }, null);
        return patchExecution(executionOf('ok', null, log, sup, []), {
          refusal_detail: 'git apply reads other paths in the patch than make.fun read in it (git apply --numstat disagrees with its header lines); it was not applied',
        });
      }
      let issue: PatchReportIssue | null = null;
      let report: JunitReport | null = null;
      if (frame.overlay === 'failed') issue = 'overlay_failed';
      else if (frame.report === null) issue = 'missing';
      else {
        const parsed = parseJunit(frame.report);
        if (parsed.ok) report = parsed.report;
        else issue = parsed.refused;
      }
      // The exit as run.sh saw it, held against the whole report: code under test that writes the report must also end the run as it implies.
      const log = patchRunLog(opts.lists, { applied: true, refused: null }, report, patchExitCheck(frame, report));
      return patchExecution(executionOf('ok', null, log, sup, []), {
        report_issue: issue,
        // A copy: the frame's buffer (the report's bytes and all) is not kept with it.
        test_log: opts.keepTestLog && frame.log !== null ? Buffer.from(frame.log) : null,
        test_exit: frame.exit,
      });
    } catch (err) {
      await sup.kill();
      if (!(err instanceof Stopped)) throw err;
      const r = err.reason;
      if (r.kind === 'timeout') return timedOut();
      if (r.kind === 'violation') return failed(`limit: ${r.message}`);
      if (ctx.sandbox.isDriverFailure(r.exit)) throw driverFailure(proc, `the sandbox failed (${describeExit(r.exit)}): ${stderrTail(sup.stderr())}`);
      return failed(describeStop(r));
    }
  } finally {
    await rm(botDir, { recursive: true, force: true });
    await rm(inputDir, { recursive: true, force: true });
    await rm(emptyTestsDir, { recursive: true, force: true });
  }
}
