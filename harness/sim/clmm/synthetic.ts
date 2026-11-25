// Synthetic clmm datasets for tests and end-to-end proofs: the rows of one concentrated-liquidity pool
// (contracts/clmm-dataset.ts ClmmRow) and the hourly bars a freeze builds from them (ClmmDatasetLine),
// deterministic per seed (SplitMix64). The dataset digest is computed as a frozen dataset's is: the
// sha256 of the bars NDJSON followed by the rows NDJSON (clmmDatasetFiles' order), so a freeze of the
// same rows names the same dataset_sha256.
//
//   makeClmmDataset         rows written out by hand (ClmmRowSpec), the bars derived from them
//   generateClmmDataset     a seeded tick walk sampled every 10 s, with gaps on request
//   syntheticClmmHarness    a valid ClmmReplayHarness over a dataset's pool, its blocks the longest
//                           that cut the dataset's window into CLMM_MIN_BLOCKS whole ones (3 hours for
//                           a day), defaults overridable
//
// A bar is what the contract says a freeze writes. Its hour holds the rows of [t - 1 h, t). o and c
// are the medians (barsMedian) of the prices in its open and close windows (clmmReferenceWindows),
// h and l the extremes, o_depth and c_depth the medians of the per-row depths over the same windows,
// and the o_ and c_ states the reference rows' (clmmReferenceRow). A row's price is its sqrt price's
// at the pool's price_scale, floored (collector/bars/decode.ts chainPrice). A row's depth is what
// collector/bars/freeze.ts sampleDepthOf gives a concentrated sample read with its vaults: the smaller
// of the in-range virtual reserve of USDC (L x sqrt / 2^64 with USDC as token B, L x 2^64 / sqrt as
// token A) and the smaller of the two vaults' sides at the row's price, at least 1.
//
// The default pool is SOL/USDC on an Orca Whirlpool (SOL token A, 9 decimals; USDC token B), tick
// spacing 4, prices at scale 6, its address drawn from the asset and venue alone.

import { barsMedian } from '../../contracts/bars-dataset.ts';
import { BARS_QUOTE, USDC_DECIMALS, USDC_MINT } from '../../contracts/bars-protocol.ts';
import {
  ClmmDatasetLine,
  ClmmDatasetPool,
  clmmNdjsonLine,
  ClmmRow,
  clmmReferenceRow,
  clmmReferenceWindows,
  clmmRowLine,
  type ClmmDatasetLineT,
  type ClmmDatasetPoolT,
  type ClmmGapsT,
  type ClmmRowT,
} from '../../contracts/clmm-dataset.ts';
import { CLMM_BAR_MS, CLMM_HARNESS_KIND, CLMM_MAX_FEE_INTERVAL_MS, CLMM_MIN_BLOCKS, CLMM_PROTOCOL, CLMM_VENUES, ClmmReplayHarness, type ClmmReplayHarnessT, type ClmmVenueT } from '../../contracts/clmm-protocol.ts';
import { WSOL_MINT } from '../../contracts/events.ts';
import { syntheticMint } from '../bars/synthetic.ts';
import { sha256Hex } from '../canonical.ts';
import { keyedU64, SplitMix64 } from '../rng.ts';
import { SyntheticKeys } from '../synthetic.ts';
import type { ClmmDataset } from './engine.ts';
import { MAX_TICK_INDEX, MIN_TICK_INDEX, Q64, sqrtPriceAtTick, tickAtSqrtPrice, U128_MODULUS } from './position.ts';

/** 2026-01-01T00:00:00Z: the default window start. */
export const SYNTHETIC_CLMM_START_MS = Date.UTC(2026, 0, 1);
/** The poller's cadence: one row every 10 s. */
export const SYNTHETIC_CLMM_EVERY_MS = 10_000;
/** The default price of the asset: 150 whole USDC, at any price scale. */
export const SYNTHETIC_CLMM_PRICE_USDC = 150n;
/** The pool's default in-range liquidity: about 38.7M USDC of virtual reserve at 150 USDC per SOL. */
export const SYNTHETIC_CLMM_LIQUIDITY = 100_000_000_000_000n;
/** The default vaults, as [asset, USDC] raw units: 100,000 SOL and 15,000,000 USDC, so a sample's depth is about 15M USDC. */
export const SYNTHETIC_CLMM_VAULTS: readonly [bigint, bigint] = [100_000_000_000_000n, 15_000_000_000000n];
/**
 * The default fee growth per row, as [asset, USDC] (Q64.64 per unit of liquidity): at the default
 * liquidity, about 0.2 USDC of fees on each side every 10 s.
 */
export const SYNTHETIC_CLMM_FEE_GROWTH_STEP: readonly [bigint, bigint] = [246_000_000_000n, 36_900_000_000n];

const SLOT0 = 380_000_000;
const SLOT_MS = 400;
const Q128 = 1n << 128n;
const POOL_DOMAIN = 0x636c6d6d2d706f6fn; // "clmm-poo"
const WALK_DOMAIN = 0x636c6d6d2d77616cn; // "clmm-wal"

const minOf = (a: bigint, b: bigint) => (a < b ? a : b);

/** floor(sqrt(n)) of a non-negative bigint (Newton's method from a power of two above the root). */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

export interface SyntheticClmmPoolSpec {
  /** Default 'SOL'. */
  asset?: string;
  /** Default WSOL's mint for SOL, else the bars synthetic mint of the ticker (sim/bars/synthetic.ts syntheticMint). */
  mint?: string;
  /** The asset mint's decimals; default 9. */
  decimals?: number;
  /** Default 'orca-whirlpool'. */
  venue?: ClmmVenueT;
  /** Which of the pool's two tokens is USDC: default 'b' (a Whirlpool's SOL/USDC: SOL is A). */
  usdc_side?: 'a' | 'b';
  /** Default 4. */
  tick_spacing?: number;
  /** Default 6. */
  price_scale?: number;
  /** The pool account; default syntheticClmmPoolKey(asset, venue). */
  pool?: string;
}

/** The pool account a synthetic dataset names for an asset on a venue: a base58 key drawn from the two alone. */
export function syntheticClmmPoolKey(asset: string, venue: ClmmVenueT): string {
  const ticker = BigInt(`0x${sha256Hex(asset).slice(0, 16)}`);
  return new SyntheticKeys(keyedU64(POOL_DOMAIN, ticker, BigInt(CLMM_VENUES.indexOf(venue)))).pubkey();
}

/** A synthetic dataset's pool (contracts/clmm-dataset.ts ClmmDatasetPool), the defaults filled in. */
export function syntheticClmmPool(spec: SyntheticClmmPoolSpec = {}): ClmmDatasetPoolT {
  const asset = spec.asset ?? 'SOL';
  const venue = spec.venue ?? 'orca-whirlpool';
  const mint = spec.mint ?? (asset === 'SOL' ? WSOL_MINT : syntheticMint(asset));
  const usdcIsA = spec.usdc_side === 'a';
  return ClmmDatasetPool.parse({
    asset,
    mint,
    decimals: spec.decimals ?? 9,
    venue,
    pool: spec.pool ?? syntheticClmmPoolKey(asset, venue),
    mint_a: usdcIsA ? USDC_MINT : mint,
    mint_b: usdcIsA ? mint : USDC_MINT,
    tick_spacing: spec.tick_spacing ?? 4,
    price_scale: spec.price_scale ?? 6,
  });
}

/** Whether the pool's token A is its asset. */
const assetIsA = (pool: Pick<ClmmDatasetPoolT, 'mint_a' | 'mint_b'>) => pool.mint_b === USDC_MINT;

/** A [asset, USDC] pair in the pool's own order [a, b]. */
export function poolOrder<T>(pool: Pick<ClmmDatasetPoolT, 'mint_a' | 'mint_b'>, pair: readonly [T, T]): [T, T] {
  return assetIsA(pool) ? [pair[0], pair[1]] : [pair[1], pair[0]];
}

/** A row's price at the pool's price_scale from its sqrt price, floored (collector/bars/decode.ts chainPrice of the pool's one hop). */
export function clmmPriceOf(sqrtPriceX64: bigint, pool: Pick<ClmmDatasetPoolT, 'mint_a' | 'mint_b' | 'decimals' | 'price_scale'>): bigint {
  const scale = 10n ** BigInt(pool.decimals + pool.price_scale);
  const usdc = 10n ** BigInt(USDC_DECIMALS);
  const p2 = sqrtPriceX64 * sqrtPriceX64;
  return assetIsA(pool) ? (p2 * scale) / (Q128 * usdc) : (Q128 * scale) / (p2 * usdc);
}

/** The tick whose price is nearest below `price` (at the pool's price_scale, USDC per whole asset) in the pool's own terms (token B per token A, raw). */
export function clmmTickOfPrice(price: bigint, pool: Pick<ClmmDatasetPoolT, 'mint_a' | 'mint_b' | 'decimals' | 'price_scale'>): number {
  const scale = 10n ** BigInt(pool.decimals + pool.price_scale);
  const usdc = 10n ** BigInt(USDC_DECIMALS);
  // B per A, raw: USDC raw per asset raw when the asset is A, its inverse when it is B.
  const [num, den] = assetIsA(pool) ? [price * usdc, scale] : [scale, price * usdc];
  return tickAtSqrtPrice(isqrt((num * Q128) / den));
}

/** A row's depth (see the header): USDC raw units, at least 1. */
export function clmmRowDepth(row: Pick<ClmmRowT, 'sqrt_price_x64' | 'liquidity' | 'vaults'>, pool: Pick<ClmmDatasetPoolT, 'mint_a' | 'mint_b'>): bigint {
  const s = BigInt(row.sqrt_price_x64);
  const L = BigInt(row.liquidity);
  const [va, vb] = [BigInt(row.vaults[0]), BigInt(row.vaults[1])];
  const baseIsA = assetIsA(pool);
  const inRange = baseIsA ? (L * s) / Q64 : (L * Q64) / s;
  const quoteVault = baseIsA ? vb : va;
  const baseVault = baseIsA ? va : vb;
  const baseInQuote = baseIsA ? (baseVault * s * s) / Q128 : (baseVault * Q128) / (s * s);
  const d = minOf(inRange, minOf(quoteVault, baseInQuote));
  return d < 1n ? 1n : d;
}

/** sha256 of the bars NDJSON followed by the rows NDJSON (one rows file or several, concatenated in order): a frozen dataset's dataset_sha256. */
export function clmmDatasetSha256(bars: readonly ClmmDatasetLineT[], rows: readonly ClmmRowT[]): string {
  return sha256Hex(bars.map((b) => clmmNdjsonLine(b)).join('') + rows.map((r) => clmmRowLine(r)).join(''));
}

/** The gap stats of a window's rows (contracts/clmm-dataset.ts ClmmGaps). */
export function clmmGapsOf(rows: readonly Pick<ClmmRowT, 'ts'>[], bars: number, hours: number): ClmmGapsT {
  let long = 0;
  let longest = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i]!.ts - rows[i - 1]!.ts;
    if (d > CLMM_MAX_FEE_INTERVAL_MS) long++;
    if (d > longest) longest = d;
  }
  return { missing_hours: hours - bars, long_intervals: long, longest_interval_ms: longest };
}

/** One row as written by hand. */
export interface ClmmRowSpec {
  ts: number;
  /** The pool's tick; without sqrt_price_x64 the row sits at the tick's own sqrt price (sqrtPriceAtTick). */
  tick?: number;
  /** The pool's sqrt price; without a tick the row's is tickAtSqrtPrice of it. One of the two is required. */
  sqrt_price_x64?: bigint;
  /** Default SYNTHETIC_CLMM_LIQUIDITY. */
  liquidity?: bigint;
  /** The pool's fee growth counters, [a, b] (u128). */
  fee_growth: readonly [bigint, bigint];
  /** [a, b]; default SYNTHETIC_CLMM_VAULTS in the pool's order. */
  vaults?: readonly [bigint, bigint];
  /** Default a slot counted from the window's start at 400 ms a slot. */
  slot?: number;
}

export interface SyntheticClmmDataset extends ClmmDataset {
  bars: ClmmDatasetLineT[];
  rows: ClmmRowT[];
  gaps: ClmmGapsT;
}

export interface ClmmDatasetSpec {
  pool?: SyntheticClmmPoolSpec;
  /** The window's first hour's open time; default SYNTHETIC_CLMM_START_MS. */
  start_ms?: number;
  /** Hours in the window. */
  hours: number;
  /** In ts order, every ts within the window. */
  rows: readonly ClmmRowSpec[];
}

/** The bars a freeze builds from a window's rows (see the header): one per hour that holds a row. */
export function clmmBarsOf(rows: readonly ClmmRowT[], pool: ClmmDatasetPoolT, window: { start_ms: number; hours: number }): ClmmDatasetLineT[] {
  const bars: ClmmDatasetLineT[] = [];
  let i = 0;
  for (let k = 0; k < window.hours; k++) {
    const t = window.start_ms + (k + 1) * CLMM_BAR_MS;
    const from = i;
    while (i < rows.length && rows[i]!.ts < t) i++;
    if (from === i) continue;
    const members = rows.slice(from, i);
    const { open, close } = clmmReferenceWindows(members);
    const prices = members.map((r) => BigInt(r.price));
    const ro = clmmReferenceRow(open);
    const rc = clmmReferenceRow(close);
    const median = (w: readonly ClmmRowT[], f: (r: ClmmRowT) => bigint) => barsMedian(w.map(f)).toString();
    bars.push(
      ClmmDatasetLine.parse({
        t,
        o: median(open, (r) => BigInt(r.price)),
        h: prices.reduce((a, b) => (b > a ? b : a)).toString(),
        l: prices.reduce((a, b) => (b < a ? b : a)).toString(),
        c: median(close, (r) => BigInt(r.price)),
        v: null,
        o_depth: [median(open, (r) => clmmRowDepth(r, pool))],
        c_depth: [median(close, (r) => clmmRowDepth(r, pool))],
        venue: pool.venue,
        first_slot: members[0]!.slot,
        last_slot: members.at(-1)!.slot,
        samples: members.length,
        o_tick: ro.tick,
        c_tick: rc.tick,
        o_sqrt_price_x64: ro.sqrt_price_x64,
        c_sqrt_price_x64: rc.sqrt_price_x64,
        o_liquidity: ro.liquidity,
        c_liquidity: rc.liquidity,
      }),
    );
  }
  if (i !== rows.length) throw new RangeError(`${rows.length - i} rows lie after the window`);
  return bars;
}

/** A dataset of rows written out by hand (see ClmmRowSpec); the bars are derived from them. */
export function makeClmmDataset(spec: ClmmDatasetSpec): SyntheticClmmDataset {
  const pool = syntheticClmmPool(spec.pool);
  const start = spec.start_ms ?? SYNTHETIC_CLMM_START_MS;
  if (!Number.isSafeInteger(start) || start % CLMM_BAR_MS !== 0) throw new RangeError(`start_ms ${start} is not a whole hour`);
  if (!Number.isInteger(spec.hours) || spec.hours < 1) throw new RangeError(`a window holds at least one hour, not ${spec.hours}`);
  const end = start + spec.hours * CLMM_BAR_MS;
  const vaults = poolOrder(pool, SYNTHETIC_CLMM_VAULTS);
  let prev = -1;
  const rows = spec.rows.map((r): ClmmRowT => {
    if (!Number.isSafeInteger(r.ts) || r.ts < start || r.ts >= end) throw new RangeError(`row ts ${r.ts} is not in the window [${start}, ${end})`);
    if (r.ts <= prev) throw new RangeError(`row ts ${r.ts} does not follow ${prev}`);
    prev = r.ts;
    if (r.tick === undefined && r.sqrt_price_x64 === undefined) throw new RangeError(`row ts ${r.ts} has neither a tick nor a sqrt price`);
    const sqrt = r.sqrt_price_x64 ?? sqrtPriceAtTick(r.tick!);
    const tick = r.tick ?? tickAtSqrtPrice(sqrt);
    return ClmmRow.parse({
      ts: r.ts,
      slot: r.slot ?? SLOT0 + Math.floor((r.ts - start) / SLOT_MS),
      price: clmmPriceOf(sqrt, pool).toString(),
      sqrt_price_x64: sqrt.toString(),
      liquidity: (r.liquidity ?? SYNTHETIC_CLMM_LIQUIDITY).toString(),
      tick,
      vaults: (r.vaults ?? vaults).map(String),
      fee_growth: r.fee_growth.map((g) => (((g % U128_MODULUS) + U128_MODULUS) % U128_MODULUS).toString()),
    });
  });
  const window = { start_ms: start, end_ms: end, hours: spec.hours };
  const bars = clmmBarsOf(rows, pool, window);
  return { sha256: clmmDatasetSha256(bars, rows), pool, window, bars, rows, gaps: clmmGapsOf(rows, bars.length, spec.hours) };
}

export interface GenerateClmmOptions {
  seed: bigint;
  /** Default 24. */
  hours?: number;
  start_ms?: number;
  /** Default SYNTHETIC_CLMM_EVERY_MS. */
  every_ms?: number;
  /** Row i's ts is start_ms + i x every_ms + a draw in [0, jitter_ms); default 0 (below every_ms). */
  jitter_ms?: number;
  pool?: SyntheticClmmPoolSpec;
  /** The first row's tick; default the tick of SYNTHETIC_CLMM_PRICE_USDC per whole asset. */
  tick0?: number;
  /** The largest move of the walk's tick from one row to the next, either way; default 2. */
  max_tick_step?: number;
  /** A row's tick, instead of the walk's: given the row's index, its ts and the walk's tick. */
  tick?: (i: number, ts: number, walk: number) => number;
  /** The pool's in-range liquidity, or row by row; default SYNTHETIC_CLMM_LIQUIDITY. */
  liquidity?: bigint | ((i: number, ts: number) => bigint);
  /** The fee growth each row adds to the one before, [a, b]; default SYNTHETIC_CLMM_FEE_GROWTH_STEP in the pool's order. */
  fee_growth_step?: readonly [bigint, bigint];
  /** The counters' first values, [a, b] (they wrap at 2^128); default [0, 0]. */
  fee_growth0?: readonly [bigint, bigint];
  /** [a, b]; default SYNTHETIC_CLMM_VAULTS in the pool's order. */
  vaults?: readonly [bigint, bigint];
  /** Hours of the window (by index) with no row. */
  gap_hours?: readonly number[];
  /** Spans [from_ms, to_ms) with no row (an interval over 30 s credits no fee). */
  drop?: readonly { from_ms: number; to_ms: number }[];
}

/**
 * A seeded tick walk sampled every every_ms: each row's tick up to max_tick_step from the one before
 * (or opts.tick's), its sqrt price a seeded point within that tick (so tickAtSqrtPrice gives the tick
 * back), its fee growth the one before plus the step. A dropped row still moves the walk and the
 * counters, unseen, as a poller missing a read would.
 */
export function generateClmmDataset(opts: GenerateClmmOptions): SyntheticClmmDataset {
  const pool = syntheticClmmPool(opts.pool);
  const hours = opts.hours ?? SYNTHETIC_CLMM_HOURS;
  const start = opts.start_ms ?? SYNTHETIC_CLMM_START_MS;
  const every = opts.every_ms ?? SYNTHETIC_CLMM_EVERY_MS;
  const jitter = opts.jitter_ms ?? 0;
  if (!Number.isInteger(every) || every < 1 || !Number.isInteger(jitter) || jitter < 0 || jitter >= every) throw new RangeError(`every_ms ${every} and jitter_ms ${jitter}: 0 <= jitter < every`);
  const step = BigInt(opts.max_tick_step ?? 2);
  const rng = new SplitMix64(keyedU64(opts.seed, WALK_DOMAIN));
  const gapHours = new Set(opts.gap_hours ?? []);
  const fgStep = opts.fee_growth_step ?? poolOrder(pool, SYNTHETIC_CLMM_FEE_GROWTH_STEP);
  const fg: [bigint, bigint] = [opts.fee_growth0?.[0] ?? 0n, opts.fee_growth0?.[1] ?? 0n];
  let walk = opts.tick0 ?? clmmTickOfPrice(SYNTHETIC_CLMM_PRICE_USDC * 10n ** BigInt(pool.price_scale), pool);
  const rows: ClmmRowSpec[] = [];
  const end = start + hours * CLMM_BAR_MS;
  for (let i = 0; ; i++) {
    const ts = start + i * every + (jitter > 0 ? Number(rng.below(BigInt(jitter))) : 0);
    if (ts >= end) break;
    if (i > 0) {
      walk += Number(rng.below(2n * step + 1n) - step);
      walk = Math.min(MAX_TICK_INDEX - 1, Math.max(MIN_TICK_INDEX, walk));
      fg[0] = (fg[0] + fgStep[0]) % U128_MODULUS;
      fg[1] = (fg[1] + fgStep[1]) % U128_MODULUS;
    }
    const tick = opts.tick === undefined ? walk : opts.tick(i, ts, walk);
    const lo = sqrtPriceAtTick(tick);
    const span = sqrtPriceAtTick(tick + 1) - lo;
    const sqrt = lo + rng.below(span);
    const hour = Math.floor((ts - start) / CLMM_BAR_MS);
    if (gapHours.has(hour) || (opts.drop ?? []).some((d) => ts >= d.from_ms && ts < d.to_ms)) continue;
    const liquidity = typeof opts.liquidity === 'function' ? opts.liquidity(i, ts) : opts.liquidity;
    rows.push({ ts, tick, sqrt_price_x64: sqrt, fee_growth: [fg[0], fg[1]], ...(liquidity === undefined ? {} : { liquidity }), ...(opts.vaults === undefined ? {} : { vaults: opts.vaults }) });
  }
  return makeClmmDataset({ pool: opts.pool ?? {}, start_ms: start, hours, rows });
}

/** The hours of generateClmmDataset's default window: a day. */
export const SYNTHETIC_CLMM_HOURS = 24;

/**
 * The block length syntheticClmmHarness gives a window of `hours` hours: the longest that still cuts
 * it into CLMM_MIN_BLOCKS whole blocks, floor(hours / 8) (3 for a day), at least 1 (a window under 8
 * hours holds fewer blocks whatever their length, and clmmBlockHoursIssue refuses it where it meets
 * the harness).
 */
export function syntheticClmmBlockHours(hours: number): number {
  if (!Number.isSafeInteger(hours) || hours < 1) throw new RangeError(`a window holds a whole number of hours, at least 1, not ${hours}`);
  return Math.max(1, Math.floor(hours / CLMM_MIN_BLOCKS));
}

/**
 * A valid harness block over a dataset's pool: 10,000 USDC, the pool's 4 bps swap fee, 5 bps
 * slippage, a 1 USDC minimum swap, a 100-tick minimum width, one action a batch, an in-range share of
 * at least 0.5, a 90% block bootstrap of 200 resamples whose blocks are syntheticClmmBlockHours of the
 * dataset's window (of the default day's 24 hours, 3, when it names none), so the window holds
 * CLMM_MIN_BLOCKS whole blocks. Each key of `patch` replaces the default's whole.
 */
export function syntheticClmmHarness(dataset: Pick<ClmmDataset, 'pool'> & { window?: Pick<ClmmDataset['window'], 'hours'> }, patch: Partial<ClmmReplayHarnessT> = {}): ClmmReplayHarnessT {
  const p = dataset.pool;
  const blockHours = syntheticClmmBlockHours(dataset.window?.hours ?? SYNTHETIC_CLMM_HOURS);
  return ClmmReplayHarness.parse({
    kind: CLMM_HARNESS_KIND,
    protocol: CLMM_PROTOCOL,
    runtimes: ['node22'],
    capital: { quote: BARS_QUOTE, quote_scale: USDC_DECIMALS, quote_units: '10000000000' },
    pool: { venue: p.venue, pool: p.pool, mint_a: p.mint_a, mint_b: p.mint_b, decimals: p.decimals, tick_spacing: p.tick_spacing },
    fees: { fee_bps: 4, slippage_bps: 5, min_notional_quote_units: '1000000' },
    caps: { min_width_ticks: 100, max_actions_per_batch: 1 },
    guardrails: { min_in_range_share: '0.500000000' },
    interval: { method: 'bootstrap-blocks', block_hours: blockHours, level: '0.900000000', resamples: 200 },
    ...patch,
  });
}
