// The hindsight audit of one entry (agent-fun/hindsight-audit/v1): its replay on m twins and m block
// surrogates of the window it was graded on, scored, and the hindsight check's verdict on the numbers
// (server/entries/hindsight.ts: CHEAT_CHECK, hindsightVerdict, hindsightScan).
//
//   auditEntry({ sandbox, runtime, botDir, harness, limits,
//                real: { dataset, seed, failKey, net_pnl_lamports }, source, m, seeds[, secrets, rungs, reuse] })
//
//   real.dataset   the drawn MASKED window the entry was graded on (a frozen dataset directory, as
//                  scripts/backtest/seal.ts writes it). Every surrogate is built from it, so each keeps
//                  the time base and slot base the entry saw.
//   real.seed      the real run's hello seed, and real.failKey its failed-tx draw's key (u64 decimal):
//                  every surrogate run uses both (the pairing). A surrogate has its own dataset digest,
//                  so grader/worker.ts phaseSeed would give it another hello seed and another fail key
//                  (#1101): the runs would then differ in their draws as well as in their data.
//   real.net_pnl_lamports
//                  the real run's net PnL as its stored run recorded it: taken as given, never
//                  re-derived here.
//   source         the drawn window's UNMASKED source (a dataset directory, or hindsight.ts's
//                  HindsightSource or HindsightIndex): the static scan of the entry's files runs
//                  against it (hindsightScan). Null or absent: no scan, and the record's scan is null.
//   m              surrogates per rung (default CHEAT_CHECK.m; an appeal passes CHEAT_CHECK.appeal_m).
//   seeds          one master secret (auditSeeds derives m seeds per rung from it), or the seeds
//                  themselves ({ twin: [...], blocks: [...] }, m each).
//   secrets        the entrant's env-lane entry secrets the real run ran with, NAME to value (grader/worker.ts
//                  re-opens exactly the rows the stored run recorded: run.entry_secret_ids, recordedEnvSecrets).
//                  Every surrogate run gets them as the real run did (run.ts SandboxRunOptions.secrets: the
//                  bot's own variables), so an entry that needs one runs on the surrogates as it ran on the
//                  window, never failing there for the want of it. Absent or empty: none, as before.
//
//   rungs, reuse   which rungs this audit runs (default both). A rung left out is taken from `reuse`
//                  (an earlier record's rung: m runs, each under this audit's seed for it, built with
//                  the params this audit's check gives): a calibration audits one bot under several
//                  twin sigmas on the same seeds, and the block rung, which does not depend on the
//                  twin's numbers, is run once and reused. Neither is part of the check (CHEAT_CHECK,
//                  cheatCheckSha256): the record is the one a full audit gives.
//
// Each surrogate i of a rung is built under its own seed and a fresh 32-byte mask key derived from
// it (surrogateKey): collector/surrogate.ts twinDataset with CHEAT_CHECK.twin {sigma, shift_slots},
// blockDataset with CHEAT_CHECK.blocks {mean, sigma, min_pool, quiet_slots, complete_progress_lamports,
// edges}. The lamport numbers are converted to the surrogate's SOL (complete_progress_lamports ->
// completeFromRealQuoteSol, progress_lamports -> real_quote_sol, age_slots -> age_slots, net_short ->
// net_sol_30, net_long -> net_sol_300; the surrogate measures net flow over exactly 30 and 300 slots,
// so other windows are refused). The record carries the surrogate's own params in blocks.params.
//
// Each surrogate is loaded as the grader loads a phase's dataset (grader/dataset.ts readFrozenDataset,
// every hash checked), reduced to its universe (grader/harnesses.ts universeDataset), and the entry
// runs on it once through grader/run.ts executeReplay, with the competition's harness as its hello
// (sim/params.ts makeHello) and the real seed and fail key. An ok run is scored with sim/metrics.ts
// scoreActionLog under the same fail key; its net_pnl_lamports is the number the rule reads. A run that
// fails or times out counts as net 0 and is listed in the record's `failed`. Harness faults are thrown,
// never blamed on the entry: a surrogate that cannot be built (AuditError surrogate_failed), a dataset
// the replay refuses, a sandbox failure, a scorer abort.
//
// Entry secrets: every form of every value (run.ts entrySecretForms) is masked out of what a run says and
// keeps, as the grade path masks its executions (grade.ts executeOnce): its execution (run.ts maskExecution:
// its error REDACTED_MARK, its stderr SECRET_MARK), so a record's errors and onRun's stderr hold none, and
// whatever it throws (run.ts redactSecrets over the message and the stack: a SandboxError's tail, a scorer's
// abort). The action log is never masked (it is scored), and the record keeps only its digest. The record
// names no secret: it is the record of the bot as it ran, under them.
//
// The surrogates are written under opts.workDir (default a fresh private directory under the system
// temporary directory) as <rung>-<nn> (surrogateDirName) beside their preservation reports, and each
// is removed once its run is scored, unless opts.keep. A surrogate carries the window's coins with
// perturbed amounts: the work directory belongs where the window does.
//
// The record (HindsightAuditRecord). Deterministic for a fixed window, bot, seeds, check and harness:
// no paths, wall times or execution flags (those vary run to run; opts.onRun reports them).
//   cheat_check   {version, provisional, sha256}: the parameters the audit ran under (cheatCheckSha256)
//   m, runtime, bot_sha256 (canonicalSha256 of the bot directory's [path, sha256] list)
//   real          {dataset_sha256 (canonicalSha256 of the window's manifest.json), seed, net_pnl_lamports}
//   twin, blocks  {params (the surrogate's own, as its report names them), runs: [{index, seed,
//                 dataset_sha256, status, error, net_pnl_lamports, action_log_sha256}]}
//   failed        every run that did not finish ok: {rung, index, status, error}
//   scan          hindsightScan of the bot's files against the source, or null
//   verdict       hindsightVerdict of the above: each rung's median, max, rank, rank cap (rank_max: the
//                 twin rung's top share of its m + 1 runs, its median at version 3, 10 of 20 at M = 19;
//                 1 on the block rung), gap and flag, and why
// The schema stays v1 across CHEAT_CHECK version 3: its verdict only gained rank_max and rank_ok,
// optional in RungVerdict so a record of version 2 still reads, and cheat_check names the rule a
// record's verdict is re-derived under (checkAuditRecord refuses a record of another version).
// The fail key is not in the record: on a final phase it is secret until the phase is finalized (the
// stored run keeps it). The seeds are: with them and the window anyone rebuilds the surrogates, so the
// record is kept with the window, never published before the verdict.
// checkAuditRecord re-derives the verdict from the record's numbers and checks its shape.

import { createHash, createHmac } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { readManifest, verifyDataset } from '../collector/freeze.ts';
import { DatasetManifest } from '../collector/manifest.ts';
import { readDatasetRecords } from '../collector/mask.ts';
import { blockDataset, SurrogateError, twinDataset, type BlockEdges, type BlockOptions, type SurrogateKind, type TwinOptions } from '../collector/surrogate.ts';
import { RUNTIMES, type ReplayHarness } from '../contracts/competition.ts';
import type { ChainEventT } from '../contracts/events.ts';
import {
  CHEAT_CHECK,
  cheatCheckSha256,
  HindsightIndex,
  HindsightScan,
  hindsightScan,
  HindsightVerdict,
  hindsightVerdict,
  type CheatCheck,
  type HindsightScanT,
  type HindsightSource,
  type HindsightVerdictT,
  type SnapshotFile,
} from '../server/entries/hindsight.ts';
import { canonicalJson, canonicalSha256, compareCodeUnits } from '../sim/canonical.ts';
import { scoreActionLog } from '../sim/metrics.ts';
import { makeHello } from '../sim/params.ts';
import { parseU64 } from '../sim/rng.ts';
import { readFrozenDataset } from './dataset.ts';
import { universeDataset } from './harnesses.ts';
import type { FormSet } from './gateway/secret-mask.ts';
import { entrySecretForms, executeReplay, maskExecution, redactSecrets, type ExecutionStatus, type LimitsT } from './run.ts';
import type { Runtime, Sandbox } from './sandbox/types.ts';

export const AUDIT_SCHEMA = 'agent-fun/hindsight-audit/v1';
/** The HMAC label of a surrogate seed (auditSeeds) and of a surrogate's mask key (surrogateKey). */
export const AUDIT_SEED_LABEL = 'agent-fun/hindsight-audit/v1 seed';
export const AUDIT_KEY_LABEL = 'agent-fun/hindsight-audit/v1 key';
export const AUDIT_RUNGS = ['twin', 'blocks'] as const satisfies readonly SurrogateKind[];
export type AuditRung = (typeof AUDIT_RUNGS)[number];

const LAMPORTS_PER_SOL = 1_000_000_000;

export const AUDIT_ERROR_CODES = ['invalid_options', 'window_mismatch', 'surrogate_failed'] as const;
export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[number];

/** The audit cannot run as asked: options, a window that is not the one named, or a surrogate that cannot be built. */
export class AuditError extends Error {
  readonly code: AuditErrorCode;

  constructor(code: AuditErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuditError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- seeds and keys

/** The surrogate seeds of one audit: m per rung. */
export interface AuditSeeds {
  readonly twin: readonly string[];
  readonly blocks: readonly string[];
}

/** m seeds per rung from one master secret: hex of the first 16 bytes of HMAC-SHA256(master, label 0x00 rung 0x00 i). */
export function auditSeeds(master: string, m: number): AuditSeeds {
  if (typeof master !== 'string' || master.length === 0) throw new AuditError('invalid_options', 'the audit seed must be a non-empty string');
  const count = positiveInt(m, 'm');
  const derive = (rung: AuditRung, i: number) => createHmac('sha256', master).update(`${AUDIT_SEED_LABEL}\0${rung}\0${i}`).digest('hex').slice(0, 32);
  return {
    twin: Array.from({ length: count }, (_, i) => derive('twin', i)),
    blocks: Array.from({ length: count }, (_, i) => derive('blocks', i)),
  };
}

/** The fresh 32-byte mask key of one surrogate: HMAC-SHA256(label, rung 0x00 seed). Secret as long as its seed is. */
export function surrogateKey(rung: AuditRung, seed: string): Buffer {
  return createHmac('sha256', AUDIT_KEY_LABEL).update(`${rung}\0${seed}`).digest();
}

/** A surrogate's directory under the work directory, and its manifest id: twin-01, blocks-01, ... */
export function surrogateDirName(rung: AuditRung, index: number): string {
  return `${rung}-${String(index + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- CHEAT_CHECK -> surrogate options

const solOf = (lamports: string, what: string): number => {
  if (!/^-?\d+$/.test(lamports)) throw new AuditError('invalid_options', `${what} ${JSON.stringify(lamports)} is not a lamport amount`);
  return Number(BigInt(lamports)) / LAMPORTS_PER_SOL;
};

/** The twin options CHEAT_CHECK.twin names. */
export function twinOptionsOf(check: CheatCheck = CHEAT_CHECK): Required<Pick<TwinOptions, 'sigma' | 'shiftSlots'>> {
  return { sigma: check.twin.sigma, shiftSlots: check.twin.shift_slots };
}

/** The block surrogate options CHEAT_CHECK.blocks names, its lamport numbers in the surrogate's SOL. */
export function blockOptionsOf(check: CheatCheck = CHEAT_CHECK): Required<Pick<BlockOptions, 'mean' | 'sigma' | 'minPool' | 'quietTailSlots' | 'completeFromRealQuoteSol' | 'edges'>> {
  const b = check.blocks;
  if (b.edges.net_short.slots !== 30 || b.edges.net_long.slots !== 300) {
    throw new AuditError(
      'invalid_options',
      `the block surrogate measures trailing net flow over 30 and 300 slots; CHEAT_CHECK.blocks.edges names ${b.edges.net_short.slots} and ${b.edges.net_long.slots}`,
    );
  }
  const edges: BlockEdges = {
    real_quote_sol: b.edges.progress_lamports.map((v, i) => solOf(v, `blocks.edges.progress_lamports[${i}]`)),
    age_slots: [...b.edges.age_slots],
    net_sol_30: b.edges.net_short.lamports.map((v, i) => solOf(v, `blocks.edges.net_short.lamports[${i}]`)),
    net_sol_300: b.edges.net_long.lamports.map((v, i) => solOf(v, `blocks.edges.net_long.lamports[${i}]`)),
  };
  return {
    mean: b.mean,
    sigma: b.sigma,
    minPool: b.min_pool,
    quietTailSlots: b.quiet_slots,
    completeFromRealQuoteSol: solOf(b.complete_progress_lamports, 'blocks.complete_progress_lamports'),
    edges,
  };
}

// ---------------------------------------------------------------- the record

const Lamports = z.string().regex(/^-?(0|[1-9][0-9]*)$/, 'expected a decimal lamport amount');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex sha256');

export const AuditRun = z.strictObject({
  /** Position in its rung, from 0. */
  index: z.int().min(0),
  seed: z.string().min(1),
  /** canonicalSha256 of the surrogate's manifest.json. */
  dataset_sha256: Sha256,
  status: z.enum(['ok', 'failed', 'timeout']),
  /** Why it failed or timed out; null when ok. */
  error: z.string().nullable(),
  /** The scored net PnL; 0 when the run failed or timed out. */
  net_pnl_lamports: Lamports,
  action_log_sha256: Sha256.nullable(),
});
export type AuditRunT = z.infer<typeof AuditRun>;

const Rung = z.strictObject({
  /** The surrogate's parameters, as its preservation report names them (what its draws are keyed by). */
  params: z.record(z.string(), z.unknown()),
  runs: z.array(AuditRun),
});
/** One rung of a record (its twin or blocks): what an audit that does not run that rung reuses (AuditOptions.reuse). */
export type ReusedRung = z.infer<typeof Rung>;

export const HindsightAuditRecord = z.strictObject({
  schema: z.literal(AUDIT_SCHEMA),
  cheat_check: z.strictObject({ version: z.int().min(1), provisional: z.boolean(), sha256: Sha256 }),
  m: z.int().min(1),
  runtime: z.enum(RUNTIMES),
  /** canonicalSha256 of the bot directory's files as [path, sha256] pairs, by path. */
  bot_sha256: Sha256,
  real: z.strictObject({ dataset_sha256: Sha256, seed: z.string().min(1), net_pnl_lamports: Lamports }),
  twin: Rung,
  blocks: Rung,
  failed: z.array(z.strictObject({ rung: z.enum(AUDIT_RUNGS), index: z.int().min(0), status: z.enum(['failed', 'timeout']), error: z.string() })),
  scan: HindsightScan.nullable(),
  verdict: HindsightVerdict,
});
export type HindsightAuditRecordT = z.infer<typeof HindsightAuditRecord>;

/** Whether a record is well-formed and its verdict is the one its numbers give under `check`. */
export function checkAuditRecord(value: unknown, check: CheatCheck = CHEAT_CHECK): { ok: boolean; problems: string[] } {
  const parsed = HindsightAuditRecord.safeParse(value);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const r = parsed.data;
  const problems: string[] = [];
  if (r.cheat_check.sha256 !== cheatCheckSha256(check) || r.cheat_check.version !== check.version) {
    problems.push(`the record ran under CHEAT_CHECK version ${r.cheat_check.version} (${r.cheat_check.sha256}), not version ${check.version} (${cheatCheckSha256(check)})`);
  }
  const failed: HindsightAuditRecordT['failed'] = [];
  for (const rung of AUDIT_RUNGS) {
    const runs = r[rung].runs;
    if (runs.length !== r.m) problems.push(`${rung}: ${runs.length} runs, m is ${r.m}`);
    runs.forEach((run, i) => {
      if (run.index !== i) problems.push(`${rung} run ${i} is numbered ${run.index}`);
      if (run.status === 'ok') {
        if (run.error !== null || run.action_log_sha256 === null) problems.push(`${rung} run ${i} is ok without an action log, or with an error`);
      } else {
        if (run.net_pnl_lamports !== '0' || run.action_log_sha256 !== null || run.error === null) problems.push(`${rung} run ${i} ${run.status} must count 0 with no action log and say why`);
        failed.push({ rung, index: i, status: run.status, error: run.error ?? '' });
      }
    });
  }
  if (canonicalJson(failed) !== canonicalJson(r.failed)) problems.push('`failed` does not list exactly the runs that did not finish ok');
  if (problems.length === 0) {
    const verdict = hindsightVerdict(r, check);
    if (canonicalJson(verdict) !== canonicalJson(r.verdict)) problems.push('the verdict is not the one the record’s numbers give');
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------- one run on one window

export interface WindowRunOptions {
  sandbox: Sandbox;
  runtime: Runtime;
  /** The entry's files, mounted read-only at /bot. */
  botDir: string;
  /** The competition's pumpfun-replay/v2 harness: the hello's numbers and the scorer's parameters. */
  harness: z.infer<typeof ReplayHarness>;
  limits: LimitsT;
  /** A frozen dataset directory. */
  dataset: string;
  /** Refuse the window unless its manifest digest is this one. */
  expectSha256?: string;
  /** hello.seed (u64 decimal). */
  seed: string;
  /** The failed-tx draw's key (u64 decimal). */
  failKey: string;
  label?: string;
  imageDigest?: string | null;
  /**
   * The entrant's env-lane entry secrets the run is to have, NAME to value (the header's `secrets`): the bot's sandbox
   * spec's `secrets`, every form of every value masked out of what the run says and keeps. Absent or empty: none.
   */
  secrets?: Readonly<Record<string, string>>;
}

/**
 * `err` with every form in `forms` redacted out of its message and stack (run.ts redactSecrets), as grade.ts
 * redactThrown leaves what a grade throws: the same object, so its class and cause stand. `err` itself with none.
 */
function redactedThrow(err: unknown, forms: FormSet | null): unknown {
  if (forms === null || !(err instanceof Error)) return err;
  const message = redactSecrets(err.message, forms);
  if (message !== err.message) err.message = message;
  if (typeof err.stack === 'string') {
    const stack = redactSecrets(err.stack, forms);
    if (stack !== err.stack) err.stack = stack;
  }
  return err;
}

export interface WindowRun {
  /** canonicalSha256 of the window's manifest.json. */
  dataset_sha256: string;
  status: ExecutionStatus;
  error: string | null;
  /** The scored net PnL; null when the run failed or timed out. */
  net_pnl_lamports: string | null;
  action_log_sha256: string | null;
  wall_ms: number;
  flags: string[];
  stderr: Buffer;
}

/**
 * The entry run once on a frozen window as the grader runs it (one execution, not the grader's
 * determinism pair) and scored: the real run a stored run stands for (scripts/backtest/audit.ts runs
 * it when no stored net PnL is given), and each surrogate run of an audit. With `secrets` the bot gets
 * them, and nothing it returns or throws holds a form of a value (the header's entry secrets).
 */
export async function runOnWindow(o: WindowRunOptions): Promise<WindowRun> {
  const secrets = o.secrets === undefined || Object.keys(o.secrets).length === 0 ? undefined : o.secrets;
  const forms = entrySecretForms(secrets);
  try {
    parseU64(o.seed, 'hello seed');
    parseU64(o.failKey, 'fail key');
    const loaded = await readFrozenDataset(o.dataset, o.expectSha256 === undefined ? {} : { expectSha256: o.expectSha256 });
    const dataset = universeDataset(loaded.dataset, loaded.sample);
    const h = o.harness;
    const hello = makeHello({ seed: o.seed, sample: loaded.sample, capital_lamports: h.capital.lamports, caps: h.caps, latency_slots: h.latency_slots, fees: h.fees });
    const executed = await executeReplay({
      sandbox: o.sandbox,
      runtime: o.runtime,
      botDir: o.botDir,
      dataset,
      hello,
      limits: o.limits,
      label: o.label ?? 'audit',
      imageDigest: o.imageDigest ?? null,
      engine: { schemaCheck: true, failKey: o.failKey },
      ...(secrets === undefined ? {} : { secrets }),
    });
    // Masked however the replay ran it (the header's entry secrets); its action log never: it is scored.
    const e = maskExecution(executed, forms);
    let net: string | null = null;
    if (e.status === 'ok') {
      const scored = scoreActionLog(dataset, e.log!, { guardrails: h.guardrails, interval: h.interval, final_window: null }, { schemaCheck: true, failKey: o.failKey });
      net = scored.metrics.net_pnl_lamports;
    }
    return { dataset_sha256: dataset.sha256, status: e.status, error: e.error, net_pnl_lamports: net, action_log_sha256: e.log_sha256, wall_ms: e.wall_ms, flags: e.flags, stderr: e.stderr };
  } catch (err) {
    throw redactedThrow(err, forms);
  }
}

// ---------------------------------------------------------------- the entry's files

/**
 * Every regular file under a bot directory (its snapshot), by POSIX path from it. A `.git` directory
 * at its root is not part of a snapshot and is left out; symbolic links are not followed.
 */
export function readBotFiles(botDir: string): SnapshotFile[] {
  const root = resolve(botDir);
  const out: SnapshotFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (rel === '' && e.name === '.git') continue;
      const abs = join(dir, e.name);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs, path);
      else if (st.isFile()) out.push({ path, bytes: readFileSync(abs) });
    }
  };
  walk(root, '');
  return out.sort((a, b) => compareCodeUnits(a.path, b.path));
}

/** canonicalSha256 of the files as [path, sha256 of the bytes] pairs, by path. */
export function botFilesSha256(files: readonly SnapshotFile[]): string {
  const pairs = [...files].sort((a, b) => compareCodeUnits(a.path, b.path)).map((f) => [f.path, createHash('sha256').update(f.bytes).digest('hex')]);
  return canonicalSha256(pairs);
}

/**
 * The scan's view of an unmasked source window directory (it must verify): its records and its
 * manifest's excluded mints, with the records of `background` windows (public ones, such as the
 * competition's dev window) whose amounts are common knowledge.
 */
export function loadHindsightSource(dir: string, background: readonly string[] = []): HindsightSource {
  const read = (d: string, role: string): { records: ChainEventT[]; excluded: { mint: string }[] } => {
    const v = verifyDataset(d);
    if (!v.ok) throw new AuditError('invalid_options', `${role} ${d} does not verify (${v.status ?? 'no manifest'}): ${v.problems.slice(0, 3).join('; ')}`);
    const manifest = DatasetManifest.parse(readManifest(d));
    return { records: readDatasetRecords(d, manifest), excluded: manifest.excluded_mints.map((x) => ({ mint: x.mint })) };
  };
  const src = read(resolve(dir), 'the source');
  const bg = background.flatMap((d) => read(resolve(d), 'background window').records);
  return { records: src.records, excluded_mints: src.excluded, ...(bg.length > 0 ? { background: bg } : {}) };
}

// ---------------------------------------------------------------- the audit

/** One finished run, for progress and timing (opts.onRun): what the record keeps, and what it leaves out. */
export interface AuditRunEvent extends AuditRunT {
  rung: AuditRung;
  wall_ms: number;
  flags: string[];
  stderr: Buffer;
}

export interface AuditOptions {
  sandbox: Sandbox;
  runtime: Runtime;
  /** The entry's files (mounted read-only at /bot; also what the scan reads and bot_sha256 names). */
  botDir: string;
  /** The competition's pumpfun-replay/v2 harness. */
  harness: z.infer<typeof ReplayHarness>;
  limits: LimitsT;
  real: {
    /** The drawn masked window's directory: what the entry was graded on and what every surrogate is built from. */
    dataset: string;
    /** Refuse the window unless its manifest digest is this one (the stored run's dataset_sha256). */
    dataset_sha256?: string;
    /** The real run's hello seed (u64 decimal). */
    seed: string;
    /** The real run's fail key (u64 decimal). */
    failKey: string;
    /** The real run's net PnL as stored (never re-derived). */
    net_pnl_lamports: string | bigint;
  };
  /** The unmasked source for the static scan (a dataset directory, a HindsightSource or an index); null or absent: no scan. */
  source?: string | HindsightSource | HindsightIndex | null;
  /** Addresses the scan never counts: the entrant's own wallets. */
  ignoreAddresses?: Iterable<string>;
  /** Surrogates per rung (default check.m). */
  m?: number;
  /** A master secret (auditSeeds), or m seeds per rung. */
  seeds: string | AuditSeeds;
  /**
   * The rungs to build and run (default both, AUDIT_RUNGS). Every rung left out comes from `reuse`.
   * Not part of the check: the record and its verdict are the ones a full audit gives.
   */
  rungs?: readonly AuditRung[];
  /**
   * A rung this audit does not run, as an earlier audit of the same bot and window under the same seeds
   * and the same rung parameters recorded it (its record's twin or blocks): m runs, each under this
   * audit's seed for it. Calibration reuses the block rung across its twin sigmas.
   */
  reuse?: Partial<Record<AuditRung, ReusedRung>>;
  /** Default CHEAT_CHECK. */
  check?: CheatCheck;
  /** Where the surrogates are written (default a fresh private directory under the system temporary directory, removed after). */
  workDir?: string;
  /** Keep every surrogate (and its report) under workDir instead of removing each after its run. */
  keep?: boolean;
  /** Runs at once (default 1): the bots run in parallel, while building, replaying and scoring share this process. */
  concurrency?: number;
  /** Container name stem (default `audit`). */
  label?: string;
  imageDigest?: string | null;
  /**
   * The env-lane entry secrets the real run ran with, NAME to value (the header's `secrets`): every surrogate run gets
   * them, masked out of its error, its stderr and whatever it throws. Absent or empty: none.
   */
  secrets?: Readonly<Record<string, string>>;
  onRun?: (run: AuditRunEvent) => void;
}

function positiveInt(v: number, what: string): number {
  if (!Number.isSafeInteger(v) || v < 1) throw new AuditError('invalid_options', `${what} must be a positive integer, got ${v}`);
  return v;
}

function seedsOf(seeds: string | AuditSeeds, m: number): AuditSeeds {
  if (typeof seeds === 'string') return auditSeeds(seeds, m);
  for (const rung of AUDIT_RUNGS) {
    const list = seeds?.[rung];
    if (!Array.isArray(list) || list.length !== m) throw new AuditError('invalid_options', `seeds.${rung} must list m = ${m} seeds`);
    list.forEach((s, i) => {
      if (typeof s !== 'string' || s.length === 0) throw new AuditError('invalid_options', `seeds.${rung}[${i}] must be a non-empty string`);
    });
    if (new Set(list).size !== m) throw new AuditError('invalid_options', `seeds.${rung} repeats a seed`);
  }
  return { twin: [...seeds.twin], blocks: [...seeds.blocks] };
}

/** The surrogate params a rung built under `check` records (its report's names), as far as the check sets them. */
function checkParamsOf(rung: AuditRung, check: CheatCheck): Record<string, unknown> {
  if (rung === 'twin') {
    const t = twinOptionsOf(check);
    return { sigma: t.sigma, shift_slots: t.shiftSlots };
  }
  const b = blockOptionsOf(check);
  return { mean: b.mean, sigma: b.sigma, edges: b.edges, min_pool: b.minPool, complete_from_real_quote_sol: b.completeFromRealQuoteSol, quiet_tail_slots: b.quietTailSlots };
}

/**
 * The rungs an audit runs and the ones it reuses (AuditOptions.rungs, reuse): every rung is exactly
 * one of the two, and a reused one is m runs, numbered in order, each under this audit's seed for it,
 * built with the surrogate params this audit's check gives.
 */
function rungPlan(selected: readonly AuditRung[] | undefined, reuse: AuditOptions['reuse'], seeds: AuditSeeds, m: number, check: CheatCheck): { run: AuditRung[]; reused: Partial<Record<AuditRung, ReusedRung>> } {
  const run = selected === undefined ? [...AUDIT_RUNGS] : [...selected];
  if (run.length === 0) throw new AuditError('invalid_options', 'rungs must name at least one rung to run (twin, blocks)');
  for (const r of run) if (!(AUDIT_RUNGS as readonly string[]).includes(r)) throw new AuditError('invalid_options', `rungs: ${JSON.stringify(r)} is not a rung (${AUDIT_RUNGS.join(', ')})`);
  if (new Set(run).size !== run.length) throw new AuditError('invalid_options', 'rungs names a rung twice');
  const reused: Partial<Record<AuditRung, ReusedRung>> = {};
  for (const rung of AUDIT_RUNGS) {
    const given = reuse?.[rung];
    if (run.includes(rung)) {
      if (given !== undefined) throw new AuditError('invalid_options', `reuse.${rung}: the ${rung} rung is run by this audit, so it is not reused too`);
      continue;
    }
    if (given === undefined) throw new AuditError('invalid_options', `the ${rung} rung is neither run (rungs) nor reused (reuse.${rung})`);
    const parsed = Rung.safeParse(given);
    if (!parsed.success) throw new AuditError('invalid_options', `reuse.${rung} is not a rung of an audit record: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    for (const [key, want] of Object.entries(checkParamsOf(rung, check))) {
      if (canonicalJson(parsed.data.params[key] ?? null) !== canonicalJson(want)) {
        throw new AuditError('invalid_options', `reuse.${rung} was built with ${key} ${canonicalJson(parsed.data.params[key] ?? null)}, not this check's ${canonicalJson(want)}`);
      }
    }
    const runs = parsed.data.runs;
    if (runs.length !== m) throw new AuditError('invalid_options', `reuse.${rung} holds ${runs.length} runs, m is ${m}`);
    runs.forEach((r, i) => {
      if (r.index !== i) throw new AuditError('invalid_options', `reuse.${rung} run ${i} is numbered ${r.index}`);
      if (r.seed !== seeds[rung][i]) throw new AuditError('invalid_options', `reuse.${rung} run ${i} was not run under this audit's seed for it: only an audit of the same bot and window under the same seeds is reused`);
    });
    reused[rung] = parsed.data;
  }
  return { run, reused };
}

async function inPool<T, R>(items: readonly T[], width: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failure: { err: unknown } | null = null;
  const worker = async () => {
    for (let i = next++; i < items.length && failure === null; i = next++) {
      try {
        out[i] = await f(items[i]!);
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  if (failure !== null) throw (failure as { err: unknown }).err;
  return out;
}

/** Audit one entry (header): build the surrogates, run and score the entry on each, and return the record with its verdict. */
export async function auditEntry(o: AuditOptions): Promise<HindsightAuditRecordT> {
  const check = o.check ?? CHEAT_CHECK;
  const m = positiveInt(o.m ?? check.m, 'm');
  const concurrency = positiveInt(o.concurrency ?? 1, 'concurrency');
  const seeds = seedsOf(o.seeds, m);
  const plan = rungPlan(o.rungs, o.reuse, seeds, m, check);
  const twinOpts = twinOptionsOf(check);
  const blockOpts = blockOptionsOf(check);
  parseU64(o.real.seed, 'the real hello seed');
  parseU64(o.real.failKey, 'the real fail key');
  const realNet = typeof o.real.net_pnl_lamports === 'bigint' ? o.real.net_pnl_lamports.toString() : o.real.net_pnl_lamports;
  if (!Lamports.safeParse(realNet).success) throw new AuditError('invalid_options', `the real net PnL ${JSON.stringify(realNet)} is not a decimal lamport amount`);

  const window = resolve(o.real.dataset);
  const windowSha256 = canonicalSha256(readManifest(window));
  if (o.real.dataset_sha256 !== undefined && o.real.dataset_sha256 !== windowSha256) {
    throw new AuditError('window_mismatch', `${window} is dataset ${windowSha256}, not the real run's ${o.real.dataset_sha256}`);
  }

  const files = readBotFiles(o.botDir);
  let scan: HindsightScanT | null = null;
  if (o.source !== undefined && o.source !== null) {
    const source = typeof o.source === 'string' ? loadHindsightSource(o.source) : o.source;
    scan = hindsightScan(files, source, { check, ...(o.ignoreAddresses === undefined ? {} : { ignoreAddresses: o.ignoreAddresses }) });
  }

  if (o.keep && o.workDir === undefined) throw new AuditError('invalid_options', 'keep needs a workDir to keep the surrogates in');
  await o.sandbox.preflight(o.runtime, o.imageDigest ?? null);
  const ownWork = o.workDir === undefined;
  const work = ownWork ? mkdtempSync(join(tmpdir(), 'hindsight-audit-')) : resolve(o.workDir!);
  if (!ownWork) mkdirSync(work, { recursive: true, mode: 0o700 });
  const params: Record<AuditRung, Record<string, unknown> | null> = { twin: plan.reused.twin?.params ?? null, blocks: plan.reused.blocks?.params ?? null };
  const jobs = AUDIT_RUNGS.filter((rung) => plan.run.includes(rung)).flatMap((rung) => seeds[rung].map((seed, index) => ({ rung, index, seed })));
  // never build over (and so never remove) what an earlier audit left in a given work directory
  for (const { rung, index } of jobs) {
    const dir = join(work, surrogateDirName(rung, index));
    for (const path of [dir, `${dir}.report.json`]) if (existsSync(path)) throw new AuditError('invalid_options', `${path} exists: the work directory must not hold this audit's surrogates already`);
  }
  const created: string[] = [];
  const remove = (dir: string) => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.report.json`, { force: true });
  };

  try {
    const runs = await inPool(jobs, concurrency, async ({ rung, index, seed }): Promise<AuditRunT> => {
      const name = surrogateDirName(rung, index);
      const dir = join(work, name);
      created.push(dir);
      const key = surrogateKey(rung, seed);
      let built;
      try {
        built = rung === 'twin' ? twinDataset(window, dir, { key, seed, id: name, ...twinOpts }) : blockDataset(window, dir, { key, seed, id: name, ...blockOpts });
      } catch (err) {
        if (err instanceof SurrogateError) throw new AuditError('surrogate_failed', `${rung} surrogate ${index + 1} of ${window}: ${err.message}`, { cause: err });
        throw err;
      }
      params[rung] ??= built.report.params;
      try {
        const r = await runOnWindow({
          sandbox: o.sandbox,
          runtime: o.runtime,
          botDir: o.botDir,
          harness: o.harness,
          limits: o.limits,
          dataset: dir,
          expectSha256: built.report.output_dataset_sha256,
          seed: o.real.seed,
          failKey: o.real.failKey,
          label: `${o.label ?? 'audit'}-${name}`,
          imageDigest: o.imageDigest ?? null,
          ...(o.secrets === undefined ? {} : { secrets: o.secrets }),
        });
        const run: AuditRunT = {
          index,
          seed,
          dataset_sha256: r.dataset_sha256,
          status: r.status,
          error: r.error,
          net_pnl_lamports: r.net_pnl_lamports ?? '0',
          action_log_sha256: r.action_log_sha256,
        };
        o.onRun?.({ ...run, rung, wall_ms: r.wall_ms, flags: r.flags, stderr: r.stderr });
        return run;
      } finally {
        if (!o.keep) remove(dir);
      }
    });

    const byRung = (rung: AuditRung): AuditRunT[] => plan.reused[rung]?.runs ?? runs.filter((_, i) => jobs[i]!.rung === rung);
    const twin = byRung('twin');
    const blocks = byRung('blocks');
    const failed = [...twin.map((r) => ({ rung: 'twin' as const, r })), ...blocks.map((r) => ({ rung: 'blocks' as const, r }))]
      .filter(({ r }) => r.status !== 'ok')
      .map(({ rung, r }) => ({ rung, index: r.index, status: r.status as 'failed' | 'timeout', error: r.error ?? '' }));
    const verdict: HindsightVerdictT = hindsightVerdict({ real: { net_pnl_lamports: realNet }, twin: { runs: twin }, blocks: { runs: blocks }, scan }, check);
    return HindsightAuditRecord.parse({
      schema: AUDIT_SCHEMA,
      cheat_check: { version: check.version, provisional: check.provisional, sha256: cheatCheckSha256(check) },
      m,
      runtime: o.runtime,
      bot_sha256: botFilesSha256(files),
      real: { dataset_sha256: windowSha256, seed: o.real.seed, net_pnl_lamports: realNet },
      twin: { params: params.twin!, runs: twin },
      blocks: { params: params.blocks!, runs: blocks },
      failed,
      scan,
      verdict,
    });
  } finally {
    if (!o.keep) {
      for (const dir of created) remove(dir);
      if (ownWork) rmSync(work, { recursive: true, force: true });
    }
  }
}
