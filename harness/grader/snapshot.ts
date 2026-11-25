// A snapshot index (server/repos/index-tar.ts, agent-fun/snapshot/v1) built from a directory on
// disk instead of a `git archive` tar: for the house's own entries (bots/baseline-*) and for tests,
// which grade those directories exactly as intake would have stored them. Regular files only, with
// git's two modes (0755 when any execute bit is set, else 0644); symlinks are recorded by their
// target text (never followed); dot-files and node_modules are skipped (git archive of a clean
// checkout would not carry them either). Paths are validated with the intake's own rule.

import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobStore } from '../server/blobstore.ts';
import { canonicalSnapshotJson, comparePaths, SNAPSHOT_FORMAT, validateSnapshotIndex, validateSnapshotPath, type SnapshotEntry, type SnapshotIndex } from '../server/repos/index-tar.ts';

export async function snapshotFromDirectory(dir: string, blobs: Pick<BlobStore, 'put'>): Promise<{ index: SnapshotIndex; snapshotSha256: string }> {
  const files: SnapshotEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const path = validateSnapshotPath(rel === '' ? e.name : `${rel}/${e.name}`);
      const abs = join(dir, path);
      const st = await lstat(abs);
      if (st.isDirectory()) await walk(path);
      else if (st.isSymbolicLink()) {
        const target = Buffer.from(await readlink(abs), 'utf8');
        const put = await blobs.put(target);
        files.push({ path, kind: 'symlink', mode: 0o777, size: target.length, sha256: put.sha256 });
      } else if (st.isFile()) {
        const bytes = await readFile(abs);
        const put = await blobs.put(bytes);
        files.push({ path, kind: 'file', mode: st.mode & 0o111 ? 0o755 : 0o644, size: bytes.length, sha256: put.sha256 });
      }
    }
  };
  await walk('');
  files.sort((a, b) => comparePaths(a.path, b.path));
  const index: SnapshotIndex = { format: SNAPSHOT_FORMAT, commit: null, files };
  validateSnapshotIndex(index);
  const stored = await blobs.put(canonicalSnapshotJson(index));
  return { index, snapshotSha256: stored.sha256 };
}
