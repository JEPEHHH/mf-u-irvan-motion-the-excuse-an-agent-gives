// A screened bundle's sealed dev contender rounds (agent-fun/judge-contender/v1): top dev entries judged against one
// another by one judge (the bundle's named one, or a contend chain's overflow judge fixed at round 0), one immutable
// record per round chained by `prev`. Pure: no clock and no I/O, plain numbers, Fixed9 strings and member sha256s that the caller copies in from the bundle; only + - * / and Math.sqrt
// (as grader/judge-heat.ts judgeFit, grader/judge-ladder.ts and grader/judge-race.ts), every sum in sha256 member order,
// games folded into whole-twentieth counts first, logs from judgeRaceLog: the same bits on every host, for any order of
// the games. Nothing here reads a contest's score: a screened chain's verdicts only pick a final's shortlist and first
// pairings, and a contend chain's (ProgramJudgeContend) ratings only go on the dev board (server/grading/contend-board.ts),
// never a final score.
//
//   the seed         judgeContenderSeed(phase seed) = sha256(utf8(JUDGE_CONTENDER_FORMAT) || 0x00 || utf8(the dev phase
//                    seed)), lowercase hex: judge-heat's seed in this format's domain
//   the setup        JudgeContenderSetup: the judge as on a heat (format, phase seed, seed, agent, judge_sha256, media,
//                    house_text, artifact, invalid_share_max; the agent names one model, and a round is judged whole by
//                    one judge: the chain's, judgeContenderJudgeOf. On a screened chain, and a contend chain fixed on the
//                    bundle's named judge, there is no `judges` and that judge is the agent's model on its own door; a
//                    contend chain fixed at round 0 on the judge-overflow switch's judge (the job's: the overflow moved
//                    all of the contest's dev judging to it) lists it as `judges`, one judge `via` overflow on OpenRouter,
//                    its endpoints pinned, and every round after carries it unchanged); the ladder (its digests, every house
//                    member's fixed strength and the judge anchors among them, each in sha256 order, and phi); the design
//                    (games: the most contender games a member plays, line_places M, z, phi_margin, epsilon; and on a
//                    contend chain its band); the round
//                    (0 first) and `prev`, round - 1's record sha256 (null at round 0); `select` (line_micro: the M-th best
//                    dev interval_low_micro, Force_Last applied, or null while fewer than M are rated; top_member: the
//                    ladder member of highest fixed strength, ties by sha256); `members`, only those entering the chain
//                    or changed this round, in sha256 order, each its artifact, bytes, entries, ladder record and that
//                    record's games from the member's own side, in record order (its snapshot); `players`, this round's
//                    contenders in sha256 order, each a member of the chain so far. A member is never a house member
//   the judge view   (a dossier judge's, optional) a round planned since the view (grader/judge-heat.ts judge_view,
//                    server/judging/dossier-view.ts dossier-view/v1) sends each artifact its calls carry as its judge
//                    view: `judge_view` names the policy and each of those artifacts' sha256 to its view blob's (every
//                    one the calls carry, nothing else, each a player), its house_text framing entries in
//                    JUDGE_HOUSE_TEXT_DOSSIER_VIEW (judgeContenderSetup's `view`). The policy is one of the chain's
//                    judge constants beside its house text, so a chain begun on whole dossiers sends them whole to its
//                    end, and one begun on views sends views. A round naming none is the bytes it was
//   the record       JudgeContenderRecord: the setup plus judge-heat's calls (stage `race`, round the record's, no
//                    `judge`), games, totals, invalid_calls and optional spares, under judge-heat's rules for each
//   the fold         judgeContenderFold(prev fold | null, record): each member's latest snapshot, every contender game in
//                    chain order and each member's count, the round and the head sha256. A record whose round is not
//                    prev + 1, whose `prev` is not the head, whose judge, ladder or design moved, or whose player is no
//                    member breaks the chain. judgeContenderHold holds a record against the fold first
//   the fit          judgeContenderStrengths: Bradley-Terry by minorize-maximize over the free members (every chain
//                    member), the house members held at their ladder strengths, over the contender games and each
//                    member's latest ladder games: W_i = (10 + its twentieths) / 20 (judgeFit's virtual draw against
//                    strength 1, counted in whole twentieths and divided once), p_i <- W_i / (1/(p_i+1) + sum_j
//                    c_ij/(p_i+p_j)) for the free members at once from the last iterate, JUDGE_BT_ITERATIONS times from
//                    p = 1, opponents in sha256 order in flat arrays; I_i = p_i/(p_i+1)^2 + sum_j c_ij p_i p_j/(p_i+p_j)^2,
//                    judgeRaceStrengths' information. O(iterations x (members + pairs))
//   the phi          the ladder's phi while the contender games are no more than the members who played them (round 0
//                    and early rounds: judgeHeatDispersion has no estimate there and answers 1, far wider than the
//                    ladder's measured phi); once they are more, max(ladder phi, judgeHeatDispersion over the contender
//                    games and the fit of the members that played them)
//   the intervals    the schedule's, a race's own: se = sqrt(phi_margin x phi / I) and lo/hi = judgeRaceLog(p) -+ z se
//                    (judgeRaceIntervals). phi_margin widens only these, which pick the contender line, who is active
//                    and when a player stops (epsilon), as it widens a final race's (grader/judge-race.ts)
//   who plays        judgeContenderPlayers: a candidate plays when its dev interval_high_micro reaches select.line_micro
//                    (every candidate while the line is null), `line`; or when it played the top member at least once
//                    and won every such game (more than 10 of its 20 points), `top_member`. The record holds each player
//                    to it again, its interval high recomputed from its snapshot (judgeLadderScore against the record's
//                    strengths, anchors and phi). A contend chain's (contracts/competition.ts ProgramJudgeContend: its
//                    design names `band`, its select a null line and `band_edge`) are judgeContenderBand's instead: the
//                    top `band` candidates by house-only dev win rate, then interval high, highest first, then the
//                    lowest sha256, `band`, and no other path; band_edge the band-th of them, null while the candidates
//                    are no more than the band. The record holds them to it again: no more players than the band, and
//                    with an edge exactly the band, the edge a player whose snapshot gives its numbers, none ranked below
//                    it, each player's rate and high recomputed from its snapshot as above. judgeContenderPlayerIssues
//                    weighs it before a call is spent
//   the schedule     judgeContenderSchedule(fold, setup): the contender line is the M-th best lo among the players (none
//                    under M players). Active: a player with fewer than `games` contender games, a half-width above
//                    epsilon and hi >= the line (when there is one); and every player with no contender game yet,
//                    whatever its interval (a newcomer's interval is its ladder record's alone, and a low top rung holds
//                    every strong one under a line drawn among players the contender games rated: were it never active,
//                    a round of such players alone would be empty, never recorded, and the chain would stop admitting
//                    anyone); ranked by p then sha256, its room games - its games so far. Candidates: the players with games left, each capped at games - its games so far (a hard
//                    cap, never passed). Ties: judgeRaceActive's over the players. Pairs: judgeRacePairs at epoch_calls 2
//                    (no padding: one chosen game per active player), each pair's first slot order judgeSlotOrder(seed,
//                    `race`, round, a, b), then the other. Under two candidates, or with no active player, the round is
//                    empty, and an empty round is never recorded
//   the ratings      judgeContenderRatings: each member with a contender game, its p as Fixed9, its log-scale se as
//                    Fixed9, and E, se_E = d se and E -+ JUDGE_Z90 se_E clamped, over the judge anchors
//                    (judgeLadderScore's formulas), in millionths, and its contender games. The se is a ladder
//                    rating's, as the screen reads one (grader/judge-screen-inputs.ts): sqrt(phi) / sqrt(I), the phi
//                    above and no phi_margin, so a contender line and a ladder line are drawn on one convention and
//                    judgeScreen applies its z to both
//   the snapshot     judgeContenderSnapshotOf(a v3 provisional record that holds): its subject and every game it played,
//                    scrutiny included, from its own side in record order
//
// It names a new harness_version (grader/version.ts sums every grader/ source); no record format before it moves, and
// grader/judge-heat.ts parseJudgeHeatRecord refuses this format, as parseJudgeContenderRecord refuses a heat's. The
// newcomer rule (the schedule's every player with no contender game active) moved the schedule a record is held to
// within this format: a chain recorded before it would not hold against it, and none was (no shipped bundle names
// `screened`). The contend chain's keys (design.band, select.band_edge, judges) are optional and absent on a screened
// chain, so a screened record's bytes, sha256 and checks are what they were; `judges` is absent on a contend chain on
// the bundle's named judge too.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BundlePath,
  JudgeAgent,
  namedJudgeAgent,
  PROGRAM_JUDGE_CONTEND_MAX_BAND,
  PROGRAM_JUDGE_CONTEND_MIN_BAND,
  PROGRAM_JUDGE_MEDIA,
  PROGRAM_JUDGE_SCREENED_MAX_Z,
  type ProgramJudgeT,
} from "../contracts/competition.ts";
import {
  Fixed9,
  FIXED9_SCALE,
  parseFixed9,
  Sha256Hex,
  toFixed9,
  U64,
} from "../contracts/primitives.ts";
import { JUDGE_MICRO } from "../contracts/score.ts";
import { ScrapeEntryId } from "../contracts/scrape.ts";
import {
  JudgeDoorRefusal,
  JudgeOfHeat,
  type JudgeDoorT,
  type JudgeOfHeatT,
} from "../server/judging/pool.ts";
import {
  canonicalJson,
  compareCodeUnits,
  sha256Hex,
} from "../sim/canonical.ts";
import { JUDGE_HOUSE_TEXT, JUDGE_HOUSE_TEXT_DOSSIER_VIEW } from "./judge-call.ts";
import {
  JUDGE_BT_ITERATIONS,
  JUDGE_GAME_POINTS,
  JUDGE_HEAT_FORMAT_V3,
  JUDGE_HEAT_MAX_SENDS,
  JUDGE_Z90,
  JudgeHeatCall,
  JudgeHeatError,
  JudgeHeatGame,
  JudgeHeatJudgeView,
  JudgeHeatRecord,
  JudgeHeatSpare,
  JudgeHeatTotals,
  JudgeHouseText,
  JudgeLadderStrength,
  judgeGamePoints,
  judgeGameResultOf,
  judgeHeatCallIssues,
  judgeHeatInvalidShareOver,
  judgeHeatJudgesOf,
  judgeHeatRecordIssues,
  judgeHeatSpareIssues,
  judgeSlotOrder,
  judgeHeatDispersion,
  type JudgeHeatCallT,
  type JudgeHeatGameT,
  type JudgeHeatJudgeViewT,
  type JudgeHeatRecordT,
  type JudgeHeatSpareT,
  type JudgeHeatTotalsT,
  type JudgeHouseTextT,
  type JudgeLadderStrengthT,
  type JudgePlannedCallT,
  type JudgeSlotOrderT,
} from "./judge-heat.ts";
import {
  judgeLadderFromFixed9,
  judgeLadderScore,
  judgeLadderToFixed9,
} from "./judge-ladder.ts";
import {
  judgeRaceActive,
  judgeRaceIntervals,
  judgeRaceNumber,
  judgeRacePairs,
  type JudgeRaceActiveT,
  type JudgeRaceIntervalT,
  type JudgeRacePairT,
  type JudgeRaceStrengthT,
} from "./judge-race.ts";
// ---------------------------------------------------------------- constants

/** The contender round record's format, and the seed's domain (the header's seed). */
export const JUDGE_CONTENDER_FORMAT = "agent-fun/judge-contender/v1";
/**
 * The most contender games a member plays (the design's `games`): contracts/competition.ts
 * PROGRAM_JUDGE_CONTENDER_MAX_GAMES's value, held here as a schema bound so a record read from outside plans no more.
 */
export const JUDGE_CONTENDER_MAX_GAMES = 96;
/** A round's number fits judgeSlotOrder's u32. */
const ROUND_MAX = 0xffff_ffff;
/** A Fixed9 number's bound, exclusive: 2^53 billionths, past which a number no longer holds every billionth exactly. */
const FIXED9_NUMBER_MAX = 2n ** 53n;
const HALF = JUDGE_GAME_POINTS / 2;

const whenValid = {
  when: (payload: { issues: readonly unknown[] }): boolean =>
    payload.issues.length === 0,
};

const Share = Fixed9.refine(
  (s) => parseFixed9(s) >= 0n && parseFixed9(s) <= FIXED9_SCALE,
  { message: "a share: at least 0, at most 1", ...whenValid },
);

// ---------------------------------------------------------------- the setup and the record

/**
 * What a contender round rates by (the header's setup): the ladder dir's tree digest and its calibration record's
 * sha256, every house member's fixed strength in sha256 order, the judge anchors among them in sha256 order (E's
 * members), and the calibration's dispersion phi.
 */
export const JudgeContenderLadder = z.strictObject({
  ladder_sha256: Sha256Hex,
  calibration_sha256: Sha256Hex,
  strengths: z.array(JudgeLadderStrength).min(1),
  anchors: z.array(Sha256Hex).min(1),
  dispersion: Fixed9,
});
export type JudgeContenderLadderT = z.infer<typeof JudgeContenderLadder>;

/**
 * The bundle's contender numbers (the header's setup): the most contender games a member plays, the line's places M
 * (judgeShortlistPlaces), and z, phi_margin and epsilon (Fixed9; z above 0 and at most PROGRAM_JUDGE_SCREENED_MAX_Z,
 * phi_margin at least 1, epsilon from 0).
 */
export const JudgeContenderDesign = z.strictObject({
  games: z.int().min(1).max(JUDGE_CONTENDER_MAX_GAMES),
  line_places: z.int().min(1),
  z: Fixed9,
  phi_margin: Fixed9,
  epsilon: Fixed9,
  /**
   * A contend chain's band (contracts/competition.ts ProgramJudgeContend.band; the header's who plays): its players are
   * the field's top `band` by house-only dev win rate. Absent on a screened chain, whose players the line picks.
   */
  band: z
    .int()
    .min(PROGRAM_JUDGE_CONTEND_MIN_BAND)
    .max(PROGRAM_JUDGE_CONTEND_MAX_BAND)
    .optional(),
});
export type JudgeContenderDesignT = z.infer<typeof JudgeContenderDesign>;

/**
 * A contend band's last place (the header's who plays): the band-th candidate in band order (house-only dev win rate,
 * then interval high, highest first, then the lowest sha256), its numbers in millionths.
 */
export const JudgeContenderBandEdge = z.strictObject({
  artifact_sha256: Sha256Hex,
  win_rate_micro: z.int().min(0).max(JUDGE_MICRO),
  interval_high_micro: z.int().min(0).max(JUDGE_MICRO),
});
export type JudgeContenderBandEdgeT = z.infer<typeof JudgeContenderBandEdge>;

/**
 * Who could play this round (the header's who plays): the dev line in millionths (null while fewer than M are rated)
 * and the top house member; on a contend chain (the design names a band) the line is null and `band_edge` the band's
 * last place, null while the field holds no more candidates than the band. Absent on a screened chain.
 */
export const JudgeContenderSelect = z.strictObject({
  line_micro: z.int().min(0).max(JUDGE_MICRO).nullable(),
  top_member: Sha256Hex,
  band_edge: JudgeContenderBandEdge.nullable().optional(),
});
export type JudgeContenderSelectT = z.infer<typeof JudgeContenderSelect>;

/** One game of a member's ladder record, from the member's side: its opponent (a house member) and the member's twentieths. */
export const JudgeContenderLadderGame = z.strictObject({
  b: Sha256Hex,
  a_points: z.int().min(0).max(JUDGE_GAME_POINTS),
});
export type JudgeContenderLadderGameT = z.infer<
  typeof JudgeContenderLadderGame
>;

/**
 * A chain member's snapshot (the header's setup): its artifact and size, the entries whose artifact it is (code-unit
 * order), the v3 ladder record it was rated by and that record's games from the member's side, in record order.
 */
export const JudgeContenderMember = z.strictObject({
  artifact_sha256: Sha256Hex,
  artifact_bytes: z.int().min(0),
  entries: z.array(ScrapeEntryId).min(1),
  ladder_record_sha256: Sha256Hex,
  ladder_games: z.array(JudgeContenderLadderGame),
});
export type JudgeContenderMemberT = z.infer<typeof JudgeContenderMember>;

const setupShape = {
  format: z.literal(JUDGE_CONTENDER_FORMAT),
  /** The dev phase's seed, a u64 decimal. */
  phase_seed: U64,
  /** judgeContenderSeed(phase_seed). */
  seed: Sha256Hex,
  /** The bundle's judge: one named model (the chain's judge on its own door when `judges` is absent). */
  agent: JudgeAgent,
  /**
   * A contend chain's judge when it is not the agent's model (the header's setup): the judge-overflow switch's, fixed at
   * round 0 (one judge, `via` overflow, on OpenRouter, its endpoints pinned), every round after carrying it unchanged.
   * Absent on a screened chain and on a contend chain on the bundle's named judge.
   */
  judges: z.array(JudgeOfHeat).length(1).optional(),
  judge_sha256: Sha256Hex,
  media: z.enum(PROGRAM_JUDGE_MEDIA),
  /** The house text the round's requests are built from (a judge view round's, JUDGE_HOUSE_TEXT_DOSSIER_VIEW). */
  house_text: JudgeHouseText,
  /**
   * A dossier round's judge view (the header's judge view): each artifact its calls carry to the view blob sent in its
   * place. Absent on every round that sends its dossiers whole.
   */
  judge_view: JudgeHeatJudgeView.optional(),
  /** The output file each member's artifact is read from. */
  artifact: BundlePath,
  invalid_share_max: Share,
  ladder: JudgeContenderLadder,
  design: JudgeContenderDesign,
  /** 0 for the chain's first round. */
  round: z.int().min(0).max(ROUND_MAX),
  /** The sha256 of round - 1's record; null at round 0. */
  prev: Sha256Hex.nullable(),
  select: JudgeContenderSelect,
  /** Members entering the chain or changed this round, in sha256 order. */
  members: z.array(JudgeContenderMember),
  /** This round's contenders, in sha256 order, each a member of the chain so far. */
  players: z.array(Sha256Hex),
};

/** A contender round before its calls: what its schedule (judgeContenderSchedule) plans from, with the chain before it. */
export const JudgeContenderSetup = z.strictObject(setupShape);
export type JudgeContenderSetupT = z.infer<typeof JudgeContenderSetup>;

/** A contender round's record (the header's record): canonical JSON, stored as a blob named by its sha256. */
export const JudgeContenderRecord = z.strictObject({
  ...setupShape,
  calls: z.array(JudgeHeatCall),
  games: z.array(JudgeHeatGame),
  totals: JudgeHeatTotals,
  /** The calls with no verdict. */
  invalid_calls: z.int().min(0),
  /** The calls' other sends, ordered by call, then send; absent, never empty, when there are none. */
  spares: z.array(JudgeHeatSpare).min(1).optional(),
});
export type JudgeContenderRecordT = z.infer<typeof JudgeContenderRecord>;

/**
 * The judge's constants of a round: what every round of a chain holds the same, a judge view round's policy among them
 * (absent on a chain that sends its dossiers whole, so such a chain's are the keys they were).
 */
export type JudgeContenderJudgeT = Pick<
  JudgeContenderSetupT,
  | "format"
  | "phase_seed"
  | "seed"
  | "agent"
  | "judges"
  | "judge_sha256"
  | "media"
  | "house_text"
  | "artifact"
  | "invalid_share_max"
> & { judge_view?: JudgeHeatJudgeViewT["policy"] };

function judgeOf(s: JudgeContenderSetupT): JudgeContenderJudgeT {
  return {
    format: s.format,
    phase_seed: s.phase_seed,
    seed: s.seed,
    agent: s.agent,
    ...(s.judges === undefined ? {} : { judges: s.judges }),
    judge_sha256: s.judge_sha256,
    media: s.media,
    house_text: s.house_text,
    artifact: s.artifact,
    invalid_share_max: s.invalid_share_max,
    ...(s.judge_view === undefined ? {} : { judge_view: s.judge_view.policy }),
  };
}

/** The record's canonical JSON and its sha256: the blob it is stored as, and the next round's `prev`. */
export function judgeContenderRecordDigest(record: JudgeContenderRecordT): {
  json: string;
  sha256: string;
} {
  const json = canonicalJson(JudgeContenderRecord.parse(record));
  return { json, sha256: sha256Hex(json) };
}

/** The key a round's kept calls are resumed under: sha256 of the canonical JSON of the format and the setup. */
export function judgeContenderResumeKey(setup: JudgeContenderSetupT): string {
  const parsed = JudgeContenderSetup.parse(setup);
  return sha256Hex(
    canonicalJson({ format: JUDGE_CONTENDER_FORMAT, setup: parsed }),
  );
}

/**
 * The one judge a chain's rounds are judged by (the header's setup): its `judges`' one (the judge-overflow switch's,
 * fixed at round 0), else its agent's named model on its own door (judgeHeatJudgesOf, `via` rules). JudgeHeatError when
 * it lists none and its agent names no one model; JudgeDoorRefusal on masq's spelling of a router model.
 */
export function judgeContenderJudgeOf(
  s: Pick<JudgeContenderSetupT, "agent" | "judges">,
): JudgeOfHeatT {
  return judgeHeatJudgesOf(
    s.judges === undefined ? { agent: s.agent } : { agent: s.agent, judges: s.judges },
  )[0]!;
}

// ---------------------------------------------------------------- the seed and the setup

/** The chain's seed (the header's seed): sha256(utf8(JUDGE_CONTENDER_FORMAT) || 0x00 || utf8(phase seed)), lowercase hex. */
export function judgeContenderSeed(phaseSeed: string): string {
  if (!U64.safeParse(phaseSeed).success)
    throw new RangeError(
      `the phase seed ${JSON.stringify(phaseSeed)} is not a u64 decimal`,
    );
  return createHash("sha256")
    .update(JUDGE_CONTENDER_FORMAT, "utf8")
    .update(Buffer.from([0]))
    .update(phaseSeed, "utf8")
    .digest("hex");
}

/** The ladder member of highest fixed strength (compared exactly, as Fixed9), ties by the lowest sha256. RangeError on none. */
export function judgeContenderTopMember(
  strengths: readonly JudgeLadderStrengthT[],
): string {
  let best: { m: string; v: bigint } | null = null;
  for (const s of strengths) {
    const v = parseFixed9(s.strength);
    if (
      best === null ||
      v > best.v ||
      (v === best.v && compareCodeUnits(s.artifact_sha256, best.m) < 0)
    )
      best = { m: s.artifact_sha256, v };
  }
  if (best === null) throw new RangeError("a ladder has at least one member");
  return best.m;
}

export interface JudgeContenderSetupOptions {
  /** The dev phase's seed, a u64 decimal. */
  phaseSeed: string;
  judge: Pick<
    ProgramJudgeT,
    "agent" | "judge_sha256" | "media" | "artifact" | "invalid_share_max"
  >;
  /**
   * The house text its requests are built from: default JUDGE_HOUSE_TEXT (a live round), JUDGE_HOUSE_TEXT_DOSSIER_VIEW
   * with a `view`; a record's own (a chain's) when given.
   */
  house?: JudgeHouseTextT;
  /**
   * A dossier round's judge view (the header's judge view): the policy and each artifact its calls carry to its view
   * blob. Omitted: its dossiers are sent whole.
   */
  view?: JudgeHeatJudgeViewT;
  /**
   * A contend chain's judge when it is not the agent's named model (the setup's `judges`: the overflow judge it fixed at
   * round 0, carried by every round after); absent, the agent's.
   */
  judges?: readonly JudgeOfHeatT[];
  ladder: JudgeContenderLadderT;
  design: JudgeContenderDesignT;
  round: number;
  prev: string | null;
  /** The dev line (millionths, null while fewer than M are rated); the top member follows from the ladder. Null on a contend chain. */
  lineMicro: number | null;
  /** A contend chain's band edge (judgeContenderBand; null while the field holds no more than the band); absent on a screened chain. */
  bandEdge?: JudgeContenderBandEdgeT | null;
  members: readonly JudgeContenderMemberT[];
  players: readonly string[];
}

/**
 * A round's setup (the header's setup), its seed and top member derived, its members (and each one's entries) and
 * players sorted. JudgeHeatError when it does not hold on its own (the chain's checks are judgeContenderSchedule's and
 * judgeContenderRecordIssues').
 */
export function judgeContenderSetup(
  o: JudgeContenderSetupOptions,
): JudgeContenderSetupT {
  const setup = {
    format: JUDGE_CONTENDER_FORMAT,
    phase_seed: o.phaseSeed,
    seed: judgeContenderSeed(o.phaseSeed),
    agent: o.judge.agent,
    ...(o.judges === undefined ? {} : { judges: o.judges.map((j) => structuredClone(j)) }),
    judge_sha256: o.judge.judge_sha256,
    media: o.judge.media,
    house_text: {
      ...(o.house ??
        (o.view === undefined
          ? JUDGE_HOUSE_TEXT
          : JUDGE_HOUSE_TEXT_DOSSIER_VIEW)),
    },
    ...(o.view === undefined
      ? {}
      : {
          judge_view: { policy: o.view.policy, views: { ...o.view.views } },
        }),
    artifact: o.judge.artifact,
    invalid_share_max: o.judge.invalid_share_max,
    ladder: o.ladder,
    design: o.design,
    round: o.round,
    prev: o.prev,
    select: {
      line_micro: o.lineMicro,
      top_member: judgeContenderTopMember(o.ladder.strengths),
      ...(o.bandEdge === undefined ? {} : { band_edge: o.bandEdge === null ? null : { ...o.bandEdge } }),
    },
    members: [...o.members]
      .map((m) => ({
        ...m,
        entries: [...m.entries].sort(compareCodeUnits),
        ladder_games: m.ladder_games.map((g) => ({
          b: g.b,
          a_points: g.a_points,
        })),
      }))
      .sort((x, y) => compareCodeUnits(x.artifact_sha256, y.artifact_sha256)),
    players: [...o.players].sort(compareCodeUnits),
  };
  const parsed = JudgeContenderSetup.safeParse(setup);
  if (!parsed.success)
    throw new JudgeHeatError(
      `the contender round is not one: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(setup)"}: ${i.message}`)
        .slice(0, 5)
        .join("; ")}`,
    );
  const issues = setupIssuesOf(parsed.data);
  if (issues.length > 0) throw doesNotHold(issues);
  return parsed.data;
}

function doesNotHold(issues: readonly string[]): JudgeHeatError {
  return new JudgeHeatError(
    `the contender round does not hold: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? `; and ${issues.length - 5} more` : ""}`,
  );
}

/** Why a Fixed9 value is not one from `lo` (above it when `above`) to `hi` and below 2^53 billionths, or null. */
function fixed9RangeIssue(
  s: string,
  lo: bigint,
  o: { above?: boolean; hi?: bigint } = {},
): string | null {
  const v = parseFixed9(s);
  if (o.above === true ? v <= lo : v < lo)
    return `${s} is not ${o.above === true ? "above" : "at least"} ${toFixed9(lo)}`;
  if (o.hi !== undefined && v > o.hi) return `${s} is above ${toFixed9(o.hi)}`;
  if (v >= FIXED9_NUMBER_MAX) return `${s} is 2^53 billionths or more`;
  return null;
}

const ascending = (list: readonly string[]): boolean =>
  list.every((x, k) => k === 0 || compareCodeUnits(list[k - 1]!, x) < 0);

/**
 * What does not hold in a parsed setup on its own (the header's setup), each issue naming where: its seed; one named
 * judge model; the ladder's strengths and anchors distinct and in sha256 order, each anchor a strength, every Fixed9
 * one that reads back; the design's z, phi_margin and epsilon in range; `prev` null exactly at round 0; the top member
 * the ladder's; the members distinct and in sha256 order, none a house member, each one's entries distinct, in code-unit
 * order and no other member's, each ladder game against a house member; the players distinct and in sha256 order; a
 * judge view a dossier round's alone, naming players alone.
 */
function setupIssuesOf(s: JudgeContenderSetupT): string[] {
  const issues: string[] = [];
  if (s.seed !== judgeContenderSeed(s.phase_seed))
    issues.push(`seed: not judgeContenderSeed(${s.phase_seed})`);
  if (namedJudgeAgent(s.agent) === null)
    issues.push(
      "agent: a contender round is judged whole by the bundle's one named model on its own door, and this judge names none",
    );
  if (s.judges !== undefined) {
    // A contend chain's overflow judge, fixed at round 0 (the header's setup): one judge, the switch's, on OpenRouter.
    if (s.design.band === undefined)
      issues.push(
        "judges: only a contend chain's round (its design names a band) is judged by another judge than its agent's named model",
      );
    s.judges.forEach((j, k) => {
      if (j.via !== "overflow" || j.door !== "openrouter")
        issues.push(
          `judges.${k}: a contend chain's own judge is the judge-overflow switch's on OpenRouter, not ${j.model} on ${j.door} via ${j.via}`,
        );
      else if (j.provider === undefined)
        issues.push(
          `judges.${k}: ${j.model} on OpenRouter records the endpoints it is pinned to`,
        );
    });
  }
  const house = new Set<string>();
  const ladder = s.ladder;
  if (!ascending(ladder.strengths.map((x) => x.artifact_sha256)))
    issues.push("ladder.strengths: every house member once, in sha256 order");
  ladder.strengths.forEach((x, k) => {
    house.add(x.artifact_sha256);
    const off = fixed9RangeIssue(x.strength, 0n, { above: true });
    if (off !== null) issues.push(`ladder.strengths.${k}.strength: ${off}`);
  });
  if (!ascending(ladder.anchors))
    issues.push("ladder.anchors: the judge anchors once each, in sha256 order");
  ladder.anchors.forEach((a, k) => {
    if (!house.has(a))
      issues.push(
        `ladder.anchors.${k}: ${a} is no house member of the ladder's strengths`,
      );
  });
  const phi = fixed9RangeIssue(ladder.dispersion, 0n, { above: true });
  if (phi !== null) issues.push(`ladder.dispersion: ${phi}`);
  const z = fixed9RangeIssue(s.design.z, 0n, {
    above: true,
    hi: parseFixed9(PROGRAM_JUDGE_SCREENED_MAX_Z),
  });
  if (z !== null) issues.push(`design.z: ${z}`);
  const margin = fixed9RangeIssue(s.design.phi_margin, FIXED9_SCALE);
  if (margin !== null) issues.push(`design.phi_margin: ${margin}`);
  const eps = fixed9RangeIssue(s.design.epsilon, 0n);
  if (eps !== null) issues.push(`design.epsilon: ${eps}`);
  if ((s.round === 0) !== (s.prev === null))
    issues.push(
      "prev: null exactly at round 0, else round - 1's record sha256",
    );
  if (s.design.band === undefined) {
    if (s.select.band_edge !== undefined)
      issues.push(
        "select.band_edge: only a contend chain's round (its design names a band) has a band edge",
      );
  } else {
    if (s.design.line_places > s.design.band)
      issues.push(
        `design.line_places: a contend chain's line is a place among its band of ${s.design.band}, not ${s.design.line_places}`,
      );
    if (s.select.line_micro !== null)
      issues.push(
        "select.line_micro: a contend chain's players are its band, drawn at no dev line: null",
      );
    if (s.select.band_edge === undefined)
      issues.push(
        "select.band_edge: a contend chain's round names its band's last place (null while the field holds no more than the band)",
      );
  }
  if (
    issues.length === 0 &&
    s.select.top_member !== judgeContenderTopMember(ladder.strengths)
  ) {
    issues.push(
      `select.top_member: the ladder's strongest member is ${judgeContenderTopMember(ladder.strengths)}`,
    );
  }
  if (!ascending(s.members.map((m) => m.artifact_sha256)))
    issues.push("members: distinct, in sha256 order");
  const entries = new Set<string>();
  s.members.forEach((m, k) => {
    if (house.has(m.artifact_sha256))
      issues.push(
        `members.${k}: ${m.artifact_sha256} is a house member, never a contender`,
      );
    if (!ascending(m.entries))
      issues.push(`members.${k}.entries: distinct, in code-unit order`);
    for (const e of m.entries) {
      if (entries.has(e))
        issues.push(`members.${k}.entries: ${e} is another member's too`);
      entries.add(e);
    }
    m.ladder_games.forEach((g, j) => {
      if (!house.has(g.b))
        issues.push(
          `members.${k}.ladder_games.${j}.b: ${g.b} is no house member`,
        );
    });
  });
  if (!ascending(s.players)) issues.push("players: distinct, in sha256 order");
  if (s.judge_view !== undefined) {
    if (s.media !== "dossier")
      issues.push(
        `judge_view: a dossier round's alone, and this round judges ${s.media}`,
      );
    const players = new Set(s.players);
    for (const a of Object.keys(s.judge_view.views))
      if (!players.has(a))
        issues.push(`judge_view.views.${a}: not one of the round's players`);
  }
  return issues;
}

// ---------------------------------------------------------------- the fold

/** A chain member as the fold keeps it: its latest snapshot and its contender games so far. */
export interface JudgeContenderFoldMemberT extends JudgeContenderMemberT {
  contender_games: number;
}

/**
 * The chain so far (the header's fold): plain data, so a caller may keep it as JSON. The judge, ladder and design every
 * round holds, each member's latest snapshot and contender game count in sha256 order, every contender game in chain
 * order, the last round and its record's sha256.
 */
export interface JudgeContenderFoldT {
  head_sha256: string;
  round: number;
  judge: JudgeContenderJudgeT;
  ladder: JudgeContenderLadderT;
  design: JudgeContenderDesignT;
  members: JudgeContenderFoldMemberT[];
  games: JudgeHeatGameT[];
}

/** What the fit and the intervals read of a chain. */
export type JudgeContenderChainT = Pick<
  JudgeContenderFoldT,
  "ladder" | "design" | "members" | "games"
>;

const snapshotKey = (m: JudgeContenderMemberT): string =>
  canonicalJson({
    artifact_sha256: m.artifact_sha256,
    artifact_bytes: m.artifact_bytes,
    entries: m.entries,
    ladder_record_sha256: m.ladder_record_sha256,
    ladder_games: m.ladder_games,
  });

/**
 * What breaks the chain between `prev` and a round (the header's fold): its round and `prev` link, its judge, ladder or
 * design moved, a member listed that neither enters as a player nor changed, a player that is no member.
 */
function continuityIssuesOf(
  prev: JudgeContenderFoldT | null,
  s: JudgeContenderSetupT,
): string[] {
  const issues: string[] = [];
  const known = new Map<string, JudgeContenderFoldMemberT>();
  if (prev === null) {
    if (s.round !== 0)
      issues.push(`round: a chain's first round is 0, not ${s.round}`);
    if (s.prev !== null) issues.push("prev: round 0 follows no record");
  } else {
    if (s.round !== prev.round + 1)
      issues.push(
        `round: the chain's next round is ${prev.round + 1}, not ${s.round}`,
      );
    if (s.prev !== prev.head_sha256)
      issues.push(
        `prev: the chain's head is ${prev.head_sha256}, not ${String(s.prev)}`,
      );
    if (canonicalJson(judgeOf(s)) !== canonicalJson(prev.judge))
      issues.push(
        "judge: a chain's rounds are judged by one judge, seed and house text",
      );
    if (canonicalJson(s.ladder) !== canonicalJson(prev.ladder))
      issues.push("ladder: a chain's rounds rate by one ladder");
    if (canonicalJson(s.design) !== canonicalJson(prev.design))
      issues.push("design: a chain's rounds play by one design");
    for (const m of prev.members) known.set(m.artifact_sha256, m);
  }
  const players = new Set(s.players);
  s.members.forEach((m, k) => {
    const was = known.get(m.artifact_sha256);
    if (was === undefined) {
      if (!players.has(m.artifact_sha256))
        issues.push(
          `members.${k}: ${m.artifact_sha256} enters the chain only as one of the round's players`,
        );
    } else if (snapshotKey(was) === snapshotKey(m))
      issues.push(
        `members.${k}: ${m.artifact_sha256} is listed only when its snapshot changed, and it did not`,
      );
  });
  const listed = new Set(s.members.map((m) => m.artifact_sha256));
  s.players.forEach((p, k) => {
    if (!known.has(p) && !listed.has(p))
      issues.push(`players.${k}: ${p} is no member of the chain`);
  });
  return issues;
}

/** The chain's members after a round's snapshots: prev's, each listed one replaced (its contender count kept) or added, in sha256 order. */
function mergeMembers(
  prev: JudgeContenderFoldT | null,
  s: JudgeContenderSetupT,
): JudgeContenderFoldMemberT[] {
  const old = prev?.members ?? [];
  const out: JudgeContenderFoldMemberT[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length || j < s.members.length) {
    const a = old[i];
    const b = s.members[j];
    const c =
      a === undefined
        ? 1
        : b === undefined
          ? -1
          : compareCodeUnits(a.artifact_sha256, b.artifact_sha256);
    if (c < 0) {
      out.push(a!);
      i++;
    } else {
      out.push({ ...b!, contender_games: c === 0 ? a!.contender_games : 0 });
      if (c === 0) i++;
      j++;
    }
  }
  return out;
}

function judgeOfFold(
  prev: JudgeContenderFoldT | null,
  s: JudgeContenderSetupT,
): Pick<JudgeContenderFoldT, "judge" | "ladder" | "design"> {
  return prev === null
    ? { judge: judgeOf(s), ladder: s.ladder, design: s.design }
    : { judge: prev.judge, ladder: prev.ladder, design: prev.design };
}

/**
 * The chain with `record` folded in (the header's fold): each listed member's snapshot replaces its last, the record's
 * games are added and counted. JudgeHeatError when the record is out of shape or breaks the chain (a round that is not
 * prev + 1, a `prev` that is not the head, a judge, ladder or design that moved, a player that is no member). `prev`
 * is never changed. It holds only the chain's links: judgeContenderHold holds the record itself first.
 */
export function judgeContenderFold(
  prev: JudgeContenderFoldT | null,
  record: JudgeContenderRecordT,
): JudgeContenderFoldT {
  const parsed = JudgeContenderRecord.safeParse(record);
  if (!parsed.success)
    throw new JudgeHeatError(
      `the contender record is not one: ${parsed.error.issues[0]?.message ?? "malformed"}`,
    );
  const r = parsed.data;
  const issues = continuityIssuesOf(prev, r);
  if (issues.length > 0)
    throw new JudgeHeatError(
      `the contender chain is broken at round ${r.round}: ${issues.slice(0, 5).join("; ")}`,
    );
  const members = mergeMembers(prev, r);
  const at = new Map(members.map((m, k) => [m.artifact_sha256, k]));
  const counted = members.map((m) => m.contender_games);
  for (const g of r.games) {
    const i = at.get(g.a);
    const j = at.get(g.b);
    if (i === undefined || j === undefined)
      throw new JudgeHeatError(
        `the contender chain is broken at round ${r.round}: a game between ${g.a} and ${g.b} names no member`,
      );
    counted[i]! += 1;
    counted[j]! += 1;
  }
  return {
    head_sha256: judgeContenderRecordDigest(r).sha256,
    round: r.round,
    ...judgeOfFold(prev, r),
    members: members.map((m, k) =>
      m.contender_games === counted[k]
        ? m
        : { ...m, contender_games: counted[k]! },
    ),
    games: [...(prev?.games ?? []), ...r.games],
  };
}

/** `record` held against the chain (judgeContenderRecordIssues), then folded in. JudgeHeatError when it does not hold. */
export function judgeContenderHold(
  prev: JudgeContenderFoldT | null,
  record: JudgeContenderRecordT,
): JudgeContenderFoldT {
  const issues = judgeContenderRecordIssues(record, prev);
  if (issues.length > 0)
    throw new JudgeHeatError(
      `the contender record does not hold: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? `; and ${issues.length - 5} more` : ""}`,
    );
  return judgeContenderFold(prev, record);
}

// ---------------------------------------------------------------- the fit

/**
 * Bradley-Terry over the chain (the header's fit): each free member's (every chain member's) p, I and games in the fit,
 * keyed in sha256 order, the house members held at the ladder's strengths. The games are the contender games (each
 * between two members, with a_points) and each member's latest ladder games (against a house member). The same bits for
 * any order of the games. RangeError on a game outside the chain, a member that is a house member, or members or
 * strengths out of sha256 order.
 */
export function judgeContenderStrengths(
  chain: Pick<JudgeContenderChainT, "ladder" | "members" | "games">,
): Map<string, JudgeRaceStrengthT> {
  const house = chain.ladder.strengths;
  const free = chain.members;
  for (let k = 1; k < house.length; k++)
    if (
      compareCodeUnits(
        house[k - 1]!.artifact_sha256,
        house[k]!.artifact_sha256,
      ) >= 0
    )
      throw new RangeError(
        "the ladder's strengths are not distinct, in sha256 order",
      );
  for (let k = 1; k < free.length; k++)
    if (
      compareCodeUnits(
        free[k - 1]!.artifact_sha256,
        free[k]!.artifact_sha256,
      ) >= 0
    )
      throw new RangeError(
        "the chain's members are not distinct, in sha256 order",
      );
  // Every member, free and house, in one sha256 order: each sum runs in it.
  const n = house.length + free.length;
  if (n * n >= 2 ** 53)
    throw new RangeError(`${n} members are too many for one fit`);
  const names: string[] = new Array<string>(n);
  const isFree = new Uint8Array(n);
  const p = new Float64Array(n);
  {
    let i = 0;
    let j = 0;
    for (let k = 0; k < n; k++) {
      const h = house[i];
      const f = free[j];
      const c =
        h === undefined
          ? 1
          : f === undefined
            ? -1
            : compareCodeUnits(h.artifact_sha256, f.artifact_sha256);
      if (c === 0)
        throw new RangeError(
          `the member ${f!.artifact_sha256} is a house member`,
        );
      if (c < 0) {
        names[k] = h!.artifact_sha256;
        p[k] = judgeLadderFromFixed9(h!.strength);
        i++;
      } else {
        names[k] = f!.artifact_sha256;
        isFree[k] = 1;
        p[k] = 1;
        j++;
      }
    }
  }
  const at = new Map<string, number>();
  for (let k = 0; k < n; k++) at.set(names[k]!, k);
  // Whole twentieths, so the fold is exact in any order.
  const units = new Float64Array(n);
  for (let k = 0; k < n; k++) if (isFree[k] === 1) units[k] = HALF;
  let total = chain.games.length;
  for (const m of free) total += m.ladder_games.length;
  const keys = new Float64Array(total);
  let g = 0;
  const points = (x: number | undefined, what: string): number => {
    if (
      x === undefined ||
      !Number.isSafeInteger(x) ||
      x < 0 ||
      x > JUDGE_GAME_POINTS
    )
      throw new RangeError(
        `${what}'s a_points ${String(x)} is not a whole number from 0 to ${JUDGE_GAME_POINTS}`,
      );
    return x;
  };
  for (const game of chain.games) {
    const i = at.get(game.a);
    const j = at.get(game.b);
    if (
      i === undefined ||
      j === undefined ||
      isFree[i] !== 1 ||
      isFree[j] !== 1
    )
      throw new RangeError(
        `a contender game between ${game.a} and ${game.b} names a member outside the chain`,
      );
    if (i === j)
      throw new RangeError(`a contender game of ${game.a} against itself`);
    const u = points(game.a_points, "a contender game");
    units[i] += u;
    units[j] += JUDGE_GAME_POINTS - u;
    keys[g++] = i < j ? i * n + j : j * n + i;
  }
  for (const m of free) {
    const i = at.get(m.artifact_sha256)!;
    for (const lg of m.ladder_games) {
      const j = at.get(lg.b);
      if (j === undefined || isFree[j] === 1)
        throw new RangeError(
          `${m.artifact_sha256}'s ladder game names ${lg.b}, no house member`,
        );
      units[i] += points(lg.a_points, `${m.artifact_sha256}'s ladder game`);
      keys[g++] = i < j ? i * n + j : j * n + i;
    }
  }
  keys.sort();
  // The pairs in key order; a free member's opponents filled in that order (those below it first, then those above),
  // so each list is in member order, as judgeRaceStrengths keeps its own. A house member's p never moves: no list.
  const degree = new Int32Array(n + 1);
  const pairLo: number[] = [];
  const pairHi: number[] = [];
  const pairCount: number[] = [];
  for (let k = 0; k < keys.length;) {
    const key = keys[k]!;
    let c = 0;
    while (k < keys.length && keys[k] === key) {
      c++;
      k++;
    }
    const i = Math.floor(key / n);
    const j = key - i * n;
    pairLo.push(i);
    pairHi.push(j);
    pairCount.push(c);
    if (isFree[i] === 1) degree[i + 1] += 1;
    if (isFree[j] === 1) degree[j + 1] += 1;
  }
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i]! + degree[i + 1]!;
  const cursor = off.slice(0, n);
  const nbr = new Int32Array(off[n]!);
  const cnt = new Float64Array(off[n]!);
  const played = new Float64Array(n);
  for (let k = 0; k < pairLo.length; k++) {
    const i = pairLo[k]!;
    const j = pairHi[k]!;
    const c = pairCount[k]!;
    if (isFree[i] === 1) {
      nbr[cursor[i]!] = j;
      cnt[cursor[i]!] = c;
      cursor[i] += 1;
      played[i] += c;
    }
    if (isFree[j] === 1) {
      nbr[cursor[j]!] = i;
      cnt[cursor[j]!] = c;
      cursor[j] += 1;
      played[j] += c;
    }
  }
  const freeAt: number[] = [];
  for (let k = 0; k < n; k++) if (isFree[k] === 1) freeAt.push(k);
  const wins = new Float64Array(n);
  for (const i of freeAt) wins[i] = units[i]! / JUDGE_GAME_POINTS;
  // Jacobi: every free member from the last iterate; the house members' entries are the same in both arrays.
  let cur = p;
  let next = p.slice();
  for (let iter = 0; iter < JUDGE_BT_ITERATIONS; iter++) {
    for (const i of freeAt) {
      const pi = cur[i]!;
      let denom = 1 / (pi + 1);
      for (let e = off[i]!, end = off[i + 1]!; e < end; e++)
        denom += cnt[e]! / (pi + cur[nbr[e]!]!);
      next[i] = wins[i]! / denom;
    }
    const was = cur;
    cur = next;
    next = was;
  }
  const out = new Map<string, JudgeRaceStrengthT>();
  for (const i of freeAt) {
    const pi = cur[i]!;
    let info = pi / ((pi + 1) * (pi + 1));
    for (let e = off[i]!, end = off[i + 1]!; e < end; e++) {
      const pj = cur[nbr[e]!]!;
      const s = pi + pj;
      info += (cnt[e]! * pi * pj) / (s * s);
    }
    out.set(names[i]!, { p: pi, info, games: played[i]! });
  }
  return out;
}

// ---------------------------------------------------------------- the intervals

/** The chain's phi (the header's phi): the one it rates by, and what its contender games measured (null: no estimate yet). */
export interface JudgeContenderPhiT {
  phi: number;
  /** judgeHeatDispersion over the contender games; null while they are no more than the members who played them. */
  measured: number | null;
}

/** The chain's intervals (the header's intervals): phi, what was measured, and each member's log-strength interval, in sha256 order. */
export interface JudgeContenderIntervalsT extends JudgeContenderPhiT {
  intervals: Map<string, JudgeRaceIntervalT>;
}

/**
 * The chain's phi (the header's phi) over its fit: the ladder's while the contender games are no more than the members
 * who played them, else max(the ladder's, judgeHeatDispersion over those games and those members' fit).
 */
function phiOf(
  chain: Pick<JudgeContenderChainT, "ladder" | "games">,
  strengths: ReadonlyMap<string, JudgeRaceStrengthT>,
): JudgeContenderPhiT {
  const ladder = judgeLadderFromFixed9(chain.ladder.dispersion);
  const playedFit = new Map<string, { p: number }>();
  for (const g of chain.games) {
    for (const m of [g.a, g.b])
      if (!playedFit.has(m)) playedFit.set(m, { p: strengths.get(m)!.p });
  }
  if (chain.games.length <= playedFit.size)
    return { phi: ladder, measured: null };
  const measured = judgeHeatDispersion(chain.games, playedFit);
  return { phi: Math.max(ladder, measured), measured };
}

/**
 * Each chain member's interval as the schedule races it (the header's phi and intervals): se = sqrt(phi_margin x phi /
 * I), lo/hi = log p -+ z se. The ratings a screen reads carry no phi_margin (judgeContenderRatings).
 */
export function judgeContenderIntervals(
  chain: JudgeContenderChainT,
): JudgeContenderIntervalsT {
  const strengths = judgeContenderStrengths(chain);
  const { phi, measured } = phiOf(chain, strengths);
  return {
    phi,
    measured,
    intervals: judgeRaceIntervals(
      strengths,
      phi,
      chain.design.z,
      chain.design.phi_margin,
    ),
  };
}

// ---------------------------------------------------------------- who plays

/** A member's ladder record as the selection reads it: its artifact and its games from its own side. */
export interface JudgeContenderSnapshotT {
  artifact_sha256: string;
  ladder_games: JudgeContenderLadderGameT[];
}

/**
 * Why a contender plays (the header's who plays): its dev interval reaches the line, or it beat the top member every
 * time (a screened chain); or it is in the contend band (a contend chain).
 */
export type JudgeContenderWhyT = "line" | "top_member" | "band";

/** A dev entry that could contend: its artifact, entries, dev interval_high_micro and ladder snapshot. */
export interface JudgeContenderCandidateT {
  artifact_sha256: string;
  entries: readonly string[];
  interval_high_micro: number;
  snapshot: JudgeContenderSnapshotT;
}

function whyOf(
  games: readonly JudgeContenderLadderGameT[],
  high: number,
  line: number | null,
  top: string,
): JudgeContenderWhyT | null {
  if (line === null || high >= line) return "line";
  let against = 0;
  for (const g of games) {
    if (g.b !== top) continue;
    if (!(g.a_points > HALF)) return null;
    against++;
  }
  return against > 0 ? "top_member" : null;
}

function checkMicro(x: number | null, what: string): void {
  if (x !== null && (!Number.isSafeInteger(x) || x < 0 || x > JUDGE_MICRO))
    throw new RangeError(
      `${what} ${String(x)} is not a whole number of millionths from 0 to ${JUDGE_MICRO}`,
    );
}

/**
 * The candidates that play (the header's who plays), in sha256 order, each with why. TypeError on a candidate listed
 * twice or whose snapshot is another artifact's; RangeError on millionths out of range.
 */
export function judgeContenderPlayers(o: {
  candidates: readonly JudgeContenderCandidateT[];
  line_micro: number | null;
  top_member: string;
}): Array<JudgeContenderCandidateT & { why: JudgeContenderWhyT }> {
  checkMicro(o.line_micro, "the line");
  if (!Sha256Hex.safeParse(o.top_member).success)
    throw new TypeError(
      `the top member ${JSON.stringify(o.top_member)} is not an artifact's lowercase hex sha256`,
    );
  const seen = new Set<string>();
  const out: Array<JudgeContenderCandidateT & { why: JudgeContenderWhyT }> = [];
  for (const c of o.candidates) {
    if (!Sha256Hex.safeParse(c.artifact_sha256).success)
      throw new TypeError(
        `the candidate ${JSON.stringify(c.artifact_sha256)} is not an artifact's lowercase hex sha256`,
      );
    if (seen.has(c.artifact_sha256))
      throw new TypeError(`the candidate ${c.artifact_sha256} is listed twice`);
    seen.add(c.artifact_sha256);
    if (c.snapshot.artifact_sha256 !== c.artifact_sha256)
      throw new TypeError(
        `the candidate ${c.artifact_sha256}'s snapshot is ${c.snapshot.artifact_sha256}'s`,
      );
    checkMicro(
      c.interval_high_micro,
      `${c.artifact_sha256}'s interval_high_micro`,
    );
    const why = whyOf(
      c.snapshot.ladder_games,
      c.interval_high_micro,
      o.line_micro,
      o.top_member,
    );
    if (why !== null) out.push({ ...c, why });
  }
  return out.sort((x, y) =>
    compareCodeUnits(x.artifact_sha256, y.artifact_sha256),
  );
}

/** A contend candidate (judgeContenderBand): a candidate with its house-only dev win rate, in millionths. */
export interface JudgeContenderBandCandidateT extends JudgeContenderCandidateT {
  win_rate_micro: number;
}

/** Band order (the header's who plays): win rate, then interval high, highest first, then the lowest sha256. Negative when x ranks above y. */
function bandOrder(
  x: Pick<JudgeContenderBandEdgeT, "artifact_sha256" | "win_rate_micro" | "interval_high_micro">,
  y: Pick<JudgeContenderBandEdgeT, "artifact_sha256" | "win_rate_micro" | "interval_high_micro">,
): number {
  if (x.win_rate_micro !== y.win_rate_micro)
    return x.win_rate_micro > y.win_rate_micro ? -1 : 1;
  if (x.interval_high_micro !== y.interval_high_micro)
    return x.interval_high_micro > y.interval_high_micro ? -1 : 1;
  return compareCodeUnits(x.artifact_sha256, y.artifact_sha256);
}

/**
 * A contend chain's players (the header's who plays): the top `band` candidates in band order (house-only dev win rate,
 * then interval high, highest first, then the lowest sha256), each why 'band', in sha256 order, and the band's edge
 * (the band-th of them; null when the candidates are no more than the band, so every one plays). No path beside it: a
 * candidate outside the band never plays, whatever it did against the top house member. TypeError on a candidate listed
 * twice or whose snapshot is another artifact's; RangeError on millionths out of range or a band that is not one.
 */
export function judgeContenderBand(o: {
  candidates: readonly JudgeContenderBandCandidateT[];
  band: number;
}): {
  edge: JudgeContenderBandEdgeT | null;
  players: Array<JudgeContenderBandCandidateT & { why: JudgeContenderWhyT }>;
} {
  if (
    !Number.isSafeInteger(o.band) ||
    o.band < PROGRAM_JUDGE_CONTEND_MIN_BAND ||
    o.band > PROGRAM_JUDGE_CONTEND_MAX_BAND
  )
    throw new RangeError(
      `a contend band holds ${PROGRAM_JUDGE_CONTEND_MIN_BAND} to ${PROGRAM_JUDGE_CONTEND_MAX_BAND} entries, not ${String(o.band)}`,
    );
  const seen = new Set<string>();
  for (const c of o.candidates) {
    if (!Sha256Hex.safeParse(c.artifact_sha256).success)
      throw new TypeError(
        `the candidate ${JSON.stringify(c.artifact_sha256)} is not an artifact's lowercase hex sha256`,
      );
    if (seen.has(c.artifact_sha256))
      throw new TypeError(`the candidate ${c.artifact_sha256} is listed twice`);
    seen.add(c.artifact_sha256);
    if (c.snapshot.artifact_sha256 !== c.artifact_sha256)
      throw new TypeError(
        `the candidate ${c.artifact_sha256}'s snapshot is ${c.snapshot.artifact_sha256}'s`,
      );
    checkMicro(c.win_rate_micro, `${c.artifact_sha256}'s win_rate_micro`);
    checkMicro(
      c.interval_high_micro,
      `${c.artifact_sha256}'s interval_high_micro`,
    );
  }
  const ranked = [...o.candidates].sort(bandOrder);
  const inBand = ranked.slice(0, o.band);
  const last = ranked.length > o.band ? inBand[o.band - 1]! : null;
  return {
    edge:
      last === null
        ? null
        : {
            artifact_sha256: last.artifact_sha256,
            win_rate_micro: last.win_rate_micro,
            interval_high_micro: last.interval_high_micro,
          },
    players: inBand
      .map((c) => ({ ...c, why: "band" as const }))
      .sort((x, y) => compareCodeUnits(x.artifact_sha256, y.artifact_sha256)),
  };
}

/**
 * A contend round's players held to its band (the header's who plays), each recomputed from its snapshot: no more
 * players than the band; with an edge, exactly the band, the edge one of them with the numbers its snapshot gives, and
 * none ranked below it.
 */
function bandIssuesOf(
  s: JudgeContenderSetupT,
  scoreOf: (p: string) => { win_rate_micro: number; interval_high_micro: number } | null,
): string[] {
  const issues: string[] = [];
  const band = s.design.band!;
  const edge = s.select.band_edge ?? null;
  if (s.players.length > band)
    issues.push(
      `players: a contend round plays at most its band of ${band}, and ${s.players.length} are listed`,
    );
  if (edge === null) return issues;
  if (s.players.length !== band)
    issues.push(
      `players: a band with an edge is full, ${band} players, and ${s.players.length} are listed`,
    );
  if (!s.players.includes(edge.artifact_sha256)) {
    issues.push(
      `select.band_edge: ${edge.artifact_sha256} is the band's last place, and no player`,
    );
    return issues;
  }
  s.players.forEach((p, k) => {
    const score = scoreOf(p);
    if (score === null) return;
    const mine = { artifact_sha256: p, ...score };
    if (p === edge.artifact_sha256) {
      if (
        score.win_rate_micro !== edge.win_rate_micro ||
        score.interval_high_micro !== edge.interval_high_micro
      )
        issues.push(
          `select.band_edge: its snapshot rates ${p} at ${score.win_rate_micro} (interval high ${score.interval_high_micro}), not ${edge.win_rate_micro} (${edge.interval_high_micro})`,
        );
    } else if (bandOrder(edge, mine) < 0)
      issues.push(
        `players.${k}: ${p}'s dev win rate ${score.win_rate_micro} (interval high ${score.interval_high_micro}) ranks below the band's edge`,
      );
  });
  return issues;
}

/** Each player that does not play by the rule, recomputed from its snapshot (the header's who plays), each issue naming where. */
function eligibilityIssuesOf(
  s: JudgeContenderSetupT,
  members: readonly JudgeContenderFoldMemberT[],
): string[] {
  const issues: string[] = [];
  const at = new Map(members.map((m) => [m.artifact_sha256, m]));
  const strengths = new Map(
    s.ladder.strengths.map((x) => [
      x.artifact_sha256,
      judgeLadderFromFixed9(x.strength),
    ]),
  );
  const phi = judgeLadderFromFixed9(s.ladder.dispersion);
  if (s.design.band !== undefined) {
    // A contend round: its band, each player's house-only rate recomputed from its snapshot; no other path.
    return bandIssuesOf(s, (p) => {
      const m = at.get(p);
      if (m === undefined) return null; // continuityIssuesOf names it
      const score = judgeLadderScore({
        subject: p,
        games: m.ladder_games.map((g) => ({ a: p, b: g.b, a_points: g.a_points })),
        strengths,
        anchors: s.ladder.anchors,
        phi,
      });
      return { win_rate_micro: score.win_rate_micro, interval_high_micro: score.interval_high_micro };
    });
  }
  s.players.forEach((p, k) => {
    const m = at.get(p);
    if (m === undefined) return; // continuityIssuesOf names it
    const games = m.ladder_games.map((g) => ({
      a: p,
      b: g.b,
      a_points: g.a_points,
    }));
    const high = judgeLadderScore({
      subject: p,
      games,
      strengths,
      anchors: s.ladder.anchors,
      phi,
    }).interval_high_micro;
    if (
      whyOf(m.ladder_games, high, s.select.line_micro, s.select.top_member) ===
      null
    ) {
      issues.push(
        `players.${k}: ${p}'s dev interval high ${high} is below the line ${String(s.select.line_micro)}, and it has not beaten the top member ${s.select.top_member} in every game against it`,
      );
    }
  });
  return issues;
}

// ---------------------------------------------------------------- the schedule

/** A round's plan (the header's schedule): the contender line, the active players, the candidates and their caps, the pairs and their calls. */
export interface JudgeContenderScheduleT {
  /** The M-th best lo among the players, on the log scale; null under M players. */
  line: number | null;
  /** The active players in rank order, each its room. */
  active: JudgeRaceActiveT[];
  /** The players with games left, in sha256 order, each capped at its games left. */
  caps: Map<string, number>;
  pairs: JudgeRacePairT[];
  /** Two calls a pair: the drawn slot order, then the other. Empty when the round is. */
  planned: JudgePlannedCallT[];
}

function otherOrder(o: JudgeSlotOrderT): JudgeSlotOrderT {
  return o === "ab" ? "ba" : "ab";
}

function scheduleOf(
  s: JudgeContenderSetupT,
  chain: JudgeContenderChainT,
): JudgeContenderScheduleT {
  const empty = (
    line: number | null,
    active: JudgeRaceActiveT[],
    caps: Map<string, number>,
  ): JudgeContenderScheduleT => ({
    line,
    active,
    caps,
    pairs: [],
    planned: [],
  });
  const players = s.players;
  if (players.length === 0) return empty(null, [], new Map());
  const { intervals } = judgeContenderIntervals(chain);
  const count = new Map(
    chain.members.map((m) => [m.artifact_sha256, m.contender_games]),
  );
  const of = (m: string): JudgeRaceIntervalT => {
    const v = intervals.get(m);
    if (v === undefined)
      throw new RangeError(`the player ${m} is no member of the chain`);
    return v;
  };
  const games = chain.design.games;
  const places = chain.design.line_places;
  const eps = judgeRaceNumber(chain.design.epsilon, "epsilon", 0);
  const los = players.map((m) => of(m).lo).sort((x, y) => y - x);
  const line = players.length >= places ? los[places - 1]! : null;
  const ranked = [...players].sort((x, y) => {
    const px = of(x).p;
    const py = of(y).p;
    return px > py ? -1 : px < py ? 1 : compareCodeUnits(x, y);
  });
  const active: JudgeRaceActiveT[] = [];
  for (const m of ranked) {
    const v = of(m);
    const c = count.get(m)!;
    // A player with no contender game yet is active whatever its interval (the header's schedule): its interval is its
    // ladder record's alone, so a line drawn among players rated by contender games says nothing of it.
    if (c < games && (c === 0 || (v.half > eps && (line === null || v.hi >= line))))
      active.push({ member: m, room: games - c });
  }
  const caps = new Map<string, number>();
  for (const m of players)
    if (count.get(m)! < games) caps.set(m, games - count.get(m)!);
  if (caps.size < 2 || active.length === 0) return empty(line, active, caps);
  const { ties } = judgeRaceActive({
    entrants: players,
    intervals,
    tiers: [],
    epsilon: chain.design.epsilon,
    games: chain.games,
  });
  const candidates = new Map<string, JudgeRaceIntervalT>();
  for (const m of caps.keys()) candidates.set(m, of(m));
  const pairs = judgeRacePairs({
    active,
    candidates,
    games: chain.games.filter((g) => caps.has(g.a) && caps.has(g.b)),
    ties,
    epochCalls: 2,
    caps,
    first: (a, b) => judgeSlotOrder(s.seed, "race", s.round, a, b),
  });
  const planned: JudgePlannedCallT[] = [];
  for (const p of pairs) {
    planned.push(
      { stage: "race", round: s.round, a: p.a, b: p.b, slot_order: p.first },
      {
        stage: "race",
        round: s.round,
        a: p.a,
        b: p.b,
        slot_order: otherOrder(p.first),
      },
    );
  }
  return { line, active, caps, pairs, planned };
}

/**
 * A round's plan (the header's schedule) after the chain `fold` (null before round 0), from its setup: the fit over the
 * chain with the round's snapshots in, the line, the active players, the caps and the pairs, two calls each.
 * JudgeHeatError when the setup does not hold on its own or does not follow the chain (judgeContenderFold's links).
 */
export function judgeContenderSchedule(
  fold: JudgeContenderFoldT | null,
  setup: JudgeContenderSetupT,
): JudgeContenderScheduleT {
  const parsed = JudgeContenderSetup.safeParse(setup);
  if (!parsed.success)
    throw new JudgeHeatError(
      `the contender round is not one: ${parsed.error.issues[0]?.message ?? "malformed"}`,
    );
  const s = parsed.data;
  const issues = [...setupIssuesOf(s), ...continuityIssuesOf(fold, s)];
  if (issues.length > 0) throw doesNotHold(issues);
  return scheduleOf(s, {
    ...judgeOfFold(fold, s),
    members: mergeMembers(fold, s),
    games: fold?.games ?? [],
  });
}

/**
 * Each of a round's players that does not play by the rule after the chain `fold` (the header's who plays), recomputed
 * from its snapshot as judgeContenderRecordIssues holds the round's record to it; none when every one does. What a
 * caller weighs before a call is spent: a record whose players do not hold is never linked. JudgeHeatError when the
 * setup does not hold on its own or does not follow the chain.
 */
export function judgeContenderPlayerIssues(
  fold: JudgeContenderFoldT | null,
  setup: JudgeContenderSetupT,
): string[] {
  const parsed = JudgeContenderSetup.safeParse(setup);
  if (!parsed.success)
    throw new JudgeHeatError(
      `the contender round is not one: ${parsed.error.issues[0]?.message ?? "malformed"}`,
    );
  const s = parsed.data;
  const issues = [...setupIssuesOf(s), ...continuityIssuesOf(fold, s)];
  if (issues.length > 0) throw doesNotHold(issues);
  return eligibilityIssuesOf(s, mergeMembers(fold, s));
}

// ---------------------------------------------------------------- the calls, games, spares and totals

const USAGE_KEYS = [
  "input",
  "output",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "reasoning",
] as const;
type UsageT = JudgeHeatTotalsT["usage"];

function usageSum(all: readonly (UsageT | null)[]): UsageT | null {
  let sum: UsageT | null = null;
  for (const u of all) {
    if (u === null) continue;
    sum ??= {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      reasoning: 0,
    };
    for (const k of USAGE_KEYS) sum[k] += u[k];
  }
  return sum;
}

function microUsdSum(all: readonly (string | null)[]): string {
  let sum = 0n;
  for (const m of all) if (m !== null) sum += BigInt(m);
  return sum.toString();
}

/** The calls' totals, the spares' attempts counted (judge-heat's totals). */
function totalsOf(
  calls: readonly JudgeHeatCallT[],
  spares: readonly JudgeHeatSpareT[],
): JudgeHeatTotalsT {
  const attempts = [
    ...calls.flatMap((c) => c.attempts),
    ...spares.flatMap((x) => x.attempts),
  ];
  return {
    calls: calls.length,
    attempts: attempts.length,
    usage: usageSum(attempts.map((t) => t.usage)) ?? {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      reasoning: 0,
    },
    micro_usd: microUsdSum(attempts.map((t) => t.micro_usd)),
  };
}

/** The games of calls that run two a pair, in their order: judge-heat's v2 fold (judgeGamePoints). */
function gamesOf(calls: readonly JudgeHeatCallT[]): JudgeHeatGameT[] {
  const out: JudgeHeatGameT[] = [];
  for (let k = 0; k + 1 < calls.length; k += 2) {
    const first = calls[k]!;
    const aPoints = judgeGamePoints(first, calls[k + 1]!);
    out.push({
      stage: first.stage,
      round: first.round,
      a: first.a,
      b: first.b,
      result: judgeGameResultOf(aPoints),
      a_points: aPoints,
    });
  }
  return out;
}

/**
 * What does not hold in a parsed record on its own (none when it holds), each issue naming where: its setup
 * (setupIssuesOf); a judge view naming exactly the artifacts its calls carry (the header's judge view); every call a `race` call of the record's round with no `judge`, holding (judgeHeatCallIssues) with
 * its margin as a v2 call carries it, each game's two calls one pair in both slot orders; an attempt names its
 * `provider` only on an openrouter judge; the spares (judge-heat's rules); the games, totals and invalid calls derived
 * from the calls, an invalid share within invalid_share_max; and at least one game.
 */
function recordIssuesOf(r: JudgeContenderRecordT): string[] {
  const issues = setupIssuesOf(r);
  if (r.judge_view !== undefined) {
    // A view round names exactly the artifacts its calls carry (the header's judge view).
    const carried = new Set(r.calls.flatMap((c) => [c.a, c.b]));
    for (const a of carried)
      if (r.judge_view.views[a] === undefined)
        issues.push(`judge_view.views: names no view of ${a}, which a call carries`);
    for (const a of Object.keys(r.judge_view.views))
      if (!carried.has(a))
        issues.push(`judge_view.views.${a}: no call carries it`);
  }
  let door: JudgeDoorT | null | undefined;
  const doorOf = (): JudgeDoorT | null => {
    if (door === undefined) {
      try {
        door = judgeContenderJudgeOf(r).door;
      } catch (err) {
        if (!(err instanceof JudgeHeatError || err instanceof JudgeDoorRefusal))
          throw err;
        door = null;
      }
    }
    return door;
  };
  const providers = (
    where: string,
    attempts: readonly { provider?: string }[],
  ): void => {
    attempts.forEach((t, n) => {
      if (t.provider !== undefined && doorOf() !== "openrouter")
        issues.push(
          `${where}.attempts.${n}.provider: only an attempt an openrouter judge was sent names who served it`,
        );
    });
  };
  r.calls.forEach((c, i) => {
    if (c.stage !== "race")
      issues.push(
        `calls.${i}.stage: a contender round's calls are race calls, not ${c.stage}`,
      );
    if (c.round !== r.round)
      issues.push(
        `calls.${i}.round: the record's round ${r.round}, not ${c.round}`,
      );
    if (c.judge !== undefined)
      issues.push(
        `calls.${i}.judge: a contender round's calls name no judge index: its one judge is the chain's`,
      );
    issues.push(
      ...judgeHeatCallIssues(c).map((issue) => `calls.${i}.${issue}`),
    );
    if (c.margin === undefined)
      issues.push(
        `calls.${i}.margin: a contender call carries its margin (null with no verdict)`,
      );
    else if ((c.margin === null) !== (c.verdict === null))
      issues.push(`calls.${i}.margin: null exactly when the verdict is`);
    if (i % 2 === 1) {
      const first = r.calls[i - 1]!;
      if (
        first.a !== c.a ||
        first.b !== c.b ||
        first.slot_order === c.slot_order
      )
        issues.push(
          `calls.${i}: a game's second call judges its pair in the other slot order`,
        );
    }
    providers(`calls.${i}`, c.attempts);
  });
  if (r.calls.length % 2 !== 0)
    issues.push(`calls: two calls a game, and ${r.calls.length} are listed`);
  const spares = r.spares ?? [];
  const perCall = new Map<number, number>();
  spares.forEach((x, k) => {
    issues.push(
      ...judgeHeatSpareIssues(x).map((issue) => `spares.${k}.${issue}`),
    );
    if (x.call >= r.calls.length)
      issues.push(
        `spares.${k}.call: ${x.call} names no call: ${r.calls.length} are listed`,
      );
    const prev = spares[k - 1];
    if (
      prev !== undefined &&
      (prev.call > x.call || (prev.call === x.call && prev.send >= x.send))
    )
      issues.push(
        `spares.${k}: the spares are ordered by call, then send, each send of a call once`,
      );
    const n = (perCall.get(x.call) ?? 0) + 1;
    perCall.set(x.call, n);
    if (n === JUDGE_HEAT_MAX_SENDS)
      issues.push(
        `spares.${k}.call: call ${x.call} has at most ${JUDGE_HEAT_MAX_SENDS - 1} spares`,
      );
    providers(`spares.${k}`, x.attempts);
  });
  if (issues.length > 0) return issues;
  if (r.calls.length === 0)
    return ["calls: a round with no game is never recorded"];
  const games = gamesOf(r.calls);
  if (games.length !== r.games.length)
    issues.push(
      `games: the calls make ${games.length} games, and ${r.games.length} are listed`,
    );
  else {
    const at = games.findIndex(
      (g, i) => canonicalJson(g) !== canonicalJson(r.games[i]),
    );
    if (at !== -1)
      issues.push(
        `games.${at}: the calls make ${canonicalJson(games[at])} here`,
      );
  }
  const totals = totalsOf(r.calls, spares);
  if (canonicalJson(totals) !== canonicalJson(r.totals))
    issues.push(
      `totals: the calls and their spares total ${canonicalJson(totals)}`,
    );
  const invalid = r.calls.filter((c) => c.verdict === null).length;
  if (invalid !== r.invalid_calls)
    issues.push(
      `invalid_calls: ${invalid} calls have no verdict, not ${r.invalid_calls}`,
    );
  else if (
    judgeHeatInvalidShareOver(invalid, r.calls.length, r.invalid_share_max)
  ) {
    issues.push(
      `invalid_calls: ${invalid} of ${r.calls.length} calls have no verdict, more than the ${r.invalid_share_max} share the round allows`,
    );
  }
  return issues;
}

// ---------------------------------------------------------------- issues, records, parsing

/**
 * What does not hold in a record after the chain `prev` (null before round 0), none when it holds: its shape, seed and
 * own fields (the calls, games, spares, totals and invalid share), the chain's links (judgeContenderFold's), each
 * player's eligibility recomputed from its snapshot (the header's who plays), and every call's place: the round's
 * schedule re-derived from the chain and the setup, call for call. Each issue names where.
 */
export function judgeContenderRecordIssues(
  raw: JudgeContenderRecordT,
  prev: JudgeContenderFoldT | null,
): string[] {
  const parsed = JudgeContenderRecord.safeParse(raw);
  if (!parsed.success)
    return parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(record)"}: ${i.message}`,
    );
  const r = parsed.data;
  const issues = [...recordIssuesOf(r), ...continuityIssuesOf(prev, r)];
  if (issues.length > 0) return issues;
  const members = mergeMembers(prev, r);
  issues.push(...eligibilityIssuesOf(r, members));
  if (issues.length > 0) return issues;
  const s = scheduleOf(r, {
    ...judgeOfFold(prev, r),
    members,
    games: prev?.games ?? [],
  });
  for (let i = 0; i < Math.min(s.planned.length, r.calls.length); i++) {
    const p = s.planned[i]!;
    const c = r.calls[i]!;
    if (c.a !== p.a || c.b !== p.b || c.slot_order !== p.slot_order)
      return [
        `calls.${i}: the round judges ${p.a} against ${p.b} in slot order ${p.slot_order} here`,
      ];
  }
  if (s.planned.length !== r.calls.length)
    return [
      `calls: the round makes ${s.planned.length} calls, and ${r.calls.length} are listed`,
    ];
  return [];
}

/**
 * The record of a round whose calls are all made (the header's record), after the chain `prev`: the setup, `calls` in
 * the order they ran, the games, totals and invalid calls derived from them, and `spares` (absent when none).
 * JudgeHeatError when it does not hold (judgeContenderRecordIssues): the calls are not the round's, not all of them,
 * more came back invalid than invalid_share_max allows, or the round is empty.
 */
export function judgeContenderRecordOf(
  prev: JudgeContenderFoldT | null,
  setup: JudgeContenderSetupT,
  calls: readonly JudgeHeatCallT[],
  spares: readonly JudgeHeatSpareT[] = [],
): JudgeContenderRecordT {
  const parsed = JudgeContenderSetup.safeParse(setup);
  if (!parsed.success)
    throw new JudgeHeatError(
      `the contender round is not one: ${parsed.error.issues[0]?.message ?? "malformed"}`,
    );
  let games: JudgeHeatGameT[];
  try {
    games = gamesOf(calls);
  } catch (err) {
    if (err instanceof RangeError)
      throw new JudgeHeatError(
        `the round's calls make no games: ${err.message}`,
      );
    throw err;
  }
  const record: JudgeContenderRecordT = {
    ...parsed.data,
    calls: [...calls],
    games,
    totals: totalsOf(calls, spares),
    invalid_calls: calls.filter((c) => c.verdict === null).length,
    ...(spares.length === 0 ? {} : { spares: [...spares] }),
  };
  const issues = judgeContenderRecordIssues(record, prev);
  if (issues.length > 0) throw doesNotHold(issues);
  return JudgeContenderRecord.parse(record);
}

/**
 * A record as stored (canonical JSON text or bytes), parsed and held on its own (its shape, seed and own fields; the
 * chain's checks are judgeContenderRecordIssues' against the fold before it). JudgeHeatError when it is no contender
 * record that holds: a judge heat record, of any format, is refused by its format.
 */
export function parseJudgeContenderRecord(
  stored: string | Uint8Array,
): JudgeContenderRecordT {
  let raw: unknown;
  try {
    raw = JSON.parse(
      typeof stored === "string"
        ? stored
        : new TextDecoder("utf-8", { fatal: true }).decode(stored),
    );
  } catch (err) {
    throw new JudgeHeatError(
      `the contender record is not JSON: ${(err as Error).message}`,
    );
  }
  const format = (raw as { format?: unknown } | null)?.format;
  if (format !== JUDGE_CONTENDER_FORMAT)
    throw new JudgeHeatError(
      `the contender record's format is ${JSON.stringify(format)}, not ${JUDGE_CONTENDER_FORMAT}`,
    );
  const parsed = JudgeContenderRecord.safeParse(raw);
  if (!parsed.success)
    throw new JudgeHeatError(
      `the contender record is not one: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(record)"}: ${i.message}`)[0] ?? "malformed"}`,
    );
  const issues = recordIssuesOf(parsed.data);
  if (issues.length > 0)
    throw new JudgeHeatError(
      `the contender record does not hold: ${issues[0]}`,
    );
  return parsed.data;
}

// ---------------------------------------------------------------- the ratings

/** A member's contender rating (the header's ratings): as a screen's rated input carries it, and its contender games. */
export interface JudgeContenderRatingT {
  artifact_sha256: string;
  /** p, Fixed9. */
  strength: string;
  /** The log-scale se as a ladder rating carries it, sqrt(phi) / sqrt(I) with no phi_margin, Fixed9 from 0. */
  se: string;
  win_rate_micro: number;
  se_micro: number;
  interval_low_micro: number;
  interval_high_micro: number;
  games: number;
}

const micro = (x: number): number => Math.round(x * JUDGE_MICRO);

/** A value from 0 as Fixed9: toFixed9(BigInt(Math.round(x * 1e9))). RangeError past 2^53 billionths. */
function fixed9From0(x: number): string {
  if (!Number.isFinite(x) || x < 0)
    throw new RangeError(
      `the value ${String(x)} is not a finite number from 0`,
    );
  const scaled = Math.round(x * Number(FIXED9_SCALE));
  if (scaled >= 2 ** 53)
    throw new RangeError(`the value ${String(x)} is 2^53 billionths or more`);
  return toFixed9(BigInt(scaled));
}

/**
 * Each member with at least one contender game, rated (the header's ratings), in sha256 order: p and its log-scale se =
 * sqrt(phi) / sqrt(I) (the header's phi, no phi_margin: a ladder rating's se, grader/judge-screen-inputs.ts) as Fixed9;
 * E = (1/|A|) sum_A p/(p+p_j) over the judge anchors A, d = (1/|A|) sum_A p p_j/(p+p_j)^2, se_E = d se, the interval
 * E -+ JUDGE_Z90 se_E clamped to [0, 1], each in millionths as judgeLadderScore rounds them; its contender games.
 * JudgeHeatError when a strength has no Fixed9 form.
 */
export function judgeContenderRatings(
  fold: JudgeContenderChainT,
): Map<string, JudgeContenderRatingT> {
  const fit = judgeContenderStrengths(fold);
  const rootPhi = Math.sqrt(phiOf(fold, fit).phi);
  const strengths = new Map(
    fold.ladder.strengths.map((x) => [
      x.artifact_sha256,
      judgeLadderFromFixed9(x.strength),
    ]),
  );
  const anchors = [...fold.ladder.anchors].sort(compareCodeUnits).map((a) => {
    const pj = strengths.get(a);
    if (pj === undefined)
      throw new RangeError(`the anchor ${a} has no fixed strength`);
    return pj;
  });
  const n = anchors.length;
  if (n === 0) throw new RangeError("a rating takes at least one anchor");
  const out = new Map<string, JudgeContenderRatingT>();
  for (const m of fold.members) {
    if (m.contender_games === 0) continue;
    const v = fit.get(m.artifact_sha256)!;
    const p = v.p;
    const se = rootPhi / Math.sqrt(v.info);
    let e = 0;
    let slope = 0;
    for (const pj of anchors) {
      const s = p + pj;
      e += p / s;
      slope += (p * pj) / (s * s);
    }
    e = e / n;
    const seE = (slope / n) * se;
    const half = JUDGE_Z90 * seE;
    try {
      out.set(m.artifact_sha256, {
        artifact_sha256: m.artifact_sha256,
        strength: judgeLadderToFixed9(p),
        se: fixed9From0(se),
        win_rate_micro: micro(e),
        se_micro: Math.min(JUDGE_MICRO, micro(seE)),
        interval_low_micro: micro(Math.max(0, e - half)),
        interval_high_micro: micro(Math.min(1, e + half)),
        games: m.contender_games,
      });
    } catch (err) {
      if (err instanceof RangeError)
        throw new JudgeHeatError(
          `${m.artifact_sha256}'s contender rating has no Fixed9 form: ${err.message}`,
        );
      throw err;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the snapshot

/**
 * A member's snapshot from its v3 provisional ladder record (the header's snapshot): its subject and every game it
 * played, scrutiny rounds included, from the subject's side, in record order. JudgeHeatError when the record does not
 * hold (judgeHeatRecordIssues) or is not a provisional heat's on a ladder.
 */
export function judgeContenderSnapshotOf(
  record: JudgeHeatRecordT,
): JudgeContenderSnapshotT {
  const issues = judgeHeatRecordIssues(record);
  if (issues.length > 0)
    throw new JudgeHeatError(`the ladder record does not hold: ${issues[0]}`);
  const r = JudgeHeatRecord.parse(record);
  if (
    r.format !== JUDGE_HEAT_FORMAT_V3 ||
    r.stage !== "provisional" ||
    r.ladder === undefined
  ) {
    throw new JudgeHeatError(
      `a contender's snapshot is read from a ${JUDGE_HEAT_FORMAT_V3} provisional heat on a ladder, and this record is a ${r.format} ${r.stage} heat's`,
    );
  }
  const subject = r.field.find((m) => m.entries.length > 0)!.artifact_sha256;
  return {
    artifact_sha256: subject,
    ladder_games: r.games.map((g) =>
      g.a === subject
        ? { b: g.b, a_points: g.a_points! }
        : { b: g.a, a_points: JUDGE_GAME_POINTS - g.a_points! },
    ),
  };
}
