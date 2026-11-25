// One trial's model traffic (contracts/agent.ts Cassette, agent-fun/cassette/v1): the request key the
// replay matches on, the writer the LIVE pass records with and the matcher the REPLAY pass serves from.
//
//   request key   requestKey / keyRequest: the sha256 of the canonical JSON (sim/canonical.ts) of
//                 {route, headers, body}. headers holds only anthropic-version, anthropic-beta and
//                 openai-beta (KEYED_HEADERS), so auth headers, x-stainless-* (an SDK's retry counter)
//                 and every other client header never move it. Each one's value is its list members
//                 (every field line, split on commas, optional whitespace trimmed, empty members
//                 dropped), de-duplicated, sorted and joined with ','; a header that is absent is
//                 absent from the object. body is the parsed JSON body; `models` (a GET) has none and
//                 keys body null. A body that is not strict UTF-8 JSON the canonical form can hash (a
//                 BOM, a lone surrogate, nesting past the stack) gets no key: the forwarder refuses it
//                 and records the refusal with request_key null. Given a mask (RequestKeyInput.mask:
//                 the forwarder's request_mask, an entrant's env-lane entry secrets), every string of
//                 the parsed body, its object keys included, and every keyed header's value is masked
//                 before the key is taken (maskJsonStrings), so no key is a hash over a secret an entry
//                 sent (one a guess could be tested against) and, the same mask given to the live
//                 pass's forwarder and its replay's, the replay keys each request as live did. Masking
//                 the parsed strings, never the bytes, keeps the body JSON whatever a form spans.
//   writer        CassetteWriter: begin() takes a seq at arrival (0, 1, 2, ... with no gap), so entries
//                 are in arrival order whatever order their responses finish in; settle() stores the
//                 response body in the blob store under its sha256 and fills the entry; finish(), once
//                 the trial ends, stores the canonical cassette JSON as a blob (cassette_sha256 names
//                 it) and, given a path, writes it there too. Asked to (`requests`), it also keeps the trial's
//                 request log (requests.ts): each begin() streams the bytes its request_key hashes (keyedJson,
//                 masked) into one zstd blob, stored after the cassette; its failure is the log's alone. The
//                 cassette's own bytes are the same with it or without it.
//   replay        CassetteReplay: a FIFO of recorded entries per (route, request_key), unkeyed refusals
//                 on a FIFO of their route, so parallel and duplicate calls replay in recorded order.
//                 take() pops at arrival; a request with nothing left is a cassette_miss, and stop()
//                 with entries left over is cassette_unconsumed. Either makes the trial
//                 nondeterministic.
//   model calls   cassetteModelCalls: what the LLM agent floor (grader/agent-score.ts) counts of a
//                 trial, read off its stored cassette alone, so the fan-in, the kit's local grade, a
//                 regrade and a verifier count the same bytes the same way. A model call is an entry
//                 the forwarder sent upstream on a completion route (anthropic.messages, openai.chat,
//                 openai.responses) that the model answered (outcome upstream) with usage counting at
//                 least one token (isModelCall). Not one: a `models` listing (the forwarder answers it
//                 itself from the allowlist, outcome upstream all the same, which is why totals.upstream
//                 is no count of model calls), a refusal, an upstream error, and an answer that
//                 reported no usage or no tokens.
//
// Blobs go through CassetteBlobs, which server/blobstore.ts BlobStore fits (as grader/program.ts
// OutputBlobs does). A missing or corrupt blob, a cassette that is not canonical or not a Cassette, and
// a writer used out of order throw CassetteError: an infrastructure fault, never a nondeterminism one.

import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import type { z } from 'zod';
import {
  Cassette,
  CASSETTE_FORMAT,
  CassetteEntry,
  CassetteRoute,
  type AgentTrialStatusT,
  type CassetteEntryT,
  type CassetteT,
  type CassetteUsageT,
} from '../../contracts/agent.ts';
import { IsoDateTime, Sha256Hex } from '../../contracts/primitives.ts';
import { canonicalBytes, canonicalJson, CanonicalJsonError, compareCodeUnits, sha256Hex } from '../../sim/canonical.ts';
import { RequestLogWriter, type WrittenRequests } from './requests.ts';

export type CassetteRouteT = z.infer<typeof CassetteRoute>;
type CassetteOutcomeT = CassetteEntryT['outcome'];

export class CassetteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CassetteError';
  }
}

/** Where response bodies and cassettes are kept: server/blobstore.ts BlobStore fits. */
export interface CassetteBlobs {
  put(data: Uint8Array): Promise<{ sha256: string }>;
  get(sha256: string, opts?: { verify?: boolean }): Promise<Uint8Array | null>;
}

function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}

// ---------------------------------------------------------------- request key

/** The only request headers the key covers, lowercase: what selects the API's behaviour, never auth or SDK bookkeeping. */
export const KEYED_HEADERS: readonly string[] = Object.freeze(['anthropic-beta', 'anthropic-version', 'openai-beta']);
const KEYED = new Set(KEYED_HEADERS);

export type HeaderValue = string | readonly string[] | undefined;
/**
 * Request headers in any of the shapes a server holds them: a fetch Headers, node:http's
 * IncomingHttpHeaders (or headersDistinct), any record keyed by name in any case, or [name, value]
 * pairs. Never node's flat rawHeaders array: pair it up first.
 */
export type HeadersLike = Headers | Readonly<Record<string, HeaderValue>> | Iterable<readonly [string, string]>;

/** RFC 9110 optional whitespace: what a list member is trimmed of. */
const OWS_EDGES = /^[ \t]+|[ \t]+$/g;

/** The keyed headers, each a list value normalised so header order, field-line splits and spacing never move the key. */
export function keyedHeaders(headers: HeadersLike): Record<string, string> {
  const members = new Map<string, Set<string>>();
  const add = (name: string, value: HeaderValue): void => {
    if (typeof name !== 'string') throw new TypeError(`a header name is a string, not ${typeof name}`);
    const n = name.toLowerCase();
    if (!KEYED.has(n) || value === undefined) return;
    const set = members.get(n) ?? new Set<string>();
    members.set(n, set);
    for (const line of typeof value === 'string' ? [value] : value) {
      if (typeof line !== 'string') throw new TypeError(`header ${n} has a ${typeof line} value: header values are strings`);
      for (const m of line.split(',')) {
        const t = m.replace(OWS_EDGES, '');
        if (t !== '') set.add(t);
      }
    }
  };
  if (Symbol.iterator in headers) {
    for (const pair of headers as Iterable<readonly [string, string]>) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('headers given as an iterable are [name, value] pairs (pair up node rawHeaders first)');
      add(pair[0], pair[1]);
    }
  } else {
    for (const [n, v] of Object.entries(headers as Readonly<Record<string, HeaderValue>>)) add(n, v);
  }
  const out: Record<string, string> = {};
  for (const n of [...members.keys()].sort(compareCodeUnits)) out[n] = [...members.get(n)!].sort(compareCodeUnits).join(',');
  return out;
}

/** A string's masked spelling (the forwarder's request mask: grader/gateway/secret-mask.ts maskText over its forms). */
export type StringMask = (text: string) => string;

/** What a request key is the sha256 of, before canonicalisation. */
export interface RequestKeyInput {
  route: CassetteRouteT;
  headers: HeadersLike;
  /** The parsed JSON body; null for `models`. */
  body: unknown;
  /** Applied to every string of the body and every keyed header's value before the key is taken (the header's `request key`). */
  mask?: StringMask;
}

/**
 * `value` (a parsed JSON value) with `mask` applied to every string in it, object keys included, at any depth: what the
 * request key hashes of a body under a mask (the header's `request key`). Two keys an object's mask makes one keep the
 * later's value, as JSON.parse keeps a later duplicate. Nesting past the stack throws RangeError, as the key itself does.
 */
export function maskJsonStrings(value: unknown, mask: StringMask): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((v) => maskJsonStrings(v, mask));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // defineProperty: a key the mask leaves as `__proto__` stays an own key, as JSON.parse makes it.
      Object.defineProperty(out, mask(k), { value: maskJsonStrings(v, mask), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/**
 * The request key of a parsed request: sha256 of the canonical JSON of {route, headers, body}, each keyed header's value
 * and every string of the body masked first when a mask is given. Throws CanonicalJsonError (or RangeError, nesting past
 * the stack) on a body the canonical form refuses; keyRequest turns that into an unkeyed request.
 */
export function requestKey(input: RequestKeyInput): string {
  return sha256Hex(keyedJson(input));
}

/**
 * What the request key is the sha256 of (its UTF-8): the canonical JSON of {route, headers, body}, masked as requestKey
 * masks it. The request log (requests.ts) keeps these exact bytes, so each of its lines hashes to its entry's
 * request_key. Throws as requestKey does.
 */
export function keyedJson(input: RequestKeyInput): string {
  const route = CassetteRoute.parse(input.route);
  const mask = input.mask;
  const headers = keyedHeaders(input.headers);
  if (mask === undefined) return canonicalJson({ route, headers, body: input.body });
  const masked: Record<string, string> = {};
  for (const [n, v] of Object.entries(headers)) masked[n] = mask(v);
  return canonicalJson({ route, headers: masked, body: maskJsonStrings(input.body, mask) });
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A JSON request body parsed strictly: UTF-8 with no byte-order mark, then JSON.parse. */
export function parseJsonBody(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false; error: string } {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { ok: false, error: 'the request body is not UTF-8' };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const why = text.charCodeAt(0) === 0xfeff ? 'it opens with a byte-order mark' : (err as Error).message;
    return { ok: false, error: `the request body is not JSON: ${why}` };
  }
}

/** A request the forwarder can forward or replay: its key and what the cassette entry records of it. */
export interface KeyedRequest {
  route: CassetteRouteT;
  request_key: string;
  /** The parsed JSON body (null on `models`), for the policy and the upstream adapter. */
  body: unknown;
  /** The body's model, when it names one as a non-empty string. */
  model: string | null;
  /** True when the body asks for a stream (`stream: true`). */
  stream: boolean;
  /** The canonical JSON request_key is the sha256 of (keyedJson), masked: what the request log keeps. */
  keyed_json: string;
}

/** A request whose body is not JSON: the forwarder refuses it, and records the refusal with no key. */
export interface UnkeyedRequest {
  route: CassetteRouteT;
  request_key: null;
  model: null;
  stream: false;
  /** Why it has no key, for the refusal the forwarder answers. */
  error: string;
}

function bodyObject(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/**
 * Key one request off the wire: its route, its headers and its body bytes, under `mask` when given (the header's
 * `request key`). `models` ignores the body (it is a GET: body null in the key). Any other route needs a JSON body the
 * canonical form can hash; one that is not gets request_key null and the reason. The body, model and stream answered are
 * the request's own, unmasked: what the policy and the upstream read.
 */
export function keyRequest(req: { route: CassetteRouteT; headers: HeadersLike; body: Uint8Array; mask?: StringMask }): KeyedRequest | UnkeyedRequest {
  const route = CassetteRoute.parse(req.route);
  const masked = req.mask === undefined ? {} : { mask: req.mask };
  if (route === 'models') {
    const json = keyedJson({ route, headers: req.headers, body: null, ...masked });
    return { route, request_key: sha256Hex(json), body: null, model: null, stream: false, keyed_json: json };
  }
  const parsed = parseJsonBody(req.body);
  if (!parsed.ok) return { route, request_key: null, model: null, stream: false, error: parsed.error };
  let json: string;
  try {
    json = keyedJson({ route, headers: req.headers, body: parsed.value, ...masked });
  } catch (err) {
    if (err instanceof CanonicalJsonError) return { route, request_key: null, model: null, stream: false, error: `the request body is not JSON the request key can hash: ${err.message}` };
    if (err instanceof RangeError) return { route, request_key: null, model: null, stream: false, error: 'the request body is not JSON the request key can hash: it nests too deep' };
    throw err;
  }
  const obj = bodyObject(parsed.value);
  const model = obj !== null && typeof obj.model === 'string' && obj.model !== '' ? obj.model : null;
  return { route, request_key: sha256Hex(json), body: parsed.value, model, stream: obj !== null && obj.stream === true, keyed_json: json };
}

// ---------------------------------------------------------------- totals and bytes

const ZERO_USAGE: CassetteUsageT = { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, reasoning: 0 };
const USAGE_KEYS = Object.keys(ZERO_USAGE) as (keyof CassetteUsageT)[];

/** What entries add up to (contracts/agent.ts CassetteTotals). */
export function cassetteTotals(entries: readonly CassetteEntryT[]): CassetteT['totals'] {
  const usage = { ...ZERO_USAGE };
  let upstream = 0;
  let refused = 0;
  let upstreamErrors = 0;
  let micro = 0n;
  for (const e of entries) {
    if (e.outcome === 'upstream') upstream++;
    else if (e.outcome === 'refused') refused++;
    else upstreamErrors++;
    micro += BigInt(e.micro_usd);
    if (e.usage !== null) for (const k of USAGE_KEYS) usage[k] += e.usage[k];
  }
  return { requests: entries.length, upstream, refused, upstream_errors: upstreamErrors, micro_usd: micro.toString(), usage };
}

/** The tokens a response's usage counts: every class but reasoning, which is a subset of output. */
export function usageTokens(usage: CassetteUsageT): number {
  return usage.input + usage.output + usage.cache_read + usage.cache_write_5m + usage.cache_write_1h;
}

/**
 * Whether an entry is a model call as the LLM agent floor counts one (the header's `model calls`): on
 * a completion route, never `models`; answered by the model, outcome upstream; its usage counting at
 * least one token.
 */
export function isModelCall(entry: CassetteEntryT): boolean {
  return entry.route !== 'models' && entry.outcome === 'upstream' && entry.usage !== null && usageTokens(entry.usage) > 0;
}

/** A trial's model calls (isModelCall), counted off its cassette's entries: the LLM agent floor's count (grader/agent-score.ts). */
export function cassetteModelCalls(cassette: Pick<CassetteT, 'entries'>): number {
  let n = 0;
  for (const e of cassette.entries) if (isModelCall(e)) n++;
  return n;
}

/** A cassette's canonical JSON, UTF-8: the bytes it is stored as and cassette_sha256 hashes. */
export function cassetteBytes(cassette: CassetteT): Uint8Array {
  return canonicalBytes(cassette);
}

/** A stored cassette's bytes back as a Cassette: strict UTF-8, exactly canonical JSON, and a valid Cassette. */
export function parseCassette(bytes: Uint8Array): CassetteT {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new CassetteError('the cassette is not UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CassetteError('the cassette is not JSON');
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch (err) {
    throw new CassetteError(`the cassette is not canonical JSON: ${(err as Error).message}`);
  }
  if (canonical !== text) throw new CassetteError('the cassette is not canonical JSON');
  const checked = Cassette.safeParse(parsed);
  if (!checked.success) throw new CassetteError(`the cassette is not an ${CASSETTE_FORMAT} cassette: ${issuesText(checked.error)}`);
  return checked.data;
}

async function getBlob(blobs: Pick<CassetteBlobs, 'get'>, sha256: string, what: string): Promise<Uint8Array> {
  let bytes: Uint8Array | null;
  try {
    bytes = await blobs.get(sha256, { verify: true });
  } catch (err) {
    throw new CassetteError(`${what} ${sha256} is unreadable: ${(err as Error).message}`);
  }
  if (bytes === null) throw new CassetteError(`${what} ${sha256} is missing from the blob store`);
  const actual = sha256Hex(bytes);
  if (actual !== sha256) throw new CassetteError(`${what} ${sha256} is corrupt: its bytes hash to ${actual}`);
  return bytes;
}

/** The cassette stored under sha256: it must hash to its name, be canonical JSON and be a Cassette. */
export async function readCassette(blobs: Pick<CassetteBlobs, 'get'>, sha256: string): Promise<CassetteT> {
  if (!Sha256Hex.safeParse(sha256).success) throw new CassetteError(`not a cassette name: ${JSON.stringify(String(sha256).slice(0, 80))}`);
  return parseCassette(await getBlob(blobs, sha256, 'cassette'));
}

// ---------------------------------------------------------------- writer

/** What the forwarder knows of a request when it takes it (a KeyedRequest or UnkeyedRequest fits, with `at`). */
export interface CassetteRequest {
  /** When the forwarder took the request: the time it is priced at. */
  at: Date | string;
  route: CassetteRouteT;
  request_key: string | null;
  model: string | null;
  stream: boolean;
  /** The canonical JSON request_key is the sha256 of (KeyedRequest.keyed_json): the request log's line, when the writer keeps one. */
  keyed_json?: string | null;
  /** True when keyed_json still holds a form of a secret answers are masked of: the log keeps the line without its bytes (requests.ts). */
  withheld?: boolean;
}

/** How the request ended. */
export interface CassetteResponse {
  outcome: CassetteOutcomeT;
  status: number;
  content_type: string;
  /** The response body as the client received it (streamed bytes included): stored as a blob under its sha256. */
  body: Uint8Array;
  usage: CassetteUsageT | null;
  micro_usd: bigint | string;
}

/** A finished cassette: the document, its canonical bytes and the sha256 they are stored under. */
export interface WrittenCassette {
  cassette: CassetteT;
  bytes: Uint8Array;
  sha256: string;
  /** The trial's request log (requests.ts), stored as a blob; null when the writer keeps none or it failed. */
  requests: WrittenRequests | null;
  /** Why a request log the writer kept was not stored: a fault of the log alone, never the cassette's. */
  requests_fault: string | null;
}

type Slot =
  | { state: 'open'; request: Omit<CassetteRequest, 'at'> & { at: string } }
  | { state: 'storing'; request: Omit<CassetteRequest, 'at'> & { at: string }; done: Promise<unknown> }
  | { state: 'settled'; entry: CassetteEntryT };

/**
 * Records one LIVE trial. begin() at arrival (synchronously, before any await, so seq is arrival
 * order), settle() once the response is done, finish() once the trial ends. Every begun request must
 * be settled before finish(): one the trial cut off is settled with what it received.
 */
export class CassetteWriter {
  readonly trial: CassetteT['trial'];
  readonly pricingRev: string;
  readonly #blobs: Pick<CassetteBlobs, 'put'>;
  readonly #slots: Slot[] = [];
  /** The request log (requests.ts), when kept: a line per begin(), stored by finish() after the cassette. */
  readonly #log: RequestLogWriter | null;
  #closing = false;
  #finished = false;

  /**
   * `requests` keeps the trial's request log (requests.ts): each begin() appends its request's line (CassetteRequest
   * keyed_json), and finish() stores it once the cassette is stored. Its failure is the log's alone: finish() answers
   * requests null with requests_fault, the cassette as ever.
   */
  constructor(opts: { trial: CassetteT['trial']; pricing_rev: string; blobs: Pick<CassetteBlobs, 'put'>; requests?: boolean | { maxBytes: number } }) {
    const { index, instance_sha256 } = opts.trial;
    if (!Number.isSafeInteger(index) || index < 0) throw new CassetteError(`trial index ${index} is not a non-negative integer`);
    if (!Sha256Hex.safeParse(instance_sha256).success) throw new CassetteError(`trial instance ${JSON.stringify(instance_sha256)} is not a sha256`);
    if (typeof opts.pricing_rev !== 'string' || opts.pricing_rev === '') throw new CassetteError('pricing_rev is empty');
    this.trial = { index, instance_sha256 };
    this.pricingRev = opts.pricing_rev;
    this.#blobs = opts.blobs;
    const r = opts.requests;
    this.#log = r === undefined || r === false ? null : new RequestLogWriter(r === true ? {} : { maxBytes: r.maxBytes });
  }

  /** Requests taken so far, settled or not: what the request cap counts. */
  get requests(): number {
    return this.#slots.length;
  }

  /** The settled entries, in seq order (a request still in flight is not among them). */
  entries(): CassetteEntryT[] {
    return this.#slots.flatMap((s) => (s.state === 'settled' ? [s.entry] : []));
  }

  /** Take a request: its seq, the next in arrival order. */
  begin(req: CassetteRequest): number {
    if (this.#closing || this.#finished) throw new CassetteError('the cassette is closed: the trial has ended');
    const at = req.at instanceof Date ? req.at.toISOString() : req.at;
    if (!IsoDateTime.safeParse(at).success) throw new CassetteError(`at ${JSON.stringify(at)} is not an RFC 3339 instant with an offset`);
    const route = CassetteRoute.safeParse(req.route);
    if (!route.success) throw new CassetteError(`route ${JSON.stringify(req.route)} is not a forwarder route`);
    if (req.request_key !== null && !Sha256Hex.safeParse(req.request_key).success) throw new CassetteError(`request_key ${JSON.stringify(req.request_key)} is not a sha256`);
    if (req.model !== null && (typeof req.model !== 'string' || req.model === '')) throw new CassetteError(`model ${JSON.stringify(req.model)} is neither null nor a model id`);
    if (typeof req.stream !== 'boolean') throw new CassetteError(`stream ${JSON.stringify(req.stream)} is not a boolean`);
    const seq = this.#slots.length;
    this.#slots.push({ state: 'open', request: { at, route: route.data, request_key: req.request_key, model: req.model, stream: req.stream } });
    this.#log?.append({ seq, request_key: req.request_key, keyed: req.keyed_json ?? null, withheld: req.withheld === true });
    return seq;
  }

  /** Fill a begun entry with its response, its body stored as a blob first. */
  async settle(seq: number, res: CassetteResponse): Promise<CassetteEntryT> {
    if (this.#finished) throw new CassetteError('the cassette is finished');
    const slot = this.#slots[seq];
    if (slot === undefined) throw new CassetteError(`no request has seq ${seq}`);
    if (slot.state !== 'open') throw new CassetteError(`entry ${seq} is already settled`);
    const body_sha256 = sha256Hex(res.body);
    const micro = typeof res.micro_usd === 'bigint' ? res.micro_usd.toString() : res.micro_usd;
    const checked = CassetteEntry.safeParse({
      seq,
      ...slot.request,
      outcome: res.outcome,
      status: res.status,
      content_type: res.content_type,
      body_sha256,
      usage: res.usage,
      micro_usd: micro,
    });
    if (!checked.success) throw new CassetteError(`entry ${seq} is not a cassette entry: ${issuesText(checked.error)}`);
    const entry = checked.data;
    const done = this.#blobs.put(res.body);
    this.#slots[seq] = { state: 'storing', request: slot.request, done };
    try {
      const stored = await done;
      if (stored.sha256 !== body_sha256) throw new CassetteError(`the blob store named entry ${seq}'s body ${stored.sha256}, not its sha256 ${body_sha256}`);
    } catch (err) {
      this.#slots[seq] = slot;
      throw err;
    }
    this.#slots[seq] = { state: 'settled', entry };
    return entry;
  }

  /** Stop keeping the request log (the cassette is not being written after all): finish() then answers requests null. */
  dropRequests(why: string): void {
    this.#log?.abandon(why);
  }

  /** begin() and settle() at once: a request answered before anything else could arrive (a refusal, `models`). */
  async record(req: CassetteRequest, res: CassetteResponse): Promise<CassetteEntryT> {
    return this.settle(this.begin(req), res);
  }

  /**
   * End the trial's recording: wait for bodies still being stored, then store the canonical cassette
   * JSON as a blob (and write it to `path`, replacing it whole, when given). Throws, leaving the
   * cassette open to settle and finish again, when a begun request is unsettled.
   */
  async finish(opts: { path?: string } = {}): Promise<WrittenCassette> {
    if (this.#finished) throw new CassetteError('the cassette is finished');
    this.#closing = true;
    try {
      for (;;) {
        const storing = this.#slots.flatMap((s) => (s.state === 'storing' ? [s.done] : []));
        if (storing.length === 0) break;
        await Promise.allSettled(storing);
      }
      const unsettled = this.#slots.flatMap((s, i) => (s.state === 'settled' ? [] : [i]));
      if (unsettled.length > 0) throw new CassetteError(`entries ${unsettled.join(', ')} were never settled: every request taken is settled before the cassette is written`);
      const entries = this.entries();
      const checked = Cassette.safeParse({ format: CASSETTE_FORMAT, trial: this.trial, pricing_rev: this.pricingRev, entries, totals: cassetteTotals(entries) });
      if (!checked.success) throw new CassetteError(`the cassette is not valid: ${issuesText(checked.error)}`);
      const bytes = cassetteBytes(checked.data);
      const sha256 = sha256Hex(bytes);
      const stored = await this.#blobs.put(bytes);
      if (stored.sha256 !== sha256) throw new CassetteError(`the blob store named the cassette ${stored.sha256}, not its sha256 ${sha256}`);
      if (opts.path !== undefined) await writeWhole(opts.path, bytes);
      this.#finished = true;
      let requests: WrittenRequests | null = null;
      let requestsFault: string | null = null;
      if (this.#log !== null) {
        try {
          requests = await this.#log.finish(this.#blobs, entries.length);
        } catch (err) {
          requestsFault = err instanceof Error ? err.message : String(err);
        }
      }
      return { cassette: checked.data, bytes, sha256, requests, requests_fault: requestsFault };
    } finally {
      this.#closing = false;
    }
  }
}

/** Write a file by rename, so a reader never sees half of it. */
async function writeWhole(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}-${randomBytes(6).toString('hex')}.part`;
  try {
    await writeFile(tmp, bytes, { flag: 'wx', mode: 0o644 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------- replay

/** Why a replay is not the recording. Each makes the trial nondeterministic. */
export const CASSETTE_REPLAY_FAULTS = ['cassette_miss', 'cassette_unconsumed'] as const;
export type CassetteReplayFault = (typeof CASSETTE_REPLAY_FAULTS)[number];

/** The trial status a replay fault gives. */
export const REPLAY_FAULT_STATUS = 'nondeterministic' as const satisfies AgentTrialStatusT;

/** A replayed request the cassette had no entry left for. */
export interface CassetteMiss {
  hit: false;
  fault: 'cassette_miss';
  status: typeof REPLAY_FAULT_STATUS;
  route: CassetteRouteT;
  request_key: string | null;
}

export interface CassetteHit {
  hit: true;
  entry: CassetteEntryT;
}

/** How the replay ended: every entry consumed with no miss, or the fault that makes the trial nondeterministic. */
export type ReplayVerdict =
  | { ok: true; consumed: number }
  | {
      ok: false;
      /** cassette_miss when any request missed (the cause, even with entries left over), else cassette_unconsumed. */
      fault: CassetteReplayFault;
      status: typeof REPLAY_FAULT_STATUS;
      /** The requests that missed, in arrival order. */
      misses: { route: CassetteRouteT; request_key: string | null }[];
      /** The seqs of the entries no request consumed, in seq order. */
      unconsumed: number[];
    };

function queueName(route: string, key: string | null): string {
  return `${route} ${key ?? '-'}`;
}

/**
 * Serves one cassette back. Recorded entries queue per (route, request_key) in seq order; an unkeyed
 * refusal queues on its route's unkeyed queue. take() pops the head synchronously, so the order
 * requests arrive in decides which recorded response each gets, however long their bodies take to read.
 */
export class CassetteReplay {
  readonly cassette: CassetteT;
  readonly #blobs: Pick<CassetteBlobs, 'get'>;
  readonly #queues = new Map<string, { entries: CassetteEntryT[]; next: number }>();
  readonly #consumed: boolean[];
  readonly #misses: { route: CassetteRouteT; request_key: string | null }[] = [];
  #taken = 0;
  #stopped = false;

  constructor(cassette: CassetteT, blobs: Pick<CassetteBlobs, 'get'>) {
    const checked = Cassette.safeParse(cassette);
    if (!checked.success) throw new CassetteError(`the cassette is not an ${CASSETTE_FORMAT} cassette: ${issuesText(checked.error)}`);
    this.cassette = checked.data;
    this.#blobs = blobs;
    this.#consumed = this.cassette.entries.map(() => false);
    for (const e of this.cassette.entries) {
      const name = queueName(e.route, e.request_key);
      const q = this.#queues.get(name);
      if (q === undefined) this.#queues.set(name, { entries: [e], next: 0 });
      else q.entries.push(e);
    }
  }

  /** Entries no request has consumed yet. */
  get remaining(): number {
    return this.cassette.entries.length - this.#taken;
  }

  /** The recorded entry a request gets: the oldest one left under its route and key, or a miss. */
  take(req: { route: CassetteRouteT; request_key: string | null }): CassetteHit | CassetteMiss {
    if (this.#stopped) throw new CassetteError('the replay has stopped');
    const q = this.#queues.get(queueName(req.route, req.request_key));
    if (q === undefined || q.next >= q.entries.length) {
      const miss = { route: req.route, request_key: req.request_key };
      this.#misses.push(miss);
      return { hit: false, fault: 'cassette_miss', status: REPLAY_FAULT_STATUS, ...miss };
    }
    const entry = q.entries[q.next++]!;
    this.#consumed[entry.seq] = true;
    this.#taken++;
    return { hit: true, entry };
  }

  /** A recorded entry's response body, read from the blob store and checked against its sha256. */
  async body(entry: CassetteEntryT): Promise<Uint8Array> {
    const own = this.cassette.entries[entry.seq];
    if (own === undefined || own.body_sha256 !== entry.body_sha256) throw new CassetteError(`entry ${entry.seq} is not this cassette's`);
    return getBlob(this.#blobs, entry.body_sha256, `entry ${entry.seq}'s response body`);
  }

  /** take() and, on a hit, the body: what the forwarder answers a replayed request with. */
  async serve(req: { route: CassetteRouteT; request_key: string | null }): Promise<(CassetteHit & { body: Uint8Array }) | CassetteMiss> {
    const t = this.take(req);
    return t.hit ? { ...t, body: await this.body(t.entry) } : t;
  }

  /** End the replay: no further take(), and the verdict. */
  stop(): ReplayVerdict {
    this.#stopped = true;
    const unconsumed = this.#consumed.flatMap((c, seq) => (c ? [] : [seq]));
    if (this.#misses.length === 0 && unconsumed.length === 0) return { ok: true, consumed: this.#taken };
    return {
      ok: false,
      fault: this.#misses.length > 0 ? 'cassette_miss' : 'cassette_unconsumed',
      status: REPLAY_FAULT_STATUS,
      misses: this.#misses.map((m) => ({ ...m })),
      unconsumed,
    };
  }
}
