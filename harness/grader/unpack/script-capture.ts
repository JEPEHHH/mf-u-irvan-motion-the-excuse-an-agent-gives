// The run-time source capture: a python3.13 program, held as a string the way ./script.ts holds UNPACK_PY_SOURCE, and
// the reader of its answer. Some packed entries scramble their payload with their own code (a base-n digit loop with a
// positional patch, a byte XOR over a latin-1 literal), which no static fold (./script.ts) or fixed decoder chain
// (./script-decode.ts) reads. The capture runs that visible code, which the audit's first pass already read as text, in
// the sandbox, and stops it at the moment it hands the source it built to the compiler: the source is written out as text
// and never compiled, so the hidden code never runs. The host never runs Python (.cosmos/rules/project-context.mdc): the
// program is proven only in Docker (tests/unit/defender-capture-script.test.ts).
//
// The driver (./run.ts captureExec, wired by its own item) writes CAPTURE_PY_SOURCE to `<scratch>/code/capture.py`
// (CAPTURE_SCRIPT) and runs it in the pinned python3.13 image (python3 -P -s /bot/capture.py) in the unpack's sandbox:
// no network, a read-only root, /input read-only, a /tmp tmpfs, 1 CPU, 256 MiB, 16 pids, budget CAPTURE_BUDGET_MS.
//
// The wire in:
//
//   /input/<i>            (i = 0..n-1) the entry's text files, byte for byte: at most CAPTURE_MAX_FILES, each at most
//                         CAPTURE_MAX_FILE_BYTES, together at most CAPTURE_MAX_INPUT_BYTES
//   /input/capture.json   (CAPTURE_MANIFEST) one CaptureManifest: `files[i]` the entry path of /input/<i>, `candidates`
//                         the indices of the files to run, in run order (1 to CAPTURE_MAX_CANDIDATES, each a `.py` path)
//
// (an optional argv[1] names another input directory: a test's). captureInput builds both from the caller's files.
//
// What the program does. It reads and checks the manifest and the inputs against the caps and the path rule
// (capturePathError), lays the files out under a fresh directory in /tmp at their entry paths (files 0444, directories
// 0555), and runs each candidate in its own forked child, one at a time, each with an equal share of what is left of the
// program's clock (CAPTURE_SCRIPT_MS). A child points fds 0, 1 and 2 at /dev/null, clears the environment but PATH, sets
// cwd, sys.argv and sys.path[0] to the candidate's (sys.path otherwise the standard library's alone, no site-packages),
// turns bytecode caching off both ways (sys.dont_write_bytecode, and sys.pycache_prefix at a directory that does not exist,
// so every module it imports is compiled from its own source text and no `marshal.loads` is ever the import system's),
// installs its audit hook (sys.addaudithook), and only then runs runpy.run_path(<candidate>, run_name='__main__').
//
// The hook, on each audit event (https://docs.python.org/3.13/library/audit_events.html):
//   compile    the parser's event (CPython 3.13 Parser/peg_api.c raises it for compile(), exec() and eval() of a str or
//              bytes, always with the source as bytes: a str source is its UTF-8). A source byte-equal to the text of the
//              file its filename names, a handed file or a standard-library `.py` (its path normalised, site-packages
//              excluded), compiles; so does one of ASCII whitespace only, and the source collections.namedtuple builds
//              (its field names held to exact-str identifiers by namedtuple itself). Any other source built in a frame of
//              a handed file is CAPTURED: read as Python reads source (a BOM, a coding cookie on line 1 or 2, of the
//              UTF-8, latin-1 or ASCII families; else `not_text`), written out as UTF-8 with the handed file and line
//              whose code built it, and the child os._exit's at once, before the compiler sees it. Built anywhere else (a
//              library that compiles a string it was handed: timeit, a custom loader's source_to_code) it is refused
//              `library_compile`; an AST or a file the C reader parses is refused `syntax_tree`;
//   exec       a code object whose filename is a handed file, a standard-library `.py` or `<frozen ...>`, or namedtuple's
//              own `<string>`; else `foreign_exec`;
//   import     a module whose top name is a handed file's module or package name, or in sys.stdlib_module_names; never
//              ctypes, subprocess, multiprocessing, the subinterpreter or test modules; else `import`;
//   open       for reading only: a mode holding w, a, x or + (or os.open flags that write, create, truncate or append)
//              is `write`, as are the os and shutil file changes, tempfile, mmap and sqlite3.connect;
//   refused    marshal.loads / marshal.load (`marshal`), code.__new__ (`code_object`), ctypes.* and sqlite3's extension
//              loading (`native`), socket.* and the network clients' events (`network`), subprocess.Popen, os.system,
//              os.exec, os.posix_spawn, os.spawn, os.fork, os.forkpty, os.kill and the like (`process`), sys.settrace,
//              sys.setprofile, sys.monitoring.register_callback, sys._current_frames, the gc walks, sys.addaudithook
//              and a sys._getframe that reaches the capture program's own frames (`introspection`), a new interpreter
//              or a cpython.run_* (`interpreter`).
// A refusal writes its why and the child os._exit's. A candidate that returns, raises or exits without building a
// source is `no_build`; one past its share is killed (`timeout`); a built source past CAPTURE_MAX_TEXT_BYTES is
// `over_cap`; a child that dies of a signal or answers its parent out of shape is `failed`. One captured source per
// candidate, the first: a layer that is itself packed is judged as packed by the review.
//
// The wire out (stdout):
//
//   line 1   one JSON object (CaptureHead) of at most UNPACK_HEAD_MAX_BYTES, ASCII, no newline inside;
//   then     the captured sources' UTF-8 text back to back in candidate order, each exactly its `utf8_len` bytes.
//
// It exits 0 whenever it wrote a head, CAPTURE_EXIT_TIMEOUT when its own interval timer (CAPTURE_SCRIPT_MS plus a
// grace) fired first (no head), CAPTURE_EXIT_HEAD_TOO_LARGE when the head would pass its cap (unreachable under these
// caps), CAPTURE_EXIT_BAD_INPUT when the manifest or the inputs do not fit the wire in (nothing written). Anything else
// (a traceback) is a failed run.
//
// What the hook cannot do. A captured source is the first one the visible code hands the compiler, so visible code
// that compiles a decoy first, raises a fake `compile` audit event (sys.audit), writes to the child's answer pipe itself,
// or walks frames (frame.f_back, unaudited) from a finaliser or signal handler that runs inside the hook can show the
// review something other than what runs. Each of those is visible code the first pass read; the sandbox, not the hook,
// is what contains a run that gets past it, and the review reads a capture with that caveat.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { UNPACK_EXIT_HEAD_TOO_LARGE, UNPACK_EXIT_TIMEOUT, UNPACK_HEAD_MAX_BYTES, UNPACK_MAX_TEXT_BYTES } from './protocol.ts';

/** The script's file name under the spawn's codeDir (/bot). */
export const CAPTURE_SCRIPT = 'capture.py';
/** The manifest's name under /input: neither an input's (<i>) nor the unpack's tree names (t<j>.<kind>). */
export const CAPTURE_MANIFEST = 'capture.json';
/** Wire version: the head's `v`. */
export const CAPTURE_WIRE_VERSION = 1;

/** Candidates a run at most: each runs in its own child, one at a time. */
export const CAPTURE_MAX_CANDIDATES = 4;
/** The Supervisor's budget for a capture run, from the program's start: above the program's own clock. */
export const CAPTURE_BUDGET_MS = 10_000;
/** The program's own clock: its candidates share it, and its interval timer exits it at this plus CAPTURE_GRACE_MS. */
export const CAPTURE_SCRIPT_MS = 8_000;
/** What the program keeps back from CAPTURE_SCRIPT_MS to write its answer, and lets its timer run past it. */
export const CAPTURE_GRACE_MS = 500;
/** One captured source's UTF-8 text at most: the unpack's text cap. Past it the candidate is `over_cap`. */
export const CAPTURE_MAX_TEXT_BYTES = UNPACK_MAX_TEXT_BYTES;
/** All captured text a run at most (what follows the head). */
export const CAPTURE_MAX_TOTAL_TEXT_BYTES = CAPTURE_MAX_CANDIDATES * CAPTURE_MAX_TEXT_BYTES;
/** stdout kept at most: the head, its newline and the captured text. */
export const CAPTURE_MAX_STDOUT_BYTES = UNPACK_HEAD_MAX_BYTES + 1 + CAPTURE_MAX_TOTAL_TEXT_BYTES;
/** Handed files a run at most (/input/0 .. /input/63): the candidates and every text file they may read or import. */
export const CAPTURE_MAX_FILES = 64;
/** One handed file's bytes at most. */
export const CAPTURE_MAX_FILE_BYTES = 1_048_576;
/** All handed files' bytes together at most. */
export const CAPTURE_MAX_INPUT_BYTES = 4_194_304;
/** One entry path's UTF-8 bytes at most. */
export const CAPTURE_MAX_PATH_BYTES = 1_024;
/** The manifest's bytes at most (CAPTURE_MAX_FILES paths at CAPTURE_MAX_PATH_BYTES fit, escaped). */
export const CAPTURE_MAX_MANIFEST_BYTES = 524_288;
/** A line number a head may name: no handed file holds more lines than bytes. */
export const CAPTURE_MAX_LINE = CAPTURE_MAX_FILE_BYTES + 1;

/** Exit codes besides 0 (a head written). */
export const CAPTURE_EXIT_TIMEOUT = UNPACK_EXIT_TIMEOUT;
export const CAPTURE_EXIT_HEAD_TOO_LARGE = UNPACK_EXIT_HEAD_TOO_LARGE;
export const CAPTURE_EXIT_BAD_INPUT = 5;

/**
 * Why the hook stopped a candidate before it built a source (the header's hook): each a fixed name, never an entry byte.
 */
export const CAPTURE_REFUSALS = Object.freeze([
  'marshal',
  'code_object',
  'foreign_exec',
  'syntax_tree',
  'library_compile',
  'native',
  'network',
  'process',
  'write',
  'import',
  'introspection',
  'interpreter',
] as const);
export type CaptureRefusal = (typeof CAPTURE_REFUSALS)[number];

/**
 * Why a candidate captured nothing: it ran to its end without building a source (`no_build`), passed its share of the
 * clock (`timeout`), built a source past CAPTURE_MAX_TEXT_BYTES (`over_cap`) or one that does not read as text
 * (`not_text`), its child died or answered out of shape (`failed`), or the hook refused an operation (CAPTURE_REFUSALS).
 */
export const CAPTURE_FAILURES = Object.freeze(['no_build', 'timeout', 'over_cap', 'not_text', 'failed', ...CAPTURE_REFUSALS] as const);
export type CaptureFailure = (typeof CAPTURE_FAILURES)[number];

/** /input/capture.json: the entry path of each /input/<i>, and the indices of the candidates in run order. */
export interface CaptureManifest {
  files: string[];
  candidates: number[];
}

/** One captured candidate in the head. */
export interface CaptureHeadCaptured {
  /** The candidate's input index (/input/<i>). */
  i: number;
  /** The input index of the handed file whose code built the source (the candidate, or a file it imported). */
  from: number;
  /** The 1-based line, in that file, of the call that handed the source to the compiler; 0 when unknown. */
  line: number;
  /** The source's UTF-8 bytes: exactly what follows the head for it (at least 1). */
  utf8_len: number;
  /** The sha256 of those bytes, lowercase hex. */
  sha256: string;
}

/** One candidate that captured nothing. */
export interface CaptureHeadUncaptured {
  i: number;
  why: CaptureFailure;
}

/** The head line. */
export interface CaptureHead {
  v: typeof CAPTURE_WIRE_VERSION;
  /** platform.python_version() of the interpreter that ran (the pinned image's, e.g. 3.13.17). */
  python: string;
  /** One entry per candidate, in the manifest's candidate order. */
  files: (CaptureHeadCaptured | CaptureHeadUncaptured)[];
}

/** A captured source, read and checked: its candidate, where it was built, and its text. */
export interface CapturedSource {
  /** The candidate's entry path. */
  path: string;
  /** The entry path of the file whose code built it. */
  from: string;
  /** The line in `from` of the call that handed it to the compiler, or null. */
  line: number | null;
  /** The text's UTF-8 bytes, counted here. */
  bytes_out: number;
  /** Their sha256, computed here (and equal to the head's). */
  sha256: string;
  text: string;
}

/** A candidate that captured nothing, and why. */
export interface CaptureUncaptured {
  path: string;
  why: CaptureFailure;
}

/** The answer read: each candidate captured or not, in candidate order, or why it does not read (a fixed sentence). */
export type CaptureAnswer =
  | { ok: true; python: string; captured: CapturedSource[]; unresolved: CaptureUncaptured[] }
  | { ok: false; why: string };

/** A file the caller hands: its entry path and bytes. */
export interface CaptureFile {
  path: string;
  bytes: Uint8Array;
}

/** What the driver writes under input/: each /input/<i> and the manifest last; or why the files do not fit the wire in. */
export type CaptureInput = { ok: true; manifest: CaptureManifest; inputs: { name: string; bytes: Buffer }[] } | { ok: false; why: string };

/** C0 controls, DEL and the backslash: no entry path the capture lays out holds one. */
const PATH_BAD_RE = /[\u0000-\u001f\u007f\\]/;

/**
 * Why an entry path cannot be laid out by the program (the same rule its own manifest check applies), or null: relative
 * POSIX, at most CAPTURE_MAX_PATH_BYTES of UTF-8, each segment non-empty and neither `.` nor `..`, no control character
 * or backslash, well-formed UTF-16.
 */
export function capturePathError(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'an empty path';
  if (!path.isWellFormed()) return 'a path that is not well-formed text';
  if (Buffer.byteLength(path, 'utf8') > CAPTURE_MAX_PATH_BYTES) return `a path past ${CAPTURE_MAX_PATH_BYTES} bytes`;
  if (PATH_BAD_RE.test(path)) return 'a path holding a control character or a backslash';
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return 'a path with an empty, `.` or `..` segment';
  }
  return null;
}

/**
 * The run's inputs for `files` (each /input/<i> in order) and `candidates` (entry paths among them, in run order), held
 * to the wire in: the caps, the path rule, no path that is another's directory, each candidate a `.py` path handed once.
 */
export function captureInput(files: readonly CaptureFile[], candidates: readonly string[]): CaptureInput {
  const bad = (why: string): CaptureInput => ({ ok: false, why });
  if (!Array.isArray(files) || !Array.isArray(candidates)) return bad('the files and candidates are not lists');
  if (files.length === 0) return bad('no file was handed');
  if (files.length > CAPTURE_MAX_FILES) return bad(`more than ${CAPTURE_MAX_FILES} files`);
  if (candidates.length === 0) return bad('no candidate was named');
  if (candidates.length > CAPTURE_MAX_CANDIDATES) return bad(`more than ${CAPTURE_MAX_CANDIDATES} candidates`);
  const at = new Map<string, number>();
  let total = 0;
  for (const [i, f] of files.entries()) {
    if (f === null || typeof f !== 'object' || !(f.bytes instanceof Uint8Array)) return bad(`file ${i} is not a path and its bytes`);
    const why = capturePathError(f.path);
    if (why !== null) return bad(`file ${i}: ${why}`);
    if (at.has(f.path)) return bad(`file ${i} repeats a path`);
    at.set(f.path, i);
    if (f.bytes.length > CAPTURE_MAX_FILE_BYTES) return bad(`file ${i} passed ${CAPTURE_MAX_FILE_BYTES} bytes`);
    total += f.bytes.length;
    if (total > CAPTURE_MAX_INPUT_BYTES) return bad(`the files passed ${CAPTURE_MAX_INPUT_BYTES} bytes`);
  }
  for (const p of at.keys()) {
    for (let cut = p.indexOf('/'); cut !== -1; cut = p.indexOf('/', cut + 1)) {
      if (at.has(p.slice(0, cut))) return bad('a file path is another file\'s directory');
    }
  }
  const picked: number[] = [];
  for (const c of candidates) {
    const i = typeof c === 'string' ? at.get(c) : undefined;
    if (i === undefined) return bad('a candidate is not among the files');
    if (!c.endsWith('.py')) return bad('a candidate is not a .py path');
    if (picked.includes(i)) return bad('a candidate is named twice');
    picked.push(i);
  }
  const manifest: CaptureManifest = { files: files.map((f) => f.path), candidates: picked };
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (json.length > CAPTURE_MAX_MANIFEST_BYTES) return bad(`the manifest passed ${CAPTURE_MAX_MANIFEST_BYTES} bytes`);
  const inputs = files.map((f, i) => ({ name: String(i), bytes: Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes) }));
  inputs.push({ name: CAPTURE_MANIFEST, bytes: json });
  return { ok: true, manifest, inputs };
}

const int = (min: number, max: number) => z.number().int().min(min).max(max);

const CaptureHeadSchema = z.strictObject({
  v: z.literal(CAPTURE_WIRE_VERSION),
  python: z.string().regex(/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}[a-z0-9]{0,8}$/),
  files: z
    .array(
      z.union([
        z.strictObject({
          i: int(0, CAPTURE_MAX_FILES - 1),
          from: int(0, CAPTURE_MAX_FILES - 1),
          line: int(0, CAPTURE_MAX_LINE),
          utf8_len: int(1, CAPTURE_MAX_TEXT_BYTES),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
        z.strictObject({ i: int(0, CAPTURE_MAX_FILES - 1), why: z.enum(CAPTURE_FAILURES) }),
      ]),
    )
    .max(CAPTURE_MAX_CANDIDATES),
});

/**
 * Read the program's stdout for the run `manifest` describes: strictly, every rule of the wire checked again, since a
 * compromised sandbox writes anything. One head entry per candidate in the manifest's order, naming that candidate's
 * input; a capture's `from` a handed file; each text strict UTF-8 without NUL (a BOM kept), its `utf8_len` and sha256 its
 * bytes' own; the texts adding up to exactly the bytes after the head. Anything else is `{ ok: false }`. Never throws.
 */
export function readCaptureAnswer(stdout: Buffer, manifest: CaptureManifest): CaptureAnswer {
  const bad = (why: string): CaptureAnswer => ({ ok: false, why });
  if (!Buffer.isBuffer(stdout)) return bad('the answer is not bytes');
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
  const parsed = CaptureHeadSchema.safeParse(json);
  if (!parsed.success) return bad('the head does not match the capture wire schema');
  const head = parsed.data;
  const { files, candidates } = manifest;
  if (head.files.length !== candidates.length) return bad(`the head lists ${head.files.length} candidates for ${candidates.length} run`);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const captured: CapturedSource[] = [];
  const unresolved: CaptureUncaptured[] = [];
  let off = nl + 1;
  for (const [k, f] of head.files.entries()) {
    const want = candidates[k]!;
    if (f.i !== want) return bad(`head entry ${k} names input ${f.i}, not the candidate run`);
    const path = files[want];
    if (path === undefined) return bad(`candidate ${k} is no handed file`);
    if (!('utf8_len' in f)) {
      unresolved.push({ path, why: f.why });
      continue;
    }
    const from = files[f.from];
    if (from === undefined) return bad(`candidate ${k}'s source was built in no handed file`);
    const end = off + f.utf8_len;
    if (end > stdout.length) return bad(`candidate ${k}'s text runs past the answer`);
    if (end - (nl + 1) > CAPTURE_MAX_TOTAL_TEXT_BYTES) return bad(`the texts passed ${CAPTURE_MAX_TOTAL_TEXT_BYTES} bytes`);
    const bytes = stdout.subarray(off, end);
    off = end;
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      return bad(`candidate ${k}'s text is not UTF-8`);
    }
    if (text.includes('\0')) return bad(`candidate ${k}'s text holds NUL`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== f.sha256) return bad(`candidate ${k}'s text does not match its sha256`);
    captured.push({ path, from, line: f.line === 0 ? null : f.line, bytes_out: bytes.length, sha256, text });
  }
  if (off !== stdout.length) return bad(`${stdout.length - off} bytes follow the last text`);
  return { ok: true, python: head.python, captured, unresolved };
}

/** The refusal table as a Python dict literal: each audit event the hook stops a candidate on, by exact name. */
const REFUSED_EVENTS_PY = JSON.stringify({
  'marshal.loads': 'marshal',
  'marshal.load': 'marshal',
  'code.__new__': 'code_object',
  'sqlite3.load_extension': 'native',
  'sqlite3.enable_load_extension': 'native',
  'urllib.Request': 'network',
  'http.client.connect': 'network',
  'http.client.send': 'network',
  'ftplib.connect': 'network',
  'smtplib.connect': 'network',
  'imaplib.open': 'network',
  'nntplib.connect': 'network',
  'poplib.connect': 'network',
  'telnetlib.Telnet.open': 'network',
  'webbrowser.open': 'network',
  'subprocess.Popen': 'process',
  'os.system': 'process',
  'os.exec': 'process',
  'os.posix_spawn': 'process',
  'os.spawn': 'process',
  'os.fork': 'process',
  'os.forkpty': 'process',
  'os.kill': 'process',
  'os.killpg': 'process',
  'signal.pthread_kill': 'process',
  'os.startfile': 'process',
  'os.startfile/2': 'process',
  'os.remove': 'write',
  'os.rename': 'write',
  'os.rmdir': 'write',
  'os.mkdir': 'write',
  'os.symlink': 'write',
  'os.link': 'write',
  'os.truncate': 'write',
  'os.utime': 'write',
  'os.chmod': 'write',
  'os.chown': 'write',
  'os.chflags': 'write',
  'os.setxattr': 'write',
  'os.removexattr': 'write',
  'os.lockf': 'write',
  'shutil.copyfile': 'write',
  'shutil.copymode': 'write',
  'shutil.copystat': 'write',
  'shutil.copytree': 'write',
  'shutil.rmtree': 'write',
  'shutil.move': 'write',
  'shutil.chown': 'write',
  'shutil.make_archive': 'write',
  'shutil.unpack_archive': 'write',
  'tempfile.mkstemp': 'write',
  'tempfile.mkdtemp': 'write',
  'mmap.__new__': 'write',
  'sqlite3.connect': 'write',
  'sys.settrace': 'introspection',
  'sys.setprofile': 'introspection',
  'sys.monitoring.register_callback': 'introspection',
  'sys._current_frames': 'introspection',
  'sys._current_exceptions': 'introspection',
  'gc.get_objects': 'introspection',
  'gc.get_referrers': 'introspection',
  'gc.get_referents': 'introspection',
  'sys.addaudithook': 'introspection',
  'cpython.PyInterpreterState_New': 'interpreter',
  'cpython.run_command': 'interpreter',
  'cpython.run_file': 'interpreter',
  'cpython.run_interactivehook': 'interpreter',
  'cpython.run_module': 'interpreter',
  'cpython.run_startup': 'interpreter',
  'cpython.run_stdin': 'interpreter',
  'cpython._PySys_ClearAuditHooks': 'interpreter',
} satisfies Record<string, CaptureRefusal>);

/** Event name prefixes the hook stops on, as a Python list of [prefix, why] pairs. */
const REFUSED_PREFIXES_PY = JSON.stringify([
  ['ctypes.', 'native'],
  ['socket.', 'network'],
  ['ssl.', 'network'],
  ['syslog.', 'network'],
  ['winreg.', 'write'],
  ['_winapi.', 'process'],
  ['msvcrt.', 'process'],
] satisfies [string, CaptureRefusal][]);

/** Top-level module names no candidate may import, even from the standard library or as an entry file of that name. */
const DENIED_IMPORTS_PY = JSON.stringify([
  'ctypes',
  '_ctypes',
  'subprocess',
  '_posixsubprocess',
  'multiprocessing',
  '_multiprocessing',
  '_posixshmem',
  '_interpreters',
  '_interpqueues',
  '_interpchannels',
  '_xxsubinterpreters',
  '_xxinterpchannels',
  '_xxinterpqueues',
]);

/**
 * capture.py: stdlib only, the caps interpolated from this file and protocol.ts. The parent never imports, compiles or
 * runs an entry byte; each child runs the candidate under the hook (the header says what it allows).
 */
export const CAPTURE_PY_SOURCE = String.raw`# make.fun's run-time source capture (grader/unpack/script-capture.ts CAPTURE_PY_SOURCE), run as
# python3 -P -s /bot/capture.py [<input dir>] in the pinned python3.13 image: the entry's text files read-only at
# /input/<i>, their entry paths and the candidates in /input/capture.json, no network, no env but PATH, capped CPU,
# memory, pids and output. Each candidate runs in a forked child under an audit hook installed before any entry code;
# the child stops at the first compile of a source that is no handed or standard-library file's own text, writes that
# source out as text and exits before the compiler sees it, so the hidden code never runs. Stdlib only; the caps and
# the wire are grader/unpack/script-capture.ts's.
import _io
import hashlib
import json
import os
import pkgutil
import platform
import re
import runpy
import select
import signal
import sys
import sysconfig
import time

INPUT = sys.argv[1] if len(sys.argv) > 1 else '/input'
MANIFEST = '${CAPTURE_MANIFEST}'
WIRE_VERSION = ${CAPTURE_WIRE_VERSION}
MAX_CANDIDATES = ${CAPTURE_MAX_CANDIDATES}
MAX_FILES = ${CAPTURE_MAX_FILES}
MAX_FILE_BYTES = ${CAPTURE_MAX_FILE_BYTES}
MAX_INPUT_BYTES = ${CAPTURE_MAX_INPUT_BYTES}
MAX_PATH_BYTES = ${CAPTURE_MAX_PATH_BYTES}
MAX_MANIFEST_BYTES = ${CAPTURE_MAX_MANIFEST_BYTES}
MAX_TEXT_BYTES = ${CAPTURE_MAX_TEXT_BYTES}
MAX_LINE = ${CAPTURE_MAX_LINE}
HEAD_MAX_BYTES = ${UNPACK_HEAD_MAX_BYTES}
SCRIPT_MS = ${CAPTURE_SCRIPT_MS}
GRACE_MS = ${CAPTURE_GRACE_MS}
EXIT_TIMEOUT = ${CAPTURE_EXIT_TIMEOUT}
EXIT_HEAD_TOO_LARGE = ${CAPTURE_EXIT_HEAD_TOO_LARGE}
EXIT_BAD_INPUT = ${CAPTURE_EXIT_BAD_INPUT}
# A child that could not set itself up exits with this, having written nothing: its candidate is 'failed'.
EXIT_CHILD_SETUP = 70
# Where the import system looks for cached bytecode: nowhere that exists, so a module compiles from its source.
NO_PYCACHE = '/nonexistent-capture-pycache'
REFUSALS = frozenset(${JSON.stringify([...CAPTURE_REFUSALS])})
REFUSED_EVENTS = ${REFUSED_EVENTS_PY}
REFUSED_PREFIXES = tuple((p, w.encode('ascii')) for p, w in ${REFUSED_PREFIXES_PY})
DENIED_IMPORTS = frozenset(${DENIED_IMPORTS_PY})
DENIED_IMPORT_PREFIXES = ('_test', '_xx', 'xx', '_ctypes')


# The child running now (0: none), killed with the program when its own timer fires.
RUNNING = [0]


def out_of_time(signum, frame):
    if RUNNING[0]:
        try:
            os.kill(RUNNING[0], signal.SIGKILL)
        except OSError:
            pass
    os._exit(EXIT_TIMEOUT)


def path_ok(p):
    """The wire's path rule (script-capture.ts capturePathError)."""
    if type(p) is not str or p == '':
        return False
    try:
        if len(p.encode('utf-8')) > MAX_PATH_BYTES:
            return False
    except UnicodeEncodeError:
        return False
    for ch in p:
        if ord(ch) < 0x20 or ord(ch) == 0x7f or ch == '\\':
            return False
    for seg in p.split('/'):
        if seg in ('', '.', '..'):
            return False
    return True


def read_capped(path, cap):
    with open(path, 'rb') as f:
        data = f.read(cap + 1)
    return data if len(data) <= cap else None


def read_input():
    """The manifest and the inputs, checked against the wire in; None when they do not fit it."""
    try:
        raw = read_capped(os.path.join(INPUT, MANIFEST), MAX_MANIFEST_BYTES)
        if raw is None:
            return None
        m = json.loads(raw.decode('utf-8'))
    except (OSError, ValueError):
        return None
    if type(m) is not dict or set(m) != {'files', 'candidates'}:
        return None
    paths, cands = m['files'], m['candidates']
    if type(paths) is not list or not 1 <= len(paths) <= MAX_FILES:
        return None
    if type(cands) is not list or not 1 <= len(cands) <= MAX_CANDIDATES:
        return None
    if not all(path_ok(p) for p in paths) or len(set(paths)) != len(paths):
        return None
    every = set(paths)
    for p in paths:
        cut = p.find('/')
        while cut != -1:
            if p[:cut] in every:
                return None
            cut = p.find('/', cut + 1)
    for c in cands:
        if type(c) is not int or not 0 <= c < len(paths) or not paths[c].endswith('.py'):
            return None
    if len(set(cands)) != len(cands):
        return None
    texts = []
    total = 0
    for i in range(len(paths)):
        try:
            data = read_capped(os.path.join(INPUT, str(i)), MAX_FILE_BYTES)
        except OSError:
            return None
        if data is None:
            return None
        total += len(data)
        if total > MAX_INPUT_BYTES:
            return None
        texts.append(data)
    return paths, texts, cands


def lay_out(paths, texts):
    """The files at their entry paths under a fresh directory in /tmp: files 0444, directories 0555."""
    root = '/tmp/capture-%d' % os.getpid()
    os.mkdir(root, 0o700)
    dirs = {root}
    for p, data in zip(paths, texts):
        parts = p.split('/')
        here = root
        for seg in parts[:-1]:
            here = here + '/' + seg
            if here not in dirs:
                os.mkdir(here, 0o700)
                dirs.add(here)
        fd = os.open(root + '/' + p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
        finally:
            os.close(fd)
        os.chmod(root + '/' + p, 0o444)
    for d in sorted(dirs, key=len, reverse=True):
        os.chmod(d, 0o555)
    return root


def stdlib_dir():
    try:
        d = sysconfig.get_paths()['stdlib']
    except (KeyError, OSError):
        d = os.path.dirname(os.__file__)
    return os.path.normpath(d)


def in_stdlib(p, lib):
    if type(p) is not str:
        return False
    if p == lib:
        return True
    if not p.startswith(lib + '/'):
        return False
    rest = p[len(lib) + 1:]
    return not (rest.startswith('site-packages') or rest.startswith('dist-packages'))


def entry_modules(paths):
    """The module and package names the handed files can be imported as, from any directory of the entry."""
    names = set()
    for p in paths:
        parts = p.split('/')
        names.update(parts[:-1])
        if parts[-1].endswith('.py'):
            names.add(parts[-1][:-3])
    names.discard('__init__')
    return frozenset(n for n in names if n.isidentifier())


def make_hook(full, texts, mods, lib, wfd):
    """
    The audit hook and the child's last word, closed over their own copies of everything they read, so nothing the
    candidate rebinds (a module attribute, a global) changes what they decide or where they write.
    """
    _exit = os._exit
    _write = os.write
    _getframe = sys._getframe
    _fileio = _io.FileIO
    _str = str
    _bytes = bytes
    _int = int
    _tuple = tuple
    _code = type(make_hook.__code__)
    own_file = make_hook.__code__.co_filename
    allowed = {}
    index = {}
    for j, path in enumerate(full):
        allowed[path] = texts[j]
        index[path] = j
    stdlib_names = frozenset(sys.stdlib_module_names)
    prefix = lib + '/'
    tuple_file = prefix + 'collections/__init__.py'
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
    refused = dict((k, v.encode('ascii')) for k, v in REFUSED_EVENTS.items())
    prefixes = REFUSED_PREFIXES
    denied = DENIED_IMPORTS
    denied_prefixes = DENIED_IMPORT_PREFIXES
    cookie_re = re.compile(rb'^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)', re.ASCII)
    blank_re = re.compile(rb'^[ \t\f]*(?:[#\r\n]|$)', re.ASCII)
    utf8_names = frozenset(('utf-8', 'utf8', 'u8', 'utf'))
    latin_names = frozenset(('latin-1', 'latin1', 'iso-8859-1', 'iso8859-1', 'iso-latin-1', 'l1', 'latin', 'cp819', '8859'))
    ascii_names = frozenset(('ascii', 'us-ascii', '646'))
    max_text = MAX_TEXT_BYTES
    max_line = MAX_LINE

    def send(data):
        try:
            view = memoryview(data)
            while view:
                view = view[_write(wfd, view):]
        except BaseException:
            pass
        _exit(0)

    def refuse(why):
        send(b'R' + why)

    def norm(path):
        # An absolute path with no empty, '.' or '..' segment left: the import system may spell a file so.
        if type(path) is not _str or not path.startswith('/') or '\x00' in path:
            return None
        out = []
        for seg in path.split('/'):
            if seg == '' or seg == '.':
                continue
            if seg == '..':
                if out:
                    out.pop()
                continue
            out.append(seg)
        return '/' + '/'.join(out)

    def lib_source(n):
        if n is None or not n.startswith(prefix) or not n.endswith('.py'):
            return False
        rest = n[len(prefix):]
        return not (rest.startswith('site-packages/') or rest.startswith('dist-packages/'))

    def read_file(n):
        try:
            f = _fileio(n, 'r')
            try:
                return f.readall()
            finally:
                f.close()
        except BaseException:
            return None

    def own_text(filename, src):
        # Whether src is byte for byte the text of the handed or standard-library file filename names.
        n = norm(filename)
        if n is None:
            return False
        t = allowed.get(n)
        if t is not None:
            return t == src
        return lib_source(n) and read_file(n) == src

    def entry_index(f):
        if f is None:
            return None
        fn = f.f_code.co_filename
        n = norm(fn)
        return None if n is None else index.get(n)

    def is_tuple_frame(f):
        if f is None:
            return False
        code = f.f_code
        fn = code.co_filename
        name = code.co_name
        return type(fn) is _str and type(name) is _str and fn == tuple_file and name == 'namedtuple'

    def encoding_of(raw):
        name = raw.decode('ascii').lower().replace('_', '-')
        if name in utf8_names or name.startswith('utf-8-'):
            return 'utf-8'
        if name in latin_names or name.startswith(('latin-1-', 'iso-8859-1-', 'iso-latin-1-')):
            return 'latin-1'
        if name in ascii_names:
            return 'ascii'
        return None

    def as_text(src):
        # The source as Python reads it: a UTF-8 BOM, else a coding cookie on line 1 (or line 2 under a blank or
        # comment line 1), else UTF-8. None when it does not read, or names an encoding outside the three families.
        try:
            body = src
            bom = body[:3] == b'\xef\xbb\xbf'
            if bom:
                body = body[3:]
            nl = body.find(b'\n')
            first = body if nl < 0 else body[:nl + 1]
            m = cookie_re.match(first)
            if m is None and nl >= 0 and blank_re.match(first) is not None:
                rest = body[nl + 1:]
                nl2 = rest.find(b'\n')
                m = cookie_re.match(rest if nl2 < 0 else rest[:nl2 + 1])
            enc = 'utf-8'
            if m is not None:
                enc = encoding_of(m.group(1))
                if enc is None or (bom and enc != 'utf-8'):
                    return None
            text = _str(body, enc)
            if '\x00' in text:
                return None
            return text
        except BaseException:
            return None

    def capture(src, j, f):
        text = as_text(src)
        if text is None:
            refuse(b'not_text')
        try:
            out = text.encode('utf-8')
        except BaseException:
            refuse(b'not_text')
        if len(out) > max_text:
            refuse(b'over_cap')
        line = f.f_lineno
        if type(line) is not _int or line < 0 or line > max_line:
            line = 0
        send(b'C' + j.to_bytes(4, 'big') + line.to_bytes(4, 'big') + out)

    def on_compile(args, f):
        if len(args) != 2 or type(args[0]) is not _bytes:
            refuse(b'syntax_tree')
        src = args[0]
        if own_text(args[1], src) or not src.strip():
            return
        j = entry_index(f)
        if j is not None:
            capture(src, j, f)
        if is_tuple_frame(f):
            return
        refuse(b'library_compile')

    def on_exec(args, f):
        if len(args) == 1 and type(args[0]) is _code:
            fn = args[0].co_filename
            if type(fn) is _str:
                if fn.startswith('<frozen '):
                    return
                n = norm(fn)
                if n is not None and (n in index or lib_source(n)):
                    return
                if fn == '<string>' and is_tuple_frame(f):
                    return
        refuse(b'foreign_exec')

    def on_open(args):
        if len(args) != 3:
            refuse(b'write')
        mode = args[1]
        flags = args[2]
        if type(mode) is _str:
            if 'w' in mode or 'a' in mode or 'x' in mode or '+' in mode:
                refuse(b'write')
            return
        if mode is None and type(flags) is _int:
            if flags & write_flags:
                refuse(b'write')
            return
        refuse(b'write')

    def on_import(args):
        name = args[0] if len(args) > 0 else None
        if type(name) is not _str:
            refuse(b'import')
        top = name.partition('.')[0]
        if top in denied:
            refuse(b'import')
        if top in mods:
            return
        if top == 'test' or top.startswith(denied_prefixes):
            refuse(b'import')
        if top in stdlib_names:
            return
        refuse(b'import')

    def on_getframe(args):
        # The frame sys._getframe hands back: never one of this program's own.
        f = args[0] if len(args) == 1 else None
        if f is not None:
            fn = f.f_code.co_filename
            if type(fn) is not _str or fn == own_file:
                refuse(b'introspection')

    def hook(event, args):
        if type(args) is not _tuple:
            refuse(b'interpreter')
        if event == 'compile':
            on_compile(args, _getframe(1))
        elif event == 'exec':
            on_exec(args, _getframe(1))
        elif event == 'open':
            on_open(args)
        elif event == 'import':
            on_import(args)
        elif event == 'sys._getframe':
            on_getframe(args)
        else:
            why = refused.get(event)
            if why is None:
                for p, w in prefixes:
                    if event.startswith(p):
                        why = w
                        break
            if why is not None:
                refuse(why)

    def finish():
        send(b'Rno_build')

    return hook, finish


def child(c, root, paths, texts, mods, lib, wfd):
    """One candidate under the hook; never returns."""
    try:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, signal.SIG_DFL)
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null, fd)
        os.close(null)
        full = [root + '/' + p for p in paths]
        target = full[c]
        here = target.rsplit('/', 1)[0]
        os.chdir(here)
        keep = os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')
        os.environ.clear()
        os.environ['PATH'] = keep
        sys.argv[:] = [target]
        sys.path[:] = [here] + [p for p in sys.path if in_stdlib(p, lib)]
        sys.path_importer_cache.clear()
        sys.dont_write_bytecode = True
        sys.pycache_prefix = NO_PYCACHE
        hook, finish = make_hook(full, texts, mods, lib, wfd)
    except BaseException:
        os._exit(EXIT_CHILD_SETUP)
    sys.addaudithook(hook)
    try:
        runpy.run_path(target, run_name='__main__')
    except BaseException:
        pass
    finish()
    os._exit(EXIT_CHILD_SETUP)


def reap(pid, deadline, kill):
    """The child's wait status, killing it first when asked or once the deadline passes; and whether it passed."""
    late = False
    if not kill:
        while True:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                return status, False
            if time.monotonic() >= deadline:
                late = True
                break
            time.sleep(0.005)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    _, status = os.waitpid(pid, 0)
    return status, late


def run_one(c, root, paths, texts, mods, lib, deadline):
    """One candidate's outcome: ('captured', from, line, text) or (why,)."""
    if time.monotonic() >= deadline:
        return ('timeout',)
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        child(c, root, paths, texts, mods, lib, w)
        os._exit(EXIT_CHILD_SETUP)
    RUNNING[0] = pid
    os.close(w)
    buf = bytearray()
    timed_out = False
    over = False
    try:
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                timed_out = True
                break
            if not select.select([r], [], [], left)[0]:
                continue
            chunk = os.read(r, 65536)
            if not chunk:
                break
            buf += chunk
            if len(buf) > MAX_TEXT_BYTES + 9:
                over = True
                break
    finally:
        os.close(r)
    status, late = reap(pid, deadline, timed_out or over)
    RUNNING[0] = 0
    if timed_out or late:
        return ('timeout',)
    if over:
        return ('over_cap',)
    if not buf:
        if os.WIFEXITED(status) and os.WEXITSTATUS(status) != EXIT_CHILD_SETUP:
            return ('no_build',)
        return ('failed',)
    kind = buf[0]
    if kind == ord('R'):
        why = bytes(buf[1:])
        try:
            why = why.decode('ascii')
        except UnicodeDecodeError:
            return ('failed',)
        if why == 'no_build' or why == 'not_text' or why == 'over_cap' or why in REFUSALS:
            return (why,)
        return ('failed',)
    if kind == ord('C') and len(buf) > 9:
        j = int.from_bytes(buf[1:5], 'big')
        line = int.from_bytes(buf[5:9], 'big')
        text = bytes(buf[9:])
        if j >= len(paths) or line > MAX_LINE or len(text) > MAX_TEXT_BYTES:
            return ('failed',)
        try:
            if '\x00' in text.decode('utf-8'):
                return ('failed',)
        except UnicodeDecodeError:
            return ('failed',)
        return ('captured', j, line, text)
    return ('failed',)


def main():
    t0 = time.monotonic()
    signal.signal(signal.SIGALRM, out_of_time)
    signal.setitimer(signal.ITIMER_REAL, (SCRIPT_MS + GRACE_MS) / 1000.0)
    got = read_input()
    if got is None:
        os._exit(EXIT_BAD_INPUT)
    paths, texts, cands = got
    try:
        root = lay_out(paths, texts)
    except OSError:
        os._exit(EXIT_BAD_INPUT)
    lib = stdlib_dir()
    mods = entry_modules(paths)
    end = t0 + (SCRIPT_MS - GRACE_MS) / 1000.0
    results = []
    for k, c in enumerate(cands):
        share = (end - time.monotonic()) / (len(cands) - k)
        results.append(run_one(c, root, paths, texts, mods, lib, time.monotonic() + max(share, 0.0)))
    files = []
    body = []
    for c, res in zip(cands, results):
        if res[0] == 'captured':
            _, j, line, text = res
            files.append({'i': c, 'from': j, 'line': line, 'utf8_len': len(text), 'sha256': hashlib.sha256(text).hexdigest()})
            body.append(text)
        else:
            files.append({'i': c, 'why': res[0]})
    head = json.dumps({'v': WIRE_VERSION, 'python': platform.python_version(), 'files': files}, separators=(',', ':')).encode('ascii')
    if len(head) > HEAD_MAX_BYTES:
        os._exit(EXIT_HEAD_TOO_LARGE)
    signal.setitimer(signal.ITIMER_REAL, 0)
    out = sys.stdout.buffer
    out.write(head + b'\n')
    for text in body:
        out.write(text)
    out.flush()


main()
`;
