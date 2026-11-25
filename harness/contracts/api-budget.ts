// make.fun's API request budget: the one policy constant behind the budget middleware, its headers and
// 429, GET /api/rate-limit, OpenAPI, /developers, the SDK and the web app's own pacing, so the numbers
// cannot drift. A leaf: no imports at all, no Node or DOM APIs. Web code imports it extensionless
// (`../../contracts/api-budget`; the contracts/index.ts barrel fails TS5097 there), server code as
// `../contracts/api-budget.ts`, and the SDK vendors it verbatim as clients/ts/src/budget-policy.ts.
//
//   TIERS, LANES, BUDGET_LANES     who is counted, keyed by what, under which policies
//   BUDGET_POLICIES                every policy: a name, a quota q, a window w in seconds
//   isBudgetedPath                 the paths the budget counts at all; anything else is never counted
//   BUDGET_CLASSES, budgetClassOf  which paths cost a request, a heavy unit, a stream connect, or nothing
//   gcra, gcraAll, gcraPeek        the Generic Cell Rate Algorithm over one stored TAT per policy; a take may
//                                  cost more than one (an MCP batch costs one per tools/call it holds)
//   formatRateLimitHeaders         RateLimit-Policy and RateLimit (draft-ietf-httpapi-ratelimit-headers-11)
//                                  plus the X-RateLimit-* fields most clients already read
//   parseRateLimitHeaders          the reverse, for the SDK and the web app; null on a cached answer
//   pacingDelayMs                  how long a poller waits when its budget runs low

/** The IETF draft the RateLimit fields follow; it expires 2026-11-24 (re-check the field syntax then). */
export const DRAFT_REVISION = 'draft-ietf-httpapi-ratelimit-headers-11';
export const DRAFT_EXPIRES = '2026-11-24';

/** free: no API key (a visitor cookie or the client address). registered: an account's af_ key or session. */
export const TIERS = ['free', 'registered'] as const;
export type Tier = (typeof TIERS)[number];

/** One quota policy: `q` requests per `w` seconds (draft §3.1: q and w are integers, w > 0). */
export interface BudgetPolicy {
  readonly name: string;
  readonly q: number;
  readonly w: number;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

export const BUDGET_POLICIES = {
  'free-minute': { name: 'free-minute', q: 60, w: MINUTE },
  'free-day': { name: 'free-day', q: 5_000, w: DAY },
  /** A kept visitor cookie's day: above a tab polling every 5 s for 24 h (17,280), below registered-day. */
  'visitor-day': { name: 'visitor-day', q: 20_000, w: DAY },
  'address-minute': { name: 'address-minute', q: 300, w: MINUTE },
  'platform-minute': { name: 'platform-minute', q: 300, w: MINUTE },
  'registered-minute': { name: 'registered-minute', q: 300, w: MINUTE },
  'registered-day': { name: 'registered-day', q: 50_000, w: DAY },
  'keyed-address-minute': { name: 'keyed-address-minute', q: 1_200, w: MINUTE },
  'free-heavy-hour': { name: 'free-heavy-hour', q: 10, w: HOUR },
  'registered-heavy-hour': { name: 'registered-heavy-hour', q: 100, w: HOUR },
} as const satisfies Record<string, BudgetPolicy>;
export type PolicyName = keyof typeof BUDGET_POLICIES;
export type BudgetPolicyTable = { readonly [P in PolicyName]: BudgetPolicy };

export const LANES = ['visitor', 'address', 'address-ceiling', 'platform', 'key', 'session', 'keyed-address-ceiling', 'heavy'] as const;
export type Lane = (typeof LANES)[number];

export interface LaneSpec {
  /** The partition key's prefix: a lane's row is `<prefix>:<id>` (heavy's id is the caller's own lane key). */
  readonly prefix: string;
  readonly keyedBy: string;
  /** The policies the lane takes, by the caller's tier; a tier missing here never uses the lane. */
  readonly policies: { readonly [T in Tier]?: readonly PolicyName[] };
}

export const BUDGET_LANES = {
  visitor: { prefix: 'v', keyedBy: 'the signed visitor cookie mf_vid', policies: { free: ['free-minute', 'visitor-day'] } },
  address: { prefix: 'a', keyedBy: 'the client address (IPv6 by /64), without a visitor cookie', policies: { free: ['free-minute', 'free-day'] } },
  'address-ceiling': { prefix: 'aa', keyedBy: 'the client address, all anonymous traffic', policies: { free: ['address-minute'] } },
  platform: { prefix: 'p', keyedBy: "an address in Anthropic's or OpenAI's published egress ranges", policies: { free: ['platform-minute'] } },
  key: { prefix: 'k', keyedBy: 'the account: all its keys share one lane', policies: { registered: ['registered-minute', 'registered-day'] } },
  session: { prefix: 's', keyedBy: 'the account, a partition of its own', policies: { registered: ['registered-minute', 'registered-day'] } },
  'keyed-address-ceiling': { prefix: 'ka', keyedBy: 'the client address, all keyed traffic', policies: { registered: ['keyed-address-minute'] } },
  heavy: { prefix: 'h', keyedBy: "the caller's own lane key", policies: { free: ['free-heavy-hour'], registered: ['registered-heavy-hour'] } },
} as const satisfies Record<Lane, LaneSpec>;

/** Kit downloads one caller may run at once (per replica). */
export const KIT_CONCURRENCY = 2;
/** Account roles never counted. */
export const BUDGET_EXEMPT_ROLES = ['house', 'admin'] as const;

/** The tier a lane serves, or null for heavy, which serves both. */
export function laneTier(lane: Lane): Tier | null {
  const tiers = TIERS.filter((t) => (BUDGET_LANES[lane].policies as LaneSpec['policies'])[t] !== undefined);
  return tiers.length === 1 ? tiers[0]! : null;
}

/** A lane's policies for a tier, read from `table` (the defaults, or a test's smaller numbers). */
export function lanePolicies(lane: Lane, tier: Tier, table: BudgetPolicyTable = BUDGET_POLICIES): readonly BudgetPolicy[] {
  const names = (BUDGET_LANES[lane].policies as LaneSpec['policies'])[tier];
  if (names === undefined) throw new RangeError(`lane ${lane} serves no ${tier} caller`);
  return names.map((n) => table[n]);
}

/** The defaults with some policies' numbers replaced; each keeps its name. */
export function budgetPolicyTable(overrides: { readonly [P in PolicyName]?: { readonly q: number; readonly w: number } } = {}): BudgetPolicyTable {
  const out = { ...BUDGET_POLICIES } as Record<PolicyName, BudgetPolicy>;
  for (const name of Object.keys(overrides) as PolicyName[]) {
    const o = overrides[name]!;
    out[name] = checkPolicy({ name, q: o.q, w: o.w });
  }
  return out;
}

/** A lane's partition key: `v:<vid>`, `k:<accountId>`, `h:v:<vid>`… */
export function budgetKey(lane: Lane, id: string): string {
  return `${BUDGET_LANES[lane].prefix}:${id}`;
}

// ---- Budgeted paths ------------------------------------------------------------------------------
// The budget middleware (server/budget/middleware.ts) runs on these paths alone: /api/*, POST /mcp and /mcp/public,
// /export/* and a competition's kit. Anything else (the web app's pages, /mcp/server-card, /llms.txt, git…) is never
// counted, whatever its class below.

const KIT_PATH = /^\/c\/[^/]+\/kit$/;

/** Whether the budget counts `path` at all (the query string, if any, is ignored); the exempt class is told apart after. */
export function isBudgetedPath(path: string): boolean {
  const p = path.split('?', 1)[0]!;
  return p.startsWith('/api/') || p === '/mcp' || p === '/mcp/public' || p.startsWith('/export/') || KIT_PATH.test(p);
}

/** Whether `path` is a competition's kit, GET /c/:slug/kit (the one path with a concurrency cap: KIT_CONCURRENCY). */
export function isKitPath(path: string): boolean {
  return KIT_PATH.test(path.split('?', 1)[0]!);
}

// ---- Budget classes ------------------------------------------------------------------------------
// A pattern's `:name` is one path segment; `*` is any run of characters, `/` included, and a trailing
// `/*` also matches the bare prefix. Classes are tried exempt, heavy, stream; anything else is a request.

export type BudgetClass = 'request' | 'heavy' | 'stream' | 'exempt';

export const BUDGET_CLASSES = {
  default: 'request',
  /** One request plus one unit of the tier's heavy-hour policy (and the kit's concurrency cap). */
  heavy: ['/c/:slug/kit', '/export/*', '/api/submissions/:id/download/*', '/api/submissions/:id/raw/*'],
  /** SSE: counted once, at connect. */
  stream: ['*/stream'],
  /** Never counted. */
  exempt: ['/api/avatars/*', '/api/profiles/:handle/picture.png', '/api/auth/*', '/api/webhooks/*', '/api/telemetry/*', '/health', '/api/rate-limit', '/api/openapi*.json'],
} as const;

const patternCache = new Map<string, RegExp>();
function patternRe(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (re === undefined) {
    const trailing = pattern.endsWith('/*');
    const body = trailing ? pattern.slice(0, -2) : pattern;
    const src = body
      .split(/(\*|:[A-Za-z_][A-Za-z0-9_]*)/)
      .map((part) => (part === '*' ? '.*' : part.startsWith(':') ? '[^/]+' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    re = new RegExp(`^${src}${trailing ? '(?:/.*)?' : ''}$`);
    patternCache.set(pattern, re);
  }
  return re;
}

/** Whether a request path (or a route pattern such as `/api/competitions/:slug/live/stream`) matches. */
export function matchesBudgetPattern(pattern: string, path: string): boolean {
  return patternRe(pattern).test(path);
}

/** The budget class of a path; the query string, if any, is ignored. */
export function budgetClassOf(path: string): BudgetClass {
  const p = path.split('?', 1)[0]!;
  for (const cls of ['exempt', 'heavy', 'stream'] as const) {
    if (BUDGET_CLASSES[cls].some((pat) => matchesBudgetPattern(pat, p))) return cls;
  }
  return BUDGET_CLASSES.default;
}

// ---- GCRA ----------------------------------------------------------------------------------------
// Generic Cell Rate Algorithm (ITU-T I.371; the "virtual scheduling" form): one stored theoretical
// arrival time (TAT) per policy. Emission interval T = w/q, burst q: a request is allowed while the
// new TAT stays within w of now. TATs are stored as integer ms, so a policy's T must be whole ms.
// A take of cost n (default 1) moves the TAT n intervals at once: newTat = max(tat, now) + n*T, allowed
// iff it stays within w of now, so n is at most q; a refusal consumes nothing, as at cost 1.

export interface GcraResult {
  readonly allowed: boolean;
  /** The TAT to store: unchanged on a refusal. */
  readonly newTat: number;
  /** Requests still available right now under this policy. */
  readonly remaining: number;
  /**
   * The effective window (draft §4.1.2), whole seconds: until the quota is whole again, or, when none
   * remains, until the next unit is back, so a Retry-After never precedes it (draft §6).
   */
  readonly resetSeconds: number;
  /**
   * 0 when allowed; else whole seconds until this policy allows the take (one of the same cost); when the cost is over
   * the policy's whole quota, which no wait allows, until the quota is whole again.
   */
  readonly retryAfterSeconds: number;
}

function checkPolicy<P extends BudgetPolicy>(p: P): P {
  if (!Number.isSafeInteger(p.q) || p.q < 1 || !Number.isSafeInteger(p.w) || p.w < 1 || (p.w * 1000) % p.q !== 0) {
    throw new RangeError(`policy ${p.name}: q and w must be positive integers and q must divide 1000 * w, so w/q is whole ms (got q=${p.q}, w=${p.w})`);
  }
  return p;
}

function intervalMs(policy: BudgetPolicy): number {
  return (checkPolicy(policy).w * 1000) / policy.q;
}

const ceilSeconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));

/** What `tatMs` leaves available at `nowMs`, without taking (GET /api/rate-limit reads this). */
export function gcraPeek(tatMs: number, nowMs: number, policy: BudgetPolicy): { remaining: number; resetSeconds: number } {
  const t = intervalMs(policy);
  const limit = policy.w * 1000;
  const backlog = Math.max(tatMs, nowMs) - nowMs;
  const remaining = Math.min(policy.q, Math.max(0, Math.floor((limit - backlog) / t)));
  return { remaining, resetSeconds: ceilSeconds(remaining > 0 ? backlog : backlog + t - limit) };
}

/** A take's cost: a whole number of requests, at least 1. */
function checkCost(cost: number): number {
  if (!Number.isSafeInteger(cost) || cost < 1) throw new RangeError(`a take costs a positive whole number of requests, not ${cost}`);
  return cost;
}

/**
 * Take `cost` requests (default 1) under `policy`, all or none. `tatMs` is the stored TAT (0 or anything past for a
 * fresh row).
 */
export function gcra(tatMs: number, nowMs: number, policy: BudgetPolicy, cost: number = 1): GcraResult {
  const t = intervalMs(policy);
  const limit = policy.w * 1000;
  const base = Math.max(tatMs, nowMs);
  const newTat = base + checkCost(cost) * t;
  const allowAt = newTat - limit;
  if (nowMs < allowAt) {
    // What is left without the take (none at cost 1; fewer than the cost above it). A cost over the whole quota is
    // never allowed: its Retry-After is until the quota is whole again, at least a second.
    const left = gcraPeek(tatMs, nowMs, policy);
    return { allowed: false, newTat: tatMs, ...left, retryAfterSeconds: cost > policy.q ? Math.max(1, left.resetSeconds) : ceilSeconds(allowAt - nowMs) };
  }
  const { remaining, resetSeconds } = gcraPeek(newTat, nowMs, policy);
  return { allowed: true, newTat, remaining, resetSeconds, retryAfterSeconds: 0 };
}

export interface PolicyResult extends GcraResult {
  readonly policy: BudgetPolicy;
}

/**
 * Take `cost` requests (default 1) under every policy of a row, all or nothing: one refusal keeps every TAT as it
 * was (the others then report what is available without the take). `tats[i]` belongs to `policies[i]`.
 */
export function gcraAll(
  tats: readonly number[],
  nowMs: number,
  policies: readonly BudgetPolicy[],
  cost: number = 1,
): { allowed: boolean; results: PolicyResult[]; violated: string[] } {
  const taken = policies.map((policy, i) => ({ ...gcra(tats[i] ?? 0, nowMs, policy, cost), policy }));
  const violated = taken.filter((r) => !r.allowed).map((r) => r.policy.name);
  if (violated.length === 0) return { allowed: true, results: taken, violated };
  const results = taken.map((r, i) => (r.allowed ? { ...r, ...gcraPeek(tats[i] ?? 0, nowMs, r.policy), newTat: tats[i] ?? 0 } : r));
  return { allowed: false, results, violated };
}

// ---- Headers -------------------------------------------------------------------------------------
// draft-ietf-httpapi-ratelimit-headers-11: RateLimit-Policy (§3) `"name";q=<int>;w=<int>` and
// RateLimit (§4) `"name";r=<int>;t=<int>`, each a Structured Fields List (RFC 9651). The X-RateLimit-*
// fields describe the binding policy: a refused one, else the one with the fewest requests left.

/** The policy the X-RateLimit-* fields describe. */
export function bindingResult<R extends PolicyResult>(results: readonly R[]): R | undefined {
  const binds = (a: R, b: R): boolean => {
    if (a.allowed !== b.allowed) return !a.allowed;
    if (!a.allowed) return a.retryAfterSeconds > b.retryAfterSeconds;
    return a.remaining < b.remaining || (a.remaining === b.remaining && a.resetSeconds > b.resetSeconds);
  };
  let best: R | undefined;
  for (const r of results) if (best === undefined || binds(r, best)) best = r;
  return best;
}

const sfString = (s: string): string => `"${s.replace(/[\\"]/g, '\\$&')}"`;

/**
 * The response headers for a lane's results (the lane names the tier; heavy is charged beside a base
 * lane, so pass that). Adds Retry-After when a policy refused.
 */
export function formatRateLimitHeaders(lane: Lane, results: readonly PolicyResult[], nowMs: number = Date.now()): Record<string, string> {
  const tier = laneTier(lane);
  if (tier === null) throw new RangeError(`lane ${lane} has no tier of its own: format with the caller's base lane`);
  const bind = bindingResult(results);
  if (bind === undefined) return {};
  const out: Record<string, string> = {
    'RateLimit-Policy': results.map((r) => `${sfString(r.policy.name)};q=${r.policy.q};w=${r.policy.w}`).join(', '),
    RateLimit: results.map((r) => `${sfString(r.policy.name)};r=${r.remaining};t=${r.resetSeconds}`).join(', '),
    'X-RateLimit-Limit': String(bind.policy.q),
    'X-RateLimit-Remaining': String(bind.remaining),
    'X-RateLimit-Reset': String(Math.ceil(nowMs / 1000) + bind.resetSeconds),
    'X-RateLimit-Resource': bind.policy.name,
    'X-RateLimit-Tier': tier,
  };
  if (!bind.allowed) out['Retry-After'] = String(bind.retryAfterSeconds);
  return out;
}

/** A fetch `Headers` (or anything with `get`), or a plain record such as Node's IncomingHttpHeaders. */
export type HeaderSource = { get(name: string): string | null } | { readonly [name: string]: string | readonly string[] | undefined };

function header(h: HeaderSource, name: string): string | null {
  if (typeof (h as { get?: unknown }).get === 'function') return (h as { get(name: string): string | null }).get(name);
  const rec = h as { readonly [name: string]: string | readonly string[] | undefined };
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() !== name) continue;
    const v = rec[k];
    return v === undefined ? null : typeof v === 'string' ? v : v.join(', ');
  }
  return null;
}

export interface ParsedPolicyItem {
  readonly name: string;
  readonly params: Readonly<Record<string, number | string | boolean>>;
}

/**
 * A Structured Fields List of String items with parameters (RFC 9651 §4.2.1, the subset the draft
 * uses). Lenient: a malformed member is skipped, the rest kept.
 */
export function parseSfPolicyList(value: string): ParsedPolicyItem[] {
  const out: ParsedPolicyItem[] = [];
  let i = 0;
  const ws = (): void => {
    while (value[i] === ' ' || value[i] === '\t') i++;
  };
  const str = (): string | null => {
    let s = '';
    for (i++; i < value.length; i++) {
      const c = value[i]!;
      if (c === '"') {
        i++;
        return s;
      }
      if (c === '\\') i++;
      s += value[i] ?? '';
    }
    return null;
  };
  const bare = (): number | string | boolean | null => {
    if (value[i] === '"') return str();
    const m = /^(?:-?\d+(?:\.\d+)?|\?[01]|:[A-Za-z0-9+/=]*:|[A-Za-z*][A-Za-z0-9_\-.:%*/!#$&'^`|~+]*)/.exec(value.slice(i));
    if (m === null) return null;
    i += m[0].length;
    const v = m[0];
    return v[0] === '?' ? v === '?1' : /^-?\d/.test(v) ? Number(v) : v;
  };
  const member = (): ParsedPolicyItem | null => {
    if (value[i] !== '"') return null;
    const name = str();
    if (name === null) return null;
    const params: Record<string, number | string | boolean> = {};
    while (value[i] === ';') {
      i++;
      ws();
      const key = /^[a-z*][a-z0-9_\-.*]*/.exec(value.slice(i))?.[0];
      if (key === undefined) return null;
      i += key.length;
      if (value[i] !== '=') {
        params[key] = true;
        continue;
      }
      i++;
      const v = bare();
      if (v === null) return null;
      params[key] = v;
    }
    ws();
    return i >= value.length || value[i] === ',' ? { name, params } : null;
  };
  // Past a bad member: on to the next comma outside a string.
  const skip = (): void => {
    for (let quoted = false; i < value.length; i++) {
      const c = value[i];
      if (quoted && c === '\\') i++;
      else if (c === '"') quoted = !quoted;
      else if (c === ',' && !quoted) return;
    }
  };
  while (i < value.length) {
    ws();
    if (i >= value.length) break;
    const item = member();
    if (item === null) skip();
    else out.push(item);
    i++; // the comma
  }
  return out;
}

export interface ParsedBudget {
  /** The binding policy's name (X-RateLimit-Resource), when known. */
  readonly policy: string | null;
  readonly tier: string | null;
  readonly limit: number;
  readonly remaining: number;
  /** Milliseconds until `resetSeconds` runs out, measured from the parse. */
  readonly resetMs: number;
  /** Every policy the IETF fields named, with what they said of it. */
  readonly policies: readonly { name: string; q: number | null; w: number | null; r: number | null; t: number | null }[];
}

const int = (s: string | null): number | null => (s !== null && /^\s*\d+\s*$/.test(s) ? Number(s) : null);
const num = (v: number | string | boolean | undefined): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * Read a response's budget: X-RateLimit-* first, the IETF fields second. The reset prefers the IETF
 * `t` (a delta, immune to clock skew) for the same policy over X-RateLimit-Reset (epoch seconds).
 * Null when nothing is there, or on a cached answer (Age > 0): draft §7.3, the fields "SHOULD be
 * ignored on responses that come from cache".
 */
export function parseRateLimitHeaders(headers: HeaderSource, nowMs: number = Date.now()): ParsedBudget | null {
  const age = int(header(headers, 'age'));
  if (age !== null && age > 0) return null;

  const policyItems = parseSfPolicyList(header(headers, 'ratelimit-policy') ?? '');
  const limitItems = parseSfPolicyList(header(headers, 'ratelimit') ?? '');
  const names = [...new Set([...policyItems, ...limitItems].map((p) => p.name))];
  const policies = names.map((name) => {
    const p = policyItems.find((x) => x.name === name)?.params ?? {};
    const l = limitItems.find((x) => x.name === name)?.params ?? {};
    return { name, q: num(p.q), w: num(p.w), r: num(l.r), t: num(l.t) };
  });

  const xLimit = int(header(headers, 'x-ratelimit-limit'));
  const xRemaining = int(header(headers, 'x-ratelimit-remaining'));
  const xReset = int(header(headers, 'x-ratelimit-reset'));
  const xResource = header(headers, 'x-ratelimit-resource')?.trim() || null;
  const tier = header(headers, 'x-ratelimit-tier')?.trim() || null;

  if (xLimit !== null && xRemaining !== null) {
    const t = policies.find((p) => p.name === xResource)?.t ?? null;
    const resetMs = t !== null ? t * 1000 : xReset !== null ? Math.max(0, xReset * 1000 - nowMs) : 0;
    return { policy: xResource, tier, limit: xLimit, remaining: xRemaining, resetMs, policies };
  }

  // IETF only: the binding policy is the one with the fewest left, then the longest wait.
  let bind: (typeof policies)[number] | undefined;
  for (const p of policies) {
    if (p.q === null || p.r === null) continue;
    if (bind === undefined || p.r < bind.r! || (p.r === bind.r && (p.t ?? 0) > (bind.t ?? 0))) bind = p;
  }
  if (bind === undefined) return null;
  return { policy: bind.name, tier, limit: bind.q!, remaining: bind.r!, resetMs: (bind.t ?? 0) * 1000, policies };
}

// ---- Pacing --------------------------------------------------------------------------------------

/**
 * The next poll's delay: `pollMs`, unless under a tenth of the limit is left, then the reset spread over
 * what remains (and never sooner than `pollMs`).
 */
export function pacingDelayMs(pollMs: number, budget: Pick<ParsedBudget, 'limit' | 'remaining' | 'resetMs'> | null | undefined): number {
  if (budget == null || budget.remaining >= budget.limit * 0.1) return pollMs;
  return Math.max(pollMs, Math.ceil(budget.resetMs / Math.max(budget.remaining, 1)));
}
