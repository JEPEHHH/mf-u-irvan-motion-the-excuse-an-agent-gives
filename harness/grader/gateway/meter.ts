// The gateway forwarder's meter: what each forwarded model call used and cost, how it ended, and
// the trial's running account the request policy (grader/gateway/policy.ts) decides against.
//
// Usage, read from the response as the upstream sent it (a JSON body or an SSE stream, decoded:
// identity content-encoding), and fed to pricing/price.ts priceUsage in the route's format:
//   anthropic.messages  JSON: the message's `usage`. SSE: `message_start.message.usage`, then every
//                       `message_delta.usage` laid over it field by field (its counts are
//                       cumulative, and since server tools it may restate input and cache counts).
//                       Input, output, cache read and cache write (5m and 1h) tokens; format
//                       `anthropic`.
//   openai.chat         JSON: `usage`. SSE: the final usage chunk (`choices: []`, `usage: {...}`),
//                       which the policy makes every streamed request ask for (include_usage).
//                       Chat names its counts prompt_/completion_, so chatUsageToOpenAi renames them
//                       to the Responses names; format `openai`.
//   openai.responses    JSON: the Response's `usage`. SSE: the terminal event's `response.usage`:
//                       `response.completed`, or `response.incomplete` (max_output_tokens reached:
//                       still billed) or `response.failed`. Format `openai`.
// An SSE event cut off before its closing blank line is still read: the upstream billed it whether
// or not the entry's client saw it.
//
// On an entrant's own key (credential `entrant`: the forwarder's `provider` adapter, upstream.ts) a
// gemini-* chat answer comes from Google's OpenAI-compatible surface itself, whose usage counts the
// model's thinking in total_tokens alone, never in completion_tokens (a Gemini 3.7 Flash answer of
// prompt 55, completion 16, total 117: github.com/googleapis/python-genai/issues/2868), and Google bills
// thinking as output. withGoogleThinking folds the difference into output (and reasoning) before it is
// priced, so the trial's budget sees what Google bills. Google also restates the running usage in every
// chunk of a stream, so a stream cut short is charged the usage read so far, not its worst case.
//
// Outcome (contracts/agent.ts CassetteOutcome) of a forwarded request, classifyOutcome:
//   upstream_error  a connect failure, reset or timeout, a 5xx, a 429 (the policy's own 429s are
//                   refusals and never reach the upstream), a 401/402/403/407 (the forwarder's key
//                   or account, not the entry), a 408, a redirect, or a 2xx whose body reports an
//                   error (an SSE `error` event, a failed Response): what the void rule counts.
//                   masq's own refusals are among them (its 401 for the trial's key, 402 for the
//                   key's daily cap, 403 for a model off the key's allowlist, 429 for no pooled
//                   seat): it answers them in the same shape as a provider's error it relays, so
//                   they are read by their status like any other (upstream.ts, masq). On a request
//                   the forwarder made itself (UpstreamResult.forwarder_request: lane `house` on
//                   superbot-router, whose request is the forwarder's mapping of the env's fixed body,
//                   server.ts), any status outside 200 to 299 too, a 400, 404, 409, 413 or 422
//                   among them: the platform's fault, never the entry's, so the pass voids rather
//                   than lose the game the env stops on it. masq and an entrant's own provider
//                   keep the table above.
//   upstream        everything else: an answer, or a 4xx the entry's own request earned. A request
//                   the entry's client abandoned (the forwarder aborted the upstream) is `upstream`
//                   unless an error status had already come back.
//
// Charge, meterResponse, each request priced at its own recorded `at` and at the tier it billed at, on
// the trial's pricing table (policy.ts policyPricingTable: the policy's pricing_rev, its run's, else
// the bundled rows), the revision TrialMeter stamps on the cassette:
//   - an answer (a 2xx, or a request the client abandoned before any response head) whose final
//     usage was read: that usage;
//   - an answer without its final usage (a cut stream, a body with no usage): the request's worst
//     case reserved at admission (priced again at the tier the call billed at, when that is not the
//     one it was reserved at), or the usage read so far if that is more, so no answer is free;
//   - an upstream error or a 4xx: the usage it reported, else 0 (a masq refusal reports none).
// An unpriced model never gets this far (the policy refuses it), so pricing one here throws.
//
// The tier (policy.ts's service tiers: flex, priority, ultrafast, Anthropic's US-only inference; a
// tier no page prices for the model at its dearest known rate) is read field by field, billedTier:
// what the response reported, else what the request named (Ticket.asked). Reported: an OpenAI-shaped
// body's `service_tier` (a chat completion's or any chunk's; a Response's, the last stream event
// carrying one), outranked by a response header naming it (UpstreamResult.service_tier: Google's
// `x-gemini-service-tier`); Anthropic's `usage.speed`, `usage.service_tier` and `usage.inference_geo`.
// So a Fast request OpenAI downgraded (`service_tier: "default"`) is charged Standard, and one naming
// no tier that a project's default served at Fast (`"priority"`) is charged Fast, though it was
// reserved at Standard. masq prices every request at its model's Standard rate whatever tier it
// names (masq src/pricing.ts), so the house lane is priced here as an entrant's key is.
//
// The void rule (plan step 9; contracts/competition.ts AgentInference.void_upstream_error_share): a
// trial is void once at least VOID_MIN_UPSTREAM_ERRORS of its forwarded requests met an upstream
// error and they are at least that share of them. "Forwarded" is every entry the forwarder sent on
// (outcome upstream or upstream_error, route not `models`): a refusal never reached the upstream, so
// it neither counts as an error nor dilutes the share.
//
// The credential the lane runs on decides whose fault a refused key is. On the house's (`house`: masq)
// every upstream error counts. On an entrant's own key (`entrant`) an upstream error answered 401, 402,
// 403, 407 or 429 (ENTRANT_ERROR_STATUSES: the key refused, revoked, out of credit or rate-limited, the
// provider's answer or the adapter's own no-key 401) is the entrant's: it is still recorded as an
// upstream_error (the cassette's contract is unchanged) and still forwarded, but it is left out of the
// void count (VoidVerdict.entrant_errors), so revoking a key mid-trial never re-rolls the trial. A 5xx,
// 529, connect failure, reset or timeout still counts. voidVerdictOf reads a cassette the same way.
//
// TrialMeter is one trial's account: admit() runs the policy against the trial so far and reserves
// the worst case of what it forwards; settle() meters the answer, releases the reservation and books
// the cost; recordModels() books a `models` entry. Its totals() are the cassette's totals
// (contracts/agent.ts CassetteTotals) once every entry is booked.

import type { z } from 'zod';
import type { CassetteEntryT, CassetteTotals, CassetteUsageT } from '../../contracts/agent.ts';
import { providerOfModel } from '../../contracts/entry-secrets.ts';
import { FIXED9_SCALE, parseFixed9 } from '../../contracts/primitives.ts';
import {
  billingTier,
  checkRequest,
  GatewayPolicy,
  LIST_TIER,
  POLICED_ROUTES,
  policyPricingTable,
  priceAtTier,
  pricedWorstCase,
  remainingMicroUsd,
  type BillingTier,
  type GatewayPolicyT,
  type PolicedRoute,
  type PolicyAllow,
  type PolicyRefuse,
  type PolicyRequest,
  type PolicyState,
  type PricingTable,
  type TierFields,
} from './policy.ts';

/** contracts/agent.ts CassetteTotals (which exports no type alias for it). */
export type CassetteTotalsT = z.infer<typeof CassetteTotals>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ SSE

export interface SseEvent {
  /** The `event:` field, 'message' when none. */
  event: string;
  /** The `data:` lines joined with LF. */
  data: string;
}

/**
 * An incremental text/event-stream parser (the WHATWG event-stream grammar): bytes in any chunking,
 * LF, CR or CRLF line ends (a CRLF split across chunks included), a leading BOM dropped, `:`
 * comments and `id`/`retry` fields ignored. Unlike a browser it dispatches an event still pending
 * at the end of the stream.
 */
export class SseParser {
  readonly #onEvent: (e: SseEvent) => void;
  readonly #decoder = new TextDecoder('utf-8');
  #buf = '';
  #scanned = 0;
  #event = '';
  #data: string[] | null = null;

  constructor(onEvent: (e: SseEvent) => void) {
    this.#onEvent = onEvent;
  }

  push(chunk: Uint8Array): void {
    this.#feed(this.#decoder.decode(chunk, { stream: true }), false);
  }

  end(): void {
    this.#feed(this.#decoder.decode(), true);
    if (this.#data !== null) this.#dispatch();
  }

  #feed(text: string, final: boolean): void {
    const buf = this.#buf + text;
    let start = 0;
    let i = this.#scanned;
    while (i < buf.length) {
      const c = buf.charCodeAt(i);
      if (c !== 10 && c !== 13) {
        i++;
        continue;
      }
      // A CR at the end of what has arrived may be half of a CRLF.
      if (c === 13 && i + 1 === buf.length && !final) break;
      this.#line(buf.slice(start, i));
      i += c === 13 && buf.charCodeAt(i + 1) === 10 ? 2 : 1;
      start = i;
    }
    this.#buf = buf.slice(start);
    this.#scanned = i - start;
    if (final && this.#buf.length > 0) {
      this.#line(this.#buf);
      this.#buf = '';
      this.#scanned = 0;
    }
  }

  #line(line: string): void {
    if (line === '') {
      if (this.#data !== null) this.#dispatch();
      else this.#event = '';
      return;
    }
    if (line.charCodeAt(0) === 58) return; // ':' comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === 'event') this.#event = value;
    else if (field === 'data') (this.#data ??= []).push(value);
  }

  #dispatch(): void {
    const e: SseEvent = { event: this.#event === '' ? 'message' : this.#event, data: (this.#data ?? []).join('\n') };
    this.#event = '';
    this.#data = null;
    this.#onEvent(e);
  }
}

// ------------------------------------------------------------------ usage extraction

/** The pricer's usage format each route's usage is read in (pricing/engine.ts UsageFormat). */
export const ROUTE_USAGE_FORMAT: Readonly<Record<PolicedRoute, 'anthropic' | 'openai'>> = Object.freeze({
  'anthropic.messages': 'anthropic',
  'openai.chat': 'openai',
  'openai.responses': 'openai',
});

export interface ExtractedUsage {
  route: PolicedRoute;
  /** How the body read: an SSE stream, one JSON document, or null (empty, cut, or neither). */
  body: 'sse' | 'json' | null;
  format: 'anthropic' | 'openai';
  /** The response's usage in `format` (a stream's events merged); null when it carried none. */
  usage: Record<string, unknown> | null;
  /** `usage` is the response's final count: a whole JSON body's, or the stream's closing usage event's. */
  final: boolean;
  /** An error the body reported (an SSE `error` event, a failed Response, an error document): its code or type. */
  error: string | null;
  /**
   * The service tier an OpenAI-shaped body says it billed at: `service_tier` of a chat completion (the
   * last chunk naming one) or of a Response (the last stream event's `response` naming one); null when
   * none. Anthropic says its tier inside `usage`.
   */
  service_tier: string | null;
}

/**
 * Chat Completions usage in the Responses names pricing/engine.ts reads as format `openai`:
 * prompt_tokens → input_tokens, completion_tokens → output_tokens, prompt_tokens_details →
 * input_tokens_details, completion_tokens_details → output_tokens_details. The prediction counts
 * (accepted_/rejected_prediction_tokens) are inside completion_tokens and bill at its rate, so they
 * go; audio counts stay, so a non-zero one marks the price partial. Any other key is kept as is.
 */
export function chatUsageToOpenAi(usage: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (key === 'prompt_tokens') out.input_tokens = value;
    else if (key === 'completion_tokens') out.output_tokens = value;
    else if (key === 'prompt_tokens_details') out.input_tokens_details = value;
    else if (key === 'completion_tokens_details') {
      if (isRecord(value)) {
        const { accepted_prediction_tokens: _accepted, rejected_prediction_tokens: _rejected, ...rest } = value;
        out.output_tokens_details = rest;
      } else out.output_tokens_details = value;
    } else out[key] = value;
  }
  return out;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Google's OpenAI-compatible chat usage, in the names chatUsageToOpenAi gives it, with its thinking
 * billed (see the header): when total_tokens is more than input_tokens + output_tokens the difference
 * is thinking Google bills as output, so it is added to output_tokens and counted as reasoning
 * (output_tokens_details.reasoning_tokens, a subset of output; a reasoning count Google gave that is the
 * difference itself stays as it is, any other has the difference added). Any other usage is returned as
 * it is.
 */
export function withGoogleThinking(usage: Record<string, unknown>): Record<string, unknown> {
  const { input_tokens: input, output_tokens: output, total_tokens: total } = usage;
  if (!isCount(input) || !isCount(output) || !isCount(total) || total <= input + output) return usage;
  const thinking = total - input - output;
  const details: Record<string, unknown> = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const said = details.reasoning_tokens;
  const reasoning = isCount(said) ? (said === thinking ? thinking : said + thinking) : thinking;
  return { ...usage, output_tokens: output + thinking, output_tokens_details: { ...details, reasoning_tokens: reasoning } };
}

/** An error object's code, else its type, else `fallback`. */
function errorName(e: unknown, fallback: string): string {
  if (isRecord(e)) {
    if (typeof e.code === 'string' && e.code !== '') return e.code;
    if (typeof e.type === 'string' && e.type !== '') return e.type;
  }
  return fallback;
}

interface Collected {
  usage: Record<string, unknown> | null;
  final: boolean;
  error: string | null;
  /** anthropic.messages: message_start was read. */
  started: boolean;
  /** openai.*: the last `service_tier` the body named. */
  service_tier: string | null;
}

const RESPONSES_TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed']);

function collectAnthropic(s: Collected, doc: Record<string, unknown>): void {
  switch (doc.type) {
    case 'message':
      if (isRecord(doc.usage)) {
        s.usage = { ...doc.usage };
        s.final = true;
      }
      return;
    case 'message_start':
      if (isRecord(doc.message) && isRecord(doc.message.usage)) {
        s.usage = { ...doc.message.usage };
        s.started = true;
      }
      return;
    case 'message_delta':
      if (isRecord(doc.usage)) {
        const merged: Record<string, unknown> = { ...(s.usage ?? {}) };
        for (const [k, v] of Object.entries(doc.usage)) if (v !== null && v !== undefined) merged[k] = v;
        s.usage = merged;
        // Without message_start's input counts the usage is not the whole of it.
        s.final = s.started;
      }
      return;
    case 'error':
      s.error = errorName(doc.error, 'error');
      return;
  }
}

function collectChat(s: Collected, doc: Record<string, unknown>): void {
  if (typeof doc.service_tier === 'string') s.service_tier = doc.service_tier;
  if (isRecord(doc.usage)) {
    s.usage = chatUsageToOpenAi(doc.usage);
    s.final = true;
  }
  if (doc.error !== undefined && doc.error !== null) s.error = errorName(doc.error, 'error');
}

function collectResponses(s: Collected, doc: Record<string, unknown>, sse: boolean): void {
  if (!sse) {
    // A whole Response, or an error document.
    if (typeof doc.service_tier === 'string') s.service_tier = doc.service_tier;
    if (isRecord(doc.usage)) {
      s.usage = { ...doc.usage };
      s.final = true;
    }
    if (doc.status === 'failed') s.error = errorName(doc.error, 'response.failed');
    else if (doc.error !== undefined && doc.error !== null) s.error = errorName(doc.error, 'error');
    return;
  }
  const type = doc.type;
  // response.created echoes the tier asked; the terminal event names the one billed.
  if (isRecord(doc.response) && typeof doc.response.service_tier === 'string') s.service_tier = doc.response.service_tier;
  if (typeof type === 'string' && RESPONSES_TERMINAL.has(type)) {
    const r = doc.response;
    if (isRecord(r) && isRecord(r.usage)) {
      s.usage = { ...r.usage };
      s.final = true;
    }
    if (type === 'response.failed') s.error = errorName(isRecord(r) ? r.error : null, 'response.failed');
    return;
  }
  // {type:'error', code, message} or {type:'error', error:{...}}.
  if (type === 'error') s.error = isRecord(doc.error) ? errorName(doc.error, 'error') : typeof doc.code === 'string' && doc.code !== '' ? doc.code : 'error';
}

/**
 * Reads a response's usage as its bytes pass: push() every chunk the forwarder relays, end() when
 * the body is over. The content type picks SSE or JSON; any other (or none) is told from the body.
 */
export class UsageTap {
  readonly route: PolicedRoute;
  readonly #mode: 'sse' | 'json' | 'sniff';
  readonly #chunks: Uint8Array[] = [];
  readonly #s: Collected = { usage: null, final: false, error: null, started: false, service_tier: null };
  #sse: SseParser | null = null;
  #events = 0;
  #result: ExtractedUsage | null = null;

  constructor(route: PolicedRoute, contentType: string | null) {
    if (!(POLICED_ROUTES as readonly string[]).includes(route)) throw new TypeError(`UsageTap: ${String(route)} is not a metered route`);
    this.route = route;
    const media = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
    this.#mode = media === 'text/event-stream' ? 'sse' : media.endsWith('/json') || media.endsWith('+json') ? 'json' : 'sniff';
    if (this.#mode === 'sse') this.#sse = this.#newSse();
  }

  push(chunk: Uint8Array): void {
    if (this.#result !== null) throw new Error('UsageTap: push after end');
    if (this.#sse !== null) this.#sse.push(chunk);
    else this.#chunks.push(chunk);
  }

  end(): ExtractedUsage {
    if (this.#result !== null) return this.#result;
    let body: ExtractedUsage['body'] = null;
    if (this.#sse !== null) {
      this.#sse.end();
      if (this.#events > 0) body = 'sse';
    } else {
      const bytes = Buffer.concat(this.#chunks);
      const text = new TextDecoder('utf-8').decode(bytes);
      const first = text.trimStart()[0];
      if (this.#mode === 'json' || first === '{') {
        let doc: unknown = null;
        try {
          doc = JSON.parse(text);
        } catch {
          doc = null;
        }
        if (isRecord(doc)) {
          this.#collect(doc, false);
          body = 'json';
        }
      } else if (first !== undefined) {
        const sse = this.#newSse();
        sse.push(bytes);
        sse.end();
        if (this.#events > 0) body = 'sse';
      }
    }
    const s = this.#s;
    this.#result = { route: this.route, body, format: ROUTE_USAGE_FORMAT[this.route], usage: s.usage, final: s.usage !== null && s.final, error: s.error, service_tier: s.service_tier };
    return this.#result;
  }

  #newSse(): SseParser {
    return new SseParser((e) => {
      if (this.route === 'openai.chat' && e.data.trim() === '[DONE]') return;
      let doc: unknown;
      try {
        doc = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!isRecord(doc)) return;
      this.#events++;
      this.#collect(doc, true);
    });
  }

  #collect(doc: Record<string, unknown>, sse: boolean): void {
    if (this.route === 'anthropic.messages') collectAnthropic(this.#s, doc);
    else if (this.route === 'openai.chat') collectChat(this.#s, doc);
    else collectResponses(this.#s, doc, sse);
  }
}

/** A whole response body's usage (UsageTap over one chunk). */
export function extractUsage(route: PolicedRoute, contentType: string | null, body: Uint8Array): ExtractedUsage {
  const tap = new UsageTap(route, contentType);
  tap.push(body);
  return tap.end();
}

// ------------------------------------------------------------------ pricing

export interface PricedResponse {
  /** The normalised token classes (contracts/agent.ts CassetteUsage). */
  usage: CassetteUsageT;
  micro_usd: bigint;
  /** pricing/engine.ts flags: billing the rows cannot see, or counts that contradict themselves. */
  partial: boolean;
  inconsistent: boolean;
  reasons: string[];
}

/** The pricer's partial flags for Anthropic's tier fields (pricing/engine.ts ANTHROPIC_DEFAULTS), which a priced tier accounts for. */
const TIER_REASON = /^partial:(?:service_tier|speed|inference_geo):/;

/**
 * Price an extracted usage for `model` at `at` on `table` (policy.ts PricingTable; default the bundled rows);
 * null when the response carried none. Throws on an unpriced model. Given `tier` (billedTier: the caller read the
 * usage's tier fields), it prices at that tier and drops the pricer's partial flags for Anthropic's tier fields; else
 * at the list rate.
 */
export function priceExtracted(model: string, at: string, ex: ExtractedUsage, tier?: BillingTier, table?: PricingTable): PricedResponse | null {
  if (ex.usage === null) return null;
  const p = priceAtTier({ model, at, format: ex.format, usage: ex.usage }, tier ?? LIST_TIER, table);
  if (p.microUsd === null) throw new Error(`meter: ${model} has no pricing row; the policy refuses an unpriced model before it is forwarded`);
  const t = p.tokens;
  const reasons = tier !== undefined && ex.format === 'anthropic' ? p.reasons.filter((r) => !TIER_REASON.test(r)) : p.reasons;
  return {
    usage: { input: t.input, output: t.output, cache_read: t.cache_read, cache_write_5m: t.cache_write_5m, cache_write_1h: t.cache_write_1h, reasoning: t.reasoning },
    micro_usd: p.microUsd,
    partial: reasons.some((r) => r.startsWith('partial:')),
    inconsistent: p.inconsistent,
    reasons,
  };
}

// ------------------------------------------------------------------ outcome and charge

/** How a forwarded request's upstream exchange ended, as the forwarder saw it. */
export interface UpstreamResult {
  /** The status the upstream answered; null when no response head arrived. */
  status: number | null;
  content_type: string | null;
  /** The response body as received (decoded: identity content-encoding); empty when none. */
  body: Uint8Array;
  /** The connection failed, reset or timed out, before or during the body. */
  transport_error?: boolean;
  /** The entry's client went away and the forwarder aborted the upstream request: the entry's doing. */
  client_aborted?: boolean;
  /** The service tier a response header says the call billed at (Google's `x-gemini-service-tier`): outranks the body's. */
  service_tier?: string | null;
  /**
   * The request sent was the forwarder's own, not the entry's (lane `house` on superbot-router: its mapping of the env's
   * fixed body, server.ts): any status outside 200 to 299 is the platform's fault, an upstream_error (see the header).
   */
  forwarder_request?: boolean;
}

/** The statuses that say the upstream, or the forwarder's key or account with it, failed rather than the entry's request. */
export function isUpstreamErrorStatus(status: number): boolean {
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new RangeError(`isUpstreamErrorStatus: ${status} is not an HTTP status`);
  if (status >= 500 || status === 429) return true;
  if (status === 401 || status === 402 || status === 403 || status === 407 || status === 408) return true;
  return status < 200 || (status >= 300 && status < 400);
}

/** A forwarded request's outcome (see the header). `bodyError` is ExtractedUsage.error. */
export function classifyOutcome(r: Omit<UpstreamResult, 'body' | 'content_type'>, bodyError: string | null): 'upstream' | 'upstream_error' {
  // An error status the upstream already answered stands, whatever the client did after; on a request the forwarder made
  // itself, any status that is no answer.
  if (r.status !== null && (isUpstreamErrorStatus(r.status) || (r.forwarder_request === true && (r.status < 200 || r.status >= 300)))) return 'upstream_error';
  if (r.client_aborted) return 'upstream';
  if (r.transport_error || r.status === null) return 'upstream_error';
  if (r.status < 300 && bodyError !== null) return 'upstream_error';
  return 'upstream';
}

export type Charge = 'usage' | 'worst_case' | 'none';

export interface Metered {
  outcome: 'upstream' | 'upstream_error';
  /** The entry's usage: what the response reported (null when nothing). */
  usage: CassetteUsageT | null;
  /** The entry's micro_usd. */
  micro_usd: bigint;
  /** How micro_usd was reached: the usage priced, the admission's worst case, or nothing. */
  charge: Charge;
  /** The tier it was priced at (billedTier): what the response reported, else what the request named. */
  tier: BillingTier;
  extracted: ExtractedUsage;
  partial: boolean;
  inconsistent: boolean;
  reasons: string[];
}

export interface MeterArgs {
  route: PolicedRoute;
  /** The model the request named (the allowlist and the pricing both read it). */
  model: string;
  /** The request's recorded `at`. */
  at: string;
  /** The worst case reserved at admission (policy.ts worstCaseMicroUsd). */
  worst_micro_usd: bigint;
  /**
   * The worst case's sizes (policy.ts WorstCase): given, an answer charged its worst case is charged it
   * priced at the tier the call billed at; absent, worst_micro_usd as reserved.
   */
  worst?: { input_estimate: number; output_tokens: number };
  /** The fields of the request that named its tier (policy.ts requestTierFields; default none): its tier wherever the response names none. */
  asked?: TierFields;
  result: UpstreamResult;
  /** The usage a UsageTap already read off the relayed bytes; extracted from result.body when absent. */
  extracted?: ExtractedUsage;
  /** The credential the lane runs on (default `house`): on `entrant`, a gemini-* chat answer's usage is read as Google reports it (withGoogleThinking). */
  credential?: Credential;
  /** The table it is priced on (policy.ts policyPricingTable: the trial's); default the bundled rows. */
  table?: PricingTable;
}

/**
 * The tier a forwarded call billed at (see the header): each tier field the response reported, else
 * the request's (`asked`). On anthropic.messages the usage's `service_tier`, `speed` and
 * `inference_geo`; elsewhere `headerTier` (a response header's), else the body's `service_tier`.
 */
export function billedTier(route: PolicedRoute, asked: TierFields, ex: Pick<ExtractedUsage, 'usage'> & Partial<Pick<ExtractedUsage, 'service_tier'>>, headerTier: string | null = null): BillingTier {
  const reported: TierFields = {};
  if (route === 'anthropic.messages') {
    const u = ex.usage;
    if (u !== null) {
      for (const key of ['service_tier', 'speed', 'inference_geo'] as const) if (u[key] !== undefined && u[key] !== null) reported[key] = u[key];
    }
  } else {
    const named = headerTier ?? ex.service_tier ?? null;
    if (named !== null) reported.service_tier = named;
  }
  return billingTier(route, { ...asked, ...reported });
}

/** Whether an answer's usage is Google's own OpenAI-compatible chat usage: an entrant's key, a gemini-* model, Chat Completions (see the header). */
function isGoogleChat(a: Pick<MeterArgs, 'route' | 'model' | 'credential'>): boolean {
  return a.credential === 'entrant' && a.route === 'openai.chat' && providerOfModel(a.model) === 'google';
}

/** Meter one forwarded request's answer: its outcome, usage and charge (see the header). */
export function meterResponse(a: MeterArgs): Metered {
  const read = a.extracted ?? extractUsage(a.route, a.result.content_type, a.result.body);
  const ex = read.usage !== null && isGoogleChat(a) ? { ...read, usage: withGoogleThinking(read.usage) } : read;
  const outcome = classifyOutcome(a.result, ex.error);
  const tier = billedTier(a.route, a.asked ?? {}, ex, a.result.service_tier ?? null);
  const priced = priceExtracted(a.model, a.at, ex, tier, a.table);
  const status = a.result.status;
  // An answer: a 2xx, or a request the client abandoned before any head came back.
  const answered = outcome === 'upstream' && (status === null ? a.result.client_aborted === true : status >= 200 && status < 300);
  let micro_usd: bigint;
  let charge: Charge;
  if (answered && !(priced !== null && ex.final)) {
    const seen = priced?.micro_usd ?? 0n;
    const worst = a.worst === undefined ? a.worst_micro_usd : pricedWorstCase({ model: a.model, at: a.at, ...a.worst, tier, ...(a.table === undefined ? {} : { table: a.table }) }).micro_usd;
    micro_usd = seen > worst ? seen : worst;
    charge = 'worst_case';
  } else if (priced !== null) {
    micro_usd = priced.micro_usd;
    charge = 'usage';
  } else {
    micro_usd = 0n;
    charge = 'none';
  }
  return {
    outcome,
    usage: priced?.usage ?? null,
    micro_usd,
    charge,
    tier,
    extracted: ex,
    partial: priced?.partial ?? false,
    inconsistent: priced?.inconsistent ?? false,
    reasons: priced?.reasons ?? [],
  };
}

// ------------------------------------------------------------------ the void rule

/** A trial is never void on fewer upstream errors than this, whatever the share. */
export const VOID_MIN_UPSTREAM_ERRORS = 3;

/** Whose key a lane's model calls run on (see the header): the house's (masq), or the entrant's own. */
export type Credential = 'house' | 'entrant';
export const CREDENTIALS: readonly Credential[] = Object.freeze(['house', 'entrant'] as const);

/** The statuses whose upstream error is the entrant's own on an entrant's key (see the header): the key refused, revoked, out of credit, or rate-limited. */
export const ENTRANT_ERROR_STATUSES: readonly number[] = Object.freeze([401, 402, 403, 407, 429]);

/** Whether an upstream error answered `status` (null: no answer came) on `credential` is the entrant's own, left out of the void count. */
export function isEntrantError(credential: Credential, status: number | null): boolean {
  return credential === 'entrant' && status !== null && ENTRANT_ERROR_STATUSES.includes(status);
}

export interface VoidVerdict {
  void: boolean;
  /** The upstream errors counted. */
  upstream_errors: number;
  /** The forwarded requests the share is taken over. */
  forwarded: number;
  /** The share it was judged at (Fixed9). */
  share: string;
  /** On an entrant's key alone: the upstream errors left out as the entrant's (ENTRANT_ERROR_STATUSES), still among `forwarded`. */
  entrant_errors?: number;
}

/**
 * Void when upstream_errors ≥ VOID_MIN_UPSTREAM_ERRORS and upstream_errors / forwarded ≥ share (exact,
 * in Fixed9). `entrant_errors`, given, is carried into the verdict and never counted.
 */
export function voidVerdict(counts: { upstream_errors: number; forwarded: number; entrant_errors?: number }, share: string): VoidVerdict {
  const { upstream_errors, forwarded } = counts;
  const entrant = counts.entrant_errors ?? 0;
  if (!Number.isSafeInteger(upstream_errors) || !Number.isSafeInteger(forwarded) || !Number.isSafeInteger(entrant) || upstream_errors < 0 || entrant < 0 || upstream_errors + entrant > forwarded) {
    throw new RangeError(`voidVerdict: ${upstream_errors} upstream errors${counts.entrant_errors === undefined ? '' : ` and ${entrant} the entrant's`} of ${forwarded} forwarded requests`);
  }
  const s = parseFixed9(share);
  const isVoid = upstream_errors >= VOID_MIN_UPSTREAM_ERRORS && BigInt(upstream_errors) * FIXED9_SCALE >= s * BigInt(forwarded);
  return { void: isVoid, upstream_errors, forwarded, share, ...(counts.entrant_errors === undefined ? {} : { entrant_errors: entrant }) };
}

/**
 * The void verdict of a cassette's entries: the forwarded ones (not `models`, not refused). On
 * `credential` entrant an upstream_error entry whose status is one of ENTRANT_ERROR_STATUSES is the
 * entrant's and left out of the count (see the header), as TrialMeter left it out live.
 */
export function voidVerdictOf(
  entries: readonly (Pick<CassetteEntryT, 'route' | 'outcome'> & Partial<Pick<CassetteEntryT, 'status'>>)[],
  share: string,
  opts: { credential?: Credential } = {},
): VoidVerdict {
  const credential = opts.credential ?? 'house';
  let forwarded = 0;
  let upstream_errors = 0;
  let entrant_errors = 0;
  for (const e of entries) {
    if (e.route === 'models' || e.outcome === 'refused') continue;
    forwarded++;
    if (e.outcome !== 'upstream_error') continue;
    if (isEntrantError(credential, e.status ?? null)) entrant_errors++;
    else upstream_errors++;
  }
  return voidVerdict({ upstream_errors, forwarded, ...(credential === 'entrant' ? { entrant_errors } : {}) }, share);
}

// ------------------------------------------------------------------ the trial's account

/** A forwarded request in flight: what admit() reserved and settle() books. */
export interface Ticket {
  readonly id: number;
  readonly route: PolicedRoute;
  readonly model: string;
  readonly at: string;
  readonly stream: boolean;
  readonly worst_micro_usd: bigint;
  /** The tier the worst case was reserved at: the one the request named (policy.ts WorstCase.tier). */
  readonly tier: BillingTier;
  /** The worst case's sizes, to price it again at the tier the call billed at. */
  readonly input_estimate: number;
  readonly output_tokens: number;
  /** The fields of the request that named its tier (policy.ts PolicyAllow.asked). */
  readonly asked: TierFields;
}

export type Admission = (PolicyAllow & { ticket: Ticket }) | PolicyRefuse;

export interface MeterSnapshot {
  pricing_rev: string;
  budget_micro_usd: string;
  spent_micro_usd: string;
  reserved_micro_usd: string;
  remaining_micro_usd: string;
  /** Requests forwarded, those in flight included (what max_requests_per_trial caps). */
  forwarded: number;
  in_flight: number;
  /** The booked entries' totals (contracts/agent.ts CassetteTotals). */
  totals: CassetteTotalsT;
  void: VoidVerdict;
}

const USAGE_KEYS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'reasoning'] as const;

export interface TrialMeterOptions {
  /** Whose key the lane runs on (default `house`; see the header): `entrant` leaves the entrant's own key errors out of the void count and reads Google's chat usage as Google bills it. */
  credential?: Credential;
}

export class TrialMeter {
  readonly policy: GatewayPolicyT;
  /**
   * The pricing rows every charge is priced on (contracts/agent.ts Cassette.pricing_rev): the policy's pricing_rev,
   * its run's (policy.ts GatewayPolicy.pricing_rev), else the bundled rows' revision.
   */
  readonly pricing_rev: string;
  readonly #table: PricingTable;
  readonly credential: Credential;
  readonly #inFlight = new Map<number, Ticket>();
  #nextTicket = 0;
  #admitted = 0;
  #spent = 0n;
  #reserved = 0n;
  #forwardedSettled = 0;
  /** The upstream errors that are the entrant's own (isEntrantError): among #counts.upstream_errors, never counted toward the void rule. */
  #entrantErrors = 0;
  readonly #counts = { requests: 0, upstream: 0, refused: 0, upstream_errors: 0 };
  readonly #usage: CassetteUsageT = { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, reasoning: 0 };

  /** Throws policy.ts PricingRevisionNotHeldError when this grader holds no table of the policy's pricing_rev, before anything is admitted. */
  constructor(policy: unknown, opts: TrialMeterOptions = {}) {
    this.policy = GatewayPolicy.parse(policy);
    this.#table = policyPricingTable(this.policy);
    this.pricing_rev = this.#table.rev;
    const credential = opts.credential ?? 'house';
    if (!CREDENTIALS.includes(credential)) throw new TypeError(`TrialMeter: a credential is ${CREDENTIALS.join(' or ')}, not ${JSON.stringify(credential)}`);
    this.credential = credential;
  }

  /** The trial so far, as the policy reads it. */
  state(): PolicyState {
    return { forwarded: this.#admitted, spent_micro_usd: this.#spent, reserved_micro_usd: this.#reserved };
  }

  /**
   * Check a request against the policy. A refusal is booked at once (answer it with
   * `response`); an admitted request reserves its worst case until settle(ticket, ...).
   */
  admit(req: PolicyRequest): Admission {
    const d = checkRequest(this.policy, this.state(), req);
    if (!d.allow) {
      this.#counts.requests++;
      this.#counts.refused++;
      return d;
    }
    const ticket: Ticket = Object.freeze({
      id: this.#nextTicket++,
      route: req.route,
      model: d.model,
      at: req.at,
      stream: d.stream,
      worst_micro_usd: d.worst.micro_usd,
      tier: d.worst.tier,
      input_estimate: d.worst.input_estimate,
      output_tokens: d.worst.output_tokens,
      asked: d.asked,
    });
    this.#inFlight.set(ticket.id, ticket);
    this.#admitted++;
    this.#reserved += ticket.worst_micro_usd;
    return { ...d, ticket };
  }

  /** Meter an admitted request's answer, release its reservation and book it. Each ticket settles once. */
  settle(ticket: Ticket, result: UpstreamResult, extracted?: ExtractedUsage): Metered {
    if (this.#inFlight.get(ticket.id) !== ticket) throw new Error(`TrialMeter: ticket ${ticket.id} is not in flight here (settled already, or another meter's)`);
    const m = meterResponse({
      route: ticket.route,
      model: ticket.model,
      at: ticket.at,
      worst_micro_usd: ticket.worst_micro_usd,
      worst: { input_estimate: ticket.input_estimate, output_tokens: ticket.output_tokens },
      asked: ticket.asked,
      result,
      extracted,
      credential: this.credential,
      table: this.#table,
    });
    this.#inFlight.delete(ticket.id);
    this.#reserved -= ticket.worst_micro_usd;
    this.#spent += m.micro_usd;
    this.#forwardedSettled++;
    this.#counts.requests++;
    if (m.outcome === 'upstream') this.#counts.upstream++;
    else {
      this.#counts.upstream_errors++;
      if (isEntrantError(this.credential, result.status)) this.#entrantErrors++;
    }
    if (m.usage !== null) for (const k of USAGE_KEYS) this.#usage[k] += m.usage[k];
    return m;
  }

  /** Book a `models` request (answered by the forwarder from the allowlist: outcome upstream, no usage, 0). */
  recordModels(): void {
    this.#counts.requests++;
    this.#counts.upstream++;
  }

  /** What is left of the budget once spend and reservations are taken: never below 0. */
  remaining(): bigint {
    return remainingMicroUsd(this.policy, this.state());
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** The booked entries' totals: the cassette's, once every entry is booked. */
  totals(): CassetteTotalsT {
    return { ...this.#counts, micro_usd: this.#spent.toString(), usage: { ...this.#usage } };
  }

  /** The void rule over the settled forwarded requests (on an entrant's key, its own key errors left out). */
  voidVerdict(): VoidVerdict {
    const counted = this.#counts.upstream_errors - this.#entrantErrors;
    const entrant = this.credential === 'entrant' ? { entrant_errors: this.#entrantErrors } : {};
    return voidVerdict({ upstream_errors: counted, forwarded: this.#forwardedSettled, ...entrant }, this.policy.void_upstream_error_share);
  }

  snapshot(): MeterSnapshot {
    return {
      pricing_rev: this.pricing_rev,
      budget_micro_usd: this.policy.budget_micro_usd,
      spent_micro_usd: this.#spent.toString(),
      reserved_micro_usd: this.#reserved.toString(),
      remaining_micro_usd: this.remaining().toString(),
      forwarded: this.#admitted,
      in_flight: this.#inFlight.size,
      totals: this.totals(),
      void: this.voidVerdict(),
    };
  }
}
