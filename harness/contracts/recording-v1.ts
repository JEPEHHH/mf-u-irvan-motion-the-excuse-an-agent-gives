// v1 reader: kept for makefun-frontend-01's stored entries
//
// The older recording wire, makefun-recording/v1, the one the strict competitions sealed while it was current
// (makefun-frontend-01) recorded on, beside wire v2 (contracts/recording.ts): main's contract as of c40a5fa, unchanged
// on the wire. RECORDING_FORMAT_V1, what a stored v1 row's transcript_recording.format says, is the v1 reader's: it
// tells a v1 entry's recordings apart (server/recordings/witness.ts loadEntryWitnessFacts, server/recordings/v1/witness.ts,
// server/entries/thinking-v1.ts, server/routes/admin/provenance.ts), so makefun-frontend-01's stored entries stay
// readable and can be gated again (a regrade, an audit) for good.
//
// v1 intake: delete after 2026-11-18T00:40Z (makefun-frontend-01's final): the rest is the wire a v1 kit streams.
// While the entrant's AI agent works, a v1 `makefun record` streams the agent's append-only JSONL session logs (Claude
// Code and Codex alone) and the repository's working-tree file hashes to make.fun as hash-chained chunks, and the site
// stamps each chunk with the time it received it (ChunkResponse.received_at). The entry's transcript is then built by
// the site from the sealed recordings alone (server/recordings/v1/assemble.ts), never uploaded, and the gate check
// transcripts_witnessed (server/entries/thinking-v1.ts) holds every session line and every committed file to the times
// the site witnessed them.
//
//   start     POST /api/competitions/:slug/recordings answers RecordingStartResponseV1: the recording's id and
//             chain_seed (no format: a v1 kit's parse is strict).
//   chunks    POST /api/recordings/:id/chunks takes ChunkRequestV1, strictly in seq order: each names the chain
//             head it extends (prev_chain), the new complete lines of each session file (ChunkFileV1: the bytes
//             at the file's next offset, or the whole file again with rewrite when its sent prefix changed)
//             and the working tree's change since the last chunk (TreeDelta; the first carries the whole set).
//             The answer, ChunkResponse, is the new head (chainHashV1) and the server's receipt time.
//   finish    POST /api/recordings/:id/finish (no body) seals it: RecordingFinishResponseV1 names every file's
//             assembled sha256, the sha256s an entry message's Transcripts line is computed from.
//
// Pure: zod and the v2 contract's shared primitives (TreeDelta, the canonical JSON, sha256Hex), no I/O.

/** The older wire's format: what transcript_recording.format says of a v1 row (server/db/schema.ts RECORDING_FORMAT_V1). */
export const RECORDING_FORMAT_V1 = 'makefun-recording/v1';

// v1 intake: delete after 2026-11-18T00:40Z (makefun-frontend-01's final)
import { z } from 'zod';
import { TranscriptSource } from './bundle.ts';
import { IsoDateTime, Sha256Hex, Slug } from './primitives.ts';
import { RecordingArchiveName, RecordingId, recordingCanonicalJson, sha256Hex, treeSha256, TreeDelta } from './recording.ts';

/** The most files one v1 chunk may carry. */
export const MAX_CHUNK_FILES_V1 = 256;

/** A session file's key within a recording: `<source>:` and 24 hex of the sha256 of its absolute path (fileKeyOfV1). */
export const FileKeyV1 = z.string().max(80).regex(/^[a-z0-9-]+:[0-9a-f]{24}$/, 'expected <source>:<24 hex>');

/** The harnesses a v1 `makefun record` streams: one append-only JSONL file each, every line of which carries its time. */
export const RECORDED_SOURCES_V1 = ['claude-code', 'codex'] as const satisfies readonly z.infer<typeof TranscriptSource>[];

/** Whether `source` is one a v1 recorder streams (RECORDED_SOURCES_V1). */
export function isRecordedSourceV1(source: string): boolean {
  return (RECORDED_SOURCES_V1 as readonly string[]).includes(source);
}

/** A recorded session file's name ends in .jsonl (any case). */
export const RECORDED_ARCHIVE_NAME_V1 = /\.jsonl$/i;

/** A v1 start's answer: no format (a v1 kit parses it strictly, so a field it does not know fails its start). */
export const RecordingStartResponseV1 = z.strictObject({
  recording_id: RecordingId,
  competition: Slug,
  started_at: IsoDateTime,
  /** The server's random nonce (32 bytes, hex): chunk 1's prev_chain. */
  chain_seed: Sha256Hex,
});

/**
 * The new complete lines of one session file (or, with rewrite, the whole file again): a file of a source the v1
 * recorder streams (RECORDED_SOURCES_V1), named `.jsonl`.
 */
export const ChunkFileV1 = z
  .strictObject({
    file_key: FileKeyV1,
    source: TranscriptSource.refine(isRecordedSourceV1, {
      error: (iss) => `source ${JSON.stringify(iss.input)}: a recording carries only the session files makefun record streams, of source ${RECORDED_SOURCES_V1.join(', ')} (their append-only JSONL logs)`,
    }),
    archive_path: RecordingArchiveName.refine((n) => RECORDED_ARCHIVE_NAME_V1.test(n), {
      error: (iss) => `${JSON.stringify(iss.input)}: a recorded session file is an append-only JSONL log named .jsonl, whose every line the site witnesses (a JSON document or any other file is not recorded)`,
    }),
    /** Where these bytes start in the file: the bytes already sent for it (0 with rewrite). */
    offset: z.int().min(0),
    /** The bytes, standard base64: complete lines only, ending in \n. */
    bytes_b64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'expected standard base64'),
    /** sha256 of the decoded bytes. */
    sha256: Sha256Hex,
    /** The file's already-sent prefix changed: these bytes replace its whole content (offset 0). Strict mode fails a rewritten file. */
    rewrite: z.boolean().default(false),
  })
  .refine((f) => !f.rewrite || f.offset === 0, { message: 'a rewrite starts at offset 0', path: ['offset'] });

export const ChunkRequestV1 = z.strictObject({
  /** 1 for the first chunk, then one more each: the recording's last stored seq plus one. */
  seq: z.int().min(1),
  /** The chain head this chunk extends: chain_seed for chunk 1, else the previous chunk's ChunkResponse.chain. */
  prev_chain: Sha256Hex,
  /** The session files with new bytes, in the order chainHashV1 hashes them; none for a heartbeat. */
  files: z.array(ChunkFileV1).max(MAX_CHUNK_FILES_V1),
  /** The working tree's change since the last chunk, or null for none. */
  tree: TreeDelta.nullable(),
});

/** One sealed file of a v1 recording: its whole assembled content's size and sha256. */
export const RecordingFinishFileV1 = z.strictObject({
  file_key: FileKeyV1,
  source: TranscriptSource,
  archive_path: RecordingArchiveName,
  bytes: z.int().min(0),
  sha256: Sha256Hex,
  /** Some chunk replaced the file's content (ChunkFileV1.rewrite): strict mode fails its sessions. */
  rewritten: z.boolean(),
});

export const RecordingFinishResponseV1 = z.strictObject({
  recording_id: RecordingId,
  head_chain: Sha256Hex,
  started_at: IsoDateTime,
  sealed_at: IsoDateTime,
  chunks: z.int().min(0),
  files: z.array(RecordingFinishFileV1),
});

export type RecordingStartResponseV1T = z.infer<typeof RecordingStartResponseV1>;
export type ChunkFileV1T = z.infer<typeof ChunkFileV1>;
export type ChunkFileV1InputT = z.input<typeof ChunkFileV1>;
export type ChunkRequestV1T = z.infer<typeof ChunkRequestV1>;
export type ChunkRequestV1InputT = z.input<typeof ChunkRequestV1>;
export type RecordingFinishFileV1T = z.infer<typeof RecordingFinishFileV1>;
export type RecordingFinishResponseV1T = z.infer<typeof RecordingFinishResponseV1>;

/** What chainHashV1 reads of a chunk request: its seq, its files' keys, offsets, sha256s and rewrite flags, and its tree. */
export interface ChainedChunkV1 {
  readonly seq: number;
  readonly files: readonly { readonly file_key: string; readonly offset: number; readonly sha256: string; readonly rewrite?: boolean }[];
  readonly tree: z.infer<typeof TreeDelta> | null;
}

/**
 * The chain head a v1 chunk makes: sha256 hex over the canonical JSON of
 * { v: 1, seq, prev_chain, files: [{ file_key, offset, sha256, rewrite }] in request order, tree_sha256 }, tree_sha256
 * being treeSha256(tree) or null. The request's own prev_chain is not read: the head it extends is the caller's to name.
 */
export function chainHashV1(prevChain: string, req: ChainedChunkV1): string {
  return sha256Hex(
    recordingCanonicalJson({
      v: 1,
      seq: req.seq,
      prev_chain: prevChain,
      files: req.files.map((f) => ({ file_key: f.file_key, offset: f.offset, sha256: f.sha256, rewrite: f.rewrite === true })),
      tree_sha256: req.tree === null ? null : treeSha256(req.tree),
    }),
  );
}

/** A session file's key within a v1 recording: `${source}:` and the first 24 hex of sha256(absolutePath). */
export function fileKeyOfV1(source: string, absolutePath: string): string {
  return `${source}:${sha256Hex(absolutePath).slice(0, 24)}`;
}
