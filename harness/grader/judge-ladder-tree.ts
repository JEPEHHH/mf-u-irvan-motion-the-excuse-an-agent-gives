// A judge's sealed ladder directory read and held (contracts/competition.ts ProgramJudgeLadder): what a dev phase's
// provisional heat on a ladder plays against and rates by (grader/judge-heat.ts, the header's ladder). The worker's
// provisional heat, a regrade of its record, grade-local and the final kit's verification all read it here, as
// grader/worker.ts readJudgeTree reads the judge directory.
//
//   the seal         the ladder directory re-hashed (server/competitions/load.ts treeSha256) against the bundle's
//                    ladder.ladder_sha256, and the judge directory against judge_sha256: the image holds this bundle's
//                    ladder and judge, or nothing is read
//   the layout       PROGRAM_JUDGE_LADDER_CALIBRATION, a regular file, and at most PROGRAM_JUDGE_LADDER_RUNGS_DIR/ beside
//                    it, a flat directory of regular files (the rungs), none a judge anchor's twin and no two alike
//                    (server/competitions/load.ts ladderDirIssues held the same at load: this holds it again where it is
//                    read). The judge anchors are the regular files flat under <judge dir>/PROGRAM_JUDGE_ANCHORS_DIR/
//   the record       calibration.json is a calibration heat's record (grader/judge-heat.ts parseJudgeHeatRecord): format
//                    agent-fun/judge-heat/v3, stage `calibration`, that holds, stored as its canonical JSON byte for byte
//                    (judgeHeatRecordDigest), its sha256 the calibration_sha256 a ladder heat names
//   this judge's     the record's agent, judge_sha256, media and artifact are the bundle's, and its field is exactly the
//                    judge anchors and the rungs read here: judgeHeatField of no entries, these anchors and these rungs,
//                    each member's sha256, size, anchor files and rung files
//   the fit          judgeLadderFitOf: each member's fixed strength (Fixed9, sha256 order) and the dispersion phi
//
// A ladder that does not read or hold is refused (`{ refused }`): the bundle names a ladder the image does not hold, or
// one no heat can rate by. No retry mends that.
//
// Read once a process: the tree digests answer a file hashed before from its stat (load.ts treeSha256 and
// treeSha256Async), and the calibration record's read (its parse, its checks and its fit: 50 to 200 ms) is held by the
// sha256 of its bytes (calibrationReadOf). A server process reads a ladder with readJudgeLadderAsync: fs/promises, and a
// record not read before read on the off-thread pool (calibrationReadTask), so no read holds its event loop.

import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PROGRAM_JUDGE_ANCHORS_DIR,
  PROGRAM_JUDGE_LADDER_CALIBRATION,
  PROGRAM_JUDGE_LADDER_MAX,
  PROGRAM_JUDGE_LADDER_RUNGS_DIR,
  ProgramJudgeLadder,
  type ProgramJudgeT,
} from '../contracts/competition.ts';
import { Sha256Hex } from '../contracts/primitives.ts';
import { TreeDigestError, treeSha256, treeSha256Async } from '../server/competitions/load.ts';
import { defineOffThreadTask, runOffThread } from '../server/offthread/index.ts';
import { canonicalJson, compareCodeUnits, sha256Hex } from '../sim/canonical.ts';
import {
  JUDGE_HEAT_FORMAT_V3,
  JudgeHeatError,
  JudgeHeatLadder,
  judgeHeatField,
  judgeHeatRecordDigest,
  judgeLadderFitOf,
  parseJudgeHeatRecord,
  type JudgeFieldMemberT,
  type JudgeHeatLadderT,
  type JudgeHeatRecordT,
  type JudgeLadderStrengthT,
} from './judge-heat.ts';

/** A ladder member's file: its path under its directory (anchors/ or rungs/), its sha256 and its size in bytes. */
export interface JudgeLadderFileT {
  file: string;
  artifact_sha256: string;
  artifact_bytes: number;
}

/** A sealed ladder read and held (readJudgeLadder). */
export interface JudgeLadderInputs {
  /** The ladder directory's tree digest: the bundle's ladder.ladder_sha256. */
  ladder_sha256: string;
  /** The judge anchors, flat under <judge dir>/anchors/, in code-unit order of their names. */
  anchors: JudgeLadderFileT[];
  /** The rungs, flat under <ladder dir>/rungs/, in code-unit order of their names (none when the ladder has no rungs/). */
  rungs: JudgeLadderFileT[];
  /** The ladder's members, the calibration's field: the anchors and the rungs, one per artifact, in sha256 order. */
  members: JudgeFieldMemberT[];
  /** Every member's bytes, by sha256: what the judge reads. */
  artifacts: Map<string, Uint8Array>;
  /** The calibration heat's record, as calibration.json holds it. */
  calibration: JudgeHeatRecordT;
  /** calibration.json's sha256: its canonical JSON's (judgeHeatRecordDigest). */
  calibration_sha256: string;
  /** Every member's fixed strength in sha256 order (judgeLadderFitOf). */
  strengths: JudgeLadderStrengthT[];
  /** phi, Fixed9 (judgeLadderFitOf). */
  dispersion: string;
  /**
   * The setup's `ladder` block at the bundle's rounds, games and spread for an entry that is no ladder member (every
   * member's strength): judgeLadderBlock for another design, or an entry whose artifact is one.
   */
  ladder: JudgeHeatLadderT;
}

/** A ladder heat's adaptive design: its rounds, its games a round, the members a round spreads over. */
export interface JudgeLadderDesignT {
  rounds: number;
  games: number;
  spread: number;
}

/**
 * The setup's `ladder` block (grader/judge-heat.ts JudgeHeatLadder) for a provisional heat on the ladder `read`, with
 * the adaptive design `design` (a budget-short day's fewer rounds: grader/worker.ts) and `subject`, the entry's artifact
 * sha256: its strengths are every OTHER member's, so a subject that is a ladder member (an entry identical to an anchor
 * or a rung) is left out of them, as the heat's field merges it into that member. RangeError when the design is not
 * one a bundle's ladder may name (contracts/competition.ts ProgramJudgeLadder: rounds 0 to 8, games 1 to 8, spread 1 to
 * 4 and at most games); TypeError on a subject that is no sha256.
 */
export function judgeLadderBlock(read: Pick<JudgeLadderInputs, 'ladder_sha256' | 'calibration_sha256' | 'strengths' | 'dispersion'>, design: JudgeLadderDesignT, subject?: string): JudgeHeatLadderT {
  const parsed = ProgramJudgeLadder.safeParse({ dir: 'ladder', ladder_sha256: read.ladder_sha256, ...pick(design) });
  if (!parsed.success) {
    throw new RangeError(
      `the ladder design ${canonicalJson(pick(design))} is not one a bundle names (rounds 0 to ${PROGRAM_JUDGE_LADDER_MAX.rounds}, games 1 to ${PROGRAM_JUDGE_LADDER_MAX.games}, spread 1 to ${PROGRAM_JUDGE_LADDER_MAX.spread} and at most games): ${parsed.error.issues.map((i) => `${i.path.join('.') || '(ladder)'}: ${i.message}`).join('; ')}`,
    );
  }
  if (subject !== undefined && !Sha256Hex.safeParse(subject).success) throw new TypeError(`${JSON.stringify(subject)} is not an artifact's lowercase hex sha256`);
  return JudgeHeatLadder.parse({
    ladder_sha256: read.ladder_sha256,
    calibration_sha256: read.calibration_sha256,
    strengths: read.strengths.filter((s) => s.artifact_sha256 !== subject).map((s) => ({ ...s })),
    dispersion: read.dispersion,
    rounds: parsed.data.rounds,
    games: parsed.data.games,
    spread: parsed.data.spread,
  });
}

function pick(d: JudgeLadderDesignT): JudgeLadderDesignT {
  return { rounds: d.rounds, games: d.games, spread: d.spread };
}

/**
 * Read the ladder a bundle seals under the competition's directory (cli/grade-local.ts, cli/kit.ts): readJudgeLadder of
 * judge.ladder.dir and judge.dir there.
 */
export function readJudgeLadderDir(compDir: string, judge: ProgramJudgeT): JudgeLadderInputs | { refused: string } {
  if (judge.ladder === undefined) return { refused: 'the bundle names no ladder (harness.judge.ladder)' };
  return readJudgeLadder(join(compDir, ...judge.ladder.dir.split('/')), judge, join(compDir, ...judge.dir.split('/')));
}

/**
 * readJudgeLadderDir off the event loop's back (readJudgeLadderAsync): the same read of judge.ladder.dir and judge.dir
 * under the competition's directory.
 */
export async function readJudgeLadderDirAsync(compDir: string, judge: ProgramJudgeT): Promise<JudgeLadderInputs | { refused: string }> {
  if (judge.ladder === undefined) return { refused: 'the bundle names no ladder (harness.judge.ladder)' };
  return readJudgeLadderAsync(join(compDir, ...judge.ladder.dir.split('/')), judge, join(compDir, ...judge.dir.split('/')));
}

type Kind = 'file' | 'dir' | 'other' | 'missing';

function kindOf(path: string): Kind {
  try {
    return kindOfStat(lstatSync(path));
  } catch {
    return 'missing';
  }
}

async function kindOfAsync(path: string): Promise<Kind> {
  try {
    return kindOfStat(await lstat(path));
  } catch {
    return 'missing';
  }
}

function kindOfStat(s: Stats): Kind {
  return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other';
}

/** The regular files flat under `dir`, in code-unit order of their names, read; `refused` on anything else there. */
function readFlat(dir: string, what: string, artifacts: Map<string, Uint8Array>): JudgeLadderFileT[] | { refused: string } {
  const out: JudgeLadderFileT[] = [];
  for (const file of readdirSync(dir).sort(compareCodeUnits)) {
    if (kindOf(join(dir, file)) !== 'file') return { refused: `${what}/${file} is not a regular file: every entry of ${what}/ is an artifact` };
    out.push(flatFile(file, new Uint8Array(readFileSync(join(dir, file))), artifacts));
  }
  return out;
}

/** readFlat with fs/promises: each file read, then hashed, in a turn of its own. */
async function readFlatAsync(dir: string, what: string, artifacts: Map<string, Uint8Array>): Promise<JudgeLadderFileT[] | { refused: string }> {
  const out: JudgeLadderFileT[] = [];
  for (const file of (await readdir(dir)).sort(compareCodeUnits)) {
    if ((await kindOfAsync(join(dir, file))) !== 'file') return { refused: `${what}/${file} is not a regular file: every entry of ${what}/ is an artifact` };
    out.push(flatFile(file, new Uint8Array(await readFile(join(dir, file))), artifacts));
  }
  return out;
}

function flatFile(file: string, bytes: Uint8Array, artifacts: Map<string, Uint8Array>): JudgeLadderFileT {
  const sha = sha256Hex(bytes);
  artifacts.set(sha, bytes);
  return { file, artifact_sha256: sha, artifact_bytes: bytes.byteLength };
}

/** The tree digest of `dir`, or why it does not read (a missing path, a link, a device: TreeDigestError). */
function digestOf(dir: string): { sha: string } | { error: string } {
  try {
    return { sha: treeSha256(dir) };
  } catch (err) {
    return digestError(err);
  }
}

/** digestOf with treeSha256Async: every file hashed with fs/promises, one hashed before answered from its stat. */
async function digestOfAsync(dir: string): Promise<{ sha: string } | { error: string }> {
  try {
    return { sha: await treeSha256Async(dir) };
  } catch (err) {
    return digestError(err);
  }
}

function digestError(err: unknown): { error: string } {
  // A missing path, a link or a device (TreeDigestError), or a directory the process cannot list (an errno).
  if (err instanceof TreeDigestError || (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string')) return { error: err.message };
  throw err;
}

// ---------------------------------------------------------------- the calibration record, read once a process

/**
 * What a ladder's calibration.json reads as, by its bytes alone (calibrationReadOf): why it is no v3 calibration record
 * stored as its canonical JSON (`issue`), or the record, its canonical sha256 and its fit (judgeLadderFitOf; `fit_error`
 * the fit's refusal). Plain data, as it crosses the off-thread boundary (calibrationReadTask).
 */
export type CalibrationRead =
  | { issue: 'parse'; message: string }
  | { issue: 'format'; format: string }
  | { issue: 'stage'; stage: string }
  | { issue: 'canonical'; bytes_sha256: string; canonical_sha256: string }
  | { issue: null; calibration: JudgeHeatRecordT; calibration_sha256: string; fit: { strengths: JudgeLadderStrengthT[]; dispersion: string } | { fit_error: string } };

/**
 * calibration.json's bytes read as a ladder reads them: parseJudgeHeatRecord, a v3 calibration, its canonical JSON byte
 * for byte, then its fit. Pure, and the export the grader's off-thread task runs (calibrationReadTask): the parse, the
 * record's checks and the fit run 50 to 200 ms on a ladder of today's size.
 */
export function calibrationReadOf(input: { bytes: Uint8Array }): CalibrationRead {
  const { bytes } = input;
  let calibration: JudgeHeatRecordT;
  try {
    calibration = parseJudgeHeatRecord(bytes);
  } catch (err) {
    if (err instanceof JudgeHeatError) return { issue: 'parse', message: err.message };
    throw err;
  }
  if (calibration.format !== JUDGE_HEAT_FORMAT_V3) return { issue: 'format', format: calibration.format };
  if (calibration.stage !== 'calibration') return { issue: 'stage', stage: calibration.stage };
  const canonical = judgeHeatRecordDigest(calibration);
  if (Buffer.compare(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), Buffer.from(canonical.json, 'utf8')) !== 0) {
    return { issue: 'canonical', bytes_sha256: sha256Hex(bytes), canonical_sha256: canonical.sha256 };
  }
  let fit: { strengths: JudgeLadderStrengthT[]; dispersion: string } | { fit_error: string };
  try {
    const f = judgeLadderFitOf(calibration);
    fit = { strengths: f.strengths, dispersion: f.dispersion };
  } catch (err) {
    if (!(err instanceof JudgeHeatError)) throw err;
    fit = { fit_error: err.message };
  }
  return { issue: null, calibration, calibration_sha256: canonical.sha256, fit };
}

/**
 * calibrationReadOf on the off-thread pool (server/offthread): readJudgeLadderAsync's read of a calibration it has not
 * read before. The pooled lane: a calibration plays a ladder's few members (news-image-daily's 595 kB), never a final's field.
 */
export const calibrationReadTask = defineOffThreadTask<typeof calibrationReadOf>('judge-ladder.calibration', import.meta.url, 'calibrationReadOf', { timeoutMs: 120_000 });

/** How many calibration reads the process holds (a few ladders are graded at once; each read is a few MB of record). */
export const CALIBRATION_MEMO_MAX = 8;
/** Calibration reads by the sha256 of the bytes read, the least recently used first: a ladder's record is read once a process. */
const calibrationMemo = new Map<string, CalibrationRead>();
let calibrationReads = 0;

/** The memo's read of the calibration whose bytes hash to `sha256` (used again, so kept longest), or undefined. */
function heldCalibration(sha256: string): CalibrationRead | undefined {
  const held = calibrationMemo.get(sha256);
  if (held === undefined) return undefined;
  calibrationMemo.delete(sha256);
  calibrationMemo.set(sha256, held);
  return held;
}

function keepCalibration(sha256: string, read: CalibrationRead): void {
  calibrationMemo.delete(sha256);
  calibrationMemo.set(sha256, read);
  while (calibrationMemo.size > CALIBRATION_MEMO_MAX) calibrationMemo.delete(calibrationMemo.keys().next().value!);
}

/** What the calibration memo holds and how many reads it did not answer (tests). */
export function calibrationMemoStats(): { entries: number; reads: number } {
  return { entries: calibrationMemo.size, reads: calibrationReads };
}

/** Drop every held calibration read (tests). */
export function clearCalibrationMemo(): void {
  calibrationMemo.clear();
}

/** calibration.json's read: the memo's for bytes read before, else calibrationReadOf here, held. */
function calibrationReadSync(bytes: Uint8Array): CalibrationRead {
  const sha = sha256Hex(bytes);
  const held = heldCalibration(sha);
  if (held !== undefined) return held;
  calibrationReads += 1;
  const read = calibrationReadOf({ bytes });
  keepCalibration(sha, read);
  return read;
}

/**
 * calibration.json's read off the event loop: the memo's for bytes read before, else calibrationReadOf on the off-thread
 * pool (calibrationReadTask, one run for every caller reading the same bytes meanwhile), held. Rejects with the pool's
 * OffThreadError when the pool cannot run it: never the read on the loop.
 */
async function calibrationReadOffLoop(bytes: Uint8Array): Promise<CalibrationRead> {
  const sha = sha256Hex(bytes);
  const held = heldCalibration(sha);
  if (held !== undefined) return held;
  calibrationReads += 1;
  const copy = new Uint8Array(bytes);
  const read = await runOffThread(calibrationReadTask, { bytes: copy }, { key: `calibration:${sha}`, transfer: [copy.buffer] });
  keepCalibration(sha, read);
  return read;
}

// ---------------------------------------------------------------- the read

/** A ladder's directories read past their seals and layout (readJudgeLadder's first steps): its members' files and calibration.json's bytes. */
interface LadderFiles {
  ladder_sha256: string;
  anchors: JudgeLadderFileT[];
  rungs: JudgeLadderFileT[];
  artifacts: Map<string, Uint8Array>;
  bytes: Uint8Array;
}

/** What every read of a ladder refuses before its files: no ladder named. */
const NO_LADDER = 'the bundle names no ladder (harness.judge.ladder)';

/** The seals' refusal, if any: the ladder's digest and the judge directory's against the bundle's. */
function sealRefusal(judge: ProgramJudgeT, ladderDigest: { sha: string } | { error: string }, judgeDigest: () => { sha: string } | { error: string }): { refused: string } | null {
  const sealed = judge.ladder!;
  const where = `the ladder directory ${sealed.dir}`;
  if ('error' in ladderDigest) return { refused: `${where} does not read (${ladderDigest.error}): the image holds no ladder for this bundle` };
  if (ladderDigest.sha !== sealed.ladder_sha256) {
    return { refused: `${where} hashes to ${ladderDigest.sha}, and the bundle seals ${sealed.ladder_sha256}: the image holds another ladder than the bundle's` };
  }
  const j = judgeDigest();
  if ('error' in j) return { refused: `the judge directory ${judge.dir} does not read (${j.error}): the image holds no judge for this bundle` };
  if (j.sha !== judge.judge_sha256) {
    return { refused: `the judge directory ${judge.dir} hashes to ${j.sha}, and the bundle seals ${judge.judge_sha256}: the image holds another judge than the bundle's` };
  }
  return null;
}

/** The layout's sentence every layout refusal ends with. */
function holdsText(sealed: NonNullable<ProgramJudgeT['ladder']>): string {
  return `the ladder directory ${sealed.dir} holds ${PROGRAM_JUDGE_LADDER_CALIBRATION}, the house's calibration record, and at most ${PROGRAM_JUDGE_LADDER_RUNGS_DIR}/ beside it, a flat directory of house rungs`;
}

/** A name in the ladder directory that is neither calibration.json nor rungs/, refused. */
function strayRefusal(sealed: NonNullable<ProgramJudgeT['ladder']>, names: string[]): { refused: string } | null {
  for (const name of names.sort(compareCodeUnits)) {
    if (name !== PROGRAM_JUDGE_LADDER_CALIBRATION && name !== PROGRAM_JUDGE_LADDER_RUNGS_DIR) return { refused: `${sealed.dir}/${name} is neither ${PROGRAM_JUDGE_LADDER_CALIBRATION} nor ${PROGRAM_JUDGE_LADDER_RUNGS_DIR}/: ${holdsText(sealed)}` };
  }
  return null;
}

/** A rung that is a judge anchor's twin or another rung's, refused. */
function twinRefusal(sealed: NonNullable<ProgramJudgeT['ladder']>, anchors: JudgeLadderFileT[], rungs: JudgeLadderFileT[]): { refused: string } | null {
  const anchorShas = new Set(anchors.map((a) => a.artifact_sha256));
  const seen = new Map<string, string>();
  for (const r of rungs) {
    const at = `${sealed.dir}/${PROGRAM_JUDGE_LADDER_RUNGS_DIR}/${r.file}`;
    if (anchorShas.has(r.artifact_sha256)) return { refused: `${at} is the same artifact as a judge anchor: a rung is a member of the ladder apart from the anchors` };
    const twin = seen.get(r.artifact_sha256);
    if (twin !== undefined) return { refused: `${at} is the same artifact as ${sealed.dir}/${PROGRAM_JUDGE_LADDER_RUNGS_DIR}/${twin}: identical rungs are one member of the ladder` };
    seen.set(r.artifact_sha256, r.file);
  }
  return null;
}

/** The seals and the layout read synchronously (readJudgeLadder). */
function ladderFiles(ladderDir: string, judge: ProgramJudgeT, judgeDir: string): LadderFiles | { refused: string } {
  const sealed = judge.ladder!;
  const ladderDigest = digestOf(ladderDir);
  const seals = sealRefusal(judge, ladderDigest, () => digestOf(judgeDir));
  if (seals !== null) return seals;
  const stray = strayRefusal(sealed, readdirSync(ladderDir));
  if (stray !== null) return stray;
  const calibrationPath = join(ladderDir, PROGRAM_JUDGE_LADDER_CALIBRATION);
  if (kindOf(calibrationPath) !== 'file') return { refused: `${sealed.dir}/${PROGRAM_JUDGE_LADDER_CALIBRATION} is not a regular file: ${holdsText(sealed)}` };
  const artifacts = new Map<string, Uint8Array>();
  const anchorsDir = join(judgeDir, PROGRAM_JUDGE_ANCHORS_DIR);
  if (kindOf(anchorsDir) !== 'dir') return { refused: `the judge directory ${judge.dir} has no ${PROGRAM_JUDGE_ANCHORS_DIR}/: the ladder's members are its anchors and the rungs` };
  const anchors = readFlat(anchorsDir, `${judge.dir}/${PROGRAM_JUDGE_ANCHORS_DIR}`, artifacts);
  if (!Array.isArray(anchors)) return anchors;
  const rungsDir = join(ladderDir, PROGRAM_JUDGE_LADDER_RUNGS_DIR);
  const rungsKind = kindOf(rungsDir);
  if (rungsKind !== 'missing' && rungsKind !== 'dir') return { refused: `${sealed.dir}/${PROGRAM_JUDGE_LADDER_RUNGS_DIR} is not a directory: ${holdsText(sealed)}` };
  const rungs = rungsKind === 'missing' ? [] : readFlat(rungsDir, `${sealed.dir}/${PROGRAM_JUDGE_LADDER_RUNGS_DIR}`, artifacts);
  if (!Array.isArray(rungs)) return rungs;
  const twin = twinRefusal(sealed, anchors, rungs);
  if (twin !== null) return twin;
  return { ladder_sha256: (ladderDigest as { sha: string }).sha, anchors, rungs, artifacts, bytes: new Uint8Array(readFileSync(calibrationPath)) };
}

/** ladderFiles with fs/promises and the held tree digests (treeSha256Async): the same refusals, in the same order. */
async function ladderFilesAsync(ladderDir: string, judge: ProgramJudgeT, judgeDir: string): Promise<LadderFiles | { refused: string }> {
  const sealed = judge.ladder!;
  const ladderDigest = await digestOfAsync(ladderDir);
  // The judge directory is digested only once the ladder's seal holds, as ladderFiles digests it.
  const judgeDigest = 'sha' in ladderDigest && ladderDigest.sha === sealed.ladder_sha256 ? await digestOfAsync(judgeDir) : null;
  const seals = sealRefusal(judge, ladderDigest, () => judgeDigest!);
  if (seals !== null) return seals;
  const stray = strayRefusal(sealed, await readdir(ladderDir));
  if (stray !== null) return stray;
  const calibrationPath = join(ladderDir, PROGRAM_JUDGE_LADDER_CALIBRATION);
  if ((await kindOfAsync(calibrationPath)) !== 'file') return { refused: `${sealed.dir}/${PROGRAM_JUDGE_LADDER_CALIBRATION} is not a regular file: ${holdsText(sealed)}` };
  const artifacts = new Map<string, Uint8Array>();
  const anchorsDir = join(judgeDir, PROGRAM_JUDGE_ANCHORS_DIR);
  if ((await kindOfAsync(anchorsDir)) !== 'dir') return { refused: `the judge directory ${judge.dir} has no ${PROGRAM_JUDGE_ANCHORS_DIR}/: the ladder's members are its anchors and the rungs` };
  const anchors = await readFlatAsync(anchorsDir, `${judge.dir}/${PROGRAM_JUDGE_ANCHORS_DIR}`, artifacts);
  if (!Array.isArray(anchors)) return anchors;
  const rungsDir = join(ladderDir, PROGRAM_JUDGE_LADDER_RUNGS_DIR);
  const rungsKind = await kindOfAsync(rungsDir);
  if (rungsKind !== 'missing' && rungsKind !== 'dir') return { refused: `${sealed.dir}/${PROGRAM_JUDGE_LADDER_RUNGS_DIR} is not a directory: ${holdsText(sealed)}` };
  const rungs = rungsKind === 'missing' ? [] : await readFlatAsync(rungsDir, `${sealed.dir}/${PROGRAM_JUDGE_LADDER_RUNGS_DIR}`, artifacts);
  if (!Array.isArray(rungs)) return rungs;
  const twin = twinRefusal(sealed, anchors, rungs);
  if (twin !== null) return twin;
  return { ladder_sha256: (ladderDigest as { sha: string }).sha, anchors, rungs, artifacts, bytes: new Uint8Array(await readFile(calibrationPath)) };
}

/** The ladder held: its calibration read (`cal`, calibrationReadOf of `files.bytes`) as the bundle's judge's, then its fit. */
function heldLadder(judge: ProgramJudgeT, files: LadderFiles, cal: CalibrationRead): JudgeLadderInputs | { refused: string } {
  const sealed = judge.ladder!;
  const recordAt = `${sealed.dir}/${PROGRAM_JUDGE_LADDER_CALIBRATION}`;
  // The record: a v3 calibration that holds, stored as its canonical JSON.
  if (cal.issue === 'parse') return { refused: `${recordAt}: ${cal.message}` };
  if (cal.issue === 'format') return { refused: `${recordAt} is a ${cal.format} record: a ladder's calibration is ${JUDGE_HEAT_FORMAT_V3}` };
  if (cal.issue === 'stage') return { refused: `${recordAt} is a ${cal.stage} heat's record: a ladder's is a calibration's` };
  if (cal.issue === 'canonical') {
    return { refused: `${recordAt} is not its record's canonical JSON (sha256 ${cal.bytes_sha256}, the canonical form's ${cal.canonical_sha256}): the ladder seals the record as stored` };
  }
  const { calibration, anchors, rungs } = { calibration: cal.calibration, anchors: files.anchors, rungs: files.rungs };

  // This judge's: its agent, its judge directory, its media and its artifact, and a field of its anchors and these rungs.
  const off: string[] = [];
  if (canonicalJson(calibration.agent) !== canonicalJson(judge.agent)) off.push(`agent ${canonicalJson(calibration.agent)}, not the bundle's ${canonicalJson(judge.agent)}`);
  if (calibration.judge_sha256 !== judge.judge_sha256) off.push(`judge_sha256 ${calibration.judge_sha256}, not the bundle's ${judge.judge_sha256}`);
  if (calibration.media !== judge.media) off.push(`media ${calibration.media}, not the bundle's ${judge.media}`);
  if (calibration.artifact !== judge.artifact) off.push(`artifact ${calibration.artifact}, not the bundle's ${judge.artifact}`);
  const field = judgeHeatField([], anchors, rungs);
  if (canonicalJson(calibration.field) !== canonicalJson(field)) {
    off.push(`a field of ${calibration.field.length} members other than the judge's ${anchors.length} anchors and the ladder's ${rungs.length} rungs (each member's sha256, bytes, anchor files and rung files)`);
  }
  if (off.length > 0) return { refused: `${recordAt} calibrates another judge than the bundle's: ${off.join('; ')}` };

  if ('fit_error' in cal.fit) return { refused: `${recordAt}: ${cal.fit.fit_error}` };
  const read = { ladder_sha256: files.ladder_sha256, calibration_sha256: cal.calibration_sha256, strengths: cal.fit.strengths, dispersion: cal.fit.dispersion };
  return {
    ...read,
    anchors,
    rungs,
    members: calibration.field,
    artifacts: files.artifacts,
    calibration,
    ladder: judgeLadderBlock(read, sealed),
  };
}

/**
 * Read the ladder a bundle seals at `ladderDir` (the header), with its judge directory at `judgeDir` (where
 * grader/worker.ts readJudgeTree finds it: the competition's directory, or a sponsored judged-artifact competition's
 * materialized one): each held to its tree digest, the layout, the calibration record and its hold on this judge, then
 * the fit. `refused`, saying why, when the bundle names no ladder, either directory does not read or is another one,
 * or the ladder does not hold. The tree digests answer a file hashed before from its stat (load.ts treeSha256), and the
 * calibration record read before (by its bytes' sha256) from the process's memo, so a ladder re-read every provisional
 * heat parses and fits its record once. What it returns is shared with later reads of the same ladder: never mutate it.
 * A server process reads it with readJudgeLadderAsync.
 */
export function readJudgeLadder(ladderDir: string, judge: ProgramJudgeT, judgeDir: string): JudgeLadderInputs | { refused: string } {
  if (judge.ladder === undefined) return { refused: NO_LADDER };
  const files = ladderFiles(ladderDir, judge, judgeDir);
  if ('refused' in files) return files;
  return heldLadder(judge, files, calibrationReadSync(files.bytes));
}

/**
 * readJudgeLadder off the event loop's back, the same answer: the tree digests with fs/promises (load.ts
 * treeSha256Async, a file hashed before answered from its stat), every file read with fs/promises, and a calibration
 * record not read before parsed, checked and fitted on the off-thread pool (calibrationReadTask), then held. Rejects with
 * the pool's OffThreadError when the pool cannot read it now (the caller's job retries).
 */
export async function readJudgeLadderAsync(ladderDir: string, judge: ProgramJudgeT, judgeDir: string): Promise<JudgeLadderInputs | { refused: string }> {
  if (judge.ladder === undefined) return { refused: NO_LADDER };
  const files = await ladderFilesAsync(ladderDir, judge, judgeDir);
  if ('refused' in files) return files;
  return heldLadder(judge, files, await calibrationReadOffLoop(files.bytes));
}
