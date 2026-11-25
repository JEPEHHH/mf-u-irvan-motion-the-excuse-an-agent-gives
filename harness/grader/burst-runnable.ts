// Which grade jobs the burst grader may run (deploy/k8s burst: a grader on s18 whose sandbox pods run on a rented
// k3s + gVisor cluster). The burst role works grade-trial, grade-dev and grade-final; a grade-dev or grade-final job it
// cannot run is handed back, with its priority kept, to the home graders (server/jobs.ts JobQueueOptions.homeOnly),
// and burstGradeHomeOnly is that rule for the two grade queues. It answers null (burst runs the job) only when all of
// these hold, and otherwise the reason the job stays home:
//
//   fresh grade     the job is a `grade`. A regrade (regrade_l1, regrade_l2) and an admin's provisional rejudge (a
//                   regrade_l1 carrying `rejudge`, grader/worker.ts createGradeHandler's `job.rejudge` branch) stay home:
//                   burst is for the backlog of fresh grades, and a regrade re-derives a stored run where it was graded.
//                   A practice top-up (`top_up`) stays home too: it starts no fresh grade.
//   allow-listed    the competition's harness kind is in BURST_GRADE_KINDS (program/v1, judged or not): it grades as
//                   pods the k8s driver stages by `kubectl exec`, needing no data claim inside a pod. The three replays
//                   (pumpfun-replay/v2, bars-replay/v1, clmm-replay/v1) stay home: each stages its window's data into its
//                   pod by `kubectl exec`, which over the WAN to a burst box is the whole cost (2026-11-13, makefun-dev
//                   on a hel1 cpx62: a bars-replay grade took 62.2 s on burst against 6.4 s at home, the exec link
//                   ~10 MiB/s in and ~14.5 MiB/s out at a 134-141 ms round trip; a program/v1 grade 28-29 s against
//                   18.5 s, which the backlog it clears is worth). agent/v1's grade job only starts its run
//                   (startAgentRun), whose trials reach burst through grade-trial; scrape/v1 grades in a heat of timed
//                   trials on s18's egress; patch/v1 runs the bounty's repository image, which no burst box holds.
//   untimed         eligibilityRulesOf(bundle).timing is undefined: a code-fastest dev grade carries a provisional timing
//                   measured on the process CPU clock in timed pods (grader/worker.ts withProvisionalTiming), and timed
//                   pods run only on s18's timed nodes (MAKEFUN_K8S_TIMED_NODE_SELECTOR).
//   pinned runtime  every runtime the harness runs (its `runtimes`, which the entry's own is one of, and a program
//                   scorer's) resolves to an image in grader/images.json, each run by its pinned digest.
//
// A judged program/v1 grade runs on burst too: its provisional judge heat runs no pod, calls the house judge from s18,
// and seats in the judge pool under the claim's judge-pool/, which the burst grader mounts like every home grader.
//
// Rows that cannot be read (no submission, no phase, a phase of another competition, no bundle, a bundle that does not
// validate, no snapshot yet) are reasons too: the job goes home, whose grade handler raises its own error as it does
// today. A database error is thrown, never a reason: the queue's own error handling meets it.

import { eq } from 'drizzle-orm';
import { CompetitionBundle, harnessRuntimesOf, type CompetitionBundleT, type HarnessKindT } from '../contracts/competition.ts';
import type { Db } from '../server/db/client.ts';
import { competition, phase, submission } from '../server/db/schema.ts';
import { gradeKindHomeOnly, type JobPayload, type QueueName } from '../server/jobs.ts';
import { IMAGES, type ImageTableT } from './images.ts';
import { eligibilityRulesOf } from './score.ts';
import type { Runtime } from './sandbox/types.ts';

/**
 * The harness kinds whose fresh, untimed grade the burst grader runs (the header's `allow-listed`). Each runs its entry
 * in a pod of a house runtime and records its run from the grader (grader/worker.ts createGradeHandler):
 *   - program/v1        programPhasePlan, gradeEntry; judged or not: the provisional judge heat runs no pod (the header).
 * Not here, so home only: pumpfun-replay/v2 (replayPlan), bars-replay/v1 (barsPlan) and clmm-replay/v1 (clmmPlan), whose
 * grades are bound by the `kubectl exec` transfer of their data and ran ~10x slower on a far burst box (the header);
 * agent/v1 (startAgentRun: its trials ride grade-trial), scrape/v1 (a heat of timed trials on s18's egress) and patch/v1
 * (patchPlan: the bounty's repository image, never a grader/images.json runtime).
 */
export const BURST_GRADE_KINDS = ['program/v1'] as const satisfies readonly HarnessKindT[];

/** The queues burstGradeHomeOnly judges: a grade job's (server/jobs.ts gradeQueue). */
export const BURST_GRADE_QUEUES = ['grade-dev', 'grade-final'] as const satisfies readonly QueueName[];

/** What burstGradeHomeOnly reads of a grade job (server/jobs.ts GradeJob, parsed). */
export type BurstGradeJob = Pick<JobPayload<'grade-dev'>, 'submission_id' | 'phase_id' | 'kind' | 'rejudge'>;

export interface BurstRunnableOptions {
  /** The pinned images a burst box holds; default grader/images.json (IMAGES). */
  images?: ImageTableT;
}

/**
 * Why a job of this kind stays home, or null for a fresh grade (the header's `fresh grade`): the rule is
 * server/jobs.ts gradeKindHomeOnly, by which JobQueue.send also queues such a job in its home-only group (sendGroupOf).
 */
export function burstJobKindRefusal(job: Pick<BurstGradeJob, 'kind' | 'rejudge'>): string | null {
  if (!gradeKindHomeOnly(job)) return null;
  if (job.rejudge !== undefined) return 'a provisional rejudge stays home: burst runs fresh grades only';
  if (job.kind === 'top_up') return 'a practice top-up stays home: burst runs fresh grades only';
  return `a ${job.kind} regrade stays home: burst runs fresh grades only`;
}

/** The runtimes a harness runs in: its entries' (harnessRuntimesOf) and a program/v1 scorer's. */
function harnessImageRuntimes(bundle: CompetitionBundleT): Runtime[] {
  const h = bundle.harness;
  const runtimes: Runtime[] = [...harnessRuntimesOf(h)];
  if (h.kind === 'program/v1') runtimes.push(h.scorer.runtime);
  return [...new Set(runtimes)];
}

/**
 * Why a fresh grade under `bundle` stays home, or null when burst runs it (the header's `allow-listed`, `untimed` and
 * `pinned runtime`); the job's own kind is burstJobKindRefusal's.
 */
export function burstBundleRefusal(bundle: CompetitionBundleT, opts: BurstRunnableOptions = {}): string | null {
  const kind = bundle.harness.kind;
  if (!(BURST_GRADE_KINDS as readonly HarnessKindT[]).includes(kind)) return `a grade of ${kind} stays home: burst grades only ${BURST_GRADE_KINDS.join(', ')}`;
  if (eligibilityRulesOf(bundle).timing !== undefined) return `a timed grade of ${kind} stays home: its timing runs in s18's timed pods`;
  const images = (opts.images ?? IMAGES).images as Partial<Record<Runtime, unknown>>;
  const runtimes = harnessImageRuntimes(bundle);
  if (runtimes.length === 0) return `a grade of ${kind} names no house runtime, so it stays home: burst runs only grader/images.json runtimes`;
  const unpinned = runtimes.filter((r) => images[r] === undefined);
  if (unpinned.length > 0) return `a grade of ${kind} runs ${unpinned.join(', ')}, which grader/images.json pins no image for, so it stays home`;
  return null;
}

/**
 * Whether the burst grader may run grade job `payload` of `queue` (see the header): null when it may, else the reason it
 * is handed back to the home graders. Reads the submission, its phase and its competition's bundle as the grade handler
 * does (grader/worker.ts createGradeHandler); a regrade or rejudge is answered before any read.
 */
export async function burstGradeHomeOnly(db: Db, queue: QueueName, payload: BurstGradeJob, opts: BurstRunnableOptions = {}): Promise<string | null> {
  if (!(BURST_GRADE_QUEUES as readonly QueueName[]).includes(queue)) return `a ${queue} job stays home: burst judges only ${BURST_GRADE_QUEUES.join(' and ')} jobs by their grade`;
  const kindRefusal = burstJobKindRefusal(payload);
  if (kindRefusal !== null) return kindRefusal;
  const [sub] = await db.select({ id: submission.id, competitionId: submission.competitionId, snapshotSha256: submission.snapshotSha256 }).from(submission).where(eq(submission.id, payload.submission_id));
  if (sub === undefined) return `submission ${payload.submission_id} does not exist, so the job goes home to fail there`;
  if (sub.snapshotSha256 === null) return `submission ${sub.id} has no snapshot yet, so the job goes home to fail there`;
  const [ph] = await db.select({ id: phase.id, competitionId: phase.competitionId }).from(phase).where(eq(phase.id, payload.phase_id));
  if (ph === undefined) return `phase ${payload.phase_id} does not exist, so the job goes home to fail there`;
  if (ph.competitionId !== sub.competitionId) return `phase ${ph.id} is not a phase of submission ${sub.id}'s competition, so the job goes home to fail there`;
  const [comp] = await db.select({ slug: competition.slug, bundle: competition.bundle }).from(competition).where(eq(competition.id, sub.competitionId));
  if (comp === undefined) return `competition ${sub.competitionId} does not exist, so the job goes home to fail there`;
  if (comp.bundle === null) return `competition ${comp.slug} has no bundle, so the job goes home to fail there`;
  const parsed = CompetitionBundle.safeParse(comp.bundle);
  if (!parsed.success) return `competition ${comp.slug}'s stored bundle does not validate, so the job goes home to fail there`;
  const refusal = burstBundleRefusal(parsed.data, opts);
  return refusal === null ? null : `${comp.slug}: ${refusal}`;
}
