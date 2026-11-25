// The pump.fun replay (agent-fun/replay/v2, contracts/protocol.ts): a deterministic, non-reactive
// replay of a frozen chain-log dataset against one bot, in lockstep.
//
//   const engine = new ReplayEngine(dataset, hello);
//   send(engine.hello);
//   for (let batch; (batch = engine.nextBatch()); ) { send(batch); engine.submit(await readReply()); }
//   const { done, run } = engine.finish(); send(done);
//
// Market model (the numbers come from hello):
//   - Universe: sim/universe.ts. Only universe events are delivered, one batch per slot that carries
//     any, in dataset order (slot, mint, chain_seq).
//   - An order decided on the batch for slot s resolves at slot F = s + latency_slots, after that
//     mint's last recorded trade in F, against that trade's POST-trade reserves; with no trade for
//     the mint in F, against the latest earlier post-trade reserves (or the CreateEvent's initial
//     reserves), each shifted by the bot's own impact (below). Every order resolves at F,
//     rejections included, and is reported in the first batch after it resolves. Orders whose F
//     lies past the window's end_slot are rejected `after_end`.
//   - Persistent self-impact: on a bonding curve the price is a pure function of the reserves, so
//     the bot's own trades move it for good. Per mint the engine keeps the bot's net flow into the
//     curve (BotOffset: curve quote its buys put in minus what its sells and closes took out;
//     tokens its buys took out minus what its sells and closes put back) and every fill, close,
//     mark, decision-time snapshot and equity valuation on that mint meets the recorded reserves
//     shifted by it (offsetReserves). Within a slot that is exactly the curve advanced by the bot's
//     earlier fills (curve.ts applyTrade); across slots the shift rides on whatever the recorded
//     reserves have become. So N small buys, in one reply or over N slots, never get more tokens
//     than one buy of their sum while nothing else trades. When the recorded reserves move so far
//     that the whole shift would take a real reserve below zero (the recorded trades bought the
//     curve out past the bot's position, or sold its quote down past what the bot took out), the
//     shift is scaled down to the largest share that fits: the bot's net position never counts for
//     more than the curve's real token reserve, and a completed curve (real tokens 0) is met as
//     recorded. The recorded events themselves never move: other traders' trades replay as they
//     happened, and no fill ever changes a later recorded event.
//   - Buys are exact-in (quote_lamports = SOL spent, curve fees included), filled as the program
//     fills buy_exact_sol_in; sells sell exactly token_amount. Math: sim/curve.ts.
//   - Fee bps come from the TradeEvent the fill lands on (the mint's last trade in F); when there
//     is none, or it reports fee_basis_points 0, hello.fees' fallbacks are used and the fill is
//     flagged fee_fallback. buyback is a share of the protocol fee and holder rewards a relabel of
//     the creator fee, so neither costs the bot anything. Every order that is sent pays base +
//     priority tx fees; a seeded share fails (status failed: tx fees paid, nothing traded). The
//     draw is keyed by EngineOptions.failKey, never by hello.seed (sim/rng.ts txFails).
//   - Rejections (nothing paid), checked in this order: max_orders_per_batch, duplicate_client_id,
//     zero_amount (an amount of 0), not_in_universe (no CreateEvent delivered for the mint by the
//     decision), token_complete, insufficient_tokens (sell beyond the position: no shorts),
//     max_open_positions (a buy opening a new position at the cap), max_order_size (a buy whose
//     quote_lamports, added to those of the same reply's earlier buys on the mint that passed this
//     check, exceeds max_order_bps_of_real_reserve of the decision-time real quote reserves: the cap
//     is per mint per reply, and a buy refused here does not count toward it; or a sell paying out
//     more than the real quote reserves it fills against), zero_amount (the fill would give 0 tokens,
//     e.g. a buy on a curve whose real tokens the bot's own position already takes up, or a sell's
//     fees would eat its whole output), max_slippage (the fill's output is worse than the
//     decision-time reserves would give, beyond max_slippage_bps, at the same fee bps),
//     insufficient_cash (a buy costs quote_lamports + tx fees; any order needs its tx fees in cash;
//     no leverage). Then the seeded failure draw, then the fill. Decision-time reserves are the
//     mint's reserves as the bot met them when it decided: recorded, shifted by its impact so far.
//   - A CompleteEvent ends the mint's tradable life: the position is closed at its last trade's
//     post-trade reserves (a sell, curve fees at that trade's bps, tx fees; output capped at the real
//     quote reserves; after a completing trade the curve's real tokens are 0, so the bot's shift
//     scales to nothing there).
//     When replay data ends, every open position is closed the same way, at the reserves a fill in
//     end_slot would get (the bot's own impact included). A close whose
//     proceeds after curve fees would not cover its tx fees is abandoned instead (tokens written off,
//     nothing paid). Closes appear in fills with client_id `_complete_<n>`, `_flatten_<n>` or
//     `_writeoff_<n>`, side sell, decided_slot = slot = the closing slot; protocol.ts reserves client
//     ids starting with `_` for them, so a bot's id never collides with one.
//   - Every resolution checks conservation in lamports: bot cash delta + curve delta + protocol fee
//     + buyback fee + creator fee + network (tx) fee = 0, and tokens: bot delta + curve delta = 0
//     (a write-off moves tokens to an abandoned bucket). A violation aborts the replay.
//
// Everything is BigInt and deterministic: the same (dataset, hello, replies) give byte-identical
// batches, fills and results, which is what lets an action log be rescored (replayActionLog).
//
// Live mode: the same replay over a chain-log stream that arrives while it runs (a race over a
// window still being recorded). The engine starts from the hello alone and is fed slot by slot:
//
//   const engine = ReplayEngine.live(hello, opts);
//   engine.feed(slot, records);        // every record of that slot, in (mint, chain_seq) order
//   while (engine.ready()) { send(engine.nextBatch()); engine.submit(await readReply()); }
//   const { done, run } = engine.finish(endSlot);
//
// Slots are fed strictly increasing, each once and whole; nextBatch() returns null while no fed
// batch is waiting, and keeps its contract otherwise. Membership is decided as records arrive: a
// mint's first CreateEvent decides it (universeExclusion, LiveEngineOptions.excludedMints), and a
// record of a mint outside the universe, a repeat CreateEvent, anything after a mint's
// CompleteEvent, or a record whose *_sol_* fields disagree with their *_quote_* twins
// (sim/curve.ts CurveDataError) is dropped, never thrown: the stream is unrepaired, so there is no
// chain check and run.chain_warnings is empty. Block times are kept as they arrive (every record
// fed counts, as every record of a frozen dataset does). Records are kept by reference and never
// cloned or mutated, so one feed can be shared by every engine racing on it. Fed a frozen,
// chain-clean dataset's records slot by slot, in any number of feeds interleaved with the replies
// in any way, and finished at its end_slot, a live engine gives the frozen engine's batches,
// fills and run byte for byte, save the digest: no frozen dataset backs a live run, so its run and
// action log name the declared placeholder LIVE_DATASET_SHA256, and a live run is compared with a
// graded one by its replies alone. A frozen engine takes no feed.

import { z } from 'zod';
import type { ChainEventT, CreateEventRecordT, TradeEventRecordT } from '../contracts/events.ts';
import { Sha256Hex } from '../contracts/primitives.ts';
import {
  HARNESS_CLOSE_KINDS,
  Hello,
  MAX_HARNESS_LINE_BYTES,
  parseBotLine,
  PROTOCOL,
  Reply,
  type AccountT,
  type BatchT,
  type DoneT,
  type FillT,
  type HelloT,
  type MarkT,
  type OrderT,
  type RejectReasonT,
  type ReplyT,
} from '../contracts/protocol.ts';
import { checkChain, type ChainIssue, type ChainReport } from './chain.ts';
import { BPS, createState, CurveDataError, feeOf, buybackOf, quoteBuyExactIn, quoteSell, tradePostState, type CurveState, type FeeBps } from './curve.ts';
import { parseU64, publicFailKey, txFails } from './rng.ts';
import { universeExclusion, type UniverseExclusion, type UniverseSampleT } from './universe.ts';

export const ACTION_LOG_FORMAT = 'agent-fun/action-log/v1';

/** What the bot did: every reply, in batch order, with what it answered (hello and dataset digest). */
export const ActionLog = z.strictObject({
  format: z.literal(ACTION_LOG_FORMAT),
  protocol: z.literal(PROTOCOL),
  dataset_sha256: Sha256Hex,
  hello: Hello,
  replies: z.array(Reply),
});
export type ActionLogT = z.infer<typeof ActionLog>;

/** A frozen dataset as the replay reads it. */
export interface ReplayDataset {
  /** sha256 (hex) of the dataset's canonical manifest: the digest the contamination cert names. */
  sha256: string;
  /** ChainEvent records sorted by (slot, mint, chain_seq); non-universe records are skipped. */
  events: readonly ChainEventT[];
  /** Mints the collector could not repair: never in the universe. */
  excluded_mints?: readonly string[];
  /** Last slot of the collection window (default: the last record's slot). */
  end_slot?: number;
}

export interface EngineOptions {
  /** Every curve fee bps and every tx fee multiplied by this (cost sensitivity). Default 1. */
  feeMultiplier?: number;
  /** Parse every universe record with the strict ChainEvent schema in the chain check. Default true. */
  schemaCheck?: boolean;
  /**
   * Re-size sells by the share of the position they sold in a reference replay: `${seq}:${index}` ->
   * that sell's position_before_tokens there. The sell then sells floor(held * token_amount / it).
   * The cost-sensitivity replay uses it because a log's token amounts were sized against 1x fills
   * (sellShares builds it from the 1x run).
   */
  resizeSells?: ReadonlyMap<string, bigint>;
  /**
   * The key of the seeded failed-tx draw (u64 decimal), kept apart from hello.seed and never sent to
   * the bot or written into the action log. Default publicFailKey(hello.seed): the dev phase's,
   * which anyone holding the seed can compute. The grader passes the phase's key (grader/worker.ts
   * failKeyFor: secret on the final phase); a rescore must pass the key the run was graded with.
   */
  failKey?: string;
}

/** A live engine's options (ReplayEngine.live): the engine's, plus the mints never to admit. */
export interface LiveEngineOptions extends Omit<EngineOptions, 'schemaCheck'> {
  /** Mints kept out of the universe (counted excluded_by_dataset), as a frozen dataset's excluded_mints are. */
  excludedMints?: Iterable<string>;
}

/**
 * The dataset_sha256 a live engine's run and action log carry: a declared placeholder, since no frozen
 * dataset backs a live run (no dataset's bytes hash to all zeros). So replayActionLog refuses a live
 * log against any frozen dataset; a live run is compared with the graded one by its replies alone.
 */
export const LIVE_DATASET_SHA256 = '0'.repeat(64);

/** The placeholder datasets ReplayEngine.live builds: the constructor starts each of those live. */
const LIVE_SOURCES = new WeakSet<ReplayDataset>();

/**
 * Frozen chain reports per dataset events array (identity), then per schema flag and sorted universe:
 * checkChain is pure over those, and one replay grade builds several engines over one dataset.
 */
const CHAIN_REPORTS = new WeakMap<readonly ChainEventT[], Map<string, ChainReport>>();

/** checkChain runs the constructor did not serve from CHAIN_REPORTS (a test seam). */
export const chainCheckStats = { runs: 0 };

function universeChainReport(events: readonly ChainEventT[], universe: ReadonlySet<string>, schema: boolean): ChainReport {
  const key = `${schema ? 1 : 0}:${[...universe].sort().join(',')}`;
  let byKey = CHAIN_REPORTS.get(events);
  const hit = byKey?.get(key);
  if (hit !== undefined) return hit;
  chainCheckStats.runs++;
  const report = checkChain(events, { mints: (mint) => universe.has(mint), schema });
  for (const i of report.issues) Object.freeze(i);
  Object.freeze(report.issues);
  Object.freeze(report);
  if (byKey === undefined) CHAIN_REPORTS.set(events, (byKey = new Map()));
  byKey.set(key, report);
  return report;
}

/** Where a live engine stands on a mint whose CreateEvent it has seen. */
type LiveMint = 'out' | 'member' | 'complete';

/** The bot's net flow into one curve so far (see the header): quote put in, tokens taken out. */
export interface BotOffset {
  quote: bigint;
  tokens: bigint;
}

/**
 * The reserves the bot meets on a curve: the recorded reserves shifted by its own net flow. When
 * the whole shift would take the real token reserve or the real quote reserve below zero, quote and
 * tokens are scaled down alike (by the largest share num/den that keeps both at or above zero; the
 * token amount floored, the quote truncated toward zero), so the bot's net position never counts for
 * more than the curve's real token reserve and a completed curve is met as recorded.
 */
export function offsetReserves(recorded: CurveState, off: BotOffset): CurveState {
  let num = 1n;
  let den = 1n;
  if (off.tokens > recorded.rt) {
    num = recorded.rt;
    den = off.tokens;
  }
  if (off.quote < 0n && recorded.rq * den < num * -off.quote) {
    num = recorded.rq;
    den = -off.quote;
  }
  const scale = (x: bigint) => (num === den ? x : x >= 0n ? (x * num) / den : -((-x * num) / den));
  const q = scale(off.quote);
  const t = scale(off.tokens);
  return { vq: recorded.vq + q, rq: recorded.rq + q, vt: recorded.vt - t, rt: recorded.rt - t };
}

/** The resizeSells map of a run: each sell order that was sent (filled or failed) and the position before it. */
export function sellShares(run: Pick<ReplayRun, 'resolutions'>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const f of run.resolutions) {
    if (f.kind === 'order' && f.side === 'sell' && f.status !== 'rejected') out.set(`${f.seq}:${f.index}`, BigInt(f.position_before_tokens));
  }
  return out;
}

export class SimDataError extends Error {
  readonly issues: ChainIssue[];

  constructor(message: string, issues: ChainIssue[] = []) {
    super(message);
    this.name = 'SimDataError';
    this.issues = issues;
  }
}

/** The bot broke the protocol (bad reply, wrong seq, out of lockstep). */
export class SimProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimProtocolError';
  }
}

/** An invariant failed (conservation, negative cash): the replay is aborted, never scored. */
export class SimAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimAbortError';
  }
}

export type ResolutionKind = 'order' | (typeof HARNESS_CLOSE_KINDS)[number];

/** One resolution: the protocol Fill plus what the sim knows about it. */
export interface SimFill extends FillT {
  kind: ResolutionKind;
  /** Batch seq and order index it was decided on (null for harness closes). */
  seq: number | null;
  index: number | null;
  /** Curve quote the fill moved (q), and the fee split (fee_lamports = protocol + creator). */
  curve_quote_lamports: string;
  protocol_fee_lamports: string;
  creator_fee_lamports: string;
  /** The buyback share of the protocol fee (not an extra charge). */
  buyback_fee_lamports: string;
  /** The bot's position in the mint just before this resolution. */
  position_before_tokens: string;
  /** The bot's cash after this resolution. */
  cash_after_lamports: string;
}

export interface EquityPoint {
  /** Batch seq the point follows (-1: the start, `batches`: after the final flatten). */
  seq: number;
  slot: number;
  /** Unix seconds of that slot's block (carried forward when the data has none). */
  block_time: number | null;
  /** Cash plus every position at what closing it now would pay (curve and tx fees deducted). */
  equity_lamports: string;
}

export interface RoundTrip {
  mint: string;
  opened_slot: number;
  closed_slot: number;
  /** Every lamport in and out while the position was open, tx fees included. */
  pnl_lamports: string;
  /** What its buy fills paid (each fill's quote_lamports: curve fees included, tx fees not). */
  bought_lamports: string;
}

export interface TokenLedger {
  mint: string;
  /** Sum of every cash flow on the mint (fills, closes, tx fees of filled and failed orders). */
  realized_pnl_lamports: string;
  /** The bot's own filled orders on the mint (closes excluded). */
  fills: number;
  /** Curve fees (protocol + creator) paid on the mint, closes included. */
  fees_lamports: string;
  tx_fees_lamports: string;
}

export interface LamportLedger {
  bot: string;
  curve: string;
  protocol: string;
  buyback: string;
  creator: string;
  network: string;
}

export interface ReplayRun {
  protocol: typeof PROTOCOL;
  dataset_sha256: string;
  fee_multiplier: number;
  hello: HelloT;
  action_log: ActionLogT;
  /** Batches delivered. */
  batches: number;
  end_slot: number;
  resolutions: SimFill[];
  equity: EquityPoint[];
  round_trips: RoundTrip[];
  per_token: TokenLedger[];
  final_account: AccountT;
  start_lamports: string;
  /** Net lamport flow per bucket over the run (sums to 0). */
  ledger: LamportLedger;
  /** No delivered event, mark or fill had a slot beyond the batch it arrived in. */
  no_future_events: boolean;
  /** First and last block time (unix seconds) in the dataset; null when it carries none. */
  first_block_time: number | null;
  last_block_time: number | null;
  /** The universe: its size, its members (code-unit order) and what the sample rule left out. */
  universe: { mints: number; members: string[]; excluded: Record<UniverseExclusion, number> };
  /** Non-fatal chain findings in the universe (formula, complete_with_tokens). */
  chain_warnings: ChainIssue[];
  /** Null unless an invariant failed; then the run must not be scored. */
  aborted: string | null;
}

interface MintRt {
  create: CreateEventRecordT;
  /** The recorded reserves: the latest post-trade state (or the CreateEvent's). */
  state: CurveState;
  stateSlot: number;
  lastTrade: TradeEventRecordT | null;
  lastTradeSlot: number;
  complete: boolean;
  /** The bot's net flow into the curve over the whole run so far; every reserve it meets is `state` shifted by it. */
  offset: BotOffset;
}

interface Pending {
  order: OrderT;
  seq: number;
  index: number;
  decidedSlot: number;
  fillSlot: number;
  reject: RejectReasonT | null;
  decision: CurveState | null;
}

interface PositionRt {
  tokens: bigint;
  cost: bigint;
}

interface TokenRt {
  pnl: bigint;
  fills: number;
  fees: bigint;
  txFees: bigint;
  /** The open round trip: its cash flow, the slot its first fill landed, and what its buy fills paid. */
  open: { pnl: bigint; openedSlot: number; bought: bigint } | null;
}

interface SlotBatch {
  slot: number;
  events: ChainEventT[];
}

interface ResolvedFees extends FeeBps {
  buyback: bigint;
  fallback: boolean;
}

const ZERO_EXCLUDED = (): Record<UniverseExclusion, number> => ({
  not_sol_quoted: 0,
  mayhem_mode: 0,
  cashback_enabled: 0,
  not_sampled: 0,
  excluded_by_dataset: 0,
});

/**
 * The universe's records of a dataset, in order, from any iterable (e.g. NDJSON chunks streamed in):
 * a mint's CreateEvent precedes its other records, so membership is known when they arrive.
 */
export function filterUniverse(events: Iterable<ChainEventT>, sample: UniverseSampleT, excludedMints: Iterable<string> = []): ChainEventT[] {
  const excluded = new Set(excludedMints);
  const members = new Set<string>();
  const out: ChainEventT[] = [];
  for (const e of events) {
    if (e.event === 'CreateEvent' && universeExclusion(e, sample, excluded) === null) members.add(e.mint);
    if (members.has(e.mint)) out.push(e);
  }
  return out;
}

/** One protocol message as the line the harness writes; refuses lines over MAX_HARNESS_LINE_BYTES. */
export function encodeHarnessLine(msg: HelloT | BatchT | DoneT): string {
  const line = JSON.stringify(msg);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_HARNESS_LINE_BYTES) throw new SimDataError(`${msg.type} line is ${bytes} bytes (max ${MAX_HARNESS_LINE_BYTES})`);
  return `${line}\n`;
}

const str = (n: bigint) => n.toString();

/** Whether a curve read of a record succeeds: false on its CurveDataError (a *_sol_* / *_quote_* mismatch). */
function curveData(read: () => unknown): boolean {
  try {
    read();
    return true;
  } catch (err) {
    if (err instanceof CurveDataError) return false;
    throw err;
  }
}

/** A live engine releases delivered batches once at least this many sit before its cursor. */
const LIVE_RELEASE_BATCHES = 1024;

/** One resolution's deltas per bucket: lamports (bot cash, curve, fee recipients, network) and tokens. */
export interface ResolutionDeltas {
  bot: bigint;
  curve: bigint;
  protocol: bigint;
  buyback: bigint;
  creator: bigint;
  network: bigint;
  botTokens: bigint;
  curveTokens: bigint;
  abandonedTokens: bigint;
}

/** The per-fill conservation invariant: lamport deltas sum to 0 and token deltas sum to 0, else SimAbortError. */
export function checkConservation(d: ResolutionDeltas, what: string): void {
  const sum = d.bot + d.curve + d.protocol + d.buyback + d.creator + d.network;
  if (sum !== 0n) throw new SimAbortError(`conservation violated by ${what}: lamport deltas sum to ${sum}`);
  const tokens = d.botTokens + d.curveTokens + d.abandonedTokens;
  if (tokens !== 0n) throw new SimAbortError(`conservation violated by ${what}: token deltas sum to ${tokens}`);
}

export class ReplayEngine {
  readonly hello: HelloT;
  private readonly datasetSha: string;
  private readonly mult: bigint;
  private readonly multNum: number;
  private readonly failKey: bigint;
  private readonly latency: number;
  private readonly txFee: bigint;
  private readonly batches: SlotBatch[];
  /** The dataset's end_slot (frozen), or the one finish() is given (live). */
  private endSlot: number;
  private readonly slotTime = new Map<number, number>();
  private firstBlockTime: number | null;
  private lastBlockTime: number | null;
  private readonly universeMints: Set<string>;
  private readonly excluded: ReadonlySet<string>;
  private readonly excludedCounts: Record<UniverseExclusion, number>;
  private readonly chainWarnings: ChainIssue[];
  private readonly resize: ReadonlyMap<string, bigint> | null;
  /** Records arrive through feed() (ReplayEngine.live), not with the dataset. */
  private readonly isLive: boolean;
  /** Live: every mint whose CreateEvent was fed, and where it stands. */
  private readonly liveMints = new Map<string, LiveMint>();
  /** Live: the last slot fed (-1 before any). */
  private fedThrough = -1;
  /** Live: delivered batches released from the front of `batches` (cursor counts from there). */
  private batchesDropped = 0;
  /** The start equity point's slot had no block time (it took the earliest one known then). */
  private startUntimed = false;

  private phase: 'ready' | 'awaiting_reply' | 'finished' = 'ready';
  private cursor = 0;
  private seq = 0;
  private curSlot = -1;
  private curTime: number | null = null;
  private aborted: string | null = null;

  private readonly mints = new Map<string, MintRt>();
  private readonly pending: Pending[] = [];
  private readonly usedIds = new Set<string>();
  private readonly positions = new Map<string, PositionRt>();
  private readonly tokens = new Map<string, TokenRt>();
  private cash: bigint;
  private readonly startCash: bigint;
  private readonly ledger = { bot: 0n, curve: 0n, protocol: 0n, buyback: 0n, creator: 0n, network: 0n };
  private readonly resolutions: SimFill[] = [];
  private undelivered: FillT[] = [];
  private readonly equity: EquityPoint[] = [];
  private readonly roundTrips: RoundTrip[] = [];
  private readonly replies: ReplyT[] = [];
  private noFutureEvents = true;
  private closeCounter = 0;
  /** Buy spend per mint that passed the size check, for the reply (batch seq) now resolving. */
  private readonly spent = { seq: -1, byMint: new Map<string, bigint>() };

  constructor(dataset: ReplayDataset, hello: HelloT, opts: EngineOptions = {}) {
    this.hello = Hello.parse(hello);
    const sha = Sha256Hex.safeParse(dataset.sha256);
    if (!sha.success) throw new SimDataError(`dataset sha256 ${JSON.stringify(dataset.sha256)} is not a lowercase hex sha256`);
    this.datasetSha = dataset.sha256;
    const m = opts.feeMultiplier ?? 1;
    if (!Number.isInteger(m) || m < 1) throw new RangeError(`feeMultiplier must be a positive integer, got ${m}`);
    this.multNum = m;
    this.mult = BigInt(m);
    this.resize = opts.resizeSells ?? null;
    this.failKey = parseU64(opts.failKey ?? publicFailKey(this.hello.seed), 'failKey');
    this.latency = this.hello.latency_slots;
    this.txFee = (BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports)) * this.mult;
    this.cash = BigInt(this.hello.capital.lamports);
    this.startCash = this.cash;
    this.isLive = LIVE_SOURCES.has(dataset);

    // Universe from the CreateEvents.
    const excluded = new Set(dataset.excluded_mints ?? []);
    this.excluded = excluded;
    this.universeMints = new Set();
    this.excludedCounts = ZERO_EXCLUDED();
    let first: number | null = null;
    let last: number | null = null;
    for (const e of dataset.events) {
      if (e.block_time !== null) {
        if (!this.slotTime.has(e.slot)) this.slotTime.set(e.slot, e.block_time);
        if (first === null || e.block_time < first) first = e.block_time;
        if (last === null || e.block_time > last) last = e.block_time;
      }
      if (e.event !== 'CreateEvent' || this.universeMints.has(e.mint)) continue;
      const why = universeExclusion(e, this.hello.universe.sample, excluded);
      if (why === null) this.universeMints.add(e.mint);
      else this.excludedCounts[why]++;
    }
    this.firstBlockTime = first;
    this.lastBlockTime = last;

    // The chain check over the universe (memoized for frozen datasets); any fatal issue refuses the dataset.
    const schema = opts.schemaCheck ?? true;
    const report = this.isLive
      ? checkChain(dataset.events, { mints: (mint) => this.universeMints.has(mint), schema })
      : universeChainReport(dataset.events, this.universeMints, schema);
    if (!report.ok) {
      const fatal = report.issues.filter((i) => i.fatal);
      throw new SimDataError(
        `dataset fails the chain check: ${fatal.length} fatal issue(s), first: ${fatal[0]!.kind} at record ${fatal[0]!.index} (${fatal[0]!.detail})`,
        fatal,
      );
    }
    this.chainWarnings = report.issues.filter((i) => !i.fatal);

    // One batch per slot carrying universe records.
    this.batches = [];
    for (const e of dataset.events) {
      if (!this.universeMints.has(e.mint)) continue;
      const tail = this.batches[this.batches.length - 1];
      if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
      else this.batches.push({ slot: e.slot, events: [e] });
    }
    const lastSlot = dataset.events.length > 0 ? dataset.events[dataset.events.length - 1]!.slot : 0;
    this.endSlot = dataset.end_slot ?? lastSlot;
    if (this.endSlot < lastSlot) throw new SimDataError(`end_slot ${this.endSlot} is before the last record's slot ${lastSlot}`);
  }

  /**
   * A live engine (the header's Live mode): the hello and options checked as the constructor checks
   * them, and no record yet; feed() brings them. Its run and action log carry LIVE_DATASET_SHA256.
   * Called on a subclass, it builds that subclass.
   */
  static live<E extends ReplayEngine>(this: new (dataset: ReplayDataset, hello: HelloT, opts?: EngineOptions) => E, hello: HelloT, opts: LiveEngineOptions = {}): E {
    const { excludedMints, ...engineOpts } = opts;
    const source: ReplayDataset = { sha256: LIVE_DATASET_SHA256, events: [], excluded_mints: [...(excludedMints ?? [])] };
    LIVE_SOURCES.add(source);
    return new this(source, hello, engineOpts);
  }

  /**
   * Live mode: every record of `slot`, in dataset order ((mint, chain_seq) within the slot). Slots are
   * fed strictly increasing, each once (a slot with no record may be fed empty or skipped); a feed may
   * land while a reply is awaited. Membership is decided as records arrive and what the universe
   * cannot take is dropped, never thrown (the header). The kept records, by reference, make the
   * slot's batch. Refused (SimDataError, nothing kept): a slot that does not follow the last one fed,
   * a record of another slot. A frozen engine takes no feed; a finished one neither.
   */
  feed(slot: number, events: readonly ChainEventT[]): void {
    if (!this.isLive) throw new SimDataError('a frozen engine takes no feed: its dataset holds every record');
    if (this.phase === 'finished') throw new SimProtocolError('the replay is finished');
    if (!Number.isSafeInteger(slot) || slot < 0 || slot <= this.fedThrough) {
      throw new SimDataError(`feed slot ${String(slot)} does not follow ${this.fedThrough}: slots are fed strictly increasing`);
    }
    for (const e of events) if (e.slot !== slot) throw new SimDataError(`feed slot ${slot} carries a ${e.event} of slot ${String(e.slot)}`);
    this.fedThrough = slot;
    const kept: ChainEventT[] = [];
    for (const e of events) {
      if (e.block_time !== null) {
        if (!this.slotTime.has(e.slot)) this.slotTime.set(e.slot, e.block_time);
        if (this.firstBlockTime === null || e.block_time < this.firstBlockTime) this.firstBlockTime = e.block_time;
        if (this.lastBlockTime === null || e.block_time > this.lastBlockTime) this.lastBlockTime = e.block_time;
      }
      if (this.admit(e)) kept.push(e);
    }
    // A batch's slot time is read once, when it is stepped (stepTo); a slot with no batch never is.
    if (kept.length > 0 && this.aborted === null) this.batches.push({ slot, events: kept });
    else this.slotTime.delete(slot);
  }

  /** Live: whether a fed record reaches the bot, deciding the mint's membership on its CreateEvent. */
  private admit(e: ChainEventT): boolean {
    const at = this.liveMints.get(e.mint);
    if (e.event === 'CreateEvent') {
      if (at !== undefined) return false;
      const why = universeExclusion(e, this.hello.universe.sample, this.excluded);
      if (why !== null) this.excludedCounts[why]++;
      else if (curveData(() => createState(e))) {
        this.liveMints.set(e.mint, 'member');
        this.universeMints.add(e.mint);
        return true;
      }
      this.liveMints.set(e.mint, 'out');
      return false;
    }
    if (at !== 'member') return false;
    if (e.event === 'TradeEvent') return curveData(() => tradePostState(e));
    this.liveMints.set(e.mint, 'complete');
    return true;
  }

  /**
   * Whether a fed batch is waiting for nextBatch(), counting from after the batch whose reply is
   * awaited. A frozen engine is ready until its data is exhausted; neither is once aborted or finished.
   */
  ready(): boolean {
    if (this.phase === 'finished' || this.aborted !== null) return false;
    return (this.phase === 'awaiting_reply' ? this.cursor + 1 : this.cursor) < this.batches.length;
  }

  /** The next batch, or null when no batch is waiting: the data is exhausted (then call finish), or a live engine awaits its next feed. */
  nextBatch(): BatchT | null {
    if (this.phase === 'awaiting_reply') throw new SimProtocolError(`batch ${this.seq} has no reply yet`);
    if (this.phase === 'finished') throw new SimProtocolError('the replay is finished');
    if (this.aborted !== null || this.cursor >= this.batches.length) return null;
    const b = this.batches[this.cursor]!;
    try {
      return this.stepTo(b);
    } catch (err) {
      if (err instanceof SimAbortError) {
        this.aborted = err.message;
        return null;
      }
      throw err;
    }
  }

  /** The bot's reply to the current batch (validated against the strict Reply schema and its seq). */
  submit(reply: unknown): void {
    if (this.phase !== 'awaiting_reply') throw new SimProtocolError('a reply arrived without a pending batch');
    const parsed = Reply.safeParse(reply);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SimProtocolError(`not a reply: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}`);
    }
    const r = parsed.data;
    if (r.seq !== this.seq) throw new SimProtocolError(`reply seq ${r.seq} answers batch ${this.seq}`);
    this.replies.push(r);
    const caps = this.hello.caps;
    r.orders.forEach((order, index) => {
      let reject: RejectReasonT | null = null;
      const amount = order.side === 'buy' ? order.quote_lamports : order.token_amount;
      if (index >= caps.max_orders_per_batch) reject = 'max_orders_per_batch';
      else if (this.usedIds.has(order.client_id)) reject = 'duplicate_client_id';
      else if (amount === '0') reject = 'zero_amount';
      else if (!this.mints.has(order.mint)) reject = 'not_in_universe';
      this.usedIds.add(order.client_id);
      const m = this.mints.get(order.mint);
      this.pending.push({
        order,
        seq: this.seq,
        index,
        decidedSlot: this.curSlot,
        fillSlot: this.curSlot + this.latency,
        reject,
        decision: m ? this.reserves(m) : null,
      });
    });
    this.seq++;
    this.cursor++;
    this.phase = 'ready';
    // A long live run keeps only the batches not yet delivered (a frozen one keeps its dataset's).
    if (this.isLive && this.cursor >= LIVE_RELEASE_BATCHES) {
      this.batches.splice(0, this.cursor);
      this.batchesDropped += this.cursor;
      this.cursor = 0;
    }
  }

  /** submit() for a raw stdout line: parseBotLine's size cap, JSON and schema checks first. */
  submitLine(line: string): void {
    const parsed = parseBotLine(line);
    if (!parsed.ok) throw new SimProtocolError(parsed.reason);
    this.submit(parsed.reply);
  }

  /**
   * Resolve what is left, flatten, and close the replay: the done message and the run. A live engine
   * ends at `endSlot` (default: the last slot fed; never before it); a frozen one at its dataset's
   * end_slot, and takes none.
   */
  finish(endSlot?: number): { done: DoneT; run: ReplayRun } {
    if (this.phase === 'awaiting_reply') throw new SimProtocolError(`batch ${this.seq} has no reply yet`);
    if (this.phase === 'finished') throw new SimProtocolError('the replay is already finished');
    if (this.aborted === null && this.cursor < this.batches.length) {
      throw new SimProtocolError(`finish() before the last batch (${this.batchesDropped + this.cursor} of ${this.batchesDropped + this.batches.length})`);
    }
    if (endSlot !== undefined && !this.isLive) throw new SimDataError(`a frozen engine ends at its dataset's end_slot ${this.endSlot}`);
    if (this.isLive) {
      const end = endSlot ?? Math.max(this.fedThrough, 0);
      if (!Number.isSafeInteger(end) || end < 0) throw new SimDataError(`end_slot ${String(end)} is not a slot`);
      if (end < this.fedThrough) throw new SimDataError(`end_slot ${end} is before the last slot fed ${this.fedThrough}`);
      this.endSlot = end;
      // As a frozen dataset's: an untimed start takes the earliest block time of the whole stream.
      if (this.startUntimed) this.equity[0]!.block_time = this.firstBlockTime;
    }
    this.phase = 'finished';
    if (this.aborted === null) {
      try {
        this.curSlot = this.endSlot;
        while (this.pending.length > 0) {
          const p = this.pending.shift()!;
          if (p.fillSlot > this.endSlot) this.reject(p, 'after_end');
          else this.resolve(p);
        }
        for (const mint of [...this.positions.keys()].sort()) this.forceClose(mint, 'flatten', this.endSlot);
        this.equity.push({ seq: this.seq, slot: this.endSlot, block_time: this.lastBlockTime ?? this.curTime, equity_lamports: str(this.cash) });
        this.checkTotals();
      } catch (err) {
        if (!(err instanceof SimAbortError)) throw err;
        this.aborted = err.message;
      }
    }
    const account = this.account();
    const done: DoneT = { type: 'done', seq: this.seq, reason: this.aborted === null ? 'end_of_data' : 'aborted', account };
    const run: ReplayRun = {
      protocol: PROTOCOL,
      dataset_sha256: this.datasetSha,
      fee_multiplier: this.multNum,
      hello: this.hello,
      action_log: { format: ACTION_LOG_FORMAT, protocol: PROTOCOL, dataset_sha256: this.datasetSha, hello: this.hello, replies: this.replies },
      batches: this.seq,
      end_slot: this.endSlot,
      resolutions: this.resolutions,
      equity: this.equity,
      round_trips: this.roundTrips,
      per_token: [...this.tokens.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([mint, t]) => ({ mint, realized_pnl_lamports: str(t.pnl), fills: t.fills, fees_lamports: str(t.fees), tx_fees_lamports: str(t.txFees) })),
      final_account: account,
      start_lamports: str(this.startCash),
      ledger: {
        bot: str(this.ledger.bot),
        curve: str(this.ledger.curve),
        protocol: str(this.ledger.protocol),
        buyback: str(this.ledger.buyback),
        creator: str(this.ledger.creator),
        network: str(this.ledger.network),
      },
      no_future_events: this.noFutureEvents,
      first_block_time: this.firstBlockTime,
      last_block_time: this.lastBlockTime,
      universe: { mints: this.universeMints.size, members: [...this.universeMints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), excluded: this.excludedCounts },
      chain_warnings: this.chainWarnings,
      aborted: this.aborted,
    };
    return { done, run };
  }

  // ---------------------------------------------------------------- stepping

  private stepTo(b: SlotBatch): BatchT {
    const x = b.slot;
    if (this.equity.length === 0) {
      const t = this.slotTime.get(x);
      this.startUntimed = t === undefined;
      this.equity.push({ seq: -1, slot: x, block_time: t ?? this.firstBlockTime, equity_lamports: str(this.cash) });
    }
    // 1. Orders that resolve in slots before this one (no universe record there: latest reserves).
    while (this.pending.length > 0 && this.pending[0]!.fillSlot < x) {
      const p = this.pending.shift()!;
      this.curSlot = p.fillSlot;
      this.resolve(p);
    }
    this.curSlot = x;
    this.curTime = this.slotTime.get(x) ?? this.curTime;
    if (this.isLive) this.slotTime.delete(x);
    // 2. This slot's records.
    const completed: string[] = [];
    for (const e of b.events) {
      if (e.slot > x) this.noFutureEvents = false;
      switch (e.event) {
        case 'CreateEvent':
          this.mints.set(e.mint, { create: e, state: createState(e), stateSlot: x, lastTrade: null, lastTradeSlot: -1, complete: false, offset: { quote: 0n, tokens: 0n } });
          break;
        case 'TradeEvent': {
          const m = this.mints.get(e.mint)!;
          m.state = tradePostState(e);
          m.stateSlot = x;
          m.lastTrade = e;
          m.lastTradeSlot = x;
          break;
        }
        case 'CompleteEvent': {
          const m = this.mints.get(e.mint)!;
          m.complete = true;
          completed.push(e.mint);
          break;
        }
      }
    }
    // 3. Completed curves close their positions, then 4. orders resolving in this slot.
    for (const mint of completed) if (this.positions.has(mint)) this.forceClose(mint, 'complete', x);
    while (this.pending.length > 0 && this.pending[0]!.fillSlot === x) this.resolve(this.pending.shift()!);

    const marks = this.marks();
    for (const mk of marks) if (mk.slot > x) this.noFutureEvents = false;
    const fills = this.undelivered;
    for (const f of fills) if (f.slot > x) this.noFutureEvents = false;
    this.undelivered = [];
    this.equity.push({ seq: this.seq, slot: x, block_time: this.curTime, equity_lamports: str(this.equityNow()) });
    this.phase = 'awaiting_reply';
    return { type: 'batch', seq: this.seq, slot: x, events: b.events, marks, fills, account: this.account() };
  }

  private marks(): MarkT[] {
    const want = new Set<string>(this.positions.keys());
    for (const p of this.pending) if (this.mints.has(p.order.mint)) want.add(p.order.mint);
    return [...want].sort().map((mint) => {
      const m = this.mints.get(mint)!;
      const s = this.reserves(m);
      return {
        mint,
        slot: m.stateSlot,
        virtual_token_reserves: str(s.vt),
        virtual_quote_reserves: str(s.vq),
        real_token_reserves: str(s.rt),
        real_quote_reserves: str(s.rq),
      };
    });
  }

  private account(): AccountT {
    return {
      cash_lamports: str(this.cash),
      positions: [...this.positions.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([mint, p]) => ({ mint, token_amount: str(p.tokens), cost_lamports: str(p.cost) })),
    };
  }

  // ---------------------------------------------------------------- fees and valuation

  private feesFor(landing: TradeEventRecordT | null): ResolvedFees {
    if (landing !== null && BigInt(landing.fee_basis_points) > 0n) {
      return {
        protocol: BigInt(landing.fee_basis_points) * this.mult,
        creator: BigInt(landing.creator_fee_basis_points) * this.mult,
        buyback: BigInt(landing.buyback_fee_basis_points),
        fallback: false,
      };
    }
    return {
      protocol: BigInt(this.hello.fees.protocol_bps_fallback) * this.mult,
      creator: BigInt(this.hello.fees.creator_bps_fallback) * this.mult,
      buyback: 0n,
      fallback: true,
    };
  }

  /**
   * What closing `tokens` of the mint against reserves `s` (default: the ones the bot meets now,
   * its own impact included) pays: a sell at its last trade's bps with the curve output capped at
   * the real quote reserves, minus tx fees.
   */
  private closeQuote(m: MintRt, tokens: bigint, s: CurveState = this.reserves(m)) {
    const bps = this.feesFor(m.lastTrade);
    const raw = quoteSell(tokens, s, bps);
    const q = raw.q > s.rq ? s.rq : raw.q;
    const fee = feeOf(q, bps.protocol);
    const creatorFee = feeOf(q, bps.creator);
    const proceeds = q - fee - creatorFee;
    return { bps, q, fee, creatorFee, proceeds, net: proceeds - this.txFee, abandon: proceeds - this.txFee <= 0n };
  }

  /**
   * The bot's equity now: cash plus every position at what closing it now would pay (curve and tx
   * fees deducted; a close that would not cover its tx fees counts 0), as each equity point values
   * it. Orders not yet resolved count nothing. Read-only: a live race reads it between batches.
   */
  equityNow(): bigint {
    let e = this.cash;
    for (const [mint, p] of this.positions) {
      const c = this.closeQuote(this.mints.get(mint)!, p.tokens);
      if (!c.abandon) e += c.net;
    }
    return e;
  }

  // ---------------------------------------------------------------- resolution

  private base(p: Pending): SimFill {
    return {
      client_id: p.order.client_id,
      mint: p.order.mint,
      side: p.order.side,
      status: 'rejected',
      reason: null,
      decided_slot: p.decidedSlot,
      slot: p.fillSlot,
      quote_lamports: '0',
      token_amount: '0',
      fee_lamports: '0',
      tx_fee_lamports: '0',
      fee_fallback: false,
      kind: 'order',
      seq: p.seq,
      index: p.index,
      curve_quote_lamports: '0',
      protocol_fee_lamports: '0',
      creator_fee_lamports: '0',
      buyback_fee_lamports: '0',
      position_before_tokens: str(this.positions.get(p.order.mint)?.tokens ?? 0n),
      cash_after_lamports: str(this.cash),
    };
  }

  private record(f: SimFill): void {
    this.resolutions.push(f);
    const {
      kind: _k,
      seq: _s,
      index: _i,
      curve_quote_lamports: _q,
      protocol_fee_lamports: _p,
      creator_fee_lamports: _c,
      buyback_fee_lamports: _b,
      position_before_tokens: _h,
      cash_after_lamports: _a,
      ...fill
    } = f;
    this.undelivered.push(fill);
  }

  private reject(p: Pending, reason: RejectReasonT): void {
    const f = this.base(p);
    f.reason = reason;
    this.record(f);
  }

  private token(mint: string): TokenRt {
    let t = this.tokens.get(mint);
    if (t === undefined) {
      t = { pnl: 0n, fills: 0, fees: 0n, txFees: 0n, open: null };
      this.tokens.set(mint, t);
    }
    return t;
  }

  /** Apply one resolution's lamport and token deltas after checking they conserve. */
  private post(d: ResolutionDeltas, what: string): void {
    checkConservation(d, what);
    if (this.cash < 0n) throw new SimAbortError(`cash went negative (${this.cash}) after ${what}`);
    this.ledger.bot += d.bot;
    this.ledger.curve += d.curve;
    this.ledger.protocol += d.protocol;
    this.ledger.buyback += d.buyback;
    this.ledger.creator += d.creator;
    this.ledger.network += d.network;
  }

  private openCount(): number {
    let n = 0;
    for (const p of this.positions.values()) if (p.tokens > 0n) n++;
    return n;
  }

  /** The reserves the bot meets on `m` now: the latest recorded ones shifted by its own net flow (offsetReserves). */
  private reserves(m: MintRt): CurveState {
    return offsetReserves(m.state, m.offset);
  }

  /** Add one of the bot's own fills or closes (q curve quote, t tokens) to its net flow into the curve. */
  private impact(m: MintRt, isBuy: boolean, q: bigint, t: bigint): void {
    m.offset = isBuy ? { quote: m.offset.quote + q, tokens: m.offset.tokens + t } : { quote: m.offset.quote - q, tokens: m.offset.tokens - t };
  }

  /** The reply's buy spend on `mint` that already passed the size check (reset when a new reply resolves). */
  private spentOn(seq: number, mint: string): bigint {
    if (this.spent.seq !== seq) {
      this.spent.seq = seq;
      this.spent.byMint.clear();
    }
    return this.spent.byMint.get(mint) ?? 0n;
  }

  private resolve(p: Pending): void {
    if (p.reject !== null) return this.reject(p, p.reject);
    const m = this.mints.get(p.order.mint)!;
    if (m.complete) return this.reject(p, 'token_complete');
    const landing = m.lastTradeSlot === p.fillSlot ? m.lastTrade : null;
    const bps = this.feesFor(landing);
    const slip = BigInt(p.order.max_slippage_bps);
    const decision = p.decision!;
    const label = `${p.order.side} ${p.order.client_id} (batch ${p.seq}, order ${p.index})`;
    const s = this.reserves(m);

    if (p.order.side === 'sell') {
      const pos = this.positions.get(p.order.mint);
      let t = BigInt(p.order.token_amount);
      const share = this.resize?.get(`${p.seq}:${p.index}`);
      if (share !== undefined && share > 0n && pos !== undefined) t = (pos.tokens * t) / share;
      if (pos === undefined || pos.tokens < t) return this.reject(p, 'insufficient_tokens');
      const sq = quoteSell(t, s, bps);
      if (sq.q > s.rq) return this.reject(p, 'max_order_size');
      if (sq.proceeds <= 0n) return this.reject(p, 'zero_amount');
      const expected = quoteSell(t, decision, bps).proceeds;
      if (sq.proceeds * BPS < expected * (BPS - slip)) return this.reject(p, 'max_slippage');
      if (this.cash < this.txFee) return this.reject(p, 'insufficient_cash');
      if (this.failed(p, label)) return;
      const before = this.cash;
      const heldBefore = pos.tokens;
      this.cash += sq.proceeds - this.txFee;
      const removed = pos.tokens === t ? pos.cost : (pos.cost * t) / pos.tokens;
      pos.tokens -= t;
      pos.cost -= removed;
      const bb = buybackOf(sq.fee, bps.buyback);
      this.post(
        { bot: this.cash - before, curve: -sq.q, protocol: sq.fee - bb, buyback: bb, creator: sq.creatorFee, network: this.txFee, botTokens: -t, curveTokens: t, abandonedTokens: 0n },
        label,
      );
      this.impact(m, false, sq.q, t);
      const tk = this.token(p.order.mint);
      this.flow(tk, this.cash - before, sq.fee + sq.creatorFee, this.txFee, true);
      if (pos.tokens === 0n) {
        this.positions.delete(p.order.mint);
        this.closeRoundTrip(p.order.mint, tk, p.fillSlot);
      }
      const f = this.base(p);
      Object.assign(f, {
        status: 'filled',
        quote_lamports: str(sq.proceeds),
        token_amount: str(t),
        fee_lamports: str(sq.fee + sq.creatorFee),
        tx_fee_lamports: str(this.txFee),
        fee_fallback: bps.fallback,
        curve_quote_lamports: str(sq.q),
        protocol_fee_lamports: str(sq.fee),
        creator_fee_lamports: str(sq.creatorFee),
        buyback_fee_lamports: str(bb),
        position_before_tokens: str(heldBefore),
        cash_after_lamports: str(this.cash),
      });
      return this.record(f);
    }

    const spend = BigInt(p.order.quote_lamports);
    const held = this.positions.get(p.order.mint);
    if ((held === undefined || held.tokens === 0n) && this.openCount() >= this.hello.caps.max_open_positions) return this.reject(p, 'max_open_positions');
    const total = this.spentOn(p.seq, p.order.mint) + spend;
    if (total * BPS > decision.rq * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) return this.reject(p, 'max_order_size');
    this.spent.byMint.set(p.order.mint, total);
    const bq = quoteBuyExactIn(spend, s, bps);
    if (bq.t === 0n) return this.reject(p, 'zero_amount');
    const expected = quoteBuyExactIn(spend, decision, bps).t;
    if (bq.t * BPS < expected * (BPS - slip)) return this.reject(p, 'max_slippage');
    if (this.cash < spend + this.txFee) return this.reject(p, 'insufficient_cash');
    if (this.failed(p, label)) return;
    const before = this.cash;
    const heldBefore = held?.tokens ?? 0n;
    this.cash -= bq.paid + this.txFee;
    let pos = held;
    const opening = pos === undefined || pos.tokens === 0n;
    if (pos === undefined) {
      pos = { tokens: 0n, cost: 0n };
      this.positions.set(p.order.mint, pos);
    }
    pos.tokens += bq.t;
    pos.cost += bq.paid;
    const bb = buybackOf(bq.fee, bps.buyback);
    this.post(
      { bot: this.cash - before, curve: bq.q, protocol: bq.fee - bb, buyback: bb, creator: bq.creatorFee, network: this.txFee, botTokens: bq.t, curveTokens: -bq.t, abandonedTokens: 0n },
      label,
    );
    this.impact(m, true, bq.q, bq.t);
    const tk = this.token(p.order.mint);
    if (opening) tk.open = { pnl: 0n, openedSlot: p.fillSlot, bought: 0n };
    if (tk.open !== null) tk.open.bought += bq.paid;
    this.flow(tk, this.cash - before, bq.fee + bq.creatorFee, this.txFee, true);
    const f = this.base(p);
    Object.assign(f, {
      status: 'filled',
      quote_lamports: str(bq.paid),
      token_amount: str(bq.t),
      fee_lamports: str(bq.fee + bq.creatorFee),
      tx_fee_lamports: str(this.txFee),
      fee_fallback: bps.fallback,
      curve_quote_lamports: str(bq.q),
      protocol_fee_lamports: str(bq.fee),
      creator_fee_lamports: str(bq.creatorFee),
      buyback_fee_lamports: str(bb),
      position_before_tokens: str(heldBefore),
      cash_after_lamports: str(this.cash),
    });
    this.record(f);
  }

  /** The seeded failure draw; a failed order pays its tx fees and trades nothing. */
  private failed(p: Pending, label: string): boolean {
    if (!txFails(this.failKey, p.seq, p.index, this.hello.fees.failed_tx_bps)) return false;
    const before = this.cash;
    this.cash -= this.txFee;
    this.post({ bot: this.cash - before, curve: 0n, protocol: 0n, buyback: 0n, creator: 0n, network: this.txFee, botTokens: 0n, curveTokens: 0n, abandonedTokens: 0n }, `failed ${label}`);
    this.flow(this.token(p.order.mint), this.cash - before, 0n, this.txFee, false);
    const f = this.base(p);
    Object.assign(f, { status: 'failed', tx_fee_lamports: str(this.txFee), cash_after_lamports: str(this.cash) });
    this.record(f);
    return true;
  }

  private flow(tk: TokenRt, cashDelta: bigint, curveFees: bigint, txFees: bigint, filledOrder: boolean): void {
    tk.pnl += cashDelta;
    tk.fees += curveFees;
    tk.txFees += txFees;
    if (filledOrder) tk.fills++;
    if (tk.open !== null) tk.open.pnl += cashDelta;
  }

  private closeRoundTrip(mint: string, tk: TokenRt, slot: number): void {
    if (tk.open === null) return;
    this.roundTrips.push({ mint, opened_slot: tk.open.openedSlot, closed_slot: slot, pnl_lamports: str(tk.open.pnl), bought_lamports: str(tk.open.bought) });
    tk.open = null;
  }

  /**
   * Close a whole position at the mint's last trade's post-trade reserves (CompleteEvent or end of
   * data), shifted by the bot's own impact on it like any other fill there.
   */
  private forceClose(mint: string, why: 'complete' | 'flatten', slot: number): void {
    const pos = this.positions.get(mint)!;
    const m = this.mints.get(mint)!;
    const t = pos.tokens;
    const s = this.reserves(m);
    const c = this.closeQuote(m, t, s);
    const n = this.closeCounter++;
    const tk = this.token(mint);
    const before = this.cash;
    const kind: ResolutionKind = c.abandon ? 'writeoff' : why;
    const f: SimFill = {
      client_id: `_${kind}_${n}`,
      mint,
      side: 'sell',
      status: 'filled',
      reason: null,
      decided_slot: slot,
      slot,
      quote_lamports: '0',
      token_amount: str(t),
      fee_lamports: '0',
      tx_fee_lamports: '0',
      fee_fallback: false,
      kind,
      seq: null,
      index: null,
      curve_quote_lamports: '0',
      protocol_fee_lamports: '0',
      creator_fee_lamports: '0',
      buyback_fee_lamports: '0',
      position_before_tokens: str(t),
      cash_after_lamports: str(this.cash),
    };
    if (c.abandon) {
      this.post({ bot: 0n, curve: 0n, protocol: 0n, buyback: 0n, creator: 0n, network: 0n, botTokens: -t, curveTokens: 0n, abandonedTokens: t }, `write-off of ${mint}`);
    } else {
      this.cash += c.net;
      const bb = buybackOf(c.fee, c.bps.buyback);
      this.post(
        { bot: this.cash - before, curve: -c.q, protocol: c.fee - bb, buyback: bb, creator: c.creatorFee, network: this.txFee, botTokens: -t, curveTokens: t, abandonedTokens: 0n },
        `${why} close of ${mint}`,
      );
      this.impact(m, false, c.q, t);
      this.flow(tk, this.cash - before, c.fee + c.creatorFee, this.txFee, false);
      Object.assign(f, {
        quote_lamports: str(c.proceeds),
        fee_lamports: str(c.fee + c.creatorFee),
        tx_fee_lamports: str(this.txFee),
        fee_fallback: c.bps.fallback,
        curve_quote_lamports: str(c.q),
        protocol_fee_lamports: str(c.fee),
        creator_fee_lamports: str(c.creatorFee),
        buyback_fee_lamports: str(bb),
        cash_after_lamports: str(this.cash),
      });
    }
    this.positions.delete(mint);
    this.closeRoundTrip(mint, tk, slot);
    this.record(f);
  }

  /** End-of-run identities: the ledger sums to 0, the bot's bucket is its cash change, per-token PnL adds up. */
  private checkTotals(): void {
    const l = this.ledger;
    const sum = l.bot + l.curve + l.protocol + l.buyback + l.creator + l.network;
    if (sum !== 0n) throw new SimAbortError(`run ledger sums to ${sum}`);
    if (l.bot !== this.cash - this.startCash) throw new SimAbortError(`bot ledger ${l.bot} != cash change ${this.cash - this.startCash}`);
    let pnl = 0n;
    for (const t of this.tokens.values()) pnl += t.pnl;
    if (pnl !== this.cash - this.startCash) throw new SimAbortError(`per-token PnL ${pnl} != cash change ${this.cash - this.startCash}`);
    if (this.positions.size > 0) throw new SimAbortError(`${this.positions.size} position(s) left after flattening`);
  }
}

/** A bot the replay can drive: replies may be sync or async. */
export interface BotDriver {
  hello?(msg: HelloT): void | Promise<void>;
  batch(msg: BatchT): unknown;
  done?(msg: DoneT): void | Promise<void>;
}

/** Drive a bot through the whole replay in lockstep. */
export async function runBot(dataset: ReplayDataset, hello: HelloT, bot: BotDriver, opts?: EngineOptions): Promise<ReplayRun> {
  const engine = new ReplayEngine(dataset, hello, opts);
  await bot.hello?.(engine.hello);
  for (let b = engine.nextBatch(); b !== null; b = engine.nextBatch()) engine.submit(await bot.batch(b));
  const { done, run } = engine.finish();
  await bot.done?.(done);
  return run;
}

/** Re-run a stored action log (L1 regrade, cost sensitivity): the same dataset and replies give the same run. */
export function replayActionLog(dataset: ReplayDataset, log: ActionLogT, opts?: EngineOptions): ReplayRun {
  const parsed = ActionLog.parse(log);
  if (parsed.dataset_sha256 !== dataset.sha256) throw new SimDataError(`action log is for dataset ${parsed.dataset_sha256}, not ${dataset.sha256}`);
  const engine = new ReplayEngine(dataset, parsed.hello, opts);
  let i = 0;
  for (let b = engine.nextBatch(); b !== null; b = engine.nextBatch(), i++) {
    const reply = parsed.replies[i];
    if (reply === undefined) throw new SimProtocolError(`action log ends before batch ${b.seq}`);
    engine.submit(reply);
  }
  const { run } = engine.finish();
  if (run.aborted === null && i !== parsed.replies.length) throw new SimProtocolError(`action log has ${parsed.replies.length} replies for ${i} batches`);
  return run;
}
