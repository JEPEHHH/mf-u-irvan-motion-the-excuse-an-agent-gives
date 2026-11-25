// The entry fee's shares (contracts/competition.ts EntryFee): how a fee splits between the bounty's pot, the make.fun
// fund (fund_percent: a house bounty's fund share, or a user's bounty's house share) and the bounty's creator
// (creator, a user's or agent's bounty, less make.fun's cut of that share, which goes to the fund too), and the
// sentences every surface (server, cli, web) uses to tell people and agents about it, with the words for winnings
// still pending, which never pay a fee. The wording is tuned here alone.
//
// Split: house = floor(fee_cents * fund_percent / 100); with a creator share gross = floor(fee_cents * percent / 100)
// and cut = floor(gross * cut_percent / 100) (both 0 without one); the fund's account gets house + cut, the creator's
// gross - cut, the pot the rest (fee - house - gross). fund_percent + percent is at most 100, and a bundle with no
// fund_percent splits as it always did. A fee is whole cents; in base units
// a cent is 10^(decimals - 2) (USDC: 6 decimals, 10_000 base units a cent). Where the creator's net share goes is the
// creator block's `to`: 'balance', credited to the creator's make.fun balance; absent, paid on chain to its wallet.
//
// Floor: every bounty composed from now on keeps at least FUND_FLOOR_PERCENT of each fee for the fund (fundShareBpsOf
// counts make.fun's cut of a creator's share too; fundFloorIssue says when a fee falls short). The splits above follow
// a bundle's frozen terms, so a bundle sealed before the floor splits as it always did.
//
// Model: a user's bounty carries one of two entry-fee models (FEE_MODELS), frozen at its deposit. 'total' (the
// default, the owner's ruling of 2026-11-21: "15% in total"): make.fun takes the house percent H of each fee in all, a
// fee alone as its fund_percent, a fee with a creator share as make.fun's cut of that share and no fund_percent.
// 'beside': H as fund_percent on every fee, and the configured cut of a creator's share beside it. entryFeeRuleOf is
// the one place either rule is written: compose, the proposal checks, the suggest clamp, the terms' limits and the
// web's split sentence all call it.
//
// A leaf: no imports at all, so the server, the cli and the web app all read it.

/** The fund's name as every sentence says it. */
export const FUND_NAME = 'the make.fun fund';

/** What the fund pays for, as every sentence says it (the user's words: more bounties, more content, expansion). */
export const FUND_PURPOSE = "which pays for more bounties, more content and make.fun's expansion";

/**
 * What winnings not cleared to pay yet are (server/entry-fees/eligible.ts EligibleWinnings.pendingCents), as every
 * surface says them: they never pay an entry fee until they are cleared. The insufficient_winnings refusal carries
 * their amount typed (EntryFeeProblem.winnings_pending_usd); these words only say what that amount is.
 */
export const PENDING_WINNINGS_WORDS = 'still pending (under review, held, or awaiting approval)';

/** How every sentence names the person or agent who created a bounty (EntryFee.creator). */
export const CREATOR_NAME = "the bounty's creator";

/**
 * The most of each entry fee a bounty's creator may keep, in percent: the default of server/config.ts
 * sponsorCreatorMaxPercent (MAKEFUN_SPONSOR_CREATOR_MAX_PERCENT).
 */
export const CREATOR_SHARE_MAX_PERCENT = 50;

/**
 * make.fun's cut of a creator's share, in percent of that share, paid to the fund: the default of server/config.ts
 * sponsorCreatorCutPercent (MAKEFUN_SPONSOR_CREATOR_CUT_PERCENT), frozen into each bundle at compose
 * (EntryFee.creator.cut_percent).
 */
export const CREATOR_SHARE_CUT_PERCENT = 50;

/**
 * make.fun's house percent of every entry fee on a user's or agent's bounty, in percent of the whole fee, paid to the
 * fund: the default of server/config.ts sponsorFeeHousePercent (MAKEFUN_SPONSOR_FEE_HOUSE_PERCENT). Under the 'total'
 * model what make.fun takes of each fee in all; under 'beside' its fund_percent beside the creator's share and
 * make.fun's cut of it (entryFeeRuleOf).
 */
export const FEE_HOUSE_PERCENT = 15;

/**
 * The least percent of each entry fee make.fun keeps (to FUND_NAME) on every bounty composed from now on: the
 * owner's words, 2026-11-20, "we keep 15% of all entry fees as a floor going forward". A house bounty keeps it as its
 * fund_percent; a user's or agent's bounty as its house share (fund_percent, never under it: FEE_HOUSE_PERCENT is the
 * default, this the least), beside any creator share and make.fun's cut of it; fundFloorIssue says when a fee falls
 * short. Bundles composed before keep the terms they were sealed with.
 */
export const FUND_FLOOR_PERCENT = 15;

/**
 * Where a creator's net share goes (EntryFee.creator.to; GET /api/sponsor/terms limits.creator_payout): 'balance', credited
 * to the creator's make.fun balance and claimed like other rewards; 'wallet', paid on chain to the creator's wallet.
 */
export const CREATOR_PAYOUTS = ['balance', 'wallet'] as const;
export type CreatorPayout = (typeof CREATOR_PAYOUTS)[number];

/** Where a creator's net share of a bounty composed now goes unless the server says otherwise (MAKEFUN_SPONSOR_CREATOR_PAYOUT). */
export const CREATOR_PAYOUT_DEFAULT: CreatorPayout = 'balance';

/**
 * A creator share's terms (EntryFee.creator without its wallet): its percent of each fee, make.fun's cut of that share,
 * and `to` 'balance' when the creator's net share is credited to their make.fun balance (absent: paid to their wallet).
 */
export interface CreatorShareTerms {
  percent: number;
  cut_percent: number;
  to?: 'balance';
}

/** Where a creator share's net share goes: 'balance' for `to` 'balance', else 'wallet'. */
export function creatorPayoutOf(c: { to?: string }): CreatorPayout {
  return c.to === 'balance' ? 'balance' : 'wallet';
}

/** The terms' `to` key for a payout: `{ to: 'balance' }` in balance mode, else none, so a wallet-mode block keeps its bytes. */
export function creatorToOf(payout: CreatorPayout): Pick<CreatorShareTerms, 'to'> {
  return payout === 'balance' ? { to: 'balance' } : {};
}

/** Throws unless `p` is an integer 0..100 (`name`: EntryFee.fund_percent unless named). */
function assertPercent(p: number, name = 'fund_percent'): void {
  if (!Number.isInteger(p) || p < 0 || p > 100) throw new RangeError(`${name} ${p} is not an integer 0..100`);
}

/**
 * Throws unless `c` holds a creator share beside a fund share of `fundPercent`: percent an integer 1..100, cut_percent
 * an integer 0..100, and fundPercent + percent at most 100 (both are percents of the whole fee).
 */
function assertCreator(c: CreatorShareTerms, fundPercent = 0): void {
  if (!Number.isInteger(c.percent) || c.percent < 1 || c.percent > 100) throw new RangeError(`creator percent ${c.percent} is not an integer 1..100`);
  assertPercent(c.cut_percent, 'creator cut_percent');
  if (fundPercent + c.percent > 100) throw new RangeError(`fund_percent ${fundPercent} and creator percent ${c.percent} are more than 100: both are percents of the whole fee`);
}

/**
 * The entry-fee models a user's bounty may carry (server/config.ts sponsorFeeModel, MAKEFUN_SPONSOR_FEE_MODEL; frozen
 * at the deposit as competition_proposal.fee_model; GET /api/sponsor/terms limits.fee_model), as entryFeeRuleOf reads
 * them. 'total': make.fun takes the house percent H of each fee in total, whatever share the creator keeps (a share is
 * H or more, and make.fun's cut of it the least whole cut that makes H%, so a little over H% where the share does not
 * divide it: houseTakeOfLimits). 'beside': H of every fee as fund_percent,
 * and the configured cut of a creator's share on top (a share at most 100 less H).
 */
export const FEE_MODELS = ['total', 'beside'] as const;
export type FeeModel = (typeof FEE_MODELS)[number];

/** The model a bounty composed now carries unless the server says otherwise: the owner's ruling, 2026-11-21, "15% in total". */
export const FEE_MODEL_DEFAULT: FeeModel = 'total';

/** The model a value names, FEE_MODEL_DEFAULT for none or any other. A deposit that froze no model reads otherwise (server/proposals/compose.ts depositedHouseFeeOf: 'beside', whether or not it froze a house percent), and so do published limits that name none (entryFeeRuleOfLimits). */
export function feeModelOf(value: string | null | undefined): FeeModel {
  return FEE_MODELS.find((m) => m === value) ?? FEE_MODEL_DEFAULT;
}

/** The entry-fee terms a bundle carries (contracts/competition.ts EntryFee less its amount and wallets): either share absent when it carries none. */
export interface EntryFeeTerms {
  fund_percent?: number;
  creator?: { percent: number; cut_percent: number };
}

/** What entryFeeRuleOf reads: the model, H, the configured cut, the creator share asked (none: null or absent) and the server's most share. */
export interface EntryFeeRuleInput {
  model: FeeModel;
  /** H: make.fun's house percent of each fee, an integer 0..100 (server/config.ts sponsorFeeHousePercent, or the deposit's). */
  housePercent: number;
  /** The configured cut of a creator's share, an integer 0..100 (sponsorCreatorCutPercent, or the deposit's): read under 'beside' alone. */
  cutPercent: number;
  /** The creator share asked, whole percent of each fee; null or absent: none. */
  creatorPercent?: number | null;
  /** The server's most creator share (sponsorCreatorMaxPercent), an integer 0..100; absent: 100 (compose, which holds the share to the fee's room only). */
  maxCreatorPercent?: number;
}

/** Why a creator share falls out of a rule's bounds: under its least, or over its most. */
export interface EntryFeeRuleRefusal {
  reason: 'under_least' | 'over_most';
  percent: number;
  least: number;
  most: number;
}

/**
 * A fee's rule: the creator share's bounds under the model (min_creator_percent, max_creator_percent: none offered
 * when the most is under the least), then for the share asked (or none) the terms the bundle carries and each party's
 * share of every fee in basis points, exact (no cent rounding); or, for a share out of bounds, why not (terms and
 * shares null).
 */
export interface EntryFeeRule {
  model: FeeModel;
  house_percent: number;
  min_creator_percent: number;
  max_creator_percent: number;
  terms: EntryFeeTerms | null;
  shares: { house_bps: number; creator_bps: number; pot_bps: number } | null;
  refusal: EntryFeeRuleRefusal | null;
}

/**
 * The entry-fee rule, the one place it is written: `(model, H, configured cut, share or none, the server's most)` to
 * the terms a bundle carries, or why not.
 *
 * - 'total': a fee alone carries fund_percent H (none at 0). A share s from max(H, 1) to the server's most (at most
 *   100) carries no fund_percent and `creator: { percent: s, cut_percent: c }`, c the least whole cut with
 *   s * c >= H * 100 (at most 100; the configured cut plays no part), so make.fun takes H% of each fee in total, a
 *   little more where s does not divide H * 100 (the cut is a whole percent; the excess comes out of the creator's net,
 *   never the pot): on a $2 fee at H = 15, s = 20 freezes a 75% cut (pool $1.60, make.fun $0.30, creator $0.10), s = 50
 *   a 30% cut, s = 15 a 100% cut (the creator nets nothing), s = 44 a 35% cut (15.4% of each fee to make.fun), s = 88 an
 *   18% cut (15.84%). These are percents; the cents are floored (SHARE_ROUNDING_WORDS), so $1.07 at s = 20 gives
 *   make.fun 15 cents, 14.02%.
 * - 'beside': fund_percent H on every fee, and a share s from 1 to the smaller of the server's most and 100 less H
 *   beside it, with the configured cut: s = 20 at a 50% cut on a $2 fee gives make.fun $0.50, the creator $0.20 and
 *   the pool $1.30.
 *
 * Throws on H, the cut or the most not an integer 0..100, or a share asked that is not an integer.
 */
export function entryFeeRuleOf(input: EntryFeeRuleInput): EntryFeeRule {
  const { model, housePercent: house, cutPercent } = input;
  assertPercent(house, 'house percent');
  assertPercent(cutPercent, 'creator cut_percent');
  const ceiling = input.maxCreatorPercent ?? 100;
  assertPercent(ceiling, 'max creator percent');
  const least = model === 'total' ? Math.max(house, 1) : 1;
  const most = model === 'total' ? ceiling : Math.min(ceiling, 100 - house);
  const base = { model, house_percent: house, min_creator_percent: least, max_creator_percent: most };
  const s = input.creatorPercent ?? null;
  if (s === null) {
    return { ...base, terms: house === 0 ? {} : { fund_percent: house }, shares: { house_bps: house * 100, creator_bps: 0, pot_bps: (100 - house) * 100 }, refusal: null };
  }
  if (!Number.isInteger(s)) throw new RangeError(`creator percent ${s} is not an integer`);
  if (s < least || s > most) return { ...base, terms: null, shares: null, refusal: { reason: s < least ? 'under_least' : 'over_most', percent: s, least, most } };
  const fund = model === 'total' ? 0 : house;
  const cut = model === 'total' ? Math.min(100, Math.ceil((house * 100) / s)) : cutPercent;
  const terms: EntryFeeTerms = { ...(fund === 0 ? {} : { fund_percent: fund }), creator: { percent: s, cut_percent: cut } };
  const houseBps = fund * 100 + s * cut;
  return { ...base, terms, shares: { house_bps: houseBps, creator_bps: s * (100 - cut), pot_bps: 10_000 - fund * 100 - s * 100 }, refusal: null };
}

/** The fee model's limits a server publishes (GET /api/sponsor/terms limits: server/api-types/proposal.ts SponsorLimits), the members entryFeeRuleOfLimits reads. */
export interface FeeRuleLimits {
  fee_model?: string;
  fee_house_percent?: number;
  max_creator_percent?: number;
  creator_cut_percent?: number;
}

/**
 * entryFeeRuleOf on a server's published limits, for a surface that reads them (the web's form and split sentence,
 * the CLI, the terms' twin): the model (feeModelOf of the one named; limits that name none come from a server from
 * before the field, every one of which took the house share, if any, beside the share at its configured cut, so they
 * read as 'beside'), the house percent (0 where none is published: a server from before it takes none), the configured
 * cut (CREATOR_SHARE_CUT_PERCENT where none is published; read under 'beside' alone), the share asked and the server's
 * most (CREATOR_SHARE_MAX_PERCENT where none is published).
 */
export function entryFeeRuleOfLimits(limits: FeeRuleLimits | null | undefined, creatorPercent: number | null = null): EntryFeeRule {
  return entryFeeRuleOf({
    model: limits?.fee_model === undefined ? 'beside' : feeModelOf(limits.fee_model),
    housePercent: limits?.fee_house_percent ?? 0,
    cutPercent: limits?.creator_cut_percent ?? CREATOR_SHARE_CUT_PERCENT,
    creatorPercent,
    maxCreatorPercent: limits?.max_creator_percent ?? CREATOR_SHARE_MAX_PERCENT,
  });
}

/**
 * What a creator share nets its creator on a server's limits (entryFeeRuleOfLimits), as one clause for the surfaces
 * written from limits: a share five points over the least (the most, when that is nearer) and its net share of each
 * fee ('a 20% share nets you 5% of each fee' under 'total' at 15); null where the limits offer no share.
 */
export function creatorNetClause(limits: FeeRuleLimits | null | undefined): string | null {
  const bounds = entryFeeRuleOfLimits(limits);
  const percent = Math.min(bounds.max_creator_percent, bounds.min_creator_percent + 5);
  if (percent < bounds.min_creator_percent) return null;
  const shares = entryFeeRuleOfLimits(limits, percent).shares;
  return shares === null ? null : `${aPercentWords(percent, 'share')} nets you ${bpsPercentWords(shares.creator_bps)} of each fee`;
}

/** A whole percent and its noun with the article English reads aloud: (20, 'share') -> 'a 20% share', (88, 'share') -> 'an 88% share', (18, 'cut') -> 'an 18% cut'. */
export function aPercentWords(percent: number, noun: string): string {
  return `${/^(8|11|18)$|^8\d$/.test(String(percent)) ? 'an' : 'a'} ${percent}% ${noun}`;
}

/** make.fun's take of each fee over the creator shares a server's limits offer (houseTakeOfLimits), in basis points. */
export interface HouseTake {
  least_bps: number;
  most_bps: number;
  /** The smallest share at which make.fun's take is the most. */
  most_at: number;
}

/**
 * make.fun's take of each fee (EntryFeeRule shares.house_bps) over every creator share a server's limits offer
 * (entryFeeRuleOfLimits, each whole share from the least to the most): the least and the most it comes to, and the
 * smallest share at the most. Under 'total' make.fun's cut is a whole percent of the share, so where the share does not
 * divide the house percent the take runs over it, out of the creator's net and never the pot: at 15, a 44% share takes
 * a 35% cut, 15.4% of each fee (the most inside a most share of 50), and an 88% share an 18% cut, 15.84% (the most
 * inside 100). Null where the limits offer no share.
 */
export function houseTakeOfLimits(limits: FeeRuleLimits | null | undefined): HouseTake | null {
  const bounds = entryFeeRuleOfLimits(limits);
  const take: HouseTake = { least_bps: Number.POSITIVE_INFINITY, most_bps: -1, most_at: 0 };
  for (let s = bounds.min_creator_percent; s <= bounds.max_creator_percent; s++) {
    const bps = entryFeeRuleOfLimits(limits, s).shares?.house_bps;
    if (bps === undefined) continue;
    if (bps < take.least_bps) take.least_bps = bps;
    if (bps > take.most_bps) {
      take.most_bps = bps;
      take.most_at = s;
    }
  }
  return take.most_bps < 0 ? null : take;
}

/** houseTakeOfLimits in words: '15% to 15.4%', or one percent where the least and the most are one; null where the limits offer no share. A sentence stating it says SHARE_ROUNDING_WORDS beside it. */
export function houseTakeWords(limits: FeeRuleLimits | null | undefined): string | null {
  const take = houseTakeOfLimits(limits);
  if (take === null) return null;
  return take.least_bps === take.most_bps ? bpsPercentWords(take.least_bps) : `${bpsPercentWords(take.least_bps)} to ${bpsPercentWords(take.most_bps)}`;
}

/**
 * The rounding every sentence that states make.fun's take of each fee says beside its percent (houseTakeWords and its
 * callers, the boot error, the env examples' copy of it): the split is in whole cents, each share rounded down
 * (splitOfCents: the fund's share, the creator's gross share, then make.fun's cut of that), so on a fee that does not
 * divide evenly make.fun's part comes to as much as a cent under the cents its percent gives, never more under: at 15
 * a 20% share takes a 75% cut, and $1.07 pays the pool 86 cents, make.fun 15 and the creator 6 (14.02%), $1.99 160, 29
 * and 10, $0.50 40, 7 and 3. The take sentences name no 'at least': the percent is the sealed term
 * (creator.cut_percent, a whole percent of the share), the cents its floor.
 */
export const SHARE_ROUNDING_WORDS = "every share is rounded down to the cent, so on a fee that does not divide evenly make.fun's part can be a cent under";

/** SHARE_ROUNDING_WORDS as a sentence of its own: 'Every share is rounded down to the cent, so ... can be a cent under.' */
export const SHARE_ROUNDING_SENTENCE = `${SHARE_ROUNDING_WORDS.charAt(0).toUpperCase()}${SHARE_ROUNDING_WORDS.slice(1)}.`;

/**
 * SHARE_ROUNDING_WORDS in the short lines of a narrow hint (the sponsor form's, a sentence a line of at most 34
 * characters), after a line whose 'It' is make.fun ('It takes 15% to 15.4% of each fee.').
 */
export const SHARE_ROUNDING_LINES = ['Shares round down to the cent.', 'Some fees pay it a cent under.'] as const;

/**
 * What a creator share of `percent` nets its creator of each fee on a server's limits (entryFeeRuleOfLimits), in words:
 * '5%', or 'nothing' for a share whose cut takes it all (under 'total', a share at the house percent); null for a share
 * the rule refuses.
 */
export function creatorNetWords(limits: FeeRuleLimits | null | undefined, percent: number): string | null {
  const shares = entryFeeRuleOfLimits(limits, percent).shares;
  if (shares === null) return null;
  return shares.creator_bps === 0 ? 'nothing' : bpsPercentWords(shares.creator_bps);
}

/** A share of each fee in basis points as words, no trailing zeros: 500 -> '5%', 1650 -> '16.5%'. */
export function bpsPercentWords(bps: number): string {
  return `${percentWords(bps)}%`;
}

/** The fee's fund percent: its fund_percent, 0 when absent (or no fee at all). */
export function fundPercentOf(entryFee: { fund_percent?: number } | null | undefined): number {
  return entryFee?.fund_percent ?? 0;
}

/** The fee's creator share terms (its creator, the wallet dropped, `to` kept in balance mode), null when it has none (or no fee at all). */
export function creatorTermsOf(entryFee: { creator?: CreatorShareTerms } | null | undefined): CreatorShareTerms | null {
  const c = entryFee?.creator;
  return c === undefined ? null : { percent: c.percent, cut_percent: c.cut_percent, ...creatorToOf(creatorPayoutOf(c)) };
}

/** The split in whole cents (the one place it is computed): the fund's share, the creator's gross share and make.fun's cut of it. */
function splitOfCents(cents: bigint, fundPercent: number, creator: CreatorShareTerms | null): { house: bigint; gross: bigint; cut: bigint } {
  assertPercent(fundPercent);
  if (creator !== null) assertCreator(creator, fundPercent);
  const house = (cents * BigInt(fundPercent)) / 100n;
  const gross = creator === null ? 0n : (cents * BigInt(creator.percent)) / 100n;
  const cut = creator === null ? 0n : (gross * BigInt(creator.cut_percent)) / 100n;
  return { house, gross, cut };
}

/** An entry fee as the floor reads it (contracts/competition.ts EntryFee, the fields it needs). */
type FloorEntryFee = { amount_usd?: number; fund_percent?: number; creator?: CreatorShareTerms } | null | undefined;

/**
 * make.fun's share of each fee in basis points, on the fee's exact terms (no cent rounding): fund_percent * 100 plus,
 * with a creator share, creator.percent * creator.cut_percent (make.fun's cut of the creator's share), since a fee
 * feeds the fund and the creator both; 0 with no fee.
 */
export function fundShareBpsOf(entryFee: FloorEntryFee): number {
  const creator = creatorTermsOf(entryFee);
  return fundPercentOf(entryFee) * 100 + (creator === null ? 0 : creator.percent * creator.cut_percent);
}

/** A percent from basis points, with no trailing zeros (750 -> '7.5', 1520 -> '15.2', 1500 -> '15'). */
function percentWords(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

/**
 * Why an entry fee falls under the floor, as one plain sentence naming what it keeps and the fix (its fund_percent,
 * with or without a creator share); null when there is no fee, its amount_usd is 0, or it keeps FUND_FLOOR_PERCENT or
 * more of each fee (fundShareBpsOf).
 */
export function fundFloorIssue(entryFee: FloorEntryFee): string | null {
  if (entryFee === null || entryFee === undefined || entryFee.amount_usd === 0) return null;
  const bps = fundShareBpsOf(entryFee);
  if (bps >= FUND_FLOOR_PERCENT * 100) return null;
  return `an entry fee keeps at least ${FUND_FLOOR_PERCENT}% of each fee for ${FUND_NAME}, and this one keeps ${percentWords(bps)}%: set entry_fee.fund_percent to ${FUND_FLOOR_PERCENT} or more`;
}

/**
 * A fee of `feeCents` (a whole number of cents, 0 or more) split at `fundPercent` and, with one, `creator`'s share:
 * fund_cents is what reaches the fund's account (the fund or house share, plus make.fun's cut of the creator's share),
 * creator_cents what reaches the creator's account, creator_cut_cents make.fun's cut of the creator's share (inside
 * fund_cents), pot_cents the rest; every share rounded down to the cent, and pot_cents + fund_cents + creator_cents =
 * feeCents. Throws on a fee that is not whole cents, a percent out of range, or fundPercent + creator.percent above 100.
 */
export function entryFeeSplitCents(
  feeCents: number,
  fundPercent: number,
  creator: CreatorShareTerms | null = null,
): { pot_cents: number; fund_cents: number; creator_cents: number; creator_cut_cents: number } {
  if (!Number.isSafeInteger(feeCents) || feeCents < 0) throw new RangeError(`fee ${feeCents} is not a whole number of cents`);
  const { house, gross, cut } = splitOfCents(BigInt(feeCents), fundPercent, creator);
  return { pot_cents: feeCents - Number(house + gross), fund_cents: Number(house + cut), creator_cents: Number(gross - cut), creator_cut_cents: Number(cut) };
}

/**
 * A fee of `feeBaseUnits` (a token with `decimals` decimals) split at `fundPercent` and with `creator`, in whole cents
 * as entryFeeSplitCents splits it: fund what reaches the fund's account, creator what reaches the creator's,
 * creator_cut make.fun's cut of the creator's share (inside fund), pot the rest. Throws on decimals under 2 (or not an
 * integer), a negative fee, a fee that is not whole cents, a percent out of range, or fundPercent + creator.percent
 * above 100.
 */
export function entryFeeSplitBaseUnits(
  feeBaseUnits: bigint,
  fundPercent: number,
  decimals: number,
  creator: CreatorShareTerms | null = null,
): { pot: bigint; fund: bigint; creator: bigint; creator_cut: bigint } {
  if (!Number.isInteger(decimals) || decimals < 2) throw new RangeError(`decimals ${decimals}: a cent needs 2 or more`);
  if (feeBaseUnits < 0n) throw new RangeError(`fee ${feeBaseUnits} base units is negative`);
  const cent = 10n ** BigInt(decimals - 2);
  if (feeBaseUnits % cent !== 0n) throw new RangeError(`fee ${feeBaseUnits} base units is not whole cents at ${decimals} decimals`);
  const { house, gross, cut } = splitOfCents(feeBaseUnits / cent, fundPercent, creator);
  return { pot: feeBaseUnits - (house + gross) * cent, fund: (house + cut) * cent, creator: (gross - cut) * cent, creator_cut: cut * cent };
}

/**
 * The fees fundCentLeastCents tries, cents: at $100 every share is a whole cent (the fund's 100 * fund_percent, the
 * creator's gross 100 * percent, make.fun's cut percent * cut_percent), so terms that take any basis point of a fee pay
 * make.fun a cent there; none under it pays none at all.
 */
const FUND_CENT_SEARCH_CENTS = 10_000;

/**
 * The least fee, whole cents, at which make.fun's cents of a fee split on `terms` (entryFeeSplitCents' fund_cents: the
 * fund's share plus make.fun's cut of the creator's share, each rounded down to the cent) come to at least 1, found by
 * splitting each fee from a cent up (never a formula of its own); null where no fee pays make.fun a cent (terms with no
 * fund share and no cut). make.fun's cents never fall as the fee rises, so every fee from it up pays at least a cent. At
 * 15 under 'total': 7 cents for a fee alone, 13 at a 16% creator share (a 94% cut: 12 cents pays the creator's gross 1
 * cent and make.fun's cut of it none), 12 at 17% and 18%, 11 at 19%, 10 at 20%, 7 at 15% (a 100% cut).
 */
export function fundCentLeastCents(terms: EntryFeeTerms): number | null {
  const fund = terms.fund_percent ?? 0;
  const creator = terms.creator === undefined ? null : { percent: terms.creator.percent, cut_percent: terms.creator.cut_percent };
  for (let c = 1; c <= FUND_CENT_SEARCH_CENTS; c++) if (entryFeeSplitCents(c, fund, creator).fund_cents >= 1) return c;
  return null;
}

/**
 * The least entry fee of a proposal, whole cents: the larger of the published least (`limitCents`, limits.min_entry_fee_usd
 * in cents) and the least fee at which make.fun's share of it is a cent on the terms its fee model gives its creator share
 * (`terms`: EntryFeeRule.terms, fundCentLeastCents), so make.fun gets at least a cent of every fee a proposal lists. 0
 * where `limitCents` is 0 (an operator turned the least fee off: neither applies, any fee above $0), and the limit alone
 * for `terms` null (a share the rule refuses: its own check says so) or terms that pay make.fun no cent at any fee.
 */
export function leastEntryFeeCents(limitCents: number, terms: EntryFeeTerms | null): number {
  if (!(limitCents > 0)) return 0;
  const cent = terms === null ? null : fundCentLeastCents(terms);
  return cent === null ? limitCents : Math.max(limitCents, cent);
}

/**
 * leastEntryFeeCents on a server's published limits (limits.min_entry_fee_usd and the fee model's: entryFeeRuleOfLimits)
 * for a creator share of `creatorPercent` (none: null; one that is not a whole number reads as none), for a surface that
 * reads them (the web's form and sidebar, the CLI): the least entry fee for the share chosen, cents; 0 where the limits
 * hold none (min_entry_fee_usd 0, or absent: a server from before it).
 */
export function leastEntryFeeCentsOfLimits(limits: (FeeRuleLimits & { min_entry_fee_usd?: number }) | null | undefined, creatorPercent: number | null = null): number {
  const limit = Math.max(0, Math.round((limits?.min_entry_fee_usd ?? 0) * 100));
  const share = creatorPercent !== null && Number.isInteger(creatorPercent) && creatorPercent > 0 ? creatorPercent : null;
  return leastEntryFeeCents(limit, entryFeeRuleOfLimits(limits, share).terms);
}

/**
 * The least entry fee's creator-share clause, one fixed phrase every surface that names the published least
 * (limits.min_entry_fee_usd) says right after it (the proposal_prizes description, the terms' markdown twin, skill.md,
 * llms.txt, the MCP proposal text): with a creator share, the least is leastEntryFeeCents' cent fee where that is more.
 */
export const SHARE_LEAST_FEE_WORDS = "or, with a creator share, the smallest fee at which make.fun's share of it is a cent, when that is more";

/**
 * The creator share a server's limits offer whose least entry fee is the highest above the published least
 * (leastEntryFeeCentsOfLimits over each share from the least to the most), the first such share where several tie, and
 * that fee in cents: the worked example beside SHARE_LEAST_FEE_WORDS (on the defaults, 13 cents at a 16% share under
 * 'total'); null where no share raises the least (none offered, a least of 0, or 'beside' with its house share).
 */
export function topShareLeastOfLimits(limits: (FeeRuleLimits & { min_entry_fee_usd?: number }) | null | undefined): { percent: number; cents: number } | null {
  const bounds = entryFeeRuleOfLimits(limits);
  let top: { percent: number; cents: number } | null = null;
  let floor = leastEntryFeeCentsOfLimits(limits);
  for (let s = bounds.min_creator_percent; s <= bounds.max_creator_percent; s++) {
    const cents = leastEntryFeeCentsOfLimits(limits, s);
    if (cents > floor) {
      top = { percent: s, cents };
      floor = cents;
    }
  }
  return top;
}

/** topShareLeastOfLimits in words, the example SHARE_LEAST_FEE_WORDS takes: '$0.13 with a 16% share'; null where no share raises the least. */
export function shareLeastExampleWords(limits: (FeeRuleLimits & { min_entry_fee_usd?: number }) | null | undefined): string | null {
  const top = topShareLeastOfLimits(limits);
  return top === null ? null : `$${(top.cents / 100).toFixed(2)} with ${aPercentWords(top.percent, 'share')}`;
}

/**
 * SHARE_LEAST_FEE_WORDS with its worked example from `limits` in brackets where one share raises the least
 * (shareLeastExampleWords; `on` names whose limits they are, 'on the defaults' for a surface written from them): "or,
 * with a creator share, ..., when that is more (on the defaults, $0.13 with a 16% share)"; the bare clause where none does.
 */
export function shareLeastClause(limits: (FeeRuleLimits & { min_entry_fee_usd?: number }) | null | undefined, on: string | null = null): string {
  const example = shareLeastExampleWords(limits);
  return example === null ? SHARE_LEAST_FEE_WORDS : `${SHARE_LEAST_FEE_WORDS} (${on === null ? '' : `${on}, `}${example})`;
}

/** Where the fee goes, as one sentence: null at 0 (the whole fee joins the pot, as always). */
export function fundShareSentence(fundPercent: number): string | null {
  assertPercent(fundPercent);
  if (fundPercent === 0) return null;
  if (fundPercent === 100) return `The whole entry fee goes to ${FUND_NAME}, ${FUND_PURPOSE}; none of it joins this bounty's pot.`;
  return `${fundPercent}% of the entry fee goes to ${FUND_NAME}, ${FUND_PURPOSE}; the other ${100 - fundPercent}% joins this bounty's pot.`;
}

/** What a no-place refund returns, as one sentence: null at 0 (the whole fee is refunded). */
export function fundRefundSentence(fundPercent: number): string | null {
  assertPercent(fundPercent);
  if (fundPercent === 0) return null;
  if (fundPercent === 100) return 'None of it is refunded if nobody places.';
  return "The fund's share is never refunded: if nobody places, only the pot's share comes back.";
}

/** Where the creator's share goes in balance mode (CreatorShareTerms.to 'balance'): the sentence after creatorShareSentence's split. */
export const CREATOR_BALANCE_SENTENCE = "The creator's share is added to their make.fun balance, which they claim like other rewards.";

/**
 * Where a creator bounty's fee goes: one sentence with make.fun's house share (`housePercent`, the bundle's
 * fund_percent, when above 0), the creator's share, make.fun's cut of it (when any) and the pot's, then in balance mode
 * (`to` 'balance') CREATOR_BALANCE_SENTENCE. Wallet mode says the one sentence alone. With no house share it says what
 * it always said, so a bounty composed before the house share keeps its words (and its rules' hash).
 */
export function creatorShareSentence(c: CreatorShareTerms, housePercent = 0): string {
  assertPercent(housePercent, 'house percent');
  assertCreator(c, housePercent);
  const to = creatorPayoutOf(c) === 'balance' ? ` ${CREATOR_BALANCE_SENTENCE}` : '';
  const rest = 100 - housePercent - c.percent;
  const pot = rest === 0 ? "none of it joins this bounty's pot" : `the other ${rest}% joins this bounty's pot`;
  if (housePercent === 0) {
    const cut = c.cut_percent === 0 ? '' : `, less make.fun's ${c.cut_percent}% cut of that share, which goes to ${FUND_NAME}`;
    if (c.percent === 100) return `The whole entry fee goes to ${CREATOR_NAME}${cut}; none of it joins this bounty's pot.${to}`;
    return `${c.percent}% of the entry fee goes to ${CREATOR_NAME}${cut}; the other ${100 - c.percent}% joins this bounty's pot.${to}`;
  }
  const cut = c.cut_percent === 0 ? '' : `, less make.fun's ${c.cut_percent}% cut of that share, which goes to the fund too`;
  return `make.fun keeps ${housePercent}% of the entry fee for ${FUND_NAME}, and ${c.percent}% goes to ${CREATOR_NAME}${cut}; ${pot}.${to}`;
}

/**
 * What a no-place refund returns on a creator bounty, as one sentence: the creator's share (and make.fun's cut of it)
 * is never refunded, nor the house share (`housePercent`) beside it. When the shares take the whole fee nothing is.
 */
export function creatorRefundSentence(percent?: number, housePercent = 0): string {
  if (percent !== undefined && percent + housePercent === 100) return 'None of it is refunded if nobody places.';
  if (housePercent > 0) return "make.fun's and the creator's shares are never refunded: if nobody places, only the pot's share comes back.";
  return "The creator's share is never refunded: if nobody places, only the pot's share comes back.";
}

/** Dollars of whole cents: '$1.30'. */
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/**
 * Who gets what of one fee of `feeCents`, in dollars (entryFeeSplitCents): what make.fun keeps (its house share
 * and its cut of the creator's share, each named when both are above 0), what the creator gets, and what joins the
 * pot. Null at a fee of 0, or when the whole fee joins the pot.
 */
export function feeSplitAmountsSentence(feeCents: number, fundPercent: number, creator: CreatorShareTerms | null = null): string | null {
  if (feeCents <= 0) return null;
  const split = entryFeeSplitCents(feeCents, fundPercent, creator);
  if (split.pot_cents === feeCents) return null;
  const house = split.fund_cents - split.creator_cut_cents;
  const parts: string[] = [];
  if (split.fund_cents > 0) {
    const of = house > 0 && split.creator_cut_cents > 0 ? ` (${dollars(house)} house share, ${dollars(split.creator_cut_cents)} cut of the creator's share)` : '';
    parts.push(`make.fun keeps ${dollars(split.fund_cents)}${of}`);
  }
  if (creator !== null) parts.push(`${CREATOR_NAME} gets ${dollars(split.creator_cents)}`);
  parts.push(`${dollars(split.pot_cents)} joins this bounty's pot`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Of each ${dollars(feeCents)} fee, ${list}.`;
}

/** The creator's share beside a fee on a dock or a band ('40% to the creator'), as src/lib/bounty.ts fundShareTag says the fund's. */
export function creatorShareTag(percent: number): string {
  return `${percent}% to the creator`;
}

/**
 * The sentences for a fee's shares, whichever it has: with a creator share the creator's, the house share beside it
 * (creatorShareSentence, creatorRefundSentence, both at the fee's fund_percent), else the fund's (fundShareSentence,
 * fundRefundSentence); both null when the whole fee joins the pot (or no fee at all). Every new surface calls this one.
 */
export function feeShareSentences(entryFee: { fund_percent?: number; creator?: CreatorShareTerms } | null | undefined): { share: string | null; refund: string | null } {
  const creator = creatorTermsOf(entryFee);
  const fund = fundPercentOf(entryFee);
  if (creator !== null) return { share: creatorShareSentence(creator, fund), refund: creatorRefundSentence(creator.percent, fund) };
  return { share: fundShareSentence(fund), refund: fundRefundSentence(fund) };
}
