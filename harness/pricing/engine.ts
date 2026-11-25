// The pricer: frozen pricing rows in, one transcript line's list-price cost out, in BigInt
// micro-USD. Pure — no clock, no I/O, no module state — so the same (rows, model, at, usage)
// prices to the same figure on every machine. price.ts binds it to the bundled rows.json; the
// grader can bind it to the rows a stored score was priced under (`createPricer(doc)`).
//
// Rates are integers in micro-USD per million tokens (a vendor's "$ per MTok" times 1e6), so a
// line's exact cost is Σ tokens × rate in units of 1e-12 USD, rounded once, half up, to micro-USD.

import { z } from 'zod';
import { canonicalSha256 } from '../sim/canonical.ts';
import { compileGrammar, matchRow } from './model-match.ts';

export const PRICING_ROWS_SCHEMA = 'agent-fun/pricing-rows/v1';
export const RATE_UNIT = 'micro_usd_per_mtok';

const Rate = z.int().min(0);
const Instant = z.iso.datetime({ offset: false, precision: 3 });
const Pattern = z.strictObject({ source: z.string().min(1), flags: z.string().regex(/^[imsu]*$/) });

const Rates = z.strictObject({
  input: Rate,
  output: Rate,
  cache_write_5m: Rate,
  cache_write_1h: Rate,
  cache_read: Rate,
  /** Audio tokens priced apart from text; null bills audio at the text rates. */
  audio: z.strictObject({ input: Rate, output: Rate }).nullable(),
});

const Period = z.strictObject({
  /** Inclusive start (UTC instant), null = since the beginning. */
  effective_from: Instant.nullable(),
  /** Exclusive end (UTC instant), null = open-ended. */
  effective_to: Instant.nullable(),
  base: Rates,
  /** Past `over_tokens` of prompt (`strict`: over; else at or over) the WHOLE request reprices. */
  long_context: z.strictObject({ over_tokens: z.int().min(0), strict: z.boolean(), rates: Rates }).nullable(),
});

const Row = z.strictObject({ match: Pattern, periods: z.array(Period).min(1) });

const Aliases = z.strictObject({
  flagships: z.array(z.strictObject({ family: z.string().min(1), model: z.string().min(1), row: z.int().min(0) })),
  alias_families: z.array(z.string().min(1)),
  wire_families: z.array(z.string().min(1)),
  decoration_words: z.array(z.string().min(1)),
  decoration_separators: z.array(z.string().min(1)),
  provider_prefix: Pattern,
  gateway_ids: z.array(z.string().min(1)),
});

const Source = z.strictObject({
  repo: z.string().min(1),
  path: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  committed_at: z.iso.datetime({ offset: true }),
  ported_by: z.string().min(1),
  /** The cited override layer merged over the source rows (pricing/overrides.ts): file, sha256 of its bytes, row count. */
  overrides: z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), rows: z.int().min(1) }).optional(),
});

export const PricingRowsDoc = z.strictObject({
  schema: z.literal(PRICING_ROWS_SCHEMA),
  rate_unit: z.literal(RATE_UNIT),
  /** Provenance only: outside pricing_rev, so a re-port with identical rows keeps its rev. */
  source: Source,
  rows: z.array(Row).min(1),
  aliases: Aliases,
});

export type PricingRowsDocT = z.infer<typeof PricingRowsDoc>;
export type RatesT = z.infer<typeof Rates>;
export type PeriodT = z.infer<typeof Period>;

/**
 * sha256 (lowercase hex) of the RFC 8785 canonical JSON (sim/canonical.ts, the one implementation
 * every digest uses) of everything that decides a price: the schema tag, the rate unit, the rows
 * and the alias grammar. `source` (which cosmos commit the rows were read from) is provenance and
 * stays out, so a re-port that changes no rate keeps the rev and an old score still regrades byte
 * for byte. Every number in it is a safe integer (the schema's z.int()), so each has one spelling.
 */
export function pricingRevOf(doc: PricingRowsDocT): string {
  const priced = { schema: doc.schema, rate_unit: doc.rate_unit, rows: doc.rows, aliases: doc.aliases };
  return canonicalSha256(priced);
}

/** The usage shapes a transcript line can carry. */
export type UsageFormat = 'anthropic' | 'openai' | 'tokens';

/** Normalised token classes; every one is disjoint except the subsets named below. */
export interface TokenCounts {
  /** Uncached, unwritten input. */
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  /** The reasoning/thinking SUBSET of `output`: reported, billed inside output at its rate. */
  reasoning: number;
  /** The audio SUBSET of `input`. */
  audio_input: number;
  /** The audio SUBSET of `output`. */
  audio_output: number;
}

export interface NormalizedUsage {
  tokens: TokenCounts;
  /** The usage reported something the rows do not price (or did not say how to split it). */
  partial: boolean;
  /** The usage contradicts itself (a subset past its total, a total that does not add up). */
  inconsistent: boolean;
  /** Why, in detection order: `partial:<what>` / `inconsistent:<what>`. */
  reasons: string[];
}

export interface PriceUsageArgs {
  model: string;
  /** The line's OWN timestamp: a Date, epoch ms, or an ISO-8601 string with `Z` or an offset. */
  at: Date | number | string;
  format: UsageFormat;
  /** The usage object as the transcript carries it (see normalizeUsage). */
  usage: unknown;
}

export interface PricedUsage extends NormalizedUsage {
  /** List-price cost of this ONE request; null when the model has no row (never 0n for unknown). */
  microUsd: bigint | null;
  /** Which tier billed it; null when unpriced. */
  tier: 'base' | 'long_context' | null;
  pricingRev: string;
}

export interface Pricer {
  doc: PricingRowsDocT;
  pricingRev: string;
  /** The row index `model` bills on, or null. */
  resolveRow(model: string): number | null;
  /** The period of row `row` in force at `at`. */
  periodAt(row: number, at: Date | number | string): PeriodT;
  priceUsage(args: PriceUsageArgs): PricedUsage;
}

interface CompiledPeriod {
  from: number;
  to: number;
  period: PeriodT;
}

/** Validate a rows document and bind a pricer to it. Throws on any malformed or gapped table. */
export function createPricer(input: unknown): Pricer {
  const doc = PricingRowsDoc.parse(input);
  const patterns = doc.rows.map((r, i) => {
    try {
      return new RegExp(r.match.source, r.match.flags);
    } catch (err) {
      throw new Error(`pricing rows: row ${i} pattern does not compile: ${(err as Error).message}`);
    }
  });
  const periods = doc.rows.map((r, i) => compilePeriods(r.periods, i));
  const families = new Set<string>();
  for (const f of doc.aliases.flagships) {
    if (families.has(f.family)) throw new Error(`pricing rows: flagship family ${f.family} listed twice`);
    families.add(f.family);
    if (f.row >= doc.rows.length) throw new Error(`pricing rows: flagship ${f.family} names row ${f.row}, past the table`);
  }
  try {
    new RegExp(doc.aliases.provider_prefix.source, doc.aliases.provider_prefix.flags);
  } catch (err) {
    throw new Error(`pricing rows: provider_prefix does not compile: ${(err as Error).message}`);
  }
  const grammar = compileGrammar(doc.aliases);
  const pricingRev = pricingRevOf(doc);

  const resolveRow = (model: string): number | null => {
    if (typeof model !== 'string') throw new TypeError('priceUsage: model must be a string');
    return matchRow(model, patterns, grammar);
  };

  const periodAt = (row: number, at: Date | number | string): PeriodT => {
    const ms = instantMs(at);
    const list = periods[row];
    if (!list) throw new RangeError(`pricing rows: no row ${row}`);
    // Contiguous and covering by construction (compilePeriods), so exactly one holds.
    return list.find((p) => ms >= p.from && ms < p.to)!.period;
  };

  const priceUsage = (args: PriceUsageArgs): PricedUsage => {
    if (args === null || typeof args !== 'object') throw new TypeError('priceUsage: expected {model, at, format, usage}');
    const ms = instantMs(args.at);
    const normalized = normalizeUsage(args.format, args.usage);
    const row = resolveRow(args.model);
    if (row === null) return { ...normalized, microUsd: null, tier: null, pricingRev };
    const period = periods[row]!.find((p) => ms >= p.from && ms < p.to)!.period;
    const { microUsd, tier } = costOf(period, normalized.tokens);
    return { ...normalized, microUsd, tier, pricingRev };
  };

  return { doc, pricingRev, resolveRow, periodAt, priceUsage };
}

function compilePeriods(list: PeriodT[], row: number): CompiledPeriod[] {
  const out: CompiledPeriod[] = [];
  list.forEach((period, i) => {
    const from = period.effective_from === null ? -Infinity : parseIsoInstant(period.effective_from)!;
    const to = period.effective_to === null ? Infinity : parseIsoInstant(period.effective_to)!;
    if (i === 0 && period.effective_from !== null) throw new Error(`pricing rows: row ${row} starts at ${period.effective_from}, not open`);
    if (i === list.length - 1 && period.effective_to !== null) throw new Error(`pricing rows: row ${row} ends at ${period.effective_to}, not open`);
    if (i > 0 && period.effective_from !== list[i - 1]!.effective_to) {
      throw new Error(`pricing rows: row ${row} period ${i} does not start where period ${i - 1} ends`);
    }
    if (!(from < to)) throw new Error(`pricing rows: row ${row} period ${i} is empty`);
    out.push({ from, to, period });
  });
  return out;
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Epoch ms of an ISO-8601 instant with an explicit zone (`Z` or ±hh:mm), parsed field by field
 * rather than by Date.parse, whose reading of anything past the ES date-time format (a 6-digit
 * fraction, a missing zone) is engine-defined. Sub-millisecond digits truncate. Null when the
 * string is not such an instant or names a day or time that does not exist.
 */
function parseIsoInstant(s: string): number | null {
  const m = ISO_INSTANT.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0').slice(0, 3));
  const offset = m[8] === undefined ? 0 : (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 59 || Number(m[9] ?? 0) > 23 || Number(m[10] ?? 0) > 59) return null;
  // setUTCFullYear, not Date.UTC, which reads years 0-99 as 1900-1999.
  const day = new Date(0);
  day.setUTCFullYear(y, mo - 1, d);
  if (d < 1 || day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  return day.getTime() + ((h * 60 + mi - offset) * 60 + sec) * 1000 + ms;
}

/**
 * Epoch ms of a line's timestamp. Required: a price is read at the instant the line was written,
 * never at "now" (cosmos `modelPricing` falls back to Date.now(); this has no fallback).
 */
function instantMs(at: Date | number | string): number {
  let ms: number | null;
  if (at instanceof Date) ms = at.getTime();
  else if (typeof at === 'number') ms = at;
  else if (typeof at === 'string') ms = parseIsoInstant(at);
  else ms = null;
  if (ms === null || !Number.isFinite(ms)) {
    throw new TypeError(`priceUsage: at must be a Date, epoch ms or an ISO-8601 instant with a zone, got ${String(at)}`);
  }
  return ms;
}

function costOf(period: PeriodT, t: TokenCounts): { microUsd: bigint; tier: 'base' | 'long_context' } {
  // One request's whole prompt (model-pricing.ts promptTokensOf) picks the tier.
  const prompt = t.input + t.cache_read + t.cache_write_5m + t.cache_write_1h;
  const long = period.long_context;
  const past = long !== null && (long.strict ? prompt > long.over_tokens : prompt >= long.over_tokens);
  const r = past ? long.rates : period.base;
  const audioIn = r.audio ? Math.min(t.audio_input, t.input) : 0;
  const audioOut = r.audio ? Math.min(t.audio_output, t.output) : 0;
  const m = (tokens: number, rate: number) => BigInt(tokens) * BigInt(rate);
  const exact =
    m(t.input - audioIn, r.input) +
    m(audioIn, r.audio?.input ?? 0) +
    m(t.output - audioOut, r.output) +
    m(audioOut, r.audio?.output ?? 0) +
    m(t.cache_write_5m, r.cache_write_5m) +
    m(t.cache_write_1h, r.cache_write_1h) +
    m(t.cache_read, r.cache_read);
  return { microUsd: (exact + 500_000n) / 1_000_000n, tier: past ? 'long_context' : 'base' };
}

// ------------------------------------------------------------------ usage normalisation

class Reader {
  reasons: string[] = [];
  partial = false;
  inconsistent = false;

  flagPartial(what: string): void {
    this.partial = true;
    this.reasons.push(`partial:${what}`);
  }

  flagInconsistent(what: string): void {
    this.inconsistent = true;
    this.reasons.push(`inconsistent:${what}`);
  }

  /** A token count: absent/null is 0; anything but a non-negative safe integer is 0 and inconsistent. */
  count(obj: Record<string, unknown>, key: string, path = key): number {
    const v = obj[key];
    if (v === undefined || v === null) return 0;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
    this.flagInconsistent(`invalid_count:${path}`);
    return 0;
  }

  /** Any key the format does not know, carrying a non-empty value, is billing the rows cannot see. */
  unknownKeys(obj: Record<string, unknown>, known: ReadonlySet<string>, prefix = ''): void {
    for (const key of Object.keys(obj).sort()) {
      if (!known.has(key) && !isEmptyValue(obj[key])) this.flagPartial(`unmodelled:${prefix}${key}`);
    }
  }
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === 0 || v === '' || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.values(v as object).every(isEmptyValue);
  return false;
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new TypeError(`priceUsage: ${what} must be an object`);
  return v as Record<string, unknown>;
}

/** A nested object field: absent/null is {}; any other non-object is inconsistent. */
function subRecord(r: Reader, obj: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  r.flagInconsistent(`invalid_object:${key}`);
  return null;
}

const ANTHROPIC_KEYS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cache_creation',
  'output_tokens_details',
  'server_tool_use',
  'service_tier',
  'speed',
  'inference_geo',
  'iterations',
  'fallback_credit',
]);
const ANTHROPIC_CACHE_CREATION_KEYS = new Set(['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']);
const ANTHROPIC_OUTPUT_DETAIL_KEYS = new Set(['thinking_tokens']);
/** Web fetch bills tokens only; web search bills per search, which no row prices. */
const ANTHROPIC_SERVER_TOOL_KEYS = new Set(['web_fetch_requests']);
/** Values that bill at the list rates; any other value (priority, batch, fast, a region) does not. */
const ANTHROPIC_DEFAULTS: Record<string, ReadonlySet<string>> = {
  service_tier: new Set(['standard']),
  speed: new Set(['standard']),
  inference_geo: new Set(['', 'global', 'not_available']),
};

/**
 * Anthropic Messages usage (a Claude Code `message.usage`). `input_tokens` is already the uncached
 * input; cache writes are `cache_creation_input_tokens`, split by lifetime in
 * `cache_creation.ephemeral_{5m,1h}_input_tokens` (the 1h figure a subset of the total, clamped to
 * it, as cosmos `cacheWriteShares` reads it). With no split reported the writes price at the 5m
 * rate and the line is partial. `output_tokens_details.thinking_tokens` is a subset of output.
 */
function normalizeAnthropic(usage: Record<string, unknown>): NormalizedUsage {
  const r = new Reader();
  r.unknownKeys(usage, ANTHROPIC_KEYS);
  const input = r.count(usage, 'input_tokens');
  const output = r.count(usage, 'output_tokens');
  const cacheRead = r.count(usage, 'cache_read_input_tokens');
  const hasTotal = usage.cache_creation_input_tokens !== undefined && usage.cache_creation_input_tokens !== null;
  const reportedTotal = r.count(usage, 'cache_creation_input_tokens');
  const split = subRecord(r, usage, 'cache_creation');
  let fiveMinute: number;
  let oneHour: number;
  if (split) {
    r.unknownKeys(split, ANTHROPIC_CACHE_CREATION_KEYS, 'cache_creation.');
    const e5 = r.count(split, 'ephemeral_5m_input_tokens', 'cache_creation.ephemeral_5m_input_tokens');
    const e1 = r.count(split, 'ephemeral_1h_input_tokens', 'cache_creation.ephemeral_1h_input_tokens');
    const total = hasTotal ? reportedTotal : e5 + e1;
    if (hasTotal && reportedTotal !== e5 + e1) r.flagInconsistent('cache_creation_split_mismatch');
    oneHour = Math.min(e1, total);
    fiveMinute = total - oneHour;
  } else {
    fiveMinute = reportedTotal;
    oneHour = 0;
    if (reportedTotal > 0) r.flagPartial('cache_write_split_unknown');
  }
  const details = subRecord(r, usage, 'output_tokens_details');
  let reasoning = 0;
  if (details) {
    r.unknownKeys(details, ANTHROPIC_OUTPUT_DETAIL_KEYS, 'output_tokens_details.');
    reasoning = r.count(details, 'thinking_tokens', 'output_tokens_details.thinking_tokens');
  }
  if (reasoning > output) r.flagInconsistent('reasoning_exceeds_output');
  const tools = subRecord(r, usage, 'server_tool_use');
  if (tools) r.unknownKeys(tools, ANTHROPIC_SERVER_TOOL_KEYS, 'server_tool_use.');
  for (const [key, ok] of Object.entries(ANTHROPIC_DEFAULTS)) {
    const v = usage[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || !ok.has(v)) r.flagPartial(`${key}:${String(v)}`);
  }
  if (!isEmptyValue(usage.iterations)) r.flagPartial('unmodelled:iterations');
  if (!isEmptyValue(usage.fallback_credit)) r.flagPartial('unmodelled:fallback_credit');
  return {
    tokens: {
      input,
      output,
      cache_read: cacheRead,
      cache_write_5m: fiveMinute,
      cache_write_1h: oneHour,
      reasoning: Math.min(reasoning, output),
      audio_input: 0,
      audio_output: 0,
    },
    partial: r.partial,
    inconsistent: r.inconsistent,
    reasons: r.reasons,
  };
}

const OPENAI_KEYS = new Set([
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
  'input_tokens_details',
  'output_tokens_details',
]);
const OPENAI_INPUT_DETAIL_KEYS = new Set(['cached_tokens', 'cache_write_tokens', 'cache_write_tokens_details']);
const OPENAI_CACHE_WRITE_DETAIL_KEYS = new Set(['ttl_30m_tokens', 'ttl_12h_tokens']);
const OPENAI_OUTPUT_DETAIL_KEYS = new Set(['reasoning_tokens']);

/**
 * OpenAI usage: Codex's `token_count.info.last_token_usage` (codex-rs protocol TokenUsage) or the
 * Responses API `usage` it is built from. `input_tokens` is the WHOLE prompt: it includes
 * `cached_input_tokens` and `cache_write_input_tokens` (Codex's own parse test reads
 * input 100 = cached 40 + written 60, total 110 = input + output), so the uncached input is
 * input − cached − written. `reasoning_output_tokens` is a subset of `output_tokens` and bills
 * inside it. Cache writes bill on the 5m class (OpenAI's default 30-minute write) except the
 * 12-hour SUBSET the Responses API reports in `input_tokens_details.cache_write_tokens_details`
 * (`ttl_30m_tokens` + `ttl_12h_tokens` = `cache_write_tokens`), which bills on the 1h class.
 */
function normalizeOpenAi(usage: Record<string, unknown>): NormalizedUsage {
  const r = new Reader();
  r.unknownKeys(usage, OPENAI_KEYS);
  const inDetails = subRecord(r, usage, 'input_tokens_details');
  const outDetails = subRecord(r, usage, 'output_tokens_details');
  if (inDetails) r.unknownKeys(inDetails, OPENAI_INPUT_DETAIL_KEYS, 'input_tokens_details.');
  if (outDetails) r.unknownKeys(outDetails, OPENAI_OUTPUT_DETAIL_KEYS, 'output_tokens_details.');
  const writeSplit = inDetails ? subRecord(r, inDetails, 'cache_write_tokens_details') : null;
  if (writeSplit) r.unknownKeys(writeSplit, OPENAI_CACHE_WRITE_DETAIL_KEYS, 'input_tokens_details.cache_write_tokens_details.');
  const has = (obj: Record<string, unknown> | null, key: string) => obj !== null && obj[key] !== undefined && obj[key] !== null;
  const pick = (key: string, details: Record<string, unknown> | null, detailKey: string, path: string): number =>
    has(usage, key) ? r.count(usage, key) : details ? r.count(details, detailKey, path) : 0;
  const whole = r.count(usage, 'input_tokens');
  const cachedRaw = pick('cached_input_tokens', inDetails, 'cached_tokens', 'input_tokens_details.cached_tokens');
  const splitPath = 'input_tokens_details.cache_write_tokens_details.';
  const ttl30m = writeSplit ? r.count(writeSplit, 'ttl_30m_tokens', `${splitPath}ttl_30m_tokens`) : 0;
  const ttl12h = writeSplit ? r.count(writeSplit, 'ttl_12h_tokens', `${splitPath}ttl_12h_tokens`) : 0;
  // With no total reported, the split is the whole of the writes.
  const hasWriteTotal = has(usage, 'cache_write_input_tokens') || has(inDetails, 'cache_write_tokens');
  const writtenRaw = hasWriteTotal
    ? pick('cache_write_input_tokens', inDetails, 'cache_write_tokens', 'input_tokens_details.cache_write_tokens')
    : ttl30m + ttl12h;
  if (writeSplit && hasWriteTotal && ttl30m + ttl12h !== writtenRaw) r.flagInconsistent('cache_write_split_mismatch');
  const output = r.count(usage, 'output_tokens');
  const reasoning = pick('reasoning_output_tokens', outDetails, 'reasoning_tokens', 'output_tokens_details.reasoning_tokens');
  if (cachedRaw + writtenRaw > whole) r.flagInconsistent('cached_exceeds_input');
  const cached = Math.min(cachedRaw, whole);
  const written = Math.min(writtenRaw, whole - cached);
  // The 12h figure is a subset of the writes, clamped to them (as cache_creation's 1h is).
  const twelveHour = Math.min(ttl12h, written);
  if (usage.total_tokens !== undefined && usage.total_tokens !== null) {
    const total = r.count(usage, 'total_tokens');
    if (total !== whole + output) r.flagInconsistent('total_mismatch');
  }
  if (reasoning > output) r.flagInconsistent('reasoning_exceeds_output');
  return {
    tokens: {
      input: whole - cached - written,
      output,
      cache_read: cached,
      cache_write_5m: written - twelveHour,
      cache_write_1h: twelveHour,
      reasoning: Math.min(reasoning, output),
      audio_input: 0,
      audio_output: 0,
    },
    partial: r.partial,
    inconsistent: r.inconsistent,
    reasons: r.reasons,
  };
}

const TOKEN_KEYS = new Set([
  'input',
  'output',
  'cache_read',
  'cache_write_5m',
  'cache_write_1h',
  'reasoning',
  'audio_input',
  'audio_output',
]);

/** Already-normalised token classes (TokenCounts; absent classes are 0). */
function normalizeTokens(usage: Record<string, unknown>): NormalizedUsage {
  const r = new Reader();
  r.unknownKeys(usage, TOKEN_KEYS);
  const t: TokenCounts = {
    input: r.count(usage, 'input'),
    output: r.count(usage, 'output'),
    cache_read: r.count(usage, 'cache_read'),
    cache_write_5m: r.count(usage, 'cache_write_5m'),
    cache_write_1h: r.count(usage, 'cache_write_1h'),
    reasoning: r.count(usage, 'reasoning'),
    audio_input: r.count(usage, 'audio_input'),
    audio_output: r.count(usage, 'audio_output'),
  };
  if (t.reasoning > t.output) r.flagInconsistent('reasoning_exceeds_output');
  if (t.audio_input > t.input) r.flagInconsistent('audio_input_exceeds_input');
  if (t.audio_output > t.output) r.flagInconsistent('audio_output_exceeds_output');
  t.reasoning = Math.min(t.reasoning, t.output);
  t.audio_input = Math.min(t.audio_input, t.input);
  t.audio_output = Math.min(t.audio_output, t.output);
  return { tokens: t, partial: r.partial, inconsistent: r.inconsistent, reasons: r.reasons };
}

/** Read a transcript line's usage into disjoint token classes plus partial/inconsistent flags. */
export function normalizeUsage(format: UsageFormat, usage: unknown): NormalizedUsage {
  const obj = asRecord(usage, 'usage');
  switch (format) {
    case 'anthropic':
      return normalizeAnthropic(obj);
    case 'openai':
      return normalizeOpenAi(obj);
    case 'tokens':
      return normalizeTokens(obj);
    default:
      throw new TypeError(`priceUsage: unknown usage format ${String(format)}`);
  }
}
