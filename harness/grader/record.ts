// Recording grading outcomes: the grader (this process), never a container, writes the run row.
//
//   recordGrade     one `grade` run: status, every digest (image, dataset, harness_version,
//                   scorer_version, seed, action log), the fail key, exec_count, wall_ms, the score
//                   JSON and its sha256, the execution flags, the stderr blob, the trace blob;
//                   attempt = previous grade runs of the submission in the phase + 1; and on a judged dev
//                   grade the provisional judge heat record its verdict came from (run.judge_heat_sha256:
//                   GradeLinks, grader/worker.ts withProvisionalJudge), in the same insert, so the run is
//                   never seen with its verdict and no record to rebuild it from; and on a program/v1 grade
//                   under a bundle naming a judge, the judged artifact's manifest row in its action log
//                   (run.judge_output_row: judgeOutputRowOf over the action log in hand, at the path
//                   GradeLinks.judge_artifact names from the caller's bundle), so a judge heat's field read
//                   reads no action log for it (grader/worker.ts judgeHeatFieldRead). Any fault deriving it
//                   writes null and the grade is recorded as ever
//   recordRegrade   one `regrade_l1` / `regrade_l2` run pointing at the run it re-derives, with the
//                   fail key it re-derived it under, the trace it recomputed, the code-fastest heat
//                   record it took the timing from (run.code_heat_sha256: RegradeOutcome.code_heat_sha256,
//                   null when it read none) and the judge heat record it took the verdict from
//                   (run.judge_heat_sha256: RegradeOutcome.judge_heat_sha256, null when it read none)
//   loadStoredRun   a run row as regrade.ts reads it, its fail key and trace blob included, and on a
//                   code-fastest or judged run what its timing or verdict is rebuilt from (regrade.ts
//                   timingVerdictOf, judgeVerdictOf): the entry it grades (submission_id: the id the heat
//                   record names it by, so two entries on one graded action log stay apart) and the heat
//                   record it links (code_heat_sha256, judge_heat_sha256)
//
// An agent/v1 grade run (grader/worker.ts: K trials, contracts/agent.ts) is written in steps instead,
// as its jobs move it:
//
//   startRun        its row, status running, before any trial runs: every digest known at the start
//                   (image, dataset, harness_version, scorer_version, seed); attempt as recordGrade's.
//                   Under an id the caller derives from its grade job (server/jobs.ts agentRunId), and
//                   ON CONFLICT DO NOTHING, so a retried grade job finds the run it made. A practice top-up's
//                   (StartedRun.topUp) is kind `top_up`, attempt 1 (it takes no grade attempt), and its
//                   practice_top_up row goes in the same transaction: a round another run holds already, whatever
//                   that run's end, writes neither (TopUpRoundTakenError)
//   insertTrials    its K run_trial rows, pending (ON CONFLICT DO NOTHING on run and trial index), each
//                   tagged with its place in the grade-trial queue in the same transaction (`queue tags`)
//   moveTrial       one trial row from the state it was read in to the next: written only while the
//                   row is still in that state (its status, attempt and replay start), so of two
//                   attempts racing on one trial exactly one moves it; null for the other
//   addRunFlags     run flags a trial raises (trial_held, gateway_spend_mismatch), kept sorted and
//   dropRunFlag     once each; and one taken off again (trial_held, once no trial is held)
//   finishRun       the verdict once every trial is done: status, the action log (the trials
//                   manifest) and its blob, the score and its sha256, the run's checks trace blob
//                   (grader/agent-score.ts agentChecksBreakdown, when its trials' rows make one),
//                   exec_count, wall_ms, the error; written only while the run is running, so a
//                   second fan-in writes nothing; a trial it never started (a cancelled run's) leaves
//                   the queue in the same transaction (closeUnstartedTrials, `queue tags`), and one
//                   the run's end leaves mid-pass (live_running, live_done, replaying) is voided as
//                   run_cancelled (closeCutOffTrials): no row of a run that no longer runs says a
//                   pass is in flight, and its cancelled trial job never moves it again
//
// A dev run on practice windows (contracts/competition.ts Phase.practice_windows; grader/worker.ts gradeEras) is written
// in those steps too, startRun and finishRun, with one `run_era` row a window between them:
//
//   recordEra       one window's row (run, window key, its dataset and seed, status, exec_count, wall_ms, the
//                   error, the action log, trace and stderr blobs, the window's own Score and its sha256), the
//                   blobs first; ON CONFLICT (run, window) the row is written again, so a retried grade job
//                   that regrades a window it did not finish supersedes what it left. Written only while the run
//                   is running (its row read FOR SHARE, so finishRun waits for it or it waits for finishRun, and
//                   the conflict arm itself only while the run is running): a stale attempt or a second job
//                   that grades a window after the run is finished writes nothing (false), and never rewrites
//                   or adds to a finished run's windows
//   loadEras       a run's window rows, in window key order (what a retried grade resumes from, and an eras
//                   regrade reads its windows from)
//
// The run row is started with no dataset_sha256 and no seed (the median window is not known yet) and finishRun
// writes the median window's with the verdict (FinishedRun.median), beside the median's action log, trace and
// stderr blobs the window rows already hold. recordRegrade writes a regrade's window rows beside its run row.
//
// A scrape/v1 heat's runs (grader/worker.ts: a dev phase's practice heat, the final phase's one heat;
// contracts/scrape.ts) are written once the heat has ended, all of them in one transaction:
//
//   recordScrapeRuns  one `grade` run per entry recorded, attempt as recordGrade's: the trials
//                     manifest its action log (stored as a blob first), the heat record's canonical
//                     sha256 its dataset_sha256 (the record itself in the blob store, which the
//                     archive serves), the score, and every digest a run carries (image, the scorer's
//                     scorer_version, a harness_version naming the launcher's and the gateway's
//                     digests besides the harness source's). A scrape run has no one stderr: its
//                     stderr_sha256 names the heat's log instead (regrade.ts SCRAPE_HEAT_LOG_FORMAT,
//                     grader/worker.ts scrapeHeatLog, stored by the caller): the heat's reference read (the cassette every
//                     trial was judged against at /reference/heat/, which an L1 regrade rebuilds),
//                     the CA's digest, every attempt (warm-ups and voids included, each trial's tails
//                     and cassette named) and each run's scorer faults with its unjudged trials. So the
//                     runs of one heat share their dataset_sha256 and their stderr_sha256. Each run's
//                     entry secrets (ScrapeRunRecord's RunSecrets, below) go with its row: the rows its
//                     trials ran with, and where its outputs held one, in the same transaction. A final
//                     phase of a scrape/v1 competition runs one heat: the transaction locks each such phase's
//                     row (FOR NO KEY UPDATE, in id order) and reads again whether its heat is recorded (a
//                     grade run of the phase naming a dataset_sha256, as grader/worker.ts's scrape-heat job
//                     reads it), so a second job's heat (a resend, or a retry beside a live attempt) recorded
//                     after the first writes nothing: ScrapeHeatRecordedError, the first heat's runs standing.
//                     A dev phase's practice heats are each their grade job's own: a new attempt, as ever
//
// A grade run carries a rehost rejection. The rehost desk's 'rejected' decision (server/routes/admin/rehosts.ts)
// writes REHOST_REJECTED_FLAG (server/payouts/standings.ts) on every grade and top_up run of the entry on the final phase,
// a running one included (flagRehostRejection); recordGrade, recordScrapeRuns and startRun add it to a new grade
// or top_up run's flags, and finishRun to the run it finishes, when a grade run of the submission in the phase carries it
// (at the finish the run's own row among them), in code-unit order with the rest. So neither a regrade, whose
// run is the newest attempt the standings and the board read, nor a run that was in flight as the rejection
// landed ever puts a rejected entry back. The two sides never miss each other: each of those four locks its
// entries FOR KEY SHARE (lockEntries, the lock the run row's foreign key takes anyway) before it reads what it
// inherits, and the rejection locks the entry FOR UPDATE before it flags, so whichever commits second sees the
// other's write. No other flag is carried over.
//
// The canonical action log and the captured stderr go to the blob store first (content addressed,
// so recording twice stores them once); the action log blob's name is run.action_log_sha256.
//
// Entry secrets (RunSecrets: GradeLinks, recordRegrade's last argument, ScrapeRunRecord, StartedRun.entrySecretIds,
// recordEra's mask): a run records the entry_secret rows its executions of the entry ran with
// (run.entry_secret_ids, ids only, null for none: grader/worker.ts opens them), and its stderr blob and
// error are masked of every form of their values before either is stored (putStderr: grader/run.ts
// maskStderr, SECRET_MARK; the error redactSecrets, REDACTED_MARK), a window's row alike, whatever masked
// them before (grade.ts executeOnce already does). The action log never is: a hit worker.ts's scan of it
// and the outputs found (RunSecrets.secret_hits) flags the run secret_in_output (SECRET_IN_OUTPUT_FLAG, in
// run.flags beside the score's, never in it: regrade.ts RUN_ONLY_FLAGS) beside a SECRET_IN_OUTPUT_ACTION
// audit row naming each secret's NAME and the file, in the transaction that writes the run.
//
// So does the trace (contracts/breakdown.ts; grader/trace.ts) a run's outcome carries (a replay's, a
// program/v1 scorer's checks trace, and an agent/v1 run's checks trace as finishRun gets it): its
// canonical JSON gzip-compressed (traceBlob), stored as stderr is, its name (the sha256 of the stored
// gzip bytes, which the outcome's trace_sha256 must be) in run.trace_sha256, beside run.result and never
// inside it, so result_sha256 never moves with it. A run with no trace (nothing scored, a harness with
// none, a scorer that writes no checks.json or rows that make none, a scrape heat's) keeps trace_sha256
// null.
//
// run.fail_key is the failed-transaction draw's key (the action log does not carry it): stored, a
// regrade reuses it instead of deriving it again from the server secret (grader/worker.ts), so a
// rotated secret never breaks the regrade of a final run, and the archive can publish it once the
// phase is finalized so anyone can re-score the run (server/routes/_lib/visibility.ts runFailKeyFor).
//
// Every write that lands a verdict tells the competition's live board its standings moved: recordGrade,
// recordRegrade (the board shows whether a run reproduced), recordScrapeRuns and finishRun (only when
// it wrote, and never for a top_up run, which moves no standing) owe a live change, topic `standings` and kind `grade` (GRADE_CHANGE), on the competition
// of the run's phase (server/live/changes.ts oweLiveChanges), from the transaction that writes the run
// row, as its last statement: written AFTER that transaction commits (transactionOwingLiveChanges), in a
// transaction of its own, at most one per LIVE_OWED_GAP_MS a competition across every process, the last
// one begun after every owing commit (changes.ts openLiveChangeFeed), so the grade transaction never
// takes the competition's live change key: a final's grade wave queued each grade about 655 ms on it,
// holding its connection and row locks (2026-11-22). Rolled back, nothing is owed. Nested in a caller's
// transaction (grader/worker.ts recordWithSecretsHeld opens it with transactionOwingLiveChanges too) the
// change waits for that outer commit. A transaction naming runs of several competitions (never one
// heat in practice) owes one change per competition, in id order. startRun, insertTrials, moveTrial and
// the run flags owe none: no verdict moves with them. Nor does flagRehostRejection: the desk's
// transaction it runs in records none, and the standings read the flag when next read. The blobs are stored before the
// transaction, as they always were.
//
// The counts this file makes (makefun_trial_passes_total, makefun_trial_queue_lock_seconds) go on the
// process's registry through server/ops/errors.ts countOnProcessRegistry, never a static import of
// server/ops/metrics.ts: an off-thread task's thread loads this file (server/pipeline/ingest.ts's), and
// there the registry, never scraped, would start its default collectors for nothing.

import { and, asc, count, eq, inArray, isNotNull, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm';
import { SECRET_IN_OUTPUT_FLAG } from '../contracts/entry-secrets.ts';
import type { ScoreT } from '../contracts/score.ts';
import type { BlobStore } from '../server/blobstore.ts';
import type { Tx } from '../server/comments/hub.ts';
import type { Db } from '../server/db/client.ts';
import { auditEvent, competition, entryScreen, phase, practiceTopUp, run, runEra, runTrial, RUN_STATUSES, submission, type RunJudgeOutputRow } from '../server/db/schema.ts';
import { oweLiveChanges, transactionOwingLiveChanges, type LiveChangeInput } from '../server/live/changes.ts';
import { countOnProcessRegistry } from '../server/ops/errors.ts';
import { REHOST_REJECTED_FLAG } from '../server/payouts/standings.ts';
import { compareCodeUnits } from '../sim/canonical.ts';
import type { FormSet } from './gateway/secret-mask.ts';
import { scoreWithEntryLink, type EntryLinkRecordFacts, type GradeOutcome } from './grade.ts';
import { ProgramOutputs } from './program.ts';
import type { RegradeOutcome, StoredRun } from './regrade.ts';
import { maskStderr, redactSecrets } from './run.ts';
import { traceBlob } from './trace.ts';

export interface RunIds {
  submissionId: string;
  phaseId: string;
}

async function putActionLog(blobs: Pick<BlobStore, 'put'>, json: string | null, sha256: string | null): Promise<void> {
  if (json === null || sha256 === null) return;
  const put = await blobs.put(json);
  if (put.sha256 !== sha256) throw new Error(`action log blob ${put.sha256} does not match its recorded sha256 ${sha256}`);
}

/** Store a run's stderr, masked of `mask` first (the header's entry secrets: grader/run.ts maskStderr); its blob's name, or null when there is none. */
async function putStderr(blobs: Pick<BlobStore, 'put'>, stderr: Buffer, mask: FormSet | null = null): Promise<string | null> {
  if (stderr.length === 0) return null;
  return (await blobs.put(maskStderr(stderr, mask))).sha256;
}

/** A run's error as it is stored: redacted of `mask` (grader/run.ts redactSecrets). */
function storedError(error: string | null, mask: FormSet | null | undefined): string | null {
  return error === null || mask === undefined || mask === null ? error : redactSecrets(error, mask);
}

/**
 * Store an outcome's trace (the header): the gzip of its canonical JSON, whose sha256 must be the outcome's
 * trace_sha256 (the bytes grade.ts and regrade.ts named). The blob's name, or null when the outcome has none.
 */
async function putTrace(blobs: Pick<BlobStore, 'put'>, json: string | null | undefined, sha256: string | null | undefined): Promise<string | null> {
  if (json === null || json === undefined) return null;
  const put = await blobs.put(traceBlob(json));
  if (sha256 !== null && sha256 !== undefined && put.sha256 !== sha256) throw new Error(`trace blob ${put.sha256} does not match its recorded sha256 ${sha256}`);
  return put.sha256;
}

/**
 * A new grade run's attempt (the submission's grade runs in the phase so far, plus one) and the flags it inherits from
 * them (the header): REHOST_REJECTED_FLAG when any of them carries it, else none.
 */
async function nextGrade(db: Pick<Db, 'select'>, ids: RunIds): Promise<{ attempt: number; inherited: string[] }> {
  const [prev] = await db
    .select({ n: count(), rejected: sql<boolean | null>`bool_or(${REHOST_REJECTED_FLAG}::text = any(${run.flags}))` })
    .from(run)
    .where(and(eq(run.submissionId, ids.submissionId), eq(run.phaseId, ids.phaseId), eq(run.kind, 'grade')));
  return { attempt: Number(prev?.n ?? 0) + 1, inherited: prev?.rejected === true ? [REHOST_REJECTED_FLAG] : [] };
}

/**
 * Lock the entries a transaction writes grade runs of, FOR KEY SHARE, in id order, before it reads what its runs inherit
 * (the header): the rehost desk's rejection locks the entry FOR UPDATE before it flags the entry's runs, so one of the
 * two waits for the other's commit and a run is never written beside a rejection neither saw. KEY SHARE is the lock
 * the run row's foreign key takes anyway, so it waits on nothing else.
 */
async function lockEntries(tx: Tx, submissionIds: readonly string[]): Promise<void> {
  if (submissionIds.length === 0) return;
  await tx
    .select({ id: submission.id })
    .from(submission)
    .where(inArray(submission.id, [...new Set(submissionIds)]))
    .orderBy(asc(submission.id))
    .for('key share');
}

/** A new grade run's flags with the ones it inherits (nextGrade) added: `flags` as given when it holds them all, else the union in code-unit order. */
function withInherited(flags: readonly string[], inherited: readonly string[]): string[] {
  if (inherited.every((f) => flags.includes(f))) return [...flags];
  return [...new Set([...flags, ...inherited])].sort(compareCodeUnits);
}

/** Whether any grade run of the submission in the phase carries REHOST_REJECTED_FLAG (the header): a finishing run's own row included. */
async function carriesRejection(db: Pick<Db, 'select'>, ids: RunIds): Promise<boolean> {
  return (await nextGrade(db, ids)).inherited.includes(REHOST_REJECTED_FLAG);
}

/** run.flags with `flags` added, as an update sets them: each once, the whole list in code-unit order. */
function flagsAdding(flags: readonly string[]): SQL {
  const added = sql.join(
    flags.map((f) => sql`${f}`),
    sql`, `,
  );
  return sql`array(select f from (select distinct f from unnest(${run.flags} || array[${added}]::text[]) as f) as d order by f collate "C")`;
}

/**
 * The rehost desk's rejection of an entry's patch (server/routes/admin/rehosts.ts; the header): lock the entry FOR
 * UPDATE, which waits out a run write holding lockEntries' KEY SHARE and holds the next one off until the rejection
 * commits, then add REHOST_REJECTED_FLAG to every grade run of the submission in the phase that does not carry it yet,
 * a running one included, and every top_up run of it (the rejection stands on them too), in one update. The ids of
 * the runs it flagged, in id order: none when every one carries it.
 */
export async function flagRehostRejection(tx: Tx, ids: RunIds): Promise<string[]> {
  await tx.select({ id: submission.id }).from(submission).where(eq(submission.id, ids.submissionId)).for('update');
  const rows = await tx
    .update(run)
    .set({ flags: flagsAdding([REHOST_REJECTED_FLAG]) })
    .where(and(eq(run.submissionId, ids.submissionId), eq(run.phaseId, ids.phaseId), inArray(run.kind, ['grade', 'top_up']), not(sql`${REHOST_REJECTED_FLAG}::text = any(${run.flags})`)))
    .returning({ id: run.id });
  return rows.map((r) => r.id).sort(compareCodeUnits);
}

/** The live change a landed verdict records on its competition (the header): its standings moved by a grade. */
export const GRADE_CHANGE = { topic: 'standings', kind: 'grade' } as const satisfies Omit<LiveChangeInput, 'scopeId'>;

/**
 * Owe GRADE_CHANGE on the competition of each of `phaseIds` (once per competition, in id order) from the caller's
 * transaction, after its run rows (server/live/changes.ts oweLiveChanges: written once the transactionOwingLiveChanges
 * it runs in commits, coalesced per competition): the competitions it is owed on, in that order.
 */
async function recordGradeChanges(tx: Tx, phaseIds: readonly string[]): Promise<string[]> {
  const distinct = [...new Set(phaseIds)];
  if (distinct.length === 0) return [];
  const rows = await tx.selectDistinct({ competitionId: phase.competitionId }).from(phase).where(inArray(phase.id, distinct));
  const scopes = [...new Set(rows.map((r) => r.competitionId.toLowerCase()))].sort(compareCodeUnits);
  await oweLiveChanges(tx, GRADE_CHANGE, scopes);
  return scopes;
}

/**
 * The audit_event action of a run whose outputs held a form of one of its entrant's entry secrets (the header's entry
 * secrets), the run flagged SECRET_IN_OUTPUT_FLAG beside it: the system's (actor null). On a run graded as one execution
 * (recordGrade; grader/worker.ts gradeEras for a run on practice windows) and on a scrape/v1 heat's run (recordScrapeRuns)
 * the subject is the run row, data {run_id, hits:
 * [{name, file}]}; on an agent/v1 pass it is the run_trial row (grader/worker.ts). Each hit a secret's NAME and the file it
 * turned up in, never a value.
 */
export const SECRET_IN_OUTPUT_ACTION = 'entry_secret.in_output';

/** One entry secret turning up in a run's outputs: its NAME and the file (an action log, an output's path), never the value. */
export interface SecretHit {
  name: string;
  file: string;
}

/** What a run's record holds of the entry secrets its executions of the entry ran with (the header's entry secrets). */
export interface RunSecrets {
  /** The entry_secret rows they ran with (run.entry_secret_ids), ids only; absent, null or empty: null, none recorded. */
  entry_secret_ids?: readonly string[] | null;
  /** Every form of their values (grader/run.ts entrySecretForms): masked out of the stderr blob and the error before either is stored. */
  mask?: FormSet | null;
  /** Where its outputs held one (grader/worker.ts's scan, never masked): the run flagged SECRET_IN_OUTPUT_FLAG and a SECRET_IN_OUTPUT_ACTION row written. */
  secret_hits?: readonly SecretHit[];
}

/** What a grade run links besides its outcome (recordGrade), and the entry secrets it ran with. */
export interface GradeLinks extends RunSecrets {
  /** The judge heat record a judged dev grade's provisional verdict came from (grader/worker.ts withProvisionalJudge); null or absent links none. */
  judge_heat_sha256?: string | null;
  /**
   * A program/v1 grade's judged artifact path (its bundle's harness.judge.artifact): its manifest row in the action log
   * in hand is kept as run.judge_output_row (judgeOutputRowOf). Null or absent: none kept (no judge, another harness).
   */
  judge_artifact?: string | null;
}

/** run.entry_secret_ids as written: the ids, or null for none. */
function secretIdsOf(ids: readonly string[] | null | undefined): string[] | null {
  return ids === undefined || ids === null || ids.length === 0 ? null : [...ids];
}

/** Write SECRET_IN_OUTPUT_ACTION of run `runId`'s hits in the caller's transaction (nothing with none). */
export async function recordSecretHits(tx: Pick<Db, 'insert'>, runId: string, hits: readonly SecretHit[] | undefined, at: Date = new Date()): Promise<void> {
  if (hits === undefined || hits.length === 0) return;
  await tx.insert(auditEvent).values({ at, actorUserId: null, action: SECRET_IN_OUTPUT_ACTION, subjectType: 'run', subjectId: runId, data: { run_id: runId, hits: hits.map((h) => ({ name: h.name, file: h.file })) } });
}

/** `flags` with SECRET_IN_OUTPUT_FLAG added once (code-unit order) when there are hits. */
function flagsWithHits(flags: readonly string[], hits: readonly SecretHit[] | undefined): string[] {
  if (hits === undefined || hits.length === 0) return [...flags];
  return [...new Set([...flags, SECRET_IN_OUTPUT_FLAG])].sort(compareCodeUnits);
}

/**
 * run.judge_output_row of a run whose action log is `actionLogJson` (schema.ts RunJudgeOutputRow): the manifest row of
 * output `path`, read as program.ts readOutputManifest reads the stored log (its UTF-8 bytes decoded, JSON, held to
 * ProgramOutputs), `file` null when the outputs hold no file at `path`. Null when the log is not JSON or no program's
 * outputs: no row is stored, and the field read reads the log and meets its error as ever.
 */
export function judgeOutputRowOf(actionLogJson: string, path: string): RunJudgeOutputRow | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(actionLogJson, 'utf8').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = ProgramOutputs.safeParse(raw);
  if (!parsed.success) return null;
  const f = parsed.data.files.find((x) => x.path === path);
  return { path, file: f === undefined ? null : { sha256: f.sha256, size: f.size } };
}

/**
 * The judge output row a grade records (the header's recordGrade; judgeOutputRowOf): the action log in hand read for
 * `path`, the judged artifact's path its caller's bundle names (GradeLinks.judge_artifact). Null with no path or no
 * action log, or on any fault, which is logged: a grade is never failed by it.
 */
function judgeOutputRowFor(path: string | null | undefined, actionLogJson: string | null, what: string): RunJudgeOutputRow | null {
  if (typeof path !== 'string' || actionLogJson === null) return null;
  try {
    return judgeOutputRowOf(actionLogJson, path);
  } catch (err) {
    console.warn(`[record] ${what}: the grade's judge output row is not recorded (its field read reads the action log): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Insert the run row of a grade, with its links, and its standings change, in one transaction (the header); returns its
 * id. The entry secrets it ran with (links: RunSecrets) are recorded by id, masked out of its stderr and error, and a hit
 * in its outputs flags it secret_in_output beside a SECRET_IN_OUTPUT_ACTION row, in the same transaction. The score it
 * stores carries its entry's launch block (contracts/score.ts ProgramEntryLinkScore), filled in the same transaction from
 * the submission's stored entry-link record (grade.ts scoreWithEntryLink, never the scorer's): the stored result and
 * result_sha256 are that score's, and a record that is none, not a pumpfun one, or not a verified launch changes nothing.
 */
export async function recordGrade(db: Db, blobs: Pick<BlobStore, 'put'>, outcome: GradeOutcome, ids: RunIds, links: GradeLinks = {}): Promise<string> {
  await putActionLog(blobs, outcome.action_log_json, outcome.action_log_sha256);
  const judgeOutputRow = outcome.action_log_sha256 === null ? null : judgeOutputRowFor(links.judge_artifact, outcome.action_log_json, `submission ${ids.submissionId}'s grade on phase ${ids.phaseId}`);
  const stderrSha256 = await putStderr(blobs, outcome.stderr, links.mask ?? null);
  const traceSha256 = await putTrace(blobs, outcome.trace_json, outcome.trace_sha256);
  return transactionOwingLiveChanges(db, async (tx) => {
    await lockEntries(tx, [ids.submissionId]);
    // The entry's launch facts, from its own stored record (the entry-link stage wrote it once, at intake, before the
    // grade); the score stored with the run carries the block, so the row and its digest are the outcome's except for it.
    const [entry] = await tx.select({ entryLink: submission.entryLink }).from(submission).where(eq(submission.id, ids.submissionId));
    const stored = scoreWithEntryLink(outcome.result, outcome.result_sha256, entry?.entryLink ?? null);
    const { attempt, inherited } = await nextGrade(tx, ids);
    const [row] = await tx
      .insert(run)
      .values({
        submissionId: ids.submissionId,
        phaseId: ids.phaseId,
        kind: 'grade',
        attempt,
        status: outcome.status,
        imageDigest: outcome.image_digest,
        datasetSha256: outcome.dataset_sha256,
        harnessVersion: outcome.harness_version,
        scorerVersion: outcome.scorer_version,
        seed: outcome.seed,
        failKey: outcome.fail_key,
        actionLogSha256: outcome.action_log_sha256,
        judgeOutputRow,
        execCount: outcome.exec_count,
        wallMs: outcome.wall_ms,
        result: stored.result,
        resultSha256: stored.result_sha256,
        traceSha256,
        judgeHeatSha256: links.judge_heat_sha256 ?? null,
        flags: withInherited(flagsWithHits(outcome.flags, links.secret_hits), inherited),
        entrySecretIds: secretIdsOf(links.entry_secret_ids),
        stderrSha256,
        error: storedError(outcome.error, links.mask),
        startedAt: outcome.started_at,
        finishedAt: outcome.finished_at,
      })
      .returning({ id: run.id });
    await recordSecretHits(tx, row!.id, links.secret_hits, outcome.finished_at);
    await recordGradeChanges(tx, [ids.phaseId]);
    return row!.id;
  });
}

/**
 * Insert the run row of a regrade (the trace it recomputed stored as a grade's is, and the heat record it read linked
 * as a timed or judged grade's is) and its standings change, in one transaction (the header); returns its id. The
 * windows of an eras regrade (grader/regrade.ts regradeEras) are written in that transaction as the run's `run_era` rows.
 */
export async function recordRegrade(
  db: Db,
  blobs: Pick<BlobStore, 'put'>,
  outcome: RegradeOutcome,
  ids: RunIds,
  eras: readonly EraRecord[] = [],
  secrets: Pick<RunSecrets, 'entry_secret_ids' | 'mask'> = {},
): Promise<string> {
  const mask = secrets.mask ?? null;
  const stderrSha256 = await putStderr(blobs, outcome.stderr, mask);
  const traceSha256 = await putTrace(blobs, outcome.trace_json, outcome.trace_sha256);
  const stored = await putEras(blobs, eras, mask);
  return transactionOwingLiveChanges(db, async (tx) => {
    const [row] = await tx
      .insert(run)
      .values({
        submissionId: ids.submissionId,
        phaseId: ids.phaseId,
        kind: outcome.kind,
        attempt: 1,
        status: outcome.status,
        imageDigest: outcome.image_digest,
        datasetSha256: outcome.dataset_sha256,
        harnessVersion: outcome.harness_version,
        scorerVersion: outcome.scorer_version,
        seed: outcome.seed,
        failKey: outcome.fail_key,
        actionLogSha256: outcome.action_log_sha256,
        execCount: outcome.exec_count,
        wallMs: outcome.wall_ms,
        result: outcome.result,
        resultSha256: outcome.result_sha256,
        traceSha256,
        codeHeatSha256: outcome.code_heat_sha256 ?? null,
        judgeHeatSha256: outcome.judge_heat_sha256 ?? null,
        reproducesRunId: outcome.reproduces_run_id,
        flags: outcome.flags,
        entrySecretIds: secretIdsOf(secrets.entry_secret_ids),
        stderrSha256,
        error: storedError(outcome.error, mask),
        startedAt: outcome.started_at,
        finishedAt: outcome.finished_at,
      })
      .returning({ id: run.id });
    for (const era of stored) await insertEra(tx, row!.id, era);
    await recordGradeChanges(tx, [ids.phaseId]);
    return row!.id;
  });
}

// ---------------------------------------------------------------- a scrape/v1 heat's runs

/**
 * One run of a heat to record (recordScrapeRuns), with the entry secrets its trials ran with (RunSecrets: the header's
 * entry secrets): their rows by id, the forms its error is masked of, and where its outputs and action log held one.
 */
export interface ScrapeRunRecord extends RunIds, RunSecrets {
  /** finished: scored; failed: left unscored (its scorer faulted, the house's fault: grader/worker.ts never publishes it). */
  status: 'finished' | 'failed';
  error: string | null;
  /** The trials manifest's canonical JSON and its sha256; null when it was left unscored. */
  action_log_json: string | null;
  action_log_sha256: string | null;
  result: ScoreT | null;
  result_sha256: string | null;
  /** The run row's flags (an admin's hold: never the score's). */
  flags: string[];
  /** The entry's trial attempts (warm-ups and voids included), and its listed trials' wall time. */
  exec_count: number;
  wall_ms: number;
  image_digest: string | null;
  harness_version: string;
  scorer_version: string;
  /** The heat record's canonical sha256, and the heat log's (stderr_sha256): both already in the blob store. */
  dataset_sha256: string;
  heat_log_sha256: string;
  seed: string;
  started_at: Date;
  finished_at: Date;
}

/**
 * A heat's runs refused by recordScrapeRuns: the final phase of a scrape/v1 competition named in them has its one heat
 * recorded already (the header's recordScrapeRuns), by another job (a resend) or an earlier attempt. Nothing of this heat
 * was written; the recorded heat's runs stand, and its job answers them (grader/worker.ts's scrape-heat job reads the
 * phase's heat as recorded: a retry of this job does).
 */
export class ScrapeHeatRecordedError extends Error {
  readonly phaseId: string;
  /** The recorded heat's record (its runs' dataset_sha256). */
  readonly heatSha256: string;
  constructor(phaseId: string, heatSha256: string) {
    super(`the final phase ${phaseId} has its one scrape/v1 heat recorded already (record ${heatSha256}): this heat's runs are not recorded, the recorded heat's runs stand`);
    this.name = 'ScrapeHeatRecordedError';
    this.phaseId = phaseId;
    this.heatSha256 = heatSha256;
  }
}

/**
 * The compare-and-set of a final heat (the header's recordScrapeRuns), in the caller's transaction: lock the row of each
 * final phase of a scrape/v1 competition among `phaseIds` (FOR NO KEY UPDATE, in id order: two heats' transactions on
 * one phase take turns, and a run row's foreign key, KEY SHARE, waits on nothing), then read again whether its heat is
 * recorded (a grade run of the phase naming a dataset_sha256, as the scrape-heat job reads it); ScrapeHeatRecordedError
 * when one is.
 */
async function refuseRecordedFinalHeat(tx: Tx, phaseIds: readonly string[]): Promise<void> {
  const distinct = [...new Set(phaseIds)];
  if (distinct.length === 0) return;
  const finals = await tx
    .select({ id: phase.id })
    .from(phase)
    .innerJoin(competition, eq(competition.id, phase.competitionId))
    .where(and(inArray(phase.id, distinct), eq(phase.key, 'final'), eq(competition.harnessKind, 'scrape/v1')))
    .orderBy(asc(phase.id))
    .for('no key update', { of: phase });
  if (finals.length === 0) return;
  const [recorded] = await tx
    .select({ phaseId: run.phaseId, datasetSha256: run.datasetSha256 })
    .from(run)
    .where(and(inArray(run.phaseId, finals.map((f) => f.id)), eq(run.kind, 'grade'), isNotNull(run.datasetSha256)))
    .orderBy(asc(run.phaseId), asc(run.attempt))
    .limit(1);
  if (recorded !== undefined) throw new ScrapeHeatRecordedError(recorded.phaseId, recorded.datasetSha256!);
}

/**
 * Insert a heat's runs (the header's recordScrapeRuns) and their standings change, in one transaction: their ids, in the
 * order given. Each run's entry secrets (ScrapeRunRecord's RunSecrets) are written with it as a grade's are (recordGrade):
 * run.entry_secret_ids, its error masked, and a hit in its outputs flags it secret_in_output beside its
 * SECRET_IN_OUTPUT_ACTION row. A final phase of a scrape/v1 competition whose heat is recorded already writes nothing:
 * ScrapeHeatRecordedError (refuseRecordedFinalHeat).
 */
export async function recordScrapeRuns(db: Db, blobs: Pick<BlobStore, 'put'>, runs: readonly ScrapeRunRecord[]): Promise<string[]> {
  for (const r of runs) await putActionLog(blobs, r.action_log_json, r.action_log_sha256);
  return transactionOwingLiveChanges(db, async (tx) => {
    const ids: string[] = [];
    await lockEntries(
      tx,
      runs.map((r) => r.submissionId),
    );
    await refuseRecordedFinalHeat(
      tx,
      runs.map((r) => r.phaseId),
    );
    for (const r of runs) {
      const { attempt, inherited } = await nextGrade(tx, r);
      const [row] = await tx
        .insert(run)
        .values({
          submissionId: r.submissionId,
          phaseId: r.phaseId,
          kind: 'grade',
          attempt,
          status: r.status,
          imageDigest: r.image_digest,
          datasetSha256: r.dataset_sha256,
          harnessVersion: r.harness_version,
          scorerVersion: r.scorer_version,
          seed: r.seed,
          failKey: null,
          actionLogSha256: r.action_log_sha256,
          execCount: r.exec_count,
          wallMs: r.wall_ms,
          result: r.result,
          resultSha256: r.result_sha256,
          flags: withInherited(flagsWithHits(r.flags, r.secret_hits).sort(compareCodeUnits), inherited),
          entrySecretIds: secretIdsOf(r.entry_secret_ids),
          stderrSha256: r.heat_log_sha256,
          error: storedError(r.error, r.mask),
          startedAt: r.started_at,
          finishedAt: r.finished_at,
        })
        .returning({ id: run.id });
      await recordSecretHits(tx, row!.id, r.secret_hits, r.finished_at);
      ids.push(row!.id);
    }
    await recordGradeChanges(tx, runs.map((r) => r.phaseId));
    return ids;
  });
}

/**
 * A run row as regrade.ts reads it (the header), or null when there is none. A code-fastest or judged run carries what
 * its regrade rebuilds the timing or verdict from (regrade.ts timingVerdictOf, judgeVerdictOf): its heat record's link,
 * and its entry's id, which picks its entry out of the record's field where another entry shares its graded action log.
 * It carries its submission's stored entry-link record besides (entry_link), from which a program/v1 regrade re-derives
 * performance.entry_link (contracts/score.ts ProgramEntryLinkScore; the header's entry link): the record is stored once,
 * at intake, so the regrade reads the same value the grade did.
 */
export async function loadStoredRun(db: Db, runId: string): Promise<(StoredRun & RunIds) | null> {
  const [r] = await db.select().from(run).where(eq(run.id, runId));
  if (r === undefined) return null;
  const [s] = await db.select({ entryLink: submission.entryLink }).from(submission).where(eq(submission.id, r.submissionId));
  return {
    id: r.id,
    submissionId: r.submissionId,
    phaseId: r.phaseId,
    submission_id: r.submissionId,
    code_heat_sha256: r.codeHeatSha256,
    judge_heat_sha256: r.judgeHeatSha256,
    status: r.status,
    harness_version: r.harnessVersion,
    scorer_version: r.scorerVersion,
    image_digest: r.imageDigest,
    dataset_sha256: r.datasetSha256,
    seed: r.seed,
    fail_key: r.failKey,
    action_log_sha256: r.actionLogSha256,
    result: r.result,
    result_sha256: r.resultSha256,
    flags: r.flags,
    stderr_sha256: r.stderrSha256,
    wall_ms: r.wallMs,
    exec_count: r.execCount,
    trace_sha256: r.traceSha256,
    entry_secret_ids: r.entrySecretIds,
    entry_link: (s?.entryLink ?? null) as EntryLinkRecordFacts | null,
  };
}

// ---------------------------------------------------------------- an agent/v1 grade run

export type RunRow = typeof run.$inferSelect;
export type TrialRow = typeof runTrial.$inferSelect;

/** What an agent/v1 grade run, or a dev run on practice windows, states as it starts (startRun): every digest known before a trial or window runs. */
export interface StartedRun extends RunIds {
  /** The run's id: server/jobs.ts agentRunId of the grade job that starts it. */
  id: string;
  /** `sha256:<hex>` of the entry's image (null for the process driver): what every trial runs it in. */
  imageDigest: string | null;
  /** The digest of the instances its trials run on (grader/worker.ts agentDatasetSha256); null on an eras run, whose median window is not known yet (FinishedRun.median). */
  datasetSha256: string | null;
  harnessVersion: string;
  scorerVersion: string;
  /** The run's seed; null on an eras run, as its dataset_sha256 is. */
  seed: string | null;
  startedAt: Date;
  /**
   * The entry_secret rows every execution of the run runs the entry with (run.entry_secret_ids: an eras run's windows,
   * the header's entry secrets); absent, null or empty: null. An agent/v1 run's trials record their own (run_trial).
   */
  entrySecretIds?: readonly string[] | null;
  /** A practice top-up's round as its job carries it (server/jobs.ts GradeJob.top_up): the run is kind top_up, its practice_top_up row written with it. */
  topUp?: Pick<typeof practiceTopUp.$inferInsert, 'round' | 'units' | 'linePointsSum' | 'lineUnits' | 'lineRank' | 'within'>;
}

/** A practice top-up's round that another run holds already (startRun): nothing was written. */
export class TopUpRoundTakenError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`that entry and round has a run (${runId})`);
    this.name = 'TopUpRoundTakenError';
    this.runId = runId;
  }
}

/**
 * Insert an agent/v1 grade run's row, status running (see the header); `inserted` is false when the
 * row is there already (a retried grade job's run). A row under the id that is another submission's,
 * phase's or kind's is an Error: the id names this grade's run only. A top-up's row goes in with it, or
 * TopUpRoundTakenError when another run holds its round, the transaction then writing nothing.
 */
export async function startRun(db: Db, r: StartedRun): Promise<{ id: string; inserted: boolean }> {
  const kind = r.topUp === undefined ? 'grade' : 'top_up';
  return db.transaction(async (tx) => {
    await lockEntries(tx, [r.submissionId]);
    const { attempt, inherited } = await nextGrade(tx, r);
    const rows = await tx
      .insert(run)
      .values({
        id: r.id,
        submissionId: r.submissionId,
        phaseId: r.phaseId,
        kind,
        attempt: r.topUp === undefined ? attempt : 1,
        status: 'running',
        imageDigest: r.imageDigest,
        datasetSha256: r.datasetSha256,
        harnessVersion: r.harnessVersion,
        scorerVersion: r.scorerVersion,
        seed: r.seed,
        failKey: null,
        execCount: 0,
        flags: inherited,
        entrySecretIds: secretIdsOf(r.entrySecretIds),
        startedAt: r.startedAt,
      })
      .onConflictDoNothing({ target: run.id })
      .returning({ id: run.id });
    if (rows.length > 0) {
      if (r.topUp !== undefined) {
        const [row] = await tx
          .insert(practiceTopUp)
          .values({ runId: r.id, submissionId: r.submissionId, phaseId: r.phaseId, ...r.topUp })
          .onConflictDoNothing()
          .returning({ runId: practiceTopUp.runId });
        if (row === undefined) {
          const [held] = await tx
            .select({ runId: practiceTopUp.runId })
            .from(practiceTopUp)
            .where(and(eq(practiceTopUp.submissionId, r.submissionId), eq(practiceTopUp.phaseId, r.phaseId), eq(practiceTopUp.round, r.topUp.round)));
          throw new TopUpRoundTakenError(held?.runId ?? 'unknown');
        }
      }
      return { id: r.id, inserted: true };
    }
    const [existing] = await tx.select({ submissionId: run.submissionId, phaseId: run.phaseId, kind: run.kind }).from(run).where(eq(run.id, r.id));
    if (existing === undefined || existing.submissionId !== r.submissionId || existing.phaseId !== r.phaseId || existing.kind !== kind) {
      throw new Error(`run ${r.id} exists and is not the ${kind} run of submission ${r.submissionId} in phase ${r.phaseId}`);
    }
    return { id: r.id, inserted: false };
  });
}

/** One trial an agent/v1 run is made with (insertTrials). */
export interface NewTrial {
  /** The draw's trial t. */
  index: number;
  instanceSha256: string;
  /** The instance's directory relative to MAKEFUN_SEALED_DIR. */
  instanceRef: string;
}

/**
 * Insert a run's trials, pending, each tagged with its place in the grade-trial queue (`queue tags`: trialQueueTag of
 * its contest's figures, `wallBudgetSec` the competition's wall budget) in the same insert, under the queue's tagging
 * lock; one there already (by run and trial index, or by instance) is kept as it is, its tag with it. The figures no
 * tag moves (the run's contest and entrant, w_c, the entry's weight) are read before the lock, so its hold is the
 * figures tags move (V, n_c, the entrant's line or the final's) and the one insert (`queue tags`, the lock's hold);
 * none of them counts the run's own new rows, which no read sees before the insert commits. A call whose every trial is there
 * already (a retried grade job's) writes nothing and takes no lock.
 */
export async function insertTrials(db: Db, runId: string, trials: readonly NewTrial[], wallBudgetSec: number): Promise<void> {
  if (trials.length === 0) return;
  const there = await db.select({ trialIndex: runTrial.trialIndex, instanceSha256: runTrial.instanceSha256 }).from(runTrial).where(eq(runTrial.runId, runId));
  const indexes = new Set(there.map((r) => r.trialIndex));
  const instances = new Set(there.map((r) => r.instanceSha256));
  const fresh = trials.filter((t) => !indexes.has(t.index) && !instances.has(t.instanceSha256));
  if (fresh.length === 0) return;
  const fixed = await fixedQueueFiguresOf(db, runId, wallBudgetSec);
  if (fixed === null) throw new Error(`run ${runId} does not exist: its trials cannot be tagged`);
  // A top-up's trial indexes are its round's practice instances: each is tagged at its place in its own run, from 0.
  const first = fixed.who.kind === 'top_up' ? Math.min(...trials.map((t) => t.index)) : 0;
  await underQueueTagLock(db, async (tx) => {
    const figures = await queueFiguresFrom(tx, fixed);
    await tx
      .insert(runTrial)
      .values(
        fresh.map((t) => ({
          runId,
          trialIndex: t.index,
          instanceSha256: t.instanceSha256,
          instanceRef: t.instanceRef,
          queueTag: trialQueueTag(figures, t.index - first),
          queueCharge: figures.charge,
          queueEntrants: figures.entrants,
          queueWeight: figures.weight,
        })),
      )
      .onConflictDoNothing();
  });
}

/** One contender's later trials (insertContenderTrials): its run, and the draw's trials of the stage it still owes. */
export interface ContenderTrials {
  runId: string;
  trials: readonly NewTrial[];
}

/** How many trial rows insertContenderTrials writes in one statement (each row seven parameters, far under Postgres's 65,535). */
const CONTENDER_INSERT_CHUNK = 1000;

/**
 * Insert a staged final's contenders' trials of one stage on ONE line (`queue tags`: a staged final's contenders), in
 * one transaction under the queue's tagging lock: the line starts at the queue's head V, its charge is w_c × the
 * contenders (the runs given trials here: one round of them is charged one entrant's share of the slots), and trial t of
 * every run takes V + (t - from + 1) × charge, so trial `from` (the stage's first instance) of every contender runs
 * before trial from + 1 of any. `from` is the index of the stage's first instance, 1 for the first cut's survivors (trial
 * 0 is each run's own, made as its run started), a later cut's `at` for its survivors; it is a whole number from 1, and
 * every trial index is `from` or more. Every run must be a final phase's, all of one phase. A row there already (by run
 * and trial index, or by instance) is kept as it is, its tag with it, so a second call writes nothing. `wallBudgetSec`
 * is the competition's wall budget. Answers how many rows it made. A contender decided after the cut (a late run) gets
 * its later trials from insertTrials instead, never on this line.
 */
export async function insertContenderTrials(db: Db, runs: readonly ContenderTrials[], wallBudgetSec: number, from = 1): Promise<number> {
  if (!Number.isSafeInteger(from) || from < 1) throw new RangeError(`a stage's first trial is a whole number from 1, got ${String(from)}`);
  const owed = runs.filter((r) => r.trials.length > 0);
  if (owed.length === 0) return 0;
  const ids = owed.map((r) => r.runId.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new Error('a contender run is named twice: each run takes its trials once, on the one line');
  for (const r of owed) {
    for (const t of r.trials) {
      if (!Number.isSafeInteger(t.index) || t.index < from) throw new RangeError(`a contender's trial of the stage is a whole number from ${from}, got ${String(t.index)} for run ${r.runId}`);
    }
  }
  // The runs, their phase and the contest's w_c move with no tag: read before the lock, whose hold is V and the insert.
  const found = await db
    .select({ runId: run.id, phaseId: phase.id, phaseKey: phase.key, competitionId: phase.competitionId })
    .from(run)
    .innerJoin(phase, eq(phase.id, run.phaseId))
    .where(inArray(run.id, owed.map((r) => r.runId)));
  const missing = owed.filter((r) => !found.some((f) => f.runId.toLowerCase() === r.runId.toLowerCase()));
  if (missing.length > 0) throw new Error(`run ${missing[0]!.runId} does not exist: its trials cannot be tagged`);
  const phases = new Set(found.map((f) => f.phaseId));
  if (phases.size !== 1) throw new Error(`the contenders' runs are of ${phases.size} phases: one line is one final phase's`);
  const [first] = found;
  if (first!.phaseKey !== 'final') throw new Error(`the contenders' runs are of phase ${first!.phaseKey}: only a final's contenders share one line`);
  const slotSeconds = await contestSlotSeconds(db, first!.competitionId, wallBudgetSec);
  return underQueueTagLock(db, async (tx) => {
    const head = await queueHead(tx);
    const contenders = owed.length;
    const charge = slotSeconds * contenders;
    const rows = owed.flatMap((r) =>
      r.trials.map((t) => ({
        runId: r.runId,
        trialIndex: t.index,
        instanceSha256: t.instanceSha256,
        instanceRef: t.instanceRef,
        queueTag: head + (t.index - from + 1) * charge,
        queueCharge: charge,
        queueEntrants: contenders,
        queueWeight: 1,
      })),
    );
    let made = 0;
    for (let at = 0; at < rows.length; at += CONTENDER_INSERT_CHUNK) {
      const wrote = await tx
        .insert(runTrial)
        .values(rows.slice(at, at + CONTENDER_INSERT_CHUNK))
        .onConflictDoNothing()
        .returning({ id: runTrial.id });
      made += wrote.length;
    }
    return made;
  });
}

// ---------------------------------------------------------------- queue tags
//
// The grade-trial queue's order (server/jobs.ts gradeTrialPriority, its `trial slots`): self-clocked fair queueing by
// finish tag (SCFQ: Golestani, 1994) with entrants inside contests as its flows. Each trial's tag is computed ONCE, as
// its run's trials are made (insertTrials), and stored on its row (run_trial.queue_tag, with the charge and the
// entrants it was weighed by); its job is sent at pg-boss priority -ceil(tag / 60), and no queued job's priority is
// ever rewritten. In virtual slot-seconds:
//
//   w_c     the contest's slot-seconds a trial (trialSlotSeconds): the median of its last TRIAL_QUEUE_HISTORY
//           finished trials' live start to replay end (a timeout's live end), a window that already holds the pods'
//           start and stop, the keys and the replay, read off its recent runs (each phase's newest
//           TRIAL_QUEUE_RECENT_RUNS of each status: contestSlotSeconds), over all its trials only where those hold
//           fewer finished ones; with no history, twice its wall budget; never under its wall
//           budget's 5% or TRIAL_QUEUE_FLOOR_SECONDS, whichever is larger, so a flood of very short trials cannot make a
//           contest's charge vanish (and a final's trial t + 1 is always a priority step behind its trial t)
//   n_c     the contest's entrants (submission.user_id) with a trial queued or running, the one tagged among them
//           (a final's new line counts too every entrant whose grade-final job of the phase is queued or running: its
//           lock sends them all at once, and their runs start one by one)
//   q       w_c × n_c, the trial's charge: with n entrants waiting each is charged n times as much, so contests with a
//           backlog share the slots about equally, and the entrants inside one share their contest's equally; a dev
//           run's is × its entry's weight too (entry_screen.weight where applied, else 1: a flagged entry's trials
//           take that many charges' room, so it is ordered behind, never refused or held); a final run's weight is 1
//   V       the queue's virtual time: the largest tag of any trial whose live pass has started
//   F       where the entrant's own line ends: the largest tag over the entrant's trials in the contest, a finished
//           trial's tag less its charge plus its window × its entrants × its weight (what it held, in place of what it
//           was charged), so an entrant's later trials queue behind its own earlier ones and a burst delays that entrant
//           alone; only trials that can still cost slot time count (done, or of a running run of an entry not
//           cancelled), so a superseded entry's trial that never ran never pushes the entrant back. A final's runs are
//           ONE line instead: a final run joins the line its phase's waiting trial 0s hold (their tag less their charge
//           as its start, their charge as its own), else starts a new one at V, so every entry's trial t shares one
//           tag and trial 0 of every entry runs before trial 1 of any however the queue moves while the lock's grade
//           jobs start; a round of the final's N trials is charged w_c × N, one entrant's share of the slots for the
//           contest
//   tag(t)  of a run's trial t: max(V, F) (a final's: its line's start) + (t + 1) × q
//
// Every trial is charged, its first included: an idle entrant's trial enters at V + q, one charge past the head, so
// when every entrant is new (a dev submission is one trial, trial 0) the contests still take turns by their charges,
// where a start tag, max(V, F) alone, would put every first trial at V and run them first-come. Two queued tags never
// change order once sent; only w_c and n_c drift (by at most one charge an entrant), and the next tag corrects it.
// Between CONTESTS the split of the slot-time is enforced; between ENTRANTS the order is a courtesy, since accounts are
// free (a 20-trial burst spread over 20 accounts delays the others about as much as FIFO).
//
// A practice top-up's trials (a `top_up` run) are charged to their contest on ONE platform line of their own: in n_c
// they are one flow (TOP_UP_LINE), never their entrants, their F the line's end over the contest's top-up trials, and
// weight 1; an entrant's own line leaves them out, so no entrant's place moves for its top-ups. A top-up run's trial t
// (its round's practice instance) is tagged at its place in the run, from 0, so round r's first trial is one charge past
// the line's end as round 1's was.
//
// A staged final's contenders (contracts/competition.ts `harness.trials.staged`) are ONE line of their own at each cut:
// every entry's run starts with its trial 0 alone, on the final's line above, and once one of the phase's cuts is
// decided the cut job makes every survivor's trials of the next stage, `from` (the stage's first instance: 1 after the
// first cut, a later cut's `at` after it) to the stage's last, in one call (insertContenderTrials), under the lock: the
// line starts at V, its charge is w_c × the survivors (the runs given trials in that call, never the field the cut
// weighed: one round of them is charged one entrant's share of the slots, as a final's line is), and trial t (t ≥ from)
// of every survivor takes V + (t - from + 1) × charge, so the stage's first instance of every survivor runs before its
// second of any. Each row records that charge and the survivors as its entrants, weight 1. A row
// there already keeps its tag (ON CONFLICT DO NOTHING), so the call made twice, or after a trial's own handler made a
// row, writes nothing more. A contender decided after a cut (a late run measured against the stored line) takes its
// later trials from insertTrials, as any final run does: on the line its final's waiting trial 0s hold, else a new one
// at V, never the survivors' line.
//
// A platform fault never costs a trial its place: a trial sent again after a void, the node's room, a refused mint,
// the cut-off sweep or an admin's re-queue keeps its tag, raised to one charge behind where an idle entrant enters
// (V + q) at most (faultQueueTag: max(tag, V)), so a node lost does not send every trial it ran ahead of everything that
// came meanwhile; a pg-boss retry is the same job, its priority as it was. A trial its own contest's policy holds back
// (the dev day's budget, the practice budget, the final cap, a scrape heat, a provider key) has its tag cleared
// (deferTrialQueueTag: its charge kept, the mark of a deferral), and the job that wakes takes a fresh one at
// max(V, F) + q (retagTrial) and sends itself again at it when it was sent ahead of it, so a midnight wave cannot jump
// the line. A row made before these columns has none either way, and is tagged as a deferred one is when its job is
// claimed. A trial that will never run, one with no live pass started of a run that is no longer running or of an
// entry a supersede cancelled, leaves the queue (closeUnstartedTrials: its tag and charge cleared; it stays `pending`,
// the one status a trial with no pass spent may hold), as the run finishes (finishRun) and in the supersede's own
// transaction (server/pipeline/ingest.ts supersedeOlderEntries). An admin may move forward a queued trial whose live
// pass never started (requeueTrialQueueTag): it takes the tag it would take queued now when that is earlier than its
// own, never a later one, and its job is sent again at it, the old one cancelled.
//
// The lock's hold. Every tag computed from other trials' tags (a run's trials, a fresh tag, a re-queue) is written
// under one transaction lock, TRIAL_QUEUE_LOCK_KEY's advisory lock (underQueueTagLock), so two runs tagged at once read
// each other's: two runs of one entrant never take one tag, and two final runs never start two lines. The lock is one
// key for every grader, so its hold is kept to what tags move: the figures nothing tagged moves (the run's contest and
// entrant, w_c, the entry's weight) are read before it, and a run's every tag goes in its one insert. In each process
// the takes of a key wait in line (queueTagLines) before a pooled connection is taken, so a grader parks one connection
// at most on the advisory wait. A write to ONE trial's own tag that reads no other trial's takes no lock: a fault's
// raise (faultTrialQueueTag: max(tag, V), written only while the row still holds the tag it read, compare-and-set), a
// deferral's clear (deferTrialQueueTag: one statement locks the row, reads its tag and clears it), a tagged trial's
// claim (retagTrial reads it) and a closed trial's clear (closeUnstartedTrials). A tagger reads such a row before or
// after its write, as it would under the lock, and V, which a live start moves outside the lock anyway, may be read one
// start stale: a figure off by one charge at most. Ops jobs take the same key themselves (deploy/k8s/jobs/
// admin-retag-trials.mjs, admin-forward-trials.mjs, admin-close-final.mjs), and a draining grader of an earlier release
// still takes it for every tag: the key never changes.

/** How many of a contest's latest finished trials its slot-seconds a trial are the median of. */
export const TRIAL_QUEUE_HISTORY = 20;

/** The least slot-seconds a trial is ever weighed at (and its wall budget's TRIAL_QUEUE_FLOOR_SHARE, when that is more). */
export const TRIAL_QUEUE_FLOOR_SECONDS = 60;

/** The share of its wall budget a trial is weighed at least (TRIAL_QUEUE_FLOOR_SECONDS when that is more). */
export const TRIAL_QUEUE_FLOOR_SHARE = 0.05;

/** The transaction lock every queue tag is written under (pg_advisory_xact_lock(hashtextextended(key, 0))). */
export const TRIAL_QUEUE_LOCK_KEY = 'makefun:trial-queue-tags';

/** The trial statuses whose trial is queued or running (n_c): not done, not held for an admin. */
const QUEUED_TRIAL_STATUSES = ['pending', 'live_running', 'live_done', 'replaying', 'void'] as const;

/** The trial statuses of a trial done (its actual slot-seconds known): contracts/agent.ts AGENT_TRIAL_STATUSES. */
const DONE_STATUSES = ['finished', 'timeout', 'nondeterministic'] as const;

/**
 * A contest's slot-seconds a trial (w_c): the median of `recent` (its latest finished trials' live start to end, in
 * seconds), or twice `wallBudgetSec` with none; never under the floor (the larger of TRIAL_QUEUE_FLOOR_SECONDS and
 * TRIAL_QUEUE_FLOOR_SHARE of the wall budget). Whole seconds, rounded up.
 */
export function trialSlotSeconds(recent: readonly number[], wallBudgetSec: number): number {
  if (!Number.isSafeInteger(wallBudgetSec) || wallBudgetSec < 1) throw new RangeError(`a wall budget is whole seconds from 1, got ${String(wallBudgetSec)}`);
  const floor = Math.max(TRIAL_QUEUE_FLOOR_SECONDS, Math.ceil(wallBudgetSec * TRIAL_QUEUE_FLOOR_SHARE));
  const known = recent.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (known.length === 0) return Math.max(floor, 2 * wallBudgetSec);
  const mid = known.length >> 1;
  const median = known.length % 2 === 1 ? known[mid]! : (known[mid - 1]! + known[mid]!) / 2;
  return Math.max(floor, Math.ceil(median));
}

/** What a run's trials are tagged from (`queue tags`): where its line starts, and each trial's charge and its weight. */
export interface QueueFigures {
  /** V: the queue's virtual time. */
  head: number;
  /** Where the run's line starts, its trial t at from + (t + 1) × q: max(V, F) for a dev run, its final's line (else V) for a final run. */
  from: number;
  /** w_c: the contest's slot-seconds a trial. */
  slotSeconds: number;
  /** n_c: the contest's entrants with a trial queued or running, at least 1. */
  entrants: number;
  /** q = w_c × n_c × weight. */
  charge: number;
  /**
   * The entry screen's weight on the run's entry (entry_screen.weight where applied), 1 or more: 1 with no applied
   * verdict, and always 1 on a final run.
   */
  weight: number;
  /** Whether the run is a final's (its trials on the final's one line). */
  final: boolean;
}

/** The tag of a run's trial `trialIndex` (`queue tags`): from + (t + 1) × q, its first trial charged too. */
export function trialQueueTag(f: Pick<QueueFigures, 'from' | 'charge'>, trialIndex: number): number {
  if (!Number.isSafeInteger(trialIndex) || trialIndex < 0) throw new RangeError(`a trial index is a whole number from 0, got ${String(trialIndex)}`);
  return f.from + (trialIndex + 1) * f.charge;
}

/**
 * A fault's resend's tag (`queue tags`): the trial's own, raised to one charge behind where an idle entrant enters
 * (V + q) at most: to the head, V.
 */
export function faultQueueTag(stored: number, head: number): number {
  return Math.max(stored, head);
}

/** Take the queue's tagging lock for the rest of transaction `tx` (`queue tags`): every tag read from others' is written under it. */
async function lockQueueTags(tx: Pick<Db, 'execute'>): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${TRIAL_QUEUE_LOCK_KEY}, 0))`);
}

/**
 * Each advisory key's line in this process (`queue tags`, the lock's hold): the last take's turn, which the next take
 * waits on before it takes a pooled connection, so the process parks one connection at most on the key's advisory
 * wait, and the rest wait here, holding none. Exclusion across processes is the advisory lock's alone.
 */
const queueTagLines = new Map<string, Promise<void>>();

/** Run `fn` in its turn on `key`'s line in this process (queueTagLines): after every take before it has ended. */
async function inLine<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = queueTagLines.get(key);
  let done!: () => void;
  const mine = new Promise<void>((resolve) => {
    done = resolve;
  });
  const turn = before === undefined ? mine : before.then(() => mine);
  queueTagLines.set(key, turn);
  try {
    if (before !== undefined) await before;
    return await fn();
  } finally {
    done();
    if (queueTagLines.get(key) === turn) queueTagLines.delete(key);
  }
}

/**
 * Run `fn` in a transaction of `db` under the queue's tagging lock (`queue tags`, the lock's hold): its turn on the
 * key's line in this process first, then the transaction and the advisory lock. Each take counts on
 * makefun_trial_queue_lock_seconds (server/ops/metrics.ts noteTrialQueueLock): its wait, from this call to the lock in
 * hand, and its hold, from then to the transaction's end.
 */
async function underQueueTagLock<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const asked = performance.now();
  return inLine(TRIAL_QUEUE_LOCK_KEY, async () => {
    const lock: { at: number | null } = { at: null };
    try {
      return await db.transaction(async (tx) => {
        await lockQueueTags(tx);
        lock.at = performance.now();
        const waited = (lock.at - asked) / 1000;
        countOnProcessRegistry((metrics) => metrics.noteTrialQueueLock('wait', waited));
        return fn(tx);
      });
    } finally {
      if (lock.at !== null) {
        const held = (performance.now() - lock.at) / 1000;
        countOnProcessRegistry((metrics) => metrics.noteTrialQueueLock('held', held));
      }
    }
  });
}

/** A number Postgres answered (a bigint or numeric may come back as a string); `none` for null. */
function numberOf(v: unknown, none: number): number {
  if (v === null || v === undefined) return none;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`the queue figures read ${JSON.stringify(v)}, which is no number`);
  return n;
}

/** V (`queue tags`): the largest tag of a trial whose live pass has started, 0 before any (run_trial_queue_tag_started_idx). */
export async function queueHead(db: Pick<Db, 'select'>): Promise<number> {
  const [r] = await db
    .select({ v: sql<unknown>`max(${runTrial.queueTag})` })
    .from(runTrial)
    .where(and(sql`${runTrial.liveStartedAt} is not null`, sql`${runTrial.queueTag} is not null`));
  return numberOf(r?.v, 0);
}

/** A trial's end as `queue tags` reads it: its replay's end, else (a timeout's) its live pass's. */
const trialEnd = sql`coalesce(${runTrial.replayFinishedAt}, ${runTrial.liveFinishedAt})`;

/**
 * How many of each phase's newest runs of each status w_c's window reads (`queue tags`, contestSlotSeconds): by run id,
 * a uuidv7, so newest made first, off run_phase_status_idx (phase_id, status, id) alone.
 */
export const TRIAL_QUEUE_RECENT_RUNS = 100;

/**
 * The ids of contest `competitionId`'s recent runs (`queue tags`, contestSlotSeconds): each of its phases' newest
 * TRIAL_QUEUE_RECENT_RUNS of each run status, every one a short range of run_phase_status_idx, so the read is bounded
 * by the phases and statuses, never by how many runs the contest has made.
 */
function recentContestRuns(competitionId: string): SQL {
  const statuses = sql.raw(`array[${RUN_STATUSES.map((s) => `'${s}'`).join(', ')}]::run_status[]`);
  return sql`select r.id from ${phase} p cross join unnest(${statuses}) as st(status)
    cross join lateral (select q.id from ${run} q where q.phase_id = p.id and q.status = st.status order by q.id desc limit ${TRIAL_QUEUE_RECENT_RUNS}) r
    where p.competition_id = ${competitionId}`;
}

/**
 * Contest `competitionId`'s w_c (`queue tags`: trialSlotSeconds of its latest finished trials' windows), `wallBudgetSec`
 * its wall budget. Read first over the contest's recent runs (recentContestRuns: their trials by run_trial_run_status_idx),
 * which hold its latest trials; only where they hold fewer than TRIAL_QUEUE_HISTORY finished trials (a young contest, or
 * one whose newest runs are all still queued) is every trial of the contest read, as the window has nothing else to be.
 */
async function contestSlotSeconds(tx: Pick<Db, 'select'>, competitionId: string, wallBudgetSec: number): Promise<number> {
  const windowOf = sql<unknown>`extract(epoch from (${trialEnd} - ${runTrial.liveStartedAt}))::float8`;
  const done = and(inArray(runTrial.status, DONE_STATUSES), sql`${runTrial.liveStartedAt} is not null`, sql`${trialEnd} is not null`);
  let recent = await tx
    .select({ s: windowOf })
    .from(runTrial)
    .where(and(sql`${runTrial.runId} = any(array(${recentContestRuns(competitionId)}))`, done))
    .orderBy(sql`${trialEnd} desc`)
    .limit(TRIAL_QUEUE_HISTORY);
  if (recent.length < TRIAL_QUEUE_HISTORY) {
    recent = await tx
      .select({ s: windowOf })
      .from(runTrial)
      .innerJoin(run, eq(run.id, runTrial.runId))
      .innerJoin(phase, eq(phase.id, run.phaseId))
      .where(and(eq(phase.competitionId, competitionId), done))
      .orderBy(sql`${trialEnd} desc`)
      .limit(TRIAL_QUEUE_HISTORY);
  }
  return trialSlotSeconds(
    recent.map((r) => numberOf(r.s, Number.NaN)),
    wallBudgetSec,
  );
}

/**
 * The figures of run `runId` no tag moves (`queue tags`, the lock's hold), read before the tagging lock: its entry, its
 * entrant, contest and phase, its contest's w_c (`wallBudgetSec` its wall budget) and its entry's weight (a dev run's; 1
 * on a final's).
 */
interface FixedFigures {
  who: { submissionId: string; competitionId: string; userId: string; phaseId: string; phaseKey: string; kind: RunRow['kind'] };
  slotSeconds: number;
  weight: number;
}

/** The flow a contest's practice top-up trials share in n_c (`queue tags`: the platform's line), never a user id. */
const TOP_UP_LINE = 'practice top-up';

/** Read run `runId`'s FixedFigures, or null when there is no such run. */
async function fixedQueueFiguresOf(db: Pick<Db, 'select'>, runId: string, wallBudgetSec: number): Promise<FixedFigures | null> {
  const [who] = await db
    .select({ submissionId: submission.id, competitionId: submission.competitionId, userId: submission.userId, phaseId: run.phaseId, phaseKey: phase.key, kind: run.kind })
    .from(run)
    .innerJoin(submission, eq(submission.id, run.submissionId))
    .innerJoin(phase, eq(phase.id, run.phaseId))
    .where(eq(run.id, runId));
  if (who === undefined) return null;
  const slotSeconds = await contestSlotSeconds(db, who.competitionId, wallBudgetSec);
  if (who.phaseKey === 'final' || who.kind === 'top_up') return { who, slotSeconds, weight: 1 };
  // The entry screen's weight on the entry, where its verdict is applied (enforce); 1 with none, or only observed.
  const [screened] = await db
    .select({ weight: entryScreen.weight })
    .from(entryScreen)
    .where(and(eq(entryScreen.submissionId, who.submissionId), eq(entryScreen.applied, true)));
  return { who, slotSeconds, weight: Math.max(1, numberOf(screened?.weight, 1)) };
}

/**
 * The figures run `runId`'s trials are tagged from (`queue tags`), read in `tx` under the tagging lock: its contest's
 * w_c (`wallBudgetSec` its wall budget) and n_c, the entry's weight (a dev run's), the queue's V, and where the run's
 * line starts. A trial with no tag (being tagged now, or afresh) is in no line, so it is never behind itself.
 */
export async function queueFiguresOf(tx: Pick<Db, 'select' | 'selectDistinct' | 'execute'>, runId: string, wallBudgetSec: number): Promise<QueueFigures> {
  const fixed = await fixedQueueFiguresOf(tx, runId, wallBudgetSec);
  if (fixed === null) throw new Error(`run ${runId} does not exist: its trials cannot be tagged`);
  return queueFiguresFrom(tx, fixed);
}

/**
 * queueFiguresOf from the FixedFigures read already (before the lock): the figures tags move, read in `tx` under the
 * tagging lock: V, n_c, and where the run's line starts (the entrant's own line's end, or the final's line).
 */
async function queueFiguresFrom(tx: Pick<Db, 'select' | 'selectDistinct' | 'execute'>, fixed: FixedFigures): Promise<QueueFigures> {
  const { who, slotSeconds, weight } = fixed;
  const head = await queueHead(tx);
  // n_c: queued or running, in a run still running; a deferred trial (its tag cleared, its charge kept) waits on its
  // contest, not on the slots. The entrant being tagged counts, a deferred trial waking included. Led by the contest's
  // running runs (run_phase_status_idx on its phases), each asked for one such trial (run_trial_run_status_idx), never
  // by every entry of the contest and each trial it ever had.
  const waiting = await tx
    .selectDistinct({ userId: sql<string>`case when ${run.kind} = 'top_up' then ${TOP_UP_LINE} else ${submission.userId} end` })
    .from(run)
    .innerJoin(submission, eq(submission.id, run.submissionId))
    .where(
      and(
        sql`${run.phaseId} = any(array(select ${phase.id} from ${phase} where ${phase.competitionId} = ${who.competitionId}))`,
        eq(run.status, 'running'),
        eq(submission.competitionId, who.competitionId),
        sql`exists (select 1 from ${runTrial} where ${runTrial.runId} = ${run.id} and ${inArray(runTrial.status, QUEUED_TRIAL_STATUSES)}
          and not (${runTrial.queueTag} is null and ${runTrial.queueCharge} is not null))`,
      ),
    );
  const topUp = who.kind === 'top_up';
  const users = new Set([topUp ? TOP_UP_LINE : who.userId, ...waiting.map((w) => w.userId)]);
  if (who.phaseKey === 'final') {
    // One line for the final: a run joins the line its final's waiting trial 0s hold, at its start and its charge.
    const [line] = await tx
      .select({ base: sql<unknown>`max(${runTrial.queueTag} - ${runTrial.queueCharge})`, charge: sql<unknown>`max(${runTrial.queueCharge})`, entrants: sql<unknown>`max(${runTrial.queueEntrants})` })
      .from(runTrial)
      .innerJoin(run, eq(run.id, runTrial.runId))
      .where(
        and(
          eq(run.phaseId, who.phaseId),
          eq(run.status, 'running'),
          eq(runTrial.trialIndex, 0),
          eq(runTrial.status, 'pending'),
          sql`${runTrial.liveStartedAt} is null`,
          sql`${runTrial.queueTag} is not null`,
          sql`${runTrial.queueCharge} is not null`,
        ),
      );
    if (line?.base !== null && line?.base !== undefined) {
      const charge = numberOf(line.charge, slotSeconds);
      return { head, from: numberOf(line.base, head), slotSeconds, entrants: Math.max(1, numberOf(line.entrants, 1)), charge, weight: 1, final: true };
    }
    // A new line, at the head, weighed by every entrant the final grades now: its lock sends every entry's grade-final
    // job at once, so the ones still to start their runs count too, and every run of the line takes the same charge.
    for (const u of await finalEntrantsQueued(tx, who.phaseId)) users.add(u);
    const entrants = Math.max(1, users.size);
    return { head, from: head, slotSeconds, entrants, charge: slotSeconds * entrants, weight: 1, final: true };
  }
  const entrants = Math.max(1, users.size);
  // The entrant's own line in the contest: where each of its trials ends, a finished one at what it held in place of
  // its charge (its tag less its charge plus its window × its entrants × its weight), any other at its tag. Only a trial
  // that can still cost slot time is in it: one done, or one of a running run of an entry not cancelled; a cancelled or
  // superseded run's trial that never ran holds no place. A top-up's line is the contest's top-up trials, apart from every entrant's.
  const held = sql`case when ${inArray(runTrial.status, DONE_STATUSES)} and ${runTrial.liveStartedAt} is not null and ${trialEnd} is not null
    then ${runTrial.queueTag} - ${runTrial.queueCharge} + ceil(extract(epoch from (${trialEnd} - ${runTrial.liveStartedAt}))) * coalesce(${runTrial.queueEntrants}, 1) * coalesce(${runTrial.queueWeight}, 1)
    else ${runTrial.queueTag} end`;
  const [own] = await tx
    .select({ f: sql<unknown>`max(${held})::float8` })
    .from(runTrial)
    .innerJoin(run, eq(run.id, runTrial.runId))
    .innerJoin(submission, eq(submission.id, run.submissionId))
    .where(
      and(
        eq(submission.competitionId, who.competitionId),
        topUp ? eq(run.kind, 'top_up') : and(eq(submission.userId, who.userId), ne(run.kind, 'top_up')),
        sql`${runTrial.queueTag} is not null`,
        sql`${runTrial.queueCharge} is not null`,
        or(inArray(runTrial.status, DONE_STATUSES), and(eq(run.status, 'running'), ne(submission.status, 'cancelled'))),
      ),
    );
  return { head, from: Math.max(head, Math.ceil(numberOf(own?.f, 0))), slotSeconds, entrants, charge: slotSeconds * entrants * weight, weight, final: false };
}

/** pg-boss's job table, where a final's grade-final jobs wait (the default schema: server/jobs.ts). */
const JOB_TABLE = 'pgboss.job';

/** The entrants of the final phase `phaseId` whose grade-final job is queued or running (none where pg-boss has no table). */
async function finalEntrantsQueued(tx: Pick<Db, 'execute'>, phaseId: string): Promise<string[]> {
  const present = (await tx.execute(sql`select to_regclass(${JOB_TABLE}) is not null as present`)) as unknown as { rows?: { present: boolean }[] };
  if (present.rows?.[0]?.present !== true) return [];
  const found = (await tx.execute(
    sql`select distinct s.user_id as "userId" from ${sql.raw(JOB_TABLE)} j join ${submission} s on s.id::text = j.data->>'submission_id'
      where j.name = 'grade-final' and j.data->>'phase_id' = ${phaseId} and j.state in ('created', 'retry', 'active')`,
  )) as unknown as { rows?: { userId: string }[] };
  return (found.rows ?? []).map((r) => r.userId);
}

/** A trial's row as `queue tags` reads it. */
type QueuedTrial = Pick<TrialRow, 'id' | 'runId' | 'trialIndex' | 'queueTag' | 'queueCharge'>;

/** Which trial: its run and trial index. */
export type TrialKey = Pick<TrialRow, 'runId' | 'trialIndex'>;

/** Read trial `key`'s queue columns in `tx`, or null when there is no such trial. */
async function findQueuedTrial(tx: Pick<Db, 'select'>, key: TrialKey): Promise<QueuedTrial | null> {
  const [row] = await tx
    .select({ id: runTrial.id, runId: runTrial.runId, trialIndex: runTrial.trialIndex, queueTag: runTrial.queueTag, queueCharge: runTrial.queueCharge })
    .from(runTrial)
    .where(and(eq(runTrial.runId, key.runId), eq(runTrial.trialIndex, key.trialIndex)));
  return row ?? null;
}

/** findQueuedTrial, throwing when there is no such trial. */
async function queuedTrial(tx: Pick<Db, 'select'>, key: TrialKey): Promise<QueuedTrial> {
  const row = await findQueuedTrial(tx, key);
  if (row === null) throw new Error(`trial ${key.trialIndex} of run ${key.runId} does not exist: it has no place in the queue`);
  return row;
}

/** The tag `row` would take afresh in `tx` (under the lock), from its run's `fixed` figures: a dev trial at max(V, F) + q, a final's trial t on its final's line + (t + 1) × q. */
async function freshTagOf(tx: Pick<Db, 'select' | 'selectDistinct' | 'execute'>, row: QueuedTrial, fixed: FixedFigures): Promise<{ tag: number; figures: QueueFigures }> {
  const figures = await queueFiguresFrom(tx, fixed);
  return { tag: trialQueueTag(figures, figures.final ? row.trialIndex : 0), figures };
}

/** Write `tag` to `row` in `tx` (under the lock), with the figures it was weighed by. */
async function writeTag(tx: Pick<Db, 'update'>, row: QueuedTrial, tag: number, figures: QueueFigures): Promise<void> {
  await tx.update(runTrial).set({ queueTag: tag, queueCharge: figures.charge, queueEntrants: figures.entrants, queueWeight: figures.weight }).where(eq(runTrial.id, row.id));
}

/** Tag `row` afresh in `tx` (under the lock): freshTagOf, written to its row. */
async function tagAfresh(tx: Pick<Db, 'select' | 'selectDistinct' | 'update' | 'execute'>, row: QueuedTrial, fixed: FixedFigures): Promise<number> {
  const { tag, figures } = await freshTagOf(tx, row, fixed);
  await writeTag(tx, row, tag, figures);
  return tag;
}

/** The FixedFigures of `row`'s run, read before the lock: its run is there (run_trial.run_id references it), else an Error. */
async function fixedFiguresOfTrial(db: Pick<Db, 'select'>, row: QueuedTrial, wallBudgetSec: number): Promise<FixedFigures> {
  const fixed = await fixedQueueFiguresOf(db, row.runId, wallBudgetSec);
  if (fixed === null) throw new Error(`run ${row.runId} does not exist: its trials cannot be tagged`);
  return fixed;
}

/**
 * Write `tag` to `row` only while it still holds the tag `was` it was read with (`queue tags`, the lock's hold: a write
 * to one trial's own tag, compare-and-set, no lock). Whether it was written: false when another write moved the row's
 * tag meanwhile, and nothing is written.
 */
async function swapTag(db: Pick<Db, 'update'>, row: Pick<QueuedTrial, 'id'>, was: number, tag: number): Promise<boolean> {
  const moved = await db
    .update(runTrial)
    .set({ queueTag: tag })
    .where(and(eq(runTrial.id, row.id), eq(runTrial.queueTag, was)))
    .returning({ id: runTrial.id });
  return moved.length > 0;
}

/** How many times a fault's raise reads its trial and tries its compare-and-set (swapTag) before it takes the lock instead. */
const SWAP_TRIES = 2;

/**
 * An admin's re-queue of a trial whose live pass never started (`queue tags`; server/routes/admin/grading.ts
 * registerTrialRequeue): the tag it would take queued now (freshTagOf, weighed with its own tag out of every line, so
 * it is never behind itself), kept only where it is earlier than the one it holds, so a re-queue never moves a trial
 * back; written under the tagging lock, with its figures when the fresh tag is taken. `wallBudgetSec` is its
 * competition's wall budget. Answers the tag it holds now and the one it held (`was`, null for none: the fresh one is
 * taken), or null when there is no such trial.
 */
export async function requeueTrialQueueTag(db: Db, trial: TrialKey, wallBudgetSec: number): Promise<{ tag: number; was: number | null } | null> {
  const fixed = await fixedQueueFiguresOf(db, trial.runId, wallBudgetSec);
  if (fixed === null) return null;
  return underQueueTagLock(db, async (tx) => {
    const row = await findQueuedTrial(tx, trial);
    if (row === null) return null;
    const was = row.queueTag;
    if (was !== null) await tx.update(runTrial).set({ queueTag: null }).where(eq(runTrial.id, row.id));
    const { tag, figures } = await freshTagOf(tx, row, fixed);
    if (was !== null && was <= tag) {
      await tx.update(runTrial).set({ queueTag: was }).where(eq(runTrial.id, row.id));
      return { tag: was, was };
    }
    await writeTag(tx, row, tag, figures);
    return { tag, was };
  });
}

/**
 * The tag a trial's job is sent again at after a platform fault (`queue tags`): its own, raised to one charge behind
 * where an idle entrant enters at most (faultQueueTag), written to its row; a trial with none (deferred, or made before
 * the column) is tagged afresh. `wallBudgetSec` is its competition's wall budget. Null when there is no such trial (its
 * job sent at the head). A trial that holds a tag takes no lock (`queue tags`, the lock's hold): its raise is written
 * only while it still holds the tag it was read with (swapTag), read again once when another write moved it
 * meanwhile; only then, or with no tag, is it read again under the lock and written there.
 */
export async function faultTrialQueueTag(db: Db, trial: TrialKey, wallBudgetSec: number): Promise<number | null> {
  let seen: QueuedTrial | null = null;
  for (let tries = 0; tries < SWAP_TRIES; tries++) {
    seen = await findQueuedTrial(db, trial);
    if (seen === null) return null;
    if (seen.queueTag === null) break;
    const tag = faultQueueTag(seen.queueTag, await queueHead(db));
    if (tag === seen.queueTag || (await swapTag(db, seen, seen.queueTag, tag))) return tag;
  }
  const fixed = await fixedFiguresOfTrial(db, seen!, wallBudgetSec);
  return underQueueTagLock(db, async (tx) => {
    const row = await findQueuedTrial(tx, trial);
    if (row === null) return null;
    if (row.queueTag === null) return tagAfresh(tx, row, fixed);
    const tag = faultQueueTag(row.queueTag, await queueHead(tx));
    if (tag !== row.queueTag) await tx.update(runTrial).set({ queueTag: tag }).where(eq(runTrial.id, row.id));
    return tag;
  });
}

/**
 * A trial its own contest's policy holds back (`queue tags`): its tag cleared, its charge kept (the mark of a
 * deferral, which n_c leaves out), so the job that wakes tags it afresh (retagTrial). Answers the tag it held, or null
 * (none, or no such trial). It reads no other trial, so it takes no lock (`queue tags`, the lock's hold): one statement
 * locks the row, reads the tag it held and clears it, so no write between the read and the clear is lost.
 */
export async function deferTrialQueueTag(db: Db, trial: TrialKey): Promise<number | null> {
  const cleared = (await db.execute(
    sql`update run_trial set queue_tag = null, queue_charge = coalesce(run_trial.queue_charge, ${TRIAL_QUEUE_FLOOR_SECONDS})
      from (select id, queue_tag from run_trial where run_id = ${trial.runId} and trial_index = ${trial.trialIndex} for update) as held
      where run_trial.id = held.id
      returning held.queue_tag as "was"`,
  )) as unknown as { rows?: { was: unknown }[] };
  const was = cleared.rows?.[0]?.was;
  return was === null || was === undefined ? null : numberOf(was, 0);
}

/**
 * The tag of `trial` as its job is claimed (`queue tags`): the one it holds, or, with none (it woke from a
 * deferral, or was made before the column), a fresh one at max(V, F) + q written now. `fresh` says which. One it holds
 * is read with no lock (`queue tags`, the lock's hold); with none, it is read again under the lock and tagged there.
 */
export async function retagTrial(db: Db, trial: TrialKey, wallBudgetSec: number): Promise<{ tag: number; fresh: boolean }> {
  const seen = await queuedTrial(db, trial);
  if (seen.queueTag !== null) return { tag: seen.queueTag, fresh: false };
  const fixed = await fixedFiguresOfTrial(db, seen, wallBudgetSec);
  return underQueueTagLock(db, async (tx) => {
    const row = await queuedTrial(tx, trial);
    if (row.queueTag !== null) return { tag: row.queueTag, fresh: false };
    return { tag: await tagAfresh(tx, row, fixed), fresh: true };
  });
}

/**
 * Take the trials that will never run out of the queue (`queue tags`), in `tx`: each `pending` trial with no live pass
 * started of the run `of.runId`, or of every run of the entries `of.submissionIds`, its tag and charge cleared, so no
 * line counts it. It clears those rows' own columns and reads no other trial, so it takes no tagging lock (`queue
 * tags`, the lock's hold): finishRun and a supersede (server/pipeline/ingest.ts) never wait on every grader's tagging
 * while they hold their run's or entry's row. It stays `pending` (run_trial_attempt_spent: the one status a trial with
 * no pass spent may hold), and its run, over or of a cancelled entry, runs it no more. Answers how many it closed.
 */
export async function closeUnstartedTrials(tx: Pick<Db, 'select' | 'update' | 'execute'>, of: { runId: string } | { submissionIds: readonly string[] }): Promise<number> {
  if ('submissionIds' in of && of.submissionIds.length === 0) return 0;
  const runs = 'runId' in of ? eq(runTrial.runId, of.runId) : inArray(runTrial.runId, tx.select({ id: run.id }).from(run).where(inArray(run.submissionId, [...of.submissionIds])));
  const open = and(runs, eq(runTrial.status, 'pending'), isNull(runTrial.liveStartedAt), sql`(${runTrial.queueTag} is not null or ${runTrial.queueCharge} is not null)`);
  const closed = await tx.update(runTrial).set({ queueTag: null, queueCharge: null }).where(open).returning({ id: runTrial.id });
  return closed.length;
}

/** A run's trials, in trial index order. */
export async function loadTrials(db: Db, runId: string): Promise<TrialRow[]> {
  return db.select().from(runTrial).where(eq(runTrial.runId, runId)).orderBy(asc(runTrial.trialIndex));
}

/** What moveTrial may write: a trial row's state and records (never which run, trial or instance it is). */
export type TrialUpdate = Partial<Omit<typeof runTrial.$inferInsert, 'id' | 'runId' | 'trialIndex' | 'instanceSha256' | 'instanceRef' | 'createdAt'>>;

/**
 * Move a trial row on from the state `from` read it in (its status, attempt and replay start): `set`
 * is written only while the row is still there, and the row as written comes back; null when it has
 * moved meanwhile (another attempt took it), and nothing is written. A move into a pass's end (finished, timeout,
 * nondeterministic, void or held) counts on makefun_trial_passes_total{outcome,reason} (server/ops/metrics.ts
 * countTrialPass), the void or hold reason its row then holds: every status change goes through here, so the
 * Capacity board reads every pass's end, a void pass that completes its job as much as a scored one.
 */
export async function moveTrial(db: Pick<Db, 'update'>, from: Pick<TrialRow, 'id' | 'status' | 'attempt' | 'replayStartedAt'>, set: TrialUpdate): Promise<TrialRow | null> {
  const [row] = await db
    .update(runTrial)
    .set(set)
    .where(
      and(
        eq(runTrial.id, from.id),
        eq(runTrial.status, from.status),
        eq(runTrial.attempt, from.attempt),
        from.replayStartedAt === null ? isNull(runTrial.replayStartedAt) : eq(runTrial.replayStartedAt, from.replayStartedAt),
      ),
    )
    .returning();
  if (row !== undefined && set.status !== undefined && set.status !== from.status) {
    const status = set.status;
    const reason = row.voidReason;
    countOnProcessRegistry((metrics) => metrics.countTrialPass(status, reason));
  }
  return row ?? null;
}

/** Add run flags (each once, the whole list kept in code-unit order). */
export async function addRunFlags(db: Pick<Db, 'update'>, runId: string, flags: readonly string[]): Promise<void> {
  if (flags.length === 0) return;
  await db
    .update(run)
    .set({ flags: flagsAdding(flags) })
    .where(eq(run.id, runId));
}

/** Take a flag off a run (every copy of it). */
export async function dropRunFlag(db: Pick<Db, 'update'>, runId: string, flag: string): Promise<void> {
  await db
    .update(run)
    .set({ flags: sql`array_remove(${run.flags}, ${flag}::text)` })
    .where(eq(run.id, runId));
}

/** An agent/v1 grade run's verdict, or a dev run on practice windows' (finishRun). */
export interface FinishedRun {
  status: 'finished' | 'nondeterministic' | 'failed' | 'timeout' | 'cancelled';
  /** The trials manifest's canonical JSON (stored as a blob named by its sha256); null on a failed run. */
  action_log_json: string | null;
  action_log_sha256: string | null;
  result: ScoreT | null;
  result_sha256: string | null;
  /**
   * The run's checks trace (grader/agent-score.ts agentChecksBreakdown, grader/trace.ts encodeTrace), canonical JSON,
   * stored as a grade's trace is (the header), and the sha256 of its blob; absent or null when the run has none.
   */
  trace_json?: string | null;
  trace_sha256?: string | null;
  /** Live passes and replays the entry ran in. */
  exec_count: number;
  /** The counted live passes' wall time. */
  wall_ms: number;
  error: string | null;
  finished_at: Date;
  /**
   * An eras run's (a dev phase on practice windows) run-level digests, the median window's (or the first window that did
   * not finish): written with the verdict, the run having been started with none of them. Absent on an agent/v1 run,
   * whose digests startRun wrote. The action log, trace and stderr blobs are the window's, stored by recordEra already:
   * action_log_sha256 above names the window's log (with no action_log_json to store), trace_sha256 and stderr_sha256 here its other two.
   */
  median?: FinishedMedian;
}

/** The run-level digests an eras run takes from its median window (FinishedRun.median). */
export interface FinishedMedian {
  dataset_sha256: string | null;
  seed: string | null;
  fail_key: string | null;
  flags: string[];
  trace_sha256: string | null;
  stderr_sha256: string | null;
}

/**
 * The void reason of a trial a finishing run leaves mid-pass (`closeCutOffTrials`): the run ended without it, so no
 * attempt of it runs again. Distinct from INTERRUPTED_VOID_REASON (grader/worker.ts: a pass one attempt of the grader
 * cut off, which a later attempt of the same job takes again), so an admin reads the reason alone to tell a superseded
 * entry's cut-off from a grader restart's. Free text: run_trial_void_reason only asks that it is said.
 */
export const RUN_CANCELLED_VOID_REASON = 'run_cancelled';

/** The error the fan-in closes a cancelled entry's run with (grader/worker.ts createAgentAggregateHandler). */
export const ENTRY_CANCELLED_RUN_ERROR = 'the entry was cancelled while its trials ran';

/** The longest run error a cut-off pass's error quotes. */
export const CUT_OFF_RUN_REASON_MAX = 600;

/**
 * A cut-off pass's error, from its run row's own close reason (`runError`, the run's error as finishRun wrote it):
 * `live pass N was cut off when its run was closed <status>: <why>, and no pass of it runs again`. The opening words
 * never change (stored rows are read by them). <why> is "its job was cancelled with the entry" only when the run says
 * its entry was cancelled; else the run's reason quoted (a final's grading closed, a supersede, an ended entry, a
 * failed fan-in), or that it names none. deploy/k8s/jobs/admin-close-cancelled-trials.mjs writes the same sentence.
 */
export function cutOffPassError(attempt: SQL | typeof runTrial.attempt, endedAs: SQL, runError: SQL): SQL {
  return sql`format('live pass %s was cut off when its run was closed %s: %s, and no pass of it runs again', ${attempt}, ${endedAs}, case
    when ${runError} = ${ENTRY_CANCELLED_RUN_ERROR} then 'its job was cancelled with the entry'
    when coalesce(btrim(${runError}), '') = '' then 'its run names no reason'
    else format('its run''s own reason is "%s"', left(${runError}, ${CUT_OFF_RUN_REASON_MAX}::int))
  end)`;
}

/**
 * The trials a run that ends without them leaves mid-pass (`queue tags`), in `tx`: every row of the run still
 * `live_running`, `live_done` (a recorded pass its replay never took) or `replaying` is voided as run_cancelled at
 * `at` (never before its live pass started), its error naming the run's end (`endedAs`) and why, from the run row
 * this transaction just closed (cutOffPassError), so no row of a run that no longer runs says a pass is in flight. No
 * job moves one again (a cancelled grade-trial job never runs, and the trial handler stops on a run that is not
 * running: grader/worker.ts runContext), and an attempt landing meanwhile loses its moveTrial (written only from the
 * status it read). Answers how many it closed.
 */
export async function closeCutOffTrials(tx: Pick<Db, 'update'>, runId: string, at: Date, endedAs: FinishedRun['status']): Promise<number> {
  const closed = await tx
    .update(runTrial)
    .set({
      status: 'void',
      voidReason: RUN_CANCELLED_VOID_REASON,
      liveFinishedAt: sql`greatest(${runTrial.liveStartedAt}, ${at})`,
      error: cutOffPassError(runTrial.attempt, sql`${endedAs}::text`, sql`(select r.error from ${run} r where r.id = ${runTrial.runId})`),
    })
    .where(and(eq(runTrial.runId, runId), inArray(runTrial.status, ['live_running', 'live_done', 'replaying'])))
    .returning({ id: runTrial.id });
  countOnProcessRegistry((metrics) => metrics.countTrialPass('void', RUN_CANCELLED_VOID_REASON, closed.length));
  return closed.length;
}

/**
 * Write an agent/v1 grade run's verdict (its action log and trace blobs first) while the run is running, and its
 * standings change, in one transaction (the header), REHOST_REJECTED_FLAG added to its flags when a grade run of the
 * entry in the phase carries it (its own row included: a rejection landed while it ran); false when it is not running
 * (finished already) or there is no such run, and nothing is written, no change either.
 */
export async function finishRun(db: Db, blobs: Pick<BlobStore, 'put'>, runId: string, outcome: FinishedRun): Promise<boolean> {
  await putActionLog(blobs, outcome.action_log_json, outcome.action_log_sha256);
  const traceSha256 = await putTrace(blobs, outcome.trace_json, outcome.trace_sha256);
  return transactionOwingLiveChanges(db, async (tx) => {
    const [target] = await tx.select({ submissionId: run.submissionId, phaseId: run.phaseId }).from(run).where(eq(run.id, runId));
    if (target === undefined) return false;
    await lockEntries(tx, [target.submissionId]);
    const rejected = await carriesRejection(tx, target);
    const inherited = rejected ? [REHOST_REJECTED_FLAG] : [];
    // An eras run's flags are its median window's, with the rejection; an agent/v1 run keeps the ones its trials raised.
    const flags = outcome.median !== undefined ? withInherited(outcome.median.flags, inherited) : rejected ? flagsAdding(inherited) : undefined;
    const rows = await tx
      .update(run)
      .set({
        ...(flags === undefined ? {} : { flags }),
        status: outcome.status,
        actionLogSha256: outcome.action_log_sha256,
        result: outcome.result,
        resultSha256: outcome.result_sha256,
        traceSha256: outcome.median === undefined ? traceSha256 : outcome.median.trace_sha256,
        execCount: outcome.exec_count,
        wallMs: outcome.wall_ms,
        error: outcome.error,
        finishedAt: outcome.finished_at,
        ...(outcome.median === undefined
          ? {}
          : {
              datasetSha256: outcome.median.dataset_sha256,
              seed: outcome.median.seed,
              failKey: outcome.median.fail_key,
              stderrSha256: outcome.median.stderr_sha256,
            }),
      })
      .where(and(eq(run.id, runId), eq(run.status, 'running')))
      .returning({ phaseId: run.phaseId, kind: run.kind });
    if (rows.length === 0) return false;
    // A trial the run never started runs no more: out of the queue in the same step (closeUnstartedTrials).
    await closeUnstartedTrials(tx, { runId });
    // And a pass the run's end leaves mid-flight runs no more either: void, never a live row on a run that is not running.
    await closeCutOffTrials(tx, runId, outcome.finished_at, outcome.status);
    await recordGradeChanges(tx, rows.flatMap((r) => (r.kind === 'top_up' ? [] : [r.phaseId])));
    return true;
  });
}

// ---------------------------------------------------------------- a dev run's practice windows

export type EraRow = typeof runEra.$inferSelect;

/** One practice window of an eras run (or of its regrade), as recordEra stores it: the `run_era` row. */
export interface EraRecord {
  /** The window's key, w1..w9 (contracts/competition.ts practiceWindowKeys). */
  key: string;
  datasetId: string;
  datasetSha256: string;
  /** u64 decimal: the window's own phaseSeed. */
  seed: string;
  status: 'finished' | 'nondeterministic' | 'failed' | 'timeout';
  exec_count: number;
  wall_ms: number;
  error: string | null;
  /** The window's canonical action log and its sha256: the blob is stored first when the JSON is given (a regrade holds only the sha256 of the log it re-scored). */
  action_log_json?: string | null;
  action_log_sha256: string | null;
  /** The window's trace as GradeOutcome carries it: canonical JSON stored as a gzip blob, and the sha256 that blob must have. */
  trace_json?: string | null;
  trace_sha256?: string | null;
  stderr: Buffer;
  /** The window's own Score and its scoreDigest sha256; both null when it was left unscored. */
  result: ScoreT | null;
  result_sha256: string | null;
  started_at: Date;
  finished_at: Date;
}

/** An EraRecord with its blobs stored (putEras), the names the row carries. */
interface StoredEra {
  era: EraRecord;
  traceSha256: string | null;
  stderrSha256: string | null;
}

async function putEras(blobs: Pick<BlobStore, 'put'>, eras: readonly EraRecord[], mask: FormSet | null = null): Promise<StoredEra[]> {
  const stored: StoredEra[] = [];
  for (const era of eras) {
    await putActionLog(blobs, era.action_log_json ?? null, era.action_log_sha256);
    // A window's error is stored as its stderr is, masked of the run's entry secrets (the header's entry secrets).
    const masked = mask === null || era.error === null ? era : { ...era, error: redactSecrets(era.error, mask) };
    stored.push({ era: masked, traceSha256: (await putTrace(blobs, era.trace_json, era.trace_sha256)) ?? era.trace_sha256 ?? null, stderrSha256: await putStderr(blobs, era.stderr, mask) });
  }
  return stored;
}

async function insertEra(db: Pick<Db, 'insert'>, runId: string, { era, traceSha256, stderrSha256 }: StoredEra): Promise<void> {
  const values = {
    datasetId: era.datasetId,
    datasetSha256: era.datasetSha256,
    seed: era.seed,
    status: era.status,
    execCount: era.exec_count,
    error: era.error,
    wallMs: era.wall_ms,
    actionLogSha256: era.action_log_sha256,
    traceSha256,
    stderrSha256,
    result: era.result,
    resultSha256: era.result_sha256,
    startedAt: era.started_at,
    finishedAt: era.finished_at,
  };
  // A window row there already is written over only while its run is running (the header's recordEra): never a finished run's.
  await db
    .insert(runEra)
    .values({ runId, windowKey: era.key, ...values })
    .onConflictDoUpdate({ target: [runEra.runId, runEra.windowKey], set: values, setWhere: sql`exists (select 1 from ${run} where ${run.id} = ${runEra.runId} and ${run.status} = 'running')` });
}

/**
 * Write one window's row of an eras run (the header's recordEra), its action log, trace and stderr blobs first, its stderr
 * and error masked of `mask` (the run's entry secrets: RunSecrets.mask). A row of the run's for the window there already
 * (an earlier attempt's, one that did not finish) is written over. Only while the run is running, its row read FOR SHARE
 * in the write's transaction (finishRun's update waits for it, or it for finishRun): true when it wrote; false, nothing
 * written, when the run is finished (a stale attempt's or a second job's window, after the run's verdict) or there is no
 * such run.
 */
export async function recordEra(db: Db, blobs: Pick<BlobStore, 'put'>, runId: string, era: EraRecord, mask: FormSet | null = null): Promise<boolean> {
  const [stored] = await putEras(blobs, [era], mask);
  return db.transaction(async (tx) => {
    const [target] = await tx.select({ status: run.status }).from(run).where(eq(run.id, runId)).for('share');
    if (target?.status !== 'running') return false;
    await insertEra(tx, runId, stored!);
    return true;
  });
}

/** A run's window rows, in window key order. */
export async function loadEras(db: Pick<Db, 'select'>, runId: string): Promise<EraRow[]> {
  return db.select().from(runEra).where(eq(runEra.runId, runId)).orderBy(asc(runEra.windowKey));
}

/** The window an EraRecord is of: its key and the dataset and seed it was run on. */
export interface EraWindowRef {
  key: string;
  datasetId: string;
  datasetSha256: string;
  seed: string;
}

/** A window's grade (grade.ts gradeEntry on its plan) as its row: the executions summed, the window's own Score. */
export function eraOfGrade(w: EraWindowRef, o: GradeOutcome): EraRecord {
  return {
    ...w,
    status: o.status,
    exec_count: o.exec_count,
    wall_ms: o.wall_ms,
    error: o.error,
    action_log_json: o.action_log_json,
    action_log_sha256: o.action_log_sha256,
    trace_json: o.trace_json,
    trace_sha256: o.trace_sha256,
    stderr: o.stderr,
    result: o.result,
    result_sha256: o.result_sha256,
    started_at: o.started_at,
    finished_at: o.finished_at,
  };
}

/** A window's regrade (regrade.ts regradeL1 / regradeL2 on its plan) as its row on the regrade run: the action log is the stored run's, its blob there already. */
export function eraOfRegrade(w: EraWindowRef, o: RegradeOutcome): EraRecord {
  return {
    ...w,
    status: o.status,
    exec_count: o.exec_count,
    wall_ms: o.wall_ms,
    error: o.error,
    action_log_sha256: o.action_log_sha256,
    trace_json: o.trace_json,
    trace_sha256: o.trace_sha256,
    stderr: o.stderr,
    result: o.result,
    result_sha256: o.result_sha256,
    started_at: o.started_at,
    finished_at: o.finished_at,
  };
}
