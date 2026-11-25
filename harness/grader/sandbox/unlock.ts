// Getting a scratch directory a sandboxed program wrote into ready to delete: a program may leave a
// directory read-only (0555) or closed (0000), and rm cannot empty a directory its owner cannot
// write or enter. What is this process's own it unlocks here; what is the sandbox user's (on Linux,
// 65534's) only that user can unlock (docker.ts RECLAIM_SCRIPT). Its callers: grade.ts removeScratch
// and instance.ts removeRun, before they hand the writable directories to sandbox.removeTree.

import { chmod, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** This process's own entry (every entry, where the platform has no uids). */
export function isOwn(st: { uid: number }): boolean {
  const uid = process.getuid?.();
  return uid === undefined || st.uid === uid;
}

/**
 * Give this process's own directories under `dir` (itself included) their owner's rwx back, keeping
 * every other bit: a writable mount stays 0777, so the sandbox user can still enter it to delete what
 * it wrote. Never follows a link; another user's directory, and all under it, is left to the sandbox.
 * Never throws: what it cannot unlock is left as it was.
 */
export async function unlockOwn(dir: string): Promise<void> {
  let st;
  try {
    st = await lstat(dir);
  } catch {
    return;
  }
  if (!st.isDirectory() || !isOwn(st)) return;
  if ((st.mode & 0o700) !== 0o700) {
    try {
      await chmod(dir, (st.mode & 0o7777) | 0o700);
    } catch {
      return;
    }
  }
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) await unlockOwn(join(dir, e.name));
}
