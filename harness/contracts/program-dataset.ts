// agent-fun/program-dataset/v1: a program/v1 phase's data recorded after the bundle was published, frozen as a dataset
// directory and attached to the phase like a replay's window (`npm run admin:dataset -- --dir <dir> --slug <id> --sealed
// --attach <competition>:final`, server/admin/dataset-register.ts). A program/v1 bundle's own input_data and
// reference_data are fixed when it is published, an instance's by its generator and a pack's by the digests the bundle
// names, so none of them can hold data that exists only after the deadline. A harness that names final_dataset
// (contracts/competition.ts ProgramHarness.final_dataset) grades its final phase on this instead: the entry reads
// input/ at /input and the scorer reads reference/ at /reference, exactly as a bundle's own trees are mounted
// (grader/worker.ts programPhaseSetup). roblox-trending-forecast-01's final is one: the history of Roblox's Top Trending
// chart up to the deadline as input/, and as reference/ its reads over the 24 hours after the deadline: the first read
// in each hourly slot, at least 12 of the 24 slots read (collector/roblox/freeze.ts writes it).
//
//   <dir>/manifest.json   ProgramDatasetManifest: the schema, the dataset id (the directory's name), the competition
//                         and phase it is for, status accepted, the tree digests of input/ and reference/ (the
//                         sealed-path digest, server/competitions/load.ts treeSha256 / grader/version.ts
//                         directoryDigest), data_sha256 (grader/program.ts programDataSha256 over the two trees:
//                         the dataset_sha256 every run graded on it records), every file under input/ and reference/
//                         with its size and sha256 in UTF-8 path order, the provenance (`source`, strings only) and
//                         when it was frozen
//   <dir>/input/**        what the entry reads at /input
//   <dir>/reference/**    what the scorer reads at /reference
//
// Nothing else is in the directory: grader/program-dataset.ts verifyProgramDataset refuses any other entry, a symbolic
// link or a file whose bytes are not the listing's. The dataset row's sha256 is the RFC 8785 canonical sha256 of
// manifest.json as written, as every format's is (grader/dataset.ts). Pure: no I/O.

import { z } from 'zod';
import { canonicalSha256 } from '../sim/canonical.ts';
import { IsoDateTime, Sha256Hex, Slug } from './primitives.ts';

export const PROGRAM_DATASET_SCHEMA = 'agent-fun/program-dataset/v1';
/** Every schema of the family starts so (grader/dataset.ts datasetFormatOf tells the format by it). */
export const PROGRAM_DATASET_SCHEMA_FAMILY = 'agent-fun/program-dataset/';
/** The two trees, as the grader mounts them. */
export const PROGRAM_DATASET_INPUT_DIR = 'input';
export const PROGRAM_DATASET_REFERENCE_DIR = 'reference';
/** grader/program.ts PROGRAM_DATA_FORMAT: the format of the digest a run's dataset_sha256 names. */
export const PROGRAM_DATA_FORMAT = 'agent-fun/program-data/v1';
/** The most files a program dataset lists (grader/program.ts MAX_OUTPUT_FILES' scale). */
export const MAX_PROGRAM_DATASET_FILES = 1000;

/** A path under input/ or reference/: plain segments, no dot-file, no empty or `..` segment. */
const DatasetPath = z
  .string()
  .max(1024)
  .regex(/^(input|reference)\/(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*$/, 'a path under input/ or reference/ of plain segments (letters, digits, . _ -, none a dot-file)')
  .refine((p) => !p.split('/').includes('..'), 'no .. segment');

export const ProgramDatasetFile = z.strictObject({
  path: DatasetPath,
  size: z.int().min(0),
  sha256: Sha256Hex,
});
export type ProgramDatasetFileT = z.infer<typeof ProgramDatasetFile>;

export const ProgramDatasetManifest = z
  .strictObject({
    schema: z.literal(PROGRAM_DATASET_SCHEMA),
    id: Slug,
    competition: Slug,
    phase: z.enum(['dev', 'final']),
    status: z.literal('accepted'),
    input_sha256: Sha256Hex,
    reference_sha256: Sha256Hex,
    data_sha256: Sha256Hex,
    files: z.array(ProgramDatasetFile).min(1).max(MAX_PROGRAM_DATASET_FILES),
    source: z.record(z.string().min(1).max(64), z.string().max(2048)),
    created_at: IsoDateTime,
  })
  .superRefine((m, ctx) => {
    const issues = programDatasetFilesIssues(m.files);
    for (const message of issues) ctx.addIssue({ code: 'custom', path: ['files'], message });
    if (issues.length === 0 && programDataSha256OfFiles(m.files) !== m.data_sha256) {
      ctx.addIssue({ code: 'custom', path: ['data_sha256'], message: 'data_sha256 is not the program-data digest of the files listed' });
    }
  });
export type ProgramDatasetManifestT = z.infer<typeof ProgramDatasetManifest>;

/** UTF-8 byte order, the order every listing here is in (server/repos/index-tar.ts comparePaths). */
export function comparePathBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** What is wrong with a files listing: out of order, a path twice, a file and a directory of one name, no input or no reference file. */
export function programDatasetFilesIssues(files: readonly ProgramDatasetFileT[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < files.length; i++) {
    const c = comparePathBytes(files[i - 1]!.path, files[i]!.path);
    if (c === 0) out.push(`${files[i]!.path} is listed twice`);
    else if (c > 0) out.push(`the files are not in UTF-8 path order at ${files[i]!.path}`);
  }
  const paths = new Set(files.map((f) => f.path));
  for (const f of files) {
    const parts = f.path.split('/');
    for (let k = 1; k < parts.length; k++) if (paths.has(parts.slice(0, k).join('/'))) out.push(`${parts.slice(0, k).join('/')} is listed as a file and holds ${f.path}`);
  }
  if (!files.some((f) => f.path.startsWith(`${PROGRAM_DATASET_INPUT_DIR}/`))) out.push('no file under input/: the entry would have nothing to read');
  if (!files.some((f) => f.path.startsWith(`${PROGRAM_DATASET_REFERENCE_DIR}/`))) out.push('no file under reference/: the scorer would have nothing to read');
  return out;
}

/** The files of one tree, their paths relative to it, in order. */
export function treeFiles(files: readonly ProgramDatasetFileT[], tree: 'input' | 'reference'): Array<{ path: string; size: number; sha256: string }> {
  const prefix = `${tree}/`;
  return files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), size: f.size, sha256: f.sha256 }));
}

/**
 * grader/program.ts programDataSha256 of the dataset's two trees, from its listing alone: the canonical sha256 of
 * {format, input, reference}, each tree's [{path, size, sha256}] in UTF-8 path order: what programDataSha256 takes of a
 * setup whose inputDir and referenceDir are the dataset's input/ and reference/ (the worker mounts both).
 */
export function programDataSha256OfFiles(files: readonly ProgramDatasetFileT[]): string {
  return canonicalSha256({ format: PROGRAM_DATA_FORMAT, input: treeFiles(files, 'input'), reference: treeFiles(files, 'reference') });
}

/** Whether a manifest as written names this format, any version (its schema, before any validation). */
export function isProgramDatasetManifest(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && typeof (raw as { schema?: unknown }).schema === 'string' && (raw as { schema: string }).schema.startsWith(PROGRAM_DATASET_SCHEMA_FAMILY);
}
