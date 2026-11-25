// Content-addressed blob store on the local disk: a blob's name is the lowercase hex sha256 of its
// bytes, stored at <root>/<first two hex chars>/<sha256> (default root .data/blobs, BLOB_DIR), or as
// its zstd variant <root>/<first two hex chars>/<sha256>.zst: the same name (the sha256 of the PLAIN
// bytes), the bytes compressed. Readers never see which form a blob is kept in.
//
//   put(bytes | string)     store and return {sha256, size, created} (compress: true keeps it as its .zst)
//   putStream(stream)       the same for a stream (hashed while written, never buffered whole)
//   stageStream(stream)     the same, hashed into a StagedBlob left in tmp/ until commit() or discard():
//                           for a caller that may still refuse what it read (server/routes/submissions.ts)
//   putFile(path)           putStream of a file on disk
//   get(sha256)             the plain bytes, or null when absent (verify: true re-hashes and throws on rot)
//   head(sha256)            {sha256, size: the plain size}, or null when absent
//   has(sha256)             boolean
//   openRead(sha256)        a read stream of the plain bytes (throws BlobNotFoundError when absent)
//   remove(sha256)          unlink both forms; whether anything went
//   compressInPlace(sha256) turn a stored plain blob into its .zst (the backfill's primitive; see below)
//   pathOf(sha256)          the absolute path of the plain form (whether or not it exists)
//   compressedPathOf(sha)   the same for the .zst form: pathOf(sha) + '.zst'
//
// The .zst form: one zstd frame (level 3, windowLog 24, long-distance matching, content checksum; a reader accepts up
// to windowLog 27, what earlier releases wrote) whose header always carries the plain size (Frame_Content_Size: the
// compressor is pledged the size, so head() answers from the first 18 bytes). Only a writer that asks for it
// (PutOptions.compress, compressInPlace) makes one: transcript blobs. Everything else stays plain, for the readers of
// pathOf() (git, kits, entry links): a plain put always leaves the plain file there, even when the same bytes are
// already kept as a .zst (a transcript blob equal to a pack source, an upload, a bundle), writing it beside the .zst,
// which stays. The empty blob is always plain. zstd runs through node:zlib's async API only, on the libuv pool, never a
// *Sync call on the event loop.
//
// Readers try the plain file first, then the .zst: a blob being compressed in place has its .zst renamed in, synced and
// read back verified before its plain file is unlinked, so a reader finds one form or the other at every moment. A
// zero-length plain file under a name that is not the empty blob's (a power loss's leftover, below) gives way to a .zst
// beside it. A .zst that does not decompress is a BlobCorruptError for get() and the stream's error for openRead().
//
// No call holds the event loop for a whole large blob: put() and the stream puts hash and write a chunk over
// HASH_SLICE_BYTES a slice at a time, put() encodes a large string a piece at a time, and get(verify) hashes the bytes it
// read a slice at a time, a turn of the loop between slices (a ~200 MB upload is ~50 of them).
//
// Writes go to <root>/tmp/ first and are renamed into place once the digest is known, so a reader
// never sees a partial blob and concurrent writers of the same content converge on one file. A write
// that finds its bytes already stored in a form it takes (a compressing write either form, a plain write only the plain
// file) sets that file's time to now (unless refresh: false), so a deleter sparing recently written blobs
// (server/profile/avatar.ts) spares it; one deleted meanwhile is stored anew. A compressing write never compresses bytes
// already stored plain.
//
// A power loss leaves a blob whole or absent: a new blob's bytes are forced to disk before the rename and
// its directory after it (one data sync and one directory sync a NEW blob, none for one already stored;
// production's app node went down at 2026-11-14 01:04Z with neither, and 774 blobs kept their names over
// no bytes). And a file under a blob's name counts as that blob only at the size of the bytes being stored
// (the name is their hash, so no file is hashed on the write path): a plain file of that size, or (for a compressing
// write) a .zst whose header names that size. Any other, a zero-length one above all, is replaced by the bytes in hand
// through the same rename and answered created: true, so the store heals as its blobs are written again; the other form, when it is not the blob,
// is unlinked before the rename (a wrong plain file would shadow the .zst for every reader). A store made with
// { durable: false } (a throwaway scratch store, never one whose blobs are kept) skips both syncs and keeps the rest.
// A source that fails (a path putFile cannot open, a stream that errors before it is read) rejects the
// put with its error and leaves no temp file; it never surfaces as an uncaught exception.
// Stored blobs are read-only (0444), in both forms. A name that is not 64 lowercase hex chars is refused before
// any path is built, so a caller cannot reach outside the store through a crafted digest.
// The grader and the gateway forwarder (whose bundle inlines this file) keep runs and cassettes
// here, so this file is a harness source (grader/version.ts HARNESS_SOURCES): any change to it
// names a new harness_version.

import { createHash, randomBytes, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { type FileHandle, mkdir, open, readFile, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { constants as zlibConstants, createZstdCompress, createZstdDecompress, type ZstdOptions } from 'node:zlib';

export const SHA256_RE = /^[0-9a-f]{64}$/;

/** The sha256 of no bytes: the one name a zero-length file is the whole blob of (never compressed). */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The suffix of a blob's zstd form (compressedPathOf). */
export const ZSTD_SUFFIX = '.zst';

/**
 * The most bytes hashed (and handed to the temp file) in one go: a larger chunk (put()'s whole buffer, a stream's big
 * chunk) and a verified get() are hashed this many bytes at a time with a turn of the event loop between, so storing or
 * reading back a ~200 MB upload never holds the loop for one sha256 pass over all of it (~2-3 ms a slice). The digest
 * and the bytes stored are the same however they are cut.
 */
export const HASH_SLICE_BYTES = 4 * 1024 * 1024;

/** A string past this many UTF-16 code units is encoded a piece at a time (utf8Pieces) by put(), not in one Buffer.from. */
const STRING_PIECE_UNITS = 1024 * 1024;

/**
 * The compressor's window: 2^24 = 16 MiB, long-distance matching finding repeats within it. Measured for #124 on
 * transcripts, windowLog 24 against 27 costs ~3% in size and cuts the compressor's memory from ~166 MB to ~48 MB, and
 * every decode of a frame written here holds a 16 MiB window, not up to 128 MiB (a decoder allocates the window its
 * frame's header names).
 */
const ZSTD_WINDOW_LOG = 24;

/**
 * The largest window a reader accepts (ZSTD_d_windowLogMax): 2^27 = 128 MiB, the window releases before this one wrote
 * (windowLog 27), so a .zst any of them made still reads. A ceiling, never an allocation: a frame written at
 * ZSTD_WINDOW_LOG decodes in its own 16 MiB.
 */
const ZSTD_READ_WINDOW_LOG_MAX = 27;

/** Output chunk of the zstd streams: an fs read stream's own 64 KiB, not zlib's 16 KiB (four times the callbacks). */
const ZSTD_CHUNK_BYTES = 64 * 1024;

/** The longest zstd frame header: magic 4, descriptor 1, window 1, dictionary id 4, content size 8. */
const ZSTD_HEADER_MAX = 18;
const ZSTD_MAGIC = 0xfd2fb528;

/** The compressor's options for `size` plain bytes: pledged, so the frame header names the size. */
function zstdWriteOptions(size: number): ZstdOptions {
  return {
    chunkSize: ZSTD_CHUNK_BYTES,
    pledgedSrcSize: size,
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: 3,
      [zlibConstants.ZSTD_c_windowLog]: ZSTD_WINDOW_LOG,
      [zlibConstants.ZSTD_c_enableLongDistanceMatching]: 1,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
    },
  };
}

const ZSTD_READ_OPTIONS: ZstdOptions = { chunkSize: ZSTD_CHUNK_BYTES, params: { [zlibConstants.ZSTD_d_windowLogMax]: ZSTD_READ_WINDOW_LOG_MAX } };

export interface BlobInfo {
  sha256: string;
  /** The plain size, whichever form the blob is kept in. */
  size: number;
}
export interface PutResult extends BlobInfo {
  /**
   * False when the put found its bytes already stored in a form it takes: either form for a compressing put, the plain
   * file for a plain one. True when it wrote a file, a plain put's plain file beside a .zst of the same blob included.
   */
  created: boolean;
}
export interface PutOptions {
  /**
   * False: a blob already stored keeps its file time. Only for a writer whose rows naming the blob commit under the lock
   * its deleter takes (setAvatar, server/profile/avatar.ts).
   */
  refresh?: boolean;
  /**
   * True: a NEW blob is kept as its .zst (compressedPathOf), not plain. A blob already stored stays as it is, plain or
   * not, and the empty blob is always plain. Only for blobs nothing reads by pathOf() (transcript blobs). Absent or
   * false: the put ends with the plain file at pathOf(), whatever .zst of the same bytes is there (it stays).
   */
  compress?: boolean;
}

/** compressInPlace's answer: the plain and compressed sizes, or why nothing was done. */
export type CompressInPlaceResult =
  | { before: number; after: number }
  | {
      /**
       * already: no plain file, a .zst there; absent: neither; corrupt: the plain file does not hash to its name (left
       * as it is); empty: the empty blob, always plain.
       */
      skipped: 'already' | 'absent' | 'corrupt' | 'empty';
    };

export class InvalidBlobNameError extends Error {
  constructor(name: string) {
    super(`not a sha256 blob name: ${JSON.stringify(name.slice(0, 80))}`);
    this.name = 'InvalidBlobNameError';
  }
}

export class BlobNotFoundError extends Error {
  readonly sha256: string;
  constructor(sha256: string) {
    super(`blob not found: ${sha256}`);
    this.name = 'BlobNotFoundError';
    this.sha256 = sha256;
  }
}

export class BlobCorruptError extends Error {
  readonly sha256: string;
  /** The sha256 the stored bytes hash to, or, for a .zst that does not decompress, `zstd: <why>`. */
  readonly actual: string;
  constructor(sha256: string, actual: string) {
    super(SHA256_RE.test(actual) ? `blob ${sha256} hashes to ${actual}` : `blob ${sha256} does not read back: ${actual}`);
    this.name = 'BlobCorruptError';
    this.sha256 = sha256;
    this.actual = actual;
  }
}

/** Lowercase hex sha256 of bytes or a UTF-8 string. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256Hex of bytes, HASH_SLICE_BYTES at a time with a turn of the event loop between: the same digest. */
export async function sha256HexYielding(bytes: Uint8Array): Promise<string> {
  const hash = createHash('sha256');
  for (let at = 0; at < bytes.byteLength; at += HASH_SLICE_BYTES) {
    if (at > 0) await nextTurn();
    hash.update(bytes.subarray(at, at + HASH_SLICE_BYTES));
  }
  return hash.digest('hex');
}

/**
 * A string's UTF-8 bytes, as Buffer.from(s, 'utf8') gives them, in pieces of at most STRING_PIECE_UNITS code units, so
 * a large one is encoded a piece at a time as it is stored. A piece never ends between the two halves of a surrogate
 * pair: a high surrogate ending one is left for the next, so each piece encodes as its part of the whole does (a lone
 * surrogate, at an edge or not, is the same lone one there, U+FFFD's bytes either way).
 */
function* utf8Pieces(s: string): Generator<Buffer> {
  for (let at = 0; at < s.length; ) {
    let end = Math.min(s.length, at + STRING_PIECE_UNITS);
    if (end < s.length && end - 1 > at) {
      const last = s.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
    }
    yield Buffer.from(s.slice(at, end), 'utf8');
    at = end;
  }
}

export interface BlobStoreOptions {
  /**
   * False for a throwaway store whose blobs nobody keeps past a power loss (a snapshot's scratch store,
   * server/repos/fetch.ts): a new blob skips its data and directory syncs. Everything else is the same (temp
   * file and rename, the size check, read-only blobs). Default true.
   */
  durable?: boolean;
}

export class BlobStore {
  readonly root: string;
  /** Whether a new blob is synced, file then directory, before its put answers (BlobStoreOptions.durable). */
  readonly durable: boolean;
  readonly #tmp: string;

  constructor(root: string, opts: BlobStoreOptions = {}) {
    this.root = resolve(root);
    this.durable = opts.durable !== false;
    this.#tmp = join(this.root, 'tmp');
  }

  /** The absolute path of a blob's plain form (validated name; the file may not exist). */
  pathOf(sha256: string): string {
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) throw new InvalidBlobNameError(String(sha256));
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  /** The absolute path of a blob's zstd form: pathOf(sha256) + '.zst' (the file may not exist). */
  compressedPathOf(sha256: string): string {
    return this.pathOf(sha256) + ZSTD_SUFFIX;
  }

  async put(data: Uint8Array | string, opts?: PutOptions): Promise<PutResult> {
    // A large string is encoded a piece at a time as it is written; bytes go whole, stageStream hashing them in slices.
    if (typeof data === 'string' && data.length > STRING_PIECE_UNITS) return this.putStream(Readable.from(utf8Pieces(data)), opts);
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    return this.putStream(Readable.from([Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]), opts);
  }

  async putFile(path: string, opts?: PutOptions): Promise<PutResult> {
    // Opened before the store is touched: a path that will not open rejects this call with its own error.
    const file = await open(path, 'r');
    try {
      return await this.putStream(file.createReadStream(), opts);
    } finally {
      await file.close(); // a no-op once the stream has closed it
    }
  }

  async putStream(source: Readable | AsyncIterable<Uint8Array>, opts: PutOptions = {}): Promise<PutResult> {
    return (await this.stageStream(source)).commit(opts);
  }

  /**
   * Stream `source` into a file of the store's tmp directory, hashed as it is written (never buffered
   * whole), and return it as a StagedBlob: the bytes are in the store's hands but no reader sees a blob
   * until commit(). A caller that refuses what it read discards it instead, so a refused upload leaves
   * nothing in the store.
   */
  async stageStream(source: Readable | AsyncIterable<Uint8Array>): Promise<StagedBlob> {
    // pipeline() listens for a stream's errors only once the temp dir is made. One that fails sooner (a file stream
    // whose open fails, an upload cut off) would emit 'error' to no listener, an uncaught exception that ends the
    // process: its error is held here and rejects this call instead, and an unread stream is destroyed (its file
    // closed) when the call fails before pipeline() runs.
    const stream = source instanceof Readable ? source : null;
    const early: unknown[] = [];
    const hold = (err: unknown): void => void early.push(err);
    stream?.on('error', hold);
    try {
      await mkdir(this.#tmp, { recursive: true });
      if (early.length > 0) throw early[0];
    } catch (err) {
      stream?.destroy(); // `hold` stays on: anything its teardown emits has a listener
      throw err;
    }
    stream?.off('error', hold); // nothing is awaited from here to pipeline(), whose own listener takes over
    const tmp = tempPathIn(this.#tmp, '.part');
    const hash = createHash('sha256');
    let size = 0;
    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Uint8Array | string>) {
          for await (const chunk of chunks) {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
            if (buf.byteLength <= HASH_SLICE_BYTES) {
              hash.update(buf);
              size += buf.byteLength;
              yield buf;
              continue;
            }
            // A large chunk is hashed and written a slice at a time, a turn of the event loop between (HASH_SLICE_BYTES).
            for (let at = 0; at < buf.byteLength; at += HASH_SLICE_BYTES) {
              if (at > 0) await nextTurn();
              const slice = buf.subarray(at, at + HASH_SLICE_BYTES);
              hash.update(slice);
              size += slice.byteLength;
              yield slice;
            }
          }
        },
        createWriteStream(tmp, { flags: 'wx', mode: 0o600 }),
      );
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return new StagedBlob(this, tmp, hash.digest('hex'), size);
  }

  async get(sha256: string, opts: { verify?: boolean } = {}): Promise<Buffer | null> {
    const path = this.pathOf(sha256);
    let bytes: Buffer | null = null;
    try {
      bytes = await readFile(path);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    // Absent plain (or compressed meanwhile: its .zst is in place before the plain file goes), or a zero-length leftover.
    if (bytes === null || (bytes.byteLength === 0 && sha256 !== EMPTY_SHA256)) bytes = (await readZst(this.compressedPathOf(sha256), sha256)) ?? bytes;
    if (bytes === null) return null;
    if (opts.verify) {
      const actual = await sha256HexYielding(bytes);
      if (actual !== sha256) throw new BlobCorruptError(sha256, actual);
    }
    return bytes;
  }

  async head(sha256: string): Promise<BlobInfo | null> {
    const size = await sizeOf(this.pathOf(sha256));
    if (size !== null && (size > 0 || sha256 === EMPTY_SHA256)) return { sha256, size };
    const packed = await zstSizeOf(this.compressedPathOf(sha256));
    if (packed !== null) return { sha256, size: packed };
    return size === null ? null : { sha256, size }; // a zero-length leftover with no .zst beside it: what is there
  }

  async has(sha256: string): Promise<boolean> {
    return (await this.head(sha256)) !== null;
  }

  /** A read stream over the blob's plain bytes (optionally one inclusive byte range, as fs.createReadStream takes it). */
  async openRead(sha256: string, range?: { start: number; end: number }): Promise<Readable> {
    const plain = await openFile(this.pathOf(sha256));
    if (plain !== null && (plain.size > 0 || sha256 === EMPTY_SHA256)) return plain.file.createReadStream(range);
    const packed = await openFile(this.compressedPathOf(sha256));
    if (packed !== null) {
      await plain?.file.close();
      return await unpackStream(packed.file, sha256, range);
    }
    if (plain !== null) return plain.file.createReadStream(range); // a zero-length leftover with no .zst beside it
    throw new BlobNotFoundError(sha256);
  }

  /**
   * Unlink the blob in both forms (one absent is no error) and, when anything went, sync its directory. Whether a file
   * was removed.
   */
  async remove(sha256: string): Promise<boolean> {
    const removed = [await unlinkIfThere(this.pathOf(sha256)), await unlinkIfThere(this.compressedPathOf(sha256))].includes(true);
    if (removed && this.durable) await syncDir(join(this.root, sha256.slice(0, 2)));
    return removed;
  }

  /**
   * Turn a stored plain blob into its .zst, for a backfill: the plain file is read once, hashed (it must hash to its name)
   * and compressed into tmp/; the compressed file is sealed (0444, synced), renamed to compressedPathOf(), its directory
   * synced, then read back, decompressed and hashed (it must be the blob); only then is the plain file unlinked and the
   * directory synced again. A reader trying plain then .zst finds the blob at every step, and a crash at any step leaves
   * the plain file (and maybe a .zst beside it). A call finding a .zst beside the plain file (such a crash, or a racing
   * call) keeps it if it reads back as the blob, else compresses afresh over it. Answers the plain and compressed sizes,
   * or why nothing was done (CompressInPlaceResult).
   */
  async compressInPlace(sha256: string): Promise<CompressInPlaceResult> {
    const plainPath = this.pathOf(sha256);
    const packedPath = this.compressedPathOf(sha256);
    const plain = await openFile(plainPath);
    if (plain === null) return { skipped: (await isFile(packedPath)) ? 'already' : 'absent' };
    const dir = join(this.root, sha256.slice(0, 2));
    const durable = this.durable;
    let tmp: string | null = null;
    try {
      const before = plain.size;
      if (before === 0) return { skipped: sha256 === EMPTY_SHA256 ? 'empty' : 'corrupt' };
      if (!(await zstHolds(packedPath, sha256))) {
        await mkdir(this.#tmp, { recursive: true });
        tmp = tempPathIn(this.#tmp, '.zst.part');
        const hash = createHash('sha256');
        await pipeline(
          plain.file.createReadStream({ autoClose: false }),
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              hash.update(chunk);
              yield chunk;
            }
          },
          createZstdCompress(zstdWriteOptions(before)),
          createWriteStream(tmp, { flags: 'wx', mode: 0o600 }),
        );
        if (hash.digest('hex') !== sha256) return { skipped: 'corrupt' };
        await seal(tmp, durable);
        await rename(tmp, packedPath);
        tmp = null;
        if (durable) await syncDir(dir);
        if (!(await zstHolds(packedPath, sha256))) {
          await unlinkIfThere(packedPath);
          throw new Error(`blob ${sha256}: its new .zst does not read back as the blob; the plain file is kept`);
        }
      }
      const after = (await stat(packedPath)).size;
      await unlinkIfThere(plainPath);
      if (durable) await syncDir(dir);
      return { before, after };
    } finally {
      await plain.file.close();
      if (tmp !== null) await rm(tmp, { force: true });
    }
  }
}

/**
 * A stream put into the store's tmp directory (BlobStore.stageStream): its digest and size known, and
 * no blob a reader can see until commit(). Its temp file holds its bytes (mode 0600) until then.
 */
export class StagedBlob implements BlobInfo {
  readonly store: BlobStore;
  /** The part's file under the store's tmp/ directory; removed by commit() and discard() alike. */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  #settled = false;

  constructor(store: BlobStore, path: string, sha256: string, size: number) {
    this.store = store;
    this.path = path;
    this.sha256 = sha256;
    this.size = size;
  }

  /** Whether its file is no longer the caller's to commit or discard (commit() ran). */
  get settled(): boolean {
    return this.#settled;
  }

  /**
   * Put the staged bytes in place as their blob, as putStream ends: a blob already stored in a form this put takes (a
   * plain file under its name of this size, or, for compress: true, a .zst whose header names this size) has that file's
   * time renewed (unless refresh: false) and is answered created: false; anything else under its name is replaced.
   * compress: true keeps a new non-empty blob as its .zst. A plain put always ends with the plain file there, for the
   * readers of pathOf(): one finding only a .zst of the blob writes the plain file beside it (the .zst stays; readers take
   * the plain file first) and answers created: true. A new file is on disk, bytes and name, when this answers (see the
   * header). A failed put rejects and leaves no temp file. Only the caller that staged it may commit it, once.
   */
  async commit(opts: PutOptions = {}): Promise<PutResult> {
    if (this.#settled) throw new Error(`staged blob ${this.sha256} is already settled`);
    this.#settled = true;
    const plainPath = this.store.pathOf(this.sha256);
    const packedPath = this.store.compressedPathOf(this.sha256);
    const found = { sha256: this.sha256, size: this.size, created: false };
    let packing: string | null = null;
    try {
      const plainSize = await sizeOf(plainPath);
      if (plainSize === this.size && (opts.refresh === false || (await touch(plainPath)))) {
        await rm(this.path, { force: true });
        return found;
      }
      const compress = opts.compress === true && this.size > 0;
      const packed = await zstHeaderOf(packedPath);
      // Only a compressing put is answered by the .zst: a plain one's caller may read pathOf(), so it writes the plain file.
      if (compress && packed === this.size && (opts.refresh === false || (await touch(packedPath)))) {
        // A plain file of another size would shadow the .zst for every reader: it goes.
        if (plainSize !== null && plainSize !== this.size) await unlinkIfThere(plainPath);
        await rm(this.path, { force: true });
        return found;
      }
      const dir = join(this.store.root, this.sha256.slice(0, 2));
      const made = await mkdir(dir, { recursive: true });
      const durable = this.store.durable;
      if (compress) {
        packing = tempPathIn(join(this.store.root, 'tmp'), '.zst.part');
        await pipeline(
          createReadStream(this.path),
          createZstdCompress(zstdWriteOptions(this.size)),
          createWriteStream(packing, { flags: 'wx', mode: 0o600 }),
        );
        await rm(this.path, { force: true });
        await seal(packing, durable);
        // Whatever plain file is there is not this blob (or went meanwhile): gone before the .zst comes, never shadowing it.
        if (plainSize !== null) await unlinkIfThere(plainPath);
        await rename(packing, packedPath);
        packing = null;
      } else {
        await seal(this.path, durable);
        // A .zst there that is not this blob goes before the plain file comes (one rename, one sync); one that is stays
        // beside it, the plain file read first.
        if (packed !== undefined && packed !== this.size) await unlinkIfThere(packedPath);
        await rename(this.path, plainPath);
      }
      if (durable) {
        await syncDir(dir);
        if (made !== undefined) await syncDir(this.store.root); // the fan-out directory's own name is new
      }
      return { ...found, created: true };
    } catch (err) {
      await rm(this.path, { force: true });
      if (packing !== null) await rm(packing, { force: true });
      throw err;
    }
  }

  /** Remove the staged file: the bytes were refused, or are no longer needed (a no-op once committed). */
  async discard(): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    await rm(this.path, { force: true });
  }
}

/**
 * The plain size a zstd frame header names (Frame_Content_Size), 'absent' when a well-formed header names none, 'bad'
 * when `head` (a file's first ZSTD_HEADER_MAX bytes, or all of a shorter one) is no zstd frame header.
 */
export function zstdContentSize(head: Uint8Array): number | 'absent' | 'bad' {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (bytes.byteLength < 5 || bytes.readUInt32LE(0) !== ZSTD_MAGIC) return 'bad';
  const descriptor = bytes[4]!;
  if ((descriptor & 0x08) !== 0) return 'bad'; // the reserved bit
  const singleSegment = (descriptor & 0x20) !== 0;
  const fcsFlag = descriptor >> 6;
  const at = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 0x03]!;
  const width = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]!;
  if (width === 0) return 'absent';
  if (bytes.byteLength < at + width) return 'bad';
  if (width === 1) return bytes[at]!;
  if (width === 2) return bytes.readUInt16LE(at) + 256;
  if (width === 4) return bytes.readUInt32LE(at);
  const big = bytes.readBigUInt64LE(at);
  return big > BigInt(Number.MAX_SAFE_INTEGER) ? 'bad' : Number(big);
}

/** A .zst's header verdict: the size it names, null when it names none or is no header, undefined when no file is there. */
async function zstHeaderOf(path: string): Promise<number | null | undefined> {
  const head = await readHead(path);
  if (head === null) return undefined;
  const size = zstdContentSize(head);
  return typeof size === 'number' ? size : null;
}

/**
 * The plain size of the .zst at `path`, from its header, or (a frame naming none) by decompressing and counting; null
 * when no file is there or it is no zstd frame.
 */
async function zstSizeOf(path: string): Promise<number | null> {
  const head = await readHead(path);
  if (head === null) return null;
  const size = zstdContentSize(head);
  if (typeof size === 'number') return size;
  if (size === 'bad') return null;
  let count = 0;
  try {
    await pipeline(createReadStream(path), createZstdDecompress(ZSTD_READ_OPTIONS), async (chunks: AsyncIterable<Buffer>) => {
      for await (const chunk of chunks) count += chunk.byteLength;
    });
  } catch (err) {
    if (isMissing(err) || isZstdError(err)) return null;
    throw err;
  }
  return count;
}

/** The first ZSTD_HEADER_MAX bytes of the file at `path`; null when no file is there. */
async function readHead(path: string): Promise<Buffer | null> {
  const opened = await openFile(path);
  if (opened === null) return null;
  try {
    const buf = Buffer.alloc(ZSTD_HEADER_MAX);
    const { bytesRead } = await opened.file.read(buf, 0, ZSTD_HEADER_MAX, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await opened.file.close();
  }
}

/**
 * The plain bytes of the .zst at `path` (blob `sha256`), decompressed off the event loop into one buffer of the size its
 * header names (no concatenation pass); null when no file is there. A frame that does not decompress, or not to that
 * size, is a BlobCorruptError.
 */
async function readZst(path: string, sha256: string): Promise<Buffer | null> {
  const opened = await openFile(path);
  if (opened === null) return null;
  const { file } = opened;
  try {
    const head = Buffer.alloc(ZSTD_HEADER_MAX);
    const { bytesRead } = await file.read(head, 0, ZSTD_HEADER_MAX, 0);
    const size = zstdContentSize(head.subarray(0, bytesRead));
    if (size === 'bad') throw new BlobCorruptError(sha256, 'zstd: no frame header');
    const chunks: Buffer[] = [];
    const whole = typeof size === 'number' ? Buffer.allocUnsafe(size) : null;
    let at = 0;
    try {
      await pipeline(file.createReadStream({ start: 0, autoClose: false }), createZstdDecompress(ZSTD_READ_OPTIONS), async (out: AsyncIterable<Buffer>) => {
        for await (const chunk of out) {
          if (whole === null) chunks.push(chunk);
          else if (at + chunk.byteLength > whole.byteLength) throw new BlobCorruptError(sha256, 'zstd: more bytes than its header names');
          else chunk.copy(whole, at);
          at += chunk.byteLength;
        }
      });
    } catch (err) {
      if (isZstdError(err)) throw new BlobCorruptError(sha256, `zstd: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      throw err;
    }
    if (whole === null) return Buffer.concat(chunks, at);
    if (at !== whole.byteLength) throw new BlobCorruptError(sha256, 'zstd: fewer bytes than its header names');
    return whole;
  } finally {
    await file.close();
  }
}

/** Whether the file at `path` is a .zst decompressing to bytes that hash to `sha256` (false when absent or undecodable). */
async function zstHolds(path: string, sha256: string): Promise<boolean> {
  const hash: Hash = createHash('sha256');
  try {
    await pipeline(createReadStream(path), createZstdDecompress(ZSTD_READ_OPTIONS), async (chunks: AsyncIterable<Buffer>) => {
      for await (const chunk of chunks) hash.update(chunk);
    });
  } catch (err) {
    if (isMissing(err) || isZstdError(err)) return false;
    throw err;
  }
  return hash.digest('hex') === sha256;
}

/**
 * The plain bytes of an opened .zst as a byte stream, optionally one inclusive range of them ({start, end}, as
 * fs.createReadStream takes it). Its file is closed when the stream ends or is destroyed; a frame that does not
 * decompress, or (read to its end) not to the size its header names, errors the stream with a BlobCorruptError (node's
 * decoder ends quietly on a frame cut short).
 */
async function unpackStream(file: FileHandle, sha256: string, range?: { start: number; end: number }): Promise<Readable> {
  let named: number | 'absent' | 'bad';
  try {
    const head = Buffer.alloc(ZSTD_HEADER_MAX);
    const { bytesRead } = await file.read(head, 0, ZSTD_HEADER_MAX, 0);
    named = zstdContentSize(head.subarray(0, bytesRead));
  } catch (err) {
    await file.close();
    throw err;
  }
  const source: ReadStream = file.createReadStream({ start: 0 });
  const unpack = createZstdDecompress(ZSTD_READ_OPTIONS);
  source.on('error', (err) => unpack.destroy(err));
  source.pipe(unpack);
  async function* slice(): AsyncGenerator<Buffer> {
    if (named === 'bad') throw new BlobCorruptError(sha256, 'zstd: no frame header');
    /** Plain bytes decoded so far. */
    let at = 0;
    try {
      for await (const chunk of unpack as AsyncIterable<Buffer>) {
        const from = range === undefined ? 0 : Math.max(0, range.start - at);
        const to = range === undefined ? chunk.byteLength : Math.min(chunk.byteLength, range.end - at + 1);
        at += chunk.byteLength;
        if (typeof named === 'number' && at > named) throw new BlobCorruptError(sha256, 'zstd: more bytes than its header names');
        if (to > from) yield to - from === chunk.byteLength ? chunk : chunk.subarray(from, to);
        if (range !== undefined && at > range.end) return; // the rest is never decompressed
      }
    } catch (err) {
      if (isZstdError(err)) throw new BlobCorruptError(sha256, `zstd: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      throw err;
    }
    if (typeof named === 'number' && at !== named) throw new BlobCorruptError(sha256, 'zstd: fewer bytes than its header names');
  }
  const out = Readable.from(slice(), { objectMode: false });
  out.once('close', () => {
    unpack.destroy();
    source.destroy(); // closes the file
  });
  return out;
}

/** A fresh name in the store's tmp/ directory `tmp` (made by the caller). */
function tempPathIn(tmp: string, suffix: string): string {
  return join(tmp, `${process.pid}-${randomBytes(8).toString('hex')}${suffix}`);
}

/** A regular file opened for reading, with its size; null when none is there. */
async function openFile(path: string): Promise<{ file: FileHandle; size: number } | null> {
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  try {
    const s = await file.stat();
    if (s.isFile()) return { file, size: s.size };
  } catch (err) {
    await file.close();
    throw err;
  }
  await file.close();
  return null;
}

/** Set a stored blob's file time to now; false when it is not there (never stored, or deleted meanwhile). */
async function touch(path: string): Promise<boolean> {
  const now = new Date();
  try {
    await utimes(path, now, now);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function isFile(path: string): Promise<boolean> {
  return (await sizeOf(path)) !== null;
}

/** The size of the file at `path`; null when no file is there. */
async function sizeOf(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Unlink `path`; false when nothing was there. */
async function unlinkIfThere(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/**
 * Make a staged file read-only and (when `sync`) force its bytes and mode to disk: renamed after this, it is a whole
 * blob through a power loss.
 */
async function seal(path: string, sync: boolean): Promise<void> {
  const file = await open(path, 'r+');
  try {
    await file.chmod(0o444);
    if (sync) await file.sync();
  } finally {
    await file.close();
  }
}

/**
 * Force a directory's entries to disk, so a name just renamed into it survives a power loss. Nothing to force where a
 * directory has no sync: Windows opens none, and a filesystem without one answers EINVAL or ENOTSUP. Any other failure
 * is thrown.
 */
async function syncDir(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = await open(path, 'r');
  try {
    await dir.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw err;
  } finally {
    await dir.close();
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** A zstd decoder's refusal (node:zlib names its codes ZSTD_error_*): the frame is damaged, not the disk. */
function isZstdError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code.startsWith('ZSTD_error');
}
