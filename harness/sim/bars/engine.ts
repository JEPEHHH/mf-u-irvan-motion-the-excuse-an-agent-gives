// The bars replay (agent-fun/bars-replay/v1, contracts/bars-protocol.ts): a deterministic, causal
// replay of a frozen OHLC bars dataset (contracts/bars-dataset.ts) against one bot, in lockstep.
//
//   const engine = new BarsEngine(dataset, hello);
//   send(engine.hello);
//   for (let batch; (batch = engine.nextBatch()); ) { send(batch); engine.submit(await readReply()); }
//   const { done, run } = engine.finish(); send(done);
//
// The market model is the protocol header's (contracts/bars-protocol.ts, "Market model"); this file
// implements it and adds only what the header leaves to the sim:
//   - Prices: a dataset bar's o and c are its reference prices, the medians of its first and last
//     five minutes of pool samples (contracts/bars-dataset.ts), delivered as the bar's open and close.
//     So an order fills at, and a position is marked at, a price one thin-pool slot cannot move.
//     Its o_depth and c_depth are delivered as they are, so the bot sees every number a fill uses.
//   - Lockstep: nextBatch() refuses while a batch awaits its reply, so the bot never sees bar k + 1
//     before it has answered bar k. Orders decided on batch k resolve at the open of bar k + 1, in
//     reply order, before batch k + 1 is built, so no order is ever outstanding when the bot decides.
//   - Fill math, every division truncating toward zero (BigInt `/` on non-negative values). A fill
//     trades against the pool: constant-product hops in series with the bar's open depth (o_depth:
//     per hop of the asset's price path, USDC raw units; a SOL-quoted asset crosses its own pool and
//     the SOL/USDC leg), which in value at the reference price trade exactly as one constant-product
//     pool of depth D = 1 / (1/D1 + 1/D2) (BarsPool). On a pool no fill has touched, a trade worth a
//     meets the factor M(a) = 1 + a/D1 (+ a/D2) (barsImpact); each fill of the symbol at that open
//     then moves the pool along its curve, in reply order, so a later fill meets the pool the earlier
//     ones left and an order cut into pieces pays what it would have whole. Each bar's pool starts
//     from its own recorded depth. When the bar's samples carry a concentrated pool's (Orca
//     Whirlpool, Raydium CLMM) active liquidity, its hop is recorded as the smaller of two
//     (collector/bars/freeze.ts sampleDepthOf). One is the reserve that liquidity alone holds at the
//     price. The pool trades as exactly that while the price stays between the initialized ticks
//     around it (ticks crossed are ignored), so a small order's impact is the pool's own. The other
//     is the min side its universe froze on the vaults' balances. The in-range reserve is virtual:
//     live, JITOSOL/SOL held 50.9M SOL in range beside 37.3k SOL in its vault. So a large order never
//     trades against tokens the pool does not hold. A small order inside the band is judged a little
//     harder than the curve says, never easier than the real tokens allow; entrants hunt for the
//     most optimistic fill, so the sim errs conservative. A dataset whose samples predate the
//     liquidity carries the frozen min side alone.
//       buy:  spend = notional * (10000 - fee_bps) / 10000;  fee = notional - spend
//             price = open * (10000 + slippage_bps) * M_buy(spend) / 10000
//             qty   = spend * 10^(qty_scale + price_scale) / (price * 10^quote_scale)
//       sell: price = max(1, open * (10000 - slippage_bps) / (10000 * M_sell(value(qty, open))))
//             gross = qty * price * 10^quote_scale / 10^(qty_scale + price_scale)
//             proceeds = gross * (10000 - fee_bps) / 10000;  fee = gross - proceeds
//     M is an exact fraction, divided once, in the price. A sell's price never truncates below 1, the
//     scale's resolution: a pool always pays something. max_slippage compares the price, impact
//     included, with the latest close, so a bot caps its own impact with max_slippage_bps. A rejected
//     order leaves the pool as it found it.
//   - A dataset whose open or close would truncate to a sell price of 0 under the hello's
//     slippage_bps is refused (SimDataError).
//   - Warm-up (hello.warmup_bars, N; 0 when absent): the dataset's window holds the N bars before the
//     scored window, then the scored window. Batches 0 to N - 1 deliver the warm-up bars as ordinary
//     batches, and every order decided on one is rejected (warmup, checked after zero_amount and
//     before after_end; its client id still counts as used and the reply's order cap still applies),
//     so nothing is held and the cash is the capital when batch N, the scored window's first bar,
//     arrives. Equity points start there: the start point (seq N - 1, t the scored window's start)
//     before batch N, one per scored batch, the end. run.window is the scored window; the bar checks
//     and feed() keep the dataset's; run.batches counts every batch delivered. A dataset with no bar
//     left after the warm-up is refused (SimDataError). Without the key every batch is scored, as it
//     always was.
//   - When the window ends, the last batch's orders are rejected (after_end, or the earlier decision
//     reason) and every position is flattened at its symbol's latest close with the sell model,
//     against that close's depth (c_depth), as `_flatten_<n>` fills (n counting closes from 0 in
//     symbol order). Neither reaches the bot: they live in the run's resolutions, which a replay of
//     the action log re-derives; done carries the account after them.
//   - Cost sensitivity (BarsEngineOptions): feeMultiplier multiplies fee_bps (capped at 10000; slippage is
//     unchanged), and clampOrders names the orders (`${seq}:${index}`) the 1x run accepted when they
//     were decided (decisionAccepted). The log's amounts were sized against the 1x account, so in the
//     re-run each of those is cut to what the account can take: a sell to the quantity still held, a
//     buy to the cash left and the weight cap's room. Without that a 'sell everything' would be
//     refused insufficient_position (the position riding to the flatten) and an 'all cash' buy
//     insufficient_cash. An order the 1x run refused when deciding is decided as written.
//   - Every resolution keeps the books: cash never goes below 0, a buy's spend + fee is its notional,
//     a sell's proceeds + fee its gross, and at the end the per-symbol PnL adds up to the cash change
//     with no position left. A broken invariant aborts the replay (SimAbortError, never scored).
//   - no_future_bars is the verdict of a causality audit (BarsLookaheadAudit) that reads only the
//     batches as they are sent and the replies as they are taken, never the engine's bookkeeping: a
//     bar from after the batch, a fill resolved at or before the bar it was decided on, or an equity
//     marked at a close the bot has not been sent turns it false and is named in run.lookahead.
//     A lookahead is the engine's fault, never the bot's: the batch the audit flags is withheld (the
//     bot never receives it) and the run aborts there, run.aborted naming the first finding. So
//     no_future_bars is false only on an aborted run, and like any broken invariant it is a harness
//     fault: grading throws it (sim/metrics.ts refuses an aborted run; grader/score.ts buildScore a
//     bars performance whose no_future_bars is false), the job retries, nothing is scored.
//
// Everything is BigInt and deterministic: the same (dataset, hello, replies, options) give
// byte-identical batches, fills and runs, which is what lets an action log be rescored
// (replayBarsActionLog). The action log is sim/engine.ts's agent-fun/action-log/v1 envelope with the
// bars protocol: {format, protocol, dataset_sha256, hello, replies}.
//
// Live mode: the same replay over bars that arrive while it runs (a race over a window still being
// recorded). The engine starts from the window, the hello and each symbol's mint and scales, with no
// bar, and is fed as each interval closes:
//
//   const engine = BarsEngine.live({ interval, window, symbols }, hello);
//   engine.feed(t, { SOL: bar });      // every symbol's bars through t; a symbol left out has a gap there
//   if (engine.ready()) batch = engine.nextBatch();
//
// feed() checks each bar exactly as the constructor checks a frozen dataset's, and makes every close
// up to t final. ready() says whether the bar the next batch closes has been fed; nextBatch() refuses
// (SimProtocolError) until it has, and otherwise keeps its contract. Fed a frozen dataset's bars, in
// any number of feeds interleaved with the replies in any way, a live engine gives the frozen
// engine's batches, fills and run byte for byte, save the digest: no frozen dataset backs a live run,
// so its run and action log name the declared placeholder BARS_LIVE_DATASET_SHA256, and a live run is
// compared with a graded one by its replies alone. A frozen engine is always ready and takes no feed.

import { z } from 'zod';
import { MAX_BARS_HOPS } from '../../contracts/bars-dataset.ts';
import {
  BAR_INTERVAL_MS,
  BARS_PROTOCOL,
  BarsHello,
  BarsReply,
  barsOhlcIssues,
  barsReplyOrderCap,
  parseBarsBotLine,
  USDC_DECIMALS,
  type BarIntervalT,
  type BarsAccountT,
  type BarsBatchT,
  type BarsDoneT,
  type BarsFillT,
  type BarsHelloT,
  type BarsOrderT,
  type BarsRejectReasonT,
  type BarsReplyT,
  type SymbolBarT,
} from '../../contracts/bars-protocol.ts';
import { Sha256Hex } from '../../contracts/primitives.ts';
import { MAX_HARNESS_LINE_BYTES, type BatchT, type DoneT, type HelloT } from '../../contracts/protocol.ts';
import { ACTION_LOG_FORMAT, SimAbortError, SimDataError, SimProtocolError, type ReplayEngine, type ReplayRun } from '../engine.ts';

export { SimAbortError, SimDataError, SimProtocolError };

export const BPS = 10_000n;

/**
 * What a harness drives in lockstep, whatever the protocol: send hello; then while nextBatch()
 * gives a batch, send it and submit the bot's reply (a SimProtocolError is the bot's violation); then
 * finish() gives the done message to send and the run. BarsEngine is one, and so is the pump replay's
 * ReplayEngine (checked below), so one driver (grader/run.ts) can run either.
 */
export interface LockstepEngine<Hello, Batch extends { seq: number }, Done, Run> {
  readonly hello: Hello;
  nextBatch(): Batch | null;
  submit(reply: unknown): void;
  finish(): { done: Done; run: Run };
}

/** Compile-time only: the pump replay's engine has the lockstep shape (tsc fails here if it drifts). */
export type ReplayLockstepEngine = LockstepEngine<HelloT, BatchT, DoneT, ReplayRun>;
type Satisfies<T extends ReplayLockstepEngine> = T;
export type CheckedReplayEngine = Satisfies<ReplayEngine>;

/** What the bot did: every reply, in batch order, with what it answered (hello and dataset digest). */
export const BarsActionLog = z.strictObject({
  format: z.literal(ACTION_LOG_FORMAT),
  protocol: z.literal(BARS_PROTOCOL),
  dataset_sha256: Sha256Hex,
  hello: BarsHello,
  replies: z.array(BarsReply),
});
export type BarsActionLogT = z.infer<typeof BarsActionLog>;

/** One bar as the replay reads it (a dataset line, contracts/bars-dataset.ts BarsDatasetLine); its provenance keys (venue, slots, samples) are ignored. */
export interface BarsDatasetBarInput {
  /** Close time (ms): a multiple of the interval, in (window.start_ms, window.end_ms]. */
  t: number;
  /** The fill reference (the median of the bar's first five minutes). */
  o: string;
  h: string;
  l: string;
  /** The mark reference (the median of its last five minutes). */
  c: string;
  v: string | null;
  /** The pool depth at o and at c: per hop of the asset's price path, USDC raw units, each above 0. */
  o_depth: readonly string[];
  c_depth: readonly string[];
}

/** A symbol before its bars: its mint and scales (what a live engine is told up front). */
export interface BarsSymbolSpec {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
}

/** One symbol's series: its mint, scales and bars (t strictly ascending; a missing t is a gap). */
export interface BarsSeries extends BarsSymbolSpec {
  bars: readonly BarsDatasetBarInput[];
}

/** A frozen bars dataset as the replay reads it (the manifest's facts plus each symbol's bars). */
export interface BarsDataset {
  /** The manifest's dataset_sha256: the digest the contamination certificate names. */
  sha256: string;
  interval: BarIntervalT;
  window: { start_ms: number; end_ms: number; bars: number };
  /** Every symbol the dataset carries, a superset of the hello's universe. */
  symbols: readonly BarsSeries[];
}

/** What a live engine starts from (BarsEngine.live): a frozen dataset's facts without its digest and bars. */
export interface BarsLiveSpec {
  interval: BarIntervalT;
  window: { start_ms: number; end_ms: number; bars: number };
  /** Every symbol it may be fed, a superset of the hello's universe. */
  symbols: readonly BarsSymbolSpec[];
}

/** One symbol's bars in a feed: one bar, or a list (t strictly ascending). */
export type BarsFedBars = BarsDatasetBarInput | readonly BarsDatasetBarInput[];

/**
 * One feed() of a live engine, by symbol: its bars closing after the last close fed and at or before
 * the feed's t. A symbol left out, or given an empty list, has a gap at each of those closes, as a
 * frozen dataset with no line there has.
 */
export type BarsFeed = ReadonlyMap<string, BarsFedBars> | Readonly<Record<string, BarsFedBars>>;

/**
 * The dataset_sha256 a live engine's run and action log carry: a declared placeholder, since no frozen
 * dataset backs a live run (no dataset's bytes hash to all zeros). So replayBarsActionLog refuses a
 * live log against any frozen dataset; a live run is compared with the graded one by its replies alone.
 */
export const BARS_LIVE_DATASET_SHA256 = '0'.repeat(64);

/** The placeholder datasets BarsEngine.live builds: the constructor starts each of those live. */
const LIVE_SOURCES = new WeakSet<BarsDataset>();

export interface BarsEngineOptions {
  /** fee_bps multiplied by this, capped at 10000 (cost sensitivity). Default 1. */
  feeMultiplier?: number;
  /** Orders (`${seq}:${index}`) cut to what the account can take when decided (see the header). */
  clampOrders?: ReadonlySet<string>;
}

export type BarsResolutionKind = 'order' | 'flatten';

/** One resolution: the protocol fill plus what the sim knows about it. */
export interface BarsSimFill extends BarsFillT {
  kind: BarsResolutionKind;
  /** Batch seq and order index it was decided on (null for a flatten close). */
  seq: number | null;
  index: number | null;
  /** Where a rejection happened: when decided, or at the open it would have filled at. Null when filled. */
  rejected_at: 'decision' | 'fill' | null;
  /** The bot's position in the symbol just before this resolution. */
  position_before_qty: string;
  /** The bot's cash after it. */
  cash_after_quote_units: string;
}

export interface BarsEquityPoint {
  /** The batch seq it follows: warmup_bars - 1 for the start (-1 without a warm-up), `batches` for after the flatten. */
  seq: number;
  /** The start's is the scored window's start_ms; a batch's its t; the end's the last batch's t. */
  t: number;
  cash_quote_units: string;
  /** Cash plus every position at its symbol's latest close (no fee, no slippage, no impact). */
  equity_quote_units: string;
}

export interface BarsRoundTrip {
  symbol: string;
  /** t of the bar whose open filled the order that opened the position. */
  opened_bar: number;
  /** t of the bar whose open emptied it (the last batch's t for a flatten). */
  closed_bar: number;
  /** Every quote unit in and out while the position was open, fees included. */
  pnl_quote_units: string;
}

/** One universe symbol's books over the run (contracts/score.ts SymbolPnl's shape). */
export interface BarsSymbolLedger {
  symbol: string;
  /** Every quote unit in and out on it, fees included. */
  pnl_quote_units: string;
  /** The bot's own filled orders on it (flatten closes excluded). */
  trades: number;
  /** Every fee paid on it, flatten closes included. */
  fees_quote_units: string;
}

export interface BarsRun {
  protocol: typeof BARS_PROTOCOL;
  /** The dataset's digest; BARS_LIVE_DATASET_SHA256 on a live run (here and in action_log). */
  dataset_sha256: string;
  fee_multiplier: number;
  hello: BarsHelloT;
  action_log: BarsActionLogT;
  /** Batches delivered, the warm-up's included. */
  batches: number;
  /** The scored window: the dataset's, less the warm-up bars at its start (hello.warmup_bars). */
  window: { start_ms: number; end_ms: number; bars: number };
  resolutions: BarsSimFill[];
  equity: BarsEquityPoint[];
  round_trips: BarsRoundTrip[];
  /** One row per universe symbol, in code-unit order. */
  per_symbol: BarsSymbolLedger[];
  final_account: BarsAccountT;
  start_quote_units: string;
  /** The causality audit found nothing the bot was sent ahead of its time (BarsLookaheadAudit); false only with aborted set. */
  no_future_bars: boolean;
  /** What it found, in order (the first MAX_LOOKAHEAD_ISSUES); empty exactly when no_future_bars. */
  lookahead: string[];
  /** Null unless an invariant failed; then the run must not be scored. */
  aborted: string | null;
}

/** A bar of the replay: the dataset line's prices and depths as integers, and the wire form the bot is sent. */
export interface BarsReplayBar {
  t: number;
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
  /** The depth a fill at o meets, and a flatten at c. */
  od: readonly bigint[];
  cd: readonly bigint[];
  /** The wire form, delivered as is: the prices and both depths as the dataset line holds them. */
  wire: SymbolBarT;
}

interface SymbolRt {
  symbol: string;
  /** Its bars by close time (a live engine's grow with each feed). */
  byT: Map<number, BarsReplayBar>;
  /** Its latest bar's t (window.start_ms before any) and depth hops (null before any): what its next bar is checked against. */
  lastT: number;
  hops: number | null;
  scales: BarsScales;
  /** 10^quote_scale and 10^(qty_scale + price_scale): value(q, p) = q * p * num / den. */
  num: bigint;
  den: bigint;
  /** The latest close at or before the current batch and its depth, null until the first bar. */
  close: bigint | null;
  closeDepth: readonly bigint[];
  qty: bigint;
  cost: bigint;
  pnl: bigint;
  trades: number;
  fees: bigint;
  /** The open round trip: its cash flow and the bar its first fill landed on. */
  open: { pnl: bigint; openedBar: number } | null;
}

interface Pending {
  order: BarsOrderT;
  seq: number;
  index: number;
  decidedBar: number;
  fillBar: number;
  reject: BarsRejectReasonT | null;
  /** The amount it trades: notional (buy) or qty (sell), after any clamp. */
  amount: bigint;
  /** The symbol's latest close when decided (max_slippage's reference); null when it had none. */
  close: bigint | null;
}

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const str = (n: bigint) => n.toString();
const min = (a: bigint, b: bigint) => (a < b ? a : b);
/** The most lookaheads a run keeps (run.lookahead). */
export const MAX_LOOKAHEAD_ISSUES = 20;

/** One protocol message as the line the harness writes; refuses lines over MAX_HARNESS_LINE_BYTES. */
export function encodeBarsHarnessLine(msg: BarsHelloT | BarsBatchT | BarsDoneT): string {
  const line = JSON.stringify(msg);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_HARNESS_LINE_BYTES) throw new SimDataError(`${msg.type} line is ${bytes} bytes (max ${MAX_HARNESS_LINE_BYTES})`);
  return `${line}\n`;
}

/** A symbol's scales: its prices' and quantities', and the competition's quote scale. */
export interface BarsScales {
  quote_scale: number;
  price_scale: number;
  qty_scale: number;
}

/** The fee and slippage a fill is charged, in bps. */
export interface BarsFillBps {
  fee_bps: bigint;
  slippage_bps: bigint;
}

/** The quote units q is worth at price p (the protocol's value()). */
export function barsValue(q: bigint, p: bigint, scales: BarsScales): bigint {
  return (q * p * 10n ** BigInt(scales.quote_scale)) / 10n ** BigInt(scales.qty_scale + scales.price_scale);
}

const gcd = (a: bigint, b: bigint): bigint => {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};

/**
 * The pool one symbol's fills walk at one open (or a flatten's close). The bar's depths are
 * constant-product hops in series, USDC raw units, one per hop of the asset's price path. In value
 * at the reference price such a chain trades exactly as one constant-product pool of depth
 * D = 1 / (1/D1 + 1/D2): a trade worth a gives a/(1 + a/D1 + a/D2) through both, and every later
 * trade continues the same curve. The state is that pool's quote side y (D before any fill), against
 * its invariant x y = D^2:
 *   a buy spending s pays the factor y (y + s) / D^2 over the reference price, and y becomes y + s;
 *   a sell worth v at the reference gets the reference over (D^2 + v y) / y^2, and y becomes
 *   D^2 y / (D^2 + v y).
 * Each fill of the symbol at that open moves the pool, in reply order, so an order cut into pieces
 * pays what it would have paid whole. The next bar starts again from its own recorded depth: an
 * hour is ample for arbitrage to restore the pool. Amounts are scaled by 10^6 and depths by
 * 10^quote_scale, so both count 10^-(quote_scale + 6) USDC; y is kept as a reduced fraction.
 */
export class BarsPool {
  private readonly yn: bigint;
  private readonly yd: bigint;
  /** D^2 = kn / kd. */
  private readonly kn: bigint;
  private readonly kd: bigint;
  /** 10^6: a quote amount in the pool's units. */
  private readonly unit: bigint;

  private constructor(yn: bigint, yd: bigint, kn: bigint, kd: bigint, unit: bigint) {
    const g = gcd(yn, yd);
    this.yn = yn / g;
    this.yd = yd / g;
    this.kn = kn;
    this.kd = kd;
    this.unit = unit;
  }

  /** A pool no fill has touched: hops in series with these depths (USDC raw units, each above 0), for amounts at quote_scale. */
  static of(depth: readonly bigint[], quoteScale: number): BarsPool {
    if (depth.length === 0 || depth.some((d) => d < 1n)) throw new RangeError(`a fill needs a depth above 0 on every hop, got [${depth.join(', ')}]`);
    const d = depth.map((x) => x * 10n ** BigInt(quoteScale));
    // D = prod / sum, with prod the product of the depths and sum the sum of each one's complement.
    const prod = d.reduce((p, x) => p * x, 1n);
    const sum = d.map((_, i) => d.reduce((p, x, j) => (j === i ? p : p * x), 1n)).reduce((s, x) => s + x, 0n);
    const g = gcd(prod, sum);
    return new BarsPool(prod / g, sum / g, (prod / g) ** 2n, (sum / g) ** 2n, 10n ** BigInt(USDC_DECIMALS));
  }

  /** A buy spending `spend` quote units: the factor num / den its average price is over the reference, and the pool after it. */
  buy(spend: bigint): { num: bigint; den: bigint; after: BarsPool } {
    const yn2 = this.yn + spend * this.unit * this.yd;
    return { num: this.yn * yn2 * this.kd, den: this.yd * this.yd * this.kn, after: new BarsPool(yn2, this.yd, this.kn, this.kd, this.unit) };
  }

  /** A sell of asset worth `value` quote units at the reference: the factor num / den the reference is over its average price, and the pool after it. */
  sell(value: bigint): { num: bigint; den: bigint; after: BarsPool } {
    const t = this.kn * this.yd + value * this.unit * this.yn * this.kd;
    return { num: t * this.yd, den: this.kd * this.yn * this.yn, after: new BarsPool(this.kn * this.yn, t, this.kn, this.kd, this.unit) };
  }
}

/**
 * The factor a single trade worth `amount` quote units meets on a pool no fill has touched, reduced:
 * 1 + amount x (1/D1 + 1/D2), whichever way it runs (BarsPool).
 */
export function barsImpact(amount: bigint, depth: readonly bigint[], quoteScale: number): { num: bigint; den: bigint } {
  const { num, den } = BarsPool.of(depth, quoteScale).buy(amount);
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

const poolOf = (pool: BarsPool | readonly bigint[], quoteScale: number) => (pool instanceof BarsPool ? pool : BarsPool.of(pool, quoteScale));

/**
 * A buy of `notional` at `open` on `pool` (a BarsPool, or the depths of one no fill has touched): the
 * price (slippage and impact in), the fee, the quantity received (0 when it truncates away) and the
 * pool after it.
 */
export function barsBuyFill(notional: bigint, open: bigint, pool: BarsPool | readonly bigint[], bps: BarsFillBps, scales: BarsScales): { price: bigint; spend: bigint; fee: bigint; qty: bigint; after: BarsPool } {
  const spend = (notional * (BPS - bps.fee_bps)) / BPS;
  const m = poolOf(pool, scales.quote_scale).buy(spend);
  const price = (open * (BPS + bps.slippage_bps) * m.num) / (BPS * m.den);
  const qty = (spend * 10n ** BigInt(scales.qty_scale + scales.price_scale)) / (price * 10n ** BigInt(scales.quote_scale));
  return { price, spend, fee: notional - spend, qty, after: m.after };
}

/**
 * A sell of `qty` at `open` (or a close) on `pool`: the price (slippage and impact in, at least 1),
 * the gross value, the fee, the proceeds and the pool after it.
 */
export function barsSellFill(qty: bigint, open: bigint, pool: BarsPool | readonly bigint[], bps: BarsFillBps, scales: BarsScales): { price: bigint; gross: bigint; fee: bigint; proceeds: bigint; after: BarsPool } {
  const m = poolOf(pool, scales.quote_scale).sell(barsValue(qty, open, scales));
  const slipped = (open * (BPS - bps.slippage_bps) * m.den) / (BPS * m.num);
  const price = slipped < 1n ? 1n : slipped;
  const gross = barsValue(qty, price, scales);
  const proceeds = (gross * (BPS - bps.fee_bps)) / BPS;
  return { price, gross, fee: gross - proceeds, proceeds, after: m.after };
}

/** The clampOrders set of a run: every order that passed its decision checks (filled, or rejected only at the fill). */
export function decisionAccepted(run: Pick<BarsRun, 'resolutions'>): Set<string> {
  const out = new Set<string>();
  for (const f of run.resolutions) if (f.kind === 'order' && f.rejected_at !== 'decision') out.add(`${f.seq}:${f.index}`);
  return out;
}

/**
 * The causality audit behind a run's no_future_bars. It reads only what crosses the wire, each batch
 * as it is sent and each reply as it is taken, never the engine's own bookkeeping, so a lookahead
 * anywhere upstream of the wire shows here:
 *   - a batch sent before the bot replied to the one before, or not on its interval's close;
 *   - a bar whose t is after the batch's: bar t + 1 handed to the bot before it decided on t;
 *   - a fill resolved at a bar after the batch carrying it, at or before the bar its order was
 *     decided on (filled at an open the bot had seen the close of), or decided on a batch the bot has
 *     not answered;
 *   - an account whose equity is not its cash plus every position at the latest close the bot has
 *     been sent: a mark at a close it has not seen.
 * Each violation is kept, in order (the first MAX_LOOKAHEAD_ISSUES); ok is no_future_bars. The
 * engine withholds a batch the audit flags and aborts the run (the header).
 */
export class BarsLookaheadAudit {
  private readonly step: number;
  private readonly firstClose: number;
  private readonly scales = new Map<string, BarsScales>();
  /** Each symbol's latest close the bot has been sent. */
  private readonly closes = new Map<string, bigint>();
  private sent = 0;
  private answered = 0;
  private flagged = 0;
  readonly issues: string[] = [];

  constructor(hello: BarsHelloT) {
    this.step = BAR_INTERVAL_MS[hello.bar_interval];
    this.firstClose = hello.first_close_ms;
    for (const s of hello.symbols) this.scales.set(s.symbol, { quote_scale: hello.capital.quote_scale, price_scale: s.price_scale, qty_scale: s.qty_scale });
  }

  /** Nothing was found. */
  get ok(): boolean {
    return this.flagged === 0;
  }

  private flag(issue: string): void {
    this.flagged++;
    if (this.issues.length < MAX_LOOKAHEAD_ISSUES) this.issues.push(issue);
  }

  /** A batch, as it is about to be sent. */
  batch(b: BarsBatchT): void {
    const at = `batch ${b.seq} (t ${b.t})`;
    if (this.answered < this.sent) this.flag(`${at} was sent before the reply to batch ${this.sent - 1}`);
    const due = this.firstClose + this.sent * this.step;
    if (b.seq !== this.sent || b.t !== due) this.flag(`${at} came where batch ${this.sent} (t ${due}) was due`);
    const lastAnswered = this.answered === 0 ? null : this.firstClose + (this.answered - 1) * this.step;
    for (const bar of b.bars) if (bar.t > b.t) this.flag(`${at} carries ${bar.symbol}'s bar t ${bar.t}, after its own t`);
    for (const f of b.fills) {
      if (f.fill_bar > b.t) this.flag(`${at} carries ${f.client_id} resolved at bar ${f.fill_bar}, after its own t`);
      if (f.fill_bar <= f.decided_bar) this.flag(`${at} carries ${f.client_id} resolved at bar ${f.fill_bar}, not after the bar ${f.decided_bar} it was decided on`);
      if (lastAnswered === null || f.decided_bar > lastAnswered) this.flag(`${at} carries ${f.client_id} decided on bar ${f.decided_bar}, which the bot has not answered`);
    }
    for (const bar of b.bars) this.closes.set(bar.symbol, BigInt(bar.c));
    let equity = BigInt(b.account.cash_quote_units);
    for (const p of b.account.positions) {
      const close = this.closes.get(p.symbol);
      const scales = this.scales.get(p.symbol);
      if (close === undefined || scales === undefined) this.flag(`${at} holds ${p.symbol}, whose close the bot has not been sent`);
      else equity += barsValue(BigInt(p.qty), close, scales);
    }
    if (equity !== BigInt(b.account.equity_quote_units)) this.flag(`${at}'s equity ${b.account.equity_quote_units} is not its cash plus its positions at the closes the bot was sent (${equity})`);
    this.sent++;
  }

  /** The bot's reply to the batch last sent, as it is taken. */
  reply(seq: number): void {
    if (seq !== this.sent - 1 || this.answered !== this.sent - 1) this.flag(`a reply to batch ${seq} was taken while batch ${this.sent - 1} was the one waiting`);
    else this.answered++;
  }
}

function parseDepth(raw: unknown, at: string, key: string): bigint[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BARS_HOPS) throw new SimDataError(`${at}: ${key} ${JSON.stringify(raw)} is not 1..${MAX_BARS_HOPS} depths`);
  return raw.map((d) => {
    if (typeof d !== 'string' || !U64_RE.test(d) || BigInt(d) < 1n) throw new SimDataError(`${at}: ${key} ${JSON.stringify(raw)} holds ${JSON.stringify(d)}, not a u64 decimal above 0`);
    return BigInt(d);
  });
}

function parseBar(raw: BarsDatasetBarInput, symbol: string): BarsReplayBar {
  const at = `${symbol} bar t=${String(raw.t)}`;
  for (const k of ['o', 'h', 'l', 'c'] as const) {
    if (typeof raw[k] !== 'string' || !U64_RE.test(raw[k])) throw new SimDataError(`${at}: ${k} ${JSON.stringify(raw[k])} is not a u64 decimal`);
  }
  if (raw.v !== null && (typeof raw.v !== 'string' || !U64_RE.test(raw.v))) throw new SimDataError(`${at}: v ${JSON.stringify(raw.v)} is neither null nor a u64 decimal`);
  const issues: string[] = [];
  barsOhlcIssues(raw, (path, message) => issues.push(`${path.join('.')}: ${message}`));
  if (issues.length > 0) throw new SimDataError(`${at}: ${issues[0]}`);
  const od = parseDepth(raw.o_depth, at, 'o_depth');
  const cd = parseDepth(raw.c_depth, at, 'c_depth');
  if (od.length !== cd.length) throw new SimDataError(`${at}: o_depth has ${od.length} hops, c_depth ${cd.length}`);
  return {
    t: raw.t,
    o: BigInt(raw.o),
    h: BigInt(raw.h),
    l: BigInt(raw.l),
    c: BigInt(raw.c),
    od,
    cd,
    wire: { symbol, t: raw.t, o: raw.o, h: raw.h, l: raw.l, c: raw.c, v: raw.v, o_depth: od.map(str), c_depth: cd.map(str) },
  };
}

export class BarsEngine implements LockstepEngine<BarsHelloT, BarsBatchT, BarsDoneT, BarsRun> {
  readonly hello: BarsHelloT;
  private readonly datasetSha: string;
  private readonly window: { start_ms: number; end_ms: number; bars: number };
  /** The warm-up batches (hello.warmup_bars, 0 when absent): orders decided on them are rejected (warmup). */
  private readonly warm: number;
  /** The window scored: the dataset's less the warm-up (run.window). */
  private readonly scoredWindow: { start_ms: number; end_ms: number; bars: number };
  private readonly step: number;
  private readonly firstClose: number;
  private readonly batchCount: number;
  private readonly multNum: number;
  private readonly feeBps: bigint;
  private readonly slippageBps: bigint;
  private readonly minNotional: bigint;
  private readonly quoteScale: number;
  private readonly clamp: ReadonlySet<string>;
  /** The least o or c a bar may carry: ceil(10000 / (10000 - slippage_bps)), so a sell there never truncates to a price of 0. */
  private readonly minPrice: bigint;
  /** The universe, in code-unit order (hello.symbols'). */
  private readonly syms: SymbolRt[];
  private readonly bySymbol = new Map<string, SymbolRt>();
  /** Every symbol the dataset (or live spec) names, the universe's and any other. */
  private readonly declared: ReadonlySet<string>;
  private readonly audit: BarsLookaheadAudit;
  /** Bars arrive through feed() (BarsEngine.live), not with the dataset. */
  private readonly isLive: boolean;
  /** Every close at or before it is final: the last fed (live; window.start_ms before any feed), or the window's end (frozen). */
  private fedThrough: number;

  private phase: 'ready' | 'awaiting_reply' | 'finished' = 'ready';
  private seq = 0;
  private aborted: string | null = null;
  private cash: bigint;
  private readonly startCash: bigint;
  private pending: Pending[] = [];
  private readonly usedIds = new Set<string>();
  private readonly resolutions: BarsSimFill[] = [];
  private undelivered: BarsFillT[] = [];
  private readonly equity: BarsEquityPoint[] = [];
  private readonly roundTrips: BarsRoundTrip[] = [];
  private readonly replies: BarsReplyT[] = [];
  private closeCounter = 0;

  constructor(dataset: BarsDataset, hello: BarsHelloT, opts: BarsEngineOptions = {}) {
    this.hello = BarsHello.parse(hello);
    const h = this.hello;
    if (!Sha256Hex.safeParse(dataset.sha256).success) throw new SimDataError(`dataset sha256 ${JSON.stringify(dataset.sha256)} is not a lowercase hex sha256`);
    this.datasetSha = dataset.sha256;
    const m = opts.feeMultiplier ?? 1;
    if (!Number.isInteger(m) || m < 1) throw new RangeError(`feeMultiplier must be a positive integer, got ${m}`);
    this.multNum = m;
    const fee = BigInt(h.fees.fee_bps) * BigInt(m);
    this.feeBps = fee > BPS ? BPS : fee;
    this.slippageBps = BigInt(h.fees.slippage_bps);
    this.minNotional = BigInt(h.fees.min_notional_quote_units);
    this.quoteScale = h.capital.quote_scale;
    this.clamp = opts.clampOrders ?? new Set();
    this.isLive = LIVE_SOURCES.has(dataset);

    // The window and its batches.
    if (dataset.interval !== h.bar_interval) throw new SimDataError(`the dataset's interval is ${dataset.interval}, the hello's ${h.bar_interval}`);
    const step = BAR_INTERVAL_MS[dataset.interval];
    const w = dataset.window;
    if (!Number.isSafeInteger(w.start_ms) || !Number.isSafeInteger(w.end_ms) || w.start_ms < 0 || w.start_ms % step !== 0 || w.end_ms % step !== 0 || w.end_ms <= w.start_ms) {
      throw new SimDataError(`window ${w.start_ms}..${w.end_ms} is not a span of whole ${dataset.interval} intervals`);
    }
    if ((w.end_ms - w.start_ms) / step !== w.bars) throw new SimDataError(`window ${w.start_ms}..${w.end_ms} holds ${(w.end_ms - w.start_ms) / step} intervals, not ${w.bars}`);
    if (h.first_close_ms !== w.start_ms + step) throw new SimDataError(`hello.first_close_ms ${h.first_close_ms} is not the window's first close ${w.start_ms + step}`);
    this.window = { start_ms: w.start_ms, end_ms: w.end_ms, bars: w.bars };
    this.warm = h.warmup_bars ?? 0;
    if (this.warm >= w.bars) throw new SimDataError(`hello.warmup_bars ${this.warm} leaves no bar of the window's ${w.bars} to score`);
    this.scoredWindow = { start_ms: w.start_ms + this.warm * step, end_ms: w.end_ms, bars: w.bars - this.warm };
    this.step = step;
    this.firstClose = w.start_ms + step;
    this.batchCount = w.bars;
    this.fedThrough = this.isLive ? w.start_ms : w.end_ms;

    // The universe: every hello symbol, carried by the dataset under the same mint and scales.
    const series = new Map(dataset.symbols.map((s) => [s.symbol, s]));
    this.declared = new Set(series.keys());
    // The least price x with x * (10000 - slippage_bps) / 10000 >= 1: ceil(10000 / (10000 - slippage_bps)).
    this.minPrice = (BPS + (BPS - this.slippageBps) - 1n) / (BPS - this.slippageBps);
    this.syms = h.symbols.map((hs) => {
      const s = series.get(hs.symbol);
      if (s === undefined) throw new SimDataError(`the dataset carries no ${hs.symbol}`);
      if (s.mint !== hs.mint) throw new SimDataError(`${hs.symbol} is ${s.mint} in the dataset, ${hs.mint} in the hello`);
      if (s.price_scale !== hs.price_scale || s.qty_scale !== hs.qty_scale) {
        throw new SimDataError(`${hs.symbol}'s scales are price ${s.price_scale} / qty ${s.qty_scale} in the dataset, ${hs.price_scale} / ${hs.qty_scale} in the hello`);
      }
      const rt: SymbolRt = {
        symbol: hs.symbol,
        byT: new Map(),
        lastT: w.start_ms,
        hops: null,
        scales: { quote_scale: this.quoteScale, price_scale: hs.price_scale, qty_scale: hs.qty_scale },
        num: 10n ** BigInt(this.quoteScale),
        den: 10n ** BigInt(hs.qty_scale + hs.price_scale),
        close: null,
        closeDepth: [],
        qty: 0n,
        cost: 0n,
        pnl: 0n,
        trades: 0,
        fees: 0n,
        open: null,
      };
      for (const raw of s.bars) this.admit(rt, this.checkBar(hs.symbol, raw, rt.lastT, rt.hops));
      this.bySymbol.set(hs.symbol, rt);
      return rt;
    });

    this.cash = BigInt(h.capital.quote_units);
    this.startCash = this.cash;
    this.audit = new BarsLookaheadAudit(this.hello);
  }

  /**
   * A live engine (the header's Live mode): the window, the hello and each symbol's mint and scales,
   * checked as the constructor checks a frozen dataset's, and no bar yet; feed() brings them. Its run
   * and action log carry BARS_LIVE_DATASET_SHA256. Called on a subclass, it builds that subclass.
   */
  static live<E extends BarsEngine>(this: new (dataset: BarsDataset, hello: BarsHelloT, opts?: BarsEngineOptions) => E, spec: BarsLiveSpec, hello: BarsHelloT, opts: BarsEngineOptions = {}): E {
    const source: BarsDataset = {
      sha256: BARS_LIVE_DATASET_SHA256,
      interval: spec.interval,
      window: spec.window,
      symbols: spec.symbols.map((s) => ({ symbol: s.symbol, mint: s.mint, price_scale: s.price_scale, qty_scale: s.qty_scale, bars: [] })),
    };
    LIVE_SOURCES.add(source);
    return new this(source, hello, opts);
  }

  /**
   * One bar of a universe symbol, checked as every bar is, a frozen dataset's or a fed one: a close of
   * the window after the symbol's previous bar (prevT), its prices and depths well formed, o and c at
   * least minPrice (a sell there keeps a price above 0), and as many depth hops as its earlier bars
   * (hops).
   */
  private checkBar(symbol: string, raw: BarsDatasetBarInput, prevT: number, hops: number | null): BarsReplayBar {
    const w = this.window;
    if (!Number.isSafeInteger(raw.t) || raw.t % this.step !== 0 || raw.t <= w.start_ms || raw.t > w.end_ms) {
      throw new SimDataError(`${symbol} bar t=${String(raw.t)} is not a ${this.hello.bar_interval} close in (${w.start_ms}, ${w.end_ms}]`);
    }
    if (raw.t <= prevT) throw new SimDataError(`${symbol} bar t=${raw.t} does not follow ${prevT}: bars are strictly ascending`);
    const bar = parseBar(raw, symbol);
    for (const [k, x] of [
      ['o', bar.o],
      ['c', bar.c],
    ] as const) {
      if (x < this.minPrice) throw new SimDataError(`${symbol} bar t=${raw.t}: ${k} ${x} sells at a price of 0 under slippage_bps ${this.slippageBps}: the price scale is too coarse`);
    }
    if (hops !== null && bar.od.length !== hops) throw new SimDataError(`${symbol} bar t=${raw.t} has ${bar.od.length} depth hops, its earlier bars ${hops}: an asset's price path is one`);
    return bar;
  }

  /** Append a checked bar to its symbol's series. */
  private admit(s: SymbolRt, bar: BarsReplayBar): void {
    s.byT.set(bar.t, bar);
    s.lastT = bar.t;
    s.hops ??= bar.od.length;
  }

  /**
   * Live mode: append each symbol's bars through t (BarsFeed) and make every close up to t final; a
   * universe symbol given no bar at a close has a gap there. t is a close after the last one fed, at
   * or before the window's end. Each bar is checked exactly as the constructor checks a frozen
   * dataset's (checkBar) and must close after the last close fed and at or before t. A symbol the
   * engine was not given is refused; one it was given outside the hello's universe is ignored, as a
   * frozen dataset's extra series are. All or nothing: a refused feed (SimDataError) leaves the engine
   * as it was. A frozen engine takes no feed.
   */
  feed(t: number, bars: BarsFeed): void {
    if (!this.isLive) throw new SimDataError('a frozen engine takes no feed: its dataset holds every bar');
    const w = this.window;
    if (!Number.isSafeInteger(t) || t % this.step !== 0 || t <= this.fedThrough || t > w.end_ms) {
      throw new SimDataError(`feed t=${String(t)} is not a ${this.hello.bar_interval} close in (${this.fedThrough}, ${w.end_ms}]: bars are fed through ${this.fedThrough}`);
    }
    const entries: [string, BarsFedBars][] = bars instanceof Map ? [...(bars as ReadonlyMap<string, BarsFedBars>)] : Object.entries(bars as Readonly<Record<string, BarsFedBars>>);
    const staged: [SymbolRt, BarsReplayBar[]][] = [];
    for (const [symbol, given] of entries) {
      if (!this.declared.has(symbol)) throw new SimDataError(`feed t=${t} carries ${symbol}, a symbol the engine was not given`);
      const s = this.bySymbol.get(symbol);
      if (s === undefined) continue;
      const list = Array.isArray(given) ? (given as readonly BarsDatasetBarInput[]) : [given as BarsDatasetBarInput];
      const out: BarsReplayBar[] = [];
      let prevT = s.lastT;
      let hops = s.hops;
      for (const raw of list) {
        const bar = this.checkBar(symbol, raw, prevT, hops);
        if (bar.t <= this.fedThrough) throw new SimDataError(`${symbol} bar t=${bar.t} closes at or before ${this.fedThrough}, a close already fed`);
        if (bar.t > t) throw new SimDataError(`${symbol} bar t=${bar.t} closes after the feed's t=${t}`);
        out.push(bar);
        prevT = bar.t;
        hops ??= bar.od.length;
      }
      staged.push([s, out]);
    }
    for (const [s, fed] of staged) for (const bar of fed) this.admit(s, bar);
    this.fedThrough = t;
  }

  /**
   * Whether nextBatch() has the bars it needs: the close of batch `seq` has been fed, or no batch is
   * left to build (the window is done, or the run aborted). A frozen engine is always ready.
   */
  ready(): boolean {
    return this.aborted !== null || this.seq >= this.batchCount || this.firstClose + this.seq * this.step <= this.fedThrough;
  }

  /** The next batch, or null when the window is exhausted (then call finish). Refused on a live engine until ready(). */
  nextBatch(): BarsBatchT | null {
    if (this.phase === 'awaiting_reply') throw new SimProtocolError(`batch ${this.seq} has no reply yet`);
    if (this.phase === 'finished') throw new SimProtocolError('the replay is finished');
    if (this.aborted !== null || this.seq >= this.batchCount) return null;
    if (!this.ready()) throw new SimProtocolError(`batch ${this.seq} closes at t ${this.firstClose + this.seq * this.step}, and bars are fed only through ${this.fedThrough}`);
    let batch: BarsBatchT;
    try {
      batch = this.stepTo(this.seq);
    } catch (err) {
      if (err instanceof SimAbortError) {
        this.aborted = err.message;
        return null;
      }
      throw err;
    }
    this.audit.batch(batch);
    if (!this.audit.ok) {
      // The engine's fault, never the bot's: the batch is withheld and the run aborted (the header).
      this.lookaheadAbort();
      this.phase = 'ready';
      return null;
    }
    return batch;
  }

  /** A failed lookahead audit aborts the run, naming its first finding (run.lookahead lists them). */
  private lookaheadAbort(): void {
    this.aborted ??= `the lookahead audit failed, an engine fault: ${this.audit.issues[0] ?? 'no finding kept'}`;
  }

  /** The bot's reply to the current batch (the strict BarsReply schema, its seq, the order cap). */
  submit(reply: unknown): void {
    if (this.phase !== 'awaiting_reply') throw new SimProtocolError('a reply arrived without a pending batch');
    const parsed = BarsReply.safeParse(reply);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SimProtocolError(`not a reply: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}`);
    }
    const r = parsed.data;
    if (r.seq !== this.seq) throw new SimProtocolError(`reply seq ${r.seq} answers batch ${this.seq}`);
    const cap = barsReplyOrderCap(this.hello);
    if (r.orders.length > cap) throw new SimProtocolError(`reply to batch ${this.seq} carries ${r.orders.length} orders (max ${cap})`);
    this.audit.reply(r.seq);
    if (!this.audit.ok) this.lookaheadAbort();
    this.replies.push(r);
    this.decide(r);
    this.seq++;
    this.phase = 'ready';
  }

  /** submit() for a raw stdout line: parseBarsBotLine's size cap, JSON and schema checks first. */
  submitLine(line: string): void {
    const parsed = parseBarsBotLine(line);
    if (!parsed.ok) throw new SimProtocolError(parsed.reason);
    this.submit(parsed.reply);
  }

  /** Reject the last batch's orders, flatten, and close the replay: the done message and the run. */
  finish(): { done: BarsDoneT; run: BarsRun } {
    if (this.phase === 'awaiting_reply') throw new SimProtocolError(`batch ${this.seq} has no reply yet`);
    if (this.phase === 'finished') throw new SimProtocolError('the replay is already finished');
    if (this.aborted === null && this.seq < this.batchCount) throw new SimProtocolError(`finish() before the last batch (${this.seq} of ${this.batchCount})`);
    this.phase = 'finished';
    const lastBar = this.firstClose + (this.batchCount - 1) * this.step;
    if (this.aborted === null) {
      try {
        for (const p of this.pending) {
          if (p.reject === null) throw new SimAbortError(`order ${p.order.client_id} of the last batch passed its decision checks`);
          this.recordReject(p, p.reject, 'decision', false);
        }
        this.pending = [];
        for (const s of this.syms) if (s.qty > 0n) this.flatten(s, lastBar);
        this.equity.push({ seq: this.seq, t: lastBar, cash_quote_units: str(this.cash), equity_quote_units: str(this.cash) });
        this.checkTotals();
      } catch (err) {
        if (!(err instanceof SimAbortError)) throw err;
        this.aborted = err.message;
      }
    }
    // An aborted run's done carries the account as it stood; it is never scored.
    const account = this.account();
    const done: BarsDoneT = { type: 'done', seq: this.seq, reason: this.aborted === null ? 'end_of_data' : 'aborted', account };
    const run: BarsRun = {
      protocol: BARS_PROTOCOL,
      dataset_sha256: this.datasetSha,
      fee_multiplier: this.multNum,
      hello: this.hello,
      action_log: { format: ACTION_LOG_FORMAT, protocol: BARS_PROTOCOL, dataset_sha256: this.datasetSha, hello: this.hello, replies: this.replies },
      batches: this.seq,
      window: this.scoredWindow,
      resolutions: this.resolutions,
      equity: this.equity,
      round_trips: this.roundTrips,
      per_symbol: this.syms.map((s) => ({ symbol: s.symbol, pnl_quote_units: str(s.pnl), trades: s.trades, fees_quote_units: str(s.fees) })),
      final_account: account,
      start_quote_units: str(this.startCash),
      no_future_bars: this.audit.ok,
      lookahead: [...this.audit.issues],
      aborted: this.aborted,
    };
    return { done, run };
  }

  // ---------------------------------------------------------------- stepping

  /**
   * The bars batch k delivers and fills at, by symbol: every universe symbol's bar closing at
   * t = first_close_ms + k x the interval. Protected only so a test can stand in a subclass that
   * looks ahead, and see the audit catch it.
   */
  protected barsAt(k: number): ReadonlyMap<string, BarsReplayBar> {
    const t = this.firstClose + k * this.step;
    const out = new Map<string, BarsReplayBar>();
    for (const s of this.syms) {
      const b = s.byT.get(t);
      if (b !== undefined) out.set(s.symbol, b);
    }
    return out;
  }

  private stepTo(k: number): BarsBatchT {
    const t = this.firstClose + k * this.step;
    // The start point, before the scored window's first batch (batch 0 without a warm-up).
    if (k === this.warm) this.equity.push({ seq: this.warm - 1, t: this.scoredWindow.start_ms, cash_quote_units: str(this.cash), equity_quote_units: str(this.cash) });
    const now = this.barsAt(k);
    // 1. The previous batch's orders, at this bar's open, in reply order, each symbol's walking one pool.
    const pools = new Map<string, BarsPool>();
    for (const p of this.pending) this.resolve(p, now.get(p.order.symbol), pools);
    this.pending = [];
    // 2. The bar closes.
    for (const [symbol, b] of now) {
      const s = this.bySymbol.get(symbol)!;
      s.close = b.c;
      s.closeDepth = b.cd;
    }
    const bars = this.syms.filter((s) => now.has(s.symbol)).map((s) => now.get(s.symbol)!.wire);
    const fills = this.undelivered;
    this.undelivered = [];
    const account = this.account();
    // A warm-up batch is marked nowhere: equity starts at the scored window.
    if (k >= this.warm) this.equity.push({ seq: k, t, cash_quote_units: account.cash_quote_units, equity_quote_units: account.equity_quote_units });
    this.phase = 'awaiting_reply';
    return { type: 'batch', seq: k, t, bars, fills, account };
  }

  private equityNow(): bigint {
    let e = this.cash;
    for (const s of this.syms) if (s.qty > 0n) e += this.value(s, s.qty, s.close!);
    return e;
  }

  private account(): BarsAccountT {
    return {
      cash_quote_units: str(this.cash),
      positions: this.syms.filter((s) => s.qty > 0n).map((s) => ({ symbol: s.symbol, qty: str(s.qty), cost_quote_units: str(s.cost) })),
      equity_quote_units: str(this.equityNow()),
    };
  }

  private value(s: SymbolRt, q: bigint, p: bigint): bigint {
    return (q * p * s.num) / s.den;
  }

  // ---------------------------------------------------------------- deciding

  /** The decision checks of one reply, in order (the protocol header's list), against the batch's account. */
  private decide(r: BarsReplyT): void {
    const caps = this.hello.caps;
    const t = this.firstClose + this.seq * this.step;
    const isLast = this.seq === this.batchCount - 1;
    const equity = this.equityNow();
    let buys = 0n;
    const boughtBy = new Map<string, bigint>();
    const soldBy = new Map<string, bigint>();
    // Held symbols plus those bought earlier in the reply (max_open_positions); a sell frees no slot here.
    const open = new Set(this.syms.filter((s) => s.qty > 0n).map((s) => s.symbol));
    r.orders.forEach((order, index) => {
      const s = this.bySymbol.get(order.symbol);
      const written = BigInt(order.side === 'buy' ? order.notional_quote_units : order.qty);
      const clamp = this.clamp.has(`${this.seq}:${index}`);
      let amount = written;
      let reject: BarsRejectReasonT | null = null;
      if (index >= caps.max_orders_per_bar) reject = 'max_orders_per_bar';
      else if (this.usedIds.has(order.client_id)) reject = 'duplicate_client_id';
      else if (s === undefined) reject = 'not_in_universe';
      else if (written === 0n) reject = 'zero_amount';
      else if (this.seq < this.warm) reject = 'warmup';
      else if (isLast) reject = 'after_end';
      else if (s.close === null) reject = 'no_bar';
      else if (order.side === 'buy') {
        const cashLeft = this.cash - buys;
        const heldValue = this.value(s, s.qty, s.close);
        const bought = boughtBy.get(s.symbol) ?? 0n;
        if (clamp) {
          // The most the weight cap admits: (heldValue + bought + n) * 10000 <= max_weight_bps * equity.
          const room = (BigInt(caps.max_weight_bps) * equity) / BPS - heldValue - bought;
          const bound = min(cashLeft, room);
          if (amount > bound) amount = bound > 0n ? bound : 0n;
        }
        // Only a clamp cuts an amount to 0: refused for what bound it.
        if (amount === 0n) reject = cashLeft <= 0n ? 'insufficient_cash' : 'max_weight';
        else if (amount < this.minNotional) reject = 'below_min_notional';
        else if (amount > cashLeft) reject = 'insufficient_cash';
        else if (!open.has(s.symbol) && open.size >= caps.max_open_positions) reject = 'max_open_positions';
        else if ((heldValue + bought + amount) * BPS > BigInt(caps.max_weight_bps) * equity) reject = 'max_weight';
        if (reject === null) {
          buys += amount;
          boughtBy.set(s.symbol, bought + amount);
          open.add(s.symbol);
        }
      } else {
        const sold = soldBy.get(s.symbol) ?? 0n;
        const available = s.qty - sold;
        if (clamp && amount > available) amount = available > 0n ? available : 0n;
        if (amount === 0n || amount > available) reject = 'insufficient_position';
        else if (amount !== available && this.value(s, amount, s.close) < this.minNotional) reject = 'below_min_notional';
        if (reject === null) soldBy.set(s.symbol, sold + amount);
      }
      this.usedIds.add(order.client_id);
      this.pending.push({ order, seq: this.seq, index, decidedBar: t, fillBar: t + this.step, reject, amount, close: s?.close ?? null });
    });
  }

  // ---------------------------------------------------------------- resolving

  private base(p: Pending): BarsSimFill {
    return {
      client_id: p.order.client_id,
      symbol: p.order.symbol,
      side: p.order.side,
      status: 'rejected',
      reason: null,
      decided_bar: p.decidedBar,
      fill_bar: p.fillBar,
      price: '0',
      qty: '0',
      notional_quote_units: '0',
      fee_quote_units: '0',
      kind: 'order',
      seq: p.seq,
      index: p.index,
      rejected_at: null,
      position_before_qty: str(this.bySymbol.get(p.order.symbol)?.qty ?? 0n),
      cash_after_quote_units: str(this.cash),
    };
  }

  /** Record a resolution; `deliver` queues its protocol fill for the next batch. */
  private record(f: BarsSimFill, deliver: boolean): void {
    this.resolutions.push(f);
    if (!deliver) return;
    const { kind: _k, seq: _s, index: _i, rejected_at: _r, position_before_qty: _p, cash_after_quote_units: _c, ...fill } = f;
    this.undelivered.push(fill);
  }

  private recordReject(p: Pending, reason: BarsRejectReasonT, at: 'decision' | 'fill', deliver = true): void {
    const f = this.base(p);
    f.reason = reason;
    f.rejected_at = at;
    this.record(f, deliver);
  }

  /** One cash flow on a symbol: its PnL, its open round trip's, and its fees. */
  private flow(s: SymbolRt, cashDelta: bigint, fee: bigint): void {
    s.pnl += cashDelta;
    s.fees += fee;
    if (s.open !== null) s.open.pnl += cashDelta;
  }

  private closeRoundTrip(s: SymbolRt, bar: number): void {
    if (s.open === null) throw new SimAbortError(`${s.symbol} emptied with no open round trip`);
    this.roundTrips.push({ symbol: s.symbol, opened_bar: s.open.openedBar, closed_bar: bar, pnl_quote_units: str(s.open.pnl) });
    s.open = null;
  }

  /** Resolve one order at its fill bar's open; `pools` holds each symbol's pool at that open as the earlier fills left it. */
  private resolve(p: Pending, bar: BarsReplayBar | undefined, pools: Map<string, BarsPool>): void {
    if (p.reject !== null) return this.recordReject(p, p.reject, 'decision');
    if (bar === undefined) return this.recordReject(p, 'no_bar', 'fill');
    const s = this.bySymbol.get(p.order.symbol)!;
    const close = p.close!;
    const maxSlip = BigInt(p.order.max_slippage_bps);
    const bps = { fee_bps: this.feeBps, slippage_bps: this.slippageBps };
    const pool = pools.get(s.symbol) ?? BarsPool.of(bar.od, this.quoteScale);
    const before = s.qty;
    if (p.order.side === 'buy') {
      const fill = barsBuyFill(p.amount, bar.o, pool, bps, s.scales);
      if (fill.price * BPS > close * (BPS + maxSlip)) return this.recordReject(p, 'max_slippage', 'fill');
      if (fill.qty === 0n) return this.recordReject(p, 'zero_amount', 'fill');
      if (fill.spend + fill.fee !== p.amount) throw new SimAbortError(`buy ${p.order.client_id}: spend ${fill.spend} + fee ${fill.fee} != notional ${p.amount}`);
      pools.set(s.symbol, fill.after);
      this.cash -= p.amount;
      if (this.cash < 0n) throw new SimAbortError(`cash went negative (${this.cash}) after buy ${p.order.client_id}`);
      if (s.qty === 0n) s.open = { pnl: 0n, openedBar: bar.t };
      s.qty += fill.qty;
      s.cost += p.amount;
      s.trades++;
      this.flow(s, -p.amount, fill.fee);
      const f = this.base(p);
      Object.assign(f, {
        status: 'filled',
        price: str(fill.price),
        qty: str(fill.qty),
        notional_quote_units: str(p.amount),
        fee_quote_units: str(fill.fee),
        position_before_qty: str(before),
        cash_after_quote_units: str(this.cash),
      });
      return this.record(f, true);
    }
    const fill = barsSellFill(p.amount, bar.o, pool, bps, s.scales);
    if (fill.price * BPS < close * (BPS - maxSlip)) return this.recordReject(p, 'max_slippage', 'fill');
    if (p.amount > s.qty) throw new SimAbortError(`sell ${p.order.client_id} of ${p.amount} exceeds the ${s.qty} held`);
    pools.set(s.symbol, fill.after);
    this.cash += fill.proceeds;
    s.cost = (s.cost * (s.qty - p.amount)) / s.qty;
    s.qty -= p.amount;
    s.trades++;
    this.flow(s, fill.proceeds, fill.fee);
    if (s.qty === 0n) this.closeRoundTrip(s, bar.t);
    const f = this.base(p);
    Object.assign(f, {
      status: 'filled',
      price: str(fill.price),
      qty: str(p.amount),
      notional_quote_units: str(fill.proceeds),
      fee_quote_units: str(fill.fee),
      position_before_qty: str(before),
      cash_after_quote_units: str(this.cash),
    });
    this.record(f, true);
  }

  /** Close a whole position at the symbol's latest close with the sell model, against that close's depth (no max_slippage, no min notional). */
  private flatten(s: SymbolRt, lastBar: number): void {
    const qty = s.qty;
    const fill = barsSellFill(qty, s.close!, s.closeDepth, { fee_bps: this.feeBps, slippage_bps: this.slippageBps }, s.scales);
    this.cash += fill.proceeds;
    s.qty = 0n;
    s.cost = 0n;
    this.flow(s, fill.proceeds, fill.fee);
    this.closeRoundTrip(s, lastBar);
    this.record(
      {
        client_id: `_flatten_${this.closeCounter++}`,
        symbol: s.symbol,
        side: 'sell',
        status: 'filled',
        reason: null,
        decided_bar: lastBar,
        fill_bar: lastBar,
        price: str(fill.price),
        qty: str(qty),
        notional_quote_units: str(fill.proceeds),
        fee_quote_units: str(fill.fee),
        kind: 'flatten',
        seq: null,
        index: null,
        rejected_at: null,
        position_before_qty: str(qty),
        cash_after_quote_units: str(this.cash),
      },
      false,
    );
  }

  /** End-of-run identities: per-symbol PnL adds up to the cash change, nothing is held, cash is not negative. */
  private checkTotals(): void {
    if (this.cash < 0n) throw new SimAbortError(`cash ended negative (${this.cash})`);
    let pnl = 0n;
    for (const s of this.syms) {
      pnl += s.pnl;
      if (s.qty !== 0n || s.open !== null) throw new SimAbortError(`${s.symbol} is still held after flattening`);
    }
    if (pnl !== this.cash - this.startCash) throw new SimAbortError(`per-symbol PnL ${pnl} != cash change ${this.cash - this.startCash}`);
  }
}

/** A bot the replay can drive: replies may be sync or async. */
export interface BarsBotDriver {
  hello?(msg: BarsHelloT): void | Promise<void>;
  batch(msg: BarsBatchT): unknown;
  done?(msg: BarsDoneT): void | Promise<void>;
}

/** Drive a bot through the whole replay in lockstep. */
export async function runBarsBot(dataset: BarsDataset, hello: BarsHelloT, bot: BarsBotDriver, opts?: BarsEngineOptions): Promise<BarsRun> {
  const engine = new BarsEngine(dataset, hello, opts);
  await bot.hello?.(engine.hello);
  for (let b = engine.nextBatch(); b !== null; b = engine.nextBatch()) engine.submit(await bot.batch(b));
  const { done, run } = engine.finish();
  await bot.done?.(done);
  return run;
}

/** Re-run a stored action log (L1 regrade, cost sensitivity): the same dataset and replies give the same run. */
export function replayBarsActionLog(dataset: BarsDataset, log: BarsActionLogT, opts?: BarsEngineOptions): BarsRun {
  const parsed = BarsActionLog.parse(log);
  if (parsed.dataset_sha256 !== dataset.sha256) throw new SimDataError(`action log is for dataset ${parsed.dataset_sha256}, not ${dataset.sha256}`);
  const engine = new BarsEngine(dataset, parsed.hello, opts);
  let i = 0;
  for (let b = engine.nextBatch(); b !== null; b = engine.nextBatch(), i++) {
    const reply = parsed.replies[i];
    if (reply === undefined) throw new SimProtocolError(`action log ends before batch ${b.seq}`);
    engine.submit(reply);
  }
  const { run } = engine.finish();
  if (run.aborted === null && i !== parsed.replies.length) throw new SimProtocolError(`action log has ${parsed.replies.length} replies for ${i} batches`);
  return run;
}
