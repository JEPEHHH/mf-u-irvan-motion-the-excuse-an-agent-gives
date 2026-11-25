// Seeded randomness for the sim: SplitMix64 (Steele, Lea, Flood 2014; the generator Vigna recommends
// for seeding), in BigInt so every platform draws the same u64 stream. Two uses:
//   - failed transactions: one independent draw per order, keyed by (fail key, batch seq, order
//     index), so a rescore with different fees, or an earlier order resolving differently, never
//     shifts which orders fail. The fail key is NOT hello.seed: the engine takes it separately
//     (EngineOptions.failKey) and never sends it to the bot. The dev phase's is public
//     (publicFailKey of the phase seed, so a kit reproduces dev grading); the final phase's is
//     derived from a server secret (grader/worker.ts failKeyFor) and cannot be computed from
//     anything the bot is sent.
//   - the bootstrap interval: one stream per phase seed (hello.seed, the same for every entry of a
//     phase), so every entry of a phase draws the same resample indices

const MASK = (1n << 64n) - 1n;
const GAMMA = 0x9e3779b97f4a7c15n;
const U64_DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

/** The SplitMix64 output function applied to a state. */
export function mix64(z0: bigint): bigint {
  let z = z0 & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return z ^ (z >> 31n);
}

/** A SplitMix64 stream: state += gamma, output mix64(state). */
export class SplitMix64 {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed & MASK;
  }

  /** The next u64. */
  next(): bigint {
    this.state = (this.state + GAMMA) & MASK;
    return mix64(this.state);
  }

  /** A draw in [0, n) (n >= 1). Plain modulo: the bias is below n / 2^64. */
  below(n: bigint): bigint {
    if (n < 1n) throw new RangeError('below(n) needs n >= 1');
    return this.next() % n;
  }
}

/** Stream domains, so the failure draws, the public fail key and the bootstrap never share a stream. */
export const RNG_DOMAIN = {
  failedTx: 0x6661696c65642d74n, // "failed-t"
  bootstrap: 0x626f6f7473747270n, // "bootstrp"
  publicFailKey: 0x6661696c2d6b6579n, // "fail-key"
} as const;

/** One u64 keyed by a seed and a list of non-negative integers, each folded in through mix64. */
export function keyedU64(seed: bigint, ...parts: bigint[]): bigint {
  let h = mix64((seed + GAMMA) & MASK);
  for (const p of parts) h = mix64((h ^ (p & MASK)) + GAMMA);
  return h;
}

/** A u64 decimal string (a seed or a fail key) as a BigInt; throws on anything else. */
export function parseU64(value: string, what: string): bigint {
  if (!U64_DECIMAL.test(value) || BigInt(value) > MASK) throw new RangeError(`${what} ${JSON.stringify(value)} is not a u64 decimal`);
  return BigInt(value);
}

/**
 * The public fail key of a phase seed (u64 decimal): what the dev phase's failure draw is keyed by,
 * and the engine's default. Anyone holding the seed (the kit, the bot's hello) can compute it, which
 * is the point on dev and why the final phase never uses it.
 */
export function publicFailKey(seed: string): string {
  return keyedU64(parseU64(seed, 'seed'), RNG_DOMAIN.publicFailKey).toString();
}

/** Whether the order at (seq, index) of a run with this fail key lands in the failed-tx share (bps). */
export function txFails(failKey: bigint, seq: number, index: number, failedBps: number): boolean {
  if (failedBps <= 0) return false;
  return keyedU64(failKey, RNG_DOMAIN.failedTx, BigInt(seq), BigInt(index)) % 10_000n < BigInt(failedBps);
}
