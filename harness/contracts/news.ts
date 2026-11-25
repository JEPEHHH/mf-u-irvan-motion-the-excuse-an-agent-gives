// news.make.fun's contract: the daily front page built from the WINNING entry of make.fun's daily bounty "Sum up
// <D Month>'s world news in one image" (server/releases/templates/news-image.ts, slug news-image-YYYYMMDD). The pipeline
// reads the winner's image into a NewsEdition, the store keeps it (server/news/store.ts; news_edition and news_story,
// server/db/schema.ts), and the server and the web app both render it, so every shape, helper and sentence they share
// lives here. A leaf like contracts/feedback.ts: no Node APIs, no DOM and no import from server/ (the web app imports it).
//
//   NEWS_SCHEMA                 the edition document's format, 'news-edition/1'
//   NEWS_REGIONS                the seven regions in reading order, each with its label; NEWS_REGION_IDS their ids
//   NEWS_TIERS                  a story's place on the page: lead (the top row), card (the grid), brief (the list)
//   NEWS_EDITION_STATUSES       a built edition's status: provisional (voting still open) or final
//   NEWS_ROW_STATUSES           news_edition.status: pending, provisional, final, failed, withheld (the pipeline's states)
//   NewsLink … NewsEdition      the edition document (zod schemas; each type is the schema's z.infer, same name)
//   NewsTldr, NEWS_TLDR_HOOK_CHARS, NEWS_TLDR_POINT_CHARS
//                               a story's TL;DR (a hook and one to three points, from its own article: server/news/tldr.ts)
//                               and the English lengths the writer is held to
//   illustrationSourceOf, NEWS_PICTURE_MIN_WIDTH, NEWS_PICTURE_MIN_HEIGHT, pictureSharp, pictureRank
//                               a story picture's source (absent: the winner's crop), the sharpness floor (960 x 540)
//                               and a picture's standing (a sharp crop over a sharp article photo over a drawn
//                               illustration over a low-res crop over none), which the pipeline never trades down
//   NewsVoting, NewsEditionRead, editionVoting
//                               a provisional edition's voting (when it closes, since when its leader is on the page),
//                               read with the edition (server/news/store.ts getEdition), never stored in it
//   NewsEditionView             GET one day: the edition with its neighbours, its formats' URLs and its voting
//   NewsDaysResponse            GET the days: every content-ready day, newest first, and the open bounty
//   NewsSearchResponse          GET search: matching stories across every day
//   isNewsHost, mainOriginForNewsHost, newsOriginForMain
//                               the news host (first DNS label 'news') and the main site's origin, each from the other;
//                               a brand host's main site is make.fun (contracts/news-brands.ts, which a server serves
//                               only where it is configured: server/routes/news.ts servedNewsBrandOf)
//   dayTitle, dayShortLabel, isNewsDay, newsDayOf
//                               day words ('Wednesday 18 November 2026', 'Tue 17 Nov'), a real day, an instant's day
//   newsUtcClock, newsVotingClosed, newsVotingWords
//                               an instant's UTC clock ('14:20'), whether a day's voting has closed at `now`, and its
//                               voting as the text formats say it ('Voting open until Sat 21 Nov 00:00 UTC; ...')
//   newsBountySlug, dayOfNewsBountySlug
//                               the day's bounty slug (news-image-YYYYMMDD) and back
//   storyAnchor, newsDayPath, newsEditionUrls, newsStoryUrl
//                               paths on the news host: '/<day>' (.json, .md, .txt) and '#story-<n>'
//   NEWS_STORY_SLUG_RE, NEWS_STORY_SLUG_MAX, storySlugOf, assignStorySlugs, withStorySlugs
//                               a story's slug (its own page's last path segment, frozen at its first save): a
//                               headline's ASCII words ('eu-proposes-a-45bn-loan-to-fund-ukraine-in-2027'), unique on
//                               its day, a slug carried from an earlier build kept first
//   newsStoryPath, newsStoryPageUrl
//                               a story's own page: '/<day>/<slug>', and its absolute URL in a locale
//   storyPublishedAt, storyIndexable
//                               when a story was first published, and whether its page is worth indexing (the one rule the
//                               head, the sitemaps and IndexNow share: words of its own and two independent reporting
//                               organisations, an aggregator's wrapper link such as MSN's not counted, and no problem)
//   NEWS_STORY_PROBLEM_KINDS, storyProblems, storyProblem, storySupportTexts, storySearchOnly
//                               what the reading of the image got wrong in a story (a headline its link contradicts, one
//                               that lost its subject, a name nothing backs, news searches its only links), and the texts
//                               that can back a headline (the build drops a brief with a problem: server/news/build.ts)
//   NEWS_ORG_RE, NEWS_OUTLET_ORGS, NEWS_WRAPPER_HOSTS, NEWS_WRAPPER_OWN_ORGS, newsOrgOfHost, isNewsWrapperHost,
//   outletOrgOf, countedOutletOrg, storyOutletOrgs
//                               a link's reporting organisation (its `org`, else its host's registrable domain folded
//                               through NEWS_OUTLET_ORGS: bbc.com and bbc.co.uk are 'bbc'), whether it counts (no
//                               news-search link, no wrapper's save a verified Yahoo or AOL piece), a story's distinct ones
//   NEWS_CHECK_VERDICTS, NewsCheck, storyCheckDigest, storyChecked
//                               a story's fact check (pass, partial, fail, unread; when; on which words), the 16-hex
//                               FNV-1a digest of the words it covers, and whether it passed on the words the story holds now
//   profileUrl, regionCounts, regionLabel
//   NEWS_LIMITS, clipNewsText   the most characters each text field holds (and the most stories, links and outlets),
//                               and a text cut at a word boundary to fit one (the build clips the model's words to them)
//   isDeletedHandle, creditByline
//                               a deleted account's tombstone handle, and the credit's entrant as every renderer names
//                               them ('@handle' and the profile; a deleted account NEWS_COPY.formerPlayer, no link)
//   formatCount                 a whole number with thousands separators, as en-US writes it ('19,452')
//   NEWS_COPY                   the English catalog's (contracts/news-i18n.ts NEWS_CATALOG_EN, newsCopyIn) words the web
//                               page and the server's crawl body both print (they must match), a
//                               news-search fallback link's name (newsSearch), the credit's agents line
//                               (agentsWorked: '19,452 AI agents worked on this') and a provisional day's stages
//                               (stages: 'Voting open', 'Closes Sat 00:00 UTC', 'Final edition') among them, and a
//                               day's share card's words (card: '15,485' over 'AI agents' over 'made this front page')
//   newsPictureCredit           a picture's credit ('Photo: Reuters', 'Illustration'; none on the winner's crop)
//
// Days are UTC calendar days, 'YYYY-MM-DD'. Every instant is ISO 8601 (zod's iso datetime, an offset allowed).

import { z } from 'zod';
import { isNewsBrandDevHost, NEWS_MAIN_SITE_ORIGIN, newsBrandHostOf } from './news-brands.ts';
import { message, NEWS_CATALOG_EN, newsCopyIn } from './news-i18n.ts';
import { isNewsLocaleTag, isTranslatedNewsLocale, localizedPath, NEWS_DEFAULT_LOCALE, onDemandNewsTag } from './news-locales.ts';

/** The edition document's format: a NewsEdition's `schema`. */
export const NEWS_SCHEMA = 'news-edition/1';

/** The regions in the order the page prints them, each with its label (the English catalog's, contracts/news-i18n.ts). */
export const NEWS_REGIONS = [
  { id: 'europe', label: message(NEWS_CATALOG_EN, 'region.europe') },
  { id: 'middle-east', label: message(NEWS_CATALOG_EN, 'region.middleEast') },
  { id: 'asia', label: message(NEWS_CATALOG_EN, 'region.asia') },
  { id: 'africa', label: message(NEWS_CATALOG_EN, 'region.africa') },
  { id: 'americas', label: message(NEWS_CATALOG_EN, 'region.americas') },
  { id: 'oceania', label: message(NEWS_CATALOG_EN, 'region.oceania') },
  { id: 'world', label: message(NEWS_CATALOG_EN, 'region.world') },
] as const;
export const NEWS_REGION_IDS = ['europe', 'middle-east', 'asia', 'africa', 'americas', 'oceania', 'world'] as const;
export const NewsRegionId = z.enum(NEWS_REGION_IDS);
export type NewsRegionId = z.infer<typeof NewsRegionId>;

/** lead: the top row's big stories; card: the grid; brief: the one-line "Also on" list. */
export const NEWS_TIERS = ['lead', 'card', 'brief'] as const;
export const NewsTier = z.enum(NEWS_TIERS);
export type NewsTier = z.infer<typeof NewsTier>;

/** A built edition: provisional while the bounty's voting is still open (its winner may change), final once resolved. */
export const NEWS_EDITION_STATUSES = ['provisional', 'final'] as const;
export const NewsEditionStatus = z.enum(NEWS_EDITION_STATUSES);
export type NewsEditionStatus = z.infer<typeof NewsEditionStatus>;

/**
 * news_edition.status, the pipeline's: pending (a winner's image is known, its edition not yet built), provisional and
 * final (built, as NEWS_EDITION_STATUSES), failed (the last build failed with none built before it), withheld (no front
 * page: its winning entry was taken down or is gone, or its bounty was cancelled; no content, the row kept for the
 * audit with why in its error, and never built again on its own).
 */
export const NEWS_ROW_STATUSES = ['pending', 'provisional', 'final', 'failed', 'withheld'] as const;
export type NewsRowStatus = (typeof NEWS_ROW_STATUSES)[number];

/**
 * Where a story link came from: gdelt (a GDELT article), bing (an article Bing News's RSS search named: its publisher's own
 * URL, never Bing's or Google's redirect), brave (one Brave's News Search API named), serper (one Serper's Google News
 * API named; both the publisher's own URL as well), model (the reader model named it), search (a news-search URL, no
 * article found).
 */
export const NEWS_LINK_VIAS = ['gdelt', 'bing', 'brave', 'serper', 'model', 'search'] as const;

export const NEWS_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const day = z.string().refine((s) => isNewsDay(s), 'a real UTC day, YYYY-MM-DD');
const instant = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(SHA256_RE, 'lowercase hex sha256');
const words = z.string().trim().min(1);

/**
 * The most characters each of an edition's text fields holds, and the most stories, links and outlets: about three
 * times the longest the real 18 November edition holds (tests/fixtures/news/2026-11-18.real.json: a 64-character
 * headline, a 143-character summary, 40 stories), so no real front page meets one and a runaway model answer never
 * reaches a page. The build clips the model's words to them (clipNewsText, server/news/build.ts assembleNewsEdition);
 * NewsEdition refuses anything longer.
 */
export const NEWS_LIMITS = {
  stories: 150,
  headline: 200,
  summary: 600,
  section: 80,
  place: 120,
  /** An outlet's name, credited or a link's. */
  outlet: 80,
  outlets: 20,
  links: 20,
  linkTitle: 300,
  /** A host name's most (RFC 1035). */
  domain: 253,
  url: 2048,
  alt: 300,
  kicker: 200,
  title: 120,
  handle: 100,
  entryTitle: 200,
  id: 100,
  model: 200,
  /**
   * A TL;DR's hook and each of its points as an edition holds them, a translation's included: the English is written to
   * NEWS_TLDR_HOOK_CHARS and NEWS_TLDR_POINT_CHARS (server/news/tldr.ts refuses longer), and a translation runs longer.
   */
  tldrHook: 200,
  tldrPoint: 200,
  /** The most points a TL;DR holds. */
  tldrPoints: 3,
  /**
   * A story's slug as an edition holds it: storySlugOf writes at most NEWS_STORY_SLUG_MAX, and assignStorySlugs's
   * '-2', '-3'… (or 'story-<n>') needs the rest.
   */
  slug: 100,
} as const;

/**
 * A TL;DR's English lengths, characters: the hook one line (the point), each point a short line. server/news/tldr.ts
 * refuses a model's answer past them; NEWS_LIMITS.tldrHook and tldrPoint leave a translation room.
 */
export const NEWS_TLDR_HOOK_CHARS = 90;
export const NEWS_TLDR_POINT_CHARS = 100;

/** `max` characters of text at most: `s` itself when it fits, else cut at its last space in reach with an ellipsis. */
export function clipNewsText(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  let cut = t.slice(0, Math.max(0, max - 1));
  // Never half a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  if (space >= max / 2) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

const httpUrl = z.url({ protocol: /^https?$/ }).max(NEWS_LIMITS.url);

/** words of at most `max` characters. */
const wordsMax = (max: number) => words.max(max);

/**
 * A reporting organisation's name as a link's `org` holds it: an NEWS_OUTLET_ORGS key ('ap', 'nbc-news') or a registrable
 * domain ('arkansasadvocate.com'), lowercase.
 */
export const NEWS_ORG_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;

/** One source link of a story. */
export const NewsLink = z.object({
  url: httpUrl,
  /** The outlet's name, as a reader knows it ('Reuters'). */
  outlet: wordsMax(NEWS_LIMITS.outlet),
  /** The URL's host without 'www.' ('reuters.com'). */
  domain: wordsMax(NEWS_LIMITS.domain),
  title: wordsMax(NEWS_LIMITS.linkTitle).optional(),
  publishedAt: instant.optional(),
  via: z.enum(NEWS_LINK_VIAS),
  /**
   * The organisation that reported it (NEWS_ORG_RE), where the server knows it better than the URL's host: a wire's copy
   * on another site (an AP story on abcnews.go.com: 'ap'), an MSN page's provider whose domain differs from the
   * article's, a Yahoo page verified as Yahoo's own reporting ('yahoo'). Absent: the host's (outletOrgOf).
   */
  org: z.string().regex(NEWS_ORG_RE, 'a lowercase organisation key or registrable domain').optional(),
  /**
   * The syndicated copy (an MSN or Yahoo page) this link was unwrapped from, https: read in its stead when the outlet's
   * own page refuses a reader (reuters.com answers a bot 401).
   */
  mirror: z.url({ protocol: /^https$/ }).max(NEWS_LIMITS.url).optional(),
});
export type NewsLink = z.infer<typeof NewsLink>;

/**
 * Where a story's picture came from, best first: cut from the winner's image ('winner'), the linked article's own preview
 * image ('article', credited to its outlet), or drawn by the house image model ('generated', shown as an illustration).
 */
export const NEWS_ILLUSTRATION_SOURCES = ['winner', 'article', 'generated'] as const;
export type NewsIllustrationSource = (typeof NEWS_ILLUSTRATION_SOURCES)[number];

/**
 * A story's picture, kept in the blob store under sha256 (a WebP, served at <news origin>/img/<sha256>.webp): cut from
 * the winner's image, else the linked article's preview image, else the house model's illustration (`source`, absent on
 * the winner's crop: an edition stored before the field holds only crops, and the store serves content as stored, never
 * parsed again, so a reader takes its source through illustrationSourceOf). `credit` names an article photo's outlet
 * ('Reuters'); none for the other two.
 */
export const NewsIllustration = z.object({
  sha256,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: wordsMax(NEWS_LIMITS.alt),
  source: z.enum(NEWS_ILLUSTRATION_SOURCES).optional(),
  credit: wordsMax(NEWS_LIMITS.outlet).optional(),
});
export type NewsIllustration = z.infer<typeof NewsIllustration>;

/** Where `ill` came from: its `source`, absent on the winner's crop (every picture stored before the field was one). */
export function illustrationSourceOf(ill: Pick<NewsIllustration, 'source'>): NewsIllustrationSource {
  return ill.source ?? 'winner';
}

/**
 * The least size a picture is sharp at, px: the story's dialog shows any story's picture about 740 css px wide (a lead,
 * a card and a brief alike), so a picture under 960 x 540 is drawn larger than it is on most screens (the owner's 18 Nov
 * screenshot: the hero's and tiles 2-5's winner crops, all under 600 wide, blurry).
 */
export const NEWS_PICTURE_MIN_WIDTH = 960;
export const NEWS_PICTURE_MIN_HEIGHT = 540;

/** Whether a picture is sharp: at least NEWS_PICTURE_MIN_WIDTH x NEWS_PICTURE_MIN_HEIGHT. */
export function pictureSharp(ill: Pick<NewsIllustration, 'width' | 'height'>): boolean {
  return ill.width >= NEWS_PICTURE_MIN_WIDTH && ill.height >= NEWS_PICTURE_MIN_HEIGHT;
}

/**
 * A story's picture's standing, best highest: a sharp winner's crop 5 (never replaced), a sharp article photo 4, the
 * house model's illustration 3, a low-res winner's crop 2 (kept only while nothing sharper can be had), a low-res article
 * photo 1 (one stored before the floor), none 0 (the page's locator tile stands in). A picture is only ever replaced by
 * one that stands higher (server/news/images.ts, store.ts setStoryIllustrations).
 */
export function pictureRank(ill: Pick<NewsIllustration, 'source' | 'width' | 'height'> | undefined): number {
  if (ill === undefined) return 0;
  const source = illustrationSourceOf(ill);
  if (source === 'generated') return 3;
  if (source === 'winner') return pictureSharp(ill) ? 5 : 2;
  return pictureSharp(ill) ? 4 : 1;
}

/** pictureRank's names for its standings. */
export const NEWS_PICTURE_RANK = { none: 0, lowResArticle: 1, lowResWinner: 2, generated: 3, article: 4, winner: 5 } as const;

export const NewsGeo = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
export type NewsGeo = z.infer<typeof NewsGeo>;

/**
 * What a TL;DR was written from: 'article' when its story's own article was read (its opening text, with the headline,
 * summary and link titles), 'sources' when no article text could be read (the headline, summary and link titles alone).
 */
export const NEWS_TLDR_BASES = ['article', 'sources'] as const;
export type NewsTldrBasis = (typeof NEWS_TLDR_BASES)[number];

/**
 * A story's TL;DR (the owner, 2026-11-20: "All story modals should incl descriptive text summarizing the story tldr in
 * adhd human conpregensible formst"), written by the house model from the story's own article (server/news/tldr.ts) and
 * checked before it is kept: `hook` one line, the point; `points` one to three short lines (what happened, why it
 * matters, what comes next only where the sources say it); `basis` what it was written from (the story's window says
 * nothing of it; the machine formats carry it).
 */
export const NewsTldr = z.object({
  hook: wordsMax(NEWS_LIMITS.tldrHook),
  points: z.array(wordsMax(NEWS_LIMITS.tldrPoint)).min(1).max(NEWS_LIMITS.tldrPoints),
  basis: z.enum(NEWS_TLDR_BASES),
});
export type NewsTldr = z.infer<typeof NewsTldr>;

/**
 * A story slug's shape: lowercase ASCII letters and digits in words joined by single hyphens ('xi-greets-trump'), the
 * news host's story route's last segment (/<day>/<slug>).
 */
export const NEWS_STORY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The most characters storySlugOf writes for a headline, cut at a word; NEWS_LIMITS.slug leaves room for a '-2'. */
export const NEWS_STORY_SLUG_MAX = 80;

/**
 * A story's fact check's verdicts: pass (both layers passed), partial (layer 1 passed, layer 2 not run), fail (a layer
 * found a miss), unread (no cited text could be read).
 */
export const NEWS_CHECK_VERDICTS = ['pass', 'partial', 'fail', 'unread'] as const;
export type NewsCheckVerdict = (typeof NEWS_CHECK_VERDICTS)[number];

/** storyCheckDigest's shape: 16 lowercase hex characters. */
export const NEWS_CHECK_DIGEST_RE = /^[0-9a-f]{16}$/;

/**
 * A story's fact check: its verdict, when it was reached (`at`), and the story's words it was reached on (`of`, their
 * storyCheckDigest): a story whose words have moved since is checked again, and is not storyChecked meanwhile.
 */
export const NewsCheck = z.object({
  verdict: z.enum(NEWS_CHECK_VERDICTS),
  at: instant,
  of: z.string().regex(NEWS_CHECK_DIGEST_RE, '16 lowercase hex characters'),
});
export type NewsCheck = z.infer<typeof NewsCheck>;

/** One story on the page. */
export const NewsStory = z.object({
  /** The number the image prints beside the story, else its place in reading order (1-based); unique in an edition. */
  n: z.number().int().positive(),
  tier: NewsTier,
  region: NewsRegionId,
  /** The section tag as printed ('APEC SUMMIT'), without its region. */
  section: wordsMax(NEWS_LIMITS.section).optional(),
  /** Where it happened, a place name ('Manila'). */
  place: wordsMax(NEWS_LIMITS.place).optional(),
  headline: wordsMax(NEWS_LIMITS.headline),
  summary: wordsMax(NEWS_LIMITS.summary).optional(),
  /** The outlets the image credits, as printed (['NPR', 'Reuters']); empty when it credits none. */
  outlets: z.array(wordsMax(NEWS_LIMITS.outlet)).max(NEWS_LIMITS.outlets),
  links: z.array(NewsLink).max(NEWS_LIMITS.links),
  illustration: NewsIllustration.optional(),
  geo: NewsGeo.optional(),
  /** Its TL;DR (NewsTldr), once the sweep has written one (server/news/tldr.ts); absent before. */
  tldr: NewsTldr.optional(),
  /**
   * 'en' on a story of a translated edition (NewsEdition.locale) still in English: one of its fields is not translated
   * yet, so it shows whole in English (lang="en"), never mixed. Absent on a translated story and on the stored English
   * edition, which never carries it.
   */
  lang: z.literal(NEWS_DEFAULT_LOCALE).optional(),
  /**
   * Its own page's slug (/<day>/<slug>, NEWS_STORY_SLUG_RE), unique in its edition: given at the story's first save
   * (assignStorySlugs) and carried by its headline across rebuilds, so its URL holds. Absent on an edition stored before
   * the field: a reader takes it through withStorySlugs.
   */
  slug: z.string().max(NEWS_LIMITS.slug).regex(NEWS_STORY_SLUG_RE, 'lowercase ASCII words joined by single hyphens').optional(),
  /**
   * When the story first went on a page of its day (its first save), carried with its slug; absent on an edition stored
   * before the field: a reader takes it through storyPublishedAt (the edition's read time).
   */
  publishedAt: instant.optional(),
  /** Its fact check (NewsCheck), once the news-sources job has checked it; absent before. */
  check: NewsCheck.optional(),
});
export type NewsStory = z.infer<typeof NewsStory>;

/** Who made the front page: the winning entry and its entrant, and how many entries the bounty drew. */
export const NewsCredit = z.object({
  handle: wordsMax(NEWS_LIMITS.handle),
  profileUrl: httpUrl,
  entryTitle: wordsMax(NEWS_LIMITS.entryTitle),
  submissionId: wordsMax(NEWS_LIMITS.id),
  bountySlug: wordsMax(NEWS_LIMITS.id),
  bountyUrl: httpUrl,
  imageUrl: httpUrl,
  /** The entry's win rate in the bounty's judging, in millionths (991000 = 99.1%). */
  winRateMicro: z.number().int().min(0).max(1_000_000).optional(),
  /**
   * The day's bounty's entries, the count its page on make.fun shows (the board's submissionCount for a signed-out
   * reader: server/news/store.ts newsEntryCount), printed under the byline as NEWS_COPY.agentsWorked. Stored at the
   * build and refreshed when the edition turns final; while it is provisional (the bounty still taking entries) every
   * read of it carries the count as it stands (server/news/store.ts getEdition).
   */
  entryCount: z.number().int().min(0),
});
export type NewsCredit = z.infer<typeof NewsCredit>;

export const NewsRegionCount = z.object({ id: NewsRegionId, count: z.number().int().min(0) });
export type NewsRegionCount = z.infer<typeof NewsRegionCount>;

export const NewsProvenance = z.object({
  /** The sha256 of the winning image the edition was read from. */
  artifactSha256: sha256,
  /** The model that read it. */
  model: wordsMax(NEWS_LIMITS.model),
  extractedAt: instant,
  /** When its stories' links were checked, if they were. */
  verifiedAt: instant.optional(),
  /**
   * The logic that read it (server/news/build.ts NEWS_BUILD_VERSION); absent on an edition built before it was recorded
   * (version 1). A served day read by older logic is read again (build.ts newsRebuildDay).
   */
  buildVersion: z.number().int().positive().optional(),
});
export type NewsProvenance = z.infer<typeof NewsProvenance>;

/**
 * A translated edition's translation, read with it (never stored in the English edition): from English, by `model`, at
 * `translatedAt`, and whether every story is translated (complete; else the stories still in English carry lang 'en').
 */
export const NewsTranslation = z.object({
  from: z.literal(NEWS_DEFAULT_LOCALE),
  model: wordsMax(NEWS_LIMITS.model),
  translatedAt: instant,
  complete: z.boolean(),
});
export type NewsTranslation = z.infer<typeof NewsTranslation>;

/**
 * One day's front page. `stories` hold unique `n`s; `regions` is the region band as the image prints it (else
 * regionCounts(stories)), each region at most once. `locale` and `translation` mark a translated edition (a language tag
 * other than English, a NEWS_LOCALES one or any other asked for on demand, and how it was translated: the two together,
 * or neither); the English original, as stored, carries neither, and none of its stories a `lang`.
 */
export const NewsEdition = z
  .object({
    schema: z.literal(NEWS_SCHEMA),
    day,
    status: NewsEditionStatus,
    /** The day in words, dayTitle(day): 'Wednesday 18 November 2026'. */
    title: wordsMax(NEWS_LIMITS.title),
    kicker: wordsMax(NEWS_LIMITS.kicker).optional(),
    stories: z.array(NewsStory).max(NEWS_LIMITS.stories),
    regions: z.array(NewsRegionCount),
    credit: NewsCredit,
    provenance: NewsProvenance,
    updatedAt: instant,
    /**
     * The locale a translated edition is in: a contracts/news-locales.ts NEWS_LOCALES tag, or any other language a reader
     * asked for on demand (contracts/news-locales.ts onDemandNewsTag: canonical BCP 47 of a language Intl names, never 'en',
     * 'und' or a tag that reads as a NEWS_LOCALES locale); absent: the English original.
     */
    locale: z
      .string()
      .refine((t): boolean => isTranslatedNewsLocale(t) && (isNewsLocaleTag(t) || onDemandNewsTag(t) === t), 'a NEWS_LOCALES tag other than English, or another language a reader may ask for')
      .optional(),
    translation: NewsTranslation.optional(),
  })
  .superRefine((e, ctx) => {
    if ((e.locale === undefined) !== (e.translation === undefined)) {
      ctx.addIssue({ code: 'custom', path: [e.locale === undefined ? 'locale' : 'translation'], message: 'a translated edition carries its locale and its translation, the English one neither' });
    }
    if (e.locale === undefined) {
      e.stories.forEach((s, i) => {
        if (s.lang !== undefined) ctx.addIssue({ code: 'custom', path: ['stories', i, 'lang'], message: 'a story of the English edition carries no lang' });
      });
    }
    const seen = new Set<number>();
    e.stories.forEach((s, i) => {
      if (seen.has(s.n)) ctx.addIssue({ code: 'custom', path: ['stories', i, 'n'], message: `story number ${s.n} appears twice` });
      seen.add(s.n);
    });
    const slugs = new Set<string>();
    e.stories.forEach((s, i) => {
      if (s.slug === undefined) return;
      if (slugs.has(s.slug)) ctx.addIssue({ code: 'custom', path: ['stories', i, 'slug'], message: `story slug ${s.slug} appears twice` });
      slugs.add(s.slug);
    });
    const regions = new Set<string>();
    e.regions.forEach((r, i) => {
      if (regions.has(r.id)) ctx.addIssue({ code: 'custom', path: ['regions', i, 'id'], message: `region ${r.id} appears twice` });
      regions.add(r.id);
    });
  });
export type NewsEdition = z.infer<typeof NewsEdition>;

// ---------------------------------------------------------------- API views

/** An edition's formats, absolute URLs on the news host. */
export const NewsEditionUrls = z.object({ html: httpUrl, json: httpUrl, md: httpUrl, txt: httpUrl });
export type NewsEditionUrls = z.infer<typeof NewsEditionUrls>;

/**
 * A provisional edition's voting, read with it (server/news/store.ts getEdition), never stored in the document: closesAt
 * when its bounty's voting closes (the bounty's deadline), and leaderSince the edition's last build (news_edition.built_at),
 * which a provisional day takes only when the board's leader changes (server/news/build.ts: a new leader or image sends the
 * row back to pending and it is built again for it), so it is when the leader this page credits was picked up; null where
 * no build time is known. The page draws them as its stages (src/news/DayStages.tsx); every text format says them
 * (newsVotingWords).
 */
export const NewsVoting = z.object({ closesAt: instant, leaderSince: instant.nullable() });
export type NewsVoting = z.infer<typeof NewsVoting>;

/**
 * An edition as a read answers it: the document and, read with it (server/news/store.ts getEdition), its voting (a
 * NewsVoting while it is provisional, null once final). A document no store read (a fixture, a build's own) carries
 * none, which every renderer reads as null (editionVoting).
 */
export type NewsEditionRead = NewsEdition & { voting?: NewsVoting | null };

/** The voting an edition shows: its read's while it is provisional, else (final, or none read) null. */
export function editionVoting(e: Pick<NewsEditionRead, 'status' | 'voting'>): NewsVoting | null {
  return e.status === 'provisional' ? (e.voting ?? null) : null;
}

/**
 * GET one day: the edition, the content-ready days either side of it (null at an end), its formats' URLs and its voting
 * (NewsVoting while provisional, null once final; an answer from before the field reads as null).
 */
export const NewsEditionView = z.intersection(
  NewsEdition,
  z.object({ prev: day.nullable(), next: day.nullable(), urls: NewsEditionUrls, voting: NewsVoting.nullable().default(null) }),
);
export type NewsEditionView = z.infer<typeof NewsEditionView>;

export const NewsDaySummary = z.object({
  day,
  title: words,
  status: NewsEditionStatus,
  storyCount: z.number().int().min(0),
  winnerHandle: words,
});
export type NewsDaySummary = z.infer<typeof NewsDaySummary>;

/** GET the days: content-ready days, newest first, and the bounty now open for tomorrow's front page (null when none). */
export const NewsDaysResponse = z.object({
  days: z.array(NewsDaySummary),
  openBounty: z.object({ slug: words, url: httpUrl, deadline: instant }).nullable(),
});
export type NewsDaysResponse = z.infer<typeof NewsDaysResponse>;

/** One search hit: a story of a day, and its URL on the news host (the story's own page, /<day>/<slug>: newsStoryPageUrl). */
export const NewsSearchResult = z.object({
  day,
  n: z.number().int().positive(),
  tier: NewsTier,
  region: NewsRegionId,
  headline: words,
  summary: words.optional(),
  url: httpUrl,
  links: z.array(NewsLink),
  /**
   * 'en' on a hit asked in a translated locale (?lang=) that is still in English: its story not translated yet, or left
   * whole in English, so its headline and summary are the English ones (lang="en"), as its story's tile is
   * (NewsStory.lang). Absent on a translated hit and on every hit of an English search.
   */
  lang: z.literal(NEWS_DEFAULT_LOCALE).optional(),
});
export type NewsSearchResult = z.infer<typeof NewsSearchResult>;

export const NewsSearchResponse = z.object({ q: z.string(), results: z.array(NewsSearchResult) });
export type NewsSearchResponse = z.infer<typeof NewsSearchResponse>;

/**
 * The 202 of a first ask for a day in a language beyond the built locales (an on-demand tag: contracts/news-locales.ts
 * onDemandNewsTag): the day is being translated into `lang` (its English name `language`); ask the same `url` again in
 * about `retryAfter` seconds (the answer's Retry-After), when it answers 200 with the translated edition.
 */
export const NewsTranslationQueued = z.object({
  status: z.literal('translating'),
  day,
  lang: z.string(),
  language: z.string(),
  retryAfter: z.number().int().positive(),
  url: httpUrl,
});
export type NewsTranslationQueued = z.infer<typeof NewsTranslationQueued>;

// ---------------------------------------------------------------- helpers

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** A host's name without its port, lowercased: 'News.Make.fun:443' -> 'news.make.fun'. An IPv6 literal stays whole. */
function bareHost(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h;
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/** Whether a hostname is a news host: its first DNS label is 'news' (news.make.fun, news.dev.make.fun, news.localhost). A port is ignored. */
export function isNewsHost(hostname: string): boolean {
  const labels = bareHost(hostname).split('.');
  return labels.length >= 2 && labels[0] === 'news' && labels.every((l) => l !== '');
}

/** 'https', 'https:' or 'https://' as 'https:'. */
function schemeOf(protocol: string): string {
  return `${protocol.replace(/:?\/*$/, '')}:`;
}

/**
 * The main site's origin for a news host: the host without its 'news.' (its port kept), under `protocol` ('https' or
 * 'https:'). news.dev.make.fun -> https://dev.make.fun. On a brand host (contracts/news-brands.ts newsBrandHostOf) the
 * main site is make.fun (NEWS_MAIN_SITE_ORIGIN), whatever `protocol`; on a brand host's dev form (newsbyagents.localhost)
 * the dev server's localhost, its port kept, under `protocol`. A host that is no news host is answered as its own origin.
 */
export function mainOriginForNewsHost(host: string, protocol: string): string {
  const h = host.trim().toLowerCase();
  if (newsBrandHostOf(h) !== null) {
    if (!isNewsBrandDevHost(h)) return NEWS_MAIN_SITE_ORIGIN;
    const colon = h.lastIndexOf(':');
    return `${schemeOf(protocol)}//localhost${colon === -1 ? '' : h.slice(colon)}`;
  }
  const main = isNewsHost(h) ? h.slice('news.'.length) : h;
  return `${schemeOf(protocol)}//${main}`;
}

/** The news origin for the main site's origin: https://make.fun -> https://news.make.fun. A news origin (a brand host's too) is answered unchanged. */
export function newsOriginForMain(origin: string): string {
  const u = new URL(origin);
  return isNewsHost(u.host) || newsBrandHostOf(u.host) !== null ? `${u.protocol}//${u.host}` : `${u.protocol}//news.${u.host}`;
}

/** The anchor of story `n` on its day's page: 'story-7'. */
export function storyAnchor(n: number): string {
  return `story-${n}`;
}

/** An edition's formats, as NewsEditionUrls names them. */
export const NEWS_FORMATS = ['html', 'json', 'md', 'txt'] as const;
export type NewsFormat = (typeof NEWS_FORMATS)[number];

/** A day's path on the news host: '/2026-11-18' for its page, '/2026-11-18.json' (.md, .txt) for its other formats. */
export function newsDayPath(day: string, format: NewsFormat = 'html'): string {
  dateOf(day);
  return format === 'html' ? `/${day}` : `/${day}.${format}`;
}

/** Every format's absolute URL of a day on the news origin (NewsEditionView.urls). */
export function newsEditionUrls(newsOrigin: string, day: string): NewsEditionUrls {
  const o = newsOrigin.replace(/\/+$/, '');
  return { html: `${o}${newsDayPath(day)}`, json: `${o}${newsDayPath(day, 'json')}`, md: `${o}${newsDayPath(day, 'md')}`, txt: `${o}${newsDayPath(day, 'txt')}` };
}

/** A story's URL: its day's page at its anchor ('https://news.make.fun/2026-11-18#story-7'). */
export function newsStoryUrl(newsOrigin: string, day: string, n: number): string {
  return `${newsOrigin.replace(/\/+$/, '')}${newsDayPath(day)}#${storyAnchor(n)}`;
}

// ---------------------------------------------------------------- a story's own page

/** Whether `s` is a story slug an edition may hold: NEWS_STORY_SLUG_RE, at most NEWS_LIMITS.slug characters. */
export function isStorySlug(s: unknown): s is string {
  return typeof s === 'string' && s.length <= NEWS_LIMITS.slug && NEWS_STORY_SLUG_RE.test(s);
}

/**
 * Latin letters NFKD leaves whole (no base letter plus a mark), as a slug writes them: 'Øresund' -> 'oresund',
 * 'Łódź' -> 'lodz', 'Straße' -> 'strasse'. Lowercase only: storySlugOf lowercases first.
 */
const SLUG_LETTERS: Readonly<Record<string, string>> = {
  æ: 'ae',
  ð: 'd',
  đ: 'd',
  ħ: 'h',
  ı: 'i',
  ł: 'l',
  ŋ: 'ng',
  ø: 'o',
  œ: 'oe',
  ß: 'ss',
  þ: 'th',
  ŧ: 't',
};

/**
 * A headline's slug: lowercased, NFKD with its marks dropped ('Bogotá' -> 'bogota'), apostrophes dropped ("Xi's" ->
 * 'xis'), a few Latin letters NFKD keeps whole spelled in ASCII (SLUG_LETTERS), then every run of anything but a-z and
 * 0-9 one hyphen ('€45bn' -> '45bn'), none at either end; past NEWS_STORY_SLUG_MAX cut at its last hyphen in reach (a
 * single longer word cut at the limit). '' for a headline with no ASCII letter or digit (an all-Cyrillic one):
 * assignStorySlugs gives that story 'story-<n>'.
 */
export function storySlugOf(headline: string): string {
  const s = headline
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/['‘’ʼ]/g, '')
    .replace(/[^\x00-\x7f]/g, (c) => SLUG_LETTERS[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= NEWS_STORY_SLUG_MAX) return s;
  const cut = s.slice(0, NEWS_STORY_SLUG_MAX + 1).lastIndexOf('-');
  return cut > 0 ? s.slice(0, cut) : s.slice(0, NEWS_STORY_SLUG_MAX);
}

const TIER_INDEX = new Map<string, number>(NEWS_TIERS.map((t, i) => [t, i]));

/**
 * Every story with its slug, in the order given. Walked in page order (the lead row, the cards, the briefs, each by
 * its number: server/news/head.ts storiesInPageOrder's rule), so an earlier story keeps the plainer slug:
 *   - a carried slug is kept first: `carried`'s for the story's number, else the story's own `slug` (a valid one,
 *     isStorySlug, that no story before it in page order kept);
 *   - every other story gets storySlugOf(headline), else 'story-<n>' when that is empty, with '-2', '-3'… on the first
 *     free one when it is taken.
 * `reserved` names slugs the day's page once held (server/db/schema.ts newsStorySlug): an old URL must never come to
 * show another story, so a story keeps a reserved slug only as its own carried one (`carried`'s for its number), and
 * a story's own `slug` or a derived slug in `reserved` is passed over for the next free '-2', '-3'….
 * Deterministic: the same stories, carry and reserve give the same slugs. server/news/store.ts saveBuiltEdition
 * carries a rebuilt story's slug by its headline (`carried`) and reserves the day's history.
 */
export function assignStorySlugs<S extends Pick<NewsStory, 'n' | 'tier' | 'headline' | 'slug'>>(
  stories: readonly S[],
  carried?: ReadonlyMap<number, string>,
  reserved?: ReadonlySet<string>,
): (S & { slug: string })[] {
  const order = stories.map((_, i) => i).sort((a, b) => TIER_INDEX.get(stories[a]!.tier)! - TIER_INDEX.get(stories[b]!.tier)! || stories[a]!.n - stories[b]!.n);
  const taken = new Set<string>();
  const slugs: (string | undefined)[] = stories.map(() => undefined);
  for (const i of order) {
    const s = stories[i]!;
    const own = carried?.get(s.n);
    const kept = [own, s.slug].find((c) => isStorySlug(c) && !taken.has(c) && (c === own || reserved?.has(c) !== true));
    if (kept === undefined) continue;
    taken.add(kept);
    slugs[i] = kept;
  }
  for (const i of order) {
    if (slugs[i] !== undefined) continue;
    const s = stories[i]!;
    const base = storySlugOf(s.headline) || storyAnchor(s.n);
    let slug = base;
    for (let k = 2; taken.has(slug) || reserved?.has(slug) === true; k++) slug = `${base}-${k}`;
    taken.add(slug);
    slugs[i] = slug;
  }
  return stories.map((s, i) => ({ ...s, slug: slugs[i]! }));
}

/**
 * The edition with every story's slug: unchanged (the same object) when each has one, else every missing one filled by
 * assignStorySlugs with no carry (an edition stored before the field), the slugs it holds kept. Deterministic, so every
 * read of an unmigrated day names the same URLs.
 */
export function withStorySlugs<E extends { stories: readonly NewsStory[] }>(edition: E): E & { stories: (NewsStory & { slug: string })[] } {
  if (edition.stories.every((s) => s.slug !== undefined)) return edition as E & { stories: (NewsStory & { slug: string })[] };
  return { ...edition, stories: assignStorySlugs(edition.stories) };
}

/** When a story was first published: its own publishedAt, else (stored before the field) its edition's read time. */
export function storyPublishedAt(story: Pick<NewsStory, 'publishedAt'>, edition: { provenance: Pick<NewsProvenance, 'extractedAt'> }): string {
  return story.publishedAt ?? edition.provenance.extractedAt;
}

/**
 * Hosts whose story URLs wrap another outlet's article: a syndication page (MSN, Yahoo, AOL), a Google News redirect, an
 * aggregator's (NewsBreak, Flipboard, Ground News, Apple News). Matched by suffix, so 'www.msn.com', 'uk.news.yahoo.com'
 * and 'finance.yahoo.com' are all wrappers. A link on one counts as no outlet (storyOutletOrgs), save a Yahoo or AOL page
 * whose `org` names that wrapper's own organisation ('yahoo', 'aol': NEWS_WRAPPER_OWN_ORGS), which the reader writes only
 * after verifying the page is that organisation's own reporting; an MSN, Google News or aggregator link never counts,
 * whatever `org` it holds.
 */
export const NEWS_WRAPPER_HOSTS = [
  'msn.com',
  'news.google.com',
  'news.yahoo.com',
  'sports.yahoo.com',
  'yahoo.com',
  'aol.com',
  'newsbreak.com',
  'flipboard.com',
  'ground.news',
  'apple.news',
] as const;

/** The wrappers' organisations that also report on their own (a verified Yahoo Finance piece): see NEWS_WRAPPER_HOSTS. */
export const NEWS_WRAPPER_OWN_ORGS = ['yahoo', 'aol'] as const;

/**
 * One organisation key for every registrable domain of one newsroom (newsOrgOfHost): the wires, newsrooms that publish
 * under several domains, and the wrappers that report on their own. A domain named nowhere here is its own organisation.
 */
export const NEWS_OUTLET_ORGS = {
  ap: ['apnews.com', 'ap.org'],
  reuters: ['reuters.com'],
  afp: ['afp.com'],
  dpa: ['dpa.com', 'dpa-international.com'],
  bbc: ['bbc.com', 'bbc.co.uk'],
  guardian: ['theguardian.com', 'guardian.co.uk'],
  cnn: ['cnn.com'],
  'nbc-news': ['nbcnews.com', 'msnbc.com'],
  politico: ['politico.com', 'politico.eu'],
  aljazeera: ['aljazeera.com', 'aljazeera.net'],
  dw: ['dw.com'],
  'france-medias-monde': ['france24.com', 'rfi.fr'],
  nikkei: ['nikkei.com'],
  yahoo: ['yahoo.com'],
  aol: ['aol.com'],
} as const satisfies Record<string, readonly string[]>;

const ORG_OF_DOMAIN: ReadonlyMap<string, string> = new Map(Object.entries(NEWS_OUTLET_ORGS).flatMap(([org, domains]) => domains.map((d) => [d, org] as const)));

/**
 * Second-level labels under a two-letter country TLD that a registrable domain sits below ('bbc.co.uk', 'abc.net.au',
 * 'nhk.or.jp'): the light rule newsOrgOfHost uses instead of the public suffix list (a package the web app would carry).
 * It can only merge two outlets (under a country's own second level), never split one.
 */
const GENERIC_SLDS: ReadonlySet<string> = new Set(['ac', 'co', 'com', 'edu', 'go', 'gob', 'gov', 'mil', 'ne', 'net', 'nic', 'or', 'org', 'ltd', 'plc', 'sch']);

/** A host lowercased, its trailing dot and a leading 'www.' dropped. */
function normalHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  return h.startsWith('www.') ? h.slice(4) : h;
}

/**
 * The organisation a host belongs to: its registrable domain (the last two labels, or the last three under a two-letter
 * TLD whose second-level label is generic: GENERIC_SLDS), folded through NEWS_OUTLET_ORGS. 'edition.cnn.com' -> 'cnn',
 * 'www.bbc.co.uk' -> 'bbc', 'abc.net.au' -> 'abc.net.au', 'timesofindia.indiatimes.com' -> 'indiatimes.com'. An
 * organisation key, a single label or an IP address is answered as it is (so 'ap' -> 'ap').
 */
export function newsOrgOfHost(host: string): string {
  const h = normalHost(host);
  if (h.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(h)) return h;
  const labels = h.split('.');
  const keep = labels.length >= 3 && labels.at(-1)!.length === 2 && GENERIC_SLDS.has(labels.at(-2)!) ? 3 : 2;
  const domain = labels.slice(-keep).join('.');
  return ORG_OF_DOMAIN.get(domain) ?? domain;
}

/** A link's host: its URL's hostname lowercased, a leading 'www.' dropped (its `domain` when the URL does not parse). */
function linkHost(link: Pick<NewsLink, 'url' | 'domain'>): string {
  let host: string;
  try {
    host = new URL(link.url).hostname;
  } catch {
    host = link.domain;
  }
  return normalHost(host);
}

/** Whether a host is a wrapper's (NEWS_WRAPPER_HOSTS, by suffix: 'uk.news.yahoo.com' is; 'notmsn.com' is not). */
export function isNewsWrapperHost(host: string): boolean {
  const h = normalHost(host);
  return NEWS_WRAPPER_HOSTS.some((w) => h === w || h.endsWith(`.${w}`));
}

/**
 * The organisation a link's reporting belongs to: its `org` when set, else its host's (newsOrgOfHost), either folded
 * through NEWS_OUTLET_ORGS (an `org` written as a domain, 'apnews.com', is 'ap' too).
 */
export function outletOrgOf(link: Pick<NewsLink, 'url' | 'domain' | 'org'>): string {
  return newsOrgOfHost(link.org ?? linkHost(link));
}

const WRAPPER_OWN_ORGS: ReadonlySet<string> = new Set(NEWS_WRAPPER_OWN_ORGS);

/**
 * The organisation a link counts as for storyOutletOrgs, else null: a news-search link (`via` 'search') is no source,
 * and a wrapper's link (isNewsWrapperHost) counts only when its `org` names that wrapper's own organisation and that
 * organisation reports on its own (NEWS_WRAPPER_OWN_ORGS: a Yahoo page with `org` 'yahoo'); an MSN or Google News link
 * never does.
 */
export function countedOutletOrg(link: Pick<NewsLink, 'url' | 'domain' | 'via' | 'org'>): string | null {
  if (link.via === 'search') return null;
  const host = linkHost(link);
  if (host === '') return null;
  const org = outletOrgOf(link);
  if (org === '') return null;
  if (!isNewsWrapperHost(host)) return org;
  const wrapperOrg = newsOrgOfHost(host);
  return link.org !== undefined && org === wrapperOrg && WRAPPER_OWN_ORGS.has(wrapperOrg) ? org : null;
}

/**
 * The distinct organisations a story's links count as (countedOutletOrg), in link order ('reuters', 'ap',
 * 'usatoday.com'): bbc.com and bbc.co.uk one, edition.cnn.com and cnn.com one, an AP story on abcnews.go.com (`org`
 * 'ap') AP's; a news-search link and a wrapper's not counted, save a wrapper's own verified reporting.
 */
export function storyOutletOrgs(story: { links: readonly Pick<NewsLink, 'url' | 'domain' | 'via' | 'org'>[] }): string[] {
  const orgs = new Set<string>();
  for (const link of story.links) {
    const org = countedOutletOrg(link);
    if (org !== null) orgs.add(org);
  }
  return [...orgs];
}

/** The fields storyCheckDigest covers: the story's words a check read. */
export type NewsCheckedFields = Pick<NewsStory, 'headline' | 'summary' | 'place' | 'outlets' | 'tldr'> & { links: readonly Pick<NewsLink, 'url'>[] };

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a of a text's UTF-8 bytes, 16 lowercase hex characters. */
function fnv1a64(text: string): string {
  let h = FNV64_OFFSET;
  for (const byte of new TextEncoder().encode(text)) h = ((h ^ BigInt(byte)) * FNV64_PRIME) & U64;
  return h.toString(16).padStart(16, '0');
}

/**
 * The words a story's check is reached on, as 16 hex characters (a 64-bit FNV-1a, NewsCheck.of): its headline,
 * summary, place, printed outlets, TL;DR hook and points, and its links' URLs sorted (a reordering moves nothing).
 * Any edit to one of them moves it, so a check on older words is stale (storyChecked). Pure: the same on every runtime.
 */
export function storyCheckDigest(story: NewsCheckedFields): string {
  const urls = story.links.map((l) => l.url).sort();
  const tldr = story.tldr === undefined ? null : [story.tldr.hook, story.tldr.points];
  return fnv1a64(JSON.stringify([story.headline, story.summary ?? null, story.place ?? null, story.outlets, tldr, urls]));
}

/** Whether a story's check passed on the words it holds now: verdict 'pass' and `of` its storyCheckDigest. */
export function storyChecked(story: NewsCheckedFields & Pick<NewsStory, 'check'>): boolean {
  return story.check?.verdict === 'pass' && story.check.of === storyCheckDigest(story);
}

/**
 * Whether a story's own page is worth indexing: it says something of its own (a TL;DR or a summary) AND at least two
 * independent organisations report it (storyOutletOrgs: two distinct organisations, one newsroom's several domains
 * one, news-search links and aggregator wrappers such as MSN not counted). THE rule: the story page's head (else robots
 * noindex), the news sitemaps and IndexNow all ask it.
 *
 * Why two: a page that paraphrases one outlet's article, made at scale, is what Google's spam policy calls scaled
 * content and its rater guidelines (4.6.6) rate Lowest; a story several outlets carried, summed up across them, is not
 * (the per-story SEO research, 2026-11-23). On that day 0 of 35 stories had two outlets, so for now almost no story
 * page is indexed; source enrichment, planned separately, is what raises the count.
 *
 * And it has no problem (storyProblem: a headline its link contradicts, one that lost its subject, one only news
 * searches back): a page the reading garbled is never offered to a search engine. `dayTexts` (its day's
 * storySupportTexts) adds the unsupported-name check; a reader of the one story alone passes none.
 */
export function storyIndexable(
  story: Pick<NewsStory, 'tldr' | 'summary' | 'links'> & Partial<Pick<NewsStory, 'headline' | 'outlets' | 'place' | 'section'>>,
  dayTexts?: readonly string[],
): boolean {
  if (!((story.tldr !== undefined || (story.summary ?? '').trim() !== '') && storyOutletOrgs(story).length >= 2)) return false;
  return story.headline === undefined || storyProblem({ ...story, headline: story.headline }, dayTexts) === null;
}

// ---------------------------------------------------------------- a story's problems

/**
 * What can be wrong with a story as the reading of the winning image left it (the day-page census of 2026-11-23,
 * scripts/news-garbled-census.ts: 15 of the 240 stories of 17-22 Nov, every one a real defect on a hand check), most
 * serious first:
 *   polarity      its headline says the opposite of a link's title: where both name a measured quantity (a price, an
 *                 index, a rate, a toll), the first market word (rises / falls, hits a high / slides), or, where both
 *                 speak of a deal, the first deal word (lands, reached, signed / collapses, failed, stalls) points the
 *                 other way ('Gold hits all-time high' over 'Gold Extends Losses ...')
 *   fragment      its headline lost its subject: it opens on a lowercase verb ('says it shot down 2 US drones'), or on
 *                 a reporting verb no headline opens on ('Says ...', 'Warns ...')
 *   unsupported   its headline names a capitalised word (a person, a place, an organisation) that neither its own words
 *                 (summary, TL;DR, link titles and outlets, printed outlets, place, section) nor its day's other stories'
 *                 ever mention: a name the reading invented or garbled ('Kenya: Jephcire banned 3 years')
 *   search-only   its every link is a news search (via 'search', or a news.google.com/search URL): no article was found
 */
export const NEWS_STORY_PROBLEM_KINDS = ['polarity', 'fragment', 'unsupported', 'search-only'] as const;
export type NewsStoryProblemKind = (typeof NEWS_STORY_PROBLEM_KINDS)[number];

/** One problem of a story: its kind, and what showed it, in words for a log ('unsupported headline word: Jephcire'). */
export interface NewsStoryProblem {
  kind: NewsStoryProblemKind;
  detail: string;
}

/** The fields storyProblem reads of a story: its headline and links, and every text that can back its headline. */
export type NewsProblemStory = Pick<NewsStory, 'headline'> & {
  links: readonly Pick<NewsLink, 'url' | 'via' | 'outlet' | 'title'>[];
} & Partial<Pick<NewsStory, 'summary' | 'outlets' | 'place' | 'section'>> & { tldr?: Pick<NewsTldr, 'hook' | 'points'> };

/**
 * Words a headline capitalises for grammar or convention, never as a name: articles, prepositions, numbers written
 * out, months and weekdays, currency codes and the news vocabulary every headline shares (the census's list). A
 * capitalised word is a name to back only when it is none of these.
 */
const PROBLEM_COMMON_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'nor', 'so', 'yet', 'for', 'at', 'by', 'in', 'of', 'on', 'to', 'up', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'he', 'she', 'they', 'we', 'you', 'i', 'his', 'her', 'their', 'our', 'your', 'my', 'who', 'whom', 'whose', 'which',
  'what', 'when', 'where', 'why', 'how', 'after', 'before', 'over', 'under', 'with', 'from', 'into', 'onto', 'amid', 'about', 'against', 'between', 'during', 'since',
  'until', 'while', 'new', 'first', 'last', 'next', 'more', 'most', 'least', 'fewer', 'several', 'many', 'some', 'all', 'both', 'each', 'every', 'no', 'not', 'now',
  'then', 'than', 'say', 'says', 'said', 'set', 'top', 'key', 'big', 'major', 'second', 'third', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'dozen', 'million', 'billion', 'trillion', 'thousand', 'hundred', 'per', 'cent', 'percent', 'gmt', 'utc', 'am', 'pm', 'us', 'uk', 'eu',
  'un', 'ai', 'ap', 'afp', 'reuters', 'bloomberg', 'gold', 'oil', 'police', 'army', 'government', 'president', 'minister', 'court', 'world', 'jan', 'feb', 'mar',
  'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mp', 'mps', 'eur', 'usd', 'gbp', 'yen', 'yuan', 'rupee',
  'rupees', 'dollar', 'dollars', 'pound', 'pounds',
  // Beyond the census: the continents, the compass and the world's chambers, names no reading invents (a build's day,
  // with no TL;DR written yet, backed 'Europe' and 'House Speaker' nowhere on the 18-19 Nov days).
  'earth', 'europe', 'european', 'asia', 'asian', 'africa', 'african', 'america', 'americas', 'american', 'oceania', 'arctic', 'antarctic', 'pacific', 'atlantic',
  'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'middle', 'house', 'senate', 'parliament', 'congress', 'speaker', 'cabinet',
  'category', 'final',
]);

/**
 * What a market axis needs in both texts: a measured quantity that moves (a price, a market or an index, a commodity, a
 * currency, a rate, an economic figure, a toll or a count), so 'a road span fell into the sea' never meets 'Crimean
 * Bridge hit hard' (#71's dry run: 'hit' read as a market move up).
 */
const PROBLEM_MARKET_NOUNS =
  /\b(?:prices?|pricing|costs?|markets?|stocks?|shares?|equit(?:y|ies)|index|indexes|indices|futures|bonds?|yields?|treasur(?:y|ies)|gilts?|gold|silver|copper|platinum|palladium|bullion|metals?|oil|crude|brent|wti|gas|commodit(?:y|ies)|wheat|corn|soy(?:beans?)?|coffee|cocoa|sugar|bitcoin|btc|ether(?:eum)?|crypto(?:currenc(?:y|ies))?|tokens?|currenc(?:y|ies)|dollar|euro|yen|yuan|renminbi|sterling|pound|rupees?|rupiah|pesos?|lira|r[ou]bles?|francs?|forex|dow|nasdaq|s&p|ftse|nikkei|dax|cac|sensex|nifty|kospi|asx|hang seng|wall st(?:reet)?|valuations?|inflation|cpi|gdp|growth|economy|recession|unemployment|jobless(?:ness)?|jobs|payrolls|exports?|imports?|trade surplus|deficit|sales|profits?|earnings|revenues?|output|wages?|rates?|interest|toll|tolls|cases|infections|turnout|ratings?|approval|polls?|temperatures?)\b/i;

/** What a deal axis needs in both texts: a deal, talks or an accord of some kind. */
const PROBLEM_DEAL_NOUNS = /\b(?:deals?|talks|agreements?|pacts?|accords?|treat(?:y|ies)|truces?|ceasefires?|compacts?)\b/i;

/**
 * The polarity axes, each a word list up and one down, read only where both texts name what the axis is about
 * (`needs`): `market` the census's (prices, records, gains and losses) over a measured quantity (PROBLEM_MARKET_NOUNS),
 * `deal` a deal's or a talks' outcome (PROBLEM_DEAL_NOUNS), so 'a missile lands' never meets 'talks failed'.
 */
const PROBLEM_AXES = [
  {
    axis: 'market',
    needs: PROBLEM_MARKET_NOUNS,
    up: ['rise', 'rises', 'rose', 'rising', 'risen', 'surge', 'surges', 'surged', 'climb', 'climbs', 'climbed', 'gain', 'gains', 'gained', 'high', 'highs', 'record', 'jump', 'jumps', 'jumped', 'soar', 'soars', 'soared', 'rally', 'rallies', 'rallied', 'hit', 'hits', 'top', 'tops', 'topped', 'strong', 'stronger', 'advance', 'advances', 'advanced'],
    down: ['fall', 'falls', 'fell', 'fallen', 'falling', 'drop', 'drops', 'dropped', 'plunge', 'plunges', 'plunged', 'slide', 'slides', 'slid', 'sink', 'sinks', 'sank', 'sunken', 'decline', 'declines', 'declined', 'low', 'lows', 'down', 'loss', 'losses', 'lose', 'loses', 'lost', 'weak', 'weaker', 'slump', 'slumps', 'slumped', 'cut', 'cuts', 'lower', 'lowered', 'tumble', 'tumbles', 'tumbled', 'retreat', 'retreats', 'retreated'],
  },
  {
    axis: 'deal',
    needs: PROBLEM_DEAL_NOUNS,
    up: ['land', 'lands', 'landed', 'reach', 'reaches', 'reached', 'sign', 'signs', 'signed', 'agree', 'agrees', 'agreed', 'seal', 'seals', 'sealed'],
    down: ['collapse', 'collapses', 'collapsed', 'fail', 'fails', 'failed', 'deadlock', 'deadlocks', 'deadlocked', 'stall', 'stalls', 'stalled'],
  },
].map(({ axis, needs, up, down }) => ({ axis, needs, up: new RegExp(`\\b(?:${up.join('|')})\\b`, 'i'), down: new RegExp(`\\b(?:${down.join('|')})\\b`, 'i') }));

/** Verbs a reading keeps when it loses its sentence's subject: a headline opening on one, lowercase, is a fragment. */
const PROBLEM_OPENING_VERBS: ReadonlySet<string> = new Set([
  'says', 'say', 'said', 'beats', 'beat', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'may', 'might', 'must', 'plans', 'plan',
  'hits', 'hit', 'wins', 'won', 'kills', 'kill', 'takes', 'take', 'gets', 'get', 'keeps', 'keep', 'makes', 'make', 'calls', 'call', 'cuts', 'cut', 'signs', 'signed',
  'warns', 'warn', 'seeks', 'seek', 'faces', 'face', 'holds', 'hold', 'strikes', 'strike', 'lands', 'land', 'flies', 'fly', 'returns', 'return', 'sets', 'set',
  'votes', 'vote', 'backs', 'back', 'names', 'name', 'joins', 'join', 'ends', 'end', 'starts', 'start', 'opens', 'open', 'closes', 'close', 'raises', 'raise',
  'lowers', 'lower', 'drops', 'drop', 'falls', 'fall', 'rises', 'rise', 'gains', 'gain', 'loses', 'lose',
]);

/**
 * Reporting verbs no headline opens on even capitalised ('Says it shot down ...'): a fragment whose first letter the
 * build has since capitalised still reads as one.
 */
const PROBLEM_SUBJECTLESS_VERBS: ReadonlySet<string> = new Set(['says', 'warns', 'vows', 'urges', 'denies', 'insists']);

/** A text's words, punctuation kept only inside one ('Ust-Luga', "Iran's", 'M5.7'). */
function problemWords(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? [];
}

/** A word as problems compare it: no diacritics, no possessive, no quotes, lowercase. */
function problemForm(word: string): string {
  return word
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’']s$/, '')
    .replace(/^[’'"]+|[’'"]+$/g, '');
}

/** Every form a text offers as backing: each word and hyphen part (problemForm), and its singular when it reads plural. */
function problemForms(text: string, into: Set<string> = new Set()): Set<string> {
  for (const word of problemWords(text)) {
    for (const part of word.split(/[-–—]/)) {
      const form = problemForm(part);
      if (form === '') continue;
      into.add(form);
      if (form.length > 3 && form.endsWith('s')) into.add(form.slice(0, -1));
      if (form.length > 4 && form.endsWith('es')) into.add(form.slice(0, -2));
    }
  }
  return into;
}

/**
 * The texts a story offers to back a headline, its own and its day's other stories': its summary, TL;DR, link titles
 * and outlets, printed outlets, place and section (never a headline: one garbled reading cannot back another). A build
 * hands storyProblem every story's of its day (`stories.flatMap(storySupportTexts)`).
 */
export function storySupportTexts(story: Omit<NewsProblemStory, 'headline'>): string[] {
  return [
    story.summary ?? '',
    story.tldr?.hook ?? '',
    ...(story.tldr?.points ?? []),
    ...story.links.map((l) => l.title ?? ''),
    ...story.links.map((l) => l.outlet),
    ...(story.outlets ?? []),
    story.place ?? '',
    story.section ?? '',
  ].filter((t) => t !== '');
}

/** The forms of a day's texts, kept per array: a build asks storyProblem of every story with the one array. */
const DAY_FORMS = new WeakMap<readonly string[], Set<string>>();

function dayFormsOf(dayTexts: readonly string[]): Set<string> {
  let forms = DAY_FORMS.get(dayTexts);
  if (forms === undefined) {
    forms = new Set();
    for (const text of dayTexts) problemForms(text, forms);
    DAY_FORMS.set(dayTexts, forms);
  }
  return forms;
}

/** Whether every one of a story's links (one at least) is a news search: via 'search', or a news.google.com/search URL. */
export function storySearchOnly(story: { links: readonly Pick<NewsLink, 'url' | 'via'>[] }): boolean {
  return story.links.length > 0 && story.links.every((l) => l.via === 'search' || /^https?:\/\/news\.google\.com\/search\b/i.test(l.url));
}

/**
 * A headline's capitalised words that nothing backs (see NEWS_STORY_PROBLEM_KINDS's `unsupported`): not its first
 * word, no acronym (FBI, NATO: a name the reading got right), no common word (PROBLEM_COMMON_WORDS), and absent from
 * the story's own texts and the day's (diacritics, a possessive and a plural set aside).
 */
function unsupportedNames(story: NewsProblemStory, day: ReadonlySet<string>): string[] {
  const own = problemForms(storySupportTexts(story).join(' '));
  const backed = (form: string): boolean => PROBLEM_COMMON_WORDS.has(form) || own.has(form) || day.has(form);
  const out = new Set<string>();
  problemWords(story.headline).forEach((word, index) => {
    if (index === 0) return;
    for (const part of word.split(/[-–—]/)) {
      if (!/^\p{Lu}/u.test(part) || !/\p{L}{2}/u.test(part) || /^[A-Z]{2,6}$/.test(part)) continue;
      const form = problemForm(part);
      if (form.length < 2 || backed(form) || (form.endsWith('s') && backed(form.slice(0, -1)))) continue;
      out.add(part);
    }
  });
  return [...out];
}

/** A text's direction on one axis: +1 when its first word of the axis is an up one, -1 a down one, 0 none. */
function axisDirection(text: string, axis: (typeof PROBLEM_AXES)[number]): number {
  const up = text.search(axis.up);
  const down = text.search(axis.down);
  if (up < 0 && down < 0) return 0;
  return down < 0 || (up >= 0 && up < down) ? 1 : -1;
}

/**
 * A title's contradiction of a headline on one polarity axis (headlineContradicts): the axis, and the headline's and
 * the title's directions on it (+1 up, -1 down, never the same).
 */
export interface HeadlineContradiction {
  axis: 'market' | 'deal';
  headline: number;
  title: number;
}

/**
 * How `title` contradicts `headline` on `axis`, else null: only where both name what the axis is about (its `needs`: a
 * market axis a measured quantity, a deal axis a deal).
 */
function axisContradiction(headline: string, title: string, axis: (typeof PROBLEM_AXES)[number]): HeadlineContradiction | null {
  if (!axis.needs.test(headline) || !axis.needs.test(title)) return null;
  const said = axisDirection(headline, axis);
  if (said === 0) return null;
  const told = axisDirection(title, axis);
  return told !== 0 && told !== said ? { axis: axis.axis as HeadlineContradiction['axis'], headline: said, title: told } : null;
}

/**
 * How a title contradicts a headline on a polarity axis (PROBLEM_AXES, in their order: the first market word of each
 * points the other way, where both name a measured quantity: PROBLEM_MARKET_NOUNS; the first deal word, where both
 * name a deal: PROBLEM_DEAL_NOUNS), else null. THE polarity
 * rule: storyProblems' `polarity` asks it of each link title, and server/news/enrich.ts's gate of each page it would
 * append (so an appended link never makes its story unindexable). 'Gold hits all-time high' against 'Gold plunges from
 * all-time high': the market axis, the headline up, the title down. Pure.
 */
export function headlineContradicts(headline: string, title: string): HeadlineContradiction | null {
  for (const axis of PROBLEM_AXES) {
    const c = axisContradiction(headline, title, axis);
    if (c !== null) return c;
  }
  return null;
}

/** The first link title the headline contradicts on an axis (each axis over every link in turn), in words; null when none. */
function contradiction(story: NewsProblemStory): string | null {
  for (const axis of PROBLEM_AXES) {
    for (const link of story.links) {
      if (link.title === undefined) continue;
      const c = axisContradiction(story.headline, link.title, axis);
      if (c !== null) return `${c.axis}: headline ${c.headline > 0 ? 'up' : 'down'}, link title ${c.title > 0 ? 'up' : 'down'}: ${JSON.stringify(link.title)}`;
    }
  }
  return null;
}

/** The verb a headline that lost its subject opens on, else null (see NEWS_STORY_PROBLEM_KINDS's `fragment`). */
function openingVerb(headline: string): string | null {
  const first = problemWords(headline.trim())[0];
  if (first === undefined) return null;
  const form = problemForm(first);
  if (/^\p{Ll}/u.test(headline.trim()) && PROBLEM_OPENING_VERBS.has(form)) return first;
  return /^\p{Lu}\p{Ll}+$/u.test(first) && PROBLEM_SUBJECTLESS_VERBS.has(form) ? first : null;
}

/**
 * Every problem of a story (NEWS_STORY_PROBLEM_KINDS), most serious first; none: []. `dayTexts` are its day's stories'
 * backing texts (storySupportTexts of each); without them (undefined) the `unsupported` check is not made, the rest are
 * (a reader of one story alone, as the story page's head is). Pure.
 */
export function storyProblems(story: NewsProblemStory, dayTexts?: readonly string[]): NewsStoryProblem[] {
  const out: NewsStoryProblem[] = [];
  const contra = contradiction(story);
  if (contra !== null) out.push({ kind: 'polarity', detail: contra });
  const verb = openingVerb(story.headline);
  if (verb !== null) out.push({ kind: 'fragment', detail: `the headline opens on the verb ${JSON.stringify(verb)}: its subject is lost` });
  if (dayTexts !== undefined) {
    const names = unsupportedNames(story, dayFormsOf(dayTexts));
    if (names.length > 0) out.push({ kind: 'unsupported', detail: `unsupported headline word${names.length === 1 ? '' : 's'}: ${names.join(', ')}` });
  }
  if (storySearchOnly(story)) out.push({ kind: 'search-only', detail: 'its only links are news searches' });
  return out;
}

/** A story's most serious problem (storyProblems' first), else null. */
export function storyProblem(story: NewsProblemStory, dayTexts?: readonly string[]): NewsStoryProblem | null {
  return storyProblems(story, dayTexts)[0] ?? null;
}

/** A story's own page's path on the news host: '/2026-11-18/xi-greets-trump-on-the-tarmac-in-shenzhen'. */
export function newsStoryPath(day: string, slug: string): string {
  dateOf(day);
  if (!isStorySlug(slug)) throw new RangeError(`not a story slug: ${JSON.stringify(slug)}`);
  return `/${day}/${slug}`;
}

/**
 * A story's own page's absolute URL in `locale`: English unprefixed ('https://news.make.fun/2026-11-18/<slug>'), a
 * NEWS_LOCALES tag under its prefix (contracts/news-locales.ts localizedPath: '/es/2026-11-18/<slug>'), and any other
 * tag (an on-demand one, which has no page of its own) the English page.
 */
export function newsStoryPageUrl(newsOrigin: string, day: string, slug: string, locale: string = NEWS_DEFAULT_LOCALE): string {
  const path = newsStoryPath(day, slug);
  return `${newsOrigin.replace(/\/+$/, '')}${isNewsLocaleTag(locale) ? localizedPath(locale, path) : path}`;
}

/** Whether `s` is a real UTC calendar day written YYYY-MM-DD ('2026-02-30' is not). */
export function isNewsDay(s: unknown): s is string {
  if (typeof s !== 'string' || !NEWS_DAY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function dateOf(day: string): Date {
  if (!isNewsDay(day)) throw new RangeError(`not a news day: ${JSON.stringify(day)}`);
  return new Date(`${day}T00:00:00Z`);
}

/** The day in words, in UTC: '2026-11-18' -> 'Wednesday 18 November 2026'. Throws a RangeError on anything but a news day. */
export function dayTitle(day: string): string {
  const d = dateOf(day);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The day's short label, for the day arrows: '2026-11-17' -> 'Tue 17 Nov'. Throws a RangeError on anything but a news day. */
export function dayShortLabel(day: string): string {
  const d = dateOf(day);
  return `${WEEKDAYS[d.getUTCDay()]!.slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)}`;
}

/** The news day an instant falls in (UTC): its 'YYYY-MM-DD'. */
export function newsDayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** An instant's time on the UTC clock, hours and minutes: '2026-11-19T14:20:31Z' -> '14:20'. The same on every runtime (no Intl). */
export function newsUtcClock(at: string | Date): string {
  const d = new Date(at);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Whether a day's voting has closed at `now` (ms): its closesAt reached. */
export function newsVotingClosed(voting: Pick<NewsVoting, 'closesAt'>, now: number): boolean {
  return now >= Date.parse(voting.closesAt);
}

/** An instant as the text formats stamp it, with its day: '2026-11-21T00:00:00Z' -> 'Sat 21 Nov 00:00 UTC'. */
const textStamp = (at: string): string => `${dayShortLabel(newsDayOf(new Date(at)))} ${newsUtcClock(at)} UTC`;

/**
 * A provisional edition's voting as every text format says it (the markdown, the plain text, the feeds' items): the
 * stepper's facts (src/news/DayStages.tsx) in one sentence, each instant with its day, so it reads the same whenever
 * it is read: 'Voting open until Sat 21 Nov 00:00 UTC; this front page can change until the winner is picked. Leader
 * since Thu 19 Nov 14:20 UTC.' With no voting read, the first clause without its time; with no build time, no leader.
 */
export function newsVotingWords(voting: NewsVoting | null): string {
  const s = NEWS_COPY.stages;
  const until = voting === null ? s.open : `${s.open} until ${textStamp(voting.closesAt)}`;
  const leader = voting === null || voting.leaderSince === null ? '' : ` ${s.leaderSince} ${textStamp(voting.leaderSince)}.`;
  return `${until}; ${s.mayChange}.${leader}`;
}

/** The daily bounty's slug for a day, as server/releases/templates/news-image.ts newsImageSlug: '2026-11-18' -> 'news-image-20261118'. */
export function newsBountySlug(day: string): string {
  dateOf(day);
  return `news-image-${day.replaceAll('-', '')}`;
}

/** The day a daily news bounty's slug covers, else null: 'news-image-20261118' -> '2026-11-18'. */
export function dayOfNewsBountySlug(slug: string): string | null {
  const m = /^news-image-(\d{4})(\d{2})(\d{2})$/.exec(slug);
  if (m === null) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return isNewsDay(day) ? day : null;
}

/** An entrant's public profile on the main site: `${mainOrigin}/u/${handle}` (src/routes/match.ts USER_PREFIX). */
export function profileUrl(mainOrigin: string, handle: string): string {
  return `${mainOrigin.replace(/\/+$/, '')}/u/${encodeURIComponent(handle)}`;
}

/**
 * The prefix of the handle a deleted account's tombstone takes (server/profile/handle.ts DELETED_HANDLE_PREFIX, restated:
 * this leaf imports nothing of server/; tests/unit/news-contract.test.ts holds the two equal).
 */
export const NEWS_DELETED_HANDLE_PREFIX = 'deleted-';

/** Whether a credit's handle is a deleted account's tombstone's (deleted-<hex>, server/profile/handle.ts deletedHandle). */
export function isDeletedHandle(handle: string): boolean {
  return handle.startsWith(NEWS_DELETED_HANDLE_PREFIX);
}

/**
 * The credit's entrant as every renderer names them (the page, the crawl body, the text formats, the feeds, the JSON-LD):
 * '@'+handle and their profile URL; a deleted account (isDeletedHandle) NEWS_COPY.formerPlayer and no link, as no page
 * names it.
 */
export function creditByline(credit: Pick<NewsCredit, 'handle' | 'profileUrl'>): { name: string; url: string | null } {
  return isDeletedHandle(credit.handle) ? { name: NEWS_COPY.formerPlayer, url: null } : { name: `@${credit.handle}`, url: credit.profileUrl };
}

/** A whole number with thousands separators, as en-US writes it: 19452 -> '19,452'. The same on every runtime (no Intl). */
export function formatCount(n: number): string {
  const t = String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${t}` : t;
}

/** How many stories each region holds, in NEWS_REGIONS order, regions with none left out. */
export function regionCounts(stories: readonly Pick<NewsStory, 'region'>[]): NewsRegionCount[] {
  const counts = new Map<NewsRegionId, number>();
  for (const s of stories) counts.set(s.region, (counts.get(s.region) ?? 0) + 1);
  return NEWS_REGION_IDS.filter((id) => counts.has(id)).map((id) => ({ id, count: counts.get(id)! }));
}

/** A region's label: 'middle-east' -> 'Middle East'. */
export function regionLabel(id: NewsRegionId): string {
  return NEWS_REGIONS.find((r) => r.id === id)!.label;
}

// ---------------------------------------------------------------- copy

/**
 * The words both the web page and the server's crawl body print (the public views must say the same): the English
 * catalog's (contracts/news-i18n.ts NEWS_CATALOG_EN, newsCopyIn): change one there, never in a renderer. Among them:
 *
 *   stages          a provisional day's stages, the owner's 'Stages' pick (2026-11-19, mockup v3): the page's stepper
 *                   (src/news/DayStages.tsx: 'Voting open', then 'Closes Sat 00:00 UTC', then 'Final edition'; once the
 *                   voting has closed, 'Voting open' done and 'Voting closed, picking the winner' current; 'Leader since
 *                   14:20 UTC' beside them), the crawl body's and the share card's words for it, and the text formats'
 *                   sentence (newsVotingWords). `name` is the stepper's name for assistive tech; `closes` step 2 before
 *                   the close ('Closes Sat 00:00 UTC': closesAt's weekday and UTC time), `closesUnknown` with no closing
 *                   time read; `done` is said after a step that is over (its disc's check is drawn alone)
 *   newsSearch      a news-search fallback link's name (NewsLink via 'search': no article was found), wherever a story's
 *                   sources are listed
 *   formerPlayer    a deleted account, as a credit names it (creditByline): no handle, no profile
 *   agentsWorked    the line under the byline, linked to the day's bounty: its entries (NewsCredit.entryCount), the
 *                   owner's words (2026-11-19): '19,452 AI agents worked on this', '1 AI agent worked on this'
 *   card            a day's share card, the owner's 'Big stat' pick (2026-11-19, mockup v3: "this one is cool for the og
 *                   metadata per page for sure"; server/news/og.ts): the day's entries huge ('15,485'), `agents` under
 *                   them, then `made`. 'this' front page, never 'today's': a card is kept by its address and read on
 *                   later days. `alt` is its og:image:alt and twitter:image:alt (server/news/head.ts editionCardImage):
 *                   '15,485 AI agents made the front page for Thursday 19 November 2026: <the lead headline>.'
 *   pictureCredit   a picture's credit words by its source (newsPictureCredit): an article's photo, the house model's
 *                   illustration
 */
export const NEWS_COPY = newsCopyIn(NEWS_CATALOG_EN);

/**
 * A picture's credit as every surface prints it with the picture: an article's photo names its outlet ('Photo: Reuters'),
 * one the house model drew says so ('Illustration'); the winner's own crop carries none, the byline crediting the winner.
 */
export function newsPictureCredit(art: Pick<NewsIllustration, 'source' | 'credit'>): string | null {
  const source = illustrationSourceOf(art);
  if (source === 'article') return art.credit?.trim() ? `${NEWS_COPY.pictureCredit.article}: ${art.credit.trim()}` : NEWS_COPY.pictureCredit.article;
  if (source === 'generated') return NEWS_COPY.pictureCredit.generated;
  return null;
}
