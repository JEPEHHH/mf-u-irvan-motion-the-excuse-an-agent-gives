// The scrape contest's recording TLS gateway: the only way out of a scrape/v1 trial network. Docker's
// embedded DNS answers each listed host (apis.roblox.com, games.roblox.com) with this gateway, which
// terminates TLS with the heat CA's leaf for that host (grader/scrape/ca.ts), forwards only the
// listed routes to the real host over one HTTP/2 session per host, and records every exchange in the
// cassette the scorer grades from. grader/scrape/gateway-main.ts is its process.
//
// Config (ScrapeGatewayConfig, format agent-fun/scrape-gateway-config/v1; parseScrapeGatewayConfig
// checks it strictly and refuses anything else):
//   hosts           {"<host>": {ips, cert, key}}: the leaf (PEM) and its key (PEM pkcs8) the gateway
//                   answers that host's ClientHello with, and the host's addresses as the heat
//                   resolved them. The gateway dials only these: it never resolves a name, since its
//                   own resolver answers the listed hosts with the gateway itself
//   routes          [{id, host, method, path, query}]: what may pass. The path matches exactly (the
//                   request target up to its '?', byte for byte); each query key listed must appear
//                   once with exactly that value (decoded as URLSearchParams decodes); other keys
//                   pass through
//   request_caps    {route id: n}: requests per route per trial (every route has one)
//   max_connections TCP connections per trial, accepted or refused
//   max_concurrent  requests in flight at once (admitted, response not yet finished)
//   max_bytes_down  bytes on the wire (TLS records and all) to the entry per trial, every connection's
//   max_bytes_up    bytes on the wire from the entry per trial
//   upstream        'cold': a host's upstream session is dialled when the entry's first ClientHello
//                   naming that host arrives, so it overlaps the entry's own handshake as a direct
//                   connection would; 'warm': every host's session is open before the gateway is ready
//   upstream_port   443 (a test's local port)
//   upstream_ca     null (Node's bundled roots) or a PEM bundle (a test's own CA)
//   user_agent      the one house User-Agent every upstream request carries, naming the make.fun
//                   contest (Roblox's Terms ask API users not to mask their identity)
//   listen_port     443 (0: any free port, a test's)
//
// Per connection: the first bytes must be a whole TLS ClientHello (read here before TLS sees it). One
// with no SNI, or an SNI that is not a listed host, gets an unrecognized_name alert and is closed, as is
// anything that is not a ClientHello; each is a connection with `refused` set and no entry. Otherwise
// TLS runs with ALPN h2 and http/1.1 (http2.createSecureServer, allowHTTP1, an SNICallback that hands
// over only that host's leaf; one server per connection, built before the connection arrives, so
// every request is tied to its connection through public APIs; all share the trial's ticket keys, so
// TLS resumption works across connections as it does against one server).
//
// Per request, in this order (the first that fails decides):
//   authority       h2 :authority (or Host), h1 Host: present, a listed host, optionally with port 443
//                   or the gateway's own, and the connection's SNI exactly (Envoy #6767: an SNI-only
//                   check let SNI apis.roblox.com carry :authority users.roblox.com); an h2 request
//                   carrying both :authority and Host must name the same one
//   route           host and path a route's, then its method, then its required query
//                   -> refused_route, answered 403 {"error": reason}
//   request cap     the route's request_caps count not reached
//   concurrency     fewer than max_concurrent in flight
//                   -> refused_cap, answered 429 {"error": reason}
//   forward         to the host's upstream session: the entry's headers less authorization,
//                   x-api-key, cookie, proxy-*, forwarded, via, x-forwarded-* and the other
//                   client-address headers, hop-by-hop and request-body headers, with the house
//                   User-Agent in place of the entry's. The response goes back as received: its
//                   status, its headers less connection-specific ones, set-cookie and alt-svc, and its
//                   body bytes still encoded. An upstream 429 or 5xx is forwarded the same way and
//                   recorded upstream_error (a void); an upstream that cannot be reached, or resets
//                   before its response, is answered 502 {"error": reason} and recorded
//                   upstream_error too. A request header node:http2 will not send is the entry's:
//                   refused_route bad_header, and the route's count is given back
// A connection that pushes either trial byte total past its cap is destroyed (`refused`
// max_bytes_up or max_bytes_down), as is the connection over max_connections, at accept.
//
// The cassette (ScrapeCassette, format agent-fun/scrape-cassette/v1; the scorer and the trial grader
// read exactly these names), written as canonical JSON (keys in code-unit order, no whitespace,
// integers only: cassetteJson), so equal traffic writes equal entries but for t_us; a connection's
// wire byte counts also move by a few bytes a handshake (an ECDSA signature's DER length varies):
//   entries[]       in arrival order: {seq, t_us (integer microseconds since ready, monotonic; 0 for
//                   anything earlier), connection, sni, alpn, method, authority, path (with query, as
//                   received), route (id or null), outcome (forwarded | refused_route | refused_cap |
//                   upstream_error), reason, status (sent to the entry, or null when nothing was),
//                   headers (from the upstream response: x-ratelimit-limit, x-ratelimit-remaining,
//                   x-ratelimit-reset, content-type and date, as strings; {} without one),
//                   content_encoding (the upstream's, or null), body_sha256 and body_bytes (the
//                   DECODED upstream body: gzip, x-gzip, deflate, br, and zstd where node:zlib has it;
//                   both null when there is no whole upstream body or it does not decode),
//                   wire_bytes (body bytes sent to the entry)}
//   connections[]   in accept order: {id, t_us, sni, alpn (negotiated, or null), bytes_up, bytes_down,
//                   refused (reason or null)}
//   totals          {requests, forwarded, refused_route, refused_cap, upstream_error, connections,
//                   refused_connections, bytes_up, bytes_down}: each the sum of what is listed
// `reason` is null for a clean exchange, else one of: the refusal (no_authority, bad_authority,
// unknown_authority, authority_mismatch, not_a_route, method_not_allowed, missing_query, bad_header,
// request_cap, max_concurrent); upstream_status (the upstream's own 429 or 5xx), upstream_unavailable,
// upstream_reset, bad_upstream_header; entry_aborted (the entry closed before its response was all
// sent: the upstream's answer is still read whole and recorded), or the cap that destroyed its
// connection; unfinished (the entry was still waiting when the trial stopped: an upstream that had not
// answered is upstream_error). Connection `refused`: max_connections, not_tls, bad_client_hello,
// no_sni, unknown_sni, max_bytes_up, max_bytes_down, max_entries.
//
// The decoded bodies come back beside the cassette, keyed by sha256 (gateway-main.ts writes them to
// /record/bodies/<sha256>). Recording work (decoding, hashing) waits for stop(), off the path a
// response takes to the entry.
//
// Entry secrets (an entrant's env-lane values, contracts/entry-secrets.ts) never reach the gateway: its
// config holds none. The cassette is a scrape contest's answer key and is stored and served, so a trial
// whose entry runs with secrets masks every form of them out of the record the gateway wrote before
// anything of it is stored (grader/scrape/trial.ts, with grader/gateway/secret-mask.ts):
// maskScrapeRecording below names what of a record an entry or an upstream may have written, the rest
// being the gateway's own words. Equal traffic and equal secrets mask to equal bytes, in every round.
//
// An entry that floods the gateway is bounded: past max_connections + MAX_LISTED_REFUSED_CONNECTIONS
// connections, more are dropped unlisted, and a request past MAX_ENTRIES destroys its connection
// (`refused` max_entries) and is not listed.
//
// Stdlib only: grader/scrape/bundle.ts inlines this file, with ca.ts, into scrape-gateway.mjs.

import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { connect as h2connect, constants as h2constants, createSecureServer, type ClientHttp2Session, type ClientHttp2Stream, type Http2SecureServer, type IncomingHttpHeaders } from 'node:http2';
import { createServer as createNetServer, isIP, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { connect as tlsConnect, createSecureContext, type ConnectionOptions, type SecureContext, type TLSSocket } from 'node:tls';
import * as zlib from 'node:zlib';
import { isHostName } from './ca.ts';

export const SCRAPE_GATEWAY_CONFIG_FORMAT = 'agent-fun/scrape-gateway-config/v1';
export const SCRAPE_CASSETTE_FORMAT = 'agent-fun/scrape-cassette/v1';

/** The upstream response headers an entry records, as strings. */
export const RECORDED_HEADERS: readonly string[] = Object.freeze(['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'content-type', 'date']);
/** How long opening one upstream address may take before the next is tried. */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
/** The upstream sessions' HTTP/2 receive window per stream (four times it per session). */
export const UPSTREAM_WINDOW_BYTES = 1 << 20;
/** The largest ClientHello read before TLS starts, and the most TLS records it may span. */
export const MAX_CLIENT_HELLO_BYTES = 65_536;
export const MAX_CLIENT_HELLO_RECORDS = 64;
/** The largest decoded body recorded; a bigger one records body_sha256 null. */
export const MAX_DECODED_BODY_BYTES = 64 << 20;
/** Connections past max_connections that are still listed (refused max_connections); later ones are dropped unlisted. */
export const MAX_LISTED_REFUSED_CONNECTIONS = 64;
/** Entries recorded at most in one trial. */
export const MAX_ENTRIES = 4096;

// ---------------------------------------------------------------- config

export interface ScrapeHostConfig {
  ips: string[];
  cert: string;
  key: string;
}

export interface ScrapeRoute {
  id: string;
  host: string;
  method: 'GET';
  path: string;
  query: Record<string, string>;
}

export interface ScrapeGatewayConfig {
  format: typeof SCRAPE_GATEWAY_CONFIG_FORMAT;
  hosts: Record<string, ScrapeHostConfig>;
  routes: ScrapeRoute[];
  request_caps: Record<string, number>;
  max_connections: number;
  max_concurrent: number;
  max_bytes_down: number;
  max_bytes_up: number;
  upstream: 'cold' | 'warm';
  upstream_port: number;
  upstream_ca: string | null;
  user_agent: string;
  listen_port: number;
}

const CONFIG_KEYS: readonly string[] = [
  'format',
  'hosts',
  'routes',
  'request_caps',
  'max_connections',
  'max_concurrent',
  'max_bytes_down',
  'max_bytes_up',
  'upstream',
  'upstream_port',
  'upstream_ca',
  'user_agent',
  'listen_port',
];

export class ScrapeGatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrapeGatewayConfigError';
  }
}

function configFail(path: string, message: string): never {
  throw new ScrapeGatewayConfigError(`${path}: ${message}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** `v` as an object holding exactly `keys`. */
function exactObject(v: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(v)) configFail(path, 'is not an object');
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  if (extra.length > 0) configFail(path, `has unknown key${extra.length > 1 ? 's' : ''} ${extra.map((k) => JSON.stringify(k)).join(', ')}`);
  const missing = keys.filter((k) => !Object.hasOwn(v, k));
  if (missing.length > 0) configFail(path, `lacks ${missing.join(', ')}`);
  return v;
}

function intIn(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) configFail(path, `is not an integer in ${min}..${max}`);
  return v;
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;
/** The first line of a PEM pkcs8 private key (written in parts so no key-shaped literal sits in the source). */
const PKCS8_BEGIN = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');

/** Every certificate in a PEM bundle, parsed: at least one, and nothing but certificates. */
function pemCertificates(v: unknown, path: string): X509Certificate[] {
  if (typeof v !== 'string' || v.length > 1 << 20) configFail(path, 'is not a PEM certificate string');
  const blocks = v.match(PEM_CERT) ?? [];
  if (blocks.length === 0 || v.replace(PEM_CERT, '').trim() !== '') configFail(path, 'is not one or more PEM certificates and nothing else');
  return blocks.map((b) => {
    try {
      return new X509Certificate(b);
    } catch {
      return configFail(path, 'holds a certificate that does not parse');
    }
  });
}

function checkHostConfig(host: string, v: unknown, now: number): ScrapeHostConfig {
  const path = `hosts.${host}`;
  const o = exactObject(v, path, ['ips', 'cert', 'key']);
  if (!Array.isArray(o.ips) || o.ips.length === 0 || o.ips.length > 8) configFail(`${path}.ips`, 'is not a list of 1..8 addresses');
  const ips = o.ips.map((ip: unknown, i) => (typeof ip === 'string' && isIP(ip) !== 0 ? ip : configFail(`${path}.ips.${i}`, 'is not an IP address literal')));
  if (new Set(ips).size !== ips.length) configFail(`${path}.ips`, 'lists an address twice');
  const certs = pemCertificates(o.cert, `${path}.cert`);
  if (certs.length !== 1) configFail(`${path}.cert`, 'is not exactly one certificate');
  const leaf = certs[0]!;
  if (leaf.ca) configFail(`${path}.cert`, 'is a CA certificate, not a leaf');
  if (leaf.checkHost(host, { wildcards: false, subject: 'never' }) !== host) configFail(`${path}.cert`, `does not name ${host} in its subjectAltName`);
  if (Date.parse(leaf.validTo) <= now || Date.parse(leaf.validFrom) > now) configFail(`${path}.cert`, 'is not valid now');
  if (typeof o.key !== 'string' || !o.key.startsWith(PKCS8_BEGIN)) configFail(`${path}.key`, 'is not a PEM pkcs8 private key');
  let matches = false;
  try {
    matches = leaf.checkPrivateKey(createPrivateKey(o.key));
  } catch {
    configFail(`${path}.key`, 'does not parse as a private key');
  }
  if (!matches) configFail(`${path}.key`, `is not the key of ${path}.cert`);
  return { ips, cert: o.cert as string, key: o.key };
}

const ROUTE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const ROUTE_PATH = /^\/[\x21-\x7e]*$/;
const PRINTABLE = /^[\x20-\x7e]+$/;

function checkRoute(v: unknown, i: number, hosts: Record<string, ScrapeHostConfig>): ScrapeRoute {
  const path = `routes.${i}`;
  const o = exactObject(v, path, ['id', 'host', 'method', 'path', 'query']);
  if (typeof o.id !== 'string' || !ROUTE_ID.test(o.id)) configFail(`${path}.id`, 'is not a route id (a lowercase letter, then up to 31 of a-z 0-9 _ -)');
  if (typeof o.host !== 'string' || !Object.hasOwn(hosts, o.host)) configFail(`${path}.host`, 'is not one of hosts');
  if (o.method !== 'GET') configFail(`${path}.method`, 'is not "GET"');
  if (typeof o.path !== 'string' || o.path.length > 2048 || !ROUTE_PATH.test(o.path) || o.path.includes('?') || o.path.includes('#')) {
    configFail(`${path}.path`, "is not an origin-form path (a '/' then printable ASCII, no '?' or '#')");
  }
  if (!isPlainObject(o.query)) configFail(`${path}.query`, 'is not an object');
  const query: Record<string, string> = {};
  const keys = Object.keys(o.query);
  if (keys.length > 16) configFail(`${path}.query`, 'requires more than 16 keys');
  for (const k of keys) {
    const val = o.query[k];
    if (k.length > 256 || !PRINTABLE.test(k)) configFail(`${path}.query`, 'has a key that is not 1..256 printable ASCII characters');
    if (typeof val !== 'string' || val.length > 1024 || !PRINTABLE.test(val)) configFail(`${path}.query.${k}`, 'is not 1..1024 printable ASCII characters');
    query[k] = val;
  }
  return { id: o.id, host: o.host, method: 'GET', path: o.path, query };
}

/** Check a parsed /config/gateway.json strictly (see the header): the config, or ScrapeGatewayConfigError. */
export function parseScrapeGatewayConfig(raw: unknown, now: number = Date.now()): ScrapeGatewayConfig {
  const o = exactObject(raw, '(config)', CONFIG_KEYS);
  if (o.format !== SCRAPE_GATEWAY_CONFIG_FORMAT) configFail('format', `is not ${JSON.stringify(SCRAPE_GATEWAY_CONFIG_FORMAT)}`);
  if (!isPlainObject(o.hosts)) configFail('hosts', 'is not an object');
  const hostNames = Object.keys(o.hosts);
  if (hostNames.length === 0 || hostNames.length > 8) configFail('hosts', 'does not list 1..8 hosts');
  const hosts: Record<string, ScrapeHostConfig> = {};
  for (const h of hostNames) {
    if (!isHostName(h)) configFail('hosts', `${JSON.stringify(h)} is not an exact lowercase DNS name`);
    hosts[h] = checkHostConfig(h, o.hosts[h], now);
  }
  if (!Array.isArray(o.routes) || o.routes.length === 0 || o.routes.length > 16) configFail('routes', 'is not a list of 1..16 routes');
  const routes = o.routes.map((r: unknown, i) => checkRoute(r, i, hosts));
  const ids = new Set<string>();
  const shapes = new Set<string>();
  for (const r of routes) {
    if (ids.has(r.id)) configFail('routes', `lists the id ${r.id} twice`);
    ids.add(r.id);
    const shape = canonicalJson([r.host, r.method, r.path, r.query]);
    if (shapes.has(shape)) configFail('routes', `${r.id} repeats another route's host, method, path and query`);
    shapes.add(shape);
  }
  const caps = exactObject(o.request_caps, 'request_caps', routes.map((r) => r.id));
  const request_caps: Record<string, number> = {};
  for (const r of routes) request_caps[r.id] = intIn(caps[r.id], `request_caps.${r.id}`, 0, 10_000);
  if (o.upstream !== 'cold' && o.upstream !== 'warm') configFail('upstream', 'is not "cold" or "warm"');
  let upstream_ca: string | null = null;
  if (o.upstream_ca !== null) {
    pemCertificates(o.upstream_ca, 'upstream_ca');
    upstream_ca = o.upstream_ca as string;
  }
  if (typeof o.user_agent !== 'string' || o.user_agent.length > 256 || !PRINTABLE.test(o.user_agent)) configFail('user_agent', 'is not 1..256 printable ASCII characters');
  if (!o.user_agent.includes('make.fun')) configFail('user_agent', 'does not name the make.fun contest');
  return {
    format: SCRAPE_GATEWAY_CONFIG_FORMAT,
    hosts,
    routes,
    request_caps,
    max_connections: intIn(o.max_connections, 'max_connections', 1, 10_000),
    max_concurrent: intIn(o.max_concurrent, 'max_concurrent', 1, 10_000),
    max_bytes_down: intIn(o.max_bytes_down, 'max_bytes_down', 1, Number.MAX_SAFE_INTEGER),
    max_bytes_up: intIn(o.max_bytes_up, 'max_bytes_up', 1, Number.MAX_SAFE_INTEGER),
    upstream: o.upstream,
    upstream_port: intIn(o.upstream_port, 'upstream_port', 1, 65_535),
    upstream_ca,
    user_agent: o.user_agent,
    listen_port: intIn(o.listen_port, 'listen_port', 0, 65_535),
  };
}

// ---------------------------------------------------------------- cassette

export type ScrapeOutcome = 'forwarded' | 'refused_route' | 'refused_cap' | 'upstream_error';

export interface ScrapeCassetteEntry {
  seq: number;
  t_us: number;
  connection: number;
  sni: string;
  alpn: string | null;
  method: string;
  authority: string | null;
  path: string | null;
  route: string | null;
  outcome: ScrapeOutcome;
  reason: string | null;
  status: number | null;
  headers: Record<string, string>;
  content_encoding: string | null;
  body_sha256: string | null;
  body_bytes: number | null;
  wire_bytes: number;
}

export interface ScrapeCassetteConnection {
  id: number;
  t_us: number;
  sni: string | null;
  alpn: string | null;
  bytes_up: number;
  bytes_down: number;
  refused: string | null;
}

export interface ScrapeCassetteTotals {
  requests: number;
  forwarded: number;
  refused_route: number;
  refused_cap: number;
  upstream_error: number;
  connections: number;
  refused_connections: number;
  bytes_up: number;
  bytes_down: number;
}

export interface ScrapeCassette {
  format: typeof SCRAPE_CASSETTE_FORMAT;
  entries: ScrapeCassetteEntry[];
  connections: ScrapeCassetteConnection[];
  totals: ScrapeCassetteTotals;
}

/** A trial's record: the cassette and the decoded bodies it names, keyed by sha256. */
export interface ScrapeRecording {
  cassette: ScrapeCassette;
  bodies: Map<string, Buffer>;
}

/** Canonical JSON: object keys in code-unit order, no whitespace, safe integers the only numbers. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError(`canonical JSON holds integers only, not ${value}`);
      return String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v: unknown) => canonicalJson(v)).join(',')}]`;
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined);
      // Array.prototype.sort compares strings by UTF-16 code units.
      keys.sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot hold a ${typeof value}`);
  }
}

/** The cassette file's text: its canonical JSON. */
export function cassetteJson(cassette: ScrapeCassette): string {
  return canonicalJson(cassette);
}

/** The sums `totals` holds, from the lists. */
export function cassetteTotals(entries: readonly ScrapeCassetteEntry[], connections: readonly ScrapeCassetteConnection[]): ScrapeCassetteTotals {
  const count = (o: ScrapeOutcome): number => entries.filter((e) => e.outcome === o).length;
  return {
    requests: entries.length,
    forwarded: count('forwarded'),
    refused_route: count('refused_route'),
    refused_cap: count('refused_cap'),
    upstream_error: count('upstream_error'),
    connections: connections.length,
    refused_connections: connections.filter((c) => c.refused !== null).length,
    bytes_up: connections.reduce((s, c) => s + c.bytes_up, 0),
    bytes_down: connections.reduce((s, c) => s + c.bytes_down, 0),
  };
}

/** What masks a record's entry secrets (maskScrapeRecording): one string of the cassette, and one decoded body. */
export interface ScrapeRecordingMask {
  text(s: string): string;
  body(b: Buffer): Buffer;
}

/**
 * `recording` with what an entry or an upstream may have written masked (the header's entry secrets): what the entry
 * sent (each entry's method, authority and path, and the SNI of a connection no entry came on: one refused before TLS,
 * whose SNI named no listed host), and what the upstream answered (each entry's recorded headers and content_encoding,
 * and each decoded body, named again by its masked bytes' sha256 and size). Nothing else is touched: ids, clocks, routes,
 * outcomes, reasons, statuses, the listed host an entry's SNI names, and the wire counts (wire_bytes, bytes_up and
 * bytes_down stay what crossed the wire), so the totals still add up. A body named nowhere stays as it is. Pure: the same
 * record and mask give the same record.
 */
export function maskScrapeRecording(recording: ScrapeRecording, mask: ScrapeRecordingMask): ScrapeRecording {
  const bodies = new Map<string, Buffer>();
  const renamed = new Map<string, { sha256: string; bytes: number }>();
  for (const [sha256, body] of recording.bodies) {
    const masked = mask.body(body);
    const same = masked.equals(body);
    const name = same ? sha256 : createHash('sha256').update(masked).digest('hex');
    renamed.set(sha256, { sha256: name, bytes: same ? body.length : masked.length });
    if (!bodies.has(name)) bodies.set(name, same ? body : Buffer.from(masked));
  }
  const maybe = (s: string | null): string | null => (s === null ? null : mask.text(s));
  const used = new Set(recording.cassette.entries.map((e) => e.connection));
  const entries: ScrapeCassetteEntry[] = recording.cassette.entries.map((e) => {
    const body = e.body_sha256 === null ? undefined : renamed.get(e.body_sha256);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(e.headers)) headers[name] = mask.text(value);
    return {
      ...e,
      method: mask.text(e.method),
      authority: maybe(e.authority),
      path: maybe(e.path),
      headers,
      content_encoding: maybe(e.content_encoding),
      ...(body === undefined ? {} : { body_sha256: body.sha256, body_bytes: body.bytes }),
    };
  });
  const connections: ScrapeCassetteConnection[] = recording.cassette.connections.map((c) => (used.has(c.id) ? { ...c } : { ...c, sni: maybe(c.sni) }));
  return { cassette: { ...recording.cassette, entries, connections, totals: { ...recording.cassette.totals } }, bodies };
}

/** True when node:zlib can decode zstd here (Node 22.15 and later). */
export const ZSTD_DECODES = typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function';

/**
 * A body decoded from its Content-Encoding (codings undone last first: gzip, x-gzip, deflate, br,
 * zstd, identity), or null when a coding is unknown, zstd is not in this node:zlib, the bytes do not
 * decode, or the result would pass MAX_DECODED_BODY_BYTES.
 */
export function decodeBody(raw: Buffer, contentEncoding: string | null): Buffer | null {
  const codings = (contentEncoding ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '' && c !== 'identity');
  const opts = { maxOutputLength: MAX_DECODED_BODY_BYTES };
  let body = raw;
  try {
    for (const c of codings.reverse()) {
      if (c === 'gzip' || c === 'x-gzip') body = zlib.gunzipSync(body, opts);
      else if (c === 'br') body = zlib.brotliDecompressSync(body, opts);
      else if (c === 'zstd' && ZSTD_DECODES) body = zlib.zstdDecompressSync(body, opts);
      else if (c === 'deflate') {
        try {
          body = zlib.inflateSync(body, opts);
        } catch {
          body = zlib.inflateRawSync(body, opts);
        }
      } else return null;
    }
  } catch {
    return null;
  }
  return body.length > MAX_DECODED_BODY_BYTES ? null : body;
}

// ---------------------------------------------------------------- ClientHello

export type ClientHelloRead = { kind: 'more' } | { kind: 'refused'; reason: 'not_tls' | 'bad_client_hello' } | { kind: 'hello'; sni: string | null };

/**
 * Read the SNI host_name out of a connection's first bytes: 'more' until a whole ClientHello is there
 * (it may span TLS records), 'refused' when the bytes are not one, else its SNI (lowercased), or null
 * when it carries none.
 */
export function readClientHello(buf: Buffer): ClientHelloRead {
  if (buf.length === 0) return { kind: 'more' };
  if (buf[0] !== 0x16) return { kind: 'refused', reason: 'not_tls' };
  const fragments: Buffer[] = [];
  let have = 0;
  let off = 0;
  let need = -1;
  while (need < 0 || have < need) {
    if (fragments.length >= MAX_CLIENT_HELLO_RECORDS) return { kind: 'refused', reason: 'bad_client_hello' };
    if (buf.length < off + 5) return { kind: 'more' };
    if (buf[off] !== 0x16 || buf[off + 1] !== 0x03) return { kind: 'refused', reason: off === 0 ? 'not_tls' : 'bad_client_hello' };
    const len = buf.readUInt16BE(off + 3);
    if (len === 0 || len > 16_384) return { kind: 'refused', reason: 'bad_client_hello' };
    if (buf.length < off + 5 + len) return { kind: 'more' };
    fragments.push(buf.subarray(off + 5, off + 5 + len));
    have += len;
    off += 5 + len;
    if (need < 0 && have >= 4) {
      const head = Buffer.concat(fragments);
      if (head[0] !== 0x01) return { kind: 'refused', reason: 'bad_client_hello' };
      need = 4 + head.readUIntBE(1, 3);
      if (need > MAX_CLIENT_HELLO_BYTES) return { kind: 'refused', reason: 'bad_client_hello' };
    }
  }
  try {
    return { kind: 'hello', sni: helloSni(Buffer.concat(fragments).subarray(4, need)) };
  } catch {
    return { kind: 'refused', reason: 'bad_client_hello' };
  }
}

/** The host_name in a ClientHello body's server_name extension, or null. Throws on a malformed body. */
function helloSni(b: Buffer): string | null {
  let p = 0;
  const skip = (n: number): number => {
    const at = p;
    if (p + n > b.length) throw new RangeError('short ClientHello');
    p += n;
    return at;
  };
  skip(2 + 32); // legacy_version, random
  skip(b[skip(1)]!); // legacy_session_id
  skip(b.readUInt16BE(skip(2))); // cipher_suites
  skip(b[skip(1)]!); // legacy_compression_methods
  if (p === b.length) return null;
  const extLen = b.readUInt16BE(skip(2));
  if (p + extLen !== b.length) throw new RangeError('the extensions do not end the ClientHello');
  while (p < b.length) {
    const type = b.readUInt16BE(skip(2));
    const len = b.readUInt16BE(skip(2));
    const ext = b.subarray(skip(len), p);
    if (type !== 0) continue;
    if (ext.length < 2 || 2 + ext.readUInt16BE(0) !== ext.length) throw new RangeError('a bad server_name list');
    for (let q = 2; q < ext.length; ) {
      if (q + 3 > ext.length) throw new RangeError('a bad server_name entry');
      const nameType = ext[q]!;
      const nameLen = ext.readUInt16BE(q + 1);
      if (q + 3 + nameLen > ext.length) throw new RangeError('a bad server_name entry');
      const name = ext.subarray(q + 3, q + 3 + nameLen);
      if (nameType === 0) {
        if (nameLen === 0 || !name.every((c) => c > 0x20 && c < 0x7f)) throw new RangeError('a host_name that is not printable ASCII');
        return name.toString('ascii').toLowerCase();
      }
      q += 3 + nameLen;
    }
    return null;
  }
  return null;
}

/** A fatal TLS alert record. */
const tlsAlert = (description: number): Buffer => Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, description]);
const ALERT_UNRECOGNIZED_NAME = 112;
const ALERT_DECODE_ERROR = 50;

// ---------------------------------------------------------------- headers

/** Request headers that never reach the upstream (the house User-Agent replaces user-agent). */
const DROPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'user-agent',
  'forwarded',
  'via',
  'x-real-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'http2-settings',
  'expect',
  'content-length',
]);

/** Whether an entry's request header is dropped on the way upstream. */
export function isDroppedRequestHeader(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith(':') || n.startsWith('proxy-') || n.startsWith('x-forwarded-') || DROPPED_REQUEST_HEADERS.has(n);
}

/** Response headers that never reach the entry: connection-specific ones, and state the gateway does not carry. */
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'set-cookie', 'alt-svc']);

type HeaderMap = Record<string, string | string[] | undefined>;

/** What the upstream sees of an entry's headers: the kept ones, then the house User-Agent. */
export function upstreamRequestHeaders(entry: HeaderMap, userAgent: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(entry)) {
    if (value === undefined || isDroppedRequestHeader(name)) continue;
    out[name.toLowerCase()] = value;
  }
  out['user-agent'] = userAgent;
  return out;
}

function forwardedResponseHeaders(h: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(h)) {
    if (value === undefined || name.startsWith(':') || DROPPED_RESPONSE_HEADERS.has(name)) continue;
    out[name] = Array.isArray(value) ? value : String(value);
  }
  return out;
}

function recordedHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const v = h[name];
    if (v === undefined) continue;
    out[name] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function headerText(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(', ') : v;
}

// ---------------------------------------------------------------- the gateway

export class ScrapeGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrapeGatewayError';
  }
}

/** One accepted connection, as listed and as tracked. */
interface Conn {
  id: number;
  t_us: number;
  sni: string | null;
  alpn: string | null;
  bytes_up: number;
  bytes_down: number;
  refused: string | null;
  raw: Socket;
  meter: Meter | null;
  hello_ns: bigint | null;
  secure_ns: bigint | null;
}

/** One request, as recorded and as tracked. */
interface Exchange {
  seq: number;
  t_us: number;
  conn: Conn;
  method: string;
  authority: string | null;
  path: string | null;
  route: string | null;
  outcome: ScrapeOutcome;
  reason: string | null;
  status: number | null;
  headers: Record<string, string>;
  content_encoding: string | null;
  /** The upstream body as received; null until a response arrives. */
  chunks: Buffer[] | null;
  /** True once the upstream response ended whole. */
  bodyWhole: boolean;
  wire_bytes: number;
  /** The upstream side is settled: ended, failed, or never involved. */
  upstreamDone: boolean;
  /** The entry side is settled: its response closed. */
  entryDone: boolean;
  /** The gateway ended the entry's response. */
  sentEnd: boolean;
  /** Counted in the in-flight total. */
  inFlight: boolean;
}

/** The entry's request as node:http and the http2 compatibility API both present it. */
interface EntryRequest {
  httpVersionMajor: number;
  method?: string;
  url?: string;
  headers: HeaderMap;
  resume?(): unknown;
  on?(event: 'error', listener: () => void): unknown;
}

/** The entry's response as both present it. */
interface EntryResponse {
  writeHead(status: number, headers?: Record<string, string | string[] | number>): unknown;
  write(chunk: Buffer): boolean;
  end(chunk?: Buffer): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
  once(event: 'drain', listener: () => void): unknown;
  readonly headersSent: boolean;
  stream?: { close(code?: number): void };
  destroy?(err?: Error): unknown;
}

/**
 * A connection's bytes between its TCP socket and TLS: counted both ways against the trial's caps,
 * the first held until the ClientHello is whole (accept() does that), destroyed to refuse.
 */
class Meter extends Duplex {
  readonly conn: Conn;
  readonly gw: Gateway;
  constructor(conn: Conn, gw: Gateway) {
    super();
    this.conn = conn;
    this.gw = gw;
  }
  override _read(): void {
    this.conn.raw.resume();
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (!this.gw.countDown(this.conn, chunk.length)) {
      cb();
      return;
    }
    if (this.conn.raw.write(chunk)) cb();
    else this.conn.raw.once('drain', () => cb());
  }
  override _final(cb: (err?: Error | null) => void): void {
    this.conn.raw.end();
    cb();
  }
  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.conn.raw.destroy();
    cb(err);
  }
}

/** A per-connection HTTP/2 + HTTP/1.1 TLS server, built before the connection it will serve arrives. */
interface Slot {
  server: Http2SecureServer;
  conn: Conn | null;
}

/** One listed host's upstream: at most one HTTP/2 session per trial. */
interface UpstreamHost {
  host: string;
  session: Promise<ClientHttp2Session> | null;
  live: ClientHttp2Session | null;
  dial_ns: bigint | null;
  connect_ns: bigint | null;
  error: string | null;
}

/** When things happened (process.hrtime.bigint() nanoseconds): for tests and diagnostics, never the cassette. */
export interface ScrapeGatewayTrace {
  ready_ns: bigint | null;
  connections: { id: number; sni: string | null; hello_ns: bigint | null; secure_ns: bigint | null }[];
  upstreams: { host: string; dial_ns: bigint | null; connect_ns: bigint | null; error: string | null }[];
}

export interface ScrapeGateway {
  /** Listen on `host` at the config's listen_port, open the warm upstreams, then start the clock: the port. */
  start(host: string): Promise<number>;
  /** End the trial: refuse anything new, settle what is open as it stands, close every socket, and return the record. */
  stop(): Promise<ScrapeRecording>;
  trace(): ScrapeGatewayTrace;
}

const refuseLookup = (hostname: string, _opts: unknown, cb: (err: Error | null) => void): void => {
  cb(new ScrapeGatewayError(`the gateway never resolves names (asked for ${hostname})`));
};

/** What node:http2 throws for a request header it will not send: the entry's fault, not the upstream's. */
const BAD_HEADER_CODES = new Set(['ERR_HTTP2_INVALID_HEADER_VALUE', 'ERR_INVALID_CHAR', 'ERR_INVALID_HTTP_TOKEN', 'ERR_HTTP2_INVALID_CONNECTION_HEADERS', 'ERR_HTTP2_HEADER_SINGLE_VALUE']);

class Gateway implements ScrapeGateway {
  readonly cfg: ScrapeGatewayConfig;
  readonly contexts = new Map<string, SecureContext>();
  readonly upstreams = new Map<string, UpstreamHost>();
  readonly ticketKeys = randomBytes(48);
  readonly conns: Conn[] = [];
  readonly exchanges: Exchange[] = [];
  readonly routeCounts = new Map<string, number>();
  inFlight = 0;
  bytesUp = 0;
  bytesDown = 0;
  t0: bigint | null = null;
  port = 0;
  listener: NetServer | null = null;
  spare: Slot | null = null;
  stopping = false;
  stopped: Promise<ScrapeRecording> | null = null;

  constructor(cfg: ScrapeGatewayConfig) {
    this.cfg = cfg;
    for (const [host, h] of Object.entries(cfg.hosts)) {
      this.contexts.set(host, createSecureContext({ cert: h.cert, key: h.key, minVersion: 'TLSv1.2' }));
      this.upstreams.set(host, { host, session: null, live: null, dial_ns: null, connect_ns: null, error: null });
    }
    for (const r of cfg.routes) this.routeCounts.set(r.id, 0);
  }

  now(): bigint {
    return process.hrtime.bigint();
  }

  tUs(): number {
    if (this.t0 === null) return 0;
    const d = (this.now() - this.t0) / 1000n;
    return d < 0n ? 0 : Number(d);
  }

  // ------------------------------------------------------------ lifecycle

  async start(host: string): Promise<number> {
    if (this.listener !== null) throw new ScrapeGatewayError('the gateway is already started');
    this.spare = this.makeSlot();
    const listener = createNetServer({ noDelay: true }, (raw) => this.accept(raw));
    this.listener = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(this.cfg.listen_port, host, () => {
        listener.off('error', reject);
        resolve();
      });
    });
    listener.on('error', () => {});
    this.port = (listener.address() as AddressInfo).port;
    if (this.cfg.upstream === 'warm') {
      try {
        await Promise.all([...this.upstreams.values()].map((u) => this.openUpstream(u)));
      } catch (err) {
        await this.stop();
        throw new ScrapeGatewayError(`a warm upstream could not be opened: ${(err as Error).message}`);
      }
    }
    this.t0 = this.now();
    return this.port;
  }

  stop(): Promise<ScrapeRecording> {
    this.stopped ??= this.doStop();
    return this.stopped;
  }

  private async doStop(): Promise<ScrapeRecording> {
    this.stopping = true;
    const listener = this.listener;
    const closed = listener === null ? Promise.resolve() : new Promise<void>((resolve) => listener.close(() => resolve()));
    // Settle every open exchange as it stands before its sockets go, so their close handlers find it final.
    for (const ex of this.exchanges) {
      if (!ex.entryDone && !ex.sentEnd) {
        // The entry was still waiting: on an upstream that had not answered, that is the upstream's.
        if (!ex.upstreamDone) ex.outcome = 'upstream_error';
        ex.reason ??= 'unfinished';
      }
      ex.entryDone = true;
      ex.upstreamDone = true;
    }
    for (const c of this.conns) c.raw.destroy();
    for (const u of this.upstreams.values()) {
      u.live?.destroy();
      u.session?.then(
        (s) => s.destroy(),
        () => {},
      );
    }
    await closed;
    return this.record();
  }

  private record(): ScrapeRecording {
    const bodies = new Map<string, Buffer>();
    const entries: ScrapeCassetteEntry[] = this.exchanges.map((ex) => {
      let body_sha256: string | null = null;
      let body_bytes: number | null = null;
      if (ex.chunks !== null && ex.bodyWhole) {
        const decoded = decodeBody(Buffer.concat(ex.chunks), ex.content_encoding);
        if (decoded !== null) {
          body_sha256 = createHash('sha256').update(decoded).digest('hex');
          body_bytes = decoded.length;
          if (!bodies.has(body_sha256)) bodies.set(body_sha256, decoded);
        }
      }
      return {
        seq: ex.seq,
        t_us: ex.t_us,
        connection: ex.conn.id,
        sni: ex.conn.sni!,
        alpn: ex.conn.alpn,
        method: ex.method,
        authority: ex.authority,
        path: ex.path,
        route: ex.route,
        outcome: ex.outcome,
        reason: ex.reason,
        status: ex.status,
        headers: ex.headers,
        content_encoding: ex.content_encoding,
        body_sha256,
        body_bytes,
        wire_bytes: ex.wire_bytes,
      };
    });
    const connections: ScrapeCassetteConnection[] = this.conns.map((c) => ({
      id: c.id,
      t_us: c.t_us,
      sni: c.sni,
      alpn: c.alpn,
      bytes_up: c.bytes_up,
      bytes_down: c.bytes_down,
      refused: c.refused,
    }));
    return { cassette: { format: SCRAPE_CASSETTE_FORMAT, entries, connections, totals: cassetteTotals(entries, connections) }, bodies };
  }

  trace(): ScrapeGatewayTrace {
    return {
      ready_ns: this.t0,
      connections: this.conns.map((c) => ({ id: c.id, sni: c.sni, hello_ns: c.hello_ns, secure_ns: c.secure_ns })),
      upstreams: [...this.upstreams.values()].map((u) => ({ host: u.host, dial_ns: u.dial_ns, connect_ns: u.connect_ns, error: u.error })),
    };
  }

  // ------------------------------------------------------------ upstream

  /** The host's one session for the trial: dialled on the first call, the same promise after. */
  openUpstream(u: UpstreamHost): Promise<ClientHttp2Session> {
    if (u.session === null) {
      u.dial_ns = this.now();
      u.session = this.dial(u).then(
        (s) => {
          u.connect_ns = this.now();
          u.live = s;
          if (this.stopping) s.destroy();
          return s;
        },
        (err: Error) => {
          u.error = err.message;
          throw err;
        },
      );
      u.session.catch(() => {});
    }
    return u.session;
  }

  private async dial(u: UpstreamHost): Promise<ClientHttp2Session> {
    const failures: string[] = [];
    for (const ip of this.cfg.hosts[u.host]!.ips) {
      if (this.stopping) break;
      try {
        return await this.sessionOn(u.host, await this.connectTls(u.host, ip));
      } catch (err) {
        failures.push(`${ip}: ${(err as Error).message}`);
      }
    }
    throw new ScrapeGatewayError(`cannot reach ${u.host} (${failures.join('; ') || 'stopped'})`);
  }

  private connectTls(host: string, ip: string): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const options: ConnectionOptions = {
        host: ip,
        port: this.cfg.upstream_port,
        servername: host,
        ALPNProtocols: ['h2'],
        minVersion: 'TLSv1.2',
        lookup: refuseLookup as unknown as ConnectionOptions['lookup'],
      };
      if (this.cfg.upstream_ca !== null) options.ca = this.cfg.upstream_ca;
      const socket = tlsConnect(options);
      socket.setNoDelay(true);
      const timer = setTimeout(() => socket.destroy(new ScrapeGatewayError(`no TLS session within ${UPSTREAM_CONNECT_TIMEOUT_MS} ms`)), UPSTREAM_CONNECT_TIMEOUT_MS);
      const failed = (err: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      socket.once('error', failed);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        socket.off('error', failed);
        socket.on('error', () => {});
        if (socket.alpnProtocol !== 'h2') {
          socket.destroy();
          reject(new ScrapeGatewayError(`it negotiated ${JSON.stringify(socket.alpnProtocol)}, not h2`));
          return;
        }
        resolve(socket);
      });
    });
  }

  private sessionOn(host: string, socket: TLSSocket): Promise<ClientHttp2Session> {
    const port = this.cfg.upstream_port;
    const authority = port === 443 ? host : `${host}:${port}`;
    const session = h2connect(`https://${authority}`, {
      createConnection: () => socket,
      settings: { enablePush: false, initialWindowSize: UPSTREAM_WINDOW_BYTES },
    });
    return new Promise((resolve, reject) => {
      const failed = (err: Error): void => {
        session.destroy();
        reject(err);
      };
      session.once('error', failed);
      session.once('connect', () => {
        session.off('error', failed);
        session.on('error', () => {});
        try {
          session.setLocalWindowSize(UPSTREAM_WINDOW_BYTES * 4);
        } catch {
          // A session already closing keeps its window.
        }
        resolve(session);
      });
    });
  }

  // ------------------------------------------------------------ connections

  private makeSlot(): Slot {
    const slot: Slot = { server: null as unknown as Http2SecureServer, conn: null };
    const server = createSecureServer({
      allowHTTP1: true,
      ticketKeys: this.ticketKeys,
      minVersion: 'TLSv1.2',
      SNICallback: (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => {
        const conn = slot.conn;
        const ctx = conn !== null && conn.sni !== null && servername.toLowerCase() === conn.sni ? this.contexts.get(conn.sni) : undefined;
        if (ctx === undefined) cb(new ScrapeGatewayError(`no certificate for ${servername}`));
        else cb(null, ctx);
      },
    });
    server.on('secureConnection', (socket: TLSSocket) => {
      const conn = slot.conn;
      if (conn === null) return;
      conn.secure_ns = this.now();
      conn.alpn = typeof socket.alpnProtocol === 'string' ? socket.alpnProtocol : null;
    });
    server.on('request', (req: unknown, res: unknown) => {
      if (slot.conn !== null) this.onRequest(slot.conn, req as EntryRequest, res as EntryResponse);
    });
    // CONNECT: over HTTP/2 the compatibility API's (request, response); over HTTP/1.1 (request, socket, head).
    server.on('connect', (req: unknown, second: unknown) => {
      if (slot.conn === null) return;
      if (typeof (second as EntryResponse).writeHead === 'function') this.onRequest(slot.conn, req as EntryRequest, second as EntryResponse);
      else this.onH1Connect(slot.conn, req as EntryRequest, second as Duplex);
    });
    server.on('sessionError', () => {});
    server.on('tlsClientError', () => {});
    server.on('clientError', (_err: Error, socket: Duplex) => socket.destroy());
    server.on('unknownProtocol', (socket: Duplex) => socket.destroy());
    slot.server = server;
    return slot;
  }

  private accept(raw: Socket): void {
    raw.on('error', () => {});
    if (this.stopping) {
      raw.destroy();
      return;
    }
    const n = this.conns.length;
    if (n >= this.cfg.max_connections) {
      if (n < this.cfg.max_connections + MAX_LISTED_REFUSED_CONNECTIONS) this.conns.push(this.newConn(raw, 'max_connections'));
      raw.destroy();
      return;
    }
    const conn = this.newConn(raw, null);
    this.conns.push(conn);
    let hello: Buffer | null = Buffer.alloc(0);
    raw.on('data', (chunk: Buffer) => {
      if (conn.refused !== null) return;
      conn.bytes_up += chunk.length;
      this.bytesUp += chunk.length;
      if (this.bytesUp > this.cfg.max_bytes_up) {
        this.refuse(conn, 'max_bytes_up');
        return;
      }
      if (hello === null) {
        if (!conn.meter!.push(chunk)) raw.pause();
        return;
      }
      hello = Buffer.concat([hello, chunk]);
      const read = readClientHello(hello);
      if (read.kind === 'more') return;
      if (read.kind === 'refused') {
        this.refuse(conn, read.reason, read.reason === 'bad_client_hello' ? ALERT_DECODE_ERROR : undefined);
        return;
      }
      conn.hello_ns = this.now();
      if (read.sni === null) {
        this.refuse(conn, 'no_sni', ALERT_UNRECOGNIZED_NAME);
        return;
      }
      conn.sni = read.sni;
      const upstream = this.upstreams.get(read.sni);
      if (upstream === undefined) {
        this.refuse(conn, 'unknown_sni', ALERT_UNRECOGNIZED_NAME);
        return;
      }
      // 'cold': the entry's first ClientHello for this host dials it, before TLS answers the entry.
      this.openUpstream(upstream).catch(() => {});
      const first = hello;
      hello = null;
      this.startTls(conn, first);
    });
    raw.on('end', () => conn.meter?.push(null));
    raw.on('close', () => conn.meter?.destroy());
  }

  private newConn(raw: Socket, refused: string | null): Conn {
    return { id: this.conns.length, t_us: this.tUs(), sni: null, alpn: null, bytes_up: 0, bytes_down: 0, refused, raw, meter: null, hello_ns: null, secure_ns: null };
  }

  private startTls(conn: Conn, first: Buffer): void {
    const slot = this.spare ?? this.makeSlot();
    this.spare = null;
    slot.conn = conn;
    const meter = new Meter(conn, this);
    meter.on('error', () => {});
    conn.meter = meter;
    slot.server.emit('connection', meter);
    meter.push(first);
    // The next connection's server, built off this one's critical path.
    setImmediate(() => {
      if (!this.stopping && this.spare === null) this.spare = this.makeSlot();
    });
  }

  /** Count `n` bytes to the entry on `conn`: false, and the connection destroyed, when they pass max_bytes_down. */
  countDown(conn: Conn, n: number): boolean {
    if (conn.refused !== null) return false;
    if (this.bytesDown + n > this.cfg.max_bytes_down) {
      this.refuse(conn, 'max_bytes_down');
      return false;
    }
    conn.bytes_down += n;
    this.bytesDown += n;
    return true;
  }

  /** Refuse a connection: say why on it, send `alert` first when TLS has not started, and destroy it. */
  private refuse(conn: Conn, reason: string, alert?: number): void {
    if (conn.refused !== null) return;
    conn.refused = reason;
    const record = alert === undefined ? null : tlsAlert(alert);
    if (record !== null && conn.meter === null && this.bytesDown + record.length <= this.cfg.max_bytes_down) {
      conn.bytes_down += record.length;
      this.bytesDown += record.length;
      conn.raw.end(record);
      setTimeout(() => conn.raw.destroy(), 1000).unref();
    } else {
      conn.raw.destroy();
    }
    conn.meter?.destroy();
  }

  // ------------------------------------------------------------ requests

  private newExchange(conn: Conn, req: EntryRequest): Exchange | null {
    if (this.stopping) return null;
    if (this.exchanges.length >= MAX_ENTRIES) {
      this.refuse(conn, 'max_entries');
      return null;
    }
    const h2 = req.httpVersionMajor === 2;
    const ex: Exchange = {
      seq: this.exchanges.length,
      t_us: this.tUs(),
      conn,
      method: req.method ?? headerText(req.headers[':method']) ?? '',
      authority: h2 ? (headerText(req.headers[':authority']) ?? headerText(req.headers.host)) : headerText(req.headers.host),
      path: h2 ? headerText(req.headers[':path']) : (req.url ?? null),
      route: null,
      outcome: 'forwarded',
      reason: null,
      status: null,
      headers: {},
      content_encoding: null,
      chunks: null,
      bodyWhole: false,
      wire_bytes: 0,
      upstreamDone: false,
      entryDone: false,
      sentEnd: false,
      inFlight: false,
    };
    this.exchanges.push(ex);
    return ex;
  }

  /** The route a request may take, or why it may not (a refused_route reason). */
  private routeFor(conn: Conn, ex: Exchange, req: EntryRequest): ScrapeRoute | string {
    if (ex.authority === null || ex.authority === '') return 'no_authority';
    if (req.httpVersionMajor === 2) {
      const a = headerText(req.headers[':authority']);
      const h = headerText(req.headers.host);
      if (a !== null && h !== null && a.toLowerCase() !== h.toLowerCase()) return 'authority_mismatch';
    }
    const m = /^([^:[\]\s]+)(?::(\d{1,5}))?$/.exec(ex.authority);
    if (m === null) return 'bad_authority';
    const host = m[1]!.toLowerCase();
    if (m[2] !== undefined && Number(m[2]) !== 443 && Number(m[2]) !== this.port) return 'bad_authority';
    if (!Object.hasOwn(this.cfg.hosts, host)) return 'unknown_authority';
    if (host !== conn.sni) return 'authority_mismatch';
    const target = ex.path;
    if (target === null || !target.startsWith('/')) return 'not_a_route';
    const q = target.indexOf('?');
    const pathname = q < 0 ? target : target.slice(0, q);
    const onPath = this.cfg.routes.filter((r) => r.host === host && r.path === pathname);
    if (onPath.length === 0) return 'not_a_route';
    const byMethod = onPath.filter((r) => r.method === ex.method);
    if (byMethod.length === 0) return 'method_not_allowed';
    const params = new URLSearchParams(q < 0 ? '' : target.slice(q + 1));
    const route = byMethod.find((r) =>
      Object.entries(r.query).every(([k, v]) => {
        const got = params.getAll(k);
        return got.length === 1 && got[0] === v;
      }),
    );
    return route ?? 'missing_query';
  }

  private onRequest(conn: Conn, req: EntryRequest, res: EntryResponse): void {
    // A request body is never forwarded: drain it. An entry's stream failing is its close, never a crash.
    req.on?.('error', () => {});
    req.resume?.();
    res.on('error', () => {});
    const ex = this.newExchange(conn, req);
    if (ex === null) return;
    res.on('close', () => this.entryClosed(ex));
    const route = this.routeFor(conn, ex, req);
    if (typeof route === 'string') {
      this.answer(ex, res, 'refused_route', 403, route);
      return;
    }
    ex.route = route.id;
    if (this.routeCounts.get(route.id)! >= this.cfg.request_caps[route.id]!) {
      this.answer(ex, res, 'refused_cap', 429, 'request_cap');
      return;
    }
    if (this.inFlight >= this.cfg.max_concurrent) {
      this.answer(ex, res, 'refused_cap', 429, 'max_concurrent');
      return;
    }
    this.routeCounts.set(route.id, this.routeCounts.get(route.id)! + 1);
    this.inFlight++;
    ex.inFlight = true;
    const port = this.cfg.upstream_port;
    const outgoing: Record<string, string | string[]> = {
      ...upstreamRequestHeaders(req.headers, this.cfg.user_agent),
      ':method': ex.method,
      ':scheme': 'https',
      ':authority': port === 443 ? route.host : `${route.host}:${port}`,
      ':path': ex.path!,
    };
    this.openUpstream(this.upstreams.get(route.host)!).then(
      (session) => this.forward(ex, res, session, outgoing),
      () => this.upstreamFailed(ex, res, 'upstream_unavailable'),
    );
  }

  private onH1Connect(conn: Conn, req: EntryRequest, socket: Duplex): void {
    socket.on('error', () => {});
    const ex = this.newExchange(conn, req);
    if (ex === null) {
      socket.destroy();
      return;
    }
    const route = this.routeFor(conn, ex, req);
    const reason = typeof route === 'string' ? route : 'method_not_allowed';
    const body = Buffer.from(JSON.stringify({ error: reason }));
    ex.outcome = 'refused_route';
    ex.reason = reason;
    ex.status = 403;
    ex.wire_bytes = body.length;
    ex.upstreamDone = true;
    ex.entryDone = true;
    ex.sentEnd = true;
    socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`), body]));
  }

  /** Answer the entry without the upstream (a refusal): the outcome, the status and the JSON reason. */
  private answer(ex: Exchange, res: EntryResponse, outcome: ScrapeOutcome, status: number, reason: string): void {
    ex.outcome = outcome;
    ex.reason = reason;
    ex.upstreamDone = true;
    this.reply(ex, res, status, reason);
  }

  private reply(ex: Exchange, res: EntryResponse, status: number, reason: string): void {
    if (ex.entryDone || res.headersSent) return;
    const body = Buffer.from(JSON.stringify({ error: reason }));
    try {
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' });
      ex.status = status;
      ex.wire_bytes = body.length;
      ex.sentEnd = true;
      res.end(body);
    } catch {
      // The entry's stream went away under us.
    }
  }

  private upstreamFailed(ex: Exchange, res: EntryResponse, reason: string): void {
    if (ex.upstreamDone) return;
    ex.upstreamDone = true;
    ex.outcome = 'upstream_error';
    ex.reason = reason;
    if (ex.status === null) this.reply(ex, res, 502, reason);
    else if (!ex.entryDone) this.abortEntry(res);
  }

  private forward(ex: Exchange, res: EntryResponse, session: ClientHttp2Session, outgoing: Record<string, string | string[]>): void {
    if (ex.upstreamDone) return;
    // Sent even when the entry has already left, as a direct request it had written would have been.
    let stream: ClientHttp2Stream;
    try {
      stream = session.request(outgoing, { endStream: true });
    } catch (err) {
      if (BAD_HEADER_CODES.has((err as NodeJS.ErrnoException).code ?? '')) {
        this.routeCounts.set(ex.route!, this.routeCounts.get(ex.route!)! - 1);
        this.release(ex);
        this.answer(ex, res, 'refused_route', 403, 'bad_header');
      } else {
        this.upstreamFailed(ex, res, 'upstream_unavailable');
      }
      return;
    }
    stream.on('response', (h: IncomingHttpHeaders) => {
      if (ex.upstreamDone) return;
      const status = Number(h[':status']);
      ex.chunks = [];
      ex.headers = recordedHeaders(h);
      ex.content_encoding = headerText(h['content-encoding'])?.trim().toLowerCase() || null;
      if (status === 429 || status >= 500) {
        ex.outcome = 'upstream_error';
        ex.reason = 'upstream_status';
      }
      if (ex.entryDone) return;
      try {
        res.writeHead(status, forwardedResponseHeaders(h));
        ex.status = status;
      } catch {
        ex.outcome = 'upstream_error';
        ex.reason = 'bad_upstream_header';
        this.abortEntry(res);
      }
    });
    stream.on('data', (chunk: Buffer) => {
      if (ex.upstreamDone || ex.chunks === null) return;
      ex.chunks.push(chunk);
      if (ex.entryDone || ex.status === null) return;
      ex.wire_bytes += chunk.length;
      if (!res.write(chunk)) {
        stream.pause();
        res.once('drain', () => stream.resume());
      }
    });
    stream.on('end', () => {
      if (ex.upstreamDone) return;
      ex.upstreamDone = true;
      ex.bodyWhole = ex.chunks !== null;
      if (!ex.entryDone && ex.status !== null) {
        ex.sentEnd = true;
        res.end();
      }
    });
    stream.on('error', () => {});
    stream.on('close', () => {
      if (!ex.upstreamDone) this.upstreamFailed(ex, res, 'upstream_reset');
    });
    // An entry that leaves mid-response no longer drains it: read the rest for the record.
    res.on('close', () => stream.resume());
  }

  private abortEntry(res: EntryResponse): void {
    try {
      if (res.stream !== undefined) res.stream.close(h2constants.NGHTTP2_INTERNAL_ERROR);
      else res.destroy?.();
    } catch {
      // Already gone.
    }
  }

  private release(ex: Exchange): void {
    if (!ex.inFlight) return;
    ex.inFlight = false;
    this.inFlight--;
  }

  private entryClosed(ex: Exchange): void {
    this.release(ex);
    if (ex.entryDone) return;
    ex.entryDone = true;
    if (!ex.sentEnd) ex.reason ??= ex.conn.refused ?? 'entry_aborted';
  }
}

/** A gateway for `cfg` (as parseScrapeGatewayConfig returns it): start() it, then stop() it for the record. */
export function createScrapeGateway(cfg: ScrapeGatewayConfig): ScrapeGateway {
  return new Gateway(cfg);
}
