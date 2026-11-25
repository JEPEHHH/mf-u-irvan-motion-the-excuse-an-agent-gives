// A panel final's playoff, read for display (agent-fun/judge-heat/v5 or v6, grader/judge-heat.ts's panel final and
// dealt final): how its three drawn playoff seats agreed, and how far the Swiss judge's shadow games would have moved
// the finalists. Pure: no clock, no I/O, figures only. Nothing here is a score, and no score reads it: a v5 or v6
// record's scores are judgeHeatScoredGames' medians (grader/judge-heat.ts), the shadow's games never among them. The
// shadow is the record's Swiss judge (judgeHeatShadowOf): index 3 on a v5 record, its pool's size n on a v6 one, whose
// Swiss and race games are dealt over the pool and never read here. Either way the playoff has three seats and one
// shadow a slot, so every figure below is the same rule on both.
//
//   a slot        one playoff game slot (round, a, b; judgePanelSlotsOf): its panel seats' a_points and results in seat
//                 order, a seat whose game had a call come back with no verdict marked void (judgeGamesVoidOf of the
//                 record's calls), the median of the counted seats (the slot's scored game, judgePanelSlotGame) and its
//                 result, and the split over the counted seats: `unanimous` when their results agree (three draws
//                 among them; one seat counted, or none, agrees with itself), else `draw` when the median is half (10:
//                 the panel cancelled out, 18 / 10 / 4 say; every seat void is a draw), else `majority` (two of three
//                 carry it, or two counted seats' mean leans one way), the void seats named (judgePanelSplitWords: '1
//                 seat void'); and the shadow's a_points and result (null while still to come). A slot whose panel games
//                 are not all in yet (a heat still running) is `pending`, counted and never listed
//   agreement     the settled slots by split, and the disagreement rate: the share of settled slots that are not
//                 unanimous, in millionths (null with none settled)
//   the gap       each finalist's playoff win rate over the settled slots it played: its twentieths of a win from its
//                 side (a slot's median under the panel; the shadow's own a_points under the shadow, over those of
//                 its slots the shadow has judged), over 20 a slot, in millionths (null over no slot); and the gap,
//                 shadow minus panel, in millionths (the two rounded figures' difference, so the three shown agree)
//   the orders    the finalists ranked by each win rate (higher first, ties by sha256), over those with both, and
//                 Kendall's tau-b between the two rankings: (C - D) / sqrt((n0 - T1)(n0 - T2)) over the n(n-1)/2 = n0
//                 pairs, C concordant, D discordant, T1 and T2 the pairs tied in the panel's and the shadow's; in
//                 millionths, null under two finalists or when either ranking ties every pair. Every comparison is of
//                 whole numbers (twentieths x slots), so it is the same on every host

import {
  JUDGE_GAME_POINTS,
  JUDGE_HEAT_FORMAT_V5,
  JUDGE_HEAT_FORMAT_V6,
  judgeGamesVoidOf,
  judgeHeatPanelFormat,
  judgeHeatShadowOf,
  judgePanelSlotGame,
  judgePanelSlotsOf,
  judgeGameResultOf,
  type JudgeGameResultT,
  type JudgeHeatCallT,
  type JudgeHeatRecordT,
} from './judge-heat.ts';
import { JUDGE_MICRO } from '../contracts/score.ts';
import { compareCodeUnits } from '../sim/canonical.ts';

/** How a slot's panel split (the header's slot). */
export const JUDGE_PANEL_SPLITS = ['unanimous', 'majority', 'draw'] as const;
export type JudgePanelSplitT = (typeof JUDGE_PANEL_SPLITS)[number];

/**
 * One panel seat's game of a slot: its seat (the judge's index in the record's judges), its a_points and result as
 * recorded, and `void: true` when a call of it came back with no verdict (it then counts toward no median or split).
 */
export interface JudgePanelSeatGameT {
  judge: number;
  a_points: number;
  result: JudgeGameResultT;
  void?: true;
}

/** One settled playoff slot (the header's slot). */
export interface JudgePanelReportSlotT {
  round: number;
  a: string;
  b: string;
  /** The panel seats' games, seat 0 first. */
  panel: JudgePanelSeatGameT[];
  /** The panel's median a_points over its counted seats: the slot's scored game's. */
  median: number;
  result: JudgeGameResultT;
  /** The split over the counted seats. */
  split: JudgePanelSplitT;
  /** How many seats are void (a call of the seat's game came back with no verdict); absent when none is. */
  void?: number;
  /** The shadow's game; null while it is still to come. */
  shadow: { a_points: number; result: JudgeGameResultT } | null;
}

/** One finalist's playoff win rates (the header's gap). */
export interface JudgePanelReportFinalistT {
  artifact_sha256: string;
  /** The settled slots it played, and its twentieths of a win over them under the panel's medians. */
  slots: number;
  panel_points: number;
  panel_win_rate_micro: number | null;
  /** Those of its settled slots the shadow judged, and its twentieths of a win over them under the shadow. */
  shadow_slots: number;
  shadow_points: number;
  shadow_win_rate_micro: number | null;
  /** shadow_win_rate_micro - panel_win_rate_micro; null when either is. */
  gap_micro: number | null;
}

/** judgePanelReport's answer (the header). */
export interface JudgePanelReportT {
  slots: JudgePanelReportSlotT[];
  /** Slots whose panel games are not all in yet. */
  pending: number;
  unanimous: number;
  majority: number;
  draw: number;
  /** The share of settled slots that are not unanimous, millionths; null with none settled. */
  disagreement_micro: number | null;
  /** The record's finalists, in its order. */
  finalists: JudgePanelReportFinalistT[];
  /** The finalists with both win rates, by each (higher first, ties by sha256). */
  panel_order: string[];
  shadow_order: string[];
  /** Kendall's tau-b between panel_order and shadow_order, millionths; null when it is undefined. */
  tau_b_micro: number | null;
}

/** Millionths, rounded: x a share or a correlation. */
function micro(x: number): number {
  return Math.round(x * JUDGE_MICRO);
}

/**
 * A slot's split over its counted seats' results (the header's slot): every seat void a draw, else unanimous when they
 * agree, else a draw at the median's half, else a majority.
 */
function splitOf(results: readonly JudgeGameResultT[], median: number): JudgePanelSplitT {
  if (results.length === 0) return 'draw';
  if (results.every((r) => r === results[0])) return 'unanimous';
  return median === JUDGE_GAME_POINTS / 2 ? 'draw' : 'majority';
}

/**
 * A slot's split in words: its split, then its void seats when any is ('majority, 1 seat void'; 'draw, 3 seats void').
 */
export function judgePanelSplitWords(slot: Pick<JudgePanelReportSlotT, 'split' | 'void'>): string {
  const n = slot.void ?? 0;
  return n === 0 ? slot.split : `${slot.split}, ${n} seat${n === 1 ? '' : 's'} void`;
}

/** A win rate as whole twentieths over slots, comparable exactly: points / (20 x slots). */
export interface JudgePanelRateT {
  points: number;
  slots: number;
}

/** -1, 0 or 1: x's rate against y's, by cross-multiplication (whole numbers, exact). */
function compareRates(x: JudgePanelRateT, y: JudgePanelRateT): number {
  const l = x.points * y.slots;
  const r = y.points * x.slots;
  return l > r ? 1 : l < r ? -1 : 0;
}

/** Members by rate, higher first, ties by sha256. */
function orderOf(members: readonly string[], rates: ReadonlyMap<string, JudgePanelRateT>): string[] {
  return [...members].sort((x, y) => compareRates(rates.get(y)!, rates.get(x)!) || compareCodeUnits(x, y));
}

/**
 * Kendall's tau-b between two rankings of `members` by `first` and `second` (the header's orders): null under two
 * members or when either ties every pair.
 */
export function judgePanelTauB(members: readonly string[], first: ReadonlyMap<string, JudgePanelRateT>, second: ReadonlyMap<string, JudgePanelRateT>): number | null {
  const n = members.length;
  if (n < 2) return null;
  let concordant = 0;
  let discordant = 0;
  let tiedFirst = 0;
  let tiedSecond = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const x = compareRates(first.get(members[i]!)!, first.get(members[j]!)!);
      const y = compareRates(second.get(members[i]!)!, second.get(members[j]!)!);
      if (x === 0) tiedFirst++;
      if (y === 0) tiedSecond++;
      if (x !== 0 && y !== 0) {
        if (x === y) concordant++;
        else discordant++;
      }
    }
  }
  const pairs = (n * (n - 1)) / 2;
  const den = (pairs - tiedFirst) * (pairs - tiedSecond);
  if (den === 0) return null;
  return (concordant - discordant) / Math.sqrt(den);
}

/**
 * A panel final's playoff report (the header) from its record's games and finalists: a v5 or v6 record that holds, or
 * a running heat's games so far (its slots still to settle counted `pending`). Its shadow is judgeHeatShadowOf of the
 * record: a v6 record names its `panel` (the shadow follows its pool's members), a v5 one need not. A seat's game is
 * void where `voidAt` of its index in the games says so, else, when the record carries its `calls` (the games folded
 * from them two a pair), where judgeGamesVoidOf of them does; with neither, none is void. TypeError on a record of
 * another format; RangeError on a v6 record with no panel, as grader/judge-heat.ts judgePanelSlotsOf throws it, or on
 * calls that do not fold to the games' pairs.
 */
export function judgePanelReport(
  record: Pick<JudgeHeatRecordT, 'format' | 'games' | 'finalists' | 'panel'> & { calls?: readonly Pick<JudgeHeatCallT, 'a' | 'b' | 'verdict'>[] },
  voidAt?: (i: number) => boolean,
): JudgePanelReportT {
  if (!judgeHeatPanelFormat(record.format)) throw new TypeError(`a panel report reads a ${JUDGE_HEAT_FORMAT_V5} or ${JUDGE_HEAT_FORMAT_V6} record, and this one is ${record.format}`);
  const shadowAt = judgeHeatShadowOf(record);
  let isVoid = voidAt;
  if (isVoid === undefined && record.calls !== undefined) {
    const calls = record.calls;
    const fromCalls = judgeGamesVoidOf(calls);
    isVoid = (i) => {
      const g = record.games[i]!;
      const first = calls[2 * i];
      const second = calls[2 * i + 1];
      if (first === undefined || second === undefined || first.a !== g.a || first.b !== g.b || second.a !== g.a || second.b !== g.b) {
        throw new RangeError(`games.${i} (${g.a} against ${g.b}) is not the game of calls ${2 * i} and ${2 * i + 1}: the record's games fold its calls two a pair`);
      }
      return fromCalls(i);
    };
  }
  const slots: JudgePanelReportSlotT[] = [];
  let pending = 0;
  const counts: Record<JudgePanelSplitT, number> = { unanimous: 0, majority: 0, draw: 0 };
  const panel = new Map<string, JudgePanelRateT>(record.finalists.map((m) => [m, { points: 0, slots: 0 }]));
  const shadow = new Map<string, JudgePanelRateT>(record.finalists.map((m) => [m, { points: 0, slots: 0 }]));
  // `aPoints` from the slot's `a`'s side to each of its two members that is a finalist.
  const credit = (rates: Map<string, JudgePanelRateT>, a: string, b: string, aPoints: number): void => {
    for (const [m, points] of [
      [a, aPoints],
      [b, JUDGE_GAME_POINTS - aPoints],
    ] as const) {
      const r = rates.get(m);
      if (r === undefined) continue;
      r.points += points;
      r.slots += 1;
    }
  };
  for (const slot of judgePanelSlotsOf(record.games, isVoid, shadowAt)) {
    const scored = judgePanelSlotGame(slot);
    if (scored === null) {
      pending++;
      continue;
    }
    const seats = slot.panel.map((g, judge): JudgePanelSeatGameT => {
      const seat: JudgePanelSeatGameT = { judge, a_points: g!.a_points!, result: judgeGameResultOf(g!.a_points!) };
      if (slot.void[judge] === true) seat.void = true;
      return seat;
    });
    const voids = seats.filter((s) => s.void === true).length;
    const median = scored.a_points!;
    const split = splitOf(
      seats.filter((s) => s.void !== true).map((s) => s.result),
      median,
    );
    counts[split]++;
    const shadowGame = slot.shadow;
    if (shadowGame !== null && shadowGame.a_points === undefined) throw new RangeError(`the shadow's game of ${slot.a} against ${slot.b} has no a_points: a ${record.format} game carries them`);
    slots.push({
      round: slot.round,
      a: slot.a,
      b: slot.b,
      panel: seats,
      median,
      result: scored.result,
      split,
      ...(voids === 0 ? {} : { void: voids }),
      shadow: shadowGame === null ? null : { a_points: shadowGame.a_points!, result: judgeGameResultOf(shadowGame.a_points!) },
    });
    credit(panel, slot.a, slot.b, median);
    if (shadowGame !== null) credit(shadow, slot.a, slot.b, shadowGame.a_points!);
  }
  const rateMicro = (r: JudgePanelRateT): number | null => (r.slots === 0 ? null : micro(r.points / (JUDGE_GAME_POINTS * r.slots)));
  const finalists = record.finalists.map((m): JudgePanelReportFinalistT => {
    const p = panel.get(m)!;
    const s = shadow.get(m)!;
    const pr = rateMicro(p);
    const sr = rateMicro(s);
    return {
      artifact_sha256: m,
      slots: p.slots,
      panel_points: p.points,
      panel_win_rate_micro: pr,
      shadow_slots: s.slots,
      shadow_points: s.points,
      shadow_win_rate_micro: sr,
      gap_micro: pr === null || sr === null ? null : sr - pr,
    };
  });
  const both = record.finalists.filter((m) => panel.get(m)!.slots > 0 && shadow.get(m)!.slots > 0);
  const settled = slots.length;
  const tau = judgePanelTauB(both, panel, shadow);
  return {
    slots,
    pending,
    unanimous: counts.unanimous,
    majority: counts.majority,
    draw: counts.draw,
    disagreement_micro: settled === 0 ? null : micro((settled - counts.unanimous) / settled),
    finalists,
    panel_order: orderOf(both, panel),
    shadow_order: orderOf(both, shadow),
    tau_b_micro: tau === null ? null : micro(tau),
  };
}
