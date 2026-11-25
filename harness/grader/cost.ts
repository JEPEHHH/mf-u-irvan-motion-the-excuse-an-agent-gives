// The score's `cost` (contracts/score.ts Cost): what building the entry cost, from its priced usage
// lines (one per assistant message; the usage_line table). A pure function of the lines and the
// provenance of their sessions, independent of line order:
//
//   lines              every usage line; unpriced / partial / inconsistent count the flagged ones
//   priced_micro_usd   sum over the priced lines
//   micro_usd          that sum, or null (unpriced: an unknown cost is never $0) when
//                        - any line is unpriced, or
//                        - no priced line reports usage (no line at all: no transcript, a
//                          transcript-less baseline; or only lines whose token counts are all 0), or
//                        - any transcript session reports no usage (opts.sessions: a session none
//                          of whose lines carries a token), since its cost cannot be known
//   tokens             token totals over every line (priced or not)
//   models             per model (code-unit order): lines, tokens, and micro_usd (null as soon as one
//                      of its lines is unpriced)
//   provenance         the weakest tier among the sessions: self-reported < agent-log; `none` with no
//                      transcript session at all
//
// Every line must carry the same pricing_rev, which becomes cost.pricing_rev. repriceCostLines re-derives
// each line's cost from its token counts under a given rows document (createPricer(doc) for a stored
// pricing_rev), for a regrade that re-prices instead of trusting the stored figures.

import type { CostT } from '../contracts/score.ts';
import type { Pricer } from '../pricing/price.ts';
import type { usageLine } from '../server/db/schema.ts';
import { compareCodeUnits } from '../sim/canonical.ts';

export type Provenance = CostT['provenance'];

export interface CostLine {
  model: string;
  /** The line's own timestamp (ISO-8601). */
  at: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  reasoning: number;
  /** micro-USD as a u64 decimal string; null = unpriced. */
  micro_usd: string | null;
  pricing_rev: string;
  partial: boolean;
  inconsistent: boolean;
  /** The transcript session the line belongs to (usage_line.session_id); required when computeCost is given opts.sessions. */
  session?: string;
}

export interface CostOptions {
  /** The rows document the lines were priced under (cost.pricing_rev; used when there are no lines). */
  pricingRev: string;
  provenance: Provenance;
  /**
   * Every transcript session of the submission (transcript_session ids). When given, each line must
   * name one of them, and a session none of whose lines reports any token makes the cost unpriced.
   */
  sessions?: readonly string[];
}

export class CostInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostInputError';
  }
}

const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'reasoning'] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];

const zeroTokens = (): Record<TokenKey, bigint> => ({ input: 0n, output: 0n, cache_read: 0n, cache_write_5m: 0n, cache_write_1h: 0n, reasoning: 0n });
const tokenStrings = (t: Record<TokenKey, bigint>) =>
  Object.fromEntries(TOKEN_KEYS.map((k) => [k, t[k].toString()])) as Record<TokenKey, string>;

function count(n: number, what: string): bigint {
  if (!Number.isSafeInteger(n) || n < 0) throw new CostInputError(`${what} ${n} is not a non-negative integer`);
  return BigInt(n);
}

function micro(s: string | null, what: string): bigint | null {
  if (s === null) return null;
  if (!/^(0|[1-9][0-9]{0,19})$/.test(s)) throw new CostInputError(`${what} ${JSON.stringify(s)} is not a u64 decimal`);
  return BigInt(s);
}

/** The weakest provenance tier among a submission's sessions. */
export function provenanceOf(tiers: readonly ('agent-log' | 'self-reported')[]): Provenance {
  if (tiers.length === 0) return 'none';
  return tiers.includes('self-reported') ? 'self-reported' : 'agent-log';
}

/** Cost from usage lines (see the header for when the total is null). */
export function computeCost(lines: readonly CostLine[], opts: CostOptions): CostT {
  if (opts.pricingRev.length === 0) throw new CostInputError('pricing_rev is empty');
  const total = zeroTokens();
  let priced = 0n;
  let unpriced = 0;
  let partial = 0;
  let inconsistent = 0;
  let pricedWithUsage = 0;
  const models = new Map<string, { lines: number; micro: bigint; unpriced: boolean; tokens: Record<TokenKey, bigint> }>();
  // Per session (when given): whether any of its lines reports a token.
  const sessionUsage = opts.sessions === undefined ? null : new Map(opts.sessions.map((s) => [s, false]));
  lines.forEach((l, i) => {
    if (l.pricing_rev !== opts.pricingRev) throw new CostInputError(`usage line ${i} is priced under ${l.pricing_rev}, not ${opts.pricingRev}`);
    if (l.model.length === 0) throw new CostInputError(`usage line ${i} names no model`);
    const cost = micro(l.micro_usd, `usage line ${i} micro_usd`);
    let m = models.get(l.model);
    if (m === undefined) {
      m = { lines: 0, micro: 0n, unpriced: false, tokens: zeroTokens() };
      models.set(l.model, m);
    }
    m.lines += 1;
    let used = false;
    for (const k of TOKEN_KEYS) {
      const n = count(l[k], `usage line ${i} ${k}`);
      total[k] += n;
      m.tokens[k] += n;
      if (n > 0n) used = true;
    }
    if (sessionUsage !== null) {
      if (l.session === undefined || !sessionUsage.has(l.session)) throw new CostInputError(`usage line ${i} names no session of the submission (${JSON.stringify(l.session ?? null)})`);
      if (used) sessionUsage.set(l.session, true);
    }
    if (cost === null) {
      unpriced += 1;
      m.unpriced = true;
    } else {
      priced += cost;
      m.micro += cost;
      if (used) pricedWithUsage += 1;
    }
    if (l.partial) partial += 1;
    if (l.inconsistent) inconsistent += 1;
  });
  const silentSession = sessionUsage !== null && [...sessionUsage.values()].some((reported) => !reported);
  const fullyPriced = unpriced === 0 && pricedWithUsage > 0 && !silentSession;
  return {
    pricing_rev: opts.pricingRev,
    micro_usd: fullyPriced ? priced.toString() : null,
    priced_micro_usd: priced.toString(),
    lines: lines.length,
    unpriced_lines: unpriced,
    partial_lines: partial,
    inconsistent_lines: inconsistent,
    tokens: tokenStrings(total),
    models: [...models.entries()]
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([model, m]) => ({ model, lines: m.lines, micro_usd: m.unpriced ? null : m.micro.toString(), tokens: tokenStrings(m.tokens) })),
    provenance: opts.provenance,
  };
}

/** CostLines from usage_line rows (server/db/schema.ts). */
export function costLinesFromRows(rows: ReadonlyArray<typeof usageLine.$inferSelect>): CostLine[] {
  return rows.map((r) => ({
    model: r.model,
    at: r.at.toISOString(),
    input: r.input,
    output: r.output,
    cache_read: r.cacheRead,
    cache_write_5m: r.cacheWrite5m,
    cache_write_1h: r.cacheWrite1h,
    reasoning: r.reasoning,
    micro_usd: r.costMicroUsd === null ? null : r.costMicroUsd.toString(),
    pricing_rev: r.pricingRev,
    partial: r.partial,
    inconsistent: r.inconsistent,
    session: r.sessionId,
  }));
}

/** Re-price every line from its token counts under `pricer` (its pricing_rev replaces the lines'). */
export function repriceCostLines(lines: readonly CostLine[], pricer: Pick<Pricer, 'pricingRev' | 'priceUsage'>): CostLine[] {
  return lines.map((l) => {
    const priced = pricer.priceUsage({
      model: l.model,
      at: l.at,
      format: 'tokens',
      usage: { input: l.input, output: l.output, cache_read: l.cache_read, cache_write_5m: l.cache_write_5m, cache_write_1h: l.cache_write_1h, reasoning: l.reasoning },
    });
    return {
      ...l,
      micro_usd: priced.microUsd === null ? null : priced.microUsd.toString(),
      pricing_rev: pricer.pricingRev,
      partial: l.partial || priced.partial,
      inconsistent: l.inconsistent || priced.inconsistent,
    };
  });
}
