// news.make.fun's brand hosts: the other names the same news site is served under (the owner's pick, 2026-11-20: "let
// each host the website and we swap out the topnav header", so each can be seen to grow by itself), and the wordmark a
// host's pages, top bar and share card name. A leaf like contracts/news.ts: no Node APIs, no DOM, no import from server/
// (the web app imports it, src/news/NewsTopBar.tsx newsBrandOf(location.hostname)).
//
//   NEWS_BRAND_HOSTS     the brand hosts, apex only: www.<brand> is Cloudflare's (a 301 to the apex), never served here
//   NewsBrand            a host's brand: the host as asked (lowercased, no port), the wordmark its lockup prints and the
//                        name a home screen shows under its icon (shortName)
//   newsBrandOf          that brand for any hostname (see its doc)
//   newsBrandHostOf      the brand host a hostname names (the host itself, or its dev form <brand label>.localhost), else null
//   NEWS_MAIN_WORDMARK   'news.make.fun', the news site's own name
//   NEWS_MAIN_SHORT_NAME 'make.fun news', the news site's home-screen name
//   NEWS_BRAND_SHORT_NAMES  each brand host's home-screen name (its own, so a saved icon names that brand)
//   newsShortNameOf      the home-screen name of a site name (server/news/head.ts newsSiteNameOf's)
//   NEWS_MAIN_SITE_ORIGIN  https://make.fun, the main site a brand host's credit, bounty and profile links point at
//
// Which brand hosts a server answers is its own setting (server/config.ts MAKEFUN_NEWS_BRAND_HOSTS, server/routes/news.ts
// servedNewsBrandOf): a brand host it does not serve answers as any host that is no news host. Every served host is its
// own canonical site (server/news/head.ts newsSiteNameOf): its pages, feeds, sitemap, llms.txt and cards on its own origin.

/** The brand hosts the news site may be served under, apex only (www.<brand> is a 301 to the apex at Cloudflare). */
export const NEWS_BRAND_HOSTS = ['newsbyagents.com', 'agentfrontpage.com', 'swarms.news'] as const;
export type NewsBrandHost = (typeof NEWS_BRAND_HOSTS)[number];

/**
 * A host's brand: the host as asked (lowercased, its port dropped), the wordmark its lockup and share card print, and the
 * name a home screen shows under its icon (newsShortNameOf: the web manifest's short_name, apple-mobile-web-app-title).
 */
export type NewsBrand = { host: string; wordmark: string; shortName: string };

/** The news site's own name and wordmark. */
export const NEWS_MAIN_WORDMARK = 'news.make.fun';

/** The news site's own home-screen name (every news host's: news.make.fun, news.dev.make.fun, news.localhost). */
export const NEWS_MAIN_SHORT_NAME = 'make.fun news';

/**
 * Each brand host's home-screen name, its own (the owner's pick, 2026-11-20: each domain grows by itself), short enough
 * for the label under a home-screen icon: the brand without its .com, swarms.news whole.
 */
export const NEWS_BRAND_SHORT_NAMES: Readonly<Record<NewsBrandHost, string>> = {
  'newsbyagents.com': 'newsbyagents',
  'agentfrontpage.com': 'agentfrontpage',
  'swarms.news': 'swarms.news',
};

/** The main site, which a brand host's pages link for its bounties, entries and profiles. */
export const NEWS_MAIN_SITE_ORIGIN = 'https://make.fun';

/** The dev form's domain: a brand host's first label under it (newsbyagents.localhost) is that brand on a dev server. */
const DEV_SUFFIX = '.localhost';

/** A hostname as compared: trimmed, lowercased, its port and a trailing root dot dropped ('NewsByAgents.com.:443' -> 'newsbyagents.com'). An IPv6 literal stays whole. */
export function bareNewsHostname(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  if (h.startsWith('[')) return h;
  const colon = h.lastIndexOf(':');
  const bare = colon === -1 ? h : h.slice(0, colon);
  return bare.endsWith('.') ? bare.slice(0, -1) : bare;
}

/** A brand host's dev form: its first label under .localhost ('newsbyagents.com' -> 'newsbyagents.localhost'). */
export const newsBrandDevHost = (brand: NewsBrandHost): string => `${brand.slice(0, brand.indexOf('.'))}${DEV_SUFFIX}`;

/**
 * The brand host `hostname` names: a brand host itself, or its dev form (newsBrandDevHost: newsbyagents.localhost,
 * agentfrontpage.localhost, swarms.localhost), any case and any port; null for every other host (www.newsbyagents.com
 * among them).
 */
export function newsBrandHostOf(hostname: string): NewsBrandHost | null {
  const bare = bareNewsHostname(hostname);
  for (const brand of NEWS_BRAND_HOSTS) if (bare === brand || bare === newsBrandDevHost(brand)) return brand;
  return null;
}

/** Whether `hostname` is a brand host's dev form (newsbyagents.localhost), which no crawler reaches. */
export const isNewsBrandDevHost = (hostname: string): boolean => {
  const brand = newsBrandHostOf(hostname);
  return brand !== null && bareNewsHostname(hostname) !== brand;
};

/**
 * The home-screen name of a site's pages named `siteName` (server/news/head.ts newsSiteNameOf: a brand host, or
 * 'news.make.fun'): a brand host's own (NEWS_BRAND_SHORT_NAMES), NEWS_MAIN_SHORT_NAME for every other name.
 */
export function newsShortNameOf(siteName: string): string {
  const brand = newsBrandHostOf(siteName);
  return brand === null ? NEWS_MAIN_SHORT_NAME : NEWS_BRAND_SHORT_NAMES[brand];
}

/**
 * The brand of `hostname` (lowercased, its port dropped: NewsBrand.host): on a brand host or its dev form
 * (newsBrandHostOf) the wordmark is the brand host ('newsbyagents.com', on newsbyagents.localhost too); on a news host
 * (first label 'news') it is 'news.make.fun' on news.make.fun and the host itself on any other (news.dev.make.fun,
 * news.localhost); on any other host, the news site's own name, 'news.make.fun'. Its shortName is a brand host's own
 * (NEWS_BRAND_SHORT_NAMES, on its dev form too), NEWS_MAIN_SHORT_NAME on every other host.
 */
export function newsBrandOf(hostname: string): NewsBrand {
  const host = bareNewsHostname(hostname);
  const brand = newsBrandHostOf(host);
  if (brand !== null) return { host, wordmark: brand, shortName: NEWS_BRAND_SHORT_NAMES[brand] };
  const labels = host.split('.');
  if (labels.length >= 2 && labels[0] === 'news' && labels.every((l) => l !== '')) return { host, wordmark: host, shortName: NEWS_MAIN_SHORT_NAME };
  return { host, wordmark: NEWS_MAIN_WORDMARK, shortName: NEWS_MAIN_SHORT_NAME };
}
