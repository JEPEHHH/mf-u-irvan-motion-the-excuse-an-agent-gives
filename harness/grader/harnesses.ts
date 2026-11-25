// The harness registry: what grading means per competition harness kind. A plan binds a bundle's
// harness config (plus the phase's dataset and seed) into the three things grade.ts and regrade.ts
// need, so neither knows which harness it is driving:
//
//   execute(ctx)    run the entry once in the sandbox; its action log comes back canonical
//   score(ctx, log) the performance (contracts/score.ts Performance) of an action log, and flags
//   parseLog(json)  a stored action log, validated (L1 regrades from it)
//
//   pumpfun-replay/v2   the lockstep replay (run.ts) over the dataset reduced to its universe
//                       (filterUniverse); performance = scoreActionLog: a pure function of (dataset,
//                       action log, the bundle's guardrails and interval, its counterparties opt-in,
//                       the final window, the fail key). The fail key keys the failed-tx draw in
//                       both the execution and the scoring; it is never in hello or the action log,
//                       so the plan carries it and the run records it (grade.ts fail_key) for regrades
//   program/v1          the entry writes outputs, the competition's scorer container scores them
//                       (program.ts); performance = the validated scores.json, plus the blocks the grader
//                       fills from the entry's own records, never from the scorer (performance.passed, the
//                       timing or judge heat's verdicts, and performance.entry_link: the entry's
//                       house-verified launch, from the submission's stored entry-link record, grade.ts
//                       scoreWithEntryLink)
//   bars-replay/v1      the lockstep bars replay (run.ts executeLockstep over sim/bars/engine.ts
//                       BarsEngine and contracts/bars-protocol.ts) over the phase's frozen bars window
//                       (dataset.ts readFrozenBarsDataset), the hello the harness block's numbers plus
//                       the dataset's scales (sim/bars/params.ts makeBarsHello); performance =
//                       scoreBarsActionLog: a pure function of (dataset, action log, the harness's
//                       guardrails and interval, the final window). No fail key: the bars replay draws
//                       nothing
//   clmm-replay/v1      the lockstep clmm replay (run.ts executeLockstep over sim/clmm/engine.ts
//                       ClmmEngine and its line codec CLMM_LOCKSTEP, contracts/clmm-protocol.ts) over the
//                       phase's frozen pool window (dataset.ts readFrozenClmmDataset; at least
//                       CLMM_MIN_BLOCKS whole blocks of the harness's interval.block_hours on dev, and
//                       CLMM_RANKED_MIN_BLOCKS (28) on the ranked final phase, else refused:
//                       contracts/clmm-protocol.ts clmmPhaseBlocksIssue), the hello the
//                       harness block's numbers plus the dataset's price scale and first close
//                       (sim/clmm/params.ts makeClmmHello); performance = scoreClmmActionLog: a pure
//                       function of (dataset, action log, the harness, the final window), its LVR held
//                       to LVR leg by leg on every score before it is returned (sim/clmm/metrics.ts
//                       assertClmmLvr: a score that parts from it by more than rounding throws
//                       ClmmLvrMismatchError, the platform's fault, and nothing is scored). No fail
//                       key: the clmm replay draws nothing either
//
//   The three replays' score also returns the run's trace (Scored.trace: contracts/breakdown.ts, built
//   by grader/trace.ts traceOfReplayRun, traceOfBarsRun and traceOfClmmRun from the same 1x run the
//   performance is computed on): beside the performance, never in it, so the score's bytes are what
//   they were without it. A program/v1 run's is its scorer's checks trace (grader/program-scores.ts
//   programChecksTrace of the rows its scorer wrote beside scores.json, checks.json), when it wrote
//   any; it has none when its scorer writes no checks.json.
//
//   A breakdown never fails a grade: a checks.json that is malformed, or rows the trace contract refuses,
//   make no trace (Scored.traceIssue says why, grade.ts logs it), and the performance is exactly what it
//   is without them (scoreProgramBreakdown: the scorer's every other fault is still a ScorerError).
//
//   agent/v1            not graded as one execution scored from its log, but as K trials, each a live
//                       pass and its replay against the bundle's env (contracts/agent.ts), run by
//                       grader/agent.ts and aggregated by grader/agent-score.ts aggregateTrials. Its
//                       plan (agentPlan) carries what grade.ts's helpers read of any run (runtimes,
//                       images, scorer_version, seed, dataset digest) and parses its action log, the
//                       trials manifest; its execute and score refuse.
//   scrape/v1           not graded as one execution either, but as a heat of timed trials every entry
//                       of the heat runs in (contracts/scrape.ts), run by grader/scrape/heat.ts
//                       runScrapeHeat and judged by grader/scrape/score.ts (grader/worker.ts: a dev
//                       phase's practice heat, the final phase's one heat). Its plan (scrapePlan), as
//                       agent/v1's, carries what grade.ts's and regrade.ts's helpers read of any run
//                       (runtimes, images, scorer_version, seed, dataset digest: the heat record's) and
//                       parses its action log, the run's trials manifest; its execute and score refuse.
//                       So HARNESSES, the registry of the plans that run, is keyed by PlanHarnessKindT,
//                       every kind but these two, referral/v1 and desk/v1.
//   referral/v1         not graded as one execution either: an entry is an ad page and its image,
//                       checked by the referral contest's rules rather than run (contracts/competition.ts
//                       ReferralHarness), so it has no plan here at all. Its verdict is written as the
//                       run's referral performance (contracts/score.ts ReferralPerformance) by the
//                       referral branch of the grade; no sandbox, runtime, image or dataset is read.
//   desk/v1             not graded as one execution either: an entry names a campaign, and its grade counts
//                       what that campaign's desk already decided for the entrant (contracts/competition.ts
//                       DeskHarness), so it has no plan here at all. The count is written as the run's desk
//                       performance (contracts/score.ts DeskPerformance) by the desk branch of the grade
//                       (grader/worker.ts gradeDesk); no sandbox, runtime, image or dataset is read.
//   patch/v1            a unified diff applied to an upstream repo's sealed tree and graded by its own tests
//                       (contracts/patch.ts). Its plan (patchPlan) runs the entry's patch.diff on the bounty's
//                       sealed base tree and the phase's tree (grader/worker.ts patchPhaseSetup materializes
//                       both), in the bounty's pinned image (patch/execute.ts executePatch), and scores the
//                       run log against the phase's lists (patch/score.ts scorePatch), executed twice as
//                       every grade is (grader/grade.ts), under PATCH_RUNTIME. It grades on the docker driver
//                       alone (the k8s driver runs no repository image), and keeps no test log: the final's
//                       tests are sealed, and what a run records is the log alone.
//
//   Entry secrets. An execution context may carry the entrant's env-lane entry secrets (ExecuteContext.secrets,
//   NAME to value; grader/worker.ts opens them, grade.ts executeOnce hands them in from the entry's SnapshotSource):
//   every plan that runs passes them to its execution (run.ts SandboxRunOptions.secrets, program.ts
//   ProgramExecutionOptions.secrets), so the entry gets them as variables of its own sandbox on each of a grade's
//   two executions, every case of a run per case, an L2 re-execution and a code heat's timed runs alike. A score
//   never takes them (ScoreContext has none): the scorer is the competition's program.
//   patch/v1's plan takes none: its run is the house runner applying the entry's diff and running the owner's
//   tests in the bounty's image, so no program of the entrant's runs to read them.

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { AgentTrials, type AgentTrialsT } from '../contracts/agent.ts';
import type { TraceT } from '../contracts/breakdown.ts';
import { barsReplyOrderCap, parseBarsBotLine, type BarsBatchT, type BarsDoneT, type BarsHelloT, type BarsReplayHarnessT, type BarsReplyT } from '../contracts/bars-protocol.ts';
import { clmmBlockHoursIssue, clmmPhaseBlocksIssue, type ClmmPhaseKeyT, type ClmmReplayHarnessT } from '../contracts/clmm-protocol.ts';
import { COUNTS_ENTRY_LINK_PLATFORMS, entryLinkCountedOf, type AgentHarnessT, type CountsEntryLinkPlatformT, type EntryLinkCountedT, type HARNESS_KINDS, type ReplayHarness, type ScrapeHarnessT } from '../contracts/competition.ts';
import type { PatchHarnessT, PatchPhaseT } from '../contracts/patch.ts';
import type { PerformanceT } from '../contracts/score.ts';
import { ScrapeTrials, type ScrapeTrialsT } from '../contracts/scrape.ts';
import { BarsActionLog, BarsEngine, encodeBarsHarnessLine, type BarsActionLogT, type BarsDataset } from '../sim/bars/engine.ts';
import { makeBarsHello } from '../sim/bars/params.ts';
import { canonicalJson } from '../sim/canonical.ts';
import { CLMM_LOCKSTEP, ClmmActionLog, ClmmEngine, SimDataError, type ClmmActionLogT, type ClmmDataset } from '../sim/clmm/engine.ts';
import { assertClmmLvr, scoreClmmActionLog, type ClmmFinalWindow } from '../sim/clmm/metrics.ts';
import { makeClmmHello } from '../sim/clmm/params.ts';
import { ActionLog, filterUniverse, type ActionLogT, type ReplayDataset } from '../sim/engine.ts';
import { scoreActionLog, scoreBarsActionLog, type BarsMetricsParams, type MetricsParams } from '../sim/metrics.ts';
import { makeHello } from '../sim/params.ts';
import { publicFailKey } from '../sim/rng.ts';
import type { UniverseSampleT } from '../sim/universe.ts';
import { executeProgram, ProgramOutputs, programDataSha256, programDataSha256Async, programScorerDigest, programScorerDigestAsync, scoreProgramWithChecks, type OutputBlobs, type ProgramOutputsT, type ProgramRunTime, type ProgramScoreOptions, type ProgramSetup } from './program.ts';
import { programChecksTrace, readChecks, readScores, scoredColumns, ScorerError, type ProgramScores, type ScorerChecksT } from './program-scores.ts';
import { PATCH_DIFF_FILE } from './patch/diff.ts';
import { executePatch, type PatchExecutionOptions } from './patch/execute.ts';
import { PatchRunLog, type PatchRunLogT } from './patch/junit.ts';
import { scorePatch } from './patch/score.ts';
import { executeLockstep, executeReplay, type Execution, type LimitsT, type LockstepEndObserver, type LockstepProtocol } from './run.ts';
import type { Runtime, Sandbox } from './sandbox/types.ts';
import { traceOfBarsRun, traceOfClmmRun, traceOfReplayRun } from './trace.ts';
import { scorerVersion } from './version.ts';

export type HarnessKindT = (typeof HARNESS_KINDS)[number];

/** The kinds graded as one execution through a HarnessPlan (the header): every kind but agent/v1, scrape/v1, referral/v1 and desk/v1. */
export type PlanHarnessKindT = Exclude<HarnessKindT, 'agent/v1' | 'scrape/v1' | 'referral/v1' | 'desk/v1'>;

export interface ExecuteContext {
  sandbox: Sandbox;
  runtime: Runtime;
  /** The freshly materialized snapshot (mounted read-only at /bot). */
  botDir: string;
  limits: LimitsT;
  /** A fresh, empty directory for this execution. */
  workDir: string;
  blobs: OutputBlobs;
  label: string;
  /** The image digest to run (null: the sandbox's pinned image, or the process driver). */
  imageDigest: string | null;
  /**
   * The entrant's env-lane entry secrets, NAME to value (the header's entry secrets): variables of the entry's own
   * sandbox on this execution (each case's run, on a run per case), masked out of what it says. Absent or empty: none.
   */
  secrets?: Readonly<Record<string, string>>;
  /**
   * Told once at a lockstep replay execution's end (pumpfun-replay/v2, bars-replay/v1, clmm-replay/v1: run.ts
   * LockstepExecutionOptions.onExecutionEnd, the engine's turn beside the total wall and the bot's clock); every other
   * kind never calls it. Absent: nothing is told.
   */
  onExecutionEnd?: LockstepEndObserver;
}

/** An execution context's end observer as the lockstep run options take it: absent with none. */
function endObserverOf(ctx: Pick<ExecuteContext, 'onExecutionEnd'>): { onExecutionEnd?: LockstepEndObserver } {
  return ctx.onExecutionEnd === undefined ? {} : { onExecutionEnd: ctx.onExecutionEnd };
}

/** An execution context's entry secrets as the run options take them: absent with none, so an execution with none is what it always was. */
function secretsOf(ctx: Pick<ExecuteContext, 'secrets'>): { secrets?: Readonly<Record<string, string>> } {
  return ctx.secrets === undefined || Object.keys(ctx.secrets).length === 0 ? {} : { secrets: ctx.secrets };
}

/** What a plan's scorer runs with. No entry secret, ever: the scorer is the competition's program, never the entrant's (the header's entry secrets). */
export interface ScoreContext {
  sandbox: Sandbox;
  blobs: OutputBlobs;
  limits: LimitsT;
  /** A fresh, empty directory for the scorer. */
  workDir: string;
  /**
   * The graded run's measured wall time (grade.ts gradeIn: its executions; regrade.ts rescore: the stored run's), which a
   * program/v1 scorer finds in /scores/run.json (program.ts RUN_FILE). Absent: no file. Every other plan ignores it.
   */
  run?: ProgramRunTime | null;
}

export interface Scored {
  performance: PerformanceT;
  flags: string[];
  /**
   * The run's trace (contracts/breakdown.ts; grader/trace.ts), kept beside the score and never inside it: what a
   * replay harness's score returns of the same 1x run its performance is computed on, a program/v1 scorer's checks
   * trace (programChecksTrace). Absent: the harness has none, or the scorer's breakdown made none (traceIssue).
   */
  trace?: TraceT;
  /**
   * Why the scorer's breakdown made no trace (program/v1: a malformed checks.json, rows the trace contract refuses):
   * the grade logs it and stores no trace, its score standing exactly as without the breakdown. Absent otherwise.
   */
  traceIssue?: string;
}

export interface HarnessPlan<Log = unknown> {
  kind: HarnessKindT;
  /** The run's dataset_sha256. */
  datasetSha256: string | null;
  seed: string;
  /** The failed-tx draw's key (u64 decimal; pumpfun-replay/v2), null when the harness draws none. Never sent to the entry. */
  failKey: string | null;
  /** The runtimes the competition accepts. */
  runtimes: readonly Runtime[];
  /** Runtimes the sandbox must hold images for besides the entry's (program/v1's scorer). */
  extraRuntimes: readonly Runtime[];
  scorerVersion: string;
  /**
   * The `sha256:<hex>` of the image the run executes in when the plan names its own (patch/v1: the bounty's
   * harness.image), recorded as the score's image_digest in place of the runtime's pool image; absent = that one.
   */
  imageDigest?: string;
  /**
   * The path under /output where the house writes its dossier of the coin (contracts/competition.ts ProgramEntryLink
   * .dossier; program.ts's header `The house dossier`): a program/v1 plan's whose bundle's pump.fun entry link names
   * one, which the grade (grade.ts houseDossierLogOf) and an L2 regrade's re-execution (regrade.ts) make the house's
   * file once the program's own logs are compared. Null on every other plan: its logs are scored as they ran.
   */
  houseDossier: string | null;
  /**
   * The path under /output where the house writes the counts of the entry's link (contracts/competition.ts
   * ProgramEntryLink.counts; program.ts's header `The house counts`: a YouTube video's, an X post's, a TikTok video's or
   * a make.fun bounty's): a program/v1 plan's whose bundle's entry link, on a platform of COUNTS_ENTRY_LINK_PLATFORMS,
   * names one, which the grade (grade.ts houseCountsLogOf) and an L2 regrade's re-execution make the house's file once
   * the program's own logs are compared. Null on every other plan.
   */
  houseCounts: string | null;
  /**
   * The platform of the entry link whose counts houseCounts names (COUNTS_ENTRY_LINK_PLATFORMS: youtube, x, tiktok, makefun),
   * null exactly where houseCounts is: the grade (program.ts houseCountsOutputs) takes the house's fault on an entry's
   * record of another platform than this, never writing that platform's counts at the path.
   */
  houseCountsPlatform: CountsEntryLinkPlatformT | null;
  /**
   * Who the make.fun entry link whose counts houseCounts names counts as a named bounty's entrants
   * (contracts/competition.ts ProgramEntryLink.counted, entryLinkCountedOf: 'paying' where the link names none), null on
   * every plan whose houseCountsPlatform is not 'makefun'. The grade hands it to program.ts houseCountsOutputs: under
   * 'all' a found bounty that charges no fee writes its row's entry fee '0.00', never the house's fault.
   */
  houseCountsCounted: EntryLinkCountedT | null;
  /**
   * Whether the counts houseCounts names are an X pool link's list of posts (contracts/competition.ts
   * ProgramEntryLink.pool; houseCountsPostsOf): true exactly where the bundle's X entry link names `counts` and `pool`,
   * false on every other plan. The grade hands it to program.ts houseCountsOutputs, whose list branch it keys (an
   * XPostsCounts file, makefun/x-posts-counts/v1, of every post the record lists), never the record's shape.
   */
  houseCountsPosts: boolean;
  parseLog(json: unknown): Log;
  execute(ctx: ExecuteContext): Promise<Execution<Log>>;
  score(ctx: ScoreContext, log: Log): Promise<Scored>;
}

// ---------------------------------------------------------------- pumpfun-replay/v2

export interface ReplayPlanInput {
  harness: z.infer<typeof ReplayHarness>;
  dataset: ReplayDataset;
  /** The dataset's universe sample rule (its manifest's). */
  sample: UniverseSampleT;
  /** The phase seed: hello.seed, and the bootstrap's seed. */
  seed: string;
  /**
   * The failed-tx draw's key (u64 decimal). Default publicFailKey(seed): the dev phase's, which a kit
   * reproduces. The final phase passes its secret one (grader/worker.ts failKeyFor).
   */
  failKey?: string;
  /** Final phase: the server time of the last graded receipt. Null on dev. */
  finalWindow: { last_graded_receipt_at: string } | null;
  /** Strict ChainEvent parsing in the chain check (default true). */
  schemaCheck?: boolean;
}

// universeDataset's results per dataset object (the loader's per-process cached one, dataset.ts cachedLoader), then per
// sample's canonical JSON: every grade of one phase on a grader shares one reduced dataset, so one events array, and
// the engine's memos keyed by it hit across grades. Callers only read what it returns.
const universeMemo = new WeakMap<ReplayDataset, Map<string, ReplayDataset>>();

/** The dataset reduced to its universe, end_slot kept from the whole window; the same object for the same dataset object and sample. */
export function universeDataset(dataset: ReplayDataset, sample: UniverseSampleT): ReplayDataset {
  let bySample = universeMemo.get(dataset);
  if (bySample === undefined) universeMemo.set(dataset, (bySample = new Map()));
  const key = canonicalJson(sample);
  const memo = bySample.get(key);
  if (memo !== undefined) return memo;
  const events = filterUniverse(dataset.events, sample, dataset.excluded_mints ?? []);
  const last = dataset.events.length > 0 ? dataset.events[dataset.events.length - 1]!.slot : 0;
  const reduced: ReplayDataset = {
    sha256: dataset.sha256,
    events,
    ...(dataset.excluded_mints === undefined ? {} : { excluded_mints: dataset.excluded_mints }),
    end_slot: dataset.end_slot ?? last,
  };
  bySample.set(key, reduced);
  return reduced;
}

export function replayPlan(input: ReplayPlanInput): HarnessPlan<ActionLogT> {
  const h = input.harness;
  const hello = makeHello({
    seed: input.seed,
    sample: input.sample,
    capital_lamports: h.capital.lamports,
    caps: h.caps,
    latency_slots: h.latency_slots,
    fees: h.fees,
  });
  const dataset = universeDataset(input.dataset, input.sample);
  // The counterparties opt-in only when the harness sets it: without it the params, and the score, are what they always were.
  const params: MetricsParams = { guardrails: h.guardrails, interval: h.interval, final_window: input.finalWindow, ...(h.counterparties === true ? { counterparties: true } : {}) };
  const schemaCheck = input.schemaCheck ?? true;
  const failKey = input.failKey ?? publicFailKey(input.seed);
  return {
    kind: 'pumpfun-replay/v2',
    datasetSha256: dataset.sha256,
    seed: input.seed,
    failKey,
    runtimes: h.runtimes,
    extraRuntimes: [],
    scorerVersion: scorerVersion(),
    houseDossier: null,
    houseCounts: null,
    houseCountsPlatform: null,
    houseCountsCounted: null,
    houseCountsPosts: false,
    parseLog: (json) => ActionLog.parse(json),
    execute: (ctx) =>
      executeReplay({
        sandbox: ctx.sandbox,
        runtime: ctx.runtime,
        botDir: ctx.botDir,
        dataset,
        hello,
        limits: ctx.limits,
        label: ctx.label,
        imageDigest: ctx.imageDigest,
        engine: { schemaCheck, failKey },
        ...secretsOf(ctx),
        ...endObserverOf(ctx),
      }),
    score: async (_ctx, log) => {
      const scored = scoreActionLog(dataset, log, params, { schemaCheck, failKey });
      return { performance: { kind: 'pumpfun-replay/v2', metrics: scored.metrics }, flags: scored.flags, trace: traceOfReplayRun(scored.run) };
    },
  };
}

// ---------------------------------------------------------------- program/v1

export interface ProgramPlanInput {
  setup: ProgramSetup;
  seed: string;
  /**
   * The setup's digests when the caller took them already (programPlanAsync: off the event loop), else programPlan takes
   * them itself: its dataset digest (programDataSha256) and its scorer directory's (programScorerDigest).
   */
  digests?: { datasetSha256: string; scorerDigest: string };
}

/**
 * The house counts' /output path of a program/v1 bundle's entry link (HarnessPlan.houseCounts): its `counts` on a
 * platform whose counts the house reads (contracts/competition.ts COUNTS_ENTRY_LINK_PLATFORMS: youtube, x, tiktok,
 * makefun), else null (no link, another platform's, or one naming none).
 */
export function houseCountsPathOf(link: { platform: string; counts?: string | undefined } | undefined): string | null {
  if (link === undefined || !(COUNTS_ENTRY_LINK_PLATFORMS as readonly string[]).includes(link.platform)) return null;
  return link.counts ?? null;
}

/** The platform of a program/v1 entry link whose house counts houseCountsPathOf names (HarnessPlan.houseCountsPlatform), else null. */
export function houseCountsPlatformOf(link: { platform: string; counts?: string | undefined } | undefined): CountsEntryLinkPlatformT | null {
  return link !== undefined && houseCountsPathOf(link) !== null ? (link.platform as CountsEntryLinkPlatformT) : null;
}

/**
 * Who a program/v1 bundle's make.fun counts link counts as a named bounty's entrants (HarnessPlan.houseCountsCounted:
 * entryLinkCountedOf, 'paying' where it names none), else null (no link, another platform's, or one naming no counts).
 */
export function houseCountsCountedOf(link: { platform: string; counts?: string | undefined; counted?: EntryLinkCountedT | undefined } | undefined): EntryLinkCountedT | null {
  if (link === undefined || houseCountsPlatformOf(link) !== 'makefun') return null;
  return entryLinkCountedOf(link.counted === undefined ? {} : { counted: link.counted });
}

/**
 * Whether a program/v1 bundle's counts link is an X pool link's (HarnessPlan.houseCountsPosts): its counts on 'x'
 * (houseCountsPlatformOf) beside a `pool` (contracts/competition.ts ProgramEntryLink.pool), else false (no link,
 * another platform's, one naming no counts, or an X link naming no pool).
 */
export function houseCountsPostsOf(link: { platform: string; counts?: string | undefined; pool?: unknown } | undefined): boolean {
  return link !== undefined && houseCountsPlatformOf(link) === 'x' && link.pool !== undefined;
}

export function programPlan(input: ProgramPlanInput): HarnessPlan<ProgramOutputsT> {
  const { setup } = input;
  const scorerRuntime = setup.harness.scorer.runtime;
  return {
    kind: 'program/v1',
    datasetSha256: input.digests?.datasetSha256 ?? programDataSha256(setup),
    seed: input.seed,
    failKey: null,
    runtimes: setup.harness.runtimes,
    extraRuntimes: [scorerRuntime],
    // The house dossier's /output path (ProgramEntryLink.dossier; program.ts's header of the name), where the bundle names one.
    houseDossier: setup.harness.entry_link?.dossier ?? null,
    // The house counts' /output path (ProgramEntryLink.counts, a YouTube, an X, a TikTok or a make.fun link's alone:
    // COUNTS_ENTRY_LINK_PLATFORMS; program.ts's header of the name).
    houseCounts: houseCountsPathOf(setup.harness.entry_link),
    houseCountsPlatform: houseCountsPlatformOf(setup.harness.entry_link),
    // Who a make.fun counts link counts (ProgramEntryLink.counted): 'all' lets a free bounty's counts be written.
    houseCountsCounted: houseCountsCountedOf(setup.harness.entry_link),
    // Whether those counts are an X pool link's list of posts (ProgramEntryLink.pool): the list branch's key.
    houseCountsPosts: houseCountsPostsOf(setup.harness.entry_link),
    scorerVersion: scorerVersion(input.digests?.scorerDigest ?? programScorerDigest(setup)),
    parseLog: (json) => ProgramOutputs.parse(json),
    execute: (ctx) =>
      executeProgram({
        sandbox: ctx.sandbox,
        runtime: ctx.runtime,
        botDir: ctx.botDir,
        setup,
        limits: ctx.limits,
        workDir: ctx.workDir,
        blobs: ctx.blobs,
        label: ctx.label,
        imageDigest: ctx.imageDigest,
        ...secretsOf(ctx),
      }),
    score: async (ctx, outputs) => {
      const scored = await scoreProgramBreakdown({ sandbox: ctx.sandbox, setup, outputs, blobs: ctx.blobs, limits: ctx.limits, workDir: ctx.workDir, run: ctx.run ?? null });
      // The performance is scores.json alone, whatever the rows beside it hold: the trace never moves the score's bytes.
      return { performance: { kind: 'program/v1', scores: scored.scores }, flags: [], ...programTrace(scored) };
    },
  };
}

/**
 * programPlan with the setup's digests taken on fs/promises first (program.ts programDataSha256Async and
 * programScorerDigestAsync, each file's sum kept for the process): what a grade's job path plans by. A setup programPlan
 * refuses (programPaths' ScorerError) rejects with the same error.
 */
export async function programPlanAsync(input: ProgramPlanInput): Promise<HarnessPlan<ProgramOutputsT>> {
  if (input.digests !== undefined) return programPlan(input);
  // One after the other, as programPlan takes them: a setup that fails both fails on its dataset, as there.
  const datasetSha256 = await programDataSha256Async(input.setup);
  const scorerDigest = await programScorerDigestAsync(input.setup);
  return programPlan({ ...input, digests: { datasetSha256, scorerDigest } });
}

/** What a program/v1 scorer's run gave: its scores, and its per-check rows unless they were dropped (checksIssue says why). */
export interface ProgramBreakdown {
  scores: ProgramScores;
  /** The validated checks.json; null when the scorer wrote none, or wrote one that was dropped. */
  checks: ScorerChecksT | null;
  /** Why the scorer's checks.json was dropped (program-scores.ts readChecks's refusal of it); null when it was not. */
  checksIssue: string | null;
}

/** The directory scoreProgramWithChecks has the scorer write into under its work directory (program.ts: `<workDir>/scores`). */
const PROGRAM_SCORES_DIR = 'scores';

/**
 * Run the competition's scorer on stored outputs (program.ts scoreProgramWithChecks), its per-check rows a breakdown
 * that never fails the scoring (the header): a checks.json that program-scores.ts readChecks refuses (malformed, not a
 * regular file, too large, no JSON) is dropped, `checks` null and `checksIssue` the refusal, and the scores are what
 * the scorer's scores.json holds, validated as ever. Every other fault is thrown as scoreProgramWithChecks throws it
 * (a ScorerError: the scorer crashed or timed out, scores.json is missing or malformed).
 *
 * readChecks is scoreProgramWithChecks's last step, after the scorer exited 0 and scores.json validated, so a
 * ScorerError it throws is told from the rest by reading checks.json again from the same directory: the same refusal,
 * word for word, is checks.json's, and the scores are read back from beside it; anything else is thrown.
 */
export async function scoreProgramBreakdown(opts: ProgramScoreOptions): Promise<ProgramBreakdown> {
  try {
    const { scores, checks } = await scoreProgramWithChecks(opts);
    return { scores, checks, checksIssue: null };
  } catch (err) {
    if (!(err instanceof ScorerError)) throw err;
    const scoresDir = join(opts.workDir, PROGRAM_SCORES_DIR);
    if ((await checksRefusal(scoresDir)) !== err.message) throw err;
    return { scores: await readScores(scoresDir, scoredColumns(opts.setup.leaderboard)), checks: null, checksIssue: err.message };
  }
}

/** The message readChecks refuses `<scoresDir>/checks.json` with, or null when it reads it (or finds none). */
async function checksRefusal(scoresDir: string): Promise<string | null> {
  try {
    await readChecks(scoresDir);
    return null;
  } catch (err) {
    return err instanceof ScorerError ? err.message : null;
  }
}

/**
 * A program/v1 run's trace from its scorer's breakdown (the header): the checks trace of its rows (programChecksTrace),
 * nothing when the scorer wrote none, and the reason, never a trace, when its rows were dropped or make no trace.
 */
export function programTrace(b: Pick<ProgramBreakdown, 'checks' | 'checksIssue'>): Pick<Scored, 'trace' | 'traceIssue'> {
  if (b.checksIssue !== null) return { traceIssue: `the scorer's checks.json was dropped: ${b.checksIssue}` };
  if (b.checks === null) return {};
  try {
    return { trace: programChecksTrace(b.checks) };
  } catch (err) {
    if (!(err instanceof ScorerError)) throw err;
    return { traceIssue: err.message };
  }
}

// ---------------------------------------------------------------- bars-replay/v1

/** The bars replay's line codec (contracts/bars-protocol.ts, sim/bars/engine.ts). */
export const BARS_LOCKSTEP: LockstepProtocol<BarsHelloT, BarsBatchT, BarsDoneT, BarsReplyT> = {
  encode: encodeBarsHarnessLine,
  parseLine: parseBarsBotLine,
  replyOrderCap: barsReplyOrderCap,
};

export interface BarsPlanInput {
  harness: BarsReplayHarnessT;
  /** The phase's frozen bars window (dataset.ts readFrozenBarsDataset): a superset of the harness's universe. */
  dataset: BarsDataset;
  /** The phase seed: hello.seed, and the bootstrap's seed. */
  seed: string;
  /** Final phase: the server time of the last graded receipt. Null on dev. */
  finalWindow: { last_graded_receipt_at: string } | null;
}

/**
 * The bars-replay/v1 plan (see the header). Throws SimDataError when the dataset cannot replay the
 * harness: a universe symbol it does not carry, under another mint, or at another interval.
 */
export function barsPlan(input: BarsPlanInput): HarnessPlan<BarsActionLogT> {
  const h = input.harness;
  const { dataset } = input;
  const hello = makeBarsHello({ harness: h, dataset, seed: input.seed });
  const params: BarsMetricsParams = { guardrails: h.guardrails, interval: h.interval, final_window: input.finalWindow };
  return {
    kind: 'bars-replay/v1',
    datasetSha256: dataset.sha256,
    seed: input.seed,
    failKey: null,
    runtimes: h.runtimes,
    extraRuntimes: [],
    scorerVersion: scorerVersion(),
    houseDossier: null,
    houseCounts: null,
    houseCountsPlatform: null,
    houseCountsCounted: null,
    houseCountsPosts: false,
    parseLog: (json) => BarsActionLog.parse(json),
    execute: (ctx) =>
      executeLockstep({
        sandbox: ctx.sandbox,
        runtime: ctx.runtime,
        botDir: ctx.botDir,
        limits: ctx.limits,
        label: ctx.label,
        imageDigest: ctx.imageDigest,
        engine: new BarsEngine(dataset, hello),
        protocol: BARS_LOCKSTEP,
        harness: 'bars-replay/v1',
        ...secretsOf(ctx),
        ...endObserverOf(ctx),
      }),
    score: async (_ctx, log) => {
      const scored = scoreBarsActionLog(dataset, log, params);
      return { performance: { kind: 'bars-replay/v1', metrics: scored.metrics }, flags: [], trace: traceOfBarsRun(scored.run) };
    },
  };
}

// ---------------------------------------------------------------- clmm-replay/v1

export interface ClmmPlanInput {
  harness: ClmmReplayHarnessT;
  /** The phase's frozen pool window (dataset.ts readFrozenClmmDataset): the harness's pool's. */
  dataset: ClmmDataset;
  /** The phase seed: hello.seed, and the block bootstrap's seed. */
  seed: string;
  /** Final phase: the server time of the last graded receipt. Null on dev. */
  finalWindow: ClmmFinalWindow;
  /**
   * The phase graded, whose window is held to its floor (contracts/clmm-protocol.ts
   * clmmPhaseBlocksIssue): CLMM_RANKED_MIN_BLOCKS whole blocks on the ranked final phase,
   * CLMM_MIN_BLOCKS on dev. The grade job names it (grader/worker.ts). Absent, CLMM_MIN_BLOCKS
   * (clmmBlockHoursIssue): a kit's grade-local and regrade reproduce a run the server graded, on a
   * window its phase's floor already held.
   */
  phase?: ClmmPhaseKeyT;
  /**
   * What scores an action log (default sim/clmm/metrics.ts scoreClmmActionLog). Whatever it is, the
   * score it returns is held to LVR leg by leg before the plan returns it (assertClmmLvr), so a scorer
   * whose LVR is off is refused, never scored. A test hands in one with a fault planted in it.
   */
  scorer?: ClmmScorer;
}

/** A clmm scorer: sim/clmm/metrics.ts scoreClmmActionLog's shape (ClmmPlanInput.scorer). */
export type ClmmScorer = typeof scoreClmmActionLog;

/**
 * clmmPlan's refusal of a window under its phase's floor of whole blocks of the harness's
 * interval.block_hours (CLMM_RANKED_MIN_BLOCKS on the final phase, CLMM_MIN_BLOCKS on dev or with no
 * phase named): a SimDataError whose message is clmmPhaseBlocksIssue's (or clmmBlockHoursIssue's)
 * reason, apart so a caller can say the window is too short for its blocks rather than that it cannot
 * replay the pool.
 */
export class ClmmShortWindowError extends SimDataError {
  constructor(reason: string) {
    super(reason);
    this.name = 'ClmmShortWindowError';
  }
}

/**
 * The clmm-replay/v1 plan (see the header). Throws SimDataError when the dataset cannot replay the
 * harness: its window holds fewer whole blocks of the harness's interval.block_hours than its phase's
 * floor, CLMM_RANKED_MIN_BLOCKS on the ranked final phase and CLMM_MIN_BLOCKS on dev or with no phase
 * named (ClmmShortWindowError, carrying contracts/clmm-protocol.ts clmmPhaseBlocksIssue's reason,
 * which names the phase, the blocks and the floor: the block bootstrap says little over a handful of
 * blocks, and a prize is paid beside it), its pool is not the harness's (clmmPoolMismatch), or its bars
 * and rows disagree, or a price of it sells at 0 under the harness's slippage (the engine's own
 * checks, run here once so a window that can never replay is refused before any execution). Its score
 * throws sim/clmm/metrics.ts ClmmLvrMismatchError, never a score, when the scorer's LVR parts from LVR
 * leg by leg by more than rounding (assertClmmLvr).
 */
export function clmmPlan(input: ClmmPlanInput): HarnessPlan<ClmmActionLogT> {
  const h = input.harness;
  const { dataset } = input;
  const scorer = input.scorer ?? scoreClmmActionLog;
  const short = input.phase === undefined ? clmmBlockHoursIssue(h.interval, dataset.window.hours) : clmmPhaseBlocksIssue(h.interval, dataset.window.hours, input.phase);
  if (short !== null) throw new ClmmShortWindowError(short);
  const hello = makeClmmHello({ harness: h, dataset, seed: input.seed });
  // The engine's dataset checks, once: each execution builds its own engine from the same two.
  new ClmmEngine(dataset, hello);
  return {
    kind: 'clmm-replay/v1',
    datasetSha256: dataset.sha256,
    seed: input.seed,
    failKey: null,
    runtimes: h.runtimes,
    extraRuntimes: [],
    scorerVersion: scorerVersion(),
    houseDossier: null,
    houseCounts: null,
    houseCountsPlatform: null,
    houseCountsCounted: null,
    houseCountsPosts: false,
    parseLog: (json) => ClmmActionLog.parse(json),
    execute: (ctx) =>
      executeLockstep({
        sandbox: ctx.sandbox,
        runtime: ctx.runtime,
        botDir: ctx.botDir,
        limits: ctx.limits,
        label: ctx.label,
        imageDigest: ctx.imageDigest,
        engine: new ClmmEngine(dataset, hello),
        // sim/clmm/engine.ts's codec as it is: each parsed reply's actions also under `orders`, the key the driver counts against the cap.
        protocol: CLMM_LOCKSTEP,
        harness: 'clmm-replay/v1',
        ...secretsOf(ctx),
        ...endObserverOf(ctx),
      }),
    score: async (_ctx, log) => {
      const scored = scorer(dataset, log, h, input.finalWindow);
      // Every clmm score's LVR, the residual fees - costs - hedged PnL, against LVR leg by leg: a fault no retry mends, never the entry's.
      assertClmmLvr(scored, dataset);
      return { performance: { kind: 'clmm-replay/v1', metrics: scored.metrics }, flags: scored.flags, trace: traceOfClmmRun(scored.run) };
    },
  };
}

// ---------------------------------------------------------------- agent/v1

export interface AgentPlanInput {
  harness: AgentHarnessT;
  /** The phase seed (u64 decimal): the score's seed. */
  seed: string;
  /** The run's dataset_sha256: the digest of the instances its trials run on, as the caller's draw records it. */
  datasetSha256: string | null;
}

/**
 * The agent/v1 plan (see the header). No fail key: an agent run draws nothing. Its scorer_version is
 * the scoring source's plus ` program@<scorer_sha256>`, the sealed scorer directory's tree digest
 * (what programScorerDigest takes of a program/v1 scorer, and the loader has checked against the
 * files); the images its trials need besides the entry's are the scorer's and the env's.
 */
export function agentPlan(input: AgentPlanInput): HarnessPlan<AgentTrialsT> {
  const h = input.harness;
  const refuse = (what: string) => Promise.reject(new TypeError(`an agent/v1 run is not ${what}: grader/agent.ts runs its K trials and grader/agent-score.ts aggregateTrials scores them`));
  return {
    kind: 'agent/v1',
    datasetSha256: input.datasetSha256,
    seed: input.seed,
    failKey: null,
    runtimes: h.runtimes,
    extraRuntimes: [...new Set<Runtime>([h.scorer.runtime, h.env.runtime])],
    scorerVersion: scorerVersion(h.scorer_sha256),
    houseDossier: null,
    houseCounts: null,
    houseCountsPlatform: null,
    houseCountsCounted: null,
    houseCountsPosts: false,
    parseLog: (json) => AgentTrials.parse(json),
    execute: () => refuse('one execution'),
    score: () => refuse('scored from one action log'),
  };
}

// ---------------------------------------------------------------- scrape/v1

export interface ScrapePlanInput {
  harness: Pick<ScrapeHarnessT, 'runtimes' | 'scorer' | 'scorer_sha256'>;
  /** The run's seed (u64 decimal: grader/worker.ts phaseSeed over the heat record's digest): the score's seed. */
  seed: string;
  /** The run's dataset_sha256: the canonical sha256 of its heat record (contracts/scrape.ts ScrapeHeat). */
  datasetSha256: string | null;
}

/**
 * The scrape/v1 plan (see the header). No fail key: a heat draws its orders from a public drand round
 * (the heat record's), never a secret. Its scorer_version is the scoring source's plus
 * ` program@<scorer_sha256>`, the sealed scorer directory's tree digest, as agent/v1's; the image its
 * scoring runs in besides the entry's is the scorer's.
 */
export function scrapePlan(input: ScrapePlanInput): HarnessPlan<ScrapeTrialsT> {
  const h = input.harness;
  const refuse = (what: string) => Promise.reject(new TypeError(`a scrape/v1 run is not ${what}: grader/scrape/heat.ts runs its heat and grader/scrape/score.ts judges its trials`));
  return {
    kind: 'scrape/v1',
    datasetSha256: input.datasetSha256,
    seed: input.seed,
    failKey: null,
    runtimes: h.runtimes,
    extraRuntimes: [h.scorer.runtime],
    scorerVersion: scorerVersion(h.scorer_sha256),
    houseDossier: null,
    houseCounts: null,
    houseCountsPlatform: null,
    houseCountsCounted: null,
    houseCountsPosts: false,
    parseLog: (json) => ScrapeTrials.parse(json),
    execute: () => refuse('one execution'),
    score: () => refuse('scored from one action log'),
  };
}

// ---------------------------------------------------------------- patch/v1

/**
 * The runtime a patch/v1 run is planned and run on (the header's `patch/v1`). The entry is a diff, run in none of the
 * house's runtimes: the house runner runs it in the bounty's pinned image (patch/execute.ts, an image spec). A sandbox
 * still resolves the spec's runtime (the docker driver its pooled image, which the image spec then replaces), so the
 * run names the house's own.
 */
export const PATCH_RUNTIME: Runtime = 'node22';

/** The message a patch/v1 grade is refused with when the house cannot materialize a tree it grades on (grader/worker.ts patchPhaseSetup). */
export const NO_PATCH_TREES_MESSAGE = "a patch/v1 bundle grades only on its sealed base tree and its phase's tree";

/** What a patch/v1 phase grades on: the run's options (patch/execute.ts), for the phase it is. */
export interface PatchSetup extends PatchExecutionOptions {
  /** The competition's whole harness (a run reads its PatchRunHarness fields; the plan its kind, pack and image). */
  harness: PatchHarnessT;
  /** The phase whose pack tree is phaseTreeDir (pack.dev or pack.final): the run's dataset_sha256 is its tree_sha256. */
  phase: PatchPhaseT;
}

export interface PatchPlanInput {
  setup: PatchSetup;
  seed: string;
}

/**
 * The entry's patch.diff (PATCH_DIFF_FILE) at the root of its materialized snapshot, or null when the snapshot holds
 * none, or holds that name as anything but a regular file (a symlink or a directory: intake's `missing` too,
 * server/pipeline/snapshot.ts): executePatch refuses a null patch `missing`.
 */
export async function entryPatch(botDir: string): Promise<Buffer | null> {
  const path = join(botDir, PATCH_DIFF_FILE);
  try {
    if (!(await lstat(path)).isFile()) return null;
    return await readFile(path);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

/**
 * A patch/v1 run's plan (the header's `patch/v1`): its execute reads the entry's patch.diff (entryPatch) and runs it
 * on the setup's trees (patch/execute.ts executePatch), its record the run log and nothing else: a refusal's
 * detail, a report issue and the test log never leave it, so none reaches the performance, the stored log or an
 * API. Its score is scorePatch over the phase's lists (patch/score.ts), pure, run in no container. Its dataset is
 * the phase's tree, its one runtime PATCH_RUNTIME, and it scores in no image of its own (no extra runtime).
 */
export function patchPlan(input: PatchPlanInput): HarnessPlan<PatchRunLogT> {
  const { phase, ...options } = input.setup;
  return {
    kind: options.harness.kind,
    datasetSha256: options.harness.pack[phase].tree_sha256,
    seed: input.seed,
    failKey: null,
    runtimes: [PATCH_RUNTIME],
    extraRuntimes: [],
    scorerVersion: scorerVersion(),
    houseDossier: null,
    houseCounts: null,
    houseCountsPlatform: null,
    houseCountsCounted: null,
    houseCountsPosts: false,
    imageDigest: options.harness.image.digest,
    parseLog: (json) => PatchRunLog.parse(json),
    execute: async (ctx) => {
      const run = await executePatch(options, await entryPatch(ctx.botDir), { sandbox: ctx.sandbox, runtime: ctx.runtime, limits: ctx.limits, workDir: ctx.workDir, label: ctx.label });
      const { refusal_detail: _detail, report_issue: _issue, test_log: _testLog, test_exit: _testExit, ...execution } = run;
      return execution;
    },
    score: async (_ctx, log) => ({ performance: scorePatch(options.lists, log), flags: [] }),
  };
}

/**
 * The scorer_version a run records: the plan's, plus ` image@<digest>` of every image its scoring
 * runs in (program/v1's scorer container), so re-pinning the scorer image shows up in a regrade.
 */
export function scorerVersionOf(plan: Pick<HarnessPlan, 'scorerVersion' | 'extraRuntimes'>, sandbox: Pick<Sandbox, 'imageDigest'>): string {
  const images = plan.extraRuntimes.map((r) => sandbox.imageDigest(r)).filter((d): d is string => d !== null);
  return [plan.scorerVersion, ...images.map((d) => `image@${d}`)].join(' ');
}

/** The registry: each kind graded as one execution (PlanHarnessKindT) and how a plan is made for it. */
export const HARNESSES = {
  'pumpfun-replay/v2': replayPlan,
  'program/v1': programPlan,
  'bars-replay/v1': barsPlan,
  'clmm-replay/v1': clmmPlan,
  'patch/v1': patchPlan,
} as const satisfies Record<PlanHarnessKindT, (input: never) => HarnessPlan<unknown>>;
