// A capped judged final's contender cut (contracts/competition.ts ProgramJudge.contenders), the pure parts every reader
// of it shares: grader/worker.ts decides and stores it (judgeContenderCut: one phase.cut row on basis judge_dev, then
// one phase.cut_late row for each entry graded after it), grader/regrade.ts holds a cut run's stored score to it, the
// final kit carries it (server/routes/competitions/kit.ts, cli/kit.ts KitJudgeCut) and cli/verify-result.ts re-derives
// it. No database, no clock: a function of its arguments.
//
//   the rule       judgeContenderCutOf: the dev board's top N RATED entrants (the ones it ranks: a judged dev grade)
//                  by its rank, exactly N, hold the N seats; nothing past the N-th takes one, an entrant tied with it
//                  on the rank column's value included (the call of 2026-11-19: the board's rank already breaks that
//                  tie by its own published tie-break, below, and keeping every tie at the line left the heat's size
//                  unbounded: a rig field of 3,500 at contenders 1,000 sent all 3,500 on, 2,501 tied at the 1,000th);
//                  every entrant the board does not rate (its dev grade passed and no dev judge verdict was ever
//                  recorded: a dev judge call that faulted, say) goes on too and takes no seat, as a screened final
//                  sends every unrated entry on at its line (.cosmos/rules/judge-screened.mdc), and so do the house's
//                  own entries; an entry is cut only when it HAS a dev rating outside the N seats. So 255 rated and 235
//                  unrated entries at contenders 500 all go on.
//   the rank       the board's rank is each row's own place in its performance order (server/routes/competitions/
//                  ranking.ts: a row's rank is its position + 1), never shared: an exact tie on the rank column goes
//                  to head-to-head on a judge heat's board (the playoff games between the tied entries: none on a dev
//                  board), then the bundle's tie-break column, then the earlier receipt (byRankKey), the tie-break the
//                  bundle's rules and the board's tie_break publish (server/routes/competitions/tie-break.ts
//                  tieBreakText). A board that names two rated entrants at one rank is not the board's and is refused
//                  (a RangeError naming both), never broken here by any other order.
//   the board      the values the cut was drawn on, carried with it (JudgeCutBoard: each field entry's board rank and
//                  its value on the rank column, null for one the board does not rate), so a reader re-derives who went
//                  on from them (cli/verify-result.ts, judgeContenderCutOf again) rather than taking the cut's word
//   the rating     a cut entry keeps its latest dev grade's judge rate, se and interval as read when its decision was
//                  made (JudgeCutRating), never re-read; JUDGE_CUT_NO_RATING where none read then (below)
//   the score      a cut entry's final score carries judgeContenderCutScore of that rating on its final artifact:
//                  screened out, over no final game, never a finalist, never provisional
//   a late entry   one of the heat's field the phase.cut row does not name (graded after the cut: an admin's resend)
//                  is decided once against the stored line (judgeLateGoesOn), displacing nobody: on when it is the
//                  house's, when the board does not rate it, or when it rates it at or inside the line (every rated
//                  one when the line is null)

import type { ProgramJudgeScoreT } from '../contracts/score.ts';
import { compareCodeUnits } from '../sim/canonical.ts';

/** A cut entry's dev rating as a capped final keeps it (judgeContenderCutScore): its latest dev grade's judge rate, se and interval, in millionths. */
export type JudgeCutRating = Pick<ProgramJudgeScoreT, 'win_rate_micro' | 'se_micro' | 'interval_low_micro' | 'interval_high_micro'>;

/**
 * The rating a capped final's cut entry keeps when its latest dev grade carried no judge score when its decision was
 * made, though the board rated it (the board ranks on the entry's standing dev run, the rating is read off its newest
 * one: a dev regrade still running, or one that failed, after a judged one): none, held as zero rate, se and interval,
 * so its screened-out score ranks it below every rated cut entry, never paid. An entry the board does not rate is never
 * cut (judgeContenderCutOf), so it never keeps this. Its cut names no rating of it, and the kit's cut none
 * (cli/verify-result.ts reads the absence so).
 *
 * Under blind rounds the board is a judged round's standings, not the dev board (which then rates no entry, so it shows
 * every cut entry unrated): an entry those standings score is rated there and may be cut, and keeps the verdict of the
 * round that last judged it (grader/worker.ts blindRoundCutRatings), this only when no round's record holds one. A
 * round cut by a release before that carry kept this for every entry it carried a second time, and its standings show
 * those at 0 (make-the-ai-judge-feel-held-20261122-1600: round 3 and its final, so 2,724 of the final's 3,171 cut
 * entries); a later cut reads each back to its verdict.
 */
export const JUDGE_CUT_NO_RATING: JudgeCutRating = Object.freeze({ win_rate_micro: 0, se_micro: 0, interval_low_micro: 0, interval_high_micro: 0 });

/**
 * A capped final's cut entry's score: screened out (contracts/score.ts ProgramJudgeScore.screened_out), its win rate, se
 * and interval its kept dev rating's, over no final game, never a finalist, never provisional, on its final artifact.
 * Ranked below every judged entry, among its own by that rate (ranking.ts SCREENED_OUT_STAGE), never paid.
 */
export function judgeContenderCutScore(dev: JudgeCutRating, artifact: { sha256: string; bytes: number }): ProgramJudgeScoreT {
  return {
    win_rate_micro: dev.win_rate_micro,
    se_micro: dev.se_micro,
    interval_low_micro: dev.interval_low_micro,
    interval_high_micro: dev.interval_high_micro,
    wins: 0,
    draws: 0,
    losses: 0,
    matches: 0,
    finalist: false,
    provisional: false,
    artifact_sha256: artifact.sha256,
    artifact_bytes: artifact.bytes,
    screened_out: true,
  };
}

/** One entry of the field a judged final's contender cap draws over (judgeContenderCutOf). */
export interface JudgeCutFieldEntry {
  submission_id: string;
  /** The house's own entry, or a baseline (dev-profit.ts devProfitExempt): it is judged whatever the board says, and takes no seat. */
  house: boolean;
}

/** One row of the dev board as the cap reads it (leaderboardOf, the performance view): its rank (its own place, the board's tie-break in it; null: unrated) and its raw value on the rank column. */
export interface JudgeCutBoardRow {
  submission_id: string;
  rank: number | null;
  value: string | number | null;
}

/** A cut as judgeContenderCutOf draws it: who goes on, the line, and of those, who holds a seat, who goes on unrated, who is the house's. */
export interface JudgeCutDrawn {
  through: Set<string>;
  line: string | null;
  /** The rated entrants that went on (the top N by board rank, at most N): the seats. */
  seats: Set<string>;
  /** The entrants the board does not rate: on, no seat. */
  unrated: Set<string>;
  /** The house's own entries (and baselines): on, no seat. */
  house: Set<string>;
}

/**
 * A judged final's contender cap drawn (harness.judge.contenders; contracts/competition.ts ProgramJudge.contenders), the
 * rule a dev-qualified agent final's cut draws (server/grading/final-cut-job.ts devCutOf) over its rated entrants: the
 * field's entrants the dev board rates (ranks), best first by their board rank (the header's: a place of its own each,
 * its tie-break already in it); the first `contenders` of them go on, and no other: the seats, exactly `contenders`
 * once as many are rated, an entrant on the N-th's value but ranked after it cut like any other. Every entrant the board
 * does not rate (no rank, or no value on the rank column) goes on and takes no seat (the header's rule: a failed dev
 * judge call is not the entrant's fault), and so do the house's own entries. `line`: the `contenders`-th rated entrant's
 * value, kept for the record (a late entry is held to it: judgeLateGoesOn), null when fewer were rated (every rated one
 * goes on). A RangeError when two rated entrants share a board rank (the header's the rank) or `contenders` is no whole
 * number from 1. Pure.
 */
export function judgeContenderCutOf(input: { contenders: number; field: readonly JudgeCutFieldEntry[]; board: readonly JudgeCutBoardRow[] }): JudgeCutDrawn {
  if (!Number.isSafeInteger(input.contenders) || input.contenders < 1) throw new RangeError(`contenders is a whole number from 1, not ${String(input.contenders)}`);
  const board = new Map(input.board.map((r) => [r.submission_id, r]));
  const unrated = new Set<string>();
  const house = new Set<string>();
  const rated: { id: string; rank: number; value: string }[] = [];
  for (const e of input.field) {
    if (e.house) {
      house.add(e.submission_id);
      continue;
    }
    const b = board.get(e.submission_id);
    if (b === undefined || b.rank === null || b.value === null) unrated.add(e.submission_id);
    else rated.push({ id: e.submission_id, rank: b.rank, value: String(b.value) });
  }
  rated.sort((a, b) => a.rank - b.rank);
  for (let k = 1; k < rated.length; k++) {
    const [ahead, behind] = [rated[k - 1]!, rated[k]!];
    if (ahead.rank === behind.rank) {
      const [x, y] = [ahead.id, behind.id].sort(compareCodeUnits);
      throw new RangeError(`the dev board ranks entries ${x} and ${y} both at rank ${ahead.rank}: its rank is each row's own place, its tie-break in it, so no two rated entrants share one`);
    }
  }
  const line = rated.length >= input.contenders ? rated[input.contenders - 1]!.value : null;
  const seats = new Set(rated.slice(0, input.contenders).map((r) => r.id));
  return { through: new Set([...seats, ...unrated, ...house]), line, seats, unrated, house };
}

/**
 * The dev board a cut was drawn on, as the cut carries it (the phase.cut row's `board`, the kit's cut.json `board`):
 * each field entry's board rank and its value on the rank column, both null for an entry the board does not rate, in
 * the field's own order (its ids in code-unit order). Two arrays, never an object an entry: a field of 10,000 entries
 * keeps them in about 150 KB.
 */
export interface JudgeCutBoard {
  ranks: (number | null)[];
  values: (string | null)[];
}

/** The board rows `board` gives the `field` it is aligned with (judgeContenderCutOf's input again). */
export function judgeCutBoardRows(field: readonly string[], board: JudgeCutBoard): JudgeCutBoardRow[] {
  return field.map((id, k) => ({ submission_id: id, rank: board.ranks[k] ?? null, value: board.values[k] ?? null }));
}

/**
 * One entry graded after a capped final's cut, decided once (grader/worker.ts judgeContenderCut, its phase.cut_late row):
 * whether it is the house's, its value on the dev board's rank column when decided (null: the board did not rate it, so
 * it went on unrated), whether it went on, and, cut, its dev rating as read then (null: none, so JUDGE_CUT_NO_RATING).
 */
export interface JudgeLateCut {
  house: boolean;
  value: string | null;
  went_on: boolean;
  rating: JudgeCutRating | null;
}

/**
 * Whether an entry graded after the cut goes on (the header's late entry): the house's always; one the board does not
 * rate (`value` null: on, no seat, as the cut sends every unrated entry on); else one rated at or inside the stored
 * `line` on the rank column's sorting (`desc` true: higher is better), or any rated one when the line is null (fewer
 * were rated than the cap, so every rated one went on). Pure.
 */
export function judgeLateGoesOn(late: { house: boolean; value: string | null }, line: string | null, desc: boolean): boolean {
  if (late.house) return true;
  if (late.value === null) return true;
  if (line === null) return true;
  const v = Number(late.value);
  const l = Number(line);
  return desc ? v >= l : v <= l;
}

/**
 * A cut as every reader of who went on takes it (the phase.cut row with each late decision folded in): every entry it
 * was decided over (`field`: the row's and the late ones), those that went on (`through`), of them those that went on
 * unrated (`unrated`: no seat; the row's and each late entry that went on with no board value, not the house's), and
 * each cut entry's kept rating (`ratings`: an entry cut with none is absent, so JUDGE_CUT_NO_RATING).
 */
export interface JudgeCutView {
  contenders: number;
  field: ReadonlySet<string>;
  through: ReadonlySet<string>;
  unrated: ReadonlySet<string>;
  ratings: ReadonlyMap<string, JudgeCutRating>;
}

/** The cut `cut` with its late decisions folded in (JudgeCutView), ids as stored. */
export function judgeCutViewOf(cut: { contenders: number; field: ReadonlySet<string>; through: ReadonlySet<string>; unrated: ReadonlySet<string>; ratings: ReadonlyMap<string, JudgeCutRating>; late: ReadonlyMap<string, JudgeLateCut> }): JudgeCutView {
  const field = new Set(cut.field);
  const through = new Set(cut.through);
  const unrated = new Set(cut.unrated);
  const ratings = new Map(cut.ratings);
  for (const [id, l] of cut.late) {
    field.add(id);
    if (l.went_on) {
      through.add(id);
      if (!l.house && l.value === null) unrated.add(id);
    } else if (l.rating !== null) ratings.set(id, l.rating);
  }
  return { contenders: cut.contenders, field, through, unrated, ratings };
}

/**
 * Why `stored`, a run's stored judge verdict, is not the score its capped final's cut gives entry `entry` on `artifact`
 * (judgeContenderCutScore of its kept rating, or JUDGE_CUT_NO_RATING's), or why the cut gives it none (it went on, or
 * the cut was not decided over it); null when it is. `view` the cut with its late decisions (judgeCutViewOf); ids
 * compared in lower case.
 */
export function judgeCutScoreIssue(view: JudgeCutView, entry: string, artifact: { sha256: string; bytes: number }, stored: ProgramJudgeScoreT | undefined): string | null {
  const id = entry.toLowerCase();
  const lower = (s: ReadonlySet<string>) => [...s].some((x) => x.toLowerCase() === id);
  if (!lower(view.field)) return `the cut was decided over no entry ${entry}, so it gives it no cut score`;
  if (lower(view.through)) return `entry ${entry} went on at the cut (${lower(view.unrated) ? 'unrated, beside' : 'one of'} the ${view.contenders} contenders), so its verdict is the heat's, not a cut score`;
  const rating = [...view.ratings].find(([k]) => k.toLowerCase() === id)?.[1] ?? JUDGE_CUT_NO_RATING;
  const want = judgeContenderCutScore(rating, artifact);
  if (stored === undefined) return `its stored score carries no verdict, and the cut keeps entry ${entry}'s score at ${JSON.stringify(want)}`;
  const same = (Object.keys(want) as (keyof ProgramJudgeScoreT)[]).every((k) => stored[k] === want[k]) && Object.keys(stored).length === Object.keys(want).length;
  return same ? null : `its stored score's verdict is not the screened-out score the cut keeps for entry ${entry} (${JSON.stringify(want)})`;
}
