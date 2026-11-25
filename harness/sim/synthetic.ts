// Synthetic pump.fun chain logs: valid, chained ChainEvent records priced with sim/curve.ts (so they
// pass sim/chain.ts and the strict ChainEvent schema), plus deliberately injected breaks that the
// chain check must catch. Deterministic per seed (SplitMix64).
//
//   CurveBuilder        one curve, event by event: create, buyExactIn, buyTokens, sell, complete.
//                       It tracks reserves and chain_seq; a buy that would take more than the real
//                       token reserves is cut to them (the completing partial fill) and, like the
//                       program, emits the CompleteEvent in the same transaction.
//   assemble            merge builders into one dataset sorted by (slot, mint, chain_seq)
//   generateDataset     many curves with random activity, some outside the universe (mayhem,
//                       cashback, non-SOL quote), some completing, and the requested breaks

import { DEFAULT_PUBKEY, base58Encode, type ChainEventT, type CompleteEventRecordT, type CreateEventRecordT, type TradeEventRecordT } from '../contracts/events.ts';
import {
  applyTrade,
  buybackOf,
  buyQuoteInForTokens,
  buyTokensOutForQuote,
  exactInSplit,
  feeOf,
  sellQuoteOut,
  type CurveState,
} from './curve.ts';
import { SplitMix64 } from './rng.ts';

/** The pump.fun launch defaults (FORMULAS.txt "Initial state"). */
export const PUMP_INITIAL = {
  virtual_token_reserves: 1_073_000_000_000_000n,
  virtual_quote_reserves: 30_000_000_000n,
  real_token_reserves: 793_100_000_000_000n,
  token_total_supply: 1_000_000_000_000_000n,
} as const;

export const SYNTHETIC_FEES = { protocol_bps: 95n, creator_bps: 30n, buyback_bps: 5000n } as const;

/** A non-SOL quote mint for out-of-universe curves (USDC). */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Random base58 keys and signatures from a seeded stream. */
export class SyntheticKeys {
  readonly rng: SplitMix64;

  constructor(seed: bigint) {
    this.rng = new SplitMix64(seed);
  }

  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 8) {
      let v = this.rng.next();
      for (let j = 0; j < 8 && i + j < n; j++) {
        out[i + j] = Number(v & 0xffn);
        v >>= 8n;
      }
    }
    out[0] = out[0]! | 1; // never a leading zero byte: keeps lengths in the usual 43-44 / 86-88 range
    return out;
  }

  pubkey(): string {
    return base58Encode(this.bytes(32));
  }

  signature(): string {
    return base58Encode(this.bytes(64));
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: bigint, hi: bigint): bigint {
    return lo + this.rng.below(hi - lo + 1n);
  }
}

/** Slot -> unix seconds at 400 ms per slot from a fixed origin. */
export interface Clock {
  slot0: number;
  time0: number;
}
export const blockTimeAt = (clock: Clock, slot: number): number => clock.time0 + Math.floor(((slot - clock.slot0) * 2) / 5);

export interface CurveOptions {
  mint?: string;
  creator?: string;
  quote_mint?: string;
  is_mayhem_mode?: boolean;
  is_cashback_enabled?: boolean;
  initial?: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint; real_token_reserves: bigint };
  fees?: { protocol_bps: bigint; creator_bps: bigint; buyback_bps: bigint };
}

export interface TradeOptions {
  user?: string;
  signature?: string;
}

/** One synthetic curve, built event by event. */
export class CurveBuilder {
  readonly mint: string;
  readonly creator: string;
  readonly quoteMint: string;
  readonly bondingCurve: string;
  readonly records: ChainEventT[] = [];
  state: CurveState;
  complete = false;
  private readonly isMayhem: boolean;
  private readonly isCashback: boolean;
  private readonly initial: NonNullable<CurveOptions['initial']>;
  private readonly fees: NonNullable<CurveOptions['fees']>;
  private readonly feeRecipient: string;
  readonly keys: SyntheticKeys;
  readonly clock: Clock;

  constructor(keys: SyntheticKeys, clock: Clock, opts: CurveOptions = {}) {
    this.keys = keys;
    this.clock = clock;
    this.mint = opts.mint ?? keys.pubkey();
    this.creator = opts.creator ?? keys.pubkey();
    this.quoteMint = opts.quote_mint ?? DEFAULT_PUBKEY;
    this.bondingCurve = keys.pubkey();
    this.feeRecipient = keys.pubkey();
    this.isMayhem = opts.is_mayhem_mode ?? false;
    this.isCashback = opts.is_cashback_enabled ?? false;
    this.initial = opts.initial ?? PUMP_INITIAL;
    this.fees = opts.fees ?? SYNTHETIC_FEES;
    this.state = { vq: this.initial.virtual_quote_reserves, vt: this.initial.virtual_token_reserves, rq: 0n, rt: this.initial.real_token_reserves };
  }

  private get sol(): boolean {
    return this.quoteMint === DEFAULT_PUBKEY;
  }

  /** Tokens bought from the curve and not yet sold back. */
  get outstanding(): bigint {
    return this.initial.real_token_reserves - this.state.rt;
  }

  private meta(slot: number, signature?: string) {
    return { slot, signature: signature ?? this.keys.signature(), block_time: blockTimeAt(this.clock, slot), chain_seq: this.records.length };
  }

  create(slot: number, signature?: string): CreateEventRecordT {
    if (this.records.length > 0) throw new Error('create must be the first record');
    const bt = blockTimeAt(this.clock, slot);
    const rec: CreateEventRecordT = {
      event: 'CreateEvent',
      name: 'Synthetic',
      symbol: 'SYN',
      uri: 'https://example.invalid/metadata.json',
      mint: this.mint,
      bonding_curve: this.bondingCurve,
      user: this.creator,
      creator: this.creator,
      timestamp: String(bt),
      virtual_token_reserves: this.initial.virtual_token_reserves.toString(),
      virtual_sol_reserves: this.sol ? this.initial.virtual_quote_reserves.toString() : '0',
      real_token_reserves: this.initial.real_token_reserves.toString(),
      token_total_supply: PUMP_INITIAL.token_total_supply.toString(),
      token_program: TOKEN_PROGRAM,
      is_mayhem_mode: this.isMayhem,
      is_cashback_enabled: this.isCashback,
      quote_mint: this.quoteMint,
      virtual_quote_reserves: this.initial.virtual_quote_reserves.toString(),
      creator_fee_bps: '0',
      is_holder_reward: false,
      depth: 0,
      ...this.meta(slot, signature),
    };
    this.records.push(rec);
    return rec;
  }

  private trade(slot: number, isBuy: boolean, q: bigint, t: bigint, fee: bigint, creatorFee: bigint, ixName: string, opts: TradeOptions): TradeEventRecordT {
    if (this.records.length === 0) throw new Error('create first');
    if (this.complete) throw new Error('the curve is complete');
    const post = applyTrade(this.state, { is_buy: isBuy, quote_amount: q.toString(), token_amount: t.toString() });
    const bt = blockTimeAt(this.clock, slot);
    const solOr0 = (v: bigint) => (this.sol ? v.toString() : '0');
    const rec: TradeEventRecordT = {
      event: 'TradeEvent',
      mint: this.mint,
      sol_amount: solOr0(q),
      token_amount: t.toString(),
      is_buy: isBuy,
      user: opts.user ?? this.keys.pubkey(),
      timestamp: String(bt),
      virtual_sol_reserves: solOr0(post.vq),
      virtual_token_reserves: post.vt.toString(),
      real_sol_reserves: solOr0(post.rq),
      real_token_reserves: post.rt.toString(),
      fee_recipient: this.feeRecipient,
      fee_basis_points: this.fees.protocol_bps.toString(),
      fee: fee.toString(),
      creator: this.creator,
      creator_fee_basis_points: this.fees.creator_bps.toString(),
      creator_fee: creatorFee.toString(),
      track_volume: false,
      total_unclaimed_tokens: '0',
      total_claimed_tokens: '0',
      current_sol_volume: '0',
      last_update_timestamp: '0',
      ix_name: ixName,
      mayhem_mode: this.isMayhem,
      cashback_fee_basis_points: '0',
      cashback: '0',
      buyback_fee_basis_points: this.fees.buyback_bps.toString(),
      buyback_fee: buybackOf(fee, this.fees.buyback_bps).toString(),
      shareholders: [],
      quote_mint: this.quoteMint,
      quote_amount: q.toString(),
      virtual_quote_reserves: post.vq.toString(),
      real_quote_reserves: post.rq.toString(),
      holder_rewards_bps: '0',
      holder_rewards: '0',
      creator_fee_unclaimed: '0',
      ...this.meta(slot, opts.signature),
    };
    this.records.push(rec);
    this.state = post;
    return rec;
  }

  /** The completing partial fill: exactly the remaining real tokens, then the CompleteEvent in the same tx. */
  private completingBuy(slot: number, ixName: string, opts: TradeOptions): TradeEventRecordT {
    const t = this.state.rt;
    const q = buyQuoteInForTokens(t, this.state);
    const signature = opts.signature ?? this.keys.signature();
    const rec = this.trade(slot, true, q, t, feeOf(q, this.fees.protocol_bps), feeOf(q, this.fees.creator_bps), ixName, { ...opts, signature });
    this.completeEvent(slot, signature, rec.user);
    return rec;
  }

  /** buy_exact_sol_in with `spendable` lamports, fees included. */
  buyExactIn(slot: number, spendable: bigint, opts: TradeOptions = {}): TradeEventRecordT {
    const split = exactInSplit(spendable, this.fees.protocol_bps, this.fees.creator_bps);
    const t = buyTokensOutForQuote(split.q, this.state);
    if (t >= this.state.rt) return this.completingBuy(slot, 'buy_exact_sol_in', opts);
    if (t === 0n) throw new Error('spendable buys no tokens');
    return this.trade(slot, true, split.q, t, split.fee, split.creatorFee, 'buy_exact_sol_in', opts);
  }

  /** buy (exact tokens out). */
  buyTokens(slot: number, tokens: bigint, opts: TradeOptions = {}): TradeEventRecordT {
    if (tokens >= this.state.rt) return this.completingBuy(slot, 'buy', opts);
    const q = buyQuoteInForTokens(tokens, this.state);
    return this.trade(slot, true, q, tokens, feeOf(q, this.fees.protocol_bps), feeOf(q, this.fees.creator_bps), 'buy', opts);
  }

  sell(slot: number, tokens: bigint, opts: TradeOptions = {}): TradeEventRecordT {
    if (tokens > this.outstanding) throw new Error('selling more than is outstanding');
    const q = sellQuoteOut(tokens, this.state);
    return this.trade(slot, false, q, tokens, feeOf(q, this.fees.protocol_bps), feeOf(q, this.fees.creator_bps), 'sell', opts);
  }

  private completeEvent(slot: number, signature: string, user: string): CompleteEventRecordT {
    const rec: CompleteEventRecordT = {
      event: 'CompleteEvent',
      user,
      mint: this.mint,
      bonding_curve: this.bondingCurve,
      timestamp: String(blockTimeAt(this.clock, slot)),
      quote_mint: this.quoteMint,
      ...this.meta(slot, signature),
    };
    this.records.push(rec);
    this.complete = true;
    return rec;
  }
}

const cmp = (a: ChainEventT, b: ChainEventT) => (a.slot !== b.slot ? a.slot - b.slot : a.mint !== b.mint ? (a.mint < b.mint ? -1 : 1) : a.chain_seq - b.chain_seq);

/** Every builder's records in one dataset, sorted by (slot, mint, chain_seq). */
export function assemble(builders: readonly CurveBuilder[]): ChainEventT[] {
  return builders.flatMap((b) => b.records).sort(cmp);
}

export type BreakKind =
  | 'reserve'
  | 'sol_quote'
  | 'missing_trade'
  | 'swap_order'
  | 'trade_after_complete'
  | 'duplicate_create'
  | 'quote_mint'
  | 'chain_seq'
  | 'formula';

/** A break to inject: `curve` indexes the generated curves, `trade` that curve's TradeEvents (1-based after the create's dev buy is 0). */
export interface BreakSpec {
  kind: BreakKind;
  curve: number;
  trade?: number;
}

/** Where an injected break landed and the chain issue it must raise there. */
export interface InjectedBreak extends BreakSpec {
  /** Mint of the record that carries the issue (for `order`, the record after the moved one). */
  mint: string;
  /** Index in the final dataset of the record that must carry the issue. */
  index: number;
  expect: 'reserve_mismatch' | 'sol_quote_mismatch' | 'chain_seq' | 'order' | 'after_complete' | 'duplicate_create' | 'quote_mint_mismatch' | 'formula';
}

export interface SyntheticOptions {
  seed: bigint;
  curves: number;
  /** TradeEvents per curve after the dev buy (fewer when the curve completes first). */
  tradesPerCurve: number;
  clock?: Clock;
  /** Slots over which creates are spread. */
  createSpread?: number;
  /** Largest slot gap between two trades of a curve (0 keeps them in one slot). */
  maxGap?: number;
  /** Curve indexes created mayhem-mode / cashback-enabled / quoted in USDC (outside the universe). */
  mayhem?: number[];
  cashback?: number[];
  nonSol?: number[];
  /** Curve indexes bought out to completion after their random trades. */
  completing?: number[];
  breaks?: BreakSpec[];
}

export interface SyntheticDataset {
  events: ChainEventT[];
  /** Mint of each curve index. */
  mints: string[];
  builders: CurveBuilder[];
  breaks: InjectedBreak[];
  clock: Clock;
}

export const DEFAULT_CLOCK: Clock = { slot0: 400_000_000, time0: 1_790_000_000 };

/** Many curves with random activity, chained exactly, plus the requested breaks. */
export function generateDataset(opts: SyntheticOptions): SyntheticDataset {
  const keys = new SyntheticKeys(opts.seed);
  const clock = opts.clock ?? DEFAULT_CLOCK;
  const spread = BigInt(opts.createSpread ?? 50);
  const maxGap = BigInt(opts.maxGap ?? 3);
  const has = (list: number[] | undefined, i: number) => (list ?? []).includes(i);
  const builders: CurveBuilder[] = [];
  for (let i = 0; i < opts.curves; i++) {
    const b = new CurveBuilder(keys, clock, {
      is_mayhem_mode: has(opts.mayhem, i),
      is_cashback_enabled: has(opts.cashback, i),
      quote_mint: has(opts.nonSol, i) ? USDC_MINT : DEFAULT_PUBKEY,
    });
    let slot = clock.slot0 + Number(keys.int(0n, spread));
    const sig = keys.signature();
    b.create(slot, sig);
    b.buyExactIn(slot, keys.int(100_000_000n, 2_000_000_000n), { signature: sig, user: b.creator });
    for (let k = 0; k < opts.tradesPerCurve && !b.complete; k++) {
      slot += Number(keys.int(0n, maxGap));
      const roll = keys.rng.below(10n);
      const out = b.outstanding;
      if (roll < 4n || out === 0n) b.buyExactIn(slot, keys.int(10_000_000n, 3_000_000_000n));
      else if (roll < 6n) b.buyTokens(slot, keys.int(1_000_000_000n, 30_000_000_000_000n));
      else b.sell(slot, (out * keys.int(1n, 30n)) / 100n || 1n);
    }
    if (has(opts.completing, i)) while (!b.complete) b.buyExactIn((slot += 1), 20_000_000_000n);
    builders.push(b);
  }
  let events = assemble(builders);
  const injected: InjectedBreak[] = [];
  for (const spec of opts.breaks ?? []) events = inject(events, builders, spec, keys, injected);
  return { events, mints: builders.map((b) => b.mint), builders, breaks: injected, clock };
}

const tradeAt = (events: ChainEventT[], mint: string, n: number): number => {
  let seen = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.mint === mint && e.event === 'TradeEvent' && ++seen === n) return i;
  }
  throw new Error(`curve ${mint} has no trade ${n}`);
};

const nextOfMint = (events: ChainEventT[], mint: string, from: number): number => {
  for (let i = from + 1; i < events.length; i++) if (events[i]!.mint === mint) return i;
  throw new Error(`no record of ${mint} after ${from}`);
};

const lastOfMint = (events: ChainEventT[], mint: string): number => {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.mint === mint) return i;
  throw new Error(`no record of ${mint}`);
};

function inject(events: ChainEventT[], builders: CurveBuilder[], spec: BreakSpec, keys: SyntheticKeys, out: InjectedBreak[]): ChainEventT[] {
  const b = builders[spec.curve];
  if (b === undefined) throw new Error(`no curve ${spec.curve}`);
  const mint = b.mint;
  const ev = events.slice();
  const n = spec.trade ?? 1;
  const note = (index: number, expect: InjectedBreak['expect']) => out.push({ ...spec, mint, index, expect });
  switch (spec.kind) {
    case 'reserve': {
      const i = tradeAt(ev, mint, n);
      const t = { ...(ev[i] as TradeEventRecordT) };
      const plus = (s: string) => (BigInt(s) + 1n).toString();
      t.virtual_quote_reserves = plus(t.virtual_quote_reserves);
      t.virtual_sol_reserves = t.virtual_quote_reserves;
      ev[i] = t;
      note(i, 'reserve_mismatch');
      return ev;
    }
    case 'sol_quote': {
      const i = tradeAt(ev, mint, n);
      const t = { ...(ev[i] as TradeEventRecordT) };
      t.real_sol_reserves = (BigInt(t.real_quote_reserves) + 1n).toString();
      ev[i] = t;
      note(i, 'sol_quote_mismatch');
      return ev;
    }
    case 'formula': {
      const i = tradeAt(ev, mint, n);
      const t = { ...(ev[i] as TradeEventRecordT) };
      t.fee = (BigInt(t.fee) + 7n).toString();
      t.buyback_fee = buybackOf(BigInt(t.fee), BigInt(t.buyback_fee_basis_points)).toString();
      ev[i] = t;
      note(i, 'formula');
      return ev;
    }
    case 'quote_mint': {
      const i = tradeAt(ev, mint, n);
      const t = { ...(ev[i] as TradeEventRecordT) };
      t.quote_mint = USDC_MINT;
      t.sol_amount = '0';
      t.virtual_sol_reserves = '0';
      t.real_sol_reserves = '0';
      ev[i] = t;
      note(i, 'quote_mint_mismatch');
      return ev;
    }
    case 'chain_seq': {
      const i = tradeAt(ev, mint, n);
      for (let j = i; j < ev.length; j++) if (ev[j]!.mint === mint) ev[j] = { ...ev[j]!, chain_seq: ev[j]!.chain_seq + 1 };
      note(i, 'chain_seq');
      return ev;
    }
    case 'missing_trade': {
      const i = tradeAt(ev, mint, n);
      const next = nextOfMint(ev, mint, i);
      ev.splice(i, 1);
      note(next - 1, 'chain_seq');
      note(next - 1, 'reserve_mismatch');
      return ev;
    }
    case 'swap_order': {
      const i = tradeAt(ev, mint, n);
      const next = nextOfMint(ev, mint, i);
      const a = ev[i]!;
      ev[i] = ev[next]!;
      ev[next] = a;
      // The later record now sits at i, so the record right after it (any mint) no longer follows it.
      out.push({ ...spec, mint: ev[i + 1]!.mint, index: i + 1, expect: 'order' });
      return ev;
    }
    case 'trade_after_complete': {
      if (!b.complete) throw new Error(`curve ${spec.curve} does not complete`);
      const last = ev[lastOfMint(ev, mint)]!;
      const tpl = ev[tradeAt(ev, mint, 0)] as TradeEventRecordT;
      const rec: TradeEventRecordT = { ...tpl, slot: last.slot + 1, signature: keys.signature(), chain_seq: last.chain_seq + 1, block_time: blockTimeAt(b.clock, last.slot + 1) };
      const at = ev.findIndex((e) => cmp(e, rec) > 0);
      const idx = at === -1 ? ev.length : at;
      ev.splice(idx, 0, rec);
      note(idx, 'after_complete');
      return ev;
    }
    case 'duplicate_create': {
      const last = ev[lastOfMint(ev, mint)]!;
      const create = ev.find((e) => e.mint === mint && e.event === 'CreateEvent') as CreateEventRecordT;
      const rec: CreateEventRecordT = { ...create, slot: last.slot + 1, signature: keys.signature(), chain_seq: last.chain_seq + 1, block_time: blockTimeAt(b.clock, last.slot + 1) };
      const at = ev.findIndex((e) => cmp(e, rec) > 0);
      const idx = at === -1 ? ev.length : at;
      ev.splice(idx, 0, rec);
      note(idx, 'duplicate_create');
      return ev;
    }
  }
}
