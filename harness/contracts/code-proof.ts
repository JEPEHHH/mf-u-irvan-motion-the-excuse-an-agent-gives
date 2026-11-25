// make.fun's own code setup (plan item-173): the names every step of a funded code bounty whose hidden test pack the
// house model writes and the sandbox proves, with nobody, builds against. zod and data only, no Node API, its relative
// imports the two leaf contracts code-kinds.ts and primitives.ts (zod alone), so the server, the CLI and the browser
// bundle load it alike. tests/unit/code-proof-contract.test.ts holds every number here to the module it comes from
// (server/proposals/packs.ts, checks.ts, server/seeding/gates.ts, server/competitions/final-ceiling.ts, contracts/
// competition.ts), which a contract may not import.
//
//   the kinds     PREPARED_CODE_KINDS (what the job prepares a pack for), LISTED_CODE_KINDS (what may list on payment
//                 with no person: a pass-at-least-one kind, whose partial credit bounds what one weak or wrong case
//                 costs, or a pass-all kind whose paid places are checked on fresh cases before the result posts) and
//                 AUDITED_CODE_KINDS (those checked so: code-first, code-smallest and code-fastest, see its note: the
//                 generator is sealed, and the line is ranked before the row lock). code-cheapest is never
//                 prepared (its deposit pays a build allowance into the house's wallet); code-fastest is, its inputs
//                 sized for the timing heat (CODE_FASTEST_*: the generator's size, grown until the oracle's work over
//                 the final cases is enough to time, each case's run under half its cap)
//   the plan      CodePackPlan: an option's server-only material beside its cleared text: the public examples (2 to 8
//                 {input, output} pairs, as the brief gives them) and the comparison (exact, lines, tokens or float,
//                 never a checker: a prepared task has one right output per input, derivable from the brief's rule)
//   the bars      the proof's numbers, each with where it comes from (CODE_PROOF_*), and code-fastest's sizing
//                 (CODE_FASTEST_*)
//   the record    CodeProofRecord, format agent-fun/code-proof/v1: what a passed proof found, kept as a blob beside the
//                 pack (the proposal, objective and runtimes; each written program's role, runtime, model and tree
//                 digest; the draw's counts; each kill; the time cap and the slowest accepting run; code-fastest's size
//                 and its oracle's net work; the paid places and grade lanes the ceiling was priced at; the model calls
//                 and sandbox runs; the pack id; the look's verdict). It never
//                 holds an input, an output or the seed: every object in it is strict, so no such member parses
//   the failures  CODE_SETUP_FAILURES: the fixed words of each fail-closed reason, which the desk reads on the setup row.
//                 A failure never quotes a program's error, an input or an output

import { z } from 'zod';
import { CODE_KINDS, type CodeKindIdT } from './code-kinds.ts';
import { Sha256Hex } from './primitives.ts';

// ---------------------------------------------------------------- the kinds

/** The code kinds the job prepares a pack for (scoring.custom.kind of a suggestion's option), in catalogue order. */
export const PREPARED_CODE_KINDS = ['code-score', 'code-first', 'code-smallest', 'code-fastest'] as const satisfies readonly CodeKindIdT[];
export type PreparedCodeKindT = (typeof PREPARED_CODE_KINDS)[number];

/**
 * The prepared kinds whose paid places are checked on fresh cases before the result posts (the Audit steps): the
 * pass-all kinds, code-first, code-smallest and code-fastest (never code-score, whose gate is one passed case;
 * code-fastest's paid places are audited once its timing heat has ranked them, as every reader of its result waits on the
 * heat first). The gate that runs the audit and holds the result on it (server/competitions/lifecycle/finalize.ts
 * codeAuditOwed, runCodeAuditJob; every reader of the result waits on it) and both conditions a pass-all kind is
 * audited, and so listed below, only once they hold, have landed:
 *   1. HOLDS. The generator is sealed: harness.audit names the proof tree's digest (proof_tree_sha256, optional with no
 *      default, written only by the service's compose: server/proposals/code-house.ts codeAuditBlockOf, from the setup's
 *      row through server/routes/admin/proposals.ts serviceProofTreeOf and depositedHouseOf), the rules promise no audit
 *      without it, and the audit (server/proposals/code-setup/audit.ts runCodeAudit) reads the tree by that digest and
 *      refuses a block naming none, a setup row naming another tree, and a tree that does not hash to it;
 *   2. HOLDS. The audit's line is not ranked on the event loop under a row lock: the post-result job's step 3
 *      (server/chain/jobs/post-result.ts settledStandingsOf) and a resolve rank it once, before their transaction, as a
 *      sliced pass (finalize.ts prefetchCodeAuditLine over lifecycle/resolve.ts inLineForRewardOf: payouts/standings.ts
 *      computeStandingsSliced, the loop handed back between its steps), and under the competition row's lock read only
 *      the entries again and the code_audit rows, taking the ranked line when the entries are deeply equal to the ones it
 *      was ranked from (as entries/finalist-review.ts takes its prefetched places); only an entry that moved in between
 *      is ranked there at once. Every reader outside a transaction (the automation's gates, the code-audit job) ranks it
 *      sliced too. A bundle naming no audit ranks and reads nothing of it.
 * code-fastest's audit draws its fresh cases at the size its proof chose: the size is in the sealed generator's own
 * tree (its house-written meta file), so the audit's cases weigh as the final cases do.
 */
export const AUDITED_CODE_KINDS: readonly PreparedCodeKindT[] = Object.freeze(['code-first', 'code-smallest', 'code-fastest']);

/**
 * The prepared kinds that may list on payment with no person (MAKEFUN_PROPOSAL_CODE_SETUP `list`): code-score from the
 * start (its gate is one passed case and its partial credit bounds a weak case's cost); a pass-all kind (gate `passed`)
 * only once it is in AUDITED_CODE_KINDS, as code-first, code-smallest and code-fastest are. Every kind under `assist`
 * waits for a person.
 */
export const LISTED_CODE_KINDS: readonly PreparedCodeKindT[] = Object.freeze(['code-score', 'code-first', 'code-smallest', 'code-fastest']);

/** Whether `kind` names a kind the job prepares a pack for. */
export function isPreparedCodeKind(kind: unknown): kind is PreparedCodeKindT {
  return typeof kind === 'string' && (PREPARED_CODE_KINDS as readonly string[]).includes(kind);
}

/** Whether `kind` may list on payment with no person (LISTED_CODE_KINDS). */
export function isListedCodeKind(kind: unknown): kind is PreparedCodeKindT {
  return typeof kind === 'string' && (LISTED_CODE_KINDS as readonly string[]).includes(kind);
}

/** Whether `kind`'s paid places are checked on fresh cases before its result posts (AUDITED_CODE_KINDS). */
export function isAuditedCodeKind(kind: unknown): kind is PreparedCodeKindT {
  return typeof kind === 'string' && (AUDITED_CODE_KINDS as readonly string[]).includes(kind);
}

/** Whether kind `kind` passes an entry on every case (gate `passed`), so one wrong hidden case costs a whole reward. */
export function codeKindPassesAll(kind: CodeKindIdT): boolean {
  return CODE_KINDS[kind].gate === 'passed';
}

// ---------------------------------------------------------------- the plan

/** The runtimes a written program runs in: contracts/competition.ts RUNTIMES (the test holds them equal). */
export const CODE_PROOF_RUNTIMES = ['node22', 'python3.13'] as const;
export type CodeProofRuntimeT = (typeof CODE_PROOF_RUNTIMES)[number];

/** The comparisons a prepared pack uses: server/proposals/packs.ts PACK_COMPARE_MODES but `checker`, which a prepared task never needs. */
export const CODE_COMPARE_MODES = ['exact', 'lines', 'tokens', 'float'] as const;
export type CodeCompareModeT = (typeof CODE_COMPARE_MODES)[number];

/** The fewest and the most public examples a plan carries. */
export const CODE_PLAN_MIN_EXAMPLES = 2;
export const CODE_PLAN_MAX_EXAMPLES = 8;
/** The longest example input or output a plan carries, in UTF-16 code units: a public example a person reads in the brief. */
export const CODE_PLAN_EXAMPLE_MAX_CHARS = 16_384;

const Tolerance = z.number().finite().min(0);

/** The comparison of an output with its reference, as server/proposals/packs.ts PackCompare reads it (tolerances with float only), never `checker`. */
export const CodeCompare = z
  .strictObject({
    mode: z.enum(CODE_COMPARE_MODES),
    abs_tol: Tolerance.optional(),
    rel_tol: Tolerance.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.mode === 'float') return;
    for (const k of ['abs_tol', 'rel_tol'] as const) {
      if (c[k] !== undefined) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is a float comparison's tolerance: compare mode ${c.mode} takes none` });
    }
  });
export type CodeCompareT = z.infer<typeof CodeCompare>;

/** One public example: the input a program reads and the output the brief says it writes, as text. */
export const CodeExample = z.strictObject({
  input: z.string().min(1).max(CODE_PLAN_EXAMPLE_MAX_CHARS),
  output: z.string().max(CODE_PLAN_EXAMPLE_MAX_CHARS),
});
export type CodeExampleT = z.infer<typeof CodeExample>;

/**
 * An option's server-only material for a code setup, kept beside its cleared text and never shown to the requester: the
 * public examples (each input once) and the comparison. The brief's text is the option's own; this adds nothing a person
 * reads but the examples, which the brief shows.
 */
export const CodePackPlan = z
  .strictObject({
    examples: z.array(CodeExample).min(CODE_PLAN_MIN_EXAMPLES).max(CODE_PLAN_MAX_EXAMPLES),
    compare: CodeCompare,
  })
  .superRefine((p, ctx) => {
    const seen = new Map<string, number>();
    p.examples.forEach((e, i) => {
      const first = seen.get(e.input);
      if (first === undefined) seen.set(e.input, i);
      else ctx.addIssue({ code: 'custom', path: ['examples', i, 'input'], message: `example ${i}'s input is example ${first}'s again: each example's input is distinct` });
    });
  });
export type CodePackPlanT = z.infer<typeof CodePackPlan>;

// ---------------------------------------------------------------- the bars

/** The most final (hidden) cases a proof keeps, when the grading ceiling leaves room for them. */
export const CODE_PROOF_MAX_FINAL_CASES = 30;
/** The fewest final cases a proof keeps: server/proposals/checks.ts PACK_MIN_FINAL_CASES (packCheck's own floor). */
export const CODE_PROOF_MIN_FINAL_CASES = 10;
/** The field the final cases are sized for: server/competitions/final-ceiling.ts FINAL_GRADING_CEILING_ENTRIES, the grading ceiling's 2,000 entries. */
export const CODE_PROOF_SIZING_ENTRIES = 2_000;
/** Candidate inputs drawn for each final case the proof aims at (a draw of 3 x the aim, before legality and agreement thin it). */
export const CODE_PROOF_CANDIDATES_PER_CASE = 3;

/** A share as a whole fraction, so a bar compares in integers: `num` / `den`. */
export interface CodeProofShare {
  readonly num: number;
  readonly den: number;
}
/** At most a tenth of the legal candidates contested (the three programs disagree on them): more, and the task is read too many ways. */
export const CODE_PROOF_MAX_CONTESTED_SHARE: CodeProofShare = Object.freeze({ num: 1, den: 10 });
/** No generator class over half of its legal candidates contested. */
export const CODE_PROOF_MAX_CLASS_CONTESTED_SHARE: CodeProofShare = Object.freeze({ num: 1, den: 2 });
/** At least half the candidates legal to both validators. */
export const CODE_PROOF_MIN_LEGAL_SHARE: CodeProofShare = Object.freeze({ num: 1, den: 2 });

/** Whether `part` of `whole` is at most `share` of it, in integers. */
export function atMostShare(part: number, whole: number, share: CodeProofShare): boolean {
  return part * share.den <= whole * share.num;
}
/** Whether `part` of `whole` is at least `share` of it, in integers. */
export function atLeastShare(part: number, whole: number, share: CodeProofShare): boolean {
  return part * share.den >= whole * share.num;
}

/** Public cases added for each generator class: one kept case of each, so an entrant sees how every class is read. */
export const CODE_PROOF_PUBLIC_PER_CLASS = 1;
/** The most generator classes, and so the most public cases added. */
export const CODE_PROOF_MAX_CLASSES = 8;
/** The wrong programs the writer is asked for: each one plausible misreading or shortcut of the brief, named. */
export const CODE_PROOF_WRONG_WRITTEN = 5;
/** The fewest of them the final cases must show wrong (by the kind's gate); one never shown wrong is dropped and recorded. */
export const CODE_PROOF_MIN_WRONG_SHOWN = 3;
/** The wrong programs the pack keeps (packs.ts wrong/<name>): the two that failed the most final cases. */
export const CODE_PROOF_PACK_WRONG = 2;
/** The most points a trivial entry (the null entry or one of the battery) may score on code-score: server/seeding/gates.ts TRIVIAL_MAX_POINTS. */
export const CODE_PROOF_TRIVIAL_MAX_POINTS = 10;
/** The points a code-score pack's final cases share (server/seeding/templates/kit.ts splitPoints): an entry passing every one scores this. */
export const CODE_PROOF_FULL_POINTS = 100;
/** The fewest different point totals the written wrong programs shown wrong must take on code-score (codeScoreSpreads). */
export const CODE_PROOF_MIN_SPREAD_TOTALS = 2;

/**
 * code-score's spread (server/proposals/code-setup/prove.ts, after the kills and the fuzz swaps): whether the point
 * totals of the written wrong programs the final cases showed wrong, `totals` (one a program), take at least
 * CODE_PROOF_MIN_SPREAD_TOTALS different values with at least one above CODE_PROOF_TRIVIAL_MAX_POINTS and below
 * CODE_PROOF_FULL_POINTS. A pack whose wrong programs all score alike, or all near nothing, does not tell a partly right
 * entry from a wholly wrong one; failing it is `spread`. The pass-all kinds need none: their gate is pass or fail.
 */
export function codeScoreSpreads(totals: readonly number[]): boolean {
  return new Set(totals).size >= CODE_PROOF_MIN_SPREAD_TOTALS && totals.some((t) => t > CODE_PROOF_TRIVIAL_MAX_POINTS && t < CODE_PROOF_FULL_POINTS);
}
/**
 * The time cap is at least this many times the slowest accepting run: the ICPC problem package format's
 * ac_to_time_limit (2), and server/proposals/packs.ts buildPack's own warning on an oracle run over half its cap.
 */
export const CODE_PROOF_TIME_CAP_FACTOR = 2;
/** The least time cap, in ms, however fast the accepting runs. */
export const CODE_PROOF_MIN_TIME_CAP_MS = 1_000;
/** The seed a draw takes, in bytes: fresh for each build and each audit, zeroed once drawn, never stored or logged. */
export const CODE_PROOF_SEED_BYTES = 32;

/** The least time cap the bars allow over accepting runs whose slowest took `slowestMs` (whole ms). */
export function codeTimeCapFloorMs(slowestMs: number): number {
  return Math.max(CODE_PROOF_MIN_TIME_CAP_MS, CODE_PROOF_TIME_CAP_FACTOR * Math.ceil(Math.max(0, slowestMs)));
}

// code-fastest ranks entries on CPU time in a timing heat after the final grades, so its proof sizes the inputs
// (server/proposals/code-setup/prove.ts): the generator takes a size (its house-written meta file, ./prompts.ts), and the
// prover grows it until the oracle's work over the final cases, net of the null entry's, clears server/proposals/
// checks.ts PACK_CPU_FLOOR_US, with every accepting run under half the one cap (CODE_PROOF_TIME_CAP_FACTOR), at the
// fewest final cases (CODE_PROOF_MIN_FINAL_CASES), the final's grades and the heat composed on them held to the
// grading-time ceiling at the bounty's own paid places (CODE_FASTEST_HEAT_PLACES when none is named). No size fitting is
// the failure `sizing`.

/** The least size the generator takes: inputs at about CODE_FASTEST_SIZE_MIN / CODE_FASTEST_SIZE_MAX of the brief's largest, never under its smallest. */
export const CODE_FASTEST_SIZE_MIN = 1;
/** The most size the generator takes: every input as large as the brief allows. A size is a whole number between the two. */
export const CODE_FASTEST_SIZE_MAX = 1_000;
/** Each step of the size's growth multiplies it by this, to CODE_FASTEST_SIZE_MAX at most: 1, 2, 4, ..., 512, then 1,000. */
export const CODE_FASTEST_SIZE_GROWTH = 2;
/**
 * The paid places the heat is held to the ceiling at when none is named: one, the fewest a bounty pays, whose heat is the
 * least any prize table composes (server/proposals/compose.ts heatContendersFloor: 8 contenders), about 19 s of caps over
 * 10 final cases at 48 grade lanes. The code setup's proof names the places its bounty's stored document pays
 * (server/proposals/code-setup/prove.ts CodeProveDeps.paidPlaces), so the heat it sizes the pack for is the one the
 * bundle's own ceiling gate (server/proposals/checks.ts) composes on those prizes when it lists; the record says which
 * (CodeProofRecord.priced).
 */
export const CODE_FASTEST_HEAT_PLACES = 1;

/** The sizes the prover tries, in order (CODE_FASTEST_SIZE_MIN, then each times CODE_FASTEST_SIZE_GROWTH, to CODE_FASTEST_SIZE_MAX). */
export function codeFastestSizes(): number[] {
  const out: number[] = [];
  for (let s = CODE_FASTEST_SIZE_MIN; ; s = Math.min(CODE_FASTEST_SIZE_MAX, s * CODE_FASTEST_SIZE_GROWTH)) {
    out.push(s);
    if (s >= CODE_FASTEST_SIZE_MAX) return out;
  }
}

// ---------------------------------------------------------------- the record

/** The proof record's format. */
export const CODE_PROOF_FORMAT = 'agent-fun/code-proof/v1';

/**
 * The programs the model writes for a proof: the oracle (its outputs the references), the generator (a plan in, one
 * input a case out), two validators written blind from the brief, the plain solver and the second solver (both from the
 * brief and its examples alone, as an entrant reads them), and the wrong programs.
 */
export const CODE_PROGRAM_ROLES = ['oracle', 'generator', 'validator-first', 'validator-second', 'solver-plain', 'solver-second', 'wrong'] as const;
export type CodeProgramRoleT = (typeof CODE_PROGRAM_ROLES)[number];
/** The roles a proof holds exactly one program of: every role but `wrong`. */
export const CODE_SINGLE_ROLES = CODE_PROGRAM_ROLES.filter((r): r is Exclude<CodeProgramRoleT, 'wrong'> => r !== 'wrong');

/** A wrong program's name, as packs.ts takes a wrong/<name> directory. */
export const CODE_WRONG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A model id as the house names one: server/config.ts AI_REVIEW_MODEL_RE (a bare id, no vendor/ prefix). */
export const CODE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;

/** What a kill was: the null entry, one of the trivial battery, or a written wrong program. */
export const CODE_KILL_KINDS = ['null', 'trivial', 'written'] as const;
/** What showed it wrong: the final cases as drawn (`suite`), or a case differential fuzzing found and swapped in (`fuzz`). */
export const CODE_KILL_BY = ['suite', 'fuzz'] as const;
/** The null entry's name in a kill. */
export const CODE_NULL_ENTRY_NAME = 'null-entry';
/** The trivial battery: echo the input, one constant, random bytes, the most common expected output, a table of the public cases. */
export const CODE_TRIVIAL_ENTRIES = ['echo', 'constant', 'random', 'common-output', 'public-table'] as const;

const Count = z.int().min(0);

/** One written program, by its digest: never its source. */
export const CodeProofProgram = z
  .strictObject({
    role: z.enum(CODE_PROGRAM_ROLES),
    /** A wrong program's name; null for every other role. */
    name: z.string().regex(CODE_WRONG_NAME_RE).nullable(),
    runtime: z.enum(CODE_PROOF_RUNTIMES),
    /** The model that wrote it. */
    model: z.string().regex(CODE_MODEL_ID_RE),
    /**
     * Its tree's digest (server/competitions/load.ts treeSha256): the tree the proof ran, so code-fastest's generator's
     * with the size it chose in its house-written meta file, the one the proof tree seals for the audit.
     */
    tree_sha256: Sha256Hex,
  })
  .superRefine((p, ctx) => {
    if ((p.role === 'wrong') !== (p.name !== null)) ctx.addIssue({ code: 'custom', path: ['name'], message: 'a wrong program has a name, and no other program does' });
  });

/**
 * One entry the final cases showed wrong. A written wrong program is counted only once it ran on every public example
 * (an output for each, inside the cap); `examples_passed` says whether it also answered every one as the brief gives
 * it (a fact for the desk, never a gate). Null for a house entry, which the public examples do not run. `points`, on a
 * written wrong program's kill in a code-score proof alone, is its total over the final cases as the pack holds them
 * (after any fuzz swap): the figure the spread (codeScoreSpreads) reads. A house entry's kill, every other kind's record
 * and a record written before it have none.
 */
export const CodeProofKill = z
  .strictObject({
    name: z.string().regex(CODE_WRONG_NAME_RE),
    kind: z.enum(CODE_KILL_KINDS),
    by: z.enum(CODE_KILL_BY),
    examples_passed: z.boolean().nullable(),
    points: z.int().min(0).max(CODE_PROOF_FULL_POINTS).optional(),
  })
  .superRefine((k, ctx) => {
    if ((k.kind === 'written') !== (k.examples_passed !== null)) ctx.addIssue({ code: 'custom', path: ['examples_passed'], message: 'a written wrong program says whether it passed the public examples, and no house entry does' });
  });

/** A passed proof's record (the header): what it found, by count and digest. */
export const CodeProofRecord = z
  .strictObject({
    format: z.literal(CODE_PROOF_FORMAT),
    proposal_id: z.string().min(1).max(128),
    objective: z.enum(PREPARED_CODE_KINDS),
    runtimes: z.array(z.enum(CODE_PROOF_RUNTIMES)).min(1),
    programs: z.array(CodeProofProgram).min(CODE_SINGLE_ROLES.length + 1),
    /** The draw: candidates generated, legal to both validators, kept (the three agreed), contested, final (hidden), public cases added. */
    draw: z.strictObject({ candidates: Count, legal: Count, kept: Count, contested: Count, final: Count, public_added: Count }),
    kills: z.array(CodeProofKill),
    /** One time cap for every case, and the slowest accepting run it was set over, whole ms. */
    time: z.strictObject({ cap_ms: z.int().min(1), slowest_accepting_ms: Count }),
    /**
     * code-fastest alone (and always there): the size the final cases were drawn at (the generator's, CODE_FASTEST_SIZE_*),
     * and the oracle's runs over them net of the null entry's, whole ms of wall time (the sandbox's batch clock: the
     * proof's estimate of the work buildPack's CPU pass then reads).
     */
    sizing: z.strictObject({ size: z.int().min(CODE_FASTEST_SIZE_MIN).max(CODE_FASTEST_SIZE_MAX), oracle_net_ms: Count }).optional(),
    /**
     * What the proof priced the grading-time ceiling at: the paid places its bounty's stored document paid (the last paid
     * place; code-fastest's timing heat is composed at them, every other kind runs none) and the grade-final lanes. Every
     * proof writes it; a record written before it was priced at CODE_FASTEST_HEAT_PLACES and the base manifest's 48 lanes
     * (server/competitions/grading-budget.ts GRADE_LANES). The setup's attach refuses a document paying other places
     * (server/proposals/code-setup/job.ts).
     */
    priced: z.strictObject({ paid_places: z.int().min(1), grade_lanes: z.int().min(1) }).optional(),
    /** House model calls and sandbox runs the setup made, every attempt counted. */
    spend: z.strictObject({ model_calls: Count, sandbox_runs: Count }),
    /** The pack's id (server/proposals/packs.ts: its record's blob name). */
    pack_id: Sha256Hex,
    /** The content look over the new public text, the hidden excerpt and the oracle's source. */
    look: z.enum(['allow', 'block']),
  })
  .superRefine((r, ctx) => {
    if (new Set(r.runtimes).size !== r.runtimes.length) ctx.addIssue({ code: 'custom', path: ['runtimes'], message: 'a runtime is listed twice' });
    if ((r.objective === 'code-fastest') !== (r.sizing !== undefined)) ctx.addIssue({ code: 'custom', path: ['sizing'], message: 'a code-fastest proof says the size its inputs were drawn at, and no other proof does' });
    for (const role of CODE_SINGLE_ROLES) {
      const n = r.programs.filter((p) => p.role === role).length;
      if (n !== 1) ctx.addIssue({ code: 'custom', path: ['programs'], message: `${n} ${role} programs: a proof holds exactly one` });
    }
    // A wrong program with no name is its own issue (CodeProofProgram), and this refinement still runs beside it.
    const wrong = r.programs.flatMap((p) => (p.role === 'wrong' && typeof p.name === 'string' ? [p.name] : []));
    if (wrong.length === 0) ctx.addIssue({ code: 'custom', path: ['programs'], message: 'no wrong program' });
    if (new Set(wrong.map((n) => n.toLowerCase())).size !== wrong.length) ctx.addIssue({ code: 'custom', path: ['programs'], message: 'a wrong program is named twice' });
    const d = r.draw;
    if (d.legal > d.candidates) ctx.addIssue({ code: 'custom', path: ['draw', 'legal'], message: 'more legal candidates than candidates' });
    if (d.kept + d.contested > d.legal) ctx.addIssue({ code: 'custom', path: ['draw', 'kept'], message: 'more kept and contested cases than legal candidates' });
    if (d.final + d.public_added > d.kept) ctx.addIssue({ code: 'custom', path: ['draw', 'final'], message: 'more final and public cases than kept cases' });
    const seen = new Set<string>();
    r.kills.forEach((k, i) => {
      const key = `${k.kind}\0${k.name.toLowerCase()}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['kills', i], message: `${k.name} is killed twice` });
      seen.add(key);
      const named =
        k.kind === 'null' ? k.name === CODE_NULL_ENTRY_NAME : k.kind === 'trivial' ? (CODE_TRIVIAL_ENTRIES as readonly string[]).includes(k.name) : wrong.some((n) => n.toLowerCase() === k.name.toLowerCase());
      if (!named) ctx.addIssue({ code: 'custom', path: ['kills', i, 'name'], message: `${k.name} is no ${k.kind === 'written' ? 'wrong program of this proof' : `${k.kind} entry`}` });
      if (k.points !== undefined && (r.objective !== 'code-score' || k.kind !== 'written')) ctx.addIssue({ code: 'custom', path: ['kills', i, 'points'], message: "a written wrong program's kill states its points on a code-score proof alone" });
    });
  });
export type CodeProofRecordT = z.infer<typeof CodeProofRecord>;

// ---------------------------------------------------------------- the sponsor's words

/**
 * What every sponsor surface says of a code setup's `proving` step (server/api-types/proposal.ts ProposalSelfSetupState):
 * one copy, with no full stop, so a list of step words takes it as it is and a sentence adds the stop ("make.fun is
 * checking the hidden tests it wrote."). Nothing emits `proving` until the code setup's views land.
 */
export const CODE_SETUP_PROVING_WORDS = 'make.fun is checking the hidden tests it wrote';
/** The `proving` step's short label, where a surface names a step in a few words. */
export const CODE_SETUP_PROVING_LABEL = 'Checking its tests';

// ---------------------------------------------------------------- the failures

/**
 * Each fail-closed reason's fixed words, as the setup row keeps them (proposal_judged_setup.failed_reason, at most
 * PROPOSAL_JUDGED_SETUP_REASON_MAX code points) and the desk reads them: one line, lower case, no full stop. None quotes a
 * program's error, an input, an output or the seed. A sandbox or model fault is no failure: the job tries it again.
 */
export const CODE_SETUP_FAILURES = Object.freeze({
  kind: 'its kind is not one make.fun prepares hidden tests for by itself',
  plan: 'its suggestion kept no examples and comparison to write the hidden tests from',
  written: 'the model did not write one of the programs within its bounds',
  examples: 'the reference solution or a solver did not answer the public examples as the brief gives them',
  validators: 'a validator refused a public example or took an input it was written to refuse',
  nondeterministic: 'the input generator wrote different inputs from the same seed',
  legal: 'under half the generated inputs were legal to both validators',
  contested: 'the reference solution and the two solvers disagreed on over a tenth of the legal inputs',
  class_contested: 'the reference solution and the two solvers disagreed on over half the inputs of one kind',
  too_few: 'too few hidden tests were agreed to make a pack',
  trivial: 'a trivial entry passed the hidden tests',
  wrong: 'too few of the wrong solutions failed the hidden tests',
  spread: 'the hidden tests gave the wrong solutions the same score',
  limits: 'a correct solution ran past the limits entries run under',
  ceiling: 'the hidden tests do not fit the time grading may take',
  sizing: 'no input size made the hidden tests heavy enough to time entries on and light enough for their time limit',
  pack: 'the pack the proof built did not pass its own check',
  look: 'the content look blocked the new public examples or the reference solution',
} as const);
export type CodeSetupFailureT = keyof typeof CODE_SETUP_FAILURES;
