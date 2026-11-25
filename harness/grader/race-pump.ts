// A pump race's racer: one entry's pumpfun-replay/v2 bot run live over a race window still being recorded, minute
// by minute, so the race view can draw its equity as each minute closes. grader/race.ts runRacer is the bars racer
// (bars-replay/v1, the live BTC races); this is its twin for the pump replay, in a file of its own so the bars
// racer stays as it is. Nothing here decides anything: rank, rewards and the published result come only from the
// ordinary grade of the frozen window. The bot cannot tell a race from a grade: the protocol is
// agent-fun/replay/v2 byte for byte (grader/run.ts executeReplay, REPLAY_LOCKSTEP).
//
//   runPumpRacer({sandbox, runtime, botDir, limits, hello, failKey, roundTripMinBuyLamports, window, ticks, prior,
//                 onPoint, signal})
//
// One sandboxed process for the whole window (a spec's `race`, sandbox/types.ts), over a live pump engine
// (sim/engine.ts ReplayEngine.live) on the replay's line codec: hello is written at once; tick k's slots are fed
// to the engine; while the engine is ready its next batch is written, the reply read (parseBotLine, the reply
// order cap, MAX_ACTION_LOG_REPLY_BYTES in all), checked and submitted; once the tick's last batch is answered,
// onPoint is told the tick's point (below). At the window's end: finish (at the last slot fed), done, the bot's
// exit, then the post-flatten point (seq the window's ticks).
//
// The tick source (PumpTickSource) is an async iterable of PumpTick {seq, t, slots}: one per minute of the
// window, in order from seq 0, t = window.start_ms + (seq + 1) x 60 s (the minute's end), slots that minute's
// slots, each {slot, events}: its records, already parsed (contracts/events.ts ChainEvent), in (mint, chain_seq)
// order, the slots strictly increasing across the ticks. A tick may carry no slot. server/race/pump-feed.ts
// yields this shape and fans one feed out to every racer: the ticks and their records are shared, by reference,
// and never cloned or changed here (the engine keeps records by reference too). A tick off order or off the
// grid, slots that do not run strictly increasing, a record of another slot, a source that throws or that ends
// before the window does: a harness fault, thrown. runPumpRacer stops reading at the window's last tick (or when
// it ends) and returns the iterator.
//
// A point per tick (PumpRacePoint), made once the tick's last batch is answered (at once for a tick with none):
// equity_lamports the engine's equityNow (cash plus every position at what closing it now would pay), cash the
// last batch's account's (capital before any), fills how many of the resolutions the tick's batches delivered
// were filled (the bot's orders and the harness's closes; never a mint), reply_link the reply chain's link after
// the tick's last reply (an empty tick repeats the one before; RACE_LINK_GENESIS before any reply), and
// coins_at_most the distinct mints among the bot's own filled orders (a fill whose client_id is the order's, never
// a harness close's `_<kind>_<n>`: contracts/protocol.ts ClientOrderId) over every batch delivered up to and with
// the tick: an upper bound of the coins the official metric can count from the fills so far, since a counted coin
// (sim/metrics.ts computeMetrics: a filled order's mint, or a counted round trip's, whose buy is a filled order)
// needs a filled order of the bot's on it. The post-flatten point: seq the window's ticks, t the window's end,
// equity and cash done's, fills what the window's end resolved filled (the last batches' orders, the flatten
// closes), the last reply's link, and coins_at_most exactly what the official metric counts for the run: with the
// bundle's round-trips rule (roundTripMinBuyLamports) sim/metrics.ts countedRoundTrips' counted_mints, else the
// distinct mints of the run's filled orders (computeMetrics' distinct_mints). The mints are held in the racer's
// memory alone (each process's own set, rebuilt by a fast-forward as its engine is): no point names a mint, so
// nothing a racer stores from one can show the sampled universe.
//
// Hello and fail key: the caller's, the official grade's for the race (server/race/runner.ts): the hello sim/params.ts
// makeHello of the race seed (server/race/entries.ts raceSeed, which the racing phase's official grade is seeded
// with) and the official sample, and failKey (u64 decimal) the failed-tx draw's key, the one that grade derives for
// the phase (grader/worker.ts failKeyFor on fail-key scheme server-secret/v1; the seed's publicFailKey on a scheme the
// race cannot derive). It is the engine's alone: never written to the bot, a point or a result.
//
// Budget: think time, not wall, as runRacer's (io.ts Supervisor, budgetClock 'think'): limits.wall_budget_sec is
// held against the spans from a batch's write to its reply, never the waits for the next minute. A racer that
// answers slowly falls behind (the ticks closed meanwhile queue up) and catches up. It is stopped only as
// executeLockstep stops a bot: its think budget run out (status timeout), or the protocol broken (status failed,
// the bot exiting before done included). Flags as runRacer's (killed_after_done, nonzero_exit_after_done,
// think_budget_over_half).
//
// Reply links: link_r = sha256(link_{r-1} ‖ reply_r), link_{-1} RACE_LINK_GENESIS, each link the 32 bytes its hex
// names and each reply its RFC 8785 canonical JSON: race.ts raceReplyLink's formula (pumpReplyLink). A tick's
// link is the chain's after its last reply, so the tick links are the reply chain sampled at the minutes.
//
// Fast-forward, by tick: a lost process (its exit the driver's failure, Sandbox.isDriverFailure; or a respawn the
// driver refused with a SandboxError) is respawned, `restarts` counting each, and hello and every tick fed so far
// are replayed through a fresh engine at the bot's own pace (its think time counted afresh). Each tick's link is
// checked against the one known for that tick: prior[k] (an earlier run's, the race_point rows a restarted runner
// read back), else an earlier process's of this run. A mismatch marks the racer diverged from that tick
// (diverged_at, the first, kept) and the race carries on with the new process, whose links are the racer's from
// there. onPoint is called for every point that is new or differs from the one known for its tick, never again
// for one a fast-forward reproduced. A process lost RACE_MAX_LOST_IN_A_ROW times in a row with no tick done and
// no reply past the furthest any process of the run got is a harness fault (SandboxError); each respawn waits
// RACE_RESPAWN_BACKOFF_MS first, doubling to RACE_MAX_RESPAWN_BACKOFF_MS, and again from the start after progress.
//
// signal: aborting it kills the process and rejects with its reason (the runner stopping; a restart
// fast-forwards from the points it stored, as `prior`).

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { RaceWindowT } from "../contracts/competition.ts";
import type { ChainEventT } from "../contracts/events.ts";
import {
  Hello,
  MAX_BOT_LINE_BYTES,
  type HelloT,
  type ReplyT,
} from "../contracts/protocol.ts";
import { canonicalJson } from "../sim/canonical.ts";
import {
  ReplayEngine,
  SimAbortError,
  SimDataError,
  SimProtocolError,
  type ActionLogT,
  type ReplayRun,
} from "../sim/engine.ts";
import { countedRoundTrips } from "../sim/metrics.ts";
import { parseU64 } from "../sim/rng.ts";
import {
  RACE_LINK_GENESIS,
  RACE_MAX_LOST_IN_A_ROW,
  RACE_MAX_RESPAWN_BACKOFF_MS,
  RACE_RESPAWN_BACKOFF_MS,
  raceLifetimeMs,
  THINK_BUDGET_OVER_HALF,
  type RaceRestart,
  type RaceStatus,
} from "./race.ts";
import {
  EXIT_GRACE_MS,
  KILLED_AFTER_DONE,
  MAX_ACTION_LOG_REPLY_BYTES,
  MAX_STDERR_BYTES,
  NONZERO_EXIT_AFTER_DONE,
  REPLAY_LOCKSTEP,
  stderrTail,
  type LimitsT,
} from "./run.ts";
import { describeExit, Stopped, Supervisor } from "./sandbox/io.ts";
import {
  SandboxError,
  type Runtime,
  type Sandbox,
  type SandboxExit,
  type SandboxProcess,
} from "./sandbox/types.ts";

/** A pump race's tick: one minute of the window. */
export const PUMP_TICK_MS = 60_000;

const HEX64_RE = /^[0-9a-f]{64}$/;

/** One slot of a tick: every record of it the feed kept, in (mint, chain_seq) order (ReplayEngine.feed's input). */
export interface PumpSlot {
  slot: number;
  events: readonly ChainEventT[];
}

/** One minute of the race window, as the tick source yields it (the header). */
export interface PumpTick {
  seq: number;
  /** The minute's end: window.start_ms + (seq + 1) x PUMP_TICK_MS. */
  t: number;
  /** The minute's slots, strictly increasing (and past every earlier tick's); none for a quiet minute. */
  slots: readonly PumpSlot[];
}

/** What a pump racer reads its ticks from: every minute of the window from seq 0, in order (server/race/pump-feed.ts). */
export type PumpTickSource = AsyncIterable<PumpTick>;

/** One point of a pump racer's race (the header): never a mint. */
export interface PumpRacePoint {
  /** The tick answered, 0 .. ticks - 1; the window's ticks for the post-flatten point. */
  seq: number;
  /** The tick's end; the post-flatten point's is the window's end (the last tick's). */
  t: number;
  /** The engine's equityNow after the tick's last reply (lamports); the post-flatten point's is done's cash. */
  equity_lamports: string;
  /** Cash after the tick (the last batch's account; capital before any batch); the post-flatten point's is done's. */
  cash_lamports: string;
  /** How many of the resolutions the tick's batches delivered were filled (orders and closes); the post-flatten point's: the window end's. */
  fills: number;
  /** The reply chain's link after the tick's last reply (pumpReplyLink); an empty tick repeats the one before. */
  reply_link: string;
  /** Replies (batches answered) up to and with this tick. */
  replies: number;
  /** The process's think time so far, ms. */
  think_ms: number;
  /** Respawns so far. */
  restarts: number;
  /** The first tick whose link differed from the one known for it, or null. */
  diverged_at: number | null;
  /**
   * The distinct mints of the bot's own filled orders up to and with this tick: an upper bound of the coins the
   * official metric counts (the header); the post-flatten point's is that count exactly.
   */
  coins_at_most: number;
}

/** A respawn (PumpRaceOptions.onRestart): race.ts RaceRestart (`answered` the replies the lost process gave), and its ticks. */
export interface PumpRaceRestart extends RaceRestart {
  /** Ticks the lost process got through. */
  ticks: number;
}

export interface PumpRaceOptions {
  sandbox: Sandbox;
  runtime: Runtime;
  /** Host directory mounted read-only at /bot: the entry's materialized snapshot. */
  botDir: string;
  /** The competition's limits: wall_budget_sec is the racer's think budget (the header). */
  limits: LimitsT;
  /** makeHello of the race seed and the official sample (the header). */
  hello: HelloT;
  /** The failed-tx draw's key, u64 decimal (the header): the official grade's for the phase. Never sent to the bot. */
  failKey: string;
  /**
   * The bundle's round-trips rule's minimum buy, u64 decimal lamports (harness.guardrails.round_trips.min_buy_lamports),
   * or null where the bundle sets no such rule: what the post-flatten point's coins_at_most counts by (the header).
   */
  roundTripMinBuyLamports: string | null;
  /** The race window (contracts/competition.ts raceWindowOf): a whole number of minutes, at least one. */
  window: RaceWindowT;
  ticks: PumpTickSource;
  /** prior[k]: tick k's link from an earlier run of this racer (its stored points, by seq), which the fast-forward is held to. */
  prior?: readonly string[];
  /** Each new or changed point, awaited before the racer goes on (a throw is a harness fault). */
  onPoint?: (point: PumpRacePoint) => void | Promise<void>;
  /** Each respawn, before its backoff (a throw is a harness fault). */
  onRestart?: (restart: PumpRaceRestart) => void | Promise<void>;
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

/** How a pump racer ended. */
export interface PumpRaceResult {
  status: RaceStatus;
  /** Why it failed or timed out; null when finished. */
  error: string | null;
  /** Ticks the last process got through. */
  seq_done: number;
  /** Replies the last process gave. */
  replies: number;
  /** The last process's tick links, by tick. */
  links: string[];
  /** The last process's think time, ms. */
  think_ms: number;
  /** runPumpRacer's wall time, ms. */
  wall_ms: number;
  restarts: number;
  /** The first tick whose link differed from the one known for it (prior, or an earlier process's), or null. */
  diverged_at: number | null;
  /** How many of the first ticks had a known link theirs was checked against. */
  checked: number;
  /** The post-flatten point (finished only). */
  final: PumpRacePoint | null;
  /** The run and its action log (finished only; dataset_sha256 the live placeholder, LIVE_DATASET_SHA256). */
  run: ReplayRun | null;
  log: ActionLogT | null;
  flags: string[];
  /** The last process's stderr (at most MAX_STDERR_BYTES). */
  stderr: Buffer;
  exit: SandboxExit | null;
}

/** link_r from link_{r-1} and reply r: race.ts raceReplyLink's formula over a pump reply (the header). */
export function pumpReplyLink(prev: string, reply: ReplyT): string {
  if (typeof prev !== "string" || !HEX64_RE.test(prev))
    throw new TypeError(
      `a reply link is 64 lowercase hex, not ${JSON.stringify(prev)}`,
    );
  return createHash("sha256")
    .update(Buffer.from(prev, "hex"))
    .update(canonicalJson(reply), "utf8")
    .digest("hex");
}

/** How many ticks a race window holds; a window that is not a positive whole number of minutes is refused (RangeError). */
export function pumpRaceTicks(window: RaceWindowT): number {
  const { start_ms, end_ms } = window;
  if (
    !Number.isSafeInteger(start_ms) ||
    !Number.isSafeInteger(end_ms) ||
    end_ms <= start_ms ||
    (end_ms - start_ms) % PUMP_TICK_MS !== 0
  ) {
    throw new RangeError(
      `a pump race window is a positive whole number of minutes, not [${String(start_ms)}, ${String(end_ms)}]`,
    );
  }
  return (end_ms - start_ms) / PUMP_TICK_MS;
}

/** Run one pump racer over the race (the header). Bot failures and timeouts are returned; harness faults (and an abort) are thrown. */
export async function runPumpRacer(
  opts: PumpRaceOptions,
): Promise<PumpRaceResult> {
  return new PumpRacer(opts).run();
}

/** One process of the racer and what it did. */
interface Attempt {
  proc: SandboxProcess;
  sup: Supervisor;
  /** Replies it gave. */
  replies: number;
  /** Ticks it got through, and each one's link. */
  ticks: number;
  links: string[];
}

type Outcome =
  | { kind: "finished"; run: ReplayRun; final: PumpRacePoint; flags: string[] }
  | { kind: "timeout" | "failed"; error: string }
  | { kind: "lost"; reason: string };

/** A point before its bookkeeping (PumpRacePoint without the racer's counters). */
type PointOf = Omit<PumpRacePoint, "think_ms" | "restarts" | "diverged_at">;

const filledCount = (fills: readonly { status: string }[]): number =>
  fills.reduce((n, f) => (f.status === "filled" ? n + 1 : n), 0);

/** Add to `mints` the mint of each of the bot's own filled orders among a batch's fills: a harness close's client_id starts with `_` (protocol.ts ClientOrderId), an order's never. */
const addOwnFilledMints = (
  mints: Set<string>,
  fills: readonly { client_id: string; mint: string; status: string }[],
): void => {
  for (const f of fills)
    if (f.status === "filled" && !f.client_id.startsWith("_"))
      mints.add(f.mint);
};

/** The coins the official metric counts for a finished run (the header): countedRoundTrips' counted_mints under the rule, else the distinct mints of its filled orders. */
const countedCoins = (run: ReplayRun, minBuy: bigint | null): number => {
  if (minBuy !== null)
    return countedRoundTrips(run.round_trips, minBuy).counted_mints;
  const mints = new Set<string>();
  for (const f of run.resolutions)
    if (f.kind === "order" && f.status === "filled") mints.add(f.mint);
  return mints.size;
};

class PumpRacer {
  readonly #o: PumpRaceOptions;
  readonly #hello: HelloT;
  readonly #failKey: string;
  /** The round-trips rule's minimum buy, or null without the rule. */
  readonly #minBuy: bigint | null;
  readonly #ticksTotal: number;
  readonly #budgetMs: number;
  readonly #now: () => number;
  readonly #startedAt = performance.now();
  /** Every tick the source gave, by reference (shared with every racer): what each process's engine is fed. */
  readonly #ticks: PumpTick[] = [];
  /** The last slot of the ticks taken (-1 before any). */
  #lastSlot = -1;
  #feedEnded = false;
  #feedError: unknown = null;
  #closed = false;
  #iterator: AsyncIterator<PumpTick> | null = null;
  #returned = false;
  readonly #wakers = new Set<() => void>();
  /** The link known for each tick: prior's, then each tick's as it came (a divergence replaces the tail). */
  readonly #known: string[];
  #divergedAt: number | null = null;
  #checked = 0;
  #restarts = 0;

  constructor(o: PumpRaceOptions) {
    this.#o = o;
    this.#hello = Hello.parse(o.hello);
    try {
      parseU64(o.failKey, "failKey");
    } catch {
      // parseU64's message quotes the value: the key is never said.
      throw new TypeError("failKey is not a u64 decimal");
    }
    this.#failKey = o.failKey;
    if (
      o.roundTripMinBuyLamports !== null &&
      typeof o.roundTripMinBuyLamports !== "string"
    )
      throw new TypeError("roundTripMinBuyLamports is a u64 decimal or null");
    this.#minBuy =
      o.roundTripMinBuyLamports === null
        ? null
        : parseU64(o.roundTripMinBuyLamports, "roundTripMinBuyLamports");
    this.#ticksTotal = pumpRaceTicks(o.window);
    this.#budgetMs = o.limits.wall_budget_sec * 1000;
    this.#now = o.now ?? Date.now;
    const prior = o.prior ?? [];
    prior.forEach((l, k) => {
      if (typeof l !== "string" || !HEX64_RE.test(l))
        throw new TypeError(
          `prior[${k}] is not a reply link (64 lowercase hex): ${JSON.stringify(l)}`,
        );
    });
    this.#known = [...prior];
  }

  async run(): Promise<PumpRaceResult> {
    this.#o.signal?.throwIfAborted();
    void this.#pump();
    try {
      const firstBackoff = this.#o.respawnBackoffMs ?? RACE_RESPAWN_BACKOFF_MS;
      let backoff = firstBackoff;
      let furthestTicks = 0;
      let furthestReplies = 0;
      let lostInARow = 0;
      for (let first = true; ; first = false) {
        let att: Attempt | null = null;
        let refused = "";
        try {
          att = this.#spawn();
        } catch (err) {
          // A spec the driver refuses at the start is the caller's; at a respawn it is one more lost process.
          if (first || !(err instanceof SandboxError)) throw err;
          refused = err.message;
        }
        const outcome: Outcome =
          att === null
            ? {
                kind: "lost",
                reason: `the sandbox could not respawn it: ${refused}`,
              }
            : await this.#drive(att);
        if (outcome.kind !== "lost") return this.#result(outcome, att!);
        const reason = outcome.reason;
        const ticks = att?.ticks ?? 0;
        const replies = att?.replies ?? 0;
        if (ticks > furthestTicks || replies > furthestReplies) {
          furthestTicks = Math.max(furthestTicks, ticks);
          furthestReplies = Math.max(furthestReplies, replies);
          lostInARow = 0;
          backoff = firstBackoff;
        }
        lostInARow++;
        if (lostInARow >= RACE_MAX_LOST_IN_A_ROW) {
          throw new SandboxError(
            `the racer's process was lost ${lostInARow} times in a row with no tick past ${furthestTicks} and no reply past batch ${furthestReplies} (${this.#restarts} respawns in all): ${reason}`,
          );
        }
        this.#restarts++;
        await this.#o.onRestart?.({
          restarts: this.#restarts,
          reason,
          answered: replies,
          ticks,
        });
        await this.#pause(backoff);
        backoff = Math.min(backoff * 2, RACE_MAX_RESPAWN_BACKOFF_MS);
      }
    } finally {
      this.#closed = true;
      this.#wake();
      this.#returnSource();
    }
  }

  // ---------------------------------------------------------------- the ticks

  /** Read the source until the window's last tick, the source's end, or the racer's. */
  async #pump(): Promise<void> {
    try {
      const it = this.#o.ticks[Symbol.asyncIterator]();
      this.#iterator = it;
      while (!this.#closed && this.#ticks.length < this.#ticksTotal) {
        let r: IteratorResult<PumpTick>;
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

  /** One tick from the source: the next seq, on the grid, its slots strictly increasing past every earlier one's, each record of its slot; then kept, as given. */
  #take(x: PumpTick): void {
    const k = this.#ticks.length;
    if (typeof x !== "object" || x === null || x.seq !== k)
      throw new SimDataError(
        `the tick source yielded seq ${JSON.stringify((x as { seq?: unknown } | null)?.seq)} where ${k} was due`,
      );
    const due = this.#o.window.start_ms + (k + 1) * PUMP_TICK_MS;
    if (x.t !== due)
      throw new SimDataError(
        `the tick source's tick ${k} ends at t ${JSON.stringify(x.t)}, not ${due}`,
      );
    if (!Array.isArray(x.slots))
      throw new SimDataError(
        `the tick source's tick ${k} carries no slot list`,
      );
    let last = this.#lastSlot;
    for (const s of x.slots as readonly PumpSlot[]) {
      const slot = (s as { slot?: unknown } | null)?.slot;
      if (
        typeof slot !== "number" ||
        !Number.isSafeInteger(slot) ||
        slot <= last
      ) {
        throw new SimDataError(
          `the tick source's tick ${k} carries slot ${JSON.stringify(slot)} after ${last}: slots run strictly increasing across the ticks`,
        );
      }
      if (!Array.isArray(s.events))
        throw new SimDataError(
          `the tick source's slot ${slot} (tick ${k}) carries no record list`,
        );
      for (const e of s.events) {
        if ((e as { slot?: unknown } | null)?.slot !== slot)
          throw new SimDataError(
            `the tick source's slot ${slot} (tick ${k}) carries a record of slot ${JSON.stringify((e as { slot?: unknown } | null)?.slot)}`,
          );
      }
      last = slot;
    }
    this.#lastSlot = last;
    this.#ticks.push(x);
  }

  #returnSource(): void {
    const it = this.#iterator;
    if (it === null || this.#returned || typeof it.return !== "function")
      return;
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
      label: o.label ?? "race",
      imageDigest: o.imageDigest ?? null,
      race: {
        lifetimeMs: raceLifetimeMs(o.window, this.#budgetMs, this.#now()),
      },
    });
    const sup = new Supervisor(proc, {
      budgetMs: this.#budgetMs,
      budgetClock: "think",
      maxStderrBytes: MAX_STDERR_BYTES,
      stdout: { mode: "lines", maxLineBytes: MAX_BOT_LINE_BYTES },
    });
    // An idle racer learns of its process's end at once (the Supervisor's own handler has run by then).
    void proc.exited.then(() => this.#wake());
    return { proc, sup, replies: 0, ticks: 0, links: [] };
  }

  /** One process, from hello to its end: finished, the bot's failure or timeout, or lost (the header). */
  async #drive(att: Attempt): Promise<Outcome> {
    const { sup } = att;
    const engine = ReplayEngine.live(this.#hello, { failKey: this.#failKey });
    const cap = REPLAY_LOCKSTEP.replyOrderCap(engine.hello);
    const flags: string[] = [];
    let replyBytes = 0;
    let delivered = 0;
    let cash = engine.hello.capital.lamports;
    let link = RACE_LINK_GENESIS;
    /** The mints of the bot's own filled orders delivered so far, this process's (the header): only their count leaves. */
    const coins = new Set<string>();
    let phase: "waiting" | "awaiting" | "done" = "waiting";
    let awaitingSeq = 0;
    try {
      await this.#abortable(sup.write(REPLAY_LOCKSTEP.encode(engine.hello)));
      for (let k = 0; k < this.#ticksTotal; k++) {
        for (;;) {
          if (this.#feedError !== null) throw this.#feedError;
          if (k < this.#ticks.length) break;
          if (this.#feedEnded)
            throw new SimDataError(
              `the tick source ended after ${this.#ticks.length} of the window's ${this.#ticksTotal} ticks`,
            );
          await this.#idle(sup);
        }
        const tick = this.#ticks[k]!;
        for (const s of tick.slots) engine.feed(s.slot, s.events);
        let fills = 0;
        while (engine.ready()) {
          const b = engine.nextBatch();
          // Ready, yet no batch: the engine aborted stepping to it (finish names why).
          if (b === null)
            throw new SimAbortError(
              `replay aborted: ${engine.finish().run.aborted ?? "no batch where one was ready"}`,
            );
          delivered += b.fills.length;
          fills += filledCount(b.fills);
          addOwnFilledMints(coins, b.fills);
          cash = b.account.cash_lamports;
          awaitingSeq = b.seq;
          phase = "awaiting";
          sup.expectLine();
          await this.#abortable(sup.write(REPLAY_LOCKSTEP.encode(b)));
          const text = await this.#abortable(sup.nextLine());
          replyBytes += Buffer.byteLength(text, "utf8");
          if (replyBytes > MAX_ACTION_LOG_REPLY_BYTES)
            throw sup.violate(
              `replies passed ${MAX_ACTION_LOG_REPLY_BYTES} bytes in total`,
            );
          const parsed = REPLAY_LOCKSTEP.parseLine(text);
          if (!parsed.ok)
            throw sup.violate(`reply to batch ${b.seq}: ${parsed.reason}`);
          if (parsed.reply.orders.length > cap)
            throw sup.violate(
              `reply to batch ${b.seq} carries ${parsed.reply.orders.length} orders (max ${cap})`,
            );
          try {
            engine.submit(parsed.reply);
          } catch (err) {
            if (err instanceof SimProtocolError)
              throw sup.violate(`reply to batch ${b.seq}: ${err.message}`);
            throw err;
          }
          phase = "waiting";
          link = pumpReplyLink(link, parsed.reply);
          att.replies++;
        }
        att.links.push(link);
        att.ticks++;
        await this.#point(
          {
            seq: k,
            t: tick.t,
            equity_lamports: engine.equityNow().toString(),
            cash_lamports: cash,
            fills,
            reply_link: link,
            replies: att.replies,
            coins_at_most: coins.size,
          },
          sup,
          true,
        );
      }
      const { done, run } = engine.finish();
      if (run.aborted !== null)
        throw new SimAbortError(`replay aborted: ${run.aborted}`);
      phase = "done";
      await this.#abortable(sup.write(REPLAY_LOCKSTEP.encode(done)));
      sup.closeStdin();
      const exit = await this.#abortable(
        sup.waitExit(this.#o.exitGraceMs ?? EXIT_GRACE_MS),
      );
      if (exit === "grace") {
        flags.push(KILLED_AFTER_DONE);
        await sup.kill();
      } else if (exit.code !== 0 && !this.#o.sandbox.isDriverFailure(exit))
        flags.push(NONZERO_EXIT_AFTER_DONE);
      const final = await this.#point(
        {
          seq: this.#ticksTotal,
          t: this.#o.window.end_ms,
          equity_lamports:
            run.equity.at(-1)?.equity_lamports ?? done.account.cash_lamports,
          cash_lamports: done.account.cash_lamports,
          fills: filledCount(run.resolutions.slice(delivered)),
          reply_link: link,
          replies: att.replies,
          coins_at_most: countedCoins(run, this.#minBuy),
        },
        sup,
        false,
      );
      return { kind: "finished", run, final, flags };
    } catch (err) {
      await sup.kill();
      if (!(err instanceof Stopped)) throw err;
      const r = err.reason;
      if (r.kind === "timeout")
        return { kind: "timeout", error: "the think budget ran out" };
      if (r.kind === "violation")
        return { kind: "failed", error: `protocol violation: ${r.message}` };
      if (this.#o.sandbox.isDriverFailure(r.exit))
        return {
          kind: "lost",
          reason: `the sandbox failed (${describeExit(r.exit)}): ${stderrTail(sup.stderr())}`,
        };
      const when =
        phase === "awaiting"
          ? `before replying to batch ${awaitingSeq}`
          : phase === "done"
            ? "before done"
            : `while waiting for batch ${att.replies}`;
      return {
        kind: "failed",
        error: `the bot exited ${when} (${describeExit(r.exit)})`,
      };
    }
  }

  /** Wait, uncharged, for the next tick, the source's end or the process's (then its stop reason is thrown). */
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
    if (ended())
      throw new Stopped(sup.stopped ?? { kind: "exited", exit: sup.exit! });
  }

  /**
   * A point made (the header): a tick's is checked against the link known for its tick, a mismatch marking the
   * divergence and taking the new chain from there; reported when it is new or differs. The post-flatten point is
   * reported unless the same link is known for its seq. Its full form either way.
   */
  async #point(
    p: PointOf,
    sup: Supervisor,
    tick: boolean,
  ): Promise<PumpRacePoint> {
    const k = p.seq;
    const known = k < this.#known.length ? this.#known[k] : undefined;
    const report = known !== p.reply_link;
    if (tick) {
      if (known !== undefined) {
        this.#checked = Math.max(this.#checked, k + 1);
        if (report) {
          this.#divergedAt ??= k;
          this.#known.length = k;
        }
      }
      // A process makes tick k's point only once it has made every earlier tick's, so a new link lands at k.
      if (report) this.#known.push(p.reply_link);
    }
    const point: PumpRacePoint = {
      ...p,
      think_ms: Math.round(sup.elapsedMs()),
      restarts: this.#restarts,
      diverged_at: this.#divergedAt,
    };
    if (report) await this.#o.onPoint?.(point);
    return point;
  }

  #result(
    outcome: Exclude<Outcome, { kind: "lost" }>,
    att: Attempt,
  ): PumpRaceResult {
    const think = Math.round(att.sup.elapsedMs());
    const finished = outcome.kind === "finished" ? outcome : null;
    const flags = finished === null ? [] : [...finished.flags];
    if (finished !== null && think * 2 > this.#budgetMs)
      flags.push(THINK_BUDGET_OVER_HALF);
    return {
      status: outcome.kind,
      error: outcome.kind === "finished" ? null : outcome.error,
      seq_done: att.ticks,
      replies: att.replies,
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
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", onAbort);
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
