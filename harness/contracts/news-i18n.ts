// news.make.fun's words in every locale: the catalog format, the English catalog (every string the news host prints),
// and the formatters that render a catalog's messages, plurals, counts and days. A leaf like contracts/news.ts: no Node
// APIs, no DOM and no import from server/ or contracts/news.ts (which derives NEWS_COPY from it), so the web app, the
// server and the scripts all read it, and every formatter answers the same on every runtime.
//
//   NEWS_CATALOG_SCHEMA         a catalog's format, 'news-catalog/1'
//   NewsCatalog                 one locale's catalog (zod): its messages (a text with {placeholders}, or plural forms
//                               keyed by CLDR category), the sha256 of each message's English source (sources: the
//                               generator, scripts/news-i18n.ts, translates again only the keys whose English changed),
//                               its dates (weekday and month names, long and short, and the day patterns, built from
//                               NEWS_DATE_TOKENS), its numbers (the group separator and sizes; Latin digits always) and
//                               its languages (each NEWS_LOCALES tag's name in this locale: the picker's second line)
//   NEWS_CATALOG_EN             the English catalog: every string the news host prints (the page, its head and crawl
//                               body, the text formats, the feeds and their person's page, llms.txt, the share card),
//                               and the keys later steps print (language, languageTrigger, suggested, translatedFrom,
//                               readOriginal). Its dates and numbers are written by hand to match contracts/news.ts
//                               dayTitle, dayShortLabel and formatCount exactly
//   NewsMessageKey              a key of the English catalog: every key a renderer may ask for
//   message, plural             a message with its placeholders filled; a plural message for a count, its form picked by
//                               Intl.PluralRules (the locale's CLDR rules), else its 'other' form. A key a catalog lacks
//                               is the English catalog's, key by key
//   formatCountIn, dayTitleIn, dayShortLabelIn, dayWithoutYearIn, dayMonthIn, dayTitleShortIn, weekdayShortIn, textStampIn,
//   newsUtcClock
//                               a whole number with the locale's grouping ('19,452', '19 452', '12,34,567'); a UTC day in
//                               the locale's words; an instant as the text formats stamp it ('Sat 21 Nov 00:00 UTC')
//   newsVotingWordsIn, newsCardAltIn, newsCopyIn
//                               the voting sentence of the text formats, the share card's alt, and NEWS_COPY's shape for
//                               any catalog (contracts/news.ts NEWS_COPY is newsCopyIn(NEWS_CATALOG_EN))
//   newsEditionPageNameIn, newsSentenceJoinIn
//                               a front page's name in its title (the front page's, a day's page's), and what joins two
//                               sentences (a front page's first paragraph: its standfirst, its byline, its agents line)
//   languageNameIn, newsCatalogDir
//                               a locale's name in a catalog's language; a catalog's writing direction
//   NEWS_PSEUDO_LOCALES, pseudoCatalog
//                               the pseudo-locales, for tests and dev only (never in NEWS_LOCALES), Android's practice:
//                               en-XA, every letter accented and every text padded by 40% inside brackets (overflow and
//                               clipping), and ar-XB, every word right-to-left (mirroring), before real translations exist
//   newsMessageSource, newsSourceHash, newsCatalogSources, sha256Hex
//                               a message's English source as hashed, its sha256 (pure: the same in a browser, the
//                               server and the generator), and a catalog's sources over a set of messages
//
// Brand and protocol words are never in a catalog: make.fun, news.make.fun, RSS 2.0, JSON Feed 1.1, llms.txt and UTC
// stay as they are in every locale (the generator's glossary).

import { z } from 'zod';
import { isNewsLocaleTag, NEWS_LOCALES, newsLocale } from './news-locales.ts';

/** A catalog's format: a NewsCatalog's `schema`. */
export const NEWS_CATALOG_SCHEMA = 'news-catalog/1';

/** CLDR's plural categories, in CLDR's order. */
export const NEWS_PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type NewsPluralCategory = (typeof NEWS_PLURAL_CATEGORIES)[number];

/**
 * The tokens a day pattern is built from: the weekday long ('Thursday') and short ('Thu'), the day of the month ('19'),
 * the month long ('November') and short ('Nov'), the year ('2026'). Anything else in a pattern is printed as written.
 */
export const NEWS_DATE_TOKENS = ['weekday', 'wd', 'day', 'month', 'mon', 'year'] as const;
export type NewsDateToken = (typeof NEWS_DATE_TOKENS)[number];

/** The pseudo-locales (tests and dev only, never in NEWS_LOCALES), with the direction each is written in. */
export const NEWS_PSEUDO_LOCALES = { 'en-XA': { dir: 'ltr' }, 'ar-XB': { dir: 'rtl' } } as const;
export type NewsPseudoLocale = keyof typeof NEWS_PSEUDO_LOCALES;

export function isNewsPseudoLocale(tag: string): tag is NewsPseudoLocale {
  return Object.hasOwn(NEWS_PSEUDO_LOCALES, tag);
}

/** A message key: dotted camelCase words ('stages.open', 'agentsWorked'). */
const KEY_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;
/** A placeholder in a message: '{count}', '{day}'. */
const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const SHA256_RE = /^[0-9a-f]{64}$/;

const text = z.string().min(1);
const key = z.string().regex(KEY_RE, 'a message key: dotted camelCase words');

/** A message's plural forms, by CLDR category: `other` always, the locale's other categories where its rules have them. */
export const NewsPluralForms = z.strictObject({
  zero: text.optional(),
  one: text.optional(),
  two: text.optional(),
  few: text.optional(),
  many: text.optional(),
  other: text,
});
export type NewsPluralForms = z.infer<typeof NewsPluralForms>;

/** One message: a text with {placeholders}, or plural forms (each with {count} where the count prints). */
export const NewsMessage = z.union([text, NewsPluralForms]);
export type NewsMessage = z.infer<typeof NewsMessage>;

/** A day pattern: text and NEWS_DATE_TOKENS in braces ('{weekday} {day} {month} {year}'), at least one token, no other braces. */
const pattern = z.string().refine((p) => {
  const tokens = [...p.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
  const rest = p.replace(/\{[^{}]*\}/g, '');
  return tokens.length > 0 && tokens.every((t) => (NEWS_DATE_TOKENS as readonly string[]).includes(t)) && !/[{}]/.test(rest);
}, `a day pattern of ${NEWS_DATE_TOKENS.map((t) => `{${t}}`).join(', ')} and text`);

const names = (n: number) => z.array(text).length(n);

export const NewsCatalogDates = z.strictObject({
  /** Sunday first, as Date#getUTCDay counts. */
  weekdays: z.strictObject({ long: names(7), short: names(7) }),
  /** January first, each in the form a date prints it (CLDR's format context: Polish 'listopada', not 'listopad'). */
  months: z.strictObject({ long: names(12), short: names(12) }),
  patterns: z.strictObject({
    /** The day in words, the page's h1 and title: 'Thursday 19 November 2026'. */
    title: pattern,
    /** The day arrows' and the search's: 'Thu 19 Nov'. */
    short: pattern,
    /** The 'Also on' heading's: 'Thursday 19 November'. */
    withoutYear: pattern,
    /** The bounty's day in the text formats' byline: '19 Nov'. */
    dayMonth: pattern,
  }),
});
export type NewsCatalogDates = z.infer<typeof NewsCatalogDates>;

/**
 * How a count is grouped, digits always Latin (the translations keep the source's digits): the separator; the group
 * sizes from the right, the last repeating ([3] for 19,452; [3, 2] for Hindi's 12,34,567); and CLDR's
 * minimumGroupingDigits (2 where 1234 stays ungrouped and 12 345 is grouped, as Polish writes them).
 */
export const NewsCatalogNumbers = z.strictObject({
  group: z.string(),
  sizes: z.array(z.number().int().min(1).max(9)).min(1).max(2),
  minimumGroupingDigits: z.number().int().min(1).max(4),
});
export type NewsCatalogNumbers = z.infer<typeof NewsCatalogNumbers>;

/** One locale's catalog (see the header). */
export const NewsCatalog = z.strictObject({
  schema: z.literal(NEWS_CATALOG_SCHEMA),
  /** A NEWS_LOCALES tag, or a pseudo-locale (NEWS_PSEUDO_LOCALES). */
  locale: z.string().refine((t): boolean => isNewsLocaleTag(t) || isNewsPseudoLocale(t), 'a NEWS_LOCALES tag or a pseudo-locale'),
  messages: z.record(key, NewsMessage),
  /** Per key, the sha256 (newsSourceHash) of the English message it was translated from. */
  sources: z.record(key, z.string().regex(SHA256_RE, 'lowercase hex sha256')),
  dates: NewsCatalogDates,
  numbers: NewsCatalogNumbers,
  /** Each NEWS_LOCALES tag's name in this locale (a tag left out is named as the English catalog names it). */
  languages: z.record(z.string().refine((t): boolean => isNewsLocaleTag(t), 'a NEWS_LOCALES tag'), text),
});
export type NewsCatalog = z.infer<typeof NewsCatalog>;

// ---------------------------------------------------------------- the English catalog

/**
 * Every string the news host prints, by surface. A message prints as written but for its {placeholders}; a plural message
 * picks its form by the count. Typographic marks are the page's own (’ in 'Today’s front page', “” round a query).
 */
const EN_MESSAGES = {
  // contracts/news.ts NEWS_COPY: the page, its crawl body and the share card say these alike.
  kicker: 'The day in world news',
  // A front page's first paragraph under its h1 opens with it: what the site is, in the words its readers search for
  // (seo/news/targets.md T01 and T02); the credit follows ('Front page by {name}.', then the agents line as a sentence).
  standfirst: 'AI-curated daily world news summary, made by AI agents competing on make.fun.',
  byline: 'Front page by',
  'byline.sentence': 'Front page by {name}',
  viewProfile: 'View profile',
  whereItHappened: 'Where it happened',
  alsoOn: 'Also on',
  'alsoOn.day': 'Also on {day}',
  'stages.name': "This front page's stages",
  'stages.open': 'Voting open',
  'stages.closes': 'Closes',
  'stages.closesAt': 'Closes {time}',
  'stages.closesUnknown': 'Voting closes',
  'stages.closed': 'Voting closed, picking the winner',
  'stages.final': 'Final edition',
  'stages.done': 'done',
  'stages.leaderSince': 'Leader since',
  'stages.leaderSinceAt': 'Leader since {time}',
  'stages.mayChange': 'this front page can change until the winner is picked',
  cta: "Make tomorrow's front page",
  stories: 'stories',
  regions: 'regions',
  'formats.rss': 'RSS',
  'formats.json': 'JSON',
  'formats.md': 'Markdown',
  'formats.llms': 'llms.txt',
  'formats.atom': 'Atom',
  'formats.jsonFeed': 'JSON Feed',
  'formats.text': 'Text',
  searchPlaceholder: "Search every day's stories",
  newsSearch: 'News search',
  formerPlayer: 'a former make.fun player',
  agentsWorked: { one: '{count} AI agent worked on this', other: '{count} AI agents worked on this' },
  'card.agents': { one: 'AI agent', other: 'AI agents' },
  'card.made': 'made this front page',
  'card.alt': { one: '{count} AI agent made the front page for {day}.', other: '{count} AI agents made the front page for {day}.' },
  'card.altLead': { one: '{count} AI agent made the front page for {day}: {lead}', other: '{count} AI agents made the front page for {day}: {lead}' },
  'card.storyWord': { one: 'story', other: 'stories' },
  'card.regionWord': { one: 'region', other: 'regions' },
  'pictureCredit.article': 'Photo',
  'pictureCredit.articleFrom': 'Photo: {outlet}',
  'pictureCredit.generated': 'Illustration',

  // The regions (contracts/news.ts NEWS_REGIONS), and the top bar's every-region link.
  'region.europe': 'Europe',
  'region.middleEast': 'Middle East',
  'region.asia': 'Asia',
  'region.africa': 'Africa',
  'region.americas': 'Americas',
  'region.oceania': 'Oceania',
  'region.world': 'World',
  'region.every': 'World',

  // The tiers' headings (server/news/render-text.ts, the page's sr-only headings).
  'tier.lead': 'Top stories',
  'tier.card': 'Stories',
  'tier.more': 'More stories',

  // Counts and stamps.
  'count.stories': { one: '{count} story', other: '{count} stories' },
  'count.regions': { one: '{count} region', other: '{count} regions' },
  'count.days': { one: '{count} day', other: '{count} days' },
  'stamp.time': '{time} UTC',
  'stamp.weekdayTime': '{weekday} {time} UTC',
  'stamp.dayTime': '{date} {time} UTC',
  'stamp.whole': '{date}, {time} UTC',
  /** An edition page's update line, above its stages (server/news/head.ts editionHtml, src/news/Masthead.tsx): {time} is stamp.dayTime's. */
  'stamp.updated': 'Updated {time}',
  /** A text closed as a sentence where it has no closing mark of its own (a headline in the card's alt). */
  sentence: '{text}.',

  // The text formats' and feeds' voting sentence (contracts/news.ts newsVotingWords).
  'votingWords.open': 'Voting open; this front page can change until the winner is picked.',
  'votingWords.openUntil': 'Voting open until {time}; this front page can change until the winner is picked.',
  'votingWords.openUntilLeader': 'Voting open until {time}; this front page can change until the winner is picked. Leader since {since}.',

  // The language picker and a translated page's note.
  language: 'Language',
  languageTrigger: 'Language: {name}',
  suggested: 'Suggested',
  translatedFrom: 'Translated from English',
  readOriginal: 'Read in English',

  // Page titles (src/news/api.ts newsDocumentTitle, server/news/head.ts newsPageTitle).
  'page.title': '{page} — news.make.fun',
  // A front page's own name in its title (newsEditionPageNameIn): the front page's ('/') names seo/news/targets.md T01
  // with no day (the h1, the description and the JSON-LD carry it), a day's page's T02 with {day} its short date
  // (dayTitleShortIn: '21 Nov 2026'), so a title with the longest host name stays within 60 characters.
  'page.front': 'AI-curated daily world news',
  'page.day': 'Daily world news summary: {day}',
  'page.search': 'Search',
  'page.noPage': 'No page here',
  'page.notFound': 'Page not found',

  // src/news/NewsTopBar.tsx
  'topBar.home': 'news.make.fun, the latest front page',
  'topBar.darkMode': 'Dark mode',
  'topBar.toLight': 'Switch to light mode',
  'topBar.toDark': 'Switch to dark mode',
  'topBar.regions': 'Regions',
  'topBar.menu': 'Menu',
  'topBar.closeMenu': 'Close the menu',

  // src/news/Masthead.tsx
  'masthead.formats': 'This day in other formats',

  // src/news/NewsFrontPage.tsx: the page, its footer and its other states.
  'front.noRegionStory': 'No story from {region} is on this page.',
  'front.showEveryRegion': 'Show every region',
  'front.empty': 'This front page holds no stories yet.',
  'front.seeWinner': 'See the winning entry',
  'front.loading': 'Loading the front page',
  'footer.credit': '{day}’s front page is {entry} by {name}, the winning entry in make.fun’s daily news bounty, set in this site’s own style.',
  'footer.links': 'Feeds and links',
  'footer.bounty': 'The bounty',

  // The daily digest by email (contracts/news-digest.ts): the footer's form, the confirm and unsubscribe pages, the
  // confirm mail and the daily mail. {site} is the host's name (newsSiteNameOf), {timezone} an IANA zone
  // ('Europe/Paris'), {link} and {url} whole addresses, {title} the day's title, {time} a stamp.dayTime.
  'digest.title': 'The front page by email',
  'digest.lede': 'Get the day’s front page in your inbox at 07:00 your time. We ask you to confirm first.',
  'digest.email': 'Email address',
  'digest.subscribe': 'Subscribe',
  'digest.sending': 'Sending a link to confirm to your inbox.',
  'digest.sent': 'Check your inbox for a link to confirm. Nothing is sent until you open it.',
  'digest.invalid': 'Enter an email address, like name@example.com.',
  'digest.failed': 'Subscribing did not work. Try again in a few minutes.',
  'digest.confirm.title': 'Confirm your subscription',
  'digest.confirm.body': 'Confirm to get the front page of {site} by email each day at 07:00 {timezone}.',
  'digest.confirm.button': 'Confirm',
  'digest.confirm.done': 'You are subscribed. The first email comes at the next 07:00 {timezone}.',
  'digest.confirm.expired': 'This link has expired or was already used. Subscribe again to get a new one.',
  'digest.unsubscribe.title': 'Unsubscribe',
  'digest.unsubscribe.body': 'Stop getting the front page of {site} by email.',
  'digest.unsubscribe.button': 'Unsubscribe',
  'digest.unsubscribe.done': 'You are unsubscribed. No more daily emails come to this address.',
  'digest.confirmMail.subject': 'Confirm your daily front page from {site}',
  'digest.confirmMail.body':
    'Someone asked for the daily front page of {site} at this address. To confirm, open {link}. If it was not you, ignore this email: nothing is sent unless the link is confirmed.',
  'digest.confirmMail.agent': 'An agent can confirm with a POST to {url} with this link’s token as `token` in a JSON body.',
  'digest.mail.subject': '{title} — {site}',
  'digest.mail.provisional': 'Voting is open until {time}: this front page can change until the winner is picked.',
  'digest.mail.readOn': 'Read it on {site}',
  'digest.mail.english': 'Today’s stories are in English: their translation was not ready when this email was sent.',
  'digest.mail.footer': 'You get this email because you subscribed to the daily front page of {site}.',
  'digest.mail.unsubscribe': 'Unsubscribe',
  'noEdition.heading': 'Voting is open',
  'noEdition.sentence': "The first front page appears here once the day's bounty has a winner.",
  'missingDay.heading': 'No front page for {day}',
  'missingDay.sentence': 'That day has no edition.',
  'missingDay.nearest': 'That day has no edition; the nearest is {day}.',
  todaysFrontPage: 'Today’s front page',
  'readFailed.heading': 'The front page did not load',
  'readFailed.sentence': 'Check your connection, then try again.',
  tryAgain: 'Try again',
  'noPage.sentence': 'This address is not a day of news.make.fun.',

  // src/news/DayNav.tsx
  'dayNav.days': 'Days',
  'dayNav.previous': 'Previous day: {day}',
  'dayNav.next': 'Next day: {day}',
  'dayNav.noEarlier': 'No earlier front page',
  'dayNav.noLater': 'No later front page yet',

  // src/news/StoryCard.tsx, StoryTile.tsx, LocatorTile.tsx, WorldMap.tsx
  'story.tag': '{region} - {section}',
  'story.brief': '{place}: {headline}',
  'story.label': 'Story {n}, {tag}',
  newTab: '(opens in a new tab)',
  'source.newTab': '{label} (opens in a new tab)',
  'source.searchFor': 'News search: {headline} (opens in a new tab)',
  'map.label': 'Map: {place}',
  'map.stories': 'Stories on the map',
  'map.pin': '{n}: {headline}',

  // src/news/StoryDialog.tsx
  'dialog.readAt': 'Read at {outlet}',
  'dialog.copyLink': 'Copy link',
  'dialog.linkCopied': 'Link copied',
  'dialog.sources': 'Sources',
  'dialog.previous': 'Previous story',
  'dialog.next': 'Next story',
  'dialog.close': 'Close',
  'dialog.count': '{n} of {total}',
  'dialog.stepped': '{n} of {total}: {headline}',
  // A story's TL;DR (contracts/news.ts NewsTldr): the label over its hook and points in the story's window, and before
  // them in the text formats (server/news/render-text.ts).
  tldr: 'TL;DR',

  // src/news/SearchBox.tsx and NewsSearch.tsx
  'search.label': 'Search the news',
  'search.failed': 'Search did not load.',
  'search.noMatch': 'No stories match “{q}”.',
  'search.noMatchSaid': 'No stories match {q}.',
  'search.countSaid': { one: '{count} story.', other: '{count} stories.' },
  'search.clear': 'Clear search',
  'search.listbox': 'Stories',
  'search.everyMatch': 'Every story matching “{q}”',
  'search.submit': 'Search',
  'search.heading': 'Stories matching “{q}”',
  'search.region': 'Region',
  'search.allRegions': 'All regions',
  'search.summary': '{stories} across {days}',
  'search.summaryIn': '{summary} in {region}',
  'search.summarySaid': '{summary}.',
  'search.tooShort': {
    one: "Type at least {count} character to search every day's front page.",
    other: "Type at least {count} characters to search every day's front page.",
  },
  'search.readToday': "Read today's front page",
  'search.noMatchIn': 'No stories in {region} match “{q}”.',
  'search.everyRegion': 'Search every region',

  // server/news/render-text.ts: the day's Markdown and plain text.
  'text.winnerOf': 'winner of the {day} bounty',
  'text.formats': 'Formats: {formats}',
  'text.sources': 'Sources: {sources}',

  // server/news/head.ts: the head's alternates, descriptions and the default card's alt.
  'head.alternate': '{name} ({format})',
  'head.noStories': '{kicker}: {day}.',
  'head.defaultCardAlt': 'The news.make.fun logo, the make.fun ghost reading a newspaper, over “{kicker}”, a dotted map of the world and a “{cta}” button.',

  // server/news/feeds.ts: the feeds' titles and descriptions.
  'feed.titleRegion': '{site}: {region}',
  'feed.description': "{kicker}: the daily front page made from the winning entry of make.fun's news-in-one-image bounty, one item per story with its region, place and sources.",
  'feed.descriptionRegion':
    "{kicker}: the daily front page made from the winning entry of make.fun's news-in-one-image bounty, one item per story with its region, place and sources, {region} only.",

  // server/news/feeds.ts formatPageHtml: a person's page of a file.
  'formatPage.title': '{heading}, {format}',
  'formatPage.copyLink': 'Copy link',
  'formatPage.openRaw': 'Open raw file',
  'formatPage.selected': 'Selected',
  'formatPage.selectedSaid': 'The link is selected: copy it with your device.',
  'formatPage.copied': 'Copied',
  'formatPage.copiedSaid': 'Link copied.',
  'formatPage.forAgents': 'Agents, scripts and feed readers fetching this address get the file itself.',
  'formatPage.mdAbout': 'This edition as Markdown.',
  'formatPage.plainText': 'Plain text',
  'formatPage.txtAbout': { one: 'This edition as plain text, wrapped at {count} column.', other: 'This edition as plain text, wrapped at {count} columns.' },
  'formatPage.jsonAbout': 'This edition as JSON, schema {schema}.',
  'formatPage.newest': 'This address always holds the newest day.',
  'formatPage.readAsPage': 'Read it as a page',
  'formatPage.noItems': 'No stories in this feed yet.',
  'formatPage.toFront': 'Go to the front page',
  'formatPage.lastDays': { one: 'The last {count} day', other: 'The last {count} days' },
  'formatPage.lastDaysRegion': { one: '{region}, the last {count} day', other: '{region}, the last {count} days' },
  'formatPage.feedAbout': 'One item per story, newest day first. Add this address to a feed reader to follow each new edition.',
  'formatPage.everyDay': 'Every day',
  'formatPage.daysAbout': "Each day's edition, newest first, and the bounty now taking entries for the next front page.",
  'formatPage.rssFeed': 'RSS feed',
  'formatPage.atomFeed': 'Atom feed',
  'formatPage.forAiAgents': 'For AI agents',
  'formatPage.llmsAbout': 'The index AI agents read first: what this site publishes and where to fetch it, in Markdown.',
  'formatPage.llmsFullAbout': {
    one: 'The last {count} edition as Markdown, one after another in one file.',
    other: 'The last {count} editions as Markdown, one after another in one file.',
  },

  // server/news/feeds.ts newsLlmsTxt: llms.txt.
  'llms.summary': "A daily world-news front page: the winning entry of {link}'s daily news-in-one-image bounty, ported to text. Every story has its headline, summary, region, place and source links.",
  'llms.about':
    "Each UTC day (YYYY-MM-DD) is one edition: the winner of that day's bounty on make.fun, read off the winning image into numbered stories (lead, card and brief) and a credit to the entrant who made it. An edition is provisional while the bounty's voting is still open (its winner may change) and final once the bounty resolves. A story's source links are articles found for it; where none was found its link is a news search, labelled “{newsSearch}”.",
  'llms.formats': 'Formats',
  'llms.latest': 'Latest edition as Markdown',
  'llms.latestWhat': 'the newest day; `/latest.json` and `/latest.txt` too',
  'llms.dayMd': 'One day as Markdown',
  'llms.dayMdWhat': "any day's edition; the day's page (`/<YYYY-MM-DD>`) answers `Accept: text/markdown` with the same Markdown",
  'llms.dayJson': 'One day as JSON',
  'llms.dayJsonWhat':
    'the edition document (schema `{schema}`): its stories with `n`, `tier`, `region`, `section`, `place`, `headline`, `summary`, `tldr` (`hook`, `points`, `basis`), `outlets` and `links` (`url`, `outlet`, `domain`, `via`), and the credit',
  'llms.dayTxt': 'One day as plain text',
  'llms.dayTxtWhat': "the Markdown's content without markup, wrapped at {count} columns, URLs in angle brackets",
  'llms.daysWhat': "each day's title, status, story count and winner, newest first, and the bounty open for the next front page",
  'llms.rssWhat': {
    one: 'one item per story of the last {count} day, newest first; `?region=<id>` keeps one region ({regions})',
    other: 'one item per story of the last {count} days, newest first; `?region=<id>` keeps one region ({regions})',
  },
  'llms.sameItems': 'the same items; `?region=<id>`',
  'llms.searchWhat': '`GET /api/news/search?q=<words>&region=<id>&limit=<n>`, the stories of every day that match, best first, as JSON',
  'llms.sitemap': 'Sitemap',
  'llms.sitemapWhat': "every day's page",
  'llms.recentDays': 'Recent days',
  'llms.none': 'No edition is published yet.',
  'llms.day': '{stories}, front page by {name}',
  'llms.dayProvisional': '{stories}, front page by {name} (voting open: it can change until the winner is picked)',
  'llms.optional': 'Optional',
  'llms.fullWhat': { one: "the last {count} day's editions as Markdown, in one file", other: "the last {count} days' editions as Markdown, in one file" },
} as const satisfies Record<string, NewsMessage>;

/** A key of the English catalog: every key a renderer may ask a catalog for. */
export type NewsMessageKey = keyof typeof EN_MESSAGES;

/** Every key of the English catalog, in its order. */
export const NEWS_MESSAGE_KEYS = Object.keys(EN_MESSAGES) as NewsMessageKey[];

/** The English dates, by hand: as contracts/news.ts dayTitle and dayShortLabel write them (no comma, the day before the month). */
const EN_DATES: NewsCatalogDates = {
  weekdays: {
    long: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    short: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  },
  months: {
    long: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    short: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  patterns: { title: '{weekday} {day} {month} {year}', short: '{wd} {day} {mon}', withoutYear: '{weekday} {day} {month}', dayMonth: '{day} {mon}' },
};

/** The English numbers, as contracts/news.ts formatCount groups them: '19,452'. */
const EN_NUMBERS: NewsCatalogNumbers = { group: ',', sizes: [3], minimumGroupingDigits: 1 };

let enSources: Record<string, string> | undefined;

/**
 * The English catalog (see the header). Its sources are its own messages' hashes, computed on first read (only the
 * generator and the tests read them).
 */
export const NEWS_CATALOG_EN: NewsCatalog = {
  schema: NEWS_CATALOG_SCHEMA,
  locale: 'en',
  messages: EN_MESSAGES,
  get sources(): Record<string, string> {
    enSources ??= newsCatalogSources(EN_MESSAGES);
    return enSources;
  },
  dates: EN_DATES,
  numbers: EN_NUMBERS,
  languages: Object.fromEntries(NEWS_LOCALES.map((l) => [l.tag, l.name])),
};

// ---------------------------------------------------------------- messages and plurals

/** A value a placeholder takes: a text as it is, a number as the catalog's count (formatCountIn). */
export type NewsMessageVars = Readonly<Record<string, string | number>>;

/** The catalog's message for `key`, else the English catalog's (a key the catalog does not hold yet). */
function lookup(cat: NewsCatalog, key: NewsMessageKey): NewsMessage {
  return cat.messages[key] ?? EN_MESSAGES[key];
}

/** `template` with each {placeholder} `vars` names filled; one it does not name is left as written. */
function fill(cat: NewsCatalog, template: string, vars: NewsMessageVars | undefined): string {
  if (vars === undefined) return template;
  return template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!Object.hasOwn(vars, name)) return whole;
    const v = vars[name]!;
    return typeof v === 'number' ? formatCountIn(cat, v) : v;
  });
}

/** A message in `cat` (else English), its placeholders filled from `vars`. A plural message gives its 'other' form. */
export function message(cat: NewsCatalog, key: NewsMessageKey, vars?: NewsMessageVars): string {
  const m = lookup(cat, key);
  return fill(cat, typeof m === 'string' ? m : m.other, vars);
}

const pluralRules = new Map<string, Intl.PluralRules>();

/** The Intl locale a catalog's plural rules are CLDR's for: its NEWS_LOCALES row's cldr, else its tag (a pseudo-locale). */
const intlLocaleOf = (cat: NewsCatalog): string => newsLocale(cat.locale)?.cldr ?? cat.locale;

/** The CLDR plural category of `n` in `cat`'s locale (Intl.PluralRules, cardinal). */
export function pluralCategoryIn(cat: NewsCatalog, n: number): NewsPluralCategory {
  const locale = intlLocaleOf(cat);
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(n) as NewsPluralCategory;
}

/**
 * A plural message for `n` in `cat` (else English): the form of n's CLDR category, else 'other', its {count} n as the
 * catalog writes counts (formatCountIn) and its other placeholders from `vars`. A message with no forms prints as written.
 */
export function plural(cat: NewsCatalog, key: NewsMessageKey, n: number, vars?: NewsMessageVars): string {
  const m = lookup(cat, key);
  const form = typeof m === 'string' ? m : (m[pluralCategoryIn(cat, n)] ?? m.other);
  return fill(cat, form, { count: formatCountIn(cat, n), ...vars });
}

/** The {placeholders} a message names, each once, in order (every form of a plural message). */
export function messagePlaceholders(m: NewsMessage): string[] {
  const texts = typeof m === 'string' ? [m] : NEWS_PLURAL_CATEGORIES.flatMap((c) => (m[c] === undefined ? [] : [m[c]!]));
  return [...new Set(texts.flatMap((t) => [...t.matchAll(PLACEHOLDER_RE)].map((x) => x[1]!)))];
}

/** A locale's name in `cat`'s language ('Français' in French, 'French' in English), else the English catalog's, else its tag. */
export function languageNameIn(cat: NewsCatalog, tag: string): string {
  return cat.languages[tag] ?? NEWS_CATALOG_EN.languages[tag] ?? tag;
}

/** The direction a catalog's locale is written in: its NEWS_LOCALES row's, a pseudo-locale's own, else left to right. */
export function newsCatalogDir(locale: string): 'ltr' | 'rtl' {
  if (isNewsPseudoLocale(locale)) return NEWS_PSEUDO_LOCALES[locale].dir;
  return newsLocale(locale)?.dir ?? 'ltr';
}

// ---------------------------------------------------------------- numbers

/** `digits` grouped from the right by `sizes` (the last repeating), when it is long enough to group at all. */
function groupDigits(digits: string, numbers: NewsCatalogNumbers): string {
  const primary = numbers.sizes[0]!;
  if (digits.length < primary + numbers.minimumGroupingDigits) return digits;
  const parts: string[] = [];
  let end = digits.length;
  for (let i = 0; end > 0; i++) {
    const size = numbers.sizes[Math.min(i, numbers.sizes.length - 1)]!;
    const start = Math.max(0, end - size);
    parts.unshift(digits.slice(start, end));
    end = start;
  }
  return parts.join(numbers.group);
}

/**
 * A whole number as `cat` writes a count, Latin digits always: 19452 -> '19,452' (en), '19 452' (fr, a narrow no-break
 * space), '12,34,567' for 1234567 (hi). Truncated toward zero, a minus before a negative one. The same on every runtime (no Intl).
 */
export function formatCountIn(cat: NewsCatalog, n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const t = groupDigits(BigInt(Math.trunc(Math.abs(n))).toString(), cat.numbers);
  return n < 0 ? `-${t}` : t;
}

// ---------------------------------------------------------------- days

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real UTC day as a Date at its midnight; a RangeError on anything else (contracts/news.ts isNewsDay's rule). */
function dateOf(day: string): Date {
  if (DAY_RE.test(day)) {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d) return t;
  }
  throw new RangeError(`not a news day: ${JSON.stringify(day)}`);
}

/** A day written by one of `cat`'s patterns. */
function dayIn(cat: NewsCatalog, day: string, which: keyof NewsCatalogDates['patterns']): string {
  const d = dateOf(day);
  const { weekdays, months, patterns } = cat.dates;
  const values: Record<NewsDateToken, string> = {
    weekday: weekdays.long[d.getUTCDay()]!,
    wd: weekdays.short[d.getUTCDay()]!,
    day: String(d.getUTCDate()),
    month: months.long[d.getUTCMonth()]!,
    mon: months.short[d.getUTCMonth()]!,
    year: String(d.getUTCFullYear()),
  };
  return patterns[which].replace(/\{([a-z]+)\}/g, (_, token: NewsDateToken) => values[token]);
}

/** The day in words, in UTC: '2026-11-19' -> 'Thursday 19 November 2026' (en), 'jeudi 19 novembre 2026' (fr). A RangeError on anything but a news day. */
export const dayTitleIn = (cat: NewsCatalog, day: string): string => dayIn(cat, day, 'title');

/** The day's short label: 'Thu 19 Nov' (en), 'jeu. 19 nov.' (fr). */
export const dayShortLabelIn = (cat: NewsCatalog, day: string): string => dayIn(cat, day, 'short');

/** The day in words without its year, the 'Also on' heading's: 'Thursday 19 November'. */
export const dayWithoutYearIn = (cat: NewsCatalog, day: string): string => dayIn(cat, day, 'withoutYear');

/** The day of the month and the month, short: '19 Nov'. */
export const dayMonthIn = (cat: NewsCatalog, day: string): string => dayIn(cat, day, 'dayMonth');

/**
 * `title`'s pattern with its weekday left out and its month short. A weekday first takes the words after it with it
 * ('{weekday}, ', Thai's '{weekday}ที่ '); a weekday last takes only the spaces and punctuation before it (', {weekday}',
 * Korean's '일 {weekday}' keeps its '일', Japanese '日{weekday}' its '日'): '{weekday} {day} {month} {year}' ->
 * '{day} {mon} {year}', '{year}年{month}月{day}日{weekday}' -> '{year}年{mon}月{day}日', '{day}, {month} {year}, {weekday}' ->
 * '{day}, {mon} {year}'. Read off the catalog's own title pattern, so it needs no pattern of its own (the generator,
 * scripts/news-i18n.ts, writes four) and keeps the h1's order.
 */
export function titleShortPattern(title: string): string {
  const parts = title.split(/(\{[a-z]+\})/).filter((p) => p !== '');
  const at = parts.indexOf('{weekday}');
  const isToken = (p: string | undefined): boolean => p !== undefined && /^\{[a-z]+\}$/.test(p);
  if (at === 0) parts.splice(0, isToken(parts[1]) ? 1 : 2);
  else if (at > 0) {
    parts.splice(at, 1);
    const before = parts[at - 1];
    if (before !== undefined && !isToken(before)) parts[at - 1] = before.replace(/[\s\p{P}]+$/u, '');
  }
  return parts.join('').replace('{month}', '{mon}').trim();
}

/** The day short with its year, a day page's title's: '21 Nov 2026' (en), '21. Nov. 2026' (de), '2026年11月21日' (ja). */
export function dayTitleShortIn(cat: NewsCatalog, day: string): string {
  const d = dateOf(day);
  const { months } = cat.dates;
  return titleShortPattern(cat.dates.patterns.title).replace(/\{([a-z]+)\}/g, (whole, token: string) =>
    token === 'day' ? String(d.getUTCDate()) : token === 'mon' ? months.short[d.getUTCMonth()]! : token === 'year' ? String(d.getUTCFullYear()) : whole,
  );
}

/** The day's weekday, short: 'Thu'. */
export function weekdayShortIn(cat: NewsCatalog, day: string): string {
  return cat.dates.weekdays.short[dateOf(day).getUTCDay()]!;
}

/** An instant's day (UTC), 'YYYY-MM-DD'. */
const dayOfInstant = (at: string | Date): string => new Date(at).toISOString().slice(0, 10);

/** An instant's time on the UTC clock, hours and minutes: '2026-11-19T14:20:31Z' -> '14:20'. The same in every locale. */
export function newsUtcClock(at: string | Date): string {
  const d = new Date(at);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** An instant as the text formats stamp it, with its day: '2026-11-21T00:00:00Z' -> 'Sat 21 Nov 00:00 UTC'. */
export function textStampIn(cat: NewsCatalog, at: string | Date): string {
  return message(cat, 'stamp.dayTime', { date: dayShortLabelIn(cat, dayOfInstant(at)), time: newsUtcClock(at) });
}

// ---------------------------------------------------------------- sentences built from a catalog

/**
 * A provisional edition's voting as every text format says it (contracts/news.ts newsVotingWords, in `cat`'s words):
 * 'Voting open until Sat 21 Nov 00:00 UTC; this front page can change until the winner is picked. Leader since Thu 19
 * Nov 14:20 UTC.' With no voting read, the first clause without its time; with no build time, no leader.
 */
export function newsVotingWordsIn(cat: NewsCatalog, voting: { closesAt: string; leaderSince: string | null } | null): string {
  if (voting === null) return message(cat, 'votingWords.open');
  const time = textStampIn(cat, voting.closesAt);
  if (voting.leaderSince === null) return message(cat, 'votingWords.openUntil', { time });
  return message(cat, 'votingWords.openUntilLeader', { time, since: textStampIn(cat, voting.leaderSince) });
}

/** A sentence's closing marks: a headline ending in one is a sentence already. */
const CLOSED = /[.!?…。！？।؟]$/u;

/** `s` trimmed, closed as a sentence (the catalog's `sentence`) unless it ends in a closing mark of its own. */
export function sentenceIn(cat: NewsCatalog, s: string): string {
  const t = s.trim();
  return CLOSED.test(t) ? t : message(cat, 'sentence', { text: t });
}

/**
 * A day's share card's alt (og:image:alt, twitter:image:alt): '15,485 AI agents made the front page for Thursday 19
 * November 2026: <the lead headline>.' `day` is the day as words already; `lead` the lead story's headline, if any.
 */
export function newsCardAltIn(cat: NewsCatalog, n: number, day: string, lead: string | null): string {
  return lead === null ? plural(cat, 'card.alt', n, { day }) : plural(cat, 'card.altLead', n, { day, lead: sentenceIn(cat, lead) });
}

/**
 * A front page's own name, what its title puts before the site (the catalog's page.title): 'AI-curated daily world news'
 * on the front page (`/`, `front`), 'Daily world news summary: 18 Nov 2026' on a day's page (`/<day>`, its day short:
 * dayTitleShortIn). `day` is the edition's day, YYYY-MM-DD. With the longest brand host (agentfrontpage.com) the English
 * titles run 48 and 58 characters, under the 60 a result title keeps (seo/news/gaps.md N1). server/news/head.ts
 * editionHead and src/news/NewsApp.tsx's document title both name a page by it, so the two titles agree.
 */
export function newsEditionPageNameIn(cat: NewsCatalog, front: boolean, day: string): string {
  return front ? message(cat, 'page.front') : message(cat, 'page.day', { day: dayTitleShortIn(cat, day) });
}

/**
 * What joins two sentences in `cat`'s words, as a front page's first paragraph joins its standfirst, its byline and its
 * agents line ('… competing on make.fun. Front page by @handle. 1,284 AI agents worked on this.'): nothing where the
 * catalog ends a sentence with a full-width stop ('{text}。', as Chinese and Japanese write it), a space else.
 * src/news/Masthead.tsx Standfirst and server/news/head.ts's crawl body join them alike.
 */
export function newsSentenceJoinIn(cat: NewsCatalog): string {
  return /[。！？]$/u.test(message(cat, 'sentence')) ? '' : ' ';
}

/**
 * The words both the web page and the server's crawl body print, in `cat`'s locale: contracts/news.ts NEWS_COPY is this of
 * the English catalog (its fields documented there), so a renderer given a catalog prints the same words in its language.
 */
export function newsCopyIn(cat: NewsCatalog) {
  const m = (k: NewsMessageKey): string => message(cat, k);
  return {
    kicker: m('kicker'),
    byline: m('byline'),
    viewProfile: m('viewProfile'),
    whereItHappened: m('whereItHappened'),
    alsoOn: m('alsoOn'),
    stages: {
      name: m('stages.name'),
      open: m('stages.open'),
      closes: m('stages.closes'),
      closesUnknown: m('stages.closesUnknown'),
      closed: m('stages.closed'),
      final: m('stages.final'),
      done: m('stages.done'),
      leaderSince: m('stages.leaderSince'),
      mayChange: m('stages.mayChange'),
    },
    cta: m('cta'),
    stories: m('stories'),
    regions: m('regions'),
    formats: { rss: m('formats.rss'), json: m('formats.json'), md: m('formats.md'), llms: m('formats.llms') },
    searchPlaceholder: m('searchPlaceholder'),
    newsSearch: m('newsSearch'),
    formerPlayer: m('formerPlayer'),
    agentsWorked: (n: number): string => plural(cat, 'agentsWorked', n),
    card: {
      agents: (n: number): string => plural(cat, 'card.agents', n),
      made: m('card.made'),
      alt: (n: number, day: string, lead: string | null): string => newsCardAltIn(cat, n, day, lead),
    },
    pictureCredit: { article: m('pictureCredit.article'), generated: m('pictureCredit.generated') },
  } as const;
}

export type NewsCopy = ReturnType<typeof newsCopyIn>;

// ---------------------------------------------------------------- pseudo-locales

/** en-XA's letters: each ASCII letter an accented one, one UTF-16 unit each. */
const ACCENTED: Readonly<Record<string, string>> = Object.fromEntries(
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'].map((c, i) => [c, [...'ÅƁÇĐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽåƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýž'][i]!]),
);

/** The words en-XA pads with, as Android's pseudo-locale does. */
const PAD_WORDS = ' one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';

/** The share of a text's length en-XA adds to it: 40%, about the most a translation grows an English UI string. */
export const NEWS_PSEUDO_EXPANSION = 0.4;

/** `s` split into its placeholders (kept) and the text between them (transformed by `f`). */
const mapLiterals = (s: string, f: (t: string) => string): string =>
  s
    .split(/(\{[A-Za-z][A-Za-z0-9]*\})/)
    .map((part, i) => (i % 2 === 1 ? part : f(part)))
    .join('');

/** Padding of at least `n` characters, in whole words (' one two'). */
function padding(n: number): string {
  let pad = '';
  while (pad.length < n || PAD_WORDS[pad.length % PAD_WORDS.length] !== ' ') pad += PAD_WORDS[pad.length % PAD_WORDS.length];
  return pad;
}

/** en-XA's form of a text: accented and padded by NEWS_PSEUDO_EXPANSION, inside brackets when `bracket`. */
function expand(s: string, bracket: boolean): string {
  const inner = `${mapLiterals(s, (t) => t.replace(/[A-Za-z]/g, (c) => ACCENTED[c]!))}${padding(Math.ceil([...s].length * NEWS_PSEUDO_EXPANSION))}`;
  return bracket ? `[${inner}]` : inner;
}

/** ar-XB's form of a text: each word drawn right to left (RLM, RLO, the word, PDF, RLM), its placeholders as they are. */
const mirror = (s: string): string => mapLiterals(s, (t) => t.replace(/[^\s]+/gu, (w) => `\u200f\u202e${w}\u202c\u200f`));

/** Every form of a message through `f`. */
const mapMessage = (m: NewsMessage, f: (t: string) => string): NewsMessage =>
  typeof m === 'string' ? f(m) : (Object.fromEntries(Object.entries(m).map(([c, t]) => [c, f(t)])) as NewsPluralForms);

/**
 * A pseudo-locale's catalog of `base` (the English catalog by default), for tests and dev only: en-XA, every message's
 * letters accented and its length padded by 40% inside brackets (an overflow or a clipped end shows), its day and month
 * names and its languages accented and padded; ar-XB, every word right to left (a layout that does not mirror shows).
 * Placeholders, patterns, numbers and sources stay the base's.
 */
export function pseudoCatalog(tag: NewsPseudoLocale, base: NewsCatalog = NEWS_CATALOG_EN): NewsCatalog {
  const f = tag === 'en-XA' ? (s: string) => expand(s, true) : mirror;
  const name = tag === 'en-XA' ? (s: string) => expand(s, false) : mirror;
  const all = (xs: readonly string[]) => xs.map(name);
  const messages: Record<string, NewsMessage> = {};
  for (const k of NEWS_MESSAGE_KEYS) messages[k] = mapMessage(lookup(base, k), f);
  return {
    schema: NEWS_CATALOG_SCHEMA,
    locale: tag,
    messages,
    sources: base.sources,
    dates: {
      weekdays: { long: all(base.dates.weekdays.long), short: all(base.dates.weekdays.short) },
      months: { long: all(base.dates.months.long), short: all(base.dates.months.short) },
      patterns: base.dates.patterns,
    },
    numbers: base.numbers,
    languages: Object.fromEntries(NEWS_LOCALES.map((l) => [l.tag, f(languageNameIn(base, l.tag))])),
  };
}

// ---------------------------------------------------------------- sources

/**
 * A message's English source as its hash reads it: a text as written; plural forms as their categories and texts in
 * CLDR's order, JSON. A change to any form is a new source.
 */
export function newsMessageSource(m: NewsMessage): string {
  if (typeof m === 'string') return m;
  return JSON.stringify(NEWS_PLURAL_CATEGORIES.flatMap((c) => (m[c] === undefined ? [] : [[c, m[c]]])));
}

/** A message's source hash: the sha256 of 'news-msg/1', a NUL and newsMessageSource(m), in UTF-8, lowercase hex. */
export const newsSourceHash = (m: NewsMessage): string => sha256Hex(`news-msg/1\u0000${newsMessageSource(m)}`);

/** Each key's source hash over `messages`: what a catalog translated from them records as its sources. */
export function newsCatalogSources(messages: Readonly<Record<string, NewsMessage>>): Record<string, string> {
  return Object.fromEntries(Object.entries(messages).map(([k, m]) => [k, newsSourceHash(m)]));
}

/* SHA-256 (FIPS 180-4), synchronous and pure, so a hash is the same in a browser, the server and the generator. */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const ror = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** The SHA-256 of `s` in UTF-8, lowercase hex. */
export function sha256Hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const blocks = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  blocks.set(bytes);
  blocks[bytes.length] = 0x80;
  const view = new DataView(blocks.buffer);
  view.setUint32(blocks.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(blocks.length - 4, (bytes.length << 3) >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let off = 0; off < blocks.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      w[i] = (w[i - 16]! + (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) + w[i - 7]! + (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + k) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}
