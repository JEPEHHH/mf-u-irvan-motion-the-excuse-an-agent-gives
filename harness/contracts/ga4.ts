// The make.fun GA4 event contract: every event the site and the server send to Google Analytics 4, the
// parameters each carries and how GA reports them, the user properties, the primary CTA ids, and the query
// keys a page_location may keep. One source of truth for three readers, none of which may name an event or a
// parameter this file does not hold: the browser client (a type-checked sbTrack-style call), the server's
// Measurement Protocol sender, and the audit (.cosmos/skills/ga-audit, whose tracking-plan.json mirrors this
// file and is held equal to it by tests/unit/ga4-plan.test.ts). No imports and no Node APIs: safe for the
// Vite app and the node server alike.
//
//   GA4_HOSTS               the hostnames the property receives
//   GA4_NEWS_HOSTS          the news site's hostnames, which report into it too (not the site's own: GA4_HOSTS)
//   GA4_REALTIME_ON_A_PAGE  the Realtime filter that counts only people on a page (every realtime visitor read takes it)
//   GA4_EVENTS              event name -> { sender, key, expect, since, params, where, stitch }
//   GA4_APP_PARAMS          the app dimensions (app_platform, app_channel, app_build) every event from inside make.fun's
//                           app carries, beside its own params; ga4AppParams makes them from the shell's identity
//   GA4_USER_PROPERTIES     user-scoped dimensions (customUser:<name>)
//   GA4_PRIMARY_CTA         the data-track ids of the primary CTAs, and the events that hand off from them
//   GA4_PAGE_TYPES          page_view's page_type: the route names of src/routes/match.ts that are tracked
//   GA4_NEWS_PAGE_TYPES     page_view's page_type on a news host (GA4_NEWS_HOSTS): the news site's own pages, a
//                           story's own page (news-story) among them
//   GA4_PAGE_LOCATION_*     what page_location may carry (ga4PageLocation applies it, client and server alike)
//   GA4_CLICK_IDS           ad click ids a landing keeps, and the network each belongs to (GA4_CLICK_IDS_WITHHELD: kept
//                           for their network only, their value never sent)
//   GA4_BUILTIN_DIMENSIONS  the GA Data API name each 'builtin' parameter is read as
//   GA4_LIMITS              GA4's name, count and length limits the contract is held to
//   Ga4EventName, Ga4Params<E>   the types a call site is checked against
//
// A parameter's kind says how GA reports it:
//   dim         an event-scoped custom dimension (customEvent:<name>), registered in the property
//   metric      an event-scoped custom metric (customEvent:<name>), registered in the property
//   builtin     a parameter GA reads natively (link_url, search_term, value, currency, transaction_id,
//               page_location): nothing to register, its Data API name is in GA4_BUILTIN_DIMENSIONS
//   unreported  sent but not registered (an id too fine for a dimension): BigQuery export only
// One parameter name has one kind in every event (GA refuses a name as both a dimension and a metric, and
// a dimension is registered once per name, not once per event). Dimension values are strings (a boolean is
// 'true' or 'false', at most 100 characters); a metric's and `value`'s are numbers. A parameter an event
// carries only in some cases (page_view's competition_slug: on a bounty's page, not the board) names the
// case in the event's `when`, so ga-audit's param coverage reads its '(not set)' on the rows of that case
// alone instead of filing every other page as a dropped parameter. A parameter that ships after its event
// (skill_fetch's bot), or whose dimension GA registered after the event shipped (experiment_exposure's arm), names its
// own day in the event's `paramSince`, so that coverage reads it from that day on and never files the event's earlier
// rows, sent before the parameter existed or before GA read it, as dropped.
//
// sender: 'client' events come from the browser's gtag; 'server' events from the Measurement Protocol, sent
// after the action is committed (never before, never for an action that was refused); 'both' only when one
// event name is sent from each side for different actions. A server-sent event carries `stitch`, how it is
// tied to the visitor:
//   browser    the request is always the visitor's browser: client_id and session_id from its _ga and
//              _ga_<stream> cookies
//   request    either: the browser's cookies when the request carries them, else (an agent, the CLI, an API
//              key) the account's stored ga_client_id
//   account    no browser is in the request (a worker, an admin acting for the account): the account's
//              stored ga_client_id
//   anonymous  no account, no cookie: a per-day bucket client_id (skill_fetch, mcp_request), never a person
// Every server-sent event also carries user_id = the account id (opaque, not PII, absent only on
// 'anonymous'), page_location (ga4PageLocation of the page the action came from, on the public origin),
// session_id and engagement_time_msec (GA4_SERVER_COMMON_PARAMS).
//
// No PII in any parameter, user property or page_location: no email, phone, wallet address, handle, IP,
// claim code, device code, token or free text a visitor typed. A competition slug, an entry id and a
// proposal id are public or opaque and may ride. Admin pages are never tracked (GA4_PAGE_TYPES leaves them
// out; staff actions send nothing of their own: a staff action that is a user's conversion, a proposal
// approved, is sent for the user's account).
//
// Consent: no banner and no consent-mode gate. The client sends nothing from an automated browser
// (navigator.webdriver) unless ?ga_force=1.

/** The day this contract's events were first planned: every `since` below but the referral events'. */
const SINCE = '2026-11-05';
/** The day the referral program's events ship (referral_share, referral_signup, referral_claim). */
const REFERRALS_SINCE = '2026-11-08';
/** The day skill_fetch's `bot` ships, with agent_kind ai_search (an AI answer engine's fetcher told from a crawler). */
const SKILL_FETCH_BOT_SINCE = '2026-11-08';
/** The day the agent-fetch counter ships: mcp_request, and skill_fetch's `verified` (an AI fetcher's address against its owner's list). */
const AGENT_FETCH_SINCE = '2026-11-08';
/**
 * The day skill_fetch's handoff_ga and handoff_touch ship (whether a read of skill.md came with the copied prompt's `?ga=`, and
 * whether that value carried the visitor's first touch): the measure of the handoff lost between a copied prompt and the agent.
 */
const SKILL_FETCH_HANDOFF_SINCE = '2026-11-19';
/** The day discord_join ships (a Join Discord click, named, where Enhanced measurement saw only a generic outbound click). */
const DISCORD_JOIN_SINCE = '2026-11-09';
/**
 * The day discord_bot_add ships (Add the make.fun bot, in the add-the-bot dialog of that day; from then on in the two-step
 * Discord pop-up the Discord controls open while the site's Discord buttons are in join_and_bot mode).
 */
const DISCORD_BOT_SINCE = '2026-11-15';
/** The day page_exit's page_type and sign_up's via ship (an exit split by page without a join; a person's sign-up told from an agent's key mint). */
const EXIT_TYPE_SIGNUP_VIA_SINCE = '2026-11-09';
/** The day agent_prompt_email ships (a phone's Email me the prompt beside Copy for your agent). */
const PROMPT_EMAIL_SINCE = '2026-11-10';
/** The day the discord_reward A/B test ships: experiment_exposure, and the Discord quest's CTAs (link_area quest_offer). */
const DISCORD_REWARD_SINCE = '2026-11-09';
/** The day the tutorial A/B test ships: experiment_exposure's experiment tutorial, tutorial_step and tutorial_end, the tours' CTAs. */
const TUTORIAL_SINCE = '2026-11-09';
/**
 * The first whole day GA reads the `experiment` and `arm` dimensions (experiment_exposure's both, tutorial_step's and
 * tutorial_end's arm). The client sent them from the events' first day, but the two custom dimensions were registered in
 * the property only on 2026-11-14, at about 11:00 Pacific, GA's day (their Admin API ids, 16342436122 and 16342447321,
 * follow the 2026-11-05 batch's 1628…), and GA fills a dimension only for events it processes after the registration:
 * every one of those events reads '(not set)' from 2026-11-09 to 11:00 on 2026-11-14 and none after (make.fun, read
 * 2026-11-19), while step and outcome, registered with the batch, read set from the first day.
 */
const ARM_DIMS_SINCE = '2026-11-15';
/**
 * The first whole day referral_share carries placement: it shipped with the header's invite dialog (header_invite),
 * deployed in the evening of 2026-11-18 (its first placement at 19:00 Pacific, GA's day); that day's earlier shares, all
 * the Referrals tab's, went out without one, as every share did before.
 */
const REFERRAL_PLACEMENT_SINCE = '2026-11-19';
/** The day the on-chain side market's events are planned: market_trade's action, and market_close_position. */
const SIDE_MARKET_SINCE = '2026-11-13';
/** The day the slow-load prompt ships: slow_load_prompt, and its links' CTAs (link_area slow_load | slow_load_update). */
const SLOW_LOAD_SINCE = '2026-11-14';
/**
 * The first whole day GA reads the app shell's telemetry: the app dimensions (GA4_APP_PARAMS), shell_launch, shell_revive,
 * shell_tap_open, wallet_return, and push_subscribe's kind. Planned 2026-11-22 for the next release; it must be moved to the
 * first whole day after both that release went live and the new dimensions (app_platform, app_channel, app_build, kind,
 * road) were registered in the property, whichever is later (GA fills a dimension only for the events it processes after
 * its registration: ARM_DIMS_SINCE).
 */
const APP_SHELL_SINCE = '2026-11-23';
/**
 * The first whole day GA reads news_subscribe, the news digest's sign-up from a front page's footer (src/news/DigestForm.tsx).
 * Planned 2026-11-24 for the next release: like APP_SHELL_SINCE it must be moved to the first whole day after both that
 * release went live with MAKEFUN_NEWS_DIGEST on and its new `lang` dimension was registered in the property, whichever is
 * later (`placement` is registered already).
 */
const NEWS_DIGEST_SINCE = '2026-11-25';
/**
 * The first whole day GA reads the app_install A/B test (server/api-types/app-install.ts): experiment_exposure's
 * experiment app_install, app_install_click, app_install_dismiss and the ab_app_install user property. Planned 2026-11-24
 * for the next release: like APP_SHELL_SINCE it must be moved to the first whole day after both that release went live
 * and the new definitions (the `store` event dimension and the ab_app_install user dimension) were registered in the
 * property, whichever is later (`arm` and `experiment` are registered already).
 */
const APP_INSTALL_SINCE = '2026-11-25';

/** The hostnames the property receives: `host` is the site, `hosts` every host expected to report. */
export const GA4_HOSTS = { host: 'make.fun', hosts: ['make.fun', 'dev.make.fun'] } as const;

/**
 * The news site's hostnames, which report into the same property: news.make.fun and news.dev.make.fun (contracts/news.ts
 * isNewsHost) and the brand hosts it is served under (contracts/news-brands.ts NEWS_BRAND_HOSTS), written out because this
 * file imports nothing (tests/unit/news-ga4.test.ts holds them equal). Their pages send page_view under GA4_NEWS_PAGE_TYPES
 * (src/lib/ga4.ts ga4PageOf), and an agent's read of their machine files sends skill_fetch with page_location on the host
 * read (server/ga4.ts ga4PageLocationOf), so GA's hostName splits the hosts, server events and pages alike. Not in
 * GA4_HOSTS.hosts, the site's own: a visitor a news host sends to make.fun is still a referral (acq_*, the first touch).
 * They also report into a property of their own while MAKEFUN_NEWS_GA4_MEASUREMENT_ID is set (server/config.ts
 * config.news.ga4): page_view and page_exit from the browser and the news skill_fetch from the server, the same events
 * and params as here, sent to both properties; no make.fun host and no other event reaches it.
 */
export const GA4_NEWS_HOSTS = ['news.make.fun', 'news.dev.make.fun', 'newsbyagents.com', 'agentfrontpage.com', 'swarms.news'] as const;

/**
 * The FilterExpression every Realtime (runRealtimeReport) visitor read carries: a user counts once one of their events is on a page
 * (unifiedScreenName not empty). It drops the users whose every event the server sent (sender 'server': no page title), no visitors
 * and at peak most of Realtime's activeUsers (7,629 of about 9,000 on 2026-11-19). GA refuses it beside eventName (400), so an
 * eventCount by eventName read stays whole. Read by deploy/grafana/dashboards/traffic-live.ts, traffic.ts and ga-audit's realtime lane.
 */
export const GA4_REALTIME_ON_A_PAGE = {
  notExpression: { filter: { fieldName: 'unifiedScreenName', stringFilter: { matchType: 'EXACT', value: '' } } },
} as const;

export type Ga4ParamKind = 'dim' | 'metric' | 'builtin' | 'unreported';
export type Ga4Sender = 'client' | 'server' | 'both';
export type Ga4Expect = 'always' | 'sometimes';
export type Ga4Stitch = 'browser' | 'request' | 'account' | 'anonymous';

export interface Ga4EventSpec {
  readonly sender: Ga4Sender;
  /** Marked a key event in GA: a conversion (a money or commit act, or the primary CTA). */
  readonly key: boolean;
  /** always: every audit window should hold some; sometimes: a window may legitimately hold none. */
  readonly expect: Ga4Expect;
  readonly since: string;
  /** Present on every event a server sends (sender server or both), never on a client one. */
  readonly stitch?: Ga4Stitch;
  readonly params: Readonly<Record<string, Ga4ParamKind>>;
  /**
   * The params it carries only in some cases, each with its case: other 'dim' params of this event and the values under which
   * it is always set (tracking-plan.json `when`). A param left out is carried on every event the sender sends.
   */
  readonly when?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  /**
   * The params GA reads later than the event, each with the first whole day it does, later than the event's `since`
   * (tracking-plan.json params[].since): a param that shipped after the event (the day its sender went live, the next one
   * when it went live late in GA's day), or one whose custom dimension was registered after the event shipped (GA fills a
   * dimension only for the events it processes after its registration). A param left out is read from the event's own day.
   */
  readonly paramSince?: Readonly<Record<string, string>>;
  /** `<repo path>#<symbol>`: the file and the identifier at or beside which the event is sent. */
  readonly where: string;
}

/** GA4's own limits (support.google.com/analytics/answer/9267744), the contract is held to them. */
export const GA4_LIMITS = {
  eventNameLength: 40,
  paramNameLength: 40,
  paramValueLength: 100,
  userPropertyValueLength: 36,
  paramsPerEvent: 25,
  eventDimensions: 50,
  userDimensions: 25,
  metrics: 50,
  keyEvents: 30,
  reservedPrefixes: ['ga_', 'google_', 'firebase_'],
  // GA's reserved event names (app_install is one of them: the PWA install is `pwa_install`).
  reservedEvents: [
    'ad_activeview', 'ad_click', 'ad_exposure', 'ad_impression', 'ad_query', 'adunit_exposure',
    'app_clear_data', 'app_install', 'app_remove', 'app_update', 'error', 'first_open', 'first_visit',
    'in_app_purchase', 'notification_dismiss', 'notification_foreground', 'notification_open',
    'notification_receive', 'os_update', 'screen_view', 'session_start', 'user_engagement',
  ],
} as const;

/** Where a 'builtin' parameter is read: its GA Data API name. */
export const GA4_BUILTIN_DIMENSIONS = {
  link_url: 'linkUrl',
  search_term: 'searchTerm',
  value: 'eventValue',
  currency: 'currencyCode',
  transaction_id: 'transactionId',
  page_location: 'pageLocation',
} as const;

/** What every Measurement Protocol event carries besides its own params (see the header). */
export const GA4_SERVER_COMMON_PARAMS = {
  page_location: 'builtin',
  session_id: 'unreported',
  engagement_time_msec: 'unreported',
} as const satisfies Record<string, Ga4ParamKind>;

/**
 * The app dimensions: which make.fun app an event came from, so app traffic is told from browser traffic in every report.
 * Read from the app shell's identity (the app shell contract v1: window.makefunShell, else the `MakefunApp/<version>
 * (<platform>; <channel>; <build>)` token of the web view's user agent):
 *   app_platform  ios | android (GA4_APP_PLATFORMS)
 *   app_channel   the build line: ios-team | ios-store | android-team | android-dapp | android-play, as the shell names it
 *   app_build     the build number, digits
 * Carried, beside an event's own params, by every event from inside the app, and by nothing else:
 *   - the browser (src/lib/ga4.ts createGa4): inside the app, one gtag('set', ...) of the three ahead of the tag's start, so
 *     the Google tag's own page_view, every event the app sends and Enhanced measurement's carry them; a page in a browser
 *     outside the app sets none;
 *   - the server (server/ga4.ts): an event whose stitch reads the request (browser, request) and whose request's user agent
 *     carries the shell's token (server/shell/channel.ts shellOf); `account` and `anonymous` events, which no request of
 *     the person's sends, carry none.
 * So an event's '(not set)' app_platform (from APP_SHELL_SINCE on) is the web: a browser outside the app, an agent, or a
 * server event no person's request sent. A value the shell sent malformed reads `unknown` (a channel outside [a-z-]{1,32}, a
 * build that is no 1 to 20 digits).
 */
export const GA4_APP_PARAMS = {
  app_platform: 'dim',
  app_channel: 'dim',
  app_build: 'dim',
} as const satisfies Record<string, Ga4ParamKind>;

/** app_platform's values: the shell platforms. */
export const GA4_APP_PLATFORMS = ['ios', 'android'] as const;

/** The app dimensions' values for an event. */
export type Ga4AppParams = { -readonly [P in keyof typeof GA4_APP_PARAMS]?: string };

/**
 * The app dimensions for an event from the shell `shell` names (its platform, channel and build as the shell sent them),
 * or none ({}) outside the app: null, or a platform that is not ios or android.
 */
export function ga4AppParams(shell: { readonly platform: string; readonly channel: string; readonly build: string } | null | undefined): Ga4AppParams {
  if (!shell || !(GA4_APP_PLATFORMS as readonly string[]).includes(shell.platform)) return {};
  return {
    app_platform: shell.platform,
    app_channel: /^[a-z-]{1,32}$/.test(shell.channel) ? shell.channel : 'unknown',
    app_build: /^[0-9]{1,20}$/.test(shell.build) ? shell.build : 'unknown',
  };
}

export const GA4_EVENTS = {
  // ---------------------------------------------------------------------------------------------- client
  // Every page and every in-app navigation, exactly one each (the app is a SPA, so GA's own page-change
  // page_view is switched off and this one is sent per route change). A document's first tracked page is
  // the Google tag's own load page_view, its config's (src/lib/ga4.ts GA4_CONFIG): it carries
  // page_location and page_title (the page_type) but no page_type param, so a landing reads by page_title;
  // every later page is the app's own event with page_type. page_type is the Route name of src/routes/match.ts
  // (sponsorRouteOf's `sponsor` and `proposal` too, and signInErrorOf's `sign-in-error`, the home page's
  // address under a failed sign-in's query); competition_slug is set on a page that has one: always
  // on bounty and leaderboard, on archive only as a bounty's entry breakdown (/bounty/<slug>/e/<id>, not
  // /s/<id>), never on another page type (src/lib/ga4.ts#ga4PageOf). On a news host (GA4_NEWS_HOSTS) page_type is the news
  // site's own page (GA4_NEWS_PAGE_TYPES: news-front | news-day | news-story | news-search | news-about |
  // news-other), never one of make.fun's routes, and no competition_slug rides (a story's page sends no slug).
  page_view: {
    sender: 'client', key: false, expect: 'always', since: SINCE,
    params: { page_type: 'dim', competition_slug: 'dim' },
    when: { competition_slug: { page_type: ['bounty', 'leaderboard'] } },
    where: 'src/App.tsx#matchRoute',
  },
  // Any click on a link or button carrying data-track (else a stable id, else 'link'). cta_id is the
  // data-track value (GA4_PRIMARY_CTA lists the primary ones), link_area the nearest data-track-area (GA4_PRIMARY_CTA
  // lists the primary CTAs' areas; beta_welcome is the beta welcome dialog, src/components/help/BetaWelcome.tsx, whose
  // Join our Discord is beta_welcome_discord, whose Reviewed on Trustpilot tag is beta_welcome_trustpilot and whose Let's
  // make some fun and X are beta_welcome_close; discord_bot, from DISCORD_BOT_SINCE, is the Discord pop-up, the add-the-bot
  // dialog of that day and from then on the two-step pop-up every Discord control opens while the site's Discord buttons
  // are in join_and_bot mode (the admin desk's toggle), src/components/discord/DiscordBotDialog.tsx: its step 1, Join the
  // make.fun Discord, discord_bot_join, its step 2, Add the make.fun bot, discord_bot_add, the Follow @makefunai on X link
  // under them discord_bot_follow_x (also the back_soon pop-up's one action, Follow @makefunai on X, and from 2026-11-17 the
  // back_soon_bot pop-up's first, beside its Add the make.fun bot, discord_bot_add), its X discord_bot_close; quest_offer, from
  // DISCORD_REWARD_SINCE, is the Discord quest, src/components/quests/: its modal's one action by state,
  // quest_continue_discord | quest_link_discord | quest_join_server | quest_claim, the 'I joined, check again' link under
  // Join our server quest_check_join, its X quest_close, and the header's pill and a phone's bottom bar that open it
  // again, quest_reopen); quick_tour and full_tour, from TUTORIAL_SINCE, are the tutorial's two tours, src/components/tutorial/
  // (src/lib/tutorial.ts TUTORIAL_TRACK): Skip tutorial_skip, the X tutorial_close, Next tutorial_next, Copy prompt and the
  // prompt's copy icon home_earn_agent_copy (the band's primary CTA id: the same prompt copied), I pasted it tutorial_pasted,
  // Back tutorial_back, Find a bounty tutorial_find_bounty, Join our Discord tutorial_discord, the first step's Reviewed
  // on Trustpilot tag tutorial_trustpilot, and the paste step's app picker tutorial_app_claude_code | tutorial_app_codex |
  // tutorial_app_cursor; first_win_bonus is the first-win bonus band, src/components/quests/FirstWinBand.tsx (the
  // first_win_bonus test's offer arm alone; src/lib/firstWinPromo.ts FIRST_WIN_TRACK): Sign up first_win_sign_up, Find a
  // bounty first_win_find_bounty, Claim $10 first_win_claim, its X first_win_dismiss; tab_bar is a phone's bottom tab
  // bar, src/components/SiteTabBar.tsx, on every page under 40rem of window: its tabs
  // tab_home | tab_create (Create, the new proposal's page, /sponsor/new) | tab_saved (Saved, /?list=saved) |
  // tab_profile (signed out, tab_profile opens the sign-in dialog: sign_in_open); slow_load and slow_load_update, from
  // SLOW_LOAD_SINCE, are the slow-load prompt, src/components/SlowLoadPrompt.tsx (a page on its skeletons 8 s;
  // slow_load_update when the maintenance page answered its reads, a deploy going live; its showing is slow_load_prompt):
  // Follow @makefunai on X slow_load_follow_x, Check status slow_load_status; load_failed, from 2026-11-16, is the
  // load-failed panel, src/components/LoadFailedPanel.tsx (every public page whose first read failed with nothing to
  // show: the prompt's look set inline where its content would be): Follow @makefunai on X load_failed_follow_x, Check
  // status load_failed_status (its Try again carries no data-track and sends nothing); home_market, from 2026-11-17 until
  // 2026-11-19 (its slot then came off the home page, so nothing sends it), is the home market banner, src/components/board/MarketSpotlight.tsx (the home_spotlight test's market arm, in the home
  // page's Standout slot, desktop only; signed in both buttons are links to the market's Odds tab, link_url
  // /bounty/<slug>#odds, signed out both open the sign-in dialog, no link_url, with sign_in_open placement
  // home_market): Yes home_market_yes, No home_market_no, the leader's name and picture (their profile, link_url
  // /u/<handle>) home_market_leader; referral_invite, from 2026-11-18, is the header's invite dialog,
  // src/components/board/ReferralInviteDialog.tsx (opened by the header's gift button, signed in, cta_id referral_open
  // in link_area header): Copy referral_share (the clipboard's copy also sends the referral_share event, placement
  // header_invite), Share on X referral_share_x, See your referrals referral_view_all, its X referral_invite_close (Esc
  // and the backdrop send no click);
  // home_odds_strip, from 2026-11-18, is the phone home's Odds strip,
  // src/components/board/OddsStrip.tsx (the phone_odds_strip test's strip arm, one row under the hero carousel's dots,
  // signed in and on a phone only; plain links): the row for the current slide's market, home_odds_strip_odds (link_url
  // /bounty/<slug>#odds), and the quiet row where that slide has none, home_odds_strip_all (link_url /odds); else
  // header | footer | main by
  // landmark (the footer's Reviews on Trustpilot link, src/components/Trustpilot.tsx TrustpilotLink, is footer_trustpilot;
  // the footer's Discord band's Follow @makefunai on X, src/components/DiscordBand.tsx, from
  // 2026-11-15, is footer_band_follow_x; the phone board's list control, src/components/board/ListControl.tsx, the one
  // button that opens its sort and filter sheet, is board_controls_open, in main).
  cta_click: {
    sender: 'client', key: false, expect: 'always', since: SINCE,
    params: { cta_id: 'dim', link_url: 'builtin', link_area: 'dim' },
    where: 'src/main.tsx#startInstall',
  },
  // A [data-track-section] element first scrolled into view on a page; section_index is its order on the page. On a
  // bounty's pages each tab but the Overview is one section, its panel (src/components/board/BountyPage.tsx, from
  // 2026-11-19): bounty_leaderboard, bounty_feed, bounty_odds, bounty_comments. A panel mounted or unhidden as its tab
  // shows is watched like any other section (src/lib/ga4.ts rescans on every DOM change).
  section_view: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { section_id: 'dim', section_index: 'metric' },
    where: 'src/main.tsx#startInstall',
  },
  // Sent once when a page is left or hidden, by beacon: how far and how long the visitor read, and the
  // Core Web Vitals of the page (LCP and INP in ms, CLS times 1000 as an integer). page_type is the page's page_view
  // page_type (from EXIT_TYPE_SIGNUP_VIA_SINCE). last_section is set only where a page renders [data-track-section]: the
  // board (HomeHero, StandoutSpotlight or MarketSpotlight in the slot under it, HomeEarnBand, AllBounties), the referral
  // landing (the board under who invited you) and a bounty's pages (BountyPage, ClosedResults), and there only once a
  // section was seen. On a bounty's pages every tab has them: the Overview's own, and from 2026-11-19 each other tab's
  // panel is one, bounty_leaderboard (the Leaderboard tab, page_type leaderboard), bounty_feed (the Feed, a phone's
  // default on a bounty with one), bounty_odds and bounty_comments (to then those tabs rendered none, so an exit from one
  // carried no last_section). inp_ms is the worst interaction under 10 s (from the release after 2026-11-19;
  // src/lib/ga4.ts INP_MAX_INTERACTION_MS skips a longer one, which Chromium on Android reports for a page that stopped
  // painting): a longer next paint is not an interaction latency, and a page whose every interaction ran longer sends no
  // inp_ms.
  page_exit: {
    sender: 'client', key: false, expect: 'always', since: SINCE,
    params: {
      page_type: 'dim', max_scroll: 'metric', last_section: 'dim', engaged_ms: 'metric', lcp_ms: 'metric', inp_ms: 'metric',
      cls_x1000: 'metric',
    },
    when: { last_section: { page_type: ['board', 'referral', 'bounty', 'leaderboard'] } },
    paramSince: { page_type: EXIT_TYPE_SIGNUP_VIA_SINCE },
    where: 'src/main.tsx#startInstall',
  },
  // An uncaught error or unhandled rejection: message is the error's own text cut to 100 characters with
  // any URL query removed (an empty or bare 'Uncaught' one is the thrown value's name or text), error_source the script
  // it came from (a path, never a query): the event's file, else the first same-origin frame of the error's or the
  // rejection's stack; 'cross-origin' for a bare 'Script error.' with no file (another origin's script, hidden by CORS).
  // Never named `source`: GA reads an event param named source as the session's traffic source (until 2026-11-19 it
  // went out as `source`, which made script paths the source of ~19k sessions; customEvent:source holds those days).
  js_error: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { message: 'dim', error_source: 'dim' },
    paramSince: { error_source: '2026-11-19' },
    where: 'src/main.tsx#startInstall',
  },
  // KEY. The human -> agent hand-off, the site's primary CTA: the visitor copies the one-line prompt
  // ("Read make.fun/skill.md and enter the bounty ...") for their coding agent. The whole product starts
  // here (the agent funnel's first step after the landing), so it is the conversion the ads optimize for.
  // placement home_hero | bounty_page | sponsor_new (the new proposal page's Copy for your agent, src/components/sponsor/
  // NewProposalPage.tsx) | guide (a guide's Quick start, src/components/help/Guide.tsx) |
  // home_earn_band (the home page's Ways to earn band in the site footer, src/components/board/HomeEarnBand.tsx: its
  // prompt chip's copy icon) | quick_tour | full_tour (the tutorial's copy
  // step, from TUTORIAL_SINCE, src/components/tutorial/TutorialHost.tsx: its Copy prompt and its prompt's copy icon);
  // copy_result copied | manual (the clipboard refused and the prompt was selected for Ctrl+C). competition_slug is the
  // bounty the bar is for: none on the new proposal page, which has no bounty yet, nor on a guide, the band or
  // a tour, whose prompt names none.
  agent_prompt_copy: {
    sender: 'client', key: true, expect: 'always', since: SINCE,
    params: { placement: 'dim', competition_slug: 'dim', copy_result: 'dim' },
    when: { competition_slug: { placement: ['home_hero', 'bounty_page'] } },
    where: 'src/components/board/AgentEntryBar.tsx#copyText',
  },
  // The starter kit link of an AgentEntryBar (a .tar.gz whose URL has no extension, so GA's own
  // file_download never sees it: the bar's Starter kit, the home hero band's Download starter kit in Copy for your
  // agent's chevron menu, the header door's Download starter kit in the split's chevron menu, src/components/board/
  // AgentSplit.tsx), and the same download wherever else it is offered: the bounty page's action dock (the tarballs
  // in the same split's chevron menu, or the Download kit half of a listing that takes no entries), the entry
  // dialog's step 1 and the page body's kit downloads (the sealed-window line's final kit, the Kit section's dev and
  // final kits). Sent only for a real kit, not for the agent-guide link it falls back to. placement home_hero |
  // bounty_page | bounty_dock | entry_steps | bounty_kits.
  kit_download: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { placement: 'dim', competition_slug: 'dim' },
    where: 'src/components/board/AgentEntryBar.tsx#kitLink',
  },
  // A phone's Email me the prompt sent (src/components/board/PromptEmail.tsx): the server accepted the address and its email
  // provider took the message (POST /api/agent-prompt/email answered 2xx), so the visitor has the exact Copy for your
  // agent prompt in their inbox to open on a computer. Shown only on a phone (the bar's max-sm) on a server that sends
  // email. Not a key event: it is the hand-off deferred, and the agent's arrival (skill_fetch, then the entry) counts the
  // conversion. Never the address. placement home_hero; competition_slug the hero's bounty.
  agent_prompt_email: {
    sender: 'client', key: false, expect: 'sometimes', since: PROMPT_EMAIL_SINCE,
    params: { placement: 'dim', competition_slug: 'dim' },
    when: { competition_slug: { placement: ['home_hero'] } },
    where: 'src/components/board/PromptEmail.tsx#sendPromptEmail',
  },
  // The sign-in dialog opened; placement is the opening SignInButton's testId (header-sign-in is the header's, sign-in the
  // entry dialog's steps; the signed-out profile, notifications and admin cards run the flow inline and open no dialog,
  // so they send none, only login_start), or create_bounty
  // for the signed-out header's Create a bounty (src/components/board/SiteHeader.tsx opens the same dialog over /sponsor/new),
  // or tab_bar for the Create or Profile tab of a phone's tab bar while signed out (src/App.tsx opens its one dialog over the page in view),
  // or home_market for the home market banner's Yes or No while signed out (src/components/board/MarketSpotlight.tsx),
  // or bounty_hold_appeal for a signed-out arrival at a bounty's #distinct-entrant-appeal (src/components/board/BountyPage.tsx
  // HoldAppealAtFragment opens it before the copy-check appeal).
  sign_in_open: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { placement: 'dim' },
    where: 'src/components/ui.tsx#SignInButton',
  },
  // A sign-in method chosen: GitHub's, Google's, Apple's or Discord's redirect started, or a wallet asked to sign. method
  // github | google | apple | discord | solana | dev.
  login_start: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { method: 'dim' },
    where: 'src/components/auth/SignInDialog.tsx#goToGithub',
  },
  // A wallet sign-in that ended without a session: reason rejected | failed | unavailable.
  login_error: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { method: 'dim', reason: 'dim' },
    where: 'src/components/auth/SignInDialog.tsx#signInWithWallet',
  },
  // A bounty saved or unsaved with the bookmark (browser-local, so no server could see it).
  bounty_save: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { competition_slug: 'dim', saved: 'dim' },
    where: 'src/components/BookmarkButton.tsx#toggle',
  },
  // GA's recommended `search`: the site search, once the query settles. The client sends nothing for a
  // term over 40 characters or one holding '@' or a 32+ character base58 run (an address), and the term
  // lowercased and trimmed. result_count is how many rows it listed.
  search: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { search_term: 'builtin', result_count: 'metric' },
    where: 'src/components/board/SiteSearch.tsx#onQueryChange',
  },
  // GA's recommended `select_content`: a bounty, entry or profile picked from the site search, a board
  // card, a card of the board's live band (src/components/board/LiveBand.tsx) or one of its Upcoming rows
  // (src/components/board/UpcomingRows.tsx). content_type bounty | entry | profile | page; item_id the competition slug
  // or entry id (never a handle); placement site_search | board_card | board_live_band | board_upcoming. A phone's
  // board sends the same three: a bounty's row (src/components/board/BountyRow.tsx) the card's, board_card, a live row
  // or a card of the Live rail (src/components/board/LiveRail.tsx) the band's, board_live_band, and a row of its
  // Upcoming section, the wide board's own row, board_upcoming.
  select_content: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { content_type: 'dim', item_id: 'dim', placement: 'dim' },
    where: 'src/components/BountyCard.tsx#BountyCard',
  },
  // GA's recommended `share`: the win panel's Share on X, or its Copy link. method x | copy_link,
  // content_type win, item_id the competition slug.
  share: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { method: 'dim', content_type: 'dim', item_id: 'dim' },
    where: 'src/components/win/WinCelebration.tsx#xIntentUrl',
  },
  // The account's referral link put out: method copy (the clipboard took the link) | x (Share on X) | native (the
  // browser's share sheet reported it shared); placement referrals_tab (the profile's Referrals tab: its hero's link row,
  // LinkRow, and an empty state's Copy link) | header_invite (the header's invite dialog, src/components/board/
  // ReferralInviteDialog.tsx, from 2026-11-18; before it every share was the tab's and named no placement), read from
  // REFERRAL_PLACEMENT_SINCE. Never the link or its code: the code names the account it credits.
  referral_share: {
    sender: 'client', key: false, expect: 'sometimes', since: REFERRALS_SINCE,
    params: { method: 'dim', placement: 'dim' },
    paramSince: { placement: REFERRAL_PLACEMENT_SINCE },
    where: 'src/components/profile/ReferralsPanel.tsx#LinkRow',
  },
  // A click on a link into the community server (src/components/DiscordBand.tsx: a control showing the server's vanity
  // invite, https://discord.gg/makefun, whose plain click goes through the site's join redirect, /api/discord/join, which
  // sends the browser on to the invite of the visit's source class, or to the vanity when that class has none), sent as
  // the link opens its new tab: community join intent. The same click's cta_click carries link_url
  // https://discord.gg/makefun, the shown href (read in the capture phase, before the click routes it; from 2026-11-15,
  // before it the redirect's address). While the site's Discord buttons are in join mode (the default) that link is the
  // Discord control itself; in join_and_bot mode (the admin desk's toggle) a control's plain click opens the two-step
  // Discord pop-up instead (src/components/discord/DiscordBotDialog.tsx) and this is sent by its step 1, Join the make.fun
  // Discord, under the placement of the control that opened it (discord_bot_add is its step 2). On 2026-11-15, while the
  // community server was closed (Discord banned it), each control opened an add-the-bot dialog in place, and this meant
  // 'clicked a Discord control'. A key
  // event, the second client one beside the primary CTA, so Discord interest counts per source and per ad in GA4's
  // key-event reports and the ads ledger rather than being read off Enhanced measurement's generic `click`; Google Ads
  // imports it as a secondary conversion (counted, never bid on). It is intent, not a join: the join happens off-site, so it sits on no
  // funnel (tests/unit/ga4-plan.test.ts). placement footer_band (the footer's Discord band's Join Discord) |
  // beta_welcome (the beta welcome's Join our Discord) | footer_social (the footer Socials column's Discord) |
  // quest_offer (the Discord quest's Join our server, src/components/quests/QuestHost.tsx, from DISCORD_REWARD_SINCE) |
  // quick_tour | full_tour (a tour's last step's Join our Discord, src/components/tutorial/, from TUTORIAL_SINCE) |
  // discord_page (/discord's Join the server, from 2026-11-15) | early_welcome (2026-11-15 alone: the beta welcome's Join
  // our Discord clicked on the card painted with the document before the app ran, src/lib/earlyWelcome.ts; before and
  // after that day such a click is beta_welcome).
  discord_join: {
    sender: 'client', key: true, expect: 'sometimes', since: DISCORD_JOIN_SINCE,
    params: { placement: 'dim' },
    where: 'src/components/DiscordBand.tsx#trackDiscordJoin',
  },
  // A click on Add the make.fun bot, sent as the site's redirect (/api/discord/bot, which counts it server-side) opens
  // Discord's add-app page in a new tab: the bot's add intent. From DISCORD_BOT_SINCE, the add-the-bot dialog's action on
  // that day; from then on the two-step Discord pop-up's step 2 (src/components/discord/DiscordBotDialog.tsx), shown while
  // the site's Discord buttons are in join_and_bot mode, and /discord's own Add the make.fun bot in that mode; from
  // 2026-11-17 also the coming-back-soon pop-up's Add the make.fun bot in back_soon_bot mode (the server down, the bot
  // up), the same event under the same placements. placement
  // is the Discord control that opened the pop-up, one of discord_join's (src/lib/discordBot.ts DISCORD_BOT_PLACEMENTS),
  // discord_page for /discord's own. A key event like discord_join, and off-site like it: the add happens on Discord, so
  // it sits on no funnel.
  discord_bot_add: {
    sender: 'client', key: true, expect: 'sometimes', since: DISCORD_BOT_SINCE,
    params: { placement: 'dim' },
    where: 'src/components/discord/DiscordBotDialog.tsx#trackDiscordBotAdd',
  },
  // An A/B test's arm assigned to a browser, sent as the beta welcome opens on its first visit to a signed-out viewer, the
  // same moment in every arm (intention to treat; an open to a signed-in account sends none, in any arm), once per browser
  // (src/lib/experiments.ts exposeOnce, from src/components/help/BetaWelcome.tsx; the server's experiment_exposure row,
  // POST /api/experiments/exposure, is the count the admin readout reads, this is GA's copy for its own segments).
  // experiment discord_reward (the Discord quest test, sent until it concluded on 2026-11-10: its $2 offer is every new
  // account's quest since, with no arm); arm control (the welcome alone) | offer ($2) | offer_5 ($5) | offer_10 ($10) |
  // offer_20 ($20) (each offer arm's quest modal followed the welcome's close, src/components/quests/QuestHost.tsx).
  // experiment tutorial (the tutorial test, from TUTORIAL_SINCE, its arm drawn on its own, one event per test at the same
  // open); arm control (the welcome alone) | quick_tour (a four-turn
  // ghost chat) | full_tour (a four-step split-card pager) (each tour arm's tour follows the welcome's close, before any
  // quest, src/components/tutorial/TutorialHost.tsx). A browser outside a test (its first visit while that test was off, or
  // one that had the welcome before) sends none for it.
  // experiment ad_landing (the ad_landing test, src/lib/adLandingTest.ts sendAdLandingExposure, also through exposeOnce):
  // sent at another moment, a dog ad's home landing (Meta, or a campaign, content or term naming a dog) while the dog
  // contest takes entries, once per browser at the landing that rolled its arm, signed in or out, both arms alike, just
  // after GA starts; arm control (stayed home) | contest_feed (sent to the contest's Feed tab, /bounty/<slug>#feed, before
  // the landing page_view, so that page is the session's landing page). A forced arm (?ab_ad_landing=) sends none.
  // experiment first_win_bonus (the first_win_bonus test, from 2026-11-10, src/lib/firstWinBonus.ts stepFirstWinBonus,
  // also through exposeOnce): sent at another moment, a signed-out page load once the browser holds its arm (the load
  // that rolled it by GET /api/quests' shares, or a later one), once per browser, both arms alike whether or not a promo
  // shows; a signed-in viewer sends none; arm control (no offer) | offer ($10 free once the account has won $5 in bounty
  // rewards, the first_win_bonus quest).
  // experiment home_spotlight (the home_spotlight test, from 2026-11-17, server/api-types/home-spotlight.ts; desktop
  // only: a phone draws neither banner and sends none): sent at another moment, the home page's Standout slot's banner
  // (under the hero) half in view, in a visible tab, for one continuous second, both arms alike, by two routes. A
  // signed-in account's is sent from src/lib/homeSpotlight.ts sendHomeSpotlightExposure, its own track call, not
  // through exposeOnce, only while GET /api/home/spotlight answers it eligible (both banners could render), once per
  // page view (the server's row, POST /api/home/spotlight/exposure, keeps an account's first exposure alone, one row an
  // account, so GA may hold several per account). A signed-out desktop browser's (its arm rolled by the same GET's
  // browser_percent while it answers shown, kept in the mf_ab_home_spotlight cookie) is sent through exposeOnce
  // (src/lib/homeSpotlight.ts exposeHomeSpotlightBrowser) at the same one second in view, once per browser (the
  // server's row, POST /api/experiments/exposure); a viewer /api/me answers signed in sends none by that route; arm
  // standouts (control: the Standout banner, today's winning games) | market (the most-bet side market's banner,
  // src/components/board/MarketSpotlight.tsx, whose Yes and No open its Odds tab signed in and the sign-in dialog
  // signed out: cta_click's link_area home_market). A forced arm (?ab_home_spotlight=) sends none. Nothing sends it
  // since 2026-11-19, when the slot came off the home page (the owner: "remove this hero row for now, kill the AB").
  // The phone_odds_strip test (from 2026-11-18, server/api-types/odds-strip.ts; signed-in accounts on a phone where side
  // bets show, its arms control, the phone home as it is, and strip, the Odds strip under the hero carousel's dots,
  // cta_click's link_area home_odds_strip) sends experiment phone_odds_strip from src/lib/oddsStrip.ts exposeOddsStrip,
  // its own track call, not through exposeOnce: at another moment, the phone home's front drawing its slot under the
  // hero once GET /api/home/odds-strip has answered the account an arm and at least one hero slide's bounty has a market
  // the strip can show, both arms alike (control draws nothing there and sends it all the same), once per account per
  // page (the server's row, POST /api/home/odds-strip/exposure, one an account, is the count the admin readout reads;
  // GA may hold several per account). A desktop, a signed-out reader and an account outside the test send none.
  // experiment app_install (the app_install test, from APP_INSTALL_SINCE, server/api-types/app-install.ts; a phone
  // browser alone: never desktop, never inside make.fun's iPhone or Android app, never the installed web app) is sent
  // through exposeOnce (src/lib/appInstall.ts exposeAppInstall) at another moment, the same in all three arms: the first
  // time the reader is eligible (the phone layout on an iPhone, or on an Android phone while Google Play lists the app,
  // the test running), no dialog open, the first visit's welcome, tour and quest settled and the page visible for about
  // 4 seconds; once per browser, signed in or out (the server's row, POST /api/experiments/exposure); arm control
  // (nothing drawn) | sheet (a bottom sheet with the store badges, once) | pill (a floating pill above the tab bar with
  // this phone's store button, until closed or tapped). The same moment sets the user property ab_app_install to the
  // browser's arm; a store tap is app_install_click and a close app_install_dismiss.
  // experiment and arm are read from ARM_DIMS_SINCE, the first whole day after GA registered their dimensions.
  experiment_exposure: {
    sender: 'client', key: false, expect: 'sometimes', since: DISCORD_REWARD_SINCE,
    params: { experiment: 'dim', arm: 'dim' },
    paramSince: { experiment: ARM_DIMS_SINCE, arm: ARM_DIMS_SINCE },
    where: 'src/lib/experiments.ts#exposeOnce',
  },
  // A tour's step first reached on this open of the tutorial (src/components/tutorial/TutorialHost.tsx, once per step per
  // open): arm quick_tour | full_tour (the browser's tutorial arm, as experiment_exposure names it; read from
  // ARM_DIMS_SINCE); step how | copy | paste | next, how being the tour shown; step_index its 1-based place, 1 to 4.
  tutorial_step: {
    sender: 'client', key: false, expect: 'sometimes', since: TUTORIAL_SINCE,
    params: { arm: 'dim', step: 'dim', step_index: 'metric' },
    paramSince: { arm: ARM_DIMS_SINCE },
    where: 'src/lib/tutorial.ts#trackTutorialStep',
  },
  // A tour closed: arm quick_tour | full_tour (read from ARM_DIMS_SINCE); outcome finished (Find a bounty) | skipped (Skip,
  // the X, Esc or the backdrop); step and step_index the step it closed at, as tutorial_step's. Join our Discord closes
  // nothing (discord_join).
  tutorial_end: {
    sender: 'client', key: false, expect: 'sometimes', since: TUTORIAL_SINCE,
    params: { arm: 'dim', outcome: 'dim', step: 'dim', step_index: 'metric' },
    paramSince: { arm: ARM_DIMS_SINCE },
    where: 'src/lib/tutorial.ts#trackTutorialEnd',
  },
  // The app install control: the browser's prompt answered, or the app installed. outcome accepted |
  // dismissed | installed | steps_shown (the iOS/Safari steps disclosed) | bar_dismissed (the phone's install
  // bar turned down, src/components/InstallBar.tsx#dismissInstallBar). Not `app_install`: GA reserves it.
  pwa_install: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { outcome: 'dim' },
    where: 'src/lib/install.ts#promptInstall',
  },
  // A store link of the app_install test tapped (from APP_INSTALL_SINCE, server/api-types/app-install.ts; a phone browser
  // alone, never inside make.fun's app): a badge in the sheet arm's bottom sheet or the pill arm's store button, sent as
  // the page leaves for the store, beside the server's own count (POST /api/app-install/click). arm sheet | pill (the
  // browser's app_install arm; control draws no link); store ios (the App Store) | android (Google Play). The install
  // itself happens in the store, out of GA's sight (the stores' own campaign reports read it, by the link's tags:
  // appStoreLinkOf), so it is not a key event. Not `app_install`: GA reserves it.
  app_install_click: {
    sender: 'client', key: false, expect: 'sometimes', since: APP_INSTALL_SINCE,
    params: { arm: 'dim', store: 'dim' },
    where: 'src/lib/appInstall.ts#trackAppInstallClick',
  },
  // The app_install test's ask closed without a store tap (from APP_INSTALL_SINCE): the sheet arm's Not now or any other
  // close of its sheet, or the pill arm's close; the ask never shows again in that browser. arm sheet | pill.
  app_install_dismiss: {
    sender: 'client', key: false, expect: 'sometimes', since: APP_INSTALL_SINCE,
    params: { arm: 'dim' },
    where: 'src/lib/appInstall.ts#trackAppInstallDismiss',
  },
  // The slow-load prompt shown (src/components/SlowLoadPrompt.tsx): a page sat on its skeletons 8 s with the tab in view
  // (src/lib/slowLoad.ts), once per opening (it closes itself as the content lands and may open again on a later stall;
  // closed by the reader, never again that tab's session), so its shows stand beside its two links' cta_click
  // (slow_load_follow_x, slow_load_status). cause slow (Taking longer than usual) | update (the maintenance page answered
  // its reads: a deploy going live), the cause it opened on. Never from an automated browser: the prompt never opens there.
  slow_load_prompt: {
    sender: 'client', key: false, expect: 'sometimes', since: SLOW_LOAD_SINCE,
    params: { cause: 'dim' },
    where: 'src/components/SlowLoadPrompt.tsx#trackSlowLoadShown',
  },
  // A finished entry's storefront put to use: method copy (the command), link (Use this bot), download
  // (Download code) or original (View on GitHub). entry_id is unreported: too fine for a dimension.
  entry_use: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { method: 'dim', competition_slug: 'dim', entry_id: 'unreported' },
    where: 'src/components/archive/Storefront.tsx#UseCopy',
  },
  // A step of a multi-step form reached, once per step per page view: form_id sponsor_proposal (the new
  // proposal page's steps, src/components/sponsor/newProposal.ts NEW_PROPOSAL_STEPS: prompt on its first view,
  // options as they land, adjust at the first edit, fund at the press) | entry (the dialog's kit, build and link
  // steps as each comes into view, sent from src/components/board/SubmissionForm.tsx); step the step's stable name
  // (the plan's forms block lists them in order); step_index its 1-based place. No completion or abandon event:
  // the form's own event is the completion (generate_lead, entry_submit). No step carries what the visitor typed.
  form_step: {
    sender: 'client', key: false, expect: 'sometimes', since: SINCE,
    params: { form_id: 'dim', step: 'dim', step_index: 'metric' },
    where: 'src/components/sponsor/NewProposalPage.tsx#NewProposalPage',
  },
  // A document loaded inside make.fun's app (the iPhone or Android shell around the site, src/lib/shell.ts) as the first of
  // the app's web view: the app was opened (a tap on its icon, a notification's or a link's tap that started it). Sent once a
  // document, from APP_SHELL_SINCE, by the tracker itself (src/lib/ga4.ts trackShellDocument), which tells it from the
  // shell's other document loads by the tab's sessionStorage (SHELL_DOCUMENT_KEY): a web view starts with none, and every
  // later document of the same web view finds the last one's mark. app_platform, app_channel and app_build (GA4_APP_PARAMS,
  // which every event from inside the app carries) are listed here too, so the audit registers and judges them on the app's
  // own events. Never from a browser outside the app.
  shell_launch: {
    sender: 'client', key: false, expect: 'sometimes', since: APP_SHELL_SINCE,
    params: { app_platform: 'dim', app_channel: 'dim', app_build: 'dim' },
    where: 'src/lib/ga4.ts#trackShellDocument',
  },
  // A document the app loaded again after the system ended its web process (iOS reclaims a suspended app's web content
  // process; Android's renderer can go): the shell loads the last route the page reported (the contract's `route`), and
  // this load finds the previous document's mark still `live` or `hidden`, never `left` (a document that unloaded the
  // ordinary way marks itself left on pagehide; one whose process was killed never does). How often the app's page dies
  // under the reader, per platform and build. Sent once a document (src/lib/ga4.ts trackShellDocument); the same params as
  // shell_launch. A web view whose sessionStorage did not survive its process reads as a launch instead.
  shell_revive: {
    sender: 'client', key: false, expect: 'sometimes', since: APP_SHELL_SINCE,
    params: { app_platform: 'dim', app_channel: 'dim', app_build: 'dim' },
    where: 'src/lib/ga4.ts#trackShellDocument',
  },
  // A notification tapped while the app was open: the shell's `open` message (the contract's tap of a warm app), which the
  // page routes in place (src/App.tsx), sent as it arrives (src/lib/ga4.ts trackShellTap), under the page the reader was on.
  // page_type is the page the tap opens (ga4PageOf of its path: one of GA4_PAGE_TYPES). A tap that starts the app cold loads
  // its page as the web view's first document, which reads as shell_launch: the page cannot tell it from an icon's tap, since
  // the push's url carries no mark of its own.
  shell_tap_open: {
    sender: 'client', key: false, expect: 'sometimes', since: APP_SHELL_SINCE,
    params: { page_type: 'dim' },
    where: 'src/lib/ga4.ts#trackShellTap',
  },
  // A wallet app's answer arrived: a page load whose address carries ?wallet-return=<wallet>.<step> (src/lib/walletDeeplink.ts
  // readWalletReturn), in the app or in a browser, sent once that load (src/lib/ga4.ts trackWalletReturn) before the page
  // reads the answer; inside the app also the shell's `wallet.return {path}`, the answer handed to the live page with no
  // document load (the app shell contract v1, Wallet returns). method the wallet app's slug as the return names it (phantom | solflare | backpack, else other: anyone
  // can craft the link; never `wallet`, which reads as an address); step connect | sign | tx | unknown; road the way the
  // answer came back (walletDeeplink.ts ReturnRoad): scheme (makefun://, inside the app alone, APP_RETURN_ROADS) | https (the
  // site's own address); outcome answered (the app sent its answer) | declined (its errorCode 4001: the person said no) |
  // failed (another errorCode) | elsewhere (the return names the browser it started in, &from=, and that is not this one
  // with no flow of its own here: an answer for the app that opened in the phone's browser, walletDeeplink.ts
  // startedElsewhere). Its app_platform tells the app's returns from a browser's.
  wallet_return: {
    sender: 'client', key: false, expect: 'sometimes', since: APP_SHELL_SINCE,
    params: { method: 'dim', step: 'dim', road: 'dim', outcome: 'dim' },
    where: 'src/lib/ga4.ts#trackWalletReturn',
  },
  // The news digest signed up for on a front page: its footer's form (src/news/DigestForm.tsx subscribeToDigest) POSTed
  // /api/news/subscribe and it answered 202, so a link to confirm is on its way to the address typed. The digest is double
  // opt-in: nothing is mailed until that link is opened, which GA never sees, so this is the ask, not a subscriber. The
  // form shows only on a news host that sends a digest (contracts/news-digest.ts newsDigestSenderOf: news.make.fun and the
  // three brand hosts) while the digest is on (MAKEFUN_NEWS_DIGEST: the page's data block carries `digest`). placement
  // footer (the edition footer, src/news/NewsFrontPage.tsx EditionFooter); lang the page's locale, the digest's language (a
  // contracts/news-locales.ts tag, en on the bare URLs). Never the address, the region or the timezone it sent. Sent to
  // make.fun's property alone: the news hosts' own takes page_view and page_exit only. Not a key event: a sign-up still
  // to be confirmed is no conversion.
  news_subscribe: {
    sender: 'client', key: false, expect: 'sometimes', since: NEWS_DIGEST_SINCE,
    params: { placement: 'dim', lang: 'dim' },
    where: 'src/news/DigestForm.tsx#subscribeToDigest',
  },

  // ---------------------------------------------------------------------------------------------- server
  // KEY. An account made (a first sign-in by GitHub, Google, Discord or a Solana wallet): the visitor became a user. method
  // github | google | discord | solana. via (from EXIT_TYPE_SIGNUP_VIA_SINCE) web (a person's sign-in: the OAuth callback, a
  // wallet's siws/verify) | agent (an agent's key mint, POST /api/auth/solana/key, whose verify makes the account: its
  // method reads solana). Sent from the first-session after-hook of Better Auth (server/auth.ts trackSignIn), once per
  // account.
  sign_up: {
    sender: 'server', key: true, expect: 'sometimes', since: SINCE, stitch: 'browser',
    params: { method: 'dim', via: 'dim' },
    paramSince: { via: EXIT_TYPE_SIGNUP_VIA_SINCE },
    where: 'server/auth.ts#databaseHooks',
  },
  // GA's recommended `login`: a session made for an account that exists already (every sign-in that is
  // not the first one). method github | google | discord | solana.
  login: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'browser',
    params: { method: 'dim' },
    where: 'server/auth.ts#databaseHooks',
  },
  // A sign-up that carried a referral code and bound it (bindReferral wrote the referral row, after the session hook's
  // sign_up), sent for the new account: method github | google | discord | solana | key (an agent's key mint, POST /api/auth/solana/key, whose
  // body's `ref` carried the code; its sign_up reads solana). Never the code or the referrer: each names an account. Not a
  // key event: sign_up is the conversion, this says it came by a referral.
  referral_signup: {
    sender: 'server', key: false, expect: 'sometimes', since: REFERRALS_SINCE, stitch: 'request',
    params: { method: 'dim' },
    where: 'server/referrals/attribution.ts#bindReferral',
  },
  // The first-sign-in username step answered: step username (a handle chosen) | skip.
  profile_setup: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { step: 'dim' },
    where: 'server/profile/routes.ts#changeHandle',
  },
  // A wallet linked to the signed-in account (POST /api/auth/siws/link succeeded).
  wallet_link: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'browser',
    params: {},
    where: 'server/auth.ts#LINK_PATH',
  },
  // KEY. A signed-in person approved an agent's connect request (/connect): the agent may now enter as
  // them. The commit act between the sign-up and the entry, and the only step a person takes for an
  // agent that logs in with `makefun login`. scopes the granted scopes sorted and comma-joined
  // (bet,comment,enter,sponsor); merge true when the approval also merges the agent's account.
  agent_connect_approve: {
    sender: 'server', key: true, expect: 'sometimes', since: SINCE, stitch: 'browser',
    params: { scopes: 'dim', merge: 'dim' },
    where: 'server/agents/connect.ts#decideConnect',
  },
  // A signed-in person refused an agent's connect request.
  agent_connect_deny: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'browser',
    params: {},
    where: 'server/agents/connect.ts#decideConnect',
  },
  // The agent redeemed its approved grant (its token poll succeeded, pollToken): its API key is minted, the agent
  // is connected and can enter.
  agent_connect_complete: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'account',
    params: { scopes: 'dim' },
    where: 'server/agents/connect.ts#pollToken',
  },
  // A paired agent disconnected from the account (its keys revoked).
  agent_disconnect: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'browser',
    params: {},
    where: 'server/agents/connect.ts#disconnectWallet',
  },
  // An agent read a document the copied prompt or an answer engine points it at: a non-browser GET (no Sec-Fetch-Dest; never a
  // HEAD; a browser loading the page is a page_view, not this) of /skill.md, /heartbeat.md, /developers or /llms.txt, a revalidation's 304
  // included (server/routes/agent.ts agentDoc and its llms.txt route), of the Agent Skill wrapper /skills/make-fun/SKILL.md (a
  // static file of the built web UI: server/app.ts webUi), of the bounty list those documents send an agent to, GET
  // /api/competitions with any query (?status=open), its JSON or markdown (server/app.ts: the act after the read), or of a
  // guide, /guide/<slug> (server/routes/seo.ts). doc skill | heartbeat | developers | llms | agent-skill | api-competitions |
  // make-money-with-ai-agents | how-ai-agents-earn-money | ai-agent-bounties | post-a-bounty-for-ai-agents
  // (server/accounts/ga-client.ts SKILL_FETCH_PATHS). From the release after 2026-11-20, also a news host's machine files (GA4_NEWS_HOSTS,
  // under any language's prefix: server/news/feeds.ts newsFormatRoutes), a 200 or a 304, by kind: doc news-llms (/llms.txt) |
  // news-llms-full (/llms-full.txt) | news-md | news-txt | news-json (a day's twin, /<YYYY-MM-DD>.md, or the latest's,
  // /latest.md) | news-days (/days.json) | news-feed (/feed.xml, /atom.xml, /feed.json) (ga-client.ts NEWS_SKILL_FETCH_DOCS),
  // its page_location the file read on the host read, so GA's hostName names the host; a reader there is also its host.
  // No cookie, no account: the client_id is the numeric bucket
  // <hash of agent_kind>.<yyyymmdd> (MP takes only digits.digits), so the day's reads of one agent family are one anonymous user.
  // agent_kind is the user agent's family: claude | codex | cursor | gemini | curl | ai_search | crawler | other. `ai_search` is
  // an AI answer engine's fetcher (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User,
  // and xAI's xAI-SearchBot, GrokBot, xAI-Grok, grok-agent, which before 2026-11-09 read as crawler or other:
  // ga-client.ts AI_SEARCH_BOTS; Claude Code's WebFetch also sends Claude-User, but with a claude-code token, and counts as
  // `claude`: it fetches from a developer's machine); `crawler` a search, SEO, social-preview or AI-training crawler by User-Agent (Googlebot,
  // bingbot, GPTBot, ClaudeBot ...). bot, on those two alone (from SKILL_FETCH_BOT_SINCE), is the token that told it: the
  // fetcher's name as its owner writes it, or the crawler's product token, never more than the token (no URL or address rides).
  // verified, on ai_search alone (from AGENT_FETCH_SINCE), says whether the client address is in the list that fetcher's owner
  // publishes (server/accounts/fetcher-ranges.ts FETCHER_RANGE_SOURCES): true | false (the User-Agent's claim is not to be
  // believed) | unknown (no copy of the list held, or no address; always for xAI's four, whose owner publishes no list:
  // fetcher-ranges.ts UNLISTED_FETCHERS). Information only: every read is served and counted alike.
  // handoff_ga and handoff_touch, on doc skill alone (from SKILL_FETCH_HANDOFF_SINCE), say what the read's `?ga=` (the copied
  // prompt's handoff, contracts/acquisition.ts splitHandoff) held: handoff_ga yes when its GA part is a well-formed browser
  // handoff (server/ga4.ts ga4BrowserFromHandoff's shape), handoff_touch yes when its tail is a packed first touch
  // (parseAcquisition reads it), each no otherwise (no `ga`, or that part missing or malformed); a touch with no GA part (a
  // browser with no _ga cookie) is handoff_ga no, handoff_touch yes. Never the value itself, nor a touch the URL's own utm tags
  // carry. The pair is part of the reader, so one reader's read with a handoff is sent beside its bare one that day.
  // Sent once per reader (client IP) per doc per agent family per UTC day (server/accounts/ga-client.ts trackSkillFetch).
  skill_fetch: {
    sender: 'server', key: false, expect: 'always', since: SINCE, stitch: 'anonymous',
    params: { doc: 'dim', agent_kind: 'dim', bot: 'dim', verified: 'dim', handoff_ga: 'dim', handoff_touch: 'dim' },
    when: {
      bot: { agent_kind: ['ai_search', 'crawler'] },
      verified: { agent_kind: ['ai_search'] },
      handoff_ga: { doc: ['skill'] },
      handoff_touch: { doc: ['skill'] },
    },
    paramSince: { bot: SKILL_FETCH_BOT_SINCE, verified: AGENT_FETCH_SINCE, handoff_ga: SKILL_FETCH_HANDOFF_SINCE, handoff_touch: SKILL_FETCH_HANDOFF_SINCE },
    where: 'server/routes/agent.ts#agentDoc',
  },
  // An agent's use of the MCP server: POST /mcp answered 200 or 202 (server/routes/agent.ts) carrying an `initialize` (a client
  // connecting: the server is stateless, so this is the session) or a `tools/call` of a tool the server lists. rpc initialize |
  // tools/call; tool the tool called (on tools/call alone). agent_kind, bot and verified as skill_fetch's, from the User-Agent;
  // where it names no family (`other`: an SDK's bare fetch), the agent family the initialize's clientInfo.name names. mcp_client
  // is that clientInfo.name (the client's own name, claude-code, codex-mcp-client, cursor-vscode ...: letters, digits, spaces and
  // . _ + / - only, at most 64, else unknown), on initialize always, and on a tools/call when the same address and User-Agent
  // initialized that UTC day. No cookie, no account: skill_fetch's anonymous bucket (agent family and day). Sent once per client
  // (client IP, agent family) per rpc and tool per UTC day (server/accounts/ga-client.ts trackMcpRequest).
  mcp_request: {
    sender: 'server', key: false, expect: 'sometimes', since: AGENT_FETCH_SINCE, stitch: 'anonymous',
    params: { rpc: 'dim', tool: 'dim', agent_kind: 'dim', bot: 'dim', mcp_client: 'dim', verified: 'dim' },
    when: {
      tool: { rpc: ['tools/call'] },
      bot: { agent_kind: ['ai_search', 'crawler'] },
      mcp_client: { rpc: ['initialize'] },
      verified: { agent_kind: ['ai_search'] },
    },
    where: 'server/routes/mcp.ts#mcpRequestCounter',
  },
  // KEY. An entry accepted (POST /api/competitions/:slug/submissions answered 202): the agent funnel's
  // commit act, a signed, receipted entry in a competition. via web (a session) | agent (an API key); round
  // is the entry's round number. Never the claim code the 202 carries.
  entry_submit: {
    sender: 'server', key: true, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { competition_slug: 'dim', round: 'dim', via: 'dim', entry_id: 'unreported' },
    where: 'server/routes/submissions.ts#SubmissionCreated',
  },
  // An entry graded (the grader's result was published): result finished | failed | timeout | nondeterministic.
  entry_graded: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'account',
    params: { competition_slug: 'dim', round: 'dim', result: 'dim', entry_id: 'unreported' },
    where: 'server/pipeline/publish.ts#createPublishStage',
  },
  // The entrant won a paid place when the competition resolved (the `won` notification's sweep): prize_place
  // is the placement, value the prize in USD. Not a key event: the prize is not revenue, prize_claim is the act.
  entry_win: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'account',
    params: {
      competition_slug: 'dim', prize_place: 'metric', value: 'builtin', currency: 'builtin',
      entry_id: 'unreported',
    },
    where: 'server/notifications/sweep.ts#sweepResults',
  },
  // The winner's claim form accepted (POST /api/submissions/:id/claim, applyClaim): a payout is queued.
  prize_claim_apply: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { competition_slug: 'dim', via: 'dim', entry_id: 'unreported' },
    where: 'server/routes/community.ts#applyClaim',
  },
  // KEY. A prize claimed on chain (POST /api/claims/:id/submit confirmed): the winner is paid, the last
  // step of the agent funnel and the only point where money reaches an entrant. value is the USDC paid in
  // USD (amount_base_units / 1e6), result full | partial.
  prize_claim: {
    sender: 'server', key: true, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: {
      competition_slug: 'dim', value: 'builtin', currency: 'builtin', result: 'dim', via: 'dim',
      claim_id: 'unreported',
    },
    where: 'server/routes/claims.ts#ClaimSubmitResponse',
  },
  // A referrer's claim of its approved referral rewards filed (POST /api/me/referrals/claim, the MCP tool
  // claim_referral_rewards through it), after its inline send: value the claim's USDC in USD (amount_base_units / 1e6),
  // result paid | sending | held (an admin's Pay decides it), via web | agent. A refused claim (400, 409, 451) sends nothing.
  // Not a key event: a referral reward is what the program costs, not a conversion.
  referral_claim: {
    sender: 'server', key: false, expect: 'sometimes', since: REFERRALS_SINCE, stitch: 'request',
    params: { value: 'builtin', currency: 'builtin', result: 'dim', via: 'dim' },
    where: 'server/referrals/claim.ts#claimReferralRewardsOf',
  },
  // A sponsor proposal draft made (POST /api/sponsor/proposals answered 201). via web | agent.
  proposal_start: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { via: 'dim', proposal_id: 'unreported' },
    where: 'server/routes/sponsor.ts#renderProposal',
  },
  // A sponsor asked the team to set the proposal up from a brief (custom bounty request).
  proposal_setup_request: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { proposal_id: 'unreported' },
    where: 'server/routes/sponsor.ts#PROPOSAL_SETUP_REQUEST_ACTION',
  },
  // KEY. GA's recommended `generate_lead`: a sponsor proposal submitted for review, its pot deposited on
  // chain and in the proposal's vault until the team decides (proposal.submit, server/routes/sponsor/store.ts
  // PROPOSAL_SUBMIT_ACTION). The sponsor funnel's commit act. lead_type sponsor_proposal; value the pot in USD.
  generate_lead: {
    sender: 'server', key: true, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { lead_type: 'dim', value: 'builtin', currency: 'builtin', proposal_id: 'unreported' },
    where: 'server/routes/sponsor.ts#PROPOSAL_SUBMIT_ACTION',
  },
  // A sponsor withdrew a deposited proposal (pot returned).
  proposal_withdraw: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { proposal_id: 'unreported' },
    where: 'server/routes/sponsor.ts#PROPOSAL_WITHDRAW_ACTION',
  },
  // The team rejected a submitted proposal (pot returned): sent for the sponsor's account, by the admin's action.
  proposal_reject: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'account',
    params: { proposal_id: 'unreported' },
    where: 'server/routes/admin/proposals.ts#recordRejected',
  },
  // KEY. GA's recommended `purchase`: the prize funded. The team approved the sponsor's proposal, the pot
  // moved into the prize escrow and the competition listed (recordApproved, the one place every approval
  // path ends): the sponsor's money is committed. transaction_id the proposal id (one purchase per
  // proposal), value the pot in USD. Sent for the sponsor's account, not the approving admin's.
  purchase: {
    sender: 'server', key: true, expect: 'sometimes', since: SINCE, stitch: 'account',
    params: { transaction_id: 'builtin', value: 'builtin', currency: 'builtin', competition_slug: 'dim' },
    where: 'server/routes/admin/proposals.ts#recordApproved',
  },
  // KEY. A side-bet trade landed: the on-chain market's POST /api/competitions/:slug/market/trades/submit confirmed (a
  // USDC trade on the side_market program), the one act a spectator commits money to on a competition, so the spectator
  // funnel's conversion. side yes | no, action buy | sell, via web | api | mcp (the submit route's caller: a session, an
  // API key's REST call, an MCP tool; the trades only the indexer sees, direct, house and quoter, send nothing),
  // first_trade true on the wallet's first trade on that market (its ticket opened with it), sent by the submit handler
  // once the trade is confirmed and recorded (server/routes/market.ts submitTrade).
  market_trade: {
    sender: 'server', key: true, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { competition_slug: 'dim', side: 'dim', action: 'dim', via: 'dim', first_trade: 'dim' },
    paramSince: { action: SIDE_MARKET_SINCE },
    where: 'server/routes/market.ts#submitTrade',
  },
  // A side-bet position closed: a confirmed sell (POST .../market/trades/submit) that left the wallet no shares on that
  // outcome (the web's Close, an MCP prepare_bet with close: true, or any sell of the whole position), sent beside that
  // sell's market_trade. side yes | no, the side closed; via web | api | mcp. Not a key event: market_trade is the act.
  // The submit handler sends it (server/routes/market.ts submitTrade).
  market_close_position: {
    sender: 'server', key: false, expect: 'sometimes', since: SIDE_MARKET_SINCE, stitch: 'request',
    params: { competition_slug: 'dim', side: 'dim', via: 'dim' },
    where: 'server/routes/market.ts#submitTrade',
  },
  // A payout delegation registered (POST /api/agents/me/delegations): the owner's wallet is now the payout
  // pin. result created (201) | repinned (200).
  delegation_register: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { result: 'dim' },
    where: 'server/routes/delegations.ts#DelegationResponse',
  },
  // Two accounts merged (an approved merge, POST /api/account/merges/approve).
  account_merge: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'browser',
    params: {},
    where: 'server/routes/account-merge.ts#afterMerge',
  },
  // A comment posted on a competition (POST /api/competitions/:slug/comments answered 201), held for
  // moderation or not. is_reply true for a reply.
  comment_post: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { competition_slug: 'dim', via: 'dim', is_reply: 'dim' },
    where: 'server/routes/community/comments.ts#answerRefusals',
  },
  // A contact channel verified with its 6-digit code (POST /api/me/contact/:channel/confirm). channel
  // email | phone; never the address.
  contact_verify: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { channel: 'dim' },
    where: 'server/contact/store.ts#confirmCode',
  },
  // A browser subscribed to Web Push, or an app shell's device registered with its alerts allowed (POST
  // /api/notifications/push, a new row): notifications opted in. kind (from APP_SHELL_SINCE) web (a browser's Web Push) |
  // apns (the iPhone app's device) | fcm (the Android app's device); a device row is sent for once, when its row is made with
  // authorization authorized (one registered denied or undetermined is no opt-in, and its later re-registration updates the
  // row, sending none).
  push_subscribe: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'browser',
    params: { kind: 'dim' },
    paramSince: { kind: APP_SHELL_SINCE },
    where: 'server/routes/notifications.ts#PushBody',
  },
  // An entrant's masq build key issued for a metered competition (POST /api/competitions/:slug/build-key
  // answered 201). rotate true when it replaced an active key.
  build_key_issue: {
    sender: 'server', key: false, expect: 'sometimes', since: SINCE, stitch: 'request',
    params: { competition_slug: 'dim', rotate: 'dim' },
    where: 'server/routes/competitions/build-key.ts#issueBuildKey',
  },
} as const satisfies Record<string, Ga4EventSpec>;

export type Ga4EventName = keyof typeof GA4_EVENTS;

type ParamsOf<E extends Ga4EventName> = (typeof GA4_EVENTS)[E]['params'];
type ParamValue<Name extends string, Kind> = Kind extends 'metric' ? number : Name extends 'value' ? number : string;

/**
 * The parameters an event may carry, each typed by its kind: a number for a metric and for `value`, else a string; and the
 * app dimensions (GA4_APP_PARAMS), which any event from inside the app carries.
 */
export type Ga4Params<E extends Ga4EventName> = {
  -readonly [P in keyof ParamsOf<E> & string]?: ParamValue<P, ParamsOf<E>[P]>;
} & Ga4AppParams;

/** Every event name, in the order above. */
export const GA4_EVENT_NAMES = Object.keys(GA4_EVENTS) as Ga4EventName[];

/** The key events, derived from GA4_EVENTS's `key`. */
export const GA4_KEY_EVENTS: readonly Ga4EventName[] = GA4_EVENT_NAMES.filter((name) => GA4_EVENTS[name].key);

/** The events a server sends over the Measurement Protocol (sender server or both). */
export const GA4_SERVER_EVENTS: readonly Ga4EventName[] = GA4_EVENT_NAMES.filter((name) => GA4_EVENTS[name].sender !== 'client');

export const isGa4EventName = (name: string): name is Ga4EventName => Object.hasOwn(GA4_EVENTS, name);

/**
 * User-scoped dimensions (customUser:<name>), set by gtag's `user_properties` and so on every later event of
 * the user. A value is at most 36 characters.
 *   acq_source, acq_medium, acq_campaign, acq_content   the latest non-direct landing's utm_source,
 *       utm_medium, utm_campaign and utm_content, or an external referrer's host (medium referral, campaign
 *       (referral)): taken from a landing that has one and kept in localStorage (makefun:acq:v1), so a
 *       later direct landing restores them and GA Realtime can show a fresh ad visitor
 *   signed_in   'true' | 'false'
 *   theme       the resolved color mode: light | dark | night
 *   ab_app_install   the browser's app_install arm (server/api-types/app-install.ts): control | sheet | pill, set at its
 *       exposure (control's too) and on every later load of a browser holding one, so every later event of a phone
 *       browser in the test reads its arm (sessions, engagement and conversions by arm); a browser outside the test
 *       sets none
 */
export const GA4_USER_PROPERTIES = {
  acq_source: { since: SINCE, where: 'src/main.tsx#startInstall' },
  acq_medium: { since: SINCE, where: 'src/main.tsx#startInstall' },
  acq_campaign: { since: SINCE, where: 'src/main.tsx#startInstall' },
  acq_content: { since: SINCE, where: 'src/main.tsx#startInstall' },
  signed_in: { since: SINCE, where: 'src/lib/useApi.ts#useMe' },
  theme: { since: SINCE, where: 'src/main.tsx#subscribeTheme' },
  ab_app_install: { since: APP_INSTALL_SINCE, where: 'src/lib/appInstall.ts#exposeAppInstall' },
} as const satisfies Record<string, { readonly since: string; readonly where: string }>;

export type Ga4UserProperty = keyof typeof GA4_USER_PROPERTIES;

/**
 * The primary CTAs: the buttons and links that start an entry (data-track=<id>, so cta_click's cta_id is
 * the id and not the button's text). The ids are the AgentEntryBar's testIds with `-` as `_`: its home-hero
 * band (hero-agent-copy, its Copy for your agent; hero-agent-kit, the Download starter kit in that split's chevron
 * menu, whose agent guide and brief links carry none; hero-submit, its Submit an entry), the bounty page's door
 * (bounty-agent-copy, bounty-agent-kit, bounty-submit-cta), the new proposal page's (sponsor-prompt-copy) and a guide's Quick start's
 * (guide-agent-copy), plus two ids that are a data-track and no bar's testId: home_earn_agent_copy,
 * the copy icon of the home Ways to earn band's prompt chip (src/components/board/HomeEarnBand.tsx), and sponsor_start, the
 * link that starts a bounty proposal: the header's Create a bounty and the sponsor list's Start one. One action is one id
 * wherever it appears: the bounty page's action dock (Copy for your agent, bounty_agent_copy, its chevron menu
 * holding the kits, bounty_agent_kit, and 'Kit, phases and digest'; a listing that takes no entries keeps Download
 * kit, bounty_agent_kit, in its place; then Submit an entry, bounty_submit_cta) and the entry dialog's Download kit
 * (bounty_agent_kit) reuse the bar's ids, and so does every other link that opens a bounty's
 * entry form (a board card's Submit, the live entries' empty-state Submit an entry, the next-step bar's submit and
 * resubmit, a profile entry's Fix and resubmit, the standings' two Submit links: tests/unit/web-ga4-sites.test.ts
 * finds them in src/ and fails one without it), as does every kit download on the bounty page's body. link_area, the
 * nearest data-track-area, tells the placements apart: bounty_dock | entry_steps | bounty_card | live_entries |
 * next_step | profile_entries | leaderboard | bounty_kits | bounty_page | header | sponsor_list | quick_tour | full_tour (the tutorial's two tours,
 * src/components/tutorial/, whose Copy prompt and prompt copy icon carry home_earn_agent_copy: the same prompt copied is
 * one action), and live_band, the
 * board's live band, whose cards hold no primary CTA (its title links' cta_click). beta_welcome, the beta
 * welcome dialog, holds none either: its Join our Discord is beta_welcome_discord, its Let's make some fun and X
 * beta_welcome_close; nor does quest_offer, the Discord quest (its quest_* ids, cta_click); nor first_win_bonus, the
 * first-win bonus band (src/components/quests/FirstWinBand.tsx): the band holds no primary CTA, its Sign up, Find a
 * bounty, Claim $10 and X being first_win_sign_up, first_win_find_bounty, first_win_claim and first_win_dismiss
 * (cta_click). A tour's other controls carry
 * no primary CTA either: tutorial_skip, tutorial_close, tutorial_next, tutorial_pasted, tutorial_back,
 * tutorial_find_bounty, tutorial_discord, tutorial_trustpilot and tutorial_app_claude_code | tutorial_app_codex |
 * tutorial_app_cursor (cta_click). `handoff_events` are the events that follow a
 * primary click with the thing itself done.
 */
export const GA4_PRIMARY_CTA = {
  ids: [
    'hero_agent_copy', 'hero_agent_kit', 'hero_submit',
    'bounty_agent_copy', 'bounty_agent_kit', 'bounty_submit_cta',
    'sponsor_prompt_copy', 'sponsor_start',
    'guide_agent_copy', 'home_earn_agent_copy',
  ],
  handoff_events: ['agent_prompt_copy'],
} as const;

/**
 * page_view's page_type values: the route names of src/routes/match.ts (matchRoute, sponsorRouteOf's
 * sponsor and proposal, and signInErrorOf's sign-in-error) that are tracked. The admin desk and the styleguide are staff's and send nothing, and
 * neither do an email's unsubscribe page and an account deletion's confirm page, whose paths carry their tokens
 * (GA4_UNTRACKED_PAGE_TYPES). `other`
 * is a path the app does not know (its 404).
 */
export const GA4_PAGE_TYPES = [
  'board', 'bounty', 'leaderboard', 'archive', 'tree', 'profile', 'rankings', 'how-it-works', 'press',
  'coin', 'terms', 'privacy', 'delegate', 'notifications', 'connect', 'agents', 'sponsor', 'proposal', 'other',
  // The invite landing, /r/<code>: the board under who invited you.
  'referral',
  // A guide, /guide/<slug> (src/components/help/Guide.tsx): no competition_slug (its route names the guide `guide`, not
  // `slug`, so ga4PageOf reads none); which guide is page_location's path.
  'guide',
  // Your Discord link and rank roles, /discord (src/components/discord/DiscordPage.tsx): signed-in and unlisted like
  // notifications and connect, and tracked like them; its ?linked, ?error and ?from are not in GA4_PAGE_LOCATION_ALLOW,
  // so page_location drops them.
  'discord',
  // What make.fun is and who runs it, /about (src/components/help/About.tsx): public, a reader's page like how-it-works.
  'about',
  // Every reward paid, /payouts (src/components/payouts/): public, the same for everyone, like rankings; its ?cursor is
  // not in GA4_PAGE_LOCATION_ALLOW, so page_location drops it.
  'payouts',
  // A failed sign-in's landing, the home page's address under ?sign-in=failed (src/routes/match.ts signInErrorOf): where
  // the server sends a provider's redirect it refused, and the app draws one sentence and Try again in the board's
  // place (src/components/auth/SignInError.tsx). Never `board`: the reader did not see the board. Its ?sign-in,
  // ?provider and ?error are not in GA4_PAGE_LOCATION_ALLOW, so page_location drops them and reads as the home page's:
  // page_type alone tells the two apart.
  'sign-in-error',
  // Your bets, /bets (src/components/market/BetsPage.tsx; src/routes/match.ts betsRouteOf): signed-in and unlisted like
  // notifications, connect and discord, and tracked like them; no competition_slug. Only where the server shows side
  // bets: elsewhere the path draws the not-found page and reads `other`.
  'bets',
  // The odds page, /odds (src/components/market/OddsPage.tsx; src/routes/match.ts oddsRouteOf): every market in one
  // place, signed-in and unlisted like bets, and tracked like it; no competition_slug (the market it features, ?market=,
  // is not in GA4_PAGE_LOCATION_ALLOW, so page_location drops it). Only where the server shows side bets, as bets.
  'odds',
  // Every contest winner on record, /records (src/components/records/RecordsPage.tsx; src/routes/match.ts RECORDS_PATH):
  // public and the same for everyone, like payouts; no competition_slug. A record's own address is this page with the
  // contest's slug as its fragment, which page_location drops.
  'records',
  // The research page, /research/coding-agent-harnesses (src/routes/match.ts STUDY_PATH): public and the same for
  // everyone, like records; no competition_slug. A page only while the server serves it: off, the app draws its
  // not-found page there, and the address still reads `study` (as a hidden /coin reads `coin`).
  'study',
  // Your privacy choices, /privacy-choices (src/components/legal/ChoicesPage.tsx; src/routes/match.ts
  // PRIVACY_CHOICES_PATH): public like terms and privacy, and tracked like them; no competition_slug. Which choices the
  // reader makes is never sent: the page's switches carry no data-track, and its path holds no secret.
  'privacy-choices',
  // A public work desk campaign, /desk/<campaign> (src/components/desk/DeskPage.tsx), and a contributor's credited units
  // in one, /desk/<campaign>/contributors/<handle> (src/components/desk/ContributorPage.tsx): public and the same for
  // everyone, like records; no competition_slug (their routes name the campaign `campaign`, not `slug`). Which campaign is
  // page_location's path; the contributor's handle is not (GA4_PAGE_LOCATION_PATH_PATTERNS reads it /:handle).
  'desk',
  'desk-contributor',
] as const;
export const GA4_UNTRACKED_PAGE_TYPES = ['admin', 'admin-competition', 'admin-entry', 'admin-explore', 'styleguide', 'unsubscribe', 'account-delete'] as const;

/**
 * page_view's page_type on a news host (GA4_NEWS_HOSTS), where the page is the news site's (src/news/NewsApp.tsx), never one
 * of make.fun's routes: its front page would otherwise read `board` and a day `other`, inside make.fun's rows of every report
 * not cut by hostname. Under any language's prefix alike ('/es/', '/es/2026-11-18', '/es/2026-11-18/<slug>'); every one
 * tracked, none with a competition_slug (src/lib/ga4.ts ga4NewsPageOf):
 *   news-front    '/', the latest day's front page
 *   news-day      '/<YYYY-MM-DD>', that day's front page
 *   news-story    '/<YYYY-MM-DD>/<slug>', a story's own page (its day's front page with the story's dialog open); the
 *                 type alone, never the slug
 *   news-search   '/search'
 *   news-about    '/about', the host's about page
 *   news-other    any other path (its not-found page), as `other` is make.fun's
 * Not GA4_PAGE_TYPES, which are src/routes/match.ts's route names (src/news/api.ts newsRouteOf names these pages).
 */
export const GA4_NEWS_PAGE_TYPES = ['news-front', 'news-day', 'news-story', 'news-search', 'news-about', 'news-other'] as const;

/**
 * Ad click ids, and the network each marks: a landing carrying one is that network's paid click (source the network,
 * medium cpc or paid_social), read by the key's presence alone. Each is kept in page_location but those
 * GA4_CLICK_IDS_WITHHELD names. bfcid is Freebuff's, appended by Freebuff to its ads' destination URLs (a bare
 * one reads freebuff / paid_social, the default; the ads' own utm_medium is paid).
 */
export const GA4_CLICK_IDS = {
  gclid: 'google',
  gbraid: 'google',
  wbraid: 'google',
  msclkid: 'microsoft',
  fbclid: 'meta',
  twclid: 'x',
  ttclid: 'tiktok',
  li_fat_id: 'linkedin',
  rdt_cid: 'reddit',
  bfcid: 'freebuff',
} as const;

/**
 * Click ids whose value never leaves for analytics: still read for their network (by presence), never kept in a
 * page_location, page_referrer or link_url. Freebuff's bfcid (a ~600-character token): Freebuff forbids sending it to GA.
 */
export const GA4_CLICK_IDS_WITHHELD = ['bfcid'] as const satisfies readonly (keyof typeof GA4_CLICK_IDS)[];

/** The campaign tags a landing keeps in page_location. */
export const GA4_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'] as const;

/**
 * The query keys a page_location may carry: the campaign tags, the ad click ids but those withheld
 * (GA4_CLICK_IDS_WITHHELD), and the keys the app's own routes read (?tab= the profile and board tabs, ?sort= the
 * board's order, ?order= the rankings', ?view= the leaderboard's, ?examples= the board's examples switch). Every other
 * key is dropped, as is the fragment.
 */
export const GA4_PAGE_LOCATION_ALLOW: readonly string[] = [
  ...GA4_UTM_KEYS,
  ...Object.keys(GA4_CLICK_IDS).filter((key) => !(GA4_CLICK_IDS_WITHHELD as readonly string[]).includes(key)),
  'tab', 'sort', 'order', 'view', 'examples',
];

/**
 * Keys that are never allowed in, each a secret, a visitor's own text or a value withheld from analytics: the agent
 * connect page's ?code= (a device user code that approves an agent), the delegation page's ?message= (a payout
 * delegation to sign), the board's ?q= (what the visitor typed), ?claim= and ?merge= (ids of a claim and a merge), and
 * the click ids GA4_CLICK_IDS_WITHHELD names (Freebuff's bfcid), and OpenAI Ads' ?oppref= (a ChatGPT ad click's opaque
 * attribution id, kept by the server under a ref for OpenAI's Conversions API alone: server/accounts/openai-click.ts).
 * oppref is no GA4_CLICK_IDS key: a ChatGPT ad's landing names its network by its own utm tags, and a click id there
 * would also make the landing an ad landing for the page (src/lib/adLanding.ts), which this leaves as it is.
 */
export const GA4_PAGE_LOCATION_DENY = ['code', 'message', 'q', 'claim', 'merge', ...GA4_CLICK_IDS_WITHHELD, 'oppref'] as const;

/**
 * Google Analytics as analytics alone, inside make.fun's iPhone app (contracts/acquisition.ts IOS_APP_USER_AGENT_RE,
 * src/lib/ga4.ts reads it as shell.ts's platform `ios`), where no ad measurement runs. Ahead of the tag's start, before
 * gtag.js reads its queue:
 *   consent  gtag('consent', 'default', ...): advertising storage, user data and personalisation denied, analytics
 *            storage granted (Google tag API reference, "consent", retrieved 2026-11-22)
 *   set      gtag('set', ...): allow_google_signals false (no Google signals, no join beacons) and
 *            allow_ad_personalization_signals false (npa=1 on every beacon), set globally so the news property gets them
 *            too (developers.google.com/tag-platform/security/guides/privacy, retrieved 2026-11-22)
 * and every page_location, page_referrer and link_url drops each ad click id's value (ga4PageLocation's
 * withholdClickIds); the click id still names the landing's network by its presence (acq_*). A browser and the Android
 * apps send none of it: their gtag calls are what they were.
 */
export const GA4_ANALYTICS_ONLY = {
  consent: { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted' },
  set: { allow_google_signals: false, allow_ad_personalization_signals: false },
} as const;

/**
 * A path prefix whose remainder is a person or a secret and is replaced whole: a profile's /u/<handle> reads
 * /u/:handle, an invite link's /r/<code> (the code names the account it credits) reads /r/:code, and an email's
 * unsubscribe link /email/unsubscribe/<token> (src/routes/match.ts UNSUBSCRIBE_PATH) reads
 * /email/unsubscribe/:token, and an account deletion's confirm link /email/delete-account/<token> (ACCOUNT_DELETE_PATH)
 * reads /email/delete-account/:token, so none reaches GA as a page_referrer or the error beacon's page either.
 */
export const GA4_PAGE_LOCATION_PATH_REWRITES = [
  { prefix: '/u/', to: '/u/:handle' },
  { prefix: '/r/', to: '/r/:code' },
  { prefix: '/email/unsubscribe/', to: '/email/unsubscribe/:token' },
  { prefix: '/email/delete-account/', to: '/email/delete-account/:token' },
] as const;

/**
 * A path whose person sits in its middle, where no prefix reaches: each `pattern` (a regular expression's source, matched
 * against the whole path) is replaced by its `to` ($1 the part kept). A work desk contributor's page,
 * /desk/<campaign>/contributors/<handle> (an optional trailing slash), reads /desk/<campaign>/contributors/:handle: the
 * campaign stays, the handle goes, so none reaches GA as a page_location, a page_referrer or the error beacon's page.
 * Applied after GA4_PAGE_LOCATION_PATH_REWRITES.
 */
export const GA4_PAGE_LOCATION_PATH_PATTERNS = [
  { pattern: '^/desk/([^/]+)/contributors/[^/]+/?$', to: '/desk/$1/contributors/:handle' },
] as const;

const PATH_PATTERNS: readonly { re: RegExp; to: string }[] = GA4_PAGE_LOCATION_PATH_PATTERNS.map((p) => ({ re: new RegExp(p.pattern), to: p.to }));

/**
 * The page_location to send for a page: its origin and path (a profile's handle, a desk contributor's or a token replaced), and only the
 * query keys GA4_PAGE_LOCATION_ALLOW names; the fragment dropped. The client's page_location and the
 * server's both come from here, so a /connect?code= or a /delegate?message= never leaves the browser or the
 * server. With `withholdClickIds` (inside make.fun's iPhone app: GA4_ANALYTICS_ONLY) every ad click id is dropped too,
 * as GA4_CLICK_IDS_WITHHELD's are everywhere. '' for a string that is not an absolute URL.
 */
export function ga4PageLocation(href: string, opts: { readonly withholdClickIds?: boolean } = {}): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return '';
  }
  let path = url.pathname;
  for (const rewrite of GA4_PAGE_LOCATION_PATH_REWRITES) if (path.startsWith(rewrite.prefix)) path = rewrite.to;
  for (const p of PATH_PATTERNS) path = path.replace(p.re, p.to);
  const kept = new URLSearchParams();
  const allowed = (key: string): boolean => GA4_PAGE_LOCATION_ALLOW.includes(key) && !(opts.withholdClickIds === true && Object.hasOwn(GA4_CLICK_IDS, key));
  for (const [key, value] of url.searchParams) if (allowed(key)) kept.append(key, value);
  const query = kept.toString();
  return `${url.origin}${path}${query === '' ? '' : `?${query}`}`;
}
