// agent-fun/clmm-replay/v1: the line protocol between the grader's CLMM replay harness and an entrant's
// bot, and the harness block a competition bundle carries for it (ClmmReplayHarness). A causal replay,
// hour by hour, of one concentrated-liquidity pool (an Orca Whirlpool or a Raydium CLMM pairing an
// asset with USDC) from pool state our own poller recorded (contracts/clmm-dataset.ts): the bot manages
// one liquidity position in the pool, setting its tick range, re-centring it and withdrawing it. The
// framing is agent-fun/replay/v2's (protocol.ts), as bars-replay/v1's is: one JSON object per line
// (UTF-8, `\n`-terminated, the `\n` not counted in the limits) on the bot's stdin (harness -> bot, at
// most MAX_HARNESS_LINE_BYTES per line) and stdout (bot -> harness, at most MAX_BOT_LINE_BYTES per
// line). Every message is zod-strict: an unknown key, a missing key or a malformed value is a protocol
// violation. No key is optional.
//
//   harness -> bot   hello                                   once, first
//   harness -> bot   batch {seq, t, bar, results, ...}       once per hour of the window, in order
//   bot -> harness   reply {seq, actions[]}                  exactly one per batch, echoing its seq,
//                                                            before the next batch is sent (lockstep)
//   harness -> bot   done                                    once, last; the bot exits without replying
//
// Units (BigInt throughout; amounts travel as canonical decimal strings, ticks and times as integers):
//   - Token amounts are raw units of their mint, in pairs [a, b] in the pool's own order (Whirlpool
//     A/B, CLMM 0/1): pool.mint_a's, then pool.mint_b's. One of the two mints is USDC's (6 decimals),
//     the other the asset's, of pool.decimals decimals (pools.json's `decimals`). clmmQuoteIndex names
//     the USDC side. A quote amount (*_quote_units) is USDC raw units: capital.quote_scale is USDC's 6.
//   - A price p is p / 10^price_scale USDC per whole unit (10^decimals raw units) of the asset, at
//     hello.price_scale (the dataset's, pools.json's). value(q, p) = q * p * 10^6 / 10^(decimals +
//     price_scale), truncated: the quote units that q raw units of the asset are worth at p.
//   - A tick i is the pool's price 1.0001^i, in raw units of token B per raw unit of token A. A sqrt
//     price (*_sqrt_price_x64) is the pool's Q64.64 square root of that price, a liquidity (u128) the
//     pool's in-range liquidity. Ticks lie in [CLMM_MIN_TICK, CLMM_MAX_TICK] = [-443636, 443636] on
//     both venues. A range [lower, upper) holds tick i when lower <= i < upper, the venues' in-range
//     rule. With USDC as token B a higher tick is a higher asset price; with USDC as token A it is a
//     lower one.
//   - Fee growth is the pool's global fee growth per unit of in-range liquidity, per token, in Q64.64:
//     a u128 counter that wraps at 2^128 (collector/bars/decode.ts feeGrowthDelta takes its wrapping
//     delta).
//   - A bar's t is its CLOSE time: its open time + 1 h, a whole UTC hour, in ms since the Unix epoch.
//     o, h, l, c, o_depth and c_depth are bars-replay/v1's (contracts/bars-protocol.ts). o and c are
//     the medians of the samples' prices over the bar's first and last five minutes, the only prices
//     the replay swaps and marks at. h and l are the extremes of every sample, which are information,
//     never a fill or a mark. The depths are the pool's at o and at c, one hop (the pool is
//     USDC-quoted), in USDC raw units. o_tick, o_sqrt_price_x64 and o_liquidity are the pool's state
//     in the open's reference sample: of the samples in the bar's first five minutes, the lower median
//     by sqrt price (contracts/clmm-dataset.ts clmmReferenceRow). The c_ three are the same for the
//     close's last five minutes. fee_growth_delta_x64 is the pool's fee growth from the last sample
//     before the bar to its last sample (the bar's first sample for the window's first bar), per
//     token, wrapping.
//
// Market model (sim/clmm/engine.ts implements it; hello and the bars tell the bot the numbers):
//   - Time: batch k (seq k) closes bar k of the window at t = first_close_ms + k x 1 h, even when the
//     hour holds no sample; its bar is null then. The latest close is the close at or before the
//     batch, however many hours back.
//   - Capital: the account starts with capital.quote_units of USDC, idle, and no position.
//   - Equity: the USDC held (idle, in the position, in its fees owed), plus value(the asset held the
//     same three ways, the latest close c). The position's tokens are the amounts its liquidity holds
//     at the latest close's sqrt price (c_sqrt_price_x64). No fee, slippage or impact is charged.
//   - Fees: the dataset's rows are the pool's samples, one about every 10 s. Over each interval
//     between two consecutive rows r0 and r1, a position earns, per token,
//       floor(feeGrowthDelta(r0.fee_growth, r1.fee_growth) x L_pos x L_pool / ((L_pool + L_pos) x 2^64))
//     with L_pos its liquidity and L_pool r0's liquidity. It earns only when r1.ts - r0.ts <=
//     CLMM_MAX_FEE_INTERVAL_MS (30 s), both r0.tick and r1.tick lie in its range, and the interval
//     falls within its life (below). The position is not on chain, so the pool's liquidity never
//     counts it: its own liquidity dilutes the pool's, and the pool's volume is taken as unchanged by
//     it. While the price stays in range the global growth equals the growth inside the range, so the
//     credit is exact up to the floor. An excursion out of the range and back between two samples is
//     the model's stated limit, and caps.min_width_ticks bounds it. Ticks crossed are ignored (tick
//     arrays are not recorded). Fees accrue to the position (fees_owed) until it is withdrawn.
//   - A position's life starts at the end of the open window of the bar it was minted at. That end is
//     the bar's first sample's ts + BARS_REFERENCE_MS (contracts/bars-dataset.ts), about 5 minutes
//     after the open. The position earns from the first interval whose r0.ts is at or after it, and
//     through the last interval whose r0.ts is before the end of the open window of the bar it is
//     withdrawn at (the final close-out: through the window's last row).
//   - Actions decided on batch k apply at the OPEN of bar k + 1, in reply order. Every action of
//     batch k is resolved there, applied or rejected, and comes back in batch k + 1's results in reply
//     order. An action decided on the last batch is rejected (after_end) and reported in the action
//     log only: done carries the final account, not results.
//   - Checked when decided, in reply order, the first failing check naming the reason:
//       max_actions_per_batch  the action is past the first caps.max_actions_per_batch of the reply. A
//                              reply carrying more than clmmReplyActionCap(hello) = max(64, 4 x
//                              max_actions_per_batch) actions is a protocol violation that fails the run
//       after_end              decided on the last batch
//     set_range and withdraw, then:
//       no_bar                 no bar has closed yet (there is no latest close to decide against)
//     set_range, then (clmmRangeRejection):
//       tick_bounds            lower_tick or upper_tick is outside [CLMM_MIN_TICK, CLMM_MAX_TICK]
//       tick_spacing           lower_tick or upper_tick is not a multiple of pool.tick_spacing
//       min_width              upper_tick - lower_tick < caps.min_width_ticks (an inverted range too)
//     A hold passes every check after the first two and changes nothing.
//   - Applied at the open of bar k + 1, in reply order, each on the account the earlier ones left. It
//     is rejected instead, leaving the account as it found it, when:
//       no_bar                 bar k + 1 has no sample
//       nothing_to_withdraw    a withdraw finds no position and no idle asset
//       max_slippage           its swap's price x 10000 > the latest close x (10000 + max_slippage_bps)
//                              for a buy, or < the latest close x (10000 - max_slippage_bps) for a sell,
//                              the latest close as of the decision. The modelled slippage and the pool's
//                              impact count toward it, as in bars-replay/v1
//       zero_liquidity         a set_range whose tokens, after its swap, buy no liquidity in the range
//     set_range {lower_tick, upper_tick, max_slippage_bps}:
//       1. The position, if any, is withdrawn at the open's reference sqrt price (o_sqrt_price_x64): the
//          tokens its liquidity holds there and its fees owed become idle.
//       2. The idle tokens are swapped toward the token ratio [lower_tick, upper_tick) holds at that
//          sqrt price, sized by sim/clmm/engine.ts: a buy of the asset with surplus USDC, or a sell of
//          surplus asset. The swap goes through bars-replay/v1's fill model (sim/bars/engine.ts
//          barsBuyFill and barsSellFill) at the open o against o_depth: fees.fee_bps, plus
//          fees.slippage_bps, plus the constant-product impact. A swap worth less than
//          fees.min_notional_quote_units at o is not made, and nor is a buy whose quantity truncates
//          to 0.
//       3. The most liquidity the idle tokens buy in [lower_tick, upper_tick) at the open's reference
//          sqrt price is minted. What is left stays idle.
//     withdraw {max_slippage_bps}: the position, if any, is withdrawn as in 1, and every idle unit of
//       the asset is sold as in 2 (a sale not worth min_notional is not made).
//     Every swap at one open walks the pool that the earlier swaps at that open left, as bars fills
//     do. Each bar's pool starts again from its own o_depth.
//   - When the replay ends, the position is withdrawn at the latest close's sqrt price, and every unit
//     of the asset is sold by the sell model at the latest close c, against that close's c_depth,
//     untouched. There is no max_slippage and no min_notional check. This close-out is recorded in the
//     action log, and done carries the account after it: no position, and no asset left.
//   - Long only: no borrowing, no leverage; no idle amount ever goes below 0.
//   - Scoring (clmm-score.ts): the rank key is hedged PnL, the run's PnL less its exposure to the
//     asset's price over every hour, each hour split at its open. The gap from the previous close to
//     the open is hedged with the asset held at that close, the move from the open to the close with
//     the asset held right after the open's actions. An exposure taken at an open earns none of the
//     move after it. What is left is the LP fees, minus loss-versus-rebalancing, minus swap costs.

import { z } from 'zod';
import { BarsVenue } from './bars-dataset.ts';
import { BAR_INTERVAL_MS, BARS_QUOTE, BarsScale, BarTime, barsIssuer, barsOhlcIssues, USDC_DECIMALS, USDC_MINT, whenBarsValid, type BarsIssue } from './bars-protocol.ts';
import { Fixed9, FIXED9_SCALE, parseFixed9, Pubkey, U64, U8 } from './primitives.ts';
import { Bps, MAX_BOT_LINE_BYTES, MAX_HARNESS_LINE_BYTES, Seq } from './protocol.ts';

export const CLMM_PROTOCOL = 'agent-fun/clmm-replay/v1';
/** The harness kind a competition bundle names (one of competition.ts HARNESS_KINDS, the last). */
export const CLMM_HARNESS_KIND = 'clmm-replay/v1';
export const CLMM_PROTOCOL_SCHEMA_ID = 'https://make.fun/schemas/agent-fun/clmm-replay/v1.json';

/**
 * Sandbox runtimes: competition.ts RUNTIMES, repeated here because competition.ts imports this
 * module (its Harness union holds ClmmReplayHarness), and importing it back would be a cycle.
 * tests/unit/contracts-clmm.test.ts pins the two lists equal.
 */
const Runtime = z.enum(['node22', 'python3.13']);

/** The concentrated-liquidity venues a clmm-replay/v1 pool may live on (a subset of bars-dataset.ts BARS_VENUES). */
export const CLMM_VENUES = ['orca-whirlpool', 'raydium-clmm'] as const;
export const ClmmVenue = BarsVenue.extract(CLMM_VENUES);
export type ClmmVenueT = z.infer<typeof ClmmVenue>;

/** One batch per hour: a bar's t is a multiple of this. */
export const CLMM_BAR_MS = BAR_INTERVAL_MS['1h'];

/**
 * The tick bounds of both venues: orca-so/whirlpools programs/whirlpool/src/state/tick.rs
 * MIN_TICK_INDEX / MAX_TICK_INDEX and raydium-io/raydium-clmm programs/amm/src/libraries/tick_math.rs
 * MIN_TICK / MAX_TICK.
 */
export const CLMM_MIN_TICK = -443_636;
export const CLMM_MAX_TICK = 443_636;

/**
 * The sqrt prices of those ticks (Q64.64), the same files' MIN_SQRT_PRICE_X64 and MAX_SQRT_PRICE_X64.
 * The minimum is the same on both venues. The maximum differs in its last digits: each venue rounds
 * its own tick math.
 */
export const CLMM_MIN_SQRT_PRICE_X64 = 4_295_048_016n;
export const CLMM_MAX_SQRT_PRICE_X64: Readonly<Record<ClmmVenueT, bigint>> = {
  'orca-whirlpool': 79_226_673_515_401_279_992_447_579_055n,
  'raydium-clmm': 79_226_673_521_066_979_257_578_248_091n,
};
const SQRT_PRICE_MAX_ANY = CLMM_MAX_SQRT_PRICE_X64['raydium-clmm'];

/** No fee is credited over a sample interval longer than this (ms): see the header's Fees. */
export const CLMM_MAX_FEE_INTERVAL_MS = 30_000;

/** The fewest actions a reply may always carry without failing the run (as replay/v2's orders). */
export const MIN_CLMM_REPLY_ACTION_CAP = 64;

const isPositive = (s: string) => BigInt(s) > 0n;
const fixed9Between = (s: string, lo: bigint, hi: bigint) => {
  const v = parseFixed9(s);
  return v >= lo && v <= hi;
};

// ---------------------------------------------------------------- numbers

const U128_MAX = (1n << 128n) - 1n;
/** u128 as a canonical decimal string (collector/bars/samples.ts U128's rule). */
export const U128 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,38})$/, { error: 'expected a u128 decimal string', abort: true })
  .refine((s) => BigInt(s) <= U128_MAX, 'exceeds u128');

/** An i32: what a reply's ticks may be (a tick outside the venues' bounds is rejected, tick_bounds). */
export const I32 = z.int().min(-(2 ** 31)).max(2 ** 31 - 1);

/** A tick the pool can hold: [CLMM_MIN_TICK, CLMM_MAX_TICK]. */
export const ClmmTick = z.int().min(CLMM_MIN_TICK).max(CLMM_MAX_TICK);

/** A pool's sqrt price (Q64.64): a u128 within either venue's bounds. */
export const ClmmSqrtPriceX64 = U128.refine(
  (s) => {
    const v = BigInt(s);
    return v >= CLMM_MIN_SQRT_PRICE_X64 && v <= SQRT_PRICE_MAX_ANY;
  },
  { message: `a sqrt price is within [${CLMM_MIN_SQRT_PRICE_X64}, ${SQRT_PRICE_MAX_ANY}]`, ...whenBarsValid },
);

/** Two token amounts (u64 raw units) in the pool's own order: [a, b]. */
export const ClmmTokenPair = z.tuple([U64, U64]);
/** The pool's fee growth of its two tokens (u128, Q64.64) in the pool's own order: [a, b]. */
export const ClmmFeeGrowthPair = z.tuple([U128, U128]);

/** A pool depth as a bar carries it: bars-replay/v1's, one hop (the pool is USDC-quoted), USDC raw units above 0. */
export const ClmmBarDepth = z.array(U64.refine(isPositive, { message: 'a pool depth is above 0', ...whenBarsValid })).length(1);

// ---------------------------------------------------------------- shared blocks (harness and hello)

/** A pool block's own rules: two distinct mints, exactly one of them USDC's. */
export function clmmPoolIssues(p: { mint_a: string; mint_b: string }, at: (string | number)[], issue: BarsIssue): void {
  if (p.mint_a === p.mint_b) issue([...at, 'mint_b'], 'mint_a and mint_b are distinct');
  else if ((p.mint_a === USDC_MINT) === (p.mint_b === USDC_MINT)) issue([...at, 'mint_b'], `the pool pairs an asset with USDC: exactly one of mint_a and mint_b is ${USDC_MINT}`);
}

/** The pool a run trades in, as the harness and hello name it. */
export const ClmmPool = z
  .strictObject({
    venue: ClmmVenue,
    /** The pool account the dataset sampled. */
    pool: Pubkey,
    /** The pool's two mints in its own order (Whirlpool A/B, CLMM 0/1): one is USDC's, the other the asset's. */
    mint_a: Pubkey,
    mint_b: Pubkey,
    /** The asset's mint's decimals (pools.json's `decimals`); USDC's are USDC_DECIMALS. */
    decimals: U8,
    /** Every tick of a range is a multiple of this. */
    tick_spacing: z.int().min(1).max(65_535),
  })
  .superRefine((p, ctx) => clmmPoolIssues(p, [], barsIssuer(ctx)), whenBarsValid);

export const ClmmCapital = z.strictObject({
  /** The quote asset: USDC, the asset every price is in and the capital is held in. */
  quote: z.literal(BARS_QUOTE),
  /** Quote units are USDC raw units: the pool's USDC side and the account's cash share one scale. */
  quote_scale: z.literal(USDC_DECIMALS),
  /** Starting cash, in quote units; above 0. */
  quote_units: U64.refine(isPositive, { message: 'starting capital must be above 0', ...whenBarsValid }),
});

export const ClmmFees = z.strictObject({
  /** Charged on every swap: a buy's notional, a sell's gross value. */
  fee_bps: Bps,
  /** The modelled slippage: buys fill this far above the open, sells this far below, the pool's impact on top; under 10000. */
  slippage_bps: z.int().min(0).max(9_999),
  /** The smallest swap made: a rebalance or withdraw swap worth less at the open is not made. */
  min_notional_quote_units: U64,
});

export const ClmmCaps = z.strictObject({
  /** The narrowest range a set_range may ask for, in ticks (upper_tick - lower_tick). */
  min_width_ticks: z.int().min(1).max(CLMM_MAX_TICK - CLMM_MIN_TICK),
  /** Actions past this many in one reply are rejected one by one (max_actions_per_batch). */
  max_actions_per_batch: z.int().min(1),
});

export const ClmmGuardrails = z.strictObject({
  /** The least in-range share (clmm-score.ts) of a compliant entry, "0.000000000".."1.000000000". */
  min_in_range_share: Fixed9.refine((s) => fixed9Between(s, 0n, FIXED9_SCALE), { message: 'min_in_range_share is a share: 0..1', ...whenBarsValid }),
});

/**
 * The fewest whole blocks of block_hours hours a window may hold (clmmBlockHoursIssue). The interval
 * resamples the window's blocks (sim/clmm/metrics.ts clmmBlockInterval), and over a handful of them
 * a bootstrap says little: over one block every resample is that block's PnL, a zero-width interval.
 * The floor of a dev phase's window, and of a window whose phase is not known; a ranked phase's is
 * CLMM_RANKED_MIN_BLOCKS (clmmPhaseBlocksIssue).
 */
export const CLMM_MIN_BLOCKS = 8;

/**
 * A competition's phase keys: competition.ts PHASE_KEYS, repeated here for Runtime's reason (that
 * module imports this one). tests/unit/contracts-clmm.test.ts pins the two lists equal.
 */
export const CLMM_PHASE_KEYS = ['dev', 'final'] as const;
export type ClmmPhaseKeyT = (typeof CLMM_PHASE_KEYS)[number];

/**
 * The ranked phase: the final phase, whose board pays the prizes. The dev phase is where entries are
 * tried out and pays nothing.
 */
export const CLMM_RANKED_PHASE: ClmmPhaseKeyT = 'final';

/**
 * The fewest whole blocks a ranked phase's window may hold (clmmPhaseBlocksIssue): 28, the six-hour
 * blocks of a 7-day final window. A prize is paid beside the interval the board reports, and the
 * block bootstrap's spread is close to the textbook bootstrap's from about this many blocks on (at 28,
 * slightly wider; 15 to 30% wider at 2 to 8: sim/clmm/metrics.ts's header).
 */
export const CLMM_RANKED_MIN_BLOCKS = 28;

/** The fewest whole blocks a window of phase `phase` may hold: CLMM_RANKED_MIN_BLOCKS on the ranked phase, CLMM_MIN_BLOCKS on any other. */
export function clmmMinBlocksOf(phase: ClmmPhaseKeyT): number {
  if (!(CLMM_PHASE_KEYS as readonly string[]).includes(phase)) throw new RangeError(`a phase is one of ${CLMM_PHASE_KEYS.join(', ')}, not ${JSON.stringify(phase)}`);
  return phase === CLMM_RANKED_PHASE ? CLMM_RANKED_MIN_BLOCKS : CLMM_MIN_BLOCKS;
}

/** The interval reported next to the rank key: a block bootstrap of hedged PnL (clmm-score.ts ClmmPnlInterval). */
export const ClmmIntervalConfig = z.strictObject({
  method: z.literal('bootstrap-blocks'),
  /**
   * The window is cut into blocks of this many hours from its start (the last may be shorter). A
   * window must hold at least CLMM_MIN_BLOCKS whole ones, so block_hours is at most its hours / 8, and
   * a ranked phase's at least CLMM_RANKED_MIN_BLOCKS, at most its hours / 28 (6 on a 7-day final
   * window): clmmPhaseBlocksIssue, the rule for where a phase's window meets the harness (this block
   * names none).
   */
  block_hours: z.int().min(1),
  /** Strictly between 0 and 1. */
  level: Fixed9.refine((s) => fixed9Between(s, 1n, FIXED9_SCALE - 1n), { message: 'level is strictly between 0 and 1', ...whenBarsValid }),
  resamples: z.int().min(1),
});

/**
 * Why a harness's interval cannot resample a window of `hours` hours, or null when it can: its
 * block_hours leaves the window fewer than CLMM_MIN_BLOCKS whole blocks (hours < 8 x block_hours).
 * The harness block names no window (the window is the phase's frozen dataset), so the check runs
 * where the two meet: by phase (clmmPhaseBlocksIssue) where the phase is known, this floor alone
 * where it is not (a kit's grade-local and regrade, grader/harnesses.ts clmmPlan given no phase).
 */
export function clmmBlockHoursIssue(interval: Pick<ClmmIntervalConfigT, 'block_hours'>, hours: number): string | null {
  return blocksIssue(interval.block_hours, hours, CLMM_MIN_BLOCKS, `the ${hours}-hour window`, 'the block bootstrap resamples');
}

/**
 * Why a harness's interval cannot resample phase `phase`'s window of `hours` hours, or null when it
 * can: its block_hours leaves the window fewer than clmmMinBlocksOf(phase) whole blocks,
 * CLMM_RANKED_MIN_BLOCKS on the ranked phase (final), CLMM_MIN_BLOCKS on dev. The reason names the
 * phase, the whole blocks the window holds and the floor. Where a phase's window meets its harness
 * (grader/harnesses.ts clmmPlan, server/routes/admin.ts's dataset attach, server/routes/admin/bars.ts's
 * replacement step), this is the rule.
 */
export function clmmPhaseBlocksIssue(interval: Pick<ClmmIntervalConfigT, 'block_hours'>, hours: number, phase: ClmmPhaseKeyT): string | null {
  const floor = clmmMinBlocksOf(phase);
  const under = phase === CLMM_RANKED_PHASE ? 'a ranked phase takes (its board pays the prizes)' : 'the block bootstrap resamples';
  return blocksIssue(interval.block_hours, hours, floor, `the ${phase} phase's ${hours}-hour window`, under);
}

/** clmmBlockHoursIssue's and clmmPhaseBlocksIssue's rule: `hours` cut into blocks of `b` hours holds at least `floor` whole ones, else why not. */
function blocksIssue(b: number, hours: number, floor: number, window: string, under: string): string | null {
  if (!Number.isSafeInteger(hours) || hours < 1) throw new RangeError(`a window holds a whole number of hours, at least 1, not ${hours}`);
  if (hours >= floor * b) return null;
  const whole = Math.floor(hours / b);
  const held = `interval.block_hours ${b} cuts ${window} into ${whole} whole block${whole === 1 ? '' : 's'}, under the ${floor} ${under}`;
  const most = Math.floor(hours / floor);
  return most >= 1 ? `${held}: block_hours is at most ${most} on it` : `${held}: no block length does on a window under ${floor} hours`;
}

/** The widest range whose ticks are multiples of `tickSpacing` within [CLMM_MIN_TICK, CLMM_MAX_TICK], in ticks. */
export function clmmWidestRange(tickSpacing: number): number {
  const upper = Math.floor(CLMM_MAX_TICK / tickSpacing) * tickSpacing;
  const lower = Math.ceil(CLMM_MIN_TICK / tickSpacing) * tickSpacing;
  return upper - lower;
}

function widthIssues(h: { pool: { tick_spacing: number }; caps: { min_width_ticks: number } }, issue: BarsIssue): void {
  const widest = clmmWidestRange(h.pool.tick_spacing);
  if (h.caps.min_width_ticks > widest) issue(['caps', 'min_width_ticks'], `min_width_ticks ${h.caps.min_width_ticks} exceeds the widest range on tick spacing ${h.pool.tick_spacing} (${widest} ticks): no set_range could pass`);
}

// ---------------------------------------------------------------- the harness block

/**
 * The harness block of a clmm-replay/v1 competition bundle. The pool's scales (price_scale) come from
 * the dataset (clmm-dataset.ts), which must carry this pool (clmmPoolMismatch).
 */
export const ClmmReplayHarness = z
  .strictObject({
    kind: z.literal(CLMM_HARNESS_KIND),
    protocol: z.literal(CLMM_PROTOCOL),
    runtimes: z.array(Runtime).min(1),
    capital: ClmmCapital,
    pool: ClmmPool,
    fees: ClmmFees,
    caps: ClmmCaps,
    guardrails: ClmmGuardrails,
    interval: ClmmIntervalConfig,
  })
  .superRefine((h, ctx) => widthIssues(h, barsIssuer(ctx)), whenBarsValid);

// ---------------------------------------------------------------- harness -> bot

export const ClmmHello = z
  .strictObject({
    type: z.literal('hello'),
    protocol: z.literal(CLMM_PROTOCOL),
    /** The phase's seed (u64), the same for every entry of a phase: seed the bot's own randomness from it. */
    seed: U64,
    pool: ClmmPool,
    /** Every price (o, h, l, c, a swap's) is an integer at this scale: the dataset's. */
    price_scale: BarsScale,
    capital: ClmmCapital,
    /** t of batch 0: the window's first hour's close time. */
    first_close_ms: BarTime,
    caps: ClmmCaps,
    fees: ClmmFees,
  })
  .superRefine((h, ctx) => {
    const issue = barsIssuer(ctx);
    if (h.first_close_ms % CLMM_BAR_MS !== 0) issue(['first_close_ms'], 'first_close_ms is not a whole UTC hour');
    widthIssues(h, issue);
  }, whenBarsValid);

/** The bar closing at the batch's t (see the header): prices at price_scale, the pool's state at its open and close references, its depth at each, and the hour's fee growth. */
export const ClmmBar = z
  .strictObject({
    o: U64,
    h: U64,
    l: U64,
    c: U64,
    o_tick: ClmmTick,
    c_tick: ClmmTick,
    o_sqrt_price_x64: ClmmSqrtPriceX64,
    c_sqrt_price_x64: ClmmSqrtPriceX64,
    o_liquidity: U128,
    c_liquidity: U128,
    o_depth: ClmmBarDepth,
    c_depth: ClmmBarDepth,
    /** The pool's fee growth over (the last sample before the bar, the bar's last sample], per token, wrapping. */
    fee_growth_delta_x64: ClmmFeeGrowthPair,
  })
  .superRefine((b, ctx) => barsOhlcIssues(b, barsIssuer(ctx)), whenBarsValid);

/** Whether a range holds a tick: lower <= tick < upper (the venues' in-range rule). */
export function clmmInRange(range: { lower_tick: number; upper_tick: number }, tick: number): boolean {
  return range.lower_tick <= tick && tick < range.upper_tick;
}

/** The position the account holds, at the batch's close. */
export const ClmmPosition = z
  .strictObject({
    lower_tick: ClmmTick,
    upper_tick: ClmmTick,
    /** Above 0: a withdrawn position leaves the batch (position null), and a mint of none is rejected. */
    liquidity: U128.refine(isPositive, { message: 'a held position has liquidity above 0', ...whenBarsValid }),
    /** The tokens its liquidity holds at the latest close's sqrt price, [a, b]. */
    amounts: ClmmTokenPair,
    /** Fees credited since it was minted, not yet collected (a withdraw collects them), [a, b]. */
    fees_owed: ClmmTokenPair,
    /** The part of fees_owed credited over this batch's hour, [a, b]. */
    fees_hour: ClmmTokenPair,
    /** The latest close's tick lies in [lower_tick, upper_tick). */
    in_range: z.boolean(),
  })
  .superRefine((p, ctx) => {
    const issue = barsIssuer(ctx);
    if (p.lower_tick >= p.upper_tick) issue(['upper_tick'], 'a position\'s range has lower_tick < upper_tick');
    [0, 1].forEach((i) => {
      if (BigInt(p.fees_hour[i]!) > BigInt(p.fees_owed[i]!)) issue(['fees_hour', i], 'the hour\'s fees are part of the fees owed');
    });
  }, whenBarsValid);

export const ClmmAccount = z.strictObject({
  /** The tokens held outside the position (collected fees included), [a, b]. */
  idle: ClmmTokenPair,
  /** The header's equity at the latest close. */
  equity_quote_units: U64,
});

export const ClmmSide = z.enum(['buy', 'sell']);

/** A swap of the asset against USDC, as bars-replay/v1 fills it (BarsFill's numbers). */
export const ClmmSwap = z.strictObject({
  /** buy: the asset with USDC; sell: the asset for USDC. */
  side: ClmmSide,
  /** The fill price at price_scale: the open (the close-out's: the close) with the slippage and the pool's impact. */
  price: U64.refine(isPositive, { message: 'a swap has a price above 0', ...whenBarsValid }),
  /** Raw units of the asset: bought, or sold. */
  qty: U64.refine(isPositive, { message: 'a swap trades a quantity above 0', ...whenBarsValid }),
  /** Buy: USDC spent, fee included. Sell: USDC received, fee deducted. */
  notional_quote_units: U64,
  fee_quote_units: U64,
});

export const CLMM_ACTIONS = ['hold', 'set_range', 'withdraw'] as const;
export const ClmmActionKind = z.enum(CLMM_ACTIONS);
export type ClmmActionKindT = z.infer<typeof ClmmActionKind>;

export const CLMM_REJECT_REASONS = ['max_actions_per_batch', 'after_end', 'no_bar', 'tick_bounds', 'tick_spacing', 'min_width', 'nothing_to_withdraw', 'max_slippage', 'zero_liquidity'] as const;
export const ClmmRejectReason = z.enum(CLMM_REJECT_REASONS);
export type ClmmRejectReasonT = z.infer<typeof ClmmRejectReason>;

/** The reasons each action can be rejected for (the header's checks). */
export const CLMM_REJECT_REASONS_BY_ACTION: Readonly<Record<ClmmActionKindT, readonly ClmmRejectReasonT[]>> = {
  hold: ['max_actions_per_batch', 'after_end'],
  set_range: ['max_actions_per_batch', 'after_end', 'no_bar', 'tick_bounds', 'tick_spacing', 'min_width', 'max_slippage', 'zero_liquidity'],
  withdraw: ['max_actions_per_batch', 'after_end', 'no_bar', 'nothing_to_withdraw', 'max_slippage'],
};

/** How an action of the previous batch resolved at this bar's open: applied or rejected (then nothing moved). */
export const ClmmActionResult = z
  .strictObject({
    action: ClmmActionKind,
    status: z.enum(['applied', 'rejected']),
    /** Set exactly when status is rejected. */
    reason: ClmmRejectReason.nullable(),
    /** t of the batch the action was decided on. */
    decided_t: BarTime,
    /** t of the bar whose open it applied at, or would have: decided_t + 1 h. */
    applied_t: BarTime,
    /** A set_range's ticks as it asked (out of bounds when rejected tick_bounds); null for the other actions. */
    lower_tick: I32.nullable(),
    upper_tick: I32.nullable(),
    /** Its swap, when it was applied and made one; null otherwise. */
    swap: ClmmSwap.nullable(),
  })
  .superRefine((r, ctx) => {
    const issue = barsIssuer(ctx);
    if ((r.status === 'rejected') !== (r.reason !== null)) issue(['reason'], 'reason is set exactly when the action was rejected');
    if (r.reason !== null && !CLMM_REJECT_REASONS_BY_ACTION[r.action].includes(r.reason)) issue(['reason'], `a ${r.action} is never rejected for ${r.reason}`);
    const ranged = r.action === 'set_range';
    if (ranged !== (r.lower_tick !== null) || ranged !== (r.upper_tick !== null)) issue(['lower_tick'], 'lower_tick and upper_tick are set exactly on a set_range');
    if (ranged && r.status === 'applied' && r.lower_tick !== null && r.upper_tick !== null && !(r.lower_tick < r.upper_tick && r.lower_tick >= CLMM_MIN_TICK && r.upper_tick <= CLMM_MAX_TICK)) {
      issue(['upper_tick'], 'an applied set_range\'s range is in bounds with lower_tick < upper_tick');
    }
    if (r.swap !== null) {
      if (r.status === 'rejected') issue(['swap'], 'a rejected action made no swap');
      else if (r.action === 'hold') issue(['swap'], 'a hold makes no swap');
      else if (r.action === 'withdraw' && r.swap.side !== 'sell') issue(['swap', 'side'], 'a withdraw only sells the asset');
    }
    if (r.applied_t !== r.decided_t + CLMM_BAR_MS) issue(['applied_t'], 'applied_t is decided_t + 1 h: an action applies at the next bar\'s open');
  }, whenBarsValid);

export const ClmmBatch = z
  .strictObject({
    type: z.literal('batch'),
    seq: Seq,
    /** The close time of the hour this batch delivers: first_close_ms + seq x 1 h. */
    t: BarTime,
    /** That hour's bar, or null when it holds no sample. */
    bar: ClmmBar.nullable(),
    /** The previous batch's actions, resolved at this bar's open, in reply order. */
    results: z.array(ClmmActionResult),
    /** The position after them, its fees credited through the hour; null when there is none. */
    position: ClmmPosition.nullable(),
    /** The account at the latest close. */
    account: ClmmAccount,
  })
  .superRefine((b, ctx) => {
    const issue = barsIssuer(ctx);
    if (b.t % CLMM_BAR_MS !== 0) issue(['t'], 't is not a whole UTC hour');
    b.results.forEach((r, i) => {
      if (r.applied_t !== b.t) issue(['results', i, 'applied_t'], `a result in the batch at ${b.t} applied at its bar's open, not at ${r.applied_t}`);
    });
    if (b.bar !== null && b.position !== null && b.position.in_range !== clmmInRange(b.position, b.bar.c_tick)) {
      issue(['position', 'in_range'], `in_range is whether c_tick ${b.bar.c_tick} lies in [${b.position.lower_tick}, ${b.position.upper_tick})`);
    }
  }, whenBarsValid);

export const ClmmDone = z
  .strictObject({
    type: z.literal('done'),
    seq: Seq,
    reason: z.enum(['end_of_data', 'aborted']),
    /** The final account after the close-out: no asset left, so its equity is its USDC. */
    account: ClmmAccount,
  })
  .superRefine((d, ctx) => {
    const [a, b] = d.account.idle;
    if ((a !== '0' && b !== '0') || BigInt(d.account.equity_quote_units) !== BigInt(a) + BigInt(b)) {
      barsIssuer(ctx)(['account'], 'done comes after the close-out: no asset is left, and the equity is the USDC held');
    }
  }, whenBarsValid);

// ---------------------------------------------------------------- bot -> harness

export const ClmmHoldAction = z.strictObject({ action: z.literal('hold') });

export const ClmmSetRangeAction = z.strictObject({
  action: z.literal('set_range'),
  /** Multiples of pool.tick_spacing, upper_tick - lower_tick at least caps.min_width_ticks. */
  lower_tick: I32,
  upper_tick: I32,
  max_slippage_bps: Bps,
});

export const ClmmWithdrawAction = z.strictObject({
  action: z.literal('withdraw'),
  max_slippage_bps: Bps,
});

export const ClmmAction = z.discriminatedUnion('action', [ClmmHoldAction, ClmmSetRangeAction, ClmmWithdrawAction]);

export const ClmmReply = z.strictObject({
  type: z.literal('reply'),
  /** The seq of the batch this answers. */
  seq: Seq,
  /** In order; an empty list holds, as [{action: "hold"}] does. */
  actions: z.array(ClmmAction),
});

export const ClmmHarnessMessage = z.discriminatedUnion('type', [ClmmHello, ClmmBatch, ClmmDone]);
export const ClmmBotMessage = ClmmReply;

export type ClmmReplayHarnessT = z.infer<typeof ClmmReplayHarness>;
export type ClmmPoolT = z.infer<typeof ClmmPool>;
export type ClmmCapitalT = z.infer<typeof ClmmCapital>;
export type ClmmFeesT = z.infer<typeof ClmmFees>;
export type ClmmCapsT = z.infer<typeof ClmmCaps>;
export type ClmmGuardrailsT = z.infer<typeof ClmmGuardrails>;
export type ClmmIntervalConfigT = z.infer<typeof ClmmIntervalConfig>;
export type ClmmHelloT = z.infer<typeof ClmmHello>;
export type ClmmBarT = z.infer<typeof ClmmBar>;
export type ClmmPositionT = z.infer<typeof ClmmPosition>;
export type ClmmAccountT = z.infer<typeof ClmmAccount>;
export type ClmmSwapT = z.infer<typeof ClmmSwap>;
export type ClmmActionResultT = z.infer<typeof ClmmActionResult>;
export type ClmmBatchT = z.infer<typeof ClmmBatch>;
export type ClmmDoneT = z.infer<typeof ClmmDone>;
export type ClmmActionT = z.infer<typeof ClmmAction>;
export type ClmmReplyT = z.infer<typeof ClmmReply>;
export type ClmmHarnessMessageT = z.infer<typeof ClmmHarnessMessage>;

/** The index of the pool's USDC side in an [a, b] pair: 0 when mint_a is USDC's, else 1. */
export function clmmQuoteIndex(pool: Pick<ClmmPoolT, 'mint_a' | 'mint_b'>): 0 | 1 {
  return pool.mint_a === USDC_MINT ? 0 : 1;
}

/**
 * A set_range's range checks when it is decided (the header's tick_bounds, tick_spacing and
 * min_width, in that order): the reason it is rejected, or null when the range passes.
 */
export function clmmRangeRejection(hello: { pool: Pick<ClmmPoolT, 'tick_spacing'>; caps: Pick<ClmmCapsT, 'min_width_ticks'> }, range: { lower_tick: number; upper_tick: number }): 'tick_bounds' | 'tick_spacing' | 'min_width' | null {
  const { lower_tick: lower, upper_tick: upper } = range;
  if (lower < CLMM_MIN_TICK || lower > CLMM_MAX_TICK || upper < CLMM_MIN_TICK || upper > CLMM_MAX_TICK) return 'tick_bounds';
  const s = hello.pool.tick_spacing;
  if (lower % s !== 0 || upper % s !== 0) return 'tick_spacing';
  if (upper - lower < hello.caps.min_width_ticks) return 'min_width';
  return null;
}

/**
 * The most actions one reply may carry before it is a protocol violation that fails the run:
 * max(64, 4 x caps.max_actions_per_batch). Actions past max_actions_per_batch but within it are
 * rejected one by one (reason max_actions_per_batch).
 */
export function clmmReplyActionCap(hello: { caps: Pick<ClmmCapsT, 'max_actions_per_batch'> }): number {
  return Math.max(MIN_CLMM_REPLY_ACTION_CAP, 4 * hello.caps.max_actions_per_batch);
}

/**
 * Parse one line from the bot: size cap, JSON, then the strict ClmmReply schema (bars-protocol.ts
 * parseBarsBotLine, for this protocol). Returns the reply or a reason string (the grader turns a
 * reason into a protocol-violation failure); it never throws, whatever the bot wrote. The action cap
 * needs hello and is the engine's (clmmReplyActionCap).
 */
export function parseClmmBotLine(line: string): { ok: true; reply: ClmmReplyT } | { ok: false; reason: string } {
  const bytes = new TextEncoder().encode(line).byteLength;
  if (bytes > MAX_BOT_LINE_BYTES) return { ok: false, reason: `line is ${bytes} bytes (max ${MAX_BOT_LINE_BYTES})` };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  let parsed: ReturnType<typeof ClmmReply.safeParse>;
  try {
    parsed = ClmmReply.safeParse(value);
  } catch (err) {
    // No schema here throws on bad input (patterns abort, refinements run only on valid input);
    // should one ever, the bot's line is still a violation, never a grader crash.
    return { ok: false, reason: `not a reply: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `not a reply: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}` };
  }
  return { ok: true, reply: parsed.data };
}

/**
 * The protocol as one JSON Schema (draft 2020-12) document: `$defs.harness_message` is what the bot
 * reads, `$defs.bot_message` what it writes. Published in every clmm competition kit as
 * protocol.schema.json. Cross-field rules (a pool's USDC side, a range's order, a result's reason, a
 * bar's OHLC order) are the header's and the zod schemas'; JSON Schema carries the shapes.
 */
export function clmmProtocolJsonSchema(): Record<string, unknown> {
  const strip = (schema: Record<string, unknown>) => {
    const { $schema: _drop, ...rest } = schema;
    return rest;
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: CLMM_PROTOCOL_SCHEMA_ID,
    title: CLMM_PROTOCOL,
    description:
      `makefun CLMM replay protocol v1: newline-delimited JSON, harness -> bot on stdin (hello, batch..., done), bot -> harness on stdout (one reply per batch, echoing its seq). Harness lines are at most ${MAX_HARNESS_LINE_BYTES} bytes, bot lines at most ${MAX_BOT_LINE_BYTES} bytes (UTF-8, the newline not counted). One batch per hour of recorded pool state. A reply's actions (hold, set_range, withdraw) apply at the next bar's open: the position is withdrawn, the tokens swapped toward the range's ratio at the open price with fee, slippage and constant-product impact against the open depth, and the most liquidity they buy is minted. Fees accrue per sample interval of at most ${CLMM_MAX_FEE_INTERVAL_MS / 1000} s whose two ticks lie in the range, diluted by the pool's liquidity. Token amounts are raw units in the pool's own order [a, b]; prices, quote amounts, liquidity and sqrt prices are integer decimal strings; ticks and times are integers.`,
    $defs: {
      harness_message: strip(z.toJSONSchema(ClmmHarnessMessage, { io: 'output' }) as Record<string, unknown>),
      bot_message: strip(z.toJSONSchema(ClmmBotMessage, { io: 'input' }) as Record<string, unknown>),
    },
  };
}
