// What a run stamps on itself so a regrade can tell whether it is re-deriving with the same code:
//
//   harness_version   `harness@<sha256> node <process.version>`: the source digest of the harness's code (every
//                     .ts/.json/.sh file under grader/, sim/, contracts/ and pricing/: the .sh one is
//                     grader/patch/runner/run.sh, the house runner a patch/v1 run's tests run under;
//                     plus server/repos/index-tar.ts, which materializes the /bot mount, and
//                     server/blobstore.ts, the layout the cassette and every run's blobs are kept in),
//                     and the Node version the harness runs on. L2 re-executes under a different one
//                     all the same, and reproduces only on equality, flagged harness_moved; anything
//                     else there is inconclusive (grader/regrade.ts underMovedHarness).
//                     HARNESS_SOURCES holds every file the gateway forwarder's bundle
//                     may inline (grader/gateway/bundle.ts GATEWAY_BUNDLE_SOURCES), so a change to the
//                     pricing tables the forwarder meters with or to the blob layout it records into
//                     names a new harness.
//   scorer_version    `scorer@<sha256>`: the source digest of the scoring code (sim/, contracts/ and the
//                     grader's score, cost, metered, program-scores, agent-score and size modules, and
//                     patch/v1's score and the run log it reads, grader/patch/score.ts and junit.ts: a
//                     change to how a program/v1 size count counts an entry's code names a new scorer,
//                     as a change to how its cost is priced, or a build meter's cost matched and
//                     summed, does). A program/v1 run
//                     appends ` program@<sha256>` of the competition's scorer directory, an agent/v1
//                     run the same of its sealed one (scorer_sha256). An L1 regrade is
//                     byte-identical under the same scorer_version: the rebuilt score carries it. One
//                     whose `scorer@` digest alone moved still reproduces, its result kept with the
//                     run's stamp and flagged scorer_moved (grader/regrade.ts scorerMovedOf).
//
// A source digest is sha256 over the lines `<path>\0<sum>\n`, paths relative to the project root in
// code-unit order, so it is independent of the filesystem's listing order. Digests are computed once
// per process (the files do not change under a running grader).
//
// The sums of the two versions' sources (HARNESS_SOURCES, SCORER_SOURCES) are over code (codeSha256):
// a .ts file's is the sha256 of its text with its comments and the whitespace between its tokens
// dropped (tsCode), a .json or .sh file's the sha256 of its bytes. So an edit that changes no token of any
// file (a comment written or reworded, a line re-indented, a blank line) names no new harness and no
// new scorer, and every run graded before it still regrades: its L2 under the same harness_version,
// its L1 to the same bytes, scorer_version and all. Any change to a token names a new one, as before.
// (#2700, 0ce1f044, only added comment lines to contracts/bars-dataset.ts; summed over bytes, that
// moved both versions and refused every earlier run's L2 and failed its L1 at $.scorer_version.)
// Any other entries, a bundle's sources (grader/gateway/bundle.ts, grader/scrape/bundle.ts), are summed
// over their bytes: esbuild carries some comments into what it builds (a block comment before an
// argument or a returned value, a legal comment), so a digest naming a built bundle must see them.
//
// What tsCode keeps of a file: every token as written (a string, template or regular expression
// literal whole, the whitespace inside it and all), the comments a tool reads as code (TOOL_COMMENT:
// esbuild's `@__PURE__`-style annotations, which let it drop a call from a bundle, the legal comments
// it carries into one, a source map reference), and between two tokens a line break where what lay
// between them held one (automatic semicolon insertion reads it), else one space where the two would
// otherwise run together (two word characters, or two operator characters: `a - -b`, `x / /re/`),
// else nothing. Its tokenizer tells a regular expression from a division by what came before, as the
// grammar does; tests/unit/grader-version.test.ts holds it to TypeScript's own parser on every harness
// source. A file it cannot read (an unterminated literal or comment, an unbalanced bracket, bytes that
// are not UTF-8) is summed over its bytes.
//
// Runs graded before the sums were over code (by a tree whose grader/version.ts summed its sources over
// their bytes, before 96fd6d42) recorded digests over bytes. grader/version-history.json names every such
// digest with the code digest of the same sources, as this file sums them (codeVersionOf): its `scorer`
// and `harness` tables, each byte digest a grader on such a tree recorded mapped to its code digest,
// rebuilt from git (every commit reachable from its `anchor` whose grader/version.ts summed over bytes,
// each with that file's HARNESS_SOURCES and SCORER_SOURCES) by tests/unit/grader-version.test.ts, which
// holds the file to that rebuild and to the digests runs on dev recorded. A regrade takes such a run's
// scorer_version as its own when its code digest is this process's (grader/regrade.ts
// regradeScorerVersion), so a run graded by the same scorer code, comments and whitespace aside,
// reproduces at L1 whichever tree's bytes it recorded (the dev run 01a1a8f9 recorded scorer@73b19b5a…,
// the 3e2a4317 tree's bytes, whose code is 0ce1f044's and later trees': scorer@24955652…). L2 compares a
// run's harness_version exactly; the table's `harness` names what a moved byte digest is over code.
// The table is JSON imported here, so the kit's command line (server/kit/cli-bundle.ts) carries it.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCodeUnits } from '../sim/canonical.ts';
import versionHistory from './version-history.json' with { type: 'json' };

/** The project root (this file lives in <root>/grader/). */
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

export const HARNESS_SOURCES: readonly string[] = Object.freeze(['grader', 'sim', 'contracts', 'pricing', 'server/blobstore.ts', 'server/repos/index-tar.ts']);
export const SCORER_SOURCES: readonly string[] = Object.freeze(['sim', 'contracts', 'grader/score.ts', 'grader/cost.ts', 'grader/metered.ts', 'grader/program-scores.ts', 'grader/agent-score.ts', 'grader/size.ts', 'grader/patch/score.ts', 'grader/patch/junit.ts']);

/** No .sh file was ever under a source directory before run.sh, so every digest summed before it is the same with it. */
const SOURCE_EXT = /\.(ts|json|sh)$/;

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Every source file under `entries` (files or directories, relative to `root`), as sorted relative POSIX paths. */
export function sourceFiles(entries: readonly string[], root: string = PROJECT_ROOT): string[] {
  const out = new Set<string>();
  const walk = (abs: string): void => {
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        walk(join(abs, name));
      }
    } else if (st.isFile() && SOURCE_EXT.test(abs)) {
      out.add(relative(root, abs).split(sep).join('/'));
    }
  };
  for (const e of entries) walk(join(root, e));
  return [...out].sort(compareCodeUnits);
}

/** What a source digest sums each file over: its code (codeSha256) or its bytes. */
export type DigestOver = 'code' | 'bytes';

/**
 * sha256 over `<path>\0<sum>\n` for every file, in code-unit path order, each sum over `over`: by default its code for
 * HARNESS_SOURCES and SCORER_SOURCES themselves (harness_version's and scorer_version's: see the header), its bytes for
 * any other entries (a bundle's sources).
 */
export function sourceDigest(entries: readonly string[], root: string = PROJECT_ROOT, over: DigestOver = entries === HARNESS_SOURCES || entries === SCORER_SOURCES ? 'code' : 'bytes'): string {
  const h = createHash('sha256');
  for (const rel of sourceFiles(entries, root)) {
    const bytes = readFileSync(join(root, rel));
    h.update(`${rel}\0${over === 'code' ? codeSha256(rel, bytes) : sha256(bytes)}\n`);
  }
  return h.digest('hex');
}

/** The same digest over a directory's files (any extension, each over its bytes), paths relative to it: a program/v1 scorer. */
export function directoryDigest(dir: string): string {
  return digestOfSums(treeFileSums(dir));
}

/** directoryDigest, its walk and reads on fs/promises (the event loop is not held by the tree). */
export async function directoryDigestAsync(dir: string): Promise<string> {
  return digestOfSums(await treeFileSumsAsync(dir));
}

function digestOfSums(sums: TreeFileSum[]): string {
  sums.sort((a, b) => compareCodeUnits(a.path, b.path));
  const h = createHash('sha256');
  for (const f of sums) h.update(`${f.path}\0${f.sha256}\n`);
  return h.digest('hex');
}

// ---------------------------------------------------------------- a tree's file sums, once per process
//
// directoryDigest here, and grader/program.ts directoryManifest (with programDataSha256 and grader/agent.ts
// instanceSha256 over it), sum every regular file under a directory (a symbolic link followed, anything neither a file
// nor a directory skipped) by the sha256 of its bytes. A grade, a trial and the web's geo map digest the same trees on
// every job (an instance's thousands of files), so each file's sum is kept for the process by its absolute path and its
// stat fingerprint (device, inode, size, mtime and ctime: a write moves mtime and ctime, a chmod, a rename over it or a
// utimes moves ctime), and a tree walked again reads no file whose fingerprint held: only its listing and a stat each.
// A file is kept only when its stat after the read is the one before it (nothing wrote it meanwhile) and its mtime and
// ctime are RACY_MS older than the read (a write in the same timestamp tick as the read, after it, would otherwise keep
// the stale sum, as git's racy-index rule has it); so a tree written just before it is digested is read again next time.
// The memo holds FILE_SUMS_MAX files, the least recently summed dropped first. The async walk (treeFileSumsAsync) stats
// and reads on fs/promises, at most TREE_IO_CONCURRENCY at once, each file streamed into its hash in READ_CHUNK pieces.

/** One regular file of a tree: its path relative to the tree (POSIX separators), its size and the sha256 of its bytes. */
export interface TreeFileSum {
  path: string;
  size: number;
  sha256: string;
}

const FILE_SUMS_MAX = 100_000;
const RACY_MS = 1_000;
const TREE_IO_CONCURRENCY = 16;
const READ_CHUNK = 256 * 1024;

/** Every kept file sum, by absolute path, in least-recently-summed order. */
const fileSums = new Map<string, { key: string; size: number; sha256: string }>();
/** What the memo has done since the process started (or dropTreeFileSums): a test's and a probe's window on it. */
const memoCounts = { filesRead: 0, bytesRead: 0, hits: 0 };

/** Files read and their bytes, and files answered from the memo, since the process started (or dropTreeFileSums). */
export function treeFileSumCounts(): { filesRead: number; bytesRead: number; hits: number; kept: number } {
  return { ...memoCounts, kept: fileSums.size };
}

/** Forgets every kept file sum and zeroes the counts (a test's fresh start). */
export function dropTreeFileSums(): void {
  fileSums.clear();
  memoCounts.filesRead = 0;
  memoCounts.bytesRead = 0;
  memoCounts.hits = 0;
}

function statKey(st: Stats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

function keptSum(abs: string, key: string): { size: number; sha256: string } | null {
  const kept = fileSums.get(abs);
  if (kept === undefined || kept.key !== key) return null;
  memoCounts.hits++;
  // Most recently used last, so the oldest is the first to go.
  fileSums.delete(abs);
  fileSums.set(abs, kept);
  return { size: kept.size, sha256: kept.sha256 };
}

function keepSum(abs: string, before: Stats, after: Stats, readAt: number, size: number, sha256: string): void {
  memoCounts.filesRead++;
  memoCounts.bytesRead += size;
  const key = statKey(before);
  if (statKey(after) !== key || size !== before.size || readAt - Math.max(before.mtimeMs, before.ctimeMs) < RACY_MS) {
    fileSums.delete(abs);
    return;
  }
  fileSums.delete(abs);
  if (fileSums.size >= FILE_SUMS_MAX) fileSums.delete(fileSums.keys().next().value!);
  fileSums.set(abs, { key, size, sha256 });
}

function fileSumSync(abs: string, st: Stats): { size: number; sha256: string } {
  const kept = keptSum(abs, statKey(st));
  if (kept !== null) return kept;
  const readAt = Date.now();
  const bytes = readFileSync(abs);
  const sum = { size: bytes.length, sha256: sha256(bytes) };
  keepSum(abs, st, statSync(abs), readAt, sum.size, sum.sha256);
  return sum;
}

async function fileSumAsync(abs: string, st: Stats): Promise<{ size: number; sha256: string }> {
  const kept = keptSum(abs, statKey(st));
  if (kept !== null) return kept;
  const readAt = Date.now();
  const h = createHash('sha256');
  let size = 0;
  const fh = await open(abs, 'r');
  let after: Stats;
  try {
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(READ_CHUNK, st.size + 1)));
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead));
      size += bytesRead;
    }
    after = await fh.stat();
  } finally {
    await fh.close();
  }
  const sum = { size, sha256: h.digest('hex') };
  keepSum(abs, st, after, readAt, size, sum.sha256);
  return sum;
}

/** The regular files under `dir` (a symbolic link followed), each summed (kept sums reused), in walk order. */
export function treeFileSums(dir: string): TreeFileSum[] {
  const out: TreeFileSum[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) out.push({ path: r, ...fileSumSync(p, st) });
    }
  };
  walk(dir, '');
  return out;
}

/** treeFileSums on fs/promises: at most TREE_IO_CONCURRENCY stats and reads at once, each file streamed into its hash. */
export async function treeFileSumsAsync(dir: string): Promise<TreeFileSum[]> {
  const out: TreeFileSum[] = [];
  let active = 0;
  let failed = null as { err: unknown } | null;
  const waiting: Array<() => void> = [];
  const io = async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= TREE_IO_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    // A walk that has failed starts no more I/O (each waiter woken in turn): its first error is its answer.
    if (failed !== null) {
      waiting.shift()?.();
      throw failed.err;
    }
    active++;
    try {
      return await fn();
    } catch (err) {
      failed ??= { err };
      throw err;
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
  const walk = async (abs: string, rel: string): Promise<void> => {
    const names = await io(() => readdir(abs));
    await Promise.all(
      names.map(async (name) => {
        const p = join(abs, name);
        const r = rel === '' ? name : `${rel}/${name}`;
        const st = await io(() => stat(p));
        if (st.isDirectory()) await walk(p, r);
        else if (st.isFile()) out.push({ path: r, ...(await io(() => fileSumAsync(p, st))) });
      }),
    );
  };
  try {
    await walk(dir, '');
  } catch (err) {
    throw failed?.err ?? err;
  }
  return out;
}

/**
 * A sealed tree's digest as server/competitions/load.ts treeSha256 takes it, byte for byte, each file's sum from the kept
 * ones: sha256 over `<path>\0<sha256>\n` in code-unit order of every regular file under `path` (`path` a file: that file,
 * by its base name). Where treeSha256 throws its TreeDigestError this answers the same `rel` and `reason` as a value (a
 * path that cannot be lstat'd does not exist; a symbolic link or anything but a file or directory refuses the tree); a
 * listing or a read that fails throws its own error, as there.
 */
export function sealedTreeDigest(path: string): { sha256: string } | { rel: string; reason: string } {
  const files: Array<{ rel: string; abs: string; st: Stats }> = [];
  let issue = null as { rel: string; reason: string } | null;
  const kind = (abs: string, rel: string): Stats | null => {
    let st: Stats;
    try {
      st = lstatSync(abs);
    } catch {
      issue = { rel, reason: 'does not exist' };
      return null;
    }
    if (st.isSymbolicLink()) issue = { rel, reason: 'is a symbolic link' };
    else if (!st.isDirectory() && !st.isFile()) issue = { rel, reason: 'is not a regular file' };
    return issue === null ? st : null;
  };
  const walk = (abs: string, rel: string): boolean => {
    for (const name of readdirSync(abs)) {
      const childAbs = join(abs, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const st = kind(childAbs, childRel);
      if (st === null) return false;
      if (st.isDirectory()) {
        if (!walk(childAbs, childRel)) return false;
      } else files.push({ rel: childRel, abs: childAbs, st });
    }
    return true;
  };
  const top = kind(path, '');
  if (top === null) return issue!;
  if (top.isDirectory()) {
    if (!walk(path, '')) return issue!;
  } else files.push({ rel: basename(path), abs: path, st: top });
  files.sort((a, b) => compareCodeUnits(a.rel, b.rel));
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.rel}\0${fileSumSync(f.abs, f.st).sha256}\n`);
  return { sha256: h.digest('hex') };
}

/**
 * sealedTreeDigest off the event loop's back, the same answer: the same walk in the same order (so the same first `rel`
 * and `reason` it refuses on), every directory listed and path lstat'd on fs/promises, and each file's sum taken from
 * the kept ones or streamed into its hash (fileSumAsync), so a tree digested before reads no file. For a server
 * process's job (a grader's instance trees, checked every grade); the command line keeps sealedTreeDigest.
 */
export async function sealedTreeDigestAsync(path: string): Promise<{ sha256: string } | { rel: string; reason: string }> {
  const files: Array<{ rel: string; abs: string; st: Stats }> = [];
  let issue = null as { rel: string; reason: string } | null;
  const kind = async (abs: string, rel: string): Promise<Stats | null> => {
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch {
      issue = { rel, reason: 'does not exist' };
      return null;
    }
    if (st.isSymbolicLink()) issue = { rel, reason: 'is a symbolic link' };
    else if (!st.isDirectory() && !st.isFile()) issue = { rel, reason: 'is not a regular file' };
    return issue === null ? st : null;
  };
  const walk = async (abs: string, rel: string): Promise<boolean> => {
    for (const name of await readdir(abs)) {
      const childAbs = join(abs, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const st = await kind(childAbs, childRel);
      if (st === null) return false;
      if (st.isDirectory()) {
        if (!(await walk(childAbs, childRel))) return false;
      } else files.push({ rel: childRel, abs: childAbs, st });
    }
    return true;
  };
  const top = await kind(path, '');
  if (top === null) return issue!;
  if (top.isDirectory()) {
    if (!(await walk(path, ''))) return issue!;
  } else files.push({ rel: basename(path), abs: path, st: top });
  files.sort((a, b) => compareCodeUnits(a.rel, b.rel));
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.rel}\0${(await fileSumAsync(f.abs, f.st)).sha256}\n`);
  return { sha256: h.digest('hex') };
}

// ---------------------------------------------------------------- a .ts file's code

/**
 * The sum of a source file in a version's digest (the header): a .ts file's the sha256 of tsCode of its text, a .json
 * file's (and a .ts file tsCode cannot read, or whose bytes are not UTF-8) the sha256 of its bytes.
 */
export function codeSha256(rel: string, bytes: Uint8Array): string {
  if (!rel.endsWith('.ts')) return sha256(bytes);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) return sha256(bytes);
  try {
    return sha256(tsCode(text));
  } catch (err) {
    if (err instanceof SyntaxError) return sha256(bytes);
    throw err;
  }
}

/**
 * A comment a tool reads as code, which tsCode keeps (the header): a legal comment (`/*!`, `//!`, `@license`,
 * `@preserve`), an esbuild annotation (`@__PURE__`, `@__NO_SIDE_EFFECTS__`, `@__KEY__`, each also with `#`), a source map
 * reference (`//# sourceMappingURL=`).
 */
export const TOOL_COMMENT = /^\/[/*]!|[@#]__(?:PURE|NO_SIDE_EFFECTS|KEY)__|@(?:license|preserve)\b|^\/\/[#@]\s*source(?:Mapping)?URL=/;

/** Keywords after which a `/` starts a regular expression literal (an operand comes next), not a division. */
const OPERAND_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends', 'default']);
/** Keywords whose parenthesized head a statement follows: after its `)` a `/` starts a regular expression literal. */
const HEAD_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

/** ECMAScript LineTerminator. */
function isLineBreak(c: string): boolean {
  return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
}

const UNICODE_SPACE = /\p{Zs}/u;

/** ECMAScript WhiteSpace: tab, vertical tab, form feed, the byte order mark and every Zs space. */
function isSpace(c: string): boolean {
  if (c === ' ' || c === '\t' || c === '\v' || c === '\f') return true;
  return c >= '\u0080' && (c === '\ufeff' || UNICODE_SPACE.test(c));
}

/** ASCII punctuation that is never part of a word token (`#`, `$`, `_` and `\` are: private names, identifiers, escapes). */
const PUNCTUATION = new Set([...'{}()[];,<>+-*/%&|^!~?:=.@\'"`']);
/** Operator characters: two of them may run together into another operator (`+ +`, `/ /`, `< <`), or open a comment. */
const OPERATOR = new Set([...'+-*/%&|^!~<>=?:']);

function isWordChar(c: string): boolean {
  return !PUNCTUATION.has(c) && !isSpace(c) && !isLineBreak(c);
}

/** Whether two tokens, `left` ending and `right` starting with these characters, would run together without a space. */
function joins(left: string, right: string): boolean {
  const word = (c: string) => c === '.' || c === '@' || isWordChar(c);
  return (word(left) && word(right)) || (OPERATOR.has(left) && OPERATOR.has(right));
}

/** What tsCode drops of a text (whitespace and comments, as [start, end) runs) and the comments it keeps (TOOL_COMMENT). */
export interface TsTrivia {
  dropped: Array<[number, number]>;
  kept: Array<[number, number]>;
}

/**
 * The trivia of a TypeScript text (no JSX): every run of whitespace and comments between its tokens, which tsCode drops,
 * but a TOOL_COMMENT, which it keeps. A SyntaxError when the text does not read as tokens: an unterminated string,
 * template, regular expression or comment, a line break in a string or a regular expression, an unbalanced `(` or `{`.
 */
export function tsTrivia(text: string): TsTrivia {
  const n = text.length;
  const dropped: Array<[number, number]> = [];
  const kept: Array<[number, number]> = [];
  const drop = (from: number, to: number): void => {
    const last = dropped.at(-1);
    if (last !== undefined && last[1] === from) last[1] = to;
    else dropped.push([from, to]);
  };
  const lineEnd = (from: number): number => {
    let j = from;
    while (j < n && !isLineBreak(text[j]!)) j++;
    return j;
  };
  // Whether a `/` here starts a regular expression literal (an operand is expected), not a division.
  let operand = true;
  // The last token was `.` or `?.`: a word here is a property name, never a keyword.
  let member = false;
  // The last token, when it was a word (and no property name).
  let lastWord = '';
  // Per open `(`: whether it is an if/while/for/with head, after whose `)` a statement (an operand) starts.
  const parens: boolean[] = [];
  // Per open `{`: whether it opened a template's substitution (`${`), whose `}` resumes the template.
  const braces: boolean[] = [];
  const token = (expectOperand: boolean): void => {
    operand = expectOperand;
    member = false;
    lastWord = '';
  };
  /** Scan a template's text from `j` (after its backquote or a substitution's `}`) to its end or its next `${`. */
  const template = (from: number): number => {
    for (let j = from; j < n; j++) {
      const d = text[j]!;
      if (d === '\\') j++;
      else if (d === '`') {
        token(false);
        return j + 1;
      } else if (d === '$' && text[j + 1] === '{') {
        braces.push(true);
        token(true);
        return j + 2;
      }
    }
    throw new SyntaxError(`an unterminated template literal (from offset ${from})`);
  };

  let i = 0;
  // A hashbang line is code: kept as written.
  if (text.startsWith('#!')) i = lineEnd(0);
  while (i < n) {
    const c = text[i]!;
    if (isSpace(c) || isLineBreak(c)) {
      const from = i;
      while (i < n && (isSpace(text[i]!) || isLineBreak(text[i]!))) i++;
      drop(from, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = lineEnd(i);
      if (TOOL_COMMENT.test(text.slice(i, end))) kept.push([i, end]);
      else drop(i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) throw new SyntaxError(`an unterminated comment at offset ${i}`);
      if (TOOL_COMMENT.test(text.slice(i, close + 2))) kept.push([i, close + 2]);
      else drop(i, close + 2);
      i = close + 2;
      continue;
    }
    if (c === '/' && operand) {
      // A regular expression literal: to its closing `/` outside a class, then its flags.
      let j = i + 1;
      let inClass = false;
      for (;;) {
        const d = text[j];
        if (d === undefined || isLineBreak(d)) throw new SyntaxError(`an unterminated regular expression at offset ${i}`);
        if (d === '\\') j += 2;
        else {
          j++;
          if (inClass) inClass = d !== ']';
          else if (d === '[') inClass = true;
          else if (d === '/') break;
        }
      }
      while (j < n && isWordChar(text[j]!)) j++;
      i = j;
      token(false);
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        const d = text[j];
        if (d === undefined || d === '\n' || d === '\r') throw new SyntaxError(`an unterminated string at offset ${i}`);
        if (d === '\\') j += text[j + 1] === '\r' && text[j + 2] === '\n' ? 3 : 2;
        else if (d === c) break;
        else j++;
      }
      i = j + 1;
      token(false);
      continue;
    }
    if (c === '`') {
      i = template(i + 1);
      continue;
    }
    if (c === '{') {
      braces.push(false);
      i++;
      token(true);
      continue;
    }
    if (c === '}') {
      if (braces.length === 0) throw new SyntaxError(`an unbalanced } at offset ${i}`);
      if (braces.pop()!) {
        i = template(i + 1);
        continue;
      }
      // A block's end, after which a statement (an operand) may start.
      i++;
      token(true);
      continue;
    }
    if (c === '(') {
      parens.push(!member && HEAD_KEYWORDS.has(lastWord));
      i++;
      token(true);
      continue;
    }
    if (c === ')') {
      if (parens.length === 0) throw new SyntaxError(`an unbalanced ) at offset ${i}`);
      const head = parens.pop()!;
      i++;
      token(head);
      continue;
    }
    if (c === ']') {
      i++;
      token(false);
      continue;
    }
    if (isWordChar(c)) {
      const from = i;
      while (i < n && isWordChar(text[i]!)) i++;
      const word = text.slice(from, i);
      operand = !member && OPERAND_AFTER.has(word);
      lastWord = member ? '' : word;
      member = false;
      continue;
    }
    if ((c === '+' || c === '-') && text[i + 1] === c) {
      // `++` / `--`, postfix where an operand ended (a division may follow) and prefix where none did.
      i += 2;
      token(operand);
      continue;
    }
    if (c === '!' && !operand && text[i + 1] !== '=') {
      // After an operand a `!` is TypeScript's non-null assertion, which ends one too.
      i++;
      token(false);
      continue;
    }
    if (c === '.' || (c === '?' && text[i + 1] === '.' && !(text[i + 2]! >= '0' && text[i + 2]! <= '9'))) {
      i += c === '.' ? 1 : 2;
      token(false);
      member = true;
      continue;
    }
    i++;
    token(true);
  }
  if (parens.length > 0) throw new SyntaxError('an unbalanced (');
  if (braces.length > 0) throw new SyntaxError(braces.at(-1)! ? 'an unterminated template literal' : 'an unbalanced {');
  return { dropped, kept };
}

/**
 * The code of a TypeScript text (no JSX), what a version sums of a .ts file (the header): its text with every run of
 * whitespace and comments between tokens (tsTrivia's `dropped`) replaced by a line break when the run held one, else by
 * one space when the tokens on either side would run together, else by nothing; at the start and the end, by nothing.
 * Two texts whose code is the same differ only in their comments and the whitespace between their tokens. A SyntaxError
 * as tsTrivia's.
 */
export function tsCode(text: string): string {
  let out = '';
  let at = 0;
  for (const [from, to] of tsTrivia(text).dropped) {
    out += text.slice(at, from);
    if (from > 0 && to < text.length) {
      let lineBreak = false;
      for (let j = from; j < to && !lineBreak; j++) lineBreak = isLineBreak(text[j]!);
      if (lineBreak) out += '\n';
      else if (joins(text[from - 1]!, text[to]!)) out += ' ';
    }
    at = to;
  }
  return out + text.slice(at);
}

// ---------------------------------------------------------------- the versions

let harnessMemo: string | null = null;
let scorerMemo: string | null = null;

/** harness_version of this process: `harness@<source sha256> node <version>`. */
export function harnessVersion(): string {
  harnessMemo ??= `harness@${sourceDigest(HARNESS_SOURCES)} node ${process.version}`;
  return harnessMemo;
}

/** scorer_version of this process (`scorer@<sha256>`), with ` program@<sha256>` for a program/v1 scorer directory digest. */
export function scorerVersion(programScorerDigest: string | null = null): string {
  scorerMemo ??= `scorer@${sourceDigest(SCORER_SOURCES)}`;
  return programScorerDigest === null ? scorerMemo : `${scorerMemo} program@${programScorerDigest}`;
}

// ---------------------------------------------------------------- the digests recorded over bytes

/** grader/version-history.json's tables (the header): each byte digest a grader recorded, by version, to its code digest. */
const CODE_OF_BYTES: Readonly<Record<'harness' | 'scorer', ReadonlyMap<string, string>>> = Object.freeze({
  harness: new Map(Object.entries(versionHistory.harness)),
  scorer: new Map(Object.entries(versionHistory.scorer)),
});

const RECORDED_DIGEST = /^(harness|scorer)@([0-9a-f]{64})(?= |$)/;

/**
 * A harness_version or scorer_version a run recorded, over code: when its `harness@` or `scorer@` digest is one a
 * grader recorded before the sums were over code (a byte digest grader/version-history.json names: the header), that
 * digest replaced by the code digest of the same sources, the rest as it is (` node <version>`, a ` program@`, an
 * ` image@`). Null when the digest is none the table names: a version recorded over code (this process's included),
 * or no version at all.
 */
export function codeVersionOf(recorded: string): string | null {
  const m = RECORDED_DIGEST.exec(recorded);
  if (m === null) return null;
  const code = CODE_OF_BYTES[m[1] as 'harness' | 'scorer'].get(m[2]!);
  return code === undefined ? null : `${m[1]}@${code}${recorded.slice(m[0].length)}`;
}
