// A grader's warm pool of grade-family sandbox pods (k8s.ts's header, Warm pool; the init-time plan's P1, P3 and P4):
// pods of the shapes its grades spawn, booted ahead of the runs that will take them, so a spawn that finds one skips the
// whole pod start (the create, the scheduler, the sandbox's start, the `stage` agent's) and goes on from the staging.
//
// What a pool pod is. A program pod made exactly as a cold spawn's (K8sSandbox's #spawn: sandboxPodSpec of the shape,
// its `<pod>-env` Secret first, the same create under the pace), plus POOL_ANNOTATION naming its shape's key, booted up to
// its `stage` agent's first authenticated answer (k8s.ts bootToAgent: the pin on HKDF(K) checked at the dial, the HMAC
// of K on every request), and held: the pod, its Secret and that `stage` session. Nothing of any run is in it (the
// header's Pool-ready: a grade-family pod is the same pod for every run of one shape, the name and K aside), and no
// entrant's code reaches it before a spawn takes it and stages its trees.
//
//   take(shape)   a spawn's ask, before it makes a pod (K8sSandbox #spawn, for a pool-ready spec): the oldest ready pod
//                 of its shape whose `stage` agent answers the claim (claimed: a /v1/health over its kept session, or a
//                 re-dial when that session is gone or does not answer, the pin checked again), handed over whole (its
//                 name, refs, IP, K and session: the spawn stages into it, waits Ready and deletes it as its own); a pod
//                 that does not answer is deleted (`expired`) and the next one asked, all within POOL_CLAIM_CHECK_MS;
//                 none left (or that time spent), null (`miss`) and the spawn boots cold. Every take is that shape's
//                 demand, whichever way it went.
//   one spawn     a pod is taken once, by one spawn, and deleted with it: never handed back, never reused.
//   TTL           a pod not taken within ttlMs (POOL_TTL_MS) of being ready is deleted (`expired`), well inside its
//                 `stage` agent's own STAGE_ARRIVAL_S (after which the agent exits and the pod fails by itself).
//   drain         drain() (server/server.ts's SIGTERM drain, before anything else waits) stops the refills, cuts every
//                 boot in flight and deletes every pod of the pool, awaited.
//   restart       a pool's pods are never adopted: K holds them, and K lives in this process alone. A pool's first
//                 attach (its places) sweeps every pod annotated POOL_ANNOTATION whose creator is its own pod
//                 (opts.sweep: what a run of its container before a restart left), before its first refill; another
//                 creator's are the orphan reap's (k8s.ts reapOrphans: the creator annotation, as every sandbox pod's).
//
// Places (server/pod-pool.ts's warm places, attach: JobQueue.attachWarmPool). Every pool pod, booting or ready, stands on
// a place of its process's pod budget (MAKEFUN_K8S_SANDBOX_POD_BUDGET) taken early for the grade work in hand: counted
// under the budget beside the jobs' places (the queue's line sees it in use, makefun_sandbox_pool_used_pods{class=warm}),
// and every Pending one counted held by the capacity read (K8sSandbox.sandboxPodsHeld), so the dynamic budget does not
// read low. The sandbox pool hands a freed place to the pool first while it wants one (warmPlaces.wanted), so a wave
// that fills the budget keeps the pool at its want rather than trimming it to nothing; a grade job that waits only for
// the warm places takes one with a booted pod as its own place (warmPlaces.converted: no second place), and its spawn's
// take hits that pod; a job already holding its place that takes a pod leaves the pod's place to the pool (refilled, or
// given back). A converted place whose take does not come within POOL_PROMISE_MS (its spawn missed: another shape), or
// whose take missed, leaves a pod with no place: deleted. Places are given back as soon as no pod needs them.
//
// How deep. Each shape's want is its demand over its refill time: the rate of its takes (an exponential average with
// time constant POOL_RATE_TAU_MS) times the p95 of the refills measured in the last POOL_REFILL_WINDOW_MS (this pool's
// own boots, the spawns' cold boots beside them: noteBoot; POOL_REFILL_PRIOR_MS until one is in), rounded up, and none
// for a shape that expects less than one take within the TTL (its pod would expire). The wants are summed over every
// shape seen, so a wave of several shapes is sized as a whole, and are held under:
//
//   the ceiling   opts.max, the grader's own (server/config.ts MAKEFUN_K8S_WARM_POOL_MAX);
//   the work      the grade jobs in hand (WarmBudget.entitled: grade-dev and grade-final places in use and jobs
//                 waiting): the pool never boots more pods than those jobs would start anyway, and a process with none
//                 holds none;
//   the room      POOL_ROOM_SHARE of the nodes' free places beside POOL_NODE_HEADROOM, per live grader, counted with
//                 the pool's own pods (opts.room): the pool shrinks first when the nodes run short;
//   the budget    a place it cannot hold (WarmBudget.hold: no free place beside every class's places and reserves, or
//                 a trial's or another class's job waiting) boots nothing.
//
// The ceiling, the work and the room are hard: a pool over any of them deletes pods at once (the ready ones first, the
// shape most over its want first), and so it does at every spawn (nudge) and every tick (POOL_TICK_MS); trimming only
// ever drops pods no grade job in hand would take. The wants only stop the growth: a pod already booted waits for its
// take or its TTL. No places attached (no sandbox pool: no pod budget) holds no pool, and reads nothing: the tick and
// the nudge read the room only once a shape has been asked for and places are attached.
//
// The refills go under the process's sandbox pace (k8s.ts SandboxPace) as every create does, but only into the slots
// no start is waiting for, half of them at most (opts.paceRoom), so a refill never puts a spawn's own create or exec
// behind it. A shape whose boot fails waits POOL_BACKOFF_MS before its next, doubling to POOL_BACKOFF_MAX_MS; what the
// failed boot made is deleted.
//
// Metrics (registerPoolMetrics, on the process's registry; agent-client.ts's init clock beside them, its `source` label
// warm or cold):
//
//   makefun_k8s_sandbox_pool_pods{state}           the pools' pods now: booting | ready (taken ones are their spawns')
//   makefun_k8s_sandbox_pool_takes_total{outcome}  hit (a spawn took a pod) | miss (it found none and booted cold) |
//                                                  expired (a pod deleted untaken: its TTL, or no answer at its claim);
//                                                  every series 0 from registration

import type { PodAgentSession } from './k8s.ts';

/** How long a ready pod waits for a take before it is deleted (the header's TTL). */
export const POOL_TTL_MS = 120_000;
/** How often a pool re-reads its room and re-sizes (an unref'd timer). */
export const POOL_TICK_MS = 1_000;
/** The time constant of a shape's take rate (an exponential average: a take adds 1/τ, the rate decays by e^(−t/τ)). */
export const POOL_RATE_TAU_MS = 60_000;
/** The refills the depth is sized from: those of the last this many ms. */
export const POOL_REFILL_WINDOW_MS = 5 * 60_000;
/** At most this many refills kept. */
export const POOL_REFILL_SAMPLES = 256;
/**
 * The refill time assumed before one is measured: a grade-family pod's init p50 at low churn on makefun-prod
 * (2.4-2.8 s, the init-time record's §2a), replaced by the measured p95 as soon as one boot ends.
 */
export const POOL_REFILL_PRIOR_MS = 3_000;
/**
 * How long one take may spend on claims (the kept sessions' /v1/health, the re-dials): past it the spawn boots cold,
 * the pods not yet asked kept, so a pool of silent pods never holds a spawn longer than this.
 */
export const POOL_CLAIM_CHECK_MS = 2_000;
/** The share of a grader's free places on the nodes its pool may hold (the header's room). */
export const POOL_ROOM_SHARE = 0.5;
/** The free places each node keeps beside the pool (server/jobs.ts NODE_POD_HEADROOM, restated: grader/ imports no server code). */
export const POOL_NODE_HEADROOM = 4;
/** A shape's first wait after a failed boot; it doubles with each failure in a row, to POOL_BACKOFF_MAX_MS. */
export const POOL_BACKOFF_MS = 5_000;
export const POOL_BACKOFF_MAX_MS = 60_000;
/** A shape with no take for this long, and no pod, is forgotten. */
export const POOL_SHAPE_FORGET_MS = 10 * 60_000;
/** The most a pool's ceiling may be (MAKEFUN_K8S_WARM_POOL_MAX's range). */
export const POOL_MAX_CEILING = 128;

/** A shape a pool holds pods of: its key (k8s.ts shapeKeyOf, the pods' POOL_ANNOTATION) and the label its pods are named for. */
export interface PoolShape {
  readonly key: string;
  readonly label: string;
}

/** A pool pod booted to its `stage` agent (k8s.ts bootToAgent): what a take hands its spawn. */
export interface WarmPod {
  readonly name: string;
  /** `kind/name` of everything made for it, the pod first: what its delete takes (k8s.ts deleteObjects). */
  readonly refs: readonly string[];
  readonly ip: string;
  /** Its agents' K, from its Secret. */
  readonly key: string;
  /** Its `stage` agent's session: kept from the boot, or the claim's re-dial. */
  stage: PodAgentSession;
  /** Whether it has `watch` (its shape's writable mounts). */
  readonly watched: boolean;
  /** Its shape's key. */
  readonly shape: string;
}

/** One pool boot's end (opts.boot): the pod, or why not and what it may have made (deleted by the pool). */
export type PoolBoot = { ok: true; pod: WarmPod } | { ok: false; killed: boolean; error: string; noRoom: string | null; refs: readonly string[] };

/**
 * What a sandbox pool hands its warm pool (server/pod-pool.ts WarmBudget, restated: grader/ imports no server code; the
 * header's places): how it holds and gives back a place, and the grade jobs in hand its places never pass.
 */
export interface WarmBudget {
  hold(): boolean;
  release(): void;
  entitled(): number;
  /** A pod of its booted: the sandbox pool walks its line again, so a grade job waiting for the warm places takes it. */
  poke(): void;
}

/**
 * A warm pool as its sandbox pool sees it (server/pod-pool.ts WarmPlaces, restated; K8sWarmPool.warmPlaces): every call
 * synchronous, made inside the sandbox pool's walk.
 */
export interface WarmPlacesView {
  wanted(): number;
  convertible(): number;
  placed(): void;
  converted(cls: string): void;
}

/** How long a converted place waits for its job's take before the pod with no place is deleted (the header's places). */
export const POOL_PROMISE_MS = 30_000;

/**
 * A shape's want (the header's depth): its take rate (per ms) times the refill p95 (ms), rounded up; 0 when fewer than
 * one take is expected within `ttlMs`.
 */
export function shapeWant(ratePerMs: number, refillMs: number, ttlMs: number): number {
  if (!(ratePerMs > 0) || ratePerMs * ttlMs < 1) return 0;
  return Math.max(1, Math.ceil(ratePerMs * refillMs - 1e-9));
}

/**
 * `wants` held to `cap` in all: unchanged when they fit, else each its share of the cap by its want, rounded down, the
 * places left given by the largest remainders (the larger want first on a tie).
 */
export function shareWants(wants: ReadonlyMap<string, number>, cap: number): Map<string, number> {
  const total = [...wants.values()].reduce((a, b) => a + b, 0);
  if (total <= cap) return new Map(wants);
  const out = new Map<string, number>();
  const rest: Array<{ key: string; frac: number; want: number }> = [];
  let given = 0;
  for (const [key, want] of wants) {
    const exact = (want * Math.max(0, cap)) / total;
    const n = Math.floor(exact);
    out.set(key, n);
    given += n;
    rest.push({ key, frac: exact - n, want });
  }
  rest.sort((a, b) => b.frac - a.frac || b.want - a.want);
  for (const r of rest) {
    if (given >= cap) break;
    out.set(r.key, out.get(r.key)! + 1);
    given++;
  }
  return out;
}

/** The p95 of `ms` (nearest rank), or null for none. */
export function p95Of(ms: readonly number[]): number | null {
  if (ms.length === 0) return null;
  const sorted = [...ms].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

/** A take rate: an exponential average of events (the header's depth), read per ms. */
class Rate {
  #value = 0;
  #at = 0;
  readonly tauMs: number;
  constructor(tauMs: number) {
    this.tauMs = tauMs;
  }
  add(now: number): void {
    this.#value = this.at(now) + 1 / this.tauMs;
    this.#at = now;
  }
  at(now: number): number {
    return this.#value * Math.exp(-Math.max(0, now - this.#at) / this.tauMs);
  }
}

interface ReadyPod {
  pod: WarmPod;
  readyAt: number;
  timer: NodeJS.Timeout;
}

interface Booting {
  readonly abort: AbortController;
  readonly startedAt: number;
  /** Trimmed or drained while it booted: what it makes is deleted, never held. */
  cancelled: boolean;
  done: Promise<void>;
}

interface ShapeState<S extends PoolShape> {
  /** The latest spawn's shape: what a refill builds from. */
  shape: S;
  readonly ready: ReadyPod[];
  readonly booting: Set<Booting>;
  readonly rate: Rate;
  lastAsked: number;
  failures: number;
  backoffUntil: number;
}

export interface K8sWarmPoolOptions<S extends PoolShape> {
  /** The ceiling (the header's): the most pods it holds, booting and ready, a whole number from 1 to POOL_MAX_CEILING. */
  max: number;
  /** The TTL (default POOL_TTL_MS). */
  ttlMs?: number;
  /** A pod of `shape` made and booted to its `stage` agent (K8sSandbox's: k8s.ts bootToAgent), cut by `signal`. Never rejects. */
  boot(shape: S, signal: AbortSignal): Promise<PoolBoot>;
  /** Delete what `refs` name (k8s.ts deleteObjects: the short grace). Never rejects. */
  remove(refs: readonly string[]): Promise<void>;
  /** A claim's re-dial of `pod`'s `stage` agent (its pin checked again), within `budgetMs`; rejects when it cannot be had. */
  redial(pod: WarmPod, budgetMs: number): Promise<PodAgentSession>;
  /** The nodes' free places beside POOL_NODE_HEADROOM, per live grader, or null when they cannot be read. */
  room(): Promise<number | null>;
  /** How many creates a refill may start now without any start waiting for a slot (Infinity with no pace). */
  paceRoom(): number;
  /** This creator's own pool pods left by an earlier run of it, deleted (the header's restart). Never rejects. */
  sweep(): Promise<void>;
  warn: (line: string) => void;
  /** Its clock (default Date.now). */
  now?: () => number;
  /** How often it re-sizes (default POOL_TICK_MS); 0 for no timer (a test drives nudge()). */
  tickMs?: number;
  /** Its take rates' time constant (default POOL_RATE_TAU_MS): a test's shorter one. */
  rateTauMs?: number;
}

/** Every pool of the process not yet drained: what the pods gauge sums. */
const POOLS = new Set<{ readonly pods: { booting: number; ready: number } }>();

/** The process's takes by outcome, counted before the registry registers (and added then). */
export const POOL_TAKE_OUTCOMES = Object.freeze(['hit', 'miss', 'expired'] as const);
export type PoolTakeOutcome = (typeof POOL_TAKE_OUTCOMES)[number];
export const POOL_POD_STATES = Object.freeze(['booting', 'ready'] as const);
const takesTally: Record<PoolTakeOutcome, number> = { hit: 0, miss: 0, expired: 0 };
let takesCounter: { inc(labels: { outcome: PoolTakeOutcome }): void } | null = null;

function countTake(outcome: PoolTakeOutcome): void {
  takesTally[outcome]++;
  takesCounter?.inc({ outcome });
}

/** The pool metrics' names (the header): the dashboards read these, so they never change. */
export const POOL_METRICS = Object.freeze({
  pods: 'makefun_k8s_sandbox_pool_pods',
  takes: 'makefun_k8s_sandbox_pool_takes_total',
});

let registering: Promise<void> | null = null;

/**
 * Register the pool metrics on the process's registry (server/ops/metrics.ts metricsRegistry), once a process, as
 * agent-client.ts registerAgentMetrics does: every outcome's series from 0 (plus what was counted before), the pods
 * gauge read at each scrape. A failure is said and drops only the metrics.
 */
export function registerPoolMetrics(warn: (line: string) => void): Promise<void> {
  registering ??= (async () => {
    try {
      const [{ metricsRegistry }, { Counter, Gauge }] = await Promise.all([import('../../server/ops/metrics.ts'), import('@prometheus-io/client')]);
      if (metricsRegistry.getSingleMetric(POOL_METRICS.takes) !== undefined) return;
      const takes = new Counter({
        name: POOL_METRICS.takes,
        help: "Warm pool takes by outcome: hit (a spawn took a booted pod) | miss (it found none of its shape and booted cold) | expired (a pool pod deleted untaken: its TTL, or no answer from its agent at a claim).",
        labelNames: ['outcome'] as const,
        registers: [metricsRegistry],
      });
      for (const outcome of POOL_TAKE_OUTCOMES) takes.inc({ outcome }, takesTally[outcome]);
      new Gauge({
        name: POOL_METRICS.pods,
        help: "Warm pool pods now, by state: booting (made, its stage agent not yet answering) | ready (booted, waiting for a spawn of its shape). A taken pod is its spawn's, in neither.",
        labelNames: ['state'] as const,
        registers: [metricsRegistry],
        collect() {
          const sum = { booting: 0, ready: 0 };
          for (const p of POOLS) {
            sum.booting += p.pods.booting;
            sum.ready += p.pods.ready;
          }
          for (const state of POOL_POD_STATES) this.set({ state }, sum[state]);
        },
      });
      takesCounter = { inc: (labels) => takes.inc(labels) };
    } catch (err) {
      warn(`k8s sandbox: the warm pool metrics could not be registered (the pool runs unmeasured): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return registering;
}

/** The warm pool (the header): one per K8sSandbox that has one, so one per grader process. */
export class K8sWarmPool<S extends PoolShape = PoolShape> {
  readonly max: number;
  readonly ttlMs: number;
  /** This pool's takes by outcome (the metric counts every pool's). */
  readonly counts: Record<PoolTakeOutcome, number> = { hit: 0, miss: 0, expired: 0 };
  /** Settles once its restart sweep has ended (opts.sweep, at its first attach): no refill starts before it. Never rejects. */
  readonly started: Promise<void>;
  /** What its sandbox pool reads and tells it inside its walk (the header's places; JobQueue.attachWarmPool). */
  readonly warmPlaces: WarmPlacesView;
  readonly #opts: K8sWarmPoolOptions<S>;
  readonly #tauMs: number;
  readonly #now: () => number;
  readonly #shapes = new Map<string, ShapeState<S>>();
  /** The refills measured (the header's depth): when each ended and how long it took. */
  readonly #refills: Array<{ at: number; ms: number }> = [];
  /** Deletes in flight (drain waits for them). */
  readonly #removals = new Set<Promise<void>>();
  /** Its places (the header's places), or null before attach. */
  #budget: WarmBudget | null = null;
  /** The places it holds of the pod budget. */
  #held = 0;
  /** Places converted into grade jobs' whose take has not come yet: each one's lapse (POOL_PROMISE_MS). */
  readonly #promises: NodeJS.Timeout[] = [];
  /**
   * The room's last answer (null: unknown, so the pool does not grow), the pool's own pods when it came (its free places
   * are the nodes' less those), and whether a read is in flight.
   */
  #room: number | null = null;
  #roomHeld = 0;
  #roomReading = false;
  /** The restart sweep is done: refills may start. */
  #started = false;
  #startSweep!: () => void;
  #draining: Promise<void> | null = null;
  /**
   * Set first thing in drain(), synchronously, before any place is given back: from then on it wants no place, has no
   * pod to convert, boots nothing and is handed nothing (its sandbox pool's walk, re-entered by those releases, reads it).
   */
  #closing = false;
  #tick: NodeJS.Timeout | null = null;
  /** The last failure said per shape (each streak said once). */
  readonly #said = new Map<string, string>();

  constructor(opts: K8sWarmPoolOptions<S>) {
    if (!Number.isSafeInteger(opts.max) || opts.max < 1 || opts.max > POOL_MAX_CEILING) throw new RangeError(`a warm pool's ceiling is a whole number of pods from 1 to ${POOL_MAX_CEILING}, not ${opts.max}`);
    const ttl = opts.ttlMs ?? POOL_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new RangeError(`a warm pool's TTL is a positive number of ms, not ${ttl}`);
    this.max = opts.max;
    this.ttlMs = ttl;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#tauMs = opts.rateTauMs ?? POOL_RATE_TAU_MS;
    if (!Number.isFinite(this.#tauMs) || this.#tauMs <= 0) throw new RangeError(`a warm pool's rate time constant is a positive number of ms, not ${this.#tauMs}`);
    POOLS.add(this);
    // The sweep waits for the first attach: a process that never has places reads nothing (the header's places).
    this.started = new Promise<void>((resolve) => {
      this.#startSweep = () => resolve();
    }).then(() =>
      opts
        .sweep()
        .catch((err: unknown) => opts.warn(`k8s sandbox: the warm pool's sweep of this process's earlier pool pods failed (${err instanceof Error ? err.message : String(err)}): the orphan reap and their own deadline are left for them`))
        .finally(() => {
          this.#started = true;
          this.#readRoom();
        }),
    );
    this.warmPlaces = {
      wanted: () => this.#wanted(),
      convertible: () => this.#convertible(),
      placed: () => this.#placed(),
      converted: () => this.#converted(),
    };
    const every = opts.tickMs ?? POOL_TICK_MS;
    if (every > 0) {
      this.#tick = setInterval(() => {
        this.#readRoom();
        this.#pump();
      }, every);
      this.#tick.unref();
    }
  }

  /**
   * Its places (the header's places: JobQueue.attachWarmPool's answer for its warmPlaces), the first one starting its
   * restart sweep; null holds nothing (every pod deleted, as its places are gone).
   */
  attach(budget: WarmBudget | null): void {
    this.#budget = budget;
    this.#held = 0;
    if (budget !== null) this.#startSweep();
    this.#pump();
  }

  /** Its pods now: booting (cancelled ones aside) and ready. */
  get pods(): { booting: number; ready: number } {
    let booting = 0;
    let ready = 0;
    for (const st of this.#shapes.values()) {
      booting += this.#live(st) - st.ready.length;
      ready += st.ready.length;
    }
    return { booting, ready };
  }

  /** The places it holds of its pod budget (the header's places). */
  get held(): number {
    return this.#held;
  }

  /** The room's last answer (opts.room: the nodes' free places per live grader), or null: unknown, or never read. */
  get room(): number | null {
    return this.#room;
  }

  /** The refill time the depth is sized from (the header's depth), ms: the p95 of the window's refills, or POOL_REFILL_PRIOR_MS. */
  refillMs(): number {
    const now = this.#now();
    while (this.#refills.length > 0 && now - this.#refills[0]!.at > POOL_REFILL_WINDOW_MS) this.#refills.shift();
    return p95Of(this.#refills.map((r) => r.ms)) ?? POOL_REFILL_PRIOR_MS;
  }

  /** A refill measured elsewhere: a spawn's cold boot, its create to its agent's answer (k8s.ts K8sProcess). */
  noteBoot(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.#refills.push({ at: this.#now(), ms });
    if (this.#refills.length > POOL_REFILL_SAMPLES) this.#refills.shift();
  }

  /** Each shape's want now (the header's depth), before the caps: what a test and a line read. */
  wants(): Map<string, number> {
    const now = this.#now();
    const refill = this.refillMs();
    return new Map([...this.#shapes].map(([key, st]) => [key, shapeWant(st.rate.at(now), refill, this.ttlMs)]));
  }

  /**
   * A spawn's take (the header's take): the oldest ready pod of `shape` whose agent answers its claim, now the spawn's
   * alone, or null (none: the spawn boots cold). Counted hit, miss, and expired for each pod that did not answer.
   * Never rejects.
   */
  async take(shape: S): Promise<WarmPod | null> {
    const now = this.#now();
    if (this.#closing) {
      this.#count('miss');
      return null;
    }
    const st = this.#shapeOf(shape, now);
    st.rate.add(now);
    const deadline = Date.now() + POOL_CLAIM_CHECK_MS;
    let taken: WarmPod | null = null;
    try {
      while (st.ready.length > 0 && Date.now() < deadline) {
        const r = st.ready.shift()!;
        clearTimeout(r.timer);
        if (await this.#claim(r.pod, deadline)) {
          taken = r.pod;
          break;
        }
        this.#count('expired');
        this.#dispose(r.pod);
      }
      this.#count(taken === null ? 'miss' : 'hit');
      // A converted place's take (the header's places): its pod stays the job's on that place; a take that missed it
      // leaves a pod with no place, deleted now.
      const promise = this.#promises.shift();
      if (promise !== undefined) clearTimeout(promise);
      return taken;
    } finally {
      this.#trimUnplaced();
      if (this.#room === null) this.#readRoom();
      this.#pump();
    }
  }

  /** Re-size now, its room read again (a spawn's: a job that took a free place may have left the pool over the budget). */
  nudge(): void {
    this.#readRoom();
    this.#pump();
  }

  /**
   * The drain (the header's): no refill from now on, every boot in flight cut, every pod of the pool deleted and every
   * place given back; resolves once each delete has been asked and every boot has ended. Once a process; a take from
   * then on misses.
   */
  drain(): Promise<void> {
    if (this.#draining !== null) return this.#draining;
    // Closed before anything else: the releases below re-enter the sandbox pool's walk, which must find it wanting none.
    this.#closing = true;
    if (this.#tick !== null) clearInterval(this.#tick);
    this.#tick = null;
    for (const t of this.#promises.splice(0)) clearTimeout(t);
    const boots: Array<Promise<void>> = [];
    for (const st of this.#shapes.values()) {
      for (const r of st.ready.splice(0)) {
        clearTimeout(r.timer);
        this.#dispose(r.pod);
      }
      for (const b of st.booting) {
        b.cancelled = true;
        b.abort.abort();
        boots.push(b.done);
      }
    }
    this.#releaseAll();
    this.#draining = (async () => {
      // Every boot cut has ended (what it made deleted in its end), and every delete asked has answered.
      await Promise.all(boots);
      while (this.#removals.size > 0) await Promise.all([...this.#removals]);
      POOLS.delete(this);
    })();
    return this.#draining;
  }

  /** Whether drain() has been called (it closes the pool at once: no place, conversion or boot from then on). */
  get draining(): boolean {
    return this.#closing;
  }

  #count(outcome: PoolTakeOutcome): void {
    this.counts[outcome]++;
    countTake(outcome);
  }

  #shapeOf(shape: S, now: number): ShapeState<S> {
    let st = this.#shapes.get(shape.key);
    if (st === undefined) {
      st = { shape, ready: [], booting: new Set(), rate: new Rate(this.#tauMs), lastAsked: now, failures: 0, backoffUntil: 0 };
      this.#shapes.set(shape.key, st);
    }
    st.shape = shape;
    st.lastAsked = now;
    return st;
  }

  /** A shape's pods that count: ready, and booting not cancelled. */
  #live(st: ShapeState<S>): number {
    let n = st.ready.length;
    for (const b of st.booting) if (!b.cancelled) n++;
    return n;
  }

  /** Every pod that counts. */
  #total(): number {
    let n = 0;
    for (const st of this.#shapes.values()) n += this.#live(st);
    return n;
  }

  /** Its pods on its own places: every pod but those a converted place's job is still to take (the header's places). */
  #placedPods(): number {
    return Math.max(0, this.#total() - this.#promises.length);
  }

  /**
   * The caps (the header's depth): `hard` (the ceiling, the work, the room: over it, pods go) and each shape's target,
   * its want shared under `hard`. Nothing without places, before the sweep, or once draining.
   */
  #caps(): { hard: number; targets: Map<string, number> } {
    if (this.#budget === null || !this.#started || this.#closing) return { hard: 0, targets: new Map() };
    const held = this.#total();
    const roomCap = this.#room === null ? held : Math.max(0, Math.floor(POOL_ROOM_SHARE * (this.#room + this.#roomHeld)));
    const hard = Math.max(0, Math.min(this.max, this.#budget.entitled(), roomCap));
    return { hard, targets: shareWants(this.wants(), hard) };
  }

  /** The places it would take now beyond those it holds (warmPlaces.wanted: the sandbox pool's walk asks). */
  #wanted(): number {
    if (this.#closing) return 0;
    const { targets } = this.#caps();
    const now = this.#now();
    let want = 0;
    for (const [key, st] of this.#shapes) if (now >= st.backoffUntil) want += Math.max(0, (targets.get(key) ?? 0) - this.#live(st));
    return Math.max(0, Math.min(want, this.#caps().hard - this.#placedPods(), this.#opts.paceRoom()) - this.#spare());
  }

  /** Its places with no pod on them (a pod taken, expired or failed, not yet refilled or given back). */
  #spare(): number {
    return Math.max(0, this.#held - this.#placedPods());
  }

  /** Its booted pods a grade job's start may take over as its place (warmPlaces.convertible). */
  #convertible(): number {
    if (this.#closing) return 0;
    let ready = 0;
    for (const st of this.#shapes.values()) ready += st.ready.length;
    return Math.max(0, ready - this.#promises.length);
  }

  /** The walk handed it a place (warmPlaces.placed): a boot into it now, the shape most short first. */
  #placed(): void {
    this.#held++;
    // Closing (the walk asked before it read the flag, or a caller's bug): the place goes straight back, no boot.
    if (this.#closing) {
      queueMicrotask(() => this.#releaseAll());
      return;
    }
    // Inside the sandbox pool's walk: a boot never calls back into it, and the re-size after it waits for the walk's end.
    this.#bootShortest();
    queueMicrotask(() => this.#pump());
  }

  /** One of its places became a grade job's (warmPlaces.converted): its take is awaited for POOL_PROMISE_MS. */
  #converted(): void {
    this.#held = Math.max(0, this.#held - 1);
    const timer = setTimeout(() => {
      const i = this.#promises.indexOf(timer);
      if (i < 0) return;
      this.#promises.splice(i, 1);
      this.#trimUnplaced();
      this.#pump();
    }, POOL_PROMISE_MS);
    timer.unref();
    this.#promises.push(timer);
  }

  /** A pod with no place (more pods than places and promises): the one most over its want deleted, until none is. */
  #trimUnplaced(): void {
    while (this.#total() > this.#held + this.#promises.length && this.#dropOne()) {
      // dropped one
    }
  }

  /** Delete one pod (ready first, of the shape most over its want), or cut one boot: false when there is none. */
  #dropOne(): boolean {
    const wants = this.wants();
    let worst: ShapeState<S> | null = null;
    let worstBy = Number.NEGATIVE_INFINITY;
    for (const [key, st] of this.#shapes) {
      const by = this.#live(st) - (wants.get(key) ?? 0);
      if (this.#live(st) > 0 && by > worstBy) {
        worst = st;
        worstBy = by;
      }
    }
    if (worst === null) return false;
    const r = worst.ready.shift();
    if (r !== undefined) {
      clearTimeout(r.timer);
      this.#dispose(r.pod);
      return true;
    }
    const b = [...worst.booting].find((x) => !x.cancelled)!;
    b.cancelled = true;
    b.abort.abort();
    return true;
  }

  /** Boot one pod of the shape most short of its target into a place held (the walk's): none short, the place goes back. */
  #bootShortest(): boolean {
    if (this.#closing) return false;
    const { targets } = this.#caps();
    const now = this.#now();
    let best: ShapeState<S> | null = null;
    let bestShort = 0;
    for (const [key, st] of this.#shapes) {
      const short = (targets.get(key) ?? 0) - this.#live(st);
      if (now >= st.backoffUntil && short > bestShort) {
        best = st;
        bestShort = short;
      }
    }
    if (best === null) return false;
    this.#boot(best, now);
    return true;
  }

  /** Whether `pod`'s `stage` agent answers its claim (the header's take) by `deadline`: its kept session's /v1/health, else a re-dial in what is left. */
  async #claim(pod: WarmPod, deadline: number): Promise<boolean> {
    const kept = pod.stage;
    if (kept.alive) {
      try {
        await kept.health({ timeoutMs: Math.max(1, deadline - Date.now()) });
        return true;
      } catch {
        // Gone quiet: a re-dial, its pin checked again, decides.
      }
    }
    void kept.close().catch(() => undefined);
    const left = deadline - Date.now();
    if (left <= 0) return false;
    try {
      const fresh = await this.#opts.redial(pod, left);
      pod.stage = fresh;
      return true;
    } catch {
      return false;
    }
  }

  /** A pod the pool lets go of untaken: its session closed, its objects deleted (tracked for the drain); its place spare. */
  #dispose(pod: WarmPod): void {
    void pod.stage.close().catch(() => undefined);
    this.#remove(pod.refs);
  }

  #remove(refs: readonly string[]): void {
    if (refs.length === 0) return;
    const p: Promise<void> = this.#opts
      .remove(refs)
      .catch((err: unknown) => this.#opts.warn(`k8s sandbox: the warm pool's delete of ${refs.join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.#removals.delete(p));
    this.#removals.add(p);
  }

  /** Give back every place it holds (drain, or no places). */
  #releaseAll(): void {
    const budget = this.#budget;
    for (; this.#held > 0; this.#held--) budget?.release();
  }

  /** The room read (opts.room), only for a pool that can hold pods: places attached and a shape asked for (the header). */
  #readRoom(): void {
    if (this.#roomReading || this.#closing || this.#budget === null || this.#shapes.size === 0) return;
    this.#roomReading = true;
    void this.#opts
      .room()
      .then(
        (room) => {
          this.#room = room;
          this.#roomHeld = this.#total();
        },
        () => {
          this.#room = null;
        },
      )
      .finally(() => {
        this.#roomReading = false;
        this.#pump();
      });
  }

  /**
   * The re-size (the header's depth and places): forget idle shapes; with no places, delete every pod; trim to the hard
   * caps (the ceiling, the work, the room); grow each shape toward its target into a spare place or one newly held, under
   * the pace's spare slots; give back every place no pod stands on.
   */
  #pump(): void {
    if (this.#closing) return;
    const now = this.#now();
    for (const [key, st] of this.#shapes) {
      if (st.ready.length === 0 && st.booting.size === 0 && now - st.lastAsked > POOL_SHAPE_FORGET_MS) this.#shapes.delete(key);
    }
    const budget = this.#budget;
    if (budget === null) {
      while (this.#dropOne()) {
        // no places: no pool
      }
      return;
    }
    if (!this.#started) return;
    const { hard, targets } = this.#caps();
    // Trim: placed pods over a hard cap, the ready ones first, the shape most over its want first.
    for (let over = this.#placedPods() - hard; over > 0 && this.#dropOne(); over--) {
      // dropped one
    }
    // Grow: each shape toward its target, into a spare place first, else one held now, while the pace has slots.
    let slots = this.#opts.paceRoom();
    const short = [...this.#shapes].map(([key, st]) => ({ st, short: (targets.get(key) ?? 0) - this.#live(st) })).filter((x) => x.short > 0);
    short.sort((a, b) => b.short - a.short);
    grow: for (const { st } of short) {
      if (now < st.backoffUntil) continue;
      while (this.#live(st) < (targets.get(st.shape.key) ?? 0) && this.#placedPods() < hard && slots > 0) {
        if (this.#spare() === 0) {
          if (!budget.hold()) break grow;
          this.#held++;
        }
        this.#boot(st, now);
        slots--;
      }
    }
    // A place no pod stands on goes back to the line.
    while (this.#spare() > 0) {
      this.#held--;
      budget.release();
    }
  }

  #boot(st: ShapeState<S>, now: number): void {
    if (this.#closing) return;
    const abort = new AbortController();
    const b: Booting = { abort, startedAt: now, cancelled: false, done: Promise.resolve() };
    st.booting.add(b);
    const shape = st.shape;
    b.done = this.#opts
      .boot(shape, abort.signal)
      .catch((err: unknown): PoolBoot => ({ ok: false, killed: false, error: err instanceof Error ? err.message : String(err), noRoom: null, refs: [] }))
      .then((end) => this.#booted(st, b, end));
  }

  #booted(st: ShapeState<S>, b: Booting, end: PoolBoot): void {
    st.booting.delete(b);
    const now = this.#now();
    if (!end.ok) {
      this.#remove(end.refs);
      if (!b.cancelled && !this.#closing && !end.killed) {
        st.failures++;
        const waitMs = Math.min(POOL_BACKOFF_MAX_MS, POOL_BACKOFF_MS * 2 ** (st.failures - 1));
        st.backoffUntil = now + waitMs;
        const said = end.noRoom !== null ? 'no room' : end.error;
        if (this.#said.get(st.shape.key) !== said) {
          this.#said.set(st.shape.key, said);
          this.#opts.warn(`k8s sandbox: a warm pod of ${st.shape.label}'s shape could not be booted (${end.error}): its refills wait ${waitMs} ms, doubling while they fail`);
        }
      }
      this.#pump();
      return;
    }
    if (b.cancelled || this.#closing) {
      this.#dispose(end.pod);
      this.#pump();
      return;
    }
    this.noteBoot(now - b.startedAt);
    st.failures = 0;
    this.#said.delete(st.shape.key);
    const r: ReadyPod = { pod: end.pod, readyAt: now, timer: setTimeout(() => this.#expire(st, r), this.ttlMs) };
    r.timer.unref();
    st.ready.push(r);
    // A grade job waiting only for the warm places takes this one as its place now (the header's places).
    if (!this.#closing) this.#budget?.poke();
    this.#pump();
  }

  /** A ready pod past its TTL (the header's TTL): deleted, `expired`. */
  #expire(st: ShapeState<S>, r: ReadyPod): void {
    const i = st.ready.indexOf(r);
    if (i < 0) return;
    st.ready.splice(i, 1);
    this.#count('expired');
    this.#dispose(r.pod);
    this.#trimUnplaced();
    this.#pump();
  }
}
