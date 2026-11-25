// The score JSON a grading run stores in run.result (and hashes into run.result_sha256). It is a
// pure function of (dataset, canonical action log, pricing rows, authorship, the entry's own stored
// records, and under a bundle's build meter the entrant's metered requests its grade counted, through
// the entry's receipt time and named by their list's digest: Cost.metered, and under a harness naming
// an entry link whose record verified a launch, that launch's facts: performance.entry_link):
// no ids, no grading run's clock, no host facts, so an L1 regrade reproduces it byte for byte (the
// entry's records are stored once, at intake, and read the same on the regrade). Lamports,
// quote units and micro-USD are decimal strings, ratios Fixed9 strings (BigInt scaled by 1e9), counts
// integers. On agent/v1 the action log is the trials manifest (contracts/agent.ts AgentTrials), on
// scrape/v1 the entry's run in its heat (contracts/scrape.ts ScrapeTrials). A program/v1 score under a
// code bounty's harness (contracts/competition.ts ProgramHarness: gate, size, timing) may also carry
// whether the entry passed its gate (performance.passed), its code size (Score.size, a count of its
// snapshot) and, after a timing heat, its CPU times (performance.timing, from the heat's stored
// records), or under a judge heat's harness (ProgramHarness.judge) its win rate against the field
// (performance.judge, from the heat's stored judge calls), and under a harness naming an entry link
// whose record verified a launch its launch time (performance.entry_link): each a pure function of
// what a regrade has too.
//
// The identities a performance must satisfy are refinements that run only on a value whose shape
// already parsed (bars-protocol.ts whenBarsValid, barsIssuer: generic despite the name).

import { z } from 'zod';
import { AgentTrialStatus, checkTrialOrder } from './agent.ts';
import { barsIssuer, BarSymbol, checkBarsSymbolOrder, whenBarsValid } from './bars-protocol.ts';
import { ClmmReplayPerformance } from './clmm-score.ts';
import { ColumnKey, HarnessKind, PracticeWindowCount, PracticeWindowKey, practiceWindowKeys, type ProgramSizeT } from './competition.ts';
import { PatchPerformance } from './patch.ts';
import { Fixed9, FIXED9_SCALE, I64, IsoDateTime, parseFixed9, Pubkey, Sha256Hex, U64 } from './primitives.ts';
import { ScrapeMillis, ScrapePerformance } from './scrape.ts';

export const SCORE_SCHEMA = 'agent-fun/score/v1';

/** Seeded bootstrap interval of net PnL, resampling tokens. */
export const PnlInterval = z.strictObject({
  /** e.g. "0.900000000". */
  level: Fixed9,
  method: z.literal('bootstrap-tokens'),
  resamples: z.int().min(1),
  seed: U64,
  low_lamports: I64,
  high_lamports: I64,
});

export const TokenPnl = z.strictObject({
  mint: Pubkey,
  realized_pnl_lamports: I64,
  fills: z.int().min(0),
  fees_lamports: U64,
});

/** The round-trip rule (competition Guardrails.round_trips), evaluated. */
export const RoundTripConstraint = z.strictObject({
  /** A round trip counts when its buy fills spent at least this. */
  min_buy_lamports: U64,
  /** Round trips at or above the floor, and the distinct coins holding one (mints_ok checks these). */
  counted: z.int().min(0),
  counted_mints: z.int().min(0),
});

/** The competition's guardrails, evaluated. A non-compliant entry ranks below every compliant one. */
export const Constraints = z.strictObject({
  min_fills: z.int().min(0),
  min_distinct_mints: z.int().min(0),
  max_drawdown: Fixed9,
  fills_ok: z.boolean(),
  /** Coins with a filled order (metrics.distinct_mints), or round_trips.counted_mints when present. */
  mints_ok: z.boolean(),
  drawdown_ok: z.boolean(),
  compliant: z.boolean(),
  /** Present exactly when the competition sets the round-trip rule; absent in every score before it. */
  round_trips: RoundTripConstraint.optional(),
});

/** Evidence that no future data reached the bot and the final window post-dates every entry. */
export const Contamination = z.strictObject({
  /**
   * No delivered event's slot exceeded the slot of the batch it arrived in (sim/engine.ts). False is
   * the engine's fault, never the entry's: grading refuses it as a harness fault the job retries
   * (grader/score.ts buildScore throws SimAbortError), so it is never stored and a stored score
   * always carries true.
   */
  no_future_events: z.boolean(),
  /** First block time of the final window (null on the dev phase). */
  final_window_first_block_time: IsoDateTime.nullable(),
  /** Server time of the last graded receipt (null on the dev phase). */
  last_graded_receipt_at: IsoDateTime.nullable(),
  /** final_window_first_block_time > last_graded_receipt_at (null on the dev phase). */
  window_after_receipts: z.boolean().nullable(),
  dataset_sha256: Sha256Hex,
});

/** One coin's distinct counterparties (Counterparties.per_coin). */
export const CoinCounterparties = z.strictObject({
  mint: Pubkey,
  distinct: z.int().min(0),
});

/**
 * The distinct-counterparties metric, present exactly when the harness sets counterparties: true
 * (sim/metrics.ts countCounterparties). Per coin the bot held: the distinct recorded trader wallets
 * (TradeEvent.user) whose trades on it landed while it was held, over every round trip on the coin,
 * from the slot after the fill that opened the position through the slot of the fill or close that
 * emptied it (a fill lands after its slot's recorded trades). The creator's own trades count like
 * anyone's. A profit made on coins only one or two wallets traded (a creator wash-trading its coin)
 * shows here; the rank key stays net PnL.
 */
export const Counterparties = z
  .strictObject({
    /** The distinct wallets over every coin the bot held, each counted once however many coins it traded. */
    distinct: z.int().min(0),
    /** The fewest any one coin it held had; null when it held none. */
    min_per_coin: z.int().min(0).nullable(),
    /** One row per coin it held, in code-unit mint order. */
    per_coin: z.array(CoinCounterparties),
  })
  .superRefine((c, ctx) => {
    const issue = barsIssuer(ctx);
    let min: number | null = null;
    let max = 0;
    let sum = 0;
    c.per_coin.forEach((p, i) => {
      if (i > 0 && !(c.per_coin[i - 1]!.mint < p.mint)) issue(['per_coin', i, 'mint'], 'per_coin rows are one per coin, in code-unit mint order');
      min = min === null ? p.distinct : Math.min(min, p.distinct);
      max = Math.max(max, p.distinct);
      sum += p.distinct;
    });
    if (c.min_per_coin !== min) issue(['min_per_coin'], `the fewest per coin is ${min}, not min_per_coin ${c.min_per_coin}`);
    if (c.distinct < max || c.distinct > sum) issue(['distinct'], `distinct ${c.distinct} is not between the most on one coin (${max}) and the per-coin sum (${sum})`);
  }, whenBarsValid);

export const ReplayMetrics = z.strictObject({
  /** The rank key. */
  net_pnl_lamports: I64,
  /** net PnL / starting capital. */
  return: Fixed9,
  /** On hourly marks; null when undefined (fewer than two marks, zero variance). */
  sharpe: Fixed9.nullable(),
  sortino: Fixed9.nullable(),
  /** Peak-to-trough share of equity, 0..1. */
  max_drawdown: Fixed9,
  /** Winning round trips / round trips; null with no round trip. */
  win_rate: Fixed9.nullable(),
  round_trips: z.int().min(0),
  fills: z.int().min(0),
  rejected: z.int().min(0),
  failed_txs: z.int().min(0),
  distinct_mints: z.int().min(0),
  fees_lamports: U64,
  tx_fees_lamports: U64,
  fee_fallback_fills: z.int().min(0),
  per_token: z.array(TokenPnl),
  interval: PnlInterval,
  /** The same action log re-scored with every fee multiplied. */
  cost_sensitivity: z.strictObject({
    fee_multiplier: z.int().min(2),
    net_pnl_lamports: I64,
  }),
  constraints: Constraints,
  contamination: Contamination,
  /** Present exactly when the harness sets counterparties: true; absent in every score before it, which keeps its bytes. */
  counterparties: Counterparties.optional(),
});

/** One practice window of a dev grade's ReplayEras: how it was graded (the first five) and the figures the dev board shows. */
export const EraWindow = z.strictObject({
  /** w1..w<count> (contracts/competition.ts practiceWindowKeys). */
  key: PracticeWindowKey,
  /** The window's dataset. */
  dataset_sha256: Sha256Hex,
  /** phaseSeed over that dataset: each window's replay is seeded on its own. */
  seed: U64,
  /** The window's own canonical action log. */
  action_log_sha256: Sha256Hex,
  /** The sha256 of the window's own Score (grader/score.ts scoreDigest), which the run_era row stores whole. */
  result_sha256: Sha256Hex,
  /** The window's ReplayMetrics.net_pnl_lamports. */
  net_pnl_lamports: I64,
  fills: z.int().min(0),
  distinct_mints: z.int().min(0),
  max_drawdown: Fixed9,
  /** The window's metrics.constraints.compliant. */
  compliant: z.boolean(),
});

/**
 * A dev grade's practice windows (contracts/competition.ts Phase.practice_windows), at
 * performance.eras: the grade's score is the median window's own Score (grader/score.ts aggregateEras),
 * and this is every window's figures beside it. Present exactly when the phase sets practice_windows;
 * absent in every score before it, which keeps its bytes.
 *   aggregate    the rank rule: the window of the median net PnL (sorted by (net_pnl_lamports, key),
 *                index floor(count / 2)), the only one so far
 *   count, hours the phase's practice_windows
 *   rank_window  the key of the median window: the Score's own metrics, dataset, seed and action log
 *   windows      every window in key order
 *   *_net_pnl_lamports  the median (the rank key), the half-even mean, the worst and the best window's;
 *                shown, never ranked but the median
 *   in_profit    windows with a net PnL above 0
 *   compliant_windows   windows meeting the competition's guardrails (the Score's own eligibility follows the median window's alone)
 */
export const ReplayEras = z
  .strictObject({
    aggregate: z.literal('median'),
    count: PracticeWindowCount,
    hours: z.int().min(1),
    rank_window: PracticeWindowKey,
    windows: z.array(EraWindow),
    median_net_pnl_lamports: I64,
    mean_net_pnl_lamports: I64,
    worst_net_pnl_lamports: I64,
    best_net_pnl_lamports: I64,
    in_profit: z.int().min(0),
    compliant_windows: z.int().min(0),
  })
  .superRefine((e, ctx) => {
    const issue = barsIssuer(ctx);
    if (e.windows.length !== e.count) issue(['windows'], `windows must hold count ${e.count} windows, has ${e.windows.length}`);
    const keys = practiceWindowKeys(e.count);
    e.windows.forEach((w, i) => {
      if (w.key !== keys[i]) issue(['windows', i, 'key'], `windows must be in key order: expected ${keys[i] ?? 'no window'} at ${i}, got ${w.key}`);
    });
    const rank = e.windows.find((w) => w.key === e.rank_window);
    if (rank === undefined) issue(['rank_window'], `rank_window ${e.rank_window} is not one of the windows`);
    else if (rank.net_pnl_lamports !== e.median_net_pnl_lamports) {
      issue(['median_net_pnl_lamports'], `median_net_pnl_lamports ${e.median_net_pnl_lamports} must equal rank_window ${e.rank_window}'s net_pnl_lamports ${rank.net_pnl_lamports}`);
    }
    if (e.windows.length === 0) return;
    const pnls = e.windows.map((w) => BigInt(w.net_pnl_lamports));
    const worst = pnls.reduce((a, b) => (b < a ? b : a));
    const best = pnls.reduce((a, b) => (b > a ? b : a));
    if (BigInt(e.worst_net_pnl_lamports) !== worst) issue(['worst_net_pnl_lamports'], `worst_net_pnl_lamports must be the lowest window's, ${worst}`);
    if (BigInt(e.best_net_pnl_lamports) !== best) issue(['best_net_pnl_lamports'], `best_net_pnl_lamports must be the highest window's, ${best}`);
    const inProfit = pnls.filter((p) => p > 0n).length;
    if (e.in_profit !== inProfit) issue(['in_profit'], `in_profit must count the windows above 0, ${inProfit}`);
    const compliant = e.windows.filter((w) => w.compliant).length;
    if (e.compliant_windows !== compliant) issue(['compliant_windows'], `compliant_windows must count the compliant windows, ${compliant}`);
  }, whenBarsValid);

export const ReplayPerformance = z.strictObject({
  kind: z.literal('pumpfun-replay/v2'),
  metrics: ReplayMetrics,
  /** The dev grade's practice windows (ReplayEras). Absent: no key appears, so a score without it keeps its bytes. */
  eras: ReplayEras.optional(),
});

/**
 * A program/v1 timing heat's result for one entry (contracts/competition.ts ProgramTiming, at
 * performance.timing), in whole microseconds of CPU time net of a null entry's (canonical JSON: integers
 * only, each value half-even to the microsecond). Each timed run counts net: its CPU time less the heat's
 * pooled control, the median of the control's runs over the heat's main and playoff rounds (the house's
 * null entry, run once a round as an entry is: what starting and ending the containers and the
 * interpreter costs any program), so what is compared is the entry's own work (grader/code-heat.ts
 * codeHeatPooledControlUs, codeHeatNetRuns; the heat record keeps every reading gross, the control's
 * among them, and the median is taken again from it). A run under the control counts below 0, never
 * clamped for the order: one reading taken off every run is a constant shift, so the order and the ties
 * are the gross readings' exactly, where a clamp at 0 would reorder entries whose own work is within the
 * noise. One pooled reading, not each round's own: a round's control would add its own run-to-run noise
 * to every run it nets, and widen every interval. median_cpu_us and trimmed_mean_cpu_us are never below 0,
 * so when the lowest trimmed mean in a heat falls below 0, every figure of every timing in that heat is
 * raised together by the one amount it falls short (codeHeatTimingsOf; no raise when none does, and the
 * raise is never stored: anyone re-derives it from the record): the lowest then reads 0, and every
 * difference of trimmed means and every interval's width at or past the clock's tick (below) stays the
 * unclamped net runs' exactly, so the order and every tie read from these figures (codeTimingDifference)
 * are the runs'. A median still below 0 after the raise, which nothing weighs, reads 0. The dev phase's
 * provisional timing (provisionalCodeTiming), shown and never weighed, counts each of its runs net of the
 * median of its three control runs, 0 when under it (codeRunNetUs): with no field timed beside it there is
 * nothing to raise it by.
 *   rounds               the timed runs that count, main and playoff alike
 *   median_cpu_us        the median of those runs' net CPU times, plus the heat's raise (0 when still
 *                        under 0)
 *   trimmed_mean_cpu_us  the rank key, lower is faster: the mean with the harness's `trim` runs dropped
 *                        at each end of the sorted net times, plus the heat's raise
 *   interval_low_us,     the trimmed mean's Yuen interval at the harness's interval_level over the net
 *   interval_high_us     times, widened to one clock tick either side of the trimmed mean where narrower on
 *                        a clock coarser than the microsecond (a gVisor heat's 10 ms: grader/code-heat.ts
 *                        codeClockTickUs, codeHeatTimingsOf; a microsecond clock's stands as Yuen's),
 *                        plus the heat's raise, never clipped (the low end may be below 0), holding the
 *                        trimmed mean
 */
export const ProgramTimingScore = z
  .strictObject({
    median_cpu_us: z.int().min(0),
    trimmed_mean_cpu_us: z.int().min(0),
    rounds: z.int().min(1),
    interval_low_us: z.int(),
    interval_high_us: z.int(),
  })
  .refine((t) => t.interval_low_us <= t.trimmed_mean_cpu_us && t.trimmed_mean_cpu_us <= t.interval_high_us, {
    message: 'the interval holds the trimmed mean: interval_low_us <= trimmed_mean_cpu_us <= interval_high_us',
    path: ['trimmed_mean_cpu_us'],
    ...whenBarsValid,
  });

/** The whole of a judge heat's share in millionths (ProgramJudgeScore's *_micro: micro = 10^-6). */
export const JUDGE_MICRO = 1_000_000;

const judgeMicro = z.int().min(0).max(JUDGE_MICRO);

/**
 * A program/v1 judge heat's result for one entry (contracts/competition.ts ProgramJudge, at
 * performance.judge): integers only (canonical JSON), each share in millionths of JUDGE_MICRO. The house
 * judge compares the artifact the entry wrote with another field member's (an entry's or a house
 * anchor's), match by match.
 *   win_rate_micro        the rank key, higher first: the entry's expected win rate against the field
 *   se_micro              its standard error
 *   interval_low_micro,   the interval around it, within [0, JUDGE_MICRO], holding it
 *   interval_high_micro
 *   wins, draws, losses   its matches by outcome, summing to matches (a match's two calls each give their pick 5 +
 *                         margin tenths of a win: more than half the match's points a win, exactly half a draw;
 *                         the win rate weighs the points themselves, grader/judge-heat.ts)
 *   matches               the matches it played: at least 1, except on a screened-out score (0)
 *   finalist              whether it played the playoff (a provisional score never does)
 *   provisional           the dev phase's, against the anchors alone: shown, never weighed
 *   artifact_sha256       sha256 of the artifact the judge compared (ProgramJudge.artifact)
 * A score from a v2 heat record (grader/judge-heat.ts JUDGE_HEAT_FORMAT) also carries what breaks an EXACT tie of
 * win_rate_micro (a statistical tie stays display-only): head-to-head among the tied entries, then the smaller
 * artifact, then the earlier receipt. A v1 record's scores carry neither, so their stored bytes hold.
 *   artifact_bytes        the artifact's size in bytes (the exact-tie chain's second link)
 *   head_to_head          per exact-tie peer (another entrant member with the same win_rate_micro and finalist
 *                         flag), in sha256 order: `points`, this member's twentieths of a win summed over the
 *                         PLAYOFF games against that peer (Swiss pairings are unbalanced and never count); absent
 *                         when the member has no such peer, and on a provisional score
 * A screened final's score (contracts/competition.ts ProgramJudgeScreened; a v4 heat record) also marks an entry the
 * screen left off the shortlist, which plays no final game:
 *   screened_out          true: the win rate, se and interval are its dev rating's, carried from the screen, over 0
 *                         matches (wins, draws and losses 0); never a finalist, never provisional (it is the final's
 *                         score), no head_to_head. Absent on every other score, so its stored bytes hold.
 */
export const ProgramJudgeHeadToHead = z.strictObject({
  artifact_sha256: Sha256Hex,
  points: z.int().min(0),
});
export type ProgramJudgeHeadToHeadT = z.infer<typeof ProgramJudgeHeadToHead>;

export const ProgramJudgeScore = z
  .strictObject({
    win_rate_micro: judgeMicro,
    se_micro: judgeMicro,
    interval_low_micro: judgeMicro,
    interval_high_micro: judgeMicro,
    wins: z.int().min(0),
    draws: z.int().min(0),
    losses: z.int().min(0),
    matches: z.int().min(0),
    finalist: z.boolean(),
    provisional: z.boolean(),
    artifact_sha256: Sha256Hex,
    artifact_bytes: z.int().min(0).optional(),
    head_to_head: z.array(ProgramJudgeHeadToHead).min(1).optional(),
    screened_out: z.literal(true).optional(),
  })
  .superRefine((j, ctx) => {
    if (j.screened_out === true) {
      const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
      if (j.matches !== 0) issue('matches', `a screened-out entry plays no final game: its matches are 0, not ${j.matches}`);
      if (j.finalist) issue('finalist', 'a screened-out entry is off the shortlist: it never plays the playoff');
      if (j.provisional) issue('provisional', "a screened-out score is the final's, its rate carried from the dev rating: it is never provisional");
      if (j.head_to_head !== undefined) issue('head_to_head', 'a screened-out entry plays no final game: it carries no head_to_head');
    } else if (j.matches < 1) {
      ctx.addIssue({ code: 'custom', path: ['matches'], message: 'a judged entry plays at least 1 match: matches is 0 only on a screened-out score' });
    }
    if (j.head_to_head !== undefined) {
      if (j.provisional) ctx.addIssue({ code: 'custom', path: ['head_to_head'], message: 'a provisional score has no exact-tie peers: it carries no head_to_head' });
      j.head_to_head.forEach((h, k) => {
        if (h.artifact_sha256 === j.artifact_sha256) ctx.addIssue({ code: 'custom', path: ['head_to_head', k, 'artifact_sha256'], message: "a head-to-head peer is another member, not the score's own artifact" });
        if (k > 0 && j.head_to_head![k - 1]!.artifact_sha256 >= h.artifact_sha256) {
          ctx.addIssue({ code: 'custom', path: ['head_to_head', k, 'artifact_sha256'], message: 'the head-to-head peers are distinct, in sha256 order' });
        }
      });
    }
    if (j.wins + j.draws + j.losses !== j.matches) {
      ctx.addIssue({ code: 'custom', path: ['matches'], message: `wins, draws and losses sum to the matches: ${j.wins} + ${j.draws} + ${j.losses} is not ${j.matches}` });
    }
    if (j.interval_low_micro > j.win_rate_micro || j.win_rate_micro > j.interval_high_micro) {
      ctx.addIssue({ code: 'custom', path: ['win_rate_micro'], message: 'the interval holds the win rate: interval_low_micro <= win_rate_micro <= interval_high_micro' });
    }
    if (j.provisional && j.finalist) {
      ctx.addIssue({ code: 'custom', path: ['finalist'], message: "a provisional score is the dev phase's, against the anchors alone: it never plays the playoff" });
    }
  }, whenBarsValid);

/**
 * The entry's verified launch a program/v1 score carries (ProgramPerformance.entry_link): the coin the entry's
 * entry-link file named, and when it was created, as the house read it before grading (contracts/competition.ts
 * ProgramHarness.entry_link, the `pumpfun` platform; server/db/schema.ts PumpfunEntryLinkRecord, the record the
 * entry-link stage wrote after checking it on chain). Never the scorer's: the record is the entry's own fact, stored
 * once at intake, so a regrade re-derives this block from the submission row.
 *   mint        the coin's Solana mint (base58), the one the record verified its create transaction made
 *   created_ms  when that creating transaction landed, unix milliseconds
 *   elapsed_ms  created_ms less the competition's opens_at, milliseconds (below 0 for a coin created before the
 *               bounty opened): a leaderboard column reads it by source (performance.entry_link.elapsed_ms), so the
 *               column is not scored (contracts/competition.ts isScoredColumn) and the rank key can be this path
 *   slot        that transaction's slot, the chain's own ordering: created_ms is only whole seconds, so two launches
 *               in one second tie on it, and the slot breaks the tie. Null where the record holds none (written before
 *               the house read the slot), never absent, so the block's shape is the same on every score
 * Filled from the submission's stored record when the entry is graded (grader/grade.ts entryLinkFactsOf) and
 * re-derived on a regrade (grader/regrade.ts). Absent on every score whose entry has no such record, and on every
 * score before this key: no key appears, so those scores keep their bytes.
 */
export const ProgramEntryLinkScore = z.strictObject({
  mint: Pubkey,
  created_ms: z.int().nonnegative(),
  elapsed_ms: z.int(),
  slot: z.int().nonnegative().nullable(),
});
export type ProgramEntryLinkScoreT = z.infer<typeof ProgramEntryLinkScore>;

/**
 * program/v1: the scorer container's scores.json, keyed by leaderboard column keys, plus the blocks the
 * grader fills from the entry's own records (never the scorer). Under a harness with a gate
 * (contracts/competition.ts ProgramHarness.gate), `passed`: whether the entry scored 1 in the gate column
 * in a ranked run (grader/score.ts gatedPerformance: a nondeterministic run passes nothing, its column
 * what it may); one that did not pass is not prize-eligible (FAILED_TESTS_REASON when its column is not 1,
 * else its run's own reason) and ranks below every entry that did. Under a harness with a timing heat,
 * `timing` (ProgramTimingScore), measured only on an entry that passed; under a harness with a judge heat,
 * `judge` (ProgramJudgeScore), likewise; under a harness naming an entry link whose record verified a
 * launch, `entry_link` (ProgramEntryLinkScore). Each absent, no key appears, so a score without it keeps
 * its bytes.
 */
export const ProgramPerformance = z
  .strictObject({
    kind: z.literal('program/v1'),
    scores: z.record(ColumnKey, z.number().finite().nullable()),
    passed: z.boolean().optional(),
    timing: ProgramTimingScore.optional(),
    judge: ProgramJudgeScore.optional(),
    /** The entry's house-verified launch time (ProgramEntryLinkScore). Absent: no key appears, so a score without it keeps its bytes. */
    entry_link: ProgramEntryLinkScore.optional(),
  })
  .refine((p) => p.timing === undefined || p.passed === true, {
    message: 'a timing heat runs only the entries that passed the gate: timing needs passed true',
    path: ['timing'],
    ...whenBarsValid,
  })
  .refine((p) => p.judge === undefined || p.passed === true, {
    message: 'a judge heat plays only the entries that passed the gate: judge needs passed true',
    path: ['judge'],
    ...whenBarsValid,
  });

// ---------------------------------------------------------------- bars-replay/v1
//
// Quote units are USDC at the harness's capital.quote_scale (contracts/bars-protocol.ts). Equity
// points are the starting cash, the equity at every batch (bar close), and the cash after the final
// flatten.
//
//   net_pnl_quote_units  final cash after flattening - starting cash (the rank key)
//   return               net PnL / starting cash, at least -1 (cash never goes below 0)
//   sharpe, sortino      per bar, NOT annualised, on the equity points' returns
//   max_drawdown         largest (peak - equity) / peak over the equity points, 0..1
//   win_rate             round trips with PnL > 0 / round trips (a round trip runs from the fill that
//                        opens a position to the fill or flatten that empties it); null with none
//   trades               the bot's own filled orders (flatten closes excluded); rejected its rejected
//                        orders; distinct_symbols the symbols it filled an order on
//   fees_quote_units     every fee paid, flatten closes included
//   exposure             mean over the batches of (equity - cash) / equity, 0..1
//   per_symbol           one row per universe symbol in code-unit order (0 for one never traded):
//                        realized PnL (every quote unit in and out on it, fees included), its trades
//                        and fees. The rows add up to net_pnl_quote_units, trades and
//                        fees_quote_units, and distinct_symbols counts the rows with a trade.
//   interval             paired, seeded bootstrap of net PnL resampling the universe's symbols (every
//                        per_symbol row), as the pump interval resamples tokens
//   block_hours,         net PnL over time: per_block one row per block of block_hours hours of the
//   per_block            window from its start, block 0 first. Block b holds the bars opening in hours
//                        [b x block_hours, (b + 1) x block_hours) of the window, the last block possibly
//                        shorter, and its PnL is the equity at its last bar's close minus the equity at
//                        the previous block's (the starting cash for block 0); the last block ends with
//                        the cash after the final flatten. The rows add up to net_pnl_quote_units
//                        exactly. block_hours is the harness's (sim/metrics.ts barsBlockHoursOf: 6 by
//                        default, as clmm's, a whole number of bars). The prize gate weighs an entry's
//                        margin over the baseline block by block as well as symbol by symbol
//                        (server/payouts/baseline.ts). Both keys are in every score the scorer writes
//                        since #2478 and absent together in a score before it (no bars competition
//                        stored one: both were drafts), which the gate fails closed on
//   cost_sensitivity     the same action log replayed with fee_bps doubled, sells capped at the
//                        quantity held
//   constraints          the harness's guardrails evaluated: trades >= min_trades, distinct_symbols >=
//                        min_distinct_symbols, max_drawdown at or under its cap; compliant is all three
//   contamination        the causality audit found nothing the bot was sent ahead of its time
//                        (no_future_bars: batches in lockstep and on time, no bar after its batch,
//                        no fill resolved at or before the bar it was decided on or on a batch the
//                        bot had not answered, no equity marked at a close the bot had not been
//                        sent; BarsContamination lists each check). It is true in every stored
//                        score: a run failing it is aborted, an engine fault grading throws and
//                        retries. And the final window starts after every graded receipt

/** Seeded bootstrap interval of net PnL, resampling symbols. */
export const BarsPnlInterval = z
  .strictObject({
    /** e.g. "0.900000000". */
    level: Fixed9,
    method: z.literal('bootstrap-symbols'),
    resamples: z.int().min(1),
    seed: U64,
    low_quote_units: I64,
    high_quote_units: I64,
  })
  .refine((i) => BigInt(i.low_quote_units) <= BigInt(i.high_quote_units), { message: 'low_quote_units is above high_quote_units', path: ['high_quote_units'], ...whenBarsValid });

export const SymbolPnl = z.strictObject({
  symbol: BarSymbol,
  /** Realized PnL on the symbol, fees included. */
  pnl_quote_units: I64,
  /** The bot's own filled orders on it. */
  trades: z.int().min(0),
  fees_quote_units: U64,
});

/** One block's net PnL (BarsReplayMetrics per_block; the header). */
export const BarsBlockPnl = z.strictObject({
  /** The block's index from the window's start: the bars opening in hours [block x block_hours, (block + 1) x block_hours). */
  block: z.int().min(0),
  pnl_quote_units: I64,
});

/** The bars harness's guardrails, evaluated. A non-compliant entry ranks below every compliant one. */
export const BarsConstraints = z
  .strictObject({
    min_trades: z.int().min(0),
    min_distinct_symbols: z.int().min(0),
    max_drawdown: Fixed9,
    trades_ok: z.boolean(),
    symbols_ok: z.boolean(),
    drawdown_ok: z.boolean(),
    compliant: z.boolean(),
  })
  .refine((c) => c.compliant === (c.trades_ok && c.symbols_ok && c.drawdown_ok), { message: 'compliant is trades_ok and symbols_ok and drawdown_ok', path: ['compliant'], ...whenBarsValid });

/** Evidence that no future bar reached the bot and the final window post-dates every entry. */
export const BarsContamination = z.strictObject({
  /**
   * The replay's causality audit (sim/bars/engine.ts BarsLookaheadAudit) found nothing the bot was
   * sent ahead of its time. It reads only what crossed the wire, each batch as it went out and each
   * reply as it came in, and checks that:
   *   - every batch went out only after the reply to the one before, as batch first_close_ms + seq x
   *     the interval, in seq order, and every reply answered the batch then waiting;
   *   - no bar's t is after the t of the batch carrying it (bar t + 1 before the decision on t);
   *   - every fill was resolved at a bar no later than the batch carrying it, after the bar it was
   *     decided on (never at an open whose close the bot had seen), and decided on a batch the bot
   *     had answered;
   *   - every account's equity is its cash plus each position at the latest close the bot had been
   *     sent (never a mark at a close it had not seen), and every position's symbol had a close sent.
   * False is the engine's fault, never the entry's: the engine withholds the batch and aborts the
   * run, and grading refuses it as a harness fault (sim/metrics.ts, grader/score.ts buildScore) that
   * the job retries. So a stored score always carries true.
   */
  no_future_bars: z.boolean(),
  /** The final window's first bar's open time (window.start_ms; null on the dev phase). */
  final_window_first_bar_time: IsoDateTime.nullable(),
  /** Server time of the last graded receipt (null on the dev phase). */
  last_graded_receipt_at: IsoDateTime.nullable(),
  /** final_window_first_bar_time > last_graded_receipt_at (null on the dev phase). */
  window_after_receipts: z.boolean().nullable(),
  dataset_sha256: Sha256Hex,
});

const fixed9In = (s: string, lo: bigint, hi: bigint) => {
  const v = parseFixed9(s);
  return v >= lo && v <= hi;
};

export const BarsReplayMetrics = z
  .strictObject({
    /** The rank key. */
    net_pnl_quote_units: I64,
    /** net PnL / starting capital. */
    return: Fixed9,
    /** Per bar, not annualised; null when undefined (fewer than two returns, zero denominator). */
    sharpe: Fixed9.nullable(),
    sortino: Fixed9.nullable(),
    /** Peak-to-trough share of equity, 0..1. */
    max_drawdown: Fixed9,
    /** Winning round trips / round trips; null with no round trip. */
    win_rate: Fixed9.nullable(),
    trades: z.int().min(0),
    rejected: z.int().min(0),
    distinct_symbols: z.int().min(0),
    fees_quote_units: U64,
    /** Mean invested share of equity over the batches, 0..1. */
    exposure: Fixed9,
    per_symbol: z.array(SymbolPnl),
    interval: BarsPnlInterval,
    /** The hours each per_block block covers; present exactly when per_block is (the header). */
    block_hours: z.int().min(1).optional(),
    /** Net PnL in each block of the window, block 0 first, adding up to net_pnl_quote_units (the header). */
    per_block: z.array(BarsBlockPnl).min(1).optional(),
    /** The same action log re-scored with fee_bps doubled. */
    cost_sensitivity: z.strictObject({
      fee_multiplier: z.literal(2),
      net_pnl_quote_units: I64,
    }),
    constraints: BarsConstraints,
    contamination: BarsContamination,
  })
  .superRefine((m, ctx) => {
    const issue = barsIssuer(ctx);
    const one = FIXED9_SCALE;
    if (parseFixed9(m.return) < -one) issue(['return'], 'return is at least -1: cash never goes below 0');
    if (!fixed9In(m.max_drawdown, 0n, one)) issue(['max_drawdown'], 'max_drawdown is a share: 0..1');
    if (!fixed9In(m.exposure, 0n, one)) issue(['exposure'], 'exposure is a share: 0..1');
    if (m.win_rate !== null && !fixed9In(m.win_rate, 0n, one)) issue(['win_rate'], 'win_rate is a share: 0..1');

    checkBarsSymbolOrder(m.per_symbol, ['per_symbol'], issue);
    let pnl = 0n;
    let fees = 0n;
    let trades = 0;
    let traded = 0;
    for (const s of m.per_symbol) {
      pnl += BigInt(s.pnl_quote_units);
      fees += BigInt(s.fees_quote_units);
      trades += s.trades;
      if (s.trades > 0) traded += 1;
    }
    if (pnl !== BigInt(m.net_pnl_quote_units)) issue(['per_symbol'], `per_symbol PnL adds up to ${pnl}, not net_pnl_quote_units ${m.net_pnl_quote_units}`);
    if (fees !== BigInt(m.fees_quote_units)) issue(['per_symbol'], `per_symbol fees add up to ${fees}, not fees_quote_units ${m.fees_quote_units}`);
    if (trades !== m.trades) issue(['per_symbol'], `per_symbol trades add up to ${trades}, not trades ${m.trades}`);
    if (traded !== m.distinct_symbols) issue(['distinct_symbols'], `${traded} per_symbol rows hold a trade, not distinct_symbols ${m.distinct_symbols}`);

    if ((m.block_hours === undefined) !== (m.per_block === undefined)) {
      issue([m.per_block === undefined ? 'per_block' : 'block_hours'], 'block_hours and per_block come together: the hours a block covers, and each block\'s PnL');
    }
    if (m.per_block !== undefined) {
      let sum = 0n;
      m.per_block.forEach((b, i) => {
        if (b.block !== i) issue(['per_block', i, 'block'], `per_block rows are blocks 0, 1, ... in order: row ${i} is block ${b.block}`);
        sum += BigInt(b.pnl_quote_units);
      });
      if (sum !== BigInt(m.net_pnl_quote_units)) issue(['per_block'], `per_block PnL adds up to ${sum}, not net_pnl_quote_units ${m.net_pnl_quote_units}`);
    }

    const c = m.constraints;
    if (c.trades_ok !== m.trades >= c.min_trades) issue(['constraints', 'trades_ok'], 'trades_ok is trades >= min_trades');
    if (c.symbols_ok !== m.distinct_symbols >= c.min_distinct_symbols) issue(['constraints', 'symbols_ok'], 'symbols_ok is distinct_symbols >= min_distinct_symbols');
    if (c.drawdown_ok !== parseFixed9(m.max_drawdown) <= parseFixed9(c.max_drawdown)) issue(['constraints', 'drawdown_ok'], 'drawdown_ok is max_drawdown at or under its cap');
  }, whenBarsValid);

export const BarsReplayPerformance = z.strictObject({
  kind: z.literal('bars-replay/v1'),
  metrics: BarsReplayMetrics,
});

// ---------------------------------------------------------------- agent/v1
//
// An agent/v1 run (contracts/agent.ts) is K trials, one per beacon-drawn instance every entry of the
// phase shares (paired). Its performance lists each trial that counts, in index order, as the trials
// manifest does: finished, timeout (0 on every column) or nondeterministic (the run is listed and
// unranked). A void trial never appears: it re-runs on the same instance, and counts.voids_rerun
// says how often one did.
//
//   trials          per trial: its instance, how it ended, its scores (the scorer's scores.json
//                   keyed by column key; 0 on every column for a timeout), whether its store works,
//                   its requests and spend, and the digests of its cassette and its state export
//   scores          per column, the mean of the trials' scores in it, so a leaderboard column reads
//                   performance.scores.<key> exactly as on program/v1
//   interval        the two-sided interval at `level` on the primary column's mean; null bounds
//                   when it is undefined (fewer than two trials)
//   counts          the trials, how many ended each way, and the void re-runs
//   working_trials  the trials whose store works
//   spend           what the listed trials' model calls cost, priced at pricing_rev, and their count

const ColumnScores = z.record(ColumnKey, z.number().finite().nullable());

export const AgentTrialScore = z
  .strictObject({
    index: z.int().min(0),
    instance_sha256: Sha256Hex,
    status: AgentTrialStatus,
    scores: ColumnScores,
    /** The store works: every operations check passed (the scorer's working column). */
    working: z.boolean(),
    /** The trial's cassette entries (Cassette.totals.requests). */
    requests: z.int().min(0),
    /** Its cassette's totals.micro_usd. */
    spend_micro_usd: U64,
    cassette_sha256: Sha256Hex,
    state_sha256: Sha256Hex,
  })
  .superRefine((t, ctx) => {
    if (t.status !== 'timeout') return;
    const issue = barsIssuer(ctx);
    for (const [k, v] of Object.entries(t.scores)) if (v !== 0) issue(['scores', k], `a timeout scores 0 on every column, not ${v}`);
    if (t.working) issue(['working'], 'a timeout scores 0 on every column: its store does not work');
  }, whenBarsValid);

export const AgentInterval = z
  .strictObject({
    /** e.g. "0.900000000". */
    level: Fixed9,
    low: z.number().finite().nullable(),
    high: z.number().finite().nullable(),
  })
  .refine((i) => (i.low === null) === (i.high === null) && (i.low === null || i.high === null || i.low <= i.high), {
    message: 'low and high are both null or both bounds, low at most high',
    path: ['high'],
    ...whenBarsValid,
  });

export const AgentCounts = z.strictObject({
  trials: z.int().min(1),
  finished: z.int().min(0),
  timeout: z.int().min(0),
  nondeterministic: z.int().min(0),
  /** Trials voided (an infrastructure fault) and re-run on their instance: none of them is listed. */
  voids_rerun: z.int().min(0),
});

export const AgentSpend = z.strictObject({
  /** The pricing rows every listed trial's cassette was priced on. */
  pricing_rev: z.string().min(1),
  /** The listed trials' spend_micro_usd summed. */
  micro_usd: U64,
  /** The listed trials' requests summed. */
  requests: z.int().min(0),
});

export const AgentPerformance = z
  .strictObject({
    kind: z.literal('agent/v1'),
    trials: z.array(AgentTrialScore).min(1),
    scores: ColumnScores,
    interval: AgentInterval,
    counts: AgentCounts,
    working_trials: z.int().min(0),
    spend: AgentSpend,
  })
  .superRefine((p, ctx) => {
    const issue = barsIssuer(ctx);
    checkTrialOrder(p.trials, ['trials'], issue);
    const columns = Object.keys(p.scores).sort().join(',');
    let requests = 0;
    let spend = 0n;
    let working = 0;
    const by = { finished: 0, timeout: 0, nondeterministic: 0 };
    p.trials.forEach((t, i) => {
      if (Object.keys(t.scores).sort().join(',') !== columns) issue(['trials', i, 'scores'], 'every trial scores the columns the means are taken over, and only those');
      requests += t.requests;
      spend += BigInt(t.spend_micro_usd);
      if (t.working) working++;
      by[t.status]++;
    });
    const c = p.counts;
    if (c.trials !== p.trials.length) issue(['counts', 'trials'], `${p.trials.length} trials are listed, not counts.trials ${c.trials}`);
    for (const k of ['finished', 'timeout', 'nondeterministic'] as const) {
      if (c[k] !== by[k]) issue(['counts', k], `${by[k]} listed trials are ${k}, not counts.${k} ${c[k]}`);
    }
    if (p.working_trials !== working) issue(['working_trials'], `${working} listed trials work, not working_trials ${p.working_trials}`);
    if (p.spend.requests !== requests) issue(['spend', 'requests'], `the trials' requests add up to ${requests}, not spend.requests ${p.spend.requests}`);
    if (BigInt(p.spend.micro_usd) !== spend) issue(['spend', 'micro_usd'], `the trials' spend adds up to ${spend}, not spend.micro_usd ${p.spend.micro_usd}`);
  }, whenBarsValid);

// ---------------------------------------------------------------- clmm-replay/v1
//
// ClmmReplayPerformance lives in its own module (contracts/clmm-score.ts, whose header defines every
// metric): hedged PnL the rank key, with fees, costs and LVR beside it, the in-range share its
// guardrail, a block bootstrap its interval.

// ---------------------------------------------------------------- scrape/v1
//
// ScrapePerformance lives in contracts/scrape.ts with the records it is scored from: per trial its
// round, stage, status and wall time; the trimmed mean of the correct wall times the rank key
// (time_ms, lower is better), its Yuen 90% interval, and the counts.

// ---------------------------------------------------------------- patch/v1
//
// PatchPerformance lives in contracts/patch.ts with the harness it scores: whether the patch applied
// (or why it was refused), whether the canaries caught tampering, the fail-to-pass and pass-to-pass
// tallies, the scores a column reads (PATCH_SCORE_COLUMNS) and the gate (resolved). Counts only.

// ---------------------------------------------------------------- referral/v1
//
// A referral/v1 entry (an ad page and its image, contracts/competition.ts ReferralHarness) is checked by
// the referral contest's rules rather than run: a verdict (verified, unverified or undecided, the rules'
// or an audit's) is the score's only fact, and its leaderboard columns read the facts keyed by column key
// at performance.scores.<key>, exactly as a program/v1 score's do.
export const ReferralPerformance = z.strictObject({
  kind: z.literal('referral/v1'),
  scores: z.record(ColumnKey, z.number().finite().nullable()),
});

// ---------------------------------------------------------------- desk/v1
//
// A desk/v1 entry (contracts/competition.ts DeskHarness) names a campaign and runs nothing: its grade counts what the
// campaign's desk decided for the account inside the competition's window, and its leaderboard columns
// (DESK_SCORE_COLUMNS) read those counts at performance.scores.<key>. points is the credited units' weights summed (the
// rank key), units how many units were credited, refused_checks how many of the account's submissions the validator
// refused (the tie-break: fewer ranks first), and pending_units, when the grade names it, how many submissions were
// still undecided when it counted (an undecided submission never counts). Every weight is at least 1, so points is at
// least units, and none when units is none.
export const DeskScores = z
  .strictObject({
    points: z.int().min(0),
    units: z.int().min(0),
    refused_checks: z.int().min(0),
    pending_units: z.int().min(0).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.points < d.units) {
      ctx.addIssue({ code: 'custom', path: ['points'], message: `${d.units} credited units weigh at least 1 each, so points is at least ${d.units}, not ${d.points}` });
    } else if (d.units === 0 && d.points !== 0) {
      ctx.addIssue({ code: 'custom', path: ['points'], message: `no unit is credited, so points is 0, not ${d.points}` });
    }
  });

export const DeskPerformance = z.strictObject({
  kind: z.literal('desk/v1'),
  scores: DeskScores,
});

export const Performance = z.discriminatedUnion('kind', [ReplayPerformance, ProgramPerformance, BarsReplayPerformance, AgentPerformance, ClmmReplayPerformance, ScrapePerformance, PatchPerformance, ReferralPerformance, DeskPerformance]);

export const TokenTotals = z.strictObject({
  input: U64,
  output: U64,
  cache_read: U64,
  cache_write_5m: U64,
  cache_write_1h: U64,
  reasoning: U64,
});

/** A cost's provenance (Cost.provenance): a session tier, `none` with no transcript, or `metered`. */
export const COST_PROVENANCES = ['agent-log', 'self-reported', 'none', 'metered'] as const;

/**
 * What the house's build meter saw (Cost.metered), under a bundle with a build meter
 * (contracts/competition.ts BuildMeter): `requests` the entrant's metered requests on its make.fun
 * build keys counted, those at or before `through` (the entry's receipt time), `unmetered_lines`
 * the entry's transcript usage lines no metered request vouches for, and `requests_sha256` which
 * requests those were. Each is a function of the metered requests the grade counted and the entry's
 * own usage lines, so a regrade reproduces it.
 */
export const MeteredCost = z.strictObject({
  requests: z.int().min(0),
  /** The instant the requests are counted through: the entry's receipt time. */
  through: IsoDateTime,
  unmetered_lines: z.int().min(0),
  /**
   * The sha256 of the counted requests' list: their masq request ids, ascending, as canonical JSON (a
   * blob in the store, grader/entry-cost.ts meteredRequestsJson). An L1 or L2 regrade prices from exactly
   * the stored requests it names, so a request masq recorded late, stored after the grade, never moves a
   * regrade. Absent on a cost priced before the list was kept: its regrade counts the stored requests
   * through `through`.
   */
  requests_sha256: Sha256Hex.optional(),
});

/**
 * What building the entry cost, priced per transcript line at that line's own timestamp; under a
 * bundle with a build meter, the house meter's list cost of the entrant's metered requests instead,
 * with what the meter saw in `metered`.
 */
export const Cost = z
  .strictObject({
    pricing_rev: z.string().min(1),
    /** The total when every line is priced; null as soon as one line is unpriced (never $0). */
    micro_usd: U64.nullable(),
    /** Sum over the priced lines only. */
    priced_micro_usd: U64,
    lines: z.int().min(0),
    unpriced_lines: z.int().min(0),
    partial_lines: z.int().min(0),
    inconsistent_lines: z.int().min(0),
    tokens: TokenTotals,
    models: z.array(
      z.strictObject({
        model: z.string().min(1),
        lines: z.int().min(0),
        /** Null when the model is unpriced. */
        micro_usd: U64.nullable(),
        tokens: TokenTotals,
      }),
    ),
    /**
     * Weakest provenance tier among the sessions ("none" with no transcript), or "metered": the house's
     * build meter vouched for every usage line of the entry's transcripts (metered.unmetered_lines 0).
     * "metered" is the cost's alone, never a session's tier (transcripts/types.ts ProvenanceTier).
     */
    provenance: z.enum(COST_PROVENANCES),
    /** What the build meter saw (MeteredCost), under a bundle with a build meter. Absent: no key appears, so a cost without it keeps its bytes. */
    metered: MeteredCost.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.provenance !== 'metered') return;
    const issue = barsIssuer(ctx);
    if (c.metered === undefined) issue(['metered'], 'a metered cost says what the meter saw: provenance metered needs metered');
    else if (c.metered.unmetered_lines !== 0) issue(['provenance'], `provenance metered means the meter vouched for every usage line, and ${c.metered.unmetered_lines} are unmetered: the cost takes its sessions' tier instead`);
  }, whenBarsValid);

/** transcripts/authorship.ts, summarised (per-file rows live in the authorship table). */
export const AuthorshipSummary = z.strictObject({
  algo_version: z.int().min(1),
  lines_total: z.int().min(0),
  authored: z.int().min(0),
  pasted: z.int().min(0),
  read: z.int().min(0),
  absent: z.int().min(0),
  /** authored / lines_total; null with no counted line. */
  authored_coverage: Fixed9.nullable(),
  /** Priced authoring cost per surviving authored line; null when nothing priced survived. */
  micro_usd_per_surviving_line: U64.nullable(),
  /** Share of priced cost spent in sessions with zero surviving lines; null when nothing is priced. */
  dead_spend: Fixed9.nullable(),
});

/**
 * The eligibility reason of a program/v1 entry that did not pass its harness's pass bar: its gate
 * (contracts/competition.ts ProgramHarness.gate: it scored other than 1 in the gate column, its
 * performance.passed false), or its pass count (ProgramHarness.pass_count, a Best test score bounty's,
 * which has no gate: it passed no case, no count of 1 or more in that column, and its performance
 * carries no passed). Either way it keeps its listing, ranks below every entry that passed (the gate, or
 * a case: server/routes/competitions/ranking.ts compliantOf reads this reason where there is no passed),
 * and is neither prize- nor efficiency-eligible (grader/score.ts eligibility).
 */
export const FAILED_TESTS_REASON = 'failed_tests';

/**
 * The eligibility reason of an entry under a bundle with a build meter (contracts/competition.ts
 * BuildMeter) whose cost the meter did not vouch for in full (cost.provenance other than metered: a
 * usage line of its transcripts no metered request matches, or no metered build at all): it keeps its
 * listing, and is unranked (the bundle's rank key is the metered cost, so it takes no rank in any view,
 * no place and no prize), and neither efficiency- nor, through the bundle's prize_requires_efficiency,
 * prize-eligible (grader/score.ts eligibility).
 */
export const COST_UNMETERED_REASON = 'cost_unmetered';

export const Eligibility = z.strictObject({
  /**
   * False for nondeterministic, timed-out or failed runs; and, under a bundle with a build meter
   * (contracts/competition.ts BuildMeter), for an entry without a metered cost (its reasons
   * COST_UNMETERED_REASON and/or cost_unpriced): it is listed, and ranks in no view.
   */
  ranked: z.boolean(),
  prize_eligible: z.boolean(),
  efficiency_eligible: z.boolean(),
  /** Machine-readable reasons for every false above, e.g. "house", "baseline", "coverage_below_gate", "failed_tests" (FAILED_TESTS_REASON), "cost_unmetered" (COST_UNMETERED_REASON). */
  reasons: z.array(z.string().min(1)),
});

/**
 * The entry's code size (Score.size), under a program/v1 harness that names a size count
 * (contracts/competition.ts ProgramSize): `bytes` the count at `version` (grader/size.ts codeSize): for
 * every entry of the snapshot, a regular file's bytes or a symlink's by the bytes of its target text,
 * plus the UTF-8 bytes of its path, less every regular file byte-identical to the kit's starter file at
 * its path; `files` the entries counted, files and symlinks alike. Public, as the entry's scores are:
 * the entry's own code, never a build metric (contracts/competition.ts readsBuildMetric), so a column
 * reading size.bytes is shown to everyone. Under the compressed count ('compressed-all-files') it also
 * carries `compressed`: the same entries' compressed size under the size model (sim/size-model.ts), in
 * bytes at exactly three fraction digits (compressedSizeText), a decimal string a column reads exactly
 * (contracts/competition.ts PROGRAM_COMPRESSED_SIZE_SOURCE). The score cannot see the harness's count,
 * so this schema keeps it optional: the grader writes it exactly under the compressed count, at
 * `version` PROGRAM_COMPRESSED_SIZE_VERSION, and never under 'bytes-all-files' (scoreSizeIssue checks a
 * size against its count).
 */
export const ScoreSize = z.strictObject({
  bytes: z.int().min(0),
  files: z.int().min(0),
  /** The size count's version it was taken at (contracts/competition.ts PROGRAM_SIZE_VERSION, or PROGRAM_COMPRESSED_SIZE_VERSION under the compressed count). */
  version: z.int().min(1),
  /**
   * The compressed size in bytes, exactly three fraction digits, e.g. "1234.567" (the decimal string of
   * contracts/scrape.ts ScrapeMillis, the one schema server/competitions/load.ts scoreSourceIssue reads
   * a column of at three places). Present exactly under the compressed count; absent, no key appears, so
   * a bytes-all-files score keeps its bytes and its hash.
   */
  compressed: ScrapeMillis.optional(),
  /**
   * Under a size count saying `count_secrets: true` (contracts/competition.ts ProgramSize), the entry's env-lane entry
   * secrets it counted (grader/size.ts countSecrets): `count` of them and their `bytes`, each its NAME's UTF-8 bytes plus
   * its value's, already inside `bytes` (and `compressed`, byte for byte). Never a name or a value. Present exactly under
   * the switch ({count: 0, bytes: 0} for an entry with none); absent, no key appears, so a size without it keeps its
   * bytes and its hash.
   */
  secrets: z
    .strictObject({
      count: z.int().min(0),
      bytes: z.int().min(0),
    })
    .optional(),
});

/** The thousandths of a byte (a safe integer or a bigint, not below 0) as ScoreSize.compressed text: 1234567 → "1234.567". */
export function compressedSizeText(thousandths: number | bigint): string {
  if (typeof thousandths === 'number' && !Number.isSafeInteger(thousandths)) throw new RangeError(`compressed size ${thousandths}: thousandths of a byte are a safe integer`);
  const n = BigInt(thousandths);
  if (n < 0n) throw new RangeError(`compressed size ${n}: thousandths of a byte are not below 0`);
  return `${n / 1000n}.${(n % 1000n).toString().padStart(3, '0')}`;
}

/** ScoreSize.compressed text as thousandths of a byte: "1234.567" → 1234567n. Throws on text that is not one. */
export function compressedSizeThousandths(text: string): bigint {
  const parsed = ScrapeMillis.safeParse(text);
  if (!parsed.success) throw new RangeError(`compressed size ${JSON.stringify(text)}: expected bytes with exactly three fraction digits, e.g. "1234.567"`);
  const [whole, frac] = text.split('.') as [string, string];
  return BigInt(whole) * 1000n + BigInt(frac);
}

/**
 * Null when a score's size (ScoreSize) is the one the harness's size count (contracts/competition.ts
 * ProgramSize) writes: taken at the count's version, carrying `compressed` exactly under
 * 'compressed-all-files' and `secrets` exactly under `count_secrets: true`, its bytes within the size's. Otherwise
 * the reason it is not.
 */
export function scoreSizeIssue(size: ScoreSizeT, count: ProgramSizeT): string | null {
  if (size.version !== count.version) return `the size was taken at version ${size.version}, and the harness counts ${count.count} at version ${count.version}`;
  const compressed = count.count === 'compressed-all-files';
  if (compressed && size.compressed === undefined) return `the harness counts ${count.count}, and the size carries no compressed size`;
  if (!compressed && size.compressed !== undefined) return `the harness counts ${count.count}, and the size carries a compressed size (${size.compressed}) only the compressed count writes`;
  const secrets = count.count_secrets === true;
  if (secrets && size.secrets === undefined) return `the harness counts the entry's secrets (count_secrets), and the size carries no count of them`;
  if (!secrets && size.secrets !== undefined) return `the harness counts no entry secret, and the size carries a count of ${size.secrets.count} (${size.secrets.bytes} bytes) only count_secrets writes`;
  if (size.secrets !== undefined && size.secrets.bytes > size.bytes) return `the size counts ${size.bytes} bytes, fewer than the ${size.secrets.bytes} bytes of entry secrets it says are among them`;
  return null;
}

export const Score = z.strictObject({
  schema: z.literal(SCORE_SCHEMA),
  harness: z.strictObject({
    kind: HarnessKind,
    /** Harness source sha + Node version. */
    version: z.string().min(1),
  }),
  scorer_version: z.string().min(1),
  /** `sha256:<hex>` of the runtime image (null for the process driver used in tests). */
  image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  dataset_sha256: Sha256Hex.nullable(),
  action_log_sha256: Sha256Hex,
  seed: U64,
  performance: Performance,
  cost: Cost,
  authorship: AuthorshipSummary.nullable(),
  eligibility: Eligibility,
  /** e.g. "wall_budget_over_half", "fee_fallback". */
  flags: z.array(z.string().min(1)),
  /** The entry's code size (ScoreSize), under a program/v1 harness with a size count. Absent: no key appears, so a score without it keeps its bytes. */
  size: ScoreSize.optional(),
});

export type ScoreT = z.infer<typeof Score>;
export type ReplayMetricsT = z.infer<typeof ReplayMetrics>;
export type CounterpartiesT = z.infer<typeof Counterparties>;
export type ReplayErasT = z.infer<typeof ReplayEras>;
export type EraWindowT = z.infer<typeof EraWindow>;
export type AgentPerformanceT = z.infer<typeof AgentPerformance>;
export type AgentTrialScoreT = z.infer<typeof AgentTrialScore>;
export type BarsReplayMetricsT = z.infer<typeof BarsReplayMetrics>;
export type SymbolPnlT = z.infer<typeof SymbolPnl>;
export type BarsBlockPnlT = z.infer<typeof BarsBlockPnl>;
export type CostT = z.infer<typeof Cost>;
export type MeteredCostT = z.infer<typeof MeteredCost>;
export type CostProvenanceT = (typeof COST_PROVENANCES)[number];
export type AuthorshipSummaryT = z.infer<typeof AuthorshipSummary>;
export type EligibilityT = z.infer<typeof Eligibility>;
export type PerformanceT = z.infer<typeof Performance>;
export type ProgramPerformanceT = z.infer<typeof ProgramPerformance>;
export type ReferralPerformanceT = z.infer<typeof ReferralPerformance>;
export type DeskPerformanceT = z.infer<typeof DeskPerformance>;
export type ProgramTimingScoreT = z.infer<typeof ProgramTimingScore>;
export type ProgramJudgeScoreT = z.infer<typeof ProgramJudgeScore>;
export type ScoreSizeT = z.infer<typeof ScoreSize>;

