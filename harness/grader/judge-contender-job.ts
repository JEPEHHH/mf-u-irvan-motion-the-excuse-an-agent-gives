// The judge-contender job (server/jobs.ts judge-contender): a judged bundle's one sealed dev contender chain
// (grader/judge-contender.ts, agent-fun/judge-contender/v1), played on the graders, sent by the provisional-rejudge
// sweep once a dev phase and 15-minute slot (sendContenderRound): a contend block's (contracts/competition.ts
// ProgramJudgeContend: the dev board's top `band` play one another, their ratings on the board), else a screened
// block's contender_games. createContenderRoundHandler's job, in order:
//
//   off        the competition carries no provisional verdicts (server/routes/admin/grading.ts
//              provisionalRejudgeTargetOf refuses it, blind rounds holding it among the reasons: its entries are
//              judged only in its rounds, never one on its own; or the job's phase is not its dev phase), its judge names no
//              contend block and is not screened, or is screened with contender_games 0, it names no ladder or no one
//              model (namedJudgeAgent), its dev seed is not one this job reads (a pack bundle's is its trees' digest),
//              or its judge directory or ladder does not read: nothing is played, and no retry mends it
//   closed     now is at or past the competition's deadline: the chain's head never moves then
//              (server/grading/contender-select.ts advanceContenderHead), so no round is played
//   the chain  the dev phase's head (contenderHeadOf) and the chain behind it, read as a final's screen reads it
//              (grader/worker.ts contenderChainOf: every record from the blob store back to round 0, each its canonical
//              JSON, of its round, held against the chain before it by judgeContenderHold), unless the fold of the head
//              the row names is kept (the fold memo: one object a head in the judge state's `heat-partials`
//              (judgeStateObjectsOf: off the data claim the blob tier's, so it outlives the grader's pod and every
//              grader reads it; on the claim a file at the work root), `judge-contender-partial-<phase>_<head
//              sha256>.json` (contenderFoldMemoKey), plain JSON {format, prev: the head record's prev, fold}; written
//              only from a chain contenderChainOf read and held, or from the round this job just held and linked, so it
//              is that chain's fold, and immutable: a head's fold never changes). With none kept of the head, the walk
//              back stops at the newest record one is kept of (asked beside each record's read: a record's `prev` names
//              the one before, so the records are read one after another) and holds only the records after it, onto
//              that fold: the same fold to the byte, as a fold is plain data and the hold reads nothing else. A phase
//              keeps its newest two: each memo kept drops the one two rounds back (and a walk's the one it read onto),
//              so a job that read the head just before the next memo landed still finds the one before. A memo that
//              cannot be kept or dropped is said, never thrown: the round is linked already, and a later job reads the
//              chain again
//     drained    before each round, a grader that drains (the pipeline's queue: GradeWorkerDeps.jobs `draining`, from
//                its drain's first step) plays no more: the round in hand ends, the job returns (never throws), and the
//                next sweep's job, by the phase's singleton key, lands on a live grader instead of this one's drain
//     broken     a chain that does not hold, or a head row that does not read: no round is played on it (the final's
//                screen leaves it out too), the job ends 'broken', and it is paged at most once a dev phase an hour
//                (BROKEN_PAGE_MS; the sweeps between log it), the page sealed. The head is moved only by this job,
//                after its record was stored, so either is the platform's: a lost or damaged blob, a hand-edited row
//   the judge  the chain's one judge (grader/judge-contender.ts judgeContenderJudgeOf): a screened chain's is always the
//              bundle's named model on its own door. A contend chain's is fixed at its round 0 (judgeAtRoundZero): the
//              judge the phase's dev heats are planned on then, as the judge planner (GradeWorkerDeps.judge.plan) answers
//              a provisional heat: the judge-overflow switch's judge on its door, its pin recorded, when the switch moves
//              all (share 100) of the contest's dev judging to it; else (no planner, the switch off or exempting the
//              contest, a share under 100, the overflow left out for want of a key or a pin) the bundle's named judge.
//              Round 0's record holds it (its `judges`, absent on the named judge), and every round after is judged by
//              it, whatever the switch does since: the round's pins read again for the endpoints it recorded (the
//              planner's resume, with `repin`: an endpoint gone from OpenRouter's list since round 0 is kept in its
//              place as recorded, and the round sent on those of them left, so the chain's judge and its requests'
//              provider.order stay round 0's). The job's log names which judge the chain fixed, on every round it plays.
//              Since the owner's order of 2026-11-17 (judging never dials superbot-router; every heat on OpenRouter
//              z-ai/glm-5.3-flash), the planner answers that judge alone for every contest, so a new contend chain
//              fixes it at round 0; a chain on the bundle's named judge off OpenRouter (every screened chain on a
//              router or masq model, a contend chain whose round 0 fixed the named judge, or one with no planner) is
//              deferred, never played on that judge
//   a round    up to every_sweep of them (the contend block's every_sweep, else contender_every_sweep), each built
//              afresh: the field (contenderFieldOf, its record memo one object a phase beside the fold memo,
//              `judge-contender-partial-<phase>_field.json` (contenderFieldMemoKey; contender-select.ts
//              contenderFieldMemoText), read at the job's first field and kept again whenever a field read loads or
//              drops a record, the records it lacks loaded CONTENDER_RECORD_READS at once;
//              only dev records judged by the chain's judge read: their `judges`, or none for the bundle's named model;
//              a record on another judge is no candidate, other_judge, and the board shows its house-only rate alone),
//              the players (contenderPlayersOf: a contend chain's its band by house-only dev win rate, no other path),
//              the round's setup (judgeContenderSetup: the bundle's judge and ladder, its design
//              (grader/judge-screen-inputs.ts contenderDesignOf: a contend block's games, its `top` as the line's
//              places, its band, z, phi_margin and epsilon the screened block's or PROGRAM_JUDGE_SCREENED_DEFAULTS';
//              else the screened block's as the final holds a chain to it, judgeContenderDesignOf), round and `prev`
//              from the chain, select from the field, as members only the players entering the chain or whose
//              snapshot changed (on a contend chain also every member still in the field whose snapshot changed, so
//              the board's ratings are fit on each artifact's current ladder record), the chain's own house text),
//              a contend round's band held as its record will be (judgeContenderPlayerIssues), then its schedule
//              (judgeContenderSchedule)
//     idle       the round is empty (under two players with games left, or none active): nothing is sent or recorded.
//                A player with no contender game is always active (judge-contender.ts's schedule), so a round with a
//                newcomer and another player with games left is never idle: the chain keeps admitting players
//     deferred   on a screened chain, the judge planner (GradeWorkerDeps.judge.plan, stage 'provisional', the round's
//                seed) answers a plan for an artifact the round judges, or cannot answer: the overflow switch would move
//                that judging off the bundle's own named judge, and a screened round is played on nothing else, so it
//                waits for a later sweep. A contend chain never defers on the switch (its round plays on the judge its
//                round 0 fixed): only when its judge cannot be had now (the planner cannot answer at round 0, or there
//                is none, or none of the overflow judge's recorded endpoints reads now). Said once a dev phase an hour
//     played     the pairs' artifacts read from their players' latest dev grade runs' action logs (readOutputFile);
//                on a dossier judge (a screened or a contend chain's, on the bundle's named judge or the overflow's),
//                a new chain of a contest with a judge view budget (server/judging/dossier-view-budget.ts
//                dossierViewBudgetOf, by the competition's slug) or one begun on judge views (its fold's judge names
//                the view policy: grader/judge-contender.ts's judge view) sends each of them as its judge view, as
//                grader/worker.ts plans a dossier heat: made once an artifact, budget and policy in this process
//                (server/judging/dossier-view.ts dossierJudgeViewAt at the contest's budget, a chain begun on views
//                whose contest now names none at DOSSIER_VIEW_ENTRY_TOKENS; under the policy the chain began on, one of
//                its judge constants, a new chain's its contest's dossierViewPolicyOf; its memos per handler),
//                stored as a blob in the grader's store before the round's first call, and named in the round's setup
//                (judge_view); a chain begun on whole dossiers, or a new one of a contest with no budget (null: its
//                dossiers judged whole), sends them whole to its end, and an artifact whose view cannot be made leaves
//                the round unplayed. Then the round played on the chain's judge (grader/worker.ts playContenderRound, handed the overflow judge's
//                plan when the chain is on it: no pool seat, as an all-OpenRouter heat; a named judge's contend round
//                keeps its 'practice' seat): its record stored as a blob, its calls kept
//                as they settle, so a retry asks only the calls still to come), then the head moved from the chain's
//                to it (tryAdvanceContenderHead) once its record holds against the chain (judgeContenderHold, as
//                contenderChainOf holds it). A contend round's move carries the board's ratings (contendBoardOf over
//                judgeContenderRatings of the chain with the round in: each member holding a contender game, its four
//                millionth figures and the ladder record its snapshot was read from), written in the head move's
//                transaction under its deadline guard (server/grading/contend-board.ts writeContendBoard), so a
//                round's ratings land once, with its head, and never after the deadline; ratings that do not fit
//                leave the record unlinked ('unplayed'). A move refused stops the job and leaves the record unlinked: no head
//                names it, so nothing ever reads it. The head's answer says why: at or past the deadline, by the
//                database's clock or this grader's, ends it 'closed' (a grader whose clock runs behind included);
//                another job moved the head first, or any other refusal, ends it 'unplayed'
//     unplayed   the round recorded nothing for a cause no retry mends (an unpriced judge model, too many calls with no
//                verdict, a setup the chain refuses, an artifact that no longer reads, a record that does not hold
//                against the chain, a field whose line is not the design's): the next sweep's job tries
//                afresh. A platform fault (a call that faulted again, no gateway) throws instead, so the job retries
//                from the calls kept
//
// Sealed (the owner's call: nothing serves a contender record, its sha256 or a figure derived from one before the
// deadline): every log line, the job's answer and every error it fails with carry counts only (the round, players,
// active players, games, calls) and the chain's judge's model, every sha256 masked; never a record's sha256 or a
// member's verdict, rating or rank.
// It writes no run, score, entry_artifact row or run.judge_heat_sha256: only the head row and the record blob, and on a
// contend chain the board's row (each rated artifact's four millionth figures and ladder record sha256, nothing else:
// no opponent, game, round count or head), besides its memos in the judge state (the graders' own namespace, which no
// route serves: the heats' partials beside them hold the same calls). A job
// that dies for good is paged by server/pipeline/index.ts with its phase, its round (contenderRoundOf) and the error;
// a broken chain is paged here (deps.page), never by throwing, so it pages once an hour, not every 15-minute sweep.
//
// It names a new harness_version (grader/version.ts sums every grader/ source).

import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { namedJudgeAgent, type ProgramHarnessT, type ProgramJudgeT } from '../contracts/competition.ts';
import { objectKeyProblem, type ObjectNamespace, type ObjectStore } from '../server/blob-tier/object-store.ts';
import { competition, phase } from '../server/db/schema.ts';
import type { ContendBoardRatingT } from '../server/grading/contend-board.ts';
import type { ContenderFieldMemoT, ContenderHeadRefusalT } from '../server/grading/contender-select.ts';
import { PermanentJobError, type JobContext, type JobPayload } from '../server/jobs.ts';
// No sharp loads with it: a view is made only through server/judging/dossier-view.ts, imported when one is.
import { DOSSIER_VIEW_DEFAULT_POLICY, DOSSIER_VIEW_ENTRY_TOKENS, dossierViewBudgetOf, dossierViewPolicyOf, type DossierViewPolicy } from '../server/judging/dossier-view-budget.ts';
import { JudgeDoorRefusal, judgeDoorOf, type JudgeOfHeatT } from '../server/judging/pool.ts';
import { JUDGE_OVERFLOW_MODEL } from '../server/ops/judge-overflow.ts';
import { canonicalJson, compareCodeUnits } from '../sim/canonical.ts';
import type { JudgeContenderFoldT, JudgeContenderLadderT, JudgeContenderMemberT, JudgeContenderRatingT, JudgeContenderSetupOptions } from './judge-contender.ts';
import type { JudgeHeatJudgeViewT, JudgePlannedCallT } from './judge-heat.ts';
import { readOutputFile } from './program.ts';
import {
  competitionDirOf,
  competitionSeedKey,
  contenderChainOf,
  judgeContenderLadderOf,
  judgedTreesOf,
  judgeStateObjectsOf,
  phaseSeed,
  playContenderRound,
  type ContenderChainWalk,
  type GradeWorkerDeps,
  type JudgeWorkerPlan,
  type JudgeWorkerPlanner,
} from './worker.ts';

/**
 * The judge planner as a contend chain resumes its judge (the header's the judge): server/judging/plan.ts resume with
 * `repin` (JudgeResumeOptions), which a planner of an older shape ignores, resuming strictly.
 */
type ChainPlanner = JudgeWorkerPlanner & { resume(judges: readonly JudgeOfHeatT[], options: { repin: true }): Promise<JudgeWorkerPlan> };

/** How a judge-contender job ended (the header): the reason its rounds stopped. */
export type ContenderJobEndedT = 'played' | 'idle' | 'off' | 'closed' | 'deferred' | 'unplayed' | 'broken' | 'drained';

/** A judge-contender job's answer: counts only (the header's sealed). */
export interface ContenderJobOutcome {
  phase_id: string;
  /** The rounds this job recorded and linked to the head. */
  rounds_played: number;
  ended: ContenderJobEndedT;
}

/**
 * What the job reads and plays through: the grade jobs' deps (the judge's broker, pool and planner among them; `page` a
 * broken chain's page, default console.error; `objects` the judge state its memos are kept in, judgeStateObjectsOf's
 * default; `jobs` the pipeline's queue, whose `draining` ends the job after the round in hand).
 */
export type ContenderJobDeps = Pick<GradeWorkerDeps, 'db' | 'blobs' | 'objects' | 'workRoot' | 'competitionDir' | 'judge' | 'log' | 'page' | 'now' | 'jobs'>;

/** The fold memo's format (the header's chain): a new one when what is kept of a fold changes (v2: off the pod, with the head's prev). */
const FOLD_MEMO_FORMAT = 'makefun/judge-contender-fold-memo/v2';

/** The judge state's namespace the memos are kept in (the header's chain): the heats' partials'. */
const MEMO_NS: ObjectNamespace = 'heat-partials';

/** How often a deferral is said, per dev phase (the header's deferred). */
const DEFERRED_SAY_MS = 3_600_000;

/** How long after a dev phase's broken chain was paged it is paged again while it stands (the header's broken). */
const BROKEN_PAGE_MS = 3_600_000;

/** Why a played round's record was left unlinked, by why the head refused to move to it (tryAdvanceContenderHead). */
const HEAD_REFUSED: Readonly<Record<ContenderHeadRefusalT, string>> = {
  closed: 'the deadline passed as it played',
  stale: 'another job moved the head first',
  round: "the head's round is not the one before this round",
  unread: "the head's row does not read",
  gone: 'its dev phase is gone',
};

/** The most judge views a handler keeps made (contenderViewsMade): every player of a round's field, and those met lately. */
const VIEW_MEMO = 256;

/** A judge view made from its artifact's bytes: its own sha256 and bytes (a dossier). */
export interface MadeView {
  sha256: string;
  bytes: Uint8Array;
}

/**
 * The judge view of a dossier round over `artifacts` (the header's played) at an entry budget of `entryTokens` (the
 * contest's, dossierViewBudgetOf; default DOSSIER_VIEW_ENTRY_TOKENS) under `policy` (the chain's; default
 * DOSSIER_VIEW_DEFAULT_POLICY, v1): each artifact's view made once a handler (`memo`, the handler's memo of that budget
 * and policy, by the artifact's sha256, the oldest dropped past VIEW_MEMO) and stored in `blobs`, each put held to its
 * sha256, the view naming `policy`; `unmade`, counting them, when a view cannot be made (bytes that are no dossier, an
 * image sharp cannot decode).
 */
export async function contenderViewsMade(
  blobs: Pick<ContenderJobDeps['blobs'], 'put'>,
  artifacts: ReadonlyMap<string, Uint8Array>,
  memo: Map<string, Promise<MadeView>>,
  entryTokens: number = DOSSIER_VIEW_ENTRY_TOKENS,
  policy: DossierViewPolicy = DOSSIER_VIEW_DEFAULT_POLICY,
): Promise<{ view: JudgeHeatJudgeViewT } | { unmade: number; why: string }> {
  const views: Record<string, string> = {};
  let unmade = 0;
  let why = '';
  for (const [sha256, bytes] of [...artifacts].sort((x, y) => compareCodeUnits(x[0], y[0]))) {
    let made = memo.get(sha256);
    if (made !== undefined) {
      memo.delete(sha256);
      memo.set(sha256, made);
    } else {
      const making = (async (): Promise<MadeView> => {
        const { dossierJudgeViewAt } = await import('../server/judging/dossier-view.ts');
        const v = await dossierJudgeViewAt(bytes, entryTokens, policy);
        return { sha256: v.sha256, bytes: v.view };
      })();
      made = making;
      memo.set(sha256, making);
      // A view that could not be made is not kept: the next round tries again.
      making.catch(() => {
        if (memo.get(sha256) === making) memo.delete(sha256);
      });
      while (memo.size > VIEW_MEMO) memo.delete(memo.keys().next().value!);
    }
    let view: MadeView;
    try {
      view = await made;
    } catch (err) {
      unmade++;
      why ||= err instanceof Error ? err.message : String(err);
      continue;
    }
    const put = await blobs.put(view.bytes);
    if (put.sha256 !== view.sha256) throw new Error(`a player's judge view stored as ${put.sha256}, not ${view.sha256}`);
    views[sha256] = view.sha256;
  }
  return unmade > 0 ? { unmade, why } : { view: { policy, views } };
}

/** The handler's memo key of the views made at `entryTokens` under `policy` (the header's played): one memo each. */
export const contenderViewMemoKey = (entryTokens: number, policy: DossierViewPolicy): string => `${policy}:${entryTokens}`;

/** The round each error a job failed with was on (contenderRoundOf). */
const roundOfError = new WeakMap<object, number>();

/**
 * The round a judge-contender job's error was thrown on (the round it was setting up or playing), or null when it was
 * thrown before a round was set up (its chain, its trees) or is no error of the job's.
 */
export function contenderRoundOf(err: unknown): number | null {
  return typeof err === 'object' && err !== null ? (roundOfError.get(err) ?? null) : null;
}

/** `text` with every sha256 in it masked (the header's sealed). */
export function contenderSealedText(text: string): string {
  return text.replace(/[0-9a-f]{64}/gi, '(sha256)');
}

/**
 * `err` as the job fails with it (the header's sealed): itself when its message names no sha256, else an error of its
 * kind (a PermanentJobError stays one, so it still dead-letters) with the message masked and no cause, so neither
 * pg-boss's stored error nor a page carries one. An abort's reason passes as it is.
 */
function sealedError(err: unknown): unknown {
  if (!(err instanceof Error)) return new Error(contenderSealedText(String(err)));
  if (!/[0-9a-f]{64}/i.test(`${err.message}\n${err.stack ?? ''}`)) return err;
  const text = contenderSealedText(err.message);
  const out = err instanceof PermanentJobError ? new PermanentJobError(text) : new Error(text);
  out.stack = `${out.name}: ${text}`;
  return out;
}

/**
 * A dev phase's memo object `name` (the header's chain: `_<head sha256>`, a fold; `_field`, the field's) in the judge
 * state's `heat-partials` namespace: `judge-contender-partial-<phase, lowercase>_<name>.json`, one name at the work root
 * (server/blob-tier/object-store.ts HEAT_PARTIAL_KEY), beside the phase's round partial (judgeContenderPartialPath)
 * and never that name. RangeError on a phase id or name no key is made of.
 */
export function contenderMemoKey(phaseId: string, name: string): string {
  const key = `judge-contender-partial-${phaseId.toLowerCase()}_${name}.json`;
  const problem = objectKeyProblem(MEMO_NS, key);
  if (problem !== undefined) throw new RangeError(`dev phase ${phaseId}'s contender memo ${name} has no ${MEMO_NS} key: ${problem}`);
  return key;
}

/** The fold memo's key of head `sha256` (contenderMemoKey). */
export const contenderFoldMemoKey = (phaseId: string, sha256: string): string => contenderMemoKey(phaseId, sha256);

/** The field memo's key (contenderMemoKey). */
export const contenderFieldMemoKey = (phaseId: string): string => contenderMemoKey(phaseId, 'field');

/** The text of memo `key`, or null with no object under it. A store fault is thrown: a retry may mend it. */
async function memoText(objects: ObjectStore, key: string): Promise<string | null> {
  const got = await objects.get(MEMO_NS, key);
  return got === undefined ? null : new Response(got.stream).text();
}

/** A fold memo as kept (the header's chain): the fold, and its head record's `prev` (null: round 0's, or not known). */
interface FoldMemo {
  fold: JudgeContenderFoldT;
  prev: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The fold kept for head `sha256` at `round`, or null with none that reads (missing, torn, another format, another head's). */
async function readFoldMemo(objects: ObjectStore, phaseId: string, sha256: string, round: number): Promise<FoldMemo | null> {
  const text = await memoText(objects, contenderFoldMemoKey(phaseId, sha256));
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as { format?: unknown; prev?: unknown; fold?: JudgeContenderFoldT };
    if (raw.format !== FOLD_MEMO_FORMAT || raw.fold === undefined || raw.fold === null || raw.fold.head_sha256 !== sha256 || raw.fold.round !== round) return null;
    if (raw.prev !== null && !(typeof raw.prev === 'string' && SHA256_HEX.test(raw.prev))) return null;
    return { fold: raw.fold, prev: raw.prev };
  } catch {
    return null;
  }
}

/**
 * Keep `memo` under its head (the header's chain), whole or not at all (the store's put: a temp renamed over its name,
 * or one PUT), then drop the fold memo of the round two back (`drop`: the prev of the fold memo this one follows), so a
 * phase keeps its newest two: the one before stays for a job that read the head just before this one was written. A
 * fault is said, never thrown: the round it follows is linked already, and a later job reads the chain again.
 */
async function keepFoldMemo(objects: ObjectStore, phaseId: string, memo: FoldMemo, drop: string | null, say: (line: string) => void): Promise<void> {
  try {
    await objects.put(MEMO_NS, contenderFoldMemoKey(phaseId, memo.fold.head_sha256), `${JSON.stringify({ format: FOLD_MEMO_FORMAT, prev: memo.prev, fold: memo.fold })}\n`);
  } catch (err) {
    say(`the fold of round ${memo.fold.round} was not kept (${ioWhyOf(err)}): a later job reads the chain again`);
    return;
  }
  if (drop === null || drop === memo.fold.head_sha256 || drop === memo.prev) return;
  try {
    await objects.delete(MEMO_NS, contenderFoldMemoKey(phaseId, drop));
  } catch (err) {
    say(`an older round's kept fold was not dropped (${ioWhyOf(err)})`);
  }
}

/** The field memo kept for the phase (contender-select.ts contenderFieldMemoOf), or an empty one with none that reads. */
async function readFieldMemo(objects: ObjectStore, phaseId: string): Promise<ContenderFieldMemoT> {
  const { contenderFieldMemoOf } = await import('../server/grading/contender-select.ts');
  const text = await memoText(objects, contenderFieldMemoKey(phaseId));
  return (text === null ? null : contenderFieldMemoOf(text)) ?? new Map();
}

/** Keep the phase's field memo (contenderFieldMemoText) whole; a fault is said, never thrown: the next read loads its records again. */
async function keepFieldMemo(objects: ObjectStore, phaseId: string, memo: ContenderFieldMemoT, say: (line: string) => void): Promise<void> {
  const { contenderFieldMemoText } = await import('../server/grading/contender-select.ts');
  try {
    await objects.put(MEMO_NS, contenderFieldMemoKey(phaseId), contenderFieldMemoText(memo));
  } catch (err) {
    say(`the field's records were not kept (${ioWhyOf(err)}): the next read loads them again`);
  }
}

/** Why a store call failed, in a log's words: its errno or code when it has one, else its message (sealed by the log). */
function ioWhyOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The dev phase's chain as the job extends it (the header's chain): the fold kept for the head the row names, or else
 * the chain read as a final's screen reads it (grader/worker.ts contenderChainOf), from the newest record a fold is
 * kept of (only the records after it read and held onto it; with none, back to round 0), and its fold kept under its
 * head. `{ fold: null }` with no head; `{ broken }`, saying why (every sha256 masked), when the chain does not hold or
 * its head's row does not read. A database or store fault on a read is thrown: a retry may mend it.
 */
async function chainOf(
  deps: Pick<ContenderJobDeps, 'db' | 'blobs'>,
  objects: ObjectStore,
  phaseId: string,
  say: (line: string) => void,
): Promise<{ fold: JudgeContenderFoldT | null; prev: string | null } | { broken: string }> {
  const { contenderHeadOf } = await import('../server/grading/contender-select.ts');
  let head: Awaited<ReturnType<typeof contenderHeadOf>> = null;
  try {
    head = await contenderHeadOf(deps.db, phaseId);
  } catch (err) {
    // A head row that does not read: contenderChainOf says so, as a final reads it.
    if (!(err instanceof TypeError)) throw err;
  }
  if (head !== null) {
    const kept = await readFoldMemo(objects, phaseId, head.head_sha256, head.round);
    if (kept !== null) return kept;
  }
  const walk: ContenderChainWalk = { records: 0, head_prev: null, from: null };
  const chain = await contenderChainOf(deps, phaseId, { kept: async (sha, round) => (await readFoldMemo(objects, phaseId, sha, round))?.fold ?? null, walk });
  if ('broken' in chain) return { broken: contenderSealedText(chain.broken) };
  if ('none' in chain) return { fold: null, prev: null };
  say(`the chain read to round ${chain.fold.round}: ${walk.records} records read, ${walk.from === null ? 'from round 0 (no fold kept of any)' : `onto the fold kept of round ${walk.from.round}`}`);
  // A fold another job kept of the head as this one read it is kept already.
  if (walk.from?.head_sha256 === chain.fold.head_sha256) return { fold: chain.fold, prev: null };
  // The fold read onto is dropped once this one is kept, unless it is the head's prev (the newest two stay).
  await keepFoldMemo(objects, phaseId, { fold: chain.fold, prev: walk.head_prev }, walk.from?.head_sha256 ?? null, say);
  return { fold: chain.fold, prev: walk.head_prev };
}

/**
 * A contend round's board ratings (server/grading/contend-board.ts ContendBoardRating) from the chain with the round in
 * and its judgeContenderRatings: one a member holding a contender game, its four millionth figures, its artifact and the
 * ladder record its snapshot was read from (the one the fit counted its house games from), nothing else of the chain.
 */
export function contendBoardOf(fold: Pick<JudgeContenderFoldT, 'members'>, ratings: ReadonlyMap<string, JudgeContenderRatingT>): ContendBoardRatingT[] {
  const recordOf = new Map(fold.members.map((m) => [m.artifact_sha256, m.ladder_record_sha256]));
  return [...ratings.values()].map((r) => {
    const ladder = recordOf.get(r.artifact_sha256);
    if (ladder === undefined) throw new RangeError('a rating names no member of the chain');
    return {
      artifact_sha256: r.artifact_sha256,
      ladder_record_sha256: ladder,
      win_rate_micro: r.win_rate_micro,
      se_micro: r.se_micro,
      interval_low_micro: r.interval_low_micro,
      interval_high_micro: r.interval_high_micro,
    };
  });
}

/**
 * The judge a contend chain's round 0 fixes (the header's the judge): the judge the phase's dev heats are planned on
 * now, as the judge planner answers a provisional heat (`ask`: the contest, the bundle's judge block, the dev heats'
 * seed and a subject). Its plan (the overflow judge and its pin) when that answer is the judge-overflow switch's judge
 * alone at share 100 (server/judging/pool.ts effectiveJudges: the overflow judge then the whole pool, at weight 100), so
 * every dev heat is planned on it whatever its artifact; null, the bundle's named judge, with no planner, no plan (the
 * bundle's own judge), a share under 100 (the dev heats split between the two), or any other answer. `{ unanswered }`
 * when the planner cannot answer now (a JudgePlanFault, retryable); anything else it throws is thrown. The planner
 * answers OpenRouter's one judge alone at weight 100 for every contest since 2026-11-17 (server/judging/plan.ts), so a
 * new chain is fixed on it; null now only with no planner, and the job then defers the chain.
 */
export async function judgeAtRoundZero(
  planner: Pick<JudgeWorkerPlanner, 'of'> | undefined,
  ask: { slug: string; agent: ProgramJudgeT['agent']; seed: string; subject: string },
): Promise<{ plan: JudgeWorkerPlan | null } | { unanswered: string }> {
  if (planner === undefined) return { plan: null };
  let answer: JudgeWorkerPlan | null;
  try {
    answer = await planner.of({ slug: ask.slug, stage: 'provisional', judge: ask.agent, seed: ask.seed, subject: ask.subject });
  } catch (err) {
    if ((err as { retryable?: unknown } | null)?.retryable !== true) throw err;
    return { unanswered: err instanceof Error ? err.message : String(err) };
  }
  if (answer === null || answer.judges.length !== 1) return { plan: null };
  const one = answer.judges[0]!;
  const pin = answer.pins[0] ?? null;
  if (one.via !== 'overflow' || one.door !== 'openrouter' || one.weight !== 100 || one.provider === undefined || pin === null) return { plan: null };
  return { plan: { judges: [one], pins: [pin] } };
}

/** The snapshot fields a member is held to between rounds (judge-contender.ts's continuity rule), as one comparable string. */
function snapshotKey(m: Pick<JudgeContenderMemberT, 'artifact_sha256' | 'artifact_bytes' | 'entries' | 'ladder_record_sha256' | 'ladder_games'>): string {
  return JSON.stringify([m.artifact_sha256, m.artifact_bytes, [...m.entries].sort(compareCodeUnits), m.ladder_record_sha256, m.ladder_games.map((g) => [g.b, g.a_points])]);
}

/**
 * The judge-contender job's handler (the header): `deps` the grade jobs' (its judge's broker, pool and planner). Its
 * answer carries counts only; a platform fault is thrown (the job retries from the calls kept), with its round
 * (contenderRoundOf) and sealed. A chain that does not hold ends the job 'broken', paged at most once an hour a phase.
 */
export function createContenderRoundHandler(deps: ContenderJobDeps): (data: JobPayload<'judge-contender'>, ctx: Pick<JobContext, 'id'> & Partial<Pick<JobContext, 'signal'>>) => Promise<ContenderJobOutcome> {
  const log = (line: string): void => (deps.log ?? ((l: string) => console.log(l)))(contenderSealedText(line));
  const page = (line: string): void => (deps.page ?? ((l: string) => console.error(l)))(contenderSealedText(line));
  const now = deps.now ?? (() => new Date());
  /** When each dev phase's deferral was last said (the header's deferred). */
  const deferredSaid = new Map<string, number>();
  /** When each dev phase's broken chain was last paged (the header's broken). */
  const brokenPaged = new Map<string, number>();
  /**
   * Each artifact's judge view made by this handler (the header's played: contenderViewsMade), one memo an entry budget
   * and policy, so a v1 and a v2 view of one artifact never share one.
   */
  const viewMemos = new Map<string, Map<string, Promise<MadeView>>>();
  const viewMemoOf = (entryTokens: number, policy: DossierViewPolicy): Map<string, Promise<MadeView>> => {
    const key = contenderViewMemoKey(entryTokens, policy);
    let memo = viewMemos.get(key);
    if (memo === undefined) viewMemos.set(key, (memo = new Map()));
    return memo;
  };

  return async (data, ctx) => {
    const phaseId = data.phase_id.toLowerCase();
    const end = (rounds_played: number, ended: ContenderJobEndedT): ContenderJobOutcome => ({ phase_id: phaseId, rounds_played, ended });
    const [row] = await deps.db
      .select({ comp: competition })
      .from(phase)
      .innerJoin(competition, eq(competition.id, phase.competitionId))
      .where(and(eq(phase.id, phaseId), eq(phase.key, 'dev')));
    if (row === undefined) {
      log(`[contender] dev phase ${phaseId}: no such dev phase, so no contender round is played`);
      return end(0, 'off');
    }
    const comp = row.comp;
    const say = (line: string): void => log(`[contender] ${comp.slug} dev phase ${phaseId}: ${line}`);
    const { provisionalRejudgeTargetOf } = await import('../server/routes/admin/grading.ts');
    const target = await provisionalRejudgeTargetOf(deps.db, comp);
    if ('refused' in target || target.dev.id.toLowerCase() !== phaseId) {
      say(`off: ${'refused' in target ? target.refused : 'it is not the competition\'s dev phase'}`);
      return end(0, 'off');
    }
    const judge: ProgramJudgeT = target.judge;
    const screened = judge.screened;
    // A contend block (ProgramJudgeContend) plays the phase's one chain; else a screened block's contender_games does.
    const contend = judge.contend;
    const harness = target.bundle.harness as ProgramHarnessT;
    const off =
      contend === undefined && screened === undefined
        ? 'its judge is not screened (harness.judge.screened)'
        : contend === undefined && screened!.contender_games === 0
          ? 'contender_games is 0'
          : judge.ladder === undefined
            ? 'its judge names no ladder'
            : namedJudgeAgent(judge.agent) === null
              ? 'its judge names no one model'
              : harness.pack !== undefined || harness.generator !== undefined
                ? "its dev phase is seeded on its pack's or instance's trees, which this job does not read"
                : null;
    if (off !== null) {
      say(`off: ${off}`);
      return end(0, 'off');
    }
    if (now().getTime() >= comp.deadline.getTime()) {
      say('closed: the deadline has passed, so the chain is not extended');
      return end(0, 'closed');
    }
    // The dev phase's seed, as its grades are seeded: a bundle with data of its own seeds on no dataset digest.
    const devSeed = phaseSeed(competitionSeedKey(comp), 'dev', null);
    // The bundle's judge directory and ladder, read as a provisional heat reads them.
    let ladder: JudgeContenderLadderT;
    try {
      const trees = await judgedTreesOf(deps, comp.slug, harness, judge);
      const { readJudgeLadder } = await import('./judge-ladder-tree.ts');
      const rel = judge.ladder!.dir;
      const ladderDir = trees.ladderDir ?? (rel === '.' ? competitionDirOf(deps, comp.slug, harness) : join(competitionDirOf(deps, comp.slug, harness), ...rel.split('/')));
      const read = readJudgeLadder(ladderDir, judge, trees.judgeDir);
      if ('refused' in read) {
        say(`off: its judge's ladder does not read: ${read.refused}`);
        return end(0, 'off');
      }
      ladder = judgeContenderLadderOf(read);
    } catch (err) {
      if (!(err instanceof PermanentJobError)) throw sealedError(err);
      say(`off: ${err.message}`);
      return end(0, 'off');
    }
    const cs = await import('../server/grading/contender-select.ts');
    const jc = await import('./judge-contender.ts');
    const jh = await import('./judge-heat.ts');
    const { contenderDesignOf } = await import('./judge-screen-inputs.ts');
    let round: number | null = null;
    let played = 0;
    /** The chain's overflow judge on its pins (null: none read yet, or the chain is on the bundle's named judge). */
    let chainPlan: JudgeWorkerPlan | null = null;
    /** End the job 'deferred' before round `r` is played, said once a dev phase an hour (the header's deferred). */
    const defer = (r: number, why: string): ContenderJobOutcome => {
      const hour = Math.floor(now().getTime() / DEFERRED_SAY_MS);
      if (deferredSaid.get(phaseId) !== hour) {
        deferredSaid.set(phaseId, hour);
        say(`round ${r} deferred: ${why}`);
      }
      return end(played, 'deferred');
    };
    try {
      // The judge state the memos are kept in: off the claim the blob tier's, so a fresh grader reads what another kept.
      const objects = await judgeStateObjectsOf(deps);
      const chain = await chainOf(deps, objects, phaseId, say);
      if ('broken' in chain) {
        const t = now().getTime();
        const last = brokenPaged.get(phaseId);
        if (last === undefined || t - last >= BROKEN_PAGE_MS) {
          brokenPaged.set(phaseId, t);
          page(
            `[contender] ALERT: ${comp.slug} dev phase ${phaseId}: its sealed contender chain does not hold (${chain.broken}), so no contender round is played on it, ` +
              "and the final's screen leaves it out (every member rated on its ladder record alone). " +
              'Fix: restore the record the blob store lost or the head row that does not read; the sweep after that reads the chain again. Paged at most once an hour while it stands',
          );
        } else say(`broken: its contender chain does not hold (${chain.broken}), so no round is played on it (paged within the hour)`);
        return end(0, 'broken');
      }
      let fold: JudgeContenderFoldT | null = chain.fold;
      /** The fold's head record's `prev` (null: round 0's, or not known), the fold memo to drop once the next is kept. */
      let foldPrev: string | null = chain.prev;
      /** The field's record memo (the header's a round), read from the judge state at the job's first field. */
      let fieldMemo: ContenderFieldMemoT | null = null;
      // The bundle's contender design (judge-screen-inputs.ts contenderDesignOf): a contend block's, else the screened
      // block's as the final's screen holds the chain to it (judgeScreenContenderOf).
      const design = contenderDesignOf(judge, target.bundle.prizes)!;
      const everySweep = contend !== undefined ? contend.every_sweep : screened!.contender_every_sweep;
      for (let k = 0; k < everySweep; k++) {
        ctx.signal?.throwIfAborted();
        // A draining grader plays no round after the one in hand (the header's drained): the next sweep's job, sent by
        // the phase's singleton key, lands on a live grader instead of waiting out this one's drain.
        if (deps.jobs?.draining === true) {
          say(`drained after ${played} rounds: this grader drains, so the next sweep's job plays on`);
          return end(played, 'drained');
        }
        if (now().getTime() >= comp.deadline.getTime()) {
          say(`closed after ${played} rounds: the deadline has passed`);
          return end(played, 'closed');
        }
        round = fold === null ? 0 : fold.round + 1;
        const r = round;
        // The chain's judge (the header's the judge): the one its round 0 fixed (the fold's `judges`, none: the bundle's
        // named model), else, at a contend chain's round 0, the judge the dev heats are planned on now.
        let judges: JudgeOfHeatT[] | undefined = fold?.judge.judges;
        if (fold === null && contend !== undefined) {
          const fixed = await judgeAtRoundZero(deps.judge?.plan, { slug: comp.slug, agent: judge.agent, seed: jh.judgeHeatSeed(devSeed, jh.JUDGE_HEAT_FORMAT_V3), subject: jc.judgeContenderSeed(devSeed) });
          if ('unanswered' in fixed) return defer(r, `the judge planner could not say which judge the dev heats are planned on (${fixed.unanswered}), and round 0 fixes the chain's judge by it`);
          chainPlan = fixed.plan;
          judges = fixed.plan === null ? undefined : fixed.plan.judges;
        }
        if (judges !== undefined && (chainPlan === null || canonicalJson(chainPlan.judges) !== canonicalJson(judges))) {
          // The chain's overflow judge on its pins, read again for the endpoints round 0 recorded (plan.ts resume).
          const planner = deps.judge?.plan;
          if (planner === undefined) return defer(r, `the chain's judge ${judges[0]!.model} was fixed at round 0, and this process has no judge planner to dial it`);
          try {
            // Re-pinned when an endpoint round 0 recorded has left OpenRouter's list (plan.ts resume's repin): the
            // round is sent on those left of them, its judges as recorded, so the chain holds and its requests rebuild.
            chainPlan = await (planner as ChainPlanner).resume(judges, { repin: true });
          } catch (err) {
            if ((err as { retryable?: unknown } | null)?.retryable !== true) throw err;
            return defer(r, `the chain's judge ${judges[0]!.model}, fixed at round 0, cannot be dialled now (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        // A chain on the bundle's named judge (a screened chain's always; a contend chain whose round 0 fixed no plan) plays
        // only when that judge is on OpenRouter: judging never dials superbot-router, and every judge heat is played on
        // OpenRouter's one judge (the owner's order, 2026-11-17), which a chain fixed on another judge cannot take.
        if (judges === undefined) {
          const named = namedJudgeAgent(judge.agent)!.model;
          let door: string;
          try {
            door = judgeDoorOf(named);
          } catch (err) {
            if (!(err instanceof JudgeDoorRefusal)) throw err;
            door = 'no door';
          }
          if (door !== 'openrouter') {
            return defer(
              r,
              `the chain's judge is the bundle's named ${named} (on ${door})${fold === null ? '' : ', fixed at its round 0'}, and judging never dials superbot-router: ` +
                `every judge heat is played on OpenRouter ${JUDGE_OVERFLOW_MODEL} (the owner's order, 2026-11-17), so no round of it is played`,
            );
          }
        }
        const judgeWords = judges === undefined ? `the bundle's named judge ${namedJudgeAgent(judge.agent)!.model}` : `the overflow judge ${judges[0]!.model} on OpenRouter`;
        // Who plays: the field as it stands now (records judged by the chain's judge alone), its players, and those
        // entering the chain or changed since.
        fieldMemo ??= await readFieldMemo(objects, phaseId);
        const memoHeld = fieldMemo.size;
        const field = await cs.contenderFieldOf(deps.db, deps.blobs, target, {
          memo: fieldMemo,
          phaseSeed: devSeed,
          ...(judges === undefined ? {} : { judge: { model: judges[0]!.model, door: judges[0]!.door } }),
        });
        // Kept again when this read loaded a record or dropped one: the field's records, read once a phase.
        if (field.records_read > 0 || fieldMemo.size < memoHeld) await keepFieldMemo(objects, phaseId, fieldMemo, say);
        if (field.line_places !== design.line_places) {
          say(`round ${r} unplayed: the field reads its line at ${field.line_places} places, not the design's ${design.line_places}`);
          return end(played, 'unplayed');
        }
        const { select, players } = cs.contenderPlayersOf(field, ladder.strengths);
        const known = new Map((fold?.members ?? []).map((m) => [m.artifact_sha256, snapshotKey(m)]));
        // A contend chain also refreshes every member still in the field whose ladder record moved, player or not, so
        // each rating it puts on the board is fit on the ladder record the board shows the artifact by.
        const listed = contend === undefined ? players : field.candidates.filter((c) => known.has(c.artifact_sha256) || players.some((p) => p.artifact_sha256 === c.artifact_sha256));
        const members: JudgeContenderMemberT[] = listed
          .filter((p) => known.get(p.artifact_sha256) !== snapshotKey({ ...p.snapshot, artifact_bytes: p.artifact_bytes, entries: p.entries, ladder_record_sha256: p.ladder_record_sha256 }))
          .map((p) => ({ artifact_sha256: p.artifact_sha256, artifact_bytes: p.artifact_bytes, entries: p.entries, ladder_record_sha256: p.ladder_record_sha256, ladder_games: p.snapshot.ladder_games }));
        let setup: ReturnType<typeof jc.judgeContenderSetup>;
        let planned: JudgePlannedCallT[];
        let active: number;
        const setupOptions: JudgeContenderSetupOptions = {
          phaseSeed: devSeed,
          judge,
          ...(fold === null ? {} : { house: fold.judge.house_text }),
          ...(judges === undefined ? {} : { judges }),
          ladder,
          design,
          round: r,
          prev: fold?.head_sha256 ?? null,
          lineMicro: select.line_micro,
          ...(select.band_edge === undefined ? {} : { bandEdge: select.band_edge }),
          members,
          players: players.map((p) => p.artifact_sha256),
        };
        try {
          setup = jc.judgeContenderSetup(setupOptions);
          // A contend round's band, held as its record will be before a call is spent (judgeContenderPlayerIssues).
          if (contend !== undefined) {
            const issues = jc.judgeContenderPlayerIssues(fold, setup);
            if (issues.length > 0) throw new jh.JudgeHeatError(`its band does not hold: ${issues.slice(0, 3).join('; ')}`);
          }
          const schedule = jc.judgeContenderSchedule(fold, setup);
          planned = schedule.planned;
          active = schedule.active.length;
        } catch (err) {
          if (!(err instanceof jh.JudgeHeatError)) throw err;
          say(`round ${r} unplayed: its setup does not follow the chain or the bundle (${err.message})`);
          return end(played, 'unplayed');
        }
        const counts = `${setup.players.length} players (${members.length} entering or changed), ${active} active`;
        if (planned.length === 0) {
          say(`round ${r} idle: ${counts}, no pair to judge`);
          return end(played, 'idle');
        }
        const artifacts = [...new Set(planned.flatMap((p) => [p.a, p.b]))].sort(compareCodeUnits);
        // A screened chain's round is played on the bundle's own named judge alone: a plan for any artifact the round
        // judges defers it. A contend chain's plays on the judge its round 0 fixed, whatever the switch says now.
        const plan = contend === undefined ? deps.judge?.plan : undefined;
        if (plan !== undefined) {
          let moved: string | null = null;
          for (const subject of artifacts) {
            let answer: JudgeWorkerPlan | null;
            try {
              answer = await plan.of({ slug: comp.slug, stage: 'provisional', judge: judge.agent, seed: setup.seed, subject });
            } catch (err) {
              if ((err as { retryable?: unknown } | null)?.retryable !== true) throw err;
              moved = `the judge planner could not answer (${err instanceof Error ? err.message : String(err)})`;
              break;
            }
            if (answer !== null) {
              moved = `the judge planner moves its judging to ${answer.judges.map((j) => j.model).join(', ')}`;
              break;
            }
          }
          if (moved !== null) return defer(r, `${moved}, and a contender round is judged only by the bundle's own named judge`);
        }
        // The pairs' artifacts, read from their players' latest dev grade runs.
        const bytes = await artifactsOf(deps, target.dev.id, judge, players, artifacts);
        if ('missing' in bytes) {
          say(`round ${r} unplayed: ${bytes.missing}`);
          return end(played, 'unplayed');
        }
        // A dossier round on a new chain of a contest with a view budget, or on one begun on views: each artifact its
        // calls carry sent as its judge view (the header's played), the setup naming them; its schedule is the one planned
        // above, which no view moves. A new chain of a contest with none (dossierViewBudgetOf null) sends them whole.
        const viewBudget = judge.media === 'dossier' ? dossierViewBudgetOf(comp.slug) : null;
        if (judge.media === 'dossier' && (fold === null ? viewBudget !== null : fold.judge.judge_view !== undefined)) {
          const entryTokens = viewBudget ?? DOSSIER_VIEW_ENTRY_TOKENS;
          // The chain's policy, one of its judge constants: a chain begun on v1 views keeps them whatever its contest
          // names now (a moved constant would break it); a new chain takes its contest's.
          const policy = fold?.judge.judge_view ?? dossierViewPolicyOf(comp.slug);
          const made = await contenderViewsMade(deps.blobs, bytes.artifacts, viewMemoOf(entryTokens, policy), entryTokens, policy);
          if ('unmade' in made) {
            say(`round ${r} unplayed: the judge views of ${made.unmade} of the round's ${artifacts.length} players' ${judge.artifact} could not be made (${made.why})`);
            return end(played, 'unplayed');
          }
          try {
            setup = jc.judgeContenderSetup({ ...setupOptions, view: made.view });
          } catch (err) {
            if (!(err instanceof jh.JudgeHeatError)) throw err;
            say(`round ${r} unplayed: its setup on judge views does not hold (${err.message})`);
            return end(played, 'unplayed');
          }
        }
        // A contend chain's round 0 fixes its judge (named here, as on every round after): the overflow judge when the
        // switch moved all of the contest's dev judging to it, else the bundle's named judge.
        if (contend !== undefined && r === 0) say(`round 0 fixes the chain's judge: ${judgeWords}${judges === undefined ? '' : " (the judge-overflow switch moves all of this contest's dev judging to it)"}, every round after judged by it`);
        say(`round ${r}: ${counts}, ${planned.length / 2} games in ${planned.length} calls, judged by ${judgeWords}`);
        const ended = await playContenderRound(deps, {
          slug: comp.slug,
          harness,
          judge,
          devPhaseId: phaseId,
          fold,
          setup,
          planned,
          artifacts: bytes.artifacts,
          ...(judges === undefined || chainPlan === null ? {} : { plan: chainPlan }),
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });
        if ('unplayed' in ended) {
          if (ended.cause === 'fault') throw new Error(`round ${r} faulted: ${ended.unplayed}`);
          say(`round ${r} unplayed (${ended.cause}): ${ended.unplayed}`);
          return end(played, 'unplayed');
        }
        const record = ended.record;
        // The chain with the record held and folded in as a final's screen reads it (contenderChainOf's
        // judgeContenderHold): a record that would not hold there is never linked.
        let next: JudgeContenderFoldT;
        try {
          next = jc.judgeContenderHold(fold, record);
        } catch (err) {
          if (!(err instanceof jh.JudgeHeatError || err instanceof RangeError)) throw err;
          say(`round ${r} recorded ${record.games.length} games and left unlinked: its record does not hold against the chain (${err.message})`);
          return end(played, 'unplayed');
        }
        // A contend chain's ratings after the round (the board's), each member with a contender game rated on the fold
        // with the round in, beside the ladder record its snapshot (the fit's ladder games) was read from.
        let board: ContendBoardRatingT[] | undefined;
        if (contend !== undefined) {
          try {
            board = contendBoardOf(next, jc.judgeContenderRatings(next));
          } catch (err) {
            if (!(err instanceof jh.JudgeHeatError || err instanceof RangeError)) throw err;
            say(`round ${r} recorded ${record.games.length} games and left unlinked: its ratings do not fit (${err.message})`);
            return end(played, 'unplayed');
          }
        }
        // The head's answer says why a move was refused: 'closed' is the deadline by the database's clock or this
        // grader's, so a grader whose clock runs behind still ends closed, never 'another job moved the head first'.
        // A contend round's ratings are written in the head move's transaction, under its deadline guard, or not at all.
        const moved = await cs.tryAdvanceContenderHead(deps.db, {
          phaseId,
          prev: fold?.head_sha256 ?? null,
          next: ended.sha256,
          round: r,
          players: setup.players.length,
          games: record.games.length,
          at: now(),
          ...(board === undefined ? {} : { board }),
        });
        if (!moved.moved) {
          say(`round ${r} recorded ${record.games.length} games and left unlinked: ${HEAD_REFUSED[moved.why]}`);
          return end(played, moved.why === 'closed' ? 'closed' : 'unplayed');
        }
        // The fold with the round in, kept under its head (its prev the head it followed), the round two back dropped.
        await keepFoldMemo(objects, phaseId, { fold: next, prev: fold?.head_sha256 ?? null }, foldPrev, say);
        foldPrev = fold?.head_sha256 ?? null;
        fold = next;
        played++;
        say(`round ${r} played: ${setup.players.length} players, ${record.games.length} games in ${record.calls.length} calls (${ended.kept_calls} kept from an earlier attempt, ${record.invalid_calls} with no verdict), judged by ${judgeWords}`);
      }
      return end(played, 'played');
    } catch (err) {
      if (ctx.signal?.aborted === true && err === ctx.signal.reason) throw err;
      const out = sealedError(err);
      if (round !== null && typeof out === 'object' && out !== null) roundOfError.set(out, round);
      throw out;
    }
  };
}

/**
 * Each of `artifacts` (sha256s of players' artifacts) read from a player's entries' latest dev grade runs: the first
 * finished run of one of its entries whose action log's `judge.artifact` is that artifact. The runs are read narrow
 * (server/grading/dev-scrutiny-line.ts latestDevGradeRunsOf: the latest attempt alone, its status and action log among
 * a few columns, a 5,000-entry slice a statement), never every attempt's whole row. Missing, said in counts only, when
 * a player has none: an entry graded again since the field was read, or a store that lost its output.
 */
async function artifactsOf(
  deps: Pick<ContenderJobDeps, 'db' | 'blobs'>,
  devId: string,
  judge: Pick<ProgramJudgeT, 'artifact'>,
  players: readonly { artifact_sha256: string; entries: readonly string[] }[],
  artifacts: readonly string[],
): Promise<{ artifacts: Map<string, Uint8Array> } | { missing: string }> {
  const { latestDevGradeRunsOf } = await import('../server/grading/dev-scrutiny-line.ts');
  const by = new Map(players.map((p) => [p.artifact_sha256, p]));
  const wanted = artifacts.map((a) => by.get(a)!);
  const runs = await latestDevGradeRunsOf(deps.db, devId, wanted.flatMap((p) => p.entries));
  const out = new Map<string, Uint8Array>();
  let missing = 0;
  for (const p of wanted) {
    for (const entry of p.entries) {
      const r = runs.get(entry);
      if (r === undefined || r.status !== 'finished' || r.actionLogSha256 === null) continue;
      try {
        const art = await readOutputFile(deps.blobs, r.actionLogSha256, judge.artifact);
        if (art !== null && art.sha256 === p.artifact_sha256) {
          out.set(p.artifact_sha256, art.bytes);
          break;
        }
      } catch {
        // An action log or output the store does not hold whole: another entry of the artifact may.
      }
    }
    if (!out.has(p.artifact_sha256)) missing++;
  }
  return missing === 0 ? { artifacts: out } : { missing: `${missing} of the round's ${artifacts.length} players' ${judge.artifact} no longer read from their latest dev grade` };
}
