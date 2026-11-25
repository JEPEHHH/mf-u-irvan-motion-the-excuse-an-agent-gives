// The scrape/v1 harness's records (contracts/competition.ts ScrapeHarness): what a scrape entry is
// graded from. A heat runs every entry, the house baseline among them, once per round in an order
// drawn from a public drand round. Each trial runs in a fresh container whose only way out is the
// house's recording TLS gateway (grader/scrape/gateway.ts), the house launcher times it from spawn to
// exit (grader/scrape/launch.ts), and the bundle's sealed scorer checks its output against the
// trial's own cassette: what the upstream served this entry in this trial.
//
//   network          ScrapeNetwork, the harness block's: the hosts the gateway answers, the routes it
//                    forwards, the caps it holds a trial to, and when it opens its upstream sessions
//   heat             ScrapeHeatConfig, the harness block's: the timed and warm-up rounds, the trim,
//                    the per-trial cap, the cooldown between trials, the playoff, and, when named, its
//                    contenders cut (StagedHeat, which a program/v1 timing heat names too)
//   cassette         agent-fun/scrape-cassette/v1 (ScrapeCassette): one trial's traffic, as the
//                    gateway writes it (grader/scrape/gateway.ts ScrapeCassette, the same names).
//                    Every request it took is an entry, in arrival order: when, on which connection,
//                    the route it matched (or null), its method, authority and path, how it ended
//                    (outcome) and why (reason), the status sent back, the upstream's rate-limit and
//                    content headers, its content-encoding, and the decoded body's sha256 and size
//                    (the body itself sits in the blob store, named by that sha256). Every
//                    connection is listed too, in accept order. The totals add the lists up
//   heat record      agent-fun/scrape-heat/v1 (ScrapeHeat): the heat's id, the drand round it drew
//                    on (with its signature's digest), the seed, every entrant, each round's order,
//                    the playoff's entrants, the upstream addresses the heat resolved, and the digest
//                    of its reference read's cassette (the house's own read at heat start, what the
//                    scorer judged every trial of the heat against)
//   trials manifest  agent-fun/scrape-trials/v1 (ScrapeTrials): one entry's run, its action log (the
//                    document run.action_log_sha256 names). Per timed round, main stage then
//                    playoff: the round, its place in the round's order, how it ended, the
//                    launcher's wall time and exit code, the outputs (what the scorer reads at
//                    /output), and the digests of the cassette and the scorer's scores.json. A void
//                    a heat meets (an infrastructure fault: an upstream 429 or 5xx, a gateway or
//                    launcher death; or a trial judged void, a chart the upstream served short) is
//                    never listed: it re-runs, and voids_rerun counts it. A trial judged void at an
//                    admin's re-judging (grader/regrade.ts rejudgeScrapeRun: incorrect against the
//                    heat's reference read, correct judged again against its own cassette), which no
//                    trial can run again, is listed under its round with status void
//                    (SCRAPE_VOID_STATUS), both judgings' scores.json named (scores_sha256, then
//                    own_scores_sha256): every round still lists one trial, and the void counts for
//                    nothing (below)
//   performance      ScrapePerformance (contracts/score.ts Performance's scrape/v1 branch): per trial
//                    its round, stage, status and wall time, a listed void among them; the rank key
//                    and its neighbours (scores); the Yuen 90% interval of the trimmed mean; the counts
//
// Canonical JSON (sim/canonical.ts), integers only: every number in these records is an integer
// (a count, bytes, microseconds, nanoseconds). A time in milliseconds is a decimal string with exactly
// three fraction digits (ScrapeMillis, "190.123"): a whole number of microseconds.
//
// The rank key (scrapeTimeUs, the one rule the performance is held to): of a run's K trials that count
// (every listed trial but a void: scrapeCountedTrials), take the correct ones' wall_us and one
// +infinity per other trial, drop the `trim` fastest and the `trim` slowest, and average the
// K - 2 x trim left, half-even to the microsecond. More than `trim` trials that are not correct leave
// the run unranked: time_ms null. A finalist's K counts its main and playoff trials alike. A listed
// void is left out of every time (the rank key, the median, the best, the interval), every count, and
// the trim (the harness's rule, trim under a third of the main trials, holds over those that count),
// so a run is scored on its other rounds as if its void ones never ran; one whose voids leave fewer
// main trials to count than scrapeFewestCountedMain has no performance.
//
// The identities a record must satisfy are refinements that run only on a value whose shape already
// parsed (whenValid). zod only, no Node APIs: browser-safe, as every contract.

import { z } from 'zod';
import { TrialOutputs } from './agent.ts';
import { Fixed9, Sha256Hex } from './primitives.ts';

export const SCRAPE_HARNESS_KIND = 'scrape/v1';

type Issue = (path: (string | number)[], message: string) => void;

const issuer =
  (ctx: { addIssue: (i: { code: 'custom'; path: (string | number)[]; message: string }) => void }): Issue =>
  (path, message) =>
    ctx.addIssue({ code: 'custom', path, message });

/** Run a refinement only on a value whose shape already parsed. */
const whenValid = { when: (payload: { issues: readonly unknown[] }): boolean => payload.issues.length === 0 };

/** Whether a list holds no value twice; the first repeat's index, or -1. */
function firstRepeat<T>(xs: readonly T[], key: (x: T) => string = String): number {
  const seen = new Set<string>();
  for (let i = 0; i < xs.length; i++) {
    const k = key(xs[i]!);
    if (seen.has(k)) return i;
    seen.add(k);
  }
  return -1;
}

/** Object keys in code-unit order, recursively, as canonical JSON writes them: equal maps spell equal. */
function sortedJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`)
    .join(',')}}`;
}

// ---------------------------------------------------------------- times

/** A time in milliseconds at whole microseconds, not below 0: e.g. "190.123". */
export const ScrapeMillis = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{3}$/, 'expected milliseconds with exactly three fraction digits, e.g. "190.123"');

/** ScrapeMillis that may be below 0 (an interval's low end), never "-0.000". */
export const ScrapeSignedMillis = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)\.[0-9]{3}$/, 'expected milliseconds with exactly three fraction digits, e.g. "190.123" or "-4.500"')
  .refine((s) => s !== '-0.000', 'negative zero');

/** Microseconds as ScrapeMillis text (a negative count signed): 190123n -> "190.123". */
export function formatScrapeMillis(us: bigint): string {
  const neg = us < 0n;
  const abs = neg ? -us : us;
  return `${neg ? '-' : ''}${abs / 1000n}.${(abs % 1000n).toString().padStart(3, '0')}`;
}

/** ScrapeMillis (or ScrapeSignedMillis) text back to microseconds. Throws RangeError on anything else. */
export function parseScrapeMillis(s: string): bigint {
  if (!ScrapeSignedMillis.safeParse(s).success) throw new RangeError(`${JSON.stringify(s)} is not milliseconds with three fraction digits`);
  const neg = s.startsWith('-');
  const [whole, frac] = (neg ? s.slice(1) : s).split('.') as [string, string];
  const us = BigInt(whole) * 1000n + BigInt(frac);
  return neg ? -us : us;
}

/** num / den rounded half to even; num >= 0, den > 0. */
export function divHalfEven(num: bigint, den: bigint): bigint {
  if (num < 0n || den <= 0n) throw new RangeError('divHalfEven takes num >= 0 and den > 0');
  const q = num / den;
  const twice = (num % den) * 2n;
  if (twice > den || (twice === den && q % 2n === 1n)) return q + 1n;
  return q;
}

/** The launcher's wall_ns as the performance's wall_us: half-even to the microsecond. */
export function scrapeWallUs(wallNs: number): number {
  return Number(divHalfEven(BigInt(wallNs), 1000n));
}

// ---------------------------------------------------------------- network (the harness block's)

/**
 * An exact lowercase DNS name: 2..127 dot-separated labels of a-z 0-9 and inner hyphens, each 1..63
 * characters, at most 253 in all, the last not all digits (a resolver would read it as an IPv4
 * literal). No wildcard, no trailing dot, no port. grader/scrape/ca.ts isHostName, the same rule.
 */
export function isScrapeHostName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  const labels = name.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1]!);
}

export const ScrapeHostName = z.string().refine(isScrapeHostName, 'expected an exact lowercase DNS name, e.g. apis.roblox.com: no wildcard, port or trailing dot');

/** A route's id: a lowercase letter, then up to 31 of a-z 0-9 _ - (the gateway's ROUTE_ID). */
export const ScrapeRouteId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'expected a route id: a lowercase letter, then up to 31 of a-z 0-9 _ -');

/** A route's path: origin-form, a '/' then printable ASCII, no '?' or '#', at most 2048 characters. */
export const ScrapeRoutePath = z
  .string()
  .max(2048)
  .regex(/^\/[\x21-\x7e]*$/, "expected an origin-form path: a '/' then printable ASCII")
  .refine((p) => !p.includes('?') && !p.includes('#'), "a route's path carries no query or fragment: its required query is `query`");

/** The most required query keys one route may name. */
export const SCRAPE_MAX_ROUTE_QUERY_KEYS = 16;

/**
 * One request the gateway forwards: GET on `host` at exactly `path` (byte for byte, up to the '?'),
 * each `query` key present once with exactly that value (as URLSearchParams decodes it); other query
 * keys pass through. Anything else on a listed host is refused_route.
 */
export const ScrapeRoute = z.strictObject({
  id: ScrapeRouteId,
  host: ScrapeHostName,
  method: z.literal('GET'),
  path: ScrapeRoutePath,
  /** The required query: key -> value, 1..256 and 1..1024 printable ASCII characters, at most SCRAPE_MAX_ROUTE_QUERY_KEYS keys. */
  query: z
    .record(z.string().regex(/^[\x20-\x7e]{1,256}$/, 'expected a query key: 1..256 printable ASCII characters'), z.string().regex(/^[\x20-\x7e]{1,1024}$/, 'expected a query value: 1..1024 printable ASCII characters'))
    .refine((q) => Object.keys(q).length <= SCRAPE_MAX_ROUTE_QUERY_KEYS, `at most ${SCRAPE_MAX_ROUTE_QUERY_KEYS} required query keys`)
    .default({}),
});

/** When the gateway opens a host's upstream session: at the entry's first ClientHello naming it (cold), or before the trial starts (warm). */
export const SCRAPE_UPSTREAM_MODES = ['cold', 'warm'] as const;
export const ScrapeUpstreamMode = z.enum(SCRAPE_UPSTREAM_MODES);

/** The most hosts and routes a harness may list, and the largest per-trial request cap of one route. */
export const SCRAPE_MAX_HOSTS = 8;
export const SCRAPE_MAX_ROUTES = 16;
export const SCRAPE_MAX_REQUEST_CAP = 10_000;
/** The most connections, and requests in flight, a harness may allow one trial. */
export const SCRAPE_MAX_CONNECTIONS = 10_000;

/**
 * What a trial may reach (the gateway's config, grader/scrape/gateway.ts, carries these as they are):
 * each listed host is a DNS alias of the gateway on the trial network, only the routes pass, each at
 * most its request cap per trial (refused_cap past it), and the connection, concurrency and byte caps
 * hold the whole trial (a connection over one is destroyed). Hosts listed once each, route ids
 * unique, each route on a listed host and no two the same request, and request_caps naming exactly
 * the routes.
 */
export const ScrapeNetwork = z
  .strictObject({
    hosts: z.array(ScrapeHostName).min(1).max(SCRAPE_MAX_HOSTS),
    routes: z.array(ScrapeRoute).min(1).max(SCRAPE_MAX_ROUTES),
    /** Route id -> the most requests on it one trial may make. */
    request_caps: z.record(ScrapeRouteId, z.int().min(1).max(SCRAPE_MAX_REQUEST_CAP)),
    /** TCP connections per trial, accepted or refused. */
    max_connections: z.int().min(1).max(SCRAPE_MAX_CONNECTIONS),
    /** Requests in flight at once (admitted, response not yet finished). */
    max_concurrent: z.int().min(1).max(SCRAPE_MAX_CONNECTIONS),
    /** Bytes on the wire (TLS records and all) to the entry per trial, every connection's together. */
    max_bytes_down: z.int().min(1),
    /** Bytes on the wire from the entry per trial. */
    max_bytes_up: z.int().min(1),
    upstream: ScrapeUpstreamMode.default('cold'),
  })
  .superRefine((n, ctx) => {
    const issue = issuer(ctx);
    const twice = firstRepeat(n.hosts);
    if (twice !== -1) issue(['hosts', twice], `the host ${n.hosts[twice]} is listed twice`);
    const hosts = new Set(n.hosts);
    const ids = new Set<string>();
    const requests = new Map<string, string>();
    n.routes.forEach((r, i) => {
      if (ids.has(r.id)) issue(['routes', i, 'id'], `the route id ${r.id} is listed twice`);
      ids.add(r.id);
      if (!hosts.has(r.host)) issue(['routes', i, 'host'], `${r.host} is not one of hosts: a route is on a listed host`);
      const request = sortedJson([r.host, r.method, r.path, r.query]);
      const same = requests.get(request);
      if (same !== undefined) issue(['routes', i], `${r.id} is the same request as ${same}: host, method, path and query`);
      else requests.set(request, r.id);
    });
    for (const id of ids) if (!Object.hasOwn(n.request_caps, id)) issue(['request_caps'], `the route ${id} has no request cap: every route has one`);
    for (const id of Object.keys(n.request_caps)) if (!ids.has(id)) issue(['request_caps', id], `${id} is not a route: request_caps names the routes, and only them`);
  }, whenValid);

// ---------------------------------------------------------------- heat config (the harness block's)

/** The heat's numbers when the bundle names none (the plan's, from #2192's noise measurements). */
export const SCRAPE_HEAT_DEFAULTS = Object.freeze({
  rounds: 15,
  warmup_rounds: 1,
  trim: 2,
  cap_ms: 5000,
  cooldown_ms: 1000,
  playoff: Object.freeze({ places: 12, rounds: 30 }),
});

/**
 * The playoff: once the main stage is scored, its `places` best ranked runs (the house baseline too,
 * if it ranks there) run `rounds` more interleaved rounds among themselves. A playoff runs only when
 * both are above 0.
 */
export const ScrapePlayoffConfig = z
  .strictObject({
    places: z.int().min(0).max(20).default(SCRAPE_HEAT_DEFAULTS.playoff.places),
    rounds: z.int().min(0).max(60).default(SCRAPE_HEAT_DEFAULTS.playoff.rounds),
  })
  .prefault({});

/**
 * The fewest and the most contenders a staged heat names (StagedHeat.contenders): a scrape/v1 heat's
 * (ScrapeHeatConfig.staged) or a program/v1 timing heat's (contracts/competition.ts ProgramTiming.staged).
 * How many a bundle should name is an authoring rule, not the contract's.
 */
export const STAGED_HEAT_MIN_CONTENDERS = 2;
export const STAGED_HEAT_MAX_CONTENDERS = 1000;

/**
 * A staged heat: rather than every entry running every round of the serial heat, each entry's
 * qualifying trial (a scrape/v1 entry's practice heat, a timing entry's final grades' own measured
 * time) costs the serial lane nothing, and only the `contenders` fastest entrants' entries on it run
 * the heat. Its rules against the rest of the bundle: server/competitions/load.ts stagedHeatIssues
 * (every playoff place a contender, a final phase, and for a scrape/v1 heat a dev phase); read through
 * contracts/competition.ts stagedHeatOf.
 */
export const StagedHeat = z.strictObject({
  /** M: how many entrants' entries run the heat, STAGED_HEAT_MIN_CONTENDERS..STAGED_HEAT_MAX_CONTENDERS, at least the playoff's places. */
  contenders: z.int().min(STAGED_HEAT_MIN_CONTENDERS).max(STAGED_HEAT_MAX_CONTENDERS),
});

/**
 * How a heat runs: warmup_rounds untimed rounds first (they count for nothing), then `rounds` timed
 * main rounds, every entrant once a round in a drawn order, then the playoff. Each trial is SIGKILLed
 * at cap_ms, and cooldown_ms pass between trials. `trim` trials are dropped at each end of a run's
 * sorted times (the rank key, scrapeTimeUs), so it is under rounds / 3: at least a third of the
 * rounds are averaged.
 */
export const ScrapeHeatConfig = z
  .strictObject({
    rounds: z.int().min(5).max(31).default(SCRAPE_HEAT_DEFAULTS.rounds),
    warmup_rounds: z.int().min(0).max(2).default(SCRAPE_HEAT_DEFAULTS.warmup_rounds),
    trim: z.int().min(0).default(SCRAPE_HEAT_DEFAULTS.trim),
    cap_ms: z.int().min(1000).max(30_000).default(SCRAPE_HEAT_DEFAULTS.cap_ms),
    cooldown_ms: z.int().min(0).max(60_000).default(SCRAPE_HEAT_DEFAULTS.cooldown_ms),
    playoff: ScrapePlayoffConfig,
    /**
     * The contenders cut (StagedHeat). Absent: every entry runs the heat (it is not staged), and no
     * key appears, so a bundle without it keeps its hash.
     */
    staged: StagedHeat.optional(),
  })
  .superRefine((h, ctx) => {
    if (3 * h.trim >= h.rounds) {
      issuer(ctx)(['trim'], `trim ${h.trim} is not under rounds / 3 (${h.rounds} rounds): dropping ${h.trim} at each end must leave more than a third of the rounds; at most ${Math.floor((h.rounds - 1) / 3)}`);
    }
  }, whenValid)
  .prefault({});

// ---------------------------------------------------------------- cassette

export const SCRAPE_CASSETTE_FORMAT = 'agent-fun/scrape-cassette/v1';

/**
 * How a request ended: forwarded (the upstream answered it, and the answer went back as received),
 * refused_route (not a listed host, route, method or required query: answered 403), refused_cap (its
 * route's request cap or max_concurrent: answered 429), upstream_error (the upstream's own 429 or 5xx,
 * or it could not be reached or reset: a void).
 */
export const SCRAPE_OUTCOMES = ['forwarded', 'refused_route', 'refused_cap', 'upstream_error'] as const;
export const ScrapeOutcome = z.enum(SCRAPE_OUTCOMES);

/** Why a request was refused_route (bad_header: a request header the upstream session will not send). */
export const SCRAPE_ROUTE_REFUSALS = ['no_authority', 'bad_authority', 'unknown_authority', 'authority_mismatch', 'not_a_route', 'method_not_allowed', 'missing_query', 'bad_header'] as const;
/** Why a request was refused_cap. */
export const SCRAPE_CAP_REFUSALS = ['request_cap', 'max_concurrent'] as const;
/** Why a request was upstream_error (unfinished: the trial stopped before the upstream answered). */
export const SCRAPE_UPSTREAM_ERRORS = ['upstream_status', 'upstream_unavailable', 'upstream_reset', 'bad_upstream_header', 'unfinished'] as const;
/**
 * Why a connection was refused (`refused`): at accept (max_connections), before TLS (not_tls,
 * bad_client_hello, no_sni, unknown_sni), or destroyed later by a trial cap (max_bytes_up,
 * max_bytes_down, max_entries).
 */
export const SCRAPE_CONNECTION_REFUSALS = ['max_connections', 'not_tls', 'bad_client_hello', 'no_sni', 'unknown_sni', 'max_bytes_up', 'max_bytes_down', 'max_entries'] as const;
/**
 * Why a forwarded request did not go back whole, or null when it did: the entry left first
 * (entry_aborted), a cap destroyed its connection, or the trial stopped first (unfinished).
 */
export const SCRAPE_FORWARDED_REASONS = ['entry_aborted', 'unfinished', 'max_bytes_up', 'max_bytes_down', 'max_entries'] as const;

/** Every `reason` an entry may carry, by its outcome. */
export const SCRAPE_REASONS_BY_OUTCOME: Readonly<Record<(typeof SCRAPE_OUTCOMES)[number], readonly string[]>> = Object.freeze({
  forwarded: SCRAPE_FORWARDED_REASONS,
  refused_route: SCRAPE_ROUTE_REFUSALS,
  refused_cap: SCRAPE_CAP_REFUSALS,
  upstream_error: SCRAPE_UPSTREAM_ERRORS,
});

/** The upstream response headers an entry records, as strings (grader/scrape/gateway.ts RECORDED_HEADERS). */
export const SCRAPE_RECORDED_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'content-type', 'date'] as const;

/** The ALPN protocols a connection may negotiate (h2, or http/1.1 through allowHTTP1). */
export const SCRAPE_ALPNS = ['h2', 'http/1.1'] as const;
const Alpn = z.enum(SCRAPE_ALPNS).nullable();

const Status = z.int().min(100).max(599);

export const ScrapeCassetteEntry = z
  .strictObject({
    /** 0-based arrival order: entry i has seq i. */
    seq: z.int().min(0),
    /** Microseconds since the gateway was ready, on its monotonic clock (0 for anything earlier). */
    t_us: z.int().min(0),
    /** The id of the connection it came on (ScrapeCassetteConnection.id). */
    connection: z.int().min(0),
    /** That connection's SNI: a listed host. */
    sni: ScrapeHostName,
    alpn: Alpn,
    /** As received. */
    method: z.string(),
    /** h2 :authority (or Host), h1 Host, as received; null when it carried none. */
    authority: z.string().nullable(),
    /** The request target with its query, as received; null when it carried none. */
    path: z.string().nullable(),
    /** The route it matched; null when it matched none. */
    route: ScrapeRouteId.nullable(),
    outcome: ScrapeOutcome,
    /** Null for a clean exchange; else one of SCRAPE_REASONS_BY_OUTCOME[outcome]. */
    reason: z.string().nullable(),
    /** The status sent to the entry; null when nothing was. */
    status: Status.nullable(),
    /** The upstream response's SCRAPE_RECORDED_HEADERS it carried, as strings; {} without an upstream response. */
    headers: z.partialRecord(z.enum(SCRAPE_RECORDED_HEADERS), z.string()),
    /** The upstream's Content-Encoding, trimmed and lowercased; null without one. */
    content_encoding: z.string().min(1).nullable(),
    /** sha256 and size of the DECODED upstream body, both null when there is no whole upstream body or it does not decode. */
    body_sha256: Sha256Hex.nullable(),
    body_bytes: z.int().min(0).nullable(),
    /** Body bytes sent to the entry. */
    wire_bytes: z.int().min(0),
  })
  .superRefine((e, ctx) => {
    const issue = issuer(ctx);
    if ((e.body_sha256 === null) !== (e.body_bytes === null)) issue(['body_bytes'], 'body_sha256 and body_bytes are both null or both set: the decoded body and its size');
    if (e.reason !== null && !SCRAPE_REASONS_BY_OUTCOME[e.outcome].includes(e.reason)) {
      issue(['reason'], `${e.outcome} takes the reasons ${SCRAPE_REASONS_BY_OUTCOME[e.outcome].join(', ')}, or none, not ${e.reason}`);
    }
    if (e.outcome === 'forwarded') {
      if (e.route === null) issue(['route'], 'a forwarded request matched a route');
      if (e.status !== null && (e.status === 429 || e.status >= 500)) issue(['status'], `an upstream ${e.status} is upstream_error, not forwarded`);
      return;
    }
    if (e.reason === null) issue(['reason'], `${e.outcome} says why: its reason is one of ${SCRAPE_REASONS_BY_OUTCOME[e.outcome].join(', ')}`);
    if (e.outcome === 'upstream_error') {
      if (e.route === null) issue(['route'], 'only a request that matched a route reaches the upstream');
      return;
    }
    // Refused: answered by the gateway itself, never by the upstream.
    if (e.outcome === 'refused_cap' && e.route === null) issue(['route'], 'a request cap is a route\'s: a refused_cap request matched one');
    if (e.outcome === 'refused_route' && (e.route !== null) !== (e.reason === 'bad_header')) {
      issue(['route'], 'a refused_route request names its route only when the route matched and a header could not be sent (bad_header)');
    }
    const answered = e.outcome === 'refused_route' ? 403 : 429;
    if (e.status !== null && e.status !== answered) issue(['status'], `the gateway answers ${e.outcome} with ${answered}, not ${e.status}`);
    if (Object.keys(e.headers).length > 0) issue(['headers'], 'a refused request has no upstream response, so no headers');
    if (e.content_encoding !== null) issue(['content_encoding'], 'a refused request has no upstream response, so no content-encoding');
    if (e.body_sha256 !== null) issue(['body_sha256'], 'a refused request has no upstream response, so no body');
  }, whenValid);

export const ScrapeCassetteConnection = z
  .strictObject({
    /** 0-based accept order: connection i has id i. */
    id: z.int().min(0),
    /** Microseconds since the gateway was ready, at accept. */
    t_us: z.int().min(0),
    /** The ClientHello's SNI, lowercased; null when none was read. */
    sni: z.string().nullable(),
    /** The negotiated ALPN; null when TLS did not finish or negotiated none. */
    alpn: Alpn,
    /** Wire bytes (TLS records and all) from and to the entry on this connection. */
    bytes_up: z.int().min(0),
    bytes_down: z.int().min(0),
    /** Why it was refused or destroyed (SCRAPE_CONNECTION_REFUSALS); null when it was not. */
    refused: z.enum(SCRAPE_CONNECTION_REFUSALS).nullable(),
  })
  .refine((c) => c.refused !== 'max_connections' || (c.sni === null && c.alpn === null), {
    message: 'a connection refused at accept (max_connections) never read a ClientHello',
    path: ['refused'],
    ...whenValid,
  });

/** What a cassette's lists add up to. */
export const ScrapeCassetteTotals = z.strictObject({
  /** Every entry, and the entries of each outcome. */
  requests: z.int().min(0),
  forwarded: z.int().min(0),
  refused_route: z.int().min(0),
  refused_cap: z.int().min(0),
  upstream_error: z.int().min(0),
  /** Every connection, and those refused. */
  connections: z.int().min(0),
  refused_connections: z.int().min(0),
  /** The connections' wire bytes summed. */
  bytes_up: z.int().min(0),
  bytes_down: z.int().min(0),
});

export const ScrapeCassette = z
  .strictObject({
    format: z.literal(SCRAPE_CASSETTE_FORMAT),
    entries: z.array(ScrapeCassetteEntry),
    connections: z.array(ScrapeCassetteConnection),
    totals: ScrapeCassetteTotals,
  })
  .superRefine((c, ctx) => {
    const issue = issuer(ctx);
    c.connections.forEach((k, i) => {
      if (k.id !== i) issue(['connections', i, 'id'], `connection ${i} has id ${k.id}: connections are in accept order, id 0, 1, 2, ...`);
      if (i > 0 && k.t_us < c.connections[i - 1]!.t_us) issue(['connections', i, 't_us'], 'connections are in accept order: t_us never goes back');
    });
    const sum = { requests: c.entries.length, forwarded: 0, refused_route: 0, refused_cap: 0, upstream_error: 0 };
    c.entries.forEach((e, i) => {
      if (e.seq !== i) issue(['entries', i, 'seq'], `entry ${i} has seq ${e.seq}: entries are in arrival order, seq 0, 1, 2, ...`);
      if (i > 0 && e.t_us < c.entries[i - 1]!.t_us) issue(['entries', i, 't_us'], 'entries are in arrival order: t_us never goes back');
      sum[e.outcome]++;
      const k = c.connections[e.connection];
      if (k === undefined) {
        issue(['entries', i, 'connection'], `no connection has id ${e.connection}`);
        return;
      }
      if (k.sni !== e.sni) issue(['entries', i, 'sni'], `entry ${i} came on connection ${k.id}, whose SNI is ${String(k.sni)}, not ${e.sni}`);
      if (k.alpn !== e.alpn) issue(['entries', i, 'alpn'], `entry ${i} came on connection ${k.id}, which negotiated ${String(k.alpn)}, not ${String(e.alpn)}`);
    });
    const t = c.totals;
    for (const key of ['requests', 'forwarded', 'refused_route', 'refused_cap', 'upstream_error'] as const) {
      if (t[key] !== sum[key]) issue(['totals', key], `the entries hold ${sum[key]}, not totals.${key} ${t[key]}`);
    }
    const conns = { connections: c.connections.length, refused_connections: c.connections.filter((k) => k.refused !== null).length, bytes_up: 0, bytes_down: 0 };
    for (const k of c.connections) {
      conns.bytes_up += k.bytes_up;
      conns.bytes_down += k.bytes_down;
    }
    for (const key of ['connections', 'refused_connections', 'bytes_up', 'bytes_down'] as const) {
      if (t[key] !== conns[key]) issue(['totals', key], `the connections hold ${conns[key]}, not totals.${key} ${t[key]}`);
    }
  }, whenValid);

// ---------------------------------------------------------------- stages and statuses

/** The stages of a heat: warm-up rounds (untimed, never listed in a run), the main stage, the playoff. */
export const SCRAPE_HEAT_STAGES = ['warmup', 'main', 'playoff'] as const;
export const ScrapeHeatStage = z.enum(SCRAPE_HEAT_STAGES);

/** The timed stages: what a run lists. */
export const SCRAPE_STAGES = ['main', 'playoff'] as const;
export const ScrapeStage = z.enum(SCRAPE_STAGES);
export type ScrapeStageT = (typeof SCRAPE_STAGES)[number];

/**
 * How a timed trial that counts ended (grader/scrape/trial.ts decides the fault, the sealed scorer
 * the verdict):
 *   - correct: exited 0 within the cap, and the scorer found its output equal to what the trial's own
 *     cassette served; the only status whose wall time counts
 *   - incorrect: exited 0 within the cap, and the scorer found it unequal
 *   - timeout: SIGKILLed at cap_ms
 *   - crashed: a non-zero exit
 *   - invalid_output: its /output broke the output caps
 *   - leftover_process: it left a process behind
 *   - off_route: the gateway refused one of its requests as off the routes (refused_route)
 *   - over_cap: it hit a request cap (refused_cap), or a connection or byte cap
 */
export const SCRAPE_TRIAL_STATUSES = ['correct', 'incorrect', 'timeout', 'crashed', 'invalid_output', 'leftover_process', 'off_route', 'over_cap'] as const;
export const ScrapeTrialStatus = z.enum(SCRAPE_TRIAL_STATUSES);
export type ScrapeTrialStatusT = (typeof SCRAPE_TRIAL_STATUSES)[number];

/**
 * A listed trial that counts for nothing (the header's trials manifest): judged void at an admin's re-judging, incorrect
 * against the heat's reference read and correct judged again against its own cassette (it failed on how the upstream
 * served the same request since the heat began, a chart served short, never on what the entry wrote), which a heat
 * would run again and a re-judging cannot. Listed under its round, its wall time as measured; every time, count and the
 * trim leave it out.
 */
export const SCRAPE_VOID_STATUS = 'void';

/** The statuses a listed trial carries: every status of a trial that counts (SCRAPE_TRIAL_STATUSES), and void. */
export const SCRAPE_LISTED_STATUSES = [...SCRAPE_TRIAL_STATUSES, SCRAPE_VOID_STATUS] as const;
export const ScrapeListedStatus = z.enum(SCRAPE_LISTED_STATUSES);
export type ScrapeListedStatusT = (typeof SCRAPE_LISTED_STATUSES)[number];

/** A run's trials that count: every listed trial but a void (SCRAPE_VOID_STATUS), in their order. What K, the times, the counts and the trim are over. */
export function scrapeCountedTrials<T extends { status: ScrapeListedStatusT }>(trials: readonly T[]): T[] {
  return trials.filter((t) => t.status !== SCRAPE_VOID_STATUS);
}

/**
 * The fewest main trials that count (scrapeCountedTrials) a run is scored on under `trim`: more than 3 x trim (the
 * harness's trim rule, ScrapeHeatConfig: the trimmed mean averages more than a third of them) and at least 2 (Yuen's
 * interval keeps at least 2 past the trim). A heat's runs list one trial per round and voids only a re-judging lists, so
 * only judged voids ever leave a run with fewer. RangeError for a trim that is no whole number of trials.
 */
export function scrapeFewestCountedMain(trim: number): number {
  if (!Number.isSafeInteger(trim) || trim < 0) throw new RangeError(`trim ${trim}: a whole number of trials`);
  return Math.max(3 * trim + 1, 2);
}

/**
 * A run's trials in order: the main stage first, then the playoff (a finalist's alone), each stage one
 * trial per round, rounds 0, 1, 2, ... with none missing (a void a heat meets re-runs and is listed
 * under its own round; one a re-judging judged is listed void), and at least one main trial.
 */
export function checkScrapeTrialOrder(trials: readonly { stage: ScrapeStageT; round: number }[], path: (string | number)[], issue: Issue): void {
  const next: Record<ScrapeStageT, number> = { main: 0, playoff: 0 };
  let playoff = false;
  trials.forEach((t, i) => {
    if (t.stage === 'playoff') playoff = true;
    else if (playoff) issue([...path, i, 'stage'], 'main trials come before playoff trials');
    if (t.round !== next[t.stage]) {
      issue([...path, i, 'round'], `${t.stage} round ${t.round} where round ${next[t.stage]} is due: a stage lists one trial per round, rounds 0, 1, 2, ... in order`);
    }
    next[t.stage] = t.round + 1;
  });
  if (next.main === 0) issue(path, 'no main trial: every run runs the main stage');
}

// ---------------------------------------------------------------- heat record

export const SCRAPE_HEAT_FORMAT = 'agent-fun/scrape-heat/v1';

/** A heat's id: 1..40 of a-z 0-9 -, starting with a letter or digit (a uuid fits); the <heat> of a trial owner `scrape-<heat>.<entry>.<round>`. */
export const ScrapeHeatId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'expected a heat id: 1..40 of a-z 0-9 -');

/** An entrant: its submission id (a lowercase uuid fits), 1..40 of a-z 0-9 -. */
export const ScrapeEntryId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'expected an entry id (its submission id): 1..40 of a-z 0-9 -');

/** An IP address literal, v4 or v6. */
const IpLiteral = z.union([z.ipv4(), z.ipv6()]);

/** One round of the heat and the order its entrants ran in. */
export const ScrapeHeatRound = z.strictObject({
  stage: ScrapeHeatStage,
  /** 0-based within its stage. */
  round: z.int().min(0),
  /** Who ran when: a permutation of the stage's field (entries, or the playoff's entrants), first to run first. */
  order: z.array(ScrapeEntryId).min(1),
});

/** A host's addresses as the heat resolved them: the gateway dials only these. */
export const ScrapeResolution = z
  .strictObject({
    host: ScrapeHostName,
    ips: z.array(IpLiteral).min(1).max(8),
  })
  .refine((r) => firstRepeat(r.ips) === -1, { message: 'an address is listed twice', path: ['ips'], ...whenValid });

/** Whether `order` is a permutation of `field` (the field already listed once each). */
function isPermutation(order: readonly string[], field: readonly string[]): boolean {
  return order.length === field.length && firstRepeat(order) === -1 && order.every((x) => field.includes(x));
}

/** A code-unit-ordered list with no repeat: the first index out of order, or -1. */
function firstUnsorted(xs: readonly string[]): number {
  for (let i = 1; i < xs.length; i++) if (!(xs[i - 1]! < xs[i]!)) return i;
  return -1;
}

export const ScrapeHeat = z
  .strictObject({
    format: z.literal(SCRAPE_HEAT_FORMAT),
    id: ScrapeHeatId,
    /** The public drand round the heat's orders are drawn from: its chain's hash, the round, and the sha256 of its signature's bytes. */
    drand: z.strictObject({
      chain: Sha256Hex,
      round: z.int().min(1),
      signature_sha256: Sha256Hex,
    }),
    /** The heat's seed, derived from the drand round and its signature: every round's order is drawn from it. */
    seed: Sha256Hex,
    /** Every entrant, the house baseline among them, by submission id in code-unit order: the field each order permutes. */
    entries: z.array(ScrapeEntryId).min(1),
    /** Every round, warm-up first, then main, then playoff, each stage's rounds 0, 1, 2, ... in order. */
    rounds: z.array(ScrapeHeatRound).min(1),
    /** The playoff's entrants (the main stage's best ranked runs), in code-unit order; empty when the heat ran no playoff. */
    playoff: z.array(ScrapeEntryId),
    /** The upstream addresses, in the order resolved: each host's first before the heat's first trial, a later one a re-resolution after a dial failure. */
    upstream: z.array(ScrapeResolution).min(1),
    /**
     * sha256 of the heat's reference read's canonical cassette JSON (ScrapeCassette), as stored: the
     * house's own read of the routes at heat start (grader/scrape/heat.ts), the one judged correct, which
     * the scorer read at /reference/heat/ judging every trial of the heat. An L1 regrade rebuilds
     * /reference/heat/ from it, and a final kit carries it as runs/reference/.
     */
    reference_cassette_sha256: Sha256Hex,
  })
  .superRefine((h, ctx) => {
    const issue = issuer(ctx);
    const unsorted = firstUnsorted(h.entries);
    if (unsorted !== -1) issue(['entries', unsorted], 'entries are listed once each, in code-unit order');
    const finalists = firstUnsorted(h.playoff);
    if (finalists !== -1) issue(['playoff', finalists], "the playoff's entrants are listed once each, in code-unit order");
    h.playoff.forEach((p, i) => {
      if (!h.entries.includes(p)) issue(['playoff', i], `${p} is not one of the heat's entries`);
    });
    const order = SCRAPE_HEAT_STAGES;
    const next: Record<(typeof SCRAPE_HEAT_STAGES)[number], number> = { warmup: 0, main: 0, playoff: 0 };
    let stageAt = 0;
    h.rounds.forEach((r, i) => {
      const at = order.indexOf(r.stage);
      if (at < stageAt) issue(['rounds', i, 'stage'], `a ${r.stage} round after a ${order[stageAt]} one: warm-up rounds first, then main, then playoff`);
      stageAt = Math.max(stageAt, at);
      if (r.round !== next[r.stage]) issue(['rounds', i, 'round'], `${r.stage} round ${r.round} where round ${next[r.stage]} is due: a stage's rounds run 0, 1, 2, ... in order`);
      next[r.stage] = r.round + 1;
      const field = r.stage === 'playoff' ? h.playoff : h.entries;
      if (!isPermutation(r.order, field)) {
        issue(['rounds', i, 'order'], r.stage === 'playoff' ? "a playoff round's order is a permutation of the playoff's entrants" : `a ${r.stage} round's order is a permutation of the heat's entries`);
      }
    });
    if (next.main === 0) issue(['rounds'], 'no main round: a heat runs its main stage');
    if ((next.playoff > 0) !== (h.playoff.length > 0)) issue(['playoff'], 'the playoff has entrants exactly when the heat ran playoff rounds');
  }, whenValid);

// ---------------------------------------------------------------- trials manifest

export const SCRAPE_TRIALS_FORMAT = 'agent-fun/scrape-trials/v1';

export const ScrapeTrialRecord = z
  .strictObject({
    /** 0-based within its stage: the heat record's round. */
    round: z.int().min(0),
    stage: ScrapeStage,
    /** The entry's 0-based place in that round's order (the heat record's), whenever it ran. */
    position: z.int().min(0),
    /** How it ended (SCRAPE_TRIAL_STATUSES), or void: judged void at a re-judging, counting for nothing (SCRAPE_VOID_STATUS). */
    status: ScrapeListedStatus,
    /** The launcher's clock from spawn to exit, nanoseconds. */
    wall_ns: z.int().min(0),
    /** The entry's exit code; null when a signal ended it (a timeout's SIGKILL). */
    exit: z.int().min(0).max(255).nullable(),
    /** The trial's /output as program outputs: what the scorer reads at /output. */
    outputs: TrialOutputs,
    /** sha256 of the trial's canonical cassette JSON (ScrapeCassette), as stored. */
    cassette_sha256: Sha256Hex,
    /** sha256 of the scores.json the sealed scorer wrote for it, against the heat's reference read; null when the scorer did not run on it. */
    scores_sha256: Sha256Hex.nullable(),
    /**
     * A void's alone (absent on every other trial, so its bytes are as before): sha256 of the scores.json the sealed scorer
     * wrote judging it again with its own cassette at /reference/heat/ in place of the heat's reference read (correct).
     */
    own_scores_sha256: Sha256Hex.optional(),
  })
  .superRefine((t, ctx) => {
    const issue = issuer(ctx);
    if (t.status === 'correct' || t.status === 'incorrect') {
      if (t.exit !== 0) issue(['exit'], `${t.status} is the scorer's verdict on an entry that exited 0: a non-zero exit is crashed, a signal a timeout`);
      if (t.scores_sha256 === null) issue(['scores_sha256'], `${t.status} is the scorer's verdict: its scores.json is recorded`);
    }
    if (t.status === SCRAPE_VOID_STATUS) {
      if (t.exit !== 0) issue(['exit'], 'a void was judged by the scorer on an entry that exited 0: a non-zero exit is crashed, a signal a timeout');
      if (t.scores_sha256 === null) issue(['scores_sha256'], "a void was judged against the heat's reference read, incorrect: that scores.json is recorded");
      if (t.own_scores_sha256 === undefined) issue(['own_scores_sha256'], 'a void was judged again against its own cassette, correct: that scores.json is recorded');
    } else if (t.own_scores_sha256 !== undefined) {
      issue(['own_scores_sha256'], `only a void is judged against its own cassette: a ${t.status} trial records no own_scores_sha256`);
    }
    if (t.status === 'crashed' && t.exit === 0) issue(['exit'], 'a crashed trial exited non-zero, or a signal ended it');
  }, whenValid);

/** A trial record's fields but its verdict: what two judgings of one trial share. */
function trialSpelled(t: ScrapeTrialRecordT): string {
  return sortedJson([t.round, t.stage, t.position, t.wall_ns, t.exit, t.outputs, t.cassette_sha256]);
}

/**
 * A listed void (the header's trials manifest) from its two judgings: `reference`, the trial judged against the heat's
 * reference read (incorrect), and `own`, the same trial judged again with its own cassette in place of it (correct). The
 * first judging's record with status void and the second's scores.json digest (own_scores_sha256). RangeError when the
 * two are not that: two judgings of one trial, incorrect then correct.
 */
export function scrapeVoidRecord(reference: ScrapeTrialRecordT, own: ScrapeTrialRecordT): ScrapeTrialRecordT {
  if (reference.status !== 'incorrect') throw new RangeError(`a void is incorrect against the heat's reference read, not ${reference.status}`);
  if (own.status !== 'correct') throw new RangeError(`a void is correct judged against its own cassette, not ${own.status}`);
  if (reference.scores_sha256 === null || own.scores_sha256 === null) throw new RangeError("a void's two judgings each wrote a scores.json: both are recorded");
  if (trialSpelled(reference) !== trialSpelled(own)) {
    throw new RangeError(`a void is two judgings of one trial: ${reference.stage} round ${reference.round} and ${own.stage} round ${own.round} differ in where, when or what it wrote`);
  }
  const { own_scores_sha256: _none, ...judged } = reference;
  return ScrapeTrialRecord.parse({ ...judged, status: SCRAPE_VOID_STATUS, own_scores_sha256: own.scores_sha256 });
}

/** One entry's run: its action log. */
export const ScrapeTrials = z
  .strictObject({
    format: z.literal(SCRAPE_TRIALS_FORMAT),
    /** The heat it ran in (ScrapeHeat.id) and the entry it is (one of its entries). */
    heat: ScrapeHeatId,
    entry: ScrapeEntryId,
    /** Every timed trial: main rounds, then playoff rounds (checkScrapeTrialOrder), one per round, a re-judging's void listed void. */
    trials: z.array(ScrapeTrialRecord).min(1),
    /** Trials voided (an infrastructure fault, or a chart served short) and re-run: none of them is listed (a listed void never re-ran). */
    voids_rerun: z.int().min(0),
  })
  .superRefine((m, ctx) => checkScrapeTrialOrder(m.trials, ['trials'], issuer(ctx)), whenValid);

/**
 * What a run's manifest disagrees with its heat record on: the heat, the entry one of its entries,
 * every main round of the heat listed and, for a playoff entrant, every playoff round (no other run
 * lists one), and each trial's position the entry's place in its round's order. The issue lines, or
 * none. Both records already parsed.
 */
export function scrapeTrialsHeatIssues(heat: ScrapeHeatT, trials: ScrapeTrialsT): string[] {
  const issues: string[] = [];
  if (trials.heat !== heat.id) issues.push(`heat: the run ran in heat ${trials.heat}, not ${heat.id}`);
  if (!heat.entries.includes(trials.entry)) issues.push(`entry: ${trials.entry} is not one of heat ${heat.id}'s entries`);
  const finalist = heat.playoff.includes(trials.entry);
  for (const stage of SCRAPE_STAGES) {
    const rounds = heat.rounds.filter((r) => r.stage === stage);
    const listed = trials.trials.filter((t) => t.stage === stage);
    const due = stage === 'playoff' && !finalist ? 0 : rounds.length;
    if (listed.length !== due) issues.push(`trials: ${listed.length} ${stage} trials are listed, and the heat ran ${due} ${stage} rounds for ${trials.entry}`);
  }
  trials.trials.forEach((t, i) => {
    const round = heat.rounds.find((r) => r.stage === t.stage && r.round === t.round);
    if (round === undefined) return;
    const at = round.order.indexOf(trials.entry);
    if (at !== t.position) issues.push(`trials.${i}.position: ${trials.entry} ran at position ${at} of ${t.stage} round ${t.round}, not ${t.position}`);
  });
  return issues;
}

// ---------------------------------------------------------------- performance

/** Sorted ascending, as BigInt. */
function sortedUs(xs: readonly number[]): bigint[] {
  return xs.map((x) => BigInt(x)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** What the times read of a listed trial. */
type TimedTrial = { status: ScrapeListedStatusT; wall_us: number };

/**
 * The rank key, in microseconds (see the header): of the K trials that count (a listed void is none), the correct
 * ones' wall_us and one +infinity per other trial, the `trim` fastest and the `trim` slowest dropped, the K - 2 x trim
 * left averaged half-even. Null when more than `trim` trials that count are not correct (the run is unranked) or when
 * nothing would be left to average.
 */
export function scrapeTimeUs(trials: readonly TimedTrial[], trim: number): bigint | null {
  const counted = scrapeCountedTrials(trials);
  const correct = sortedUs(counted.filter((t) => t.status === 'correct').map((t) => t.wall_us));
  const failed = counted.length - correct.length;
  const kept = counted.length - 2 * trim;
  if (failed > trim || kept <= 0) return null;
  // The failures are the slowest `failed`, all dropped with the trim - failed slowest correct trials.
  const mean = correct.slice(trim, correct.length - (trim - failed));
  return divHalfEven(
    mean.reduce((s, x) => s + x, 0n),
    BigInt(kept),
  );
}

/** The median of the correct trials' wall_us (the two middle ones' mean, half-even, on an even count); null with none correct. A void is none. */
export function scrapeMedianUs(trials: readonly TimedTrial[]): bigint | null {
  const xs = sortedUs(trials.filter((t) => t.status === 'correct').map((t) => t.wall_us));
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 === 1 ? xs[mid]! : divHalfEven(xs[mid - 1]! + xs[mid]!, 2n);
}

/** The fastest correct trial's wall_us; null with none correct. A void is none. */
export function scrapeBestUs(trials: readonly TimedTrial[]): bigint | null {
  const xs = sortedUs(trials.filter((t) => t.status === 'correct').map((t) => t.wall_us));
  return xs[0] ?? null;
}

/** One listed trial, as the board and the ties read it: a void among them, listed under its round and counting for nothing. */
export const ScrapeTrialScore = z.strictObject({
  round: z.int().min(0),
  stage: ScrapeStage,
  status: ScrapeListedStatus,
  /** The manifest's wall_ns, half-even to the microsecond (scrapeWallUs). */
  wall_us: z.int().min(0),
});

/** The run's scores: what a leaderboard column reads at performance.scores.<key>. */
export const ScrapeScores = z.strictObject({
  /** THE RANK KEY (scrapeTimeUs), lower is better; null when the run is unranked. */
  time_ms: ScrapeMillis.nullable(),
  /** The median and the fastest of the correct trials; null with none correct. */
  median_ms: ScrapeMillis.nullable(),
  best_ms: ScrapeMillis.nullable(),
  /** counts.correct. */
  correct_trials: z.int().min(0),
  /** It ran the playoff: its time_ms covers its main and playoff trials, and it ranks above every run that did not. */
  finalist: z.boolean(),
});

/** The Yuen interval's level: 90%. */
export const SCRAPE_INTERVAL_LEVEL = '0.900000000';

/**
 * Yuen's 90% interval of the trimmed mean (the rank key's trim): the trimmed mean plus and minus the
 * t quantile at K - 2 x trim - 1 degrees of freedom times its standard error from the winsorized
 * variance, each end half-even to the microsecond and never clipped (the low end may be below 0).
 * Both ends null exactly when time_ms is.
 */
export const ScrapeInterval = z.strictObject({
  level: z.literal(SCRAPE_INTERVAL_LEVEL),
  low_ms: ScrapeSignedMillis.nullable(),
  high_ms: ScrapeSignedMillis.nullable(),
});

export const ScrapeCounts = z.strictObject({
  /** K: the trials that count (scrapeCountedTrials: every listed trial but a void), main and playoff. */
  rounds: z.int().min(1),
  /** Those correct, and the rest (rounds - correct): a listed void is neither. */
  correct: z.int().min(0),
  failed: z.int().min(0),
  /** The manifest's voids_rerun. */
  voids_rerun: z.int().min(0),
});

export const ScrapePerformance = z
  .strictObject({
    kind: z.literal(SCRAPE_HARNESS_KIND),
    /** The trials dropped at each end (the harness's heat.trim): what time_ms and the interval are held to. */
    trim: z.int().min(0),
    /** Every listed trial, a void among them (counting for nothing: the header). */
    trials: z.array(ScrapeTrialScore).min(1),
    scores: ScrapeScores,
    interval: ScrapeInterval,
    counts: ScrapeCounts,
  })
  .superRefine((p, ctx) => {
    const issue = issuer(ctx);
    checkScrapeTrialOrder(p.trials, ['trials'], issue);
    const counted = scrapeCountedTrials(p.trials);
    const correct = counted.filter((t) => t.status === 'correct').length;
    const c = p.counts;
    if (c.rounds !== counted.length) issue(['counts', 'rounds'], `${counted.length} listed trials count (every one but a void), not counts.rounds ${c.rounds}`);
    if (c.correct !== correct) issue(['counts', 'correct'], `${correct} listed trials are correct, not counts.correct ${c.correct}`);
    if (c.failed !== counted.length - correct) issue(['counts', 'failed'], `${counted.length - correct} listed trials that count are not correct, not counts.failed ${c.failed}`);
    if (p.scores.correct_trials !== correct) issue(['scores', 'correct_trials'], `${correct} listed trials are correct, not correct_trials ${p.scores.correct_trials}`);
    // The harness's trim rule, over the main trials that count.
    const main = p.trials.filter((t) => t.stage === 'main');
    const countedMain = scrapeCountedTrials(main).length;
    const mainVoids = main.length - countedMain;
    if (3 * p.trim >= countedMain) {
      issue(['trim'], `trim ${p.trim} is not under a third of the ${countedMain} main trials${mainVoids > 0 ? ` that count (${mainVoids} void)` : ''}: the harness's rule`);
    }
    const finalist = p.trials.some((t) => t.stage === 'playoff');
    if (p.scores.finalist !== finalist) issue(['scores', 'finalist'], finalist ? 'a run with playoff trials is a finalist' : 'a finalist lists its playoff trials');

    const ms = (us: bigint | null) => (us === null ? null : formatScrapeMillis(us));
    const time = ms(scrapeTimeUs(p.trials, p.trim));
    if (p.scores.time_ms !== time) {
      issue(
        ['scores', 'time_ms'],
        time === null
          ? `${counted.length - correct} trials that count are not correct, more than trim ${p.trim}: the run is unranked, time_ms null`
          : `the trimmed mean of the trials is ${time}, not time_ms ${String(p.scores.time_ms)}`,
      );
    }
    const median = ms(scrapeMedianUs(p.trials));
    if (p.scores.median_ms !== median) issue(['scores', 'median_ms'], `the correct trials' median is ${String(median)}, not median_ms ${String(p.scores.median_ms)}`);
    const best = ms(scrapeBestUs(p.trials));
    if (p.scores.best_ms !== best) issue(['scores', 'best_ms'], `the fastest correct trial is ${String(best)}, not best_ms ${String(p.scores.best_ms)}`);

    const { low_ms: low, high_ms: high } = p.interval;
    if ((low === null) !== (p.scores.time_ms === null) || (high === null) !== (p.scores.time_ms === null)) {
      issue(['interval'], 'the interval has both ends exactly when time_ms is set');
    } else if (low !== null && high !== null && p.scores.time_ms !== null) {
      const t = parseScrapeMillis(p.scores.time_ms);
      if (!(parseScrapeMillis(low) <= t && t <= parseScrapeMillis(high))) issue(['interval'], `the interval ${low}..${high} does not hold time_ms ${p.scores.time_ms}`);
    }
  }, whenValid);

export type ScrapeNetworkT = z.infer<typeof ScrapeNetwork>;
export type ScrapeRouteT = z.infer<typeof ScrapeRoute>;
export type ScrapeHeatConfigT = z.infer<typeof ScrapeHeatConfig>;
export type StagedHeatT = z.infer<typeof StagedHeat>;
export type ScrapeCassetteT = z.infer<typeof ScrapeCassette>;
export type ScrapeCassetteEntryT = z.infer<typeof ScrapeCassetteEntry>;
export type ScrapeCassetteConnectionT = z.infer<typeof ScrapeCassetteConnection>;
export type ScrapeCassetteTotalsT = z.infer<typeof ScrapeCassetteTotals>;
export type ScrapeOutcomeT = (typeof SCRAPE_OUTCOMES)[number];
export type ScrapeHeatT = z.infer<typeof ScrapeHeat>;
export type ScrapeHeatRoundT = z.infer<typeof ScrapeHeatRound>;
export type ScrapeTrialsT = z.infer<typeof ScrapeTrials>;
export type ScrapeTrialRecordT = z.infer<typeof ScrapeTrialRecord>;
export type ScrapeTrialScoreT = z.infer<typeof ScrapeTrialScore>;
export type ScrapePerformanceT = z.infer<typeof ScrapePerformance>;
