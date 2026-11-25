// A judge ladder's pure rate math: a dev entry rated against members of FIXED strength (the house anchors and rungs a
// calibration heat measured), not refitted with them. No clock and no I/O, and, as grader/judge-heat.ts judgeFit, only
// + - * / and Math.sqrt (each of which ES2025 §6.1.6.1, §21.3.2.33 rounds correctly in binary64), every sum in a fixed
// order (members in sha256 code-unit order, games folded into whole-twentieth counts first): the same bits on every host,
// for any order of the games.
//
//   the estimate     the subject's games: each gives it s_g = its twentieths / 20 of a win against a member of fixed
//                    strength p_g. With W = 0.5 + sum s_g (counted in whole twentieths and divided once, exact), p^ is
//                    the root of W = p/(p+1) + sum_g p/(p+p_g): one virtual draw against strength 1, the prior judgeFit
//                    gives every member, so p^ is finite for all wins and all losses alike. The right side rises in p,
//                    so a geometric bisection finds it: lo = 2^-64, hi = 2^64, mid = sqrt(lo*hi), JUDGE_LADDER_STEPS
//                    (100) halvings of the log-width (128 bits to far below one ulp), then sqrt(lo*hi)
//   the jackknife    for each opponent of the subject's games, in sha256 order, p^ again over every game but that
//                    opponent's (its whole twentieths taken out of W exactly): what a screen's leave-one-opponent-out
//                    se is read from (grader/judge-screen-inputs.ts judgeScreenSe)
//   the score       on today's provisional scale: E = (1/|A|) sum_{j in A} p^/(p^+p_j), A the judge anchors only (rungs
//                    play but never weigh in E); d = dE/dlog p^ = (1/|A|) sum_{j in A} p^ p_j/(p^+p_j)^2; the
//                    information I = p^/(p^+1)^2 + sum_g p^ p_g/(p^+p_g)^2 (the virtual draw included, as judgeFit's);
//                    SE = d sqrt(phi / I), phi the calibration's dispersion, computed as d sqrt(phi) / sqrt(I) so that at
//                    phi = 1 it is judgeFit's d / sqrt(I) bit for bit; the 90% interval E +- JUDGE_Z90 SE clamped to
//                    [0, 1]; each rounded to millionths as judge-heat's scoresOf rounds them
//   the next games   the ladder members ranked by the Fisher information a game against them carries at p^,
//                    p^ p_j/(p^+p_j)^2 (highest where the subject's chance is nearest even), exact ties by sha256; a
//                    round's games go to the first `spread`
//   strengths        stored as Fixed9 (contracts/primitives.ts): toFixed9(BigInt(Math.round(x * 1e9))) and back
//                    Number(parseFixed9(s)) / 1e9, both refusing x <= 0, a value that rounds to 0 and x * 1e9 >= 2^53
//   the dispersion   phi, a calibration's pooled within-pair dispersion: over every unordered pair with R >= 2 games and
//                    fitted p_ij = p_i/(p_i+p_j) in [0.1, 0.9], sum (s - mean)^2 over sum (R-1) p_ij (1-p_ij), s each
//                    game's twentieths / 20 to the pair's lower sha256. Under 2 such pairs phi = 1; else at least 0.1
//
//   the scrutiny     a dev heat's money-place scrutiny reads the score's interval mid-heat: over the games settled
//                    so far, interval_high_micro at or above the line (judgeLadderReachesLine) earns more rounds
//
// The judge-heat constants are read only inside functions, so judge-heat.ts may import this module back without an
// evaluation-order hazard.

import { FIXED9_SCALE, parseFixed9, Sha256Hex, toFixed9 } from '../contracts/primitives.ts';
import { JUDGE_MICRO } from '../contracts/score.ts';
import { compareCodeUnits } from '../sim/canonical.ts';
import { JUDGE_GAME_POINTS, JUDGE_Z90, type JudgeFitT, type JudgeHeatGameT } from './judge-heat.ts';

/** The estimate's geometric bisection: its halvings, and its bracket [2^-64, 2^64]. */
export const JUDGE_LADDER_STEPS = 100;
export const JUDGE_LADDER_LO = 1 / 18_446_744_073_709_551_616; // 2^-64, exact
export const JUDGE_LADDER_HI = 18_446_744_073_709_551_616; // 2^64, exact
/** A dispersion pair counts only with its fitted p_ij in [this, 1 - this]. */
export const JUDGE_LADDER_PAIR_P_MIN = 0.1;
/** The fewest informative pairs a dispersion is measured over; under them phi = 1. */
export const JUDGE_LADDER_MIN_PAIRS = 2;
/** The least a measured dispersion counts as. */
export const JUDGE_LADDER_PHI_MIN = 0.1;

/** A game as the ladder reads it: its pair and `a`'s twentieths (a v2/v3 game's a_points). */
export type JudgeLadderGameT = Pick<JudgeHeatGameT, 'a' | 'b' | 'a_points'>;

const SCALE = Number(FIXED9_SCALE);
const MAX_SCALED = 2 ** 53;

function checkSha(m: string, what: string): void {
  if (!Sha256Hex.safeParse(m).success) throw new TypeError(`${what} ${JSON.stringify(m)} is not an artifact's lowercase hex sha256`);
}

function checkPositive(x: number, what: string): void {
  if (typeof x !== 'number' || !Number.isFinite(x) || !(x > 0)) throw new RangeError(`${what} ${String(x)} is not a finite number above 0`);
}

function pointsOf(g: JudgeLadderGameT): number {
  const p = g.a_points;
  if (p === undefined || !Number.isSafeInteger(p) || p < 0 || p > JUDGE_GAME_POINTS) {
    throw new RangeError(`a game's a_points ${String(p)} is not a whole number from 0 to ${JUDGE_GAME_POINTS}`);
  }
  return p;
}

// ---------------------------------------------------------------- Fixed9

/**
 * A positive value as Fixed9 (a strength, a dispersion): toFixed9(BigInt(Math.round(x * 1e9))). RangeError when x is not
 * finite, x <= 0, x rounds to 0 at nine places (it would not read back above 0), or x * 1e9 >= 2^53 (it would not read
 * back exactly).
 */
export function judgeLadderToFixed9(x: number): string {
  checkPositive(x, 'the value');
  const scaled = Math.round(x * SCALE);
  if (scaled >= MAX_SCALED) throw new RangeError(`the value ${String(x)} is 2^53 billionths or more`);
  if (scaled === 0) throw new RangeError(`the value ${String(x)} rounds to 0 at nine places`);
  return toFixed9(BigInt(scaled));
}

/** A Fixed9 positive value back as a number: Number(parseFixed9(s)) / 1e9. RangeError on a value out of judgeLadderToFixed9's range. */
export function judgeLadderFromFixed9(s: string): number {
  const scaled = parseFixed9(s);
  if (scaled <= 0n) throw new RangeError(`the value ${s} is not above 0`);
  if (scaled >= BigInt(MAX_SCALED)) throw new RangeError(`the value ${s} is 2^53 billionths or more`);
  return Number(scaled) / SCALE;
}

/** The fixed strengths a record lists ({artifact_sha256, strength: Fixed9}), keyed by member. TypeError on a member listed twice. */
export function judgeLadderStrengths(list: readonly { artifact_sha256: string; strength: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const { artifact_sha256: m, strength } of list) {
    checkSha(m, 'the member');
    if (out.has(m)) throw new TypeError(`the strengths list ${m} twice`);
    out.set(m, judgeLadderFromFixed9(strength));
  }
  return out;
}

// ---------------------------------------------------------------- the estimate

/**
 * The subject's games folded: its whole twentieths (the virtual draw's 10 included), and its opponents in sha256 order
 * with their strength, games and the subject's whole twentieths against them.
 */
interface FoldT {
  units: number;
  opponents: Array<{ m: string; p: number; c: number; u: number }>;
}

function foldOf(subject: string, games: readonly JudgeLadderGameT[], strengths: ReadonlyMap<string, number>): FoldT {
  checkSha(subject, 'the subject');
  let units = JUDGE_GAME_POINTS / 2;
  const counts = new Map<string, { c: number; u: number }>();
  for (const g of games) {
    const points = pointsOf(g);
    let opponent: string;
    let won: number;
    if (g.a === subject && g.b !== subject) {
      opponent = g.b;
      won = points;
    } else if (g.b === subject && g.a !== subject) {
      opponent = g.a;
      won = JUDGE_GAME_POINTS - points;
    } else if (g.a === subject) throw new RangeError(`a game of ${subject} against itself`);
    else throw new RangeError(`a game between ${g.a} and ${g.b} is not the subject's`);
    if (!strengths.has(opponent)) throw new RangeError(`the subject's opponent ${opponent} has no fixed strength`);
    units += won;
    const was = counts.get(opponent) ?? { c: 0, u: 0 };
    counts.set(opponent, { c: was.c + 1, u: was.u + won });
  }
  const opponents = [...counts.keys()].sort(compareCodeUnits).map((m) => {
    const p = strengths.get(m)!;
    checkPositive(p, `${m}'s strength`);
    const { c, u } = counts.get(m)!;
    return { m, p, c, u };
  });
  return { units, opponents };
}

function estimateOf(fold: FoldT): number {
  const w = fold.units / JUDGE_GAME_POINTS;
  let lo = JUDGE_LADDER_LO;
  let hi = JUDGE_LADDER_HI;
  for (let step = 0; step < JUDGE_LADDER_STEPS; step++) {
    const mid = Math.sqrt(lo * hi);
    let f = mid / (mid + 1);
    for (const { p, c } of fold.opponents) f += (c * mid) / (mid + p);
    if (f < w) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/**
 * The subject's strength p^ against fixed strengths (the header's estimate). Every game is the subject's, against a
 * member `strengths` holds (each finite and above 0), its a_points a whole number from 0 to JUDGE_GAME_POINTS (`a`'s,
 * whichever side the subject plays). Finite for any games, none included (then about 1).
 */
export function judgeLadderEstimate(subject: string, games: readonly JudgeLadderGameT[], strengths: ReadonlyMap<string, number>): number {
  return estimateOf(foldOf(subject, games, strengths));
}

/** One opponent's leave-one-out estimate (judgeLadderLeaveOneOut): the opponent, its games with the subject, and p^ without them. */
export interface JudgeLadderLeftOutT {
  opponent: string;
  games: number;
  p: number;
}

/**
 * The subject's leave-one-opponent-out estimates (the header's jackknife): for each opponent of its games, in sha256
 * order, p^ over every game but those against it (the virtual draw kept). Each p is judgeLadderEstimate's over those
 * games bit for bit: the same fold with that opponent's whole twentieths and games taken out, exactly. The same games
 * and strengths judgeLadderEstimate takes; [] when the subject played none.
 */
export function judgeLadderLeaveOneOut(subject: string, games: readonly JudgeLadderGameT[], strengths: ReadonlyMap<string, number>): JudgeLadderLeftOutT[] {
  const fold = foldOf(subject, games, strengths);
  return fold.opponents.map((left) => ({
    opponent: left.m,
    games: left.c,
    p: estimateOf({ units: fold.units - left.u, opponents: fold.opponents.filter((o) => o.m !== left.m) }),
  }));
}

// ---------------------------------------------------------------- the score

/** The subject's rate (the header's score): p^, E, SE and its interval, and each in millionths as a ProgramJudgeScore holds it. */
export interface JudgeLadderScoreT {
  p: number;
  e: number;
  se: number;
  win_rate_micro: number;
  se_micro: number;
  interval_low_micro: number;
  interval_high_micro: number;
}

function micro(x: number): number {
  return Math.round(x * JUDGE_MICRO);
}

/** What a subject's rate is read from (judgeLadderScore): its games, the fixed strengths, the judge anchors and phi. */
export interface JudgeLadderRateInputT {
  subject: string;
  games: readonly JudgeLadderGameT[];
  strengths: ReadonlyMap<string, number>;
  anchors: readonly string[];
  phi: number;
}

/**
 * The subject's rate against fixed strengths (the header's score): p^ by judgeLadderEstimate, E and d over `anchors`
 * alone (the judge anchors, each with a strength; at least one; never the rungs), I over the subject's games, SE scaled
 * by the dispersion `phi` (finite, above 0; 1 leaves judgeFit's SE).
 */
export function judgeLadderScore(input: JudgeLadderRateInputT): JudgeLadderScoreT {
  const { subject, games, strengths, phi } = input;
  checkPositive(phi, 'the dispersion');
  const anchors = [...input.anchors].sort(compareCodeUnits);
  if (anchors.length === 0) throw new RangeError('a ladder score takes at least one anchor');
  if (new Set(anchors).size !== anchors.length) throw new TypeError('the anchors list a member twice');
  for (const m of anchors) {
    checkSha(m, 'the anchor');
    if (m === subject) throw new RangeError(`the subject ${m} is one of the anchors`);
    if (!strengths.has(m)) throw new RangeError(`the anchor ${m} has no fixed strength`);
    checkPositive(strengths.get(m)!, `${m}'s strength`);
  }
  const fold = foldOf(subject, games, strengths);
  const p = estimateOf(fold);
  let e = 0;
  let slope = 0;
  for (const m of anchors) {
    const pj = strengths.get(m)!;
    const s = p + pj;
    e += p / s;
    slope += (p * pj) / (s * s);
  }
  let info = p / ((p + 1) * (p + 1));
  for (const { p: pj, c } of fold.opponents) {
    const s = p + pj;
    info += (c * p * pj) / (s * s);
  }
  const n = anchors.length;
  e = e / n;
  const se = (slope / n) * Math.sqrt(phi) / Math.sqrt(info);
  const half = JUDGE_Z90 * se;
  return {
    p,
    e,
    se,
    win_rate_micro: micro(e),
    se_micro: Math.min(JUDGE_MICRO, micro(se)),
    interval_low_micro: micro(Math.max(0, e - half)),
    interval_high_micro: micro(Math.min(1, e + half)),
  };
}

/**
 * Whether a dev heat's money-place scrutiny takes the subject on (the header's scrutiny): its interval read mid-heat,
 * judgeLadderScore over `input.games` (the games settled so far), its interval_high_micro at or above `lineMicro`, a
 * whole number of millionths from 0 to JUDGE_MICRO on the same scale (E against the judge anchors, as the dev board
 * shows it). A finished heat with no scrutiny games is read the same off its stored score's interval_high_micro.
 */
export function judgeLadderReachesLine(input: JudgeLadderRateInputT, lineMicro: number): boolean {
  if (!Number.isSafeInteger(lineMicro) || lineMicro < 0 || lineMicro > JUDGE_MICRO) throw new RangeError(`the line ${String(lineMicro)} is not a whole number of millionths from 0 to ${JUDGE_MICRO}`);
  return judgeLadderScore(input).interval_high_micro >= lineMicro;
}

// ---------------------------------------------------------------- the next games

/**
 * The ladder members a round's games go to (the header's next games): `members` (each with a finite strength above 0)
 * ranked by p^ p_j/(p^+p_j)^2 at the estimate `estimate`, highest first, exact ties by sha256 code-unit order; the
 * first `spread` (all of them when fewer). `spread` a whole number at least 1.
 */
export function judgeLadderNext(estimate: number, members: ReadonlyMap<string, number>, spread: number): string[] {
  checkPositive(estimate, 'the estimate');
  if (!Number.isSafeInteger(spread) || spread < 1) throw new RangeError(`spread ${String(spread)} is not a whole number at least 1`);
  const ranked = [...members].map(([m, pj]) => {
    checkSha(m, 'the member');
    checkPositive(pj, `${m}'s strength`);
    const s = estimate + pj;
    return { m, info: (estimate * pj) / (s * s) };
  });
  ranked.sort((x, y) => (x.info > y.info ? -1 : x.info < y.info ? 1 : compareCodeUnits(x.m, y.m)));
  return ranked.slice(0, spread).map((r) => r.m);
}

// ---------------------------------------------------------------- the dispersion

/**
 * A calibration's pooled within-pair dispersion phi (the header's dispersion), as Fixed9. `games` every calibration
 * game (each with a_points, between two members `fit` holds); `fit` each member's strength, a number or judgeFit's
 * {p}. Pairs are taken in sha256 order of their lower then upper member; each pair's sum of squares is an exact integer
 * (R sum u^2 - U^2, u its twentieths) divided once.
 */
export function judgeLadderDispersion(games: readonly JudgeLadderGameT[], fit: ReadonlyMap<string, number | Pick<JudgeFitT, 'p'>>): string {
  const strengthOf = (m: string): number => {
    const v = fit.get(m);
    if (v === undefined) throw new RangeError(`a game names ${m}, which the fit does not hold`);
    const p = typeof v === 'number' ? v : v.p;
    checkPositive(p, `${m}'s strength`);
    return p;
  };
  const pairs = new Map<string, { lo: string; hi: string; r: number; u: number; uu: number }>();
  for (const g of games) {
    checkSha(g.a, 'the member');
    checkSha(g.b, 'the member');
    if (g.a === g.b) throw new RangeError(`a game of ${g.a} against itself`);
    const points = pointsOf(g);
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
  let num = 0;
  let den = 0;
  let informative = 0;
  for (const key of [...pairs.keys()].sort(compareCodeUnits)) {
    const { lo, hi, r, u, uu } = pairs.get(key)!;
    const pi = strengthOf(lo);
    const pj = strengthOf(hi);
    if (r < 2) continue;
    const pij = pi / (pi + pj);
    if (pij < JUDGE_LADDER_PAIR_P_MIN || pij > 1 - JUDGE_LADDER_PAIR_P_MIN) continue;
    const squares = r * uu - u * u; // R^2 sum (u - mean)^2, a whole number
    num += squares / (r * JUDGE_GAME_POINTS * JUDGE_GAME_POINTS);
    den += (r - 1) * pij * (1 - pij);
    informative += 1;
  }
  const phi = informative < JUDGE_LADDER_MIN_PAIRS ? 1 : Math.max(num / den, JUDGE_LADDER_PHI_MIN);
  return judgeLadderToFixed9(phi);
}
