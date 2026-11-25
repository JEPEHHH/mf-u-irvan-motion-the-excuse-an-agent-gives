// A sponsor's proposal: the part of a competition bundle (./competition.ts) a sponsor writes when
// proposing a competition paid from their own wallet. server/proposals/compose.ts composes it with
// the house's values into a CompetitionBundleT, deterministically, and that bundle then passes the
// one validator every competition passes (server/competitions/load.ts validateBundle and
// bundleIssues). server/proposals/checks.ts runs the checks.
//
// Templates only (owner decision 2, as the owner was told): the harness is a choice from the
// house's scoring templates (server/proposals/templates.ts: pumpfun-replay, solana-bars-1h,
// solana-clmm-lp), a dataset window the template accepts, a metric it ranks by and its bounded knobs; or social-post
// (SocialPostChoice: posts on X, TikTok or YouTube ranked on their public counts, the sponsor writing the platform, the
// preset, the mention, the subject, a brief and on X engagement the post each entry quotes). A sponsor never uploads a scorer, reference data or
// input data, so the house never runs a sponsor's code and no sponsor writes the rubric. When no
// template fits, the sponsor writes a plain-language scoring brief instead (CustomScoringProposal:
// scoring.custom; for a code bounty with its code kind, contracts/code-kinds.ts, and runtimes) and the
// make.fun team finishes the setup by attaching a template and its knobs
// (server/routes/admin/proposals.ts); only then is it composed and funded. Two templates are the team's
// alone (code-tests, CodeTestsChoice: a code bounty's objective, runtimes and the hidden test pack the
// team writes from the brief; judged-artifact, JudgedArtifactChoice: the judge's persona, the medium and
// its caps from the brief, and the judge model, anchors and calibrated ladder the team sets): the contract parses
// each, so a proposal the team set up checks and composes as any, but a sponsor never names one
// (server/routes/sponsor.ts refuses it on create and edit).
//
//   The sponsor writes   the title, summary, description, rules, category (one the template fits)
//                        and skills; competition.duration_hours, how long entries stay open;
//                        competition.placements, whether scores and places show while it runs; the
//                        template choice; the submission rule's max_per_day, max_total and
//                        strategy_note_required; the placement prizes; and on a Cheapest to build
//                        bounty (code-cheapest) alone, its build allowance (allowance_usd);
//                        optionally, an entry fee each account pays once into the escrow, where it
//                        joins the pot less make.fun's house share (entry_fee_usd: the bundle's
//                        entry_fee, its fund_percent the house share); with it, optionally,
//                        the percent of each fee the sponsor keeps as the bounty's creator, paid to
//                        its funding wallet less make.fun's cut (creator_percent: the bundle's
//                        entry_fee.creator); and,
//                        optionally, the opening it chooses (competition.start_at), held to the start
//                        window by proposal_schedule, on a house template or a judged brief only; and,
//                        optionally, its blind rounds (blind_rounds: 0 off, 1 to the server's most rounds,
//                        limits.max_blind_rounds (8 by default), at least limits.min_blind_round_minutes (15
//                        by default) of entries apart, absent for make.fun's default,
//                        proposalBlindRoundsDefault: limits.default_blind_rounds (3 by default) on a judged
//                        kind, fewer where its entries space fewer that far apart; a judged kind is always
//                        judged in private rounds, limits.min_blind_rounds (1 by default) at the least, so 0
//                        and placements live are refused on one: proposalBlindRoundsIssues), the draft competition row's runtime column
//                        (competition.blind_rounds), never a byte of the composed bundle
//   The house sets       every date, from duration_hours (server/proposals/schedule.ts houseDates)
//                        and start_at when written, on every save and checks pass and at the team's
//                        finish of a setup, until the deposit: competition.opens_at (start_at itself
//                        when written), the deadline and the final phase's window. A sponsor need not
//                        write them, and any written are replaced, never refused, so a downloaded
//                        proposal round-trips (one written with dates and no duration_hours is refused
//                        naming duration_hours, never a date)
//   The house fills      the version; status draft and visibility internal (approval lists it); a
//                        sponsor-namespaced slug; the sponsor; reward_usd (the prizes' sum); the
//                        dev phase (opens_at to the deadline) and both phases' datasets (the house
//                        attaches the windows it collects); the template's harness block, leaderboard
//                        and sandbox limits, and its prize rule (pumpfun-replay: beat holding cash;
//                        solana-bars-1h and solana-clmm-lp: beat the house baselines; code-tests,
//                        judged-artifact and social-post: none past its gate, and code-cheapest an efficiency-eligible
//                        build); the rest
//                        of the submission rule (transcripts_required true, house_only false, Force_Last
//                        but on code-first, Force_Best with max_total at most 30, an OSI license, a
//                        repository created after the opening); min_authored_coverage 0 (no
//                        efficiency prize; code-cheapest 0.8); code-cheapest's build meter (the
//                        sponsor's allowance, and each entrant's share of it and the models its build
//                        key may call: the setup's CodeTestsChoice.build, else the house's defaults);
//                        and the resolution panel, with a deterministic tie-break
//
// The build allowance is not a prize: it pays for the entrants' metered build keys (contracts/
// competition.ts BuildMeter), so it is no part of reward_usd or the escrow's pot; the house holds it and
// owes back what the keys did not spend. Its bounds are the proposal checks' (server/proposals/checks.ts),
// as every amount's is: PROPOSAL_CAPS counts characters and items only.
//
// Strict: a key the house fills is refused, never ignored, and so is any upload (a scorer, reference
// or input data, or a digest of one). Placement prizes only (an escrow pays nothing else). Every
// instant is whole seconds, as the escrow program counts them. zod and the pure registry only, no
// Node APIs.
//
// The challenge window is make.fun's alone, never the sponsor's (the owner, 2026-11-23: "No one wants to wait 24 hours
// to get paid. It's unnecessary. It should be like an hour"): the window a bounty's escrow opens with is the desk's
// value for it, else make.fun's setting for its pool (published at GET /api/sponsor/terms limits.challenge_window),
// raised to the chain's floors. A proposal naming the escrow block a sponsor once wrote (escrow.challenge_hours, until
// 2026-11-23) is refused at the root in one sentence (ESCROW_BLOCK_REFUSAL); a funded or cleared deposit's document read
// as stored drops it (proposalAsStored), since its window is on the deposit's accounts and is never derived again.
//
// No string anywhere in a proposal carries a make.fun API key (`af_` and 64 letters,
// ../transcripts/api-key.ts holdsMakefunApiKey, the pattern every caller-text ingest refuses a key by):
// proposalApiKeyIssue names the first, at its path, and both schemas refuse it there (refuseApiKeys), so
// proposal_schema fails and nothing composes, deposits or publishes with it. A proposal's text is read by
// the make.fun team and, once approved, by everyone, and whoever reads the key acts as the sponsor's account.

import { z } from 'zod';
import { CODE_KIND_IDS, CODE_KINDS, codeKindRuntimesFit, isCodeKindId, OFFERED_CODE_KIND_IDS, type CodeKindIdT, type CodeKindT } from './code-kinds.ts';
import {
  BuildKeyModels,
  BuildKeyShareUsd,
  Category,
  EntryFeeUsd,
  HouseAgent,
  PLACEMENTS,
  PROGRAM_JUDGE_MIN_ANCHORS,
  ProgramPack,
  Runtime,
  RUNTIMES,
  SPONSOR_JUDGE_MEDIA,
  UsdAmount,
  type CODABENCH_SUBMISSION_RULES,
} from './competition.ts';
import { holdsMakefunApiKey, MAKEFUN_API_KEY_WHAT } from '../transcripts/api-key.ts';
import { IsoDateTime, Sha256Hex } from './primitives.ts';
import { PAYOUT_MEASURED_MAX_PLACES, placesMostOf, type PlacesKind } from './payout-shapes.ts';
import {
  CODE_TESTS,
  CODE_TESTS_ID,
  isUploadKey,
  JUDGED_ARTIFACT,
  JUDGED_ARTIFACT_ID,
  JUDGED_ARTIFACT_MAX_ANCHORS,
  JUDGED_ARTIFACT_MAX_RUNGS,
  JUDGED_ARTIFACT_PROMPT_MAX,
  orList,
  PUMPFUN_REPLAY,
  PUMPFUN_REPLAY_DATASET_IDS,
  PUMPFUN_REPLAY_ID,
  PUMPFUN_REPLAY_METRIC_IDS,
  SOLANA_BARS,
  SOLANA_BARS_DATASET_IDS,
  SOLANA_BARS_ID,
  SOLANA_BARS_METRIC_IDS,
  SOLANA_CLMM,
  SOLANA_CLMM_DATASET_IDS,
  SOLANA_CLMM_ID,
  SOLANA_CLMM_METRIC_IDS,
  SOCIAL_POST,
  SOCIAL_POST_ID,
  SOCIAL_POST_PLATFORM_IDS,
  SOCIAL_POST_PRESET_IDS,
  SPONSOR_PICKABLE_TEMPLATE_IDS,
  uploadKeysIn,
  type TemplateChoiceT,
} from '../server/proposals/templates.ts';
import { socialQuotePostIdOf } from '../server/proposals/social-presets.ts';

export const SPONSOR_PROPOSAL_VERSION = 1;

/**
 * Size caps on what a sponsor writes (characters, or items for skills and prizes). `prizes` is the most places any bounty
 * pays (PAYOUT_MEASURED_MAX_PLACES, contracts/payout-shapes.ts): the schemas accept that many, and a judged bounty or a
 * code-fastest one pays at most PAYOUT_MAX_PLACES, where a real limit binds (a judged bounty's playoff and private rounds
 * grow with its places, server/proposals/judged-house.ts HOUSE_JUDGED_MAX_PLACES; a code-fastest bounty's timing heat is
 * sized on it, server/proposals/checks.ts PACK_HEAT_FIELD). That per-kind cut is refusePlacesCap, read by placesKindOf.
 */
export const PROPOSAL_CAPS = Object.freeze({
  title: 120,
  summary: 280,
  description: 16_000,
  rules: 32_000,
  skill: 40,
  skills: 12,
  prize_title: 80,
  prizes: PAYOUT_MEASURED_MAX_PLACES,
  max_per_day: 100,
  max_total: 10_000,
});

/** Size caps on a custom scoring brief (characters): what wins and how to judge it, at least a sentence; its worked examples. */
export const SCORING_BRIEF_CAPS = Object.freeze({ brief_min: 40, brief: 4_000, examples: 8_000 });

/** The most a proposal's canonical JSON may weigh, in bytes (well under the competition file's 256 KiB). */
export const MAX_PROPOSAL_BYTES = 128 * 1024;

/**
 * The proposal limits' defaults, per sponsor (one sponsor per account): at most `max_open` proposals
 * in review or running at once (deposited and not yet decided, or approved with a bounty whose result is not posted,
 * that is not cancelled, and whose escrow can still take one) and `max_per_day` submitted per UTC day.
 * MAKEFUN_SPONSOR_MAX_OPEN and MAKEFUN_SPONSOR_MAX_PER_DAY set a server's own (server/config.ts
 * sponsorMaxOpen, sponsorMaxPerDay); server/proposals/checks.ts proposal_rate holds a sponsor to them.
 */
export const PROPOSAL_RATE = Object.freeze({ max_open: 3, max_per_day: 3 });

/**
 * The least MAKEFUN_SPONSOR_MIN_PRIZE_USD may set a sponsor's prize pool floor to, in USD: a value under
 * it is taken as it (server/config.ts sponsorMinPrizeFloorUsd). Creating or saving a proposal under the
 * floor in force answers 422 (server/routes/sponsor.ts), and proposal_prizes fails under it.
 */
export const SPONSOR_MIN_PRIZE_FLOOR_USD = 1;

/** A sponsor's prize pool floor, USD, while MAKEFUN_SPONSOR_MIN_PRIZE_USD is unset. */
export const DEFAULT_SPONSOR_MIN_PRIZE_USD = 5;

/**
 * The longest whole run of a sponsored competition, hours, while MAKEFUN_SPONSOR_MAX_RUN_HOURS is unset: a week, from
 * the opening to the end of the final (the owner, 2026-11-20: "Yes, cap the whole run — shorter is better, let them
 * decide to run things shorter, let them pick"). Entries stay open only as long as the final leaves.
 */
export const DEFAULT_SPONSOR_MAX_RUN_HOURS = 168;

/**
 * How many times entry_fee_usd a proposal's pool (the sum of its prizes) totals at the least, while
 * MAKEFUN_SPONSOR_FEE_POT_MULTIPLE is unset; 0 holds no such rule.
 */
export const DEFAULT_SPONSOR_FEE_POT_MULTIPLE = 5;

const text = (max: number) => z.string().min(1).max(max);

/** An instant in whole seconds (the escrow program's unit), with an explicit offset. */
export const ProposalInstant = IsoDateTime.refine((s) => Date.parse(s) % 1000 === 0, 'whole seconds only (no fraction of a second)');

const START_AT_WORDS = 'competition.start_at is the opening you choose, a UTC instant in whole seconds like 2026-11-21T09:00:00Z; leave it out and make.fun picks the opening';

/** The opening a sponsor chooses (competition.start_at): an ISO 8601 instant in UTC (a Z, no other offset), whole seconds. */
export const ProposalStartAt = z.iso.datetime({ error: START_AT_WORDS }).refine((s) => Date.parse(s) % 1000 === 0, START_AT_WORDS);

export const ProposalCompetition = z.strictObject({
  title: text(PROPOSAL_CAPS.title),
  /** One line for the card and link previews. */
  summary: text(PROPOSAL_CAPS.summary),
  /** Board text: paragraphs split by a blank line, "- " bullets, "## " subheadings. */
  description: z.string().max(PROPOSAL_CAPS.description).default(''),
  /** The full rules, markdown. */
  rules: z.string().max(PROPOSAL_CAPS.rules).default(''),
  /** A board category the template fits (proposal_category). */
  category: Category,
  skills: z.array(text(PROPOSAL_CAPS.skill)).max(PROPOSAL_CAPS.skills).default([]),
  /**
   * How long entries stay open, hours (fractions allowed): any length from the schedule's shortest entries
   * window up, the house's 15 minutes, 0.25 (server/proposals/schedule.ts MIN_ENTRIES_MS, held by
   * proposal_schedule, not here: the schedule in force decides it). The test-windows schedule runs it at a
   * minute per hour, so 0.25 is its shortest there too (15 seconds).
   */
  duration_hours: z.number().positive(),
  /**
   * The opening the sponsor chooses, optional: a UTC instant in whole seconds (ProposalStartAt). Present, it is opens_at
   * (server/proposals/checks.ts scheduleProposal), held by proposal_schedule to the start window, from the opening the
   * house would pick up to MAKEFUN_SPONSOR_MAX_START_HOURS after the checks (server/proposals/schedule.ts startWindowOf),
   * and refused, never moved, outside it; refused on a custom brief, whose opening make.fun sets once its scoring is set
   * up, but a judged one (scoring.custom.judged), held to the start window of the lead its setup after funding takes.
   * Absent: the house picks the opening, and no key appears, so a proposal without it parses, composes and hashes as
   * it always did.
   */
  start_at: ProposalStartAt.optional(),
  /** Entries open (and the dev phase starts), set by the house: competition.start_at when written, else the first whole hour at least the review time after the save or checks pass. */
  opens_at: ProposalInstant,
  /** Entries close (and the dev phase ends), set by the house: duration_hours after opens_at. */
  deadline: ProposalInstant,
  /** Whether entries' scores and places show while the competition runs (the bundle's leaderboard.placements); absent: hidden until the results are published. */
  placements: z.enum(PLACEMENTS).optional(),
});

const UPLOADS_REFUSED = 'a sponsored competition uploads no scorer, reference or input data: it is scored by a house template';

/** The refusal of a harness that names no house template, by what it holds instead. */
function templateRefusal(input: unknown): string {
  const uploads = uploadKeysIn({ harness: input });
  const named = (input as { template?: unknown } | null)?.template;
  // The templates a sponsor names: a setup-only one (code-tests) is the make.fun team's, reached by a custom brief.
  const choose = `name a house template in harness.template: ${orList(SPONSOR_PICKABLE_TEMPLATE_IDS)}`;
  if (uploads.length > 0) return `${UPLOADS_REFUSED} (${uploads.join(', ')}); ${choose}`;
  if (typeof named === 'string') return `${JSON.stringify(named)} is not a house template; ${choose}`;
  return choose;
}

/** The refusal of a value a template does not list: what it should be, and the choices. */
function notListed(input: unknown, what: string, ids: readonly string[]): string {
  return input === undefined ? `name ${what}: one of ${orList(ids)}` : `${JSON.stringify(input)} is not ${what}: one of ${orList(ids)}`;
}

/** The refusal of a key a template's choice does not take: an upload, or a knob of another template. */
function unknownKeys(id: string) {
  return (iss: { code?: string; keys?: string[] }) =>
    iss.code === 'unrecognized_keys' && iss.keys !== undefined ? `${iss.keys.join(', ')}: ${iss.keys.some(isUploadKey) ? UPLOADS_REFUSED : `not a choice ${id} takes`}` : undefined;
}

/** The runtimes an entry may use on template `id` (default every one the template runs), each once. */
const runtimesOf = (id: string, knob: { readonly allowed: readonly z.infer<typeof Runtime>[]; readonly default: readonly z.infer<typeof Runtime>[] }) =>
  z
    .array(Runtime)
    .min(1, 'at least one runtime')
    .refine((rs) => new Set(rs).size === rs.length, 'a runtime is listed once')
    .refine((rs) => rs.every((r) => knob.allowed.includes(r)), `${id} runs ${orList(knob.allowed)} only`)
    .default(() => [...knob.default]);

const k = PUMPFUN_REPLAY.knobs;
/** An integer knob of template `id`, inside its bounds. */
const boundedOn = (id: string, name: string, knob: { min: number; max: number }, unit = '') =>
  z
    .int({ error: `${name} is a whole number, ${knob.min} to ${knob.max}${unit}` })
    .min(knob.min, `${name} is at least ${knob.min}${unit} on ${id}`)
    .max(knob.max, `${name} is at most ${knob.max}${unit} on ${id}`);
const bounded = (name: string, knob: { min: number; max: number; default: number }, unit = '') => boundedOn(PUMPFUN_REPLAY_ID, name, knob, unit).default(knob.default);

/** A choice of the pumpfun-replay template (server/proposals/templates.ts PUMPFUN_REPLAY): its window, its metric, its knobs. */
export const PumpfunReplayChoice = z.strictObject(
  {
    template: z.literal(PUMPFUN_REPLAY_ID),
    /** The forward window the final phase replays. */
    dataset: z.enum(PUMPFUN_REPLAY_DATASET_IDS, { error: (iss) => notListed(iss.input, `a dataset window ${PUMPFUN_REPLAY_ID} accepts`, PUMPFUN_REPLAY_DATASET_IDS) }),
    /** The leaderboard column entries rank by. */
    metric: z.enum(PUMPFUN_REPLAY_METRIC_IDS, { error: (iss) => notListed(iss.input, `a metric ${PUMPFUN_REPLAY_ID} ranks by`, PUMPFUN_REPLAY_METRIC_IDS) }),
    /** The runtimes an entry may use (default every one the template runs), each once. */
    runtimes: runtimesOf(PUMPFUN_REPLAY_ID, k.runtimes),
    /** The activity bar: coins each holding a round trip of at least the house's floor. */
    min_distinct_mints: bounded('min_distinct_mints', k.min_distinct_mints),
    /** The drawdown bar, in whole percent of equity. */
    max_drawdown_pct: bounded('max_drawdown_pct', k.max_drawdown_pct, '%'),
  },
  { error: unknownKeys(PUMPFUN_REPLAY_ID) },
);

/**
 * A choice of the solana-bars-1h template (server/proposals/templates.ts SOLANA_BARS): its window (3 or 7
 * whole UTC days), its one metric, its runtimes. Nothing else moves: solana-bars-1h-01's harness block runs
 * verbatim (but what a 3-day final changes in it: SOLANA_BARS.final_harness), and its buy-and-hold baseline
 * sets the prize bar.
 */
export const SolanaBarsChoice = z.strictObject(
  {
    template: z.literal(SOLANA_BARS_ID),
    /** The forward window the final phase is, the sponsor's pick: 3 or 7 whole UTC days from a UTC midnight. */
    dataset: z.enum(SOLANA_BARS_DATASET_IDS, { error: (iss) => notListed(iss.input, `a dataset window ${SOLANA_BARS_ID} accepts`, SOLANA_BARS_DATASET_IDS) }),
    /** The leaderboard column entries rank by. */
    metric: z.enum(SOLANA_BARS_METRIC_IDS, { error: (iss) => notListed(iss.input, `a metric ${SOLANA_BARS_ID} ranks by`, SOLANA_BARS_METRIC_IDS) }),
    runtimes: runtimesOf(SOLANA_BARS_ID, SOLANA_BARS.knobs.runtimes),
  },
  { error: unknownKeys(SOLANA_BARS_ID) },
);

/**
 * A choice of the solana-clmm-lp template (server/proposals/templates.ts SOLANA_CLMM): its window (3 or 7
 * whole UTC days), its one metric, its runtimes. Nothing else moves: solana-clmm-lp-01's harness block runs
 * verbatim (but a 3-day final's 2-hour blocks: SOLANA_CLMM.final_harness), and its two baselines set the
 * prize bar.
 */
export const SolanaClmmChoice = z.strictObject(
  {
    template: z.literal(SOLANA_CLMM_ID),
    /** The forward window the final phase is, the sponsor's pick: 3 or 7 whole UTC days from a UTC midnight. */
    dataset: z.enum(SOLANA_CLMM_DATASET_IDS, { error: (iss) => notListed(iss.input, `a dataset window ${SOLANA_CLMM_ID} accepts`, SOLANA_CLMM_DATASET_IDS) }),
    /** The leaderboard column entries rank by. */
    metric: z.enum(SOLANA_CLMM_METRIC_IDS, { error: (iss) => notListed(iss.input, `a metric ${SOLANA_CLMM_ID} ranks by`, SOLANA_CLMM_METRIC_IDS) }),
    runtimes: runtimesOf(SOLANA_CLMM_ID, SOLANA_CLMM.knobs.runtimes),
  },
  { error: unknownKeys(SOLANA_CLMM_ID) },
);

/** The code kinds the make.fun team may attach code-tests with: those offered now (the house cannot run the rest yet). */
const objectiveNotOffered = (iss: { input?: unknown }) => `${String(iss.input)} is not offered yet: the objective is one of ${orList(CODE_TESTS.knobs.objective.one_of)}`;

/**
 * The test pack a code-tests choice is graded on (server/proposals/packs.ts): the pack record's id (the blob
 * the house keeps it by, which the setup reads its checks and its proposal from) and its trees' digests
 * (ProgramPack, the bundle's harness.pack), so the composed bundle, and the escrow's rules_sha256, bind the
 * hidden cases. The make.fun team's, never a sponsor's upload.
 */
export const CodeTestsPack = ProgramPack.safeExtend({ id: Sha256Hex });

/** The code kind a build allowance and a build meter go with: Cheapest to build, ranked on the metered build cost. */
export const BUILD_ALLOWANCE_CODE_KIND = 'code-cheapest' as const satisfies CodeKindIdT;

/** "Cheapest to build (code-cheapest)": the kind a build allowance goes with, as a refusal names it. */
const ALLOWANCE_KIND_WORDS = `${CODE_KINDS[BUILD_ALLOWANCE_CODE_KIND].label} (${BUILD_ALLOWANCE_CODE_KIND})`;

/**
 * A code-cheapest choice's build keys (CodeTestsChoice.build): each entrant's share of the sponsor's build
 * allowance and the model globs its key may call, as the composed bundle's build meter carries them
 * (contracts/competition.ts BuildMeter per_entrant_usd and models; the share is clamped to the allowance
 * there). The make.fun team's, set at setup.
 */
export const CodeTestsBuild = z.strictObject({
  per_entrant_usd: BuildKeyShareUsd,
  models: BuildKeyModels,
});

/**
 * A choice of the code-tests template (server/proposals/templates.ts CODE_TESTS): the make.fun team's alone
 * (setup only: server/routes/sponsor.ts refuses it from a sponsor, server/routes/admin/proposals.ts attaches
 * it to a custom brief). Its objective, a code kind the house offers now (contracts/code-kinds.ts), picks
 * the winner; its runtimes, exactly one for a kind that compares entries in one language; its pack, the
 * hidden test cases the team wrote and sealed for this proposal; on code-cheapest alone, optionally its
 * build keys (CodeTestsBuild; absent, the house's defaults, and no key appears). No dataset window or
 * metric: the pack is its data, the objective its rank.
 */
export const CodeTestsChoice = z
  .strictObject(
    {
      template: z.literal(CODE_TESTS_ID),
      objective: z
        .enum(CODE_KIND_IDS, { error: (iss) => notListed(iss.input, `an objective ${CODE_TESTS_ID} ranks by (a code kind)`, CODE_TESTS.knobs.objective.one_of) })
        .refine((id) => CODE_KINDS[id].offered, { error: objectiveNotOffered }),
      runtimes: runtimesOf(CODE_TESTS_ID, CODE_TESTS.knobs.runtimes),
      pack: CodeTestsPack,
      build: CodeTestsBuild.optional(),
    },
    { error: unknownKeys(CODE_TESTS_ID) },
  )
  .superRefine((c, ctx) => {
    // zod skips this when a field is the wrong type, so CODE_KINDS is read only for a kind it holds; guarded all the same.
    if (!isCodeKindId(c.objective)) return;
    if (!codeKindRuntimesFit(c.objective, c.runtimes)) {
      const kind = CODE_KINDS[c.objective];
      ctx.addIssue({ code: 'custom', path: ['runtimes'], message: `${kind.id} (${kind.label}) compares every entry in one language: name exactly one runtime (${orList(CODE_TESTS.knobs.runtimes.allowed)}), not ${c.runtimes.length}`, input: c.runtimes });
    }
    if (c.build !== undefined && c.objective !== BUILD_ALLOWANCE_CODE_KIND) {
      const kind = CODE_KINDS[c.objective];
      ctx.addIssue({
        code: 'custom',
        path: ['build'],
        message: `build sets the metered build keys of a ${ALLOWANCE_KIND_WORDS} bounty alone, and the objective is ${kind.id} (${kind.label}), which meters no build: drop build`,
        input: c.build,
      });
    }
  });

const ja = JUDGED_ARTIFACT.knobs;
const JUDGED_CAP_KEYS = ['max_chars', 'max_bytes', 'max_width', 'max_height'] as const;

/** A judged artifact's medium, the judge's persona and the medium's caps, each inside its bound: the sponsor's part of a judged choice, and a judged brief's whole (ProposalJudgedBrief). */
const judgedMediaFields = {
  media: z.enum(SPONSOR_JUDGE_MEDIA, { error: (iss) => notListed(iss.input, `a medium ${JUDGED_ARTIFACT_ID} judges`, ja.media.one_of) }),
  prompt: z
    .string({ error: "write the judge's persona: the prompt it judges by" })
    .max(JUDGED_ARTIFACT_PROMPT_MAX, `the judge's persona is at most ${JUDGED_ARTIFACT_PROMPT_MAX} characters`)
    .refine((s) => s.trim().length > 0, "write the judge's persona: the prompt it judges by"),
  max_chars: boundedOn(JUDGED_ARTIFACT_ID, 'max_chars', ja.max_chars, ' characters').optional(),
  max_bytes: boundedOn(JUDGED_ARTIFACT_ID, 'max_bytes', ja.max_bytes, ' bytes').optional(),
  max_width: boundedOn(JUDGED_ARTIFACT_ID, 'max_width', ja.max_width, ' pixels').optional(),
  max_height: boundedOn(JUDGED_ARTIFACT_ID, 'max_height', ja.max_height, ' pixels').optional(),
};

/** Refuses each cap of the other medium (a text's max_bytes, an image's max_chars), at its key. */
function refuseOtherMediumCaps(c: { media: (typeof SPONSOR_JUDGE_MEDIA)[number] } & Partial<Record<(typeof JUDGED_CAP_KEYS)[number], number>>, ctx: z.RefinementCtx): void {
  const medium = JUDGED_ARTIFACT.media[c.media];
  const an = c.media === 'image' ? 'an image' : 'a text';
  for (const key of JUDGED_CAP_KEYS) {
    if (c[key] === undefined || medium.caps.includes(key)) continue;
    ctx.addIssue({ code: 'custom', path: [key], message: `${key} is not a cap of ${an} artifact, whose caps are ${medium.caps.join(', ')}: drop ${key}`, input: c[key] });
  }
}

/** A house anchor's file name under the judge directory's anchors/: a plain name, never a path. */
const AnchorName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'an anchor is named as a plain file: 1 to 64 letters, digits, dots, underscores and hyphens, starting with a letter or digit');

/** A house anchor the team attached: its file name and its bytes' sha256, the blob it was attached as. */
export const JudgedArtifactAnchor = z.strictObject({ name: AnchorName, sha256: Sha256Hex });

/**
 * A judged artifact's calibrated ladder, the make.fun team's (server/proposals/templates.ts JudgedArtifactLadderT): the
 * blob of the house judge's calibration record (calibration.json, grade-local --calibrate's) and at most
 * JUDGED_ARTIFACT_MAX_RUNGS rungs, house artifacts of the medium named as anchors are, none an anchor's bytes and no two
 * alike (the medium's file endings, distinct names: checked with the choice). Whether the record calibrates this judge
 * and these members is the grader's to hold (grader/judge-ladder-tree.ts readJudgeLadder): this contract cannot read it.
 */
export const JudgedArtifactLadder = z.strictObject(
  {
    calibration_sha256: Sha256Hex,
    rungs: z.array(JudgedArtifactAnchor).max(JUDGED_ARTIFACT_MAX_RUNGS, `at most ${JUDGED_ARTIFACT_MAX_RUNGS} rungs: each is a member of the calibration's round robin`).optional(),
  },
  { error: (iss) => (iss.code === 'unrecognized_keys' && iss.keys !== undefined ? `${iss.keys.join(', ')}: not a key a ${JUDGED_ARTIFACT_ID} ladder takes (calibration_sha256, rungs)` : undefined) },
);

/**
 * The judged-artifact choice (the make.fun team's alone; server/proposals/templates.ts JudgedArtifactTemplate). From
 * the sponsor's brief: the medium, the judge's persona (prompt) and the medium's caps, each inside its bound and
 * absent for its default; the other medium's caps are refused. The team's: the judge's model call (a HouseAgent but
 * its prompt file, which is always prompt.md) and at least PROGRAM_JUDGE_MIN_ANCHORS anchors of the medium (distinct
 * bytes, distinct names); and, once it has calibrated the composed bundle's judge, its ladder (JudgedArtifactLadder),
 * absent until then. House judging has no spend cap: the choice sets none.
 */
export const JudgedArtifactChoice = z
  .strictObject(
    {
      template: z.literal(JUDGED_ARTIFACT_ID),
      media: judgedMediaFields.media,
      prompt: judgedMediaFields.prompt,
      runtimes: runtimesOf(JUDGED_ARTIFACT_ID, ja.runtimes),
      max_chars: judgedMediaFields.max_chars,
      max_bytes: judgedMediaFields.max_bytes,
      max_width: judgedMediaFields.max_width,
      max_height: judgedMediaFields.max_height,
      agent: HouseAgent.omit({ prompt: true }),
      anchors: z
        .array(JudgedArtifactAnchor)
        .min(PROGRAM_JUDGE_MIN_ANCHORS, `at least ${PROGRAM_JUDGE_MIN_ANCHORS} anchors: the judge's fixed points, weak to strong`)
        .max(JUDGED_ARTIFACT_MAX_ANCHORS, `at most ${JUDGED_ARTIFACT_MAX_ANCHORS} anchors: each is in every heat's field`),
      // The judge spend cap a choice set up before house judging lost its caps still names: a whole number, read by
      // nothing (judgedArtifactHarnessOf composes no cap key), kept so a stored proposal's choice parses as it was stored.
      max_total_usd: z.int({ error: 'max_total_usd is a whole number of USD' }).optional(),
      ladder: JudgedArtifactLadder.optional(),
    },
    { error: unknownKeys(JUDGED_ARTIFACT_ID) },
  )
  .superRefine((c, ctx) => {
    refuseOtherMediumCaps(c, ctx);
    const medium = JUDGED_ARTIFACT.media[c.media];
    const an = c.media === 'image' ? 'an image' : 'a text';
    const names = new Set<string>();
    const digests = new Set<string>();
    c.anchors.forEach((a, i) => {
      if (!medium.anchor_extensions.some((ext) => a.name.endsWith(ext)))
        ctx.addIssue({ code: 'custom', path: ['anchors', i, 'name'], message: `${an} anchor's file name ends in ${orList(medium.anchor_extensions)}`, input: a.name });
      if (names.has(a.name)) ctx.addIssue({ code: 'custom', path: ['anchors', i, 'name'], message: `anchor ${a.name} is named twice`, input: a.name });
      if (digests.has(a.sha256)) ctx.addIssue({ code: 'custom', path: ['anchors', i, 'sha256'], message: `anchor ${a.name} has another anchor's bytes: each anchor is distinct`, input: a.sha256 });
      names.add(a.name);
      digests.add(a.sha256);
    });
    // The rungs: artifacts of the medium, one ladder member each, apart from the anchors (readJudgeLadder refuses a twin).
    const rungNames = new Set<string>();
    const rungDigests = new Set<string>();
    (c.ladder?.rungs ?? []).forEach((r, i) => {
      const at = ['ladder', 'rungs', i];
      if (!medium.anchor_extensions.some((ext) => r.name.endsWith(ext))) ctx.addIssue({ code: 'custom', path: [...at, 'name'], message: `${an} rung's file name ends in ${orList(medium.anchor_extensions)}`, input: r.name });
      if (rungNames.has(r.name)) ctx.addIssue({ code: 'custom', path: [...at, 'name'], message: `rung ${r.name} is named twice`, input: r.name });
      if (digests.has(r.sha256)) ctx.addIssue({ code: 'custom', path: [...at, 'sha256'], message: `rung ${r.name} has an anchor's bytes: a rung is a ladder member apart from the anchors`, input: r.sha256 });
      else if (rungDigests.has(r.sha256)) ctx.addIssue({ code: 'custom', path: [...at, 'sha256'], message: `rung ${r.name} has another rung's bytes: each rung is distinct`, input: r.sha256 });
      rungNames.add(r.name);
      rungDigests.add(r.sha256);
    });
  });

const sp = SOCIAL_POST.texts;

/** A one-line text of a social-post choice, trimmed: `name`, 1 to `max` characters, no line break (CR, LF, U+2028 or U+2029). */
const socialLine = (name: string, max: number, what: string) =>
  z
    .string({ error: `write ${name}: ${what}` })
    .trim()
    .min(1, `write ${name}: ${what}`)
    .max(max, `${name} is at most ${max} characters`)
    .refine((s) => !/[\r\n\u2028\u2029]/.test(s), `${name} is one line: it holds no line break`);

/**
 * A choice of the social-post template (server/proposals/templates.ts SOCIAL_POST), a sponsor's own: where the posts go
 * (platform: x, tiktok or youtube) and what ranks them (preset: views, or engagement on x alone: X's likes, reposts and
 * quotes), each pair a sealed home (server/proposals/social-presets.ts); the mention every post carries as written in
 * its own text (the sponsor's tag or handle, one line of at most ENTRY_LINK_MENTION_MAX characters, the bundle's
 * entry_link.mention); the subject the posts promote (one line); optionally a brief (what to make of the subject, the
 * rules print it as written); and, on x engagement alone, quote_post, the address of the sponsor's own X post every
 * entry quotes (https://x.com/<handle>/status/<id>; the bundle carries its bare id). What media a post carries is the
 * preset's, never the choice's: a native video on a views preset, any picture or video of the post's own on engagement.
 * Every text is trimmed.
 */
export const SocialPostChoice = z
  .strictObject(
    {
      template: z.literal(SOCIAL_POST_ID),
      platform: z.enum(SOCIAL_POST_PLATFORM_IDS, { error: (iss) => notListed(iss.input, `a platform ${SOCIAL_POST_ID} posts on`, SOCIAL_POST_PLATFORM_IDS) }),
      preset: z.enum(SOCIAL_POST_PRESET_IDS, { error: (iss) => notListed(iss.input, `a preset ${SOCIAL_POST_ID} ranks on`, SOCIAL_POST_PRESET_IDS) }),
      mention: socialLine('mention', sp.mention.max_chars, sp.mention.text),
      subject: socialLine('subject', sp.subject.max_chars, sp.subject.text),
      brief: z.string({ error: `brief is text: ${sp.brief.text}` }).trim().max(sp.brief.max_chars, `brief is at most ${sp.brief.max_chars} characters`).optional(),
      quote_post: z.string({ error: `quote_post is text: ${sp.quote_post.text}` }).trim().max(sp.quote_post.max_chars, `quote_post is at most ${sp.quote_post.max_chars} characters`).optional(),
    },
    { error: unknownKeys(SOCIAL_POST_ID) },
  )
  .superRefine((c, ctx) => {
    if (c.preset === 'engagement' && c.platform !== 'x') {
      ctx.addIssue({ code: 'custom', path: ['preset'], message: `${c.platform} ranks on views alone (its reader counts no engagement a preset weighs): set preset to views, or platform to x`, input: c.preset });
    }
    if (c.quote_post === undefined) return;
    if (c.platform !== 'x' || c.preset !== 'engagement') {
      ctx.addIssue({ code: 'custom', path: ['quote_post'], message: `quote_post names the X post every entry quotes, on x engagement alone, and this choice is ${c.platform} ${c.preset}: drop quote_post`, input: c.quote_post });
      return;
    }
    if (socialQuotePostIdOf(c.quote_post) === null) {
      ctx.addIssue({ code: 'custom', path: ['quote_post'], message: "quote_post is the address of your own post on X, https://x.com/<handle>/status/<id> (or twitter.com), its id 1 to 20 digits", input: c.quote_post });
    }
  });

/** The harness: a house template choice, by template id (code-tests and judged-artifact the make.fun team's alone). */
export const ProposalHarness = z.discriminatedUnion('template', [PumpfunReplayChoice, SolanaBarsChoice, SolanaClmmChoice, SocialPostChoice, CodeTestsChoice, JudgedArtifactChoice], {
  error: (iss) => templateRefusal(iss.input),
});

/**
 * The final phase's window, set by the house with the competition's dates (server/proposals/schedule.ts
 * houseDates): scores are graded on it and shown once an admin finalizes it. It starts the
 * schedule's final gap (the house's 10 minutes) or more after the deadline. Its data starts the template's
 * lead after starts_at; on a window of whole UTC days (solana-bars-1h, solana-clmm-lp) the phase is the
 * window exactly, starts_at a UTC midnight and ends_at its end; a code bounty's test pack (code-tests),
 * and a custom brief until its template is attached, collect no data, so ends_at need only follow
 * starts_at: the final grades are queued when the final phase is locked (the deadline at the earliest) and
 * the result is posted once the final phase's results are published and its checks pass, not at the final
 * window's end, so the window need not hold the grading (server/proposals/checks.ts proposal_schedule,
 * described in server/entries/checks.ts).
 */
export const ProposalFinal = z.strictObject({
  starts_at: ProposalInstant,
  ends_at: ProposalInstant,
});

export const ProposalSubmissionRule = z.strictObject({
  max_per_day: z.int().min(1).max(PROPOSAL_CAPS.max_per_day).default(5),
  max_total: z.int().min(1).max(PROPOSAL_CAPS.max_total).nullable().default(null),
  strategy_note_required: z.boolean().default(false),
});

/**
 * The one sentence a proposal naming the escrow block is refused in (rootKeysRefusal, at the root, after `escrow: `):
 * a bounty's challenge window is make.fun's, never a sponsor's choice. The block a sponsor once wrote
 * (escrow.challenge_hours, until 2026-11-23) is gone: a new proposal, an amendment and a saved unfunded draft at its
 * next checks are refused naming it; a funded or cleared deposit's document read as stored drops it (proposalAsStored).
 */
export const ESCROW_BLOCK_REFUSAL = "a bounty's challenge window is make.fun's, published at GET /api/sponsor/terms (limits.challenge_window): remove the escrow block";

/**
 * make.fun's defaults for blind rounds as a sponsor names them (blind_rounds): `max`, the most rounds, and `default`, the
 * rounds a judged kind starts with, fewer where its entries space fewer PROPOSAL_BLIND_ROUND_MIN_MINUTES apart
 * (proposalBlindRoundsDefaultFor: the owner's "at least like ... 15 30 minutes between each judge running a given
 * contest"). The owner (2026-11-22): "maybe we just default it to like ... three, and then they can select up to like,
 * up to eight or something, just to prevent like judge spam abuse too", and of every limit of the build: "It's going to
 * all be configurable by us". So these are the defaults of make.fun's settings (server/config.ts
 * MAKEFUN_SPONSOR_MAX_BLIND_ROUNDS and MAKEFUN_SPONSOR_DEFAULT_BLIND_ROUNDS, published as limits.max_blind_rounds and
 * limits.default_blind_rounds), the limits every reader here takes when it is handed none (PROPOSAL_BLIND_ROUNDS_LIMITS),
 * and what a client falls back to where the terms carry none. A user's bounty alone: a house bundle's row starts at
 * server/competitions/blind-rounds.ts BLIND_ROUNDS_DEFAULT and an admin may set up to BLIND_ROUNDS_MAX (the column's
 * CHECK), PROPOSAL_BLIND_ROUNDS_STORED_MAX here, which this contract cannot import (that module loads drizzle and the
 * database schema); tests/unit/sponsor-proposal-blind-rounds.test.ts holds this within the server's.
 *
 * `min`, the least rounds a judged kind runs (proposalJudgedBlindRoundsLeast): the owner (2026-11-22): "make sure that
 * any contests we construct for them is blind round mode if subjective". So a judged bounty a user's proposal builds is
 * always judged in private rounds, 1 at the least (one round, judged at the close), never in public: a new proposal or an
 * amendment of a judged kind naming 0 is refused (proposalBlindRoundsIssues), and make.fun's default never falls under
 * it. A setting too (server/config.ts MAKEFUN_SPONSOR_MIN_BLIND_ROUNDS, published as limits.min_blind_rounds); 0 there
 * restores the public choice. A kind that is not judged runs none unless it names them, whatever the least.
 */
export const PROPOSAL_BLIND_ROUNDS = Object.freeze({ max: 8, default: 3, min: 1 });

/**
 * The most blind rounds a proposal may name on any server: the draft row's column CHECK
 * (server/competitions/blind-rounds.ts BLIND_ROUNDS_MAX), the absolute shape of the field (ProposalBlindRounds) and the
 * most make.fun's setting takes (MAKEFUN_SPONSOR_MAX_BLIND_ROUNDS). It was also the cap until 2026-11-22, so a funded
 * proposal's document may name a count past the server's most up to it; such a count is never taken anew, from a new
 * proposal or an amendment (proposalSchemasOf at the server's limits refuses it), but the stored document keeps it and
 * is read as written (proposalAsStored, proposalStoredBlindRounds), never rewritten.
 */
export const PROPOSAL_BLIND_ROUNDS_STORED_MAX = 48;

/**
 * make.fun's default for the fewest minutes of entries between two of a sponsor's blind rounds (server/config.ts
 * MAKEFUN_SPONSOR_MIN_BLIND_ROUND_MINUTES, published as limits.min_blind_round_minutes): a count is refused whose rounds
 * would come closer (proposalBlindRoundsMost). The sponsor's field alone: an admin's count
 * (server/routes/admin/blind-rounds.ts) is held to no spacing.
 */
export const PROPOSAL_BLIND_ROUND_MIN_MINUTES = 15;

/**
 * The limits a server holds a sponsor's blind rounds to (server/proposals/checks.ts ProposalCaps, from server/config.ts:
 * limits.max_blind_rounds, limits.default_blind_rounds, limits.min_blind_round_minutes): `max`, the most rounds a new
 * proposal or an amendment names (1 to PROPOSAL_BLIND_ROUNDS_STORED_MAX); `default`, the rounds a judged kind starts with
 * when it names none (1 to `max`, fewer where its entries space fewer); `min_minutes`, the fewest minutes of entries
 * between two rounds (1 or more); `min`, the least rounds a judged kind runs (0 to `default`: limits.min_blind_rounds,
 * proposalJudgedBlindRoundsLeast), absent make.fun's (PROPOSAL_BLIND_ROUNDS.min, 1), so limits written before it read
 * at make.fun's least. A stored document is read at 0 (server/proposals/checks.ts storedBlindRoundsHeldOf), never held to it.
 */
export interface ProposalBlindRoundsLimits {
  readonly max: number;
  readonly default: number;
  readonly min_minutes: number;
  readonly min?: number;
}

/** make.fun's blind rounds limits with none of its settings set (PROPOSAL_BLIND_ROUNDS, PROPOSAL_BLIND_ROUND_MIN_MINUTES): what every reader here takes when handed none. */
export const PROPOSAL_BLIND_ROUNDS_LIMITS: ProposalBlindRoundsLimits = Object.freeze({
  max: PROPOSAL_BLIND_ROUNDS.max,
  default: PROPOSAL_BLIND_ROUNDS.default,
  min_minutes: PROPOSAL_BLIND_ROUND_MIN_MINUTES,
  min: PROPOSAL_BLIND_ROUNDS.min,
});

/** The limits a schema holds blind_rounds to (proposalSchemasOf): the most rounds, their spacing and a judged kind's least. */
export type ProposalBlindRoundsHeld = Pick<ProposalBlindRoundsLimits, 'max' | 'min_minutes' | 'min'>;

/** The least rounds a judged kind runs under `limits` (ProposalBlindRoundsLimits.min), make.fun's where they name none. */
export const blindRoundsLeastOf = (limits: Pick<ProposalBlindRoundsLimits, 'min'>): number => limits.min ?? PROPOSAL_BLIND_ROUNDS.min;

/**
 * `limits` as a reader here is handed them, else make.fun's defaults: where none is handed, and where what came is no
 * object (a reader passed to Array.prototype.map, its index in the place of the limits), so every reader reads as it did
 * before the limits were settings unless a server's are handed it.
 */
const limitsOr = <T extends object>(limits: T | undefined): T => (typeof limits === 'object' && limits !== null ? limits : (PROPOSAL_BLIND_ROUNDS_LIMITS as unknown as T));

/** The field's words at `max` rounds: what a count it does not take is refused in. */
const blindRoundsWordsOf = (max: number): string => `blind_rounds is 0 for off, a whole number of rounds from 1 to ${max}, or left out for make.fun's default`;

/**
 * blind_rounds held to `max` rounds: 0 off, 1 to `max`, in the field's words (blindRoundsWordsOf), past `max` naming it.
 * While on, no score shows when an entry is sent and no one's place shows until the results are published; at each
 * round every entry received so far is judged the way the final judges, and each entrant then sees their own place and,
 * with more than one round, the five entries ranked just above and the five just below their best placed entry, never
 * the rest (server/competitions/blind-rounds.ts blindRoundsNote, the board hidden as a sponsor's bounty starts).
 * Never null: an RFC 7386 merge patch's null deletes the key, which is the default.
 */
const blindRoundsFieldOf = (max: number) => {
  const words = blindRoundsWordsOf(max);
  return z.int({ error: words }).min(0, words).max(max, `${words}: at most ${max} rounds`);
};

/**
 * The blind rounds a sponsor names (blind_rounds) in their absolute shape: a whole number 0 (off) to
 * PROPOSAL_BLIND_ROUNDS_STORED_MAX, the bound a stored document reads by on any server. The server's most and spacing
 * (make.fun's settings) are not this field's: proposal_schema holds a new proposal and an amendment to them
 * (proposalSchemasOf at the server's limits: server/proposals/checks.ts schemaCheck).
 */
export const ProposalBlindRounds = blindRoundsFieldOf(PROPOSAL_BLIND_ROUNDS_STORED_MAX);

/** The refusal of blind rounds beside competition.placements 'live', at blind_rounds. */
export const BLIND_ROUNDS_LIVE_WORDS = 'blind rounds hide every place until the results are published, and placements live shows them as runs finish: drop one';

/**
 * The most blind rounds `durationHours` of entries (competition.duration_hours) take under `limits`, each round at least
 * limits.min_minutes of entries after the one before, and never over limits.max: on make.fun's defaults
 * (PROPOSAL_BLIND_ROUNDS_LIMITS) 4 on an hour, 1 on 15 minutes, 0 under them. Counted in the hours duration_hours writes,
 * as proposal_schedule counts the whole run: a final window of whole UTC days moves the deadline on to a midnight, which
 * only spaces the rounds wider.
 */
export function proposalBlindRoundsMost(durationHours: number, limits?: ProposalBlindRoundsHeld): number {
  if (!Number.isFinite(durationHours) || durationHours <= 0) return 0;
  const l = limitsOr(limits);
  const ms = Math.round(durationHours * 3_600_000);
  return Math.min(l.max, Math.floor(ms / (l.min_minutes * 60_000)));
}

/**
 * The least blind rounds a user's judged bounty with `durationHours` of entries runs under `limits`: 0 while the least is
 * 0 (limits.min, the public choice open), else the least, lowered to what those entries space limits.min_minutes apart
 * but never under 1: entries shorter than the spacing take one round, judged at the close (the final itself:
 * server/competitions/blind-rounds.ts blindRoundCutoffs' last cutoff is the deadline), so a judged bounty is private
 * however short. On the defaults 1 on every length.
 */
export function proposalJudgedBlindRoundsLeast(durationHours: number, limits?: ProposalBlindRoundsHeld): number {
  const l = limitsOr(limits);
  const least = blindRoundsLeastOf(l);
  if (least <= 0) return 0;
  return Math.min(least, Math.max(1, proposalBlindRoundsMost(durationHours, l)));
}

/**
 * The most blind rounds a user's judged bounty with `durationHours` of entries may name under `limits`: the most those
 * entries space (proposalBlindRoundsMost), and never under the least it runs (proposalJudgedBlindRoundsLeast: one round at
 * the close on entries shorter than the spacing, while the least is 1 or more). On the defaults 1 under 30 minutes, 2
 * on 30, 4 on an hour.
 */
export function proposalJudgedBlindRoundsMost(durationHours: number, limits?: ProposalBlindRoundsHeld): number {
  const l = limitsOr(limits);
  return Math.max(proposalBlindRoundsMost(durationHours, l), proposalJudgedBlindRoundsLeast(durationHours, l));
}

/**
 * The blind rounds a user's judged bounty with `durationHours` of entries (competition.duration_hours) starts with when
 * it names none: limits.default, lowered to the most those entries space limits.min_minutes apart
 * (proposalBlindRoundsMost), so make.fun's default never judges closer than a named count may, and never under the least
 * a judged bounty runs (proposalJudgedBlindRoundsLeast): on the defaults 1 under 30 minutes (one round at the close
 * under 15), 2 on 30, 3 from 45; with the least at 0, 0 (off) under 15 minutes, as before the least.
 */
export function proposalBlindRoundsDefaultFor(durationHours: number, limits?: ProposalBlindRoundsLimits): number {
  const l = limitsOr(limits);
  return Math.max(proposalJudgedBlindRoundsLeast(durationHours, l), Math.min(l.default, proposalBlindRoundsMost(durationHours, l)));
}

/**
 * Whether `doc` (as written or parsed) is of a judged kind: the judged-artifact template, or a judged brief
 * (scoring.custom.judged), the kinds a judge model ranks against the field. A Something else brief is not (the template
 * its setup attaches decides it), nor any other template or code kind.
 */
export function proposalJudgedKind(doc: unknown): boolean {
  const harness = fieldOf(doc, 'harness');
  if (harness !== undefined) return fieldOf(harness, 'template') === JUDGED_ARTIFACT_ID;
  return fieldOf(fieldOf(fieldOf(doc, 'scoring'), 'custom'), 'judged') !== undefined;
}

/** The fix a judged kind's public choice is refused with (proposalBlindRoundsIssues): its words name the least. */
export const JUDGED_PRIVATE_FIX = 'private judging, at least 1 round';

/** JUDGED_PRIVATE_FIX at a least of `least` rounds. */
const judgedPrivateFixOf = (least: number): string => (least === 1 ? JUDGED_PRIVATE_FIX : `private judging, at least ${least} rounds`);

/** A number in words with at most one decimal (7.5, 90). */
const decimalWords = (n: number): string => String(Math.round(n * 10) / 10);

/** What proposalBlindRoundsIssues reads of a proposal: its count, its competition and, for its kind (proposalJudgedKind), its harness or scoring. */
export type BlindRoundsIssuesInput = { blind_rounds?: number | undefined; competition: { placements?: string | undefined; duration_hours: number }; harness?: unknown; scoring?: unknown };

/**
 * Why `blind_rounds` cannot run as named beside these competition fields under `limits` (make.fun's defaults unless
 * handed the server's), or none: a count of 1 or more beside placements 'live' (BLIND_ROUNDS_LIVE_WORDS), or more rounds
 * than the entries window spaces limits.min_minutes apart (proposalBlindRoundsMost), naming the most it takes. On a
 * judged kind (proposalJudgedKind) while its least is 1 or more (proposalJudgedBlindRoundsLeast: limits.min, 1 by
 * default), judging is private: a named 0, or placements 'live' with none named, is refused naming the least
 * (JUDGED_PRIVATE_FIX), and its most is never under that least (proposalJudgedBlindRoundsMost: one round at the close on
 * entries shorter than the spacing). Otherwise 0 and absent always pass, and so does a count past limits.max, which the
 * field refuses in its own words. With the least at 0 every answer is the one before the least.
 */
export function proposalBlindRoundsIssues(p: BlindRoundsIssuesInput, held?: ProposalBlindRoundsHeld): string[] {
  const limits = limitsOr(held);
  const n = p.blind_rounds;
  const hours = p.competition.duration_hours;
  const least = proposalJudgedKind(p) ? proposalJudgedBlindRoundsLeast(hours, limits) : 0;
  if (least >= 1) {
    const most = Math.max(least, Math.min(limits.max, proposalJudgedBlindRoundsMost(hours, limits)));
    const range = most === least ? `${least}` : `from ${least} to ${most}`;
    if (n === 0) return [`blind_rounds 0 judges in public, and make.fun judges a judged bounty in private rounds: set blind_rounds ${least === most ? 'to ' : ''}${range} (${judgedPrivateFixOf(least)}), or leave it out`];
    if (n === undefined && p.competition.placements === 'live') return [`competition.placements live shows scores as entries are judged, and make.fun judges a judged bounty in private rounds: drop placements live (${judgedPrivateFixOf(least)})`];
  }
  // A count the field itself refuses (blindRoundsFieldOf) is named once, in its words.
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > limits.max) return [];
  const out: string[] = [];
  if (p.competition.placements === 'live') out.push(BLIND_ROUNDS_LIVE_WORDS);
  const most = least >= 1 ? proposalJudgedBlindRoundsMost(hours, limits) : proposalBlindRoundsMost(hours, limits);
  if (n > most) {
    const apart = `rounds are at least ${limits.min_minutes} minutes of entries apart`;
    out.push(
      most === 0
        ? `competition.duration_hours ${hours} keeps entries open under ${limits.min_minutes} minutes, and ${apart}: set blind_rounds to 0, or leave it out`
        : least >= 1 && proposalBlindRoundsMost(hours, limits) === 0
          ? `competition.duration_hours ${hours} keeps entries open under ${limits.min_minutes} minutes, and ${apart}, so a judged bounty runs one private round, at the close: set blind_rounds to 1, or leave it out`
          : `blind_rounds ${n} would judge a round every ${decimalWords((hours * 60) / n)} minutes of entries, and ${apart}, so competition.duration_hours ${hours} takes at most ${most}: set blind_rounds to ${most} or fewer${least >= 1 ? '' : ', or 0 for off'}`,
    );
  }
  return out;
}

/**
 * Refuses blind rounds that cannot run as named, at blind_rounds: held to `held` (proposalBlindRoundsIssues: the
 * spacing, none beside placements live, and a judged kind's private judging at held.min), or, `held` null (the absolute
 * shape), only a count beside placements live.
 */
function blindRoundsRefusalOf(held: ProposalBlindRoundsHeld | null) {
  return (p: BlindRoundsIssuesInput, ctx: z.RefinementCtx): void => {
    const n = p.blind_rounds;
    const counted = typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= PROPOSAL_BLIND_ROUNDS_STORED_MAX;
    const issues = held !== null ? proposalBlindRoundsIssues(p, held) : counted && p.competition.placements === 'live' ? [BLIND_ROUNDS_LIVE_WORDS] : [];
    for (const message of issues) ctx.addIssue({ code: 'custom', path: ['blind_rounds'], message, input: p.blind_rounds });
  };
}

/** A plain object's own field, or undefined. */
function fieldOf(x: unknown, key: string): unknown {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>)[key] : undefined;
}

/**
 * The blind rounds a proposal starts with when it names none (blind_rounds absent), read off the document as written
 * or parsed: null (off) beside competition.placements 'live'; on a judged kind, a judged brief (scoring.custom.judged)
 * or the judged-artifact template, PROPOSAL_BLIND_ROUNDS.default held to its entries' length
 * (proposalJudgedBlindRoundsDefault: never closer than PROPOSAL_BLIND_ROUND_MIN_MINUTES apart, and never under the least
 * a judged kind runs, one round at the close where they space none; null there only with the least at 0); null on
 * every other template and on a brief naming a code kind (beside placements live too, which a new judged proposal may
 * not name while the least is 1 or more: proposalBlindRoundsIssues); undefined on a custom brief with neither
 * (Something else), whose template the make.fun team attaches at setup decides it. On exactly where
 * server/competitions/blind-rounds.ts blindRoundsDefaultOf starts the bundle each composes on, at a user's count, never
 * the house's BLIND_ROUNDS_DEFAULT (server/proposals/blind-rounds.ts sponsorBlindRoundsOf writes it to the draft row;
 * tests/unit/sponsor-proposal-blind-rounds.test.ts). Under `limits`, the server's (make.fun's defaults unless handed them).
 */
export function proposalBlindRoundsDefault(doc: unknown, given?: ProposalBlindRoundsLimits): number | null | undefined {
  const limits = limitsOr(given);
  if (fieldOf(fieldOf(doc, 'competition'), 'placements') === 'live') return null;
  const harness = fieldOf(doc, 'harness');
  if (harness !== undefined) return fieldOf(harness, 'template') === JUDGED_ARTIFACT_ID ? proposalJudgedBlindRoundsDefault(doc, limits) : null;
  const custom = fieldOf(fieldOf(doc, 'scoring'), 'custom');
  if (fieldOf(custom, 'judged') !== undefined) return proposalJudgedBlindRoundsDefault(doc, limits);
  if (fieldOf(custom, 'kind') !== undefined) return null;
  return undefined;
}

/**
 * The default blind rounds of a judged proposal `doc` (one whose bundle blindRoundsDefaultOf starts on) under `limits`,
 * read off its competition.duration_hours: proposalBlindRoundsDefaultFor that length (never under the least, one round at
 * the close on entries shorter than the spacing), null (off) only where the least is 0 and it spaces none; a document
 * naming no length as a number yet (a kind in the suggest catalog, a form mid-edit) reads the plain limits.default, as
 * the schema refuses it before it runs.
 */
export function proposalJudgedBlindRoundsDefault(doc: unknown, given?: ProposalBlindRoundsLimits): number | null {
  const limits = limitsOr(given);
  const hours = fieldOf(fieldOf(doc, 'competition'), 'duration_hours');
  if (typeof hours !== 'number') return limits.default;
  const n = proposalBlindRoundsDefaultFor(hours, limits);
  return n === 0 ? null : n;
}

/** The blind rounds a proposal names (blind_rounds, a whole number 0 to limits.max, make.fun's most unless handed the server's), or undefined when it names none. */
export function proposalNamedBlindRounds(doc: unknown, limits?: Pick<ProposalBlindRoundsLimits, 'max'>): number | undefined {
  const n = fieldOf(doc, 'blind_rounds');
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= limitsOr(limits).max ? n : undefined;
}

/**
 * The blind rounds a proposal runs with as written under `limits`: its named count (0 off, null; N rounds, N), else its
 * default (proposalBlindRoundsDefault: undefined on a Something-else brief until its setup).
 */
export function proposalBlindRoundsOf(doc: unknown, given?: ProposalBlindRoundsLimits): number | null | undefined {
  const limits = limitsOr(given);
  const named = proposalNamedBlindRounds(doc, limits);
  if (named !== undefined) return named === 0 ? null : named;
  return proposalBlindRoundsDefault(doc, limits);
}

/**
 * The blind rounds a stored proposal names: any whole count 0 to PROPOSAL_BLIND_ROUNDS_STORED_MAX, past the server's
 * most too (written before the cap was 8, or under a most since lowered); undefined when it names none or one neither
 * reads. What a funded proposal's draft row takes (server/proposals/blind-rounds.ts sponsorBlindRoundsOf), never a
 * check of a new count.
 */
export function proposalStoredBlindRounds(doc: unknown): number | undefined {
  const n = fieldOf(doc, 'blind_rounds');
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= PROPOSAL_BLIND_ROUNDS_STORED_MAX ? n : undefined;
}

/**
 * A stored proposal document as a funded path parses it (server/proposals/checks.ts schemaCheck's `stored`, at the
 * limits it reads stored documents by, `held`: make.fun's defaults unless handed them): one naming blind_rounds past
 * held.max, up to PROPOSAL_BLIND_ROUNDS_STORED_MAX (written before the cap was 8, or under a most since lowered), that
 * runs as it did then (its rounds held.min_minutes of entries apart, none beside placements live) is parsed as naming
 * held.max (`doc`, a shallow copy, every other field held as ever) and its own count put back on what parses (`kept`);
 * any other document is parsed as written (`kept` undefined), so a count that never ran is refused in the field's words.
 * blind_rounds is never composed, so the bundle and its rules_sha256 are the same either way. A document written while
 * a sponsor could name its challenge window (the escrow block, until 2026-11-23) is read without it (`doc`, a shallow
 * copy): that deposit's window is on its accounts and is never derived again (ESCROW_BLOCK_REFUSAL refuses the block on
 * every document read as written).
 */
export function proposalAsStored(raw: unknown, given?: ProposalBlindRoundsHeld): { doc: unknown; kept: number | undefined } {
  const held = limitsOr(given);
  const doc = withoutEscrowBlock(raw);
  const n = proposalStoredBlindRounds(doc);
  if (n === undefined || n <= held.max) return { doc, kept: undefined };
  const competition = fieldOf(doc, 'competition');
  const hours = fieldOf(competition, 'duration_hours');
  const spaced = typeof hours === 'number' && Number.isFinite(hours) && hours > 0 && Math.floor(Math.round(hours * 3_600_000) / (held.min_minutes * 60_000)) >= n;
  if (!spaced || fieldOf(competition, 'placements') === 'live') return { doc, kept: undefined };
  return { doc: { ...(doc as Record<string, unknown>), blind_rounds: held.max }, kept: n };
}

/** `raw` without its escrow block (a shallow copy) when it is a plain object naming one; else `raw` itself. */
function withoutEscrowBlock(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, 'escrow')) return raw;
  const { escrow: _escrow, ...rest } = raw as Record<string, unknown>;
  return rest;
}

/**
 * The creator share a proposal's entry fee starts with where it names a fee and no share, percent: the fund panel's own
 * starting share and the suggest service's (server/proposals/suggest/assemble.ts), held to the terms' bounds
 * (limits.min_creator_percent to limits.max_creator_percent). The owner (2026-11-22): "for paid, we should default it to
 * their share being 25% instead of 50%."
 */
export const PROPOSAL_CREATOR_PERCENT_DEFAULT = 25;

export const ProposalPrize = z.strictObject({
  /** Optional, and only placement: an escrowed competition pays placement prizes alone. */
  kind: z.literal('placement', { error: 'a sponsored competition pays placement prizes only' }).optional(),
  place: z.int().min(1).max(PROPOSAL_CAPS.prizes),
  /** Above $0 in whole cents; the pool's floor (DEFAULT_SPONSOR_MIN_PRIZE_USD unless a server sets its own) and a server's ceiling are proposal_prizes'. */
  amount_usd: UsdAmount.refine((n) => n > 0, 'a prize pays more than zero'),
  title: text(PROPOSAL_CAPS.prize_title).nullable().default(null),
});

/** The choices of a brief's code kind, for a refusal: the kinds offered now, or none. */
const KIND_CHOICES = `one of ${orList(OFFERED_CODE_KIND_IDS)}, or leave kind out for Something else`;

/** A code kind a brief may name: one the catalogue offers now (contracts/code-kinds.ts). */
const ProposalCodeKind = z
  .enum(CODE_KIND_IDS, { error: (iss) => `${JSON.stringify(iss.input)} is not a code kind: ${KIND_CHOICES}` })
  .refine((id) => CODE_KINDS[id].offered, { error: (iss) => `${String(iss.input)} is not offered yet: ${KIND_CHOICES}` });

/**
 * A judged brief (scoring.custom.judged): a judged text or image bounty's judge as the suggest service wrote it, the
 * medium, the judge's persona (prompt) and the medium's caps, each inside the bound a judged-artifact choice holds it to
 * and absent for its default; the other medium's caps are refused. Once funded, make.fun prepares the judge's anchors
 * and ladder from it and attaches the judged-artifact choice it names. Words and numbers only, never an anchor.
 */
export const ProposalJudgedBrief = z
  .strictObject(judgedMediaFields, {
    error: (iss) =>
      iss.code === 'unrecognized_keys' && iss.keys !== undefined
        ? `${iss.keys.join(', ')}: ${iss.keys.some(isUploadKey) ? UPLOADS_REFUSED : `not a field of a judged brief (media, prompt, ${JUDGED_CAP_KEYS.join(', ')})`}`
        : undefined,
  })
  .superRefine(refuseOtherMediumCaps);

/**
 * A custom scoring brief: when no house template fits, the sponsor says in plain words what wins and
 * how to judge it (and, optionally, worked examples), and requests the make.fun team's setup (POST
 * /api/sponsor/proposals/:id/request-setup). The team attaches a house template and its knobs (the
 * harness), or returns the proposal with a note; no deposit is taken before then, since the escrow
 * commits the rules' digest. Words only: never a scorer, reference data or input data.
 *
 * A code bounty names its code kind (contracts/code-kinds.ts: what wins once make.fun writes the
 * hidden tests from the brief) and the runtimes an entry may use; a kind that compares entries in one
 * language (Smallest code, Fastest) takes exactly one. No kind is Something else: the team reads the
 * brief alone. A judged text or image bounty carries its judge instead (judged, ProposalJudgedBrief),
 * never beside a code kind or runtimes.
 */
export const ProposalCustomScoring = z
  .strictObject(
    {
      /** What wins and how to judge it, in plain words; for a code kind, what the program must do and what it reads and writes. */
      brief: z
        .string()
        .trim()
        .min(SCORING_BRIEF_CAPS.brief_min, `say what wins and how to judge it, in at least ${SCORING_BRIEF_CAPS.brief_min} characters`)
        .max(SCORING_BRIEF_CAPS.brief),
      /** Worked examples of entries and how they would rank, in plain words. */
      examples: z.string().trim().max(SCORING_BRIEF_CAPS.examples).nullable().default(null),
      /** The code kind that picks the winner (contracts/code-kinds.ts), one offered now. Absent: Something else. */
      kind: ProposalCodeKind.optional(),
      /**
       * The runtimes an entry may use, each once: exactly one for a kind that compares entries in one
       * language. Absent: every runtime the house runs (refused for a one-language kind).
       */
      runtimes: z
        .array(Runtime)
        .refine((rs) => new Set(rs).size === rs.length, 'a runtime is listed once')
        .optional(),
      /** A judged text or image bounty's judge (ProposalJudgedBrief), never beside kind or runtimes. Absent: none, and no key appears. */
      judged: ProposalJudgedBrief.optional(),
    },
    {
      error: (iss) =>
        iss.code === 'unrecognized_keys' ? `${iss.keys.join(', ')}: ${iss.keys.some(isUploadKey) ? UPLOADS_REFUSED : 'not a field of a custom scoring brief (brief, examples, kind, runtimes and judged)'}` : undefined,
    },
  )
  .superRefine((c, ctx) => {
    if (c.judged !== undefined) {
      // A judged brief is judged by a model, not a code bounty: no kind picks its winner and no runtime runs its entries.
      for (const key of ['kind', 'runtimes'] as const) {
        if (c[key] === undefined) continue;
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is a code bounty's, and judged a judged text or image bounty's: a brief is one or the other, so drop ${key}`, input: c[key] });
      }
      return;
    }
    // zod skips this when a field is the wrong type, so an unknown kind never reaches CODE_KINDS; guarded all the same.
    if (c.kind !== undefined && !isCodeKindId(c.kind)) return;
    if (c.kind === undefined ? c.runtimes?.length !== 0 : codeKindRuntimesFit(c.kind, c.runtimes)) return;
    const kind = c.kind === undefined ? undefined : CODE_KINDS[c.kind];
    const n = c.runtimes?.length ?? 0;
    const message =
      kind?.runtimes === 'one'
        ? `${kind.id} (${kind.label}) compares every entry in one language: name exactly one runtime (${orList(RUNTIMES)})${n === 0 ? '' : `, not ${n}`}`
        : 'at least one runtime, or leave runtimes out for every one the house runs';
    ctx.addIssue({ code: 'custom', path: ['runtimes'], message, input: c.runtimes });
  });

/** The scoring block of a proposal no house template fits: its custom brief. */
export const ProposalScoring = z.strictObject(
  { custom: ProposalCustomScoring },
  { error: (iss) => (iss.code === 'unrecognized_keys' ? `${iss.keys.join(', ')}: scoring takes a custom brief only (scoring.custom); a house template is named in harness instead` : undefined) },
);

/** Root keys the house template sets, refused with why. */
const TEMPLATE_SETS = new Set(['leaderboard', 'limits', 'phases']);

function rootKeysRefusal(keys: string[], scoredBy: 'harness' | 'scoring'): string {
  if (keys.includes('escrow')) {
    const others = keys.filter((key) => key !== 'escrow');
    return others.length === 0 ? `escrow: ${ESCROW_BLOCK_REFUSAL}` : `escrow: ${ESCROW_BLOCK_REFUSAL}; ${rootKeysRefusal(others, scoredBy)}`;
  }
  const list = keys.join(', ');
  if (keys.some(isUploadKey)) return `${list}: ${UPLOADS_REFUSED}`;
  if (keys.some((key) => TEMPLATE_SETS.has(key))) return `${list}: not a field a sponsor writes (the house template sets the harness block, the leaderboard, the phases' data and the sandbox limits)`;
  if (keys.includes(scoredBy === 'harness' ? 'scoring' : 'harness'))
    return `${list}: a proposal is scored by a house template (harness) or, when none fits, by a custom brief the make.fun team sets up (scoring.custom), not both: drop one`;
  return `${list}: not a field a sponsor writes`;
}

const proposalFields = {
  version: z.literal(SPONSOR_PROPOSAL_VERSION),
  competition: ProposalCompetition,
  final: ProposalFinal,
  submission_rule: ProposalSubmissionRule.default(() => ({ max_per_day: 5, max_total: null, strategy_note_required: false })),
  prizes: z.array(ProposalPrize).min(1).max(PROPOSAL_CAPS.prizes),
  /**
   * The build allowance, in USD on top of the prizes: on a Cheapest to build bounty (code-cheapest) alone
   * (allowanceIssue), it pays for the entrants' metered build keys (the composed bundle's build meter,
   * contracts/competition.ts BuildMeter). Not a prize, so no part of the escrow's pot. Its bounds are the
   * proposal checks' (see the header). Absent: none, and no key appears, so a proposal without it parses
   * as it always did.
   */
  allowance_usd: UsdAmount.optional(),
  /**
   * The entry fee, in USD (the composed bundle's entry_fee.amount_usd, contracts/competition.ts EntryFee): what
   * each account pays once to enter, into the bounty's escrow vault, where it joins the pot, less make.fun's house
   * share (server/config.ts sponsorFeeHousePercent, frozen at compose as entry_fee.fund_percent). Above 0, in whole
   * cents (EntryFeeUsd). Absent: entry is free, and no key appears, so a proposal without it parses, composes
   * and hashes as it always did. Refused on social-post, whose entrants post for the sponsor (socialEntryFeeIssue).
   */
  entry_fee_usd: EntryFeeUsd.optional(),
  /**
   * The percent of each entry fee the sponsor keeps as the bounty's creator, an integer 1..100 (the composed
   * bundle's entry_fee.creator.percent, contracts/competition.ts EntryFeeCreator): paid at payment to its funding
   * wallet, less make.fun's cut of that share, which goes to the make.fun fund; the rest, less any house share, joins
   * the pot. Needs entry_fee_usd; its bounds and the cut are the fee model's (contracts/entry-fee-fund.ts
   * entryFeeRuleOf, the proposal checks' feeRuleOfCaps): under 'total' (the default) from the house percent to
   * sponsorCreatorMaxPercent, the cut the least that keeps the house percent of each fee; under 'beside' from 1 to the
   * smaller of sponsorCreatorMaxPercent and 100 less the house share, the cut sponsorCreatorCutPercent. Absent: no creator share, and no key appears, so a proposal without it parses as it always did.
   */
  creator_percent: z.int().min(1).max(100).optional(),
  /**
   * The blind rounds the bounty runs with (ProposalBlindRounds, the absolute shape: 0 off, 1 to
   * PROPOSAL_BLIND_ROUNDS_STORED_MAX rounds, never beside competition.placements 'live'); a new proposal and an amendment
   * are held to the server's most and spacing too (proposalSchemasOf: 1 to limits.max_blind_rounds rounds, each at least
   * limits.min_blind_round_minutes of entries after the one before, proposalBlindRoundsIssues; on a judged kind never 0,
   * nor absent beside placements live, while limits.min_blind_rounds is 1 or more: private judging). A runtime setting of the
   * draft competition row (competition.blind_rounds: server/proposals/blind-rounds.ts sponsorBlindRoundsOf), never
   * composed, so the bundle and its rules_sha256 are the same with it or without. Absent: make.fun's default
   * (proposalBlindRoundsDefault: limits.default_blind_rounds on a judged kind, held to what its entries space
   * limits.min_blind_round_minutes apart), and no key appears, so a proposal without it parses as it always did.
   */
  blind_rounds: ProposalBlindRounds.optional(),
};

/** What proposalCodeKind reads of a proposal: its harness (a template choice), or its custom brief. */
export type CodeKindBearing = { harness: { template: string; objective?: unknown } } | { scoring: { custom: { kind?: unknown } } };

/**
 * The code kind a proposal names (contracts/code-kinds.ts): its harness's objective on code-tests, its
 * custom brief's kind; undefined on any other template, or a brief that names none (Something else).
 */
export function proposalCodeKind(p: CodeKindBearing): CodeKindIdT | undefined {
  const kind = 'harness' in p ? (p.harness.template === CODE_TESTS_ID ? p.harness.objective : undefined) : p.scoring.custom.kind;
  return isCodeKindId(kind) ? kind : undefined;
}

/** Whether a proposal may carry a build allowance (allowance_usd): its code kind is code-cheapest. */
export function takesBuildAllowance(p: CodeKindBearing): boolean {
  return proposalCodeKind(p) === BUILD_ALLOWANCE_CODE_KIND;
}

/** The refusal of a build allowance on a proposal of another kind (allowance_usd present, takesBuildAllowance false), naming the field; null when it holds. */
export function allowanceIssue(p: CodeKindBearing & { allowance_usd?: number }): string | null {
  if (p.allowance_usd === undefined || takesBuildAllowance(p)) return null;
  const kind = proposalCodeKind(p);
  const named =
    kind !== undefined
      ? `its code kind is ${kind} (${CODE_KINDS[kind].label})`
      : 'harness' in p
        ? `it is scored by the house template ${p.harness.template}`
        : 'its brief names no code kind (Something else)';
  return `allowance_usd is the build allowance of a ${ALLOWANCE_KIND_WORDS} bounty alone, which pays for its entrants' metered build keys, and ${named}: drop allowance_usd`;
}

/** Refuses a build allowance on any kind but code-cheapest (allowanceIssue), at allowance_usd. */
function refuseAllowance(p: CodeKindBearing & { allowance_usd?: number }, ctx: z.RefinementCtx): void {
  const message = allowanceIssue(p);
  if (message !== null) ctx.addIssue({ code: 'custom', path: ['allowance_usd'], message, input: p.allowance_usd });
}

/**
 * The refusal of an entry fee on a social-post bounty (entry_fee_usd present on harness.template social-post), naming the
 * field; null when it holds. Its entrants post for the sponsor, so it charges none: a fee would make them pay to promote
 * the sponsor's subject (the house's own social contests charge none either).
 */
export function socialEntryFeeIssue(p: { harness?: { template: string }; entry_fee_usd?: number }): string | null {
  if (p.entry_fee_usd === undefined || p.harness?.template !== SOCIAL_POST_ID) return null;
  return `entry_fee_usd: a ${SOCIAL_POST_ID} bounty takes no entry fee, since its entrants post for the sponsor and a fee would charge them to promote it: drop entry_fee_usd`;
}

/** Refuses an entry fee on a social-post bounty (socialEntryFeeIssue), at entry_fee_usd. */
function refuseSocialEntryFee(p: { harness?: { template: string }; entry_fee_usd?: number }, ctx: z.RefinementCtx): void {
  const message = socialEntryFeeIssue(p);
  if (message !== null) ctx.addIssue({ code: 'custom', path: ['entry_fee_usd'], message: message.slice('entry_fee_usd: '.length), input: p.entry_fee_usd });
}

/** The code kind whose bounty pays at most PAYOUT_MAX_PLACES: Fastest, whose timing heat is sized on those places (checks.ts PACK_HEAT_FIELD). */
export const PLACES_CAPPED_CODE_KIND = 'code-fastest' as const satisfies CodeKindIdT;

/** The kind a proposal names for its places: its code kind (the code-tests objective, or the brief's kind), undefined when none is named. */
function placesCodeKindOf(p: unknown): unknown {
  const harness = fieldOf(p, 'harness');
  return harness !== undefined ? fieldOf(harness, 'objective') : fieldOf(fieldOf(fieldOf(p, 'scoring'), 'custom'), 'kind');
}

/**
 * The places cap a proposal's kind falls under (contracts/payout-shapes.ts PlacesKind): 'capped' for a judged kind (the
 * judged-artifact template, or a judged brief), for code-fastest, and for a Something else brief (no kind yet, which the
 * make.fun team may set up as either); 'measured' for every other measured kind (the trading boards and the other code
 * kinds). Its web mirror is src/components/sponsor/form.ts placesKindOfDoc, held equal by tests/unit/payout-shapes.test.ts.
 */
export function placesKindOf(p: unknown): PlacesKind {
  if (proposalJudgedKind(p)) return 'capped';
  const harness = fieldOf(p, 'harness');
  if (harness !== undefined && fieldOf(harness, 'template') !== CODE_TESTS_ID) return 'measured';
  const kind = placesCodeKindOf(p);
  return kind === undefined || kind === PLACES_CAPPED_CODE_KIND ? 'capped' : 'measured';
}

/** The kind a places refusal names (refusePlacesCap): a judged bounty, a Fastest bounty, a Something else bounty, or this bounty. */
function placesWordsOf(p: unknown): string {
  if (proposalJudgedKind(p)) return 'a judged bounty';
  const kind = placesCodeKindOf(p);
  if (kind === PLACES_CAPPED_CODE_KIND) return 'a Fastest bounty';
  return kind === undefined && placesKindOf(p) === 'capped' ? 'a bounty of Something else' : 'this bounty';
}

/**
 * The places a proposal names, held to its kind's most (placesKindOf, placesMostOf): a judged bounty, a code-fastest one
 * or a Something else brief pays at most PAYOUT_MAX_PLACES, every other measured kind at most PAYOUT_MEASURED_MAX_PLACES.
 * Refused at prizes, naming the count and the most; the schema's own cap (PROPOSAL_CAPS.prizes) holds every kind to the
 * largest, so this is the one place a capped kind's count is refused.
 */
function refusePlacesCap(p: unknown, ctx: z.RefinementCtx): void {
  const prizes = fieldOf(p, 'prizes');
  if (!Array.isArray(prizes)) return;
  const most = placesMostOf(placesKindOf(p));
  const named = Math.max(prizes.length, ...prizes.map((z) => fieldOf(z, 'place')).filter((n): n is number => typeof n === 'number'));
  if (named <= most) return;
  ctx.addIssue({ code: 'custom', path: ['prizes'], message: `prizes name ${named} places, and ${placesWordsOf(p)} pays at most ${most}: drop the places past ${most}`, input: prizes });
}

/** A proposal string carrying a make.fun API key: where it stands, and the sentence that refuses it. */
export interface ProposalApiKeyIssue {
  path: (string | number)[];
  message: string;
}

/**
 * The first string of a proposal document (as written or as parsed: objects and arrays walked in order, keys
 * left to the strict schemas) that carries a make.fun API key (holdsMakefunApiKey), or null. Credentials only:
 * no other content is judged here.
 */
export function proposalApiKeyIssue(raw: unknown): ProposalApiKeyIssue | null {
  const walk = (v: unknown, path: (string | number)[]): ProposalApiKeyIssue | null => {
    if (typeof v === 'string') {
      if (!holdsMakefunApiKey(v)) return null;
      return {
        path,
        message: `this carries ${MAKEFUN_API_KEY_WHAT}: a proposal is read by the make.fun team and, once approved, by everyone, and whoever reads the key acts as your account. Take it out`,
      };
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const found = walk(v[i], [...path, i]);
        if (found !== null) return found;
      }
      return null;
    }
    if (typeof v === 'object' && v !== null) {
      for (const [key, x] of Object.entries(v)) {
        const found = walk(x, [...path, key]);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(raw, []);
}

/** Refuses a proposal any string of which carries a make.fun API key (proposalApiKeyIssue), at that string's path. */
function refuseApiKeys(p: unknown, ctx: z.RefinementCtx): void {
  const issue = proposalApiKeyIssue(p);
  if (issue !== null) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
}

/**
 * Both proposal schemas with blind_rounds held to `held` (blindRoundsFieldOf held.max, its spacing held.min_minutes:
 * blindRoundsRefusalOf), or, `held` null, in its absolute shape alone (0 to PROPOSAL_BLIND_ROUNDS_STORED_MAX, none
 * beside placements live). Every other field is the same in each.
 */
function proposalSchemasBuilt(held: ProposalBlindRoundsHeld | null) {
  const fields = held === null ? proposalFields : { ...proposalFields, blind_rounds: blindRoundsFieldOf(held.max).optional() };
  const refuseBlindRounds = blindRoundsRefusalOf(held);
  return {
    sponsor: z
      .strictObject({ ...fields, harness: ProposalHarness }, { error: (iss) => (iss.code === 'unrecognized_keys' ? rootKeysRefusal(iss.keys, 'harness') : undefined) })
      .superRefine(refuseAllowance)
      .superRefine(refuseSocialEntryFee)
      .superRefine(refuseBlindRounds)
      .superRefine(refusePlacesCap)
      .superRefine(refuseApiKeys),
    custom: z
      .strictObject({ ...fields, scoring: ProposalScoring }, { error: (iss) => (iss.code === 'unrecognized_keys' ? rootKeysRefusal(iss.keys, 'scoring') : undefined) })
      .superRefine(refuseAllowance)
      .superRefine(refuseBlindRounds)
      .superRefine(refusePlacesCap)
      .superRefine(refuseApiKeys),
  };
}

const ABSOLUTE_SCHEMAS = proposalSchemasBuilt(null);

/**
 * A proposal on a house template: the only kind composed and checked in full, and deposited with its rules named. Its
 * blind_rounds in the absolute shape (ProposalBlindRounds), as a stored document reads on any server; proposal_schema
 * holds a new one to the server's limits (proposalSchemasOf).
 */
export const SponsorProposal = ABSOLUTE_SCHEMAS.sponsor;

/**
 * A proposal no house template fits: every field as written, its scoring a custom brief instead of
 * a harness. It is checked but for the template's checks and funds first: never composed, it
 * deposits with its rules unset (rules_sha256 all zeros, no bundle), the landing asking the make.fun
 * team's setup (the proposal's setup record, the brief kept on it), and it is in review while the
 * team sets how it is scored. It becomes a SponsorProposal when the team attaches the harness, its
 * rules set on chain at approval (set_proposal_rules). A request made before funding came first
 * (status setup_requested) waits for the team's setup, then deposits as a SponsorProposal. Its blind_rounds as
 * SponsorProposal's.
 */
export const CustomScoringProposal = ABSOLUTE_SCHEMAS.custom;

/** The schemas built for each blind rounds limit asked (proposalSchemasOf): a server asks one, its tests a few. */
const HELD_SCHEMAS = new Map<string, typeof ABSOLUTE_SCHEMAS>();

/**
 * SponsorProposal and CustomScoringProposal with blind_rounds held to a server's limits (make.fun's settings: the most
 * rounds, `held.max`, and their spacing, `held.min_minutes`), as proposal_schema parses a new proposal and an amendment
 * (server/proposals/checks.ts schemaCheck): a count past the most refused at blind_rounds in the field's words naming it,
 * one closer than the spacing naming the most the entries take (proposalBlindRoundsIssues), in the order and words a
 * schema built on them always gave; on a judged kind, the public choice refused while `held.min` (absent: make.fun's 1)
 * is 1 or more. Built once per limits.
 */
export function proposalSchemasOf(held: ProposalBlindRoundsHeld): { sponsor: typeof SponsorProposal; custom: typeof CustomScoringProposal } {
  const min = blindRoundsLeastOf(held);
  const key = `${held.max}:${held.min_minutes}:${min}`;
  let built = HELD_SCHEMAS.get(key);
  if (built === undefined) {
    built = proposalSchemasBuilt({ max: held.max, min_minutes: held.min_minutes, min });
    HELD_SCHEMAS.set(key, built);
  }
  return built;
}

/**
 * Whether a stored or submitted proposal is written with a custom scoring brief (a `scoring` key and
 * no `harness`): such a document parses as CustomScoringProposal, any other as SponsorProposal.
 */
export function isCustomScoringDocument(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'scoring' in raw && !('harness' in raw);
}

export type SponsorProposalT = z.infer<typeof SponsorProposal>;
export type SponsorProposalInput = z.input<typeof SponsorProposal>;
export type CustomScoringProposalT = z.infer<typeof CustomScoringProposal>;
export type ProposalCustomScoringT = z.infer<typeof ProposalCustomScoring>;
export type ProposalJudgedBriefT = z.infer<typeof ProposalJudgedBrief>;
export type ProposalPrizeT = z.infer<typeof ProposalPrize>;
export type ProposalHarnessT = z.infer<typeof ProposalHarness>;

// The registry's hand-written choice type is the contract's parse: a drift fails the typecheck.
type Same<A, B> = [A, B] extends [B, A] ? true : false;
type Holds<T extends true> = T;
type _ProposalHarnessIsRegistryChoice = Holds<Same<ProposalHarnessT, TemplateChoiceT>>;
// The code kinds catalogue imports nothing of contracts/ (./code-kinds.ts), so it is held to the
// competition contract here: a kind's submission rule is a Codabench rule.
type _CodeKindSubmissionIsARule = Holds<CodeKindT['submission'] extends (typeof CODABENCH_SUBMISSION_RULES)[number] ? true : false>;
