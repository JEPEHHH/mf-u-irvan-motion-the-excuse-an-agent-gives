// A race's racer: one entry's bars-replay/v1 bot run live over a race window still being recorded, as the
// official grade later runs it over the frozen window (grader/run.ts executeLockstep, grader/harnesses.ts
// barsPlan), so the race view can draw its P&L as each bar closes. Nothing here decides anything: rank,
// rewards and the published result come only from the ordinary grade of the frozen window, and a race is a
// provisional third execution. The bot cannot tell the two apart: the protocol is bars-replay/v1 byte for byte.
//
//   runRacer({sandbox, runtime, botDir, limits, hello, spec, bars, prior, onPoint, signal})
//
// One sandboxed process for the whole race (a spec's `race`, types.ts: kept past every stale sweep, ended by
// the driver at raceLifetimeMs), over a live engine (sim/bars/engine.ts BarsEngine.live) in executeLockstep's
// shape and on its line codec (BARS_LOCKSTEP): hello is written at once; each bar the source yields is fed to
// the engine; while the engine is ready its next batch is written, the reply read, checked and submitted, and
// onPoint told the point it makes: the batch's seq, t, account and fills, and the reply chain's link. At the
// window's end: finish, done, the bot's exit, then the post-flatten point (seq the window's bars, t the last
// batch's, done's account, the fills the window's end resolved: the last batch's orders and the flatten closes).
//
// The bar source (RaceBarSource) is an async iterable of RaceBar {seq, t, bars}: one per close of the window,
// in order from seq 0, t = hello.first_close_ms + seq x the interval, bars that close's bars by symbol
// (BarsFeed; a symbol left out has a gap there). collector/bars/live.ts openLiveBars yields this shape; the race
// runner fans one out to every racer, the closes already past first for a racer started late. A bar out of
// order or off the grid, one the engine refuses (SimDataError), a source that throws or that ends before the
// window does: a harness fault, thrown. runRacer stops reading at the window's last bar (or when it ends) and
// returns the iterator.
//
// Budget: think time, not wall. limits.wall_budget_sec is held against each process's think time (io.ts
// Supervisor, budgetClock 'think'): from a batch's write to its reply, never the waits for the next bar to
// close. A racer that answers slowly falls behind (the closes fed meanwhile queue up as batches) and catches
// up. It is stopped only as executeLockstep stops a bot: its think budget run out (status timeout), or the
// protocol broken (status failed: every limit and reason in run.ts's header, the bot exiting before done
// included). Flags are executeLockstep's after done (killed_after_done, nonzero_exit_after_done), and
// think_budget_over_half for wall_budget_over_half.
//
// Reply links: link_k = sha256(link_{k-1} ‖ reply_k), link_{-1} RACE_LINK_GENESIS (32 zero bytes), each link
// the 32 bytes its hex names and each reply its RFC 8785 canonical JSON (sim/canonical.ts). A chain of the
// replies alone (raceReplyLinks), so a race is held to itself across processes and to the official grade's
// action log by the same function.
//
// Fast-forward: a lost process (its exit the driver's failure, Sandbox.isDriverFailure: the k8s exec cut, its
// pod gone, docker run refused; or a respawn the driver refused with a SandboxError) is respawned, `restarts`
// counting each, and hello and every batch the bars fed so far make are replayed through a fresh engine at the
// bot's own pace (its think time counted afresh: each process is held to the budget of one pass). Each reply's
// link is checked against the one known for it: prior[k] (an earlier run's, the race_point rows a restarted
// runner read back), else an earlier process's of this run. A mismatch marks the racer diverged from that
// batch (diverged_at: the first, kept) and the race carries on with the new process, whose links are the
// racer's from there. onPoint is called for every point that is new or differs from the one known for its seq,
// never again for one a fast-forward reproduced. A process lost RACE_MAX_LOST_IN_A_ROW times in a row with no
// reply past the furthest any process of the run got is a harness fault (SandboxError); each respawn waits
// RACE_RESPAWN_BACKOFF_MS first, doubling to RACE_MAX_RESPAWN_BACKOFF_MS, and again from the start after
// progress.
//
// signal: aborting it kills the process and rejects with its reason (the runner stopping; a restart
// fast-forwards from the points it stored, as `prior`).

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { BAR_INTERVAL_MS, type BarsAccountT, type BarsFillT, type BarsHelloT, type BarsReplyT } from '../contracts/bars-protocol.ts';
import { MAX_BOT_LINE_BYTES } from '../contracts/protocol.ts';
import { BarsEngine, SimAbortError, SimDataError, SimProtocolError, type BarsActionLogT, type BarsFeed, type BarsLiveSpec, type BarsRun, type BarsSimFill } from '../sim/bars/engine.ts';
import { canonicalJson } from '../sim/canonical.ts';
import { BARS_LOCKSTEP } from './harnesses.ts';
import { EXIT_GRACE_MS, KILLED_AFTER_DONE, MAX_ACTION_LOG_REPLY_BYTES, MAX_STDERR_BYTES, NONZERO_EXIT_AFTER_DONE, stderrTail, type LimitsT } from './run.ts';
import { describeExit, Stopped, Supervisor } from './sandbox/io.ts';
import { SandboxError, type Runtime, type Sandbox, type SandboxExit, type SandboxProcess } from './sandbox/types.ts';

/** link_{-1} of every racer's reply chain (the header): 32 zero bytes. */
export const RACE_LINK_GENESIS = '0'.repeat(64);
/** A race process lives this long past the window's end and its think budget (raceLifetimeMs): k8s's activeDeadlineSeconds, docker's deadline label. */
export const RACE_DEADLINE_SLACK_MS = 2 * 60 * 60 * 1000;
/** The first respawn's wait after a lost process; each lost in a row doubles it, up to RACE_MAX_RESPAWN_BACKOFF_MS. */
export const RACE_RESPAWN_BACKOFF_MS = 1_000;
export const RACE_MAX_RESPAWN_BACKOFF_MS = 30_000;
/** How many processes in a row may be lost with no reply past the furthest one got before the race is the harness's fault. */
export const RACE_MAX_LOST_IN_A_ROW = 5;
/** A finished racer that thought more than half its budget (run.ts WALL_BUDGET_OVER_HALF's twin). */
export const THINK_BUDGET_OVER_HALF = 'think_budget_over_half';

const HEX64_RE = /^[0-9a-f]{64}$/;

/** One close of the race window, as the bar source yields it (the header): batch `seq`'s bars. */
export interface RaceBar {
  seq: number;
  /** Its close time: hello.first_close_ms + seq x the interval. */
  t: number;
  /** The bars closing at t, by symbol (a Map or a record; one bar each, or a list): a symbol left out has a gap there. */
  bars: BarsFeed;
}

/** What a racer reads its bars from: every close of the window from seq 0, in order (collector/bars/live.ts openLiveBars). */
export type RaceBarSource = AsyncIterable<RaceBar>;

/** One point of a racer's race (the header). */
export interface RacePoint {
  /** The batch answered, 0 .. bars - 1; the window's bars for the post-flatten point. */
  seq: number;
  /** Its batch's close time; the post-flatten point's is the last batch's. */
  t: number;
  /** The account the batch carried (after its fills, marked at its closes); the post-flatten point's is done's. */
  account: BarsAccountT;
  /** The fills the batch carried; the post-flatten point's are the window end's (the last batch's orders, the flatten closes). */
  fills: BarsFillT[];
  /** link_seq of the reply chain (raceReplyLink); the post-flatten point repeats the last reply's. */
  reply_link: string;
  /** The process's think time so far, ms. */
  think_ms: number;
  /** Respawns so far. */
  restarts: number;
  /** The first batch whose reply differed from the one known for it, or null. */
  diverged_at: number | null;
}

/** A respawn (RaceOptions.onRestart). */
export interface RaceRestart {
  /** Respawns so far, this one included. */
  restarts: number;
  /** Why the process before it was lost. */
  reason: string;
  /** Replies the lost process gave. */
  answered: number;
}

export interface RaceOptions {
  sandbox: Sandbox;
  runtime: Runtime;
  /** Host directory mounted read-only at /bot: the entry's materialized snapshot. */
  botDir: string;
  /** The competition's limits: wall_budget_sec is the racer's think budget (the header). */
  limits: LimitsT;
  /** The hello the official grade will build (collector/bars/live.ts liveHello). */
  hello: BarsHelloT;
  /** The window and every symbol the bars may carry, mints and scales: BarsEngine.live's spec (the race phase's [starts_at, ends_at]). */
  spec: BarsLiveSpec;
  bars: RaceBarSource;
  /** prior[k]: reply k's link from an earlier run of this racer (its stored points, by seq), which the fast-forward is held to. */
  prior?: readonly string[];
  /** Each new or changed point, awaited before the racer goes on (a throw is a harness fault). */
  onPoint?: (point: RacePoint) => void | Promise<void>;
  /** Each respawn, before its backoff (a throw is a harness fault). */
  onRestart?: (restart: RaceRestart) => void | Promise<void>;
  signal?: AbortSignal;
  /** Container or pod name stem (default `race`). */
  label?: string;
  /** Run this image digest instead of the pinned one. */
  imageDigest?: string | null;
  exitGraceMs?: number;
  /** The epoch clock, ms (default Date.now): a process's lifetime is reckoned from it. */
  now?: () => number;
  /** The first respawn's wait (default RACE_RESPAWN_BACKOFF_MS). */
  respawnBackoffMs?: number;
}

export type RaceStatus = 'finished' | 'timeout' | 'failed';

/** How a racer ended. */
export interface RaceResult {
  status: RaceStatus;
  /** Why it failed or timed out; null when finished. */
  error: string | null;
  /** Batches the last process answered. */
  seq_done: number;
  /** The last process's reply links, by seq. */
  links: string[];
  /** The last process's think time, ms. */
  think_ms: number;
  /** runRacer's wall time, ms. */
  wall_ms: number;
  restarts: number;
  /** The first batch whose reply differed from the one known for it (prior, or an earlier process's), or null. */
  diverged_at: number | null;
  /** How many of the first batches had a known link their reply was checked against: crosscheck `matched` when > 0 with no divergence. */
  checked: number;
  /** The post-flatten point (finished only). */
  final: RacePoint | null;
  /** The run and its action log (finished only; dataset_sha256 the live placeholder, BARS_LIVE_DATASET_SHA256). */
  run: BarsRun | null;
  log: BarsActionLogT | null;
  flags: string[];
  /** The last process's stderr (at most MAX_STDERR_BYTES). */
  stderr: Buffer;
  exit: SandboxExit | null;
}

/** link_k from link_{k-1} and reply k (the header). */
export function raceReplyLink(prev: string, reply: BarsReplyT): string {
  if (typeof prev !== 'string' || !HEX64_RE.test(prev)) throw new TypeError(`a reply link is 64 lowercase hex, not ${JSON.stringify(prev)}`);
  return createHash('sha256').update(Buffer.from(prev, 'hex')).update(canonicalJson(reply), 'utf8').digest('hex');
}

/** Every link of a run of replies, from RACE_LINK_GENESIS (an action log's replies: what the official grade's run is held to). */
export function raceReplyLinks(replies: readonly BarsReplyT[]): string[] {
  const out: string[] = [];
  let link = RACE_LINK_GENESIS;
  for (const r of replies) out.push((link = raceReplyLink(link, r)));
  return out;
}

/** How long a race process may live from `now` (epoch ms): the window still ahead, the think budget and RACE_DEADLINE_SLACK_MS. */
export function raceLifetimeMs(window: { end_ms: number }, budgetMs: number, now: number): number {
  return Math.ceil(Math.max(0, window.end_ms - now) + budgetMs + RACE_DEADLINE_SLACK_MS);
}

/** Run one racer over the race (the header). Bot failures and timeouts are returned; harness faults (and an abort) are thrown. */
export async function runRacer(opts: RaceOptions): Promise<RaceResult> {
  return new Racer(opts).run();
}

/** One process of the racer and what it did. */
interface Attempt {
  proc: SandboxProcess;
  sup: Supervisor;
  answered: number;
  links: string[];
}

type Outcome =
  | { kind: 'finished'; run: BarsRun; final: RacePoint; flags: string[] }
  | { kind: 'timeout' | 'failed'; error: string }
  | { kind: 'lost'; reason: string };

/** A point before its bookkeeping (RacePoint without the racer's counters). */
type PointOf = Pick<RacePoint, 'seq' | 't' | 'account' | 'fills' | 'reply_link'>;

/** The resolutions the window's end recorded and no batch delivered, as the protocol's fills. */
function windowEndFills(run: BarsRun, delivered: number): BarsFillT[] {
  return run.resolutions.slice(delivered).map((f: BarsSimFill) => {
    const { kind: _k, seq: _s, index: _i, rejected_at: _r, position_before_qty: _p, cash_after_quote_units: _c, ...fill } = f;
    return fill;
  });
}

class Racer {
  readonly #o: RaceOptions;
  readonly #hello: BarsHelloT;
  readonly #step: number;
  readonly #bars: number;
  readonly #budgetMs: number;
  readonly #now: () => number;
  readonly #startedAt = performance.now();
  /** Every bar the source gave, as given (cloned): what a fresh engine is fed. */
  readonly #fed: RaceBar[] = [];
  #engine: BarsEngine;
  #feedEnded = false;
  #feedError: unknown = null;
  #closed = false;
  #iterator: AsyncIterator<RaceBar> | null = null;
  #returned = false;
  readonly #wakers = new Set<() => void>();
  /** The link known for each seq: prior's, then each reply's as it came (a divergence replaces the tail). */
  readonly #known: string[];
  #divergedAt: number | null = null;
  #checked = 0;
  #restarts = 0;

  constructor(o: RaceOptions) {
    this.#o = o;
    this.#engine = BarsEngine.live(o.spec, o.hello);
    this.#hello = this.#engine.hello;
    this.#step = BAR_INTERVAL_MS[this.#hello.bar_interval];
    this.#bars = o.spec.window.bars;
    this.#budgetMs = o.limits.wall_budget_sec * 1000;
    this.#now = o.now ?? Date.now;
    const prior = o.prior ?? [];
    prior.forEach((l, k) => {
      if (typeof l !== 'string' || !HEX64_RE.test(l)) throw new TypeError(`prior[${k}] is not a reply link (64 lowercase hex): ${JSON.stringify(l)}`);
    });
    this.#known = [...prior];
  }

  async run(): Promise<RaceResult> {
    this.#o.signal?.throwIfAborted();
    void this.#pump();
    try {
      const firstBackoff = this.#o.respawnBackoffMs ?? RACE_RESPAWN_BACKOFF_MS;
      let backoff = firstBackoff;
      let furthest = 0;
      let lostInARow = 0;
      for (let first = true; ; first = false) {
        let att: Attempt | null = null;
        let refused = '';
        try {
          att = this.#spawn();
        } catch (err) {
          // A spec the driver refuses at the start is the caller's; at a respawn it is one more lost process.
          if (first || !(err instanceof SandboxError)) throw err;
          refused = err.message;
        }
        const outcome: Outcome = att === null ? { kind: 'lost', reason: `the sandbox could not respawn it: ${refused}` } : await this.#drive(att);
        if (outcome.kind !== 'lost') return this.#result(outcome, att!);
        const reason = outcome.reason;
        const answered = att?.answered ?? 0;
        if (answered > furthest) {
          furthest = answered;
          lostInARow = 0;
          backoff = firstBackoff;
        }
        lostInARow++;
        if (lostInARow >= RACE_MAX_LOST_IN_A_ROW) {
          throw new SandboxError(`the racer's process was lost ${lostInARow} times in a row with no reply past batch ${furthest} (${this.#restarts} respawns in all): ${reason}`);
        }
        this.#restarts++;
        await this.#o.onRestart?.({ restarts: this.#restarts, reason, answered });
        await this.#pause(backoff);
        backoff = Math.min(backoff * 2, RACE_MAX_RESPAWN_BACKOFF_MS);
        this.#engine = this.#freshEngine();
      }
    } finally {
      this.#closed = true;
      this.#wake();
      this.#returnSource();
    }
  }

  // ---------------------------------------------------------------- the bars

  /** Read the source into the engine until the window's last bar, the source's end, or the racer's. */
  async #pump(): Promise<void> {
    try {
      const it = this.#o.bars[Symbol.asyncIterator]();
      this.#iterator = it;
      while (!this.#closed && this.#fed.length < this.#bars) {
        let r: IteratorResult<RaceBar>;
        try {
          r = await it.next();
        } catch (err) {
          // A source that threw is done: nothing to return.
          this.#returned = true;
          throw err;
        }
        if (this.#closed) break;
        if (r.done === true) {
          this.#returned = true;
          break;
        }
        this.#take(r.value);
        this.#wake();
      }
    } catch (err) {
      if (!this.#closed) this.#feedError = err;
    } finally {
      this.#feedEnded = true;
      this.#returnSource();
      this.#wake();
    }
  }

  /** One bar from the source: the next seq, on the grid, fed to the engine (all or nothing), then kept. */
  #take(b: RaceBar): void {
    const k = this.#fed.length;
    if (typeof b !== 'object' || b === null || b.seq !== k) throw new SimDataError(`the bar source yielded seq ${JSON.stringify((b as { seq?: unknown } | null)?.seq)} where ${k} was due`);
    const due = this.#hello.first_close_ms + k * this.#step;
    if (b.t !== due) throw new SimDataError(`the bar source's bar ${k} closes at t ${JSON.stringify(b.t)}, not ${due}`);
    const kept: RaceBar = { seq: b.seq, t: b.t, bars: structuredClone(b.bars) };
    this.#engine.feed(kept.t, kept.bars);
    this.#fed.push(kept);
  }

  /** A live engine fed every bar so far: what a respawned process is replayed through. */
  #freshEngine(): BarsEngine {
    const engine = BarsEngine.live(this.#o.spec, this.#o.hello);
    for (const b of this.#fed) engine.feed(b.t, b.bars);
    return engine;
  }

  #returnSource(): void {
    const it = this.#iterator;
    if (it === null || this.#returned || typeof it.return !== 'function') return;
    if (!this.#feedEnded && !this.#closed) return;
    this.#returned = true;
    void Promise.resolve()
      .then(() => it.return!())
      .catch(() => undefined);
  }

  #wake(): void {
    for (const w of [...this.#wakers]) w();
  }

  // ---------------------------------------------------------------- a process

  #spawn(): Attempt {
    const o = this.#o;
    const proc = o.sandbox.spawn({
      runtime: o.runtime,
      codeDir: o.botDir,
      limits: o.limits,
      label: o.label ?? 'race',
      imageDigest: o.imageDigest ?? null,
      race: { lifetimeMs: raceLifetimeMs(o.spec.window, this.#budgetMs, this.#now()) },
    });
    const sup = new Supervisor(proc, {
      budgetMs: this.#budgetMs,
      budgetClock: 'think',
      maxStderrBytes: MAX_STDERR_BYTES,
      stdout: { mode: 'lines', maxLineBytes: MAX_BOT_LINE_BYTES },
    });
    // An idle racer learns of its process's end at once (the Supervisor's own handler has run by then).
    void proc.exited.then(() => this.#wake());
    return { proc, sup, answered: 0, links: [] };
  }

  /** One process, from hello to its end: finished, the bot's failure or timeout, or lost (the header). */
  async #drive(att: Attempt): Promise<Outcome> {
    const { sup } = att;
    const engine = this.#engine;
    const cap = BARS_LOCKSTEP.replyOrderCap(engine.hello);
    const flags: string[] = [];
    let replyBytes = 0;
    let delivered = 0;
    let lastT = this.#hello.first_close_ms;
    let link = RACE_LINK_GENESIS;
    let phase: 'waiting' | 'awaiting' | 'done' = 'waiting';
    try {
      await this.#abortable(sup.write(BARS_LOCKSTEP.encode(engine.hello)));
      for (;;) {
        if (this.#feedError !== null) throw this.#feedError;
        if (!engine.ready()) {
          if (this.#feedEnded) throw new SimDataError(`the bar source ended after ${this.#fed.length} of the window's ${this.#bars} bars`);
          await this.#idle(sup);
          continue;
        }
        const b = engine.nextBatch();
        if (b === null) break;
        delivered += b.fills.length;
        lastT = b.t;
        phase = 'awaiting';
        sup.expectLine();
        await this.#abortable(sup.write(BARS_LOCKSTEP.encode(b)));
        const text = await this.#abortable(sup.nextLine());
        replyBytes += Buffer.byteLength(text, 'utf8');
        if (replyBytes > MAX_ACTION_LOG_REPLY_BYTES) throw sup.violate(`replies passed ${MAX_ACTION_LOG_REPLY_BYTES} bytes in total`);
        const parsed = BARS_LOCKSTEP.parseLine(text);
        if (!parsed.ok) throw sup.violate(`reply to batch ${b.seq}: ${parsed.reason}`);
        if (parsed.reply.orders.length > cap) throw sup.violate(`reply to batch ${b.seq} carries ${parsed.reply.orders.length} orders (max ${cap})`);
        try {
          engine.submit(parsed.reply);
        } catch (err) {
          if (err instanceof SimProtocolError) throw sup.violate(`reply to batch ${b.seq}: ${err.message}`);
          throw err;
        }
        phase = 'waiting';
        link = raceReplyLink(link, parsed.reply);
        att.links.push(link);
        att.answered++;
        await this.#point({ seq: b.seq, t: b.t, account: b.account, fills: b.fills, reply_link: link }, sup, true);
      }
      const { done, run } = engine.finish();
      if (run.aborted !== null) throw new SimAbortError(`replay aborted: ${run.aborted}`);
      phase = 'done';
      await this.#abortable(sup.write(BARS_LOCKSTEP.encode(done)));
      sup.closeStdin();
      const exit = await this.#abortable(sup.waitExit(this.#o.exitGraceMs ?? EXIT_GRACE_MS));
      if (exit === 'grace') {
        flags.push(KILLED_AFTER_DONE);
        await sup.kill();
      } else if (exit.code !== 0 && !this.#o.sandbox.isDriverFailure(exit)) flags.push(NONZERO_EXIT_AFTER_DONE);
      const final = await this.#point({ seq: run.batches, t: lastT, account: done.account, fills: windowEndFills(run, delivered), reply_link: link }, sup, false);
      return { kind: 'finished', run, final, flags };
    } catch (err) {
      await sup.kill();
      if (!(err instanceof Stopped)) throw err;
      const r = err.reason;
      if (r.kind === 'timeout') return { kind: 'timeout', error: 'the think budget ran out' };
      if (r.kind === 'violation') return { kind: 'failed', error: `protocol violation: ${r.message}` };
      if (this.#o.sandbox.isDriverFailure(r.exit)) return { kind: 'lost', reason: `the sandbox failed (${describeExit(r.exit)}): ${stderrTail(sup.stderr())}` };
      const when = phase === 'awaiting' ? `before replying to batch ${att.answered}` : phase === 'done' ? 'before done' : `while waiting for batch ${att.answered}`;
      return { kind: 'failed', error: `the bot exited ${when} (${describeExit(r.exit)})` };
    }
  }

  /** Wait, uncharged, for the next bar, the source's end or the process's (then its stop reason is thrown). */
  async #idle(sup: Supervisor): Promise<void> {
    const ended = () => sup.exit !== null || sup.stopped !== null;
    if (!ended()) {
      await this.#abortable(
        new Promise<void>((resolve) => {
          const wake = () => {
            this.#wakers.delete(wake);
            resolve();
          };
          this.#wakers.add(wake);
        }),
      );
    }
    if (ended()) throw new Stopped(sup.stopped ?? { kind: 'exited', exit: sup.exit! });
  }

  /**
   * A point made (the header): a reply's is checked against the link known for its seq, a mismatch marking the
   * divergence and taking the new chain from there; reported when it is new or differs. The post-flatten point is
   * reported unless the same link is known for its seq. Its full form either way.
   */
  async #point(p: PointOf, sup: Supervisor, reply: boolean): Promise<RacePoint> {
    const k = p.seq;
    const known = k < this.#known.length ? this.#known[k] : undefined;
    const report = known !== p.reply_link;
    if (reply) {
      if (known !== undefined) {
        this.#checked = Math.max(this.#checked, k + 1);
        if (report) {
          this.#divergedAt ??= k;
          this.#known.length = k;
        }
      }
      // A reply comes for seq k only once every seq before it has a link known, so it lands at k.
      if (report) this.#known.push(p.reply_link);
    }
    const point: RacePoint = { ...p, think_ms: Math.round(sup.elapsedMs()), restarts: this.#restarts, diverged_at: this.#divergedAt };
    if (report) await this.#o.onPoint?.(point);
    return point;
  }

  #result(outcome: Exclude<Outcome, { kind: 'lost' }>, att: Attempt): RaceResult {
    const think = Math.round(att.sup.elapsedMs());
    const finished = outcome.kind === 'finished' ? outcome : null;
    const flags = finished === null ? [] : [...finished.flags];
    if (finished !== null && think * 2 > this.#budgetMs) flags.push(THINK_BUDGET_OVER_HALF);
    return {
      status: outcome.kind,
      error: outcome.kind === 'finished' ? null : outcome.error,
      seq_done: att.answered,
      links: [...att.links],
      think_ms: think,
      wall_ms: Math.round(performance.now() - this.#startedAt),
      restarts: this.#restarts,
      diverged_at: this.#divergedAt,
      checked: this.#checked,
      final: finished?.final ?? null,
      run: finished?.run ?? null,
      log: finished?.run.action_log ?? null,
      flags: [...new Set(flags)].sort(),
      stderr: att.sup.stderr(),
      exit: att.sup.exit,
    };
  }

  // ---------------------------------------------------------------- the signal

  /** `p`, or the signal's reason once it aborts (p's own end then ignored). */
  #abortable<T>(p: Promise<T>): Promise<T> {
    const signal = this.#o.signal;
    if (signal === undefined) return p;
    if (signal.aborted) {
      p.catch(() => undefined);
      return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        p.catch(() => undefined);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  /** Wait `ms` before a respawn; the signal's reason when it aborts meanwhile. */
  async #pause(ms: number): Promise<void> {
    const signal = this.#o.signal;
    try {
      await sleep(ms, undefined, signal === undefined ? undefined : { signal });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      throw err;
    }
  }
}
