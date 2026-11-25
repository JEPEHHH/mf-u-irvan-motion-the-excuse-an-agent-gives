// patch/v1's entry: a `git diff` the entrant wrote, held as patch.diff at the root of the entry's
// source bundle (PATCH_DIFF_FILE). parsePatch reads it on the host before any container runs, so a
// patch a pack may not take is refused by name (contracts/patch.ts PATCH_REFUSALS) and never applied;
// the house runner (grader/patch/runner/run.sh) then applies an accepted one with a strict `git apply`.
// Intake runs the same parse for early feedback (server/pipeline/snapshot.ts); the grader re-checks.
//
// The format taken is git's own, what upstream receives: each file opens with
// `diff --git a/<old> b/<new>`, then git's extended header lines (old/new mode, new/deleted file
// mode, rename from/to, similarity index, index), then either nothing (a mode change, an empty file,
// a pure rename) or `--- a/<old>` / `+++ b/<new>` and one or more `@@ -l,s +l,s @@` hunks whose line
// counts match their header. A name git quoted (C-style, octal bytes) is decoded; the TAB git writes
// after a ---/+++ name holding a space is dropped. A name on any header line holding a control
// character (U+0000-U+001F, U+007F) written raw is `unsafe_path`: git diff escapes one, and git apply
// ends an unquoted name at a TAB or a CR (apply.c find_name), so it would patch another path
// (pytest.ini, for "pytest.ini\r") than the one checked here; so is a NUL however written (git's names
// are C strings). One escaped in a quoted name git reads back exactly: it stands. Anything else is
// `malformed`: text before the first `diff --git` line or after a hunk (a commit message, a
// format-patch signature), a diff written with --no-prefix (run.sh applies with -p1), CRLF line
// endings, a copy (git diff -C), a hunk whose lines do not add up to its header, a path two files claim.
//
// The refusals, in the order a file is checked (the first file refused names the patch's refusal):
//
//   too_large        more than maxBytes (the harness's max_patch_bytes), checked before anything else
//   not_utf8         not UTF-8
//   empty            nothing but whitespace
//   malformed        not git's diff format, as above
//   binary           a `GIT binary patch` or `Binary files ... differ`
//   mode             any mode but 100644 and 100755: a symlink (120000), a submodule (160000), a tree
//   unsafe_path      a path patchPathIssue refuses (absolute, `..`, `.`, empty segment, `.git`, too
//                    long, a lone surrogate) or holding a `.makefun` segment, a quoted name that is
//                    not UTF-8, or a name holding a raw control character or a NUL (checked as each
//                    line is read)
//   protected_path   an old or new path matching protected_paths (matchesProtected): the ratified
//                    tests', which the runner overlays after the patch in any case
//
// A detail names a path of the entrant's own patch and the rule, never a test id. Pure: no fs, no git.
//
// patchNumstat says what `git apply --numstat -z -p1` prints of an accepted patch, forward and with -R:
// run.sh holds git to it before it applies anything, so a path git reads otherwise than this parser
// did refuses the run (unsafe_path) rather than reaching the tree.

import { matchesProtected, patchPathIssue, type PatchRefusalT } from '../../contracts/patch.ts';

/** The entry file: a source bundle's root carries it (bundle:<root>). */
export const PATCH_DIFF_FILE = 'patch.diff';

/** The modes a patched file may carry: a regular file, executable or not. */
export const PATCH_FILE_MODES = ['100644', '100755'] as const;
export type PatchFileMode = (typeof PATCH_FILE_MODES)[number];

export const PATCH_FILE_OPS = ['add', 'modify', 'delete', 'rename'] as const;
export type PatchFileOp = (typeof PATCH_FILE_OPS)[number];

/** One file a patch touches. */
export interface PatchFile {
  op: PatchFileOp;
  /** The repo-relative path before the patch (git's a/ dropped); null for an add. */
  old: string | null;
  /** The repo-relative path after the patch (git's b/ dropped); null for a delete. */
  new: string | null;
  /**
   * The file's mode after the patch; null for a delete, or when the diff names none: a pure rename, or a
   * hand-written diff with no `index` line, which git apply then applies to whatever type the tree
   * holds there (a symlink's target text included), so only the tree can say it is a regular file.
   */
  mode: PatchFileMode | null;
}

/** What parsePatch refuses: every refusal but the two only a grading run reaches (missing, apply_failed). */
export type PatchParseRefusal = Exclude<PatchRefusalT, 'missing' | 'apply_failed'>;

export type PatchParse = { ok: true; files: PatchFile[] } | { ok: false; refused: PatchParseRefusal; detail: string };

export interface ParsePatchOptions {
  /** The harness's max_patch_bytes. */
  maxBytes: number;
  /** The harness's protected_paths globs. */
  protectedPaths: readonly string[];
}

const DIFF_GIT = 'diff --git ';
const DEV_NULL = '/dev/null';
const MODE_RE = /^[0-7]{6}$/;
const INDEX_RE = /^index [0-9a-f]{4,64}\.\.[0-9a-f]{4,64}(?: ([0-7]{6}))?$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const SIMILARITY_RE = /^(?:dis)?similarity index \d{1,3}%$/;

/** What a mode git writes stands for, for a `mode` refusal's detail. */
const MODE_KINDS: Record<string, string> = { '120000': 'a symlink', '160000': 'a submodule', '040000': 'a directory' };

class Refused extends Error {
  readonly refused: PatchParseRefusal;
  readonly detail: string;
  constructor(refused: PatchParseRefusal, detail: string) {
    super(detail);
    this.refused = refused;
    this.detail = detail;
  }
}

function refuse(refused: PatchParseRefusal, detail: string): never {
  throw new Refused(refused, detail);
}

function malformed(line: number, why: string): never {
  return refuse('malformed', `line ${line}: ${why}`);
}

/** A path for a detail: JSON-quoted, so a space or a control character reads unambiguously; clipped. */
function shown(p: string): string {
  return JSON.stringify(p.length > 200 ? `${p.slice(0, 200)}…` : p);
}

/** git's C-style quoting (quote_c_style): the escapes it writes, and octal for any other byte. */
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * The quoted name opening at s[start] (a `"`): its decoded text and the index just past its closing
 * quote, or null when no well-formed quoted name opens there.
 */
function readQuoted(s: string, start: number, line: number): { text: string; end: number } | null {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  let i = start + 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
      } catch {
        return refuse('unsafe_path', `line ${line}: a quoted path is not UTF-8`);
      }
      return { text, end: i + 1 };
    }
    if (c === '\\') {
      const e = s[i + 1];
      if (e === undefined) return null;
      if (e in C_ESCAPES) {
        bytes.push(C_ESCAPES[e]!);
        i += 2;
      } else if (/^[0-3][0-7]{2}$/.test(s.slice(i + 1, i + 4))) {
        bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
        i += 4;
      } else {
        return null;
      }
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    for (const b of enc.encode(ch)) bytes.push(b);
    i += ch.length;
  }
  return null;
}

/**
 * The name `name` (decoded, when quoted), written on its line as `written` (a quoted one with its quotes),
 * refused `unsafe_path` where git apply would read another path: a control character (U+0000-U+001F,
 * U+007F) written raw (git diff escapes one, and git apply ends an unquoted name at a TAB or a CR), or a
 * NUL however written (git's names are C strings, cut there). A control character escaped in a quoted name
 * (`\t`, `\r`, `\177` ...) git apply reads back exactly, so it stands, held to protected_paths like any.
 */
function heldName(written: string, name: string, line: number): string {
  for (const ch of written) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) {
      refuse('unsafe_path', `line ${line}: ${shown(written)} holds a control character (${codeOf(c)}) written raw: git diff escapes one in a quoted name, and git apply ends an unquoted name at a TAB or a CR`);
    }
  }
  if (name.includes('\0')) refuse('unsafe_path', `line ${line}: ${shown(name)} holds a NUL (U+0000), where git apply's name ends`);
  return name;
}

/** A code point as a detail names it: U+000D. */
function codeOf(c: number): string {
  return `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** A name standing alone (a ---/+++ or rename line's): quoted whole, or raw (heldName). */
function readName(s: string, line: number): string {
  if (!s.startsWith('"')) return heldName(s, s, line);
  const q = readQuoted(s, 0, line);
  if (q === null || q.end !== s.length) return malformed(line, 'a quoted path is not closed where the line ends');
  return heldName(s, q.text, line);
}

/** Drop git's a/ or b/ prefix from a name; a name without it is a --no-prefix diff, which -p1 misreads. */
function unprefixed(name: string, prefix: 'a/' | 'b/', line: number): string {
  if (!name.startsWith(prefix)) return malformed(line, `a path without git's ${prefix} prefix: write the diff with git's default prefixes (run.sh applies with -p1)`);
  return name.slice(prefix.length);
}

/** A ---/+++ line's name: /dev/null, or a prefixed path (git's TAB after a name holding a space dropped). */
function sideName(rest: string, prefix: 'a/' | 'b/', line: number): string | typeof DEV_NULL {
  const raw = rest.endsWith('\t') ? rest.slice(0, -1) : rest;
  if (raw === DEV_NULL) return DEV_NULL;
  return unprefixed(readName(raw, line), prefix, line);
}

/**
 * The two names on a `diff --git` line, prefixes dropped, each held (heldName; an unquoted line holding a
 * control character is refused whole). Unquoted names holding spaces are ambiguous where they differ (a
 * rename): then both are null and the rename or ---/+++ lines name the files.
 */
function headerNames(rest: string, line: number): { old: string | null; new: string | null } {
  let first: string;
  let second: string;
  if (rest.startsWith('"')) {
    const q = readQuoted(rest, 0, line);
    if (q === null || rest[q.end] !== ' ') return malformed(line, 'a `diff --git` line whose first path is not quoted well');
    first = heldName(rest.slice(0, q.end), q.text, line);
    second = readName(rest.slice(q.end + 1), line);
  } else if (rest.endsWith('"')) {
    let split = -1;
    let text = '';
    for (let at = rest.indexOf(' "'); at !== -1; at = rest.indexOf(' "', at + 1)) {
      const q = readQuoted(rest, at + 1, line);
      if (q !== null && q.end === rest.length) {
        split = at;
        text = q.text;
        break;
      }
    }
    if (split === -1) return malformed(line, 'a `diff --git` line whose second path is not quoted well');
    first = heldName(rest.slice(0, split), rest.slice(0, split), line);
    second = heldName(rest.slice(split + 1), text, line);
  } else {
    heldName(rest, rest, line);
    if (!rest.startsWith('a/')) return malformed(line, "a path without git's a/ prefix: write the diff with git's default prefixes (run.sh applies with -p1)");
    const half = (rest.length - 5) / 2;
    if (Number.isInteger(half) && half > 0 && rest.slice(2 + half) === ` b/${rest.slice(2, 2 + half)}`) {
      first = rest.slice(0, 2 + half);
      second = rest.slice(3 + half);
    } else {
      const at = rest.indexOf(' b/');
      if (at === -1) return malformed(line, "a `diff --git` line without git's b/ path");
      if (rest.indexOf(' b/', at + 1) !== -1) return { old: null, new: null };
      first = rest.slice(0, at);
      second = rest.slice(at + 1);
    }
  }
  return { old: unprefixed(first, 'a/', line), new: unprefixed(second, 'b/', line) };
}

/** Why a path may not be patched (unsafe_path), or null. */
function pathIssue(p: string): string | null {
  const why = patchPathIssue(p);
  if (why !== null) return why;
  if (p.split('/').some((seg) => seg.toLowerCase() === '.makefun')) return 'holds a `.makefun` segment';
  return null;
}

/**
 * Read a git diff (the header): every file it touches, or why it is refused. Nothing is applied and
 * nothing is read but `bytes`.
 */
export function parsePatch(bytes: Uint8Array, opts: ParsePatchOptions): PatchParse {
  try {
    return { ok: true, files: parse(bytes, opts).map((f) => f.file) };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, refused: err.refused, detail: err.detail };
    throw err;
  }
}

/**
 * What `git apply --numstat -z -p1` prints of the patch `bytes` (one parsePatch accepts), and what it prints
 * with -R: one `<added>\t<deleted>\t<path>\0` record per file, its hunks' `+` and `-` lines and its new path
 * (its old, for a delete), in the patch's order; under -R the files in reverse order, each its old path (its
 * new, for an add) and the counts swapped. git names only one path of a file there, so the two together
 * name both of a rename's. run.sh holds git to them before it applies anything (the header). Throws on a
 * patch parsePatch refuses.
 */
export function patchNumstat(bytes: Uint8Array, opts: ParsePatchOptions): { forward: Uint8Array; reverse: Uint8Array } {
  let parsed: ParsedFile[];
  try {
    parsed = parse(bytes, opts);
  } catch (err) {
    if (err instanceof Refused) throw new RangeError(`patchNumstat of a patch parsePatch refuses (${err.refused}: ${err.detail})`);
    throw err;
  }
  const record = (added: number, deleted: number, path: string): string => `${added}\t${deleted}\t${path}\0`;
  const forward = parsed.map((f) => record(f.added, f.deleted, (f.file.new ?? f.file.old)!));
  const reverse = parsed.map((f) => record(f.deleted, f.added, (f.file.old ?? f.file.new)!)).reverse();
  const enc = new TextEncoder();
  return { forward: enc.encode(forward.join('')), reverse: enc.encode(reverse.join('')) };
}

/** A file as parse reads it: what it is, and its hunks' `+` and `-` lines (what git apply --numstat counts). */
interface ParsedFile {
  file: PatchFile;
  added: number;
  deleted: number;
}

function parse(bytes: Uint8Array, opts: ParsePatchOptions): ParsedFile[] {
  if (bytes.byteLength > opts.maxBytes) refuse('too_large', `the patch is ${bytes.byteLength} bytes; the cap is ${opts.maxBytes} (max_patch_bytes)`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse('not_utf8', 'the patch is not UTF-8');
  }
  if (text.trim() === '') refuse('empty', 'the patch holds no change');

  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const files: ParsedFile[] = [];
  const olds = new Set<string>();
  const news = new Set<string>();
  let i = 0;

  const claim = (seen: Set<string>, p: string | null, line: number): void => {
    if (p === null) return;
    if (seen.has(p)) malformed(line, `${shown(p)} is patched twice`);
    seen.add(p);
  };

  while (i < lines.length) {
    const at = i + 1;
    const head = lines[i]!;
    // Blank lines an editor left after the last file carry nothing.
    if (head === '' && i > 0 && lines.slice(i).every((l) => l === '')) break;
    if (!head.startsWith(DIFF_GIT)) {
      malformed(at, i === 0 ? 'a patch opens with a `diff --git` line (git diff\'s format)' : 'expected a `diff --git` line: a patch holds only file diffs');
    }
    if (head.endsWith('\r')) malformed(at, 'a CRLF line ending: git diff writes LF');
    const names = headerNames(head.slice(DIFF_GIT.length), at);
    i++;

    // git's extended header lines.
    const modes: { mode: string; line: number }[] = [];
    let oldMode: string | undefined;
    let newMode: string | undefined;
    let newFileMode: string | undefined;
    let deletedMode: string | undefined;
    let indexMode: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    const modeOf = (s: string, line: number): string => {
      if (!MODE_RE.test(s)) malformed(line, 'a mode that is not six octal digits');
      modes.push({ mode: s, line });
      return s;
    };
    while (i < lines.length) {
      const l = lines[i]!;
      const ln = i + 1;
      if (l.startsWith(DIFF_GIT) || l.startsWith('--- ') || l.startsWith('@@') || l === 'GIT binary patch' || l.startsWith('Binary files ')) break;
      // Blank lines an editor left after a last file with no hunk (a mode change, an empty add, a pure rename).
      if (l === '' && lines.slice(i).every((x) => x === '')) break;
      if (l.startsWith('old mode ')) oldMode = modeOf(l.slice(9), ln);
      else if (l.startsWith('new mode ')) newMode = modeOf(l.slice(9), ln);
      else if (l.startsWith('new file mode ')) newFileMode = modeOf(l.slice(14), ln);
      else if (l.startsWith('deleted file mode ')) deletedMode = modeOf(l.slice(18), ln);
      else if (l.startsWith('rename from ')) renameFrom = readName(l.slice(12), ln);
      else if (l.startsWith('rename to ')) renameTo = readName(l.slice(10), ln);
      else if (l.startsWith('copy from ') || l.startsWith('copy to ')) malformed(ln, 'a copy (git diff -C) is not taken: write the diff without -C');
      else if (SIMILARITY_RE.test(l)) {
        // A rename's similarity: nothing to keep.
      } else {
        const m = INDEX_RE.exec(l);
        if (m === null) malformed(ln, 'not one of git diff\'s header lines');
        if (m[1] !== undefined) indexMode = modeOf(m[1], ln);
      }
      i++;
    }
    if ((renameFrom === undefined) !== (renameTo === undefined)) malformed(at, 'a rename names only one of its paths');

    // The body: binary, nothing, or ---/+++ and hunks.
    const body = lines[i];
    let minus: string | undefined;
    let plus: string | undefined;
    let hunks = 0;
    let added = 0;
    let deleted = 0;
    if (body !== undefined && (body === 'GIT binary patch' || body.startsWith('Binary files '))) {
      const p = renameTo ?? names.new ?? renameFrom ?? names.old;
      refuse('binary', `${p === null ? 'a file' : shown(p)}: a binary diff (a patch/v1 patch is text only)`);
    }
    if (body !== undefined && body.startsWith('--- ')) {
      minus = sideName(body.slice(4), 'a/', i + 1);
      i++;
      const p = lines[i];
      if (p === undefined || !p.startsWith('+++ ')) malformed(i + 1, 'a `---` line with no `+++` line after it');
      plus = sideName(p.slice(4), 'b/', i + 1);
      i++;
      while (i < lines.length && lines[i]!.startsWith('@@')) {
        const h = readHunk(lines, i, { add: minus === DEV_NULL, del: plus === DEV_NULL });
        i = h.next;
        added += h.added;
        deleted += h.deleted;
        hunks++;
      }
      if (hunks === 0) malformed(i + 1, 'a `---`/`+++` pair with no hunk after it');
    } else if (body !== undefined && body.startsWith('@@')) {
      malformed(i + 1, 'a hunk with no `---`/`+++` lines before it');
    }

    // What the file is.
    const isAdd = newFileMode !== undefined || minus === DEV_NULL;
    const isDelete = deletedMode !== undefined || plus === DEV_NULL;
    if (isAdd && isDelete) malformed(at, 'a file both added and deleted');
    if (newFileMode !== undefined && minus !== undefined && minus !== DEV_NULL) malformed(at, 'a new file whose `---` line names an old one');
    if (deletedMode !== undefined && plus !== undefined && plus !== DEV_NULL) malformed(at, 'a deleted file whose `+++` line names a new one');
    if (minus === DEV_NULL && newFileMode === undefined) malformed(at, 'an added file with no `new file mode` line');
    if (plus === DEV_NULL && deletedMode === undefined) malformed(at, 'a deleted file with no `deleted file mode` line');
    if ((isAdd || isDelete) && renameFrom !== undefined) malformed(at, 'a rename that also adds or deletes');

    const side = (v: string | undefined): string | undefined => (v === DEV_NULL ? undefined : v);
    const old = isAdd ? null : (renameFrom ?? side(minus) ?? names.old);
    const neu = isDelete ? null : (renameTo ?? side(plus) ?? names.new);
    if (!isAdd && old === null) malformed(at, 'a file diff that names no old path');
    if (!isDelete && neu === null) malformed(at, 'a file diff that names no new path');
    if (names.old !== null && old !== null && names.old !== old) malformed(at, 'the `diff --git` line and the lines under it name different old paths');
    if (names.new !== null && neu !== null && names.new !== neu) malformed(at, 'the `diff --git` line and the lines under it name different new paths');
    // A rename's paths are its rename lines'; git apply refuses ---/+++ lines naming others.
    if (side(minus) !== undefined && side(minus) !== old) malformed(at, 'the `---` line and the `rename from` line name different old paths');
    if (side(plus) !== undefined && side(plus) !== neu) malformed(at, 'the `+++` line and the `rename to` line name different new paths');
    const op: PatchFileOp = isAdd ? 'add' : isDelete ? 'delete' : renameFrom !== undefined ? 'rename' : 'modify';
    if (op === 'rename' && old === neu) malformed(at, 'a rename to its own path');
    if (op === 'modify' && old !== neu) malformed(at, 'a file whose old and new paths differ with no `rename` lines');
    if (op === 'modify' && hunks === 0 && newMode === undefined) malformed(at, 'a file diff that changes nothing');
    if ((oldMode === undefined) !== (newMode === undefined)) malformed(at, 'a mode change names only one of its modes');

    const named = (neu ?? old)!;
    for (const m of modes) {
      if (!(PATCH_FILE_MODES as readonly string[]).includes(m.mode)) {
        const kind = MODE_KINDS[m.mode];
        refuse('mode', `${shown(named)}: mode ${m.mode}${kind === undefined ? '' : ` (${kind})`}; a patched file is a regular file, 100644 or 100755`);
      }
    }
    for (const p of [old, neu]) {
      if (p === null) continue;
      const why = pathIssue(p);
      if (why !== null) refuse('unsafe_path', `${shown(p)} ${why}`);
    }
    for (const p of [old, neu]) {
      if (p !== null && matchesProtected(p, opts.protectedPaths)) {
        refuse('protected_path', `${shown(p)} is a protected path (protected_paths: the ratified tests'); a patch may not touch it`);
      }
    }
    claim(olds, old, at);
    claim(news, neu, at);
    const mode = isDelete ? null : ((newFileMode ?? newMode ?? indexMode ?? null) as PatchFileMode | null);
    files.push({ file: { op, old, new: neu, mode }, added, deleted });
  }
  return files;
}

/**
 * Read the hunk whose header is lines[i]: the index of the line after it, and its `+` and `-` lines. Its
 * lines must add up to the header's counts exactly (an empty line is an empty context line, as git apply
 * reads one; a `\` line marks the line before it as ending with no newline and counts toward neither side).
 */
function readHunk(lines: readonly string[], i: number, kind: { add: boolean; del: boolean }): { next: number; added: number; deleted: number } {
  const at = i + 1;
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) return malformed(at, 'a hunk header that is not `@@ -l,s +l,s @@`');
  let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
  let newLeft = m[4] === undefined ? 1 : Number(m[4]);
  if (kind.add && (m[1] !== '0' || oldLeft !== 0)) malformed(at, 'an added file\'s hunk must start `@@ -0,0`');
  if (kind.del && (m[3] !== '0' || newLeft !== 0)) malformed(at, 'a deleted file\'s hunk must read `+0,0 @@`');
  if (oldLeft === 0 && newLeft === 0) malformed(at, 'a hunk that counts no line');
  i++;
  let prevContent = false;
  let added = 0;
  let deleted = 0;
  while (oldLeft > 0 || newLeft > 0) {
    const l = lines[i];
    if (l === undefined) return malformed(at, 'the patch ends inside a hunk: its lines fall short of its header');
    const c = l === '' ? ' ' : l[0]!;
    if (c === ' ') {
      if (oldLeft === 0 || newLeft === 0) malformed(i + 1, 'a hunk holds more lines than its header counts');
      oldLeft--;
      newLeft--;
      prevContent = true;
    } else if (c === '-') {
      if (oldLeft === 0) malformed(i + 1, 'a hunk removes more lines than its header counts');
      oldLeft--;
      deleted++;
      prevContent = true;
    } else if (c === '+') {
      if (newLeft === 0) malformed(i + 1, 'a hunk adds more lines than its header counts');
      newLeft--;
      added++;
      prevContent = true;
    } else if (c === '\\') {
      if (!prevContent) malformed(i + 1, 'a `\\ No newline` marker with no line before it');
      prevContent = false;
    } else {
      malformed(i + 1, 'a hunk\'s lines fall short of its header');
    }
    i++;
  }
  if (prevContent && lines[i]?.startsWith('\\')) i++;
  const next = lines[i];
  const trailingBlanks = (): boolean => lines.slice(i).every((l) => l === '');
  if (next !== undefined && !next.startsWith('@@') && !next.startsWith(DIFF_GIT) && !trailingBlanks()) malformed(i + 1, 'a hunk holds more lines than its header counts');
  return { next: i, added, deleted };
}
