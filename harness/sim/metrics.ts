// Replay metrics (contracts/score.ts ReplayMetrics) from a finished run, in BigInt fixed point: ratios
// are integers scaled by 1e9 (Fixed9), square roots are integer square roots, and every division
// truncates toward zero (BigInt `/`), so a score is byte-stable on every machine.
//
//   net_pnl_lamports   final cash after flattening - starting cash (the rank key)
//   return             net PnL / starting cash
//   sharpe, sortino    per-hour, NOT annualized, on hourly equity marks: marks[0] is the starting
//                      cash; marks[k+1] is the equity at the end of hour k counted from the first block
//                      time of the dataset (carried forward through empty hours), the last one after
//                      the final flatten. r_i = (m_i - m_{i-1}) / m_{i-1} (0 when m_{i-1} is 0).
//                      sharpe = mean(r) / sample stdev(r) (n - 1); sortino = mean(r) /
//                      sqrt(sum(min(r, 0)^2) / n). Null with fewer than two returns or a zero
//                      denominator.
//   max_drawdown       largest (peak - equity) / peak over every equity point (each batch, the start
//                      and the end), 0..1
//   win_rate           round trips with PnL > 0 / round trips (a round trip runs from the fill that
//                      opens a position to the one that closes it, tx fees included); null with none
//   fills              the bot's own filled orders (harness closes excluded); rejected and failed_txs
//                      count its other orders; distinct_mints the mints it filled an order on
//   fees_lamports      curve fees (protocol + creator) paid, closes included; tx_fees_lamports every
//                      base + priority fee paid (fills, failed txs, closes)
//   per_token          realized PnL per mint (every lamport in and out on it); they add up to net PnL
//   interval           paired, seeded bootstrap of net PnL resampling the universe's tokens: the
//                      per-token PnL of EVERY universe mint of the dataset, in code-unit mint order
//                      (0 for a mint the bot never touched), B resamples of that list (with
//                      replacement, same size), sums sorted, nearest-rank quantiles at
//                      (1 - level)/2 and (1 + level)/2. SplitMix64 seeded from the phase seed
//                      (hello.seed: one per competition, phase and dataset). The draws depend only
//                      on (seed, universe size), so every entry of a phase is resampled with the same
//                      indices and two entries' intervals compare the same coins (paired); a bot
//                      cannot narrow its interval by trading fewer coins
//   cost_sensitivity   the same action log replayed with every curve fee bps and tx fee multiplied
//                      (default 2x). Buys keep their lamports; each sell sent at 1x (filled or failed)
//                      sells the same share of the position it sold there (the log's token amounts were sized
//                      against 1x fills, so a 'sell everything' would otherwise be refused as
//                      insufficient_tokens and the position ride to the flatten)
//   constraints        the competition's guardrails evaluated: fills >= min_fills, coins >= min_distinct_mints,
//                      max_drawdown at or under its cap. With the round-trip rule (guardrails.round_trips)
//                      a coin counts only when it holds a round trip whose buy fills spent at least
//                      round_trips.min_buy_lamports (order-splitting merges into one round trip, a dust
//                      round trip stays below the floor), and constraints.round_trips reports the count;
//                      without it every coin with a filled order counts and that key is absent
//   contamination     the run's no-future-events certificate, the final window's first block time
//                      against the last graded receipt, and the dataset digest
//   counterparties     opt-in (MetricsParams.counterparties, the harness's counterparties: true; absent
//                      otherwise, so a score without it keeps its bytes): per coin the bot held, the
//                      distinct TradeEvent.user wallets of the recorded trades on it in a slot s with
//                      opened_slot < s <= closed_slot of one of its round trips (a fill lands after its
//                      slot's recorded trades, so the opening slot's came before the bot held it, the
//                      closing slot's while it still did), the creator's own trades counted like any
//                      other's; distinct over every held coin at once, and the fewest on one coin
//                      (countCounterparties). Net PnL stays the rank key
//
// The bars replay's metrics (contracts/score.ts BarsReplayMetrics) are at the end of this file
// (scoreBarsActionLog), on the same fixed-point tools.

import type { z } from 'zod';
import { BAR_INTERVAL_MS, type BarIntervalT, type BarsGuardrailsT } from '../contracts/bars-protocol.ts';
import type { Guardrails } from '../contracts/competition.ts';
import type { ChainEventT } from '../contracts/events.ts';
import { parseFixed9, toFixed9 } from '../contracts/primitives.ts';
import { BarsReplayMetrics, ReplayMetrics, type BarsReplayMetricsT, type CounterpartiesT, type ReplayMetricsT } from '../contracts/score.ts';
import { decisionAccepted, replayBarsActionLog, type BarsActionLogT, type BarsDataset, type BarsRun } from './bars/engine.ts';
import { replayActionLog, sellShares, SimAbortError, type ActionLogT, type EngineOptions, type ReplayDataset, type ReplayRun, type RoundTrip } from './engine.ts';
import { keyedU64, RNG_DOMAIN, SplitMix64 } from './rng.ts';

export type GuardrailsT = z.infer<typeof Guardrails>;

export const SCALE = 1_000_000_000n;
export const HOUR_SECONDS = 3600;
export const DEFAULT_COST_MULTIPLIER = 2;

/** floor(sqrt(n)) for n >= 0 (Newton's method on BigInt). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative number');
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** a / b as Fixed9 scaled BigInt (truncated toward zero). */
export const ratio9 = (a: bigint, b: bigint): bigint => (a * SCALE) / b;

/** Hourly equity marks (lamports) from a run's equity points; see the header for the rule. */
export function hourlyMarks(run: Pick<ReplayRun, 'equity' | 'start_lamports' | 'first_block_time'>): bigint[] {
  const start = BigInt(run.start_lamports);
  const pts = run.equity;
  const last = pts[pts.length - 1];
  if (last === undefined) return [start];
  const t0 = run.first_block_time;
  if (t0 === null) return [start, BigInt(last.equity_lamports)];
  const marks: bigint[] = [start];
  let bucket = 0;
  let current = start;
  for (const p of pts) {
    const k = p.block_time === null ? bucket : Math.max(bucket, Math.floor((p.block_time - t0) / HOUR_SECONDS));
    while (bucket < k) {
      marks.push(current);
      bucket++;
    }
    current = BigInt(p.equity_lamports);
  }
  marks.push(current);
  return marks;
}

/** Per-period returns (Fixed9 scaled) of consecutive marks. */
export function periodReturns(marks: readonly bigint[]): bigint[] {
  const out: bigint[] = [];
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1]!;
    out.push(prev === 0n ? 0n : ratio9(marks[i]! - prev, prev));
  }
  return out;
}

// The deviations are taken at scale 1e18 (isqrt of a 1e36-scaled variance) so the ratio keeps its
// full 1e-9 precision; only the final division truncates.
const SCALE2 = SCALE * SCALE;

/** mean / sample stdev (n - 1), Fixed9 scaled; null with fewer than two returns or zero variance. */
export function sharpe9(r: readonly bigint[]): bigint | null {
  const n = BigInt(r.length);
  if (n < 2n) return null;
  let s = 0n;
  let s2 = 0n;
  for (const x of r) {
    s += x;
    s2 += x * x;
  }
  // var = (n*sum(x^2) - sum(x)^2) / (n*(n-1)) in scale^2 units; sd18 = sqrt(var) at scale 1e18.
  const sd18 = isqrt(((n * s2 - s * s) * SCALE2) / (n * (n - 1n)));
  if (sd18 === 0n) return null;
  return (s * SCALE2) / (n * sd18);
}

/** mean / sqrt(sum(min(r,0)^2) / n), Fixed9 scaled; null with fewer than two returns or no downside. */
export function sortino9(r: readonly bigint[]): bigint | null {
  const n = BigInt(r.length);
  if (n < 2n) return null;
  let s = 0n;
  let d2 = 0n;
  for (const x of r) {
    s += x;
    if (x < 0n) d2 += x * x;
  }
  const dd18 = isqrt((d2 * SCALE2) / n);
  if (dd18 === 0n) return null;
  return (s * SCALE2) / (n * dd18);
}

/** Largest peak-to-trough share, Fixed9 scaled (0 when equity never falls below a positive peak). */
export function maxDrawdown9(equity: readonly bigint[]): bigint {
  let peak = 0n;
  let worst = 0n;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (peak > 0n) {
      const dd = ratio9(peak - e, peak);
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

// The BigInt draws dominate a scoring, and every entry of a phase draws the same ones, so the index
// table (resamples x n, row-major in draw order) is kept for the last two (seed, n, resamples) keys.
// Every index is < n, so a table is Uint16 while n <= 65,536 (Uint32 past it). A table past
// BOOTSTRAP_MEMO_MAX_BYTES is never built: that call draws inline. Worst case 2 x 16 MiB held.
export const BOOTSTRAP_MEMO_MAX_BYTES = 16 * 1024 * 1024;
const BOOTSTRAP_MEMO_SIZE = 2;
type IndexTable = Uint16Array | Uint32Array;
const bootstrapMemo = new Map<string, IndexTable>();
let bootstrapTableDraws = 0;

/** Index tables drawn so far (a test seam: a memo hit draws none). */
export const bootstrapIndexTableDraws = (): number => bootstrapTableDraws;

/** Bytes the (n, resamples) index table would take. */
export const bootstrapTableBytes = (n: number, resamples: number): number => resamples * n * (n <= 65_536 ? 2 : 4);

function bootstrapIndexTable(seed: bigint, n: number, resamples: number): IndexTable {
  const key = `${seed}:${n}:${resamples}`;
  const hit = bootstrapMemo.get(key);
  if (hit !== undefined) {
    bootstrapMemo.delete(key);
    bootstrapMemo.set(key, hit);
    return hit;
  }
  const rng = new SplitMix64(keyedU64(seed, RNG_DOMAIN.bootstrap));
  const nb = BigInt(n);
  const table = n <= 65_536 ? new Uint16Array(resamples * n) : new Uint32Array(resamples * n);
  for (let i = 0; i < table.length; i++) table[i] = Number(rng.below(nb));
  bootstrapTableDraws++;
  bootstrapMemo.set(key, table);
  if (bootstrapMemo.size > BOOTSTRAP_MEMO_SIZE) bootstrapMemo.delete(bootstrapMemo.keys().next().value!);
  return table;
}

/**
 * Seeded bootstrap interval of a sum, resampling the items; nearest-rank quantiles. The resample
 * indices depend only on (seed, values.length), never on the values: lists of one length under one
 * seed are resampled identically (paired).
 */
export function bootstrapInterval(values: readonly bigint[], level: bigint, resamples: number, seed: bigint): { low: bigint; high: bigint } {
  if (!Number.isInteger(resamples) || resamples < 1) throw new RangeError('resamples must be a positive integer');
  if (level <= 0n || level >= SCALE) throw new RangeError('level must be strictly between 0 and 1');
  const n = values.length;
  if (n === 0) return { low: 0n, high: 0n };
  const sums: bigint[] = new Array(resamples);
  if (bootstrapTableBytes(n, resamples) <= BOOTSTRAP_MEMO_MAX_BYTES) {
    const table = bootstrapIndexTable(seed, n, resamples);
    for (let b = 0, i = 0; b < resamples; b++) {
      let sum = 0n;
      for (let j = 0; j < n; j++, i++) {
        const v = values[table[i]!]!;
        if (v !== 0n) sum += v;
      }
      sums[b] = sum;
    }
  } else {
    const rng = new SplitMix64(keyedU64(seed, RNG_DOMAIN.bootstrap));
    const nb = BigInt(n);
    for (let b = 0; b < resamples; b++) {
      let sum = 0n;
      for (let j = 0; j < n; j++) {
        const v = values[Number(rng.below(nb))]!;
        if (v !== 0n) sum += v;
      }
      sums[b] = sum;
    }
  }
  sums.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const B = BigInt(resamples);
  const rank = (num: bigint) => {
    const r = (num * B + 2n * SCALE - 1n) / (2n * SCALE); // ceil(num * B / (2 * SCALE))
    const idx = Number(r < 1n ? 0n : r - 1n);
    return Math.min(idx, resamples - 1);
  };
  return { low: sums[rank(SCALE - level)]!, high: sums[rank(SCALE + level)]! };
}

export interface MetricsParams {
  guardrails: GuardrailsT;
  /** The interval reported next to the rank key (competition harness.interval). */
  interval: { level: string; resamples: number };
  /** Final phase: the server time of the last graded receipt. Null on the dev phase. */
  final_window: { last_graded_receipt_at: string } | null;
  /**
   * The distinct-counterparties metric (the header; harness counterparties: true): true computes
   * ReplayMetrics.counterparties from the dataset's TradeEvents. Absent or false: no such key.
   */
  counterparties?: boolean;
}

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/**
 * The bootstrap's items: the realized PnL of every universe mint, in the run's universe order
 * (code units), 0 for a mint the bot never touched. Every mint with a cash flow is a universe mint
 * (orders on any other are rejected before anything is paid); one that is not is a sim bug.
 */
export function universePnl(run: Pick<ReplayRun, 'universe' | 'per_token'>): bigint[] {
  const pnl = new Map(run.per_token.map((t) => [t.mint, BigInt(t.realized_pnl_lamports)]));
  const out = run.universe.members.map((mint) => {
    const v = pnl.get(mint) ?? 0n;
    pnl.delete(mint);
    return v;
  });
  if (pnl.size > 0) throw new SimAbortError(`per-token PnL for ${pnl.size} mint(s) outside the universe, first ${[...pnl.keys()][0]}`);
  return out;
}

/** The round trips whose buy fills paid at least `minBuy`, and the distinct mints holding one. */
export function countedRoundTrips(trips: readonly Pick<RoundTrip, 'mint' | 'bought_lamports'>[], minBuy: bigint): { counted: number; counted_mints: number } {
  let counted = 0;
  const mints = new Set<string>();
  for (const t of trips) {
    if (BigInt(t.bought_lamports) < minBuy) continue;
    counted++;
    mints.add(t.mint);
  }
  return { counted, counted_mints: mints.size };
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The distinct-counterparties metric (contracts/score.ts Counterparties; the header) of a run's round
 * trips over the dataset's records: per coin with a round trip, the distinct TradeEvent.user of its
 * recorded trades in a slot s with opened_slot < s <= closed_slot of one of its round trips; in code-
 * unit mint order, with the distinct wallets over every such coin at once and the fewest on one coin
 * (null with no round trip). Records of any other kind or coin are skipped, in any order.
 */
export function countCounterparties(events: Iterable<ChainEventT>, trips: readonly Pick<RoundTrip, 'mint' | 'opened_slot' | 'closed_slot'>[]): CounterpartiesT {
  // Each coin's holds as (from, to] slot ranges. A coin's round trips follow one another, so its
  // ranges never overlap and the one that can hold slot s is the last opened before s.
  const holds = new Map<string, { from: number; to: number }[]>();
  for (const t of trips) {
    const list = holds.get(t.mint) ?? [];
    list.push({ from: t.opened_slot, to: t.closed_slot });
    holds.set(t.mint, list);
  }
  const wallets = new Map<string, Set<string>>();
  for (const [mint, list] of holds) {
    list.sort((a, b) => a.from - b.from || a.to - b.to);
    wallets.set(mint, new Set());
  }
  for (const e of events) {
    if (e.event !== 'TradeEvent') continue;
    const list = holds.get(e.mint);
    if (list === undefined) continue;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.from < e.slot) lo = mid + 1;
      else hi = mid;
    }
    const hold = list[lo - 1];
    if (hold !== undefined && e.slot <= hold.to) wallets.get(e.mint)!.add(e.user);
  }
  const all = new Set<string>();
  let min: number | null = null;
  const perCoin = [...wallets.keys()].sort(byCodeUnits).map((mint) => {
    const set = wallets.get(mint)!;
    for (const w of set) all.add(w);
    min = min === null ? set.size : Math.min(min, set.size);
    return { mint, distinct: set.size };
  });
  return { distinct: all.size, min_per_coin: min, per_coin: perCoin };
}

/**
 * ReplayMetrics of a run, with the cost-sensitivity run of the same action log. `events` (the
 * dataset's records) is read only when params.counterparties is true, and then required.
 */
export function computeMetrics(run: ReplayRun, costRun: ReplayRun, params: MetricsParams, events?: Iterable<ChainEventT>): ReplayMetricsT {
  if (run.aborted !== null) throw new SimAbortError(`run aborted: ${run.aborted}`);
  if (costRun.aborted !== null) throw new SimAbortError(`cost-sensitivity run aborted: ${costRun.aborted}`);
  if (params.counterparties === true && events === undefined) throw new RangeError('the counterparties metric counts the dataset\'s trades: pass its events');
  const start = BigInt(run.start_lamports);
  const net = BigInt(run.final_account.cash_lamports) - start;
  const costNet = BigInt(costRun.final_account.cash_lamports) - BigInt(costRun.start_lamports);

  const returns = periodReturns(hourlyMarks(run));
  const sharpe = sharpe9(returns);
  const sortino = sortino9(returns);
  const dd = maxDrawdown9(run.equity.map((p) => BigInt(p.equity_lamports)));

  const wins = run.round_trips.filter((t) => BigInt(t.pnl_lamports) > 0n).length;
  const trips = run.round_trips.length;

  let fills = 0;
  let rejected = 0;
  let failed = 0;
  let fees = 0n;
  let txFees = 0n;
  let fallback = 0;
  const filledMints = new Set<string>();
  for (const f of run.resolutions) {
    txFees += BigInt(f.tx_fee_lamports);
    if (f.status === 'failed') failed++;
    if (f.status === 'filled') {
      fees += BigInt(f.fee_lamports);
      if (f.fee_fallback) fallback++;
    }
    if (f.kind !== 'order') continue;
    if (f.status === 'rejected') rejected++;
    if (f.status === 'filled') {
      fills++;
      filledMints.add(f.mint);
    }
  }

  const level = parseFixed9(params.interval.level);
  const ci = bootstrapInterval(universePnl(run), level, params.interval.resamples, BigInt(run.hello.seed));

  const g = params.guardrails;
  const rule = g.round_trips;
  const roundTrips = rule === undefined ? null : { min_buy_lamports: rule.min_buy_lamports, ...countedRoundTrips(run.round_trips, BigInt(rule.min_buy_lamports)) };
  const fillsOk = fills >= g.min_fills;
  const mintsOk = (roundTrips === null ? filledMints.size : roundTrips.counted_mints) >= g.min_distinct_mints;
  const drawdownOk = dd <= parseFixed9(g.max_drawdown);

  let firstBlock: string | null = null;
  let receipt: string | null = null;
  let after: boolean | null = null;
  if (params.final_window !== null) {
    receipt = params.final_window.last_graded_receipt_at;
    const receiptMs = Date.parse(receipt);
    if (Number.isNaN(receiptMs)) throw new RangeError(`last_graded_receipt_at ${JSON.stringify(receipt)} is not a date-time`);
    firstBlock = run.first_block_time === null ? null : iso(run.first_block_time);
    after = run.first_block_time === null ? false : run.first_block_time * 1000 > receiptMs;
  }

  const metrics: ReplayMetricsT = {
    net_pnl_lamports: net.toString(),
    return: toFixed9(start === 0n ? 0n : ratio9(net, start)),
    sharpe: sharpe === null ? null : toFixed9(sharpe),
    sortino: sortino === null ? null : toFixed9(sortino),
    max_drawdown: toFixed9(dd),
    win_rate: trips === 0 ? null : toFixed9(ratio9(BigInt(wins), BigInt(trips))),
    round_trips: trips,
    fills,
    rejected,
    failed_txs: failed,
    distinct_mints: filledMints.size,
    fees_lamports: fees.toString(),
    tx_fees_lamports: txFees.toString(),
    fee_fallback_fills: fallback,
    per_token: run.per_token.map((t) => ({ mint: t.mint, realized_pnl_lamports: t.realized_pnl_lamports, fills: t.fills, fees_lamports: t.fees_lamports })),
    interval: {
      level: params.interval.level,
      method: 'bootstrap-tokens',
      resamples: params.interval.resamples,
      seed: run.hello.seed,
      low_lamports: ci.low.toString(),
      high_lamports: ci.high.toString(),
    },
    cost_sensitivity: { fee_multiplier: costRun.fee_multiplier, net_pnl_lamports: costNet.toString() },
    constraints: {
      min_fills: g.min_fills,
      min_distinct_mints: g.min_distinct_mints,
      max_drawdown: g.max_drawdown,
      fills_ok: fillsOk,
      mints_ok: mintsOk,
      drawdown_ok: drawdownOk,
      compliant: fillsOk && mintsOk && drawdownOk,
      // Absent without the rule, never undefined: a pilot score keeps its bytes.
      ...(roundTrips === null ? {} : { round_trips: roundTrips }),
    },
    contamination: {
      no_future_events: run.no_future_events,
      final_window_first_block_time: firstBlock,
      last_graded_receipt_at: receipt,
      window_after_receipts: after,
      dataset_sha256: run.dataset_sha256,
    },
    // Absent without the opt-in, never undefined: a score without it keeps its bytes.
    ...(params.counterparties === true ? { counterparties: countCounterparties(events!, run.round_trips) } : {}),
  };
  return ReplayMetrics.parse(metrics);
}

export interface ScoredReplay {
  metrics: ReplayMetricsT;
  /** Score flags the replay raises ("fee_fallback", "chain_warnings"). */
  flags: string[];
  run: ReplayRun;
  cost_run: ReplayRun;
}

/**
 * The replay score of an action log: a pure function of (dataset, action log, params, opts.failKey:
 * the failed-tx draw's key, which the log does not carry). Replays the log at fee multiplier 1 and
 * at `cost_multiplier` (default 2, sells re-sized by their 1x share), both under the same fail key,
 * then computes the metrics (the counterparties metric, when params opt in, on the dataset's
 * records). Throws SimAbortError when either replay aborts (never a partial score).
 */
export function scoreActionLog(dataset: ReplayDataset, log: ActionLogT, params: MetricsParams & { cost_multiplier?: number }, opts: Omit<EngineOptions, 'feeMultiplier'> = {}): ScoredReplay {
  const run = replayActionLog(dataset, log, opts);
  if (run.aborted !== null) throw new SimAbortError(`run aborted: ${run.aborted}`);
  const costRun = replayActionLog(dataset, log, { ...opts, feeMultiplier: params.cost_multiplier ?? DEFAULT_COST_MULTIPLIER, resizeSells: sellShares(run) });
  const metrics = computeMetrics(run, costRun, params, dataset.events);
  const flags: string[] = [];
  if (metrics.fee_fallback_fills > 0) flags.push('fee_fallback');
  if (run.chain_warnings.length > 0) flags.push('chain_warnings');
  return { metrics, flags, run, cost_run: costRun };
}

// ---------------------------------------------------------------- bars-replay/v1
//
// BarsReplayMetrics (contracts/score.ts, whose header defines each metric) of a finished bars run
// (sim/bars/engine.ts). Every metric is the scored window's: with a warm-up (hello.warmup_bars, N)
// the run's equity points start before batch N, so the N warm-up batches are marked nowhere, and
// run.window is the scored window; without one every batch is scored.
//   - sharpe, sortino, max_drawdown: the run's equity points (the starting cash, the equity at every
//     batch's close, the cash after the flatten) through periodReturns, sharpe9, sortino9 and
//     maxDrawdown9: per bar, not annualised. hourlyMarks is the pump replay's and is not used here.
//   - exposure: the mean over the batches of (equity - cash) / equity (0 at a batch with equity 0),
//     each share and the mean truncated
//   - interval: bootstrapInterval over the per-symbol PnL of EVERY universe symbol in code-unit order
//     (0 for one never traded), seeded by hello.seed (the phase seed): the draws depend only on
//     (seed, universe size), so every entry of a phase is resampled with the same indices (paired),
//     and trading fewer symbols cannot narrow an interval
//   - block_hours, per_block (barsBlockPnl): the scored window's batches in blocks of block_hours / the
//     bar's hours (barsPerBlock; barsBlockHoursOf: the harness's interval.block_hours, else
//     BARS_BLOCK_HOURS, 6, or one bar where a bar is longer; a whole number of bars, 60 an hour on 1m
//     bars), scored batch k (counted from the first after any warm-up) in block floor(k / that),
//     ceil(scored batches / that) blocks, the last possibly shorter. A block's PnL is the equity point
//     of its last batch minus the previous block's (the start's for block 0); the last block's ends at
//     the point after the flatten, the final cash. They telescope to net PnL exactly: the start's point
//     is the starting cash and the end's the final cash (anything else is a sim bug, SimAbortError)
//   - cost_sensitivity: the same action log replayed with fee_bps doubled, each order the 1x run
//     accepted when deciding cut to what the 2x account can take: sells to the quantity held, buys to
//     the cash and weight room left (sim/bars/engine.ts clampOrders; the lesson of the
//     cost_sensitivity line above, whose 'sell everything' would otherwise be refused)
//   - constraints: the harness's guardrails (trades >= min_trades, distinct_symbols >=
//     min_distinct_symbols, max_drawdown at or under its cap)
//   - contamination: the run's no-future-bars certificate, the final window's first scored bar's open
//     time (run.window.start_ms, after any warm-up) against the last graded receipt, and the dataset digest

export const BARS_COST_MULTIPLIER = 2;

/** The hours a bars score's per_block block covers when the harness names none: clmm's six (contracts/clmm-protocol.ts), 28 blocks to a 7-day window. */
export const BARS_BLOCK_HOURS = 6;

const HOUR_MS = HOUR_SECONDS * 1000;

export interface BarsMetricsParams {
  guardrails: BarsGuardrailsT;
  /**
   * The interval reported next to the rank key (the harness's interval), and the hours of each
   * per_block block (block_hours; absent, barsBlockHoursOf's default).
   */
  interval: { level: string; resamples: number; block_hours?: number };
  /** Final phase: the server time of the last graded receipt. Null on the dev phase. */
  final_window: { last_graded_receipt_at: string } | null;
}

/**
 * The hours each per_block block of a run on `barInterval` bars covers (see the bars header):
 * `blockHours` when it is given, else BARS_BLOCK_HOURS, or one bar where a bar is longer (24 on 1d
 * bars; 6 on 1m bars, 360 of them). A RangeError unless it is whole hours and a whole number of bars,
 * at least one. Counted in ms, so a bar shorter than an hour (1m: a 1 h block is 60 bars) divides exactly.
 */
export function barsBlockHoursOf(barInterval: BarIntervalT, blockHours?: number): number {
  const barMs = BAR_INTERVAL_MS[barInterval];
  const hours = blockHours ?? Math.max(BARS_BLOCK_HOURS, barMs / HOUR_MS);
  if (!Number.isSafeInteger(hours) || hours * HOUR_MS < barMs || (hours * HOUR_MS) % barMs !== 0) throw new RangeError(`block_hours ${hours} is not a whole number of ${barInterval} bars`);
  return hours;
}

/** The bars one per_block block of `blockHours` (barsBlockHoursOf) holds on `barInterval` bars: 6 on 1h bars, 360 on 1m. */
export function barsPerBlock(barInterval: BarIntervalT, blockHours: number): number {
  return (barsBlockHoursOf(barInterval, blockHours) * HOUR_MS) / BAR_INTERVAL_MS[barInterval];
}

/**
 * Each block's net PnL (contracts/score.ts per_block; the bars header): the run's equity points in
 * blocks of `blockHours` (barsBlockHoursOf), block 0 first, adding up to final cash - starting cash.
 * The points must be the start (seq warm - 1, warm the hello's warmup_bars, 0 when absent), one per
 * scored batch in seq order and the end after the flatten (seq batches), the start's the starting cash
 * and the end's the final cash: anything else is a sim bug (SimAbortError). The blocks cover the
 * batches - warm scored batches.
 */
export function barsBlockPnl(run: Pick<BarsRun, 'equity' | 'batches' | 'hello' | 'start_quote_units' | 'final_account'>, blockHours: number): bigint[] {
  const perBlock = barsPerBlock(run.hello.bar_interval, blockHours);
  const warm = run.hello.warmup_bars ?? 0;
  const scored = run.batches - warm;
  const pts = run.equity;
  if (scored < 1 || pts.length !== scored + 2) {
    throw new SimAbortError(`${pts.length} equity points for ${scored} batches${warm > 0 ? ` after ${warm} warm-up batches` : ''}: a run marks the start, every scored batch and the end`);
  }
  pts.forEach((p, i) => {
    if (p.seq !== warm + i - 1) throw new SimAbortError(`equity point ${i} follows seq ${p.seq}, not ${warm + i - 1}`);
  });
  const start = BigInt(run.start_quote_units);
  if (BigInt(pts[0]!.equity_quote_units) !== start) throw new SimAbortError(`the start's equity ${pts[0]!.equity_quote_units} is not the starting cash ${start}`);
  const end = pts.at(-1)!;
  if (end.equity_quote_units !== run.final_account.cash_quote_units) throw new SimAbortError(`the end's equity ${end.equity_quote_units} is not the final cash ${run.final_account.cash_quote_units}`);
  const blocks = Math.ceil(scored / perBlock);
  const out: bigint[] = [];
  let prev = start;
  for (let b = 0; b < blocks; b++) {
    // Point i follows scored batch i - 1: block b's last is (b + 1) x perBlock - 1, the last block's the end.
    const at = BigInt(pts[b === blocks - 1 ? pts.length - 1 : (b + 1) * perBlock]!.equity_quote_units);
    out.push(at - prev);
    prev = at;
  }
  return out;
}

/** A bars run's equity points as integers: the marks every bars ratio is taken on. */
export function barsEquityMarks(run: Pick<BarsRun, 'equity'>): bigint[] {
  return run.equity.map((p) => BigInt(p.equity_quote_units));
}

/** Mean invested share of equity over the scored batches (the warm-up's are not marked), Fixed9 scaled (see the bars header). */
export function barsExposure9(run: Pick<BarsRun, 'equity' | 'batches' | 'hello'>): bigint {
  const warm = run.hello.warmup_bars ?? 0;
  let sum = 0n;
  let n = 0n;
  for (const p of run.equity) {
    if (p.seq < warm || p.seq >= run.batches) continue;
    const equity = BigInt(p.equity_quote_units);
    if (equity > 0n) sum += ratio9(equity - BigInt(p.cash_quote_units), equity);
    n++;
  }
  return n === 0n ? 0n : sum / n;
}

/**
 * The bootstrap's items: the PnL of every universe symbol, in the hello's (code-unit) order, 0 for
 * one never traded. Every symbol with a row is a universe symbol; one that is not is a sim bug.
 */
export function barsUniversePnl(run: Pick<BarsRun, 'hello' | 'per_symbol'>): bigint[] {
  const pnl = new Map(run.per_symbol.map((s) => [s.symbol, BigInt(s.pnl_quote_units)]));
  const out = run.hello.symbols.map((s) => {
    const v = pnl.get(s.symbol) ?? 0n;
    pnl.delete(s.symbol);
    return v;
  });
  if (pnl.size > 0) throw new SimAbortError(`per-symbol PnL for ${pnl.size} symbol(s) outside the universe, first ${[...pnl.keys()][0]}`);
  return out;
}

/** BarsReplayMetrics of a run, with the 2x-fee run of the same action log. */
export function computeBarsMetrics(run: BarsRun, costRun: BarsRun, params: BarsMetricsParams): BarsReplayMetricsT {
  if (run.aborted !== null) throw new SimAbortError(`run aborted: ${run.aborted}`);
  if (costRun.aborted !== null) throw new SimAbortError(`cost-sensitivity run aborted: ${costRun.aborted}`);
  if (costRun.fee_multiplier !== BARS_COST_MULTIPLIER) throw new RangeError(`the cost-sensitivity run is at fee multiplier ${costRun.fee_multiplier}, not ${BARS_COST_MULTIPLIER}`);
  const start = BigInt(run.start_quote_units);
  const net = BigInt(run.final_account.cash_quote_units) - start;
  const costNet = BigInt(costRun.final_account.cash_quote_units) - BigInt(costRun.start_quote_units);

  const marks = barsEquityMarks(run);
  const returns = periodReturns(marks);
  const sharpe = sharpe9(returns);
  const sortino = sortino9(returns);
  const dd = maxDrawdown9(marks);

  const wins = run.round_trips.filter((t) => BigInt(t.pnl_quote_units) > 0n).length;
  const trips = run.round_trips.length;

  let trades = 0;
  let rejected = 0;
  let fees = 0n;
  const traded = new Set<string>();
  for (const f of run.resolutions) {
    if (f.status === 'filled') fees += BigInt(f.fee_quote_units);
    if (f.kind !== 'order') continue;
    if (f.status === 'rejected') rejected++;
    else {
      trades++;
      traded.add(f.symbol);
    }
  }

  const level = parseFixed9(params.interval.level);
  const ci = bootstrapInterval(barsUniversePnl(run), level, params.interval.resamples, BigInt(run.hello.seed));
  const blockHours = barsBlockHoursOf(run.hello.bar_interval, params.interval.block_hours);
  const blocks = barsBlockPnl(run, blockHours);

  const g = params.guardrails;
  const tradesOk = trades >= g.min_trades;
  const symbolsOk = traded.size >= g.min_distinct_symbols;
  const drawdownOk = dd <= parseFixed9(g.max_drawdown);

  let firstBar: string | null = null;
  let receipt: string | null = null;
  let after: boolean | null = null;
  if (params.final_window !== null) {
    receipt = params.final_window.last_graded_receipt_at;
    const receiptMs = Date.parse(receipt);
    if (Number.isNaN(receiptMs)) throw new RangeError(`last_graded_receipt_at ${JSON.stringify(receipt)} is not a date-time`);
    firstBar = new Date(run.window.start_ms).toISOString();
    after = run.window.start_ms > receiptMs;
  }

  const metrics: BarsReplayMetricsT = {
    net_pnl_quote_units: net.toString(),
    return: toFixed9(ratio9(net, start)),
    sharpe: sharpe === null ? null : toFixed9(sharpe),
    sortino: sortino === null ? null : toFixed9(sortino),
    max_drawdown: toFixed9(dd),
    win_rate: trips === 0 ? null : toFixed9(ratio9(BigInt(wins), BigInt(trips))),
    trades,
    rejected,
    distinct_symbols: traded.size,
    fees_quote_units: fees.toString(),
    exposure: toFixed9(barsExposure9(run)),
    per_symbol: run.per_symbol.map((s) => ({ symbol: s.symbol, pnl_quote_units: s.pnl_quote_units, trades: s.trades, fees_quote_units: s.fees_quote_units })),
    interval: {
      level: params.interval.level,
      method: 'bootstrap-symbols',
      resamples: params.interval.resamples,
      seed: run.hello.seed,
      low_quote_units: ci.low.toString(),
      high_quote_units: ci.high.toString(),
    },
    block_hours: blockHours,
    per_block: blocks.map((pnl, block) => ({ block, pnl_quote_units: pnl.toString() })),
    cost_sensitivity: { fee_multiplier: BARS_COST_MULTIPLIER, net_pnl_quote_units: costNet.toString() },
    constraints: {
      min_trades: g.min_trades,
      min_distinct_symbols: g.min_distinct_symbols,
      max_drawdown: g.max_drawdown,
      trades_ok: tradesOk,
      symbols_ok: symbolsOk,
      drawdown_ok: drawdownOk,
      compliant: tradesOk && symbolsOk && drawdownOk,
    },
    contamination: {
      no_future_bars: run.no_future_bars,
      final_window_first_bar_time: firstBar,
      last_graded_receipt_at: receipt,
      window_after_receipts: after,
      dataset_sha256: run.dataset_sha256,
    },
  };
  return BarsReplayMetrics.parse(metrics);
}

export interface ScoredBarsReplay {
  metrics: BarsReplayMetricsT;
  run: BarsRun;
  cost_run: BarsRun;
}

/**
 * The bars score of an action log: a pure function of (dataset, action log, params). Replays the log
 * at fee multiplier 1 and at BARS_COST_MULTIPLIER (orders the 1x run accepted when deciding clamped
 * to the 2x account), then computes the metrics. Throws SimAbortError when either replay aborts
 * (never a partial score).
 */
export function scoreBarsActionLog(dataset: BarsDataset, log: BarsActionLogT, params: BarsMetricsParams): ScoredBarsReplay {
  const run = replayBarsActionLog(dataset, log);
  if (run.aborted !== null) throw new SimAbortError(`run aborted: ${run.aborted}`);
  const costRun = replayBarsActionLog(dataset, log, { feeMultiplier: BARS_COST_MULTIPLIER, clampOrders: decisionAccepted(run) });
  const metrics = computeBarsMetrics(run, costRun, params);
  return { metrics, run, cost_run: costRun };
}
