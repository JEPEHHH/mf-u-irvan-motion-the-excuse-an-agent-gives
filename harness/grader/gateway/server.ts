// The gateway forwarder: the node:http server an agent/v1 trial's entry reaches its models through
// (http://llm:8080 on the trial network). LIVE it checks each request against the trial's policy,
// forwards what the policy admits to its one upstream, masq on the trial's masq key, superbot-router on
// the house lane's router key, or the entrant's own providers on the entrant's own keys (a test's fake
// instead; grader/gateway/upstream.ts), relays
// the answer as it arrives, meters it and records it in the cassette. REPLAY it serves the recorded
// cassette back and never dials out: it holds no upstream at all.
//
// The credential (LiveGatewayOptions.credential) says whose key the lane's calls run on: `house` (masq:
// the default) or `entrant` (the `provider` adapter, main.ts). It goes to the meter, which on an
// entrant's key leaves the entrant's own key errors (401, 402, 403, 407, 429) out of the void count
// (meter.ts). An entrant's key never pays for the house lane: `entrant` with lane `house` is refused.
//
// LIVE every call is priced on the policy's pricing table (policy.ts GatewayPolicy.pricing_rev, the
// trial's run's revision, else the bundled rows) and the cassette is stamped with that revision
// (meter.ts TrialMeter.pricing_rev), so a run's trials share one table whichever release's grader
// records them. A revision this grader holds no table of (pricing/revs.ts) throws policy.ts
// PricingRevisionNotHeldError from the constructor: the forwarder never starts, nothing is recorded.
//
// Routes (anything else is 404, the same answer whatever was asked):
//   POST /v1/messages          anthropic.messages
//   POST /v1/chat/completions  openai.chat
//   POST /v1/responses         openai.responses
//   GET  /v1/models            models: the policy's allowlist, answered by the forwarder (a cassette entry)
//   GET  /__ready              the harness's probe: 200 only with the ready file's token in
//                              x-makefun-ready-token (main.ts writes the file once listening), else
//                              the same 404, so an entry cannot tell it is there
// A query string is dropped: it neither reaches the upstream nor moves the request key (the Anthropic
// SDK's beta client posts /v1/messages?beta=true).
//
// The lane (CommonOptions.client; grader/agent.ts gives each of a pass's forwarders one): the model
// routes answer only the caller holding the lane's credential, compared as the ready token is. Lane
// `entry` (http://llm:8080) wants the entry's API key, as x-api-key or Authorization: Bearer
// (contracts/agent.ts AGENT_GATEWAY_ENV): derived from the trial (grader/agent.ts entryLaneKey), it is
// hygiene against an env calling the entry's lane by mistake, not a secret boundary. Lane `house`
// (http://house:8080, a target's) wants the env's house token in HOUSE_TOKEN_HEADER (AGENT_HOUSE_ENV),
// random each pass and held by the env alone: the boundary keeping the entry off the house's models.
// Anything else is CLIENT_REFUSED_STATUS (401), its connection closed, before the body is read:
// nothing is recorded, live or replayed, and neither credential is keyed (cassette.ts KEYED_HEADERS) or
// sent upstream (FORWARDED_CLIENT_HEADERS). A trial network lets every role reach every other
// (grader/sandbox/network.ts), so the credential is the only gate. Lane `house` on masq also sends every
// request upstream as a masq side spawn (HOUSE_UPSTREAM_HEADERS), so masq places no cache breakpoint on the
// target's prompts and the meter reads the house lane's spend as masq bills it; lane `entry` sends none,
// its caching being the entrant's, and the router lane none (it is masq's word). None moves a request key:
// the cassette keys the client's headers.
//
// The forwarder reads its upstream's kind (upstream.ts Upstream.kind): `masq`, `router` (superbot-router,
// the house lane of a target whose models the router serves), `provider` (an entrant's own keys), or a
// test's `fake`.
//
// superbot never goes through masq (the owner, 2026-11-12: "we CANNOT EVER use masq for superbot-router on
// this project, it is FORBIDDEN"). On any lane whose upstream is masq, a request naming a model the router
// serves (namesRouterModel: grader/dialect.ts ROUTER_MODELS, `superbot`, `superbot-fast` and the spellings
// folded to them, masq's `superbot-router/superbot` among them, as written or under masq's routing grammar)
// is not sent: 502 upstream_error in the route's shape (ROUTER_MODEL_ON_MASQ_MESSAGE), settled as a
// transport error that sent nothing, so it costs nothing and counts toward the void. masq's route rows
// (upstream.ts MASQ_ROUTE_ROWS, isServedModel) stay for their readers elsewhere; this forwarder renames no
// model.
//
// Lane `house` on masq dials a Claude model in its own dialect: a Chat Completions request (a sealed env's)
// that grader/dialect.ts chatToMessages can say faithfully as a Messages request goes upstream on
// anthropic.messages (POST /v1/messages, x-api-key, HOUSE_MESSAGES_HEADERS: anthropic-version and the side
// spawn), its system prompt under a cache breakpoint of the request's own (masq places none on a side
// spawn). Any other request, a model the dialect does not know included, is sent on as it came
// (houseForwardBody), but that on Chat Completions an assistant turn that says nothing (an env's retry
// sending back a reply cut off before any text) is left out and the user turns either side merge, as on
// Messages, which only the upstream sees. A body with none goes byte for byte.
//
// Lane `house` on superbot-router (`router`) dials the router alone, on Messages alone: a Chat Completions
// request grader/dialect.ts chatToRouterMessages maps (a router house model under its bare id, effort as
// output_config.effort, streamed) goes upstream on anthropic.messages with ROUTER_MESSAGES_HEADERS
// (anthropic-version alone: no side spawn, which is masq's; the adapter adds x-api-key, x-sbr-speed and
// metadata.user_id). Anything else, on any lane (a request the mapping cannot say, a model it does not
// serve, another route), is not sent: 502 upstream_error in the route's shape (ROUTER_UNSAID_MESSAGE),
// recorded as an upstream_error costing nothing. masq's door is not the router's: sendPastSeatRefusals never
// runs there, and the adapter's retry ladder (ROUTER_HOUSE_TRIES sends inside ROUTER_HOUSE_LADDER_MS, each wait the
// router's own retry-after) is the only wait (upstream.ts routerUpstream).
//
// Either way the answer is held whole, metered as the Messages answer it is (its cache reads and writes
// priced as such; a router answer's `usage.speed` flex at superbot's Standard rate), and answered and
// recorded as the Chat Completions answer messagesToChat makes of it (chatAnswerOf): the client, the request
// key (the body as received, on openai.chat) and the cassette see Chat Completions alone, so a replay, of a
// cassette recorded before this or after, never knows. An event stream (the router's answer) is assembled
// first (grader/dialect.ts messagesStreamToMessage): a stream that never reached message_stop is a 502
// upstream_error; an in-band error event is answered in Chat's error shape, its type and message kept, at
// its type's status (overloaded 529, rate limit 429, api error 500), an upstream_error. A router answer is
// taken only from the router's primary: a 2xx whose final `sbr` marker is missing or whose `sbr.tier` is
// not `primary` (a standby) is a 502 upstream_error naming its model_version, settled as a transport error;
// the Chat answer stored carries `sbr: {model_version, tier}`. The router's request is this forwarder's own
// mapping of the env's fixed body, never the entry's, so any answer outside 200 to 299 is the platform's fault:
// a 400, 404, 409, 413 or 422 too is answered as it came but settled an upstream_error (meter.ts
// UpstreamResult.forwarder_request), costing what it reported (a refusal reports nothing), and the pass voids by
// the house-lane rule rather than lose the game the env stops on it; masq's and a provider's 4xx keep meter.ts's
// table. No timer is the router's own: the stream
// total (stream_total_ms) bounds it as any answer, and an env's own 180 s house timeout goes first.
// #answerChat says how a cut answer ends.
//
// Lane `house` on masq waits out masq's door (sendPastSeatRefusals): an answer that is masq refusing for want
// of a pooled seat, or of a seat for this caller's key to bind to (upstream.ts masqSeatRefusal: 429, its own
// sentences) reached no provider and cost nothing, and a seat comes back as it cools or frees, so the same
// request goes again after each step of HOUSE_SEAT_RETRY_MS (fixed steps, no jitter, 59 s in all: a third
// of an env's 180 s house timeout, leaving the rest for the answer). A refused attempt is neither metered
// nor recorded: the request keeps the one cassette entry begun at its arrival, settled once with the answer
// it ends with, so a replay serves it as a first-try answer. Past the last step the refusal is answered as
// it came, as any upstream error is (an env voids its trial on it). Nothing else is sent again: a provider's
// 429 or 5xx, a 4xx, the policy's own refusals (never sent), lane `entry` at all (an entrant's key's errors
// are the entrant's), and the router lane past its adapter's retry ladder (ROUTER_HOUSE_TRIES sends inside
// ROUTER_HOUSE_LADDER_MS). The wait is inside the request's
// stream total, and a client gone or the trial closing ends it.
//
// Hardening (#1268):
//   - the request target must be a path: absolute-form (`POST http://elsewhere/...`) and asterisk-form
//     are 400, CONNECT is 405 and an upgrade is 404, each with the connection closed; the upstream
//     origin is the adapter's, so no URL, Host or query the client sends reaches it
//   - request headers past MAX_HEADER_BYTES (64 KiB) are 431 (Node's parser)
//   - a body over the policy's max_request_bytes is not held: it is read on and counted (the policy's
//     request_too_large names its whole size), and past max_drain_bytes more the connection is dropped
//     unanswered, as a malformed request would be (nothing is recorded, live or replayed)
//   - a response is relayed up to max_response_bytes (64 MiB) and for stream_total_ms (300 s) from the
//     moment it is sent upstream; past either the upstream is torn down and the client's response
//     ends there
//   - client headers reach the upstream only from FORWARDED_CLIENT_HEADERS (anthropic-version,
//     anthropic-beta, openai-beta), minus any the client's Connection header names hop-by-hop; every
//     other header, Authorization and x-api-key included, is dropped, the house lane on masq adds its own
//     (HOUSE_UPSTREAM_HEADERS; on the router ROUTER_MESSAGES_HEADERS alone), and the adapter adds the key
//   - the key never leaves: it is in no answer (an upstream echoing it gets every occurrence masked,
//     each maximal run SECRET_MARK, wherever the chunks split it, before the client or the cassette
//     sees it: grader/gateway/secret-mask.ts BytesMasker), no fault message (REDACTED_MARK) and no
//     file the forwarder writes. `secrets` is every value so kept, each in every form
//     (upstream.ts secretFormSet): the masq key, the router key, or an entrant's keys with its env-lane entry secrets
//     and the org and project ids their key check learned (main.ts). An answer the forwarder makes
//     itself (a refusal, which may quote what a request named) is masked as a relayed one is
//   - an entrant's env-lane entry secrets (CommonOptions.requestSecrets, main.ts `request_mask`) are
//     masked, in every form, out of each request's keyed headers and every string of its parsed body
//     before the request key is taken, and out of the model it named as the cassette records it
//     (cassette.ts keyRequest's mask): the cassette's request side holds no hash over a secret, and a
//     replay given the same secrets keys each request as its live pass did. What goes upstream is the
//     request as the entry sent it, to the entrant's own provider
//
// What the client sees is a function of the cassette entry alone, so a replay answers the same:
// status, `content-type` (plus REFUSAL_HEADERS on a refusal), the body, chunked, with no Date. Upstream
// response headers other than content-type are not passed on, retry-after and retry-after-ms included:
// the entry records no header (contracts/agent.ts CassetteEntry), so a wait passed on live would be
// missing from the replay, and an entry that read it could replay otherwise (another state.json, or a
// replay_timeout: grader/agent.ts). An upstream 429 reaches the agent as its status and body, and the
// agent's SDK backs off on its own schedule (no x-should-retry). One more is read: SERVICE_TIER_HEADER,
// the tier Google says the call billed at, goes to the meter (meter.ts UpstreamResult.service_tier), so
// a Priority request Google downgraded is charged Standard; the cassette keeps no header, only the
// entry's micro_usd shows it.
//
// Per request, LIVE, once its body has arrived and synchronously (before any await, so seq is arrival
// order): the request key on the body as received (cassette.ts keyRequest), the time `at`, the
// policy (meter.ts TrialMeter.admit, which reserves the worst case), and CassetteWriter.begin. Then:
//   refused      the policy's refusal, in the vendor's shape with REFUSAL_HEADERS (a body the
//                cassette cannot key is invalid_json with its reason)
//   models       the allowlist (MODELS_CONTENT_TYPE JSON)
//   forwarded    policy forward_body to the upstream; the response streamed through byte for byte
//                and tapped for usage (meter.ts UsageTap); then TrialMeter.settle and
//                CassetteWriter.settle with the bytes the client was sent. When nothing came back the
//                forwarder answers in the vendor's shape itself:
//                  502  no connection, TLS not verified, a reset or malformed answer, an answer
//                       served by another model or naming none (upstream.ts vetServedModel,
//                       UpstreamError `model`), or a redirect (never followed); and, never
//                       sent at all, a router model on masq or a request the router lane cannot say
//                       (see above)
//                  504  the stream total ran out before a response head
//                  499  the client went first (it never sees this; the entry records it)
//                A response cut part way (a reset, a cap, the stream total, the client gone) is settled
//                with the bytes relayed, and the client's response simply ends there.
// REPLAY: the same key, then CassetteReplay.take at once; a hit is answered from its blob, a miss with
// 400 cassette_miss (REFUSAL_HEADERS: no SDK retries it) and onMiss.
//
// The request log (requests.ts; LiveGatewayOptions.captureRequests, on by default): LIVE, CassetteWriter.begin also
// streams each request's line into the trial's zstd request log, the canonical bytes its request_key is the sha256 of
// (cassette.ts keyedJson: the keyed headers and the parsed body, the request mask applied), so the log holds the
// trial's tool definitions, system prompts and sampling settings and each line verifies against its cassette entry.
// A request whose keyed bytes still hold a form of a secret answers are masked of (the masq or router key, an entrant's
// provider keys and the ids their pre-flight learned) keeps its line without them (`withheld`). The log is stored at
// close() after the cassette (GatewayResult.requests); its failure is GatewayResult.requests_fault alone, never a
// fault: the trial, the cassette, the replay and every digest are the same with the log or without it. REPLAY keeps one
// only when asked (ReplayGatewayOptions.captureRequests, off by default): each hit's line under the seq of the entry it
// consumed, put back in seq order (requests.ts ReorderedRequestLog), stored only when the replay is ok.
//
// close() ends the trial: no new requests (503), every exchange in flight torn down and settled as
// the client's (the entry is over), then LIVE the cassette written (CassetteWriter.finish) and checked
// against the meter's totals, REPLAY the verdict (CassetteReplay.stop). Anything that is not the
// entry's doing (a blob store fault, a corrupt replay blob, the meter and the cassette disagreeing) is
// a fault in the result: an infrastructure fault, never nondeterminism.

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import type { Duplex } from 'node:stream';
import type { CassetteEntryT, CassetteT } from '../../contracts/agent.ts';
import { chatMessagesWithoutBlankTurns, chatToMessages, chatToRouterMessages, MESSAGES_API_VERSION, messagesStreamToMessage, messagesToChat, routerModel, type MessagesAnswer } from '../dialect.ts';
import {
  CassetteReplay,
  CassetteWriter,
  keyRequest,
  type CassetteBlobs,
  type CassetteMiss,
  type CassetteResponse,
  type CassetteRouteT,
  type KeyedRequest,
  type ReplayVerdict,
  type UnkeyedRequest,
  type WrittenCassette,
} from './cassette.ts';
import { ReorderedRequestLog, RequestLogWriter, type WrittenRequests } from './requests.ts';
import { CREDENTIALS, TrialMeter, UsageTap, type Admission, type Credential, type MeterSnapshot, type Ticket, type UpstreamResult } from './meter.ts';
import { GatewayPolicy, REFUSAL_HEADERS, type GatewayPolicyT, type PolicedRoute, type PolicyAllow } from './policy.ts';
import { BytesMasker, FormSet, maskBytes, maskText } from './secret-mask.ts';
import {
  MASQ_SEAT_REFUSAL_STATUS,
  masqSeatRefusal,
  MAX_SEAT_REFUSAL_BYTES,
  modelIdentity,
  redactForms,
  secretFormSet,
  UpstreamError,
  vendorErrorBody,
  type Upstream,
  type UpstreamRequest,
  type UpstreamResponse,
} from './upstream.ts';

/** The port the forwarder listens on in its container. */
export const GATEWAY_PORT = 8080;
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const STREAM_TOTAL_MS = 300_000;
/** How far a body may run past max_request_bytes before the connection is dropped unanswered. */
export const MAX_DRAIN_BYTES = 64 * 1024 * 1024;

/** The routes, by exact path. */
export const GATEWAY_ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; route: CassetteRouteT }>> = Object.freeze({
  '/v1/messages': { method: 'POST', route: 'anthropic.messages' },
  '/v1/chat/completions': { method: 'POST', route: 'openai.chat' },
  '/v1/responses': { method: 'POST', route: 'openai.responses' },
  '/v1/models': { method: 'GET', route: 'models' },
});

export const READY_PATH = '/__ready';
export const READY_TOKEN_HEADER = 'x-makefun-ready-token';
/** The header the house lane's caller presents its token in (CommonOptions.client, lane `house`). */
export const HOUSE_TOKEN_HEADER = 'x-makefun-house-token';
/** The status a model route answers a caller without the lane's credential. */
export const CLIENT_REFUSED_STATUS = 401;

/** The only client headers sent upstream (independently of the request key's KEYED_HEADERS). */
export const FORWARDED_CLIENT_HEADERS: readonly string[] = Object.freeze(['anthropic-version', 'anthropic-beta', 'openai-beta']);

/**
 * What lane `house` adds to every request it sends upstream, after the client's (upstreamHeaders). A request
 * naming itself a side spawn with no x-cosmos-chat (never forwarded) is a one-shot to masq (masq
 * src/cache-hints.ts isOneShotSideSpawn), which then places no cache breakpoint of its own. At a breakpoint of
 * masq's a Claude model writes the prompt to the cache (1.25x input, 2x at 1h) and masq bills the write, but
 * its chat-completions answer folds the write into prompt_tokens, so the meter would charge it as input and
 * read the target's spend low against harness.target's caps (and masq.ts retireTrialKey would flag
 * gateway_spend_mismatch). The judge does the same (grader/judge-call.ts JUDGE_SIDE_SPAWN). Lane `entry`
 * adds none: its caching is the entrant's.
 */
export const HOUSE_UPSTREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'x-cosmos-side-spawn': 'makefun-house' });

/** The status a request the client abandoned before any answer is recorded with. */
export const CLIENT_CLOSED_STATUS = 499;
/** The status a replayed request the cassette has no entry for is answered. */
export const REPLAY_MISS_STATUS = 400;
export const MODELS_CONTENT_TYPE = 'application/json';

export interface GatewayLimits {
  max_response_bytes: number;
  stream_total_ms: number;
  max_drain_bytes: number;
}

export const DEFAULT_LIMITS: Readonly<GatewayLimits> = Object.freeze({
  max_response_bytes: MAX_RESPONSE_BYTES,
  stream_total_ms: STREAM_TOTAL_MS,
  max_drain_bytes: MAX_DRAIN_BYTES,
});

/**
 * Who the model routes answer (see the header): lane `entry` a caller presenting `token` as its API key
 * (x-api-key, or Authorization: Bearer), lane `house` one presenting it in HOUSE_TOKEN_HEADER.
 */
export interface GatewayClient {
  lane: 'entry' | 'house';
  token: string;
}

interface CommonOptions {
  /** The trial's policy (policy.ts GatewayPolicy). Replay reads max_request_bytes from it, so a body is held exactly as it was live; live prices on its pricing_rev. */
  policy: GatewayPolicyT;
  limits?: Partial<GatewayLimits>;
  /** The token GET /__ready must present; without one /__ready is always 404. */
  readyToken?: string;
  /** The lane's caller and its credential; absent, the model routes answer anyone who reaches them. */
  client?: GatewayClient;
  /**
   * An entrant's env-lane entry secrets: every form of each (upstream.ts secretFormSet) masked out of each request before
   * it is keyed, and out of the model it named as recorded (see the header). The same on a live pass and its replay, so
   * the replay keys each request as live did; LIVE they are masked out of every answer too, as `secrets` are.
   */
  requestSecrets?: readonly string[];
}

export interface LiveGatewayOptions extends CommonOptions {
  mode: 'live';
  trial: CassetteT['trial'];
  upstream: Upstream;
  /** Whose key the lane's calls run on (default `house`, masq): `entrant` on the `provider` adapter. The meter reads it (meter.ts TrialMeter). */
  credential?: Credential;
  /** Where response bodies and the cassette are stored. */
  blobs: Pick<CassetteBlobs, 'put'>;
  /**
   * The trial's key, or an entrant's keys with its env-lane entry secrets and the ids their pre-flight learned (any other
   * secret): every form of each (upstream.ts secretFormSet) masked out of every answer, and out of every fault message.
   */
  secrets?: readonly string[];
  /** The clock a request's `at` is read from. */
  now?: () => Date;
  /** How lane `house` waits between attempts masq refused for want of a seat (sendPastSeatRefusals); a test's own, else realSleep. */
  sleep?: GatewaySleep;
  /** close() also writes the cassette's canonical bytes here. */
  cassettePath?: string;
  /**
   * Keep the trial's request log (requests.ts; the header's request log): default true. false keeps none (GatewayResult
   * requests null). The cassette is the same bytes either way.
   */
  captureRequests?: boolean;
}

export interface ReplayGatewayOptions extends CommonOptions {
  mode: 'replay';
  cassette: CassetteT;
  blobs: Pick<CassetteBlobs, 'get'>;
  /** Called at a miss, synchronously: the harness stops the entry. */
  onMiss?: (miss: CassetteMiss) => void;
  /**
   * Opt-in, off by default: keep the replayed trial's request log (requests.ts) in this store, for a trial recorded
   * before its live pass kept one. A passing replay sends the live pass's requests (each one keyed as live, consumed in
   * its live seq), so its log is the live log's lines; a replay that is not ok stores none. The caller decides when
   * (never during a final: the header's request log).
   */
  captureRequests?: Pick<CassetteBlobs, 'put'>;
}

export type GatewayOptions = LiveGatewayOptions | ReplayGatewayOptions;

export interface GatewayResult {
  mode: 'live' | 'replay';
  /** No fault, and (replay) a verdict with every entry consumed and no miss. */
  ok: boolean;
  /** Infrastructure faults, in the order they happened (never the entry's doing). */
  faults: string[];
  /** LIVE: the cassette written; null when it could not be. */
  cassette: WrittenCassette | null;
  /** LIVE: the meter's account at the end. */
  meter: MeterSnapshot | null;
  /** REPLAY: the verdict. */
  replay: ReplayVerdict | null;
  /** The trial's request log, stored (requests.ts); null when none was kept or it failed. */
  requests: WrittenRequests | null;
  /** Why a request log that was kept is not stored: never a fault of the trial's (not in faults, never moves ok). */
  requests_fault: string | null;
}

const EMPTY = new Uint8Array(0);
const JSON_TYPE = 'application/json';

// ------------------------------------------------------------------ pieces

/** The headers sent upstream: FORWARDED_CLIENT_HEADERS the client sent, minus those its Connection header names. */
export function forwardedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const connection = headers.connection;
  const nominated = new Set(
    (Array.isArray(connection) ? connection.join(',') : (connection ?? ''))
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ''),
  );
  const out: Record<string, string> = {};
  for (const name of FORWARDED_CLIENT_HEADERS) {
    if (nominated.has(name)) continue;
    const v = headers[name];
    if (v === undefined) continue;
    out[name] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** The headers a lane's request is sent upstream with: forwardedHeaders, then HOUSE_UPSTREAM_HEADERS on lane `house`. */
export function upstreamHeaders(lane: GatewayClient['lane'] | null, headers: IncomingHttpHeaders): Record<string, string> {
  const out = forwardedHeaders(headers);
  return lane === 'house' ? { ...out, ...HOUSE_UPSTREAM_HEADERS } : out;
}

/**
 * What lane `house` sends a Chat Completions request it dials on Messages with (houseMessagesBody): the Messages API
 * version and HOUSE_UPSTREAM_HEADERS. The client's own headers are Chat's (openai-beta), so none goes.
 */
export const HOUSE_MESSAGES_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'anthropic-version': MESSAGES_API_VERSION, ...HOUSE_UPSTREAM_HEADERS });

/**
 * What lane `house` sends a Chat Completions request it dials on superbot-router with (houseMessagesBody on a `router`
 * upstream): the Messages API version alone. No side spawn: that is an instruction to masq, which this lane never
 * reaches; the router adapter adds its own key, speed and stream headers (upstream.ts routerUpstream).
 */
export const ROUTER_MESSAGES_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'anthropic-version': MESSAGES_API_VERSION });

/**
 * The Messages body lane `house` dials a Chat Completions request on, or null. On a `router` upstream it is the
 * router's mapping (grader/dialect.ts chatToRouterMessages: a router house model, streamed, its bare id), and null
 * means the request is not sent at all (the router lane dials nothing else; see the header). On any other upstream
 * it is Claude's (grader/dialect.ts chatToMessages), and null means the request goes on as it came: any other lane or
 * route, a model that is not Claude, or a request the dialect cannot say faithfully. A function of the lane, the
 * route, the body and the upstream's kind alone.
 */
export function houseMessagesBody(lane: GatewayClient['lane'] | null, route: CassetteRouteT, body: Uint8Array, upstream: Upstream['kind'] = 'masq'): Uint8Array | null {
  if (lane !== 'house' || route !== 'openai.chat') return null;
  return upstream === 'router' ? chatToRouterMessages(body) : chatToMessages(body);
}

/**
 * Whether `model` names a model superbot-router serves (grader/dialect.ts ROUTER_MODELS: `superbot`, `superbot-fast`,
 * and the spellings folded to them, masq's `superbot-router/superbot` among them), as written or once masq's routing
 * grammar is off it (upstream.ts modelIdentity: `superbot(high)`, `SUPERBOT`, `anthropic/superbot`): what a lane on
 * masq never sends (see the header).
 */
export function namesRouterModel(model: string): boolean {
  return routerModel(model) !== null || routerModel(modelIdentity(model)) !== null;
}

/** Why a lane on masq answers a request for a router model itself (namesRouterModel; see the header). */
export const ROUTER_MODEL_ON_MASQ_MESSAGE = 'superbot is dialled on superbot-router alone, never through masq';

/** Why a lane on superbot-router answers a request its mapping cannot say itself (houseMessagesBody null; see the header). */
export const ROUTER_UNSAID_MESSAGE = 'this house request cannot be said on Messages, and the router lane dials nothing else';

/**
 * The body lane `house` sends a request on with when it does not dial it on Messages (houseMessagesBody null; see the
 * header): on Chat Completions its assistant turns that say nothing left out and the user turns either side merged
 * (grader/dialect.ts chatMessagesWithoutBlankTurns). The model is never renamed: masq's route rows
 * (upstream.ts MASQ_ROUTE_ROWS) are no business of this forwarder's, since a router model never reaches masq. When
 * nothing is left out (any other lane or route, a body with no blank turn, one that is no JSON object) it is `body`
 * itself, so the request goes byte for byte as it came. The request key, the model recorded and the answer the env
 * reads are its own body's either way: only the upstream sees this one. A function of the lane, the route and the body
 * alone.
 */
export function houseForwardBody(lane: GatewayClient['lane'] | null, route: CassetteRouteT, body: Uint8Array): Uint8Array {
  if (lane !== 'house' || route !== 'openai.chat') return body;
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return body;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return body;
  const messages = (doc as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return body;
  const kept = chatMessagesWithoutBlankTurns(messages);
  return kept === null ? body : new TextEncoder().encode(JSON.stringify({ ...(doc as Record<string, unknown>), messages: kept }));
}

/** The tier of superbot-router's marker (`sbr.tier`) the house lane takes a turn from (see the header). */
export const ROUTER_PRIMARY_TIER = 'primary';

/** What chatAnswerOf answers: messagesToChat's, or `fault` (a stream that never finished) or `not_primary` (the router's answer from another tier, or naming none). */
export interface ChatAnswer {
  status: number;
  body: Uint8Array;
  kind: MessagesAnswer['kind'] | 'fault' | 'not_primary';
}

const clipText = (s: string): string => (s.length <= 200 ? s : `${s.slice(0, 199)}…`);

/**
 * A Messages answer held whole, at `status` and of `contentType`, as the Chat Completions answer lane `house` gives its
 * env (see the header): an event stream assembled first (grader/dialect.ts messagesStreamToMessage), its in-band error
 * at the status its type is answered at, a stream that never finished a 502 upstream_error (`fault`); then
 * messagesToChat. With `router` (a superbot-router answer) a 2xx message is taken only when its `sbr.tier` is
 * ROUTER_PRIMARY_TIER: else a 502 upstream_error naming the tier and model_version it carried (`not_primary`). Pure.
 */
export function chatAnswerOf(raw: Uint8Array, status: number, contentType: string, router: boolean): ChatAnswer {
  let doc: Uint8Array = raw;
  let at = status;
  if (/^\s*text\/event-stream\b/i.test(contentType)) {
    const s = messagesStreamToMessage(raw);
    if (s.kind === 'fault') {
      return { status: 502, body: vendorErrorBody('openai.chat', 'upstream_error', `the model provider's stream ended before its answer was whole: ${s.fault}`), kind: 'fault' };
    }
    if (s.kind === 'error') {
      doc = new TextEncoder().encode(JSON.stringify(s.error));
      at = s.status;
    } else doc = new TextEncoder().encode(JSON.stringify(s.message));
  }
  const chat = messagesToChat(doc, at);
  if (!router || chat.kind !== 'message' || at < 200 || at >= 300) return chat;
  const sbr = (JSON.parse(new TextDecoder('utf-8').decode(doc)) as Record<string, unknown>).sbr;
  const mark = sbr !== null && typeof sbr === 'object' && !Array.isArray(sbr) ? (sbr as Record<string, unknown>) : null;
  if (mark !== null && mark.tier === ROUTER_PRIMARY_TIER) return chat;
  const named = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(clipText(v)) : 'none');
  const message = mark === null
    ? "superbot-router's answer carries no sbr marker, so the model that served it is unknown: this gateway takes a house turn from the router's primary alone"
    : `superbot-router answered from its ${named(mark.tier)} tier (model_version ${named(mark.model_version)}), not its primary: this gateway takes a house turn from the router's primary alone`;
  return { status: 502, body: vendorErrorBody('openai.chat', 'upstream_error', message), kind: 'not_primary' };
}

/**
 * How long lane `house` waits before sending a request masq refused for want of a seat again (see the header):
 * fixed steps, no jitter, 59 s in all, so at most six attempts, the last sent well inside an env's 180 s house timeout
 * (competitions/werewolf-agent-01/src/server/house.ts HOUSE_TIMEOUT_MS) with time left for its answer.
 */
export const HOUSE_SEAT_RETRY_MS: readonly number[] = Object.freeze([2_000, 4_000, 8_000, 15_000, 30_000]);

/** A wait of `ms` that ends early, resolving, when `signal` aborts (the forwarder's real one; a test injects its own). */
export type GatewaySleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const realSleep: GatewaySleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * A response whose body was read whole (or as far as it got) to be looked at: the same head, its body the bytes held, then
 * the rest of the upstream's body when it was not done, then the failure that cut it, if one did. Iterated, it relays
 * exactly what the upstream sent; abandoned part way, the upstream's own body is closed with it.
 */
function heldResponse(head: UpstreamResponse, held: readonly Uint8Array[], rest: AsyncIterator<Uint8Array> | null, failure: unknown): UpstreamResponse {
  async function* body(): AsyncIterable<Uint8Array> {
    let finished = rest === null;
    try {
      for (const chunk of held) yield chunk;
      if (failure !== null) throw failure;
      while (!finished) {
        const next = await rest!.next();
        if (next.done === true) finished = true;
        else yield next.value;
      }
    } finally {
      if (!finished) await rest!.return?.();
    }
  }
  return { status: head.status, headers: head.headers, body: body() };
}

/**
 * Send a request on lane `house`, waiting out masq's door (see the header): each answer that is masq refusing for want of
 * a pooled seat or a seat for this caller (upstream.ts masqSeatRefusal) is read whole and dropped, and after the next of
 * `steps` the same request goes again; any other answer, or the refusal after the last step, is the one returned, its body relaying every byte
 * the upstream sent. A refused attempt reached no provider: nothing of it is metered or recorded. A wait the signal ends
 * (the client gone, the stream total, shutdown) rejects as UpstreamError `aborted`; send's own rejections pass through.
 */
export async function sendPastSeatRefusals(send: () => Promise<UpstreamResponse>, signal: AbortSignal, sleep: GatewaySleep = realSleep, steps: readonly number[] = HOUSE_SEAT_RETRY_MS): Promise<UpstreamResponse> {
  for (let attempt = 0; ; attempt++) {
    const head = await send();
    if (head.status !== MASQ_SEAT_REFUSAL_STATUS) return head;
    // A 429: read it (a short error document, at most MAX_SEAT_REFUSAL_BYTES) to tell masq's seat refusal from a provider's limit.
    const it = head.body[Symbol.asyncIterator]();
    const held: Uint8Array[] = [];
    let bytes = 0;
    let done = false;
    let failure: unknown = null;
    try {
      while (bytes <= MAX_SEAT_REFUSAL_BYTES) {
        const next = await it.next();
        if (next.done === true) {
          done = true;
          break;
        }
        held.push(next.value);
        bytes += next.value.byteLength;
      }
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      failure = err;
      done = true;
    }
    const answer = heldResponse(head, held, done ? null : it, failure);
    if (!done || failure !== null || attempt >= steps.length || !masqSeatRefusal(head.status, Buffer.concat(held))) return answer;
    await sleep(steps[attempt]!, signal);
    if (signal.aborted) throw new UpstreamError('aborted', 'the request was aborted while it waited for masq to have a pooled seat');
  }
}

/**
 * The response header Google names the tier a call billed at in: a Priority request over Google's
 * Priority limits is downgraded and "billed at the standard rate", the downgrade named here
 * (aistudio.google.com/docs/priority-inference, read 2026-11-07). Read for the meter, never passed on.
 */
export const SERVICE_TIER_HEADER = 'x-gemini-service-tier';

/**
 * The tier a response head says its call billed at (SERVICE_TIER_HEADER), trimmed and lowercased as
 * Google documents its values ("standard", "priority", "flex"); null when it names none, so an empty
 * header leaves the body's tier, else the request's, to decide (meter.ts billedTier).
 */
export function headerServiceTier(headers: Readonly<Record<string, string>>): string | null {
  const v = headers[SERVICE_TIER_HEADER]?.trim().toLowerCase();
  return v === undefined || v === '' ? null : v;
}

/** The headers an entry is answered with, live and replayed alike. */
export function entryHeaders(entry: Pick<CassetteEntryT, 'outcome' | 'content_type'>): Record<string, string> {
  return entry.outcome === 'refused' ? { ...REFUSAL_HEADERS } : { 'content-type': entry.content_type };
}

/** GET /v1/models: the allowlist, in a shape both SDKs read (OpenAI's list and Anthropic's page at once). */
export function modelsBody(policy: GatewayPolicyT): Uint8Array {
  const data = policy.models.map((id) => ({ id, object: 'model', type: 'model', display_name: id, created: 0, created_at: '1970-01-01T00:00:00Z', owned_by: 'makefun' }));
  return new TextEncoder().encode(JSON.stringify({ object: 'list', data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }));
}

/** Whether a header's value is exactly `expected`: a length check, then a constant-time compare (timingSafeEqual throws on unequal lengths). */
function tokenMatches(expected: Buffer, value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false;
  const v = Buffer.from(value, 'utf8');
  return v.length === expected.length && timingSafeEqual(v, expected);
}

const BEARER_RE = /^bearer +([^ ]+) *$/i;

/** Whether a request carries the lane's credential (see the header). */
export function clientAdmitted(client: { lane: GatewayClient['lane']; token: Buffer }, headers: IncomingHttpHeaders): boolean {
  if (client.lane === 'house') return tokenMatches(client.token, headers[HOUSE_TOKEN_HEADER]);
  const auth = headers.authorization;
  const bearer = typeof auth === 'string' ? BEARER_RE.exec(auth)?.[1] : undefined;
  // Both are checked whatever the first says, so the time taken never tells which one was tried.
  const byKey = tokenMatches(client.token, headers['x-api-key']);
  const byBearer = tokenMatches(client.token, bearer);
  return byKey || byBearer;
}

/**
 * `text` with every form of every secret (upstream.ts secretFormSet: each value whole too, whatever its length) replaced
 * by REDACTED_MARK: what a fault message, or a config the forwarder refuses, may say of a secret.
 */
export function redact(text: string, secrets: readonly string[] | FormSet): string {
  return redactForms(text, secrets instanceof FormSet ? secrets : secretFormSet(secrets));
}

function errorBody(route: CassetteRouteT, type: string, message: string): Uint8Array {
  return vendorErrorBody(route === 'models' ? 'openai.chat' : route, type, message);
}

interface Body {
  /** The bytes held: the whole body, or nothing when it ran past the cap. */
  held: Buffer;
  /** Every byte received. */
  size: number;
  whole: boolean;
}

/**
 * Read a request body, holding at most `cap` bytes. onEnd runs in the 'end' event itself, so what it
 * does synchronously happens in arrival order. Past cap + drain bytes onDrop runs and onEnd never does.
 */
function readBody(req: IncomingMessage, cap: number, drain: number, onEnd: (b: Body) => void, onDrop: () => void): void {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > cap + drain) {
    onDrop();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let whole = true;
  let dropped = false;
  req.on('data', (c: Buffer) => {
    if (dropped) return;
    size += c.length;
    if (size > cap + drain) {
      dropped = true;
      chunks.length = 0;
      onDrop();
      return;
    }
    if (whole && size <= cap) chunks.push(c);
    else if (whole) {
      whole = false;
      chunks.length = 0;
    }
  });
  req.on('end', () => {
    if (!dropped) onEnd({ held: whole ? Buffer.concat(chunks) : Buffer.alloc(0), size, whole });
  });
  // A client gone before its body ended was never taken: nothing is recorded.
  req.on('error', () => {
    dropped = true;
  });
}

function plainJson(res: ServerResponse, status: number, doc: unknown, close = false): void {
  if (res.headersSent || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(doc));
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': String(body.length), ...(close ? { connection: 'close' } : {}) });
  res.end(body);
}

/** Answer as an entry is answered (see the header): status, its headers, the body, chunked. */
function answer(res: ServerResponse, status: number, headers: Readonly<Record<string, string>>, body: Uint8Array): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, headers);
  res.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
}

const NOT_FOUND = { error: { type: 'not_found_error', message: 'this gateway serves POST /v1/messages, POST /v1/chat/completions, POST /v1/responses and GET /v1/models' } };

function rawRefusal(socket: Duplex, status: string, message: string): void {
  const body = JSON.stringify({ error: { type: 'invalid_request_error', message } });
  socket.on('error', () => {});
  socket.end(`HTTP/1.1 ${status}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

// ------------------------------------------------------------------ the forwarder

export class Gateway {
  readonly mode: 'live' | 'replay';
  readonly server: Server;
  readonly policy: GatewayPolicyT;
  readonly #limits: GatewayLimits;
  readonly #readyToken: Buffer | null;
  readonly #client: { lane: GatewayClient['lane']; token: Buffer } | null;
  /** Every form of every secret (LIVE: `secrets` and `requestSecrets`; REPLAY: `requestSecrets`): what no answer may hold. */
  readonly #secrets: FormSet;
  /** Every form of an entrant's env-lane entry secrets (`requestSecrets`), masked out of a request before it is keyed; null with none. */
  readonly #requestForms: FormSet | null;
  /** #secrets and the lane's credential: what no fault message may hold. */
  readonly #faultSecrets: FormSet;
  readonly #faults: string[] = [];
  readonly #pending = new Set<Promise<void>>();
  readonly #inflight = new Set<() => void>();
  // LIVE
  readonly #upstream: Upstream | null = null;
  readonly #meter: TrialMeter | null = null;
  readonly #writer: CassetteWriter | null = null;
  readonly #now: () => Date = () => new Date();
  readonly #sleep: GatewaySleep = realSleep;
  readonly #cassettePath: string | undefined;
  // REPLAY
  readonly #replay: CassetteReplay | null = null;
  readonly #onMiss: ((miss: CassetteMiss) => void) | undefined;
  /** REPLAY with captureRequests: the request log, put back in seq order, and where it is stored. */
  readonly #replayLog: { log: ReorderedRequestLog; blobs: Pick<CassetteBlobs, 'put'> } | null = null;
  #closing = false;
  #closed: Promise<GatewayResult> | null = null;

  constructor(opts: GatewayOptions) {
    this.mode = opts.mode;
    this.policy = GatewayPolicy.parse(opts.policy);
    this.#limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
    this.#readyToken = opts.readyToken === undefined ? null : Buffer.from(opts.readyToken, 'utf8');
    if (opts.client !== undefined && ((opts.client.lane !== 'entry' && opts.client.lane !== 'house') || opts.client.token === '')) {
      throw new TypeError('a gateway client is lane entry or house with a token');
    }
    this.#client = opts.client === undefined ? null : { lane: opts.client.lane, token: Buffer.from(opts.client.token, 'utf8') };
    const requestSecrets = [...(opts.requestSecrets ?? [])].filter((s) => s !== '');
    this.#requestForms = requestSecrets.length === 0 ? null : secretFormSet(requestSecrets);
    let secrets: string[];
    if (opts.mode === 'live') {
      const credential = opts.credential ?? 'house';
      if (!CREDENTIALS.includes(credential)) throw new TypeError(`a gateway's credential is ${CREDENTIALS.join(' or ')}`);
      if (credential === 'entrant' && opts.client?.lane === 'house') throw new TypeError("the house lane runs on the house's key: an entrant's own key never pays for it");
      if (credential === 'house' && requestSecrets.length > 0) throw new TypeError("an entrant's entry secrets ride an entrant's own lane (credential entrant): a house-paid lane runs none");
      secrets = [...(opts.secrets ?? []), ...requestSecrets];
      this.#upstream = opts.upstream;
      this.#meter = new TrialMeter(this.policy, { credential });
      this.#writer = new CassetteWriter({ trial: opts.trial, pricing_rev: this.#meter.pricing_rev, blobs: opts.blobs, requests: opts.captureRequests ?? true });
      if (opts.now !== undefined) this.#now = opts.now;
      if (opts.sleep !== undefined) this.#sleep = opts.sleep;
      this.#cassettePath = opts.cassettePath;
    } else {
      secrets = requestSecrets;
      this.#replay = new CassetteReplay(opts.cassette, opts.blobs);
      this.#onMiss = opts.onMiss;
      if (opts.captureRequests !== undefined) this.#replayLog = { log: new ReorderedRequestLog(new RequestLogWriter()), blobs: opts.captureRequests };
    }
    this.#secrets = secretFormSet(secrets);
    this.#faultSecrets = opts.client === undefined ? this.#secrets : secretFormSet([...secrets, opts.client.token]);
    this.server = createServer({ maxHeaderSize: MAX_HEADER_BYTES, requestTimeout: STREAM_TOTAL_MS, headersTimeout: 60_000, keepAliveTimeout: 5_000 }, (req, res) => this.#onRequest(req, res));
    this.server.on('connect', (_req: IncomingMessage, socket: Duplex) => rawRefusal(socket, '405 Method Not Allowed', 'CONNECT is refused: this gateway is no proxy'));
    this.server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => rawRefusal(socket, '404 Not Found', 'this gateway upgrades no connection'));
  }

  /** Listen; resolves with the address taken. */
  listen(port: number, host: string): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const failed = (err: Error): void => reject(err);
      this.server.once('error', failed);
      this.server.listen(port, host, () => {
        this.server.off('error', failed);
        resolve(this.server.address() as AddressInfo);
      });
    });
  }

  /** The faults so far (see GatewayResult.faults). */
  get faults(): readonly string[] {
    return this.#faults;
  }

  /** LIVE: the meter's account so far. */
  snapshot(): MeterSnapshot | null {
    return this.#meter?.snapshot() ?? null;
  }

  #fault(err: unknown): void {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.#faults.push(redact(text, this.#faultSecrets));
  }

  #track(p: Promise<void>): void {
    const tracked = p.catch((err: unknown) => this.#fault(err));
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  #readyOk(value: string | string[] | undefined): boolean {
    return this.#readyToken !== null && tokenMatches(this.#readyToken, value);
  }

  /** A model route's caller without the lane's credential (see the header): 401, never recorded, the connection closed. */
  #refuseClient(res: ServerResponse, route: CassetteRouteT): void {
    const message = this.#client!.lane === 'entry'
      ? "this gateway answers the trial's entry alone: present its API key (x-api-key, or Authorization: Bearer)"
      : `this gateway answers the trial's env alone: present its house token in ${HOUSE_TOKEN_HEADER}`;
    const body = route === 'models' ? new TextEncoder().encode(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message } })) : vendorErrorBody(route, 'authentication_error', message);
    if (res.headersSent || res.destroyed) return;
    res.writeHead(CLIENT_REFUSED_STATUS, { ...REFUSAL_HEADERS, 'content-length': String(body.byteLength), connection: 'close' });
    res.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    res.sendDate = false;
    const target = req.url ?? '';
    if (!target.startsWith('/')) {
      plainJson(res, 400, { error: { type: 'invalid_request_error', message: 'a request target is a path: absolute-form and asterisk-form targets are refused' } }, true);
      return;
    }
    const q = target.indexOf('?');
    const path = q === -1 ? target : target.slice(0, q);
    if (path === READY_PATH && req.method === 'GET' && this.#readyOk(req.headers[READY_TOKEN_HEADER])) {
      plainJson(res, 200, { ready: true, mode: this.mode, closing: this.#closing });
      return;
    }
    const spec = Object.hasOwn(GATEWAY_ROUTES, path) ? GATEWAY_ROUTES[path] : undefined;
    if (spec === undefined || req.method !== spec.method) {
      plainJson(res, 404, NOT_FOUND);
      return;
    }
    if (this.#client !== null && !clientAdmitted(this.#client, req.headers)) {
      this.#refuseClient(res, spec.route);
      return;
    }
    if (this.#closing) {
      plainJson(res, 503, { error: { type: 'unavailable', message: 'the trial is over: this gateway is shutting down' } }, true);
      return;
    }
    readBody(
      req,
      this.policy.max_request_bytes,
      this.#limits.max_drain_bytes,
      (body) => {
        try {
          this.#arrived(req, res, spec.route, body);
        } catch (err) {
          this.#fault(err);
          plainJson(res, 500, { error: { type: 'api_error', message: 'the gateway failed: an infrastructure fault' } }, true);
        }
      },
      () => req.socket.destroy(),
    );
  }

  /** A whole request: keyed, taken and answered (see the header). Synchronous until the first await. */
  #arrived(req: IncomingMessage, res: ServerResponse, route: CassetteRouteT, body: Body): void {
    if (this.#closing) {
      plainJson(res, 503, { error: { type: 'unavailable', message: 'the trial is over: this gateway is shutting down' } }, true);
      return;
    }
    // `models` keys no body (a GET's is ignored), so however long one ran it is keyed. An entrant's env-lane secrets are
    // masked out of what is keyed (the header's request side), live and replayed alike.
    const forms = this.#requestForms;
    const mask = forms === null ? {} : { mask: (text: string) => maskText(text, forms) };
    const keyed: KeyedRequest | UnkeyedRequest = body.whole || route === 'models'
      ? keyRequest({ route, headers: req.headers, body: body.held, ...mask })
      : { route, request_key: null, model: null, stream: false, error: `the request body is over this competition's cap of ${this.policy.max_request_bytes} bytes` };
    if (this.#replay !== null) {
      this.#track(this.#replayOne(res, keyed));
      return;
    }
    const meter = this.#meter!;
    const writer = this.#writer!;
    const at = this.#now().toISOString();
    const logged = this.#logged(keyed);
    if (route === 'models') {
      const seq = writer.begin({ at, route, request_key: keyed.request_key, model: null, stream: false, ...logged });
      meter.recordModels();
      this.#track(this.#local(res, seq, { outcome: 'upstream', status: 200, content_type: MODELS_CONTENT_TYPE, body: modelsBody(this.policy), usage: null, micro_usd: 0n }));
      return;
    }
    const d: Admission = meter.admit({
      route,
      at,
      body: body.held,
      ...(body.whole ? {} : { body_bytes: body.size }),
      ...(keyed.request_key === null ? { unkeyed: (keyed as UnkeyedRequest).error } : {}),
    });
    // The model as the cassette records it: the request's own, masked as its key is (a model the entry names is its own text).
    const model = d.model === null || forms === null ? d.model : maskText(d.model, forms);
    if (!d.allow) {
      const seq = writer.begin({ at, route, request_key: keyed.request_key, model, stream: d.stream, ...logged });
      this.#track(this.#local(res, seq, { outcome: 'refused', status: d.response.status, content_type: d.response.content_type, body: d.response.body, usage: null, micro_usd: 0n }));
      return;
    }
    if (keyed.request_key === null) throw new Error('the policy admitted a request the cassette could not key');
    const seq = writer.begin({ at, route, request_key: keyed.request_key, model, stream: d.stream, ...logged });
    this.#track(this.#forward(req, res, route, seq, d));
  }

  /**
   * What a request gives the request log (the header's request log): the bytes its key hashes, or, when they still hold a
   * form of a secret answers are masked of (#secrets: they cannot be masked further and still hash to the key), none and
   * withheld. A request with no key gives no bytes.
   */
  #logged(keyed: KeyedRequest | UnkeyedRequest): { keyed_json: string | null; withheld: boolean } {
    if (keyed.request_key === null) return { keyed_json: null, withheld: false };
    const json = (keyed as KeyedRequest).keyed_json;
    if (this.#secrets.forms.length > 0 && maskText(json, this.#secrets) !== json) return { keyed_json: null, withheld: true };
    return { keyed_json: json, withheld: false };
  }

  /** `body` with every form of every secret masked (secret-mask.ts maskBytes), or `body` itself when there are none. */
  #mask(body: Uint8Array): Uint8Array {
    return this.#secrets.forms.length === 0 ? body : maskBytes(body, this.#secrets);
  }

  /** Answer an entry the forwarder itself answers (a refusal, models), its body masked of every secret as a relayed one is, then settle it. */
  async #local(res: ServerResponse, seq: number, response: CassetteResponse): Promise<void> {
    const masked: CassetteResponse = this.#secrets.forms.length === 0 ? response : { ...response, body: maskBytes(response.body, this.#secrets) };
    answer(res, masked.status, entryHeaders(masked), masked.body);
    await this.#writer!.settle(seq, masked);
  }

  async #replayOne(res: ServerResponse, keyed: KeyedRequest | UnkeyedRequest): Promise<void> {
    const replay = this.#replay!;
    const t = replay.take({ route: keyed.route, request_key: keyed.request_key });
    if (this.#replayLog !== null) {
      // Under the seq of the entry it consumed: a passing replay's log is the live log's lines. A miss ends the log.
      if (t.hit) {
        const l = this.#logged(keyed);
        this.#replayLog.log.add({ seq: t.entry.seq, request_key: t.entry.request_key, keyed: l.keyed_json, withheld: l.withheld });
      } else this.#replayLog.log.writer.abandon('the replay missed');
    }
    if (!t.hit) {
      try {
        this.#onMiss?.(t);
      } finally {
        answer(res, REPLAY_MISS_STATUS, REFUSAL_HEADERS, errorBody(keyed.route, 'cassette_miss', 'this request is not the one the trial recorded at this point: the replay has diverged'));
      }
      return;
    }
    let body: Uint8Array;
    try {
      body = await replay.body(t.entry);
    } catch (err) {
      plainJson(res, 502, { error: { type: 'api_error', message: 'the gateway failed: an infrastructure fault' } }, true);
      throw err;
    }
    answer(res, t.entry.status, entryHeaders(t.entry), body);
  }

  async #write(res: ServerResponse, chunk: Uint8Array): Promise<void> {
    if (res.destroyed || res.writableEnded) return;
    if (res.write(chunk)) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.on('drain', done);
      res.on('close', done);
    });
  }

  /** Forward an admitted request, relay its answer, meter and record it. */
  async #forward(req: IncomingMessage, res: ServerResponse, route: PolicedRoute, seq: number, d: PolicyAllow & { ticket: Ticket }): Promise<void> {
    const meter = this.#meter!;
    const writer = this.#writer!;
    const ac = new AbortController();
    // Why the exchange was torn down, by whoever came first (a field, as callbacks set it).
    const torn: { cause: 'client' | 'timeout' | 'shutdown' | null } = { cause: null };
    const abort = (why: 'client' | 'timeout' | 'shutdown'): void => {
      torn.cause ??= why;
      ac.abort();
    };
    const onClose = (): void => {
      if (!res.writableFinished) abort('client');
    };
    res.once('close', onClose);
    const timer = setTimeout(() => abort('timeout'), this.#limits.stream_total_ms);
    const shutdown = (): void => abort('shutdown');
    this.#inflight.add(shutdown);
    try {
      let head: UpstreamResponse | null = null;
      let failure: UpstreamError | null = null;
      const lane = this.#client?.lane ?? null;
      const kind = this.#upstream!.kind;
      const onRouter = kind === 'router';
      // superbot never goes through masq, on any lane (see the header): answered here, never sent.
      if (kind === 'masq' && namesRouterModel(d.model)) {
        await this.#unsent(res, route, seq, d, ROUTER_MODEL_ON_MASQ_MESSAGE);
        return;
      }
      const messages = houseMessagesBody(lane, route, d.forward_body, kind);
      // The router lane dials what its mapping says on Messages and nothing else (see the header).
      if (onRouter && messages === null) {
        await this.#unsent(res, route, seq, d, ROUTER_UNSAID_MESSAGE);
        return;
      }
      // On Messages, or on as it came: on lane `house` without a blank assistant turn (houseForwardBody).
      const out: Omit<UpstreamRequest, 'signal'> = messages === null
        ? { route, headers: upstreamHeaders(lane, req.headers), body: houseForwardBody(lane, route, d.forward_body) }
        : { route: 'anthropic.messages', headers: onRouter ? ROUTER_MESSAGES_HEADERS : HOUSE_MESSAGES_HEADERS, body: messages };
      const send = (): Promise<UpstreamResponse> => this.#upstream!.send({ ...out, signal: ac.signal });
      try {
        // Lane `house` alone waits out masq's door, either dialect (see the header); an entrant's lane answers what came, and
        // the router lane what its adapter's retry ladder left (ROUTER_HOUSE_TRIES sends inside ROUTER_HOUSE_LADDER_MS:
        // upstream.ts routerUpstream).
        head = lane === 'house' && !onRouter ? await sendPastSeatRefusals(send, ac.signal, this.#sleep) : await send();
      } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
        failure = err;
      }

      if (head === null) {
        const gone = torn.cause === 'client' || torn.cause === 'shutdown';
        const [status, type, message] = gone
          ? [CLIENT_CLOSED_STATUS, 'client_closed_request', 'the client closed the request before the model provider answered']
          : torn.cause === 'timeout'
            ? [504, 'upstream_timeout', `the model provider sent no answer within ${this.#limits.stream_total_ms} ms`]
            : [502, failure!.kind === 'tls' ? 'upstream_tls_error' : failure!.kind === 'connect' ? 'upstream_unreachable' : 'upstream_error', `the gateway could not get an answer from the model provider: ${failure!.message}`];
        const result: UpstreamResult = { status: null, content_type: null, body: EMPTY, ...(gone ? { client_aborted: true } : { transport_error: true }) };
        const m = meter.settle(d.ticket, result);
        const body = vendorErrorBody(route, type, redact(message, this.#secrets));
        answer(res, status, { 'content-type': JSON_TYPE }, body);
        await writer.settle(seq, { outcome: m.outcome, status, content_type: JSON_TYPE, body, usage: m.usage, micro_usd: m.micro_usd });
        return;
      }

      if (head.status >= 300 && head.status < 400) {
        ac.abort();
        const m = meter.settle(d.ticket, { status: head.status, content_type: head.headers['content-type'] ?? null, body: EMPTY });
        const body = vendorErrorBody(route, 'upstream_redirect', `the model provider answered ${head.status}, a redirect, which this gateway never follows`);
        answer(res, 502, { 'content-type': JSON_TYPE }, body);
        await writer.settle(seq, { outcome: m.outcome, status: 502, content_type: JSON_TYPE, body, usage: m.usage, micro_usd: m.micro_usd });
        return;
      }

      if (messages !== null) {
        await this.#answerChat(res, seq, d, head, ac, torn, onRouter);
        return;
      }

      const status = head.status;
      const contentType = head.headers['content-type'] || 'application/octet-stream';
      const tap = new UsageTap(route, contentType);
      const mask = new BytesMasker(this.#secrets);
      const parts: Uint8Array[] = [];
      const cap = this.#limits.max_response_bytes;
      let bytes = 0;
      let capped = false;
      let broken = false;
      if (!res.destroyed) res.writeHead(status, { 'content-type': contentType });
      const relay = async (chunk: Uint8Array): Promise<void> => {
        let out = chunk;
        if (out.byteLength > cap - bytes) {
          out = out.subarray(0, cap - bytes);
          capped = true;
        }
        if (out.byteLength === 0) return;
        parts.push(out);
        bytes += out.byteLength;
        tap.push(out);
        await this.#write(res, out);
      };
      try {
        for await (const chunk of head.body) {
          await relay(mask.push(chunk));
          if (capped) break;
        }
      } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
        broken = true;
      }
      if (!capped) await relay(mask.end());
      if (capped) ac.abort();
      if (!res.destroyed && !res.writableEnded) res.end();
      const body = Buffer.concat(parts);
      const gone = torn.cause === 'client' || torn.cause === 'shutdown';
      const result: UpstreamResult = {
        status,
        content_type: contentType,
        body,
        service_tier: headerServiceTier(head.headers),
        ...(gone ? { client_aborted: true } : capped || broken || torn.cause === 'timeout' ? { transport_error: true } : {}),
      };
      const m = meter.settle(d.ticket, result, tap.end());
      await writer.settle(seq, { outcome: m.outcome, status, content_type: contentType, body, usage: m.usage, micro_usd: m.micro_usd });
    } catch (err) {
      // An infrastructure fault (the caller records it): the client is answered all the same.
      ac.abort();
      if (!res.headersSent) plainJson(res, 500, { error: { type: 'api_error', message: 'the gateway failed: an infrastructure fault' } }, true);
      else if (!res.writableEnded) res.end();
      throw err;
    } finally {
      clearTimeout(timer);
      this.#inflight.delete(shutdown);
      res.off('close', onClose);
    }
  }

  /**
   * An admitted request the forwarder will not send (see the header: a router model on masq, a request the router lane
   * cannot say): 502 upstream_error in the route's vendor shape (Chat's on openai.chat), masked as any answer is,
   * settled as a transport error with nothing sent and nothing received, so it costs nothing and counts toward the void.
   */
  async #unsent(res: ServerResponse, route: PolicedRoute, seq: number, d: PolicyAllow & { ticket: Ticket }, message: string): Promise<void> {
    const m = this.#meter!.settle(d.ticket, { status: null, content_type: null, body: EMPTY, transport_error: true });
    const body = this.#mask(vendorErrorBody(route, 'upstream_error', message));
    answer(res, 502, { 'content-type': JSON_TYPE }, body);
    await this.#writer!.settle(seq, { outcome: m.outcome, status: 502, content_type: JSON_TYPE, body, usage: m.usage, micro_usd: m.micro_usd });
  }

  /**
   * Lane `house`'s answer to a Chat Completions request it dialled on Messages (see the header): the upstream's answer
   * held whole (to max_response_bytes), metered as the Messages answer it is, then answered and recorded as the Chat
   * Completions answer the client asked for (grader/dialect.ts messagesToChat), masked as a relayed one is. An event
   * stream is first assembled into the one Messages document it says (grader/dialect.ts messagesStreamToMessage): an
   * in-band error event is that error document, at its type's status; a stream that never finished is a 502
   * upstream_error. On the router (`router`) a 2xx answer is taken only from its primary: one whose `sbr` marker is
   * missing or names another tier is a 502 upstream_error naming the model_version, settled as a transport error, and an
   * answer at any status outside 200 to 299, a 4xx too, is answered as it came and settled an upstream_error. An
   * answer cut short (a reset, the cap, the stream total) is no answer to translate: 502 (504 at the stream total) in
   * Chat's shape, an upstream_error; a client gone first is recorded as CLIENT_CLOSED_STATUS. A 2xx that is no
   * Messages answer is 502, an upstream_error.
   */
  async #answerChat(res: ServerResponse, seq: number, d: PolicyAllow & { ticket: Ticket }, head: UpstreamResponse, ac: AbortController, torn: { cause: 'client' | 'timeout' | 'shutdown' | null }, router: boolean): Promise<void> {
    const contentType = head.headers['content-type'] || 'application/octet-stream';
    const tap = new UsageTap('anthropic.messages', contentType);
    const parts: Uint8Array[] = [];
    const cap = this.#limits.max_response_bytes;
    let bytes = 0;
    let capped = false;
    let broken = false;
    try {
      for await (const chunk of head.body) {
        let c = chunk;
        if (c.byteLength > cap - bytes) {
          c = c.subarray(0, cap - bytes);
          capped = true;
        }
        if (c.byteLength > 0) {
          parts.push(c);
          bytes += c.byteLength;
          tap.push(c);
        }
        if (capped) break;
      }
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      broken = true;
    }
    if (capped) ac.abort();
    const raw = Buffer.concat(parts);
    const gone = torn.cause === 'client' || torn.cause === 'shutdown';
    const cut = capped || broken || torn.cause === 'timeout';
    let status: number;
    let body: Uint8Array;
    let unreadable = false;
    if (gone) {
      status = CLIENT_CLOSED_STATUS;
      body = vendorErrorBody('openai.chat', 'client_closed_request', 'the client closed the request before the model provider answered');
    } else if (cut) {
      const [s, type, message] = torn.cause === 'timeout'
        ? [504, 'upstream_timeout', `the model provider's answer was not whole within ${this.#limits.stream_total_ms} ms`]
        : capped
          ? [502, 'upstream_error', `the model provider's answer ran past this gateway's cap of ${cap} bytes`]
          : [502, 'upstream_error', "the model provider's connection dropped before its answer was whole"];
      status = s;
      body = vendorErrorBody('openai.chat', type, message);
    } else {
      const chat = chatAnswerOf(raw, head.status, contentType, router);
      status = chat.status;
      body = this.#mask(chat.body);
      // No answer the trial may take: settled as the transport error it is, whatever the head said.
      unreadable = chat.kind === 'fault' || chat.kind === 'not_primary' || (chat.kind === 'unreadable' && head.status >= 200 && head.status < 300);
    }
    const result: UpstreamResult = {
      status: head.status,
      content_type: contentType,
      body: raw,
      service_tier: headerServiceTier(head.headers),
      ...(gone ? { client_aborted: true } : cut || unreadable ? { transport_error: true } : {}),
      // The router's request is this forwarder's own mapping: any refusal of it is the platform's (meter.ts classifyOutcome).
      ...(router ? { forwarder_request: true } : {}),
    };
    const m = this.#meter!.settle(d.ticket, result, tap.end());
    answer(res, status, { 'content-type': JSON_TYPE }, body);
    await this.#writer!.settle(seq, { outcome: m.outcome, status, content_type: JSON_TYPE, body, usage: m.usage, micro_usd: m.micro_usd });
  }

  /**
   * End the trial (see the header): resolves with the result once every exchange is settled and the
   * cassette is written (live) or the verdict reached (replay). Calling it again returns the same.
   */
  close(): Promise<GatewayResult> {
    this.#closed ??= this.#close();
    return this.#closed;
  }

  async #close(): Promise<GatewayResult> {
    this.#closing = true;
    this.server.close(() => {});
    for (const abort of [...this.#inflight]) abort();
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
    this.server.closeAllConnections();
    if (this.#replay !== null) {
      const verdict = this.#replay.stop();
      const ok = this.#faults.length === 0 && verdict.ok;
      let requests: WrittenRequests | null = null;
      let requestsFault: string | null = null;
      if (this.#replayLog !== null) {
        const { log, blobs } = this.#replayLog;
        if (!ok) log.writer.abandon('the replay is not the recording');
        try {
          requests = await log.writer.finish(blobs, this.#replay.cassette.entries.length);
        } catch (err) {
          requestsFault = redact(err instanceof Error ? err.message : String(err), this.#faultSecrets);
        }
      }
      return { mode: 'replay', ok, faults: [...this.#faults], cassette: null, meter: null, replay: verdict, requests, requests_fault: requestsFault };
    }
    this.#upstream!.close();
    let cassette: WrittenCassette | null = null;
    try {
      cassette = await this.#writer!.finish(this.#cassettePath !== undefined ? { path: this.#cassettePath } : {});
    } catch (err) {
      this.#fault(err);
      this.#writer!.dropRequests('the cassette was not written');
    }
    const meter = this.#meter!.snapshot();
    if (cassette !== null && !isDeepStrictEqual(cassette.cassette.totals, meter.totals)) {
      this.#fault(new Error(`the meter's totals ${JSON.stringify(meter.totals)} are not the cassette's ${JSON.stringify(cassette.cassette.totals)}`));
    }
    const requestsFault = cassette === null ? null : cassette.requests_fault === null ? null : redact(cassette.requests_fault, this.#faultSecrets);
    return { mode: 'live', ok: this.#faults.length === 0, faults: [...this.#faults], cassette, meter, replay: null, requests: cassette?.requests ?? null, requests_fault: requestsFault };
  }
}

/** A forwarder for one trial (see the header). */
export function createGateway(opts: GatewayOptions): Gateway {
  return new Gateway(opts);
}
