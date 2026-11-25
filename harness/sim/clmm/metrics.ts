// The clmm replay's metrics (contracts/clmm-score.ts ClmmReplayMetrics, whose header defines each one)
// from a finished run of sim/clmm/engine.ts, and the score of an action log: a pure function of
// (dataset, action log, harness, final window). BigInt throughout, every division truncating toward
// zero (BigInt `/`), so a score is byte-stable on every machine. What the contract leaves to the sim:
//
//   - The closes. A run's marks (ClmmMark) are the account at the start, at every batch's close and
//     after the close-out, in that order. Mark i's close is the latest close c as of it (carried over
//     an hour with no bar, null before the first bar), and its asset_units are x: the asset idle, in
//     the position at the latest close's sqrt price (rounded down) and in its fees owed.
//   - The hedge has no unhedged hour: each hour is split at its open, where the bot's actions apply.
//     Hour h (batch h, mark h + 1) with a bar o_h, c_h hedges
//       x_{h-1} x (c_h - c_{h-1}) + (x_h^open - x_{h-1}) x (c_h - o_h),
//     each product valued as value(q, p) is, q x p x 10^6 / 10^(decimals + price_scale) truncated
//     toward zero. Before truncation that is x_{h-1} x (o_h - c_{h-1}) + x_h^open x (c_h - o_h): the
//     close-to-open gap hedged with the asset held at the previous close, the open-to-close move with
//     the asset held right after the open's actions, so an exposure taken at an open earns none of
//     the hour's move. x_{h-1} and c_{h-1} are the previous mark's (the start's x is 0); o_h and c_h
//     are the dataset's bar closing at the batch's t (the run carries o only on a swap's
//     reference_price, so the hedge reads the bar, and checks the mark's close and every swap's
//     reference price against it). x_h^open is:
//       - x_{h-1} when no set_range or withdraw applied at the open (a position the open left alone
//         is not re-marked there), so that hour hedges x_{h-1} x (c_h - c_{h-1}) exactly, one
//         product;
//       - otherwise, from the resolutions of the actions decided on batch h - 1: the idle asset after
//         the last of them (its idle_after), plus, when the last applied set_range or withdraw is a
//         set_range, the asset its minted liquidity holds at the open's reference sqrt price
//         (o_sqrt_price_x64), rounded down as a mark rounds a position's. A withdraw leaves no
//         position, and a fresh one owes no fees.
//     An hour with no bar hedges nothing: no set_range or withdraw applies at its open (no_bar), and
//     its mark carries the previous one's close and asset_units (anything else is a sim bug). The next
//     bar's gap therefore runs from that carried latest close to its open, hedged with the holdings
//     carried. While no bar has closed nothing is held, and nothing is hedged. The close-out hedges
//     nothing: it sells at the latest close, which does not move. Hedged PnL so far at mark i is its
//     equity - starting capital - the hedges through mark i: 0 at the start, and after the close-out
//     final USDC - starting capital - every hedge, hedged_pnl_quote_units.
//   - max_drawdown: sim/metrics.ts maxDrawdown9 of the hedged equity curve, starting capital + hedged
//     PnL so far at every mark (the start, every close, the end after the close-out).
//   - Blocks. Block b holds the window's hours [b x block_hours, (b + 1) x block_hours), ceil(hours /
//     block_hours) blocks, the last one possibly shorter. Its PnL is hedged PnL so far at the mark of
//     its last hour's batch minus that at the previous block's (the start's for block 0). The last
//     block ends at the mark after the close-out, so the close-out's sale is its. The blocks add up to
//     the rank key.
//   - The interval. B = interval.resamples resamples of the window's K blocks (clmmWindowCounts). In
//     resample r, block b counts n(b, r) times: the r-th u64 of the SplitMix64 stream seeded by
//     keyedU64(the phase seed (hello.seed), CLMM_BLOCK_DOMAIN, b), through the exact Poisson(1)
//     inverse CDF the board's ties draw with (server/payouts/baseline.ts barsSymbolCounts; capped at
//     CLMM_POISSON_CAP). A resample in which no block counts (N(r), the sum over b of n(b, r), is 0:
//     probability e^-K) is drawn again: at attempt a = 1, 2, ... every block's count is
//     Poisson1(keyedU64(the seed, CLMM_REDRAW_DOMAIN, b, r, a)), until some block counts. The counts
//     depend on (seed, K, b, r) alone, never on any PnL, so every entry of a phase (one window, one K)
//     is resampled with the same counts (paired): two entries' intervals weigh the same hours alike.
//     Resample r's total is K x (the sum over b of n(b, r) x PnL_b) / N(r), truncated toward zero:
//     each resample normalised to the window's K blocks, the count-weighted mean block scaled to K.
//     That resamples the K-block total around its own mean, as the block bootstrap does: its spread is
//     close to, slightly wider than, the textbook bootstrap's (K blocks drawn with replacement) at the
//     28 blocks of a week, and wider on fewer (a reviewer measured about 5% at 24 blocks and 15 to 30%
//     at 2 to 8), never equal to it by construction. The plain counted sum, n(b, r) x PnL_b over b,
//     also resamples the window's length (N(r) is Poisson(K)), adding (the sum of PnL_b)^2 / K of
//     variance: on a few dozen blocks with a mean far from 0 that is several times too wide, and one
//     block alone would span [0, 3 x its PnL] at 90%. With the totals sorted, low and high are the
//     nearest-rank quantiles at (1 - level) / 2 and (1 + level) / 2 (sim/metrics.ts
//     bootstrapInterval's ranks). The score names this draw contracts/clmm-score.ts
//     CLMM_INTERVAL_METHOD ('bootstrap-blocks/v2'), never the harness's interval.method (the family a
//     bundle asks for, 'bootstrap-blocks'): it is the only method a clmm score may name. Over few
//     blocks the bootstrap still says little (over one, every total is that block's PnL):
//     contracts/clmm-protocol.ts clmmPhaseBlocksIssue is the rule a harness's block_hours and a
//     phase's window are held to where the two meet (grader/harnesses.ts clmmPlan, the admin's dataset
//     attach and the gap rule's replacement step): CLMM_MIN_BLOCKS whole blocks at least on dev,
//     CLMM_RANKED_MIN_BLOCKS (28, the six-hour blocks of a 7-day window) on the ranked final phase,
//     whose board pays the prizes; the scorer itself scores any window.
//   - Fees: each mark's credits over its hour (fees_credited), USDC's as they are and the asset's
//     valued at the mark's close, value(credit, c), but for what an open's withdrawal (a withdraw or
//     a re-range) collected that was credited in its own hour before that open (clmmPreOpenCredits):
//     from the open those fees are idle, held and hedged as idle, so they are valued at that open,
//     value(credit, o). That way every fee enters the hedge at the price it is valued at.
//   - Costs: every applied action's swap (the run's resolutions) against the reference price it
//     filled from, the open o, and the close-out's sale against the close c: a buy's notional -
//     value(qty, ref), a sale's value(qty, ref) - proceeds. A cost below 0 is a sim bug
//     (SimAbortError), never scored.
//   - LVR, leg by leg (clmmLvrLegs, clmmLvrByLegs): lvr_quote_units is fees - costs - hedged PnL, a
//     residual that could hide an error in any of the three, so it is also computed on its own from
//     the run's positions (ClmmPositionSpan) and the bars' prices alone, as Milionis et al. define it:
//     the value the hedged position loses. The legs are the hedge's: an hour whose open applied a
//     set_range or withdraw is two, the gap from the latest close to the open (the position held
//     before it) and the open to the close (the one held after it); an hour whose open changed
//     nothing is one, the latest close to the close; an hour with no bar none. Over a leg from price
//     P0 to P1 a position of liquidity L holds tokens x(P) of the asset and y(P) of USDC
//     (sim/clmm/position.ts amountsForLiquidity at the bar's reference sqrt price, o_sqrt_price_x64 or
//     c_sqrt_price_x64, rounded down as a mark rounds them) worth V(P) = y(P) + x(P) x P, and loses
//     -[V(P1) - V(P0) - x(P0) x (P1 - P0)], truncated toward zero once: 0 for a position out of range
//     all leg long (V is linear there), above 0 in range (V is concave). Idle tokens and fees owed
//     are linear in the price, so the hedge takes their moves out whole, and every fee is valued at
//     the price it enters the hedge at (Fees, above). So the sum matches lvr_quote_units to within
//     rounding alone: under a unit per leg, hedge product, fee valuation and swap (value()'s
//     truncation), and the raw unit of each token a mint rounds its deposit up by
//     (tests/unit/sim-clmm-metrics.test.ts pins the identity). clmmLvrRoundingBound counts that bound
//     from the run, and clmmLvrCheck holds a score's lvr_quote_units to it. Every clmm-replay/v1 grade
//     asserts it before anything is scored (grader/harnesses.ts clmmPlan, assertClmmLvr): a score that
//     fails it carries a fault of the scorer or the engine (ClmmLvrMismatchError), never the entry's,
//     and the grade job dead-letters as the platform's fault (grader/worker.ts).
//   - in_range_share: the marks' in_range_share_9_sum over the marks' intervals, truncated (the engine
//     adds floor(10^9 x position value / equity) for each interval a live position's range held both
//     ticks of, 0 for every other interval); 0 for a window of a single row.
//   - Cost sensitivity: replayClmmActionLog at fee multiplier CLMM_COST_MULTIPLIER (fee_bps doubled on
//     every swap, the close-out's included; the LP fees credited unchanged), its hedged PnL by the same
//     rule. An action carries no amount, so that re-run sizes its swaps against its own account and
//     needs no clamp. A max_slippage or zero_liquidity verdict can still flip there, and then the
//     score carries the flag `cost_run_diverged` (CLMM_COST_RUN_DIVERGED): some action resolved
//     otherwise in the two runs (applied in one and rejected in the other, or rejected for another
//     reason), so cost_sensitivity holds more than the doubled fee alone.
//   - The harness. The run's hello must carry the harness's pool, capital, fees and caps
//     (clmmHarnessMismatch): a log made under another harness is refused (SimDataError), never scored
//     under this one's guardrails and interval.
//   - Contamination: bars-replay/v1's (sim/metrics.ts computeBarsMetrics): the run's no_future_bars,
//     and on the final window its first hour's open time (window.start_ms) against the last graded
//     receipt.

import { USDC_DECIMALS } from '../../contracts/bars-protocol.ts';
import type { ClmmDatasetLineT } from '../../contracts/clmm-dataset.ts';
import { CLMM_BAR_MS, ClmmReplayHarness, clmmQuoteIndex, type ClmmHelloT, type ClmmReplayHarnessT, type ClmmSwapT } from '../../contracts/clmm-protocol.ts';
import { CLMM_INTERVAL_METHOD, ClmmReplayMetrics, type ClmmReplayMetricsT } from '../../contracts/clmm-score.ts';
import { parseFixed9, toFixed9 } from '../../contracts/primitives.ts';
import { barsValue, type BarsScales } from '../bars/engine.ts';
import { canonicalJson } from '../canonical.ts';
import { maxDrawdown9, SCALE } from '../metrics.ts';
import { keyedU64, SplitMix64 } from '../rng.ts';
import { ClmmActionLog, replayClmmActionLog, SimAbortError, SimDataError, type ClmmActionLogT, type ClmmDataset, type ClmmPositionSpan, type ClmmResolution, type ClmmRun } from './engine.ts';
import { amountsForLiquidity } from './position.ts';

/** The cost-sensitivity run's fee multiplier: fees.fee_bps doubled (ClmmReplayMetrics cost_sensitivity.fee_multiplier). */
export const CLMM_COST_MULTIPLIER = 2;

/** The score flag of a cost-sensitivity run that resolved some action otherwise (see the header). */
export const CLMM_COST_RUN_DIVERGED = 'cost_run_diverged';

/** The block bootstrap's stream domain ("blk-boot"), apart from every sim/rng.ts RNG_DOMAIN stream and the board's ties' ("tie-diff", server/payouts/baseline.ts barsSymbolCounts). */
export const CLMM_BLOCK_DOMAIN = 0x626c6b2d626f6f74n;

/** The redraw stream's domain ("blk-rdrw"): a resample that counted no block of the window draws its counts again from it. */
export const CLMM_REDRAW_DOMAIN = 0x626c6b2d72647277n;

/**
 * The most redraws of one resample (see the header). Each attempt counts some block with
 * probability 1 - e^-K, at least 0.63: a resample still counting none after this many would need
 * odds below e^-64 (2^-92), so the cap is never reached on a hash that mixes.
 */
const CLMM_MAX_REDRAWS = 64;

/** The largest Poisson(1) count a draw returns (P(X > 20) is below 2^-64): the block bootstrap's and the board's ties' (server/payouts/baseline.ts barsSymbolCounts) alike. */
export const CLMM_POISSON_CAP = 20;

/** Final phase: the server time of the last graded receipt. Null on the dev phase. */
export type ClmmFinalWindow = { last_graded_receipt_at: string } | null;

/**
 * Poisson(1) inverse-CDF thresholds on a u64 draw: floor(2^64 x P(X <= k)) for k = 0..CLMM_POISSON_CAP-1,
 * from e^-1 and the partial sums of 1/j! in exact fixed point at 2^-192 (e^-1 by its alternating series
 * to 1/60!), so every machine draws the same counts. The one table: the board's ties draw their counts
 * through it too (clmmPoisson1, read by server/payouts/baseline.ts barsSymbolCounts).
 */
const POISSON_U64: readonly bigint[] = (() => {
  const bits = 192n;
  const unit = 1n << bits;
  const inv: bigint[] = [unit];
  for (let j = 1n; j <= 60n; j++) inv.push(inv[inv.length - 1]! / j);
  const eInv = inv.reduce((sum, t, j) => (j % 2 === 0 ? sum + t : sum - t), 0n);
  const out: bigint[] = [];
  let partial = 0n;
  for (let k = 0; k < CLMM_POISSON_CAP; k++) {
    partial += inv[k]!;
    out.push((eInv * partial) >> (2n * bits - 64n));
  }
  return out;
})();

/** One Poisson(1) count from a uniform u64 (inverse CDF, capped at CLMM_POISSON_CAP). */
export function clmmPoisson1(u: bigint): number {
  let k = 0;
  while (k < CLMM_POISSON_CAP && u >= POISSON_U64[k]!) k++;
  return k;
}

/**
 * Block `block`'s own stream of counts, one per resample: keyed by (the phase seed, the block id)
 * alone (see the header). A window's counts are these but where a resample counted no block of it
 * (clmmWindowCounts).
 */
export function clmmBlockCounts(seed: bigint, block: number, resamples: number): Uint8Array {
  if (!Number.isSafeInteger(block) || block < 0) throw new RangeError(`a block id is a non-negative integer, not ${block}`);
  if (!Number.isInteger(resamples) || resamples < 1) throw new RangeError('resamples must be a positive integer');
  const rng = new SplitMix64(keyedU64(seed, CLMM_BLOCK_DOMAIN, BigInt(block)));
  const out = new Uint8Array(resamples);
  for (let r = 0; r < resamples; r++) out[r] = clmmPoisson1(rng.next());
  return out;
}

/** A window's resampling counts (clmmWindowCounts): what every entry of a phase is resampled with. */
export interface ClmmWindowCounts {
  /** counts[b][r]: block b's count in resample r. */
  counts: Uint8Array[];
  /** totals[r]: resample r's counts summed over the window's blocks, N(r), at least 1. */
  totals: Uint32Array;
}

/**
 * The counts of every block of a `blocks`-block window in each of `resamples` resamples (see the
 * header): block b's own stream (clmmBlockCounts), but a resample counting no block of the window
 * drawn again from the redraw keys. A function of (seed, blocks, resamples) alone.
 */
export function clmmWindowCounts(seed: bigint, blocks: number, resamples: number): ClmmWindowCounts {
  if (!Number.isSafeInteger(blocks) || blocks < 1) throw new RangeError(`a window holds at least one block, not ${blocks}`);
  const counts = Array.from({ length: blocks }, (_, b) => clmmBlockCounts(seed, b, resamples));
  const totals = new Uint32Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let total = 0;
    for (const c of counts) total += c[r]!;
    for (let a = 1; total === 0; a++) {
      if (a > CLMM_MAX_REDRAWS) throw new SimAbortError(`resample ${r} of seed ${seed} counted no block of ${blocks} in ${CLMM_MAX_REDRAWS} redraws`);
      for (let b = 0; b < blocks; b++) {
        const n = clmmPoisson1(keyedU64(seed, CLMM_REDRAW_DOMAIN, BigInt(b), BigInt(r), BigInt(a)));
        counts[b]![r] = n;
        total += n;
      }
    }
    totals[r] = total;
  }
  return { counts, totals };
}

/**
 * Each resample's total of a window's per-block values (see the header): K x (the sum over b of
 * n(b, r) x pnl[b]) / N(r), truncated toward zero, K = pnl.length the window's blocks under `w`.
 */
export function clmmResampledTotals(pnl: readonly bigint[], w: ClmmWindowCounts): bigint[] {
  if (pnl.length !== w.counts.length) throw new RangeError(`${pnl.length} block values for a window of ${w.counts.length} blocks`);
  const sums = new Array<bigint>(w.totals.length).fill(0n);
  pnl.forEach((v, block) => {
    // A block of PnL 0 adds 0 under any count; its counts still weigh in N(r).
    if (v === 0n) return;
    const counts = w.counts[block]!;
    for (let r = 0; r < sums.length; r++) if (counts[r] !== 0) sums[r]! += BigInt(counts[r]!) * v;
  });
  const k = BigInt(pnl.length);
  return sums.map((s, r) => (k * s) / BigInt(w.totals[r]!));
}

/**
 * The paired, normalised Poisson block bootstrap of a window's total (see the header): `pnl[b]` is
 * block b's PnL, one value for every block of the window (at least one), `level` Fixed9 scaled.
 */
export function clmmBlockInterval(pnl: readonly bigint[], level: bigint, resamples: number, seed: bigint): { low: bigint; high: bigint } {
  if (!Number.isInteger(resamples) || resamples < 1) throw new RangeError('resamples must be a positive integer');
  if (level <= 0n || level >= SCALE) throw new RangeError('level must be strictly between 0 and 1');
  const sums = clmmResampledTotals(pnl, clmmWindowCounts(seed, pnl.length, resamples));
  sums.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const B = BigInt(resamples);
  // sim/metrics.ts bootstrapInterval's nearest rank: ceil(num x B / (2 x SCALE)) - 1, within [0, B - 1].
  const rank = (num: bigint) => {
    const r = (num * B + 2n * SCALE - 1n) / (2n * SCALE);
    return Math.min(Number(r < 1n ? 0n : r - 1n), resamples - 1);
  };
  return { low: sums[rank(SCALE - level)]!, high: sums[rank(SCALE + level)]! };
}

const scalesOf = (hello: Pick<ClmmHelloT, 'price_scale' | 'pool'>): BarsScales => ({ quote_scale: USDC_DECIMALS, price_scale: hello.price_scale, qty_scale: hello.pool.decimals });

/** What the hedge reads of a run: its marks, and the resolutions of the actions applied at each open. */
type HedgeRun = Pick<ClmmRun, 'marks' | 'hello' | 'start_quote_units' | 'batches' | 'resolutions' | 'dataset_sha256'>;

/** What the hedge reads of the run's dataset: the bars, for each hour's open and close. */
export type ClmmHedgeBars = Pick<ClmmDataset, 'sha256' | 'bars'>;

/**
 * The run's marks, checked to be the start, one per batch an hour apart and the end at the last
 * batch's t, in order (anything else is a sim bug).
 */
function checkedMarks(run: Pick<ClmmRun, 'marks' | 'batches' | 'start_quote_units'>): ClmmRun['marks'] {
  const m = run.marks;
  if (m.length !== run.batches + 2) throw new SimAbortError(`${m.length} marks for ${run.batches} batches: a run marks the start, every batch and the end`);
  m.forEach((mark, i) => {
    if (mark.seq !== i - 1) throw new SimAbortError(`mark ${i} follows seq ${mark.seq}, not ${i - 1}`);
    if (i === 0) return;
    const t = i === m.length - 1 ? m[i - 1]!.t : m[i - 1]!.t + CLMM_BAR_MS;
    if (mark.t !== t) throw new SimAbortError(`mark ${i} is at ${mark.t}, not ${t}`);
  });
  if (m[0]!.equity_quote_units !== run.start_quote_units) throw new SimAbortError(`the start's equity ${m[0]!.equity_quote_units} is not the starting capital ${run.start_quote_units}`);
  if (m.at(-1)!.asset_units !== '0') throw new SimAbortError(`${m.at(-1)!.asset_units} units of the asset are marked after the close-out`);
  return m;
}

/**
 * x^open (see the header): the asset held right after `decided`, the resolutions of the actions one
 * batch decided, applied at the open of `bar`, the next batch's. Null when none of them is an applied
 * set_range or withdraw: the open changed nothing.
 */
function assetAfterOpen(decided: readonly ClmmResolution[], bar: ClmmDatasetLineT | undefined, x: 0 | 1): bigint | null {
  const moves = decided.filter((r) => r.status === 'applied' && r.action !== 'hold');
  const last = moves.at(-1);
  if (last === undefined) return null;
  if (bar === undefined) throw new SimAbortError(`action ${last.seq}:${last.index} applied at an open with no bar`);
  const o = BigInt(bar.o);
  for (const r of moves) {
    const at = `action ${r.seq}:${r.index}`;
    if (r.applied_t !== bar.t) throw new SimAbortError(`${at} applied at ${r.applied_t}, not at the open of the bar closing at ${bar.t}`);
    if (r.swap !== null && (r.reference_price === null || BigInt(r.reference_price) !== o)) throw new SimAbortError(`${at} swapped from ${r.reference_price}, not from the open ${o} of the bar closing at ${bar.t}`);
  }
  const idle = BigInt(decided.at(-1)!.idle_after[x]);
  if (last.action === 'withdraw') return idle;
  if (last.minted === null || last.lower_tick === null || last.upper_tick === null) throw new SimAbortError(`set_range ${last.seq}:${last.index} applied without a mint`);
  const held = amountsForLiquidity(BigInt(last.minted.liquidity), BigInt(bar.o_sqrt_price_x64), { lower: last.lower_tick, upper: last.upper_tick }, false);
  return idle + (x === 0 ? held.a : held.b);
}

/**
 * Hedged PnL so far at every mark of a run (see the header), in mark order: the start's (0), one per
 * batch, then the end's after the close-out, which is the rank key. `dataset` is the run's: its bars
 * give each hour's open, where the hedge is split.
 */
export function clmmHedgedPnl(run: HedgeRun, dataset: ClmmHedgeBars): bigint[] {
  return hedgeOf(run, dataset).curve;
}

/** clmmHedgedPnl's curve, and how many hedge products it truncated: each of a quantity other than 0 (clmmLvrRoundingBound). */
function hedgeOf(run: HedgeRun, dataset: ClmmHedgeBars): { curve: bigint[]; products: number } {
  if (dataset.sha256 !== run.dataset_sha256) throw new RangeError(`the run replays dataset ${run.dataset_sha256}, not ${dataset.sha256}`);
  const marks = checkedMarks(run);
  const scales = scalesOf(run.hello);
  const x = clmmQuoteIndex(run.hello.pool) === 0 ? 1 : 0;
  const bars = new Map(dataset.bars.map((b) => [b.t, b] as const));
  const decided = new Map<number, ClmmResolution[]>();
  for (const r of run.resolutions) {
    const list = decided.get(r.seq);
    if (list === undefined) decided.set(r.seq, [r]);
    else list.push(r);
  }
  const start = BigInt(run.start_quote_units);
  const out: bigint[] = [];
  let hedge = 0n;
  let products = 0;
  marks.forEach((m, i) => {
    if (i > 0) {
      const prev = marks[i - 1]!;
      const x0 = BigInt(prev.asset_units);
      if (prev.close === null && x0 !== 0n) throw new SimAbortError(`mark ${i - 1} holds ${x0} units of the asset before any close`);
      if (i === marks.length - 1) {
        // The close-out sells at the latest close, which does not move: it hedges nothing.
        if (m.close !== prev.close) throw new SimAbortError(`the close-out is marked at the close ${m.close}, not the latest ${prev.close}`);
      } else {
        // Batch k = i - 1: the actions decided on batch k - 1 applied at its open.
        const bar = bars.get(m.t);
        const xOpen = assetAfterOpen(decided.get(i - 2) ?? [], bar, x);
        if (bar === undefined) {
          // No bar: nothing applied at the open (assetAfterOpen refuses it), so the holdings and the latest close carry over.
          if (m.close !== prev.close || m.asset_units !== prev.asset_units) throw new SimAbortError(`mark ${i}, of an hour with no bar, moved the close (${prev.close} to ${m.close}) or the asset held (${prev.asset_units} to ${m.asset_units})`);
        } else {
          const c = BigInt(bar.c);
          if (m.close === null || BigInt(m.close) !== c) throw new SimAbortError(`mark ${i} is marked at the close ${m.close}, not ${c} of the bar closing at ${bar.t}`);
          // A set_range or withdraw decided with no latest close is rejected (no_bar), so none applies before one.
          if (xOpen !== null && prev.close === null) throw new SimAbortError(`an action applied at batch ${i - 1}'s open, before any close`);
          // barsValue is the protocol's value(q, p): signed, BigInt `/` truncating toward zero.
          if (prev.close !== null) {
            hedge += barsValue(x0, c - BigInt(prev.close), scales);
            if (x0 !== 0n) products++;
          }
          if (xOpen !== null && xOpen !== x0) {
            hedge += barsValue(xOpen - x0, c - BigInt(bar.o), scales);
            products++;
          }
        }
      }
    }
    out.push(BigInt(m.equity_quote_units) - start - hedge);
  });
  return { curve: out, products };
}

/**
 * Each block's hedged PnL (see the header) from clmmHedgedPnl's list: one entry per mark, the start's
 * first and the end's last, so batch k's is entry k + 1.
 */
export function clmmBlockPnl(hedged: readonly bigint[], blockHours: number): bigint[] {
  if (!Number.isInteger(blockHours) || blockHours < 1) throw new RangeError(`block_hours must be a positive integer, not ${blockHours}`);
  const hours = hedged.length - 2;
  if (hours < 1) throw new RangeError(`${hedged.length} hedged marks hold no hour: the start, one per batch and the end`);
  const blocks = Math.ceil(hours / blockHours);
  const out: bigint[] = [];
  let prev = hedged[0]!;
  for (let b = 0; b < blocks; b++) {
    const end = b === blocks - 1 ? hours + 1 : (b + 1) * blockHours;
    out.push(hedged[end]! - prev);
    prev = hedged[end]!;
  }
  return out;
}

/**
 * The fees each open's withdrawal collected that were credited in its own hour, before that open (see
 * the header's fees), [a, b], keyed by the t of the bar it was withdrawn at: the position's fees (all
 * collected there) less what it was credited over the hours before, the batches' fees_credited from
 * its mint's hour on, less, in that hour, what the position withdrawn at its mint's open was credited
 * before it. A run holds one position at a time, so nothing else shares those hours' credits. The
 * close-out's withdrawal (withdrawn_t null) collects at the latest close, none of this.
 */
export function clmmPreOpenCredits(run: Pick<ClmmRun, 'marks' | 'positions'>): Map<number, [bigint, bigint]> {
  const batches = run.marks.slice(1, -1);
  const out = new Map<number, [bigint, bigint]>();
  for (const p of run.positions) {
    if (p.withdrawn_t === null) continue;
    const fees: [bigint, bigint] = [BigInt(p.fees[0]), BigInt(p.fees[1])];
    if (p.withdrawn_t === p.minted_t) {
      // Minted and withdrawn at one open: its life is empty.
      if (fees[0] !== 0n || fees[1] !== 0n) throw new SimAbortError(`a position minted and withdrawn at the open of the bar closing at ${p.minted_t} was credited fees`);
      continue;
    }
    const carried = out.get(p.minted_t) ?? [0n, 0n];
    const pre: [bigint, bigint] = [0n, 0n];
    for (const j of [0, 1] as const) {
      let before = -carried[j];
      for (const m of batches) if (m.t >= p.minted_t && m.t < p.withdrawn_t) before += BigInt(m.fees_credited[j]);
      pre[j] = fees[j] - before;
      const hour = batches.find((m) => m.t === p.withdrawn_t);
      if (before < 0n || pre[j] < 0n || hour === undefined || pre[j] > BigInt(hour.fees_credited[j])) {
        throw new SimAbortError(`the position withdrawn at the open of the bar closing at ${p.withdrawn_t} collected ${fees[j]} of token ${j} in fees, which its marks' credits do not account for`);
      }
    }
    const had = out.get(p.withdrawn_t) ?? [0n, 0n];
    out.set(p.withdrawn_t, [had[0] + pre[0], had[1] + pre[1]]);
  }
  return out;
}

/**
 * The LP fees credited to the run's positions in quote units (see the header): each mark's credits,
 * the asset's valued at the mark's close, but those credited before an open to the position
 * withdrawn there (clmmPreOpenCredits), valued at that open, where they became idle and hedged.
 * `dataset` is the run's: its bars give each open.
 */
export function clmmFeesQuote(run: Pick<ClmmRun, 'marks' | 'hello' | 'positions' | 'dataset_sha256'>, dataset: ClmmHedgeBars): bigint {
  return feesOf(run, dataset).sum;
}

/** clmmFeesQuote's sum, and how many valuations of the asset's credits it truncated (clmmLvrRoundingBound). */
function feesOf(run: Pick<ClmmRun, 'marks' | 'hello' | 'positions' | 'dataset_sha256'>, dataset: ClmmHedgeBars): { sum: bigint; valuations: number } {
  if (dataset.sha256 !== run.dataset_sha256) throw new RangeError(`the run replays dataset ${run.dataset_sha256}, not ${dataset.sha256}`);
  const q = clmmQuoteIndex(run.hello.pool);
  const x = q === 0 ? 1 : 0;
  const scales = scalesOf(run.hello);
  const early = clmmPreOpenCredits(run);
  const bars = new Map(dataset.bars.map((b) => [b.t, b] as const));
  let sum = 0n;
  let valuations = 0;
  run.marks.forEach((m, i) => {
    sum += BigInt(m.fees_credited[q]);
    let asset = BigInt(m.fees_credited[x]);
    // A batch's mark (the start's and the end's credit nothing before an open).
    const atOpen = i > 0 && i < run.marks.length - 1 ? (early.get(m.t)?.[x] ?? 0n) : 0n;
    if (atOpen > 0n) {
      const bar = bars.get(m.t);
      if (bar === undefined) throw new SimAbortError(`a position was withdrawn at the open of the hour closing at ${m.t}, which has no bar`);
      sum += barsValue(atOpen, BigInt(bar.o), scales);
      valuations++;
      asset -= atOpen;
    }
    if (asset === 0n) return;
    if (m.close === null) throw new SimAbortError(`mark ${m.seq} credits ${asset} units of the asset in fees with no close to value them at`);
    sum += barsValue(asset, BigInt(m.close), scales);
    valuations++;
  });
  return { sum, valuations };
}

/** What the run's swaps cost against the reference prices they filled from (see the header), the close-out's included. */
export function clmmCostsQuote(run: Pick<ClmmRun, 'resolutions' | 'close_out' | 'hello'>): bigint {
  const scales = scalesOf(run.hello);
  let sum = 0n;
  const add = (swap: ClmmSwapT, ref: string | null, what: string) => {
    if (ref === null) throw new SimAbortError(`${what} swapped with no reference price`);
    const v = barsValue(BigInt(swap.qty), BigInt(ref), scales);
    const n = BigInt(swap.notional_quote_units);
    const cost = swap.side === 'buy' ? n - v : v - n;
    if (cost < 0n) throw new SimAbortError(`${what}'s ${swap.side} cost ${cost} against its reference price ${ref}: below 0`);
    sum += cost;
  };
  for (const r of run.resolutions) if (r.status === 'applied' && r.swap !== null) add(r.swap, r.reference_price, `action ${r.seq}:${r.index}`);
  if (run.close_out === null) throw new SimAbortError('the run has no close-out');
  if (run.close_out.swap !== null) add(run.close_out.swap, run.close_out.reference_price, 'the close-out');
  return sum;
}

/**
 * One leg of the hedge (see the header's LVR, leg by leg) over which a position was held: the hour of
 * batch `seq` (its bar closing at `t`), from price p0 to p1 (the dataset's price scale), each with the
 * reference sqrt price the position's tokens are read at.
 */
export interface ClmmLvrLeg {
  seq: number;
  t: number;
  /** gap: the latest close to the open; move: the open to the close; hour: the latest close to the close of an hour whose open changed nothing. */
  leg: 'gap' | 'move' | 'hour';
  lower_tick: number;
  upper_tick: number;
  liquidity: bigint;
  p0: bigint;
  p1: bigint;
  sqrt0: bigint;
  sqrt1: bigint;
  /** x(P0): the asset the position holds at p0's sqrt price, rounded down. */
  x0: bigint;
  /** -[V(P1) - V(P0) - x(P0) x (P1 - P0)], truncated toward zero once. */
  lvr: bigint;
}

/** The span a run held over an instant: the one minted at an earlier open (`before`: at an earlier one or this one) and not withdrawn by it. */
function spanHeld(spans: readonly ClmmPositionSpan[], t: number, after: boolean): ClmmPositionSpan | null {
  const held = spans.filter((p) => (after ? p.minted_t <= t : p.minted_t < t) && (p.withdrawn_t === null || (after ? p.withdrawn_t > t : p.withdrawn_t >= t)));
  if (held.length > 1) throw new SimAbortError(`${held.length} positions held ${after ? 'after' : 'before'} the open of the bar closing at ${t}: a run holds one`);
  return held[0] ?? null;
}

/**
 * LVR leg by leg, from the run's positions and the bars' prices alone (see the header): every leg of
 * the hedge over which a position was held, in order. `dataset` is the run's.
 */
export function clmmLvrLegs(run: Pick<ClmmRun, 'marks' | 'hello' | 'batches' | 'positions' | 'dataset_sha256' | 'start_quote_units'>, dataset: ClmmHedgeBars): ClmmLvrLeg[] {
  if (dataset.sha256 !== run.dataset_sha256) throw new RangeError(`the run replays dataset ${run.dataset_sha256}, not ${dataset.sha256}`);
  const marks = checkedMarks(run);
  const q = clmmQuoteIndex(run.hello.pool);
  const den = 10n ** BigInt(run.hello.pool.decimals + run.hello.price_scale);
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const bars = new Map(dataset.bars.map((b) => [b.t, b] as const));
  const out: ClmmLvrLeg[] = [];
  const leg = (seq: number, t: number, kind: ClmmLvrLeg['leg'], p: ClmmPositionSpan | null, from: { p: bigint; sqrt: bigint }, to: { p: bigint; sqrt: bigint }) => {
    if (p === null) return;
    const range = { lower: p.lower_tick, upper: p.upper_tick };
    const L = BigInt(p.liquidity);
    const at0 = amountsForLiquidity(L, from.sqrt, range, false);
    const at1 = amountsForLiquidity(L, to.sqrt, range, false);
    const [x0, y0, x1, y1] = q === 0 ? [at0.b, at0.a, at1.b, at1.a] : [at0.a, at0.b, at1.a, at1.b];
    // V(P) = y + x x P (USDC raw units), over den: V(P1) - V(P0) - x(P0) x (P1 - P0), one truncation toward zero.
    const num = (y1 - y0) * den + (x1 * to.p - x0 * from.p - x0 * (to.p - from.p)) * unit;
    out.push({ seq, t, leg: kind, lower_tick: p.lower_tick, upper_tick: p.upper_tick, liquidity: L, p0: from.p, p1: to.p, sqrt0: from.sqrt, sqrt1: to.sqrt, x0, lvr: -(num / den) });
  };
  let latest: ClmmDatasetLineT | null = null;
  // The batches' marks (the start's and the end's apart: the close-out sells at the latest close, which does not move).
  for (let i = 1; i < marks.length - 1; i++) {
    const t = marks[i]!.t;
    const bar = bars.get(t);
    // An hour with no bar moves nothing and hedges nothing; the next bar's gap runs from the latest close.
    if (bar === undefined) continue;
    const before = spanHeld(run.positions, t, false);
    const after = spanHeld(run.positions, t, true);
    const close = { p: BigInt(bar.c), sqrt: BigInt(bar.c_sqrt_price_x64) };
    const moved = run.positions.some((p) => p.minted_t === t || p.withdrawn_t === t);
    if (latest === null) {
      // Nothing is held before the first close, and nothing is minted at its open (no_bar).
      if (before !== null || moved) throw new SimAbortError(`a position is held at the open of the bar closing at ${t}, before any close`);
    } else {
      const from = { p: BigInt(latest.c), sqrt: BigInt(latest.c_sqrt_price_x64) };
      if (!moved) leg(i - 1, t, 'hour', before, from, close);
      else {
        const open = { p: BigInt(bar.o), sqrt: BigInt(bar.o_sqrt_price_x64) };
        leg(i - 1, t, 'gap', before, from, open);
        leg(i - 1, t, 'move', after, open, close);
      }
    }
    latest = bar;
  }
  return out;
}

/** clmmLvrLegs summed: the run's LVR leg by leg, which lvr_quote_units (fees - costs - hedged PnL) must match (see the header). */
export function clmmLvrByLegs(run: Pick<ClmmRun, 'marks' | 'hello' | 'batches' | 'positions' | 'dataset_sha256' | 'start_quote_units'>, dataset: ClmmHedgeBars): bigint {
  return clmmLvrLegs(run, dataset).reduce((s, l) => s + l.lvr, 0n);
}

/** What the LVR check (clmmLvrCheck) needs of a run: the hedge's, the legs' and the swaps'. */
export type ClmmLvrRun = Pick<ClmmRun, 'marks' | 'hello' | 'batches' | 'positions' | 'dataset_sha256' | 'start_quote_units' | 'resolutions' | 'close_out'>;

/**
 * How far lvr_quote_units may sit from clmmLvrByLegs by rounding alone (see the header's LVR), in
 * quote units: one per truncation toward zero that can err either way, and two per mint. Those are each
 * leg's own (`legs` of clmmLvrLegs); each hedge product of a quantity other than 0 (an hour's
 * x_{h-1} x (c_h - c_{h-1}), and where its open moved the asset held, (x_h^open - x_{h-1}) x (c_h - o_h));
 * each valuation of the asset's fees (a mark's credits at its close, those an open's withdrawal
 * collected of its own hour at that open); each swap's value at its reference price, the close-out's
 * included; and per mint its deposit rounded up, a raw unit of USDC and one of the asset (worth under a
 * quote unit at these pools' prices). The tolerance tests/unit/sim-clmm-metrics.test.ts holds the
 * reported LVR to on every scorer test, counted from the run here rather than from the wire.
 */
export function clmmLvrRoundingBound(run: ClmmLvrRun, dataset: ClmmHedgeBars, legs: number = clmmLvrLegs(run, dataset).length): bigint {
  const { products } = hedgeOf(run, dataset);
  const { valuations } = feesOf(run, dataset);
  const swaps = run.resolutions.filter((r) => r.status === 'applied' && r.swap !== null).length + (run.close_out?.swap ? 1 : 0);
  return BigInt(legs + products + valuations + swaps + 2 * run.positions.length);
}

/** The LVR check of one score (clmmLvrCheck): the reported LVR, LVR leg by leg, how far apart, and the rounding bound. */
export interface ClmmLvrCheck {
  /** lvr_quote_units: fees - costs - hedged PnL. */
  reported: bigint;
  /** clmmLvrByLegs: from the run's positions and the bars' prices alone. */
  by_legs: bigint;
  /** reported - by_legs. */
  off: bigint;
  /** clmmLvrRoundingBound: the most |off| rounding alone accounts for. */
  bound: bigint;
  legs: number;
  /** |off| <= bound. */
  ok: boolean;
}

/**
 * The reported LVR of a run's score (`reported`, its lvr_quote_units) against LVR leg by leg
 * (clmmLvrByLegs), within clmmLvrRoundingBound: the residual fees - costs - hedged PnL can hide an
 * error in any of the three, and the legs are computed apart from all of them, so a score whose two
 * part by more than rounding carries a fault of the scorer or the engine, never the entry's.
 */
export function clmmLvrCheck(run: ClmmLvrRun, dataset: ClmmHedgeBars, reported: string | bigint): ClmmLvrCheck {
  const legs = clmmLvrLegs(run, dataset);
  const byLegs = legs.reduce((s, l) => s + l.lvr, 0n);
  const r = BigInt(reported);
  const bound = clmmLvrRoundingBound(run, dataset, legs.length);
  const off = r - byLegs;
  return { reported: r, by_legs: byLegs, off, bound, legs: legs.length, ok: off >= -bound && off <= bound };
}

/**
 * A clmm score whose reported LVR parts from LVR leg by leg by more than rounding (clmmLvrCheck): a
 * fault of the scorer or the engine, never the entry's, so nothing is scored. A SimAbortError, as every
 * fault of the sim is; the grade job meets it as the platform's fault (grader/worker.ts).
 */
export class ClmmLvrMismatchError extends SimAbortError {
  readonly check: ClmmLvrCheck;

  constructor(check: ClmmLvrCheck) {
    super(
      `the clmm score's LVR ${check.reported} (fees - costs - hedged PnL) is ${check.off} quote units from LVR leg by leg ${check.by_legs} (${check.legs} legs), over the rounding bound ${check.bound}: a fault of the scorer or the engine, never the entry's, and nothing is scored`,
    );
    this.name = 'ClmmLvrMismatchError';
    this.check = check;
  }
}

/** clmmLvrCheck of a scored run (ScoredClmmReplay's run and metrics), thrown as ClmmLvrMismatchError when it fails; the check when it holds. */
export function assertClmmLvr(scored: { run: ClmmLvrRun; metrics: Pick<ClmmReplayMetricsT, 'lvr_quote_units'> }, dataset: ClmmHedgeBars): ClmmLvrCheck {
  const check = clmmLvrCheck(scored.run, dataset, scored.metrics.lvr_quote_units);
  if (!check.ok) throw new ClmmLvrMismatchError(check);
  return check;
}

/** The mean share of equity in an in-range position over the window's sample intervals, Fixed9 scaled (see the header). */
export function clmmInRangeShare9(run: Pick<ClmmRun, 'marks'>): bigint {
  let sum = 0n;
  let n = 0n;
  for (const m of run.marks) {
    sum += BigInt(m.in_range_share_9_sum);
    n += BigInt(m.intervals);
  }
  if (sum > n * SCALE) throw new SimAbortError(`in-range shares summing to ${sum} over ${n} intervals: a share is at most 1`);
  return n === 0n ? 0n : sum / n;
}

/** The bot's applied set_range and withdraw actions (holds, rejections and the close-out excluded). */
export function clmmActionsApplied(run: Pick<ClmmRun, 'resolutions'>): number {
  return run.resolutions.filter((r) => r.status === 'applied' && r.action !== 'hold').length;
}

/** Why a hello was not made from this harness: the first of pool, capital, fees and caps that differs; null when none does. */
export function clmmHarnessMismatch(hello: Pick<ClmmHelloT, 'pool' | 'capital' | 'fees' | 'caps'>, harness: Pick<ClmmReplayHarnessT, 'pool' | 'capital' | 'fees' | 'caps'>): string | null {
  for (const key of ['pool', 'capital', 'fees', 'caps'] as const) {
    if (canonicalJson(hello[key]) !== canonicalJson(harness[key])) return `the action log's hello ${key} ${canonicalJson(hello[key])} is not the harness's ${canonicalJson(harness[key])}`;
  }
  return null;
}

/** Whether two runs of one action log resolved some action otherwise: status or reason (see the header's flags). */
export function clmmRunsDiverge(a: Pick<ClmmRun, 'resolutions'>, b: Pick<ClmmRun, 'resolutions'>): boolean {
  if (a.resolutions.length !== b.resolutions.length) return true;
  return a.resolutions.some((r, i) => {
    const o = b.resolutions[i]!;
    return r.seq !== o.seq || r.index !== o.index || r.status !== o.status || r.reason !== o.reason;
  });
}

/**
 * ClmmReplayMetrics of a run of `dataset`, with the CLMM_COST_MULTIPLIER run of the same action log,
 * under the harness's guardrails and interval. The dataset's bars give the hedge each hour's open.
 */
export function computeClmmMetrics(dataset: ClmmHedgeBars, run: ClmmRun, costRun: ClmmRun, harness: ClmmReplayHarnessT, finalWindow: ClmmFinalWindow): ClmmReplayMetricsT {
  if (run.aborted !== null) throw new SimAbortError(`run aborted: ${run.aborted}`);
  if (costRun.aborted !== null) throw new SimAbortError(`cost-sensitivity run aborted: ${costRun.aborted}`);
  if (run.fee_multiplier !== 1) throw new RangeError(`the scored run is at fee multiplier ${run.fee_multiplier}, not 1`);
  if (costRun.fee_multiplier !== CLMM_COST_MULTIPLIER) throw new RangeError(`the cost-sensitivity run is at fee multiplier ${costRun.fee_multiplier}, not ${CLMM_COST_MULTIPLIER}`);
  if (costRun.dataset_sha256 !== run.dataset_sha256 || canonicalJson(costRun.action_log) !== canonicalJson(run.action_log)) throw new RangeError('the cost-sensitivity run replays another action log or dataset');
  if (dataset.sha256 !== run.dataset_sha256) throw new RangeError(`the run replays dataset ${run.dataset_sha256}, not ${dataset.sha256}`);
  const h = ClmmReplayHarness.parse(harness);
  const mismatch = clmmHarnessMismatch(run.hello, h);
  if (mismatch !== null) throw new SimDataError(mismatch);

  const start = BigInt(run.start_quote_units);
  const q = clmmQuoteIndex(run.hello.pool);
  if (run.final_account.idle[q === 0 ? 1 : 0] !== '0') throw new SimAbortError('the final account holds the asset after the close-out');
  const final = BigInt(run.final_account.idle[q]);
  if (run.marks.at(-1)?.equity_quote_units !== final.toString()) throw new SimAbortError(`the end's mark is not the final account's ${final} USDC`);

  const hedgedCurve = clmmHedgedPnl(run, dataset);
  const hedged = hedgedCurve.at(-1)!;
  const fees = clmmFeesQuote(run, dataset);
  const costs = clmmCostsQuote(run);
  const share = clmmInRangeShare9(run);
  const dd = maxDrawdown9(hedgedCurve.map((v) => start + v));
  const blocks = clmmBlockPnl(hedgedCurve, h.interval.block_hours);
  const ci = clmmBlockInterval(blocks, parseFixed9(h.interval.level), h.interval.resamples, BigInt(run.hello.seed));
  const costHedged = clmmHedgedPnl(costRun, dataset).at(-1)!;
  const inRangeOk = share >= parseFixed9(h.guardrails.min_in_range_share);

  let firstBar: string | null = null;
  let receipt: string | null = null;
  let after: boolean | null = null;
  if (finalWindow !== null) {
    receipt = finalWindow.last_graded_receipt_at;
    const receiptMs = Date.parse(receipt);
    if (Number.isNaN(receiptMs)) throw new RangeError(`last_graded_receipt_at ${JSON.stringify(receipt)} is not a date-time`);
    firstBar = new Date(run.window.start_ms).toISOString();
    after = run.window.start_ms > receiptMs;
  }

  const metrics: ClmmReplayMetricsT = {
    hedged_pnl_quote_units: hedged.toString(),
    net_pnl_quote_units: (final - start).toString(),
    fees_quote_units: fees.toString(),
    costs_quote_units: costs.toString(),
    lvr_quote_units: (fees - costs - hedged).toString(),
    in_range_share: toFixed9(share),
    actions: clmmActionsApplied(run),
    max_drawdown: toFixed9(dd),
    per_block: blocks.map((pnl, block) => ({ block, pnl_quote_units: pnl.toString() })),
    interval: {
      level: h.interval.level,
      method: CLMM_INTERVAL_METHOD,
      block_hours: h.interval.block_hours,
      resamples: h.interval.resamples,
      seed: run.hello.seed,
      low_quote_units: ci.low.toString(),
      high_quote_units: ci.high.toString(),
    },
    cost_sensitivity: { fee_multiplier: CLMM_COST_MULTIPLIER, hedged_pnl_quote_units: costHedged.toString() },
    constraints: { min_in_range_share: h.guardrails.min_in_range_share, in_range_ok: inRangeOk, compliant: inRangeOk },
    contamination: {
      no_future_bars: run.no_future_bars,
      final_window_first_bar_time: firstBar,
      last_graded_receipt_at: receipt,
      window_after_receipts: after,
      dataset_sha256: run.dataset_sha256,
    },
  };
  return ClmmReplayMetrics.parse(metrics);
}

export interface ScoredClmmReplay {
  metrics: ClmmReplayMetricsT;
  /** Score flags the replay raises: CLMM_COST_RUN_DIVERGED, or none. */
  flags: string[];
  run: ClmmRun;
  cost_run: ClmmRun;
}

/**
 * The clmm score of an action log: a pure function of (dataset, action log, harness, final window).
 * Refuses a log whose hello is not the harness's (SimDataError), replays it at fee multiplier 1 and
 * at CLMM_COST_MULTIPLIER, then computes the metrics. Throws SimAbortError when either replay aborts
 * (never a partial score).
 */
export function scoreClmmActionLog(dataset: ClmmDataset, log: ClmmActionLogT, harness: ClmmReplayHarnessT, finalWindow: ClmmFinalWindow): ScoredClmmReplay {
  const h = ClmmReplayHarness.parse(harness);
  const parsed = ClmmActionLog.parse(log);
  const mismatch = clmmHarnessMismatch(parsed.hello, h);
  if (mismatch !== null) throw new SimDataError(mismatch);
  const run = replayClmmActionLog(dataset, parsed);
  if (run.aborted !== null) throw new SimAbortError(`run aborted: ${run.aborted}`);
  const costRun = replayClmmActionLog(dataset, parsed, { feeMultiplier: CLMM_COST_MULTIPLIER });
  const metrics = computeClmmMetrics(dataset, run, costRun, h, finalWindow);
  return { metrics, flags: clmmRunsDiverge(run, costRun) ? [CLMM_COST_RUN_DIVERGED] : [], run, cost_run: costRun };
}
