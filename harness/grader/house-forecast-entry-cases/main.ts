// make.fun's house model entry in a per-file forecast contest (Node 22, standard library only), a Polymarket price
// forecast's (polymarket-nvidia-ceo-forecast-01). It calls no model and reads no network: the house asked its model
// ONCE, before the deadline, for each market's {sigma, drift} on the history to a cut (grader/house-forecast.ts
// callHouseForecast, writeHouseEntry), and this entry applies that one answer to every case it is run on.
//
//   forecasts/<sha256>.json   the forecast the house's model answered: {"forecasts":[{"id","sigma","drift"}]}, sigma in
//                             price units per square-root minute, drift in price units per hour. The tree holds exactly
//                             one; <sha256> is its instance descriptor's (grader/house-forecast.ts polymarketInstanceBytes)
//   records/<sha256>.json     that call's record (agent-fun/house-forecast-record/v1): the model, its flags, the
//                             prompt's and the answer's sha256, its per_case history cut, every attempt, what it cost
//
// For every <id>.in in the input directory (the grader runs one case at a time, with only that case's file there), it
// writes <id>.out: for each market of the case, in its order, horizon_minutes rows (row h-1 the minute at+h) of the
// quantiles at the levels 0.05, 0.25, 0.5, 0.75 and 0.95,
//
//   q = clamp(x + drift * h / 60 + z * sigma * sqrt(h), 0, 1), rounded to 6 decimals, z = -1.644854 .. 1.644854,
//
// x the market's last price in the case (its price at `at`). A market the forecast lacks gets the persistence baseline's
// sigma 0.0025 and drift 0, and so does every market of a case whose `at` is before the record's history cut: the
// forecast is never applied to a checkpoint earlier than the history it was made on. With the baseline's numbers its
// rows are the baseline's, digit for digit. A regrade runs this file again and gets the same bytes.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const HERE = fileURLToPath(new URL('./', import.meta.url));

/** The quantile levels every case asks for, in a row's order. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals: the persistence baseline's. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** The persistence baseline's parameters: a market the forecast lacks, or a case before the cut, gets them. */
const BASELINE: Params = { sigma: 0.0025, drift: 0 };
const SIGMA_MAX = 0.05;
const DRIFT_MAX = 0.2;
const MAX_HORIZON = 1440;
const INSTANCE_FILE = /^([0-9a-f]{64})\.json$/;

interface Params {
  sigma: number;
  drift: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function fail(message: string): never {
  process.stderr.write(`house forecast: ${message}\n`);
  process.exit(1);
}

/** The one forecast the tree ships, its record's competition and history cut (ms). */
function shipped(): { competition: string; cut: number; params: Map<string, Params> } {
  const files = readdirSync(join(HERE, 'forecasts')).filter((f) => INSTANCE_FILE.test(f));
  if (files.length !== 1) fail(`the entry holds ${files.length} forecasts, not exactly one`);
  const sha = (INSTANCE_FILE.exec(files[0] as string) as RegExpExecArray)[1] as string;
  const bytes = readFileSync(join(HERE, 'forecasts', `${sha}.json`));
  const record: unknown = JSON.parse(readFileSync(join(HERE, 'records', `${sha}.json`), 'utf8'));
  if (!isObject(record) || record.task_sha256 !== sha || typeof record.competition !== 'string') fail(`records/${sha}.json is not the record of instance ${sha}`);
  const kept = record.forecast;
  if (!isObject(kept) || kept.valid !== true || kept.sha256 !== sha256(bytes)) fail(`records/${sha}.json names no valid forecast with the bytes of forecasts/${sha}.json`);
  const perCase = record.per_case;
  const cut = isObject(perCase) && typeof perCase.history_until === 'string' ? Date.parse(perCase.history_until) : Number.NaN;
  if (!Number.isFinite(cut)) fail(`records/${sha}.json names no per_case history cut`);
  const doc: unknown = JSON.parse(bytes.toString('utf8'));
  const params = new Map<string, Params>();
  for (const row of isObject(doc) && Array.isArray(doc.forecasts) ? doc.forecasts : []) {
    if (!isObject(row) || typeof row.id !== 'string' || params.has(row.id)) continue;
    const { sigma, drift } = row;
    if (typeof sigma !== 'number' || !Number.isFinite(sigma) || sigma < 0 || sigma > SIGMA_MAX) continue;
    if (typeof drift !== 'number' || !Number.isFinite(drift) || drift < -DRIFT_MAX || drift > DRIFT_MAX) continue;
    params.set(row.id, { sigma, drift });
  }
  return { competition: record.competition as string, cut, params };
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0): the persistence baseline's rounding. */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** One market's rows from its last price `x`. */
function rows(x: number, p: Params, horizon: number): number[][] {
  const out: number[][] = [];
  for (let h = 1; h <= horizon; h++) out.push(Z.map((z) => price6(x + (p.drift * h) / 60 + z * p.sigma * Math.sqrt(h))));
  return out;
}

/** Case `file`'s output bytes, or why it has none. */
function caseOutput(file: string, house: ReturnType<typeof shipped>): string {
  const c: unknown = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
  if (!isObject(c)) throw new Error('it is not a JSON object');
  if (c.competition !== house.competition) throw new Error(`it is competition ${JSON.stringify(c.competition)}'s, and this entry's forecast is ${house.competition}'s`);
  const levels = c.quantiles;
  if (!Array.isArray(levels) || levels.length !== QUANTILES.length || levels.some((t, j) => t !== QUANTILES[j])) throw new Error(`it asks for quantiles ${JSON.stringify(levels)}, not ${JSON.stringify(QUANTILES)}`);
  const horizon = c.horizon_minutes;
  if (typeof horizon !== 'number' || !Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON) throw new Error(`its horizon_minutes ${JSON.stringify(horizon)} is not a whole number from 1 to ${MAX_HORIZON}`);
  if (!Array.isArray(c.markets)) throw new Error('it holds no markets');
  const apply = typeof c.at === 'string' && Date.parse(c.at) >= house.cut;
  const forecasts = c.markets.map((m: unknown, k: number) => {
    if (!isObject(m) || typeof m.id !== 'string' || !Array.isArray(m.prices) || m.prices.length === 0) throw new Error(`markets[${k}] is not {id, prices}`);
    const x = m.prices[m.prices.length - 1];
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`market ${m.id}'s last price is not a number`);
    return { id: m.id, q: rows(x, (apply ? house.params.get(m.id) : undefined) ?? BASELINE, horizon) };
  });
  return `${JSON.stringify({ forecasts })}\n`;
}

const house = shipped();
mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
for (const file of readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort()) {
  let out: string;
  try {
    out = caseOutput(file, house);
  } catch (err) {
    process.stderr.write(`house forecast: ${file}: ${err instanceof Error ? err.message : String(err)}, so it gets no output\n`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(join(OUTPUT_DIR, `${file.slice(0, -'.in'.length)}.out`), out);
}
