// Supervising one sandboxed program: its wall budget, its stdout (protocol lines with a per-line byte
// cap, or a capped capture), its stderr (capped), and how it stopped. A harness drives it with
// write / expectLine / nextLine / closeStdin / waitExit; anything that ends the program early
// (the budget running out, a limit broken, a line nobody asked for, the program exiting) is
// recorded once as `stopped` and kills the program, and every pending or later call rejects with
// a Stopped error carrying that reason.
//
// The budget runs on the program's clock: from spawn, or from the process's `started` when its
// driver sets one (k8s, whose pod is created and seen Ready, and its exec opened, before the program
// runs). Until then nothing counts and no budget timer runs: the driver bounds that wait itself,
// ending the process with an exit when the program never starts.
//
// Lockstep is enforced here: a stdout line is accepted only while the harness is expecting one
// (expectLine before writing the message it answers, then nextLine). A line that arrives when none
// is expected (two replies to one batch, output before the first batch or after done) is a
// violation. Lines are strict UTF-8; a line longer than the cap is a violation as soon as its
// buffered prefix passes the cap, so an endless line never buffers more than the cap.
//
// Think time (budgetClock 'think': a race's racer, grader/race.ts): the budget counts only while a
// reply is expected, from expectLine (the batch it answers is written right after) to that line's
// arrival, and only once the program has started. The waits between replies (a racer waiting for the
// next bar to close) are never charged, so a program that answers slowly falls behind and catches up,
// and is stopped only when the spans it took to answer add up to the budget: then the stop reason is
// `{kind: 'timeout', clock: 'think'}`. elapsedMs and remainingMs are on that clock; waitExit is not
// (its grace is the program's own time, as ever).
//
// A wall budget that moves (grader/house-clock.ts: time the program spent waiting on the house, given back): on the wall
// clock its owner may raise the budget while the program runs (extendBudget: monotone and idempotent, never shortened,
// the deadline moved out with it), and with SupervisorOptions.atDeadline it is asked once more each time the deadline
// falls due, before the timeout is called, so time owed up to the last moment counts: a budget it raises runs on, else
// the timeout stands. Without atDeadline and no extendBudget call, the budget is fixed, as it always was.
//
// Turns (wall clock, SupervisorOptions.paused / pauseOnLine / backstopMs: a lockstep replay's bot, grader/run.ts
// executeLockstep): the budget may be paused while the harness holds the turn and resumed when it hands the turn back
// (pause / resume), so only the program's own turns are charged to it. `paused` starts it paused (the harness's turn
// from the start); `pauseOnLine` pauses it the moment an expected line arrives (the reply hands the turn back), never a
// tick later; resume() runs it on, its deadline the budget left. elapsedMs and remainingMs read the budget's clock,
// wallMs the total wall (every pause included). A backstop bounds the total: once wallMs passes backstopMs with the
// budget not spent, the program is stopped with `{kind: 'timeout', clock: 'total'}`, which the harness reads as its
// own fault (the time went to its turns), never the program's timeout. Without these the wall clock is as it was.
//
// The program's end: `exited`, or the process's `finished` when its driver sets one (k8s, which returns a writable
// mount's files and removes the pod between the program's end and `exited`). From then the program's clock stands:
// elapsedMs and remainingMs read the end, no budget timer runs on (no timeout is called on the driver's time), and
// a waitExit's grace neither arms nor fires (the exit is the driver's to bring). Its stdout and stderr are still
// read, and every limit on them still holds, until `exited`.

import type { SandboxExit, SandboxProcess } from './types.ts';

export type StopReason =
  /** clock: absent the wall budget, `think` the think budget, `total` the turns' backstop (the harness's fault, never the program's). */
  | { kind: 'timeout'; clock?: 'think' | 'total' }
  | { kind: 'violation'; message: string }
  | { kind: 'exited'; exit: SandboxExit };

export class Stopped extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason) {
    super(describeStop(reason));
    this.name = 'Stopped';
    this.reason = reason;
  }
}

export function describeStop(r: StopReason): string {
  switch (r.kind) {
    case 'timeout':
      return r.clock === 'think' ? 'the think budget ran out' : r.clock === 'total' ? "the total wall passed its backstop with the program's budget not spent" : 'the wall budget ran out';
    case 'violation':
      return r.message;
    case 'exited':
      return `exited (${describeExit(r.exit)})`;
  }
}

export function describeExit(e: SandboxExit): string {
  if (e.error !== undefined) return e.error;
  if (e.signal !== null) return `signal ${e.signal}`;
  return `code ${e.code}`;
}

export interface SupervisorOptions {
  /** The budget, in ms: wall time from the program's start (spawn, or the process's `started`), or its think time (budgetClock). */
  budgetMs: number;
  /**
   * What the budget counts (default `wall`): `wall`, everything from the program's start; `think`, only the
   * spans a reply is expected in once it has started (the header's Think time).
   */
  budgetClock?: 'wall' | 'think';
  maxStderrBytes: number;
  /** `lines`: protocol lines of at most maxLineBytes (UTF-8, the `\n` not counted); `capture`: keep up to maxBytes. */
  stdout: { mode: 'lines'; maxLineBytes: number } | { mode: 'capture'; maxBytes: number };
  /** Monotonic clock in ms (tests inject one). */
  now?: () => number;
  /**
   * Wall clock only: asked once each time the deadline falls due, before the timeout is called: the budget (ms, from the
   * program's start) it stands at now. One above the budget raises it (extendBudget) and the program runs on to the new
   * deadline; anything else (the same, lower, not a finite number, a rejection) and the timeout stands.
   */
  atDeadline?: () => number | Promise<number>;
  /** Wall clock only (the header's Turns): start with the budget paused, so it runs only from the first resume(). */
  paused?: boolean;
  /** Wall clock only (the header's Turns): each expected stdout line pauses the budget as it arrives, until resume(). */
  pauseOnLine?: boolean;
  /**
   * Wall clock only (the header's Turns): the most total wall (ms from the program's start, every pause included) it may
   * take with its budget not spent; past it, stopped with `{kind: 'timeout', clock: 'total'}`. Absent: no backstop.
   */
  backstopMs?: number;
}

const NEWLINE = 0x0a;

export class Supervisor {
  readonly proc: SandboxProcess;
  /** When the process was spawned (the Supervisor made), on the `now` clock. */
  readonly startedAt: number;
  /** What the budget counts (SupervisorOptions.budgetClock). */
  readonly budgetClock: 'wall' | 'think';
  #budgetMs: number;
  /** Wall clock: SupervisorOptions.atDeadline is being asked (the deadline fell due); its answer arms or stops. */
  #asking = false;
  #now: () => number;
  #runningAt: number | null = null;
  /** Think time: the closed spans' total, and when the open one began (null while none is open). */
  #charged = 0;
  #chargeFrom: number | null = null;
  #stopped: StopReason | null = null;
  #exit: SandboxExit | null = null;
  /** When the program ended (the header's end: the process's `finished`, else its exit), on the `now` clock. */
  #endAt: number | null = null;
  #timer: NodeJS.Timeout | null = null;
  /** Turns (wall clock): whether the budget is paused, the closed pauses' total once started, and when the open one began counting (null while none is open or before the start). */
  #paused: boolean;
  #pausedMs = 0;
  #pausedFrom: number | null = null;
  /** Turns: the backstop's timer (SupervisorOptions.backstopMs), armed at the start. */
  #backstop: NodeJS.Timeout | null = null;
  #killed = false;
  #expecting = false;
  #queue: string[] = [];
  #waiter: { resolve: (l: string) => void; reject: (e: Stopped) => void } | null = null;
  #partial: Buffer[] = [];
  #partialBytes = 0;
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #stderr: Buffer[] = [];
  #stderrBytes = 0;
  #stdoutCapture: Buffer[] = [];
  #stdoutBytes = 0;
  #listeners = new Set<() => void>();
  readonly #opts: SupervisorOptions;

  constructor(proc: SandboxProcess, opts: SupervisorOptions) {
    this.proc = proc;
    this.#opts = opts;
    this.#now = opts.now ?? (() => performance.now());
    this.startedAt = this.#now();
    this.#budgetMs = opts.budgetMs;
    this.budgetClock = opts.budgetClock ?? 'wall';
    if (opts.atDeadline !== undefined && this.budgetClock !== 'wall') throw new TypeError('atDeadline runs on the wall clock alone');
    if ((opts.paused !== undefined || opts.pauseOnLine !== undefined || opts.backstopMs !== undefined) && this.budgetClock !== 'wall') throw new TypeError('turns run on the wall clock alone');
    if (opts.backstopMs !== undefined && !(Number.isFinite(opts.backstopMs) && opts.backstopMs > 0)) throw new RangeError(`a backstop is a positive number of ms, got ${String(opts.backstopMs)}`);
    this.#paused = opts.paused === true;
    if (proc.started === undefined) this.#begin(this.startedAt);
    else void proc.started.then(() => this.#begin(this.#now()));
    proc.stdout.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    proc.stderr.on('data', (chunk: Buffer) => this.#onStderr(chunk));
    // A write after the program died raises EPIPE here; the exit itself is what gets reported.
    proc.stdin.on('error', () => undefined);
    proc.stdout.on('error', () => undefined);
    proc.stderr.on('error', () => undefined);
    if (proc.finished !== undefined) {
      const finish = () => this.#finish(this.#now());
      void proc.finished.then(finish, finish);
    }
    void proc.exited.then((exit) => {
      if (this.#timer !== null) clearTimeout(this.#timer);
      this.#clearBackstop();
      if (this.#endAt === null) this.#endAt = this.#now();
      if (this.#opts.stdout.mode === 'lines' && this.#partialBytes > 0 && this.#stopped === null) {
        this.#stopped = { kind: 'violation', message: 'stdout ended inside a line (no trailing newline)' };
      }
      this.#exit = exit;
      this.#rejectWaiter(new Stopped(this.#stopped ?? { kind: 'exited', exit }));
      this.#notify();
    });
  }

  /** How the program was stopped early, or null. */
  get stopped(): StopReason | null {
    return this.#stopped;
  }

  /** The program's exit, once it has exited. */
  get exit(): SandboxExit | null {
    return this.#exit;
  }

  /** When the program ended (the header's end: the process's `finished`, else its exit), or null while it runs. */
  get endedAt(): number | null {
    return this.#endAt;
  }

  /** When the program began to run (the budget's start: startedAt, or the process's `started`), or null while it has not. */
  get runningAt(): number | null {
    return this.#runningAt;
  }

  /** The budget, in ms: SupervisorOptions.budgetMs, or what extendBudget (or atDeadline) raised it to since. */
  get budgetMs(): number {
    return this.#budgetMs;
  }

  /**
   * Wall clock: raise the budget to `ms` (from the program's start; the header's moving budget). Monotone and idempotent:
   * a budget at or under the current one changes nothing, so it is never shortened; one above it moves the deadline out
   * while the program runs (a timeout already called stays called). Returns the budget as it stands.
   */
  extendBudget(ms: number): number {
    if (this.budgetClock !== 'wall') throw new TypeError('extendBudget runs on the wall clock alone');
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= this.#budgetMs) return this.#budgetMs;
    this.#budgetMs = ms;
    // While atDeadline is asked, its answer arms the deadline (or stops); before the start #begin arms it.
    if (!this.#asking && this.#timer !== null) this.#armWall();
    return this.#budgetMs;
  }

  /**
   * ms from the program's start until now, or until its end once it has ended (the header's end); 0 while it has not
   * started, less every pause (the header's Turns; wallMs is the total). On the think clock: the spans a reply was
   * expected in, the open one until now (or the end).
   */
  elapsedMs(): number {
    if (this.budgetClock === 'think') return this.#charged + (this.#chargeFrom === null ? 0 : (this.#endAt ?? this.#now()) - this.#chargeFrom);
    return this.#wallElapsed();
  }

  /** The budget left: all of it while the program has not started, what was left at its end once it has ended. */
  remainingMs(): number {
    return this.budgetMs - this.elapsedMs();
  }

  /** The total wall: ms from the program's start until now, or until its end once it has ended, every pause included; 0 while it has not started. */
  wallMs(): number {
    return this.#runningAt === null ? 0 : (this.#endAt ?? this.#now()) - this.#runningAt;
  }

  /** Whether the budget is paused (the header's Turns). */
  get paused(): boolean {
    return this.#paused;
  }

  /** Wall clock (the header's Turns): pause the budget now (the harness takes the turn); its timer stops, the backstop's runs on. Idempotent. */
  pause(): void {
    if (this.budgetClock !== 'wall') throw new TypeError('pause runs on the wall clock alone');
    if (this.#paused) return;
    this.#paused = true;
    if (this.#runningAt === null) return;
    this.#pausedFrom = this.#endAt ?? this.#now();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Wall clock (the header's Turns): run the budget on now (the program takes the turn), its deadline the budget left. Idempotent. */
  resume(): void {
    if (this.budgetClock !== 'wall') throw new TypeError('resume runs on the wall clock alone');
    if (!this.#paused) return;
    this.#paused = false;
    if (this.#pausedFrom !== null) this.#pausedMs += Math.max(0, (this.#endAt ?? this.#now()) - this.#pausedFrom);
    this.#pausedFrom = null;
    if (!this.#asking) this.#armWall();
  }

  stderr(): Buffer {
    return Buffer.concat(this.#stderr);
  }

  stdoutCapture(): Buffer {
    return Buffer.concat(this.#stdoutCapture);
  }

  /** Accept exactly one stdout line from now on (call before writing the message it answers). On the think clock its span opens here, or at the start. */
  expectLine(): void {
    this.#throwIfStopped();
    this.#expecting = true;
    if (this.budgetClock === 'think' && this.#runningAt !== null) this.#charge(this.#now());
  }

  /** The line expectLine allowed. */
  nextLine(): Promise<string> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#stopped !== null) return Promise.reject(new Stopped(this.#stopped));
    if (this.#exit !== null) return Promise.reject(new Stopped({ kind: 'exited', exit: this.#exit }));
    return new Promise<string>((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  /** Write to stdin, waiting for the pipe to drain when it is full. */
  async write(text: string): Promise<void> {
    this.#throwIfStopped();
    if (this.#exit !== null) throw new Stopped({ kind: 'exited', exit: this.#exit });
    const ok = this.proc.stdin.write(text);
    if (ok) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        this.proc.stdin.off('drain', done);
        this.#listeners.delete(onChange);
        resolve();
      };
      const onChange = () => {
        if (this.#stopped !== null || this.#exit !== null) {
          this.proc.stdin.off('drain', done);
          this.#listeners.delete(onChange);
          reject(new Stopped(this.#stopped ?? { kind: 'exited', exit: this.#exit! }));
        }
      };
      this.proc.stdin.on('drain', done);
      this.#listeners.add(onChange);
    });
  }

  closeStdin(): void {
    if (!this.proc.stdin.destroyed && !this.proc.stdin.writableEnded) this.proc.stdin.end();
  }

  /**
   * Wait for the exit, at most `ms` of the program's clock (so counted from its start when it has not
   * started yet: `waitExit(remainingMs())` waits out the budget). Resolves the exit, or 'grace' when `ms`
   * passed first while the budget still had time; rejects with Stopped when the budget ran out or a
   * limit broke meanwhile. Once the program has ended (the header's end) its clock stands, so the grace never comes:
   * it waits for the exit.
   */
  async waitExit(ms: number): Promise<SandboxExit | 'grace'> {
    if (this.#exit !== null) return this.#exit;
    this.#throwIfStopped();
    return new Promise<SandboxExit | 'grace'>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const arm = () => {
        if (this.#endAt !== null) return;
        timer = setTimeout(() => {
          this.#listeners.delete(onChange);
          resolve('grace');
        }, Math.max(0, ms));
      };
      const onChange = () => {
        if (this.#exit !== null) {
          if (timer !== null) clearTimeout(timer);
          this.#listeners.delete(onChange);
          if (this.#stopped !== null && this.#stopped.kind !== 'exited') reject(new Stopped(this.#stopped));
          else resolve(this.#exit);
        } else if (this.#stopped !== null) {
          if (timer !== null) clearTimeout(timer);
          this.#listeners.delete(onChange);
          reject(new Stopped(this.#stopped));
        } else if (this.#endAt !== null) {
          if (timer !== null) clearTimeout(timer);
          timer = null;
        } else if (timer === null && this.#runningAt !== null) arm();
      };
      this.#listeners.add(onChange);
      if (this.#runningAt !== null) arm();
    });
  }

  /** Kill the program (if still running) and wait for it to be gone. */
  async kill(): Promise<void> {
    this.#killed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#clearBackstop();
    await this.proc.kill();
  }

  /** Record a violation found by the harness (bad reply, cap exceeded) and kill the program. */
  violate(message: string): Stopped {
    this.#stop({ kind: 'violation', message });
    return new Stopped(this.#stopped!);
  }

  // ---------------------------------------------------------------- internals

  #throwIfStopped(): void {
    if (this.#stopped !== null) throw new Stopped(this.#stopped);
  }

  /**
   * The program started at `at`: its clock and its budget run from then (a waitExit waiting on the start arms); on
   * the think clock, a reply already expected opens its span then.
   */
  #begin(at: number): void {
    if (this.#runningAt !== null || this.#exit !== null || this.#endAt !== null) return;
    this.#runningAt = at;
    // A budget paused before the start counts its pause from the start (the header's Turns).
    if (this.#paused) this.#pausedFrom = at;
    if (this.#stopped !== null || this.#killed) return;
    if (this.budgetClock === 'think') {
      if (this.#expecting) this.#charge(at);
    } else if (!this.#paused) this.#timer = setTimeout(() => this.#wallDue(), Math.max(0, this.budgetMs));
    const backstop = this.#opts.backstopMs;
    if (backstop !== undefined) this.#backstop = setTimeout(() => this.#backstopDue(), Math.max(0, backstop));
    this.#notify();
  }

  /** The program ended at `at` (the process's `finished`): its clock stands from then, and no budget timer runs on. */
  #finish(at: number): void {
    if (this.#endAt !== null || this.#exit !== null) return;
    this.#endAt = at;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#clearBackstop();
    this.#notify();
  }

  /** Wall clock: the budget's clock (the header's Turns): from the start, less every pause. */
  #wallElapsed(): number {
    if (this.#runningAt === null) return 0;
    const to = this.#endAt ?? this.#now();
    return to - this.#runningAt - this.#pausedMs - (this.#pausedFrom === null ? 0 : Math.max(0, to - this.#pausedFrom));
  }

  /** Wall clock: the deadline moved (extendBudget, an atDeadline answer, a resume): its timer set again to the budget left; none while paused. */
  #armWall(): void {
    if (this.#runningAt === null || this.#endAt !== null || this.#stopped !== null || this.#exit !== null || this.#killed || this.#paused) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#wallDue(), Math.max(0, this.#budgetMs - this.#wallElapsed()));
  }

  /**
   * The backstop fell due (the header's Turns): the total wall passed backstopMs. A budget already spent is the
   * program's timeout, as its own deadline would have called it; otherwise the backstop's stop, the harness's fault.
   */
  #backstopDue(): void {
    this.#backstop = null;
    if (this.#endAt !== null || this.#stopped !== null || this.#exit !== null || this.#killed) return;
    this.#stop(this.#wallElapsed() >= this.#budgetMs && !this.#asking ? { kind: 'timeout' } : { kind: 'timeout', clock: 'total' });
  }

  #clearBackstop(): void {
    if (this.#backstop !== null) clearTimeout(this.#backstop);
    this.#backstop = null;
  }

  /**
   * Wall clock: the deadline fell due. Without atDeadline the timeout, as ever; with it, asked once: a budget it raises
   * (or one extendBudget raised meanwhile) runs on to the new deadline, else the timeout.
   */
  #wallDue(): void {
    const ask = this.#opts.atDeadline;
    if (this.#endAt !== null) return;
    if (ask === undefined) {
      this.#stop({ kind: 'timeout' });
      return;
    }
    if (this.#stopped !== null || this.#exit !== null || this.#killed || this.#asking) return;
    this.#asking = true;
    const before = this.#budgetMs;
    void Promise.resolve()
      .then(ask)
      .then(
        (ms) => {
          this.extendBudget(ms);
        },
        () => undefined,
      )
      .then(() => {
        this.#asking = false;
        if (this.#killed || this.#endAt !== null) return;
        if (this.#budgetMs > before) this.#armWall();
        else this.#stop({ kind: 'timeout' });
      });
  }

  /** Think clock: open a span at `at` (none while one is open, or once the program has stopped), its timer set to the budget left. */
  #charge(at: number): void {
    if (this.#chargeFrom !== null || this.#endAt !== null || this.#stopped !== null || this.#exit !== null || this.#killed) return;
    this.#chargeFrom = at;
    this.#timer = setTimeout(() => {
      if (this.#endAt === null) this.#stop({ kind: 'timeout', clock: 'think' });
    }, Math.max(0, this.budgetMs - this.#charged));
  }

  /** Think clock: close the open span now (the expected line came), or at the program's end when a line it wrote before it came after. */
  #uncharge(): void {
    if (this.#chargeFrom === null) return;
    this.#charged += (this.#endAt ?? this.#now()) - this.#chargeFrom;
    this.#chargeFrom = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #stop(reason: StopReason): void {
    if (this.#stopped !== null || this.#exit !== null) return;
    this.#stopped = reason;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#clearBackstop();
    this.#rejectWaiter(new Stopped(reason));
    this.#notify();
    void this.proc.kill();
  }

  #rejectWaiter(err: Stopped): void {
    const w = this.#waiter;
    this.#waiter = null;
    w?.reject(err);
  }

  #notify(): void {
    for (const l of [...this.#listeners]) l();
  }

  #onStderr(chunk: Buffer): void {
    if (this.#stopped !== null) return;
    const room = this.#opts.maxStderrBytes - this.#stderrBytes;
    if (chunk.length > room) {
      if (room > 0) this.#stderr.push(chunk.subarray(0, room));
      this.#stderrBytes = this.#opts.maxStderrBytes;
      this.#stop({ kind: 'violation', message: `stderr passed ${this.#opts.maxStderrBytes} bytes` });
      return;
    }
    this.#stderr.push(chunk);
    this.#stderrBytes += chunk.length;
  }

  #onStdout(chunk: Buffer): void {
    if (this.#stopped !== null) return;
    const mode = this.#opts.stdout;
    if (mode.mode === 'capture') {
      if (this.#stdoutBytes + chunk.length > mode.maxBytes) {
        this.#stop({ kind: 'violation', message: `stdout passed ${mode.maxBytes} bytes` });
        return;
      }
      this.#stdoutCapture.push(chunk);
      this.#stdoutBytes += chunk.length;
      return;
    }
    let start = 0;
    for (let nl = chunk.indexOf(NEWLINE); nl !== -1; nl = chunk.indexOf(NEWLINE, start)) {
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (this.#partialBytes + piece.length > mode.maxLineBytes) {
        this.#stop({ kind: 'violation', message: `stdout line is over ${mode.maxLineBytes} bytes` });
        return;
      }
      const bytes = this.#partialBytes === 0 ? piece : Buffer.concat([...this.#partial, piece]);
      this.#partial = [];
      this.#partialBytes = 0;
      if (!this.#line(bytes)) return;
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0) {
      if (this.#partialBytes + rest.length > mode.maxLineBytes) {
        this.#stop({ kind: 'violation', message: `stdout line is over ${mode.maxLineBytes} bytes` });
        return;
      }
      this.#partial.push(rest);
      this.#partialBytes += rest.length;
    }
  }

  /** One complete stdout line; false once the program was stopped. */
  #line(bytes: Buffer): boolean {
    let text: string;
    try {
      text = this.#decoder.decode(bytes);
    } catch {
      this.#stop({ kind: 'violation', message: 'stdout line is not valid UTF-8' });
      return false;
    }
    if (!this.#expecting) {
      this.#stop({ kind: 'violation', message: 'stdout line arrived while no reply was expected (out of lockstep)' });
      return false;
    }
    this.#expecting = false;
    if (this.budgetClock === 'think') this.#uncharge();
    // The reply hands the turn back (the header's Turns): the budget stops as it arrives, not when the harness reads it.
    else if (this.#opts.pauseOnLine === true) this.pause();
    const w = this.#waiter;
    if (w !== null) {
      this.#waiter = null;
      w.resolve(text);
    } else {
      this.#queue.push(text);
    }
    return true;
  }
}
