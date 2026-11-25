// make.fun's house model entry in a forecast contest (Node 22, standard library only). It calls no model and
// reads no network: the house asked its model ONCE per instance, before the instance closed, and this entry
// replays that answer (grader/house-forecast.ts callHouseForecast, writeHouseEntry).
//
//   forecasts/<sha256>.json   the forecast the house's model answered for the instance whose /input/task.json
//                             hashes to <sha256> (lowercase hex of its exact bytes)
//   records/<sha256>.json     that call's record (agent-fun/house-forecast-record/v1): the model, its flags, the
//                             prompt's and the answer's sha256, every attempt, what it cost
//
// It hashes /input/task.json and copies forecasts/<that sha256>.json, byte for byte, to /output under the name
// task.json's `output` gives. An instance the house holds no forecast for gets nothing: no file, exit 0, and so
// no valid score and no part in the prize gate. A regrade runs this file again and gets the same bytes.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
/** A file name the output may take: no directory, no dot-only name. */
const OUTPUT_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

const task = readFileSync(join(INPUT_DIR, 'task.json'));
const sha256 = createHash('sha256').update(task).digest('hex');
const forecast = new URL(`./forecasts/${sha256}.json`, import.meta.url);

if (!existsSync(forecast)) {
  process.stderr.write(`house forecast: no forecast for task ${sha256}, so this instance gets none\n`);
} else {
  const output: unknown = (JSON.parse(task.toString('utf8')) as { output?: unknown }).output;
  if (typeof output !== 'string' || !OUTPUT_NAME.test(output)) {
    process.stderr.write(`house forecast: task ${sha256} names no output file name (output ${JSON.stringify(output)})\n`);
    process.exitCode = 1;
  } else {
    writeFileSync(join(OUTPUT_DIR, output), readFileSync(forecast));
  }
}
