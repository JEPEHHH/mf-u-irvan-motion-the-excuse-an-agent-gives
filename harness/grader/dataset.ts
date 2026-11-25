// A phase's frozen dataset, read for grading from the collector's directory format and verified
// before anything uses it. Five formats (DatasetFormat), told apart by the manifest's `schema`
// (datasetFormatOf):
//
//   agent-fun/dataset/v1        chain: a pumpfun-replay/v2 chain log (collector/freeze.ts,
//                               collector/manifest.ts): readFrozenDataset, below
//   agent-fun/bars-dataset/*   bars: a bars-replay/v1 OHLC window (contracts/bars-dataset.ts
//                               BARS_DATASET_SCHEMA, collector/bars/freeze.ts): readFrozenBarsDataset,
//                               further below; a window of another version than BARS_DATASET_SCHEMA's
//                               is a bars window the contract refuses, never read as a chain log
//   agent-fun/clmm-dataset/*   clmm: a clmm-replay/v1 pool window (contracts/clmm-dataset.ts
//                               CLMM_DATASET_SCHEMA, collector/bars/clmm-freeze.ts):
//                               readFrozenClmmDataset; another version than CLMM_DATASET_SCHEMA's
//                               is a clmm window the contract refuses, never read as anything else
//   agent-fun/bars-history/*   bars-history: a seeding-only history window of GeckoTerminal pool OHLCV
//                               (contracts/bars-history.ts BARS_HISTORY_SCHEMA, collector/bars/history.ts):
//                               readFrozenBarsHistory, last. No phase grades on it: no harness's
//                               format is it (server/admin/dataset-register.ts
//                               HARNESS_DATASET_FORMAT), so it never attaches to a phase and no kit
//                               serves it; only the seeding gate's dev run reads it
//                               (server/seeding/templates/bars-beat-strategy/dev-run.ts)
//   agent-fun/program-dataset/* program: a program/v1 final phase's data recorded after the deadline
//                               (contracts/program-dataset.ts, collector/roblox/freeze.ts), its input/ and
//                               reference/ trees and the listing of their files: grader/program-dataset.ts
//                               verifyProgramDataset checks it and readFrozenProgramDataset reads it for
//                               grader/worker.ts programPhaseSetup, which mounts the two trees as it mounts a
//                               bundle's own (a final_dataset harness's final phase alone:
//                               server/admin/dataset-register.ts HARNESS_DATASET_FORMAT)
//
// The chain log:
//
//   <dir>/manifest.json                 DatasetManifest, status `accepted`; the RFC 8785 canonical
//                                       sha256 of the manifest as written must equal the dataset
//                                       row's sha256 (the digest runs and the contamination
//                                       certificate name: sim/engine.ts ReplayDataset.sha256)
//   <dir>/events/part-NNNNN.ndjson.gz   every chunk the manifest lists, in its order: size and
//                                       sha256 of the stored gzip, then ndjson_sha256 and the event
//                                       count of the decompressed NDJSON; all of it concatenated
//                                       must hash to manifest.dataset_sha256
//
// The result is the `{ dataset, sample }` grader/worker.ts loadDataset returns: the records in file
// order (the collector sorted them by (slot, mint, chain_seq)), excluded_mints and end_slot from the
// manifest, and the manifest's universe sample rule. Lines are JSON-parsed only: their bytes are the
// ones the manifest hashes, which registerDataset() checked end to end with the collector's own
// verifyDataset (schema, canonical form, order, chains, counts, verdict), and the replay's chain
// check re-validates every universe record anyway.
//
// Any mismatch is a DatasetIntegrityError: retrying cannot help until an operator acts, so the
// grade job dead-letters. A missing file or an I/O failure stays an ordinary error (the job retries:
// a volume may not be mounted yet).
//
// A bars window (readFrozenBarsDataset):
//
//   <dir>/manifest.json                 BarsDatasetManifest, status `accepted`; its RFC 8785 canonical
//                                       sha256 must equal the dataset row's, as a chain log's must,
//                                       and is the BarsDataset's sha256 (the digest the run, its action
//                                       log and its contamination certificate name), which commits to
//                                       the manifest's dataset_sha256 and every file digest in it
//   <dir>/bars/<SYMBOL>.ndjson.gz       every file the manifest lists, in its order: size and sha256 of
//                                       the stored gzip, then ndjson_sha256 and the bar count of the
//                                       decompressed NDJSON; all of it concatenated must hash to
//                                       manifest.dataset_sha256
//
// The result is a BarsDataset (sim/bars/engine.ts): the window, the interval and every symbol's mint,
// scales and bars in file order, each line as the file holds it (the replay reads its prices and
// pool depths and ignores its provenance). Lines are JSON-parsed only, as a chain log's are: registerDataset
// checked them end to end with collector/bars/verify.ts verifyBarsDataset (schema, canonical form,
// every bar re-derived from the pool-state samples beside them, gaps, verdict), and the replay checks
// every bar it reads again. The samples are evidence, not input: they are not read here.
//
// A clmm window (readFrozenClmmDataset):
//
//   <dir>/manifest.json                 ClmmDatasetManifest, status `accepted`; its RFC 8785 canonical
//                                       sha256 must equal the dataset row's, as the other formats',
//                                       and is the ClmmDataset's sha256 (the digest the run, its action
//                                       log and its contamination certificate name). It commits to the
//                                       manifest's pool, window and dataset_sha256 and every file
//                                       digest in it
//   <dir>/bars/<ASSET>.ndjson.gz        the hourly bars, then every rows/<YYYY-MM-DD>.ndjson.gz in the
//   <dir>/rows/<day>.ndjson.gz          manifest's rows[] order (clmmDatasetFiles): size and sha256 of
//                                       each stored gzip, then its ndjson_sha256 and line count; the
//                                       bars then the rows, decompressed and concatenated, must hash
//                                       to manifest.dataset_sha256
//   <dir>/pools.json                    not read here: the manifest's pool block is what the replay
//                                       reads. collector/bars/verify.ts verifyClmmDataset needs it
//                                       (registerDataset), so every copy of the dataset keeps it
//
// The result is a ClmmDataset (sim/clmm/engine.ts): the manifest's pool and window, the bars and
// every row in file order, each line as the file holds it. Unlike a bars window's samples, the rows
// are replay input (the fees are credited from them), so they are read, and dataset_sha256 commits to
// them. Lines are JSON-parsed only: registerDataset checked them end to end with verifyClmmDataset
// (schema, canonical form, every bar re-derived from the rows, fee growth only moving forward, gaps,
// verdict), and the engine re-checks every bar against its hour's rows before a batch is sent.
//
// A history window (readFrozenBarsHistory):
//
//   <dir>/manifest.json                 BarsHistoryManifest, status `accepted`; its RFC 8785 canonical
//                                       sha256 must equal the dataset row's, as the other formats', and
//                                       is the BarsDataset's sha256 (the digest a dev run's phase seed
//                                       and action log name)
//   <dir>/bars/<SYMBOL>.ndjson.gz       every file the manifest lists, checked as a bars window's are;
//                                       all of it concatenated must hash to manifest.dataset_sha256
//
// The result is the same BarsDataset a bars window gives (sim/bars/engine.ts): its lines carry t, o,
// h, l, c, v and the depths, which is all the replay reads. Lines are JSON-parsed only:
// registerDataset checked them end to end with collector/bars/verify.ts verifyBarsHistory (every line
// re-derived from the raw GeckoTerminal responses and pools.json beside them, gaps, verdict). The raw
// responses are evidence, not input: they are not read here.
//
// registerDataset() is how a frozen directory becomes a dataset row, dispatching on the manifest's
// schema: a chain log's verifyDataset must pass, then the row records the path, the manifest, its
// digest, chain_report and excluded_mints; a bars window's verifyBarsDataset, a clmm window's
// verifyClmmDataset or a history window's verifyBarsHistory must pass, then the row records the same
// with chain_report null and excluded_mints empty (a window of prices has no chain and excludes no
// mint: the dataset table needs nothing more). A manifest.json that is not JSON is refused before any
// verifier runs, as an integrity error. The verify and those facts are datasetRegistrationFacts, a pure
// function of the directory an off-thread task runs (server/routes/admin/sealed-window.ts, the draw's
// windows); registerVerifiedDataset then writes the same row from its answer on the caller's thread.
//
// An integrity error's message is this module's own words: an admin route answers with it
// (server/admin/dataset-register.ts, 422) and the grade job dead-letters with it, so the platform's
// error (JSON.parse's, which quotes the file; zlib's) is kept only as its cause.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { verifyBarsDataset, verifyBarsHistory, verifyClmmDataset } from '../collector/bars/verify.ts';
import { readManifest, verifyDataset } from '../collector/freeze.ts';
import { DatasetManifest, MANIFEST_FILE, type DatasetManifestT } from '../collector/manifest.ts';
import { BARS_DATASET_SCHEMA, BarsDatasetManifest, type BarsDatasetManifestT } from '../contracts/bars-dataset.ts';
import { BARS_HISTORY_SCHEMA, BarsHistoryManifest, type BarsHistoryManifestT } from '../contracts/bars-history.ts';
import { CLMM_DATASET_SCHEMA, ClmmDatasetManifest, type ClmmDatasetLineT, type ClmmDatasetManifestT, type ClmmRowT } from '../contracts/clmm-dataset.ts';
import { isProgramDatasetManifest } from '../contracts/program-dataset.ts';
import type { ChainEventT } from '../contracts/events.ts';
import { Slug } from '../contracts/primitives.ts';
import type { Db } from '../server/db/client.ts';
import { dataset } from '../server/db/schema.ts';
import { canonicalSha256, CanonicalJsonError, sha256Hex } from '../sim/canonical.ts';
import type { BarsDataset, BarsDatasetBarInput, BarsSeries } from '../sim/bars/engine.ts';
import type { ClmmDataset } from '../sim/clmm/engine.ts';
import type { ReplayDataset } from '../sim/engine.ts';
import type { UniverseSampleT } from '../sim/universe.ts';
import { ProgramDatasetError, readVerifiedProgramManifest, verifyProgramDataset } from './program-dataset.ts';
import { PROJECT_ROOT } from './version.ts';

const gunzipAsync = promisify(gunzip);

/** A frozen dataset that does not match its manifest or its dataset row. */
export class DatasetIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatasetIntegrityError';
  }
}

export interface LoadedDataset {
  dataset: ReplayDataset;
  /** The manifest's universe sample rule. */
  sample: UniverseSampleT;
  manifest: DatasetManifestT;
}

/** A frozen bars window, loaded (readFrozenBarsDataset). */
export interface LoadedBarsDataset {
  dataset: BarsDataset;
  manifest: BarsDatasetManifestT;
}

/** A frozen clmm window, loaded (readFrozenClmmDataset). */
export interface LoadedClmmDataset {
  dataset: ClmmDataset;
  manifest: ClmmDatasetManifestT;
}

/** A history window, loaded (readFrozenBarsHistory): the BarsDataset the replay reads, and its manifest. */
export interface LoadedBarsHistory {
  dataset: BarsDataset;
  manifest: BarsHistoryManifestT;
}

type DatasetRow = typeof dataset.$inferSelect;

/**
 * manifest.json as written (JSON); a SyntaxError is an integrity error, an I/O failure stays itself. The integrity
 * error says so in this module's words, JSON.parse's error kept as its cause: that one's message quotes the file, and
 * this one's is what POST /api/admin/datasets/register answers (server/admin/dataset-register.ts, 422) and the grade
 * job dead-letters with.
 */
function readRawManifest(dir: string): unknown {
  try {
    return readManifest(dir);
  } catch (err) {
    if (err instanceof SyntaxError) throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} is not JSON`, { cause: err });
    throw err;
  }
}

/** The RFC 8785 canonical sha256 of a manifest as written. */
function manifestSha256(dir: string, raw: unknown): string {
  try {
    return canonicalSha256(raw);
  } catch (err) {
    if (err instanceof CanonicalJsonError) throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} has no canonical form (${err.message})`, { cause: err });
    throw err;
  }
}

/** The schema family of every bars manifest version (BARS_DATASET_SCHEMA is the one in force). */
const BARS_SCHEMA_FAMILY = BARS_DATASET_SCHEMA.slice(0, BARS_DATASET_SCHEMA.lastIndexOf('/') + 1);
/** The schema family of every clmm manifest version (CLMM_DATASET_SCHEMA is the one in force). */
const CLMM_SCHEMA_FAMILY = CLMM_DATASET_SCHEMA.slice(0, CLMM_DATASET_SCHEMA.lastIndexOf('/') + 1);
/** The schema family of every history manifest version (BARS_HISTORY_SCHEMA is the one in force). */
const BARS_HISTORY_SCHEMA_FAMILY = BARS_HISTORY_SCHEMA.slice(0, BARS_HISTORY_SCHEMA.lastIndexOf('/') + 1);

const schemaOf = (raw: unknown): string | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const schema = (raw as { schema?: unknown }).schema;
  return typeof schema === 'string' ? schema : null;
};

/** Whether a manifest as written names the bars format, any version (its schema, before any validation). */
export function isBarsManifest(raw: unknown): boolean {
  return schemaOf(raw)?.startsWith(BARS_SCHEMA_FAMILY) ?? false;
}

/** Whether a manifest as written names the clmm format, any version (its schema, before any validation). */
export function isClmmManifest(raw: unknown): boolean {
  return schemaOf(raw)?.startsWith(CLMM_SCHEMA_FAMILY) ?? false;
}

/** Whether a manifest as written names the history format, any version (its schema, before any validation). */
export function isBarsHistoryManifest(raw: unknown): boolean {
  return schemaOf(raw)?.startsWith(BARS_HISTORY_SCHEMA_FAMILY) ?? false;
}

/** The frozen dataset formats (see the header): a chain log, a bars window, a clmm window, a (seeding-only) history window, a program/v1 phase's trees. */
export const DATASET_FORMATS = ['chain', 'bars', 'clmm', 'bars-history', 'program'] as const;
export type DatasetFormat = (typeof DATASET_FORMATS)[number];

/**
 * The format a manifest as written names, by its schema before any validation: bars, clmm or
 * bars-history by their schema families, a chain log otherwise (whose reader then says what is wrong
 * with it).
 */
export function datasetFormatOf(raw: unknown): DatasetFormat {
  return isBarsManifest(raw) ? 'bars' : isClmmManifest(raw) ? 'clmm' : isBarsHistoryManifest(raw) ? 'bars-history' : isProgramDatasetManifest(raw) ? 'program' : 'chain';
}

/**
 * The format a directory's manifest.json names, read as it is; a chain log when it cannot be read (the chain log's
 * verifier then says why: missing). One that is not JSON is readRawManifest's integrity error here: the chain log's
 * verifier would throw JSON.parse's own error, its text and all.
 */
function formatOfDir(dir: string): DatasetFormat {
  let raw: unknown;
  try {
    raw = readRawManifest(dir);
  } catch (err) {
    if (err instanceof DatasetIntegrityError) throw err;
    return 'chain';
  }
  return datasetFormatOf(raw);
}

const issueWords = (e: { issues: readonly { path: PropertyKey[]; message: string }[] }) =>
  e.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');

/** manifest.json as written (JSON), its validated form and its canonical sha256. */
function readVerifiedManifest(dir: string): { raw: unknown; manifest: DatasetManifestT; sha256: string } {
  const raw = readRawManifest(dir);
  const format = datasetFormatOf(raw);
  if (format !== 'chain') {
    throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} is an ${String(schemaOf(raw))} ${format} window, not an agent-fun/dataset/v1 chain log: a pumpfun-replay/v2 phase grades on a chain log`);
  }
  const parsed = DatasetManifest.safeParse(raw);
  if (!parsed.success) throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} is not an agent-fun/dataset/v1 manifest of a finished collection (${issueWords(parsed.error)})`);
  return { raw, manifest: parsed.data, sha256: manifestSha256(dir, raw) };
}

/** A bars manifest as written, its validated form and its canonical sha256. */
function readVerifiedBarsManifest(dir: string): { raw: unknown; manifest: BarsDatasetManifestT; sha256: string } {
  const raw = readRawManifest(dir);
  if (!isBarsManifest(raw)) {
    throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} is not an ${BARS_DATASET_SCHEMA} bars window: a bars-replay/v1 phase grades on one (collector/bars freeze)`);
  }
  const parsed = BarsDatasetManifest.safeParse(raw);
  if (!parsed.success) throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} is not a valid ${BARS_DATASET_SCHEMA} manifest (${issueWords(parsed.error)})`);
  return { raw, manifest: parsed.data, sha256: manifestSha256(dir, raw) };
}

/** A clmm manifest as written, its validated form and its canonical sha256. */
function readVerifiedClmmManifest(dir: string): { raw: unknown; manifest: ClmmDatasetManifestT; sha256: string } {
  const raw = readRawManifest(dir);
  if (!isClmmManifest(raw)) {
    throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} is not an ${CLMM_DATASET_SCHEMA} clmm window: a clmm-replay/v1 phase grades on one (collector/bars freeze-clmm)`);
  }
  const parsed = ClmmDatasetManifest.safeParse(raw);
  if (!parsed.success) throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} is not a valid ${CLMM_DATASET_SCHEMA} manifest (${issueWords(parsed.error)})`);
  return { raw, manifest: parsed.data, sha256: manifestSha256(dir, raw) };
}

/** A history manifest as written, its validated form and its canonical sha256. */
function readVerifiedBarsHistoryManifest(dir: string): { raw: unknown; manifest: BarsHistoryManifestT; sha256: string } {
  const raw = readRawManifest(dir);
  if (!isBarsHistoryManifest(raw)) {
    throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} is not an ${BARS_HISTORY_SCHEMA} history window (collector/bars history)`);
  }
  const parsed = BarsHistoryManifest.safeParse(raw);
  if (!parsed.success) throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} is not a valid ${BARS_HISTORY_SCHEMA} manifest (${issueWords(parsed.error)})`);
  return { raw, manifest: parsed.data, sha256: manifestSha256(dir, raw) };
}

/**
 * One stored gzip file of a manifest, checked (size, sha256, then the decompressed NDJSON's sha256), and its decompressed
 * bytes. A file gunzip refuses is "not gzip" in this module's words, zlib's error kept as the cause, as readRawManifest
 * keeps JSON.parse's.
 */
async function readCheckedGzip(dir: string, f: { path: string; sha256: string; bytes: number; ndjson_sha256: string }): Promise<Buffer> {
  const gz = await readFile(join(dir, f.path));
  const got = sha256Hex(gz);
  if (got !== f.sha256) throw new DatasetIntegrityError(`${f.path}: sha256 ${got} does not match the manifest's ${f.sha256}`);
  if (gz.byteLength !== f.bytes) throw new DatasetIntegrityError(`${f.path}: ${gz.byteLength} bytes, the manifest says ${f.bytes}`);
  let ndjson: Buffer;
  try {
    ndjson = await gunzipAsync(gz);
  } catch (err) {
    throw new DatasetIntegrityError(`${f.path}: not gzip`, { cause: err });
  }
  if (sha256Hex(ndjson) !== f.ndjson_sha256) throw new DatasetIntegrityError(`${f.path}: the decompressed NDJSON does not match the manifest's ndjson_sha256`);
  return ndjson;
}

/** A decompressed NDJSON file's lines, each JSON-parsed; `count` is how many the manifest says it holds. */
function ndjsonLines(path: string, ndjson: Buffer, count: number, what: string): unknown[] {
  const text = ndjson.toString('utf8');
  if (text.length > 0 && !text.endsWith('\n')) throw new DatasetIntegrityError(`${path}: the last line is not newline-terminated`);
  const lines = text.length > 0 ? text.slice(0, -1).split('\n') : [];
  if (lines.length !== count) throw new DatasetIntegrityError(`${path}: ${lines.length} ${what}, the manifest says ${count}`);
  return lines.map((line, n) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (err) {
      throw new DatasetIntegrityError(`${path}:${n + 1}: not JSON`, { cause: err });
    }
  });
}

/**
 * Read a frozen dataset directory, verifying every hash its manifest names (and, given
 * `expectSha256`, the manifest's own digest first). Only accepted windows load.
 */
export async function readFrozenDataset(dir: string, opts: { expectSha256?: string } = {}): Promise<LoadedDataset> {
  const { manifest: m, sha256 } = readVerifiedManifest(dir);
  if (opts.expectSha256 !== undefined && sha256 !== opts.expectSha256) {
    throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} hashes to ${sha256}, not the recorded ${opts.expectSha256}`);
  }
  if (m.status !== 'accepted') throw new DatasetIntegrityError(`dataset ${m.id} is a ${m.status} window: only accepted windows are graded`);
  const all = createHash('sha256');
  const events: ChainEventT[] = [];
  for (const f of m.files) {
    const ndjson = await readCheckedGzip(dir, f);
    all.update(ndjson);
    for (const e of ndjsonLines(f.path, ndjson, f.events, 'events')) events.push(e as ChainEventT);
  }
  if (all.digest('hex') !== m.dataset_sha256) throw new DatasetIntegrityError(`dataset ${m.id}: the chunks do not hash to the manifest's dataset_sha256`);
  if (events.length !== m.counts.events) throw new DatasetIntegrityError(`dataset ${m.id}: ${events.length} events, the manifest counts ${m.counts.events}`);
  return {
    manifest: m,
    sample: m.universe.sample,
    dataset: { sha256, events, excluded_mints: m.excluded_mints.map((x) => x.mint), end_slot: m.window.end_slot },
  };
}

/**
 * Read a frozen bars window (see the header), verifying every hash its manifest names (and, given
 * `expectSha256`, the manifest's own canonical digest first). Only accepted windows load.
 */
export async function readFrozenBarsDataset(dir: string, opts: { expectSha256?: string } = {}): Promise<LoadedBarsDataset> {
  const { manifest: m, sha256 } = readVerifiedBarsManifest(dir);
  if (opts.expectSha256 !== undefined && sha256 !== opts.expectSha256) {
    throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} hashes to ${sha256}, not the recorded ${opts.expectSha256}`);
  }
  if (m.status !== 'accepted') throw new DatasetIntegrityError(`dataset ${m.id} is a ${m.status} window: only accepted windows are graded`);
  const all = createHash('sha256');
  const symbols: BarsSeries[] = [];
  for (const [i, f] of m.files.entries()) {
    const sym = m.symbols[i]!;
    const ndjson = await readCheckedGzip(dir, f);
    all.update(ndjson);
    const bars = ndjsonLines(f.path, ndjson, f.bars, 'bars') as BarsDatasetBarInput[];
    symbols.push({ symbol: sym.symbol, mint: sym.mint, price_scale: sym.price_scale, qty_scale: sym.qty_scale, bars });
  }
  if (all.digest('hex') !== m.dataset_sha256) throw new DatasetIntegrityError(`dataset ${m.id}: the bars files do not hash to the manifest's dataset_sha256`);
  return {
    manifest: m,
    dataset: { sha256, interval: m.source.interval, window: { start_ms: m.window.start_ms, end_ms: m.window.end_ms, bars: m.window.bars }, symbols },
  };
}

/**
 * Read a frozen clmm window (see the header), verifying every hash its manifest names (and, given
 * `expectSha256`, the manifest's own canonical digest first). Only accepted windows load.
 */
export async function readFrozenClmmDataset(dir: string, opts: { expectSha256?: string } = {}): Promise<LoadedClmmDataset> {
  const { manifest: m, sha256 } = readVerifiedClmmManifest(dir);
  if (opts.expectSha256 !== undefined && sha256 !== opts.expectSha256) {
    throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} hashes to ${sha256}, not the recorded ${opts.expectSha256}`);
  }
  if (m.status !== 'accepted') throw new DatasetIntegrityError(`dataset ${m.id} is a ${m.status} window: only accepted windows are graded`);
  // dataset_sha256's order (contracts/clmm-dataset.ts clmmDatasetFiles): the bars file, then every rows file in rows[] order.
  const all = createHash('sha256');
  const barsNdjson = await readCheckedGzip(dir, m.bars);
  all.update(barsNdjson);
  const bars = ndjsonLines(m.bars.path, barsNdjson, m.bars.bars, 'bars') as ClmmDatasetLineT[];
  const rows: ClmmRowT[] = [];
  for (const f of m.rows) {
    const ndjson = await readCheckedGzip(dir, f);
    all.update(ndjson);
    for (const r of ndjsonLines(f.path, ndjson, f.rows, 'rows')) rows.push(r as ClmmRowT);
  }
  if (all.digest('hex') !== m.dataset_sha256) throw new DatasetIntegrityError(`dataset ${m.id}: the bars and rows files do not hash to the manifest's dataset_sha256`);
  return {
    manifest: m,
    dataset: { sha256, pool: m.pool, window: { start_ms: m.window.start_ms, end_ms: m.window.end_ms, hours: m.window.hours }, bars, rows },
  };
}

/**
 * Read a history window (see the header), verifying every hash its manifest names (and, given
 * `expectSha256`, the manifest's own canonical digest first). Only accepted windows load.
 */
export async function readFrozenBarsHistory(dir: string, opts: { expectSha256?: string } = {}): Promise<LoadedBarsHistory> {
  const { manifest: m, sha256 } = readVerifiedBarsHistoryManifest(dir);
  if (opts.expectSha256 !== undefined && sha256 !== opts.expectSha256) {
    throw new DatasetIntegrityError(`${join(dir, MANIFEST_FILE)} hashes to ${sha256}, not the recorded ${opts.expectSha256}`);
  }
  if (m.status !== 'accepted') throw new DatasetIntegrityError(`history window ${m.id} is a ${m.status} window: only accepted windows are read`);
  const all = createHash('sha256');
  const symbols: BarsSeries[] = [];
  for (const [i, f] of m.files.entries()) {
    const sym = m.symbols[i]!;
    const ndjson = await readCheckedGzip(dir, f);
    all.update(ndjson);
    const bars = ndjsonLines(f.path, ndjson, f.bars, 'bars') as BarsDatasetBarInput[];
    symbols.push({ symbol: sym.symbol, mint: sym.mint, price_scale: sym.price_scale, qty_scale: sym.qty_scale, bars });
  }
  if (all.digest('hex') !== m.dataset_sha256) throw new DatasetIntegrityError(`history window ${m.id}: the bars files do not hash to the manifest's dataset_sha256`);
  return {
    manifest: m,
    dataset: { sha256, interval: m.source.interval, window: { start_ms: m.window.start_ms, end_ms: m.window.end_ms, bars: m.window.bars }, symbols },
  };
}

export interface DatasetLoaderOptions {
  /** A relative dataset path resolves against this (default the project root). */
  root?: string;
  /** Loaded datasets kept in memory, most recent first, by digest and directory (default 1; 0 keeps none). */
  cache?: number;
}

/**
 * grader/worker.ts's loadDataset: a dataset row's directory, read and verified against the row's
 * sha256. Concurrent loads of one dataset share one read; a failed read is not cached.
 */
export function createDatasetLoader(opts: DatasetLoaderOptions = {}): (row: Pick<DatasetRow, 'path' | 'sha256'>) => Promise<LoadedDataset> {
  return cachedLoader(readFrozenDataset, opts);
}

/** grader/worker.ts's loadBarsDataset: a bars dataset row's directory, read and verified against the row's sha256, cached as createDatasetLoader caches. */
export function createBarsDatasetLoader(opts: DatasetLoaderOptions = {}): (row: Pick<DatasetRow, 'path' | 'sha256'>) => Promise<LoadedBarsDataset> {
  return cachedLoader(readFrozenBarsDataset, opts);
}

/** grader/worker.ts's loadClmmDataset: a clmm dataset row's directory, read and verified against the row's sha256, cached as createDatasetLoader caches. */
export function createClmmDatasetLoader(opts: DatasetLoaderOptions = {}): (row: Pick<DatasetRow, 'path' | 'sha256'>) => Promise<LoadedClmmDataset> {
  return cachedLoader(readFrozenClmmDataset, opts);
}

/** The seeding dev run's history loader: a history dataset row's directory, read and verified against the row's sha256, cached as createDatasetLoader caches. */
export function createBarsHistoryLoader(opts: DatasetLoaderOptions = {}): (row: Pick<DatasetRow, 'path' | 'sha256'>) => Promise<LoadedBarsHistory> {
  return cachedLoader(readFrozenBarsHistory, opts);
}

function cachedLoader<T>(read: (dir: string, o: { expectSha256: string }) => Promise<T>, opts: DatasetLoaderOptions): (row: Pick<DatasetRow, 'path' | 'sha256'>) => Promise<T> {
  const root = opts.root ?? PROJECT_ROOT;
  const size = opts.cache ?? 1;
  const cache = new Map<string, Promise<T>>();
  return (row) => {
    const dir = resolve(root, row.path);
    const key = `${row.sha256}\0${dir}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const loading = read(dir, { expectSha256: row.sha256 });
    if (size > 0) {
      cache.set(key, loading);
      loading.catch(() => {
        if (cache.get(key) === loading) cache.delete(key);
      });
      while (cache.size > size) cache.delete(cache.keys().next().value!);
    }
    return loading;
  };
}

export interface RegisterDatasetOptions {
  /** The frozen dataset directory. */
  dir: string;
  slug: string;
  /** What the row stores as its path (default `dir`; a relative one resolves against the loader's root). */
  path?: string;
  /** Final-phase data: never served in a kit, never changed. */
  sealed?: boolean;
}

/** Each format's collector verifier (see the header): every one must pass before a row is written. */
const VERIFY_FORMAT: Readonly<Record<DatasetFormat, (dir: string) => { ok: boolean; problems: string[] }>> = {
  chain: verifyDataset,
  bars: verifyBarsDataset,
  clmm: verifyClmmDataset,
  'bars-history': verifyBarsHistory,
  program: verifyProgramDataset,
};

/** Each window format's manifest reader (the chain log's is readVerifiedManifest, whose row carries more). */
const WINDOW_MANIFEST: Readonly<Record<Exclude<DatasetFormat, 'chain'>, (dir: string) => { raw: unknown; sha256: string }>> = {
  bars: readVerifiedBarsManifest,
  clmm: readVerifiedClmmManifest,
  'bars-history': readVerifiedBarsHistoryManifest,
  program: programManifestOf,
};

/** A program dataset's verified manifest (grader/program-dataset.ts), its refusal in this module's integrity words. */
function programManifestOf(dir: string): { raw: unknown; sha256: string } {
  try {
    return readVerifiedProgramManifest(dir);
  } catch (err) {
    if (err instanceof ProgramDatasetError) throw new DatasetIntegrityError(err.message, { cause: err });
    throw err;
  }
}

/** What a dataset row records of a directory whose format's verifier passed: plain data (it crosses a thread). */
export interface DatasetRegistrationFacts {
  /** manifest.json as written. */
  raw: unknown;
  /** Its RFC 8785 canonical sha256. */
  sha256: string;
  /** A chain log's chain_report; null for every other format. */
  chainReport: unknown;
  /** A chain log's excluded mints; empty for every other format. */
  excludedMints: string[];
}

/** A directory's format verified and its row's facts read (registerDataset's checks, in its order): a DatasetIntegrityError when they do not hold. */
function registrationFactsOf(dir: string): DatasetRegistrationFacts {
  const format = formatOfDir(dir);
  const report = VERIFY_FORMAT[format](dir);
  if (!report.ok) throw new DatasetIntegrityError(`the dataset at ${dir} does not verify: ${report.problems.slice(0, 5).join('; ')}`);
  if (format !== 'chain') {
    const v = WINDOW_MANIFEST[format](dir);
    return { raw: v.raw, sha256: v.sha256, chainReport: null, excludedMints: [] };
  }
  const v = readVerifiedManifest(dir);
  return { raw: v.raw, sha256: v.sha256, chainReport: v.manifest.chain_report, excludedMints: v.manifest.excluded_mints.map((x) => x.mint) };
}

/**
 * registerDataset's verify and facts of `dir`, as an off-thread task answers them (server/routes/admin/sealed-window.ts
 * registrationFactsTask): the facts, or `{ integrity }` with the DatasetIntegrityError's message word for word (a thrown
 * error crosses a thread with its class lost). Any other error (an I/O failure) is thrown as registerDataset throws it.
 */
export function datasetRegistrationFacts(dir: string): { facts: DatasetRegistrationFacts } | { integrity: string } {
  try {
    return { facts: registrationFactsOf(dir) };
  } catch (err) {
    if (err instanceof DatasetIntegrityError) return { integrity: err.message };
    throw err;
  }
}

/**
 * Register a frozen dataset directory as a dataset row (see the header), after the collector's
 * verifier of its format passes (accepted windows only): verifyDataset for a chain log,
 * verifyBarsDataset for a bars window, verifyClmmDataset for a clmm window, verifyBarsHistory for a
 * history window, verifyProgramDataset for a program dataset. Registering the same dataset under the same slug again returns its row.
 */
export async function registerDataset(db: Db, opts: RegisterDatasetOptions): Promise<DatasetRow> {
  const slug = Slug.parse(opts.slug);
  return insertDatasetRow(db, slug, opts, registrationFactsOf(opts.dir));
}

/**
 * registerDataset with its verify and facts already worked out (datasetRegistrationFacts, off the event loop): the same row
 * written, the same refusals. An `integrity` answer is thrown as the DatasetIntegrityError registerDataset would throw.
 */
export async function registerVerifiedDataset(db: Db, opts: RegisterDatasetOptions, outcome: { facts: DatasetRegistrationFacts } | { integrity: string }): Promise<DatasetRow> {
  const slug = Slug.parse(opts.slug);
  if ('integrity' in outcome) throw new DatasetIntegrityError(outcome.integrity);
  return insertDatasetRow(db, slug, opts, outcome.facts);
}

/** The row of a verified directory: the one already holding its digest (under the same slug), else inserted. */
async function insertDatasetRow(db: Db, slug: string, opts: RegisterDatasetOptions, facts: DatasetRegistrationFacts): Promise<DatasetRow> {
  const { raw, sha256, chainReport, excludedMints } = facts;
  const [existing] = await db.select().from(dataset).where(eq(dataset.sha256, sha256));
  if (existing !== undefined) {
    if (existing.slug !== slug) throw new DatasetIntegrityError(`this dataset (${sha256}) is already registered as ${existing.slug}`);
    return existing;
  }
  const sealed = opts.sealed ?? false;
  const [row] = await db
    .insert(dataset)
    .values({
      slug,
      path: opts.path ?? opts.dir,
      manifest: raw,
      sha256,
      sealed,
      chainReport,
      excludedMints,
      sealedAt: sealed ? new Date() : null,
    })
    .returning();
  return row!;
}
