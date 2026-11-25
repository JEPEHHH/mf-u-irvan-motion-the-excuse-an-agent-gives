// Reading a program/v1 scorer's scores.json (Codabench contract: the scorer container writes
// /scores/scores.json keyed by leaderboard column keys; the grader, never the container, records
// them). The file must be a regular file of at most MAX_SCORES_BYTES holding one JSON object whose
// keys are exactly the leaderboard's scored columns (computation null and source null: the other
// columns are derived or read from the score JSON) and whose values are finite numbers or null.
// Anything else is a scorer fault (ScorerError): the competition's code is broken, not the entry.
//
// Per-check rows (optional). A scorer whose checks are not leaderboard columns (dropship's thirty
// rubric checks against its handful of group columns) may also write /scores/checks.json: a JSON
// array of its checks, in the order it shows them,
//
//   [{ "key", "group"?, "title", "points", "earned", "pass", "detail"? }, ...]
//
//   key      the check's id, unique in the file (1-128 characters)
//   group    the heading it is shown under (1-128 characters); absent: none
//   title    what it judges (1-256 characters)
//   points   its maximum, at least 0
//   earned   what it earned, at most its points (a penalty may earn below 0)
//   pass     whether it passed, the scorer's own verdict (a check may pass and earn less than its points)
//   detail   why it did not (at most MAX_CHECK_DETAIL_CHARS characters); absent: nothing to say
//
// every number a checks value (contracts/breakdown.ts CheckPoints: finite, at most six decimals, of
// magnitude at most CHECK_POINTS_MAX), and no other field. No file is no checks (readChecks: null),
// and the run's breakdown falls back to its scored columns; a file that is there must be a regular
// file of at most MAX_CHECKS_BYTES holding 1..MAX_CHECKS such rows, or readChecks refuses it with a
// ScorerError, like a malformed scores.json. The checks never move the score: scores.json alone is the
// score. How grading treats that refusal is grader/harnesses.ts scoreProgramBreakdown's: the file is
// dropped with its reason and the scores stand as without it, never a failed grade (only a malformed
// scores.json, or any other scorer fault, still fails one).
//
// The rows become a checks trace (contracts/breakdown.ts ChecksTrace, agent-fun/trace/v1), the run's
// breakdown: programChecksTrace makes a program/v1 run's (aggregation sum, its parts the checks,
// earned against points); grader/agent-score.ts agentChecksTrace makes an agent/v1 run's from each
// trial's (aggregation mean, one earned per trial). A part keeps a check's key, group, title, points
// (as max) and earned; the trace has no field for pass or detail, so those stay on the rows.

import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CheckPoints, ChecksPart, ChecksTrace, checksTotalMicro, TRACE_FORMAT, type ChecksPartT, type ChecksTraceT } from '../contracts/breakdown.ts';
import { ColumnKey, type Leaderboard } from '../contracts/competition.ts';
import { compareCodeUnits } from '../sim/canonical.ts';

export const SCORES_FILE = 'scores.json';
export const MAX_SCORES_BYTES = 64 * 1024;

/** The optional per-check rows a scorer may write beside scores.json (the header). */
export const CHECKS_FILE = 'checks.json';
export const MAX_CHECKS_BYTES = 256 * 1024;
/** The most rows checks.json may hold. */
export const MAX_CHECKS = 500;
/** The longest detail a row may carry, in characters. */
export const MAX_CHECK_DETAIL_CHARS = 2000;

/** The competition's scorer misbehaved (crashed, timed out, wrote no or a malformed scores.json). */
export class ScorerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScorerError';
  }
}

export type ProgramScores = Record<string, number | null>;

/** The columns a scorer must write: neither computed nor read from the score JSON. */
export function scoredColumns(leaderboard: Pick<z.infer<typeof Leaderboard>, 'columns'>): string[] {
  return leaderboard.columns
    .filter((c) => c.computation === null && c.source === null)
    .map((c) => c.key)
    .sort(compareCodeUnits);
}

/** Validate a parsed scores.json against the scored columns; returns the scores with keys in code-unit order. */
export function validateScores(value: unknown, columns: readonly string[]): ProgramScores {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ScorerError('scores.json is not a JSON object');
  const want = new Set(columns);
  const out: ProgramScores = {};
  const keys = Object.keys(value).sort(compareCodeUnits);
  for (const k of keys) {
    if (!ColumnKey.safeParse(k).success) throw new ScorerError(`scores.json key ${JSON.stringify(k)} is not a column key`);
    if (!want.has(k)) throw new ScorerError(`scores.json has ${k}, which is not a scored leaderboard column (expected ${columns.join(', ')})`);
    const v = (value as Record<string, unknown>)[k];
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new ScorerError(`scores.json ${k} is not a finite number or null`);
    // -0 and 0 hash alike in canonical JSON; keep one spelling.
    out[k] = v === null ? null : Object.is(v, -0) ? 0 : (v as number);
  }
  const missing = columns.filter((c) => !(c in out));
  if (missing.length > 0) throw new ScorerError(`scores.json lacks ${missing.join(', ')}`);
  return out;
}

/** Read and validate `<scoresDir>/scores.json`. */
export async function readScores(scoresDir: string, columns: readonly string[]): Promise<ProgramScores> {
  const file = `${scoresDir}/${SCORES_FILE}`;
  let st;
  try {
    st = await lstat(file);
  } catch {
    throw new ScorerError('the scorer wrote no scores.json');
  }
  if (!st.isFile()) throw new ScorerError('scores.json is not a regular file');
  if (st.size > MAX_SCORES_BYTES) throw new ScorerError(`scores.json is ${st.size} bytes (max ${MAX_SCORES_BYTES})`);
  const text = (await readFile(file)).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ScorerError('scores.json is not JSON');
  }
  return validateScores(parsed, columns);
}

// ---------------------------------------------------------------- checks.json

/** A checks value with one spelling of zero: -0 and 0 hash alike in canonical JSON. */
const CheckValue = CheckPoints.transform((x) => (Object.is(x, -0) ? 0 : x));

/** Cross-field rules run only on what already parsed. */
const whenValid = { when: (payload: { issues: readonly unknown[] }): boolean => payload.issues.length === 0 };

/** One row of checks.json (the header). */
export const ScorerCheck = z
  .strictObject({
    key: ChecksPart.shape.key,
    group: ChecksPart.shape.group,
    title: ChecksPart.shape.title,
    points: CheckValue.refine((x) => x >= 0, 'points is a maximum: at least 0'),
    earned: CheckValue,
    pass: z.boolean(),
    detail: z.string().max(MAX_CHECK_DETAIL_CHARS).optional(),
  })
  .refine((c) => c.earned <= c.points, { path: ['earned'], message: 'a check earns at most its points', ...whenValid });

/** checks.json: 1..MAX_CHECKS rows, each key once, in the scorer's order. */
export const ScorerChecks = z
  .array(ScorerCheck)
  .min(1, 'checks.json lists no checks: a scorer with none writes no file')
  .max(MAX_CHECKS, `checks.json lists more than ${MAX_CHECKS} checks`)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      if (seen.has(r.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `${JSON.stringify(r.key)} is another check's key: each key appears once` });
      seen.add(r.key);
    });
  }, whenValid);

export type ScorerCheckT = z.infer<typeof ScorerCheck>;
export type ScorerChecksT = z.infer<typeof ScorerChecks>;

/** A zod path as checks.json's: [3].earned. */
function checksPath(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('');
}

/** Validate a parsed checks.json (the header); the rows in the scorer's order, -0 written 0. Anything else is a ScorerError. */
export function validateChecks(value: unknown): ScorerChecksT {
  const parsed = ScorerChecks.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ScorerError(`${CHECKS_FILE}${checksPath(issue.path)}: ${issue.message}`);
  }
  return parsed.data;
}

/** Read and validate `<scoresDir>/checks.json`: null when the scorer wrote none. */
export async function readChecks(scoresDir: string): Promise<ScorerChecksT | null> {
  const file = `${scoresDir}/${CHECKS_FILE}`;
  let st;
  try {
    st = await lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw new ScorerError(`${CHECKS_FILE} cannot be read (${(err as NodeJS.ErrnoException | null)?.code ?? 'error'})`);
  }
  if (!st.isFile()) throw new ScorerError(`${CHECKS_FILE} is not a regular file`);
  if (st.size > MAX_CHECKS_BYTES) throw new ScorerError(`${CHECKS_FILE} is ${st.size} bytes (max ${MAX_CHECKS_BYTES})`);
  const text = (await readFile(file)).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ScorerError(`${CHECKS_FILE} is not JSON`);
  }
  return validateChecks(parsed);
}

/** A check as a trace part: its key, group, title, its points as max; the caller adds what it earned. */
export function checkPartBase(c: Pick<ScorerCheckT, 'key' | 'group' | 'title' | 'points'>): Omit<ChecksPartT, 'earned' | 'earned_by_trial'> {
  return { key: c.key, ...(c.group === undefined ? {} : { group: c.group }), title: c.title, max: c.points };
}

/**
 * A checks trace checked against the contract (contracts/breakdown.ts ChecksTrace), its total the
 * parts' own (checksTotalMicro). Its parts are a scorer's rows, so what the contract refuses (a
 * total past CHECK_POINTS_MAX) is a ScorerError.
 */
export function checksTraceOf(aggregation: ChecksTraceT['aggregation'], trials: number, parts: ChecksPartT[]): ChecksTraceT {
  const micro = checksTotalMicro({ aggregation, trials, parts });
  // A count of 10^-6 as a number: exact to six decimals below 2^53, which CHECK_POINTS_MAX keeps it under.
  const total = Number(micro) / 1e6;
  const parsed = ChecksTrace.safeParse({ format: TRACE_FORMAT, kind: 'checks', aggregation, trials, parts, total });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ScorerError(`${CHECKS_FILE} makes no checks trace: ${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`);
  }
  return parsed.data;
}

/** A program/v1 run's checks trace (aggregation sum, one run): its parts the checks, earned against points, in the scorer's order. */
export function programChecksTrace(checks: ScorerChecksT): ChecksTraceT {
  const rows = validateChecks(checks);
  return checksTraceOf(
    'sum',
    1,
    rows.map((c) => ({ ...checkPartBase(c), earned: c.earned })),
  );
}
