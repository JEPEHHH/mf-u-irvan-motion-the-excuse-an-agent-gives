// The house clock: how much of an agent/v1 trial's wall budget the house's own time may take, for a contest whose house
// side burns compute inside the trial wall (its env runs house engines between the entry's calls). A contest's rules
// state the wall "the house's own thinking included (about N minutes of it)"; on the platform's node the house can take
// far longer than that (tiny-chess-01: 739-2,004 s of its then 3,600 s for 16 games on production, against the rules'
// then 5 to 11 minutes),
// which cut entries that budgeted their own time as the rules said. So a contest with a row here has its trial's wall
// charged for the house's time only up to what its rules state (`houseSec`), the rest given back to the entry
// (grader/agent.ts runPass, the Supervisor's deadline moved out: grader/sandbox/io.ts extendBudget), up to `ceilingSec`
// of real time for the pass, the most one pass may take. A pass the house alone ran past that ceiling is the
// platform's fault: void, re-run as any void is (never scored 0).
//
// The house's time is read off the env's call log (grader/agent.ts ENV_LOG_FILE, /state/calls.ndjson): one JSON line a
// call, `ms` the env's time answering it, the house's move included (competitions/tiny-chess-01/src/server/main.ts).
// houseMsOf sums `ms` over the well-formed lines; a line that is not one (a malformed line, or the partial last line
// the env is still writing) is skipped, never thrown on.
//
// So a contest gets a row only when its env log's `ms` is the house's time alone: the env holds no request open waiting
// on the entry (no long-poll endpoint), or a call's `ms` would count the entry's own time as the house's and give it
// back to the entry. tiny-chess-01's was checked: on five production logs the wall less the sum of `ms` and `think_ms`
// is 11 to 15 s, the pass's start-up, so neither figure holds the other. A contest whose env long-polls gets no row
// until its log is measured so first.
//
// The row is keyed by the setup's competition (grader/agent.ts AgentSetup.competition), which every trial setup names
// with the bundle's slug: the grader's (grader/worker.ts) and those built outside it, the public verification's L1 and
// L2 replay, the CLI regrade and an entrant's local grading (cli/regrade.ts agentSetupOf) and the pilot
// (scripts/agent/pilot.ts), so a replay of a credited trial anywhere runs on the clock it ran on, never cut at the bare
// wall (replay_timeout) where the platform's pass finished.
//
// The credit, the ms the deadline moves out by: max(0, house ms - houseSec × 1000), at most (ceilingSec - wall) × 1000.
// The house's time under its stated bound is charged to the wall as it always was. A contest with no row here is
// untouched: no log read, no deadline moved, the pass exactly as before.
//
// A trial's grade-trial job (server/jobs.ts agentTrialExpirySeconds) expires 2 × ceilingSec + 30 min after it starts for
// a contest with a row, against 2 × wall + 30 min for any other, as a live pass and its replay may each take the
// ceiling. The credit each pass ran on is a run flag (houseClockFlag; grader/worker.ts adds it), in no score, state,
// output, cassette or record a result_sha256 covers.
//
// So a trial on a clock could outlast a grader's drain (deploy/k8s/base/grader.yaml MAKEFUN_DRAIN_SECONDS, 9,000 s):
// tiny-chess-01's ran up to about 12,300 s at 16 games, a live pass and its replay of up to 6,000 s each; at 8 games
// it runs up to about 6,300 s (3,000 s each), inside the drain, though a deploy can still cut a trial it finds late.
// The cut pass is voided `interrupted` and re-run, spending no pass of its series (grader/worker.ts
// AGENT_INTERRUPTED_RERUNS); a `house_clock` void spends one, and the series' third void (AGENT_SERIES_PASSES) holds the
// trial for an admin, paged.
//
// This file imports nothing, so the server (server/jobs.ts) reads the registry as the grader does.

/** A contest's house clock: what its rules state of the house's time, and the most real time one pass may take. */
export interface HouseClockRow {
  /** The house's own time, in seconds, the rules say the wall includes (their upper figure): charged to the wall, no more. */
  readonly houseSec: number;
  /** The most real time, in seconds, one pass may take, the credit included: the deadline never moves past it. */
  readonly ceilingSec: number;
}

/** The registry, by competition slug (one row each). */
export type HouseClocks = Readonly<Record<string, HouseClockRow>>;

/**
 * Every contest with a house clock. tiny-chess-01: its rules (competitions/tiny-chess-01/competition.yaml, Trials) state
 * "about 3 to 6 minutes" of the house's thinking inside its 1,800 s wall for 8 games: 330 s, the upper figure; 3,000 s
 * the ceiling. A trial was 16 games in 3,600 s, its row 660 s and 6,000 s, until the staged final halved the games, and
 * the wall, the house's time and the ceiling with them.
 */
export const HOUSE_CLOCKS: HouseClocks = Object.freeze({
  'tiny-chess-01': Object.freeze({ houseSec: 330, ceilingSec: 3000 }),
});

/** How often a pass on a house clock reads the env's call log while the entry runs (grader/agent.ts runPass). */
export const HOUSE_CLOCK_POLL_MS = 5_000;

/** The prefix of a pass's run flag (houseClockFlag). */
export const HOUSE_CLOCK_FLAG_PREFIX = 'house_clock:';

/** A contest's house clock row, or null when it has none (or no slug is known): then nothing of this file applies. */
export function houseClockOf(slug: string | null | undefined, clocks: HouseClocks = HOUSE_CLOCKS): HouseClockRow | null {
  if (typeof slug !== 'string' || !Object.hasOwn(clocks, slug)) return null;
  const row = clocks[slug]!;
  checkRow(slug, row);
  return row;
}

function checkRow(slug: string, row: HouseClockRow): void {
  const whole = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
  if (!whole(row.houseSec) || !whole(row.ceilingSec) || row.ceilingSec < 1) {
    throw new RangeError(`${slug}'s house clock names whole seconds from 0 (a ceiling from 1), got houseSec ${String(row.houseSec)}, ceilingSec ${String(row.ceilingSec)}`);
  }
}

/**
 * The house's ms in the env's call log text so far: the sum of `ms` over its complete, well-formed lines (a JSON object
 * whose `ms` is a finite number from 0). A line that is not JSON, or whose `ms` is anything else, counts nothing; the
 * text after its last newline (a line the env is still writing) counts nothing. Never throws.
 */
export function houseMsOf(text: string): number {
  const end = text.lastIndexOf('\n');
  if (end === -1) return 0;
  let sum = 0;
  for (const line of text.slice(0, end).split('\n')) {
    if (line.trim() === '') continue;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) continue;
    const ms = (doc as { ms?: unknown }).ms;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) sum += ms;
  }
  return sum;
}

/** What a pass's house clock owes it: `owed_ms` the house's time past its bound, `credit_ms` what the deadline moves by (owed, capped). */
export interface HouseCredit {
  owed_ms: number;
  credit_ms: number;
}

/**
 * The credit at `houseMs` of the house's time, under a wall of `wallBudgetSec`: owed max(0, houseMs - houseSec × 1000),
 * credited at most (ceilingSec - wall) × 1000 (none when the ceiling is not above the wall). capped: owed > credit.
 */
export function houseCredit(row: HouseClockRow, wallBudgetSec: number, houseMs: number): HouseCredit {
  const owed = Math.max(0, Math.round(houseMs) - row.houseSec * 1000);
  const cap = Math.max(0, (row.ceilingSec - wallBudgetSec) * 1000);
  return { owed_ms: owed, credit_ms: Math.min(owed, cap) };
}

/** What a pass on a house clock records (TrialPass.house_clock): the house's ms as the entry ended, its bound, the credit the deadline stood at. */
export interface HouseClockPass {
  house_ms: number;
  bound_ms: number;
  credit_ms: number;
}

/**
 * A pass's run flag: `house_clock:t<trial>.<pass>.<live|replay>:house_ms=<n>,bound_ms=<n>,credit_ms=<n>`, so each pass
 * of each trial is one flag (run flags are kept once each).
 */
export function houseClockFlag(trialIndex: number, pass: number, mode: 'live' | 'replay', c: HouseClockPass): string {
  return `${HOUSE_CLOCK_FLAG_PREFIX}t${trialIndex}.${pass}.${mode}:house_ms=${c.house_ms},bound_ms=${c.bound_ms},credit_ms=${c.credit_ms}`;
}

/** A grade-trial job's expiry for a contest on a house clock: a live pass and its replay at the ceiling each, and 30 minutes besides. */
export function houseClockExpirySeconds(row: HouseClockRow, wallBudgetSec: number): number {
  return 2 * Math.max(row.ceilingSec, wallBudgetSec) + 30 * 60;
}
