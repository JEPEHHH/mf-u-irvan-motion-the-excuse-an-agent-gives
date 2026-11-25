// An agent/v1 run's performance (contracts/score.ts AgentPerformance): its K trials, one per
// beacon-drawn instance every entry of the phase shares (paired), aggregated into what the run stores.
// Each trial's state export was scored by the bundle's scorer (grader/program-scores.ts: scores.json
// keyed by the leaderboard's scored columns); aggregateTrials takes those trials, in index order, and
// builds:
//
//   trials          each trial as it counts: its scores in integer points (a timeout, and a trial the
//                   LLM agent floor finds silent, 0 on every column whatever its store holds), whether
//                   its store works (its `working` column is 1; a timeout's or a silent trial's never
//                   does), its cassette's requests and spend, its digests
//   scores          per scored column, the mean over the K listed trials
//   interval        the 90% two-sided Student t-interval of the primary column's mean,
//                   mean ± t(0.95, K-1) · s / √K (s the sample standard deviation), with t from
//                   T90_MICRO, a table to six decimals for K = 2..30; null bounds at K = 1
//   counts          the listed trials by status, and the void re-runs before them (a void trial, an
//                   infrastructure fault, re-runs on its instance and is never listed)
//   working_trials  the trials whose store works
//   spend           the listed trials' cassette totals summed, on the one pricing_rev they share
//
// Byte-stable arithmetic: a trial's points are integers, and every figure derived from them is an
// integer count of 10^-6 before it becomes a JSON number: a mean is sum · 10^6 / K rounded half away
// from zero; the interval's half-width is round(√(t² · (K·Σx² - (Σx)²) / (K²·(K-1)))) at 10^-6 (t at
// 10^-6, an exact integer square root), and its bounds are the published mean minus and plus it. So
// the same trials give the same canonical bytes (run.result_sha256) on every host and every Node.
//
// The run's action log is the trials manifest (contracts/agent.ts AgentTrials): trialsManifest gives
// its canonical JSON and the sha256 run.action_log_sha256 names. A trial's brief digest
// (prompt_sha256) is in it only when its record carries one, and so is a target's house lane
// cassette (house_cassette_sha256).
//
// Eligibility reads the trials (grader/score.ts): the run is deterministic, so ranked, exactly when
// no trial is nondeterministic (agentDeterministic); a timeout counts, as 0, and keeps it ranked.
//
// An LLM agent's floor: the rules say each entry is an LLM agent, and the one part of that a grader
// can see is the gateway's cassette. A trial's model calls are what grader/gateway/cassette.ts
// cassetteModelCalls counts in it: completions the forwarder sent upstream that the model answered
// using tokens (a `models` listing, a refusal, an upstream error or an answer with no tokens is none),
// counted off the stored cassette's bytes alone (AgentTrialResult.model_calls), so whoever re-derives
// the run counts the same. The floor holds an entrant's entry (neither a house entry nor a baseline,
// the score's two entry facts: AgentEntryFacts) to it; the house's own entries are exempt, since they
// take no prize and its scripted baseline (agent/scripted-baseline-store-agent, the prize gate's bar)
// calls no model by design. A harness waives the floor for every entry in either of two ways, the
// harness's two entry facts (agentHarnessFloorFacts reads both off it), and then no trial of any entry
// is silent and no run of it is refused:
//   a target       it names a house target (contracts/competition.ts AgentHarness.target: the env
//                  calls the target's models through the house lane, metered apart from the entry's
//                  own; AgentEntryFacts.target): an entry there may be a scripted attacker that makes
//                  no model call of its own and is a legal entry all the same; one that never works
//                  the target still scores what the scorer gives it (a `working` column of 0)
//   model_calls    it says the competition does not require model calls (AgentHarness.model_calls:
//                  optional; AgentEntryFacts.model_calls_optional): an entry there may be a scripted
//                  program that calls no model at all (a chess engine, a poker bot), scored as any
//                  other; the harness's inference still meters any model call an entry does make.
// Of an entrant's trials, on a harness that waives neither:
//   silent trial   one whose store would be scored (finished or nondeterministic) and whose live pass
//                  made no model call (agentTrialSilent) scores 0 on every column, its store not
//                  scored (its scores are not read) and not working, as a timeout does; aggregateTrials
//                  applies it when it is handed the entry's facts, and agentSilentNote names those
//                  trials in the words the run's error and the kit's local grade carry, opening with
//                  AGENT_SILENT_TRIAL. Its status stays its own (finished, nondeterministic).
//   refused run    a run none of whose trials made a model call, one of them a trial whose store would
//                  be scored (agentModelCallRefusal), is refused whole: the run fails with
//                  AGENT_NO_MODEL_CALL as its error, so the entry is rejected by its own check
//                  (server/entries/checks.ts model_call, implied from that error) and scores nothing.
//                  An entry whose passes ran with no provider key of its entrant's (grader/worker.ts
//                  `entry lane`: no provider-lane entry secret) is told so in that error, naming the keys
//                  its bundle's models are served by (AgentModelCallRefusalOptions.keys), and that pushing
//                  one of those is the way out. A caller that cannot say which keys those are names none
//                  (never a guessed list): only `keys` tells the reason what to name.
//   timeout        already scores 0 whatever its store holds: the floor neither zeroes it nor refuses
//                  for it, so a run whose every trial timed out is scored (0) and never refused.
// The callers that finish a run apply it, each before it builds the score: the fan-in (grader/worker.ts
// finish) and the kit's local grade (cli/grade-local.ts, under --house and --baseline), each handing it
// the harness's waivers (agentHarnessFloorFacts) with the entry's facts. An L1 regrade or a verifier
// reproduces a scored run's bytes only when it hands aggregateTrials the same facts (grader/regrade.ts
// reads the waivers off the setup's harness) and each trial's count off the same cassette. One model
// call a trial passes it: this is a floor, not a proof that a model did the work.
//
// Faults: scores that are not integer points, a `working` column other than 0 or 1, or a leaderboard
// an agent/v1 run cannot be scored on (agentColumns) are the competition's, never the entry's
// (ScorerError); trials out of order, out of range or priced on two pricing revisions are the
// caller's (RangeError, TypeError).
//
// The run's checks trace (agentChecksBreakdown, agentChecksTrace): a bundle whose scorer writes
// per-check rows beside scores.json (grader/program-scores.ts checks.json) keeps each trial's rows on
// its result (AgentTrialResult.checks: grader/agent.ts scoreTrialWithChecks), and the run's breakdown is
// the checks trace of them (contracts/breakdown.ts ChecksTrace, aggregation mean over the K listed
// trials): one part per check, earned_by_trial the check's earned on each trial in index order, total
// the mean of the per-trial sums. A trial whose scores are not read (a timeout, a silent trial) has its
// rows unread too and earns 0 on every check, as it scores 0 on every column. The trace needs every
// scored trial scored on the same checks: the same keys in the same order, each with the same group,
// title and points (only earned, pass and detail differ). A breakdown never fails a grade: when the
// scored trials' checks differ (a scorer that writes rows on one and none on another, or other checks,
// as a rubric with per-instance asks does), a scored trial's checks.json was dropped as malformed
// (AgentTrialResult.checks_issue), its rows are invalid, or they make no trace the contract accepts,
// the run has no checks trace (null) and agentChecksBreakdown says why, for the caller to log; the
// score is exactly what it is without the rows. A run none of whose scored trials carries rows has no
// checks trace either (null, no reason), and its breakdown falls back to its columns. The trace is
// apart from the performance: aggregateTrials never reads the rows, so run.result and its sha256 do
// not move with them.

import type { z } from 'zod';
import { AGENT_TRIALS_FORMAT, AgentTrials, checkTrialOrder, type AgentTrialRecordT, type AgentTrialsT, type AgentTrialStatusT } from '../contracts/agent.ts';
import type { ChecksTraceT } from '../contracts/breakdown.ts';
import { AGENT_MODEL_CALLS_OPTIONAL, AGENT_WORKING_COLUMN, agentLeaderboardIssues, type AgentHarnessT, type Leaderboard } from '../contracts/competition.ts';
import { U64 } from '../contracts/primitives.ts';
import { AgentPerformance, type AgentPerformanceT, type AgentTrialScoreT } from '../contracts/score.ts';
import { canonicalJson, sha256Hex } from '../sim/canonical.ts';
import { checkPartBase, checksTraceOf, scoredColumns, ScorerError, validateChecks, validateScores, type ProgramScores, type ScorerCheckT, type ScorerChecksT } from './program-scores.ts';

/** The interval's level (AgentInterval.level): two-sided 90%. */
export const AGENT_INTERVAL_LEVEL = '0.900000000';

/** The scorer column saying a trial's store works: 1 when every operations check passed, else 0 (the contract's: contracts/competition.ts). */
export { AGENT_WORKING_COLUMN };

/** The most trials a run lists: AgentTrialsConfig.final_instances' maximum, the t table's last K. */
export const AGENT_MAX_TRIALS = 30;

/** The largest magnitude a trial's points may have: every mean and bound stays an exact integer of 10^-6 below 2^53. */
export const AGENT_MAX_POINTS = 1_000_000_000;

const MICRO = 1_000_000n;

/**
 * Student's t at the 0.95 quantile (two-sided 90%), in 10^-6, keyed by degrees of freedom K - 1 for
 * K = 2..30: each the correctly rounded six-decimal value (tests/unit/grader-agent-score.test.ts
 * re-derives every one from the t distribution).
 */
export const T90_MICRO: Readonly<Record<number, bigint>> = Object.freeze({
  1: 6_313_752n,
  2: 2_919_986n,
  3: 2_353_363n,
  4: 2_131_847n,
  5: 2_015_048n,
  6: 1_943_180n,
  7: 1_894_579n,
  8: 1_859_548n,
  9: 1_833_113n,
  10: 1_812_461n,
  11: 1_795_885n,
  12: 1_782_288n,
  13: 1_770_933n,
  14: 1_761_310n,
  15: 1_753_050n,
  16: 1_745_884n,
  17: 1_739_607n,
  18: 1_734_064n,
  19: 1_729_133n,
  20: 1_724_718n,
  21: 1_720_743n,
  22: 1_717_144n,
  23: 1_713_872n,
  24: 1_710_882n,
  25: 1_708_141n,
  26: 1_705_618n,
  27: 1_703_288n,
  28: 1_701_131n,
  29: 1_699_127n,
});

// ---------------------------------------------------------------- integer arithmetic

/** n / d rounded to the nearest integer, half away from zero (d > 0). */
function divRound(n: bigint, d: bigint): bigint {
  const q = (2n * (n < 0n ? -n : n) + d) / (2n * d);
  return n < 0n ? -q : q;
}

/** floor(√n) for n >= 0, exactly (Newton's method from above). */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError(`no square root of ${n}`);
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length >> 1) + 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Integer points as BigInt: each a safe integer of magnitude at most AGENT_MAX_POINTS. */
function toPoints(values: readonly number[], what: string): bigint[] {
  return values.map((v, i) => {
    if (!Number.isSafeInteger(v) || Math.abs(v) > AGENT_MAX_POINTS) throw new RangeError(`${what} ${i} is ${v}: points are integers of magnitude at most ${AGENT_MAX_POINTS}`);
    return BigInt(v);
  });
}

/** A count of 10^-6 as the JSON number it publishes (exact: every such count here is below 2^53). */
function microToNumber(micro: bigint): number {
  return Number(micro) / 1e6;
}

/** The mean of integer points in 10^-6: sum · 10^6 / K, rounded half away from zero. */
export function meanMicro(points: readonly bigint[]): bigint {
  if (points.length === 0) throw new RangeError('a mean needs at least one value');
  return divRound(points.reduce((s, x) => s + x, 0n) * MICRO, BigInt(points.length));
}

/**
 * The 90% two-sided t-interval's half-width, t(0.95, K-1) · s / √K, in 10^-6, rounded to the nearest
 * (half up); null at K = 1, where it is undefined. K is at most AGENT_MAX_TRIALS, the table's last.
 */
export function halfWidth90Micro(points: readonly bigint[]): bigint | null {
  const k = BigInt(points.length);
  if (points.length < 2) return null;
  const t = T90_MICRO[points.length - 1];
  if (t === undefined) throw new RangeError(`${points.length} values: the t table covers K = 2..${AGENT_MAX_TRIALS}`);
  let sum = 0n;
  let squares = 0n;
  for (const x of points) {
    sum += x;
    squares += x * x;
  }
  // K·Σx² - (Σx)² = K·Σ(x - mean)², never negative; s²/K = it / (K²·(K-1)).
  const spread = k * squares - sum * sum;
  // round(√a) = (floor(√(4a)) + 1) >> 1, and floor(√a) = isqrt(floor(a)).
  return (isqrt((4n * t * t * spread) / (k * k * (k - 1n))) + 1n) >> 1n;
}

/**
 * The mean of integer points and its 90% two-sided t-interval, published to six decimals (the
 * header): the bounds are null with one value. The run's interval on its primary column, and the
 * paired interval of two runs' per-instance differences alike.
 */
export function interval90(values: readonly number[]): { mean: number; low: number | null; high: number | null } {
  const points = toPoints(values, 'value');
  const mean = meanMicro(points);
  const half = halfWidth90Micro(points);
  return { mean: microToNumber(mean), low: half === null ? null : microToNumber(mean - half), high: half === null ? null : microToNumber(mean + half) };
}

// ---------------------------------------------------------------- aggregation

export type AgentLeaderboard = Pick<z.infer<typeof Leaderboard>, 'primary_index' | 'columns'>;

/**
 * The columns an agent/v1 run is scored on: the leaderboard's scored columns (neither computed nor
 * read from the score JSON: the scorer writes them), among them the primary column, whose per-trial
 * points the interval is taken over, and AGENT_WORKING_COLUMN. The rule is the contract's one
 * predicate (contracts/competition.ts agentLeaderboardIssues), which refuses such a bundle at load
 * too; its first issue here is a ScorerError: the competition's leaderboard cannot score the run.
 */
export function agentColumns(leaderboard: AgentLeaderboard): { columns: string[]; primary: string } {
  const [issue] = agentLeaderboardIssues(leaderboard);
  if (issue !== undefined) throw new ScorerError(issue.message);
  const primary = leaderboard.columns.find((c) => c.index === leaderboard.primary_index)!;
  return { columns: scoredColumns(leaderboard), primary: primary.key };
}

/**
 * One trial that counts, as its live pass, replay and scoring left it: its trials-manifest fields
 * (contracts/agent.ts AgentTrialRecord), the scorer's scores of its state export, its cassette's
 * pricing revision and totals, and how many voided passes it re-ran.
 */
export interface AgentTrialResult extends Pick<AgentTrialRecordT, 'index' | 'instance_sha256' | 'cassette_sha256' | 'state_sha256'> {
  status: AgentTrialStatusT;
  /**
   * The scorer's scores.json for the trial's state export (finished: the store the agent left;
   * nondeterministic: the live pass's), integer points in every scored column. A timeout, and a trial
   * the floor finds silent (agentTrialSilent), score 0 on every column whatever the store holds: their
   * scores are not read and may be null.
   */
  scores: ProgramScores | null;
  /**
   * The scorer's checks.json for the same state export (grader/program-scores.ts readChecks), when the
   * bundle's scorer writes one: what agentChecksTrace makes the run's breakdown of (the header). Read
   * exactly where `scores` is; absent or null: the scorer wrote none, or wrote one that was dropped (checks_issue).
   * aggregateTrials never reads it.
   */
  checks?: ScorerChecksT | null;
  /**
   * Why the scorer's checks.json for the trial's state export was dropped (grader/harnesses.ts scoreProgramBreakdown:
   * readChecks refused it), its scores standing as without it; absent or null when it was not. A scored trial's makes
   * the run's breakdown none (agentChecksBreakdown). aggregateTrials never reads it.
   */
  checks_issue?: string | null;
  /** Its cassette's pricing_rev. */
  pricing_rev: string;
  /** Its cassette's totals.requests. */
  requests: number;
  /**
   * Its cassette's model calls (grader/gateway/cassette.ts cassetteModelCalls): what the LLM agent
   * floor counts (the header). Needed on every trial of an entrant's run that aggregateTrials holds to
   * the floor; read by nothing else.
   */
  model_calls?: number;
  /** Its cassette's totals.micro_usd (U64 decimal). */
  spend_micro_usd: string;
  /** Its live passes voided (an infrastructure fault) and re-run on its instance before the one that counts. */
  voids: number;
}

/** A trial's points per scored column, and whether its store works: 0 and not working, its scores unread, when it is a timeout or `silent`. */
function trialPoints(t: AgentTrialResult, columns: readonly string[], silent: boolean): { scores: Record<string, number>; working: boolean } {
  if (t.status === 'timeout' || silent) return { scores: Object.fromEntries(columns.map((c) => [c, 0])), working: false };
  if (t.scores === null) throw new TypeError(`trial ${t.index} is ${t.status}: its state export is scored, so it carries the scorer's scores`);
  const validated = validateScores(t.scores, columns);
  const scores: Record<string, number> = {};
  for (const c of columns) {
    const v = validated[c] ?? null;
    if (v === null || !Number.isSafeInteger(v) || Math.abs(v) > AGENT_MAX_POINTS) {
      throw new ScorerError(`trial ${t.index}'s ${c} is ${v}: an agent/v1 scorer scores every column in integer points, of magnitude at most ${AGENT_MAX_POINTS}`);
    }
    scores[c] = v;
  }
  const working = scores[AGENT_WORKING_COLUMN];
  if (working !== 0 && working !== 1) throw new ScorerError(`trial ${t.index}'s ${AGENT_WORKING_COLUMN} is ${working}: it is 1 when the store works, else 0`);
  return { scores, working: working === 1 };
}

/**
 * The agent/v1 performance of a run's K trials (the header), K = 1..AGENT_MAX_TRIALS, given in index
 * order, each on an instance of its own; validated against contracts/score.ts AgentPerformance.
 * Handed the entry's facts (`entry`), it holds an entrant's run to the LLM agent floor: each silent
 * trial (agentTrialSilent) scores 0 on every column, its store not scored, and every trial of the run
 * then carries its model_calls (a TypeError otherwise: the caller's). Without them no trial is held
 * to it, as for the house's own entries and on a harness that waives the floor (`target`,
 * `model_calls_optional`): what checks one trial's points alone passes none.
 */
export function aggregateTrials(trials: readonly AgentTrialResult[], leaderboard: AgentLeaderboard, entry?: AgentEntryFacts): AgentPerformanceT {
  const { columns, primary } = agentColumns(leaderboard);
  checkTrialList(trials);
  const pricingRev = trials[0]!.pricing_rev;
  for (const t of trials) {
    if (t.pricing_rev !== pricingRev) {
      throw new TypeError(`trial ${t.index} was priced on ${t.pricing_rev}, trial ${trials[0]!.index} on ${pricingRev}: a run's spend is stated on one pricing revision, so its cassettes are priced on one`);
    }
    if (!Number.isSafeInteger(t.voids) || t.voids < 0) throw new RangeError(`trial ${t.index} has ${t.voids} void re-runs: a count`);
    if (t.model_calls !== undefined) checkModelCalls(t);
  }
  const floor = floorHolds(trials, entry);

  const listed: AgentTrialScoreT[] = trials.map((t) => {
    const { scores, working } = trialPoints(t, columns, floor && silentTrial(t));
    return {
      index: t.index,
      instance_sha256: t.instance_sha256,
      status: t.status,
      scores,
      working,
      requests: t.requests,
      spend_micro_usd: U64.parse(t.spend_micro_usd),
      cassette_sha256: t.cassette_sha256,
      state_sha256: t.state_sha256,
    };
  });

  const pointsOf = (c: string) => listed.map((t) => BigInt(t.scores[c]!));
  const scores: Record<string, number> = {};
  for (const c of columns) scores[c] = microToNumber(meanMicro(pointsOf(c)));
  const primaryPoints = pointsOf(primary);
  const mean = meanMicro(primaryPoints);
  const half = halfWidth90Micro(primaryPoints);

  const count = (s: AgentTrialStatusT) => listed.filter((t) => t.status === s).length;
  return AgentPerformance.parse({
    kind: 'agent/v1',
    trials: listed,
    scores,
    interval: {
      level: AGENT_INTERVAL_LEVEL,
      low: half === null ? null : microToNumber(mean - half),
      high: half === null ? null : microToNumber(mean + half),
    },
    counts: {
      trials: listed.length,
      finished: count('finished'),
      timeout: count('timeout'),
      nondeterministic: count('nondeterministic'),
      voids_rerun: trials.reduce((s, t) => s + t.voids, 0),
    },
    working_trials: listed.filter((t) => t.working).length,
    spend: {
      pricing_rev: pricingRev,
      micro_usd: listed.reduce((s, t) => s + BigInt(t.spend_micro_usd), 0n).toString(),
      requests: listed.reduce((s, t) => s + t.requests, 0),
    },
  });
}

/** 1..AGENT_MAX_TRIALS trials in index order, each on an instance of its own (RangeError otherwise: the caller's). */
function checkTrialList(trials: readonly AgentTrialResult[]): void {
  if (trials.length < 1 || trials.length > AGENT_MAX_TRIALS) throw new RangeError(`an agent/v1 run lists 1..${AGENT_MAX_TRIALS} trials, not ${trials.length}`);
  checkTrialOrder(trials, ['trials'], (path, message) => {
    throw new RangeError(`${path.join('.')}: ${message}`);
  });
}

/** Whether the run is held to the LLM agent floor (handed an entrant's facts); every trial then carries its model calls (TypeError otherwise: the caller's). */
function floorHolds(trials: readonly AgentFloorTrial[], entry: AgentEntryFacts | undefined): boolean {
  const floor = entry !== undefined && heldToFloor(entry);
  if (floor) {
    for (const t of trials) if (t.model_calls === undefined) throw new TypeError(`trial ${t.index} carries no model_calls: an entrant's run is held to the LLM agent floor, so every trial carries its cassette's model calls`);
  }
  return floor;
}

/** A check's shape, as the reason naming two trials' different checks shows it. */
function checkShape(c: Pick<ScorerCheckT, 'key' | 'group' | 'title' | 'points'>): string {
  return `${c.group === undefined ? '' : `${c.group}/`}${c.key} ${JSON.stringify(c.title)} of ${c.points} points`;
}

/** An agent/v1 run's breakdown (agentChecksBreakdown): its checks trace, or null and, when its scorer's rows made none, why. */
export interface AgentChecksBreakdown {
  /** The run's checks trace; null when no scored trial carries rows, or when they make none (`reason`). */
  trace: ChecksTraceT | null;
  /** Why the scored trials' rows make no trace (the header), for the caller to log; null when they make one or there are none. */
  reason: string | null;
}

/** The reason a run's breakdown is dropped for (agentChecksBreakdown): what keeps its rows from a trace, and that its score stands. */
function droppedBreakdown(why: string): AgentChecksBreakdown {
  return { trace: null, reason: `no checks trace: ${why}; the run's score stands as without the breakdown` };
}

/** What `run` returns, or the message of a ScorerError it throws (the scorer's rows refused); anything else it throws is thrown. */
function scorerTry<T>(run: () => T): { value: T } | { refused: string } {
  try {
    return { value: run() };
  } catch (err) {
    if (err instanceof ScorerError) return { refused: err.message };
    throw err;
  }
}

/**
 * The checks breakdown of an agent/v1 run's K trials (the header), given in index order as aggregateTrials takes them,
 * with the same entry facts (`entry`), so a trial the floor finds silent earns 0 on every check as it scores 0 on every
 * column. Its trace's parts are the scored trials' common checks, in their order, each part's earned_by_trial what each
 * listed trial earned on it (0 on a timeout and a silent trial); the trace is null with no reason when no scored trial
 * carries checks. It never throws for the scorer's rows (a breakdown never fails a grade): a scored trial without checks
 * beside one with them, one whose checks.json was dropped (checks_issue), invalid rows, other checks (keys, order, group,
 * title or points) or rows the trace contract refuses make the trace null with the reason. Trials out of order or out of
 * range, and an entrant's trial without model_calls, are the caller's (RangeError, TypeError), as on aggregateTrials.
 */
export function agentChecksBreakdown(trials: readonly AgentTrialResult[], entry?: AgentEntryFacts): AgentChecksBreakdown {
  checkTrialList(trials);
  for (const t of trials) if (t.model_calls !== undefined) checkModelCalls(t);
  const floor = floorHolds(trials, entry);
  // Each trial's rows: 'unread' on a timeout and a silent trial (it earns 0 on every check), null where the scorer wrote none (or they were dropped).
  const read = trials.map((t): ScorerChecksT | null | 'unread' => (t.status === 'timeout' || (floor && silentTrial(t)) ? 'unread' : (t.checks ?? null)));
  const dropped = trials.find((t, i) => read[i] !== 'unread' && t.checks_issue !== undefined && t.checks_issue !== null);
  if (dropped !== undefined) return droppedBreakdown(`trial ${dropped.index}'s checks.json was dropped (${dropped.checks_issue})`);
  const rows: (ScorerChecksT | null | 'unread')[] = [];
  for (const [i, r] of read.entries()) {
    if (r === 'unread' || r === null) {
      rows.push(r);
      continue;
    }
    const valid = scorerTry(() => validateChecks(r));
    if ('refused' in valid) return droppedBreakdown(`trial ${trials[i]!.index}'s ${valid.refused}`);
    rows.push(valid.value);
  }
  const firstAt = rows.findIndex((r) => r !== null && r !== 'unread');
  if (firstAt < 0) return { trace: null, reason: null };
  const first = trials[firstAt]!;
  const rubric = rows[firstAt] as ScorerChecksT;
  for (const [i, r] of rows.entries()) {
    const t = trials[i]!;
    if (r === 'unread') continue;
    if (r === null) return droppedBreakdown(`trial ${t.index}'s scorer wrote no checks.json and trial ${first.index}'s did: a trace needs its checks on every scored trial or on none`);
    if (r.length !== rubric.length) return droppedBreakdown(`trial ${t.index}'s checks.json lists ${r.length} checks and trial ${first.index}'s ${rubric.length}: a trace needs every scored trial scored on the same checks`);
    for (const [j, c] of r.entries()) {
      const want = rubric[j]!;
      if (c.key !== want.key || c.group !== want.group || c.title !== want.title || c.points !== want.points) {
        return droppedBreakdown(`trial ${t.index}'s check ${j} is ${checkShape(c)} and trial ${first.index}'s ${checkShape(want)}: a trace needs every scored trial scored on the same checks, in the same order, each with the same group, title and points`);
      }
    }
  }
  const trace = scorerTry(() =>
    checksTraceOf(
      'mean',
      trials.length,
      // Every row list but 'unread' is the rubric's length here: a null one, or one of another length, has returned above.
      rubric.map((c, j) => ({ ...checkPartBase(c), earned_by_trial: rows.map((r) => (r === 'unread' ? 0 : r![j]!.earned)) })),
    ),
  );
  return 'refused' in trace ? droppedBreakdown(trace.refused) : { trace: trace.value, reason: null };
}

/**
 * The checks trace of an agent/v1 run's K trials (agentChecksBreakdown's trace): null when no scored trial carries
 * checks, and null too when the scored trials' rows make none (agentChecksBreakdown says why). Never a ScorerError;
 * the caller's faults are thrown as agentChecksBreakdown throws them.
 */
export function agentChecksTrace(trials: readonly AgentTrialResult[], entry?: AgentEntryFacts): ChecksTraceT | null {
  return agentChecksBreakdown(trials, entry).trace;
}

// ---------------------------------------------------------------- an LLM agent's floor

/** The plain reason an entrant's agent/v1 run none of whose trials made a model call is refused with (agentModelCallRefusal): its error leads with it. */
export const AGENT_NO_MODEL_CALL = 'this entry made no model call; each entry is an LLM agent';

/** What opens the note naming an entrant's silent trials on a run that is scored all the same (agentSilentNote). */
export const AGENT_SILENT_TRIAL = 'a trial with no model call scores 0; each entry is an LLM agent';

/** A model call in the words the floor's reasons give it (grader/gateway/cassette.ts isModelCall). */
const MODEL_CALL_WORDS = 'a completion the model gateway forwarded and the model answered using tokens; listing the models, a refused request, an upstream error or an answer that used no tokens is none';

/**
 * The facts the floor reads: the entry's, as the score records them (grader/score.ts ScoreFacts: a house account's
 * entry, a baseline), and the competition's harness's two waivers (agentHarnessFloorFacts): whether it names a house
 * target, and whether it says the competition does not require model calls.
 */
export interface AgentEntryFacts {
  house: boolean;
  baseline: boolean;
  /**
   * The harness names a house target (contracts/competition.ts AgentHarness.target), which waives the floor for every
   * entry (the header): a scripted attacker that makes no model call of its own is a legal entry there. Absent: false,
   * a harness with no target.
   */
  target?: boolean;
  /**
   * The harness says model_calls: optional (contracts/competition.ts AgentHarness.model_calls), which waives the floor
   * for every entry (the header): the competition does not require model calls, so a scripted program that calls no
   * model is a legal entry there. Absent: false, a harness that does not say it.
   */
  model_calls_optional?: boolean;
}

/** The harness's half of an entry's facts (AgentEntryFacts): its two waivers of the floor, each said (true or false). */
export type AgentHarnessFloorFacts = Required<Pick<AgentEntryFacts, 'target' | 'model_calls_optional'>>;

/**
 * The waivers an agent/v1 harness sets on every entry's facts (the header): `target` when it names a house target,
 * `model_calls_optional` when its model_calls is AGENT_MODEL_CALLS_OPTIONAL. The fan-in, the kit's local grade and a
 * regrade each read them here, off the harness the run was graded under, so all three hold an entry to the same floor.
 */
export function agentHarnessFloorFacts(harness: Pick<AgentHarnessT, 'target' | 'model_calls'>): AgentHarnessFloorFacts {
  return { target: harness.target !== undefined, model_calls_optional: harness.model_calls === AGENT_MODEL_CALLS_OPTIONAL };
}

/** What the floor reads of a trial: its index, its status and its cassette's model calls. */
export type AgentFloorTrial = Pick<AgentTrialResult, 'index' | 'status' | 'model_calls'>;

/**
 * An entrant's entry is held to the floor; the house's own entries and the baselines are not, and on a harness that
 * waives it (a target, or model_calls: optional) no entry is.
 */
function heldToFloor(entry: AgentEntryFacts): boolean {
  return !entry.house && !entry.baseline && entry.target !== true && entry.model_calls_optional !== true;
}

/** A trial's model calls, a count (RangeError otherwise: the caller's). */
function checkModelCalls(t: AgentFloorTrial): number {
  const n = t.model_calls;
  if (n === undefined || !Number.isSafeInteger(n) || n < 0) throw new RangeError(`trial ${t.index} made ${n} model calls: a count`);
  return n;
}

/** Silent, of a trial held to the floor: its store would be scored (it is no timeout) and its live pass made no model call. */
function silentTrial(t: AgentFloorTrial): boolean {
  return checkModelCalls(t) === 0 && t.status !== 'timeout';
}

/** "trial 0", "trials 1 and 3", "trials 1, 3 and 5". */
function trialList(indexes: readonly number[]): string {
  if (indexes.length === 1) return `trial ${indexes[0]}`;
  return `trials ${indexes.slice(0, -1).join(', ')} and ${indexes.at(-1)}`;
}

/**
 * Whether the floor zeroes a trial (the header's `silent trial`): an entrant's (neither `house` nor
 * `baseline`) trial, on a harness that waives nothing (neither `target` nor `model_calls_optional`),
 * whose store would be scored (finished or nondeterministic) and whose live pass made no model call. A
 * count of model calls that is not one is the caller's (RangeError), the house's included.
 */
export function agentTrialSilent(t: AgentFloorTrial, entry: AgentEntryFacts): boolean {
  return silentTrial(t) && heldToFloor(entry);
}

/** "OPENROUTER_API_KEY", "GEMINI_API_KEY or OPENROUTER_API_KEY", "A, B or C": the keys a refusal names. */
function keyChoice(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/** agentModelCallRefusal's options. */
export interface AgentModelCallRefusalOptions {
  /**
   * Whether the entry's live passes ran with no provider key of the entrant's (grader/worker.ts's `entry
   * lane`: no provider-lane entry secret), so the model gateway refused each call itself (a 401) and none
   * could reach a model. The reason then says that, and what fixes it.
   */
  keyless?: boolean;
  /**
   * The provider-lane secret names whose keys serve the run's bundle (contracts/entry-secrets.ts
   * SECRET_PROVIDER_ENV of providersOfModels(harness.inference.models)), in the order the reason names
   * them. A keyless reason names these, never a key that could serve none of its models: a bundle whose
   * allowlist is `openrouter/*:free` names OPENROUTER_API_KEY alone. A caller that knows its bundle
   * (grader/worker.ts) passes them; one that does not names no key at all rather than guess.
   */
  keys?: readonly string[];
}

/**
 * Why an agent/v1 run is refused for calling no model (the header's `refused run`), or null when it is
 * not: an entrant's entry, on a harness that waives nothing (neither `target` nor `model_calls_optional`),
 * none of whose trials made a model call, one of them at least a trial whose store would be scored
 * (finished or nondeterministic). A run with one model call on any trial, a timeout's included, is
 * never refused: its silent trials score 0 instead (agentTrialSilent). The reason opens with
 * AGENT_NO_MODEL_CALL and says which live passes; the caller fails the run with it. A count of model
 * calls that is not one is the caller's (RangeError), the house's included.
 *
 * `keyless` (AgentModelCallRefusalOptions): the entry's live passes ran with no provider key of the
 * entrant's (grader/worker.ts's `entry lane`: no provider-lane entry secret; house money never pays an
 * entrant's model calls), so the model gateway refused each call itself (a 401) and none could reach a
 * model. The reason then says that, and what fixes it: the floor holds only where the competition
 * requires model calls, so a solve in code is no way out there, and pushing a provider key as an entry
 * secret, then submitting again (as a refused key's reason says: a key pushed later reaches no run
 * already graded), is; it names the keys its bundle's models are served by, `keys` (never one that could serve
 * none of them), and says so when no provider key can serve one at all. A caller that does not name
 * `keys` gets a reason naming no provider key: a guessed list could send the entrant after a key that
 * serves none of its models, so none is guessed.
 */
export function agentModelCallRefusal(trials: readonly AgentFloorTrial[], entry: AgentEntryFacts, opts: AgentModelCallRefusalOptions = {}): string | null {
  for (const t of trials) checkModelCalls(t);
  if (!heldToFloor(entry)) return null;
  if (trials.some((t) => t.model_calls! > 0) || trials.every((t) => t.status === 'timeout')) return null;
  const which = trials.length === 1 ? `the live pass of ${trialList([trials[0]!.index])}` : `the live passes of all ${trials.length} of its trials`;
  if (opts.keyless === true) {
    const head = `${AGENT_NO_MODEL_CALL}: no provider key of this entry's entrant reached it, so ${which} could reach no model (the model gateway answers each model call with a 401) and the run is refused and scores nothing`;
    const keys = opts.keys;
    if (keys === undefined) return `${head}; this competition requires model calls, so push your own provider key as an entry secret: the key of the provider that serves its allowed models, with \`makefun secrets push <slug> --dotenv .env\`, then submit again`;
    if (keys.length === 0) return `${head}; this competition requires model calls, and none of its models is served by a provider key an entry secret carries, so no key of yours could reach one`;
    return `${head}; this competition requires model calls, so push your own provider key as an entry secret (${keyChoice(keys)} in a .env, with \`makefun secrets push <slug> --dotenv .env\`), then submit again`;
  }
  return `${AGENT_NO_MODEL_CALL}: ${which} made no model call (${MODEL_CALL_WORDS}), so the run is refused and scores nothing`;
}

/**
 * The note naming an entrant's silent trials (agentTrialSilent) on a run the floor does not refuse,
 * or null when it has none (or is the house's, or the harness waives the floor): it opens with
 * AGENT_SILENT_TRIAL, names the trials and says what they score. The fan-in keeps it as the run's
 * error (after the nondeterminism one, if any) and the kit's local grade as its own.
 */
export function agentSilentNote(trials: readonly AgentFloorTrial[], entry: AgentEntryFacts): string | null {
  const silent = trials.filter((t) => agentTrialSilent(t, entry)).map((t) => t.index);
  if (silent.length === 0) return null;
  const one = silent.length === 1;
  const which = trials.length === 1 ? `the live pass of ${trialList(silent)}` : `the live ${one ? 'pass' : 'passes'} of ${trialList(silent)}, of its ${trials.length} trials,`;
  return `${AGENT_SILENT_TRIAL}: ${which} made no model call (${MODEL_CALL_WORDS}), so ${one ? 'it scores' : 'they score'} 0 on every column and the ${one ? 'store it' : 'stores they'} left ${one ? 'is' : 'are'} not scored`;
}

/** An agent/v1 run is deterministic exactly when every trial's replay matched: no trial is nondeterministic. */
export function agentDeterministic(performance: Pick<AgentPerformanceT, 'trials'>): boolean {
  return performance.trials.every((t) => t.status !== 'nondeterministic');
}

/**
 * The run's action log: the trials manifest of its trials that count (each trial's manifest fields,
 * nothing else), validated, with its canonical JSON and the sha256 run.action_log_sha256 names. A
 * trial's prompt_sha256 is written when it has one and left out when it has none, so a run recorded
 * before briefs were keeps the bytes it had; so is its house_cassette_sha256, which only a trial under
 * a target (contracts/competition.ts AgentTarget) has, and its entry_key, which only a trial whose entry
 * ran one pod has (grader/agent.ts podEntryLaneKey: the stand-in key every later replay hands the entry).
 */
export function trialsManifest(trials: readonly AgentTrialRecordT[]): { manifest: AgentTrialsT; json: string; sha256: string } {
  const manifest = AgentTrials.parse({
    format: AGENT_TRIALS_FORMAT,
    trials: trials.map((t) => ({
      index: t.index,
      instance_sha256: t.instance_sha256,
      status: t.status,
      cassette_sha256: t.cassette_sha256,
      state_sha256: t.state_sha256,
      env_log_sha256: t.env_log_sha256,
      outputs: t.outputs,
      ...(t.prompt_sha256 === undefined ? {} : { prompt_sha256: t.prompt_sha256 }),
      ...(t.house_cassette_sha256 === undefined ? {} : { house_cassette_sha256: t.house_cassette_sha256 }),
      ...(t.entry_key === undefined ? {} : { entry_key: t.entry_key }),
    })),
  });
  const json = canonicalJson(manifest);
  return { manifest, json, sha256: sha256Hex(json) };
}
