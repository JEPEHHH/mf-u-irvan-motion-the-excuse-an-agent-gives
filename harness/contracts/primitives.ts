// Wire primitives every contract shares. Integers that can exceed 2^53 (u64/i64 chain values,
// lamports, micro-USD) travel as canonical decimal strings and are read with BigInt; ratios travel
// as Fixed9 strings (exactly nine fractional digits, i.e. a BigInt scaled by 1e9), so a score JSON
// is byte-stable across machines. Browser-safe: zod only, no Node APIs.

import { z } from 'zod';

export const U64_MAX = 18446744073709551615n;
export const I64_MIN = -9223372036854775808n;
export const I64_MAX = 9223372036854775807n;
export const FIXED9_SCALE = 1_000_000_000n;

// The pattern aborts: zod would otherwise run the BigInt range check on a string that failed it, and
// BigInt("1.5") throws instead of reporting.

/** u64 as a canonical decimal string (no sign, no leading zeros). */
export const U64 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/, { error: 'expected a u64 decimal string', abort: true })
  .refine((s) => BigInt(s) <= U64_MAX, 'exceeds u64');

/** i64 as a canonical decimal string (no `+`, no `-0`, no leading zeros). */
export const I64 = z
  .string()
  .regex(/^(0|-?[1-9][0-9]{0,18})$/, { error: 'expected an i64 decimal string', abort: true })
  .refine((s) => {
    const n = BigInt(s);
    return n >= I64_MIN && n <= I64_MAX;
  }, 'exceeds i64');

export const U8 = z.int().min(0).max(255);
export const U16 = z.int().min(0).max(65535);
export const U32 = z.int().min(0).max(4294967295);

/** A Solana address (base58, 32 bytes). */
export const Pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'expected a base58 public key');

/** A Solana transaction signature (base58, 64 bytes). */
export const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, 'expected a base58 signature');

/** A Solana slot (fits a JS safe integer for the next ~100 million years). */
export const Slot = z.int().min(0);

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex sha256');
export const GitSha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-char lowercase git sha');

/** RFC 3339 instant with an explicit offset (`Z` or ±hh:mm). */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** A decimal with exactly nine fractional digits, e.g. "0.125000000", "-3.000000000". */
export const Fixed9 = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)\.[0-9]{9}$/, 'expected a Fixed9 decimal string')
  .refine((s) => s !== '-0.000000000', 'negative zero');

/** Format a BigInt scaled by 1e9 as Fixed9 (12345n -> "0.000012345"). */
export function toFixed9(scaled: bigint): string {
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const whole = abs / FIXED9_SCALE;
  const frac = (abs % FIXED9_SCALE).toString().padStart(9, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Parse a Fixed9 string back to its BigInt scaled by 1e9. Throws on anything else. */
export function parseFixed9(s: string): bigint {
  Fixed9.parse(s);
  const neg = s.startsWith('-');
  const [whole, frac] = (neg ? s.slice(1) : s).split('.') as [string, string];
  const v = BigInt(whole) * FIXED9_SCALE + BigInt(frac);
  return neg ? -v : v;
}

/** A lowercase kebab-case slug (competitions, sponsors, datasets): the same rule as the DB check. */
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'expected a lowercase slug');
