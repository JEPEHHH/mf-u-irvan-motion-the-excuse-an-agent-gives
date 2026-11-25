// The house's counts files: what the grader writes at a program/v1 entry link's `counts` path under /output
// (contracts/competition.ts ProgramEntryLink.counts, on a YouTube, an X, a TikTok or a make.fun link:
// COUNTS_ENTRY_LINK_PLATFORMS) after the entry's runs and before the scorer, so the scorer ranks the entry on counts the
// house read, never on a number the entry wrote. One JSON object, UTF-8, in one of five formats by the link's platform: a
// post's three, of at most ENTRY_LINK_COUNTS_MAX_BYTES, told apart by `format` (parseEntryLinkCounts), a make.fun
// link's bounty list (BountiesCounts, parseBountiesCounts), of at most BOUNTIES_COUNTS_MAX_BYTES, read alone, and an X
// pool link's list of posts (XPostsCounts, parseXPostsCounts), of at most X_POSTS_COUNTS_MAX_BYTES, read alone.
//
// A YouTube video's, EntryLinkCounts (ENTRY_LINK_COUNTS_FORMAT, makefun/video-counts/v1), of exactly these keys:
//
//   format    ENTRY_LINK_COUNTS_FORMAT, exactly
//   platform  'youtube'
//   video_id  the video's id, 11 of [A-Za-z0-9_-] (YOUTUBE_VIDEO_ID)
//   url       the video's address as the entry-link record holds it (https)
//   reading   'check', the reading taken when the entry was checked (a dev grade's), or 'deadline', the one taken at
//             the final phase's lock (a final grade's)
//   at        when that reading was taken (RFC 3339 with an offset)
//   video     'public', the video was read and public; 'gone', YouTube answered it absent or not public (the
//             entrant's), every count then null
//   views, likes, comments   each a whole count from 0, or null where YouTube showed none (hidden likes, comments off)
//
// An X post's, XPostCounts (POST_COUNTS_FORMAT, makefun/post-counts/v1), of exactly these keys:
//
//   format    POST_COUNTS_FORMAT, exactly
//   platform  'x'
//   post_id   the post's id, 1 to 20 decimal digits with no leading zero and below 2^64 (X_POST_ID, as
//             server/entry-link/x.ts reads a post's address)
//   url       the post's address as the entry-link record holds it (https)
//   reading   'check', the reading taken when the entry was checked (a dev grade's), or 'deadline', the one taken
//             after the final phase's lock by the house's deadline pass over the field (a final grade's)
//   at        when that reading was taken (RFC 3339 with an offset)
//   post      'public', the post was read; 'gone', X answered it deleted or not public (the entrant's), every count
//             then null
//   views, likes, replies, reposts, quotes   each a whole count from 0, or null where X showed none (a legacy post's
//             views)
//
// A TikTok video's, TiktokVideoCounts (TIKTOK_COUNTS_FORMAT, makefun/tiktok-counts/v1), of exactly these keys:
//
//   format    TIKTOK_COUNTS_FORMAT, exactly
//   platform  'tiktok'
//   video_id  the video's id, 1 to 20 decimal digits with no leading zero and below 2^64 (TIKTOK_VIDEO_ID, the id
//             in the video's address https://www.tiktok.com/@<handle>/video/<id>)
//   url       the video's address as the entry-link record holds it (https, at most 2,048 characters)
//   reading   'check', the reading taken when the entry was checked (a dev grade's), or 'deadline', the one taken
//             after the final phase's lock by the house's deadline pass over the field (a final grade's)
//   at        when that reading was taken (RFC 3339 with an offset)
//   video     'public', the video was read and public; 'gone', TikTok answered it deleted, not public, or not shown
//             to a visitor from the US (the entrant's), every count then null
//   views, likes, comments, shares, saves   each a whole count from 0 (TikTok's play, like, comment, share and save
//             counts), or null where none was shown
//
// An X link naming `pool` (contracts/competition.ts ProgramEntryLink.pool: an entry names a list of posts, each tied to
// one of the pool author's posts), XPostsCounts (X_POSTS_COUNTS_FORMAT, makefun/x-posts-counts/v1), one JSON object of
// at most X_POSTS_COUNTS_MAX_BYTES, read alone (parseXPostsCounts), of exactly these keys:
//
//   format    X_POSTS_COUNTS_FORMAT, exactly
//   platform  'x'
//   reading   'check' (the intake reading, a dev grade's) or 'deadline' (the one taken after the final phase's lock by
//             the house's deadline pass over the field: a final grade's)
//   at        when that reading was taken (RFC 3339 with an offset): the entry's reading, one for every post it names
//   posts     one row for each post the entry names, 1 to X_POSTS_COUNTS_MAX rows, by post id ascending as numbers
//             (BigInt order; an id has no leading zero, so it is the shorter id first, then code-unit order), each post
//             id once and each pool post id once, a row of exactly:
//     post_id       the post's id (X_POST_ID, below 2^64)
//     url           the post's address as the entry-link record holds it (https)
//     pool_post_id  the id of the pool post it quotes or replies to (X_POST_ID, below 2^64)
//     post          'public', the post was read; 'gone', X answered it deleted or not public (the entrant's), every count
//                   then null
//     views, likes, replies, reposts, quotes   each a whole count from 0, or null where X showed none
//
// A posts file's score under `rank_by` is xPostsScoreOf: countsScoreOf of each public row, summed; a gone row adds 0.
//
// makefun/video-counts/v1 and makefun/post-counts/v1 never change: gta6-clipper-01's and gta6-clipper-x-01's sealed
// scorers mirror them byte for byte. A scorer ranks a post's file on
// countsScoreOf: each count its bundle's `rank_by` names (ProgramEntryLink.rank_by; views alone where it names none)
// times its weight, a null count as 0, summed; a gone post scores 0.
//
// A make.fun link naming one or several bounties, BountiesCounts (BOUNTIES_COUNTS_FORMAT, makefun/bounty-counts/v2),
// one JSON object of at most BOUNTIES_COUNTS_MAX_BYTES, of exactly these keys (it replaces the one-bounty
// makefun/bounty-counts/v1, which only two drafts' scorers read and no opened bundle's did: the house writes v1 no more):
//
//   format          BOUNTIES_COUNTS_FORMAT, exactly
//   reading         'check' (the intake reading, a dev grade's) or 'deadline' (the final lock's, capped at the
//                   contest's deadline: a final grade's)
//   read_at         when that reading was taken (RFC 3339 with an offset)
//   min_entrants    the least counted entrants a named bounty needs before it counts (the link's
//                   ProgramEntryLink.min_entrants; 0 where the link names none), a whole number from 0
//   bounties        one row for each bounty the entry names, 1 to BOUNTIES_COUNTS_MAX rows, by slug ascending (code-unit
//                   order), each slug once and each id once, a row of exactly:
//     slug            the bounty's slug (primitives.ts Slug)
//     id              the bounty's competition id, a lowercase hyphenated uuid
//     url             exactly https://make.fun/bounty/<slug>, the record's canonical address
//     bounty          'live', found approved and public; 'gone', not found, or a draft, cancelled or internal (the
//                     entrant's), entrants, entry_fees_usd and pot_usd then null
//     entrants        the bounty's counted entrants up to the reading's cap, a whole count from 0, or null where gone
//     entry_fees_usd  the entry fees those entrants paid up to the cap, a USD decimal (USD_DECIMAL), or null where gone
//     pot_usd         the bounty's pot at the cap, a USD decimal (USD_DECIMAL), or null where gone
//     entry_fee_usd   the bounty's own entry fee, a USD decimal above 0.00 (BountiesCounts); under a link counting every
//                     entrant (ProgramEntryLink.counted 'all', BountiesCountsAll) 0.00 too, a bounty charging none,
//                     which only that link's check passes. A widening of v2: every file written before it still parses
//                     under both, and a 'paying' bundle's scorer, which never sees a 0.00 row, keeps refusing one
//
// A row is 'gone' exactly when entrants, entry_fees_usd and pot_usd are all three null. A row COUNTS when it is live and
// its entrants are at least the file's min_entrants; bountiesTotalsOf sums the counting rows, the one rule every
// scorer of the format mirrors. BOUNTIES_COUNTS_MAX is a bound of the format, four times what a sponsor's limits let
// one account list in a 168-hour window (3 bounties a UTC day over the 8 UTC days such a window touches). A bounty
// list's file takes no `rank_by`: its bundle's scorer ranks it on its own rule over those totals.
//
// Pure: it imports nothing but zod and the primitives, so every reader may take it without the bundle contract. A
// bundle's scorer mirrors its format with its language's standard library alone (no import of this file).

import { z } from 'zod';
import { IsoDateTime, Slug } from './primitives.ts';

/** A video's counts file's format tag (EntryLinkCounts.format). */
export const ENTRY_LINK_COUNTS_FORMAT = 'makefun/video-counts/v1';

/** An X post's counts file's format tag (XPostCounts.format). */
export const POST_COUNTS_FORMAT = 'makefun/post-counts/v1';

/** A TikTok video's counts file's format tag (TiktokVideoCounts.format). */
export const TIKTOK_COUNTS_FORMAT = 'makefun/tiktok-counts/v1';

/** An X pool link's posts counts file's format tag (XPostsCounts.format). */
export const X_POSTS_COUNTS_FORMAT = 'makefun/x-posts-counts/v1';

/** The most rows an X posts counts file holds (XPostsCounts.posts), and so the most posts a pool link's list names (contracts/competition.ts X_POOL_POSTS_MAX). */
export const X_POSTS_COUNTS_MAX = 25;

/** The most bytes an X posts counts file holds: 16 KiB, past X_POSTS_COUNTS_MAX rows of an X address (about 60 characters) and five counts each (about 300 bytes a row). */
export const X_POSTS_COUNTS_MAX_BYTES = 16 * 1024;

/** A bounty list's counts file's format tag (BountiesCounts.format). */
export const BOUNTIES_COUNTS_FORMAT = 'makefun/bounty-counts/v2';

/** The most rows a bounty list's counts file holds (BountiesCounts.bounties): a bound of the format, four times what a sponsor's limits let one account list in a 168-hour window (3 a UTC day over 8 UTC days). */
export const BOUNTIES_COUNTS_MAX = 100;

/** The most bytes a bounty list's counts file holds: 64 KiB, past BOUNTIES_COUNTS_MAX rows of the longest slug and the widest amounts (about 400 bytes a row). */
export const BOUNTIES_COUNTS_MAX_BYTES = 64 * 1024;

/** The most bytes a counts file holds, any format but a bounty list's (BOUNTIES_COUNTS_MAX_BYTES): 4 KiB, far past any one the grader writes (an address of at most 2,048 characters and five counts). */
export const ENTRY_LINK_COUNTS_MAX_BYTES = 4 * 1024;

/** A YouTube video's id: 11 letters, digits, underscores and hyphens. */
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** An X post's id as server/entry-link/x.ts reads one: 1 to 20 decimal digits, no leading zero (XPostCounts also holds it below 2^64). */
export const X_POST_ID = /^[1-9][0-9]{0,19}$/;

/** A TikTok video's id as its address carries it: 1 to 20 decimal digits, no leading zero (TiktokVideoCounts also holds it below 2^64). */
export const TIKTOK_VIDEO_ID = /^[1-9][0-9]{0,19}$/;

/** Which reading a counts file carries (EntryLinkCounts.reading, BountiesCounts.reading and the others'): the entry's check's (dev), or the final lock's (final). */
export const ENTRY_LINK_COUNTS_READINGS = ['check', 'deadline'] as const;
export type EntryLinkCountsReadingT = (typeof ENTRY_LINK_COUNTS_READINGS)[number];

/** What the platform answered of the video at that reading (EntryLinkCounts.video, YouTube's; TiktokVideoCounts.video, TikTok's). */
export const ENTRY_LINK_COUNTS_VIDEO = ['public', 'gone'] as const;
export type EntryLinkCountsVideoT = (typeof ENTRY_LINK_COUNTS_VIDEO)[number];

/** What the house found of a bounty at that reading (BountiesCountsRow.bounty): approved and public, or gone. */
export const BOUNTY_COUNTS_BOUNTY = ['live', 'gone'] as const;
export type BountyCountsBountyT = (typeof BOUNTY_COUNTS_BOUNTY)[number];

/** A USD amount as a counts file writes it: whole dollars (no leading zero, at most 12 digits), a point and two cents digits. */
export const USD_DECIMAL = /^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/;

/** What X answered of the post at that reading (XPostCounts.post). */
export const POST_COUNTS_POST = ['public', 'gone'] as const;
export type PostCountsPostT = (typeof POST_COUNTS_POST)[number];

/** One count: a whole number from 0, or null where the platform showed none. */
const Count = z.int().min(0).nullable();

/** A USD decimal string (USD_DECIMAL). */
const UsdDecimal = z.string().regex(USD_DECIMAL, 'a USD amount is written as dollars, a point and two cents digits, with no leading zero (such as "0.50" or "12.00")');

/** A video's counts, as the grader writes them for the scorer (the header). */
export const EntryLinkCounts = z
  .strictObject({
    format: z.literal(ENTRY_LINK_COUNTS_FORMAT),
    platform: z.literal('youtube'),
    video_id: z.string().regex(YOUTUBE_VIDEO_ID, "a YouTube video's id is 11 letters, digits, underscores and hyphens"),
    url: z
      .string()
      .max(2048)
      .regex(/^https:\/\/\S+$/, 'the video address is an https URL'),
    reading: z.enum(ENTRY_LINK_COUNTS_READINGS),
    at: IsoDateTime,
    video: z.enum(ENTRY_LINK_COUNTS_VIDEO),
    views: Count,
    likes: Count,
    comments: Count,
  })
  .refine((c) => c.video === 'public' || (c.views === null && c.likes === null && c.comments === null), {
    message: "a video read 'gone' carries no count: views, likes and comments are null",
    // Only on a file whose shape parsed.
    when: (payload) => payload.issues.length === 0,
  });
export type EntryLinkCountsT = z.infer<typeof EntryLinkCounts>;

/** A bounty's competition id as a bounty list's counts file writes it (BountiesCounts row `id`): a lowercase hyphenated uuid. */
export const BOUNTY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who a bounty list's counts file counts (ProgramEntryLink.counted, mirrored here so this file imports no bundle contract). */
export type BountiesCountsCountedT = 'paying' | 'all';

/**
 * One named bounty's row in a bounty list's counts file (the header), its entry_fee_usd above 0.00 under the count
 * 'paying' (BountiesCountsRow) and 0.00 or above under 'all' (BountiesCountsRowAll).
 */
function bountiesCountsRowOf(counted: BountiesCountsCountedT) {
  const fee =
    counted === 'all' ? UsdDecimal : UsdDecimal.refine((s) => /[1-9]/.test(s), { message: 'the entry fee is above 0.00', when: (payload) => payload.issues.length === 0 });
  return z
    .strictObject({
      slug: Slug,
      id: z.string().regex(BOUNTY_ID, "a bounty's id is a lowercase hyphenated uuid"),
      url: z.string().max(2048),
      bounty: z.enum(BOUNTY_COUNTS_BOUNTY),
      entrants: Count,
      entry_fees_usd: UsdDecimal.nullable(),
      pot_usd: UsdDecimal.nullable(),
      entry_fee_usd: fee,
    })
    .refine((c) => c.url === `https://make.fun/bounty/${c.slug}`, {
      path: ['url'],
      message: "the bounty's address is exactly https://make.fun/bounty/<slug>, of its own slug",
      // Only on a row whose shape parsed.
      when: (payload) => payload.issues.length === 0,
    })
    .refine(
      (c) =>
        c.bounty === 'gone'
          ? c.entrants === null && c.entry_fees_usd === null && c.pot_usd === null
          : c.entrants !== null && c.entry_fees_usd !== null && c.pot_usd !== null,
      {
        message: "a bounty is read 'gone' exactly when entrants, entry_fees_usd and pot_usd are all null: a live bounty carries all three, a gone one none",
        when: (payload) => payload.issues.length === 0,
      },
    );
}

/** One named bounty's row under the count 'paying' (BountiesCounts.bounties; the header): its entry fee above 0.00. */
export const BountiesCountsRow = bountiesCountsRowOf('paying');
/** One named bounty's row under the count 'all' (BountiesCountsAll.bounties): its entry fee 0.00 or above. */
export const BountiesCountsRowAll = bountiesCountsRowOf('all');
export type BountiesCountsRowT = z.infer<typeof BountiesCountsRowAll>;

/** A bounty list's counts of rows `row` (the header): the file's keys, and each slug and id once, by slug ascending. */
function bountiesCountsOf(row: typeof BountiesCountsRow | typeof BountiesCountsRowAll) {
  return z
    .strictObject({
      format: z.literal(BOUNTIES_COUNTS_FORMAT),
      reading: z.enum(ENTRY_LINK_COUNTS_READINGS),
      read_at: IsoDateTime,
      min_entrants: z.int().min(0),
      bounties: z.array(row).min(1).max(BOUNTIES_COUNTS_MAX),
    })
    .superRefine((c, ctx) => {
      // Each slug once and each id once, by slug ascending in code-unit order (a slug is ASCII, so every language's
      // plain string order agrees): one row a bounty, in the one order a scorer may rely on.
      const slugs = new Set<string>();
      const ids = new Set<string>();
      c.bounties.forEach((row, i) => {
        if (slugs.has(row.slug)) {
          ctx.addIssue({ code: 'custom', path: ['bounties', i, 'slug'], message: `${row.slug} is named twice: a bounty list's counts file holds each slug once` });
        } else if (i > 0 && row.slug < (c.bounties[i - 1]?.slug ?? '')) {
          ctx.addIssue({ code: 'custom', path: ['bounties', i, 'slug'], message: `${row.slug} is listed after ${c.bounties[i - 1]?.slug}: the rows are by slug ascending` });
        }
        if (ids.has(row.id)) ctx.addIssue({ code: 'custom', path: ['bounties', i, 'id'], message: `${row.id} is named twice: a bounty list's counts file holds each id once` });
        slugs.add(row.slug);
        ids.add(row.id);
      });
    }, {
      // Only on a file whose rows parsed.
      when: (payload) => payload.issues.length === 0,
    });
}

/** A bounty list's counts under the count 'paying', as the grader writes them for the scorer (the header). */
export const BountiesCounts = bountiesCountsOf(BountiesCountsRow);
/** A bounty list's counts under the count 'all' (the header): BountiesCounts with a bounty charging no fee's 0.00 read too. */
export const BountiesCountsAll = bountiesCountsOf(BountiesCountsRowAll);
export type BountiesCountsT = z.infer<typeof BountiesCountsAll>;

/** The schema of a bounty list's counts file under the count `counted`: BountiesCounts ('paying'), else BountiesCountsAll. */
export function bountiesCountsSchemaOf(counted: BountiesCountsCountedT): typeof BountiesCounts | typeof BountiesCountsAll {
  return counted === 'all' ? BountiesCountsAll : BountiesCounts;
}

/** What a bounty list's counted rows add up to (bountiesTotalsOf): whole numbers, the amounts in cents. */
export interface BountiesTotalsT {
  /** How many rows read live, counting or not. */
  live: number;
  /** How many rows count: live, with at least the least entrants. */
  bounties: number;
  /** The counted entrants of the counting rows, summed. */
  entrants: number;
  /** The paid entry fees of the counting rows, summed, in cents. */
  entry_fees_cents: number;
  /** The pots of the counting rows, summed, in cents. */
  pot_cents: number;
}

/** A USD decimal (USD_DECIMAL) as whole cents, read digit by digit (never through a float). */
function centsOf(usd: string): number {
  const point = usd.indexOf('.');
  return Number(usd.slice(0, point)) * 100 + Number(usd.slice(point + 1));
}

/**
 * The totals of a bounty list's rows (BountiesCounts.bounties, or any rows of the same four keys): a row counts when it
 * is live and its entrants are at least `minEntrants` (a whole number from 0; 0 counts every live row, one with no
 * entrant too); `entrants`, `entry_fees_cents` and `pot_cents` sum the counting rows, `live` counts every live row. A
 * live row's null count reads 0 (BountiesCountsRow carries none). Throws a RangeError for a `minEntrants` that is no
 * whole number from 0, or a sum past Number.MAX_SAFE_INTEGER (no file of bounded amounts a sponsor can fund reaches
 * it). Pure: it reads only its arguments.
 */
export function bountiesTotalsOf(
  rows: readonly Pick<BountiesCountsRowT, 'bounty' | 'entrants' | 'entry_fees_usd' | 'pot_usd'>[],
  minEntrants: number,
): BountiesTotalsT {
  if (!Number.isSafeInteger(minEntrants) || minEntrants < 0) throw new RangeError(`minEntrants is a whole number from 0, not ${minEntrants}`);
  const totals: BountiesTotalsT = { live: 0, bounties: 0, entrants: 0, entry_fees_cents: 0, pot_cents: 0 };
  for (const row of rows) {
    if (row.bounty !== 'live') continue;
    totals.live += 1;
    const entrants = row.entrants ?? 0;
    if (entrants < minEntrants) continue;
    totals.bounties += 1;
    totals.entrants += entrants;
    totals.entry_fees_cents += row.entry_fees_usd === null ? 0 : centsOf(row.entry_fees_usd);
    totals.pot_cents += row.pot_usd === null ? 0 : centsOf(row.pot_usd);
  }
  for (const [key, value] of Object.entries(totals)) {
    if (!Number.isSafeInteger(value)) throw new RangeError(`the ${key} total ${value} is past Number.MAX_SAFE_INTEGER`);
  }
  return totals;
}

/** An X post's counts, as the grader writes them for the scorer (the header). */
export const XPostCounts = z
  .strictObject({
    format: z.literal(POST_COUNTS_FORMAT),
    platform: z.literal('x'),
    post_id: z
      .string()
      .regex(X_POST_ID, "an X post's id is 1 to 20 decimal digits, no leading zero")
      .refine((id) => BigInt(id) < 2n ** 64n, {
        message: "an X post's id is below 2^64",
        // Only on an id of digits, which BigInt reads.
        when: (payload) => payload.issues.length === 0,
      }),
    url: z
      .string()
      .max(2048)
      .regex(/^https:\/\/\S+$/, 'the post address is an https URL'),
    reading: z.enum(ENTRY_LINK_COUNTS_READINGS),
    at: IsoDateTime,
    post: z.enum(POST_COUNTS_POST),
    views: Count,
    likes: Count,
    replies: Count,
    reposts: Count,
    quotes: Count,
  })
  .refine((c) => c.post === 'public' || (c.views === null && c.likes === null && c.replies === null && c.reposts === null && c.quotes === null), {
    message: "a post read 'gone' carries no count: views, likes, replies, reposts and quotes are null",
    // Only on a file whose shape parsed.
    when: (payload) => payload.issues.length === 0,
  });
export type XPostCountsT = z.infer<typeof XPostCounts>;

/** An X post's id in a posts counts file (XPostsCounts row post_id, pool_post_id): X_POST_ID, below 2^64; `what` names it in the refusal. */
function xPostIdOf(what: string) {
  return z
    .string()
    .regex(X_POST_ID, `${what} is 1 to 20 decimal digits, no leading zero`)
    .refine((id) => BigInt(id) < 2n ** 64n, {
      message: `${what} is below 2^64`,
      // Only on an id of digits, which BigInt reads.
      when: (payload) => payload.issues.length === 0,
    });
}

/**
 * The order of two X post ids (X_POST_ID: decimal, no leading zero) as numbers, which a posts counts file's rows go by:
 * the shorter id first, then code-unit order, the same as BigInt order on such ids and never a throw on any string.
 * Negative where `a` goes first. Pure.
 */
export function compareXPostIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One post's row in an X posts counts file (XPostsCounts.posts; the header). */
export const XPostsCountsRow = z
  .strictObject({
    post_id: xPostIdOf("an X post's id"),
    url: z
      .string()
      .max(2048)
      .regex(/^https:\/\/\S+$/, 'the post address is an https URL'),
    pool_post_id: xPostIdOf("the pool post's id"),
    post: z.enum(POST_COUNTS_POST),
    views: Count,
    likes: Count,
    replies: Count,
    reposts: Count,
    quotes: Count,
  })
  .refine((c) => c.post === 'public' || (c.views === null && c.likes === null && c.replies === null && c.reposts === null && c.quotes === null), {
    message: "a post read 'gone' carries no count: views, likes, replies, reposts and quotes are null",
    // Only on a row whose shape parsed.
    when: (payload) => payload.issues.length === 0,
  });
export type XPostsCountsRowT = z.infer<typeof XPostsCountsRow>;

/** An X pool link's posts counts, as the grader writes them for the scorer (the header). */
export const XPostsCounts = z
  .strictObject({
    format: z.literal(X_POSTS_COUNTS_FORMAT),
    platform: z.literal('x'),
    reading: z.enum(ENTRY_LINK_COUNTS_READINGS),
    at: IsoDateTime,
    posts: z.array(XPostsCountsRow).min(1).max(X_POSTS_COUNTS_MAX),
  })
  .superRefine(
    (c, ctx) => {
      // Each post once and each pool post once, by post id ascending as numbers: one row a post, tied to a pool post no
      // other row is, in the one order a scorer may rely on.
      const ids = new Set<string>();
      const pool = new Set<string>();
      c.posts.forEach((row, i) => {
        if (ids.has(row.post_id)) {
          ctx.addIssue({ code: 'custom', path: ['posts', i, 'post_id'], message: `${row.post_id} is named twice: a posts counts file holds each post once` });
        } else if (i > 0 && compareXPostIds(row.post_id, c.posts[i - 1]?.post_id ?? '') < 0) {
          ctx.addIssue({ code: 'custom', path: ['posts', i, 'post_id'], message: `${row.post_id} is listed after ${c.posts[i - 1]?.post_id}: the rows are by post id ascending` });
        }
        if (pool.has(row.pool_post_id)) {
          ctx.addIssue({ code: 'custom', path: ['posts', i, 'pool_post_id'], message: `pool post ${row.pool_post_id} is tied to two rows: each post is tied to a different pool post` });
        }
        ids.add(row.post_id);
        pool.add(row.pool_post_id);
      });
    },
    {
      // Only on a file whose rows parsed.
      when: (payload) => payload.issues.length === 0,
    },
  );
export type XPostsCountsT = z.infer<typeof XPostsCounts>;

/** A TikTok video's counts, as the grader writes them for the scorer (the header). */
export const TiktokVideoCounts = z
  .strictObject({
    format: z.literal(TIKTOK_COUNTS_FORMAT),
    platform: z.literal('tiktok'),
    video_id: z
      .string()
      .regex(TIKTOK_VIDEO_ID, "a TikTok video's id is 1 to 20 decimal digits, no leading zero")
      .refine((id) => BigInt(id) < 2n ** 64n, {
        message: "a TikTok video's id is below 2^64",
        // Only on an id of digits, which BigInt reads.
        when: (payload) => payload.issues.length === 0,
      }),
    url: z
      .string()
      .max(2048)
      .regex(/^https:\/\/\S+$/, 'the video address is an https URL'),
    reading: z.enum(ENTRY_LINK_COUNTS_READINGS),
    at: IsoDateTime,
    video: z.enum(ENTRY_LINK_COUNTS_VIDEO),
    views: Count,
    likes: Count,
    comments: Count,
    shares: Count,
    saves: Count,
  })
  .refine((c) => c.video === 'public' || (c.views === null && c.likes === null && c.comments === null && c.shares === null && c.saves === null), {
    message: "a video read 'gone' carries no count: views, likes, comments, shares and saves are null",
    // Only on a file whose shape parsed.
    when: (payload) => payload.issues.length === 0,
  });
export type TiktokVideoCountsT = z.infer<typeof TiktokVideoCounts>;

/**
 * A counts file of any format (parseEntryLinkCounts), each typed with the others' own keys absent: a strict file never
 * holds them, so a reader may ask `counts.video_id`, `counts.post` or `counts.shares` of any and read undefined where
 * its format carries none.
 */
export type CountsFileT =
  | (EntryLinkCountsT & { post_id?: never; post?: never; replies?: never; reposts?: never; quotes?: never; shares?: never; saves?: never })
  | (XPostCountsT & { video_id?: never; video?: never; comments?: never; shares?: never; saves?: never })
  | (TiktokVideoCountsT & { post_id?: never; post?: never; replies?: never; reposts?: never; quotes?: never });

/**
 * The counts a platform's counts file carries, which a bundle's `rank_by` may weigh (contracts/competition.ts
 * ProgramEntryLink.rank_by): a YouTube video's views, likes and comments; an X post's views, likes, replies, reposts and
 * quotes; a TikTok video's views, likes, comments, shares and saves.
 */
export const COUNTS_RANK_KEYS = {
  youtube: ['views', 'likes', 'comments'],
  x: ['views', 'likes', 'replies', 'reposts', 'quotes'],
  tiktok: ['views', 'likes', 'comments', 'shares', 'saves'],
} as const;
export type CountsPlatformT = keyof typeof COUNTS_RANK_KEYS;

/** Every count any platform's file carries (COUNTS_RANK_KEYS, joined), in that order. */
export const COUNTS_RANK_KEYS_ALL = ['views', 'likes', 'comments', 'replies', 'reposts', 'quotes', 'shares', 'saves'] as const;
export type CountsRankKeyT = (typeof COUNTS_RANK_KEYS_ALL)[number];

/** A bundle's weights (ProgramEntryLink.rank_by): each count it names, to a whole weight. */
export type CountsRankByT = Readonly<Partial<Record<CountsRankKeyT, number>>>;

/** The weights a bundle naming no `rank_by` ranks on: views alone (gta6-clipper-01's score). */
export const COUNTS_RANK_BY_DEFAULT: CountsRankByT = Object.freeze({ views: 1 });

/** Whether a counts file reads its post gone (a YouTube or a TikTok video's `video`, an X post's `post`). */
export function countsGone(counts: CountsFileT): boolean {
  switch (counts.platform) {
    case 'youtube':
      return counts.video === 'gone';
    case 'x':
      return counts.post === 'gone';
    case 'tiktok':
      return counts.video === 'gone';
  }
}

/**
 * A counts file's score under `rankBy` (ProgramEntryLink.rank_by; absent, COUNTS_RANK_BY_DEFAULT, views alone): the sum
 * of each named count times its weight, a null count as 0; 0 for a post read gone. A key the file's platform does not
 * count reads 0 (the loader refuses such a rank_by: server/competitions/load.ts entryLinkIssues). Pure: it reads only
 * its arguments.
 */
export function countsScoreOf(counts: CountsFileT, rankBy: CountsRankByT | undefined): number {
  if (countsGone(counts)) return 0;
  const weights = rankBy ?? COUNTS_RANK_BY_DEFAULT;
  const read = counts as Readonly<Partial<Record<CountsRankKeyT, number | null>>>;
  let score = 0;
  for (const key of COUNTS_RANK_KEYS_ALL) {
    const weight = weights[key];
    if (weight === undefined) continue;
    score += weight * (read[key] ?? 0);
  }
  return score;
}

/**
 * An X posts counts file's score under `rankBy` (ProgramEntryLink.rank_by; absent, COUNTS_RANK_BY_DEFAULT, views alone):
 * countsScoreOf of each row read as one post's counts, summed, so a gone row adds 0 and a null count reads 0. The dev
 * board's overlay and a pool bundle's sealed scorer mirror it. Pure: it reads only its arguments.
 */
export function xPostsScoreOf(
  file: { readonly posts: readonly Pick<XPostsCountsRowT, 'post' | 'views' | 'likes' | 'replies' | 'reposts' | 'quotes'>[] },
  rankBy: CountsRankByT | undefined,
): number {
  let score = 0;
  for (const row of file.posts) {
    const counts = { platform: 'x', post: row.post, views: row.views, likes: row.likes, replies: row.replies, reposts: row.reposts, quotes: row.quotes } as CountsFileT;
    score += countsScoreOf(counts, rankBy);
  }
  return score;
}

/**
 * A counts file's text, parsed by the schema `schemaOf` picks for its JSON, or the issues that refuse it: over
 * `maxBytes` (ENTRY_LINK_COUNTS_MAX_BYTES unless named; refused before it is parsed), not JSON, or not that schema.
 * Pure: it reads only its arguments.
 */
function parseCounts(
  text: string,
  schemaOf: (raw: unknown) => z.ZodType,
  maxBytes: number = ENTRY_LINK_COUNTS_MAX_BYTES,
): { ok: true; counts: unknown } | { ok: false; issues: string[] } {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) return { ok: false, issues: [`${bytes} bytes, over the ${maxBytes} a counts file holds`] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: ['not JSON'] };
  }
  const r = schemaOf(raw).safeParse(raw);
  if (r.success) return { ok: true, counts: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`) };
}

/**
 * A post's counts file's text, parsed, or the issues that refuse it (parseCounts): a file whose `format` is
 * POST_COUNTS_FORMAT is read as XPostCounts, one whose `format` is TIKTOK_COUNTS_FORMAT as TiktokVideoCounts, any other
 * as EntryLinkCounts (so a file of no format is refused as a YouTube video's, in the words it was before the other
 * formats existed). A bounty list's file is parseBountiesCounts'. Pure: it reads only `text`.
 */
export function parseEntryLinkCounts(text: string): { ok: true; counts: CountsFileT } | { ok: false; issues: string[] } {
  const r = parseCounts(text, (raw) => {
    const format = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { format?: unknown }).format : undefined;
    return format === POST_COUNTS_FORMAT ? XPostCounts : format === TIKTOK_COUNTS_FORMAT ? TiktokVideoCounts : EntryLinkCounts;
  });
  return r.ok ? { ok: true, counts: r.counts as CountsFileT } : r;
}

/**
 * A bounty list's counts file's text, parsed, or the issues that refuse it (parseCounts, over BOUNTIES_COUNTS_MAX_BYTES
 * refused before it is parsed), under the count `counted` (bountiesCountsSchemaOf: 'paying' unless named, an entry fee of
 * 0.00 refused; 'all' reads it). Pure: it reads only its arguments.
 */
export function parseBountiesCounts(text: string, counted: BountiesCountsCountedT = 'paying'): { ok: true; counts: BountiesCountsT } | { ok: false; issues: string[] } {
  const r = parseCounts(text, () => bountiesCountsSchemaOf(counted), BOUNTIES_COUNTS_MAX_BYTES);
  return r.ok ? { ok: true, counts: r.counts as BountiesCountsT } : r;
}

/**
 * An X posts counts file's text (XPostsCounts, makefun/x-posts-counts/v1), parsed, or the issues that refuse it
 * (parseCounts, over X_POSTS_COUNTS_MAX_BYTES refused before it is parsed). Read alone, as a bounty list's is: a pool
 * link's scorer knows its format, and parseEntryLinkCounts, whose one post's files every other scorer reads, keeps its
 * type and its refusals. Pure: it reads only `text`.
 */
export function parseXPostsCounts(text: string): { ok: true; counts: XPostsCountsT } | { ok: false; issues: string[] } {
  const r = parseCounts(text, () => XPostsCounts, X_POSTS_COUNTS_MAX_BYTES);
  return r.ok ? { ok: true, counts: r.counts as XPostsCountsT } : r;
}
