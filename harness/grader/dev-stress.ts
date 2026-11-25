// The dev stress job (server/jobs.ts `dev-stress`): after an eras dev grade is published, the entry is run once on
// each of the kit's `stress` block surrogates of the practice windows it was graded on, and what those copies say of
// the dev score is kept beside it (dev_stress, server/db/schema.ts). One dev window is a small sample, and most of a
// pump bot's PnL comes from a few coins; rebuilding the windows with blocks of OTHER coins' recorded flow
// (collector/surrogate.ts blockDataset) shows how much of the score is the windows' own luck.
//
//   enqueueDevStress    the publish stage's side (server/pipeline/index.ts): a finished eras dev grade run whose
//                       bundle sets practice_windows.stress gets its dev_stress row (`pending`, one per run) and a
//                       dev-stress job under devStressJobId
//   createDevStressHandler(deps)   the job's handler (PipelineHandlers.devStress); createDevStressRunner is its body
//
// The job, for one grade run:
//
//   skipped      the submission is no longer its entrant's newest dev submission (a later one is in, so nobody reads
//                this one's stress: no copy is built, no entry run), or the bundle sets no stress after all
//   wait         while a scrape/v1 heat holds this host's lease under the `host` lease scope (MAKEFUN_SCRAPE_LEASE_SCOPE's
//                default: grader/worker.ts scrapeLeaseScopeOf) the job runs nothing beside it: it hands itself on to
//                the next recheck slot (devStressWaitJobId), spending none of its own expiry. Under `egress` it does
//                not wait: the heat keeps only other heats off the egress, its pods reserving their CPU instead
//   copies       copy i of the m asked for is dealt to window i mod N as that window's copy floor(i / N)
//                (server/entries/stress.ts stressDraw), under the public seed stressSeed(window sha256, copy). It is
//                built ONCE per (window dataset sha256, copy) and shared by every entry: at
//                <dataDir>/stress/<seed>/dataset (with report.json beside it), built into a temp directory of the same
//                parent and renamed into place, so a reader sees all of it or none (a second builder that loses the
//                rename takes the winner's). A copy found there is used after a digest check (its report's output
//                digest is its manifest's canonical sha256, its source digest the window's); one that fails it is
//                removed and rebuilt once. An entry never builds its own copy. Off the data claim (DevStressDeps.mirror:
//                the tier mirror, grader/worker.ts `mirror`) the window's dataset directory is copied from the tier
//                before a build reads it (missing after a memoized copy, copied once more; the job's signal riding the
//                copy, so a stopped attempt's wait on the tier ends with the abort's reason), and the copies land under
//                the grader's own data directory (its emptyDir), one store per grader
//   runs        the entry's snapshot materialized in the job's own scratch (DEV_STRESS_SCRATCH_PREFIX, owned by the
//                job so its retry removes what a dead grader left), run once on each copy by grader/hindsight-audit.ts
//                runOnWindow under the window's own hello seed (the run_era row's) and its public fail key, one
//                copy at a time, the run held to the copy's digest again (runOnWindow reads every file against it).
//                Each run first waits in the handler for a replay place (grader/replay-places.ts: its sim engine steps
//                on this process's main thread, as a replay grade's does), held for that run alone and given back
//                as it ends; the wait is said once a run, and the attempt's signal ends it
//   secrets      every copy runs the entry with the env-lane entry secrets its grade ran with: exactly the rows the
//                run recorded (run.entry_secret_ids), re-opened as an L2 re-opens them (grader/worker.ts
//                recordedEnvSecrets, with DevStressDeps.entrySecrets' seal), so an entry that needs one runs on the
//                copies as it ran on the windows. One erased since (replaced, deleted or purged) cannot run it as it
//                was graded: a PermanentJobError naming it by NAME and row (the row `failed`), nothing run; one this
//                grader cannot open is a retryable Error, nothing run. Every form of every value is masked out of
//                what a run says (runOnWindow) and redacted out of whatever it throws (grade.ts redactThrown), so
//                no row, record or log line holds one
//   layout       the copies run on the layout the grade ran on, by its run's flag (grader/worker.ts `layout`), never the
//                table: a run flagged ONE_POD_FLAG on the one-pod view (DevStressDeps.onePod's host; its scratch reaped
//                and removed through the view, whose removeTree is the base's: every member's tree came back as the
//                grader's own, so the grader deletes it itself, no pod), an unflagged one on the grader's sandbox as
//                before. A flagged run in a process that cannot host the view (onePodHostOf) is
//                the platform's fault (PlatformFaultError, one plain sentence), nothing run, never run on `split`
//   record       server/entries/stress.ts summarizeStress over the runs against the dev score (the run's own: the
//                median window's net PnL), stored canonical as a blob (stressRecordDigest) and named by
//                dev_stress.record_sha256, with the figures copied onto the row. It equals `makefun grade-local
//                --stress`'s record of the same copies and snapshot (cli/stress.ts stressRecordOf: the CLI's JSON
//                less each run's wall_ms)
//   dead         a PermanentJobError (a window dataset gone, a copy that cannot be built, a run that is no grade, a
//                secret the run ran with erased) or
//                a throw on the job's last attempt (server/jobs.ts isLastAttempt) marks the row `failed` with the
//                error, then stands as the job's own
//   newer bundle a competition bundle a newer release wrote (a key this release's strict contract does not know,
//                nothing else wrong: server/release-skew.ts parseStored) is never "no bundle that validates": its
//                NewerReleaseRowError hands the job back for a process of that release (server/jobs.ts `a newer
//                release's row`), on its last attempt too, the row left as it is; the publish stage's enqueue likewise
//                throws it, so the publish job is handed back rather than queueing no stress
//
// The module reads the grader's helpers from worker.ts (a one-way import: worker.ts imports nothing from here), and
// server/pipeline/index.ts takes createDevStressHandler from here.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq, ne } from 'drizzle-orm';
import { blockDataset, SurrogateError } from '../collector/surrogate.ts';
import { MANIFEST_FILE } from '../collector/manifest.ts';
import { CompetitionBundle } from '../contracts/competition.ts';
import { Score } from '../contracts/score.ts';
import type { BlobStore } from '../server/blobstore.ts';
import type { Db } from '../server/db/client.ts';
import { competition, devStress, phase, run, submission } from '../server/db/schema.ts';
import { CHEAT_CHECK } from '../server/entries/hindsight.ts';
import { stressDraw, stressRecordDigest, summarizeStress, type StressRecord, type StressRun } from '../server/entries/stress.ts';
import { assertHeld, devStressJobId, devStressWaitJobId, handsBackNewerRelease, isLastAttempt, isStaleAttempt, PermanentJobError, type JobContext, type JobHandler, type JobPayload, type JobQueue } from '../server/jobs.ts';
import { parseStored } from '../server/release-skew.ts';
import { materializeSnapshot, readSnapshotIndex, removeMaterialized } from '../server/repos/index-tar.ts';
import { canonicalSha256 } from '../sim/canonical.ts';
import { publicFailKey } from '../sim/rng.ts';
import { redactThrown, removeScratch, releaseScratch, stoppableSandbox } from './grade.ts';
import { blockOptionsOf, runOnWindow, surrogateDirName, surrogateKey, type WindowRun } from './hindsight-audit.ts';
import { loadEras, type EraRow } from './record.ts';
import { ownedScratch, reapScratch, storedRunLayout } from './regrade.ts';
import { processReplayPlaces, refusalWords, type ReplayPlaces } from './replay-places.ts';
import { entrySecretForms } from './run.ts';
import type { Sandbox } from './sandbox/types.ts';
import { PROJECT_ROOT } from './version.ts';
import {
  datasetMirrorOf,
  entryRuntime,
  entrySecretSealOf,
  mirrorBefore,
  onePodHostOf,
  practiceWindowsOf,
  recordedEnvSecrets,
  regradeOwner,
  SCRAPE_HOST_RECHECK_MS,
  scrapeHostHeldBy,
  scrapeHostRecheckSlot,
  scratchReapLine,
  storedEraWindows,
  type AgentEntrySecretDeps,
  type EraWindow,
  type GraderMirror,
  type HindsightJobContext,
  type MirrorCall,
  type OnePodDeps,
  type ScrapeWorkerDeps,
} from './worker.ts';

/**
 * The prefix of a dev stress job's scratch under the work root: `devstress-<owner>-XXXXXX`, its owner the job's
 * (regradeOwner of the job's id; regrade.ts ownedScratch), which the job's next attempt removes should its grader die
 * (regrade.ts reapScratch), and the workers' start (server/pipeline/index.ts sweepDeadWork) only once no active
 * dev-stress job holds it, as a hindsight audit's (grader/worker.ts HINDSIGHT_SCRATCH_PREFIX).
 */
export const DEV_STRESS_SCRATCH_PREFIX = 'devstress-';

/** The directory of the shared copies under the data directory: <dataDir>/stress/<seed>/. */
export const STRESS_DIR_NAME = 'stress';

/** A copy being built lives in `.tmp-XXXXXX` beside the finished ones; one this old was left by a builder that died (the job's expiry, 4 h, and a margin). */
export const STALE_BUILD_MS = 6 * 3600 * 1000;

export interface DevStressDeps {
  db: Db;
  blobs: BlobStore;
  sandbox: Sandbox;
  /** Existing directory for each job's scratch directory (the entry's snapshot, once per run). */
  workRoot: string;
  /** Where a held job hands itself on. */
  jobs: Pick<JobQueue, 'send'>;
  /** The data directory whose `stress/` holds the shared copies (default <project root>/.data, the datasets' parent). */
  dataDir?: string;
  /** A relative dataset path resolves against this (default the project root, as the grader's dataset loader). */
  datasetRoot?: string;
  /**
   * The tier mirror (grader/worker.ts GradeWorkerDeps.mirror; the header's `copies`): off the claim, a window's dataset
   * directory is copied from the tier before a copy of it is built. Absent: the claim is the directory.
   */
  mirror?: GraderMirror;
  /** The host's scrape lease, which a stress runs nothing beside under its `host` scope (default scrapeLeaseDirFromEnv() and scrapeLeaseScopeFromEnv(), as GradeWorkerDeps.scrape's). */
  scrape?: Pick<ScrapeWorkerDeps, 'leaseDir' | 'leaseScope'>;
  /** The block surrogate builder (default collector/surrogate.ts blockDataset); a test counts its calls. */
  build?: typeof blockDataset;
  /** One run of the entry on one frozen window (default grader/hindsight-audit.ts runOnWindow). */
  runWindow?: typeof runOnWindow;
  /**
   * How the job re-opens the env-lane entry secrets the run recorded (the header's `secrets`): the grader's seal settings,
   * whose private keys open them (default the environment's, as GradeWorkerDeps.entrySecrets; read only for a run that
   * recorded some).
   */
  entrySecrets?: Pick<AgentEntrySecretDeps, 'seal'>;
  /**
   * The sandbox layout's inputs (grader/worker.ts `layout`; the pipeline's onePodBootOf): the copies run on the run's own
   * layout (the header's `layout`), so only `host` is read. Absent or null: an unflagged run as ever, a flagged one refused
   * as the platform's fault.
   */
  onePod?: OnePodDeps;
  /** The replay places each copy's run waits for (the header's `runs`; default the process's own, processReplayPlaces); a test's. */
  replayPlaces?: ReplayPlaces;
  now?: () => Date;
  log?: (line: string) => void;
}

/** What one dev-stress job did (the handler logs it; tests read it). */
export type DevStressOutcome =
  | {
      kind: 'finished';
      run_id: string;
      submission_id: string;
      record: StressRecord;
      record_sha256: string;
      /** Copies this job built, and copies it found built (and verified) already. */
      built: number;
      reused: number;
    }
  | { kind: 'skipped'; why: string }
  /** The run's stress is recorded already (a retry after the record was written, or a second send): nothing was done. */
  | { kind: 'kept'; run_id: string }
  | { kind: 'waiting'; run_id: string; until: Date; job_id: string | null; held_by: string };

type SubmissionRow = typeof submission.$inferSelect;
type DevStressRow = typeof devStress.$inferSelect;

async function one<T>(rows: Promise<T[]>, what: string): Promise<T> {
  const [row] = await rows;
  if (row === undefined) throw new PermanentJobError(`${what} does not exist`);
  return row;
}

// ---------------------------------------------------------------- the publish stage's side

/**
 * A finished eras dev grade run's dev stress, queued: its dev_stress row (`pending`, m the bundle's
 * practice_windows.stress; one per run) and the dev-stress job under devStressJobId (one per run: sent again by a
 * retried publish, it queues nothing twice). Null, and nothing queued, for a run that is no finished grade on a dev
 * phase with practice windows, or whose bundle sets no stress.
 */
export async function enqueueDevStress(deps: { db: Db; jobs: Pick<JobQueue, 'send'> }, runId: string): Promise<{ run_id: string; m: number; job_id: string | null } | null> {
  const { db } = deps;
  const [r] = await db.select().from(run).where(eq(run.id, runId));
  if (r === undefined || r.kind !== 'grade' || r.status !== 'finished') return null;
  const [ph] = await db.select().from(phase).where(eq(phase.id, r.phaseId));
  if (ph === undefined || ph.key !== 'dev') return null;
  const [comp] = await db.select({ slug: competition.slug, bundle: competition.bundle }).from(competition).where(eq(competition.id, ph.competitionId));
  // A bundle a newer release wrote is not read as none (the header's `newer bundle`): NewerReleaseRowError, so the
  // publish job that queues this is handed back for that release, never left with no stress queued.
  const bundle = comp?.bundle == null ? null : parseStored(CompetitionBundle, comp.bundle, `competition ${comp.slug}'s stored bundle`);
  if (bundle === null || !bundle.success) return null;
  const m = practiceWindowsOf(bundle.data, 'dev')?.windows.stress;
  if (m === undefined) return null;
  await db.insert(devStress).values({ submissionId: r.submissionId, phaseId: r.phaseId, runId: r.id, m }).onConflictDoNothing({ target: devStress.runId });
  const job_id = await deps.jobs.send('dev-stress', { submission_id: r.submissionId, run_id: r.id }, { id: devStressJobId(r.id) });
  return { run_id: r.id, m, job_id };
}

// ---------------------------------------------------------------- the shared copies

/** Where copy `seed` lives under `stressDir`: its dataset directory and its preservation report. */
export function copyPaths(stressDir: string, seed: string): { home: string; dataset: string; report: string } {
  const home = join(stressDir, seed);
  return { home, dataset: join(home, 'dataset'), report: join(home, 'report.json') };
}

/** One block surrogate of a window, ready to run on. */
export interface SharedCopy {
  /** The copy's frozen dataset directory. */
  dir: string;
  /** Its manifest's canonical sha256 (the report's output_dataset_sha256): what a run reads it against. */
  sha256: string;
  /** Whether this call built it. */
  built: boolean;
}

/**
 * The copy under `home` when it is whole and is the copy of `windowSha256`: its report parses, names that window as its
 * source, and its output digest is the canonical sha256 of the manifest beside it. Null when it is absent or fails any.
 */
async function verifiedCopy(paths: ReturnType<typeof copyPaths>, windowSha256: string): Promise<{ sha256: string } | null> {
  try {
    const report: unknown = JSON.parse(await readFile(paths.report, 'utf8'));
    if (typeof report !== 'object' || report === null) return null;
    const { source_dataset_sha256: source, output_dataset_sha256: output } = report as Record<string, unknown>;
    if (source !== windowSha256 || typeof output !== 'string') return null;
    const manifest: unknown = JSON.parse(await readFile(join(paths.dataset, MANIFEST_FILE), 'utf8'));
    return canonicalSha256(manifest) === output ? { sha256: output } : null;
  } catch {
    return null;
  }
}

/** The leftovers of builders that died: `.tmp-*` directories of `stressDir` not touched for STALE_BUILD_MS. */
async function sweepStaleBuilds(stressDir: string, atMs: number): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(stressDir)).filter((n) => n.startsWith('.tmp-'));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(stressDir, name);
    try {
      if (atMs - (await stat(dir)).mtimeMs > STALE_BUILD_MS) await rm(dir, { recursive: true, force: true });
    } catch {
      // Another job's sweep got it first, or it is not ours to remove: left for the next one.
    }
  }
}

export interface SharedCopyRequest {
  /** <dataDir>/stress. */
  stressDir: string;
  /** stressSeed(windowSha256, copy). */
  seed: string;
  /** The window's frozen dataset directory and its digest (the dataset row's sha256). */
  windowDir: string;
  windowSha256: string;
  /** The window's copy number (stressDraw's `copy`): the copy's manifest id is blocks-<copy + 1>. */
  copy: number;
  build?: typeof blockDataset;
  /** The window's copy from the tier (worker.ts datasetMirrorOf of DevStressDeps.mirror), run only before a build; null or absent, none. */
  mirrorWindow?: MirrorCall | null;
  /** The job attempt's signal: it rides the window's copy, so a stopped attempt's wait on the tier ends with the abort's reason, nothing built. */
  signal?: AbortSignal;
  now?: () => Date;
}

/**
 * The block surrogate of a window that `seed` draws: the copy under <stressDir>/<seed>/ when it is there and verifies,
 * else built (blockOptionsOf CHEAT_CHECK, the options grade-local --stress builds with) into a temp directory beside it
 * and renamed into place. A copy that is there and fails its check is removed and built again; a rename lost to another
 * builder takes theirs (which must verify). A PermanentJobError when the window cannot be rebuilt (a SurrogateError: the
 * dataset on disk is not the window's, or has nothing to draw blocks from).
 */
export async function sharedCopy(o: SharedCopyRequest): Promise<SharedCopy> {
  const paths = copyPaths(o.stressDir, o.seed);
  const found = await verifiedCopy(paths, o.windowSha256);
  if (found !== null) return { dir: paths.dataset, sha256: found.sha256, built: false };
  // The window, off the claim, copied from the tier before it is read: missing after a memoized copy, copied once more.
  await mirrorBefore(o.mirrorWindow ?? null, () => existsSync(o.windowDir), o.signal);
  const build = o.build ?? blockDataset;
  const name = surrogateDirName('blocks', o.copy);
  await mkdir(o.stressDir, { recursive: true });
  await sweepStaleBuilds(o.stressDir, (o.now ?? (() => new Date()))().getTime());
  await rm(paths.home, { recursive: true, force: true });
  const tmp = await mkdtemp(join(o.stressDir, '.tmp-'));
  try {
    let sha256: string;
    try {
      const built = build(o.windowDir, join(tmp, 'dataset'), { key: surrogateKey('blocks', o.seed), seed: o.seed, id: name, reportFile: join(tmp, 'report.json'), ...blockOptionsOf(CHEAT_CHECK) });
      if (built.report.source_dataset_sha256 !== o.windowSha256) {
        throw new PermanentJobError(`the window dataset at ${o.windowDir} has digest ${built.report.source_dataset_sha256}, not the ${o.windowSha256} its row names`);
      }
      sha256 = built.report.output_dataset_sha256;
    } catch (err) {
      if (err instanceof SurrogateError) throw new PermanentJobError(`block surrogate ${name} (seed ${o.seed}) of window ${o.windowSha256} cannot be built: ${err.message}`, { cause: err });
      throw err;
    }
    try {
      await rename(tmp, paths.home);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw err;
      const won = await verifiedCopy(paths, o.windowSha256);
      if (won === null) throw new Error(`block surrogate ${name} (seed ${o.seed}): ${paths.home} appeared while it was built and does not verify`);
      return { dir: paths.dataset, sha256: won.sha256, built: false };
    }
    return { dir: paths.dataset, sha256, built: true };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the job

/**
 * `run` holding a place of `places` (the header's `runs`): waited for first (ReplayPlaces.wait, every `pollMs`; `signal`
 * ends the wait with its reason, `run` never called and no place held), given back as `run` settles, however it
 * settles. `say` hears, under `what`, that it waits (the refusal's words) and, once in, how long it waited.
 */
export async function withReplayPlace<T>(places: ReplayPlaces, o: { what: string; say: (line: string) => void; signal?: AbortSignal; pollMs?: number }, run: () => Promise<T>): Promise<T> {
  const from = Date.now();
  let waited = false;
  const place = await places.wait({
    ...(o.signal === undefined ? {} : { signal: o.signal }),
    ...(o.pollMs === undefined ? {} : { pollMs: o.pollMs }),
    onWait: (refused) => {
      waited = true;
      o.say(`${o.what} waits for a replay place on this grader (${refusalWords(refused)})`);
    },
  });
  if (waited) o.say(`${o.what} has its replay place after ${Date.now() - from} ms (${place.inFlight} replays in flight here)`);
  try {
    return await run();
  } finally {
    place.release();
  }
}

/** The dev score of a grade run: the net PnL of its (median window's) replay score, or null for any other. */
function devNetOf(r: Pick<typeof run.$inferSelect, 'status' | 'result'>): string | null {
  if (r.status !== 'finished') return null;
  const score = Score.safeParse(r.result);
  return score.success && score.data.performance.kind === 'pumpfun-replay/v2' ? score.data.performance.metrics.net_pnl_lamports : null;
}

/**
 * The newest other submission of the entrant (same competition and user) received after `sub` and still in play: not a
 * baseline, not cancelled or failed (a refused duplicate snapshot is a failed one), as server/entries/facts.ts reads
 * it: a later entry supersedes from the moment it is accepted. A baseline is never superseded (the house enters one per
 * bot). Its id, or null.
 */
async function newerSubmissionOf(db: Db, sub: SubmissionRow): Promise<string | null> {
  if (sub.baseline) return null;
  const mine = await db
    .select({ id: submission.id, createdAt: submission.createdAt, status: submission.status })
    .from(submission)
    .where(and(eq(submission.competitionId, sub.competitionId), eq(submission.userId, sub.userId), eq(submission.baseline, false), ne(submission.id, sub.id)));
  let newest: { id: string; createdAt: Date } | null = null;
  for (const o of mine) {
    if (o.status === 'cancelled' || o.status === 'failed') continue;
    const later = o.createdAt.getTime() !== sub.createdAt.getTime() ? o.createdAt.getTime() > sub.createdAt.getTime() : o.id > sub.id;
    if (later && (newest === null || o.createdAt.getTime() > newest.createdAt.getTime())) newest = o;
  }
  return newest?.id ?? null;
}

/** The handler's body, answering what it did. */
export function createDevStressRunner(deps: DevStressDeps): (data: JobPayload<'dev-stress'>, ctx: HindsightJobContext) => Promise<DevStressOutcome> {
  const { db, blobs } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const root = deps.datasetRoot ?? PROJECT_ROOT;
  const stressDir = join(deps.dataDir ?? join(PROJECT_ROOT, '.data'), STRESS_DIR_NAME);
  const runWindow = deps.runWindow ?? runOnWindow;
  const sealOf = entrySecretSealOf(deps);

  /** The row's end: `status` (skipped or failed) with why. A finished row is never moved. */
  const settle = async (runId: string, status: 'skipped' | 'failed', why: string): Promise<void> => {
    const at = now();
    const [row] = await db.select({ startedAt: devStress.startedAt }).from(devStress).where(eq(devStress.runId, runId));
    await db
      .update(devStress)
      .set({ status, error: why, startedAt: row?.startedAt ?? at, finishedAt: at })
      .where(and(eq(devStress.runId, runId), ne(devStress.status, 'finished')));
  };

  const stressOne = async (data: JobPayload<'dev-stress'>, ctx: HindsightJobContext): Promise<DevStressOutcome> => {
    const sub = await one(db.select().from(submission).where(eq(submission.id, data.submission_id)), `submission ${data.submission_id}`);
    const r = await one(db.select().from(run).where(eq(run.id, data.run_id)), `run ${data.run_id}`);
    if (r.submissionId !== sub.id || r.kind !== 'grade') throw new PermanentJobError(`run ${r.id} is not a grade run of submission ${sub.id}`);
    // The run's own layout (the header's `layout`): a flagged run's copies on the one-pod view, refused where nothing can
    // host it (the platform's fault), before anything is reaped, built or run; an unflagged one's on the grader's sandbox.
    const sandbox: Sandbox =
      storedRunLayout(r) === 'pod' ? onePodHostOf(deps.onePod, `the dev stress of run ${r.id} (submission ${sub.id}, job ${ctx.id})`).view() : deps.sandbox;
    // The job's owner, the same on each of its attempts: before anything else is made, what an attempt of it that died left goes.
    const owner = regradeOwner(ctx.id);
    const reaped = scratchReapLine(
      `the dev stress of run ${data.run_id} (submission ${data.submission_id}, job ${ctx.id})`,
      `attempt ${(ctx.retryCount ?? 0) + 1}`,
      await reapScratch(sandbox, deps.workRoot, DEV_STRESS_SCRATCH_PREFIX, owner),
      'dev-stress',
    );
    if (reaped !== null) log(reaped);
    const ph = await one(db.select().from(phase).where(eq(phase.id, r.phaseId)), `phase ${r.phaseId}`);
    const comp = await one(db.select().from(competition).where(eq(competition.id, ph.competitionId)), `competition ${ph.competitionId}`);
    // A bundle a newer release wrote throws NewerReleaseRowError (the header's `newer bundle`), never this refusal.
    const parsed = comp.bundle === null ? null : parseStored(CompetitionBundle, comp.bundle, `competition ${comp.slug}'s stored bundle`);
    if (parsed === null || !parsed.success) throw new PermanentJobError(`competition ${comp.slug} has no bundle that validates`);
    const bundle = parsed.data;
    const practice = ph.key === 'dev' ? practiceWindowsOf(bundle, 'dev') : null;
    if (practice === null) throw new PermanentJobError(`run ${r.id} is not on the dev phase of a replay competition with practice windows`);
    const asked = practice.windows.stress;
    if (asked === undefined) return { kind: 'skipped', why: `the dev phase of ${comp.slug} sets no stress runs` };

    // The run's row (made when its grade was published; made here when a job came without one).
    await db.insert(devStress).values({ submissionId: sub.id, phaseId: ph.id, runId: r.id, m: asked }).onConflictDoNothing({ target: devStress.runId });
    const row: DevStressRow = await one(db.select().from(devStress).where(eq(devStress.runId, r.id)), `dev_stress of run ${r.id}`);
    if (row.status === 'finished') return { kind: 'kept', run_id: r.id };
    const m = row.m;

    const newer = await newerSubmissionOf(db, sub);
    if (newer !== null) {
      const why = `submission ${sub.id} is no longer its entrant's newest: submission ${newer} came in after it`;
      await settle(r.id, 'skipped', why);
      log(`[dev-stress] ${ctx.id}: run ${r.id} skipped: ${why}`);
      return { kind: 'skipped', why };
    }

    // While a scrape heat holds this host under the `host` lease scope, the stress runs nothing beside it: handed on to the
    // next recheck slot (under `egress` scrapeHostHeldBy is null).
    const heldBy = await scrapeHostHeldBy(deps);
    if (heldBy !== null) {
      const slot = scrapeHostRecheckSlot(now().getTime());
      const until = new Date(slot * SCRAPE_HOST_RECHECK_MS);
      const jobId = await deps.jobs.send('dev-stress', data, { id: devStressWaitJobId(r.id, slot), startAfter: until });
      log(`[dev-stress] ${ctx.id}: the stress of run ${r.id} waits for ${until.toISOString()}: ${heldBy}, and nothing else grades here while a heat runs`);
      return { kind: 'waiting', run_id: r.id, until, job_id: jobId, held_by: heldBy };
    }

    const devNet = devNetOf(r);
    if (devNet === null) throw new PermanentJobError(`run ${r.id} is ${r.status} with no replay score: only a finished run is stressed`);
    const eraRows: EraRow[] = await loadEras(db, r.id);
    if (eraRows.length === 0) throw new PermanentJobError(`run ${r.id} graded no practice windows (no run_era rows): there is nothing to rebuild`);
    const unfinished = eraRows.find((e) => e.status !== 'finished');
    if (unfinished !== undefined) throw new PermanentJobError(`run ${r.id}'s window ${unfinished.windowKey} is ${unfinished.status}, not finished`);
    const windows: EraWindow[] = await storedEraWindows(db, eraRows);
    if (sub.snapshotSha256 === null) throw new PermanentJobError(`submission ${sub.id} has no snapshot`);
    const index = await readSnapshotIndex(blobs, sub.snapshotSha256);
    const picked = entryRuntime(index, practice.harness.runtimes);
    if ('error' in picked) throw new PermanentJobError(`submission ${sub.id}: ${picked.error}`);
    // The env-lane entry secrets its grade ran the entry with, re-opened (the header's `secrets`): every copy runs it as
    // it was graded, or none does.
    const recorded = await recordedEnvSecrets(db, sealOf, { userId: sub.userId, competitionId: comp.id }, r.entrySecretIds);
    if (recorded.erased !== null) {
      throw new PermanentJobError(`run ${r.id} ran the entry with an env-lane entry secret that is erased since (replaced, deleted or purged): ${recorded.erased}, so no copy can run it as it was graded`);
    }
    if (recorded.kind === 'unopened') {
      throw new Error(`run ${r.id}: the env-lane entry secrets it ran the entry with cannot be opened here, so no copy runs it without them (the job tries again): ${recorded.why}`);
    }
    const secrets = recorded.secrets.ids.length === 0 ? {} : { secrets: recorded.secrets.env };
    const forms = entrySecretForms(recorded.secrets.env);

    const startedAt = now();
    await db
      .update(devStress)
      .set({ status: 'running', startedAt, finishedAt: null, error: null })
      .where(and(eq(devStress.runId, r.id), ne(devStress.status, 'finished')));

    const signal = ctx.signal;
    signal?.throwIfAborted();
    const several = windows.length > 1;
    const shas = windows.map((w) => w.ds.sha256);
    const runs: StressRun[] = [];
    let built = 0;
    let reused = 0;
    const dir = await ownedScratch(deps.workRoot, DEV_STRESS_SCRATCH_PREFIX, owner);
    const botDir = join(dir, 'bot');
    // The job's scratch, removed once its runs ended, released from the sandbox's daemon once the record is kept, or it
    // threw (grade.ts releaseScratch, its header's Releasing): a release never stands between the stress and its record.
    const removed: string[] = [];
    try {
      try {
        for (let i = 0; i < m; i += 1) {
          signal?.throwIfAborted();
          const draw = stressDraw(shas, i);
          const w = windows[draw.window]!;
          const windowDir = resolve(root, w.ds.path);
          const copy = await sharedCopy({ stressDir, seed: draw.seed, windowDir, windowSha256: w.ds.sha256, copy: draw.copy, build: deps.build, mirrorWindow: datasetMirrorOf(deps.mirror, windowDir), ...(signal === undefined ? {} : { signal }), now });
          if (copy.built) built += 1;
          else reused += 1;
          // Its replay place (the header's `runs`): waited for here, the copy's run its only holder.
          const result: WindowRun = await withReplayPlace(deps.replayPlaces ?? processReplayPlaces(), { what: `[dev-stress] ${ctx.id}: run ${r.id} copy ${i + 1}/${m}`, say: log, ...(signal === undefined ? {} : { signal }) }, async () => {
            try {
              await materializeSnapshot(index, blobs, botDir);
              return await runWindow({
                // Bound to the signal (grade.ts stoppableSandbox): its abort kills the replay running, and no later one starts.
                sandbox: stoppableSandbox(sandbox, signal),
                runtime: picked.runtime,
                botDir,
                harness: practice.harness,
                limits: bundle.limits,
                dataset: copy.dir,
                expectSha256: copy.sha256,
                seed: w.seed,
                failKey: publicFailKey(w.seed),
                label: `stress-${surrogateDirName('blocks', draw.copy)}`,
                imageDigest: r.imageDigest,
                ...secrets,
              });
            } finally {
              await removeMaterialized(botDir).catch(() => undefined);
            }
          });
          runs.push({ index: i, seed: draw.seed, ...(several ? { window: w.key } : {}), status: result.status, net_pnl_lamports: result.net_pnl_lamports });
          log(`[dev-stress] ${ctx.id}: run ${r.id} copy ${i + 1}/${m} (${w.key}, ${copy.built ? 'built' : 'reused'}): ${result.net_pnl_lamports === null ? result.status : `net PnL ${result.net_pnl_lamports} lamports`}`);
        }
      } catch (err) {
        // Given up: whatever the stopped run threw is the stop's doing, so the signal's reason (retried, never permanent).
        if (signal?.aborted === true) throw signal.reason;
        // Whatever else it threw says none of the secrets it ran with (the header's `secrets`): the row's error is its words.
        throw redactThrown(err, forms);
      } finally {
        await removeScratch(sandbox, dir, removed);
      }
      // An attempt given up records nothing, however far it got (a killed replay reads as a failed copy).
      signal?.throwIfAborted();
      const record = summarizeStress(runs, devNet, windows.length);
      const digest = stressRecordDigest(record);
      const put = await blobs.put(digest.json);
      if (put.sha256 !== digest.sha256) throw new Error(`the stress record's blob ${put.sha256} is not its digest ${digest.sha256}`);
      // Its claim read last (server/jobs.ts JobContext.assertHeld): a stale attempt, whose killed replays read as failed
      // copies, finishes no row beside the attempt that holds the job.
      await assertHeld(ctx, `run ${r.id}'s dev stress`);
      await db
        .update(devStress)
        .set({
          status: 'finished',
          medianLamports: record.median_lamports,
          p10Lamports: record.p10_lamports,
          p90Lamports: record.p90_lamports,
          belowZero: record.below_zero,
          failed: record.failed,
          devRank: record.dev_rank,
          recordSha256: digest.sha256,
          error: null,
          finishedAt: now(),
        })
        .where(and(eq(devStress.runId, r.id), ne(devStress.status, 'finished')));
      log(`[dev-stress] ${ctx.id}: run ${r.id}: ${m} copies (${built} built, ${reused} reused): the dev score is above ${record.dev_rank} of ${m - record.failed}; record ${digest.sha256}`);
      return { kind: 'finished', run_id: r.id, submission_id: sub.id, record, record_sha256: digest.sha256, built, reused };
    } finally {
      await releaseScratch(sandbox, removed);
    }
  };

  return async (data, ctx) => {
    try {
      return await stressOne(data, ctx);
    } catch (err) {
      // Dying for good (pg-boss retries it no more): the row says so, then the job's own error stands. A stale attempt
      // (isStaleAttempt: its claim lost) did not die: the attempt that holds the job settles the row. Nor did one the queue
      // hands back for a newer release's row (server/jobs.ts handsBackNewerRelease), on its last attempt too: the row
      // stays as it is for the attempt of that release.
      if (handsBackNewerRelease(ctx, err)) {
        log(`[dev-stress] ${ctx.id}: run ${data.run_id}'s stress met a stored value a newer release wrote (${err instanceof Error ? err.message : String(err)}): not a death, so its row is left as it is; the job is handed back for a process of that release`);
      } else if (isStaleAttempt(ctx, err)) {
        log(`[dev-stress] ${ctx.id}: run ${data.run_id}'s stress lost its pg-boss claim on attempt ${(ctx.retryCount ?? 0) + 1} (${err instanceof Error ? err.message : String(err)}): not a death, so not paged here; the attempt that holds the job carries on, and one pg-boss failed is found by its row`);
      } else if (err instanceof PermanentJobError || isLastAttempt(ctx)) {
        await settle(data.run_id, 'failed', err instanceof Error ? err.message : String(err)).catch((e: unknown) => {
          log(`[dev-stress] ${ctx.id}: run ${data.run_id}'s stress died for good, and its row could not be marked failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
      throw err;
    }
  };
}

/** The dev-stress queue's handler (PipelineHandlers.devStress): the runner, its outcome logged by the runner itself. */
export function createDevStressHandler(deps: DevStressDeps): JobHandler<'dev-stress'> {
  const runner = createDevStressRunner(deps);
  return async (data, ctx: JobContext) => {
    await runner(data, ctx);
  };
}
