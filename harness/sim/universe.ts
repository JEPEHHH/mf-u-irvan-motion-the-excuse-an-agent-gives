// Which mints a replay delivers. A mint is in the universe iff the dataset holds its CreateEvent and
// that CreateEvent says: SOL-quoted (quote_mint = Pubkey::default(), contracts/events.ts isSolQuoted;
// NOT wSOL), not mayhem-mode (mayhem coins carry per-coin virtual params via
// set_mayhem_virtual_params), not cashback-enabled (cashback semantics are unverified: no cashback
// coin was seen while settling the fee formulas), and sha256(UTF-8 bytes of the base58 mint), read
// as a big-endian unsigned integer, mod `modulus` equals `residue`; and the dataset does not list it
// as excluded (an unrepairable chain). Every rule reads create-time facts only, so the sample
// carries no outcome bias. A mint whose CreateEvent predates the window has no create-time facts
// and no initial reserves in the dataset, so it is not in the universe.

import { createHash } from 'node:crypto';
import { isSolQuoted, type CreateEvent } from '../contracts/events.ts';
import type { UniverseT } from '../contracts/protocol.ts';

export type UniverseSampleT = UniverseT['sample'];

/** sha256 of the mint's UTF-8 base58 text, as a big-endian unsigned integer. */
export function mintSampleHash(mint: string): bigint {
  return BigInt(`0x${createHash('sha256').update(mint, 'utf8').digest('hex')}`);
}

export function inSample(mint: string, sample: UniverseSampleT): boolean {
  return mintSampleHash(mint) % BigInt(sample.modulus) === BigInt(sample.residue);
}

export type UniverseExclusion = 'not_sol_quoted' | 'mayhem_mode' | 'cashback_enabled' | 'not_sampled' | 'excluded_by_dataset';

/** Null when the created mint is in the universe, else the first rule it fails. */
export function universeExclusion(
  create: Pick<CreateEvent, 'mint' | 'quote_mint' | 'is_mayhem_mode' | 'is_cashback_enabled'>,
  sample: UniverseSampleT,
  excluded: ReadonlySet<string> = new Set(),
): UniverseExclusion | null {
  if (!isSolQuoted(create.quote_mint)) return 'not_sol_quoted';
  if (create.is_mayhem_mode) return 'mayhem_mode';
  if (create.is_cashback_enabled) return 'cashback_enabled';
  if (excluded.has(create.mint)) return 'excluded_by_dataset';
  if (!inSample(create.mint, sample)) return 'not_sampled';
  return null;
}
