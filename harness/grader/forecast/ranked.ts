// The ranked forecast: the canonical scoring rule of make.fun's forecast contests (node22, standard library only, and no
// import of any kind). grader/forecast/ranked.ts is the canonical copy. Each forecast bundle vendors it byte for byte
// as competitions/<slug>/scorer/ranked.ts, because its scorer container holds only the sealed scorer directory, and
// tests/unit/forecast-ranked.test.ts holds every copy to these bytes: change this file, then copy it to every bundle.
// Pure: the caller reads the files.
//
// THE FORECAST-BUNDLE TEMPLATE (.cosmos/rules/contest-design.mdc, the owner's 2026-11-07 ask). Every forecast contest is
//   - program/v1 with `final_dataset: true`: its final is graded on a sealed program dataset the house froze after the
//     window closed (contracts/program-dataset.ts), so no entry can have seen the outcomes it is scored on;
//   - scored on many outcomes in order: a place-by-id probability matrix scored at every place of every read in the
//     window (places x reads), plus each id's size in bins where the outcome has a magnitude (a stock's return);
//   - the log score in nats: ln max(p, P_FLOOR) per outcome with P_FLOOR = 1e-4 (ln = -9.210340, so a miss costs 9.21
//     and never minus infinity), summed over the places (and the sizes) of a read, averaged over a day's reads, and
//     summed over days by the bundle; higher is better, 0 the best;
//   - proper for the place marginals, not the joint: each place is its own log score, so the best forecast states each
//     id's true probability at each place, and knowing how the places move together earns nothing. #3186 measured that
//     joint edge at 1.47 nats, below the per-day sd of about 1.9 to 4.4. The floor bends propriety only for
//     probabilities under 1e-4;
//   - gated on the house baselines: a prize needs a score strictly above the best house entry, the persistence
//     baseline (the kit's starter) and the house model one-shot (grader/house-forecast.ts, entered by
//     scripts/competitions/house-forecast.ts), both flagged baseline;
//   - spray-checked before it ships: scripts/forecast/spray-sim.ts, run on s4, must find P(the best account of a
//     5,000-account fleet of likely orders scores above a calibrated forecaster) <= 5%.
//
// THE FORECAST (parseRanked, under a RankedSpec): at most maxBytes of UTF-8 JSON, one object with exactly the keys
// `probabilities` and topKey, plus every key of extraKeys when the spec names some (their values are the bundle's to
// read, sizes through parseSizes):
//   probabilities  a list of rows, each exactly {<idKey>, place, p}: the id (idKind 'int': a positive safe integer;
//                  'string': a non-empty string), place an integer from 1 to places, and p a number from 0 to 1. Each
//                  (id, place) appears at most once, a place has at most maxRowsPerPlace rows, and each place's p add
//                  up to at most 1 + SUM_TOLERANCE. An empty list is a forecast: every place spread evenly. Nothing
//                  bounds an id's p summed over the places: each place is scored on its own and each place's log
//                  score is proper, so a forecast incoherent across places cannot gain by it.
//   <topKey>       exactly `places` distinct ids, place 1 first: the point guess, for the hits and the tie-break.
// Anything else is not a forecast: parseRanked says why, and the bundle scores it the floor at every place.
//
// THE SCORES, against a read's chart (its ids, place 1 first; the house's, so a chart that lists no id or one id twice
// throws, as does any other house-side input out of shape: a spec, a floor, bin edges):
//   P_k(id)        placeProbability: the row's own p when the forecast names the id at place k; otherwise place k's
//                  unnamed mass, max(0, 1 - the sum of its rows), shared equally by the chart's ids it does not name
//                  at place k (0 when it names them all). An id the forecast names off the chart still spends its p.
//   order score    orderLogScore: the sum over k = 1 .. n = min(places, the chart's length) of
//                  ln max(P_k(chart[k]), floor), from n x -9.210340 (every place floored) to 0.
//   a day          meanLogScore: the order score's mean over the day's reads. Summing the days is the bundle's.
//   hits           hitsOf: how many ids of the top list are among the chart's first `places`.
//   agreement      agreementOf, the tie-break: for each id in both, `places` minus the distance between its two places
//                  (10 places: the same place 10, one place apart 9, ...), summed: 0 to places².
//
// SIZES (parseSizes, for stocks): a list of rows, each exactly {<idKey>, bin, p}, over a universe of ids and strictly
// ascending bin edges. Bin 0 holds r < edges[0], bin i holds edges[i-1] <= r < edges[i], and bin edges.length holds
// r >= the last edge (binOf), so 41 edges at 0.5 pp from -10% to +10% make 42 bins, 2 of them the tails. Each id is in
// the universe, each (id, bin) appears at most once, and each id's p add up to at most 1 + SUM_TOLERANCE; an id's
// unnamed mass is shared equally by its unnamed bins (sizeProbability). sizeLogScore: the sum over the ids with an
// actual return of ln max(P(the id's bin), floor). Order and size are both proper, so their sum is.

/** The log score's floor: an outcome given less than this scores ln(1e-4) = -9.210340, never minus infinity. */
export const P_FLOOR = 1e-4;
/** How far over 1 a sum of probabilities may run (float rounding). */
export const SUM_TOLERANCE = 1e-9;
/** RankedSpec.maxRowsPerPlace when the spec names none. */
export const DEFAULT_MAX_ROWS_PER_PLACE = 100;
/** RankedSpec.maxBytes when the spec names none. */
export const DEFAULT_MAX_BYTES = 1_048_576;

/** An id: a positive safe integer (idKind 'int', a Roblox universe id) or a non-empty string (idKind 'string', a symbol). */
export type RankedId = number | string;
export type IdKind = 'int' | 'string';

/** A bundle's forecast format (the header). */
export interface RankedSpec {
  /** The places scored and the top list's length: 10 for a top-10 chart. */
  places: number;
  /** The id's key in a row: `universe_id`, `symbol`. */
  idKey: string;
  idKind: IdKind;
  /** The top list's key: `top10`. */
  topKey: string;
  /** The most rows a place may have (DEFAULT_MAX_ROWS_PER_PLACE). */
  maxRowsPerPlace?: number;
  /** The most bytes the forecast file may hold (DEFAULT_MAX_BYTES). */
  maxBytes?: number;
  /** More top-level keys the document must hold, read by the bundle (`sizes`). */
  extraKeys?: readonly string[];
}

export interface RankedRow {
  id: RankedId;
  place: number;
  p: number;
}

/** A forecast that reads (parseRanked). */
export interface RankedForecast {
  places: number;
  /** The rows in the document's order. */
  rows: RankedRow[];
  /** The top list, place 1 first. */
  top: RankedId[];
  /** Each extraKeys key's value as the document holds it. */
  extras: Record<string, unknown>;
  /** Place k's rows by id at index k - 1. */
  named: Map<RankedId, number>[];
  /** Place k's sum of p at index k - 1. */
  sums: number[];
}

export type ParsedRanked = { ok: true; forecast: RankedForecast } | { ok: false; why: string };

/** A bundle's size format: the universe and the bin edges come from its task. */
export interface SizeSpec {
  idKey: string;
  idKind: IdKind;
  /** Every id a row may name: the universe. */
  ids: readonly RankedId[];
  /** Strictly ascending finite bin edges (binOf). */
  edges: readonly number[];
  /** The document key the rows came from, for the reasons (default `sizes`). */
  key?: string;
}

export interface SizeRow {
  id: RankedId;
  bin: number;
  p: number;
}

/** Sizes that read (parseSizes). */
export interface RankedSizes {
  edges: number[];
  /** edges.length + 1. */
  bins: number;
  /** The rows in the document's order. */
  rows: SizeRow[];
  /** Each universe id's rows by bin (an empty map for an id no row names). */
  named: Map<RankedId, Map<number, number>>;
  /** Each universe id's sum of p. */
  sums: Map<RankedId, number>;
}

export type ParsedSizes = { ok: true; sizes: RankedSizes } | { ok: false; why: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isProbability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const hasExactly = (row: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(row).length === keys.length && keys.every((k) => Object.hasOwn(row, k));

function isIdOf(kind: IdKind, v: unknown): v is RankedId {
  return kind === 'int' ? typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 : typeof v === 'string' && v.length > 0;
}

function idWords(kind: IdKind): string {
  return kind === 'int' ? 'a positive integer' : 'a non-empty string';
}

function show(id: RankedId): string {
  return typeof id === 'string' ? JSON.stringify(id) : String(id);
}

function checkFloor(floor: number): void {
  if (!(Number.isFinite(floor) && floor > 0 && floor <= 1)) throw new RangeError(`the floor ${floor} is not a probability above 0`);
}

function checkEdges(edges: readonly number[]): void {
  if (!Array.isArray(edges) || edges.length === 0) throw new RangeError('the bin edges list no edge');
  for (let i = 0; i < edges.length; i++) {
    if (typeof edges[i] !== 'number' || !Number.isFinite(edges[i])) throw new RangeError(`bin edge ${i} is not a finite number`);
    if (i > 0 && !(edges[i]! > edges[i - 1]!)) throw new RangeError(`the bin edges are not strictly ascending at edge ${i}`);
  }
}

function checkIdKind(kind: unknown): asserts kind is IdKind {
  if (kind !== 'int' && kind !== 'string') throw new TypeError(`idKind ${JSON.stringify(kind)} is not 'int' or 'string'`);
}

function checkIdKey(key: unknown, reserved: readonly string[]): void {
  if (typeof key !== 'string' || key.length === 0 || reserved.includes(key)) throw new TypeError(`idKey ${JSON.stringify(key)} is not a key of its own beside ${reserved.join(' and ')}`);
}

function checkChart(chart: readonly RankedId[]): void {
  if (!Array.isArray(chart) || chart.length === 0) throw new RangeError('the chart lists no id');
  if (new Set(chart).size !== chart.length) throw new RangeError('the chart lists an id twice');
}

function checkSpec(spec: RankedSpec): { maxRows: number; maxBytes: number; keys: string[] } {
  if (!Number.isSafeInteger(spec.places) || spec.places < 1) throw new RangeError(`places ${spec.places} is not a positive integer`);
  checkIdKind(spec.idKind);
  checkIdKey(spec.idKey, ['place', 'p']);
  if (typeof spec.topKey !== 'string' || spec.topKey.length === 0 || spec.topKey === 'probabilities') throw new TypeError(`topKey ${JSON.stringify(spec.topKey)} is not a key of its own beside probabilities`);
  const maxRows = spec.maxRowsPerPlace ?? DEFAULT_MAX_ROWS_PER_PLACE;
  const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new RangeError(`maxRowsPerPlace ${maxRows} is not a positive integer`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError(`maxBytes ${maxBytes} is not a positive integer`);
  const keys = ['probabilities', spec.topKey, ...(spec.extraKeys ?? [])];
  if (new Set(keys).size !== keys.length || keys.some((k) => typeof k !== 'string' || k.length === 0)) throw new TypeError(`the document keys ${JSON.stringify(keys)} are not distinct non-empty strings`);
  return { maxRows, maxBytes, keys };
}

/** Rounded to 6 decimals, the precision every fractional score is written at (never -0). */
export function round6(x: number): number {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** The forecast in `bytes` (the header's format under `spec`), or the reason it is not one. `null`: no file. */
export function parseRanked(bytes: Uint8Array | null, spec: RankedSpec): ParsedRanked {
  const { maxRows, maxBytes, keys } = checkSpec(spec);
  const { places, idKey, idKind, topKey } = spec;
  if (bytes === null) return { ok: false, why: 'no forecast file (a regular file)' };
  if (bytes.length > maxBytes) return { ok: false, why: `the forecast is over ${maxBytes} bytes` };
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (err) {
    return { ok: false, why: `the forecast is not UTF-8 JSON: ${(err as Error).message}` };
  }
  if (!isObject(doc)) return { ok: false, why: 'the forecast is not one JSON object' };
  const have = Object.keys(doc).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) return { ok: false, why: `the forecast's keys are ${JSON.stringify(have)}, not exactly ${JSON.stringify(want)}` };
  const list = doc.probabilities;
  if (!Array.isArray(list)) return { ok: false, why: 'probabilities is not a list' };
  const shape = [idKey, 'place', 'p'];
  const named: Map<RankedId, number>[] = Array.from({ length: places }, () => new Map<RankedId, number>());
  const sums: number[] = new Array<number>(places).fill(0);
  const rows: RankedRow[] = [];
  for (const [i, row] of list.entries()) {
    if (!isObject(row) || !hasExactly(row, shape)) return { ok: false, why: `probabilities[${i}] is not exactly {${idKey}, place, p}` };
    const id = row[idKey];
    if (!isIdOf(idKind, id)) return { ok: false, why: `probabilities[${i}].${idKey} is not ${idWords(idKind)}` };
    const place = row.place;
    if (typeof place !== 'number' || !Number.isInteger(place) || place < 1 || place > places) return { ok: false, why: `probabilities[${i}].place is not an integer from 1 to ${places}` };
    const p = row.p;
    if (!isProbability(p)) return { ok: false, why: `probabilities[${i}].p is not a number from 0 to 1` };
    const at = named[place - 1]!;
    if (at.has(id)) return { ok: false, why: `${idKey} ${show(id)} is named twice at place ${place}` };
    if (at.size === maxRows) return { ok: false, why: `place ${place} has more than ${maxRows} rows` };
    at.set(id, p);
    sums[place - 1] += p;
    rows.push({ id, place, p });
  }
  for (let k = 1; k <= places; k++) {
    const sum = sums[k - 1]!;
    if (sum > 1 + SUM_TOLERANCE) return { ok: false, why: `place ${k}'s probabilities add up to ${sum}, more than 1` };
  }
  const top = doc[topKey];
  if (!Array.isArray(top) || top.length !== places || !top.every((v) => isIdOf(idKind, v)) || new Set(top).size !== places) return { ok: false, why: `${topKey} is not ${places} distinct ids, each ${idWords(idKind)}` };
  const extras: Record<string, unknown> = {};
  for (const key of spec.extraKeys ?? []) extras[key] = doc[key];
  return { ok: true, forecast: { places, rows, top: top as RankedId[], extras, named, sums } };
}

/** P_k(id) (the header): the probability `f` gives `id` at `place`, where `chartIds` is every id of the read's chart. */
export function placeProbability(f: RankedForecast, place: number, id: RankedId, chartIds: readonly RankedId[]): number {
  if (!Number.isInteger(place) || place < 1 || place > f.places) throw new RangeError(`place ${place} is not from 1 to ${f.places}`);
  const at = f.named[place - 1]!;
  const own = at.get(id);
  if (own !== undefined) return own;
  let unnamed = 0;
  for (const c of new Set(chartIds)) if (!at.has(c)) unnamed += 1;
  const left = Math.max(0, 1 - f.sums[place - 1]!);
  return unnamed === 0 ? 0 : left / unnamed;
}

/** The order score of `f` on one read (the header): `chart` is its ids, place 1 first. */
export function orderLogScore(f: RankedForecast, chart: readonly RankedId[], floor: number = P_FLOOR): number {
  checkFloor(floor);
  checkChart(chart);
  const n = Math.min(f.places, chart.length);
  let total = 0;
  for (let k = 1; k <= n; k++) total += Math.log(Math.max(placeProbability(f, k, chart[k - 1]!, chart), floor));
  return total;
}

/** The order score's mean over a day's reads (`charts`, each place 1 first). */
export function meanLogScore(f: RankedForecast, charts: readonly (readonly RankedId[])[], floor: number = P_FLOOR): number {
  if (!Array.isArray(charts) || charts.length === 0) throw new RangeError('no read to score');
  let total = 0;
  for (const chart of charts) total += orderLogScore(f, chart, floor);
  return total / charts.length;
}

/** How many ids of `top` are among the first top.length ids of `actual`. */
export function hitsOf(top: readonly RankedId[], actual: readonly RankedId[]): number {
  const head = actual.slice(0, top.length);
  let hits = 0;
  for (const id of top) if (head.includes(id)) hits += 1;
  return hits;
}

/** The tie-break (the header): for each id of `top` among the first top.length ids of `actual`, top.length minus the distance between its two places, summed. */
export function agreementOf(top: readonly RankedId[], actual: readonly RankedId[]): number {
  const width = top.length;
  const head = actual.slice(0, width);
  let points = 0;
  top.forEach((id, i) => {
    const j = head.indexOf(id);
    if (j >= 0) points += width - Math.abs(i - j);
  });
  return points;
}

/** The bin of the value `r` under strictly ascending `edges` (the header): how many edges are at or below it. */
export function binOf(r: number, edges: readonly number[]): number {
  checkEdges(edges);
  if (typeof r !== 'number' || !Number.isFinite(r)) throw new RangeError(`the value ${r} is not a finite number`);
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid]! <= r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The size rows in `rows` (the header's format under `spec`, a document value parseRanked kept in extras), or the reason they are not. */
export function parseSizes(rows: unknown, spec: SizeSpec): ParsedSizes {
  checkIdKind(spec.idKind);
  checkIdKey(spec.idKey, ['bin', 'p']);
  checkEdges(spec.edges);
  const key = spec.key ?? 'sizes';
  const { idKey, idKind } = spec;
  if (!Array.isArray(spec.ids) || spec.ids.length === 0) throw new RangeError('the size universe lists no id');
  const named = new Map<RankedId, Map<number, number>>();
  const sums = new Map<RankedId, number>();
  for (const id of spec.ids) {
    if (!isIdOf(idKind, id)) throw new TypeError(`the size universe's id ${String(id)} is not ${idWords(idKind)}`);
    if (named.has(id)) throw new RangeError(`the size universe lists ${show(id)} twice`);
    named.set(id, new Map<number, number>());
    sums.set(id, 0);
  }
  const bins = spec.edges.length + 1;
  if (!Array.isArray(rows)) return { ok: false, why: `${key} is not a list` };
  const shape = [idKey, 'bin', 'p'];
  const out: SizeRow[] = [];
  for (const [i, row] of rows.entries()) {
    if (!isObject(row) || !hasExactly(row, shape)) return { ok: false, why: `${key}[${i}] is not exactly {${idKey}, bin, p}` };
    const id = row[idKey];
    if (!isIdOf(idKind, id)) return { ok: false, why: `${key}[${i}].${idKey} is not ${idWords(idKind)}` };
    const at = named.get(id);
    if (at === undefined) return { ok: false, why: `${key}[${i}].${idKey} ${show(id)} is not in the universe` };
    const bin = row.bin;
    if (typeof bin !== 'number' || !Number.isInteger(bin) || bin < 0 || bin >= bins) return { ok: false, why: `${key}[${i}].bin is not an integer from 0 to ${bins - 1}` };
    const p = row.p;
    if (!isProbability(p)) return { ok: false, why: `${key}[${i}].p is not a number from 0 to 1` };
    if (at.has(bin)) return { ok: false, why: `${idKey} ${show(id)} is named twice at bin ${bin}` };
    at.set(bin, p);
    sums.set(id, sums.get(id)! + p);
    out.push({ id, bin, p });
  }
  for (const [id, sum] of sums) if (sum > 1 + SUM_TOLERANCE) return { ok: false, why: `${idKey} ${show(id)}'s ${key} add up to ${sum}, more than 1` };
  return { ok: true, sizes: { edges: [...spec.edges], bins, rows: out, named, sums } };
}

/** The probability `s` gives `id`'s value falling in `bin`: the row's own p, else the id's unnamed mass shared equally by its unnamed bins. */
export function sizeProbability(s: RankedSizes, id: RankedId, bin: number): number {
  const at = s.named.get(id);
  if (at === undefined) throw new RangeError(`${show(id)} is not in the size universe`);
  if (!Number.isInteger(bin) || bin < 0 || bin >= s.bins) throw new RangeError(`bin ${bin} is not from 0 to ${s.bins - 1}`);
  const own = at.get(bin);
  if (own !== undefined) return own;
  const unnamed = s.bins - at.size;
  const left = Math.max(0, 1 - s.sums.get(id)!);
  return unnamed === 0 ? 0 : left / unnamed;
}

/** The size score of `s` (the header): `actual` is each id's realised value, only the ids that have one. */
export function sizeLogScore(s: RankedSizes, actual: ReadonlyMap<RankedId, number>, floor: number = P_FLOOR): number {
  checkFloor(floor);
  if (actual.size === 0) throw new RangeError('no id has an actual value to score');
  let total = 0;
  for (const [id, r] of actual) total += Math.log(Math.max(sizeProbability(s, id, binOf(r, s.edges)), floor));
  return total;
}
