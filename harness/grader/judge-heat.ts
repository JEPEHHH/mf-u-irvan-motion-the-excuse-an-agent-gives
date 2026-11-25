// A program/v1 judge heat's pure core (contracts/competition.ts ProgramJudge): the house judge compares two
// artifacts at a time, and every field member's score (contracts/score.ts ProgramJudgeScore) is read off the
// verdicts. No clock and no I/O here: the heat job (grader/worker.ts) sends each call through grader/judge-call.ts,
// keeps what came back as a JudgeHeatCall, and asks judgeHeatNextCall for the next one; the record it then stores
// (agent-fun/judge-heat/v2, JUDGE_HEAT_FORMAT) rebuilds every score (judgeHeatVerdicts), by the heat and by any regrade
// alike, as grader/code-heat.ts's record rebuilds a timing. An agent-fun/judge-heat/v1 record (JUDGE_HEAT_FORMAT_V1:
// verdicts with no margin, the binary fold below) still parses, holds and scores to the same bytes it always did, so
// the v1 heats already stored keep verifying; no heat writes one again. An agent-fun/judge-heat/v3 record
// (JUDGE_HEAT_FORMAT_V3) is a ladder's (below): a calibration's, or a provisional heat's on a ladder. Its calls, games
// and verdicts are v2's (judgeHeatVerdictFormat: v2); final heats keep writing v2, but a screened final, which writes
// agent-fun/judge-heat/v4 (JUDGE_HEAT_FORMAT_V4, the screened final below), a screened final with a drawn playoff
// panel, which writes agent-fun/judge-heat/v5 (JUDGE_HEAT_FORMAT_V5, the panel final below), and a panel final whose
// Swiss and race are dealt over the whole sealed pool, which writes agent-fun/judge-heat/v6 (JUDGE_HEAT_FORMAT_V6, the
// dealt final below). judgeHeatFinalFormatOf names a final's format from its judge block.
//
//   the field        one member per distinct artifact (judgeHeatField): the final phase's kept entries that passed
//                    the gate, grouped by their artifact's sha256 (byte-identical copies share one member and one
//                    score, so the board's exact-tie rule, the earlier receipt, keeps the original first), and the
//                    house anchors (<judge.dir>/anchors/, `anchor: true`), in sha256 order. An entry whose artifact
//                    is an anchor's joins the anchor's member: it plays, and is scored, as that anchor, and never
//                    enters the playoff. A provisional heat's field is one dev entry's artifact and the anchors
//   the seed         judgeHeatSeed(phase seed) = sha256(utf8(the record's format) || 0x00 || utf8(the phase seed, u64
//                    decimal)), so a v1 record re-derives its v1 seed; the phase seed is the one the phase's grade
//                    runs carry (grader/worker.ts programPlan: a final
//                    heat's runs hold it, and a regrade holds the record to it). Round 1's order (judgeHeatOrder) is grader/scrape/heat.ts scrapeHeatOrder
//                    of that seed, stage `main`, round 0, over the members' places in sha256 order: a Fisher-Yates
//                    shuffle drawn from a sha256 stream. Which slot order of a pair runs first (judgeSlotOrder) is
//                    a bit of sha256(utf8('slot') || 0x00 || seed || stage || 0x00 || u32be(round) || a || b)
//   a game           one pair judged twice, once in each slot order (the A/B assignment of a call: `ab` puts `a`
//                    in slot A). Each call answers a winner and a margin, 1 (by a hair) to 5 (overwhelmingly),
//                    and is worth 10 tenths of a win between the two (judgeCallTenths): 5 + margin to the member it
//                    picks, 5 - margin to the other; a call with no verdict gives each 5. The game's a_points is
//                    `a`'s tenths from its two calls summed, twentieths of a game from 0 to 20 (judgeGamePoints):
//                    above 10 `a` wins, below 10 `b` does, and exactly 10 is a draw, which only two calls that
//                    cancel exactly make (opposite picks at one margin, or neither answering). The judge is never
//                    offered a tie (GenArena's forced choice), and a split decides by its margins: the call surer
//                    of its pick carries the game. A v1 record's game is the binary fold its calls had no margin
//                    for: both calls valid and naming the same artifact, that artifact wins; anything else (the
//                    slots disagree, or a call came back with no verdict) is a draw, and it holds no a_points
//   the Swiss        `rounds` rounds over the whole field, anchors included (judgeSwissPairs): round 1 in the
//                    seed's order, every later round ranked by the current expected win rate (below, over the
//                    games so far), ties by sha256. Walking down the ranking, each member takes the nearest member
//                    below it that it has not played: a backtracking search, so no pairing repeats a game while a
//                    pairing without one exists (within JUDGE_SWISS_SEARCH_STEPS; past them, or when none exists,
//                    each takes the nearest member it has played least). On an odd field the bye goes to the lowest
//                    ranked member among those with the fewest byes that leaves the rest such a pairing
//   the playoff      the first playoff_places members by expected win rate after the Swiss (judgePlayoffPlaces;
//                    anchors never), ties by sha256, at least two of them: every pair of them is one game per
//                    repeat, playoff_repeats times, its two calls in the drawn order. They are the finalists
//                    (`finalist: true`); with fewer than two entrant members, no playoff runs
//   provisional      a dev entry's artifact plays every other member (the anchors) once, both slot orders: two
//                    calls an anchor, the same judge, prompt and anchors as the final's Swiss, so dev and final
//                    share one scale. Its score is `provisional: true`: shown, never weighed
//   the ladder       (v3) members of FIXED strength a dev entry is rated against (grader/judge-ladder.ts), sealed in the
//                    bundle's ladder dir: the judge anchors and the rungs (house artifacts under <ladder dir>/rungs/, a
//                    member's `rung_files`). A calibration heat (stage `calibration`, no entries, at least two members)
//                    judges every pair i < j in sha256 order, both slot orders, `repeats` times, the first order drawn
//                    by judgeSlotOrder(seed, `calibration`, repeat, a, b); judgeLadderFitOf reads each member's strength
//                    off judgeFit over its games, as Fixed9, and the pooled within-pair dispersion phi. A provisional
//                    heat on a ladder (its setup's `ladder`: the ladder's and calibration's digests, every other
//                    member's strength in sha256 order, phi, and rounds, games and spread) plays the judge anchors
//                    (never the rungs) in round 0 as above, then `rounds` x `games` adaptive games k = 1, 2, ...: at
//                    each round's start the estimate p^ over the games so far (judgeLadderEstimate), the round's games
//                    cycling over the `spread` members most informative at it (judgeLadderNext), each a game of stage
//                    `adaptive`, round k, its first order judgeSlotOrder(seed, `adaptive`, k, entry, member). A
//                    screened bundle's dev heat names its money-place `scrutiny` (line_micro, rounds): once the
//                    `rounds` settle, an entry whose judgeLadderScore interval high over its games so far is at or
//                    above line_micro (judgeLadderReachesLine) plays `scrutiny.rounds` more such rounds, k continuing,
//                    against the ladder's members alone (house-only, as every adaptive game); below it the heat ends
//                    there. Either way the heat up to that decision is the same calls, so a record with no scrutiny
//                    is a prefix of the scrutinised one (a dev top-up resumes from it), and judgeHeatPlannedCalls is
//                    at most (judgeLadderCallsAtMost). Its one score is the entry's, judgeLadderScore against the
//                    record's own strengths and phi over every game it played: E over the judge anchors, provisional
//   the fit          Bradley-Terry by Hunter's MM (Hunter 2004, Annals of Statistics 32(1):384-406) over every game
//                    of the record, its outcomes soft: a v2 game gives `a` a_points twentieths of a win and `b` the
//                    other 20 - a_points (a game decided 12 to 8 is 0.6 of a win to one side, 0.4 to the other); a
//                    v1 game a whole win to its winner, or half a win each for a draw. Every member has one virtual
//                    draw against a virtual player of strength 1 (half a win: it fixes the scale and keeps every
//                    strength finite). W_i, the wins so summed, is counted in whole twentieths and divided by 20
//                    once (exact in binary64, so a v1 record's W_i is the same bits its half-wins gave), and
//                    p_i <- W_i / (1/(p_i + 1) + sum_j n_ij/(p_i + p_j)), all members at once from the last
//                    iterate, JUDGE_BT_ITERATIONS (200) times from p = 1. Only + - * / and Math.sqrt, each of
//                    which ES2025 (§6.1.6.1, §21.3.2.33) rounds correctly in binary64, every sum in member order:
//                    the fit is the same bits on every host
//   the score        E_i = (1/(n-1)) sum_{j != i} p_i/(p_i + p_j) over the whole field, anchors included; its
//                    standard error by the delta method, SE = d_i / sqrt(I_i), with d_i = dE_i/dlog p_i = (1/(n-1))
//                    sum_{j != i} p_i p_j/(p_i + p_j)^2 and I_i = p_i/(p_i + 1)^2 + sum_j n_ij p_i p_j/(p_i + p_j)^2
//                    (the virtual draw is part of the fit, so of its curvature); the 90% interval E +- 1.6449 SE
//                    clamped to [0, 1]; each rounded to millionths (JUDGE_MICRO). A member that played no game has
//                    no score. That SE takes phi = 1, a binomial judge; judgeHeatDispersion measures a heat's own
//                    overdispersion phi around its fit (df-adjusted, at least 0.1), which only a v4 record (below) reads:
//                    every v1, v2 and v3 score and interval stays the bits it was
//   the exact tie    what breaks a tie of win_rate_micro to the millionth (a statistical tie stays display-only): a
//                    v2 record's field holds each member's artifact_bytes, and its scores carry them, and, for an
//                    entrant member of a final heat with exact-tie peers (the other entrant members scored with the
//                    same win_rate_micro and the same finalist flag), head_to_head: per peer in sha256 order its
//                    twentieths of a win summed over the PLAYOFF games against that peer (the Swiss pairs by the
//                    standing, unevenly, so its games never count). The board's chain is head-to-head among the tied
//                    entries, then the smaller artifact, then the earlier receipt. A v1 record holds and scores neither
//   the record       JudgeHeatRecord: the stage, the phase seed and the heat's seed, the house judge (its agent,
//                    judge_sha256, media and artifact, and the house text its requests were built from:
//                    house_text, so a request is rebuilt from the record's own words, never the code's current
//                    ones), the heat's numbers, the field, every call in the order it ran (its pair and slot order,
//                    then grader/judge-call.ts's JudgeCallResult: the verdict, its margin (a v2 call's; a v1 call
//                    has none), reason and invalid, the last request's hashes and model, the usage and price summed,
//                    and each request sent as its JudgeAttempt; judgeHeatCallOf builds one, judgeHeatCallIssues holds
//                    it), the games (a v2 game with its a_points), the finalists, the totals (its calls' counts, usage
//                    and price, and the heat's timing: judgeHeatTimingOf's started_at, finished_at and elapsed_ms, or
//                    none on a record written before the timing and on a heat that sent no call) and the invalid calls.
//                    The verdict's shape follows the format (judgeHeatVerdictFormat: a request rebuilds in the
//                    record's own schema), and judgeHeatRecordIssues holds every call and game to it; it re-derives every
//                    pairing, slot order, game, the finalists and the totals from the rest; judgeHeatVerdicts
//                    rebuilds the scores from a record that holds, twice, and refuses two that differ by a byte
//   spares           a planned call may be sent more than once, its first send and up to two backups
//                    (JUDGE_HEAT_MAX_SENDS in all). Its decision is the first send to answer with a verdict (a tie to
//                    the earlier send): that send is the call `calls` keeps, one a planned call and shaped as ever.
//                    Every other send of it is cancelled at once and kept in the record's optional `spares`, ordered by
//                    call, then send (JudgeHeatSpare: its call's index and send number, when it was sent and when it
//                    ended, how it ended, its attempts and their usage and price summed; judgeHeatSpareOf builds one,
//                    judgeHeatSpareIssues holds it). It ended `cancelled` (aborted when another send decided its call:
//                    no attempt, or one that gave no verdict), `invalid` (both its requests answered, neither with a
//                    verdict), `faulted` (a grader/judge-call.ts JudgeCallFault, its attempts the ones that completed),
//                    or `late` (a verdict that was not the first: in the same tick as the decision's, where the tie
//                    went to the earlier send, or just after it, answered before its cancel reached it: the one spare
//                    with a verdict, margin and reason). A spare is never scored: the games, the fit and
//                    every score read `calls` alone, so a record scores the same with its spares as without them. The
//                    totals count their attempts, usage and price (the heat paid for them), never a call, and the
//                    timing's first send and last instant are theirs too. `spares` is absent, never empty, when a call
//                    had no other send, so such a record is the bytes it always was; a v1 record has none
//   invalid calls   a call with no verdict (grader/judge-call.ts: unparseable, refused, cut at the length limit or
//                    answered by another model, its answer and then its `verdict` tool, forced or offered). More than
//                    invalid_share_max of a heat's calls (judgeHeatInvalidShareOver) and the heat does not count:
//                    no record holds, no score is written
//   the resume       an attempt keeps each call as it settles (JudgeHeatPartial, under judgeHeatResumeKey), with what
//                    the heat spent and the key it holds open, and each kept call's spares; the next attempt checks the
//                    kept calls against the schedule and their spares to them (judgeHeatKeptIssue) and sends only the
//                    calls still to come
//   the judges       (server/judging/pool.ts) a heat judged by other than the bundle's one named model on its own door
//                    lists them in its setup's `judges` (JudgeOfHeat: its door and, on `openrouter`, its pin); each
//                    call names its judge's index (`judge`), and an attempt OpenRouter served names who did (`provider`).
//                    A final's games are dealt (judgeDeal over the seed, the weights and its games in schedule order,
//                    both calls of a game on one judge; a v5 final's are planned, the panel final below, and a v6
//                    final's Swiss and race games dealt over its pool's members alone, the dealt final below); a
//                    provisional heat and a calibration list one judge. All three
//                    keys are absent on a heat its named model judged, so such a record is the bytes it always was
//                    (judgeHeatJudgesOf derives its one judge). The resume key never reads `judges`; a partial keeps
//                    them. A release before these keys cannot parse a record or partial that holds them
//   the judge view   (a dossier heat's, optional in every format but v1) a dossier heat planned since the view
//                    (server/judging/dossier-view.ts, under its contest's policy: JUDGE_VIEW_POLICIES, dossier-view/v1
//                    unless server/judging/dossier-view-budget.ts DOSSIER_VIEW_POLICIES names v2) sends each member as
//                    its judge view: built once an artifact before the first call, stored as a blob, and named in the
//                    setup's `judge_view` (the policy that built its views, and each member's artifact sha256 to its
//                    view's sha256, every member named), its house_text
//                    framing entries in grader/judge-call.ts JUDGE_DOSSIER_VIEW_ENTRY_FRAME (judgeHeatSetup's `view`). A
//                    request is rebuilt from the stored views (grader/judge-call.ts judgeArtifactsViewed), never from views
//                    made again. A setup naming none sends every dossier whole, so every record written before it is the
//                    bytes it was; a resumed final keeps the view (or none) its partial kept (JudgeHeatPartial.judge_view)
//   screened final   (v4, JUDGE_HEAT_FORMAT_V4: a final whose judge block names `screened`, contracts/competition.ts
//                    ProgramJudgeScreened; v2's calls, games, verdict and field) the setup's `screen` holds each entrant
//                    member's dev rating (its dev record's sha256, log-strength p^ and log-scale se as Fixed9, and the
//                    dev score the board showed) or why it has none (JUDGE_SCREEN_UNRATED), each anchor's calibration
//                    strength, z and the line M (judgeShortlistPlaces); `race` the judge's racing numbers and the prize
//                    tiers (grader/judge-race.ts judgeRaceTiers). A rated member the sealed dev contender rounds
//                    (agent-fun/judge-contender/v1) also rate carries that rating beside its house-only one, as its
//                    `contender` sub-rating (strength and se, naming the chain's head: no millionths), and the screen
//                    then names that chain (`contender`: head sha256 and rounds; absent, and the screen the bytes it
//                    was, when no member carries one). The sub-rating sets the line, the member's cut against it and
//                    its round-0 place, and nothing else. The screen inputs are fixed before the first call,
//                    and a partial keeps them (`screen`). Its schedule (all of it grader/judge-race.ts's math):
//                    F1 the shortlist S, judgeScreen (every anchor, every unrated entrant at the line, each rated one
//                    whose interval reaches the M-th best low: among the contender-rated members when at least M
//                    are, else among the rated ones), and the house-only floor (judgeHeatScreenOf): with a
//                    sub-rating in the screen, every member the house-only screen keeps (each rated member on its
//                    house-only rating, the M-th best of their lows) is kept as well, so the contender rounds only
//                    ever keep more than the house-only screen; F2 `rounds` Swiss rounds over S, round 0 in the screen's
//                    seeded order and each later one by the standing p/(1+p) of judgeRaceStrengths over the games so far;
//                    F3 racing epochs (stage `race`, round the epoch) while an entrant straddles a prize boundary under
//                    its cap with its phi-scaled interval wider than epsilon, each epoch judgeRacePairs' pairs within the
//                    race's budget (max(M x race_cap_max, ceil(|S| / 2)) games, judgeRaceBudget), at most
//                    race_cap_max epochs; F4 the round-robin among the first playoff_places entrants of S by p,
//                    playoff_repeats times, then top_repeats games between the two first by p after it (stage
//                    `playoff`, rounds playoff_repeats and on). The finalists are the
//                    round-robin's players. judgeHeatPlannedCalls is an upper bound (judgeScreenedCallBound), the
//                    most a schedule over the calls so far can still come to judgeHeatScheduleCeiling's (each step
//                    still to plan at that bound's count for it, never rising), the schedule's `complete` the end, and
//                    judgeHeatScheduleMemo keeps its steps between replans. Its
//                    scores: S's by judgeFit over the games among S, se x sqrt(phi_margin x phi^) and the interval
//                    E +- z se; a rated entrant the screen left out `screened_out`, its house-only dev rating's numbers
//                    over 0 matches (one with a contender sub-rating too: a contender verdict is never a score). Since
//                    the sub-rating, a release names a new harness_version (grader/version.ts sums every grader/
//                    source); no v4 record was written before it, so no record format moved
//   panel final      (v5, JUDGE_HEAT_FORMAT_V5: a screened final whose judge block also names `panel`,
//                    contracts/competition.ts ProgramJudgePanel; v4's screen, race, calls, verdict and field) the setup's
//                    `panel` holds the bundle's sealed pool (server/judging/panel.ts JudgePanelPool, its
//                    `<judge.dir>/panel.json`) and its sha256 (the judge block's), the drand beacon it was drawn on (chain,
//                    round, signature), the draw (judgePanelDraw) and the pool's order under it (judgePanelOrder), fixed
//                    before the first call (a partial keeps it, `panel`). Its `judges` are exactly the members at
//                    order[0..JUDGE_PANEL_SIZE-1] (via `panel`, on openrouter, pinned, each asked its member's model, at
//                    most its output tokens and its temperature), then the Swiss judge (via `overflow`, weight
//                    JUDGE_HEAT_PANEL_SWISS_WEIGHT, last); each of its games names its judge (JudgeHeatGame.judge, a v5
//                    game's alone). The setup holds the panel by sha256 alone (panelIssuesOf); the beacon's BLS signature
//                    and its round against the final's starts_at (judgePanelRound) are the regrade's and the kit
//                    verifier's to check. A panel names no other format's setup, and a panel judge no other format's
//                    judges, so every v1-v4 record is the bytes it was. Its schedule is v4's, its judges planned with
//                    its calls and never dealt (judgeDeal): every F2 Swiss and F3 race call on the Swiss judge
//                    (JUDGE_HEAT_PANEL_SWISS_JUDGE, index JUDGE_PANEL_SIZE); in F4 each round-robin game, each repeat,
//                    and each top_repeats game is a slot planned as JUDGE_HEAT_PANEL_PLAYOFF_GAMES games in a fixed
//                    order, panel seat 0, 1, 2, then the shadow (the Swiss judge), each both slot orders in the
//                    pair's drawn first order (judgeSlotOrder(seed, `playoff`, round, a, b)). Its scores read its
//                    games as they score (judgeHeatScoredGames): a Swiss or race game as it is, a playoff slot one game
//                    whose a_points is the median of its three panel games' (a whole number from 0 to 20; 18, 10 and 4
//                    is a draw) over the seats that count: a seat's game counts only when both its calls carry a
//                    verdict (judgeGamesVoidOf), two counted their mean rounded toward 10 (18 and 4 is 11), one its
//                    own, none 10 (judgePanelPointsOf), so a failed call never votes a draw, every call with no
//                    verdict still counted toward invalid_share_max; its result judgeGameResultOf of that, and the
//                    shadow's game dropped; so the fit, phi,
//                    the tally (a slot one match), head-to-head and the schedule's top-two pick never read a shadow
//                    verdict, and the record's own `games` stay the raw ones, re-derived from its calls.
//                    judgeHeatPlannedCalls and judgeHeatScheduleCeiling count each F4 game JUDGE_HEAT_PANEL_PLAYOFF_GAMES times
//                    (judgeScreenedCallBound's `playoffJudges`). grader/judge-panel-report.ts reads the panel's
//                    agreement and the shadow's gap off a record: display figures, never a score
//   dealt final      (v6, JUDGE_HEAT_FORMAT_V6: a panel final whose judge block's `panel` also names `deal: true`,
//                    contracts/competition.ts ProgramJudgePanel; v5's screen, race, calls, verdict, field and panel, the
//                    same pool, beacon, draw and order) its `judges` are every pool member in drawn order, order[0] to
//                    order[n - 1] (n the pool's members, 4 to 8; via `panel`, on openrouter, pinned, each asked its
//                    member's model, at most its output tokens and its temperature, at weight JUDGE_HEAT_PANEL_SEAT_WEIGHT),
//                    then the Swiss judge (via `overflow`, weight JUDGE_HEAT_PANEL_SWISS_WEIGHT, last, at index n: the
//                    shadow, judgeHeatShadowOf). Its schedule is v5's but for the Swiss and race: every F2 Swiss and F3
//                    race game, a prefix of the schedule, is dealt (judgeDeal over the seed, the n members' weights and
//                    those games in schedule order, both calls of a game on one judge; a prefix deals as the whole does),
//                    never over the Swiss judge's weight, so the Swiss judge judges no Swiss or race game. Its F4 games
//                    are v5's, planned and never dealt: panel seat 0, 1, 2 (the members at order[0..2]), then the shadow
//                    at index n, each both slot orders; its fold is v5's with the shadow at n, its games each naming
//                    their judge. The Swiss judge stays the dev heats' and the screen's, so the screen stays predictable
//                    by design; the call counts are v5's (the bound and the ceiling count F4 games
//                    JUDGE_HEAT_PANEL_PLAYOFF_GAMES times). A dealt panel names no other format's setup, so every v1-v5
//                    record is the bytes it was
//
// Faults: a record out of shape, a call that is not the one the heat makes next, a heat whose judge answered too
// few calls are the house's (JudgeHeatError), never an entry's.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BundlePath,
  JudgeAgent,
  namedJudgeAgent,
  PROGRAM_JUDGE_LADDER_MAX,
  PROGRAM_JUDGE_MEDIA,
  PROGRAM_JUDGE_MIN_PLAYOFF_PLACES,
  PROGRAM_JUDGE_MIN_ROUNDS,
  PROGRAM_JUDGE_SCREENED_MAX_Z,
  judgeShortlistPlaces,
  type PrizeT,
  type ProgramJudgeT,
} from '../contracts/competition.ts';
import { CassetteUsage, type CassetteUsageT } from '../contracts/agent.ts';
import { Fixed9, FIXED9_SCALE, IsoDateTime, parseFixed9, Sha256Hex, toFixed9, U64 } from '../contracts/primitives.ts';
import { JUDGE_MICRO, ProgramJudgeScore, type ProgramJudgeScoreT } from '../contracts/score.ts';
import { ScrapeEntryId } from '../contracts/scrape.ts';
// The two helpers come from grading-budget.ts, not load.ts: load.ts reaches this module back through verify-result and
// judge-contender, so importing it here starts a cycle in which judge-heat's bindings are not set yet when that
// module's body runs. grading-budget.ts holds the same two functions (judgePlayoffPlaceCount: load.ts's judgePlayoffPlaces,
// lastPaidPlace: its body) and loads no judge module.
import { judgePlayoffPlaceCount, lastPaidPlace } from '../server/competitions/grading-budget.ts';
import { judgeText } from '../server/judging/judge-text.ts';
import {
  JUDGE_PANEL_POOL_MAX,
  JUDGE_PANEL_POOL_MIN,
  JUDGE_PANEL_SIZE,
  JudgePanelBeacon,
  JudgePanelPool,
  judgePanelDraw,
  judgePanelOrder,
  judgePanelPoolIssues,
  judgePanelPoolSha256,
} from '../server/judging/panel.ts';
import { JUDGE_POOL_MAX, judgeDeal, JudgeDoorRefusal, judgeDoorOf, JudgeOfHeat, type JudgeDoorT, type JudgeOfHeatT } from '../server/judging/pool.ts';
import { canonicalJson, compareCodeUnits, sha256Hex } from '../sim/canonical.ts';
import { JUDGE_DOSSIER_TEXT_MIN, JUDGE_HOUSE_TEXT, JUDGE_HOUSE_TEXT_DOSSIER_VIEW, JUDGE_MARGIN_MAX, JUDGE_MARGIN_MIN, JUDGE_REASON_MAX, type JudgeVerdictFormat } from './judge-call.ts';
// grader/judge-ladder.ts imports this module's constants back: its bindings are read only inside functions here.
import {
  judgeLadderDispersion,
  judgeLadderEstimate,
  judgeLadderFromFixed9,
  judgeLadderNext,
  judgeLadderReachesLine,
  judgeLadderScore,
  judgeLadderStrengths,
  judgeLadderToFixed9,
  JUDGE_LADDER_PHI_MIN,
} from './judge-ladder.ts';
// grader/judge-race.ts imports this module's constants back, likewise read only inside its functions.
import {
  judgeRaceActive,
  judgeRaceBudget,
  judgeRaceIntervals,
  judgeRaceLog,
  judgeRaceNumber,
  judgeRacePairs,
  judgeRaceStrengths,
  judgeRaceTiers,
  judgeScreen,
  judgeScreenedCallBound,
  type JudgeRaceStrengthT,
  type JudgeScreenT,
} from './judge-race.ts';
import { scrapeHeatOrder } from './scrape/heat.ts';

// ---------------------------------------------------------------- constants

/**
 * The heat record's format every final heat and every provisional heat with no ladder writes, and the seed's domain:
 * verdicts with a margin, games with their points.
 */
export const JUDGE_HEAT_FORMAT = 'agent-fun/judge-heat/v2';
/** The format of the records written before the margin (the header): read, held and scored, never written again. */
export const JUDGE_HEAT_FORMAT_V1 = 'agent-fun/judge-heat/v1';
/**
 * The ladder's format (the header's ladder): a calibration heat's record and a provisional heat's on a ladder. Its
 * calls, games and field are v2's (the same verdict and margin), plus the rungs, the calibration's repeats and the
 * provisional heat's fixed strengths; a final heat never writes it.
 */
export const JUDGE_HEAT_FORMAT_V3 = 'agent-fun/judge-heat/v3';
/**
 * A screened final's format (the header's screened final): v2's calls, games and field, plus the screen its shortlist
 * was drawn by and the race's numbers. A final heat whose judge block names `screened` writes it; no other heat does.
 */
export const JUDGE_HEAT_FORMAT_V4 = 'agent-fun/judge-heat/v4';
/**
 * A panel final's format (the header's panel final): v4's screen, race, calls and field, plus the playoff panel drawn
 * from the bundle's sealed pool and the judges it seats. A final heat whose judge block names `screened` and `panel`
 * writes it; no other heat does.
 */
export const JUDGE_HEAT_FORMAT_V5 = 'agent-fun/judge-heat/v5';
/**
 * A dealt panel final's format (the header's dealt final): v5's screen, race, calls, field and panel, its judges every
 * pool member in drawn order and then the Swiss judge, its Swiss and race games dealt over the members. A final heat
 * whose judge block names `screened` and a `panel` with `deal: true` writes it; no other heat does.
 */
export const JUDGE_HEAT_FORMAT_V6 = 'agent-fun/judge-heat/v6';
/** Every format a record may carry. */
export const JUDGE_HEAT_FORMATS = [JUDGE_HEAT_FORMAT_V1, JUDGE_HEAT_FORMAT, JUDGE_HEAT_FORMAT_V3, JUDGE_HEAT_FORMAT_V4, JUDGE_HEAT_FORMAT_V5, JUDGE_HEAT_FORMAT_V6] as const;
export type JudgeHeatFormatT = (typeof JUDGE_HEAT_FORMATS)[number];
/**
 * The formats a final heat's record may carry: v3 is the ladder's alone, v4 a screened final's, v5 a panel final's, v6
 * a dealt panel final's.
 */
export const JUDGE_HEAT_FINAL_FORMATS = [JUDGE_HEAT_FORMAT_V1, JUDGE_HEAT_FORMAT, JUDGE_HEAT_FORMAT_V4, JUDGE_HEAT_FORMAT_V5, JUDGE_HEAT_FORMAT_V6] as const;
/** The formats of a panel final (the header's panel final and dealt final): v5 and v6. */
export type JudgeHeatPanelFormatT = typeof JUDGE_HEAT_FORMAT_V5 | typeof JUDGE_HEAT_FORMAT_V6;
/** The formats of a screened final (the header's screened final, panel final and dealt final): v4, v5 and v6. */
export type JudgeHeatScreenedFormatT = typeof JUDGE_HEAT_FORMAT_V4 | JudgeHeatPanelFormatT;
/** Whether `format` is a panel final's (v5 or v6): a record whose setup names a drawn `panel`. */
export function judgeHeatPanelFormat(format: string): format is JudgeHeatPanelFormatT {
  return format === JUDGE_HEAT_FORMAT_V5 || format === JUDGE_HEAT_FORMAT_V6;
}
/** Whether `format` is a screened final's (v4, v5 or v6): a record whose setup names a `screen` and a `race`. */
export function judgeHeatScreenedFormat(format: string): format is JudgeHeatScreenedFormatT {
  return format === JUDGE_HEAT_FORMAT_V4 || judgeHeatPanelFormat(format);
}
/**
 * The format a final heat run now writes for its judge block (the header's screened final, panel final and dealt
 * final): JUDGE_HEAT_FORMAT_V6 when it names `screened` and a `panel` with `deal: true`, JUDGE_HEAT_FORMAT_V5 when it
 * names `screened` and a `panel` without one, JUDGE_HEAT_FORMAT_V4 when it names `screened` alone, JUDGE_HEAT_FORMAT
 * otherwise. The one copy of the rule: judgeHeatSetup's default, and every reader that holds a final to its bundle.
 */
export function judgeHeatFinalFormatOf(judge: Pick<ProgramJudgeT, 'screened' | 'panel'>): typeof JUDGE_HEAT_FORMAT | JudgeHeatScreenedFormatT {
  if (judge.screened === undefined) return JUDGE_HEAT_FORMAT;
  if (judge.panel === undefined) return JUDGE_HEAT_FORMAT_V4;
  return judge.panel.deal === true ? JUDGE_HEAT_FORMAT_V6 : JUDGE_HEAT_FORMAT_V5;
}
/**
 * The Swiss judge's weight in a panel final's judges (the header's panel final): server/judging/plan.ts
 * JUDGE_ALONE_WEIGHT, written here so a record holds without loading the planner; tests/unit/grader-judge-heat-v5-setup.test.ts
 * holds the two equal.
 */
export const JUDGE_HEAT_PANEL_SWISS_WEIGHT = 100;
/**
 * The Swiss judge's index in a v5 record's judges (the header's panel final): listed last, after the panel's
 * JUDGE_PANEL_SIZE seats. It judges every Swiss and race call, and in the playoff the shadow game, recorded and never scored.
 * A v6 record's Swiss judge is listed after every pool member, at the pool's size (judgeHeatShadowOf).
 */
export const JUDGE_HEAT_PANEL_SWISS_JUDGE = JUDGE_PANEL_SIZE;
/**
 * A pool member's weight in a v6 record's judges (the header's dealt final): what the deal of its Swiss and race games
 * reads, every member alike. server/judging/plan.ts JUDGE_PANEL_WEIGHT, written here so a record holds without loading
 * the planner; tests/unit/grader-judge-heat-v6-setup.test.ts holds the two equal.
 */
export const JUDGE_HEAT_PANEL_SEAT_WEIGHT = 1;
/** The games a v5 or v6 playoff slot plans (the header's panel final): one for each panel seat, then the shadow's. */
export const JUDGE_HEAT_PANEL_PLAYOFF_GAMES = JUDGE_PANEL_SIZE + 1;
/** A call's worth between its two members, in tenths of a win (the header's game): 5 + margin and 5 - margin. */
export const JUDGE_CALL_TENTHS = 10;
/** A game's worth, in twentieths of a win (its two calls' tenths): a_points runs 0 to this, a draw at half. */
export const JUDGE_GAME_POINTS = 20;
/**
 * A record's stage: the final phase's heat, a dev entry's provisional heat against the anchors (and, on a ladder, its
 * rungs), or the house's calibration of a ladder's members against each other.
 */
export const JUDGE_HEAT_STAGES = ['final', 'provisional', 'calibration'] as const;
export type JudgeHeatStageT = (typeof JUDGE_HEAT_STAGES)[number];
/**
 * A call's stage: a final heat's Swiss rounds, then its playoff; a provisional heat's round against the anchors, then
 * on a ladder its adaptive games; a calibration's repeats; a screened final's racing epochs (between its Swiss rounds
 * and its playoff).
 */
export const JUDGE_CALL_STAGES = ['swiss', 'playoff', 'provisional', 'calibration', 'adaptive', 'race'] as const;
export type JudgeCallStageT = (typeof JUDGE_CALL_STAGES)[number];
/** A call's slot order: `ab` shows the pair's `a` as Entry A and `b` as Entry B, `ba` the other way round. */
export const JUDGE_SLOT_ORDERS = ['ab', 'ba'] as const;
export type JudgeSlotOrderT = (typeof JUDGE_SLOT_ORDERS)[number];
/** What the judge answers: the slot it prefers. It has no tie. */
export const JUDGE_VERDICTS = ['A', 'B'] as const;
export type JudgeVerdictT = (typeof JUDGE_VERDICTS)[number];
/** A game's result: its pair's `a` won, its `b` won, or a draw. */
export const JUDGE_GAME_RESULTS = ['a', 'b', 'draw'] as const;
export type JudgeGameResultT = (typeof JUDGE_GAME_RESULTS)[number];

/** The fit's MM iterations (the header's fit): fixed, so the fit is the same bits wherever it runs. */
export const JUDGE_BT_ITERATIONS = 200;
/** The normal quantile of the 90% two-sided interval (the header's score). */
export const JUDGE_Z90 = 1.6449;
/**
 * The form a request was sent in (grader/judge-call.ts JudgeForm): the answer asked for as a response_format and the
 * forced `verdict` tool, or, for a model that takes no forced tool, the answer the system prompt alone asks for and the
 * verdict tool offered with tool_choice auto.
 */
export const JUDGE_CALL_FORMS = ['answer', 'tool', 'answer_plain', 'tool_auto'] as const;
export type JudgeCallFormT = (typeof JUDGE_CALL_FORMS)[number];
/**
 * A call's requests in the order sent (grader/judge-call.ts sendJudgeCall), by the answer's form: the answer, then,
 * when it gave no verdict, one of its retries. A forced answer retries as the forced tool, or as the offered one when
 * masq refused the forced form for its model; an unforced answer only as the offered tool.
 */
export const JUDGE_CALL_RETRY_FORMS: Readonly<Partial<Record<JudgeCallFormT, readonly JudgeCallFormT[]>>> = Object.freeze({
  answer: ['tool', 'tool_auto'],
  answer_plain: ['tool_auto'],
});
/** The requests a call sends at most (grader/judge-call.ts JUDGE_CALL_ATTEMPTS): its answer and one retry. */
export const JUDGE_CALL_MAX_ATTEMPTS = 2;
/**
 * The sends one planned call may have at most (the header's spares): its decision and at most two spares, its first
 * send and two backups. A spare's `send` is 0 to JUDGE_HEAT_MAX_SENDS - 1, and a call has at most JUDGE_HEAT_MAX_SENDS
 * - 1 spares. The sender's backup rule (grader/judge-backup.ts) sends no more than this.
 */
export const JUDGE_HEAT_MAX_SENDS = 3;
/**
 * How a spare send ended (the header's spares): aborted when another send decided its call, answered with no verdict
 * after its requests, a JudgeCallFault, or a verdict that was not its call's first (the header's `late`).
 */
export const JUDGE_SPARE_ENDS = ['cancelled', 'invalid', 'faulted', 'late'] as const;
export type JudgeSpareEndT = (typeof JUDGE_SPARE_ENDS)[number];
/** The candidate pairings a Swiss round's search examines before it takes the nearest-least-played walk instead. */
export const JUDGE_SWISS_SEARCH_STEPS = 1_000_000;

/** The heat cannot go on, or a record does not hold: the house's fault, never an entry's. */
export class JudgeHeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeHeatError';
  }
}

/** Whether `format` is a record format this code reads. */
function isHeatFormat(format: string): format is JudgeHeatFormatT {
  return (JUDGE_HEAT_FORMATS as readonly string[]).includes(format);
}

/**
 * The verdict a record of `format` asked for and reads (grader/judge-call.ts JudgeVerdictFormat): what its requests
 * rebuild in (judgeRequestBody's `verdict`) and its response bodies read as (judgeVerdictOf). RangeError on another.
 */
export function judgeHeatVerdictFormat(format: string): JudgeVerdictFormat {
  if (format === JUDGE_HEAT_FORMAT_V1) return 'v1';
  if (format === JUDGE_HEAT_FORMAT || format === JUDGE_HEAT_FORMAT_V3 || judgeHeatScreenedFormat(format)) return 'v2';
  throw new RangeError(`${JSON.stringify(format)} is not a judge heat record's format (${JUDGE_HEAT_FORMATS.join(', ')})`);
}

// ---------------------------------------------------------------- the record

const whenValid = { when: (payload: { issues: readonly unknown[] }): boolean => payload.issues.length === 0 };

/**
 * One request of a call, in the order sent: grader/judge-call.ts JudgeAttempt, field for field. What was sent and
 * what came back (the response stored as a blob before it was read), the model that answered, its usage in the
 * cassette's token classes and its price (priceUsage at `at`, micro-USD), and why it gave no verdict.
 */
export const JudgeHeatAttempt = z.strictObject({
  form: z.enum(JUDGE_CALL_FORMS),
  request_sha256: Sha256Hex,
  request_bytes: z.int().min(0),
  at: IsoDateTime,
  status: z.int().min(100).max(599),
  response_body_sha256: Sha256Hex,
  model_answered: z.string().nullable(),
  finish_reason: z.string().nullable(),
  /** Null when the answer carried none. */
  usage: CassetteUsage.nullable(),
  /** A u64 decimal; null when a 2xx answer carried no usage it could be priced by. */
  micro_usd: U64.nullable(),
  /** Null for the attempt that gave the verdict. */
  invalid: z.string().min(1).nullable(),
  /** Who served it, as OpenRouter's answer names them: an attempt sent to an openrouter judge's only; absent when none is named. */
  provider: z.string().min(1).optional(),
});
export type JudgeHeatAttemptT = z.infer<typeof JudgeHeatAttempt>;

/**
 * One call of the heat, in the order it ran: its pair and slot order, then grader/judge-call.ts JudgeCallResult's
 * verdict, margin (a v2 call's), reason, invalid, the last attempt's request, response blob and answering model, the
 * attempts' usage and price summed, and every attempt (judgeHeatCallIssues holds them together; judgeHeatCallOf builds
 * one).
 */
export const JudgeHeatCall = z.strictObject({
  stage: z.enum(JUDGE_CALL_STAGES),
  round: z.int().min(0),
  a: Sha256Hex,
  b: Sha256Hex,
  slot_order: z.enum(JUDGE_SLOT_ORDERS),
  /** Its judge, an index into the setup's `judges`: present exactly when the setup lists them (the header's judges). */
  judge: z.int().min(0).optional(),
  /** The slot that won; null when no attempt gave a verdict (an invalid call). */
  verdict: z.enum(JUDGE_VERDICTS).nullable(),
  /**
   * How far the winner is ahead, JUDGE_MARGIN_MIN (by a hair) to JUDGE_MARGIN_MAX (overwhelmingly); null exactly when
   * the verdict is. Present on every call of a v2 record, absent on every call of a v1 record (judgeHeatRecordIssues).
   */
  margin: z.int().min(JUDGE_MARGIN_MIN).max(JUDGE_MARGIN_MAX).nullable().optional(),
  /** The judge's reason; null with the verdict. */
  reason: z.string().max(JUDGE_REASON_MAX).nullable(),
  /** Why the last attempt gave no verdict; null when one did. */
  invalid: z.string().min(1).nullable(),
  request_sha256: Sha256Hex,
  response_body_sha256: Sha256Hex,
  model_answered: z.string().nullable(),
  /** Every attempt's usage summed; null when none carried any. */
  usage: CassetteUsage.nullable(),
  /** Every attempt's price summed, a u64 decimal (an unpriced attempt adds nothing). */
  micro_usd: U64,
  attempts: z.array(JudgeHeatAttempt).min(1).max(JUDGE_CALL_MAX_ATTEMPTS),
});
export type JudgeHeatCallT = z.infer<typeof JudgeHeatCall>;

/** One game: a pair's two calls (the header's game), its `a` and `b` as the pairing named them. */
export const JudgeHeatGame = z.strictObject({
  stage: z.enum(JUDGE_CALL_STAGES),
  round: z.int().min(0),
  a: Sha256Hex,
  b: Sha256Hex,
  result: z.enum(JUDGE_GAME_RESULTS),
  /**
   * `a`'s twentieths of the game, 0 to JUDGE_GAME_POINTS (judgeGamePoints): its two calls' tenths summed, `b` holding the
   * rest. Present on every game of a v2 record, absent on every game of a v1 record (judgeHeatRecordIssues).
   */
  a_points: z.int().min(0).max(JUDGE_GAME_POINTS).optional(),
  /**
   * The judge that judged it, an index into the setup's `judges` (its first call's): present exactly on every game of a
   * v5 or v6 record (the header's panel final and dealt final: a v6 Swiss or race game names the member it was dealt),
   * absent on every other record's, so theirs are the bytes they were.
   */
  judge: z.int().min(0).optional(),
});
export type JudgeHeatGameT = z.infer<typeof JudgeHeatGame>;

/**
 * One field member (the header's field): a distinct artifact, its size, the anchor files that hold it (`anchor` exactly
 * when there is one), the ladder's rung files that hold it (a v3 record's, present exactly when there is one) and the
 * entries whose artifact it is, each list in code-unit order. A member is an anchor, a rung or an entry (or several:
 * byte-identical artifacts share one member).
 */
export const JudgeFieldMember = z
  .strictObject({
    artifact_sha256: Sha256Hex,
    /**
     * The artifact's size in bytes: what an exact win-rate tie falls to after head-to-head (the smaller first). Present
     * on every member of a v2 or v3 record, absent on every member of a v1 record (judgeHeatRecordIssues).
     */
    artifact_bytes: z.int().min(0).optional(),
    anchor: z.boolean(),
    /** Paths under <judge.dir>/anchors/. */
    anchor_files: z.array(BundlePath),
    /** Paths under <ladder dir>/rungs/: a v3 record's only, and only on a member a rung file holds. */
    rung_files: z.array(BundlePath).min(1).optional(),
    entries: z.array(ScrapeEntryId),
  })
  .refine((m) => m.anchor === m.anchor_files.length > 0, { message: 'a member is an anchor exactly when an anchor file holds it', path: ['anchor'], ...whenValid })
  .refine((m) => m.anchor_files.length + (m.rung_files?.length ?? 0) + m.entries.length > 0, { message: 'a member is an anchor, a rung or an entry', path: ['entries'], ...whenValid });
export type JudgeFieldMemberT = z.infer<typeof JudgeFieldMember>;

const Share = Fixed9.refine((s) => parseFixed9(s) >= 0n && parseFixed9(s) <= FIXED9_SCALE, {
  message: 'a share: at least 0, at most 1',
  when: (payload) => payload.issues.length === 0,
});

/**
 * The house's own words in every request of a heat (grader/judge-call.ts JudgeHouseText): the system prompt's
 * suffix, the user message's last line, an entry's heading (`{slot}` filled), a text entry's frame line (`{tag}`,
 * `{slot}` filled) and the verdict tool's description. A request is rebuilt from the record's, never from the
 * code's current wording; the verdict's JSON schema and the entry tag are structure, and stay the code's.
 */
export const JudgeHouseText = z.strictObject({
  verdict_instructions: z.string(),
  answer_line: z.string(),
  entry_heading: z.string(),
  entry_frame: z.string(),
  verdict_tool_description: z.string(),
  /** A compact dossier heat's (judge-call.ts judgeDossierText): the characters each dossier's text was cut to; absent, sent whole. */
  dossier_text_max: z.int().min(JUDGE_DOSSIER_TEXT_MIN).optional(),
});
export type JudgeHouseTextT = z.infer<typeof JudgeHouseText>;

/**
 * The judge view policies a setup may name (the header's judge view): server/judging/dossier-view-budget.ts
 * DOSSIER_VIEW_POLICY_NAMES, written out here so a record parses and rebuilds without loading the modules that make
 * views (and sharp with them); tests/unit/dossier-view-v2.test.ts holds the two lists equal.
 */
export const JUDGE_VIEW_POLICIES = ['dossier-view/v1', 'dossier-view/v2'] as const;
export type JudgeViewPolicy = (typeof JUDGE_VIEW_POLICIES)[number];
/**
 * The default policy (server/judging/dossier-view.ts DOSSIER_VIEW_POLICY): a dossier heat planned now names its
 * contest's (dossierViewPolicyOf), this one unless its contest has a DOSSIER_VIEW_POLICIES row.
 */
export const JUDGE_VIEW_POLICY = JUDGE_VIEW_POLICIES[0];

/**
 * A dossier heat's judge view (the header's judge view): the policy its views were made under, and every member's
 * artifact sha256 to the sha256 of the view blob its calls sent in its place.
 */
export const JudgeHeatJudgeView = z.strictObject({
  policy: z.enum(JUDGE_VIEW_POLICIES),
  views: z.record(Sha256Hex, Sha256Hex),
});
export type JudgeHeatJudgeViewT = z.infer<typeof JudgeHeatJudgeView>;

/** A ladder member's fixed strength (the header's ladder): its artifact and the calibration's strength, Fixed9. */
export const JudgeLadderStrength = z.strictObject({
  artifact_sha256: Sha256Hex,
  /** Above 0 and below 2^53 billionths (grader/judge-ladder.ts judgeLadderFromFixed9). */
  strength: Fixed9,
});
export type JudgeLadderStrengthT = z.infer<typeof JudgeLadderStrength>;

/**
 * A ladder heat's money-place scrutiny (the header's ladder), a screened bundle's dev phase's: the line, in millionths on
 * the board's dev scale (E against the judge anchors: the K-th best dev interval low when the heat set up), and the
 * adaptive rounds an entry whose interval high over its first games reaches it plays on top (the bundle's
 * `screened.dev_rounds`, at least 1: a bundle with none records no scrutiny).
 */
export const JudgeHeatLadderScrutiny = z.strictObject({
  line_micro: z.int().min(0).max(JUDGE_MICRO),
  rounds: z.int().min(1).max(PROGRAM_JUDGE_LADDER_MAX.rounds),
});
export type JudgeHeatLadderScrutinyT = z.infer<typeof JudgeHeatLadderScrutiny>;

/**
 * What a provisional heat on a ladder plays against and rates by (the header's ladder): the sealed ladder dir's tree
 * digest and its calibration record's sha256, every other member's fixed strength in sha256 order, the calibration's
 * dispersion, the adaptive design: `rounds` rounds of `games` games, each round over the `spread` most informative
 * members, and, on a screened bundle's dev heat, its `scrutiny` (absent on every other, so a record before it is the bytes
 * it was). Each number is held to the bundle's bounds (contracts/competition.ts PROGRAM_JUDGE_LADDER_MAX), so a record
 * read from outside cannot plan a call list longer than a bundle's ladder makes.
 */
export const JudgeHeatLadder = z.strictObject({
  ladder_sha256: Sha256Hex,
  calibration_sha256: Sha256Hex,
  strengths: z.array(JudgeLadderStrength),
  /** phi, the calibration's pooled within-pair dispersion (grader/judge-ladder.ts judgeLadderDispersion). */
  dispersion: Fixed9,
  rounds: z.int().min(0).max(PROGRAM_JUDGE_LADDER_MAX.rounds),
  games: z.int().min(1).max(PROGRAM_JUDGE_LADDER_MAX.games),
  spread: z.int().min(1).max(PROGRAM_JUDGE_LADDER_MAX.spread),
  scrutiny: JudgeHeatLadderScrutiny.optional(),
});
export type JudgeHeatLadderT = z.infer<typeof JudgeHeatLadder>;

/**
 * Why a final entrant member has no dev rating the screen reads (the header's screened final): its entry has no dev
 * record on the bundle's ladder, the record is not a complete one, it was judged by another judge than the final's, or
 * it rated another artifact than the one the final judges. An unrated member is never screened out: it enters at the line.
 */
export const JUDGE_SCREEN_UNRATED = ['no_record', 'incomplete', 'other_judge', 'other_artifact'] as const;
export type JudgeScreenUnratedT = (typeof JUDGE_SCREEN_UNRATED)[number];

const screenMicro = z.int().min(0).max(JUDGE_MICRO);

/**
 * A rated member's contender sub-rating (the header's screened final): its rating from the sealed dev contender rounds
 * (agent-fun/judge-contender/v1), read from the chain whose head is `record_sha256` (the screen's
 * `contender.record_sha256`): the contender fit's strength p^ and log-scale se (Fixed9: strength above 0, se from 0).
 * It sets the screen's line and the member's place in it and in round 0's order, and nothing else: it carries no
 * millionths, since no score ever reads a contender verdict.
 */
export const JudgeScreenContenderRating = z.strictObject({
  record_sha256: Sha256Hex,
  strength: Fixed9,
  se: Fixed9,
});
export type JudgeScreenContenderRatingT = z.infer<typeof JudgeScreenContenderRating>;

/**
 * A rated member's dev rating (the header's screened final): the dev ladder record it was read from, its strength p^
 * and log-scale standard error (Fixed9: strength above 0, se from 0, each below 2^53 billionths), and the dev score the
 * board showed (win rate, se and interval in millionths, E against the judge anchors): its house-only dev rating, and
 * what a screened-out score carries, always. `contender` (absent when none) is its contender sub-rating
 * (JudgeScreenContenderRating): the screen reads it in place of the house-only strength and se, for the line, the cut and
 * the round-0 order only, and still keeps a member the house-only rating keeps (judgeHeatScreenOf's floor); a score never
 * reads it.
 */
export const JudgeScreenRating = z.strictObject({
  record_sha256: Sha256Hex,
  strength: Fixed9,
  se: Fixed9,
  win_rate_micro: screenMicro,
  se_micro: screenMicro,
  interval_low_micro: screenMicro,
  interval_high_micro: screenMicro,
  contender: JudgeScreenContenderRating.optional(),
});
export type JudgeScreenRatingT = z.infer<typeof JudgeScreenRating>;

/** A final entrant member's screen input: its dev rating, or why it has none. */
export const JudgeScreenMember = z.union([
  z.strictObject({ artifact_sha256: Sha256Hex, rated: JudgeScreenRating }),
  z.strictObject({ artifact_sha256: Sha256Hex, unrated: z.enum(JUDGE_SCREEN_UNRATED) }),
]);
export type JudgeScreenMemberT = z.infer<typeof JudgeScreenMember>;

/**
 * The sealed dev contender chain a screen's contender ratings come from (agent-fun/judge-contender/v1, the header's
 * screened final): its head record's sha256 and how many rounds it holds (round 0 to rounds - 1, chained by `prev`).
 * Present exactly when some member's rating carries a `contender` sub-rating, each such sub-rating naming this head.
 */
export const JudgeHeatScreenContender = z.strictObject({
  record_sha256: Sha256Hex,
  rounds: z.int().min(1),
});
export type JudgeHeatScreenContenderT = z.infer<typeof JudgeHeatScreenContender>;

/**
 * What a screened final's screen reads, fixed before its first call (grader/worker.ts builds it from the dev records;
 * a partial keeps it): one input per entrant member (a member an entry's artifact is), in the field's sha256 order, and
 * each anchor member's calibration strength (Fixed9, above 0), in sha256 order; and, when some member's rating carries
 * a contender sub-rating, the contender chain it was read from (`contender`, absent otherwise).
 */
export const JudgeHeatScreenInputs = z.strictObject({
  members: z.array(JudgeScreenMember),
  anchor_strengths: z.array(JudgeLadderStrength),
  contender: JudgeHeatScreenContender.optional(),
});
export type JudgeHeatScreenInputsT = z.infer<typeof JudgeHeatScreenInputs>;

/**
 * A v4 record's screen (the header's screened final): the screen's inputs, with z (Fixed9, the interval's width in
 * standard errors) and line_places, M (contracts/competition.ts judgeShortlistPlaces): the line is the M-th best interval
 * low among the contender-rated members (on their contender sub-ratings) when at least M are, else among the rated
 * members, and a member the house-only screen keeps is never cut (judgeHeatScreenOf's floor); and the contender chain those sub-ratings come from (`contender`, absent when no member carries one: such a
 * screen is the bytes it was).
 */
export const JudgeHeatScreen = z.strictObject({
  z: Fixed9,
  line_places: z.int().min(1),
  members: z.array(JudgeScreenMember),
  anchor_strengths: z.array(JudgeLadderStrength),
  contender: JudgeHeatScreenContender.optional(),
});
export type JudgeHeatScreenT = z.infer<typeof JudgeHeatScreen>;

/** A prize boundary a v4 heat races (grader/judge-race.ts judgeRaceTiers): the place above it, and the most games an entrant races it for. */
export const JudgeHeatRaceTier = z.strictObject({
  place: z.int().min(1),
  cap: z.int().min(1),
});

/**
 * A v4 record's race (the header's screened final), the bundle's ProgramJudgeScreened numbers: z, phi_margin and epsilon
 * (Fixed9), race_cap and race_cap_max (the games at the smallest prize drop, the most at any: race_cap_max is also the
 * race's most epochs, and max(M x race_cap_max, ceil(|S| / 2)) its most games, judgeRaceBudget), epoch_calls,
 * top_repeats, and the tiers judgeRaceTiers drew from the prizes, in place order.
 */
export const JudgeHeatRace = z.strictObject({
  z: Fixed9,
  phi_margin: Fixed9,
  epsilon: Fixed9,
  race_cap: z.int().min(1),
  race_cap_max: z.int().min(1),
  epoch_calls: z.int().min(2),
  top_repeats: z.int().min(0),
  tiers: z.array(JudgeHeatRaceTier),
});
export type JudgeHeatRaceT = z.infer<typeof JudgeHeatRace>;

/**
 * A v5 or v6 record's playoff panel (the header's panel final): the sealed pool (server/judging/panel.ts JudgePanelPool,
 * the bundle's `<judge.dir>/panel.json`) and its sha256, the drand beacon it was drawn on (its chain, round and
 * signature), the draw (judgePanelDraw) and the pool's order under it (judgePanelOrder): the judges seated are the
 * members at order[0..JUDGE_PANEL_SIZE-1] (a v6 record's: every member, in that order, the first JUDGE_PANEL_SIZE its
 * playoff seats). Fixed before the first call; a partial keeps it.
 */
export const JudgeHeatPanel = z.strictObject({
  pool_sha256: Sha256Hex,
  pool: JudgePanelPool,
  beacon: JudgePanelBeacon,
  draw: Sha256Hex,
  order: z.array(z.int().min(0)).min(JUDGE_PANEL_POOL_MIN).max(JUDGE_PANEL_POOL_MAX),
});
export type JudgeHeatPanelT = z.infer<typeof JudgeHeatPanel>;

/** What a heat is before its calls: everything that plans them. */
const setupShape = {
  /**
   * JUDGE_HEAT_FORMAT for a final heat and a provisional heat with no ladder run now; JUDGE_HEAT_FORMAT_V3 for a
   * calibration and a provisional heat on a ladder; JUDGE_HEAT_FORMAT_V4 for a screened final; JUDGE_HEAT_FORMAT_V5 for
   * a panel final; JUDGE_HEAT_FORMAT_V6 for a dealt panel final; JUDGE_HEAT_FORMAT_V1 for a record written before the
   * margin.
   */
  format: z.enum(JUDGE_HEAT_FORMATS),
  stage: z.enum(JUDGE_HEAT_STAGES),
  phase_seed: U64,
  /** judgeHeatSeed(phase_seed, format). */
  seed: Sha256Hex,
  /** The house judge: the model call (its model, prompt file and parameters) and the judge directory's tree digest. */
  agent: JudgeAgent,
  /** The judges its calls were sent to (the header's judges); absent when the agent's one named model judged on its door. */
  judges: z.array(JudgeOfHeat).min(1).max(JUDGE_POOL_MAX).optional(),
  judge_sha256: Sha256Hex,
  media: z.enum(PROGRAM_JUDGE_MEDIA),
  /** The house text the heat's requests are built from (JUDGE_HOUSE_TEXT when it ran; a judge view heat's, JUDGE_HOUSE_TEXT_DOSSIER_VIEW). */
  house_text: JudgeHouseText,
  /** A dossier heat's judge view (the header's judge view): absent on every heat that sends its dossiers whole. */
  judge_view: JudgeHeatJudgeView.optional(),
  /** The output file each entry's artifact is read from. */
  artifact: BundlePath,
  /** The Swiss rounds (a provisional heat's and a calibration's: 0; a ladder's adaptive rounds are its `ladder.rounds`). */
  rounds: z.int().min(0),
  /** judgePlayoffPlaceCount: the most finalists the playoff takes (a provisional heat's and a calibration's: 0). */
  playoff_places: z.int().min(0),
  /** The times each playoff pair is judged (a provisional heat's and a calibration's: 0). */
  playoff_repeats: z.int().min(0),
  invalid_share_max: Share,
  /** The members, in sha256 order. */
  field: z.array(JudgeFieldMember),
  /** A calibration's (and only a calibration's): the times every pair of members is judged, both slot orders each time. */
  repeats: z.int().min(1).optional(),
  /** A provisional heat's on a ladder (a v3 one's, and only its): what it plays against and rates by. */
  ladder: JudgeHeatLadder.optional(),
  /** A screened final's (a v4, v5 or v6 record's, and only its): the dev ratings its shortlist is drawn by. */
  screen: JudgeHeatScreen.optional(),
  /** A screened final's (a v4, v5 or v6 record's, and only its): its racing numbers and prize boundaries. */
  race: JudgeHeatRace.optional(),
  /** A panel final's (a v5 or v6 record's, and only its): the playoff panel drawn from the bundle's sealed pool. */
  panel: JudgeHeatPanel.optional(),
};

/** A heat's setup: a record before its calls. What the schedule (judgeHeatSchedule) plans from. */
export const JudgeHeatSetup = z.strictObject(setupShape);
export type JudgeHeatSetupT = z.infer<typeof JudgeHeatSetup>;

/**
 * The calls' totals: how many, and every attempt the heat sent (its calls' and its spares'), counted, their usage and
 * price summed (micro-USD, a u64 decimal); and the heat's timing (judgeHeatTimingOf): when its first send went out,
 * when the last instant it names came, and the two's difference. The timing is all three keys or none: none on a
 * record written before it and on a heat that sent no call.
 */
export const JudgeHeatTotals = z
  .strictObject({
    calls: z.int().min(0),
    attempts: z.int().min(0),
    usage: CassetteUsage,
    micro_usd: U64,
    /** When the heat's first call was dispatched (ISO 8601, milliseconds): judgeHeatTimingOf's. */
    started_at: IsoDateTime.optional(),
    /** The last instant the record names (ISO 8601, milliseconds): the last send, or a spare's end when one came later. */
    finished_at: IsoDateTime.optional(),
    /** finished_at - started_at, whole milliseconds: judgeHeatTimingOf's. */
    elapsed_ms: z.int().min(0).optional(),
  })
  .refine(
    (t) => {
      const timing = [t.started_at, t.finished_at, t.elapsed_ms];
      if (timing.every((v) => v === undefined)) return true;
      if (timing.some((v) => v === undefined)) return false;
      const ms = Date.parse(t.finished_at!) - Date.parse(t.started_at!);
      return ms >= 0 && t.elapsed_ms === ms;
    },
    { message: 'the heat timing is all three of started_at, finished_at and elapsed_ms, and elapsed_ms is finished_at - started_at', path: ['started_at'] },
  );
export type JudgeHeatTotalsT = z.infer<typeof JudgeHeatTotals>;

/**
 * A send of a call that is not its decision (the header's spares): which call and which send, when it was sent and
 * ended, how it ended, what it answered (a verdict, margin and reason only when `late`), why it gave no verdict
 * (null only when `late`), its attempts' usage and price summed, and its attempts, none to JUDGE_CALL_MAX_ATTEMPTS
 * (judgeHeatSpareIssues holds them together; judgeHeatSpareOf builds one). Never scored.
 */
export const JudgeHeatSpare = z.strictObject({
  /** The index into the record's (or the partial's) `calls` of the call it was a send of. */
  call: z.int().min(0),
  /** 0 the call's first send, 1 and 2 its backups; the call's decision holds the send number its spares do not. */
  send: z.int().min(0).max(JUDGE_HEAT_MAX_SENDS - 1),
  sent_at: IsoDateTime,
  /** When it answered, faulted or was cancelled: not before sent_at. */
  ended_at: IsoDateTime,
  ended: z.enum(JUDGE_SPARE_ENDS),
  /** A `late` spare's verdict; null on any other. */
  verdict: z.enum(JUDGE_VERDICTS).nullable(),
  /** A `late` spare's margin, JUDGE_MARGIN_MIN to JUDGE_MARGIN_MAX; null on any other. */
  margin: z.int().min(JUDGE_MARGIN_MIN).max(JUDGE_MARGIN_MAX).nullable(),
  /** A `late` spare's reason; null on any other. */
  reason: z.string().max(JUDGE_REASON_MAX).nullable(),
  /** Why it gave no verdict: an `invalid` spare's last attempt's why, a `faulted` or `cancelled` one's fault; null when `late`. */
  invalid: z.string().min(1).nullable(),
  /** Every attempt's usage summed; null when none carried any. */
  usage: CassetteUsage.nullable(),
  /** Every attempt's price summed, a u64 decimal (an unpriced attempt adds nothing). */
  micro_usd: U64,
  attempts: z.array(JudgeHeatAttempt).max(JUDGE_CALL_MAX_ATTEMPTS),
});
export type JudgeHeatSpareT = z.infer<typeof JudgeHeatSpare>;

/** The heat record (the header's record): canonical JSON, stored as a blob named by its sha256. */
export const JudgeHeatRecord = z.strictObject({
  ...setupShape,
  calls: z.array(JudgeHeatCall),
  games: z.array(JudgeHeatGame),
  /** The playoff's members in Swiss-standing order; empty when no playoff ran. */
  finalists: z.array(Sha256Hex),
  totals: JudgeHeatTotals,
  /** The calls with no verdict. */
  invalid_calls: z.int().min(0),
  /** The calls' other sends, ordered by call, then send (the header's spares); absent, never empty, when there are none. */
  spares: z.array(JudgeHeatSpare).min(1).optional(),
});
export type JudgeHeatRecordT = z.infer<typeof JudgeHeatRecord>;

/** The record's canonical JSON and its sha256: the blob it is stored as. */
export function judgeHeatRecordDigest(record: JudgeHeatRecordT): { json: string; sha256: string } {
  const json = canonicalJson(JudgeHeatRecord.parse(record));
  return { json, sha256: sha256Hex(json) };
}

// ---------------------------------------------------------------- the seed and the draws

/**
 * The heat's seed (the header's seed): sha256(utf8(format) || 0x00 || utf8(phase seed)), lowercase hex. `format` is the
 * record's own (default JUDGE_HEAT_FORMAT, a heat run now): a v1 record re-derives its v1 seed.
 */
export function judgeHeatSeed(phaseSeed: string, format: JudgeHeatFormatT = JUDGE_HEAT_FORMAT): string {
  if (!U64.safeParse(phaseSeed).success) throw new RangeError(`the phase seed ${JSON.stringify(phaseSeed)} is not a u64 decimal`);
  if (!isHeatFormat(format)) throw new RangeError(`${JSON.stringify(format)} is not a judge heat record's format (${JUDGE_HEAT_FORMATS.join(', ')})`);
  return createHash('sha256').update(format, 'utf8').update(Buffer.from([0])).update(phaseSeed, 'utf8').digest('hex');
}

function checkSeed(seed: string): void {
  if (!Sha256Hex.safeParse(seed).success) throw new RangeError('the seed is 64 lowercase hex');
}

function checkRound(round: number): void {
  if (!Number.isSafeInteger(round) || round < 0 || round > 0xffff_ffff) throw new RangeError(`round ${String(round)} is not a whole number from 0 to ${0xffff_ffff}`);
}

function checkMembers(members: readonly string[]): void {
  for (const m of members) if (!Sha256Hex.safeParse(m).success) throw new TypeError(`${JSON.stringify(m)} is not a member (an artifact's lowercase hex sha256)`);
  if (new Set(members).size !== members.length) throw new TypeError('the field lists a member twice');
}

/**
 * Round 1's order (the header's seed): scrapeHeatOrder of the seed, stage `main`, round 0, over the members' places
 * in sha256 order (equal-width decimal labels, which sort as the places do), mapped back to the members. order[0]
 * ranks first.
 */
export function judgeHeatOrder(seed: string, members: readonly string[]): string[] {
  checkSeed(seed);
  checkMembers(members);
  if (members.length === 0) return [];
  const sorted = [...members].sort(compareCodeUnits);
  const width = String(sorted.length - 1).length;
  const labels = sorted.map((_, i) => String(i).padStart(width, '0'));
  return scrapeHeatOrder(seed, 'main', 0, labels).map((label) => sorted[Number(label)]!);
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** Which slot order of the pair (a, b) runs first in a stage's round (the header's seed). The other runs second. */
export function judgeSlotOrder(seed: string, stage: JudgeCallStageT, round: number, a: string, b: string): JudgeSlotOrderT {
  checkSeed(seed);
  if (!(JUDGE_CALL_STAGES as readonly string[]).includes(stage)) throw new RangeError(`stage ${JSON.stringify(stage)} is not one of ${JUDGE_CALL_STAGES.join(', ')}`);
  checkRound(round);
  checkMembers([a, b]);
  const digest = createHash('sha256')
    .update('slot', 'utf8')
    .update(Buffer.from([0]))
    .update(Buffer.from(seed, 'hex'))
    .update(stage, 'utf8')
    .update(Buffer.from([0]))
    .update(u32be(round))
    .update(Buffer.from(a, 'hex'))
    .update(Buffer.from(b, 'hex'))
    .digest();
  return (digest[0]! & 1) === 0 ? 'ab' : 'ba';
}

function otherOrder(o: JudgeSlotOrderT): JudgeSlotOrderT {
  return o === 'ab' ? 'ba' : 'ab';
}

// ---------------------------------------------------------------- the fit

/** One member's fit: its strength p, its expected win rate E against the field and E's standard error. */
export interface JudgeFitT {
  p: number;
  e: number;
  se: number;
}

/**
 * Bradley-Terry over `games` (the header's fit and score): every member's strength, expected win rate and standard
 * error, keyed by member. A game with a_points (v2) is the soft outcome a_points / 20 to `a` and the rest to `b`; one
 * without (v1) a whole win to its result's side, or half each for a draw. The members are taken in sha256 order and the
 * games folded into counts first, so the result is the same bits for any order of either. At least two members; every
 * game between two of them, its a_points (when present) a whole number from 0 to JUDGE_GAME_POINTS.
 */
export function judgeFit(members: readonly string[], games: readonly Pick<JudgeHeatGameT, 'a' | 'b' | 'result' | 'a_points'>[]): Map<string, JudgeFitT> {
  checkMembers(members);
  if (members.length < 2) throw new RangeError('a fit takes at least two members');
  const sorted = [...members].sort(compareCodeUnits);
  const n = sorted.length;
  const at = new Map(sorted.map((m, i) => [m, i]));
  // Twentieths of a win, the virtual draw's half a win (10) each: whole numbers, so the fold is exact in any order.
  const half = JUDGE_GAME_POINTS / 2;
  const units = new Array<number>(n).fill(half);
  const counts = new Map<number, number>();
  for (const g of games) {
    const i = at.get(g.a);
    const j = at.get(g.b);
    if (i === undefined || j === undefined) throw new RangeError(`a game between ${g.a} and ${g.b} names a member outside the field`);
    if (i === j) throw new RangeError(`a game of ${g.a} against itself`);
    if (g.a_points !== undefined) {
      if (!Number.isSafeInteger(g.a_points) || g.a_points < 0 || g.a_points > JUDGE_GAME_POINTS) throw new RangeError(`a game's a_points ${String(g.a_points)} is not a whole number from 0 to ${JUDGE_GAME_POINTS}`);
      units[i] += g.a_points;
      units[j] += JUDGE_GAME_POINTS - g.a_points;
    } else if (g.result === 'a') units[i] += JUDGE_GAME_POINTS;
    else if (g.result === 'b') units[j] += JUDGE_GAME_POINTS;
    else {
      units[i] += half;
      units[j] += half;
    }
    const key = i < j ? i * n + j : j * n + i;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Each member's opponents in member order, with the games against each.
  const opponents: Array<Array<[number, number]>> = sorted.map(() => []);
  for (const [key, c] of [...counts].sort((x, y) => x[0] - y[0])) {
    const i = Math.floor(key / n);
    const j = key - i * n;
    opponents[i]!.push([j, c]);
    opponents[j]!.push([i, c]);
  }
  for (const list of opponents) list.sort((x, y) => x[0] - y[0]);
  // One division each, exact: a v1 record's wins are the same bits its half-wins / 2 gave.
  const wins = units.map((u) => u / JUDGE_GAME_POINTS);
  let p = new Array<number>(n).fill(1);
  for (let iter = 0; iter < JUDGE_BT_ITERATIONS; iter++) {
    const next = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const pi = p[i]!;
      let denom = 1 / (pi + 1);
      for (const [j, c] of opponents[i]!) denom += c / (pi + p[j]!);
      next[i] = wins[i]! / denom;
    }
    p = next;
  }
  const out = new Map<string, JudgeFitT>();
  for (let i = 0; i < n; i++) {
    const pi = p[i]!;
    let e = 0;
    let slope = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const s = pi + p[j]!;
      e += pi / s;
      slope += (pi * p[j]!) / (s * s);
    }
    let info = pi / ((pi + 1) * (pi + 1));
    for (const [j, c] of opponents[i]!) {
      const s = pi + p[j]!;
      info += (c * pi * p[j]!) / (s * s);
    }
    out.set(sorted[i]!, { p: pi, e: e / (n - 1), se: slope / (n - 1) / Math.sqrt(info) });
  }
  return out;
}

/**
 * A heat's overdispersion phi around its own fit: the Pearson statistic of its games over their degrees of freedom,
 * sum (s - pi)^2 / sum pi (1 - pi) times m / (m - k), for m games, k the fit's members, s a game's share of a win to
 * its lower-sha256 member (a_points / 20 from that side; a v1 game's 1, 0 or 1/2) and pi that member's fitted
 * Bradley-Terry chance p_lo / (p_lo + p_hi). At least JUDGE_LADDER_PHI_MIN; 1 (judgeFit's own SE) when m <= k or no
 * game is informative. judgeFit's SE assumes phi = 1, and a final's judge is less noisy than a binomial (phi near 0.1
 * on the finals measured): SE x sqrt(phi) is its overdispersion-scaled SE. No record format reads it yet, so no
 * existing score or interval moves. The games are folded into whole-number counts per pair (games, twentieths and
 * their squares) and summed in sha256 order of the pairs, so the result is the same bits for any order of `games`.
 */
export function judgeHeatDispersion(
  games: readonly Pick<JudgeHeatGameT, 'a' | 'b' | 'result' | 'a_points'>[],
  fit: ReadonlyMap<string, Pick<JudgeFitT, 'p'>>,
): number {
  const pairs = new Map<string, { lo: string; hi: string; r: number; u: number; uu: number }>();
  for (const g of games) {
    if (g.a === g.b) throw new RangeError(`a game of ${g.a} against itself`);
    if (!fit.has(g.a) || !fit.has(g.b)) throw new RangeError(`a game between ${g.a} and ${g.b} names a member the fit does not hold`);
    let points: number;
    if (g.a_points !== undefined) {
      if (!Number.isSafeInteger(g.a_points) || g.a_points < 0 || g.a_points > JUDGE_GAME_POINTS) throw new RangeError(`a game's a_points ${String(g.a_points)} is not a whole number from 0 to ${JUDGE_GAME_POINTS}`);
      points = g.a_points;
    } else points = g.result === 'a' ? JUDGE_GAME_POINTS : g.result === 'b' ? 0 : JUDGE_GAME_POINTS / 2;
    const aLow = compareCodeUnits(g.a, g.b) < 0;
    const lo = aLow ? g.a : g.b;
    const hi = aLow ? g.b : g.a;
    const u = aLow ? points : JUDGE_GAME_POINTS - points;
    const key = `${lo}:${hi}`;
    const pair = pairs.get(key) ?? { lo, hi, r: 0, u: 0, uu: 0 };
    pair.r += 1;
    pair.u += u;
    pair.uu += u * u;
    pairs.set(key, pair);
  }
  const m = games.length;
  if (m <= fit.size) return 1;
  let num = 0;
  let den = 0;
  for (const key of [...pairs.keys()].sort(compareCodeUnits)) {
    const { lo, hi, r, u, uu } = pairs.get(key)!;
    const pl = fit.get(lo)!.p;
    const ph = fit.get(hi)!.p;
    if (!(pl > 0) || !(ph > 0) || !Number.isFinite(pl) || !Number.isFinite(ph)) throw new RangeError(`the fit's strengths of ${lo} and ${hi} are not finite and above 0`);
    const pij = pl / (pl + ph);
    // sum (u/20 - pij)^2 over the pair's r games, from its whole-number sums of u and u^2.
    num += uu / (JUDGE_GAME_POINTS * JUDGE_GAME_POINTS) - (2 * pij * u) / JUDGE_GAME_POINTS + r * pij * pij;
    den += r * pij * (1 - pij);
  }
  if (!(den > 0)) return 1;
  return Math.max((num / den) * (m / (m - fit.size)), JUDGE_LADDER_PHI_MIN);
}

// ---------------------------------------------------------------- the Swiss

/** A Swiss pair: `a` ranked above `b`, and the slot order its first call runs in. */
export interface JudgeSwissPairT {
  a: string;
  b: string;
  first: JudgeSlotOrderT;
}

/** One Swiss round's pairing: its pairs from the top of the ranking down, and the member with the bye (null on an even field). */
export interface JudgeSwissRoundT {
  pairs: JudgeSwissPairT[];
  bye: string | null;
}

/** What the earlier rounds played: the games between each two members (judgePairKey) and each member's byes. */
export interface JudgeSwissHistoryT {
  games: ReadonlyMap<string, number>;
  byes: ReadonlyMap<string, number>;
}

/** The key of an unordered pair of members. */
export function judgePairKey(a: string, b: string): string {
  return compareCodeUnits(a, b) < 0 ? `${a}:${b}` : `${b}:${a}`;
}

/** The history of `rounds`, in any order. */
export function judgeSwissHistory(rounds: readonly JudgeSwissRoundT[]): JudgeSwissHistoryT {
  const games = new Map<string, number>();
  const byes = new Map<string, number>();
  for (const r of rounds) {
    for (const p of r.pairs) games.set(judgePairKey(p.a, p.b), (games.get(judgePairKey(p.a, p.b)) ?? 0) + 1);
    if (r.bye !== null) byes.set(r.bye, (byes.get(r.bye) ?? 0) + 1);
  }
  return { games, byes };
}

/** The members ranked by E, higher first, ties by sha256. */
function byStanding(standing: ReadonlyMap<string, number>): string[] {
  return [...standing.keys()].sort((x, y) => standing.get(y)! - standing.get(x)! || compareCodeUnits(x, y));
}

/**
 * A pairing of every member of `ranked` (an even count) with no game played before, each member from the top taking
 * the nearest one below it that leaves the rest such a pairing; null when none exists, or when the search spends the
 * budget. Pairs of indices into `ranked`, top first.
 *
 * A depth-first search with its own stack, not the call stack: one level per pair, so a recursion of n/2 frames
 * overflowed Node's default stack from about 16,000 members. `out` is the stack: level k holds the pair out[k] (its top
 * and the candidate it took), and a level that runs out of candidates backtracks into the one below it, which drops
 * its candidate and tries the next. Every step, the budget's spend included, is the recursive search's in the same
 * order, so it chooses the same pairs, the same way, for every input.
 */
export function judgeFreshPairing(ranked: readonly string[], played: (a: string, b: string) => number, budget: { left: number }): Array<[number, number]> | null {
  const n = ranked.length;
  const used = new Array<boolean>(n).fill(false);
  const out: Array<[number, number]> = [];
  // Where the next level looks for its top (the member after the last level's), or -1 to backtrack into the last level.
  let from = 0;
  for (;;) {
    let top: number;
    let c: number;
    if (from >= 0) {
      top = from;
      while (top < n && used[top]) top++;
      if (top === n) return out;
      used[top] = true;
      c = top + 1;
    } else {
      const [t, held] = out.pop()!;
      used[held] = false;
      top = t;
      c = held + 1;
    }
    let took = false;
    for (; c < n; c++) {
      if (used[c]) continue;
      if (--budget.left < 0) break;
      if (played(ranked[top]!, ranked[c]!) > 0) continue;
      used[c] = true;
      out.push([top, c]);
      took = true;
      break;
    }
    if (took) from = top + 1;
    else {
      used[top] = false;
      if (out.length === 0) return null;
      from = -1;
    }
  }
}

/** Each member from the top takes the nearest one below it that it has played least: repeats allowed. */
function leastPlayedPairing(ranked: readonly string[], played: (a: string, b: string) => number): Array<[number, number]> {
  const used = new Array<boolean>(ranked.length).fill(false);
  const out: Array<[number, number]> = [];
  for (let top = 0; top < ranked.length; top++) {
    if (used[top]) continue;
    let best = -1;
    for (let c = top + 1; c < ranked.length; c++) {
      if (!used[c] && (best === -1 || played(ranked[top]!, ranked[c]!) < played(ranked[top]!, ranked[best]!))) best = c;
    }
    used[top] = true;
    used[best] = true;
    out.push([top, best]);
  }
  return out;
}

/**
 * One Swiss round's pairing (the header's Swiss). `standing` is every Swiss member's current expected win rate (round
 * 0 ranks by the seed's order instead, or by `order` when named: a screened final's seeded order, every member of
 * `standing` once, first first), `played` what the earlier rounds played (judgeSwissHistory), and each pair's first
 * slot order is drawn from the seed (judgeSlotOrder, stage `swiss`). With no `order`, round 0 is the seed's, as ever;
 * a later round never reads it. RangeError or TypeError on a malformed argument.
 */
export function judgeSwissPairs(standing: ReadonlyMap<string, number>, played: JudgeSwissHistoryT, seed: string, round: number, order?: readonly string[]): JudgeSwissRoundT {
  checkSeed(seed);
  checkRound(round);
  checkMembers([...standing.keys()]);
  for (const [m, e] of standing) if (!Number.isFinite(e) || e < 0 || e > 1) throw new RangeError(`${m}'s expected win rate ${e} is not within [0, 1]`);
  if (order !== undefined) {
    checkMembers(order);
    if (order.length !== standing.size || order.some((m) => !standing.has(m))) throw new TypeError("round 0's order ranks every member of the standing once, and no other");
  }
  const ranked = round === 0 ? (order === undefined ? judgeHeatOrder(seed, [...standing.keys()]) : [...order]) : byStanding(standing);
  if (ranked.length < 2) return { pairs: [], bye: ranked[0] ?? null };
  const games = (a: string, b: string): number => played.games.get(judgePairKey(a, b)) ?? 0;
  const byes = (m: string): number => played.byes.get(m) ?? 0;
  // The bye's candidates: the fewest byes first, the lowest ranked first among them; none on an even field.
  const candidates =
    ranked.length % 2 === 0
      ? [null]
      : ranked
          .map((m, i) => ({ m, i }))
          .sort((x, y) => byes(x.m) - byes(y.m) || y.i - x.i)
          .map(({ m }) => m);
  const budget = { left: JUDGE_SWISS_SEARCH_STEPS };
  let chosen: { bye: string | null; rest: string[]; pairs: Array<[number, number]> } | null = null;
  for (const bye of candidates) {
    const rest = ranked.filter((m) => m !== bye);
    const pairs = judgeFreshPairing(rest, games, budget);
    if (pairs !== null) {
      chosen = { bye, rest, pairs };
      break;
    }
    if (budget.left < 0) break;
  }
  if (chosen === null) {
    const bye = candidates[0] ?? null;
    const rest = ranked.filter((m) => m !== bye);
    chosen = { bye, rest, pairs: leastPlayedPairing(rest, games) };
  }
  const { rest } = chosen;
  return {
    pairs: chosen.pairs.map(([i, j]) => ({ a: rest[i]!, b: rest[j]!, first: judgeSlotOrder(seed, 'swiss', round, rest[i]!, rest[j]!) })),
    bye: chosen.bye,
  };
}

// ---------------------------------------------------------------- the field and the setup

/** An entry of the field: its id, its artifact's sha256 and (a v2 heat's) its size in bytes. */
export interface JudgeHeatEntryInputT {
  entry: string;
  artifact_sha256: string;
  artifact_bytes?: number;
}

/** A house anchor of the field: its path under <judge.dir>/anchors/, its sha256 and (a v2 heat's) its size in bytes. */
export interface JudgeHeatAnchorInputT {
  file: string;
  artifact_sha256: string;
  artifact_bytes?: number;
}

/** A ladder rung of the field (a v3 heat's): its path under <ladder dir>/rungs/, its sha256 and its size in bytes. */
export type JudgeHeatRungInputT = JudgeHeatAnchorInputT;

/**
 * The field (the header's field): one member per distinct artifact sha256, in sha256 order, each holding its size in
 * bytes (when the entries, anchors and rungs name theirs), the anchor files, the rung files (a key only on a member one
 * holds) and the entries whose artifact it is (in code-unit order). TypeError on an entry, anchor or rung file listed
 * twice, on a malformed one, on sizes named for some and not all, or on two sizes for one artifact.
 */
export function judgeHeatField(entries: readonly JudgeHeatEntryInputT[], anchors: readonly JudgeHeatAnchorInputT[], rungs: readonly JudgeHeatRungInputT[] = []): JudgeFieldMemberT[] {
  const members = new Map<string, { bytes: number | undefined; anchor_files: string[]; rung_files: string[]; entries: string[] }>();
  const all = [...entries, ...anchors, ...rungs];
  const sized = all.filter((x) => x.artifact_bytes !== undefined).length;
  if (sized !== 0 && sized !== all.length) throw new TypeError(`${sized} of the field's ${all.length} entries, anchors and rungs name their artifact's bytes: every one does, or none`);
  const member = (sha: string, bytes: number | undefined, who: string) => {
    if (!Sha256Hex.safeParse(sha).success) throw new TypeError(`${JSON.stringify(sha)} is not an artifact's lowercase hex sha256`);
    if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0)) throw new TypeError(`${who}'s artifact bytes ${String(bytes)} is not a whole number from 0`);
    let m = members.get(sha);
    if (m === undefined) members.set(sha, (m = { bytes, anchor_files: [], rung_files: [], entries: [] }));
    else if (m.bytes !== bytes) throw new TypeError(`${who}'s artifact ${sha} is ${String(bytes)} bytes, and another's of the same sha256 ${String(m.bytes)}`);
    return m;
  };
  const seen = new Set<string>();
  for (const e of entries) {
    if (!ScrapeEntryId.safeParse(e.entry).success) throw new TypeError(`${JSON.stringify(e.entry)} is not an entry id`);
    if (seen.has(`entry ${e.entry}`)) throw new TypeError(`entry ${e.entry} is listed twice`);
    seen.add(`entry ${e.entry}`);
    member(e.artifact_sha256, e.artifact_bytes, `entry ${e.entry}`).entries.push(e.entry);
  }
  for (const a of anchors) {
    if (!BundlePath.safeParse(a.file).success) throw new TypeError(`${JSON.stringify(a.file)} is not an anchor file's path`);
    if (seen.has(`anchor ${a.file}`)) throw new TypeError(`anchor ${a.file} is listed twice`);
    seen.add(`anchor ${a.file}`);
    member(a.artifact_sha256, a.artifact_bytes, `anchor ${a.file}`).anchor_files.push(a.file);
  }
  for (const r of rungs) {
    if (!BundlePath.safeParse(r.file).success) throw new TypeError(`${JSON.stringify(r.file)} is not a rung file's path`);
    if (seen.has(`rung ${r.file}`)) throw new TypeError(`rung ${r.file} is listed twice`);
    seen.add(`rung ${r.file}`);
    member(r.artifact_sha256, r.artifact_bytes, `rung ${r.file}`).rung_files.push(r.file);
  }
  return [...members]
    .sort((x, y) => compareCodeUnits(x[0], y[0]))
    .map(([sha, m]) => ({
      artifact_sha256: sha,
      ...(m.bytes === undefined ? {} : { artifact_bytes: m.bytes }),
      anchor: m.anchor_files.length > 0,
      anchor_files: m.anchor_files.sort(compareCodeUnits),
      ...(m.rung_files.length === 0 ? {} : { rung_files: m.rung_files.sort(compareCodeUnits) }),
      entries: m.entries.sort(compareCodeUnits),
    }));
}

export interface JudgeHeatSetupOptions {
  stage: JudgeHeatStageT;
  /** The phase's seed, a u64 decimal: the seed its grade runs carry (grader/worker.ts programPlan). */
  phaseSeed: string;
  judge: Pick<ProgramJudgeT, 'agent' | 'judge_sha256' | 'media' | 'artifact' | 'rounds' | 'playoff_places' | 'playoff_repeats' | 'invalid_share_max' | 'screened' | 'panel'>;
  /**
   * A screened final's (a v4, v5 or v6 record's, and only its): every entrant member's dev rating or why it has none,
   * and the anchors' calibration strengths (the record's `screen`, with the judge's z and M). Fixed before the first
   * call: a resumed heat names its partial's.
   */
  screen?: JudgeHeatScreenInputsT;
  /**
   * A panel final's (a v5 or v6 record's, and only its): the playoff panel drawn from the bundle's sealed pool (the
   * record's `panel`: the pool and its sha256, which is the judge block's, the beacon, the draw and the order). Fixed
   * before the first call: a resumed heat names its partial's. Its seated members are the first JUDGE_PANEL_SIZE
   * `judges`; a v6 setup's `judges` are every member in drawn order, then the Swiss judge.
   */
  panel?: JudgeHeatPanelT;
  /** A final heat's: the bundle's prizes, for judgePlayoffPlaceCount (and a screened final's line M and race tiers). */
  prizes?: readonly Pick<PrizeT, 'kind' | 'place' | 'amount_usd'>[];
  /**
   * A final heat's: every kept entry that passed the gate; a provisional heat's: its one dev entry; a calibration's:
   * none. Each names its artifact's bytes for a v2 or v3 heat (its field records them); a v1 setup drops them, as v1
   * recorded none.
   */
  entries: readonly JudgeHeatEntryInputT[];
  /** The house anchors under <judge.dir>/anchors/, each with its file's bytes likewise. */
  anchors: readonly JudgeHeatAnchorInputT[];
  /** A v3 heat's: the ladder's rungs under <ladder dir>/rungs/, each with its file's bytes. */
  rungs?: readonly JudgeHeatRungInputT[];
  /** A calibration's: the times every pair of members is judged (both slot orders each time), at least 1. */
  repeats?: number;
  /** A provisional heat's on a ladder: what it plays against and rates by (the record's `ladder`). */
  ladder?: JudgeHeatLadderT;
  /**
   * The house text its requests are built from: default JUDGE_HOUSE_TEXT (a live heat), JUDGE_HOUSE_TEXT_DOSSIER_VIEW
   * with a `view`; a record's own when one is re-derived.
   */
  house?: JudgeHouseTextT;
  /**
   * A dossier heat's judge view (the record's `judge_view`, the header's judge view): the policy and each member's view
   * blob, every member named. Omitted: its dossiers are sent whole; a stored record's own when one is re-derived.
   */
  view?: JudgeHeatJudgeViewT;
  /**
   * The record's format: by default what a heat run now writes, JUDGE_HEAT_FORMAT_V3 for a calibration and a provisional
   * heat on a ladder, and for a final judgeHeatFinalFormatOf its judge: JUDGE_HEAT_FORMAT_V6 for one whose judge names
   * `screened` and a `panel` with `deal: true`, JUDGE_HEAT_FORMAT_V5 for `screened` and a `panel` without it,
   * JUDGE_HEAT_FORMAT_V4 for `screened` alone, and JUDGE_HEAT_FORMAT for any other; a stored record's own when one is
   * re-derived (a v1 record's setup, and so its seed, is v1's). A panel format names its judge's: a v6 setup's judge
   * names `deal: true`, a v5 one's no deal.
   */
  format?: JudgeHeatFormatT;
  /**
   * The judges its calls go to (the record's `judges`, the header's judges): omitted when the judge block's one named
   * model judges on its own door; a stored record's own when one is re-derived.
   */
  judges?: readonly JudgeOfHeatT[];
}

/**
 * A heat planned on judge views records the house text handed (a contest's judgeHouseTextOf, or a record's own) with
 * its entries framed as views and no dossier text cap: a view is already shortened, so the cap would cut nothing. A
 * record planned so rebuilds to the same text.
 */
function viewHouseText(house: JudgeHouseTextT | undefined): JudgeHouseTextT {
  const { dossier_text_max: _cut, ...rest } = house ?? JUDGE_HOUSE_TEXT_DOSSIER_VIEW;
  return { ...rest, entry_frame: JUDGE_HOUSE_TEXT_DOSSIER_VIEW.entry_frame };
}

/** A heat's setup from its judge and field. JudgeHeatError when it does not hold (judgeHeatSetupIssues). */
export function judgeHeatSetup(o: JudgeHeatSetupOptions): JudgeHeatSetupT {
  const final = o.stage === 'final';
  if (final && o.prizes === undefined) throw new TypeError("a final heat's playoff places follow from the prizes: name them");
  const format =
    o.format ??
    (o.stage === 'calibration' || o.ladder !== undefined
      ? JUDGE_HEAT_FORMAT_V3
      : final
        ? judgeHeatFinalFormatOf(o.judge)
        : JUDGE_HEAT_FORMAT);
  const v1 = format === JUDGE_HEAT_FORMAT_V1;
  const rungs = o.rungs ?? [];
  const panelled = judgeHeatPanelFormat(format);
  const screened = judgeHeatScreenedFormat(format) ? screenedSetupOf(o, format) : {};
  if (!judgeHeatScreenedFormat(format) && o.screen !== undefined) {
    throw new TypeError(`screen inputs are a screened final's (a ${JUDGE_HEAT_FORMAT_V4}, ${JUDGE_HEAT_FORMAT_V5} or ${JUDGE_HEAT_FORMAT_V6} record's) alone, and this setup is ${format}`);
  }
  if (!panelled && o.panel !== undefined) throw new TypeError(`a playoff panel is a panel final's (a ${JUDGE_HEAT_FORMAT_V6} or ${JUDGE_HEAT_FORMAT_V5} record's) alone, and this setup is ${format}`);
  const panel = panelled ? panelSetupOf(o, format) : {};
  const setup = {
    format,
    stage: o.stage,
    phase_seed: o.phaseSeed,
    seed: judgeHeatSeed(o.phaseSeed, format),
    agent: o.judge.agent,
    ...(o.judges === undefined ? {} : { judges: [...o.judges] }),
    judge_sha256: o.judge.judge_sha256,
    media: o.judge.media,
    house_text: o.view === undefined ? { ...(o.house ?? JUDGE_HOUSE_TEXT) } : viewHouseText(o.house),
    ...(o.view === undefined ? {} : { judge_view: { policy: o.view.policy, views: { ...o.view.views } } }),
    artifact: o.judge.artifact,
    rounds: final ? o.judge.rounds : 0,
    playoff_places: final ? judgePlayoffPlaceCount(o.judge, o.prizes!) : 0,
    playoff_repeats: final ? o.judge.playoff_repeats : 0,
    invalid_share_max: o.judge.invalid_share_max,
    field: v1
      ? judgeHeatField(
          o.entries.map((e) => ({ entry: e.entry, artifact_sha256: e.artifact_sha256 })),
          o.anchors.map((a) => ({ file: a.file, artifact_sha256: a.artifact_sha256 })),
          rungs.map((r) => ({ file: r.file, artifact_sha256: r.artifact_sha256 })),
        )
      : judgeHeatField(o.entries, o.anchors, rungs),
    ...(o.repeats === undefined ? {} : { repeats: o.repeats }),
    ...(o.ladder === undefined ? {} : { ladder: o.ladder }),
    ...screened,
    ...panel,
  };
  const issues = judgeHeatSetupIssues(setup as JudgeHeatSetupT);
  if (issues.length > 0) throw new JudgeHeatError(`the heat does not hold: ${issues.slice(0, 5).join('; ')}`);
  return JudgeHeatSetup.parse(setup);
}

/**
 * A screened final's `screen` and `race` (the header's screened final): the screen inputs with the judge's z and its line
 * M (judgeShortlistPlaces over the prizes' last paid place), and the judge's racing numbers with the tiers judgeRaceTiers
 * draws from the placement prizes. TypeError when the judge names no `screened` block or no screen inputs are named;
 * JudgeHeatError when the prizes give no tiers (their places not exactly 1 to K).
 */
function screenedSetupOf(o: JudgeHeatSetupOptions, format: JudgeHeatFormatT): { screen: JudgeHeatScreenT; race: JudgeHeatRaceT } {
  const sc = o.judge.screened;
  if (sc === undefined) throw new TypeError(`a ${format} record is a screened final's, and the judge names no screened block`);
  if (o.screen === undefined) throw new TypeError("a screened final screens its entrants on their dev ratings: name the screen inputs (each entrant member's rating, and the anchors' strengths)");
  const prizes = o.prizes ?? [];
  const placement = prizes.filter((p) => p.kind === 'placement' && p.place !== null).map((p) => ({ place: p.place!, amount: p.amount_usd }));
  let tiers: JudgeHeatRaceT['tiers'];
  try {
    tiers = judgeRaceTiers(placement, sc.race_cap, sc.race_cap_max);
  } catch (err) {
    if (err instanceof RangeError) throw new JudgeHeatError(`the race's tiers follow from the placement prizes: ${err.message}`);
    throw err;
  }
  return {
    screen: {
      z: sc.z,
      line_places: judgeShortlistPlaces(sc, lastPaidPlace(prizes)),
      members: o.screen.members.map((m) =>
        'rated' in m
          ? { artifact_sha256: m.artifact_sha256, rated: { ...m.rated, ...(m.rated.contender === undefined ? {} : { contender: { ...m.rated.contender } }) } }
          : { artifact_sha256: m.artifact_sha256, unrated: m.unrated },
      ),
      anchor_strengths: o.screen.anchor_strengths.map((a) => ({ artifact_sha256: a.artifact_sha256, strength: a.strength })),
      ...(o.screen.contender === undefined ? {} : { contender: { record_sha256: o.screen.contender.record_sha256, rounds: o.screen.contender.rounds } }),
    },
    race: {
      z: sc.z,
      phi_margin: sc.phi_margin,
      epsilon: sc.epsilon,
      race_cap: sc.race_cap,
      race_cap_max: sc.race_cap_max,
      epoch_calls: sc.epoch_calls,
      top_repeats: sc.top_repeats,
      tiers,
    },
  };
}

/**
 * A panel final's `panel` (the header's panel final and dealt final, a v5 or v6 setup's): the drawn panel named,
 * copied. TypeError when the judge names no `panel` block, when its block's deal is not the format's (a v6 setup's
 * names `deal: true`, a v5 one's none), when no panel is named, or when the panel's pool is not the one the judge block
 * names (its pool_sha256). Whether the draw, the order and the judges hold is judgeHeatSetupIssues'.
 */
function panelSetupOf(o: JudgeHeatSetupOptions, format: JudgeHeatPanelFormatT): { panel: JudgeHeatPanelT } {
  const block = o.judge.panel;
  if (block === undefined) throw new TypeError(`a ${format} record is a panel final's, and the judge names no panel block`);
  const dealt = format === JUDGE_HEAT_FORMAT_V6;
  if ((block.deal === true) !== dealt) {
    throw new TypeError(dealt ? `a ${format} record is a dealt panel final's, and the judge's panel names no deal: true` : `a ${format} record is an undealt panel final's, and the judge's panel names deal: true (a ${JUDGE_HEAT_FORMAT_V6} record's)`);
  }
  const p = o.panel;
  if (p === undefined) throw new TypeError("a panel final's playoff is judged by the panel drawn from its sealed pool: name the panel (the pool, its beacon, the draw and the order)");
  if (p.pool_sha256 !== block.pool_sha256) throw new TypeError(`the panel's pool is ${p.pool_sha256}, and the judge block names ${block.pool_sha256}`);
  return {
    panel: {
      pool_sha256: p.pool_sha256,
      pool: {
        format: p.pool.format,
        salt: p.pool.salt,
        members: p.pool.members.map((m) => ({ model: m.model, max_output_tokens: m.max_output_tokens, reasoning_effort: m.reasoning_effort, ...(m.temperature === undefined ? {} : { temperature: m.temperature }) })),
      },
      beacon: { chain: p.beacon.chain, round: p.beacon.round, signature: p.beacon.signature },
      draw: p.draw,
      order: [...p.order],
    },
  };
}

/** The most rounds a call's round number holds (judgeSlotOrder draws on it as a u32). */
const ROUND_MAX = 0xffff_ffff;

/**
 * What does not hold in a parsed setup: its seed, the field's order and lists, each member's artifact bytes as the
 * format records them (a v2 or v3 member's present, a v1 member's absent) and its rung files (a v3 member's alone), the
 * stage's format (a final heat's v1 or v2, a calibration's v3, a provisional heat's v3 exactly when it plays a ladder),
 * and the stage's numbers and field (judgeLadderIssuesOf for a ladder's).
 */
function setupIssuesOf(setup: JudgeHeatSetupT): string[] {
  const issues: string[] = [];
  if (setup.seed !== judgeHeatSeed(setup.phase_seed, setup.format)) issues.push(`seed: not judgeHeatSeed(${setup.phase_seed}, ${setup.format})`);
  const entries = new Set<string>();
  const files = new Set<string>();
  const rungFiles = new Set<string>();
  const sorted = (list: readonly string[]) => list.every((x, k) => k === 0 || compareCodeUnits(list[k - 1]!, x) < 0);
  const v1 = setup.format === JUDGE_HEAT_FORMAT_V1;
  const v3 = setup.format === JUDGE_HEAT_FORMAT_V3;
  setup.field.forEach((m, i) => {
    if (i > 0 && compareCodeUnits(setup.field[i - 1]!.artifact_sha256, m.artifact_sha256) >= 0) issues.push(`field.${i}: the members are distinct, in sha256 order`);
    if (v1 && m.artifact_bytes !== undefined) issues.push(`field.${i}.artifact_bytes: a ${JUDGE_HEAT_FORMAT_V1} member records no artifact bytes`);
    if (!v1 && m.artifact_bytes === undefined) issues.push(`field.${i}.artifact_bytes: a ${setup.format} member records its artifact's bytes`);
    if (!sorted(m.entries)) issues.push(`field.${i}.entries: distinct, in code-unit order`);
    if (!sorted(m.anchor_files)) issues.push(`field.${i}.anchor_files: distinct, in code-unit order`);
    for (const e of m.entries) {
      if (entries.has(e)) issues.push(`field.${i}.entries: ${e} is another member's too`);
      entries.add(e);
    }
    for (const f of m.anchor_files) {
      if (files.has(f)) issues.push(`field.${i}.anchor_files: ${f} is another member's too`);
      files.add(f);
    }
    if (m.rung_files !== undefined) {
      if (!v3) issues.push(`field.${i}.rung_files: a ${setup.format} member holds no rung: rungs are a ${JUDGE_HEAT_FORMAT_V3} record's`);
      if (!sorted(m.rung_files)) issues.push(`field.${i}.rung_files: distinct, in code-unit order`);
      for (const f of m.rung_files) {
        if (rungFiles.has(f)) issues.push(`field.${i}.rung_files: ${f} is another member's too`);
        rungFiles.add(f);
      }
    }
  });
  const noRounds = (who: string) => {
    if (setup.rounds !== 0 || setup.playoff_places !== 0 || setup.playoff_repeats !== 0) issues.push(`rounds: ${who} plays no Swiss rounds and no playoff (rounds, playoff_places and playoff_repeats 0)`);
  };
  if (setup.judge_view !== undefined) {
    if (setup.media !== 'dossier') issues.push(`judge_view: a dossier heat's alone, and this heat judges ${setup.media}`);
    if (v1) issues.push(`judge_view: a ${JUDGE_HEAT_FORMAT_V1} record names none`);
    const views = setup.judge_view.views;
    const members = new Set(setup.field.map((m) => m.artifact_sha256));
    for (const m of members) if (views[m] === undefined) issues.push(`judge_view.views: names no view of member ${m}`);
    for (const k of Object.keys(views)) if (!members.has(k)) issues.push(`judge_view.views.${k}: not a member of the field`);
  }
  if (setup.repeats !== undefined && setup.stage !== 'calibration') issues.push("repeats: a calibration's alone");
  if (setup.ladder !== undefined && !(v3 && setup.stage === 'provisional')) issues.push(`ladder: a ${JUDGE_HEAT_FORMAT_V3} provisional heat's alone`);
  const panelled = judgeHeatPanelFormat(setup.format);
  const dealt = setup.format === JUDGE_HEAT_FORMAT_V6;
  const screenedFormat = judgeHeatScreenedFormat(setup.format);
  if (screenedFormat && setup.stage !== 'final') issues.push(`format: a ${setup.format} record is a ${dealt ? 'dealt panel' : panelled ? 'panel' : 'screened'} final's, never a ${setup.stage} heat's`);
  for (const key of ['screen', 'race'] as const) {
    if (screenedFormat && setup[key] === undefined) issues.push(`${key}: a ${setup.format} record names its screened final's ${key}`);
    if (!screenedFormat && setup[key] !== undefined) issues.push(`${key}: a ${JUDGE_HEAT_FORMAT_V4} record's alone (or a ${JUDGE_HEAT_FORMAT_V5} or ${JUDGE_HEAT_FORMAT_V6} one's)`);
  }
  if (screenedFormat && setup.stage === 'final' && setup.screen !== undefined && setup.race !== undefined) issues.push(...screenedIssuesOf(setup, setup.screen, setup.race));
  if (panelled && setup.panel === undefined) issues.push(`panel: a ${setup.format} record names its ${dealt ? 'dealt ' : ''}panel final's drawn panel`);
  if (!panelled && setup.panel !== undefined) issues.push(`panel: a ${JUDGE_HEAT_FORMAT_V5} or ${JUDGE_HEAT_FORMAT_V6} record's alone, and this one is ${setup.format}`);
  if (panelled && setup.judges === undefined) {
    issues.push(`judges: a ${setup.format} record lists its judges: ${dealt ? "every pool member in the draw's order" : "the drawn panel's members"}, then the Swiss judge`);
  }
  if (!panelled) {
    setup.judges?.forEach((j, k) => {
      if (j.via === 'panel') issues.push(`judges.${k}.via: a panel judge is a ${JUDGE_HEAT_FORMAT_V5} record's alone (or a ${JUDGE_HEAT_FORMAT_V6} one's), and this one is ${setup.format}`);
    });
  }
  if (panelled && setup.panel !== undefined) issues.push(...panelIssuesOf(setup, setup.panel));
  if (setup.judges === undefined) {
    if (namedJudgeAgent(setup.agent) === null) issues.push("judges: a heat whose judge block names no one model (a pool, or the house's) lists the judges it called");
  } else {
    if (v1) issues.push(`judges: a ${JUDGE_HEAT_FORMAT_V1} record lists none`);
    if (setup.stage !== 'final' && setup.judges.length !== 1) issues.push(`judges: a ${setup.stage} heat is judged whole by one judge, and ${setup.judges.length} are listed`);
    setup.judges.forEach((j, k) => {
      if (j.door === 'openrouter' && j.provider === undefined) issues.push(`judges.${k}.provider: an openrouter judge names its pinned endpoints, or its requests cannot be rebuilt`);
    });
  }
  if (setup.stage === 'final') {
    if (v3) issues.push(`format: a final heat's record is ${JUDGE_HEAT_FORMAT_V1} or ${JUDGE_HEAT_FORMAT}, never ${JUDGE_HEAT_FORMAT_V3}; a screened final's is ${JUDGE_HEAT_FORMAT_V4}, a panel final's ${JUDGE_HEAT_FORMAT_V5}, a dealt panel final's ${JUDGE_HEAT_FORMAT_V6}`);
    if (setup.rounds < PROGRAM_JUDGE_MIN_ROUNDS) issues.push(`rounds: a final heat plays at least ${PROGRAM_JUDGE_MIN_ROUNDS} Swiss rounds`);
    if (setup.playoff_places < PROGRAM_JUDGE_MIN_PLAYOFF_PLACES) issues.push(`playoff_places: a final heat's playoff takes at least ${PROGRAM_JUDGE_MIN_PLAYOFF_PLACES} places`);
    if (setup.playoff_repeats < 1) issues.push("playoff_repeats: a final heat's playoff judges each pair at least once");
  } else if (setup.stage === 'calibration') {
    if (!v3) issues.push(`format: a calibration's record is ${JUDGE_HEAT_FORMAT_V3}`);
    noRounds('a calibration');
    if (setup.repeats === undefined) issues.push('repeats: a calibration judges every pair of its members at least once');
    else if (setup.repeats - 1 > ROUND_MAX) issues.push(`repeats: at most ${ROUND_MAX + 1}`);
    // Every member is an anchor or a rung: a member holds an anchor file, a rung file or an entry (JudgeFieldMember).
    if (setup.field.some((m) => m.entries.length > 0)) issues.push("field: a calibration judges the ladder's members, the anchors and the rungs, never an entry");
    if (setup.field.length < 2) issues.push('field: a calibration takes at least two members');
  } else {
    noRounds('a provisional heat');
    // Every other member is an anchor (or, on a ladder, a rung): a member holds an anchor file, a rung file or an entry.
    const subjects = setup.field.filter((m) => m.entries.length > 0);
    if (subjects.length !== 1 || subjects[0]!.entries.length !== 1) issues.push('field: a provisional heat judges one entry, against the anchors');
    else if (v3) {
      if (setup.ladder === undefined) issues.push(`ladder: a ${JUDGE_HEAT_FORMAT_V3} provisional heat plays a ladder, and names it`);
      else issues.push(...judgeLadderIssuesOf(setup, setup.ladder, subjects[0]!.artifact_sha256));
    }
  }
  return issues;
}

/**
 * What does not hold in a provisional heat's ladder (the header's ladder): the subject (the entry's member) plays every
 * other member, each an anchor or a rung, at least one of them a judge anchor (its E is over them); `strengths` names
 * exactly those members, in sha256 order, each a strength judgeLadderFromFixed9 reads; the dispersion likewise; and its
 * adaptive games' round numbers, the scrutiny's included, fit a u32.
 */
function judgeLadderIssuesOf(setup: JudgeHeatSetupT, ladder: JudgeHeatLadderT, subject: string): string[] {
  const issues: string[] = [];
  const others = setup.field.filter((m) => m.artifact_sha256 !== subject);
  others.forEach((m) => {
    if (!m.anchor && m.rung_files === undefined) issues.push(`field: ${m.artifact_sha256} is neither an anchor nor a rung: a ladder heat's entry plays the ladder alone`);
  });
  if (!others.some((m) => m.anchor)) issues.push("field: a ladder heat rates its entry against the judge anchors: at least one other member is an anchor");
  const named = ladder.strengths.map((s) => s.artifact_sha256);
  const want = others.map((m) => m.artifact_sha256);
  if (canonicalJson(named) !== canonicalJson(want)) issues.push("ladder.strengths: one fixed strength for each member but the entry's, in sha256 order");
  ladder.strengths.forEach((s, k) => {
    const off = fixed9Issue(s.strength);
    if (off !== null) issues.push(`ladder.strengths.${k}.strength: ${off}`);
  });
  const off = fixed9Issue(ladder.dispersion);
  if (off !== null) issues.push(`ladder.dispersion: ${off}`);
  if ((ladder.rounds + (ladder.scrutiny?.rounds ?? 0)) * ladder.games > ROUND_MAX) issues.push(`ladder: (rounds + scrutiny.rounds) x games is at most ${ROUND_MAX}, an adaptive game's round`);
  return issues;
}

/**
 * What does not hold in a panel final's panel (the header's panel final), sha256 alone (the beacon's BLS signature and
 * its round against the final's starts_at are the regrade's and the kit verifier's): the pool hashes to pool_sha256
 * (judgePanelPoolSha256, its canonical JSON) and has no judgePanelPoolIssues; the draw is judgePanelDraw(pool_sha256,
 * the beacon's signature) and the order judgePanelOrder of that draw over the pool's members; and the judges are laid out
 * exactly as [the seated members, order[0] to order[JUDGE_PANEL_SIZE - 1], then the Swiss judge]: each seated member's
 * judge via `panel`, on openrouter (its endpoints pinned: every setup holds an openrouter judge to its pin), its model
 * the member's, asked at most the member's output tokens and exactly its temperature (its effort is its pin's nearest,
 * server/judging/plan.ts); the Swiss judge via `overflow`, at JUDGE_HEAT_PANEL_SWISS_WEIGHT, last. A v6 setup's judges
 * (the header's dealt final, dealtJudgesIssuesOf) are every member instead, in the draw's order, then the Swiss judge.
 */
function panelIssuesOf(setup: JudgeHeatSetupT, panel: JudgeHeatPanelT): string[] {
  const issues: string[] = [];
  const sha = judgePanelPoolSha256(panel.pool);
  if (sha !== panel.pool_sha256) issues.push(`panel.pool_sha256: the pool hashes to ${sha}, not ${panel.pool_sha256}`);
  for (const i of judgePanelPoolIssues(panel.pool)) issues.push(`panel.pool: ${i}`);
  const draw = judgePanelDraw(panel.pool_sha256, panel.beacon.signature);
  if (panel.draw !== draw) issues.push(`panel.draw: the pool's sha256 and the beacon's signature draw ${draw}, not ${panel.draw}`);
  const order = judgePanelOrder(draw, panel.pool.members.length);
  if (canonicalJson(panel.order) !== canonicalJson(order)) issues.push(`panel.order: the draw orders the pool ${canonicalJson(order)}, not ${canonicalJson(panel.order)}`);
  const judges = setup.judges;
  if (judges === undefined) return issues;
  if (setup.format === JUDGE_HEAT_FORMAT_V6) return [...issues, ...dealtJudgesIssuesOf(judges, panel, order)];
  if (judges.length !== JUDGE_PANEL_SIZE + 1) issues.push(`judges: a ${JUDGE_HEAT_FORMAT_V5} record lists the ${JUDGE_PANEL_SIZE} seated members, then the Swiss judge (${JUDGE_PANEL_SIZE + 1} judges), and ${judges.length} are listed`);
  for (let k = 0; k < JUDGE_PANEL_SIZE && k < judges.length; k++) {
    const j = judges[k]!;
    const m = panel.pool.members[order[k]!]!;
    const where = `judges.${k}`;
    if (j.via !== 'panel') issues.push(`${where}.via: the panel's seat ${k} is judged via panel, and this judge is via ${j.via}`);
    if (j.door !== 'openrouter') issues.push(`${where}.door: every panel call goes to OpenRouter, and this judge is on ${j.door}`);
    if (j.model !== m.model) issues.push(`${where}.model: the panel's seat ${k} is pool member ${order[k]} (${m.model}), not ${j.model}`);
    if (j.max_output_tokens > m.max_output_tokens) issues.push(`${where}.max_output_tokens: ${m.model} is asked at most the member's ${m.max_output_tokens} output tokens, and this judge asks ${j.max_output_tokens}`);
    if (j.temperature !== m.temperature) issues.push(`${where}.temperature: ${m.model} is asked the member's temperature ${m.temperature ?? '(none named)'}, and this judge asks ${j.temperature ?? '(none named)'}`);
  }
  const k = judges.length - 1;
  const swiss = judges[k]!;
  if (judges.length > JUDGE_PANEL_SIZE) {
    if (swiss.via !== 'overflow') issues.push(`judges.${k}.via: the Swiss judge, listed last, is via overflow, and this judge is via ${swiss.via}`);
    if (swiss.weight !== JUDGE_HEAT_PANEL_SWISS_WEIGHT) issues.push(`judges.${k}.weight: the Swiss judge's weight is ${JUDGE_HEAT_PANEL_SWISS_WEIGHT}, and this judge's ${swiss.weight}`);
  }
  for (let i = JUDGE_PANEL_SIZE; i < k; i++) issues.push(`judges.${i}: a ${JUDGE_HEAT_FORMAT_V5} record lists no judge between the panel's seats and the Swiss judge`);
  return issues;
}

/**
 * What does not hold in a dealt panel final's judges (the header's dealt final), `order` the draw's order of the pool:
 * laid out exactly as [every pool member, order[0] to order[n - 1], then the Swiss judge], n the pool's size. Each
 * member's judge via `panel`, on openrouter, its model the member's, asked at most the member's output tokens and
 * exactly its temperature, at JUDGE_HEAT_PANEL_SEAT_WEIGHT (the deal of the Swiss and race games reads it, so it is held
 * here); the Swiss judge via `overflow`, at JUDGE_HEAT_PANEL_SWISS_WEIGHT, last, at index n (judgeHeatShadowOf).
 */
function dealtJudgesIssuesOf(judges: readonly JudgeOfHeatT[], panel: JudgeHeatPanelT, order: readonly number[]): string[] {
  const issues: string[] = [];
  const n = panel.pool.members.length;
  if (judges.length !== n + 1) issues.push(`judges: a ${JUDGE_HEAT_FORMAT_V6} record lists the pool's ${n} members in the draw's order, then the Swiss judge (${n + 1} judges), and ${judges.length} are listed`);
  for (let k = 0; k < n && k < judges.length; k++) {
    const j = judges[k]!;
    const m = panel.pool.members[order[k]!]!;
    const where = `judges.${k}`;
    if (j.via !== 'panel') issues.push(`${where}.via: the pool's member at draw place ${k} is judged via panel, and this judge is via ${j.via}`);
    if (j.door !== 'openrouter') issues.push(`${where}.door: every pool member's call goes to OpenRouter, and this judge is on ${j.door}`);
    if (j.model !== m.model) issues.push(`${where}.model: the draw's place ${k} is pool member ${order[k]} (${m.model}), not ${j.model}`);
    if (j.max_output_tokens > m.max_output_tokens) issues.push(`${where}.max_output_tokens: ${m.model} is asked at most the member's ${m.max_output_tokens} output tokens, and this judge asks ${j.max_output_tokens}`);
    if (j.temperature !== m.temperature) issues.push(`${where}.temperature: ${m.model} is asked the member's temperature ${m.temperature ?? '(none named)'}, and this judge asks ${j.temperature ?? '(none named)'}`);
    if (j.weight !== JUDGE_HEAT_PANEL_SEAT_WEIGHT) issues.push(`${where}.weight: a pool member's weight is ${JUDGE_HEAT_PANEL_SEAT_WEIGHT} (the deal reads it), and this judge's ${j.weight}`);
  }
  const k = judges.length - 1;
  if (judges.length > n) {
    const swiss = judges[k]!;
    if (swiss.via !== 'overflow') issues.push(`judges.${k}.via: the Swiss judge, listed last, is via overflow, and this judge is via ${swiss.via}`);
    if (swiss.weight !== JUDGE_HEAT_PANEL_SWISS_WEIGHT) issues.push(`judges.${k}.weight: the Swiss judge's weight is ${JUDGE_HEAT_PANEL_SWISS_WEIGHT}, and this judge's ${swiss.weight}`);
  }
  for (let i = n; i < k; i++) issues.push(`judges.${i}: a ${JUDGE_HEAT_FORMAT_V6} record lists no judge between the pool's members and the Swiss judge`);
  return issues;
}

/** A Fixed9 knob's bound, exclusive: 2^53 billionths, past which a number no longer holds every billionth exactly. */
const FIXED9_NUMBER_MAX = 2n ** 53n;

/** Why a Fixed9 value is not one from `lo` (above it when `above`) to `hi` (inclusive) and below FIXED9_NUMBER_MAX, or null. */
function fixed9RangeIssue(s: string, lo: bigint, o: { above?: boolean; hi?: bigint } = {}): string | null {
  const v = parseFixed9(s);
  if (o.above === true ? v <= lo : v < lo) return `${s} is not ${o.above === true ? 'above' : 'at least'} ${toFixed9(lo)}`;
  if (o.hi !== undefined && v > o.hi) return `${s} is above ${toFixed9(o.hi)}`;
  if (v >= FIXED9_NUMBER_MAX) return `${s} is 2^53 billionths or more`;
  return null;
}

/**
 * What does not hold in a screened final's screen and race (the header's screened final): the screen names one input
 * for each entrant member (a member an entry's artifact is) in the field's order, and one calibration strength for each
 * anchor member in sha256 order; every Fixed9 reads back (a strength above 0, an se from 0, z above 0 and at most
 * PROGRAM_JUDGE_SCREENED_MAX_Z, the one z of screen and race, phi_margin at least 1, epsilon from 0); a rated member's
 * dev interval holds its rate; a contender sub-rating's strength is above 0 and its se from 0, and it names the screen's
 * contender chain (its record_sha256 the head), and the screen names a chain only when some member holds a contender
 * sub-rating; the tiers are a judgeRaceTiers draw's shape (places rising within the line, each cap
 * race_cap times a whole number or race_cap_max, the smallest drop's race_cap itself); and every round number the race
 * and the playoff draw on fits a u32.
 */
function screenedIssuesOf(setup: JudgeHeatSetupT, screen: JudgeHeatScreenT, race: JudgeHeatRaceT): string[] {
  const issues: string[] = [];
  const entrants = setup.field.filter((m) => m.entries.length > 0).map((m) => m.artifact_sha256);
  if (canonicalJson(screen.members.map((m) => m.artifact_sha256)) !== canonicalJson(entrants)) {
    issues.push("screen.members: one input for each entrant member (a member an entry's artifact is), in the field's sha256 order");
  }
  const anchors = setup.field.filter((m) => m.anchor).map((m) => m.artifact_sha256);
  if (canonicalJson(screen.anchor_strengths.map((a) => a.artifact_sha256)) !== canonicalJson(anchors)) {
    issues.push('screen.anchor_strengths: one calibration strength for each anchor member, in sha256 order');
  }
  screen.anchor_strengths.forEach((a, k) => {
    const off = fixed9RangeIssue(a.strength, 0n, { above: true });
    if (off !== null) issues.push(`screen.anchor_strengths.${k}.strength: ${off}`);
  });
  screen.members.forEach((m, k) => {
    if (!('rated' in m)) return;
    const r = m.rated;
    const strength = fixed9RangeIssue(r.strength, 0n, { above: true });
    if (strength !== null) issues.push(`screen.members.${k}.rated.strength: ${strength}`);
    const se = fixed9RangeIssue(r.se, 0n);
    if (se !== null) issues.push(`screen.members.${k}.rated.se: ${se}`);
    if (r.interval_low_micro > r.win_rate_micro || r.win_rate_micro > r.interval_high_micro) issues.push(`screen.members.${k}.rated: the dev interval holds its win rate`);
    const c = r.contender;
    if (c === undefined) return;
    const cStrength = fixed9RangeIssue(c.strength, 0n, { above: true });
    if (cStrength !== null) issues.push(`screen.members.${k}.rated.contender.strength: ${cStrength}`);
    const cSe = fixed9RangeIssue(c.se, 0n);
    if (cSe !== null) issues.push(`screen.members.${k}.rated.contender.se: ${cSe}`);
    if (c.record_sha256 !== screen.contender?.record_sha256) {
      issues.push(`screen.members.${k}.rated.contender.record_sha256: a contender sub-rating is read from the screen's contender chain, its head ${screen.contender?.record_sha256 ?? '(none named)'}`);
    }
  });
  if (screen.contender !== undefined && !screen.members.some((m) => 'rated' in m && m.rated.contender !== undefined)) {
    issues.push('screen.contender: a screen names a contender chain only when some member holds a contender sub-rating');
  }
  const z = fixed9RangeIssue(screen.z, 0n, { above: true, hi: parseFixed9(PROGRAM_JUDGE_SCREENED_MAX_Z) });
  if (z !== null) issues.push(`screen.z: ${z}`);
  if (race.z !== screen.z) issues.push(`race.z: the screen's and the race's z are the judge's one z, and they are ${screen.z} and ${race.z}`);
  const phi = fixed9RangeIssue(race.phi_margin, FIXED9_SCALE);
  if (phi !== null) issues.push(`race.phi_margin: ${phi}`);
  const eps = fixed9RangeIssue(race.epsilon, 0n);
  if (eps !== null) issues.push(`race.epsilon: ${eps}`);
  if (race.race_cap > race.race_cap_max) issues.push(`race.race_cap: at most race_cap_max ${race.race_cap_max}`);
  if (race.race_cap_max - 1 > ROUND_MAX) issues.push(`race.race_cap_max: at most ${ROUND_MAX + 1}, the race's epochs (an epoch is a call's round)`);
  if (!Number.isSafeInteger(screen.line_places * race.race_cap_max)) issues.push("race.race_cap_max: line_places x race_cap_max, the race's least game budget (judgeRaceBudget), is a safe integer");
  if (setup.playoff_repeats + race.top_repeats - 1 > ROUND_MAX) issues.push(`race.top_repeats: playoff_repeats + top_repeats is at most ${ROUND_MAX + 1}, the playoff's rounds`);
  race.tiers.forEach((t, k) => {
    const prev = race.tiers[k - 1];
    if (prev !== undefined && prev.place >= t.place) issues.push(`race.tiers.${k}.place: the tiers are distinct places, in order`);
    if (t.place > screen.line_places) issues.push(`race.tiers.${k}.place: a paid place within the shortlist's line ${screen.line_places}`);
    if (t.cap > race.race_cap_max || (t.cap !== race.race_cap_max && t.cap % race.race_cap !== 0)) issues.push(`race.tiers.${k}.cap: race_cap ${race.race_cap} times a whole number, at most race_cap_max ${race.race_cap_max}`);
  });
  if (race.tiers.length > 0 && !race.tiers.some((t) => t.cap === Math.min(race.race_cap, race.race_cap_max))) issues.push(`race.tiers: the smallest prize drop races for race_cap ${race.race_cap} games`);
  return issues;
}

/** Why a Fixed9 strength or dispersion does not read back as one (judgeLadderFromFixed9), or null when it does. */
function fixed9Issue(s: string): string | null {
  try {
    judgeLadderFromFixed9(s);
    return null;
  } catch (err) {
    if (err instanceof RangeError) return err.message;
    throw err;
  }
}

/** What does not hold in a setup (none when it holds); each issue names where. */
export function judgeHeatSetupIssues(raw: JudgeHeatSetupT): string[] {
  const parsed = JudgeHeatSetup.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.') || '(setup)'}: ${i.message}`);
  return setupIssuesOf(parsed.data);
}

// ---------------------------------------------------------------- the cost

/**
 * The calls a final heat makes (the budget preflight's count): two a pair, ⌊n/2⌋ pairs in each of `rounds` Swiss
 * rounds over `n` members (an odd field's bye plays none), and `places` (places - 1) `repeats` in the playoff, which
 * runs with at least two finalists (judgeHeatFinalistCount).
 */
export function judgeHeatCalls(n: number, rounds: number, places: number, repeats: number): number {
  for (const [what, v] of [['members', n], ['rounds', rounds], ['places', places], ['repeats', repeats]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${what} ${String(v)} is not a whole number from 0`);
  }
  const swiss = 2 * Math.floor(n / 2) * rounds;
  const playoff = places < 2 ? 0 : places * (places - 1) * repeats;
  return swiss + playoff;
}

/** The calls a provisional heat makes: two an anchor it plays. */
export function judgeProvisionalCalls(anchors: number): number {
  if (!Number.isSafeInteger(anchors) || anchors < 0) throw new RangeError(`anchors ${String(anchors)} is not a whole number from 0`);
  return 2 * anchors;
}

/** The finalists a final heat's playoff takes: playoff_places, no more than its entrant members, none below two. */
export function judgeHeatFinalistCount(setup: Pick<JudgeHeatSetupT, 'stage' | 'playoff_places' | 'field'>): number {
  if (setup.stage !== 'final') return 0;
  const p = Math.min(setup.playoff_places, setup.field.filter((m) => !m.anchor).length);
  return p < 2 ? 0 : p;
}

/**
 * The calls a provisional heat on a ladder makes (the header's ladder): two a judge anchor it plays, then two each of its
 * `rounds` x `games` adaptive games.
 */
export function judgeLadderCalls(anchors: number, rounds: number, games: number): number {
  for (const [what, v] of [['anchors', anchors], ['rounds', rounds], ['games', games]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${what} ${String(v)} is not a whole number from 0`);
  }
  return 2 * anchors + 2 * rounds * games;
}

/**
 * The most calls a provisional heat on a ladder with money-place scrutiny makes (the header's ladder): judgeLadderCalls'
 * count, and two each of the `scrutinyRounds` x `games` adaptive games an entry at its line plays on top. An entry
 * whose interval stays below the line makes judgeLadderCalls(anchors, rounds, games) alone.
 */
export function judgeLadderCallsAtMost(anchors: number, rounds: number, games: number, scrutinyRounds: number): number {
  if (!Number.isSafeInteger(scrutinyRounds) || scrutinyRounds < 0) throw new RangeError(`scrutinyRounds ${String(scrutinyRounds)} is not a whole number from 0`);
  return judgeLadderCalls(anchors, rounds, games) + 2 * scrutinyRounds * games;
}

/** The calls a calibration makes (the header's ladder): every pair of its `members`, both slot orders, `repeats` times. */
export function judgeCalibrationCalls(members: number, repeats: number): number {
  for (const [what, v] of [['members', members], ['repeats', repeats]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${what} ${String(v)} is not a whole number from 0`);
  }
  return repeats * members * (members - 1 < 0 ? 0 : members - 1);
}

/** The member a provisional heat judges: the one its entry's artifact is (undefined when none is). */
function subjectOf(setup: Pick<JudgeHeatSetupT, 'field'>): string | undefined {
  return setup.field.find((m) => m.entries.length > 0)?.artifact_sha256;
}

/** The judge anchors a provisional heat's subject plays first: every anchor member but the subject's own, in sha256 order. */
function anchorsOf(setup: Pick<JudgeHeatSetupT, 'field'>, subject: string): string[] {
  return setup.field.filter((m) => m.anchor && m.artifact_sha256 !== subject).map((m) => m.artifact_sha256);
}

/**
 * The F1 screen of a screened final's setup (a v4, v5 or v6 record's, the header's screened final): grader/judge-race.ts
 * judgeScreen over its screen's inputs, at its line M and z; null on a setup of any other format. A member with a
 * contender sub-rating is screened on it (its strength and se, flagged `contender`), every other rated member on its
 * house-only dev rating: the line, the cut and the round-0 order are the only things the sub-rating moves
 * (screenedScoresOf never reads it).
 *
 * The house-only floor: with any sub-rating, a member is screened out only when BOTH screens cut it, the contender
 * screen above and the house-only one (judgeScreen over every rated member's house-only dev rating, no flag: the screen
 * with no contender block, to the bit). Contender rounds only ever keep more members than the house-only screen, never
 * cut one it keeps: the chain rates only the members it reached, and its line, drawn among them on the contender games'
 * scale, can sit above every house-only interval of a strong entrant the chain never reached. The line is the contender
 * screen's (an unrated member enters at it); a member only the floor keeps is placed in round 0's order by the rating it
 * was screened on, as every other. With no member rescued the screen is the contender screen's, every field of it. The
 * setup is taken as one that holds.
 */
export function judgeHeatScreenOf(setup: Pick<JudgeHeatSetupT, 'format' | 'screen'>): JudgeScreenT | null {
  const screen = setup.screen;
  if (!judgeHeatScreenedFormat(setup.format) || screen === undefined) return null;
  const anchors = screen.anchor_strengths;
  const members = screen.members.map((m) => {
    if (!('rated' in m)) return { artifact_sha256: m.artifact_sha256, unrated: m.unrated };
    const c = m.rated.contender;
    return { artifact_sha256: m.artifact_sha256, rated: c === undefined ? { strength: m.rated.strength, se: m.rated.se } : { strength: c.strength, se: c.se, contender: true as const } };
  });
  const flagged = judgeScreen({ members, anchors }, screen.line_places, screen.z);
  if (flagged.screened_out.length === 0 || !screen.members.some((m) => 'rated' in m && m.rated.contender !== undefined)) return flagged;
  // The house-only screen: every rated member on its house-only dev rating.
  const house = judgeScreen(
    { members: screen.members.map((m) => ('rated' in m ? { artifact_sha256: m.artifact_sha256, rated: { strength: m.rated.strength, se: m.rated.se } } : { artifact_sha256: m.artifact_sha256, unrated: m.unrated })), anchors },
    screen.line_places,
    screen.z,
  );
  const houseOut = new Set(house.screened_out);
  const screenedOut = flagged.screened_out.filter((m) => houseOut.has(m));
  if (screenedOut.length === flagged.screened_out.length) return flagged;
  // judgeScreen's round-0 keys over the kept members: an anchor at its calibration strength's log, a rated member at the
  // log of the rating it was screened on, an unrated one at the line (the bottom when there is none).
  const out = new Set(screenedOut);
  const key = new Map<string, number>(anchors.map((a) => [a.artifact_sha256, judgeRaceLog(judgeRaceNumber(a.strength, `${a.artifact_sha256}'s strength`, 0, true))]));
  for (const m of members) {
    if (out.has(m.artifact_sha256) || key.has(m.artifact_sha256)) continue;
    key.set(m.artifact_sha256, m.rated === undefined ? (flagged.line ?? -Infinity) : judgeRaceLog(judgeRaceNumber(m.rated.strength, `${m.artifact_sha256}'s strength`, 0, true)));
  }
  const shortlist = [...key.keys()].sort(compareCodeUnits);
  const order = [...shortlist].sort((x, y) => {
    const kx = key.get(x)!;
    const ky = key.get(y)!;
    return kx > ky ? -1 : kx < ky ? 1 : compareCodeUnits(x, y);
  });
  return { line: flagged.line, shortlist, order, screened_out: screenedOut };
}

/**
 * The games each playoff game of a heat's schedule is planned as (the header's panel final): a v5 or v6 record's
 * JUDGE_HEAT_PANEL_PLAYOFF_GAMES (each panel seat's, then the shadow's), every other record's 1.
 */
function playoffGamesOf(setup: Pick<JudgeHeatSetupT, 'format'>): number {
  return judgeHeatPanelFormat(setup.format) ? JUDGE_HEAT_PANEL_PLAYOFF_GAMES : 1;
}

/**
 * The shadow's index in a panel final's judges (the header's panel final and dealt final): the Swiss judge's, listed
 * last. A v5 setup's JUDGE_HEAT_PANEL_SWISS_JUDGE (after its JUDGE_PANEL_SIZE seats); a v6 setup's its pool's size n
 * (after every member). RangeError on a setup of any other format, or a v6 setup that names no panel.
 */
export function judgeHeatShadowOf(setup: Pick<JudgeHeatSetupT, 'format' | 'panel'>): number {
  if (setup.format === JUDGE_HEAT_FORMAT_V5) return JUDGE_HEAT_PANEL_SWISS_JUDGE;
  if (setup.format === JUDGE_HEAT_FORMAT_V6) {
    if (setup.panel === undefined) throw new RangeError(`a ${JUDGE_HEAT_FORMAT_V6} setup's shadow follows its pool's members, and it names no panel`);
    return setup.panel.pool.members.length;
  }
  throw new RangeError(`a shadow is a panel final's (a ${JUDGE_HEAT_FORMAT_V5} or ${JUDGE_HEAT_FORMAT_V6} record's), and this one is ${setup.format}`);
}

/**
 * Every call a heat makes, before any is made; a screened final's (v4, v5 or v6) an upper bound (grader/judge-race.ts
 * judgeScreenedCallBound over its shortlist, a v5 or v6 one's playoff and top games each JUDGE_HEAT_PANEL_PLAYOFF_GAMES times
 * over): how many it makes is the race's; a ladder heat's with scrutiny likewise
 * (judgeLadderCallsAtMost: whether its entry reaches the line is its first games'). Either is done at the schedule's
 * `complete`, which may come with fewer calls: read this as at most, never as the count a finished heat lists.
 */
export function judgeHeatPlannedCalls(setup: JudgeHeatSetupT): number {
  if (setup.stage === 'calibration') return judgeCalibrationCalls(setup.field.length, setup.repeats ?? 0);
  const screen = judgeHeatScreenOf(setup);
  if (screen !== null && setup.screen !== undefined && setup.race !== undefined) {
    return judgeScreenedCallBound(screen.shortlist.length, {
      field: setup.field.length,
      rounds: setup.rounds,
      linePlaces: setup.screen.line_places,
      raceCapMax: setup.race.race_cap_max,
      playoffPlaces: setup.playoff_places,
      playoffRepeats: setup.playoff_repeats,
      topRepeats: setup.race.top_repeats,
      playoffJudges: playoffGamesOf(setup),
    });
  }
  if (setup.stage === 'provisional') {
    const ladder = setup.ladder;
    if (ladder === undefined) return judgeProvisionalCalls(Math.max(0, setup.field.length - 1));
    const subject = subjectOf(setup);
    return judgeLadderCallsAtMost(subject === undefined ? 0 : anchorsOf(setup, subject).length, ladder.rounds, ladder.games, ladder.scrutiny?.rounds ?? 0);
  }
  return judgeHeatCalls(setup.field.length, setup.rounds, judgeHeatFinalistCount(setup), setup.playoff_repeats);
}

// ---------------------------------------------------------------- the schedule

/** A call the heat makes: its stage and round, its pair and its slot order. */
export interface JudgePlannedCallT {
  stage: JudgeCallStageT;
  round: number;
  a: string;
  b: string;
  slot_order: JudgeSlotOrderT;
  /** Its judge, an index into the setup's `judges` (the header's judges); absent when the setup lists none. */
  judge?: number;
}

/** A settled call as the schedule reads it: a v2 call's margin with its verdict. */
export type JudgeSettledCallT = Pick<JudgeHeatCallT, 'stage' | 'round' | 'a' | 'b' | 'slot_order' | 'verdict' | 'margin'>;

/** The member a call's verdict names; null with none. */
export function judgeCallWinner(c: Pick<JudgeHeatCallT, 'a' | 'b' | 'slot_order' | 'verdict'>): string | null {
  if (c.verdict === null) return null;
  return (c.verdict === 'A') === (c.slot_order === 'ab') ? c.a : c.b;
}

/**
 * A v2 call's tenths of a win for `member`, its `a` or its `b` (the header's game): 5 + margin to the member its verdict
 * picks, 5 - margin to the other, 5 each when it has no verdict; the two always sum to JUDGE_CALL_TENTHS. RangeError on
 * a member the call does not judge, or a verdict without its margin (a v1 call: its game is the binary fold).
 */
export function judgeCallTenths(c: Pick<JudgeHeatCallT, 'a' | 'b' | 'slot_order' | 'verdict' | 'margin'>, member: string): number {
  if (member !== c.a && member !== c.b) throw new RangeError(`${member} is neither member of the call between ${c.a} and ${c.b}`);
  const half = JUDGE_CALL_TENTHS / 2;
  const winner = judgeCallWinner(c);
  if (winner === null) return half;
  const m = c.margin;
  if (m === undefined || m === null || !Number.isSafeInteger(m) || m < JUDGE_MARGIN_MIN || m > JUDGE_MARGIN_MAX) {
    throw new RangeError(`the call's verdict ${String(c.verdict)} has no margin from ${JUDGE_MARGIN_MIN} to ${JUDGE_MARGIN_MAX} (${String(m)}): only a v2 call's tenths are its own`);
  }
  return winner === member ? half + m : half - m;
}

/** A v2 game's a_points from its two calls (the header's game): `a`'s tenths from each, summed, 0 to JUDGE_GAME_POINTS. */
export function judgeGamePoints(first: Pick<JudgeHeatCallT, 'a' | 'b' | 'slot_order' | 'verdict' | 'margin'>, second: Pick<JudgeHeatCallT, 'a' | 'b' | 'slot_order' | 'verdict' | 'margin'>): number {
  if (first.a !== second.a || first.b !== second.b) throw new RangeError(`a game's two calls judge one pair, not ${first.a}/${first.b} and ${second.a}/${second.b}`);
  return judgeCallTenths(first, first.a) + judgeCallTenths(second, first.a);
}

/**
 * Why a settled call is not one of a `format` record's (null when it is): a v2 call carries its margin, a whole number
 * from JUDGE_MARGIN_MIN to JUDGE_MARGIN_MAX with a verdict and null without one; a v1 call carries none.
 */
function callFormatIssue(format: JudgeHeatFormatT, c: Pick<JudgeHeatCallT, 'verdict' | 'margin'>): string | null {
  if (format === JUDGE_HEAT_FORMAT_V1) return c.margin === undefined ? null : `margin: a ${JUDGE_HEAT_FORMAT_V1} call has no margin`;
  if (c.margin === undefined) return `margin: a ${format} call carries its margin (null with no verdict)`;
  if (c.verdict === null) return c.margin === null ? null : 'margin: a call with no verdict has no margin';
  if (c.margin === null || !Number.isSafeInteger(c.margin) || c.margin < JUDGE_MARGIN_MIN || c.margin > JUDGE_MARGIN_MAX) return `margin: a verdict comes with its margin, ${JUDGE_MARGIN_MIN} to ${JUDGE_MARGIN_MAX}`;
  return null;
}

/** A game's result from a_points: `a` above half, `b` below, a draw at exactly half. */
export function judgeGameResultOf(aPoints: number): JudgeGameResultT {
  const half = JUDGE_GAME_POINTS / 2;
  return aPoints > half ? 'a' : aPoints < half ? 'b' : 'draw';
}

/**
 * A pair's game from its two calls (the header's game): in a v2 record by its points (judgeGamePoints); in a v1 record
 * the binary fold, a win only when both name the same artifact. A v5 or v6 game names `judge`, its first call's (the
 * header's panel final and dealt final); no other format's does.
 */
function gameOf(format: JudgeHeatFormatT, first: JudgeSettledCallT, second: JudgeSettledCallT, judge: number | undefined): JudgeHeatGameT {
  const game = { stage: first.stage, round: first.round, a: first.a, b: first.b };
  if (format === JUDGE_HEAT_FORMAT_V1) {
    const w1 = judgeCallWinner(first);
    const w2 = judgeCallWinner(second);
    return { ...game, result: w1 !== null && w1 === w2 ? (w1 === first.a ? 'a' : 'b') : 'draw' };
  }
  const aPoints = judgeGamePoints(first, second);
  const out: JudgeHeatGameT = { ...game, result: judgeGameResultOf(aPoints), a_points: aPoints };
  if (judgeHeatPanelFormat(format) && judge !== undefined) out.judge = judge;
  return out;
}

/**
 * The games of settled calls that run two a pair, in their order, folded as `format` folds them. A v5 or v6 game's
 * `judge` is judgeAt(k) of its first call's index k when named (the schedule's own: the judge it planned that call on;
 * a v6 Swiss or race call, dealt once the schedule is planned, has none yet), else that call's own `judge` (a record's
 * calls).
 */
function gamesOf(format: JudgeHeatFormatT, calls: readonly (JudgeSettledCallT & { judge?: number })[], judgeAt?: (k: number) => number | undefined): JudgeHeatGameT[] {
  const out: JudgeHeatGameT[] = [];
  const panelled = judgeHeatPanelFormat(format);
  for (let k = 0; k + 1 < calls.length; k += 2) {
    const first = calls[k]!;
    out.push(gameOf(format, first, calls[k + 1]!, panelled ? (judgeAt === undefined ? first.judge : judgeAt(k)) : undefined));
  }
  return out;
}

// ---------------------------------------------------------------- the panel's fold

/**
 * One playoff game slot of a v5 or v6 record (the header's panel final): its round and pair, the index of its first game in
 * the games read, its panel seats' games (seat k at index k; undefined for a seat not yet played), which of them are
 * void (seat k's game had a call come back with no verdict: judgeGamesVoidOf) and its shadow's (the Swiss judge's, null
 * until played).
 */
export interface JudgePanelSlotT {
  round: number;
  a: string;
  b: string;
  at: number;
  panel: (JudgeHeatGameT | undefined)[];
  void: boolean[];
  shadow: JudgeHeatGameT | null;
}

/**
 * Which games of `calls` folded two a pair (gamesOf: game i is calls 2i and 2i + 1) are void: a call of the pair came
 * back with no verdict. A v5 playoff seat's void game never counts toward its slot's median (judgePanelSlotGame).
 */
export function judgeGamesVoidOf(calls: readonly Pick<JudgeHeatCallT, 'verdict'>[]): (i: number) => boolean {
  return (i) => {
    const first = calls[2 * i];
    const second = calls[2 * i + 1];
    if (first === undefined || second === undefined) throw new RangeError(`game ${i} has no two calls among the ${calls.length} read`);
    return first.verdict === null || second.verdict === null;
  };
}

/**
 * The playoff game slots of a v5 or v6 record's games (the header's panel final), in the order their first game comes:
 * every playoff game grouped by (round, a, b), placed by its `judge` (a panel seat, 0 to JUDGE_PANEL_SIZE - 1, or the
 * shadow: `shadow`, judgeHeatShadowOf of the record's setup, default JUDGE_HEAT_PANEL_SWISS_JUDGE, a v5 record's), a
 * panel seat's game void where `voidAt` of its index says so (judgeGamesVoidOf; none void without it). Any other
 * stage's games are not read. RangeError on a playoff game that names no judge, one between the seats and the shadow or
 * past it, or a judge a slot has twice: no schedule plans one; or on a shadow below JUDGE_PANEL_SIZE.
 */
export function judgePanelSlotsOf(games: readonly JudgeHeatGameT[], voidAt?: (i: number) => boolean, shadow: number = JUDGE_HEAT_PANEL_SWISS_JUDGE): JudgePanelSlotT[] {
  if (!Number.isSafeInteger(shadow) || shadow < JUDGE_PANEL_SIZE) throw new RangeError(`the shadow's index ${String(shadow)} is a whole number past the panel's ${JUDGE_PANEL_SIZE} seats`);
  const slots = new Map<string, JudgePanelSlotT>();
  games.forEach((g, i) => {
    if (g.stage !== 'playoff') return;
    const j = g.judge;
    if (j === undefined || !Number.isSafeInteger(j) || j < 0 || (j >= JUDGE_PANEL_SIZE && j !== shadow)) {
      throw new RangeError(`games.${i}: a panel final's playoff game is judged by a panel seat (0 to ${JUDGE_PANEL_SIZE - 1}) or the shadow (${shadow}), and this one names ${String(j)}`);
    }
    const key = `${g.round}:${g.a}:${g.b}`;
    let slot = slots.get(key);
    if (slot === undefined) {
      slots.set(
        key,
        (slot = { round: g.round, a: g.a, b: g.b, at: i, panel: new Array<JudgeHeatGameT | undefined>(JUDGE_PANEL_SIZE).fill(undefined), void: new Array<boolean>(JUDGE_PANEL_SIZE).fill(false), shadow: null }),
      );
    }
    if (j === shadow) {
      if (slot.shadow !== null) throw new RangeError(`games.${i}: the playoff's round ${g.round} game of ${g.a} against ${g.b} has its shadow game twice`);
      slot.shadow = g;
    } else {
      if (slot.panel[j] !== undefined) throw new RangeError(`games.${i}: the playoff's round ${g.round} game of ${g.a} against ${g.b} has panel seat ${j}'s game twice`);
      slot.panel[j] = g;
      slot.void[j] = voidAt === undefined ? false : voidAt(i);
    }
  });
  return [...slots.values()];
}

/**
 * The panel's points for a slot from its counted seats' a_points (judgePanelSlotGame): their median, the middle one
 * sorted; over an even count the mean of the middle two, a half rounded toward JUDGE_GAME_POINTS / 2 (the draw side);
 * over none, JUDGE_GAME_POINTS / 2 (a draw).
 */
export function judgePanelPointsOf(points: readonly number[]): number {
  const half = JUDGE_GAME_POINTS / 2;
  if (points.length === 0) return half;
  const sorted = [...points].sort((x, y) => x - y);
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2]!;
  const sum = sorted[n / 2 - 1]! + sorted[n / 2]!;
  return sum / 2 > half ? Math.floor(sum / 2) : Math.ceil(sum / 2);
}

/**
 * A v5 playoff slot's scored game (the header's panel final): its pair's one game, a_points judgePanelPointsOf its
 * counted seats' a_points (a seat counts when its game is not void, both its calls carrying a verdict: three the
 * median, two their mean rounded toward 10, one its own, none 10), a whole number from 0 to JUDGE_GAME_POINTS, its
 * result judgeGameResultOf of that, and no `judge`; the shadow's game never enters it. Null while a seat's game is still
 * to come. RangeError on a panel game with no a_points (no v5 game lacks one).
 */
export function judgePanelSlotGame(slot: Pick<JudgePanelSlotT, 'round' | 'a' | 'b' | 'panel'> & { void?: readonly boolean[] }): JudgeHeatGameT | null {
  const points: number[] = [];
  let seats = 0;
  for (const [k, g] of slot.panel.entries()) {
    if (g === undefined) return null;
    if (g.a_points === undefined) throw new RangeError(`panel seat ${k}'s game of ${slot.a} against ${slot.b} has no a_points: a panel final's game carries them`);
    seats++;
    if (slot.void?.[k] !== true) points.push(g.a_points);
  }
  if (seats !== JUDGE_PANEL_SIZE) return null;
  const aPoints = judgePanelPointsOf(points);
  return { stage: 'playoff', round: slot.round, a: slot.a, b: slot.b, result: judgeGameResultOf(aPoints), a_points: aPoints };
}

/**
 * The games a heat's scores read (the header's panel final): the record's own games on every format but v5 and v6, as
 * they are (the same array). On a v5 or v6 record's (its shadow judgeHeatShadowOf of `setup`, so a v6 one's is read off
 * its panel): every Swiss and race game as it is; each playoff game slot (round, a, b) one
 * game, judgePanelSlotGame's median of its counted panel games (a seat's game void where `voidAt` of its index says so,
 * judgeGamesVoidOf of the calls the games were folded from: a call with no verdict never votes a draw), placed where
 * the slot's first game was; a slot whose panel games are not all in yet (a heat still running) none; and every shadow
 * game dropped. The fit, its dispersion, the tally (a slot one match), head-to-head and the schedule's top-two pick read
 * these; the record's own `games` stay the raw ones, re-derived from its calls. RangeError as judgePanelSlotsOf throws
 * it.
 */
export function judgeHeatScoredGames(setup: Pick<JudgeHeatSetupT, 'format' | 'panel'>, games: readonly JudgeHeatGameT[], voidAt?: (i: number) => boolean): readonly JudgeHeatGameT[] {
  if (!judgeHeatPanelFormat(setup.format)) return games;
  const firsts = new Map(judgePanelSlotsOf(games, voidAt, judgeHeatShadowOf(setup)).map((s) => [s.at, s]));
  const out: JudgeHeatGameT[] = [];
  games.forEach((g, i) => {
    if (g.stage !== 'playoff') {
      out.push(g);
      return;
    }
    const slot = firsts.get(i);
    if (slot === undefined) return;
    const scored = judgePanelSlotGame(slot);
    if (scored !== null) out.push(scored);
  });
  return out;
}

/** The finalists after the Swiss games (the header's playoff): entrant members by E, ties by sha256. */
function finalistsOf(setup: JudgeHeatSetupT, swiss: readonly JudgeHeatGameT[]): string[] {
  const count = judgeHeatFinalistCount(setup);
  if (count === 0) return [];
  const fit = judgeFit(
    setup.field.map((m) => m.artifact_sha256),
    swiss,
  );
  const entrants = new Map(setup.field.filter((m) => !m.anchor).map((m) => [m.artifact_sha256, fit.get(m.artifact_sha256)!.e]));
  return byStanding(entrants).slice(0, count);
}

export interface JudgeHeatScheduleT {
  /** The heat's calls as far as the settled ones decide them, in the order they run. */
  planned: JudgePlannedCallT[];
  /** Every call of the heat is planned: none waits on a result still to come. */
  complete: boolean;
  /** The playoff's finalists once the Swiss (a screened final's: the race) is settled (empty when none plays); null before. */
  finalists: string[] | null;
  /** The first settled call that is not the call the heat makes at its place, or one past its last; null when none. */
  issue: string | null;
}

/**
 * What judgeHeatSchedule may keep between its calls on one screened final (the header's screened final): each step's
 * plan (a Swiss round's pairing, a racing epoch's pairs, the playoff's finalists, the top two) at the settled-call
 * boundary it was planned at, and the settled calls it read. Opaque: made by judgeHeatScheduleMemo, read and written by
 * judgeHeatSchedule alone. A step is reused only while the setup (by its canonical JSON, taken once per setup object: a
 * setup is never mutated once handed) and every settled call before its boundary are the ones it was planned from, so
 * the schedule is the same with the memo as without it; a settled call that differs drops every step past it.
 */
export interface JudgeHeatScheduleMemoT {
  readonly memo: 'judge-heat-schedule';
}

/** A settled call as the memo compares it: the fields the schedule reads. */
type MemoCallT = Pick<JudgeSettledCallT, 'stage' | 'round' | 'a' | 'b' | 'slot_order' | 'verdict' | 'margin'>;

interface MemoStateT {
  setup: string | null;
  calls: MemoCallT[];
  steps: Map<string, { boundary: number; value: unknown }>;
}

const memoStates = new WeakMap<JudgeHeatScheduleMemoT, MemoStateT>();
const setupKeys = new WeakMap<object, string>();

/** A fresh memo for judgeHeatSchedule (JudgeHeatScheduleMemoT): one per heat a caller replans as its calls settle. */
export function judgeHeatScheduleMemo(): JudgeHeatScheduleMemoT {
  const memo: JudgeHeatScheduleMemoT = Object.freeze({ memo: 'judge-heat-schedule' as const });
  memoStates.set(memo, { setup: null, calls: [], steps: new Map() });
  return memo;
}

/**
 * The memo's step reader for `setup` and `settled` (null without a memo): the memo's steps planned before the first
 * settled call that differs from the one it read kept, every later one dropped, and the settled calls taken in. The
 * reader returns a step's kept plan when it was planned at this boundary, else computes and keeps it.
 */
function memoStepsOf(memo: JudgeHeatScheduleMemoT | undefined, setup: JudgeHeatSetupT, settled: readonly JudgeSettledCallT[]): (<T>(label: string, boundary: number, compute: () => T) => T) | null {
  if (memo === undefined) return null;
  const state = memoStates.get(memo);
  if (state === undefined) throw new TypeError('the memo is not one judgeHeatScheduleMemo made');
  let key = setupKeys.get(setup);
  if (key === undefined) setupKeys.set(setup, (key = canonicalJson(setup)));
  if (state.setup !== key) {
    state.setup = key;
    state.calls = [];
    state.steps.clear();
  }
  const shared = Math.min(state.calls.length, settled.length);
  let d = 0;
  for (; d < shared; d++) {
    const x = state.calls[d]!;
    const y = settled[d]!;
    if (x.stage !== y.stage || x.round !== y.round || x.a !== y.a || x.b !== y.b || x.slot_order !== y.slot_order || x.verdict !== y.verdict || x.margin !== y.margin) break;
  }
  if (d < shared) {
    state.calls.length = d;
    for (const [label, step] of state.steps) if (step.boundary > d) state.steps.delete(label);
  }
  for (let i = state.calls.length; i < settled.length; i++) {
    const c = settled[i]!;
    state.calls.push({ stage: c.stage, round: c.round, a: c.a, b: c.b, slot_order: c.slot_order, verdict: c.verdict, margin: c.margin });
  }
  return <T>(label: string, boundary: number, compute: () => T): T => {
    const kept = state.steps.get(label);
    if (kept !== undefined && kept.boundary === boundary) return kept.value as T;
    const value = compute();
    state.steps.set(label, { boundary, value });
    return value;
  };
}

/**
 * The heat's calls in the order they run, as far as `settled` (the calls made so far, in their order) decide them
 * (the header's Swiss, playoff, provisional and ladder): each Swiss round is planned from the games before it, the
 * playoff from the Swiss's, each adaptive round of a ladder heat from the estimate over the games before it; a
 * calibration is planned whole. Each settled call is checked against the call planned at its place. On a setup that
 * lists `judges`, each planned call carries its judge (the header's judges), so planned[i].judge is settled call i's
 * dealt one (a v5 setup's planned, never dealt: the header's panel final; a v6 setup's Swiss and race calls dealt over
 * its pool's members, its playoff planned: the header's dealt final); a settled call's own `judge` is
 * judgeHeatKeptIssue's and judgeHeatRecordIssues', never read here. The
 * setup is taken as one that holds (judgeHeatSetupIssues). A screened final's (v4) is planned step by step, its Swiss
 * rounds, each racing epoch, the playoff and the top two's games each from the games before it (the header's screened
 * final); `memo` (judgeHeatScheduleMemo), when named, keeps those steps between calls on one heat, and the schedule is
 * the same with it as without it. Any other format never reads it.
 */
export function judgeHeatSchedule(setup: JudgeHeatSetupT, settled: readonly JudgeSettledCallT[], memo?: JudgeHeatScheduleMemoT): JudgeHeatScheduleT {
  const planned: JudgePlannedCallT[] = [];
  let issue: string | null = null;
  let checked = 0;
  // Checks the settled calls against the planned ones; true when every planned call is settled as planned.
  const settle = (): boolean => {
    for (; issue === null && checked < Math.min(planned.length, settled.length); checked++) {
      const p = planned[checked]!;
      const s = settled[checked]!;
      if (s.stage !== p.stage || s.round !== p.round || s.a !== p.a || s.b !== p.b || s.slot_order !== p.slot_order) {
        issue = `calls.${checked}: the heat's ${p.stage} round ${p.round} judges ${p.a} against ${p.b} in slot order ${p.slot_order} here`;
      } else {
        const off = callFormatIssue(setup.format, s);
        if (off !== null) issue = `calls.${checked}.${off}`;
      }
    }
    return issue === null && settled.length >= planned.length;
  };
  // `judge`, named only by a v5 or v6 schedule (the header's panel final), is the judge its games are planned on.
  const plan = (stage: JudgeCallStageT, round: number, pairs: readonly JudgeSwissPairT[], judge?: number): void => {
    const on = judge === undefined ? {} : { judge };
    for (const p of pairs) {
      planned.push({ stage, round, a: p.a, b: p.b, slot_order: p.first, ...on }, { stage, round, a: p.a, b: p.b, slot_order: otherOrder(p.first), ...on });
    }
  };
  // Each planned call's judge, on a setup that lists them (the header's judges): a final's games dealt in schedule order
  // (a prefix deals as the whole does), any other heat's calls judge 0. A deal that cannot be made is the schedule's issue.
  // A v5 schedule's are planned with its calls (screenedSchedule: the Swiss judge's, or a playoff game's seat) and never dealt.
  // A v6 schedule's playoff calls are planned so too; its Swiss and race games, the schedule's prefix before them, are
  // dealt over the pool's n members alone (never over the Swiss judge's weight of 100, which would take nearly every game).
  const judged = (s: JudgeHeatScheduleT): JudgeHeatScheduleT => {
    const judges = setup.judges;
    if (judges === undefined || setup.format === JUDGE_HEAT_FORMAT_V5) return s;
    if (setup.format === JUDGE_HEAT_FORMAT_V6) {
      // The pool's members are judges 0 to n - 1, the Swiss judge n (judgeHeatShadowOf).
      const n = judgeHeatShadowOf(setup);
      const games: { stage: string; round: number; a: string; b: string }[] = [];
      for (let k = 0; k + 1 < planned.length && (planned[k]!.stage === 'swiss' || planned[k]!.stage === 'race'); k += 2) {
        games.push({ stage: planned[k]!.stage, round: planned[k]!.round, a: planned[k]!.a, b: planned[k]!.b });
      }
      let dealt: number[];
      try {
        dealt = judgeDeal(
          setup.seed,
          judges.slice(0, n).map((j) => j.weight),
          games,
        );
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return { ...s, complete: false, issue: s.issue ?? `judges: the heat's Swiss and race games cannot be dealt over its pool: ${err.message}` };
      }
      dealt.forEach((j, g) => {
        planned[2 * g]!.judge = j;
        planned[2 * g + 1]!.judge = j;
      });
      return s;
    }
    let dealt: number[] = [];
    if (setup.stage === 'final') {
      const games: { stage: string; round: number; a: string; b: string }[] = [];
      for (let k = 0; k + 1 < planned.length; k += 2) games.push({ stage: planned[k]!.stage, round: planned[k]!.round, a: planned[k]!.a, b: planned[k]!.b });
      try {
        dealt = judgeDeal(setup.seed, judges.map((j) => j.weight), games);
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return { ...s, complete: false, issue: s.issue ?? `judges: the heat's games cannot be dealt: ${err.message}` };
      }
    }
    planned.forEach((p, i) => {
      p.judge = setup.stage === 'final' ? dealt[Math.floor(i / 2)]! : 0;
    });
    return s;
  };
  const done = (finalists: string[]): JudgeHeatScheduleT => {
    if (!settle()) return judged({ planned, complete: issue === null, finalists, issue });
    if (settled.length > planned.length) issue = `calls.${planned.length}: the heat makes ${planned.length} calls, and this is one more`;
    return judged({ planned, complete: issue === null, finalists, issue });
  };
  const waiting = (): JudgeHeatScheduleT => judged({ planned, complete: false, finalists: null, issue });
  const members = setup.field.map((m) => m.artifact_sha256);

  if (setup.stage === 'calibration') {
    // Every pair i < j in sha256 order, both slot orders, the first drawn per repeat.
    for (let repeat = 0; repeat < (setup.repeats ?? 0); repeat++) {
      const pairs: JudgeSwissPairT[] = [];
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) pairs.push({ a: members[i]!, b: members[j]!, first: judgeSlotOrder(setup.seed, 'calibration', repeat, members[i]!, members[j]!) });
      }
      plan('calibration', repeat, pairs);
    }
    return done([]);
  }
  if (setup.stage === 'provisional') {
    const subject = subjectOf(setup);
    const ladder = setup.ladder;
    if (subject !== undefined) {
      // Round 0: every other member; on a ladder, the judge anchors alone (the rungs only ever play adaptive games).
      const opponents = ladder === undefined ? members.filter((m) => m !== subject) : anchorsOf(setup, subject);
      plan('provisional', 0, opponents.map((b) => ({ a: subject, b, first: judgeSlotOrder(setup.seed, 'provisional', 0, subject, b) })));
      if (ladder !== undefined) {
        const strengths = judgeLadderStrengths(ladder.strengths);
        const gamesSoFar = (): JudgeHeatGameT[] => gamesOf(setup.format, settled.slice(0, planned.length));
        // Each round's games go to the members most informative at the estimate over every game before it.
        const adaptive = (round: number): void => {
          const next = judgeLadderNext(judgeLadderEstimate(subject, gamesSoFar(), strengths), strengths, ladder.spread);
          for (let g = 0; g < ladder.games; g++) {
            const k = round * ladder.games + g + 1;
            const b = next[g % next.length]!;
            plan('adaptive', k, [{ a: subject, b, first: judgeSlotOrder(setup.seed, 'adaptive', k, subject, b) }]);
          }
        };
        for (let round = 0; round < ladder.rounds; round++) {
          if (!settle()) return waiting();
          adaptive(round);
        }
        // The scrutiny: an entry whose interval high over the games so far reaches the line plays its rounds on top, the
        // same adaptive rounds over the same members (house-only), k continuing. A heat before the line's decision is a
        // prefix of either way, so a record without scrutiny is the start of the one with it.
        const scrutiny = ladder.scrutiny;
        if (scrutiny !== undefined) {
          if (!settle()) return waiting();
          const rate = { subject, games: gamesSoFar(), strengths, anchors: anchorsOf(setup, subject), phi: judgeLadderFromFixed9(ladder.dispersion) };
          if (judgeLadderReachesLine(rate, scrutiny.line_micro)) {
            for (let round = ladder.rounds; round < ladder.rounds + scrutiny.rounds; round++) {
              if (!settle()) return waiting();
              adaptive(round);
            }
          }
        }
      }
    }
    return done([]);
  }
  const screen = judgeHeatScreenOf(setup);
  if (screen !== null && setup.screen !== undefined && setup.race !== undefined) {
    return screenedSchedule(setup, setup.screen, setup.race, screen, settled, memoStepsOf(memo, setup, settled), {
      planned,
      settle,
      plan,
      done,
      waiting: (finalists) => judged({ planned, complete: false, finalists, issue }),
    });
  }
  if (members.length < 2) return done([]);

  const rounds: JudgeSwissRoundT[] = [];
  for (let round = 0; round < setup.rounds; round++) {
    if (!settle()) return waiting();
    const fit = judgeFit(members, gamesOf(setup.format, settled.slice(0, planned.length)));
    const standing = new Map(members.map((m) => [m, fit.get(m)!.e]));
    const pairing = judgeSwissPairs(standing, judgeSwissHistory(rounds), setup.seed, round);
    rounds.push(pairing);
    plan('swiss', round, pairing.pairs);
  }
  if (!settle()) return waiting();
  const finalists = finalistsOf(setup, gamesOf(setup.format, settled.slice(0, planned.length)));
  for (let repeat = 0; repeat < (finalists.length === 0 ? 0 : setup.playoff_repeats); repeat++) {
    const pairs: JudgeSwissPairT[] = [];
    for (let i = 0; i < finalists.length; i++) {
      for (let j = i + 1; j < finalists.length; j++) {
        pairs.push({ a: finalists[i]!, b: finalists[j]!, first: judgeSlotOrder(setup.seed, 'playoff', repeat, finalists[i]!, finalists[j]!) });
      }
    }
    plan('playoff', repeat, pairs);
  }
  return done(finalists);
}

/** judgeHeatSchedule's own planner, as a screened final's steps use it: its planned calls, and what checks and plans them. */
interface ScheduleKitT {
  planned: JudgePlannedCallT[];
  settle: () => boolean;
  plan: (stage: JudgeCallStageT, round: number, pairs: readonly JudgeSwissPairT[], judge?: number) => void;
  done: (finalists: string[]) => JudgeHeatScheduleT;
  waiting: (finalists: string[] | null) => JudgeHeatScheduleT;
}

/** Members by strength p, higher first, ties by sha256. */
function byStrength(members: readonly string[], strengths: ReadonlyMap<string, Pick<JudgeRaceStrengthT, 'p'>>): string[] {
  return [...members].sort((x, y) => {
    const px = strengths.get(x)!.p;
    const py = strengths.get(y)!.p;
    return px > py ? -1 : px < py ? 1 : compareCodeUnits(x, y);
  });
}

/**
 * A screened final's schedule (the header's screened final), over its shortlist S (the screen's: kept entrants and every
 * anchor), each step from the games settled before it (grader/judge-race.ts judgeRaceStrengths' p over them, never E):
 *   F2  `rounds` Swiss rounds over S: round 0 in the screen's seeded order, every later one by the standing p/(1+p);
 *   F3  racing epochs 0, 1, ... (stage `race`, round the epoch) while an entrant is active (judgeRaceActive over the
 *       phi-scaled intervals: judgeHeatDispersion's phi^ times phi_margin), its pairs judgeRacePairs' with the race's
 *       budget left (max(M x race_cap_max, ceil(|S| / 2)) games in all, judgeRaceBudget over S), stopping when none is
 *       active, no pair can be made or race_cap_max epochs have run;
 *   F4  the playoff: the first playoff_places entrants of S by p (no anchor; none below two), every pair of them per
 *       repeat, playoff_repeats times (stage `playoff`, round the repeat), then once those settle, top_repeats games
 *       between the two of them first by p (rounds playoff_repeats and on, one game each, its first order drawn).
 * The finalists are the round-robin's players. A v5 schedule (the header's panel final) plans F2's and F3's calls on the
 * Swiss judge (JUDGE_HEAT_PANEL_SWISS_JUDGE), and each F4 game, the round-robin's and the top two's, as
 * JUDGE_HEAT_PANEL_PLAYOFF_GAMES games in a fixed order, panel seats 0 to JUDGE_PANEL_SIZE - 1 and then the shadow, each
 * in both slot orders, the pair's drawn first order first; every step reads the games so far as they score
 * (judgeHeatScoredGames), so the top two are picked on the panel's medians and the shadow's games move nothing. A v6
 * schedule (the header's dealt final) plans F2's and F3's calls on no judge (judgeHeatSchedule deals them over the pool
 * once planned) and its F4 games as v5's, the shadow at its pool's size (judgeHeatShadowOf), and reads its games so far
 * as v5's do.
 */
function screenedSchedule(
  setup: JudgeHeatSetupT,
  screenBlock: JudgeHeatScreenT,
  race: JudgeHeatRaceT,
  screen: JudgeScreenT,
  settled: readonly JudgeSettledCallT[],
  steps: (<T>(label: string, boundary: number, compute: () => T) => T) | null,
  kit: ScheduleKitT,
): JudgeHeatScheduleT {
  const { planned, settle, plan: planOf, done, waiting } = kit;
  const step = <T>(label: string, compute: () => T): T => (steps === null ? compute() : steps(label, planned.length, compute));
  const shortlist = screen.shortlist;
  if (shortlist.length < 2) return done([]);
  const anchors = new Set(setup.field.filter((m) => m.anchor).map((m) => m.artifact_sha256));
  const entrants = shortlist.filter((m) => !anchors.has(m));
  // A v5 schedule (the header's panel final) plans each call on its judge: every Swiss and race call on the Swiss judge,
  // each playoff game once on each panel seat, then once on the Swiss judge as the shadow. Its games so far are read as
  // they score (judgeHeatScoredGames: a playoff slot the median of its panel games, the shadow's dropped), each game's
  // judge the one it was planned on.
  // A v6 schedule (the header's dealt final) plans its Swiss and race calls on no judge (judgeHeatSchedule's `judged`
  // deals them), and its playoff as v5's with the shadow after every pool member.
  const v5 = setup.format === JUDGE_HEAT_FORMAT_V5;
  const panelled = judgeHeatPanelFormat(setup.format);
  const shadow = panelled ? judgeHeatShadowOf(setup) : undefined;
  const plan = (stage: JudgeCallStageT, round: number, pairs: readonly JudgeSwissPairT[]): void => planOf(stage, round, pairs, v5 ? JUDGE_HEAT_PANEL_SWISS_JUDGE : undefined);
  const planPlayoff = (round: number, pairs: readonly JudgeSwissPairT[]): void => {
    if (shadow === undefined) return planOf('playoff', round, pairs);
    for (const p of pairs) {
      for (let seat = 0; seat < JUDGE_PANEL_SIZE; seat++) planOf('playoff', round, [p], seat);
      planOf('playoff', round, [p], shadow);
    }
  };
  const gamesSoFar = (): readonly JudgeHeatGameT[] => {
    const calls = settled.slice(0, planned.length);
    return panelled ? judgeHeatScoredGames(setup, gamesOf(setup.format, calls, (k) => planned[k]!.judge), judgeGamesVoidOf(calls)) : gamesOf(setup.format, calls);
  };

  // F2: the Swiss rounds over S.
  const rounds: JudgeSwissRoundT[] = [];
  for (let round = 0; round < setup.rounds; round++) {
    if (!settle()) return waiting(null);
    const pairing = step(`swiss ${round}`, () => {
      if (round === 0) return judgeSwissPairs(new Map(shortlist.map((m) => [m, 0])), judgeSwissHistory(rounds), setup.seed, round, screen.order);
      const standing = new Map([...judgeRaceStrengths(shortlist, gamesSoFar())].map(([m, s]) => [m, s.p / (1 + s.p)]));
      return judgeSwissPairs(standing, judgeSwissHistory(rounds), setup.seed, round);
    });
    rounds.push(pairing);
    plan('swiss', round, pairing.pairs);
  }

  // F3: the racing epochs, within the race's budget.
  const budget = judgeRaceBudget(screenBlock.line_places, race.race_cap_max, shortlist.length);
  let raced = 0;
  for (let epoch = 0; epoch < race.race_cap_max; epoch++) {
    if (!settle()) return waiting(null);
    const left = budget - raced;
    const pairs = step(`race ${epoch}`, (): JudgeSwissPairT[] => {
      if (entrants.length === 0 || race.tiers.length === 0 || left <= 0) return [];
      const games = gamesSoFar();
      const strengths = judgeRaceStrengths(shortlist, games);
      const intervals = judgeRaceIntervals(strengths, judgeHeatDispersion(games, strengths), race.z, race.phi_margin);
      const state = judgeRaceActive({ entrants, intervals, tiers: race.tiers, epsilon: race.epsilon, games });
      if (state.active.length === 0) return [];
      return judgeRacePairs({
        active: state.active,
        candidates: strengths,
        games,
        ties: state.ties,
        epochCalls: race.epoch_calls,
        budget: left,
        first: (a, b) => judgeSlotOrder(setup.seed, 'race', epoch, a, b),
      });
    });
    if (pairs.length === 0) break;
    plan('race', epoch, pairs);
    raced += pairs.length;
  }

  // F4: the round-robin among the first playoff_places entrants by p, then the top two's games.
  if (!settle()) return waiting(null);
  const finalists = step('playoff', () => {
    const count = Math.min(setup.playoff_places, entrants.length);
    return count < 2 ? [] : byStrength(entrants, judgeRaceStrengths(shortlist, gamesSoFar())).slice(0, count);
  });
  for (let repeat = 0; repeat < (finalists.length === 0 ? 0 : setup.playoff_repeats); repeat++) {
    const pairs: JudgeSwissPairT[] = [];
    for (let i = 0; i < finalists.length; i++) {
      for (let j = i + 1; j < finalists.length; j++) {
        pairs.push({ a: finalists[i]!, b: finalists[j]!, first: judgeSlotOrder(setup.seed, 'playoff', repeat, finalists[i]!, finalists[j]!) });
      }
    }
    planPlayoff(repeat, pairs);
  }
  if (finalists.length >= 2 && race.top_repeats > 0) {
    if (!settle()) return waiting([...finalists]);
    const [top, second] = step('top', () => byStrength(finalists, judgeRaceStrengths(shortlist, gamesSoFar())).slice(0, 2)) as [string, string];
    for (let k = 0; k < race.top_repeats; k++) {
      const round = setup.playoff_repeats + k;
      planPlayoff(round, [{ a: top, b: second, first: judgeSlotOrder(setup.seed, 'playoff', round, top, second) }]);
    }
  }
  return done([...finalists]);
}

/**
 * The F2 members a screened final's schedule plays, min(S, field) as judgeHeatPlannedCalls counts them
 * (judgeScreenedCallBound); null on a setup of any other format (judgeHeatScreenOf's null).
 */
function screenedMembersOf(setup: JudgeHeatSetupT): number | null {
  const screen = judgeHeatScreenOf(setup);
  return screen === null ? null : Math.min(screen.shortlist.length, setup.field.length);
}

/**
 * The most calls a heat can still come to, `s` its schedule (judgeHeatSchedule) over the calls kept so far, never more
 * than `bound` (default judgeHeatPlannedCalls(setup)): the calls `s` has planned (each one the heat makes), and for a
 * screened final (v4) whose schedule is not complete the most each step screenedSchedule has still to plan can add, as
 * judgeScreenedCallBound counts it: F2's Swiss rounds still to pair, floor(members / 2) games a round; F3's budget,
 * judgeRaceBudget's max(M x race_cap_max, ceil(members / 2)) games, less the race's games planned, none once
 * race_cap_max epochs are; F4's round-robin and top-two games until the round-robin is drawn, the top two's alone
 * after (a v5 or v6 final's F4 games each JUDGE_HEAT_PANEL_PLAYOFF_GAMES times over, as screenedSchedule plans them). A
 * complete schedule's is its count; one with an issue, or an incomplete one of any other heat (a scrutinised ladder heat's still undecided), the
 * bound. It never rises as more calls are kept: each step is planned within what it counted for it. `members` is the
 * screened final's F2 members (min(S, field)), null on any other heat, read only when needed (default from the setup's
 * screen). The heat-job's invalid-share stop judges a bounded heat's share over it (grader/worker.ts
 * judgeHeatInvalidShareStop); a change to how many calls a step of screenedSchedule can plan changes this beside it.
 */
export function judgeHeatScheduleCeiling(
  setup: JudgeHeatSetupT,
  s: Pick<JudgeHeatScheduleT, 'planned' | 'complete' | 'finalists' | 'issue'>,
  bound: number = judgeHeatPlannedCalls(setup),
  members: () => number | null = () => screenedMembersOf(setup),
): number {
  if (s.issue !== null) return bound;
  if (s.complete) return Math.min(bound, s.planned.length);
  const m = members();
  if (m === null || setup.screen === undefined || setup.race === undefined) return bound;
  let rest: number;
  // A v5 or v6 schedule plans each playoff and top game once a panel seat and once for the shadow.
  const games = playoffGamesOf(setup);
  // F4 drawn: the round-robin is planned, the top two's games (none under two finalists) all that is still to come.
  if (s.finalists !== null) rest = s.finalists.length < 2 ? 0 : 2 * setup.race.top_repeats * games;
  else {
    let swissRounds = 0;
    let raceCalls = 0;
    const epochs = new Set<number>();
    for (const c of s.planned) {
      if (c.stage === 'swiss') swissRounds = Math.max(swissRounds, c.round + 1);
      else if (c.stage === 'race') {
        raceCalls++;
        epochs.add(c.round);
      }
    }
    // F2: each Swiss round still to pair; F3: the race's budget less its calls planned; F4: the round-robin and the top two.
    const swiss = 2 * Math.floor(m / 2) * Math.max(0, setup.rounds - swissRounds);
    const race = epochs.size >= setup.race.race_cap_max ? 0 : Math.max(0, 2 * judgeRaceBudget(setup.screen.line_places, setup.race.race_cap_max, m) - raceCalls);
    const places = Math.min(setup.playoff_places, m);
    const playoff = places < 2 ? 0 : (places * (places - 1) * setup.playoff_repeats + 2 * setup.race.top_repeats) * games;
    rest = swiss + race + playoff;
  }
  return Math.min(bound, s.planned.length + rest);
}

/**
 * The call the heat makes next after `settled`, or null when it has made them all. JudgeHeatError when a settled call
 * is not the heat's. It plans the heat from the start each time (a fit a Swiss round so far): a runner may as well walk
 * judgeHeatSchedule's planned calls, planning again once it has made them all (a screened final's steps kept between
 * calls by `memo`, judgeHeatSchedule's).
 */
export function judgeHeatNextCall(setup: JudgeHeatSetupT, settled: readonly JudgeSettledCallT[], memo?: JudgeHeatScheduleMemoT): JudgePlannedCallT | null {
  const s = judgeHeatSchedule(setup, settled, memo);
  if (s.issue !== null) throw new JudgeHeatError(`the calls made are not the heat's: ${s.issue}`);
  return s.planned[settled.length] ?? null;
}

/**
 * Why calls kept from an earlier attempt cannot resume the heat (null when they can): the setup does not hold, or a
 * kept call is not the one the heat makes at its place (judgeHeatSchedule), or a kept spare (the partial's `spares`)
 * does not hold or names no kept call (judgeHeatSpareIssues, and the order and count a record's spares keep), or a kept
 * call's judge or an attempt's provider is not the heat's (the header's judges: judgeHeatJudgeIssuesOf, then the judge
 * the schedule dealt it). Kept calls that pass are a prefix of the heat's: the attempt goes on from the next one.
 */
export function judgeHeatKeptIssue(setup: JudgeHeatSetupT, kept: readonly JudgeHeatCallT[], spares: readonly JudgeHeatSpareT[] = []): string | null {
  const setupIssues = judgeHeatSetupIssues(setup);
  if (setupIssues.length > 0) return setupIssues[0]!;
  const parsedCalls: JudgeHeatCallT[] = [];
  for (const [i, c] of kept.entries()) {
    const parsed = JudgeHeatCall.safeParse(c);
    if (!parsed.success) return `calls.${i}: ${parsed.error.issues[0]?.message ?? 'malformed'}`;
    const callIssues = judgeHeatCallIssues(parsed.data);
    if (callIssues.length > 0) return `calls.${i}.${callIssues[0]}`;
    parsedCalls.push(parsed.data);
  }
  const parsedSpares: JudgeHeatSpareT[] = [];
  for (const [i, s] of spares.entries()) {
    const parsed = JudgeHeatSpare.safeParse(s);
    if (!parsed.success) return `spares.${i}: ${parsed.error.issues.map((x) => `${x.path.join('.') || '(spare)'}: ${x.message}`)[0] ?? 'malformed'}`;
    parsedSpares.push(parsed.data);
  }
  const spareIssues = sparesIssuesOf(setup.format, parsedSpares, kept.length);
  if (spareIssues.length > 0) return spareIssues[0]!;
  const judgeIssues = judgeHeatJudgeIssuesOf(JudgeHeatSetup.parse(setup), parsedCalls, parsedSpares);
  if (judgeIssues.length > 0) return judgeIssues[0]!;
  const s = judgeHeatSchedule(setup, kept);
  return s.issue ?? judgeDealtIssue(s.planned, parsedCalls);
}

/**
 * The key kept calls are resumed under: sha256 of the canonical JSON of the format, the setup and the caller's
 * `plan` (whatever else the calls depend on: grader/worker.ts names the phase, its bundle and the artifacts' bytes).
 * The format is the setup's own, so calls a v1 heat kept never resume a v2 one. The setup's `judges` is left out (the
 * header's judges: a partial keeps them), so a setup that lists none hashes the bytes it always did.
 */
export function judgeHeatResumeKey(setup: JudgeHeatSetupT, plan: unknown): string {
  const { judges: _judges, ...parsed } = JudgeHeatSetup.parse(setup);
  return sha256Hex(canonicalJson({ format: parsed.format, setup: parsed, plan }));
}

export const JUDGE_HEAT_PARTIAL_FORMAT = 'agent-fun/judge-heat-partial/v1';

/**
 * What an attempt of a heat keeps as it goes (grader/worker.ts judgeHeatPartialPath), so the next attempt sends only
 * the calls still to come: its calls, its spend and its one fault re-sent, and the masq key it holds open.
 */
export const JudgeHeatPartial = z.strictObject({
  format: z.literal(JUDGE_HEAT_PARTIAL_FORMAT),
  /** judgeHeatResumeKey: the calls are this heat's only under it. */
  key: Sha256Hex,
  /** The calls settled so far, in the order they ran: a prefix of the heat's (judgeHeatKeptIssue). */
  calls: z.array(JudgeHeatCall),
  /** The heat's spend so far, µUSD (a u64 decimal): every attempt its keys sent and priced, a faulted call's too. */
  spent_micro_usd: U64,
  /** The calls sent again after a fault: a heat re-sends one; a second fault fails it. */
  resent: z.int().min(0).max(1),
  /** The keys the heat has minted: the next one's attempt number (grader/gateway/masq.ts JudgeKeySpec) is this plus 1. */
  keys: z.int().min(0),
  /** The key the last attempt minted, while not retired, and what it metered: the next attempt retires it first. */
  open_key: z.strictObject({ id: z.string().min(1), label: z.string().min(1), meter_micro_usd: U64 }).nullable(),
  /**
   * The kept calls' other sends (the header's spares), ordered by call, then send, each naming a kept call; absent,
   * never empty, when there are none (a partial kept before spares were has none).
   */
  spares: z.array(JudgeHeatSpare).min(1).optional(),
  /**
   * The setup's `judges` its calls were sent to (the header's judges), which the resume key leaves out: the next
   * attempt's setup lists the same, so the heat's mix is the one fixed before its first call. Absent when it lists none.
   */
  judges: z.array(JudgeOfHeat).min(1).max(JUDGE_POOL_MAX).optional(),
  /**
   * A screened final's screen inputs (the header's screened final), fixed before its first call: the next attempt sets
   * up on these, never on the dev records as they are now, so it rebuilds the same setup (and so the same resume key,
   * which holds the setup's `screen`) however those records moved after the deadline. Absent on any other heat.
   */
  screen: JudgeHeatScreenInputs.optional(),
  /**
   * A panel final's drawn panel (the header's panel final), fixed before its first call: the next attempt sets up on
   * it, never drawing again, so it rebuilds the same setup (and so the same resume key, which holds the setup's
   * `panel`). Absent on any other heat.
   */
  panel: JudgeHeatPanel.optional(),
  /**
   * A dossier final's judge view (the header's judge view), fixed before its first call: the next attempt sets up on
   * these stored views, never on views made again, so it rebuilds the same setup (and resume key). Absent on any other
   * heat, and on a heat begun before the view, which sends its dossiers whole to its end.
   */
  judge_view: JudgeHeatJudgeView.optional(),
});
export type JudgeHeatPartialT = z.infer<typeof JudgeHeatPartial>;

// ---------------------------------------------------------------- the calls

const USAGE_KEYS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'reasoning'] as const satisfies readonly (keyof CassetteUsageT)[];

/** Usages summed; null when none carries any (grader/judge-call.ts sums a call's attempts so). */
function usageSum(all: readonly (CassetteUsageT | null)[]): CassetteUsageT | null {
  let sum: CassetteUsageT | null = null;
  for (const u of all) {
    if (u === null) continue;
    sum ??= { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, reasoning: 0 };
    for (const k of USAGE_KEYS) sum[k] += u[k];
  }
  return sum;
}

/** Prices summed, an unpriced one adding nothing: micro-USD, a u64 decimal. */
function microUsdSum(all: readonly (string | null)[]): string {
  let sum = 0n;
  for (const m of all) if (m !== null) sum += BigInt(m);
  return sum.toString();
}

/**
 * What does not hold between a parsed call's fields (none when it holds), each issue naming its field: two members;
 * the attempts in grader/judge-call.ts's order (the answer, then a retry its form allows: JUDGE_CALL_RETRY_FORMS), a
 * retry only after an attempt that gave no verdict, and both sent before a call is invalid; the verdict, reason and
 * invalid as the last attempt left them; a margin, where the call carries one (a v2 call: whether it must is the
 * record's format, judgeHeatRecordIssues), null exactly when the verdict is; the last attempt's request, response and
 * model; the attempts' usage and price summed.
 */
export function judgeHeatCallIssues(c: JudgeHeatCallT): string[] {
  const issues: string[] = [];
  const last = c.attempts[c.attempts.length - 1]!;
  const answer = c.attempts[0]!.form;
  const retries = JUDGE_CALL_RETRY_FORMS[answer];
  if (c.a === c.b) issues.push('b: a call compares two field members');
  c.attempts.forEach((t, i) => {
    if (i === 0 && retries === undefined) issues.push(`attempts.0.form: request 1 of a call is its answer, ${Object.keys(JUDGE_CALL_RETRY_FORMS).join(' or ')}`);
    if (i > 0 && retries !== undefined && !retries.includes(t.form)) issues.push(`attempts.${i}.form: request ${i + 1} of a call answered as ${answer} is its retry, ${retries.join(' or ')}`);
    if (i < c.attempts.length - 1 && t.invalid === null) issues.push(`attempts.${i}.invalid: a call is retried only after a request that gave no verdict`);
  });
  if (c.verdict === null) {
    if (last.invalid === null) issues.push(`attempts.${c.attempts.length - 1}.invalid: the last request of a call with no verdict says why it gave none`);
    if (c.attempts.length !== JUDGE_CALL_MAX_ATTEMPTS) issues.push(`attempts: a call is invalid only after its ${JUDGE_CALL_MAX_ATTEMPTS} requests`);
    if (c.reason !== null) issues.push('reason: a call with no verdict has no reason');
    if (c.margin !== undefined && c.margin !== null) issues.push('margin: a call with no verdict has no margin');
    if (c.invalid !== last.invalid) issues.push('invalid: why the last request gave no verdict');
  } else {
    if (last.invalid !== null) issues.push(`attempts.${c.attempts.length - 1}.invalid: the request a verdict was read from is valid`);
    if (last.model_answered === null) issues.push('model_answered: a verdict is read off an answer that names its model');
    if (c.reason === null) issues.push('reason: a verdict comes with its reason');
    if (c.margin === null) issues.push(`margin: a verdict comes with its margin, ${JUDGE_MARGIN_MIN} to ${JUDGE_MARGIN_MAX}`);
    if (c.invalid !== null) issues.push('invalid: a call with a verdict is valid');
  }
  if (c.request_sha256 !== last.request_sha256) issues.push("request_sha256: the last request's");
  if (c.response_body_sha256 !== last.response_body_sha256) issues.push("response_body_sha256: the last request's");
  if (c.model_answered !== last.model_answered) issues.push("model_answered: the last request's");
  const usage = usageSum(c.attempts.map((t) => t.usage));
  if (canonicalJson(usage) !== canonicalJson(c.usage)) issues.push(`usage: the attempts sum to ${canonicalJson(usage)}`);
  const micro = microUsdSum(c.attempts.map((t) => t.micro_usd));
  if (micro !== c.micro_usd) issues.push(`micro_usd: the attempts sum to ${micro}`);
  return issues;
}

/**
 * Attempts as the heat keeps them: each as handed, its `provider` (grader/judge-call.ts JudgeAttempt's, read
 * structurally) kept only when it names one, so an attempt with none holds no key.
 */
function attemptsOf(attempts: readonly JudgeHeatAttemptT[]): JudgeHeatAttemptT[] {
  return attempts.map((t) => {
    const { provider, ...rest } = t as JudgeHeatAttemptT & { provider?: string };
    return provider === undefined ? rest : { ...rest, provider };
  });
}

/** What the heat keeps of a grader/judge-call.ts JudgeCallResult (structurally: a JudgeCallResult is one). */
export interface JudgeCallResultT {
  /** Entry A's artifact, and Entry B's. */
  a_sha256: string;
  b_sha256: string;
  verdict: JudgeVerdictT | null;
  /** How far the winner is ahead, 1 to 5; null exactly when verdict is. */
  margin: number | null;
  winner_sha256: string | null;
  reason: string | null;
  invalid: string | null;
  request_sha256: string;
  response_body_sha256: string;
  model_answered: string | null;
  usage: CassetteUsageT | null;
  micro_usd: string;
  attempts: readonly JudgeHeatAttemptT[];
}

/**
 * The call the heat keeps for `planned`, from what grader/judge-call.ts answered for it: a v2 call, its margin
 * included (every heat run now writes JUDGE_HEAT_FORMAT), the planned call's `judge` and each attempt's `provider`
 * where named (the header's judges). JudgeHeatError when that answer judged another pair or slot order than the planned
 * call's, carries no margin (one 1 to 5 with a verdict, null without), or does not hold (judgeHeatCallIssues).
 */
export function judgeHeatCallOf(planned: JudgePlannedCallT, result: JudgeCallResultT): JudgeHeatCallT {
  const [slotA, slotB] = planned.slot_order === 'ab' ? [planned.a, planned.b] : [planned.b, planned.a];
  if (result.a_sha256 !== slotA || result.b_sha256 !== slotB) {
    throw new JudgeHeatError(`the call judged ${result.a_sha256} (A) against ${result.b_sha256} (B), not the planned ${slotA} against ${slotB}`);
  }
  const winner = result.verdict === null ? null : result.verdict === 'A' ? slotA : slotB;
  if (result.winner_sha256 !== winner) throw new JudgeHeatError(`the call's winner ${String(result.winner_sha256)} is not its verdict ${String(result.verdict)}'s artifact`);
  const margin = (result as { margin?: unknown }).margin;
  if (margin === undefined || (margin === null) !== (result.verdict === null)) {
    throw new JudgeHeatError(`the call's margin ${String(margin)} is not one for its verdict ${String(result.verdict)}: a verdict comes with a margin from ${JUDGE_MARGIN_MIN} to ${JUDGE_MARGIN_MAX}, no verdict with null`);
  }
  const parsed = JudgeHeatCall.safeParse({
    stage: planned.stage,
    round: planned.round,
    a: planned.a,
    b: planned.b,
    slot_order: planned.slot_order,
    ...(planned.judge === undefined ? {} : { judge: planned.judge }),
    verdict: result.verdict,
    margin,
    reason: result.reason,
    invalid: result.invalid,
    request_sha256: result.request_sha256,
    response_body_sha256: result.response_body_sha256,
    model_answered: result.model_answered,
    usage: result.usage,
    micro_usd: result.micro_usd,
    attempts: attemptsOf(result.attempts),
  });
  if (!parsed.success) throw new JudgeHeatError(`the call is not one: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(call)'}: ${i.message}`).join('; ')}`);
  const issues = judgeHeatCallIssues(parsed.data);
  if (issues.length > 0) throw new JudgeHeatError(`the call does not hold: ${issues.join('; ')}`);
  return parsed.data;
}

// ---------------------------------------------------------------- the spares

/**
 * What does not hold between a parsed spare's fields (none when it holds), each issue naming its field: ended_at not
 * before sent_at; the attempts in grader/judge-call.ts's order (the answer, then a retry its form allows), a retry only
 * after an attempt that gave no verdict; a verdict, margin and reason exactly when `late`, read off its last attempt (one
 * that gave the verdict and names its model); `invalid` null exactly when `late`, an `invalid` spare's its last
 * attempt's after both its requests; a `cancelled` spare's attempts at most one, which gave no verdict; the attempts'
 * usage and price summed. Where it sits in a record (its call, its send number) is judgeHeatRecordIssues'.
 */
export function judgeHeatSpareIssues(s: JudgeHeatSpareT): string[] {
  const issues: string[] = [];
  if (Date.parse(s.ended_at) < Date.parse(s.sent_at)) issues.push('ended_at: a send ends no earlier than it was sent');
  const last = s.attempts[s.attempts.length - 1];
  const answer = s.attempts[0]?.form;
  const retries = answer === undefined ? undefined : JUDGE_CALL_RETRY_FORMS[answer];
  s.attempts.forEach((t, i) => {
    if (i === 0 && retries === undefined) issues.push(`attempts.0.form: request 1 of a send is its answer, ${Object.keys(JUDGE_CALL_RETRY_FORMS).join(' or ')}`);
    if (i > 0 && retries !== undefined && !retries.includes(t.form)) issues.push(`attempts.${i}.form: request ${i + 1} of a send answered as ${String(answer)} is its retry, ${retries.join(' or ')}`);
    if (i < s.attempts.length - 1 && t.invalid === null) issues.push(`attempts.${i}.invalid: a send is retried only after a request that gave no verdict`);
  });
  if (s.ended === 'late') {
    if (last === undefined) issues.push('attempts: a late spare answered its verdict in at least one request');
    else {
      if (last.invalid !== null) issues.push(`attempts.${s.attempts.length - 1}.invalid: the request a late spare's verdict was read from is valid`);
      if (last.model_answered === null) issues.push("attempts: a late spare's verdict is read off an answer that names its model");
    }
    if (s.verdict === null) issues.push('verdict: a late spare answered with a verdict');
    if (s.margin === null) issues.push(`margin: a late spare's verdict comes with its margin, ${JUDGE_MARGIN_MIN} to ${JUDGE_MARGIN_MAX}`);
    if (s.reason === null) issues.push("reason: a late spare's verdict comes with its reason");
    if (s.invalid !== null) issues.push('invalid: a late spare gave a verdict');
  } else {
    if (s.verdict !== null) issues.push(`verdict: only a late spare carries a verdict, and this one ended ${s.ended}`);
    if (s.margin !== null) issues.push(`margin: only a late spare carries a margin, and this one ended ${s.ended}`);
    if (s.reason !== null) issues.push(`reason: only a late spare carries a reason, and this one ended ${s.ended}`);
    if (s.invalid === null) issues.push(`invalid: a spare that ended ${s.ended} says why it gave no verdict`);
    if (s.ended === 'invalid') {
      if (s.attempts.length !== JUDGE_CALL_MAX_ATTEMPTS) issues.push(`attempts: a send is invalid only after its ${JUDGE_CALL_MAX_ATTEMPTS} requests`);
      if (last !== undefined && last.invalid === null) issues.push(`attempts.${s.attempts.length - 1}.invalid: the last request of an invalid spare says why it gave no verdict`);
      if (last !== undefined && s.invalid !== last.invalid) issues.push('invalid: why the last request gave no verdict');
    } else if (s.ended === 'cancelled') {
      if (s.attempts.length > JUDGE_CALL_MAX_ATTEMPTS - 1) issues.push(`attempts: a cancelled spare was aborted before its last request answered, so holds at most ${JUDGE_CALL_MAX_ATTEMPTS - 1}`);
      s.attempts.forEach((t, i) => {
        if (t.invalid === null) issues.push(`attempts.${i}.invalid: a cancelled spare's request gave no verdict`);
      });
    }
  }
  const usage = usageSum(s.attempts.map((t) => t.usage));
  if (canonicalJson(usage) !== canonicalJson(s.usage)) issues.push(`usage: the attempts sum to ${canonicalJson(usage)}`);
  const micro = microUsdSum(s.attempts.map((t) => t.micro_usd));
  if (micro !== s.micro_usd) issues.push(`micro_usd: the attempts sum to ${micro}`);
  return issues;
}

/**
 * What does not hold in a record's (or a partial's) spares beyond each one's own fields: a v1 record has none; each
 * names one of the `calls` listed; they are ordered by call, then send, so a call's send numbers are distinct (its
 * decision holds the one they leave); a call has at most JUDGE_HEAT_MAX_SENDS - 1. Each issue names where.
 */
function sparesIssuesOf(format: JudgeHeatFormatT, spares: readonly JudgeHeatSpareT[], calls: number): string[] {
  const issues: string[] = [];
  if (spares.length === 0) return issues;
  if (format === JUDGE_HEAT_FORMAT_V1) return [`spares: a ${JUDGE_HEAT_FORMAT_V1} record has none`];
  const perCall = new Map<number, number>();
  spares.forEach((s, k) => {
    issues.push(...judgeHeatSpareIssues(s).map((issue) => `spares.${k}.${issue}`));
    if (s.call >= calls) issues.push(`spares.${k}.call: ${s.call} names no call: ${calls} are listed`);
    const prev = spares[k - 1];
    if (prev !== undefined && (prev.call > s.call || (prev.call === s.call && prev.send >= s.send))) {
      issues.push(`spares.${k}: the spares are ordered by call, then send, each send of a call once (call ${s.call} send ${s.send} after call ${prev.call} send ${prev.send})`);
    }
    const n = (perCall.get(s.call) ?? 0) + 1;
    perCall.set(s.call, n);
    if (n === JUDGE_HEAT_MAX_SENDS) issues.push(`spares.${k}.call: call ${s.call} has at most ${JUDGE_HEAT_MAX_SENDS - 1} spares, its decision the ${JUDGE_HEAT_MAX_SENDS}th of its sends`);
  });
  return issues;
}

/**
 * What a send ended on when it threw (grader/judge-call.ts JudgeCallFault, structurally: its message and the attempts
 * that completed before it; a throw that is no JudgeCallFault, none).
 */
export interface JudgeSendFaultT {
  message: string;
  attempts: readonly JudgeHeatAttemptT[];
}

/** An instant as an ISO date-time: a string kept as handed, epoch milliseconds or a Date as toISOString writes it. */
function isoOf(at: string | number | Date): string {
  if (typeof at === 'string') return at;
  const d = typeof at === 'number' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) throw new RangeError(`${String(at)} is no instant`);
  return d.toISOString();
}

/**
 * The spare the heat keeps for send `send` of call `index` (the header's spares), sent at `sentAt` and ended at `endedAt`
 * (ISO date-times, epoch milliseconds or Dates), from what it ended on: grader/judge-call.ts's JudgeCallResult (`late`
 * with its verdict, margin and reason, or `invalid` with none) or the JudgeCallFault it threw (`cancelled` or
 * `faulted`, the fault's message, well formed (judgeText: any error's words, a quoted body among them), its `invalid`,
 * its attempts the fault's). JudgeHeatError when `ended` is not one what it
 * ended on can be, or the spare does not hold (judgeHeatSpareIssues).
 */
export function judgeHeatSpareOf(
  index: number,
  send: number,
  sentAt: string | number | Date,
  endedAt: string | number | Date,
  ended: JudgeSpareEndT,
  from: JudgeCallResultT | JudgeSendFaultT,
): JudgeHeatSpareT {
  let raw: Record<string, unknown>;
  if ('verdict' in from) {
    const result = from;
    const want: JudgeSpareEndT = result.verdict === null ? 'invalid' : 'late';
    if (ended !== want) throw new JudgeHeatError(`a send that answered ${result.verdict === null ? 'with no verdict' : `the verdict ${result.verdict}`} ended ${want}, not ${ended}`);
    raw = {
      verdict: result.verdict,
      margin: result.margin,
      reason: result.reason,
      invalid: result.invalid,
      usage: result.usage,
      micro_usd: result.micro_usd,
      attempts: attemptsOf(result.attempts),
    };
  } else {
    if (ended !== 'cancelled' && ended !== 'faulted') throw new JudgeHeatError(`a send that threw ended cancelled or faulted, not ${ended}`);
    raw = {
      verdict: null,
      margin: null,
      reason: null,
      invalid: judgeText(from.message),
      usage: usageSum(from.attempts.map((t) => t.usage)),
      micro_usd: microUsdSum(from.attempts.map((t) => t.micro_usd)),
      attempts: attemptsOf(from.attempts),
    };
  }
  const parsed = JudgeHeatSpare.safeParse({ call: index, send, sent_at: isoOf(sentAt), ended_at: isoOf(endedAt), ended, ...raw });
  if (!parsed.success) throw new JudgeHeatError(`the spare is not one: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(spare)'}: ${i.message}`).join('; ')}`);
  const issues = judgeHeatSpareIssues(parsed.data);
  if (issues.length > 0) throw new JudgeHeatError(`the spare does not hold: ${issues.join('; ')}`);
  return parsed.data;
}

// ---------------------------------------------------------------- the totals and the invalid share

/** A heat's timing, as its record's totals keep it (JudgeHeatTotals): its first send, the last instant it names, their difference. */
export interface JudgeHeatTimingT {
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
}

/**
 * The timing the calls and spares the heat kept name, read off the record itself (no clock): `started_at`, the first
 * send of any of them (the earliest attempt's `at`, or a spare's `sent_at`: when the heat's first call was dispatched);
 * `finished_at`, the latest instant they name (the last send, or a spare's `ended_at` when one settled later; a
 * decision send's answer arrival is not recorded, so a heat no spare ended after names its last send); and
 * `elapsed_ms`, the two's difference in whole milliseconds. Null when they name none (a heat that sent no call).
 *
 * A heat resumed from a partial keeps its first start: the partial's kept calls carry their own `at`s, so the record
 * built over them and the calls still to come begins where the heat did, never at the last attempt's send. Every
 * attempt and spare is read as an instant, so two spellings of one instant (an offset's and Z's) time the heat the same.
 */
export function judgeHeatTimingOf(calls: readonly Pick<JudgeHeatCallT, 'attempts'>[], spares: readonly Pick<JudgeHeatSpareT, 'sent_at' | 'ended_at'>[] = []): JudgeHeatTimingT | null {
  const instant = (iso: string, where: string): number => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) throw new RangeError(`${where} ${JSON.stringify(iso)} is no instant`);
    return ms;
  };
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  calls.forEach((c, i) =>
    c.attempts.forEach((t, k) => {
      const ms = instant(t.at, `calls.${i}.attempts.${k}.at`);
      if (ms < first) first = ms;
      if (ms > last) last = ms;
    }),
  );
  spares.forEach((s, k) => {
    const sent = instant(s.sent_at, `spares.${k}.sent_at`);
    const ended = instant(s.ended_at, `spares.${k}.ended_at`);
    if (sent < first) first = sent;
    if (sent > last) last = sent;
    if (ended > last) last = ended;
  });
  if (first === Number.POSITIVE_INFINITY) return null;
  return { started_at: new Date(first).toISOString(), finished_at: new Date(last).toISOString(), elapsed_ms: last - first };
}

/**
 * The calls' totals: their count, and every attempt the heat sent, its spares' too (the header's spares: the heat paid
 * for them), counted, its usage and price summed.
 */
function totalsOf(calls: readonly JudgeHeatCallT[], spares: readonly JudgeHeatSpareT[] = []): JudgeHeatTotalsT {
  const attempts = [...calls.flatMap((c) => c.attempts), ...spares.flatMap((s) => s.attempts)];
  return {
    calls: calls.length,
    attempts: attempts.length,
    usage: usageSum(attempts.map((t) => t.usage)) ?? { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, reasoning: 0 },
    micro_usd: microUsdSum(attempts.map((t) => t.micro_usd)),
  };
}

/** The totals a record written now carries: totalsOf's, and the timing the calls and spares name (judgeHeatTimingOf), when they name one. */
function timedTotalsOf(calls: readonly JudgeHeatCallT[], spares: readonly JudgeHeatSpareT[] = []): JudgeHeatTotalsT {
  const totals = totalsOf(calls, spares);
  const timing = judgeHeatTimingOf(calls, spares);
  return timing === null ? totals : { ...totals, ...timing };
}

/** What does not hold between a record's totals and the timing its calls and spares name (none when it holds): each issue names where. */
function judgeHeatTimingIssuesOf(calls: readonly JudgeHeatCallT[], spares: readonly JudgeHeatSpareT[], totals: JudgeHeatTotalsT): string[] {
  // The schema holds the three all or none: a record written before the timing names none, and is the bytes it always was.
  if (totals.started_at === undefined) return [];
  const timing = judgeHeatTimingOf(calls, spares);
  if (timing === null) return ['totals.started_at: the heat names a timing, and its calls and spares name no instant'];
  const issues: string[] = [];
  if (Date.parse(totals.started_at) !== Date.parse(timing.started_at)) issues.push(`totals.started_at: the heat's first send went out at ${timing.started_at}`);
  if (Date.parse(totals.finished_at!) !== Date.parse(timing.finished_at)) issues.push(`totals.finished_at: the last instant its calls and spares name is ${timing.finished_at}`);
  if (totals.elapsed_ms !== timing.elapsed_ms) issues.push(`totals.elapsed_ms: ${timing.started_at} to ${timing.finished_at} is ${timing.elapsed_ms} ms`);
  return issues;
}

/** Whether `invalid` calls of `calls` is more than the share `max` (a Fixed9 string) allows: exact, in integers. */
export function judgeHeatInvalidShareOver(invalid: number, calls: number, max: string): boolean {
  if (!Number.isSafeInteger(calls) || calls < 0 || !Number.isSafeInteger(invalid) || invalid < 0 || invalid > calls) {
    throw new RangeError(`${String(invalid)} invalid of ${String(calls)} calls is no count`);
  }
  return BigInt(invalid) * FIXED9_SCALE > BigInt(calls) * parseFixed9(max);
}

// ---------------------------------------------------------------- the judges

/**
 * The judges a heat's calls name (the header's judges; a call's `judge` indexes them): its setup's `judges`, or on one
 * that lists none the one judge its agent names, on judgeDoorOf(agent.model), weight 1, via `rules` (derived: such a
 * record never stored a door). JudgeHeatError when it lists none and its agent names no one model; JudgeDoorRefusal on
 * masq's spelling of a router model.
 */
export function judgeHeatJudgesOf(record: Pick<JudgeHeatSetupT, 'agent' | 'judges'>): JudgeOfHeatT[] {
  if (record.judges !== undefined) return [...record.judges];
  const named = namedJudgeAgent(record.agent);
  if (named === null) throw new JudgeHeatError("the heat lists no judges, and its judge block names no one model (a pool, or the house's)");
  return [
    {
      model: named.model,
      door: judgeDoorOf(named.model),
      weight: 1,
      max_output_tokens: named.max_output_tokens,
      ...(named.reasoning_effort === undefined ? {} : { reasoning_effort: named.reasoning_effort }),
      ...(named.temperature === undefined ? {} : { temperature: named.temperature }),
      via: 'rules',
    },
  ];
}

/**
 * What does not hold in calls' judges and providers beyond the schedule (the header's judges), each issue naming where:
 * a call names `judge` exactly when the setup lists `judges`, one of them; a game's two calls name one judge; an attempt,
 * a call's or a spare's, names its `provider` only when its call's judge is on the openrouter door (a setup that lists
 * none: its agent's derived judge). Which judge a call has is the schedule's (judgeDealtIssue).
 */
function judgeHeatJudgeIssuesOf(setup: JudgeHeatSetupT, calls: readonly JudgeHeatCallT[], spares: readonly JudgeHeatSpareT[]): string[] {
  const issues: string[] = [];
  const judges = setup.judges;
  // The derived judge's door, read only when an attempt names a provider: a stored record's model is never asked one.
  let derived: JudgeDoorT | null | undefined;
  const doorOf = (c: JudgeHeatCallT): JudgeDoorT | null => {
    if (judges !== undefined) return c.judge === undefined ? null : (judges[c.judge]?.door ?? null);
    if (derived === undefined) {
      try {
        derived = judgeHeatJudgesOf(setup)[0]!.door;
      } catch (err) {
        if (!(err instanceof JudgeHeatError || err instanceof JudgeDoorRefusal)) throw err;
        derived = null;
      }
    }
    return derived;
  };
  const providers = (where: string, attempts: readonly JudgeHeatAttemptT[], c: JudgeHeatCallT | undefined): void => {
    attempts.forEach((t, n) => {
      if (t.provider !== undefined && (c === undefined || doorOf(c) !== 'openrouter')) issues.push(`${where}.attempts.${n}.provider: only an attempt an openrouter judge was sent names who served it`);
    });
  };
  calls.forEach((c, i) => {
    if (judges === undefined) {
      if (c.judge !== undefined) issues.push(`calls.${i}.judge: a heat that lists no judges names none on its calls`);
    } else if (c.judge === undefined) issues.push(`calls.${i}.judge: a heat that lists its judges names each call's`);
    else if (c.judge >= judges.length) issues.push(`calls.${i}.judge: ${c.judge} names no judge: ${judges.length} are listed`);
    const prev = calls[i - 1];
    if (i % 2 === 1 && prev !== undefined && c.judge !== undefined && prev.judge !== undefined && c.judge !== prev.judge) {
      issues.push(`calls.${i}.judge: a game's two calls have one judge, and this one's are ${prev.judge} and ${c.judge}`);
    }
    providers(`calls.${i}`, c.attempts, c);
  });
  spares.forEach((s, k) => providers(`spares.${k}`, s.attempts, calls[s.call]));
  return issues;
}

/** The first call whose judge is not the one the schedule dealt it (its planned call's), or null. */
function judgeDealtIssue(planned: readonly JudgePlannedCallT[], calls: readonly Pick<JudgeHeatCallT, 'judge'>[]): string | null {
  for (let i = 0; i < Math.min(planned.length, calls.length); i++) {
    if (calls[i]!.judge !== planned[i]!.judge) return `calls.${i}.judge: the heat deals this call to judge ${String(planned[i]!.judge)}, not ${String(calls[i]!.judge)}`;
  }
  return null;
}

// ---------------------------------------------------------------- issues, verdicts, parsing

/**
 * What does not hold in a record (none when it holds): its setup (judgeHeatSetupIssues), every call's place in the
 * schedule re-derived from the seed and the verdicts before it and its shape the format's (a v2 call's margin, a v1
 * call's none), the spares (each one's fields, judgeHeatSpareIssues; each naming a listed call, ordered by call, then
 * send, at most JUDGE_HEAT_MAX_SENDS - 1 a call; none in a v1 record), the games (folded as the format folds them: a v2
 * game's a_points, a v1 game's none), the finalists, the totals (the spares' attempts included, and the timing held to
 * judgeHeatTimingOf's) and the invalid calls,
 * and an invalid share within invalid_share_max; the calls' judges and the attempts' providers (judgeHeatJudgeIssuesOf),
 * each call's judge the one the schedule dealt it. Each issue names where.
 */
export function judgeHeatRecordIssues(raw: JudgeHeatRecordT): string[] {
  const parsed = JudgeHeatRecord.safeParse(raw);
  if (!parsed.success) return recordShapeIssues(parsed.error);
  return parsedRecordIssues(parsed.data);
}

/** A record's shape issues as judgeHeatRecordIssues words them (zod's, each naming where). */
function recordShapeIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(record)'}: ${i.message}`);
}

/**
 * judgeHeatRecordIssues over a record already parsed (JudgeHeatRecord), so it is parsed once. `built`: the record
 * judgeHeatRecordOf has just built from a setup that holds (judgeHeatSetupIssues) and the schedule it planned over its
 * calls with no issue and complete: its setup, its schedule, and the games, finalists, totals and invalid calls it
 * derived from that schedule and those calls are not derived again (they hold by construction); every other check runs.
 */
function parsedRecordIssues(record: JudgeHeatRecordT, built?: { schedule: JudgeHeatScheduleT }): string[] {
  const issues = built === undefined ? setupIssuesOf(record) : [];
  record.calls.forEach((c, i) => issues.push(...judgeHeatCallIssues(c).map((issue) => `calls.${i}.${issue}`)));
  issues.push(...sparesIssuesOf(record.format, record.spares ?? [], record.calls.length));
  if (issues.length === 0) issues.push(...judgeHeatJudgeIssuesOf(record, record.calls, record.spares ?? []));
  if (issues.length > 0) return issues;
  // A calibration is planned whole, every repeat at once: its calls are counted first, so a record whose repeats are
  // past the calls it lists is refused before the schedule plans them.
  if (record.stage === 'calibration') {
    const want = judgeHeatPlannedCalls(record);
    if (want !== record.calls.length) return [`calls: the calibration makes ${want} calls, and ${record.calls.length} are listed`];
  }
  const s = built?.schedule ?? judgeHeatSchedule(record, record.calls);
  if (s.issue !== null) return [s.issue];
  const dealt = judgeDealtIssue(s.planned, record.calls);
  if (dealt !== null) return [dealt];
  if (!s.complete || record.calls.length !== s.planned.length) return [`calls: the heat makes ${s.planned.length}${s.complete ? '' : ' or more'} calls, and ${record.calls.length} are listed`];
  if (built !== undefined) {
    // Built from these calls and this schedule: only the invalid share is left to hold.
    const invalid = record.invalid_calls;
    if (judgeHeatInvalidShareOver(invalid, record.calls.length, record.invalid_share_max)) {
      issues.push(`invalid_calls: ${invalid} of ${record.calls.length} calls have no verdict, more than the ${record.invalid_share_max} share the heat allows`);
    }
    return issues;
  }
  const games = gamesOf(record.format, record.calls);
  if (games.length !== record.games.length) issues.push(`games: the calls make ${games.length} games, and ${record.games.length} are listed`);
  else {
    const at = games.findIndex((g, i) => canonicalJson(g) !== canonicalJson(record.games[i]));
    if (at !== -1) issues.push(`games.${at}: the calls make ${canonicalJson(games[at])} here`);
  }
  if (canonicalJson(s.finalists) !== canonicalJson(record.finalists)) issues.push(`finalists: the Swiss names ${JSON.stringify(s.finalists)}, not ${JSON.stringify(record.finalists)}`);
  // The four counts and sums are derived whole; the timing is held to its own derivation, and is absent on a record
  // written before it (the totals' schema holds its three keys all or none).
  const totals = totalsOf(record.calls, record.spares ?? []);
  const { started_at: _started, finished_at: _finished, elapsed_ms: _elapsed, ...held } = record.totals;
  if (canonicalJson(totals) !== canonicalJson(held)) issues.push(`totals: the calls and their spares total ${canonicalJson(totals)}`);
  else issues.push(...judgeHeatTimingIssuesOf(record.calls, record.spares ?? [], record.totals));
  const invalid = record.calls.filter((c) => c.verdict === null).length;
  if (invalid !== record.invalid_calls) issues.push(`invalid_calls: ${invalid} calls have no verdict, not ${record.invalid_calls}`);
  else if (judgeHeatInvalidShareOver(invalid, record.calls.length, record.invalid_share_max)) {
    issues.push(`invalid_calls: ${invalid} of ${record.calls.length} calls have no verdict, more than the ${record.invalid_share_max} share the heat allows`);
  }
  return issues;
}

/** Each member's matches by outcome. */
function tallyOf(members: readonly string[], games: readonly JudgeHeatGameT[]): Map<string, { wins: number; draws: number; losses: number }> {
  const out = new Map(members.map((m) => [m, { wins: 0, draws: 0, losses: 0 }]));
  for (const g of games) {
    const a = out.get(g.a)!;
    const b = out.get(g.b)!;
    if (g.result === 'a') {
      a.wins++;
      b.losses++;
    } else if (g.result === 'b') {
      b.wins++;
      a.losses++;
    } else {
      a.draws++;
      b.draws++;
    }
  }
  return out;
}

/** Millionths, rounded (Math.round: exact). */
function micro(x: number): number {
  return Math.round(x * JUDGE_MICRO);
}

/**
 * `member`'s twentieths of a win over the playoff games it played against `peer` (a v2 game's a_points from its side).
 * Swiss games never count: their pairings follow the standing, so two members meet there unevenly.
 */
function playoffPointsOf(games: readonly JudgeHeatGameT[], member: string, peer: string): number {
  let points = 0;
  for (const g of games) {
    if (g.stage !== 'playoff') continue;
    if (g.a === member && g.b === peer) points += g.a_points!;
    else if (g.a === peer && g.b === member) points += JUDGE_GAME_POINTS - g.a_points!;
  }
  return points;
}

/**
 * Every member's score over every game of a record that holds (the header's fit and score). A v2 record's scores also
 * carry what breaks an exact tie (contracts/score.ts ProgramJudgeScore): each its member's artifact_bytes and, for an
 * entrant member of a final heat with exact-tie peers (the other entrant members scored with the same win_rate_micro
 * and the same finalist flag), head_to_head: its playoff points against each, in sha256 order. A v1 record's carry
 * neither, so their bytes are what they were.
 */
function scoresOf(record: JudgeHeatRecordT): Map<string, ProgramJudgeScoreT> {
  if (record.ladder !== undefined) return ladderScoresOf(record, record.ladder);
  if (judgeHeatScreenedFormat(record.format) && record.race !== undefined) return screenedScoresOf(record, record.race);
  const members = record.field.map((m) => m.artifact_sha256);
  const out = new Map<string, ProgramJudgeScoreT>();
  if (members.length < 2) return out;
  const v2 = record.format !== JUDGE_HEAT_FORMAT_V1;
  // A calibration's scores, as a provisional heat's, are shown and never weighed.
  const provisional = record.stage !== 'final';
  const fit = judgeFit(members, record.games);
  const tally = tallyOf(members, record.games);
  const finalists = new Set(record.finalists);
  const bases = new Map<string, Omit<ProgramJudgeScoreT, 'head_to_head'>>();
  for (const m of record.field) {
    const sha = m.artifact_sha256;
    const t = tally.get(sha)!;
    const matches = t.wins + t.draws + t.losses;
    if (matches === 0) continue;
    const { e, se } = fit.get(sha)!;
    const half = JUDGE_Z90 * se;
    bases.set(sha, {
      win_rate_micro: micro(e),
      se_micro: Math.min(JUDGE_MICRO, micro(se)),
      interval_low_micro: micro(Math.max(0, e - half)),
      interval_high_micro: micro(Math.min(1, e + half)),
      wins: t.wins,
      draws: t.draws,
      losses: t.losses,
      matches,
      finalist: finalists.has(sha),
      provisional,
      artifact_sha256: sha,
      ...(v2 ? { artifact_bytes: m.artifact_bytes! } : {}),
    });
  }
  const entrants = record.field.filter((m) => !m.anchor && bases.has(m.artifact_sha256)).map((m) => m.artifact_sha256);
  for (const [sha, base] of bases) {
    let headToHead: { artifact_sha256: string; points: number }[] = [];
    if (v2 && !provisional && entrants.includes(sha)) {
      headToHead = entrants
        .filter((peer) => peer !== sha && bases.get(peer)!.win_rate_micro === base.win_rate_micro && bases.get(peer)!.finalist === base.finalist)
        .map((peer) => ({ artifact_sha256: peer, points: playoffPointsOf(record.games, sha, peer) }));
    }
    out.set(sha, ProgramJudgeScore.parse(headToHead.length === 0 ? base : { ...base, head_to_head: headToHead }));
  }
  return out;
}

/**
 * A screened final's scores (the header's screened final), in field order. A member of the shortlist S (the screen's,
 * anchors included) that played: judgeFit over the record's games among S (E against S), its se scaled by
 * sqrt(phi_margin x phi^) (phi^ judgeHeatDispersion over the same games and fit), its interval E -+ z se clamped to
 * [0, 1] (the race's z), its finalist flag and exact-tie head_to_head as a v2 final's. A rated entrant the screen left
 * off S: `screened_out`, its house-only dev rating's win rate, se and interval from the screen (the board's dev score
 * against the house's fixed images: a contender sub-rating, which only placed it against the line, is never read
 * here), over 0 matches, never a finalist, never provisional, no head_to_head (and never anyone's exact-tie peer). An
 * unrated entrant is never screened out. No score reads a contender verdict: S's come from the final's games alone. A
 * v5 or v6 record's read its games as they score (judgeHeatScoredGames): each playoff slot one match, at its panel's
 * median, and no shadow game, so the shadow's verdicts move no score.
 */
function screenedScoresOf(record: JudgeHeatRecordT, race: JudgeHeatRaceT): Map<string, ProgramJudgeScoreT> {
  const out = new Map<string, ProgramJudgeScoreT>();
  const screen = judgeHeatScreenOf(record)!;
  const shortlist = screen.shortlist;
  const inShortlist = new Set(shortlist);
  const screenedOut = new Set(screen.screened_out);
  const ratings = new Map<string, JudgeScreenRatingT>();
  for (const m of record.screen!.members) if ('rated' in m) ratings.set(m.artifact_sha256, m.rated);
  // A v5 record's games as they score (judgeHeatScoredGames: a playoff slot its counted panel seats' median, a seat with
  // a call of no verdict void, the shadow's dropped); a v4 record's are its own.
  const games = judgeHeatScoredGames(record, record.games, judgeGamesVoidOf(record.calls));
  let fit: Map<string, JudgeFitT> | null = null;
  let scale = 1;
  if (shortlist.length >= 2) {
    fit = judgeFit(shortlist, games);
    scale = Math.sqrt(judgeRaceNumber(race.phi_margin, 'the phi margin', 1) * judgeHeatDispersion(games, fit));
  }
  const z = judgeRaceNumber(race.z, 'z', 0, true);
  const tally = tallyOf(shortlist, games);
  const finalists = new Set(record.finalists);
  const bases = new Map<string, Omit<ProgramJudgeScoreT, 'head_to_head'>>();
  for (const m of record.field) {
    const sha = m.artifact_sha256;
    if (screenedOut.has(sha)) {
      // The house-only dev rating's millionths: a contender sub-rating has none, so it can never reach a score.
      const r = ratings.get(sha)!;
      bases.set(sha, {
        win_rate_micro: r.win_rate_micro,
        se_micro: r.se_micro,
        interval_low_micro: r.interval_low_micro,
        interval_high_micro: r.interval_high_micro,
        wins: 0,
        draws: 0,
        losses: 0,
        matches: 0,
        finalist: false,
        provisional: false,
        artifact_sha256: sha,
        artifact_bytes: m.artifact_bytes!,
        screened_out: true,
      });
      continue;
    }
    if (fit === null || !inShortlist.has(sha)) continue;
    const t = tally.get(sha)!;
    const matches = t.wins + t.draws + t.losses;
    if (matches === 0) continue;
    const { e, se: fitSe } = fit.get(sha)!;
    const se = fitSe * scale;
    const half = z * se;
    bases.set(sha, {
      win_rate_micro: micro(e),
      se_micro: Math.min(JUDGE_MICRO, micro(se)),
      interval_low_micro: micro(Math.max(0, e - half)),
      interval_high_micro: micro(Math.min(1, e + half)),
      wins: t.wins,
      draws: t.draws,
      losses: t.losses,
      matches,
      finalist: finalists.has(sha),
      provisional: false,
      artifact_sha256: sha,
      artifact_bytes: m.artifact_bytes!,
    });
  }
  // The shortlisted entrants by (win rate, finalist flag), each group in sha256 order: an entrant's exact-tie peers are its group's others.
  const tied = new Map<string, string[]>();
  for (const m of record.field) {
    const base = bases.get(m.artifact_sha256);
    if (m.anchor || base === undefined || base.screened_out === true) continue;
    const key = `${base.win_rate_micro}:${base.finalist}`;
    const group = tied.get(key) ?? [];
    group.push(m.artifact_sha256);
    tied.set(key, group);
  }
  for (const [sha, base] of bases) {
    let headToHead: { artifact_sha256: string; points: number }[] = [];
    const group = base.screened_out === true ? undefined : tied.get(`${base.win_rate_micro}:${base.finalist}`);
    if (group !== undefined && group.includes(sha)) {
      headToHead = group.filter((peer) => peer !== sha).map((peer) => ({ artifact_sha256: peer, points: playoffPointsOf(games, sha, peer) }));
    }
    out.set(sha, ProgramJudgeScore.parse(headToHead.length === 0 ? base : { ...base, head_to_head: headToHead }));
  }
  return out;
}

/**
 * A provisional heat's score on a ladder (the header's ladder): its entry's member's alone, rated against the record's
 * own fixed strengths and dispersion (grader/judge-ladder.ts judgeLadderScore, E over the judge anchors), its matches
 * every game it played. Shown, never weighed: provisional, never a finalist, no head-to-head.
 */
function ladderScoresOf(record: JudgeHeatRecordT, ladder: JudgeHeatLadderT): Map<string, ProgramJudgeScoreT> {
  const out = new Map<string, ProgramJudgeScoreT>();
  const member = record.field.find((m) => m.entries.length > 0);
  if (member === undefined) return out;
  const subject = member.artifact_sha256;
  const t = tallyOf(
    record.field.map((m) => m.artifact_sha256),
    record.games,
  ).get(subject)!;
  const matches = t.wins + t.draws + t.losses;
  if (matches === 0) return out;
  const s = judgeLadderScore({
    subject,
    games: record.games,
    strengths: judgeLadderStrengths(ladder.strengths),
    anchors: anchorsOf(record, subject),
    phi: judgeLadderFromFixed9(ladder.dispersion),
  });
  out.set(
    subject,
    ProgramJudgeScore.parse({
      win_rate_micro: s.win_rate_micro,
      se_micro: s.se_micro,
      interval_low_micro: s.interval_low_micro,
      interval_high_micro: s.interval_high_micro,
      wins: t.wins,
      draws: t.draws,
      losses: t.losses,
      matches,
      finalist: false,
      provisional: true,
      artifact_sha256: subject,
      artifact_bytes: member.artifact_bytes!,
    }),
  );
  return out;
}

/** A calibration's fit, what a ladder heat rates by: every member's fixed strength in sha256 order, and the dispersion. */
export interface JudgeLadderFitT {
  strengths: JudgeLadderStrengthT[];
  /** phi, Fixed9 (grader/judge-ladder.ts judgeLadderDispersion). */
  dispersion: string;
}

function ladderFitOf(record: JudgeHeatRecordT): JudgeLadderFitT {
  const members = record.field.map((m) => m.artifact_sha256);
  const fit = judgeFit(members, record.games);
  try {
    return {
      strengths: members.map((m) => ({ artifact_sha256: m, strength: judgeLadderToFixed9(fit.get(m)!.p) })),
      dispersion: judgeLadderDispersion(record.games, fit),
    };
  } catch (err) {
    if (err instanceof RangeError) throw new JudgeHeatError(`the calibration's fit is no ladder: ${err.message}`);
    throw err;
  }
}

/**
 * The ladder a calibration record measures (the header's ladder): judgeFit over its games, each member's strength as
 * Fixed9 (grader/judge-ladder.ts judgeLadderToFixed9), and the pooled within-pair dispersion over the same fit. Derived
 * twice, and the two must be the same bytes, as judgeHeatVerdicts derives. JudgeHeatError when the record does not hold
 * (judgeHeatRecordIssues), is not a calibration's, or a fitted strength has no Fixed9 form.
 */
export function judgeLadderFitOf(record: JudgeHeatRecordT): JudgeLadderFitT {
  const issues = judgeHeatRecordIssues(record);
  if (issues.length > 0) throw doesNotHold(issues);
  const parsed = JudgeHeatRecord.parse(record);
  if (parsed.stage !== 'calibration') throw new JudgeHeatError(`a ladder's fit is a calibration's, and this record is a ${parsed.stage} heat's`);
  const first = ladderFitOf(parsed);
  const second = ladderFitOf(parsed);
  const a = canonicalJson(first);
  const b = canonicalJson(second);
  if (a !== b) throw new JudgeHeatError(`the calibration's fit differs across two derivations: ${sha256Hex(a)} against ${sha256Hex(b)}`);
  return first;
}

function doesNotHold(issues: readonly string[]): JudgeHeatError {
  return new JudgeHeatError(`the heat record does not hold: ${issues.slice(0, 5).join('; ')}${issues.length > 5 ? `; and ${issues.length - 5} more` : ''}`);
}

/**
 * Every member's score from a record that holds (the header's score), keyed by artifact sha256, in field order: the
 * anchors' too (the judge breakdown's), none for a member that played no game. Derived twice, and the two must be
 * the same bytes. What a run's performance.judge is built with, by the heat and by a regrade from the stored blob
 * alike. JudgeHeatError when the record does not hold (judgeHeatRecordIssues).
 */
export function judgeHeatVerdicts(record: JudgeHeatRecordT): Map<string, ProgramJudgeScoreT> {
  // Parsed once: judgeHeatRecordIssues' own parse is the record's.
  const parsed = JudgeHeatRecord.safeParse(record);
  if (!parsed.success) throw doesNotHold(recordShapeIssues(parsed.error));
  const issues = parsedRecordIssues(parsed.data);
  if (issues.length > 0) throw doesNotHold(issues);
  return heldScoresOf(parsed.data);
}

/**
 * judgeHeatVerdicts of a record already parsed and held (judgeHeatRecordOf's answer, or parseJudgeHeatRecord's), not
 * held again: every member's score derived twice, and the two the same bytes. JudgeHeatError when they are not.
 */
export function judgeHeatHeldVerdicts(parsed: JudgeHeatRecordT): Map<string, ProgramJudgeScoreT> {
  return heldScoresOf(parsed);
}

function heldScoresOf(parsed: JudgeHeatRecordT): Map<string, ProgramJudgeScoreT> {
  const first = scoresOf(parsed);
  const second = scoresOf(parsed);
  const a = canonicalJson([...first]);
  const b = canonicalJson([...second]);
  if (a !== b) throw new JudgeHeatError(`the heat's scores differ across two derivations: ${sha256Hex(a)} against ${sha256Hex(b)}`);
  return first;
}

/** Each entry's score (judgeHeatVerdicts: its artifact's member's), keyed by entry id, in field order. */
export function judgeHeatEntryVerdicts(record: JudgeHeatRecordT): Map<string, ProgramJudgeScoreT> {
  return judgeHeatEntryVerdictsOf(record.field, judgeHeatVerdicts(record));
}

/** judgeHeatEntryVerdicts from a field and its members' scores (judgeHeatVerdicts'), keyed by entry id, in field order. */
export function judgeHeatEntryVerdictsOf(field: readonly Pick<JudgeFieldMemberT, 'artifact_sha256' | 'entries'>[], scores: ReadonlyMap<string, ProgramJudgeScoreT>): Map<string, ProgramJudgeScoreT> {
  const out = new Map<string, ProgramJudgeScoreT>();
  for (const m of field) {
    const score = scores.get(m.artifact_sha256);
    if (score !== undefined) for (const e of m.entries) out.set(e, score);
  }
  return out;
}

/**
 * The record of a heat whose calls are all made: `calls` in the order they ran, the games, finalists, totals and
 * invalid calls derived from them (the totals carrying the heat's timing, judgeHeatTimingOf, which the calls and their
 * spares name), and `spares`, the calls' other sends ordered by call, then send (the header's spares; the key absent
 * when there are none, so a record without them is the bytes it always was), counted in the totals and never scored.
 * JudgeHeatError when the calls are not the heat's, not all of them, more of them came back invalid than
 * invalid_share_max allows (the heat does not count, and no score is written), or a spare does not hold.
 */
export function judgeHeatRecordOf(setup: JudgeHeatSetupT, calls: readonly JudgeHeatCallT[], spares: readonly JudgeHeatSpareT[] = []): JudgeHeatRecordT {
  const setupIssues = judgeHeatSetupIssues(setup);
  if (setupIssues.length > 0) throw doesNotHold(setupIssues);
  const s = judgeHeatSchedule(setup, calls);
  if (s.issue !== null) throw new JudgeHeatError(`the calls made are not the heat's: ${s.issue}`);
  if (!s.complete || calls.length !== s.planned.length) throw new JudgeHeatError(`the heat is not done: ${calls.length} of its ${s.planned.length}${s.complete ? '' : ' or more'} calls are made`);
  const record: JudgeHeatRecordT = {
    ...JudgeHeatSetup.parse(setup),
    calls: [...calls],
    games: gamesOf(setup.format, calls),
    finalists: s.finalists ?? [],
    totals: timedTotalsOf(calls, spares),
    invalid_calls: calls.filter((c) => c.verdict === null).length,
    ...(spares.length === 0 ? {} : { spares: [...spares] }),
  };
  // Held once (judgeHeatRecordIssues), parsed once: what it derived from this schedule is not derived again.
  const parsed = JudgeHeatRecord.safeParse(record);
  if (!parsed.success) throw doesNotHold(recordShapeIssues(parsed.error));
  const issues = parsedRecordIssues(parsed.data, { schedule: s });
  if (issues.length > 0) throw doesNotHold(issues);
  return parsed.data;
}

/**
 * The end of a heat whose calls are all made, its record held once: judgeHeatRecordOf's record, judgeHeatRecordDigest's
 * canonical JSON and sha256 of it (the record is JudgeHeatRecord's parse, which parsing again answers unchanged: no
 * schema of it transforms), and judgeHeatEntryVerdicts' verdicts by entry (judgeHeatHeldVerdicts), or, when its scores
 * differ across their two derivations, that JudgeHeatError's message (`verdictsIssue`: the record stands, its verdicts
 * do not). JudgeHeatError as judgeHeatRecordOf throws it.
 */
export interface JudgeHeatRecordEndT {
  record: JudgeHeatRecordT;
  json: string;
  sha256: string;
  verdicts: Map<string, ProgramJudgeScoreT> | null;
  verdictsIssue: string | null;
}

export function judgeHeatRecordEnd(setup: JudgeHeatSetupT, calls: readonly JudgeHeatCallT[], spares: readonly JudgeHeatSpareT[] = []): JudgeHeatRecordEndT {
  const record = judgeHeatRecordOf(setup, calls, spares);
  const json = canonicalJson(record);
  let verdicts: Map<string, ProgramJudgeScoreT> | null = null;
  let verdictsIssue: string | null = null;
  try {
    verdicts = judgeHeatEntryVerdictsOf(record.field, heldScoresOf(record));
  } catch (err) {
    if (!(err instanceof JudgeHeatError)) throw err;
    verdictsIssue = err.message;
  }
  return { record, json, sha256: sha256Hex(json), verdicts, verdictsIssue };
}

/** The record as stored (canonical JSON text or bytes), parsed and checked: JudgeHeatError when it is no record that holds. */
export function parseJudgeHeatRecord(stored: string | Uint8Array): JudgeHeatRecordT {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof stored === 'string' ? stored : new TextDecoder('utf-8', { fatal: true }).decode(stored));
  } catch (err) {
    throw new JudgeHeatError(`the heat record is not JSON: ${(err as Error).message}`);
  }
  const parsed = JudgeHeatRecord.safeParse(raw);
  if (!parsed.success) throw new JudgeHeatError(`the heat record is not one: ${parsed.error.issues[0]?.message ?? 'malformed'}`);
  // Parsed once: judgeHeatRecordIssues' own parse is this one.
  const issues = parsedRecordIssues(parsed.data);
  if (issues.length > 0) throw new JudgeHeatError(`the heat record does not hold: ${issues[0]}`);
  return parsed.data;
}

/**
 * A stored record read back (parseJudgeHeatRecord: parsed and held once) and held to its bytes: the record, or why it is
 * refused (parseJudgeHeatRecord's JudgeHeatError message), or that its bytes are not its canonical JSON (the text
 * judgeHeatRecordDigest writes: canonicalJson of the parsed record, which parsing again answers unchanged).
 */
export function judgeHeatRecordRead(stored: Uint8Array): { record: JudgeHeatRecordT } | { refused: string } | { uncanonical: true } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stored);
  } catch (err) {
    return { refused: `the heat record is not JSON: ${(err as Error).message}` };
  }
  let record: JudgeHeatRecordT;
  try {
    record = parseJudgeHeatRecord(text);
  } catch (err) {
    if (err instanceof JudgeHeatError) return { refused: err.message };
    throw err;
  }
  // The decoder drops a leading byte order mark, which the stored bytes' own text keeps: such bytes are never canonical.
  const bom = stored.length >= 3 && stored[0] === 0xef && stored[1] === 0xbb && stored[2] === 0xbf;
  return !bom && canonicalJson(record) === text ? { record } : { uncanonical: true };
}
