// One trial's model requests as the forwarder keyed them (agent-fun/requests/v1): the request side the cassette keeps
// only a hash of. Each cassette entry's request_key is the sha256 of the canonical JSON of {route, headers, body}, masked
// (cassette.ts requestKey); this log keeps those exact bytes, so every line verifies itself against its key and the
// cassette entry of its seq. It is what an export reads for a trial's tool definitions, system prompt and sampling
// settings (ATIF agent.tool_definitions), and nothing replay, scoring or any digest reads.
//
//   format        one zstd frame (level 3, windowLog 24, long-distance matching, content checksum: what
//                 server/blobstore.ts writes its .zst with) of NDJSON, one line per cassette entry in seq order
//                 (0, 1, 2, ... with no gap, as many lines as the cassette has entries), each line canonical JSON
//                 (sim/canonical.ts) ending in "\n":
//                   {"keyed":<K>,"request_key":<key>,"seq":<n>}                       a keyed request
//                   {"keyed":null,"request_key":<key>,"seq":<n>,"withheld":"secret"}  its bytes held back (below)
//                   {"keyed":null,"request_key":null,"seq":<n>}                       an unkeyed refusal (no JSON body)
//                 K is the canonical JSON of {route, headers, body} the key hashes: sha256(K) === request_key, byte
//                 for byte, K being the very string the key was taken of. headers holds the keyed headers alone
//                 (KEYED_HEADERS), body the parsed JSON body (null on `models`), both with the request mask applied
//                 (an entrant's env-lane entry secrets as SECRET_MARK). A line is withheld when K, masked as it is,
//                 still holds a form of a secret the forwarder masks out of answers (the trial's masq key, an
//                 entrant's provider keys and the ids their pre-flight learned): K cannot be masked further without
//                 breaking its key, so it is not kept at all. The blob is stored under the sha256 of the compressed
//                 bytes (a plain blob of the store: requests_sha256 names it).
//   writer        RequestLogWriter: append() at a request's arrival, synchronously and in seq order (the cassette
//                 writer's begin()), streaming each line into the compressor, so the forwarder never holds a trial's
//                 bodies: only the compressed stream, capped at REQUEST_LOG_MAX_BYTES (past it the log is dropped).
//                 zstd runs on node:zlib's async API, on the libuv pool, never on the event loop. finish() stores
//                 the blob. A log that fails (the compressor, the cap, the store) is a fault of the log alone: the
//                 cassette and the trial never wait on it or fail for it (cassette.ts CassetteWriter.finish).
//   reader        readRequestLog / requestLines: each line parsed and checked (canonical, seq in order, sha256 of K
//                 its request_key); verifyRequestLog: the lines against the cassette they were recorded with;
//                 toolDefinitions: the distinct `tools` entries across the trial (deduplicated by canonical JSON), on
//                 Anthropic Messages, OpenAI Chat Completions and OpenAI Responses bodies alike.

import * as zlib from 'node:zlib';
import type { CassetteT } from '../../contracts/agent.ts';
import { canonicalJson, sha256Hex } from '../../sim/canonical.ts';
import type { CassetteBlobs, CassetteRouteT } from './cassette.ts';

export const REQUEST_LOG_FORMAT = 'agent-fun/requests/v1';
/** The compressed log's cap: past it the log is dropped (requests_sha256 null), the trial unaffected. */
export const REQUEST_LOG_MAX_BYTES = 64 * 1024 * 1024;
/** Why a line's bytes are not kept (see the header). */
export const WITHHELD_SECRET = 'secret';

const SHA256_RE = /^[0-9a-f]{64}$/;
// A namespace import, read at run time: a Node without zstd (before 22.15) still loads the forwarder, and its log fails alone.
const zstd = zlib as unknown as {
  createZstdCompress?: (opts: object) => zlib.ZstdCompress;
  createZstdDecompress?: (opts: object) => zlib.ZstdDecompress;
};
const C = zlib.constants as Record<string, number>;
const ZSTD_CHUNK_BYTES = 64 * 1024;
/** What a reader accepts: the window releases of server/blobstore.ts read up to. */
const ZSTD_READ_WINDOW_LOG_MAX = 27;

export class RequestLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestLogError';
  }
}

/** What a request contributes to the log at its arrival. */
export interface RequestLogLine {
  seq: number;
  request_key: string | null;
  /** The canonical JSON the key is the sha256 of (cassette.ts KeyedRequest.keyed_json); null with no key or withheld. */
  keyed: string | null;
  /** True when its bytes still hold a secret's form (see the header). */
  withheld?: boolean;
}

/** A stored log: the blob's name and its measures. */
export interface WrittenRequests {
  sha256: string;
  /** Lines: the cassette's entries. */
  requests: number;
  /** The NDJSON's size before compression. */
  plain_bytes: number;
  /** The blob's size. */
  bytes: number;
  /** Lines withheld for a secret's form. */
  withheld: number;
}

/**
 * Streams one trial's request lines into a zstd frame (see the header). append() is synchronous and never throws on the
 * log's own account: a failure is kept and finish() rejects with it.
 */
export class RequestLogWriter {
  readonly #z: zlib.ZstdCompress | null;
  readonly #max: number;
  readonly #out: Buffer[] = [];
  readonly #ended: Promise<void>;
  #outBytes = 0;
  #plainBytes = 0;
  #lines = 0;
  #withheld = 0;
  #fault: string | null = null;
  #closed = false;

  constructor(opts: { maxBytes?: number } = {}) {
    this.#max = opts.maxBytes ?? REQUEST_LOG_MAX_BYTES;
    let z: zlib.ZstdCompress | null = null;
    try {
      if (typeof zstd.createZstdCompress !== 'function') throw new Error('this Node has no zstd');
      z = zstd.createZstdCompress({
        chunkSize: ZSTD_CHUNK_BYTES,
        params: { [C.ZSTD_c_compressionLevel!]: 3, [C.ZSTD_c_windowLog!]: 24, [C.ZSTD_c_enableLongDistanceMatching!]: 1, [C.ZSTD_c_checksumFlag!]: 1 },
      });
    } catch (err) {
      this.#fault = `no compressor: ${(err as Error).message}`;
    }
    this.#z = z;
    if (z === null) {
      this.#ended = Promise.resolve();
      return;
    }
    this.#ended = new Promise<void>((resolve) => {
      z.on('end', resolve);
      z.on('close', resolve);
      z.on('error', (err: Error) => {
        this.#fail(`the compressor failed: ${err.message}`);
        resolve();
      });
    });
    z.on('data', (chunk: Buffer) => {
      if (this.#fault !== null) return;
      this.#outBytes += chunk.byteLength;
      if (this.#outBytes > this.#max) {
        this.#fail(`the request log ran past its cap of ${this.#max} compressed bytes`);
        return;
      }
      this.#out.push(chunk);
    });
  }

  /** Lines appended so far. */
  get lines(): number {
    return this.#lines;
  }

  /** Why the log failed, or null while it holds. */
  get fault(): string | null {
    return this.#fault;
  }

  #fail(why: string): void {
    if (this.#fault !== null) return;
    this.#fault = why;
    this.#out.length = 0;
    this.#z?.destroy();
  }

  /** One request's line, at its arrival: seq must be the next (lines so far). */
  append(line: RequestLogLine): void {
    if (this.#closed) {
      this.#fail('a line was appended after the log was finished');
      return;
    }
    if (this.#fault !== null) {
      this.#lines++;
      return;
    }
    if (line.seq !== this.#lines) {
      this.#fail(`line ${line.seq} arrived where line ${this.#lines} was due`);
      return;
    }
    if (line.request_key !== null && !SHA256_RE.test(line.request_key)) {
      this.#fail(`line ${line.seq}'s request_key is not a sha256`);
      return;
    }
    this.#lines++;
    const key = line.request_key === null ? 'null' : `"${line.request_key}"`;
    const withheld = line.request_key !== null && line.withheld === true;
    const keyed = line.request_key === null || withheld ? null : line.keyed;
    if (line.request_key !== null && !withheld && keyed === null) {
      this.#fail(`line ${line.seq} is keyed but carries no keyed bytes`);
      return;
    }
    if (withheld) this.#withheld++;
    // Three writes, so a large K is never copied into one more string; the line is canonical (keys in code-unit order).
    const head = '{"keyed":';
    const tail = `,"request_key":${key},"seq":${line.seq}${withheld ? `,"withheld":"${WITHHELD_SECRET}"` : ''}}\n`;
    const z = this.#z!;
    z.write(head);
    z.write(keyed ?? 'null');
    z.write(tail);
    this.#plainBytes += head.length + Buffer.byteLength(keyed ?? 'null', 'utf8') + tail.length;
  }

  /** Stop the log without storing it (a replay that diverged, a trial whose cassette is not written). */
  abandon(why = 'the log was abandoned'): void {
    this.#closed = true;
    this.#fail(why);
  }

  /**
   * End the frame and store it: `expected` lines (the cassette's entries) must have been appended. Rejects with
   * RequestLogError on any failure of the log's; nothing else depends on it.
   */
  async finish(blobs: Pick<CassetteBlobs, 'put'>, expected: number): Promise<WrittenRequests> {
    if (this.#closed && this.#fault === null) throw new RequestLogError('the request log is already finished');
    this.#closed = true;
    if (this.#fault === null && this.#lines !== expected) this.#fail(`the log holds ${this.#lines} lines, the cassette ${expected} entries`);
    if (this.#fault === null) this.#z!.end();
    await this.#ended;
    if (this.#fault !== null) throw new RequestLogError(this.#fault);
    const bytes = Buffer.concat(this.#out, this.#outBytes);
    this.#out.length = 0;
    const sha256 = sha256Hex(bytes);
    let stored: { sha256: string };
    try {
      stored = await blobs.put(bytes);
    } catch (err) {
      throw new RequestLogError(`the blob store refused the request log: ${(err as Error).message}`);
    }
    if (stored.sha256 !== sha256) throw new RequestLogError(`the blob store named the request log ${stored.sha256}, not its sha256 ${sha256}`);
    return { sha256, requests: this.#lines, plain_bytes: this.#plainBytes, bytes: bytes.byteLength, withheld: this.#withheld };
  }
}

/**
 * Lines that may arrive out of seq order (a replay: each request's line under the seq of the entry it consumed, parallel
 * calls arriving in another order than live) put back in order before the writer: each held until every earlier seq is
 * in. The writer sees seq order, so a replay's log is the live log's lines.
 */
export class ReorderedRequestLog {
  readonly writer: RequestLogWriter;
  readonly #held = new Map<number, RequestLogLine>();

  constructor(writer: RequestLogWriter) {
    this.writer = writer;
  }

  /** Lines held for an earlier seq still out. */
  get held(): number {
    return this.#held.size;
  }

  add(line: RequestLogLine): void {
    if (line.seq < this.writer.lines || this.#held.has(line.seq)) {
      this.writer.abandon(`line ${line.seq} arrived twice`);
      return;
    }
    this.#held.set(line.seq, line);
    for (let next = this.#held.get(this.writer.lines); next !== undefined; next = this.#held.get(this.writer.lines)) {
      this.#held.delete(next.seq);
      this.writer.append(next);
    }
  }
}

// ------------------------------------------------------------------ reader

/** A line of the log, parsed: `keyed` its {route, headers, body}, null where the line keeps none. */
export interface RequestRecord {
  seq: number;
  request_key: string | null;
  route: CassetteRouteT | null;
  headers: Record<string, string> | null;
  /** The request's parsed JSON body as keyed (masked); null on `models` and where none is kept. */
  body: unknown;
  withheld: boolean;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** One NDJSON line (no newline) checked and parsed: canonical, its seq `seq`, its K hashing to its request_key. */
export function parseRequestLine(text: string, seq: number): RequestRecord {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new RequestLogError(`line ${seq} is not JSON`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new RequestLogError(`line ${seq} is not an object`);
  const d = doc as Record<string, unknown>;
  let canonical: string;
  try {
    canonical = canonicalJson(d);
  } catch (err) {
    throw new RequestLogError(`line ${seq} is not canonical JSON: ${(err as Error).message}`);
  }
  if (canonical !== text) throw new RequestLogError(`line ${seq} is not canonical JSON`);
  const keys = Object.keys(d).sort().join(',');
  if (keys !== 'keyed,request_key,seq' && keys !== 'keyed,request_key,seq,withheld') throw new RequestLogError(`line ${seq} holds the fields ${keys}`);
  if (d.seq !== seq) throw new RequestLogError(`line ${seq} names seq ${JSON.stringify(d.seq)}`);
  const key = d.request_key;
  if (key !== null && (typeof key !== 'string' || !SHA256_RE.test(key))) throw new RequestLogError(`line ${seq}'s request_key is neither null nor a sha256`);
  const withheld = 'withheld' in d;
  if (withheld && (d.withheld !== WITHHELD_SECRET || key === null || d.keyed !== null)) throw new RequestLogError(`line ${seq} is withheld wrongly`);
  if (key === null || withheld) {
    if (d.keyed !== null) throw new RequestLogError(`line ${seq} keeps bytes it has no key for`);
    return { seq, request_key: key as string | null, route: null, headers: null, body: null, withheld };
  }
  const k = d.keyed;
  if (k === null || typeof k !== 'object' || Array.isArray(k)) throw new RequestLogError(`line ${seq} is keyed and keeps no {route, headers, body}`);
  const kk = k as Record<string, unknown>;
  if (Object.keys(kk).sort().join(',') !== 'body,headers,route') throw new RequestLogError(`line ${seq}'s keyed request is not {route, headers, body}`);
  if (sha256Hex(canonicalJson(kk)) !== key) throw new RequestLogError(`line ${seq}'s bytes do not hash to its request_key`);
  if (typeof kk.route !== 'string') throw new RequestLogError(`line ${seq}'s route is not a string`);
  const headers = kk.headers;
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers) || !Object.values(headers).every((v) => typeof v === 'string')) {
    throw new RequestLogError(`line ${seq}'s headers are not strings by name`);
  }
  return { seq, request_key: key as string, route: kk.route as CassetteRouteT, headers: headers as Record<string, string>, body: kk.body, withheld: false };
}

/**
 * Every line of a stored log (the blob's bytes), decompressed as a stream on the libuv pool and parsed one line at a
 * time (parseRequestLine): a reader of a large trial never holds its decompressed whole.
 */
export async function* requestLines(blob: Uint8Array): AsyncGenerator<RequestRecord> {
  if (typeof zstd.createZstdDecompress !== 'function') throw new RequestLogError('this Node has no zstd to read the request log with');
  const z = zstd.createZstdDecompress({ chunkSize: ZSTD_CHUNK_BYTES, params: { [C.ZSTD_d_windowLogMax!]: ZSTD_READ_WINDOW_LOG_MAX } });
  z.end(blob);
  let pending: Buffer[] = [];
  let seq = 0;
  const lineOf = (parts: Buffer[]): RequestRecord => {
    let text: string;
    try {
      text = UTF8.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts));
    } catch {
      throw new RequestLogError(`line ${seq} is not UTF-8`);
    }
    return parseRequestLine(text, seq++);
  };
  try {
    for await (const chunk of z as AsyncIterable<Buffer>) {
      let from = 0;
      for (let nl = chunk.indexOf(0x0a, from); nl !== -1; nl = chunk.indexOf(0x0a, from)) {
        pending.push(chunk.subarray(from, nl));
        const parts = pending;
        pending = [];
        from = nl + 1;
        yield lineOf(parts);
      }
      if (from < chunk.byteLength) pending.push(chunk.subarray(from));
    }
  } catch (err) {
    if (err instanceof RequestLogError) throw err;
    throw new RequestLogError(`the request log does not decompress: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  } finally {
    z.destroy();
  }
  if (pending.some((p) => p.byteLength > 0)) throw new RequestLogError(`line ${seq} has no closing newline`);
}

/** Every line of a stored log, in seq order (requestLines, gathered). */
export async function readRequestLog(blob: Uint8Array): Promise<RequestRecord[]> {
  const out: RequestRecord[] = [];
  for await (const r of requestLines(blob)) out.push(r);
  return out;
}

/** The lines against the cassette they were recorded with: one per entry, each with its entry's request_key and route. */
export function verifyRequestLog(lines: readonly RequestRecord[], cassette: Pick<CassetteT, 'entries'>): void {
  if (lines.length !== cassette.entries.length) throw new RequestLogError(`the log holds ${lines.length} lines, the cassette ${cassette.entries.length} entries`);
  lines.forEach((l, i) => {
    const e = cassette.entries[i]!;
    if (l.seq !== e.seq || l.request_key !== e.request_key) throw new RequestLogError(`line ${i} is not the request of cassette entry ${e.seq}`);
    if (l.route !== null && l.route !== e.route) throw new RequestLogError(`line ${i} is on ${l.route}, its cassette entry on ${e.route}`);
  });
}

/** One distinct tool definition of a trial. */
export interface ToolDefinition {
  /** The tool's name as its dialect spells it (Messages `name`, Chat `function.name`, Responses `name`), else its `type`; null when it names neither. */
  name: string | null;
  /** The route of the first request that sent it. */
  route: CassetteRouteT;
  /** The seq of the first request that sent it, and how many requests sent it. */
  first_seq: number;
  requests: number;
  /** The entry of `tools` as sent (masked as the request was keyed). */
  definition: Record<string, unknown>;
}

function toolName(route: CassetteRouteT, t: Record<string, unknown>): string | null {
  const fn = t.function;
  if (route === 'openai.chat' && fn !== null && typeof fn === 'object' && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === 'string') {
    return (fn as Record<string, unknown>).name as string;
  }
  if (typeof t.name === 'string') return t.name;
  return typeof t.type === 'string' ? t.type : null;
}

/**
 * The distinct `tools` entries a trial's requests sent, deduplicated by their canonical JSON, in the order each first
 * appeared: Anthropic Messages ({name, description, input_schema} and server tools by `type`), OpenAI Chat Completions
 * ({type: function, function: {name, description, parameters}}) and OpenAI Responses ({type: function, name,
 * parameters} and built-in tools by `type`) alike; a request with no `tools` list adds none.
 */
export function toolDefinitions(lines: Iterable<RequestRecord>): ToolDefinition[] {
  const seen = new Map<string, ToolDefinition>();
  for (const l of lines) {
    if (l.route === null || l.route === 'models' || l.body === null || typeof l.body !== 'object' || Array.isArray(l.body)) continue;
    const tools = (l.body as Record<string, unknown>).tools;
    if (!Array.isArray(tools)) continue;
    const inThis = new Set<string>();
    for (const t of tools) {
      if (t === null || typeof t !== 'object' || Array.isArray(t)) continue;
      const c = canonicalJson(t);
      if (inThis.has(c)) continue;
      inThis.add(c);
      const known = seen.get(c);
      if (known !== undefined) known.requests++;
      else seen.set(c, { name: toolName(l.route, t as Record<string, unknown>), route: l.route, first_seq: l.seq, requests: 1, definition: t as Record<string, unknown> });
    }
  }
  return [...seen.values()];
}
