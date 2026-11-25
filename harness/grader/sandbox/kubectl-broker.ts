// The kubectl broker: where MAKEFUN_KUBECTL_BROKER is `1` (deploy/k8s/base/grader.yaml) every kubectl the process runs
// (k8s.ts kubectlExec: create, wait, delete, get, patch; no exec, as grading execs nothing over kubectl; in a grader pod
// only a call the in-process client could not ask, k8s-count.ts apiExec and the pod watch asking the API server
// themselves, so the broker idles but for those) is spawned by
// a small node child, this file run with KUBECTL_BROKER_FLAG, and its stdio is relayed over the child's IPC channel, so
// no kubectl is forked from the grader itself. spawn() forks, and on Linux a fork copies the parent's page tables: a prod grader at
// 1.4-1.65 GB resident spent 37.4 % of its main thread in uv_spawn at ~425 kubectl children a minute, ~52 ms of
// main-thread wall per spawn and 23.5 s of system time in 64 s (#877's profile, release 67d11bf). The broker is tens of
// MB, so its forks are cheap and off the grader's event loop; the grader pays a few IPC messages per kubectl.
// server/repos/git.ts's git broker does the same for git (whole runs: its caps and deadline run in its broker); this
// one relays streams (a kubectl's stdin, stdout and stderr as it runs: a create's manifest in, a watch's lines out).
//
// spawnPiped(command, args, env) is the one entry: a child with piped stdin, stdout and stderr and the events and
// methods k8s.ts reads of a ChildProcess ('error', 'exit', 'close', kill(), pid), the same either way. Through the
// broker:
//   - the child's stdout and stderr are Readables fed by the broker's chunks, each counting `bytesRead` as a pipe socket
//     does; a reader that holds back (push over the high-water mark) pauses the broker's read of that pipe, so kubectl
//     blocks on a full pipe as it would here, and a reader taking again resumes it;
//   - stdin is a Writable whose chunks the broker writes to kubectl's; up to STDIN_WINDOW_BYTES may be unacknowledged
//     before a write waits (its callback held until the broker says kubectl's stdin took them); end and destroy cross,
//     but a destroy of a stdin already finished (the autoDestroy after 'finish' above all) does not: what it wrote is
//     the broker's to deliver, as a pipe's kernel buffer delivers a finished socket's last bytes; a write error of
//     kubectl's stdin (EPIPE) destroys this stdin with it;
//   - 'exit' (code, signal) when the broker's kubectl exits, then stdin destroyed (as Node destroys a child's stdin at
//     its exit); 'close' once the exit came and stdout and stderr have closed here; a spawn that fails ('error' with no
//     pid: ENOENT for a kubectl not on PATH) emits 'error' and then 'close' with the errno, as Node does;
//   - kill(signal) is sent to the broker, which signals its kubectl; a SIGKILL with no exit KUBECTL_BROKER_STUCK_MS
//     later asks the broker about it (a ping, sent after this process's loop has read what the broker sent
//     meanwhile). The broker's answer comes after every message it sent before it and says how long ago, on its own
//     clock, it SIGKILLed that kubectl: under KUBECTL_BROKER_STUCK_MS (the broker was behind: stopped, starved) the
//     window runs on to that mark and asks again; past it, a child still without its exit has a kubectl that did not
//     die: that one child is recovered alone (its kubectl SIGKILLed again from here, its outputs ended, exit (null,
//     'SIGKILL') with `lost` saying why), the broker and every other kubectl kept. No answer KUBECTL_BROKER_PROBE_MS
//     on takes the broker as wedged: it is SIGKILLed, which ends its children as below, unless that deadline fired
//     more than KUBECTL_BROKER_STALL_MS late: then this process's own main thread was held (the answer may be in the
//     pipe unread), which is never taken as the broker's silence: it waits again.
//
// Never a silent no-op: where the broker is asked for and cannot run, stderr says so (once per process for a bundle,
// once per failed start, once per broker that went before it said ready) and each kubectl spawned here instead counts
// on makefun_kubectl_broker_fallbacks_total{reason} (kubectlBrokerTally, read by server/ops/metrics.ts at each scrape);
// the children the broker ran count on makefun_kubectl_broker_spawns_total{outcome}.
//
//   parent -> broker  {t: 'spawn', id, cmd, args, env, cwd}; then per child {t: 'in', id, chunk}, {t: 'inend', id},
//                     {t: 'indestroy', id}, {t: 'pause' | 'resume' | 'outdestroy', id, fd}, {t: 'kill', id, signal};
//                     {t: 'ping', seq, id} (the stuck guard's question about child id)
//   broker -> parent  {t: 'ready'} first; then per child {t: 'started', id, pid} or {t: 'spawnerr', id, error};
//                     {t: 'out', id, fd, chunk}, {t: 'outend', id, fd} (its pipe closed), {t: 'inack', id, bytes},
//                     {t: 'inerr', id, error}, {t: 'exit', id, code, signal}, {t: 'closed', id} (its last message);
//                     {t: 'pong', seq, killedMsAgo} at once for each ping: how long ago, on the broker's clock, it
//                     SIGKILLed that child's kubectl (null: it has no such kubectl, or sent it no SIGKILL)
//
// Advanced serialization: a chunk crosses as a Buffer. The env is the caller's (kubectlEnv), the cwd this process's,
// so neither the broker's environment nor its working directory matters.
//
// When the broker goes (a crash, a kill, a wedge), each child it had spawned (`started` came) has its kubectl SIGKILLed
// by pid, its stdout and stderr end with what came, and it exits (null, 'SIGKILL') with `lost` saying why (kubectlExec
// puts that on its result's error); each child it had not spawned is spawned here instead, the stdin written so far
// replayed into it (a child already killed is not spawned: it exits (null, its signal)). A broker that goes before it
// said ready, or whose spawn throws, is not tried again for KUBECTL_BROKER_RETRY_MS (kubectl spawns here meanwhile);
// one that ran is started afresh on the next spawn. When this process goes, the broker SIGKILLs its kubectls and exits.
// While no child is in flight the broker holds this process's event loop open no more than an idle socket would.
//
// Started at boot (bootKubectlBroker, from server/index.ts before the app's module graph loads: its one fork copies a
// process of tens of MB, not the booted grader's gigabytes) or else on the first spawn; never from a bundle of this
// module, which has no file of its own to run. This file imports node's own modules only, so the broker stays small.

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve as resolvePath, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

/** The environment variable that turns the broker on (`1`); read at boot (bootKubectlBroker) or else on the first spawn. */
export const KUBECTL_BROKER_ENV = 'MAKEFUN_KUBECTL_BROKER';
/** The broker child's argv flag. */
const KUBECTL_BROKER_FLAG = '--makefun-kubectl-broker';
/** How long kubectl spawns here after a broker went before it said ready, or its spawn threw. */
export const KUBECTL_BROKER_RETRY_MS = 60_000;
/** How long a killed child may go without its exit before the broker is asked (a ping) whether it still answers. */
export const KUBECTL_BROKER_STUCK_MS = 30_000;
/** How long the broker has to answer that ping before it is taken as wedged and SIGKILLed, every kubectl of it with it. */
export const KUBECTL_BROKER_PROBE_MS = 10_000;
/**
 * How late the ping's deadline may fire and still be read as the broker's silence: later than this, this process's own
 * event loop was held past it (a main-thread stall), so the broker's answer may be in the pipe unread, and the deadline
 * waits KUBECTL_BROKER_PROBE_MS again instead. (The stuck window itself needs no such guard: its end only asks, and the
 * answer comes after every exit the broker sent before it.)
 */
export const KUBECTL_BROKER_STALL_MS = 2_000;
/** Bytes of one child's stdin sent to the broker and not yet written to its kubectl before a write waits. */
export const STDIN_WINDOW_BYTES = 1024 * 1024;

/**
 * How a child the broker took ended (makefun_kubectl_broker_spawns_total's `outcome`): done (it ran and its last
 * message came), spawn_failed (the broker's spawn failed: no such kubectl) or lost (the broker went while it ran: its
 * kubectl killed; a wedged broker's included; or its kubectl, killed, had not exited by the stuck guard's answered ping,
 * and was ended alone).
 */
export const KUBECTL_BROKER_SPAWN_OUTCOMES = ['done', 'spawn_failed', 'lost'] as const;
export type KubectlBrokerSpawnOutcome = (typeof KUBECTL_BROKER_SPAWN_OUTCOMES)[number];

/**
 * Why a kubectl in a process that asks for the broker was spawned here instead (makefun_kubectl_broker_fallbacks_total's
 * `reason`): no_entry (this module is a bundle, not grader/sandbox/kubectl-broker.ts on disk: no broker can ever run),
 * start_failed (the broker's spawn threw), retry_wait (inside KUBECTL_BROKER_RETRY_MS of a broker that went before it
 * said ready), send_failed (the spawn's IPC send failed), no_cwd (this process's working directory is gone) or
 * broker_gone (the broker went before it spawned the kubectl).
 */
export const KUBECTL_BROKER_FALLBACK_REASONS = ['no_entry', 'start_failed', 'retry_wait', 'send_failed', 'no_cwd', 'broker_gone'] as const;
export type KubectlBrokerFallbackReason = (typeof KUBECTL_BROKER_FALLBACK_REASONS)[number];

/** What kubectlBrokerTally reads: every outcome and every reason, 0 until one happens; only ever grows. */
export interface KubectlBrokerTally {
  spawns: Record<KubectlBrokerSpawnOutcome, number>;
  fallbacks: Record<KubectlBrokerFallbackReason, number>;
}

const counts: KubectlBrokerTally = {
  spawns: { done: 0, spawn_failed: 0, lost: 0 },
  fallbacks: { no_entry: 0, start_failed: 0, retry_wait: 0, send_failed: 0, no_cwd: 0, broker_gone: 0 },
};

/** This process's broker spawns and fallbacks since it loaded this module (a copy: the counts keep growing). */
export function kubectlBrokerTally(): KubectlBrokerTally {
  return { spawns: { ...counts.spawns }, fallbacks: { ...counts.fallbacks } };
}

function fellBack(reason: KubectlBrokerFallbackReason): void {
  counts.fallbacks[reason] += 1;
}

/**
 * A child with its stdio piped, as k8s.ts reads one: a ChildProcess spawned here, or one the broker runs. `lost` is set
 * on a brokered child whose broker went while it ran (why; its kubectl was killed).
 */
export interface PipedChild extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number | undefined;
  readonly lost?: string | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** `command args` with stdio piped and `env` its whole environment, spawned here (no broker). */
function spawnHere(command: string, args: readonly string[], env: Record<string, string>): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env });
}

/**
 * Spawn `command args` with stdin, stdout and stderr piped and `env` its whole environment: through the broker where
 * the process asks for it (MAKEFUN_KUBECTL_BROKER=1, or startKubectlBroker()), else here; where the broker is asked for
 * and cannot run, here, said and counted (the header).
 */
export function spawnPiped(command: string, args: readonly string[], env: Record<string, string>): PipedChild {
  const broker = brokerFor();
  if (broker === null) return spawnHere(command, args, env);
  if (typeof broker === 'string') {
    fellBack(broker);
    return spawnHere(command, args, env);
  }
  return broker.spawn(command, args, env);
}

// ---------------------------------------------------------------- the wire

type Fd = 1 | 2;

type ToBroker =
  | { t: 'spawn'; id: number; cmd: string; args: string[]; env: Record<string, string>; cwd: string }
  | { t: 'in'; id: number; chunk: Buffer }
  | { t: 'inend'; id: number }
  | { t: 'indestroy'; id: number }
  | { t: 'pause'; id: number; fd: Fd }
  | { t: 'resume'; id: number; fd: Fd }
  | { t: 'outdestroy'; id: number; fd: Fd }
  | { t: 'kill'; id: number; signal: NodeJS.Signals | number }
  | { t: 'ping'; seq: number; id: number };

type FromBroker =
  | { t: 'ready' }
  | { t: 'pong'; seq: number; killedMsAgo: number | null }
  | { t: 'started'; id: number; pid: number }
  | { t: 'spawnerr'; id: number; error: WireError }
  | { t: 'out'; id: number; fd: Fd; chunk: Buffer }
  | { t: 'outend'; id: number; fd: Fd }
  | { t: 'inack'; id: number; bytes: number }
  | { t: 'inerr'; id: number; error: WireError }
  | { t: 'exit'; id: number; code: number | null; signal: NodeJS.Signals | null }
  | { t: 'closed'; id: number };

interface WireError {
  name: string;
  message: string;
  props: Record<string, unknown>;
}

/** The fields of a Node system error a caller may read (err.code above all). */
const WIRE_ERROR_PROPS = ['code', 'errno', 'syscall', 'path', 'spawnargs'] as const;

function errorToWire(err: unknown): WireError {
  if (!(err instanceof Error)) return { name: 'Error', message: String(err), props: {} };
  const props: Record<string, unknown> = {};
  for (const k of WIRE_ERROR_PROPS) {
    const v = (err as unknown as Record<string, unknown>)[k];
    if (v !== undefined) props[k] = v;
  }
  return { name: err.name, message: err.message, props };
}

function errorFromWire(w: WireError): Error {
  const err = new Error(w.message);
  if (w.name !== 'Error') err.name = w.name;
  Object.assign(err, w.props);
  return err;
}

// ---------------------------------------------------------------- a brokered child, this side

/** A Readable fed from elsewhere, counting the bytes it was fed as a pipe socket's bytesRead does. */
type FedReadable = Readable & { bytesRead: number };

/** One of a brokered child's outputs: the stream its reader holds, and where its bytes come from. */
interface Out {
  readonly fd: Fd;
  readonly stream: FedReadable;
  /** The source sent its end (or will send nothing more): no chunk is pushed after it. */
  ended: boolean;
  /** A pause was sent to the broker (or the local source was paused) and not yet undone. */
  paused: boolean;
  /** The local child's pipe, once the child was spawned here instead. */
  source: Readable | null;
}

/** What a brokered child's owner gives it: its broker's send, and word of its end. */
interface BrokerPort {
  post(m: ToBroker): void;
  armStuck(child: BrokeredChild): void;
}

class BrokeredChild extends EventEmitter implements PipedChild {
  readonly stdin: Writable;
  readonly stdout: FedReadable;
  readonly stderr: FedReadable;
  pid: number | undefined = undefined;
  lost: string | null = null;

  readonly #id: number;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #env: Record<string, string>;
  #port: BrokerPort | null;
  /** The child spawned here when the broker went before it spawned one. */
  #local: ChildProcessWithoutNullStreams | null = null;
  readonly #outs: Record<Fd, Out>;
  #started = false;
  /** stdin written before the broker said it spawned: replayed into a child spawned here instead. */
  #pendingIn: Buffer[] = [];
  #inEnded = false;
  #inDestroyed = false;
  /** stdin bytes sent and not yet acknowledged, and the write callbacks waiting on the window. */
  #inFlight = 0;
  #inWaiters: Array<() => void> = [];
  /** A destroy of stdin from this side's own bookkeeping (the exit, the broker's error), never sent. */
  #quietIn = false;
  #killedWith: NodeJS.Signals | number | null = null;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  #exitEmitted = false;
  #closeEmitted = false;
  #outsClosed = 0;

  constructor(id: number, command: string, args: readonly string[], env: Record<string, string>, port: BrokerPort) {
    super();
    this.#id = id;
    this.#command = command;
    this.#args = args;
    this.#env = env;
    this.#port = port;
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => this.#writeIn(chunk, cb),
      final: (cb) => this.#endIn(cb),
      destroy: (err, cb) => {
        this.#destroyIn();
        cb(err);
      },
    });
    this.#outs = { 1: this.#out(1), 2: this.#out(2) };
    this.stdout = this.#outs[1].stream;
    this.stderr = this.#outs[2].stream;
  }

  get id(): number {
    return this.#id;
  }

  get started(): boolean {
    return this.#started;
  }

  get exited(): boolean {
    return this.#exit !== null;
  }

  #out(fd: Fd): Out {
    const out: Out = {
      fd,
      ended: false,
      paused: false,
      source: null,
      stream: new Readable({
        read: () => this.#resumeOut(out),
        destroy: (err, cb) => {
          this.#destroyOut(out);
          cb(err);
        },
      }) as FedReadable,
    };
    out.stream.bytesRead = 0;
    out.stream.once('close', () => {
      this.#outsClosed += 1;
      this.#maybeClose();
    });
    return out;
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.#local !== null) return this.#local.kill(signal);
    if (this.#exit !== null || this.#port === null) return false;
    this.#killedWith = signal;
    this.#port.post({ t: 'kill', id: this.#id, signal });
    // only a SIGKILL must end it: a kubectl may outlive another signal on purpose
    if (signal === 'SIGKILL' || signal === 9) this.#port.armStuck(this);
    return true;
  }

  // ---- the broker's messages

  onStarted(pid: number): void {
    this.#started = true;
    this.pid = pid;
    this.#pendingIn = [];
  }

  onSpawnError(err: Error): void {
    this.#port = null;
    this.#spawnFailed(err);
  }

  onOut(fd: Fd, chunk: Buffer): void {
    const out = this.#outs[fd];
    if (out.ended || out.stream.destroyed) return;
    out.stream.bytesRead += chunk.byteLength;
    if (!out.stream.push(chunk) && !out.paused) {
      out.paused = true;
      this.#port?.post({ t: 'pause', id: this.#id, fd });
    }
  }

  onOutEnd(fd: Fd): void {
    this.#endOut(this.#outs[fd]);
  }

  onInAck(bytes: number): void {
    this.#inFlight -= bytes;
    while (this.#inFlight <= STDIN_WINDOW_BYTES && this.#inWaiters.length > 0) this.#inWaiters.shift()!();
  }

  onInError(err: Error): void {
    if (this.stdin.destroyed) return;
    this.#quietIn = true;
    this.stdin.destroy(err);
  }

  onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exit !== null) return;
    this.#exit = { code, signal };
    this.#releaseIn();
    if (!this.stdin.destroyed) {
      this.#quietIn = true;
      this.stdin.destroy();
    }
    this.#exitEmitted = true;
    this.emit('exit', code, signal);
    this.#maybeClose();
  }

  /** The broker's last word on it (its kubectl closed): nothing more comes, so every output still open ends here. */
  onClosed(): void {
    this.#port = null;
    for (const out of Object.values(this.#outs)) this.#endOut(out);
  }

  /** The broker went while its kubectl ran: kill that kubectl, end what is open, exit (null, 'SIGKILL') if not yet. */
  onLost(why: string): void {
    this.#port = null;
    // a kubectl whose exit came is gone (its pid may be another process's by now): only one still running is killed
    if (this.pid !== undefined && this.#exit === null) {
      try {
        process.kill(this.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    if (this.#exit === null) this.lost = why;
    for (const out of Object.values(this.#outs)) this.#endOut(out);
    this.onExit(null, 'SIGKILL');
  }

  /** The broker went before it spawned this child (or never got it): spawn it here, its stdin so far replayed. */
  spawnHereInstead(): void {
    this.#port = null;
    if (this.#killedWith !== null) {
      // killed before it ever ran: as a kill of a running kubectl ends, with nothing of it run
      for (const out of Object.values(this.#outs)) this.#endOut(out);
      this.onExit(null, typeof this.#killedWith === 'string' ? this.#killedWith : 'SIGKILL');
      return;
    }
    let local: ChildProcessWithoutNullStreams;
    try {
      local = spawnHere(this.#command, this.#args, this.#env);
    } catch (err) {
      this.#spawnFailed(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.#local = local;
    this.pid = local.pid;
    const stdin = local.stdin;
    stdin.on('error', (err) => {
      if (this.stdin.destroyed) return;
      this.#quietIn = true;
      this.stdin.destroy(err);
    });
    for (const chunk of this.#pendingIn) stdin.write(chunk);
    this.#pendingIn = [];
    this.#releaseIn();
    if (this.#inDestroyed) stdin.destroy();
    else if (this.#inEnded) stdin.end();
    for (const [fd, source] of [
      [1, local.stdout],
      [2, local.stderr],
    ] as const) {
      const out = this.#outs[fd];
      out.source = source;
      if (out.stream.destroyed) {
        source.destroy();
        continue;
      }
      source.on('data', (chunk: Buffer) => {
        if (out.ended || out.stream.destroyed) return;
        out.stream.bytesRead += chunk.byteLength;
        if (!out.stream.push(chunk)) {
          out.paused = true;
          source.pause();
        }
      });
      source.on('error', () => undefined);
      source.once('close', () => this.#endOut(out));
    }
    local.on('error', (err) => {
      // an 'error' with a pid is a kill or a write that failed: the exit still comes
      if (local.pid === undefined) this.#spawnFailed(err);
    });
    local.once('exit', (code, signal) => this.onExit(code, signal));
  }

  // ---- stdin

  #writeIn(chunk: Buffer, cb: (err?: Error | null) => void): void {
    if (this.#local !== null) {
      this.#local.stdin.write(chunk, () => cb());
      return;
    }
    if (chunk.byteLength === 0 || this.#port === null) {
      cb();
      return;
    }
    if (!this.#started) this.#pendingIn.push(chunk);
    this.#inFlight += chunk.byteLength;
    this.#port.post({ t: 'in', id: this.#id, chunk });
    if (this.#inFlight <= STDIN_WINDOW_BYTES) cb();
    else this.#inWaiters.push(() => cb());
  }

  #endIn(cb: (err?: Error | null) => void): void {
    this.#inEnded = true;
    if (this.#local !== null) this.#local.stdin.end();
    else this.#port?.post({ t: 'inend', id: this.#id });
    cb();
  }

  #destroyIn(): void {
    this.#releaseIn();
    // Finished (ended, every write called back: the autoDestroy after 'finish' among them), what it wrote is the
    // broker's to deliver, as a pipe's kernel buffer delivers what a finished socket wrote: a destroy then cuts nothing.
    if (this.#quietIn || this.stdin.writableFinished) return;
    this.#inDestroyed = true;
    if (this.#local !== null) this.#local.stdin.destroy();
    else this.#port?.post({ t: 'indestroy', id: this.#id });
  }

  /** Let every write waiting on the window go (the child is gone, or stdin is). */
  #releaseIn(): void {
    this.#inFlight = 0;
    const waiters = this.#inWaiters;
    this.#inWaiters = [];
    for (const w of waiters) w();
  }

  // ---- stdout and stderr

  #resumeOut(out: Out): void {
    if (!out.paused) return;
    out.paused = false;
    if (out.source !== null) out.source.resume();
    else this.#port?.post({ t: 'resume', id: this.#id, fd: out.fd });
  }

  #destroyOut(out: Out): void {
    if (out.ended) return;
    out.ended = true;
    if (out.source !== null) out.source.destroy();
    else this.#port?.post({ t: 'outdestroy', id: this.#id, fd: out.fd });
  }

  #endOut(out: Out): void {
    if (out.ended) return;
    out.ended = true;
    if (!out.stream.destroyed) out.stream.push(null);
  }

  // ---- the end

  #spawnFailed(err: Error): void {
    if (this.#exit !== null) return;
    // As Node: 'error' (no pid), stdio closed, then 'close' with the errno and no 'exit'.
    const errno = (err as NodeJS.ErrnoException).errno;
    this.#exit = { code: typeof errno === 'number' ? errno : null, signal: null };
    this.#releaseIn();
    this.emit('error', err);
    this.#quietIn = true;
    this.stdin.destroy();
    for (const out of Object.values(this.#outs)) {
      out.ended = true;
      out.stream.destroy();
    }
  }

  #maybeClose(): void {
    if (this.#closeEmitted || this.#exit === null || this.#outsClosed < 2) return;
    this.#closeEmitted = true;
    const { code, signal } = this.#exit;
    // on the next turn, as Node emits a child's 'close' after its 'exit' handlers ran
    process.nextTick(() => this.emit('close', code, signal));
  }

  /** Whether 'exit' (or a failed spawn) has been seen: the stuck guard's question. */
  get ended(): boolean {
    return this.#exitEmitted || this.#exit !== null;
  }
}

// ---------------------------------------------------------------- the broker, this side

/**
 * The stuck guard's watch on one SIGKILLed child (the header): the deadline it waits on (its timer, then the check that
 * runs after the turn's poll), and the ping it asked once the stuck window passed.
 */
interface StuckWatch {
  timer: NodeJS.Timeout | null;
  check: NodeJS.Immediate | null;
  probe: number | null;
}

class KubectlBroker {
  readonly #children = new Map<number, BrokeredChild>();
  readonly #stuck = new Map<BrokeredChild, StuckWatch>();
  /** Each ping not yet answered, by its seq: the child whose watch asked it. */
  readonly #probes = new Map<number, BrokeredChild>();
  #nextProbe = 1;
  #nextId = 1;
  #ready = false;
  #stopping = false;
  gone = false;
  readonly exited: Promise<void>;
  readonly #child: ChildProcess;
  readonly #port: BrokerPort;

  private constructor(child: ChildProcess) {
    this.#child = child;
    let exited!: () => void;
    this.exited = new Promise((res) => (exited = res));
    // 'exit', not 'close': the broker has no stdio pipe (as git.ts's broker)
    child.once('exit', () => exited());
    child.on('message', (m: FromBroker) => this.#onMessage(m));
    // the channel ends after every message the broker wrote has been read: no answer is lost to it
    child.on('disconnect', () => this.#onGone('exited'));
    child.on('error', (err) => {
      // a broker that could not be spawned; a failed kill or send names a broker already going
      if (child.pid === undefined) {
        this.#onGone(`could not start (${err.message})`);
        exited();
      }
    });
    child.unref();
    child.channel?.unref();
    this.#port = {
      post: (m) => this.#post(m),
      armStuck: (c) => this.#armStuck(c),
    };
  }

  /** Spawn a broker; what the spawn threw, when it throws. */
  static start(entry: string): KubectlBroker | { error: unknown } {
    try {
      return new KubectlBroker(spawn(process.execPath, [entry, KUBECTL_BROKER_FLAG], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced' }));
    } catch (error) {
      return { error };
    }
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  spawn(command: string, args: readonly string[], env: Record<string, string>): PipedChild {
    let cwd: string;
    try {
      cwd = resolvePath('.');
    } catch {
      // no working directory (removed under us): as a spawn here would meet it
      fellBack('no_cwd');
      return spawnHere(command, args, env);
    }
    const id = this.#nextId++;
    const child = new BrokeredChild(id, command, args, env, this.#port);
    const message: ToBroker = { t: 'spawn', id, cmd: command, args: [...args], env: { ...env }, cwd };
    this.#children.set(id, child);
    this.#holdLoop();
    try {
      this.#child.send(message, undefined, {}, (err) => {
        if (err) this.#sendFailed(id);
      });
    } catch {
      // a value structured clone refuses, a channel already closed
      this.#children.delete(id);
      this.#holdLoop();
      fellBack('send_failed');
      return spawnHere(command, args, env);
    }
    return child;
  }

  /** Finish in-flight children, then end the broker; resolves once it has exited. */
  stop(): Promise<void> {
    this.#stopping = true;
    if (!this.gone) this.#child.ref(); // held until it has exited: the caller waits on that
    this.#holdLoop();
    return this.exited;
  }

  #post(m: ToBroker): void {
    if (this.gone) return;
    try {
      this.#child.send(m, undefined, {}, () => undefined);
    } catch {
      // a channel already closed: its disconnect ends the children
    }
  }

  #sendFailed(id: number): void {
    const child = this.#children.get(id);
    if (child === undefined || child.started) return;
    this.#settle(id, child);
    fellBack('send_failed');
    child.spawnHereInstead();
  }

  #onMessage(m: FromBroker): void {
    if (m.t === 'ready') {
      this.#ready = true;
      return;
    }
    if (m.t === 'pong') {
      this.#onPong(m.seq, m.killedMsAgo);
      return;
    }
    const child = this.#children.get(m.id);
    if (child === undefined) return;
    switch (m.t) {
      case 'started':
        child.onStarted(m.pid);
        return;
      case 'spawnerr':
        this.#settle(m.id, child);
        counts.spawns.spawn_failed += 1;
        child.onSpawnError(errorFromWire(m.error));
        return;
      case 'out':
        child.onOut(m.fd, Buffer.isBuffer(m.chunk) ? m.chunk : Buffer.from(m.chunk));
        return;
      case 'outend':
        child.onOutEnd(m.fd);
        return;
      case 'inack':
        child.onInAck(m.bytes);
        return;
      case 'inerr':
        child.onInError(errorFromWire(m.error));
        return;
      case 'exit':
        this.#clearStuck(child);
        child.onExit(m.code, m.signal);
        return;
      case 'closed':
        this.#settle(m.id, child);
        counts.spawns.done += 1;
        child.onClosed();
        return;
    }
  }

  #settle(id: number, child: BrokeredChild): void {
    this.#children.delete(id);
    this.#clearStuck(child);
    this.#holdLoop();
  }

  /** A SIGKILL was sent for `child`: watch for its exit (the header's stuck guard). */
  #armStuck(child: BrokeredChild): void {
    if (this.#stuck.has(child) || this.gone) return;
    const watch: StuckWatch = { timer: null, check: null, probe: null };
    this.#stuck.set(child, watch);
    this.#deadline(child, watch, KUBECTL_BROKER_STUCK_MS, () => this.#ask(child, watch));
  }

  /**
   * Run `then(lateMs)` `ms` from now, unless the watch was cleared or the child's exit came first. Never straight from
   * the timer: libuv runs the expired timers of a turn before its poll reads the pipe, so after a stall of this process's
   * main thread the broker's answer (an exit, a pong) may be there unread. The check runs on setImmediate, after this
   * turn's poll; how late the timer itself fired is what it is handed (performance.now: monotonic).
   */
  #deadline(child: BrokeredChild, watch: StuckWatch, ms: number, then: (lateMs: number) => void): void {
    const due = performance.now() + ms;
    watch.timer = setTimeout(() => {
      watch.timer = null;
      const lateMs = performance.now() - due;
      watch.check = setImmediate(() => {
        watch.check = null;
        if (this.#stuck.get(child) !== watch || this.gone) return;
        if (child.ended) {
          this.#clearStuck(child);
          return;
        }
        then(lateMs);
      });
      watch.check.unref();
    }, ms);
    watch.timer.unref();
  }

  /** The stuck window passed with no exit: ask the broker whether it still answers, and wait KUBECTL_BROKER_PROBE_MS for it. */
  #ask(child: BrokeredChild, watch: StuckWatch): void {
    const seq = this.#nextProbe++;
    watch.probe = seq;
    this.#probes.set(seq, child);
    this.#post({ t: 'ping', seq, id: child.id });
    const wait = (): void =>
      this.#deadline(child, watch, KUBECTL_BROKER_PROBE_MS, (lateMs) => {
        // this process's own stall, not the broker's silence: its answer may be in the pipe, read once the loop runs
        if (lateMs > KUBECTL_BROKER_STALL_MS) wait();
        else this.#wedged(child);
      });
    wait();
  }

  /**
   * The broker answered a ping. Its answer comes after every message it sent before it, so the asking child's exit,
   * had the broker seen one, has been read here. A broker that SIGKILLed the kubectl under KUBECTL_BROKER_STUCK_MS ago
   * (it took the kill late: stopped, starved, behind on its pipe) gives it the rest of that window, then is asked again.
   * Past it, the kubectl did not die of its SIGKILL (or the broker had none to kill): it is recovered alone; the broker
   * and every other kubectl stay.
   */
  #onPong(seq: number, killedMsAgo: number | null): void {
    const child = this.#probes.get(seq);
    if (child === undefined) return;
    this.#probes.delete(seq);
    const watch = this.#stuck.get(child);
    if (watch === undefined || watch.probe !== seq) return;
    if (child.ended) {
      this.#clearStuck(child);
      return;
    }
    if (killedMsAgo !== null && killedMsAgo < KUBECTL_BROKER_STUCK_MS) {
      // the ping's own deadline is done with: the window runs on, from the broker's kill
      if (watch.timer !== null) clearTimeout(watch.timer);
      if (watch.check !== null) clearImmediate(watch.check);
      watch.timer = null;
      watch.check = null;
      watch.probe = null;
      this.#deadline(child, watch, Math.max(1, Math.ceil(KUBECTL_BROKER_STUCK_MS - killedMsAgo)), () => this.#ask(child, watch));
      return;
    }
    this.#recover(child);
  }

  /** End one child whose kubectl did not exit of its SIGKILL: SIGKILLed again from here, counted lost, the broker kept. */
  #recover(child: BrokeredChild): void {
    this.#settle(child.id, child);
    counts.spawns.lost += 1;
    const kubectl = `kubectl (pid ${child.pid ?? 'none'})`;
    console.error(
      `kubectl broker (pid ${this.#child.pid}): a killed ${kubectl} has not exited ${KUBECTL_BROKER_STUCK_MS} ms on, though the broker answers: killing it from here and ending it alone (the broker and its ${this.#children.size} other kubectl(s) in flight kept)`,
    );
    child.onLost(`its ${kubectl} had not exited ${KUBECTL_BROKER_STUCK_MS} ms after a SIGKILL, though the kubectl broker (pid ${this.#child.pid}) answered (killed again from this process)`);
  }

  #clearStuck(child: BrokeredChild): void {
    const watch = this.#stuck.get(child);
    if (watch === undefined) return;
    if (watch.timer !== null) clearTimeout(watch.timer);
    if (watch.check !== null) clearImmediate(watch.check);
    if (watch.probe !== null) this.#probes.delete(watch.probe);
    this.#stuck.delete(child);
  }

  /** Hold this process's event loop open while a child is in flight, as a running kubectl would; end a stopping broker once none is. */
  #holdLoop(): void {
    if (this.gone) return;
    if (this.#children.size > 0) this.#child.channel?.ref();
    else if (!this.#stopping) this.#child.channel?.unref();
    else if (this.#child.connected) this.#child.disconnect();
  }

  /** The broker did not answer the ping `child`'s watch asked, with this process's loop awake for the window: it is wedged. */
  #wedged(child: BrokeredChild): void {
    if (this.gone) return;
    console.error(
      `kubectl broker (pid ${this.#child.pid}): a killed kubectl (pid ${child.pid ?? 'none'}) has not exited ${KUBECTL_BROKER_STUCK_MS} ms on and the broker has not answered in ${KUBECTL_BROKER_PROBE_MS} ms; killing the broker`,
    );
    try {
      this.#child.kill('SIGKILL');
    } catch {
      // already gone: its disconnect ends the children
    }
  }

  #onGone(why: string): void {
    if (this.gone) return;
    this.gone = true;
    if (kubectlBroker === this) kubectlBroker = null;
    if (!this.#ready) {
      brokerRetryAt = Date.now() + KUBECTL_BROKER_RETRY_MS;
      if (!this.#stopping) {
        console.error(
          `kubectl broker (pid ${this.#child.pid ?? 'none'}) ${why} before it said ready: every kubectl spawns in this process for the next ${KUBECTL_BROKER_RETRY_MS / 1000} s (makefun_kubectl_broker_fallbacks_total)`,
        );
      }
    }
    if (this.#children.size > 0 && !this.#stopping) console.error(`kubectl broker (pid ${this.#child.pid}) ${why} with ${this.#children.size} kubectl(s) in flight`);
    for (const child of [...this.#stuck.keys()]) this.#clearStuck(child);
    this.#probes.clear();
    const children = [...this.#children.values()];
    this.#children.clear();
    for (const child of children) {
      if (child.started) {
        if (child.exited) counts.spawns.done += 1;
        else counts.spawns.lost += 1;
        child.onLost(`the kubectl broker (pid ${this.#child.pid}) ${why} while kubectl ran (kubectl was killed)`);
      } else {
        fellBack('broker_gone');
        child.spawnHereInstead();
      }
    }
  }
}

/** Whether this process spawns its kubectl through the broker: MAKEFUN_KUBECTL_BROKER, read once, unless start/stop said. */
let brokerWanted: boolean | undefined;
let kubectlBroker: KubectlBroker | null = null;
/** Epoch ms before which no broker is started (one went before it said ready, or its spawn threw). */
let brokerRetryAt = 0;
/** Whether the line saying a bundle cannot run the broker has been written (once per process). */
let noEntrySaid = false;

/** This module's URL, named by the line that says a bundle cannot run the broker. */
const MODULE_URL: string = import.meta.url;

/** This module's file, the broker's entry; null when it is not grader/sandbox/kubectl-broker.ts on disk (a bundle). */
const BROKER_ENTRY: string | null = (() => {
  try {
    const file = fileURLToPath(import.meta.url);
    return file.endsWith(`${sep}grader${sep}sandbox${sep}kubectl-broker.ts`) ? file : null;
  } catch {
    return null;
  }
})();

/**
 * The broker spawnPiped hands its child to, started if need be; null where the broker is not asked for; where it is and
 * cannot run, why (a KubectlBrokerFallbackReason; the caller counts its spawn), said on stderr as the header says.
 */
function brokerFor(): KubectlBroker | KubectlBrokerFallbackReason | null {
  brokerWanted ??= process.env[KUBECTL_BROKER_ENV] === '1';
  if (!brokerWanted) return null;
  if (BROKER_ENTRY === null) {
    if (!noEntrySaid) {
      noEntrySaid = true;
      console.error(
        `kubectl broker: asked for (${KUBECTL_BROKER_ENV}=1 or startKubectlBroker) but cannot run: this module (${MODULE_URL}) is not grader/sandbox/kubectl-broker.ts on disk (a bundle), so every kubectl spawns in this process, forking it (makefun_kubectl_broker_fallbacks_total{reason="no_entry"})`,
      );
    }
    return 'no_entry';
  }
  if (kubectlBroker !== null && !kubectlBroker.gone) return kubectlBroker;
  if (Date.now() < brokerRetryAt) return 'retry_wait';
  const started = KubectlBroker.start(BROKER_ENTRY);
  if (started instanceof KubectlBroker) {
    kubectlBroker = started;
    return started;
  }
  kubectlBroker = null;
  brokerRetryAt = Date.now() + KUBECTL_BROKER_RETRY_MS;
  const why = started.error instanceof Error ? started.error.message : String(started.error);
  console.error(
    `kubectl broker: could not start (${why}): every kubectl spawns in this process for the next ${KUBECTL_BROKER_RETRY_MS / 1000} s (makefun_kubectl_broker_fallbacks_total{reason="start_failed"})`,
  );
  return 'start_failed';
}

/**
 * Spawn this process's kubectl through the broker from now on, whatever MAKEFUN_KUBECTL_BROKER says, and start it now
 * (a boot that calls it takes the broker's one fork while the process is still small). Returns the broker's pid, or
 * null where it cannot run (a bundle of this module, a spawn that throws or fails: kubectl spawns here, and stderr says
 * why).
 */
export function startKubectlBroker(): number | null {
  brokerWanted = true;
  brokerRetryAt = 0;
  const broker = brokerFor();
  return broker instanceof KubectlBroker ? (broker.pid ?? null) : null;
}

/**
 * The boot's start of the broker (server/index.ts, before the app's module graph loads, so the broker's one fork copies
 * a small process): where `env` asks for it (MAKEFUN_KUBECTL_BROKER=1, the grader) start it and say so on one line, its
 * pid on stdout, or why it cannot run on stderr (brokerFor's lines). Returns the broker's pid; null where `env` does
 * not ask for it (nothing is started or said; the variable is still read on the first spawn) or it cannot run.
 */
export function bootKubectlBroker(env: NodeJS.ProcessEnv = process.env): number | null {
  if (env[KUBECTL_BROKER_ENV] !== '1') return null;
  const pid = startKubectlBroker();
  if (pid !== null) console.log(`kubectl broker: pid ${pid} spawns this process's kubectl (${KUBECTL_BROKER_ENV}=1), started at boot`);
  return pid;
}

/** Spawn kubectl here from now on; the broker finishes its in-flight children and exits (resolves once it has). */
export async function stopKubectlBroker(): Promise<void> {
  brokerWanted = false;
  const broker = kubectlBroker;
  kubectlBroker = null;
  if (broker !== null) await broker.stop();
}

// ---------------------------------------------------------------- the broker's side

/** The broker: spawn each request's command, relay its stdio and its end; SIGKILL what runs and exit when the parent goes. */
function serveAsKubectlBroker(): void {
  brokerWanted = false; // its own spawns never look for a broker
  const children = new Map<number, ChildProcess>();
  /** When (performance.now) each child's kubectl was first sent a SIGKILL here: a ping's answer says how long ago. */
  const killedAt = new Map<number, number>();
  const reply = (m: FromBroker) => {
    if (process.connected) process.send?.(m, undefined, {}, () => undefined);
  };
  const spawnOne = (m: Extract<ToBroker, { t: 'spawn' }>): void => {
    const { id } = m;
    let child: ChildProcess;
    try {
      child = spawn(m.cmd, m.args, { stdio: ['pipe', 'pipe', 'pipe'], env: m.env, cwd: m.cwd });
    } catch (err) {
      reply({ t: 'spawnerr', id, error: errorToWire(err) });
      return;
    }
    if (child.pid === undefined) {
      // ENOENT and its like: Node emits the 'error' on the next turn
      child.once('error', (err) => reply({ t: 'spawnerr', id, error: errorToWire(err) }));
      return;
    }
    children.set(id, child);
    reply({ t: 'started', id, pid: child.pid });
    for (const [fd, out] of [
      [1, child.stdout!],
      [2, child.stderr!],
    ] as const) {
      out.on('data', (chunk: Buffer) => reply({ t: 'out', id, fd, chunk }));
      out.on('error', () => undefined);
      out.once('close', () => reply({ t: 'outend', id, fd }));
    }
    child.stdin!.on('error', (err: NodeJS.ErrnoException) => {
      // a write after the exit (Node destroyed stdin then) fails here as it would there, with no error event
      if (err.code !== 'ERR_STREAM_DESTROYED') reply({ t: 'inerr', id, error: errorToWire(err) });
    });
    child.on('error', () => undefined); // a kill or a write that failed: the exit still comes
    child.once('exit', (code, signal) => reply({ t: 'exit', id, code, signal }));
    child.once('close', () => {
      children.delete(id);
      killedAt.delete(id);
      reply({ t: 'closed', id });
    });
  };
  process.on('message', (m: ToBroker) => {
    if (m === null || typeof m !== 'object') return;
    if (m.t === 'spawn') {
      spawnOne(m);
      return;
    }
    if (m.t === 'ping') {
      // at once, behind every message already sent: the parent reads it as "nothing more came before this"
      const at = killedAt.get(m.id);
      reply({ t: 'pong', seq: m.seq, killedMsAgo: at === undefined ? null : performance.now() - at });
      return;
    }
    const child = children.get(m.id);
    if (child === undefined) return;
    switch (m.t) {
      case 'in': {
        const bytes = m.chunk.byteLength;
        const stdin = child.stdin!;
        if (stdin.destroyed || stdin.writableEnded) {
          reply({ t: 'inack', id: m.id, bytes });
          return;
        }
        stdin.write(m.chunk, () => reply({ t: 'inack', id: m.id, bytes }));
        return;
      }
      case 'inend':
        child.stdin!.end();
        return;
      case 'indestroy':
        child.stdin!.destroy();
        return;
      case 'pause':
        (m.fd === 1 ? child.stdout! : child.stderr!).pause();
        return;
      case 'resume':
        (m.fd === 1 ? child.stdout! : child.stderr!).resume();
        return;
      case 'outdestroy':
        (m.fd === 1 ? child.stdout! : child.stderr!).destroy();
        return;
      case 'kill':
        // stamped before the kill is made: the stuck guard's window counts from here
        if ((m.signal === 'SIGKILL' || m.signal === 9) && !killedAt.has(m.id)) killedAt.set(m.id, performance.now());
        try {
          child.kill(m.signal);
        } catch {
          // an unknown signal: as kill() here would throw, nothing is sent
        }
        return;
    }
  });
  process.on('disconnect', () => {
    for (const child of children.values()) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    process.exit(0);
  });
  reply({ t: 'ready' });
}

// The broker child: this file run by node with the broker flag and an IPC channel (KubectlBroker.start). Last in the
// module, so every declaration above is initialised before a request is served.
if (process.argv[2] === KUBECTL_BROKER_FLAG && process.send !== undefined && BROKER_ENTRY !== null && process.argv[1] !== undefined && resolvePath(process.argv[1]) === BROKER_ENTRY) {
  serveAsKubectlBroker();
}
