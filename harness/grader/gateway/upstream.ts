// The gateway forwarder's upstreams: where a request the policy admitted goes, and the only code in the
// forwarder that dials out. The forwarder (grader/gateway/server.ts) hands an adapter the route, the
// client headers its allowlist kept (and the house lane's own: server.ts HOUSE_UPSTREAM_HEADERS) and
// the body to send; the adapter adds the key and answers the response head and its body, decoded. It
// never follows a redirect: a 3xx comes back as it is, and the forwarder answers it 502.
//
//   masq     the platform's broker, and the upstream of every house-paid trial: at the one origin the
//            config names (http or https, no path, query or credentials), every route's path on it,
//            the trial's own masq key (x-api-key on Messages, Authorization: Bearer on the OpenAI
//            routes) and MASQ_HEADERS on every request (x-masq-pin: strict, no substitution or
//            reroute, upstream errors passed through; x-masq-verbatim: 1; x-masq-policy: off).
//            grader/gateway/masq.ts mints and retires the key. A refusal masq makes itself (the key
//            unknown, disabled or expired: 401 authentication_error; over its daily cap: 402
//            permission_error; a model off its allowlist: 403 permission_error; no pooled seat it
//            may use, or no seat for a new key to bind to: 429 rate_limit_error) comes back in the same
//            vendor error document, status and type as a provider's error masq relays, with no header
//            or field of its own: only the sentence differs. So none is told apart here: each is
//            relayed as it came and metered by its status (meter.ts): an upstream error, charged the
//            usage its body reports, and a refusal's body reports none, so it costs 0. Two are told
//            apart by their sentences, and only by the forwarder's house lane on masq (a Claude
//            target's: a router-served target's lane is on `router`, below, and never waits out masq's
//            door): no pooled seat and no seat for this caller (masqSeatRefusal), the ones a short
//            wait can change, which server.ts sendPastSeatRefusals sends again before it answers.
//            Every 2xx is answered by the model the request named, or it is no answer (vetServedModel):
//            masq names a model it swapped in (its policy detour, a substitution, a quota hop, an
//            empty-reply reroute) in x-masq-model, and the body names the model that served it (the
//            JSON's `model`; on a stream the first event that names one: Messages' message_start,
//            a chat chunk, a Response's response.created). A swap named either way, or a 2xx that
//            names no model, rejects as UpstreamError `model`: the forwarder answers 502 and records an
//            upstream_error charged nothing, so neither the meter nor the cassette ever holds another
//            model's answer as the trial's. Until the model is read the body is held (a stream's
//            first events, a JSON body whole; at most MAX_SERVED_MODEL_SCAN_BYTES), then relayed as it
//            came. An error status, or an error document or event before any model, is relayed as it
//            came: it is no answer. One of masq's route rows (MASQ_ROUTE_ROWS) is one model to the
//            check: a request for `superbot-router/superbot` is answered by it or by `superbot`, one for
//            `superbot-router/superbot-fast` by it, `superbot-flash` or `superbot-fast` (isServedModel).
//   router   superbot-router, the house's own serving, and the upstream of a house lane whose target names
//            a model the router serves (routerUpstream): at the one origin the config names (as masq's),
//            on the house lane's router key, Messages alone (any other route rejects as `protocol`,
//            unsent) and the router's bare house ids alone (ROUTER_HOUSE_MODELS: `superbot`,
//            `superbot-fast`; any other id, masq's `superbot-router/...` spellings included, rejects as
//            `model`, unsent). Every request is POST /v1/messages with exactly x-api-key, anthropic-version
//            (the request's, else ROUTER_ANTHROPIC_VERSION 2023-06-01), x-sbr-speed (the config's
//            `speed`: flex or standard), content-type, content-length, accept: text/event-stream,
//            accept-encoding: identity and user-agent: no MASQ_HEADERS, no x-masq-* or x-cosmos-* header
//            (the side spawn is masq's) and no other x-sbr-*, whatever the request carries. With the
//            config's `user` the body's metadata.user_id is set to it (its other metadata kept): the
//            router buckets a caller's streams by it, and without one by key and prompt head, so every
//            house call of a contest would share one bucket. One retry ladder and no other layer (the house
//            key's batch-lane ladder, ~/.cosmos/rules/superbot-router-client.mdc: nothing above it retries):
//            an answer of status 429, 503 or 529 with a retry-after of whole seconds and no
//            x-should-retry: false (routerRetryWaitMs; the router's pool-full 529 `x-sbr-shed: pool` is one)
//            is read and dropped, the adapter waits the router's own retry-after held to 2 to 60 s
//            (routerHouseWaitMs; ended by the request's signal, no timer of the adapter's own) and sends the
//            same bytes and headers again, at most ROUTER_HOUSE_TRIES (8) sends in all; the first answer
//            that is no such refusal is the answer, and so is the 8th whatever it is. Every wait ends inside
//            ROUTER_HOUSE_LADDER_MS (150 s) from the first send: one that would end later is not taken, and
//            that refusal is the answer (an upstream error: the pass voids and re-runs). So a busy pool
//            delays a house move and never voids its trial. Nothing else is sent again: not a 5xx without
//            retry-after, not a 3xx, not a reset, not anything after a body byte. A 2xx (the answer the
//            ladder returns) must name the model asked, exactly (vetServedModel with
//            the router's check: no swap header, no routing grammar peeled, no release date): the router
//            echoes the id asked, so this proves only that the answer is for this request; which engine
//            served it is the stream's closing `sbr` marker, read by the forwarder (server.ts).
//   provider the entrant's own provider on the entrant's own key (house money never pays for an
//            entrant's model calls), the provider-lane entry secret its entrant pushed
//            (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY or GOOGLE_API_KEY), for
//            every entry lane an entrant's entry runs (with none, model-free). The model a request names
//            picks the provider (contracts/entry-secrets.ts providerOfModel) and its route the wire,
//            as PROVIDER_ROUTES (grader/gateway/providers.ts, the one platform module that names the
//            providers' origins) serves them on an entrant's key:
//              anthropic.messages  claude-*                   Anthropic, POST /v1/messages, x-api-key
//              openai.chat         gpt-*, chatgpt-*, o<digit>* OpenAI, POST /v1/chat/completions, Bearer
//                                  gemini-*                   Google, POST /v1beta/openai/chat/completions
//                                                             (its OpenAI-compatible surface), Bearer
//                                  openrouter/*               OpenRouter, POST /api/v1/chat/completions, Bearer
//              openai.responses    gpt-*, chatgpt-*, o<digit>* OpenAI, POST /v1/responses, Bearer
//            Each provider is sent its own id for the model (providerWireModel): the gateway-side spelling
//            — masq's provider prefix (`anthropic/`, `claude:`, `openai/`, `google/`, `gemini/`, `router/`,
//            …: contracts/entry-secrets.ts MASQ_PROVIDER_PREFIX) or this lane's `openrouter/` — names how
//            an id routes and never reaches a provider's wire. `openrouter/liquid/lfm-3-1.7b:free` is sent
//            with `"model":"liquid/lfm-3-1.7b:free"`, the id OpenRouter accepts and echoes back, and
//            `anthropic/claude-opus-5-5` with `"model":"claude-opus-5-5"`; a 2xx must name that same
//            provider id (an answer naming the prefixed spelling is another model). OpenRouter refuses the
//            prefixed id as no model of its own (free-model-aggregator-02's first live trial got HTTP 400
//            on it), and Anthropic refuses `anthropic/claude-opus-5-5` alike. An id with no prefix — a
//            fine-tuned `ft:…`, a model whose name merely contains a slash (`o3/mini`) — is sent as it came.
//            The adapter answers its refusals itself, never sending them, in the route's vendor shape
//            (vendorErrorBody), recorded like any answer so a replay serves them alike:
//              400 invalid_request_error  a model its provider does not serve on this route on an
//                                         entrant's key (a gemini model on Responses, a claude model on
//                                         an OpenAI route, a gpt one on Messages), a model no entrant's
//                                         key reaches (the message names the route to call: providerFor),
//                                         or OpenRouter's `openrouter/` prefix with no id after it. The
//                                         meter reads it as the entry's own 4xx.
//              401 authentication_error   a provider no key of the entrant's reaches (noProviderKeyMessage):
//                                         the message names the entry secret that carries one, by the
//                                         provider's name for it (contracts/entry-secrets.ts
//                                         SECRET_PROVIDER_ENV: ANTHROPIC_API_KEY, OPENAI_API_KEY,
//                                         OPENROUTER_API_KEY, GEMINI_API_KEY) in a .env, and `makefun
//                                         secrets push <slug> --dotenv .env`; on a config
//                                         whose `entry_secrets` is off (the deployment that wrote it has
//                                         no seal public key, MAKEFUN_ENTRY_SECRET_SEAL_PUBLIC_KEY, so a push
//                                         answers 503 entry_secrets_off there: server/secrets/store.ts)
//                                         it says pushing a secret is not open on this site yet and names
//                                         no command. The meter reads it as an upstream error, which on
//                                         an entrant's key is the entrant's and never counts toward the
//                                         void rule (meter.ts).
//            The request carries the provider's own auth (providers.ts vendorAuth: x-api-key and
//            anthropic-version 2023-06-01, or a bearer), then the client's own headers for that provider
//            alone (PROVIDER_CLIENT_HEADERS, so a client's newer anthropic-version is kept, never
//            downgraded), content-type, content-length, accept-encoding: identity and user-agent: no
//            MASQ_HEADERS, no x-masq-* or x-cosmos-* (the house lane's side spawn) and nothing of another
//            provider's. TLS is verified, https only, as for masq. A 2xx must be the provider's own
//            answer for the model asked (vetServedModel with isProviderServedModel: the id the provider was
//            sent — providerWireModel's, OpenRouter's bare slug or Anthropic's own id for `anthropic/<id>` —
//            or it under a release date, so an answer naming the gateway-side spelling is another model;
//            no x-masq-model is read, no routing grammar peeled), else
//            UpstreamError `model` as for masq. Google's OpenAI-compatible chat names the id asked for,
//            bare, in every chunk (a Gemini 3.7 Flash answer and stream quoted in
//            github.com/googleapis/python-genai/issues/2868, 2026-08-17, and a Gemini 3 Flash stream on
//            discuss.ai.google.dev/t/127400, 2026-02-27), takes stream_options.include_usage (its docs'
//            streamed extra_body example sets it: aistudio.google.com/docs/openai, read 2026-11-06) and
//            reports usage in every chunk, its thinking in total_tokens alone (meter.ts
//            withGoogleThinking). The keys and the config's `mask` values (the entrant's env-lane entry
//            secrets, and the org and project ids the worker's key check learned) are the forwarder's
//            secrets (main.ts): every form of each (grader/gateway/secret-mask.ts secretForms, and each
//            key or value whole whatever its length: secretFormSet) is masked out of every answer and
//            out of every fault message, this adapter's own included (a key's echoed runs too:
//            providers.ts redactKeys). An id the check never learned (one a provider names only in a
//            later answer) is not masked.
//   fake     a scripted upstream for tests: replies in order (or from a function), with delays, a
//            refused connection, a reset mid-body; it never touches the network, and it checks no model.
//   none     no model at all: every request fails as `connect` with NO_MODEL_MESSAGE, which says
//            plainly that the competition provides no model, and the forwarder answers it 502 and
//            records an upstream_error charged nothing (never a model call). cli/grade-local.ts
//            NO_MODEL_UPSTREAM: a local grade given no provider key nor --gateway on a competition that
//            does not require model calls and names no target. It never touches the network, and the
//            config's key (a live config on it always carries one) reaches nothing.
//
// masq's policy detour (masq src/policy.ts, at /opt/masq/src 960a61a): a prompt a vendor refuses on
// content policy is re-asked on another vendor's model down the chain for the refused model (live on
// s5: claude-sonnet* -> superbot-router/DeepSeek-V4.1-Flash-Uncensored[1m]-max), and the answer comes
// back as a 200 from that model. x-masq-policy: off turns it off for one request (src/server.ts:7142,
// `detourRefused`, which x-masq-pin: strict also sets; it ends the walk at :7363), and it also stops
// the empty-reply reroute (:7756); the other switches are the operator's (`masq policy off`, an empty
// chain). A key's allowed-models list does keep the detour to models on it (:7393), but a key minted
// with none allows every rung, so the header, not the key, is what turns it off.
//
// No adapter but `provider` reaches a model provider: a house-paid trial's model calls go through masq,
// on the masq key minted for it, or, for a house lane whose models the router serves, to the house's own
// superbot-router (`router`, at the origin its config names: no file names a host for it), and nowhere
// else, and `provider` reaches only the provider the
// entrant's own key is for, at providers.ts's origins (tests/unit/masq-only.test.ts fails on a
// provider's API host named anywhere in grader/ or server/ but providers.ts, and lets only this file of
// the forwarder import it). The vendor of a route (ROUTE_VENDOR) names its wire shape, the header the
// masq key goes in and the shape of an error document, never a destination.
//
// Every request to masq (and to the router or a provider, with its own headers as above):
//   - goes to ROUTE_PATHS[route] on the configured origin: the client's path, query and Host never
//     reach it;
//   - carries the headers it was given (the allowlisted client headers; on the house lane, its
//     x-cosmos-side-spawn), MASQ_HEADERS, the key, content-type application/json, content-length,
//     accept-encoding: identity and user-agent GATEWAY_USER_AGENT, and nothing else;
//   - verifies TLS (rejectUnauthorized true, whatever NODE_TLS_REJECT_UNAUTHORIZED says);
//   - fails a connection not made, TLS handshake included, within CONNECT_TIMEOUT_MS (10 s);
//   - refuses response headers over MAX_UPSTREAM_HEADER_BYTES (64 KiB);
//   - is torn down when the forwarder's signal aborts (a client gone, the 300 s stream total, shutdown).
// A body the upstream encodes anyway (gzip, deflate, br; zstd where this Node has it) is decoded here,
// so the forwarder relays and meters identity bytes; any other content-encoding fails as `protocol`.

import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { pipeline, type Readable, type Transform } from 'node:stream';
import * as zlib from 'node:zlib';
import { z } from 'zod';
import { ENTRY_SECRET_MAX_COUNT, ENTRY_SECRET_VALUE_MAX_BYTES, providerOfModel, SECRET_PROVIDER_ENV } from '../../contracts/entry-secrets.ts';
import { SseParser } from './meter.ts';
import type { PolicedRoute } from './policy.ts';
import { PROVIDER_NAMES, PROVIDER_ORIGINS, PROVIDER_ROUTES, PROVIDERS, redactKeys, vendorAuth as providerAuth, type Provider } from './providers.ts';
import { FormSet, maskText, SECRET_FORM_MIN_CHARS, secretForms } from './secret-mask.ts';

/** A route's wire shape: Anthropic Messages, or the OpenAI routes (see the header). */
export type Vendor = 'anthropic' | 'openai';

/** The path each route is sent to upstream (no query: the client's never passes). */
export const ROUTE_PATHS: Readonly<Record<PolicedRoute, string>> = Object.freeze({
  'anthropic.messages': '/v1/messages',
  'openai.chat': '/v1/chat/completions',
  'openai.responses': '/v1/responses',
});

export const ROUTE_VENDOR: Readonly<Record<PolicedRoute, Vendor>> = Object.freeze({
  'anthropic.messages': 'anthropic',
  'openai.chat': 'openai',
  'openai.responses': 'openai',
});

/**
 * What every request to masq carries (plan step 6): the pin (masq src/pin.ts: no substitution,
 * reroute or rescue onto another model or box), verbatim (src/rewrite-request.ts: the prompt reaches
 * the model unrewritten) and policy off (src/server.ts:7142: no detour onto another vendor's model
 * after a content-policy refusal; the refusal comes back as it came).
 */
export const MASQ_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-masq-pin': 'strict',
  'x-masq-verbatim': '1',
  'x-masq-policy': 'off',
});

export const CONNECT_TIMEOUT_MS = 10_000;
export const MAX_UPSTREAM_HEADER_BYTES = 64 * 1024;
export const GATEWAY_USER_AGENT = 'makefun-gateway/1';

// ------------------------------------------------------------------ the adapter interface

export interface UpstreamRequest {
  route: PolicedRoute;
  /** Client headers the forwarder's allowlist kept, then its lane's own (server.ts upstreamHeaders), lowercase names. Never auth: the adapter adds the key. */
  headers: Readonly<Record<string, string>>;
  /** The bytes to send (policy.ts PolicyAllow.forward_body). */
  body: Uint8Array;
  /** Aborted when the client goes, the stream total runs out or the forwarder shuts down. */
  signal: AbortSignal;
}

export interface UpstreamResponse {
  status: number;
  /** Response headers, lowercase, repeated ones joined with ', '; content-encoding and content-length dropped once decoded. */
  headers: Readonly<Record<string, string>>;
  /** The body, decoded to identity. Iterating throws UpstreamError on a reset, a decoding fault or an abort. */
  body: AsyncIterable<Uint8Array>;
}

/**
 * How an exchange failed: no connection (refused, unresolved, connect timeout), TLS (a certificate not
 * verified, a handshake failed), reset (the connection dropped), protocol (a malformed or undecodable
 * response), aborted (the forwarder's signal), model (a 2xx answered by a model other than the one the
 * request named, or naming none: vetServedModel).
 */
export type UpstreamFailure = 'connect' | 'tls' | 'reset' | 'protocol' | 'aborted' | 'model';

export class UpstreamError extends Error {
  readonly kind: UpstreamFailure;
  constructor(kind: UpstreamFailure, message: string) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = kind;
  }
}

export interface Upstream {
  readonly kind: 'masq' | 'router' | 'provider' | 'fake' | 'none';
  /** Send one request: the response head and its body, or a rejection with UpstreamError (nothing came back). */
  send(req: UpstreamRequest): Promise<UpstreamResponse>;
  /** Drop idle connections: the forwarder is done. */
  close(): void;
}

const encoder = new TextEncoder();

/** An error document in the route's vendor shape (the forwarder's own errors). */
export function vendorErrorBody(route: PolicedRoute, type: string, message: string): Uint8Array {
  const doc = ROUTE_VENDOR[route] === 'anthropic' ? { type: 'error', error: { type, message } } : { error: { message, type, param: null, code: type } };
  return encoder.encode(JSON.stringify(doc));
}

// ------------------------------------------------------------------ masq's door: no pooled seat, no seat for this caller

/** The status masq refuses a request with when no seat may serve it (and a provider's rate limit, relayed, alike). */
export const MASQ_SEAT_REFUSAL_STATUS = 429;
/** The most of a 429 body read to tell masq's seat refusal (a short error document) from anything else; past it, it is no refusal of masq's. */
export const MAX_SEAT_REFUSAL_BYTES = 16 * 1024;

/**
 * masq's sentence for a request it refuses at its door because every pooled seat the key may use is revoked, exhausted,
 * disabled, held or cooling (its requests row's error type `pool_unavailable`), in its two forms, from masq's own
 * source (src/server.ts handleInference, read at masq 9322efc): the door, for a key with a routing policy (`No allowed
 * account can serve <model> for this key: <cause>.`), and the pooled vendor with nothing eligible (quotaRefusalMessage:
 * `No <vendor> account has usable quota right now. Usage resets on the vendor’s own window; retry shortly. Pool:
 * <cause>.`), where the cause as the caller hears it is doorRefusalCause's `no usable seat` (an older masq put the seat
 * counts after it, in brackets). The heads are the ones masq keeps for its clients to match on (its
 * test/door-refusal.mjs UNSERVABLE_ACCOUNT_RE, GATEWAY_QUOTA_REFUSAL). The other causes on the same sentences
 * (`excluded by this key's policy`, the fable ceiling's own sentence) and masq's other 429 (`key concurrency limit
 * reached`) are not this, and neither is anything a provider says.
 */
export const MASQ_NO_SEAT_SENTENCE = /^(?:No allowed account can serve \S+ for this key: |No \S+ account has usable quota right now\.[^\n]* Pool: )no usable seat\b/;

/**
 * masq's whole message when it refuses a caller key a seat to bind to (src/server.ts handleInference): each key binds to
 * one seat, at most 10 keys a seat (MASQ_BIND_MAX_KEYS_PER_SEAT), and a new key is refused while every load-admitted seat
 * is at its ceiling, with Retry-After 2 s. The request reached no provider and cost nothing. Matched whole, never as a
 * prefix.
 */
export const MASQ_CALLER_SEAT_SENTENCE = /^no seat is available for this caller; retrying shortly$/;

/**
 * Whether an answer is masq refusing at its own door for want of a seat (see above): status 429, and a body that is one
 * vendor error document (Messages' `{type: 'error', error}` or the OpenAI routes' `{error}`) of type rate_limit_error
 * whose message opens with one of masq's two no-pooled-seat sentences or is, whole, its no-seat-for-this-caller one.
 * masq adds no header or field of its own to either (see the header), so the sentence is all that tells it from a
 * provider's rate limit masq relays, which never says it. Such a request reached no provider and cost nothing.
 */
export function masqSeatRefusal(status: number, body: Uint8Array): boolean {
  if (status !== MASQ_SEAT_REFUSAL_STATUS || body.byteLength > MAX_SEAT_REFUSAL_BYTES) return false;
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return false;
  }
  if (!isRecord(doc) || !isRecord(doc.error)) return false;
  if (doc.type !== undefined && doc.type !== 'error') return false;
  const { type, message } = doc.error;
  if (type !== 'rate_limit_error' || typeof message !== 'string') return false;
  return MASQ_NO_SEAT_SENTENCE.test(message) || MASQ_CALLER_SEAT_SENTENCE.test(message);
}

// ------------------------------------------------------------------ origins and keys

/** An origin as the config gives it: http or https, a host, an optional port, and nothing else. */
export function parseOrigin(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(`upstream origin ${JSON.stringify(text)} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`upstream origin ${JSON.stringify(text)} is not http or https`);
  if (url.username !== '' || url.password !== '') throw new TypeError(`upstream origin ${JSON.stringify(text)} carries credentials: the key goes in the config's key`);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(text)) throw new TypeError(`upstream origin ${JSON.stringify(text)} has a path, query or fragment: an origin is scheme, host and port only`);
  if (text.replace(/\/$/, '') !== url.origin) throw new TypeError(`upstream origin ${JSON.stringify(text)} is not in its plain form ${url.origin}`);
  return url;
}

/** A key the forwarder can put in a header as it is: visible ASCII, no spaces, at most 4096 characters. */
export const UpstreamKey = z.string().regex(/^[\x21-\x7e]{1,4096}$/, 'a key is 1 to 4096 visible ASCII characters');

export const UpstreamOrigin = z.string().superRefine((s, ctx) => {
  try {
    parseOrigin(s);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
  }
});

/** The header a route's masq key goes in: x-api-key on Messages, a bearer on the OpenAI routes. */
function vendorAuth(vendor: Vendor, key: string): Record<string, string> {
  return vendor === 'anthropic' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` };
}

// ------------------------------------------------------------------ the served model

/**
 * The response header masq names a model it swapped in with: its policy detour (masq src/server.ts
 * setDetourHeaders, :7909), a substitution or quota hop (:3678, :3753, :3940, :5058, :6147) and an
 * empty-reply reroute (:7865). Absent when the model asked for answered.
 */
export const MASQ_MODEL_HEADER = 'x-masq-model';

/** The most of a 2xx body masqUpstream holds to read the model that served it; past it the answer is refused. */
export const MAX_SERVED_MODEL_SCAN_BYTES = 16 * 1024 * 1024;

// masq's routing grammar on a model id (masq src/models.ts PROVIDER_PREFIX :149, GATEWAY_EFFORT :197,
// NAMED_EFFORT :862, CONTEXT_TAG :615): a provider prefix, a `(word)` or `-high` effort and a `[1m]`
// context tag say how a model is reached and served, never which model it is.
const PROVIDER_PREFIX = /^(?:anthropic|claude|openai|xai|x-ai|grok|google|gemini|meta)[:/]|^(?:openrouter|groq|compat|local):|^router[/:]/;
const GATEWAY_EFFORT = /\([^()]*\)$/;
const NAMED_EFFORT = /[-:](?:minimal|low|medium|high|xhigh|max)$/;
const CONTEXT_TAG = /\[[^\]]*\]$/;
/** The release date an alias is answered under (`claude-sonnet-4-5-20250929`, `gpt-4o-2024-08-06`). */
const RELEASE_DATE = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/** The model an id names: lowercase, with masq's routing grammar peeled off (repeatedly, in any order). */
export function modelIdentity(id: string): string {
  let m = id.trim().toLowerCase().replace(PROVIDER_PREFIX, '');
  for (;;) {
    const next = m.replace(GATEWAY_EFFORT, '').replace(NAMED_EFFORT, '').replace(CONTEXT_TAG, '');
    if (next === m) return m;
    m = next;
  }
}

/** One of masq's route rows: the id masq takes, the id it routes that to, and the name masq's answer gives the model served. */
export interface MasqRouteRow {
  readonly asked: string;
  readonly routed: string;
  readonly served: string;
}

/**
 * masq's route rows (inference di9/06-masq.md): an id masq takes, the id of the model it routes it to,
 * superbot-router's own (`superbot` → `superbot-router/superbot`, `superbot-flash` →
 * `superbot-router/superbot-fast`; `superbot-fast` has no row), and the name masq's answer gives that model.
 * The one table: server/house-model.ts reads it here through MASQ_ROUTED (masqAllowedModels: a key's
 * allowlist names a row's asked and routed ids, since masq checks it against both), as the forwarder's bundle
 * reaches no server/ module (bundle.ts GATEWAY_BUNDLE_SOURCES).
 *
 * Under MASQ_HEADERS' x-masq-pin: strict masq answers a request for a row's own id 409 ("Send the route's
 * target spelling, or drop the pin": the superbot pilot, 2026-11-10); masqRouteTarget names the routed id such a
 * request would have to carry. No forwarder request carries either: server.ts houseForwardBody renames no model, a
 * router-served house model is dialled on the `router` upstream alone (routerUpstream), and on a masq upstream a
 * request naming one is refused unsent (server.ts namesRouterModel, ROUTER_MODEL_ON_MASQ_MESSAGE). masq's answer to a
 * routed id names the row's `served` name, which
 * isServedModel takes as the model asked for: `superbot` for superbot-router/superbot (18 of 18 answers) and
 * `superbot-fast` for superbot-router/superbot-fast (2 of 2, no x-masq-model; masq live, 2026-11-10). A served
 * name is what masq answered, never a rule: nothing after `superbot-router/` is taken as a row's model.
 */
export const MASQ_ROUTE_ROWS: readonly MasqRouteRow[] = Object.freeze([
  Object.freeze({ asked: 'superbot', routed: 'superbot-router/superbot', served: 'superbot' }),
  Object.freeze({ asked: 'superbot-flash', routed: 'superbot-router/superbot-fast', served: 'superbot-fast' }),
]);

/** MASQ_ROUTE_ROWS as asked id → routed id: what masqRouteTarget names and a masq key's allowlist names. */
export const MASQ_ROUTED: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(MASQ_ROUTE_ROWS.map((row) => [row.asked, row.routed])),
);

/**
 * The id masq's route row sends `model` to (MASQ_ROUTED), when `model` is a row's own id spelled exactly as
 * the row spells it; null for any other id (one in masq's routing grammar, another case, a routed id
 * itself), which is sent as it came.
 */
export function masqRouteTarget(model: string): string | null {
  return Object.hasOwn(MASQ_ROUTED, model) ? MASQ_ROUTED[model]! : null;
}

/**
 * The identities an answer may name for the route row whose asked or routed id `identity` is (its asked id,
 * its routed id, its served name); null when it is neither end of any row. A served name alone finds no row:
 * a request for `superbot-fast` is its own model.
 */
function routeRowOf(identity: string): readonly string[] | null {
  for (const { asked, routed, served } of MASQ_ROUTE_ROWS) {
    if (modelIdentity(asked) === identity || modelIdentity(routed) === identity) return [asked, routed, served].map(modelIdentity);
  }
  return null;
}

/**
 * Whether `served` (the model an answer names) is `requested` (the model asked for): the same model once
 * masq's routing grammar is off both, or that model under a release date (an alias answered by its dated
 * snapshot); or, for a request naming a route row's asked or routed id (MASQ_ROUTE_ROWS), that row's asked
 * id, routed id or served name likewise (`superbot-router/superbot` answered as `superbot`, `superbot` as
 * `superbot-router/superbot`; `superbot-router/superbot-fast` or `superbot-flash` answered as `superbot-fast`,
 * the name masq's live answer gave it on 2026-11-10, or as either other id of its row). Anything else, an
 * empty name included, is another model: one row's names never answer another's (`superbot-fast` never
 * answers `superbot`, nor `superbot` `superbot-flash`), and no prefix is peeled to make an id a row's, so
 * `x/superbot` never answers `superbot`.
 */
export function isServedModel(requested: string, served: string): boolean {
  const want = modelIdentity(requested);
  const got = modelIdentity(served);
  if (want === '' || got === '') return false;
  const names = (id: string): boolean => got === id || (RELEASE_DATE.test(got) && got.replace(RELEASE_DATE, '') === id);
  if (names(want)) return true;
  // A row's three names are one model to this check, and only as masq routes them today: masq can retarget the
  // router behind the same id (another model served as superbot-router/superbot) and no answer would say so, so
  // vetServedModel cannot see it. No house lane leans on it: a router-served target is dialled on `router`, where the
  // forwarder takes a turn only from the router's primary (server.ts, `sbr.tier`; .cosmos/rules/house-models.mdc).
  const row = routeRowOf(want);
  return row !== null && row.some(names);
}

/**
 * Whether `served` is a provider's own answer for `requested` (the `provider` adapter's check): the id the
 * provider was sent (providerWireModel: OpenRouter's own bare slug for `openrouter/<slug>`, Anthropic's
 * own id for `anthropic/<id>`: see the header), or that id under a release date (Anthropic answers an alias
 * by its dated snapshot, claude-sonnet-4-5 as claude-sonnet-4-5-20250929; OpenAI gpt-4o as
 * gpt-4o-2024-08-06; Google's OpenAI-compatible chat names the id asked for, bare), case aside. A provider
 * speaks no routing grammar, so none is peeled here: `o3-high` does not answer `o3`, nor `models/x` x.
 */
export function isProviderServedModel(requested: string, served: string): boolean {
  const want = requested.trim().toLowerCase();
  const got = served.trim().toLowerCase();
  if (want === '' || got === '') return false;
  return got === want || (RELEASE_DATE.test(got) && got.replace(RELEASE_DATE, '') === want);
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const clipName = (s: string): string => (s.length <= 200 ? s : `${s.slice(0, 199)}…`);

/** The model a request body names (its JSON's `model`), or null. */
function requestedModelOf(body: Uint8Array): string | null {
  try {
    const doc: unknown = JSON.parse(new TextDecoder('utf-8').decode(body));
    const model = isRecord(doc) ? doc.model : undefined;
    return typeof model === 'string' && model.trim() !== '' ? model : null;
  } catch {
    return null;
  }
}

/** What an answer document (a JSON body, or one SSE event) says of the model: the one it names, that it is an error (none to name), or nothing. */
export type ModelSign = { served: string } | { error: true } | null;

export function modelSignOf(data: string, event: string | null): ModelSign {
  if (event === 'error') return { error: true };
  let doc: unknown;
  try {
    doc = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  if (doc.type === 'error' || (doc.error !== undefined && doc.error !== null)) return { error: true };
  // A JSON body's and a chat chunk's `model`, Messages' message_start, a Response's response.created.
  for (const named of [doc.model, isRecord(doc.message) ? doc.message.model : undefined, isRecord(doc.response) ? doc.response.model : undefined]) {
    if (typeof named === 'string' && named.trim() !== '') return { served: named };
  }
  return null;
}

/** Who answered and how its answer is read (vetServedModel): masq's, by default. */
interface ServedModelCheck {
  /** Who answered, as a refusal names it. */
  who: string;
  /** The header a swap is named in (masq's x-masq-model), or null: a provider names none. */
  swapHeader: string | null;
  /** Whether the model an answer names is the one asked for. */
  matches: (requested: string, served: string) => boolean;
  /**
   * The id the request named, when `matches` checks another one (providerWireModel's: OpenRouter's bare slug
   * for this lane's `openrouter/<slug>`, Anthropic's own id for `anthropic/<id>`): a refusal names both, so
   * the client reads which id the provider was asked for.
   */
  asked?: string;
}

const MASQ_CHECK: ServedModelCheck = Object.freeze({ who: 'masq', swapHeader: MASQ_MODEL_HEADER, matches: isServedModel });

/**
 * A 2xx from masq (or, under `check`, a provider) as the trial may take it (see the header): answered by
 * `requested`, its body relayed from the first byte as it came; or a rejection with UpstreamError
 * `model`, the upstream torn down (`destroy`). Any other status passes untouched, and so does a 2xx that
 * is an error document or opens with an error event. A reset or an abort while the body is held rejects
 * as it would have.
 */
async function vetServedModel(requested: string, res: UpstreamResponse, destroy: () => void, check: ServedModelCheck = MASQ_CHECK): Promise<UpstreamResponse> {
  if (res.status < 200 || res.status >= 300) return res;
  function refuse(why: string): never {
    destroy();
    throw new UpstreamError('model', why);
  }
  const { who, matches } = check;
  // What a refusal calls the model asked for: the provider's wire id, with the request's own beside it when
  // the two differ (providerWireModel's: OpenRouter's bare slug, Anthropic's own id for `anthropic/<id>`).
  const wanted = check.asked === undefined ? clipName(requested) : `${clipName(requested)} (${who}'s id for ${clipName(check.asked)})`;
  const swapped = check.swapHeader === null ? undefined : res.headers[check.swapHeader];
  if (swapped !== undefined && !matches(requested, swapped)) {
    refuse(`${who} answered with ${clipName(swapped)} (${check.swapHeader}), not ${wanted}, the model the request named`);
  }
  const it = res.body[Symbol.asyncIterator]();
  const held: Uint8Array[] = [];
  let bytes = 0;
  let ended = false;
  const found: { sign: ModelSign } = { sign: null };
  const sse = /^\s*text\/event-stream\b/i.test(res.headers['content-type'] ?? '');
  const parser = sse ? new SseParser((e) => (found.sign ??= modelSignOf(e.data, e.event))) : null;
  while (found.sign === null) {
    const next = await it.next();
    if (next.done === true) {
      ended = true;
      break;
    }
    held.push(next.value);
    bytes += next.value.byteLength;
    parser?.push(next.value);
    if (found.sign === null && bytes > MAX_SERVED_MODEL_SCAN_BYTES) {
      refuse(`${who}'s answer named no model in its first ${MAX_SERVED_MODEL_SCAN_BYTES} bytes, so the model that served it could not be checked against ${wanted}, the model the request named`);
    }
  }
  if (found.sign === null) {
    if (parser !== null) parser.end();
    else found.sign = modelSignOf(new TextDecoder('utf-8').decode(Buffer.concat(held)), null);
  }
  const sign = found.sign;
  if (sign === null) refuse(`${who}'s ${res.status} answer names no model, so the model that served it could not be checked against ${wanted}, the model the request named`);
  else if ('served' in sign && !matches(requested, sign.served)) refuse(`${who}'s answer was served by ${clipName(sign.served)}, not ${wanted}, the model the request named`);
  async function* relay(): AsyncIterable<Uint8Array> {
    let finished = ended;
    try {
      for (const chunk of held) yield chunk;
      while (!finished) {
        const next = await it.next();
        if (next.done === true) finished = true;
        else yield next.value;
      }
    } finally {
      // The forwarder stopped reading (its cap) or the body failed: the upstream goes with it.
      if (!finished) destroy();
    }
  }
  return { status: res.status, headers: res.headers, body: relay() };
}

// ------------------------------------------------------------------ masq

export interface MasqUpstreamOptions {
  /** masq's origin (parseOrigin). */
  origin: string;
  /** The trial's masq key (UpstreamKey). */
  key: string;
  connectTimeoutMs?: number;
  /** The certificates to trust instead of Node's bundled CAs (tests: a fixture's). Verification is never off. */
  ca?: string | Buffer;
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ETIMEDOUT', 'EAI_FAIL', 'EAI_NONAME']);

function failureOf(err: unknown, phase: 'request' | 'body'): UpstreamError {
  if (err instanceof UpstreamError) return err;
  const e = err as NodeJS.ErrnoException & { code?: string };
  const code = typeof e?.code === 'string' ? e.code : '';
  if (e?.name === 'AbortError' || code === 'ABORT_ERR') return new UpstreamError('aborted', 'the request was aborted');
  if (phase === 'request' && CONNECT_CODES.has(code)) return new UpstreamError('connect', `could not connect to the upstream (${code})`);
  if (/^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_|ERR_OSSL)/.test(code)) return new UpstreamError('tls', `the upstream's TLS was not verified (${code})`);
  if (code.startsWith('HPE_') || code.startsWith('Z_') || code === 'ERR_INVALID_CHAR' || code.startsWith('ERR_ZLIB') || code === 'ERR__ERROR') {
    return new UpstreamError('protocol', `the upstream's response is malformed (${code})`);
  }
  return new UpstreamError('reset', `the upstream connection dropped${code ? ` (${code})` : ''}`);
}

type Decoder = () => Transform;

function decoderFor(encoding: string | undefined): Decoder | null | 'unsupported' {
  const e = (encoding ?? '').trim().toLowerCase();
  if (e === '' || e === 'identity') return null;
  if (e === 'gzip' || e === 'x-gzip') return () => zlib.createGunzip();
  if (e === 'deflate') return () => zlib.createInflate();
  if (e === 'br') return () => zlib.createBrotliDecompress();
  const zstd = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
  if (e === 'zstd' && typeof zstd === 'function') return () => zstd();
  return 'unsupported';
}

function joinHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, values] of Object.entries(res.headersDistinct)) {
    if (values !== undefined) out[name] = values.join(', ');
  }
  return out;
}

/** The body as an async iterable whose every failure is an UpstreamError. */
async function* bodyOf(stream: Readable): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of stream) yield chunk as Uint8Array;
  } catch (err) {
    throw failureOf(err, 'body');
  }
}

/** Where an adapter dials: its origin, whether over TLS, the connect timeout, the CAs to trust and the agent. */
interface Dialer {
  readonly url: URL;
  readonly tls: boolean;
  readonly connectTimeoutMs: number;
  /** The certificates to trust instead of Node's bundled CAs (tests). Verification is never off. */
  readonly ca: string | Buffer | undefined;
  readonly agent: HttpAgent;
}

/**
 * One exchange with `d`'s origin (see the header): POST `path` with exactly `headers` and the request's
 * body; the response head and its body, decoded, and how to tear the response down.
 */
function dial(d: Dialer, path: string, headers: OutgoingHttpHeaders, req: UpstreamRequest): Promise<{ res: UpstreamResponse; destroy: () => void }> {
  if (req.signal.aborted) return Promise.reject(new UpstreamError('aborted', 'the request was aborted'));
  const { url, tls, connectTimeoutMs } = d;
  return new Promise<{ res: UpstreamResponse; destroy: () => void }>((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | null = null;
    let connectTimer: NodeJS.Timeout | null = null;
    const clearConnect = (): void => {
      if (connectTimer !== null) clearTimeout(connectTimer);
      connectTimer = null;
    };
    const fail = (err: UpstreamError): void => {
      clearConnect();
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const r: ClientRequest = (tls ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port === '' ? (tls ? 443 : 80) : Number(url.port),
      method: 'POST',
      path,
      headers,
      agent: d.agent,
      maxHeaderSize: MAX_UPSTREAM_HEADER_BYTES,
      ...(tls ? { rejectUnauthorized: true, ...(d.ca !== undefined ? { ca: d.ca } : {}) } : {}),
    });
    const onAbort = (): void => {
      const err = new UpstreamError('aborted', 'the request was aborted');
      if (response !== null) response.destroy(err);
      r.destroy(err);
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    r.once('close', () => {
      clearConnect();
      if (response === null) req.signal.removeEventListener('abort', onAbort);
    });
    r.on('socket', (socket: Socket) => {
      if (r.reusedSocket) return;
      connectTimer = setTimeout(() => r.destroy(new UpstreamError('connect', `no connection to the upstream within ${connectTimeoutMs} ms`)), connectTimeoutMs);
      socket.once(tls ? 'secureConnect' : 'connect', clearConnect);
    });
    r.on('error', (err) => fail(failureOf(err, 'request')));
    r.on('response', (res: IncomingMessage) => {
      clearConnect();
      response = res;
      res.once('close', () => req.signal.removeEventListener('abort', onAbort));
      const status = res.statusCode ?? 0;
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        res.destroy();
        fail(new UpstreamError('protocol', `the upstream answered status ${status}`));
        return;
      }
      const head = joinHeaders(res);
      const decoder = decoderFor(head['content-encoding']);
      if (decoder === 'unsupported') {
        res.destroy();
        fail(new UpstreamError('protocol', `the upstream encoded its body as ${JSON.stringify(head['content-encoding'])}, which this gateway cannot decode`));
        return;
      }
      let stream: Readable = res;
      if (decoder !== null) {
        delete head['content-encoding'];
        delete head['content-length'];
        stream = pipeline(res, decoder(), () => {});
      }
      settled = true;
      resolve({
        res: { status, headers: head, body: bodyOf(stream) },
        destroy: () => {
          if (!res.destroyed) res.destroy();
        },
      });
    });
    r.end(Buffer.from(req.body.buffer, req.body.byteOffset, req.body.byteLength));
  });
}

/** masq at `origin`, on the trial's masq key (see the header): every route to the one origin. */
export function masqUpstream(opts: MasqUpstreamOptions): Upstream {
  const key = UpstreamKey.parse(opts.key);
  const url = parseOrigin(opts.origin);
  const tls = url.protocol === 'https:';
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 64 });
  const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 64 });
  const dialer: Dialer = { url, tls, connectTimeoutMs, ca: opts.ca, agent: tls ? httpsAgent : httpAgent };

  /** One exchange: the response head and its body, and how to tear the response down. */
  const exchange = (req: UpstreamRequest): Promise<{ res: UpstreamResponse; destroy: () => void }> => {
    const headers: OutgoingHttpHeaders = {
      ...req.headers,
      ...MASQ_HEADERS,
      ...vendorAuth(ROUTE_VENDOR[req.route], key),
      'content-type': 'application/json',
      'content-length': String(req.body.byteLength),
      'accept-encoding': 'identity',
      'user-agent': GATEWAY_USER_AGENT,
    };
    return dial(dialer, ROUTE_PATHS[req.route], headers, req);
  };

  // The model the request named is the one a 2xx must be answered by (vetServedModel). The policy
  // admits only a request that names one, so a body without one is never sent.
  const send = async (req: UpstreamRequest): Promise<UpstreamResponse> => {
    const requested = requestedModelOf(req.body);
    if (requested === null) throw new UpstreamError('model', 'the request names no model, so the model that answers it could not be checked: it was not sent');
    const { res, destroy } = await exchange(req);
    return vetServedModel(requested, res, destroy);
  };

  return {
    kind: 'masq',
    send,
    close() {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}

// ------------------------------------------------------------------ router: superbot-router, the house's own serving

/** The ids superbot-router serves the house lane, bare: the only models routerUpstream sends (masq's spellings never). */
export const ROUTER_HOUSE_MODELS: readonly string[] = Object.freeze(['superbot', 'superbot-fast']);

/** The router's service tier a request asks for (its x-sbr-speed): the batch lane's flex, or standard. */
export const RouterSpeed = z.enum(['flex', 'standard']);
export type RouterSpeedT = z.infer<typeof RouterSpeed>;

/** What the router buckets a caller's streams by (the body's metadata.user_id): 1 to 200 visible ASCII characters. */
export const RouterUser = z.string().regex(/^[\x21-\x7e]{1,200}$/, 'a router user is 1 to 200 visible ASCII characters');

/** The anthropic-version a router request carries when the request names none. */
export const ROUTER_ANTHROPIC_VERSION = '2023-06-01';

/** The statuses whose answer, with a retry-after in seconds, the router adapter sends again on its ladder (see the header). */
export const ROUTER_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 503, 529]);

/**
 * The most sends of one house request on superbot-router: the first and up to seven more, each after a refusal
 * routerRetryWaitMs names (the house key's batch-lane ladder: up to 8 tries on a 2 to 60 s backoff). At 24 trials
 * at once the pool answers about a third of the sends 529 pool-full with retry-after 2 to 9 s, and one upstream
 * error on the house lane voids the trial's pass (grader/agent.ts), so one retry is not enough.
 */
export const ROUTER_HOUSE_TRIES = 8;

/**
 * The span, from the first send, inside which every ladder wait ends: a wait that would end later is not taken and
 * that refusal is the answer. Every sealed env aborts a house call at 180 s
 * (competitions/werewolf-agent-01/src/server/house.ts HOUSE_TIMEOUT_MS) and scores that game a loss with no void, so
 * the forwarder must answer first: 150 s leaves 30 s for the last send's answer, and a refusal relayed in time voids
 * the pass, which re-runs, where an env timeout would cost the entry a game.
 */
export const ROUTER_HOUSE_LADDER_MS = 150_000;

/** The shortest and longest ladder wait, ms: the router's own retry-after held to 2 to 60 s (routerHouseWaitMs). */
export const ROUTER_HOUSE_MIN_WAIT_MS = 2_000;
export const ROUTER_HOUSE_MAX_WAIT_MS = 60_000;

/**
 * The longest retry-after routerRetryWaitMs reads, in seconds: the longest wait a Node timer holds (2^31 - 1 ms). A
 * longer one is relayed; one within it is waited at most ROUTER_HOUSE_MAX_WAIT_MS (routerHouseWaitMs).
 */
export const MAX_ROUTER_RETRY_AFTER_S = Math.floor(2_147_483_647 / 1000);

/** The most of a dropped answer's body (each one a retry replaces) read while the adapter waits; past it the answer is torn down. */
export const MAX_DROPPED_ANSWER_BYTES = 64 * 1024;

export interface RouterUpstreamOptions {
  /** The router's origin (parseOrigin). */
  origin: string;
  /** The house lane's router key (UpstreamKey). */
  key: string;
  /** The service tier every request asks for (x-sbr-speed). */
  speed: RouterSpeedT;
  /** The caller the router buckets these streams by (RouterUser), written into each body's metadata.user_id; absent, the body goes as it came. */
  user?: string;
  connectTimeoutMs?: number;
  /** The certificates to trust instead of Node's bundled CAs (tests: a fixture's). Verification is never off. */
  ca?: string | Buffer;
  /** Tests only: the ladder's wait (ended by the signal, rejecting UpstreamError `aborted`); a real timer by default. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Tests only: the ladder's clock, ms; Date.now by default. */
  now?: () => number;
}

/** How a router answer is vetted: the id asked, exactly. The router names no swap in a header, and speaks no routing grammar. */
const ROUTER_CHECK: ServedModelCheck = Object.freeze({ who: 'superbot-router', swapHeader: null, matches: (requested: string, served: string) => served === requested });

/** `body` (a Messages request, a JSON object) with metadata.user_id set to `user`, its other metadata kept. */
function withRouterUser(body: Uint8Array, user: string): Uint8Array {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8').decode(body));
  } catch {
    throw new UpstreamError('protocol', 'the request body is not JSON, so its metadata.user_id could not be written: it was not sent');
  }
  if (!isRecord(doc)) throw new UpstreamError('protocol', 'the request body is not a JSON object, so its metadata.user_id could not be written: it was not sent');
  const metadata = isRecord(doc.metadata) ? doc.metadata : {};
  return encoder.encode(JSON.stringify({ ...doc, metadata: { ...metadata, user_id: user } }));
}

/**
 * The wait, in ms, an answer asks before the router adapter sends again (see the header), or null when it is not
 * to be sent again: a status of ROUTER_RETRY_STATUSES, a retry-after of whole seconds (at most
 * MAX_ROUTER_RETRY_AFTER_S; an HTTP date, a fraction or a repeated header is none), and no x-should-retry: false.
 */
export function routerRetryWaitMs(status: number, headers: Readonly<Record<string, string>>): number | null {
  if (!ROUTER_RETRY_STATUSES.has(status)) return null;
  if ((headers['x-should-retry'] ?? '').trim().toLowerCase() === 'false') return null;
  const m = /^\s*(\d{1,10})\s*$/.exec(headers['retry-after'] ?? '');
  if (m === null) return null;
  const seconds = Number(m[1]);
  return seconds <= MAX_ROUTER_RETRY_AFTER_S ? seconds * 1000 : null;
}

/** The ladder's wait for a retry-after of `askedMs` (routerRetryWaitMs): held to ROUTER_HOUSE_MIN_WAIT_MS to ROUTER_HOUSE_MAX_WAIT_MS. */
export function routerHouseWaitMs(askedMs: number): number {
  return Math.min(ROUTER_HOUSE_MAX_WAIT_MS, Math.max(ROUTER_HOUSE_MIN_WAIT_MS, askedMs));
}

/** Read and drop an answer a retry replaces, at most MAX_DROPPED_ANSWER_BYTES of it; its faults are nobody's. */
async function dropAnswer(res: UpstreamResponse): Promise<void> {
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_DROPPED_ANSWER_BYTES) break;
    }
  } catch {
    // Torn down (the wait ended, the request was aborted) or reset: it was dropped either way.
  }
}

/**
 * superbot-router at `origin`, on the house lane's router key (see the header): Messages only, to the router's
 * bare house ids only, every request asking `speed` and, with `user`, naming it as the body's metadata.user_id; a
 * retry-after refusal sent again on the house ladder (ROUTER_HOUSE_TRIES sends inside ROUTER_HOUSE_LADDER_MS).
 */
export function routerUpstream(opts: RouterUpstreamOptions): Upstream {
  const key = UpstreamKey.parse(opts.key);
  const speed = RouterSpeed.parse(opts.speed);
  const user = opts.user === undefined ? undefined : RouterUser.parse(opts.user);
  const url = parseOrigin(opts.origin);
  const tls = url.protocol === 'https:';
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const agent = tls ? new HttpsAgent({ keepAlive: true, maxSockets: 64 }) : new HttpAgent({ keepAlive: true, maxSockets: 64 });
  const dialer: Dialer = { url, tls, connectTimeoutMs, ca: opts.ca, agent };
  const path = ROUTE_PATHS['anthropic.messages'];
  const wait = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;

  const send = async (req: UpstreamRequest): Promise<UpstreamResponse> => {
    if (req.route !== 'anthropic.messages') throw new UpstreamError('protocol', `superbot-router's house lane is dialled on Messages alone, not ${ROUTE_NAMES[req.route]}: it was not sent`);
    const requested = requestedModelOf(req.body);
    if (requested === null) throw new UpstreamError('model', 'the request names no model, so the model that answers it could not be checked: it was not sent');
    if (!ROUTER_HOUSE_MODELS.includes(requested)) {
      throw new UpstreamError('model', `superbot-router's house lane serves ${ROUTER_HOUSE_MODELS.join(' and ')} by their bare ids, not ${clipName(requested)}: it was not sent`);
    }
    if (req.signal.aborted) throw new UpstreamError('aborted', 'the request was aborted');
    const body = user === undefined ? req.body : withRouterUser(req.body, user);
    const version = req.headers['anthropic-version'];
    // Exactly these, whatever else the request carries: never MASQ_HEADERS, an x-masq-* or x-cosmos-* header, or another x-sbr-*.
    const headers: OutgoingHttpHeaders = {
      'x-api-key': key,
      'anthropic-version': version !== undefined && version !== '' ? version : ROUTER_ANTHROPIC_VERSION,
      'x-sbr-speed': speed,
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
      accept: 'text/event-stream',
      'accept-encoding': 'identity',
      'user-agent': GATEWAY_USER_AGENT,
    };
    const out: UpstreamRequest = { route: req.route, headers: req.headers, body, signal: req.signal };
    // The ladder (see the header): the same bytes and headers, at most ROUTER_HOUSE_TRIES sends, every wait ending
    // inside ROUTER_HOUSE_LADDER_MS from the first send.
    const deadline = now() + ROUTER_HOUSE_LADDER_MS;
    let answer = await dial(dialer, path, headers, out);
    for (let sent = 1; sent < ROUTER_HOUSE_TRIES; sent++) {
      const asked = routerRetryWaitMs(answer.res.status, answer.res.headers);
      if (asked === null) break;
      const ms = routerHouseWaitMs(asked);
      // A wait that would end past the ladder's span is not taken: this refusal is the answer.
      if (now() + ms > deadline) break;
      // This answer is read and dropped while the adapter waits, then the same bytes go again.
      const refused = answer;
      const dropped = dropAnswer(refused.res);
      try {
        await wait(ms, req.signal);
      } finally {
        refused.destroy();
        await dropped;
      }
      answer = await dial(dialer, path, headers, out);
    }
    return vetServedModel(requested, answer.res, answer.destroy, ROUTER_CHECK);
  };

  return {
    kind: 'router',
    send,
    close() {
      agent.destroy();
    },
  };
}

// ------------------------------------------------------------------ provider: the entrant's own key

/** The entrant's own keys, by provider (each UpstreamKey); a provider with none pushed is left out. */
export type ProviderKeys = Readonly<Partial<Record<Provider, string>>>;

/** What each policed route is called in a message. */
export const ROUTE_NAMES: Readonly<Record<PolicedRoute, string>> = Object.freeze({
  'anthropic.messages': 'Messages',
  'openai.chat': 'Chat Completions',
  'openai.responses': 'Responses',
});

/** Each provider's model families as a message names them (contracts/entry-secrets.ts providerOfModel reads them). */
const PROVIDER_FAMILIES: Readonly<Record<Provider, string>> = Object.freeze({ anthropic: 'claude-*', openai: 'gpt-*, chatgpt-* and o<digit>*', google: 'gemini-*', openrouter: 'openrouter/*' });

/**
 * The client headers each provider is sent, of those the forwarder passes on (server.ts
 * FORWARDED_CLIENT_HEADERS): its own alone. masq's, the house lane's and another provider's never go.
 * OpenRouter takes none: no client header is its own, so its requests carry its bearer alone.
 */
export const PROVIDER_CLIENT_HEADERS: Readonly<Record<Provider, readonly string[]>> = Object.freeze({
  anthropic: Object.freeze(['anthropic-version', 'anthropic-beta']),
  openai: Object.freeze(['openai-beta']),
  google: Object.freeze([]),
  openrouter: Object.freeze([]),
});

/**
 * Whether entrants can push an entry secret on the deployment whose worker wrote the config: `on`
 * when it seals them (its MAKEFUN_ENTRY_SECRET_SEAL_PUBLIC_KEY set), `off` when it has no seal public key
 * and a push answers 503 entry_secrets_off (server/secrets/store.ts). It changes the no-key 401's words
 * alone (noProviderKeyMessage); a config that leaves it out is `on`.
 */
export const EntrySecretsOpen = z.enum(['on', 'off']);
export type EntrySecretsOpenT = z.infer<typeof EntrySecretsOpen>;

/**
 * The 401's message for a provider no key of the entrant's reaches (see the header): the entry secret
 * that carries one (its SECRET_PROVIDER_ENV name in a .env) and the command that pushes it, or, with
 * `off` on this deployment, that pushing a secret is not open here yet, naming no command.
 */
export function noProviderKeyMessage(provider: Provider, entrySecrets: EntrySecretsOpenT = 'on'): string {
  const head = `make.fun: no ${PROVIDER_NAMES[provider]} key reaches this entry`;
  if (entrySecrets === 'off') return `${head}: pushing a secret is not open on this site yet, so solve without models`;
  return `${head}: put ${SECRET_PROVIDER_ENV[provider]}=<your key> in a .env and push it with \`makefun secrets push <slug> --dotenv .env\`, or solve without models`;
}

/**
 * What the forwarder masks of `values` (the keys, the config's `mask`, or its `request_mask`): every form of each
 * (secret-mask.ts secretForms: the value, its lines, base64, percent, JSON, hex and sha256 spellings, each at least
 * SECRET_FORM_MIN_CHARS characters) and each value itself whatever its length, so a key shorter than a form may be is
 * still masked whole. Empty strings are no value.
 */
export function secretFormSet(values: Iterable<string>): FormSet {
  const forms: string[] = [];
  for (const v of new Set(values)) {
    if (v === '') continue;
    forms.push(v, ...secretForms(v));
  }
  return new FormSet(forms);
}

/** What a message (an error, a fault) holds in place of a secret: providers.ts redactKeys's mark, so a key and any other secret read alike. */
export const REDACTED_MARK = '[redacted]';

/** `text` with every form in `forms` replaced by REDACTED_MARK: a message's own redaction (an answer's body is masked with secret-mask.ts SECRET_MARK). */
export function redactForms(text: string, forms: FormSet): string {
  return forms.forms.length === 0 ? text : maskText(text, forms, REDACTED_MARK);
}

/** The routes `provider` serves on an entrant's key, in a message: `Chat Completions (/v1/chat/completions) and Responses (/v1/responses)`. */
function servedRoutes(provider: Provider): string {
  const routes = (Object.keys(PROVIDER_ROUTES[provider].chat) as PolicedRoute[]).map((r) => `${ROUTE_NAMES[r]} (${ROUTE_PATHS[r]})`);
  return routes.length <= 1 ? routes.join('') : `${routes.slice(0, -1).join(', ')} and ${routes.at(-1)}`;
}

/**
 * Where an entrant's own key sends a request for `model` on `route` (see the header): the provider
 * whose model it is, when that provider serves the route on an entrant's key; else why it is not sent,
 * the 400's message naming the route to call.
 */
export function providerFor(route: PolicedRoute, model: string): { provider: Provider } | { refused: string } {
  const provider = providerOfModel(model);
  if (provider === null) {
    const reach = PROVIDERS.map((p) => `${PROVIDER_NAMES[p]}'s ${PROVIDER_FAMILIES[p]}`);
    return { refused: `make.fun: on your own key, no provider serves ${clipName(model)}: an entrant's key reaches ${reach.slice(0, -1).join(', ')} and ${reach.at(-1)}` };
  }
  if (PROVIDER_ROUTES[provider].chat[route] === undefined) {
    return { refused: `make.fun: on your own key, ${PROVIDER_NAMES[provider]} serves ${PROVIDER_FAMILIES[provider]} on ${servedRoutes(provider)} only` };
  }
  return { provider };
}

/** The gateway-side prefix on OpenRouter's model ids (`openrouter/<slug>`): this lane's, never OpenRouter's. */
const OPENROUTER_MODEL_PREFIX = 'openrouter/';

/**
 * The id OpenRouter is sent for the model a request names, and the one its answer must name: OpenRouter's own
 * id, the gateway-side `openrouter/<slug>` with this lane's prefix off (`openrouter/liquid/lfm-3-1.7b:free` →
 * `liquid/lfm-3-1.7b:free`). The id is read as contracts/entry-secrets.ts providerOfModel reads it — trimmed,
 * lowercased, one masq provider prefix off (PROVIDER_PREFIX, above), so `router/openrouter/<slug>` maps
 * alike — and any other id comes back trimmed as it came. OpenRouter accepts and echoes the bare id, and
 * refuses the prefixed one as no model of its own (free-model-aggregator-02's first live trial:
 * `openrouter/baidu/ernie-5.5-flash-preview:free is not a valid model ID`, HTTP 400). This is
 * providerWireModel's OpenRouter rule.
 */
export function openRouterModelId(id: string): string {
  const routed = id.trim().toLowerCase().replace(PROVIDER_PREFIX, '');
  return routed.startsWith(OPENROUTER_MODEL_PREFIX) ? routed.slice(OPENROUTER_MODEL_PREFIX.length) : id.trim();
}

/**
 * The id `provider`'s wire accepts for the model a request named, and the one its answer must name (see the
 * header): the gateway-side id with the provider prefix it routes under off, when what follows is a model
 * `provider` serves — `anthropic/claude-opus-5-5`, `claude:claude-opus-5-5` and `router/claude-opus-5-5` are
 * all Anthropic's `claude-opus-5-5`, and `gemini/gemini-4-argon` is Google's `gemini-4-argon` — read as
 * providerOfModel reads an id for selection: trimmed, lowercased, one masq provider prefix off (PROVIDER_PREFIX,
 * contracts/entry-secrets.ts MASQ_PROVIDER_PREFIX). OpenRouter's is openRouterModelId's rule. A prefix names
 * where an id routes and never reaches a provider's wire (the prefixed spelling is no model of the provider's:
 * OpenRouter answered HTTP 400 on `openrouter/<slug>`, free-model-aggregator-02's first live trial). An id the
 * grammar does not prefix comes back as it came: a fine-tuned `ft:…`, a model whose name merely contains a
 * slash (`o3/mini`), case and all. A prefixed id's remainder is lowercased, as openRouterModelId reads one.
 */
export function providerWireModel(provider: Provider, id: string): string {
  if (provider === 'openrouter') return openRouterModelId(id);
  const trimmed = id.trim();
  const prefix = PROVIDER_PREFIX.exec(trimmed.toLowerCase());
  if (prefix === null) return id;
  const bare = trimmed.slice(prefix[0].length).toLowerCase();
  return providerOfModel(bare) === provider ? bare : id;
}

/**
 * `body` with its `model` set to `model` and every other member kept, re-serialized: the body OpenRouter is
 * sent for a gateway-side `openrouter/<slug>` id (the caller has read a model out of `body` with
 * requestedModelOf, so it is a JSON object with a model string).
 */
export function bodyWithModel(body: Uint8Array, model: string): Uint8Array {
  const doc = JSON.parse(new TextDecoder('utf-8').decode(body)) as Record<string, unknown>;
  return encoder.encode(JSON.stringify({ ...doc, model }));
}

export interface ProviderUpstreamOptions {
  /** The entrant's own keys (ProviderKeys); none at all runs the entry model-free, every call answered 401. */
  keys: ProviderKeys;
  /**
   * Values whose every form (secretFormSet) is redacted with the keys out of this adapter's own messages: the entrant's
   * env-lane entry secrets and the org and project ids the key check learned (the forwarder masks them out of every
   * answer: main.ts).
   */
  mask?: readonly string[];
  /** Each provider's origin (default providers.ts PROVIDER_ORIGINS): https only, a test's fake provider. */
  origins?: Readonly<Partial<Record<Provider, string>>>;
  /** The certificates to trust instead of Node's bundled CAs (tests: a fixture's). Verification is never off. */
  ca?: string | Buffer;
  connectTimeoutMs?: number;
  /** Whether this deployment lets entrants push an entry secret (EntrySecretsOpen; default `on`): the no-key 401's words. */
  entrySecrets?: EntrySecretsOpenT;
}

/** A body of one chunk. */
async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/**
 * The entrant's own providers on the entrant's own keys (see the header): each request to the provider
 * its model names, at that provider's origin and path for its route, or answered here (400, 401) and
 * sent nowhere. Throws TypeError, naming no key, for a key no header can carry or an origin that is not
 * plain https.
 */
export function providerUpstream(opts: ProviderUpstreamOptions): Upstream {
  const keys: Partial<Record<Provider, string>> = {};
  for (const p of PROVIDERS) {
    const key = opts.keys[p];
    if (key === undefined) continue;
    if (!UpstreamKey.safeParse(key).success) throw new TypeError(`the ${PROVIDER_NAMES[p]} key is not one a header can carry: 1 to 4096 visible ASCII characters, no spaces`);
    keys[p] = key;
  }
  const held = Object.values(keys).filter((k): k is string => typeof k === 'string' && k !== '');
  const forms = secretFormSet([...held, ...(opts.mask ?? [])]);
  /** A message of this adapter's with every key (its echoed runs too: providers.ts redactKeys) and every form of a secret redacted. */
  const redact = (text: string): string => redactForms(redactKeys(text, held), forms);
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const entrySecrets = opts.entrySecrets ?? 'on';
  const agent = new HttpsAgent({ keepAlive: true, maxSockets: 64 });
  const dialers = {} as Record<Provider, Dialer>;
  for (const p of PROVIDERS) {
    const text = opts.origins?.[p] ?? PROVIDER_ORIGINS[p];
    const url = parseOrigin(text);
    if (url.protocol !== 'https:') throw new TypeError(`${PROVIDER_NAMES[p]}'s origin ${JSON.stringify(text)} is not https: an entrant's key goes to its provider over verified TLS only`);
    dialers[p] = { url, tls: true, connectTimeoutMs, ca: opts.ca, agent };
  }

  /** An answer the adapter makes itself, in the route's vendor shape. */
  const own = (route: PolicedRoute, status: number, type: string, message: string): UpstreamResponse => ({
    status,
    headers: { 'content-type': 'application/json' },
    body: once(vendorErrorBody(route, type, message)),
  });

  // As masq's: the model the request named picks the provider, and a 2xx must be answered by it — for the id
  // it is sent, the provider's own (providerWireModel), which is never the gateway-side spelling.
  const send = async (req: UpstreamRequest): Promise<UpstreamResponse> => {
    if (req.signal.aborted) throw new UpstreamError('aborted', 'the request was aborted');
    const requested = requestedModelOf(req.body);
    if (requested === null) throw new UpstreamError('model', 'the request names no model, so the model that answers it could not be checked: it was not sent');
    const lane = providerFor(req.route, requested);
    if ('refused' in lane) return own(req.route, 400, 'invalid_request_error', lane.refused);
    const { provider } = lane;
    // Every provider is sent, and must answer for, its own id: the gateway-side provider prefix names how the
    // id routes and never reaches a provider's wire. An id the grammar does not prefix is sent as it came.
    const sent = providerWireModel(provider, requested);
    if (sent === '') {
      return own(req.route, 400, 'invalid_request_error', `make.fun: on your own key, ${clipName(requested)} names no model: the \`openrouter/\` prefix is the gateway's, and OpenRouter's own id follows it`);
    }
    const key = keys[provider];
    if (key === undefined) return own(req.route, 401, 'authentication_error', noProviderKeyMessage(provider, entrySecrets));
    const body = sent === requested ? req.body : bodyWithModel(req.body, sent);
    const kept: Record<string, string> = {};
    for (const name of PROVIDER_CLIENT_HEADERS[provider]) {
      const v = req.headers[name];
      if (v !== undefined) kept[name] = v;
    }
    // The provider's auth first, so a client's own anthropic-version wins over the default; `kept`
    // holds no auth header (PROVIDER_CLIENT_HEADERS names none), so the key is always the entrant's.
    const headers: OutgoingHttpHeaders = {
      ...providerAuth(provider, key),
      ...kept,
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
      'accept-encoding': 'identity',
      'user-agent': GATEWAY_USER_AGENT,
    };
    try {
      const { res, destroy } = await dial(dialers[provider], PROVIDER_ROUTES[provider].chat[req.route]!, headers, { ...req, body });
      return await vetServedModel(sent, res, destroy, { who: PROVIDER_NAMES[provider], swapHeader: null, matches: isProviderServedModel, ...(sent === requested ? {} : { asked: requested }) });
    } catch (err) {
      if (err instanceof UpstreamError) throw new UpstreamError(err.kind, redact(err.message));
      throw err;
    }
  };

  return {
    kind: 'provider',
    send,
    close() {
      agent.destroy();
    },
  };
}

// ------------------------------------------------------------------ the fake

/** One scripted answer. */
export interface FakeReply {
  status: number;
  /** Response headers (content-type, ...). */
  headers?: Readonly<Record<string, string>>;
  /** The body, in the chunks it is sent in (strings as UTF-8). */
  chunks?: readonly (string | Uint8Array)[];
  /** Wait this long before the head. */
  delay_ms?: number;
  /** Wait this long before each chunk. */
  chunk_delay_ms?: number;
  /** connect: reject before any head; reset: drop the body after the chunks. */
  fail?: 'connect' | 'reset';
}

/** A request the fake took: the route, the headers it would have been sent with (the key included) and the body. */
export interface FakeRequest {
  route: PolicedRoute;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type FakeScript = readonly FakeReply[] | ((req: FakeRequest, n: number) => FakeReply | Promise<FakeReply>);

export interface FakeUpstream extends Upstream {
  /** Every request sent, in order. */
  readonly requests: FakeRequest[];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UpstreamError('aborted', 'the request was aborted'));
    if (ms <= 0) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new UpstreamError('aborted', 'the request was aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A scripted upstream: replies in order from a list (a request past its end fails as `connect`), or
 * from a function of the request. It injects `key` in the header masq takes it in (vendorAuth), so a
 * test sees what an upstream would.
 */
export function fakeUpstream(script: FakeScript, opts: { key?: string } = {}): FakeUpstream {
  const requests: FakeRequest[] = [];
  const send = async (req: UpstreamRequest): Promise<UpstreamResponse> => {
    const n = requests.length;
    const headers: Record<string, string> = { ...req.headers, ...(opts.key !== undefined ? vendorAuth(ROUTE_VENDOR[req.route], opts.key) : {}), 'content-type': 'application/json', 'accept-encoding': 'identity' };
    const taken: FakeRequest = { route: req.route, headers, body: Uint8Array.from(req.body) };
    requests.push(taken);
    if (req.signal.aborted) throw new UpstreamError('aborted', 'the request was aborted');
    const reply = typeof script === 'function' ? await script(taken, n) : script[n];
    if (reply === undefined) throw new UpstreamError('connect', `the fake upstream's script has no reply for request ${n}`);
    await sleep(reply.delay_ms ?? 0, req.signal);
    if (reply.fail === 'connect') throw new UpstreamError('connect', 'the fake upstream refused the connection');
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(reply.headers ?? {})) lower[k.toLowerCase()] = v;
    const signal = req.signal;
    async function* body(): AsyncIterable<Uint8Array> {
      for (const c of reply!.chunks ?? []) {
        await sleep(reply!.chunk_delay_ms ?? 0, signal);
        yield typeof c === 'string' ? encoder.encode(c) : c;
      }
      if (reply!.fail === 'reset') throw new UpstreamError('reset', 'the fake upstream dropped the connection');
    }
    return { status: reply.status, headers: lower, body: body() };
  };
  return { kind: 'fake', requests, send, close() {} };
}

// ------------------------------------------------------------------ none

/** What a request to the `none` upstream meets (the forwarder's 502 carries it after its own words): no model is behind the gateway. */
export const NO_MODEL_MESSAGE =
  'this competition provides no model (it does not require model calls, and this grade was given no provider key nor --gateway), so no model is behind the gateway to answer this request';

/** The upstream with no model behind it (the header's `none`): every request rejects as `connect` with NO_MODEL_MESSAGE, an abort as `aborted`. */
export function noModelUpstream(): Upstream {
  const send = async (req: UpstreamRequest): Promise<UpstreamResponse> => {
    if (req.signal.aborted) throw new UpstreamError('aborted', 'the request was aborted');
    throw new UpstreamError('connect', NO_MODEL_MESSAGE);
  };
  return { kind: 'none', send, close() {} };
}

// ------------------------------------------------------------------ from the config

/** A fake reply as the config carries it (chunks as UTF-8 text). */
export const FakeReplyConfig = z.strictObject({
  status: z.int().min(100).max(599),
  headers: z.record(z.string(), z.string()).optional(),
  chunks: z.array(z.string()).max(100_000).optional(),
  delay_ms: z.int().min(0).max(600_000).optional(),
  chunk_delay_ms: z.int().min(0).max(600_000).optional(),
  fail: z.enum(['connect', 'reset']).optional(),
});

/** A provider's origin as the config may give it (a test's fake provider): parseOrigin's, https only. */
export const ProviderOrigin = z.string().superRefine((s, ctx) => {
  try {
    if (parseOrigin(s).protocol !== 'https:') ctx.addIssue({ code: 'custom', message: `provider origin ${JSON.stringify(s)} is not https: an entrant's key goes to its provider over verified TLS only` });
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
  }
});

/** The most of a PEM bundle a provider config's `ca` holds. */
export const MAX_CA_CHARS = 65_536;

/**
 * The `provider` adapter as the config names it: by default each provider at providers.ts's origin
 * under Node's bundled CAs; `origins` and `ca` point it at a test's fake provider instead (https and
 * verified TLS whatever they say); `entry_secrets` is EntrySecretsOpen (absent: `on`), off when the
 * deployment that wrote the config lets no entrant push a secret. Its keys and mask values are the
 * config's `keys` and `mask` (main.ts LiveGatewayConfig), never here.
 */
export const ProviderUpstreamConfig = z.strictObject({
  adapter: z.literal('provider'),
  origins: z
    .strictObject({ anthropic: ProviderOrigin.optional(), openai: ProviderOrigin.optional(), google: ProviderOrigin.optional(), openrouter: ProviderOrigin.optional() })
    .optional(),
  ca: z.string().min(1).max(MAX_CA_CHARS).optional(),
  entry_secrets: EntrySecretsOpen.optional(),
});

/** The entrant's own keys as the config carries them (ProviderKeys): each a header-safe UpstreamKey. */
export const ProviderKeysConfig = z.strictObject({ anthropic: UpstreamKey.optional(), openai: UpstreamKey.optional(), google: UpstreamKey.optional(), openrouter: UpstreamKey.optional() });

/** UTF-8 that refuses what is not (a lone surrogate never reaches it: MaskValue checks the string first). */
const UTF8_BYTES = new TextEncoder();

/** Whether `text` holds at least SECRET_FORM_MIN_CHARS code points. */
function maskable(text: string): boolean {
  let n = 0;
  for (const _ of text) if (++n >= SECRET_FORM_MIN_CHARS) return true;
  return false;
}

/**
 * A value the forwarder masks every form of (secretFormSet) beside the keys: an entrant's env-lane entry secret, or an
 * org or project id the provider pre-flight learned. At least SECRET_FORM_MIN_CHARS characters (a shorter one cannot be
 * masked reliably: it would mangle an answer's own text), at most ENTRY_SECRET_VALUE_MAX_BYTES of UTF-8 (an entry
 * secret's own limit, contracts/entry-secrets.ts), well-formed, no NUL. A refusal never quotes it.
 */
export const MaskValue = z.string().superRefine((s, ctx) => {
  const refuse = (message: string): void => ctx.addIssue({ code: 'custom', message });
  if (!s.isWellFormed() || s.includes('\0')) return refuse('a mask value is well-formed text with no NUL');
  if (!maskable(s)) return refuse(`a mask value is at least ${SECRET_FORM_MIN_CHARS} characters: a shorter one cannot be masked reliably`);
  if (UTF8_BYTES.encode(s).byteLength > ENTRY_SECRET_VALUE_MAX_BYTES) return refuse(`a mask value is at most ${ENTRY_SECRET_VALUE_MAX_BYTES} bytes of UTF-8`);
});
/** The most org and project ids a config masks, those the pre-flight learned. */
export const MAX_LEARNED_IDS = 64;
/** The most values a config's `mask` (or `request_mask`) holds: every entry secret an entrant may hold, and the learned ids. */
export const MAX_MASK_VALUES = ENTRY_SECRET_MAX_COUNT + MAX_LEARNED_IDS;
export const MaskValues = z.array(MaskValue).max(MAX_MASK_VALUES);

/**
 * The `router` adapter as the config names it (routerUpstream): superbot-router's origin, the service tier every
 * request asks for (`speed`, its x-sbr-speed), and, optionally, the caller the router buckets its streams by
 * (`user`, written as each body's metadata.user_id). Its key is the config's `key` (main.ts LiveGatewayConfig).
 */
export const RouterUpstreamConfig = z.strictObject({
  adapter: z.literal('router'),
  origin: UpstreamOrigin,
  speed: RouterSpeed,
  user: RouterUser.optional(),
});

/**
 * The config's `upstream` (main.ts GatewayConfig): masq at its origin, superbot-router at its origin (`router`:
 * the house lane of a target whose models the router serves), the entrant's own providers (`provider`, on the
 * config's `keys`), a test's fake, or none (no model behind the gateway: a local grade's NO_MODEL_UPSTREAM).
 * There is no other: nothing in a config, and nothing the client sends, points the forwarder anywhere but masq,
 * the house's router, or the provider an entrant's own key is for.
 */
export const UpstreamConfig = z.discriminatedUnion('adapter', [
  z.strictObject({ adapter: z.literal('masq'), origin: UpstreamOrigin }),
  RouterUpstreamConfig,
  ProviderUpstreamConfig,
  z.strictObject({ adapter: z.literal('fake'), replies: z.array(FakeReplyConfig).max(100_000) }),
  z.strictObject({ adapter: z.literal('none') }),
]);
export type UpstreamConfigT = z.infer<typeof UpstreamConfig>;

/** What the `provider` adapter runs on: the entrant's keys and the values masked with them. */
export interface ProviderCredentials {
  keys: ProviderKeys;
  mask: readonly string[];
}

/**
 * The adapter a config names, on its credentials: one key for masq, the router (the house lane's router key),
 * the fake (a test's) and none (sent nowhere); the entrant's keys and mask values for `provider`. Either given
 * to the other is a TypeError.
 */
export function upstreamFromConfig(upstream: UpstreamConfigT, credentials: string | ProviderCredentials): Upstream {
  if (upstream.adapter === 'provider') {
    if (typeof credentials === 'string') throw new TypeError("the provider adapter runs on the entrant's keys by provider, not on one key");
    return providerUpstream({
      keys: credentials.keys,
      mask: credentials.mask,
      ...(upstream.origins === undefined ? {} : { origins: upstream.origins }),
      ...(upstream.ca === undefined ? {} : { ca: upstream.ca }),
      ...(upstream.entry_secrets === undefined ? {} : { entrySecrets: upstream.entry_secrets }),
    });
  }
  if (typeof credentials !== 'string') throw new TypeError(`the ${upstream.adapter} adapter runs on one key, not on keys by provider`);
  const key = credentials;
  switch (upstream.adapter) {
    case 'masq':
      return masqUpstream({ origin: upstream.origin, key });
    case 'router':
      return routerUpstream({ origin: upstream.origin, key, speed: upstream.speed, ...(upstream.user === undefined ? {} : { user: upstream.user }) });
    case 'fake':
      return fakeUpstream(upstream.replies, { key });
    case 'none':
      return noModelUpstream();
  }
}
