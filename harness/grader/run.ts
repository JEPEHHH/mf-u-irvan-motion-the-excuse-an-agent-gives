// One execution of a replay entry: the bot in its sandbox, a sim engine (trusted, in this process)
// on the other end of stdin/stdout, in lockstep. executeLockstep drives any engine of the lockstep
// shape (sim/bars/engine.ts LockstepEngine) over its protocol's line codec (LockstepProtocol):
//
//   pumpfun-replay/v2   executeReplay: sim/engine.ts ReplayEngine, contracts/protocol.ts (slot batches)
//   bars-replay/v1      grader/harnesses.ts barsPlan: sim/bars/engine.ts BarsEngine,
//                       contracts/bars-protocol.ts (one batch per bar close)
//
//   hello -> bot;  for each batch: batch -> bot, exactly one reply line back, engine.submit;
//   done -> bot, stdin closed, the bot exits on its own
//
// Limits (each a bot failure: status `failed`, no action log, no score):
//   - a stdout line over MAX_BOT_LINE_BYTES (64 KiB), not strict UTF-8, not JSON, not a zod-strict
//     reply of the protocol (protocol.parseLine), echoing the wrong seq, or arriving when no reply is
//     expected (out of lockstep); stdout after done; the program exiting before done
//   - a reply with more than protocol.replyOrderCap(hello) orders (pump: contracts/protocol.ts
//     replyOrderCap, max(64, 4x hello.caps.max_orders_per_batch); bars: contracts/bars-protocol.ts
//     barsReplyOrderCap, max(64, 4x max_orders_per_bar); orders past the per-batch cap but within it
//     are logged and rejected one by one by the replay, as each protocol says), and replies totalling
//     more than MAX_ACTION_LOG_REPLY_BYTES (the action log is held in memory and hashed)
// The pump replay's failed-tx draw's key (engine.failKey) stays in this process: hello carries only
// the seed.
//   - stderr over MAX_STDERR_BYTES (1 MiB)
// Wall budget: limits.wall_budget_sec of the bot's own turns, on the bot's clock (sandbox/io.ts Supervisor's Turns):
// it runs from a batch's write until the bot's reply line arrives, and from done's write until the bot exits. The
// engine's turns are never charged: from the program's start (spawn, or under the k8s sandbox the exec's start
// line, so pod scheduling is never charged either) until the first batch is written (hello is the engine's), and
// from each reply's arrival until the next batch (or done) is written (submit, nextBatch, encode, and whatever stall
// the grader's event loop puts between them). Exhausted at any point before the bot has exited: status `timeout`,
// nothing scored (never a partial score). Finished with more than half of it used: flag `wall_budget_over_half`.
// wall_ms is the execution's total wall all the same, every turn included. A bot still running EXIT_GRACE_MS after
// done is killed and flagged `killed_after_done`; one exiting non-zero after done is flagged
// `nonzero_exit_after_done` (the action log was already complete in both cases).
// The backstop: an execution whose total wall passes LOCKSTEP_WALL_BACKSTOP_FACTOR (2) x the wall budget with the
// bot's clock under budget spent the rest on the engine's turns: the bot is killed and a WallBackstopError (a
// SandboxError) is thrown, a harness fault, so its grade is retried and the entrant never charged a `timeout`.
// The engine's turn (measured, never charged, never scored): the sum of the bot's clock's pauses over the execution,
// its total wall less the bot's clock (Supervisor wallMs - elapsedMs): spawn (or the k8s start line) to the first
// batch's write, and each reply's arrival to the next write (submit, nextBatch, encode, every loop stall between). At
// each execution's end, whatever its outcome (a thrown harness fault too), executeLockstep hands it, beside the total
// wall and the bot's clock, to the caller's observer (LockstepExecutionOptions.onExecutionEnd: LockstepExecutionEnd),
// once, an observer's throw swallowed so it never reaches the run. It says and imports nothing itself: the grader's
// server process observes it (grader/replay-engine-metrics.ts enableReplayEngineTurns: the end line and
// makefun_replay_engine_turn_seconds{kind}, handed in by grader/grade.ts executeOnce through the plan's
// ExecuteContext.onExecutionEnd); a CLI or a test that enables or hands none gets nothing. It never touches the
// Execution, its action log or its score.
// Harness faults are thrown, never blamed on the bot: a dataset the engine refuses (SimDataError), a
// sim invariant failing or any run the engine aborts (SimAbortError: the bars replay's lookahead
// audit, finding a batch that would show the bot a later bar, withholds it and aborts, so a
// lookahead is retried as the engine's fault and never scored), the sandbox driver failing
// (SandboxError), the total-wall backstop (WallBackstopError, a SandboxError). A program whose k8s pod never ran because the node had no room for it (k8s.ts noRoomOf) is
// thrown as a NodeRoomError, still a SandboxError, so its job is handed back for later instead of spending a
// retry (server/jobs.ts's `node room`). One whose own last call of the control plane met a fault (k8s.ts controlPlaneOf:
// the API server unreachable or shedding; no exec crosses it) is thrown as an
// ExecUnstartedError, a SandboxError too, its grade handed back the same way (server/jobs.ts's `control plane`).
//
// Entry secrets (SandboxRunOptions.secrets): an entrant's env-lane entry secrets, NAME to value
// (contracts/entry-secrets.ts; grader/worker.ts opens them), handed to the bot's sandbox as its spec's
// `secrets` (variables of the bot's own process, carried out of band by every driver: sandbox/types.ts
// checkSandboxSecrets, which also refuses a provider-lane name, so no provider key ever reaches a
// non-agent sandbox). Never the scorer's, and never a race's. Every form of every value
// (entrySecretForms: grader/gateway/upstream.ts secretFormSet) is masked out of what an execution says
// and keeps: its stderr capture (maskStderr, SECRET_MARK, the whole capture before any cut, and a capture
// the cap cut keeps nothing of a form the cut may have split), its error (redactSecrets, REDACTED_MARK),
// and the stderr tail a SandboxError quotes. The action log is never masked: it is scored and compared
// byte for byte, so grader/worker.ts scans it for the values instead (secret_in_output).

import type { z } from 'zod';
import { LOCKSTEP_WALL_BACKSTOP_FACTOR, type Limits } from '../contracts/competition.ts';
import { MAX_BOT_LINE_BYTES, parseBotLine, replyOrderCap, type BatchT, type DoneT, type HelloT, type ReplyT } from '../contracts/protocol.ts';
import type { LockstepEngine } from '../sim/bars/engine.ts';
import { canonicalJson, sha256Hex } from '../sim/canonical.ts';
import { encodeHarnessLine, ReplayEngine, SimAbortError, SimProtocolError, type ActionLogT, type EngineOptions, type ReplayDataset } from '../sim/engine.ts';
import { BytesMasker, maskText, type FormSet } from './gateway/secret-mask.ts';
import { REDACTED_MARK, secretFormSet } from './gateway/upstream.ts';
import { describeExit, Stopped, Supervisor } from './sandbox/io.ts';
import { controlPlaneOf, ExecUnstartedError, NodeRoomError, noRoomOf } from './sandbox/k8s.ts';
import { SandboxError, type Runtime, type Sandbox, type SandboxExit, type SandboxProcess, type SandboxSpec } from './sandbox/types.ts';

export type LimitsT = z.infer<typeof Limits>;

export const MAX_STDERR_BYTES = 1_048_576;
export const MAX_ACTION_LOG_REPLY_BYTES = 128 * 1024 * 1024;
export const EXIT_GRACE_MS = 5_000;
export const WALL_BUDGET_OVER_HALF = 'wall_budget_over_half';
export const KILLED_AFTER_DONE = 'killed_after_done';
export const NONZERO_EXIT_AFTER_DONE = 'nonzero_exit_after_done';

/**
 * A lockstep execution's total wall passed its backstop (the header's backstop: LOCKSTEP_WALL_BACKSTOP_FACTOR x the wall
 * budget) with the bot's own clock under budget: the time went to the engine's turns, so it is the harness's fault, a
 * SandboxError (retried, never the bot's `timeout`).
 */
export class WallBackstopError extends SandboxError {
  /** The execution's total wall, and the bot's own clock, in ms, when it was stopped. */
  readonly wallMs: number;
  readonly botMs: number;
  constructor(message: string, wallMs: number, botMs: number) {
    super(message);
    this.name = 'WallBackstopError';
    this.wallMs = wallMs;
    this.botMs = botMs;
  }
}

/** The most orders one reply may carry before it is a protocol violation (contracts/protocol.ts). */
export { replyOrderCap };

export type ExecutionStatus = 'ok' | 'timeout' | 'failed';

/** One execution of an entry, harness-independent. */
export interface Execution<Log = unknown> {
  status: ExecutionStatus;
  /** Why it failed or timed out; null when ok. */
  error: string | null;
  /** The action log (ok only). */
  log: Log | null;
  /** Its RFC 8785 canonical JSON, and that text's sha256 (ok only). */
  log_json: string | null;
  log_sha256: string | null;
  wall_ms: number;
  flags: string[];
  /** Captured stderr (at most MAX_STDERR_BYTES). */
  stderr: Buffer;
  exit: SandboxExit | null;
}

/** Where and how long an execution runs, whatever the harness. */
export interface SandboxRunOptions {
  sandbox: Sandbox;
  runtime: Runtime;
  /** Host directory mounted read-only at /bot: a freshly materialized snapshot. */
  botDir: string;
  limits: LimitsT;
  /** Container name stem. */
  label?: string;
  /** Run this image digest instead of the pinned one (L2). */
  imageDigest?: string | null;
  exitGraceMs?: number;
  /**
   * The entrant's env-lane entry secrets, NAME to value (the header's entry secrets): the bot's sandbox spec's `secrets`,
   * masked out of its stderr, its error and every tail a SandboxError quotes. Absent or empty: none.
   */
  secrets?: Readonly<Record<string, string>>;
}

/** `secrets` as a sandbox spec takes them (SandboxSpec.secrets): absent when there are none, so a spec with none is what it always was. */
export function specSecrets(secrets: Readonly<Record<string, string>> | undefined): Pick<SandboxSpec, 'secrets'> {
  return secrets === undefined || Object.keys(secrets).length === 0 ? {} : { secrets };
}

/**
 * Every form of every value of `secrets` (grader/gateway/upstream.ts secretFormSet: secret-mask.ts secretForms of each,
 * and the value itself), compiled once; null when there are none, so a run with none masks nothing.
 */
export function entrySecretForms(secrets: Readonly<Record<string, string>> | undefined): FormSet | null {
  const values = secrets === undefined ? [] : Object.values(secrets).filter((v) => v !== '');
  return values.length === 0 ? null : secretFormSet(values);
}

/**
 * A stderr capture with every form in `forms` replaced by SECRET_MARK (secret-mask.ts BytesMasker), the whole capture at
 * once. A capture of MAX_STDERR_BYTES or more is one the cap cut (sandbox/io.ts Supervisor): its tail that could still
 * begin a form (the masker's held bytes) is dropped, so a value the cut split leaves no prefix of itself behind.
 */
export function maskStderr(stderr: Buffer, forms: FormSet | null): Buffer {
  if (forms === null || stderr.length === 0) return stderr;
  const masker = new BytesMasker(forms);
  const head = Buffer.from(masker.push(stderr));
  if (stderr.length >= MAX_STDERR_BYTES) return head;
  const tail = masker.end();
  return tail.length === 0 ? head : Buffer.concat([head, tail]);
}

/** `text` with every form in `forms` replaced by REDACTED_MARK (a message's own redaction); `text` itself with none. */
export function redactSecrets(text: string, forms: FormSet | null): string {
  return forms === null || forms.forms.length === 0 ? text : maskText(text, forms, REDACTED_MARK);
}

/** An execution as it may be kept and said (the header's entry secrets): its error redacted and its stderr masked of `forms`. */
export function maskExecution<Log>(e: Execution<Log>, forms: FormSet | null): Execution<Log> {
  if (forms === null) return e;
  return { ...e, error: e.error === null ? null : redactSecrets(e.error, forms), stderr: maskStderr(e.stderr, forms) };
}

export interface ReplayExecutionOptions extends SandboxRunOptions {
  /** The dataset, already reduced to the universe (filterUniverse). */
  dataset: ReplayDataset;
  hello: HelloT;
  /** schemaCheck, and failKey: the failed-tx draw's key, which stays in this process (never in hello). */
  engine?: Pick<EngineOptions, 'schemaCheck' | 'failKey'>;
  /** Told once at the execution's end, under harness `pumpfun-replay/v2` (LockstepExecutionOptions.onExecutionEnd). */
  onExecutionEnd?: LockstepEndObserver;
}

/** A protocol's line codec, as the lockstep driver needs it. */
export interface LockstepProtocol<Hello, Batch, Done, Reply extends { orders: readonly unknown[] }> {
  /** One harness message as the `\n`-terminated line written to the bot (an oversized one is a harness fault, thrown). */
  encode(msg: Hello | Batch | Done): string;
  /** One line the bot wrote: its reply, or why it is a protocol violation; never throws. */
  parseLine(line: string): { ok: true; reply: Reply } | { ok: false; reason: string };
  /** The most orders one reply may carry before it is a protocol violation. */
  replyOrderCap(hello: Hello): number;
}

/** What a finished lockstep run must carry: whether it aborted, and the action log to keep. */
export interface LockstepRun<Log> {
  aborted: string | null;
  action_log: Log;
}

export interface LockstepExecutionOptions<Hello, Batch extends { seq: number }, Done, Reply extends { orders: readonly unknown[] }, Log> extends SandboxRunOptions {
  /** A fresh engine for this execution (its hello is the first line the bot reads). */
  engine: LockstepEngine<Hello, Batch, Done, LockstepRun<Log>>;
  protocol: LockstepProtocol<Hello, Batch, Done, Reply>;
  /** The harness kind its end is said under (the header's engine turn; LockstepExecutionEnd.harness); absent: LOCKSTEP_HARNESS. */
  harness?: string;
  /** Told once at the execution's end (the header's engine turn); its throw is swallowed. Absent: nothing is told. */
  onExecutionEnd?: LockstepEndObserver;
}

/** How a lockstep execution ended (the header's engine turn): an ExecutionStatus, `backstop` (WallBackstopError) or `fault` (any other harness fault, thrown). */
export type LockstepOutcome = ExecutionStatus | 'backstop' | 'fault';

/** A lockstep execution's end (the header's engine turn): its clocks in whole ms; `wall_ms` 0 when its program never started. */
export interface LockstepExecutionEnd {
  /** The run options' label (the container name stem; default `replay`). */
  label: string;
  harness: string;
  status: LockstepOutcome;
  wall_ms: number;
  bot_ms: number;
  engine_turn_ms: number;
}

/** An observer of lockstep executions' ends (LockstepExecutionOptions.onExecutionEnd). */
export type LockstepEndObserver = (e: LockstepExecutionEnd) => void;

/** The pump replay's line codec (contracts/protocol.ts, sim/engine.ts). */
export const REPLAY_LOCKSTEP: LockstepProtocol<HelloT, BatchT, DoneT, ReplyT> = { encode: encodeHarnessLine, parseLine: parseBotLine, replyOrderCap };

/** The harness an execution whose caller named none is said under (LockstepExecutionOptions.harness). */
export const LOCKSTEP_HARNESS = 'lockstep';

/** An execution's clocks at its end (the header's engine turn), in whole ms: total wall, the bot's turns, the engine's. */
export interface LockstepTimes {
  wall_ms: number;
  bot_ms: number;
  engine_turn_ms: number;
}

/** `sup`'s clocks as an execution's end reads them: the engine's turn is every pause of the bot's clock (wall less the bot's). */
export function lockstepTimes(sup: Pick<Supervisor, 'wallMs' | 'elapsedMs'>): LockstepTimes {
  const wall = sup.wallMs();
  const bot = sup.elapsedMs();
  return { wall_ms: Math.round(wall), bot_ms: Math.round(bot), engine_turn_ms: Math.max(0, Math.round(wall - bot)) };
}

/** A finished execution's record, given its log (or none); its error and stderr masked of `forms` (the header's entry secrets), the log never. */
export function executionOf<Log>(
  status: ExecutionStatus,
  error: string | null,
  log: Log | null,
  sup: Supervisor,
  flags: string[],
  forms: FormSet | null = null,
): Execution<Log> {
  // wall_ms the total wall; the over-half flag on the budget's own clock (the bot's turns, on a lockstep run: the header).
  const wall = Math.round(sup.wallMs());
  const outFlags = [...flags];
  if (status === 'ok' && Math.round(sup.elapsedMs()) * 2 > sup.budgetMs) outFlags.push(WALL_BUDGET_OVER_HALF);
  const json = status === 'ok' && log !== null ? canonicalJson(log) : null;
  return maskExecution(
    {
      status,
      error,
      log: status === 'ok' ? log : null,
      log_json: json,
      log_sha256: json === null ? null : sha256Hex(json),
      wall_ms: wall,
      flags: [...new Set(outFlags)].sort(),
      stderr: sup.stderr(),
      exit: sup.exit,
    },
    forms,
  );
}

/** The last lines of a stderr capture, for an error message: masked of `forms` as a whole before it is cut (maskStderr), so the cut never splits a value. */
export function stderrTail(buf: Buffer, max = 500, forms: FormSet | null = null): string {
  const text = maskStderr(buf, forms).toString('utf8').trim();
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

/**
 * The driver's failure running `proc` as thrown (the header's harness faults): a NodeRoomError when its k8s pod never
 * ran because the node had no room for it (k8s.ts noRoomOf: backpressure, its job handed back), an ExecUnstartedError when
 * its own last call of the control plane met a fault (k8s.ts controlPlaneOf: its job handed back too), else a
 * SandboxError. Neither is read off `message`, which may quote what the program wrote.
 */
export function driverFailure(proc: SandboxProcess, message: string): SandboxError {
  const noRoom = noRoomOf(proc);
  if (noRoom !== null) return new NodeRoomError(message, noRoom);
  const fault = controlPlaneOf(proc);
  return fault === null ? new SandboxError(message) : new ExecUnstartedError(message, fault);
}

/** Execute a pumpfun-replay/v2 entry once (executeLockstep over the pump engine). Bot failures and timeouts are returned; harness faults are thrown. */
export async function executeReplay(opts: ReplayExecutionOptions): Promise<Execution<ActionLogT>> {
  const failKey = opts.engine?.failKey;
  return executeLockstep({ ...opts, engine: new ReplayEngine(opts.dataset, opts.hello, { schemaCheck: opts.engine?.schemaCheck ?? true, ...(failKey === undefined ? {} : { failKey }) }), protocol: REPLAY_LOCKSTEP, harness: 'pumpfun-replay/v2' });
}

/**
 * Execute an entry once against a lockstep engine over its protocol (see the header). Bot failures
 * and timeouts are returned; harness faults (a dataset the engine refuses, a broken sim invariant,
 * the sandbox driver failing) are thrown.
 */
export async function executeLockstep<Hello, Batch extends { seq: number }, Done, Reply extends { orders: readonly unknown[] }, Log>(
  opts: LockstepExecutionOptions<Hello, Batch, Done, Reply, Log>,
): Promise<Execution<Log>> {
  const { engine, protocol } = opts;
  const cap = protocol.replyOrderCap(engine.hello);
  // The entrant's env-lane secrets (the header's entry secrets): the bot's own variables, masked out of all it says here.
  const forms = entrySecretForms(opts.secrets);
  const proc = opts.sandbox.spawn({
    runtime: opts.runtime,
    codeDir: opts.botDir,
    limits: opts.limits,
    label: opts.label ?? 'replay',
    imageDigest: opts.imageDigest ?? null,
    ...specSecrets(opts.secrets),
  });
  // The bot's clock (the header's wall budget): paused from the start (the engine's turn until the first batch is
  // written), paused again the moment each reply arrives, resumed at each batch's and done's write.
  const budgetMs = opts.limits.wall_budget_sec * 1000;
  const sup = new Supervisor(proc, {
    budgetMs,
    paused: true,
    pauseOnLine: true,
    backstopMs: LOCKSTEP_WALL_BACKSTOP_FACTOR * budgetMs,
    maxStderrBytes: MAX_STDERR_BYTES,
    stdout: { mode: 'lines', maxLineBytes: MAX_BOT_LINE_BYTES },
  });
  const flags: string[] = [];
  let replyBytes = 0;
  let awaitingSeq: number | null = null;
  // How it ended, for its observer (the header's engine turn): every return passes through ended(); a throw stays `fault`.
  let outcome: LockstepOutcome = 'fault';
  const ended = (e: Execution<Log>): Execution<Log> => {
    outcome = e.status;
    return e;
  };
  try {
    await sup.write(protocol.encode(engine.hello));
    for (let b = engine.nextBatch(); b !== null; b = engine.nextBatch()) {
      const line = protocol.encode(b);
      awaitingSeq = b.seq;
      sup.expectLine();
      sup.resume();
      await sup.write(line);
      // Its arrival paused the bot's clock (pauseOnLine): from here to the next write is the engine's turn.
      const text = await sup.nextLine();
      replyBytes += Buffer.byteLength(text, 'utf8');
      if (replyBytes > MAX_ACTION_LOG_REPLY_BYTES) throw sup.violate(`replies passed ${MAX_ACTION_LOG_REPLY_BYTES} bytes in total`);
      const parsed = protocol.parseLine(text);
      if (!parsed.ok) throw sup.violate(`reply to batch ${b.seq}: ${parsed.reason}`);
      if (parsed.reply.orders.length > cap) throw sup.violate(`reply to batch ${b.seq} carries ${parsed.reply.orders.length} orders (max ${cap})`);
      try {
        engine.submit(parsed.reply);
      } catch (err) {
        if (err instanceof SimProtocolError) throw sup.violate(`reply to batch ${b.seq}: ${err.message}`);
        throw err;
      }
      awaitingSeq = null;
    }
    const { done, run } = engine.finish();
    if (run.aborted !== null) throw new SimAbortError(`replay aborted: ${run.aborted}`);
    const doneLine = protocol.encode(done);
    // From done's write to the exit is the bot's turn.
    sup.resume();
    await sup.write(doneLine);
    sup.closeStdin();
    const exitGrace = opts.exitGraceMs ?? EXIT_GRACE_MS;
    const remaining = sup.remainingMs();
    const exit = await sup.waitExit(Math.max(0, Math.min(exitGrace, remaining)));
    if (exit === 'grace') {
      if (remaining <= exitGrace) {
        await sup.kill();
        return ended(executionOf<Log>('timeout', 'the wall budget ran out waiting for the bot to exit after done', null, sup, flags, forms));
      }
      flags.push(KILLED_AFTER_DONE);
      await sup.kill();
    } else {
      if (opts.sandbox.isDriverFailure(exit)) throw driverFailure(proc, `the sandbox failed after done (${describeExit(exit)}): ${stderrTail(sup.stderr(), undefined, forms)}`);
      if (exit.code !== 0) flags.push(NONZERO_EXIT_AFTER_DONE);
    }
    return ended(executionOf('ok', null, run.action_log, sup, flags, forms));
  } catch (err) {
    await sup.kill();
    if (!(err instanceof Stopped)) throw err;
    const r = err.reason;
    if (r.kind === 'timeout' && r.clock === 'total') {
      const wall = Math.round(sup.wallMs());
      const bot = Math.round(sup.elapsedMs());
      outcome = 'backstop';
      throw new WallBackstopError(
        `the execution's total wall passed its backstop (${wall} ms, over ${LOCKSTEP_WALL_BACKSTOP_FACTOR} x the ${opts.limits.wall_budget_sec} s wall budget) with the bot's own turns at ${bot} ms: the harness's turns took the rest`,
        wall,
        bot,
      );
    }
    if (r.kind === 'timeout') return ended(executionOf<Log>('timeout', 'the wall budget ran out', null, sup, flags, forms));
    if (r.kind === 'violation') return ended(executionOf<Log>('failed', `protocol violation: ${r.message}`, null, sup, flags, forms));
    if (opts.sandbox.isDriverFailure(r.exit)) throw driverFailure(proc, `the sandbox failed (${describeExit(r.exit)}): ${stderrTail(sup.stderr(), undefined, forms)}`);
    const when = awaitingSeq === null ? 'before done' : `before replying to batch ${awaitingSeq}`;
    return ended(executionOf<Log>('failed', `the bot exited ${when} (${describeExit(r.exit)})`, null, sup, flags, forms));
  } finally {
    // The engine's turn, told whatever the outcome (the header's engine turn); never the Execution's, never a throw into the run.
    if (opts.onExecutionEnd !== undefined) {
      try {
        opts.onExecutionEnd({ label: opts.label ?? 'replay', harness: opts.harness ?? LOCKSTEP_HARNESS, status: outcome, ...lockstepTimes(sup) });
      } catch {
        // an observer's fault is its own: the execution stands as it ended
      }
    }
  }
}
