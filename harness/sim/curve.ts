// pump.fun bonding-curve math in BigInt: reserve transitions, curve outputs and fees, exactly as the
// program computes them. Every formula here was settled from mainnet (U1, 2026-10-26) by replaying
// 744/744 and 236/236 consecutive TradeEvents of two curves (tests/fixtures/sim/FORMULAS.txt, checked
// by tests/unit/sim-curve.test.ts against tests/fixtures/sim/trade-chain*.json). The collector's chain
// check uses applyTrade / preTradeState from here.
//
// q = quote_amount (== sol_amount on SOL curves), t = token_amount, (vq, vt, rq, rt) = PRE-trade
// virtual/real quote/token reserves. All divisions floor (BigInt `/` on non-negative operands).
//
//   Reserves (every variant: buy, buy_v2/v3, buy_exact_sol_in, buy_exact_quote_in_v2/v3, sell, sell_v2/v3):
//     buy : vq' = vq + q ; rq' = rq + q ; vt' = vt - t ; rt' = rt - t
//     sell: vq' = vq - q ; rq' = rq - q ; vt' = vt + t ; rt' = rt + t
//     No fee appears in any reserve delta; vq - rq and vt - rt are invariant along a chain.
//   Curve output
//     sell                          q = (t*vq) / (vt + t)                  floor
//     buy, exact tokens ('buy')     q = (t*vq) / (vt - t) + 1              floor + 1
//     buy, exact quote in           t = ((q-1)*vt) / (vq + q - 1)          floor, q-1; reserves still move by the full q
//     curve-completing buy          t = rt (cap), q = (t*vq)/(vt - t) + 1, fees on that q
//   Fees (paid ON TOP by the trader: a buy costs q + fee + creator_fee, a sell pays out q - fee - creator_fee)
//     fee            = ceil(q * fee_basis_points / 10000)           protocol, 95 bps
//     creator_fee    = ceil(q * creator_fee_basis_points / 10000)   30 bps
//     buyback_fee    = floor(fee * buyback_fee_basis_points / 10000)   a SHARE of the protocol fee, not extra
//     holder_rewards = holder_rewards_bps ? creator_fee : 0          a relabel of creator_fee, not extra
//   Exact-in buys (S = the spendable argument, fees included):
//     net0 = S*10000 / (10000 + fee_bps + creator_bps); fee = ceil(net0*fee_bps/1e4);
//     creator_fee = ceil(net0*creator_bps/1e4); q = net0 - max(0, net0 + fee + creator_fee - S)
//     (the overshoot is 0 or 1, so the fees sit on net0 and can be ceil(q*bps)+1 in rare cases)

import type { CreateEvent, TradeEvent } from '../contracts/events.ts';
import { isSolQuoted, solQuoteMismatches } from '../contracts/events.ts';

export const BPS = 10_000n;

/** A curve's virtual and real reserves (lamports for quote, base units for tokens). */
export interface CurveState {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
}

/** The fee rates a fill pays, in bps. */
export interface FeeBps {
  protocol: bigint;
  creator: bigint;
}

export class CurveDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurveDataError';
  }
}

export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export const sameState = (a: CurveState, b: CurveState): boolean => a.vq === b.vq && a.vt === b.vt && a.rq === b.rq && a.rt === b.rt;

export const stateToJson = (s: CurveState) => ({ vq: s.vq.toString(), vt: s.vt.toString(), rq: s.rq.toString(), rt: s.rt.toString() });

type TradeAmounts = Pick<TradeEvent, 'is_buy' | 'quote_amount' | 'token_amount'>;

/** Post-trade reserves from pre-trade reserves and a trade's amounts. */
export function applyTrade(pre: CurveState, ev: TradeAmounts): CurveState {
  const q = BigInt(ev.quote_amount);
  const t = BigInt(ev.token_amount);
  return ev.is_buy ? { vq: pre.vq + q, rq: pre.rq + q, vt: pre.vt - t, rt: pre.rt - t } : { vq: pre.vq - q, rq: pre.rq - q, vt: pre.vt + t, rt: pre.rt + t };
}

/** Pre-trade reserves derived from a trade's post-trade reserves and amounts (the inverse of applyTrade). */
export function preTradeState(post: CurveState, ev: TradeAmounts): CurveState {
  const q = BigInt(ev.quote_amount);
  const t = BigInt(ev.token_amount);
  return ev.is_buy ? { vq: post.vq - q, rq: post.rq - q, vt: post.vt + t, rt: post.rt + t } : { vq: post.vq + q, rq: post.rq + q, vt: post.vt - t, rt: post.rt - t };
}

/**
 * A TradeEvent's POST-trade reserves, read from the authoritative *_quote_* fields. Throws
 * CurveDataError when a legacy *_sol_* field disagrees with its *_quote_* twin (a data error).
 */
export function tradePostState(
  ev: Pick<
    TradeEvent,
    | 'quote_mint'
    | 'sol_amount'
    | 'quote_amount'
    | 'virtual_sol_reserves'
    | 'virtual_quote_reserves'
    | 'real_sol_reserves'
    | 'real_quote_reserves'
    | 'virtual_token_reserves'
    | 'real_token_reserves'
  >,
): CurveState {
  const bad = solQuoteMismatches(ev);
  if (bad.length > 0) throw new CurveDataError(`*_sol_* / *_quote_* mismatch: ${bad.join(', ')}`);
  return {
    vq: BigInt(ev.virtual_quote_reserves),
    vt: BigInt(ev.virtual_token_reserves),
    rq: BigInt(ev.real_quote_reserves),
    rt: BigInt(ev.real_token_reserves),
  };
}

/**
 * A curve's initial reserves from its CreateEvent: virtual token and quote reserves and real token
 * reserves as reported (never the 30 SOL / 1.073e15 defaults), real quote reserves 0. Like the trade
 * fields, virtual_sol_reserves must equal virtual_quote_reserves on a SOL curve and be 0 on any other.
 */
export function createState(
  ev: Pick<CreateEvent, 'quote_mint' | 'virtual_token_reserves' | 'virtual_quote_reserves' | 'virtual_sol_reserves' | 'real_token_reserves'>,
): CurveState {
  const expectSol = isSolQuoted(ev.quote_mint) ? ev.virtual_quote_reserves : '0';
  if (ev.virtual_sol_reserves !== expectSol) {
    throw new CurveDataError(`CreateEvent virtual_sol_reserves ${ev.virtual_sol_reserves} != ${expectSol} (quote_mint ${ev.quote_mint})`);
  }
  return { vq: BigInt(ev.virtual_quote_reserves), vt: BigInt(ev.virtual_token_reserves), rq: 0n, rt: BigInt(ev.real_token_reserves) };
}

/** Sell t tokens: quote out before fees, floor(t*vq/(vt+t)). */
export const sellQuoteOut = (t: bigint, s: CurveState): bigint => (t * s.vq) / (s.vt + t);

/** Buy exactly t tokens (ix `buy`): quote in before fees, floor(t*vq/(vt-t)) + 1. Requires t < vt. */
export const buyQuoteInForTokens = (t: bigint, s: CurveState): bigint => (t * s.vq) / (s.vt - t) + 1n;

/** Buy for exactly q quote (ix `buy_exact_sol_in` / `buy_exact_quote_in`): tokens out, floor((q-1)*vt/(vq+q-1)). */
export const buyTokensOutForQuote = (q: bigint, s: CurveState): bigint => (q <= 1n ? 0n : ((q - 1n) * s.vt) / (s.vq + q - 1n));

/** fee, creator_fee: ceil(amount * bps / 10000). */
export const feeOf = (amount: bigint, bps: bigint): bigint => ceilDiv(amount * bps, BPS);

/** buyback_fee: floor(fee * bps / 10000), a share of the protocol fee. */
export const buybackOf = (fee: bigint, bps: bigint): bigint => (fee * bps) / BPS;

/** holder_rewards: the creator fee relabelled on holder-reward coins, never an extra charge. */
export const holderRewardsOf = (creatorFee: bigint, holderBps: bigint): bigint => (holderBps > 0n ? creatorFee : 0n);

/** How an exact-in buy splits the spendable amount S into curve quote q and fees. */
export function exactInSplit(spendable: bigint, feeBps: bigint, creatorBps: bigint): { q: bigint; fee: bigint; creatorFee: bigint; over: bigint } {
  const net0 = (spendable * BPS) / (BPS + feeBps + creatorBps);
  const fee = feeOf(net0, feeBps);
  const creatorFee = feeOf(net0, creatorBps);
  const over = net0 + fee + creatorFee > spendable ? net0 + fee + creatorFee - spendable : 0n;
  return { q: net0 - over, fee, creatorFee, over };
}

export interface BuyQuote {
  /** Curve quote: what the reserves move by. */
  q: bigint;
  /** Tokens out. */
  t: bigint;
  fee: bigint;
  creatorFee: bigint;
  /** What the buyer pays: q + fee + creatorFee (never more than the spendable amount). */
  paid: bigint;
  /** The buy hit real_token_reserves and was cut to them (the curve-completing partial fill). */
  capped: boolean;
}

/**
 * An exact-in buy of `spendable` lamports (fees included) against reserves `s`, as the program fills
 * buy_exact_sol_in: split, tokens out for q, and the completion cap when t would exceed rt (then
 * t = rt and q, fees are recomputed for exactly those tokens).
 */
export function quoteBuyExactIn(spendable: bigint, s: CurveState, bps: FeeBps): BuyQuote {
  const split = exactInSplit(spendable, bps.protocol, bps.creator);
  const t = buyTokensOutForQuote(split.q, s);
  if (t > s.rt) {
    const tc = s.rt;
    if (tc === 0n) return { q: 0n, t: 0n, fee: 0n, creatorFee: 0n, paid: 0n, capped: true };
    const q = buyQuoteInForTokens(tc, s);
    const fee = feeOf(q, bps.protocol);
    const creatorFee = feeOf(q, bps.creator);
    return { q, t: tc, fee, creatorFee, paid: q + fee + creatorFee, capped: true };
  }
  return { q: split.q, t, fee: split.fee, creatorFee: split.creatorFee, paid: split.q + split.fee + split.creatorFee, capped: false };
}

export interface SellQuote {
  /** Curve quote out: what the reserves move by. */
  q: bigint;
  fee: bigint;
  creatorFee: bigint;
  /** What the seller receives: q - fee - creatorFee (negative when the fees exceed q). */
  proceeds: bigint;
}

/** A sell of t tokens against reserves `s`. */
export function quoteSell(t: bigint, s: CurveState, bps: FeeBps): SellQuote {
  const q = sellQuoteOut(t, s);
  const fee = feeOf(q, bps.protocol);
  const creatorFee = feeOf(q, bps.creator);
  return { q, fee, creatorFee, proceeds: q - fee - creatorFee };
}

/** The ix_name values whose amounts follow the exact-quote-in formula. */
export const EXACT_IN_IX_NAMES = new Set(['buy_exact_sol_in', 'buy_exact_quote_in']);

/**
 * Formula consistency of one recorded trade against its pre-trade reserves: the curve output for its
 * ix_name and its fee, creator fee, buyback and holder-reward amounts. Returns readable issues
 * (empty when consistent). Exact-in buys carry fees on net0, which the event does not report, so
 * their fees are checked against q and q + 1 (the overshoot is 0 or 1).
 */
export function tradeFormulaIssues(
  pre: CurveState,
  ev: Pick<
    TradeEvent,
    | 'is_buy'
    | 'ix_name'
    | 'quote_amount'
    | 'token_amount'
    | 'real_token_reserves'
    | 'fee_basis_points'
    | 'fee'
    | 'creator_fee_basis_points'
    | 'creator_fee'
    | 'buyback_fee_basis_points'
    | 'buyback_fee'
    | 'holder_rewards_bps'
    | 'holder_rewards'
  >,
): string[] {
  const issues: string[] = [];
  const q = BigInt(ev.quote_amount);
  const t = BigInt(ev.token_amount);
  const fb = BigInt(ev.fee_basis_points);
  const cb = BigInt(ev.creator_fee_basis_points);
  const fee = BigInt(ev.fee);
  const cf = BigInt(ev.creator_fee);
  let exactIn = false;
  if (!ev.is_buy) {
    if (q !== sellQuoteOut(t, pre)) issues.push(`sell quote ${q} != floor(t*vq/(vt+t)) ${sellQuoteOut(t, pre)}`);
  } else if (ev.real_token_reserves === '0' && t === pre.rt) {
    // The curve-completing buy: cut to the remaining real tokens, priced as an exact-tokens buy.
    if (q !== buyQuoteInForTokens(t, pre)) issues.push(`completing buy quote ${q} != floor(t*vq/(vt-t))+1 ${buyQuoteInForTokens(t, pre)}`);
  } else if (EXACT_IN_IX_NAMES.has(ev.ix_name)) {
    exactIn = true;
    if (t !== buyTokensOutForQuote(q, pre)) issues.push(`exact-in tokens ${t} != floor((q-1)*vt/(vq+q-1)) ${buyTokensOutForQuote(q, pre)}`);
  } else if (q !== buyQuoteInForTokens(t, pre)) {
    issues.push(`buy quote ${q} != floor(t*vq/(vt-t))+1 ${buyQuoteInForTokens(t, pre)}`);
  }
  const feeOk = (actual: bigint, bps: bigint) => actual === feeOf(q, bps) || (exactIn && actual === feeOf(q + 1n, bps));
  if (!feeOk(fee, fb)) issues.push(`fee ${fee} != ceil(q*${fb}/1e4) ${feeOf(q, fb)}`);
  if (!feeOk(cf, cb)) issues.push(`creator_fee ${cf} != ceil(q*${cb}/1e4) ${feeOf(q, cb)}`);
  const bb = buybackOf(fee, BigInt(ev.buyback_fee_basis_points));
  if (BigInt(ev.buyback_fee) !== bb) issues.push(`buyback_fee ${ev.buyback_fee} != floor(fee*bps/1e4) ${bb}`);
  const hr = holderRewardsOf(cf, BigInt(ev.holder_rewards_bps));
  if (BigInt(ev.holder_rewards) !== hr) issues.push(`holder_rewards ${ev.holder_rewards} != ${hr}`);
  return issues;
}
