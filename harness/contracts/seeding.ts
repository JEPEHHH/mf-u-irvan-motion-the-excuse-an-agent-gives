// The seeding pipeline's enums: what make.fun's own contest seeding (server/seeding) records about an
// idea, the template that drew it, the gates it went through, the adversaries it was measured against
// and the runs that measured it. Each list is the source of a database enum (server/db/schema) and of
// the zod enum beside it, in the order shown.
//
//   an idea        drafted (a template drew params at a rung) → compiled (its pack built) → gated (every
//                  gate passed) or rejected (one failed) → picked → exported (as a sponsor proposal) →
//                  launched (a competition opened on it) → retired
//   a template     a family of contests: its format (beat an open-source baseline, or crack a planted
//                  secret), what it compiles to (a code pack, or a bars dataset), how an entry scores
//                  (correct or not, or relative to the baseline's quality), its niches
//   the gates      each check an idea's compile is held to, in the order they run
//   the roster     the adversaries a pack is measured against: the open-source baseline, a champion of an
//                  earlier rung, the trivial battery, a one-shot model answer, and the house witness
//
// zod and data only: no Node APIs and no relative import, so the browser bundle, the server and the CLI
// load it alike (contracts/code-kinds.ts says why).

import { z } from 'zod';

/** An idea's life, in order. */
export const SEEDING_IDEA_STATUSES = ['drafted', 'compiled', 'gated', 'rejected', 'picked', 'exported', 'launched', 'retired'] as const;
export type SeedingIdeaStatusT = (typeof SEEDING_IDEA_STATUSES)[number];
export const SeedingIdeaStatus = z.enum(SEEDING_IDEA_STATUSES);

/** beat_baseline: beat an open-source tool's answers; crack: recover what a case plants. */
export const SEEDING_FORMATS = ['beat_baseline', 'crack'] as const;
export type SeedingFormatT = (typeof SEEDING_FORMATS)[number];
export const SeedingFormat = z.enum(SEEDING_FORMATS);

/** What a template compiles to: a code bounty's test pack, or a bars dataset. */
export const SEEDING_TARGETS = ['pack', 'bars'] as const;
export type SeedingTargetT = (typeof SEEDING_TARGETS)[number];
export const SeedingTarget = z.enum(SEEDING_TARGETS);

/** correctness: a case passes or fails; relative: a case passes when the answer's quality beats the case's bar. */
export const SEEDING_SCORING = ['correctness', 'relative'] as const;
export type SeedingScoringT = (typeof SEEDING_SCORING)[number];
export const SeedingScoring = z.enum(SEEDING_SCORING);

/** The code kinds a seeded contest takes (contracts/code-kinds.ts CODE_KIND_IDS): code-first only for a crack compared exactly. */
export const SEEDING_KINDS = ['code-score', 'code-first'] as const;
export type SeedingKindT = (typeof SEEDING_KINDS)[number];
export const SeedingKind = z.enum(SEEDING_KINDS);

/** The gates an idea's compile is held to, in the order they run. */
export const SEEDING_GATES = [
  'params',
  'compile',
  'pack_check',
  'bundle_validate',
  'headroom',
  'witness',
  'triviality',
  'one_shot',
  'novelty',
  'single_use',
  'baseline_dev_run',
] as const;
export type SeedingGateT = (typeof SEEDING_GATES)[number];
export const SeedingGate = z.enum(SEEDING_GATES);

/** The roles a measured adversary plays. */
export const SEEDING_ADVERSARY_ROLES = ['oss', 'champion', 'trivial', 'one_shot', 'witness'] as const;
export type SeedingAdversaryRoleT = (typeof SEEDING_ADVERSARY_ROLES)[number];
export const SeedingAdversaryRole = z.enum(SEEDING_ADVERSARY_ROLES);

/** How an open-source baseline runs: its stdlib-only code vendored as an entry, or its recorded outputs replayed. */
export const SEEDING_BASELINE_MODES = ['vendored', 'replay'] as const;
export type SeedingBaselineModeT = (typeof SEEDING_BASELINE_MODES)[number];
export const SeedingBaselineMode = z.enum(SEEDING_BASELINE_MODES);

/** A seeding run's (a compile's, a baseline replay's) state. */
export const SEEDING_RUN_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type SeedingRunStatusT = (typeof SEEDING_RUN_STATUSES)[number];
export const SeedingRunStatus = z.enum(SEEDING_RUN_STATUSES);

/** A gap's state (what the seeding found it cannot cover yet): open, then accepted or dismissed. */
export const SEEDING_GAP_STATUSES = ['open', 'accepted', 'dismissed'] as const;
export type SeedingGapStatusT = (typeof SEEDING_GAP_STATUSES)[number];
export const SeedingGapStatus = z.enum(SEEDING_GAP_STATUSES);

/** The niches a template serves, as slugs. */
export const SEEDING_NICHES = ['trading-crypto', 'trading-stocks', 'automation-captcha', 'automation-macro', 'roblox-dev', 'security-crypto'] as const;
export type SeedingNicheT = (typeof SEEDING_NICHES)[number];
export const SeedingNiche = z.enum(SEEDING_NICHES);
