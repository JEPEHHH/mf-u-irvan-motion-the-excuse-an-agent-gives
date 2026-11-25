// The patch/v1 harness's records: a bounty on an open upstream issue, graded by applying an entry's
// unified diff (its patch.diff) to the repo's sealed tree at the bounty's commit and running the
// repo's own tests over it in a pinned image. The dev phase grades the tests the kit publishes; the
// final phase grades hidden ones, the fix's own tests among them, so an entry is ranked on whether it
// resolves the issue rather than on whether it satisfies the tests it could read.
//
//   harness          PatchHarness, the competition bundle's block:
//     repo             PatchRepo: the upstream (https://github.com/<owner>/<repo>, the canonical form
//                      server/repos/source.ts githubSource writes, by its rules), the commit the bounty
//                      is cut at, and the sha256 of that commit's sealed tree: the snapshot index
//                      digest (server/repos/index-tar.ts snapshotSha256) of `git archive base_commit`
//     image            PatchImage: the repo's test image, pinned by digest (repository@sha256:…,
//                      patchImageRef), never by tag
//     test             PatchTest: the argv that runs the tests in /work, and the JUnit XML report it
//                      writes at report_path, repo-relative under /work
//     protected_paths  1 to 64 globs (PatchGlob) a patch may touch nothing under: the tests, the test
//                      config, the report (matchesProtected)
//     pack             PatchPack: the digests of the two phase trees, the oracle patch and the witness
//                      record, as the pack builder sealed them
//     work_mb          the size of the tmpfs the tests run in (/work)
//     max_patch_bytes  the largest patch.diff intake takes; max_entry_bytes the largest entry tree,
//                      at least max_patch_bytes (the tree carries the patch)
//     gate             resolved: an entry passes exactly when its patch resolves (below)
//   phase tree       dev, then final (PATCH_PHASES), each a sealed tree: overlay/** (test files, by
//                    their repo-relative paths, copied over /work after the patch, every one
//                    protected), lists.json (PatchLists) and, in the final tree only, salt (whose
//                    bytes make the final tree's digest unguessable from the dev tree's).
//                    patchPhaseTreeIssues is the layout. The dev tree is published in the kit; the
//                    final tree, the oracle and the witness record never are
//   lists            agent-fun/patch-lists/v1 (PatchLists): the JUnit test ids (`<classname>::<name>`)
//                    a phase grades. fail_to_pass fail on the base tree and must pass; pass_to_pass
//                    pass on it and must still pass; the canaries are the house's tamper check,
//                    must_fail a test that must still fail and must_pass one that must still pass.
//                    The four lists are disjoint. Between the two phases (patchListsIssues) the final
//                    tree grades at least one fail-to-pass test the dev tree does not name, and holds
//                    at least one must_fail canary, none of its canaries named by the dev tree
//   refusal          PATCH_REFUSALS: why a patch.diff was not applied, each scoring 0
//   performance      PatchPerformance (contracts/score.ts Performance's patch/v1 branch): whether the
//                    patch applied (or why it was refused), whether the canaries or the exit check
//                    caught tampering, the passed and listed counts of the fail-to-pass and
//                    pass-to-pass tests, the scores a leaderboard column reads (PATCH_SCORE_COLUMNS),
//                    and passed. Counts only, never a test id: the final lists are sealed
//   witness record   agent-fun/patch-witness/v1 (PatchWitnessRecord): the house agent's run on the
//                    dev tree that found the oracle, at least PATCH_WITNESS_MIN_TRIALS trials, each paid
//                    by a masq key of its own: its spend, the digests of its patch and transcript,
//                    whether its patch resolved dev, and why it stopped
//
// Resolved (patchResolved, the gate): the patch applied, the run was not tampered with (every
// must_fail canary failed, every must_pass canary passed, and the tests' exit status agreed with
// their report: grader/patch/score.ts patchExitCheck), and every fail-to-pass and every
// pass-to-pass test passed. A dev tree may list no fail-to-pass test, so resolving dev can be keeping
// the pass-to-pass tests passing; the final tree always lists one.
//
// A repo-relative path (PatchPath) follows server/repos/index-tar.ts validateSnapshotPath, the same
// rules: non-empty, relative, no NUL and no lone surrogate, at most 4096 UTF-8 bytes, no empty, `.`,
// `..` or `.git` segment, each segment at most 255 UTF-8 bytes. A glob (PatchGlob) is such a path
// whose segments may hold `*` (any run of characters within one segment, none included) or be `**`
// (any run of whole segments, none included); every other character is literal, the ones other glob
// dialects read as syntax (? [ ] { } \ and a leading !) refused so no glob protects other than it
// reads. Matching is case-sensitive, and `*` and `**` match names starting with a dot too: a glob
// protects more rather than less.
//
// The identities a record must satisfy are refinements that run only on a value whose shape already
// parsed (whenValid). An issue names a test id by its list and index, never by its text, so a sealed
// list's issue leaks none. zod only, no Node APIs: browser-safe, as every contract.

import { z } from 'zod';
import { GitSha, IsoDateTime, Sha256Hex, Slug, U64 } from './primitives.ts';

export const PATCH_HARNESS_KIND = 'patch/v1';

type Issue = (path: (string | number)[], message: string) => void;

const issuer =
  (ctx: { addIssue: (i: { code: 'custom'; path: (string | number)[]; message: string }) => void }): Issue =>
  (path, message) =>
    ctx.addIssue({ code: 'custom', path, message });

/** Run a refinement only on a value whose shape already parsed. */
const whenValid = { when: (payload: { issues: readonly unknown[] }): boolean => payload.issues.length === 0 };

/** Whether a list holds no value twice; the first repeat's index, or -1. */
function firstRepeat<T>(xs: readonly T[], key: (x: T) => string = String): number {
  const seen = new Set<string>();
  for (let i = 0; i < xs.length; i++) {
    const k = key(xs[i]!);
    if (seen.has(k)) return i;
    seen.add(k);
  }
  return -1;
}

// ---------------------------------------------------------------- paths and globs

/** server/repos/index-tar.ts MAX_PATH_BYTES and MAX_SEGMENT_BYTES. */
export const PATCH_PATH_MAX_BYTES = 4096;
export const PATCH_SEGMENT_MAX_BYTES = 255;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

/** A UTF-16 surrogate with no partner: a string holding one has no UTF-8 form. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Why `p` is not a repo-relative path a sealed tree can hold (validateSnapshotPath's rules, the
 * header), or null when it is.
 */
export function patchPathIssue(p: string): string | null {
  if (p === '') return 'is empty';
  if (p.startsWith('/')) return 'is absolute';
  if (p.includes('\0')) return 'holds a NUL';
  if (LONE_SURROGATE.test(p)) return 'holds a lone surrogate (no UTF-8 form)';
  if (utf8Bytes(p) > PATCH_PATH_MAX_BYTES) return `is longer than ${PATCH_PATH_MAX_BYTES} UTF-8 bytes`;
  for (const seg of p.split('/')) {
    if (seg === '..') return 'holds a `..` segment';
    if (seg === '' || seg === '.') return 'holds an empty or `.` segment';
    if (seg.toLowerCase() === '.git') return 'holds a `.git` segment';
    if (utf8Bytes(seg) > PATCH_SEGMENT_MAX_BYTES) return `holds a segment longer than ${PATCH_SEGMENT_MAX_BYTES} UTF-8 bytes`;
  }
  return null;
}

/** A repo-relative POSIX path (patchPathIssue). */
export const PatchPath = z.string().superRefine((p, ctx) => {
  const why = patchPathIssue(p);
  if (why !== null) ctx.addIssue({ code: 'custom', message: `a repo-relative path: this one ${why}` });
});

/** What other glob dialects read as syntax: refused anywhere in a glob, as a leading `!` is. */
const GLOB_SYNTAX = /[?[\]{}\\]/;

/** Why `g` is not a protected-path glob (the header's grammar), or null when it is. */
export function patchGlobIssue(g: string): string | null {
  if (g.startsWith('!')) return 'starts with `!`: a protected path is never negated';
  if (GLOB_SYNTAX.test(g)) return 'holds one of ? [ ] { } \\: the grammar is literal characters, `*` and `**`';
  const why = patchPathIssue(g);
  if (why !== null) return why;
  if (g.split('/').some((seg) => seg !== '**' && seg.includes('**'))) return 'holds `**` inside a segment: `**` stands only as a whole segment';
  return null;
}

/** A protected-path glob (patchGlobIssue). */
export const PatchGlob = z.string().superRefine((g, ctx) => {
  const why = patchGlobIssue(g);
  if (why !== null) ctx.addIssue({ code: 'custom', message: `a protected-path glob: this one ${why}` });
});

/** Whether one path segment matches one glob segment, `*` standing for any run of characters. */
function segmentMatches(glob: string, seg: string): boolean {
  let g = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < seg.length) {
    if (g < glob.length && glob[g] === '*') {
      star = g++;
      mark = s;
    } else if (g < glob.length && glob[g] === seg[s]) {
      g++;
      s++;
    } else if (star !== -1) {
      g = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

/** Whether a path's segments match a glob's, `**` standing for any run of whole segments. */
function globMatches(glob: readonly string[], path: readonly string[]): boolean {
  // memo[i * (path.length + 1) + j]: whether glob[i..] matches path[j..] (undefined: not yet known).
  const memo: (boolean | undefined)[] = [];
  const match = (i: number, j: number): boolean => {
    if (i === glob.length) return j === path.length;
    const at = i * (path.length + 1) + j;
    const known = memo[at];
    if (known !== undefined) return known;
    const seg = glob[i]!;
    const hit =
      seg === '**'
        ? match(i + 1, j) || (j < path.length && match(i, j + 1))
        : j < path.length && segmentMatches(seg, path[j]!) && match(i + 1, j + 1);
    memo[at] = hit;
    return hit;
  };
  return match(0, 0);
}

/** Whether a repo-relative path matches any of the protected-path globs. */
export function matchesProtected(path: string, globs: readonly string[]): boolean {
  const segs = path.split('/');
  return globs.some((g) => globMatches(g.split('/'), segs));
}

// ---------------------------------------------------------------- repo and image

/** The upstream's owner and name: server/repos/source.ts GITHUB_OWNER_RE and GITHUB_REPO_RE, the same rules. */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Whether `url` is https://github.com/<owner>/<repo> exactly: no `.git`, no trailing `/`, nothing after. */
export function isPatchRepoUrl(url: string): boolean {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
  if (m === null) return false;
  const owner = m[1]!;
  const name = m[2]!;
  return GITHUB_OWNER.test(owner) && GITHUB_NAME.test(name) && name !== '.' && name !== '..' && !name.toLowerCase().endsWith('.git');
}

export const PatchRepo = z.strictObject({
  url: z.string().refine(isPatchRepoUrl, 'expected https://github.com/<owner>/<repo>: no .git, no trailing /'),
  /** The commit the bounty is cut at. */
  base_commit: GitSha,
  /** The snapshot index digest (index-tar.ts snapshotSha256) of `git archive base_commit`. */
  base_tree_sha256: Sha256Hex,
});

/** Docker's NameTotalLengthMax. */
export const PATCH_IMAGE_REPOSITORY_MAX = 255;

/** A registry host: dot-joined labels of letters, digits and inner hyphens, then an optional port. */
const IMAGE_REGISTRY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?$/;
/** A path component, Docker's: lowercase letters and digits, joined by one `.`, one or two `_`, or a run of `-`. */
const IMAGE_COMPONENT = /^[a-z0-9]+(?:(?:\.|_{1,2}|-+)[a-z0-9]+)*$/;

/**
 * Whether `r` is an image repository with its registry named (`registry/path`): the registry a
 * host Docker reads as one (holding a `.` or a `:` port, or `localhost`), then one or more path
 * components. No tag and no `@`: the digest pins the image.
 */
export function isPatchImageRepository(r: string): boolean {
  if (r.length > PATCH_IMAGE_REPOSITORY_MAX) return false;
  const [registry, ...path] = r.split('/');
  if (registry === undefined || path.length === 0) return false;
  if (!(registry.includes('.') || registry.includes(':') || registry === 'localhost')) return false;
  return IMAGE_REGISTRY.test(registry) && path.every((c) => IMAGE_COMPONENT.test(c));
}

export const PatchImage = z.strictObject({
  repository: z
    .string()
    .refine(isPatchImageRepository, 'expected an image repository with its registry (registry/path): lowercase path components, no tag, no @'),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256:<64 lowercase hex>'),
});

/** The reference a container runtime pulls and runs: repository@digest. */
export function patchImageRef(image: z.infer<typeof PatchImage>): string {
  return `${image.repository}@${image.digest}`;
}

// ---------------------------------------------------------------- test

export const PATCH_TEST_MAX_ARGS = 64;
export const PATCH_TEST_ARG_MAX = 4096;

export const PatchTest = z.strictObject({
  /** Run in /work, as is: no shell unless the argv names one. */
  argv: z
    .array(
      z
        .string()
        .min(1)
        .max(PATCH_TEST_ARG_MAX)
        .refine((a) => !a.includes('\0'), 'an argument holds no NUL'),
    )
    .min(1)
    .max(PATCH_TEST_MAX_ARGS),
  report: z.literal('junit-xml'),
  /** Where under /work the run writes its report: a protected path (PatchHarness), so no patch plants one. */
  report_path: PatchPath,
});

// ---------------------------------------------------------------- pack

/** A phase tree, by its snapshot index digest. */
export const PatchPhaseTree = z.strictObject({ tree_sha256: Sha256Hex });

export const PatchPack = z
  .strictObject({
    dev: PatchPhaseTree,
    final: PatchPhaseTree,
    /**
     * sha256 of the oracle patch, also the house reserve entry: the witness's lowest-numbered trial
     * resolving final, or the engineer's witness/engineer.diff when none does (the witness record's
     * oracle_source says which).
     */
    oracle_sha256: Sha256Hex,
    /** sha256 of the witness record (PatchWitnessRecord), as the pack build sealed it. */
    witness_sha256: Sha256Hex,
  })
  .superRefine((p, ctx) => {
    const issue = issuer(ctx);
    const sealed: [path: string[], what: string, digest: string][] = [
      [['dev', 'tree_sha256'], 'the dev tree', p.dev.tree_sha256],
      [['final', 'tree_sha256'], 'the final tree', p.final.tree_sha256],
      [['oracle_sha256'], 'the oracle', p.oracle_sha256],
      [['witness_sha256'], 'the witness record', p.witness_sha256],
    ];
    sealed.forEach(([path, what, digest], i) => {
      const earlier = sealed.slice(0, i).find(([, , d]) => d === digest);
      if (earlier === undefined) return;
      issue(
        path,
        i === 1 ? 'the final tree is the dev tree: the final phase grades hidden tests the dev tree does not hold' : `${what} has ${earlier[1]}'s digest: the pack seals four different things`,
      );
    });
  }, whenValid);

// ---------------------------------------------------------------- harness

export const PATCH_MAX_PROTECTED_PATHS = 64;
export const PATCH_WORK_MB_MIN = 64;
export const PATCH_WORK_MB_MAX = 16384;
/** 1 MiB. */
export const PATCH_MAX_PATCH_BYTES = 1_048_576;
export const PATCH_GATE = 'resolved';

export const PatchHarness = z
  .strictObject({
    kind: z.literal(PATCH_HARNESS_KIND),
    repo: PatchRepo,
    image: PatchImage,
    test: PatchTest,
    protected_paths: z.array(PatchGlob).min(1).max(PATCH_MAX_PROTECTED_PATHS),
    pack: PatchPack,
    work_mb: z.int().min(PATCH_WORK_MB_MIN).max(PATCH_WORK_MB_MAX),
    max_patch_bytes: z.int().min(1).max(PATCH_MAX_PATCH_BYTES),
    max_entry_bytes: z.int().min(1),
    gate: z.literal(PATCH_GATE),
  })
  .superRefine((h, ctx) => {
    const issue = issuer(ctx);
    const dup = firstRepeat(h.protected_paths);
    if (dup !== -1) issue(['protected_paths', dup], `${h.protected_paths[dup]} is listed twice`);
    if (!matchesProtected(h.test.report_path, h.protected_paths)) {
      issue(['test', 'report_path'], 'no protected path covers the report: a patch could plant the report its tests are read from');
    }
    if (h.max_entry_bytes < h.max_patch_bytes) {
      issue(['max_entry_bytes'], `the entry tree carries its patch.diff: max_entry_bytes ${h.max_entry_bytes} is under max_patch_bytes ${h.max_patch_bytes}`);
    }
  }, whenValid);

// ---------------------------------------------------------------- phase trees and lists

export const PATCH_PHASES = ['dev', 'final'] as const;
export const PatchPhase = z.enum(PATCH_PHASES);

/** A phase tree's layout: its overlay directory, its lists and (final only) its salt. */
export const PATCH_OVERLAY_DIR = 'overlay';
export const PATCH_LISTS_FILE = 'lists.json';
export const PATCH_SALT_FILE = 'salt';

/**
 * What keeps a phase tree's paths from being its phase's layout: lists.json, salt exactly in the final
 * tree, and every other path under overlay/, a repo-relative path a protected-path glob covers (the
 * overlay is the tests; no patch may touch them).
 */
export function patchPhaseTreeIssues(phase: PatchPhaseT, paths: readonly string[], protectedPaths: readonly string[]): string[] {
  const issues: string[] = [];
  const held = new Set(paths);
  if (!held.has(PATCH_LISTS_FILE)) issues.push(`${phase}: the tree holds no ${PATCH_LISTS_FILE}`);
  if (phase === 'final' && !held.has(PATCH_SALT_FILE)) issues.push(`final: the tree holds no ${PATCH_SALT_FILE}`);
  const prefix = `${PATCH_OVERLAY_DIR}/`;
  const layout = phase === 'final' ? `${PATCH_LISTS_FILE}, ${PATCH_SALT_FILE} or under ${prefix}` : `${PATCH_LISTS_FILE} or under ${prefix}`;
  for (const p of held) {
    if (p === PATCH_LISTS_FILE || (phase === 'final' && p === PATCH_SALT_FILE)) continue;
    if (!p.startsWith(prefix)) {
      issues.push(`${phase}: ${p} is not ${layout}`);
      continue;
    }
    const rel = p.slice(prefix.length);
    const why = patchPathIssue(rel);
    if (why !== null) issues.push(`${phase}: ${p}'s repo-relative path ${why}`);
    else if (!matchesProtected(rel, protectedPaths)) issues.push(`${phase}: ${p} is an overlay file no protected path covers: a patch could edit the test it is graded by`);
  }
  return issues;
}

export const PATCH_LISTS_SCHEMA = 'agent-fun/patch-lists/v1';
export const PATCH_TEST_ID_MAX = 512;
export const PATCH_LIST_MAX_IDS = 10_000;

/** A JUnit test id (`<classname>::<name>`, just `<name>` with no classname), as the report parser reads it. */
export const PatchTestId = z
  .string()
  .min(1)
  .max(PATCH_TEST_ID_MAX)
  .refine((id) => !LONE_SURROGATE.test(id), 'a test id has a UTF-8 form: no lone surrogate');

const PatchIdList = z.array(PatchTestId).max(PATCH_LIST_MAX_IDS);

const PatchListsShape = z.strictObject({
  schema: z.literal(PATCH_LISTS_SCHEMA),
  fail_to_pass: PatchIdList,
  pass_to_pass: PatchIdList,
  canaries: z.strictObject({ must_fail: PatchIdList, must_pass: PatchIdList }),
});

/** The four lists, in the order their issues name them. */
function namedLists(l: z.infer<typeof PatchListsShape>): { path: string[]; ids: readonly string[] }[] {
  return [
    { path: ['fail_to_pass'], ids: l.fail_to_pass },
    { path: ['pass_to_pass'], ids: l.pass_to_pass },
    { path: ['canaries', 'must_fail'], ids: l.canaries.must_fail },
    { path: ['canaries', 'must_pass'], ids: l.canaries.must_pass },
  ];
}

export const PatchLists = PatchListsShape.superRefine((l, ctx) => {
  const issue = issuer(ctx);
  // Each id's first place: a repeat names it there, by list and index (never the id itself).
  const first = new Map<string, string>();
  for (const { path, ids } of namedLists(l)) {
    ids.forEach((id, i) => {
      const at = first.get(id);
      if (at === undefined) first.set(id, `${path.join('.')}.${i}`);
      else issue([...path, i], at.startsWith(`${path.join('.')}.`) ? `repeats ${at}` : `is ${at} too: the four lists are disjoint`);
    });
  }
}, whenValid);

/**
 * What keeps a dev and a final lists.json from being one pack's: the final tree grades at least one
 * fail-to-pass test, one of them hidden (not in dev's fail_to_pass), and holds at least one must_fail
 * canary (a patch that reports every test passing fails it), none of its canaries in any of dev's
 * lists (a canary the kit publishes is none). Dev's fail_to_pass may be empty.
 */
export function patchListsIssues(dev: PatchListsT, final: PatchListsT): string[] {
  const issues: string[] = [];
  if (final.fail_to_pass.length === 0) {
    issues.push('final.fail_to_pass: the final phase grades at least one fail-to-pass test');
  } else {
    const devF2p = new Set(dev.fail_to_pass);
    if (final.fail_to_pass.every((id) => devF2p.has(id))) {
      issues.push("final.fail_to_pass: every id is in dev's fail_to_pass: the final phase grades at least one hidden fail-to-pass test");
    }
  }
  if (final.canaries.must_fail.length === 0) {
    issues.push('final.canaries.must_fail: the final phase holds at least one must_fail canary: a patch that reports every test passing fails it');
  }
  const published = new Set(namedLists(dev).flatMap((l) => l.ids));
  for (const kind of ['must_fail', 'must_pass'] as const) {
    final.canaries[kind].forEach((id, i) => {
      if (published.has(id)) issues.push(`final.canaries.${kind}.${i}: dev's lists name it: a canary the kit publishes is none`);
    });
  }
  return issues;
}

// ---------------------------------------------------------------- refusals and performance

/** Why a patch.diff was not applied (grader/patch/diff.ts parsePatch, then the apply). */
export const PATCH_REFUSALS = [
  'missing',
  'empty',
  'too_large',
  'not_utf8',
  'malformed',
  'binary',
  'mode',
  'unsafe_path',
  'protected_path',
  'apply_failed',
] as const;
export const PatchRefusal = z.enum(PATCH_REFUSALS);

/** The columns a patch/v1 leaderboard may name: each a key of PatchPerformance.scores. */
export const PATCH_SCORE_COLUMNS = ['resolved', 'f2p_passed', 'f2p_total', 'p2p_passed', 'p2p_total'] as const;

const PatchTestCount = z.int().min(0).max(PATCH_LIST_MAX_IDS);

/** A list's tests that passed, of those it lists. */
export const PatchTally = z.strictObject({ passed: PatchTestCount, total: PatchTestCount });

/** What a leaderboard column reads at performance.scores.<key> (PATCH_SCORE_COLUMNS). */
export const PatchScores = z.strictObject({
  /** THE GATE: 1 when the patch resolves (patchResolved), else 0. */
  resolved: z.union([z.literal(0), z.literal(1)]),
  f2p_passed: PatchTestCount,
  f2p_total: PatchTestCount,
  p2p_passed: PatchTestCount,
  p2p_total: PatchTestCount,
});

/** Whether a run resolves: applied, untampered, and every fail-to-pass and pass-to-pass test passed. */
export function patchResolved(r: { applied: boolean; tampered: boolean; f2p: PatchTallyT; p2p: PatchTallyT }): boolean {
  return r.applied && !r.tampered && r.f2p.passed === r.f2p.total && r.p2p.passed === r.p2p.total;
}

export const PatchPerformance = z
  .strictObject({
    kind: z.literal(PATCH_HARNESS_KIND),
    /** The patch applied: exactly when it was not refused. */
    applied: z.boolean(),
    refused: PatchRefusal.nullable(),
    /**
     * A must_fail canary passed or a must_pass canary did not, or the tests' exit status contradicted
     * their report (a signal ended them, exit 0 beside a failure, a non-zero exit beside none).
     */
    tampered: z.boolean(),
    f2p: PatchTally,
    p2p: PatchTally,
    scores: PatchScores,
    /** The gate (resolved). */
    passed: z.boolean(),
  })
  .superRefine((p, ctx) => {
    const issue = issuer(ctx);
    for (const key of ['f2p', 'p2p'] as const) {
      if (p[key].passed > p[key].total) issue([key, 'passed'], `${p[key].passed} passed of ${p[key].total} listed`);
    }
    if (p.applied !== (p.refused === null)) {
      issue(['refused'], p.applied ? 'an applied patch was not refused: refused is null' : 'a patch that did not apply was refused: refused names why');
    }
    if (!p.applied) {
      if (p.tampered) issue(['tampered'], 'a patch that did not apply ran no tests: nothing was tampered with');
      for (const key of ['f2p', 'p2p'] as const) {
        if (p[key].passed !== 0) issue([key, 'passed'], 'a patch that did not apply ran no tests: none passed');
      }
    }
    const s = p.scores;
    if (s.f2p_passed !== p.f2p.passed) issue(['scores', 'f2p_passed'], `f2p.passed is ${p.f2p.passed}, not ${s.f2p_passed}`);
    if (s.f2p_total !== p.f2p.total) issue(['scores', 'f2p_total'], `f2p.total is ${p.f2p.total}, not ${s.f2p_total}`);
    if (s.p2p_passed !== p.p2p.passed) issue(['scores', 'p2p_passed'], `p2p.passed is ${p.p2p.passed}, not ${s.p2p_passed}`);
    if (s.p2p_total !== p.p2p.total) issue(['scores', 'p2p_total'], `p2p.total is ${p.p2p.total}, not ${s.p2p_total}`);
    const resolved = patchResolved(p) ? 1 : 0;
    if (s.resolved !== resolved) issue(['scores', 'resolved'], resolved === 1 ? 'the patch applied untampered and every listed test passed: resolved is 1' : 'the patch did not resolve: resolved is 0');
    if (p.passed !== (resolved === 1)) issue(['passed'], `the gate is resolved: passed is ${resolved === 1}`);
  }, whenValid);

/**
 * The performance of a run: refused (with its reason, nothing run: both lists' passed 0) or applied,
 * with what the canaries and the tests read. Throws (zod) on a run no performance describes.
 */
export function patchPerformanceOf(r: { refused: PatchRefusalT | null; tampered: boolean; f2p: PatchTallyT; p2p: PatchTallyT }): PatchPerformanceT {
  const applied = r.refused === null;
  const resolved = patchResolved({ applied, ...r });
  return PatchPerformance.parse({
    kind: PATCH_HARNESS_KIND,
    applied,
    refused: r.refused,
    tampered: r.tampered,
    f2p: r.f2p,
    p2p: r.p2p,
    scores: { resolved: resolved ? 1 : 0, f2p_passed: r.f2p.passed, f2p_total: r.f2p.total, p2p_passed: r.p2p.passed, p2p_total: r.p2p.total },
    passed: resolved,
  });
}

// ---------------------------------------------------------------- witness

export const PATCH_WITNESS_SCHEMA = 'agent-fun/patch-witness/v1';
/** The fewest trials a witness runs: deliberately not PRIZE_GATE_MIN_TRIALS (5), a rehearsal's. */
export const PATCH_WITNESS_MIN_TRIALS = 3;
export const PATCH_WITNESS_MAX_TRIALS = 16;

/**
 * Whose patch is the pack's oracle (and its house reserve entry): a witness trial's, or, when none of
 * them resolves the final tree, the engineer's hand-written witness/engineer.diff.
 */
export const PATCH_ORACLE_SOURCES = ['witness', 'engineer'] as const;
export const PatchOracleSource = z.enum(PATCH_ORACLE_SOURCES);

/**
 * Why the house agent's trial stopped: it submitted; it ran out of steps, tokens or wall time; the
 * model ended its turn without a tool call; or a model call failed.
 */
export const PATCH_AGENT_STOPS = ['submitted', 'max_steps', 'max_tokens', 'wall_time', 'ended', 'model_error'] as const;
export const PatchAgentStop = z.enum(PATCH_AGENT_STOPS);

/**
 * contracts/competition.ts ModelId, the same rule. Not imported: competition.ts imports this module
 * once its Harness union holds PatchHarness, and the cycle would read ModelId before it is set.
 */
const PatchModelId = z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/, 'expected an exact model id: letters, digits and . _ : / -, no wildcards');
/** masq's key id (grader/gateway/masq.ts KeyId, the same rule). */
const MasqKeyId = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, "expected masq's key id: letters, digits and _ . -, 1 to 128");

export const PatchWitnessTrial = z
  .strictObject({
    /** 1, 2, …: the trial's place in the run (witness/trial-<n>.diff). */
    n: z.int().min(1).max(PATCH_WITNESS_MAX_TRIALS),
    /** The key that paid for it, never the secret. */
    masq_key_id: MasqKeyId,
    spend_micro_usd: U64,
    /** sha256 of its patch; null when it ended with none. */
    patch_sha256: Sha256Hex.nullable(),
    transcript_sha256: Sha256Hex,
    /** Its patch resolved the dev tree. */
    dev_resolved: z.boolean(),
    stop: PatchAgentStop,
  })
  .refine((t) => !t.dev_resolved || t.patch_sha256 !== null, {
    message: 'a trial that resolved dev did so with a patch: patch_sha256 names it',
    path: ['patch_sha256'],
    ...whenValid,
  });

export const PatchWitnessRecord = z
  .strictObject({
    schema: z.literal(PATCH_WITNESS_SCHEMA),
    competition: Slug,
    base_tree_sha256: Sha256Hex,
    image: PatchImage,
    dev_tree_sha256: Sha256Hex,
    model: PatchModelId,
    trials: z.array(PatchWitnessTrial).min(PATCH_WITNESS_MIN_TRIALS).max(PATCH_WITNESS_MAX_TRIALS),
    ran_at: IsoDateTime,
    /**
     * Whose patch the pack's oracle is; absent means a trial's, so a witness's record keeps its digest.
     * The witness writes none: the pack build sets 'engineer' on the record it seals when no trial
     * resolves final and witness/engineer.diff is the oracle.
     */
    oracle_source: PatchOracleSource.optional(),
  })
  .superRefine((w, ctx) => {
    const issue = issuer(ctx);
    w.trials.forEach((t, i) => {
      if (t.n !== i + 1) issue(['trials', i, 'n'], `trials are numbered 1, 2, … in order: this one is ${i + 1}, not ${t.n}`);
    });
    const dup = firstRepeat(w.trials, (t) => t.masq_key_id);
    if (dup !== -1) issue(['trials', dup, 'masq_key_id'], 'each trial is paid by a masq key of its own: this key paid an earlier trial');
  }, whenValid);

export type PatchRepoT = z.infer<typeof PatchRepo>;
export type PatchImageT = z.infer<typeof PatchImage>;
export type PatchTestT = z.infer<typeof PatchTest>;
export type PatchPhaseTreeT = z.infer<typeof PatchPhaseTree>;
export type PatchPackT = z.infer<typeof PatchPack>;
export type PatchHarnessT = z.infer<typeof PatchHarness>;
export type PatchPhaseT = (typeof PATCH_PHASES)[number];
export type PatchListsT = z.infer<typeof PatchLists>;
export type PatchRefusalT = (typeof PATCH_REFUSALS)[number];
export type PatchScoreColumnT = (typeof PATCH_SCORE_COLUMNS)[number];
export type PatchTallyT = z.infer<typeof PatchTally>;
export type PatchScoresT = z.infer<typeof PatchScores>;
export type PatchPerformanceT = z.infer<typeof PatchPerformance>;
export type PatchAgentStopT = (typeof PATCH_AGENT_STOPS)[number];
export type PatchWitnessTrialT = z.infer<typeof PatchWitnessTrial>;
export type PatchWitnessRecordT = z.infer<typeof PatchWitnessRecord>;
export type PatchOracleSourceT = (typeof PATCH_ORACLE_SOURCES)[number];
