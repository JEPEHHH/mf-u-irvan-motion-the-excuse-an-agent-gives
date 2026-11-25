// The grader's client of agent/v1 (agent-wire.ts, whose header is the spec): one AgentSession per agent instance of a
// sandbox pod (its `stage` agent while it stages, then its `watch` agent for the pod's life), and over it an exec shaped
// as kubectl exec's was, so the driver's readers (forward, SentinelScanner, the tree readers) keep their code.
//
// The session. AgentSession.open dials <podIP>:AGENT_PORT and stops at the caller's budget (`budgetMs`, `signal`):
//
//   - TCP: each attempt is bounded by DIAL_ATTEMPT_MS. An attempt whose SYN gets no answer is abandoned and a new one
//     made at once, so a SYN dropped while Cilium readies the pod's endpoint costs 150 ms, never the kernel's 1 s SYN
//     RTO; ECONNREFUSED (the agent not yet listening), and any other connect error, re-dials after
//     DIAL_REFUSED_RETRY_MS. With MAKEFUN_AGENT_RELAY_URL set (a burst grader, which cannot route to the burst
//     cluster's pod network), the TCP is to the relay instead, then `CONNECT <podIP>:9011` with
//     MAKEFUN_AGENT_RELAY_TOKEN (connectRequest); its 502 (the relay's dial failed: the agent not yet up) and 503 (its
//     tunnel cap full) re-dial the same way, any other answer ends the open. An https:// relay URL (a relay started
//     with --tls) puts the relay's own TLS under that CONNECT first: TLS 1.3, rejectUnauthorized false, and its pin
//     (agent-wire.ts relayPin, from the token this grader holds) checked on secureConnect before the bearer is written
//     (checkRelaySocket), so the bearer never crosses the open network in clear and reaches no host but the relay. A
//     pin that fails ends the open at once (AgentDialError `pin`: not the relay this token is for); a handshake that
//     fails otherwise re-dials like a failed CONNECT. The agent's TLS below then runs inside the relay's.
//   - TLS 1.3, ALPN h2, rejectUnauthorized false (the agent's certificate is self-signed): the pin is checked on
//     secureConnect (checkAgentSocket) before the h2 session exists, so no byte of any request ever reaches a socket
//     whose key is not the pod's. A pin that fails ends the open at once, never re-dialled (AgentDialError `pin`): it
//     is a recycled IP, a stolen port or the wrong K, and none of those heals.
//   - h2 with H2_SETTINGS, maxSessionMemory H2_CLIENT_MAX_SESSION_MEMORY_MB, maxSendHeaderBlockLength
//     H2_MAX_SEND_HEADER_BLOCK_LENGTH, the connection window raised to H2_CONNECTION_WINDOW. The open resolves only
//     once the agent's SETTINGS are in: a stream opened before them would be held to Node's assumed limit (100), not
//     the agent's 64, and the agent refuses the excess with REFUSED_STREAM.
//   - The token (agentToken over this connection's exporter) on every request.
//   - A PING every PING_EVERY_MS; PING_MISSES_DEAD in a row unanswered = the session is dead (destroyed).
//
// The session never holds more streams open than the agent's SETTINGS_MAX_CONCURRENT_STREAMS: the rest wait here, in
// order, and start as streams close (a queued exec's stdin is held until it starts). close() is the pod's end: no new
// exec, the open ones may finish within CLOSE_GRACE_MS, then the session is destroyed.
//
// An exec. stream(container, argv) answers at once with an AgentChild, a KubectlChild (stdin, stdout, stderr, closed,
// kill) plus `opened`, which resolves at the agent's `:status 200` (the program spawned) and rejects for an error status
// or a stream that ended before it. `container` is the agent's own (the session's `agent`: no makefun-container header)
// or a member's (release 2). Its end (`closed`, an AgentEnd) comes after stdout and stderr have delivered every byte
// they were given (or at once when nobody reads them), and says how:
//
//   exit      the makefun-exit trailer: `code` is the program's status (128+n for signal n), as kubectl's was.
//   refused   an error status (401, 400, 404, 405): `error` names it and the agent's reason; nothing ran.
//   lost      the stream ended without a trailer: a reset, a GOAWAY that cut it, the session dead, or the agent's
//             release (stage's SIGUSR1 and serve's SIGTERM send what the pipes held, then END_STREAM with no trailer,
//             as an exec under a container that ends). `code` and `signal` are null, `error` says why; every byte the
//             stream carried is still in stdout and stderr, so a caller whose verdict is its own output (the staging's
//             `ok` line) still reads it.
//   killed    the caller's kill(): RST_STREAM(CANCEL), which closes the program's pipes and never signals it
//             (kubectl's end). `signal` is SIGKILL, as the killed kubectl's was.
//   protocol  a frame or trailer that breaks the wire: the client resets the stream (CANCEL).
//   unsent    the session was closed or dead before the stream started: nothing reached the agent.
//
// A caller whose verdict is already in when the program's release ends the exec (the staging's verified `ok` ack: the
// release then ends `stage` and its exec with no trailer, by design) says so by the child's released(): its end, if
// `lost`, is still `lost` to the caller (its AgentEnd as the wire left it) but is counted `exit` on the metric below,
// the exec's normal end; every other end counts as it is. Without it every clean staging counted `lost` (makefun-prod
// 2026-11-16: 2,835 lost, 0 exit), and a lost staging, a real fault, could not be told apart.
//
// No re-send, ever: a stream is sent once and an exec that did not end with its trailer is the caller's failure, never
// tried again here (a lost stream may have run its program). run(container, argv, {input, timeoutMs, signal}) is
// stream() to its end as a KubectlResult (plus its outcome).
//
// The peer. agentPeerIp() is the address a pod's agent must admit (its MAKEFUN_AGENT_PEERS): MAKEFUN_AGENT_PEER_IP
// when set; with a relay, the relay's `/v1/peer` answer (cached per relay, forgotten after any CONNECT failure, so a
// relay that moved is read again); else this process's first non-internal IPv4 address (a grader pod's own IP: Cilium
// does not SNAT pod to pod).
//
// Metrics (registered on the process's registry by registerAgentMetrics, which the driver calls once; counted in
// process before it, and added at registration):
//
//   makefun_k8s_sandbox_agent_execs_total{container_kind,outcome}  every exec's end; container_kind stage | watch (the
//                                     agent's own container) | member, outcome as above (a released exec's lost end
//                                     counted exit); every series 0 from registration
//   makefun_k8s_sandbox_agent_open_seconds{container_kind}  an exec's request to its 200 (queued time included)
//   makefun_k8s_sandbox_agent_sessions  sessions open now
//   makefun_k8s_sandbox_init_seconds{phase,source}  a program's init clock (the driver's recordInit), by where its pod
//                                     came from (INIT_SOURCES): `cold`, a pod made for it, each phase from its create
//                                     call: created (the create answered), scheduled (bound to a node), ip (its IP
//                                     seen), agent (the agent's first authenticated answer: the end of init); `warm`,
//                                     a pod its grader's warm pool had booted (k8s-pool.ts), agent alone, from the
//                                     spawn call to the taken pod's agent answering at the claim; and for either,
//                                     started, from the spawn call to the program's start line (staging, Ready, the
//                                     exec's start in it: what the program waited in all)

import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import tls from 'node:tls';
import {
  AGENT_ALPN,
  AGENT_ENV_PREFIX,
  AGENT_PORT,
  AGENT_RELAY_TOKEN_ENV,
  AGENT_RELAY_URL_ENV,
  AGENT_TLS_VERSION,
  agentPin,
  agentToken,
  ARGV_HEADER,
  AUTH_HEADER,
  checkAgentSocket,
  checkRelaySocket,
  CONTAINER_HEADER,
  connectAuthority,
  connectionExporter,
  connectRequest,
  CONTAINER_NAME_RE,
  deriveClientKey,
  DIAL_ATTEMPT_MS,
  DIAL_REFUSED_RETRY_MS,
  encodeArgvHeader,
  EXEC_PATH,
  EXIT_TRAILER,
  FrameDecoder,
  H2_CLIENT_MAX_SESSION_MEMORY_MB,
  H2_CONNECTION_WINDOW,
  H2_MAX_SEND_HEADER_BLOCK_LENGTH,
  H2_SETTINGS,
  HEALTH_PATH,
  parseAgentKey,
  parseExit,
  parseHealth,
  parsePeerAnswer,
  parseRelayUrl,
  PEER_PATH,
  PING_EVERY_MS,
  PING_MISSES_DEAD,
  relayPin,
  STDOUT_CHANNEL,
  type AgentHealth,
} from './agent-wire.ts';
import type { KubectlChild, KubectlEnd, KubectlResult } from './k8s.ts';

/** The grader's own override of agentPeerIp (an operator's hand; no spec sets it). */
export const AGENT_PEER_IP_ENV = `${AGENT_ENV_PREFIX}PEER_IP`;
/** How long close() lets open streams finish before it destroys the session. */
export const CLOSE_GRACE_MS = 1_000;
/** The relay's answer head, and an error status's reason, read at most this far. */
const HEAD_MAX_BYTES = 16 << 10;
/** A /v1/health or /v1/peer body read at most this far. */
const BODY_MAX_BYTES = 64 << 10;
/** An error status's reason kept for the message. */
const REASON_MAX_BYTES = 1 << 10;
/** A /v1/peer read's own bound when the caller names none. */
const PEER_READ_TIMEOUT_MS = 5_000;
/** health()'s own bound when the caller names none. */
const HEALTH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------- the metrics

/** The agent metrics' names (the header): the dashboards read these, so they never change. */
export const AGENT_METRICS = Object.freeze({
  execs: 'makefun_k8s_sandbox_agent_execs_total',
  open: 'makefun_k8s_sandbox_agent_open_seconds',
  sessions: 'makefun_k8s_sandbox_agent_sessions',
  init: 'makefun_k8s_sandbox_init_seconds',
});

/** Which container an exec ran in: the agent's own (`stage`, `watch`) or a member's through its shim. */
export const AGENT_CONTAINER_KINDS = Object.freeze(['stage', 'watch', 'member'] as const);
export type AgentContainerKind = (typeof AGENT_CONTAINER_KINDS)[number];
/** The agent that a session speaks to: the pod's `stage` init container's, or its `watch` container's. */
export type AgentName = Exclude<AgentContainerKind, 'member'>;

/** How an exec ended (the header). */
export const AGENT_EXEC_OUTCOMES = Object.freeze(['exit', 'refused', 'lost', 'killed', 'protocol', 'unsent'] as const);
export type AgentExecOutcome = (typeof AGENT_EXEC_OUTCOMES)[number];

/**
 * The init clock's phases (the header): a cold pod's created, scheduled, ip and agent from its create call, a warm pod's
 * agent from the spawn call; either's started from the spawn call.
 */
export const INIT_PHASES = Object.freeze(['created', 'scheduled', 'ip', 'agent', 'started'] as const);
export type InitPhase = (typeof INIT_PHASES)[number];
/** Where a program's pod came from (the header): made for it (`cold`), or taken booted from its grader's warm pool (`warm`). */
export const INIT_SOURCES = Object.freeze(['cold', 'warm'] as const);
export type InitSource = (typeof INIT_SOURCES)[number];

/** makefun_k8s_sandbox_agent_open_seconds' buckets. */
export const AGENT_OPEN_BUCKETS: readonly number[] = Object.freeze([0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
/** makefun_k8s_sandbox_init_seconds' buckets: fine around the 1 s (p50) and 1.5 s (p95) targets. */
export const INIT_BUCKETS: readonly number[] = Object.freeze([0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5, 10, 30, 60]);

/** What the client tells the metrics, each event once. */
export interface AgentMetricsObserver {
  exec(kind: AgentContainerKind, outcome: AgentExecOutcome): void;
  opened(kind: AgentContainerKind, seconds: number): void;
  sessions(delta: 1 | -1): void;
  init(phase: InitPhase, seconds: number, source: InitSource): void;
}

/** Observations held for the registry until it registers (at most this many of each histogram's). */
const PENDING_MAX = 10_000;
const tally = {
  execs: new Map<string, number>(),
  sessions: 0,
  opens: [] as Array<[AgentContainerKind, number]>,
  inits: [] as Array<[InitPhase, number, InitSource]>,
};
let registered: AgentMetricsObserver | null = null;
let registering: Promise<void> | null = null;
const observers = new Set<AgentMetricsObserver>();

/** The process's metrics: counted in process, on the registry once registered, and to every added observer. */
const metrics: AgentMetricsObserver = {
  exec(kind, outcome) {
    const k = `${kind} ${outcome}`;
    tally.execs.set(k, (tally.execs.get(k) ?? 0) + 1);
    registered?.exec(kind, outcome);
    for (const o of observers) o.exec(kind, outcome);
  },
  opened(kind, seconds) {
    if (registered !== null) registered.opened(kind, seconds);
    else if (tally.opens.length < PENDING_MAX) tally.opens.push([kind, seconds]);
    for (const o of observers) o.opened(kind, seconds);
  },
  sessions(delta) {
    tally.sessions += delta;
    for (const o of observers) o.sessions(delta);
  },
  init(phase, seconds, source) {
    if (registered !== null) registered.init(phase, seconds, source);
    else if (tally.inits.length < PENDING_MAX) tally.inits.push([phase, seconds, source]);
    for (const o of observers) o.init(phase, seconds, source);
  },
};

/** Add an observer of every agent metric event (a test's); returns its removal. */
export function observeAgentMetrics(observer: AgentMetricsObserver): () => void {
  observers.add(observer);
  return () => void observers.delete(observer);
}

/**
 * The init clock's mark: `phase` reached `seconds` after its start (the header: a cold pod's create call, or the spawn
 * call), for a pod of `source` (default `cold`); the driver's, once a phase a program.
 */
export function recordInit(phase: InitPhase, seconds: number, source: InitSource = 'cold'): void {
  if (!INIT_PHASES.includes(phase)) throw new Error(`recordInit: ${String(phase)} is no init phase`);
  if (!INIT_SOURCES.includes(source)) throw new Error(`recordInit: ${String(source)} is no init source`);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  metrics.init(phase, seconds, source);
}

/** Sessions open now in this process. */
export function agentSessionsOpen(): number {
  return tally.sessions;
}

/**
 * Register the agent metrics on the process's registry (server/ops/metrics.ts metricsRegistry), once a process: imported
 * here, not at the top, as registerPaceMetrics does, since the metrics module starts collectors at import. Every exec
 * series starts at 0 (plus what was counted before), the held observations are added, and the sessions gauge reads the
 * live count at each scrape. A failure is said and drops only the metrics.
 */
export function registerAgentMetrics(warn: (line: string) => void): Promise<void> {
  registering ??= (async () => {
    try {
      const [{ metricsRegistry }, { Counter, Gauge, Histogram }] = await Promise.all([import('../../server/ops/metrics.ts'), import('@prometheus-io/client')]);
      if (metricsRegistry.getSingleMetric(AGENT_METRICS.execs) !== undefined) return;
      const execs = new Counter({
        name: AGENT_METRICS.execs,
        help: "Agent execs ended, by container_kind (stage | watch: the agent's own container; member: through its shim) and outcome: exit (the makefun-exit trailer, or a staging's release once its verdict was in) | refused (an error status: nothing ran) | lost (ended without a trailer: a reset, a GOAWAY, the session dead, the agent's release; never re-sent) | killed (the caller's cancel) | protocol (a frame that breaks the wire) | unsent (the session closed before it started).",
        labelNames: ['container_kind', 'outcome'] as const,
        registers: [metricsRegistry],
      });
      for (const kind of AGENT_CONTAINER_KINDS) for (const outcome of AGENT_EXEC_OUTCOMES) execs.inc({ container_kind: kind, outcome }, tally.execs.get(`${kind} ${outcome}`) ?? 0);
      const open = new Histogram({
        name: AGENT_METRICS.open,
        help: "An agent exec's request to its :status 200 (the program spawned), queued time included, by container_kind.",
        labelNames: ['container_kind'] as const,
        buckets: [...AGENT_OPEN_BUCKETS],
        registers: [metricsRegistry],
      });
      new Gauge({
        name: AGENT_METRICS.sessions,
        help: 'Agent sessions (one per agent of a sandbox pod: its stage, then its watch) open now in this process.',
        registers: [metricsRegistry],
        collect() {
          this.set(tally.sessions);
        },
      });
      const init = new Histogram({
        name: AGENT_METRICS.init,
        help: "A program's init clock, by source: cold (a pod made for it), each phase from its create call: created (the create answered) | scheduled (bound to a node) | ip (its IP seen) | agent (the agent's first authenticated answer: the end of init); warm (a pod taken booted from its grader's warm pool), agent alone, from the spawn call to the taken pod's agent answering at the claim; either's started, from the spawn call to the program's start line.",
        labelNames: ['phase', 'source'] as const,
        buckets: [...INIT_BUCKETS],
        registers: [metricsRegistry],
      });
      registered = {
        exec: (kind, outcome) => execs.inc({ container_kind: kind, outcome }),
        opened: (kind, seconds) => open.observe({ container_kind: kind }, seconds),
        sessions: () => undefined,
        init: (phase, seconds, source) => init.observe({ phase, source }, seconds),
      };
      for (const [kind, s] of tally.opens.splice(0)) registered.opened(kind, s);
      for (const [phase, s, source] of tally.inits.splice(0)) registered.init(phase, s, source);
    } catch (err) {
      warn(`k8s sandbox: the agent metrics could not be registered (the agent runs unmeasured): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return registering;
}

// ---------------------------------------------------------------- errors and shapes

/** Why an open failed: its budget, the pin, TLS or h2, the relay, the caller's abort. */
export type AgentDialFault = 'budget' | 'pin' | 'tls' | 'relay' | 'aborted';

/** An AgentSession.open that failed. `attempts` is the TCP attempts it made. */
export class AgentDialError extends Error {
  override name = 'AgentDialError';
  readonly fault: AgentDialFault;
  readonly attempts: number;
  constructor(message: string, fault: AgentDialFault, attempts: number) {
    super(message);
    this.fault = fault;
    this.attempts = attempts;
  }
}

/** An exec that never opened (an error status, a stream that ended before its 200), or a health read that failed. */
export class AgentExecError extends Error {
  override name = 'AgentExecError';
  readonly outcome: AgentExecOutcome;
  readonly status: number | null;
  constructor(message: string, outcome: AgentExecOutcome, status: number | null = null) {
    super(message);
    this.outcome = outcome;
    this.status = status;
  }
}

/** How an agent exec ended: KubectlEnd's fields as kubectl's would read, and how. */
export interface AgentEnd extends KubectlEnd {
  outcome: AgentExecOutcome;
  /** The agent's error status, for `refused`. */
  status?: number;
}

/** A KubectlChild over the agent, plus the 200. */
export interface AgentChild extends KubectlChild {
  readonly closed: Promise<AgentEnd>;
  /** Resolves at the agent's :status 200 (the program spawned); rejects (AgentExecError) when the exec never opened. */
  readonly opened: Promise<void>;
  /**
   * The caller's verdict is in and the program's release is to end the exec (the header's released()): a `lost` end
   * from now on counts `exit` on makefun_k8s_sandbox_agent_execs_total. Absent on a stand-in that counts nothing.
   */
  released?(): void;
}

/** run()'s result: a KubectlResult and how the exec ended. */
export interface AgentResult extends KubectlResult {
  outcome: AgentExecOutcome;
}

export interface AgentRunOptions {
  /** Its stdin (none: closed at once). */
  input?: string | Uint8Array;
  /** Its budget, from the call: past it the exec is killed and `error` says so. */
  timeoutMs?: number;
  /** Kills it when this aborts. */
  signal?: AbortSignal;
}

/** A relay as MAKEFUN_AGENT_RELAY_URL and _TOKEN name it. */
export interface AgentRelay {
  host: string;
  port: number;
  token: string;
  /** An https:// URL: the relay's TLS, pinned to relayPin(token) (absent or false: plain HTTP/1.1). */
  tls?: boolean;
}

/** Opens one TCP connection (net.connect's shape): the tests' seam for a SYN that is never answered. */
export type TcpConnect = (host: string, port: number) => net.Socket;

export interface AgentSessionOptions {
  /** The pod's IP. */
  ip: string;
  /** The pod's K (MAKEFUN_AGENT_KEY's value, or its 32 bytes). */
  key: string | Uint8Array;
  /** Which agent of the pod: `stage` (its init container) or `watch`. Its own container takes no makefun-container. */
  agent: AgentName;
  /** The open's whole budget (dial, relay, TLS, h2 settings), from the call. */
  budgetMs: number;
  /** Ends the open (AgentDialError `aborted`); it does not close an opened session. */
  signal?: AbortSignal;
  /** The agent's port (AGENT_PORT; a test's agent listens elsewhere). Through a relay the CONNECT always names AGENT_PORT. */
  port?: number;
  /** The relay to dial through: undefined reads MAKEFUN_AGENT_RELAY_URL and _TOKEN from `env`, null dials directly. */
  relay?: AgentRelay | null;
  env?: NodeJS.ProcessEnv;
  /** The PING period (PING_EVERY_MS; a test's is short). */
  pingEveryMs?: number;
  /** How one TCP attempt is made (net.connect). */
  connect?: TcpConnect;
}

const noop = (): void => undefined;
const defaultConnect: TcpConnect = (host, port) => net.connect({ host, port, noDelay: true });

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, Math.max(0, ms));
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** MAKEFUN_AGENT_RELAY_URL and _TOKEN to a relay; null when no relay is named. A URL without its token is refused. */
export function agentRelayFromEnv(env: NodeJS.ProcessEnv = process.env): AgentRelay | null {
  const url = env[AGENT_RELAY_URL_ENV];
  if (url === undefined || url === '') return null;
  const token = env[AGENT_RELAY_TOKEN_ENV];
  if (token === undefined || token === '') throw new Error(`${AGENT_RELAY_URL_ENV} is set without ${AGENT_RELAY_TOKEN_ENV}`);
  return { ...parseRelayUrl(url), token };
}

// ---------------------------------------------------------------- the peer

const relayPeers = new Map<string, Promise<string>>();
const relayKey = (r: AgentRelay): string => `${r.host} ${r.port}`;

/** Forget a relay's cached /v1/peer answer (after a CONNECT through it failed: it may have moved). */
export function forgetRelayPeer(relay: AgentRelay): void {
  relayPeers.delete(relayKey(relay));
}

/** The relay's /v1/peer answer: one HTTP/1.1 GET with its bearer (inside the relay's pinned TLS for an https:// relay). */
async function readRelayPeer(relay: AgentRelay, timeoutMs: number): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  // An https:// relay: its TLS is up and its pin checked before http writes a byte (the bearer goes to no other host).
  // http takes that socket only with no agent (agent: false would make its own connection).
  const secured = relay.tls === true ? await startRelayTls(null, relay, relayPin(relay.token), deadline) : null;
  return new Promise((resolve, reject) => {
    const left = Math.max(1, Math.ceil(deadline - performance.now()));
    const req = http.request({ host: relay.host, port: relay.port, path: PEER_PATH, method: 'GET', headers: { authorization: `Bearer ${relay.token}` }, timeout: left, ...(secured === null ? { agent: false } : { createConnection: () => secured }) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (b: Buffer) => {
        size += b.byteLength;
        if (size > BODY_MAX_BYTES) return req.destroy(new Error(`the answer passed ${BODY_MAX_BYTES} bytes`));
        chunks.push(b);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`the relay answered ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          resolve(parsePeerAnswer(body));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** A relay TLS handshake that failed: `pin` when the relay's key is not the pinned one (never re-dialled). */
class RelayTlsError extends Error {
  override name = 'RelayTlsError';
  readonly pin: boolean;
  constructor(message: string, pin: boolean) {
    super(message);
    this.pin = pin;
  }
}

/**
 * The relay's TLS (an https:// relay) over `raw`, or over a TCP connection of its own when `raw` is null: TLS 1.3,
 * rejectUnauthorized false (its certificate is self-signed), and the pin checked on secureConnect (checkRelaySocket),
 * before anything is written. Rejects with a RelayTlsError (`pin` true for a key that is not the pinned one).
 */
function startRelayTls(raw: net.Socket | null, relay: AgentRelay, pin: Buffer, deadline: number, signal?: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      ...(raw === null ? { port: relay.port } : { socket: raw }),
      host: relay.host,
      minVersion: AGENT_TLS_VERSION,
      maxVersion: AGENT_TLS_VERSION,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    });
    let done = false;
    const finish = (err: RelayTlsError | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('secureConnect', onSecure);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (err === null) return resolve(socket);
      socket.on('error', noop);
      socket.destroy();
      raw?.destroy();
      reject(err);
    };
    const onSecure = (): void => {
      const why = checkRelaySocket(socket, pin);
      finish(why === null ? null : new RelayTlsError(why, true));
    };
    const onError = (e: Error): void => finish(new RelayTlsError(`TLS to the relay: ${e.message}`, false));
    const onClose = (): void => finish(new RelayTlsError('the relay closed the connection before TLS completed', false));
    const onAbort = (): void => finish(new RelayTlsError('cut off', false));
    const timer = setTimeout(() => finish(new RelayTlsError('TLS to the relay did not complete within the budget', false)), Math.max(1, deadline - performance.now()));
    socket.once('secureConnect', onSecure);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

/**
 * This process's first non-internal IPv4 address, in the interfaces' order; of `interfaces` when given. This process's own
 * is read once and kept (a pod's address is its own for its life): os.networkInterfaces() is a getifaddrs() and an
 * object per address, and k8s.ts asks at every program pod's spec (0.9 % of a prod grader's main thread, #877). A read
 * that finds none is not kept, so an interface that comes up later is still found.
 */
export function firstNonInternalIpv4(interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null {
  if (interfaces !== undefined) return firstIpv4Of(interfaces);
  ownIpv4 ??= firstIpv4Of(os.networkInterfaces()) ?? undefined;
  return ownIpv4 ?? null;
}

/** firstNonInternalIpv4's own read, kept once it found one. */
let ownIpv4: string | undefined;

function firstIpv4Of(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null {
  for (const infos of Object.values(interfaces)) for (const i of infos ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}

export interface AgentPeerOptions {
  env?: NodeJS.ProcessEnv;
  /** The interfaces read (os.networkInterfaces()). */
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** A relay read's bound. */
  timeoutMs?: number;
}

/**
 * The address a pod's agent must admit (MAKEFUN_AGENT_PEERS), the header's peer: MAKEFUN_AGENT_PEER_IP; else the relay's
 * /v1/peer answer (cached per relay until a CONNECT through it fails; a read that fails is not cached); else this
 * process's first non-internal IPv4.
 */
export async function agentPeerIp(opts: AgentPeerOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const forced = env[AGENT_PEER_IP_ENV];
  if (forced !== undefined && forced !== '') {
    if (net.isIP(forced) === 0) throw new Error(`${AGENT_PEER_IP_ENV} ${JSON.stringify(forced)} is not an IP address`);
    return forced;
  }
  const relay = agentRelayFromEnv(env);
  if (relay !== null) {
    const key = relayKey(relay);
    let p = relayPeers.get(key);
    if (p === undefined) {
      p = readRelayPeer(relay, opts.timeoutMs ?? PEER_READ_TIMEOUT_MS);
      relayPeers.set(key, p);
      p.catch(() => {
        if (relayPeers.get(key) === p) relayPeers.delete(key);
      });
    }
    try {
      return await p;
    } catch (e) {
      throw new Error(`the agent relay's ${PEER_PATH} at ${relay.host}:${relay.port}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const ip = firstNonInternalIpv4(opts.interfaces);
  if (ip === null) throw new Error(`no non-internal IPv4 address to name as the agents' peer (set ${AGENT_PEER_IP_ENV})`);
  return ip;
}

// ---------------------------------------------------------------- the dial

interface Dial {
  deadline: number;
  signal: AbortSignal | undefined;
  connect: TcpConnect;
  attempts: number;
}

function dialFault(d: Dial, what: string, last: string | null): AgentDialError {
  if (d.signal?.aborted === true) return new AgentDialError(`${what}: cut off`, 'aborted', d.attempts);
  return new AgentDialError(`${what}: no connection within the budget after ${d.attempts} attempt${d.attempts === 1 ? '' : 's'}${last === null ? '' : ` (last: ${last})`}`, 'budget', d.attempts);
}

/** One TCP attempt, bounded: the socket, or why not and whether to re-dial at once (no answer) or after a pause. */
function tcpAttempt(d: Dial, host: string, port: number, boundMs: number): Promise<{ socket: net.Socket } | { why: string; now: boolean }> {
  return new Promise((resolve) => {
    d.attempts++;
    const socket = d.connect(host, port);
    let done = false;
    const settle = (r: { socket: net.Socket } | { why: string; now: boolean }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      d.signal?.removeEventListener('abort', onAbort);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      if (!('socket' in r)) {
        socket.on('error', noop);
        socket.destroy();
      }
      resolve(r);
    };
    const onConnect = (): void => settle({ socket });
    const onError = (e: NodeJS.ErrnoException): void => settle({ why: e.code ?? e.message, now: false });
    const onAbort = (): void => settle({ why: 'cut off', now: false });
    const timer = setTimeout(() => settle({ why: `no answer within ${boundMs} ms`, now: true }), boundMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
    d.signal?.addEventListener('abort', onAbort, { once: true });
    if (d.signal?.aborted === true) onAbort();
  });
}

/** TCP to host:port within the dial's budget: attempts of DIAL_ATTEMPT_MS, a refused or failed one re-dialled after DIAL_REFUSED_RETRY_MS. */
async function dialTcp(d: Dial, host: string, port: number, what: string): Promise<net.Socket> {
  let last: string | null = null;
  for (;;) {
    const left = d.deadline - performance.now();
    if (d.signal?.aborted === true || left <= 0) throw dialFault(d, what, last);
    const r = await tcpAttempt(d, host, port, Math.max(1, Math.min(DIAL_ATTEMPT_MS, Math.ceil(left))));
    if ('socket' in r) return r.socket;
    last = r.why;
    if (!r.now) await sleep(Math.min(DIAL_REFUSED_RETRY_MS, d.deadline - performance.now()), d.signal);
  }
}

/** The relay's answer head to a CONNECT: its status and the bytes after the head (none expected: TLS speaks first). */
function readConnectAnswer(socket: net.Socket, d: Dial): Promise<{ status: number; line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const finish = (err: Error | null, r?: { status: number; line: string; rest: Buffer }): void => {
      clearTimeout(timer);
      d.signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.pause();
      if (err !== null) reject(err);
      else resolve(r!);
    };
    const onData = (b: Buffer): void => {
      buf = Buffer.concat([buf, b]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.byteLength > HEAD_MAX_BYTES) finish(new Error(`the relay's answer head passed ${HEAD_MAX_BYTES} bytes`));
        return;
      }
      const line = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
      const m = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(line);
      if (m === null) return finish(new Error(`the relay answered ${JSON.stringify(line.slice(0, 100))}`));
      finish(null, { status: Number(m[1]), line, rest: buf.subarray(end + 4) });
    };
    const onError = (e: Error): void => finish(e);
    const onClose = (): void => finish(new Error('the relay closed the connection unanswered'));
    const onAbort = (): void => finish(new Error('cut off'));
    const timer = setTimeout(() => finish(new Error('no answer from the relay within the budget')), Math.max(1, d.deadline - performance.now()));
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    d.signal?.addEventListener('abort', onAbort, { once: true });
    if (d.signal?.aborted === true) onAbort();
  });
}

/**
 * A tunnel to ip:AGENT_PORT through the relay: re-dialled on its 502 and 503 within the budget, any other answer fatal.
 * An https:// relay's TLS (pinned) comes first: a pin that fails is fatal, any other TLS failure re-dialled.
 */
async function dialRelay(d: Dial, relay: AgentRelay, ip: string): Promise<net.Socket> {
  const what = `the agent at ${connectAuthority(ip)} through the relay ${relay.host}:${relay.port}`;
  const pin = relay.tls === true ? relayPin(relay.token) : null;
  let last: string | null = null;
  const spent = (): boolean => d.signal?.aborted === true || d.deadline - performance.now() <= 0;
  for (;;) {
    if (spent()) throw dialFault(d, what, last);
    const tcp = await dialTcp(d, relay.host, relay.port, what);
    let socket: net.Socket = tcp;
    if (pin !== null) {
      try {
        socket = await startRelayTls(tcp, relay, pin, d.deadline, d.signal);
      } catch (e) {
        tcp.destroy();
        forgetRelayPeer(relay);
        if (e instanceof RelayTlsError && e.pin) throw new AgentDialError(`${what}: ${e.message}`, 'pin', d.attempts);
        last = e instanceof Error ? e.message : String(e);
        if (spent()) throw dialFault(d, what, last);
        await sleep(Math.min(DIAL_REFUSED_RETRY_MS, d.deadline - performance.now()), d.signal);
        continue;
      }
    }
    socket.on('error', noop);
    socket.write(connectRequest(ip, relay.token));
    let answer: { status: number; line: string; rest: Buffer };
    try {
      answer = await readConnectAnswer(socket, d);
    } catch (e) {
      socket.destroy();
      tcp.destroy();
      forgetRelayPeer(relay);
      last = e instanceof Error ? e.message : String(e);
      if (spent()) throw dialFault(d, what, last);
      await sleep(Math.min(DIAL_REFUSED_RETRY_MS, d.deadline - performance.now()), d.signal);
      continue;
    }
    socket.removeListener('error', noop);
    if (answer.status === 200) {
      if (answer.rest.byteLength > 0) socket.unshift(answer.rest);
      return socket;
    }
    socket.destroy();
    tcp.destroy();
    forgetRelayPeer(relay);
    last = answer.line;
    if (answer.status !== 502 && answer.status !== 503) throw new AgentDialError(`${what}: the relay refused the CONNECT (${answer.line})`, 'relay', d.attempts);
    await sleep(Math.min(DIAL_REFUSED_RETRY_MS, d.deadline - performance.now()), d.signal);
  }
}

/** TLS 1.3 + h2 over `raw`, the pin checked on secureConnect before anything else is sent. */
function startTls(d: Dial, raw: net.Socket, ip: string, pin: Buffer, what: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      socket: raw,
      host: ip,
      ALPNProtocols: [AGENT_ALPN],
      minVersion: AGENT_TLS_VERSION,
      maxVersion: AGENT_TLS_VERSION,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    });
    let done = false;
    const finish = (err: AgentDialError | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      d.signal?.removeEventListener('abort', onAbort);
      socket.removeListener('secureConnect', onSecure);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (err === null) return resolve(socket);
      socket.on('error', noop);
      socket.destroy();
      reject(err);
    };
    const onSecure = (): void => {
      const why = checkAgentSocket(socket, pin);
      finish(why === null ? null : new AgentDialError(`${what}: ${why}`, 'pin', d.attempts));
    };
    const onError = (e: Error): void => finish(new AgentDialError(`${what}: TLS: ${e.message}`, 'tls', d.attempts));
    const onClose = (): void => finish(new AgentDialError(`${what}: the agent closed the connection before TLS completed (a source it does not admit as a peer?)`, 'tls', d.attempts));
    const onAbort = (): void => finish(dialFault(d, what, null));
    const timer = setTimeout(() => finish(new AgentDialError(`${what}: TLS did not complete within the budget`, 'budget', d.attempts)), Math.max(1, d.deadline - performance.now()));
    socket.once('secureConnect', onSecure);
    socket.once('error', onError);
    socket.once('close', onClose);
    d.signal?.addEventListener('abort', onAbort, { once: true });
    if (d.signal?.aborted === true) onAbort();
  });
}

// ---------------------------------------------------------------- an exec

/** RFC 9113's error codes by number, for a message. */
const RST_NAMES: Record<number, string> = { 0: 'NO_ERROR', 1: 'PROTOCOL_ERROR', 2: 'INTERNAL_ERROR', 3: 'FLOW_CONTROL_ERROR', 4: 'SETTINGS_TIMEOUT', 5: 'STREAM_CLOSED', 6: 'FRAME_SIZE_ERROR', 7: 'REFUSED_STREAM', 8: 'CANCEL', 9: 'COMPRESSION_ERROR', 10: 'CONNECT_ERROR', 11: 'ENHANCE_YOUR_CALM', 12: 'INADEQUATE_SECURITY', 13: 'HTTP_1_1_REQUIRED' };

interface ExecHost {
  /** The h2 session, or why there is none to start on. */
  sessionOrWhy(): http2.ClientHttp2Session | string;
  done(exec: Exec): void;
}

/** One exec's state: queued, then its stream, then its end. */
class Exec {
  readonly child: AgentChild;
  #req: http2.ClientHttp2Stream | null = null;
  #ended = false;
  #status = 0;
  #reason: Buffer[] = [];
  #reasonBytes = 0;
  #trailers: http2.IncomingHttpHeaders | null = null;
  #decoder = new FrameDecoder();
  #startWaiters: Array<() => void> = [];
  #drainWaiter: (() => void) | null = null;
  #resolveClosed!: (e: AgentEnd) => void;
  #resolveOpened!: () => void;
  #rejectOpened!: (e: Error) => void;
  #queuedAt = performance.now();
  /** The caller's released(): a lost end counts exit. */
  #released = false;
  readonly #stdout: Readable;
  readonly #stderr: Readable;

  readonly host: ExecHost;
  readonly kind: AgentContainerKind;
  readonly headers: http2.OutgoingHttpHeaders;
  readonly what: string;

  constructor(host: ExecHost, kind: AgentContainerKind, headers: http2.OutgoingHttpHeaders, what: string) {
    this.host = host;
    this.kind = kind;
    this.headers = headers;
    this.what = what;
    const closed = new Promise<AgentEnd>((r) => (this.#resolveClosed = r));
    const opened = new Promise<void>((resolve, reject) => {
      this.#resolveOpened = resolve;
      this.#rejectOpened = reject;
    });
    opened.catch(noop);
    const read = (): void => this.#resume();
    this.#stdout = new Readable({ read });
    this.#stderr = new Readable({ read });
    const stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => this.#whenStarted(() => this.#write(chunk, cb)),
      final: (cb) =>
        this.#whenStarted(() => {
          this.#endRequest();
          cb();
        }),
      destroy: (err, cb) => {
        this.#whenStarted(() => this.#endRequest());
        cb(err);
      },
    });
    stdin.on('error', noop);
    this.child = {
      stdin,
      stdout: this.#stdout,
      stderr: this.#stderr,
      closed,
      opened,
      kill: () => this.#kill(),
      released: () => {
        this.#released = true;
      },
    };
  }

  get started(): boolean {
    return this.#req !== null;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Start the stream on the session (a free slot is the caller's). */
  start(): void {
    if (this.#ended) return;
    const s = this.host.sessionOrWhy();
    if (typeof s === 'string') return this.#finish('unsent', s);
    let req: http2.ClientHttp2Stream;
    try {
      req = s.request(this.headers, { endStream: false });
    } catch (e) {
      return this.#finish('unsent', `the stream could not start: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.#req = req;
    req.on('error', noop);
    req.on('response', (h) => {
      this.#status = Number(h[':status']);
      if (this.#status === 200) {
        metrics.opened(this.kind, (performance.now() - this.#queuedAt) / 1000);
        this.#resolveOpened();
      }
    });
    req.on('data', (chunk: Buffer) => this.#data(chunk));
    req.on('trailers', (t) => (this.#trailers = t));
    req.on('end', () => this.#end());
    req.on('close', () => {
      this.#flushDrain();
      if (!this.#ended) this.#finish('lost', `${this.what}: the stream closed with no exit (${this.#closeWords(req)})`);
      this.host.done(this);
    });
    for (const w of this.#startWaiters.splice(0)) w();
  }

  /** The session ended under it (dead, destroyed): lost if it was sent, unsent if it was still queued. */
  sessionEnded(why: string): void {
    if (this.#ended) return;
    if (this.#req === null) this.#finish('unsent', why);
    else if (!this.#req.readableEnded) this.#finish('lost', `${this.what}: ${why}`);
  }

  #closeWords(req: http2.ClientHttp2Stream): string {
    const code = req.rstCode;
    return code === undefined ? 'closed' : `RST_STREAM ${RST_NAMES[code] ?? code}`;
  }

  #whenStarted(f: () => void): void {
    if (this.#req !== null || this.#ended) f();
    else this.#startWaiters.push(f);
  }

  #requestOpen(): boolean {
    const req = this.#req;
    return req !== null && !req.destroyed && !req.writableEnded && !this.#ended;
  }

  #write(chunk: Buffer, cb: (err?: Error | null) => void): void {
    // Bytes the program can no longer take are dropped, as a pipe to an ended kubectl drops them.
    if (!this.#requestOpen()) return cb();
    if (this.#req!.write(chunk)) return cb();
    this.#drainWaiter = () => cb();
    this.#req!.once('drain', () => this.#flushDrain());
  }

  #flushDrain(): void {
    const w = this.#drainWaiter;
    this.#drainWaiter = null;
    w?.();
  }

  #endRequest(): void {
    if (this.#requestOpen()) this.#req!.end();
  }

  #data(chunk: Buffer): void {
    if (this.#ended) return;
    if (this.#status !== 200) {
      if (this.#reasonBytes < REASON_MAX_BYTES) {
        this.#reason.push(chunk);
        this.#reasonBytes += chunk.byteLength;
      }
      return;
    }
    let frames;
    try {
      frames = this.#decoder.push(chunk);
    } catch (e) {
      return this.#finish('protocol', `${this.what}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let full = false;
    for (const f of frames) if (!(f.channel === STDOUT_CHANNEL ? this.#stdout : this.#stderr).push(f.data)) full = true;
    if (full) this.#req?.pause();
  }

  /**
   * A reader asked for more (stdout's or stderr's _read): take the stream's bytes again. _read comes before the reader
   * has taken what is buffered and is not asked again until a push, so it resumes unconditionally; the next push past
   * either side's high-water mark pauses the stream once more (one chunk past it at most), and the agent's window shuts
   * behind it.
   */
  #resume(): void {
    const req = this.#req;
    if (req !== null && !this.#ended && req.isPaused()) req.resume();
  }

  #end(): void {
    if (this.#ended) return;
    if (this.#status !== 200) {
      const reason = Buffer.concat(this.#reason).subarray(0, REASON_MAX_BYTES).toString('utf8').trim();
      return this.#finish('refused', `${this.what}: the agent answered ${this.#status === 0 ? 'nothing' : this.#status}${reason === '' ? '' : `: ${reason}`}`);
    }
    try {
      this.#decoder.finish();
    } catch (e) {
      return this.#finish('protocol', `${this.what}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const exit = this.#trailers?.[EXIT_TRAILER];
    if (exit === undefined) return this.#finish('lost', `${this.what}: the stream ended with no exit (the agent's container ending?)`);
    let code: number;
    try {
      code = parseExit(typeof exit === 'string' ? exit : String(exit));
    } catch (e) {
      return this.#finish('protocol', `${this.what}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.#finish('exit', null, code);
  }

  #kill(): void {
    if (this.#ended) return;
    this.#finish('killed', `${this.what}: killed`);
  }

  #finish(outcome: AgentExecOutcome, why: string | null, code: number | null = null): void {
    if (this.#ended) return;
    this.#ended = true;
    const req = this.#req;
    if (req !== null && !req.closed && !req.destroyed) {
      // An exit with stdin still open closes the request side normally; every other end cancels the stream, which
      // closes the program's pipes (the wire's cancel) and never signals it.
      req.close(outcome === 'exit' ? http2.constants.NGHTTP2_NO_ERROR : http2.constants.NGHTTP2_CANCEL);
    }
    this.#flushDrain();
    for (const w of this.#startWaiters.splice(0)) w();
    if (this.#status !== 200) this.#rejectOpened(new AgentExecError(why ?? `${this.what}: never opened`, outcome, this.#status === 0 ? null : this.#status));
    metrics.exec(this.kind, outcome === 'lost' && this.#released ? 'exit' : outcome);
    if (req === null) this.host.done(this);
    const end: AgentEnd =
      outcome === 'exit'
        ? { code, signal: null, outcome }
        : outcome === 'killed'
          ? { code: null, signal: 'SIGKILL', outcome }
          : { code: null, signal: null, error: why ?? outcome, outcome, ...(outcome === 'refused' && this.#status !== 0 ? { status: this.#status } : {}) };
    this.#stdout.push(null);
    this.#stderr.push(null);
    if (outcome === 'killed') return this.#resolveClosed(end);
    void Promise.all([delivered(this.#stdout), delivered(this.#stderr)]).then(() => this.#resolveClosed(end));
  }
}

/**
 * Resolves once `r` (ended by push(null)) has handed out every byte it holds, as a killed kubectl's pipes close after
 * their last byte is read: at its 'end' when it flows, once emptied when paused, at once when nobody ever read it.
 */
function delivered(r: Readable): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      const done = r.readableEnded || r.destroyed || r.readableFlowing === null || (r.readableFlowing === false && r.readableLength === 0);
      if (!done) return;
      for (const ev of ['end', 'close', 'pause', 'resume'] as const) r.removeListener(ev, later);
      resolve();
    };
    const later = (): void => void setImmediate(check);
    for (const ev of ['end', 'close', 'pause', 'resume'] as const) r.on(ev, later);
    check();
  });
}

// ---------------------------------------------------------------- the session

/** One agent of a pod (the header): open with AgentSession.open, close at the pod's end. */
export class AgentSession {
  readonly ip: string;
  readonly agent: AgentName;
  /** The TCP attempts the open made. */
  readonly attempts: number;
  /** The open's time, ms. */
  readonly openMs: number;
  /** Resolves with why the session ended (closed, dead, destroyed). */
  readonly ended: Promise<string>;
  #session: http2.ClientHttp2Session;
  #token: string;
  #what: string;
  #dead: string | null = null;
  #accepting = true;
  #active = new Set<Exec>();
  #queue: Exec[] = [];
  #ping: NodeJS.Timeout;
  #pingsOut = 0;
  #misses = 0;
  #resolveEnded!: (why: string) => void;
  #counted = true;
  /** Why the agent stopped taking streams (its GOAWAY), or why the caller did (close()). */
  #goaway: string | null = null;
  #closing: string | null = null;

  private constructor(session: http2.ClientHttp2Session, token: string, opts: AgentSessionOptions, attempts: number, openMs: number, what: string) {
    this.#session = session;
    this.#token = token;
    this.ip = opts.ip;
    this.agent = opts.agent;
    this.attempts = attempts;
    this.openMs = openMs;
    this.#what = what;
    this.ended = new Promise((r) => (this.#resolveEnded = r));
    metrics.sessions(1);
    session.on('error', (e) => this.#die(`the session failed: ${e.message}`));
    session.on('goaway', (code) => {
      this.#accepting = false;
      this.#goaway = `the agent sent GOAWAY (${code})`;
      for (const e of this.#queue.splice(0)) e.sessionEnded(`${this.#what}: ${this.#goaway}: never sent`);
    });
    session.on('close', () => this.#die(this.#closing ?? this.#goaway ?? 'the session closed'));
    session.on('remoteSettings', () => this.#pump());
    const every = opts.pingEveryMs ?? PING_EVERY_MS;
    this.#ping = setInterval(() => this.#tick(), every);
    this.#ping.unref();
  }

  /** Dial, check the pin, open h2 and wait for the agent's SETTINGS, within `budgetMs`. */
  static async open(opts: AgentSessionOptions): Promise<AgentSession> {
    if (!CONTAINER_NAME_RE.test(opts.agent) || (opts.agent !== 'stage' && opts.agent !== 'watch')) throw new Error(`agent session: ${JSON.stringify(opts.agent)} is not stage or watch`);
    if (net.isIP(opts.ip) === 0) throw new Error(`agent session: ${JSON.stringify(opts.ip)} is not an IP address`);
    const key = typeof opts.key === 'string' ? parseAgentKey(opts.key) : Buffer.from(opts.key);
    const pin = agentPin(key);
    const clientKey = deriveClientKey(key);
    const relay = opts.relay === undefined ? agentRelayFromEnv(opts.env) : opts.relay;
    const port = opts.port ?? AGENT_PORT;
    const started = performance.now();
    const d: Dial = { deadline: started + opts.budgetMs, signal: opts.signal, connect: opts.connect ?? defaultConnect, attempts: 0 };
    const what = relay === null ? `the ${opts.agent} agent at ${connectAuthority(opts.ip, port)}` : `the ${opts.agent} agent at ${connectAuthority(opts.ip)} through the relay ${relay.host}:${relay.port}`;
    const raw = relay === null ? await dialTcp(d, opts.ip, port, what) : await dialRelay(d, relay, opts.ip);
    raw.setNoDelay(true);
    const socket = await startTls(d, raw, opts.ip, pin, what);
    const token = agentToken(clientKey, connectionExporter(socket));
    const session = http2.connect(`https://${connectAuthority(opts.ip, port)}`, {
      createConnection: () => socket,
      settings: { ...H2_SETTINGS },
      maxSessionMemory: H2_CLIENT_MAX_SESSION_MEMORY_MB,
      maxSendHeaderBlockLength: H2_MAX_SEND_HEADER_BLOCK_LENGTH,
    });
    session.on('error', noop);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (err: AgentDialError | null): void => {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          session.removeListener('remoteSettings', onSettings);
          session.removeListener('close', onClose);
          session.removeListener('error', onError);
          if (err === null) resolve();
          else reject(err);
        };
        const onSettings = (): void => finish(null);
        const onClose = (): void => finish(new AgentDialError(`${what}: the session closed before the agent's SETTINGS`, 'tls', d.attempts));
        const onError = (e: Error): void => finish(new AgentDialError(`${what}: h2: ${e.message}`, 'tls', d.attempts));
        const onAbort = (): void => finish(dialFault(d, what, null));
        const timer = setTimeout(() => finish(new AgentDialError(`${what}: no SETTINGS from the agent within the budget`, 'budget', d.attempts)), Math.max(1, d.deadline - performance.now()));
        session.once('remoteSettings', onSettings);
        session.once('close', onClose);
        session.once('error', onError);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        if (opts.signal?.aborted === true) onAbort();
      });
    } catch (e) {
      session.destroy();
      throw e;
    }
    session.setLocalWindowSize(H2_CONNECTION_WINDOW);
    session.removeListener('error', noop);
    return new AgentSession(session, token, opts, d.attempts, performance.now() - started, what);
  }

  /** Whether new execs can start. */
  get alive(): boolean {
    return this.#dead === null && this.#accepting;
  }

  /** Streams open on the agent now, and execs waiting here for a slot. */
  get load(): { active: number; queued: number } {
    return { active: this.#active.size, queued: this.#queue.length };
  }

  /** The agent's SETTINGS_MAX_CONCURRENT_STREAMS (H2_SETTINGS' when it named none). */
  get maxStreams(): number {
    const n = this.#session.remoteSettings?.maxConcurrentStreams;
    return n === undefined || n <= 0 || n > 0xffff_ffff - 1 ? H2_SETTINGS.maxConcurrentStreams : n;
  }

  /** One exec of argv in `container` (the session's own agent's, or a member's): the header's AgentChild. */
  stream(container: string, argv: readonly string[]): AgentChild {
    if (!CONTAINER_NAME_RE.test(container)) throw new Error(`agent exec: ${JSON.stringify(container)} is not a container name`);
    const own = container === this.agent;
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': EXEC_PATH,
      [AUTH_HEADER]: this.#token,
      [ARGV_HEADER]: encodeArgvHeader(argv),
      ...(own ? {} : { [CONTAINER_HEADER]: container }),
      // An argv can carry whole scripts: never indexed in the HPACK table, where it would only evict the token.
      [http2.sensitiveHeaders]: [ARGV_HEADER],
    };
    const exec = new Exec(this.#host, own ? this.agent : 'member', headers, `${this.#what}: exec ${argvWords(argv)}${own ? '' : ` in ${container}`}`);
    if (!this.alive) {
      exec.sessionEnded(`${exec.what}: ${this.#dead ?? this.#goaway ?? 'the session is closed'}: never sent`);
      return exec.child;
    }
    this.#queue.push(exec);
    this.#pump();
    return exec.child;
  }

  /** stream() to its end, as a KubectlResult: stdout and stderr whole (UTF-8), `error` for every end but an exit. */
  async run(container: string, argv: readonly string[], opts: AgentRunOptions = {}): Promise<AgentResult> {
    const child = this.stream(container, argv);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    let cut: string | null = null;
    const stop = (why: string): void => {
      cut ??= why;
      child.kill();
    };
    const timer = opts.timeoutMs === undefined ? null : setTimeout(() => stop(`no exit within ${opts.timeoutMs} ms`), opts.timeoutMs);
    timer?.unref();
    const onAbort = (): void => stop('cut off');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted === true) onAbort();
    child.stdin.end(opts.input === undefined ? undefined : typeof opts.input === 'string' ? Buffer.from(opts.input, 'utf8') : opts.input);
    const end = await child.closed;
    if (timer !== null) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    const res: AgentResult = { code: end.code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), outcome: end.outcome };
    if (cut !== null) res.error = `${this.#what}: exec ${argvWords(argv)}: ${cut}`;
    else if (end.error !== undefined) res.error = end.error;
    return res;
  }

  /** GET /v1/health: the agent's mode, version, connected members and uptime. Its first answer is the init clock's end. */
  health(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AgentHealth> {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new AgentExecError(`${this.#what}: health: ${this.#dead ?? this.#goaway ?? 'the session is closed'}`, 'unsent'));
      let req: http2.ClientHttp2Stream;
      try {
        req = this.#session.request({ ':method': 'GET', ':path': HEALTH_PATH, [AUTH_HEADER]: this.#token }, { endStream: true });
      } catch (e) {
        return reject(new AgentExecError(`${this.#what}: health: ${e instanceof Error ? e.message : String(e)}`, 'unsent'));
      }
      let status = 0;
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const limit = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
      const finish = (err: AgentExecError | null, h?: AgentHealth): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (!req.closed) req.close(http2.constants.NGHTTP2_CANCEL);
        if (err === null) resolve(h!);
        else reject(err);
      };
      const onAbort = (): void => finish(new AgentExecError(`${this.#what}: health: cut off`, 'killed'));
      const timer = setTimeout(() => finish(new AgentExecError(`${this.#what}: health: no answer within ${limit} ms`, 'killed')), limit);
      timer.unref();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted === true) onAbort();
      req.on('error', noop);
      req.on('response', (h) => (status = Number(h[':status'])));
      req.on('data', (b: Buffer) => {
        size += b.byteLength;
        if (size > BODY_MAX_BYTES) return finish(new AgentExecError(`${this.#what}: health: the answer passed ${BODY_MAX_BYTES} bytes`, 'protocol'));
        chunks.push(b);
      });
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (status !== 200) return finish(new AgentExecError(`${this.#what}: health: the agent answered ${status === 0 ? 'nothing' : status}${body.trim() === '' ? '' : `: ${body.trim().slice(0, 200)}`}`, 'refused', status === 0 ? null : status));
        try {
          finish(null, parseHealth(body));
        } catch (e) {
          finish(new AgentExecError(`${this.#what}: health: ${e instanceof Error ? e.message : String(e)}`, 'protocol'));
        }
      });
      req.on('close', () => finish(new AgentExecError(`${this.#what}: health: the stream closed unanswered`, 'lost')));
    });
  }

  /** The pod's end: no new exec; the open ones may finish within `graceMs`, then the session is destroyed. */
  async close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    this.#accepting = false;
    this.#closing ??= 'closed by the caller';
    for (const e of this.#queue.splice(0)) e.sessionEnded(`${e.what}: the session was closed: never sent`);
    if (this.#dead === null) {
      const t = setTimeout(() => this.#die('closed by the caller'), graceMs);
      t.unref();
      this.#session.close(() => clearTimeout(t));
      if (this.#active.size === 0) this.#die('closed by the caller');
    }
    await this.ended;
  }

  /** Destroy the session now: every open stream ends lost, every queued one unsent. */
  destroy(why = 'destroyed by the caller'): void {
    this.#die(why);
  }

  readonly #host: ExecHost = {
    sessionOrWhy: () => (this.#dead !== null ? this.#dead : !this.#accepting ? (this.#closing ?? this.#goaway ?? 'the session is closed') : this.#session),
    done: (exec) => {
      if (this.#active.delete(exec)) this.#pump();
    },
  };

  #pump(): void {
    while (this.#queue.length > 0 && this.alive && this.#active.size < this.maxStreams) {
      const exec = this.#queue.shift()!;
      if (exec.ended) continue;
      this.#active.add(exec);
      exec.start();
      if (!exec.started) this.#active.delete(exec);
    }
  }

  #tick(): void {
    if (this.#dead !== null) return;
    if (this.#pingsOut > 0) {
      this.#misses++;
      if (this.#misses >= PING_MISSES_DEAD) return this.#die(`${this.#misses} PINGs in a row unanswered: the session is dead`);
    }
    try {
      const sent = this.#session.ping((err) => {
        this.#pingsOut = Math.max(0, this.#pingsOut - 1);
        if (err === null) this.#misses = 0;
      });
      if (sent) this.#pingsOut++;
    } catch {
      // A session past its end cannot PING; its close says why.
    }
  }

  #die(why: string): void {
    if (this.#dead !== null) return;
    this.#dead = why;
    this.#accepting = false;
    clearInterval(this.#ping);
    for (const e of this.#queue.splice(0)) e.sessionEnded(`${e.what}: ${why}: never sent`);
    for (const e of [...this.#active]) e.sessionEnded(why);
    if (!this.#session.destroyed) this.#session.destroy();
    if (this.#counted) {
      this.#counted = false;
      metrics.sessions(-1);
    }
    this.#resolveEnded(why);
  }
}

/** argv for a message: its first words, bounded. */
function argvWords(argv: readonly string[]): string {
  const words = argv.slice(0, 3).map((a) => (a.length > 40 ? `${a.slice(0, 40)}…` : a));
  return JSON.stringify(argv.length > 3 ? [...words, '…'] : words);
}
