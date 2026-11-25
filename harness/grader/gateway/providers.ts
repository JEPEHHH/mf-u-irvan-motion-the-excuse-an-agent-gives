// The model providers an entrant's own key reaches, and the one module of the platform's own code that
// names their API hosts. Every house-paid model call (a trial on house keys, an AI review, a house
// baseline, a pilot, a house target or judge) goes through masq (upstream.ts masqUpstream) and never
// through here; an entrant who brings their own key pays their own provider, and this is where that
// provider is. tests/unit/masq-only.test.ts excludes this file by name from its host guard and pins who
// may import it: the forwarder's entrant-key lane (upstream.ts), the worker's pre-flight (worker.ts), the
// advisory pre-flight of a pushed provider key (server/secrets/store.ts) and the command line's relay
// (cli/agent-relay.ts), and tests.
//
//   anthropic  https://api.anthropic.com                  x-api-key + anthropic-version (vendorAuth)
//                POST /v1/messages                         the models list: GET /v1/models?limit=1000
//   openai     https://api.openai.com                     Authorization: Bearer
//                POST /v1/chat/completions, /v1/responses  the models list: GET /v1/models
//   google     https://generativelanguage.googleapis.com  chat: Authorization: Bearer, on its OpenAI-compatible surface
//                POST /v1beta/openai/chat/completions      the models list: GET /v1beta/models?pageSize=1000 with
//                                                          x-goog-api-key (its native list reads no bearer)
//   openrouter https://openrouter.ai                      Authorization: Bearer
//                POST /api/v1/chat/completions             the key check: GET /api/v1/key (the key itself;
//                                                          /api/v1/models is keyless and never its verdict)
//
// Each as its provider's docs give it, read 2026-11-06: Anthropic's models list
// (platform.claude.com/docs/en/api/models/list: at most 1000 a page, has_more and last_id for the next)
// and errors (/docs/en/api/errors: 401 authentication_error, 402 billing_error, 403 permission_error);
// OpenAI's models list (developers.openai.com/api/reference/resources/models/methods/list: one page) and
// error codes (/api/docs/guides/error-codes: 401 for a key that is wrong, revoked or not allowed from
// here, 403 for a region it does not serve: our egress, so no verdict on the key); Google's models list
// (aistudio.google.com/api-reference/models/list-models: at most 1000 a page, nextPageToken for the next)
// and errors (a standard key, AIza…, it cannot use is 400 INVALID_ARGUMENT whose ErrorInfo reason is
// API_KEY_INVALID, not 401; an auth key, AQ.…, it cannot use is 401 UNAUTHENTICATED,
// ACCESS_TOKEN_TYPE_UNSUPPORTED, as discuss.ai.google.dev/t/180529 measured it on 2026-09-02; 402 for
// depleted prepay credit, 403 PERMISSION_DENIED for a project denied access) and its OpenAI-compatible
// surface (aistudio.google.com/docs/openai: chat completions, no Responses API). Each Google route takes
// its own header alone: the compatible surface answers a bearer sent beside x-goog-api-key 400 "API key
// not valid", and x-goog-api-key alone 400 (github.com/NousResearch/hermes-agent/issues/12127,
// 2026-04-18), so its chat never carries x-goog-api-key and the models list never a bearer. OpenRouter's
// errors (openrouter.ai/docs/api-reference/errors, read 2026-11-14: 401 no valid authentication, 402
// insufficient credits, 429 rate limited) come in the OpenAI chat shape, and its models list is keyless
// (measured 2026-11-14: GET /api/v1/models answers 200 with no key), so the list proves transport, not the
// key: a key the check calls valid may still be refused at the chat route. Its key record is the route that
// names the key itself (GET /api/v1/key; openrouter.ai/docs/api-reference/api-keys/get-current-api-key, read
// 2026-11-16: 200 `{ data: { label, limit, limit_remaining, usage, … } }`, 401 an OpenAI-shaped error saying
// what it received: "Invalid API key: this is not an OpenRouter API key", "Missing Authentication header",
// "API key expired", "User not found."), so OpenRouter's check reads that and never the models list.
//
// checkProviderKey: whether a key authenticates with its provider, spending nothing. The provider's own key
// route where it has one (OpenRouter's GET /api/v1/key, one request), else its models list page by page (at
// most MAX_MODEL_PAGES), within one KEY_CHECK_TIMEOUT_MS budget (connect, TLS and every page) and
// MAX_KEY_CHECK_BYTES read in all; TLS verified always (whatever NODE_TLS_REJECT_UNAUTHORIZED says), https
// alone, and no redirect followed. It answers one of:
//
//   valid        a key route's 2xx and its key record (OpenRouter's `{ data: { … } }`: the key itself, its
//                label and its limits), or every models-list page 2xx and a models list: the model ids it
//                lists, and the org and project ids its answers named (IDENTIFIER_HEADERS), kept so the
//                forwarder can mask them out of every answer it relays on this key. OpenRouter lists no
//                models: its keyless list names no key and is never read
//   refused      the provider refused the key: 401, 402 or 403 (any provider), or Google's 400 naming a
//                key it cannot use (GOOGLE_REFUSED_REASONS); the status and why, in the provider's words
//   unreachable  no verdict on the key, which is never the entrant's fault: no connection, TLS not
//                verified, the budget out, the caller's signal, a redirect, any other status (429, 5xx,
//                any other 4xx), an answer whose words name a region the provider does not serve (our
//                egress, REGION_REFUSAL_RE), an answer over MAX_KEY_CHECK_BYTES, one with no models list,
//                or one from a key route with no key record
//
// No message names the key (redactKeys: the key itself, and any run of MIN_KEY_ECHO or more of its
// characters a provider echoes back). A key that cannot go in a header as it is, an unknown provider or
// an origin that is not plain https is a TypeError before anything is sent, and never names the key.

import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import * as zlib from 'node:zlib';
import type { PolicedRoute } from './policy.ts';

/** A provider an entrant's own key is for. */
export type Provider = 'anthropic' | 'openai' | 'google' | 'openrouter';

export const PROVIDERS: readonly Provider[] = Object.freeze(['anthropic', 'openai', 'google', 'openrouter'] as const);

/** Each provider's name, as a message says it. */
export const PROVIDER_NAMES: Readonly<Record<Provider, string>> = Object.freeze({ anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', openrouter: 'OpenRouter' });

/** Where each provider's API is: an https origin, nothing else. */
export const PROVIDER_ORIGINS: Readonly<Record<Provider, string>> = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai',
});

export interface ProviderRoutes {
  /** The models list (GET) the key check reads where the provider has no key route, at its path on the provider's origin. */
  readonly models: string;
  /** The key record's route (GET), where the provider answers for the key itself (OpenRouter's /api/v1/key): the check reads this alone, and its 2xx with a key record is the verdict. */
  readonly keyCheck?: string;
  /** Each gateway route (policy.ts PolicedRoute) the provider serves, at its path on its origin (POST). */
  readonly chat: Readonly<Partial<Record<PolicedRoute, string>>>;
}

/** Each provider's routes (see the header): Google's and OpenRouter's chat is their OpenAI-compatible surface, which has no Responses API. */
export const PROVIDER_ROUTES: Readonly<Record<Provider, ProviderRoutes>> = Object.freeze({
  anthropic: Object.freeze({ models: '/v1/models', chat: Object.freeze({ 'anthropic.messages': '/v1/messages' }) }),
  openai: Object.freeze({ models: '/v1/models', chat: Object.freeze({ 'openai.chat': '/v1/chat/completions', 'openai.responses': '/v1/responses' }) }),
  google: Object.freeze({ models: '/v1beta/models', chat: Object.freeze({ 'openai.chat': '/v1beta/openai/chat/completions' }) }),
  openrouter: Object.freeze({ models: '/api/v1/models', keyCheck: '/api/v1/key', chat: Object.freeze({ 'openai.chat': '/api/v1/chat/completions' }) }),
});

/** The anthropic-version vendorAuth sends: the version a request that names none is read under. */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The headers a request to `provider`'s chat routes authenticates with: Anthropic's x-api-key and
 * anthropic-version (ANTHROPIC_VERSION), OpenAI's, Google's and OpenRouter's Authorization: Bearer. A caller
 * relaying a client's own anthropic-version (server.ts FORWARDED_CLIENT_HEADERS) spreads these first, so the
 * client's version wins.
 */
export function vendorAuth(provider: Provider, key: string): Record<string, string> {
  switch (provider) {
    case 'anthropic':
      return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
    case 'openai':
    case 'google':
    case 'openrouter':
      return { authorization: `Bearer ${key}` };
  }
}

/** The headers a GET to a provider's key route or models list authenticates with: vendorAuth's, but Google's native list reads x-goog-api-key (a bearer reaches it keyless). */
export function modelsListAuth(provider: Provider, key: string): Record<string, string> {
  return provider === 'google' ? { 'x-goog-api-key': key } : vendorAuth(provider, key);
}

/** The whole key check's budget: connect, TLS and every page. */
export const KEY_CHECK_TIMEOUT_MS = 10_000;
/** The most the key check reads, over every page: 1 MiB. */
export const MAX_KEY_CHECK_BYTES = 1024 * 1024;
/** The most response headers it takes. */
export const MAX_KEY_CHECK_HEADER_BYTES = 64 * 1024;
/** The most pages of a models list it reads; a list longer still is taken as far as it read. */
export const MAX_MODEL_PAGES = 10;
/** The page size it asks for, each provider's maximum. */
export const MODELS_PAGE_SIZE = 1000;
export const KEY_CHECK_USER_AGENT = 'makefun-key-check/1';

/** The response headers that name the org or project a key belongs to (Anthropic's organization, OpenAI's organization and project). */
export const IDENTIFIER_HEADERS: readonly string[] = Object.freeze(['anthropic-organization-id', 'openai-organization', 'openai-project']);

/** The statuses that refuse a key at any provider. */
export const REFUSED_STATUSES: readonly number[] = Object.freeze([401, 402, 403]);

/**
 * Words an error (its message, code, status or type, `_` read as a space) uses for a region a provider does
 * not serve: our egress's place, never the key. OpenAI's 403 "Country, region, or territory not supported",
 * code unsupported_country_region_territory (developers.openai.com/api/docs/guides/error-codes, read
 * 2026-11-17); Google's "User location is not supported for the API use" (aistudio.google.com/docs/available-regions
 * lists where it serves); OpenRouter's 403 "This model is not available in your region"
 * (github.com/openclaw/openclaw/issues/41126). Anthropic's region 403 ("Request not allowed") names no region,
 * so it stays a refusal (platform.claude.com/docs/en/api/errors: 403 permission_error).
 */
const REGION_REFUSAL_RE =
  /\b(?:countr(?:y|ies)|regions?|territor(?:y|ies)|location)\b[^.]{0,80}?\b(?:not (?:supported|available|served|allowed)|unsupported|unavailable)\b|\b(?:unsupported|not supported in|not available in|unavailable in)\b[^.]{0,80}?\b(?:countr(?:y|ies)|regions?|territor(?:y|ies)|location)\b/i;

/** The ErrorInfo reasons of Google's 400 that refuse a key: one it cannot use, or one expired. */
export const GOOGLE_REFUSED_REASONS: readonly string[] = Object.freeze(['API_KEY_INVALID', 'API_KEY_EXPIRED']);

/** A key a header carries as it is: visible ASCII, no spaces, at most 4096 characters (upstream.ts UpstreamKey). */
const HEADER_KEY_RE = /^[\x21-\x7e]{1,4096}$/;

/** The shortest run of a key's characters a message may not carry: a provider echoing part of a key leaks that part. */
export const MIN_KEY_ECHO = 12;
const REDACTED = '[redacted]';

/** The verdict on a key (see the header). */
export type KeyCheck =
  | { state: 'valid'; models: string[]; identifiers: string[] }
  | { state: 'refused'; status: number; reason: string }
  | { state: 'unreachable'; reason: string };

export interface KeyCheckOptions {
  /** Aborted when the caller gives up: the check stops and answers unreachable. */
  signal: AbortSignal;
  /** Each provider's origin (default PROVIDER_ORIGINS): https only, a test's fake provider. */
  origins?: Partial<Record<Provider, string>>;
  /** The certificates to trust instead of Node's bundled ones (tests). Verification is never off. */
  ca?: string | Buffer;
  /** The whole check's budget (default KEY_CHECK_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** The longest run of `key`'s consecutive characters `text` holds at offset `at` on, when at least MIN_KEY_ECHO long; else 0. */
function echoAt(text: string, at: number, key: string): number {
  if (text.length - at < MIN_KEY_ECHO) return 0;
  const head = text.slice(at, at + MIN_KEY_ECHO);
  let longest = 0;
  for (let j = key.indexOf(head); j !== -1; j = key.indexOf(head, j + 1)) {
    let n = MIN_KEY_ECHO;
    while (at + n < text.length && j + n < key.length && text[at + n] === key[j + n]) n++;
    if (n > longest) longest = n;
  }
  return longest;
}

/**
 * `text` with each of `keys` replaced, and every run of MIN_KEY_ECHO or more of one's characters with
 * it: every key whole first (the longest first), so one key's echo never cuts another apart.
 */
export function redactKeys(text: string, keys: readonly string[]): string {
  const all = keys.filter((k) => k !== '').sort((a, b) => b.length - a.length);
  let out = text;
  for (const key of all) out = out.split(key).join(REDACTED);
  for (const key of all) {
    if (key.length < MIN_KEY_ECHO) continue;
    let said = '';
    for (let i = 0; i < out.length; ) {
      const run = echoAt(out, i, key);
      if (run > 0) {
        said += REDACTED;
        i += run;
      } else {
        said += out[i];
        i += 1;
      }
    }
    out = said;
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A provider's words as a message carries them: one line, at most `max` characters. */
function clip(text: string, max = 300): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** The origin a provider is checked at: plain https (scheme, host, port), or a TypeError. */
function httpsOrigin(provider: Provider, text: string): URL {
  const name = PROVIDER_NAMES[provider];
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(`${name}'s origin ${JSON.stringify(text)} is not a URL`);
  }
  if (url.protocol !== 'https:') throw new TypeError(`${name}'s origin ${JSON.stringify(text)} is not https: a key goes to its provider over verified TLS only`);
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TypeError(`${name}'s origin ${JSON.stringify(text)} is not an origin: scheme, host and port only`);
  }
  return url;
}

/** The models list's path for a page: the first (cursor null), or the one after `cursor`. */
function modelsPath(provider: Provider, cursor: string | null): string {
  const path = PROVIDER_ROUTES[provider].models;
  switch (provider) {
    case 'anthropic':
      return `${path}?limit=${MODELS_PAGE_SIZE}${cursor === null ? '' : `&after_id=${encodeURIComponent(cursor)}`}`;
    case 'google':
      return `${path}?pageSize=${MODELS_PAGE_SIZE}${cursor === null ? '' : `&pageToken=${encodeURIComponent(cursor)}`}`;
    case 'openai':
    case 'openrouter':
      return path;
  }
}

/** A model id as a list gives it: one line, 1 to 256 characters. */
const MODEL_ID_RE = /^[^\u0000-\u001f\u007f\s][^\u0000-\u001f\u007f]{0,255}$/;

/**
 * A page of a models list: the ids it lists, and the cursor for the next page (null at the last); null
 * when the document is no models list. Anthropic's, OpenAI's and OpenRouter's are `data[].id`; Google's are
 * `models[].name` less its `models/`, and an empty list is `{}` (proto3's JSON leaves an empty list out).
 * OpenRouter's list carries `data[].id` too, its `:free` suffix included.
 */
function pageOf(provider: Provider, doc: unknown): { models: string[]; next: string | null } | null {
  if (!isRecord(doc) || doc.error !== undefined) return null;
  const ids = (entries: unknown[], field: 'id' | 'name'): string[] =>
    entries.flatMap((e) => {
      const v = isRecord(e) ? e[field] : undefined;
      const id = typeof v === 'string' ? (field === 'name' ? v.replace(/^models\//, '') : v).trim() : '';
      return MODEL_ID_RE.test(id) ? [id] : [];
    });
  const cursor = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const listed: unknown = provider === 'google' ? (doc.models ?? []) : doc.data;
  if (!Array.isArray(listed)) return null;
  switch (provider) {
    case 'anthropic':
      return { models: ids(listed, 'id'), next: doc.has_more === true ? cursor(doc.last_id) : null };
    case 'openai':
    case 'openrouter':
      return { models: ids(listed, 'id'), next: null };
    case 'google':
      return { models: ids(listed, 'name'), next: cursor(doc.nextPageToken) };
  }
}

/**
 * Whether a 2xx answer to a provider's key route names the key it was sent on: OpenRouter's key record, a
 * `data` object carrying its label and limits (get-current-api-key.md's 200). A 2xx without one (a proxy's
 * page, an API whose shape changed) says nothing about the key.
 */
function keyRecordOf(doc: unknown): boolean {
  return isRecord(doc) && doc.error === undefined && isRecord(doc.data);
}

/**
 * What an error document says: its kind (Anthropic's and OpenAI's `type`, Google's `status`), its
 * message, and Google's ErrorInfo reasons, each through `tidy` (the key redacted, then clipped: a key
 * clipped first could leave a piece of itself short enough to pass).
 */
function errorOf(text: string | null, tidy: (s: string, max: number) => string): { kind: string | null; message: string | null; reasons: string[]; region: boolean } {
  let doc: unknown = null;
  try {
    doc = text === null ? null : JSON.parse(text);
  } catch {
    // Not JSON: no words of the provider's to give.
  }
  const err = isRecord(doc) && isRecord(doc.error) ? doc.error : null;
  if (err === null) return { kind: null, message: null, reasons: [], region: false };
  const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' ? tidy(v, max) : null);
  const reasons = Array.isArray(err.details) ? err.details.flatMap((d) => (isRecord(d) ? [str(d.reason, 80)].filter((r): r is string => r !== null) : [])) : [];
  const region = [err.message, err.code, err.status, err.type].some((v) => typeof v === 'string' && REGION_REFUSAL_RE.test(v.replace(/_/g, ' ')));
  return { kind: str(err.type, 80) ?? str(err.status, 80) ?? str(err.code, 80), message: str(err.message, 300), reasons, region };
}

/** The connection failures that are no connection made. */
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ETIMEDOUT', 'EAI_FAIL', 'EAI_NONAME']);
const TLS_CODE_RE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_|ERR_OSSL)/;

/** How an exchange failed, in words. */
function faultOf(err: unknown): string {
  const code = typeof (err as NodeJS.ErrnoException)?.code === 'string' ? (err as NodeJS.ErrnoException).code! : '';
  if (CONNECT_CODES.has(code)) return `no connection (${code})`;
  if (TLS_CODE_RE.test(code)) return `its TLS was not verified (${code})`;
  if (code.startsWith('HPE_')) return `its answer is malformed (${code})`;
  return `the connection dropped${code === '' ? '' : ` (${code})`}`;
}

interface Answer {
  status: number;
  headers: Readonly<Record<string, readonly string[]>>;
  /** The body as it came (null for a redirect, never read). */
  body: Buffer | null;
}

type Exchange = { answer: Answer } | { fault: 'oversize' } | { fault: 'error'; why: string };

/** One GET over verified TLS: the status, headers and body (at most `maxBytes`), or how it failed. A redirect's body is never read. */
function exchange(url: URL, path: string, headers: Record<string, string>, o: { signal: AbortSignal; ca: string | Buffer | undefined; maxBytes: number }): Promise<Exchange> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (e: Exchange): void => {
      if (settled) return;
      settled = true;
      resolve(e);
    };
    const r = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port === '' ? 443 : Number(url.port),
      method: 'GET',
      path,
      headers,
      agent: false,
      signal: o.signal,
      maxHeaderSize: MAX_KEY_CHECK_HEADER_BYTES,
      rejectUnauthorized: true,
      ...(o.ca === undefined ? {} : { ca: o.ca }),
    });
    r.on('error', (err) => settle({ fault: 'error', why: faultOf(err) }));
    r.on('response', (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const head = res.headersDistinct as Record<string, string[]>;
      if (status >= 300 && status < 400) {
        settle({ answer: { status, headers: head, body: null } });
        res.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > o.maxBytes) {
          settle({ fault: 'oversize' });
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => settle({ answer: { status, headers: head, body: Buffer.concat(chunks) } }));
      res.on('error', (err) => settle({ fault: 'error', why: faultOf(err) }));
      res.on('close', () => settle({ fault: 'error', why: 'the connection dropped mid-answer' }));
    });
    r.end();
  });
}

/** A body decoded to identity text (at most MAX_KEY_CHECK_BYTES of it), 'oversize' past that, or null when it cannot be decoded. */
function decoded(body: Buffer, encoding: string | undefined): string | 'oversize' | null {
  const e = (encoding ?? '').trim().toLowerCase();
  const opts = { maxOutputLength: MAX_KEY_CHECK_BYTES };
  try {
    if (e === '' || e === 'identity') return body.toString('utf8');
    if (e === 'gzip' || e === 'x-gzip') return zlib.gunzipSync(body, opts).toString('utf8');
    if (e === 'deflate') return zlib.inflateSync(body, opts).toString('utf8');
    if (e === 'br') return zlib.brotliDecompressSync(body, opts).toString('utf8');
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError ? 'oversize' : null;
  }
}

/** Whether a non-2xx answer refuses the key (see the header): one naming a region it does not serve refuses where we call from, never the key. */
function refuses(provider: Provider, status: number, err: { reasons: readonly string[]; region: boolean }): boolean {
  if (err.region) return false;
  return REFUSED_STATUSES.includes(status) || (provider === 'google' && status === 400 && err.reasons.some((r) => GOOGLE_REFUSED_REASONS.includes(r)));
}

/**
 * Whether `key` authenticates with `provider` (see the header): valid on a key route's record, or with the
 * models a models list gives and the org/project ids its answers named; refused with the provider's status
 * and words; or unreachable with why. Never rejects, but with a TypeError (naming no key) for an unknown
 * provider, a key no header can carry, or an origin that is not plain https.
 */
export async function checkProviderKey(provider: Provider, key: string, opts: KeyCheckOptions): Promise<KeyCheck> {
  if (!PROVIDERS.includes(provider)) throw new TypeError(`no provider ${JSON.stringify(provider)}: one of ${PROVIDERS.join(', ')}`);
  const name = PROVIDER_NAMES[provider];
  if (typeof key !== 'string' || !HEADER_KEY_RE.test(key)) throw new TypeError(`the ${name} key is not one a header can carry: 1 to 4096 visible ASCII characters, no spaces`);
  const url = httpsOrigin(provider, opts.origins?.[provider] ?? PROVIDER_ORIGINS[provider]);
  const timeoutMs = opts.timeoutMs ?? KEY_CHECK_TIMEOUT_MS;
  const at = `${name} at ${url.origin}`;
  const say = (text: string): string => redactKeys(text, [key]);
  const tidy = (text: string, max: number): string => clip(say(text), max);
  const unreachable = (why: string): KeyCheck => ({ state: 'unreachable', reason: say(why) });
  if (opts.signal.aborted) return unreachable(`the check of the ${name} key was aborted before it started`);

  // Why the check stopped early, if it did: the budget out, or the caller's signal (whichever came first).
  const controller = new AbortController();
  const ended: { by: 'timeout' | 'aborted' | null } = { by: null };
  const timer = setTimeout(() => {
    ended.by ??= 'timeout';
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => {
    ended.by ??= 'aborted';
    controller.abort();
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });
  const headers = { ...modelsListAuth(provider, key), accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': KEY_CHECK_USER_AGENT };
  /** The verdict a check that stopped before its answer gives (the budget out or the caller's signal), or null when it got one. */
  const stopped = (): KeyCheck | null => {
    if (ended.by === 'timeout') return unreachable(`${at} did not answer within ${timeoutMs} ms`);
    if (ended.by === 'aborted') return unreachable(`the check of the ${name} key was aborted`);
    return null;
  };
  /** The verdict of a non-2xx answer (see the header): refused with the provider's status and words when it refuses the key, else unreachable. */
  const verdictOf = (status: number, text: string | null): KeyCheck => {
    const err = errorOf(text, tidy);
    const words = `${err.kind === null ? '' : ` ${err.kind}`}${err.reasons.length === 0 ? '' : ` ${err.reasons.join(', ')}`}${err.message === null ? '' : `: ${err.message}`}`;
    if (refuses(provider, status, err)) return { state: 'refused', status, reason: say(`${name} refused the key: ${status}${words}`) };
    return unreachable(`${at} answered ${status}${words}, which is no verdict on the key`);
  };
  /** The verdict of a redirect: one is never followed (see the header). */
  const redirectOf = (status: number, head: Answer['headers']): KeyCheck => {
    const location = head.location?.[0];
    return unreachable(`${at} answered ${status}, a redirect${location === undefined ? '' : ` to ${tidy(location, 200)}`}: the check follows none, so it has no verdict on the key`);
  };
  try {
    const keyCheck = PROVIDER_ROUTES[provider].keyCheck;
    if (keyCheck !== undefined) {
      // The provider's own answer on the key itself (OpenRouter's key record): its 2xx is the verdict, and the keyless models list is never read.
      const ex = await exchange(url, keyCheck, headers, { signal: controller.signal, ca: opts.ca, maxBytes: MAX_KEY_CHECK_BYTES });
      const stop = stopped();
      if (stop !== null) return stop;
      if ('fault' in ex) return unreachable(ex.fault === 'oversize' ? `${at} answered more than ${MAX_KEY_CHECK_BYTES} bytes, more than a key record is` : `${at}: ${ex.why}`);
      const { status, headers: head, body } = ex.answer;
      if (body === null) return redirectOf(status, head);
      const text = decoded(body, head['content-encoding']?.[0]);
      if (text === 'oversize') return unreachable(`${at} answered more than ${MAX_KEY_CHECK_BYTES} bytes, more than a key record is`);
      if (status >= 200 && status < 300) {
        let doc: unknown = null;
        try {
          doc = text === null ? null : JSON.parse(text);
        } catch {
          // Not JSON: no key record.
        }
        if (!keyRecordOf(doc)) return unreachable(`${at} answered ${status} with no key record, so it has no verdict on the key`);
        return { state: 'valid', models: [], identifiers: [] };
      }
      return verdictOf(status, text);
    }
    const models = new Set<string>();
    const identifiers = new Set<string>();
    let read = 0;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const ex = await exchange(url, modelsPath(provider, cursor), headers, { signal: controller.signal, ca: opts.ca, maxBytes: MAX_KEY_CHECK_BYTES - read });
      const stop = stopped();
      if (stop !== null) return stop;
      if ('fault' in ex) return unreachable(ex.fault === 'oversize' ? `${at} answered more than ${MAX_KEY_CHECK_BYTES} bytes, more than a models list is` : `${at}: ${ex.why}`);
      const { status, headers: head, body } = ex.answer;
      if (body === null) return redirectOf(status, head);
      read += body.byteLength;
      const text = decoded(body, head['content-encoding']?.[0]);
      if (text === 'oversize') return unreachable(`${at} answered more than ${MAX_KEY_CHECK_BYTES} bytes, more than a models list is`);
      if (status >= 200 && status < 300) {
        let doc: unknown = null;
        try {
          doc = text === null ? null : JSON.parse(text);
        } catch {
          // Not JSON: no models list.
        }
        const list = pageOf(provider, doc);
        if (list === null) return unreachable(`${at} answered ${status} with no models list, so it has no verdict on the key`);
        for (const m of list.models) models.add(m);
        for (const h of IDENTIFIER_HEADERS) {
          for (const v of head[h] ?? []) {
            const id = v.trim();
            if (id.length <= 256 && HEADER_KEY_RE.test(id)) identifiers.add(id);
          }
        }
        cursor = list.next;
        if (cursor === null) break;
        continue;
      }
      return verdictOf(status, text);
    }
    return { state: 'valid', models: [...models].sort(), identifiers: [...identifiers].sort() };
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
  }
}
