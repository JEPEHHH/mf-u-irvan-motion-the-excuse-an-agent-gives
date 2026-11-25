// The host side of a claim-less sandbox pod's two house transfers, both over the pod's agent (agent/v1: one HTTP/2
// stream an exec, agent-client.ts AgentSession.stream; agent-wire.ts's header is the spec) and both in the house tree
// stream (tree-stream.ts, makefun-tree/1):
//
//   stageStream    grader -> pod: packTrees as the stdin of an exec of <the unpacker> by the pod's `stage` agent
//   collectMounts  pod -> grader: an exec of <the packer> by the pod's `watch` agent, its stdout read by readTrees
//
// Neither touches the control plane: the caller (k8s.ts) dials the pod's agent and hands its session in
// (TransferContext.agent), and every byte goes grader to pod directly, never through the API server or a kubelet. What
// runs them is the caller's too: which agent's container takes a stage and how it is released, when a collect may
// start. Neither exec carries a nonce: nothing of an entrant's ever runs in the stage container or in `watch`, and the
// collect exec opens only after everything of the program's is dead, so nothing can forge either side's words.
//
// Once. Each transfer is one exec, sent once and never again (agent-client.ts's no re-send). The agent answers `:status
// 200` once the program is spawned, so there is no sign of an opening to wait for and no retry of one: a stream that
// opened and then stalls is the driver's failure at the transfer's budget, one that never opened (refused, unsent, the
// session lost) is the driver's failure as soon as it ends. Neither is run again here, whatever the caller then does.
//
// Staging. The exec runs the unpacker (treeUnpackArgv), or the caller's wrapper of it (StageOptions.command: a umask,
// the container's release after a good ack, all in the one exec; what it wraps it with is the caller's, never built
// here). A wrapper prints nothing on stdout before the unpacker's line. The verdict is that first stdout line, the
// unpacker's ack (parseUnpackAck): `ok <entries> <bytes>`, which must equal what the stream carried, or `no <why>`.
// The exec's end is never read: the release that follows a good ack ends the agent's container under the exec, whose
// stream then ends with no exit (`lost`), and that races the ack's own end. No ack in time, a `no`, any other line or a
// stream that ends with no line is a SandboxError naming the pod with the stager's words (its `no` line, else the exec's
// stderr and how the exec ended); the one that ran out of its budget with no ack is a StageError whose `fault` is
// `no_ack`, so a caller acting on it reads that off the type, never off a message that quotes what the stream carried.
// A failure on the host's side (a tree packTrees refuses) is one too, and the exec is killed. Once the ack is in, the
// exec has STAGE_EXIT_GRACE_MS to end on its own, then is killed: StageResult.ended settles when it is gone.
//
// Collect. The packer (in `watch`, as uid 10001) sends each writable mount's tree, held to the mount's `returns` as
// its caps exactly (the packer itself sends the one entry past a cap); readTrees writes each into the mount's host
// directory. That directory is kept, and what it held (the live mirror, the grader's own files) is removed first,
// since readTrees writes only into an empty directory; a host directory that is not a real directory is refused
// before anything is removed. The verdict is the stream's closing frame, its totals and the end of the stream
// (readTrees); a stream with no closing frame, a refused one, or none in time is a SandboxError naming the pod. Which
// of the first two it was is seen on the exec's stdout, not read off the reader's message: a reader that throws once
// it has been handed the stream's end met no closing frame; one that throws before refused what it read. A refused or
// cut stream leaves a partial replica, all of it the grader's own files, mode-000 placeholders among them: it is left
// for the scratch removal, which unlocks before it deletes. Nothing a program leaves in a mount makes the packer print a
// figure the reader refuses (it clamps every size: tree-stream.ts's header), so a mount past its caps, a sparse file of
// an exabyte among them, comes back cut, the program's own breach for the caller's walk to find; `was refused` is a
// broken packer's, the driver's failure.
//
// The exec's stdout is read at the reader's pace: a reader slowed by the host's disk (each entry's mkdir, open, write
// and chmod on libuv's few threads, shared by every transfer in the process) leaves the exec's stdout buffered to its
// high-water mark, past which the agent client stops taking the stream's bytes and the HTTP/2 window shuts behind
// them, holding the packer back; nothing is closed under a reader that lags, and a large mount never sits whole in
// memory. The stream's end is stdout's own. Its total is bounded by what the mounts may return (collectStreamBound:
// their data caps plus each entry's most frame bytes): a stream past it is refused and the exec killed.
//
// Budgets. Neither transfer is the program's time. Each has a fixed base plus its bytes over a floor rate well under
// the 46.7 to 93 MiB/s a kubectl exec carried on s18 across the evaluation's two runs (E6: 64 MiB into `stage` in
// 703 ms; the second run: 1 MiB in 287 ms, 16 MiB in 657 ms, 64 MiB at 46.7 MiB/s, and 64 MiB out in 1,242 ms), plus
// a small allowance per entry, which neither run measured and a tree of many small files spends on creating them in
// the pod. The figures are the ones sized for kubectl exec (TRANSFER_BUDGET), whose base also had to hold the API
// server's backend dial to the kubelet: the agent's path has no such dial, so a transfer is held to them as before, a
// stall failing no sooner than it did. A stage's bytes are the stream's bytes sent so far, so its deadline moves with
// the stream and a stall is seen without a walk of the trees first; a whole stage gets exactly base + bytes/rate +
// entries. A collect's are its mounts' caps (`returns.maxBytes`, `maxEntries` plus the one past it), fixed before the
// exec starts. No timer is handed more than Node's longest delay (2^31 - 1 ms, which setTimeout would fire at once): a
// budget past it is waited out in steps. A stage whose ack comes past half its budget is still a stage, and one line on
// the driver's warning channel (TransferContext.warn) names its elapsed time, bytes and entries.

import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import type { AgentChild, AgentEnd, AgentSession } from './agent-client.ts';
import {
  packTrees,
  parseUnpackAck,
  readTrees,
  type ReturnCaps,
  type ReturnedTree,
  shownBytes,
  type StageTree,
  TREE_MAX_LINE,
  TREE_MAX_LINK_BYTES,
  TREE_MAX_PATH_BYTES,
  TREE_STREAM_FORMAT,
  TreeStreamError,
  treePackArgv,
  treeUnpackArgv,
} from './tree-stream.ts';
import { SandboxError } from './types.ts';

/** The container a collect execs into (the plan's D9b: the house container beside `main`), its agent's own. */
export const WATCH_CONTAINER = 'watch';

/** What a StageError's `fault` names: `no_ack`, a staging that ran out of its budget with no ack (stageStream's timer). */
export type StageFault = 'no_ack';

/**
 * stageStream's failure of a kind its caller acts on (StageFault; the header's Staging): a SandboxError like its every
 * other failure, its kind typed so that nothing is read off its message, which quotes the stager's words and so what
 * the stream carried (an entry's paths).
 */
export class StageError extends SandboxError {
  readonly fault: StageFault;

  constructor(message: string, fault: StageFault, options?: { cause?: unknown }) {
    super(message, options);
    this.fault = fault;
  }
}

/** How long a transfer may take: base + bytes / bytesPerSecond + entries × entryMs. */
export interface TransferBudget {
  /** The fixed part: the exec's start on a busy node (and, when it was sized, kubectl's backend dial to the kubelet). */
  baseMs: number;
  /** The floor rate bytes are allowed at. */
  bytesPerSecond: number;
  /** Per entry: a file or directory made in the pod or in the replica. */
  entryMs: number;
}

/**
 * The budgets' figures: a 45 s base, a measured margin over the 31.4 s worst the API server's backend dial to a kubelet
 * took in a 46-minute fleet event (1,297 of 11,603 pods failed staging at a 30 s base, each cut about a second before
 * kubectl's own SPDY fallback answered in 108-192 ms), kept for the agent's path, which has no such dial (the header's
 * Budgets); 8 MiB/s (under a fifth of the slowest the two runs measured, 46.7 MiB/s), 2 ms an entry. A 64 MiB,
 * 1,000-entry tree: 45 + 8 + 2 s.
 */
export const TRANSFER_BUDGET: Readonly<TransferBudget> = Object.freeze({ baseMs: 45_000, bytesPerSecond: 8 * 1024 * 1024, entryMs: 2 });

/** The share of a stage's budget past which a successful ack is warned of as late (stageStream). */
const SLOW_STAGE_ACK_SHARE = 0.5;

/** After the ack, how long the staging exec has to end by itself before it is killed. */
export const STAGE_EXIT_GRACE_MS = 5_000;
/** After a failure's kill, or a collect's closing frame, how long the exec has to be gone. */
export const EXEC_END_GRACE_MS = 5_000;
/** The longest ack line the stager may print (the unpacker's longest `no` is well under it). */
export const MAX_ACK_BYTES = 4096;
/** How much of an exec's stderr is kept for its words. */
const STDERR_KEEP_BYTES = 8192;
/** Node's longest timer delay (2^31 - 1 ms): setTimeout fires a longer one at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const POD_RE = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const CONTAINER_RE = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

/** A transfer's budget in ms for `bytes` and `entries`. */
export function transferBudgetMs(bytes: number, entries: number, budget: Readonly<TransferBudget> = TRANSFER_BUDGET): number {
  return budget.baseMs + Math.ceil((bytes * 1000) / budget.bytesPerSecond) + entries * budget.entryMs;
}

/** A collect's budget: its mounts' byte caps, and their entry caps plus the one entry past each. */
export function collectBudgetMs(mounts: readonly { returns: ReturnCaps }[], budget: Readonly<TransferBudget> = TRANSFER_BUDGET): number {
  let bytes = 0;
  let entries = 0;
  for (const m of mounts) {
    bytes += m.returns.maxBytes;
    entries += m.returns.maxEntries + 1;
  }
  return transferBudgetMs(bytes, entries, budget);
}

/** The most frame bytes one entry may carry besides its file data: its header line and "\n", its path, a link's target. */
export const COLLECT_ENTRY_FRAME_BYTES = TREE_MAX_LINE + 1 + TREE_MAX_PATH_BYTES + TREE_MAX_LINK_BYTES;
/** What a collect stream may carry past its trees' own figures. */
export const COLLECT_STREAM_SLACK_BYTES = 64 * 1024;

/**
 * The most bytes a collect stream of `mounts` may carry (the header's Collect): its opening and closing frames, and per
 * mount its data cap (`returns.maxBytes`), its tree's M and C frames, and COLLECT_ENTRY_FRAME_BYTES for each entry it
 * may send (`maxEntries` and the one past the cap); then COLLECT_STREAM_SLACK_BYTES.
 */
export function collectStreamBound(mounts: readonly { returns: ReturnCaps }[]): number {
  let bound = TREE_STREAM_FORMAT.length + 1 + (TREE_MAX_LINE + 1) + COLLECT_STREAM_SLACK_BYTES;
  for (const m of mounts) bound += m.returns.maxBytes + 2 * (TREE_MAX_LINE + 1) + (m.returns.maxEntries + 1) * COLLECT_ENTRY_FRAME_BYTES;
  return bound;
}

/**
 * What a transfer runs on (the header): `agent`, the pod's agent session, whose `stream` is the one exec it opens (its
 * `stage` agent's for a staging into `stage`, its `watch` agent's for a collect or a staging into `watch`); `warn`, the
 * driver's warning channel, which takes a stage's late ack (the header's Budgets).
 */
export interface TransferContext {
  agent: Pick<AgentSession, 'stream'>;
  warn?: (line: string) => void;
}

export interface StageOptions {
  pod: string;
  /** The container whose unpacker receives the trees (its mount points read-write): the session's own agent's. */
  container: string;
  /** Each host directory and the mount point it is staged at; every one must arrive, an empty tree included. */
  trees: readonly StageTree[];
  /** Aborting cuts the stage off: the exec is killed and the stage fails. */
  signal?: AbortSignal;
  /** The budget's figures (default TRANSFER_BUDGET). */
  budget?: Readonly<TransferBudget>;
  /**
   * Maps the unpacker's argv (treeUnpackArgv of the mounts) to the argv the exec runs; absent, the unpacker's own. A
   * wrapper prints nothing on stdout before the unpacker's ack, which stays the first line and the verdict; the exec
   * may end right after it (the header). An empty argv, or one whose first element starts with `-`, is refused before
   * any exec.
   */
  command?: (unpack: readonly string[]) => readonly string[];
}

export interface StageResult {
  /** The stager's ack: entries and data bytes written, equal to what the stream carried. */
  entries: number;
  bytes: number;
  /** The stream's own bytes, frames included. */
  streamBytes: number;
  /** From the exec's start to the ack. */
  ms: number;
  /** Settles once the exec has ended (by itself, or killed STAGE_EXIT_GRACE_MS after the ack); never rejects. */
  ended: Promise<void>;
}

export interface CollectMount {
  /** The writable mount point in the pod. */
  mount: string;
  /** Its host directory: kept, its content replaced by the returned tree. */
  dir: string;
  /** How much may come back (SandboxMount.returns), the packer's and the reader's caps as they are. */
  returns: ReturnCaps;
}

export interface CollectOptions {
  pod: string;
  mounts: readonly CollectMount[];
  signal?: AbortSignal;
  budget?: Readonly<TransferBudget>;
}

/** Whether `signal` has aborted, read afresh (not narrowed by an earlier read). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function checkName(re: RegExp, value: string, what: string): void {
  if (!re.test(value)) throw new SandboxError(`${what} ${JSON.stringify(value)} is not a Kubernetes name`);
}

/**
 * Calls `fn` once `ms` has passed, however long it is: a delay past MAX_TIMER_MS is waited out in steps of it, never
 * handed to setTimeout whole. Returns what cancels it.
 */
function afterMs(ms: number, fn: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const arm = (left: number): void => {
    const step = Math.min(MAX_TIMER_MS, left);
    timer = setTimeout(() => (left > step ? arm(left - step) : fn()), step);
  };
  arm(Math.max(0, ms));
  return () => clearTimeout(timer);
}

/** Resolves true when `p` settles within `ms`, false at `ms`. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let cancel: (() => void) | undefined;
  const late = new Promise<false>((resolve) => {
    cancel = afterMs(ms, () => resolve(false));
  });
  try {
    return await Promise.race([p.then(() => true as const), late]);
  } finally {
    cancel?.();
  }
}

/** An exec's stderr, kept up to STDERR_KEEP_BYTES. */
function keepStderr(child: AgentChild): () => string {
  const kept: Buffer[] = [];
  let size = 0;
  child.stderr.on('data', (b: Buffer) => {
    if (size >= STDERR_KEEP_BYTES) return;
    const part = b.subarray(0, STDERR_KEEP_BYTES - size);
    kept.push(part);
    size += part.length;
  });
  return () => Buffer.concat(kept).toString('utf8');
}

/** How an agent exec ended, for a message: its outcome (agent-client.ts's header), and its status or the client's words. */
function execEnd(end: AgentEnd | null): string {
  if (end === null) return 'the agent exec still running';
  if (end.outcome === 'exit') return `the agent exec exited ${end.code}`;
  if (end.outcome === 'killed') return 'the agent exec killed';
  return `the agent exec ${end.outcome}: ${end.error ?? 'no words'}`;
}

/** What an exec said and how it ended, for a message: its stderr's first lines, and its end. */
function execWords(stderr: string, end: AgentEnd | null): string {
  const said = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, 3)
    .join('; ');
  const how = execEnd(end);
  return said === '' ? how : `${said.length > 600 ? `${said.slice(0, 600)}…` : said} (${how})`;
}

/** Kill `child` and wait, bounded, for its end: how it ended, or null when it did not in time. */
async function killAndWait(child: AgentChild): Promise<AgentEnd | null> {
  child.kill();
  let end: AgentEnd | null = null;
  await within(
    child.closed.then((e) => {
      end = e;
    }),
    EXEC_END_GRACE_MS,
  );
  return end;
}

/** The first line of `child`'s stdout (without its "\n"), or null when stdout ends first or passes MAX_ACK_BYTES. */
function firstLine(child: AgentChild): { line: Promise<string | null>; overlong: () => boolean } {
  let buf = Buffer.alloc(0);
  let done = false;
  let over = false;
  let resolve!: (l: string | null) => void;
  const line = new Promise<string | null>((r) => (resolve = r));
  const settle = (l: string | null): void => {
    if (done) return;
    done = true;
    resolve(l);
  };
  child.stdout.on('data', (b: Buffer) => {
    if (done) return;
    buf = Buffer.concat([buf, b]);
    const i = buf.indexOf(0x0a);
    if (i >= 0 && i <= MAX_ACK_BYTES) return settle(buf.subarray(0, i).toString('latin1'));
    if (buf.length > MAX_ACK_BYTES) {
      over = true;
      settle(null);
    }
  });
  child.stdout.once('end', () => settle(null));
  child.stdout.once('close', () => settle(null));
  child.stdout.once('error', () => settle(null));
  // `closed` comes once stdout has delivered its bytes; one that was never read may end no stream at all.
  void child.closed.then(() => setImmediate(() => settle(null)));
  return { line, overlong: () => over };
}

/** Resolves once `w` can take more, or is gone, or `stop` aborts. */
function drained(w: Writable, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      w.off('drain', done);
      w.off('error', done);
      w.off('close', done);
      stop.removeEventListener('abort', done);
      resolve();
    };
    w.once('drain', done);
    w.once('error', done);
    w.once('close', done);
    stop.addEventListener('abort', done, { once: true });
    if (stop.aborted) done();
  });
}

/** One exec by the session (TransferContext.agent), a SandboxError naming `at` when the client refuses to make it. */
function agentExec(ctx: TransferContext, container: string, argv: readonly string[], at: string): AgentChild {
  try {
    return ctx.agent.stream(container, argv);
  } catch (err) {
    throw new SandboxError(`${at}: the agent exec could not be made: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * Stage `trees` into `pod`'s `container` (the header's Staging): one exec by the pod's agent, resolving at the stager's
 * `ok` once it equals what the stream carried; a SandboxError naming the pod otherwise. Never sent twice.
 */
export async function stageStream(ctx: TransferContext, opts: StageOptions): Promise<StageResult> {
  checkName(POD_RE, opts.pod, 'pod');
  checkName(CONTAINER_RE, opts.container, 'container');
  const budget = opts.budget ?? TRANSFER_BUDGET;
  const at = `pod ${opts.pod}: staging into ${opts.container}`;
  let argv: readonly string[];
  try {
    argv = treeUnpackArgv(opts.trees.map((t) => t.mount));
  } catch (err) {
    throw new SandboxError(`${at}: ${(err as Error).message}`, { cause: err });
  }
  if (opts.command !== undefined) {
    let wrapped: unknown;
    try {
      wrapped = opts.command(Object.freeze([...argv]));
    } catch (err) {
      throw new SandboxError(`${at}: the staging command threw: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!Array.isArray(wrapped) || wrapped.length === 0 || !wrapped.every((a) => typeof a === 'string')) throw new SandboxError(`${at}: the staging command is no argv`);
    if ((wrapped[0] as string).startsWith('-')) throw new SandboxError(`${at}: the staging command ${JSON.stringify(wrapped[0])} starts with -`);
    argv = [...(wrapped as string[])];
  }
  // Made before the exec, so that a mount it refuses fails before anything is sent.
  let pack: ReturnType<typeof packTrees>;
  try {
    pack = packTrees(opts.trees);
  } catch (err) {
    throw new SandboxError(`${at}: ${(err as Error).message}`, { cause: err });
  }
  if (isAborted(opts.signal)) throw new SandboxError(`${at}: cut off before it started`);

  const started = Date.now();
  const child = agentExec(ctx, opts.container, argv, at);
  child.stdin.on('error', () => undefined);
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  const stderr = keepStderr(child);
  const ack = firstLine(child);

  let sent = 0;
  let timedOut = false;
  let aborted = false;
  let packError: unknown = null;
  let packDone = false;
  const stopPump = new AbortController();
  const allowed = (): number => transferBudgetMs(sent, pack.totals.entries, budget);
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    timer = setTimeout(
      () => {
        if (Date.now() - started < allowed()) return arm();
        timedOut = true;
        stopPump.abort();
        child.kill();
      },
      // Held to MAX_TIMER_MS: a longer budget re-arms when this fires, as a deadline the bytes moved does.
      Math.min(MAX_TIMER_MS, Math.max(1, allowed() - (Date.now() - started))),
    );
  };
  arm();
  const onAbort = (): void => {
    aborted = true;
    stopPump.abort();
    child.kill();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  // An abort may come while the exec starts (its listener is added after).
  if (isAborted(opts.signal)) onAbort();

  const pump = (async () => {
    try {
      for await (const chunk of pack) {
        if (stopPump.signal.aborted || child.stdin.destroyed || child.stdin.writableEnded) return;
        sent += chunk.length;
        if (!child.stdin.write(chunk)) await drained(child.stdin, stopPump.signal);
      }
    } catch (err) {
      packError = err;
      stopPump.abort();
      child.kill();
      return;
    }
    packDone = !stopPump.signal.aborted;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  })();

  /** Fail with `why`, given the exec's words (its stderr and its end) once it is gone; a StageError when `fault` names its kind. */
  const fail = async (why: (exec: string) => string, cause?: unknown, fault?: StageFault): Promise<never> => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    stopPump.abort();
    const end = await killAndWait(child);
    await within(pump, EXEC_END_GRACE_MS);
    const message = `${at}: ${why(execWords(stderr(), end))}`;
    const options = cause === undefined ? undefined : { cause };
    throw fault === undefined ? new SandboxError(message, options) : new StageError(message, fault, options);
  };

  const line = await ack.line;
  if (line !== null) {
    const verdict = parseUnpackAck(line);
    if (verdict === null) return await fail((exec) => `the stager answered ${shownBytes(line)}, no ack (${exec})`);
    if (!verdict.ok) return await fail(() => `the stager refused the stream: ${verdict.why}`);
    // The ack comes once the closing frame is read: the pump is at its end, or about to be.
    await within(pump, Math.max(EXEC_END_GRACE_MS, allowed() - (Date.now() - started)));
    if (packError !== null) return await fail(() => `the host trees could not be staged: ${(packError as Error).message}`, packError);
    if (!packDone) return await fail((exec) => `the stager acknowledged before the whole stream was sent (${sent} bytes; ${exec})`);
    const t = pack.totals;
    if (verdict.entries !== t.entries || verdict.bytes !== t.bytes) {
      return await fail(() => `the stager acknowledged ${verdict.entries} entries and ${verdict.bytes} bytes, but the stream carried ${t.entries} and ${t.bytes}`);
    }
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    // The verdict is in: the release that now ends the exec (no exit trailer) is its normal end (agent-client.ts released()).
    child.released?.();
    const ms = Date.now() - started;
    // Late but inside the budget: one line, so a future incident has the figures without a live probe. A stage that
    // failed has said why already.
    const allowedMs = allowed();
    if (ms >= allowedMs * SLOW_STAGE_ACK_SHARE) {
      ctx.warn?.(
        `k8s sandbox: staging into ${opts.container} in pod ${opts.pod} acked ${ms} ms into its ${allowedMs} ms budget (${verdict.bytes} bytes, ${verdict.entries} entries; over half the budget, so a slow agent exec or a slow unpack)`,
      );
    }
    const ended = (async () => {
      if (!(await within(child.closed, STAGE_EXIT_GRACE_MS))) await killAndWait(child);
    })();
    return { entries: verdict.entries, bytes: verdict.bytes, streamBytes: sent, ms, ended };
  }
  if (packError !== null) return await fail(() => `the host trees could not be staged: ${(packError as Error).message}`, packError);
  if (timedOut) return await fail((exec) => `no ack within ${allowed()} ms (${sent} bytes sent; ${exec})`, undefined, 'no_ack');
  if (aborted) return await fail((exec) => `cut off before the ack (${exec})`);
  if (ack.overlong()) return await fail((exec) => `the stager printed more than ${MAX_ACK_BYTES} bytes with no line (${exec})`);
  // Stdout ended with no line: the exec's end (its exit, or why it never opened or was lost) is read once it is in.
  await within(child.closed, EXEC_END_GRACE_MS);
  return await fail((exec) => `the stream ended with no ack (${exec})`);
}

/** Remove everything in `dir`, keeping `dir`, which must be a real directory (never a link to one). */
async function emptyDir(dir: string): Promise<void> {
  const st = await lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
}

/**
 * Collect `mounts` from `pod`'s `watch` (the header's Collect) into their host directories: one exec by the pod's
 * `watch` agent, resolving to readTrees' report per mount, in `mounts`' order, once the stream's closing frame and end
 * are read; a SandboxError naming the pod otherwise. Never sent twice. Call it only once the program's exec has ended.
 */
export async function collectMounts(ctx: TransferContext, opts: CollectOptions): Promise<ReturnedTree[]> {
  checkName(POD_RE, opts.pod, 'pod');
  const shown = opts.mounts.map((m) => m.mount).join(', ');
  const at = `pod ${opts.pod}: the collect of ${shown}`;
  let argv: string[];
  try {
    argv = treePackArgv(opts.mounts.map((m) => ({ mount: m.mount, caps: m.returns })));
  } catch (err) {
    throw new SandboxError(`${at}: ${(err as Error).message}`, { cause: err });
  }
  for (const m of opts.mounts) {
    const st = await lstat(m.dir).catch((err: NodeJS.ErrnoException) => {
      throw new SandboxError(`${at}: host directory ${m.dir}: ${err.code ?? err.message}`, { cause: err });
    });
    if (!st.isDirectory()) throw new SandboxError(`${at}: host directory ${m.dir} (for ${m.mount}) is not a directory`);
  }
  for (const m of opts.mounts) {
    try {
      await emptyDir(m.dir);
    } catch (err) {
      throw new SandboxError(`${at}: could not empty ${m.dir} (for ${m.mount}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`, { cause: err });
    }
  }
  if (isAborted(opts.signal)) throw new SandboxError(`${at}: cut off before it started`);

  const budgetMs = collectBudgetMs(opts.mounts, opts.budget ?? TRANSFER_BUDGET);
  const bound = collectStreamBound(opts.mounts);
  const trees = opts.mounts.map((m) => ({ mount: m.mount, dir: m.dir, caps: m.returns }));
  const child = agentExec(ctx, WATCH_CONTAINER, argv, at);
  const r = await readCollect(child, trees, opts.signal, bound, budgetMs);
  if (r.ok) return r.reports;
  const { words, err } = r;
  if (r.kind === 'timedOut') throw new SandboxError(`${at} sent no closing frame within ${budgetMs} ms (${words})`, { cause: err });
  if (r.kind === 'aborted') throw new SandboxError(`${at} was cut off (${words})`, { cause: err });
  if (r.kind === 'refused') throw new SandboxError(`${at} was refused: ${err instanceof Error ? err.message : String(err)} (${words})`, { cause: err });
  throw new SandboxError(`${at} ended without its closing frame (${words})`, { cause: err });
}

type CollectRead = { ok: true; reports: ReturnedTree[] } | { ok: false; kind: 'timedOut' | 'aborted' | 'cut' | 'refused'; words: string; err: unknown };

/**
 * The collect exec `child` read into `trees` (the header's Collect): its stdout at the reader's pace, its total bounded
 * by `bound`, the exec killed when `budgetMs` is spent or `signal` aborts. Its reports, or how it failed with the exec's
 * words.
 */
async function readCollect(child: AgentChild, trees: { mount: string; dir: string; caps: ReturnCaps }[], signal: AbortSignal | undefined, bound: number, budgetMs: number): Promise<CollectRead> {
  const started = Date.now();
  child.stdin.on('error', () => undefined);
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  child.stdin.end();
  const stderr = keepStderr(child);
  let timedOut = false;
  let aborted = false;
  const cancelTimer = afterMs(budgetMs, () => {
    timedOut = true;
    child.kill();
  });
  const onAbort = (): void => {
    aborted = true;
    child.kill();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  // An abort may come while the exec starts (its listener is added after).
  if (isAborted(signal)) onAbort();
  // Whether the reader was handed the end of the exec's stdout: then a reader that throws met a stream with no
  // closing frame, and one that throws before it refused what it read. Seen here, never read off the reader's words.
  let readerSawEnd = false;
  const source = (async function* (): AsyncGenerator<Buffer> {
    const it = (child.stdout as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
    let received = 0;
    for (;;) {
      let next: IteratorResult<Buffer>;
      try {
        next = await it.next();
      } catch {
        // A stdout that failed has ended: what it carried is all there is.
        break;
      }
      if (next.done === true) break;
      received += next.value.length;
      if (received > bound) {
        child.kill();
        throw new TreeStreamError(`the stream ran past ${bound} bytes, more than its mounts' returns can carry`);
      }
      yield next.value;
    }
    readerSawEnd = true;
  })();
  try {
    const reports = await readTrees(source, trees);
    // The closing frame and the stream's end are in: the exec has what is left of its budget to be gone.
    if (!(await within(child.closed, Math.max(EXEC_END_GRACE_MS, budgetMs - (Date.now() - started))))) await killAndWait(child);
    return { ok: true, reports };
  } catch (err) {
    const cut = readerSawEnd;
    // What the reader left unread would hold the exec's end back (its end comes once stdout has delivered its bytes):
    // dropped first.
    child.stdout.destroy();
    const end = await killAndWait(child);
    const kind = timedOut ? 'timedOut' : aborted ? 'aborted' : cut ? 'cut' : 'refused';
    return { ok: false, kind, words: execWords(stderr(), end), err };
  } finally {
    cancelTimer();
    signal?.removeEventListener('abort', onAbort);
  }
}
