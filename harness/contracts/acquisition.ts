// Sign-up acquisition: the first non-direct touch that brought a browser to make.fun, stored once per account at
// sign-up (account_acquisition). One grammar for every reader, the browser that records the touch and the server that
// stores it, so neither may write or accept a value this file would not:
//
//   Acquisition            { source, medium, campaign, content, referrerHost }, each a tag or null
//   acqTag / acqHost       the shape of one tag (a utm value, a click id's network) and of a referring host
//   acquisitionOf          a landing's touch: the rule of src/lib/ga4.ts ga4AcqOf, null where GA writes (not set)
//   pack/parseAcquisition  the five fields as one `~`-joined value (the mf_acq cookie, the handoff's tail)
//   acquisitionOfCookie    the touch a request's Cookie header carries
//   acquisitionQuery       a stored touch back as the landing's utm tags, for a link that opens the site in a browser
//                          holding no cookie (a wallet's own browser, the phone's own browser out of another app's)
//   withAcquisition        such a link carrying them, unless it carries a landing tag already
//   split/joinHandoff      the `ga` handoff value: `<ga>`, `<ga>~<packed>`, `<ga>~<packed>~<arm>` or
//                          `<ga>~<packed>~<arm>~<click ref>` (below)
//   isHandoffArm           the arm field's shape: the first_win_bonus cookie's value `<arm>.<browser id>`
//   isFreebuffClickRef     the click ref field's shape: the mf_fbc cookie's value (FREEBUFF_CLICK_REF_RE)
//   freebuffClickRefOfCookie  the click ref a request's (or the page's) Cookie header carries in mf_fbc
//   isOpenAiClickRef       an OpenAI Ads click ref's shape: the mf_oac cookie's value (OPENAI_CLICK_REF_RE)
//   openAiClickRefOfCookie the OpenAI Ads click ref a Cookie header carries in mf_oac
//   split/joinHandoffClick the click field: the Freebuff ref, then optionally `.` and the OpenAI Ads ref (below)
//   isIosAppUserAgent      a user agent from inside make.fun's iPhone app, where no ad measurement runs and the page
//                          hands on no click ref (IOS_APP_USER_AGENT_RE)
//
// The touch rides the existing `ga` handoff value (POST /api/auth/solana/key's `ga`, the CLI's --ga) as a tail after
// the first `~`, never a new body field: the key route's body is strict and old kits refuse unknown flags. So does the
// browser's first_win_bonus assignment, as an optional sixth tail field after the touch: the value of its
// mf_ab_first_win_bonus cookie verbatim (server/api-types/experiments.ts: `control` or `offer`, a `.`, then a browser
// id of 16 to 64 of [A-Za-z0-9_-], case-sensitive, never lowercased on its way), which the key mint that makes the
// account binds it to (server/experiments/bind.ts), as the cookie binds a browser's own sign-up. Only that test rides
// it. And so does the browser's Freebuff ad click, as an optional seventh tail field after the arm: the 16-character ref
// of its mf_fbc cookie (FREEBUFF_CLICK_REF_RE, case-sensitive), never the click id itself (up to 600 characters, kept
// in the server's own table under that ref), which the key mint resolves to report the sign-up to Freebuff. So a value
// is one part (`<ga>`), six (`<ga>~<source>~<medium>~<campaign>~<content>~<referrer host>`), seven
// (`<ga>~<source>~<medium>~<campaign>~<content>~<referrer host>~<arm>.<browser id>`) or eight
// (`<ga>~<source>~<medium>~<campaign>~<content>~<referrer host>~<arm>.<browser id or empty>~<click ref>`); with an arm
// or a click and no touch the five touch fields are empty (`<ga>~~~~~~offer.<id>`), with a click and no arm the arm
// field is empty (`<ga>~~~~~~~<ref>`: five empty touch fields, an empty arm, then the ref), and with no GA half the
// value opens with `~`. A handoff without a touch, an arm or a click stays byte for byte what it was, one with a touch
// and no arm or click too, and one with no click is what it was before the click existed.
//
// The click field also carries the browser's OpenAI Ads click (ChatGPT ads, `?oppref=`): the 16-character ref of its
// mf_oac cookie (OPENAI_CLICK_REF_RE), after the Freebuff ref and a `.` (`<freebuff ref>.<openai ref>`, or
// `.<openai ref>` with no Freebuff click: joinHandoffClick), never the oppref itself (opaque, of no documented length,
// kept in the server's own table under that ref). A field with no OpenAI ref is the Freebuff ref alone, byte for byte
// what it was before the OpenAI ref existed; a reader that knows only the Freebuff ref (an older server) reads a field
// with a `.` as a malformed ref and ignores it, as it ignores any other.
//
// Every `ga` reader allows 256 characters (HANDOFF_MAX: server/routes/solana-auth.ts GA_MAX, cli/register.ts GA_MAX,
// which kits already unpacked enforce). The longest value without an arm is 46 (server/ga4.ts GA4_HANDOFF_MAX) + 1 +
// ACQ_PACKED_MAX = 251; an arm adds up to 73 (`~`, `control`, `.`, 64) and a click field up to 34 after an arm (`~` and
// 16, `.`, 16), 35 after an empty arm field, so joinHandoff leaves the click off first, then the arm, where the value
// would pass HANDOFF_MAX, and writes the rest as it would without them. A malformed arm or click field is ignored by
// every reader, never refused, and costs neither the GA half, the touch nor (for a click) the arm.
//
// No PII: a tag is a campaign's own label and a host is a site's hostname alone, never a path or a query; no `@`, space
// or `~` survives a tag, a browser id is a random draw of the browser's, and a click ref is a hash prefix of an ad
// network's opaque click id. No Node APIs and no DOM: safe for the Vite app and the node server alike. Not listed in
// contracts/index.ts (as contracts/ga4.ts is not).

import { EXPERIMENT_BROWSER_ID_RE, FIRST_WIN_BONUS_ARMS } from '../server/api-types/experiments.ts';
import { GA4_CLICK_IDS } from './ga4.ts';

/** The first-touch cookie: the packed Acquisition, set on a non-direct landing while the browser holds none and is signed out. Not HttpOnly. */
export const ACQ_COOKIE = 'mf_acq';
/** How long the first-touch cookie lasts, in days. */
export const ACQ_COOKIE_DAYS = 90;
/** The longest tag (source, medium, campaign, content). */
export const ACQ_TAG_MAX = 40;
/** The longest referring host. */
export const ACQ_HOST_MAX = 40;
/** The longest packed Acquisition: four tags, a host and four `~`. */
export const ACQ_PACKED_MAX = 4 * ACQ_TAG_MAX + ACQ_HOST_MAX + 4;
/** A tag's shape. */
export const ACQ_TAG_RE = /^[a-z0-9._-]{1,40}$/;
/** A referring host's shape. */
export const ACQ_HOST_RE = /^[a-z0-9.-]{1,40}$/;

/** The longest `ga` handoff value any reader takes (see the header): joinHandoff leaves the click, then the arm, off rather than pass it. */
export const HANDOFF_MAX = 256;

/**
 * The Freebuff click cookie: the 16-character ref (FREEBUFF_CLICK_REF_RE) under which the server keeps a landing's ad
 * click id, never the click id itself. Set by the server on a landing with a click; not HttpOnly, so a copied prompt
 * can hand the ref on as the handoff's click field.
 */
export const FREEBUFF_CLICK_COOKIE = 'mf_fbc';
/** A Freebuff click ref's shape: 16 of [A-Za-z0-9_-] (a base64url sha256 prefix), case-sensitive. */
export const FREEBUFF_CLICK_REF_RE = /^[A-Za-z0-9_-]{16}$/;

/**
 * The OpenAI Ads click cookie: the 16-character ref (OPENAI_CLICK_REF_RE) under which the server keeps a landing's
 * `oppref` (server/accounts/openai-click.ts), never the oppref itself. Set by the server on a landing with one while
 * OPENAI_ADS_CAPI_KEY is set; not HttpOnly, so a copied prompt can hand the ref on in the handoff's click field.
 */
export const OPENAI_CLICK_COOKIE = 'mf_oac';
/** An OpenAI Ads click ref's shape: 16 of [A-Za-z0-9_-] (a base64url sha256 prefix), case-sensitive. */
export const OPENAI_CLICK_REF_RE = /^[A-Za-z0-9_-]{16}$/;
/**
 * The OpenAI Ads pixel cookie: make.fun's Pixel ID (OPENAI_PIXEL_ID_RE), set beside a landing's `oppref` while
 * OPENAI_ADS_PIXEL_ID is set (server/accounts/openai-click.ts). index.html's pixel boot loads OpenAI's measurement pixel
 * only in a browser holding it, so a visitor who never clicked a ChatGPT ad never loads it. Not HttpOnly.
 */
export const OPENAI_PIXEL_COOKIE = 'mf_oap';
/** An OpenAI Ads Pixel ID's shape (Ads Manager > Conversions > Data sources): 8 to 64 of [A-Za-z0-9_-]. */
export const OPENAI_PIXEL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/**
 * The OpenAI Ads registration cookie: the event id of the `registration_completed` the server sent for the account a
 * browser just made (server/auth.ts), set on that sign-in's answer only in a browser holding OPENAI_PIXEL_COOKIE, so
 * index.html's pixel boot measures the same event (the same id: OpenAI keeps the first and drops the other) and
 * clears it. Not HttpOnly.
 */
export const OPENAI_REGISTRATION_COOKIE = 'mf_oar';
/** An OpenAI Ads event id's shape as the registration cookie carries it: 8 to 64 of [A-Za-z0-9_-]. */
export const OPENAI_EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A user agent from inside make.fun's iPhone app: the app shell's token (server/shell/channel.ts SHELL_TOKEN_RE) with
 * platform `ios`, whatever the channel (`ios-team`, `ios-store`). No ad measurement runs there (X's, OpenAI's and
 * Freebuff's scripts, the click refs kept for them), and Google Analytics runs as analytics alone. index.html's X and
 * OpenAI boots and server/freebuff-tag.ts's loader repeat this pattern inline, on navigator.userAgent alone, so the one
 * document every reader gets decides it in the page (tests/unit/web-ad-measurement-ios.test.ts holds them together).
 */
export const IOS_APP_USER_AGENT_RE = /\bMakefunApp\/[0-9A-Za-z.]+ \(ios; [a-z-]+; [0-9]+\)/;

/** Whether `userAgent` is the iPhone app's (IOS_APP_USER_AGENT_RE); false for anything that is not a string. */
export const isIosAppUserAgent = (userAgent: unknown): boolean => typeof userAgent === 'string' && IOS_APP_USER_AGENT_RE.test(userAgent);

/** The separator of the click field's Freebuff ref from its OpenAI ref: in neither ref's alphabet. */
const CLICK_SEP = '.';

/** The separator of the packed fields, and of the handoff's `ga` from its packed tail, of that from its arm and of that from its click ref. No tag, host, arm or ref may hold it. */
const SEP = '~';

/**
 * A search engine's host (`www.` already dropped), whose referral is organic: src/lib/ga4.ts SEARCH_ENGINE_RE, one
 * pattern on both sides. Any host on an engine's domain in any country (google.com, news.google.com, google.co.uk,
 * search.yahoo.com, bing.com, duckduckgo.com, baidu.com…) and any search. host (search.aol.com). A sign-in return from
 * accounts.google.* never reaches it (SIGN_IN_HOST_RE).
 */
const SEARCH_ENGINE_RE = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|brave|startpage|kagi)\.[a-z.]+$|^search\./i;
/**
 * A sign-in provider's page that sends the visitor straight back after an OAuth sign-in (Sign in with Google returns from
 * accounts.google.com; src/lib/ga4.ts SIGN_IN_HOST_RE): a return to the site, not a new touch, so it reads as a
 * self-referral does (no referring host, no touch) and the landing kept before the sign-in stands.
 */
const SIGN_IN_HOST_RE = /^accounts\.google\.[a-z.]+$/i;

/** Whether a referring host (bare, never cut, as the browser judges it) is a search engine's: its referral is organic. */
const isSearchHost = (host: string): boolean => SEARCH_ENGINE_RE.test(host);

/** What each ad network's click id marks as a medium (src/lib/ga4.ts CLICK_ID_MEDIUM): the search networks cpc, the rest paid_social. */
const CLICK_ID_MEDIUM: Readonly<Record<string, string>> = { google: 'cpc', microsoft: 'cpc' };

/** The utm keys that mark a landing as tagged (ga4AcqOf's: utm_term and utm_id do not). */
const UTM_TAGGED = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const;

/** A first touch. Each field is a tag (ACQ_TAG_RE; referrerHost ACQ_HOST_RE) or null where GA4 would write (not set). */
export interface Acquisition {
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
  readonly content: string | null;
  readonly referrerHost: string | null;
}

/** The packed order of the fields. */
const FIELDS = ['source', 'medium', 'campaign', 'content', 'referrerHost'] as const;

/**
 * A tag: trimmed, lowercased, each run of characters outside [a-z0-9._-] written as one `_`, a leading or trailing `_`
 * dropped, cut to ACQ_TAG_MAX. Null when nothing is left. `My Clip #1` reads `my_clip_1`.
 */
export function acqTag(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const tag = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, ACQ_TAG_MAX)
    .replace(/_+$/, '');
  return ACQ_TAG_RE.test(tag) ? tag : null;
}

/** A host as compared: lowercased, one trailing `.` (the root) and a leading `www.` dropped. */
const bareHost = (host: string): string => host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** An external referrer's whole bare host, or null: acqHost's rule before the cut to ACQ_HOST_MAX. */
function externalHost(referrer: string | null | undefined, ownHosts: readonly string[]): string | null {
  if (typeof referrer !== 'string' || referrer.trim() === '') return null;
  let from: URL;
  try {
    from = new URL(referrer.trim());
  } catch {
    return null;
  }
  if (from.protocol !== 'http:' && from.protocol !== 'https:') return null;
  const host = bareHost(from.hostname);
  if (host === '' || SIGN_IN_HOST_RE.test(host) || ownHosts.some((own) => bareHost(own) === host)) return null;
  return ACQ_HOST_RE.test(host.slice(-ACQ_HOST_MAX)) ? host : null;
}

/**
 * The referring host of a referrer URL: an http(s) URL's hostname, lowercased, a leading `www.` dropped, the last
 * ACQ_HOST_MAX characters of a longer one. Null for anything else: not a URL, not http(s), one of `ownHosts` (the
 * site's own: a referral from itself is no touch), a sign-in provider's return (SIGN_IN_HOST_RE: accounts.google.com,
 * read as a self-referral is), or a host outside [a-z0-9.-] (an IP v6 literal). Never a path or a query.
 */
export function acqHost(referrer: string | null | undefined, ownHosts: readonly string[]): string | null {
  return externalHost(referrer, ownHosts)?.slice(-ACQ_HOST_MAX) ?? null;
}

/** An Acquisition whose fields are all null is no touch. */
const isEmpty = (a: Acquisition): boolean => FIELDS.every((field) => a[field] === null);

/**
 * The first touch a landing carries, or null for a direct one: the rule of src/lib/ga4.ts ga4AcqOf, with null where GA
 * writes (not set). A utm tag (source, medium, campaign or content) or an ad click id (contracts/ga4.ts GA4_CLICK_IDS)
 * gives source (utm_source, else the click id's network), medium (utm_medium, else cpc for google and microsoft,
 * paid_social for the rest), campaign and content, plus the referring host. With neither, an external referrer gives
 * source = its host and medium organic (a search engine, SEARCH_ENGINE_RE, judged on the whole host before its cut) or
 * referral; a sign-in provider's return (accounts.google.com) is no touch. `href` is
 * the landing URL, `referrer` the document's referrer, `ownHosts` the site's own hosts (contracts/ga4.ts
 * GA4_HOSTS.hosts); the landing's own host is never external either.
 */
export function acquisitionOf(href: string, referrer: string | null | undefined, ownHosts: readonly string[]): Acquisition | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const hosts = url.hostname === '' ? ownHosts : [...ownHosts, url.hostname];
  const external = externalHost(referrer, hosts);
  const referrerHost = external?.slice(-ACQ_HOST_MAX) ?? null;
  const query = url.searchParams;
  const clickId = Object.keys(GA4_CLICK_IDS).find((key) => query.has(key));
  const network: string | null = clickId ? GA4_CLICK_IDS[clickId as keyof typeof GA4_CLICK_IDS] : null;
  const tagged = UTM_TAGGED.some((key) => (query.get(key) ?? '').trim() !== '');
  if (tagged || network) {
    // `||` as ga4AcqOf has it: a utm_source that is present but blank still wins over the network (GA writes (not set)).
    const touch: Acquisition = {
      source: acqTag(query.get('utm_source') || network),
      medium: acqTag(query.get('utm_medium') || (network ? (CLICK_ID_MEDIUM[network] ?? 'paid_social') : null)),
      campaign: acqTag(query.get('utm_campaign')),
      content: acqTag(query.get('utm_content')),
      referrerHost,
    };
    return isEmpty(touch) ? null : touch;
  }
  if (external === null || referrerHost === null) return null;
  return {
    source: referrerHost,
    medium: isSearchHost(external) ? 'organic' : 'referral',
    campaign: null,
    content: null,
    referrerHost,
  };
}

/** A field's shape: a tag's, or a host's for referrerHost. */
const shapeOf = (field: (typeof FIELDS)[number]): RegExp => (field === 'referrerHost' ? ACQ_HOST_RE : ACQ_TAG_RE);

/**
 * The five fields joined by `~` in the order source, medium, campaign, content, referrerHost, a null field empty. Null
 * when every field is null, or when one is not in its shape (so whatever this packs, parseAcquisition reads back).
 */
export function packAcquisition(a: Acquisition | null | undefined): string | null {
  if (!a || isEmpty(a)) return null;
  const parts: string[] = [];
  for (const field of FIELDS) {
    const value = a[field];
    if (value === null) parts.push('');
    else if (typeof value === 'string' && shapeOf(field).test(value)) parts.push(value);
    else return null;
  }
  return parts.join(SEP);
}

/** A packed Acquisition: exactly five `~`-separated fields, each empty or in its shape, at least one set, at most ACQ_PACKED_MAX characters. Anything else is null. */
export function parseAcquisition(packed: string | null | undefined): Acquisition | null {
  if (typeof packed !== 'string' || packed === '' || packed.length > ACQ_PACKED_MAX) return null;
  const parts = packed.split(SEP);
  if (parts.length !== FIELDS.length) return null;
  const values: (string | null)[] = [];
  for (const [i, field] of FIELDS.entries()) {
    const part = parts[i] as string;
    if (part === '') values.push(null);
    else if (shapeOf(field).test(part)) values.push(part);
    else return null;
  }
  const [source, medium, campaign, content, referrerHost] = values as [string | null, string | null, string | null, string | null, string | null];
  const a: Acquisition = { source, medium, campaign, content, referrerHost };
  return isEmpty(a) ? null : a;
}

/** The first cookie named `name` in a Cookie header (a quoted value unquoted) that `read` takes, else null. */
function firstCookieOf<T>(cookieHeader: string | null | undefined, name: string, read: (value: string) => T | null): T | null {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return null;
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq).trim() !== name) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    const found = read(value);
    if (found !== null) return found;
  }
  return null;
}

/** The first well-shaped `mf_acq` of a Cookie header (a quoted value unquoted), else null. */
export function acquisitionOfCookie(cookieHeader: string | null | undefined): Acquisition | null {
  return firstCookieOf(cookieHeader, ACQ_COOKIE, parseAcquisition);
}

/** Each utm key a landing is tagged by (UTM_TAGGED), with the field acquisitionOf reads it into, in that order. */
const UTM_FIELDS = [
  ['utm_source', 'source'],
  ['utm_medium', 'medium'],
  ['utm_campaign', 'campaign'],
  ['utm_content', 'content'],
] as const satisfies readonly (readonly [(typeof UTM_TAGGED)[number], (typeof FIELDS)[number]])[];

/** The mediums acquisitionOf gives an untagged referral (its source the referring host). */
const REFERRAL_MEDIUMS: readonly string[] = ['organic', 'referral'];

/**
 * A stored first touch as the landing tags that give it back (acquisitionOf of a URL carrying them): utm_source,
 * utm_medium, utm_campaign and utm_content from source, medium, campaign and content, each null or malformed field left
 * out. For a link that opens the site in a browser that holds no `mf_acq` (a wallet's own browser, the phone's own
 * browser out of another app's), so the server's landing rule sets the cookie there and GA reads the same source.
 *
 * Null for no touch, for a touch with no tag left, and for an untagged referral (no campaign or content, medium organic
 * or referral, source the referring host): its source is the Referer's, which no link can carry, and a utm tag made up
 * for it would read as a campaign. Never a click id (only the landing that held one is that click), never the
 * referring host, never anything but the tags.
 */
export function acquisitionQuery(a: Acquisition | null | undefined): URLSearchParams | null {
  if (!a) return null;
  const referral = a.campaign === null && a.content === null && a.source !== null && a.source === a.referrerHost && REFERRAL_MEDIUMS.includes(a.medium ?? '');
  if (referral) return null;
  const query = new URLSearchParams();
  let tags = 0;
  for (const [key, field] of UTM_FIELDS) {
    const value = a[field];
    if (typeof value !== 'string' || !ACQ_TAG_RE.test(value)) continue;
    query.set(key, value);
    tags += 1;
  }
  return tags > 0 ? query : null;
}

/** Whether a query (without its `?`) already tags its landing: any utm_* key, or an ad click id (GA4_CLICK_IDS). */
function tagsLanding(query: string): boolean {
  const clickIds = Object.keys(GA4_CLICK_IDS);
  for (const key of new URLSearchParams(query).keys()) {
    if (key.toLowerCase().startsWith('utm_') || clickIds.includes(key)) return true;
  }
  return false;
}

/**
 * `href` with the touch's landing tags (acquisitionQuery) added to its query, before its fragment: every pair it holds
 * kept as written. `href` itself, unchanged, when the touch gives no tags or `href` already tags its landing (any utm_*
 * key, or an ad click id): a tag already there is never overwritten nor mixed with another touch's.
 */
export function withAcquisition(href: string, a: Acquisition | null | undefined): string {
  const query = acquisitionQuery(a);
  if (query === null) return href;
  const hashAt = href.indexOf('#');
  const before = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  const queryAt = before.indexOf('?');
  if (queryAt >= 0 && tagsLanding(before.slice(queryAt + 1))) return href;
  const sep = queryAt < 0 ? '?' : before.endsWith('?') || before.endsWith('&') ? '' : '&';
  return `${before}${sep}${query.toString()}${hash}`;
}

/** Whether `value` is a click ref a handoff may carry (FREEBUFF_CLICK_REF_RE): the mf_fbc cookie's value. */
export function isFreebuffClickRef(value: unknown): value is string {
  return typeof value === 'string' && FREEBUFF_CLICK_REF_RE.test(value);
}

/** The first well-shaped `mf_fbc` click ref of a Cookie header (a quoted value unquoted), else null. */
export function freebuffClickRefOfCookie(cookieHeader: string | null | undefined): string | null {
  return firstCookieOf(cookieHeader, FREEBUFF_CLICK_COOKIE, (value) => (isFreebuffClickRef(value) ? value : null));
}

/** Whether `value` is an OpenAI Ads click ref (OPENAI_CLICK_REF_RE): the mf_oac cookie's value. */
export function isOpenAiClickRef(value: unknown): value is string {
  return typeof value === 'string' && OPENAI_CLICK_REF_RE.test(value);
}

/** The first well-shaped `mf_oac` click ref of a Cookie header (a quoted value unquoted), else null. */
export function openAiClickRefOfCookie(cookieHeader: string | null | undefined): string | null {
  return firstCookieOf(cookieHeader, OPENAI_CLICK_COOKIE, (value) => (isOpenAiClickRef(value) ? value : null));
}

/** The first well-shaped `mf_oap` Pixel ID of a Cookie header, else null. */
export function openAiPixelIdOfCookie(cookieHeader: string | null | undefined): string | null {
  return firstCookieOf(cookieHeader, OPENAI_PIXEL_COOKIE, (value) => (OPENAI_PIXEL_ID_RE.test(value) ? value : null));
}

/** The click field's refs, each null where it is absent or malformed. */
export interface HandoffClicks {
  readonly freebuff: string | null;
  readonly openai: string | null;
}

/**
 * The click field in its refs (see the header): no `.`, the Freebuff ref alone; one `.`, the Freebuff ref (may be
 * empty) before it and the OpenAI ref after it. Each ref is kept only when its shape takes it, so a reader ignores a
 * malformed one alone; any other value is neither.
 */
export function splitHandoffClick(click: string | null | undefined): HandoffClicks {
  if (typeof click !== 'string' || click === '') return { freebuff: null, openai: null };
  const parts = click.split(CLICK_SEP);
  if (parts.length > 2) return { freebuff: null, openai: null };
  const [freebuff, openai] = parts as [string, string | undefined];
  return { freebuff: isFreebuffClickRef(freebuff) ? freebuff : null, openai: isOpenAiClickRef(openai) ? openai : null };
}

/**
 * The click field of the refs a browser holds (see the header): the Freebuff ref alone, byte for byte the field before
 * the OpenAI ref existed; `.<openai ref>` with no Freebuff ref; both `<freebuff>.<openai>`; null when neither is
 * well-shaped. A malformed ref is left out alone.
 */
export function joinHandoffClick(freebuff: string | null | undefined, openai: string | null | undefined): string | null {
  const fb = isFreebuffClickRef(freebuff) ? freebuff : null;
  const oa = isOpenAiClickRef(openai) ? openai : null;
  if (oa === null) return fb;
  return `${fb ?? ''}${CLICK_SEP}${oa}`;
}

/** Whether `value` is a click field a handoff may carry: exactly what joinHandoffClick writes of its refs, not empty. */
export function isHandoffClick(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  const { freebuff, openai } = splitHandoffClick(value);
  return joinHandoffClick(freebuff, openai) === value;
}

/**
 * A handoff split in its four parts (see the header): `ga` the GA browser handoff before the first `~`, `packed` the
 * packed Acquisition after it, `arm` the first_win_bonus cookie's value after the touch, `click` the click field after
 * the arm (the Freebuff click ref, then optionally `.` and the OpenAI Ads click ref: splitHandoffClick). None is
 * validated; an empty part is null.
 */
export interface Handoff {
  readonly ga: string | null;
  readonly packed: string | null;
  readonly arm: string | null;
  readonly click: string | null;
}

/** The arm field's first_win_bonus arms (control, offer). */
const HANDOFF_ARMS: readonly string[] = FIRST_WIN_BONUS_ARMS;

/**
 * Whether `value` is an arm field a handoff may carry: the first_win_bonus cookie's value `<arm>.<browser id>`, the arm
 * control or offer and the browser id EXPERIMENT_BROWSER_ID_RE's (16 to 64 of [A-Za-z0-9_-], case-sensitive), exactly
 * as server/experiments/cookie.ts parseExperimentCookieValue reads it unquoted.
 */
export function isHandoffArm(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  return dot > 0 && HANDOFF_ARMS.includes(value.slice(0, dot)) && EXPERIMENT_BROWSER_ID_RE.test(value.slice(dot + 1));
}

/** The tail of a handoff with an arm or a click and no touch: the five touch fields, each empty. */
const NO_TOUCH = SEP.repeat(FIELDS.length - 1);

/**
 * A `ga` handoff value in its parts: cut at its first `~` (none: all of it is `ga`), the rest the packed touch, except
 * that a rest of exactly six `~`-separated fields is the touch's five and the arm, and one of exactly seven the touch's
 * five, the arm (may be empty) and the click ref (five empty touch fields: no touch). Any other rest is `packed` whole,
 * as before the arm existed. Validates no part: ga4BrowserFromHandoff, parseAcquisition, isHandoffArm and
 * splitHandoffClick do, each reader ignoring a malformed part on its own.
 */
export function splitHandoff(raw: string | null | undefined): Handoff {
  if (typeof raw !== 'string' || raw === '') return { ga: null, packed: null, arm: null, click: null };
  const at = raw.indexOf(SEP);
  if (at < 0) return { ga: raw, packed: null, arm: null, click: null };
  const ga = raw.slice(0, at);
  let packed = raw.slice(at + 1);
  let arm = '';
  let click = '';
  const fields = packed.split(SEP);
  if (fields.length === FIELDS.length + 1 || fields.length === FIELDS.length + 2) {
    if (fields.length === FIELDS.length + 2) click = fields.pop() as string;
    arm = fields.pop() as string;
    packed = fields.join(SEP);
    if (packed === NO_TOUCH) packed = '';
  }
  const orNull = (part: string): string | null => (part === '' ? null : part);
  return { ga: orNull(ga), packed: orNull(packed), arm: orNull(arm), click: orNull(click) };
}

/**
 * The handoff value (see the header): `ga`, `~packed`, `ga~packed`, or null when both are empty; then, when `arm` is
 * one isHandoffArm takes and `packed` is empty or five fields, `~` and the arm after the touch (its five fields empty
 * when there is none), unless that would pass HANDOFF_MAX: the arm alone is left off then. Then, when `click` is a
 * click field isHandoffClick takes (a Freebuff ref alone is one) and `packed` is empty or five fields, `~`, the arm or nothing, `~` and the click ref, unless
 * that would pass HANDOFF_MAX: the click alone is left off then, the value exactly what it is without one (the arm
 * keeps its place over the click). A handoff without a touch, an arm or a click is `ga` byte for byte; one without an
 * arm or a click is what it was before the arm existed, and one without a click what it was before the click existed.
 */
export function joinHandoff(ga: string | null | undefined, packed: string | null | undefined, arm?: string | null, click?: string | null): string | null {
  const head = typeof ga === 'string' ? ga : '';
  const tail = typeof packed === 'string' ? packed : '';
  const plain = tail === '' ? (head === '' ? null : head) : `${head}${SEP}${tail}`;
  const armed = isHandoffArm(arm);
  if (!armed && !isHandoffClick(click)) return plain;
  const touch = tail === '' ? NO_TOUCH : tail;
  // A tail that is not five fields would read back with the arm and the click inside it: such a tail carries neither.
  if (touch.split(SEP).length !== FIELDS.length) return plain;
  const withArm = armed ? `${head}${SEP}${touch}${SEP}${arm}` : null;
  const unclicked = withArm !== null && withArm.length <= HANDOFF_MAX ? withArm : plain;
  if (!isHandoffClick(click)) return unclicked;
  const withClick = `${head}${SEP}${touch}${SEP}${armed ? arm : ''}${SEP}${click}`;
  return withClick.length <= HANDOFF_MAX ? withClick : unclicked;
}
