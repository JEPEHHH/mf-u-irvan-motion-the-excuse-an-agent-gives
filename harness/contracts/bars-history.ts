// agent-fun/bars-history/v1: a seeding-only history window of a house bars competition's universe,
// built from GeckoTerminal's public pool OHLCV of the exact pools its pools.json names
// (collector/bars/history.ts, `collector/bars/cli.ts history`). It exists so the seeding gate
// baseline_dev_run (server/seeding/templates/bars-beat-strategy/dev-run.ts devWindowOf) can replay a
// house baseline on real-shaped hourly bars before the house's own recorded window is frozen and
// attached. It is never a competition's data:
//   - it registers as its own dataset format (grader/dataset.ts 'bars-history'), which no harness
//     grades on, so POST /api/admin/datasets/register refuses to attach it to any phase
//     (server/admin/dataset-register.ts datasetFitsHarness) and no kit ever serves it. CoinGecko's
//     API terms forbid re-distributing it (the vendor's terms, below), and the house rules promise
//     bars from our own poller "never from an exchange or a data vendor";
//   - devWindowOf takes one only while no recorded window is attached to the house's dev phase: a
//     recorded window always wins once one is.
//
// The vendor's terms, as read on 2026-11-04. GeckoTerminal's keyless endpoints, the ones the builder
// calls (GECKOTERMINAL_API), are "governed by the CoinGecko API Terms of Service"
// (https://docs.coingecko.com/docs/keyless-public-api). GeckoTerminal's own site terms forbid storing
// or deriving from its content "without our Company's prior written consent (or as may be specifically
// stated on our Site in relation to any particular portion of our Content such as use of our
// GeckoTerminal API pursuant to our API Terms of Service)" (https://www.geckoterminal.com/terms-conditions,
// version of 11 August 2025, clause 4.1). The API terms (https://www.coingecko.com/en/api_terms, version
// of 5 Sept 2025) bind this data in three ways:
//   - what may be stored (section 6, Data Caching and Storage): "We do not encourage caching or storage
//     of Data. However, if you must cache or store Data:- You should refresh the cache at least every 24
//     hours; Strong encryption and other security measures should be applied to stored Data; [...] In
//     the event that CoinGecko terminates your access to or use of the CoinGecko API (regardless of
//     reasons), you agree to promptly and permanently delete all Data and any other information that
//     you have stored pursuant to your use of or access to the CoinGecko API, without keeping any copy
//     thereof unless required by applicable law." Then: "Except as expressly permitted hereunder this
//     API Terms, you are not allowed to duplicate, reproduce, copy, store, derive from or translate any
//     Data, API Documentation, or any information expressed by the Data (including but not limited to
//     hashed or transferred data)."
//   - what may be passed on (section 4, Scope of Use): "you are not permitted to sell, rent, lease,
//     sub-license, re-distribute or syndicate access to the CoinGecko API or part thereof (unless
//     pursuant to the terms of an Executed Agreement that you enter into with CoinGecko)."
//   - attribution (section 4): "you shall duly attribute ownership of the CoinGecko API to CoinGecko by
//     displaying prominently the message “Powered by CoinGecko” in a legible font [...] no smaller than
//     font size 10". The keyless page adds: "If you display data from CoinGecko or GeckoTerminal keyless
//     endpoints in your application, website, or project, you are required to provide appropriate
//     attribution." For on-chain data, the attribution guide
//     (https://brand.coingecko.com/resources/attribution-guide) asks for one of "On-chain data provided
//     by GeckoTerminal", "Powered by GeckoTerminal", "Source: GeckoTerminal" or "Powered by CoinGecko
//     API", with GeckoTerminal's logo linked to https://www.geckoterminal.com, placed "in a visible
//     location, close to where the data is displayed".
// The keyless page also calls these endpoints "not recommended for production environments" and points
// "commercial licensing" to the paid plans; the pricing page's licence row is blank for the free plan and
// "Commercial" from Basic up.
//
// Where a window stands under those terms. raw/ keeps every response byte for byte, and bars/ is derived
// from it. Both are kept unencrypted as long as the dataset row is, and never refreshed, because
// verifyBarsHistory re-derives every line from them. That is storage the terms "do not encourage", kept
// without the 24-hour refresh and the encryption they say it "should" have. If CoinGecko ends our access,
// every window built from it must be deleted. No window is served (no phase takes one, no kit carries
// one), so none is passed on. A seeding gate row that shows a history window's result (window_kind
// 'history', window_vendor) displays information derived from this data, so the attribution above
// applies to it.
//
// What it is, and how far it is from a recorded window (agent-fun/bars-dataset/v2):
//   - o, h, l, c are GeckoTerminal's hourly candle of the pool, priced in USD per whole token of the
//     mint (`token=<mint>`), each converted from its JSON number text to an integer at the symbol's
//     price_scale with BigInt, truncated: no float ever touches a price. A candle is built from the
//     pool's trades, so its prices are fee-inclusive and side-dependent: about one pool fee (~25 bps
//     p50, #152) from the house's 5-minute medians of the pool's mid. A candle's timestamp is its OPEN
//     time; a line's t is its CLOSE time (open + 1h), as a bars dataset's is. h and l are widened to
//     cover o and c when the candle's own do not. An hour with no candle (no trade) has no line and
//     counts as a gap, and so does an hour GeckoTerminal answered twice with different prices (it
//     does now and then); answered twice alike, it is one candle. USD is read as USDC.
//   - v is null, as on a recorded line: a GeckoTerminal volume is USD, never a pool amount.
//   - o_depth and c_depth are the pools.json depths frozen with the universe (depth model
//     pools-json-frozen), constant over the window: hop 1 the pool's depth_usdc_at_freeze, a SOL-quoted
//     asset's hop 2 its SOL/USDC leg's depth_usdc_at_freeze, each in USDC raw units (6 decimals). A
//     recorded window falls back to the same frozen depth for a read without vaults or liquidity.
//   - a stocks house's window (BARS_HISTORY_HOUSE_CALENDARS) keeps only the hours wholly inside its
//     session calendar (contracts/bars-dataset.ts barsIntervalInSession), as a recorded stocks window
//     does; gaps count the in-session hours.
//   - xStocks: whether GeckoTerminal prices the raw unit or the displayed share (raw x the mint's
//     ScaledUiAmount multiplier, at most 1.0057 when #152 read them) is not established; the difference
//     sits inside the fee noise above.
// A baseline's dev score on a history window is indicative only; the gate passes on byte-equal action
// logs, which this window serves as well as a recorded one.
//
//   <dir>/manifest.json               this manifest, written last (tmp + rename)
//   <dir>/raw/<SYMBOL>-<NN>.json      every GeckoTerminal response, byte for byte as received
//                                     (source.responses: url, before_timestamp, sha256, bytes), NN its
//                                     page (01, 02, ...): page 1 asks before_timestamp = the window's
//                                     end, each next page one second before the earliest candle of
//                                     the page before, until a page holds fewer than page_limit
//                                     candles or reaches the window's start (barsHistoryNextBefore)
//   <dir>/bars/<SYMBOL>.ndjson.gz     one line per in-window (in-session) candle, barsHistoryNdjsonLine's
//                                     canonical bytes, t strictly ascending, pinnedGzip
//                                     (collector/freeze.ts) as a bars dataset's
//   <dir>/pools.json                  the house's frozen universe, byte for byte (depth.pools_sha256)
//
// collector/bars/verify.ts verifyBarsHistory re-derives every line from raw/ and pools.json byte for
// byte, and holds the window to the bars datasets' gap rule (every symbol has a bar, gaps at most 2% of
// the counted hours). dataset_sha256 is the sha256 of every bars file's decompressed NDJSON in files[]
// order, as a bars dataset's.

import { z } from 'zod';
import { IsoDateTime, Pubkey, Sha256Hex, Slug, U64 } from './primitives.ts';
import { BAR_INTERVAL_MS, BarSymbol, barsIssuer, barsOhlcIssues, checkBarsSymbolOrder, checkBarsUniverseMints, MAX_BARS_SYMBOLS, whenBarsValid } from './bars-protocol.ts';
import { BarsDatasetFile, BarsDatasetSymbol, BarsDepth, barsFilePath, barsSessionBars, barsSessionHolidaysIn, BarsSession, BarsWindow, type BarsSessionCalendarT } from './bars-dataset.ts';

export const BARS_HISTORY_SCHEMA = 'agent-fun/bars-history/v1';
/** Where the candles come from: GeckoTerminal's pool OHLCV (public API, no key). */
export const BARS_HISTORY_VENDOR = 'geckoterminal-pool-ohlcv';
export const GECKOTERMINAL_API = 'https://api.geckoterminal.com/api/v2';
export const BARS_HISTORY_NETWORK = 'solana';
/** The only interval: GeckoTerminal's `ohlcv/hour?aggregate=1`. */
export const BARS_HISTORY_INTERVAL = '1h';
export const BARS_HISTORY_INTERVAL_MS = BAR_INTERVAL_MS[BARS_HISTORY_INTERVAL];
/** The prices' currency GeckoTerminal is asked for. */
export const BARS_HISTORY_CURRENCY = 'usd';
/** The most candles GeckoTerminal returns a call (its `limit` ceiling); the builder asks for this many. */
export const BARS_HISTORY_MAX_PAGE = 1000;
/** The depth model: each hop's pools.json depth at freeze, constant over the window. */
export const BARS_HISTORY_DEPTH_MODEL = 'pools-json-frozen';
/** The most pages a symbol's candles may take (raw/<SYMBOL>-<NN>.json). */
export const BARS_HISTORY_MAX_PAGES = 99;

/**
 * The house bars competitions whose windows are frozen against a session calendar: a history window
 * of such a house carries that session, any other none. The same table as server/seeding/export.ts
 * BARS_HOUSE_CALENDARS (tests/unit/bars-history.test.ts holds them equal).
 */
export const BARS_HISTORY_HOUSE_CALENDARS: Readonly<Record<string, BarsSessionCalendarT>> = { 'solana-stocks-1h-01': 'xstocks-24x5' };

/** A symbol's response page, relative to the dataset root: raw/<SYMBOL>-<NN>.json, NN its page from 01. */
export function barsHistoryResponsePath(symbol: string, page: number): string {
  if (!Number.isInteger(page) || page < 1 || page > BARS_HISTORY_MAX_PAGES) throw new RangeError(`page ${page} is not 1 to ${BARS_HISTORY_MAX_PAGES}`);
  return `raw/${BarSymbol.parse(symbol)}-${String(page).padStart(2, '0')}.json`;
}

/** The GeckoTerminal call for one page of a pool's hourly candles, priced in USD per whole token of `mint`. */
export function barsHistoryUrl(p: { pool: string; mint: string }, beforeTimestamp: number, limit: number): string {
  return `${GECKOTERMINAL_API}/networks/${BARS_HISTORY_NETWORK}/pools/${p.pool}/ohlcv/hour?aggregate=1&limit=${limit}&currency=${BARS_HISTORY_CURRENCY}&token=${p.mint}&before_timestamp=${beforeTimestamp}`;
}

/**
 * The paging rule (see the header): after a page of candles (their open times, seconds), the next
 * page's before_timestamp, or null when this page ends the symbol's calls: it holds fewer than
 * `limit` candles (the pool's history ran out) or its earliest candle opens at or before the window's
 * start. GeckoTerminal's before_timestamp is inclusive, so the next page asks one second before the
 * earliest candle and never repeats one.
 */
export function barsHistoryNextBefore(openTimes: readonly number[], startS: number, limit: number): number | null {
  if (openTimes.length < limit || openTimes.length === 0) return null;
  const earliest = Math.min(...openTimes);
  return earliest <= startS ? null : earliest - 1;
}

/**
 * One line of a history window's bars file: the bar closing at t (ms), o h l c at the symbol's
 * price_scale, v null, and the frozen depth per hop at o and at c (USDC raw units). The replay reads it
 * as it reads a bars dataset line (sim/bars/engine.ts BarsDatasetBarInput); it carries no slot
 * provenance, having none.
 */
export const BarsHistoryLine = z
  .strictObject({ t: z.int().min(0), o: U64, h: U64, l: U64, c: U64, v: z.null(), o_depth: BarsDepth, c_depth: BarsDepth })
  .superRefine((b, ctx) => {
    const issue = barsIssuer(ctx);
    barsOhlcIssues(b, issue);
    if (b.o_depth.length !== b.c_depth.length) issue(['c_depth'], `c_depth has ${b.c_depth.length} hops, o_depth ${b.o_depth.length}: one per hop of the asset's price path`);
  }, whenBarsValid);

/** A history line's canonical bytes: keys in BarsHistoryLine's order, no spaces, `\n`-terminated. */
export function barsHistoryNdjsonLine(line: BarsHistoryLineT): string {
  const b = BarsHistoryLine.parse(line);
  return `${JSON.stringify({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, o_depth: b.o_depth, c_depth: b.c_depth })}\n`;
}

/** One GeckoTerminal response as kept under raw/: the call made and the bytes it answered. */
export const BarsHistoryResponse = z.strictObject({
  asset: BarSymbol,
  /** The pool asked: the symbol's pools.json pool. */
  pool: Pubkey,
  /** The symbol's page, from 1. */
  page: z.int().min(1).max(BARS_HISTORY_MAX_PAGES),
  /** The call's before_timestamp (s): the window's end on page 1, then barsHistoryNextBefore. */
  before_timestamp: z.int().min(0),
  /** The call (barsHistoryUrl). */
  url: z.string().min(1),
  fetched_at: IsoDateTime,
  /** raw/<SYMBOL>-<NN>.json (barsHistoryResponsePath). */
  path: z.string().regex(/^raw\/[A-Z0-9]{1,20}-[0-9]{2}\.json$/, 'expected raw/<SYMBOL>-<NN>.json'),
  /** sha256 and size of the body as received. */
  sha256: Sha256Hex,
  bytes: z.int().min(1),
});

export const BarsHistorySource = z.strictObject({
  vendor: z.literal(BARS_HISTORY_VENDOR),
  api: z.literal(GECKOTERMINAL_API),
  network: z.literal(BARS_HISTORY_NETWORK),
  interval: z.literal(BARS_HISTORY_INTERVAL),
  currency: z.literal(BARS_HISTORY_CURRENCY),
  /** Every call's limit. */
  page_limit: z.int().min(1).max(BARS_HISTORY_MAX_PAGE),
  /** Every response, in symbols[] order, each symbol's pages in order. */
  responses: z.array(BarsHistoryResponse).min(1),
});

export const BarsHistoryDepth = z.strictObject({
  model: z.literal(BARS_HISTORY_DEPTH_MODEL),
  /** sha256 of the pools.json the depths (and every symbol's pool) come from: the house's own. */
  pools_sha256: Sha256Hex,
});

const { scaled_ui: _scaledUi, ...symbolShape } = BarsDatasetSymbol.shape;
/** A universe symbol: its pool and scales (from pools.json) and its bars file, as a bars dataset's (no scaled_ui: no samples carry a multiplier). */
export const BarsHistorySymbol = z.strictObject(symbolShape);

export const BarsHistoryManifest = z
  .strictObject({
    schema: z.literal(BARS_HISTORY_SCHEMA),
    id: Slug,
    /** accepted windows register; a rejected one (the gap rule) is kept for inspection only. */
    status: z.enum(['accepted', 'rejected']),
    created_at: IsoDateTime,
    /** The house bars competition whose universe (competitions/<house>/pools.json) this is. */
    house: Slug,
    source: BarsHistorySource,
    depth: BarsHistoryDepth,
    window: BarsWindow,
    /** The house's session (BARS_HISTORY_HOUSE_CALENDARS); absent for a house without one. */
    session: BarsSession.optional(),
    /** The universe, in code-unit order of symbol: pools.json's assets. */
    symbols: z.array(BarsHistorySymbol).min(1).max(MAX_BARS_SYMBOLS),
    /** One bars file per symbol, in symbols[] order. */
    files: z.array(BarsDatasetFile).min(1).max(MAX_BARS_SYMBOLS),
    /** sha256 of every file's decompressed NDJSON, concatenated in files[] order. */
    dataset_sha256: Sha256Hex,
    fatal: z.null(),
  })
  .superRefine((m, ctx) => {
    const issue = barsIssuer(ctx);
    const step = BARS_HISTORY_INTERVAL_MS;
    const { start_ms, end_ms, bars } = m.window;
    if (start_ms % step !== 0) issue(['window', 'start_ms'], `start_ms is not a multiple of the ${BARS_HISTORY_INTERVAL} interval`);
    if (end_ms % step !== 0) issue(['window', 'end_ms'], `end_ms is not a multiple of the ${BARS_HISTORY_INTERVAL} interval`);
    if (end_ms <= start_ms) issue(['window', 'end_ms'], 'end_ms must be after start_ms');
    else if ((end_ms - start_ms) / step !== bars) issue(['window', 'bars'], `the window holds ${(end_ms - start_ms) / step} intervals, not ${bars}`);

    // the house's session, and its holidays and in-session intervals the calendar's for this window
    const want = BARS_HISTORY_HOUSE_CALENDARS[m.house];
    if (want !== undefined && m.session?.calendar !== want) issue(['session'], `${m.house}'s windows are frozen against the ${want} session calendar: a history window of it carries that session`);
    if (want === undefined && m.session !== undefined) issue(['session'], `${m.house} has no session calendar: every hour of its windows counts`);
    let counted = bars;
    let what = "the window's";
    if (m.session && end_ms > start_ms) {
      const { calendar, holidays } = m.session;
      what = `the ${calendar} session's`;
      try {
        const got = barsSessionHolidaysIn(calendar, m.window);
        if (holidays.join(',') !== got.join(',')) issue(['session', 'holidays'], `the ${calendar} holidays of this window are [${got.join(', ')}], not [${holidays.join(', ')}]`);
      } catch (e) {
        issue(['session', 'calendar'], (e as Error).message);
      }
      counted = m.session.bars;
      const inSession = barsSessionBars(m.session, m.window, step);
      if (inSession !== counted) issue(['session', 'bars'], `the window holds ${inSession} ${BARS_HISTORY_INTERVAL} intervals inside the ${calendar} session, not ${counted}`);
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

    // the responses: symbol by symbol in symbols[] order, each symbol's pages 1, 2, ... with the calls the rule makes
    const bySymbol = new Map(m.symbols.map((s, i) => [s.symbol, { s, i }]));
    let at = -1;
    let prev: { asset: string; page: number; before: number } | null = null;
    m.source.responses.forEach((r, n) => {
      const sym = bySymbol.get(r.asset);
      if (sym === undefined) {
        issue(['source', 'responses', n, 'asset'], `${r.asset} is no symbol of the window`);
        return;
      }
      if (sym.i < at) issue(['source', 'responses', n, 'asset'], `responses are in symbols[] order: ${r.asset} after ${m.symbols[at]!.symbol}`);
      const page = prev !== null && prev.asset === r.asset ? prev.page + 1 : 1;
      if (r.page !== page) issue(['source', 'responses', n, 'page'], `${r.asset}'s response ${n} is page ${r.page}, expected ${page}`);
      if (page === 1 && r.before_timestamp * 1000 !== end_ms) issue(['source', 'responses', n, 'before_timestamp'], `${r.asset}'s first page asks before ${r.before_timestamp}, not the window's end ${end_ms / 1000}`);
      if (page > 1 && prev !== null && r.before_timestamp >= prev.before) issue(['source', 'responses', n, 'before_timestamp'], `${r.asset}'s page ${r.page} asks before ${r.before_timestamp}, not before its page ${prev.page}'s ${prev.before}`);
      if (r.pool !== sym.s.pool) issue(['source', 'responses', n, 'pool'], `${r.asset}'s pool is ${sym.s.pool}, not ${r.pool}`);
      if (r.page >= 1 && r.page <= BARS_HISTORY_MAX_PAGES && r.path !== barsHistoryResponsePath(r.asset, r.page)) issue(['source', 'responses', n, 'path'], `${r.asset}'s page ${r.page} is ${barsHistoryResponsePath(r.asset, r.page)}`);
      const url = barsHistoryUrl({ pool: sym.s.pool, mint: sym.s.mint }, r.before_timestamp, m.source.page_limit);
      if (r.url !== url) issue(['source', 'responses', n, 'url'], `${r.asset}'s page ${r.page} was asked as ${url}`);
      at = Math.max(at, sym.i);
      prev = { asset: r.asset, page: r.page, before: r.before_timestamp };
    });
    const answered = new Set(m.source.responses.map((r) => r.asset));
    m.symbols.forEach((s, i) => {
      if (!answered.has(s.symbol)) issue(['symbols', i, 'symbol'], `${s.symbol} has no response in source.responses`);
    });
  }, whenBarsValid);

export type BarsHistoryLineT = z.infer<typeof BarsHistoryLine>;
export type BarsHistoryResponseT = z.infer<typeof BarsHistoryResponse>;
export type BarsHistorySourceT = z.infer<typeof BarsHistorySource>;
export type BarsHistorySymbolT = z.infer<typeof BarsHistorySymbol>;
export type BarsHistoryManifestT = z.infer<typeof BarsHistoryManifest>;
