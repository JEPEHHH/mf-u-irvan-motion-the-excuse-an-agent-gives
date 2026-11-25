// A program/v1 timing heat (contracts/competition.ts ProgramTiming; code-fastest, contracts/code-kinds.ts): the
// final phase's entries that passed the gate timed on CPU time net of a null entry's, the least trimmed mean first.
// runCodeHeat runs one and returns its record (agent-fun/code-heat/v3, stored as a blob), from which every entry's
// timing is rebuilt (codeHeatVerdicts), by the heat and by any regrade alike, as a scrape/v1 run's trials manifest is.
//
//   the field        each entrant's one kept entry (Force_Last) whose final grade passed the gate (performance.passed:
//                    the gate column 1 and the run ranked), the house's baselines among them, in receipt order
//                    (server/routes/admin/grading.ts codeHeatField). The heat runs after the final grades, as its
//                    own job: never inside a grade job, whose attempt expires long before a heat of a full field ends
//   the clock        CPU time, user and system, read host-side from cgroup v2: every timed container runs under one
//                    parent cgroup made for the heat (grader/sandbox/docker.ts openCpuClock), and a run's CPU time
//                    is the parent's usage_usec after it minus before it (a removed child's CPU stays folded into
//                    its parent). Measured on this machine's sandbox for #37 (Docker Desktop, cgroup v2, cgroupfs,
//                    runc; docker.ts's header has the probe): by container id the reading is gone the moment the
//                    container is, so it misses the tail; the parent's delta held 1 514 307 µs for a container whose
//                    own process.cpuUsage() said 1 508 564 µs. On the k8s driver (grader/sandbox/k8s.ts openCpuClock,
//                    its header's Timing) every timed pod runs its program under the house's CPU launcher, the child
//                    subreaper of all the program starts, which reaps every descendant and reports their
//                    getrusage(RUSAGE_CHILDREN), user and system; the clock is the sum of its pods' readings, so a
//                    run's CPU time is again the clock after it minus before it (under gVisor its Sentry's 10 ms-tick
//                    estimate, not the host's: k8s.ts's header says how it is counted). Either clock is a TimingSandbox's
//                    (openCpuClock). A run that reads 0 µs never ranks: the clock is not reading on that host
//                    (SandboxError), and the heat stops. A clock's tick is the CPU time its every reading is a whole
//                    number of (codeClockTickUs, from the record's cpu_source): gVisor's 10 ms (GVISOR_CLOCK_TICK_US) on
//                    a k8s clock under a RuntimeClass, the microsecond on docker's and on a k8s pod under none (runc:
//                    the host kernel's own accounting, k8s.ts's header); the statistics hold every interval to it
//   a run            one execution of the entry over the phase's cases from a fresh snapshot (grade.ts executeOnce:
//                    one fresh container per case under 'per-file'), with `--cpus 1` (CODE_HEAT_CPUS; on k8s a pod
//                    whose CPU limit and request are both one) and the
//                    competition's other limits, in the image its grade ran. Its outputs must be the graded ones:
//                    its action log (the outputs manifest, with each case's status) byte-equal to the graded run's
//                    (action_log_sha256), else the run is not `matched`, and one run not matched, warm-up or timed,
//                    leaves the entry unranked (score.ts TIMING_OUTPUTS_DIFFER): it is not the program that passed.
//                    Under a house dossier (harnesses.ts HarnessPlan.houseDossier; grade.ts's header `The house
//                    dossier`) the graded log is the one the grade made of execution 1's, the file at the dossier path
//                    the house's: so each timed run's log takes the same step (grade.ts houseDossierLogOf, from the
//                    entry's entry-link record, TimedEntry.entry_link) once its CPU reading is taken, outside the timed
//                    window, and that log's sha256 is the one compared and recorded; a run whose program wrote what it
//                    wrote when graded then matches. A dossier missing by the house's fault throws HouseDossierFault (the
//                    house's, the heat job tried again), never an unmatched run; an entry handed no record keeps its
//                    program's own log (houseDossierLogOf's local grade), as the grade would. Every other plan's run
//                    log is compared as it ran
//   the control      every round also runs the null entry once (CODE_HEAT_CONTROL_ID: server/proposals/packs.ts
//                    PACK_NULL_ENTRY in the competition's runtime, an empty output for each case, run as an entry
//                    is in the pinned image), through the same timer, at the place the seed draws for it among the
//                    round's entries. Its CPU time is what any run spends starting and ending its containers and
//                    interpreter: #135 measured a median 59 593 µs a case on this machine's docker, and on
//                    code-tests-01 the oracle's own CPU past it could not be told from zero. An entry's run
//                    counts net of the heat's pooled control (codeHeatPooledControlUs: the median of the control's
//                    main and playoff runs; the main standing, read before the playoff, the median of its main
//                    runs), its cpu_us minus that, below 0 when under it (codeHeatNetRuns: never clamped, #209: one
//                    pooled reading taken off every run is a constant shift, so the order and the ties below are
//                    the gross readings' exactly, where a clamp at 0 reordered 20 of 1241 simulated pairs with a run
//                    under the control, an entry whose own work is within the noise); the record keeps every reading
//                    as measured, the control's gross too, so the pooled control and every net run are re-derived
//                    from it. A timing over net runs can fall below 0, which a score never holds (contracts/score.ts
//                    ProgramTimingScore): the heat's timings are then all raised by the one amount the lowest
//                    trimmed mean falls short of 0 (codeHeatTimingsOf), so the lowest reads 0 and every difference,
//                    so the order and every tie, stays what the runs say; a median, which nothing weighs, is held at
//                    0. Gross, that fixed cost compresses every ratio (1.0 s against 0.5 s of work over 20 cases
//                    reads 1.30x) toward 1, and its noise widens every interval the order below weighs. Pooled,
//                    never each round's own (#171's simulation over #135's runs and the default timing): a round's
//                    control adds its own run-to-run
//                    noise to every run it nets, 1.3x to 1.9x the variance each timing's interval sees at 50 ms of
//                    work a run, while what two entries' rounds share cancels in their difference either way; the
//                    median takes the same fixed cost out of every run, and a 1.2x-faster later entry came first
//                    after the playoff in 75-80% of heats against 50-70% (69-73% against 49-70% under a ±5% drift of
//                    the fixed cost over the heat), identical entries kept in receipt order in about 95% or more, the
//                    order's own level. It does not follow a drift within the heat: #135's own trend carried over a
//                    whole heat (about ±9%) is where the two rules met. The control is the house's own program: a
//                    control run that does not end ok stops the heat (CodeHeatError), and its outputs are no graded
//                    run's (never matched). A run reading 0 µs stops the heat only when it is an entry's (the clock
//                    is not reading); a control's 0 is a reading like any other
//   the seed         codeHeatSeed(phase seed) = sha256(utf8(CODE_HEAT_FORMAT) || 0x00 || utf8(the phase seed, u64
//                    decimal)), and each round's order (codeHeatRoundOrder) grader/scrape/heat.ts scrapeHeatOrder
//                    of that seed, the stage and the round over the field and the control: a Fisher-Yates shuffle
//                    of their ids (sorted, the control's CODE_HEAT_CONTROL_ID, which no entry may take) drawn from a
//                    sha256 stream, so anyone re-derives every order from the record. order[0] runs first, one run
//                    at a time, so no two timed containers share the host
//   the stages       timing.warmup_rounds warm-up rounds (run and checked, never timed into anything), then
//                    timing.rounds main rounds, every entry and the control once a round; then the main standing
//                    (below, over the main rounds) names the finalists: the first codeHeatPlaces of the ranked
//                    entries, the paid places (server/competitions/load.ts lastPaidPlace) and playoff_extra_places
//                    more. With at least two of them and playoff_rounds above 0 they run playoff_rounds more
//                    interleaved rounds among themselves and the control; a finalist's timing covers its main and
//                    playoff rounds
//   the statistics   a ranked entry's timing (contracts/score.ts ProgramTimingScore) over its counted rounds' net
//                    CPU times, in whole microseconds, by grader/scrape/score.ts's arithmetic with every run a
//                    correct trial: trimmed_mean_cpu_us drops `trim` runs at each end and averages the rest
//                    half-even (contracts/scrape.ts scrapeTimeUs), median_cpu_us (scrapeMedianUs), and Yuen's 90%
//                    interval of the trimmed mean (scrapeIntervalUs: ± t(0.95, h - 1) √d, d the winsorized variance
//                    over h (h - 1), h = rounds - 2 trim). On a clock whose tick is coarser than the microsecond the
//                    interval is never narrower than one tick either side of the trimmed mean (codeHeatTimingsOf,
//                    #3113): such a clock counts a run's work in whole ticks, the same count every run when the work
//                    does not vary, so runs that agree to the tick show none of the up-to-a-tick error each reading
//                    carries, and a Yuen interval 0 wide would let a byte copy one tick under what it copied read as
//                    faster. A microsecond clock's intervals stand as Yuen's: its error is under the microsecond every
//                    figure is rounded to, and every docker heat's timings are what they were
//   the difference   codeTimingDifference: two weighable timings' trimmed means a - b ± t(0.95, ν) √(d_a + d_b),
//                    each d read back from its own published interval (d = (half-width / t(0.95, h - 1))², so the
//                    score alone decides it, on the board as in the heat, a tick clock's floor with it: two timings
//                    of one stage at the floor differ by ± √2 ticks, so one tick apart they tie and two ticks apart
//                    the lower is faster), ν = min(h_a, h_b) - 1: Hsu's
//                    conservative degrees of freedom, never past the t table's 60 (never z). Welch-Satterthwaite's ν
//                    with z past 60 (grader/scrape/score.ts scrapeDifference's) holds a 90% two-sided interval a
//                    shade under its level at a playoff's 39 rounds (about 94.7% of identical pairs kept the earlier
//                    receipt first in #37's simulation), and the order below promises at least 95%
//   the order        orderCodeTimings: finalists first (a finalist's timing is over more rounds: rounds above
//                    timing.rounds), then the trimmed mean ascending, an exact tie to the earlier receipt; then the
//                    adjacent-pair pass, until nothing moves (settleEarlierReceipts): an entry received earlier
//                    directly behind one received later, the two of one stage, whose difference interval holds 0
//                    moves ahead of it. Each move puts an earlier receipt before a later one, so the pass ends. A
//                    later entry passes an earlier one only when it is faster at 95% confidence, one-sided, over its
//                    repeated runs: a copy is never placed ahead of what it copied on noise, and otherwise the
//                    earlier receipt keeps the place. The rules say that, and no fixed ratio: how wide a gap the test
//                    tells apart follows each heat's own noise and rounds (#12 measured 5-13% run-to-run noise on
//                    one CPU, under which a 1.2x gap wins after a playoff: tests/unit/grader-code-heat.test.ts's
//                    noise). The board (server/routes/competitions/ranking.ts) orders a code-fastest phase the same
//                    way, from the scores: the main standing here is that order over the main rounds alone
//   the record       CodeHeatRecord: the phase seed and the heat's seed, the timing config, the finalist places,
//                    whether each round ran the control (controlled), where the CPU was read, the entries (id,
//                    receipt, graded action log) in receipt order, every run in the order it ran, the control's
//                    among them under CODE_HEAT_CONTROL_ID (stage, round, position, status, cpu_us as the clock read
//                    it, its action log's sha256, matched), and the finalists. codeHeatRecordIssues re-derives every
//                    order, every matched flag and the finalists (net of the main rounds' pooled control) from the
//                    rest; codeHeatVerdicts rebuilds each entry's verdict, net of the heat's pooled control, from a
//                    record that holds (a regrade reads the stored blob back: the measurement itself is never
//                    re-run). The pooled control is never stored: the controls' readings are, and anyone takes their
//                    median again. A v2 record (each run net of its round's control) is not read as one. A v3
//                    record made before #209 reads as it is (its readings were gross then too), its verdicts
//                    re-derived unclamped: the same wherever no counted run of it read under its pooled control,
//                    and its finalists hold unless a clamp moved its main standing. A record of
//                    no control (controlled false: runCodeHeatRounds handed no timeControl, a simulated clock's)
//                    counts every run gross; runCodeHeat always times the control
//   the resume       a heat keeps its runs as they are measured (runCodeHeat's progress: a CodeHeatPartial, its
//                    canonical JSON written whole after each run, the control's included, between timed runs, never
//                    inside one; on the grader, the process's `heat-partials` objects, codeHeatPartialObject: each
//                    write held in memory and pushed in the background at most every PARTIAL_PUSH_MS (longer when
//                    a push is slow: PARTIAL_PUSH_DUTY), and at the heat's end, abort or drain, so an attempt cut
//                    off without its flush re-times at most one window's runs), so an
//                    attempt that dies or expires partway loses none of them (an expiry, the job
//                    attempt's signal, kills the run under way, which is never measured or kept, and starts no
//                    other: CodeTimerOptions.signal): the next attempt takes the kept runs as they stand (a kept
//                    control is never timed again either), times only the rest, and makes the record an
//                    uninterrupted heat makes of the same measurements. Kept runs are
//                    resumed only under the same key (codeHeatResumeKey: the kept runs' format, the phase seed, the
//                    timing, the finalist places, the field with each entry's graded action log, the control's
//                    program, and the caller's plan: codeHeatMeasuredUnder, what grader/worker.ts names: the phase, its
//                    bundle as stored, its data, the runtime and its image, and each entry's snapshot, image and
//                    secrets), only as a prefix of the heat's runs in the orders the seed draws (codeHeatKeptIssue),
//                    and only on a clock of the same kind (codeHeatClockKind: the source but its parent, `cgroup-v2
//                    <driver> <runtime>`, or but its id, `rusage-children k8s <runtime class>`, so a docker heat never
//                    resumes on k8s); anything else discards them, and the heat starts over. The key names what a run
//                    measures, never the grader that measured it: no harness_version and no bundle as this release's
//                    schema reads it (a release that adds a defaulted key moves neither the stored bundle nor a run),
//                    so a heat cut by a deploy resumes on any grader pod of any later release that reads the same
//                    store (grader/worker.ts keeps it in the judge state's `heat-partials`, the claim's work root or the tier's over it). A
//                    change to how a timed run is read that moves no input above bumps CODE_HEAT_PARTIAL_FORMAT, so
//                    every run kept before it is discarded. The record's cpu_source is the clock its first run was
//                    read on; a later attempt's clock is named in the kept runs' cpu_sources and the job's log. A heat
//                    that records drops them (its caller, once the record's verdicts are written)
//   progress         each round an attempt timed a run of ends with a line (codeHeatProgressLine, through
//                    runCodeHeat's log): the rounds and runs done of the most the heat makes (codeHeatRunsPlanned,
//                    exact once the finalists are named), how many of them an earlier attempt kept, this attempt's
//                    runs a minute and when the heat ends at that pace
//   the dev phase    no heat: runProvisionalTiming times a passing entry CODE_TIMING_DEV_ROUNDS times, each run
//                    followed by one of the control, its provisional timing (provisionalCodeTiming) over the runs
//                    net of the median of the control's three, pooled as a heat's, each 0 when under it
//                    (codeRunNetUs: with no field timed beside it there is nothing to raise it by, and a figure is
//                    never below 0): their median as its trimmed mean, its interval their range (no Yuen interval at
//                    three runs): shown on the board, never weighed. It stops as a heat does once its grade job's
//                    signal aborts: the run under way killed, no other started, no verdict
//
// Faults: a clock that cannot read, a sandbox that fails, a control that does not run, a record out of shape are the
// house's (SandboxError, CodeHeatError), never the entry's: the heat job is retried. An entry's own failure in a run
// (a crash, a timeout, other outputs) is its own: that run is not matched.

import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProgramTiming, PROGRAM_TIMING_MIN_ROUNDS, type PrizeT, type ProgramTimingT } from '../contracts/competition.ts';
import { IsoDateTime, Sha256Hex, U64 } from '../contracts/primitives.ts';
import { ProgramTimingScore, type ProgramTimingScoreT } from '../contracts/score.ts';
import { SCRAPE_HEAT_STAGES, ScrapeEntryId, scrapeMedianUs } from '../contracts/scrape.ts';
import type { ObjectNamespace, ObjectStore } from '../server/blob-tier/object-store.ts';
import { BlobStore } from '../server/blobstore.ts';
import { lastPaidPlace } from '../server/competitions/load.ts';
import { SNAPSHOT_FORMAT, type SnapshotIndex } from '../server/repos/index-tar.ts';
import { canonicalJson, canonicalSha256, compareCodeUnits, sha256Hex } from '../sim/canonical.ts';
import { executeOnce, houseDossierLine, houseDossierLogOf, preflight, releaseScratch, type EntryFacts, type SnapshotSource } from './grade.ts';
import type { HarnessPlan } from './harnesses.ts';
import type { OutputBlobs } from './program.ts';
import type { Execution, LimitsT } from './run.ts';
import type { CpuClock } from './sandbox/docker.ts';
import { ENTRY_SCRIPTS, SandboxError, type Runtime, type Sandbox } from './sandbox/types.ts';
import { scrapeHeatOrder } from './scrape/heat.ts';
import { SCRAPE_T_MAX_DF, SCRAPE_T90_MICRO, scrapeIntervalUs, scrapeT90Micro, sqrtHalfEven } from './scrape/score.ts';
import { CODE_TIMING_DEV_ROUNDS, TIMING_OUTPUTS_DIFFER, type TimingVerdictT } from './score.ts';

export { CODE_TIMING_DEV_ROUNDS, TIMING_OUTPUTS_DIFFER, type TimingVerdictT };

// ---------------------------------------------------------------- constants

/**
 * The heat record's format, and the seed's domain. v2: each round runs the control, and each run counts net of its
 * round's; v3 (#171): the runs count net of the heat's pooled control, the median of the control's counted runs, so a
 * v2 record's timings are not a v3 one's, and it is not read as one.
 */
export const CODE_HEAT_FORMAT = 'agent-fun/code-heat/v3';
/**
 * The control's id (the header's control): its place in a round's order, and the `entry` of its runs in the record.
 * An entry id as grader/scrape/heat.ts takes one, and never an entry of the field (an entry's id is its submission's
 * UUID; a field naming this one is refused).
 */
export const CODE_HEAT_CONTROL_ID = 'null-entry';
/** The CPUs every timed container gets: one, so a program's CPU time is its work, never another core's (a timed k8s pod's limit and request). */
export const CODE_HEAT_CPUS = 1;
/** How a run ended (grader/run.ts ExecutionStatus). */
export const CODE_RUN_STATUSES = ['ok', 'failed', 'timeout'] as const;
export type CodeRunStatusT = (typeof CODE_RUN_STATUSES)[number];
/** The heat's stages, a scrape/v1 heat's (contracts/scrape.ts SCRAPE_HEAT_STAGES), in the order they run. */
export const CODE_HEAT_STAGES = SCRAPE_HEAT_STAGES;
export type CodeHeatStageT = (typeof CODE_HEAT_STAGES)[number];

const MICRO_SQUARED = 1_000_000_000_000n;

/** The heat cannot go on, or a record does not hold: the house's fault, never an entry's. */
export class CodeHeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeHeatError';
  }
}

// ---------------------------------------------------------------- the seed and the orders

/** The heat's seed (the header): sha256(utf8(CODE_HEAT_FORMAT) || 0x00 || utf8(phase seed)), lowercase hex. */
export function codeHeatSeed(phaseSeed: string): string {
  if (!U64.safeParse(phaseSeed).success) throw new RangeError(`the phase seed ${JSON.stringify(phaseSeed)} is not a u64 decimal`);
  return createHash('sha256').update(CODE_HEAT_FORMAT, 'utf8').update(Buffer.from([0])).update(phaseSeed, 'utf8').digest('hex');
}

/** One round's order of `field` (the header): grader/scrape/heat.ts scrapeHeatOrder of the heat's seed. order[0] runs first. */
export function codeHeatOrder(seed: string, stage: CodeHeatStageT, round: number, field: readonly string[]): string[] {
  return scrapeHeatOrder(seed, stage, round, field);
}

/**
 * One round's order as the heat runs it (the header's seed and control): codeHeatOrder over the field and, in a
 * controlled heat, CODE_HEAT_CONTROL_ID, the control's place where that id falls. order[0] runs first.
 */
export function codeHeatRoundOrder(seed: string, stage: CodeHeatStageT, round: number, field: readonly string[], controlled: boolean): string[] {
  return codeHeatOrder(seed, stage, round, controlled ? [...field, CODE_HEAT_CONTROL_ID] : field);
}

/**
 * A run's CPU time net of a control reading as a figure shows it (the header's control): its cpu_us less `controlUs`,
 * 0 when it is under it; its cpu_us as read when there is no control (`controlUs` null). The dev phase's provisional
 * timing counts its runs so (its median control run); a heat's order never does: codeHeatNetRuns keeps the difference
 * below 0, since a clamp reorders.
 */
export function codeRunNetUs(cpuUs: number, controlUs: number | null): number {
  if (!Number.isSafeInteger(cpuUs) || cpuUs < 0) throw new RangeError(`${cpuUs} µs: CPU time is whole microseconds`);
  if (controlUs === null) return cpuUs;
  if (!Number.isSafeInteger(controlUs) || controlUs < 0) throw new RangeError(`${controlUs} µs: the control's CPU time is whole microseconds`);
  return Math.max(0, cpuUs - controlUs);
}

/** How many entries the playoff takes (the header's stages): the paid places and timing.playoff_extra_places more. */
export function codeHeatPlaces(prizes: readonly Pick<PrizeT, 'kind' | 'place' | 'amount_usd'>[], timing: Pick<ProgramTimingT, 'playoff_extra_places'>): number {
  return lastPaidPlace(prizes) + timing.playoff_extra_places;
}

// ---------------------------------------------------------------- the statistics

/** CPU times as grader/scrape/score.ts reads trials: every run a correct one. */
function asTrials(cpuUs: readonly number[]): { status: 'correct'; wall_us: number }[] {
  return cpuUs.map((us) => {
    if (!Number.isSafeInteger(us) || us < 0) throw new RangeError(`${us} µs: CPU time is whole microseconds`);
    return { status: 'correct' as const, wall_us: us };
  });
}

/**
 * A ranked entry's timing over its counted runs' CPU times (the header's statistics): the trimmed mean, the median and
 * Yuen's 90% interval, whole microseconds. A RangeError when the trim leaves fewer than two runs.
 */
export function codeTimingOf(cpuUs: readonly number[], trim: number): ProgramTimingScoreT {
  if (!Number.isSafeInteger(trim) || trim < 0) throw new RangeError(`trim ${trim}: a whole number of runs`);
  const trials = asTrials(cpuUs);
  const interval = scrapeIntervalUs(trials, trim);
  if (interval === null) throw new RangeError(`${cpuUs.length} runs with trim ${trim} leave no trimmed mean`);
  return ProgramTimingScore.parse({
    median_cpu_us: Number(scrapeMedianUs(trials)!),
    trimmed_mean_cpu_us: Number(interval.centre_us),
    rounds: cpuUs.length,
    interval_low_us: Number(interval.low_us),
    interval_high_us: Number(interval.high_us),
  });
}

/**
 * A timing's figures over net CPU times that may fall below 0 (codeHeatNetRuns): what codeTimingOf gives for them, its
 * every figure below 0 where the runs are, so no score holds it as it is (codeHeatTimingsOf makes one). Exact: the runs
 * are lifted to 0 or more by an even number of microseconds and the figures lowered by it again, and an even shift
 * moves every half-even rounding of a mean and of a median's two middle runs by just that, as it moves a winsorized
 * sample's spread not at all. A RangeError for a time that is no whole number of microseconds, or a trim that leaves
 * fewer than two runs.
 */
export function codeNetTimingOf(netUs: readonly number[], trim: number): ProgramTimingScoreT {
  for (const us of netUs) if (!Number.isSafeInteger(us)) throw new RangeError(`${us} µs: a net CPU time is whole microseconds`);
  const lowest = netUs.reduce((m, us) => Math.min(m, us), 0);
  const lift = lowest % 2 === 0 ? -lowest : 1 - lowest;
  const t = codeTimingOf(lift === 0 ? netUs : netUs.map((us) => us + lift), trim);
  return {
    median_cpu_us: t.median_cpu_us - lift,
    trimmed_mean_cpu_us: t.trimmed_mean_cpu_us - lift,
    rounds: t.rounds,
    interval_low_us: t.interval_low_us - lift,
    interval_high_us: t.interval_high_us - lift,
  };
}

/**
 * gVisor's clock tick (linux.ClockTick), µs: its Sentry credits a whole tick of CPU to each task it finds running at every
 * tick, so every reading of a k8s clock under a RuntimeClass is a whole number of them (grader/sandbox/k8s.ts's header,
 * What gVisor reports).
 */
export const GVISOR_CLOCK_TICK_US = 10_000;

/** A k8s clock's source up to its runtime class (grader/sandbox/k8s.ts K8S_CPU_CLOCK_SOURCE): `rusage-children k8s <runtime class|default> cpu-<12 hex>`. */
const K8S_CLOCK_SOURCE = 'rusage-children k8s';

/**
 * The tick of the clock `source` names (a record's cpu_source; the header's clock), whole µs: what each of its readings is
 * a whole number of. GVISOR_CLOCK_TICK_US on a k8s clock under a RuntimeClass (`rusage-children k8s <runtime class> …`:
 * the cluster's RuntimeClasses are gVisor's, deploy/k8s/cluster); 1 on every other, which reads to the microsecond:
 * docker's (`cgroup-v2 …`, the timing parent's usage_usec), a k8s pod's under no RuntimeClass (`rusage-children k8s
 * default …`, the host kernel's own accounting) and a simulated clock's. Read from the source's words, so a clock of
 * one kind (codeHeatClockKind) has one tick.
 */
export function codeClockTickUs(source: string): number {
  const [clock, driver, runtimeClass] = source.split(' ');
  return `${clock} ${driver}` === K8S_CLOCK_SOURCE && runtimeClass !== undefined && runtimeClass !== 'default' ? GVISOR_CLOCK_TICK_US : 1;
}

/**
 * Each entry's timing over its counted runs' net CPU times (the header's control: codeHeatNetRuns, each run less the
 * pooled control, below 0 when under it), as a score holds it: codeNetTimingOf of each, then every figure of every one
 * raised by the one amount the lowest trimmed mean falls below 0 (none when none does), so no trimmed mean or interval
 * centre reads below 0; a median still below 0, which nothing weighs, reads 0. Read on a clock whose tick (`tickUs`,
 * codeClockTickUs of the record's cpu_source; default the microsecond) is coarser than the microsecond, an interval
 * narrower than one tick either side of its trimmed mean is widened to that (the header's statistics), so a difference
 * read back from two of them (codeTimingDifference) never tells a gap of one tick from none; a microsecond clock's
 * intervals stand as Yuen's. The differences of the trimmed means, and every interval's width at or past the tick, are the unclamped
 * runs' exactly, so the order and the ties (orderCodeTimings, codeTimingDifference) are those of the runs as measured,
 * net or gross alike. In `netUs`'s order. A RangeError for a tick that is no whole number of microseconds.
 */
export function codeHeatTimingsOf(netUs: ReadonlyMap<string, readonly number[]>, trim: number, tickUs = 1): Map<string, ProgramTimingScoreT> {
  if (!Number.isSafeInteger(tickUs) || tickUs < 1) throw new RangeError(`a clock tick of ${tickUs} µs: a whole number of microseconds, at least 1`);
  const figures = new Map([...netUs].map(([id, us]) => [id, codeNetTimingOf(us, trim)] as const));
  const raise = [...figures.values()].reduce((m, t) => Math.max(m, -t.trimmed_mean_cpu_us), 0);
  const out = new Map<string, ProgramTimingScoreT>();
  for (const [id, t] of figures) {
    const widen = tickUs > 1 && t.interval_high_us - t.trimmed_mean_cpu_us < tickUs;
    out.set(
      id,
      ProgramTimingScore.parse({
        median_cpu_us: Math.max(0, t.median_cpu_us + raise),
        trimmed_mean_cpu_us: t.trimmed_mean_cpu_us + raise,
        rounds: t.rounds,
        interval_low_us: (widen ? t.trimmed_mean_cpu_us - tickUs : t.interval_low_us) + raise,
        interval_high_us: (widen ? t.trimmed_mean_cpu_us + tickUs : t.interval_high_us) + raise,
      }),
    );
  }
  return out;
}

/**
 * The dev phase's provisional timing (the header's dev phase) over CODE_TIMING_DEV_ROUNDS runs: their median as both
 * the median and the trimmed mean (each end trimmed but the middle run), the interval their range (fastest to slowest).
 */
export function provisionalCodeTiming(cpuUs: readonly number[]): ProgramTimingScoreT {
  if (cpuUs.length !== CODE_TIMING_DEV_ROUNDS) throw new RangeError(`a provisional timing is over ${CODE_TIMING_DEV_ROUNDS} runs, not ${cpuUs.length}`);
  const trials = asTrials(cpuUs);
  const median = Number(scrapeMedianUs(trials)!);
  return ProgramTimingScore.parse({
    median_cpu_us: median,
    trimmed_mean_cpu_us: median,
    rounds: cpuUs.length,
    interval_low_us: Math.min(...cpuUs),
    interval_high_us: Math.max(...cpuUs),
  });
}

/** Whether a timing is the dev phase's provisional one: fewer runs than any heat times (PROGRAM_TIMING_MIN_ROUNDS). */
export function codeTimingProvisional(t: Pick<ProgramTimingScoreT, 'rounds'>): boolean {
  return t.rounds < PROGRAM_TIMING_MIN_ROUNDS;
}

/** A heat's timing as the difference reads it back (the header's difference): its centre, h, and d = p / q µs². */
interface PublishedYuen {
  centre: bigint;
  h: number;
  p: bigint;
  q: bigint;
}

/**
 * A timing's Yuen variance read back from its published interval, or null when it is not weighable: a provisional
 * timing, one that keeps fewer than two runs past `trim`, or one whose interval is not centred on its trimmed mean.
 */
function publishedYuen(t: ProgramTimingScoreT, trim: number): PublishedYuen | null {
  if (codeTimingProvisional(t)) return null;
  const h = t.rounds - 2 * trim;
  if (h < 2) return null;
  const centre = BigInt(t.trimmed_mean_cpu_us);
  const half = BigInt(t.interval_high_us) - centre;
  if (centre - BigInt(t.interval_low_us) !== half || half < 0n) return null;
  const tq = scrapeT90Micro(h - 1);
  // half = round(t √d), t = tq / 10^6, so d = half² 10^12 / tq².
  return { centre, h, p: half * half * MICRO_SQUARED, q: tq * tq };
}

/** Whether two timings can be weighed against each other under `trim` (codeTimingDifference): each a heat's, keeping two runs or more. */
export function codeTimingWeighable(t: ProgramTimingScoreT, trim: number): boolean {
  return publishedYuen(t, trim) !== null;
}

/** Two timings' difference interval (codeTimingDifference): a - b, whole microseconds. */
export interface CodeTimingDifferenceT {
  /** trimmed mean of a minus trimmed mean of b: below 0 when a is the faster. */
  diff_us: bigint;
  half_us: bigint;
  low_us: bigint;
  high_us: bigint;
  /** The degrees of freedom t was taken at (min(h_a, h_b) - 1, at most the table's 60); null when both intervals are 0 wide. */
  df: number | null;
  /** The interval holds 0: neither is faster at 90% two-sided. */
  tie: boolean;
  /** The interval lies wholly below 0: a is faster than b at 95% one-sided. */
  faster: boolean;
}

/**
 * The difference interval of a's trimmed mean minus b's (the header's difference): (tm_a - tm_b) ± t(0.95, ν) √(d_a + d_b),
 * each d from its own published interval, ν = min(h_a, h_b) - 1 capped at SCRAPE_T_MAX_DF, the half-width half-even to
 * the microsecond (grader/scrape/score.ts sqrtHalfEven). Null when either is not weighable (codeTimingWeighable).
 */
export function codeTimingDifference(a: ProgramTimingScoreT, b: ProgramTimingScoreT, trim: number): CodeTimingDifferenceT | null {
  const ya = publishedYuen(a, trim);
  const yb = publishedYuen(b, trim);
  if (ya === null || yb === null) return null;
  // d_a + d_b = (p_a q_b + p_b q_a) / (q_a q_b).
  const sumNum = ya.p * yb.q + yb.p * ya.q;
  let df: number | null = null;
  let half = 0n;
  if (sumNum > 0n) {
    df = Math.min(Math.min(ya.h, yb.h) - 1, SCRAPE_T_MAX_DF);
    const t = SCRAPE_T90_MICRO[df]!;
    half = sqrtHalfEven(t * t * sumNum, MICRO_SQUARED * ya.q * yb.q);
  }
  const diff = ya.centre - yb.centre;
  const low = diff - half;
  const high = diff + half;
  return { diff_us: diff, half_us: half, low_us: low, high_us: high, df, tie: low <= 0n && 0n <= high, faster: high < 0n };
}

/** Whether two timings are a statistical tie under `trim`: both weighable and their difference interval holds 0. */
export function codeTimingTie(a: ProgramTimingScoreT | null, b: ProgramTimingScoreT | null, trim: number): boolean {
  if (a === null || b === null) return false;
  return codeTimingDifference(a, b, trim)?.tie ?? false;
}

// ---------------------------------------------------------------- the order

/**
 * The adjacent-pair pass (the header's order), until nothing moves: wherever `earlier(b, a)` holds for b directly behind
 * a and `tie(a, b)` does, b moves ahead of a. Each move lessens by one the pairs whose later receipt stands first, so it
 * ends. A new array; `order` is left as it was.
 */
export function settleEarlierReceipts<T>(order: readonly T[], earlier: (a: T, b: T) => boolean, tie: (a: T, b: T) => boolean): T[] {
  const out = [...order];
  for (let moved = true; moved; ) {
    moved = false;
    for (let k = 0; k + 1 < out.length; k++) {
      const a = out[k]!;
      const b = out[k + 1]!;
      if (earlier(b, a) && tie(a, b)) {
        out[k] = b;
        out[k + 1] = a;
        moved = true;
      }
    }
  }
  return out;
}

/** An entry as the order reads it: its id, its receipt (ISO-8601) and its timing (null when it has none to rank by). */
export interface CodeTimingRow {
  id: string;
  received_at: string;
  timing: ProgramTimingScoreT | null;
}

/** The earlier receipt first (received_at, then the id, in code units). */
export function compareReceipts(a: Pick<CodeTimingRow, 'id' | 'received_at'>, b: Pick<CodeTimingRow, 'id' | 'received_at'>): number {
  return compareCodeUnits(a.received_at, b.received_at) || compareCodeUnits(a.id, b.id);
}

/** Whether a timing is a finalist's under `timing`: over more rounds than the main stage's. */
export function codeTimingFinalist(t: Pick<ProgramTimingScoreT, 'rounds'>, timing: Pick<ProgramTimingT, 'rounds'>): boolean {
  return t.rounds > timing.rounds;
}

/**
 * The code-fastest order (the header's order) of the rows with a timing; the rest after them in receipt order:
 * finalists first, the trimmed mean ascending, the earlier receipt on an exact tie, then settleEarlierReceipts over
 * pairs of one stage that tie (codeTimingTie).
 */
export function orderCodeTimings<R extends CodeTimingRow>(rows: readonly R[], timing: Pick<ProgramTimingT, 'rounds' | 'trim'>): R[] {
  const stage = (r: R) => (r.timing !== null && codeTimingFinalist(r.timing, timing) ? 0 : 1);
  const timed = rows
    .filter((r) => r.timing !== null)
    .sort((a, b) => stage(a) - stage(b) || a.timing!.trimmed_mean_cpu_us - b.timing!.trimmed_mean_cpu_us || compareReceipts(a, b));
  const settled = settleEarlierReceipts(
    timed,
    (a, b) => compareReceipts(a, b) < 0,
    (a, b) => stage(a) === stage(b) && codeTimingTie(a.timing, b.timing, timing.trim),
  );
  return [...settled, ...rows.filter((r) => r.timing === null).sort(compareReceipts)];
}

// ---------------------------------------------------------------- the record

const CpuSource = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/, 'printable ASCII words');

/** One run of the heat, in the order it ran: an entry's, or its round's control's (entry CODE_HEAT_CONTROL_ID). */
export const CodeHeatRun = z
  .strictObject({
    stage: z.enum(CODE_HEAT_STAGES),
    round: z.int().min(0),
    /** Its place in its round's order (codeHeatRoundOrder): 0 ran first. */
    position: z.int().min(0),
    /** The entry it ran, or CODE_HEAT_CONTROL_ID: the round's control. */
    entry: ScrapeEntryId,
    status: z.enum(CODE_RUN_STATUSES),
    /**
     * The clock's reading after the run minus before it, gross: every CPU microsecond its containers spent (docker: the
     * timing parent's usage_usec; k8s: its pods' CPU launcher readings).
     * At least 1 for an entry's run (one read at 0 is a clock not reading); 0 or more for a control's. What a timing
     * counts is an entry's net of the heat's pooled control (codeHeatNetRuns), re-derived from the controls' readings.
     */
    cpu_us: z.int().min(0),
    /** sha256 of its action log (the outputs manifest); null unless it ran ok. */
    log_sha256: Sha256Hex.nullable(),
    /** Its action log is the graded run's: status ok and log_sha256 the entry's action_log_sha256. Never a control's. */
    matched: z.boolean(),
  })
  .refine((r) => (r.status === 'ok') === (r.log_sha256 !== null), { message: 'a run has an action log exactly when it ran ok', path: ['log_sha256'] })
  .refine((r) => r.entry === CODE_HEAT_CONTROL_ID || r.cpu_us >= 1, { message: "an entry's run spends CPU: at least 1 µs (a run read at 0 is a clock not reading)", path: ['cpu_us'] })
  .refine((r) => r.entry !== CODE_HEAT_CONTROL_ID || (r.status === 'ok' && !r.matched), { message: 'a control ran ok and matches no graded run (one that did not run stops the heat)', path: ['status'] });
export type CodeHeatRunT = z.infer<typeof CodeHeatRun>;

/** One entry of the field: its id (never the control's), its receipt and the action log its final grade recorded. */
export const CodeHeatFieldEntry = z.strictObject({
  entry: ScrapeEntryId.refine((id) => id !== CODE_HEAT_CONTROL_ID, { message: `${CODE_HEAT_CONTROL_ID} is the control's id, never an entry's` }),
  received_at: IsoDateTime,
  action_log_sha256: Sha256Hex,
});
export type CodeHeatEntryT = z.infer<typeof CodeHeatFieldEntry>;

/** The heat record (the header's record): canonical JSON, stored as a blob named by its sha256. */
export const CodeHeatRecord = z.strictObject({
  format: z.literal(CODE_HEAT_FORMAT),
  phase_seed: U64,
  /** codeHeatSeed(phase_seed). */
  seed: Sha256Hex,
  /** The harness's timing heat, every number named. */
  timing: ProgramTiming,
  /** codeHeatPlaces: the first this many ranked entries of the main standing are the finalists. */
  finalist_places: z.int().min(0),
  /**
   * Every round ran the control (the header's control), at its drawn place, and each entry's run counts net of the
   * heat's pooled control (the median of the control's main and playoff runs: codeHeatPooledControlUs); false: no round
   * did (a simulated clock's heat), and every run counts as read.
   */
  controlled: z.boolean(),
  /**
   * Where the CPU time was read (grader/sandbox/docker.ts CpuClock.source): the clock the heat's first run was read on
   * (a resumed heat's later attempts read on clocks of its kind on the same host: the header's resume). Its tick
   * (codeClockTickUs), when coarser than the microsecond, is the least half-width of every timing's interval
   * (codeHeatTimingsOf), the main standing's that names the finalists too.
   */
  cpu_source: CpuSource,
  /** The field, in receipt order. */
  entries: z.array(CodeHeatFieldEntry),
  runs: z.array(CodeHeatRun),
  /** The finalists, in main-standing order; empty when no playoff ran. */
  finalists: z.array(ScrapeEntryId),
});
export type CodeHeatRecordT = z.infer<typeof CodeHeatRecord>;

/** The record's canonical JSON and its sha256: the blob it is stored as. */
export function codeHeatRecordDigest(record: CodeHeatRecordT): { json: string; sha256: string } {
  const json = canonicalJson(CodeHeatRecord.parse(record));
  return { json, sha256: sha256Hex(json) };
}

/**
 * The pooled control of `runs` (the header's control): the median (scrapeMedianUs: the two middle ones' mean, half-even,
 * on an even count) of the cpu_us of the control's runs among them that count, every stage's but the warm-up's; null
 * when none does. Over a record's runs, the heat's pooled control; over its warm-up and main runs, the main standing's.
 */
export function codeHeatPooledControlUs(runs: readonly CodeHeatRunT[]): number | null {
  const counted = runs.filter((r) => r.entry === CODE_HEAT_CONTROL_ID && r.stage !== 'warmup');
  if (counted.length === 0) return null;
  return Number(scrapeMedianUs(asTrials(counted.map((r) => r.cpu_us)))!);
}

/**
 * The CPU time each of `runs` counts at (the header's control), in their order: an entry's run less the pooled control
 * of `runs` (codeHeatPooledControlUs), below 0 when under it (never clamped: a clamp would reorder), as read in a heat of
 * no control; a control's own as read. CodeHeatError when `runs` hold a controlled heat's entry run and no control run
 * that counts.
 */
export function codeHeatNetRuns(runs: readonly CodeHeatRunT[], controlled: boolean): number[] {
  const pooled = controlled ? codeHeatPooledControlUs(runs) : null;
  return runs.map((r) => {
    if (r.entry === CODE_HEAT_CONTROL_ID || !controlled) return r.cpu_us;
    if (pooled === null) throw new CodeHeatError(`${r.entry}'s ${r.stage} round ${r.round} run counts net of the heat's pooled control, and no main or playoff round among the runs ran the control`);
    return r.cpu_us - pooled;
  });
}

/**
 * Each entry's verdict over the runs given (no order checks: codeHeatRecordIssues makes those): TIMING_OUTPUTS_DIFFER
 * when a run of it is not matched, else its timing over its main and playoff runs, each net of the pooled control of
 * the runs given in a controlled heat (codeHeatNetRuns), the timings made together on the clock's tick `tickUs`
 * (codeHeatTimingsOf).
 */
function verdictsOf(entries: readonly CodeHeatEntryT[], runs: readonly CodeHeatRunT[], trim: number, controlled: boolean, tickUs: number): Map<string, TimingVerdictT> {
  const out = new Map<string, TimingVerdictT>();
  const counted = new Map<string, number[]>();
  const net = codeHeatNetRuns(runs, controlled);
  for (const e of entries) {
    const own = runs.map((r, i) => ({ r, us: net[i]! })).filter(({ r }) => r.entry === e.entry);
    if (own.some(({ r }) => !r.matched)) {
      out.set(e.entry, TIMING_OUTPUTS_DIFFER);
      continue;
    }
    const us = own.filter(({ r }) => r.stage !== 'warmup').map(({ us }) => us);
    if (us.length > 0) counted.set(e.entry, us);
  }
  for (const [id, t] of codeHeatTimingsOf(counted, trim, tickUs)) out.set(id, t);
  // The field's order, as before: an entry unranked and one timed, each where it stands.
  return new Map(entries.flatMap((e) => (out.has(e.entry) ? [[e.entry, out.get(e.entry)!] as const] : [])));
}

/**
 * The finalists the main rounds name (the header's stages): the main standing, orderCodeTimings over each entry's main
 * rounds (net of the main rounds' pooled control: the playoff's has not run; each interval held to the clock's tick
 * `tickUs`), its first `places` entries with a timing; none when fewer than two, or when the playoff runs no rounds.
 */
function finalistsOf(entries: readonly CodeHeatEntryT[], runs: readonly CodeHeatRunT[], timing: ProgramTimingT, places: number, controlled: boolean, tickUs: number): string[] {
  if (timing.playoff_rounds === 0 || places < 2) return [];
  const verdicts = verdictsOf(entries, runs.filter((r) => r.stage !== 'playoff'), timing.trim, controlled, tickUs);
  const rows = entries.map((e): CodeTimingRow => {
    const v = verdicts.get(e.entry);
    return { id: e.entry, received_at: e.received_at, timing: v === undefined || v === TIMING_OUTPUTS_DIFFER ? null : v };
  });
  const ranked = orderCodeTimings(rows, timing).filter((r) => r.timing !== null);
  const finalists = ranked.slice(0, places).map((r) => r.id);
  return finalists.length >= 2 ? finalists : [];
}

/** The rounds each stage runs, and over which field. */
function stagePlan(record: Pick<CodeHeatRecordT, 'timing' | 'entries' | 'finalists'>): { stage: CodeHeatStageT; rounds: number; field: string[] }[] {
  const all = record.entries.map((e) => e.entry);
  return [
    { stage: 'warmup', rounds: all.length === 0 ? 0 : record.timing.warmup_rounds, field: all },
    { stage: 'main', rounds: all.length === 0 ? 0 : record.timing.rounds, field: all },
    { stage: 'playoff', rounds: record.finalists.length === 0 ? 0 : record.timing.playoff_rounds, field: [...record.finalists] },
  ];
}

/**
 * What does not hold in a record (none when it holds): the seed, the field's receipt order, every round's order and
 * positions re-derived from the seed (the control's place among them in a controlled heat, none in another), each
 * run's matched flag from its status and action log, and the finalists from the main rounds. Each issue names where.
 */
export function codeHeatRecordIssues(raw: CodeHeatRecordT): string[] {
  const parsed = CodeHeatRecord.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.') || '(record)'}: ${i.message}`);
  const record = parsed.data;
  const issues: string[] = [];
  if (record.seed !== codeHeatSeed(record.phase_seed)) issues.push(`seed: not codeHeatSeed(${record.phase_seed})`);
  const byId = new Map<string, CodeHeatEntryT>();
  record.entries.forEach((e, i) => {
    if (byId.has(e.entry)) issues.push(`entries.${i}: ${e.entry} is listed twice`);
    byId.set(e.entry, e);
    if (i > 0 && compareReceipts({ id: record.entries[i - 1]!.entry, received_at: record.entries[i - 1]!.received_at }, { id: e.entry, received_at: e.received_at }) >= 0) {
      issues.push(`entries.${i}: the field is in receipt order`);
    }
  });
  if (issues.length > 0) return issues;
  record.runs.forEach((r, i) => {
    if (r.entry === CODE_HEAT_CONTROL_ID) {
      if (!record.controlled) issues.push(`runs.${i}: a run of the control, in a heat that ran none (controlled false)`);
      return;
    }
    const e = byId.get(r.entry);
    if (e === undefined) issues.push(`runs.${i}: ${r.entry} is not in the field`);
    else if (r.matched !== (r.status === 'ok' && r.log_sha256 === e.action_log_sha256)) issues.push(`runs.${i}: matched is ${r.matched}, but its action log ${r.log_sha256 === e.action_log_sha256 ? 'is' : 'is not'} the graded one`);
  });
  // Every round in the order the seed draws, the warm-up and main rounds first: the finalists are read off those.
  let at = 0;
  const plan = stagePlan(record);
  const checkStage = (p: (typeof plan)[number]): void => {
    for (let round = 0; round < p.rounds; round++) {
      codeHeatRoundOrder(record.seed, p.stage, round, p.field, record.controlled).forEach((id, position) => {
        const r = record.runs[at];
        if (r === undefined || r.stage !== p.stage || r.round !== round || r.position !== position || r.entry !== id) {
          issues.push(`runs.${at}: ${p.stage} round ${round} runs ${id} at position ${position} here`);
        }
        at++;
      });
    }
  };
  checkStage(plan[0]!);
  checkStage(plan[1]!);
  if (issues.length > 0) return issues;
  const finalists = finalistsOf(record.entries, record.runs.slice(0, at), record.timing, record.finalist_places, record.controlled, codeClockTickUs(record.cpu_source));
  if (canonicalJson(finalists) !== canonicalJson(record.finalists)) {
    issues.push(`finalists: the main standing names ${JSON.stringify(finalists)}, not ${JSON.stringify(record.finalists)}`);
    return issues;
  }
  checkStage(plan[2]!);
  if (at !== record.runs.length) issues.push(`runs: the heat runs ${at} times, and ${record.runs.length} are listed`);
  return issues;
}

/**
 * Every entry's verdict from a record that holds (the header's record): its timing over its runs net of the heat's
 * pooled control (codeHeatPooledControlUs of the record's runs; never clamped, the timings made together on the tick of
 * the record's clock: codeHeatTimingsOf, codeClockTickUs), or TIMING_OUTPUTS_DIFFER. What a score is built with
 * (grader/score.ts ScoredInputs.timing), by the heat and by a regrade from the stored blob alike. CodeHeatError when the
 * record does not hold (codeHeatRecordIssues).
 */
export function codeHeatVerdicts(record: CodeHeatRecordT): Map<string, TimingVerdictT> {
  const issues = codeHeatRecordIssues(record);
  if (issues.length > 0) throw new CodeHeatError(`the heat record does not hold: ${issues.slice(0, 5).join('; ')}${issues.length > 5 ? `; and ${issues.length - 5} more` : ''}`);
  return verdictsOf(record.entries, record.runs, record.timing.trim, record.controlled, codeClockTickUs(record.cpu_source));
}

/** The record as stored (canonical JSON text or bytes), parsed and checked: CodeHeatError when it is no record that holds. */
export function parseCodeHeatRecord(stored: string | Uint8Array): CodeHeatRecordT {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof stored === 'string' ? stored : new TextDecoder('utf-8', { fatal: true }).decode(stored));
  } catch (err) {
    throw new CodeHeatError(`the heat record is not JSON: ${(err as Error).message}`);
  }
  const parsed = CodeHeatRecord.safeParse(raw);
  if (!parsed.success) throw new CodeHeatError(`the heat record is not one: ${parsed.error.issues[0]?.message ?? 'malformed'}`);
  const issues = codeHeatRecordIssues(parsed.data);
  if (issues.length > 0) throw new CodeHeatError(`the heat record does not hold: ${issues[0]}`);
  return parsed.data;
}

// ---------------------------------------------------------------- running the rounds

/** Where a run stands in the heat. */
export interface CodeRunAt {
  stage: CodeHeatStageT;
  round: number;
  position: number;
}

/** What one timed run measured: how it ended, its CPU time and its action log's sha256 (null unless ok). */
export interface TimedRunT {
  status: CodeRunStatusT;
  cpu_us: number;
  log_sha256: string | null;
}

export interface CodeHeatRoundsOptions {
  /** The phase seed (u64 decimal): every order is drawn from codeHeatSeed of it. */
  phaseSeed: string;
  timing: ProgramTimingT;
  /** codeHeatPlaces. */
  places: number;
  /** The field (any order: the record lists it in receipt order). */
  entries: readonly CodeHeatEntryT[];
  /** Where the CPU time is read (the record's cpu_source). */
  cpuSource: string;
  /** Run `entry` once and measure it. A throw stops the heat (the house's fault). */
  timeRun(entry: CodeHeatEntryT, at: CodeRunAt): Promise<TimedRunT>;
  /**
   * Run the control once (the header's control: the null entry, through the same timer) and measure it, at the place
   * each round draws for it. Given, every round runs it and the record is controlled; absent (a simulated clock), no
   * round does, and every run counts as read. A throw stops the heat; so does a control that did not end ok.
   */
  timeControl?(at: CodeRunAt): Promise<TimedRunT>;
  /**
   * The runs an earlier attempt of this heat measured, in the order they ran, its controls among them (the header's
   * resume): taken as they stand, never timed again, the heat going on after them. A prefix of the heat's runs
   * (codeHeatKeptIssue), else CodeHeatError.
   */
  kept?: readonly CodeHeatRunT[];
  /** Told of each run as it is recorded (a control's too), and of every run so far (the kept ones included): each one timed now, never a kept one. */
  onRun?(run: CodeHeatRunT, runs: number): void;
  /**
   * Handed every run so far (the kept ones first) after each run timed now, and awaited before the next starts: where the
   * heat keeps them (the header's resume). It is the heat's own list: read it before returning, never change it.
   */
  keep?(runs: readonly CodeHeatRunT[]): Promise<void>;
  /** Told of each round once its last run is recorded (a round wholly kept included: `timed` 0), after that run's keep. */
  onRound?(done: CodeHeatRoundDone): void;
  /** Stops the heat between runs, with the signal's reason. */
  signal?: AbortSignal;
}

/** A round of the heat once its last run is recorded (CodeHeatRoundsOptions.onRound). */
export interface CodeHeatRoundDone {
  stage: CodeHeatStageT;
  round: number;
  /** Every run recorded so far, kept ones included. */
  runs: number;
  /** The runs of this round timed now, never a kept one. */
  timed: number;
  /** The finalists, once the main standing named them (an empty list: no playoff); null before. */
  finalists: readonly string[] | null;
}

/**
 * The heat's field (the header's field): each entry checked, in receipt order. A TypeError when it lists one twice, or
 * names the control's id.
 */
function heatField(entries: readonly CodeHeatEntryT[]): CodeHeatEntryT[] {
  if (entries.some((e) => e.entry === CODE_HEAT_CONTROL_ID)) throw new TypeError(`the field names ${CODE_HEAT_CONTROL_ID}, the control's id: no entry takes it`);
  const field = entries.map((e) => CodeHeatFieldEntry.parse(e)).sort((a, b) => compareReceipts({ id: a.entry, received_at: a.received_at }, { id: b.entry, received_at: b.received_at }));
  if (new Set(field.map((e) => e.entry)).size !== field.length) throw new TypeError('the field lists an entry twice');
  return field;
}

/** A heat as its kept runs are held to it (codeHeatKeptIssue): the record's own header, whether it runs the control, and its clock. */
export type CodeHeatKeptHeat = Pick<CodeHeatRoundsOptions, 'phaseSeed' | 'timing' | 'places' | 'entries'> & {
  /** Every round runs the control (runCodeHeatRounds handed timeControl; runCodeHeat's always do). Default false. */
  controlled?: boolean;
  /**
   * The clock the record names (its cpu_source: the kept runs' first), whose tick (codeClockTickUs) the main standing
   * that names the finalists is weighed on. Default a clock that reads to the microsecond.
   */
  cpuSource?: string;
};

/**
 * Where `kept` parts from the runs of the heat `o` names (the header's resume), or null when it is a prefix of them: every
 * run in shape, at the stage, round, position and entry the seed draws there (the control's place among them in a
 * controlled heat; the playoff's over the finalists the kept main rounds name on the heat's clock), an entry's matched
 * exactly when it ran ok with its graded action log, and no more runs than the heat makes.
 */
export function codeHeatKeptIssue(o: CodeHeatKeptHeat, kept: readonly CodeHeatRunT[]): string | null {
  const timing = ProgramTiming.parse(o.timing);
  const entries = heatField(o.entries);
  const controlled = o.controlled ?? false;
  const tickUs = o.cpuSource === undefined ? 1 : codeClockTickUs(o.cpuSource);
  const byId = new Map(entries.map((e) => [e.entry, e]));
  const seed = codeHeatSeed(o.phaseSeed);
  let at = 0;
  const walk = (stage: CodeHeatStageT, rounds: number, field: readonly string[]): string | null => {
    for (let round = 0; round < rounds && at < kept.length; round++) {
      const order = codeHeatRoundOrder(seed, stage, round, field, controlled);
      for (let position = 0; position < order.length && at < kept.length; position++, at++) {
        const parsed = CodeHeatRun.safeParse(kept[at]);
        if (!parsed.success) return `run ${at}: ${parsed.error.issues[0]?.message ?? 'out of shape'}`;
        const r = parsed.data;
        if (r.stage !== stage || r.round !== round || r.position !== position || r.entry !== order[position]) {
          return `run ${at} is ${r.entry}'s at ${r.stage} round ${r.round} position ${r.position}, and the heat runs ${order[position]} at ${stage} round ${round} position ${position} there`;
        }
        // A control's shape is CodeHeatRun's (ok, never matched); an entry's matched flag is its graded log's.
        if (r.entry === CODE_HEAT_CONTROL_ID) continue;
        const graded = byId.get(r.entry)!.action_log_sha256;
        if (r.matched !== (r.status === 'ok' && r.log_sha256 === graded)) return `run ${at} of ${r.entry}: matched is ${r.matched}, but its action log ${r.log_sha256 === graded ? 'is' : 'is not'} the graded one`;
      }
    }
    return null;
  };
  const ids = entries.map((e) => e.entry);
  const issue = walk('warmup', ids.length === 0 ? 0 : timing.warmup_rounds, ids) ?? walk('main', ids.length === 0 ? 0 : timing.rounds, ids);
  if (issue !== null) return issue;
  if (at < kept.length) {
    // Every warm-up and main run is kept: the playoff runs over the finalists they name.
    const finalists = finalistsOf(entries, kept.slice(0, at), timing, o.places, controlled, tickUs);
    const playoff = walk('playoff', finalists.length === 0 ? 0 : timing.playoff_rounds, finalists);
    if (playoff !== null) return playoff;
  }
  return at < kept.length ? `${kept.length} runs are kept, and the heat makes ${at}` : null;
}

/** A control run as the heat records it (the header's control), or CodeHeatError when it did not run as the house's own program must. */
function controlRun(t: TimedRunT, at: CodeRunAt): CodeHeatRunT {
  const where = `${at.stage} round ${at.round}`;
  if (t.status !== 'ok') throw new CodeHeatError(`${where}: the control (the null entry, the house's own program) ended ${String(t.status)}: no run of the round can be counted net of it`);
  if (!Number.isSafeInteger(t.cpu_us) || t.cpu_us < 0) throw new CodeHeatError(`${where}: the control read ${t.cpu_us} µs of CPU, no whole number of microseconds`);
  if (t.log_sha256 === null || !Sha256Hex.safeParse(t.log_sha256).success) throw new CodeHeatError(`${where}: the control ended ok with no action log`);
  return CodeHeatRun.parse({ ...at, entry: CODE_HEAT_CONTROL_ID, status: 'ok', cpu_us: t.cpu_us, log_sha256: t.log_sha256, matched: false });
}

/**
 * Run a heat's rounds (the header's stages) through `timeRun`, one run at a time, and return its record: the warm-up and
 * main rounds over the field, the finalists named from the main standing, the playoff over them, each round's control
 * through `timeControl` at its drawn place when that is given (the header's control). Runs `kept` by an earlier attempt
 * stand in for their places, and only the rest are timed (the header's resume): the record is the one an uninterrupted
 * heat makes of the same measurements. The record holds (codeHeatRecordIssues), or this throws CodeHeatError. An entry's
 * run measured at no CPU, a control that did not end ok, or a run out of shape, is CodeHeatError.
 */
export async function runCodeHeatRounds(o: CodeHeatRoundsOptions): Promise<CodeHeatRecordT> {
  const timing = ProgramTiming.parse(o.timing);
  if (!Number.isSafeInteger(o.places) || o.places < 0) throw new RangeError(`${o.places} finalist places: a count`);
  const entries = heatField(o.entries);
  const byId = new Map(entries.map((e) => [e.entry, e]));
  const seed = codeHeatSeed(o.phaseSeed);
  const controlled = o.timeControl !== undefined;
  const kept = o.kept ?? [];
  const keptIssue = kept.length === 0 ? null : codeHeatKeptIssue({ ...o, timing, controlled }, kept);
  if (keptIssue !== null) throw new CodeHeatError(`the kept runs are no prefix of this heat's: ${keptIssue}`);
  const runs: CodeHeatRunT[] = [];
  let named: string[] | null = null;
  const runRound = async (stage: CodeHeatStageT, round: number, field: readonly string[]): Promise<void> => {
    const order = codeHeatRoundOrder(seed, stage, round, field, controlled);
    let timed = 0;
    for (let position = 0; position < order.length; position++) {
      const before = kept[runs.length];
      if (before !== undefined) {
        // Measured by an earlier attempt, and checked to stand here (codeHeatKeptIssue): never timed again.
        runs.push(CodeHeatRun.parse(before));
        continue;
      }
      timed++;
      o.signal?.throwIfAborted();
      const at: CodeRunAt = { stage, round, position };
      let run: CodeHeatRunT;
      if (order[position] === CODE_HEAT_CONTROL_ID) run = controlRun(await o.timeControl!(at), at);
      else {
        const e = byId.get(order[position]!)!;
        const t = await o.timeRun(e, at);
        if (!(CODE_RUN_STATUSES as readonly string[]).includes(t.status)) throw new CodeHeatError(`${stage} round ${round}: ${e.entry}'s run ended ${String(t.status)}`);
        if (!Number.isSafeInteger(t.cpu_us) || t.cpu_us <= 0) {
          throw new CodeHeatError(`${stage} round ${round}: ${e.entry}'s run read ${t.cpu_us} µs of CPU: a run that started its container spent some, so the clock is not reading`);
        }
        const log = t.status === 'ok' ? t.log_sha256 : null;
        if (t.status === 'ok' && (log === null || !Sha256Hex.safeParse(log).success)) throw new CodeHeatError(`${stage} round ${round}: ${e.entry}'s run ended ok with no action log`);
        run = CodeHeatRun.parse({ ...at, entry: e.entry, status: t.status, cpu_us: t.cpu_us, log_sha256: log, matched: t.status === 'ok' && log === e.action_log_sha256 });
      }
      runs.push(run);
      o.onRun?.(run, runs.length);
      await o.keep?.(runs);
    }
    o.onRound?.({ stage, round, runs: runs.length, timed, finalists: named });
  };
  const ids = entries.map((e) => e.entry);
  if (ids.length > 0) {
    for (let r = 0; r < timing.warmup_rounds; r++) await runRound('warmup', r, ids);
    for (let r = 0; r < timing.rounds; r++) await runRound('main', r, ids);
  }
  const finalists = finalistsOf(entries, runs, timing, o.places, controlled, codeClockTickUs(o.cpuSource));
  named = finalists;
  for (let r = 0; r < (finalists.length === 0 ? 0 : timing.playoff_rounds); r++) await runRound('playoff', r, finalists);
  const record = CodeHeatRecord.parse({
    format: CODE_HEAT_FORMAT,
    phase_seed: o.phaseSeed,
    seed,
    timing,
    finalist_places: o.places,
    controlled,
    cpu_source: o.cpuSource,
    entries,
    runs,
    finalists,
  });
  const issues = codeHeatRecordIssues(record);
  if (issues.length > 0) throw new CodeHeatError(`the heat's own record does not hold: ${issues[0]}`);
  return record;
}

// ---------------------------------------------------------------- the progress

/**
 * The most rounds and runs a heat makes (the header's progress): the warm-up and main rounds over `field` entries (and
 * the control, `controlled`), then the playoff's rounds over its finalists and the control. With `finalists` named (the
 * main standing's) that is exactly what it makes; before (null), as many finalists as the field and `places` allow, none
 * under two: grader/worker.ts codeHeatPlannedRuns and server/competitions/grading-budget.ts codeHeatRunCount count the same.
 */
export function codeHeatRunsPlanned(
  timing: Pick<ProgramTimingT, 'warmup_rounds' | 'rounds' | 'playoff_rounds'>,
  field: number,
  places: number,
  controlled: boolean,
  finalists: number | null = null,
): { rounds: number; runs: number } {
  if (field === 0) return { rounds: 0, runs: 0 };
  const most = finalists ?? Math.min(field, places);
  const playoff = timing.playoff_rounds > 0 && most >= 2 ? most : 0;
  const control = controlled ? 1 : 0;
  const first = timing.warmup_rounds + timing.rounds;
  return {
    rounds: first + (playoff === 0 ? 0 : timing.playoff_rounds),
    runs: first * (field + control) + (playoff === 0 ? 0 : timing.playoff_rounds * (playoff + control)),
  };
}

/** Where a heat stands once a round ends (codeHeatProgressLine). */
export interface CodeHeatProgressT {
  stage: CodeHeatStageT;
  round: number;
  /** Rounds and runs done, kept ones included, and the most the heat makes (codeHeatRunsPlanned). */
  roundsDone: number;
  roundsPlanned: number;
  runsDone: number;
  runsPlanned: number;
  /** Of the runs done, those an earlier attempt kept, and those this attempt timed. */
  kept: number;
  timed: number;
  /** ms since this attempt began timing, and the wall clock now (ms since the epoch). */
  ms: number;
  now: number;
  /** The finalists are named: runsPlanned is what the heat makes, not the most it can. */
  exact: boolean;
}

/**
 * The line a heat logs as a round ends (the header's progress): `<stage> round <r + 1> of <its stage's rounds> done
 * (<rounds done> of <planned> rounds[ at most]): <runs done> of <planned> runs[ at most] (<kept> kept from an earlier
 * attempt, <timed> timed by this one) at <rate> runs/min; ends about <ISO time> (<left> runs[ at most] to go)`. The rate
 * is this attempt's own (its timed runs over its time so far); no end is said before it has timed a run.
 */
export function codeHeatProgressLine(p: CodeHeatProgressT & { stageRounds: number }): string {
  const most = p.exact ? '' : ' at most';
  const left = Math.max(0, p.runsPlanned - p.runsDone);
  const perMin = p.ms > 0 ? (p.timed * 60_000) / p.ms : 0;
  const end =
    left === 0
      ? 'its last run is done'
      : perMin > 0
        ? `ends about ${new Date(p.now + (left / perMin) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')} (${left} runs${most} to go)`
        : `${left} runs${most} to go`;
  return (
    `${p.stage} round ${p.round + 1} of ${p.stageRounds} done (${p.roundsDone} of ${p.roundsPlanned} rounds${most}): ${p.runsDone} of ${p.runsPlanned} runs${most} ` +
    `(${p.kept} kept from an earlier attempt, ${p.timed} timed by this one) at ${perMin.toFixed(1)} runs/min; ${end}`
  );
}

// ---------------------------------------------------------------- the kept runs

/**
 * The kept runs' format (the header's resume), and their key's domain. v2: a controlled heat's, its control runs among
 * them, so every run v1 kept (none of a control) is measured for another heat, and discarded. v3: a heat of
 * CODE_HEAT_FORMAT v3's (its own seed, so its own orders, and the finalists named net of the pooled control), so every
 * run v2 kept is another heat's, and discarded.
 */
export const CODE_HEAT_PARTIAL_FORMAT = 'agent-fun/code-heat-partial/v3';

/** The runs an attempt of a heat has measured so far (the header's resume): canonical JSON, written whole after each run. */
export const CodeHeatPartial = z.strictObject({
  format: z.literal(CODE_HEAT_PARTIAL_FORMAT),
  /** codeHeatResumeKey of the heat they were measured for: a heat resumes from them only under the same key. */
  key: Sha256Hex,
  /** Every clock a run was read on, in the order the attempts opened them, each once: the first is the record's cpu_source. */
  cpu_sources: z.array(CpuSource).min(1),
  /** The runs measured so far, in the order they ran, the controls' among them: a prefix of the heat's (codeHeatKeptIssue). */
  runs: z.array(CodeHeatRun),
});
export type CodeHeatPartialT = z.infer<typeof CodeHeatPartial>;

/**
 * What a heat's kept runs were measured for (the header's resume): sha256 of the canonical JSON of the kept runs' format,
 * the record's own header (the phase seed, the timing, the finalist places, the field in receipt order with each
 * entry's graded action log), the control's program (`control`: the sha256 of its entry script, codeHeatControl's; null
 * for a heat of no control) and `plan`, the caller's JSON data naming everything else a timed run depends on. Any change
 * discards them.
 */
export function codeHeatResumeKey(o: Pick<CodeHeatRoundsOptions, 'phaseSeed' | 'timing' | 'places' | 'entries'> & { control?: string | null; plan: unknown }): string {
  return sha256Hex(
    canonicalJson({
      format: CODE_HEAT_PARTIAL_FORMAT,
      phase_seed: o.phaseSeed,
      seed: codeHeatSeed(o.phaseSeed),
      timing: ProgramTiming.parse(o.timing),
      finalist_places: o.places,
      entries: heatField(o.entries),
      control: o.control ?? null,
      plan: o.plan,
    }),
  );
}

/** What a timed run of a phase's heat depends on besides the record's own header (codeHeatMeasuredUnder's input). */
export interface CodeHeatMeasuredUnderInput {
  phaseId: string;
  /**
   * The competition's bundle as stored (competition.bundle, its JSON), never as this release's schema parses it: a
   * release that adds a defaulted key reads the same row as another object, and its runs are the same runs.
   */
  storedBundle: unknown;
  /** The phase's data digest (its plan's datasetSha256). */
  datasetSha256: string | null;
  /** The competition's one runtime, and the image the sandbox runs it in (Sandbox.imageDigest: null, none pinned). */
  runtime: string;
  imageDigest: string | null;
  /** Each entry of the field: its snapshot, the image its grade ran, and its env-lane entry_secret rows where it is timed with some. */
  field: readonly { entry: string; snapshot_sha256: string; image_digest: string | null; entry_secret_ids?: readonly string[] | undefined }[];
}

/**
 * The plan a phase's kept runs are keyed under (codeHeatResumeKey's plan; the header's resume): the phase, the sha256 of
 * its bundle as stored, its data, the runtime and its image, and the field's snapshots, images and secrets in entry id
 * order. Nothing of the grader that times it (no harness_version, no node version, no pod): every input of a run and
 * no more, so a heat cut on one grader or release resumes on any other that times the same inputs.
 */
export function codeHeatMeasuredUnder(i: CodeHeatMeasuredUnderInput): unknown {
  return {
    phase_id: i.phaseId.toLowerCase(),
    bundle_sha256: canonicalSha256(JSON.parse(JSON.stringify(i.storedBundle ?? null)) as unknown),
    dataset_sha256: i.datasetSha256,
    runtime: i.runtime,
    image_digest: i.imageDigest,
    // Each entry's entry_secret rows only where it is timed with some, so a field with none keys what it always did.
    field: i.field
      .map((f) => ({
        entry: f.entry,
        snapshot_sha256: f.snapshot_sha256,
        image_digest: f.image_digest,
        ...(f.entry_secret_ids === undefined ? {} : { entry_secret_ids: [...f.entry_secret_ids] }),
      }))
      .sort((a, b) => compareCodeUnits(a.entry, b.entry)),
  };
}

/**
 * A clock's kind (the header's resume): its source but the parent it reads, the last word (`cgroup-v2 <driver> <runtime>`
 * of grader/sandbox/docker.ts CpuClock.source; `rusage-children k8s <runtime class>` of a k8s clock's, its id dropped).
 * A heat resumes only on a clock of its kept runs' kind.
 */
export function codeHeatClockKind(source: string): string {
  const cut = source.lastIndexOf(' ');
  return cut < 0 ? source : source.slice(0, cut);
}

/** Where a heat keeps its runs (the header's resume): one heat's, its text whole or none. */
export interface CodeHeatPartialStore {
  /** Where it keeps them, as a log names it. */
  readonly where: string;
  /** The text kept, or null when none is. */
  read(): Promise<string | null>;
  /**
   * Keep `text` in place of what was kept: the whole of it, or (on a throw) what was kept before. A store that holds
   * writes (codeHeatPartialObject with a push window) keeps it in memory and resolves at once, never waiting for an
   * upload: it is pushed in the background, and is sure to be kept only once its flush resolves.
   */
  write(text: string): Promise<void>;
  /** Keep nothing (none kept: done), a write still held dropped with it. */
  remove(): Promise<void>;
  /**
   * Push what write() holds and has not pushed yet, after any push in flight: at the heat's end, abort or drain
   * (codeHeatPartialObject). Resolves once the newest text written is kept. Absent, or nothing held: nothing to do.
   * Throws when the push fails (what was pushed before stays kept).
   */
  flush?(): Promise<void>;
  /**
   * Its uploads in the background so far, read only, for a log (codeHeatPartialObject with a push window; null with
   * none, or before one has finished or failed). Absent: the store uploads nothing in the background.
   */
  uploads?(): CodeHeatPartialUploadsT | null;
}

/** A held store's uploads so far (CodeHeatPartialStore.uploads): words for a log only, never kept. */
export interface CodeHeatPartialUploadsT {
  /** The last upload that finished: how long it took, ms, and its text's length (as the partial's saves count bytes); null before one has. */
  last: { ms: number; bytes: number } | null;
  /** The window in force, ms: the least time from the last upload's start, finished or failed, to the next's (max(pushMs, PARTIAL_PUSH_DUTY x its length)). */
  windowMs: number;
  /** The uploads finished, and those that failed. */
  done: number;
  failed: number;
}

/**
 * How often a heat's partial kept through the process's objects is pushed at most (codeHeatPartialObject's window, the
 * header's resume): a write inside the window is held in memory and pushed when it ends, or at the heat's end, abort or
 * drain (flush). A heat cut off with no flush (its process killed) re-spends at most one window's runs or calls.
 */
export const PARTIAL_PUSH_MS = 10_000;

/**
 * The least time between two pushes' starts, as a multiple of the last push's own length (codeHeatPartialObject's
 * window: the larger of it and PARTIAL_PUSH_MS): uploads keep to about an eighth of the time, since the shared blob tier
 * slowed every heat's reads while a big partial was pushed back to back (news-image-20261121's final: 106 MB, 12 to 15 s
 * a push).
 */
export const PARTIAL_PUSH_DUTY = 8;

/** The objects a partial is kept in: a namespace's get, put and delete (server/blob-tier/object-store.ts ObjectStore). */
export type PartialObjects = Pick<ObjectStore, 'get' | 'put' | 'delete'>;

export interface CodeHeatPartialObjectOptions {
  /**
   * Push at most this often, in ms, or PARTIAL_PUSH_DUTY times the last push's length if longer, each write resolved at
   * once (default 0: each write pushed before it resolves).
   */
  pushMs?: number;
  /** Where a log names it (default `<ns>/<key>`). */
  where?: string;
  /** The monotonic clock the window runs on, in ms (default performance.now). */
  elapsedMs?: () => number;
  /** Told of a push in the background that failed (default console.log): its text stays held for the next push. */
  log?: (line: string) => void;
}

/**
 * The kept text as the object `key` of namespace `ns` (the grader's `heat-partials`: grader/worker.ts
 * heatPartialObjectsOf), one heat's, written whole by a put and read by a get, so another process (any grader, on any
 * node) resumes from it. With `pushMs`, each write is held in memory and resolves at once: a push of the newest text
 * held is begun in the background when none is under way and the window (pushMs, or PARTIAL_PUSH_DUTY times the last
 * push's length) has passed since the last began, else when the window ends (a timer) or at flush(), whichever comes
 * first; writes during a push only replace what is held. So a heat's many writes cost the tier one put a window, and
 * its sender never waits on one. Pushes and the removal run one at a time, in order, so a removal is never undone by a
 * push that lands after it. A read in the process that holds a write answers it; any other reads the object.
 */
export function codeHeatPartialObject(objects: PartialObjects, ns: ObjectNamespace, key: string, o: CodeHeatPartialObjectOptions = {}): CodeHeatPartialStore {
  const pushMs = o.pushMs !== undefined && Number.isFinite(o.pushMs) && o.pushMs > 0 ? o.pushMs : 0;
  const elapsed = o.elapsedMs ?? (() => performance.now());
  const log = o.log ?? ((line: string) => console.log(line));
  const where = o.where ?? `${ns}/${key}`;
  // The text written and not yet kept (null: none), when the last push began and how long it took, the pushes asked
  // and not yet settled, and the timer that ends the window.
  let held: string | null = null;
  let pushedAt = Number.NEGATIVE_INFINITY;
  let lastPushMs = 0;
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // For a log only (uploads()): the last push that landed, and the pushes landed and failed.
  let landed: { ms: number; bytes: number } | null = null;
  let done = 0;
  let failed = 0;
  // Every push and removal, one at a time, in the order asked.
  let turns: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const mine = turns.then(fn, fn);
    turns = mine.catch(() => undefined);
    return mine;
  };
  const stopTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const words = (err: unknown) => (err instanceof Error ? err.message : String(err));
  // The newest text held when it begins, one put.
  const push = (): Promise<void> => {
    pending++;
    return inTurn(async () => {
      const text = held;
      if (text === null) return;
      const began = elapsed();
      pushedAt = began;
      try {
        await objects.put(ns, key, text, { contentType: 'application/json' });
      } catch (err) {
        failed++;
        throw err;
      } finally {
        lastPushMs = Math.max(0, elapsed() - began);
      }
      done++;
      landed = { ms: lastPushMs, bytes: text.length };
      // A write since keeps its own text held.
      if (held === text) held = null;
    }).finally(() => {
      pending--;
    });
  };
  // With a window: a push begun in the background once none is asked and the window has passed since the last began,
  // else the timer set for its end. A push that lands with a newer text held starts the next window here.
  const next = (): void => {
    if (pushMs === 0 || held === null || pending > 0) return;
    const wait = pushedAt + Math.max(pushMs, PARTIAL_PUSH_DUTY * lastPushMs) - elapsed();
    if (wait <= 0) {
      stopTimer();
      push().then(next, (err: unknown) => log(`the partial kept at ${where} could not be pushed (${words(err)}): it is held, and pushed again by the next write or the heat's end`));
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      next();
    }, wait);
    timer.unref?.();
  };
  return {
    where,
    async read() {
      if (held !== null) return held;
      const got = await objects.get(ns, key);
      return got === undefined ? null : new Response(got.stream).text();
    },
    async write(text) {
      held = text;
      // No window: pushed before it resolves.
      if (pushMs === 0) {
        await push();
        return;
      }
      next();
    },
    async remove() {
      stopTimer();
      held = null;
      await inTurn(() => objects.delete(ns, key));
    },
    async flush() {
      stopTimer();
      // After any push in flight: the newest text held when it begins.
      await push();
      next();
    },
    uploads() {
      if (pushMs === 0 || done + failed === 0) return null;
      return { last: landed, windowMs: Math.max(pushMs, PARTIAL_PUSH_DUTY * lastPushMs), done, failed };
    },
  };
}

/**
 * The kept runs in a file at `path` (grader/worker.ts codeHeatPartialPath: the work root's, on the data claim every grader
 * pod mounts): each write goes to `<path>.tmp` and is renamed into place, so a reader finds a whole text or the one before it.
 * One heat writes it at a time (its job's singleton key, the process's one clock).
 */
export function codeHeatPartialFile(path: string): CodeHeatPartialStore {
  const tmp = `${path}.tmp`;
  return {
    where: path,
    async read() {
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(text) {
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, path);
    },
    async remove() {
      await rm(tmp, { force: true });
      await rm(path, { force: true });
    },
  };
}

/** What became of the runs an earlier attempt kept (runCodeHeat with progress; the header's resume). */
export type CodeHeatResumeT =
  /** None was kept (or the heat keeps none: no progress handed in): every run timed now. */
  | { kind: 'fresh' }
  /** `runs` kept runs taken as they stood, the rest timed now; `cpu_sources` every clock the record's runs were read on, its cpu_source first. */
  | { kind: 'resumed'; runs: number; cpu_sources: string[] }
  /** Runs were kept, and not for this heat on this kind of clock, or not readable (`why`): dropped, and every run timed now. */
  | { kind: 'discarded'; why: string };

/** What an attempt resumes from: the kept runs and their clocks when they are this heat's, else why not (null: none kept). */
async function keptOf(
  store: CodeHeatPartialStore,
  key: string,
  source: string,
  heat: CodeHeatKeptHeat,
): Promise<{ partial: CodeHeatPartialT } | { why: string } | null> {
  const words = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let text: string | null;
  try {
    text = await store.read();
  } catch (err) {
    return { why: `they could not be read (${words(err)})` };
  }
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { why: `they are not JSON (${words(err)})` };
  }
  const parsed = CodeHeatPartial.safeParse(raw);
  if (!parsed.success) return { why: `they are out of shape (${parsed.error.issues[0]?.path.join('.') || '(partial)'}: ${parsed.error.issues[0]?.message ?? 'malformed'})` };
  const partial = parsed.data;
  if (partial.key !== key) return { why: `they were measured for another heat (key ${partial.key}; this one's is ${key}): its field, seed, timing or plan has changed since` };
  const first = partial.cpu_sources[0]!;
  if (codeHeatClockKind(first) !== codeHeatClockKind(source)) return { why: `they were read on another kind of clock (${first}; this attempt reads on ${source})` };
  // The record names the first clock, and weighs its main standing on that clock's tick.
  const issue = codeHeatKeptIssue({ ...heat, cpuSource: first }, partial.runs);
  if (issue !== null) return { why: `they are no prefix of this heat's runs: ${issue}` };
  return { partial };
}

// ---------------------------------------------------------------- on a timing sandbox

/** A timed sandbox and its CPU clock, as a timing sandbox's openCpuClock hands them back. */
export interface TimedSandbox {
  clock: CpuClock;
  sandbox: Sandbox;
}

/**
 * A sandbox a timing reads CPU time on (the header's clock): the docker driver's (grader/sandbox/docker.ts DockerSandbox,
 * a timing parent cgroup read host-side) or the k8s driver's (grader/sandbox/k8s.ts K8sSandbox, the CPU launcher's
 * readings summed). Its openCpuClock hands back the sandbox every timed run goes to and the clock that counts them.
 */
export interface TimingSandbox extends Sandbox {
  openCpuClock(runtime: Runtime): TimedSandbox;
}

/**
 * An entry as the timer runs it: its field entry, its snapshot, the image digest its grade ran (null: the pinned one),
 * and its entry-link record.
 */
export interface TimedEntry extends CodeHeatEntryT {
  snapshot: SnapshotSource;
  image_digest: string | null;
  /**
   * The entry's entry-link record as its grade was handed it (grade.ts EntryFacts.entry_link: submission.entry_link, null
   * where the stage recorded none), from which a plan naming a house dossier (HarnessPlan.houseDossier) makes each timed
   * run's log the one its grade recorded (the header's `a run`). Read only under such a plan. Absent: the run's own log,
   * as a grade handed no record keeps it.
   */
  entry_link?: EntryFacts['entry_link'];
}

export interface CodeTimerOptions {
  /** The final phase's program/v1 plan (grader/harnesses.ts), as its grades ran. */
  plan: HarnessPlan;
  /** The grader's timing sandbox (docker or k8s): the timer opens its CPU clock (openCpuClock) and runs every entry under it. */
  sandbox: TimingSandbox;
  /** The competition's one runtime. */
  runtime: Runtime;
  /** The competition's limits: every run takes them with cpus CODE_HEAT_CPUS. */
  limits: LimitsT;
  /** An existing directory; each run's scratch is made and removed under it (grade.ts executeOnce). */
  workRoot: string;
  /** Where each run's outputs are kept. */
  blobs: OutputBlobs;
  /** Whose runs these are (grade.ts GradeRequest.owner): the scratch is named for it. */
  owner?: string;
  /**
   * The job attempt's signal (server/jobs.ts JobContext.signal): once it aborts, the run under way is stopped (its program
   * killed: grade.ts executeOnce's signal) and throws the signal's reason, never measured, and no run starts after it.
   */
  signal?: AbortSignal;
  /**
   * Where the house dossier step's note goes (the header's `a run`), with the entry it is of; only under a plan naming a
   * dossier path. Default: a line on stdout (grade.ts houseDossierLine), each entry's same note once a timer, so a heat's
   * many runs of one entry log it once.
   */
  onHouseDossier?: (entry: string, note: string) => void;
}

/** A clock and the runs it times: one run of an entry, or of the control, its CPU time the clock's settled delta. */
export interface CodeTimer {
  readonly source: string;
  /** The control's program (the sha256 of its entry script: codeHeatControl), what the kept runs' key names. */
  readonly control: string;
  time(entry: TimedEntry, label: string): Promise<TimedRunT>;
  /** One run of the control (the header's control), as an entry's run is timed; its reading may be 0. */
  timeControl(label: string): Promise<TimedRunT>;
  close(): Promise<void>;
}

/** A run's container label stem: `heat-<w|m|p><round>`, each case's container `<stem>-c<case>`. */
export function codeRunLabel(at: Pick<CodeRunAt, 'stage' | 'round'>): string {
  return `heat-${at.stage[0]}${at.round}`;
}

/** A control run's container label stem: its round's (codeRunLabel) and `-control`. */
export function codeControlLabel(at: Pick<CodeRunAt, 'stage' | 'round'>): string {
  return `${codeRunLabel(at)}-control`;
}

/** Where the timer keeps the control's program (the header's control), under the work root: a blob store of its own. */
export const CODE_HEAT_CONTROL_STORE = 'code-heat-control';

/**
 * The control's snapshot in `runtime` (the header's control): server/proposals/packs.ts PACK_NULL_ENTRY as the one
 * entry script (ENTRY_SCRIPTS), its blob in a store at `<workRoot>/CODE_HEAT_CONTROL_STORE`, and `sha256`, the script's
 * (what the kept runs' key names: codeHeatResumeKey's control).
 */
export async function codeHeatControl(workRoot: string, runtime: Runtime): Promise<{ snapshot: SnapshotSource; sha256: string }> {
  // Loaded here: the pack module is a heavy import for the record's readers (cli/kit.ts, the archive), who run no heat.
  const { PACK_NULL_ENTRY } = await import('../server/proposals/packs.ts');
  const bytes = Buffer.from(PACK_NULL_ENTRY[runtime], 'utf8');
  const blobs = new BlobStore(join(workRoot, CODE_HEAT_CONTROL_STORE));
  const { sha256 } = await blobs.put(bytes);
  const index: SnapshotIndex = { format: SNAPSHOT_FORMAT, commit: null, files: [{ path: ENTRY_SCRIPTS[runtime], kind: 'file', mode: 0o644, size: bytes.length, sha256 }] };
  return { snapshot: { index, blobs }, sha256 };
}

/**
 * Open a timer (the header's clock, a run and the control): preflight the plan's images, open the sandbox's CPU clock,
 * keep the control's snapshot (codeHeatControl), and time each run as the clock's settled reading after it minus the
 * one before it, the run itself grade.ts executeOnce in the timed sandbox at CODE_HEAT_CPUS (the control's in the pinned
 * image). An entry's run is held to the graded log by the log its grade would record of it: under a plan naming a house
 * dossier the one grade.ts houseDossierLogOf makes, once the reading after it is taken (the header's `a run`), else its
 * own. An entry's run read at no CPU is the clock's fault (SandboxError). A run under way when the options' signal
 * aborts is killed and throws the signal's reason, never measured. Each run's scratch is released from the sandbox's
 * daemon once its reading is taken (or it threw), between runs and never between a run's two readings (grade.ts
 * releaseScratch, its header's Releasing; a docker sandbox whose daemon is in a VM, nothing elsewhere). Close it when done.
 */
export async function openCodeTimer(o: CodeTimerOptions): Promise<CodeTimer> {
  if (o.plan.kind !== 'program/v1') throw new TypeError(`a timing heat runs program/v1 entries, not ${o.plan.kind}`);
  await preflight(o.plan, o.sandbox, o.runtime, null);
  const control = await codeHeatControl(o.workRoot, o.runtime);
  const { clock, sandbox } = o.sandbox.openCpuClock(o.runtime);
  const limits: LimitsT = { ...o.limits, cpus: CODE_HEAT_CPUS };
  const noted = new Set<string>();
  const noteDossier =
    o.onHouseDossier ??
    ((entry: string, note: string): void => {
      const key = `${entry}\u0000${note}`;
      if (noted.has(key)) return;
      noted.add(key);
      console.log(houseDossierLine(`code timing of ${entry}`, note));
    });
  /**
   * The sha256 of the log run `exec` of `entry` is held to the graded one by (the header's `a run`): under a plan naming a
   * house dossier the log the grade's own step makes of it (grade.ts houseDossierLogOf: HouseDossierFault where the
   * dossier is missing by the house's fault), else its own. Null unless it ended ok. Read after the clock's reading.
   */
  const gradedLogSha256 = async (entry: TimedEntry, exec: Execution, label: string): Promise<string | null> => {
    if (exec.status !== 'ok') return null;
    const graded = await houseDossierLogOf(
      {
        plan: o.plan,
        entry: entry.entry_link === undefined ? {} : { entry_link: entry.entry_link },
        blobs: o.blobs,
        onHouseDossier: (note) => noteDossier(entry.entry, note),
      },
      exec,
      label,
    );
    return graded.sha256;
  };
  const measure = async (snapshot: SnapshotSource, imageDigest: string | null, label: string, entry: TimedEntry | null): Promise<{ status: CodeRunStatusT; cpu: bigint; log_sha256: string | null }> => {
    // The run's scratch, removed as it ends (executeOnce), handed here rather than released there, between the clock's two
    // readings: released once the reading after it is taken, or the run threw (grade.ts releaseScratch, its header's
    // Releasing), so a release container never runs inside a timed window, nor moves a reading.
    const released: string[] = [];
    try {
      const before = await clock.settled();
      const exec = await executeOnce({
        plan: o.plan,
        sandbox,
        runtime: o.runtime,
        snapshot,
        limits,
        workRoot: o.workRoot,
        blobs: o.blobs,
        label,
        imageDigest,
        ...(o.owner === undefined ? {} : { owner: o.owner }),
        ...(o.signal === undefined ? {} : { signal: o.signal }),
        released,
      });
      const after = await clock.settled();
      // An entry's log as its grade recorded it (gradedLogSha256: a house dossier's step, outside the timed window); the
      // control's as it ran (the house's own program, never matched).
      const log = entry === null ? (exec.status === 'ok' ? exec.log_sha256 : null) : await gradedLogSha256(entry, exec, label);
      return { status: exec.status, cpu: after - before, log_sha256: log };
    } finally {
      await releaseScratch(sandbox, released);
    }
  };
  return {
    source: clock.source,
    control: control.sha256,
    async time(entry, label) {
      const m = await measure(entry.snapshot, entry.image_digest, label, entry);
      if (m.cpu <= 0n) throw new SandboxError(`CPU time is unreadable host-side: ${clock.source} read ${m.cpu} µs for a run of ${entry.entry} that started its container`);
      return { status: m.status, cpu_us: Number(m.cpu), log_sha256: m.log_sha256 };
    },
    async timeControl(label) {
      const m = await measure(control.snapshot, null, label, null);
      if (m.cpu < 0n) throw new SandboxError(`the CPU clock went back: ${clock.source} read ${m.cpu} µs for a run of the control`);
      return { status: m.status, cpu_us: Number(m.cpu), log_sha256: m.log_sha256 };
    },
    close: () => clock.close(),
  };
}

/** Where a heat keeps its runs as it goes, and what they are measured under (the header's resume). */
export interface CodeHeatProgress {
  /** Where they are kept (codeHeatPartialFile). */
  store: CodeHeatPartialStore;
  /**
   * What a timed run depends on besides the record's own header (codeHeatResumeKey's plan): JSON data, the caller's
   * (grader/worker.ts hands codeHeatMeasuredUnder: the phase, its bundle as stored, its data, the runtime and its image,
   * each entry's snapshot, image and secrets). Kept runs measured under any other are discarded.
   */
  plan: unknown;
}

/** A heat as runTimedCodeHeat runs it on a timer it is handed: the record's header, its field, and what it keeps and tells. */
export interface CodeHeatTimedOptions {
  phaseSeed: string;
  timing: ProgramTimingT;
  /** codeHeatPlaces of the bundle's prizes. */
  places: number;
  entries: readonly TimedEntry[];
  /** Keep the runs as they are measured, and resume from those an earlier attempt kept (the header's resume). None: every run timed, none kept. */
  progress?: CodeHeatProgress;
  /**
   * Told what the heat did with the kept runs (resumed or discarded them), of a write of them that failed, and as each
   * round this attempt timed a run of ends, where the heat stands (codeHeatProgressLine: the header's progress).
   */
  log?(line: string): void;
  onRun?(run: CodeHeatRunT, runs: number): void;
  /** Stops the heat between runs (and the run under way, on a timer that takes it), with the signal's reason. */
  signal?: AbortSignal;
  /** The wall clock, ms since the epoch (default Date.now): what the progress line's pace and end are read on. */
  now?: () => number;
}

/** A heat on a timing sandbox (runCodeHeat): the timer's options, the job attempt's signal among them, and the heat's. */
export type CodeHeatOptions = CodeTimerOptions & CodeHeatTimedOptions;

/** A heat run: its record, the record's canonical JSON and sha256 (the blob to store), every entry's verdict, and what it resumed from. */
export interface CodeHeatOutcome {
  record: CodeHeatRecordT;
  json: string;
  sha256: string;
  verdicts: Map<string, TimingVerdictT>;
  resume: CodeHeatResumeT;
}

/**
 * Run a heat on a timing sandbox (the header): openCodeTimer, then runTimedCodeHeat on it, the timer closed however it
 * ends. The kept runs outlive the heat: its caller removes them once the record's verdicts are written
 * (progress.store.remove).
 */
export async function runCodeHeat(o: CodeHeatOptions): Promise<CodeHeatOutcome> {
  const timer = await openCodeTimer(o);
  try {
    return await runTimedCodeHeat(timer, o);
  } finally {
    try {
      // The runs a held store has not pushed yet, pushed at the heat's end, abort or drain (codeHeatPartialObject).
      await o.progress?.store.flush?.();
    } catch (err) {
      o.log?.(`the heat's last runs could not be kept at ${o.progress?.store.where} (${err instanceof Error ? err.message : String(err)}): an attempt after this one resumes from what was kept before`);
    } finally {
      await timer.close();
    }
  }
}

/**
 * Run a heat through `timer` (the header): runCodeHeatRounds through it with every round's control (the timer's
 * timeControl), the verdicts rebuilt from the record. Handed `progress`, it first reads what an earlier attempt kept:
 * runs of this heat (codeHeatResumeKey, the timer's control named) read on a clock of this one's kind are taken as they
 * stand, kept controls with them, and only the rest timed, the record's cpu_source the clock of its first run; anything
 * else kept is removed, and the heat starts over. Every run timed is then kept before the next starts (a write that
 * fails is logged once, and the heat goes on: what was kept before stays a prefix of it). Each round this attempt timed
 * a run of ends with a progress line (codeHeatProgressLine). The process holds nothing the next attempt needs: a heat
 * cut anywhere resumes, on any process that reads the same store, at the run after the last one kept.
 */
export async function runTimedCodeHeat(timer: Pick<CodeTimer, 'source' | 'control' | 'time' | 'timeControl'>, o: CodeHeatTimedOptions): Promise<CodeHeatOutcome> {
  const now = o.now ?? Date.now;
  const byId = new Map(o.entries.map((e) => [e.entry, e]));
  const heat = {
    phaseSeed: o.phaseSeed,
    timing: o.timing,
    places: o.places,
    entries: o.entries.map((e) => ({ entry: e.entry, received_at: e.received_at, action_log_sha256: e.action_log_sha256 })),
    controlled: true,
  };
  const words = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let kept: CodeHeatRunT[] = [];
  let sources: string[] = [];
  let resume: CodeHeatResumeT = { kind: 'fresh' };
  const progress = o.progress;
  const key = progress === undefined ? null : codeHeatResumeKey({ ...heat, control: timer.control, plan: progress.plan });
  if (progress !== undefined && key !== null) {
    const { store } = progress;
    const found = await keptOf(store, key, timer.source, heat);
    if (found !== null && 'why' in found) {
      resume = { kind: 'discarded', why: found.why };
      o.log?.(`the runs kept at ${store.where} are discarded, and the heat starts over: ${found.why}`);
      try {
        await store.remove();
      } catch (err) {
        o.log?.(`the discarded runs at ${store.where} could not be removed (${words(err)}): the heat's first run writes over them`);
      }
    } else if (found !== null) {
      kept = found.partial.runs;
      sources = found.partial.cpu_sources;
      resume = { kind: 'resumed', runs: kept.length, cpu_sources: [...sources] };
      o.log?.(
        `resuming from ${kept.length} ${kept.length === 1 ? 'run' : 'runs'} an earlier attempt kept at ${store.where} (read on ${sources.join(', ')}): ` +
          `they are never timed again, and this attempt reads the rest on ${timer.source}`,
      );
    }
  }
  // A run timed now is read on this attempt's clock, named after the kept runs' clocks (once); the record names the first.
  const clocks = sources.includes(timer.source) ? sources : [...sources, timer.source];
  let keep: ((runs: readonly CodeHeatRunT[]) => Promise<void>) | undefined;
  if (progress !== undefined && key !== null) {
    const { store } = progress;
    let failed = false;
    keep = async (runs) => {
      // Each run was checked as it was recorded (CodeHeatRun); what is read back is checked again (keptOf).
      const partial: CodeHeatPartialT = { format: CODE_HEAT_PARTIAL_FORMAT, key, cpu_sources: clocks, runs: runs as CodeHeatRunT[] };
      try {
        await store.write(canonicalJson(partial));
      } catch (err) {
        if (!failed) o.log?.(`the heat's runs could not be kept at ${store.where} (${words(err)}): it goes on, and an attempt after this one resumes from what was kept before`);
        failed = true;
      }
    };
  }
  // The progress line at each round's end (the header's progress): this attempt's pace, from when it began timing.
  const started = now();
  let timedNow = 0;
  const field = heat.entries.length;
  const stageRounds = { warmup: o.timing.warmup_rounds, main: o.timing.rounds, playoff: o.timing.playoff_rounds } as const;
  const onRound = (d: CodeHeatRoundDone): void => {
    timedNow += d.timed;
    if (d.timed === 0 || o.log === undefined) return;
    const planned = codeHeatRunsPlanned(o.timing, field, o.places, true, d.finalists === null ? null : d.finalists.length);
    const before = { warmup: 0, main: o.timing.warmup_rounds, playoff: o.timing.warmup_rounds + o.timing.rounds }[d.stage];
    const at = now();
    o.log(
      codeHeatProgressLine({
        stage: d.stage,
        round: d.round,
        stageRounds: stageRounds[d.stage],
        roundsDone: before + d.round + 1,
        roundsPlanned: planned.rounds,
        runsDone: d.runs,
        runsPlanned: planned.runs,
        kept: kept.length,
        timed: timedNow,
        ms: at - started,
        now: at,
        exact: d.finalists !== null,
      }),
    );
  };
  const record = await runCodeHeatRounds({
    ...heat,
    cpuSource: clocks[0]!,
    kept,
    timeRun: (e, at) => timer.time(byId.get(e.entry)!, codeRunLabel(at)),
    timeControl: (at) => timer.timeControl(codeControlLabel(at)),
    onRound,
    ...(keep === undefined ? {} : { keep }),
    ...(o.onRun === undefined ? {} : { onRun: o.onRun }),
    ...(o.signal === undefined ? {} : { signal: o.signal }),
  });
  if (resume.kind === 'resumed') resume = { ...resume, cpu_sources: [...(record.runs.length > kept.length ? clocks : sources)] };
  const { json, sha256 } = codeHeatRecordDigest(record);
  return { record, json, sha256, verdicts: codeHeatVerdicts(record), resume };
}

/**
 * The dev phase's provisional timing of one passing entry (the header's dev phase): CODE_TIMING_DEV_ROUNDS runs through
 * a timer of its own, each followed by a run of the control, TIMING_OUTPUTS_DIFFER when one is not the graded run's
 * action log, else provisionalCodeTiming of the runs net of the median of the control's runs (codeRunNetUs: pooled, as
 * a heat's are). A control that does not end ok is CodeHeatError (the house's fault). Once the options' signal aborts,
 * the run under way is killed and no other starts: the signal's reason is thrown, and no verdict.
 */
export async function runProvisionalTiming(o: CodeTimerOptions & { entry: TimedEntry }): Promise<TimingVerdictT> {
  o.signal?.throwIfAborted();
  const timer = await openCodeTimer(o);
  try {
    const cpu: number[] = [];
    const control: number[] = [];
    for (let i = 0; i < CODE_TIMING_DEV_ROUNDS; i++) {
      o.signal?.throwIfAborted();
      const t = await timer.time(o.entry, `dev-time-${i}`);
      if (t.status !== 'ok' || t.log_sha256 !== o.entry.action_log_sha256) return TIMING_OUTPUTS_DIFFER;
      o.signal?.throwIfAborted();
      const c = await timer.timeControl(`dev-time-${i}-control`);
      if (c.status !== 'ok') throw new CodeHeatError(`dev timing run ${i}: the control (the null entry, the house's own program) ended ${c.status}: the runs cannot be counted net of it`);
      cpu.push(t.cpu_us);
      control.push(c.cpu_us);
    }
    const pooled = Number(scrapeMedianUs(asTrials(control))!);
    return provisionalCodeTiming(cpu.map((us) => codeRunNetUs(us, pooled)));
  } finally {
    await timer.close();
  }
}
