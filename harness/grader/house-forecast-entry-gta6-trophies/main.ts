// make.fun's house model entry in a GTA VI trophy rarity forecast (gta6-trophy-rarity-forecast-01; Node 22, standard
// library only). It calls no model and reads no network: the house asked its model ONCE a phase, before the deadline,
// for each case and each of its trophies a median earn rate and a logit spread (grader/house-forecast.ts
// callHouseForecast, writeHouseEntry), and this entry applies that one answer to every case it is run on.
//
//   forecasts/<sha256>.json   the forecast the house's model answered:
//                             {"cases":[{"id","trophies":[{"id","median","spread"}]}]}. The tree holds exactly one;
//                             <sha256> is its instance descriptor's (grader/house-forecast.ts gta6TrophiesInstanceBytes)
//   records/<sha256>.json     that call's record (agent-fun/house-forecast-record/v1)
//
// For every <id>.in in the input directory (the grader runs one case at a time, with only that case's file there), it
// writes <id>.out: for each of the case's trophies, in the case's order, the quantiles at the levels 0.05, 0.25, 0.5,
// 0.75 and 0.95 of its earn rate at the case's target, in percent,
//
//   q = 100 / (1 + exp(-(logit(median) + z x spread))), rounded to 4 decimals, z = -1.645, -0.674, 0, 0.674, 1.645,
//
// logit(x) = ln(c / (100 - c)) of c = x clamped to [0.01, 99.99]. A case id the forecast lacks, and a trophy of a case
// the forecast lacks, get the persistence baseline's numbers (median the trophy's rate in the case's last read, 0 where
// that read lacked it; spread 0.5 x sqrt(the horizon in days)), the kit's starter's digit for digit. A regrade runs this
// file again and gets the same bytes (grader/house-forecast.ts gta6TrophiesCaseOutputBytes is the same arithmetic).
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

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const SIGMA = 0.5;
const SPREAD_MAX = 5;
const INSTANCE_FILE = /^([0-9a-f]{64})\.json$/;

interface Params {
  median: number;
  spread: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp(pct) / (100 - clamp(pct)));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

function fail(message: string): never {
  process.stderr.write(`house forecast: ${message}\n`);
  process.exit(1);
}

/** The one forecast the tree ships: each case id's trophies' parameters. */
function shipped(): Map<string, Map<number, Params>> {
  const files = readdirSync(join(HERE, 'forecasts')).filter((f) => INSTANCE_FILE.test(f));
  if (files.length !== 1) fail(`the entry holds ${files.length} forecasts, not exactly one`);
  const sha = (INSTANCE_FILE.exec(files[0] as string) as RegExpExecArray)[1] as string;
  const bytes = readFileSync(join(HERE, 'forecasts', `${sha}.json`));
  const record: unknown = JSON.parse(readFileSync(join(HERE, 'records', `${sha}.json`), 'utf8'));
  if (!isObject(record) || record.task_sha256 !== sha) fail(`records/${sha}.json is not the record of instance ${sha}`);
  const kept = record.forecast;
  if (!isObject(kept) || kept.valid !== true || kept.sha256 !== sha256(bytes)) fail(`records/${sha}.json names no valid forecast with the bytes of forecasts/${sha}.json`);
  const doc: unknown = JSON.parse(bytes.toString('utf8'));
  const params = new Map<string, Map<number, Params>>();
  for (const row of isObject(doc) && Array.isArray(doc.cases) ? doc.cases : []) {
    if (!isObject(row) || typeof row.id !== 'string' || params.has(row.id) || !Array.isArray(row.trophies)) continue;
    const own = new Map<number, Params>();
    for (const t of row.trophies) {
      if (!isObject(t) || typeof t.id !== 'number' || own.has(t.id)) continue;
      if (!isRate(t.median) || typeof t.spread !== 'number' || !Number.isFinite(t.spread) || t.spread < 0 || t.spread > SPREAD_MAX) continue;
      own.set(t.id, { median: t.median, spread: t.spread });
    }
    params.set(row.id, own);
  }
  return params;
}

/** Case `file`'s output bytes. */
function caseOutput(file: string, params: Map<string, Map<number, Params>>): string {
  const c: unknown = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
  if (!isObject(c) || typeof c.id !== 'string') throw new Error('it is not a case object with an id');
  const levels = c.levels;
  if (!Array.isArray(levels) || levels.length !== LEVELS.length || levels.some((t, j) => t !== LEVELS[j])) throw new Error(`it asks for levels ${JSON.stringify(levels)}, not ${JSON.stringify(LEVELS)}`);
  if (!Array.isArray(c.trophies) || c.trophies.length === 0) throw new Error('it lists no trophies');
  const horizon = c.horizon_minutes;
  if (typeof horizon !== 'number' || !Number.isFinite(horizon) || horizon < 0) throw new Error('it has no horizon_minutes');
  const history = Array.isArray(c.history) ? c.history : [];
  const last: unknown = history[history.length - 1];
  const own = params.get(c.id);
  const trophies = c.trophies.map((t: unknown, i: number) => {
    if (!isObject(t) || typeof t.id !== 'number') throw new Error(`its trophy ${i} has no id`);
    let p = own?.get(t.id);
    if (p === undefined) {
      if (!isObject(last) || !Array.isArray(last.rates)) throw new Error(`it has no history, so trophy ${t.id} has no last rate`);
      const r: unknown = last.rates[i];
      p = { median: typeof r === 'number' ? r : 0, spread: SIGMA * Math.sqrt(horizon / 1440) };
    }
    const l = logit(p.median);
    const spread = p.spread;
    return { id: t.id, q: Z.map((z) => round4(100 / (1 + Math.exp(-(l + z * spread))))) };
  });
  return `${JSON.stringify({ trophies })}\n`;
}

const params = shipped();
mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
for (const file of readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort()) {
  let out: string;
  try {
    out = caseOutput(file, params);
  } catch (err) {
    process.stderr.write(`house forecast: ${file}: ${err instanceof Error ? err.message : String(err)}, so it gets no output\n`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(join(OUTPUT_DIR, `${file.slice(0, -'.in'.length)}.out`), out);
}
