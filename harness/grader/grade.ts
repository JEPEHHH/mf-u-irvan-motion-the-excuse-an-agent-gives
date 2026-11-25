// Grading one entry: execute it twice, each time from a freshly materialized snapshot in a fresh
// sandbox, and require the two canonical action logs to be byte-equal.
//
//   execution 1 failed or timed out   -> that status, no score (execution 2 is not run)
//   execution 2 failed or timed out   -> that status, no score
//   both ok, logs differ              -> `nondeterministic`: scored from execution 1, never ranked
//   both ok, logs byte-equal          -> `finished`: scored, ranked (eligibility permitting)
//
// Once (GradeRequest.executions 1: a bundle naming run_once, contracts/competition.ts gradeExecutionsOf): execution 1
// alone runs, a failed or timed-out one that status as above, an ok one `finished` and scored as deterministic, the
// run flagged EXECUTED_ONCE_FLAG beside the score and never in it (regrade.ts RUN_ONLY_FLAGS); exec_count, wall_ms and
// the scorer's run time (program.ts RUN_FILE) are the one execution's. Its second run, when one is owed, is an L2
// regrade (regrade.ts), which holds a re-execution's log to the graded one.
//
// The score (score.ts) is built from execution 1's action log by the plan's pure scorer, the cost and
// the authorship summary passed in (under a program/v1 size count, the entry's code size too:
// GradeRequest.size), and the facts recorded on the run: harness_version (harness
// source sha + Node version), the image digest, the dataset digest and the seed. The outcome also
// carries the plan's fail key (the failed-tx draw's key, not in the score JSON: secret on the final
// phase until it is finalized), which the run must keep for its regrades. A replay harness's scorer also
// returns execution 1's trace (harnesses.ts Scored.trace, grader/trace.ts), a program/v1 scorer its
// checks trace when it writes checks.json: the outcome carries it as canonical JSON with the sha256 of
// the blob it is stored as (trace_json, trace_sha256), beside the result and never inside it, so the
// result's bytes do not move with it. A breakdown that makes no trace (Scored.traceIssue: a malformed
// checks.json) never fails the grade: the reason is logged (GradeRequest.onTraceIssue), the outcome
// carries no trace, and the result is what it would be without the breakdown. Under a code-fastest
// timing heat (grader/code-heat.ts) a grade carries no timing: scoreWithTiming builds a program/v1
// score again with a timing verdict (the dev phase's provisional timing, the final's heat), only its
// performance and eligibility moving (grader/worker.ts writes it). Nothing here
// touches the database: record.ts stores the outcome. Harness faults (a dataset the sim refuses, the
// sandbox driver failing, a scorer misbehaving) are thrown so the job is retried, never recorded as
// the entry's failure.
//
// Entry secrets: the entry's source (SnapshotSource) may carry the entrant's env-lane entry secrets
// (SnapshotSource.secrets, NAME to value; grader/worker.ts opens them). executeOnce hands them to the plan's
// execution (harnesses.ts ExecuteContext.secrets), so both of a grade's executions, every case of a run per
// case, an L2 re-execution (regrade.ts) and each run a code heat times (code-heat.ts, its TimedEntry's
// snapshot) run the entry with the same values; the scorer never gets them. Every execution that leaves
// executeOnce is masked of every form of every value (run.ts maskExecution: its stderr SECRET_MARK, its error
// REDACTED_MARK), whatever the plan masked itself, so the outcome's stderr (record.ts putStderr's blob), its
// error (`execution <n>: …`) and its executions' errors hold none; and so is whatever executeOnce or gradeEntry
// throws (redactThrown: a SandboxError's tail, a ScorerError quoting a scorer's stderr over the entry's outputs).
// The action log never is: it is scored and compared byte for byte (grader/worker.ts scans it instead).
//
// The house dossier (contracts/competition.ts ProgramEntryLink.dossier; program.ts's header of the same name): on a
// program/v1 bundle whose pump.fun entry link names `dossier` (its plan's harnesses.ts HarnessPlan.houseDossier), the
// file at that /output path is the house's dossier of the coin as launched, never what the program wrote. Once the two
// executions' logs are compared (as the program wrote them: the determinism check is the program's), houseDossierLogOf
// rewrites execution 1's outputs manifest so the file there is the dossier the entry-link stage stored at intake
// (EntryFacts.entry_link's dossier_sha256, its bytes in the blob store the stage and the grader share), or so no file
// is there where the record names none because the coin's check failed at intake (a house entry's would-be fail: the
// scorer's gate then fails the entry; the step's note says why: GradeRequest.onHouseDossier). That manifest is the
// one scored and recorded (action_log_json, action_log_sha256, the score's action_log_sha256), so every reader of the
// run's artifact (the judge heats, the feed, the score's artifact bytes, an L1 regrade) reads the house's dossier and
// none of them changes. No network read: the record is the intake's. A missing dossier that is the house's fault
// (program.ts HouseDossierOutputs.fault: the record holds no read of the coin because the stage's lookup or store
// faulted on its last attempt and recorded a skip, or predates the dossier; or its blob is gone, or corrupt in the
// store: server/blobstore.ts BlobCorruptError) is never scored as the entrant's fail: the grade throws
// HouseDossierFault, a server/jobs.ts PlatformFaultError, its message the note, so the pipeline's grade stage puts the
// entry back as it was, never failed, and the job dead-letters paged (`dead grade job`) for an admin to redrive its
// entry-link check and then its grade (makefun-k8s.sh admin-redrive --kind entry-link, then --kind grade); the
// stuck-entry sweep holds such a death by its name (server/pipeline/stuck-running.ts HELD_ERROR_NAMES), never sending
// the grade again by itself. A grade handed no record at all
// (EntryFacts.entry_link undefined) is a local one: cli/grade-local.ts refuses an entrant's kit of such a bundle before
// it grades (its scorer stays on the server), and the house's own field grading (gradeJudgeLocal) has no intake, so
// there the program's own file stands and the note says the house writes the dossier at intake. An L2 regrade's
// re-execution (grader/regrade.ts) logs the program's own manifest, which the recorded one is not where a dossier was
// written: it takes the same step (houseDossierLogOf) before its comparison.
//
// The house counts (contracts/competition.ts ProgramEntryLink.counts; program.ts's header of the same name): on a
// program/v1 bundle whose YouTube, X, TikTok or make.fun entry link names `counts` (COUNTS_ENTRY_LINK_PLATFORMS; its
// plan's harnesses.ts HarnessPlan.houseCounts), the file at that /output path is the house's counts of the entry's
// video, post or bounty, never what the program wrote. After the dossier's step (a counts link names no dossier, so at
// most one of the two writes) and before scoring, houseCountsLogOf rewrites the outputs manifest so the file there is
// the canonical counts (contracts/entry-link-counts.ts: a YouTube video's EntryLinkCounts, makefun/video-counts/v1; an
// X post's XPostCounts, makefun/post-counts/v1; a TikTok video's TiktokVideoCounts, makefun/tiktok-counts/v1; the
// make.fun bounties an entry names, BountiesCounts, makefun/bounty-counts/v2, a row a bounty) of the reading
// EntryFacts.entry_link_reading names: a dev grade's the intake check's (engagement.intake or readings.intake,
// `reading: 'check'`), a final grade's the deadline one
// (engagement.deadline or readings.deadline, `reading: 'deadline'`: a video's read at the final lock,
// server/entry-link/youtube-readings.ts; a post's by the house's deadline pass over the field after the lock; a
// bounty's at the final lock, capped at the contest's deadline, server/entry-link/makefun-readings.ts; grader/worker.ts
// sends a final grade with none yet again a minute on, countsHandOn, so it waits inside the final window). A video gone
// or no longer public reads `video: 'gone'`, a post deleted or withheld `post: 'gone'`, every count null, and a
// bounty no longer found, a draft, cancelled or internal `bounty: 'gone'`, entrants and fees null: the entrant's; a
// count the platform showed none of reads null (a video's hidden statistics, a legacy post's views). Counts the house
// cannot write (a record of another platform than the link's or of no counts platform, its video or post never read, a
// bounty record lacking its slug, entry fee or readings, the reading absent, or one that read nothing: program.ts
// HouseCountsOutputs.fault) throw HouseCountsFault, a PlatformFaultError held by the stuck-entry sweep as
// HouseDossierFault is, for an admin to redrive: its entry-link check, then its grade (makefun-k8s.sh admin-redrive
// --kind entry-link, then --kind grade), only where the record is missing or holds no readings, as a re-check writes
// the intake reading alone; a missing deadline reading waits on its own reader, then the grade (houseCountsLogOf). A dev
// grade whose record read no post or video (its intake check's reader faulted) needs no hand: the entry-link re-check
// that reads it sends the grade again (server/entry-link/counts-regrade.ts). A final grade whose record read no post or
// video at intake is scored on its deadline reading where that reading read it or found it gone (program.ts
// houseCountsOutputs), whether or not the deadline write filled the record's state. A TikTok video its bounty accepts
// with no counts (the region switch's "Accept, no counts", server/entry-link/tiktok-region.ts) whose reading read
// nothing is held by that ruling, not for a redrive: its fault says no redrive mends it and nothing is owed
// (houseCountsAcceptedNone, HOUSE_COUNTS_ACCEPTED_NONE). An X pool entry's final grade on a record that ties a post it
// lists to no pool post (its link never checked before the lock) is owed no redrive either, as nothing writes a tie
// after the lock: its fault says the entry stays unranked in that final, the house's fault, an admin's to disqualify
// or leave (houseCountsTieNeverMade, HOUSE_COUNTS_TIE_NEVER_MADE). Counts the house cannot write are asked
// before anything runs too (houseCountsBeforeRun, with the same houseCountsOutputs over an empty manifest), so such a
// grade spends no execution and no sandbox pod on an entry it cannot score. A local grade (EntryFacts.entry_link
// undefined) leaves the program's own file and says so.
//
// Stopping: a grade handed a signal (GradeRequest.signal: its job attempt's, which pg-boss aborts once it
// gives the attempt up at its expiry) stops once it aborts. Every program it starts runs in a sandbox
// bound to the signal (stoppableSandbox): the abort kills the program running (its container with it, on
// the docker driver; a pod it opened closed, on the k8s one-pod view; a session it opened closed, a run per case's on a
// driver with sessions), and nothing starts after it, so a run per case (program.ts executeProgram) stops
// between cases and the second execution and the scorer never start. Its scratch is removed as ever, and
// gradeEntry rejects with the signal's reason, no outcome built: nothing is recorded, and the error is no
// PermanentJobError, so the job's retry grades it afresh.
//
// Scratch: each execution and the scorer work in a fresh private directory under the request's work
// root, removed as they end (removeScratch): `exec-XXXXXX` and `score-XXXXXX`. A process that dies
// mid-grade leaves them behind, and in a work root that outlives the process (the pipeline's,
// server/pipeline/index.ts) nothing can tell a dead grade's from a live one's by name. A grade with
// an owner (GradeRequest.owner: whose grade it is, the same on every attempt of it and no other's,
// e.g. its job's) names them for it, `exec-<owner>-XXXXXX` and `score-<owner>-XXXXXX` (regrade.ts
// ownedScratch, EXEC_SCRATCH_PREFIX, SCORE_SCRATCH_PREFIX), and first removes what an earlier attempt
// of the same owner left (reapGradeScratch); a sweep that knows which owners are live can remove the
// rest by the same names.
//
// Heartbeat: every directory named for an owner carries SCRATCH_HEARTBEAT_FILE, which this process
// rewrites every SCRATCH_HEARTBEAT_MS while the directory's run lasts (keepScratchAlive, started by
// regrade.ts ownedScratch; stopped by removeScratch, or by the directory going). It is a direct entry,
// so the workers' start (server/pipeline/index.ts sweepDeadWork), which removes such a directory only
// once its newest change, its own or a direct entry's, is older than STALE_AFTER_MS's six hours, never
// takes a live run's: not even one on another database sharing the work root whose processes no
// process listing here can see (the docker driver's, in containers). An owner's reap (regrade.ts
// reapScratch) reads it too: a directory whose `.alive` is younger than SCRATCH_LIVE_MS (twice the beat),
// or that this process still beats, is a live attempt's and is left, logged, never removed: every
// grader pod mounts the one work root, and pg-boss starts a job's retry while the attempt it took for
// dead (a heartbeat that lapsed in a drain) still runs on another grader (job f86c2803, 2026-11-15: the
// retry's reap removed the live attempt's folder, and 15 grade-final jobs failed on ENOENT). What a reap
// leaves goes to sweepDeadWork.
//
// A lost work folder: a file-system error (ENOENT, ESTALE) on a path under the work root, met while an
// execution stages, runs or collects or a scorer scores (executeOnce, scoreOnce), is the grader's own
// folder gone (lostWorkFolder), the platform's fault and never the entry's: it is thrown as a SandboxError
// saying so, which the pipeline's grade stage puts back and sends again (server/pipeline/index.ts
// isSandboxFault), never failing the entry. The same error on a path outside the work root is thrown as it
// came.
//
// Loop time: a replay plan's execution (grader/replay-places.ts isReplayHarness: its sim engine steps on this process's
// main thread) is metered by replayLoopMeter as it runs, the loop's busy time over it observed and said beside the
// replays in flight (that module's header); nothing of the execution, its log or its score moves with it.
//
// Releasing (grader/sandbox/docker.ts releaseRemovedTrees, its header's Releasing): on Docker Desktop the VM keeps a
// host file descriptor on every entry of a tree a container looked up until the tree is looked up again from inside the
// VM, a removal on the host notwithstanding, and a host whose vnodes run dry fails every open (ENFILE, #226). So a
// scratch tree removed here is handed to the sandbox to release (releaseScratch: one release container a parent on a
// docker sandbox whose daemon is in a VM, nothing on Linux or another driver), once, after it is gone and after what
// ran in it is settled. Which trees removeScratch releases on its own: the scratch roots this process handed out and
// holds until it removes them, an execution's and a scorer's (scratchDir), every one named for an owner (regrade.ts
// ownedScratch, beating: the hindsight audit's, a trial's, a regrade's) and one its caller holds (holdScratch: a bars
// dev run's, a seeding compile attempt's, an ownerless scrape heat's (worker.ts runScrapeHeatFor), a regrade's
// ownerless one, a CLI command's root once its sandbox is picked, an agent pass's and its scoring's (agent.ts runTrial,
// scoreTrialWithChecks), a scrape trial's and its scoring's (scrape/trial.ts runScrapeTrial, scrape/score.ts
// scoreScrapeTrial), the agent pilot's own world (scripts/agent/pilot.ts prepareWorld)). A tree removed under a root
// still held is left to that root's release, which takes everything the VM cached under it in the same lookup: a run
// per case (program.ts) costs no release container of its own, nor an execution inside a held root, nor a pack build's
// runs inside a compile attempt's, nor an agent pass's or a scrape trial's scratch inside the root its caller holds
// (worker.ts's, a CLI's, the pilot's). Anything else removed (a
// sub-directory, a dead run's leftovers) is released by whoever removed it, as one batch (removeScratch's `released`,
// then releaseScratch): a reap releases what it removed once, at its end, or hands it to its caller (regrade.ts
// reapScratch's `released`); gradeEntry hands its executions' and scorer's scratch, and what it reaped, to one release
// once its outcome is built (or it threw), so a release never runs between a grade's executions, never moves its
// timing or its log, and never fails it (it never throws). A code heat's timer does the same for each run it measures
// (code-heat.ts openCodeTimer's measure): the run's scratch is released once the clock's reading after it is taken (or
// it threw), so no release runs between a run's two readings or moves its CPU time. A trial's and an audit's handlers
// (worker.ts livePass, interrupted, replay, scorePass, hindsight auditOne) hand all they remove to one release in a
// `finally`, once their outcome is recorded (the trial row moved, its void or score written, the audit's record kept)
// or they threw, so no release stands before a recorded end (liveFinishedAt, replayFinishedAt) or between an audit and
// its record.

import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { ProgramEntryLinkScore, type AuthorshipSummaryT, type CostT, type PerformanceT, type ProgramEntryLinkScoreT, type ScoreSizeT, type ScoreT } from '../contracts/score.ts';
import type { BlobStore } from '../server/blobstore.ts';
import type { EntryLinkRecord } from '../server/db/schema.ts';
import { PlatformFaultError } from '../server/jobs.ts';
import { materializeSnapshot, removeMaterialized, type SnapshotIndex } from '../server/repos/index-tar.ts';
import { scorerVersionOf, type ExecuteContext, type HarnessPlan, type ScoreContext } from './harnesses.ts';
import { houseCountsOutputs, houseCountsRefusedOf, houseDossierOutputs, PROGRAM_OUTPUTS_FORMAT, type HouseCountsReading, type OutputBlobs } from './program.ts';
import type { ScratchReap, ScratchReapOptions } from './regrade.ts';
import { replayEngineObserver } from './replay-engine-metrics.ts';
import { isReplayHarness, replayLoopMeter } from './replay-places.ts';
import { entrySecretForms, maskExecution, redactSecrets, type Execution, type LimitsT } from './run.ts';
import { buildScore, scoreDigest, type EligibilityRules, type TimingVerdictT } from './score.ts';
import type { FormSet } from './gateway/secret-mask.ts';
import { releaseRemovedTrees } from './sandbox/docker.ts';
import {
  SandboxError,
  type MeteredProcess,
  type PodMember,
  type Runtime,
  type Sandbox,
  type SandboxPod,
  type SandboxPodPlan,
  type SandboxPods,
  type SandboxProcess,
  type SandboxSession,
  type SandboxSessions,
  type SandboxSpec,
  type TreeMeter,
  type TreeMeterOptions,
} from './sandbox/types.ts';
import { isOwn, unlockOwn } from './sandbox/unlock.ts';
import { encodeTrace } from './trace.ts';
import { harnessVersion } from './version.ts';

export type GradeStatus = 'finished' | 'failed' | 'timeout' | 'nondeterministic';

/**
 * An entry as an execution takes it (executeOnce): its snapshot, and the env-lane entry secrets every execution of it
 * runs with (the header's `Entry secrets`).
 */
export interface SnapshotSource {
  index: SnapshotIndex;
  blobs: BlobStore;
  /**
   * The entrant's env-lane entry secrets, NAME to value (contracts/entry-secrets.ts; grader/worker.ts opens them: a
   * grade the entrant's active ones, an L2 and a code heat its run's recorded ones): each execution's
   * ExecuteContext.secrets, so the entry's own sandbox gets them on every run of it from this source (both of a grade's
   * executions, every case of a run per case, a timed run), and every word of an execution masked of them. Never the
   * scorer's. Absent or empty: none.
   */
  secrets?: Readonly<Record<string, string>>;
}

/**
 * `err` with every form in `forms` redacted out of its message and stack (run.ts redactSecrets): what a grade, an
 * execution or a regrade throws past its entry's secrets (a SandboxError quoting a tail, a ScorerError quoting the
 * scorer's stderr over outputs the entry wrote) says none of them. The same object, so its class and cause stand.
 */
export function redactThrown(err: unknown, forms: FormSet | null): unknown {
  if (forms === null || !(err instanceof Error)) return err;
  const message = redactSecrets(err.message, forms);
  if (message !== err.message) err.message = message;
  if (typeof err.stack === 'string') {
    const stack = redactSecrets(err.stack, forms);
    if (stack !== err.stack) err.stack = stack;
  }
  return err;
}

export interface EntryFacts {
  house: boolean;
  baseline: boolean;
  /**
   * The entry's public link as the entry-link stage resolved it (server/db/schema.ts EntryLinkRecord), the submission's
   * own record, when the bundle's harness names one (contracts/competition.ts ProgramHarness.entry_link): a pump.fun
   * record holding both times fills the score's launch (entryLinkFactsOf, contracts/score.ts
   * ProgramPerformance.entry_link). Absent or null: no launch, and the grade is what it was; a record missing a time or
   * another platform's never fails a grade.
   */
  entry_link?: EntryLinkRecord | null;
  /**
   * Which of a counts record's readings (a YouTube video's, an X post's, a TikTok video's or a make.fun bounty's) the
   * house counts file carries (the header's `The house counts`), on a plan naming a counts path (harnesses.ts
   * HarnessPlan.houseCounts): 'intake', the check's (a dev grade's), or 'deadline', the one taken at or after the final's
   * lock (a final grade's): grader/worker.ts sets it from the grade's phase. Absent on every other grade.
   */
  entry_link_reading?: HouseCountsReading;
  /**
   * Whether the entry's entry_link check refused its link (program.ts entryLinkCheckRefused of its submission.checks, as
   * grader/worker.ts reads them at grade time): true, a plan naming a counts path writes no counts and the grade is the
   * house's fault (program.ts houseCountsOutputs' `refused`), whatever the record's read state, reading or stamp. The
   * record's own `refused` stamp (the counts deadline write's) is not enough alone: a re-check rebuilds the record without
   * it, and a record written before the stamp carries none. Absent or false: the record's stamp alone decides.
   */
  entry_link_refused?: boolean;
}

/**
 * The launch a program/v1 score carries (contracts/score.ts ProgramEntryLinkScore): the entry's pump.fun record
 * (server/db/schema.ts PumpfunEntryLinkRecord, written by the entry-link stage before grading) with its mint,
 * created_ms and elapsed_ms read, and its slot (null when the record holds none: written before the house read it).
 * Null for another platform's record, for a record with either time unread, and for none at all: a grade never fails
 * for it, the score just carries no launch. Exported for record.ts (scoreWithEntryLink) and the regrade
 * (grader/regrade.ts, which re-derives the block from the submission's record as it stands and so fails an L1 whose
 * record moved), and for tests. Structural, because a caller may hold only the record's facts (EntryLinkRecordFacts).
 */
export function entryLinkFactsOf(record: unknown): ProgramEntryLinkScoreT | null {
  if (record === null || typeof record !== 'object') return null;
  const r = record as EntryLinkRecordFacts;
  if (r.platform !== 'pumpfun' || typeof r.created_ms !== 'number' || typeof r.elapsed_ms !== 'number') return null;
  // The record's JSON is the database's (jsonb), so each value is held to the score's own shape: a malformed one is no
  // launch, never a failed grade. A record written before the slot was read carries none: the block names it null.
  const parsed = ProgramEntryLinkScore.safeParse({ mint: r.mint, created_ms: r.created_ms, elapsed_ms: r.elapsed_ms, slot: r.slot ?? null });
  return parsed.success ? parsed.data : null;
}

export interface GradeRequest {
  plan: HarnessPlan;
  sandbox: Sandbox;
  runtime: Runtime;
  snapshot: SnapshotSource;
  limits: LimitsT;
  /** An existing directory; every execution gets a fresh private directory under it, removed after. */
  workRoot: string;
  /** Where program/v1 outputs are kept (usually the same blob store as the snapshot). */
  blobs: OutputBlobs;
  cost: CostT;
  authorship: AuthorshipSummaryT | null;
  entry: EntryFacts;
  rules: EligibilityRules;
  /**
   * How many times the grade executes the entry (contracts/competition.ts gradeExecutionsOf: 1 under a bundle naming
   * run_once). 2, or absent (every hand-built request): execute twice and hold the two action logs byte for byte. 1:
   * execution 1 alone, an ok one `finished` and scored as deterministic, the outcome flagged EXECUTED_ONCE_FLAG beside
   * its score and never in it. A TypeError for anything else.
   */
  executions?: 1 | 2;
  /**
   * The entry's code size (grader/size.ts codeSize over the snapshot's entries and the kit's starter; under the
   * compressed count weighCodeSize, its compressed size too: grader/size-weigh.ts snapshotCodeSize), counted upstream
   * as cost and authorship are: given exactly when the rules name a size count (rules.size), at its version, and absent
   * under none (score.ts buildScore refuses either otherwise, a TypeError).
   */
  size?: ScoreSizeT;
  /** Container name stem (default `grade`). */
  label?: string;
  /**
   * Whose grade this is, as a label value (grader/sandbox/network.ts TRIAL_OWNER_RE), the same on every
   * attempt of the grade and no other grade's (the pipeline's job owner, worker.ts regradeOwner): each
   * execution's and the scorer's scratch is named for it (`exec-<owner>-XXXXXX`, `score-<owner>-XXXXXX`),
   * and what an earlier attempt of it left under `workRoot` is removed before anything runs
   * (reapGradeScratch), but a folder whose heartbeat says an attempt of it may still be live, which is left (a retry
   * pg-boss started while the attempt it took for dead still runs on another grader). Absent: `exec-XXXXXX`,
   * `score-XXXXXX`, as before. A TypeError when it is no label value.
   */
  owner?: string;
  /** Told what the removal of an earlier attempt's scratch took (and could not), each time it ran (an owner given). */
  onScratchReap?: (reaped: ScratchReap) => void;
  /**
   * Told why the scorer's breakdown made no trace (harnesses.ts Scored.traceIssue: a program/v1 scorer's malformed
   * checks.json), the run then storing none and its score standing as without it. Default: a line on stderr
   * (traceIssueLine).
   */
  onTraceIssue?: (issue: string) => void;
  /**
   * Told what the house dossier step did (the header's `The house dossier`: written, or the path left empty and why, or
   * a local grade's program file left standing, or the house's fault that stops the grade), on a grade whose bundle
   * names one. Default: a line on stdout (houseDossierLine).
   */
  onHouseDossier?: (note: string) => void;
  /**
   * Told what the house counts step did (the header's `The house counts`: written, or a local grade's program file left
   * standing, or the house's fault that stops the grade), on a grade whose bundle names a counts path. Default: a line
   * on stdout (houseDossierLine's shape).
   */
  onHouseCounts?: (note: string) => void;
  /**
   * The job attempt's signal (server/jobs.ts JobContext.signal; the header's `Stopping`): once it aborts, the program
   * running is killed, nothing more starts, and gradeEntry rejects with its reason, nothing graded. Absent: never stopped.
   */
  signal?: AbortSignal;
  /**
   * Told execution 1's action log (its canonical JSON and sha256) once execution 1 ended ok, before execution 2 and the
   * scorer start: a judged dev grade's provisional heat begins its anchor round on it (grader/worker.ts
   * provisionalOverlapOf; its header's `provisional overlap`), and keeps nothing of it unless the grade ends finished,
   * the two logs byte-equal and the gate passed. It changes nothing the grade runs, compares, scores or returns; what it
   * throws is dropped. Absent: told nothing.
   */
  onFirstExecution?: (log: { json: string; sha256: string }) => void;
}

/**
 * `sandbox` bound to `signal` (the header's `Stopping`): each program it starts is killed once the signal aborts, and once
 * it has, spawn, spawnMetered, meterTree, pods.open and sessions.open throw the signal's reason and start nothing. A pod it
 * opened (Sandbox.pods) is closed once the signal aborts, which kills its members, and once it has, the pod's spawn and
 * meter throw the signal's reason too; a session it opened (Sandbox.sessions) likewise: closed on the abort, its runs
 * killed, its spawn and meterTree then throwing the reason (stoppableSession). Everything else is the sandbox's own (its
 * removeTree too, so a stopped run's scratch is still removed; a driver without spawnMetered, pods or sessions still has
 * none), and it is still an instance of the sandbox's class. `sandbox` itself when there is no signal.
 */
export function stoppableSandbox<S extends Sandbox>(sandbox: S, signal: AbortSignal | undefined): S {
  if (signal === undefined) return sandbox;
  const spawn = (spec: SandboxSpec): SandboxProcess => {
    signal.throwIfAborted();
    return killedOnAbort(sandbox.spawn(spec), signal);
  };
  const metered = sandbox.spawnMetered;
  const spawnMetered =
    metered === undefined
      ? undefined
      : (spec: SandboxSpec, dir: string, meterOpts: TreeMeterOptions): MeteredProcess => {
          signal.throwIfAborted();
          const started = metered.call(sandbox, spec, dir, meterOpts);
          killedOnAbort(started.process, signal);
          return started;
        };
  const meter = sandbox.meterTree;
  const meterTree =
    meter === undefined
      ? undefined
      : (dir: string, opts: TreeMeterOptions): TreeMeter => {
          signal.throwIfAborted();
          return meter.call(sandbox, dir, opts);
        };
  const own = sandbox.pods;
  const pods: SandboxPods | undefined =
    own === undefined
      ? undefined
      : Object.freeze({
          open: (plan: SandboxPodPlan): SandboxPod => {
            signal.throwIfAborted();
            return stoppablePod(own.open(plan), signal);
          },
        });
  const ownSessions = sandbox.sessions;
  const sessions: SandboxSessions | undefined =
    ownSessions === undefined
      ? undefined
      : Object.freeze({
          open: (template: SandboxSpec): SandboxSession => {
            signal.throwIfAborted();
            return stoppableSession(ownSessions.open(template), signal);
          },
        });
  return new Proxy(sandbox, {
    get(target, prop) {
      if (prop === 'spawn') return spawn;
      if (prop === 'spawnMetered') return spawnMetered;
      if (prop === 'meterTree') return meterTree;
      if (prop === 'pods') return pods;
      if (prop === 'sessions') return sessions;
      const value: unknown = Reflect.get(target, prop, target);
      // Bound to the sandbox itself, so a driver's private fields are its own.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** `proc`, killed once `signal` aborts (at once when it already has: aborted while the driver started it, as the listener would have). */
function killedOnAbort<P extends SandboxProcess>(proc: P, signal: AbortSignal): P {
  const stop = (): void => void proc.kill().catch(() => undefined);
  if (signal.aborted) {
    stop();
    return proc;
  }
  signal.addEventListener('abort', stop, { once: true });
  const off = (): void => signal.removeEventListener('abort', stop);
  proc.exited.then(off, off);
  return proc;
}

/**
 * `pod` bound to `signal` (stoppableSandbox's pods): closed once the signal aborts (at once when it already has), which
 * kills what its members run; once it has, spawn and meter throw the signal's reason and start nothing. Its own close()
 * drops the listener. Everything else is the pod's own, read on the pod itself (its private fields are its own).
 */
function stoppablePod(pod: SandboxPod, signal: AbortSignal): SandboxPod {
  const stop = (): void => void pod.close().catch(() => undefined);
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  const spawn = (member: PodMember) => {
    signal.throwIfAborted();
    return pod.spawn(member);
  };
  const meter = (opts: TreeMeterOptions): TreeMeter => {
    signal.throwIfAborted();
    return pod.meter(opts);
  };
  const close = (): Promise<void> => {
    signal.removeEventListener('abort', stop);
    return pod.close();
  };
  return new Proxy(pod, {
    get(target, prop) {
      if (prop === 'spawn') return spawn;
      if (prop === 'meter') return meter;
      if (prop === 'close') return close;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * `session` bound to `signal` (stoppableSandbox's sessions): closed once the signal aborts (at once when it already has),
 * which kills its live run, and each run it starts killed on the abort too; once it has, spawn and meterTree throw the
 * signal's reason and start nothing. Its own close() drops the listener. Everything else is the session's own, read on the
 * session itself (its private fields are its own); a session without meterTree still has none.
 */
function stoppableSession(session: SandboxSession, signal: AbortSignal): SandboxSession {
  const stop = (): void => void session.close().catch(() => undefined);
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  const spawn = (spec: SandboxSpec): SandboxProcess => {
    signal.throwIfAborted();
    return killedOnAbort(session.spawn(spec), signal);
  };
  const meter = session.meterTree;
  const meterTree =
    meter === undefined
      ? undefined
      : (dir: string, opts: TreeMeterOptions): TreeMeter => {
          signal.throwIfAborted();
          return meter.call(session, dir, opts);
        };
  const close = (): Promise<void> => {
    signal.removeEventListener('abort', stop);
    return session.close();
  };
  return new Proxy(session, {
    get(target, prop) {
      if (prop === 'spawn') return spawn;
      if (prop === 'meterTree') return meterTree;
      if (prop === 'close') return close;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** `err`, or the signal's reason when the signal has aborted (the header's `Stopping`): what a stopped run threw is the stop's doing. */
function stoppedOr(err: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted === true ? signal.reason : err;
}

/** The prefix of an execution's scratch under its work root (executeOnce): `exec-XXXXXX`, with an owner `exec-<owner>-XXXXXX`. */
export const EXEC_SCRATCH_PREFIX = 'exec-';

/** The prefix of a scorer's scratch under its work root (scoreOnce): `score-XXXXXX`, with an owner `score-<owner>-XXXXXX`. */
export const SCORE_SCRATCH_PREFIX = 'score-';

/** Every prefix a grade's scratch is named with under its work root: an execution's and the scorer's. */
export const GRADE_SCRATCH_PREFIXES = [EXEC_SCRATCH_PREFIX, SCORE_SCRATCH_PREFIX] as const;

/** `owner` when it is a label value (grader/sandbox/network.ts TRIAL_OWNER_RE), else a TypeError: a caller's mistake, never the entry's or the sandbox's. */
async function checkGradeOwner(owner: string): Promise<string> {
  const { TRIAL_OWNER_RE } = await import('./sandbox/network.ts');
  if (typeof owner !== 'string' || !TRIAL_OWNER_RE.test(owner)) {
    throw new TypeError(`grade owner ${JSON.stringify(owner)} is no label value: lowercase [a-z0-9._-], at most 128 characters`);
  }
  return owner;
}

/**
 * The file a live run's owned scratch carries (the header's `Heartbeat`): rewritten every SCRATCH_HEARTBEAT_MS while
 * the run lasts, so its change time says the directory is in use however long the run goes untouched elsewhere.
 */
export const SCRATCH_HEARTBEAT_FILE = '.alive';

/** How often a live run's heartbeat file is rewritten: ten minutes, well inside STALE_AFTER_MS's six hours. */
export const SCRATCH_HEARTBEAT_MS = 10 * 60_000;

/**
 * How fresh an owned scratch's heartbeat file keeps it from a reap (regrade.ts reapScratch): twice SCRATCH_HEARTBEAT_MS.
 * A live run's `.alive` is at most one beat old plus the beat's own lateness (a timer that fires late under load, a write
 * still in flight, which skips that tick, a clock a little apart on the volume's host): one beat of slack past the beat,
 * so a run that is alive is never taken for dead, while one whose beat stopped twenty minutes ago is.
 */
export const SCRATCH_LIVE_MS = 2 * SCRATCH_HEARTBEAT_MS;

/** One directory's heartbeat: its timer, the write in flight (one at a time), and whether it was stopped. */
interface Heartbeat {
  timer: ReturnType<typeof setInterval> | null;
  beat: Promise<void> | null;
  stopped: boolean;
}

/** Every heartbeat this process keeps, by the directory's absolute path. */
const heartbeats = new Map<string, Heartbeat>();

/**
 * The scratch roots this process holds beside the beating ones (the header's Releasing), by absolute path: an
 * execution's and a scorer's made for no owner (scratchDir) and each one a caller holds (holdScratch), until
 * removeScratch takes it or anything above it.
 */
const held = new Set<string>();

/** Whether `key` (an absolute path) is a scratch root this process holds now: beating, or held. */
function holdsRoot(key: string): boolean {
  return heartbeats.has(key) || held.has(key);
}

/** Whether a scratch root this process holds lies above `dir` (not `dir` itself): that root's release takes `dir` with it. */
function heldAbove(dir: string): boolean {
  let at = resolve(dir);
  for (let up = dirname(at); up !== at; at = up, up = dirname(at)) if (holdsRoot(up)) return true;
  return false;
}

/** Let go of the hold on `key` (an absolute path) and on every root held under it: removeScratch is taking them. */
function dropHeld(key: string): void {
  const below = key.endsWith(sep) ? key : `${key}${sep}`;
  for (const d of [...held]) if (d === key || d.startsWith(below)) held.delete(d);
}

/**
 * Hold `dir`, a scratch root its caller made and removes with removeScratch (the header's Releasing): until then
 * nothing removed under it (a grade's executions and scorer, say) is released on its own, and its removal releases it,
 * everything under it in the same lookup.
 */
export function holdScratch(dir: string): void {
  held.add(resolve(dir));
}

/**
 * Release `dirs`, scratch trees this process removed, from the sandbox's daemon (docker.ts releaseRemovedTrees, the
 * header's Releasing), but each under a root this process still holds, which that root's release takes: a docker
 * sandbox whose daemon is in a VM runs one release container a parent, any other sandbox nothing. Never throws.
 */
export async function releaseScratch(sandbox: Sandbox, dirs: readonly string[]): Promise<void> {
  await releaseRemovedTrees(sandbox, dirs.filter((d) => !heldAbove(d)));
}

/**
 * Rewrite `dir`'s heartbeat file (this process's pid and the time, so a look at it says whose run it is). Never throws:
 * `gone` when the directory is not there any more (its run removed it, or someone else did), `failed` on anything else
 * (the next beat tries again; meanwhile the directory only ages as it would without one).
 */
async function writeHeartbeat(dir: string): Promise<'ok' | 'gone' | 'failed'> {
  try {
    await writeFile(join(dir, SCRATCH_HEARTBEAT_FILE), `${process.pid} ${new Date().toISOString()}\n`, { mode: 0o600 });
    return 'ok';
  } catch (err) {
    const code = errno(err);
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'failed';
  }
}

/** Stop `hb`, `dir`'s: no beat after this one starts, and the map forgets it. */
function dropHeartbeat(dir: string, hb: Heartbeat): void {
  hb.stopped = true;
  if (hb.timer !== null) clearInterval(hb.timer);
  if (heartbeats.get(dir) === hb) heartbeats.delete(dir);
}

/**
 * Give `dir` a heartbeat (the header's `Heartbeat`): its file written now, before the directory is handed out, then
 * every SCRATCH_HEARTBEAT_MS on a timer that never keeps the process up, until removeScratch takes the directory (or
 * anything under which it lies) or a beat finds it gone. A directory already beating keeps its one heartbeat.
 */
export async function keepScratchAlive(dir: string): Promise<void> {
  const key = resolve(dir);
  if (heartbeats.has(key)) return;
  const hb: Heartbeat = { timer: null, beat: null, stopped: false };
  heartbeats.set(key, hb);
  const first = writeHeartbeat(key);
  hb.beat = first.then(() => undefined);
  const wrote = await first;
  hb.beat = null;
  if (wrote === 'gone') {
    dropHeartbeat(key, hb);
    return;
  }
  if (hb.stopped) return;
  hb.timer = setInterval(() => {
    if (hb.stopped || hb.beat !== null) return;
    hb.beat = writeHeartbeat(key).then((r) => {
      hb.beat = null;
      if (r === 'gone') dropHeartbeat(key, hb);
    });
  }, SCRATCH_HEARTBEAT_MS);
  hb.timer.unref();
}

/**
 * Stop the heartbeat of `dir` and of every directory under it, each beat in flight awaited, so nothing writes into
 * the tree once this returns (removeScratch, before it removes anything).
 */
export async function stopScratchHeartbeats(dir: string): Promise<void> {
  const top = resolve(dir);
  const below = top.endsWith(sep) ? top : `${top}${sep}`;
  const inFlight: Promise<void>[] = [];
  for (const [key, hb] of [...heartbeats]) {
    if (key !== top && !key.startsWith(below)) continue;
    dropHeartbeat(key, hb);
    if (hb.beat !== null) inFlight.push(hb.beat);
  }
  await Promise.all(inFlight);
}

/** The directories this process keeps a heartbeat for now, sorted (absolute paths). */
export function beatingScratch(): string[] {
  return [...heartbeats.keys()].sort();
}

/**
 * A fresh private scratch directory under `root`, a root this process holds until removeScratch takes it (the header's
 * Releasing): `<prefix>XXXXXX`, or with an owner `<prefix><owner>-XXXXXX` (regrade.ts ownedScratch, beating).
 */
async function scratchDir(root: string, prefix: string, owner: string | undefined): Promise<string> {
  if (owner === undefined) {
    const dir = await mkdtemp(join(root, prefix));
    held.add(resolve(dir));
    return dir;
  }
  const checked = await checkGradeOwner(owner);
  // Loaded when used: regrade.ts imports this module.
  const { ownedScratch } = await import('./regrade.ts');
  return ownedScratch(root, prefix, checked);
}

/**
 * What an earlier attempt of `owner`'s grade left under `workRoot`, removed: every execution's and scorer's
 * scratch named for it (`exec-<owner>-XXXXXX`, `score-<owner>-XXXXXX`; regrade.ts reapScratch, each removed as
 * its run would have removed it). Never another owner's, an ownerless one, or a link, and never one a live attempt of
 * `owner` may still work in (its `.alive` younger than SCRATCH_LIVE_MS, or beating in this process: reapScratch's
 * `left`, logged), since a job's retry can start while an attempt pg-boss took for dead still runs on another grader on
 * the same work root. What it removed is released from the sandbox's
 * daemon in one go (releaseScratch; the header's Releasing), or, given `released`, handed there for the caller to
 * release with the rest (gradeEntry). Never throws for what it finds: what it could not list or remove is in `errors`;
 * a TypeError when `owner` is no label value.
 */
export async function reapGradeScratch(sandbox: Sandbox, workRoot: string, owner: string, released?: string[], opts: ScratchReapOptions = {}): Promise<ScratchReap> {
  const checked = await checkGradeOwner(owner);
  const { reapScratch } = await import('./regrade.ts');
  const out: ScratchReap = { owner: checked, dirs: [], errors: [] };
  // Each prefix's removals handed here (reapScratch's `released`), for the one release below or the caller's.
  const removed: string[] = [];
  for (const prefix of GRADE_SCRATCH_PREFIXES) {
    const r = await reapScratch(sandbox, workRoot, prefix, checked, null, removed, opts);
    out.dirs.push(...r.dirs);
    out.errors.push(...r.errors);
    if (r.left !== undefined) (out.left ??= []).push(...r.left);
  }
  if (released !== undefined) released.push(...removed);
  else await releaseScratch(sandbox, removed);
  return out;
}

export interface ExecutionSummary {
  status: Execution['status'];
  error: string | null;
  wall_ms: number;
  flags: string[];
  action_log_sha256: string | null;
  exit_code: number | null;
  stderr_bytes: number;
}

export interface GradeOutcome {
  status: GradeStatus;
  error: string | null;
  executions: ExecutionSummary[];
  /** Execution 1's canonical action log (stored as a blob named by its sha256). */
  action_log_json: string | null;
  action_log_sha256: string | null;
  result: ScoreT | null;
  result_sha256: string | null;
  /**
   * The run's trace (contracts/breakdown.ts; grader/trace.ts) as canonical JSON: execution 1's run row by row, what
   * the scorer returned beside the score (harnesses.ts Scored.trace; program/v1: its scorer's checks trace). Null
   * when nothing was scored, the harness makes none (a program/v1 scorer that writes no checks.json) or the
   * breakdown made none (GradeRequest.onTraceIssue). Never part of result.
   */
  trace_json: string | null;
  /** sha256 of the blob the trace is stored as (grader/trace.ts traceBlob: the gzip of trace_json): what run.trace_sha256 names. */
  trace_sha256: string | null;
  /** Flags the executions raised (run.flags). */
  flags: string[];
  /** Total wall time of the executions. */
  wall_ms: number;
  /** stderr of the execution that decided the status (the failing one, else execution 1). */
  stderr: Buffer;
  image_digest: string | null;
  harness_version: string;
  scorer_version: string;
  dataset_sha256: string | null;
  seed: string;
  /**
   * The failed-tx draw's key the executions and the scorer used (u64 decimal; null for program/v1):
   * an execution fact a regrade needs (the action log does not carry it). Secret on the final phase
   * until it is finalized: stored with the run; published once the phase is finalized (or the
   * competition resolved), so anyone can then L1-regrade a final run
   * (server/routes/_lib/visibility.ts runFailKeyFor).
   */
  fail_key: string | null;
  exec_count: number;
  started_at: Date;
  finished_at: Date;
}

function summarize(e: Execution): ExecutionSummary {
  return {
    status: e.status,
    error: e.error,
    wall_ms: e.wall_ms,
    flags: e.flags,
    action_log_sha256: e.log_sha256,
    exit_code: e.exit?.code ?? null,
    stderr_bytes: e.stderr.length,
  };
}

/**
 * The directories under `dir` (itself included) the sandbox user could write into, none inside
 * another: this process's own world-writable ones (the writable mounts, /output and /scores, made
 * 0777 for that user) and any directory that is not this process's (one that user made). Everything
 * else is this process's own, with nothing of the sandbox user's in it. Never follows a link.
 */
async function sandboxWritable(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let st;
    try {
      st = await lstat(d);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    if (!isOwn(st) || (st.mode & 0o002) !== 0) {
      found.push(d);
      return;
    }
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) await walk(join(d, e.name));
  };
  await walk(dir);
  return found;
}

/**
 * Remove a scratch directory the sandbox may have written into. This process's own directories in it
 * get their rwx back first (sandbox/unlock.ts); then only the directories the sandbox user could write
 * go to sandbox.removeTree (on Linux the docker driver deletes what that user made from a container
 * running as that user, which can enter those directories and no other of ours; the k8s driver's
 * trees came back as this process's own, so its removeTree is unlockOwn and rm, no pod; removeWritable); the
 * rest is this process's own and goes with removeOwnTree. A tree the program nested past PATH_MAX is
 * deleted all the same, never a harness fault. Every private (0700) scratch root goes through here,
 * never to removeTree itself: an execution's and a scorer's (below), the hindsight audit's (worker.ts)
 * and the pipeline's own work root (server/pipeline/index.ts). The heartbeat of `dir` and of anything
 * under it stops first (stopScratchHeartbeats; the header's `Heartbeat`): its run is over, and a removal
 * that fails part-way leaves what it could not take to age as a dead run's. Once it is gone the sandbox's daemon is
 * told (releaseScratch; the header's Releasing): given `released`, `dir` goes there whatever it is, for the caller to
 * release with the rest of what it removes; else `dir` is released here when it is a scratch root this process
 * holds (scratchDir, ownedScratch, holdScratch) and no root it still holds lies above it, and not otherwise. Every
 * hold on `dir` and on what is under it ends here, the removal failing or not.
 */
export async function removeScratch(sandbox: Sandbox, dir: string, released?: string[]): Promise<void> {
  const key = resolve(dir);
  const root = holdsRoot(key);
  dropHeld(key);
  await stopScratchHeartbeats(dir);
  await unlockOwn(dir);
  for (const writable of await sandboxWritable(dir)) await removeWritable(sandbox, writable);
  await removeOwnTree(dir);
  if (released !== undefined) released.push(dir);
  else if (root) await releaseScratch(sandbox, [dir]);
}

/**
 * sandbox.removeTree(dir) for a directory the sandbox user could write. Where the driver deleted with
 * this process's own rm and met a tree nested past PATH_MAX (ENAMETOOLONG: the process driver, whose
 * program ran as this process's user, or the k8s driver, whose trees came back through the collect's
 * reader as this process's own; either way the tree is this process's own), removeOwnTree instead;
 * the docker driver takes such a tree to its reclaim container itself.
 */
export async function removeWritable(sandbox: Sandbox, dir: string): Promise<void> {
  try {
    await sandbox.removeTree(dir);
  } catch (err) {
    if (errno(err) !== 'ENAMETOOLONG') throw err;
    await removeOwnTree(dir);
  }
}

/**
 * The longest path removeOwnTree hands readdir, chmod and rename while it lifts a deep tree: half of
 * macOS's PATH_MAX (1024, the shorter platform's), so an entry's name (at most 255 bytes) still fits
 * after it.
 */
const LIFT_AT_BYTES = 512;

/**
 * rm -r for a tree of this process's own, however deep. Where rm meets a path past PATH_MAX
 * (ENAMETOOLONG: a program chdir'd its way down), every directory whose path passes LIFT_AT_BYTES is
 * renamed up to a fresh name directly under `dir`, and each of this process's own directories on the
 * way gets its owner's rwx back (a program running as this user may have left one read-only); then
 * rm runs again over what is now a shallow tree. Every other failure is rm's own, thrown; so is
 * ENAMETOOLONG when `dir` itself is too long to lift anything under.
 */
export async function removeOwnTree(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    return;
  } catch (err) {
    if (errno(err) !== 'ENAMETOOLONG' || Buffer.byteLength(dir) >= LIFT_AT_BYTES) throw err;
  }
  const tag = randomBytes(6).toString('hex');
  let lifted = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    await ownerRwx(d);
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      let p = join(d, e.name);
      if (Buffer.byteLength(p) > LIFT_AT_BYTES) {
        // A directory moving to another parent needs its own write bit too (Linux).
        await ownerRwx(p);
        const up = join(dir, `.lifted-${tag}-${++lifted}`);
        await rename(p, up);
        p = up;
      }
      stack.push(p);
    }
  }
  await rm(dir, { recursive: true, force: true });
}

/** Give `dir`, when it is this process's own directory, its owner's rwx (every other bit kept). */
async function ownerRwx(dir: string): Promise<void> {
  const st = await lstat(dir);
  if (st.isDirectory() && isOwn(st) && (st.mode & 0o700) !== 0o700) await chmod(dir, (st.mode & 0o7777) | 0o700);
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** The file-system errors that say a path the grader made under its work root is not there any more. */
const LOST_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ESTALE']);

/**
 * `err` as the platform's fault when it says the grader's own work folder was lost (the header's `A lost work folder`):
 * a file-system error (ENOENT, ESTALE) whose path, or destination, lies under `workRoot` (or is it), thrown while an
 * execution staged, ran or collected or a scorer scored, becomes a SandboxError naming the loss, `err` its cause, so the
 * pipeline's grade stage puts the entry back and sends the grade again (server/pipeline/index.ts isSandboxFault), never
 * failing it. Anything else, the same error on a path outside the work root among it, is `err` as it came.
 */
export function lostWorkFolder(err: unknown, workRoot: string): unknown {
  if (!(err instanceof Error) || err instanceof SandboxError) return err;
  const e = err as NodeJS.ErrnoException & { dest?: unknown };
  if (e.code === undefined || !LOST_CODES.has(e.code)) return err;
  const root = resolve(workRoot);
  const below = root.endsWith(sep) ? root : `${root}${sep}`;
  const lost = [e.path, e.dest].find((p): p is string => typeof p === 'string' && (resolve(p) === root || resolve(p).startsWith(below)));
  if (lost === undefined) return err;
  return new SandboxError(
    `the grader's work folder was lost: ${lost} is gone under its work root ${root} (removed by another attempt's reap or a sweep, or dropped by the volume), the platform's fault and never the entry's: ${e.message}`,
    { cause: err },
  );
}

export interface ExecuteOnceOptions {
  plan: HarnessPlan;
  sandbox: Sandbox;
  runtime: Runtime;
  snapshot: SnapshotSource;
  limits: LimitsT;
  workRoot: string;
  blobs: OutputBlobs;
  label: string;
  imageDigest: string | null;
  /** Whose execution this is (GradeRequest.owner): its scratch is `exec-<owner>-XXXXXX`; absent `exec-XXXXXX`. */
  owner?: string;
  /** Stops it (GradeRequest.signal; the header's `Stopping`): the program killed, nothing more started, and the signal's reason thrown, never an execution. */
  signal?: AbortSignal;
  /**
   * Where its scratch goes once removed, for the caller to release with the rest (gradeEntry: once its outcome is
   * built; code-heat.ts openCodeTimer: once the clock's reading after the run is taken; the header's Releasing).
   * Absent: released from the sandbox's daemon as it is removed (removeScratch).
   */
  released?: string[];
}

/**
 * One execution from a freshly materialized snapshot in a fresh scratch directory (removed after, then released: the
 * header's Releasing). Under a signal that aborts before it ends (the header's `Stopping`) it throws the signal's
 * reason, its scratch removed all the same.
 */
export async function executeOnce(o: ExecuteOnceOptions): Promise<Execution> {
  o.signal?.throwIfAborted();
  const secrets = o.snapshot.secrets;
  const forms = entrySecretForms(secrets);
  const dir = await scratchDir(o.workRoot, EXEC_SCRATCH_PREFIX, o.owner);
  const botDir = join(dir, 'bot');
  const workDir = join(dir, 'work');
  try {
    await materializeSnapshot(o.snapshot.index, o.snapshot.blobs, botDir);
    await mkdir(workDir, { mode: 0o700 });
    // A lockstep replay's engine turn, said and measured where the process enabled it (the grader's server: replay-engine-metrics.ts).
    const observer = replayEngineObserver();
    const ctx: ExecuteContext = {
      sandbox: stoppableSandbox(o.sandbox, o.signal),
      runtime: o.runtime,
      botDir,
      limits: o.limits,
      workDir,
      blobs: o.blobs,
      label: o.label,
      imageDigest: o.imageDigest,
      ...(secrets === undefined || forms === null ? {} : { secrets }),
      ...(observer === undefined ? {} : { onExecutionEnd: observer }),
    };
    // A replay's main-thread time over its execution, measured and said (replay-places.ts replayLoopMeter), never changing it.
    const meter = isReplayHarness(o.plan.kind) ? replayLoopMeter(o.plan.kind, o.label) : null;
    let execution: Execution;
    try {
      execution = await o.plan.execute(ctx);
    } catch (err) {
      meter?.end('threw');
      throw err;
    }
    meter?.end(execution.status);
    // A run the stop cut short (its program killed: a failed case, a failed execution) is no execution.
    o.signal?.throwIfAborted();
    // Masked however the plan ran it (the header's `Entry secrets`): no execution leaves here holding a form of a value.
    return maskExecution(execution, forms);
  } catch (err) {
    // The grader's own folder gone under it (the header's `A lost work folder`) is the platform's fault, never the entry's.
    throw redactThrown(lostWorkFolder(stoppedOr(err, o.signal), o.workRoot), forms);
  } finally {
    await removeMaterialized(botDir).catch(() => undefined);
    await removeScratch(o.sandbox, dir, o.released);
  }
}

/**
 * Score a log in a fresh scratch directory (removed after, then released as executeOnce's is, or handed to `released`:
 * the header's Releasing): `score-XXXXXX`, with an owner (GradeRequest.owner) `score-<owner>-XXXXXX`. Under a signal
 * that aborts before it ends (the header's `Stopping`) the scorer is killed and this throws the signal's reason.
 */
export async function scoreOnce<Log>(plan: HarnessPlan<Log>, base: Omit<ScoreContext, 'workDir'>, workRoot: string, log: Log, owner?: string, signal?: AbortSignal, released?: string[]) {
  signal?.throwIfAborted();
  const dir = await scratchDir(workRoot, SCORE_SCRATCH_PREFIX, owner);
  try {
    const scored = await plan.score({ ...base, sandbox: stoppableSandbox(base.sandbox, signal), workDir: dir }, log);
    signal?.throwIfAborted();
    return scored;
  } catch (err) {
    throw lostWorkFolder(stoppedOr(err, signal), workRoot);
  } finally {
    await removeScratch(base.sandbox, dir, released);
  }
}

/** The line a grade logs for its house dossier step (GradeRequest.onHouseDossier's default). */
export function houseDossierLine(label: string, note: string): string {
  return `[grade] ${label}: ${note}`;
}

/**
 * A grade (or an L2 regrade's re-execution) stopped because its house dossier is missing by the house's fault (program.ts
 * HouseDossierOutputs.fault; the header's `The house dossier`): a PlatformFaultError, so nothing is scored or recorded,
 * the pipeline's grade stage puts the entry back as it was, never failed, and the job dead-letters, paged, for an admin
 * to redrive the entry's entry-link check and then its grade. Its message names the fault (the step's note). Its name
 * is listed in server/pipeline/stuck-running.ts HELD_ERROR_NAMES, so the stuck-entry sweep, which reads a death by
 * name, holds it rather than sending the grade again.
 */
export class HouseDossierFault extends PlatformFaultError {
  constructor(message: string) {
    super(message);
    this.name = 'HouseDossierFault';
  }
}

/** What houseDossierLogOf reads of a grade's request: the plan's dossier path, the entry's record, the blob store, and where its note goes. */
export interface HouseDossierRequest {
  plan: Pick<HarnessPlan, 'houseDossier'>;
  entry: Pick<EntryFacts, 'entry_link'>;
  blobs: Pick<OutputBlobs, 'get'>;
  onHouseDossier?: (note: string) => void;
}

/**
 * The action log a grade scores and records (the header's `The house dossier`): execution 1's as it ran, where its
 * plan names no dossier path (harnesses.ts HarnessPlan.houseDossier); else the one program.ts houseDossierOutputs makes
 * of it from the entry's entry-link record (EntryFacts.entry_link): the file at the dossier path the house's dossier, or
 * no file there where the coin's check failed at intake. A dossier missing by the house's fault (HouseDossierOutputs
 * .fault) throws HouseDossierFault, its note logged first: never the entrant's scoring fail. A grade handed no record at
 * all (EntryFacts.entry_link undefined: a local grade, which has no intake; the server's grade always hands one, null
 * where the stage recorded none) leaves the program's own file standing and says so: the house writes the dossier at
 * intake, and a local grade cannot read the coin. Called once the two executions' logs are compared, so the determinism
 * check reads the program's own outputs; an L2 regrade calls it on its one re-execution before comparing the result
 * with the run's recorded log.
 */
export async function houseDossierLogOf(
  req: HouseDossierRequest,
  first: Pick<Execution, 'log' | 'log_json' | 'log_sha256'>,
  label: string,
): Promise<{ log: unknown; json: string | null; sha256: string | null }> {
  // Read as possibly absent: a hand-built plan (a test's cast) carries no field, and is a plan naming none.
  const path = req.plan.houseDossier ?? null;
  const as = { log: first.log, json: first.log_json, sha256: first.log_sha256 };
  if (path === null) return as;
  const note = req.onHouseDossier ?? ((line: string) => console.log(houseDossierLine(label, line)));
  if (req.entry.entry_link === undefined) {
    note(`a local grade: the house writes its dossier of the coin at /output/${path} at intake, from the coin the entry-link check read; here the program's own file there (if any) stands`);
    return as;
  }
  const made = await houseDossierOutputs(first.log, path, req.entry.entry_link, req.blobs);
  if (made.fault) {
    const why = `${made.note}; the entry is not scored: redrive its entry-link check, then its grade (makefun-k8s.sh admin-redrive --kind entry-link, then --kind grade)`;
    note(why);
    throw new HouseDossierFault(`house dossier fault: ${why}`);
  }
  note(made.note);
  return { log: made.outputs, json: made.json, sha256: made.sha256 };
}

/**
 * A grade (or an L2 regrade's re-execution) stopped because the house counts of its entry link (a video's, a post's or
 * a bounty's) cannot be written by the house's fault (program.ts HouseCountsOutputs.fault; the header's `The house counts`): a PlatformFaultError, as
 * HouseDossierFault is, so nothing is scored or recorded, the entry is put back as it was, never failed, and the job
 * dead-letters, paged, for an admin to redrive the entry's entry-link check and then its grade. Its name is listed in
 * server/pipeline/stuck-running.ts HELD_ERROR_NAMES, so the stuck-entry sweep holds it rather than sending it again.
 */
export class HouseCountsFault extends PlatformFaultError {
  constructor(message: string) {
    super(message);
    this.name = 'HouseCountsFault';
  }
}

/**
 * What a grade stopped on the house counts says mends it (HouseCountsFault's last words). An entry-link re-check writes,
 * on a counts bundle, the intake reading alone (server/entry-link/stage.ts): it mends a record missing or holding no
 * readings, never a missing deadline reading, which only that reading's own reader writes; and the re-check that reads
 * a dev grade's post or video its intake could not sends that dev grade again by itself
 * (server/entry-link/counts-regrade.ts).
 */
const HOUSE_COUNTS_REDRIVE =
  "the entry is not scored: where its record is missing or holds no readings, redrive its entry-link check, then its grade (makefun-k8s.sh admin-redrive --kind entry-link, then --kind grade), save a dev grade whose record read no post or video, which the entry-link re-check that reads it sends again by itself; a re-check never writes a missing deadline reading: that waits on the deadline's own reader (a video's or a make.fun bounty's the 15-minute sweep, a video's also a re-run of the final's lock; a post's or a TikTok video's its counts deadline job inside the final window and none after it), then its grade (--kind grade)";

/**
 * What a grade stopped on the house counts of a TikTok video its bounty accepts with no counts says instead of
 * HOUSE_COUNTS_REDRIVE (the region switch's "Accept, no counts", the owner's ruling of 2026-11-23:
 * server/entry-link/tiktok-region.ts). The hold is that ruling's: such a video's counts are recorded as a reading that
 * read nothing, never zero and never gone, so the grade is held, neither refused nor scored. No redrive mends it, as
 * TikTok shows the house nothing of the video but its account, and a re-check reads the same nothing; the counts
 * deadline job reads the video again for the final.
 */
const HOUSE_COUNTS_ACCEPTED_NONE =
  "the entry is not scored and nothing is owed: the bounty accepts this video with no counts (the owner's ruling of 2026-11-23), so its grade is held, neither refused nor scored 0; no redrive mends it, as TikTok shows the house nothing of the video but its account and an entry-link re-check reads the same nothing; a dev grade stays unscored, and the final grade is scored on the counts its deadline reading reads (the tiktok-counts deadline job), the entry unranked in that final where that reading reads nothing too";

/**
 * Whether `record`'s reading `reading` is the counts of a TikTok video its bounty accepts with no counts (see
 * HOUSE_COUNTS_ACCEPTED_NONE): a TikTok record the check passed as hidden from the US with nothing of it read but its
 * account (server/entry-link/tiktok.ts tiktokLinkRecordOf: `video` 'read', `hidden_in_us`, `public` null as only such a
 * video writes it beside a read video), whose reading asked read nothing (`missing`, never `gone`).
 */
export function houseCountsAcceptedNone(record: unknown, reading: HouseCountsReading): boolean {
  if (record === null || typeof record !== 'object') return false;
  const r = record as { platform?: unknown; video?: unknown; hidden_in_us?: unknown; public?: unknown; engagement?: unknown };
  if (r.platform !== 'tiktok' || r.video !== 'read' || r.hidden_in_us !== true || r.public !== null) return false;
  const engagement = r.engagement !== null && typeof r.engagement === 'object' ? (r.engagement as Record<string, unknown>) : null;
  const taken = engagement?.[reading];
  if (taken === null || typeof taken !== 'object') return false;
  const t = taken as { missing?: unknown; gone?: unknown };
  return typeof t.missing === 'string' && t.gone !== true;
}

/**
 * What a final grade stopped on the house counts of an X pool entry whose record ties a post it lists to no pool post
 * says instead of HOUSE_COUNTS_REDRIVE (server/pipeline/stuck-running.ts HELD_DEATH_SENDERS.HouseCountsFault words the
 * same death): the posts counts file refuses a row with no pool tie (program.ts xPostsCountsOf), and no tie is ever
 * written after the final's lock, as the entry-link stage re-checks no entry of a locked final (admin-redrive refuses
 * --kind entry-link once no phase is open) and the x-counts deadline job reads each post's counts, never its tie. So
 * every redrive of the grade dies on the same fault, whatever else its record lacks: no redrive is owed.
 */
const HOUSE_COUNTS_TIE_NEVER_MADE =
  "the entry is not scored and no redrive is owed: its record ties a post it lists to no pool post (posts.N.pool_post_id null), as its link was never checked before the final's lock (every check of it skipped, so no tie was made), and nothing writes a tie after the lock (the entry-link stage re-checks no entry of a locked final, and the x-counts deadline job reads each post's counts, never its tie), so a grade redrive dies on the same fault: the entry stays unranked in that final, the house's fault and never the entrant's; an admin may disqualify it or leave it";

/**
 * Whether `record`'s reading `reading` is a final grade's of an X pool entry whose record ties a post it lists to no
 * pool post (see HOUSE_COUNTS_TIE_NEVER_MADE): on a plan whose link is an X pool link's (`posts`, HarnessPlan
 * .houseCountsPosts true: keyed on the plan's word, as program.ts houseCountsOutputs keys its list branch), the deadline
 * reading of an X record whose `posts` list holds a post whose `pool_post_id` is no id, the link not refused
 * (`refused`, the grade's own word, or the record's stamp: program.ts houseCountsRefusedOf), since a refused link's
 * fault is its refusal and never its ties. A dev grade's intake reading is never one: a re-check while the final is
 * open fills the ties.
 */
export function houseCountsTieNeverMade(record: unknown, reading: HouseCountsReading, of: { posts?: boolean | null; refused?: boolean | null }): boolean {
  if (of.posts !== true || reading !== 'deadline' || record === null || typeof record !== 'object') return false;
  if (houseCountsRefusedOf(record, of.refused) !== null) return false;
  const r = record as { platform?: unknown; posts?: unknown };
  if (r.platform !== 'x' || !Array.isArray(r.posts)) return false;
  return r.posts.some((p: unknown) => {
    const tie = p !== null && typeof p === 'object' ? (p as { pool_post_id?: unknown }).pool_post_id : undefined;
    return typeof tie !== 'string' || tie === '';
  });
}

/**
 * The tail of a house counts fault of `record`'s reading `reading` on a grade's request `req` (its plan's list word,
 * the entry's refusal): what mends it, or that nothing need (houseCountsAcceptedNone) or none is owed
 * (houseCountsTieNeverMade).
 */
function houseCountsMendOf(record: unknown, reading: HouseCountsReading, req: Pick<HouseCountsRequest, 'plan' | 'entry'>): string {
  if (houseCountsAcceptedNone(record, reading)) return HOUSE_COUNTS_ACCEPTED_NONE;
  if (houseCountsTieNeverMade(record, reading, { posts: req.plan.houseCountsPosts, refused: req.entry.entry_link_refused })) return HOUSE_COUNTS_TIE_NEVER_MADE;
  return HOUSE_COUNTS_REDRIVE;
}

/** The sha256 houseCountsBeforeRun's dry store answers: the counts it would keep are thrown away. */
const DRY_COUNTS_SHA256 = '0'.repeat(64);

/** What houseCountsOutputs' fault note ends with over a manifest the program has yet to write. */
const NOTHING_WRITTEN_YET = '; the program wrote nothing there, so the path is empty';

/**
 * Before anything of a grade runs (the header's `The house counts`): throw HouseCountsFault, the note logged first, where
 * the counts the grade must write cannot be written now, so it spends no execution or sandbox pod on an entry it cannot
 * score. The same question houseCountsLogOf asks after the executions, asked of an empty manifest with a store that
 * keeps nothing (program.ts houseCountsOutputs; the reading EntryFacts.entry_link_reading, none named the same fault):
 * a record of another platform than the plan's link, none, one that read no post or video, a reading absent or that
 * read nothing. Nothing where the plan names no counts path or the grade is a local one (no record handed).
 */
export async function houseCountsBeforeRun(req: HouseCountsRequest, label: string): Promise<void> {
  const path = req.plan.houseCounts ?? null;
  if (path === null || req.entry.entry_link === undefined) return;
  const note = req.onHouseCounts ?? ((line: string) => console.log(houseDossierLine(label, line)));
  const reading = req.entry.entry_link_reading;
  let why: string;
  let mend = HOUSE_COUNTS_REDRIVE;
  if (reading === undefined) {
    why = `no house counts at /output/${path}: the grade names no reading of its entry link to write (EntryFacts.entry_link_reading), the house's fault and never the entrant's`;
  } else {
    const dry = await houseCountsOutputs({ format: PROGRAM_OUTPUTS_FORMAT, files: [] }, path, req.entry.entry_link, reading, { put: async () => ({ sha256: DRY_COUNTS_SHA256 }) }, req.plan.houseCountsPlatform ?? null, req.plan.houseCountsCounted ?? null, req.entry.entry_link_refused ?? null, req.plan.houseCountsPosts ?? null);
    if (!dry.fault) return;
    why = dry.note.endsWith(NOTHING_WRITTEN_YET) ? dry.note.slice(0, -NOTHING_WRITTEN_YET.length) : dry.note;
    mend = houseCountsMendOf(req.entry.entry_link, reading, req);
  }
  const said = `${why}; asked before the entry's program ran, so nothing was executed; ${mend}`;
  note(said);
  throw new HouseCountsFault(`house counts fault: ${said}`);
}

/**
 * What houseCountsLogOf reads of a grade's request: the plan's counts path, its entry link's platform (absent on a
 * hand-built plan: no platform compared) and a make.fun link's count (HarnessPlan.houseCountsCounted: 'all' writes a
 * found free bounty's entry fee '0.00'; absent, the paying rule), whether the link is an X pool link's (HarnessPlan
 * .houseCountsPosts: true writes the list of posts' file; absent, as false), the entry's record and which reading, the
 * blob store, and where its note goes.
 */
export interface HouseCountsRequest {
  plan: Pick<HarnessPlan, 'houseCounts'> & Partial<Pick<HarnessPlan, 'houseCountsPlatform' | 'houseCountsCounted' | 'houseCountsPosts'>>;
  entry: Pick<EntryFacts, 'entry_link' | 'entry_link_reading' | 'entry_link_refused'>;
  blobs: Pick<OutputBlobs, 'put'>;
  onHouseCounts?: (note: string) => void;
}

/**
 * The action log a grade scores and records under a counts path (the header's `The house counts`): `graded` (the
 * log houseDossierLogOf answered) as it is where its plan names none (harnesses.ts HarnessPlan.houseCounts); else the
 * one program.ts houseCountsOutputs makes of it, the file at the path the counts (a video's, a post's, a bounty list's, or
 * an X pool entry's list of posts' under HarnessPlan.houseCountsPosts) of
 * the entry's record's reading EntryFacts.entry_link_reading. Counts the house cannot write (HouseCountsOutputs.fault: a
 * record of another platform than HarnessPlan.houseCountsPlatform among them; or no reading named)
 * throw HouseCountsFault, the note logged first: never the entrant's fail. A grade handed no record at all
 * (EntryFacts.entry_link undefined: a local grade, which has no intake) leaves the program's own file standing and says
 * so. Called after houseDossierLogOf, once the two executions' logs are compared and before scoring; an L2 regrade calls
 * it on its re-execution before comparing with the recorded log.
 */
export async function houseCountsLogOf(
  req: HouseCountsRequest,
  graded: { log: unknown; json: string | null; sha256: string | null },
  label: string,
): Promise<{ log: unknown; json: string | null; sha256: string | null }> {
  // Read as possibly absent: a hand-built plan (a test's cast) carries no field, and is a plan naming none.
  const path = req.plan.houseCounts ?? null;
  if (path === null) return graded;
  const note = req.onHouseCounts ?? ((line: string) => console.log(houseDossierLine(label, line)));
  if (req.entry.entry_link === undefined) {
    // An X pool link's counts are a list file (makefun/x-posts-counts/v1), a row each post the entry's list names.
    const whose = req.plan.houseCountsPosts === true ? 'each post its list names (makefun/x-posts-counts/v1, a row a post)' : 'the video, post or bounty';
    note(`a local grade: the house writes its entry link's counts at /output/${path} from the readings it takes of ${whose} (the check's on dev, the deadline one on the final); here the program's own file there (if any) stands`);
    return graded;
  }
  const redrive = HOUSE_COUNTS_REDRIVE;
  const reading = req.entry.entry_link_reading;
  if (reading === undefined) {
    const why = `no house counts at /output/${path}: the grade names no reading of its entry link to write (EntryFacts.entry_link_reading), the house's fault and never the entrant's; ${redrive}`;
    note(why);
    throw new HouseCountsFault(`house counts fault: ${why}`);
  }
  // A record of another platform than the plan's entry link is the house's fault (HouseCountsOutputs.fault), never that platform's counts.
  const made = await houseCountsOutputs(graded.log, path, req.entry.entry_link, reading, req.blobs, req.plan.houseCountsPlatform ?? null, req.plan.houseCountsCounted ?? null, req.entry.entry_link_refused ?? null, req.plan.houseCountsPosts ?? null);
  if (made.fault) {
    const why = `${made.note}; ${houseCountsMendOf(req.entry.entry_link, reading, req)}`;
    note(why);
    throw new HouseCountsFault(`house counts fault: ${why}`);
  }
  note(made.note);
  return { log: made.outputs, json: made.json, sha256: made.sha256 };
}

/** The line a grade logs when its scorer's breakdown made no trace (GradeRequest.onTraceIssue's default). */
export function traceIssueLine(label: string, issue: string): string {
  return `[grade] ${label}: no trace is stored, the score standing as without one: ${issue}`;
}

/** Every runtime image the plan needs is present (or the driver refuses), before anything runs. */
export async function preflight(plan: HarnessPlan, sandbox: Sandbox, runtime: Runtime, imageDigest: string | null): Promise<void> {
  if (!plan.runtimes.includes(runtime)) throw new SandboxError(`the competition does not accept ${runtime} (accepts ${plan.runtimes.join(', ')})`);
  await sandbox.preflight(runtime, imageDigest);
  for (const r of plan.extraRuntimes) await sandbox.preflight(r);
}

/** A grade that fails before anything runs (no entrypoint, a runtime the competition refuses): the entry's failure, recorded like any other. */
export function refusedGrade(plan: HarnessPlan, error: string): GradeOutcome {
  const at = new Date();
  return {
    status: 'failed',
    error,
    executions: [],
    action_log_json: null,
    action_log_sha256: null,
    result: null,
    result_sha256: null,
    trace_json: null,
    trace_sha256: null,
    flags: [],
    wall_ms: 0,
    stderr: Buffer.alloc(0),
    image_digest: null,
    harness_version: harnessVersion(),
    scorer_version: plan.scorerVersion,
    dataset_sha256: plan.datasetSha256,
    seed: plan.seed,
    fail_key: plan.failKey,
    exec_count: 0,
    started_at: at,
    finished_at: at,
  };
}

/**
 * The run flag a grade executed once carries (GradeRequest.executions 1: a bundle naming run_once; the header's `Once`):
 * its one execution's log was scored with no second execution to hold it to, so the grade's `finished` claims no
 * reproduction; an L2 regrade of the run is its first second execution. Beside the score, never in it (regrade.ts
 * RUN_ONLY_FLAGS, so an L1 rebuilds the score without it). Public: it says nothing but how the run ran.
 */
export const EXECUTED_ONCE_FLAG = 'executed_once';

/**
 * Grade an entry: execute twice (once under GradeRequest.executions 1), compare the canonical action logs, score execution 1's. With an owner, what an
 * earlier attempt of it left under the work root goes first (reapGradeScratch), and this one's scratch is named for it.
 * Under a signal that aborts before it ends (GradeRequest.signal; the header's `Stopping`) it rejects with the signal's
 * reason, the program running killed and nothing more run: no outcome, so nothing to record. Everything of its
 * scratch it removed (its executions', its scorer's, what it reaped) is released from the sandbox's daemon in one go
 * once the outcome is built or the grade threw (releaseScratch; the header's Releasing), and a release changes
 * neither: it never throws.
 */
export async function gradeEntry(req: GradeRequest): Promise<GradeOutcome> {
  const removed: string[] = [];
  try {
    return await gradeIn(req, removed);
  } catch (err) {
    // Whatever stopped it (its scorer's fault quoting outputs the entry wrote, say) says none of the entry's secrets.
    throw redactThrown(err, entrySecretForms(req.snapshot.secrets));
  } finally {
    await releaseScratch(req.sandbox, removed);
  }
}

/** gradeEntry's grade, every scratch dir it removes handed to `removed` (for its one release). */
async function gradeIn(req: GradeRequest, removed: string[]): Promise<GradeOutcome> {
  const { signal } = req;
  if (req.executions !== undefined && req.executions !== 1 && req.executions !== 2) throw new TypeError(`a grade executes its entry once or twice (GradeRequest.executions 1 or 2), not ${String(req.executions)}`);
  // Under run_once (GradeRequest.executions 1; the header's `Once`), execution 1 alone.
  const once = req.executions === 1;
  signal?.throwIfAborted();
  const startedAt = new Date();
  const label = req.label ?? 'grade';
  const owner = req.owner === undefined ? undefined : await checkGradeOwner(req.owner);
  if (owner !== undefined) {
    const reaped = await reapGradeScratch(req.sandbox, req.workRoot, owner, removed);
    req.onScratchReap?.(reaped);
  }
  await preflight(req.plan, req.sandbox, req.runtime, null);
  // The house counts, asked before anything runs (the header's `The house counts`): counts it cannot write stop the
  // grade here, no execution spent.
  await houseCountsBeforeRun(req, label);
  // The entry's verified launch (entryLinkFactsOf), read once: a program/v1 score carries it
  // (contracts/score.ts ProgramPerformance.entry_link), so the board reads the launch off the score. Null for every
  // other record and for none at all: nothing changes.
  const launch = entryLinkFactsOf(req.entry.entry_link);
  const base = {
    plan: req.plan,
    sandbox: req.sandbox,
    runtime: req.runtime,
    snapshot: req.snapshot,
    limits: req.limits,
    workRoot: req.workRoot,
    blobs: req.blobs,
    imageDigest: null,
    ...(owner === undefined ? {} : { owner }),
    ...(signal === undefined ? {} : { signal }),
    released: removed,
  };
  const executions: Execution[] = [];
  const first = await executeOnce({ ...base, label: `${label}-1` });
  executions.push(first);
  // Execution 1's log told before anything else runs (GradeRequest.onFirstExecution): a caller's hook, never the grade's.
  if (first.status === 'ok' && first.log_json !== null && first.log_sha256 !== null && req.onFirstExecution !== undefined) {
    try {
      req.onFirstExecution({ json: first.log_json, sha256: first.log_sha256 });
    } catch {
      // Dropped: the grade runs as it would without the hook.
    }
  }
  if (first.status === 'ok' && !once) executions.push(await executeOnce({ ...base, label: `${label}-2` }));
  // The action log the grade records: execution 1's, or under a house dossier the one houseDossierLogOf makes of it.
  let actionLog: { json: string | null; sha256: string | null } = { json: first.log_json, sha256: first.log_sha256 };

  const outcome = (status: GradeStatus, error: string | null, stderr: Buffer): Omit<GradeOutcome, 'result' | 'result_sha256' | 'trace_json' | 'trace_sha256'> => ({
    status,
    error,
    executions: executions.map(summarize),
    action_log_json: actionLog.json,
    action_log_sha256: actionLog.sha256,
    flags: [...new Set(executions.flatMap((e) => e.flags))].sort(),
    wall_ms: executions.reduce((s, e) => s + e.wall_ms, 0),
    stderr,
    // A plan naming its own image (patch/v1's bounty image) ran in that one; the process driver runs in none.
    image_digest: req.sandbox.imageDigest(req.runtime) === null ? null : (req.plan.imageDigest ?? req.sandbox.imageDigest(req.runtime)),
    harness_version: harnessVersion(),
    scorer_version: scorerVersionOf(req.plan, req.sandbox),
    dataset_sha256: req.plan.datasetSha256,
    seed: req.plan.seed,
    fail_key: req.plan.failKey,
    exec_count: executions.length,
    started_at: startedAt,
    finished_at: new Date(),
  });

  const bad = executions.find((e) => e.status !== 'ok');
  if (bad !== undefined) {
    const n = executions.indexOf(bad) + 1;
    // No score, and no action log either: a run carries one exactly when it was scored.
    return {
      ...outcome(bad.status === 'timeout' ? 'timeout' : 'failed', `execution ${n}: ${bad.error}`, bad.stderr),
      action_log_json: null,
      action_log_sha256: null,
      result: null,
      result_sha256: null,
      trace_json: null,
      trace_sha256: null,
    };
  }
  // Executed once, nothing to compare: deterministic as far as this grade knows, and the run says so (EXECUTED_ONCE_FLAG).
  const second = once ? first : executions[1]!;
  const deterministic = first.log_json === second.log_json;
  const status: GradeStatus = deterministic ? 'finished' : 'nondeterministic';
  const error = deterministic ? null : `the two executions' action logs differ (${first.log_sha256} vs ${second.log_sha256})`;
  // The house dossier (the header's `The house dossier`), once the two logs are compared as the program wrote them: the
  // log scored and recorded is the one whose file at the bundle's dossier path is the house's.
  const dossier = await houseDossierLogOf(req, first, label);
  // The house counts (the header's `The house counts`), after the dossier and before scoring: the file at the bundle's
  // counts path is the counts the house read of the entry's video, post or bounty.
  const graded = await houseCountsLogOf(req, dossier, label);
  actionLog = { json: graded.json, sha256: graded.sha256 };
  const log = req.plan.parseLog(graded.log);
  // The run time the scorer may read (program.ts RUN_FILE): the executions' total and count, as record.ts stores them
  // (run.wall_ms, run.exec_count), so an L1 regrade hands the scorer the same (regrade.ts rescore).
  const run = { wall_ms_total: executions.reduce((s, e) => s + e.wall_ms, 0), executions: executions.length };
  const scored = await scoreOnce(req.plan, { sandbox: req.sandbox, blobs: req.blobs, limits: req.limits, run }, req.workRoot, log, owner, signal, removed);
  const partial = outcome(status, error, first.stderr);
  const result = buildScore(
    {
      harness: { kind: req.plan.kind, version: partial.harness_version },
      image_digest: partial.image_digest,
      dataset_sha256: partial.dataset_sha256,
      seed: partial.seed,
      deterministic,
      execution_flags: partial.flags,
      house: req.entry.house,
      baseline: req.entry.baseline,
    },
    {
      action_log_sha256: actionLog.sha256!,
      // The entry's launch (contracts/score.ts ProgramEntryLinkScore), which the score carries: a house fact read from
      // the submission's record before grading, so the board reads it off the score and an L1 regrade rebuilds it
      // (regrade.ts rescore).
      performance: launch === null || scored.performance.kind !== 'program/v1' ? scored.performance : { ...scored.performance, entry_link: launch },
      performance_flags: scored.flags,
      cost: req.cost,
      authorship: req.authorship,
      size: req.size,
    },
    req.rules,
    partial.scorer_version,
  );
  // The trace is encoded apart from the score: buildScore never sees it, so result and result_sha256 are what they were without it.
  const trace = scored.trace === undefined ? null : encodeTrace(scored.trace);
  // A breakdown that made no trace never fails the grade (harnesses.ts Scored.traceIssue): said, and the run stores none.
  if (scored.traceIssue !== undefined) (req.onTraceIssue ?? ((issue: string) => console.warn(traceIssueLine(label, issue))))(scored.traceIssue);
  // A once grade's flag goes on the run after its score is built (the header's `Once`): beside the score, never in it.
  const flags = once ? [...new Set([...partial.flags, EXECUTED_ONCE_FLAG])].sort() : partial.flags;
  return { ...partial, flags, finished_at: new Date(), result, result_sha256: scoreDigest(result).sha256, trace_json: trace?.json ?? null, trace_sha256: trace?.sha256 ?? null };
}

// ---------------------------------------------------------------- the entry's launch block
//
// performance.entry_link (contracts/score.ts ProgramEntryLinkScore) is the entry's own fact, never the
// scorer's: the submission's stored entry-link record (server/db/schema.ts EntryLinkRecord, written once at
// intake by the entry-link stage) is read here into the score a run stores (gradeEntry, from EntryFacts
// .entry_link; record.ts recordGrade fills one still absent from the row it records; regrade.ts rescore, from
// the record it is handed or the stored run's). A record that is no pumpfun record, or whose launch was not
// verified (created_ms or elapsed_ms null), leaves the score without the key: no grade, regrade or verify
// fails for a missing record.

/**
 * What the grader reads of a submission's stored entry-link record (server/db/schema.ts EntryLinkRecord): the
 * platform, and a pumpfun record's house-verified launch facts. Structural and all-optional, because the
 * record is a union by platform and a record stored before it carries none of these fields.
 */
export interface EntryLinkRecordFacts {
  platform?: unknown;
  mint?: unknown;
  created_ms?: unknown;
  elapsed_ms?: unknown;
  /** The create transaction's slot (see EntryLinkRecord): absent on a record written before the house read it. */
  slot?: unknown;
}

/**
 * `performance` with its entry's launch block (contracts/score.ts ProgramEntryLinkScore at performance.entry_link),
 * a program/v1 performance's alone: the same value when there is none, one is already there, or the performance
 * is another harness kind's. Every score before the key keeps its bytes.
 */
export function withEntryLink(performance: PerformanceT, entryLink: ProgramEntryLinkScoreT | null | undefined): PerformanceT {
  if (entryLink === undefined || entryLink === null || performance.kind !== 'program/v1' || performance.entry_link !== undefined) return performance;
  return { ...performance, entry_link: entryLink };
}

/** The launch block a stored score carries (performance.entry_link), when it is a program/v1 score's: undefined when it carries none, or it does not read. */
export function entryLinkOfScore(score: unknown): ProgramEntryLinkScoreT | undefined {
  const performance = (score as { performance?: unknown } | null | undefined)?.performance;
  if (performance === null || typeof performance !== 'object') return undefined;
  const p = performance as { kind?: unknown; entry_link?: unknown };
  if (p.kind !== 'program/v1') return undefined;
  const parsed = ProgramEntryLinkScore.safeParse(p.entry_link);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `score` with performance.entry_link filled from the submission's stored entry-link record (withEntryLink), and the
 * digest it had when there was nothing to fill: the same score and result_sha256 then, byte for byte. What
 * record.ts recordGrade stores (the record is read from the row it records) so a grade's score carries the block
 * without any scorer seeing it; a null score stays null. A record that does not read changes nothing.
 */
export function scoreWithEntryLink(score: ScoreT | null, resultSha256: string | null, record: unknown): { result: ScoreT | null; result_sha256: string | null } {
  if (score === null) return { result: null, result_sha256: null };
  const performance = withEntryLink(score.performance, entryLinkFactsOf(record));
  if (performance === score.performance) return { result: score, result_sha256: resultSha256 };
  const result: ScoreT = { ...score, performance };
  return { result, result_sha256: scoreDigest(result).sha256 };
}

/**
 * A program/v1 score built again with a timing verdict (score.ts ScoredInputs.timing: grader/code-heat.ts's heat, or
 * the dev phase's provisional timing): the score's own facts and inputs as they were (its performance's scores and
 * entry-link block, without the passed and the timing it was built with; its cost, authorship and size; its flags),
 * the entry's facts and the rules given, so only performance.passed, performance.timing and the eligibility move.
 * buildScore's TypeError for a verdict on an entry that did not pass. What grader/worker.ts writes on a timed run.
 */
export function scoreWithTiming(score: ScoreT, timing: TimingVerdictT, entry: EntryFacts, rules: EligibilityRules): { result: ScoreT; result_sha256: string } {
  const perf = score.performance;
  if (perf.kind !== 'program/v1') throw new TypeError(`a timing verdict is a program/v1 score's, and this score is ${perf.kind}`);
  const result = buildScore(
    {
      harness: score.harness,
      image_digest: score.image_digest,
      dataset_sha256: score.dataset_sha256,
      seed: score.seed,
      deterministic: !score.flags.includes('nondeterministic'),
      execution_flags: score.flags.filter((f) => f !== 'nondeterministic'),
      house: entry.house,
      baseline: entry.baseline,
    },
    {
      action_log_sha256: score.action_log_sha256,
      // The entry's launch block rides with the performance: the timing rebuild moves passed, timing and eligibility
      // alone, so a timed run's score keeps it (contracts/score.ts ProgramPerformance.entry_link).
      performance: { kind: perf.kind, scores: perf.scores, ...(perf.entry_link === undefined ? {} : { entry_link: perf.entry_link }) },
      performance_flags: [],
      cost: score.cost,
      authorship: score.authorship,
      ...(score.size === undefined ? {} : { size: score.size }),
      timing,
    },
    rules,
    score.scorer_version,
  );
  return { result, result_sha256: scoreDigest(result).sha256 };
}
