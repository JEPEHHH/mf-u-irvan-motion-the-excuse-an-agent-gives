// make.fun's house model entry in a Twitch viewers forecast (gta6-twitch-ccu-forecast-01; Node 22, standard library
// only). It calls no model and reads no network: the house asked its model ONCE a phase, before the deadline, for each
// case id's 23 median ratios and 23 log spreads (grader/house-forecast.ts callHouseForecast, writeHouseEntry), and this
// entry applies that one answer to every case it is run on.
//
//   forecasts/<sha256>.json   the forecast the house's model answered: {"cases":[{"id","ratios","spreads"}]}, 23 of each,
//                             for hours 2 to 24. The tree holds exactly one; <sha256> is its instance descriptor's
//                             (grader/house-forecast-twitch-ccu.ts twitchCcuInstanceBytes)
//   records/<sha256>.json     that call's record (agent-fun/house-forecast-record/v1)
//
// For every <id>.in in the input directory (the grader runs one case at a time, with only that case's file there), it
// writes <id>.out: for each hour h = 2 to 24 the quantiles at the levels 0.05, 0.25, 0.5, 0.75 and 0.95,
//
//   q = p x ratios[h - 2] x exp(z x spreads[h - 2]), rounded to 2 decimals, z = -1.645, -0.674, 0, 0.674, 1.645,
//
// p the case's hour-1 print (1 if it is below 1). A case id the forecast lacks gets the persistence baseline's numbers
// (every ratio 1, spreads 0.15 x sqrt(h - 1)), the kit's starter's digit for digit. A regrade runs this file again and
// gets the same bytes (grader/house-forecast-twitch-ccu.ts twitchCcuCaseOutputBytes is the same arithmetic).
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
const HOURS = Array.from({ length: 23 }, (_, i) => i + 2);
const SIGMA = 0.15;
const RATIO_MIN = 0.01;
const RATIO_MAX = 100;
const SPREAD_MAX = 3;
const INSTANCE_FILE = /^([0-9a-f]{64})\.json$/;

interface Params {
  ratios: number[];
  spreads: number[];
}
const BASELINE: Params = { ratios: HOURS.map(() => 1), spreads: HOURS.map((h) => SIGMA * Math.sqrt(h - 1)) };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const round2 = (x: number): number => Math.round(x * 100) / 100;

function fail(message: string): never {
  process.stderr.write(`house forecast: ${message}\n`);
  process.exit(1);
}

/** The one forecast the tree ships: each case id's parameters. */
function shipped(): Map<string, Params> {
  const files = readdirSync(join(HERE, 'forecasts')).filter((f) => INSTANCE_FILE.test(f));
  if (files.length !== 1) fail(`the entry holds ${files.length} forecasts, not exactly one`);
  const sha = (INSTANCE_FILE.exec(files[0] as string) as RegExpExecArray)[1] as string;
  const bytes = readFileSync(join(HERE, 'forecasts', `${sha}.json`));
  const record: unknown = JSON.parse(readFileSync(join(HERE, 'records', `${sha}.json`), 'utf8'));
  if (!isObject(record) || record.task_sha256 !== sha) fail(`records/${sha}.json is not the record of instance ${sha}`);
  const kept = record.forecast;
  if (!isObject(kept) || kept.valid !== true || kept.sha256 !== sha256(bytes)) fail(`records/${sha}.json names no valid forecast with the bytes of forecasts/${sha}.json`);
  const doc: unknown = JSON.parse(bytes.toString('utf8'));
  const params = new Map<string, Params>();
  const ok = (xs: unknown, lo: number, hi: number): xs is number[] => Array.isArray(xs) && xs.length === HOURS.length && xs.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi);
  for (const row of isObject(doc) && Array.isArray(doc.cases) ? doc.cases : []) {
    if (!isObject(row) || typeof row.id !== 'string' || params.has(row.id)) continue;
    if (!ok(row.ratios, RATIO_MIN, RATIO_MAX) || !ok(row.spreads, 0, SPREAD_MAX)) continue;
    params.set(row.id, { ratios: row.ratios, spreads: row.spreads });
  }
  return params;
}

/** Case `file`'s output bytes. */
function caseOutput(file: string, params: Map<string, Params>): string {
  const c: unknown = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
  if (!isObject(c) || typeof c.id !== 'string') throw new Error('it is not a case object with an id');
  const levels = c.levels;
  if (!Array.isArray(levels) || levels.length !== LEVELS.length || levels.some((t, j) => t !== LEVELS[j])) throw new Error(`it asks for levels ${JSON.stringify(levels)}, not ${JSON.stringify(LEVELS)}`);
  const first = Array.isArray(c.known) ? c.known.find((k: unknown) => isObject(k) && k.hour === 1) : undefined;
  if (!isObject(first) || typeof first.viewers !== 'number' || !Number.isFinite(first.viewers)) throw new Error('it has no hour-1 print');
  const p = Math.max(1, first.viewers);
  const own = params.get(c.id) ?? BASELINE;
  const hours = HOURS.map((hour, i) => ({ hour, q: Z.map((z) => round2(p * own.ratios[i]! * Math.exp(z * own.spreads[i]!))) }));
  return `${JSON.stringify({ hours })}\n`;
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
