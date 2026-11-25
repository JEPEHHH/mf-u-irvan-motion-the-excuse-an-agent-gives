// The entry's code size as a grader process takes it from a snapshot in its blob store (grader/size.ts weighCodeSize):
// grader/worker.ts for every grade and regrade, cli/grade-local.ts for a local grade and a field's entries, so all of
// them read the same bytes and weigh them the same way.
//
//   the bytes    under the compressed count, every counted entry whole (asked by grader/size.ts weighCodeSize).
//                Each blob it reads (a regular file's bytes, a symlink's target text) is streamed from the blob
//                store the grade materialises its snapshot from (BlobStore.openRead: the plain file or its .zst
//                unpacked), every chunk hashed and the asked bytes kept, in an ArrayBuffer of its own (so it moves
//                to the thread, never a pooled slab); a blob missing, or whose stream does not hash to its sha256 at
//                its size, is RepoIntakeError snapshot_corrupt, as materializing the snapshot finds it
//   the bound    counted entries whose stream passes the model's bound (sim/size-model.ts SIZE_MODEL_MODELED_BYTES,
//                1 MiB) have no compressed size: weighCodeSize refuses them from the index alone
//                (SizeModelBoundError), before a blob is opened, so one weigh holds at most 1 MiB of entry bytes,
//                plus one read chunk of a blob in flight and the model's tables (two copies of about 34 MB: the
//                state after its primer, kept for the thread's life, and the copy a weigh codes on), whatever the
//                snapshot holds (up to its 1 GiB cap)
//   the weigh    sim/size-model.ts compressedSizeMilli, run as the off-thread task grader.size-compressed
//                (.cosmos/rules/off-thread.mdc): the bytes moved to the thread (transfer), its answer a number. A
//                oneshot thread, since a weigh takes up to some seconds (about 7 s for the model's full MiB on an
//                M-series core, 0.26 s more for the primer on a thread's first weigh) and the pooled lane's
//                long-lived threads serve the process's quick tasks. A pool that cannot run it
//                (OFFTHREAD_SATURATED, a timeout, a thread that died) rejects, and the job retries: the model never
//                runs on a grader process's thread. The one other weigher is the command
//                line's (cli/grade-local.ts hands `weigh`): an entrant's own process, not a server's, and inside the
//                kit's one-file bundle (server/kit/cli-bundle.ts) no pool thread can start, since
//                server/offthread/pool.ts finds its thread module beside import.meta.url, the bundle's own
//   bytes count  'bytes-all-files' reads and weighs nothing: codeSize over the index, as before
//
// Not scoring source (grader/version.ts SCORER_SOURCES): what is counted, and how the answer is written, is
// grader/size.ts's; the weight is sim/size-model.ts's; this module only fetches bytes that their sha256 pins and
// hands them over.

import type { ProgramSizeT } from '../contracts/competition.ts';
import type { ScoreSizeT } from '../contracts/score.ts';
import { createHash } from 'node:crypto';
import { BlobCorruptError, BlobNotFoundError, type BlobStore } from '../server/blobstore.ts';
import { defineOffThreadTask, runOffThread } from '../server/offthread/index.ts';
import { RepoIntakeError } from '../server/repos/errors.ts';
import type { SizeModelFile } from '../sim/size-model.ts';
import { weighCodeSize, type CountedSecrets, type SizedEntry, type StarterFile } from './size.ts';

/** The size model's weigh off the main thread: sim/size-model.ts compressedSizeMilli itself, its input the files, its answer thousandths of a byte. */
export const compressedSizeTask = defineOffThreadTask<typeof import('../sim/size-model.ts').compressedSizeMilli>(
  'grader.size-compressed',
  new URL('../sim/size-model.ts', import.meta.url).href,
  'compressedSizeMilli',
  { lane: 'oneshot', heapMb: 256, timeoutMs: 180_000 },
);

/** `files` weighed by the size model on an off-thread pool thread, their bytes moved there (detached here). */
export async function weighOffThread(files: SizeModelFile[], signal?: AbortSignal): Promise<number> {
  const transfer = new Set<ArrayBuffer>();
  const sent = files.map((f) => {
    let bytes = f.bytes;
    // Moved only when the view is the whole of an ArrayBuffer of its own, not yet moved: else a copy is.
    if (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength || transfer.has(bytes.buffer)) bytes = new Uint8Array(bytes);
    transfer.add(bytes.buffer as ArrayBuffer);
    return { path: f.path, bytes };
  });
  return runOffThread(compressedSizeTask, sent, { transfer: [...transfer], ...(signal === undefined ? {} : { signal }) });
}

/**
 * The reader snapshotCodeSize hands weighCodeSize: an entry's first `bytes` bytes from `blobs` (weighCodeSize asks
 * them all), its blob streamed whole through its sha256 (any rest hashed, never kept), stopped at `signal`'s abort. A blob
 * missing, longer or shorter than its entry's size, or not hashing to its sha256, is RepoIntakeError snapshot_corrupt.
 */
export function snapshotReader(blobs: Pick<BlobStore, 'openRead'>, signal?: AbortSignal): (e: SizedEntry, bytes: number) => Promise<Uint8Array> {
  return async (e, bytes) => {
    signal?.throwIfAborted();
    let stream: Awaited<ReturnType<BlobStore['openRead']>>;
    try {
      stream = await blobs.openRead(e.sha256);
    } catch (err) {
      if (err instanceof BlobNotFoundError) throw new RepoIntakeError('snapshot_corrupt', `blob for ${e.path} is missing`, { cause: err });
      throw err;
    }
    const kept = new Uint8Array(bytes);
    const hash = createHash('sha256');
    let n = 0;
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        signal?.throwIfAborted();
        hash.update(chunk);
        if (n < bytes) kept.set(chunk.subarray(0, Math.min(chunk.byteLength, bytes - n)), n);
        n += chunk.byteLength;
        if (n > e.size) break; // longer than its entry: no use reading on
      }
    } catch (err) {
      if (err instanceof BlobCorruptError) throw new RepoIntakeError('snapshot_corrupt', `blob for ${e.path} is corrupt`, { cause: err });
      throw err;
    } finally {
      stream.destroy();
    }
    if (n !== e.size || hash.digest('hex') !== e.sha256) throw new RepoIntakeError('snapshot_corrupt', `blob for ${e.path} is corrupt`);
    return kept;
  };
}

/**
 * How snapshotCodeSize weighs: `signal` stops it; `weigh` is the command line's own weigher (the header), absent the
 * off-thread pool's; `secrets` the entry's secrets as a count under `count_secrets: true` counts them (grader/size.ts
 * countSecrets of the rows every run of the entry gets), read by no count without the switch.
 */
export interface SnapshotCodeSizeOptions {
  signal?: AbortSignal | undefined;
  weigh?: (files: SizeModelFile[]) => Promise<number>;
  secrets?: CountedSecrets | undefined;
}

/**
 * The entry's code size under `count` over its snapshot's `entries`, less the kit's `starter` files kept as handed
 * (grader/size.ts weighCodeSize): under the compressed count the counted entries read from `blobs` (snapshotReader) and weighed
 * off the main thread (weighOffThread, or o.weigh), stopped at o.signal's abort; under 'bytes-all-files' codeSize,
 * nothing read. Under `count_secrets: true` o.secrets added (grader/size.ts: the header's entry secrets).
 */
export function snapshotCodeSize(count: ProgramSizeT, entries: readonly SizedEntry[], starter: readonly StarterFile[], blobs: BlobStore, o: SnapshotCodeSizeOptions = {}): Promise<ScoreSizeT> {
  const { signal } = o;
  return weighCodeSize(
    count,
    entries,
    starter,
    {
      read: snapshotReader(blobs, signal),
      weigh: (files) => {
        signal?.throwIfAborted();
        return o.weigh === undefined ? weighOffThread(files, signal) : o.weigh(files);
      },
    },
    o.secrets,
  );
}
