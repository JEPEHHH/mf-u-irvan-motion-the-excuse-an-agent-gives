// Concentrated-liquidity position math for the clmm-replay harness, in BigInt only
// (.cosmos/rules/grading.mdc). A position is a liquidity L over a half-open tick range [lower, upper)
// of one recorded pool. The functions here give its tokens and value at any sqrt price and the fees
// one sample interval credits it. The engine (sim/clmm/engine.ts) composes them; nothing here holds
// state.
//
// Prices. A sqrt price is Q64.64: sqrt_price_x64 = sqrt(price) x 2^64, where price is token B per
// token A in raw units (B per A, base units; for SOL/USDC, USDC micro-units per lamport). Tick t is
// the price 1.0001^t. The tick <-> sqrt price maps are Orca Whirlpool's, bit for bit:
// orca-so/whirlpools programs/whirlpool/src/math/tick_math.rs at
// ebf9e96f474b41bec46d388c812eaad4fbacca00 (sqrt_price_from_tick_index :23,
// tick_index_from_sqrt_price :39, the positive/negative tick constants :103/:168). Ticks run over
// [MIN_TICK_INDEX, MAX_TICK_INDEX] (programs/whirlpool/src/state/tick.rs :6-7) and sqrt prices over
// [MIN_SQRT_PRICE_X64, MAX_SQRT_PRICE_X64]; anything outside is refused with a RangeError.
//
// Tokens. With sL = sqrtPriceAtTick(lower), sU = sqrtPriceAtTick(upper) and the price clamped into
// the range, c = min(max(s, sL), sU):
//     a = L x (sU - c) x 2^64 / (sU x c)        (Whirlpool get_amount_delta_a, token_math.rs :84)
//     b = L x (c - sL) / 2^64                   (get_amount_delta_b, token_math.rs :142)
// Minting rounds both up (the pool takes at least the exact amounts), withdrawing rounds both down,
// as calculate_liquidity_token_deltas (manager/liquidity_manager.rs :192) does at
// e5f089bc5c49b01f5c8abb43c78457ab6c440568. Clamping the price is the same as Whirlpool's
// three-way branch on the current tick. Below the range the position is all A, and at or above it
// it is all B. At s = sL and s = sU the in-range formula gives exactly the out-of-range amounts, so
// a position's tokens, and its value, have no jump at the range edges.
//
// Liquidity. The most liquidity some amounts buy at a sqrt price is Whirlpool's
// estimate_max_liquidity_from_token_amounts (token_math.rs :355-404):
//     L_a = floor(a x lo x hi / ((hi - lo) x 2^64)),  L_b = floor(b x 2^64 / (hi - lo)),
// over [c, sU] for A and [sL, c] for B. It takes L_a below the range, L_b at or above it, and the
// smaller of the two inside. (Orca floors twice; floor(floor(x/m)/n) = floor(x/(mn)), so one floor
// is the same number.) Minting that L never needs more of either token than was offered: amounts
// -> L -> amounts never grows. One unit more liquidity always would need more.
//
// Value. A position's value in the quote token at a sqrt price is its withdrawable (round-down)
// amounts priced at that sqrt price: quote B: b + floor(a x s^2 / 2^128), quote A: a +
// floor(b x 2^128 / s^2). The price is the one its amounts were computed at, so a replay values a
// position at a sample's own sqrt_price_x64.
//
// Fees. A pool's fee growth (fee_growth_global_a/b) is Q64.64 fees per unit of in-range liquidity
// and wraps at 2^128 (Orca's counter is wrapping), so a delta is (after - before) mod 2^128. The
// recorded pool never held this harness's position. Had it held L_pos, the same fees would have
// been split over L_pool + L_pos, so for one sample interval and per token:
//     credit = floor(dfg x L_pos x L_pool / ((L_pool + L_pos) x 2^64))
// That is credited only when the interval is at most MAX_FEE_INTERVAL_MS and the recorded tick at
// both ends lies in [lower, upper). While the price stays inside the range, the growth inside the
// range moves exactly as the global growth does, so that credit is exact. An excursion out and back
// between two samples is credited as if it had stayed in range; that is the model's stated limit,
// and the harness's minimum range width bounds it (tick arrays are not recorded). The pool's
// liquidity can change inside an interval, as the price crosses other positions' ticks, and only the
// endpoints are recorded. L_pool is the liquidity at the interval's first sample r0 (`from`), never
// the second's nor the smaller of the two: that is the contract's rule (contracts/clmm-protocol.ts,
// "Market model", Fees: "L_pool r0's liquidity"), and sim/clmm/engine.ts credits by it, so this
// function and the replay give the same fees for the same interval. Since L_pos / (L_pool + L_pos)
// <= 1, the credit never exceeds the fees r0's liquidity earned (dfg x L_pool / 2^64).
//
// BigInt has no overflow, so where Whirlpool would refuse a result past u64 (a token amount) or u128
// (a liquidity) these functions return the exact number; the harness's capital is far below either.

/** 2^64: one in Q64.64. */
export const Q64 = 1n << 64n;
/** 2^128: the modulus a u128 fee-growth counter wraps at. */
export const U128_MODULUS = 1n << 128n;

/** Whirlpool's tick bounds (programs/whirlpool/src/state/tick.rs). */
export const MIN_TICK_INDEX = -443636;
export const MAX_TICK_INDEX = 443636;
/** The sqrt prices of MIN_TICK_INDEX and MAX_TICK_INDEX (tick_math.rs :5-6). */
export const MIN_SQRT_PRICE_X64 = 4295048016n;
export const MAX_SQRT_PRICE_X64 = 79226673515401279992447579055n;

/** The longest sample interval (ms) that is credited fees: a longer gap credits nothing. */
export const MAX_FEE_INTERVAL_MS = 30_000;

/** A position's tick range [lower, upper): lower inclusive, upper exclusive. */
export interface TickRange {
  lower: number;
  upper: number;
}

/** Raw token amounts in the pool's own order (A/B for a Whirlpool, 0/1 for a Raydium CLMM). */
export interface TokenAmounts {
  a: bigint;
  b: bigint;
}

/** Which token a value is expressed in. */
export type QuoteSide = 'a' | 'b';

/** One recorded pool sample, as far as fee accrual reads it. */
export interface FeeGrowthSample {
  /** ms since the Unix epoch */
  ts: number;
  /** the pool's current tick index (tick_current_index), as recorded */
  tick: number;
  /** the pool's in-range liquidity (u128) */
  liquidity: bigint;
  /** fee_growth_global [a, b], Q64.64 per unit of liquidity (u128, wrapping) */
  feeGrowth: readonly [bigint, bigint];
}

// --- validation -----------------------------------------------------------------------------

function checkTick(tick: number, what = 'tick'): void {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK_INDEX || tick > MAX_TICK_INDEX) {
    throw new RangeError(`${what} ${tick} is not an integer in [${MIN_TICK_INDEX}, ${MAX_TICK_INDEX}]`);
  }
}

function checkSqrtPrice(sqrtPriceX64: bigint): void {
  if (sqrtPriceX64 < MIN_SQRT_PRICE_X64 || sqrtPriceX64 > MAX_SQRT_PRICE_X64) {
    throw new RangeError(`sqrt price ${sqrtPriceX64} is outside [${MIN_SQRT_PRICE_X64}, ${MAX_SQRT_PRICE_X64}]`);
  }
}

function checkNonNegative(v: bigint, what: string): void {
  if (v < 0n) throw new RangeError(`${what} ${v} is negative`);
}

function checkU128(v: bigint, what: string): void {
  if (v < 0n || v >= U128_MODULUS) throw new RangeError(`${what} ${v} is not a u128`);
}

/** Throws unless the range is two valid ticks with lower < upper. */
export function checkRange(range: TickRange): void {
  checkTick(range.lower, 'lower tick');
  checkTick(range.upper, 'upper tick');
  if (range.lower >= range.upper) throw new RangeError(`range [${range.lower}, ${range.upper}) is empty`);
}

/** Whether a tick lies in the half-open range [lower, upper). */
export function tickInRange(tick: number, range: TickRange): boolean {
  return range.lower <= tick && tick < range.upper;
}

// --- tick math (Whirlpool tick_math.rs, bit for bit) ----------------------------------------

// Positive ticks: ratio starts at sqrt(1.0001) x 2^96 (bit 0 set) or 2^96, and each further set bit
// k of the tick multiplies by sqrt(1.0001)^(2^k) x 2^96 and shifts right 96; the result is >> 32.
const POSITIVE_BIT0_X96 = 79232123823359799118286999567n;
const POSITIVE_FACTORS_X96: readonly bigint[] = [
  79236085330515764027303304731n, // 2
  79244008939048815603706035061n, // 4
  79259858533276714757314932305n, // 8
  79291567232598584799939703904n, // 16
  79355022692464371645785046466n, // 32
  79482085999252804386437311141n, // 64
  79736823300114093921829183326n, // 128
  80248749790819932309965073892n, // 256
  81282483887344747381513967011n, // 512
  83390072131320151908154831281n, // 1024
  87770609709833776024991924138n, // 2048
  97234110755111693312479820773n, // 4096
  119332217159966728226237229890n, // 8192
  179736315981702064433883588727n, // 16384
  407748233172238350107850275304n, // 32768
  2098478828474011932436660412517n, // 65536
  55581415166113811149459800483533n, // 131072
  38992368544603139932233054999993551n, // 262144
];

// Negative ticks: ratio starts at 1/sqrt(1.0001) x 2^64 (bit 0 set) or 2^64, and each further set
// bit k of |tick| multiplies by sqrt(1.0001)^-(2^k) x 2^64 and shifts right 64.
const NEGATIVE_BIT0_X64 = 18445821805675392311n;
const NEGATIVE_FACTORS_X64: readonly bigint[] = [
  18444899583751176498n, // 2
  18443055278223354162n, // 4
  18439367220385604838n, // 8
  18431993317065449817n, // 16
  18417254355718160513n, // 32
  18387811781193591352n, // 64
  18329067761203520168n, // 128
  18212142134806087854n, // 256
  17980523815641551639n, // 512
  17526086738831147013n, // 1024
  16651378430235024244n, // 2048
  15030750278693429944n, // 4096
  12247334978882834399n, // 8192
  8131365268884726200n, // 16384
  3584323654723342297n, // 32768
  696457651847595233n, // 65536
  26294789957452057n, // 131072
  37481735321082n, // 262144
];

/** The sqrt price (Q64.64) at a tick: Whirlpool's sqrt_price_from_tick_index, exactly. */
export function sqrtPriceAtTick(tick: number): bigint {
  checkTick(tick);
  if (tick >= 0) {
    let ratio = tick & 1 ? POSITIVE_BIT0_X96 : 1n << 96n;
    POSITIVE_FACTORS_X96.forEach((f, i) => {
      if (tick & (2 << i)) ratio = (ratio * f) >> 96n;
    });
    return ratio >> 32n;
  }
  const abs = -tick;
  let ratio = abs & 1 ? NEGATIVE_BIT0_X64 : Q64;
  NEGATIVE_FACTORS_X64.forEach((f, i) => {
    if (abs & (2 << i)) ratio = (ratio * f) >> 64n;
  });
  return ratio;
}

const LOG_B_2_X32 = 59543866431248n;
const BIT_PRECISION = 14;
const LOG_B_P_ERR_MARGIN_LOWER_X64 = 184467440737095516n; // 0.01
const LOG_B_P_ERR_MARGIN_UPPER_X64 = 15793534762490258745n; // 2^-precision / log_2_b + 0.01

/**
 * The tick of a sqrt price: the largest tick t with sqrtPriceAtTick(t) <= sqrtPriceX64
 * (Whirlpool's tick_index_from_sqrt_price, exactly).
 */
export function tickAtSqrtPrice(sqrtPriceX64: bigint): number {
  checkSqrtPrice(sqrtPriceX64);
  // log2 of the sqrt price: the integer part from the most significant bit, then BIT_PRECISION
  // fractional bits by repeated squaring of the mantissa r in [1, 2) as Q1.63.
  const msb = sqrtPriceX64.toString(2).length - 1;
  const log2pIntegerX32 = BigInt(msb - 64) << 32n;
  let r = msb >= 64 ? sqrtPriceX64 >> BigInt(msb - 63) : sqrtPriceX64 << BigInt(63 - msb);
  let bit = 0x8000_0000_0000_0000n;
  let log2pFractionX64 = 0n;
  for (let precision = 0; bit > 0n && precision < BIT_PRECISION; precision++) {
    r *= r;
    const isRMoreThanTwo = r >> 127n;
    r >>= 63n + isRMoreThanTwo;
    log2pFractionX64 += bit * isRMoreThanTwo;
    bit >>= 1n;
  }
  const log2pX32 = log2pIntegerX32 + (log2pFractionX64 >> 32n);
  // base 2 to base sqrt(1.0001); BigInt >> floors like Rust's arithmetic shift on i128
  const logbpX64 = log2pX32 * LOG_B_2_X32;
  const tickLow = Number((logbpX64 - LOG_B_P_ERR_MARGIN_LOWER_X64) >> 64n);
  const tickHigh = Number((logbpX64 + LOG_B_P_ERR_MARGIN_UPPER_X64) >> 64n);
  if (tickLow === tickHigh) return tickLow;
  return sqrtPriceAtTick(tickHigh) <= sqrtPriceX64 ? tickHigh : tickLow;
}

// --- token amounts and liquidity --------------------------------------------------------------

const ordered = (s0: bigint, s1: bigint): [bigint, bigint] => (s0 > s1 ? [s1, s0] : [s0, s1]);

/** Token A for liquidity L between two sqrt prices: L x |s1 - s0| x 2^64 / (s0 x s1), floored or rounded up. */
export function amountDeltaA(sqrtPrice0X64: bigint, sqrtPrice1X64: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = ordered(sqrtPrice0X64, sqrtPrice1X64);
  if (lo <= 0n) throw new RangeError(`sqrt price ${lo} is not positive`);
  checkNonNegative(liquidity, 'liquidity');
  const numerator = (liquidity * (hi - lo)) << 64n;
  const denominator = hi * lo;
  const q = numerator / denominator;
  return roundUp && q * denominator !== numerator ? q + 1n : q;
}

/** Token B for liquidity L between two sqrt prices: L x |s1 - s0| / 2^64, floored or rounded up. */
export function amountDeltaB(sqrtPrice0X64: bigint, sqrtPrice1X64: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = ordered(sqrtPrice0X64, sqrtPrice1X64);
  if (lo <= 0n) throw new RangeError(`sqrt price ${lo} is not positive`);
  checkNonNegative(liquidity, 'liquidity');
  const p = liquidity * (hi - lo);
  const q = p >> 64n;
  return roundUp && (p & (Q64 - 1n)) !== 0n ? q + 1n : q;
}

/** The range's two sqrt prices and the price clamped into them. */
function rangePrices(sqrtPriceX64: bigint, range: TickRange): { sL: bigint; sU: bigint; c: bigint } {
  checkRange(range);
  checkSqrtPrice(sqrtPriceX64);
  const sL = sqrtPriceAtTick(range.lower);
  const sU = sqrtPriceAtTick(range.upper);
  const c = sqrtPriceX64 < sL ? sL : sqrtPriceX64 > sU ? sU : sqrtPriceX64;
  return { sL, sU, c };
}

/**
 * The tokens a liquidity holds in [lower, upper) at a sqrt price. roundUp: what minting it takes
 * (each side rounded up); otherwise what withdrawing it returns (each side floored).
 */
export function amountsForLiquidity(liquidity: bigint, sqrtPriceX64: bigint, range: TickRange, roundUp: boolean): TokenAmounts {
  checkNonNegative(liquidity, 'liquidity');
  const { sL, sU, c } = rangePrices(sqrtPriceX64, range);
  return { a: amountDeltaA(c, sU, liquidity, roundUp), b: amountDeltaB(sL, c, liquidity, roundUp) };
}

const liquidityForA = (lo: bigint, hi: bigint, a: bigint): bigint => (a * lo * hi) / ((hi - lo) << 64n);
const liquidityForB = (lo: bigint, hi: bigint, b: bigint): bigint => (b << 64n) / (hi - lo);

/**
 * The most liquidity some token amounts buy in [lower, upper) at a sqrt price (Whirlpool's
 * estimate_max_liquidity_from_token_amounts). amountsForLiquidity(result, s, range, true) never
 * exceeds the amounts on either side, and result + 1 would on at least one.
 */
export function liquidityForAmounts(sqrtPriceX64: bigint, range: TickRange, amounts: TokenAmounts): bigint {
  checkNonNegative(amounts.a, 'amount a');
  checkNonNegative(amounts.b, 'amount b');
  const { sL, sU, c } = rangePrices(sqrtPriceX64, range);
  if (c === sL) return liquidityForA(sL, sU, amounts.a);
  if (c === sU) return liquidityForB(sL, sU, amounts.b);
  const la = liquidityForA(c, sU, amounts.a);
  const lb = liquidityForB(sL, c, amounts.b);
  return la < lb ? la : lb;
}

// --- value --------------------------------------------------------------------------------------

/** Token amounts valued in one of the two tokens at a sqrt price, floored. */
export function amountsValue(amounts: TokenAmounts, sqrtPriceX64: bigint, quote: QuoteSide): bigint {
  checkSqrtPrice(sqrtPriceX64);
  checkNonNegative(amounts.a, 'amount a');
  checkNonNegative(amounts.b, 'amount b');
  const p2 = sqrtPriceX64 * sqrtPriceX64;
  return quote === 'b' ? amounts.b + ((amounts.a * p2) >> 128n) : amounts.a + (amounts.b << 128n) / p2;
}

/**
 * A position's value in the quote token (USDC for SOL/USDC, where USDC is token B) at a sqrt
 * price: what withdrawing it there returns, priced there.
 */
export function positionValue(liquidity: bigint, sqrtPriceX64: bigint, range: TickRange, quote: QuoteSide): bigint {
  return amountsValue(amountsForLiquidity(liquidity, sqrtPriceX64, range, false), sqrtPriceX64, quote);
}

// --- fees ---------------------------------------------------------------------------------------

/** A u128 fee-growth counter's movement from before to after: (after - before) mod 2^128. */
export function feeGrowthDelta(before: bigint, after: bigint): bigint {
  checkU128(before, 'fee growth');
  checkU128(after, 'fee growth');
  return (((after - before) % U128_MODULUS) + U128_MODULUS) % U128_MODULUS;
}

/**
 * The fees (raw token units) a position of positionLiquidity earns from a fee-growth movement of
 * deltaFeeGrowthX64 had it sat beside poolLiquidity: floor(dfg x L_pos x L_pool / ((L_pool + L_pos) x 2^64)).
 */
export function feeCredit(deltaFeeGrowthX64: bigint, positionLiquidity: bigint, poolLiquidity: bigint): bigint {
  checkNonNegative(deltaFeeGrowthX64, 'fee growth delta');
  checkNonNegative(positionLiquidity, 'position liquidity');
  checkNonNegative(poolLiquidity, 'pool liquidity');
  const denominator = (poolLiquidity + positionLiquidity) << 64n;
  if (denominator === 0n) return 0n;
  return (deltaFeeGrowthX64 * positionLiquidity * poolLiquidity) / denominator;
}

/**
 * The fees one sample interval (from = r0, to = r1) credits a position, per token:
 * feeCredit(feeGrowthDelta(r0, r1), positionLiquidity, r0.liquidity). Zero unless the interval is at
 * most MAX_FEE_INTERVAL_MS and both samples' ticks are in [lower, upper). L_pool is r0's liquidity
 * alone, as contracts/clmm-protocol.ts's market model says and sim/clmm/engine.ts credits; to's
 * liquidity is validated but never moves the credit.
 */
export function intervalFeeCredit(from: FeeGrowthSample, to: FeeGrowthSample, range: TickRange, positionLiquidity: bigint): TokenAmounts {
  checkRange(range);
  checkNonNegative(positionLiquidity, 'position liquidity');
  for (const s of [from, to]) {
    if (!Number.isSafeInteger(s.ts)) throw new RangeError(`sample ts ${s.ts} is not an integer`);
    checkTick(s.tick, 'sample tick');
    checkU128(s.liquidity, 'pool liquidity');
  }
  if (to.ts <= from.ts) throw new RangeError(`sample interval ${from.ts} -> ${to.ts} does not move forward`);
  const dA = feeGrowthDelta(from.feeGrowth[0], to.feeGrowth[0]);
  const dB = feeGrowthDelta(from.feeGrowth[1], to.feeGrowth[1]);
  if (to.ts - from.ts > MAX_FEE_INTERVAL_MS || !tickInRange(from.tick, range) || !tickInRange(to.tick, range)) return { a: 0n, b: 0n };
  return { a: feeCredit(dA, positionLiquidity, from.liquidity), b: feeCredit(dB, positionLiquidity, from.liquidity) };
}
