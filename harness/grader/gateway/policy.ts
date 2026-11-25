// The gateway forwarder's request policy: what it checks of an entry's model call before forwarding
// it, and how it refuses one. The rules are the bundle's `inference` (contracts/competition.ts
// AgentInference) as GatewayPolicy, the shape the forwarder's config carries (budget in micro-USD).
// checkRequest is pure: the same request, policy and state give the same decision and the same
// refusal bytes. The state is the trial's so far (grader/gateway/meter.ts TrialMeter keeps it):
// requests forwarded (in flight included), spend settled, and the worst cases reserved by requests
// still in flight, so parallel calls cannot overrun the budget between them.
//
// The checks, in this order (the first that fails refuses):
//   request_too_large    413  the body is over max_request_bytes (the forwarder may hold only its
//                             first bytes and pass the whole size as body_bytes)
//   invalid_json         400  the body is not a JSON object (UTF-8), or the forwarder could not key it
//                             (`unkeyed`: grader/gateway/cassette.ts keyRequest refuses a BOM, a lone
//                             surrogate or nesting past the stack, which a plain parse would take)
//   stateful_request     400  the request leans on state kept at the provider, which a trial must not:
//                             replay serves only what the trial itself sent, the meter prices only what
//                             it sees, and no state may pass between trials. `param` names the field:
//                               openai.responses    previous_response_id, conversation, store: true;
//                                                   an input item_reference; a content part (or a
//                                                   function call output part) with a file_id; a
//                                                   file_search tool (a vector store); a
//                                                   code_interpreter container named by id or given
//                                                   file_ids
//                               openai.chat         store: true (a stored completion); a content
//                                                   part with a file_id (`file.file_id`)
//                               anthropic.messages  `container`; a content block whose source is
//                                                   `{type: "file"}` (a Files API id), in a message,
//                                                   the system prompt, a tool result or a document's
//                                                   content source; a container_upload block
//                             Only those places are read: a field of the same name inside a tool's
//                             schema, a tool call's input or any text never refuses.
//   network_request      400  an offline bundle's alone (GatewayPolicy.offline, from contracts/
//                             competition.ts AgentInference.offline): the request has the provider
//                             reach the network for the entry. `param` names the field:
//                               every route         a tool whose type opens web_search, web_fetch or
//                                                   mcp (Anthropic's web_search_20250305,
//                                                   web_fetch_20250910 and mcp_toolset, OpenAI's
//                                                   web_search, web_search_preview and mcp)
//                               anthropic.messages  mcp_servers (an empty list names none); a content
//                                                   block whose source is {type: "url"}, in a message,
//                                                   the system prompt, a tool result or a document's
//                                                   content source
//                               openai.chat         web_search_options; a content part whose image_url
//                                                   (its url) is anything but a data: URL
//                               openai.responses    a content part (or a function call output part)
//                                                   whose image_url is anything but a data: URL, or
//                                                   that names a file_url
//                             It reads request structure alone (tool types, content sources and their
//                             URLs), never text: a tool the entry runs itself, whatever its name, and a
//                             URL written in a prompt are forwarded. It is no part of REFUSAL_TYPES
//                             (the refusals every bundle's forwarder makes): NETWORK_REFUSAL.
//   model_not_allowed    400  `model` is missing, matches none of the allowlist globs, or has no
//                             row in the trial's pricing table (below): an unpriced model is never
//                             billed at $0
//   max_tokens_required  400  the output cap is missing, not a positive integer, or over
//                             max_output_tokens_per_request. The field is the route's own:
//                               anthropic.messages  max_tokens
//                               openai.chat         max_completion_tokens or max_tokens (each named
//                                                   one is checked; GPT-5 and the o-series take only
//                                                   max_completion_tokens)
//                               openai.responses    max_output_tokens
//   request_cap          429  max_requests_per_trial requests were already forwarded
//   budget_exhausted     429  worst case + spent + reserved > budget
//
// The worst case is the request priced at its recorded `at` with an input estimate of
// ceil(body bytes / 3) tokens and an output of its cap (× `n` on openai.chat, which generates n
// choices). The estimate is priced at the dearest input class of the model's period (plain input,
// 5-minute or 1-hour cache write), since a request may write its whole prompt to the cache and a
// cache write bills above plain input (claude-opus-5-5: $8 a MTok for a 1-hour write, $4 for input).
// It is priced at the tier the request names (below), never refused for naming one.
//
// Service tiers. A call can ask to bill at another rate than its model's list (Standard) row:
//   openai.chat, openai.responses  `service_tier`: OpenAI's "flex" (½), "priority" or "fast" (its
//                                  Fast mode, renamed from Priority processing on 2026-07-30: about
//                                  2×), "ultrafast" (6×); "auto" or none bills at the project's
//                                  default tier, "default" at Standard. Google's OpenAI-compatible
//                                  surface takes the same field, "flex" (½) and "priority" (1.8×).
//   anthropic.messages             `speed: "fast"` (2×) and `inference_geo` other than global (US-only
//                                  inference, 1.1× on top); `service_tier` "auto" may draw on a
//                                  Priority Tier commitment, which publishes no per-token rate.
// The forwarder sends these as they came; the meter prices each call at its tier's published rate
// (PUBLISHED_TIERS: the model's rows scaled as the vendor's page prints them, cited there with the
// date read), and a tier no page prices for the model (an unknown value, OpenAI's "scale",
// Anthropic's Priority Tier, Fast on a model the Fast table leaves out) at the dearest rate known
// for that model. billingTier reads the fields; the worst case is reserved at the tier the request
// names (a request naming none, or "auto", at Standard), and meter.ts settles each call at the tier
// its response reports it billed at.
//
// The pricing table. Every price here, the worst case and meter.ts's charges alike, is read on one
// table: the policy's pricing_rev (GatewayPolicy.pricing_rev; pricingTableOf), the run's revision, so
// every trial of a run is metered and its cassette stamped on one table whichever release's grader
// runs it (grader/agent-score.ts states a run's spend on one revision and refuses trials priced on
// two). A policy naming none is priced on the bundled rows (pricing/price.ts). A revision is the
// bundled one or a held one (pricing/revs.ts); the tier tables are built from that table's own rows
// (a PUBLISHED_TIERS model a held table prices on no row is left out of it). A revision this grader
// holds no table of is PricingRevisionNotHeldError when the trial's meter is made (meter.ts
// TrialMeter): the platform's fault, before anything is forwarded.
//
// A refusal is answered in the vendor's own error shape, carrying our `type` and what is left of the
// budget, so an SDK raises its usual error class:
//   anthropic.messages  {"type":"error","error":{"type":T,"message":M,"remaining_micro_usd":R}}
//   openai.*            {"error":{"message":M,"type":T,"param":P,"code":T,"remaining_micro_usd":R}}
// with REFUSAL_HEADERS (`x-should-retry: false`: the Anthropic and OpenAI SDKs then skip their
// automatic retry of a 429, which no retry could change). A refusal is a cassette entry (outcome
// `refused`, contracts/agent.ts), so a replay serves the same status and bytes; the forwarder adds
// REFUSAL_HEADERS to every refused entry it answers, live or replayed.
//
// Streamed Chat Completions report usage only when asked: a request with `stream: true` is forwarded
// with `stream_options.include_usage: true` set (the entry's SDK sees one extra final chunk with
// empty `choices` and the usage, which the OpenAI SDKs handle). With no `stream_options` key the
// member is spliced in after the opening brace and every other byte is kept; an existing
// `stream_options` that does not already say include_usage: true is rewritten (the body
// re-serialised). Anthropic Messages and OpenAI Responses streams always carry usage.
//
// An OpenAI Responses request leaving `store` out is stored at the provider (the API's default is
// true), so every Responses request is forwarded with `store: false`: no trial content is kept
// upstream. `store: true` was already refused (stateful_request); with no `store` key the member is
// spliced in after the opening brace and every other byte is kept, a `store` of false is forwarded
// as sent, and one of any other value (null, a string, a number) is rewritten false (the body
// re-serialised). Nothing earlier in the trial is stored either, so an input item passed back by
// its id alone (a reasoning item without its encrypted_content: ask for it with
// include: ["reasoning.encrypted_content"]) finds nothing, and the provider answers 400, the
// entry's own error (meter.ts isUpstreamErrorStatus: a 400 is no upstream error). Chat
// Completions stores nothing unless asked, and asking (`store: true`) is refused as on Responses,
// so nothing of a trial is kept at the provider on either OpenAI route; a chat `store` left out,
// false or null is forwarded as sent. Anthropic Messages has no such field: its bodies are left
// alone.
//
// Only the forwarded bytes change: the cassette keys the request on the body as the entry sent it,
// and the worst case is priced on it, so a replay matches whatever was set on the way up.
//
// Every lane runs these checks before any upstream sees a byte: grader/gateway/server.ts takes each
// request through meter.ts TrialMeter.admit, the one caller of checkRequest, and only an admitted
// request reaches the lane's upstream adapter (upstream.ts: masq on the house's key, or the provider
// on the entrant's own), so no adapter forwards what the policy refuses.

import { z } from 'zod';
import { ModelGlob, type AgentInferenceT, type AgentTargetT } from '../../contracts/competition.ts';
import { FIXED9_SCALE, Fixed9, parseFixed9, Sha256Hex, U64 } from '../../contracts/primitives.ts';
import {
  createPricer,
  PRICING_ROWS,
  pricingRev,
  type PeriodT,
  type PriceUsageArgs,
  type PricedUsage,
  type Pricer,
  type RatesT,
} from '../../pricing/price.ts';
import { heldPricingRevs, pricerOfRev } from '../../pricing/revs.ts';

/** The routes the policy guards: the forwarder's POST routes (contracts/agent.ts CASSETTE_ROUTES but `models`). */
export const POLICED_ROUTES = ['anthropic.messages', 'openai.chat', 'openai.responses'] as const;
export type PolicedRoute = (typeof POLICED_ROUTES)[number];

/** The refusals every bundle's forwarder makes, in check order (server/routes/competitions/kit.ts lists them in RULES.txt). */
export const REFUSAL_TYPES = [
  'request_too_large',
  'invalid_json',
  'stateful_request',
  'model_not_allowed',
  'max_tokens_required',
  'request_cap',
  'budget_exhausted',
] as const;
export type RefusalType = (typeof REFUSAL_TYPES)[number];

/** The refusal an offline bundle's forwarder adds (GatewayPolicy.offline), checked after stateful_request. */
export const NETWORK_REFUSAL = 'network_request';
/** Every refusal checkRequest answers: REFUSAL_TYPES, and NETWORK_REFUSAL on an offline bundle. */
export type PolicyRefusalType = RefusalType | typeof NETWORK_REFUSAL;

/** Each refusal's HTTP status. */
export const REFUSAL_STATUS: Readonly<Record<PolicyRefusalType, 400 | 413 | 429>> = Object.freeze({
  request_too_large: 413,
  invalid_json: 400,
  stateful_request: 400,
  network_request: 400,
  model_not_allowed: 400,
  max_tokens_required: 400,
  request_cap: 429,
  budget_exhausted: 429,
});

/** The headers every refused entry is answered with, live or replayed. */
export const REFUSAL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
  'x-should-retry': 'false',
});

/** The output cap fields each route takes, in the order a refusal names them. */
export const OUTPUT_CAP_FIELDS: Readonly<Record<PolicedRoute, readonly string[]>> = Object.freeze({
  'anthropic.messages': Object.freeze(['max_tokens']),
  'openai.chat': Object.freeze(['max_completion_tokens', 'max_tokens']),
  'openai.responses': Object.freeze(['max_output_tokens']),
});

/** A request's input estimate: one token per three body bytes, rounded up. */
export const BYTES_PER_INPUT_TOKEN = 3;

/**
 * The policy as the forwarder's config carries it: the bundle's inference rules with the budget in
 * micro-USD (a u64 decimal string, as contracts/agent.ts writes money).
 */
export const GatewayPolicy = z.strictObject({
  /** The allowlist: model id globs (contracts/competition.ts ModelGlob). */
  models: z.array(ModelGlob).min(1).max(20),
  budget_micro_usd: U64.refine((s) => s !== '0', 'a budget is above 0'),
  max_requests_per_trial: z.int().min(1),
  max_output_tokens_per_request: z.int().min(1),
  max_request_bytes: z.int().min(1),
  void_upstream_error_share: Fixed9.refine((s) => parseFixed9(s) > 0n && parseFixed9(s) <= FIXED9_SCALE, {
    message: 'void_upstream_error_share is a share: above 0, at most 1',
    when: (payload) => payload.issues.length === 0,
  }),
  /**
   * An offline bundle's (AgentInference.offline): refuse a request that has the provider reach the
   * network (network_request). Absent: no such check, and no key appears.
   */
  offline: z.literal(true).optional(),
  /**
   * The pricing revision the trial is metered on (the header's `pricing table`): its run's, so a
   * release changing pricing/rows.json mid-run leaves no trial of it on another. Absent: the bundled rows.
   */
  pricing_rev: Sha256Hex.optional(),
});
export type GatewayPolicyT = z.infer<typeof GatewayPolicy>;

/** What a policy builder may add: the pricing revision its trial is metered on (GatewayPolicy.pricing_rev). */
export interface PolicyPricing {
  pricing_rev?: string;
}

/** A USD amount of at most two decimals (contracts/competition.ts UsdAmount) in micro-USD. */
export function usdToMicroUsd(usd: number): bigint {
  const cents = Math.round(usd * 100);
  if (!Number.isFinite(usd) || usd < 0 || !Number.isSafeInteger(cents) || Math.abs(usd * 100 - cents) >= 1e-6) {
    throw new RangeError(`usdToMicroUsd: expected a USD amount of at most two decimals, got ${usd}`);
  }
  return BigInt(cents) * 10_000n;
}

/** The forwarder's policy for one trial of a bundle whose inference rules are `inference`, metered on `pricing.pricing_rev` when given. */
export function policyFromInference(inference: AgentInferenceT, pricing: PolicyPricing = {}): GatewayPolicyT {
  return GatewayPolicy.parse({
    models: [...inference.models],
    budget_micro_usd: usdToMicroUsd(inference.budget_usd_per_trial).toString(),
    max_requests_per_trial: inference.max_requests_per_trial,
    max_output_tokens_per_request: inference.max_output_tokens_per_request,
    max_request_bytes: inference.max_request_bytes,
    void_upstream_error_share: inference.void_upstream_error_share,
    ...(inference.offline === true ? { offline: true } : {}),
    ...(pricing.pricing_rev === undefined ? {} : { pricing_rev: pricing.pricing_rev }),
  });
}

/**
 * The least share a policy carries. The house lane's: any upstream error there voids the trial
 * (grader/agent.ts), so its policy's share only fills the field.
 */
export const HOUSE_VOID_SHARE = '0.000000001';

/**
 * The house lane's forwarder policy for one trial of a bundle whose target is `target`
 * (contracts/competition.ts AgentTarget): its exact model ids as the allowlist, its per-trial caps,
 * metered on `pricing.pricing_rev` when given (its run's, as the entry lane's).
 */
export function policyFromTarget(target: AgentTargetT, pricing: PolicyPricing = {}): GatewayPolicyT {
  return GatewayPolicy.parse({
    models: [...target.models],
    budget_micro_usd: usdToMicroUsd(target.budget_usd_per_trial).toString(),
    max_requests_per_trial: target.max_requests_per_trial,
    max_output_tokens_per_request: target.max_output_tokens_per_request,
    max_request_bytes: target.max_request_bytes,
    void_upstream_error_share: HOUSE_VOID_SHARE,
    ...(pricing.pricing_rev === undefined ? {} : { pricing_rev: pricing.pricing_rev }),
  });
}

// ------------------------------------------------------------------ model globs

const globCache = new Map<string, RegExp>();

/** A ModelGlob as an anchored, case-sensitive RegExp: `*` any run of characters, `?` exactly one, the rest literal. */
export function modelGlobRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re === undefined) {
    let source = '^';
    for (const ch of glob) {
      if (ch === '*') source += '.*';
      else if (ch === '?') source += '.';
      else source += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
    re = new RegExp(`${source}$`, 'su');
    globCache.set(glob, re);
  }
  return re;
}

/** Whether `model` matches one of the allowlist's globs. */
export function modelAllowed(globs: readonly string[], model: string): boolean {
  return globs.some((g) => modelGlobRegExp(g).test(model));
}

// ------------------------------------------------------------------ the request

export interface ParsedRequest {
  /** The body as text (UTF-8, a leading BOM dropped). */
  text: string;
  json: Record<string, unknown>;
  /** `model` when it is a non-empty string, else null. */
  model: string | null;
  /** `stream === true`. */
  stream: boolean;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** The body as a JSON object, or null when it is not valid UTF-8 or not a JSON object. */
export function parseRequestBody(body: Uint8Array): ParsedRequest | null {
  let text: string;
  let json: unknown;
  try {
    text = utf8.decode(body);
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  const model = typeof obj.model === 'string' && obj.model.length > 0 ? obj.model : null;
  return { text, json: obj, model, stream: obj.stream === true };
}

type OutputCap = { ok: true; per_choice: number; choices: number } | { ok: false; param: string; message: string };

/** The request's output cap, checked against the policy's: what the worst case bills as output. */
function outputCap(route: PolicedRoute, json: Record<string, unknown>, cap: number): OutputCap {
  const fields = OUTPUT_CAP_FIELDS[route];
  const named = fields.filter((f) => json[f] !== undefined && json[f] !== null);
  if (named.length === 0) {
    return { ok: false, param: fields[0]!, message: `${fields.join(' or ')} is required: name the most output tokens this request may produce, at most ${cap}` };
  }
  let most = 0;
  for (const f of named) {
    const v = json[f];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
      return { ok: false, param: f, message: `${f} must be a positive integer, at most ${cap}; got ${JSON.stringify(v)}` };
    }
    if (v > cap) return { ok: false, param: f, message: `${f} ${v} is over this competition's cap of ${cap} output tokens per request` };
    most = Math.max(most, v);
  }
  // Chat Completions generates `n` choices, each up to the cap; anything but a positive integer the
  // upstream refuses itself, unbilled.
  const n = route === 'openai.chat' && typeof json.n === 'number' && Number.isSafeInteger(json.n) && json.n >= 1 ? json.n : 1;
  return { ok: true, per_choice: most, choices: n };
}

// ------------------------------------------------------------------ provider-side state

/** A request field that leans on state kept at the provider: its path (OpenAI's `param` style) and why. */
export interface StatefulField {
  param: string;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const present = (v: unknown): boolean => v !== undefined && v !== null;
const SELF_CONTAINED = 'a trial is self-contained, so send the content itself';

/** A content part naming an uploaded file by id (`file_id`, or chat's `file.file_id`). */
function fileIdPart(part: unknown, path: string): StatefulField | null {
  if (!isObj(part)) return null;
  if (present(part.file_id)) return { param: `${path}.file_id`, message: `${path}.file_id names a file stored at the provider: ${SELF_CONTAINED}` };
  if (isObj(part.file) && present(part.file.file_id)) {
    return { param: `${path}.file.file_id`, message: `${path}.file.file_id names a file stored at the provider: ${SELF_CONTAINED}` };
  }
  return null;
}

function fileIdParts(parts: unknown, path: string): StatefulField | null {
  if (!Array.isArray(parts)) return null;
  for (let i = 0; i < parts.length; i++) {
    const hit = fileIdPart(parts[i], `${path}[${i}]`);
    if (hit !== null) return hit;
  }
  return null;
}

/** Anthropic content blocks: a Files API source, a container upload, and the blocks a tool result or a document holds. */
function anthropicBlocks(blocks: unknown, path: string): StatefulField | null {
  if (!Array.isArray(blocks)) return null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const p = `${path}[${i}]`;
    if (!isObj(b)) continue;
    if (b.type === 'container_upload') return { param: p, message: `${p} uploads a file into a container kept at the provider: ${SELF_CONTAINED}` };
    if (isObj(b.source)) {
      if (b.source.type === 'file') return { param: `${p}.source`, message: `${p}.source names a file stored at the provider (a Files API id): ${SELF_CONTAINED}` };
      if (b.source.type === 'content') {
        const hit = anthropicBlocks(b.source.content, `${p}.source.content`);
        if (hit !== null) return hit;
      }
    }
    if (b.type === 'tool_result') {
      const hit = anthropicBlocks(b.content, `${p}.content`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * The first field of the request that leans on provider-side state (see the header), or null. Reads
 * only the places each route's API keeps such references.
 */
export function statefulField(route: PolicedRoute, json: Record<string, unknown>): StatefulField | null {
  if (route === 'anthropic.messages') {
    if (present(json.container)) return { param: 'container', message: `container reuses a code execution container kept at the provider: ${SELF_CONTAINED}` };
    const sys = anthropicBlocks(json.system, 'system');
    if (sys !== null) return sys;
    const messages = Array.isArray(json.messages) ? json.messages : [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const hit = isObj(m) ? anthropicBlocks(m.content, `messages[${i}].content`) : null;
      if (hit !== null) return hit;
    }
    return null;
  }
  if (route === 'openai.chat') {
    if (json.store === true) return { param: 'store', message: 'store: true keeps the completion at the provider (a stored completion): nothing of a trial is kept upstream, so leave store out or set it false' };
    const messages = Array.isArray(json.messages) ? json.messages : [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const hit = isObj(m) ? fileIdParts(m.content, `messages[${i}].content`) : null;
      if (hit !== null) return hit;
    }
    return null;
  }
  if (present(json.previous_response_id)) {
    return { param: 'previous_response_id', message: `previous_response_id continues a response stored at the provider: ${SELF_CONTAINED}, the whole conversation in input` };
  }
  if (present(json.conversation)) return { param: 'conversation', message: `conversation continues a conversation stored at the provider: ${SELF_CONTAINED}, the whole conversation in input` };
  if (json.store === true) return { param: 'store', message: 'store: true keeps the response at the provider for later requests: a trial is self-contained, so leave store out or set it false' };
  const input = Array.isArray(json.input) ? json.input : [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const p = `input[${i}]`;
    if (!isObj(item)) continue;
    if (item.type === 'item_reference') return { param: p, message: `${p} references an item stored at the provider: ${SELF_CONTAINED}` };
    const hit = fileIdParts(item.content, `${p}.content`) ?? fileIdParts(item.output, `${p}.output`);
    if (hit !== null) return hit;
  }
  const tools = Array.isArray(json.tools) ? json.tools : [];
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const p = `tools[${i}]`;
    if (!isObj(t)) continue;
    if (t.type === 'file_search') return { param: `${p}.vector_store_ids`, message: `${p} searches a vector store kept at the provider: ${SELF_CONTAINED}` };
    if (t.type === 'code_interpreter') {
      if (typeof t.container === 'string') return { param: `${p}.container`, message: `${p}.container reuses a container kept at the provider: ${SELF_CONTAINED}` };
      if (isObj(t.container) && Array.isArray(t.container.file_ids) && t.container.file_ids.length > 0) {
        return { param: `${p}.container.file_ids`, message: `${p}.container.file_ids names files stored at the provider: ${SELF_CONTAINED}` };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ the network (an offline bundle's)

/** A request field that has the provider reach the network for the entry: its path (OpenAI's `param` style) and why. */
export interface NetworkField {
  param: string;
  message: string;
}

/** A tool type the provider runs on the network: a web search, a web fetch, an MCP server or toolset. */
const NETWORK_TOOL_TYPE = /^(?:web_search|web_fetch|mcp)/;
/** The one inline form of an image URL: a data: URL. */
const DATA_URL = /^data:/i;

function offline(param: string, what: string, fix: string): NetworkField {
  return { param, message: `${what}; this competition is offline, so no model call may have the provider reach the network: ${fix}` };
}

/** The first tool whose type is a network tool's (every route: a `tools` list). */
function networkTool(tools: unknown): NetworkField | null {
  if (!Array.isArray(tools)) return null;
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (isObj(t) && typeof t.type === 'string' && NETWORK_TOOL_TYPE.test(t.type)) {
      return offline(`tools[${i}]`, `tools[${i}] is a ${t.type} tool, which the provider runs on the network`, 'leave the tool out');
    }
  }
  return null;
}

/** Anthropic content blocks: a URL source, and the blocks a tool result or a document's content source holds. */
function anthropicUrlSource(blocks: unknown, path: string): NetworkField | null {
  if (!Array.isArray(blocks)) return null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const p = `${path}[${i}]`;
    if (!isObj(b)) continue;
    if (isObj(b.source)) {
      if (b.source.type === 'url') return offline(`${p}.source`, `${p}.source is a URL the provider would fetch`, 'send the content inline, as a base64 source');
      if (b.source.type === 'content') {
        const hit = anthropicUrlSource(b.source.content, `${p}.source.content`);
        if (hit !== null) return hit;
      }
    }
    if (b.type === 'tool_result') {
      const hit = anthropicUrlSource(b.content, `${p}.content`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** An OpenAI content part given by URL: an image_url (chat's `{url}` or Responses' string) that is no data: URL, or a file_url. */
function openAiUrlPart(part: unknown, path: string): NetworkField | null {
  if (!isObj(part)) return null;
  const image = part.image_url;
  const url = isObj(image) ? image.url : image;
  const at = isObj(image) ? `${path}.image_url.url` : `${path}.image_url`;
  if (typeof url === 'string' && !DATA_URL.test(url)) {
    return offline(at, `${at} is a URL the provider would fetch, not a data: URL`, 'send the image inline, as a data: URL (base64)');
  }
  if (present(part.file_url)) return offline(`${path}.file_url`, `${path}.file_url is a URL the provider would fetch`, 'send the file inline, as file_data (base64)');
  return null;
}

function openAiUrlParts(parts: unknown, path: string): NetworkField | null {
  if (!Array.isArray(parts)) return null;
  for (let i = 0; i < parts.length; i++) {
    const hit = openAiUrlPart(parts[i], `${path}[${i}]`);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * The first field of the request that has the provider reach the network for the entry (see the
 * header's network_request), or null. Reads request structure alone: tool types, content sources and
 * their URLs, never text.
 */
export function networkField(route: PolicedRoute, json: Record<string, unknown>): NetworkField | null {
  const tool = networkTool(json.tools);
  if (tool !== null) return tool;
  if (route === 'anthropic.messages') {
    const servers = json.mcp_servers;
    if (Array.isArray(servers) ? servers.length > 0 : present(servers)) {
      return offline('mcp_servers', 'mcp_servers connects the provider to MCP servers on the network', 'leave it out');
    }
    const sys = anthropicUrlSource(json.system, 'system');
    if (sys !== null) return sys;
    const messages = Array.isArray(json.messages) ? json.messages : [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const hit = isObj(m) ? anthropicUrlSource(m.content, `messages[${i}].content`) : null;
      if (hit !== null) return hit;
    }
    return null;
  }
  if (route === 'openai.chat') {
    if (present(json.web_search_options)) return offline('web_search_options', 'web_search_options has the provider search the web', 'leave it out');
    const messages = Array.isArray(json.messages) ? json.messages : [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const hit = isObj(m) ? openAiUrlParts(m.content, `messages[${i}].content`) : null;
      if (hit !== null) return hit;
    }
    return null;
  }
  const input = Array.isArray(json.input) ? json.input : [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!isObj(item)) continue;
    const hit = openAiUrlParts(item.content, `input[${i}].content`) ?? openAiUrlParts(item.output, `input[${i}].output`);
    if (hit !== null) return hit;
  }
  return null;
}

// ------------------------------------------------------------------ service tiers

/**
 * The rate a call bills at, against its model's Standard (list) row (see the header): `flex`
 * (discounted), `priority` (OpenAI's Fast mode, Google's Priority inference, Anthropic's fast mode),
 * `ultrafast` (OpenAI's), or `unlisted`: a tier no vendor page prices for the model, billed at the
 * dearest rate known for it.
 */
export const RATE_TIERS = ['standard', 'flex', 'priority', 'ultrafast', 'unlisted'] as const;
export type RateTier = (typeof RATE_TIERS)[number];

/** What a call bills at: its tier, and Anthropic's US-only inference uplift on top of it. */
export interface BillingTier {
  tier: RateTier;
  /** An Anthropic `inference_geo` other than global: every rate × US_ONLY_UPLIFT. */
  us_only: boolean;
}

/** The list rate: what a call naming no tier bills at. */
export const LIST_TIER: Readonly<BillingTier> = Object.freeze({ tier: 'standard', us_only: false });

/**
 * The fields that name a call's tier, as a request sent them or a response reported them; a field
 * not said (absent or null) is left out. `service_tier` on every route; `speed` and `inference_geo`
 * on anthropic.messages alone.
 */
export interface TierFields {
  service_tier?: unknown;
  speed?: unknown;
  inference_geo?: unknown;
}

const said = (v: unknown): boolean => v !== undefined && v !== null;

/** The fields of a request body that name its tier (TierFields). */
export function requestTierFields(route: PolicedRoute, json: Record<string, unknown>): TierFields {
  const out: TierFields = {};
  if (said(json.service_tier)) out.service_tier = json.service_tier;
  if (route === 'anthropic.messages') {
    if (said(json.speed)) out.speed = json.speed;
    if (said(json.inference_geo)) out.inference_geo = json.inference_geo;
  }
  return Object.freeze(out);
}

/** OpenAI-shaped `service_tier` values that bill at Standard: OpenAI's "auto" (when the project's default is Standard) and "default", Google's "standard". */
const LIST_SERVICE_TIERS: ReadonlySet<string> = new Set(['auto', 'default', 'standard']);
/** Anthropic `service_tier` values that bill at Standard: the request's "auto" and "standard_only", the usage's "standard". */
const ANTHROPIC_LIST_SERVICE_TIERS: ReadonlySet<string> = new Set(['auto', 'standard_only', 'standard']);
/** Anthropic `inference_geo` values that bill at Standard (pricing/engine.ts ANTHROPIC_DEFAULTS reads the same). */
const LIST_GEOS: ReadonlySet<string> = new Set(['', 'global', 'not_available']);

/** An OpenAI-shaped `service_tier` (OpenAI's or Google's, asked or reported) as a rate tier; any value not listed is `unlisted`. */
function serviceTierRate(v: unknown): RateTier {
  if (!said(v)) return 'standard';
  if (typeof v !== 'string') return 'unlisted';
  if (LIST_SERVICE_TIERS.has(v)) return 'standard';
  if (v === 'flex') return 'flex';
  // OpenAI answers "priority" for a GPT-5.6 or earlier model asked for either (guides/fast-mode).
  if (v === 'priority' || v === 'fast') return 'priority';
  if (v === 'ultrafast') return 'ultrafast';
  return 'unlisted';
}

/**
 * What a call bills at, from the fields that name its tier (TierFields) on its route. On
 * anthropic.messages `speed: "fast"` is `priority`, any other speed or a `service_tier` that is not
 * one of the Standard values (usage's "priority": a Priority Tier commitment, priced by contract) is
 * `unlisted`, and an `inference_geo` that is not global sets `us_only`. Elsewhere `service_tier` alone
 * decides (serviceTierRate).
 */
export function billingTier(route: PolicedRoute, f: TierFields): BillingTier {
  if (route !== 'anthropic.messages') {
    const tier = serviceTierRate(f.service_tier);
    return tier === 'standard' ? LIST_TIER : Object.freeze({ tier, us_only: false });
  }
  const speed: RateTier = !said(f.speed) || f.speed === 'standard' ? 'standard' : f.speed === 'fast' ? 'priority' : 'unlisted';
  const service: RateTier = !said(f.service_tier) || (typeof f.service_tier === 'string' && ANTHROPIC_LIST_SERVICE_TIERS.has(f.service_tier)) ? 'standard' : 'unlisted';
  const tier: RateTier = service === 'unlisted' ? 'unlisted' : speed;
  const us_only = said(f.inference_geo) && !(typeof f.inference_geo === 'string' && LIST_GEOS.has(f.inference_geo));
  return tier === 'standard' && !us_only ? LIST_TIER : Object.freeze({ tier, us_only });
}

/** A multiple of a Standard rate, as numerator and denominator. */
export type Ratio = readonly [number, number];
type RateKey = 'input' | 'output' | 'cache_write_5m' | 'cache_write_1h' | 'cache_read';

/**
 * One model's published rates for one tier: `times` × its Standard row on every rate, period and
 * context, but for the rates the page prints at another multiple (`base`: at or under the row's
 * long-context threshold; `long`: past it). `long: 'unlisted'` is a page that prints no long-context
 * rate for the tier: past the threshold the tier bills at the dearest rate known for the model.
 * A cache write the rows bill at the input rate (no write price published) scales as input does.
 */
export interface PublishedTier {
  times: Ratio;
  base?: Partial<Record<RateKey, Ratio>>;
  long?: Partial<Record<RateKey, Ratio>> | 'unlisted';
}

/** The tiers a vendor publishes rates for (RATE_TIERS but `standard` and `unlisted`). */
export type PublishedRateTier = 'flex' | 'priority' | 'ultrafast';
export const PUBLISHED_RATE_TIERS: readonly PublishedRateTier[] = Object.freeze(['flex', 'priority', 'ultrafast'] as const);

const HALF: Ratio = [1, 2];
const TWICE: Ratio = [2, 1];
const GOOGLE_PRIORITY: Ratio = [9, 5];
const freezeTier = (t: PublishedTier): PublishedTier => Object.freeze({ ...t, ...(t.base ? { base: Object.freeze({ ...t.base }) } : {}), ...(t.long && t.long !== 'unlisted' ? { long: Object.freeze({ ...t.long }) } : {}) });
const tierTable = (rows: Record<string, PublishedTier>): Readonly<Record<string, PublishedTier>> =>
  Object.freeze(Object.fromEntries(Object.entries(rows).map(([model, t]) => [model, freezeTier(t)])));
const every = (models: readonly string[], t: PublishedTier): Record<string, PublishedTier> => Object.fromEntries(models.map((m) => [m, t]));

/**
 * Each tier's published rates, keyed by a model id its row bills (pricing/price.ts resolveRow: every
 * model on that row bills them, and two ids on one row must agree), as read on 2026-11-07:
 *
 *   OpenAI   developers.openai.com/api/docs/pricing.md, the Flagship tables (Standard, Flex, Fast,
 *            Ultrafast; "Priority processing was renamed Fast mode on July 30, 2026"), with
 *            /api/docs/guides/fast-mode.md (`service_tier` "fast", or "priority" "for supported
 *            models"; a project can make Fast its default for requests that name no tier; a request
 *            the ramp-rate limit downgrades is answered `service_tier: "default"` and charged
 *            Standard) and /api/docs/guides/ultrafast-mode.md (`service_tier: "ultrafast"`,
 *            gpt-6-astra and gpt-6.1-sol). Flex is half of Standard on every rate the tables print,
 *            but gpt-5.4's cached input ($0.13 against $0.25) and gpt-5.5-pro past 272K (no Flex
 *            price). Fast is 2× but gpt-5.5 (2.5×) and gpt-5-mini (1.8×), with no long-context Fast
 *            price for gpt-5.5 or gpt-5.4; gpt-5.6, which the page no longer lists, keeps the 2× its
 *            Fast row in pricing/rows.json was ported at (pricing/overrides.json, read 2026-10-27).
 *            Ultrafast is 6× on every rate. A model a table leaves out has no published rate there.
 *   Google   aistudio.google.com/docs/pricing (each model's Flex and Priority tabs), with
 *            /docs/openai ("Flex and Priority inference": `service_tier` "flex" or "priority",
 *            standard when none), /docs/flex-inference (no server-side fallback to Standard) and
 *            /docs/priority-inference (a request over the Priority limits is downgraded and "billed
 *            at the standard rate", named in the `x-gemini-service-tier` response header). Flex is
 *            half and Priority 1.8× of Standard on every rate and period, but gemini-3.5-flash-lite's
 *            context caching (Flex $0.02, Priority $0.05, against $0.03) and gemini-3.1-pro's Flex
 *            caching ("Same as Standard").
 *   Anthropic platform.claude.com/docs/en/about-claude/pricing.md ("Fast mode pricing": Opus 5.5 $8 /
 *            $40, Opus 5 and Opus 4.8 $10 / $50, prompt caching multipliers on top, the full context
 *            window; "Data residency pricing": `inference_geo: "us"` 1.1× on every rate, Claude 4.6
 *            and later) and /docs/en/build-with-claude/fast-mode.md (`speed: "fast"`, `usage.speed`
 *            says which ran). /docs/en/api/service-tiers.md prices Priority Tier by commitment alone.
 */
export const PUBLISHED_TIERS: Readonly<Record<PublishedRateTier, Readonly<Record<string, PublishedTier>>>> = Object.freeze({
  flex: tierTable({
    ...every(
      ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
      { times: HALF },
    ),
    'gpt-5.4': { times: HALF, base: { cache_read: [13, 25] } },
    'gpt-5.5-pro': { times: HALF, long: 'unlisted' },
    ...every(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite'], { times: HALF }),
    'gemini-3.5-flash-lite': { times: HALF, base: { cache_read: [2, 3] } },
    'gemini-3.1-pro': { times: HALF, base: { cache_read: [1, 1] }, long: { cache_read: [1, 1] } },
  }),
  priority: tierTable({
    ...every(
      ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5.3-codex'],
      { times: TWICE },
    ),
    'gpt-5.5': { times: [5, 2], long: 'unlisted' },
    'gpt-5.4': { times: TWICE, long: 'unlisted' },
    'gpt-5-mini': { times: [9, 5] },
    ...every(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro'], { times: GOOGLE_PRIORITY }),
    'gemini-3.5-flash-lite': { times: GOOGLE_PRIORITY, base: { cache_read: [5, 3] } },
    ...every(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'], { times: TWICE }),
  }),
  ultrafast: tierTable(every(['gpt-6-astra', 'gpt-6.1-sol'], { times: [6, 1] })),
});

/** Anthropic's US-only inference (`inference_geo: "us"`): 1.1× every rate, on top of the tier. */
export const US_ONLY_UPLIFT: Ratio = Object.freeze([11, 10] as const);

/** A rate × a ratio, rounded up: never under what the page prints. */
const scaled = (rate: number, [n, d]: Ratio): number => Math.ceil((rate * n) / d);

function scaleRates(r: RatesT, times: Ratio, per: Partial<Record<RateKey, Ratio>> = {}): RatesT {
  return {
    input: scaled(r.input, per.input ?? times),
    output: scaled(r.output, per.output ?? times),
    cache_write_5m: scaled(r.cache_write_5m, per.cache_write_5m ?? times),
    cache_write_1h: scaled(r.cache_write_1h, per.cache_write_1h ?? times),
    cache_read: scaled(r.cache_read, per.cache_read ?? times),
    audio: r.audio === null ? null : { input: scaled(r.audio.input, times), output: scaled(r.audio.output, times) },
  };
}

/** The dearest of several rate sets, rate by rate (an audio rate of null bills audio at the text rate). */
function dearestRates(sets: readonly RatesT[]): RatesT {
  const most = (pick: (r: RatesT) => number): number => Math.max(...sets.map(pick));
  return {
    input: most((r) => r.input),
    output: most((r) => r.output),
    cache_write_5m: most((r) => r.cache_write_5m),
    cache_write_1h: most((r) => r.cache_write_1h),
    cache_read: most((r) => r.cache_read),
    audio: sets.some((r) => r.audio !== null) ? { input: most((r) => r.audio?.input ?? r.input), output: most((r) => r.audio?.output ?? r.output) } : null,
  };
}

type PublishedRows = ReadonlyMap<number, ReadonlyMap<PublishedRateTier, PublishedTier>>;

/**
 * PUBLISHED_TIERS by the row of `list` each model bills on. Throws when two ids on one row disagree, or, on the bundled
 * rows (`strict`), when a model id there bills on no row; a held table that prices one on no row leaves it out.
 */
function publishedByRow(list: Pricer, strict: boolean): PublishedRows {
  const rows = new Map<number, Map<PublishedRateTier, PublishedTier>>();
  for (const tier of PUBLISHED_RATE_TIERS) {
    for (const [model, spec] of Object.entries(PUBLISHED_TIERS[tier])) {
      const row = list.resolveRow(model);
      if (row === null && !strict) continue;
      if (row === null) throw new Error(`service tiers: ${model} (${tier}) has no pricing row`);
      const tiers = rows.get(row) ?? new Map<PublishedRateTier, PublishedTier>();
      const had = tiers.get(tier);
      if (had !== undefined && JSON.stringify(had) !== JSON.stringify(spec)) throw new Error(`service tiers: ${model} prices row ${row}'s ${tier} tier unlike another model on that row`);
      tiers.set(tier, spec);
      rows.set(row, tiers);
    }
  }
  return rows;
}

const NO_TIERS: ReadonlyMap<PublishedRateTier, PublishedTier> = new Map();

/**
 * A Standard period of a row at `tier`: its published rates where `specs` (the row's published
 * tiers) has them; else, as for a tier no page prices for the model, the dearest rate it is known at
 * in that period (its Standard rates and every published tier's, short and long context alike), one
 * rate at any prompt size.
 */
function tierPeriod(p: PeriodT, tier: RateTier, specs: ReadonlyMap<PublishedRateTier, PublishedTier>): PeriodT {
  if (tier === 'standard') return p;
  const known: RatesT[] = [p.base];
  if (p.long_context !== null) known.push(p.long_context.rates);
  for (const s of specs.values()) {
    known.push(scaleRates(p.base, s.times, s.base));
    if (p.long_context !== null && s.long !== 'unlisted') known.push(scaleRates(p.long_context.rates, s.times, s.long));
  }
  const spec = tier === 'unlisted' ? undefined : specs.get(tier);
  if (spec === undefined) return { ...p, base: dearestRates(known), long_context: null };
  const long = p.long_context;
  return {
    ...p,
    base: scaleRates(p.base, spec.times, spec.base),
    long_context: long === null ? null : { ...long, rates: spec.long === 'unlisted' ? dearestRates(known) : scaleRates(long.rates, spec.times, spec.long) },
  };
}

function upliftPeriod(p: PeriodT): PeriodT {
  return { ...p, base: scaleRates(p.base, US_ONLY_UPLIFT), long_context: p.long_context === null ? null : { ...p.long_context, rates: scaleRates(p.long_context.rates, US_ONLY_UPLIFT) } };
}

/** One pricing table a trial is metered on (the header's `pricing table`): its rows at the list rate, and at each tier built from them. */
export class PricingTable {
  /** Its revision (pricing/engine.ts pricingRevOf): what the cassette of a trial it meters names (contracts/agent.ts Cassette.pricing_rev). */
  readonly rev: string;
  /** Its rows at the list rate. */
  readonly list: Pricer;
  /** The bundled rows' (pricing/price.ts), whose PUBLISHED_TIERS must each bill on a row. */
  readonly bundled: boolean;
  #published: PublishedRows | null = null;
  readonly #tiers = new Map<string, Pricer>();

  constructor(list: Pricer, bundled: boolean) {
    this.rev = list.pricingRev;
    this.list = list;
    this.bundled = bundled;
  }

  /** The row `model` bills on, or null when it is unpriced. */
  resolveRow(model: string): number | null {
    return this.list.resolveRow(model);
  }

  /** PUBLISHED_TIERS by this table's rows (publishedByRow), built once. */
  published(): PublishedRows {
    return (this.#published ??= publishedByRow(this.list, this.bundled));
  }

  /** The rows with every period at `t` (built once per tier): pricing/engine.ts prices them as it prices the list. */
  atTier(t: BillingTier): Pricer {
    const key = `${t.tier}${t.us_only ? '+us_only' : ''}`;
    let pricer = this.#tiers.get(key);
    if (pricer === undefined) {
      const byRow = this.published();
      const doc = this.list.doc;
      pricer = createPricer({
        ...doc,
        rows: doc.rows.map((row, i) => ({
          match: row.match,
          periods: row.periods.map((p) => {
            const at = tierPeriod(p, t.tier, byRow.get(i) ?? NO_TIERS);
            return t.us_only ? upliftPeriod(at) : at;
          }),
        })),
      });
      this.#tiers.set(key, pricer);
    }
    return pricer;
  }
}

const pricingTables = new Map<string, PricingTable>();

/**
 * The pricing table of revision `rev` (built once): the bundled rows' for the bundled revision, a held table's
 * (pricing/revs.ts pricerOfRev) for a held one, its tier tables read on its rows here, so a held table they cannot
 * be read on throws now; null for a revision this grader holds no table of.
 */
export function pricingTableOf(rev: string): PricingTable | null {
  const had = pricingTables.get(rev);
  if (had !== undefined) return had;
  let table: PricingTable;
  if (rev === pricingRev) table = new PricingTable(createPricer(PRICING_ROWS), true);
  else {
    const held = pricerOfRev(rev);
    if (held === null || !('doc' in held) || !('resolveRow' in held) || held.pricingRev !== rev) return null;
    table = new PricingTable(held as Pricer, false);
    table.published();
  }
  pricingTables.set(rev, table);
  return table;
}

/** The bundled rows' table (pricing/price.ts): what a policy naming no pricing_rev is metered on. */
export function bundledPricingTable(): PricingTable {
  return pricingTableOf(pricingRev)!;
}

/** A trial whose run is priced on a revision this grader holds no table of: the platform's fault, never the entry's. */
export class PricingRevisionNotHeldError extends Error {
  readonly pricing_rev: string;
  constructor(rev: string) {
    super(
      `this trial's run is priced on pricing revision ${rev}, which this grader holds no table of (it holds ${heldPricingRevs().join(', ')}: pricing/revs.ts): its trials are metered on one table, so this one cannot run here`,
    );
    this.name = 'PricingRevisionNotHeldError';
    this.pricing_rev = rev;
  }
}

/** The table `policy` is metered on: its pricing_rev's, the bundled rows' when it names none. Throws PricingRevisionNotHeldError for one this grader does not hold. */
export function policyPricingTable(policy: Pick<GatewayPolicyT, 'pricing_rev'>): PricingTable {
  if (policy.pricing_rev === undefined) return bundledPricingTable();
  const table = pricingTableOf(policy.pricing_rev);
  if (table === null) throw new PricingRevisionNotHeldError(policy.pricing_rev);
  return table;
}

const isList = (t: BillingTier): boolean => t.tier === 'standard' && !t.us_only;

/**
 * Price one call's usage at `tier` on `table` (default the bundled rows; its list pricer at the list rate). Its
 * pricingRev is the table's (the tier tables are this file's, under harness_version).
 */
export function priceAtTier(args: PriceUsageArgs, tier: BillingTier = LIST_TIER, table: PricingTable = bundledPricingTable()): PricedUsage {
  if (isList(tier)) return table.list.priceUsage(args);
  return { ...table.atTier(tier).priceUsage(args), pricingRev: table.rev };
}

/** The rates `model` bills at `at` and `tier` on `table` (default the bundled rows; a pricing/engine.ts period), or null when it has no row. */
export function tierPeriodAt(model: string, at: string, tier: BillingTier, table: PricingTable = bundledPricingTable()): PeriodT | null {
  const row = table.resolveRow(model);
  if (row === null) return null;
  return table.atTier(tier).periodAt(row, at);
}

/** A tier as a refusal message names it; '' for the list rate. */
function tierNote(t: BillingTier): string {
  if (isList(t)) return '';
  const rate = t.tier === 'standard' ? 'the standard rate' : t.tier === 'unlisted' ? 'the dearest rate known for this model, as the tier it names has no published price' : `the ${t.tier} rate`;
  return ` at ${rate}${t.us_only ? ' with the US-only inference uplift' : ''}`;
}

// ------------------------------------------------------------------ worst case

export interface WorstCase {
  /** ceil(body bytes / 3). */
  input_estimate: number;
  output_tokens: number;
  micro_usd: bigint;
  /** The tier it is priced at: the one the request names (billingTier). */
  tier: BillingTier;
}

const DEAREST_INPUT_CLASSES = ['input', 'cache_write_5m', 'cache_write_1h'] as const;

/**
 * The most a request can bill: `input_estimate` tokens at the dearest input class of `model`'s period
 * at `at`, plus `output_tokens` of output, at `tier` (default the list rate), on `table` (default the bundled
 * rows). Throws on an unpriced model (the policy refuses those first).
 */
export function worstCaseMicroUsd(args: { model: string; at: string; body_bytes: number; output_tokens: number; tier?: BillingTier; table?: PricingTable }): WorstCase {
  if (!Number.isSafeInteger(args.body_bytes) || args.body_bytes < 0) throw new RangeError(`worstCaseMicroUsd: body_bytes must be a non-negative safe integer, got ${args.body_bytes}`);
  const input_estimate = Math.ceil(args.body_bytes / BYTES_PER_INPUT_TOKEN);
  return pricedWorstCase({ model: args.model, at: args.at, input_estimate, output_tokens: args.output_tokens, tier: args.tier ?? LIST_TIER, ...(args.table === undefined ? {} : { table: args.table }) });
}

/** worstCaseMicroUsd from its input estimate: what meter.ts prices a reserved worst case at again, at the tier the call billed at. */
export function pricedWorstCase(args: { model: string; at: string; input_estimate: number; output_tokens: number; tier: BillingTier; table?: PricingTable }): WorstCase {
  for (const [what, n] of [['input_estimate', args.input_estimate], ['output_tokens', args.output_tokens]] as const) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`worstCaseMicroUsd: ${what} must be a non-negative safe integer, got ${n}`);
  }
  const table = args.table ?? bundledPricingTable();
  let most = -1n;
  for (const cls of DEAREST_INPUT_CLASSES) {
    const priced = priceAtTier({ model: args.model, at: args.at, format: 'tokens', usage: { [cls]: args.input_estimate, output: args.output_tokens } }, args.tier, table);
    if (priced.microUsd === null) throw new Error(`worstCaseMicroUsd: ${args.model} has no pricing row`);
    if (priced.microUsd > most) most = priced.microUsd;
  }
  return { input_estimate: args.input_estimate, output_tokens: args.output_tokens, micro_usd: most, tier: args.tier };
}

// ------------------------------------------------------------------ include_usage

/**
 * The body a streamed Chat Completions request is forwarded with: `stream_options.include_usage`
 * true. Null when it needs no change (not streamed, or include_usage already true).
 */
export function withIncludeUsage(req: ParsedRequest): string | null {
  if (!req.stream) return null;
  const opts = req.json.stream_options;
  if (!Object.hasOwn(req.json, 'stream_options')) {
    // `stream: true` is a member, so the object is not empty: a member spliced in after `{` keeps the
    // body valid and every other byte as sent.
    const brace = req.text.indexOf('{');
    return `${req.text.slice(0, brace + 1)}"stream_options":{"include_usage":true},${req.text.slice(brace + 1)}`;
  }
  if (opts !== null && typeof opts === 'object' && !Array.isArray(opts) && (opts as Record<string, unknown>).include_usage === true) return null;
  const merged = opts !== null && typeof opts === 'object' && !Array.isArray(opts) ? { ...(opts as Record<string, unknown>), include_usage: true } : { include_usage: true };
  return JSON.stringify({ ...req.json, stream_options: merged });
}

// ------------------------------------------------------------------ store: false

/**
 * The body a Responses request is forwarded with: `store` false, so the provider keeps no copy (see
 * the header). Null when it already says `store: false`.
 */
export function withStoreFalse(req: ParsedRequest): string | null {
  if (req.json.store === false) return null;
  if (!Object.hasOwn(req.json, 'store')) {
    // A JSON object's text opens with its brace (after any whitespace): a member spliced in after it
    // keeps every other byte as sent, with a comma unless the object is empty.
    const brace = req.text.indexOf('{');
    const comma = Object.keys(req.json).length === 0 ? '' : ',';
    return `${req.text.slice(0, brace + 1)}"store":false${comma}${req.text.slice(brace + 1)}`;
  }
  return JSON.stringify({ ...req.json, store: false });
}

// ------------------------------------------------------------------ the decision

/** The trial so far, as TrialMeter keeps it. */
export interface PolicyState {
  /** Requests forwarded so far, those in flight included. */
  forwarded: number;
  /** What the settled requests cost. */
  spent_micro_usd: bigint;
  /** The worst cases reserved by the requests in flight. */
  reserved_micro_usd: bigint;
}

export interface PolicyRequest {
  route: PolicedRoute;
  /** When the forwarder took the request (the entry's `at`): the instant it is priced at. */
  at: string;
  /** The body as received (only its first bytes when body_bytes says it was longer). */
  body: Uint8Array;
  /**
   * The body's whole size, when the forwarder stopped holding it past max_request_bytes (`body` is
   * then what it held). At least body.byteLength; absent, the body is whole.
   */
  body_bytes?: number;
  /**
   * Why the cassette could not key the body (cassette.ts UnkeyedRequest.error): the request is
   * refused as invalid_json with this message, even when a plain parse would take it (a leading BOM).
   */
  unkeyed?: string;
}

export interface Refusal {
  type: PolicyRefusalType;
  status: 400 | 413 | 429;
  /** The request field at fault, or null. */
  param: string | null;
  message: string;
  /** budget − spent − reserved, never below 0. */
  remaining_micro_usd: bigint;
}

export interface RefusalResponse {
  status: number;
  content_type: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface PolicyAllow {
  allow: true;
  model: string;
  stream: boolean;
  /** Priced at the tier the request names (worst.tier). */
  worst: WorstCase;
  /** The fields of the request that name its tier, as sent (requestTierFields): meter.ts settles at them where the response says nothing. */
  asked: TierFields;
  /**
   * The bytes to forward: the body as received, or with include_usage set (openai.chat, streamed),
   * or with store: false set (openai.responses, unless it already said so).
   */
  forward_body: Uint8Array;
  include_usage_injected: boolean;
  store_false_injected: boolean;
}

export interface PolicyRefuse {
  allow: false;
  /** What the cassette entry records: the model the body named (null when none or not JSON) and whether it asked to stream. */
  model: string | null;
  stream: boolean;
  /** False when the body is not a JSON object (the entry has no request key). */
  json: boolean;
  refusal: Refusal;
  response: RefusalResponse;
}

export type PolicyDecision = PolicyAllow | PolicyRefuse;

/** What is left of the budget: budget − spent − reserved, never below 0. */
export function remainingMicroUsd(policy: GatewayPolicyT, state: PolicyState): bigint {
  const left = BigInt(policy.budget_micro_usd) - state.spent_micro_usd - state.reserved_micro_usd;
  return left > 0n ? left : 0n;
}

/** Check one request against the policy, given the trial so far. */
export function checkRequest(policy: GatewayPolicyT, state: PolicyState, req: PolicyRequest): PolicyDecision {
  if (!(POLICED_ROUTES as readonly string[]).includes(req.route)) throw new TypeError(`checkRequest: ${String(req.route)} is not a policed route`);
  const size = req.body_bytes ?? req.body.byteLength;
  if (!Number.isSafeInteger(size) || size < req.body.byteLength) throw new RangeError(`checkRequest: body_bytes ${req.body_bytes} is less than the ${req.body.byteLength} bytes held`);
  const remaining = remainingMicroUsd(policy, state);
  // A body not held whole, or one the cassette could not key, is not read as JSON at all.
  const parsed = req.unkeyed === undefined && size === req.body.byteLength ? parseRequestBody(req.body) : null;
  const refuse = (type: PolicyRefusalType, param: string | null, message: string): PolicyRefuse => {
    const refusal: Refusal = { type, status: REFUSAL_STATUS[type], param, message, remaining_micro_usd: remaining };
    return { allow: false, model: parsed?.model ?? null, stream: parsed?.stream ?? false, json: parsed !== null, refusal, response: refusalResponse(req.route, refusal) };
  };

  if (size > policy.max_request_bytes) {
    return refuse('request_too_large', null, `the request body is ${size} bytes, over this competition's cap of ${policy.max_request_bytes}`);
  }
  if (parsed === null) return refuse('invalid_json', null, req.unkeyed ?? 'the request body is not a JSON object');

  const stateful = statefulField(req.route, parsed.json);
  if (stateful !== null) return refuse('stateful_request', stateful.param, stateful.message);

  if (policy.offline === true) {
    const network = networkField(req.route, parsed.json);
    if (network !== null) return refuse(NETWORK_REFUSAL, network.param, network.message);
  }

  const model = parsed.model;
  if (model === null) return refuse('model_not_allowed', 'model', `the request names no model; this competition allows ${policy.models.join(', ')}`);
  if (!modelAllowed(policy.models, model)) return refuse('model_not_allowed', 'model', `${model} is not allowed; this competition allows ${policy.models.join(', ')}`);
  const table = policyPricingTable(policy);
  if (table.resolveRow(model) === null) return refuse('model_not_allowed', 'model', `${model} has no price, so it cannot be metered: name a priced model`);

  const cap = outputCap(req.route, parsed.json, policy.max_output_tokens_per_request);
  if (!cap.ok) return refuse('max_tokens_required', cap.param, cap.message);

  if (state.forwarded >= policy.max_requests_per_trial) {
    return refuse('request_cap', null, `this trial has made its ${policy.max_requests_per_trial} requests`);
  }

  // A huge `n` saturates rather than overflowing (the pricer reads an unsafe count as 0).
  const outputTokens = Math.min(cap.per_choice * cap.choices, Number.MAX_SAFE_INTEGER);
  // Reserved at the tier the request names: a service tier is priced, never refused.
  const asked = requestTierFields(req.route, parsed.json);
  const tier = billingTier(req.route, asked);
  const worst = worstCaseMicroUsd({ model, at: req.at, body_bytes: req.body.byteLength, output_tokens: outputTokens, tier, table });
  // Unclamped: a trial already past its budget refuses even a free request.
  if (worst.micro_usd + state.spent_micro_usd + state.reserved_micro_usd > BigInt(policy.budget_micro_usd)) {
    const inFlight = state.reserved_micro_usd > 0n ? `, ${state.reserved_micro_usd} of it reserved by requests in flight` : '';
    return refuse(
      'budget_exhausted',
      null,
      `this request may cost up to ${worst.micro_usd} micro-USD (about ${worst.input_estimate} input tokens and ${worst.output_tokens} output tokens${tierNote(tier)}), over the ${remaining} micro-USD left of this trial's budget of ${policy.budget_micro_usd}${inFlight}`,
    );
  }

  // At most one route's rewrite applies; parsed.json is never mutated, so the cassette's key of the
  // body as received stands.
  const withUsage = req.route === 'openai.chat' ? withIncludeUsage(parsed) : null;
  const withStore = req.route === 'openai.responses' ? withStoreFalse(parsed) : null;
  const rewritten = withUsage ?? withStore;
  return {
    allow: true,
    model,
    stream: parsed.stream,
    worst,
    asked,
    forward_body: rewritten === null ? req.body : encoder.encode(rewritten),
    include_usage_injected: withUsage !== null,
    store_false_injected: withStore !== null,
  };
}

/** A refusal in the route's vendor error shape. */
export function refusalResponse(route: PolicedRoute, refusal: Refusal): RefusalResponse {
  const remaining_micro_usd = refusal.remaining_micro_usd.toString();
  const doc =
    route === 'anthropic.messages'
      ? { type: 'error', error: { type: refusal.type, message: refusal.message, remaining_micro_usd } }
      : { error: { message: refusal.message, type: refusal.type, param: refusal.param, code: refusal.type, remaining_micro_usd } };
  return { status: refusal.status, content_type: REFUSAL_HEADERS['content-type']!, headers: REFUSAL_HEADERS, body: encoder.encode(JSON.stringify(doc)) };
}
