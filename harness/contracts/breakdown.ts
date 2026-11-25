// agent-fun/trace/v1: one entry's run, row by row, for the people watching it. The running phase
// replays it on a server clock (the live board's frames: equity, rank, fills so far), and the
// per-entry breakdown (the page, GET /api/submissions/:id/breakdown, its markdown twin and MCP
// get_breakdown) prints it. Two kinds:
//
//   pnl      a replay harness's run (pumpfun-replay/v2, bars-replay/v1, clmm-replay/v1): the equity
//            after every batch, every fill and failed order with each part of its cash flow, the
//            rejections counted per reason, the round trips, and one ledger row per item (a mint, a
//            symbol, a pool) whose realized amounts add up to the net PnL.
//   checks   a scored run (program/v1, agent/v1): its score parts, earned against max, that add up
//            to the total (sum), or per trial, whose per-trial totals average to it (mean).
//
// Where it lives. A trace is stored as its own blob BESIDE run.result (run.trace_sha256 names it),
// never inside it: run.result and run.result_sha256 stay byte-identical, so an L1 regrade still
// reproduces them, and a regrade that recomputes a different trace flags it (trace_differs) without
// touching the status. Like the score, a trace holds no ids, wall-clock times or host facts: it is a
// pure function of the run, so the same run gives the same canonical bytes.
//
// Cash basis. A pnl trace's money is integers of one unit (TraceUnit: lamports on the pump replay,
// the quote asset's raw units on bars and clmm), as decimal strings (U64 or, where it can be
// negative, I64). Every fill row carries every part of its cash flow, so a reader re-adds the run by
// hand (Alpha Arena's fee columns do not reconcile, #2187; these must):
//
//   cash_flow = trade − Σ fees − tx_fee + Σ other          (each row; the schema refuses one that does not)
//   cash_after = the previous row's cash_after (start_equity before the first) + cash_flow
//   items[i].realized = Σ cash_flow of the fills on item i  (realized is cash basis: what left and
//                                                             came back, so a held position reads as
//                                                             negative realized plus unrealized)
//   Σ items.realized = net,  start_equity + net = end_equity  (every harness ends all cash: the final
//                                                             flatten, writeoff or close-out)
//
// traceSums re-adds them all and reports each identity with both sides; the schema refuses only what
// one row says about itself, so a trace that does not reconcile still parses and shows where.
//
// The fill cap. fills lists the filled and failed resolutions in order, at most TRACE_MAX_FILLS
// (20,000); fills_truncated counts the ones dropped past the cap (always from the end, so the kept
// rows are an exact prefix). items, rejected, round_trips and the equity points are always whole;
// only the re-adds of fills into items (realized per item, fees, tx fees, filled orders), which need
// every fill, are then reported as not checkable (ok null).
// A rejected order moved nothing and is only counted, per reason, in rejected; an applied clmm hold
// moves nothing either and is no row.
//
// Time. Every point, fill and round trip carries t_ms (ms since the Unix epoch) inside the window:
// the batch's t on bars and clmm, block_time × 1000 carried forward on the pump replay (which keeps
// its slot too). Points ascend by seq and fills by t_ms, so traceAt cuts both at a replay clock.
//
// Browser-safe: zod and the other contracts only, no Node APIs, never grader/ (the mean rule is
// grader/agent-score.ts meanMicro's, re-implemented here and pinned equal by the test).

import { z } from 'zod';
import { BARS_PROTOCOL, barsIssuer, whenBarsValid, type BarsIssue } from './bars-protocol.ts';
import { CLMM_PROTOCOL } from './clmm-protocol.ts';
import { I64, Slot, U64 } from './primitives.ts';
import { HARNESS_CLOSE_KINDS, PROTOCOL } from './protocol.ts';

export const TRACE_FORMAT = 'agent-fun/trace/v1';

/** The most fill rows a pnl trace lists; fills_truncated counts the rest. */
export const TRACE_MAX_FILLS = 20_000;

// ---------------------------------------------------------------- pnl

/** The replay protocols a pnl trace is built from. */
export const TRACE_PROTOCOLS = [PROTOCOL, BARS_PROTOCOL, CLMM_PROTOCOL] as const;

/**
 * The unit every amount of a pnl trace is in, as the engines name it: `lamports` on the pump replay
 * (SOL, 9 decimals: sim/engine.ts *_lamports), `quote_units` on bars and clmm (USDC raw units at the
 * competition's quote_scale, 6 on clmm: sim/bars/engine.ts and sim/clmm/engine.ts *_quote_units).
 */
export const TRACE_UNIT_NAMES = ['lamports', 'quote_units'] as const;

export const TraceUnit = z
  .strictObject({
    name: z.enum(TRACE_UNIT_NAMES),
    /** The asset the unit is of: SOL for lamports, USDC for quote units. */
    asset: z.enum(['SOL', 'USDC']),
    /** An amount a is a / 10^decimals of the asset: 9 for lamports; the quote_scale for quote units. */
    decimals: z.int().min(0).max(18),
  })
  .superRefine((u, ctx) => {
    const issue = barsIssuer(ctx);
    if ((u.name === 'lamports') !== (u.asset === 'SOL')) issue(['asset'], 'lamports are SOL\'s unit, quote units USDC\'s');
    if (u.name === 'lamports' && u.decimals !== 9) issue(['decimals'], 'a lamport is 10^-9 SOL');
  }, whenBarsValid);

/** What a fill row is: a bot's order (pump, bars), a bot's action (clmm), or a harness's close. */
export const TRACE_FILL_KINDS = ['order', 'set_range', 'withdraw', 'complete', 'flatten', 'writeoff', 'close_out'] as const;
export const TraceFillKind = z.enum(TRACE_FILL_KINDS);
/** The harness's closes: the pump replay's (protocol.ts HARNESS_CLOSE_KINDS) and clmm's close-out. Never decided on a batch. */
export const TRACE_CLOSE_KINDS = [...HARNESS_CLOSE_KINDS, 'close_out'] as const;
/** The kinds each protocol's run resolves into. */
export const TRACE_FILL_KINDS_BY_PROTOCOL: Readonly<Record<(typeof TRACE_PROTOCOLS)[number], readonly TraceFillKindT[]>> = {
  [PROTOCOL]: ['order', ...HARNESS_CLOSE_KINDS],
  [BARS_PROTOCOL]: ['order', 'flatten'],
  [CLMM_PROTOCOL]: ['set_range', 'withdraw', 'close_out'],
};

/** An item a run trades: a pump mint, a bars symbol, a clmm pool. */
export const TraceItemName = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'expected an item: 1-64 of [A-Za-z0-9_.:-]');
/** A name of a fee part, a cash movement or a reject reason: snake_case. */
export const TracePartName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'expected a snake_case name');

/** ms since the Unix epoch. */
const TimeMs = z.int().min(0);

/** The account's equity after one batch (and at the start, and after the final close). */
export const TracePoint = z.strictObject({
  /** The batch seq it follows: -1 for the start, the batch count for after the final close. */
  seq: z.int().min(-1),
  t_ms: TimeMs,
  /** The pump replay's slot; absent on bars and clmm. */
  slot: Slot.optional(),
  /** Cash plus every holding at what closing it would pay (each engine's equity). */
  equity: U64,
});

/**
 * One resolution that moved something: a filled or failed order, an applied clmm action, a harness
 * close. Its cash flow and every part of it (the header's identity):
 *   trade    the quote the trade itself moved, before any fee: −(curve quote | spend) on a buy,
 *            +(curve quote | gross) on a sell, 0 without a trade
 *   fees     each fee part, a cost: pump {protocol, creator} (the buyback is a share of protocol, not
 *            an extra charge, so it is no part), bars {pool}, a clmm swap {swap}
 *   tx_fee   base + priority transaction fees (pump only; a failed order pays only these)
 *   other    every other cash movement, signed, by name: a clmm position's mint (negative), its
 *            withdrawal and the fees it collected (positive). Empty on pump and bars.
 */
export const TraceFill = z
  .strictObject({
    /** The batch seq and the order's index in its reply; both null on a harness close. */
    seq: z.int().min(0).nullable(),
    index: z.int().min(0).nullable(),
    kind: TraceFillKind,
    /** The bot's client_id, or a pump or bars close's `_<kind>_<n>`; absent on clmm. */
    client_id: z.string().min(1).max(64).optional(),
    /** filled: it resolved and moved (a fill, a close, an applied clmm action); failed: a pump order whose transaction failed (tx fee paid, nothing traded). */
    status: z.enum(['filled', 'failed']),
    /** When it resolved. */
    t_ms: TimeMs,
    slot: Slot.optional(),
    item: TraceItemName,
    /** null: no trade (a clmm action that only moved liquidity). */
    side: z.enum(['buy', 'sell']).nullable(),
    /** What it traded, in the item's raw units (items[].size_decimals); "0" without a trade. */
    size: U64,
    /** The fill price the harness reports (bars, clmm: at price_scale), value / 10^scale of the unit's asset per whole item; absent on pump (|trade| / size). */
    price: z.strictObject({ value: U64, scale: z.int().min(0).max(18) }).optional(),
    cash_flow: I64,
    trade: I64,
    fees: z.record(TracePartName, U64),
    tx_fee: U64,
    other: z.record(TracePartName, I64),
    /** The account's cash after it. */
    cash_after: U64,
  })
  .superRefine((f, ctx) => {
    const issue = barsIssuer(ctx);
    if (BigInt(f.cash_flow) !== fillPartsSum(f)) issue(['cash_flow'], `cash_flow is trade − fees − tx_fee + other = ${fillPartsSum(f)}, not ${f.cash_flow}`);
    const close = isTraceClose(f.kind);
    if (close !== (f.seq === null) || close !== (f.index === null)) issue(['seq'], 'seq and index are null exactly on a harness close');
    if (f.status === 'failed') {
      if (f.kind !== 'order') issue(['status'], 'only an order fails');
      if (f.trade !== '0' || f.size !== '0') issue(['trade'], 'a failed order traded nothing');
      if (Object.values(f.fees).some((v) => v !== '0') || Object.keys(f.other).length > 0) issue(['fees'], 'a failed order pays only its tx fee');
    }
    const trade = BigInt(f.trade);
    if (f.side === null && (trade !== 0n || f.size !== '0')) issue(['side'], 'a row without a side trades nothing');
    if (f.side === 'buy' && trade > 0n) issue(['trade'], 'a buy\'s trade is cash out: at most 0');
    if (f.side === 'sell' && trade < 0n) issue(['trade'], 'a sell\'s trade is cash in: at least 0');
    if (f.side === null && f.price !== undefined) issue(['price'], 'a row without a trade has no price');
  }, whenBarsValid);

/** One position from open to empty. */
export const TraceRoundTrip = z
  .strictObject({
    item: TraceItemName,
    opened_t_ms: TimeMs,
    closed_t_ms: TimeMs,
    opened_slot: Slot.optional(),
    closed_slot: Slot.optional(),
    /** Every unit in and out while it was open, fees included (the engine's round-trip PnL). */
    pnl: I64,
    /** What its buys paid, curve fees included (pump's bought_lamports). */
    bought: U64.optional(),
    /** A clmm position's tick range. */
    range: z.strictObject({ lower_tick: z.int(), upper_tick: z.int() }).optional(),
  })
  .superRefine((r, ctx) => {
    const issue = barsIssuer(ctx);
    if (r.closed_t_ms < r.opened_t_ms) issue(['closed_t_ms'], 'a round trip closes at or after it opens');
    if (r.range !== undefined && r.range.lower_tick >= r.range.upper_tick) issue(['range'], 'lower_tick < upper_tick');
  }, whenBarsValid);

/** One item's ledger over the whole run (sim TokenLedger, BarsSymbolLedger). */
export const TraceItem = z.strictObject({
  item: TraceItemName,
  /** Σ cash_flow of its fills: fills, closes and failed orders' tx fees. */
  realized: I64,
  /** Σ fee parts of its fills, closes included. */
  fees: U64,
  /** Σ tx_fee of its fills, failed orders included. */
  tx_fees: U64,
  /** The bot's own filled orders and applied actions on it (closes and failed orders excluded). */
  fills: z.int().min(0),
  /** Decimals of its size unit: pump.fun mints 6, a bars symbol its qty_scale, a clmm pool its asset's decimals. */
  size_decimals: z.int().min(0).max(18),
});

export const PnlTrace = z
  .strictObject({
    format: z.literal(TRACE_FORMAT),
    kind: z.literal('pnl'),
    protocol: z.enum(TRACE_PROTOCOLS),
    unit: TraceUnit,
    start_equity: U64,
    end_equity: U64,
    /** end − start, as the score states it. */
    net: I64,
    /** The replayed window: every t_ms of the trace lies in it. */
    window: z.strictObject({ start_ms: TimeMs, end_ms: TimeMs }),
    /** Equity at the start, after every batch and after the final close, ascending by seq. */
    points: z.array(TracePoint).min(1),
    /** Filled and failed resolutions in resolution order, the first TRACE_MAX_FILLS. */
    fills: z.array(TraceFill).max(TRACE_MAX_FILLS),
    /** Filled and failed resolutions past the cap, not listed. */
    fills_truncated: z.int().min(0),
    /** Rejected orders (nothing moved), counted per reason; a reason appears only when it happened. */
    rejected: z.record(TracePartName, z.int().min(1)),
    round_trips: z.array(TraceRoundTrip),
    /** One row per item, each item once. */
    items: z.array(TraceItem),
  })
  .superRefine((t, ctx) => {
    const issue = barsIssuer(ctx);
    if ((t.protocol === PROTOCOL) !== (t.unit.name === 'lamports')) issue(['unit', 'name'], `${t.protocol} counts in ${t.protocol === PROTOCOL ? 'lamports' : 'quote_units'}`);
    const { start_ms, end_ms } = t.window;
    if (end_ms < start_ms) issue(['window', 'end_ms'], 'the window ends at or after it starts');
    const inWindow = (ms: number, at: (string | number)[]): void => {
      if (ms < start_ms || ms > end_ms) issue(at, `${ms} lies outside the window [${start_ms}, ${end_ms}]`);
    };
    t.points.forEach((p, i) => {
      inWindow(p.t_ms, ['points', i, 't_ms']);
      const prev = t.points[i - 1];
      if (prev !== undefined && p.seq <= prev.seq) issue(['points', i, 'seq'], 'points ascend by seq');
      if (prev !== undefined && p.t_ms < prev.t_ms) issue(['points', i, 't_ms'], 'a point is never earlier than the one before');
    });
    const items = new Set<string>();
    t.items.forEach((it, i) => {
      if (items.has(it.item)) issue(['items', i, 'item'], `${it.item} has one row`);
      items.add(it.item);
    });
    const kinds = TRACE_FILL_KINDS_BY_PROTOCOL[t.protocol];
    t.fills.forEach((f, i) => {
      inWindow(f.t_ms, ['fills', i, 't_ms']);
      const prev = t.fills[i - 1];
      if (prev !== undefined && f.t_ms < prev.t_ms) issue(['fills', i, 't_ms'], 'fills are in resolution order: never earlier than the one before');
      if (!items.has(f.item)) issue(['fills', i, 'item'], `${f.item} has no items row`);
      if (!kinds.includes(f.kind)) issue(['fills', i, 'kind'], `a ${t.protocol} run has no ${f.kind} rows`);
    });
    if (t.fills_truncated > 0 && t.fills.length !== TRACE_MAX_FILLS) issue(['fills_truncated'], `fills are dropped only past the first ${TRACE_MAX_FILLS}`);
    t.round_trips.forEach((r, i) => {
      inWindow(r.opened_t_ms, ['round_trips', i, 'opened_t_ms']);
      inWindow(r.closed_t_ms, ['round_trips', i, 'closed_t_ms']);
      if (!items.has(r.item)) issue(['round_trips', i, 'item'], `${r.item} has no items row`);
    });
  }, whenBarsValid);

// ---------------------------------------------------------------- checks

/** The largest magnitude a checks value may have: its count of 10^-6 stays a safe integer. */
export const CHECK_POINTS_MAX = 9_000_000_000;

/** Whether x is a checks value: finite, of magnitude at most CHECK_POINTS_MAX, with at most six decimals. */
export function isCheckPoints(x: number): boolean {
  return Number.isFinite(x) && Math.abs(x) <= CHECK_POINTS_MAX && Math.round(x * 1e6) / 1e6 === x;
}

/** A score value: a finite number with at most six decimals (an integer point on agent/v1, a scores.json number on program/v1). */
export const CheckPoints = z.number().refine(isCheckPoints, `expected a finite number with at most six decimals, of magnitude at most ${CHECK_POINTS_MAX}`);

/** One score part: a leaderboard column, or one check of a scorer's. */
export const ChecksPart = z.strictObject({
  key: z.string().min(1).max(128),
  /** A heading parts are shown under. */
  group: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(256),
  /** null: no stated maximum. */
  max: CheckPoints.nullable(),
  /** aggregation sum: what it earned (null: the scorer left it unscored; it adds 0). */
  earned: CheckPoints.nullable().optional(),
  /** aggregation mean: what it earned on each trial, in trial order. */
  earned_by_trial: z.array(CheckPoints).optional(),
});

export const ChecksTrace = z
  .strictObject({
    format: z.literal(TRACE_FORMAT),
    kind: z.literal('checks'),
    /** sum: program/v1, one run, total = Σ earned. mean: agent/v1, total = the mean over trials of each trial's Σ earned. */
    aggregation: z.enum(['sum', 'mean']),
    /** 1 on sum; K on mean. */
    trials: z.int().min(1),
    parts: z.array(ChecksPart).min(1),
    /** The score the parts make (checksTotalMicro, as a number to six decimals). */
    total: CheckPoints,
  })
  .superRefine((t, ctx) => {
    const issue = barsIssuer(ctx);
    if (t.aggregation === 'sum' && t.trials !== 1) issue(['trials'], 'a sum is of one run: trials 1');
    const keys = new Set<string>();
    t.parts.forEach((p, i) => {
      if (keys.has(p.key)) issue(['parts', i, 'key'], `${p.key} appears once`);
      keys.add(p.key);
      checkPartShape(p, t.aggregation, t.trials, ['parts', i], issue);
    });
  }, whenBarsValid);

function checkPartShape(p: ChecksPartT, aggregation: 'sum' | 'mean', trials: number, at: (string | number)[], issue: BarsIssue): void {
  if (aggregation === 'sum') {
    if (p.earned === undefined) issue([...at, 'earned'], 'a part of a sum states earned');
    if (p.earned_by_trial !== undefined) issue([...at, 'earned_by_trial'], 'a part of a sum has no per-trial scores');
  } else {
    if (p.earned !== undefined) issue([...at, 'earned'], 'a part of a mean states earned_by_trial, not earned');
    if (p.earned_by_trial?.length !== trials) issue([...at, 'earned_by_trial'], `a part of a mean states one score per trial: ${trials}`);
  }
}

export const Trace = z.discriminatedUnion('kind', [PnlTrace, ChecksTrace]);

export type TraceT = z.infer<typeof Trace>;
export type PnlTraceT = z.infer<typeof PnlTrace>;
export type ChecksTraceT = z.infer<typeof ChecksTrace>;
export type TraceUnitT = z.infer<typeof TraceUnit>;
export type TracePointT = z.infer<typeof TracePoint>;
export type TraceFillT = z.infer<typeof TraceFill>;
export type TraceFillKindT = z.infer<typeof TraceFillKind>;
export type TraceRoundTripT = z.infer<typeof TraceRoundTrip>;
export type TraceItemT = z.infer<typeof TraceItem>;
export type ChecksPartT = z.infer<typeof ChecksPart>;

// ---------------------------------------------------------------- arithmetic

const MICRO = 1_000_000n;

/** Whether a fill kind is a harness close (never decided on a batch). */
export function isTraceClose(kind: TraceFillKindT): boolean {
  return (TRACE_CLOSE_KINDS as readonly string[]).includes(kind);
}

/** A fill's parts re-added: trade − Σ fees − tx_fee + Σ other (its cash_flow when it reconciles). */
export function fillPartsSum(f: Pick<TraceFillT, 'trade' | 'fees' | 'tx_fee' | 'other'>): bigint {
  let s = BigInt(f.trade) - BigInt(f.tx_fee);
  for (const v of Object.values(f.fees)) s -= BigInt(v);
  for (const v of Object.values(f.other)) s += BigInt(v);
  return s;
}

/** n / d rounded to the nearest integer, half away from zero (d > 0): grader/agent-score.ts divRound. */
export function divRoundHalfAway(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError(`divide by ${d}: the divisor is above 0`);
  const q = (2n * (n < 0n ? -n : n) + d) / (2n * d);
  return n < 0n ? -q : q;
}

/** The mean of integer points in 10^-6: Σ · 10^6 / K, half away from zero (grader/agent-score.ts meanMicro's rule). */
export function meanMicroOf(points: readonly bigint[]): bigint {
  if (points.length === 0) throw new RangeError('a mean needs at least one value');
  return divRoundHalfAway(points.reduce((s, x) => s + x, 0n) * MICRO, BigInt(points.length));
}

/** A checks value as its exact count of 10^-6. Throws on anything CheckPoints refuses. */
export function toMicro(x: number): bigint {
  if (!isCheckPoints(x)) throw new RangeError(`${x} is not a finite number with at most six decimals, of magnitude at most ${CHECK_POINTS_MAX}`);
  return BigInt(Math.round(x * 1e6));
}

/** A count of 10^-6 as a plain decimal, trailing zeros dropped: 87500000n -> "87.5", -1n -> "-0.000001". */
export function formatMicro(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const frac = (abs % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / MICRO}${frac === '' ? '' : `.${frac}`}`;
}

/**
 * The total a checks trace's parts make, in 10^-6. sum: Σ earned (null adds 0). mean: the integer-sum
 * mean, divRound(Σ trials Σ parts earned · 10^6, K), half away from zero: the mean of the per-trial
 * totals, rounded once (summing per-part means, each rounded, could drift a unit per part). On integer
 * points it is meanMicroOf(per-trial totals).
 */
export function checksTotalMicro(t: Pick<ChecksTraceT, 'aggregation' | 'trials' | 'parts'>): bigint {
  let sum = 0n;
  if (t.aggregation === 'sum') {
    for (const p of t.parts) if (p.earned !== undefined && p.earned !== null) sum += toMicro(p.earned);
    return sum;
  }
  for (const p of t.parts) for (const e of p.earned_by_trial ?? []) sum += toMicro(e);
  return divRoundHalfAway(sum, BigInt(t.trials));
}

// ---------------------------------------------------------------- traceSums

/**
 * One identity re-added: its two sides as decimal strings (integers of the trace's unit on pnl,
 * counts for counts, plain decimals on checks), in the order the name reads them. ok null: not
 * checkable, because fills were truncated (rhs is then the sum over the kept rows only).
 */
export interface TraceSum {
  name: string;
  lhs: string;
  rhs: string;
  ok: boolean | null;
}

function sum(name: string, lhs: bigint, rhs: bigint, checkable = true): TraceSum {
  return { name, lhs: lhs.toString(), rhs: rhs.toString(), ok: checkable ? lhs === rhs : null };
}

/**
 * Every identity the trace states, re-added from its rows (the header's list). pnl, in order: each
 * fill's parts; the cash_after chain; per item, Σ its fills' cash_flow = realized; Σ fills' fees,
 * tx fees and filled orders = the items'; Σ items.realized = net; start + net = end; the first and
 * last points = start and end. checks: Σ parts = total, or the integer-sum mean = total.
 */
export function traceSums(trace: TraceT): TraceSum[] {
  return trace.kind === 'pnl' ? pnlSums(trace) : checksSums(trace);
}

function pnlSums(t: PnlTraceT): TraceSum[] {
  const start = BigInt(t.start_equity);
  const end = BigInt(t.end_equity);
  const net = BigInt(t.net);
  const whole = t.fills_truncated === 0;
  let flows = 0n;
  let parts = 0n;
  let partsOk = true;
  let cash = start;
  let chainOk = true;
  let fees = 0n;
  let txFees = 0n;
  let filled = 0;
  const byItem = new Map<string, bigint>();
  for (const f of t.fills) {
    const flow = BigInt(f.cash_flow);
    const p = fillPartsSum(f);
    flows += flow;
    parts += p;
    if (p !== flow) partsOk = false;
    const after = BigInt(f.cash_after);
    if (cash + flow !== after) chainOk = false;
    cash = after;
    for (const v of Object.values(f.fees)) fees += BigInt(v);
    txFees += BigInt(f.tx_fee);
    if (f.status === 'filled' && !isTraceClose(f.kind)) filled++;
    byItem.set(f.item, (byItem.get(f.item) ?? 0n) + flow);
  }
  const out: TraceSum[] = [];
  out.push({ ...sum('each fill: cash_flow = trade − fees − tx_fee + other', flows, parts), ok: partsOk });
  out.push({ ...sum('start_equity + Σ cash_flow = last cash_after', start + flows, cash), ok: chainOk });
  let realized = 0n;
  let itemFees = 0n;
  let itemTx = 0n;
  let itemFills = 0;
  for (const it of t.items) {
    realized += BigInt(it.realized);
    itemFees += BigInt(it.fees);
    itemTx += BigInt(it.tx_fees);
    itemFills += it.fills;
    out.push(sum(`Σ fills.cash_flow on ${it.item} = realized`, byItem.get(it.item) ?? 0n, BigInt(it.realized), whole));
  }
  out.push(sum('Σ fills.fees = Σ items.fees', fees, itemFees, whole));
  out.push(sum('Σ fills.tx_fee = Σ items.tx_fees', txFees, itemTx, whole));
  out.push(sum('filled orders = Σ items.fills', BigInt(filled), BigInt(itemFills), whole));
  out.push(sum('Σ items.realized = net', realized, net));
  out.push(sum('start_equity + net = end_equity', start + net, end));
  const first = t.points[0];
  const last = t.points[t.points.length - 1];
  if (first !== undefined) out.push(sum('first point = start_equity', BigInt(first.equity), start));
  if (last !== undefined) out.push(sum('last point = end_equity', BigInt(last.equity), end));
  return out;
}

function checksSums(t: ChecksTraceT): TraceSum[] {
  const parts = checksTotalMicro(t);
  const total = toMicro(t.total);
  const name = t.aggregation === 'sum' ? 'Σ parts.earned = total' : `mean over ${t.trials} trials of Σ parts.earned = total`;
  return [{ name, lhs: formatMicro(parts), rhs: formatMicro(total), ok: parts === total }];
}

// ---------------------------------------------------------------- traceAt

/** A pnl trace as it stood at t_ms on the replay's clock. */
export interface TraceAt {
  t_ms: number;
  /** Points and fills with t_ms ≤ t (prefixes), and the round trips closed by t. */
  points: TracePointT[];
  fills: TraceFillT[];
  round_trips: TraceRoundTripT[];
  /** The last point's equity at or before t; start_equity before the first. */
  equity: string;
  /** equity − start_equity. */
  net: string;
  /**
   * The items rows with a fill (filled or failed) at or before t, in the stored rows' order, each re-added from those
   * fills: never a row for an item first traded after t. The stored rows, every one, once the window has ended.
   */
  items: TraceItemT[];
  /** Σ items.realized so far. */
  realized: string;
  /** equity − start_equity − realized: what the held positions would add if closed now. */
  unrealized: string;
  /** false when dropped fills (fills_truncated) may lie at or before t: items, realized and unrealized then undercount them. */
  exact: boolean;
}

/** How many rows of a list ascending by t_ms lie at or before t. */
function countUpTo(rows: readonly { t_ms: number }[], t: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid]!.t_ms <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A pnl trace cut at t_ms: what the running phase shows at that point of its clock, and the
 * breakdown clamped to it. Points and fills are cut at t (both ascend by t_ms, which PnlTrace
 * enforces); the items with a fill so far, and only those, have their realized, fees, tx fees and
 * filled orders re-added from those fills (an item the run first trades after t has no row, so the
 * cut names no coin before the clock reaches it), and unrealized is the rest of the equity's move.
 * Once t reaches the window's end the run is over and the stored items rows stand, every one (exact
 * even when fills were truncated).
 *
 * A checks trace has no clock: its scores are the run's, not a path through time (the
 * freeze-and-resolve reveal of program/v1 and agent/v1 parts is its own engine). traceAt takes only
 * a pnl trace and throws a TypeError on any other.
 */
export function traceAt(trace: PnlTraceT, t_ms: number): TraceAt {
  if ((trace as TraceT).kind !== 'pnl') throw new TypeError(`traceAt cuts a pnl trace on its clock; a ${(trace as TraceT).kind} trace has none`);
  if (!Number.isFinite(t_ms)) throw new RangeError(`t_ms ${t_ms} is not a finite time`);
  const start = BigInt(trace.start_equity);
  const points = trace.points.slice(0, countUpTo(trace.points, t_ms));
  const fills = trace.fills.slice(0, countUpTo(trace.fills, t_ms));
  const round_trips = trace.round_trips.filter((r) => r.closed_t_ms <= t_ms);
  const equity = points.length > 0 ? BigInt(points[points.length - 1]!.equity) : start;
  const over = t_ms >= trace.window.end_ms;
  let items: TraceItemT[];
  let exact: boolean;
  if (over) {
    items = trace.items.map((it) => ({ ...it }));
    exact = true;
  } else {
    const so = new Map<string, { realized: bigint; fees: bigint; tx: bigint; fills: number }>();
    for (const f of fills) {
      const a = so.get(f.item) ?? { realized: 0n, fees: 0n, tx: 0n, fills: 0 };
      a.realized += BigInt(f.cash_flow);
      for (const v of Object.values(f.fees)) a.fees += BigInt(v);
      a.tx += BigInt(f.tx_fee);
      if (f.status === 'filled' && !isTraceClose(f.kind)) a.fills++;
      so.set(f.item, a);
    }
    // Only the items with a fill so far: a row for one the run trades later would name it (and its place in the stored
    // order) before the clock reaches it, which is the replay's future.
    items = [];
    for (const it of trace.items) {
      const a = so.get(it.item);
      if (a === undefined) continue;
      items.push({ item: it.item, realized: a.realized.toString(), fees: a.fees.toString(), tx_fees: a.tx.toString(), fills: a.fills, size_decimals: it.size_decimals });
    }
    // Dropped fills follow the kept ones, so none lies at or before t while t is before the last kept fill.
    const lastKept = trace.fills[trace.fills.length - 1];
    exact = trace.fills_truncated === 0 || (lastKept !== undefined && t_ms < lastKept.t_ms);
  }
  const realized = items.reduce((s, it) => s + BigInt(it.realized), 0n);
  return {
    t_ms,
    points,
    fills,
    round_trips,
    equity: equity.toString(),
    net: (equity - start).toString(),
    items,
    realized: realized.toString(),
    unrealized: (equity - start - realized).toString(),
    exact,
  };
}

// ---------------------------------------------------------------- downsample

/**
 * At most n of the points, for a chart: always the first, the last and the global lowest and highest
 * equity, the rest min/max decimation. The interior (every point but the first and last) is cut by
 * index into floor((n − 2) / 2) buckets of near-equal size, and each bucket keeps its lowest and its
 * highest point (the earliest on a tie), so every dip and spike the full curve shows survives as a
 * vertex. Deterministic; the result keeps the input's order. n is an integer of at least 4 (first,
 * last, min and max can be four points); a list of at most n points comes back whole.
 */
export function downsample<P extends { equity: string }>(points: readonly P[], n: number): P[] {
  if (!Number.isSafeInteger(n) || n < 4) throw new RangeError(`downsample keeps at least 4 points (first, last, min, max), not ${n}`);
  const len = points.length;
  if (len <= n) return points.slice();
  const value = points.map((p) => BigInt(p.equity));
  const inner = len - 2;
  const buckets = Math.floor((n - 2) / 2);
  const keep = new Set<number>([0, len - 1]);
  for (let b = 0; b < buckets; b++) {
    const from = 1 + Math.floor((b * inner) / buckets);
    const to = 1 + Math.floor(((b + 1) * inner) / buckets);
    let lo = from;
    let hi = from;
    for (let i = from + 1; i < to; i++) {
      if (value[i]! < value[lo]!) lo = i;
      if (value[i]! > value[hi]!) hi = i;
    }
    keep.add(lo);
    keep.add(hi);
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]!);
}
