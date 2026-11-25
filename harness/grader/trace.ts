// A replay run's trace (contracts/breakdown.ts, agent-fun/trace/v1, kind pnl): what the entry did and
// what each of its fills moved, row by row, kept beside its score. Each builder reads the 1x run the
// harness's scorer already returns (sim/metrics.ts ScoredReplay.run and ScoredBarsReplay.run,
// sim/clmm/metrics.ts ScoredClmmReplay.run), never the cost-sensitivity run, so a trace is a pure
// function of what the score is a pure function of:
//
//   traceOfReplayRun   pumpfun-replay/v2 (sim/engine.ts ReplayRun), in lamports
//   traceOfBarsRun     bars-replay/v1 (sim/bars/engine.ts BarsRun), in the quote's raw units
//   traceOfClmmRun     clmm-replay/v1 (sim/clmm/engine.ts ClmmRun), in USDC raw units
//
// grader/harnesses.ts's replay plans return it beside the performance (Scored.trace); grader/grade.ts
// carries it on the outcome as canonical JSON (trace_json) and the sha256 of its blob (trace_sha256);
// grader/record.ts stores the blob (traceBlob: the gzip of that JSON) and names it in run.trace_sha256;
// grader/regrade.ts recomputes it and compares the stored one, decompressed, flagging a difference
// (trace_differs) without moving the status. It never enters run.result, so result_sha256 does not move.
//
// Every builder checks what it built against PnlTrace (contracts/breakdown.ts) and throws TraceError
// on a trace the contract refuses: a fault of this module or of the engine, never the entry's, which
// grading throws (the job retries) as it throws any harness fault, rather than record a run whose
// replay could not be shown.
//
// What each run's rows are (the contract's header names the parts; cash_flow is always their sum):
//
//   pump    every resolution that is not rejected, in resolution order: a filled order, a failed one
//           (its tx fee alone), a close (complete, flatten) or a write-off (its tokens gone for 0
//           lamports). trade is the curve quote the fill moved (the reserves' q): −q on a buy, +q on a
//           sell or close. fees {protocol, creator}: the buyback is a share of protocol, no charge of
//           its own. tx_fee base + priority. size the tokens (pump.fun mints: 6 decimals), no price.
//           Time is the block time: a point's block_time × 1000, a point with none carrying the one
//           before it forward (the start's falling back to the dataset's first block time, and to 0 on
//           a dataset that carries none), never earlier than the point before. A resolution, and a
//           round trip's ends, sit at the slot they resolved in: the time of the last point at or
//           before that slot (a slot no batch was sent for has no block time of its own, so the latest
//           batch's carries over; the final close's slot is the end point's). The window runs from the
//           dataset's first block time to its last, widened to every point.
//   bars    every filled order and flatten, in resolution order, each at its fill_bar: the t of the
//           batch that reports it (a flatten's, the last batch's). trade −(notional − fee) on a buy
//           (the spend) and +(proceeds + fee) on a sell (the gross); fees {pool}; no tx fee; price the
//           fill's at the symbol's price_scale; size at its qty_scale. The window is the run's.
//   clmm    every applied set_range and withdraw (an applied hold moves nothing and is no row), at
//           applied_t, the t of the bar whose open applied it; then the close-out at its t, when it
//           moved anything. The cash is the idle USDC: other holds the USDC a withdrawn position
//           returned (position_withdrawn) and the fees it had owed (fees_collected), and minus what a
//           mint took (position_minted); a swap's trade is −(notional − fee) on a buy of the asset and
//           +(proceeds + fee) on a sale, its fee {swap}. The asset's own legs are holdings, not cash:
//           they move the equity points. size is the asset's raw units the swap traded, price its fill
//           price at hello.price_scale. The one item is the pool (hello.pool.pool), its size_decimals
//           the asset's decimals; its realized adds up to the net because the close-out ends all USDC.
//           A round trip is a stretch of the account holding anything but USDC (a position, or idle
//           asset): from the row that leaves all USDC to the row that comes back to it (a withdraw
//           that sold everything, or the close-out), its pnl their cash flows added; its range the
//           position's ticks when the stretch minted one position only.
//
// Rejected orders and actions moved nothing: each is counted under its reason (rejected). Past
// TRACE_MAX_FILLS rows the rest are counted in fills_truncated; items, round trips and rejections are
// always taken from the whole run.

import { gunzipSync, gzipSync } from 'node:zlib';
import { CLMM_PROTOCOL, clmmQuoteIndex, type ClmmSwapT } from '../contracts/clmm-protocol.ts';
import { BARS_PROTOCOL } from '../contracts/bars-protocol.ts';
import {
  PnlTrace,
  TRACE_FORMAT,
  TRACE_MAX_FILLS,
  type PnlTraceT,
  type TraceFillT,
  type TraceItemT,
  type TracePointT,
  type TraceRoundTripT,
  type TraceT,
  type TraceUnitT,
} from '../contracts/breakdown.ts';
import { PROTOCOL } from '../contracts/protocol.ts';
import { BlobCorruptError, type BlobStore } from '../server/blobstore.ts';
import type { BarsRun } from '../sim/bars/engine.ts';
import { canonicalJson, sha256Hex } from '../sim/canonical.ts';
import type { ClmmResolution, ClmmRun, ClmmWithdrawal } from '../sim/clmm/engine.ts';
import type { ReplayRun } from '../sim/engine.ts';

/** A pump.fun mint's decimals: its 10^15 raw units of supply are 10^9 tokens (sim/synthetic.ts PUMP_INITIAL). */
export const PUMP_TOKEN_DECIMALS = 6;

/**
 * The gzip level a trace blob is written at (traceBlob): zlib's default. On a 10 MB trace (50,000 points, 20,000
 * fills) level 9 took about 4x as long for a blob 8% smaller, and the blob is written at every grade and regrade.
 */
export const TRACE_GZIP_LEVEL = 6;

/** The most bytes a stored trace may inflate to (readStoredTrace): server/live/reveal.ts reads to the same bound. */
export const TRACE_MAX_JSON_BYTES = 256 * 1024 * 1024;

/** A trace this module could not build: the contract refuses it, or the run cannot have one. The platform's fault, never the entry's. */
export class TraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceError';
  }
}

// ---------------------------------------------------------------- shared

/** A fill row's parts as integers, and its cash flow, their sum (contracts/breakdown.ts fillPartsSum). */
function parts(trade: bigint, fees: Record<string, bigint>, txFee: bigint, other: Record<string, bigint>): Pick<TraceFillT, 'cash_flow' | 'trade' | 'fees' | 'tx_fee' | 'other'> {
  let flow = trade - txFee;
  const feeStrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(fees)) {
    flow -= v;
    feeStrs[k] = v.toString();
  }
  const otherStrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(other)) {
    flow += v;
    otherStrs[k] = v.toString();
  }
  return { cash_flow: flow.toString(), trade: trade.toString(), fees: feeStrs, tx_fee: txFee.toString(), other: otherStrs };
}

/** Count one rejection under its reason. */
function tally(rejected: Map<string, number>, reason: string | null, what: string): void {
  if (reason === null) throw new TraceError(`${what} was rejected for no reason`);
  rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
}

function refuseAborted(aborted: string | null, protocol: string): void {
  if (aborted !== null) throw new TraceError(`an aborted ${protocol} run has no trace: ${aborted}`);
}

interface Assembly {
  protocol: PnlTraceT['protocol'];
  unit: TraceUnitT;
  start: bigint;
  end: bigint;
  window: { start_ms: number; end_ms: number };
  points: TracePointT[];
  rows: TraceFillT[];
  rejected: Map<string, number>;
  round_trips: TraceRoundTripT[];
  items: TraceItemT[];
}

/** The trace of the parts, its rows capped at TRACE_MAX_FILLS, held to PnlTrace (TraceError when it is not). */
function assemble(a: Assembly): PnlTraceT {
  const fills = a.rows.length > TRACE_MAX_FILLS ? a.rows.slice(0, TRACE_MAX_FILLS) : a.rows;
  const trace: PnlTraceT = {
    format: TRACE_FORMAT,
    kind: 'pnl',
    protocol: a.protocol,
    unit: a.unit,
    start_equity: a.start.toString(),
    end_equity: a.end.toString(),
    net: (a.end - a.start).toString(),
    window: a.window,
    points: a.points,
    fills,
    fills_truncated: a.rows.length - fills.length,
    rejected: Object.fromEntries([...a.rejected].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
    round_trips: a.round_trips,
    items: a.items,
  };
  const checked = PnlTrace.safeParse(trace);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new TraceError(`the ${a.protocol} run's trace is refused by ${TRACE_FORMAT}${issue === undefined ? '' : ` at ${issue.path.join('.') || '(root)'}: ${issue.message}`}`);
  }
  return trace;
}

// ---------------------------------------------------------------- pumpfun-replay/v2

/** What traceOfReplayRun reads of a pump replay's run. */
export type ReplayTraceRun = Pick<ReplayRun, 'aborted' | 'start_lamports' | 'final_account' | 'equity' | 'resolutions' | 'round_trips' | 'per_token' | 'first_block_time' | 'last_block_time'>;

/** The pump replay's equity points on the block-time clock (the header's pump time rule). */
function pumpPoints(run: ReplayTraceRun): TracePointT[] {
  const firstMs = run.first_block_time === null ? null : run.first_block_time * 1000;
  const points: TracePointT[] = [];
  let carried: number | null = null;
  for (const p of run.equity) {
    const own = p.block_time === null ? null : p.block_time * 1000;
    const t: number = own === null ? (carried ?? firstMs ?? 0) : Math.max(own, carried ?? own);
    carried = t;
    points.push({ seq: p.seq, t_ms: t, slot: p.slot, equity: p.equity_lamports });
  }
  return points;
}

/** The time of a slot: the last point's at or before it (points ascend by slot), the first point's before them all. */
function slotClock(points: readonly TracePointT[]): (slot: number) => number {
  return (slot) => {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (points[mid]!.slot! <= slot) lo = mid + 1;
      else hi = mid;
    }
    return points[lo > 0 ? lo - 1 : 0]!.t_ms;
  };
}

/** The trace of a pumpfun-replay/v2 run (the header's pump rows): lamports, on the block-time clock. */
export function traceOfReplayRun(run: ReplayTraceRun): PnlTraceT {
  refuseAborted(run.aborted, PROTOCOL);
  const points = pumpPoints(run);
  if (points.length === 0) throw new TraceError(`a ${PROTOCOL} run with no equity point has no trace`);
  const at = slotClock(points);
  const rows: TraceFillT[] = [];
  const rejected = new Map<string, number>();
  for (const f of run.resolutions) {
    if (f.status === 'rejected') {
      tally(rejected, f.reason, `order ${f.client_id}`);
      continue;
    }
    const filled = f.status === 'filled';
    const q = BigInt(f.curve_quote_lamports);
    const trade = !filled ? 0n : f.side === 'buy' ? -q : q;
    rows.push({
      seq: f.seq,
      index: f.index,
      kind: f.kind,
      client_id: f.client_id,
      status: f.status,
      t_ms: at(f.slot),
      slot: f.slot,
      item: f.mint,
      side: f.side,
      size: filled ? f.token_amount : '0',
      ...parts(trade, { protocol: BigInt(f.protocol_fee_lamports), creator: BigInt(f.creator_fee_lamports) }, BigInt(f.tx_fee_lamports), {}),
      cash_after: f.cash_after_lamports,
    });
  }
  const round_trips: TraceRoundTripT[] = run.round_trips.map((r) => ({
    item: r.mint,
    opened_t_ms: at(r.opened_slot),
    closed_t_ms: at(r.closed_slot),
    opened_slot: r.opened_slot,
    closed_slot: r.closed_slot,
    pnl: r.pnl_lamports,
    bought: r.bought_lamports,
  }));
  const items: TraceItemT[] = run.per_token.map((t) => ({
    item: t.mint,
    realized: t.realized_pnl_lamports,
    fees: t.fees_lamports,
    tx_fees: t.tx_fees_lamports,
    fills: t.fills,
    size_decimals: PUMP_TOKEN_DECIMALS,
  }));
  const t0 = points[0]!.t_ms;
  const tN = points[points.length - 1]!.t_ms;
  const firstMs = run.first_block_time === null ? t0 : run.first_block_time * 1000;
  const lastMs = run.last_block_time === null ? tN : run.last_block_time * 1000;
  return assemble({
    protocol: PROTOCOL,
    unit: { name: 'lamports', asset: 'SOL', decimals: 9 },
    start: BigInt(run.start_lamports),
    end: BigInt(run.final_account.cash_lamports),
    window: { start_ms: Math.min(t0, firstMs), end_ms: Math.max(tN, lastMs) },
    points,
    rows,
    rejected,
    round_trips,
    items,
  });
}

// ---------------------------------------------------------------- bars-replay/v1

/** What traceOfBarsRun reads of a bars run. */
export type BarsTraceRun = Pick<BarsRun, 'aborted' | 'hello' | 'window' | 'start_quote_units' | 'final_account' | 'equity' | 'resolutions' | 'round_trips' | 'per_symbol'>;

/** The trace of a bars-replay/v1 run (the header's bars rows): quote units, on the bars' t. */
export function traceOfBarsRun(run: BarsTraceRun): PnlTraceT {
  refuseAborted(run.aborted, BARS_PROTOCOL);
  const symbols = new Map(run.hello.symbols.map((s) => [s.symbol, s]));
  const symbolOf = (symbol: string) => {
    const s = symbols.get(symbol);
    if (s === undefined) throw new TraceError(`${symbol} is no symbol of the run's hello`);
    return s;
  };
  const points: TracePointT[] = run.equity.map((p) => ({ seq: p.seq, t_ms: p.t, equity: p.equity_quote_units }));
  const rows: TraceFillT[] = [];
  const rejected = new Map<string, number>();
  for (const f of run.resolutions) {
    if (f.status === 'rejected') {
      tally(rejected, f.reason, `order ${f.client_id}`);
      continue;
    }
    const notional = BigInt(f.notional_quote_units);
    const fee = BigInt(f.fee_quote_units);
    const trade = f.side === 'buy' ? -(notional - fee) : notional + fee;
    rows.push({
      seq: f.seq,
      index: f.index,
      kind: f.kind,
      client_id: f.client_id,
      status: 'filled',
      t_ms: f.fill_bar,
      item: f.symbol,
      side: f.side,
      size: f.qty,
      price: { value: f.price, scale: symbolOf(f.symbol).price_scale },
      ...parts(trade, { pool: fee }, 0n, {}),
      cash_after: f.cash_after_quote_units,
    });
  }
  const round_trips: TraceRoundTripT[] = run.round_trips.map((r) => ({ item: r.symbol, opened_t_ms: r.opened_bar, closed_t_ms: r.closed_bar, pnl: r.pnl_quote_units }));
  const items: TraceItemT[] = run.per_symbol.map((s) => ({
    item: s.symbol,
    realized: s.pnl_quote_units,
    fees: s.fees_quote_units,
    tx_fees: '0',
    fills: s.trades,
    size_decimals: symbolOf(s.symbol).qty_scale,
  }));
  return assemble({
    protocol: BARS_PROTOCOL,
    unit: { name: 'quote_units', asset: 'USDC', decimals: run.hello.capital.quote_scale },
    start: BigInt(run.start_quote_units),
    end: BigInt(run.final_account.cash_quote_units),
    window: { start_ms: run.window.start_ms, end_ms: run.window.end_ms },
    points,
    rows,
    rejected,
    round_trips,
    items,
  });
}

// ---------------------------------------------------------------- clmm-replay/v1

/** What traceOfClmmRun reads of a clmm run. */
export type ClmmTraceRun = Pick<ClmmRun, 'aborted' | 'hello' | 'window' | 'start_quote_units' | 'final_account' | 'marks' | 'resolutions' | 'close_out'>;

/** What one clmm row moved: the position it withdrew, its swap, the position it minted. */
interface ClmmMove {
  withdrawn: ClmmWithdrawal | null;
  swap: ClmmSwapT | null;
  minted: ClmmResolution['minted'];
}

/** One clmm row and what the round trips read of it: whether a position is held after it, the idle asset after it, the range it minted. */
interface ClmmEntry {
  row: TraceFillT;
  flow: bigint;
  fee: bigint;
  positionAfter: boolean;
  assetAfter: bigint;
  range: { lower_tick: number; upper_tick: number } | null;
}

/** The trace of a clmm-replay/v1 run (the header's clmm rows): USDC raw units, on the bars' t. */
export function traceOfClmmRun(run: ClmmTraceRun): PnlTraceT {
  refuseAborted(run.aborted, CLMM_PROTOCOL);
  const close = run.close_out;
  if (close === null) throw new TraceError(`a ${CLMM_PROTOCOL} run with no close-out has no trace`);
  const q = clmmQuoteIndex(run.hello.pool);
  const x = q === 0 ? 1 : 0;
  const item = run.hello.pool.pool;
  const priceScale = run.hello.price_scale;
  const points: TracePointT[] = run.marks.map((m) => ({ seq: m.seq, t_ms: m.t, equity: m.equity_quote_units }));

  const entryOf = (head: Pick<TraceFillT, 'seq' | 'index' | 'kind' | 't_ms'>, move: ClmmMove, idleAfter: readonly [string, string], positionAfter: boolean, range: ClmmEntry['range']): ClmmEntry => {
    const other: Record<string, bigint> = {};
    if (move.withdrawn !== null) {
      other.position_withdrawn = BigInt(move.withdrawn.amounts[q]);
      other.fees_collected = BigInt(move.withdrawn.fees[q]);
    }
    if (move.minted !== null) other.position_minted = -BigInt(move.minted.amounts[q]);
    const s = move.swap;
    const fee = s === null ? 0n : BigInt(s.fee_quote_units);
    const notional = s === null ? 0n : BigInt(s.notional_quote_units);
    const trade = s === null ? 0n : s.side === 'buy' ? -(notional - fee) : notional + fee;
    const row: TraceFillT = {
      ...head,
      status: 'filled',
      item,
      side: s === null ? null : s.side,
      size: s === null ? '0' : s.qty,
      ...(s === null ? {} : { price: { value: s.price, scale: priceScale } }),
      ...parts(trade, { swap: fee }, 0n, other),
      cash_after: idleAfter[q],
    };
    return { row, flow: BigInt(row.cash_flow), fee, positionAfter, assetAfter: BigInt(idleAfter[x]), range };
  };

  const entries: ClmmEntry[] = [];
  const rejected = new Map<string, number>();
  for (const r of run.resolutions) {
    if (r.status === 'rejected') {
      tally(rejected, r.reason, `${r.action} ${r.seq}:${r.index}`);
      continue;
    }
    if (r.action === 'hold') continue;
    const ranged = r.action === 'set_range';
    if (ranged && (r.lower_tick === null || r.upper_tick === null)) throw new TraceError(`set_range ${r.seq}:${r.index} applied with no range`);
    entries.push(
      entryOf(
        { seq: r.seq, index: r.index, kind: r.action, t_ms: r.applied_t },
        { withdrawn: r.withdrawn, swap: r.swap, minted: r.minted },
        r.idle_after,
        ranged,
        ranged ? { lower_tick: r.lower_tick!, upper_tick: r.upper_tick! } : null,
      ),
    );
  }
  if (close.withdrawn !== null || close.swap !== null) {
    entries.push(entryOf({ seq: null, index: null, kind: 'close_out', t_ms: close.t }, { withdrawn: close.withdrawn, swap: close.swap, minted: null }, close.idle_after, false, null));
  }

  // The round trips: each stretch of the account holding anything but USDC (the header's clmm round trips).
  const round_trips: TraceRoundTripT[] = [];
  let trip: { opened: number; pnl: bigint; ranges: { lower_tick: number; upper_tick: number }[] } | null = null;
  let realized = 0n;
  let fees = 0n;
  let fills = 0;
  for (const e of entries) {
    realized += e.flow;
    fees += e.fee;
    if (e.row.kind !== 'close_out') fills++;
    const holding = e.positionAfter || e.assetAfter > 0n;
    if (trip === null && holding) trip = { opened: e.row.t_ms, pnl: 0n, ranges: [] };
    if (trip === null) continue;
    trip.pnl += e.flow;
    if (e.range !== null) trip.ranges.push(e.range);
    if (!holding) {
      round_trips.push({ item, opened_t_ms: trip.opened, closed_t_ms: e.row.t_ms, pnl: trip.pnl.toString(), ...(trip.ranges.length === 1 ? { range: trip.ranges[0]! } : {}) });
      trip = null;
    }
  }
  if (trip !== null) throw new TraceError(`the ${CLMM_PROTOCOL} run's close-out left the account holding more than USDC`);

  return assemble({
    protocol: CLMM_PROTOCOL,
    unit: { name: 'quote_units', asset: 'USDC', decimals: run.hello.capital.quote_scale },
    start: BigInt(run.start_quote_units),
    end: BigInt(run.final_account.idle[q]),
    window: { start_ms: run.window.start_ms, end_ms: run.window.end_ms },
    points,
    rows: entries.map((e) => e.row),
    rejected,
    round_trips,
    items: [{ item, realized: realized.toString(), fees: fees.toString(), tx_fees: '0', fills, size_decimals: run.hello.pool.decimals }],
  });
}

// ---------------------------------------------------------------- the blob

/** A trace as a run keeps it: its canonical JSON, the blob stored (traceBlob of it), and that blob's sha256 (run.trace_sha256). */
export interface EncodedTrace {
  json: string;
  blob: Buffer;
  sha256: string;
}

/** The blob a trace is stored as: the gzip of its canonical JSON (TRACE_GZIP_LEVEL). */
export function traceBlob(json: string): Buffer {
  return gzipSync(json, { level: TRACE_GZIP_LEVEL });
}

/** A trace's canonical JSON, its blob and the blob's sha256. */
export function encodeTrace(trace: TraceT): EncodedTrace {
  const json = canonicalJson(trace);
  const blob = traceBlob(json);
  return { json, blob, sha256: sha256Hex(blob) };
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** A stored trace read back (readStoredTrace): its canonical JSON, or why it could not be read. */
export type StoredTrace = { json: string } | { problem: string };

/**
 * The trace a run stored (the blob run.trace_sha256 names), read back as canonical JSON: the blob must
 * hash to its name and hold JSON, gzip-compressed (traceBlob) or plain. Comparing what comes back with a
 * recomputed trace's JSON compares the traces, never the gzip bytes, which another zlib may write
 * otherwise. A blob that is missing, corrupt or no (gzip) JSON is a problem, returned; anything else
 * the store throws (an I/O fault) is thrown.
 */
export async function readStoredTrace(blobs: Pick<BlobStore, 'get'>, sha256: string): Promise<StoredTrace> {
  let bytes: Buffer | null;
  try {
    bytes = await blobs.get(sha256, { verify: true });
  } catch (err) {
    if (err instanceof BlobCorruptError) return { problem: `trace blob ${sha256} is corrupt: ${err.message}` };
    throw err;
  }
  if (bytes === null) return { problem: `trace blob ${sha256} is not in the blob store` };
  const actual = sha256Hex(bytes);
  if (actual !== sha256) return { problem: `trace blob ${sha256} is corrupt: its bytes hash to ${actual}` };
  try {
    const text = isGzip(bytes) ? gunzipSync(bytes, { maxOutputLength: TRACE_MAX_JSON_BYTES }) : bytes;
    return { json: canonicalJson(JSON.parse(text.toString('utf8'))) };
  } catch (err) {
    return { problem: `trace blob ${sha256} is not gzip JSON: ${(err as Error).message}` };
  }
}
