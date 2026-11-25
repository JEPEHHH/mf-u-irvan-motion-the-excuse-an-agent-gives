// agent-fun/bars-dataset/v2: a frozen bars dataset, the input of a bars-replay/v1 run
// (contracts/bars-protocol.ts). The bars are built by our own poller from public Solana DEX pool
// state (collector/bars): every `sample_every_ms` one read of each asset's pool account and its two
// vaults, the pool named in a frozen pools.json (per asset its deepest pool on Raydium AMM v4, Orca
// Whirlpool or Raydium CLMM, quoted in USDC, or in SOL and priced through the universe's SOL/USDC
// pool, read in the same call; a pool's depth the smaller of its two sides at its own price), each
// sample's price an exact integer at the asset's price_scale, never a float.
//
// A bar covers the samples of one UTC interval (source.interval: 1h, 1d or 1m). h and l are the
// highest and lowest price of all of them. o and c are the bar's reference prices, the ones the
// replay fills and marks at: o is the median price of the samples within barsReferenceMs(interval)
// of the bar's first sample, c the median of those within it of its last. On 1h and 1d bars that is
// BARS_REFERENCE_MS, five minutes: with a 10 s cadence each median is about 30 samples, so pushing a
// thin pool for one slot at the hour boundary no longer moves the price a bot trades or is marked at.
// On 1m bars it is 10 s (BARS_1M_REFERENCE_MS), and the cadence must put at least three samples in it
// (barsCadenceIssue: sample_every_ms x 3 <= 10 s; a 2 s cadence gives five). The median of an even
// count is the floor of the mean of the two middle values (barsMedian). o_depth and c_depth are the
// pool depth over the same two windows, per hop of the asset's price path: the asset's own pool
// first, then a SOL-quoted asset's SOL/USDC leg. A hop's depth is its quote side in USDC raw units
// (6 decimals), the median of the per-sample depths:
//   - AMM v4: the sample's own reserve of the pool's quote token. At the pool's price the two sides
//     are equal, so this is the #1323 min.
//   - Whirlpool / CLMM, sample with a liquidity: the smaller of two. One is the in-range virtual
//     reserve of the quote token: L x sqrt_price / 2^64 when the quote is the pool's token B,
//     L x 2^64 / sqrt_price when it is A (L the pool account's in-range liquidity, recorded with the
//     sample with its current tick). The other caps it at what the pool holds: the smaller of the
//     sample's own two vault sides at its price, min(the quote vault, floor(the base vault x quote
//     per base)), from the vaults' balances read in the same getMultipleAccounts as the pool (the
//     sample's `vaults`, #1449), so the cap follows LPs in and out sample by sample. A sample
//     without its vaults (recorded before they were read with it) takes the min-side depth
//     pools.json froze in their place (next item), which cannot follow a withdrawal during the
//     window and may then overstate what the pool still holds.
//     The in-range reserve is virtual: live, JITOSOL/SOL's liquidity held 50.9M SOL in range beside
//     37.3k SOL in its vault, and NVDAx's $14.2M beside $1.18M. Capped, a large order never trades
//     against tokens the pool does not hold. A buy takes the asset out and a sell the quote, so the
//     cap is the smaller side. A small order inside the band is judged a little harder than the
//     curve says, never easier than the real tokens allow; entrants hunt for the most optimistic
//     fill, so the sim errs conservative.
//     Limit: the in-range reserve is exact only while a trade keeps the price between the
//     initialized ticks around it. The sample does not carry the tick arrays, so a trade big enough
//     to cross one is priced as if the liquidity held there too, though it may be thinner or deeper.
//     A liquidity of 0 (the price in a liquidity gap) is a depth of 0, the least a depth is (1).
//   - Whirlpool / CLMM, sample without a liquidity (recorded before liquidity was kept, as the first
//     window was): the min-side depth pools.json froze alone (depth_usdc_at_freeze, or for a
//     SOL-quoted pool depth_sol_at_freeze). It is the smaller of the vaults' two sides at the pool's
//     price, or the in-range depth then when that was smaller (depth_basis). It is read once at
//     freeze, not per sample. In a pools.json without depth_basis (frozen before
//     collector/bars/universe.ts measured in range) it comes from the vault balances alone. Those
//     count out-of-range liquidity as depth, but treat it as spread over the whole curve. Live, the
//     SOL/USDC pools held 25 to 38 times their vaults' USDC in range, so for an ordinary order the
//     frozen min side charges more impact than the pool would.
//   - A SOL amount is valued in USDC through the leg's price in the same sample.
// The replay charges a constant-product price impact against those depths (sim/bars/engine.ts):
// the hops in series trade as one constant-product pool of depth 1 / (1/D1 + 1/D2), and every fill
// of the symbol at one open walks it in reply order.
// Pool state carries no volume, so v is null. Ledger state carries no licence, so a kit may ship the
// dataset.
//
// Units. A price is USDC per 10^decimals RAW units of the mint (its "whole unit"), whatever the mint
// displays. A tokenized stock (xStocks: Token-2022 mints with the ScaledUiAmount extension) shows a
// holder raw x multiplier / 10^decimals shares, and the issuer raises the multiplier for dividends
// and splits (docs.xstocks.fi/docs/dividends-and-stock-splits), so a raw unit's price stays
// continuous across them and the dataset keeps it. Such a symbol carries `scaled_ui: true`, and every
// one of its samples the mint's multiplier as read in the same call (collector/bars/samples.ts
// scaled_ui): the price of one displayed share is the price / the multiplier in effect then.
//
// Sessions. A dataset may be frozen against a session calendar (`session`, BARS_SESSION_CALENDARS):
// its bars and samples are only those of intervals wholly inside the session, and gaps count only the
// in-session intervals (bars + gaps = session.bars, not window.bars). A crypto dataset has no session:
// every interval of the window counts. The DEX pools of a tokenized stock trade at all hours, but the
// issuer's market (and with it arbitrage against the share) does not, so the hours outside it are left
// out rather than graded.
//
// collector/bars/bars.ts builds the interval OHLC of the samples (BarsDatasetBar: o the first, c the
// last). collector/bars/freeze.ts referenceBars turns those bars into a bars file's lines
// (BarsDatasetLine), and verify re-derives both from the samples.
//
//   <dir>/bars/<SYMBOL>.ndjson.gz     one per universe symbol, in symbol order: one bar per line,
//                                     barsNdjsonLine's canonical bytes (BarsDatasetLine), t strictly
//                                     ascending, every t in (window.start_ms, window.end_ms] and a
//                                     multiple of the interval (with a session, its interval wholly
//                                     inside it); an interval with no sample has no line and counts
//                                     as a gap (with a session, only an in-session one). gzip level
//                                     9 with the header's OS byte pinned (collector/freeze.ts
//                                     pinnedGzip), so the bytes and the digests are the same
//                                     whichever machine froze the window.
//   <dir>/samples/<name>.ndjson.gz    the pool-state samples the bars were built from, in
//                                     collector/bars's sample records: verify re-derives every bar
//                                     from them, and each sample's slot and account-data digest can
//                                     be re-checked against the ledger.
//   <dir>/cut.json                    only when the window is a cut of a longer recording (freeze
//                                     --from / --until): the record of that recording
//                                     (collector/bars/freeze.ts BarsCut). No field of this manifest
//                                     names it, so it is inside none of its digests and the manifest's
//                                     own (the registered dataset's) is the same with or without it;
//                                     verify checks it against the manifest, and a kit ships it.
//   <dir>/manifest.json               this manifest, written last (tmp + rename).
//
// dataset_sha256 is the sha256 of every bars file's decompressed NDJSON, concatenated in files[]
// order (the replay's input; the samples are evidence, pinned by their own digests).

import { z } from 'zod';
import { IsoDateTime, Pubkey, Sha256Hex, Slot, Slug, U64, U8 } from './primitives.ts';
import {
  BAR_INTERVAL_MS,
  BarInterval,
  BARS_QUOTE,
  BarsScale,
  BarSymbol,
  BarTime,
  barsIssuer,
  barsOhlcIssues,
  checkBarsSymbolOrder,
  checkBarsUniverseMints,
  MAX_BARS_SYMBOLS,
  USDC_DECIMALS,
  USDC_MINT,
  whenBarsValid,
  type BarIntervalT,
  type BarsIssue,
} from './bars-protocol.ts';

const isPositive = (s: string) => BigInt(s) > 0n;

export const BARS_DATASET_SCHEMA = 'agent-fun/bars-dataset/v2';

/**
 * The span of a 1h or 1d bar's two reference windows (ms): its first five minutes of samples (o) and
 * its last five (c). The clmm replay's open window is the same span (contracts/clmm-dataset.ts).
 */
export const BARS_REFERENCE_MS = 300_000;
/** The span of a 1m bar's two reference windows (ms): its first 10 s of samples (o) and its last 10 s (c). */
export const BARS_1M_REFERENCE_MS = 10_000;
/** The fewest samples a 1m bar's reference window must span at the cadence (barsCadenceIssue). */
export const BARS_1M_MIN_REFERENCE_SAMPLES = 3;

/** The span of a bar's two reference windows (ms) on `interval` bars: 10 s on 1m bars, BARS_REFERENCE_MS (five minutes) on 1h and 1d. */
export function barsReferenceMs(interval: BarIntervalT): number {
  return interval === '1m' ? BARS_1M_REFERENCE_MS : BARS_REFERENCE_MS;
}

/**
 * Why a poller's cadence cannot make `interval` bars, or null when it can: a bar needs more than one
 * sample (sample_every_ms under the interval), and a 1m bar's 10 s reference window at least
 * BARS_1M_MIN_REFERENCE_SAMPLES (sample_every_ms x 3 <= 10 s, so at most 3333 ms).
 */
export function barsCadenceIssue(interval: BarIntervalT, sampleEveryMs: number): string | null {
  if (sampleEveryMs >= BAR_INTERVAL_MS[interval]) return `a bar needs more than one sample per ${interval}`;
  if (interval === '1m' && sampleEveryMs * BARS_1M_MIN_REFERENCE_SAMPLES > BARS_1M_REFERENCE_MS) {
    return `a 1m bar's ${BARS_1M_REFERENCE_MS / 1000} s reference windows need at least ${BARS_1M_MIN_REFERENCE_SAMPLES} samples each: sample_every_ms ${sampleEveryMs} is over ${Math.floor(BARS_1M_REFERENCE_MS / BARS_1M_MIN_REFERENCE_SAMPLES)}`;
  }
  return null;
}
/** The most hops an asset's price path has: its own pool, then a SOL-quoted asset's SOL/USDC leg. */
export const MAX_BARS_HOPS = 2;

/** The DEX venues a pool may live on. */
export const BARS_VENUES = ['raydium-amm-v4', 'orca-whirlpool', 'raydium-clmm'] as const;
export const BarsVenue = z.enum(BARS_VENUES);

const Count = z.int().min(0);

/**
 * The median of a non-empty list of integers: the middle value once sorted, or for an even count
 * the floor of the mean of the two middle values. A bar's o, c, o_depth and c_depth are medians.
 */
export function barsMedian(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new RangeError('the median of no values');
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

/** The shape and provenance a bar's samples give it, before its references. */
const sampledShape = {
  t: BarTime,
  o: U64,
  h: U64,
  l: U64,
  c: U64,
  v: U64.nullable(),
  venue: BarsVenue,
  first_slot: Slot,
  last_slot: Slot,
  samples: z.int().min(1),
};

type SampledFields = { o: string; h: string; l: string; c: string; first_slot: number; last_slot: number; samples: number };

/** Prices above 0 and in order, slots in order, and a one-sample bar's prices and slots all one. */
function sampledIssues(b: SampledFields, issue: BarsIssue): void {
  barsOhlcIssues(b, issue);
  if (b.first_slot > b.last_slot) issue(['last_slot'], 'last_slot is before first_slot');
  if (b.samples === 1) {
    if (!(b.o === b.h && b.h === b.l && b.l === b.c)) issue(['samples'], 'a one-sample bar has o = h = l = c');
    if (b.first_slot !== b.last_slot) issue(['samples'], 'a one-sample bar has first_slot = last_slot');
  }
}

/**
 * A bar as its samples' prices give it (collector/bars/bars.ts buildBars): the bar closing at t (its
 * open time + the interval, ms), the OHLC of the samples in [t - interval, t) (o the first, h the
 * highest, l the lowest, c the last), v null (pool state has no volume), venue the pool's,
 * first_slot and last_slot the slots of its first and last sample, samples how many it was built
 * from. Not yet a bars file line: referenceBars (collector/bars/freeze.ts) turns it into a
 * BarsDatasetLine.
 */
export const BarsDatasetBar = z.strictObject(sampledShape).superRefine((b, ctx) => sampledIssues(b, barsIssuer(ctx)), whenBarsValid);

/** A hop's depth: its quote side in USDC raw units (6 decimals), above 0. */
const HopDepth = U64.refine(isPositive, { message: 'a pool depth is above 0', ...whenBarsValid });
/** One depth per hop of the asset's price path: its own pool, then (SOL-quoted) the SOL/USDC leg. */
export const BarsDepth = z.array(HopDepth).min(1).max(MAX_BARS_HOPS);

/**
 * One line of a bars file: a BarsDatasetBar whose o and c are the bar's reference prices (the medians
 * of its first and last barsReferenceMs(interval) of samples, see the header), with the pool depth over each
 * window (o_depth, c_depth: per hop, USDC raw units). h and l stay the extremes of every sample. Prices
 * are at the symbol's price_scale.
 */
export const BarsDatasetLine = z
  .strictObject({ ...sampledShape, o_depth: BarsDepth, c_depth: BarsDepth })
  .superRefine((b, ctx) => {
    const issue = barsIssuer(ctx);
    sampledIssues(b, issue);
    if (b.o_depth.length !== b.c_depth.length) issue(['c_depth'], `c_depth has ${b.c_depth.length} hops, o_depth ${b.o_depth.length}: one per hop of the asset's price path`);
    else if (b.samples === 1 && b.o_depth.some((d, i) => d !== b.c_depth[i])) issue(['c_depth'], 'a one-sample bar has o_depth = c_depth');
  }, whenBarsValid);

/** A bars file line's canonical bytes: keys in BarsDatasetLine's order, no spaces, `\n`-terminated. */
export function barsNdjsonLine(line: BarsDatasetLineT): string {
  const b = BarsDatasetLine.parse(line);
  return `${JSON.stringify({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, o_depth: b.o_depth, c_depth: b.c_depth, venue: b.venue, first_slot: b.first_slot, last_slot: b.last_slot, samples: b.samples })}\n`;
}

/** A symbol's bars file, relative to the dataset root. */
export function barsFilePath(symbol: string): string {
  return `bars/${BarSymbol.parse(symbol)}.ndjson.gz`;
}

export const BarsDatasetFile = z.strictObject({
  /** bars/<SYMBOL>.ndjson.gz (barsFilePath). */
  path: z.string().regex(/^bars\/[A-Z0-9]{1,20}\.ndjson\.gz$/, 'expected bars/<SYMBOL>.ndjson.gz'),
  /** sha256 of the file as stored (gzip bytes). */
  sha256: Sha256Hex,
  bytes: Count,
  /** sha256 of the decompressed NDJSON. */
  ndjson_sha256: Sha256Hex,
  bars: Count,
});

export const BarsSamplesFile = z.strictObject({
  path: z.string().regex(/^samples\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.ndjson\.gz$/, 'expected samples/<name>.ndjson.gz'),
  sha256: Sha256Hex,
  bytes: Count,
  ndjson_sha256: Sha256Hex,
  samples: Count,
});

/** A universe symbol of the dataset: its pool (from pools.json), its scales and its bars file. */
export const BarsDatasetSymbol = z.strictObject({
  /** pools.json's asset ticker. */
  symbol: BarSymbol,
  mint: Pubkey,
  /** The mint's decimals. */
  decimals: U8,
  venue: BarsVenue,
  /** The pool account sampled. */
  pool: Pubkey,
  /** Prices are integers at this scale: p / 10^price_scale USDC per whole unit of the asset. */
  price_scale: BarsScale,
  /** Quantities in the replay are integers at this scale, at most the mint's decimals. */
  qty_scale: BarsScale,
  /** Its bars file (barsFilePath) and that file's facts, as in files[]. */
  file: BarsDatasetFile.shape.path,
  sha256: Sha256Hex,
  bytes: Count,
  ndjson_sha256: Sha256Hex,
  bars: Count,
  /** Intervals of the window (of its session, with one) with no bar: bars + gaps = window.bars (session.bars). */
  gaps: Count,
  /**
   * Present (true) when the mint carries Token-2022 ScaledUiAmount: every sample of the symbol carries
   * the mint's multiplier (samples' scaled_ui), prices stay per 10^decimals raw units (see the header).
   */
  scaled_ui: z.literal(true).optional(),
});

// ---------------------------------------------------------------- session calendars

/**
 * Session calendars a dataset may be frozen against.
 *
 *   xstocks-24x5  the issuer's 24/5 schedule, for xStocks whose trading.tradingHoursMode is
 *                 TwentyFourFive (GET https://api.xstocks.fi/api/v2/public/assets/<symbol>). The
 *                 issuer's OpenAPI (https://docs.xstocks.fi/_bundle/apis/@v2/openapi.yaml,
 *                 limitsPerPeriod) names the periods: overnight 8:00 PM - 4:00 AM ET, extended 4:00 -
 *                 9:30 AM and 4:00 - 8:00 PM ET, market 9:30 AM - 4:00 PM ET, closed "weekends and
 *                 holidays"; docs.xstocks.fi: "Issuance and redemption through the issuer operate 24/5,
 *                 aligned with U.S. equity market hours". So the session runs from 20:00 America/New_York
 *                 on Sunday to 20:00 on Friday. Session day D (Monday to Friday) runs from 20:00 on the
 *                 evening before to 20:00 on D, and a full-day NYSE holiday closes its session day:
 *                 trading "ends at 8 p.m. ET on the calendar day before the holiday and reopens at 8
 *                 p.m. ET on the holiday itself" (Charles Schwab, How Does After-Hours Trading Work;
 *                 Alpaca's 24/5 docs say the same of Thanksgiving). The holidays are NYSE's for 2026 to
 *                 2028 (https://www.nyse.com/trade/hours-calendars, BARS_SESSION_HOLIDAYS); an early-close
 *                 day is a whole session day. America/New_York is UTC-5, and UTC-4 from 02:00 local on
 *                 the second Sunday of March to 02:00 local on the first Sunday of November (15 U.S.C.
 *                 260a), so every edge of the session falls on a whole UTC hour and a 1h or 1m
 *                 interval is wholly in or out.
 */
export const BARS_SESSION_CALENDARS = ['xstocks-24x5'] as const;
export const BarsSessionCalendar = z.enum(BARS_SESSION_CALENDARS);
export type BarsSessionCalendarT = z.infer<typeof BarsSessionCalendar>;

/** A calendar's closed weekdays (America/New_York dates) and the session days its list covers. */
export interface BarsSessionHolidays {
  /** The first and last session day the list speaks for (YYYY-MM-DD, inclusive). */
  from: string;
  to: string;
  dates: readonly string[];
}

/** Each calendar's holidays: NYSE's full-day closures, 2026 to 2028 (nyse.com/trade/hours-calendars, as listed 2026-10-28). */
export const BARS_SESSION_HOLIDAYS: Readonly<Record<BarsSessionCalendarT, BarsSessionHolidays>> = {
  'xstocks-24x5': {
    from: '2026-01-01',
    to: '2028-12-31',
    dates: [
      // 2026: New Year's Day, Martin Luther King Jr. Day, Washington's Birthday, Good Friday, Memorial Day,
      // Juneteenth, Independence Day (observed), Labor Day, Thanksgiving, Christmas
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-04-03',
      '2026-05-25',
      '2026-06-19',
      '2026-07-03',
      '2026-09-07',
      '2026-11-26',
      '2026-12-25',
      // 2027: the same ten; Juneteenth, Independence Day and Christmas observed
      '2027-01-01',
      '2027-01-18',
      '2027-02-15',
      '2027-03-26',
      '2027-05-31',
      '2027-06-18',
      '2027-07-05',
      '2027-09-06',
      '2027-11-25',
      '2027-12-24',
      // 2028: no New Year's Day holiday (January 1 is a Saturday)
      '2028-01-17',
      '2028-02-21',
      '2028-04-14',
      '2028-05-29',
      '2028-06-19',
      '2028-07-04',
      '2028-09-04',
      '2028-11-23',
      '2028-12-25',
    ],
  },
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** ms since the epoch of 00:00 UTC on a day of a month (1-based) of a year. */
const utcDay = (y: number, month: number, day: number) => Date.UTC(y, month - 1, day);

/** The UTC instant of 02:00 local on the n-th Sunday (n >= 1) of a month, local being UTC + offsetH. */
function nthSundayAt2(y: number, month: number, n: number, offsetH: number): number {
  const first = utcDay(y, month, 1);
  const weekday = new Date(first).getUTCDay();
  const day = 1 + ((7 - weekday) % 7) + 7 * (n - 1);
  return utcDay(y, month, day) + (2 - offsetH) * HOUR_MS;
}

/** America/New_York's offset from UTC at an instant (ms): -4 h in daylight time, -5 h otherwise (15 U.S.C. 260a). */
export function newYorkOffsetMs(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const start = nthSundayAt2(y, 3, 2, -5);
  const end = nthSundayAt2(y, 11, 1, -4);
  return ms >= start && ms < end ? -4 * HOUR_MS : -5 * HOUR_MS;
}

const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * The xstocks-24x5 session day an instant belongs to: its America/New_York date, or the next day from
 * 20:00 on (YYYY-MM-DD), and that day's weekday (0 Sunday .. 6 Saturday).
 */
export function barsSessionDay(ms: number): { date: string; weekday: number } {
  const local = ms + newYorkOffsetMs(ms);
  const day = Math.floor(local / DAY_MS) + (local - Math.floor(local / DAY_MS) * DAY_MS >= 20 * HOUR_MS ? 1 : 0);
  return { date: isoDay(day), weekday: (((day + 4) % 7) + 7) % 7 };
}

/** The session a dataset was frozen against: its calendar and the holidays the window holds. */
export interface BarsSessionRule {
  calendar: BarsSessionCalendarT;
  holidays: readonly string[];
}

/** Whether the calendar is open at an instant: its session day is a weekday and not one of the holidays. */
export function barsSessionOpen(rule: BarsSessionRule, ms: number): boolean {
  const d = barsSessionDay(ms);
  return d.weekday >= 1 && d.weekday <= 5 && !rule.holidays.includes(d.date);
}

/** Whether every instant of [openMs, closeMs) is in session (the session's edges fall on whole UTC hours). */
export function barsIntervalInSession(rule: BarsSessionRule, openMs: number, closeMs: number): boolean {
  for (let at = openMs; at < closeMs; at = (Math.floor(at / HOUR_MS) + 1) * HOUR_MS) {
    if (!barsSessionOpen(rule, at)) return false;
  }
  return true;
}

/** The window's intervals wholly inside the session. */
export function barsSessionBars(rule: BarsSessionRule, window: { start_ms: number; end_ms: number }, intervalMs: number): number {
  let n = 0;
  for (let t = window.start_ms; t < window.end_ms; t += intervalMs) if (barsIntervalInSession(rule, t, t + intervalMs)) n++;
  return n;
}

/**
 * The calendar's holidays among the window's session days, ascending; throws when the window reaches
 * a session day the calendar's holiday list does not cover.
 */
export function barsSessionHolidaysIn(calendar: BarsSessionCalendarT, window: { start_ms: number; end_ms: number }): string[] {
  const h = BARS_SESSION_HOLIDAYS[calendar];
  const first = barsSessionDay(window.start_ms).date;
  const last = barsSessionDay(window.end_ms - 1).date;
  if (first < h.from || last > h.to) throw new RangeError(`the ${calendar} holiday list covers session days ${h.from} to ${h.to}; the window runs from ${first} to ${last}`);
  return h.dates.filter((d) => d >= first && d <= last);
}

/** A window's session under a calendar: the holidays it holds and its in-session intervals. */
export function barsSessionOf(calendar: BarsSessionCalendarT, window: { start_ms: number; end_ms: number }, intervalMs: number): BarsSessionT {
  const holidays = barsSessionHolidaysIn(calendar, window);
  return { calendar, holidays, bars: barsSessionBars({ calendar, holidays }, window, intervalMs) };
}

/** The session a dataset was frozen against (see BARS_SESSION_CALENDARS). */
export const BarsSession = z.strictObject({
  calendar: BarsSessionCalendar,
  /** The calendar's holidays among the window's session days, ascending (America/New_York dates). */
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date')),
  /** The window's intervals wholly inside the session: every symbol's bars + gaps. */
  bars: z.int().min(1),
});

/** Our own poller of Solana DEX pool accounts (collector/bars). */
export const SolanaDexPoolsSource = z
  .strictObject({
    vendor: z.literal('solana-dex-pools'),
    /** What every price is in. */
    quote: z.strictObject({ symbol: z.literal(BARS_QUOTE), mint: z.literal(USDC_MINT), decimals: z.literal(USDC_DECIMALS) }),
    /** The bar interval: 1h, 1d or 1m (BAR_INTERVALS). */
    interval: BarInterval,
    /** The poller's cadence (10 s; 2 s for 1m bars): under the interval, and on 1m bars at most 3333 ms (barsCadenceIssue). */
    sample_every_ms: z.int().min(1),
    /** sha256 of the frozen pools.json the poller read. */
    pools_sha256: Sha256Hex,
    /** The samples files, in code-unit order of path. */
    samples: z.array(BarsSamplesFile).min(1),
  })
  .superRefine((s, ctx) => {
    const issue = barsIssuer(ctx);
    for (let i = 1; i < s.samples.length; i++) {
      const prev = s.samples[i - 1]!.path;
      const cur = s.samples[i]!.path;
      if (prev >= cur) issue(['samples', i, 'path'], prev === cur ? `duplicate samples file ${cur}` : `samples files must be in code-unit order: ${cur} after ${prev}`);
    }
    const cadence = barsCadenceIssue(s.interval, s.sample_every_ms);
    if (cadence) issue(['sample_every_ms'], cadence);
  }, whenBarsValid);

/** Where the bars came from: one variant per source, keyed by vendor. */
export const BarsSource = z.discriminatedUnion('vendor', [SolanaDexPoolsSource]);

export const BarsWindow = z.strictObject({
  /** The first bar's open time (ms): a multiple of the interval. */
  start_ms: BarTime,
  /** The last bar's close time (ms): a multiple of the interval, after start_ms. */
  end_ms: BarTime,
  /** Intervals in the window: (end_ms - start_ms) / the interval. */
  bars: z.int().min(1),
});

export const BarsDatasetManifest = z
  .strictObject({
    schema: z.literal(BARS_DATASET_SCHEMA),
    id: Slug,
    /** accepted windows are graded; a rejected one is kept for inspection only. */
    status: z.enum(['accepted', 'rejected']),
    created_at: IsoDateTime,
    source: BarsSource,
    window: BarsWindow,
    /** The session calendar the window was frozen against; absent (every crypto dataset) when every interval counts. */
    session: BarsSession.optional(),
    /** The universe, in code-unit order of symbol, each bound to a distinct mint. */
    symbols: z.array(BarsDatasetSymbol).min(1).max(MAX_BARS_SYMBOLS),
    /** One bars file per symbol, in symbols[] order. */
    files: z.array(BarsDatasetFile).min(1).max(MAX_BARS_SYMBOLS),
    /** sha256 of every file's decompressed NDJSON, concatenated in files[] order. */
    dataset_sha256: Sha256Hex,
    /** A freeze either finishes or writes no manifest; the key matches agent-fun/dataset/v1's. */
    fatal: z.null(),
  })
  .superRefine((m, ctx) => {
    const issue = barsIssuer(ctx);
    const step = BAR_INTERVAL_MS[m.source.interval];
    const { start_ms, end_ms, bars } = m.window;
    if (start_ms % step !== 0) issue(['window', 'start_ms'], `start_ms is not a multiple of the ${m.source.interval} interval`);
    if (end_ms % step !== 0) issue(['window', 'end_ms'], `end_ms is not a multiple of the ${m.source.interval} interval`);
    if (end_ms <= start_ms) issue(['window', 'end_ms'], 'end_ms must be after start_ms');
    else if ((end_ms - start_ms) / step !== bars) issue(['window', 'bars'], `the window holds ${(end_ms - start_ms) / step} intervals, not ${bars}`);
    // a session's holidays and in-session intervals are the calendar's for this window
    let counted = bars;
    let what = "the window's";
    if (m.session && end_ms > start_ms) {
      const { calendar, holidays } = m.session;
      what = `the ${calendar} session's`;
      try {
        const want = barsSessionHolidaysIn(calendar, m.window);
        if (holidays.join(',') !== want.join(',')) issue(['session', 'holidays'], `the ${calendar} holidays of this window are [${want.join(', ')}], not [${holidays.join(', ')}]`);
      } catch (e) {
        issue(['session', 'calendar'], (e as Error).message);
      }
      counted = m.session.bars;
      const inSession = barsSessionBars(m.session, m.window, step);
      if (inSession !== counted) issue(['session', 'bars'], `the window holds ${inSession} ${m.source.interval} intervals inside the ${calendar} session, not ${counted}`);
    }

    checkBarsSymbolOrder(m.symbols, ['symbols'], issue);
    checkBarsUniverseMints(m.symbols, ['symbols'], issue);
    m.symbols.forEach((s, i) => {
      if (s.file !== barsFilePath(s.symbol)) issue(['symbols', i, 'file'], `${s.symbol}'s file is ${barsFilePath(s.symbol)}`);
      if (s.bars + s.gaps !== counted) issue(['symbols', i, 'gaps'], `${s.symbol}: bars ${s.bars} + gaps ${s.gaps} != ${what} ${counted}`);
      if (s.qty_scale > s.decimals) issue(['symbols', i, 'qty_scale'], `${s.symbol}: qty_scale ${s.qty_scale} is finer than the mint's ${s.decimals} decimals`);
    });

    if (m.files.length !== m.symbols.length) issue(['files'], `${m.files.length} files for ${m.symbols.length} symbols: one per symbol`);
    m.files.forEach((f, i) => {
      const s = m.symbols[i];
      if (s === undefined) return;
      if (f.path !== s.file) issue(['files', i, 'path'], `files[${i}] is ${f.path}, symbols[${i}] names ${s.file}`);
      else {
        for (const k of ['sha256', 'bytes', 'ndjson_sha256', 'bars'] as const) {
          if (f[k] !== s[k]) issue(['files', i, k], `files[${i}].${k} disagrees with ${s.symbol}'s`);
        }
      }
    });
  }, whenBarsValid);

export type BarsDatasetManifestT = z.infer<typeof BarsDatasetManifest>;
export type BarsDatasetBarT = z.infer<typeof BarsDatasetBar>;
export type BarsDatasetLineT = z.infer<typeof BarsDatasetLine>;
export type BarsDepthT = z.infer<typeof BarsDepth>;
export type BarsDatasetFileT = z.infer<typeof BarsDatasetFile>;
export type BarsSamplesFileT = z.infer<typeof BarsSamplesFile>;
export type BarsDatasetSymbolT = z.infer<typeof BarsDatasetSymbol>;
export type BarsSourceT = z.infer<typeof BarsSource>;
export type BarsVenueT = z.infer<typeof BarsVenue>;
export type BarsWindowT = z.infer<typeof BarsWindow>;
export type BarsSessionT = z.infer<typeof BarsSession>;
