// The packed-payload unpacker's driver (server/defender/unpack.ts Unpacker): it runs the fold programs, each once
// per audit in its own language's pinned sandbox, and reads their answers (./protocol.ts's wire) as untrusted bytes.
// Python's (./script.ts UNPACK_PY_SOURCE) folds the `.py` candidates in python3.13; node's (./script-node.ts
// UNPACK_NODE_SOURCE, the vendored parser beside it) folds the JavaScript and TypeScript ones in node22
// (server/defender/types.ts unpackRuntimeOf; a path neither claims goes to Python's, as every path did before node22).
// It decodes, decompresses and parses no entry byte itself.
//
// One unpack:
//
//   input caps    checked over the whole candidate list before anything is written: past UNPACK_MAX_FILES files, a
//                 file over UNPACK_MAX_FILE_BYTES, or the file that takes the total past UNPACK_MAX_INPUT_BYTES and
//                 every later one, stays unsent and is listed unresolved `over_cap` (line null)
//   the groups    the sent files split by runtime, in order; each non-empty group is one run, and the two run at once,
//                 each in its own scratch, spawn, Supervisor and deadline
//   the trees     a fold is sound per file, but another file of the same entry can patch a builtin or a decoder the fold
//                 calls before a site in a different file runs. So each program is handed, beside its candidates, every
//                 other text file of its own language the caller marks `checkOnly` (UnpackFile), at /input/t<j>.<kind>
//                 (node: the path's own extension; Python: `py`), and unpacks no file unless every text of its tree
//                 passes its rule. A tree that cannot be handed whole inside the caps (a candidate of its language left
//                 unsent, or its candidates and tree files together past UNPACK_MAX_FILES, UNPACK_MAX_FILE_BYTES or
//                 UNPACK_MAX_INPUT_BYTES) is not run at all: its candidates are `over_cap`
//   the paths     node's loader rule lets a relative specifier load only a file of the entry it was handed, so node's
//                 run is also handed the entry's path manifest (protocol.ts UnpackNodePaths, UNPACK_NODE_PATHS): the
//                 caller's path list (UnpackEntry: every regular file of the snapshot; absent, the paths of the files
//                 handed) cut to the node-language and .json paths, sorted by their UTF-8 bytes, each once, and the entry
//                 path of each candidate and tree file. Paths only, never content. A manifest past
//                 UNPACK_MAX_PATHS_BYTES leaves the node tree unhanded: its candidates are `over_cap`
//   scratch       <workRoot>/defender-unpack/<16 hex> (0700) a run: code/<script> and the program's other code files
//                 (each 0444 in a 0755 directory: node's is unpack.mjs with acorn.mjs beside it) and the inputs (0444
//                 in a 0555 directory): input/<i> for Python, input/<i>.<kind> (UNPACK_NODE_KINDS, the path's own
//                 extension) for node, input/t<j>.<kind> for either one's tree files, and input/paths.json for node's
//                 manifest. On k8s every path a pod is staged from must
//                 lie under the data root (grader/sandbox/k8s.ts checkUnderDataRoot), so workRoot is the pipeline's own. Held
//                 (grade.ts holdScratch) and always removed with removeScratch, whatever happened
//   the spawn     { runtime, codeDir, script, /input read-only, 1 CPU, 256 MiB, 16 pids, label defender-unpack }: no
//                 network, env, secrets, work, image or launcher. The process sandbox isolates nothing, so it runs no
//                 house program (`unavailable`, nothing written); a test's injected program still runs there
//   supervision   a capture Supervisor (budget UNPACK_BUDGET_MS from the program's start, stderr capped at
//                 UNPACK_MAX_STDERR_BYTES, stdout at the head, its newline and the text caps), raced against
//                 UNPACK_DEADLINE_MS from the spawn: the budget starts only at a driver's `started` (k8s waits
//                 for a pod to be Ready first), so the deadline bounds the whole run, killing it on expiry
//   the abort     the caller's signal (UnpackOptions.signal, the audit's: the snapshot job's), raced beside the deadline:
//                 once it aborts no scratch is written and no spawn made, and a run in flight is killed (its scratch
//                 removed as ever) and ends `unavailable` at once, so an unpack never outlives its job's expiry by its
//                 own deadline
//   the answer    Python's read first, then node's, its `n` shifted by Python's layer count. Each split at the first
//                 newline; the head (at most UNPACK_HEAD_MAX_BYTES, ASCII) parsed by its own wire's strict zod schema
//                 (`python` or `node`, UNPACK_VIA or UNPACK_NODE_VIA: a head naming the other wire's decoder is
//                 malformed); then every rule again: one file entry per candidate input in index order, `n` counting
//                 from 1 across the run, a parent always an earlier layer of the same file, depth its parent's plus
//                 one and at most UNPACK_MAX_DEPTH, `via` names each once, the layer, text and failure caps, the
//                 `utf8_len`s adding up to exactly the bytes after the head, and each layer strict UTF-8 (a BOM
//                 kept) without NUL. Each layer's sha256 is computed here. When the two answers together pass
//                 UNPACK_MAX_LAYERS or UNPACK_MAX_TEXT_BYTES, node's layers are all dropped and its files `over_cap`
//
// The outcomes, none thrown (an Unpacker never throws), each run's own: a run past its budget or the deadline, or the
// script's own clock (UNPACK_EXIT_TIMEOUT), `timeout`; a run the caller's signal aborted, `unavailable`; a stdout or
// stderr cap, the script's head cap (UNPACK_EXIT_HEAD_TOO_LARGE) or a tree past the caps, `over_cap`; a driver failure (an exit with `error`,
// isDriverFailure, a pod the node had no room for), a SandboxError or any other throw, and the process sandbox,
// `unavailable`; another non-zero exit or a signal, `failed`; an answer that breaks the wire, `malformed`; at least
// one layer `ok`, else `none`. One run: the result is that run's, with no `runs`. Two: `runs` (Python first), `image`
// null, `ok` when any layer came back, else the first run's status that is not `none`, else `none`. Each non-ok run
// logs one `[defender] unpack` warn line naming its status, its runtime and a fixed reason, never an entry byte.
//
// The data decode (decodeData, server/defender/decode.ts DataDecoder: the security review's): the entry's data files
// (a binary sidecar, a wholly-encoded text) decoded to text as data by ./script-decode.ts DECODE_PY_SOURCE, never run.
//
//   input caps    checked over the handed list before anything is written: past DECODE_MAX_FILES files, a file over
//                 DECODE_MAX_FILE_BYTES, or the file that takes the total past DECODE_MAX_INPUT_BYTES and every later
//                 one, stays unsent and comes back undecoded `over_cap`; with nothing left to send nothing is spawned
//                 (`over_cap`, or `none` for an empty list)
//   the run       one python3.13 run as the fold's: its scratch (input/<i> each), spawn (UNPACK_LIMITS, which hold a
//                 64 MiB lzma dictionary: script-decode.ts's header sizes it), Supervisor, budget, deadline, kill and
//                 exit codes; stdout capped at DECODE_MAX_STDOUT_BYTES. The process sandbox runs no house decoder
//                 (`unavailable`), as it runs no house fold (server/pipeline/index.ts hands it no unpacker at all)
//   the answer    readDecodeAnswer: the head (at most UNPACK_HEAD_MAX_BYTES, ASCII) parsed by its strict zod schema
//                 (DecodeHead: one file entry per input in index order, `via` 1 to DECODE_MAX_DEPTH DECODE_VIA names,
//                 `bytes_in` the input's own size, `why` a DECODE_FAILURES name), each text strict UTF-8 holding no
//                 control character but DECODE_TEXT_CONTROLS, the `utf8_len`s adding up to exactly the bytes after the
//                 head and at most DECODE_MAX_TOTAL_TEXT_BYTES; each text's bytes_out and sha256 computed here from its
//                 bytes, its path the handed file's own. Anything else: the whole result `malformed`
//   the outcome   `ok` when a file decoded, else `none`; a run that never answered keeps the fold's statuses
//                 (timeout, over_cap, failed, unavailable). `decoded` in handed order and empty unless `ok`;
//                 `undecoded` every other handed file in handed order with its DECODE_FAILURES why, or, when the run
//                 gave no answer, the run's status. Never thrown; a non-ok decode logs one `[defender] decode` warn line
//                 naming its status and a fixed reason, never an entry byte.
//
// The run-time capture (captureExec, server/defender/decode.ts ExecCapture: the security review's): the entry's own
// visible code of each candidate (a `.py` file whose exec site the fold left unresolved) run by ./script-capture.ts
// CAPTURE_PY_SOURCE under its audit hook, stopped the moment it hands a source it built at run time to the compiler: the
// source comes back as text, never compiled or run.
//
//   input caps    planCapture, before anything is written: the candidates first (each a handed `.py` file, at most
//                 CAPTURE_MAX_CANDIDATES, in the caller's order), then the caller's other files in its order, each
//                 sent while it keeps to CAPTURE_MAX_FILES, CAPTURE_MAX_FILE_BYTES, CAPTURE_MAX_INPUT_BYTES and the
//                 path rule (script-capture.ts capturePathError); a file that does not is left out (a candidate left
//                 out comes back unresolved `over_cap`, one not handed or no `.py` path `failed`, a name repeated counts
//                 once). Nothing to run spawns nothing (`over_cap` or `failed`, or `none` for no candidate)
//   the run       one python3.13 run as the fold's: its scratch (captureInput: input/<i> each, the manifest
//                 input/capture.json last), spawn (UNPACK_LIMITS), Supervisor (budget CAPTURE_BUDGET_MS, stdout capped at
//                 CAPTURE_MAX_STDOUT_BYTES), deadline, kill and exit codes (CAPTURE_EXIT_TIMEOUT `timeout`,
//                 CAPTURE_EXIT_HEAD_TOO_LARGE `over_cap`, CAPTURE_EXIT_BAD_INPUT and any other `failed`). The process
//                 sandbox isolates nothing, so it runs no house capture (`unavailable`), as it runs no house fold
//   the answer    readCaptureAnswer against the manifest: strictly, every rule of the wire again, each text's bytes_out
//                 and sha256 computed here. Anything else: the whole result `malformed`
//   the outcome   `ok` when a candidate's source came back, else `none`; a run that never answered keeps the fold's
//                 statuses (timeout, over_cap, failed, unavailable). `captured` in candidate order and empty unless
//                 `ok`; `unresolved` every other candidate in the caller's order with its why (a CAPTURE_FAILURES name,
//                 or the run's status when it gave no answer). Never thrown; a non-ok capture logs one
//                 `[defender] capture` warn line naming its status and a fixed reason, never an entry byte.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { CapturedFile, CaptureResult, DataDecoder, DecodedFile, DecodeFile, DecodeResult, ExecCapture } from '../../server/defender/decode.ts';
import type { UnpackEntry, Unpacker, UnpackFile, UnpackLayer, UnpackOptions, UnpackResult } from '../../server/defender/unpack.ts';
import {
  unpackedPath,
  unpackRuntimeOf,
  type DefenderUnpackRun,
  type DefenderUnpackStatus,
  type DefenderUnpackUnresolved,
  type UnpackRuntime,
} from '../../server/defender/types.ts';
import { holdScratch, removeScratch } from '../grade.ts';
import { describeExit, Stopped, Supervisor } from '../sandbox/io.ts';
import { noRoomOf } from '../sandbox/k8s.ts';
import { checkHostPath, scriptOf, type Runtime, type Sandbox, type SandboxExit, type SandboxSpec } from '../sandbox/types.ts';
import {
  DECODE_FAILURES,
  DECODE_MAX_DEPTH,
  DECODE_MAX_FILE_BYTES,
  DECODE_MAX_FILES,
  DECODE_MAX_INPUT_BYTES,
  DECODE_MAX_TEXT_BYTES,
  DECODE_MAX_TOTAL_TEXT_BYTES,
  DECODE_TEXT_CONTROLS,
  DECODE_VIA,
  DECODE_WIRE_VERSION,
  UNPACK_EXIT_HEAD_TOO_LARGE,
  UNPACK_EXIT_TIMEOUT,
  UNPACK_HEAD_MAX_BYTES,
  UNPACK_MAX_DEPTH,
  UNPACK_MAX_FAILED,
  UNPACK_MAX_FILE_BYTES,
  UNPACK_MAX_FILES,
  UNPACK_MAX_INPUT_BYTES,
  UNPACK_MAX_LAYER_BYTES,
  UNPACK_MAX_LAYERS,
  UNPACK_MAX_PATHS_BYTES,
  UNPACK_MAX_TEXT_BYTES,
  UNPACK_NODE_KINDS,
  UNPACK_NODE_PATHS,
  UNPACK_NODE_VIA,
  UNPACK_PY_TREE_KIND,
  UNPACK_SITE_FAILURES,
  UNPACK_TREE_PREFIX,
  UNPACK_VIA,
  UNPACK_WIRE_VERSION,
  type UnpackHeadFailed,
  type UnpackHeadFile,
  type UnpackHeadLayer,
  type UnpackNodeKind,
  type UnpackNodePaths,
} from './protocol.ts';
import { UNPACK_PY_SOURCE, UNPACK_SCRIPT } from './script.ts';
import {
  CAPTURE_BUDGET_MS,
  CAPTURE_MAX_CANDIDATES,
  CAPTURE_MAX_FILE_BYTES,
  CAPTURE_MAX_FILES,
  CAPTURE_MAX_INPUT_BYTES,
  CAPTURE_MAX_STDOUT_BYTES,
  CAPTURE_PY_SOURCE,
  CAPTURE_SCRIPT,
  captureInput,
  capturePathError,
  readCaptureAnswer,
  type CaptureFile,
} from './script-capture.ts';
import { DECODE_PY_SOURCE, DECODE_SCRIPT } from './script-decode.ts';
import { UNPACK_NODE_SCRIPT, UNPACK_NODE_SOURCE, unpackNodeFiles } from './script-node.ts';

/** The directory under workRoot every unpack's scratch sits in. */
export const UNPACK_SCRATCH_DIR = 'defender-unpack';
/** The spawn's label (its container or pod name stem). */
export const UNPACK_LABEL = 'defender-unpack';
/** The spawn's limits. */
export const UNPACK_LIMITS = Object.freeze({ cpus: 1, memory_mb: 256, pids: 16 });
/** The Supervisor's budget, from the program's start: above the script's own clock (UNPACK_SCRIPT_MS). */
export const UNPACK_BUDGET_MS = 10_000;
/**
 * The whole run at most, from the spawn: on k8s a pod's create, scheduling, staging and wait for Ready included, so a pod
 * never Ready ends `timeout` here, never left to the driver's own Ready budget. Counted from the spawn on purpose, never
 * from `started`; the pipeline hands a longer one for that wait (server/pipeline/index.ts DEFENDER_UNPACK_DEADLINE_MS,
 * 120 s; tests/unit/defender-unpack-deadline.test.ts), and the fold itself is bounded from its start by UNPACK_BUDGET_MS.
 */
export const UNPACK_DEADLINE_MS = 30_000;
/** stderr kept at most; past it the run is `over_cap`. */
export const UNPACK_MAX_STDERR_BYTES = 65_536;
/** stdout kept at most: the head, its newline and the layers' text. */
export const UNPACK_MAX_STDOUT_BYTES = UNPACK_HEAD_MAX_BYTES + 1 + UNPACK_MAX_TEXT_BYTES;
/** The decode's stdout kept at most: the head, its newline and the texts. */
export const DECODE_MAX_STDOUT_BYTES = UNPACK_HEAD_MAX_BYTES + 1 + DECODE_MAX_TOTAL_TEXT_BYTES;
/** How long a kill is waited for once the run is over its time: past it the scratch goes all the same. */
export const UNPACK_KILL_WAIT_MS = 10_000;

/** Which wire an answer is read against: its head's interpreter key and the `via` names its layers may hold. */
export type UnpackWire = 'python' | 'node';

/** A code file a program writes beside its script. */
export interface UnpackCodeFile {
  /** Its name under codeDir: one path segment. */
  readonly name: string;
  /** Its text, written as UTF-8. */
  readonly text: string;
}

/** A program the driver runs: one of the two house fold programs, unless a test plays one. */
export interface UnpackProgram {
  runtime: Runtime;
  /** Its file name under codeDir (types.ts scriptOf). */
  script: string;
  /** Its source, written there. */
  source: string;
  /** The other code files written beside it (each 0444): node's vendored parser. Default none. */
  files?: readonly UnpackCodeFile[];
  /** How it names an input under /input: `index` is `<i>` (Python's), `kind` is `<i>.<kind>` (node's). Default `index`. */
  inputs?: 'index' | 'kind';
  /** The head schema and `via` list its answer is read against. Default `python`. */
  wire?: UnpackWire;
  /** A house fold program: the process sandbox, which isolates nothing, never runs one. Default false (a test's stub). */
  house?: boolean;
}

export interface SandboxUnpackerOptions {
  sandbox: Sandbox;
  /** The scratch root (absolute, checkHostPath's characters; on k8s under the data root): the pipeline's work root. */
  workRoot: string;
  /** Tests only: a program playing Python's fold (a node22 stub under the process sandbox). */
  program?: UnpackProgram;
  /** Tests only: a program playing node's fold. */
  nodeProgram?: UnpackProgram;
  /** Tests only: a program playing the data decoder (DECODE_PY_SOURCE). */
  decodeProgram?: UnpackProgram;
  /** Tests only: a program playing the run-time capture (CAPTURE_PY_SOURCE). */
  captureProgram?: UnpackProgram;
  /** Tests only: the Supervisor's budget (UNPACK_BUDGET_MS; the capture's CAPTURE_BUDGET_MS). */
  budgetMs?: number;
  /** The deadline from the spawn (UNPACK_DEADLINE_MS): the pipeline's is DEFENDER_UNPACK_DEADLINE_MS (defenderUnpackerOf). */
  deadlineMs?: number;
  /** Where the warn line of a non-ok run goes (default console.warn). */
  log?: (line: string) => void;
  /** Monotonic clock in ms (default performance.now). */
  now?: () => number;
}

const PYTHON_PROGRAM: UnpackProgram = Object.freeze({
  runtime: 'python3.13',
  script: UNPACK_SCRIPT,
  source: UNPACK_PY_SOURCE,
  files: Object.freeze([]),
  inputs: 'index',
  wire: 'python',
  house: true,
});

/** The data decoder: one python3.13 program, read on the decode wire (readDecodeAnswer) whatever its `wire` says. */
const DECODE_PROGRAM: UnpackProgram = Object.freeze({
  runtime: 'python3.13',
  script: DECODE_SCRIPT,
  source: DECODE_PY_SOURCE,
  files: Object.freeze([]),
  inputs: 'index',
  wire: 'python',
  house: true,
});

/** The run-time capture: one python3.13 program, read on the capture wire (readCaptureAnswer) whatever its `wire` says. */
const CAPTURE_PROGRAM: UnpackProgram = Object.freeze({
  runtime: 'python3.13',
  script: CAPTURE_SCRIPT,
  source: CAPTURE_PY_SOURCE,
  files: Object.freeze([]),
  inputs: 'index',
  wire: 'python',
  house: true,
});

/** Node's fold: the program and its parser (unpackNodeFiles), read when a node group first runs. */
function nodeProgram(): UnpackProgram {
  const files = unpackNodeFiles();
  const script = files.find((f) => f.name === UNPACK_NODE_SCRIPT);
  if (script === undefined || script.text !== UNPACK_NODE_SOURCE) throw new Error('the node fold program is not the one unpackNodeFiles lists');
  return { runtime: 'node22', script: UNPACK_NODE_SCRIPT, source: script.text, files: files.filter((f) => f !== script), inputs: 'kind', wire: 'node', house: true };
}

/** What a run that folded nothing names in its warn line. */
const NONE_REASON: Readonly<Record<UnpackRuntime, string>> = Object.freeze({
  'python3.13': 'no exec or eval site folded to a literal payload',
  node22: 'no eval, Function or vm site folded to a literal payload',
});

/** A run that never produced an answer: its status and the fixed reason the warn line names. */
interface Ended {
  status: Exclude<DefenderUnpackStatus, 'ok' | 'none' | 'path_collision'>;
  reason: string;
  image: string | null;
  /** Sites the run lists besides the plan's unsent files (a tree past the caps: its candidates). */
  unresolved?: Located[];
}

/** A run's stdout, to be read once the runs before it are. */
interface Answered {
  stdout: Buffer;
  image: string | null;
}

/** One runtime's share of the sent files. */
interface Group {
  runtime: UnpackRuntime;
  /** Its program; null when it could not be read (`broken` says why). */
  program: UnpackProgram | null;
  broken: string | null;
  /** Its candidates, in the plan's order: /input/<k> (or <k>.<kind>) is `sent[k]`. */
  sent: Sent[];
  /** Its tree files, in the caller's order: /input/t<j>.<kind>. */
  tree: { bytes: Buffer; kind: string; path: string }[];
  /** Node's path manifest (the header's paths), written as /input/UNPACK_NODE_PATHS; null for Python's, and for a node group capped by it. */
  paths: Buffer | null;
  /** Why the tree cannot be handed whole (the header's trees), or null. */
  capped: string | null;
  /** The candidates of this runtime the caller handed, sent or not. */
  handed: number;
}

/** A run, read: what the result and its record take from it. */
interface Done {
  group: Group;
  status: Exclude<DefenderUnpackStatus, 'path_collision'>;
  reason: string | null;
  ms: number;
  image: string | null;
  layers: UnpackLayer[];
  unresolved: Located[];
}

/**
 * The sandboxed Unpacker: it reads the entry's path list (UnpackEntry) when the caller hands one (the header's paths);
 * the sandboxed DataDecoder (the header's data decode) and ExecCapture (the header's run-time capture), in the same
 * sandbox.
 */
export function createSandboxUnpacker(opts: SandboxUnpackerOptions): Unpacker & DataDecoder & ExecCapture {
  return new SandboxUnpacker(opts);
}

/** A file written to a run's input directory: its name there (one path segment) and its bytes. */
interface InputFile {
  name: string;
  bytes: Buffer;
}

class SandboxUnpacker implements Unpacker, DataDecoder, ExecCapture {
  readonly #sandbox: Sandbox;
  readonly #workRoot: string;
  readonly #program: UnpackProgram;
  readonly #nodeProgram: UnpackProgram | null;
  readonly #decodeProgram: UnpackProgram;
  readonly #captureProgram: UnpackProgram;
  readonly #budgetMs: number;
  readonly #captureBudgetMs: number;
  readonly #deadlineMs: number;
  readonly #log: (line: string) => void;
  readonly #now: () => number;

  constructor(opts: SandboxUnpackerOptions) {
    this.#sandbox = opts.sandbox;
    this.#workRoot = opts.workRoot;
    this.#program = opts.program ?? PYTHON_PROGRAM;
    this.#nodeProgram = opts.nodeProgram ?? null;
    this.#decodeProgram = opts.decodeProgram ?? DECODE_PROGRAM;
    this.#captureProgram = opts.captureProgram ?? CAPTURE_PROGRAM;
    this.#budgetMs = opts.budgetMs ?? UNPACK_BUDGET_MS;
    this.#captureBudgetMs = opts.budgetMs ?? CAPTURE_BUDGET_MS;
    this.#deadlineMs = opts.deadlineMs ?? UNPACK_DEADLINE_MS;
    this.#log = opts.log ?? ((line) => console.warn(line));
    this.#now = opts.now ?? (() => performance.now());
  }

  #warn(line: string): void {
    try {
      this.#log(line);
    } catch {
      // A logger that throws changes nothing about the result.
    }
  }

  async unpack(files: readonly UnpackFile[], entry?: UnpackEntry, opts?: UnpackOptions): Promise<UnpackResult> {
    const t0 = this.#now();
    const signal = opts?.signal;
    let out: Omit<UnpackResult, 'ms'>;
    let reason: string | null = null;
    let plan: InputPlan | null = null;
    let done: Done[] = [];
    try {
      const candidates = files.filter((f) => f.checkOnly !== true);
      plan = planInput(candidates);
      const groups = this.#groupsOf(plan, candidates, files, entry?.paths ?? files.map((f) => f.path));
      done = await this.#runAll(groups, signal);
      out = resultOf(plan, done);
      if (done.length === 0 && plan.unsent.length > 0) {
        out.status = 'over_cap';
        reason = 'every file passed an input cap';
      }
    } catch (err) {
      reason = `the unpack threw: ${messageOf(err)}`;
      done = [];
      out = { status: 'unavailable', image: null, layers: [], unresolved: plan === null ? [] : unresolvedOf(plan, []) };
    }
    const ms = Math.max(0, Math.round(this.#now() - t0));
    if (done.length === 0) {
      if (out.status !== 'ok') this.#warn(`[defender] unpack ${out.status}: ${reason ?? 'no file was handed'} (${files.length} file(s), ${ms} ms)`);
    } else {
      for (const d of done) {
        if (d.status === 'ok') continue;
        this.#warn(`[defender] unpack ${d.status}: ${d.reason ?? NONE_REASON[d.group.runtime]} (${d.group.runtime}, ${d.group.handed} file(s), ${d.ms} ms)`);
      }
    }
    return { ...out, ms };
  }

  async decodeData(handed: readonly DecodeFile[]): Promise<DecodeResult> {
    const t0 = this.#now();
    const files: readonly DecodeFile[] = Array.isArray(handed) ? handed : [];
    let status: DecodeResult['status'];
    let reason: string | null = null;
    let image: string | null = null;
    let decoded: DecodedFile[] = [];
    let undecoded: DecodeResult['undecoded'] = [];
    try {
      const plan = planDecode(files);
      const unsent = plan.unsent.map((u) => ({ at: u.at, path: u.path, why: 'over_cap' }));
      if (plan.sent.length === 0) {
        status = unsent.length > 0 ? 'over_cap' : 'none';
        reason = unsent.length > 0 ? 'every file passed an input cap' : 'no file was handed';
        undecoded = unsent.map(({ path, why }) => ({ path, why }));
      } else {
        const r = await this.#decodeRun(plan.sent);
        image = r.image;
        let answered: { at: number; path: string; why: string }[];
        if ('reason' in r) {
          status = r.status;
          reason = r.reason;
          answered = plan.sent.map((f) => ({ at: f.at, path: f.path, why: r.status }));
        } else {
          const read = readDecodeAnswer(r.stdout, plan.sent);
          if (!read.ok) {
            status = 'malformed';
            reason = read.why;
            answered = plan.sent.map((f) => ({ at: f.at, path: f.path, why: 'malformed' }));
          } else {
            decoded = read.decoded.map((d) => d.file);
            answered = read.undecoded.map((u) => ({ at: plan.sent[u.i]!.at, path: u.path, why: u.why }));
            status = decoded.length > 0 ? 'ok' : 'none';
            if (status === 'none') reason = 'no file decoded to text';
          }
        }
        undecoded = [...unsent, ...answered].sort((a, b) => a.at - b.at).map(({ path, why }) => ({ path, why }));
      }
    } catch (err) {
      status = 'unavailable';
      reason = `the decode threw: ${messageOf(err)}`;
      image = null;
      decoded = [];
      undecoded = files.map((f) => ({ path: String((f as Partial<DecodeFile> | null)?.path), why: 'unavailable' }));
    }
    const ms = Math.max(0, Math.round(this.#now() - t0));
    if (status !== 'ok') this.#warn(`[defender] decode ${status}: ${reason ?? 'no file decoded to text'} (${files.length} file(s), ${ms} ms)`);
    return { status, ms, image, decoded: status === 'ok' ? decoded : [], undecoded };
  }

  async captureExec(handed: readonly DecodeFile[], named: readonly string[]): Promise<CaptureResult> {
    const t0 = this.#now();
    const files: readonly DecodeFile[] = Array.isArray(handed) ? handed : [];
    const candidates: readonly string[] = Array.isArray(named) ? named : [];
    let status: CaptureResult['status'];
    let reason: string | null = null;
    let image: string | null = null;
    let captured: CapturedFile[] = [];
    let unresolved: CaptureResult['unresolved'] = [];
    try {
      const plan = planCapture(files, candidates);
      const answered = new Map<string, { why: string } | CapturedFile>();
      if (plan.run.length === 0) {
        status = plan.left.length > 0 ? (plan.left.some((l) => l.why === 'over_cap') ? 'over_cap' : 'failed') : 'none';
        reason = plan.left.length > 0 ? 'no candidate could be handed to the run' : 'no candidate was named';
      } else {
        const input = captureInput(plan.sent, plan.run);
        if (!input.ok) throw new Error(`the capture's input does not fit its wire: ${input.why}`);
        const r = await this.#captureRun(input.inputs);
        image = r.image;
        if ('reason' in r) {
          status = r.status;
          reason = r.reason;
          for (const c of plan.run) answered.set(c, { why: r.status });
        } else {
          const read = readCaptureAnswer(r.stdout, input.manifest);
          if (!read.ok) {
            status = 'malformed';
            reason = read.why;
            for (const c of plan.run) answered.set(c, { why: 'malformed' });
          } else {
            for (const c of read.captured) answered.set(c.path, { path: c.path, from: c.from, line: c.line, bytes_out: c.bytes_out, sha256: c.sha256, text: c.text });
            for (const u of read.unresolved) answered.set(u.path, { why: u.why });
            status = read.captured.length > 0 ? 'ok' : 'none';
            if (status === 'none') reason = 'no candidate built a source at run time';
          }
        }
      }
      // Every named candidate once, in the caller's order: what its run answered, or why it was not run.
      const left = new Map(plan.left.map((l) => [l.path, l.why]));
      const seen = new Set<string>();
      for (const c of candidates) {
        const key = typeof c === 'string' ? c : String(c);
        if (seen.has(key)) continue;
        seen.add(key);
        const a = answered.get(key);
        if (a !== undefined && 'text' in a) captured.push(a);
        else unresolved.push({ path: key, why: a?.why ?? left.get(key) ?? 'failed' });
      }
    } catch (err) {
      status = 'unavailable';
      reason = `the capture threw: ${messageOf(err)}`;
      image = null;
      captured = [];
      unresolved = [...new Set(candidates.map((c) => String(c)))].map((path) => ({ path, why: 'unavailable' }));
    }
    const ms = Math.max(0, Math.round(this.#now() - t0));
    if (status !== 'ok') this.#warn(`[defender] capture ${status}: ${reason ?? 'no candidate built a source at run time'} (${files.length} file(s), ${candidates.length} candidate(s), ${ms} ms)`);
    return { status, ms, image, captured: status === 'ok' ? captured : [], unresolved };
  }

  /** The capture's one run (the header's run-time capture): a fixed ending, or its stdout to read. */
  async #captureRun(inputs: readonly InputFile[]): Promise<Ended | Answered> {
    const program = this.#captureProgram;
    if (this.#sandbox.kind === 'process' && program.house === true) {
      return { status: 'unavailable', reason: 'the process sandbox isolates nothing, so it runs no house capture program', image: null };
    }
    try {
      return await this.#runIn(program, inputs, CAPTURE_MAX_STDOUT_BYTES, this.#captureBudgetMs);
    } catch (err) {
      return { status: 'unavailable', reason: `the capture run threw: ${messageOf(err)}`, image: null };
    }
  }

  /** The decode's one run (the header's data decode): a fixed ending, or its stdout to read. */
  async #decodeRun(sent: readonly DecodeSent[]): Promise<Ended | Answered> {
    const program = this.#decodeProgram;
    if (this.#sandbox.kind === 'process' && program.house === true) {
      return { status: 'unavailable', reason: 'the process sandbox isolates nothing, so it runs no house decode program', image: null };
    }
    const inputs: InputFile[] = sent.map((f, i) => ({ name: String(i), bytes: f.bytes }));
    try {
      return await this.#runIn(program, inputs, DECODE_MAX_STDOUT_BYTES);
    } catch (err) {
      return { status: 'unavailable', reason: `the decode run threw: ${messageOf(err)}`, image: null };
    }
  }

  /** The sent files by runtime (Python's group first), each with its tree files (node's with its manifest) and whether they fit. */
  #groupsOf(plan: InputPlan, candidates: readonly UnpackFile[], files: readonly UnpackFile[], entryPaths: readonly string[]): Group[] {
    const runtimeOf = (path: string): UnpackRuntime => unpackRuntimeOf(path) ?? 'python3.13';
    const handed = (runtime: UnpackRuntime) => candidates.filter((f) => runtimeOf(f.path) === runtime).length;
    const groups: Group[] = [];
    const own = new Set(candidates.map((f) => f.path));
    const treeOf = (runtime: UnpackRuntime, kindOf: (path: string) => string) =>
      files.filter((f) => f.checkOnly === true && unpackRuntimeOf(f.path) === runtime && !own.has(f.path)).map((f) => ({ bytes: f.bytes, kind: kindOf(f.path), path: f.path }));
    const py = plan.sent.filter((s) => runtimeOf(s.path) === 'python3.13');
    if (py.length > 0) {
      const tree = treeOf('python3.13', () => UNPACK_PY_TREE_KIND);
      groups.push({ runtime: 'python3.13', program: this.#program, broken: null, sent: py, tree, paths: null, capped: treeCap(plan, 'python3.13', py, tree), handed: handed('python3.13') });
    }
    const node = plan.sent.filter((s) => runtimeOf(s.path) === 'node22');
    if (node.length > 0) {
      const tree = treeOf('node22', nodeKindOf);
      const paths = nodePathsOf(entryPaths, node, tree);
      let program = this.#nodeProgram;
      let broken: string | null = null;
      if (program === null) {
        try {
          program = nodeProgram();
        } catch (err) {
          broken = `the node fold program could not be read: ${messageOf(err)}`;
        }
      }
      const capped = treeCap(plan, 'node22', node, tree) ?? (paths === null ? `the node entry's path list passed ${UNPACK_MAX_PATHS_BYTES} bytes` : null);
      groups.push({ runtime: 'node22', program, broken, sent: node, tree, paths, capped, handed: handed('node22') });
    }
    return groups;
  }

  /** Every group run at once, then the answers read in order (each later one's `n` after the earlier ones' layers). */
  async #runAll(groups: readonly Group[], signal?: AbortSignal): Promise<Done[]> {
    const ran = await Promise.all(
      groups.map(async (group) => {
        const t0 = this.#now();
        let r: Ended | Answered;
        try {
          r = await this.#run(group, signal);
        } catch (err) {
          r = { status: 'unavailable', reason: `the unpack threw: ${messageOf(err)}`, image: null };
        }
        return { group, r, ms: Math.max(0, Math.round(this.#now() - t0)) };
      }),
    );
    const done: Done[] = [];
    let base = 0;
    let textBytes = 0;
    for (const { group, r, ms } of ran) {
      if ('reason' in r) {
        done.push({ group, status: r.status, reason: r.reason, ms, image: r.image, layers: [], unresolved: r.unresolved ?? [] });
        continue;
      }
      const read = readUnpackAnswer(
        r.stdout,
        group.sent.map((s) => s.path),
        { wire: group.program?.wire ?? 'python', base },
      );
      if (!read.ok) {
        done.push({ group, status: 'malformed', reason: read.why, ms, image: r.image, layers: [], unresolved: [] });
        continue;
      }
      const unresolved = read.unresolved.map((u) => ({ ...u, at: group.sent[u.i]!.at }));
      const bytes = read.layers.reduce((n, l) => n + l.bytes_out, 0);
      if (base + read.layers.length > UNPACK_MAX_LAYERS || textBytes + bytes > UNPACK_MAX_TEXT_BYTES) {
        const reason = `the runs' layers together passed ${UNPACK_MAX_LAYERS} layers or ${UNPACK_MAX_TEXT_BYTES} bytes`;
        done.push({ group, status: 'over_cap', reason, ms, image: r.image, layers: [], unresolved: group.sent.map((s, i) => ({ i, at: s.at, path: s.path, line: null, why: 'over_cap' })) });
        continue;
      }
      base += read.layers.length;
      textBytes += bytes;
      done.push({ group, status: read.layers.length > 0 ? 'ok' : 'none', reason: null, ms, image: r.image, layers: read.layers, unresolved });
    }
    return done;
  }

  /** One group's run: a fixed ending (status and reason), or its stdout to read. */
  async #run(group: Group, signal?: AbortSignal): Promise<Ended | Answered> {
    const program = group.program;
    if (program === null) return { status: 'unavailable', reason: group.broken ?? 'the fold program could not be read', image: null };
    if (this.#sandbox.kind === 'process' && program.house === true) {
      return { status: 'unavailable', reason: 'the process sandbox isolates nothing, so it runs no house fold program', image: null };
    }
    if (group.capped !== null) {
      return { status: 'over_cap', reason: group.capped, image: null, unresolved: group.sent.map((s, i) => ({ i, at: s.at, path: s.path, line: null, why: 'over_cap' })) };
    }
    const byKind = program.inputs === 'kind';
    const inputs: InputFile[] = group.sent.map((f, i) => ({ name: byKind ? `${i}.${nodeKindOf(f.path)}` : String(i), bytes: f.bytes }));
    for (const [j, f] of group.tree.entries()) inputs.push({ name: `${UNPACK_TREE_PREFIX}${j}.${f.kind}`, bytes: f.bytes });
    if (group.paths !== null) inputs.push({ name: UNPACK_NODE_PATHS, bytes: group.paths });
    return await this.#runIn(program, inputs, UNPACK_MAX_STDOUT_BYTES, this.#budgetMs, signal);
  }

  /**
   * One program run in its own scratch (the header's scratch): its code files, then `inputs` in order under input/ (each
   * 0444, the directory 0555), the spawn, and the scratch removed whatever happened. Nothing is written once `signal`
   * (the header's abort) has aborted.
   */
  async #runIn(program: UnpackProgram, inputs: readonly InputFile[], maxStdoutBytes: number, budgetMs: number = this.#budgetMs, signal?: AbortSignal): Promise<Ended | Answered> {
    const script = scriptOf(program);
    const extra = program.files ?? [];
    for (const f of extra) {
      if (!CODE_NAME_RE.test(f.name) || f.name === script) throw new Error(`a program's code file is named ${JSON.stringify(f.name)}`);
    }
    for (const f of inputs) {
      if (!CODE_NAME_RE.test(f.name)) throw new Error(`an input is named ${JSON.stringify(f.name)}`);
    }
    if (signal?.aborted === true) return { status: 'unavailable', reason: ABORTED_REASON, image: null };
    const parent = join(this.#workRoot, UNPACK_SCRATCH_DIR);
    const dir = checkHostPath(join(parent, randomBytes(8).toString('hex')));
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    holdScratch(dir);
    try {
      const codeDir = join(dir, 'code');
      const inputDir = join(dir, 'input');
      await mkdir(dirname(join(codeDir, script)), { recursive: true, mode: 0o755 });
      await writeFile(join(codeDir, script), program.source, { flag: 'wx', mode: 0o444 });
      await chmod(join(codeDir, script), 0o444);
      for (const f of extra) {
        await writeFile(join(codeDir, f.name), f.text, { flag: 'wx', mode: 0o444, encoding: 'utf8' });
        await chmod(join(codeDir, f.name), 0o444);
      }
      await chmod(codeDir, 0o755);
      await mkdir(inputDir, { mode: 0o700 });
      for (const f of inputs) await writeFile(join(inputDir, f.name), f.bytes, { flag: 'wx', mode: 0o444 });
      await chmod(inputDir, 0o555);
      return await this.#spawn(program, codeDir, inputDir, script, maxStdoutBytes, budgetMs, signal);
    } finally {
      try {
        await removeScratch(this.#sandbox, dir);
      } catch (err) {
        this.#warn(`[defender] unpack scratch ${dir} could not be removed: ${messageOf(err)}`);
      }
    }
  }

  async #spawn(program: UnpackProgram, codeDir: string, inputDir: string, script: string, maxStdoutBytes: number, budgetMs: number, signal?: AbortSignal): Promise<Ended | Answered> {
    // The scratch writes took turns of the event loop: an abort that landed meanwhile spawns nothing.
    if (signal?.aborted === true) return { status: 'unavailable', reason: ABORTED_REASON, image: null };
    const spec: SandboxSpec = {
      runtime: program.runtime,
      codeDir,
      script,
      mounts: [{ host: inputDir, at: '/input', readOnly: true }],
      limits: { ...UNPACK_LIMITS },
      label: UNPACK_LABEL,
    };
    let proc;
    try {
      proc = this.#sandbox.spawn(spec);
    } catch (err) {
      return { status: 'unavailable', reason: `the sandbox refused the spawn: ${messageOf(err)}`, image: null };
    }
    const image = imageOf(this.#sandbox, program.runtime);
    const ended = (status: Ended['status'], reason: string): Ended => ({ status, reason, image });
    const sup = new Supervisor(proc, { budgetMs, maxStderrBytes: UNPACK_MAX_STDERR_BYTES, stdout: { mode: 'capture', maxBytes: maxStdoutBytes } });
    sup.closeStdin();
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<{ kind: 'deadline' }>((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ kind: 'deadline' }), Math.max(0, this.#deadlineMs));
    });
    // The caller's signal (the header's abort), raced beside the deadline; with none this never settles.
    let resolveAborted: (v: { kind: 'aborted' }) => void = () => undefined;
    const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
      resolveAborted = resolve;
    });
    const onAbort = () => resolveAborted({ kind: 'aborted' });
    // Asked again, not narrowed from the check above: the sandbox's spawn ran code between the two, and a signal that
    // aborted meanwhile fires no listener added now.
    const abortedNow = (s: AbortSignal | undefined): boolean => s?.aborted === true;
    if (abortedNow(signal)) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const waited = sup.waitExit(Math.max(0, sup.remainingMs())).then(
      (exit) => ({ kind: 'exit' as const, exit }),
      (err: unknown) => ({ kind: 'error' as const, err }),
    );
    const first = await Promise.race([waited, deadline, aborted]);
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', onAbort);
    if (first.kind === 'aborted') {
      await killWithin(sup);
      return ended('unavailable', ABORTED_REASON);
    }
    if (first.kind === 'deadline') {
      await killWithin(sup);
      return ended('timeout', `the run passed its ${this.#deadlineMs} ms deadline`);
    }
    if (first.kind === 'error') {
      await killWithin(sup);
      const err = first.err;
      if (err instanceof Stopped && err.reason.kind === 'timeout') return ended('timeout', `the run passed its ${budgetMs} ms budget`);
      if (err instanceof Stopped && err.reason.kind === 'violation') return ended('over_cap', err.reason.message);
      return ended('unavailable', `the supervision failed: ${messageOf(err)}`);
    }
    const exit: SandboxExit | 'grace' = first.exit;
    if (exit === 'grace') {
      await killWithin(sup);
      return ended('timeout', `the run passed its ${budgetMs} ms budget`);
    }
    const noRoom = noRoomOf(proc);
    if (noRoom !== null) return ended('unavailable', 'the node had no room for the sandbox');
    if (exit.error !== undefined || this.#sandbox.isDriverFailure(exit)) return ended('unavailable', `the sandbox failed (${describeExit(exit)})`);
    if (exit.code === UNPACK_EXIT_TIMEOUT && exit.signal === null) return ended('timeout', "the script's own clock ran out");
    if (exit.code === UNPACK_EXIT_HEAD_TOO_LARGE && exit.signal === null) return ended('over_cap', "the script's head passed its cap");
    if (exit.code !== 0 || exit.signal !== null) return ended('failed', `the script exited with ${describeExit(exit)}`);
    return { stdout: sup.stdoutCapture(), image };
  }
}

/** The fixed reason a run the caller's signal aborted ends with (the header's abort). */
const ABORTED_REASON = "the caller's signal aborted the run";

/** A program's other code file: one plain path segment. */
const CODE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const NODE_KINDS = new Set<string>(UNPACK_NODE_KINDS);

/** A node-language path's input suffix: its own extension (unpackRuntimeOf matched it exactly). */
function nodeKindOf(path: string): UnpackNodeKind {
  const kind = path.slice(path.lastIndexOf('.') + 1);
  if (!NODE_KINDS.has(kind)) throw new Error('a node input has no node extension');
  return kind as UnpackNodeKind;
}

/** Whether a path is one node's loader may load: a node-language or `.json` path (protocol.ts UnpackNodePaths). */
function nodeLoadable(path: string): boolean {
  return path.endsWith('.json') || (NODE_KINDS.has(path.slice(path.lastIndexOf('.') + 1)) && path.lastIndexOf('.') > path.lastIndexOf('/'));
}

/**
 * Node's path manifest (the header's paths) as written: the entry's node-language and `.json` paths, sorted by their
 * UTF-8 bytes, each once, and the entry path of each candidate and tree file, in input order; null when it would pass
 * UNPACK_MAX_PATHS_BYTES.
 */
function nodePathsOf(entryPaths: readonly string[], sent: readonly Sent[], tree: readonly { path: string }[]): Buffer | null {
  const listed = [...new Set(entryPaths.filter((p) => typeof p === 'string' && nodeLoadable(p)))];
  // Each path costs its bytes and two quotes at least: a list that cannot fit is cut before it is sorted or written out.
  if (listed.reduce((n, p) => n + Buffer.byteLength(p, 'utf8') + 2, 0) > UNPACK_MAX_PATHS_BYTES) return null;
  const paths = listed.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const manifest: UnpackNodePaths = { paths, files: sent.map((s) => s.path), tree: tree.map((f) => f.path) };
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  return bytes.length > UNPACK_MAX_PATHS_BYTES ? null : bytes;
}

/** Why a runtime's candidates and tree cannot be handed whole inside the caps (the header's trees), or null. */
function treeCap(plan: InputPlan, runtime: UnpackRuntime, sent: readonly Sent[], tree: readonly { bytes: Buffer }[]): string | null {
  const name = runtime === 'node22' ? 'node' : 'Python';
  if (plan.unsent.some((u) => (unpackRuntimeOf(u.path) ?? 'python3.13') === runtime)) return `a ${name} file of the tree passed an input cap`;
  if (sent.length + tree.length > UNPACK_MAX_FILES) return `the ${name} tree holds more than ${UNPACK_MAX_FILES} files`;
  if (tree.some((f) => f.bytes.length > UNPACK_MAX_FILE_BYTES)) return `a ${name} file of the tree passed ${UNPACK_MAX_FILE_BYTES} bytes`;
  const total = [...sent, ...tree].reduce((n, f) => n + f.bytes.length, 0);
  if (total > UNPACK_MAX_INPUT_BYTES) return `the ${name} tree passed ${UNPACK_MAX_INPUT_BYTES} bytes`;
  return null;
}

/** The result from the runs (the header's outcomes): one run's own, or both with `runs`. */
function resultOf(plan: InputPlan, done: readonly Done[]): Omit<UnpackResult, 'ms'> {
  const layers = done.flatMap((d) => d.layers);
  const unresolved = unresolvedOf(plan, done.flatMap((d) => d.unresolved));
  if (done.length === 0) return { status: 'none', image: null, layers: [], unresolved };
  if (done.length === 1) {
    const d = done[0]!;
    return { status: d.status, image: d.image, layers, unresolved };
  }
  const status = layers.length > 0 ? 'ok' : (done.find((d) => d.status !== 'none')?.status ?? 'none');
  const runs: DefenderUnpackRun[] = done.map((d) => ({ runtime: d.group.runtime, status: d.status, ms: d.ms, image: d.image, candidates: d.group.sent.length, layers: d.layers.length }));
  return { status, image: null, layers, unresolved, runs };
}

/** Kill the run, waiting at most UNPACK_KILL_WAIT_MS for it to be gone. */
async function killWithin(sup: Supervisor): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    sup.kill().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, UNPACK_KILL_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
}

function imageOf(sandbox: Sandbox, runtime: Runtime): string | null {
  try {
    return sandbox.imageDigest(runtime);
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- the input caps

/** A sent file: its path, bytes and index in the caller's candidate list. */
interface Sent {
  path: string;
  bytes: Buffer;
  at: number;
}

/** What goes to the sandboxes and what stays: each with its index in the caller's candidate list. */
interface InputPlan {
  sent: Sent[];
  unsent: { path: string; at: number }[];
}

/** The files the caps let through, in order (the header's input caps). */
function planInput(files: readonly UnpackFile[]): InputPlan {
  const plan: InputPlan = { sent: [], unsent: [] };
  let total = 0;
  let overTotal = false;
  for (const [at, f] of files.entries()) {
    const size = f.bytes.length;
    if (!overTotal && total + size > UNPACK_MAX_INPUT_BYTES && size <= UNPACK_MAX_FILE_BYTES) overTotal = true;
    if (overTotal || size > UNPACK_MAX_FILE_BYTES || plan.sent.length >= UNPACK_MAX_FILES) {
      plan.unsent.push({ path: f.path, at });
      continue;
    }
    total += size;
    plan.sent.push({ path: f.path, bytes: f.bytes, at });
  }
  return plan;
}

/** A site of an answer, by the input it is under. */
interface Located extends DefenderUnpackUnresolved {
  /** The input's index in its run (/input/<i>). */
  i: number;
  /** The driver's: the file's index in the caller's candidate list. */
  at?: number;
}

/** Every unresolved site in the caller's file order: the answers', and an `over_cap` per unsent file. */
function unresolvedOf(plan: InputPlan, answered: readonly Located[]): DefenderUnpackUnresolved[] {
  const byFile = new Map<number, DefenderUnpackUnresolved[]>();
  const add = (at: number, u: DefenderUnpackUnresolved) => {
    const list = byFile.get(at);
    if (list === undefined) byFile.set(at, [u]);
    else list.push(u);
  };
  for (const u of plan.unsent) add(u.at, { path: u.path, line: null, why: 'over_cap' });
  for (const u of answered) add(u.at ?? plan.sent[u.i]!.at, { path: u.path, line: u.line, why: u.why });
  return [...byFile.entries()].sort(([a], [b]) => a - b).flatMap(([, list]) => list);
}

// ---------------------------------------------------------------- the answer

/** A line number an answer may name: no text under the caps holds more lines than bytes. */
const MAX_LINE = Math.max(UNPACK_MAX_FILE_BYTES, UNPACK_MAX_LAYER_BYTES) + 1;
/** A layer's payload literals at most: they sit in a file or a layer. */
const MAX_BYTES_IN = Math.max(UNPACK_MAX_FILE_BYTES, UNPACK_MAX_LAYER_BYTES);
/** An interpreter version a head may name (`platform.python_version()`, `process.versions.node`). */
const VERSION_RE = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}[a-z0-9]{0,8}$/;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** One wire's head schema, its layers' `via` from `via` alone. */
function headSchema(wire: UnpackWire, via: ReadonlySet<string>) {
  const HeadLayer: z.ZodType<UnpackHeadLayer> = z.strictObject({
    n: int(1, UNPACK_MAX_LAYERS),
    parent: int(0, UNPACK_MAX_LAYERS),
    line: int(1, MAX_LINE),
    depth: int(1, UNPACK_MAX_DEPTH),
    via: z.array(z.string().refine((v) => via.has(v))).max(via.size),
    bytes_in: int(0, MAX_BYTES_IN),
    utf8_len: int(0, UNPACK_MAX_LAYER_BYTES),
  });
  const HeadFailed: z.ZodType<UnpackHeadFailed> = z.strictObject({
    parent: int(0, UNPACK_MAX_LAYERS),
    line: int(0, MAX_LINE),
    why: z.enum(UNPACK_SITE_FAILURES),
  });
  const HeadFile: z.ZodType<UnpackHeadFile> = z.strictObject({
    i: int(0, UNPACK_MAX_FILES - 1),
    layers: z.array(HeadLayer).max(UNPACK_MAX_LAYERS),
    failed: z.array(HeadFailed).max(UNPACK_MAX_FAILED),
    failed_more: int(1, Number.MAX_SAFE_INTEGER).optional(),
  });
  const files = z.array(HeadFile).max(UNPACK_MAX_FILES);
  const version = z.string().regex(VERSION_RE);
  return wire === 'python'
    ? z.strictObject({ v: z.literal(UNPACK_WIRE_VERSION), python: version, files })
    : z.strictObject({ v: z.literal(UNPACK_WIRE_VERSION), node: version, files });
}

const HEADS: Readonly<Record<UnpackWire, ReturnType<typeof headSchema>>> = Object.freeze({
  python: headSchema('python', new Set<string>(UNPACK_VIA)),
  node: headSchema('node', new Set<string>(UNPACK_NODE_VIA)),
});

/** The answer read: its layers and its unresolved sites, or why it does not read (a fixed sentence, never its bytes). */
export type UnpackAnswer = { ok: true; layers: UnpackLayer[]; unresolved: Located[] } | { ok: false; why: string };

/** How an answer is read: its wire (default `python`) and the layers already numbered before it (default 0). */
export interface UnpackAnswerOptions {
  wire?: UnpackWire;
  base?: number;
}

/**
 * Read a script's stdout (the header's answer) for the candidates sent as /input/<i>, `paths[i]` each: strictly,
 * every rule of the wire checked again, since a compromised sandbox writes anything. Layer `n` of the answer is the
 * result's `base + n`.
 */
export function readUnpackAnswer(stdout: Buffer, paths: readonly string[], opts: UnpackAnswerOptions = {}): UnpackAnswer {
  const base = opts.base ?? 0;
  const bad = (why: string): UnpackAnswer => ({ ok: false, why });
  const nl = stdout.indexOf(0x0a);
  if (nl === -1) return bad('the answer holds no head line');
  if (nl > UNPACK_HEAD_MAX_BYTES) return bad(`the head passed ${UNPACK_HEAD_MAX_BYTES} bytes`);
  const headBytes = stdout.subarray(0, nl);
  for (const b of headBytes) if (b >= 0x80) return bad('the head is not ASCII');
  let json: unknown;
  try {
    json = JSON.parse(headBytes.toString('latin1'));
  } catch {
    return bad('the head is not JSON');
  }
  const parsed = HEADS[opts.wire ?? 'python'].safeParse(json);
  if (!parsed.success) return bad('the head does not match the wire schema');
  const head = parsed.data;
  if (head.files.length !== paths.length) return bad(`the head lists ${head.files.length} files for ${paths.length} sent`);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const layers: UnpackLayer[] = [];
  const unresolved: Located[] = [];
  let off = nl + 1;
  let n = 0;
  let failed = 0;
  for (const [k, f] of head.files.entries()) {
    if (f.i !== k) return bad(`file entry ${k} names input ${f.i}`);
    const path = paths[k]!;
    // This file's layers so far: n to its virtual path and depth.
    const own = new Map<number, { path: string; depth: number }>();
    for (const l of f.layers) {
      n += 1;
      if (l.n !== n) return bad(`layer ${n} is numbered ${l.n}`);
      const parent = l.parent === 0 ? null : own.get(l.parent);
      if (parent === undefined) return bad(`layer ${n}'s parent ${l.parent} is no earlier layer of its file`);
      if (l.depth !== (parent === null ? 1 : parent.depth + 1)) return bad(`layer ${n}'s depth ${l.depth} does not follow its parent's`);
      if (new Set(l.via).size !== l.via.length) return bad(`layer ${n} names a decoder twice`);
      const end = off + l.utf8_len;
      if (end > stdout.length) return bad(`layer ${n}'s text runs past the answer`);
      if (end - (nl + 1) > UNPACK_MAX_TEXT_BYTES) return bad(`the layers' text passed ${UNPACK_MAX_TEXT_BYTES} bytes`);
      const bytes = stdout.subarray(off, end);
      off = end;
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        return bad(`layer ${n}'s text is not UTF-8`);
      }
      if (text.includes('\0')) return bad(`layer ${n}'s text holds NUL`);
      const from = parent === null ? path : parent.path;
      const virtual = unpackedPath(from, base + n);
      own.set(n, { path: virtual, depth: l.depth });
      layers.push({
        path: virtual,
        from,
        line: l.line,
        depth: l.depth,
        via: [...l.via],
        bytes_in: l.bytes_in,
        bytes_out: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        text,
      });
    }
    for (const x of f.failed) {
      failed += 1;
      if (failed > UNPACK_MAX_FAILED) return bad(`the head lists more than ${UNPACK_MAX_FAILED} failed sites`);
      const parent = x.parent === 0 ? path : own.get(x.parent)?.path;
      if (parent === undefined) return bad(`a failed site's parent ${x.parent} is no layer of its file`);
      unresolved.push({ i: k, path: parent, line: x.line === 0 ? null : x.line, why: x.why });
    }
  }
  if (off !== stdout.length) return bad(`${stdout.length - off} bytes follow the last layer`);
  return { ok: true, layers, unresolved };
}

// ---------------------------------------------------------------- the data decode

/** A file the decode sends: its path, bytes and index in the caller's list. */
interface DecodeSent {
  path: string;
  bytes: Buffer;
  at: number;
}

/** The handed files the decode's caps let through, in order, and those they keep back (the header's data decode). */
function planDecode(files: readonly DecodeFile[]): { sent: DecodeSent[]; unsent: { path: string; at: number }[] } {
  const sent: DecodeSent[] = [];
  const unsent: { path: string; at: number }[] = [];
  let total = 0;
  let overTotal = false;
  for (const [at, f] of files.entries()) {
    if (typeof f.path !== 'string' || !(f.bytes instanceof Uint8Array)) throw new Error(`handed file ${at} is not a path and its bytes`);
    const size = f.bytes.length;
    if (!overTotal && total + size > DECODE_MAX_INPUT_BYTES && size <= DECODE_MAX_FILE_BYTES) overTotal = true;
    if (overTotal || size > DECODE_MAX_FILE_BYTES || sent.length >= DECODE_MAX_FILES) {
      unsent.push({ path: f.path, at });
      continue;
    }
    total += size;
    sent.push({ path: f.path, bytes: Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes), at });
  }
  return { sent, unsent };
}

const DecodeHeadSchema = z.strictObject({
  v: z.literal(DECODE_WIRE_VERSION),
  python: z.string().regex(VERSION_RE),
  files: z
    .array(
      z.union([
        z.strictObject({
          i: int(0, DECODE_MAX_FILES - 1),
          via: z.array(z.enum(DECODE_VIA)).min(1).max(DECODE_MAX_DEPTH),
          bytes_in: int(0, DECODE_MAX_FILE_BYTES),
          utf8_len: int(1, DECODE_MAX_TEXT_BYTES),
        }),
        z.strictObject({ i: int(0, DECODE_MAX_FILES - 1), why: z.enum(DECODE_FAILURES) }),
      ]),
    )
    .max(DECODE_MAX_FILES),
});

/** A control character no decoded text may hold: every C0 one but DECODE_TEXT_CONTROLS, and DEL. */
const DECODE_CONTROL_RE = new RegExp(
  `[${[...Array.from({ length: 32 }, (_, c) => c).filter((c) => !(DECODE_TEXT_CONTROLS as readonly number[]).includes(c)), 0x7f]
    .map((c) => `\\x${c.toString(16).padStart(2, '0')}`)
    .join('')}]`,
);

/** The decode's answer read: each file that decoded (with its input index) and each that did not, or why it does not read. */
export type DecodeAnswer =
  | { ok: true; decoded: { i: number; file: DecodedFile }[]; undecoded: { i: number; path: string; why: string }[] }
  | { ok: false; why: string };

/**
 * Read the decode program's stdout (the header's data decode) for the files sent as /input/<i>, `sent[i]` each:
 * strictly, every rule of the wire checked again, since a compromised sandbox writes anything. Never throws.
 */
export function readDecodeAnswer(stdout: Buffer, sent: readonly { path: string; bytes: { length: number } }[]): DecodeAnswer {
  const bad = (why: string): DecodeAnswer => ({ ok: false, why });
  const nl = stdout.indexOf(0x0a);
  if (nl === -1) return bad('the answer holds no head line');
  if (nl > UNPACK_HEAD_MAX_BYTES) return bad(`the head passed ${UNPACK_HEAD_MAX_BYTES} bytes`);
  const headBytes = stdout.subarray(0, nl);
  for (const b of headBytes) if (b >= 0x80) return bad('the head is not ASCII');
  let json: unknown;
  try {
    json = JSON.parse(headBytes.toString('latin1'));
  } catch {
    return bad('the head is not JSON');
  }
  const parsed = DecodeHeadSchema.safeParse(json);
  if (!parsed.success) return bad('the head does not match the decode wire schema');
  const head = parsed.data;
  if (head.files.length !== sent.length) return bad(`the head lists ${head.files.length} files for ${sent.length} sent`);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decoded: { i: number; file: DecodedFile }[] = [];
  const undecoded: { i: number; path: string; why: string }[] = [];
  let off = nl + 1;
  for (const [k, f] of head.files.entries()) {
    if (f.i !== k) return bad(`file entry ${k} names input ${f.i}`);
    const path = sent[k]!.path;
    if (!('via' in f)) {
      undecoded.push({ i: k, path, why: f.why });
      continue;
    }
    if (f.bytes_in !== sent[k]!.bytes.length) return bad(`file ${k}'s bytes_in is not its input's size`);
    const end = off + f.utf8_len;
    if (end > stdout.length) return bad(`file ${k}'s text runs past the answer`);
    if (end - (nl + 1) > DECODE_MAX_TOTAL_TEXT_BYTES) return bad(`the texts passed ${DECODE_MAX_TOTAL_TEXT_BYTES} bytes`);
    const bytes = stdout.subarray(off, end);
    off = end;
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      return bad(`file ${k}'s text is not UTF-8`);
    }
    if (DECODE_CONTROL_RE.test(text)) return bad(`file ${k}'s text holds a control character`);
    decoded.push({
      i: k,
      file: { path, via: [...f.via], bytes_in: f.bytes_in, bytes_out: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text },
    });
  }
  if (off !== stdout.length) return bad(`${stdout.length - off} bytes follow the last text`);
  return { ok: true, decoded, undecoded };
}

// ---------------------------------------------------------------- the run-time capture

/** What the capture sends (the header's run-time capture): the files in order, the candidates run, and those left out with why. */
interface CapturePlan {
  sent: CaptureFile[];
  run: string[];
  left: { path: string; why: string }[];
}

/**
 * The candidates and files the capture's caps let through (the header's run-time capture): the candidates first, then
 * the other files in the caller's order, each kept to the caps and the path rule; a candidate that does not fit, past
 * CAPTURE_MAX_CANDIDATES, is `over_cap`, one not handed (or not a `.py` path) `failed`. A handed file that is no path
 * and its bytes is a throw (the caller's fault, `unavailable`).
 */
function planCapture(files: readonly DecodeFile[], candidates: readonly string[]): CapturePlan {
  const byPath = new Map<string, DecodeFile>();
  for (const [at, f] of files.entries()) {
    if (f === null || typeof f !== 'object' || typeof f.path !== 'string' || !(f.bytes instanceof Uint8Array)) throw new Error(`handed file ${at} is not a path and its bytes`);
    if (!byPath.has(f.path)) byPath.set(f.path, f);
  }
  const plan: CapturePlan = { sent: [], run: [], left: [] };
  const sentPaths = new Set<string>();
  let total = 0;
  // A path fits when it keeps the path rule and no sent path is its directory, or it theirs.
  const clashes = (p: string): boolean => {
    for (let cut = p.indexOf('/'); cut !== -1; cut = p.indexOf('/', cut + 1)) if (sentPaths.has(p.slice(0, cut))) return true;
    for (const q of sentPaths) if (q.startsWith(`${p}/`)) return true;
    return false;
  };
  const fits = (f: DecodeFile): boolean =>
    plan.sent.length < CAPTURE_MAX_FILES && f.bytes.length <= CAPTURE_MAX_FILE_BYTES && total + f.bytes.length <= CAPTURE_MAX_INPUT_BYTES && capturePathError(f.path) === null && !clashes(f.path);
  const send = (f: DecodeFile) => {
    plan.sent.push({ path: f.path, bytes: Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes) });
    sentPaths.add(f.path);
    total += f.bytes.length;
  };
  const named = new Set<string>();
  for (const c of candidates) {
    if (typeof c !== 'string' || named.has(c)) continue;
    named.add(c);
    const f = byPath.get(c);
    if (f === undefined || !c.endsWith('.py')) plan.left.push({ path: c, why: 'failed' });
    else if (plan.run.length >= CAPTURE_MAX_CANDIDATES || !fits(f)) plan.left.push({ path: c, why: 'over_cap' });
    else {
      send(f);
      plan.run.push(c);
    }
  }
  if (plan.run.length === 0) return plan;
  for (const f of byPath.values()) if (!sentPaths.has(f.path) && fits(f)) send(f);
  return plan;
}
