// The code kinds: the ways a sponsored code bounty can pick its winner when make.fun writes the
// hidden tests. A sponsor whose bounty is code (a program that reads inputs and writes outputs) picks
// one in a custom scoring brief (contracts/sponsor-proposal.ts ProposalCustomScoring: scoring.custom
// .kind, with its runtimes), says in the brief what the program must do and what it reads and writes,
// and requests the make.fun team's setup; the team writes the hidden tests from the brief and its
// examples and sets the scoring up (server/routes/admin/proposals.ts). A brief with no kind is
// "Something else": the team reads the brief alone. A sponsor never uploads the tests, a scorer or
// any data.
//
//   code-score      Best test score     pass at least one test; the highest test score wins, partial
//                                       credit counts, an equal score going to the smaller code
//   code-first      First to pass       pass every test; every passing entry ties, the earlier wins
//   code-smallest   Smallest code       pass every test; the smallest compressed size wins, in one
//                                       language
//   code-fastest    Fastest             pass every test; the least CPU time, net of the null-entry
//                                       control, wins, in one language
//   code-cheapest   Cheapest to build   pass every test; the lowest model spend on the build key
//                                       make.fun meters wins, and a prize needs 80% of the code authored
//
// Every tie left goes to the earlier entry, and a place no entry through the pass bar takes refunds to the
// sponsor: a field where nobody passes it pays nobody, and the whole pot goes back. One catalogue for
// every surface: the contract (the kind a brief names), the proposal wizard's choice (label, pitch,
// caveat, the language row), the brief a draft is built from (rubric), the house's setup (gate, rank,
// submission) and the agent skill's text. zod and data only: no Node APIs and no relative import at all, not even of types, since the
// web typecheck (tsconfig.json) refuses the `.ts` paths the rest of contracts/ imports by, so the
// browser bundle, the server and the CLI load it alike. contracts/sponsor-proposal.ts holds the
// catalogue to the competition contract instead: a kind's submission rule is one of its
// CODABENCH_SUBMISSION_RULES, and the runtimes a brief names are its RUNTIMES.
//
// The words of Best test score and Smallest code moved with the measured-bounty rules (plan item-489, rules generation
// 1: ComposeHouse.measure_rules, frozen on the proposal at its deposit): CODE_KINDS says them now, and the words they
// replaced are LEGACY_CODE_KIND_WORDS, which a bounty that froze no generation still runs under (codeKindWordsOf), so
// its published rules say what its bundle does. First to pass, Fastest and Cheapest to build kept every word. What ranks
// moved with them, at the generation alone (codeKindRankOf, codeKindTieBreakOf): Smallest code by compressed size, and
// an equal Best test score to the smaller compressed size; CODE_KINDS' rank is what a bounty with no generation runs.

import { z } from 'zod';

/** Every code kind, in the order a sponsor is shown them. */
export const CODE_KIND_IDS = ['code-score', 'code-first', 'code-smallest', 'code-fastest', 'code-cheapest'] as const;
export type CodeKindIdT = (typeof CODE_KIND_IDS)[number];

/** A code kind's id (scoring.custom.kind). */
export const CodeKindId = z.enum(CODE_KIND_IDS);

/** The house's tie rule, word for word in every pitch but Best test score's (CODE_SCORE_TIE) and Fastest's (CODE_FASTEST_TIE). */
export const CODE_KIND_TIE = 'ties go to the earlier entry';

/**
 * Best test score's tie rule, word for word in its pitch: an equal score goes to the smaller code by compressed size
 * (the board's tie-break column), and only then to the earlier entry, so whole points shared by every working entry
 * still leave a clear order. Its legacy pitch (LEGACY_CODE_KIND_WORDS) said the house's, CODE_KIND_TIE.
 */
export const CODE_SCORE_TIE = 'ties go to the smaller code, then the earlier entry';

/**
 * Fastest's tie rule, word for word in its pitch (and only there: its caveat, shown right under the pitch, leaves it
 * out rather than say it twice): its order (grader/code-heat.ts) lets a later entry pass an earlier one only when it
 * is faster at 95% confidence over the repeated runs, so a time the runs cannot tell apart stays with the earlier
 * entry, not only an exact tie.
 */
export const CODE_FASTEST_TIE = 'a later entry beats an earlier one only if it is faster with 95% confidence';

/** Each kind's tie rule, word for word in its pitch (the catalogue's check, CodeKind, reads it): its own where it has one, else the house's. */
export const CODE_KIND_TIES: { readonly [K in CodeKindIdT]: string } = Object.freeze({
  'code-score': CODE_SCORE_TIE,
  'code-first': CODE_KIND_TIE,
  'code-smallest': CODE_KIND_TIE,
  'code-fastest': CODE_FASTEST_TIE,
  'code-cheapest': CODE_KIND_TIE,
});

/** A line of copy: no line break, no space at either end. */
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), 'one line, no line break')
    .refine((s) => s === s.trim(), 'no leading or trailing space');

/** A sentence of copy: one line that ends with a full stop. */
const sentence = (max: number) => line(max).refine((s) => s.endsWith('.'), 'a sentence, ending with a full stop');

/** The submission rules a kind takes: two of contracts/competition.ts CODABENCH_SUBMISSION_RULES. */
const KindSubmission = z.enum(['Force_Best', 'Force_Last']);

/** One code kind, as the catalogue holds it; its pitch names its kind's tie rule, word for word. */
export const CodeKind = z.strictObject({
  id: CodeKindId,
  /** A short, friendly name for the choice ("Smallest code"). */
  label: line(40),
  /** One line a sponsor reads to pick it: the gate, what ranks, and its tie rule (CODE_KIND_TIES: CODE_KIND_TIE, Best test score's CODE_SCORE_TIE, Fastest's CODE_FASTEST_TIE). */
  pitch: sentence(240),
  /** The one thing a sponsor should know before choosing it (shown under the pitch, so never repeating it), or null when the pitch says it all. */
  caveat: sentence(200).nullable(),
  /** How to judge entries, in one sentence a brief built for this kind ends with (it follows what the program must do). */
  rubric: sentence(300),
  /**
   * What an entry must pass to take a prize, its pass bar: 'passed', every hidden test (the house tests
   * scorer's passed column is 1, the harness's gate; an entry that fails ranks below every one that passes
   * and takes no prize); 'one', at least one hidden test (the scorer's tests_passed column at 1 or more,
   * the harness's pass_count; an entry that passes none keeps its listing, ranks below every one that
   * passes a case and takes no prize), partial credit above it ranking as it scores. Either way the
   * eligibility reason is failed_tests, and a place no entry through the bar takes refunds to the sponsor.
   */
  gate: z.enum(['one', 'passed']),
  /**
   * What entries rank by, among those through the gate: `key` the measure, a column the house tests
   * scorer writes (score, passed) or a measure of the entry itself (size.bytes, timing.trimmed_mean,
   * cost.micro_usd); `better` which way wins. A tie on it goes as the kind's tie rule says (CODE_KIND_TIES). What a
   * bounty with no rules generation ranks by: one of rules generation 1 ranks as codeKindRankOf says (Smallest code by
   * size.compressed, MEASURED_CODE_KIND_RANKS), its exact ties first to codeKindTieBreakOf's measure where it names one.
   */
  rank: z.strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'a snake_case measure, dot-separated'),
    better: z.enum(['higher', 'lower']),
  }),
  /** 'one': every entry in one language, so sizes and times compare like for like; 'any': any runtime the sponsor allows. */
  runtimes: z.enum(['one', 'any']),
  /**
   * Which of an entrant's entries ranks: Force_Best, their best (a later push that fails does not
   * undo an earlier pass); Force_Last, their last.
   */
  submission: KindSubmission,
  /**
   * Whether a sponsor can pick it now; false while the house cannot run it yet, and never true while no grading
   * module writes its rank column (server/proposals/templates.ts CODE_RANK_WRITERS; code-kinds.test.ts holds it).
   */
  offered: z.boolean(),
}).superRefine((k, ctx) => {
  const tie = CODE_KIND_TIES[k.id];
  if (!k.pitch.includes(tie)) ctx.addIssue({ code: 'custom', path: ['pitch'], message: `the pitch names the tie rule: ${tie}` });
});

type CodeKindParsed = z.infer<typeof CodeKind>;
/** A code kind, frozen: the catalogue's entries. */
export type CodeKindT = Readonly<Omit<CodeKindParsed, 'rank'>> & { readonly rank: Readonly<CodeKindParsed['rank']> };

function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

/** The catalogue, by id. */
export const CODE_KINDS: { readonly [K in CodeKindIdT]: CodeKindT & { readonly id: K } } = deepFreeze({
  'code-score': {
    id: 'code-score',
    label: 'Best test score',
    pitch: 'Entries run on hidden tests make.fun writes from your brief; the highest test score wins, partial credit counts, an entry must pass at least one hidden test to win, and ties go to the smaller code, then the earlier entry.',
    caveat: "A tie on the score goes to the smaller compressed size of an entry's repo, file names included, counted the way a compressor would shrink it; a packed program is counted by the bytes it ships.",
    rubric: 'Each entry runs on hidden tests written from this brief and earns the points of every test it passes; the highest score wins, partial credit counts, an entry must pass at least one hidden test to win, and ties go to the smaller code by compressed size, then the earlier entry.',
    gate: 'one',
    rank: { key: 'score', better: 'higher' },
    runtimes: 'any',
    submission: 'Force_Last',
    offered: true,
  },
  'code-first': {
    id: 'code-first',
    label: 'First to pass',
    pitch: 'Entries must pass every hidden test make.fun writes from your brief; every entry that does ties, and ties go to the earlier entry, so the first to pass wins.',
    caveat: 'Who passed first is decided at the final grade after entries close, not the moment someone passes.',
    rubric: 'An entry must pass every hidden test written from this brief; every entry that does ties, and ties go to the earlier entry, so the first entry to pass them all wins.',
    gate: 'passed',
    rank: { key: 'passed', better: 'higher' },
    runtimes: 'any',
    submission: 'Force_Best',
    offered: true,
  },
  'code-smallest': {
    id: 'code-smallest',
    label: 'Smallest code',
    pitch: 'Entries must pass every hidden test make.fun writes from your brief; the smallest code by compressed size wins, and ties go to the earlier entry.',
    caveat: "Size is the compressed size of every file in an entry's repo, file names included, in one language, to a thousandth of a byte; a packed program is counted by the bytes it ships.",
    rubric: 'An entry must pass every hidden test written from this brief; among those that do, the smallest code wins, by the compressed size of every file in its repo and its file names in one language, a packed program counted by the bytes it ships, and ties go to the earlier entry.',
    gate: 'passed',
    rank: { key: 'size.bytes', better: 'lower' },
    runtimes: 'one',
    submission: 'Force_Last',
    offered: true,
  },
  'code-fastest': {
    id: 'code-fastest',
    label: 'Fastest',
    pitch: 'Entries must pass every hidden test make.fun writes from your brief; the least CPU time over repeated timed runs, net of the null-entry control, wins, and a later entry beats an earlier one only if it is faster with 95% confidence.',
    caveat: 'Every entry is in one language with a repo of at most 1 MiB, to bound lookup tables.',
    rubric: 'An entry must pass every hidden test written from this brief; among those that do, the least CPU time over repeated timed runs, net of the null-entry control (a do-nothing entry timed beside them), wins, in one language, and a later entry passes an earlier entry only if faster at 95% confidence.',
    gate: 'passed',
    rank: { key: 'timing.trimmed_mean', better: 'lower' },
    runtimes: 'one',
    submission: 'Force_Last',
    offered: true,
  },
  'code-cheapest': {
    id: 'code-cheapest',
    label: 'Cheapest to build',
    pitch: 'Entries must pass every hidden test make.fun writes from your brief; the lowest model spend to build one wins, and ties go to the earlier entry.',
    caveat: "Only model spend on make.fun's metered build key counts, so an entry with unmetered model use can't place, and a reward needs at least 80% of its code written in its build transcripts.",
    rubric: 'An entry must pass every hidden test written from this brief; among those that do, the lowest metered model spend to build it wins, and ties go to the earlier entry.',
    gate: 'passed',
    rank: { key: 'cost.micro_usd', better: 'lower' },
    runtimes: 'any',
    submission: 'Force_Last',
    offered: true,
  },
});

/** A kind's words: the line a sponsor picks it by (pitch), the one thing to know (caveat, or null) and how a brief built for it ends (rubric). */
export type CodeKindWordsT = Readonly<Pick<CodeKindParsed, 'pitch' | 'caveat' | 'rubric'>>;

/** The kinds whose words moved with the rules generation (LEGACY_CODE_KIND_WORDS' keys). */
export type LegacyWordsCodeKindIdT = 'code-score' | 'code-smallest';

/**
 * The words Best test score and Smallest code said before the measured-bounty rules (rules generation 1,
 * CODE_KIND_WORDS_GENERATION), word for word: what a bounty that froze no generation (deposited with the setting off,
 * before the generation was kept, or a code brief whose own text holds one of these rubrics: compose.ts
 * depositFrozenTermsOf) still runs and publishes (codeKindWordsOf). Each pitch names the house's tie rule
 * (CODE_KIND_TIE): ties went to the earlier entry alone, and size was every byte. Never edited: a funded bounty's rules
 * say them.
 */
export const LEGACY_CODE_KIND_WORDS: { readonly [K in LegacyWordsCodeKindIdT]: CodeKindWordsT } = deepFreeze({
  'code-score': {
    pitch: 'Entries run on hidden tests make.fun writes from your brief; the highest test score wins, partial credit counts, an entry must pass at least one hidden test to win, and ties go to the earlier entry.',
    caveat: null,
    rubric: 'Each entry runs on hidden tests written from this brief and earns the points of every test it passes; the highest score wins, partial credit counts, an entry must pass at least one hidden test to win, and ties go to the earlier entry.',
  },
  'code-smallest': {
    pitch: 'Entries must pass every hidden test make.fun writes from your brief; the smallest code in bytes wins, and ties go to the earlier entry.',
    caveat: "Size is every byte of every file in an entry's repo, file names included, in one language, except a starter file left unchanged: bytes, not lines, since lines can be joined.",
    rubric: 'An entry must pass every hidden test written from this brief; among those that do, the smallest code wins, counting every byte of every file in its repo and its file names, except a starter file left unchanged, in one language, and ties go to the earlier entry.',
  },
});

/** Whether code kind `id`'s words moved with the rules generation (a key of LEGACY_CODE_KIND_WORDS). */
export function hasLegacyCodeKindWords(id: unknown): id is LegacyWordsCodeKindIdT {
  return typeof id === 'string' && Object.hasOwn(LEGACY_CODE_KIND_WORDS, id);
}

/**
 * The rules generation CODE_KINDS' words are written for: 1, the measured-bounty rules (server/proposals/compose.ts
 * MEASURE_RULES_GENERATION, ComposeHouse.measure_rules; one number, held equal by tests/unit/code-kinds-generation.test.ts).
 */
export const CODE_KIND_WORDS_GENERATION = 1;

/**
 * Code kind `id`'s words for a bounty of rules generation `generation` (ComposeHouse.measure_rules, the proposal's frozen
 * measure_rules): CODE_KINDS' at CODE_KIND_WORDS_GENERATION; with none (absent, null) or a generation no release knows,
 * the legacy words where the kind's moved (LEGACY_CODE_KIND_WORDS), so a bounty's rules say what its bundle runs. A
 * kind whose words never moved gets CODE_KINDS' either way.
 */
export function codeKindWordsOf(id: CodeKindIdT, generation?: number | null): CodeKindWordsT {
  if (generation !== CODE_KIND_WORDS_GENERATION && hasLegacyCodeKindWords(id)) return LEGACY_CODE_KIND_WORDS[id];
  return CODE_KINDS[id];
}

/** A measure a kind's entries are ordered by (CodeKind.rank's shape): its key and which way wins. */
export type CodeKindRankT = CodeKindT['rank'];

/**
 * What a kind ranks by at rules generation 1 (CODE_KIND_WORDS_GENERATION), where that moved: Smallest code by the
 * compressed size of its files and their names under make.fun's size model (size.compressed: contracts/competition.ts
 * PROGRAM_COMPRESSED_SIZE_SOURCE, the 'compressed-all-files' count), in place of CODE_KINDS' every byte (size.bytes),
 * which a bounty that froze no generation still ranks by. The words that say it are CODE_KINDS' (codeKindWordsOf).
 */
export const MEASURED_CODE_KIND_RANKS: { readonly [K in CodeKindIdT]?: CodeKindRankT } = deepFreeze({
  'code-smallest': { key: 'size.compressed', better: 'lower' },
});

/**
 * What an exact tie on a kind's rank goes to first at rules generation 1 (CODE_KIND_WORDS_GENERATION), where it names
 * one: Best test score's equal scores to the smaller compressed size (size.compressed, the board's tie-break column),
 * its pitch's CODE_SCORE_TIE. Every other tie, and every tie on a bounty with no generation, goes to the earlier entry.
 */
export const MEASURED_CODE_KIND_TIE_BREAKS: { readonly [K in CodeKindIdT]?: CodeKindRankT } = deepFreeze({
  'code-score': { key: 'size.compressed', better: 'lower' },
});

/**
 * Code kind `id`'s rank for a bounty of rules generation `generation` (ComposeHouse.measure_rules): at
 * CODE_KIND_WORDS_GENERATION its MEASURED_CODE_KIND_RANKS entry where it has one; else, and with none (absent, null) or a
 * generation no release knows, CODE_KINDS' rank, so a bounty with no generation ranks as it always did.
 */
export function codeKindRankOf(id: CodeKindIdT, generation?: number | null): CodeKindRankT {
  return (generation === CODE_KIND_WORDS_GENERATION ? MEASURED_CODE_KIND_RANKS[id] : undefined) ?? CODE_KINDS[id].rank;
}

/**
 * The measure an exact tie on code kind `id`'s rank goes to first, for a bounty of rules generation `generation`: at
 * CODE_KIND_WORDS_GENERATION its MEASURED_CODE_KIND_TIE_BREAKS entry, else null (the earlier entry decides it).
 */
export function codeKindTieBreakOf(id: CodeKindIdT, generation?: number | null): CodeKindRankT | null {
  return (generation === CODE_KIND_WORDS_GENERATION ? MEASURED_CODE_KIND_TIE_BREAKS[id] : undefined) ?? null;
}

/** The kinds a sponsor can pick now, in catalogue order. */
export const OFFERED_CODE_KIND_IDS: readonly CodeKindIdT[] = Object.freeze(CODE_KIND_IDS.filter((id) => CODE_KINDS[id].offered));

/** Whether `id` names a code kind (any, offered or not). */
export function isCodeKindId(id: unknown): id is CodeKindIdT {
  return typeof id === 'string' && (CODE_KIND_IDS as readonly string[]).includes(id);
}

/**
 * Whether `runtimes` (scoring.custom.runtimes) fits kind `id`: a one-language kind (runtimes 'one')
 * takes exactly one runtime; any other takes one or more, or none named (every runtime the house runs).
 */
export function codeKindRuntimesFit(id: CodeKindIdT, runtimes: readonly string[] | undefined): boolean {
  if (CODE_KINDS[id].runtimes === 'one') return runtimes?.length === 1;
  return runtimes === undefined || runtimes.length >= 1;
}
