// A scrape/v1 run's verdicts and its performance (contracts/scrape.ts holds the records, and the rank
// key's one rule, scrapeTimeUs). Three parts:
//
//   the verdict      each timed trial's output against what its own cassette served. A trial the harness
//                    found no fault in (grader/scrape/trial.ts: the entry exited 0 within the cap, left no
//                    process, stayed on the routes and under the caps) is scored by the bundle's sealed
//                    scorer TWICE, each run through harnesses.ts scoreProgramBreakdown (program.ts's scorer
//                    run, a malformed checks.json dropped as program/v1 grading drops it: a checks.json is
//                    no part of a scrape verdict, so it never fails one) in a fresh directory: /output
//                    the trial's outputs from the blob store, /reference/cassette/ the trial's cassette
//                    (cassette.json, the bytes stored under cassette_sha256) and every decoded body it
//                    names (bodies/<sha256>), and /reference/heat/ the heat's reference read in the same
//                    layout (the house's own read of the routes through the same gateway at heat start,
//                    which a scorer may hold a trial's responses to: roblox-top100-scrape-01's takes its
//                    reference row count from it). The two scores.json must be byte-equal, or the scorer
//                    disagreed with itself (ScorerDisagreementError, a ScorerError): the deterministic half
//                    of grade-twice, since the measurement itself cannot be re-run. scores.json holds
//                    SCRAPE_SCORE_COLUMNS, whole numbers, `correct` 1 or 0. The trial is correct when the
//                    scorer says correct = 1 and the harness found no fault; incorrect when it says 0; a
//                    trial with a fault keeps the fault as its status and is never scored (scores_sha256
//                    null), so an L1 regrade re-scores exactly the trials that were scored. The callers
//                    judge an incorrect trial a second time with its own cassette mounted at /reference/heat/
//                    in place of the heat's reference read (heatReferenceSha256 = its cassette_sha256):
//                    correct then, it failed on the reference read alone, on how the upstream served the
//                    same request since the heat began (roblox-top100-scrape-01: Roblox's chart a game
//                    short for every reader at once), so a heat voids it and runs it again (grader/scrape/
//                    heat.ts judged voids, judged_void in its log), the kit's local test shows it void and
//                    runs it again (cli/scrape-local.ts), and an admin's re-judging, which can run no trial,
//                    lists it void (contracts/scrape.ts SCRAPE_VOID_STATUS, scrapeVoidRecord: both judgings'
//                    scores.json named) and scores its run on its other rounds (grader/regrade.ts
//                    rejudgeScrapeRun), whose L1 regrade judges it twice again. This module judges once per
//                    call either way; the reference read and a faulted trial are never judged twice
//   the performance  scrapePerformance: per trial its round, stage, status and wall_us (the manifest's
//                    wall_ns half-even to the microsecond, scrapeWallUs), and from those the rank key
//                    time_ms (scrapeTimeUs: the correct trials' times plus one +infinity per other trial,
//                    the `trim` fastest and slowest dropped, the rest averaged half-even; more than `trim`
//                    failures leave the run unranked), median_ms and best_ms over the correct trials, the
//                    counts, and Yuen's 90% interval of the trimmed mean. A listed void is listed and left
//                    out of all of them and of the trim's rule (contracts/scrape.ts scrapeCountedTrials): K
//                    is the trials that count, and voids that leave fewer main trials to count than
//                    scrapeFewestCountedMain make no performance. Per stage: at the main stage's end
//                    a run's performance is over its main trials (stage 'main'), which is what the playoff
//                    is drawn from; after the playoff a finalist's covers its main and playoff trials alike
//   the order        compareScrapeRuns: ranked runs before unranked ones, finalists before every
//                    non-finalist whatever their times, then time_ms ascending; an exact tie is the
//                    caller's to break (the board's earlier receipt). scrapeDifference is the two-sample
//                    Yuen-Welch interval of two ranked runs' trimmed means, for the statistical ties (it
//                    holds 0) and the baseline gate (it lies wholly below 0: the entry is faster)
//
// The interval, in exact integers. Of a ranked run's K trials that count (failures as +infinity, never more than
// g = trim of them; a listed void none of them), the winsorized sample w: the K sorted times with the g fastest set to the (g+1)-th
// fastest and the g slowest to the (g+1)-th slowest, a correct trial whenever the run is ranked. With
// h = K - 2g the trials kept, Yuen's variance of the trimmed mean is d = SSD_w / (h (h - 1)), SSD_w the
// winsorized sum of squared deviations (Tukey & McLaughlin 1963; Yuen 1974): in integers,
// d = (K Σw² - (Σw)²) / (K h (h - 1)) square microseconds. The run's interval is
// time_ms ± t(0.95, h - 1) √d; two runs' difference is (time_a - time_b) ± t(0.95, ν) √(d_a + d_b),
// ν the Welch-Satterthwaite (d_a + d_b)² / (d_a² / (h_a - 1) + d_b² / (h_b - 1)), floored to a whole
// number of degrees of freedom. t comes from SCRAPE_T90_MICRO, the 0.95 quantile at 10^-6 for 1..60
// degrees of freedom (grader/agent-score.ts T90_MICRO's 1..29, extended), and z (1.644854) beyond. The
// half-width round(t √d) is taken exactly, half to even (sqrtHalfEven), and each end is the published
// centre minus or plus it: whole microseconds, so the same trials give the same bytes everywhere.
//
// Faults: a scorer that crashes, times out, writes a malformed scores.json or values outside its
// contract, or disagrees with itself, and a reference the blob store cannot rebuild (the trial's
// cassette, the heat's reference read or a body either names missing, a cassette that is not one), are
// the competition's or the house's (ScorerError), never the entry's; a trial or run handed in out of
// shape is the caller's (RangeError, TypeError).

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { LeaderboardColumn, ProgramHarness, ScrapeHarnessT } from '../../contracts/competition.ts';
import {
  checkScrapeTrialOrder,
  formatScrapeMillis,
  parseScrapeMillis,
  SCRAPE_HARNESS_KIND,
  SCRAPE_INTERVAL_LEVEL,
  SCRAPE_LISTED_STATUSES,
  ScrapeCassette,
  scrapeCountedTrials,
  scrapeFewestCountedMain,
  ScrapePerformance,
  scrapeBestUs,
  scrapeMedianUs,
  scrapeTimeUs,
  ScrapeTrialRecord,
  scrapeWallUs,
  type ScrapeCassetteT,
  type ScrapeListedStatusT,
  type ScrapePerformanceT,
  type ScrapeStageT,
  type ScrapeTrialRecordT,
  type ScrapeTrialStatusT,
} from '../../contracts/scrape.ts';
import { T90_MICRO } from '../agent-score.ts';
import { holdScratch, removeScratch } from '../grade.ts';
import { scoreProgramBreakdown } from '../harnesses.ts';
import { ProgramOutputs, sealStaged, type OutputBlobs, type ProgramSetup } from '../program.ts';
import { ScorerError, SCORES_FILE, type ProgramScores } from '../program-scores.ts';
import type { LimitsT } from '../run.ts';
import type { Sandbox } from '../sandbox/types.ts';
import { BODIES_DIR, CASSETTE_FILE } from './gateway-main.ts';

// ---------------------------------------------------------------- the scorer's contract

/**
 * What a scrape/v1 scorer writes to /scores/scores.json, every value a whole number: `correct` (1 when
 * the output is what the trial's cassette served, else 0) and the counts it judged on (the output's
 * rows, the chart responses and the details ids the cassette held). Keys in code-unit order.
 */
export const SCRAPE_SCORE_COLUMNS = ['chart_responses', 'correct', 'details_ids', 'rows'] as const;
export type ScrapeScoreColumnT = (typeof SCRAPE_SCORE_COLUMNS)[number];
export type ScrapeTrialScoresT = Record<ScrapeScoreColumnT, number>;

/** The column holding the scorer's verdict. */
export const SCRAPE_CORRECT_COLUMN = 'correct' satisfies ScrapeScoreColumnT;

/** Where the trial's cassette sits under /reference: /reference/cassette/cassette.json and /reference/cassette/bodies/<sha256>. */
export const SCRAPE_REFERENCE_CASSETTE_DIR = 'cassette';

/** Where the heat's reference read sits under /reference, in the same layout: /reference/heat/cassette.json and /reference/heat/bodies/<sha256>. */
export const SCRAPE_REFERENCE_HEAT_DIR = 'heat';

/** The statuses the harness gives a trial (grader/scrape/trial.ts): every status but the scorer's two verdicts. */
export const SCRAPE_FAULT_STATUSES = ['timeout', 'crashed', 'invalid_output', 'leftover_process', 'off_route', 'over_cap'] as const satisfies readonly ScrapeTrialStatusT[];
export type ScrapeFaultStatusT = (typeof SCRAPE_FAULT_STATUSES)[number];

/** The scorer's two verdicts. */
export const SCRAPE_VERDICT_STATUSES = ['correct', 'incorrect'] as const satisfies readonly ScrapeTrialStatusT[];

/** Whether a status is a harness fault (SCRAPE_FAULT_STATUSES). */
export function isScrapeFault(status: string): status is ScrapeFaultStatusT {
  return (SCRAPE_FAULT_STATUSES as readonly string[]).includes(status);
}

/**
 * A listed trial's harness fault, or null when the scorer judged it (correct, incorrect, or void: judged twice at a
 * re-judging, incorrect against the heat's reference read and correct against its own cassette): what an L1 regrade
 * hands judgeScrapeTrial back.
 */
export function scrapeFaultOf(status: ScrapeListedStatusT): ScrapeFaultStatusT | null {
  return isScrapeFault(status) ? status : null;
}

/** The scorer wrote different scores.json bytes on its two runs over the same trial (the header): its digests, first run then second. */
export class ScorerDisagreementError extends ScorerError {
  readonly first_sha256: string;
  readonly second_sha256: string;

  constructor(first: string, second: string) {
    super(`the scorer disagreed with itself: two runs over the same trial wrote different scores.json (sha256 ${first}, then ${second}); a sealed scorer judges a trial to the same bytes every time`);
    this.name = 'ScorerDisagreementError';
    this.first_sha256 = first;
    this.second_sha256 = second;
  }
}

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** scores.json's values held to the contract (SCRAPE_SCORE_COLUMNS): each a whole number, `correct` 1 or 0. ScorerError otherwise. */
export function scrapeTrialScores(scores: ProgramScores): ScrapeTrialScoresT {
  const out = {} as ScrapeTrialScoresT;
  for (const c of SCRAPE_SCORE_COLUMNS) {
    const v = scores[c];
    if (v === undefined || v === null || !Number.isSafeInteger(v) || v < 0) throw new ScorerError(`scores.json ${c} is ${String(v)}: a scrape/v1 scorer writes whole numbers`);
    out[c] = v;
  }
  for (const k of Object.keys(scores)) if (!(SCRAPE_SCORE_COLUMNS as readonly string[]).includes(k)) throw new ScorerError(`scores.json has ${k}, which a scrape/v1 scorer does not write (${SCRAPE_SCORE_COLUMNS.join(', ')})`);
  if (out.correct !== 0 && out.correct !== 1) throw new ScorerError(`scores.json correct is ${out.correct}: it is 1 when the output is what the trial's cassette served, else 0`);
  return out;
}

/** The trial's status: its harness fault when it has one, else the scorer's verdict. */
export function scrapeTrialVerdict(fault: ScrapeFaultStatusT | null, scores: Pick<ScrapeTrialScoresT, 'correct'> | null): ScrapeTrialStatusT {
  if (fault !== null) {
    if (!isScrapeFault(fault)) throw new RangeError(`${String(fault)} is not a harness fault: one of ${SCRAPE_FAULT_STATUSES.join(', ')}`);
    return fault;
  }
  if (scores === null) throw new TypeError('a trial with no harness fault is scored: its verdict needs the scorer\'s scores');
  return scores.correct === 1 ? 'correct' : 'incorrect';
}

// ---------------------------------------------------------------- the scorer, twice

/** The sealed scorer's part of a scrape/v1 bundle, and the competition directory it sits in. */
export interface ScrapeScorerSetup {
  /**
   * Absolute competition directory: the scorer's entrypoint is inside it. On the k8s sandbox, whose pods mount the data
   * claim alone, the scorer's stage there, which holds it at the bundle's own path, byte for byte the image's and
   * re-hashed to scorer_sha256 (grader/worker.ts stageScrapeScorerSetup).
   */
  compDir: string;
  harness: Pick<ScrapeHarnessT, 'runtimes' | 'scorer' | 'scorer_sha256'>;
}

type ProgramHarnessT = z.infer<typeof ProgramHarness>;
type LeaderboardColumnT = z.infer<typeof LeaderboardColumn>;

/** The columns scoreProgramBreakdown holds scores.json to: SCRAPE_SCORE_COLUMNS, each scored (no computation, no source). */
const SCORER_COLUMNS: LeaderboardColumnT[] = SCRAPE_SCORE_COLUMNS.map((key, index) => ({
  key,
  title: key,
  index,
  sorting: 'desc',
  precision: 0,
  hidden: true,
  computation: null,
  computation_indexes: null,
  source: null,
}));

/**
 * program.ts's setup for the scrape scorer over one trial: a program/v1 harness with no data of its
 * own (the scorer's runtime and entrypoint, its sealed digest), the trial's reference directory as an
 * instance's, and scores.json held to SCRAPE_SCORE_COLUMNS. programScorerDigest takes the scorer's
 * version from it.
 */
export function scrapeProgramSetup(setup: ScrapeScorerSetup, referenceDir: string): ProgramSetup {
  const h = setup.harness;
  const harness: ProgramHarnessT = {
    kind: 'program/v1',
    runtimes: [...h.runtimes],
    input_data: null,
    scorer: { runtime: h.scorer.runtime, entrypoint: h.scorer.entrypoint, reference_data: null },
    scorer_sha256: h.scorer_sha256,
  };
  return { compDir: setup.compDir, harness, leaderboard: { columns: SCORER_COLUMNS }, referenceDir };
}

async function readBlob(blobs: OutputBlobs, digest: string, what: string): Promise<Uint8Array> {
  const bytes = await blobs.get(digest, { verify: true });
  if (bytes === null) throw new ScorerError(`${what} (${digest}) is missing from the blob store`);
  if (sha256(bytes) !== digest) throw new ScorerError(`${what} (${digest}) hashes to ${sha256(bytes)} in the blob store`);
  return bytes;
}

/**
 * Write one cassette into `dir` (made here) from the blob store, read-only: cassette.json, the bytes
 * stored under `cassetteSha256`, which must parse as a ScrapeCassette, and bodies/<sha256> for every
 * decoded body it names, each its recorded size. The cassette, parsed; `what` names it in a fault.
 */
async function materializeCassette(cassetteSha256: string, blobs: OutputBlobs, dir: string, what: string): Promise<ScrapeCassetteT> {
  const bytes = await readBlob(blobs, cassetteSha256, what);
  let cassette: ScrapeCassetteT;
  try {
    cassette = ScrapeCassette.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (err) {
    throw new ScorerError(`${what} (${cassetteSha256}) is not a scrape cassette: ${(err as Error).message}`);
  }
  const sizes = new Map<string, number>();
  for (const e of cassette.entries) {
    if (e.body_sha256 === null) continue;
    const size = sizes.get(e.body_sha256);
    if (size !== undefined && size !== e.body_bytes) throw new ScorerError(`${what} records body ${e.body_sha256} at ${size} and ${e.body_bytes} bytes`);
    sizes.set(e.body_sha256, e.body_bytes!);
  }
  const bodiesDir = join(dir, BODIES_DIR);
  await mkdir(dir, { mode: 0o700 });
  await mkdir(bodiesDir, { mode: 0o700 });
  await writeFile(join(dir, CASSETTE_FILE), bytes, { flag: 'wx', mode: 0o444 });
  for (const digest of [...sizes.keys()].sort()) {
    const body = await readBlob(blobs, digest, `the body seq ${cassette.entries.find((e) => e.body_sha256 === digest)!.seq} of ${what} names`);
    if (body.byteLength !== sizes.get(digest)) throw new ScorerError(`the body ${digest} is ${body.byteLength} bytes in the blob store; ${what} records ${sizes.get(digest)}`);
    await writeFile(join(bodiesDir, digest), body, { flag: 'wx', mode: 0o444 });
  }
  // cassette.json and every body 0444 under directories 0555 whatever the umask (program.ts sealStaged, STAGED_READ_ONLY).
  await sealStaged(dir);
  return cassette;
}

/**
 * Write a trial's reference into `dir` (made here) from the blob store, read-only (the header):
 * cassette/, the trial's cassette and its bodies, and heat/, the heat's reference read and its bodies.
 * Both cassettes, parsed. ScorerError when the store cannot give back what the gateway recorded.
 */
export async function materializeScrapeReference(cassetteSha256: string, heatReferenceSha256: string, blobs: OutputBlobs, dir: string): Promise<{ trial: ScrapeCassetteT; heat: ScrapeCassetteT }> {
  await mkdir(dir, { mode: 0o700 });
  const trial = await materializeCassette(cassetteSha256, blobs, join(dir, SCRAPE_REFERENCE_CASSETTE_DIR), "the trial's cassette");
  const heat = await materializeCassette(heatReferenceSha256, blobs, join(dir, SCRAPE_REFERENCE_HEAT_DIR), "the heat's reference read");
  await chmod(dir, 0o555);
  return { trial, heat };
}

export interface ScrapeScoreOptions {
  sandbox: Sandbox;
  setup: ScrapeScorerSetup;
  /** The trial: its outputs (what the scorer reads at /output) and its cassette's digest. */
  trial: Pick<ScrapeTrialRecordT, 'outputs' | 'cassette_sha256'>;
  /** The heat's reference read: the cassette of the house's own read through the same gateway at heat start (every trial of the heat shares it). */
  heatReferenceSha256: string;
  /** Holds the outputs, both cassettes and their bodies (server/blobstore.ts BlobStore fits). */
  blobs: OutputBlobs;
  /** The bundle's limits, which the scorer runs under. */
  limits: LimitsT;
  /** A directory the scoring may use: its scratch is made in it and deleted after. */
  workDir: string;
}

export interface ScrapeScored {
  scores: ScrapeTrialScoresT;
  /** scores.json as the scorer wrote it, the same bytes on both runs: what scores_sha256 names (the caller keeps it in the blob store). */
  scores_json: Uint8Array;
  scores_sha256: string;
}

/**
 * Score one trial with the bundle's sealed scorer, twice (the header): the reference (the trial's
 * cassette and the heat's reference read) rebuilt once from the blob store and mounted read-only for
 * both runs, each run in a fresh directory. ScorerDisagreementError when the two scores.json differ by
 * a byte; ScorerError on any other scorer or reference fault.
 */
export async function scoreScrapeTrial(o: ScrapeScoreOptions): Promise<ScrapeScored> {
  const outputs = ProgramOutputs.parse(o.trial.outputs);
  const scratch = await mkdtemp(join(o.workDir, 'scrape-score-'));
  // Held (../grade.ts holdScratch, its header's Releasing): neither run's scorer scratch is released between the two
  // runs; the removal below, after both, releases the reference and both runs in one go, unless its caller holds a root above.
  holdScratch(scratch);
  try {
    const referenceDir = join(scratch, 'reference');
    await materializeScrapeReference(o.trial.cassette_sha256, o.heatReferenceSha256, o.blobs, referenceDir);
    const setup = scrapeProgramSetup(o.setup, referenceDir);
    const runs: Array<{ scores: ProgramScores; bytes: Uint8Array }> = [];
    for (const n of [1, 2]) {
      const dir = join(scratch, `run-${n}`);
      await mkdir(dir, { mode: 0o700 });
      // A checks.json beside scores.json is no part of a scrape verdict: a malformed one is dropped, never a fault (the header).
      const { scores } = await scoreProgramBreakdown({ sandbox: o.sandbox, setup, outputs, blobs: o.blobs, limits: o.limits, workDir: dir, label: 'scrape-scorer' });
      // The scorer run's scores directory (<workDir>/scores): the bytes it has just validated.
      runs.push({ scores, bytes: new Uint8Array(await readFile(join(dir, 'scores', SCORES_FILE))) });
    }
    const first = runs[0]!;
    const second = runs[1]!;
    if (!Buffer.from(first.bytes).equals(Buffer.from(second.bytes))) throw new ScorerDisagreementError(sha256(first.bytes), sha256(second.bytes));
    return { scores: scrapeTrialScores(first.scores), scores_json: first.bytes, scores_sha256: sha256(first.bytes) };
  } finally {
    await removeScratch(o.sandbox, scratch);
  }
}

/** A timed trial as grader/scrape/trial.ts leaves it: its trials-manifest fields but the verdict, and the harness's fault. */
export interface ScrapeTrialRun extends Omit<ScrapeTrialRecordT, 'status' | 'scores_sha256'> {
  /** The harness's fault, or null when the entry exited 0 within the cap with none: only then is its output scored. */
  fault: ScrapeFaultStatusT | null;
}

export interface JudgeScrapeTrialOptions extends Omit<ScrapeScoreOptions, 'trial'> {
  trial: ScrapeTrialRun;
}

/**
 * A trial's manifest record (contracts/scrape.ts ScrapeTrialRecord): a trial with no fault scored
 * twice (scoreScrapeTrial) and given the scorer's verdict and scores_sha256; one with a fault keeps it,
 * unscored (scored null, scores_sha256 null). A trial with no fault exited 0 (a RangeError otherwise:
 * the caller's).
 */
export async function judgeScrapeTrial(o: JudgeScrapeTrialOptions): Promise<{ record: ScrapeTrialRecordT; scored: ScrapeScored | null }> {
  const t = o.trial;
  if (t.fault !== null && !isScrapeFault(t.fault)) throw new RangeError(`${String(t.fault)} is not a harness fault: one of ${SCRAPE_FAULT_STATUSES.join(', ')}`);
  if (t.fault === null && t.exit !== 0) throw new RangeError(`${t.stage} round ${t.round} has no fault but exited ${String(t.exit)}: a non-zero exit is crashed, a signal a timeout`);
  const scored = t.fault === null ? await scoreScrapeTrial({ ...o, trial: t }) : null;
  const record = ScrapeTrialRecord.parse({
    round: t.round,
    stage: t.stage,
    position: t.position,
    status: scrapeTrialVerdict(t.fault, scored?.scores ?? null),
    wall_ns: t.wall_ns,
    exit: t.exit,
    outputs: t.outputs,
    cassette_sha256: t.cassette_sha256,
    scores_sha256: scored?.scores_sha256 ?? null,
  });
  return { record, scored };
}

// ---------------------------------------------------------------- integer arithmetic

/** The z quantile at 0.95 (two-sided 90%) in 10^-6: what the t quantile is past SCRAPE_T_MAX_DF degrees of freedom. */
export const SCRAPE_Z90_MICRO = 1_644_854n;

/** The last degrees of freedom SCRAPE_T90_MICRO lists. */
export const SCRAPE_T_MAX_DF = 60;

/**
 * Student's t at the 0.95 quantile (two-sided 90%), in 10^-6, keyed by degrees of freedom 1..60: each
 * the correctly rounded six-decimal value. 1..29 are grader/agent-score.ts T90_MICRO's;
 * tests/unit/grader-scrape-score.test.ts re-derives every one from the t distribution.
 */
export const SCRAPE_T90_MICRO: Readonly<Record<number, bigint>> = Object.freeze({
  ...T90_MICRO,
  30: 1_697_261n,
  31: 1_695_519n,
  32: 1_693_889n,
  33: 1_692_360n,
  34: 1_690_924n,
  35: 1_689_572n,
  36: 1_688_298n,
  37: 1_687_094n,
  38: 1_685_954n,
  39: 1_684_875n,
  40: 1_683_851n,
  41: 1_682_878n,
  42: 1_681_952n,
  43: 1_681_071n,
  44: 1_680_230n,
  45: 1_679_427n,
  46: 1_678_660n,
  47: 1_677_927n,
  48: 1_677_224n,
  49: 1_676_551n,
  50: 1_675_905n,
  51: 1_675_285n,
  52: 1_674_689n,
  53: 1_674_116n,
  54: 1_673_565n,
  55: 1_673_034n,
  56: 1_672_522n,
  57: 1_672_029n,
  58: 1_671_553n,
  59: 1_671_093n,
  60: 1_670_649n,
});

/** t(0.95, df) in 10^-6: the table through SCRAPE_T_MAX_DF, z beyond. df a whole number >= 1. */
export function scrapeT90Micro(df: number): bigint {
  if (!Number.isSafeInteger(df) || df < 1) throw new RangeError(`${df} degrees of freedom: a whole number, at least 1`);
  return df > SCRAPE_T_MAX_DF ? SCRAPE_Z90_MICRO : SCRAPE_T90_MICRO[df]!;
}

/** floor(√n) for n >= 0, exactly (Newton's method from above). */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError(`no square root of ${n}`);
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length >> 1) + 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** √(num / den) rounded to the nearest whole number, half to even, exactly; num >= 0, den > 0. */
export function sqrtHalfEven(num: bigint, den: bigint): bigint {
  if (num < 0n || den <= 0n) throw new RangeError('sqrtHalfEven takes num >= 0 and den > 0');
  // q = floor(√(num/den)) = isqrt(floor(num/den)); compare √(num/den) with q + 1/2 by squaring.
  const q = isqrt(num / den);
  const mid = (2n * q + 1n) * (2n * q + 1n) * den;
  const four = 4n * num;
  if (four > mid || (four === mid && q % 2n === 1n)) return q + 1n;
  return q;
}

// ---------------------------------------------------------------- the interval

/** What the interval reads of a listed trial (a void among them, counting for nothing). */
type TimedTrial = { status: ScrapeListedStatusT; wall_us: number };

/** A ranked run's trimmed sample, in integers: K trials, h = K - 2 trim kept, spread = K Σw² - (Σw)² over the winsorized sample (square microseconds times K). */
interface Trimmed {
  k: bigint;
  h: bigint;
  spread: bigint;
  /** The rank key, published (scrapeTimeUs). */
  centre: bigint;
}

/**
 * The run's trimmed sample (the header) over its trials that count (a listed void is none: contracts/scrape.ts
 * scrapeCountedTrials), or null when it is unranked. A run that keeps fewer than 2 trials has no interval (RangeError:
 * the caller's).
 */
function trimmed(listed: readonly TimedTrial[], trim: number): Trimmed | null {
  const trials = scrapeCountedTrials(listed);
  const centre = scrapeTimeUs(trials, trim);
  if (centre === null) return null;
  const k = trials.length;
  const h = k - 2 * trim;
  if (h < 2) throw new RangeError(`${k} trials with trim ${trim} keep ${h}: an interval needs at least 2 kept trials`);
  // Ranked, so at most `trim` failures: the +infinities sit among the `trim` slowest, and the
  // winsorized sample is all correct times (the (trim+1)-th slowest of K is the (k - trim)-th fastest).
  const c = trials
    .filter((t) => t.status === 'correct')
    .map((t) => BigInt(t.wall_us))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const low = c[trim]!;
  const high = c[k - trim - 1]!;
  let sum = BigInt(trim) * (low + high);
  let squares = BigInt(trim) * (low * low + high * high);
  for (let i = trim; i < k - trim; i++) {
    sum += c[i]!;
    squares += c[i]! * c[i]!;
  }
  return { k: BigInt(k), h: BigInt(h), spread: BigInt(k) * squares - sum * sum, centre };
}

/** Yuen's d = spread / (K h (h - 1)) as a fraction [numerator, denominator]. */
const yuenD = (s: Trimmed): [bigint, bigint] => [s.spread, s.k * s.h * (s.h - 1n)];

/** A Yuen interval in microseconds: the centre, the half-width, both ends, and the degrees of freedom t was taken at. */
export interface ScrapeIntervalUs {
  centre_us: bigint;
  half_us: bigint;
  low_us: bigint;
  high_us: bigint;
  df: number;
}

/**
 * Yuen's 90% interval of a run's trimmed mean (the header), or null when the run is unranked:
 * time_ms ± t(0.95, h - 1) √d, the half-width half-even to the microsecond.
 */
export function scrapeIntervalUs(trials: readonly TimedTrial[], trim: number): ScrapeIntervalUs | null {
  const s = trimmed(trials, trim);
  if (s === null) return null;
  const df = Number(s.h - 1n);
  const t = scrapeT90Micro(df);
  const [num, den] = yuenD(s);
  const half = sqrtHalfEven(t * t * num, 1_000_000_000_000n * den);
  return { centre_us: s.centre, half_us: half, low_us: s.centre - half, high_us: s.centre + half, df };
}

/** Two ranked runs' Yuen-Welch difference interval (scrapeDifference): a - b. */
export interface ScrapeDifferenceT {
  level: typeof SCRAPE_INTERVAL_LEVEL;
  /** time_ms of a minus time_ms of b: below 0 when a is the faster. */
  diff_ms: string;
  half_width_ms: string;
  low_ms: string;
  high_ms: string;
  /** The degrees of freedom t was taken at: Welch-Satterthwaite, floored; null when both winsorized variances are 0 (the half-width is 0). */
  df: number | null;
  /** The interval holds 0: a statistical tie. */
  tie: boolean;
  /** The interval lies wholly below 0: a is faster than b at 90% (the baseline gate, with b the baseline). */
  faster: boolean;
}

/**
 * The two-sample Yuen-Welch 90% interval of a's trimmed mean minus b's (the header), from each run's
 * listed trials and trim: (time_a - time_b) ± t(0.95, ν) √(d_a + d_b). Both runs ranked (a RangeError
 * otherwise: an unranked run has no trimmed mean to compare). A finalist is compared over all its
 * trials, as its time_ms is.
 */
export function scrapeDifference(a: Pick<ScrapePerformanceT, 'trials' | 'trim'>, b: Pick<ScrapePerformanceT, 'trials' | 'trim'>): ScrapeDifferenceT {
  const sa = trimmed(a.trials, a.trim);
  const sb = trimmed(b.trials, b.trim);
  if (sa === null || sb === null) throw new RangeError(`${sa === null ? 'the first' : 'the second'} run is unranked: a difference interval compares two ranked runs`);
  const [pa, qa] = yuenD(sa);
  const [pb, qb] = yuenD(sb);
  // d_a + d_b = (pa qb + pb qa) / (qa qb).
  const sumNum = pa * qb + pb * qa;
  let df: number | null = null;
  let half = 0n;
  if (sumNum > 0n) {
    const ha1 = sa.h - 1n;
    const hb1 = sb.h - 1n;
    // ν = (d_a + d_b)² / (d_a² / (h_a - 1) + d_b² / (h_b - 1)) = (pa qb + pb qa)² (h_a-1)(h_b-1) / (pa² qb² (h_b-1) + pb² qa² (h_a-1)).
    df = Number((sumNum * sumNum * ha1 * hb1) / (pa * pa * qb * qb * hb1 + pb * pb * qa * qa * ha1));
    const t = scrapeT90Micro(df);
    half = sqrtHalfEven(t * t * sumNum, 1_000_000_000_000n * qa * qb);
  }
  const diff = sa.centre - sb.centre;
  const low = diff - half;
  const high = diff + half;
  return {
    level: SCRAPE_INTERVAL_LEVEL,
    diff_ms: formatScrapeMillis(diff),
    half_width_ms: formatScrapeMillis(half),
    low_ms: formatScrapeMillis(low),
    high_ms: formatScrapeMillis(high),
    df,
    tie: low <= 0n && 0n <= high,
    faster: high < 0n,
  };
}

// ---------------------------------------------------------------- the performance

/** What the performance reads of a manifest's trial (contracts/scrape.ts ScrapeTrialRecord). */
export type ScrapeTrialTiming = Pick<ScrapeTrialRecordT, 'round' | 'stage' | 'status' | 'wall_ns'>;

/**
 * A run's scrape/v1 performance (contracts/scrape.ts ScrapePerformance) from its manifest's trials,
 * main then playoff in round order, and the heat's trim (the header). `stage` 'main' takes its main
 * trials alone (the main stage's standing, which the playoff is drawn from: never a finalist);
 * 'playoff', the default, every listed trial. A listed void (a re-judging's) is listed in it and left
 * out of its times, counts and trim, so the run is scored on its other rounds; voids that leave fewer
 * main trials to count than contracts/scrape.ts scrapeFewestCountedMain are the caller's (RangeError),
 * as any run out of shape. voids_rerun is the manifest's, as given.
 */
export function scrapePerformance(run: { trials: readonly ScrapeTrialTiming[]; voids_rerun: number }, trim: number, stage: ScrapeStageT = 'playoff'): ScrapePerformanceT {
  if (!Number.isSafeInteger(trim) || trim < 0) throw new RangeError(`trim ${trim}: a whole number of trials`);
  if (!Number.isSafeInteger(run.voids_rerun) || run.voids_rerun < 0) throw new RangeError(`${run.voids_rerun} void re-runs: a count`);
  const listed = stage === 'main' ? run.trials.filter((t) => t.stage === 'main') : run.trials;
  checkScrapeTrialOrder(listed, ['trials'], (path, message) => {
    throw new RangeError(`${path.join('.')}: ${message}`);
  });
  for (const t of listed) {
    if (!(SCRAPE_LISTED_STATUSES as readonly string[]).includes(t.status)) throw new RangeError(`${t.stage} round ${t.round}'s status ${String(t.status)} is not a scrape/v1 trial status`);
    if (!Number.isSafeInteger(t.wall_ns) || t.wall_ns < 0) throw new RangeError(`${t.stage} round ${t.round}'s wall_ns ${t.wall_ns}: whole nanoseconds`);
  }
  const main = listed.filter((t) => t.stage === 'main');
  const countedMain = scrapeCountedTrials(main).length;
  const fewest = scrapeFewestCountedMain(trim);
  if (countedMain < fewest) {
    throw new RangeError(`${countedMain} of its ${main.length} main trials count (${main.length - countedMain} void): under trim ${trim} a run is scored on at least ${fewest}`);
  }
  const trials = listed.map((t) => ({ round: t.round, stage: t.stage, status: t.status, wall_us: scrapeWallUs(t.wall_ns) }));
  const counted = scrapeCountedTrials(trials);
  const correct = counted.filter((t) => t.status === 'correct').length;
  const ms = (us: bigint | null) => (us === null ? null : formatScrapeMillis(us));
  const interval = scrapeIntervalUs(trials, trim);
  return ScrapePerformance.parse({
    kind: SCRAPE_HARNESS_KIND,
    trim,
    trials,
    scores: {
      time_ms: ms(scrapeTimeUs(trials, trim)),
      median_ms: ms(scrapeMedianUs(trials)),
      best_ms: ms(scrapeBestUs(trials)),
      correct_trials: correct,
      finalist: trials.some((t) => t.stage === 'playoff'),
    },
    interval: { level: SCRAPE_INTERVAL_LEVEL, low_ms: ms(interval?.low_us ?? null), high_ms: ms(interval?.high_us ?? null) },
    counts: { rounds: counted.length, correct, failed: counted.length - correct, voids_rerun: run.voids_rerun },
  });
}

// ---------------------------------------------------------------- the order

/** The rank key in microseconds, or null for an unranked run. */
const rankKey = (p: Pick<ScrapePerformanceT, 'scores'>): bigint | null => (p.scores.time_ms === null ? null : parseScrapeMillis(p.scores.time_ms));

/**
 * The scrape/v1 order (the header): below 0 when `a` ranks above `b`. Ranked runs before unranked
 * ones; among the ranked, finalists before every non-finalist whatever their times, each group by
 * time_ms ascending; among the unranked, finalists first. 0 on an exact tie: the caller breaks it (the
 * board by the earlier receipt).
 */
export function compareScrapeRuns(a: Pick<ScrapePerformanceT, 'scores'>, b: Pick<ScrapePerformanceT, 'scores'>): number {
  const ka = rankKey(a);
  const kb = rankKey(b);
  if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1;
  if (a.scores.finalist !== b.scores.finalist) return a.scores.finalist ? -1 : 1;
  if (ka === null || kb === null || ka === kb) return 0;
  return ka < kb ? -1 : 1;
}
