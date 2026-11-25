// The house model forecast's Twitch viewers kind (gta6-twitch-ccu-forecast-01: program/v1, `cases: per-file`, each case
// /input/<id>.in of schema makefun/twitch-ccu-case/v1). The model is asked ONCE a phase (grader/house-forecast.ts
// callHouseForecast) for each case id it is shown: 23 median ratios r_h to the case's hour-1 print and 23 log spreads
// s_h, h = 2..24. The house's entry (grader/house-forecast-entry-twitch-ccu/main.ts, the same arithmetic) applies that one
// answer to every case it is run on, with no model call:
//
//   q_tau = p x r_h x exp(z_tau x s_h), rounded to 2 decimals, p = max(1, the case's hour-1 print)
//
// A case id the answer lacks takes the persistence baseline's numbers (r_h 1, s_h 0.15 x sqrt(h - 1)), the kit's
// starter's digit for digit. The final's call is made before hour 1 has begun (the history cut, 2026-11-18T23:00Z): its
// ratios are to hour 1's print, whatever it turns out to be, and are replayed on h00.
//
//   twitchCcuInstanceBytes   the descriptor that stands for the instance's task.json (its sha256 the record's key)
//   twitchCcuForecastSchema  the forecast document's JSON schema for the case ids asked
//   parseTwitchCcuForecast   the house's own parse of the forecast document (the bundle's scorer reads <id>.out)
//   twitchCcuForecastContract the output contract the prompt states
//   compactTwitchCcuHistory  the cases as the prompt gives them, compacted
//   twitchCcuCaseOutputBytes the <id>.out the entry writes for a case, byte for byte the entry's main.ts's

import { canonicalJson } from '../sim/canonical.ts';

/** A Twitch viewers case file's schema (the bundle's scorer/forecast.ts CASE_SCHEMA). */
export const TWITCH_CCU_CASE_SCHEMA = 'makefun/twitch-ccu-case/v1';
/** The house-built descriptor the instance stands for its task.json with. */
export const TWITCH_CCU_INSTANCE_SCHEMA = 'makefun/house-forecast/twitch-ccu-instance/v1';
/** The descriptor's `output`: the forecast document the entry applies (each case's own output is <id>.out). */
export const TWITCH_CCU_FORECAST_FILE = 'forecast.json';
/** The hours forecast, 2 to 24 of the case's day. */
export const TWITCH_CCU_HOURS: readonly number[] = Object.freeze(Array.from({ length: 23 }, (_, i) => i + 2));
/** The standard normal's quantile at each of the levels 0.05, 0.25, 0.5, 0.75 and 0.95: the starter's. */
export const TWITCH_CCU_Z: readonly number[] = Object.freeze([-1.645, -0.674, 0, 0.674, 1.645]);
/** The persistence baseline's spread, in log units per square-root hour (the starter's SIGMA). */
export const TWITCH_CCU_BASELINE_SIGMA = 0.15;
/** The bounds a forecast's ratios and spreads keep to. */
export const TWITCH_CCU_RATIO_MIN = 0.01;
export const TWITCH_CCU_RATIO_MAX = 100;
export const TWITCH_CCU_SPREAD_MAX = 3;
/** The compact history's own last hours of a case's history_hourly, and the comparables' days around their release. */
export const HOUSE_FORECAST_TWITCH_CCU_HOURS = 72;

const HOUR_MS = 3_600_000;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One case's parameters: ratios[h - 2] and spreads[h - 2] for h = 2..24. */
export interface TwitchCcuParams {
  ratios: number[];
  spreads: number[];
}

/** The persistence baseline's parameters: r_h 1, s_h 0.15 x sqrt(h - 1). */
export const TWITCH_CCU_BASELINE_PARAMS: Readonly<TwitchCcuParams> = Object.freeze({
  ratios: TWITCH_CCU_HOURS.map(() => 1),
  spreads: TWITCH_CCU_HOURS.map((h) => TWITCH_CCU_BASELINE_SIGMA * Math.sqrt(h - 1)),
});

/** A case as the house reads it (the fields it uses; the bundle's scorer holds the whole contract). */
export interface TwitchCcuCase {
  schema: string;
  id: string;
  day_start: string;
  checkpoint: string;
  known: Array<{ hour: number; viewers: number; channels?: number | null; reads?: number }>;
  forecast: Array<{ hour: number }>;
  history_hourly: Array<{ from: string; viewers: number; channels: number | null; reads?: number }>;
  streams: Array<{ login: string; viewers: number; language: string | null; started_at: string | null }> | null;
  comparables: Array<{ name: string; day_start: string; unlock: string; platforms: string; hourly: Array<{ from: string; viewers: number; channels: number | null }> }>;
  game: { name: string; twitch_id: string };
  notes?: string;
}

/** A case document's bytes as a TwitchCcuCase, or a TypeError naming what is off. */
export function parseTwitchCcuCase(bytes: Uint8Array | string, where = 'the case'): TwitchCcuCase {
  let doc: unknown;
  try {
    doc = JSON.parse(typeof bytes === 'string' ? bytes : utf8.decode(bytes));
  } catch {
    throw new TypeError(`${where} is not UTF-8 JSON`);
  }
  if (!isRecord(doc) || doc.schema !== TWITCH_CCU_CASE_SCHEMA) throw new TypeError(`${where} is not a ${TWITCH_CCU_CASE_SCHEMA} case`);
  for (const k of ['id', 'day_start', 'checkpoint']) if (typeof doc[k] !== 'string') throw new TypeError(`${where}'s ${k} is not a string`);
  for (const k of ['known', 'forecast', 'history_hourly', 'comparables']) if (!Array.isArray(doc[k])) throw new TypeError(`${where}'s ${k} is not a list`);
  return doc as unknown as TwitchCcuCase;
}

/** What the descriptor names. */
export interface TwitchCcuInstance {
  competition: string;
  phase: 'dev' | 'final';
  deadline: string;
  /** The history cut: the last instant the forecast sees, ISO. */
  history_until: string;
  /** The case ids the model forecasts, in order. */
  cases: string[];
  /** sha256 of the history document's exact bytes (the practice cases, or the final's history cut at history_until). */
  history_sha256: string;
}

/** The descriptor: canonical JSON {schema, competition, phase, deadline, history_until, hours, cases, history_sha256, output} and a newline. */
export function twitchCcuInstanceBytes(i: TwitchCcuInstance): Uint8Array {
  return new TextEncoder().encode(
    `${canonicalJson({
      schema: TWITCH_CCU_INSTANCE_SCHEMA,
      competition: i.competition,
      phase: i.phase,
      deadline: i.deadline,
      history_until: i.history_until,
      hours: [...TWITCH_CCU_HOURS],
      cases: [...i.cases],
      history_sha256: i.history_sha256,
      output: TWITCH_CCU_FORECAST_FILE,
    })}\n`,
  );
}

/** The forecast document's schema: {cases: one row per case id, {id, ratios: 23 numbers, spreads: 23 numbers}}; no uniqueItems (superbot's grammar refuses it). */
export function twitchCcuForecastSchema(caseIds: readonly string[]): Record<string, unknown> {
  const n = caseIds.length;
  const hours = TWITCH_CCU_HOURS.length;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['cases'],
    properties: {
      cases: {
        type: 'array',
        minItems: n,
        maxItems: n,
        description: `One row per case: each of its ${n} case ids exactly once, no id twice.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'ratios', 'spreads'],
          properties: {
            id: { type: 'string', enum: [...caseIds], description: 'The case id, as the history names it.' },
            ratios: {
              type: 'array',
              minItems: hours,
              maxItems: hours,
              items: { type: 'number', minimum: TWITCH_CCU_RATIO_MIN, maximum: TWITCH_CCU_RATIO_MAX },
              description: "For hours 2 to 24 in order: the median of that hour's count as a multiple of hour 1's count (1 = the same as hour 1).",
            },
            spreads: {
              type: 'array',
              minItems: hours,
              maxItems: hours,
              items: { type: 'number', minimum: 0, maximum: TWITCH_CCU_SPREAD_MAX },
              description: "For hours 2 to 24 in order: the standard deviation of that hour's count in natural-log units around the median (0.15 x sqrt(h - 1) is the persistence baseline's).",
            },
          },
        },
      },
    },
  };
}

/** The forecast document's bytes for `caseIds`: exactly {cases}, each row exactly {id, ratios, spreads}, every id once, 23 finite numbers each in bounds. */
export function parseTwitchCcuForecast(bytes: Uint8Array, caseIds: readonly string[]): { ok: true; params: Map<string, TwitchCcuParams> } | { ok: false; why: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(utf8.decode(bytes));
  } catch {
    return { ok: false, why: 'the forecast is not UTF-8 JSON' };
  }
  if (!isRecord(doc)) return { ok: false, why: 'the forecast is not a JSON object' };
  const top = Object.keys(doc);
  if (top.length !== 1 || top[0] !== 'cases') return { ok: false, why: `the forecast's keys are ${JSON.stringify(top)}, not exactly ["cases"]` };
  if (!Array.isArray(doc.cases)) return { ok: false, why: 'cases is not an array' };
  const wanted = new Set(caseIds);
  const params = new Map<string, TwitchCcuParams>();
  const n = TWITCH_CCU_HOURS.length;
  for (const [k, row] of doc.cases.entries()) {
    if (!isRecord(row)) return { ok: false, why: `cases[${k}] is not an object` };
    const keys = Object.keys(row).sort();
    if (keys.join(',') !== 'id,ratios,spreads') return { ok: false, why: `cases[${k}]'s keys are ${JSON.stringify(Object.keys(row))}, not exactly id, ratios and spreads` };
    const { id, ratios, spreads } = row;
    if (typeof id !== 'string' || !wanted.has(id)) return { ok: false, why: `cases[${k}] names ${JSON.stringify(id)}, no case asked` };
    if (params.has(id)) return { ok: false, why: `cases[${k}] names case ${id} a second time` };
    const inBounds = (xs: unknown, lo: number, hi: number): xs is number[] => Array.isArray(xs) && xs.length === n && xs.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi);
    if (!inBounds(ratios, TWITCH_CCU_RATIO_MIN, TWITCH_CCU_RATIO_MAX)) return { ok: false, why: `case ${id}'s ratios are not ${n} numbers from ${TWITCH_CCU_RATIO_MIN} to ${TWITCH_CCU_RATIO_MAX}` };
    if (!inBounds(spreads, 0, TWITCH_CCU_SPREAD_MAX)) return { ok: false, why: `case ${id}'s spreads are not ${n} numbers from 0 to ${TWITCH_CCU_SPREAD_MAX}` };
    params.set(id, { ratios: [...ratios], spreads: [...spreads] });
  }
  const missing = caseIds.filter((id) => !params.has(id));
  if (missing.length > 0) return { ok: false, why: `no row for case(s) ${missing.join(', ')}` };
  return { ok: true, params };
}

/** The output contract the prompt states: what the document is, how the entry applies it, then the schema. */
export function twitchCcuForecastContract(schema: Readonly<Record<string, unknown>>): string {
  return [
    "Answer one row per case, {id, ratios, spreads}, once: the house's entry calls no model. For every case it is graded on, it takes the case's hour-1 print p (Twitch's mean concurrent viewers over the day's first UTC hour, at least 1) and writes, for each hour h = 2 to 24, the quantiles at the levels 0.05, 0.25, 0.5, 0.75 and 0.95:",
    '',
    `    q = p x ratios[h - 2] x exp(z x spreads[h - 2]), rounded to 2 decimals, z = ${TWITCH_CCU_Z.join(', ')}`,
    '',
    `ratios[h - 2] is the median of hour h's count as a multiple of hour 1's (${TWITCH_CCU_RATIO_MIN} to ${TWITCH_CCU_RATIO_MAX}); spreads[h - 2] its standard deviation in natural-log units (0 to ${TWITCH_CCU_SPREAD_MAX}). ` +
      `With every ratio 1 and spreads ${TWITCH_CCU_BASELINE_SIGMA} x sqrt(h - 1) the entry is the persistence baseline, which every prize must beat. ` +
      "Each case is scored as the rules say: the pinball loss on the log scale of each quantile against the hour's recorded print. A case whose hour-1 print is not in its history yet (the final's, cut before the day began) still takes ratios to that print. Every case asked appears exactly once.",
    '',
    'The forecast document, as a JSON schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

const cell = (s: string): string => s.replace(/[\t\n\r]+/g, ' ');

/**
 * The cases as the prompt gives them: for each case its id, day and checkpoint, its hour-1 print (or that it has none
 * yet), its own history_hourly's last `hours` hours and its top streams; then, once, the comparables every case
 * shares, each its release day's 24 hourly counts and the 24 before (the first case's comparables: the practice
 * cases share theirs, the final has one case).
 */
export function compactTwitchCcuHistory(cases: readonly TwitchCcuCase[], hours: number = HOUSE_FORECAST_TWITCH_CCU_HOURS): string {
  if (!Number.isSafeInteger(hours) || hours < 1) throw new RangeError(`hours is a whole number from 1, got ${hours}`);
  const lines: string[] = [
    "Twitch's concurrent live viewers in a game's category, hour by hour (an hour's count is the mean of the minute reads in it). " +
      `For each case: its id, its day (UTC), its checkpoint (the end of hour 1), hour 1's count p when it is known, its last ${hours} hourly counts before the checkpoint (from<TAB>viewers<TAB>channels), and its top live streams at the checkpoint. ` +
      'Then the comparables: past big launches, each its release day and the day before as hourly counts.',
  ];
  for (const c of cases) {
    const p1 = c.known.find((k) => k.hour === 1);
    lines.push('', `case ${cell(c.id)}\tgame ${cell(c.game.name)}\tday ${c.day_start}\tcheckpoint ${c.checkpoint}\thour-1 count ${p1 === undefined ? 'not known yet (the forecast is made before the day began)' : String(p1.viewers)}`);
    for (const h of c.history_hourly.slice(-hours)) lines.push(`${h.from}\t${h.viewers}\t${h.channels ?? '-'}`);
    if (c.streams !== null && c.streams.length > 0) lines.push(`streams\t${c.streams.slice(0, 10).map((s) => `${cell(s.login)}:${s.viewers}:${s.language ?? '-'}`).join(' ')}`);
  }
  const shared = cases[0]?.comparables ?? [];
  if (shared.length > 0) lines.push('', `${shared.length} comparables:`);
  for (const m of shared) {
    const day = Date.parse(m.day_start);
    const window = m.hourly.filter((h) => {
      const t = Date.parse(h.from);
      return t >= day - 24 * HOUR_MS && t < day + 24 * HOUR_MS;
    });
    lines.push(`launch ${cell(m.name)}\tday ${m.day_start}\tunlock ${cell(m.unlock)}\tplatforms ${cell(m.platforms)}`, `hourly\t${window.map((h) => `${h.from.slice(5, 13)}=${h.viewers}`).join(' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** x rounded to 2 decimals (half up): the starter's round2. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The rows of one case: hour h's five quantiles from p and the case's parameters (the baseline's when null). */
export function twitchCcuRows(p1: number, params: Readonly<TwitchCcuParams>): Array<{ hour: number; q: number[] }> {
  const p = Math.max(1, p1);
  return TWITCH_CCU_HOURS.map((hour, i) => ({ hour, q: TWITCH_CCU_Z.map((z) => round2(p * params.ratios[i]! * Math.exp(z * params.spreads[i]!))) }));
}

/**
 * The <id>.out the house's entry writes for case `c` (grader/house-forecast-entry-twitch-ccu/main.ts computes the same
 * bytes): {hours} compact JSON and a newline, from the case's hour-1 print and `params`' row for its id (the baseline's
 * numbers when params is null or lacks the id). A case with no hour-1 print has no output (throws).
 */
export function twitchCcuCaseOutputBytes(c: TwitchCcuCase, params: ReadonlyMap<string, TwitchCcuParams> | null): Uint8Array {
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new TypeError(`case ${c.id} has no hour-1 print`);
  const hours = twitchCcuRows(first.viewers, params?.get(c.id) ?? TWITCH_CCU_BASELINE_PARAMS);
  return new TextEncoder().encode(`${JSON.stringify({ hours })}\n`);
}
