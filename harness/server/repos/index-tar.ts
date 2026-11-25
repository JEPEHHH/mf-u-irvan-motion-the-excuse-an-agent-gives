// Index a `git archive` tar into the blob store, one blob per entry, without extracting anything:
//
//   regular file   its bytes -> a blob; recorded as kind `file` with the header's mode and size
//   symlink        its target TEXT -> a blob; recorded as kind `symlink`; never followed or resolved
//   directory      not recorded (implied by the paths under it)
//   hardlink, character/block device, FIFO, sparse or any other type -> refused (snapshot_rejected)
//
// Paths must be relative POSIX paths in valid UTF-8 with no empty, `.`, `..` or `.git` segments
// (an absolute path or any `..` is refused), no path may sit under a file or symlink, and no path
// may appear twice. ustar, pax (`path`, `linkpath`, `size`; global `comment` = the commit git
// archive wrote) and GNU long names are understood; header checksums are verified.
//
// The snapshot index is RFC 8785 canonical JSON through sim/canonical.ts (the one canonical form
// every digest uses: keys sorted, no whitespace), its files in order of the UTF-8 bytes of the path:
//
//   {"commit":"<sha>|null","files":[{"kind","mode","path","sha256","size"}...],"format":"agent-fun/snapshot/v1"}
//
// and is itself stored as a blob; its sha256 is the submission's snapshot_sha256.
//
// indexTarFile reads the tar in one pass, TAR_READ_BYTES at a time, checking every header, path and limit in tar order
// as it goes, and puts the entries' blobs INDEX_PUT_CONCURRENCY at once (each file's bytes or symlink's target, as one
// put after another stored them); the index is put last, alone, once every entry's blob is in. A refusal or a failed
// put rejects only once every put started has settled, with the error a put after another would have met first, and a
// failed put stops new ones. The index, its sha256, the blobs and the refusals are the same as reading one entry at a
// time (tests/unit/index-tar-concurrency.test.ts pins them).
//
// The one place a snapshot touches the host filesystem is materializeSnapshot(): a FRESH directory
// for the grader's read-only mount, written with O_EXCL creates under directories made here (never
// through a symlink), symlinks created as-is, then every file and directory made read-only.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm, symlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { z } from 'zod';
import { canonicalJson, CanonicalJsonError, canonicalSha256 } from '../../sim/canonical.ts';
import { BlobCorruptError, SHA256_RE, type BlobStore } from '../blobstore.ts';
import type { snapshotFile } from '../db/schema.ts';
import { RepoIntakeError } from './errors.ts';

export const SNAPSHOT_FORMAT = 'agent-fun/snapshot/v1';

export type SnapshotFileKind = 'file' | 'symlink';

export interface SnapshotEntry {
  /** Relative POSIX path from the repo root. */
  path: string;
  kind: SnapshotFileKind;
  /** Permission bits from the tar header (0o644, 0o755; 0o777 for symlinks). */
  mode: number;
  /** Bytes of the file, or of the symlink's target text. */
  size: number;
  /** The blob holding the file bytes or the target text. */
  sha256: string;
}

export interface SnapshotIndex {
  format: typeof SNAPSHOT_FORMAT;
  /** The commit `git archive` recorded (pax global comment), null for another tar. */
  commit: string | null;
  files: SnapshotEntry[];
}

export interface TarIndexLimits {
  /** Entries of every type, directories included. */
  maxEntries: number;
  maxFileBytes: number;
  /** Sum of regular file sizes. */
  maxTotalBytes: number;
}

export const DEFAULT_TAR_LIMITS: Readonly<TarIndexLimits> = Object.freeze({
  maxEntries: 100_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
});

const BLOCK = 512;
const MAX_PATH_BYTES = 4096;
const MAX_SEGMENT_BYTES = 255;
/** Largest pax / GNU long-name payload we read. */
const MAX_META_BYTES = 1024 * 1024;

export type SnapshotRejectReason =
  | 'hardlink'
  | 'device'
  | 'fifo'
  | 'unsupported_type'
  | 'absolute_path'
  | 'parent_path'
  | 'dot_path'
  | 'dotgit_path'
  | 'empty_path'
  | 'path_too_long'
  | 'invalid_utf8'
  | 'duplicate_path'
  | 'path_conflict'
  | 'empty_symlink_target'
  | 'too_many_entries'
  | 'file_too_large'
  | 'total_too_large'
  | 'bad_checksum'
  | 'bad_header'
  | 'bad_pax'
  | 'truncated'
  | 'commit_mismatch';

function rejectEntry(reason: SnapshotRejectReason, message: string, path: string | null = null): RepoIntakeError {
  return new RepoIntakeError('snapshot_rejected', message, { detail: { reason, path } });
}

// ---------------------------------------------------------------- paths

/**
 * Check a tar path and return it without a trailing `/` (directories). Throws snapshot_rejected.
 */
export function validateSnapshotPath(raw: string, opts: { directory?: boolean } = {}): string {
  let p = raw;
  if (opts.directory && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '') throw rejectEntry('empty_path', 'empty path in archive', raw);
  if (p.startsWith('/')) throw rejectEntry('absolute_path', `absolute path in archive: ${clip(raw)}`, raw);
  if (p.includes('\0')) throw rejectEntry('invalid_utf8', `NUL in archive path: ${clip(raw)}`, raw);
  // Only an index built in memory can carry one (a tar path is decoded as strict UTF-8): it has no
  // UTF-8 form, so it can neither be hashed nor written to disk under its own name.
  if (!p.isWellFormed()) throw rejectEntry('invalid_utf8', `lone surrogate in archive path: ${clip(raw.toWellFormed())}`, raw.toWellFormed());
  if (Buffer.byteLength(p, 'utf8') > MAX_PATH_BYTES) throw rejectEntry('path_too_long', `archive path longer than ${MAX_PATH_BYTES} bytes`, clip(raw));
  for (const seg of p.split('/')) {
    if (seg === '..') throw rejectEntry('parent_path', `\`..\` in archive path: ${clip(raw)}`, raw);
    if (seg === '' || seg === '.') throw rejectEntry('dot_path', `empty or \`.\` segment in archive path: ${clip(raw)}`, raw);
    if (seg.toLowerCase() === '.git') throw rejectEntry('dotgit_path', `\`.git\` in archive path: ${clip(raw)}`, raw);
    if (Buffer.byteLength(seg, 'utf8') > MAX_SEGMENT_BYTES) throw rejectEntry('path_too_long', `archive path segment longer than ${MAX_SEGMENT_BYTES} bytes`, clip(raw));
  }
  return p;
}

/** Tracks every path seen so duplicates and paths under a file or symlink are refused. */
class PathTree {
  readonly #nodes = new Map<string, 'dir' | SnapshotFileKind>();

  add(path: string, kind: 'dir' | SnapshotFileKind): void {
    let at = path.indexOf('/');
    while (at !== -1) {
      const anc = path.slice(0, at);
      const k = this.#nodes.get(anc);
      if (k === 'file' || k === 'symlink') throw rejectEntry('path_conflict', `${clip(path)} sits under ${clip(anc)}, which is a ${k}`, path);
      if (k === undefined) this.#nodes.set(anc, 'dir');
      at = path.indexOf('/', at + 1);
    }
    const existing = this.#nodes.get(path);
    if (existing !== undefined) {
      if (existing === 'dir' && kind === 'dir') return;
      throw rejectEntry(existing === kind ? 'duplicate_path' : 'path_conflict', `${clip(path)} appears twice in the archive`, path);
    }
    this.#nodes.set(path, kind);
  }
}

function clip(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function decodePath(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw rejectEntry('invalid_utf8', 'archive path is not valid UTF-8', bytes.toString('latin1').slice(0, 200));
  }
}

/** Order paths by their UTF-8 bytes (locale-free, the same everywhere). */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------- tar headers

function cstr(h: Buffer, off: number, len: number): Buffer {
  const f = h.subarray(off, off + len);
  const nul = f.indexOf(0);
  return nul === -1 ? f : f.subarray(0, nul);
}

function parseNumber(h: Buffer, off: number, len: number, what: string): number {
  const f = h.subarray(off, off + len);
  const first = f[0] as number;
  if (first & 0x80) {
    // base-256 (GNU / star): big-endian, positive only
    if (first === 0xff) throw rejectEntry('bad_header', `negative ${what} in tar header`);
    let v = BigInt(first & 0x7f);
    for (let i = 1; i < f.length; i++) v = (v << 8n) | BigInt(f[i] as number);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw rejectEntry('bad_header', `${what} too large in tar header`);
    return Number(v);
  }
  const s = f.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw rejectEntry('bad_header', `bad ${what} field in tar header`);
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n)) throw rejectEntry('bad_header', `${what} too large in tar header`);
  return n;
}

function verifyChecksum(h: Buffer, offset: number): void {
  const stored = parseNumber(h, 148, 8, 'checksum');
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : (h[i] as number);
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  if (stored !== unsigned && stored !== signed) throw rejectEntry('bad_checksum', `bad tar header checksum at byte ${offset}`);
}

function isZeroBlock(h: Buffer): boolean {
  for (let i = 0; i < BLOCK; i++) if (h[i] !== 0) return false;
  return true;
}

function ustarName(h: Buffer): Buffer {
  const name = cstr(h, 0, 100);
  const magic = h.subarray(257, 263).toString('latin1');
  if (magic === 'ustar\0') {
    const prefix = cstr(h, 345, 155);
    if (prefix.length > 0) return Buffer.concat([prefix, Buffer.from('/'), name]);
  }
  return name;
}

interface PaxState {
  path?: Buffer;
  linkpath?: Buffer;
  size?: number;
}

/** Parse pax records `<len> <key>=<value>\n`. */
function parsePax(data: Buffer, into: PaxState, global: { comment?: string } | null): void {
  let pos = 0;
  while (pos < data.length) {
    if (data[pos] === 0) break; // NUL padding after the last record
    const sp = data.indexOf(0x20, pos);
    if (sp === -1 || sp - pos > 20) throw rejectEntry('bad_pax', 'malformed pax record');
    const lenStr = data.toString('latin1', pos, sp);
    if (!/^[1-9][0-9]*$/.test(lenStr)) throw rejectEntry('bad_pax', 'malformed pax record length');
    const end = pos + Number(lenStr);
    if (end > data.length || end <= sp + 1 || data[end - 1] !== 0x0a) throw rejectEntry('bad_pax', 'pax record overruns its header');
    const rec = data.subarray(sp + 1, end - 1);
    const eq = rec.indexOf(0x3d);
    if (eq <= 0) throw rejectEntry('bad_pax', 'pax record without a key');
    const key = rec.toString('utf8', 0, eq);
    const value = rec.subarray(eq + 1);
    pos = end;
    if (key.startsWith('GNU.sparse.')) throw rejectEntry('unsupported_type', 'sparse files are not accepted');
    if (global) {
      if (key === 'comment') global.comment = value.toString('utf8');
      continue;
    }
    if (key === 'path') {
      if (value.length === 0) delete into.path;
      else into.path = Buffer.from(value);
    } else if (key === 'linkpath') {
      if (value.length === 0) delete into.linkpath;
      else into.linkpath = Buffer.from(value);
    } else if (key === 'size') {
      const s = value.toString('latin1');
      if (s === '') delete into.size;
      else if (!/^(0|[1-9][0-9]{0,15})$/.test(s) || !Number.isSafeInteger(Number(s))) throw rejectEntry('bad_pax', 'bad pax size');
      else into.size = Number(s);
    }
  }
}

/**
 * How many of a tar's entry blobs indexTarFile puts at once: server/repos/fetch.ts KEEP_PUT_CONCURRENCY's bound, for the
 * same reason. A put is a handful of event-loop turns (its temp file's open, write and close, the size check, the
 * rename) and on a loaded loop a turn waits behind every other job's (makefun-prod 2026-11-16: the snapshot job's index
 * stage 25 s on average, up to 52 s, one read and one put after another); twelve at once overlap those waits. The index
 * is the same: each entry's blob is the same bytes under the same name, and the index lists the entries as before.
 */
export const INDEX_PUT_CONCURRENCY = 12;

/**
 * How many bytes of the tar are read at a time: 1 MiB (fetch.ts KEEP_READ_BYTES). Headers, extended headers and every
 * file up to this size come out of the window last read (TarWindow), so a tar of small files is a read a megabyte, not
 * two reads an entry; a larger file is streamed into its blob this many bytes at a time. The bytes are the same however
 * the tar is cut.
 */
export const TAR_READ_BYTES = 1024 * 1024;

/**
 * The tar read TAR_READ_BYTES at a time (a longer extended header whole): what lies inside the window last read costs no
 * read of its own. bytes() answers a copy, never a view of the window, so a put still in flight never pins one; it is
 * short only where the file ends.
 */
class TarWindow {
  readonly #fh: FileHandle;
  readonly #fileSize: number;
  #at = 0;
  #buf: Buffer = Buffer.alloc(0);
  /** Reads made so far: each one a turn of the event loop. */
  fills = 0;

  constructor(fh: FileHandle, fileSize: number) {
    this.#fh = fh;
    this.#fileSize = fileSize;
  }

  async bytes(offset: number, length: number): Promise<Buffer> {
    if (offset < this.#at || offset + length > this.#at + this.#buf.length) await this.#fill(offset, length);
    const from = offset - this.#at;
    return Buffer.from(this.#buf.subarray(from, from + length));
  }

  async #fill(offset: number, length: number): Promise<void> {
    const buf = Buffer.alloc(Math.max(length, Math.min(TAR_READ_BYTES, this.#fileSize - offset)));
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await this.#fh.read(buf, got, buf.length - got, offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    this.#at = offset;
    this.#buf = buf.subarray(0, got);
    this.fills += 1;
  }
}

async function readAt(tar: TarWindow, offset: number, length: number): Promise<Buffer> {
  const buf = await tar.bytes(offset, length);
  if (buf.length < length) throw rejectEntry('truncated', 'archive ends inside an entry');
  return buf;
}

/** `size` bytes of the tar from `start`, TAR_READ_BYTES at a time; fewer only where the file ends. */
async function* tarSlices(fh: FileHandle, start: number, size: number): AsyncGenerator<Buffer> {
  for (let at = 0; at < size; ) {
    const buf = Buffer.alloc(Math.min(TAR_READ_BYTES, size - at));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start + at);
    if (bytesRead === 0) return;
    at += bytesRead;
    yield bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
  }
}

/**
 * The entry puts of one indexTarFile, at most INDEX_PUT_CONCURRENCY in flight, started in tar order by the one reader.
 * A put that fails stops new ones from starting (start() then starts nothing); settle() waits for every put started and
 * rejects with the failure earliest in the tar, the one a put after another would have met first. A put's failure is
 * held, never an unhandled rejection.
 */
class EntryPuts {
  #inFlight = 0;
  #wake: (() => void) | null = null;
  #failure: { at: number; err: unknown } | null = null;
  /** Waits for a lane so far: each one a turn of the event loop. */
  waits = 0;

  get failed(): boolean {
    return this.#failure !== null;
  }

  /** Start `put` (the entry at tar offset `at`) once a lane is free, unless a put has failed by then. */
  async start(at: number, put: () => Promise<void>): Promise<void> {
    while (this.#inFlight >= INDEX_PUT_CONCURRENCY && this.#failure === null) await this.#turn();
    if (this.#failure !== null) return;
    this.#inFlight += 1;
    void put()
      .then(undefined, (err: unknown) => {
        if (this.#failure === null || at < this.#failure.at) this.#failure = { at, err };
      })
      .finally(() => {
        this.#inFlight -= 1;
        const wake = this.#wake;
        this.#wake = null;
        wake?.();
      });
  }

  /** Every started put settled; rejects with the failure earliest in the tar, if any. */
  async settle(): Promise<void> {
    while (this.#inFlight > 0) await this.#turn();
    if (this.#failure !== null) throw this.#failure.err;
  }

  #turn(): Promise<void> {
    this.waits += 1;
    return new Promise((resolve) => {
      this.#wake = resolve;
    });
  }
}

/** The longest the reader runs on the event loop without a turn (a read or a wait for a lane counts as one). */
const READ_TURN_MS = 2;

const padded = (n: number) => Math.ceil(n / BLOCK) * BLOCK;

// ---------------------------------------------------------------- indexing

export interface IndexTarOptions extends Partial<TarIndexLimits> {
  /** Require the archive's pax global comment (git archive's commit id) to equal this sha. */
  expectCommit?: string;
}

export interface IndexedTar {
  index: SnapshotIndex;
  /** sha256 of the canonical index JSON (also its blob name). */
  snapshotSha256: string;
  /** Sum of regular file sizes. */
  totalBytes: number;
}

/** Index the tar at `tarPath` into `blobs` (one blob per entry plus the index blob). */
export async function indexTarFile(tarPath: string, blobs: BlobStore, opts: IndexTarOptions = {}): Promise<IndexedTar> {
  const limits: TarIndexLimits = {
    maxEntries: opts.maxEntries ?? DEFAULT_TAR_LIMITS.maxEntries,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_TAR_LIMITS.maxFileBytes,
    maxTotalBytes: opts.maxTotalBytes ?? DEFAULT_TAR_LIMITS.maxTotalBytes,
  };
  const fh = await open(tarPath, 'r');
  try {
    const fileSize = (await fh.stat()).size;
    const tar = new TarWindow(fh, fileSize);
    const puts = new EntryPuts();
    const tree = new PathTree();
    // Each recorded entry takes its slot in tar order; its put fills it once the blob is in.
    const slots: Array<SnapshotEntry | null> = [];
    const global: { comment?: string } = {};
    let pax: PaxState = {};
    let longName: Buffer | null = null;
    let longLink: Buffer | null = null;
    let entries = 0;
    let totalBytes = 0;
    let offset = 0;
    // A refusal the reader meets lies later in the tar than every put it started: those settle first, and one that
    // failed is the error, as one put after another would have met it first.
    let refusal: { err: unknown } | null = null;
    // Headers out of the window cost no read, so a run of entries with no put (directories, extended headers) would
    // hold the loop until the next read: past READ_TURN_MS with no turn taken, the reader takes one.
    let turnsSeen = 0;
    let ranSince = performance.now();

    try {
      for (;;) {
        if (puts.failed) break;
        if (tar.fills + puts.waits !== turnsSeen) {
          turnsSeen = tar.fills + puts.waits;
          ranSince = performance.now();
        } else if (performance.now() - ranSince >= READ_TURN_MS) {
          await nextTurn();
          ranSince = performance.now();
        }
        if (offset + BLOCK > fileSize) throw rejectEntry('truncated', 'archive ends without an end-of-archive block');
        const h = await readAt(tar, offset, BLOCK);
        if (isZeroBlock(h)) break;
        verifyChecksum(h, offset);
        const flag = h[156] === 0 ? '0' : String.fromCharCode(h[156] as number);
        const at = offset;
        const dataOffset = offset + BLOCK;
        let size = parseNumber(h, 124, 12, 'size');

        if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
          if (size > MAX_META_BYTES) throw rejectEntry('bad_pax', 'oversized extended header');
          if (dataOffset + padded(size) > fileSize) throw rejectEntry('truncated', 'archive ends inside an extended header');
          const data = await readAt(tar, dataOffset, size);
          if (flag === 'x') parsePax(data, pax, null);
          else if (flag === 'g') parsePax(data, {}, global);
          else if (flag === 'L') longName = cstr(data, 0, data.length);
          else longLink = cstr(data, 0, data.length);
          offset = dataOffset + padded(size);
          continue;
        }

        entries += 1;
        if (entries > limits.maxEntries) throw rejectEntry('too_many_entries', `archive has more than ${limits.maxEntries} entries`);
        if (pax.size !== undefined) size = pax.size;
        const nameBytes = pax.path ?? longName ?? ustarName(h);
        const linkBytes = pax.linkpath ?? longLink ?? cstr(h, 157, 100);
        pax = {};
        longName = null;
        longLink = null;
        if (dataOffset + padded(size) > fileSize) throw rejectEntry('truncated', 'archive ends inside an entry');
        const rawPath = decodePath(nameBytes);
        const mode = parseNumber(h, 100, 8, 'mode') & 0o7777;

        switch (flag) {
          case '0':
          case '7': {
            if (rawPath.endsWith('/') && size === 0) {
              tree.add(validateSnapshotPath(rawPath, { directory: true }), 'dir');
              break;
            }
            const path = validateSnapshotPath(rawPath);
            if (size > limits.maxFileBytes) throw rejectEntry('file_too_large', `${clip(path)} is larger than ${limits.maxFileBytes} bytes`, path);
            totalBytes += size;
            if (totalBytes > limits.maxTotalBytes) throw rejectEntry('total_too_large', `files total more than ${limits.maxTotalBytes} bytes`, path);
            tree.add(path, 'file');
            const slot = slots.push(null) - 1;
            // A file up to TAR_READ_BYTES comes out of the window (short only where the tar ends); a larger one is
            // streamed from the tar by its put.
            const bytes = size === 0 ? Buffer.alloc(0) : size <= TAR_READ_BYTES ? await tar.bytes(dataOffset, size) : null;
            await puts.start(at, async () => {
              const put = bytes !== null ? await blobs.put(bytes) : await blobs.putStream(tarSlices(fh, dataOffset, size));
              if (put.size !== size) throw rejectEntry('truncated', `${clip(path)}: read ${put.size} of ${size} bytes`, path);
              slots[slot] = { path, kind: 'file', mode, size, sha256: put.sha256 };
            });
            break;
          }
          case '5':
            tree.add(validateSnapshotPath(rawPath, { directory: true }), 'dir');
            break;
          case '2': {
            const path = validateSnapshotPath(rawPath);
            if (linkBytes.length === 0) throw rejectEntry('empty_symlink_target', `symlink ${clip(path)} has no target`, path);
            if (linkBytes.length > MAX_PATH_BYTES) throw rejectEntry('path_too_long', `symlink ${clip(path)} target is longer than ${MAX_PATH_BYTES} bytes`, path);
            if (linkBytes.includes(0)) throw rejectEntry('invalid_utf8', `symlink ${clip(path)} target contains NUL`, path);
            tree.add(path, 'symlink');
            const slot = slots.push(null) - 1;
            await puts.start(at, async () => {
              const put = await blobs.put(linkBytes);
              slots[slot] = { path, kind: 'symlink', mode, size: linkBytes.length, sha256: put.sha256 };
            });
            break;
          }
          case '1':
            throw rejectEntry('hardlink', `hardlink ${clip(rawPath)} is not accepted`, rawPath);
          case '3':
          case '4':
            throw rejectEntry('device', `device node ${clip(rawPath)} is not accepted`, rawPath);
          case '6':
            throw rejectEntry('fifo', `FIFO ${clip(rawPath)} is not accepted`, rawPath);
          default:
            throw rejectEntry('unsupported_type', `tar entry type ${JSON.stringify(flag)} (${clip(rawPath)}) is not accepted`, rawPath);
        }
        offset = dataOffset + padded(size);
      }
    } catch (err) {
      refusal = { err };
    }
    await puts.settle();
    if (refusal !== null) throw refusal.err;

    const commit = global.comment !== undefined && /^[0-9a-f]{40}$/.test(global.comment) ? global.comment : null;
    if (opts.expectCommit !== undefined && commit !== opts.expectCommit) {
      throw rejectEntry('commit_mismatch', `archive records commit ${commit ?? 'none'}, expected ${opts.expectCommit}`);
    }
    const files: SnapshotEntry[] = [];
    for (const f of slots) {
      if (f === null) throw new Error('indexTarFile: a put settled without filling its entry');
      files.push(f);
    }
    // The index alone, after every entry's blob is in: a reader that finds it finds every blob it names.
    const index: SnapshotIndex = { format: SNAPSHOT_FORMAT, commit, files: sortEntries(files) };
    const stored = await blobs.put(canonicalSnapshotJson(index));
    return { index, snapshotSha256: stored.sha256, totalBytes };
  } finally {
    await fh.close();
  }
}

function sortEntries(files: SnapshotEntry[]): SnapshotEntry[] {
  return files
    .map((f) => ({ f, key: Buffer.from(f.path, 'utf8') }))
    .sort((a, b) => Buffer.compare(a.key, b.key))
    .map((x) => x.f);
}

/** The index as the JSON data that gets hashed: exactly its fields, files in path order. */
function snapshotDocument(index: SnapshotIndex): SnapshotIndex {
  return {
    format: index.format,
    commit: index.commit,
    files: sortEntries(index.files).map((f) => ({ path: f.path, kind: f.kind, mode: f.mode, size: f.size, sha256: f.sha256 })),
  };
}

/**
 * The canonical JSON text of an index (sim/canonical.ts, RFC 8785; its sha256 is the snapshot
 * sha256). Throws CanonicalJsonError for what has no canonical form (a lone surrogate in a path).
 */
export function canonicalSnapshotJson(index: SnapshotIndex): string {
  return canonicalJson(snapshotDocument(index));
}

/** sha256 of canonicalSnapshotJson(index): the snapshot_sha256 and the index blob's name. */
export function snapshotSha256(index: SnapshotIndex): string {
  return canonicalSha256(snapshotDocument(index));
}

const SnapshotIndexSchema = z.strictObject({
  format: z.literal(SNAPSHOT_FORMAT),
  commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      kind: z.enum(['file', 'symlink']),
      mode: z.int().min(0).max(0o7777),
      size: z.int().min(0),
      sha256: z.string().regex(SHA256_RE),
    }),
  ),
});

/** Check an index's paths and kinds the same way indexing does (before anything uses it). */
export function validateSnapshotIndex(index: SnapshotIndex): void {
  const tree = new PathTree();
  for (const f of index.files) {
    if (validateSnapshotPath(f.path) !== f.path) throw rejectEntry('bad_header', `non-canonical path ${clip(f.path)}`, f.path);
    tree.add(f.path, f.kind);
  }
}

/**
 * Load and verify a stored index: the blob hashes to its name, parses, and its bytes are exactly
 * the canonical form of what it parses to (so its name is also snapshotSha256 of the index).
 */
export async function readSnapshotIndex(blobs: BlobStore, snapshotSha256: string): Promise<SnapshotIndex> {
  let bytes: Buffer | null;
  try {
    bytes = await blobs.get(snapshotSha256, { verify: true });
  } catch (err) {
    if (err instanceof BlobCorruptError) throw new RepoIntakeError('snapshot_corrupt', `snapshot index ${snapshotSha256} is corrupt`, { cause: err });
    throw err;
  }
  if (bytes === null) throw new RepoIntakeError('snapshot_corrupt', `snapshot index ${snapshotSha256} is missing`);
  let index: SnapshotIndex;
  try {
    index = SnapshotIndexSchema.parse(JSON.parse(bytes.toString('utf8'))) as SnapshotIndex;
  } catch (err) {
    throw new RepoIntakeError('snapshot_corrupt', `snapshot index ${snapshotSha256} does not parse`, { cause: err });
  }
  let canonical: string;
  try {
    canonical = canonicalSnapshotJson(index);
  } catch (err) {
    if (err instanceof CanonicalJsonError) throw new RepoIntakeError('snapshot_corrupt', `snapshot index ${snapshotSha256} has no canonical form (${err.message})`, { cause: err });
    throw err;
  }
  // Bytes, not decoded text: invalid UTF-8 decodes to U+FFFD and would compare equal as a string.
  if (!bytes.equals(Buffer.from(canonical, 'utf8'))) {
    throw new RepoIntakeError('snapshot_corrupt', `snapshot index ${snapshotSha256} is not canonical`);
  }
  validateSnapshotIndex(index);
  return index;
}

/** snapshot_file rows for a submission (server/db/schema.ts). */
export function toSnapshotFileRows(submissionId: string, index: SnapshotIndex): Array<typeof snapshotFile.$inferInsert> {
  return index.files.map((f) => ({ submissionId, path: f.path, blobSha256: f.sha256, mode: f.mode, kind: f.kind, size: f.size }));
}

// ---------------------------------------------------------------- the grader's mount

export interface MaterializedSnapshot {
  dest: string;
  files: number;
  bytes: number;
}

/**
 * Write a snapshot into `dest`, which must NOT exist yet (its parent must). Files are created with
 * O_EXCL under directories created here, each verified against its sha256 while copied; symlinks
 * are created with their stored target and never followed. Afterwards files are 0444 (0555 when
 * any execute bit was set) and directories 0555, ready for `-v <dest>:/bot:ro`. On any failure the
 * partial tree is removed. Remove it later with removeMaterialized().
 */
export async function materializeSnapshot(index: SnapshotIndex, blobs: BlobStore, dest: string): Promise<MaterializedSnapshot> {
  validateSnapshotIndex(index);
  await mkdir(dest, { mode: 0o700 });
  const dirs: string[] = [];
  const made = new Set<string>();
  let bytes = 0;
  try {
    for (const f of sortEntries(index.files)) {
      let at = f.path.indexOf('/');
      while (at !== -1) {
        const rel = f.path.slice(0, at);
        if (!made.has(rel)) {
          await mkdir(join(dest, rel), { mode: 0o700 });
          made.add(rel);
          dirs.push(rel);
        }
        at = f.path.indexOf('/', at + 1);
      }
      const target = join(dest, f.path);
      if (f.kind === 'symlink') {
        const link = await blobs.get(f.sha256, { verify: true }).catch((err: unknown) => {
          throw err instanceof BlobCorruptError ? new RepoIntakeError('snapshot_corrupt', `blob for ${clip(f.path)} is corrupt`, { cause: err }) : err;
        });
        if (link === null) throw new RepoIntakeError('snapshot_corrupt', `blob for ${clip(f.path)} is missing`);
        await symlink(link, target);
        continue;
      }
      if (!(await blobs.has(f.sha256))) throw new RepoIntakeError('snapshot_corrupt', `blob for ${clip(f.path)} is missing`);
      const hash = createHash('sha256');
      let n = 0;
      await pipeline(
        await blobs.openRead(f.sha256),
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            hash.update(chunk);
            n += chunk.byteLength;
            yield chunk;
          }
        },
        createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      );
      if (hash.digest('hex') !== f.sha256 || n !== f.size) throw new RepoIntakeError('snapshot_corrupt', `blob for ${clip(f.path)} does not match the index`);
      bytes += n;
      await chmod(target, f.mode & 0o111 ? 0o555 : 0o444);
    }
    for (const rel of dirs.sort((a, b) => b.split('/').length - a.split('/').length)) await chmod(join(dest, rel), 0o555);
    await chmod(dest, 0o555);
  } catch (err) {
    await removeMaterialized(dest).catch(() => undefined);
    throw err;
  }
  return { dest, files: index.files.length, bytes };
}

/** Remove a materialized snapshot: make its directories writable again (never following links), then delete. */
export async function removeMaterialized(dest: string): Promise<void> {
  let s;
  try {
    s = await lstat(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (s.isDirectory()) {
    const unlock = async (dir: string): Promise<void> => {
      await chmod(dir, 0o700);
      for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await unlock(join(dir, e.name));
    };
    await unlock(dest);
  }
  await rm(dest, { recursive: true, force: true });
}
