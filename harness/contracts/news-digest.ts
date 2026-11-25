// The news digest's contract: a confirmed subscriber's daily email of the newest front page, from the news host they
// signed up on (news.make.fun or a brand host), with its double opt-in and one-click unsubscribe. A leaf like
// contracts/news-brands.ts: no Node APIs, no DOM, no import from server/ (the web app's subscribe pages import it).
//
//   NewsSubscribeRequest ... NewsUnsubscribeAnswer   the three POST bodies and their answers (server/routes/news-digest.ts)
//   NEWS_DIGEST_LOCAL_HOUR, NEWS_DIGEST_LAST_LOCAL_HOUR, isNewsDigestHour
//                        the send window in the subscriber's own timezone: 07:00 to 11:59, so an hourly job that misses
//                        07:00 (a deploy, a backlog) still mails that morning
//   NEWS_DIGEST_TOKEN_TTL_DAYS  how long a confirm token lives (the unsubscribe token never expires)
//   NEWS_DIGEST_BATCH_SIZE      the most messages one send carries (Resend's own /emails/batch limit)
//   the paths            the pages (/subscribe, /subscribe/confirm/<token>, /unsubscribe/<token>) and the API routes
//   the UTM triple       utm_source=digest, utm_medium=email, utm_campaign=news-digest-<day> on every link a digest holds
//   NEWS_DIGEST_SENDERS  each news host's From line; newsDigestSenderOf reads it, null for a dev host
//
// The switch is server/config.ts MAKEFUN_NEWS_DIGEST (newsDigestOn), off by default. The From addresses are no secret:
// they live here, never in a sealed env.

import type { NewsRegionId } from './news.ts';
import { bareNewsHostname, NEWS_MAIN_WORDMARK, type NewsBrandHost } from './news-brands.ts';

/** POST /api/news/subscribe: an address asks for the digest of the host it is posted to. */
export interface NewsSubscribeRequest {
  email: string;
  /** The locale the digest is written in (a contracts/news-locales.ts tag); absent, the page's. */
  lang?: string;
  /** One region's stories only (contracts/news.ts NEWS_REGION_IDS); absent, every story. */
  region?: NewsRegionId;
  /** The IANA timezone the 07:00 send is counted in (like Europe/Berlin); absent, UTC. */
  timezone?: string;
}

/** Its answer, 202 whatever the address's state (new, pending, active, unsubscribed), so no answer tells them apart. */
export interface NewsSubscribeAnswer {
  state: 'pending';
  /** Words for the person: check the inbox for the confirm link. */
  message: string;
}

/** POST /api/news/subscribe/confirm: the confirm token from the mail (the page's button POSTs it; a GET never confirms). */
export interface NewsSubscribeConfirmRequest {
  token: string;
}

/** Its 200 answer (404 for an unknown or expired token). The address is never echoed. */
export interface NewsSubscribeConfirmAnswer {
  state: 'active';
  /** The news host the digest comes from and links to. */
  host: string;
  lang: string;
  region: NewsRegionId | null;
  timezone: string;
  /** When the first digest is due: the next 07:00 in `timezone`, an ISO instant. */
  first_digest_at: string;
}

/** POST /api/news/unsubscribe: the unsubscribe token from a digest's link (the page's button POSTs it; a GET never unsubscribes). */
export interface NewsUnsubscribeRequest {
  token: string;
}

/** Its 200 answer (404 for a token this server did not make); idempotent. */
export interface NewsUnsubscribeAnswer {
  state: 'unsubscribed';
}

/** The local hour a subscriber's digest is first due: 07:00 in their own timezone. */
export const NEWS_DIGEST_LOCAL_HOUR = 7;

/** The last local hour it is still sent in: the window is 07:00 to 11:59. */
export const NEWS_DIGEST_LAST_LOCAL_HOUR = 11;

/** Whether a local hour (0 to 23) falls in the send window, 07:00 to 11:59. */
export function isNewsDigestHour(localHour: number): boolean {
  return Number.isInteger(localHour) && localHour >= NEWS_DIGEST_LOCAL_HOUR && localHour <= NEWS_DIGEST_LAST_LOCAL_HOUR;
}

/** How long a confirm token lives, in days: a pending subscriber not confirmed by then is pruned. */
export const NEWS_DIGEST_TOKEN_TTL_DAYS = 7;
export const NEWS_DIGEST_TOKEN_TTL_MS = NEWS_DIGEST_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/** The most messages one send carries: Resend's own limit on POST /emails/batch. */
export const NEWS_DIGEST_BATCH_SIZE = 100;

/** The subscribe page, on every news host. */
export const NEWS_SUBSCRIBE_PATH = '/subscribe';
/** The confirm page's prefix: /subscribe/confirm/<token>. */
export const NEWS_SUBSCRIBE_CONFIRM_PATH_PREFIX = '/subscribe/confirm/';
/** The unsubscribe page's prefix: /unsubscribe/<token>, the digest's List-Unsubscribe target. */
export const NEWS_UNSUBSCRIBE_PATH_PREFIX = '/unsubscribe/';
/** The API routes, under /api/news/* on every news host. */
export const NEWS_API_SUBSCRIBE_PATH = '/api/news/subscribe';
export const NEWS_API_SUBSCRIBE_CONFIRM_PATH = '/api/news/subscribe/confirm';
export const NEWS_API_UNSUBSCRIBE_PATH = '/api/news/unsubscribe';

/** The confirm page of a token: /subscribe/confirm/<token>. */
export const newsSubscribeConfirmPath = (token: string): string => `${NEWS_SUBSCRIBE_CONFIRM_PATH_PREFIX}${encodeURIComponent(token)}`;

/** The unsubscribe page of a token: /unsubscribe/<token>. */
export const newsUnsubscribePath = (token: string): string => `${NEWS_UNSUBSCRIBE_PATH_PREFIX}${encodeURIComponent(token)}`;

/** The UTM triple's fixed two: a digest visit lands in GA4's Email channel, never in the organic comparison. */
export const NEWS_DIGEST_UTM_SOURCE = 'digest';
export const NEWS_DIGEST_UTM_MEDIUM = 'email';
const NEWS_DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** A digest day's campaign: news-digest-<day> (the edition's UTC day, YYYY-MM-DD). Throws on what is no day. */
export function newsDigestCampaignOf(day: string): string {
  if (!NEWS_DAY_SHAPE.test(day)) throw new RangeError(`newsDigestCampaignOf: expected a day, YYYY-MM-DD, got ${JSON.stringify(day)}`);
  return `news-digest-${day}`;
}

/** The UTM triple of a digest day, in the order a link carries it. */
export function newsDigestUtmOf(day: string): readonly (readonly [string, string])[] {
  return [
    ['utm_source', NEWS_DIGEST_UTM_SOURCE],
    ['utm_medium', NEWS_DIGEST_UTM_MEDIUM],
    ['utm_campaign', newsDigestCampaignOf(day)],
  ];
}

/** `url` (absolute) with the digest day's UTM triple set, replacing any utm_source, utm_medium or utm_campaign it had; its other query and fragment kept. */
export function withNewsDigestUtm(url: string, day: string): string {
  const u = new URL(url);
  for (const [k, v] of newsDigestUtmOf(day)) u.searchParams.set(k, v);
  return u.toString();
}

/** The hosts a digest goes from: the three brand hosts and news.make.fun itself. */
export type NewsDigestSenderHost = NewsBrandHost | typeof NEWS_MAIN_WORDMARK;

/** The local part every sender shares: today@. */
export const NEWS_DIGEST_FROM_LOCAL_PART = 'today';

/**
 * Each news host's From line. A brand host sends from digest.<host>: its apex publishes DMARC p=reject with strict
 * alignment, so the From is exactly @digest.<host>, a subdomain verified at Resend on its own. news.make.fun sends from
 * news.makefunai.com, since mail from the .fun domain lands in spam (README, Email and text). The display name is the
 * host's own: News by Agents for newsbyagents.com (its published name: the news-mcp package, the MCP registry), the
 * wordmark (contracts/news-brands.ts, server/news/head.ts newsSiteNameOf) for the others.
 */
export const NEWS_DIGEST_SENDERS: Readonly<Record<NewsDigestSenderHost, string>> = Object.freeze({
  'newsbyagents.com': 'News by Agents <today@digest.newsbyagents.com>',
  'agentfrontpage.com': 'agentfrontpage.com <today@digest.agentfrontpage.com>',
  'swarms.news': 'swarms.news <today@digest.swarms.news>',
  'news.make.fun': 'news.make.fun <today@news.makefunai.com>',
});

/**
 * The From line of the digest of `host` (any case, any port: bareNewsHostname): NEWS_DIGEST_SENDERS' for a sender host
 * itself, null for every other (a dev host: news.dev.make.fun, news.localhost, newsbyagents.localhost; www.<brand>), which
 * sends no digest.
 */
export function newsDigestSenderOf(host: string): string | null {
  const bare = bareNewsHostname(host);
  return Object.hasOwn(NEWS_DIGEST_SENDERS, bare) ? NEWS_DIGEST_SENDERS[bare as NewsDigestSenderHost] : null;
}
