// Synthetic bars datasets for tests and end-to-end proofs: valid dataset lines (contracts/bars-dataset.ts
// BarsDatasetLine, depths and provenance included) over a whole window, deterministic per seed
// (SplitMix64), with the dataset digest computed as a frozen dataset's is (sha256 of every symbol's
// NDJSON, concatenated in symbol order), so a freeze of the same bars names the same dataset_sha256.
//
//   makeBarsDataset        bars written out by hand, bar k of the window by index (null: a gap)
//   generateBarsDataset    a seeded random walk per symbol, with seeded and forced gaps
//   syntheticBarsHarness   a valid BarsReplayHarness over a dataset's symbols, defaults overridable
//
// A symbol's mint and venue are pure functions of its ticker (syntheticMint, syntheticVenue), so the
// same ticker names the same mint in every synthetic dataset and harness. Every bar's pool depth is
// SYNTHETIC_BARS_DEPTH (one hop, a USDC-quoted pool) unless the series or the bar says otherwise.

import { BARS_VENUES, barsNdjsonLine, type BarsDatasetLineT, type BarsVenueT } from '../../contracts/bars-dataset.ts';
import {
  BAR_INTERVAL_MS,
  BARS_HARNESS_KIND,
  BARS_PROTOCOL,
  BARS_QUOTE,
  BarSymbol,
  BarsReplayHarness,
  type BarIntervalT,
  type BarsReplayHarnessT,
} from '../../contracts/bars-protocol.ts';
import { sha256Hex } from '../canonical.ts';
import { keyedU64, SplitMix64 } from '../rng.ts';
import { SyntheticKeys } from '../synthetic.ts';
import type { BarsDataset, BarsSeries } from './engine.ts';

/** 2026-01-01T00:00:00Z: the default window start. */
export const SYNTHETIC_BARS_START_MS = Date.UTC(2026, 0, 1);
/** The default universe, in code-unit order. */
export const SYNTHETIC_BARS_SYMBOLS = ['BONK', 'JUP', 'SOL', 'WIF'] as const;
/** The default pool depth of every synthetic bar, at o and at c: one hop of 5,000,000 USDC (raw units), inside the live universe's range. */
export const SYNTHETIC_BARS_DEPTH: readonly bigint[] = [5_000_000_000000n];

const SLOT0 = 380_000_000;
const SLOT_MS = 400;
const SAMPLE_MS = 10_000;
const MINT_DOMAIN = 0x626172732d6d696en; // "bars-min"
const WALK_DOMAIN = 0x626172732d77616cn; // "bars-wal"
const BPS = 10_000n;

export interface SyntheticSeries extends BarsSeries {
  venue: BarsVenueT;
  bars: BarsDatasetLineT[];
}

export interface SyntheticBarsDataset extends BarsDataset {
  symbols: SyntheticSeries[];
}

/**
 * Bar k of a window: prices at the symbol's price_scale. c defaults to o, h and l to the larger and
 * smaller of o and c; o_depth and c_depth (USDC raw units, per hop) to the series' depth.
 */
export interface BarSpec {
  o: bigint;
  c?: bigint;
  h?: bigint;
  l?: bigint;
  o_depth?: readonly bigint[];
  c_depth?: readonly bigint[];
}

export interface SeriesSpec {
  symbol: string;
  /** Default syntheticMint(symbol). */
  mint?: string;
  /** Default 6 and 6. */
  price_scale?: number;
  qty_scale?: number;
  venue?: BarsVenueT;
  /** Every bar's depth, per hop (USDC raw units): one entry for a USDC-quoted pool, two for a SOL-quoted one. Default SYNTHETIC_BARS_DEPTH. */
  depth?: readonly bigint[];
  /** Index k is the window's bar k (closing at start_ms + (k + 1) x the interval); null, undefined or past the end: a gap. */
  bars: readonly (BarSpec | null | undefined)[];
}

export interface BarsDatasetSpec {
  /** Default '1h'. */
  interval?: BarIntervalT;
  /** The window's first bar's open time; default SYNTHETIC_BARS_START_MS. */
  start_ms?: number;
  /** Intervals in the window. */
  bars: number;
  symbols: readonly SeriesSpec[];
}

/** A u64 of the ticker alone: what its mint, venue and walk are drawn from. */
const tickerKey = (symbol: string) => BigInt(`0x${sha256Hex(BarSymbol.parse(symbol)).slice(0, 16)}`);

/** The mint a synthetic dataset binds a ticker to: a base58 key drawn from the ticker alone. */
export function syntheticMint(symbol: string): string {
  return new SyntheticKeys(keyedU64(MINT_DOMAIN, tickerKey(symbol))).pubkey();
}

/** The venue a synthetic series is said to come from: one of BARS_VENUES, by the ticker alone. */
export function syntheticVenue(symbol: string): BarsVenueT {
  return BARS_VENUES[Number(tickerKey(symbol) % BigInt(BARS_VENUES.length))]!;
}

/** sha256 of every series' NDJSON lines (barsNdjsonLine), concatenated in order: a frozen dataset's dataset_sha256. */
export function barsDatasetSha256(symbols: readonly { bars: readonly BarsDatasetLineT[] }[]): string {
  return sha256Hex(symbols.map((s) => s.bars.map((b) => barsNdjsonLine(b)).join('')).join(''));
}

const slotAt = (ms: number, start: number) => SLOT0 + Math.floor((ms - start) / SLOT_MS);

/** A dataset of bars written out by hand (see SeriesSpec); symbols are put in code-unit order. */
export function makeBarsDataset(spec: BarsDatasetSpec): SyntheticBarsDataset {
  const interval = spec.interval ?? '1h';
  const step = BAR_INTERVAL_MS[interval];
  const start = spec.start_ms ?? SYNTHETIC_BARS_START_MS;
  if (!Number.isSafeInteger(start) || start % step !== 0) throw new RangeError(`start_ms ${start} is not a multiple of the ${interval} interval`);
  if (!Number.isInteger(spec.bars) || spec.bars < 1) throw new RangeError(`a window holds at least one bar, not ${spec.bars}`);
  const perBar = Math.floor(step / SAMPLE_MS);
  const sorted = [...spec.symbols].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const symbols = sorted.map((s): SyntheticSeries => {
    const venue = s.venue ?? syntheticVenue(s.symbol);
    const depth = s.depth ?? SYNTHETIC_BARS_DEPTH;
    const bars: BarsDatasetLineT[] = [];
    s.bars.forEach((b, k) => {
      if (b === null || b === undefined || k >= spec.bars) return;
      const c = b.c ?? b.o;
      const t = start + (k + 1) * step;
      bars.push({
        t,
        o: b.o.toString(),
        h: (b.h ?? (b.o > c ? b.o : c)).toString(),
        l: (b.l ?? (b.o < c ? b.o : c)).toString(),
        c: c.toString(),
        v: null,
        o_depth: (b.o_depth ?? depth).map(String),
        c_depth: (b.c_depth ?? depth).map(String),
        venue,
        first_slot: slotAt(t - step, start) + 1,
        last_slot: slotAt(t, start) - 1,
        samples: perBar - (k % 3),
      });
    });
    return { symbol: s.symbol, mint: s.mint ?? syntheticMint(s.symbol), price_scale: s.price_scale ?? 6, qty_scale: s.qty_scale ?? 6, venue, bars };
  });
  return {
    sha256: barsDatasetSha256(symbols),
    interval,
    window: { start_ms: start, end_ms: start + spec.bars * step, bars: spec.bars },
    symbols,
  };
}

export interface GenerateBarsOptions {
  seed: bigint;
  /** Default SYNTHETIC_BARS_SYMBOLS. */
  symbols?: readonly string[];
  /** Default 72. */
  bars?: number;
  interval?: BarIntervalT;
  start_ms?: number;
  /** Default 6 and 6. */
  price_scale?: number;
  qty_scale?: number;
  /** The largest close-to-open move of one bar, bps (default 200). */
  move_bps?: number;
  /** The share of bars left out as gaps, bps (default 0). */
  gap_bps?: number;
  /** Bar indices left out per symbol, on top of the seeded gaps. */
  gaps?: Readonly<Record<string, readonly number[]>>;
  /** Every bar's pool depth, per hop (USDC raw units); default SYNTHETIC_BARS_DEPTH. */
  depth?: readonly bigint[];
}

/**
 * A seeded random walk per symbol: a start price of 1-200 whole units, each bar's open the previous
 * close (after a gap, the walk keeps going unseen), its close up to move_bps away, wicks up to half
 * that. A symbol's bars depend only on (seed, ticker, the window, the scales and moves), never on
 * the other symbols. Prices never fall below 1/100 of a whole unit (and never below 2).
 */
export function generateBarsDataset(opts: GenerateBarsOptions): SyntheticBarsDataset {
  const n = opts.bars ?? 72;
  const priceScale = opts.price_scale ?? 6;
  const move = BigInt(opts.move_bps ?? 200);
  const gapBps = BigInt(opts.gap_bps ?? 0);
  const unit = 10n ** BigInt(priceScale);
  const floor = unit / 100n > 2n ? unit / 100n : 2n;
  const atLeast = (x: bigint) => (x < floor ? floor : x);
  const series: SeriesSpec[] = (opts.symbols ?? SYNTHETIC_BARS_SYMBOLS).map((symbol) => {
    const rng = new SplitMix64(keyedU64(opts.seed, WALK_DOMAIN, tickerKey(symbol)));
    const forced = new Set(opts.gaps?.[symbol] ?? []);
    let price = atLeast((1n + rng.below(200n)) * unit + rng.below(unit));
    const bars: (BarSpec | null)[] = [];
    for (let k = 0; k < n; k++) {
      const o = price;
      const r = rng.below(2n * move + 1n) - move;
      const c = atLeast((o * (BPS + r)) / BPS);
      const up = rng.below(move / 2n + 1n);
      const down = rng.below(move / 2n + 1n);
      const hi = o > c ? o : c;
      const lo = o < c ? o : c;
      const gap = rng.below(BPS) < gapBps || forced.has(k);
      bars.push(gap ? null : { o, c, h: (hi * (BPS + up)) / BPS, l: atLeast((lo * (BPS - down)) / BPS) });
      price = c;
    }
    return { symbol, price_scale: priceScale, qty_scale: opts.qty_scale ?? 6, ...(opts.depth === undefined ? {} : { depth: opts.depth }), bars };
  });
  return makeBarsDataset({ bars: n, symbols: series, ...(opts.interval === undefined ? {} : { interval: opts.interval }), ...(opts.start_ms === undefined ? {} : { start_ms: opts.start_ms }) });
}

/**
 * A valid harness block over a dataset's symbols: 10,000 USDC at quote_scale 6, 4 open positions, 8
 * orders a bar, 50% weight, 30 bps fees, 10 bps slippage, a 1 USDC minimum, no guardrail, a 90%
 * interval of 200 resamples. Each key of `patch` replaces the default's whole.
 */
export function syntheticBarsHarness(dataset: Pick<BarsDataset, 'interval' | 'symbols'>, patch: Partial<BarsReplayHarnessT> = {}): BarsReplayHarnessT {
  return BarsReplayHarness.parse({
    kind: BARS_HARNESS_KIND,
    protocol: BARS_PROTOCOL,
    runtimes: ['node22'],
    capital: { quote: BARS_QUOTE, quote_scale: 6, quote_units: '10000000000' },
    bar_interval: dataset.interval,
    symbols: dataset.symbols.map((s) => ({ symbol: s.symbol, mint: s.mint })),
    latency_bars: 1,
    caps: { max_open_positions: 4, max_orders_per_bar: 8, max_weight_bps: 5_000, shorts: false, leverage: false },
    fees: { fee_bps: 30, slippage_bps: 10, min_notional_quote_units: '1000000' },
    guardrails: { min_trades: 0, min_distinct_symbols: 0, max_drawdown: '1.000000000' },
    interval: { level: '0.900000000', resamples: 200 },
    ...patch,
  });
}
