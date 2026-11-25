// agent-fun/clmm-dataset/v1: a frozen window of one concentrated-liquidity pool's state, the input of a
// clmm-replay/v1 run (contracts/clmm-protocol.ts). It is built by our own poller (collector/bars),
// which reads the pool account and its two vaults every sample_every_ms in one getMultipleAccounts.
// The recording is made with `cli.ts record --fee-growth`, so every sample carries the pool's global
// fee growth beside its liquidity, tick and vaults (collector/bars/samples.ts). `cli.ts freeze-clmm`
// freezes it (collector/bars/clmm-freeze.ts). The pool is the one pools.json names for its asset
// (agent-fun/bars-pools/v2, pinned by source.pools_sha256): an Orca Whirlpool or a Raydium CLMM
// quoted in USDC. Ledger state carries no licence, so a kit may ship the dataset.
//
//   <dir>/bars/<ASSET>.ndjson.gz   the hourly bars, one per line in clmmNdjsonLine's canonical bytes
//                                  (ClmmDatasetLine). Each line is a bars-dataset/v2 line (o and c
//                                  the medians of the bar's first and last BARS_REFERENCE_MS of
//                                  samples, h and l the extremes, the depth at each per hop, the
//                                  provenance; contracts/bars-dataset.ts), plus the pool's state in
//                                  the open's and the close's reference sample. t is strictly
//                                  ascending, every t in (window.start_ms, window.end_ms] and a whole
//                                  UTC hour. An hour with no sample has no line and counts as a
//                                  missing hour. The gzip is pinned (collector/freeze.ts pinnedGzip),
//                                  so the bytes and the digests are the same whichever machine froze
//                                  the window.
//   <dir>/rows/<name>.ndjson.gz    the replay's sample rows: every kept sample of the window, one per
//                                  line in clmmRowLine's canonical bytes (ClmmRow). ts is strictly
//                                  ascending within a file and across the files in rows[] order. The
//                                  replay credits fees from them (clmm-protocol.ts, Fees), so unlike
//                                  bars-dataset/v2's samples, which are evidence only (grader/dataset.ts),
//                                  they are replay input.
//   <dir>/pools.json               the one-pool universe polled (agent-fun/bars-pools/v2), byte for
//                                  byte: its sha256 is source.pools_sha256, and its pool is the
//                                  manifest's pool block's (collector/bars/verify.ts verifyClmmDataset
//                                  checks both, so registration needs it, and every copy of the
//                                  dataset, a kit's included, keeps it). The replay reads the
//                                  manifest's pool block, never this file.
//   <dir>/manifest.json            this manifest, written last (tmp + rename).
//
// dataset_sha256 is the sha256 of the bars file's decompressed NDJSON followed by every rows file's,
// in rows[] order (clmmDatasetFiles). It commits to the bars AND the rows the replay reads.
//
// The reference sample. A bar's o_tick, o_sqrt_price_x64 and o_liquidity are one sample's state, so
// they agree with one another as a real pool state does. That sample is clmmReferenceRow of the
// samples within BARS_REFERENCE_MS of the bar's first sample (the window o is the median of): sorted
// by sqrt_price_x64 ascending, then ts, the one at index (n - 1) >> 1, the lower median. A price is
// monotonic in the sqrt price, so with an odd count that sample's price is o. The c_ three are the
// same over the close's window (the samples within BARS_REFERENCE_MS of the bar's last). The replay
// mints and withdraws positions at those sqrt prices, and swaps at o and c.
//
// Gaps and acceptance. gaps.missing_hours are the window's hours with no sample (bars + missing_hours
// = window.hours). The window is accepted exactly when missing_hours x 10000 <= hours x
// CLMM_MAX_GAP_BPS (2%), the bars gap rule (collector/bars/freeze.ts MAX_GAP_BPS). A rejected window
// is kept for inspection only. gaps.long_intervals counts the intervals between consecutive rows
// longer than CLMM_MAX_FEE_INTERVAL_MS (30 s): no fee is credited over one. gaps.longest_interval_ms
// is the longest interval between consecutive rows.

import { z } from 'zod';
import { BARS_REFERENCE_MS, BarsDatasetLine, barsFilePath, type BarsDatasetLineT } from './bars-dataset.ts';
import { BARS_QUOTE, BarsScale, BarSymbol, BarTime, barsIssuer, USDC_DECIMALS, USDC_MINT, whenBarsValid } from './bars-protocol.ts';
import {
  CLMM_BAR_MS,
  CLMM_MAX_FEE_INTERVAL_MS,
  ClmmBarDepth,
  ClmmFeeGrowthPair,
  clmmPoolIssues,
  ClmmSqrtPriceX64,
  ClmmTick,
  ClmmTokenPair,
  ClmmVenue,
  U128,
  type ClmmPoolT,
} from './clmm-protocol.ts';
import { IsoDateTime, Pubkey, Sha256Hex, Slot, Slug, U64, U8 } from './primitives.ts';

export const CLMM_DATASET_SCHEMA = 'agent-fun/clmm-dataset/v1';

/** A window is rejected when it misses more than this share of its hours (bps): 2%, collector/bars/freeze.ts MAX_GAP_BPS. */
export const CLMM_MAX_GAP_BPS = 200;

/** The acceptance rule (see the header): at least one bar, and missing hours x 10000 <= hours x CLMM_MAX_GAP_BPS. */
export function clmmWindowAccepted(bars: number, missingHours: number, hours: number): boolean {
  return bars >= 1 && missingHours * 10_000 <= hours * CLMM_MAX_GAP_BPS;
}

const Count = z.int().min(0);
/** ms since the Unix epoch. */
const Ms = z.int().min(0);

// ---------------------------------------------------------------- rows

/** One kept sample of the pool, as the replay reads it: the pool account's state and its vaults, read at `slot`. */
export const ClmmRow = z
  .strictObject({
    /** ms since the Unix epoch when the read's response arrived. */
    ts: Ms,
    /** The response's context.slot. */
    slot: Slot,
    /** USDC per whole asset at the pool's price_scale, floored (collector/bars/samples.ts samplePrice). */
    price: U64,
    sqrt_price_x64: ClmmSqrtPriceX64,
    /** The pool's in-range liquidity. */
    liquidity: U128,
    /** The pool's current tick. */
    tick: ClmmTick,
    /** Its two vaults' token amounts, [a, b]. */
    vaults: ClmmTokenPair,
    /** Its global fee growth per token (Q64.64, wrapping), [a, b]. */
    fee_growth: ClmmFeeGrowthPair,
  })
  .superRefine((r, ctx) => {
    if (BigInt(r.price) < 1n) barsIssuer(ctx)(['price'], 'prices are above 0');
  }, whenBarsValid);

/** A row's canonical line: keys in ClmmRow's order, no spaces, `\n`-terminated. */
export function clmmRowLine(row: ClmmRowT): string {
  const r = ClmmRow.parse(row);
  return `${JSON.stringify({ ts: r.ts, slot: r.slot, price: r.price, sqrt_price_x64: r.sqrt_price_x64, liquidity: r.liquidity, tick: r.tick, vaults: [r.vaults[0], r.vaults[1]], fee_growth: [r.fee_growth[0], r.fee_growth[1]] })}\n`;
}

/** The fields of a recorded sample (collector/bars/samples.ts BarsSample) a row is projected from. */
export interface ClmmSampleFields {
  ts: number;
  slot: number;
  venue: string;
  price: string;
  sqrt_price_x64: string | null;
  liquidity?: string | undefined;
  tick?: number | undefined;
  vaults?: readonly string[] | undefined;
  fee_growth?: readonly string[] | undefined;
  sol_usdc?: unknown;
}

/**
 * A recorded sample as a row, or why it cannot be one: an AMM v4 or SOL-quoted sample, one without
 * its liquidity and tick, its vaults or its fee growth (a recording made without --fee-growth), or a
 * value a row refuses. Never throws.
 */
export function clmmRowOf(s: ClmmSampleFields): { ok: true; row: ClmmRowT } | { ok: false; reason: string } {
  if (!(ClmmVenue.options as readonly string[]).includes(s.venue)) return { ok: false, reason: `a ${s.venue} sample is not a concentrated pool's` };
  if (s.sol_usdc !== undefined && s.sol_usdc !== null) return { ok: false, reason: 'a SOL-quoted sample: the pool must be quoted in USDC' };
  if (s.liquidity === undefined || s.tick === undefined) return { ok: false, reason: 'the sample lacks its liquidity and tick' };
  if (s.vaults === undefined) return { ok: false, reason: 'the sample lacks its vaults' };
  if (s.fee_growth === undefined) return { ok: false, reason: 'the sample lacks its fee growth (recorded without --fee-growth)' };
  const r = ClmmRow.safeParse({ ts: s.ts, slot: s.slot, price: s.price, sqrt_price_x64: s.sqrt_price_x64, liquidity: s.liquidity, tick: s.tick, vaults: s.vaults, fee_growth: s.fee_growth });
  if (!r.success) {
    const issue = r.error.issues[0];
    return { ok: false, reason: `not a row: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}` };
  }
  return { ok: true, row: r.data };
}

/**
 * A reference window's reference sample (see the header): of a non-empty list, sorted by
 * sqrt_price_x64 ascending then ts, the one at index (n - 1) >> 1.
 */
export function clmmReferenceRow<T extends { ts: number; sqrt_price_x64: string }>(rows: readonly T[]): T {
  if (rows.length === 0) throw new RangeError('the reference sample of no rows');
  const sorted = [...rows].sort((x, y) => {
    const a = BigInt(x.sqrt_price_x64);
    const b = BigInt(y.sqrt_price_x64);
    return a < b ? -1 : a > b ? 1 : x.ts - y.ts;
  });
  return sorted[(sorted.length - 1) >> 1]!;
}

/** The rows within BARS_REFERENCE_MS of a bar's first row (its open window) and of its last (its close window), rows in ts order. */
export function clmmReferenceWindows<T extends { ts: number }>(rows: readonly T[]): { open: T[]; close: T[] } {
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined) throw new RangeError('the reference windows of no rows');
  return { open: rows.filter((r) => r.ts < first.ts + BARS_REFERENCE_MS), close: rows.filter((r) => r.ts > last.ts - BARS_REFERENCE_MS) };
}

// ---------------------------------------------------------------- bars

const barsLineKeys = ['t', 'o', 'h', 'l', 'c', 'v', 'o_depth', 'c_depth', 'venue', 'first_slot', 'last_slot', 'samples'] as const;

/**
 * One line of the bars file: a bars-dataset/v2 line (BarsDatasetLine, its rules included) of the pool,
 * v null (pool state has no volume) and one hop of depth (the pool is USDC-quoted), plus the pool's
 * state in the open's reference sample (o_tick, o_sqrt_price_x64, o_liquidity) and in the close's (c_).
 */
export const ClmmDatasetLine = z
  .strictObject({
    t: BarTime,
    o: U64,
    h: U64,
    l: U64,
    c: U64,
    v: z.null(),
    o_depth: ClmmBarDepth,
    c_depth: ClmmBarDepth,
    venue: ClmmVenue,
    first_slot: Slot,
    last_slot: Slot,
    samples: z.int().min(1),
    o_tick: ClmmTick,
    c_tick: ClmmTick,
    o_sqrt_price_x64: ClmmSqrtPriceX64,
    c_sqrt_price_x64: ClmmSqrtPriceX64,
    o_liquidity: U128,
    c_liquidity: U128,
  })
  .superRefine((b, ctx) => {
    const issue = barsIssuer(ctx);
    if (b.t % CLMM_BAR_MS !== 0) issue(['t'], 't is not a whole UTC hour');
    const bars = BarsDatasetLine.safeParse(clmmBarsLineOf(b));
    if (!bars.success) for (const i of bars.error.issues) issue(i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)), i.message);
    if (b.samples === 1 && (b.o_tick !== b.c_tick || b.o_sqrt_price_x64 !== b.c_sqrt_price_x64 || b.o_liquidity !== b.c_liquidity)) {
      issue(['samples'], 'a one-sample bar has one reference sample: its o_ and c_ states are alike');
    }
  }, whenBarsValid);

/** The bars-dataset/v2 line a ClmmDatasetLine extends: its first twelve keys. */
export function clmmBarsLineOf(line: Pick<ClmmDatasetLineT, (typeof barsLineKeys)[number]>): BarsDatasetLineT {
  return { t: line.t, o: line.o, h: line.h, l: line.l, c: line.c, v: line.v, o_depth: [...line.o_depth], c_depth: [...line.c_depth], venue: line.venue, first_slot: line.first_slot, last_slot: line.last_slot, samples: line.samples };
}

/** A bars file line's canonical bytes: keys in ClmmDatasetLine's order (bars-dataset/v2's, then the reference states), no spaces, `\n`-terminated. */
export function clmmNdjsonLine(line: ClmmDatasetLineT): string {
  const b = ClmmDatasetLine.parse(line);
  return `${JSON.stringify({
    t: b.t,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
    o_depth: b.o_depth,
    c_depth: b.c_depth,
    venue: b.venue,
    first_slot: b.first_slot,
    last_slot: b.last_slot,
    samples: b.samples,
    o_tick: b.o_tick,
    c_tick: b.c_tick,
    o_sqrt_price_x64: b.o_sqrt_price_x64,
    c_sqrt_price_x64: b.c_sqrt_price_x64,
    o_liquidity: b.o_liquidity,
    c_liquidity: b.c_liquidity,
  })}\n`;
}

/** The pool's bars file, relative to the dataset root: bars-dataset/v2's path for its asset. */
export function clmmBarsFilePath(asset: string): string {
  return barsFilePath(asset);
}

// ---------------------------------------------------------------- the manifest

export const ClmmBarsFile = z.strictObject({
  /** bars/<ASSET>.ndjson.gz (clmmBarsFilePath). */
  path: z.string().regex(/^bars\/[A-Z0-9]{1,20}\.ndjson\.gz$/, 'expected bars/<ASSET>.ndjson.gz'),
  /** sha256 of the file as stored (gzip bytes). */
  sha256: Sha256Hex,
  bytes: Count,
  /** sha256 of the decompressed NDJSON. */
  ndjson_sha256: Sha256Hex,
  /** Lines: hours with at least one sample. */
  bars: z.int().min(1),
});

export const ClmmRowsFile = z
  .strictObject({
    path: z.string().regex(/^rows\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.ndjson\.gz$/, 'expected rows/<name>.ndjson.gz'),
    sha256: Sha256Hex,
    bytes: Count,
    ndjson_sha256: Sha256Hex,
    rows: z.int().min(1),
    /** Its first and last row's ts. */
    first_ts: Ms,
    last_ts: Ms,
  })
  .superRefine((f, ctx) => {
    // ts strictly ascending: n rows span at least n - 1 ms, and one row spans none
    const span = f.last_ts - f.first_ts;
    if (span < f.rows - 1 || (f.rows === 1 && span !== 0)) barsIssuer(ctx)(['last_ts'], `${f.rows} rows of strictly ascending ts cannot run from ${f.first_ts} to ${f.last_ts}`);
  }, whenBarsValid);

/** The pool the window sampled: pools.json's entry for its asset, the replay's facts of it. */
export const ClmmDatasetPool = z
  .strictObject({
    /** pools.json's asset ticker. */
    asset: BarSymbol,
    /** The asset's mint: the one of mint_a and mint_b that is not USDC's. */
    mint: Pubkey,
    /** The asset's mint's decimals. */
    decimals: U8,
    venue: ClmmVenue,
    pool: Pubkey,
    mint_a: Pubkey,
    mint_b: Pubkey,
    tick_spacing: z.int().min(1).max(65_535),
    /** Prices are integers at this scale: p / 10^price_scale USDC per whole asset. */
    price_scale: BarsScale,
  })
  .superRefine((p, ctx) => {
    const issue = barsIssuer(ctx);
    clmmPoolIssues(p, [], issue);
    if (p.mint === USDC_MINT || (p.mint !== p.mint_a && p.mint !== p.mint_b)) issue(['mint'], `${p.asset}: mint is the pool's asset side, the one of mint_a and mint_b that is not USDC's`);
  }, whenBarsValid);

/** Our own poller of Solana DEX pool accounts (collector/bars), recording fee growth. */
export const ClmmSource = z
  .strictObject({
    vendor: z.literal('solana-dex-pools'),
    /** What every price is in. */
    quote: z.strictObject({ symbol: z.literal(BARS_QUOTE), mint: z.literal(USDC_MINT), decimals: z.literal(USDC_DECIMALS) }),
    interval: z.literal('1h'),
    /** The poller's cadence (10 s). */
    sample_every_ms: z.int().min(1),
    /** sha256 of the frozen pools.json the poller read. */
    pools_sha256: Sha256Hex,
  })
  .superRefine((s, ctx) => {
    if (s.sample_every_ms >= CLMM_BAR_MS) barsIssuer(ctx)(['sample_every_ms'], 'a bar needs more than one sample per hour');
  }, whenBarsValid);

export const ClmmWindow = z.strictObject({
  /** The first hour's open time (ms): a whole UTC hour. */
  start_ms: BarTime,
  /** The last hour's close time (ms): a whole UTC hour, after start_ms. */
  end_ms: BarTime,
  /** Hours in the window: (end_ms - start_ms) / 1 h. */
  hours: z.int().min(1),
});

/** The gap stats (see the header). */
export const ClmmGaps = z.strictObject({
  /** Hours of the window with no sample: bars.bars + missing_hours = window.hours. */
  missing_hours: Count,
  /** Intervals between consecutive rows longer than CLMM_MAX_FEE_INTERVAL_MS: no fee is credited over one. */
  long_intervals: Count,
  /** The longest interval between consecutive rows (0 with one row). */
  longest_interval_ms: Count,
});

export const ClmmDatasetManifest = z
  .strictObject({
    schema: z.literal(CLMM_DATASET_SCHEMA),
    id: Slug,
    /** accepted windows are graded; a rejected one is kept for inspection only. Exactly the gap rule's verdict (clmmWindowAccepted). */
    status: z.enum(['accepted', 'rejected']),
    created_at: IsoDateTime,
    source: ClmmSource,
    pool: ClmmDatasetPool,
    window: ClmmWindow,
    gaps: ClmmGaps,
    /** The hourly bars file. */
    bars: ClmmBarsFile,
    /** The sample row files, in code-unit order of path and in ts order. */
    rows: z.array(ClmmRowsFile).min(1),
    /** sha256 of the bars file's decompressed NDJSON and then every rows file's, in rows[] order (clmmDatasetFiles). */
    dataset_sha256: Sha256Hex,
    /** A freeze either finishes or writes no manifest; the key matches agent-fun/dataset/v1's. */
    fatal: z.null(),
  })
  .superRefine((m, ctx) => {
    const issue = barsIssuer(ctx);
    const { start_ms, end_ms, hours } = m.window;
    if (start_ms % CLMM_BAR_MS !== 0) issue(['window', 'start_ms'], 'start_ms is not a whole UTC hour');
    if (end_ms % CLMM_BAR_MS !== 0) issue(['window', 'end_ms'], 'end_ms is not a whole UTC hour');
    if (end_ms <= start_ms) issue(['window', 'end_ms'], 'end_ms must be after start_ms');
    else if ((end_ms - start_ms) / CLMM_BAR_MS !== hours) issue(['window', 'hours'], `the window holds ${(end_ms - start_ms) / CLMM_BAR_MS} hours, not ${hours}`);

    if (m.bars.path !== clmmBarsFilePath(m.pool.asset)) issue(['bars', 'path'], `${m.pool.asset}'s bars file is ${clmmBarsFilePath(m.pool.asset)}`);
    if (m.bars.bars + m.gaps.missing_hours !== hours) issue(['gaps', 'missing_hours'], `bars ${m.bars.bars} + missing_hours ${m.gaps.missing_hours} != the window's ${hours} hours`);
    const verdict = clmmWindowAccepted(m.bars.bars, m.gaps.missing_hours, hours) ? 'accepted' : 'rejected';
    if (m.status !== verdict) issue(['status'], `${m.gaps.missing_hours} of ${hours} hours missing: the gap rule (${CLMM_MAX_GAP_BPS} bps) makes the window ${verdict}`);

    let total = 0;
    m.rows.forEach((f, i) => {
      total += f.rows;
      if (i === 0) {
        if (f.first_ts < start_ms) issue(['rows', i, 'first_ts'], 'the first row is before the window');
        return;
      }
      const prev = m.rows[i - 1]!;
      if (prev.path >= f.path) issue(['rows', i, 'path'], prev.path === f.path ? `duplicate rows file ${f.path}` : `rows files must be in code-unit order: ${f.path} after ${prev.path}`);
      if (f.first_ts <= prev.last_ts) issue(['rows', i, 'first_ts'], `rows run in ts order across the files: ${f.path} starts at ${f.first_ts}, ${prev.path} ends at ${prev.last_ts}`);
    });
    const first = m.rows[0]!.first_ts;
    const last = m.rows.at(-1)!.last_ts;
    if (last >= end_ms) issue(['rows', m.rows.length - 1, 'last_ts'], 'the last row is after the window');
    if (total < m.bars.bars) issue(['bars', 'bars'], `${m.bars.bars} bars from ${total} rows: every bar holds a row`);

    // the interval stats agree with the rows: n rows have n - 1 intervals spanning first..last
    const g = m.gaps;
    const span = last - first;
    if (g.long_intervals > total - 1) issue(['gaps', 'long_intervals'], `${total} rows have ${total - 1} intervals, not ${g.long_intervals} long ones`);
    if ((g.long_intervals > 0) !== (g.longest_interval_ms > CLMM_MAX_FEE_INTERVAL_MS)) issue(['gaps', 'long_intervals'], `long_intervals counts the intervals over ${CLMM_MAX_FEE_INTERVAL_MS} ms: some exactly when the longest (${g.longest_interval_ms} ms) is one`);
    if (g.longest_interval_ms > span || (total > 1 && g.longest_interval_ms * (total - 1) < span)) issue(['gaps', 'longest_interval_ms'], `the longest of ${total - 1} intervals spanning ${span} ms cannot be ${g.longest_interval_ms} ms`);
  }, whenBarsValid);

/** The files dataset_sha256 covers, in its order: the bars file, then every rows file in rows[] order. */
export function clmmDatasetFiles(m: Pick<ClmmDatasetManifestT, 'bars' | 'rows'>): string[] {
  return [m.bars.path, ...m.rows.map((r) => r.path)];
}

/**
 * Whether a harness's pool (clmm-protocol.ts ClmmPool) is the dataset's: the first key that differs
 * and how, or null when every one agrees.
 */
export function clmmPoolMismatch(harness: ClmmPoolT, dataset: ClmmDatasetPoolT): string | null {
  for (const k of ['venue', 'pool', 'mint_a', 'mint_b', 'decimals', 'tick_spacing'] as const) {
    if (harness[k] !== dataset[k]) return `the harness's pool ${k} is ${harness[k]}, the dataset's ${dataset[k]}`;
  }
  return null;
}

export type ClmmRowT = z.infer<typeof ClmmRow>;
export type ClmmDatasetLineT = z.infer<typeof ClmmDatasetLine>;
export type ClmmBarsFileT = z.infer<typeof ClmmBarsFile>;
export type ClmmRowsFileT = z.infer<typeof ClmmRowsFile>;
export type ClmmDatasetPoolT = z.infer<typeof ClmmDatasetPool>;
export type ClmmSourceT = z.infer<typeof ClmmSource>;
export type ClmmWindowT = z.infer<typeof ClmmWindow>;
export type ClmmGapsT = z.infer<typeof ClmmGaps>;
export type ClmmDatasetManifestT = z.infer<typeof ClmmDatasetManifest>;
