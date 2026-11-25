// A bundle's own trees on the k8s sandbox's data claim (MAKEFUN_SANDBOX=k8s). Every host path a sandbox pod is staged
// from or collected into lies under the data root (k8s.ts checkUnderDataRoot: a host path outside MAKEFUN_K8S_DATA_ROOT
// is refused, though no sandbox pod mounts the claim), and the trees a program/v1 bundle carries itself (its input/,
// its reference/, its scorer directory) are read from the worker image's competitions/<slug>/, outside it. So before a
// grade's pods are made, each such tree is copied once onto the claim, content-addressed by its tree digest
// (server/competitions/load.ts treeSha256), and staged into the pods from there (grader/worker.ts stageProgramSetup);
// the docker and process drivers mount the image's paths as they are.
//
//   <data root>/bundle-trees/<slug>/<digest>/<rel>    rel the tree's path in the bundle (input, reference, scorer);
//                                                     '.' (a scorer at the competition root) is <digest>/ itself
//
// The digest is the one the harness seals the tree to (scorer_sha256, input_sha256, reference_sha256), else (an
// unsealed bundle, or a drawn instance's tree) the source's own, read as the stage is asked for. A tree is copied into
// a scratch name beside its place (.<name>-<pid>-<12 hex>), never through a link (a symbolic link, a device, a socket
// or a FIFO in the source is refused, as treeSha256 refuses one), its files 0444 and its directories 0555 (the sandbox
// user reads them, nothing writes them); the copy is re-hashed and renamed into place only when it digests to the
// digest asked for. A source that does not is a BundleTreeError: the image does not hold the tree the bundle seals,
// which is the platform's fault, never an entry's (the worker makes it a PlatformFaultError). The scratch sits in the
// directory its tree lands in, so the rename never moves a directory to another parent (which takes write access to
// the read-only tree itself). A rename lands only where nothing is: two graders staging one tree at once leave one and
// both use it, and a reader never sees half a tree. A stage already in place is re-hashed every time it is asked for
// and used when it digests to its name (the source is not read then); one that does not (damaged, or a dead stager's)
// is looked at once more, then removed and staged again. A scratch name a stager that died left is removed once it is
// an hour old. Nothing else removes a stage: it is the bundle's, small, and every later grade of it reuses it.

import { randomBytes } from 'node:crypto';
import { constants, lstatSync, readdirSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { removePackTree, TreeDigestError, treeSha256 } from '../../server/competitions/load.ts';
import { SandboxError, type Sandbox } from './types.ts';

/** The directory under the data root that holds the staged bundle trees. */
export const BUNDLE_TREES_DIR = 'bundle-trees';
/** A stager's scratch name untouched this long was left by one that died (a bundle tree copies in well under a second). */
export const STALE_STAGE_SCRATCH_MS = 60 * 60 * 1000;
/** A staged file's mode, and a staged directory's: read by anyone, written by no one. */
export const STAGED_FILE_MODE = 0o444;
export const STAGED_DIR_MODE = 0o555;

const DIGEST_RE = /^[0-9a-f]{64}$/;
/** A slug or a bundle path segment as it may stand in a host path a pod mounts (types.ts checkHostPath), never `.` or `..`. */
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** Why a bundle tree cannot be staged: its source is not a tree of directories and regular files, or not the one asked for. */
export class BundleTreeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BundleTreeError';
  }
}

/** A staged tree: where it is, the stage directory of its digest (<data root>/bundle-trees/<slug>/<digest>), its digest, and whether it was there already. */
export interface StagedTree {
  dir: string;
  root: string;
  digest: string;
  reused: boolean;
}

/**
 * The data root every tree a sandbox's pods are staged from lies under (K8sSandbox.dataRoot) when it is the k8s driver;
 * null for the docker and process drivers, which mount the host's paths as they are. A k8s sandbox without one is a
 * SandboxError.
 */
export function k8sDataRoot(sandbox: Pick<Sandbox, 'kind'> & { readonly dataRoot?: unknown }): string | null {
  if (sandbox.kind !== 'k8s') return null;
  const root = sandbox.dataRoot;
  if (typeof root !== 'string' || root === '') throw new SandboxError('the k8s sandbox names no data root (K8sSandbox.dataRoot, MAKEFUN_K8S_DATA_ROOT)');
  return root;
}

/** Where the tree `rel` of digest `digest` is staged for `slug` under `dataRoot`: its directory and its digest's stage directory (the header). */
export function bundleTreePath(dataRoot: string, slug: string, digest: string, rel: string): { dir: string; root: string } {
  if (!DIGEST_RE.test(digest)) throw new RangeError(`${JSON.stringify(digest)} is not a tree digest`);
  if (!SEGMENT_RE.test(slug)) throw new BundleTreeError(`slug ${JSON.stringify(slug)} cannot name a directory on the data claim`);
  const segments = rel === '.' ? [] : rel.split('/');
  if (segments.some((s) => !SEGMENT_RE.test(s))) throw new BundleTreeError(`bundle path ${JSON.stringify(rel)} is not a plain relative path a pod can mount`);
  const root = join(dataRoot, BUNDLE_TREES_DIR, slug, digest);
  return { dir: join(root, ...segments), root };
}

/**
 * Stage the bundle tree at `source` (the bundle's `rel`, of `slug`) under `dataRoot` (the header), as digest `digest`
 * (null: the source's own), and say where it is. Throws BundleTreeError when the source is not a tree treeSha256
 * digests, or does not digest to `digest`; what the file system refuses (no room, no write access) as it threw it.
 */
export async function stageBundleTree(o: { dataRoot: string; slug: string; source: string; rel: string; digest: string | null }): Promise<StagedTree> {
  if (o.digest !== null && !DIGEST_RE.test(o.digest)) throw new RangeError(`${JSON.stringify(o.digest)} is not a tree digest`);
  const digest = o.digest ?? digestOf(o.source, o.source);
  const { dir, root } = bundleTreePath(o.dataRoot, o.slug, digest, o.rel);
  if (rehashes(dir, digest)) return { dir, root, digest, reused: true };
  // Damaged, or a dead stager's: staged again. Looked at once more first, so a tree another stager has just put in
  // place (a rename only ever lands where nothing is) is used, never removed under its reader.
  if (present(dir)) {
    if (rehashes(dir, digest)) return { dir, root, digest, reused: true };
    removePackTree(dir);
  }
  checkSourceDir(o.source);
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const prefix = `.${basename(dir)}-`;
  sweepStaleScratch(parent, prefix);
  const scratch = join(parent, `${prefix}${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await copyTree(o.source, scratch);
    const copied = digestOf(scratch, o.source);
    if (copied !== digest) {
      throw new BundleTreeError(
        o.digest === null
          ? `${o.source} changed while it was copied: the copy digests to ${copied}, not ${digest}`
          : `${o.source} digests to ${copied}, not the sealed ${digest}: the image does not hold the tree the bundle seals`,
      );
    }
    try {
      await rename(scratch, dir);
    } catch (err) {
      // Another stager placed it first.
      if (!rehashes(dir, digest)) throw err;
    }
  } finally {
    removePackTree(scratch);
  }
  if (!rehashes(dir, digest)) throw new BundleTreeError(`${o.source} does not re-hash where it was staged (${dir})`);
  return { dir, root, digest, reused: false };
}

/** A BundleTreeError unless `source` is a directory (a lone file digests under its own name, which a copy does not keep). */
function checkSourceDir(source: string): void {
  let st;
  try {
    st = lstatSync(source);
  } catch {
    throw new BundleTreeError(`${source} does not exist`);
  }
  if (!st.isDirectory()) throw new BundleTreeError(`${source} is not a directory`);
}

/** treeSha256 of the directory `path`, or a BundleTreeError naming `source` (`path` itself, or the tree it is a copy of). */
function digestOf(path: string, source: string): string {
  if (path === source) checkSourceDir(source);
  try {
    return treeSha256(path);
  } catch (err) {
    if (!(err instanceof TreeDigestError)) throw err;
    throw new BundleTreeError(`${source}${err.rel === '' ? '' : `/${err.rel}`} ${err.reason}: a staged tree holds directories and regular files only`, { cause: err });
  }
}

/** Whether `path` is there and digests to `digest` (treeSha256); false for anything it cannot digest. */
function rehashes(path: string, digest: string): boolean {
  try {
    return treeSha256(path) === digest;
  } catch (err) {
    if (err instanceof TreeDigestError) return false;
    throw err;
  }
}

/** Whether anything is at `path` (never following a link). */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove the scratch names under `parent` starting `prefix` that a stager which died left (STALE_STAGE_SCRATCH_MS). */
function sweepStaleScratch(parent: string, prefix: string): void {
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix) || !/^\d+-[0-9a-f]{12}$/.test(name.slice(prefix.length))) continue;
    const abs = join(parent, name);
    try {
      if (Date.now() - lstatSync(abs).mtimeMs > STALE_STAGE_SCRATCH_MS) removePackTree(abs);
    } catch {
      // removed meanwhile
    }
  }
}

/**
 * Copy the directory `src` to `dst` (which must not exist), never through a link: its files STAGED_FILE_MODE, each
 * directory STAGED_DIR_MODE once everything in it is copied.
 */
async function copyTree(src: string, dst: string): Promise<void> {
  await mkdir(dst, { mode: 0o700 });
  for (const name of await readdir(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    const st = await lstat(from);
    if (st.isDirectory()) await copyTree(from, to);
    else if (st.isFile()) {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, STAGED_FILE_MODE);
    } else throw new BundleTreeError(`${src}/${name} ${st.isSymbolicLink() ? 'is a symbolic link' : 'is not a regular file'}: a staged tree holds directories and regular files only`);
  }
  await chmod(dst, STAGED_DIR_MODE);
}
