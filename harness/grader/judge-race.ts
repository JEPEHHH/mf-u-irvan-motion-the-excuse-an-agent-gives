// A screened final's race math (judge heat v4's F1 screen and F3 racing): pure functions of plain numbers, Fixed9
// strings and member sha256s, never a bundle's judge block, so nothing here reads a contract the heat has not fixed.
// No clock and no I/O, and, as grader/judge-heat.ts judgeFit and grader/judge-ladder.ts, only + - * / and Math.sqrt
// (each correctly rounded in binary64, ES2025 §6.1.6.1, §21.3.2.33), every sum in a fixed order (members in sha256
// code-unit order, games folded into whole-twentieth counts first): the same bits on every host, for any order of the
// games. No Math.log or Math.exp (their results are implementation-approximated): log-strengths come from judgeRaceLog.
//
//   the log          judgeRaceLog(x): x = m 2^k by exact power-of-two scaling, m in (sqrt(1/2), sqrt(2)]; then
//                    log m = 2 atanh(t), t = (m-1)/(m+1), |t| <= 0.1716, by JUDGE_RACE_LOG_TERMS (12) terms of
//                    2 sum t^(2j+1)/(2j+1) in Horner form from the last; plus k ln 2 with ln 2 split Cody-Waite style
//                    (k LN2_HI exact). Within a few ulps of the true value, and the same bits everywhere
//   the strengths    judgeRaceStrengths: Bradley-Terry p over the games, judgeFit's fold, virtual draw and
//                    JUDGE_BT_ITERATIONS minorize-maximize steps operation for operation (p is judgeFit's p bit for
//                    bit), held in flat arrays (a member's opponents in member order), and the Fisher information
//                    I = p/(p+1)^2 + sum_j c_j p p_j/(p+p_j)^2, judgeFit's own. No expected win rate against the whole
//                    field (judgeFit's O(n^2) loop): O(iterations x (members + pairs))
//   the intervals    judgeRaceIntervals: se = sqrt(margin x phi^ / I) on the log scale, half = z se, lo/hi = log p -+ half
//   the screen       judgeScreen: the line is the M-th best lo among the contender-rated entrants (rated.contender, a
//                    rating from the sealed dev contender rounds: grader/judge-heat.ts judgeHeatScreenOf hands in a
//                    member's contender sub-rating here in place of its house-only one, for the screen alone; no
//                    score is read from this module's screen) when at least M are; otherwise the M-th best lo among
//                    all rated entrants (none while fewer than M are rated: then every entrant is kept). The contender
//                    line can sit above the house-only one (its lows are the contender games' own, drawn among the
//                    members the chain reached), so this screen alone may cut an entrant the house-only screen keeps:
//                    judgeHeatScreenOf's house-only floor keeps every member the house-only screen keeps, so contender
//                    ratings only ever add members. The shortlist S is every rated entrant whose hi reaches the line
//                    (hi >= line, so an exact tie at the line is kept), contender or not, every unrated entrant and
//                    every anchor. The
//                    round-0 order ranks all of S on one log-strength scale, higher first: a rated entrant at its dev
//                    log p, an unrated one at the line (the bottom when there is none), an anchor at its calibration
//                    strength's log; exact ties by sha256
//   the tiers        judgeRaceTiers: one boundary b per place whose amount exceeds the next place's (the last place's
//                    next is 0), its drop D_b; cap_b = min(capMax, cap x ceil(D_b / D_min)), whole cents
//   who races        judgeRaceActive: entrants ranked by p (higher first, ties by sha256). Entrant i straddles b when
//                    hi_i >= the b-th best lo and lo_i <= the (b+1)-th best hi (none past the entrants). i is active
//                    while it straddles some b with games_i < cap_b and its half-width exceeds epsilon; its room is the
//                    most cap_b - games_i over those b. Two entrants with >= 2 games against each other, their mean
//                    within one point (of 20) of even, and |log p_i - log p_j| <= epsilon are a tie: never paired again
//   the pairs        judgeRacePairs: each active entrant i in rank order, unless the epoch already gave it a game, takes
//                    the candidate j (S and the anchors) maximizing the information a game adds, discounted for the
//                    games the pair already played: p_i p_j/(p_i+p_j)^2 x I_j/(I_i+I_j) / (1 + games_ij); exact ties
//                    by fewer games_ij, then the lowest sha256. Never itself, a tie, a pair the epoch already holds, an
//                    active entrant out of room this epoch, or a non-racing candidate at the epoch's load cap
//                    L = ceil(E / |candidates|) + 1, E = min(budget, max(ceil(epoch_calls / 2), active entrants)) the
//                    most games the epoch can hold (a non-racing opponent's load spread over the racers); only in
//                    this first pass, an entrant the cap alone would leave without a game takes one past it. A second
//                    pass, the active entrants again in rank order and as often as needed, pads the epoch to
//                    ceil(epoch_calls / 2) games while any can still take one under the cap; every game spends its
//                    active members' rooms (padding counts toward the caps) and the race's game budget. Each pair's
//                    first slot order is the caller's draw (judgeSlotOrder(seed, 'race', epoch, a, b) on a v4 heat),
//                    `a` the entrant that chose. The caller's optional `caps` bound a candidate's games this epoch
//                    (a contender round's games left): never passed, in either pass, the first pass's game past the
//                    load cap included; a candidate at its cap neither chooses nor is chosen. With no caps the pairs
//                    are those of a call before them, game for game
//   the bound        judgeScreenedCallBound: F2's Swiss over min(n, field) members, the race's whole game budget
//                    (judgeRaceBudget: max(M x race_cap_max, ceil(|S| / 2)) games, |S| those members, so the budget
//                    grows with a shortlist past the line), the playoff round-robin and the top_repeats games,
//                    two calls a game: an upper bound on a v4 heat's calls before any result, kept true by the race
//                    spending at most its budget; a v5 panel final's (`playoffJudges` 4) plans each playoff and top
//                    game once a panel seat and once for the shadow, so those two terms count four times over
//
// The judge-heat constants are read only inside functions, so judge-heat.ts may import this module back without an
// evaluation-order hazard.

import { parseFixed9 } from '../contracts/primitives.ts';
import { compareCodeUnits } from '../sim/canonical.ts';
import { JUDGE_BT_ITERATIONS, JUDGE_GAME_POINTS, type JudgeHeatGameT, type JudgeSlotOrderT } from './judge-heat.ts';

/** The atanh series' terms in judgeRaceLog: 11 reach below half an ulp of log m on (sqrt(1/2), sqrt(2)]; one more for margin. */
export const JUDGE_RACE_LOG_TERMS = 12;
/** ln 2's high part (fdlibm's ln2_hi, its low 32 bits zero, so k x LN2_HI is exact for every binary64 exponent k) and the rest. */
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const TWO64 = 18_446_744_073_709_551_616; // 2^64, exact
const SHA256 = /^[0-9a-f]{64}$/;
const FIXED9 = 1e9;

/** A game as the race reads it: its pair, its result and (v2 and later) `a`'s twentieths. */
export type JudgeRaceGameT = Pick<JudgeHeatGameT, 'a' | 'b' | 'result' | 'a_points'>;

function checkSha(m: string, what: string): void {
  if (typeof m !== 'string' || !SHA256.test(m)) throw new TypeError(`${what} ${JSON.stringify(m)} is not an artifact's lowercase hex sha256`);
}

function checkMembers(members: readonly string[], what = 'the field'): void {
  for (const m of members) checkSha(m, 'the member');
  if (new Set(members).size !== members.length) throw new TypeError(`${what} lists a member twice`);
}

function checkWhole(v: number, what: string, min: number): void {
  if (!Number.isSafeInteger(v) || v < min) throw new RangeError(`${what} ${String(v)} is not a whole number from ${min}`);
}

function checkPositive(x: number, what: string): void {
  if (typeof x !== 'number' || !Number.isFinite(x) || !(x > 0)) throw new RangeError(`${what} ${String(x)} is not a finite number above 0`);
}

/**
 * A knob as a number: a number as it is, a Fixed9 string as Number(parseFixed9(s)) / 1e9 (judgeLadderFromFixed9's
 * read, exact to the double nearest the decimal). RangeError when it is not finite or below `min` (or at it, `above`).
 */
export function judgeRaceNumber(x: number | string, what: string, min = 0, above = false): number {
  const v = typeof x === 'string' ? Number(parseFixed9(x)) / FIXED9 : x;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || (above && v === min)) {
    throw new RangeError(`${what} ${String(x)} is not a finite number ${above ? 'above' : 'from'} ${min}`);
  }
  return v;
}

/** A game's twentieths to `a`: its a_points, or a v1 game's whole win, loss or half. */
function pointsOf(g: JudgeRaceGameT): number {
  if (g.a_points !== undefined) {
    if (!Number.isSafeInteger(g.a_points) || g.a_points < 0 || g.a_points > JUDGE_GAME_POINTS) throw new RangeError(`a game's a_points ${String(g.a_points)} is not a whole number from 0 to ${JUDGE_GAME_POINTS}`);
    return g.a_points;
  }
  return g.result === 'a' ? JUDGE_GAME_POINTS : g.result === 'b' ? 0 : JUDGE_GAME_POINTS / 2;
}

/** The key of an unordered pair of members (judge-heat.ts judgePairKey's): the lower sha256, a colon, the higher. */
export function judgeRacePairKey(a: string, b: string): string {
  return compareCodeUnits(a, b) < 0 ? `${a}:${b}` : `${b}:${a}`;
}

// ---------------------------------------------------------------- the log

/**
 * The natural log of a finite x above 0 (the header's log), from + - * / alone: the same bits on every host. Within a
 * few ulps of the true log (the tests hold it to reference values); judgeRaceLog(1) is 0 exactly.
 */
export function judgeRaceLog(x: number): number {
  checkPositive(x, 'the log of');
  let m = x;
  let k = 0;
  // Exact: each step scales by a power of two and stays within the normal range (a subnormal only ever scales up).
  while (m >= TWO64) {
    m /= TWO64;
    k += 64;
  }
  while (m < 1 / TWO64) {
    m *= TWO64;
    k -= 64;
  }
  while (m >= 2) {
    m /= 2;
    k += 1;
  }
  while (m < 1) {
    m *= 2;
    k -= 1;
  }
  if (m > Math.SQRT2) {
    m /= 2;
    k += 1;
  }
  const t = (m - 1) / (m + 1);
  const t2 = t * t;
  let s = 1 / (2 * JUDGE_RACE_LOG_TERMS - 1);
  for (let j = JUDGE_RACE_LOG_TERMS - 2; j >= 0; j--) s = 1 / (2 * j + 1) + t2 * s;
  return k * LN2_HI + (k * LN2_LO + 2 * t * s);
}

// ---------------------------------------------------------------- the strengths

/** A member's Bradley-Terry strength p (judgeFit's), its Fisher information I and its games in the fit. */
export interface JudgeRaceStrengthT {
  p: number;
  info: number;
  games: number;
}

/**
 * Bradley-Terry over `games` (the header's strengths): every member's p, I and games, keyed by member in sha256 order.
 * p is judgeFit's p bit for bit: the same fold (twentieths, the virtual draw's half a win each), the same opponent
 * order and the same JUDGE_BT_ITERATIONS steps; I is judgeFit's information. At least two members; every game between
 * two of them, its a_points (when present) a whole number from 0 to JUDGE_GAME_POINTS. The same bits for any order of
 * `members` or `games`.
 */
export function judgeRaceStrengths(members: readonly string[], games: readonly JudgeRaceGameT[]): Map<string, JudgeRaceStrengthT> {
  checkMembers(members);
  if (members.length < 2) throw new RangeError('a fit takes at least two members');
  const sorted = [...members].sort(compareCodeUnits);
  const n = sorted.length;
  const at = new Map(sorted.map((m, i) => [m, i]));
  const points = JUDGE_GAME_POINTS;
  const half = points / 2;
  // Whole twentieths, so the fold is exact in any order.
  const units = new Float64Array(n).fill(half);
  const keys = new Float64Array(games.length);
  for (let g = 0; g < games.length; g++) {
    const game = games[g]!;
    const i = at.get(game.a);
    const j = at.get(game.b);
    if (i === undefined || j === undefined) throw new RangeError(`a game between ${game.a} and ${game.b} names a member outside the field`);
    if (i === j) throw new RangeError(`a game of ${game.a} against itself`);
    const u = pointsOf(game);
    units[i] += u;
    units[j] += points - u;
    keys[g] = i < j ? i * n + j : j * n + i;
  }
  keys.sort();
  // The pairs in key order, each member's opponents filled in that order: those below it (keys k*n + i, k < i) first,
  // then those above it (i*n + j), so each list is in member order, as judgeFit sorts its own.
  const degree = new Int32Array(n + 1);
  const pairLo: number[] = [];
  const pairHi: number[] = [];
  const pairCount: number[] = [];
  for (let g = 0; g < keys.length; ) {
    const key = keys[g]!;
    let c = 0;
    while (g < keys.length && keys[g] === key) {
      c++;
      g++;
    }
    const i = Math.floor(key / n);
    const j = key - i * n;
    pairLo.push(i);
    pairHi.push(j);
    pairCount.push(c);
    degree[i + 1] += 1;
    degree[j + 1] += 1;
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
    nbr[cursor[i]!] = j;
    cnt[cursor[i]!] = c;
    cursor[i] += 1;
    nbr[cursor[j]!] = i;
    cnt[cursor[j]!] = c;
    cursor[j] += 1;
    played[i] += c;
    played[j] += c;
  }
  const wins = new Float64Array(n);
  for (let i = 0; i < n; i++) wins[i] = units[i]! / points;
  let p = new Float64Array(n).fill(1);
  let next = new Float64Array(n);
  for (let iter = 0; iter < JUDGE_BT_ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) {
      const pi = p[i]!;
      let denom = 1 / (pi + 1);
      for (let e = off[i]!, end = off[i + 1]!; e < end; e++) denom += cnt[e]! / (pi + p[nbr[e]!]!);
      next[i] = wins[i]! / denom;
    }
    const was = p;
    p = next;
    next = was;
  }
  const out = new Map<string, JudgeRaceStrengthT>();
  for (let i = 0; i < n; i++) {
    const pi = p[i]!;
    let info = pi / ((pi + 1) * (pi + 1));
    for (let e = off[i]!, end = off[i + 1]!; e < end; e++) {
      const pj = p[nbr[e]!]!;
      const s = pi + pj;
      info += (cnt[e]! * pi * pj) / (s * s);
    }
    out.set(sorted[i]!, { p: pi, info, games: played[i]! });
  }
  return out;
}

// ---------------------------------------------------------------- the intervals

/** A member's strength with its log-scale interval: log p, se, the half-width z se and lo/hi = log p -+ half. */
export interface JudgeRaceIntervalT extends JudgeRaceStrengthT {
  log: number;
  se: number;
  half: number;
  lo: number;
  hi: number;
}

/**
 * Each member's log-strength interval (the header's intervals): se = sqrt(margin x phiHat / I), half = z se,
 * lo/hi = judgeRaceLog(p) -+ half, in `strengths`' order. phiHat finite above 0 (judgeHeatDispersion's); z above 0 and
 * margin at least 1, each a number or a Fixed9 string.
 */
export function judgeRaceIntervals(strengths: ReadonlyMap<string, JudgeRaceStrengthT>, phiHat: number, z: number | string, margin: number | string): Map<string, JudgeRaceIntervalT> {
  checkPositive(phiHat, 'the dispersion');
  const zz = judgeRaceNumber(z, 'z', 0, true);
  const scale = judgeRaceNumber(margin, 'the phi margin', 1) * phiHat;
  const out = new Map<string, JudgeRaceIntervalT>();
  for (const [m, s] of strengths) {
    checkPositive(s.p, `${m}'s strength`);
    checkPositive(s.info, `${m}'s information`);
    const log = judgeRaceLog(s.p);
    const se = Math.sqrt(scale / s.info);
    const half = zz * se;
    out.set(m, { ...s, log, se, half, lo: log - half, hi: log + half });
  }
  return out;
}

// ---------------------------------------------------------------- the screen

/**
 * A final entrant's screen input: the rating the screen places it by (a Fixed9 strength above 0 and a Fixed9 log-scale
 * se; `contender` when it is its contender-round sub-rating, the header's screen, else its house-only dev rating), or why
 * it has none. The line, the cut and the round-0 order are all judgeScreen makes of it: it is never a score.
 */
export interface JudgeScreenMemberT {
  artifact_sha256: string;
  rated?: { strength: string; se: string; contender?: true };
  unrated?: string;
}

/** A house anchor's calibration strength, Fixed9 above 0. */
export interface JudgeScreenAnchorT {
  artifact_sha256: string;
  strength: string;
}

/** The screen (the header's screen): the line, the shortlist S, the round-0 order of S and the entrants screened out. */
export interface JudgeScreenT {
  /**
   * On the log scale: the M-th best lo among contender-rated entrants when at least M are, else the M-th best lo among
   * rated entrants; null while fewer than M are rated.
   */
  line: number | null;
  /** S: kept entrants and every anchor, in sha256 order. */
  shortlist: string[];
  /** S ranked for round 0, first first. */
  order: string[];
  /** Rated entrants whose hi falls short of the line, in sha256 order. */
  screened_out: string[];
}

/**
 * The F1 screen (the header's screen) over the final's entrants `members` (each exactly once, rated or unrated) and
 * the house `anchors` (each once; a member may be both, and then ranks at its anchor strength), with M = linePlaces
 * (a whole number from 1) and z (above 0; a number or a Fixed9 string).
 */
export function judgeScreen(inputs: { members: readonly JudgeScreenMemberT[]; anchors: readonly JudgeScreenAnchorT[] }, linePlaces: number, z: number | string): JudgeScreenT {
  checkWhole(linePlaces, 'the line places', 1);
  const zz = judgeRaceNumber(z, 'z', 0, true);
  checkMembers(
    inputs.members.map((m) => m.artifact_sha256),
    'the screen',
  );
  checkMembers(
    inputs.anchors.map((a) => a.artifact_sha256),
    "the screen's anchors",
  );
  const rated: Array<{ m: string; log: number; hi: number; lo: number; contender: boolean }> = [];
  const unrated: string[] = [];
  for (const member of inputs.members) {
    const m = member.artifact_sha256;
    if ((member.rated === undefined) === (member.unrated === undefined)) throw new TypeError(`the screen's member ${m} is either rated or unrated`);
    if (member.rated === undefined) {
      unrated.push(m);
      continue;
    }
    const flag: unknown = member.rated.contender;
    if (flag !== undefined && flag !== true) throw new TypeError(`the screen's member ${m}'s contender flag is true or absent`);
    const log = judgeRaceLog(judgeRaceNumber(member.rated.strength, `${m}'s strength`, 0, true));
    const half = zz * judgeRaceNumber(member.rated.se, `${m}'s se`, 0);
    rated.push({ m, log, lo: log - half, hi: log + half, contender: flag === true });
  }
  // The contender line when at least M are contender-rated, else the line over every rated entrant (the header's screen).
  const contenders = rated.filter((r) => r.contender);
  const from = contenders.length >= linePlaces ? contenders : rated;
  const los = from.map((r) => r.lo).sort((x, y) => y - x);
  const line = los.length >= linePlaces ? los[linePlaces - 1]! : null;
  const anchorKey = new Map(inputs.anchors.map((a) => [a.artifact_sha256, judgeRaceLog(judgeRaceNumber(a.strength, `${a.artifact_sha256}'s strength`, 0, true))]));
  const key = new Map<string, number>(anchorKey);
  const screenedOut: string[] = [];
  for (const r of rated) {
    if (line !== null && r.hi < line && !anchorKey.has(r.m)) screenedOut.push(r.m);
    else if (!key.has(r.m)) key.set(r.m, r.log);
  }
  for (const m of unrated) if (!key.has(m)) key.set(m, line ?? -Infinity);
  const shortlist = [...key.keys()].sort(compareCodeUnits);
  const order = [...shortlist].sort((x, y) => {
    const kx = key.get(x)!;
    const ky = key.get(y)!;
    return kx > ky ? -1 : kx < ky ? 1 : compareCodeUnits(x, y);
  });
  return { line, shortlist, order, screened_out: screenedOut.sort(compareCodeUnits) };
}

// ---------------------------------------------------------------- the tiers

/** A prize boundary the race separates: the place above it and the most games an entrant races it for. */
export interface JudgeRaceTierT {
  place: number;
  cap: number;
}

/**
 * The race's boundaries (the header's tiers) from the placement prizes [{place, amount}] (amounts in USD, at most two
 * decimals, places exactly 1 to K in any order): one per place b whose amount exceeds place b+1's (place K+1's is 0),
 * cap_b = min(capMax, cap x ceil(D_b / D_min)), in place order. cap and capMax whole numbers, 1 <= cap <= capMax. No
 * prizes, or none above 0, give none.
 */
export function judgeRaceTiers(prizes: readonly { place: number; amount: number }[], cap: number, capMax: number): JudgeRaceTierT[] {
  checkWhole(cap, 'the race cap', 1);
  checkWhole(capMax, 'the race cap max', 1);
  if (cap > capMax) throw new RangeError(`the race cap ${cap} is above its max ${capMax}`);
  const cents = new Array<number>(prizes.length + 2).fill(0);
  const seen = new Set<number>();
  for (const { place, amount } of prizes) {
    checkWhole(place, 'a prize place', 1);
    if (place > prizes.length || seen.has(place)) throw new RangeError(`the prizes' places are not exactly 1 to ${prizes.length} (place ${place})`);
    seen.add(place);
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new RangeError(`place ${place}'s amount ${String(amount)} is not a finite amount from 0`);
    const c = Math.round(amount * 100);
    if (Math.abs(amount * 100 - c) >= 1e-6) throw new RangeError(`place ${place}'s amount ${String(amount)} has more than two decimals`);
    cents[place] = c;
  }
  const drops: Array<{ place: number; drop: number }> = [];
  for (let b = 1; b <= prizes.length; b++) if (cents[b]! > cents[b + 1]!) drops.push({ place: b, drop: cents[b]! - cents[b + 1]! });
  if (drops.length === 0) return [];
  const least = Math.min(...drops.map((d) => d.drop));
  return drops.map(({ place, drop }) => {
    // ceil(drop / least) over whole cents, exactly.
    const r = drop % least;
    const q = (drop - r) / least + (r > 0 ? 1 : 0);
    return { place, cap: Math.min(capMax, cap * q) };
  });
}

// ---------------------------------------------------------------- who races

/** An active entrant: the most games it may still take before every boundary it straddles is capped for it. */
export interface JudgeRaceActiveT {
  member: string;
  room: number;
}

export interface JudgeRaceStateT {
  /** The entrants by p, higher first, ties by sha256. */
  ranked: string[];
  /** The active entrants in rank order. */
  active: JudgeRaceActiveT[];
  /** The tie clusters' pairs (judgeRacePairKey), never paired again. */
  ties: Set<string>;
}

/**
 * Who races this epoch (the header's who races). `entrants` the shortlisted entrants (never an anchor-only member),
 * each held by `intervals` (judgeRaceIntervals over the games so far: games_i its games there); `tiers` from
 * judgeRaceTiers; epsilon from 0 (a number or a Fixed9 string), on the log scale; `games` the games so far (in any
 * order), read for the ties.
 */
export function judgeRaceActive(o: {
  entrants: readonly string[];
  intervals: ReadonlyMap<string, JudgeRaceIntervalT>;
  tiers: readonly JudgeRaceTierT[];
  epsilon: number | string;
  games: readonly JudgeRaceGameT[];
}): JudgeRaceStateT {
  checkMembers(o.entrants, 'the entrants');
  const eps = judgeRaceNumber(o.epsilon, 'epsilon', 0);
  const of = (m: string): JudgeRaceIntervalT => {
    const v = o.intervals.get(m);
    if (v === undefined) throw new RangeError(`the entrant ${m} has no interval`);
    return v;
  };
  for (const t of o.tiers) {
    checkWhole(t.place, 'a tier place', 1);
    checkWhole(t.cap, `place ${t.place}'s cap`, 0);
  }
  const ranked = [...o.entrants].sort((x, y) => {
    const px = of(x).p;
    const py = of(y).p;
    return px > py ? -1 : px < py ? 1 : compareCodeUnits(x, y);
  });
  const los = ranked.map((m) => of(m).lo).sort((x, y) => y - x);
  const his = ranked.map((m) => of(m).hi).sort((x, y) => y - x);
  const active: JudgeRaceActiveT[] = [];
  for (const m of ranked) {
    const v = of(m);
    if (!(v.half > eps)) continue;
    let room = 0;
    for (const { place: b, cap } of o.tiers) {
      if (b >= ranked.length) continue; // no entrant below b: nothing to separate
      if (v.hi >= los[b - 1]! && v.lo <= his[b]! && v.games < cap) room = Math.max(room, cap - v.games);
    }
    if (room > 0) active.push({ member: m, room });
  }
  const entrant = new Set(o.entrants);
  const pairs = new Map<string, { lo: string; hi: string; r: number; u: number }>();
  for (const g of o.games) {
    if (g.a === g.b) throw new RangeError(`a game of ${g.a} against itself`);
    const points = pointsOf(g);
    if (!entrant.has(g.a) || !entrant.has(g.b)) continue;
    const aLow = compareCodeUnits(g.a, g.b) < 0;
    const key = aLow ? `${g.a}:${g.b}` : `${g.b}:${g.a}`;
    const pair = pairs.get(key) ?? { lo: aLow ? g.a : g.b, hi: aLow ? g.b : g.a, r: 0, u: 0 };
    pair.r += 1;
    pair.u += aLow ? points : JUDGE_GAME_POINTS - points;
    pairs.set(key, pair);
  }
  const ties = new Set<string>();
  for (const [key, { lo, hi, r, u }] of pairs) {
    // |u / r - 10| <= 1 in whole numbers: |u - 10 r| <= r.
    if (r < 2 || Math.abs(u - (JUDGE_GAME_POINTS / 2) * r) > r) continue;
    if (Math.abs(of(lo).log - of(hi).log) <= eps) ties.add(key);
  }
  return { ranked, active, ties };
}

// ---------------------------------------------------------------- the pairs

/** A race pair: `a` the active entrant that chose, `b` its opponent, and the slot order its first call runs in. */
export interface JudgeRacePairT {
  a: string;
  b: string;
  first: JudgeSlotOrderT;
}

/**
 * One epoch's games (the header's pairs). `active` judgeRaceActive's, in its order; `candidates` every member of S and
 * the anchors with its strength (judgeRaceStrengths'), each active entrant among them; `games` the games so far (any
 * order, each between two candidates), read for how often each pair played (the repeat discount); `ties`
 * judgeRaceActive's; `epochCalls` a whole number from 2 (the epoch pads to ceil(epochCalls / 2) games); `budget` the
 * games the race may still play (absent: no limit); `caps` the most games a candidate may take this epoch, by member
 * (each a candidate, a whole number from 0; a candidate it leaves out, and every one when absent, has none), never
 * passed in either pass; `first` each pair's first slot order. The same pairs for any order of `candidates` or `games`;
 * with no `caps`, the pairs a call before them made.
 */
export function judgeRacePairs(o: {
  active: readonly JudgeRaceActiveT[];
  candidates: ReadonlyMap<string, Pick<JudgeRaceStrengthT, 'p' | 'info'>>;
  games: readonly Pick<JudgeRaceGameT, 'a' | 'b'>[];
  ties: ReadonlySet<string>;
  epochCalls: number;
  budget?: number;
  caps?: ReadonlyMap<string, number>;
  first: (a: string, b: string) => JudgeSlotOrderT;
}): JudgeRacePairT[] {
  checkWhole(o.epochCalls, 'the epoch calls', 2);
  if (o.budget !== undefined) checkWhole(o.budget, 'the race budget', 0);
  const budget = o.budget ?? Number.POSITIVE_INFINITY;
  const target = Math.ceil(o.epochCalls / 2);
  const names = [...o.candidates.keys()].sort(compareCodeUnits);
  checkMembers(names, 'the candidates');
  const n = names.length;
  const at = new Map(names.map((m, i) => [m, i]));
  const P = new Float64Array(n);
  const I = new Float64Array(n);
  names.forEach((m, i) => {
    const s = o.candidates.get(m)!;
    checkPositive(s.p, `${m}'s strength`);
    checkPositive(s.info, `${m}'s information`);
    P[i] = s.p;
    I[i] = s.info;
  });
  checkMembers(
    o.active.map((a) => a.member),
    'the active entrants',
  );
  // Per active entrant, its games against each candidate before this epoch and the candidates it may not take
  // (Infinity: its ties and the pairs this epoch already holds).
  // An active entrant's room this epoch; a non-racing candidate's is the epoch's load cap (an opponent spends none of a
  // race cap, but no one opponent takes the epoch's games): ceil(E / n) + 1 over whole numbers, exactly.
  const most = Math.min(budget, Math.max(target, o.active.length));
  const spare = n === 0 ? 0 : most % n;
  const load = n === 0 ? 0 : (most - spare) / n + (spare > 0 ? 1 : 0) + 1;
  const room = new Float64Array(n).fill(load);
  const racing = new Uint8Array(n);
  const seen = new Map<number, Map<number, number>>();
  for (const { member, room: r } of o.active) {
    const i = at.get(member);
    if (i === undefined) throw new RangeError(`the active entrant ${member} is not a candidate`);
    checkWhole(r, `${member}'s room`, 1);
    room[i] = r;
    racing[i] = 1;
    seen.set(i, new Map());
  }
  const note = (i: number, j: number, add: number): void => {
    const row = seen.get(i);
    if (row !== undefined) row.set(j, (row.get(j) ?? 0) + add);
  };
  for (const g of o.games) {
    const i = at.get(g.a);
    const j = at.get(g.b);
    if (i === undefined || j === undefined) throw new RangeError(`a game between ${g.a} and ${g.b} names a member that is not a candidate`);
    if (i === j) throw new RangeError(`a game of ${g.a} against itself`);
    note(i, j, 1);
    note(j, i, 1);
  }
  for (const key of o.ties) {
    const [lo, hi] = key.split(':') as [string, string];
    const i = at.get(lo);
    const j = at.get(hi);
    if (i === undefined || j === undefined) continue;
    note(i, j, Number.POSITIVE_INFINITY);
    note(j, i, Number.POSITIVE_INFINITY);
  }
  // The caller's hard caps this epoch (Infinity where none is named, so a call with no caps compares as one before them).
  const cap = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  if (o.caps !== undefined) {
    for (const [m, c] of o.caps) {
      const i = at.get(m);
      if (i === undefined) throw new RangeError(`the capped member ${m} is not a candidate`);
      checkWhole(c, `${m}'s cap`, 0);
      cap[i] = c;
    }
  }
  const used = new Float64Array(n);
  const mark = new Float64Array(n);
  const out: JudgeRacePairT[] = [];
  // i's best candidate: the most information discounted for repeats, then fewer games, then the lowest sha256 (the
  // lowest index: names are in sha256 order and only a strictly better candidate displaces one). `pastLoad` lets a
  // non-racing candidate at the load cap be taken (never an active entrant out of room, never a candidate at its cap).
  const take = (i: number, pastLoad: boolean): boolean => {
    const row = seen.get(i)!;
    for (const [j, c] of row) mark[j] = c;
    mark[i] = Number.POSITIVE_INFINITY;
    const pi = P[i]!;
    const ii = I[i]!;
    let best = -1;
    let bestPlayed = 0;
    let bestScore = 0;
    for (let j = 0; j < n; j++) {
      const played = mark[j]!;
      if (played === Number.POSITIVE_INFINITY) continue;
      if (used[j]! >= cap[j]!) continue;
      if (used[j]! >= room[j]! && (racing[j] === 1 || !pastLoad)) continue;
      const pj = P[j]!;
      const s = pi + pj;
      const score = (((pi * pj) / (s * s)) * (I[j]! / (ii + I[j]!))) / (1 + played);
      if (best < 0 || score > bestScore || (score === bestScore && played < bestPlayed)) {
        best = j;
        bestPlayed = played;
        bestScore = score;
      }
    }
    for (const j of row.keys()) mark[j] = 0;
    mark[i] = 0;
    if (best < 0) return false;
    // The epoch holds the pair now: neither side takes it again this epoch.
    note(i, best, Number.POSITIVE_INFINITY);
    note(best, i, Number.POSITIVE_INFINITY);
    used[i] += 1;
    used[best] += 1;
    out.push({ a: names[i]!, b: names[best]!, first: o.first(names[i]!, names[best]!) });
    return true;
  };
  const order = o.active.map((a) => at.get(a.member)!);
  for (const i of order) {
    if (out.length >= budget) return out;
    if (used[i]! > 0 || used[i]! >= cap[i]!) continue;
    if (!take(i, false)) take(i, true);
  }
  for (let grew = true; grew && out.length < target; ) {
    grew = false;
    for (const i of order) {
      if (out.length >= target || out.length >= budget) return out;
      if (used[i]! >= room[i]! || used[i]! >= cap[i]!) continue;
      if (take(i, false)) grew = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the bound

/**
 * The most games a v4 heat's race (F3) plays in all over a shortlist of `shortlist` members (S, the anchors in it):
 * max(M x race_cap_max, ceil(|S| / 2)), so a shortlist far past the line (an n = 50k field whose top rung sits at its
 * 10th percentile keeps about 18k) still has a game's room for each of its pairs. None when M or race_cap_max is 0: no
 * line to race, or no epoch to race it in (a caller summing the bound's parts passes 0 for the parts it leaves out).
 * Whole numbers only, the same on every host.
 */
export function judgeRaceBudget(linePlaces: number, raceCapMax: number, shortlist: number): number {
  checkWhole(linePlaces, 'the line places', 0);
  checkWhole(raceCapMax, 'the race cap max', 0);
  checkWhole(shortlist, 'the shortlist', 0);
  const line = linePlaces * raceCapMax;
  return line === 0 ? 0 : Math.max(line, Math.ceil(shortlist / 2));
}

/**
 * An upper bound on a v4 heat's calls before any result (the header's bound), two calls a game: F2's `rounds` Swiss
 * rounds over min(n, field) members (n the members it plays, S and the anchors once the screen is known; field every
 * member), the race's budget over those members (judgeRaceBudget: max(linePlaces x raceCapMax, ceil(members / 2))
 * games, none when either is 0), the playoff's places (places - 1) repeats over min(playoffPlaces, those members)
 * places, and `topRepeats` games between the top two (none under two places), the playoff's and the top two's games
 * each `playoffJudges` times over (default 1: a v4 heat's one game a pair; a v5 panel final plans each playoff game once
 * a panel seat and once for the shadow, grader/judge-heat.ts JUDGE_HEAT_PANEL_PLAYOFF_GAMES). Every argument a whole
 * number from 0, `playoffJudges` from 1.
 */
export function judgeScreenedCallBound(
  n: number,
  o: { field: number; rounds: number; linePlaces: number; raceCapMax: number; playoffPlaces: number; playoffRepeats: number; topRepeats: number; playoffJudges?: number },
): number {
  checkWhole(n, 'the members', 0);
  const { playoffJudges = 1, ...counts } = o;
  for (const [what, v] of Object.entries(counts)) checkWhole(v, what, 0);
  checkWhole(playoffJudges, 'playoffJudges', 1);
  const members = Math.min(n, o.field);
  const swiss = 2 * Math.floor(members / 2) * o.rounds;
  const race = 2 * judgeRaceBudget(o.linePlaces, o.raceCapMax, members);
  const places = Math.min(o.playoffPlaces, members);
  const playoff = places < 2 ? 0 : places * (places - 1) * o.playoffRepeats * playoffJudges;
  const top = places < 2 ? 0 : 2 * o.topRepeats * playoffJudges;
  return swiss + race + playoff + top;
}
