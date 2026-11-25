// patch/v1's test report and run log. The ratified test argv writes a JUnit XML report
// (PatchTest.report_path); parseJunit reads it on the host, and patchRunLog turns it into the run's
// action log: one status per ratified test id, never the ids themselves.
//
// The parser (parseJunit) is a house subset of XML 1.0, as no XML dependency is taken:
//
//   - at most MAX_JUNIT_BYTES of UTF-8 (a BOM dropped; a declared encoding other than UTF-8 or
//     US-ASCII refused), elements nested at most MAX_JUNIT_DEPTH deep, at most MAX_JUNIT_TESTCASES
//     testcase elements
//   - no DOCTYPE and no ENTITY declaration (refused as `doctype`, wherever one stands): no entity
//     is ever declared, so none expands
//   - references: the five XML predefines (&lt; &gt; &amp; &apos; &quot;) and numeric ones
//     (&#N; &#xH;); any other is refused as `entity`
//   - elements, attributes (quoted, unique per element, whitespace in a value read as a space, as
//     XML normalizes it), text, CDATA sections, comments and processing instructions; an XML
//     declaration only first
//   - any Unicode scalar value but U+0000, U+FFFE and U+FFFF, raw or referenced: lenient about the
//     C0 controls XML 1.0 refuses, which test output carried into a report (an ANSI escape in a
//     captured log) holds unescaped often enough
//
// Anything else is `malformed`. A refusal's detail names a line and a column, never a byte of the
// report: the entry's own code runs beside the hidden tests and could write their ids into it.
//
// The report (JunitReport): the root is <testsuites> or <testsuite>, and a <testcase> stands only
// directly in a <testsuite> or <testsuites> (suites may nest); anything else is `not_junit`. A
// testcase's id is `<classname>::<name>`, just `<name>` when it has no or an empty classname
// (contracts/patch.ts PatchTestId). One with no or an empty name names no test and is passed over
// (googletest writes a suite's SetUpTestSuite or TearDownTestSuite failure as one, beside the
// suite's own testcases), though it counts toward the cap. A testcase's status reads its direct children: a
// <failure> or an <error> fails it (F), a <skipped> skips it (S), and it passes (P) otherwise. A
// googletest testcase that did not run (status="notrun", or result="skipped" or "suppressed") is
// skipped too, as googletest writes a disabled test with neither child. An id that several
// testcases carry (pytest writes a teardown error as a second testcase of the same test) takes the
// worst of their statuses, F over S over P. Whether any testcase failed, one that names no test
// included, is kept beside them (failed): what the tests' exit status is held against.
//
// The run log (PatchRunLog, agent-fun/patch-run/v1) is {schema, applied, refused, statuses, exit_check?}:
// statuses holds one character per ratified id (ratifiedIds: fail_to_pass, pass_to_pass, then the
// canaries must_fail and must_pass, each in its lists.json order), P, F or S as the report has it
// and M when the report names it not (or there is no report). A patch that did not apply ran no
// tests: every status is M. exit_check (PatchExitCheck, score.ts patchExitCheck) is how the tests'
// exit status read against the whole report: consistent, or the way it was not (a signal ended them,
// exit 0 beside a failure, or a non-zero exit beside none). It is absent where there was nothing to
// hold the exit against (a patch that did not apply, no test ran, or no report was read and no signal
// ended the tests) and on a log written before the check, which scores as it did. It is a verdict,
// not the exit and the report's failure apart, so it reads the same while an unlisted test flakes
// and takes the exit with it. No id, no count of the report's other testcases and no timing, so
// grade-twice's byte compare (grader/grade.ts) holds while unlisted tests flake, and a stored log
// names no hidden test. grader/patch/score.ts scorePatch scores it.

import { z } from 'zod';
import { PATCH_LIST_MAX_IDS, PatchRefusal, type PatchListsT, type PatchRefusalT } from '../../contracts/patch.ts';

/** 64 MiB. */
export const MAX_JUNIT_BYTES = 64 * 1024 * 1024;
export const MAX_JUNIT_DEPTH = 64;
export const MAX_JUNIT_TESTCASES = 200_000;

/** Why parseJunit read no report (the header). */
export const JUNIT_REFUSALS = ['too_large', 'not_utf8', 'doctype', 'entity', 'malformed', 'too_deep', 'too_many_testcases', 'not_junit'] as const;
export type JunitRefusalT = (typeof JUNIT_REFUSALS)[number];

/** A testcase's status: passed, failed (a failure or an error) or skipped. */
export type JunitStatus = 'P' | 'F' | 'S';

export interface JunitReport {
  /** The testcase elements the report holds, repeats of an id included. */
  testcases: number;
  /** Some testcase failed (a failure or an error), one that names no test, or no ratified one, included. */
  failed: boolean;
  /** Each id's status: the worst of its testcases'. */
  statuses: ReadonlyMap<string, JunitStatus>;
}

export type JunitParse = { ok: true; report: JunitReport } | { ok: false; refused: JunitRefusalT; detail: string };

const RANK: Record<JunitStatus, number> = { P: 0, S: 1, F: 2 };

/** The worse of two statuses: F over S over P. */
export function worstStatus(a: JunitStatus, b: JunitStatus): JunitStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

class JunitRefused extends Error {
  readonly refused: JunitRefusalT;

  constructor(refused: JunitRefusalT, detail: string) {
    super(detail);
    this.name = 'JunitRefused';
    this.refused = refused;
  }
}

const PREDEFINED = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['apos', "'"],
  ['quot', '"'],
]);

/** XML 1.0's NameStartChar and NameChar. */
const NAME_START = ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_CHARS = `[${NAME_START}][${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*`;
const NAME = new RegExp(NAME_CHARS, 'uy');
const WHOLE_NAME = new RegExp(`^${NAME_CHARS}$`, 'u');

/** A raw character the document may not hold (the header). */
const BAD_CHAR = /[\u0000\uFFFE\uFFFF]/;
/** What attribute value normalization or a reference rewrites. */
const ATTR_SPECIAL = /[&\t\n\r]/;

const SUITES = new Set(['testsuites', 'testsuite']);
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** Whether a numeric reference's code point is one the document may hold. */
const referable = (cp: number): boolean => cp >= 1 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) && cp !== 0xfffe && cp !== 0xffff;

interface Testcase {
  /** null: the testcase has no name, so it names no test. */
  id: string | null;
  status: JunitStatus;
}

interface Frame {
  name: string;
  /** Set on a testcase's own frame: its id and the status its children read so far. */
  testcase: Testcase | null;
}

/** Read a JUnit XML report (the header); a refusal names why and where, never the report's text. */
export function parseJunit(bytes: Uint8Array): JunitParse {
  if (bytes.byteLength > MAX_JUNIT_BYTES) return { ok: false, refused: 'too_large', detail: `the report is ${bytes.byteLength} bytes, over ${MAX_JUNIT_BYTES}` };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, refused: 'not_utf8', detail: 'the report is not UTF-8' };
  }
  try {
    return { ok: true, report: readReport(text) };
  } catch (e) {
    if (e instanceof JunitRefused) return { ok: false, refused: e.refused, detail: e.message };
    throw e;
  }
}

function readReport(text: string): JunitReport {
  let pos = 0;
  const stack: Frame[] = [];
  const statuses = new Map<string, JunitStatus>();
  let testcases = 0;
  let failed = false;

  /** Where an offset is, as a line and a column: never the text there. */
  const where = (offset: number): string => {
    let line = 1;
    let start = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
      line++;
      start = i + 1;
    }
    return `line ${line}, column ${offset - start + 1}`;
  };
  function refuse(refused: JunitRefusalT, why: string, offset: number = pos): never {
    throw new JunitRefused(refused, `${why} (${where(offset)})`);
  }
  const at = (s: string, i: number = pos): boolean => text.startsWith(s, i);
  const skipSpace = (): boolean => {
    const from = pos;
    while (isSpace(text[pos])) pos++;
    return pos > from;
  };
  const readName = (what: string): string => {
    NAME.lastIndex = pos;
    const m = NAME.exec(text);
    if (m === null) return refuse('malformed', `expected ${what}`);
    pos = NAME.lastIndex;
    return m[0];
  };

  /** The reference at `i` (its `&`), closed before `limit`: the text it stands for, and where it ends. */
  const reference = (i: number, limit: number): [string, number] => {
    const end = text.indexOf(';', i + 1);
    if (end === -1 || end >= limit) return refuse('malformed', 'a `&` that starts no reference', i);
    const body = text.slice(i + 1, end);
    if (body.startsWith('#')) {
      const m = /^#(?:([0-9]+)|x([0-9A-Fa-f]+))$/.exec(body);
      if (m === null) return refuse('malformed', 'a malformed character reference', i);
      const cp = m[1] !== undefined ? Number.parseInt(m[1], 10) : Number.parseInt(m[2]!, 16);
      if (!referable(cp)) return refuse('malformed', 'a character reference to a character the document may not hold', i);
      return [String.fromCodePoint(cp), end + 1];
    }
    if (!WHOLE_NAME.test(body)) return refuse('malformed', 'a `&` that starts no reference', i);
    const named = PREDEFINED.get(body);
    if (named === undefined) return refuse('entity', 'a reference to an entity other than the five XML predefines', i);
    return [named, end + 1];
  };

  /** Check the character data in [from, to): its references, and no `]]>`. Searched within the run, so the scan stays linear. */
  const charData = (from: number, to: number): void => {
    if (from === to) return;
    const run = text.slice(from, to);
    const close = run.indexOf(']]>');
    if (close !== -1) refuse('malformed', 'a `]]>` outside a CDATA section', from + close);
    for (let i = run.indexOf('&'); i !== -1; i = run.indexOf('&', i + 1)) reference(from + i, to);
  };

  /** An attribute value's raw text in [from, to), normalized and its references read. */
  const attrValue = (from: number, to: number): string => {
    const raw = text.slice(from, to);
    const lt = raw.indexOf('<');
    if (lt !== -1) refuse('malformed', 'a `<` in an attribute value', from + lt);
    if (!ATTR_SPECIAL.test(raw)) return raw;
    let out = '';
    for (let i = from; i < to; ) {
      const c = text[i]!;
      if (c === '&') {
        const [s, next] = reference(i, to);
        out += s;
        i = next;
      } else if (c === '\r') {
        out += ' ';
        i += text[i + 1] === '\n' ? 2 : 1;
      } else {
        out += c === '\t' || c === '\n' ? ' ' : c;
        i++;
      }
    }
    return out;
  };

  const comment = (): void => {
    const end = text.indexOf('-->', pos + 4);
    if (end === -1) refuse('malformed', 'a comment that is not closed');
    if (text.indexOf('--', pos + 4) !== end) refuse('malformed', 'a `--` inside a comment');
    pos = end + 3;
  };

  const instruction = (): void => {
    const from = pos;
    pos += 2;
    const target = readName('a processing instruction target');
    if (target.toLowerCase() === 'xml') refuse('malformed', 'an XML declaration that is not the first thing in the report', from);
    const end = text.indexOf('?>', pos);
    if (end === -1) refuse('malformed', 'a processing instruction that is not closed', from);
    pos = end + 2;
  };

  const declaration = (): void => {
    const word = text.slice(pos, pos + 9).toUpperCase();
    if (word === '<!DOCTYPE') refuse('doctype', 'a DOCTYPE: the report declares no document type');
    if (word.startsWith('<!ENTITY')) refuse('doctype', 'an ENTITY declaration: the report declares no entity');
    refuse('malformed', 'a `<!` that opens no comment or CDATA section');
  };

  /** Comments, processing instructions and whitespace, before or after the root element. */
  const misc = (): void => {
    for (;;) {
      skipSpace();
      if (at('<!--')) comment();
      else if (at('<?')) instruction();
      else if (at('<!') && !at('<![CDATA[')) declaration();
      else return;
    }
  };

  const record = (tc: Testcase): void => {
    if (tc.status === 'F') failed = true;
    if (tc.id === null) return;
    const was = statuses.get(tc.id);
    statuses.set(tc.id, was === undefined ? tc.status : worstStatus(was, tc.status));
  };

  /** The start tag at `pos` (its `<`): its name and attributes read, then opened. */
  const startTag = (): void => {
    const from = pos;
    pos++;
    const name = readName('an element name');
    const attrs = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      const spaced = skipSpace();
      if (at('>')) {
        pos++;
        break;
      }
      if (at('/>')) {
        pos += 2;
        selfClosing = true;
        break;
      }
      if (pos >= text.length) refuse('malformed', 'a start tag that is not closed', from);
      if (!spaced) refuse('malformed', 'attributes not separated by whitespace');
      const attrAt = pos;
      const attr = readName('an attribute name');
      skipSpace();
      if (!at('=')) refuse('malformed', 'an attribute with no `=`');
      pos++;
      skipSpace();
      const quote = text[pos];
      if (quote !== '"' && quote !== "'") refuse('malformed', 'an attribute value that is not quoted');
      const end = text.indexOf(quote, pos + 1);
      if (end === -1) refuse('malformed', 'an attribute value that is not closed');
      if (attrs.has(attr)) refuse('malformed', 'an attribute given twice on one element', attrAt);
      attrs.set(attr, attrValue(pos + 1, end));
      pos = end + 1;
    }
    open(name, attrs, selfClosing, from);
  };

  const open = (name: string, attrs: ReadonlyMap<string, string>, selfClosing: boolean, from: number): void => {
    const parent = stack.at(-1);
    if (parent === undefined && !SUITES.has(name)) refuse('not_junit', 'the root element is neither testsuites nor testsuite', from);
    if (stack.length + 1 > MAX_JUNIT_DEPTH) refuse('too_deep', `elements nested over ${MAX_JUNIT_DEPTH} deep`, from);
    // A direct child of a testcase: its failure, error or skipped marks it.
    const owner = parent?.testcase ?? null;
    if (owner !== null) {
      if (name === 'failure' || name === 'error') owner.status = worstStatus(owner.status, 'F');
      else if (name === 'skipped') owner.status = worstStatus(owner.status, 'S');
    }
    let testcase: Testcase | null = null;
    if (name === 'testcase') {
      if (owner !== null) refuse('not_junit', 'a testcase inside a testcase', from);
      if (parent === undefined || !SUITES.has(parent.name)) refuse('not_junit', 'a testcase outside a testsuite', from);
      if (++testcases > MAX_JUNIT_TESTCASES) refuse('too_many_testcases', `over ${MAX_JUNIT_TESTCASES} testcases`, from);
      const testName = attrs.get('name') ?? '';
      const classname = attrs.get('classname') ?? '';
      const notRun = attrs.get('status') === 'notrun' || attrs.get('result') === 'skipped' || attrs.get('result') === 'suppressed';
      testcase = { id: testName === '' ? null : classname === '' ? testName : `${classname}::${testName}`, status: notRun ? 'S' : 'P' };
    }
    if (!selfClosing) stack.push({ name, testcase });
    else if (testcase !== null) record(testcase);
  };

  const endTag = (): void => {
    const from = pos;
    pos += 2;
    const name = readName('an element name');
    skipSpace();
    if (!at('>')) refuse('malformed', 'an end tag that is not closed', from);
    pos++;
    const frame = stack.pop()!;
    if (frame.name !== name) refuse('malformed', 'an end tag that does not match its start tag', from);
    if (frame.testcase !== null) record(frame.testcase);
  };

  const bad = BAD_CHAR.exec(text);
  if (bad !== null) refuse('malformed', 'a character the document may not hold (U+0000, U+FFFE or U+FFFF)', bad.index);

  if (at('<?xml') && isSpace(text[5])) {
    const end = text.indexOf('?>', 5);
    if (end === -1) refuse('malformed', 'an XML declaration that is not closed', 0);
    const enc = /\sencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text.slice(5, end));
    const encoding = enc === null ? null : (enc[1] ?? enc[2]!);
    if (encoding !== null && !/^(?:utf-?8|us-ascii|ascii)$/i.test(encoding)) refuse('not_utf8', 'the report declares an encoding other than UTF-8', 0);
    pos = end + 2;
  }
  misc();
  if (pos >= text.length) refuse('malformed', 'the report holds no root element');
  if (!at('<') || at('<![CDATA[')) refuse('malformed', 'text before the root element');
  startTag();
  while (stack.length > 0) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) refuse('malformed', 'an element that is not closed', text.length);
    charData(pos, lt);
    pos = lt;
    if (at('</')) endTag();
    else if (at('<!--')) comment();
    else if (at('<![CDATA[')) {
      const end = text.indexOf(']]>', pos + 9);
      if (end === -1) refuse('malformed', 'a CDATA section that is not closed');
      pos = end + 3;
    } else if (at('<!')) declaration();
    else if (at('<?')) instruction();
    else startTag();
  }
  misc();
  if (pos < text.length) refuse('malformed', 'content after the root element');
  return { testcases, failed, statuses };
}

// ---------------------------------------------------------------- the run log

export const PATCH_RUN_SCHEMA = 'agent-fun/patch-run/v1';

/** A ratified id's status in a run: the report's (P, F, S), or M when it names the id not. */
export type PatchRunStatus = JunitStatus | 'M';

/** The most ids a phase ratifies: four lists of at most PATCH_LIST_MAX_IDS. */
const MAX_RATIFIED = 4 * PATCH_LIST_MAX_IDS;

/**
 * How the tests' exit status read against their report (score.ts patchExitCheck): consistent (exit 0
 * and no testcase failed, or a non-zero exit and one did), or the way it was not: a signal ended
 * the tests, they exited 0 while a testcase failed, or not 0 while none did. Only consistent is
 * the run's honest verdict (score.ts scorePatch reads any other as tampered).
 */
export const PATCH_EXIT_CHECKS = ['consistent', 'signal', 'exit_zero_with_failure', 'exit_nonzero_without_failure'] as const;
export const PatchExitCheck = z.enum(PATCH_EXIT_CHECKS);
export type PatchExitCheckT = z.infer<typeof PatchExitCheck>;

export const PatchRunLog = z
  .strictObject({
    schema: z.literal(PATCH_RUN_SCHEMA),
    /** The patch applied: exactly when it was not refused. */
    applied: z.boolean(),
    refused: PatchRefusal.nullable(),
    /** One of P F S M per ratified id, in ratifiedIds order. */
    statuses: z.string().max(MAX_RATIFIED).regex(/^[PFSM]*$/, 'one of P, F, S or M per ratified test'),
    /** The tests' exit status against their report; absent when there was nothing to hold it against, or the log predates the check (the header). */
    exit_check: PatchExitCheck.optional(),
  })
  .superRefine(
    (l, ctx) => {
      if (l.applied !== (l.refused === null)) {
        ctx.addIssue({ code: 'custom', path: ['refused'], message: l.applied ? 'an applied patch was not refused: refused is null' : 'a patch that did not apply was refused: refused names why' });
      }
      if (!l.applied && /[PFS]/.test(l.statuses)) {
        ctx.addIssue({ code: 'custom', path: ['statuses'], message: 'a patch that did not apply ran no tests: every status is M' });
      }
      if (!l.applied && l.exit_check !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['exit_check'], message: 'a patch that did not apply ran no tests: no exit to check' });
      }
    },
    { when: (payload) => payload.issues.length === 0 },
  );

export type PatchRunLogT = z.infer<typeof PatchRunLog>;

/** A phase's ratified test ids, in the run log's order: fail_to_pass, pass_to_pass, must_fail, must_pass. */
export function ratifiedIds(lists: PatchListsT): string[] {
  return [...lists.fail_to_pass, ...lists.pass_to_pass, ...lists.canaries.must_fail, ...lists.canaries.must_pass];
}

/**
 * The run log of one run (the header): whether the patch applied or why it was refused, each
 * ratified id's status in the report (null: there is none, every status M), and how the tests' exit
 * read against it (null: nothing to hold it against; the field is left out). A refused patch has no
 * report and no exit check; this throws on either, as on an outcome whose applied and refused disagree.
 */
export function patchRunLog(
  lists: PatchListsT,
  outcome: { applied: boolean; refused: PatchRefusalT | null },
  report: JunitReport | null,
  exitCheck: PatchExitCheckT | null = null,
): PatchRunLogT {
  if (!outcome.applied && report !== null) throw new Error('a patch that did not apply ran no tests: its run has no report');
  if (!outcome.applied && exitCheck !== null) throw new Error('a patch that did not apply ran no tests: its run has no exit check');
  const statuses = ratifiedIds(lists)
    .map((id) => report?.statuses.get(id) ?? 'M')
    .join('');
  return PatchRunLog.parse({
    schema: PATCH_RUN_SCHEMA,
    applied: outcome.applied,
    refused: outcome.refused,
    statuses,
    ...(exitCheck === null ? {} : { exit_check: exitCheck }),
  });
}
