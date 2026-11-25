// The clmm-replay/v1 performance of a score (contracts/score.ts Score.performance): a variant of
// score.ts's `Performance` union, defined in this module of its own (score.ts imports it). It is a
// pure function of the dataset (contracts/clmm-dataset.ts) and the canonical
// action log (sim/clmm/metrics.ts scoreClmmActionLog computes it), with no ids and no wall-clock
// times. Quote units are USDC raw units (the harness's capital.quote_scale, 6), as I64 or U64 decimal
// strings; shares are Fixed9.
//
//   hedged_pnl_quote_units   THE RANK KEY: the run's PnL with the asset's price exposure hedged out
//                            over every hour, each split at its open, where the bot's actions
//                            apply. It is final USDC - starting capital - the sum over the hours h
//                            with a bar of x_{h-1} x (o_h - c_{h-1}) + x_h^open x (c_h - o_h): the
//                            gap from the previous close to the open hedged with x_{h-1}, the asset
//                            held at the previous close (in the position, idle and in its fees
//                            owed), and the move from the open to the close with x_h^open, the
//                            asset held right after the open's actions. o and c are the bars'
//                            5-minute medians; an hour with no bar hedges nothing, so the next
//                            bar's gap runs from the latest close. Each hour is valued as
//                            value(x_{h-1}, c_h - c_{h-1}) + value(x_h^open - x_{h-1}, c_h - o_h)
//                            (clmm-protocol.ts value(q, p), truncated toward zero): an hour whose
//                            open changed no holdings hedges exactly value(x_{h-1}, c_h - c_{h-1}).
//                            sim/clmm/metrics.ts states how the holdings are read. Holding the asset
//                            through a rally earns nothing here, nor does buying it at an open just
//                            before the move: what is left is fees, minus loss-versus-rebalancing
//                            (LVR; Milionis, Moallemi, Roughgarden and Zhang, arXiv 2208.06046),
//                            minus swap costs
//   net_pnl_quote_units      final USDC after the close-out - starting capital, unhedged
//   fees_quote_units         the LP fees credited to the bot's positions, each token's credit valued
//                            in quote units at the close of the hour it was credited in; but a
//                            credit an open's withdrawal (a withdraw or a re-range) collected in its
//                            own hour, before that open, is valued at that open: from there it is
//                            idle, and hedged as idle
//   costs_quote_units        what the swaps cost against the reference price they filled from (the
//                            open for an action's swap, the close for the close-out): a buy's
//                            notional - value(qty, that price), a sell's value(qty, that price) -
//                            its proceeds. That is the fee, the modelled slippage and the impact
//                            together, so never below 0
//   lvr_quote_units          fees - costs - hedged PnL: what rebalancing lost to the price's moves,
//                            so hedged = fees - LVR - costs. Above 0 for an LP that lost to
//                            arbitrage: the hedge holds the asset the account held over each leg
//                            of an hour (the gap to the open, the open to the close), and a
//                            position's value is concave in the price, so a leg's move shows as
//                            LVR, never as a gain. sim/clmm/metrics.ts clmmLvrByLegs computes it
//                            on its own, leg by leg, from the positions and the bars' prices: the
//                            two agree to within value()'s truncation and a mint's rounding
//   in_range_share           the mean, over the window's sample intervals (consecutive rows), of
//                            the share of equity held in a position whose range holds both of the
//                            interval's ticks, 0..1
//   actions                  the bot's applied set_range and withdraw actions (holds, rejections
//                            and the close-out excluded)
//   max_drawdown             the largest (peak - value) / peak of the hedged equity curve (starting
//                            capital + hedged PnL so far, at every close), 0 or above (above 1
//                            only if that curve went below 0)
//   per_block                the hedged PnL of each block of interval.block_hours hours of the
//                            window from its start, block 0 first (the last block ends with the
//                            close-out), adding up to hedged_pnl_quote_units
//   interval                 a paired, seeded bootstrap of hedged PnL resampling the window's K
//                            blocks: in each resample block b counts n_b times, a Poisson(1) draw
//                            keyed by the phase seed and the block id alone (a resample counting no
//                            block drawn again), and the resample is normalised to the window's K
//                            blocks, K x (the sum of n_b x PnL_b) / (the sum of n_b): the
//                            count-weighted mean block, scaled to K. Every entry of a phase is
//                            resampled with the same counts (server/routes/competitions/ranking.ts
//                            pairs them). Its width is close to, slightly wider than, the textbook
//                            block bootstrap's (K blocks drawn with replacement) at the 28 blocks of
//                            a week, and wider still on few blocks, so a window holds at least
//                            clmm-protocol.ts clmmMinBlocksOf(its phase) whole ones: CLMM_MIN_BLOCKS
//                            (8) on dev, CLMM_RANKED_MIN_BLOCKS (28) on the ranked final phase, whose
//                            board pays the prizes (clmmPhaseBlocksIssue; clmmBlockHoursIssue, the
//                            8 alone, where no phase is named).
//                            Its method is CLMM_INTERVAL_METHOD ('bootstrap-blocks/v2'), the only
//                            one a score may name: 'bootstrap-blocks', the plain counted sum drawn
//                            before the resamples were normalised, is refused at parse (no clmm
//                            competition ever stored one)
//   cost_sensitivity         the same action log replayed with fees.fee_bps doubled (the swap fee
//                            the bot pays; the LP fees it earns are unchanged): its hedged PnL
//   constraints              the harness's guardrails, evaluated: in_range_share at or above
//                            min_in_range_share. A non-compliant entry ranks below every compliant
//                            one (eligibility reason non_compliant, grader/score.ts)
//   contamination            the causality audit found nothing the bot was sent ahead of its time,
//                            and the final window starts after every graded receipt
//                            (score.ts BarsContamination's rule, repeated: ClmmContamination)
//
// The identities a performance must satisfy are refinements that run only on a value whose shape
// already parsed (bars-protocol.ts whenBarsValid).

import { z } from 'zod';
import { barsIssuer, whenBarsValid } from './bars-protocol.ts';
import { CLMM_HARNESS_KIND } from './clmm-protocol.ts';
import { Fixed9, FIXED9_SCALE, I64, IsoDateTime, parseFixed9, Sha256Hex, U64 } from './primitives.ts';

const fixed9In = (s: string, lo: bigint, hi: bigint) => {
  const v = parseFixed9(s);
  return v >= lo && v <= hi;
};

/**
 * The interval method every clmm score is drawn under now (see the header's interval): the block
 * bootstrap, each resample normalised to the window's K blocks. The harness block's interval.method
 * stays 'bootstrap-blocks' (clmm-protocol.ts ClmmIntervalConfig: the family a bundle asks for); a
 * score names the draw it was made with.
 */
export const CLMM_INTERVAL_METHOD = 'bootstrap-blocks/v2';

/**
 * Every method a stored clmm score may name: CLMM_INTERVAL_METHOD alone. A score naming
 * 'bootstrap-blocks', the plain counted sum drawn before it (each block's PnL counted Poisson(1)
 * times and summed, no normalisation), is refused at parse with CLMM_PRE_NORMALISED_REFUSAL: no clmm
 * competition ever stored one, so no score of that draw is read, reproduced or tied.
 */
export const CLMM_INTERVAL_METHODS = [CLMM_INTERVAL_METHOD] as const;

/** Why a score naming 'bootstrap-blocks' does not parse (ClmmPnlInterval's method). */
export const CLMM_PRE_NORMALISED_REFUSAL = `interval method 'bootstrap-blocks' predates the normalised resamples: a clmm score's interval is drawn under '${CLMM_INTERVAL_METHOD}', each resample normalised to the window's blocks`;

/** Seeded, paired block bootstrap of hedged PnL (see the header). */
export const ClmmPnlInterval = z
  .strictObject({
    /** e.g. "0.900000000". */
    level: Fixed9,
    /** CLMM_INTERVAL_METHOD: the draw the interval was made with. */
    method: z.enum(CLMM_INTERVAL_METHODS, { error: (iss) => (iss.input === 'bootstrap-blocks' ? CLMM_PRE_NORMALISED_REFUSAL : undefined) }),
    /** The harness's interval.block_hours: the hours each block covers. */
    block_hours: z.int().min(1),
    resamples: z.int().min(1),
    seed: U64,
    low_quote_units: I64,
    high_quote_units: I64,
  })
  .refine((i) => BigInt(i.low_quote_units) <= BigInt(i.high_quote_units), { message: 'low_quote_units is above high_quote_units', path: ['high_quote_units'], ...whenBarsValid });

/** One block's hedged PnL. */
export const ClmmBlockPnl = z.strictObject({
  /** The block's index from the window's start: hours [block x block_hours, (block + 1) x block_hours). */
  block: z.int().min(0),
  pnl_quote_units: I64,
});

/** The clmm harness's guardrails, evaluated. A non-compliant entry ranks below every compliant one. */
export const ClmmConstraints = z
  .strictObject({
    min_in_range_share: Fixed9,
    in_range_ok: z.boolean(),
    compliant: z.boolean(),
  })
  .refine((c) => c.compliant === c.in_range_ok, { message: 'compliant is in_range_ok', path: ['compliant'], ...whenBarsValid });

/** Evidence that no future bar or row reached the bot and the final window post-dates every entry (score.ts BarsContamination's keys). */
export const ClmmContamination = z.strictObject({
  /**
   * The replay's causality audit (sim/clmm/engine.ts) found nothing the bot was sent ahead of its
   * time: every batch went out after the reply to the one before, on its hour; no bar after its batch;
   * every result resolved at the open after its decision; every account marked at a close the bot had
   * been sent. False is the engine's fault, never the entry's: grading refuses it as a harness fault
   * that the job retries, so a stored score always carries true.
   */
  no_future_bars: z.boolean(),
  /** The final window's first hour's open time (window.start_ms; null on the dev phase). */
  final_window_first_bar_time: IsoDateTime.nullable(),
  /** Server time of the last graded receipt (null on the dev phase). */
  last_graded_receipt_at: IsoDateTime.nullable(),
  /** final_window_first_bar_time > last_graded_receipt_at (null on the dev phase). */
  window_after_receipts: z.boolean().nullable(),
  dataset_sha256: Sha256Hex,
});

export const ClmmReplayMetrics = z
  .strictObject({
    /** The rank key. */
    hedged_pnl_quote_units: I64,
    net_pnl_quote_units: I64,
    fees_quote_units: U64,
    costs_quote_units: U64,
    lvr_quote_units: I64,
    /** 0..1. */
    in_range_share: Fixed9,
    actions: z.int().min(0),
    /** Of the hedged equity curve, 0 or above. */
    max_drawdown: Fixed9,
    per_block: z.array(ClmmBlockPnl).min(1),
    interval: ClmmPnlInterval,
    /** The same action log re-scored with fee_bps doubled. */
    cost_sensitivity: z.strictObject({
      fee_multiplier: z.literal(2),
      hedged_pnl_quote_units: I64,
    }),
    constraints: ClmmConstraints,
    contamination: ClmmContamination,
  })
  .superRefine((m, ctx) => {
    const issue = barsIssuer(ctx);
    if (!fixed9In(m.in_range_share, 0n, FIXED9_SCALE)) issue(['in_range_share'], 'in_range_share is a share: 0..1');
    if (parseFixed9(m.max_drawdown) < 0n) issue(['max_drawdown'], 'max_drawdown is 0 or above');

    const hedged = BigInt(m.hedged_pnl_quote_units);
    const lvr = BigInt(m.fees_quote_units) - BigInt(m.costs_quote_units) - hedged;
    if (lvr !== BigInt(m.lvr_quote_units)) issue(['lvr_quote_units'], `LVR is fees - costs - hedged PnL = ${lvr}, not ${m.lvr_quote_units}`);

    let sum = 0n;
    m.per_block.forEach((b, i) => {
      if (b.block !== i) issue(['per_block', i, 'block'], `per_block rows are blocks 0, 1, ... in order: row ${i} is block ${b.block}`);
      sum += BigInt(b.pnl_quote_units);
    });
    if (sum !== hedged) issue(['per_block'], `per_block PnL adds up to ${sum}, not hedged_pnl_quote_units ${m.hedged_pnl_quote_units}`);

    const c = m.constraints;
    if (!fixed9In(c.min_in_range_share, 0n, FIXED9_SCALE)) issue(['constraints', 'min_in_range_share'], 'min_in_range_share is a share: 0..1');
    else if (c.in_range_ok !== parseFixed9(m.in_range_share) >= parseFixed9(c.min_in_range_share)) issue(['constraints', 'in_range_ok'], 'in_range_ok is in_range_share at or above min_in_range_share');
  }, whenBarsValid);

export const ClmmReplayPerformance = z.strictObject({
  kind: z.literal(CLMM_HARNESS_KIND),
  metrics: ClmmReplayMetrics,
});

export type ClmmPnlIntervalT = z.infer<typeof ClmmPnlInterval>;
export type ClmmBlockPnlT = z.infer<typeof ClmmBlockPnl>;
export type ClmmConstraintsT = z.infer<typeof ClmmConstraints>;
export type ClmmContaminationT = z.infer<typeof ClmmContamination>;
export type ClmmReplayMetricsT = z.infer<typeof ClmmReplayMetrics>;
export type ClmmReplayPerformanceT = z.infer<typeof ClmmReplayPerformance>;
