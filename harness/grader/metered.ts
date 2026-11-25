// The score's `cost` (contracts/score.ts Cost) under a bundle with a build meter (contracts/competition.ts
// BuildMeter, plan #38): what the house's own masq meter saw the entrant spend building, vouched for line by line
// against the entry's transcripts. Pure, deterministic and BigInt: a function of the entry's usage lines (usage_line),
// its transcript sessions, the entrant's metered requests (metered_request, stored by server/metering/sync.ts before
// any grade counts them) and the instant they are counted through, whatever order each comes in.
//
//   matchMeteredLines   one usage line to one metered request, each request vouching for at most one line, in two
//                       passes:
//                         1. by id: the request's upstream_response_id is the line's message_id (the vendor reply's
//                            own id: transcripts/claude.ts keys a Claude Code usage line by its message.id, an
//                            Anthropic msg_… id, which masq records as the upstream response id);
//                         2. else by tokens: the same model (the request's resolved model, or the one its caller
//                            named), equal input, output and cache_read, cache_write_5m + cache_write_1h equal to
//                            the request's cache_creation (masq counts both cache-write lifetimes as one), and the
//                            line's timestamp within MATCH_WINDOW_MS (10 minutes) of the request's.
//                       Each pass takes its candidate pairs nearest in time first (|line.at − request.ts|), a tie
//                       going to the lower masq request id, then to the line first in canonical order (by at,
//                       message_id, session, model, then its tokens), each line and each request taken once.
//   meteredCostOf       the Cost of the requests at or before `through` (the entry's receipt: its submission's
//                       created_at), the lines matched against those alone:
//     micro_usd           Σ their list cost (exact µUSD: masq's 6-decimal list price), or null (never $0) when
//                           - the meter did not vouch for the entry (provenance below is not metered: a usage line no
//                             counted request matches, a session reporting no usage, or no transcript at all), or
//                           - a request reporting tokens is priced $0 or by masq's fallback rate (masq prices a model
//                             it does not know at $0: such a request's cost is unknown), or
//                           - no counted request reports a token (nothing was metered)
//     lines               the requests counted (each request is one of the meter's lines); unpriced_lines those
//                         reporting tokens priced $0 or by fallback; priced_micro_usd Σ over the rest; partial_lines
//                         and inconsistent_lines 0 (the counts are masq's own, never a transcript's)
//     tokens              summed over the requests counted; masq's cache_creation goes in cache_write_5m (masq
//                         counts the two cache-write lifetimes as one), cache_write_1h is 0
//     models              per request model (masq's resolved model, else the one named), in code-unit order: its
//                         requests, their tokens, and their list cost (null as soon as one of them is unpriced)
//     provenance          `metered` when the meter vouched for the entry: it has a transcript session, every
//                         session reports usage (a session none of whose lines carries a token cannot be vouched
//                         for, as cost.ts makes such a cost unpriced) and every usage line matched a counted
//                         request; else the sessions' own tier (cost.ts provenanceOf); `none` with no session
//     metered             {requests, through, unmetered_lines}: the requests counted, the instant, and the usage
//                         lines no counted request vouches for; grader/entry-cost.ts then adds requests_sha256,
//                         the blob listing the counted masq ids, which a regrade prices from exactly
//     pricing_rev         METERED_PRICING_REV ('masq-list'): masq's list prices, not a pricing/ rows document

import type { CostT } from '../contracts/score.ts';
import { compareCodeUnits } from '../sim/canonical.ts';
import { CostInputError, provenanceOf } from './cost.ts';

/** A metered cost's pricing_rev: masq's own list prices (each request's list_cost_micro_usd), not a pricing/ rows document. */
export const METERED_PRICING_REV = 'masq-list';

/** How far apart a usage line and a metered request may be stamped for a match by tokens (the header's pass 2). */
export const MATCH_WINDOW_MS = 10 * 60_000;

/** One transcript usage line (usage_line) as the meter reads it. */
export interface MeteredLine {
  /** The assistant message's id (usage_line.message_id): an Anthropic msg_… id, or a Codex event index. */
  message_id: string;
  model: string;
  /** The line's own timestamp (ISO-8601). */
  at: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  reasoning: number;
  /** Its transcript session (usage_line.session_id): one of meteredCostOf's sessions. */
  session: string;
}

/** One request masq metered on one of the entrant's build keys (metered_request). */
export interface MeteredRequest {
  /** masq's request id (metered_request.masq_request_id): unique, and the match's tie-break. */
  id: number;
  /** masq's instant of the request (ISO-8601). */
  ts: string;
  /** The model the caller named. */
  model_requested: string;
  /** The model masq sent it to (its resolved model, else model_requested). */
  model: string;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  /** Both cache-write lifetimes together. */
  cache_creation: number;
  /** masq's list price of it, exact µUSD. */
  list_cost_micro_usd: bigint;
  /** masq priced it by a fallback rate, or could not price it. */
  pricing_fallback: boolean;
  /** The vendor reply's own id (an Anthropic msg_… id), when masq recorded one. */
  upstream_response_id: string | null;
}

/** One transcript session of the entry (transcript_session): its id and its provenance tier. */
export interface MeteredSession {
  id: string;
  provenance: 'agent-log' | 'self-reported';
}

/** How a usage line was matched: by the vendor's reply id, or by its model, tokens and time. */
export type MeteredMatchKind = 'id' | 'tokens';

/** A usage line's match (matchMeteredLines): the masq request id that vouches for it, and how; both null when none does. */
export interface MeteredLineMatch {
  request: number | null;
  by: MeteredMatchKind | null;
}

function count(n: number, what: string): bigint {
  if (!Number.isSafeInteger(n) || n < 0) throw new CostInputError(`${what} ${n} is not a non-negative integer`);
  return BigInt(n);
}

function instant(iso: string, what: string): number {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) throw new CostInputError(`${what} ${JSON.stringify(iso)} is not an instant`);
  return ms;
}

/** A line, checked: its instant in ms and its token counts. */
interface Line {
  index: number;
  src: MeteredLine;
  at: number;
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  /** The tokens pass's key: input, output, cache_read and both cache writes together. */
  key: string;
  /** Any token at all (a session reporting usage). */
  used: boolean;
}

/** A request, checked: its instant in ms and its token counts. */
interface Request {
  index: number;
  src: MeteredRequest;
  ts: number;
  tokens: { input: bigint; output: bigint; reasoning: bigint; cacheRead: bigint; cacheCreation: bigint };
  key: string;
  /** It reports a token. */
  used: boolean;
}

function checkLines(lines: readonly MeteredLine[]): Line[] {
  return lines.map((l, i) => {
    const what = `usage line ${i}`;
    if (typeof l.message_id !== 'string' || l.message_id.length === 0) throw new CostInputError(`${what} names no message id`);
    if (typeof l.model !== 'string' || l.model.length === 0) throw new CostInputError(`${what} names no model`);
    const input = count(l.input, `${what} input`);
    const output = count(l.output, `${what} output`);
    const cacheRead = count(l.cache_read, `${what} cache_read`);
    const cacheWrite = count(l.cache_write_5m, `${what} cache_write_5m`) + count(l.cache_write_1h, `${what} cache_write_1h`);
    const reasoning = count(l.reasoning, `${what} reasoning`);
    return {
      index: i,
      src: l,
      at: instant(l.at, `${what} at`),
      input,
      output,
      cacheRead,
      cacheWrite,
      key: `${input}:${output}:${cacheRead}:${cacheWrite}`,
      used: input + output + cacheRead + cacheWrite + reasoning > 0n,
    };
  });
}

function checkRequests(requests: readonly MeteredRequest[]): Request[] {
  const ids = new Set<number>();
  return requests.map((r, i) => {
    const what = `metered request ${i}`;
    if (!Number.isSafeInteger(r.id) || r.id < 0) throw new CostInputError(`${what} has id ${r.id}, not masq's request id`);
    if (ids.has(r.id)) throw new CostInputError(`masq request ${r.id} is given twice`);
    ids.add(r.id);
    if (typeof r.model !== 'string' || r.model.length === 0) throw new CostInputError(`${what} (masq ${r.id}) names no model`);
    if (typeof r.list_cost_micro_usd !== 'bigint' || r.list_cost_micro_usd < 0n) throw new CostInputError(`${what} (masq ${r.id}) has list cost ${String(r.list_cost_micro_usd)}, not a µUSD amount`);
    const tokens = {
      input: count(r.input, `${what} input`),
      output: count(r.output, `${what} output`),
      reasoning: count(r.reasoning, `${what} reasoning`),
      cacheRead: count(r.cache_read, `${what} cache_read`),
      cacheCreation: count(r.cache_creation, `${what} cache_creation`),
    };
    return {
      index: i,
      src: r,
      ts: instant(r.ts, `${what} ts`),
      tokens,
      key: `${tokens.input}:${tokens.output}:${tokens.cacheRead}:${tokens.cacheCreation}`,
      used: tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheCreation > 0n,
    };
  });
}

/** The lines' canonical order (the header's tie-break after the request id): by at, message_id, session, model, then tokens; input order last (only lines alike in all of these tie, and either may take the request). */
function lineRanks(lines: readonly Line[]): number[] {
  const order = [...lines].sort(
    (a, b) =>
      a.at - b.at ||
      compareCodeUnits(a.src.message_id, b.src.message_id) ||
      compareCodeUnits(a.src.session, b.src.session) ||
      compareCodeUnits(a.src.model, b.src.model) ||
      compareBig(a.input, b.input) ||
      compareBig(a.output, b.output) ||
      compareBig(a.cacheRead, b.cacheRead) ||
      compareBig(a.cacheWrite, b.cacheWrite) ||
      a.index - b.index,
  );
  const rank = new Array<number>(lines.length);
  order.forEach((l, pos) => {
    rank[l.index] = pos;
  });
  return rank;
}

const compareBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

interface Pair {
  line: number;
  request: number;
  distance: number;
}

/** Take `pairs` nearest first (a tie to the lower masq request id, then the line first in canonical order), each line and request once. */
function takePairs(pairs: Pair[], requests: readonly Request[], rank: readonly number[], kind: MeteredMatchKind, out: MeteredLineMatch[], taken: Set<number>): void {
  pairs.sort((a, b) => a.distance - b.distance || requests[a.request]!.src.id - requests[b.request]!.src.id || rank[a.line]! - rank[b.line]!);
  for (const p of pairs) {
    if (out[p.line]!.request !== null || taken.has(p.request)) continue;
    out[p.line] = { request: requests[p.request]!.src.id, by: kind };
    taken.add(p.request);
  }
}

function matchChecked(lines: readonly Line[], requests: readonly Request[]): MeteredLineMatch[] {
  const out: MeteredLineMatch[] = lines.map(() => ({ request: null, by: null }));
  if (lines.length === 0 || requests.length === 0) return out;
  const rank = lineRanks(lines);
  const taken = new Set<number>();

  // 1. By id: the vendor reply's id is the line's message id.
  const byResponse = new Map<string, number[]>();
  for (const r of requests) {
    const id = r.src.upstream_response_id;
    if (id === null || id === undefined || id.length === 0) continue;
    const list = byResponse.get(id);
    if (list === undefined) byResponse.set(id, [r.index]);
    else list.push(r.index);
  }
  const exact: Pair[] = [];
  for (const l of lines) {
    for (const ri of byResponse.get(l.src.message_id) ?? []) exact.push({ line: l.index, request: ri, distance: Math.abs(l.at - requests[ri]!.ts) });
  }
  takePairs(exact, requests, rank, 'id', out, taken);

  // 2. By tokens: the same model, the same counts, within the window; among the requests still free.
  const byKey = new Map<string, Request[]>();
  for (const r of requests) {
    if (taken.has(r.index)) continue;
    const list = byKey.get(r.key);
    if (list === undefined) byKey.set(r.key, [r]);
    else list.push(r);
  }
  for (const list of byKey.values()) list.sort((a, b) => a.ts - b.ts || a.src.id - b.src.id);
  const tolerant: Pair[] = [];
  for (const l of lines) {
    if (out[l.index]!.request !== null) continue;
    const list = byKey.get(l.key);
    if (list === undefined) continue;
    // The first request stamped at or after the window's start, then on to its end.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid]!.ts < l.at - MATCH_WINDOW_MS) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < list.length && list[i]!.ts <= l.at + MATCH_WINDOW_MS; i++) {
      const r = list[i]!;
      if (r.src.model !== l.src.model && r.src.model_requested !== l.src.model) continue;
      tolerant.push({ line: l.index, request: r.index, distance: Math.abs(l.at - r.ts) });
    }
  }
  takePairs(tolerant, requests, rank, 'tokens', out, taken);
  return out;
}

/**
 * Each usage line's match among `requests` (the header's two passes), in the lines' order: the masq request id that
 * vouches for it, and how, or nulls when none does. Each request vouches for one line at most. Throws CostInputError
 * on a malformed line or request (a count that is no non-negative integer, a time that is no instant, a masq request
 * id given twice).
 */
export function matchMeteredLines(lines: readonly MeteredLine[], requests: readonly MeteredRequest[]): MeteredLineMatch[] {
  return matchChecked(checkLines(lines), checkRequests(requests));
}

const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'reasoning'] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];
const zeroTokens = (): Record<TokenKey, bigint> => ({ input: 0n, output: 0n, cache_read: 0n, cache_write_5m: 0n, cache_write_1h: 0n, reasoning: 0n });
const tokenStrings = (t: Record<TokenKey, bigint>) => Object.fromEntries(TOKEN_KEYS.map((k) => [k, t[k].toString()])) as Record<TokenKey, string>;

/**
 * The metered cost of an entry (the header): `requests` (the entrant's metered requests in the competition) counted at
 * or before `through` (the entry's receipt), `lines` (its usage lines) matched against those, `sessions` (its transcript
 * sessions) for the provenance. Every line must name one of the sessions. Throws CostInputError on malformed input.
 */
export function meteredCostOf(lines: readonly MeteredLine[], requests: readonly MeteredRequest[], through: Date | string, sessions: readonly MeteredSession[]): CostT {
  const throughMs = through instanceof Date ? through.getTime() : instant(through, 'through');
  if (!Number.isFinite(throughMs)) throw new CostInputError('through is not an instant');
  const checkedLines = checkLines(lines);
  const counted = checkRequests(requests)
    .filter((r) => r.ts <= throughMs)
    .map((r, i) => ({ ...r, index: i }));

  // Every session of the entry, and whether any of its lines reports a token.
  const reports = new Map<string, boolean>();
  for (const s of sessions) {
    if (typeof s.id !== 'string' || s.id.length === 0) throw new CostInputError('a transcript session has no id');
    if (reports.has(s.id)) throw new CostInputError(`transcript session ${s.id} is given twice`);
    if (s.provenance !== 'agent-log' && s.provenance !== 'self-reported') throw new CostInputError(`transcript session ${s.id} has provenance ${JSON.stringify(s.provenance)}`);
    reports.set(s.id, false);
  }
  for (const l of checkedLines) {
    if (!reports.has(l.src.session)) throw new CostInputError(`usage line ${l.index} names no session of the submission (${JSON.stringify(l.src.session ?? null)})`);
    if (l.used) reports.set(l.src.session, true);
  }

  const matches = matchChecked(checkedLines, counted);
  const unmetered = matches.filter((m) => m.request === null).length;
  const silent = [...reports.values()].some((reported) => !reported);
  const vouched = sessions.length > 0 && unmetered === 0 && !silent;

  const total = zeroTokens();
  let all = 0n;
  let priced = 0n;
  let unpriced = 0;
  let reported = false;
  const models = new Map<string, { lines: number; micro: bigint; unpriced: boolean; tokens: Record<TokenKey, bigint> }>();
  for (const r of counted) {
    const t: Record<TokenKey, bigint> = {
      input: r.tokens.input,
      output: r.tokens.output,
      cache_read: r.tokens.cacheRead,
      cache_write_5m: r.tokens.cacheCreation,
      cache_write_1h: 0n,
      reasoning: r.tokens.reasoning,
    };
    let m = models.get(r.src.model);
    if (m === undefined) {
      m = { lines: 0, micro: 0n, unpriced: false, tokens: zeroTokens() };
      models.set(r.src.model, m);
    }
    m.lines += 1;
    for (const k of TOKEN_KEYS) {
      total[k] += t[k];
      m.tokens[k] += t[k];
    }
    const cost = r.src.list_cost_micro_usd;
    all += cost;
    m.micro += cost;
    // A request with tokens priced $0 (a model masq does not know) or by masq's fallback rate: its cost is unknown.
    if (r.used && (cost === 0n || r.src.pricing_fallback)) {
      unpriced += 1;
      m.unpriced = true;
    } else {
      priced += cost;
    }
    if (r.used) reported = true;
  }
  const known = vouched && unpriced === 0 && reported;
  return {
    pricing_rev: METERED_PRICING_REV,
    micro_usd: known ? all.toString() : null,
    priced_micro_usd: priced.toString(),
    lines: counted.length,
    unpriced_lines: unpriced,
    partial_lines: 0,
    inconsistent_lines: 0,
    tokens: tokenStrings(total),
    models: [...models.entries()]
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([model, m]) => ({ model, lines: m.lines, micro_usd: m.unpriced ? null : m.micro.toString(), tokens: tokenStrings(m.tokens) })),
    provenance: sessions.length === 0 ? 'none' : vouched ? 'metered' : provenanceOf(sessions.map((s) => s.provenance)),
    metered: { requests: counted.length, through: new Date(throughMs).toISOString(), unmetered_lines: unmetered },
  };
}
