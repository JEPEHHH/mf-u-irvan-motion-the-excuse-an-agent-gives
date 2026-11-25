// agent-fun/bars-replay/v1: the line protocol between the grader's bars replay harness and an entrant's
// bot, and the harness block a competition bundle carries for it (BarsReplayHarness). A causal replay
// of OHLC bars of Solana assets quoted in USDC, long only. The bars come from our own poller of
// on-chain DEX pool state (contracts/bars-dataset.ts); each symbol is an asset ticker bound to its
// mint. The framing is agent-fun/replay/v2's (protocol.ts): one JSON object per line (UTF-8,
// `\n`-terminated, the `\n` not counted in the limits) on the bot's stdin (harness -> bot, at most
// MAX_HARNESS_LINE_BYTES per line) and stdout (bot -> harness, at most MAX_BOT_LINE_BYTES per line).
// Every message is zod-strict: an unknown key, a missing key or a malformed value is a protocol
// violation.
//
//   harness -> bot   hello                       once, first
//   harness -> bot   batch {seq, t, bars, ...}   once per bar interval of the warm-up and the window,
//                                                in order
//   bot -> harness   reply {seq, orders[]}       exactly one per batch, echoing its seq, before the
//                                                next batch is sent (lockstep)
//   harness -> bot   done                        once, last; the bot exits without replying
//
// Units (BigInt throughout; amounts travel as canonical decimal strings, times as integers):
//   - A price integer p of a symbol is p / 10^price_scale USDC per one whole unit of the symbol's
//     asset; a quantity q is q / 10^qty_scale whole units of it; a quote amount (*_quote_units) is
//     a / 10^capital.quote_scale USDC. price_scale and qty_scale are per symbol (hello.symbols),
//     quote_scale per competition.
//   - value(q, p) = q * p * 10^quote_scale / 10^(qty_scale + price_scale), truncated: the quote
//     units q is worth at price p.
//   - A bar's t is its CLOSE time, its open time + the interval, in ms since the Unix epoch, so a
//     multiple of the interval (a 1h bar's t is the UTC hour it ends on, a 1m bar's the UTC minute).
//     o, h, l, c are prices; v is the asset volume at qty_scale, or null when the source has none
//     (pool state has none). o and c are the bar's reference prices, the only ones the replay fills
//     and marks at: o is the median of the pool samples over the bar's first reference window, c over
//     its last (contracts/bars-dataset.ts barsReferenceMs: five minutes on 1h and 1d bars, 10 s on 1m
//     bars), so pushing a thin pool for one slot at the boundary moves neither. h and l are the
//     extremes of every sample: information, never a fill or a mark.
//   - A depth is a list with one entry per hop of the asset's price path (its own pool, then a
//     SOL-quoted asset's SOL/USDC leg; at most MAX_BAR_DEPTH_HOPS), each the hop's quote side in
//     USDC raw units (10^-6 USDC, whatever quote_scale is), above 0: the median over the same
//     reference window as the price. A bar carries o_depth, the pool at o (the one its open's fills trade
//     against), and c_depth, the pool at c (the one a flatten at that close trades against). When
//     its samples carry a concentrated pool's (Orca Whirlpool, Raydium CLMM) active liquidity, its
//     depth is the smaller of two. One is the reserve that liquidity holds in range, so a price in a
//     liquidity gap is as shallow as the gap (the pool trades so while the price stays between the
//     initialized ticks around it; ticks crossed are ignored). The other is its vaults' min side as
//     its universe froze it. The in-range reserve is virtual, and no order trades against tokens the
//     pool does not hold. A small order is judged a little harder than the curve says, never easier
//     than the real tokens allow. A dataset recorded before samples kept the liquidity carries the
//     vaults' min side alone.
//
// Market model (sim/bars/engine.ts implements it; the bot is told the numbers in hello and the bars):
//   - Time: batch k (seq k) closes bar k of the replay at t = first_close_ms + k * interval, even
//     when no symbol has a bar then; a symbol with no bar at t is absent from that batch's bars.
//     A symbol's latest close is its close at or before the batch, however many bars back.
//   - Warm-up: when hello carries warmup_bars N (a harness opts in with harness.warmup_bars, 1 to
//     MAX_BARS_WARMUP), batches seq 0 to N - 1 are the N bars before the scored window: ordinary
//     batches a bot reads to build its history, with trading closed (every order decided on one is
//     rejected, warmup). Batch N closes the scored window's first bar and is the first a bot can trade
//     on; equity, drawdown and every metric start at the scored window, the capital untouched until
//     then. The warm-up counts for nothing. Without the key there is no warm-up: batch 0 closes the
//     scored window's first bar, as it always has.
//   - Orders decided on batch k fill at the OPEN of their symbol's bar k + latency_bars (always 1),
//     its o, against its pool o_depth. Every order of batch k resolves there, filled or rejected,
//     and comes back in batch k + 1's fills in reply order, next to the bar whose o and o_depth
//     priced it, so a bot can recompute every fill. An order decided on the last batch is rejected
//     (after_end) and reported in the action log only: done carries the final account, not fills.
//     The next open's depth is not known when deciding: the latest c_depth, minutes before it
//     (seconds on 1m bars), is the depth to size an order against.
//   - Checked when decided, in reply order, against the batch's account and the orders of the same
//     reply accepted so far (a rejected order counts toward nothing but max_orders_per_bar and the
//     client ids), the first failing check naming the reason:
//       max_orders_per_bar    the order is past the first caps.max_orders_per_bar of the reply; a
//                             reply carrying more than barsReplyOrderCap(hello) = max(64, 4 x
//                             max_orders_per_bar) orders is a protocol violation that fails the run
//       duplicate_client_id   an earlier order of the run (this reply included) used the id
//       not_in_universe       the symbol is not in hello.symbols
//       zero_amount           notional_quote_units or qty is "0"
//       warmup                decided on a warm-up batch (seq < hello.warmup_bars)
//       after_end             decided on the last batch
//       no_bar                the symbol has had no bar yet (no latest close to decide against)
//     a buy, then:
//       below_min_notional    notional_quote_units < fees.min_notional_quote_units
//       insufficient_cash     the reply's accepted buys would spend more than the account's cash
//                             (sells' proceeds land at the same open and never fund a buy of the
//                             same reply)
//       max_open_positions    the symbol is neither held nor bought earlier in the reply, and the
//                             held symbols plus those bought earlier in the reply are already
//                             caps.max_open_positions
//       max_weight            value(held qty, latest close) + the reply's accepted buys of the symbol
//                             + this notional, times 10000, exceeds caps.max_weight_bps x the
//                             account's equity
//     a sell, then:
//       insufficient_position qty exceeds the held quantity less the reply's accepted sells of it
//       below_min_notional    value(qty, latest close) < fees.min_notional_quote_units, unless the
//                             sell, with the reply's accepted sells of the symbol, empties the
//                             position (dust can always be closed)
//   - Filled at the open of bar k + 1 (every division truncating toward zero), unless:
//       no_bar                the symbol has no bar at k + 1
//       max_slippage          a buy's price x 10000 > latest close x (10000 + max_slippage_bps), or a
//                             sell's price x 10000 < latest close x (10000 - max_slippage_bps), the
//                             latest close as of the decision: the modelled slippage and the pool's
//                             impact count toward it, so max_slippage_bps bounds the move from the
//                             close, the slippage and the order's own impact together
//       zero_amount           a buy whose qty truncates to 0
//     The pool: the hops of o_depth are constant-product pools in series. Valued in USDC at the
//     reference price they trade exactly as one constant-product pool of depth D = 1 / (1/D1 + 1/D2)
//     (D = D1 with one hop), whose USDC side y is D before any fill, against x y = D^2. Each fill of
//     the symbol at that open walks it, in reply order: a fill worth a USDC raw units (a quote
//     amount x 10^6 / 10^quote_scale, kept exact) meets the factor M, and moves y:
//       a buy spending a:                     M = y (y + a) / D^2      y becomes y + a
//       a sell of asset worth a at the open:  M = (D^2 + a y) / y^2    y becomes D^2 y / (D^2 + a y)
//     On an untouched pool (y = D) both are M = 1 + a/D = 1 + a/D1 + a/D2, so a later fill meets
//     the pool the symbol's earlier fills at that open left, and an order cut into pieces pays what
//     it would have paid whole. A rejected order leaves the pool as it found it, and each bar's pool
//     starts again from its own o_depth. M is an exact fraction, divided once, in the price:
//     buy:  spend = notional_quote_units * (10000 - fee_bps) / 10000;  fee = notional - spend
//           price = open * (10000 + slippage_bps) * M(spend) / 10000
//           qty   = spend * 10^(qty_scale + price_scale) / (price * 10^quote_scale)
//           cash falls by notional_quote_units; the fill's notional_quote_units is that notional
//     sell: price = max(1, open * (10000 - slippage_bps) / (10000 * M(value(qty, open))))
//           gross = value(qty, price);  proceeds = gross * (10000 - fee_bps) / 10000;  fee = gross - proceeds
//           cash rises by proceeds; the fill's notional_quote_units is the proceeds
//     A sell's price never truncates below 1, the scale's resolution: a pool always pays something.
//     A position's cost_quote_units is the cash spent on the quantity still held, fees included; a
//     sell lowers it pro rata (cost * qty_left / qty_before, truncated).
//   - When the replay ends every position is flattened at its symbol's latest close with the sell
//     model, the close for the open and that close's c_depth, untouched, for the pool (no
//     max_slippage, no min-notional check): sell fills with client_id `_flatten_<n>` (n counts
//     closes from 0, in symbol order), recorded in the action log; done carries the account after
//     them. Client ids starting with `_` are reserved for them: an order carrying one is a protocol
//     violation.
//   - Equity: cash plus value(qty, latest close) of every position, no fee, no slippage, no impact.
//   - Long only: no shorts, no leverage; cash never goes below 0.

import { z } from 'zod';
import { Fixed9, FIXED9_SCALE, parseFixed9, Pubkey, U64 } from './primitives.ts';
import { Bps, ClientOrderId, MAX_BOT_LINE_BYTES, MAX_HARNESS_LINE_BYTES, Seq } from './protocol.ts';

export const BARS_PROTOCOL = 'agent-fun/bars-replay/v1';
/** The harness kind a competition bundle names (competition.ts HARNESS_KINDS gains it in step 14). */
export const BARS_HARNESS_KIND = 'bars-replay/v1';
export const BARS_PROTOCOL_SCHEMA_ID = 'https://make.fun/schemas/agent-fun/bars-replay/v1.json';

/**
 * Sandbox runtimes: competition.ts RUNTIMES, repeated here because competition.ts imports this module
 * (its Harness union adopts BarsReplayHarness), so importing it back would be a cycle that leaves one
 * side's schemas uninitialised. tests/unit/contracts-bars.test.ts pins the two lists equal.
 */
const Runtime = z.enum(['node22', 'python3.13']);

/**
 * An asset's ticker, e.g. SOL, JUP, W: 1-20 of [A-Z0-9], the frozen pools.json's `asset`. A ticker
 * names nothing on its own: the universe binds each to its mint.
 */
export const BarSymbol = z.string().regex(/^[A-Z0-9]{1,20}$/, 'expected an asset ticker: 1-20 of [A-Z0-9]');
/** The quote asset every bar is priced in and capital is held in. */
export const BARS_QUOTE = 'USDC';
/** Circle's USDC on Solana mainnet (6 decimals). */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;
/** Decimal places of a scaled integer: 0..12. */
export const BarsScale = z.int().min(0).max(12);

/** The bar intervals; '1m' comes last, after the two older ones, so each keeps its place in the enum. */
export const BAR_INTERVALS = ['1h', '1d', '1m'] as const;
export const BarInterval = z.enum(BAR_INTERVALS);
export const BAR_INTERVAL_MS: Readonly<Record<z.infer<typeof BarInterval>, number>> = { '1h': 3_600_000, '1d': 86_400_000, '1m': 60_000 };

/** A bar's close time in ms since the Unix epoch (see the header). */
export const BarTime = z.int().min(0);

/** The most universe symbols a harness may name. */
export const MAX_BARS_SYMBOLS = 64;

/** The most warm-up bars a harness may ask for (harness.warmup_bars): one day of 1m bars. */
export const MAX_BARS_WARMUP = 1_440;

/** A warm-up length in bars: 1..MAX_BARS_WARMUP (absent means no warm-up; there is no 0). */
const BarsWarmup = z.int().min(1).max(MAX_BARS_WARMUP);

/** The fewest orders a reply may always carry without failing the run (as replay/v2). */
export const MIN_BARS_REPLY_ORDER_CAP = 64;

/**
 * Every bars refinement runs only on input that is otherwise valid. zod runs a refinement after a
 * continuable issue (a failed regex), and these read their fields as BigInt and Fixed9, which would
 * throw on the malformed string instead of reporting it.
 */
export const whenBarsValid = { when: (payload: { issues: readonly unknown[] }): boolean => payload.issues.length === 0 };

export type BarsIssue = (path: (string | number)[], message: string) => void;
export const barsIssuer =
  (ctx: { addIssue: (i: { code: 'custom'; path: (string | number)[]; message: string }) => void }): BarsIssue =>
  (path, message) =>
    ctx.addIssue({ code: 'custom', path, message });

/** Symbols strictly ascending in code-unit order (so unique). */
export function checkBarsSymbolOrder(items: readonly { symbol: string }[], at: (string | number)[], issue: BarsIssue): void {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!.symbol;
    const cur = items[i]!.symbol;
    if (prev === cur) issue([...at, i, 'symbol'], `duplicate symbol ${cur}`);
    else if (prev > cur) issue([...at, i, 'symbol'], `symbols must be in code-unit order: ${cur} after ${prev}`);
  }
}

/** A universe binds each ticker to a distinct mint, never the quote's. */
export function checkBarsUniverseMints(items: readonly { symbol: string; mint: string }[], at: (string | number)[], issue: BarsIssue): void {
  const seen = new Map<string, string>();
  items.forEach((s, i) => {
    if (s.mint === USDC_MINT) issue([...at, i, 'mint'], `${s.symbol} is the quote asset's mint (USDC)`);
    const other = seen.get(s.mint);
    if (other !== undefined) issue([...at, i, 'mint'], `${s.symbol} and ${other} share a mint`);
    seen.set(s.mint, s.symbol);
  });
}

const isPositive = (s: string) => BigInt(s) > 0n;
const fixed9Between = (s: string, lo: bigint, hi: bigint) => {
  const v = parseFixed9(s);
  return v >= lo && v <= hi;
};

// ---------------------------------------------------------------- shared blocks (harness and hello)

export const BarsCapital = z.strictObject({
  /** The quote asset: USDC, the asset every bar is priced in. */
  quote: z.literal(BARS_QUOTE),
  /** Decimal places of every *_quote_units amount. */
  quote_scale: BarsScale,
  /** Starting cash, in quote units; above 0 (return divides by it). */
  quote_units: U64.refine(isPositive, { message: 'starting capital must be above 0', ...whenBarsValid }),
});

export const BarsCaps = z.strictObject({
  /** Held symbols, counting those bought earlier in the same reply (max_open_positions). */
  max_open_positions: z.int().min(1),
  /** Orders past this many in one reply are rejected one by one (max_orders_per_bar). */
  max_orders_per_bar: z.int().min(1),
  /** A symbol's position may be worth at most this share (bps) of equity after a buy (max_weight). */
  max_weight_bps: z.int().min(1).max(10_000),
  shorts: z.literal(false),
  leverage: z.literal(false),
});

export const BarsFees = z.strictObject({
  /** Charged on every fill: a buy's notional, a sell's gross value. */
  fee_bps: Bps,
  /**
   * The modelled slippage: buys fill this far above the open, sells this far below, and the pool's
   * impact comes on top (the header's fill formulas); under 10000, so a sell's price stays above 0.
   */
  slippage_bps: z.int().min(0).max(9_999),
  /** The smallest buy notional, and the smallest sell value short of emptying a position. */
  min_notional_quote_units: U64,
});

export const BarsGuardrails = z.strictObject({
  /** The bot's own filled orders (flatten closes do not count). */
  min_trades: z.int().min(0),
  /** Symbols with a filled order of the bot's own. */
  min_distinct_symbols: z.int().min(0),
  /** Largest allowed peak-to-trough drawdown share of equity, "0.000000000".."1.000000000". */
  max_drawdown: Fixed9.refine((s) => fixed9Between(s, 0n, FIXED9_SCALE), { message: 'max_drawdown is a share: 0..1', ...whenBarsValid }),
});

/** A universe entry of the harness: the ticker and the mint it stands for. */
export const BarsUniverseSymbol = z.strictObject({
  symbol: BarSymbol,
  mint: Pubkey,
});

// ---------------------------------------------------------------- the harness block

/**
 * The harness block of a bars-replay/v1 competition bundle. The symbols are the universe, 1..64,
 * unique, in code-unit order, each bound to a distinct mint that is not USDC's; their scales come
 * from the dataset (bars-dataset.ts), which must carry every one of them under the same mint.
 */
export const BarsReplayHarness = z
  .strictObject({
    kind: z.literal(BARS_HARNESS_KIND),
    protocol: z.literal(BARS_PROTOCOL),
    runtimes: z.array(Runtime).min(1),
    capital: BarsCapital,
    bar_interval: BarInterval,
    symbols: z.array(BarsUniverseSymbol).min(1).max(MAX_BARS_SYMBOLS),
    /** Orders decided on bar k fill at bar k + 1's open. */
    latency_bars: z.literal(1),
    caps: BarsCaps,
    fees: BarsFees,
    guardrails: BarsGuardrails,
    /**
     * The bootstrap interval reported next to the rank key, resampling symbols (score.ts
     * BarsPnlInterval). level is strictly between 0 and 1. block_hours: the hours each block of the
     * score's per_block covers, a whole number of bars; absent, 6 (one bar where a bar is longer:
     * sim/metrics.ts barsBlockHoursOf). The prize gate weighs a margin over the baseline across those
     * blocks at this level and resample count (server/payouts/baseline.ts).
     */
    interval: z.strictObject({
      level: Fixed9.refine((s) => fixed9Between(s, 1n, FIXED9_SCALE - 1n), { message: 'level is strictly between 0 and 1', ...whenBarsValid }),
      resamples: z.int().min(1),
      block_hours: z.int().min(1).optional(),
    }),
    /**
     * The bars replayed before the scored window, trading closed (the header's Warm-up): the replay
     * starts this many intervals before the window. Optional with no default, so a bundle without it
     * keeps its bytes and its hash.
     */
    warmup_bars: BarsWarmup.optional(),
  })
  .superRefine((h, ctx) => {
    const issue = barsIssuer(ctx);
    checkBarsSymbolOrder(h.symbols, ['symbols'], issue);
    checkBarsUniverseMints(h.symbols, ['symbols'], issue);
    const blockHours = h.interval.block_hours;
    if (blockHours !== undefined && (blockHours * 3_600_000) % BAR_INTERVAL_MS[h.bar_interval] !== 0) {
      issue(['interval', 'block_hours'], `block_hours ${blockHours} is not a whole number of ${h.bar_interval} bars`);
    }
    if (h.guardrails.min_distinct_symbols > h.symbols.length) {
      issue(['guardrails', 'min_distinct_symbols'], `min_distinct_symbols ${h.guardrails.min_distinct_symbols} exceeds the ${h.symbols.length} universe symbols: no entry could comply`);
    }
  }, whenBarsValid);

// ---------------------------------------------------------------- harness -> bot

/** A universe symbol as hello carries it: its mint, and its scales from the dataset. */
export const BarsHelloSymbol = z.strictObject({
  symbol: BarSymbol,
  mint: Pubkey,
  price_scale: BarsScale,
  qty_scale: BarsScale,
});

export const BarsHello = z
  .strictObject({
    type: z.literal('hello'),
    protocol: z.literal(BARS_PROTOCOL),
    /** The phase's seed (u64), the same for every entry of a phase: seed the bot's own randomness from it. */
    seed: U64,
    /** The universe, in code-unit order. */
    symbols: z.array(BarsHelloSymbol).min(1).max(MAX_BARS_SYMBOLS),
    capital: BarsCapital,
    bar_interval: BarInterval,
    /** t of batch 0: the replay's first bar's close time (the warm-up's first bar's, when there is one). */
    first_close_ms: BarTime,
    caps: BarsCaps,
    fees: BarsFees,
    latency_bars: z.literal(1),
    /** The warm-up batches, seq 0 to warmup_bars - 1, trading closed (the header's Warm-up); absent when there is none. */
    warmup_bars: BarsWarmup.optional(),
  })
  .superRefine((h, ctx) => {
    const issue = barsIssuer(ctx);
    checkBarsSymbolOrder(h.symbols, ['symbols'], issue);
    checkBarsUniverseMints(h.symbols, ['symbols'], issue);
    if (h.first_close_ms % BAR_INTERVAL_MS[h.bar_interval] !== 0) issue(['first_close_ms'], `first_close_ms is not a multiple of the ${h.bar_interval} interval`);
  }, whenBarsValid);

/**
 * The most hops an asset's price path has: its own pool, then a SOL-quoted asset's SOL/USDC leg.
 * contracts/bars-dataset.ts MAX_BARS_HOPS, repeated here because that module imports this one;
 * tests/unit/contracts-bars.test.ts pins the two equal.
 */
export const MAX_BAR_DEPTH_HOPS = 2;

/** A pool depth as a bar carries it (see the header): per hop, USDC raw units, each above 0. */
export const SymbolBarDepth = z
  .array(U64.refine(isPositive, { message: 'a pool depth is above 0', ...whenBarsValid }))
  .min(1)
  .max(MAX_BAR_DEPTH_HOPS);

/**
 * One symbol's bar at the batch's t: prices at the symbol's price_scale, v at its qty_scale or null
 * when the dataset has no volume (a pool-state dataset never has), and the pool depth at o
 * (o_depth: what the fills this batch carries traded against) and at c (c_depth: the latest pool
 * the bot knows), the dataset's own numbers, one per hop of the symbol's price path.
 */
export const SymbolBar = z
  .strictObject({
    symbol: BarSymbol,
    t: BarTime,
    o: U64,
    h: U64,
    l: U64,
    c: U64,
    v: U64.nullable(),
    o_depth: SymbolBarDepth,
    c_depth: SymbolBarDepth,
  })
  .superRefine((b, ctx) => {
    const issue = barsIssuer(ctx);
    barsOhlcIssues(b, issue);
    if (b.o_depth.length !== b.c_depth.length) issue(['c_depth'], `c_depth has ${b.c_depth.length} hops, o_depth ${b.o_depth.length}: one per hop of the asset's price path`);
  }, whenBarsValid);

/** Prices above 0, and low <= open, close <= high. */
export function barsOhlcIssues(b: { o: string; h: string; l: string; c: string }, issue: BarsIssue): void {
  const [o, h, l, c] = [BigInt(b.o), BigInt(b.h), BigInt(b.l), BigInt(b.c)];
  if (l < 1n) issue(['l'], 'prices are above 0');
  if (l > o || l > c) issue(['l'], 'low is above open or close');
  if (h < o || h < c) issue(['h'], 'high is below open or close');
}

export const BarsPosition = z.strictObject({
  symbol: BarSymbol,
  /** Above 0: an emptied position leaves the list. */
  qty: U64.refine(isPositive, { message: 'a held position has qty above 0', ...whenBarsValid }),
  /** Cash spent on the quantity still held, fees included (see the header). */
  cost_quote_units: U64,
});

export const BarsAccount = z
  .strictObject({
    cash_quote_units: U64,
    /** In code-unit order of symbol. */
    positions: z.array(BarsPosition),
    /** Cash plus every position at its symbol's latest close. */
    equity_quote_units: U64,
  })
  .superRefine((a, ctx) => {
    const issue = barsIssuer(ctx);
    checkBarsSymbolOrder(a.positions, ['positions'], issue);
    const cash = BigInt(a.cash_quote_units);
    const equity = BigInt(a.equity_quote_units);
    if (equity < cash) issue(['equity_quote_units'], 'equity is cash plus the positions: never below cash');
    else if (a.positions.length === 0 && equity !== cash) issue(['equity_quote_units'], 'with no position, equity is the cash');
  }, whenBarsValid);

export const BarsSide = z.enum(['buy', 'sell']);

export const BARS_REJECT_REASONS = [
  'max_open_positions',
  'max_orders_per_bar',
  'max_weight',
  'insufficient_cash',
  'insufficient_position',
  'not_in_universe',
  'no_bar',
  'zero_amount',
  'duplicate_client_id',
  'below_min_notional',
  'max_slippage',
  'after_end',
  'warmup',
] as const;
export const BarsRejectReason = z.enum(BARS_REJECT_REASONS);

/** A fill's client_id: the order's, or a harness close's `_flatten_<n>`. */
export const BarsFillClientId = z
  .string()
  .max(64)
  .regex(/^(?:[A-Za-z0-9-][A-Za-z0-9_-]{0,63}|_flatten_(?:0|[1-9][0-9]*))$/, 'client_id: an order id or _flatten_<n>');

/**
 * How an order resolved: filled or rejected (nothing paid, every amount "0"). The flatten closes are
 * fills too: side sell, status filled, decided_bar = fill_bar = the last batch's t.
 */
export const BarsFill = z
  .strictObject({
    client_id: BarsFillClientId,
    symbol: BarSymbol,
    side: BarsSide,
    status: z.enum(['filled', 'rejected']),
    /** Set exactly when status is rejected. */
    reason: BarsRejectReason.nullable(),
    /** t of the batch the order was decided on. */
    decided_bar: BarTime,
    /** t of the bar whose open it filled at, or would have: decided_bar + latency_bars x the interval. */
    fill_bar: BarTime,
    /**
     * The fill price at the symbol's price_scale, "0" unless filled: the open (a flatten's: the
     * close) with the modelled slippage and the pool's impact (the header's fill formulas, against
     * the pool the symbol's earlier fills at that open left).
     */
    price: U64,
    /** Buy: asset units received. Sell: asset units sold. At the symbol's qty_scale; "0" unless filled. */
    qty: U64,
    /** Buy: cash spent, fee included. Sell: cash received, fee deducted. "0" unless filled. */
    notional_quote_units: U64,
    fee_quote_units: U64,
  })
  .superRefine((f, ctx) => {
    const issue = barsIssuer(ctx);
    if ((f.status === 'rejected') !== (f.reason !== null)) issue(['reason'], 'reason is set exactly when the order was rejected');
    if (f.status === 'rejected') {
      for (const k of ['price', 'qty', 'notional_quote_units', 'fee_quote_units'] as const) if (f[k] !== '0') issue([k], `${k} is "0" on a rejected order`);
    } else {
      if (f.price === '0') issue(['price'], 'a filled order has a price');
      if (f.qty === '0') issue(['qty'], 'a filled order trades a quantity');
    }
    if (f.client_id.startsWith('_') && (f.side !== 'sell' || f.status !== 'filled')) issue(['client_id'], 'a flatten close is a filled sell');
    if (f.fill_bar < f.decided_bar) issue(['fill_bar'], 'fill_bar is before decided_bar');
  }, whenBarsValid);

export const BarsBatch = z
  .strictObject({
    type: z.literal('batch'),
    seq: Seq,
    /** The close time of the bar this batch delivers: first_close_ms + seq x the interval. */
    t: BarTime,
    /** The symbols with a bar at t, in code-unit order; every bar's t is the batch's. */
    bars: z.array(SymbolBar),
    /** The orders of the previous batch, resolved at this bar's open, in reply order. */
    fills: z.array(BarsFill),
    /** The bot's account after those fills. */
    account: BarsAccount,
  })
  .superRefine((b, ctx) => {
    const issue = barsIssuer(ctx);
    checkBarsSymbolOrder(b.bars, ['bars'], issue);
    b.bars.forEach((bar, i) => {
      if (bar.t !== b.t) issue(['bars', i, 't'], `bar t ${bar.t} is not the batch's ${b.t}`);
    });
  }, whenBarsValid);

export const BarsDone = z
  .strictObject({
    type: z.literal('done'),
    seq: Seq,
    reason: z.enum(['end_of_data', 'aborted']),
    /** The final account after flattening: cash only, no position. */
    account: BarsAccount,
  })
  .superRefine((d, ctx) => {
    if (d.account.positions.length > 0) barsIssuer(ctx)(['account', 'positions'], 'done comes after the flatten: no position is left');
  }, whenBarsValid);

// ---------------------------------------------------------------- bot -> harness

export const BarsBuyOrder = z.strictObject({
  side: z.literal('buy'),
  client_id: ClientOrderId,
  symbol: BarSymbol,
  /** Cash to spend, fee included. */
  notional_quote_units: U64,
  max_slippage_bps: Bps,
});

export const BarsSellOrder = z.strictObject({
  side: z.literal('sell'),
  client_id: ClientOrderId,
  symbol: BarSymbol,
  /** Asset units to sell, at the symbol's qty_scale. */
  qty: U64,
  max_slippage_bps: Bps,
});

export const BarsOrder = z.discriminatedUnion('side', [BarsBuyOrder, BarsSellOrder]);

export const BarsReply = z.strictObject({
  type: z.literal('reply'),
  /** The seq of the batch this answers. */
  seq: Seq,
  orders: z.array(BarsOrder),
});

export const BarsHarnessMessage = z.discriminatedUnion('type', [BarsHello, BarsBatch, BarsDone]);
export const BarsBotMessage = BarsReply;

export type BarsReplayHarnessT = z.infer<typeof BarsReplayHarness>;
export type BarsHelloT = z.infer<typeof BarsHello>;
export type BarsHelloSymbolT = z.infer<typeof BarsHelloSymbol>;
export type BarsBatchT = z.infer<typeof BarsBatch>;
export type BarsDoneT = z.infer<typeof BarsDone>;
export type BarsReplyT = z.infer<typeof BarsReply>;
export type BarsOrderT = z.infer<typeof BarsOrder>;
export type BarsFillT = z.infer<typeof BarsFill>;
export type SymbolBarT = z.infer<typeof SymbolBar>;
export type BarsAccountT = z.infer<typeof BarsAccount>;
export type BarsPositionT = z.infer<typeof BarsPosition>;
export type BarsCapitalT = z.infer<typeof BarsCapital>;
export type BarsCapsT = z.infer<typeof BarsCaps>;
export type BarsFeesT = z.infer<typeof BarsFees>;
export type BarsGuardrailsT = z.infer<typeof BarsGuardrails>;
export type BarsHarnessMessageT = z.infer<typeof BarsHarnessMessage>;
export type BarsRejectReasonT = z.infer<typeof BarsRejectReason>;
export type BarIntervalT = z.infer<typeof BarInterval>;

/**
 * The most orders one reply may carry before it is a protocol violation that fails the run:
 * max(64, 4 x caps.max_orders_per_bar). Orders past max_orders_per_bar but within it are rejected one
 * by one (reason max_orders_per_bar).
 */
export function barsReplyOrderCap(hello: { caps: Pick<BarsCapsT, 'max_orders_per_bar'> }): number {
  return Math.max(MIN_BARS_REPLY_ORDER_CAP, 4 * hello.caps.max_orders_per_bar);
}

/**
 * Parse one line from the bot: size cap, JSON, then the strict BarsReply schema (protocol.ts
 * parseBotLine, for this protocol). Returns the reply or a reason string (the grader turns a reason
 * into a protocol-violation failure); it never throws, whatever the bot wrote.
 */
export function parseBarsBotLine(line: string): { ok: true; reply: BarsReplyT } | { ok: false; reason: string } {
  const bytes = new TextEncoder().encode(line).byteLength;
  if (bytes > MAX_BOT_LINE_BYTES) return { ok: false, reason: `line is ${bytes} bytes (max ${MAX_BOT_LINE_BYTES})` };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  let parsed: ReturnType<typeof BarsReply.safeParse>;
  try {
    parsed = BarsReply.safeParse(value);
  } catch (err) {
    // No schema here throws on bad input (primitives.ts patterns abort, bars refinements run only on
    // valid input); should one ever, the bot's line is still a violation, never a grader crash.
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
 * reads, `$defs.bot_message` what it writes. Published in every bars competition kit as
 * protocol.schema.json. Cross-field rules (symbol order, a bar's t, OHLC order, a bar's two depths
 * of as many hops, a fill's reason) are the header's and the zod schemas'; JSON Schema carries the
 * shapes.
 */
export function barsProtocolJsonSchema(): Record<string, unknown> {
  const strip = (schema: Record<string, unknown>) => {
    const { $schema: _drop, ...rest } = schema;
    return rest;
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: BARS_PROTOCOL_SCHEMA_ID,
    title: BARS_PROTOCOL,
    description:
      `makefun bars replay protocol v1: newline-delimited JSON, harness -> bot on stdin (hello, batch..., done), bot -> harness on stdout (one reply per batch, echoing its seq). Harness lines are at most ${MAX_HARNESS_LINE_BYTES} bytes, bot lines at most ${MAX_BOT_LINE_BYTES} bytes (UTF-8, the newline not counted). Orders decided on a batch fill at the next bar's open, slipped and moved by constant-product impact against that bar's pool depth (o_depth: USDC raw units per hop of the asset's price path; c_depth is the pool at the close). Client ids starting with _ are reserved for the harness's closes. Prices, quantities and quote amounts are integer decimal strings at their scales; times are ms integers.`,
    $defs: {
      harness_message: strip(z.toJSONSchema(BarsHarnessMessage, { io: 'output' }) as Record<string, unknown>),
      bot_message: strip(z.toJSONSchema(BarsBotMessage, { io: 'input' }) as Record<string, unknown>),
    },
  };
}
