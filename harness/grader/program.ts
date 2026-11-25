// program/v1, the Codabench-style harness: the entry is a program that reads /input (the bundle's
// input_data, read-only) and writes files to /output; a separate scorer container (the competition's
// own program) reads those outputs read-only at /output and the reference data read-only at
// /reference, and writes /scores/scores.json keyed by leaderboard column keys. The grader, never a
// container, turns that file into the score.
//
// Execution (executeProgram): the entry runs with stdin closed, stdout captured (at most
// MAX_PROGRAM_STDOUT_BYTES) and stderr capped like a replay bot's, under the competition's wall
// budget. Its "action log" is the outputs manifest {format, files: [{path, size, sha256}]} (paths
// sorted by UTF-8 bytes): grade-twice compares those manifests byte for byte, and every output file
// is kept in the blob store so an L1 regrade can re-run the scorer on exactly those bytes. Bot
// failures: a non-zero exit, the budget running out (timeout), outputs that are not plain regular
// files (a symlink could point the scorer at /reference) or that the grader cannot read once the
// entry exits (a directory left 0000, a path it cannot reach), more than MAX_OUTPUT_FILES entries
// (every inode: files, directories, links, FIFOs) or MAX_OUTPUT_BYTES bytes (apparent or allocated,
// whichever total is larger), an output nested more than MAX_OUTPUT_DEPTH levels
// deep or with a path longer than MAX_OUTPUT_PATH_BYTES. Those last two keep every output reachable
// by path: an entry can chdir its way past PATH_MAX, where readdir and rm fail with ENAMETOOLONG, and
// that must stay its own violation, never a harness fault (the scratch directory is still deleted:
// grade.ts removeScratch, docker.ts removeTree). The caps are also watched while it runs, every
// OUTPUT_WATCH_MS, by this process over what it can read, and by the sandbox's meter where it has one
// (Sandbox.meterTree: docker's meter container, sandbox/docker.ts; the k8s pod's `watch` container,
// sandbox/k8s.ts). Docker's meter counts all of /output whatever modes the entry left there, so a
// directory the entry closes to the grader (on Linux a 0700 one is) hides nothing from the caps
// (docker.ts's header names the one gap left, a 0000 directory on a Docker Desktop for Mac host path).
// The k8s meter counts as the grader's uid and says how many directories it could not read (TreeUsage
// .unread): one kept unreadable for UNREAD_GRACE_MS (four readings in a row at OUTPUT_WATCH_MS:
// sandbox/k8s-watch.ts UnreadGrace) is a limit, OUTPUT_UNREAD_KEPT, so a hidden directory holds only what
// can be made in that time; one made 0700 (as mkdtemp makes it) and renamed or removed at once passes,
// and every reading in which it is readable counts it against the caps (outputReadingBroken). The
// process sandbox has no meter: there the watch is this process's own as before, skipping what it
// cannot read until the exit. A meter that fails is the sandbox's fault (a SandboxError), never the
// entry's.
//
// Scoring (scoreProgram): the outputs are materialized from the blob store into a fresh read-only
// tree, the scorer runs on them (code = the scorer entrypoint's directory, mounted at /bot), and
// scores.json is validated (program-scores.ts). A scorer may also write /scores/checks.json, its
// per-check rows (program-scores.ts readChecks), which is validated on every scoring whoever asks:
// scoreProgramWithChecks returns them beside the scores (null when there is no file), for the
// run's checks trace (program-scores.ts programChecksTrace; one per trial on agent/v1, agent-score.ts
// agentChecksTrace); scoreProgram returns the scores alone. The checks never move the score. Any
// scorer misbehaviour, a malformed checks.json included, is a ScorerError here. Grading scores through
// harnesses.ts scoreProgramBreakdown instead, which drops a malformed checks.json (its reason kept, the
// scores standing as without it) and throws every other fault as these throw it, so a breakdown never
// fails a grade (program/v1 grades and regrades, agent/v1 trials, scrape/v1 verdicts).
//
// A scorer may read one more mount beside /output, /reference and /scores: /cassette, a read-only
// directory a setup names as ProgramSetup.cassetteDir. An agent/v1 trial sets it to its own gateway
// cassette materialized from the blob store (grader/agent.ts materializeTrialCassette: cassette.json
// and bodies/<sha256>), so a bundle's scorer can prove which model really answered instead of trusting
// the entry's account. It is the scorer's alone: no entry run is ever handed it. A bundle with no such
// record (program/v1, scrape/v1, whose cassettes sit at /reference) names no cassetteDir, and the mount
// is absent.
//
// Staging (sealStaged): every path the grader and its command lines write or copy for a sandbox to read has its mode
// set explicitly once written, never left to the umask, which cuts what a write asks for: under umask 077 a 0444 file is
// 0400, closed to the sandbox user (65534). Data (a case's /input, the outputs materialized for the scorer,
// /scores/run.json, a trial's cassette, a generator's seed) is STAGED_READ_ONLY, files 0444 and directories 0555; a
// drawn instance STAGED_OWNER_DIRS (its directories 0755); code a program runs in, its cwd on the process driver (a
// scorer, an env, a gateway, a generator, a scrape starter), STAGED_OWNER_WRITES, 0644 and 0755, so a program that writes
// beside its files still can. The sites: this file, grader/agent.ts, grader/instance.ts, and cli/grade-local.ts,
// regrade.ts, verify-instance.ts, verify-result.ts and scrape-local.ts's copies of kit trees
// (tests/unit/grader-stage-input-mode.test.ts scans them).
//
// The program's dataset_sha256 is the digest of its input and reference data (programDataSha256),
// so a regrade notices when either changed.
//
// An instance-drawn bundle (contracts/competition.ts ProgramHarness.generator) names no input or
// reference data of its own: each drawn instance supplies both, as ProgramSetup's inputDir and
// referenceDir (its input/ and reference/: grader/instance.ts runGenerator draws them), which
// programPaths prefers to the bundle's own; given none, it refuses the bundle with a ScorerError. The
// scorer is still the bundle's own, from compDir (programScorerDigest), and the dataset digest of an
// instance is programDataSha256 over its two directories: the draw record's instance_sha256.
//
// A pack bundle (ProgramHarness.pack, a code bounty's) names no input or reference data either: each
// phase grades on its pack's trees, which the grader materializes from the house's store, re-hashed
// (server/competitions/load.ts packTreeDir; grader/worker.ts phasePackTrees), and hands in as inputDir
// and referenceDir, as an instance's; given none, programPaths refuses it (NO_PACK_TREES_MESSAGE). Its
// compDir is where its scorer is (load.ts programCompetitionDir: competitions/code-tests-01 for a
// sponsored one), its scorer directory re-hashed against scorer_sha256 by whoever picks it.
//
// One run per case (ProgramHarness.cases 'per-file'): executeProgram runs the entry once for each case of
// the phase's reference manifest (<referenceDir>/manifest.json, server/proposals/packs.ts
// PackReferenceManifest: programCases reads its ids and time caps), as the pack build runs every one
// (packs.ts buildPack runCase): each run in its own work directory, /input a fresh read-only directory
// holding only that case's <id>.in, a fresh /output, the competition's sandbox limits with the case's
// time_cap_ms as its wall budget, everything else as one whole run (executeIn). A case's output is its
// /output/<id>.out, kept when its run ended ok; anything else it wrote is dropped. A crash, a timeout or
// an output violation loses that case alone: it writes no output and its status says why. The action
// log is the outputs manifest with `cases` [{id, status}] in the manifest's order (status ok, timeout or
// failed), so a case that ends otherwise in the two executions makes them differ, as any other output
// does, and the run is nondeterministic. The execution is ok however its cases ended (only a harness
// fault throws); its wall time is the cases' sum, its flags their union, its stderr each case's under a
// line naming it (at most MAX_STDERR_BYTES in all), and it has no single exit.
//
// Where the runs of a run per case are: on a sandbox with sessions (Sandbox.sessions, sandbox/types.ts's header:
// one sandbox pod an execution on k8s) every case of the execution runs in one session, opened labelled
// `<label>-cases` with the cases' spec as its template and closed once the last case has ended or the execution
// throws (each execution its own: never one across the determinism pair, or with the scorer); each case is still
// executeIn's own run, its spec the template's but for its directories, its label and its time cap, given only its
// own input, a fresh /output and /tmp, and none of an earlier case's processes or state. So a case's status, its
// output, its stderr and its wall time (its program's start to its end, never the session's set-up between cases)
// are what a sandbox of its own gives, and so is the action log. On a sandbox without sessions (docker, process, a
// timing sandbox) each case is a spawn of its own on the sandbox, a container or pod each. Either way each case's
// scratch is removed by the sandbox itself (grade.ts removeScratch).
//
// Entry secrets (ProgramExecutionOptions.secrets): the entrant's env-lane entry secrets are variables of
// every run of the entry (each case's, on a run per case; its sandbox spec's `secrets`), never of the
// scorer's. Each run's stderr and error, and the stderr tail a SandboxError quotes, are masked of every
// form of every value (grader/run.ts executionOf, stderrTail), so a run per case's stderr, built of its
// cases' masked ones, is masked too. The outputs never are: they are scored byte for byte, and
// grader/worker.ts scans them for the values instead (secret_in_output).
//
// Entry env (entrySpec): every run of the entry also gets MAKEFUN_BOT_DIR, the bundle's own name for its tree
// (competitions/makefun-coin-launch-01/starter/main.ts reads `process.env.MAKEFUN_BOT_DIR ?? '/bot'`, and its README,
// AGENT.md and the bundled Getting started say to test locally with `mkdir -p out && MAKEFUN_BOT_DIR=.
// MAKEFUN_OUTPUT_DIR=out node main.ts`). It names the tree this run mounts at /bot: the host code directory itself on
// the process driver, where the program's cwd already is, and '/bot' in a container, where the cwd is the image's
// (never the repository). So a program carrying the kit's `process.env.MAKEFUN_BOT_DIR ?? '.'` or `?? '/bot'` finds its
// repository in the grader as it does at home. It is the bundle's convention, not a general sandbox contract: no other
// harness sets it, and no entry secret can share the name (every MAKEFUN_* name is reserved for secrets,
// contracts/entry-secrets.ts reservedSecretName). MAKEFUN_OUTPUT_DIR needs nothing from this file: the process driver
// sets it from the /output mount (types.ts MOUNT_POINTS), and in a container /output is the mount itself; a spec's env
// may not name a mount variable (checkSandboxEnv refuses it on every driver).
//
// The run time (ProgramScoreOptions.run; RUN_FILE): before a grade's scorer starts, the grader writes
// /scores/run.json, {"executions":N,"format":"makefun/program-run/v1","wall_ms":M} in canonical JSON:
// M is the entry's measured wall time per execution (its runs' wall time summed over every instance
// or case, then the executions' mean, rounded to a whole ms) and N how many executions it averages
// (two on a grade: the determinism pair). It is the grader's measurement on the grade's sandbox,
// never the entry's word, so a scorer may write it into a column (a leaderboard tie-break: the
// faster program wins an exact tie) and it stays the scorer's own score. An L1 regrade re-hands the
// stored run's total and count (run.wall_ms, run.exec_count: grader/record.ts loadStoredRun), so the
// same file and the same score come back. A scoring that is no grade's (an agent/v1 trial's state
// export, a scrape verdict, an L1 regrade of a run stored without them) writes no file, and a scorer
// that reads none writes its column null. Every other scorer ignores the extra file.
//
// The house dossier (contracts/competition.ts ProgramEntryLink.dossier): a bundle whose pump.fun entry link names
// `dossier` judges the house's dossier of the coin as launched, never what the program wrote. Its plan names the path
// (harnesses.ts HarnessPlan.houseDossier, programPlan's from the bundle), and the grade (grader/grade.ts), once the two
// executions' manifests are compared byte for byte as the program wrote them, makes the file at that path the dossier
// the entry-link stage stored at intake (houseDossierOutputs: the record's dossier_sha256, the bytes in the blob store),
// or leaves the path empty where the record names none because the coin's check failed (a house entry's would-be fail),
// so the scorer's gate fails the entry. A record that holds no read of the coin at all (the stage's lookup faulted on
// its last attempt, or the record predates the dossier) or whose blob the store lacks or holds corrupt (server/
// blobstore.ts BlobCorruptError) is the house's fault, never the entrant's (HouseDossierOutputs.fault): the grade
// does not score it (grade.ts houseDossierLogOf). An L2 regrade's re-execution (grader/regrade.ts) takes the same step
// before its comparison with the recorded log. The manifest the grade scores and records is that one: every reader of
// the run's action log (the judge heats, the feed, the artifact's bytes on the score) reads the house's dossier.
//
// The house counts (contracts/competition.ts ProgramEntryLink.counts): a bundle whose YouTube, X, TikTok or make.fun
// entry link (COUNTS_ENTRY_LINK_PLATFORMS) names `counts` scores the counts the house read of the entry's video, post or
// bounties, never a number the program wrote. Its plan names the path (harnesses.ts HarnessPlan.houseCounts), and the
// grade, once the two executions' manifests are compared as the program wrote them, makes the file at that path the
// link's counts (houseCountsOutputs: canonical JSON put in the blob store) from the record the entry-link stage stored,
// by its platform: of contracts/entry-link-counts.ts EntryLinkCounts, makefun/video-counts/v1, from a YouTube record,
// XPostCounts, makefun/post-counts/v1, from an X record, TiktokVideoCounts, makefun/tiktok-counts/v1, from a TikTok
// record (each of the record's engagement readings), or BountiesCounts, makefun/bounty-counts/v2, from a make.fun
// record (server/entry-link/types.ts MakefunEntryLinkRecord: a row each bounty it names, the reading's row of that
// bounty joined by slug to the record's bounty, and the record's min_entrants), or, under an X link naming `pool` (the
// plan's HarnessPlan.houseCountsPosts, never the record's shape), XPostsCounts, makefun/x-posts-counts/v1, from an X
// record's `posts` list (a row each listed post, its reading the slot's own of that post). The grader reads the record alone,
// never the bundle. A dev grade's carries the intake check's reading (`reading: 'check'`), a final grade's the deadline
// reading (`reading: 'deadline'`: a YouTube video's read at the final lock, server/entry-link/youtube-readings.ts; an X
// post's or a TikTok video's by the house's deadline pass over the field after it; a make.fun record's at the final
// lock, capped at the contest's deadline, server/entry-link/makefun-readings.ts). A video gone or no longer public
// reads `video: 'gone'`, a post deleted or withheld `post: 'gone'`, every count null, and a named bounty no longer
// found, a draft, cancelled or internal a row `bounty: 'gone'`: the entrant's. A record of another platform than the
// link's, one that is none of a YouTube video's, an X post's, a TikTok video's or a make.fun record's, a video or post
// never read (save on a final grade whose deadline reading read it: that reading's own word, read or gone, stands for a
// record whose check skipped, its state filled by the deadline write or not), a link the entry_link check refused
// (stated, never inferred from a null state: the record's `refused` the deadline write stamps, or the grade's own word
// from the entry's checks; houseCountsRefusedOf), whatever its reading, a make.fun record naming no bounty or
// lacking a named bounty's id or entry fee, a record holding no such reading (or one that read nothing), a make.fun
// reading holding no row of a named bounty, or a live row with no pot (a reading taken before pots were read: redrive
// its entry-link check) is the house's fault
// (HouseCountsOutputs.fault): the grade does not score it (grade.ts houseCountsLogOf).

import { chmodSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { z } from 'zod';
import type { CountsEntryLinkPlatformT, EntryLinkCountedT, Leaderboard, ProgramHarness } from '../contracts/competition.ts';
import {
  BOUNTIES_COUNTS_FORMAT,
  bountiesCountsSchemaOf,
  bountiesTotalsOf,
  ENTRY_LINK_COUNTS_FORMAT,
  EntryLinkCounts,
  POST_COUNTS_FORMAT,
  TIKTOK_COUNTS_FORMAT,
  TiktokVideoCounts,
  compareXPostIds,
  X_POSTS_COUNTS_FORMAT,
  X_POSTS_COUNTS_MAX_BYTES,
  XPostCounts,
  XPostsCounts,
  type BountiesCountsT,
  type CountsFileT,
  type XPostsCountsT,
} from '../contracts/entry-link-counts.ts';
import { Sha256Hex } from '../contracts/primitives.ts';
import { canonicalJson, canonicalSha256, compareCodeUnits, sha256Hex } from '../sim/canonical.ts';
import { BlobCorruptError } from '../server/blobstore.ts';
import { comparePaths } from '../server/repos/index-tar.ts';
import { readChecks, readScores, scoredColumns, ScorerError, type ProgramScores, type ScorerChecksT } from './program-scores.ts';
import { driverFailure, entrySecretForms, executionOf, MAX_STDERR_BYTES, specSecrets, stderrTail, type Execution, type LimitsT } from './run.ts';
import { describeExit, describeStop, Stopped, Supervisor } from './sandbox/io.ts';
import { UNREAD_GRACE_MS, UnreadGrace } from './sandbox/k8s-watch.ts';
import { SCORES_RETURNS } from './sandbox/mounts.ts';
import { SandboxError, type MountPoint, type Runtime, type Sandbox, type SandboxReturns, type SandboxSpec, type TreeMeter, type TreeMeterOptions, type TreeUsage } from './sandbox/types.ts';
import { directoryDigest, directoryDigestAsync, treeFileSums, treeFileSumsAsync, type TreeFileSum } from './version.ts';

export const PROGRAM_OUTPUTS_FORMAT = 'agent-fun/program-outputs/v1';
export const PROGRAM_DATA_FORMAT = 'agent-fun/program-data/v1';
/** Files and directories together: a directory costs what a file does, so an entry cannot make empty ones without end. */
export const MAX_OUTPUT_FILES = 1000;
/** The larger of the outputs' apparent total and allocated total: a sparse file reports more than it holds, a preallocated one holds more than it reports. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** The deepest an output may sit (one directly in /output is at depth 1): depth is what carries a path past PATH_MAX. */
export const MAX_OUTPUT_DEPTH = 32;
/** The longest output path, in UTF-8 bytes relative to /output: with a work directory's path in front it stays well inside Linux's PATH_MAX (4096). */
export const MAX_OUTPUT_PATH_BYTES = 1024;
/**
 * How much of an entry's /output may come back from its sandbox (SandboxMount.returns): exactly its caps. A copying
 * driver returns the one entry past a cap as well (the entry that breaks it), so collectOutputs still sees the breach in
 * the returned tree and judges it the entry's, in today's words; a cap here plus one would count that entry twice.
 */
export const OUTPUT_RETURNS: SandboxReturns = Object.freeze({ maxEntries: MAX_OUTPUT_FILES, maxBytes: MAX_OUTPUT_BYTES });
export const MAX_PROGRAM_STDOUT_BYTES = 1_048_576;
export const OUTPUT_WATCH_MS = 500;

export const ProgramOutputFile = z.strictObject({
  path: z.string().min(1),
  size: z.int().min(0),
  sha256: Sha256Hex,
});

/** A case id: what <id>.in and <id>.out are named by (server/proposals/packs.ts PACK_CASE_ID_RE). */
export const PROGRAM_CASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** How one case's run ended (one run per case: the header). */
export const PROGRAM_CASE_STATUSES = ['ok', 'timeout', 'failed'] as const;

/** One case's run in the action log of a run per case: its id and how it ended. */
export const ProgramCaseRun = z.strictObject({
  id: z.string().regex(PROGRAM_CASE_ID_RE),
  status: z.enum(PROGRAM_CASE_STATUSES),
});

export const ProgramOutputs = z.strictObject({
  format: z.literal(PROGRAM_OUTPUTS_FORMAT),
  files: z.array(ProgramOutputFile),
  /** One run per case (ProgramHarness.cases 'per-file'): every case's run, in the reference manifest's order. Absent on one whole run, so its log keeps its bytes. */
  cases: z.array(ProgramCaseRun).optional(),
});
export type ProgramOutputsT = z.infer<typeof ProgramOutputs>;

/** Where output bytes are kept and read back (server/blobstore.ts BlobStore fits). */
export interface OutputBlobs {
  put(data: Uint8Array): Promise<{ sha256: string }>;
  get(sha256: string, opts?: { verify?: boolean }): Promise<Uint8Array | null>;
}

type ProgramHarnessT = z.infer<typeof ProgramHarness>;
type LeaderboardT = z.infer<typeof Leaderboard>;

export interface ProgramSetup {
  /** Absolute competition directory (holds the scorer, and the input_data and reference_data the bundle names). */
  compDir: string;
  harness: ProgramHarnessT;
  leaderboard: Pick<LeaderboardT, 'columns'>;
  /** Absolute input directory of a drawn instance (its input/), mounted at /input instead of the bundle's input_data. */
  inputDir?: string;
  /** Absolute reference directory of a drawn instance (its reference/), mounted at /reference instead of the bundle's reference_data. */
  referenceDir?: string;
  /**
   * Absolute directory of the trial's own record, mounted read-only at /cassette (CASSETTE_MOUNT) for the scorer: an
   * agent/v1 trial's gateway cassette, cassette.json and its bodies (grader/agent.ts materializeTrialCassette). Absent
   * on a bundle with no such record (program/v1, scrape/v1, whose own cassettes are read under /reference). The entry
   * never sees it: it is made after the entry has run and mounted into the scorer's program alone.
   */
  cassetteDir?: string;
}

/** Where the scorer reads ProgramSetup.cassetteDir: read-only, beside /output and /reference (grader/sandbox/types.ts MOUNT_POINTS). */
export const CASSETTE_MOUNT: MountPoint = '/cassette';

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** The message programPaths throws for an instance-drawn bundle given no instance. */
export const NO_INSTANCE_MESSAGE = 'an instance-drawn bundle grades only on an instance';
/** The message programPaths throws for a pack bundle given no pack trees. */
export const NO_PACK_TREES_MESSAGE = "a pack bundle grades only on its phase's pack trees";

/** Absolute path of a bundle path inside the competition directory. */
function bundleAt(setup: ProgramSetup, p: string): string {
  return join(setup.compDir, ...p.split('/'));
}

/** The scorer's directory (mounted at /bot) and script: the bundle's own on every bundle, instance-drawn or not. */
function scorerPaths(setup: ProgramSetup): { scorerDir: string; scorerScript: string } {
  const entry = setup.harness.scorer.entrypoint;
  const dir = posix.dirname(entry);
  return { scorerDir: dir === '.' ? setup.compDir : bundleAt(setup, dir), scorerScript: posix.basename(entry) };
}

/**
 * Absolute paths of the program/v1 pieces: the setup's inputDir and referenceDir (an instance's) when
 * given, else the bundle's input_data and reference_data inside compDir; the scorer always the
 * bundle's. An instance-drawn bundle (a harness generator) names no reference or input data of its
 * own, so it grades only on an instance: given no referenceDir, this throws ScorerError
 * (NO_INSTANCE_MESSAGE); a pack bundle likewise grades only on its phase's pack trees
 * (NO_PACK_TREES_MESSAGE).
 */
export function programPaths(setup: ProgramSetup): { inputDir: string | null; referenceDir: string; scorerDir: string; scorerScript: string } {
  const reference = setup.harness.scorer.reference_data;
  const referenceDir = setup.referenceDir ?? (reference === null ? null : bundleAt(setup, reference));
  if (referenceDir === null) throw new ScorerError(setup.harness.pack !== undefined ? NO_PACK_TREES_MESSAGE : NO_INSTANCE_MESSAGE);
  const input = setup.harness.input_data;
  return {
    inputDir: setup.inputDir ?? (input === null ? null : bundleAt(setup, input)),
    referenceDir,
    ...scorerPaths(setup),
  };
}

/**
 * sha256 over the files under a directory: [{path, size, sha256}] in UTF-8 path order. Each file's sum is kept for the
 * process while its stat holds (version.ts treeFileSums), so a tree digested again reads only its listing.
 */
export function directoryManifest(dir: string): Array<{ path: string; size: number; sha256: string }> {
  return inPathOrder(treeFileSums(dir));
}

/** directoryManifest, its walk and reads on fs/promises (version.ts treeFileSumsAsync). */
export async function directoryManifestAsync(dir: string): Promise<Array<{ path: string; size: number; sha256: string }>> {
  return inPathOrder(await treeFileSumsAsync(dir));
}

/** `files` in UTF-8 path order (index-tar.ts comparePaths), each path encoded once rather than once a comparison. */
function inPathOrder(files: TreeFileSum[]): TreeFileSum[] {
  const keyed = files.map((f) => ({ f, k: Buffer.from(f.path, 'utf8') }));
  keyed.sort((a, b) => Buffer.compare(a.k, b.k));
  return keyed.map((x) => x.f);
}

/** The program's dataset digest: its input data (if any) and reference data. */
export function programDataSha256(setup: ProgramSetup): string {
  const p = programPaths(setup);
  return programDataDigest(p.inputDir === null ? null : directoryManifest(p.inputDir), directoryManifest(p.referenceDir));
}

/** programDataSha256 with both trees walked and read on fs/promises. */
export async function programDataSha256Async(setup: ProgramSetup): Promise<string> {
  const p = programPaths(setup);
  const [input, reference] = await Promise.all([p.inputDir === null ? null : directoryManifestAsync(p.inputDir), directoryManifestAsync(p.referenceDir)]);
  return programDataDigest(input, reference);
}

/** The program-data digest of an input manifest (null: none) and a reference one (programDataSha256's, grader/agent.ts instanceSha256's). */
export function programDataDigest(input: ReturnType<typeof directoryManifest> | null, reference: ReturnType<typeof directoryManifest>): string {
  return canonicalSha256({ format: PROGRAM_DATA_FORMAT, input, reference });
}

/** The scorer directory's digest (scorer_version's ` program@<sha256>`); an instance-drawn bundle's needs no instance. */
export function programScorerDigest(setup: ProgramSetup): string {
  return directoryDigest(scorerPaths(setup).scorerDir);
}

/** programScorerDigest with the scorer directory walked and read on fs/promises. */
export async function programScorerDigestAsync(setup: ProgramSetup): Promise<string> {
  return directoryDigestAsync(scorerPaths(setup).scorerDir);
}

// ---------------------------------------------------------------- execution

export interface ProgramExecutionOptions {
  sandbox: Sandbox;
  runtime: Runtime;
  /** Host directory mounted read-only at /bot: a freshly materialized snapshot. */
  botDir: string;
  setup: ProgramSetup;
  limits: LimitsT;
  /** A fresh, empty directory this execution may use (outputs land under it). */
  workDir: string;
  blobs: OutputBlobs;
  label?: string;
  imageDigest?: string | null;
  /**
   * The entrant's env-lane entry secrets, NAME to value (the header's entry secrets): every run of the entry gets them as
   * its sandbox spec's `secrets` (each case's, on a run per case), masked out of its stderr, its error and every tail a
   * SandboxError quotes; never the scorer. Absent or empty: none.
   */
  secrets?: Readonly<Record<string, string>>;
}

/** One plain file walkOutputs found: its path relative to the output directory (POSIX), where it is, and its size. */
export interface WalkedFile {
  path: string;
  abs: string;
  size: number;
}

const TOO_MANY_OUTPUTS = `more than ${MAX_OUTPUT_FILES} output files and directories`;
const TOO_MANY_OUTPUT_BYTES = `outputs passed ${MAX_OUTPUT_BYTES} bytes`;
/** How much of a path a message shows. */
const SHOWN_PATH_CHARS = 80;

/** The output cap a meter reading of /output breaks, or null: outputReadingBroken's caps (an entry's, a scrape entry's). */
export function outputCapBroken(u: TreeUsage): string | null {
  if (u.entries > MAX_OUTPUT_FILES) return TOO_MANY_OUTPUTS;
  if (u.bytes > MAX_OUTPUT_BYTES) return TOO_MANY_OUTPUT_BYTES;
  if (u.depth > MAX_OUTPUT_DEPTH) return `outputs nested more than ${MAX_OUTPUT_DEPTH} levels deep`;
  if (u.longPaths > 0) return `an output path is longer than ${MAX_OUTPUT_PATH_BYTES} bytes`;
  return null;
}

/** The limit a directory in /output the meter could not read, kept so for the grace, is (the header; the root's D5b). */
export const OUTPUT_UNREAD_KEPT = `a directory in /output stayed unreadable to the grader for ${UNREAD_GRACE_MS / 1000} s`;

/**
 * The limit one meter reading of /output breaks, fed every reading of that meter in order (also grader/instance.ts's and
 * grader/scrape/trial.ts's): a cap `caps` names (outputCapBroken's by default), else OUTPUT_UNREAD_KEPT once `grace`
 * (sandbox/k8s-watch.ts UnreadGrace, the meter's own) says a directory has stayed unreadable for its grace; null otherwise.
 */
export function outputReadingBroken(u: TreeUsage, grace: UnreadGrace, caps: (u: TreeUsage) => string | null = outputCapBroken): string | null {
  const kept = grace.breach(u);
  return caps(u) ?? (kept ? OUTPUT_UNREAD_KEPT : null);
}

/** Which of MAX_OUTPUT_DEPTH and MAX_OUTPUT_PATH_BYTES a path relative to /output (POSIX) breaks, or null. */
export function outputPathBroken(relPath: string): 'depth' | 'length' | null {
  if (relPath.split('/').length > MAX_OUTPUT_DEPTH) return 'depth';
  if (Buffer.byteLength(relPath) > MAX_OUTPUT_PATH_BYTES) return 'length';
  return null;
}

/** A path as a message shows it: its first SHOWN_PATH_CHARS characters, and an ellipsis when it goes on. */
export function shownPath(path: string): string {
  return path.length > SHOWN_PATH_CHARS ? `${path.slice(0, SHOWN_PATH_CHARS)}…` : path;
}

/**
 * Why this process cannot look at an output path, when that is the entry's doing: a mode it left
 * (EACCES, EPERM), a path it nested past PATH_MAX (ENAMETOOLONG) or made a link loop of (ELOOP); null
 * for any other failure, which is this process's own.
 */
export function outputUnreachable(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'is not readable';
  if (code === 'ENAMETOOLONG' || code === 'ELOOP') return `cannot be reached by its path (${code})`;
  return null;
}

/**
 * Plain files under the output directory; a symlink or special file, a path this process cannot
 * reach, too many entries (directories count), too many bytes (apparent or allocated), too deep or too long a path is the
 * entry's violation. It never descends past the depth and path caps, so no path it hands the kernel
 * is longer than the output directory's own plus MAX_OUTPUT_PATH_BYTES. `running`: the watch while
 * the entry still runs, which skips what it cannot reach yet (the entry may still open it up) and
 * holds the rest to the caps. The output collector of every harness whose entry writes /output
 * (executeProgram here, grader/scrape/trial.ts), with collectOutputs below.
 */
export async function walkOutputs(root: string, running = false): Promise<{ files: WalkedFile[]; bytes: number } | { violation: string }> {
  const files: WalkedFile[] = [];
  let bytes = 0;
  let allocated = 0;
  let count = 0;
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch (err) {
      const why = outputUnreachable(err);
      if (why === null) throw err;
      if (running) continue;
      return { violation: rel === '' ? `/output ${why}` : `output ${JSON.stringify(shownPath(rel))} ${why}` };
    }
    for (const e of entries) {
      const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
      if (!SEGMENT.test(e.name)) return { violation: `output path ${JSON.stringify(shownPath(relPath))} is not a plain relative name` };
      const shape = outputPathBroken(relPath);
      if (shape === 'depth') return { violation: `output ${JSON.stringify(shownPath(relPath))} is nested more than ${MAX_OUTPUT_DEPTH} levels deep` };
      if (shape === 'length') return { violation: `output path ${JSON.stringify(shownPath(relPath))} is longer than ${MAX_OUTPUT_PATH_BYTES} bytes` };
      count += 1;
      if (count > MAX_OUTPUT_FILES) return { violation: TOO_MANY_OUTPUTS };
      if (e.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      if (!e.isFile()) return { violation: `output ${JSON.stringify(shownPath(relPath))} is not a regular file` };
      let st;
      try {
        st = await lstat(join(root, relPath));
      } catch (err) {
        const why = outputUnreachable(err);
        if (why === null) throw err;
        if (running) continue;
        return { violation: `output ${JSON.stringify(shownPath(relPath))} ${why}` };
      }
      if (!st.isFile()) return { violation: `output ${JSON.stringify(shownPath(relPath))} is not a regular file` };
      files.push({ path: relPath, abs: join(root, relPath), size: st.size });
      bytes += st.size;
      allocated += st.blocks * 512;
      if (bytes > MAX_OUTPUT_BYTES || allocated > MAX_OUTPUT_BYTES) return { violation: TOO_MANY_OUTPUT_BYTES };
    }
  }
  return { files, bytes };
}

/**
 * The outputs under `outputDir` once their program has exited: walkOutputs, then each file read and
 * stored in `blobs`, as the program-outputs manifest (paths in UTF-8 byte order); or the entry's
 * violation (walkOutputs', or a file it cannot read). What the blob store throws is thrown, and so is a file gone
 * between the walk and its read (ENOENT, ESTALE: the grader's own folder lost, grade.ts lostWorkFolder).
 */
export async function collectOutputs(outputDir: string, blobs: Pick<OutputBlobs, 'put'>): Promise<{ outputs: ProgramOutputsT } | { violation: string }> {
  const walked = await walkOutputs(outputDir);
  if ('violation' in walked) return { violation: walked.violation };
  const files: ProgramOutputsT['files'] = [];
  for (const f of walked.files) {
    let bytes: Buffer;
    try {
      bytes = await readFile(f.abs);
    } catch (err) {
      // A file the walk found gone by its read (ENOENT, ESTALE): the program has exited, so its output folder went with
      // the grader's work folder (another attempt's reap, a sweep, the volume), never the entry's doing. Thrown, for the
      // grade to name as the platform's fault (grade.ts lostWorkFolder); any other failure to read it is the entry's.
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ESTALE') throw err;
      return { violation: `${f.path} is not readable` };
    }
    const put = await blobs.put(bytes);
    files.push({ path: f.path, size: bytes.length, sha256: put.sha256 });
  }
  files.sort((a, b) => comparePaths(a.path, b.path));
  return { outputs: { format: PROGRAM_OUTPUTS_FORMAT, files } };
}

/**
 * Execute a program/v1 entry: once over the whole input, or under a harness with one run per case
 * (cases 'per-file') once per case (the header). Entry failures and timeouts are returned; harness faults thrown.
 */
export async function executeProgram(opts: ProgramExecutionOptions): Promise<Execution<ProgramOutputsT>> {
  if (opts.setup.harness.cases === 'per-file') return executePerCase(opts);
  const paths = programPaths(opts.setup);
  return executeIn(opts, { inputDir: paths.inputDir, outputDir: join(opts.workDir, 'output'), limits: opts.limits, label: opts.label ?? 'program' });
}

/** Whether `err` is the blob store's corrupt read (server/blobstore.ts BlobCorruptError), by class or by name. */
function isBlobCorrupt(err: unknown): err is Error {
  return err instanceof BlobCorruptError || (err instanceof Error && err.name === 'BlobCorruptError');
}

/** What houseDossierOutputs made of an execution's outputs: the manifest, its canonical JSON and sha256, and what it did. */
export interface HouseDossierOutputs {
  outputs: ProgramOutputsT;
  json: string;
  sha256: string;
  /** Whether the house's dossier is the file at the path now (else no file is there). */
  kept: boolean;
  /**
   * Whether the empty path is the house's fault, never the entrant's: a pump.fun record that holds no read of the coin
   * (no `coin` key and no dossier_sha256: the entry-link stage's lookup or its store faulted on its last attempt and
   * recorded a skip, or the record was written before the bundle named its dossier), an X or Reddit record that holds no
   * read of the post (its `post` null: the same fault), a dossier_sha256 that is no sha256,
   * or one whose blob the store does not hold or holds corrupt (BlobCorruptError). The grade never scores such outputs
   * (grade.ts houseDossierLogOf). False where the dossier was kept, and where the record read the coin and names no
   * dossier: its check failed at intake (a house entry's would-be fail, recorded as a skip), the entrant's own; and for
   * no record, or another platform's.
   */
  fault: boolean;
  /** What was done and why, one line for the grade's log. */
  note: string;
}

/**
 * `outputs` (a program's outputs manifest) with the file at `path` made the house's dossier of the coin (the header's
 * `The house dossier`): every file the program wrote at `path`, under it (a directory of that name) or at a directory
 * of its path is dropped, and the blob named by `record`'s dossier_sha256 (server/db/schema.ts PumpfunEntryLinkRecord, or
 * an X or Reddit record's, XEntryLinkRecord, RedditEntryLinkRecord: written at intake by the entry-link stage) is added at
 * `path`, read back from `blobs` and held to its sha256. A record that is none of a pump.fun, an X or a Reddit record, names no dossier_sha256, or whose blob the store does not hold adds nothing: the path is
 * left empty, and `note` says why; `fault` says whether that is the house's fault (HouseDossierOutputs.fault), which the
 * grade never scores, or the entrant's, whose empty path the scorer's gate fails. The program's own file never stands in.
 */
export async function houseDossierOutputs(outputs: unknown, path: string, record: unknown, blobs: Pick<OutputBlobs, 'get'>): Promise<HouseDossierOutputs> {
  const parsed = ProgramOutputs.parse(outputs);
  const clashes = (p: string): boolean => p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`);
  const dropped = parsed.files.filter((f) => clashes(f.path));
  const files = parsed.files.filter((f) => !clashes(f.path));
  const wrote = dropped.length === 0 ? 'the program wrote nothing there' : `the program's own ${dropped.map((f) => JSON.stringify(f.path)).join(', ')} dropped`;
  const r = record !== null && typeof record === 'object' ? (record as { platform?: unknown; dossier_sha256?: unknown; coin?: unknown; post?: unknown }) : null;
  // A coin's (pump.fun) or a post's (X, Reddit) record: the platforms whose entry link names a house dossier.
  const post = r?.platform === 'x' || r?.platform === 'reddit';
  const dossierRecord = r !== null && (r.platform === 'pumpfun' || post);
  const of = post ? 'post' : 'coin';
  const sha = dossierRecord && typeof r.dossier_sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.dossier_sha256) ? r.dossier_sha256 : null;
  let note: string;
  let kept = false;
  let fault = false;
  if (sha === null) {
    // A pump.fun lookup under a dossier always records the coin it kept (`coin`: its facts, or null where the metadata did
    // not read: server/entry-link/pumpfun.ts pumpfunLinkRecordOf); a record without the key never read the coin at all,
    // and one whose dossier_sha256 is there but no sha256 is the house's own record gone wrong.
    // An X or Reddit record's `post` is null where the lookup faulted on its last attempt (server/entry-link/x.ts
    // xLinkRecordOf, reddit.ts redditLinkRecordOf of no answer): it never read the post, as a pump.fun record without
    // `coin` never read the coin.
    const unread = r !== null && (r.platform === 'pumpfun' ? r.coin === undefined : r.post === null || r.post === undefined);
    fault = dossierRecord && ((r.dossier_sha256 !== undefined && r.dossier_sha256 !== null) || unread);
    note =
      r === null
        ? `no house dossier at /output/${path}: the entry has no entry-link record (the entry-link stage recorded none); ${wrote}, so the path is empty`
        : !dossierRecord
          ? `no house dossier at /output/${path}: the entry's entry-link record is no pump.fun coin's, X post's or Reddit post's; ${wrote}, so the path is empty`
          : fault
            ? r.dossier_sha256 !== undefined && r.dossier_sha256 !== null
              ? `no house dossier at /output/${path}: the entry's entry-link record names a dossier_sha256 that is no sha256 (${JSON.stringify(r.dossier_sha256)}), the house's fault and never the entrant's; ${wrote}, so the path is empty`
              : `no house dossier at /output/${path}: the entry's entry-link record holds no read of the ${of} (the house's lookup faulted on intake's last attempt and recorded a skip, or the record predates the dossier), the house's fault and never the entrant's; ${wrote}, so the path is empty`
            : `no house dossier at /output/${path}: the entry's entry-link record names none (its ${of}'s check failed at intake); ${wrote}, so the path is empty`;
  } else {
    // A blob the store holds corrupt (server/blobstore.ts BlobCorruptError, its verified read: bytes that hash to
    // another sha256, or a .zst that does not decompress) is the house's storage gone wrong, as a missing one is: a
    // fault. Any other error of the read is thrown as it is.
    let bytes: Uint8Array | null;
    let corrupt: string | null = null;
    try {
      bytes = await blobs.get(sha, { verify: true });
    } catch (err) {
      if (!isBlobCorrupt(err)) throw err;
      bytes = null;
      corrupt = err.message;
    }
    if (corrupt !== null) {
      fault = true;
      note = `no house dossier at /output/${path}: its blob ${sha} is corrupt in the blob store (${corrupt}), the house's fault and never the entrant's; ${wrote}, so the path is empty`;
    } else if (bytes === null || sha256Hex(bytes) !== sha) {
      fault = true;
      note = `no house dossier at /output/${path}: its blob ${sha} is not in the blob store (or is not its bytes), the house's fault and never the entrant's; ${wrote}, so the path is empty`;
    } else {
      files.push({ path, size: bytes.byteLength, sha256: sha });
      files.sort((a, b) => comparePaths(a.path, b.path));
      kept = true;
      note = `the house's dossier of the ${of} (${sha}) written at /output/${path}; ${wrote}`;
    }
  }
  const next: ProgramOutputsT = { format: parsed.format, files, ...(parsed.cases === undefined ? {} : { cases: parsed.cases }) };
  const json = canonicalJson(next);
  return { outputs: next, json, sha256: sha256Hex(json), kept, fault, note };
}

/**
 * Which of a counts record's readings (a YouTube video's, an X post's, a TikTok video's or a make.fun bounty's) a counts
 * file carries (EntryFacts.entry_link_reading): the intake check's (a dev grade's) or the deadline one (a final grade's).
 */
export type HouseCountsReading = 'intake' | 'deadline';

/**
 * A counts file houseCountsOutputs writes: a post's (contracts/entry-link-counts.ts CountsFileT), an X pool entry's list
 * of posts (XPostsCountsT) or a bounty list's (BountiesCountsT), each typed with the others' own keys absent (a strict
 * file never holds them), so a reader may ask
 * `counts.video` or `counts.views` of either and read undefined on a bounty list's, or `counts.bounties` and read
 * undefined on a post's.
 */
export type HouseCountsFileT =
  | (CountsFileT & { read_at?: never; min_entrants?: never; bounties?: never; posts?: never })
  | (XPostsCountsT & {
      read_at?: never;
      min_entrants?: never;
      bounties?: never;
      video_id?: never;
      post_id?: never;
      url?: never;
      video?: never;
      post?: never;
      views?: never;
      likes?: never;
      comments?: never;
      replies?: never;
      reposts?: never;
      quotes?: never;
      shares?: never;
      saves?: never;
    })
  | (BountiesCountsT & {
      posts?: never;
      platform?: never;
      video_id?: never;
      post_id?: never;
      url?: never;
      at?: never;
      video?: never;
      post?: never;
      views?: never;
      likes?: never;
      comments?: never;
      replies?: never;
      reposts?: never;
      quotes?: never;
      shares?: never;
      saves?: never;
    });

/** What houseCountsOutputs made of an execution's outputs: the manifest, its canonical JSON and sha256, the counts written, and what it did. */
export interface HouseCountsOutputs {
  outputs: ProgramOutputsT;
  json: string;
  sha256: string;
  /**
   * The counts file written at the path (contracts/entry-link-counts.ts: a YouTube record's EntryLinkCounts, an X
   * record's XPostCounts, a TikTok record's TiktokVideoCounts, a make.fun record's BountiesCounts); null where none was
   * (a fault).
   */
  counts: HouseCountsFileT | null;
  /**
   * Whether no counts could be written, the house's fault and never the entrant's: no record at all, one that is none of
   * a YouTube video's, an X post's, a TikTok video's or a make.fun bounty's, or one of another platform than the bundle's
   * entry link (a make.fun record under a YouTube link, or the reverse); its video or post never read (`video` or
   * `post` null: the check's lookup faulted on its last attempt) where the reading asked is the intake one, or a
   * deadline one absent or that read nothing (a deadline reading that read the post or video, or found it gone, is
   * written whatever the record's state, save a refused link's); a link the entry_link check refused (houseCountsRefusedOf:
   * the record's `refused` stamp, or the caller's `refused`), whatever its state or reading; a make.fun record naming no bounty, lacking a named
   * bounty's id or entry fee, or holding no readings; the reading asked for absent, a reading that read nothing
   * (`missing` without `gone`), a make.fun reading holding no row of a named bounty or a live row with no pot (taken
   * before pots were read), or one that does not make a counts file. The grade never scores such outputs (grade.ts
   * houseCountsLogOf).
   */
  fault: boolean;
  /** What was done and why, one line for the grade's log. */
  note: string;
}

/**
 * The key the counts deadline write stamps `true` on the record of an entry whose entry_link check refused its link
 * (server/entry-link/counts-pass.ts countsChunkWriteSql: its submission.checks hold an entry_link FAIL when the write
 * runs), beside the read state it keeps null: the refusal stated on the record, so the final grade refuses it
 * (houseCountsRefusedOf) and never takes its null state for a skip's. Absent on every other record.
 */
export const HOUSE_COUNTS_REFUSED_KEY = 'refused';

/**
 * Whether `checks` (an entry's submission.checks) hold the entry_link check's refusal: a FAIL of check `entry_link`
 * (server/entry-link/link.ts ENTRY_LINK_CHECK_ID), read as server/routes/archive/entry.ts reads one. A skip, a pass, a
 * held review or no verdict at all refuses nothing. What a grade hands houseCountsOutputs as `refused`.
 */
export function entryLinkCheckRefused(checks: unknown): boolean {
  if (!Array.isArray(checks)) return false;
  return checks.some((c) => c !== null && typeof c === 'object' && (c as { check?: unknown }).check === 'entry_link' && (c as { status?: unknown }).status === 'fail');
}

/**
 * Why houseCountsOutputs writes no counts of `record` as a refused link's, or null where nothing says it was refused:
 * the record's own stamp (HOUSE_COUNTS_REFUSED_KEY `true`, the deadline write's), else `refused` true (the grade's
 * word, entryLinkCheckRefused of the entry's checks). Never inferred from the record's read state.
 */
export function houseCountsRefusedOf(record: object, refused?: boolean | null): string | null {
  if ((record as Record<string, unknown>)[HOUSE_COUNTS_REFUSED_KEY] === true) return 'the deadline write stamped its record refused, its submission.checks holding an entry_link fail';
  if (refused === true) return 'its submission.checks hold an entry_link fail';
  return null;
}

/**
 * `outputs` (a program's outputs manifest) with the file at `path` made the house's counts of the entry's link (the
 * header's `The house counts`): every file the program wrote at `path`, under it or at a directory of its path is
 * dropped (the dossier's clash rule), and the canonical JSON of the counts is put in `blobs` and added at `path`. The
 * counts are `record`'s reading `reading` (a post's engagement.intake, a bounty's readings.intake, as `reading:
 * 'check'`; engagement.deadline or readings.deadline as 'deadline'), in its platform's format
 * (contracts/entry-link-counts.ts):
 *
 *   youtube  server/db/schema.ts YoutubeEntryLinkRecord, EntryLinkCounts (makefun/video-counts/v1): the record's
 *            video_id and url; `video` 'gone' where the reading says so (every count null), else 'public', its views,
 *            likes and comments each as read (null where YouTube showed none: a video whose statistics are hidden is
 *            read with every count null, never a fault)
 *   x        server/entry-link/types.ts XEntryLinkRecord, XPostCounts (makefun/post-counts/v1): the record's post_id
 *            and url; `post` 'gone' where the reading says so (every count null), else 'public', its views, likes,
 *            replies, reposts and quotes each as read (null where X showed none: a legacy post's views)
 *   tiktok   server/entry-link/types.ts TiktokEntryLinkRecord, TiktokVideoCounts (makefun/tiktok-counts/v1): the
 *            record's video_id and url; `video` 'gone' where the reading says so (deleted, not public, or not shown to
 *            a visitor from the US: every count null), else 'public', its views, likes, comments, shares and saves each
 *            as read (null where none was shown)
 *   makefun  server/entry-link/types.ts MakefunEntryLinkRecord, BountiesCounts (makefun/bounty-counts/v2): a row each
 *            bounty the record names (makefunCountsOf), its slug, id, address and own entry fee the record's, its
 *            bounty, entrants, entry fees and pot the reading's row of that slug ('gone': the three null); the
 *            reading's `at` as the file's read_at, the record's min_entrants (0 where it names none)
 *   x, under `posts` (an X pool link's plan, HarnessPlan.houseCountsPosts): XEntryLinkRecord with its `posts` list,
 *            XPostsCounts (makefun/x-posts-counts/v1): a row each listed post (xPostsCountsOf), its post id, address
 *            and pool post's id the record's, `post` and its counts the reading slot's own reading of that post
 *            (XPostsEngagementReading.posts), by post id ascending as numbers; the slot's `at` as the file's `at`
 *
 * A record is an X post's when its platform is 'x' and it names its post's id (server/entry-link/x.ts xLinkRecordOf
 * always does); a TikTok video's when its platform is 'tiktok' (server/entry-link/tiktok.ts tiktokLinkRecordOf), its
 * video_id held to TIKTOK_VIDEO_ID by the format.
 * `linkPlatform` is the platform of the bundle's entry link that names the path (harnesses.ts
 * HarnessPlan.houseCountsPlatform): a record of any other platform is the house's fault, never that platform's counts
 * written at the path. Absent or null (a hand-built plan naming none) it compares nothing, the record's platform alone
 * choosing the counts.
 * `counted` is the bundle's make.fun link's count (contracts/competition.ts ProgramEntryLink.counted,
 * entryLinkCountedOf): 'all' lets a found bounty that charges no fee (its record's entry_fee_usd null, its competition
 * id held) write its row's entry_fee_usd as '0.00', since that link's check passes such a bounty; absent, null or
 * 'paying', such a bounty is the house's fault as before (the paying check refuses it). Read on a make.fun record alone.
 * `refused` is the grade's own word that the entry's entry_link check refused its link (entryLinkCheckRefused of the
 * entry's submission.checks): true writes no counts, as a record stamped `refused` (HOUSE_COUNTS_REFUSED_KEY) writes
 * none; absent, null or false, the record's stamp alone decides (houseCountsRefusedOf).
 * `posts` is the plan's word that the link is an X pool link's (harnesses.ts HarnessPlan.houseCountsPosts): true takes
 * the list branch (xPostsCountsOf) whatever the record's shape, so a record with no `posts` list is then the house's
 * fault, never read as its one post; absent, null or false, the record's platform alone chooses its arm, as before the
 * key existed.
 * Where none can be written (HouseCountsOutputs.fault) the path is left empty and `note` says why.
 */
export async function houseCountsOutputs(
  outputs: unknown,
  path: string,
  record: unknown,
  reading: HouseCountsReading,
  blobs: Pick<OutputBlobs, 'put'>,
  linkPlatform?: CountsEntryLinkPlatformT | null,
  counted?: EntryLinkCountedT | null,
  refused?: boolean | null,
  posts?: boolean | null,
): Promise<HouseCountsOutputs> {
  const parsed = ProgramOutputs.parse(outputs);
  const clashes = (p: string): boolean => p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`);
  const dropped = parsed.files.filter((f) => clashes(f.path));
  const files = parsed.files.filter((f) => !clashes(f.path));
  const wrote = dropped.length === 0 ? 'the program wrote nothing there' : `the program's own ${dropped.map((f) => JSON.stringify(f.path)).join(', ')} dropped`;
  const done = (counts: HouseCountsFileT | null, note: string): HouseCountsOutputs => {
    const next: ProgramOutputsT = { format: parsed.format, files, ...(parsed.cases === undefined ? {} : { cases: parsed.cases }) };
    const json = canonicalJson(next);
    return { outputs: next, json, sha256: sha256Hex(json), counts, fault: counts === null, note };
  };
  const fault = (why: string) => done(null, `no house counts at /output/${path}: ${why}, the house's fault and never the entrant's; ${wrote}, so the path is empty`);
  /** The canonical JSON of `counts` put in `blobs` and added at `path`. */
  const kept = async (counts: CountsFileT | BountiesCountsT | XPostsCountsT): Promise<void> => {
    const bytes = new TextEncoder().encode(canonicalJson(counts));
    const put = await blobs.put(bytes);
    files.push({ path, size: bytes.byteLength, sha256: put.sha256 });
    files.sort((a, b) => comparePaths(a.path, b.path));
  };
  const issuesOf = (issues: readonly { path: readonly PropertyKey[]; message: string }[]): string =>
    issues.map((i) => `${i.path.map(String).join('.') || '(file)'}: ${i.message}`).join('; ');
  if (record === null || typeof record !== 'object') return fault('the entry has no entry-link record (the entry-link stage recorded none)');
  const platform = (record as { platform?: unknown }).platform;
  if (linkPlatform !== undefined && linkPlatform !== null && platform !== linkPlatform) {
    const theirs = typeof platform === 'string' ? `a ${JSON.stringify(platform)} record` : 'a record of no platform';
    return fault(`the entry's entry-link record is ${theirs}, not one of the bundle's ${JSON.stringify(linkPlatform)} entry link whose counts the path names`);
  }
  // A link the entry_link check refused is never scored, whatever its read state or reading: the refusal is stated (the
  // record's stamp or the grade's word), never inferred from a null state, which a skip's record holds too.
  const refusal = houseCountsRefusedOf(record, refused);
  if (refusal !== null) {
    const of = platform === 'x' ? 'X record holds no read of the post' : platform === 'tiktok' ? 'TikTok record holds no read of the video' : platform === 'youtube' ? 'YouTube record holds no read of the video' : 'record holds no reading';
    return fault(`the entry's ${of} a grade may score: its entry_link check refused the link (${refusal}), whatever its reading`);
  }
  // An X pool link's list of posts: keyed on the plan's word, never on the record's shape.
  if (posts === true) return xPostsCountsOf(record as XPostsCountsRecord, reading, { fault, done, write: kept, issuesOf, path, wrote });
  if (platform === 'makefun') return makefunCountsOf(record as MakefunCountsRecord, reading, { fault, done, write: kept, issuesOf, path, wrote, freeBounties: counted === 'all' });
  const r = record as { platform?: unknown; video?: unknown; video_id?: unknown; post?: unknown; post_id?: unknown; url?: unknown; engagement?: unknown };
  const engagement = r.engagement !== null && typeof r.engagement === 'object' ? (r.engagement as Record<string, unknown>) : null;
  const raw = engagement?.[reading];
  const taken =
    raw !== null && typeof raw === 'object'
      ? (raw as {
          at?: unknown;
          missing?: unknown;
          gone?: unknown;
          views?: unknown;
          likes?: unknown;
          comments?: unknown;
          replies?: unknown;
          reposts?: unknown;
          quotes?: unknown;
          shares?: unknown;
          saves?: unknown;
        })
      : null;
  const x = r.platform === 'x' && typeof r.post_id === 'string';
  const tiktok = r.platform === 'tiktok';
  if (r.platform !== 'youtube' && !x && !tiktok) return fault("the entry's entry-link record is no YouTube video's or X post's, nor a TikTok video's, nor a make.fun bounty's");
  // The X and TikTok arms: the post's or video's reading, the deadline one taken by the house's deadline pass after the
  // final's lock.
  const which =
    reading === 'intake'
      ? "the intake check's reading (engagement.intake)"
      : x || tiktok
        ? "the final's deadline reading (engagement.deadline)"
        : "the final lock's reading (engagement.deadline)";
  const recordOf = x ? 'X' : tiktok ? 'TikTok' : 'YouTube';
  // A record whose check never read its post or video (its lookup faulted on its last attempt and recorded a skip,
  // `post` or `video` null) holds nothing a dev grade can write. A final grade's deadline reading is the deadline pass's
  // own read of the post or video: one that read it, or found it gone, stands whatever the record's state, so a record
  // whose deadline reading was written before its pass filled the state (server/entry-link/counts-pass.ts
  // countsChunkWriteSql), or without that fill, is scored on it and not held for a redrive that reads nothing more. A
  // refused link's record holds a null state as a skip's does; it never reaches here (houseCountsRefusedOf, above).
  const deadlineRead = reading === 'deadline' && taken !== null && (taken.gone === true || typeof taken.missing !== 'string');
  if (!deadlineRead && (x ? r.post === null || r.post === undefined : r.video === null || r.video === undefined)) {
    return fault(`the entry's ${recordOf} record holds no read of the ${x ? 'post' : 'video'} (the check's lookup faulted on its last attempt and recorded a skip)`);
  }
  if (taken === null) return fault(`${which} is absent from the entry's ${recordOf} record`);
  const gone = taken.gone === true;
  if (typeof taken.missing === 'string' && !gone) return fault(`${which} read nothing (${taken.missing})`);
  const countOf = (v: unknown): number | null => (gone ? null : typeof v === 'number' ? v : null);
  if (x) {
    const counts = XPostCounts.safeParse({
      format: POST_COUNTS_FORMAT,
      platform: 'x',
      post_id: r.post_id,
      url: r.url,
      reading: reading === 'intake' ? 'check' : 'deadline',
      at: taken.at,
      post: gone ? 'gone' : 'public',
      views: countOf(taken.views),
      likes: countOf(taken.likes),
      replies: countOf(taken.replies),
      reposts: countOf(taken.reposts),
      quotes: countOf(taken.quotes),
    });
    if (!counts.success) return fault(`${which} makes no counts file (${issuesOf(counts.error.issues)})`);
    const c = counts.data;
    await kept(c);
    return done(
      c,
      `the house's counts of post ${c.post_id} (${c.reading} reading at ${c.at}: ${c.post === 'gone' ? 'gone' : `${c.views ?? 'no'} views, ${c.likes ?? 'no'} likes, ${c.replies ?? 'no'} replies, ${c.reposts ?? 'no'} reposts, ${c.quotes ?? 'no'} quotes`}) written at /output/${path}; ${wrote}`,
    );
  }
  if (tiktok) {
    const counts = TiktokVideoCounts.safeParse({
      format: TIKTOK_COUNTS_FORMAT,
      platform: 'tiktok',
      video_id: r.video_id,
      url: r.url,
      reading: reading === 'intake' ? 'check' : 'deadline',
      at: taken.at,
      video: gone ? 'gone' : 'public',
      views: countOf(taken.views),
      likes: countOf(taken.likes),
      comments: countOf(taken.comments),
      shares: countOf(taken.shares),
      saves: countOf(taken.saves),
    });
    if (!counts.success) return fault(`${which} makes no counts file (${issuesOf(counts.error.issues)})`);
    const c = counts.data;
    await kept(c);
    return done(
      c,
      `the house's counts of TikTok video ${c.video_id} (${c.reading} reading at ${c.at}: ${c.video === 'gone' ? 'gone' : `${c.views ?? 'no'} views, ${c.likes ?? 'no'} likes, ${c.comments ?? 'no'} comments, ${c.shares ?? 'no'} shares, ${c.saves ?? 'no'} saves`}) written at /output/${path}; ${wrote}`,
    );
  }
  const counts = EntryLinkCounts.safeParse({
    format: ENTRY_LINK_COUNTS_FORMAT,
    platform: 'youtube',
    video_id: r.video_id,
    url: r.url,
    reading: reading === 'intake' ? 'check' : 'deadline',
    at: taken.at,
    video: gone ? 'gone' : 'public',
    views: countOf(taken.views),
    likes: countOf(taken.likes),
    comments: countOf(taken.comments),
  });
  if (!counts.success) return fault(`${which} makes no counts file (${issuesOf(counts.error.issues)})`);
  const c = counts.data;
  await kept(c);
  return done(c, `the house's counts of video ${c.video_id} (${c.reading} reading at ${c.at}: ${c.video === 'gone' ? 'gone' : `${c.views ?? 'no'} views, ${c.likes ?? 'no'} likes, ${c.comments ?? 'no'} comments`}) written at /output/${path}; ${wrote}`);
}

/** An X pool record (server/entry-link/types.ts XEntryLinkRecord with `posts`) as houseCountsOutputs reads it: every field possibly absent or mistyped (a stored jsonb). */
interface XPostsCountsRecord {
  platform?: unknown;
  posts?: unknown;
  engagement?: unknown;
}

/** What houseCountsOutputs hands its X pool branch: its fault and result makers, the writer of the file, the issue joiner, the path and what the program wrote. */
interface XPostsCountsSteps {
  fault: (why: string) => HouseCountsOutputs;
  done: (counts: XPostsCountsT, note: string) => HouseCountsOutputs;
  write: (counts: XPostsCountsT) => Promise<void>;
  issuesOf: (issues: readonly { path: readonly PropertyKey[]; message: string }[]) => string;
  path: string;
  wrote: string;
}

/** The most post ids an X posts counts note names before it says how many more (the file itself names every one). */
const X_POSTS_NOTE_IDS = 5;

/**
 * houseCountsOutputs' X pool branch (HarnessPlan.houseCountsPosts): the list's counts (contracts/entry-link-counts.ts
 * XPostsCounts, makefun/x-posts-counts/v1) of `record`'s reading `reading` (engagement.intake as `reading: 'check'`,
 * engagement.deadline as 'deadline'), written at the path. The posts are the record's `posts` list (file order; the
 * server's server/entry-link/x-record.ts xPostsOf reads the same list), each row its post id, address and pool post's id
 * from the list, beside `post` ('gone' where the slot's reading of that post says so, every count null; else 'public')
 * and its views, likes, replies, reposts and quotes from the slot's own reading of the post
 * (XPostsEngagementReading.posts, by post id); the rows by post id ascending as numbers (compareXPostIds), the slot's
 * `at` the file's. The house's fault, never the entrant's: a record of another platform than 'x', one with no `posts`
 * list (a list link's record must list its posts: a one-post record is never read as a list of one), a listed post with
 * no id, no readings, the slot absent or holding no per-post readings (`posts`), a listed post with no reading in it or
 * one that read nothing (`missing` without `gone`), a post never read whose reading is the intake one (its `post` null:
 * the check's lookup faulted; a deadline reading that read the post, or found it gone, stands whatever the list's
 * state, as the one-post arm's does), a file the format refuses (a post or a pool post named twice, an id or address
 * that is none, a pool tie missing), or one over X_POSTS_COUNTS_MAX_BYTES.
 */
async function xPostsCountsOf(r: XPostsCountsRecord, reading: HouseCountsReading, steps: XPostsCountsSteps): Promise<HouseCountsOutputs> {
  const { fault, done, write, issuesOf, path, wrote } = steps;
  const which = reading === 'intake' ? "the intake check's reading (engagement.intake)" : "the final's deadline reading (engagement.deadline)";
  if (r.platform !== 'x') {
    const theirs = typeof r.platform === 'string' ? `a ${JSON.stringify(r.platform)} record` : 'a record of no platform';
    return fault(`the entry's entry-link record is ${theirs}, not an X record listing the posts of the bundle's X pool link`);
  }
  if (!Array.isArray(r.posts) || r.posts.length === 0) {
    return fault("the entry's X record lists no posts (no `posts` list): the bundle's X link names a pool, whose record lists every post its file names, and a record of one post is never read as a list of one");
  }
  const listed: { post_id: string; url: unknown; pool_post_id: unknown; post: unknown }[] = [];
  for (const [i, item] of (r.posts as unknown[]).entries()) {
    const p = item !== null && typeof item === 'object' ? (item as { post_id?: unknown; url?: unknown; pool_post_id?: unknown; post?: unknown }) : {};
    if (typeof p.post_id !== 'string' || p.post_id === '') return fault(`the entry's X record lists a post with no id (posts.${i})`);
    listed.push({ post_id: p.post_id, url: p.url, pool_post_id: p.pool_post_id, post: p.post });
  }
  const of = listed.length === 1 ? `post ${listed[0]!.post_id}` : `${listed.length} posts`;
  const engagement = r.engagement !== null && typeof r.engagement === 'object' ? (r.engagement as Record<string, unknown>) : null;
  if (engagement === null) return fault(`the entry's X record of ${of} holds no readings (its check took none)`);
  const raw = engagement[reading];
  const slot = raw !== null && typeof raw === 'object' ? (raw as { at?: unknown; posts?: unknown }) : null;
  if (slot === null) return fault(`${which} is absent from the entry's X record of ${of}`);
  const byId = slot.posts !== null && typeof slot.posts === 'object' && !Array.isArray(slot.posts) ? (slot.posts as Record<string, unknown>) : null;
  if (byId === null) return fault(`${which} holds no per-post readings (no \`posts\` map) of the entry's X record of ${of}`);
  const rows: Record<string, unknown>[] = [];
  for (const p of listed) {
    const own = Object.hasOwn(byId, p.post_id) ? byId[p.post_id] : null;
    const taken = own !== null && typeof own === 'object' ? (own as { missing?: unknown; gone?: unknown; views?: unknown; likes?: unknown; replies?: unknown; reposts?: unknown; quotes?: unknown }) : null;
    if (taken === null) return fault(`${which} holds no reading of post ${p.post_id}`);
    const gone = taken.gone === true;
    if (typeof taken.missing === 'string' && !gone) return fault(`${which} read nothing of post ${p.post_id} (${taken.missing})`);
    // As the one-post arm: an intake reading of a post its check never read stands for nothing; a deadline reading is the
    // deadline pass's own read (read or gone: it reached here), whatever the list's state.
    if (reading === 'intake' && (p.post === null || p.post === undefined)) {
      return fault(`the entry's X record holds no read of post ${p.post_id} (the check's lookup faulted on its last attempt and recorded a skip)`);
    }
    const countOf = (v: unknown): number | null => (gone ? null : typeof v === 'number' ? v : null);
    rows.push({
      post_id: p.post_id,
      url: p.url,
      pool_post_id: p.pool_post_id,
      post: gone ? 'gone' : 'public',
      views: countOf(taken.views),
      likes: countOf(taken.likes),
      replies: countOf(taken.replies),
      reposts: countOf(taken.reposts),
      quotes: countOf(taken.quotes),
    });
  }
  rows.sort((a, z) => compareXPostIds(a.post_id as string, z.post_id as string));
  const counts = XPostsCounts.safeParse({ format: X_POSTS_COUNTS_FORMAT, platform: 'x', reading: reading === 'intake' ? 'check' : 'deadline', at: slot.at, posts: rows });
  if (!counts.success) return fault(`${which} makes no counts file (${issuesOf(counts.error.issues)})`);
  const c = counts.data;
  const bytes = new TextEncoder().encode(canonicalJson(c)).byteLength;
  if (bytes > X_POSTS_COUNTS_MAX_BYTES) return fault(`${which} makes a counts file of ${bytes} bytes, over the ${X_POSTS_COUNTS_MAX_BYTES} an X posts counts file holds`);
  await write(c);
  const ids = c.posts.map((row) => row.post_id);
  const whose = ids.length === 1 ? `post ${ids[0]}` : `${ids.length} posts (${ids.slice(0, X_POSTS_NOTE_IDS).join(', ')}${ids.length > X_POSTS_NOTE_IDS ? `, and ${ids.length - X_POSTS_NOTE_IDS} more` : ''})`;
  const publicRows = c.posts.filter((row) => row.post === 'public');
  const sum = (key: 'views' | 'likes' | 'replies' | 'reposts' | 'quotes'): number => publicRows.reduce((n, row) => n + (row[key] ?? 0), 0);
  const read =
    publicRows.length === 0
      ? c.posts.length === 1
        ? 'gone'
        : `all ${c.posts.length} gone`
      : `${publicRows.length} of ${c.posts.length} public: ${sum('views')} views, ${sum('likes')} likes, ${sum('replies')} replies, ${sum('reposts')} reposts, ${sum('quotes')} quotes`;
  return done(c, `the house's counts of ${whose} (${c.reading} reading at ${c.at}: ${read}) written at /output/${path}; ${wrote}`);
}

/** A make.fun record (server/entry-link/types.ts MakefunEntryLinkRecord) as houseCountsOutputs reads it: every field possibly absent or mistyped (a stored jsonb). */
interface MakefunCountsRecord {
  platform: 'makefun';
  bounties?: unknown;
  min_entrants?: unknown;
  url?: unknown;
  slug?: unknown;
  competition_id?: unknown;
  entry_fee_usd?: unknown;
  readings?: unknown;
}

/** What houseCountsOutputs hands its make.fun branch: its fault and result makers, the writer of the file, the issue joiner, the path and what the program wrote. */
interface HouseCountsSteps {
  fault: (why: string) => HouseCountsOutputs;
  done: (counts: BountiesCountsT, note: string) => HouseCountsOutputs;
  write: (counts: BountiesCountsT) => Promise<void>;
  issuesOf: (issues: readonly { path: readonly PropertyKey[]; message: string }[]) => string;
  path: string;
  wrote: string;
  /** Whether the bundle's link counts every entrant (counted 'all'): a found bounty charging no fee then writes '0.00'. */
  freeBounties: boolean;
}

/** The most slugs a make.fun counts note names before it says how many more (the file itself names every one). */
const MAKEFUN_NOTE_SLUGS = 5;

/** Whole cents as a USD decimal (contracts/entry-link-counts.ts USD_DECIMAL): dollars, a point and two cents digits. */
function usdOfCents(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * houseCountsOutputs' make.fun branch: the bounty list's counts (contracts/entry-link-counts.ts BountiesCounts,
 * makefun/bounty-counts/v2) of `record`'s reading `reading` (readings.intake as `reading: 'check'`, readings.deadline
 * as 'deadline'), written at the path. The bounties are the record's `bounties` list, or, on a record with no list (one
 * stored before an entry could name several, or an empty list no stage writes), its top-level fields as its one bounty
 * (as server/entry-link/makefun-record.ts makefunBountiesOf reads it). Each bounty's row is its slug, competition id,
 * address and own entry fee from the record, beside its bounty, entrants, entry fees and pot from the reading's row of
 * its slug (MakefunBountyReading.bounties); a reading with no rows (taken before an entry could name several bounties)
 * is its top-level counts as the one bounty's row, its pot null where it predates pots (makefunReadingRowsOf). The rows
 * go by slug ascending in code-unit order, `min_entrants` is the record's (0 where it names none), `read_at` the
 * reading's `at`. A found bounty charging no fee (its competition id held, its entry fee null) writes '0.00' under a
 * link counting every entrant (`steps.freeBounties`, counted 'all', whose check passes such a bounty). The house's
 * fault, never the entrant's: a record naming no bounty, a named bounty with no slug, no competition id or no entry fee
 * (none of the slug was found, or, under a paying link, it charges none: its check did not pass), no readings, the
 * reading absent, a reading holding no row of a named bounty, a live row with no pot (a reading taken before pots were
 * read: redrive its entry-link check), or anything else that makes no counts file.
 */
async function makefunCountsOf(r: MakefunCountsRecord, reading: HouseCountsReading, steps: HouseCountsSteps): Promise<HouseCountsOutputs> {
  const { fault, done, write, issuesOf, path, wrote, freeBounties } = steps;
  const which = reading === 'intake' ? "the intake check's reading (readings.intake)" : "the final lock's reading (readings.deadline)";
  const listed = Array.isArray(r.bounties) && r.bounties.length > 0;
  const named: readonly unknown[] = listed ? (r.bounties as unknown[]) : [{ url: r.url, slug: r.slug, competition_id: r.competition_id, entry_fee_usd: r.entry_fee_usd }];
  const bounties: { slug: string; id: string; url: unknown; fee: string }[] = [];
  for (const [i, item] of named.entries()) {
    const b = item !== null && typeof item === 'object' ? (item as { url?: unknown; slug?: unknown; competition_id?: unknown; entry_fee_usd?: unknown }) : {};
    if (typeof b.slug !== 'string' || b.slug === '') {
      return fault(listed ? `the entry's make.fun record names a bounty with no slug (bounties.${i})` : "the entry's make.fun record names no bounty (no bounty list and no slug)");
    }
    if (typeof b.competition_id !== 'string') return fault(`the entry's make.fun record holds no id of bounty ${b.slug} (none of the slug was found: its check did not pass)`);
    // Under counted 'all' a bounty charging no fee passed its check: its row says so as '0.00'.
    const fee = typeof b.entry_fee_usd === 'string' ? b.entry_fee_usd : freeBounties && b.entry_fee_usd === null ? '0.00' : null;
    if (fee === null) return fault(`the entry's make.fun record holds no entry fee of bounty ${b.slug} (none of the slug was found, or it charges none: its check did not pass)`);
    bounties.push({ slug: b.slug, id: b.competition_id, url: b.url, fee });
  }
  const of = bounties.length === 1 ? `bounty ${bounties[0]!.slug}` : `${bounties.length} bounties`;
  const readings = r.readings !== null && typeof r.readings === 'object' ? (r.readings as Record<string, unknown>) : null;
  if (readings === null) return fault(`the entry's make.fun record of ${of} holds no readings (its check took none)`);
  const raw = readings[reading];
  const taken =
    raw !== null && typeof raw === 'object'
      ? (raw as { at?: unknown; bounty?: unknown; entrants?: unknown; entry_fees_usd?: unknown; pot_usd?: unknown; bounties?: unknown })
      : null;
  if (taken === null) return fault(`${which} is absent from the entry's make.fun record of ${of}`);
  const rows = taken.bounties !== null && typeof taken.bounties === 'object' && !Array.isArray(taken.bounties) ? (taken.bounties as Record<string, unknown>) : null;
  /** The reading's row of `slug`: under its slug in the rows, or, on a reading with none and a record of one bounty, its top-level counts; null where it holds none. */
  const rowOf = (slug: string): { bounty?: unknown; entrants?: unknown; entry_fees_usd?: unknown; pot_usd?: unknown } | null => {
    if (rows !== null) {
      const row = Object.hasOwn(rows, slug) ? rows[slug] : null;
      return row !== null && typeof row === 'object' ? (row as { bounty?: unknown; entrants?: unknown; entry_fees_usd?: unknown; pot_usd?: unknown }) : null;
    }
    return bounties.length === 1 ? { bounty: taken.bounty, entrants: taken.entrants, entry_fees_usd: taken.entry_fees_usd, pot_usd: taken.pot_usd ?? null } : null;
  };
  const fileRows: Record<string, unknown>[] = [];
  for (const b of bounties) {
    const row = rowOf(b.slug);
    if (row === null) {
      return fault(
        rows === null
          ? `${which} holds no row of bounty ${b.slug} (it carries one bounty's counts and the record names ${bounties.length}: a reading taken before an entry could name several bounties)`
          : `${which} holds no row of bounty ${b.slug}`,
      );
    }
    if (row.bounty === 'live' && (row.pot_usd === null || row.pot_usd === undefined)) {
      return fault(`${which} reads bounty ${b.slug} live with no pot (a reading taken before pots were read: redrive its entry-link check)`);
    }
    fileRows.push({ slug: b.slug, id: b.id, url: b.url, bounty: row.bounty, entrants: row.entrants, entry_fees_usd: row.entry_fees_usd, pot_usd: row.pot_usd, entry_fee_usd: b.fee });
  }
  fileRows.sort((a, z) => compareCodeUnits(a.slug as string, z.slug as string));
  const counts = bountiesCountsSchemaOf(freeBounties ? 'all' : 'paying').safeParse({
    format: BOUNTIES_COUNTS_FORMAT,
    reading: reading === 'intake' ? 'check' : 'deadline',
    read_at: taken.at,
    min_entrants: r.min_entrants === undefined || r.min_entrants === null ? 0 : r.min_entrants,
    bounties: fileRows,
  });
  if (!counts.success) return fault(`${which} makes no counts file (${issuesOf(counts.error.issues)})`);
  const c = counts.data;
  await write(c);
  const slugs = c.bounties.map((row) => row.slug);
  const whose =
    slugs.length === 1
      ? `bounty ${slugs[0]}`
      : `${slugs.length} bounties (${slugs.slice(0, MAKEFUN_NOTE_SLUGS).join(', ')}${slugs.length > MAKEFUN_NOTE_SLUGS ? `, and ${slugs.length - MAKEFUN_NOTE_SLUGS} more` : ''})`;
  let read: string;
  if (c.bounties.length === 1 && c.bounties[0]!.bounty === 'gone') read = 'gone';
  else {
    try {
      const t = bountiesTotalsOf(c.bounties, c.min_entrants);
      read = `${t.live} of ${c.bounties.length} live, ${t.bounties} counting at min_entrants ${c.min_entrants}: ${t.entrants} entrants, ${usdOfCents(t.entry_fees_cents)} USD in entry fees, ${usdOfCents(t.pot_cents)} USD in pots`;
    } catch (err) {
      // A sum past the safe integers (no file of amounts a sponsor can fund reaches one): the file stands, the note says so.
      if (!(err instanceof RangeError)) throw err;
      read = `totals past Number.MAX_SAFE_INTEGER (${err.message})`;
    }
  }
  return done(c, `the house's counts of ${whose} (${c.reading} reading at ${c.read_at}: ${read}) written at /output/${path}; ${wrote}`);
}

/** One case of a run per case, as the reference manifest names it. */
export interface ProgramCase {
  id: string;
  time_cap_ms: number;
}

/**
 * The longest reference manifest programCases reads, in bytes (1 MiB): a longer one fails every grade on its phase.
 * proposal_pack refuses a test pack whose reference manifest is longer (server/proposals/checks.ts
 * PACK_MANIFEST_MAX_BYTES, held equal to this by proposal-packs.test.ts).
 */
export const MAX_CASES_MANIFEST_BYTES = 1024 * 1024;

const CasesManifest = z.object({
  cases: z.array(z.object({ id: z.string().regex(PROGRAM_CASE_ID_RE), time_cap_ms: z.int().min(1) })),
});

/**
 * The cases of a run per case: <referenceDir>/manifest.json's cases (server/proposals/packs.ts
 * PackReferenceManifest, which the house writes and the pack's tree digest seals), their ids and time caps,
 * in its order, each id once (letter case ignored). Anything else is the competition's fault: ScorerError.
 */
export function programCases(referenceDir: string): ProgramCase[] {
  const file = join(referenceDir, 'manifest.json');
  let raw: unknown;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_CASES_MANIFEST_BYTES) throw new Error(`not a regular file of at most ${MAX_CASES_MANIFEST_BYTES} bytes`);
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ScorerError(`one run per case reads its cases from the reference's manifest.json, which does not read: ${(err as Error).message}`);
  }
  const parsed = CasesManifest.safeParse(raw);
  if (!parsed.success) throw new ScorerError(`the reference's manifest.json names no cases a run per case can take: ${parsed.error.issues[0]?.message ?? 'malformed'}`);
  const seen = new Set<string>();
  for (const c of parsed.data.cases) {
    if (seen.has(c.id.toLowerCase())) throw new ScorerError(`the reference's manifest.json names case ${c.id} twice (letter case ignored)`);
    seen.add(c.id.toLowerCase());
  }
  return parsed.data.cases.map((c) => ({ id: c.id, time_cap_ms: c.time_cap_ms }));
}

/**
 * One run per case (the header): every case of the reference manifest, each in its own work directory under opts.workDir;
 * all of them in one session of the sandbox's when it has sessions, closed however the execution ends.
 */
async function executePerCase(opts: ProgramExecutionOptions): Promise<Execution<ProgramOutputsT>> {
  const paths = programPaths(opts.setup);
  if (paths.inputDir === null) throw new ScorerError('one run per case reads each case from the input data, and there is none');
  const cases = programCases(paths.referenceDir);
  // Loaded here, not with this module: grade.ts reaches this module as it loads (through harnesses.ts).
  const { removeScratch } = await import('./grade.ts');
  const label = opts.label ?? 'program';
  const files: ProgramOutputsT['files'] = [];
  const runs: NonNullable<ProgramOutputsT['cases']> = [];
  const flags = new Set<string>();
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let wall = 0;
  const caseDirOf = (i: number): string => join(opts.workDir, `case-${i}`);
  // On a sandbox with sessions, every case runs in one session (the header): its template the cases' spec, here with the
  // first case's directories (a run's host directories are its own). Its scratch is still removed by the sandbox itself.
  const sessions = opts.sandbox.sessions;
  const session =
    sessions === undefined
      ? null
      : sessions.open(entrySpec(opts, { inputDir: join(caseDirOf(0), 'input'), outputDir: join(caseDirOf(0), 'output'), limits: opts.limits, label: `${label}-cases` }));
  const runOn = session === null ? opts : { ...opts, sandbox: session };
  try {
    for (const [i, c] of cases.entries()) {
      const caseDir = caseDirOf(i);
      await mkdir(caseDir, { mode: 0o700 });
      try {
        // Only this case's input, read-only, where the sandbox user can read it.
        const inputDir = join(caseDir, 'input');
        await mkdir(inputDir, { mode: 0o700 });
        let bytes: Buffer;
        try {
          bytes = await readFile(join(paths.inputDir, `${c.id}.in`));
        } catch (err) {
          throw new ScorerError(`case ${c.id} has no input: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message} reading ${c.id}.in`);
        }
        await writeFile(join(inputDir, `${c.id}.in`), bytes, { flag: 'wx', mode: 0o600 });
        await sealStaged(inputDir);
        const e = await executeIn(runOn, {
          inputDir,
          outputDir: join(caseDir, 'output'),
          limits: { ...opts.limits, wall_budget_sec: c.time_cap_ms / 1000 },
          label: `${label}-c${i}`,
        });
        runs.push({ id: c.id, status: e.status });
        wall += e.wall_ms;
        if (e.status === 'ok') {
          for (const f of e.flags) flags.add(f);
          const out = e.log?.files.find((f) => f.path === `${c.id}.out`);
          if (out !== undefined) files.push(out);
        }
        const head = Buffer.from(`--- case ${c.id}: ${e.status}${e.error === null ? '' : ` (${e.error})`} ---\n`, 'utf8');
        for (const part of [head, e.stderr]) {
          const room = MAX_STDERR_BYTES - stderrBytes;
          if (room <= 0) break;
          const kept = part.subarray(0, room);
          stderr.push(kept);
          stderrBytes += kept.length;
        }
      } finally {
        await removeScratch(opts.sandbox, caseDir);
      }
    }
  } finally {
    await session?.close();
  }
  files.sort((a, b) => comparePaths(a.path, b.path));
  const log: ProgramOutputsT = { format: PROGRAM_OUTPUTS_FORMAT, files, cases: runs };
  const json = canonicalJson(log);
  return { status: 'ok', error: null, log, log_json: json, log_sha256: sha256Hex(json), wall_ms: wall, flags: [...flags].sort(), stderr: Buffer.concat(stderr), exit: null };
}

/**
 * The entry's own environment (the header's entry env): MAKEFUN_BOT_DIR, the bundle's name for its tree, set to the tree
 * this spec mounts at /bot — the host code directory on the process driver (whose program's cwd is there already), and
 * '/bot' in a container, where the cwd is the image's. No entry secret can share the name: every MAKEFUN_* name is
 * reserved for secrets (contracts/entry-secrets.ts reservedSecretName), so the entry's variables never collide with it.
 * No other variable here: a mount variable is each driver's own (types.ts MOUNT_POINTS, checkSandboxEnv).
 */
function entryEnv(opts: Pick<ProgramExecutionOptions, 'sandbox' | 'botDir'>): Pick<SandboxSpec, 'env'> {
  return { env: { MAKEFUN_BOT_DIR: opts.sandbox.kind === 'process' ? opts.botDir : '/bot' } };
}

/** What one run of the entry is spawned with (executeIn): `inputDir` (null: none) read-only at /input, `outputDir` writable at /output, under `limits`. */
function entrySpec(
  opts: Pick<ProgramExecutionOptions, 'sandbox' | 'runtime' | 'botDir' | 'imageDigest' | 'secrets'>,
  run: { inputDir: string | null; outputDir: string; limits: LimitsT; label: string },
): SandboxSpec {
  return {
    runtime: opts.runtime,
    codeDir: opts.botDir,
    mounts: [
      ...(run.inputDir === null ? [] : [{ host: run.inputDir, at: '/input' as const, readOnly: true }]),
      { host: run.outputDir, at: '/output' as const, readOnly: false, returns: OUTPUT_RETURNS },
    ],
    limits: run.limits,
    label: run.label,
    imageDigest: opts.imageDigest ?? null,
    ...entryEnv(opts),
    ...specSecrets(opts.secrets),
  };
}

/** One run of the entry: `inputDir` (null: none) at /input, a fresh `outputDir` at /output, under `limits`. */
async function executeIn(
  opts: Pick<ProgramExecutionOptions, 'sandbox' | 'runtime' | 'botDir' | 'blobs' | 'imageDigest' | 'secrets'>,
  run: { inputDir: string | null; outputDir: string; limits: LimitsT; label: string },
): Promise<Execution<ProgramOutputsT>> {
  const { outputDir } = run;
  // The entrant's env-lane secrets (the header's entry secrets): the entry's own variables, masked out of all it says here.
  const forms = entrySecretForms(opts.secrets);
  await mkdir(outputDir, { mode: 0o700 });
  // The sandbox user (65534) writes here; the work dir above stays private to this process.
  await chmod(outputDir, 0o777);
  const spec = entrySpec(opts, run);
  // The sandbox's own count of /output (the header: docker's whatever its modes, k8s's with its unread directories); null on the process driver.
  let meter: TreeMeter | null = null;
  // Its fault: the sandbox's, never the entry's.
  let meterFault: string | null = null;
  const unmetered = () => (meterFault === null ? null : new SandboxError(`the sandbox could not meter /output: ${meterFault}`));
  const grace = new UnreadGrace(OUTPUT_WATCH_MS);
  // What the meter reports goes to the program's supervisor, made as soon as the program is: a driver reports from its
  // meter's output, never inside the call that starts it, so `live.sup` is set by the time a report arrives.
  const live: { sup: Supervisor | null } = { sup: null };
  const meterOpts: TreeMeterOptions = {
    runtime: opts.runtime,
    imageDigest: opts.imageDigest ?? null,
    label: run.label,
    budgetMs: run.limits.wall_budget_sec * 1000,
    intervalMs: OUTPUT_WATCH_MS,
    maxEntries: MAX_OUTPUT_FILES,
    maxBytes: MAX_OUTPUT_BYTES,
    maxDepth: MAX_OUTPUT_DEPTH,
    maxPathBytes: MAX_OUTPUT_PATH_BYTES,
    onUsage: (u) => {
      const running = live.sup;
      const broken = outputReadingBroken(u, grace);
      if (running !== null && broken !== null && running.exit === null) running.violate(broken);
    },
    onFault: (why) => {
      const running = live.sup;
      if (running === null || running.exit !== null || running.stopped !== null) return;
      meterFault = why;
      void running.kill();
    },
  };
  // The program, then (below) its meter.
  const proc = opts.sandbox.spawn(spec);
  const sup = new Supervisor(proc, {
    budgetMs: run.limits.wall_budget_sec * 1000,
    maxStderrBytes: MAX_STDERR_BYTES,
    stdout: { mode: 'capture', maxBytes: MAX_PROGRAM_STDOUT_BYTES },
  });
  live.sup = sup;
  sup.closeStdin();
  let watching = false;
  // The host walker judges only while the program runs: from its end (sup.endedAt: the process's `finished` where the
  // driver has one, else its exit) a tick does nothing and a walk in flight is dropped. On k8s the driver fills the host
  // directory with /output's replica after `finished` and before `exited`: that replica is the collector's to judge
  // (`output violation: …`), never a live `limit: …`.
  const watcher = setInterval(() => {
    if (watching || sup.endedAt !== null || sup.stopped !== null) return;
    watching = true;
    void walkOutputs(outputDir, true)
      .then((w) => {
        if ('violation' in w && sup.endedAt === null) sup.violate(w.violation);
      })
      .catch(() => undefined)
      .finally(() => {
        watching = false;
      });
  }, OUTPUT_WATCH_MS);
  try {
    meter = opts.sandbox.meterTree?.(outputDir, meterOpts) ?? null;
    const exit = await sup.waitExit(Math.max(0, sup.remainingMs()));
    await meter?.stop();
    const fault = unmetered();
    if (fault !== null) throw fault;
    if (exit === 'grace') {
      await sup.kill();
      return executionOf<ProgramOutputsT>('timeout', 'the wall budget ran out', null, sup, [], forms);
    }
    if (opts.sandbox.isDriverFailure(exit)) throw driverFailure(proc, `the sandbox failed (${describeExit(exit)}): ${stderrTail(sup.stderr(), undefined, forms)}`);
    if (exit.code !== 0) return executionOf<ProgramOutputsT>('failed', `the program exited with ${describeExit(exit)}`, null, sup, [], forms);
    const collected = await collectOutputs(outputDir, opts.blobs);
    if ('violation' in collected) return executionOf<ProgramOutputsT>('failed', `output violation: ${collected.violation}`, null, sup, [], forms);
    return executionOf('ok', null, collected.outputs, sup, [], forms);
  } catch (err) {
    await sup.kill();
    await meter?.stop();
    if (!(err instanceof Stopped)) throw err;
    const fault = unmetered();
    if (fault !== null) throw fault;
    const r = err.reason;
    if (r.kind === 'timeout') return executionOf<ProgramOutputsT>('timeout', 'the wall budget ran out', null, sup, [], forms);
    if (r.kind === 'violation') return executionOf<ProgramOutputsT>('failed', `limit: ${r.message}`, null, sup, [], forms);
    if (opts.sandbox.isDriverFailure(r.exit)) throw driverFailure(proc, `the sandbox failed (${describeExit(r.exit)}): ${stderrTail(sup.stderr(), undefined, forms)}`);
    return executionOf<ProgramOutputsT>('failed', describeStop(r), null, sup, [], forms);
  } finally {
    clearInterval(watcher);
    await meter?.stop();
  }
}

// ---------------------------------------------------------------- scoring

export interface ProgramScoreOptions {
  sandbox: Sandbox;
  setup: ProgramSetup;
  outputs: ProgramOutputsT;
  blobs: OutputBlobs;
  limits: LimitsT;
  /** A fresh, empty directory (the outputs and scores land under it). */
  workDir: string;
  label?: string;
  /** The graded entry's measured run time, written to /scores/run.json for the scorer (the header); none writes no file. */
  run?: ProgramRunTime | null;
}

/** The file a grade's scorer finds its entry's run time in, under /scores (the header). */
export const RUN_FILE = 'run.json';
export const PROGRAM_RUN_FORMAT = 'makefun/program-run/v1';

/** A graded run's measured wall time: its executions' total, and how many there were. */
export interface ProgramRunTime {
  /** The executions' wall time summed (GradeOutcome.wall_ms, run.wall_ms), in ms. */
  wall_ms_total: number;
  /** How many executions that sums (GradeOutcome.exec_count, run.exec_count): at least 1. */
  executions: number;
}

/** The run time as /scores/run.json holds it, or null when there is none to state (no execution, or no finite total). */
export function programRunFile(run: ProgramRunTime | null | undefined): string | null {
  if (run === null || run === undefined) return null;
  if (!Number.isInteger(run.executions) || run.executions < 1 || !Number.isFinite(run.wall_ms_total) || run.wall_ms_total < 0) return null;
  return canonicalJson({ executions: run.executions, format: PROGRAM_RUN_FORMAT, wall_ms: Math.round(run.wall_ms_total / run.executions) });
}

/** Write the outputs back from the blob store into `dir` (verified), then make the tree read-only. */
export async function materializeOutputs(outputs: ProgramOutputsT, blobs: OutputBlobs, dir: string): Promise<void> {
  const parsed = ProgramOutputs.parse(outputs);
  await mkdir(dir, { mode: 0o700 });
  const dirs = new Set<string>();
  for (const f of parsed.files) {
    const segs = f.path.split('/');
    if (segs.some((s) => !SEGMENT.test(s))) throw new ScorerError(`output path ${JSON.stringify(f.path)} is not a plain relative path`);
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/');
      if (!dirs.has(d)) {
        await mkdir(join(dir, d), { mode: 0o700 });
        dirs.add(d);
      }
    }
    const bytes = await blobs.get(f.sha256, { verify: true });
    if (bytes === null || bytes.byteLength !== f.size) throw new ScorerError(`output ${f.path} (${f.sha256}) is missing from the blob store`);
    await writeFile(join(dir, f.path), bytes, { flag: 'wx', mode: 0o600 });
  }
  await sealStaged(dir);
}

/** The modes sealStaged sets: a file's, a file's that had an execute bit, a directory's. Every one is readable by anyone, the sandbox user among them. */
export interface StagedModes {
  readonly file: number;
  readonly exec: number;
  readonly dir: number;
}
/** Data a sandbox reads (an /input, a /reference, the outputs a scorer reads, a cassette, a seed): written by no one. */
export const STAGED_READ_ONLY: StagedModes = Object.freeze({ file: 0o444, exec: 0o555, dir: 0o555 });
/** Data whose directories this process still adds to or removes with a plain rm (a drawn instance): its files written by no one. */
export const STAGED_OWNER_DIRS: StagedModes = Object.freeze({ file: 0o444, exec: 0o555, dir: 0o755 });
/**
 * Code a program runs in (its directory the program's cwd on the process driver: a scorer, an env, a gateway, a
 * generator, a scrape starter): still its owner's to write, so a program that writes beside its files runs as before.
 */
export const STAGED_OWNER_WRITES: StagedModes = Object.freeze({ file: 0o644, exec: 0o755, dir: 0o755 });

/** The mode sealStaged gives a path of mode `mode`, or null for one it leaves (a link, a special file). */
function stagedMode(st: { mode: number; isDirectory(): boolean; isFile(): boolean }, modes: StagedModes): number | null {
  if (st.isDirectory()) return modes.dir;
  if (st.isFile()) return (st.mode & 0o111) !== 0 ? modes.exec : modes.file;
  return null;
}

/**
 * Leave the path `root` (a file, or a directory with everything under it) as staged for the sandbox (the header's
 * Staging): each mode set here, explicitly, after the writes (`modes`, default STAGED_READ_ONLY), a directory's once
 * everything in it is. A link is left as it is, never followed.
 */
export async function sealStaged(root: string, modes: StagedModes = STAGED_READ_ONLY): Promise<void> {
  const st = await lstat(root);
  const mode = stagedMode(st, modes);
  if (mode === null) return;
  if (st.isDirectory()) for (const name of await readdir(root)) await sealStaged(join(root, name), modes);
  await chmod(root, mode);
}

/** sealStaged, on node:fs's synchronous calls (a command line's staging that is synchronous itself). */
export function sealStagedSync(root: string, modes: StagedModes = STAGED_READ_ONLY): void {
  const st = lstatSync(root);
  const mode = stagedMode(st, modes);
  if (mode === null) return;
  if (st.isDirectory()) for (const name of readdirSync(root)) sealStagedSync(join(root, name), modes);
  chmodSync(root, mode);
}

/** One output file read back: its manifest row and its bytes, verified against it. */
export interface ProgramOutputRead {
  path: string;
  size: number;
  sha256: string;
  bytes: Uint8Array;
}

/** One output file's manifest row in its run's action log: its path, size and sha256 (readOutputManifest). */
export type ProgramOutputRow = Omit<ProgramOutputRead, 'bytes'>;

/**
 * The manifest row of the output file at `path` of the run whose action log (its ProgramOutputs, canonical JSON) is blob
 * `actionLogSha256`, the action log alone read back and verified, never the file's bytes: what a judge heat's field read
 * takes an entry's artifact sha256 and size from where it needs no bytes (grader/worker.ts judgeHeatFieldRead). Null
 * when the outputs hold no file at `path`. An Error, readOutputFile's own, when the action log is missing, corrupt or no
 * program's outputs.
 */
export async function readOutputManifest(blobs: Pick<OutputBlobs, 'get'>, actionLogSha256: string, path: string): Promise<ProgramOutputRow | null> {
  const log = await blobs.get(actionLogSha256, { verify: true });
  if (log === null) throw new Error(`action log ${actionLogSha256} is missing from the blob store`);
  if (sha256Hex(log) !== actionLogSha256) throw new Error(`action log ${actionLogSha256} is corrupt: its bytes hash to ${sha256Hex(log)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(log).toString('utf8'));
  } catch {
    throw new Error(`action log ${actionLogSha256} is not JSON`);
  }
  const parsed = ProgramOutputs.safeParse(raw);
  if (!parsed.success) throw new Error(`action log ${actionLogSha256} is no program's outputs: ${parsed.error.issues[0]?.message ?? 'malformed'}`);
  const f = parsed.data.files.find((x) => x.path === path);
  if (f === undefined) return null;
  return { path: f.path, size: f.size, sha256: f.sha256 };
}

/**
 * The bytes of `row`, an output file's manifest row in action log `actionLogSha256` (readOutputManifest), read back from
 * the blob store and verified against it. An Error, readOutputFile's own, when they are missing or are not the row's.
 */
export async function readOutputRowBytes(blobs: Pick<OutputBlobs, 'get'>, actionLogSha256: string, row: ProgramOutputRow): Promise<Uint8Array> {
  const bytes = await blobs.get(row.sha256, { verify: true });
  if (bytes === null || bytes.byteLength !== row.size || sha256Hex(bytes) !== row.sha256) throw new Error(`output ${row.path} (${row.sha256}) of action log ${actionLogSha256} is missing from the blob store, or is not its bytes`);
  return bytes;
}

/**
 * The output file at `path` of the run whose action log (its ProgramOutputs, canonical JSON) is blob `actionLogSha256`,
 * read back from the blob store and verified: what a judge heat judges (contracts/competition.ts ProgramJudge.artifact;
 * grader/worker.ts judgeHeatOf). Null when the outputs hold no file at `path`. An Error when the action log is missing,
 * corrupt or no program's outputs (readOutputManifest), or the file's bytes are missing or are not the manifest's
 * (readOutputRowBytes).
 */
export async function readOutputFile(blobs: Pick<OutputBlobs, 'get'>, actionLogSha256: string, path: string): Promise<ProgramOutputRead | null> {
  const f = await readOutputManifest(blobs, actionLogSha256, path);
  if (f === null) return null;
  return { ...f, bytes: await readOutputRowBytes(blobs, actionLogSha256, f) };
}

/** What one scorer run wrote, validated: its scores.json, and its checks.json (null when it wrote none). */
export interface ProgramScored {
  scores: ProgramScores;
  checks: ScorerChecksT | null;
}

/**
 * Run the competition's scorer on stored outputs and return the validated scores. A malformed checks.json fails it all the
 * same (scoreProgramWithChecks); grading drops one instead (harnesses.ts scoreProgramBreakdown).
 */
export async function scoreProgram(opts: ProgramScoreOptions): Promise<ProgramScores> {
  return (await scoreProgramWithChecks(opts)).scores;
}

/** Run the competition's scorer on stored outputs and return the validated scores and per-check rows (the header). */
export async function scoreProgramWithChecks(opts: ProgramScoreOptions): Promise<ProgramScored> {
  const paths = programPaths(opts.setup);
  const outputDir = join(opts.workDir, 'outputs');
  const scoresDir = join(opts.workDir, 'scores');
  await materializeOutputs(opts.outputs, opts.blobs, outputDir);
  await mkdir(scoresDir, { mode: 0o700 });
  await chmod(scoresDir, 0o777);
  const runFile = programRunFile(opts.run);
  if (runFile !== null) {
    await writeFile(join(scoresDir, RUN_FILE), runFile, { flag: 'wx', mode: 0o600 });
    await sealStaged(join(scoresDir, RUN_FILE));
  }
  const runtime = opts.setup.harness.scorer.runtime;
  const cassetteDir = opts.setup.cassetteDir;
  const proc = opts.sandbox.spawn({
    runtime,
    codeDir: paths.scorerDir,
    script: paths.scorerScript,
    mounts: [
      { host: outputDir, at: '/output', readOnly: true },
      { host: paths.referenceDir, at: '/reference', readOnly: true },
      ...(cassetteDir === undefined ? [] : [{ host: cassetteDir, at: CASSETTE_MOUNT, readOnly: true }]),
      { host: scoresDir, at: '/scores', readOnly: false, returns: SCORES_RETURNS },
    ],
    limits: opts.limits,
    label: opts.label ?? 'scorer',
  });
  const sup = new Supervisor(proc, {
    budgetMs: opts.limits.wall_budget_sec * 1000,
    maxStderrBytes: MAX_STDERR_BYTES,
    stdout: { mode: 'capture', maxBytes: MAX_PROGRAM_STDOUT_BYTES },
  });
  sup.closeStdin();
  try {
    const exit = await sup.waitExit(Math.max(0, sup.remainingMs()));
    if (exit === 'grace') throw new ScorerError('the scorer ran out of wall budget');
    if (opts.sandbox.isDriverFailure(exit)) throw driverFailure(proc, `the sandbox failed running the scorer (${describeExit(exit)}): ${stderrTail(sup.stderr())}`);
    if (exit.code !== 0) throw new ScorerError(`the scorer exited with ${describeExit(exit)}: ${stderrTail(sup.stderr())}`);
  } catch (err) {
    await sup.kill();
    if (err instanceof Stopped) throw new ScorerError(`the scorer was stopped: ${describeStop(err.reason)}: ${stderrTail(sup.stderr())}`);
    throw err;
  }
  const scores = await readScores(scoresDir, scoredColumns(opts.setup.leaderboard));
  return { scores, checks: await readChecks(scoresDir) };
}
