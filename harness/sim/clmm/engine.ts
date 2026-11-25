// The clmm replay (agent-fun/clmm-replay/v1, contracts/clmm-protocol.ts): a deterministic, causal
// replay of one frozen concentrated-liquidity pool window (contracts/clmm-dataset.ts) against one bot,
// in lockstep, one batch per hour. The bot manages one liquidity position in the pool.
//
//   const engine = new ClmmEngine(dataset, hello);
//   send(engine.hello);
//   for (let batch; (batch = engine.nextBatch()); ) { send(batch); engine.submit(await readReply()); }
//   const { done, run } = engine.finish(); send(done);
//
// ClmmEngine is a LockstepEngine (sim/bars/engine.ts), so grader/run.ts executeLockstep drives it as it
// is, over CLMM_LOCKSTEP, this protocol's line codec. That driver counts a reply's `orders` against
// the cap, so the codec hands the engine each parsed reply in an envelope that carries its actions
// under that key too (ClmmLockstepReply); submit() takes the envelope or a bare reply.
//
// The market model is the protocol header's (contracts/clmm-protocol.ts, "Market model"). This file
// implements it and adds only what the header leaves to the sim:
//   - Hours. Hour k of the window holds the rows with ts in [start_ms + k h, start_ms + (k + 1) h),
//     collector/bars/bars.ts's bucketing, and its bar is the dataset line closing at its end. The
//     replay reads both, so a dataset whose bars and rows disagree is refused (SimDataError): a bar
//     without rows or rows without a bar, or a bar whose samples, first and last slot, h and l, o and
//     c (barsMedian over its reference windows) or reference states (clmmReferenceRow) are not its
//     rows'. Its open window ends at its first row's ts + BARS_REFERENCE_MS (open_end_ms).
//   - One batch, in order: (a) the hour's sample intervals that start before its open window ends
//     (r0.ts < open_end_ms) accrue to the position held then; (b) the previous batch's actions apply
//     at the open, in reply order; (c) the hour's other intervals accrue to the position held after
//     them; (d) the bar closes. An interval belongs to the hour of its later row r1, so a batch never
//     credits a row from after its t. A position therefore earns from the first interval whose r0.ts
//     is at or after the open window's end of the bar it was minted at, and through the last one whose
//     r0.ts is before the open window's end of the bar it is withdrawn at (the close-out: through the
//     window's last row), as the header says.
//   - Fees. Over an interval (r0, r1), per token: floor(feeGrowthDelta(r0, r1) x L_pos x L_pool /
//     ((L_pool + L_pos) x 2^64)) (sim/clmm/position.ts feeCredit) with L_pool r0's liquidity, the
//     header's rule. It is credited when r1.ts - r0.ts <= CLMM_MAX_FEE_INTERVAL_MS and the range holds
//     both ticks. Credits accrue to fees_owed and are collected into idle when the position is
//     withdrawn.
//   - Sizing a set_range's swap. At the open's reference sqrt price s, clamped into the range's
//     [sL, sU] as c, a token's capacity is the liquidity it alone buys: A's a x sU x c / ((sU - c) x
//     2^64), B's b x 2^64 / (c - sL). The token of the smaller capacity is short; the two compare
//     exactly by cross-multiplying, a x (c - sL) x sU x c against b x (sU - c) x 2^128. The asset short:
//     a buy of the asset with USDC. USDC short: a sale of the asset. A tie: no swap. The swap's size
//     is the largest amount (a buy's USDC notional, a sale's quantity) after whose fill (barsBuyFill or
//     barsSellFill at the open o, on the open's pool as the earlier swaps left it) the token that was
//     short still is, or ties, found by bisection; or one unit more when that mints more liquidity.
//     Past it the other token is short and the mint shrinks, so that is the swap that mints the
//     most, to within the price scale's resolution: a fill's price truncates, so its quantity grows
//     with its notional only to within that (a few parts per million of the liquidity for SOL at
//     price scale 6). A one-sided range (the price at or past an edge) swaps all of the token it does
//     not hold.
//     A swap under fees.min_notional_quote_units at o, or a buy whose quantity truncates to 0, is not
//     made (the header).
//   - Minting and withdrawing (sim/clmm/position.ts). The mint is liquidityForAmounts of the idle
//     tokens at the open's reference sqrt price, and takes amountsForLiquidity rounded up, so idle
//     never goes below 0. A withdrawal returns amountsForLiquidity rounded down at the open's
//     reference sqrt price (the close-out: the latest close's), plus the fees owed.
//   - A rejected set_range or withdraw leaves the account, the position and the open's pool exactly as
//     it found them: its withdrawal, swap and mint are drafted, and kept only when all pass.
//   - The marks (ClmmMark, one per batch, plus the start and the end) carry what the scorer
//     (sim/clmm/metrics.ts) needs: the asset and USDC held all three ways at each close, the equity,
//     the hour's fee credits per token, and the in-range accounting. Each of the hour's intervals
//     counts in `intervals`. One whose range holds both ticks, of a position live over it, counts in
//     `in_range_intervals` and adds floor(10^9 x the position's value / the equity) to
//     `in_range_share_9_sum`, both valued at r0's sqrt price (position.ts amountsValue): the position's
//     liquidity's tokens, against them plus idle plus its fees owed. The 30 s rule bounds fee credits,
//     not this count.
//   - Cost sensitivity (ClmmEngineOptions.feeMultiplier): fees.fee_bps multiplied, capped at 10000, on
//     every swap, the close-out's included. The LP fees credited are unchanged. An action carries no
//     amount (the engine sizes every swap against the account it finds), so no order needs a clamp.
//   - A dataset whose open or close would truncate to a sale price of 0 under the hello's
//     slippage_bps is refused (SimDataError), as bars-replay/v1 refuses one.
//   - Books: every change to idle is checked never to go below 0. At the end, per token, the swaps,
//     mints, withdrawals and collected fees add up to the idle change; every fee credited was
//     collected; no position and no asset are left. A broken invariant aborts the replay
//     (SimAbortError, never scored).
//   - no_future_bars is the verdict of a causality audit (ClmmLookaheadAudit) that reads the batches
//     as they are sent, the replies as they are taken, and the dataset itself, never the engine's
//     bookkeeping. A batch sent out of lockstep or off its hour, a bar that is not the dataset's hour
//     closing at the batch's t (fee growth delta included), a result resolved at or before the bar it
//     was decided on, or a position or equity marked at a close the bot has not been sent turns it
//     false. The batch is withheld, and the run aborts there (run.aborted names the first finding):
//     the engine's fault, never the bot's, which grading refuses as a harness fault (grader/run.ts).
//
// Everything is BigInt and deterministic: the same (dataset, hello, replies, options) give
// byte-identical batches, resolutions and runs, which is what lets an action log be rescored
// (replayClmmActionLog). The action log is sim/engine.ts's agent-fun/action-log/v1 envelope with this
// protocol: {format, protocol, dataset_sha256, hello, replies}. The last batch's after_end rejections
// and the close-out are in the run (resolutions, close_out), which a replay of the log re-derives.

import { z } from 'zod';
import { BARS_REFERENCE_MS, barsMedian } from '../../contracts/bars-dataset.ts';
import { USDC_DECIMALS } from '../../contracts/bars-protocol.ts';
import { ClmmDatasetLine, ClmmDatasetPool, clmmPoolMismatch, clmmReferenceRow, clmmReferenceWindows, type ClmmDatasetLineT, type ClmmDatasetPoolT, type ClmmRowT } from '../../contracts/clmm-dataset.ts';
import {
  CLMM_BAR_MS,
  CLMM_MAX_FEE_INTERVAL_MS,
  CLMM_MAX_TICK,
  CLMM_MIN_TICK,
  CLMM_PROTOCOL,
  ClmmBatch,
  ClmmDone,
  ClmmHello,
  clmmInRange,
  clmmQuoteIndex,
  clmmRangeRejection,
  ClmmReply,
  clmmReplyActionCap,
  parseClmmBotLine,
  type ClmmAccountT,
  type ClmmActionResultT,
  type ClmmActionT,
  type ClmmBarT,
  type ClmmBatchT,
  type ClmmDoneT,
  type ClmmHelloT,
  type ClmmPositionT,
  type ClmmRejectReasonT,
  type ClmmReplyT,
  type ClmmSwapT,
} from '../../contracts/clmm-protocol.ts';
import { Sha256Hex } from '../../contracts/primitives.ts';
import { MAX_HARNESS_LINE_BYTES } from '../../contracts/protocol.ts';
import { barsBuyFill, BarsPool, barsSellFill, barsValue, BPS, type BarsFillBps, type BarsScales, type LockstepEngine } from '../bars/engine.ts';
import { canonicalJson } from '../canonical.ts';
import { ACTION_LOG_FORMAT, SimAbortError, SimDataError, SimProtocolError } from '../engine.ts';
import { amountDeltaA, amountDeltaB, amountsForLiquidity, amountsValue, feeCredit, feeGrowthDelta, liquidityForAmounts, MAX_SQRT_PRICE_X64, MIN_SQRT_PRICE_X64, sqrtPriceAtTick, type QuoteSide, type TickRange } from './position.ts';

export { SimAbortError, SimDataError, SimProtocolError };

const H = CLMM_BAR_MS;
const Q128 = 1n << 128n;
/** A share's scale: Fixed9. */
const SHARE_SCALE = 1_000_000_000n;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const U128_RE = /^(0|[1-9][0-9]{0,38})$/;
/** The most lookaheads a run keeps (run.lookahead). */
export const MAX_CLMM_LOOKAHEAD_ISSUES = 20;

type Pair = [bigint, bigint];
const str = (n: bigint) => n.toString();
const pairStr = (p: readonly [bigint, bigint]): [string, string] => [str(p[0]), str(p[1])];
const zodIssue = (error: z.ZodError) => {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid';
};

/** What the bot did: every reply, in batch order, with what it answered (hello and dataset digest). */
export const ClmmActionLog = z.strictObject({
  format: z.literal(ACTION_LOG_FORMAT),
  protocol: z.literal(CLMM_PROTOCOL),
  dataset_sha256: Sha256Hex,
  hello: ClmmHello,
  replies: z.array(ClmmReply),
});
export type ClmmActionLogT = z.infer<typeof ClmmActionLog>;

/** A frozen clmm dataset as the replay reads it: the manifest's facts, the bars file's lines and every rows file's rows. */
export interface ClmmDataset {
  /**
   * The digest the run, its action log and its contamination certificate name. The grader names a
   * frozen window by its manifest's RFC 8785 canonical sha256, the dataset row's (grader/dataset.ts
   * readFrozenClmmDataset), which commits to the manifest's dataset_sha256 and so to every bar and row.
   */
  sha256: string;
  /** The manifest's pool: the harness's must be it (clmmPoolMismatch), its price_scale the hello's. */
  pool: ClmmDatasetPoolT;
  window: { start_ms: number; end_ms: number; hours: number };
  /** The bars file's lines, t strictly ascending. */
  bars: readonly ClmmDatasetLineT[];
  /** Every rows file's rows in rows[] order: ts strictly ascending, all within the window. */
  rows: readonly ClmmRowT[];
}

export interface ClmmEngineOptions {
  /** fees.fee_bps multiplied by this, capped at 10000 (cost sensitivity); the LP fees credited are unchanged. Default 1. */
  feeMultiplier?: number;
}

/** A position's withdrawal: its range and liquidity, the tokens its liquidity returned, and the fees it had owed, [a, b]. */
export interface ClmmWithdrawal {
  lower_tick: number;
  upper_tick: number;
  liquidity: string;
  amounts: [string, string];
  fees: [string, string];
}

/** One action's resolution: the protocol result plus what the sim knows about it. */
export interface ClmmResolution extends ClmmActionResultT {
  /** The batch seq and the action's index in its reply. */
  seq: number;
  index: number;
  /** Where a rejection happened: when decided, or at the open it would have applied at. Null when applied. */
  rejected_at: 'decision' | 'open' | null;
  /** The price its swap filled from (the open o); null without a swap. */
  reference_price: string | null;
  /** The position it withdrew, if any. */
  withdrawn: ClmmWithdrawal | null;
  /** The position it minted (a set_range's): its liquidity and the tokens the mint took, [a, b]. */
  minted: { liquidity: string; amounts: [string, string] } | null;
  /** The idle tokens after it, [a, b]. */
  idle_after: [string, string];
}

/** The end of the replay: the position withdrawn at the latest close's sqrt price, and the asset sold at the latest close c against its c_depth. */
export interface ClmmCloseOut {
  /** The last batch's t. */
  t: number;
  /** t of the latest close it used; null when no bar ever closed. */
  close_t: number | null;
  /** The price the sale filled from (the latest close c); null without a sale. */
  reference_price: string | null;
  withdrawn: ClmmWithdrawal | null;
  swap: ClmmSwapT | null;
  idle_after: [string, string];
}

/** One position's life. */
export interface ClmmPositionSpan {
  lower_tick: number;
  upper_tick: number;
  liquidity: string;
  /** t of the bar whose open minted it. */
  minted_t: number;
  /** It earns from the first interval whose r0.ts is at or after this: that bar's open window's end. */
  live_from_ms: number;
  /** t of the bar whose open withdrew it; null when the close-out did (or the run aborted first). */
  withdrawn_t: number | null;
  /** It earns through the last interval whose r0.ts is before this; null: through the window's last row. */
  live_until_ms: number | null;
  /** The tokens the mint took, and the tokens its withdrawal returned (fees apart), [a, b]. */
  minted_amounts: [string, string];
  withdrawn_amounts: [string, string];
  /** The fees credited to it, all collected at its withdrawal, [a, b]. */
  fees: [string, string];
}

/** The account at one close (see the header's marks). */
export interface ClmmMark {
  /** The batch seq it follows: -1 for the start, `batches` for after the close-out. */
  seq: number;
  /** The start's is window.start_ms; a batch's its t; the end's the last batch's t. */
  t: number;
  /** The latest close c at this point (null before any bar has closed). */
  close: string | null;
  /** The asset and USDC held: idle, in the position (at the latest close's sqrt price, rounded down) and in its fees owed. */
  asset_units: string;
  quote_units: string;
  /** quote_units + value(asset_units, close): the protocol's equity. */
  equity_quote_units: string;
  /** The fees credited over this batch's hour to the bot's positions, [a, b]. */
  fees_credited: [string, string];
  /** The window's sample intervals that ended in this hour. */
  intervals: number;
  /** Of them, those a live position's range held both ticks of. */
  in_range_intervals: number;
  /** Over those, the sum of floor(10^9 x the position's value / the equity) at r0's sqrt price. */
  in_range_share_9_sum: string;
}

export interface ClmmRun {
  protocol: typeof CLMM_PROTOCOL;
  dataset_sha256: string;
  fee_multiplier: number;
  hello: ClmmHelloT;
  action_log: ClmmActionLogT;
  /** Batches delivered. */
  batches: number;
  window: { start_ms: number; end_ms: number; hours: number };
  /** Every action, in decision order, the last batch's (never delivered) included. */
  resolutions: ClmmResolution[];
  /** Every position minted, in order. */
  positions: ClmmPositionSpan[];
  /** Null only on an aborted run. */
  close_out: ClmmCloseOut | null;
  marks: ClmmMark[];
  final_account: ClmmAccountT;
  start_quote_units: string;
  /** The causality audit found nothing the bot was sent ahead of its time (ClmmLookaheadAudit); false only with aborted set. */
  no_future_bars: boolean;
  /** What it found, in order (the first MAX_CLMM_LOOKAHEAD_ISSUES); empty exactly when no_future_bars. */
  lookahead: string[];
  /** Null unless an invariant failed; then the run must not be scored. */
  aborted: string | null;
}

/** One hour of the replay that holds rows: its bar as integers and the wire form the bot is sent. */
export interface ClmmReplayHour {
  /** Its index in the window, and its close time. */
  k: number;
  t: number;
  /** Its rows: [from, to) of the window's rows. */
  from: number;
  to: number;
  /** Its first row's ts + BARS_REFERENCE_MS: the end of its open window. */
  open_end_ms: number;
  o: bigint;
  c: bigint;
  o_sqrt: bigint;
  c_sqrt: bigint;
  c_tick: number;
  /** The depth an open's swaps meet, and the close-out's sale at c. */
  od: readonly bigint[];
  cd: readonly bigint[];
  wire: ClmmBarT;
}

interface Row {
  ts: number;
  tick: number;
  sqrt: bigint;
  liquidity: bigint;
  fg: readonly [bigint, bigint];
}

interface Held {
  range: TickRange;
  L: bigint;
  sL: bigint;
  sU: bigint;
  owed: Pair;
  /** The part of owed credited over the current batch's hour. */
  hour: Pair;
  liveFrom: number;
  span: ClmmPositionSpan;
}

interface Pending {
  action: ClmmActionT;
  seq: number;
  index: number;
  decidedT: number;
  appliedT: number;
  reject: ClmmRejectReasonT | null;
  /** The latest close when decided (max_slippage's reference); null when there was none. */
  close: bigint | null;
}

interface HourStats {
  credited: Pair;
  intervals: number;
  inRange: number;
  share9: bigint;
}

interface Withdrawn {
  held: Held;
  amounts: Pair;
  fees: Pair;
}

type Sized = { side: 'buy'; amount: bigint; qty: bigint; price: bigint; fee: bigint; after: BarsPool } | { side: 'sell'; amount: bigint; proceeds: bigint; price: bigint; fee: bigint; after: BarsPool };

/** One protocol message as the line the harness writes; refuses lines over MAX_HARNESS_LINE_BYTES. */
export function encodeClmmHarnessLine(msg: ClmmHelloT | ClmmBatchT | ClmmDoneT): string {
  const line = JSON.stringify(msg);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_HARNESS_LINE_BYTES) throw new SimDataError(`${msg.type} line is ${bytes} bytes (max ${MAX_HARNESS_LINE_BYTES})`);
  return `${line}\n`;
}

/** A reply as CLMM_LOCKSTEP hands it over: its actions also under `orders`, the key grader/run.ts executeLockstep counts against the cap. */
export interface ClmmLockstepReply {
  orders: readonly ClmmActionT[];
  reply: ClmmReplyT;
}

/**
 * The clmm replay's line codec, in the shape of grader/run.ts LockstepProtocol (hello, batch, done,
 * ClmmLockstepReply), so executeLockstep({ engine: new ClmmEngine(...), protocol: CLMM_LOCKSTEP })
 * runs the replay with no edit to the driver.
 */
export const CLMM_LOCKSTEP: {
  encode(msg: ClmmHelloT | ClmmBatchT | ClmmDoneT): string;
  parseLine(line: string): { ok: true; reply: ClmmLockstepReply } | { ok: false; reason: string };
  replyOrderCap(hello: ClmmHelloT): number;
} = {
  encode: encodeClmmHarnessLine,
  parseLine(line) {
    const parsed = parseClmmBotLine(line);
    return parsed.ok ? { ok: true, reply: { orders: parsed.reply.actions, reply: parsed.reply } } : parsed;
  },
  replyOrderCap: (hello) => clmmReplyActionCap(hello),
};

const isLockstepReply = (r: unknown): r is ClmmLockstepReply => {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return false;
  const keys = Object.keys(r).sort();
  return keys.length === 2 && keys[0] === 'orders' && keys[1] === 'reply';
};

/** The tokens a liquidity holds in [sL, sU) at a sqrt price, rounded down: position.ts amountsForLiquidity with the range's sqrt prices known. */
function heldAmounts(p: Pick<Held, 'L' | 'sL' | 'sU'>, s: bigint): Pair {
  const c = s < p.sL ? p.sL : s > p.sU ? p.sU : s;
  return [amountDeltaA(c, p.sU, p.L, false), amountDeltaB(p.sL, c, p.L, false)];
}

function parseRows(raw: readonly ClmmRowT[], w: { start_ms: number; end_ms: number }): Row[] {
  const u128 = (v: unknown, at: string): bigint => {
    if (typeof v !== 'string' || !U128_RE.test(v) || BigInt(v) >= Q128) throw new SimDataError(`${at} ${JSON.stringify(v)} is not a u128 decimal`);
    return BigInt(v);
  };
  let prev = -1;
  return raw.map((r, i) => {
    const at = `row ${i} (ts ${String(r.ts)})`;
    if (!Number.isSafeInteger(r.ts) || r.ts < w.start_ms || r.ts >= w.end_ms) throw new SimDataError(`${at}: ts is not in the window [${w.start_ms}, ${w.end_ms})`);
    if (r.ts <= prev) throw new SimDataError(`${at}: ts does not follow ${prev}: rows are strictly ascending`);
    prev = r.ts;
    if (!Number.isSafeInteger(r.slot) || r.slot < 0) throw new SimDataError(`${at}: slot ${String(r.slot)} is not a slot`);
    if (typeof r.price !== 'string' || !U64_RE.test(r.price) || BigInt(r.price) < 1n) throw new SimDataError(`${at}: price ${JSON.stringify(r.price)} is not a u64 decimal above 0`);
    if (!Number.isSafeInteger(r.tick) || r.tick < CLMM_MIN_TICK || r.tick > CLMM_MAX_TICK) throw new SimDataError(`${at}: tick ${String(r.tick)} is outside [${CLMM_MIN_TICK}, ${CLMM_MAX_TICK}]`);
    const sqrt = u128(r.sqrt_price_x64, `${at}: sqrt_price_x64`);
    if (sqrt < MIN_SQRT_PRICE_X64 || sqrt > MAX_SQRT_PRICE_X64) throw new SimDataError(`${at}: sqrt_price_x64 ${sqrt} is outside [${MIN_SQRT_PRICE_X64}, ${MAX_SQRT_PRICE_X64}]`);
    if (!Array.isArray(r.fee_growth) || r.fee_growth.length !== 2) throw new SimDataError(`${at}: fee_growth is not a pair`);
    return { ts: r.ts, tick: r.tick, sqrt, liquidity: u128(r.liquidity, `${at}: liquidity`), fg: [u128(r.fee_growth[0], `${at}: fee_growth[0]`), u128(r.fee_growth[1], `${at}: fee_growth[1]`)] };
  });
}

/** Refuse a bar its rows do not give (see the header's hours). */
function checkBarRows(line: ClmmDatasetLineT, rows: readonly ClmmRowT[]): void {
  const at = `bar t=${line.t}`;
  const first = rows[0]!;
  const last = rows.at(-1)!;
  if (rows.length !== line.samples) throw new SimDataError(`${at}: ${line.samples} samples, but its hour holds ${rows.length} rows`);
  if (first.slot !== line.first_slot || last.slot !== line.last_slot) throw new SimDataError(`${at}: slots ${line.first_slot}..${line.last_slot}, its rows' ${first.slot}..${last.slot}`);
  let hi = BigInt(first.price);
  let lo = hi;
  for (const r of rows) {
    const p = BigInt(r.price);
    if (p > hi) hi = p;
    if (p < lo) lo = p;
  }
  if (str(hi) !== line.h || str(lo) !== line.l) throw new SimDataError(`${at}: h ${line.h} and l ${line.l}, its rows' extremes ${hi} and ${lo}`);
  const { open, close } = clmmReferenceWindows(rows);
  const o = barsMedian(open.map((r) => BigInt(r.price)));
  const c = barsMedian(close.map((r) => BigInt(r.price)));
  if (str(o) !== line.o || str(c) !== line.c) throw new SimDataError(`${at}: o ${line.o} and c ${line.c}, its rows' reference medians ${o} and ${c}`);
  for (const [k, ref] of [
    ['o', clmmReferenceRow(open)],
    ['c', clmmReferenceRow(close)],
  ] as const) {
    const tick = k === 'o' ? line.o_tick : line.c_tick;
    const sqrt = k === 'o' ? line.o_sqrt_price_x64 : line.c_sqrt_price_x64;
    const liquidity = k === 'o' ? line.o_liquidity : line.c_liquidity;
    if (ref.tick !== tick || ref.sqrt_price_x64 !== sqrt || ref.liquidity !== liquidity) {
      throw new SimDataError(`${at}: its ${k}_ state (tick ${tick}, sqrt ${sqrt}, liquidity ${liquidity}) is not its reference row's (ts ${ref.ts}: tick ${ref.tick}, sqrt ${ref.sqrt_price_x64}, liquidity ${ref.liquidity})`);
    }
  }
}

/**
 * The causality audit behind a run's no_future_bars. It reads only what crosses the wire, each batch
 * as it is sent and each reply as it is taken, and the dataset itself (its bars by t, its rows' fee
 * growth), never the engine's bookkeeping, so a lookahead anywhere upstream of the wire shows here:
 *   - a batch sent before the bot replied to the one before, or not on its hour's close;
 *   - a bar that is not the dataset's hour closing at the batch's t, its fee growth delta (from the
 *     last row before the hour to the hour's last row) included: bar k + 1 handed over on batch k;
 *   - a result resolved after the batch carrying it, at or before the bar it was decided on, or
 *     decided on a batch the bot has not answered;
 *   - a position whose amounts are not its liquidity's at the latest close's sqrt price the bot has
 *     been sent, or whose in_range is not that close's tick's; an account whose equity is not its
 *     tokens marked at that close: a mark at a close the bot has not seen.
 * Each violation is kept, in order (the first MAX_CLMM_LOOKAHEAD_ISSUES); ok is no_future_bars. The
 * engine withholds a batch the audit flags and aborts the run (the header).
 */
export class ClmmLookaheadAudit {
  private readonly firstClose: number;
  private readonly scales: BarsScales;
  private readonly q: 0 | 1;
  private readonly x: 0 | 1;
  private readonly lines = new Map<number, ClmmDatasetLineT>();
  private readonly rows: readonly ClmmRowT[];
  /** The latest close the bot has been sent. */
  private latest: { c: bigint; sqrt: bigint; tick: number } | null = null;
  private sent = 0;
  private answered = 0;
  private flagged = 0;
  readonly issues: string[] = [];

  constructor(hello: ClmmHelloT, dataset: Pick<ClmmDataset, 'bars' | 'rows'>) {
    this.firstClose = hello.first_close_ms;
    this.scales = { quote_scale: USDC_DECIMALS, price_scale: hello.price_scale, qty_scale: hello.pool.decimals };
    this.q = clmmQuoteIndex(hello.pool);
    this.x = this.q === 0 ? 1 : 0;
    for (const b of dataset.bars) this.lines.set(b.t, b);
    this.rows = dataset.rows;
  }

  /** Nothing was found. */
  get ok(): boolean {
    return this.flagged === 0;
  }

  private flag(issue: string): void {
    this.flagged++;
    if (this.issues.length < MAX_CLMM_LOOKAHEAD_ISSUES) this.issues.push(issue);
  }

  /** The index of the first row at or after ts. */
  private rowAt(ts: number): number {
    let lo = 0;
    let hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rows[mid]!.ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The bar the dataset closes at t, as the wire carries it; null for an hour without a bar or rows. */
  private expectedBar(t: number): ClmmBarT | null {
    const line = this.lines.get(t);
    const from = this.rowAt(t - H);
    const to = this.rowAt(t);
    if (line === undefined || from === to) return null;
    const prev = this.rows[from > 0 ? from - 1 : from]!;
    const last = this.rows[to - 1]!;
    const delta = (j: 0 | 1) => str(feeGrowthDelta(BigInt(prev.fee_growth[j]), BigInt(last.fee_growth[j])));
    return {
      o: line.o,
      h: line.h,
      l: line.l,
      c: line.c,
      o_tick: line.o_tick,
      c_tick: line.c_tick,
      o_sqrt_price_x64: line.o_sqrt_price_x64,
      c_sqrt_price_x64: line.c_sqrt_price_x64,
      o_liquidity: line.o_liquidity,
      c_liquidity: line.c_liquidity,
      o_depth: [...line.o_depth],
      c_depth: [...line.c_depth],
      fee_growth_delta_x64: [delta(0), delta(1)],
    };
  }

  /** A batch, as it is about to be sent. */
  batch(b: ClmmBatchT): void {
    const at = `batch ${b.seq} (t ${b.t})`;
    if (this.answered < this.sent) this.flag(`${at} was sent before the reply to batch ${this.sent - 1}`);
    const due = this.firstClose + this.sent * H;
    if (b.seq !== this.sent || b.t !== due) this.flag(`${at} came where batch ${this.sent} (t ${due}) was due`);
    if (b.bar !== null) {
      const want = this.expectedBar(b.t);
      if (want === null || canonicalJson(want) !== canonicalJson(b.bar)) this.flag(`${at} carries a bar that is not the dataset's hour closing at its t`);
    }
    const lastAnswered = this.answered === 0 ? null : this.firstClose + (this.answered - 1) * H;
    b.results.forEach((r, i) => {
      if (r.applied_t > b.t) this.flag(`${at} carries result ${i} resolved at ${r.applied_t}, after its own t`);
      if (r.applied_t <= r.decided_t) this.flag(`${at} carries result ${i} resolved at ${r.applied_t}, not after the bar ${r.decided_t} it was decided on`);
      if (lastAnswered === null || r.decided_t > lastAnswered) this.flag(`${at} carries result ${i} decided on bar ${r.decided_t}, which the bot has not answered`);
    });
    if (b.bar !== null) this.latest = { c: BigInt(b.bar.c), sqrt: BigInt(b.bar.c_sqrt_price_x64), tick: b.bar.c_tick };
    let asset = BigInt(b.account.idle[this.x]);
    let quote = BigInt(b.account.idle[this.q]);
    const p = b.position;
    if (p !== null) {
      const lc = this.latest;
      if (lc === null) this.flag(`${at} holds a position before any close the bot was sent`);
      else {
        const amt = amountsForLiquidity(BigInt(p.liquidity), lc.sqrt, { lower: p.lower_tick, upper: p.upper_tick }, false);
        if (str(amt.a) !== p.amounts[0] || str(amt.b) !== p.amounts[1]) this.flag(`${at}'s position amounts are not its liquidity's at the latest close the bot was sent`);
        if (p.in_range !== clmmInRange(p, lc.tick)) this.flag(`${at}'s position in_range is not the latest close's tick ${lc.tick} it was sent`);
      }
      asset += BigInt(p.amounts[this.x]) + BigInt(p.fees_owed[this.x]);
      quote += BigInt(p.amounts[this.q]) + BigInt(p.fees_owed[this.q]);
    }
    if (asset > 0n && this.latest === null) this.flag(`${at} holds the asset before any close the bot was sent`);
    else {
      const equity = asset === 0n ? quote : quote + barsValue(asset, this.latest!.c, this.scales);
      if (equity !== BigInt(b.account.equity_quote_units)) this.flag(`${at}'s equity ${b.account.equity_quote_units} is not its tokens at the latest close the bot was sent (${equity})`);
    }
    this.sent++;
  }

  /** The bot's reply to the batch last sent, as it is taken. */
  reply(seq: number): void {
    if (seq !== this.sent - 1 || this.answered !== this.sent - 1) this.flag(`a reply to batch ${seq} was taken while batch ${this.sent - 1} was the one waiting`);
    else this.answered++;
  }
}

export class ClmmEngine implements LockstepEngine<ClmmHelloT, ClmmBatchT, ClmmDoneT, ClmmRun> {
  readonly hello: ClmmHelloT;
  private readonly datasetSha: string;
  private readonly window: { start_ms: number; end_ms: number; hours: number };
  private readonly firstClose: number;
  private readonly batchCount: number;
  private readonly multNum: number;
  private readonly bps: BarsFillBps;
  private readonly minNotional: bigint;
  private readonly scales: BarsScales;
  /** The pool's USDC side and asset side in an [a, b] pair, and the token a value is expressed in. */
  private readonly q: 0 | 1;
  private readonly x: 0 | 1;
  private readonly side: QuoteSide;
  private readonly rows: Row[];
  /** By hour index: null for an hour with no row. */
  private readonly hours: (ClmmReplayHour | null)[];
  private readonly audit: ClmmLookaheadAudit;

  private phase: 'ready' | 'awaiting_reply' | 'finished' = 'ready';
  private seq = 0;
  private aborted: string | null = null;
  private idle: Pair;
  private readonly startIdle: Pair;
  private held: Held | null = null;
  /** The latest hour that closed with a bar, as of the current batch. */
  private latest: ClmmReplayHour | null = null;
  private pending: Pending[] = [];
  private undelivered: ClmmActionResultT[] = [];
  private readonly resolutions: ClmmResolution[] = [];
  private readonly spans: ClmmPositionSpan[] = [];
  private readonly marks: ClmmMark[] = [];
  private readonly replies: ClmmReplyT[] = [];
  private closeOut: ClmmCloseOut | null = null;
  /** Per token: received from swaps, paid into swaps, taken by mints, returned by withdrawals, fees collected, fees credited. */
  private readonly books = { swapIn: [0n, 0n] as Pair, swapOut: [0n, 0n] as Pair, minted: [0n, 0n] as Pair, withdrawn: [0n, 0n] as Pair, collected: [0n, 0n] as Pair, credited: [0n, 0n] as Pair };

  constructor(dataset: ClmmDataset, hello: ClmmHelloT, opts: ClmmEngineOptions = {}) {
    const hp = ClmmHello.safeParse(hello);
    if (!hp.success) throw new SimDataError(`hello: ${zodIssue(hp.error)}`);
    this.hello = hp.data;
    const h = this.hello;
    if (!Sha256Hex.safeParse(dataset.sha256).success) throw new SimDataError(`dataset sha256 ${JSON.stringify(dataset.sha256)} is not a lowercase hex sha256`);
    this.datasetSha = dataset.sha256;
    const m = opts.feeMultiplier ?? 1;
    if (!Number.isInteger(m) || m < 1) throw new RangeError(`feeMultiplier must be a positive integer, got ${m}`);
    this.multNum = m;
    const fee = BigInt(h.fees.fee_bps) * BigInt(m);
    this.bps = { fee_bps: fee > BPS ? BPS : fee, slippage_bps: BigInt(h.fees.slippage_bps) };
    this.minNotional = BigInt(h.fees.min_notional_quote_units);

    // The pool: the hello's is the dataset's, at the dataset's price scale.
    const pp = ClmmDatasetPool.safeParse(dataset.pool);
    if (!pp.success) throw new SimDataError(`dataset pool: ${zodIssue(pp.error)}`);
    const pool = pp.data;
    const mismatch = clmmPoolMismatch(h.pool, pool);
    if (mismatch !== null) throw new SimDataError(mismatch);
    if (pool.price_scale !== h.price_scale) throw new SimDataError(`the dataset's price_scale is ${pool.price_scale}, the hello's ${h.price_scale}`);
    this.q = clmmQuoteIndex(h.pool);
    this.x = this.q === 0 ? 1 : 0;
    this.side = this.q === 0 ? 'a' : 'b';
    this.scales = { quote_scale: USDC_DECIMALS, price_scale: h.price_scale, qty_scale: h.pool.decimals };

    // The window and its batches.
    const w = dataset.window;
    if (!Number.isSafeInteger(w.start_ms) || !Number.isSafeInteger(w.end_ms) || w.start_ms < 0 || w.start_ms % H !== 0 || w.end_ms % H !== 0 || w.end_ms <= w.start_ms) {
      throw new SimDataError(`window ${w.start_ms}..${w.end_ms} is not a span of whole hours`);
    }
    if ((w.end_ms - w.start_ms) / H !== w.hours) throw new SimDataError(`window ${w.start_ms}..${w.end_ms} holds ${(w.end_ms - w.start_ms) / H} hours, not ${w.hours}`);
    if (h.first_close_ms !== w.start_ms + H) throw new SimDataError(`hello.first_close_ms ${h.first_close_ms} is not the window's first close ${w.start_ms + H}`);
    this.window = { start_ms: w.start_ms, end_ms: w.end_ms, hours: w.hours };
    this.firstClose = w.start_ms + H;
    this.batchCount = w.hours;

    // The rows, and each hour's bar from them.
    this.rows = parseRows(dataset.rows, w);
    // The least price x with x * (10000 - slippage_bps) / 10000 >= 1: ceil(10000 / (10000 - slippage_bps)).
    const slip = this.bps.slippage_bps;
    const minPrice = (BPS + (BPS - slip) - 1n) / (BPS - slip);
    const lines = new Map<number, ClmmDatasetLineT>();
    let prevT = w.start_ms;
    for (const raw of dataset.bars) {
      const lp = ClmmDatasetLine.safeParse(raw);
      if (!lp.success) throw new SimDataError(`bar t=${String((raw as { t?: unknown }).t)}: ${zodIssue(lp.error)}`);
      const b = lp.data;
      if (b.t <= w.start_ms || b.t > w.end_ms) throw new SimDataError(`bar t=${b.t} is not an hour's close in (${w.start_ms}, ${w.end_ms}]`);
      if (b.t <= prevT) throw new SimDataError(`bar t=${b.t} does not follow ${prevT}: bars are strictly ascending`);
      if (b.venue !== pool.venue) throw new SimDataError(`bar t=${b.t} is from ${b.venue}, the pool's venue is ${pool.venue}`);
      for (const [k, x] of [
        ['o', BigInt(b.o)],
        ['c', BigInt(b.c)],
      ] as const) {
        if (x < minPrice) throw new SimDataError(`bar t=${b.t}: ${k} ${x} sells at a price of 0 under slippage_bps ${slip}: the price scale is too coarse`);
      }
      lines.set(b.t, b);
      prevT = b.t;
    }
    this.hours = [];
    let i = 0;
    for (let k = 0; k < w.hours; k++) {
      const t = w.start_ms + (k + 1) * H;
      const from = i;
      while (i < this.rows.length && this.rows[i]!.ts < t) i++;
      const line = lines.get(t);
      if (from === i) {
        if (line !== undefined) throw new SimDataError(`bar t=${t} has no row in its hour`);
        this.hours.push(null);
        continue;
      }
      if (line === undefined) throw new SimDataError(`the hour closing at ${t} holds ${i - from} rows but has no bar`);
      checkBarRows(line, dataset.rows.slice(from, i));
      this.hours.push(this.hourOf(k, t, from, i, line));
    }

    this.idle = [0n, 0n];
    this.idle[this.q] = BigInt(h.capital.quote_units);
    this.startIdle = [this.idle[0], this.idle[1]];
    this.audit = new ClmmLookaheadAudit(this.hello, dataset);
  }

  private hourOf(k: number, t: number, from: number, to: number, line: ClmmDatasetLineT): ClmmReplayHour {
    const prev = this.rows[from > 0 ? from - 1 : from]!;
    const last = this.rows[to - 1]!;
    const delta = (j: 0 | 1) => str(feeGrowthDelta(prev.fg[j], last.fg[j]));
    return {
      k,
      t,
      from,
      to,
      open_end_ms: this.rows[from]!.ts + BARS_REFERENCE_MS,
      o: BigInt(line.o),
      c: BigInt(line.c),
      o_sqrt: BigInt(line.o_sqrt_price_x64),
      c_sqrt: BigInt(line.c_sqrt_price_x64),
      c_tick: line.c_tick,
      od: line.o_depth.map((d) => BigInt(d)),
      cd: line.c_depth.map((d) => BigInt(d)),
      wire: {
        o: line.o,
        h: line.h,
        l: line.l,
        c: line.c,
        o_tick: line.o_tick,
        c_tick: line.c_tick,
        o_sqrt_price_x64: line.o_sqrt_price_x64,
        c_sqrt_price_x64: line.c_sqrt_price_x64,
        o_liquidity: line.o_liquidity,
        c_liquidity: line.c_liquidity,
        o_depth: [...line.o_depth],
        c_depth: [...line.c_depth],
        fee_growth_delta_x64: [delta(0), delta(1)],
      },
    };
  }

  /** The next batch, or null when the window is exhausted (then call finish). */
  nextBatch(): ClmmBatchT | null {
    if (this.phase === 'awaiting_reply') throw new SimProtocolError(`batch ${this.seq} has no reply yet`);
    if (this.phase === 'finished') throw new SimProtocolError('the replay is finished');
    if (this.aborted !== null || this.seq >= this.batchCount) return null;
    let batch: ClmmBatchT;
    try {
      batch = this.stepTo(this.seq);
    } catch (err) {
      if (err instanceof SimAbortError) {
        this.aborted = err.message;
        this.phase = 'ready';
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

  /** The bot's reply to the current batch: a ClmmReply, or CLMM_LOCKSTEP's envelope of one (the strict schema, its seq, the action cap). */
  submit(reply: unknown): void {
    if (this.phase !== 'awaiting_reply') throw new SimProtocolError('a reply arrived without a pending batch');
    const parsed = ClmmReply.safeParse(isLockstepReply(reply) ? reply.reply : reply);
    if (!parsed.success) throw new SimProtocolError(`not a reply: ${zodIssue(parsed.error)}`);
    const r = parsed.data;
    if (r.seq !== this.seq) throw new SimProtocolError(`reply seq ${r.seq} answers batch ${this.seq}`);
    const cap = clmmReplyActionCap(this.hello);
    if (r.actions.length > cap) throw new SimProtocolError(`reply to batch ${this.seq} carries ${r.actions.length} actions (max ${cap})`);
    this.audit.reply(r.seq);
    if (!this.audit.ok) this.lookaheadAbort();
    this.replies.push(r);
    this.decide(r);
    this.seq++;
    this.phase = 'ready';
  }

  /** submit() for a raw stdout line: parseClmmBotLine's size cap, JSON and schema checks first. */
  submitLine(line: string): void {
    const parsed = parseClmmBotLine(line);
    if (!parsed.ok) throw new SimProtocolError(parsed.reason);
    this.submit(parsed.reply);
  }

  /** Reject the last batch's actions, close out, and end the replay: the done message and the run. */
  finish(): { done: ClmmDoneT; run: ClmmRun } {
    if (this.phase === 'awaiting_reply') throw new SimProtocolError(`batch ${this.seq} has no reply yet`);
    if (this.phase === 'finished') throw new SimProtocolError('the replay is already finished');
    if (this.aborted === null && this.seq < this.batchCount) throw new SimProtocolError(`finish() before the last batch (${this.seq} of ${this.batchCount})`);
    this.phase = 'finished';
    const lastT = this.firstClose + (this.batchCount - 1) * H;
    if (this.aborted === null) {
      try {
        for (const p of this.pending) {
          if (p.reject === null) throw new SimAbortError(`action ${p.index} of the last batch passed its decision checks`);
          this.recordReject(p, p.reject, 'decision', false);
        }
        this.pending = [];
        this.closeOutNow(lastT);
        const quote = this.idle[this.q];
        this.marks.push({ seq: this.seq, t: lastT, close: this.latest === null ? null : str(this.latest.c), asset_units: '0', quote_units: str(quote), equity_quote_units: str(quote), fees_credited: ['0', '0'], intervals: 0, in_range_intervals: 0, in_range_share_9_sum: '0' });
        this.checkTotals();
      } catch (err) {
        if (!(err instanceof SimAbortError)) throw err;
        this.aborted = err.message;
      }
    }
    // An aborted run's done carries the account as it stood; it is never sent nor scored.
    const account = this.account();
    const done: ClmmDoneT = { type: 'done', seq: this.seq, reason: this.aborted === null ? 'end_of_data' : 'aborted', account };
    if (this.aborted === null) {
      const dp = ClmmDone.safeParse(done);
      if (!dp.success) this.aborted = `done is not a ClmmDone: ${zodIssue(dp.error)}`;
    }
    const run: ClmmRun = {
      protocol: CLMM_PROTOCOL,
      dataset_sha256: this.datasetSha,
      fee_multiplier: this.multNum,
      hello: this.hello,
      action_log: { format: ACTION_LOG_FORMAT, protocol: CLMM_PROTOCOL, dataset_sha256: this.datasetSha, hello: this.hello, replies: this.replies },
      batches: this.seq,
      window: this.window,
      resolutions: this.resolutions,
      positions: this.spans,
      close_out: this.aborted === null ? this.closeOut : null,
      marks: this.marks,
      final_account: account,
      start_quote_units: str(this.startIdle[this.q]),
      no_future_bars: this.audit.ok,
      lookahead: [...this.audit.issues],
      aborted: this.aborted,
    };
    return { done, run };
  }

  // ---------------------------------------------------------------- stepping

  /**
   * The hour batch k delivers and applies at: the window's hour k, null when it holds no row.
   * Protected only so a test can stand in a subclass that looks ahead, and see the audit catch it.
   */
  protected hourAt(k: number): ClmmReplayHour | null {
    return this.hours[k] ?? null;
  }

  private stepTo(k: number): ClmmBatchT {
    const t = this.firstClose + k * H;
    if (k === 0) this.marks.push(this.mark(-1, this.window.start_ms, { credited: [0n, 0n], intervals: 0, inRange: 0, share9: 0n }));
    const hour = this.hourAt(k);
    const stats: HourStats = { credited: [0n, 0n], intervals: 0, inRange: 0, share9: 0n };
    if (this.held !== null) this.held.hour = [0n, 0n];
    // (a) the intervals before the open window's end, (b) the previous batch's actions at the open,
    // (c) the hour's other intervals, (d) the close.
    if (hour !== null) this.accrue(hour, true, stats);
    const at: { pool: BarsPool | null } = { pool: null };
    for (const p of this.pending) this.resolve(p, hour, at);
    this.pending = [];
    if (hour !== null) {
      this.accrue(hour, false, stats);
      this.latest = hour;
    }
    const position = this.positionView();
    const account = this.account();
    this.marks.push(this.mark(k, t, stats));
    const results = this.undelivered;
    this.undelivered = [];
    const batch: ClmmBatchT = { type: 'batch', seq: k, t, bar: hour === null ? null : hour.wire, results, position, account };
    const bp = ClmmBatch.safeParse(batch);
    if (!bp.success) throw new SimAbortError(`batch ${k} is not a ClmmBatch: ${zodIssue(bp.error)}`);
    this.phase = 'awaiting_reply';
    return batch;
  }

  /** Credit the hour's intervals on one side of its open window's end to the position held now (see the header). */
  private accrue(hour: ClmmReplayHour, beforeOpen: boolean, st: HourStats): void {
    const rows = this.rows;
    for (let i = Math.max(hour.from, 1); i < hour.to; i++) {
      const r0 = rows[i - 1]!;
      const r1 = rows[i]!;
      if ((r0.ts < hour.open_end_ms) !== beforeOpen) continue;
      st.intervals++;
      const p = this.held;
      if (p === null || r0.ts < p.liveFrom || !clmmIn(p.range, r0.tick) || !clmmIn(p.range, r1.tick)) continue;
      st.inRange++;
      st.share9 += this.shareAt(p, r0.sqrt);
      if (r1.ts - r0.ts > CLMM_MAX_FEE_INTERVAL_MS) continue;
      for (const j of [0, 1] as const) {
        const credit = feeCredit(feeGrowthDelta(r0.fg[j], r1.fg[j]), p.L, r0.liquidity);
        p.owed[j] += credit;
        p.hour[j] += credit;
        st.credited[j] += credit;
        this.books.credited[j] += credit;
      }
    }
  }

  /** floor(10^9 x the position's value / the equity) at a sqrt price. */
  private shareAt(p: Held, s: bigint): bigint {
    const amt = heldAmounts(p, s);
    const pos = amountsValue({ a: amt[0], b: amt[1] }, s, this.side);
    const rest = amountsValue({ a: this.idle[0] + p.owed[0], b: this.idle[1] + p.owed[1] }, s, this.side);
    const equity = pos + rest;
    return equity === 0n ? 0n : (pos * SHARE_SCALE) / equity;
  }

  /** The tokens held three ways (idle, in the position at the latest close, in its fees owed), and the position as the batch shows it. */
  private holdings(): { asset: bigint; quote: bigint; view: ClmmPositionT | null } {
    let asset = this.idle[this.x];
    let quote = this.idle[this.q];
    const p = this.held;
    if (p === null) return { asset, quote, view: null };
    const lc = this.latest;
    if (lc === null) throw new SimAbortError('a position is held before any close');
    const a = amountsForLiquidity(p.L, lc.c_sqrt, p.range, false);
    const amt: Pair = [a.a, a.b];
    asset += amt[this.x] + p.owed[this.x];
    quote += amt[this.q] + p.owed[this.q];
    const view: ClmmPositionT = {
      lower_tick: p.range.lower,
      upper_tick: p.range.upper,
      liquidity: str(p.L),
      amounts: pairStr(amt),
      fees_owed: pairStr(p.owed),
      fees_hour: pairStr(p.hour),
      in_range: clmmIn(p.range, lc.c_tick),
    };
    return { asset, quote, view };
  }

  private equityOf(asset: bigint, quote: bigint): bigint {
    if (asset === 0n) return quote;
    if (this.latest === null) throw new SimAbortError(`the asset (${asset}) is held before any close`);
    return quote + barsValue(asset, this.latest.c, this.scales);
  }

  private positionView(): ClmmPositionT | null {
    return this.holdings().view;
  }

  private account(): ClmmAccountT {
    const { asset, quote } = this.holdings();
    return { idle: pairStr(this.idle), equity_quote_units: str(this.equityOf(asset, quote)) };
  }

  private mark(seq: number, t: number, st: HourStats): ClmmMark {
    const { asset, quote } = this.holdings();
    return {
      seq,
      t,
      close: this.latest === null ? null : str(this.latest.c),
      asset_units: str(asset),
      quote_units: str(quote),
      equity_quote_units: str(this.equityOf(asset, quote)),
      fees_credited: pairStr(st.credited),
      intervals: st.intervals,
      in_range_intervals: st.inRange,
      in_range_share_9_sum: str(st.share9),
    };
  }

  // ---------------------------------------------------------------- deciding

  /** The decision checks of one reply, in order (the protocol header's list), against the batch's account. */
  private decide(r: ClmmReplyT): void {
    const t = this.firstClose + this.seq * H;
    const isLast = this.seq === this.batchCount - 1;
    const close = this.latest === null ? null : this.latest.c;
    r.actions.forEach((action, index) => {
      let reject: ClmmRejectReasonT | null = null;
      if (index >= this.hello.caps.max_actions_per_batch) reject = 'max_actions_per_batch';
      else if (isLast) reject = 'after_end';
      else if (action.action !== 'hold') {
        if (close === null) reject = 'no_bar';
        else if (action.action === 'set_range') reject = clmmRangeRejection(this.hello, action);
      }
      this.pending.push({ action, seq: this.seq, index, decidedT: t, appliedT: t + H, reject, close });
    });
  }

  // ---------------------------------------------------------------- resolving

  private result(p: Pending, reason: ClmmRejectReasonT | null, swap: ClmmSwapT | null): ClmmActionResultT {
    const a = p.action;
    return {
      action: a.action,
      status: reason === null ? 'applied' : 'rejected',
      reason,
      decided_t: p.decidedT,
      applied_t: p.appliedT,
      lower_tick: a.action === 'set_range' ? a.lower_tick : null,
      upper_tick: a.action === 'set_range' ? a.upper_tick : null,
      swap,
    };
  }

  private record(p: Pending, r: ClmmActionResultT, extra: Pick<ClmmResolution, 'rejected_at' | 'reference_price' | 'withdrawn' | 'minted'>, deliver: boolean): void {
    this.resolutions.push({ ...r, seq: p.seq, index: p.index, ...extra, idle_after: pairStr(this.idle) });
    if (deliver) this.undelivered.push(r);
  }

  private recordReject(p: Pending, reason: ClmmRejectReasonT, at: 'decision' | 'open', deliver = true): void {
    this.record(p, this.result(p, reason, null), { rejected_at: at, reference_price: null, withdrawn: null, minted: null }, deliver);
  }

  /** The position's withdrawal at a sqrt price, drafted: the tokens its liquidity returns there (rounded down) and its fees owed. */
  private withdrawal(p: Held, s: bigint): Withdrawn {
    const a = amountsForLiquidity(p.L, s, p.range, false);
    return { held: p, amounts: [a.a, a.b], fees: [p.owed[0], p.owed[1]] };
  }

  private withdrawalOut(w: Withdrawn): ClmmWithdrawal {
    return { lower_tick: w.held.range.lower, upper_tick: w.held.range.upper, liquidity: str(w.held.L), amounts: pairStr(w.amounts), fees: pairStr(w.fees) };
  }

  /** Keep a drafted withdrawal: the books, the span, no position. */
  private commitWithdrawal(w: Withdrawn, withdrawnT: number | null, liveUntil: number | null): void {
    if (this.held !== w.held) throw new SimAbortError('a withdrawal of a position no longer held');
    for (const j of [0, 1] as const) {
      this.books.withdrawn[j] += w.amounts[j];
      this.books.collected[j] += w.fees[j];
    }
    Object.assign(w.held.span, { withdrawn_t: withdrawnT, live_until_ms: liveUntil, withdrawn_amounts: pairStr(w.amounts), fees: pairStr(w.fees) });
    this.held = null;
  }

  private setIdle(idle: Pair, what: string): void {
    if (idle[0] < 0n || idle[1] < 0n) throw new SimAbortError(`idle went below 0 ([${idle[0]}, ${idle[1]}]) after ${what}`);
    this.idle = idle;
  }

  private swapOf(s: Sized): ClmmSwapT {
    return s.side === 'buy'
      ? { side: 'buy', price: str(s.price), qty: str(s.qty), notional_quote_units: str(s.amount), fee_quote_units: str(s.fee) }
      : { side: 'sell', price: str(s.price), qty: str(s.amount), notional_quote_units: str(s.proceeds), fee_quote_units: str(s.fee) };
  }

  /** A swap's tokens into a drafted idle pair, and the check that its fill is within max_slippage of the decision's close. */
  private applySwap(s: Sized, idle: Pair, close: bigint, maxSlip: bigint): boolean {
    if (s.side === 'buy') {
      if (s.price * BPS > close * (BPS + maxSlip)) return false;
      idle[this.q] -= s.amount;
      idle[this.x] += s.qty;
    } else {
      if (s.price * BPS < close * (BPS - maxSlip)) return false;
      idle[this.x] -= s.amount;
      idle[this.q] += s.proceeds;
    }
    return true;
  }

  private bookSwap(s: Sized): void {
    if (s.side === 'buy') {
      this.books.swapOut[this.q] += s.amount;
      this.books.swapIn[this.x] += s.qty;
    } else {
      this.books.swapOut[this.x] += s.amount;
      this.books.swapIn[this.q] += s.proceeds;
    }
  }

  /** Resolve one action at its bar's open; `at.pool` is the pool at that open as the earlier swaps left it (null: untouched). */
  private resolve(p: Pending, hour: ClmmReplayHour | null, at: { pool: BarsPool | null }): void {
    if (p.reject !== null) return this.recordReject(p, p.reject, 'decision');
    const a = p.action;
    if (a.action === 'hold') return this.record(p, this.result(p, null, null), { rejected_at: null, reference_price: null, withdrawn: null, minted: null }, true);
    if (hour === null) return this.recordReject(p, 'no_bar', 'open');
    if (p.close === null) throw new SimAbortError(`a ${a.action} decided with no close passed its decision checks`);
    const maxSlip = BigInt(a.max_slippage_bps);
    const pool = at.pool ?? BarsPool.of(hour.od, USDC_DECIMALS);
    const idle: Pair = [this.idle[0], this.idle[1]];
    const held = this.held;

    if (a.action === 'withdraw') {
      if (held === null && idle[this.x] === 0n) return this.recordReject(p, 'nothing_to_withdraw', 'open');
      const w = held === null ? null : this.withdrawal(held, hour.o_sqrt);
      if (w !== null) for (const j of [0, 1] as const) idle[j] += w.amounts[j] + w.fees[j];
      const asset = idle[this.x];
      let sized: Sized | null = null;
      if (asset > 0n && barsValue(asset, hour.o, this.scales) >= this.minNotional) {
        const f = barsSellFill(asset, hour.o, pool, this.bps, this.scales);
        sized = { side: 'sell', amount: asset, proceeds: f.proceeds, price: f.price, fee: f.fee, after: f.after };
        if (!this.applySwap(sized, idle, p.close, maxSlip)) return this.recordReject(p, 'max_slippage', 'open');
      }
      if (w !== null) this.commitWithdrawal(w, hour.t, hour.open_end_ms);
      if (sized !== null) {
        this.bookSwap(sized);
        at.pool = sized.after;
      }
      this.setIdle(idle, `withdraw ${p.seq}:${p.index}`);
      const swap = sized === null ? null : this.swapOf(sized);
      return this.record(p, this.result(p, null, swap), { rejected_at: null, reference_price: sized === null ? null : str(hour.o), withdrawn: w === null ? null : this.withdrawalOut(w), minted: null }, true);
    }

    // set_range: withdraw, swap toward the range's ratio, mint the most the tokens buy.
    const range: TickRange = { lower: a.lower_tick, upper: a.upper_tick };
    const sL = sqrtPriceAtTick(range.lower);
    const sU = sqrtPriceAtTick(range.upper);
    const w = held === null ? null : this.withdrawal(held, hour.o_sqrt);
    if (w !== null) for (const j of [0, 1] as const) idle[j] += w.amounts[j] + w.fees[j];
    const sized = this.sizeSwap(idle, range, sL, sU, hour, pool);
    if (sized !== null && !this.applySwap(sized, idle, p.close, maxSlip)) return this.recordReject(p, 'max_slippage', 'open');
    const L = liquidityForAmounts(hour.o_sqrt, range, { a: idle[0], b: idle[1] });
    if (L === 0n) return this.recordReject(p, 'zero_liquidity', 'open');
    const used = amountsForLiquidity(L, hour.o_sqrt, range, true);
    idle[0] -= used.a;
    idle[1] -= used.b;
    if (w !== null) this.commitWithdrawal(w, hour.t, hour.open_end_ms);
    if (sized !== null) {
      this.bookSwap(sized);
      at.pool = sized.after;
    }
    this.books.minted[0] += used.a;
    this.books.minted[1] += used.b;
    this.setIdle(idle, `set_range ${p.seq}:${p.index}`);
    const span: ClmmPositionSpan = {
      lower_tick: range.lower,
      upper_tick: range.upper,
      liquidity: str(L),
      minted_t: hour.t,
      live_from_ms: hour.open_end_ms,
      withdrawn_t: null,
      live_until_ms: null,
      minted_amounts: [str(used.a), str(used.b)],
      withdrawn_amounts: ['0', '0'],
      fees: ['0', '0'],
    };
    this.spans.push(span);
    this.held = { range, L, sL, sU, owed: [0n, 0n], hour: [0n, 0n], liveFrom: hour.open_end_ms, span };
    const swap = sized === null ? null : this.swapOf(sized);
    this.record(
      p,
      this.result(p, null, swap),
      { rejected_at: null, reference_price: sized === null ? null : str(hour.o), withdrawn: w === null ? null : this.withdrawalOut(w), minted: { liquidity: str(L), amounts: [str(used.a), str(used.b)] } },
      true,
    );
  }

  /**
   * The swap a set_range makes before its mint (see the header): a buy of the asset when the asset is
   * the short token at the open's reference sqrt price, a sale of it when USDC is, sized by
   * bisection; null for no swap (a tie, or under the minimum notional, or a buy of nothing).
   */
  private sizeSwap(idle: Pair, range: TickRange, sL: bigint, sU: bigint, hour: ClmmReplayHour, pool: BarsPool): Sized | null {
    const s = hour.o_sqrt;
    const c = s < sL ? sL : s > sU ? sU : s;
    // A's capacity a sU c / ((sU - c) 2^64) against B's b 2^64 / (c - sL), cross-multiplied.
    const kA = (c - sL) * sU * c;
    const kB = (sU - c) * Q128;
    const x = this.x;
    const q = this.q;
    const wAsset = (v: Pair) => v[x] * (x === 0 ? kA : kB);
    const wUsdc = (v: Pair) => v[q] * (q === 0 ? kA : kB);
    const liq = (v: Pair) => liquidityForAmounts(s, range, { a: v[0], b: v[1] });
    if (wAsset(idle) < wUsdc(idle)) {
      const buy = (n: bigint) => {
        const f = barsBuyFill(n, hour.o, pool, this.bps, this.scales);
        const v: Pair = [idle[0], idle[1]];
        v[q] -= n;
        v[x] += f.qty;
        return { f, v };
      };
      const n = bisect(
        idle[q],
        (m) => {
          const { v } = buy(m);
          return wAsset(v) <= wUsdc(v);
        },
        (m) => liq(buy(m).v),
      );
      if (n === 0n || n < this.minNotional) return null;
      const { f } = buy(n);
      if (f.qty === 0n) return null;
      return { side: 'buy', amount: n, qty: f.qty, price: f.price, fee: f.fee, after: f.after };
    }
    if (wUsdc(idle) < wAsset(idle)) {
      const sell = (n: bigint) => {
        const f = barsSellFill(n, hour.o, pool, this.bps, this.scales);
        const v: Pair = [idle[0], idle[1]];
        v[x] -= n;
        v[q] += f.proceeds;
        return { f, v };
      };
      const n = bisect(
        idle[x],
        (m) => {
          const { v } = sell(m);
          return wUsdc(v) <= wAsset(v);
        },
        (m) => liq(sell(m).v),
      );
      if (n === 0n || barsValue(n, hour.o, this.scales) < this.minNotional) return null;
      const { f } = sell(n);
      return { side: 'sell', amount: n, proceeds: f.proceeds, price: f.price, fee: f.fee, after: f.after };
    }
    return null;
  }

  /** The end (the header): the position withdrawn at the latest close's sqrt price, every unit of the asset sold at c against c_depth, untouched. */
  private closeOutNow(lastT: number): void {
    const lc = this.latest;
    const idle: Pair = [this.idle[0], this.idle[1]];
    let w: Withdrawn | null = null;
    if (this.held !== null) {
      if (lc === null) throw new SimAbortError('a position is held with no close to withdraw it at');
      w = this.withdrawal(this.held, lc.c_sqrt);
      for (const j of [0, 1] as const) idle[j] += w.amounts[j] + w.fees[j];
      this.commitWithdrawal(w, null, null);
    }
    let swap: ClmmSwapT | null = null;
    const asset = idle[this.x];
    if (asset > 0n) {
      if (lc === null) throw new SimAbortError(`the asset (${asset}) is held with no close to sell it at`);
      const f = barsSellFill(asset, lc.c, lc.cd, this.bps, this.scales);
      const sized: Sized = { side: 'sell', amount: asset, proceeds: f.proceeds, price: f.price, fee: f.fee, after: f.after };
      idle[this.x] = 0n;
      idle[this.q] += f.proceeds;
      this.bookSwap(sized);
      swap = this.swapOf(sized);
    }
    this.setIdle(idle, 'the close-out');
    this.closeOut = {
      t: lastT,
      close_t: lc === null ? null : lc.t,
      reference_price: swap === null || lc === null ? null : str(lc.c),
      withdrawn: w === null ? null : this.withdrawalOut(w),
      swap,
      idle_after: pairStr(this.idle),
    };
  }

  /** End-of-run identities (see the header's books). */
  private checkTotals(): void {
    if (this.held !== null) throw new SimAbortError('a position is still held after the close-out');
    if (this.idle[this.x] !== 0n) throw new SimAbortError(`${this.idle[this.x]} units of the asset are still held after the close-out`);
    const b = this.books;
    for (const j of [0, 1] as const) {
      const want = this.startIdle[j] + b.swapIn[j] - b.swapOut[j] - b.minted[j] + b.withdrawn[j] + b.collected[j];
      if (want !== this.idle[j]) throw new SimAbortError(`token ${j}: idle ${this.idle[j]} is not the books' ${want}`);
      if (b.collected[j] !== b.credited[j]) throw new SimAbortError(`token ${j}: ${b.credited[j]} in fees credited, ${b.collected[j]} collected`);
    }
  }
}

/** Whether a range holds a tick (the venues' rule, contracts/clmm-protocol.ts clmmInRange). */
function clmmIn(range: TickRange, tick: number): boolean {
  return range.lower <= tick && tick < range.upper;
}

/**
 * The largest n in [0, max] with stillShort(n) (true at 0), or n + 1 when that mints more
 * (liquidityAt): the crossing of the two tokens' capacities.
 */
function bisect(max: bigint, stillShort: (n: bigint) => boolean, liquidityAt: (n: bigint) => bigint): bigint {
  if (max === 0n || stillShort(max)) return max;
  let lo = 0n;
  let hi = max;
  while (hi - lo > 1n) {
    const mid = (lo + hi) >> 1n;
    if (stillShort(mid)) lo = mid;
    else hi = mid;
  }
  return liquidityAt(hi) > liquidityAt(lo) ? hi : lo;
}

/** A bot the replay can drive: replies may be sync or async. */
export interface ClmmBotDriver {
  hello?(msg: ClmmHelloT): void | Promise<void>;
  batch(msg: ClmmBatchT): unknown;
  done?(msg: ClmmDoneT): void | Promise<void>;
}

/** Drive a bot through the whole replay in lockstep. */
export async function runClmmBot(dataset: ClmmDataset, hello: ClmmHelloT, bot: ClmmBotDriver, opts?: ClmmEngineOptions): Promise<ClmmRun> {
  const engine = new ClmmEngine(dataset, hello, opts);
  await bot.hello?.(engine.hello);
  for (let b = engine.nextBatch(); b !== null; b = engine.nextBatch()) engine.submit(await bot.batch(b));
  const { done, run } = engine.finish();
  await bot.done?.(done);
  return run;
}

/** Re-run a stored action log (L1 regrade, cost sensitivity): the same dataset and replies give the same run. */
export function replayClmmActionLog(dataset: ClmmDataset, log: ClmmActionLogT, opts?: ClmmEngineOptions): ClmmRun {
  const parsed = ClmmActionLog.parse(log);
  if (parsed.dataset_sha256 !== dataset.sha256) throw new SimDataError(`action log is for dataset ${parsed.dataset_sha256}, not ${dataset.sha256}`);
  const engine = new ClmmEngine(dataset, parsed.hello, opts);
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
