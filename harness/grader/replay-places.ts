// Replay places: how many replay grades one grader process runs at once, by its event loop's headroom.
//
// A replay grade's executions (grader/run.ts executeLockstep: pumpfun-replay/v2's sim/engine.ts ReplayEngine, bars-replay/v1's
// BarsEngine, clmm-replay/v1's ClmmEngine) step their engine in lockstep with the bot ON THIS PROCESS'S MAIN THREAD:
// every batch is built, encoded, parsed and submitted here, between the bot's replies. The grade pool counts sandbox pods,
// not that thread, so a home grader at MAKEFUN_GRADE_CONCURRENCY 64 took every replay grade its pool let in (prod
// 2026-11-24: six home graders held ~57 pumpfun-replay/v2 grades each, their loops pinned at utilization 1.0, each replay
// 20x slower, and ingest-transcripts, 72 of its 102 workers on the graders, twice its job time). A burst grader refuses
// replays (grader/burst-runnable.ts), so every one lands at home.
//
// So a replay grade takes a place here (ReplayPlaces) before its handler runs, and holds it for the whole grade (both
// executions, every practice window of an eras grade, the scorer), given back as its handler ends:
//
//   in flight < the floor (REPLAY_PLACES_FLOOR, 2)    admitted whatever the loop reads, so replay grading never stalls
//   in flight >= the max (MAKEFUN_REPLAY_CONCURRENCY_MAX, 24)
//                                                    refused `max`: a hard max, nothing is ever admitted past it
//   the loop's utilization over its last 10 s (REPLAY_LOOP_WINDOW_MS, perf_hooks performance.eventLoopUtilization)
//   at or past MAKEFUN_REPLAY_ELU_MAX (0.75), or not read yet
//                                                    refused `loop`
//   anything else                                    admitted
//
// A loop not read yet (a window younger than one REPLAY_LOOP_STEP_MS, a reader that throws) admits the floor alone, so a
// backlog landing on a grader just started never takes the max at once; the process's window starts at its boot
// (processReplayPlaces, called by server/pipeline/index.ts startWorkers where the grade queues are worked).
//
// Who asks:
//   - a grade-dev or grade-final job (server/jobs.ts `replay room`): JobQueue.work asks JobQueueOptions.replayRoom, which
//     server/pipeline/index.ts builds with replayRoomOf over this process's places, once the job has its sandbox pool
//     place and right before its handler. A fresh grade or an L2 regrade of a replay harness (replayGradeRuns, by its
//     phase's harness kind, read once a phase and kept: phaseKindCache) takes a place and holds it until its handler ends;
//     refused, the job is handed back before its handler, so its entry is never claimed and its snapshot never read, and
//     it waits unbounded, holding nothing: no node-room hand-back is spent. An L1 regrade, a provisional rejudge, and an
//     agent/v1, program/v1 or other grade run none of this thread's lockstep, so they take none.
//   - the dev stress (grader/dev-stress.ts): its copies run one at a time, each waiting in its handler for a place
//     (ReplayPlaces.wait, REPLAY_PLACE_POLL_MS between asks, its signal ending the wait).
//
// The hindsight audit's replays (grader/hindsight-audit.ts) take no place: its queue is the ops worker's too and runs
// one audit at a time.
//
// What a place changes is only when a grade runs: never its executions, its logs or its score.
//
// Seen: makefun_replay_places_in_flight (the places held now), makefun_replay_loop_utilization (the loop's last
// windowed read), makefun_replay_admissions_total{outcome} (each ask: floor, room admitted; max, loop refused, a
// waiting stress's every ask counted), and per replay execution (grader/grade.ts executeOnce, replayLoopMeter) the main
// thread's busy time over it, makefun_replay_execution_loop_busy_seconds{kind}, with one line beside it while a place is
// held in this process: the execution's wall, the loop's busy ms over it, and the replays in flight here, so the next
// diagnosis can see where the loop's time went. A grade handed back counts on
// makefun_jobs_handed_back_total{reason="replay_room"} (server/jobs.ts). Registered on the process's registry when its
// places are made (registerReplayMetrics), never in a CLI that makes none.
//
// tests/unit/replay-places.test.ts runs it.

import { performance, type EventLoopUtilization } from 'node:perf_hooks';
import type { HarnessKindT } from '../contracts/competition.ts';
import { DEFAULT_REPLAY_CONCURRENCY_MAX, DEFAULT_REPLAY_ELU_MAX, MAX_REPLAY_CONCURRENCY_MAX, parseReplayConcurrencyMax, parseReplayEluMax } from '../server/config.ts';
import type { ReplayRoomAnswer } from '../server/jobs.ts';

/** The harnesses whose executions step a sim engine on this process's main thread (grader/run.ts executeLockstep). */
export const REPLAY_HARNESS_KINDS = Object.freeze(['pumpfun-replay/v2', 'bars-replay/v1', 'clmm-replay/v1'] as const satisfies readonly HarnessKindT[]);

/** Whether a harness of `kind` runs its executions through executeLockstep here. */
export function isReplayHarness(kind: string): boolean {
  return (REPLAY_HARNESS_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether a grade job of `kind` on a harness of `harness` runs replay executions here: a fresh grade or an L2 regrade
 * of a replay harness. An L1 regrade re-scores a stored log, a provisional rejudge and a top-up run none.
 */
export function replayGradeRuns(harness: string, kind: string): boolean {
  return isReplayHarness(harness) && (kind === 'grade' || kind === 'regrade_l2');
}

/** The places always admitted, whatever the loop reads (never above the max): replay grading never stalls on a busy loop. */
export const REPLAY_PLACES_FLOOR = 2;
/** The window the loop's utilization is read over, and the step it is sampled at. */
export const REPLAY_LOOP_WINDOW_MS = 10_000;
export const REPLAY_LOOP_STEP_MS = 1_000;
/** How often a waiting caller (the dev stress) asks again for a place. */
export const REPLAY_PLACE_POLL_MS = 2_000;

// ---------------------------------------------------------------- the loop's window

/** The event loop's utilization over its recent window, sampled on a timer. */
export interface LoopWindow {
  /** The loop's busy share (0 to 1) over its last window, or null while fewer than one step of samples are kept. */
  read(): number | null;
  /** Stop sampling. */
  stop(): void;
}

/**
 * The loop's utilization over its last `windowMs` (performance.eventLoopUtilization), sampled every `stepMs` on an unref'd
 * timer: a read is the delta from the newest sample at least `windowMs` old (the oldest kept while none is) to now.
 */
export function loopWindow(windowMs = REPLAY_LOOP_WINDOW_MS, stepMs = REPLAY_LOOP_STEP_MS): LoopWindow {
  const samples: Array<{ at: number; elu: EventLoopUtilization }> = [{ at: performance.now(), elu: performance.eventLoopUtilization() }];
  const timer = setInterval(() => {
    const at = performance.now();
    samples.push({ at, elu: performance.eventLoopUtilization() });
    // Keep one sample at least the window old, and every one after it.
    while (samples.length > 2 && samples[1]!.at <= at - windowMs) samples.shift();
  }, stepMs);
  timer.unref();
  return {
    read: () => {
      const now = performance.now();
      let base = samples[0]!;
      for (const s of samples) {
        if (s.at <= now - windowMs) base = s;
        else break;
      }
      if (now - base.at < stepMs) return null;
      return performance.eventLoopUtilization(performance.eventLoopUtilization(), base.elu).utilization;
    },
    stop: () => clearInterval(timer),
  };
}

// ---------------------------------------------------------------- the places

/** How a place was given: under the floor, or with room (under the max and the loop's line). */
export type ReplayAdmission = 'floor' | 'room';
/** Why a place was refused: the max in flight, or the loop's utilization at or past its line, or not read yet. */
export type ReplayRefusalWhy = 'max' | 'loop';
export const REPLAY_ADMISSION_OUTCOMES = Object.freeze(['floor', 'room', 'max', 'loop'] as const satisfies readonly (ReplayAdmission | ReplayRefusalWhy)[]);

/** A place held: given back once, by release (a second release does nothing). */
export interface ReplayPlace {
  readonly how: ReplayAdmission;
  /** The places in flight with this one, as it was given. */
  readonly inFlight: number;
  /** The loop's windowed utilization its admission read (null: unknown, or not read under the floor). */
  readonly utilization: number | null;
  release(): void;
}

/** A refusal, with what it read. */
export interface ReplayRefusal {
  readonly why: ReplayRefusalWhy;
  readonly inFlight: number;
  readonly max: number;
  readonly utilization: number | null;
  readonly eluMax: number;
}

export interface ReplayPlacesOptions {
  /** The loop's utilization at or past which no new replay is admitted (above 0, at most 1). */
  eluMax: number;
  /** The most replays in flight (a whole number from 1). */
  max: number;
  /** The places always admitted (default REPLAY_PLACES_FLOOR, never above `max`). */
  floor?: number;
  /** The loop's windowed utilization, null when unknown (a LoopWindow's read; a test's own). */
  loop: () => number | null;
  /** Each admission's or refusal's outcome, as it is decided (the metrics' count). */
  onOutcome?: (outcome: ReplayAdmission | ReplayRefusalWhy) => void;
}

/** A refusal in words, for a log line and the hand-back's reason. */
export function refusalWords(r: ReplayRefusal): string {
  if (r.why === 'max') return `${r.inFlight} replays in flight, its max ${r.max}`;
  if (r.utilization === null) return `the loop not read yet, so its floor alone (${r.inFlight} replays in flight)`;
  return `the loop busy ${r.utilization.toFixed(2)} of its last ${REPLAY_LOOP_WINDOW_MS / 1000} s, its line ${r.eluMax} (${r.inFlight} replays in flight)`;
}

/** One process's replay places (the header). */
export class ReplayPlaces {
  readonly eluMax: number;
  readonly max: number;
  readonly floor: number;
  readonly #loop: () => number | null;
  readonly #onOutcome: ((outcome: ReplayAdmission | ReplayRefusalWhy) => void) | undefined;
  #inFlight = 0;
  #lastRead: number | null = null;

  constructor(opts: ReplayPlacesOptions) {
    if (!(Number.isFinite(opts.eluMax) && opts.eluMax > 0 && opts.eluMax <= 1)) throw new RangeError(`a replay's loop line is above 0 and at most 1, got ${String(opts.eluMax)}`);
    if (!Number.isSafeInteger(opts.max) || opts.max < 1) throw new RangeError(`the most replays in flight is a whole number from 1, got ${String(opts.max)}`);
    const floor = opts.floor ?? REPLAY_PLACES_FLOOR;
    if (!Number.isSafeInteger(floor) || floor < 1) throw new RangeError(`the replay places' floor is a whole number from 1, got ${String(floor)}`);
    this.eluMax = opts.eluMax;
    this.max = opts.max;
    this.floor = Math.min(floor, opts.max);
    this.#loop = opts.loop;
    this.#onOutcome = opts.onOutcome;
  }

  /** The places held now. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** The loop's last windowed read an admission took (null before one, or unknown). */
  get lastRead(): number | null {
    return this.#lastRead;
  }

  /**
   * Ask once: a place (the floor's, or one with room), or why not. Never past the max; past the floor only on a loop read
   * under its line (a loop not read yet admits the floor alone).
   */
  ask(): { place: ReplayPlace } | { refused: ReplayRefusal } {
    if (this.#inFlight < this.floor) return { place: this.#give('floor', null) };
    if (this.#inFlight >= this.max) return { refused: this.#refuse('max', null) };
    const utilization = this.#read();
    if (utilization === null || utilization >= this.eluMax) return { refused: this.#refuse('loop', utilization) };
    return { place: this.#give('room', utilization) };
  }

  /**
   * A place, waited for: asked now and every `pollMs` until one is given, or `signal` aborts (its reason thrown). `onWait`
   * hears the first refusal, once, so its caller says it waits.
   */
  async wait(opts: { signal?: AbortSignal; pollMs?: number; onWait?: (r: ReplayRefusal) => void } = {}): Promise<ReplayPlace> {
    const pollMs = opts.pollMs ?? REPLAY_PLACE_POLL_MS;
    let waited = false;
    for (;;) {
      opts.signal?.throwIfAborted();
      const asked = this.ask();
      if ('place' in asked) return asked.place;
      if (!waited) opts.onWait?.(asked.refused);
      waited = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, pollMs);
        function done(): void {
          opts.signal?.removeEventListener('abort', aborted);
          resolve();
        }
        function aborted(): void {
          clearTimeout(timer);
          reject(opts.signal!.reason);
        }
        opts.signal?.addEventListener('abort', aborted, { once: true });
      });
    }
  }

  #read(): number | null {
    let read: number | null;
    try {
      read = this.#loop();
    } catch {
      read = null;
    }
    this.#lastRead = read !== null && Number.isFinite(read) ? Math.min(1, Math.max(0, read)) : null;
    return this.#lastRead;
  }

  #refuse(why: ReplayRefusalWhy, utilization: number | null): ReplayRefusal {
    this.#onOutcome?.(why);
    return { why, inFlight: this.#inFlight, max: this.max, utilization, eluMax: this.eluMax };
  }

  #give(how: ReplayAdmission, utilization: number | null): ReplayPlace {
    this.#inFlight += 1;
    heldAnywhere += 1;
    this.#onOutcome?.(how);
    const inFlight = this.#inFlight;
    let held = true;
    return {
      how,
      inFlight,
      utilization,
      release: () => {
        if (!held) return;
        held = false;
        this.#inFlight -= 1;
        heldAnywhere -= 1;
      },
    };
  }
}

/** The places held now across every ReplayPlaces of this process (replayLoopMeter's: it says its line only while one is). */
let heldAnywhere = 0;

// ---------------------------------------------------------------- a grade job's admission (server/jobs.ts `replay room`)

/** How long a phase's harness kind is kept once read (phaseKindCache): a bundle's harness never moves under a live phase. */
export const PHASE_KIND_KEEP_MS = 10 * 60_000;

/**
 * A phase's harness kind through `read` (null for a phase or bundle not found), each phase's answer kept PHASE_KIND_KEEP_MS
 * (a null one too), so a backlog of one phase's grades reads it once. A read that throws is kept nowhere and throws.
 */
export function phaseKindCache(read: (phaseId: string) => Promise<string | null>, opts: { keepMs?: number; now?: () => number; maxPhases?: number } = {}): (phaseId: string) => Promise<string | null> {
  const keepMs = opts.keepMs ?? PHASE_KIND_KEEP_MS;
  const now = opts.now ?? (() => Date.now());
  const maxPhases = opts.maxPhases ?? 4_096;
  const kept = new Map<string, { kind: string | null; at: number }>();
  return async (phaseId) => {
    const hit = kept.get(phaseId);
    if (hit !== undefined && now() - hit.at < keepMs) return hit.kind;
    const kind = await read(phaseId);
    if (kept.size >= maxPhases) kept.clear();
    kept.set(phaseId, { kind, at: now() });
    return kind;
  };
}

/**
 * JobQueueOptions.replayRoom over `places` (server/jobs.ts `replay room`): a grade-dev or grade-final job whose payload
 * runs a replay here (replayGradeRuns of its phase's harness kind, `kindOf`, and its kind; never a provisional rejudge)
 * is given a place or refused in words (refusalWords); any other job is answered null and asks nothing of the places.
 */
export function replayRoomOf(places: ReplayPlaces, kindOf: (phaseId: string) => Promise<string | null>): (queue: string, data: unknown) => Promise<ReplayRoomAnswer | null> {
  return async (_queue, data) => {
    const job = data as { phase_id?: unknown; kind?: unknown; rejudge?: unknown } | null;
    if (job === null || typeof job !== 'object' || typeof job.phase_id !== 'string' || job.rejudge !== undefined) return null;
    const kind = await kindOf(job.phase_id);
    if (kind === null || !replayGradeRuns(kind, typeof job.kind === 'string' ? job.kind : 'grade')) return null;
    const asked = places.ask();
    return 'place' in asked ? { place: asked.place } : { refused: refusalWords(asked.refused) };
  };
}

// ---------------------------------------------------------------- the process's places

let processPlaces: ReplayPlaces | null = null;
let processLoop: LoopWindow | null = null;

/**
 * This process's replay places, made on first use from MAKEFUN_REPLAY_ELU_MAX and MAKEFUN_REPLAY_CONCURRENCY_MAX (as
 * server/config.ts parses them; a value it would refuse at boot is taken as its default here, said), over a LoopWindow
 * started then: a grader makes them at its boot (server/pipeline/index.ts startWorkers), so its window is filling before
 * its first grade; a process that never grades a replay samples nothing. Its metrics are registered then too.
 */
export function processReplayPlaces(env: NodeJS.ProcessEnv = process.env): ReplayPlaces {
  if (processPlaces !== null) return processPlaces;
  const eluMax = parseReplayEluMax(env.MAKEFUN_REPLAY_ELU_MAX);
  const max = parseReplayConcurrencyMax(env.MAKEFUN_REPLAY_CONCURRENCY_MAX);
  if (eluMax === null) console.warn(`[replay] MAKEFUN_REPLAY_ELU_MAX ${JSON.stringify(env.MAKEFUN_REPLAY_ELU_MAX)} is no share above 0 and at most 1: ${DEFAULT_REPLAY_ELU_MAX} is used`);
  if (max === null) console.warn(`[replay] MAKEFUN_REPLAY_CONCURRENCY_MAX ${JSON.stringify(env.MAKEFUN_REPLAY_CONCURRENCY_MAX)} is no whole number from 1 to ${MAX_REPLAY_CONCURRENCY_MAX}: ${DEFAULT_REPLAY_CONCURRENCY_MAX} is used`);
  processLoop = loopWindow();
  const loop = processLoop;
  processPlaces = new ReplayPlaces({ eluMax: eluMax ?? DEFAULT_REPLAY_ELU_MAX, max: max ?? DEFAULT_REPLAY_CONCURRENCY_MAX, loop: () => loop.read(), onOutcome: (outcome) => countAdmission(outcome) });
  void registerReplayMetrics((line) => console.warn(line));
  return processPlaces;
}

// ---------------------------------------------------------------- one execution's loop time

/**
 * The main thread's time over one replay execution (grader/grade.ts executeOnce): started as it starts, `end` observes
 * the loop's busy seconds over it on makefun_replay_execution_loop_busy_seconds{kind} and, while a replay place is held
 * in this process (a grader's grade or stress, never a CLI's grade), says one line: its wall, the loop's busy ms over
 * it and its share, and the replays in flight here. The busy time is the whole loop's, every replay in flight sharing
 * it, so a line reads it beside the count. Never throws.
 */
export function replayLoopMeter(kind: string, label: string, log: (line: string) => void = (line) => console.log(line)): { end(status: string): void } {
  const startedAt = performance.now();
  const start = performance.eventLoopUtilization();
  const inFlightAtStart = processPlaces?.inFlight ?? 0;
  return {
    end: (status: string) => {
      try {
        const span = performance.eventLoopUtilization(performance.eventLoopUtilization(), start);
        const wallMs = performance.now() - startedAt;
        observeExecutionLoop(kind, span.active / 1000);
        if (heldAnywhere === 0) return;
        const inFlight = processPlaces?.inFlight ?? heldAnywhere;
        log(
          `[replay] ${label} (${kind}) ${status} in ${Math.round(wallMs)} ms: this process's event loop was busy ${Math.round(span.active)} ms of it (${span.utilization.toFixed(2)}), ${inFlightAtStart} replays in flight here as it began and ${inFlight} as it ended`,
        );
      } catch {
        // A meter's fault is never the execution's.
      }
    },
  };
}

// ---------------------------------------------------------------- metrics

export const REPLAY_METRICS = Object.freeze({
  inFlight: 'makefun_replay_places_in_flight',
  loop: 'makefun_replay_loop_utilization',
  admissions: 'makefun_replay_admissions_total',
  executionLoop: 'makefun_replay_execution_loop_busy_seconds',
});
const EXECUTION_LOOP_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800] as const;

/** What was counted before the metrics were registered, added at registration. */
const tally = { admissions: new Map<string, number>(), loops: [] as Array<[string, number]> };
let registered: { admission: (outcome: string) => void; loop: (kind: string, seconds: number) => void } | null = null;
let registering: Promise<void> | null = null;

function countAdmission(outcome: ReplayAdmission | ReplayRefusalWhy): void {
  if (registered !== null) registered.admission(outcome);
  else tally.admissions.set(outcome, (tally.admissions.get(outcome) ?? 0) + 1);
}

function observeExecutionLoop(kind: string, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  if (registered !== null) registered.loop(kind, seconds);
  else if (tally.loops.length < 1_000) tally.loops.push([kind, seconds]);
}

/**
 * Register the replay metrics on the process's registry (server/ops/metrics.ts metricsRegistry), once a process: imported
 * here, not at the top, since the metrics module starts collectors at import (grader/sandbox/agent-client.ts
 * registerAgentMetrics does the same). A failure is said and drops only the metrics.
 */
export function registerReplayMetrics(warn: (line: string) => void): Promise<void> {
  registering ??= (async () => {
    try {
      const [{ metricsRegistry }, { Counter, Gauge, Histogram }] = await Promise.all([import('../server/ops/metrics.ts'), import('@prometheus-io/client')]);
      if (metricsRegistry.getSingleMetric(REPLAY_METRICS.admissions) !== undefined) return;
      new Gauge({
        name: REPLAY_METRICS.inFlight,
        help: "Replay grades holding a replay place in this process now (grader/replay-places.ts): their sim engines step on this process's main thread.",
        registers: [metricsRegistry],
        collect() {
          this.set(processPlaces?.inFlight ?? 0);
        },
      });
      new Gauge({
        name: REPLAY_METRICS.loop,
        help: "This process's event loop utilization over its last 10 s as the replay places last read it (0 to 1; MAKEFUN_REPLAY_ELU_MAX is the line past which no new replay is admitted).",
        registers: [metricsRegistry],
        collect() {
          this.set(processPlaces?.lastRead ?? 0);
        },
      });
      const admissions = new Counter({
        name: REPLAY_METRICS.admissions,
        help: 'Replay place asks by outcome: floor (admitted under the floor), room (admitted under the max and the loop line); max or loop (refused, the loop at or past its line or not read yet: its grade handed back, or the dev stress asks again 2 s on, each ask counted).',
        labelNames: ['outcome'] as const,
        registers: [metricsRegistry],
      });
      for (const outcome of REPLAY_ADMISSION_OUTCOMES) admissions.inc({ outcome }, tally.admissions.get(outcome) ?? 0);
      const loop = new Histogram({
        name: REPLAY_METRICS.executionLoop,
        help: "This process's event loop busy time over one replay execution (grader/grade.ts executeOnce), by harness kind: the whole loop's, shared by every replay in flight.",
        labelNames: ['kind'] as const,
        buckets: [...EXECUTION_LOOP_BUCKETS],
        registers: [metricsRegistry],
      });
      registered = { admission: (outcome) => admissions.inc({ outcome }), loop: (kind, seconds) => loop.observe({ kind }, seconds) };
      tally.admissions.clear();
      for (const [kind, seconds] of tally.loops.splice(0)) registered.loop(kind, seconds);
    } catch (err) {
      warn(`[replay] the replay place metrics could not be registered (the places run unmeasured): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return registering;
}
