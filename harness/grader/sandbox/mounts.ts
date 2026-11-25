// A spec's mounts, checked once for every driver (types.ts's header: the mount contract). Each mount
// names one of MOUNT_POINTS, once, a host directory a `-v` argument or a pod's volume can carry
// (checkHostPath, or the driver's own check: checkSandboxMounts' checkHost), and whether the program may
// write there. A writable mount also names:
//
//   returns   how much may come back once it has ended: entries and bytes (`maxEntries`, `maxBytes`),
//             the harness's own caps exactly. Required: every writable mount says it, on every driver, so a
//             spec that runs under the process driver in a test is one a copying driver can carry. A copying
//             driver returns the one entry past a cap too (the entry that breaks it), so the harness sees
//             the breach in the tree it gets back; past it is the fault of whoever owns the mount (a
//             service's is a void pass), never a silent cut.
//   live      optional: the files the harness reads while the program runs (a ready file, a replay's
//             miss, a house-clock log with `follow`): relative plain paths under the mount, each once.
//             While the program runs a driver keeps only these in step with the program's tree; the rest
//             of the mount comes back once `exited` settles. Absent: nothing of it is read before then.
//
// The harness's caps (the claim-less plan's D7, at the caps exactly): an entry's or a generator's /output
// at its own output caps (program.ts OUTPUT_RETURNS, instance.ts INSTANCE_RETURNS: 1,000 entries,
// 64 MiB), judged the entry's as today; a scorer's /scores at SCORES_RETURNS; a trial env's /state at
// STATE_RETURNS; a forwarder's or a scrape gateway's /record at RECORD_RETURNS.
//
// A read-only mount names neither: nothing comes back from it, and nothing of it changes while the
// program runs. The docker and process drivers bind the host directory itself, so every file of a
// writable mount is live there and all of it is already back: they check both fields and need nothing
// more of them.

import { checkHostPath, MOUNT_POINTS, SandboxError, type SandboxLiveFile, type SandboxMount, type SandboxReturns } from './types.ts';

const MiB = 1024 * 1024;
/** A scorer's (or a checker driver's) /scores: run.json in, scores.json, checks.json or verdicts.json out. */
export const SCORES_RETURNS: SandboxReturns = Object.freeze({ maxEntries: 16, maxBytes: MiB });
/** A trial env's /state: its ready file, its call log and its export (agent.ts storeExport: 1,000 entries, 64 MiB). */
export const STATE_RETURNS: SandboxReturns = Object.freeze({ maxEntries: 2_000, maxBytes: 256 * MiB });
/** A forwarder's or a scrape gateway's /record: its ready and result files, its cassette and every body or blob of it. */
export const RECORD_RETURNS: SandboxReturns = Object.freeze({ maxEntries: 10_000, maxBytes: 1024 * MiB });

/** The most `live` files one mount names: a few ready files and logs, never a tree. */
export const MAX_LIVE_FILES = 8;
/** A `live` path's length cap, in bytes (one name of a few components, well inside any driver's path cap). */
export const MAX_LIVE_PATH_BYTES = 255;
/** A `live` path: relative POSIX components of [A-Za-z0-9._-], none starting with `.` or `-` (so no `..`, no dot-file, no glob). */
const LIVE_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/**
 * The spec's mounts, checked (the header): a list of {host, at, readOnly} with `at` one of MOUNT_POINTS and none twice,
 * `host` a path `checkHost` takes, `readOnly` a boolean; `live` and `returns` only on a writable mount, each as
 * checkLiveFiles and checkReturns take it, and `returns` on every writable one. The same list, in its order;
 * SandboxError on the first fault. `checkHost` is the driver's host-path check: checkHostPath (the default) for every
 * driver that mounts or copies a host directory, process.ts's checkProcessHostPath for its platform, which names a host
 * path only in the child's cwd and environment and so also takes a Windows drive-letter path there.
 */
export function checkSandboxMounts(
  mounts: readonly SandboxMount[] | undefined,
  checkHost: (path: string) => string = checkHostPath,
): readonly SandboxMount[] {
  if (mounts === undefined) return [];
  if (!Array.isArray(mounts)) throw new SandboxError(`mounts must be a list, not ${JSON.stringify(mounts)}`);
  const seen = new Set<string>();
  for (const m of mounts as readonly SandboxMount[]) {
    if (typeof m !== 'object' || m === null) throw new SandboxError(`a mount must be {host, at, readOnly}, not ${JSON.stringify(m)}`);
    if (!Object.hasOwn(MOUNT_POINTS, m.at)) throw new SandboxError(`${JSON.stringify(m.at)} is not a mount point (${Object.keys(MOUNT_POINTS).join(', ')})`);
    if (seen.has(m.at)) throw new SandboxError(`${m.at} is mounted twice`);
    seen.add(m.at);
    checkHost(m.host);
    if (typeof m.readOnly !== 'boolean') throw new SandboxError(`${m.at}'s readOnly must be true or false, not ${JSON.stringify(m.readOnly)}`);
    if (m.readOnly) {
      if (m.live !== undefined) throw new SandboxError(`${m.at} is read-only: nothing of it is live`);
      if (m.returns !== undefined) throw new SandboxError(`${m.at} is read-only: nothing of it comes back`);
      continue;
    }
    if (m.live !== undefined) checkLiveFiles(m.at, m.live);
    if (m.returns === undefined) throw new SandboxError(`${m.at} is writable: it must say how much of it may come back (returns {maxEntries, maxBytes})`);
    checkReturns(m.at, m.returns);
  }
  return mounts;
}

/** A writable mount's `live` files, checked: at most MAX_LIVE_FILES of {path, follow?}, each path LIVE_PATH_RE's and at most MAX_LIVE_PATH_BYTES, none twice, `follow` a boolean or absent. */
export function checkLiveFiles(at: string, live: readonly SandboxLiveFile[]): readonly SandboxLiveFile[] {
  if (!Array.isArray(live)) throw new SandboxError(`${at}'s live files must be a list, not ${JSON.stringify(live)}`);
  if (live.length > MAX_LIVE_FILES) throw new SandboxError(`${at} names ${live.length} live files: a mount names at most ${MAX_LIVE_FILES}`);
  const paths = new Set<string>();
  for (const f of live as readonly SandboxLiveFile[]) {
    if (typeof f !== 'object' || f === null) throw new SandboxError(`${at}'s live file must be {path, follow?}, not ${JSON.stringify(f)}`);
    const path = f.path;
    if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > MAX_LIVE_PATH_BYTES || !LIVE_PATH_RE.test(path)) {
      throw new SandboxError(`${at}'s live path ${JSON.stringify(path)} must be a relative plain path of at most ${MAX_LIVE_PATH_BYTES} bytes ([A-Za-z0-9._-] components, none starting with . or -)`);
    }
    if (paths.has(path)) throw new SandboxError(`${at}'s live path ${path} is named twice`);
    paths.add(path);
    if (f.follow !== undefined && typeof f.follow !== 'boolean') throw new SandboxError(`${at}'s live file ${path}: follow must be true, false or absent, not ${JSON.stringify(f.follow)}`);
  }
  return live;
}

/** A writable mount's `returns`, checked: {maxEntries, maxBytes}, both positive safe integers. */
export function checkReturns(at: string, returns: SandboxReturns): SandboxReturns {
  if (typeof returns !== 'object' || returns === null || !Number.isSafeInteger(returns.maxEntries) || returns.maxEntries <= 0 || !Number.isSafeInteger(returns.maxBytes) || returns.maxBytes <= 0) {
    throw new SandboxError(`${at}'s returns must be {maxEntries, maxBytes}, both positive integers, not ${JSON.stringify(returns)}`);
  }
  return returns;
}
