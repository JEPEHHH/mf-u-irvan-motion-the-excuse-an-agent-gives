// A live transcript recording, wire makefun-recording/v2 (strict transcripts: contracts/competition.ts
// SubmissionRule.strict_transcripts): a commit-reveal transparency log with salted selective disclosure.
//
// While the entrant's AI agent works, `makefun record` (cli/record.ts) watches every store file of every harness it
// records (RECORDED_SOURCES) and, for each *record* the harness writes (a JSONL line, or a row of a SQLite store's
// witness tables under its projection), sends make.fun only a salted commitment, a Leaf {tag, c}, in hash-chained
// chunks the site stamps with the time it received them (ChunkResponse.received_at), beside the working tree's
// sha256 deltas (TreeDelta). Nothing else leaves the machine before the seal: a leaf is two HMAC/sha256 outputs keyed
// by the recorder's secret K (32 random bytes made at start and never sent), so the site learns neither a record's
// content nor which store or line it sits at, and a store that also holds the entrant's other conversations
// (a Muse agent file, a Hermes state.db) shows the site nothing of them.
//
//   tag       recordTag: the first 16 bytes of HMAC-SHA256(K, "mf-rec/v2 tag\0" storeId "\0" epoch "\0" locator),
//             storeId the sha256 hex of the store file's absolute path (storeIdOf), epoch the store's rotation epoch,
//             locator `L<ordinal>` (lineLocator) or `<table>:<canonical JSON of the primary key>` (rowLocator). One
//             record's place, kept for its life: a record that changes gets a second leaf on the same tag.
//   salt      recordSalt: the first 16 bytes of HMAC-SHA256(K, "mf-rec/v2 salt\0" tag bytes), one per tag.
//   link      where the leaf sits in its store (ChainLink), committed inside c so the site can order a store's leaves
//             and see a gap once the seal opens them, though it learns nothing of the link before:
//               chain  recordChain: the first 16 bytes of HMAC-SHA256(K, "mf-rec/v2 chain\0" storeId "\0" epoch), the
//                      store's chain (a rotation's new epoch starts a new one)
//               n      the leaf's 1-based position in that chain: every leaf the recorder commits from the store, in
//                      the order it commits them, takes the next (a record's later version too)
//               conv   recordConversation: the first 16 bytes of HMAC-SHA256(K, "mf-rec/v2 conv\0" storeId "\0" key),
//                      the conversation the record belongs to, `key` its store's conversation key: "" for a store
//                      that holds one conversation (a Claude Code session, a Codex rollout: every record the same
//                      conv), the turn of a Muse app agent file (`t<n>`, the user message that opened it; its
//                      session_header `h`, in no turn), a row's session (its session_id cell, else "")
//   body      recordBody: sha256 hex of "mf-rec/v2 body\0" salt bytes and the record's stable bytes (a line's bytes
//             after line-local redaction, without its newline; a row's rowStable): the content, hidden by the salt.
//   c         leafCommitment: sha256 hex of "mf-rec/v2 leaf\0", the tag's 16 bytes, the chain's 16, n as 8 bytes
//             big-endian, the conv's 16 and the body's 32 (linkedCommitment).
//
//   start     a ONE-conversation store's start state (ONE_CONVERSATION_SOURCES: each store file one session), one leaf
//             {tag, c} the recorder commits for the store when it starts watching it (at the recording's start, or
//             when watch() first lists it later), and again at each rotation's new epoch, carrying the store's start
//             state over: its tag recordTag(K, storeId, epoch, START_LOCATOR), its salt recordSalt as any tag's, and c
//             startCommitment over the tag, the salt and the StartState {chain: the store's chain at that epoch,
//             epoch, records: the complete records the store file held when the recorder first saw it (0 for a
//             store first seen after the start), baseline: how many of those, its last ones, the baseline committed
//             in chunk 1}. No text, no position in the chain. A sealed document of such a source opens its store's
//             start state in its RevealTable (`start`): the site then knows whether its session began before the
//             recording (records past baseline), and every leaf of that chain from its first position on must be
//             accounted for, so a document cut at its start shows it (server/recordings/verify.ts).
//
//   start     POST /api/competitions/:slug/recordings answers RecordingStartResponse: the recording's id, its format
//             (RECORDING_FORMAT; the recorder refuses any other) and chain_seed, the server's nonce chunk 1 chains from.
//   chunks    POST /api/recordings/:id/chunks takes ChunkRequest, strictly in seq order: the chain head it extends
//             (prev_chain), the new leaves, and the working tree's change since the last chunk (the first carries the
//             whole set). The answer, ChunkResponse, is the new head (chainHash) and the server's receipt time. A
//             recording's chunks are held to CHUNK_RATE (429 with Retry-After) and its caps (MAX_RECORDING_CHUNKS,
//             MAX_RECORDING_LEAF_BYTES, MAX_RECORDING_TREE_BYTES: 409 RECORDING_CAP, which ends a recording).
//   blobs     PUT /api/recordings/:id/blobs takes one sealed document's bytes, or its RevealTable's JSON, at most
//             MAX_RECORDING_BLOB_BYTES, and answers BlobPutResponse: the sha256 the finish names it by. A
//             recording's blobs together come to at most MAX_RECORDING_BLOBS_BYTES (512 MiB), an account's open
//             recordings' at most MAX_ACCOUNT_OPEN_BLOBS_BYTES: a PUT past either is 413. The body may come
//             Content-Encoding: gzip (a level-28 kit sends it so, past the edge's 200 MB body cap): it is decompressed
//             as read, every limit weighs the decompressed bytes, BlobPutResponse names the decompressed blob, any
//             other coding is 415 and a stream that does not decompress is 400.
//   finish    POST /api/recordings/:id/finish takes FinishRequest and seals: each RecordingDocument names an uploaded
//             document (the one bundle would upload, cut to the recording's records and redacted with the
//             recording's fixed context) and its RevealTable, which pairs each record pointer (RecordPointer) with
//             its tag, salt and link (RevealedEntry), and accounts for every other leaf the recording committed in
//             each chain between the document's first and last revealed record by an opaque skip (SkipEntry: its
//             tag, link and body, no content); a one-conversation document's also opens its store's start state
//             (StartEntry), and then accounts for its chain from position 1. The site recomputes every commitment against the recording's leaves,
//             refuses a reveal that leaves a position of such a run unaccounted for, keeps per pointer the receipt
//             at which that content was first committed and per document the skips inside a revealed record's
//             conversation (a record the recording witnessed, gone from the document: transcripts_witnessed fails
//             it), and answers RecordingFinishResponse:
//             every document's size, sha256 (the sha256s an entry message's Transcripts line is computed from,
//             server/entries/manifest.ts transcriptsSha256), records and witnessed records.
//   list      GET /api/recordings?competition=<slug>: the caller's RecordingSummary list.
//
// The gate check transcripts_witnessed (server/entries/thinking.ts) then holds every dated message's pointer to its
// receipt within max_witness_lag_sec, so a transcript written or edited after the fact fails.
//
// What a skip shows the site: that a committed record sits at that place of its store, the receipt it was committed
// at, and which of the document's other records share its conversation (conv is the same opaque 16 bytes for the
// records of one conversation) — never its content, its pointer or any id of its conversation. So a SQLite store's
// other sessions show as how many records of how many other conversations were written beside the build and when. A
// Muse app file is one conversation (every turn of it was in the agent's context), so its seal keeps every record the
// recording witnessed, whichever turn it sits in (cli/record-seal.ts step 4): a skip in a Muse app document is a
// witnessed turn left out, which transcripts_witnessed fails, and so is each leaf its chain committed before the
// document's first revealed record (its reveal opens at position 1, the first record the recording witnessed in the
// file: server/recordings/verify.ts accountFor); only its turns from before the recording stay out.
//
// Pure: zod and the primitives only, no I/O. It hashes with node:crypto (createHash, createHmac), looked up on first
// use (process.getBuiltinModule, as contracts/dossier.ts does), so the module imports nothing else.

import { z } from 'zod';
import { LOOSE_UPLOAD_NAME } from './transcript-uploads.ts';
import { MAX_TRANSCRIPT_UPLOAD_BYTES, TranscriptSource } from './bundle.ts';
import { IsoDateTime, Sha256Hex, Slug } from './primitives.ts';

/** The recording wire format this module states. */
export const RECORDING_FORMAT = 'makefun-recording/v2';
// v1 intake: delete after 2026-11-18T00:40Z (makefun-frontend-01's final); then: /** The request header a recorder names its wire format in at the start (its value RECORDING_FORMAT); the site ignores it. */
/** The request header a recorder names its wire format in at the start (its value RECORDING_FORMAT): a competition still taking the older wire (server/recordings/v1/compat.ts V1_STRICT_COMPETITIONS) starts a v2 recording only for a start naming it, a v1 one for any other (a v1 kit sends none); every other competition ignores it. */
export const RECORDING_FORMAT_HEADER = 'x-makefun-recording-format';
/** How often the recorder sends what is new (a chunk only when something is). */
export const FLUSH_INTERVAL_MS = 5000;
/** How often the recorder sends a chunk with nothing new (a heartbeat), so a quiet recording still shows it is live. */
export const HEARTBEAT_INTERVAL_MS = 30000;
/**
 * The largest chunk request body, bytes, but the first's (MAX_FIRST_CHUNK_REQUEST_BYTES): the recorder sends at most
 * about 1 MiB (cli/record.ts CHUNK_BODY_BUDGET) and splits a larger flush, the tree's delta included, across chunks;
 * the route reads no more than this before it refuses with 413. Every chunk is validated on the main thread, so this
 * bounds what one costs there.
 */
export const MAX_CHUNK_REQUEST_BYTES = 2 * 1024 * 1024;
/**
 * The largest FIRST chunk's request body, bytes (the recording's chunk 1: it carries the whole working tree, which the
 * gate reads as the tree the recording began with, server/recordings/witness.ts initialTree, from that one chunk).
 * About 70,000 tree files at ~120 bytes each; the recorder splits only a tree past it (cli/record.ts
 * FIRST_CHUNK_BODY_BUDGET). Once a recording.
 */
export const MAX_FIRST_CHUNK_REQUEST_BYTES = 8 * 1024 * 1024;
/**
 * How fast one recording's chunks are taken, per web process: a bucket of `burst` chunks refilled at `per_second` (a
 * chunk past it is 429 with Retry-After, which the recorder waits out and sends again). The recorder sends one chunk a
 * FLUSH_INTERVAL_MS (0.2 a second) and, after an outage or a closing sweep, a backlog's chunks one after another: ten at
 * once, then one a second, is well above both.
 */
export const CHUNK_RATE = Object.freeze({ burst: 10, per_second: 1 });
/**
 * The most chunks one recording takes. An honest recording sends one a FLUSH_INTERVAL_MS while anything is new and a
 * heartbeat each HEARTBEAT_INTERVAL_MS otherwise: 17,280 in 24 h of non-stop work. 100,000 is nearly six such days (the
 * per-recording rate, CHUNK_RATE, reaches it in no less than 28 h).
 */
export const MAX_RECORDING_CHUNKS = 100_000;
/**
 * The most bytes one recording's leaves take as stored (transcript_recording_chunk.leaves, about 120 bytes a leaf):
 * about a million leaves. A busy agent writes a record or two a second; 24 h of that is under 200,000 leaves (about
 * 24 MiB), and the documents a seal reveals them in come to at most MAX_TRANSCRIPT_UPLOAD_BYTES, a few hundred bytes
 * a record.
 */
export const MAX_RECORDING_LEAF_BYTES = 128 * 1024 * 1024;
/**
 * The most bytes one recording's tree deltas take as stored (transcript_recording_chunk.tree, about 120 bytes a file
 * entry): the first chunk's whole tree (at most MAX_FIRST_CHUNK_REQUEST_BYTES) and every later delta. 24 h of an agent
 * changing a few files each FLUSH_INTERVAL_MS is a few MiB; 128 MiB is a million file changes.
 */
export const MAX_RECORDING_TREE_BYTES = 128 * 1024 * 1024;
/**
 * The code (ApiError `data.code`) of a chunk refused by a recording's caps (MAX_RECORDING_CHUNKS, MAX_RECORDING_LEAF_BYTES,
 * MAX_RECORDING_TREE_BYTES): a 409 with no head to resync from, which the recorder stops on (sending again changes
 * nothing); data names the cap, its limit and what the recording holds.
 */
export const RECORDING_CAP = 'RECORDING_CAP';
/** What a RECORDING_CAP refusal carries beside its message. */
export interface RecordingCapData {
  code: typeof RECORDING_CAP;
  cap: 'chunks' | 'leaf_bytes' | 'tree_bytes';
  max: number;
  held: number;
}
/**
 * The longest a record may take to reach the site after the time its message claims, seconds (the gate's
 * max_witness_lag_sec default, server/entries/policy.ts): a record received later than that was backfilled.
 */
export const DEFAULT_MAX_WITNESS_LAG_SEC = 300;
/**
 * The most leaves one chunk may carry (about 120 bytes of JSON each, well inside MAX_CHUNK_REQUEST_BYTES). The chunk
 * route validates a request on the main thread, so this bounds that to a few ms; the recorder splits a larger flush
 * across chunks, and one FLUSH_INTERVAL_MS flush of a live agent's records never nears it.
 */
export const MAX_CHUNK_LEAVES = 5_000;
/** The most tree paths one delta may name. */
export const MAX_TREE_PATHS = 200_000;
/** The longest repo-relative path a tree delta names, characters. */
export const MAX_TREE_PATH_CHARS = 4096;
/** The most documents one recording's finish may name. */
export const MAX_RECORDING_DOCUMENTS = 256;
/** The longest record pointer, characters. */
export const MAX_RECORD_POINTER_CHARS = 512;
/** The most entries one reveal table may hold. */
export const MAX_REVEAL_ENTRIES = 2_000_000;
/** The largest blob (a document or a reveal table's JSON) a recording takes, bytes: the transcript upload limit. */
export const MAX_RECORDING_BLOB_BYTES = MAX_TRANSCRIPT_UPLOAD_BYTES;
/**
 * The most bytes one recording's blobs come to together (each sha256 once), its documents and their reveal tables both:
 * twice the transcript upload limit a finish holds its documents to, since a reveal table is about 190 bytes a record
 * (a 256 MiB document of short lines reveals in about 148 MiB). A blob PUT past it is 413 and never stored.
 */
export const MAX_RECORDING_BLOBS_BYTES = 2 * MAX_TRANSCRIPT_UPLOAD_BYTES;
/**
 * The most bytes one account's open (unsealed) recordings' blobs come to together, every recording counted: two full
 * recordings' (MAX_RECORDING_BLOBS_BYTES each), where MAX_OPEN_RECORDINGS of them could otherwise pin eight. A seal
 * takes its recording's blobs out of the count; the recording sweep drops an abandoned one's 48 h after its last
 * activity. A PUT past it is 413 with data.code ACCOUNT_BLOBS_CAP.
 */
export const MAX_ACCOUNT_OPEN_BLOBS_BYTES = 2 * MAX_RECORDING_BLOBS_BYTES;
/** The code (ApiError `data.code`) of a blob PUT refused by MAX_ACCOUNT_OPEN_BLOBS_BYTES. */
export const ACCOUNT_BLOBS_CAP = 'ACCOUNT_BLOBS_CAP';
/**
 * The most blob PUTs one account streams at once, per web process (the recorder uploads one at a time): one more is 429
 * with Retry-After.
 */
export const MAX_CONCURRENT_BLOB_PUTS = 2;
/**
 * The most open (unsealed) recordings one account may hold at once, every competition and wire together: a start past
 * it is 409 with data.code 'OPEN_RECORDINGS_CAP' (server/recordings/store.ts OpenRecordingsCapData: the cap, how many
 * are open and their ids), never a 429, which a recorder retries. Each open recording holds its chunk rows and uploads
 * (up to MAX_RECORDING_BLOBS_BYTES) until it is sealed or the recording sweep drops it 48 h after its last activity, so
 * this bounds what one account can pin. An honest builder runs one `makefun record` a repository it works in (two or
 * three at once at most) and leaves one open only when a recorder dies before its seal (`makefun record --finish <id>`
 * seals it): eight is well above that.
 */
export const MAX_OPEN_RECORDINGS = 8;

/** A recording's id: a UUID (the schema's UUIDv7, transcript_recording.id). */
export const RecordingId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a recording id (a lowercase UUID)');

/**
 * The name a sealed document takes in the entry's transcript upload: a loose upload's plain file name (no directory,
 * server/pipeline/ingest.ts TranscriptUploadFile), ending as LOOSE_UPLOAD_NAME takes (a JSONL log, a SQLite store's
 * `.db` …), in the characters a bundle's SessionPath segment allows (contracts/bundle.ts), at most 255 characters.
 * The recorder uses the store file's own base name (`<uuid>.jsonl`, `rollout-<time>-<uuid>.jsonl`, `state.db`), which
 * the format detection reads.
 */
export const RecordingArchiveName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._@-]*$/, 'expected a plain file name (letters, digits, . _ @ -)')
  .refine((n) => LOOSE_UPLOAD_NAME.test(n), 'expected a loose transcript file name (.jsonl, .json, .db …)');

/** Whether `p` is a repo-relative POSIX path: not empty, no leading slash, no NUL, no empty, `.` or `..` segment. */
function isRepoPath(p: string): boolean {
  if (p === '' || p.length > MAX_TREE_PATH_CHARS || p.startsWith('/') || p.includes('\0')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * The harnesses `makefun record` records (cli/record.ts; cli/collect.ts re-exports this list, the one there is, as
 * tests/integration/recordings.test.ts holds), each with its witness spec (transcripts/witness-records.ts
 * WITNESS_SPECS): class J, append-only JSONL stores whose every line carries its time and whose parser numbers each
 * message by its uploaded line (Antigravity's among them: one conversation's
 * brain/<id>/.system_generated/logs/transcript_full.jsonl, behind the header lines its collector writes,
 * transcripts/antigravity.ts antigravityRecordedText; and Freebuff's and Codebuff's, source zazen: one chat's
 * trace.jsonl, written only when the CLI runs with CODEBUFF_TRACE=1, cli/harness-zazen.ts); and class S, SQLite stores recorded row by row under a projection, whose parser points
 * each message at the row it came from (Message.record): Hermes Agent's state.db, and the opencode store (Kilo
 * Code's, MiMo Code's and ZCode's, source opencode, among them). A document of any other source is
 * refused at the finish, so a strict entry's transcript is only ever records such a harness wrote as the agent worked.
 */
export const RECORDED_SOURCES = [
  'claude-code',
  'claude-stream',
  'codex',
  'muse-app',
  'superbot',
  'gemini-cli',
  'copilot-cli',
  'pi',
  'omp',
  'dsh',
  'factory-droid',
  'grok-build',
  'muse-code',
  'kiro',
  'codebuddy',
  'goose',
  'openclaw',
  'hermes',
  'opencode',
  'antigravity',
  'zazen',
] as const satisfies readonly z.infer<typeof TranscriptSource>[];

/**
 * The recorded lines sources whose store file holds ONE conversation (each file one session, as its collector maps
 * files to sessions: cli/harness-*.ts), whose sealed document must begin at its store's first record: the recorder
 * commits each such store's start state (see the header), and server/recordings/verify.ts SINGLE_CONVERSATION holds
 * a document of one to it (Antigravity's: one transcript_full.jsonl per conversation, a subagent's its own; a Freebuff
 * chat's trace.jsonl: the main agent and every subagent it spawned, one chat, begun when the chat's first step ran). Not
 * here: Claude Code and Codex (their own start records: a parentUuid chain, a
 * session_meta), the Muse app (its agent file is one conversation, but its document opens at the first record the
 * recording witnessed, or the build's first turn when that is earlier: its turns from before the recording stay out,
 * cli/record-seal.ts step 4; its reveal must open at its chain's position 1 instead, verify.ts accountFor), and the
 * SQLite stores (many sessions each).
 */
export const ONE_CONVERSATION_SOURCES = [
  'claude-stream',
  'superbot',
  'gemini-cli',
  'copilot-cli',
  'pi',
  'omp',
  'dsh',
  'factory-droid',
  'grok-build',
  'muse-code',
  'kiro',
  'codebuddy',
  'goose',
  'openclaw',
  'antigravity',
  'zazen',
] as const satisfies readonly (typeof RECORDED_SOURCES)[number][];

/** A source whose store file is one conversation (ONE_CONVERSATION_SOURCES). */
export type OneConversationSource = (typeof ONE_CONVERSATION_SOURCES)[number];

/** Whether `source`'s store files each hold one conversation (ONE_CONVERSATION_SOURCES). */
export function isOneConversationSource(source: string): source is OneConversationSource {
  return (ONE_CONVERSATION_SOURCES as readonly string[]).includes(source);
}

/** Whether `source` is one `makefun record` records (RECORDED_SOURCES). */
export function isRecordedSource(source: string): boolean {
  return (RECORDED_SOURCES as readonly string[]).includes(source);
}

/** A transcript source `makefun record` records (RECORDED_SOURCES). */
export const RecordedSource = TranscriptSource.refine(isRecordedSource, {
  error: (iss) => `source ${JSON.stringify(iss.input)}: a recording carries only the stores makefun record records, of source ${RECORDED_SOURCES.join(', ')}`,
});

/**
 * A path relative to the repository root, POSIX separators, in well-formed Unicode: a lone surrogate ("x\ud800y", which
 * JSON's \u escapes can send) has no UTF-8, so the jsonb the store writes it as would refuse it (22P02, a 500): refused
 * here, a 400, on the route's in-thread and off-thread validation alike. A tree's set paths and its removed paths both.
 */
export const RepoPath = z
  .string()
  .refine(isRepoPath, 'expected a repo-relative POSIX path (no leading /, no empty, . or .. segment)')
  .refine((p) => p.isWellFormed(), 'expected a path of well-formed Unicode (no lone surrogate)');

export const RecordingStartResponse = z.strictObject({
  recording_id: RecordingId,
  competition: Slug,
  /** The wire format the site records in: a recorder of another format refuses to record. */
  format: z.literal(RECORDING_FORMAT),
  started_at: IsoDateTime,
  /** The server's random nonce (32 bytes, hex): chunk 1's prev_chain. */
  chain_seed: Sha256Hex,
});

/** A record's tag (recordTag): 16 bytes, lowercase hex. */
export const Tag = z.string().regex(/^[0-9a-f]{32}$/, 'expected a tag (32 lowercase hex)');
/** A tag's salt (recordSalt): 16 bytes, lowercase hex. */
export const Salt = z.string().regex(/^[0-9a-f]{32}$/, 'expected a salt (32 lowercase hex)');

/** One record version's salted commitment: its tag and c = leafCommitment(tag, salt, stable bytes, its link). */
export const Leaf = z.strictObject({ tag: Tag, c: Sha256Hex });

/** One working-tree file and the sha256 of its content. */
export const TreeFile = z.strictObject({ path: RepoPath, sha256: Sha256Hex });

/**
 * The working tree's change since the last chunk (the first chunk's: the whole tree): files whose content is new or
 * changed (`set`) and files gone (`removed`). The tree is `git ls-files -co --exclude-standard` in the repository.
 * Each sha256 is defined exactly as server/repos/index-tar.ts SnapshotIndex.files sha256 is, which the gate compares it
 * with: the sha256 of the file's raw bytes for a regular file, and of the link's target path bytes for a symlink.
 */
export const TreeDelta = z.strictObject({
  set: z.array(TreeFile).max(MAX_TREE_PATHS),
  removed: z.array(RepoPath).max(MAX_TREE_PATHS),
});

export const ChunkRequest = z.strictObject({
  /** 1 for the first chunk, then one more each: the recording's last stored seq plus one. */
  seq: z.int().min(1),
  /** The chain head this chunk extends: chain_seed for chunk 1, else the previous chunk's ChunkResponse.chain. */
  prev_chain: Sha256Hex,
  /** The record versions committed since the last chunk, in the order chainHash hashes them; none for a heartbeat. */
  leaves: z.array(Leaf).max(MAX_CHUNK_LEAVES),
  /** The working tree's change since the last chunk, or null for none. */
  tree: TreeDelta.nullable(),
});

export const ChunkResponse = z.strictObject({
  seq: z.int().min(1),
  /** chainHash(prev_chain, the request): the recording's new head. */
  chain: Sha256Hex,
  /** When the site received the chunk: the receipt the gate holds each record and tree hash to. */
  received_at: IsoDateTime,
});

const LINE_POINTER = /^L[1-9][0-9]{0,9}$/;
const ROW_POINTER = /^[A-Za-z_][A-Za-z0-9_]{0,63}:.+$/s;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Where a record sits in an uploaded document: `L<n>`, its 1-based line (a JSONL document), or `<table>:<key JSON>`,
 * a row of an uploaded SQLite document by its table and the canonical JSON of its primary key (rowLocator's form).
 * At most MAX_RECORD_POINTER_CHARS characters.
 */
export const RecordPointer = z
  .string()
  .max(MAX_RECORD_POINTER_CHARS)
  .refine((p) => LINE_POINTER.test(p) || ROW_POINTER.test(p), 'expected a record pointer: L<line> or <table>:<key JSON>');

/** A chain id (recordChain) or a conversation (recordConversation): 16 bytes, lowercase hex. */
export const ChainId = z.string().regex(/^[0-9a-f]{32}$/, 'expected a chain id (32 lowercase hex)');
export const Conversation = z.string().regex(/^[0-9a-f]{32}$/, 'expected a conversation (32 lowercase hex)');
/** A leaf's place in its chain: 1-based. */
export const ChainPosition = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

/** One revealed record: its pointer in the document, and the tag, salt and link of the leaf its content matches. */
export const RevealedEntry = z.strictObject({ p: RecordPointer, tag: Tag, salt: Salt, chain: ChainId, n: ChainPosition, conv: Conversation });
/**
 * One committed leaf the document does not hold, accounted for (see the header): its tag, its link and its body
 * (recordBody), so the site recomputes its c, with no pointer and nothing of its content.
 */
export const SkipEntry = z.strictObject({ tag: Tag, chain: ChainId, n: ChainPosition, conv: Conversation, body: Sha256Hex });
/** A reveal table's entry: a revealed record (it has a pointer) or a skip. */
export const RevealEntry = z.union([RevealedEntry, SkipEntry]);

/** Whether a reveal entry is a revealed record (else a skip). */
export function isRevealed(e: RevealEntryT): e is RevealedEntryT {
  return 'p' in e;
}

/**
 * A one-conversation store's start state opened (see the header): the start leaf's tag and salt, and its StartState
 * (the store's chain at the epoch, the epoch, the records the store held when the recorder first saw it, and how many
 * of them, its last ones, the baseline committed: never more than it held).
 */
export const StartEntry = z
  .strictObject({
    tag: Tag,
    salt: Salt,
    chain: ChainId,
    epoch: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    records: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    baseline: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine((e) => e.baseline <= e.records, { message: 'a start state commits no more baseline records than the store held', path: ['baseline'] });

/**
 * A sealed document's reveal, uploaded as a blob (its JSON): one entry a revealed record (each pointer once) or a
 * skip (each chain position once, and none at a revealed one's); and, for a document of a one-conversation source
 * (ONE_CONVERSATION_SOURCES), `start`: its store's start state, the one of the chain its first revealed record sits on.
 */
export const RevealTable = z.strictObject({
  format: z.literal(RECORDING_FORMAT),
  start: StartEntry.optional(),
  entries: z
    .array(RevealEntry)
    .max(MAX_REVEAL_ENTRIES)
    .superRefine((entries, ctx) => {
      const seen = new Set<string>();
      const revealedAt = new Set<string>();
      const skippedAt = new Set<string>();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const at = `${e.chain}:${e.n}`;
        if (isRevealed(e)) {
          if (seen.has(e.p)) {
            ctx.addIssue({ code: 'custom', message: `pointer ${JSON.stringify(e.p)} is revealed twice`, path: [i, 'p'] });
            return;
          }
          seen.add(e.p);
          revealedAt.add(at);
        } else {
          if (skippedAt.has(at)) {
            ctx.addIssue({ code: 'custom', message: `chain ${e.chain} position ${e.n} is skipped twice`, path: [i, 'n'] });
            return;
          }
          skippedAt.add(at);
        }
      }
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        if (!isRevealed(e) && revealedAt.has(`${e.chain}:${e.n}`)) {
          ctx.addIssue({ code: 'custom', message: `chain ${e.chain} position ${e.n} is both revealed and skipped`, path: [i, 'n'] });
          return;
        }
      }
    }),
});

/** One sealed document the finish names: the uploaded blobs of its bytes and of its RevealTable's JSON, by sha256. */
export const RecordingDocument = z.strictObject({
  archive_path: RecordingArchiveName,
  source: RecordedSource,
  sha256: Sha256Hex,
  reveal_sha256: Sha256Hex,
});

/**
 * The seal: the recording's documents, none when it witnessed no session the seal keeps (it still seals, empty; an
 * entry refuses a recording that holds no document: server/recordings/store.ts entryRecordings).
 */
export const FinishRequest = z.strictObject({
  documents: z
    .array(RecordingDocument)
    .max(MAX_RECORDING_DOCUMENTS)
    .superRefine((docs, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < docs.length; i++) {
        const name = docs[i]!.archive_path;
        if (seen.has(name)) {
          ctx.addIssue({ code: 'custom', message: `archive_path ${JSON.stringify(name)} is named twice`, path: [i, 'archive_path'] });
          return;
        }
        seen.add(name);
      }
    }),
});

/** One sealed document of a recording: its size, sha256, records and how many of them the recording witnessed. */
export const RecordingFinishDocument = z.strictObject({
  archive_path: RecordingArchiveName,
  source: TranscriptSource,
  bytes: z.int().min(0),
  sha256: Sha256Hex,
  /** The document's records (lines or witness-table rows). */
  records: z.int().min(0),
  /** Those of its records the reveal matched to a leaf. */
  witnessed: z.int().min(0),
});

export const RecordingFinishResponse = z.strictObject({
  recording_id: RecordingId,
  head_chain: Sha256Hex,
  started_at: IsoDateTime,
  sealed_at: IsoDateTime,
  chunks: z.int().min(0),
  /** The leaves the recording's chunks carried. */
  leaves: z.int().min(0),
  documents: z.array(RecordingFinishDocument),
});

/** A stored blob: the sha256 a finish names it by, and its size. */
export const BlobPutResponse = z.strictObject({
  sha256: Sha256Hex,
  bytes: z.int().min(0).max(MAX_RECORDING_BLOB_BYTES),
});

export const RecordingSummary = z.strictObject({
  recording_id: RecordingId,
  competition: Slug,
  started_at: IsoDateTime,
  /** null while the recording is open. */
  sealed_at: IsoDateTime.nullable(),
  chunks: z.int().min(0),
  /** The sealed documents: 0 while the recording is open. */
  documents: z.int().min(0),
});

export const RecordingList = z.strictObject({ recordings: z.array(RecordingSummary) });

export type RecordedSourceT = z.infer<typeof RecordedSource>;
export type RecordingStartResponseT = z.infer<typeof RecordingStartResponse>;
export type LeafT = z.infer<typeof Leaf>;
export type TreeFileT = z.infer<typeof TreeFile>;
export type TreeDeltaT = z.infer<typeof TreeDelta>;
export type ChunkRequestT = z.infer<typeof ChunkRequest>;
export type ChunkResponseT = z.infer<typeof ChunkResponse>;
export type RecordPointerT = z.infer<typeof RecordPointer>;
export type RevealEntryT = z.infer<typeof RevealEntry>;
export type RevealedEntryT = z.infer<typeof RevealedEntry>;
export type SkipEntryT = z.infer<typeof SkipEntry>;
export type StartEntryT = z.infer<typeof StartEntry>;
export type RevealTableT = z.infer<typeof RevealTable>;
export type RecordingDocumentT = z.infer<typeof RecordingDocument>;
export type FinishRequestT = z.infer<typeof FinishRequest>;
export type RecordingFinishDocumentT = z.infer<typeof RecordingFinishDocument>;
export type RecordingFinishResponseT = z.infer<typeof RecordingFinishResponse>;
export type BlobPutResponseT = z.infer<typeof BlobPutResponse>;
export type RecordingSummaryT = z.infer<typeof RecordingSummary>;
export type RecordingListT = z.infer<typeof RecordingList>;

// ---------------------------------------------------------------- hashing

function nodeCrypto(): typeof import('node:crypto') {
  return process.getBuiltinModule('node:crypto');
}

/** The sha256 of `data` (UTF-8 for a string), lowercase hex (node:crypto, looked up on first use). */
export function sha256Hex(data: Uint8Array | string): string {
  return nodeCrypto().createHash('sha256').update(data).digest('hex');
}

/** The JSON values the recording hashes: plain data, no undefined. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

/**
 * Canonical JSON of `v`: object keys sorted by UTF-16 code units, no whitespace, strings and numbers as
 * JSON.stringify writes them. For the plain data the recording hashes (strings, finite numbers, booleans, null) this
 * is RFC 8785 and equals sim/canonical.ts canonicalJson (tests/unit/recording-contract.test.ts holds them equal).
 */
export function recordingCanonicalJson(v: Json): string {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('recordingCanonicalJson: a number that is not finite');
    return JSON.stringify(v === 0 ? 0 : v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${(v as readonly Json[]).map(recordingCanonicalJson).join(',')}]`;
  const o = v as { readonly [k: string]: Json };
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${recordingCanonicalJson(o[k]!)}`).join(',')}}`;
}

const HEX16 = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const TAG_DOMAIN = 'mf-rec/v2 tag\0';
const SALT_DOMAIN = 'mf-rec/v2 salt\0';
const LEAF_DOMAIN = 'mf-rec/v2 leaf\0';
const CHAIN_DOMAIN = 'mf-rec/v2 chain\0';
const CONV_DOMAIN = 'mf-rec/v2 conv\0';
const BODY_DOMAIN = 'mf-rec/v2 body\0';
const START_DOMAIN = 'mf-rec/v2 start\0';

/** The 16 bytes of a tag or salt's 32 hex, refusing anything else. */
function bytes16(hex: string, what: string): Buffer {
  if (!HEX16.test(hex)) throw new Error(`${what}: expected 32 lowercase hex`);
  return Buffer.from(hex, 'hex');
}

function checkSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) throw new Error('recording secret: expected 32 bytes');
}

/** HMAC-SHA256(secret, message), its first 16 bytes as 32 lowercase hex. */
function hmac16(secret: Uint8Array, message: Uint8Array): string {
  return nodeCrypto().createHmac('sha256', secret).update(message).digest().subarray(0, 16).toString('hex');
}

/** A store's id in its tags: the sha256 hex of its absolute path's UTF-8. */
export function storeIdOf(absolutePath: string): string {
  return sha256Hex(absolutePath);
}

/** The locator of a store's line `ordinal` (1-based, as a document's L pointer counts): `L<ordinal>`. */
export function lineLocator(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error(`lineLocator: expected a 1-based line ordinal, got ${ordinal}`);
  return `L${ordinal}`;
}

/** The locator of a witness-table row: `<table>:` and the canonical JSON of its primary key. */
export function rowLocator(table: string, key: Json): string {
  if (!TABLE_NAME.test(table)) throw new Error(`rowLocator: expected a table name of letters, digits and _, got ${JSON.stringify(table)}`);
  return `${table}:${recordingCanonicalJson(key)}`;
}

/**
 * A record's tag: the first 16 bytes (32 hex) of HMAC-SHA256(secret, UTF-8 of
 * `mf-rec/v2 tag\0${storeId}\0${epoch}\0${locator}`), the epoch in decimal. `secret` is the recording's K (32 bytes),
 * `storeId` storeIdOf the store's path, `epoch` the store's rotation epoch (0 first), `locator` lineLocator or
 * rowLocator.
 */
export function recordTag(secret: Uint8Array, storeId: string, epoch: number, locator: string): string {
  checkSecret(secret);
  if (!HEX32.test(storeId)) throw new Error('recordTag: expected storeId as storeIdOf gives it (64 lowercase hex)');
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`recordTag: expected a non-negative integer epoch, got ${epoch}`);
  if (locator === '') throw new Error('recordTag: expected a locator');
  return hmac16(secret, Buffer.from(`${TAG_DOMAIN}${storeId}\0${epoch}\0${locator}`, 'utf8'));
}

/** A tag's salt: the first 16 bytes (32 hex) of HMAC-SHA256(secret, UTF-8 `mf-rec/v2 salt\0` and the tag's 16 bytes). */
export function recordSalt(secret: Uint8Array, tag: string): string {
  checkSecret(secret);
  return hmac16(secret, Buffer.concat([Buffer.from(SALT_DOMAIN, 'utf8'), bytes16(tag, 'recordSalt tag')]));
}

/**
 * A store's chain id at a rotation epoch: the first 16 bytes (32 hex) of HMAC-SHA256(secret, UTF-8 of
 * `mf-rec/v2 chain\0${storeId}\0${epoch}`).
 */
export function recordChain(secret: Uint8Array, storeId: string, epoch: number): string {
  checkSecret(secret);
  if (!HEX32.test(storeId)) throw new Error('recordChain: expected storeId as storeIdOf gives it (64 lowercase hex)');
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`recordChain: expected a non-negative integer epoch, got ${epoch}`);
  return hmac16(secret, Buffer.from(`${CHAIN_DOMAIN}${storeId}\0${epoch}`, 'utf8'));
}

/**
 * A record's conversation: the first 16 bytes (32 hex) of HMAC-SHA256(secret, UTF-8 of
 * `mf-rec/v2 conv\0${storeId}\0${key}`), `key` the store's conversation key of the record ("" for a store of one).
 */
export function recordConversation(secret: Uint8Array, storeId: string, key: string): string {
  checkSecret(secret);
  if (!HEX32.test(storeId)) throw new Error('recordConversation: expected storeId as storeIdOf gives it (64 lowercase hex)');
  return hmac16(secret, Buffer.from(`${CONV_DOMAIN}${storeId}\0${key}`, 'utf8'));
}

/** A record's body: sha256 hex of UTF-8 `mf-rec/v2 body\0`, the salt's 16 bytes and the record's stable bytes. */
export function recordBody(salt: string, stable: Uint8Array): string {
  return nodeCrypto().createHash('sha256').update(Buffer.from(BODY_DOMAIN, 'utf8')).update(bytes16(salt, 'recordBody salt')).update(stable).digest('hex');
}

/** Where a leaf sits (see the header): its store's chain at the record's epoch, its position there, its conversation. */
export interface ChainLink {
  readonly chain: string;
  readonly n: number;
  readonly conv: string;
}

/**
 * A leaf's c from its tag, link and body: sha256 hex of UTF-8 `mf-rec/v2 leaf\0`, the tag's 16 bytes, the chain's
 * 16, n as 8 bytes big-endian, the conv's 16 and the body's 32. A skip's c is recomputed from exactly these.
 */
export function linkedCommitment(tag: string, link: ChainLink, body: string): string {
  if (!Number.isSafeInteger(link.n) || link.n < 1) throw new Error(`linkedCommitment: expected a 1-based chain position, got ${link.n}`);
  if (!HEX32.test(body)) throw new Error('linkedCommitment body: expected 64 lowercase hex');
  const n = Buffer.alloc(8);
  n.writeBigUInt64BE(BigInt(link.n));
  return nodeCrypto()
    .createHash('sha256')
    .update(Buffer.from(LEAF_DOMAIN, 'utf8'))
    .update(bytes16(tag, 'leafCommitment tag'))
    .update(bytes16(link.chain, 'leafCommitment chain'))
    .update(n)
    .update(bytes16(link.conv, 'leafCommitment conv'))
    .update(Buffer.from(body, 'hex'))
    .digest('hex');
}

/** A record version's c (see the header): linkedCommitment(tag, link, recordBody(salt, stable)). */
export function leafCommitment(tag: string, salt: string, stable: Uint8Array, link: ChainLink): string {
  return linkedCommitment(tag, link, recordBody(salt, stable));
}

/** The locator of a one-conversation store's start state (see the header): its tag is recordTag(K, storeId, epoch, START_LOCATOR). */
export const START_LOCATOR = 'start';

/** A one-conversation store's start state at an epoch (see the header). */
export interface StartState {
  /** The store's chain at the epoch (recordChain). */
  readonly chain: string;
  readonly epoch: number;
  /** The complete records the store file held when the recorder first saw it (0: a store first seen after the start). */
  readonly records: number;
  /** How many of them, the last ones, the baseline committed in chunk 1. */
  readonly baseline: number;
}

/**
 * A start state's c: sha256 hex of UTF-8 `mf-rec/v2 start\0`, the tag's 16 bytes, the salt's 16, the chain's 16, and
 * the epoch, the records and the baseline, each as 8 bytes big-endian.
 */
export function startCommitment(tag: string, salt: string, state: StartState): string {
  const u64 = (n: number, what: string): Buffer => {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`startCommitment: expected a non-negative integer ${what}, got ${n}`);
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
  };
  const counts = [u64(state.epoch, 'epoch'), u64(state.records, 'record count'), u64(state.baseline, 'baseline count')];
  if (state.baseline > state.records) throw new Error('startCommitment: a baseline past the records the store held');
  const h = nodeCrypto()
    .createHash('sha256')
    .update(Buffer.from(START_DOMAIN, 'utf8'))
    .update(bytes16(tag, 'startCommitment tag'))
    .update(bytes16(salt, 'startCommitment salt'))
    .update(bytes16(state.chain, 'startCommitment chain'));
  for (const b of counts) h.update(b);
  return h.digest('hex');
}

/**
 * One projected cell of a witness-table row: its SQLite storage class and value. A BLOB is standard base64, an
 * INTEGER beyond 2^53 a decimal string; projecting, excluding JSON paths and redacting are the enumerator's
 * (transcripts/witness-records.ts).
 */
export type RowCell =
  | readonly ['integer', number | string]
  | readonly ['real', number | string]
  | readonly ['text', string]
  | readonly ['blob', string]
  | readonly ['null', null];

/** A row's stable bytes: the UTF-8 of recordingCanonicalJson({t: table, c: {column: [type, value]}}). */
export function rowStable(table: string, cells: Readonly<Record<string, RowCell>>): Uint8Array {
  return Buffer.from(recordingCanonicalJson({ t: table, c: cells }), 'utf8');
}

/** sha256 of the canonical JSON of a chunk's leaves, in order (chainHash's leaves_sha256). */
export function leavesSha256(leaves: readonly { readonly tag: string; readonly c: string }[]): string {
  return sha256Hex(recordingCanonicalJson(leaves.map((l) => ({ tag: l.tag, c: l.c }))));
}

/** sha256 of the canonical JSON of a tree delta (chainHash's tree_sha256). */
export function treeSha256(tree: TreeDeltaT): string {
  return sha256Hex(recordingCanonicalJson({ set: tree.set.map((f) => ({ path: f.path, sha256: f.sha256 })), removed: [...tree.removed] }));
}

/** What chainHash reads of a chunk request: its seq, its leaves and its tree. */
export interface ChainedChunk {
  readonly seq: number;
  readonly leaves: readonly { readonly tag: string; readonly c: string }[];
  readonly tree: TreeDeltaT | null;
}

/**
 * The chain head a chunk makes: sha256 hex over the canonical JSON of
 * { v: 2, seq, prev_chain, leaves_sha256: leavesSha256(leaves), tree_sha256 }, tree_sha256 being treeSha256(tree) or
 * null. Chunk 1's prevChain is the recording's chain_seed; each later one's the head before it. The request's own
 * prev_chain is not read: the head it extends is the caller's to name.
 */
export function chainHash(prevChain: string, req: ChainedChunk): string {
  return chainHashOf(prevChain, req.seq, leavesSha256(req.leaves), req.tree === null ? null : treeSha256(req.tree));
}

/** chainHash of a chunk known by its seq, its leaves' leavesSha256 and its tree's treeSha256 (null: none). */
export function chainHashOf(prevChain: string, seq: number, leaves: string, tree: string | null): string {
  return sha256Hex(recordingCanonicalJson({ v: 2, seq, prev_chain: prevChain, leaves_sha256: leaves, tree_sha256: tree }));
}
