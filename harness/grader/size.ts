// The entry's code size (contracts/score.ts Score.size): what a program/v1 harness's size count
// (contracts/competition.ts ProgramSize, 'bytes-all-files') ranks a Smallest code bounty's passing
// entries by, the fewest bytes winning. Pure and versioned: a function of the entry's snapshot index
// (server/repos/index-tar.ts SnapshotEntry: each entry's path, kind, size and sha256, never its bytes)
// and the kit's starter, at the count's version. Nothing is read and nothing is timed, so a grade and
// every regrade fed the same snapshot and starter count the same bytes.
//
// Version 1 (PROGRAM_SIZE_VERSION), codeSize:
//   bytes   for every entry of the snapshot, its size (a regular file's bytes; a symlink's, the bytes
//           of its target text, which the program reads as easily: readlink) plus the UTF-8 bytes of
//           its path (each directory it sits under spelled out again), less every entry byte-identical
//           to the kit's starter: a regular file at the very path of a starter file, with its sha256
//           and size, so a file the entrant was handed and left as it was
//   files   the entries counted (every one but those)
//
// Why every byte of every file, names included (the size attacks this count was tried against): a
// count that leaves anything out gets the program moved into what it leaves out. Lines are joined
// (lines -92%). A token count weighs a string, a comment or a regex literal as a token or a few,
// and a file it calls generated as nothing, so `require('./s.min.js')` counted 6, a payload in a
// comment read back through Function#toString 20 and an `eval` of the program as a string 37, under
// the minified program's 81. The names of files (readdirSync) and a symlink's target (readlinkSync)
// carry a payload as well as a file's bytes do. Counted byte for byte, every such loader costs the
// bytes it loads plus its own, so none beats the program written small (an `eval` of the minified
// program as a string counts its quotes and its call more); tests/unit/grader-size.test.ts replays
// every trick and asserts it. A packer that compresses the program is no trick: its bytes are what
// the program needs, and code golf counts them alike.
//
// The starter is left out only where it stands unchanged, by path and bytes together: a file at a
// starter file's path with that file's bytes carries nothing the entrant chose. Matched on bytes
// alone, a copy of a starter file under a path of the entrant's choosing would carry that path free.
//
// Who counts: whoever holds the snapshot index, once per grade, handing the count to the score
// builders as the entry's cost and authorship are handed (grader/grade.ts GradeRequest.size,
// grader/regrade.ts RegradeL1Request.size): grader/worker.ts against the competition's starter as its
// kit hands it out (competitionStarter), cli/grade-local.ts against the kit.json listing
// (kitStarterFiles), so both count the same bytes. This module is scoring source (grader/version.ts
// SCORER_SOURCES): a change to the count names a new scorer_version.
//
// The compressed count ('compressed-all-files', PROGRAM_COMPRESSED_SIZE_VERSION), weighCodeSize: the same entries
// codeSize counts (countedEntries: every file and symlink, a starter file kept as handed left out), its `bytes` and
// `files` codeSize's own numbers, and `compressed` their weight under the size model (sim/size-model.ts
// compressedSizeMilli over each entry's path and bytes: a regular file's, a symlink's target text as UTF-8) as
// contracts/score.ts compressedSizeText writes it. The model needs the bytes, which the index does not hold: the caller
// hands weighCodeSize a reader of an entry's bytes (its blob, verified) and a weigher (the model run off the main
// thread: grader/size-weigh.ts snapshotCodeSize, the one every grader process and grade-local call), so a grade, each
// regrade and grade-local weigh the same bytes to the same thousandth. The model has a bound (sim/size-model.ts
// SIZE_MODEL_MODELED_BYTES, 1 MiB of stream: each counted entry's UTF-8 path, its bytes and two separator bytes):
// counted entries past it have NO compressed size, and weighCodeSize refuses them from the index's paths and sizes
// alone, before reading a byte, with sim/size-model.ts SizeModelBoundError, whose message is the grade's failure words
// (grader/worker.ts turns it into the grade's PermanentJobError). The intake refuses such an entry before it is ever
// graded, on a bundle naming the compressed count: compressedCountIssue is its check. Under 'bytes-all-files'
// weighCodeSize is codeSize, nothing read: its grades are byte for byte what they were.
//
// Entry secrets (a count saying `count_secrets: true`, contracts/competition.ts ProgramSize; the owner's call of
// 2026-11-22: a new bounty counts every byte an entry runs, secrets included): an env-lane entry secret is a variable
// every run of the entry's code gets (grader/grade.ts SnapshotSource.secrets), so a program moved into one runs as well
// as from a file, and a count of the snapshot alone scores it near nothing (sokoban-solver's and tiny-stack-vm's 26- and
// 27-byte trees evaluating their program from a secret). Under the switch each secret the entry's runs get counts its
// NAME's UTF-8 bytes plus its value's, as a file counts its path and its bytes (countSecrets), added to `bytes` and,
// under the compressed count, to `compressed` at a whole byte each: the value's length is what is counted
// (entry_secret.value_bytes, which outlives the value), never the value, so the count reads no value, a regrade or a
// kit's verifier long after the values are erased counts the same, and the score says only how many and how many bytes
// (contracts/score.ts ScoreSize.secrets). `files` stays the snapshot's entries. grader/worker.ts hands the rows the run
// runs with (a grade the ones it opens, a regrade the ones its run recorded: server/secrets/store.ts
// entrySecretSizesOf). Without the switch whatever secrets the caller hands are not read: every bundle sealed before it
// counts byte for byte as it did.

import { PROGRAM_COMPRESSED_SIZE_VERSION, PROGRAM_SIZE_VERSION, type ProgramSizeT } from '../contracts/competition.ts';
import { compressedSizeText, type ScoreSizeT } from '../contracts/score.ts';
import { ENTRY_SECRET_NAME_RE } from '../contracts/entry-secrets.ts';
import { KIT_STARTER_DIR } from '../server/competitions/kit-dirs.ts';
import { SizeModelBoundError, SIZE_MODEL_MODELED_BYTES, sizeModelStreamBytes, type SizeModelFile } from '../sim/size-model.ts';

/** One entry of the snapshot as the count reads it (server/repos/index-tar.ts SnapshotEntry has these and more). */
export interface SizedEntry {
  readonly path: string;
  readonly kind: 'file' | 'symlink';
  /** Bytes of the file, or of the symlink's target text. */
  readonly size: number;
  readonly sha256: string;
}

/** One regular file of the kit's starter, its path relative to the starter's root (the root of an entrant's repository). */
export interface StarterFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * One env-lane entry secret as a size count reads it (the header's entry secrets): its NAME and its value's length in
 * UTF-8 bytes (server/secrets/store.ts entrySecretSizesOf: entry_secret.value_bytes), never the value.
 */
export interface SizedSecret {
  readonly name: string;
  readonly bytes: number;
}

/** What a size count holds of an entry's secrets (contracts/score.ts ScoreSize.secrets): how many, and their bytes. */
export type CountedSecrets = NonNullable<ScoreSizeT['secrets']>;

const UTF8 = new TextEncoder();

/** The UTF-8 bytes of `s` (a lone surrogate as U+FFFD's three, as TextEncoder and Buffer write it). */
export function utf8ByteLength(s: string): number {
  return UTF8.encode(s).length;
}

function checkEntry(e: SizedEntry | StarterFile, what: string): void {
  if (typeof e.path !== 'string' || e.path === '') throw new TypeError(`${what} has no path`);
  if (!Number.isSafeInteger(e.size) || e.size < 0) throw new TypeError(`${what} ${e.path} has size ${String(e.size)}: a size is a whole number of bytes`);
  if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) throw new TypeError(`${what} ${e.path} has no sha256`);
}

/**
 * The entry's `secrets` as a size count counts them (the header's entry secrets): how many, and for each its NAME's
 * UTF-8 bytes plus its value's. A name that is no secret name (contracts/entry-secrets.ts ENTRY_SECRET_NAME_RE), a name
 * given twice or a length that is not a whole number of bytes is the caller's TypeError; its words never quote a value,
 * nor a name that failed the name rule (a value pasted where its name belongs).
 */
export function countSecrets(secrets: readonly SizedSecret[]): CountedSecrets {
  const seen = new Set<string>();
  let bytes = 0;
  for (const s of secrets) {
    if (typeof s.name !== 'string' || !ENTRY_SECRET_NAME_RE.test(s.name)) throw new TypeError('an entry secret has no secret name: a size count counts each by its NAME and its value\'s bytes');
    if (seen.has(s.name)) throw new TypeError(`the entry's secrets name ${s.name} twice`);
    if (!Number.isSafeInteger(s.bytes) || s.bytes < 0) throw new TypeError(`entry secret ${s.name} has a value of ${String(s.bytes)} bytes: a length is a whole number of bytes`);
    seen.add(s.name);
    bytes += utf8ByteLength(s.name) + s.bytes;
  }
  return { count: secrets.length, bytes };
}

/**
 * `raw` with the entry's secrets added under `count` (the header's entry secrets): under `count_secrets: true` their
 * bytes added to raw's and the count of them kept beside (none given is a TypeError: a count under the switch must be
 * told which secrets the entry's runs get, countSecrets([]) when none); without it `raw` as it is, `secrets` unread.
 */
function withSecrets(raw: { bytes: number; files: number }, count: ProgramSizeT, secrets: CountedSecrets | undefined): { bytes: number; files: number; secrets?: CountedSecrets } {
  if (count.count_secrets !== true) return raw;
  if (secrets === undefined) throw new TypeError(`size count ${count.count} v${count.version} counts the entry's secrets (count_secrets): hand it the secrets every run of the entry gets (countSecrets; countSecrets([]) when none)`);
  if (!Number.isSafeInteger(secrets.count) || secrets.count < 0 || !Number.isSafeInteger(secrets.bytes) || secrets.bytes < 0) {
    throw new TypeError(`the entry's secrets are counted as ${String(secrets.count)} of ${String(secrets.bytes)} bytes: both are whole numbers`);
  }
  if (secrets.count === 0 && secrets.bytes !== 0) throw new TypeError(`the entry's secrets are counted as none of ${secrets.bytes} bytes`);
  return { bytes: raw.bytes + secrets.bytes, files: raw.files, secrets: { count: secrets.count, bytes: secrets.bytes } };
}

/**
 * The entry's code size under size count `count` (the header): its snapshot's `entries` counted, less
 * each one byte-identical to the kit's `starter` file at its path ([] when the competition hands out
 * no starter), and under `count_secrets: true` the `secrets` every run of it gets (countSecrets; the header's entry
 * secrets), which a count without the switch never reads. A count or version this module does not take, a path named
 * twice, a size that is not a whole number of bytes, an entry of another kind, or a count under the switch handed no
 * secrets is the caller's TypeError.
 */
export function codeSize(count: ProgramSizeT, entries: readonly SizedEntry[], starter: readonly StarterFile[] = [], secrets?: CountedSecrets): ScoreSizeT {
  if (count.count === 'compressed-all-files' && count.version === PROGRAM_COMPRESSED_SIZE_VERSION) {
    throw new TypeError(`size count ${count.count} v${count.version} weighs the entries' bytes, which a snapshot index does not hold: weigh it with weighCodeSize (grader/size-weigh.ts snapshotCodeSize)`);
  }
  if (count.count !== 'bytes-all-files' || count.version !== PROGRAM_SIZE_VERSION) {
    throw new TypeError(`size count ${String(count.count)} v${String(count.version)}: this grader counts bytes-all-files at version ${PROGRAM_SIZE_VERSION} only`);
  }
  return { ...withSecrets(rawCount(countedEntries(entries, starter)), count, secrets), version: PROGRAM_SIZE_VERSION };
}

/**
 * The entries a size count counts, in the snapshot's order: every one of `entries` but a regular file byte-identical
 * to the kit's `starter` file at its path (by sha256 and size). A path named twice, a size that is not a whole number
 * of bytes, an entry with no sha256 or of another kind is the caller's TypeError (codeSize's checks).
 */
export function countedEntries(entries: readonly SizedEntry[], starter: readonly StarterFile[] = []): SizedEntry[] {
  const handed = new Map<string, StarterFile>();
  for (const f of starter) {
    checkEntry(f, 'starter file');
    if (handed.has(f.path)) throw new TypeError(`the starter names ${f.path} twice`);
    handed.set(f.path, f);
  }
  const seen = new Set<string>();
  const out: SizedEntry[] = [];
  for (const e of entries) {
    checkEntry(e, 'snapshot entry');
    if (e.kind !== 'file' && e.kind !== 'symlink') throw new TypeError(`snapshot entry ${e.path} is a ${String(e.kind)}: an entry is a file or a symlink`);
    if (seen.has(e.path)) throw new TypeError(`the snapshot names ${e.path} twice`);
    seen.add(e.path);
    const s = handed.get(e.path);
    if (e.kind === 'file' && s !== undefined && s.sha256 === e.sha256 && s.size === e.size) continue;
    out.push(e);
  }
  return out;
}

/** The raw count of counted entries: each one's size plus its path's UTF-8 bytes, and how many there are. */
function rawCount(counted: readonly SizedEntry[]): { bytes: number; files: number } {
  let bytes = 0;
  for (const e of counted) bytes += e.size + utf8ByteLength(e.path);
  return { bytes, files: counted.length };
}

/** What weighCodeSize reads and weighs with (grader/size-weigh.ts snapshotCodeSize hands the grader's own). */
export interface CodeSizeIo {
  /**
   * The bytes of a counted entry (a regular file's, or a symlink's target text), its blob verified against its sha256:
   * exactly `bytes` of them, which weighCodeSize always asks as the entry's whole size. Never asked for 0.
   */
  read(entry: SizedEntry, bytes: number): Promise<Uint8Array>;
  /** The size model's weight of `files` in thousandths of a byte (sim/size-model.ts compressedSizeMilli), off the caller's thread. */
  weigh(files: SizeModelFile[]): Promise<number>;
}

/**
 * Why the entry has no compressed size under `count`, in the words a refusal carries, or null when it has one (or the
 * count weighs nothing): under the compressed count ('compressed-all-files' at PROGRAM_COMPRESSED_SIZE_VERSION), its
 * counted entries (countedEntries: `entries` less the kit's `starter` files kept as handed) making a stream past the
 * size model's bound (sim/size-model.ts SIZE_MODEL_MODELED_BYTES), SizeModelBoundError's message. From the index's
 * paths and sizes alone, nothing read: the intake's check on a bundle naming the compressed count, the same rule
 * weighCodeSize refuses by. A bad entry or starter is countedEntries' TypeError.
 */
export function compressedCountIssue(count: ProgramSizeT, entries: readonly SizedEntry[], starter: readonly StarterFile[] = []): string | null {
  if (count.count !== 'compressed-all-files' || count.version !== PROGRAM_COMPRESSED_SIZE_VERSION) return null;
  const stream = sizeModelStreamBytes(countedEntries(entries, starter));
  return stream > SIZE_MODEL_MODELED_BYTES ? new SizeModelBoundError(stream).message : null;
}

/**
 * The entry's code size under size count `count`, as codeSize counts it, and under the compressed count
 * ('compressed-all-files' at PROGRAM_COMPRESSED_SIZE_VERSION, the header's compressed count) with `compressed` too:
 * the counted entries read whole by `io.read` (an empty entry is not read), weighed by `io.weigh` (a safe integer of
 * thousandths, not below 0). Counted entries whose stream passes the model's bound (sim/size-model.ts
 * SIZE_MODEL_MODELED_BYTES) have no compressed size: SizeModelBoundError, from the index alone, before any read or weigh.
 * Under 'bytes-all-files' nothing is read or weighed: codeSize's answer. Under `count_secrets: true` the `secrets` every
 * run of the entry gets (countSecrets) are added, to `compressed` byte for byte too (the header's entry secrets: no value
 * is read or weighed). Any other count, version or entry, or a count under the switch handed no secrets, is codeSize's
 * TypeError; a read of the wrong length is a TypeError too.
 */
export async function weighCodeSize(count: ProgramSizeT, entries: readonly SizedEntry[], starter: readonly StarterFile[], io: CodeSizeIo, secrets?: CountedSecrets): Promise<ScoreSizeT> {
  if (count.count !== 'compressed-all-files' || count.version !== PROGRAM_COMPRESSED_SIZE_VERSION) return codeSize(count, entries, starter, secrets);
  const counted = countedEntries(entries, starter);
  // Checked before a byte is read: a count under the switch handed no secrets reads nothing.
  const raw = withSecrets(rawCount(counted), count, secrets);
  const stream = sizeModelStreamBytes(counted);
  if (stream > SIZE_MODEL_MODELED_BYTES) throw new SizeModelBoundError(stream);
  const files: SizeModelFile[] = [];
  for (const e of counted) {
    const bytes = e.size === 0 ? new Uint8Array(0) : await io.read(e, e.size);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== e.size) {
      throw new TypeError(`snapshot entry ${e.path} reads ${bytes instanceof Uint8Array ? `${bytes.byteLength} bytes` : 'no bytes'}, and its size is ${e.size}`);
    }
    files.push({ path: e.path, bytes });
  }
  const milli = await io.weigh(files);
  if (!Number.isSafeInteger(milli) || milli < 0) throw new TypeError(`the size model weighed the entry at ${String(milli)}: a weight is a whole number of thousandths of a byte`);
  // Each secret byte a whole byte (the header's entry secrets), added to the model's weight of the files.
  const secretMilli = raw.secrets === undefined ? 0 : raw.secrets.bytes * 1000;
  return { ...raw, version: PROGRAM_COMPRESSED_SIZE_VERSION, compressed: compressedSizeText(BigInt(milli) + BigInt(secretMilli)) };
}

/**
 * The kit's starter as codeSize takes it, from the files a kit lists (cli/kit.ts KitFile: path, sha256,
 * size): those under starter/ (server/competitions/kit-dirs.ts KIT_STARTER_DIR), each path relative to
 * it, as an entrant's repository holds the file. Every other kit file is left out; a kit without a
 * starter gives [].
 */
export function kitStarterFiles(kitFiles: readonly StarterFile[]): StarterFile[] {
  const prefix = `${KIT_STARTER_DIR}/`;
  return kitFiles.filter((f) => f.path.startsWith(prefix) && f.path.length > prefix.length).map((f) => ({ path: f.path.slice(prefix.length), size: f.size, sha256: f.sha256 }));
}
