// The replay engine's turn per execution, said and measured on the grader's server path (grader/run.ts executeLockstep,
// its header's engine turn): the sum of the bot's clock's pauses over a lockstep replay execution (pumpfun-replay/v2,
// bars-replay/v1, clmm-replay/v1), its total wall less the bot's own turns, so the next diagnosis sees how much of a
// replay's wall went to the engine and the grader's event loop rather than to the bot.
//
//   replayEngineTurnObserver   the observer (run.ts LockstepEndObserver): one line per execution, and the histogram
//   enableReplayEngineTurns    makes it the process's (replayEngineObserver), once, in the grader's server process:
//                              grader/worker.ts createGradeHandler calls it (only server/pipeline/index.ts builds one)
//   replayEngineObserver       the process's observer, or undefined: grader/grade.ts executeOnce hands it to each run
//
// The line (replayEngineEndLine), on stdout: `[replay] <label> (<harness>) <status>: wall_ms=… bot_ms=… engine_turn_ms=…`,
// status an ExecutionStatus, `backstop` (WallBackstopError) or `fault` (any other harness fault, thrown). The metric:
// makefun_replay_engine_turn_seconds{kind} (REPLAY_ENGINE_TURN_METRIC), kind the harness as
// makefun_replay_execution_loop_busy_seconds{kind} names it, one observation per execution whose program started,
// registered on the process's registry (server/ops/metrics.ts metricsRegistry) at the first observation, imported then
// and not at the top as grader/sandbox/k8s.ts registerPaceMetrics does (the metrics module starts collectors at import).
// A process that never enables it (a CLI: cli/grade-local.ts's --json stdout; a test) says nothing and imports nothing
// of it. Neither the line nor the metric touches an Execution, its action log or its score.

import type { Histogram } from '@prometheus-io/client';
import type { LockstepEndObserver, LockstepExecutionEnd } from './run.ts';

/** The engine-turn histogram's name (the header), by kind. */
export const REPLAY_ENGINE_TURN_METRIC = 'makefun_replay_engine_turn_seconds';
/** Its buckets, in seconds: a quiet replay's turns run to seconds over an execution, a pinned grader's to many minutes. */
export const REPLAY_ENGINE_TURN_BUCKETS: readonly number[] = Object.freeze([0.05, 0.25, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600]);
/** Observations held while the metric registers: past this many, the rest are dropped (the metric only, never the line). */
const HELD_MAX = 4_096;

let held: Array<[kind: string, seconds: number]> = [];
let observe: ((kind: string, seconds: number) => void) | null = null;
let registering: Promise<void> | null = null;
let processObserver: LockstepEndObserver | undefined;

/** The end line (the header). */
export function replayEngineEndLine(e: LockstepExecutionEnd): string {
  return `[replay] ${e.label} (${e.harness}) ${e.status}: wall_ms=${e.wall_ms} bot_ms=${e.bot_ms} engine_turn_ms=${e.engine_turn_ms}`;
}

/**
 * Register the engine-turn histogram on the process's registry (server/ops/metrics.ts metricsRegistry), once a process,
 * the observations made before it added at once (the header). A failure is said and drops only the metric.
 */
export function registerReplayEngineMetrics(warn: (line: string) => void = (line) => console.warn(line)): Promise<void> {
  registering ??= (async () => {
    try {
      const [{ metricsRegistry }, prom] = await Promise.all([import('../server/ops/metrics.ts'), import('@prometheus-io/client')]);
      const histogram =
        (metricsRegistry.getSingleMetric(REPLAY_ENGINE_TURN_METRIC) as Histogram<'kind'> | undefined) ??
        new prom.Histogram({
          name: REPLAY_ENGINE_TURN_METRIC,
          help: "A lockstep replay execution's engine turns (grader/run.ts executeLockstep), by kind (the harness): the sum of the bot's clock's pauses, its total wall less the bot's own turns: spawn to the first batch's write and each reply's arrival to the next write (submit, nextBatch, encode, and every stall of the grader's event loop between). One observation per execution whose program started.",
          labelNames: ['kind'] as const,
          buckets: [...REPLAY_ENGINE_TURN_BUCKETS],
          registers: [metricsRegistry],
        });
      observe = (kind, seconds) => histogram.observe({ kind }, seconds);
      for (const [kind, seconds] of held.splice(0)) observe(kind, seconds);
    } catch (err) {
      held = [];
      observe = () => undefined;
      warn(`[replay] the engine-turn metric could not be registered (executions run unmeasured): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return registering;
}

/** One execution's engine turn into the histogram, held until it registers (the header). */
function observeTurn(kind: string, seconds: number, warn: (line: string) => void): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  if (observe !== null) {
    observe(kind, seconds);
    return;
  }
  if (held.length < HELD_MAX) held.push([kind, seconds]);
  void registerReplayEngineMetrics(warn);
}

/** The observer (the header): says each execution's end line on `log` and, when its program started, observes its engine turn. */
export function replayEngineTurnObserver(
  log: (line: string) => void = (line) => console.log(line),
  warn: (line: string) => void = (line) => console.warn(line),
): LockstepEndObserver {
  return (e) => {
    log(replayEngineEndLine(e));
    if (e.wall_ms > 0) observeTurn(e.harness, e.engine_turn_ms / 1000, warn);
  };
}

/**
 * Make replayEngineTurnObserver the process's (replayEngineObserver), once; later calls keep the first. The grader's
 * server process calls it at boot; a CLI never does (the header).
 */
export function enableReplayEngineTurns(o: { log?: (line: string) => void; warn?: (line: string) => void } = {}): void {
  processObserver ??= replayEngineTurnObserver(o.log, o.warn);
}

/** The process's observer (enableReplayEngineTurns), or undefined in a process that never enabled one. */
export function replayEngineObserver(): LockstepEndObserver | undefined {
  return processObserver;
}

/** Tests only: drop the process's observer, as a process that never enabled one (the metric, once registered, stays). */
export function resetReplayEngineTurns(): void {
  processObserver = undefined;
}
