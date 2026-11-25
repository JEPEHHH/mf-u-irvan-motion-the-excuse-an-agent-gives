// The judge heat's backup rule: when a judge call gets a second (or third) copy, and which copy decides it. Pure: no
// I/O, no clock, no import from grader/worker.ts, grader/judge-heat.ts or grader/judge-call.ts (the sender imports this
// file beside them; the record's own bound on a call's sends is judge-heat.ts JUDGE_HEAT_MAX_SENDS, which
// JUDGE_BACKUP.maxSends never passes).
//
// Why: a judge heat's round needs every one of its calls answered before the next round is paired, so each round waits
// on its slowest one to three calls. Measured on production 2026-11-11: a call's latency p50 11 s, p90 30 s, p95 37 s,
// max 125 s, and a round of 70 calls took 43-125 s. The sender (grader/worker.ts sendJudgeHeatCalls) sends a backup (a second copy of
// the same request) of the calls still out once a batch is close to done, so a round waits on the quicker of two draws
// instead of on one slow one.
//
// The decision rule (ruled by the owner's side, binding):
//   - a call's decision is the first of its sends to answer with a verdict; a tie in time goes to the earlier send;
//   - every other send of that call is cancelled at once;
//   - a backup goes out only while its call has no verdict; nothing is asked after a verdict.
// judgeCallOutcome says only which send decides; cancelling the others is the sender's job.
//
// Fairness: judgeBackupDue reads ages and counts alone (JudgeBackupState, eight numbers), never a pair, a slot, an
// artifact or an answer, and it refuses a state carrying any other key, so whether a call is backed up cannot depend
// on who is in it or what was answered. Each pair is judged in both slot orders under the same rule, so a judge whose
// slow answers lean to one slot leans both orders alike; an entry can move only through a judge whose slower answers
// to its prompt lean its way, and then by at most that lean times the share of calls a backup decides
// (tests/unit/judge-backup.test.ts simulates all three cases).
//
// Masq heats only (judgeBackupRuleOf): a heat whose key superbot-router holds sends each call once. The router queues
// a call at the flex tier and bounds it itself (its admission, first-byte budget and idle cut), and a client stacks no
// retry ladder on it (~/.cosmos/rules/superbot-router-client.mdc); measured on the dev key 2026-11-12, 64 calls at once
// ran p50 17.7 s, p90 29.1 s, max 63 s, so this rule would fire on ordinary queueing and its copies park behind their
// originals.
//
// The constants' figures: the item's measured latency buckets (413 production calls, p50 11 s, p80 20 s, p90 30 s,
// p95 37 s, p99 65 s, max 125 s) and sim5 (a model of this sender over those buckets, a call's sends correlated at
// rho 0.25-0.5, heats of 6 rounds of 70 and a 462-call playoff at window 64): at these constants a round's p50 is
// 46-53 s against 51-58 s at the last 10% and 1.5 x median, with 18-19% of a heat's calls backed up and 4-5% decided
// by a backup (rounds of 70 alone: 25% backed up, 5% decided by one; the playoff alone 14% and 2.6%).

/** The backup rule's constants: when a call still out gets another copy. All times in milliseconds. */
export interface JudgeBackupRule {
  /** The batch's tail: backups go out once at most max(tailMin, ceil(tailShare x batchSize)) of its calls are unsettled. */
  readonly tailShare: number;
  /** The fewest unsettled calls a batch's tail holds, however small the batch. */
  readonly tailMin: number;
  /** A call in the tail is late at ageFactor x the median latency of the calls answered so far. */
  readonly ageFactor: number;
  /** Answered calls needed before their median sets the threshold; fewer, and priorMs does. */
  readonly minSamples: number;
  /** The threshold before minSamples calls have answered. */
  readonly priorMs: number;
  /** The threshold never falls below this, however quick the answers so far. */
  readonly minAgeMs: number;
  /** A send this old is backed up anywhere in a batch, tail or not. */
  readonly maxAgeMs: number;
  /** The most sends one call gets: the primary and maxSends - 1 backups. */
  readonly maxSends: number;
  /** The backup budget: at most max(budgetMin, ceil(budgetShare x primariesSent)) backups. */
  readonly budgetShare: number;
  /** The budget's floor, so a heat's first calls can be backed up at all. */
  readonly budgetMin: number;
}

export const JUDGE_BACKUP: JudgeBackupRule = Object.freeze({
  // The last 20% of a batch (14 calls of a round of 70): sim5 put the last 10% at a round p50 of 51-58 s and the last
  // 20% at 46-53 s; the last 35% gained 5 s more for twice the backups (35-38% of calls).
  tailShare: 0.2,
  // A small batch (a playoff's last calls, a 24-call ladder round) still backs up its last 2.
  tailMin: 2,
  // 1.25 x the median: with the measured p50 of 11 s, about 14 s, past roughly 70% of calls; sim5's 1.0 x gained 1 s of
  // round p50 for 4 more points of backups, 1.5 x (with the last 10%) lost 5-7 s.
  ageFactor: 1.25,
  // Three answers before their median is trusted (sim5 waited on three too).
  minSamples: 3,
  // 20 s before then: the buckets' p80, so before the median is known only about one call in five is late.
  priorMs: 20_000,
  // 8 s floor: the buckets' p10, so a run of quick answers never makes an ordinary call look late.
  minAgeMs: 8_000,
  // 90 s: past the measured p99 (65 s), about 2 calls in 1,000; a send this old is stuck, wherever its batch stands.
  maxAgeMs: 90_000,
  // The primary and two backups: sim5's fourth send gained 1 s of round p50 for 4 more points of backups.
  maxSends: 3,
  // A quarter of the primaries: sim5's heats send 18-19% backups and its rounds of 70 alone 25%, so the budget trims a
  // heat of small rounds only at the margin (tests/unit/judge-backup.test.ts: 24.2% against 24.6% unbudgeted, the share
  // decided by a backup unchanged at 5.0%) and binds on a runaway (a model whose every call turns slow), where it
  // bounds the extra spend at 25%.
  budgetShare: 0.25,
  // Two backups before any budget accrues, matching tailMin.
  budgetMin: 2,
});

/**
 * A heat's backup rule: the caller's own when it passed one (null: none); else none when the heat's key is
 * superbot-router's (`router`: its id starts server/superbot-router.ts ROUTER_KEY_ID_PREFIX), each call sent once;
 * else JUDGE_BACKUP (a masq key).
 */
export function judgeBackupRuleOf(given: JudgeBackupRule | null | undefined, router: boolean): JudgeBackupRule | null {
  if (given !== undefined) return given;
  return router ? null : JUDGE_BACKUP;
}

/**
 * What judgeBackupDue reads about one unsettled call: ages and counts, exactly these eight keys. No pair, slot,
 * artifact or answer can be here: judgeBackupDue refuses a state with any other key.
 */
export interface JudgeBackupState {
  /** The calls in the call's batch (a heat's round, or its playoff). */
  readonly batchSize: number;
  /** The batch's calls not yet settled (no decision, no final invalid or fault), this one included. */
  readonly batchUnsettled: number;
  /** The batch's calls whose primary is not yet sent (the window is full). */
  readonly batchUnsent: number;
  /** How long ago this call's newest send went out. */
  readonly newestSendAgeMs: number;
  /** This call's sends so far, the primary included. */
  readonly sends: number;
  /** Backups sent so far in the budget's scope (the heat). */
  readonly backupsSent: number;
  /** Primaries sent so far in the budget's scope (the heat). */
  readonly primariesSent: number;
  /** judgeBackupThresholdMs over the answered calls so far. */
  readonly thresholdMs: number;
}

/** JudgeBackupState's keys, in its declared order: the only keys judgeBackupDue accepts. */
export const JUDGE_BACKUP_STATE_KEYS = Object.freeze([
  'batchSize',
  'batchUnsettled',
  'batchUnsent',
  'newestSendAgeMs',
  'sends',
  'backupsSent',
  'primariesSent',
  'thresholdMs',
] as const satisfies readonly (keyof JudgeBackupState)[]);

/** One send of a call: still out, answered at a time (with a verdict or not), or faulted (no answer will come). */
export type JudgeSendState =
  | { readonly state: 'flying' }
  | { readonly state: 'answered'; readonly verdict: boolean; readonly atMs: number }
  | { readonly state: 'faulted' };

/**
 * A call's outcome over its sends. `send` is the deciding send's index in send order (0 the primary).
 *   pending   no verdict yet and a send still out;
 *   decided   the first send to answer with a verdict;
 *   invalid   every send done, none with a verdict, at least one answered: the lowest-numbered answered send's;
 *   fault     every send faulted.
 */
export type JudgeCallOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'decided'; readonly send: number }
  | { readonly kind: 'invalid'; readonly send: number }
  | { readonly kind: 'fault' };

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`judge backup: ${name} must be a whole number >= 0, got ${value}`);
}

function assertMs(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`judge backup: ${name} must be a finite time >= 0 ms, got ${value}`);
}

/**
 * The age at which a call in a batch's tail is late: max(minAgeMs, ageFactor x the median of the answered calls'
 * latencies) once minSamples of them have answered, else max(minAgeMs, priorMs). The median of an even count is the
 * mean of its middle two.
 */
export function judgeBackupThresholdMs(rule: JudgeBackupRule, answeredLatenciesMs: readonly number[]): number {
  answeredLatenciesMs.forEach((ms, i) => assertMs(`answered latency ${i}`, ms));
  if (answeredLatenciesMs.length < rule.minSamples || answeredLatenciesMs.length === 0) {
    return Math.max(rule.minAgeMs, rule.priorMs);
  }
  const sorted = [...answeredLatenciesMs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.max(rule.minAgeMs, rule.ageFactor * median);
}

/**
 * Whether the call `s` describes gets another send now. True when it has fewer than maxSends sends, the budget has
 * room (backupsSent < max(budgetMin, ceil(budgetShare x primariesSent))), and either its newest send is maxAgeMs old,
 * or its batch is fully sent, in its tail (batchUnsettled <= max(tailMin, ceil(tailShare x batchSize))) and its newest
 * send is thresholdMs old. The caller asks only for a call with no verdict yet. A state with any key but the eight of
 * JudgeBackupState is refused (TypeError), so nothing about the call's pair, slots or answers can reach the rule.
 */
export function judgeBackupDue(rule: JudgeBackupRule, s: JudgeBackupState): boolean {
  const keys = Object.keys(s);
  const extra = keys.filter((k) => !(JUDGE_BACKUP_STATE_KEYS as readonly string[]).includes(k));
  const missing = JUDGE_BACKUP_STATE_KEYS.filter((k) => !keys.includes(k));
  if (extra.length > 0 || missing.length > 0) {
    throw new TypeError(
      `judge backup: the state holds exactly ${JUDGE_BACKUP_STATE_KEYS.join(', ')}` +
        (extra.length > 0 ? `; extra: ${extra.join(', ')}` : '') +
        (missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''),
    );
  }
  assertCount('batchSize', s.batchSize);
  assertCount('batchUnsettled', s.batchUnsettled);
  assertCount('batchUnsent', s.batchUnsent);
  assertMs('newestSendAgeMs', s.newestSendAgeMs);
  assertCount('sends', s.sends);
  assertCount('backupsSent', s.backupsSent);
  assertCount('primariesSent', s.primariesSent);
  assertMs('thresholdMs', s.thresholdMs);

  if (s.sends >= rule.maxSends) return false;
  const budget = Math.max(rule.budgetMin, Math.ceil(rule.budgetShare * s.primariesSent));
  if (s.backupsSent >= budget) return false;
  if (s.newestSendAgeMs >= rule.maxAgeMs) return true;
  const tail = Math.max(rule.tailMin, Math.ceil(rule.tailShare * s.batchSize));
  return s.batchUnsent === 0 && s.batchUnsettled <= tail && s.newestSendAgeMs >= s.thresholdMs;
}

/**
 * Which send decides a call, `sends` in send order (index 0 the primary): the answered send with a verdict that
 * answered first (earliest atMs, a tie to the lower index) decides; with none, the call is pending while any send is
 * flying; else invalid from the lowest-numbered answered send; else (every send faulted) a fault. A call with no
 * sends is refused (RangeError): its primary is always sent first.
 */
export function judgeCallOutcome(sends: readonly JudgeSendState[]): JudgeCallOutcome {
  if (sends.length === 0) throw new RangeError('judge backup: a call has at least its primary send');
  let decided = -1;
  let decidedAt = Infinity;
  let firstAnswered = -1;
  let flying = false;
  sends.forEach((send, i) => {
    if (send.state === 'flying') {
      flying = true;
    } else if (send.state === 'answered') {
      assertMs(`send ${i} atMs`, send.atMs);
      if (firstAnswered < 0) firstAnswered = i;
      if (send.verdict && send.atMs < decidedAt) {
        decided = i;
        decidedAt = send.atMs;
      }
    } else if (send.state !== 'faulted') {
      throw new TypeError(`judge backup: send ${i} has no state flying, answered or faulted`);
    }
  });
  if (decided >= 0) return { kind: 'decided', send: decided };
  if (flying) return { kind: 'pending' };
  if (firstAnswered >= 0) return { kind: 'invalid', send: firstAnswered };
  return { kind: 'fault' };
}
