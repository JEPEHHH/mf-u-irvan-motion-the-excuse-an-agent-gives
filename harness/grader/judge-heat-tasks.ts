// A judge heat's CPU work off the grader's event loop (server/offthread; .cosmos/rules/off-thread.mdc): the heat's
// schedule planned again once a batch (grader/worker.ts sendJudgeHeatCalls), a final heat's record built, held,
// digested and scored once its calls are all made (worker.ts judgeCodeHeat), a stored record read back held, for a
// regrade or a provisional heat's reuse (grader/regrade.ts loadJudgeHeatRecord, loadHeldJudgeHeatRecord), and a resumed
// final's kept partial read back and its calls held to the heat (worker.ts judgeCodeHeat, keptJudgeHeat). At a final's
// size (about 2,500 members and 15,000 calls, a 22 MB record) each took 0.1 to 1.2 s of one thread: the schedule's fit
// of every Swiss round, the record's zod parse and its schedule, games and totals re-derived, the canonical JSON, the
// scores' two derivations.
//
// Lean on purpose: this module is what a caller imports to run the tasks, so it imports grader/judge-heat.ts (and
// through it server/competitions/load.ts) only inside the thread, by a dynamic import in each task; the caller's side
// holds the packing and the task definitions alone.
//
// What crosses:
//   schedule     the setup (a few hundred kB at 2,500 members) and the settled calls packed (packCalls: each call's
//                stage, round, pair, slot order, verdict and margin as typed arrays, a member by its index in the
//                field), and back the planned calls packed the same way: a few MB of typed arrays where 15,000 call
//                objects would cost tens of ms to clone on each side.
//   record end   the setup and the calls' and spares' canonical JSON (one string: the partial writer's texts, joined,
//                never serialized again), and back the record's canonical JSON (one string, copied once: what the
//                blob store is handed, as before), its sha256, and what the heat's end reads of it: its call and invalid call counts, its finalists and each entry's
//                verdict. A JudgeHeatError comes back as a value (`issue`).
//   record load  the stored bytes and the sha256 they are named by, and back the record's head (every key but its
//                calls, games and spares: what a regrade holds a record to) and every member's score, or why it is
//                refused (corrupt, not a record that holds, not canonical) as a value; with `whole`, the record too.
//                On the pooled lane up to JUDGE_RECORD_POOLED_MAX_BYTES (every dev provisional record), oneshot above.
//   kept read    a resumed final's kept partial as its store holds it (one string), and back every key but its calls
//                as JudgeHeatPartial parses them, and the calls as one string, the canonical JSON of each joined, with
//                each call's end offset (Int32Array): the caller parses them back a call at a time in slices
//                (judgeHeatKeptCalls) and its partial writer keeps each text, never serializing a kept call again. A
//                text that does not read comes back as a value (`unread`). At 15,000 calls (18 MB) the parse and the
//                hold took about 0.2 s in this thread, twice (worker.ts judgeCodeHeat read the judges, then the calls),
//                and the writer's first save 0.3 s more.
//   kept check   the setup the kept calls are held to and their JSON (kept read's string, sent on as it came), and
//                back judgeHeatKeptIssue's answer and whether the setup holds: about 0.5 s of CPU at 15,000 calls.

import type { ProgramJudgeScoreT } from '../contracts/score.ts';
import { defineOffThreadTask, moved, runOffThread } from '../server/offthread/index.ts';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { JudgeHeatCallT, JudgeHeatPartialT, JudgeHeatRecordT, JudgeHeatScheduleT, JudgeHeatSetupT, JudgeHeatSpareT, JudgePlannedCallT, JudgeSettledCallT } from './judge-heat.ts';

// ---------------------------------------------------------------- packed calls

/**
 * Calls as typed arrays (packCalls): each call's stage, slot order and verdict an index into `labels`; its pair a
 * member's index in the setup's field, or -(label index + 1) for a string that is no member; its round, margin and
 * judge numbers, with `tags` saying which of margin, judge and verdict a call has. A call with a field of another type
 * than these (none the sender makes) crosses whole in `odd`, by its place.
 */
export interface PackedCalls {
  n: number;
  labels: string[];
  stage: Int32Array;
  round: Float64Array;
  a: Int32Array;
  b: Int32Array;
  slot: Int32Array;
  verdict: Int32Array;
  margin: Float64Array;
  judge: Float64Array;
  /** Bits: margin 1 null, 2 a number (0: none); judge 4 present undefined, 8 a number (0: absent); verdict 16 null, 32 a label (0: none). */
  tags: Uint8Array;
  odd: Map<number, Record<string, unknown>>;
}

const MARGIN_NULL = 1;
const MARGIN_NUMBER = 2;
const JUDGE_UNDEFINED = 4;
const JUDGE_NUMBER = 8;
const VERDICT_NULL = 16;
const VERDICT_LABEL = 32;

/** The fields a settled call crosses with (JudgeSettledCallT), and a planned one's (JudgePlannedCallT). */
const SETTLED_FIELDS = ['stage', 'round', 'a', 'b', 'slot_order', 'verdict', 'margin'] as const;
const PLANNED_FIELDS = ['stage', 'round', 'a', 'b', 'slot_order', 'judge'] as const;

const memberIndexes = new WeakMap<object, Map<string, number>>();

/** Each field member's index by its sha256, kept per field array (a setup's field never changes). */
function memberIndexOf(field: JudgeHeatSetupT['field']): Map<string, number> {
  let index = memberIndexes.get(field);
  if (index === undefined) {
    index = new Map(field.map((m, i) => [m.artifact_sha256, i]));
    memberIndexes.set(field, index);
  }
  return index;
}

/** `calls` packed (PackedCalls) against `field`: a settled call's fields (`kind` settled) or a planned call's. */
export function packCalls(calls: readonly object[], field: JudgeHeatSetupT['field'], kind: 'settled' | 'planned'): PackedCalls {
  const n = calls.length;
  const members = memberIndexOf(field);
  const labels: string[] = [];
  const labelIndex = new Map<string, number>();
  const label = (s: string): number => {
    let i = labelIndex.get(s);
    if (i === undefined) {
      i = labels.length;
      labels.push(s);
      labelIndex.set(s, i);
    }
    return i;
  };
  const side = (s: string): number => members.get(s) ?? -(label(s) + 1);
  const out: PackedCalls = {
    n,
    labels,
    stage: new Int32Array(n),
    round: new Float64Array(n),
    a: new Int32Array(n),
    b: new Int32Array(n),
    slot: new Int32Array(n),
    verdict: new Int32Array(kind === 'settled' ? n : 0),
    margin: new Float64Array(kind === 'settled' ? n : 0),
    judge: new Float64Array(kind === 'planned' ? n : 0),
    tags: new Uint8Array(n),
    odd: new Map(),
  };
  const fields = kind === 'settled' ? SETTLED_FIELDS : PLANNED_FIELDS;
  for (let i = 0; i < n; i++) {
    const c = calls[i] as Record<string, unknown>;
    const { stage, round, a, b, slot_order } = c;
    let tag = 0;
    let ok = typeof stage === 'string' && typeof round === 'number' && typeof a === 'string' && typeof b === 'string' && typeof slot_order === 'string';
    if (ok && kind === 'settled') {
      const v = c.verdict;
      const m = c.margin;
      if (v === null) tag |= VERDICT_NULL;
      else if (typeof v === 'string') {
        tag |= VERDICT_LABEL;
        out.verdict[i] = label(v);
      } else ok = false;
      if (m === null) tag |= MARGIN_NULL;
      else if (typeof m === 'number') {
        tag |= MARGIN_NUMBER;
        out.margin[i] = m;
      } else if (m !== undefined) ok = false;
    } else if (ok && 'judge' in c) {
      const j = c.judge;
      if (j === undefined) tag |= JUDGE_UNDEFINED;
      else if (typeof j === 'number') {
        tag |= JUDGE_NUMBER;
        out.judge[i] = j;
      } else ok = false;
    }
    if (!ok) {
      const raw: Record<string, unknown> = {};
      for (const f of fields) if (f in c) raw[f] = c[f];
      out.odd.set(i, raw);
      continue;
    }
    out.stage[i] = label(stage as string);
    out.round[i] = round as number;
    out.a[i] = side(a as string);
    out.b[i] = side(b as string);
    out.slot[i] = label(slot_order as string);
    out.tags[i] = tag;
  }
  return out;
}

/** The calls PackedCalls holds, as objects of `kind`'s fields (a planned call's judge only when it had one). */
export function unpackCalls(p: PackedCalls, field: JudgeHeatSetupT['field'], kind: 'settled'): JudgeSettledCallT[];
export function unpackCalls(p: PackedCalls, field: JudgeHeatSetupT['field'], kind: 'planned'): JudgePlannedCallT[];
export function unpackCalls(p: PackedCalls, field: JudgeHeatSetupT['field'], kind: 'settled' | 'planned'): object[] {
  const side = (k: number): string => (k >= 0 ? field[k]!.artifact_sha256 : p.labels[-k - 1]!);
  const out: object[] = new Array(p.n);
  for (let i = 0; i < p.n; i++) {
    const odd = p.odd.get(i);
    if (odd !== undefined) {
      out[i] = odd;
      continue;
    }
    const tag = p.tags[i]!;
    const c: Record<string, unknown> = { stage: p.labels[p.stage[i]!], round: p.round[i], a: side(p.a[i]!), b: side(p.b[i]!), slot_order: p.labels[p.slot[i]!] };
    if (kind === 'settled') {
      c.verdict = (tag & VERDICT_LABEL) !== 0 ? p.labels[p.verdict[i]!] : null;
      if ((tag & MARGIN_NUMBER) !== 0) c.margin = p.margin[i];
      else if ((tag & MARGIN_NULL) !== 0) c.margin = null;
    } else if ((tag & JUDGE_NUMBER) !== 0) c.judge = p.judge[i];
    else if ((tag & JUDGE_UNDEFINED) !== 0) c.judge = undefined;
    out[i] = c;
  }
  return out;
}

/** The typed arrays a PackedCalls holds: its transfer list (each array its own buffer). */
function buffersOf(p: PackedCalls): ArrayBuffer[] {
  return [p.stage, p.round, p.a, p.b, p.slot, p.verdict, p.margin, p.judge, p.tags].map((x) => x.buffer as ArrayBuffer);
}

// ---------------------------------------------------------------- the schedule

export interface JudgeScheduleJob {
  setup: JudgeHeatSetupT;
  settled: PackedCalls;
}

export interface JudgeSchedulePacked {
  planned: PackedCalls;
  complete: boolean;
  finalists: string[] | null;
  issue: string | null;
}

/** The thread's side of judgeHeatScheduleOffThread: judgeHeatSchedule over the unpacked calls, its planned calls packed. */
export async function judgeHeatScheduleTask(job: JudgeScheduleJob): Promise<ReturnType<typeof moved<JudgeSchedulePacked>>> {
  const { judgeHeatSchedule } = await import('./judge-heat.ts');
  const s = judgeHeatSchedule(job.setup, unpackCalls(job.settled, job.setup.field, 'settled'));
  const planned = packCalls(s.planned, job.setup.field, 'planned');
  return moved({ planned, complete: s.complete, finalists: s.finalists, issue: s.issue }, buffersOf(planned));
}

/** judge-heat.ts judgeHeatSchedule off this thread: a final's replan takes 0.1-0.2 s of CPU at 2,500 members, and 0.24 GB of heap at 119,664 calls (pooled). */
export const judgeHeatScheduleTaskDef = defineOffThreadTask<typeof judgeHeatScheduleTask>('judge-heat.schedule', import.meta.url, 'judgeHeatScheduleTask', { timeoutMs: 300_000 });

/**
 * The heats whose schedule is planned in this thread (judgeHeatScheduleFor): every heat but a final's (a provisional
 * heat plays its anchors and its ladder's few rounds, a calibration is planned whole once, never a Swiss), and a final's
 * of at most this many members and JUDGE_SCHEDULE_INLINE_CALLS settled calls, where planning takes about a millisecond
 * and a hop to a pool thread costs more than it saves. A final's Swiss refits every round so far (judgeFit), which grows
 * with members times games: 0.1-0.25 s a replan at 2,500 members.
 */
export const JUDGE_SCHEDULE_INLINE_MEMBERS = 64;
export const JUDGE_SCHEDULE_INLINE_CALLS = 1_024;

/**
 * judgeHeatSchedule(setup, settled) off this thread (judge-heat.schedule), answering as it answers: the planned calls,
 * whether complete, the finalists and the issue. A pool that is saturated or failing rejects (an OffThreadError): the
 * heat's attempt ends and its job retries from the calls kept.
 */
export async function judgeHeatScheduleOffThread(setup: JudgeHeatSetupT, settled: readonly JudgeSettledCallT[], signal?: AbortSignal): Promise<JudgeHeatScheduleT> {
  const packed = packCalls(settled, setup.field, 'settled');
  const answer = await runOffThread(judgeHeatScheduleTaskDef, { setup, settled: packed }, { transfer: buffersOf(packed), ...(signal === undefined ? {} : { signal }) });
  return { planned: unpackCalls(answer.planned, setup.field, 'planned'), complete: answer.complete, finalists: answer.finalists, issue: answer.issue };
}

/**
 * The schedule a heat's sender plans with by default (grader/worker.ts sendJudgeHeatCalls): a heat that is no final's,
 * or a small final's, in this thread (JUDGE_SCHEDULE_INLINE_MEMBERS, JUDGE_SCHEDULE_INLINE_CALLS), any other final's
 * off it (judgeHeatScheduleOffThread).
 */
export async function judgeHeatScheduleFor(setup: JudgeHeatSetupT, settled: readonly JudgeSettledCallT[], signal?: AbortSignal): Promise<JudgeHeatScheduleT> {
  if (setup.stage !== 'final' || (setup.field.length <= JUDGE_SCHEDULE_INLINE_MEMBERS && settled.length <= JUDGE_SCHEDULE_INLINE_CALLS)) {
    const { judgeHeatSchedule } = await import('./judge-heat.ts');
    return judgeHeatSchedule(setup, settled);
  }
  return judgeHeatScheduleOffThread(setup, settled, signal);
}

// ---------------------------------------------------------------- the record of a heat's end

export interface JudgeRecordEndJob {
  setup: JudgeHeatSetupT;
  /** `{"calls":[…],"spares":[…]}`: the heat's calls and spares as canonical JSON (judgeHeatEndText). */
  heat: string;
}

/** What a heat's end reads of its record (judgeHeatRecordEndOffThread), or why the calls make no record (`issue`). */
export type JudgeRecordEndAnswer =
  | { issue: string }
  | {
      /** The record's canonical JSON: the blob it is stored as. */
      json: string;
      sha256: string;
      calls: number;
      invalid_calls: number;
      finalists: string[];
      /** Each entry's verdict (judge-heat.ts judgeHeatEntryVerdicts), or null with `verdictsIssue` its JudgeHeatError's message. */
      verdicts: Map<string, ProgramJudgeScoreT> | null;
      verdictsIssue: string | null;
    };

/** `calls` and `spares` texts (each item's canonical JSON, as a partial writer keeps them) as one JudgeRecordEndJob.heat. */
export function judgeHeatEndText(calls: readonly string[], spares: readonly string[]): string {
  return `{"calls":[${calls.join(',')}],"spares":[${spares.join(',')}]}`;
}

/** The thread's side of judgeHeatRecordEndOffThread: judge-heat.ts judgeHeatRecordEnd over the calls and spares the text holds. */
export async function judgeHeatRecordEndTask(job: JudgeRecordEndJob): Promise<JudgeRecordEndAnswer> {
  const { JudgeHeatError, judgeHeatRecordEnd } = await import('./judge-heat.ts');
  const heat = JSON.parse(job.heat) as { calls: Parameters<typeof judgeHeatRecordEnd>[1]; spares: Parameters<typeof judgeHeatRecordEnd>[2] };
  let end: ReturnType<typeof judgeHeatRecordEnd>;
  try {
    end = judgeHeatRecordEnd(job.setup, heat.calls, heat.spares);
  } catch (err) {
    if (err instanceof JudgeHeatError) return { issue: err.message };
    throw err;
  }
  return {
    json: end.json,
    sha256: end.sha256,
    calls: end.record.calls.length,
    invalid_calls: end.record.invalid_calls,
    finalists: end.record.finalists,
    verdicts: end.verdicts,
    verdictsIssue: end.verdictsIssue,
  };
}

/**
 * The heap a record step gets, and every other task here whose memory grows with the heat's calls (kept read, kept
 * check, a large record's load: JUDGE_RECORD_POOLED_MAX_BYTES; server/routes/competitions/kit.ts kit.judge-records): the pooled lane's 1,024 MB cap is below what
 * a daily news-image heat now needs. news-image-20261119's heat kept 58,068 calls (97 MB of calls in the partial) and
 * its record step died on every attempt with ERR_WORKER_OUT_OF_MEMORY at the pooled cap, holding the final phase
 * unranked. Peak heap at 58,068 and 119,664 calls (2026-11-21, a news-image-daily final): record end 1.3 and 2.3 GB,
 * record load 1.1 and 1.9 GB, kept read 1.2 and 1.7 GB, kept check 0.75 and 1.15 GB, kit.judge-records 1.0 and 2.1 GB.
 * The process's own --max-old-space-size (4,096 on the grader and the worker) is the size the main isolate works in,
 * and the pod's 12 GiB holds one such thread beside it; each runs once a heat or an attempt, so two at once is rare.
 */
export const JUDGE_RECORD_TASK_HEAP_MB = 4096;

/** judge-heat.ts judgeHeatRecordEnd off this thread: about 1.2 s of CPU at 15,000 calls, and memory in proportion to them. */
export const judgeHeatRecordEndTaskDef = defineOffThreadTask<typeof judgeHeatRecordEndTask>('judge-heat.record-end', import.meta.url, 'judgeHeatRecordEndTask', { lane: 'oneshot', heapMb: JUDGE_RECORD_TASK_HEAP_MB, timeoutMs: 600_000 });

/**
 * A heat's record off this thread (judge-heat.record-end): judge-heat.ts judgeHeatRecordEnd over `heat`'s calls and
 * spares (judgeHeatEndText), its canonical JSON back. `key` joins a run of the same heat in flight.
 */
export async function judgeHeatRecordEndOffThread(job: JudgeRecordEndJob, options: { key?: string; signal?: AbortSignal } = {}): Promise<JudgeRecordEndAnswer> {
  return runOffThread(judgeHeatRecordEndTaskDef, job, { ...(options.key === undefined ? {} : { key: options.key }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
}

// ---------------------------------------------------------------- a stored record read back

/** A record's head: every key but the calls, games and spares (what a regrade holds a record to, and reads its verdicts by). */
export type JudgeHeatRecordHeadT = Omit<JudgeHeatRecordT, 'calls' | 'games' | 'spares'>;

export interface JudgeRecordLoadJob {
  /** The sha256 the record is named by. */
  sha256: string;
  /** Its stored bytes as read (unverified). */
  bytes: Uint8Array;
  /** Answer the whole record too (loadJudgeHeatRecord's), and no scores. */
  whole: boolean;
}

/** A stored record read back (judgeHeatRecordLoadOffThread), or why it is refused. */
export type JudgeRecordLoadAnswer =
  | { corrupt: string }
  | { refused: string }
  | { uncanonical: true }
  | {
      head: JudgeHeatRecordHeadT;
      /** Every member's score by artifact (judge-heat.ts judgeHeatVerdicts), or null: `whole`, or `scoresIssue` its JudgeHeatError's message. */
      scores: Map<string, ProgramJudgeScoreT> | null;
      scoresIssue: string | null;
      record?: JudgeHeatRecordT;
    };

/** The thread's side of judgeHeatRecordLoadOffThread: the bytes hashed, read back held (judge-heat.ts judgeHeatRecordRead) and, unless whole, scored. */
export async function judgeHeatRecordLoadTask(job: JudgeRecordLoadJob): Promise<JudgeRecordLoadAnswer> {
  const [{ createHash }, { JudgeHeatError, judgeHeatHeldVerdicts, judgeHeatRecordRead }] = await Promise.all([import('node:crypto'), import('./judge-heat.ts')]);
  const actual = createHash('sha256').update(job.bytes).digest('hex');
  if (actual !== job.sha256) return { corrupt: actual };
  const read = judgeHeatRecordRead(job.bytes);
  if (!('record' in read)) return read;
  const { calls: _calls, games: _games, spares: _spares, ...head } = read.record;
  if (job.whole) return { head, scores: null, scoresIssue: null, record: read.record };
  try {
    return { head, scores: judgeHeatHeldVerdicts(read.record), scoresIssue: null };
  } catch (err) {
    if (err instanceof JudgeHeatError) return { head, scores: null, scoresIssue: err.message };
    throw err;
  }
}

/**
 * The heap a large stored record is read back under (judge-heat.record-load-large): the record step's
 * (JUDGE_RECORD_TASK_HEAP_MB). Reading it hashes its bytes, parses, holds and scores them, the record end's memory shape:
 * 1.9 GB at 119,664 calls (a 220 MB record), which 2,048 held only by collecting hard, with no room for a larger heat.
 * Its callers are the grader's and the worker's alone (grader/worker.ts, grader/regrade.ts,
 * server/grading/dev-scrutiny-line.ts, server/grading/contender-select.ts), never the web pod's.
 */
export const JUDGE_RECORD_LOAD_HEAP_MB = JUDGE_RECORD_TASK_HEAP_MB;

/**
 * The largest stored record read back on the pooled lane (judge-heat.record-load), in bytes; a larger one is read on the
 * oneshot lane at JUDGE_RECORD_LOAD_HEAP_MB (judge-heat.record-load-large). The read's peak heap is about 9 times the
 * record (1.9 GB at 220 MB): a 32.07 MiB record (23,304 calls) held at 288 MB of old space, 85 MB of it the modules,
 * and died at 272, so a pooled thread's 1,024 MB cap holds this with room. Production's records (2026-11-21, their blob
 * sizes behind run.judge_heat_sha256): 3,000 dev provisional ones sampled at 38.5 KiB to 85.3 KiB (p50 47.2 KiB, p99
 * 76.1 KiB), every one of them pooled; the 40 final heats' at 0.29 MiB to 101.9 MiB (p50 7.7 MiB, p90 65 MiB), the 10
 * above 32 MiB oneshot. From 2026-11-21 17:01Z to this every read ran oneshot: the dev sweep's
 * (server/grading/dev-scrutiny-line.ts DEV_RECORD_READS_AT_ONCE) each started a thread and imported judge-heat.ts (3.4 s
 * a read against 0.01 s pooled), record loads fell from 58,402 an hour to 494, a sweep pass covered one competition
 * where it covered 18 to 23, and its eight reads filled the oneshot lane's queue of 8, so kits.publish and the other
 * oneshot tasks were refused OFFTHREAD_SATURATED.
 */
export const JUDGE_RECORD_POOLED_MAX_BYTES = 32 * 1024 * 1024;

/** A stored record's hash, parse, hold and scores off this thread, a record of at most JUDGE_RECORD_POOLED_MAX_BYTES (every dev provisional one): about 10 ms at 50 KiB, 1-2 s at 32 MiB. */
export const judgeHeatRecordLoadTaskDef = defineOffThreadTask<typeof judgeHeatRecordLoadTask>('judge-heat.record-load', import.meta.url, 'judgeHeatRecordLoadTask', { lane: 'pooled', timeoutMs: 300_000 });

/** The same over a record above JUDGE_RECORD_POOLED_MAX_BYTES (a large final's), in a fresh thread at JUDGE_RECORD_LOAD_HEAP_MB: 10-90 s at 119,664 calls, and memory with its size. */
export const judgeHeatRecordLoadLargeTaskDef = defineOffThreadTask<typeof judgeHeatRecordLoadTask>('judge-heat.record-load-large', import.meta.url, 'judgeHeatRecordLoadTask', { lane: 'oneshot', heapMb: JUDGE_RECORD_LOAD_HEAP_MB, timeoutMs: 600_000 });

/** The task a stored record of `bytes` bytes is read back by: pooled up to JUDGE_RECORD_POOLED_MAX_BYTES, oneshot above. */
export function judgeHeatRecordLoadTaskFor(bytes: number): typeof judgeHeatRecordLoadTaskDef {
  return bytes <= JUDGE_RECORD_POOLED_MAX_BYTES ? judgeHeatRecordLoadTaskDef : judgeHeatRecordLoadLargeTaskDef;
}

/**
 * A stored record's bytes read back off this thread, on the task its size picks (judgeHeatRecordLoadTaskFor); a run of
 * the same record in flight joined (a record's size is its bytes', so one sha256 always picks one task).
 */
export async function judgeHeatRecordLoadOffThread(job: JudgeRecordLoadJob): Promise<JudgeRecordLoadAnswer> {
  return runOffThread(judgeHeatRecordLoadTaskFor(job.bytes.byteLength), job, { key: `${job.sha256}\u0000${job.whole ? 'whole' : 'held'}` });
}

// ---------------------------------------------------------------- a kept partial read back

/**
 * A heat's kept partial (judge-heat.ts JudgeHeatPartial) read back (judgeHeatKeptReadOffThread): every key but its calls
 * as JudgeHeatPartial parses them (`head`, its `calls` empty in place), and the calls as JSON: `calls` the array's
 * canonical JSON, each call's text ending at its `ends` offset (the next one starting past the comma). Or why the text
 * does not read (`unread`: the message JSON.parse or the parse threw).
 */
export type JudgeKeptRead = { unread: string } | { head: JudgeHeatPartialT; calls: string; ends: Int32Array };

export interface JudgeKeptReadJob {
  /** The text kept (the partial store's read). */
  text: string;
}

/** The thread's side of judgeHeatKeptReadOffThread: the text parsed and held to JudgeHeatPartial once, each call's canonical JSON back. */
export async function judgeHeatKeptReadTask(job: JudgeKeptReadJob): Promise<JudgeKeptRead> {
  const [{ JudgeHeatPartial }, { canonicalJson }] = await Promise.all([import('./judge-heat.ts'), import('../sim/canonical.ts')]);
  let parsed: JudgeHeatPartialT;
  try {
    parsed = JudgeHeatPartial.parse(JSON.parse(job.text));
  } catch (err) {
    return { unread: err instanceof Error ? err.message : String(err) };
  }
  const ends = new Int32Array(parsed.calls.length);
  const texts: string[] = [];
  let at = 1;
  for (const [i, c] of parsed.calls.entries()) {
    const text = canonicalJson(c);
    texts.push(text);
    at += text.length;
    ends[i] = at;
    at += 1;
  }
  // `calls` left in its place among the keys, empty: the caller puts the parsed calls back there.
  return { head: { ...parsed, calls: [] }, calls: `[${texts.join(',')}]`, ends };
}

/**
 * A kept partial's JSON parse and JudgeHeatPartial parse off this thread: about 0.2 s of CPU at 15,000 calls (18 MB), with
 * each call's canonical JSON; oneshot at JUDGE_RECORD_TASK_HEAP_MB, as a pooled thread's 1 GiB died at 119,664 calls.
 */
export const judgeHeatKeptReadTaskDef = defineOffThreadTask<typeof judgeHeatKeptReadTask>('judge-heat.kept-read', import.meta.url, 'judgeHeatKeptReadTask', { lane: 'oneshot', heapMb: JUDGE_RECORD_TASK_HEAP_MB, timeoutMs: 300_000 });

/**
 * The text a heat's partial store keeps, read back off this thread (judge-heat.kept-read): once an attempt, where
 * grader/worker.ts judgeCodeHeat read and parsed it twice in this thread (its judges, then its calls). A pool that is
 * saturated or failing rejects (an OffThreadError): the attempt ends and its job retries.
 */
export async function judgeHeatKeptReadOffThread(text: string, signal?: AbortSignal): Promise<JudgeKeptRead> {
  return runOffThread(judgeHeatKeptReadTaskDef, { text }, signal === undefined ? {} : { signal });
}

/** How long the kept calls' parse back holds this thread before it yields, ms (judgeHeatKeptCalls). */
export const JUDGE_KEPT_SLICE_MS = 8;

/**
 * The calls a kept partial read back holds (judgeHeatKeptReadOffThread), each with the canonical JSON it was kept as (a
 * partial writer's memo: grader/worker.ts judgeHeatPartialWriter.remember), parsed in this thread a call at a time,
 * yielding every JUDGE_KEPT_SLICE_MS: 15,000 calls take about 40 ms of JSON.parse in all, never in one stretch.
 */
export async function judgeHeatKeptCalls(read: { calls: string; ends: Int32Array }): Promise<{ calls: JudgeHeatCallT[]; texts: string[] }> {
  const calls: JudgeHeatCallT[] = [];
  const texts: string[] = [];
  let start = 1;
  let sliceAt = performance.now();
  for (let i = 0; i < read.ends.length; i++) {
    const end = read.ends[i]!;
    const text = read.calls.slice(start, end);
    texts.push(text);
    calls.push(JSON.parse(text) as JudgeHeatCallT);
    start = end + 1;
    if ((i & 31) === 31 && performance.now() - sliceAt >= JUDGE_KEPT_SLICE_MS) {
      await yieldLoop();
      sliceAt = performance.now();
    }
  }
  return { calls, texts };
}

// ---------------------------------------------------------------- the kept calls held to the heat

export interface JudgeKeptCheckJob {
  /** The setup the kept calls are held to: the heat's, on the partial's own `judges`. */
  setup: JudgeHeatSetupT;
  /** The kept calls' JSON (JudgeKeptRead's `calls`). */
  calls: string;
  /** The partial's spares (none: []). */
  spares: JudgeHeatSpareT[];
}

/** judgeHeatKeptCheckOffThread's answer: judge-heat.ts judgeHeatKeptIssue's, and whether the setup holds (judgeHeatSetupIssues none). */
export interface JudgeKeptCheck {
  issue: string | null;
  setsUp: boolean;
}

/** The thread's side of judgeHeatKeptCheckOffThread: judgeHeatKeptIssue over the calls parsed (only once the setup holds, as it reads them). */
export async function judgeHeatKeptCheckTask(job: JudgeKeptCheckJob): Promise<JudgeKeptCheck> {
  const { judgeHeatKeptIssue, judgeHeatSetupIssues } = await import('./judge-heat.ts');
  const setupIssues = judgeHeatSetupIssues(job.setup);
  if (setupIssues.length > 0) return { issue: setupIssues[0]!, setsUp: false };
  return { issue: judgeHeatKeptIssue(job.setup, JSON.parse(job.calls) as JudgeHeatCallT[], job.spares), setsUp: true };
}

/**
 * judge-heat.ts judgeHeatKeptIssue off this thread: about 0.5 s of CPU at 15,000 calls (each call parsed again, the
 * schedule refit); oneshot at JUDGE_RECORD_TASK_HEAP_MB, as it held 1.15 GB at 119,664 calls.
 */
export const judgeHeatKeptCheckTaskDef = defineOffThreadTask<typeof judgeHeatKeptCheckTask>('judge-heat.kept-check', import.meta.url, 'judgeHeatKeptCheckTask', { lane: 'oneshot', heapMb: JUDGE_RECORD_TASK_HEAP_MB, timeoutMs: 300_000 });

/**
 * Why kept calls cannot resume the heat (judge-heat.ts judgeHeatKeptIssue; null when they can) and whether `setup`
 * holds, off this thread (judge-heat.kept-check). A pool that is saturated or failing rejects (an OffThreadError).
 */
export async function judgeHeatKeptCheckOffThread(job: JudgeKeptCheckJob, signal?: AbortSignal): Promise<JudgeKeptCheck> {
  return runOffThread(judgeHeatKeptCheckTaskDef, job, signal === undefined ? {} : { signal });
}
