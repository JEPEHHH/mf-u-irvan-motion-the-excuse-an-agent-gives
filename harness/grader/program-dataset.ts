// A program dataset (contracts/program-dataset.ts, agent-fun/program-dataset/v1) read from its directory: the verifier
// registration runs before a row is written (grader/dataset.ts VERIFY_FORMAT 'program', and a repoint's), and the
// reader a final_dataset program/v1 grade runs before it mounts the trees (grader/worker.ts programPhaseSetup).
//
// verifyProgramDataset(dir) checks, and reports every problem it finds rather than the first:
//   - manifest.json parses as ProgramDatasetManifest (schema, order, digests of the listing) and its id is the
//     directory's name;
//   - the directory holds manifest.json, input/ and reference/ and nothing else, and input/ and reference/ hold exactly
//     the files listed: no other file, no symbolic link, no special file, no empty directory a listing could not name.
//     Neither tree is ever one of no file (the manifest refuses a listing with none under input/ or under reference/:
//     contracts/program-dataset.ts programDatasetFilesIssues), so a copy that carries files only (the tier mirror off
//     the data claim, server/blob-tier/mirror.ts, which drops a directory of no file) holds both, and a tree that is
//     not there is missing, never the empty tree an instance's may be (grader/worker.ts EMPTY_TREE_SHA256);
//   - every listed file's size and sha256 are its bytes';
//   - input_sha256 and reference_sha256 are the tree digests of input/ and reference/ (grader/version.ts
//     directoryDigest, the sealed-path digest), and data_sha256 the program-data digest of the two (grader/program.ts
//     programDataSha256, which a run graded on it records as its dataset_sha256), which the manifest's own refinement
//     derives from the listing checked here (tests/unit/program-dataset.test.ts holds the two formats to one).
// readFrozenProgramDataset(dir, {expectSha256}) runs it, then holds the manifest's canonical sha256 to the row's: any
// mismatch is a DatasetIntegrityError, never retried.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PROGRAM_DATASET_INPUT_DIR, PROGRAM_DATASET_REFERENCE_DIR, ProgramDatasetManifest, type ProgramDatasetManifestT } from '../contracts/program-dataset.ts';
import { canonicalSha256 } from '../sim/canonical.ts';
import { directoryDigest } from './version.ts';

export const PROGRAM_DATASET_MANIFEST = 'manifest.json';

/** A program dataset that does not verify, or not as the row it is read for: the job cannot mend it by retrying. */
export class ProgramDatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgramDatasetError';
  }
}

/** Every entry under `root/rel`, as [relative path, kind], walking directories (never a link). */
function walk(root: string, rel: string, out: Array<[string, 'file' | 'dir' | 'other']>): void {
  for (const name of readdirSync(join(root, rel)).sort()) {
    const p = `${rel}/${name}`;
    const st = lstatSync(join(root, p));
    if (st.isDirectory()) {
      out.push([p, 'dir']);
      walk(root, p, out);
    } else out.push([p, st.isFile() ? 'file' : 'other']);
  }
}

/** The manifest.json of `dir` as written, parsed as JSON (null when it does not read). */
export function readProgramManifestRaw(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, PROGRAM_DATASET_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

/** The header's checks over `dir`: ok with no problems, or every problem found. */
export function verifyProgramDataset(dir: string): { ok: boolean; problems: string[]; manifest: ProgramDatasetManifestT | null } {
  const problems: string[] = [];
  const raw = readProgramManifestRaw(dir);
  if (raw === null) return { ok: false, problems: [`${PROGRAM_DATASET_MANIFEST} does not read as JSON`], manifest: null };
  const parsed = ProgramDatasetManifest.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 5).map((i) => `${PROGRAM_DATASET_MANIFEST} ${i.path.join('.') || '(root)'}: ${i.message}`), manifest: null };
  }
  const m = parsed.data;
  if (m.id !== basename(dir)) problems.push(`the manifest's id is ${m.id}, and the directory is ${basename(dir)}: a dataset's id is its directory's name`);
  let top: string[];
  try {
    top = readdirSync(dir).sort();
  } catch (err) {
    return { ok: false, problems: [`${dir} does not read: ${(err as Error).message}`], manifest: m };
  }
  const want = [PROGRAM_DATASET_INPUT_DIR, PROGRAM_DATASET_MANIFEST, PROGRAM_DATASET_REFERENCE_DIR].sort();
  if (JSON.stringify(top) !== JSON.stringify(want)) problems.push(`the directory holds ${JSON.stringify(top)}, not exactly ${JSON.stringify(want)}`);
  const listed = new Map(m.files.map((f) => [f.path, f]));
  const seen = new Set<string>();
  for (const tree of [PROGRAM_DATASET_INPUT_DIR, PROGRAM_DATASET_REFERENCE_DIR]) {
    let st;
    try {
      st = lstatSync(join(dir, tree));
    } catch {
      problems.push(`${tree}/ is missing`);
      continue;
    }
    if (!st.isDirectory()) {
      problems.push(`${tree} is not a directory`);
      continue;
    }
    const entries: Array<[string, 'file' | 'dir' | 'other']> = [];
    walk(dir, tree, entries);
    for (const [p, kind] of entries) {
      if (kind === 'other') problems.push(`${p} is not a regular file or a directory (a link or a special file)`);
      else if (kind === 'dir') {
        if (![...listed.keys()].some((f) => f.startsWith(`${p}/`))) problems.push(`${p}/ holds no listed file`);
      } else {
        const f = listed.get(p);
        if (f === undefined) {
          problems.push(`${p} is not listed in the manifest`);
          continue;
        }
        seen.add(p);
        const bytes = readFileSync(join(dir, p));
        if (bytes.length !== f.size) problems.push(`${p} is ${bytes.length} bytes, the manifest says ${f.size}`);
        else if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) problems.push(`${p} does not hash to the manifest's sha256`);
      }
    }
  }
  for (const p of listed.keys()) if (!seen.has(p)) problems.push(`${p} is listed and not there`);
  if (problems.length === 0) {
    if (directoryDigest(join(dir, PROGRAM_DATASET_INPUT_DIR)) !== m.input_sha256) problems.push('input_sha256 is not the tree digest of input/');
    if (directoryDigest(join(dir, PROGRAM_DATASET_REFERENCE_DIR)) !== m.reference_sha256) problems.push('reference_sha256 is not the tree digest of reference/');
  }
  return { ok: problems.length === 0, problems, manifest: m };
}

/** grader/dataset.ts's window-manifest reader for this format: the verified manifest as written and its canonical sha256. */
export function readVerifiedProgramManifest(dir: string): { raw: unknown; sha256: string } {
  const v = verifyProgramDataset(dir);
  if (!v.ok) throw new ProgramDatasetError(`the program dataset at ${dir} does not verify: ${v.problems.slice(0, 5).join('; ')}`);
  const raw = readProgramManifestRaw(dir);
  return { raw, sha256: canonicalSha256(raw) };
}

/** A program dataset's trees, verified and held to the row's sha256 (the header). */
export interface FrozenProgramDataset {
  manifest: ProgramDatasetManifestT;
  /** The manifest's canonical sha256: the dataset row's. */
  sha256: string;
  inputDir: string;
  referenceDir: string;
}

export function readFrozenProgramDataset(dir: string, o: { expectSha256: string }): FrozenProgramDataset {
  const { raw, sha256 } = readVerifiedProgramManifest(dir);
  if (sha256 !== o.expectSha256) throw new ProgramDatasetError(`the program dataset at ${dir} hashes to ${sha256}, not its row's ${o.expectSha256}`);
  return { manifest: ProgramDatasetManifest.parse(raw), sha256, inputDir: join(dir, PROGRAM_DATASET_INPUT_DIR), referenceDir: join(dir, PROGRAM_DATASET_REFERENCE_DIR) };
}
