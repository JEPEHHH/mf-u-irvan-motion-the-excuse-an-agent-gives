// A scrape/v1 heat (contracts/scrape.ts): every entry, the house baseline among them, run once a round
// in an order drawn from a public drand round (randomized multiple interleaved trials, Abedi & Brecht,
// ICPE 2017), each trial through grader/scrape/trial.ts runScrapeTrial and judged by grader/scrape/
// score.ts judgeScrapeTrial. runScrapeHeat runs one and returns each entry's trials manifest
// (agent-fun/scrape-trials/v1) and the heat record (agent-fun/scrape-heat/v1).
//
//   the seed         scrapeHeatSeed(round, signature) = sha256(utf8(SCRAPE_HEAT_FORMAT) || u64be(round)
//                    || the signature's 48 bytes): the drand round the caller drew (and verified, as
//                    instance draws do) names it. Every part after the domain has a fixed length
//   the orders       scrapeHeatOrder(seed, stage, r, field): a Fisher-Yates shuffle of the field sorted
//                    by submission id (code units), from i = n-1 down to 1 swapping i with j uniform in
//                    0..i. j is drawn from a byte stream of blocks sha256(seed's 32 bytes || utf8(stage) ||
//                    0x00 || u32be(r) || u32be(counter)), counter 0, 1, 2, ... read as big-endian u32
//                    words x, kept when x < 2^32 - (2^32 mod (i+1)) (rejection: no modulo bias), j = x
//                    mod (i+1). Both are pure, so a kit re-derives every order from the heat record's
//                    drand round alone. order[0] runs first
//   the reference    at heat start the house reads the routes itself through the same gateway: a trial of
//                    `reference` (the house baseline's snapshot, say) under the entry id
//                    SCRAPE_REFERENCE_ENTRY. Its cassette is the heat's reference read
//                    (heatReferenceSha256), which judgeScrapeTrial mounts at /reference/heat/ for every
//                    trial, and the heat record names it (reference_cassette_sha256). It is judged
//                    against itself first and must be correct: a void, a fault or an incorrect read is
//                    tried again (SCRAPE_REFERENCE_ATTEMPTS in all), and a scorer that cannot use it
//                    stops the heat before any entrant runs (ScrapeHeatError)
//   the stages       heat.warmup_rounds warm-up rounds (untimed: never judged, never listed, a void
//                    never re-run), then heat.rounds main rounds, then the playoff. Each timed trial is
//                    judged as soon as it ends, inside the pacing gap before the next one, so the
//                    scorer's sandbox never runs during a timed trial and cooldown_ms counts from the
//                    judging's end
//   voids            a void (trial.ts: an infrastructure fault) is never listed. It re-runs at the end of
//                    its round, at most SCRAPE_MAX_VOID_RERUNS times; one still void then gets one make-up
//                    round after its stage's last round, with the same re-runs at its end; one void past
//                    that stops the heat (ScrapeHeatError). It keeps its place in its round's order as
//                    its position. voids_rerun counts every void of a listed trial (each was re-run)
//   judged voids     a timed trial the scorer finds incorrect is judged once more with its own cassette
//                    mounted at /reference/heat/ in place of the heat's reference read. Correct then, it
//                    failed on the reference read alone: on how the upstream served the same request since
//                    the heat began, never on what the entry wrote (roblox-top100-scrape-01: Roblox's chart
//                    a row short for every reader at once, 15 responses in a row in #2221's rehearsal heat;
//                    the root's ruling). It is void (judged_void SCRAPE_JUDGED_VOID) and re-runs under the
//                    voids rule above, voids_rerun counting it, for the house baseline as for any entrant.
//                    Its attempt keeps outcome 'run': such voids hit every entrant in their window, so the
//                    voids review (grader/worker.ts scrapeVoidsReview, which counts outcome 'void') counts
//                    them apart. A second judging that faults voids nothing (the trial stays incorrect),
//                    but one that disagrees with itself leaves the run unscored as any disagreement does.
//                    The reference read, warm-ups and trials with a harness fault are never judged twice
//   the playoff      once the main stage is judged, each run's main standing (score.ts scrapePerformance,
//                    stage 'main') is ordered by compareScrapeRuns (an exact tie to the run listed first
//                    in `entries`: the caller lists them in receipt order); the best heat.playoff.places
//                    ranked runs, the house baseline among them if it ranks there, run playoff.rounds more
//                    interleaved rounds among themselves. It runs only when both are above 0 and at least
//                    two runs rank: one finalist alone would only spend the upstream's budget
//   one CA, one resolution   the heat makes one CA (ca.ts createHeatCa, its key only in this heat's
//                    memory) and one leaf per listed host, and resolves every host once (IPv4: both trial
//                    networks run with IPv6 off) before its first trial. A void whose cassette shows a
//                    dial failure (upstream_unavailable) re-resolves that host and appends the new
//                    resolution to the record's `upstream`: the gateway dials only a host's last
//   the scorer       a ScorerError judging a trial is the house's (the competition's scorer), never the
//                    entry's: one that is not a disagreement is tried once more; a disagreement, or a
//                    second fault, leaves that run unscored (trials null, scorer_faults listed: the
//                    pipeline holds it ineligible) and outside the playoff, and the heat goes on: its
//                    later trials still run, so every round keeps its whole field, but are not judged.
//                    Its unjudged trials (`runs`) are kept for an L1 re-judging
//
// Pacing (ScrapePacer), before every trial, the reference read and warm-ups included. The next trial
// starts when every rule holds; until then the heat sleeps for the longest wait:
//   cooldown         heat.cooldown_ms since the last trial's end (and its judging)
//   paced hosts      a host with an IP-wide limiter that no header shows (SCRAPE_PACING_DEFAULTS:
//                    games.roblox.com, #2204's ~11-call bucket refilling ~1 per 3 s; the root's ruling,
//                    at most 14 calls a minute across the host, never more than 2 in a burst). A virtual
//                    schedule (GCRA): T = 60000 / per_minute ms, and after each trial its calls on the
//                    host (forwarded or upstream_error, from its cassette; the host's whole cap when there
//                    is none) are charged at the trial's END, the latest they can have been made:
//                    tat = max(tat, end) + calls x T. A trial starts when tat - (burst - cap) x T <= now,
//                    cap the host's routes' request caps summed: so no trial can make more than `burst`
//                    calls before the debt is paid, and none can make more than per_minute a minute. A
//                    harness whose cap on such a host exceeds its burst is refused before anything runs
//   metered buckets  a route whose responses carry x-ratelimit-limit / -remaining (Roblox's fixed
//                    UTC-minute buckets per egress IP, #2184: chart 50, games 300). Its predicted remaining
//                    is the lowest x-ratelimit-remaining of the last cassette that had one, while the
//                    upstream may still be in that cassette's minute, else the bucket's full limit. It
//                    must be at least the route's cap + (limit - floor(limit x budget_pct / 100)), at
//                    least cap + 1: the heat, with whatever else the upstream counted, takes at most
//                    budget_pct (70%, #2192) of a bucket a minute; else the heat waits for :00. A cap
//                    above budget_pct of a limit can never run (ScrapeHeatError). Once any bucket is
//                    metered, a trial also starts only with at least cap_ms to the reset: never in the
//                    last cap_ms of a minute
//   the clocks       the grader's clock is taken to be within skew_ms of the upstream's: a cassette is
//                    counted in the minute of its trial's end plus skew_ms (the latest it can belong to),
//                    it stops predicting skew_ms after that minute ends, and "wait for :00" waits until
//                    skew_ms past it. Every minute is a UTC minute of Unix time
//   upstream errors  a void with an upstream_error (the upstream's own 429 or 5xx) holds the heat until
//                    the next :00, so every minute bucket has reset before the next trial
//
// The arithmetic (scrapeTrialGapMs, scrapeHeatTrialCount): with games.roblox.com at 14 a minute, a
// details cap of 2 a trial holds ceil(2 x 60000 / 14) = 8572 ms between a trial's end and the next
// start, and a cap of 4 would need 17143 ms and break the burst of 2 (refused). A field of 10 runs at
// the defaults (1 warm-up, 15 main, a playoff of 12 places and 30 rounds: all 10 are finalists) is 1 +
// 10 x 16 + 10 x 30 = 461 trials: at least 461 x 8572 ms = 65.9 min of gaps, plus each trial's own
// run time. A cap of 2 is what fits one honest read (a chart of 99 rows in two 50-id details calls).
//
// The host lease (acquireScrapeHostLease): a heat is exclusive to its host's egress, so two grading pods
// never run two heats against one egress address (a speed competition measures the address). The lease is
// a scrape_heat_lease row (server/db/schema.ts) named for the host's lease directory (SCRAPE_LEASE_FILE:
// one name, one egress): taken by one insert when the row is free or has expired, heartbeated every
// SCRAPE_LEASE_HEARTBEAT_MS while the heat runs, released however it ends, and taken over only once its
// expiry has passed (a pod killed mid-heat leaves it to expire). A heat that finds a live one stops
// (ScrapeLeaseBusyError) and the worker holds its job until the lease is free; the heat checks it still
// holds the lease before every trial (ScrapeLeaseLostError when the row is no longer its take's, or has
// expired) and releases it however it ends. The row is the database the caller hands in (ScrapeLeaseDb: the grader's),
// else DATABASE_URL's (every pod of one deployment), as the served-repo leases' (server/repos/served-repo.ts); with
// neither (PGlite, a script) the lease is this process's own, in memory: PGlite is one process's by contract. The egress
// IP stays quiet but for the heat when every Roblox caller on the grading hosts (a practice heat, a final heat) runs
// through runScrapeHeat and so through the lease: the upstream's per-address rate buckets and the pacer's schedule
// (Pacing above) assume the heat is the address's only caller, which the lease keeps under every scope. What else it
// keeps off the host is the worker's lease scope (grader/worker.ts scrapeLeaseScopeOf, MAKEFUN_SCRAPE_LEASE_SCOPE).
// Under `host`, the default, the worker reads scrapeHostLeaseHolder to take no job of another type while a live lease
// is held, so the heat's trials have a CPU no other job shares. Under `egress` only another heat waits on it, and the
// CPU is reserved instead (ScrapeHeatOptions.reserveCpu: every trial's entry and gateway pod requests its whole CPU
// limit, trial.ts ScrapeTrialOptions.reserveCpu).
//
// Abort (opts.signal): the running trial is aborted (trial.ts), every wait ends, the lease is released,
// and runScrapeHeat rejects with the signal's reason. An engine that does not keep trials apart
// (network.ts IsolationRefusal) stops the heat as it stops a trial.
//
// Entry secrets (ScrapeHeatEntry.secrets: an entrant's env-lane ones, grader/worker.ts opens them): each
// entry's every trial runs with its own and nobody else's (trial.ts ScrapeTrialOptions.secrets: its
// launcher's stdin, its record masked, its /output scanned), warm-ups and re-runs alike, so its cassette is
// masked the same way in every round. The house's reference read runs with none: it is the house's read.
// What the heat keeps of a trial is masked again of that entry's values (grader/run.ts redactSecrets):
// its attempt's message (a fault's detail or a void's message) and a scorer fault's message (a scorer
// may quote an output). Where an entry's /output held a form of one, its run's secret_hits names the
// secret and the file (`<stage>/<round>/<attempt>/output/<path>`, as the attempts list them), never the
// value, for grader/worker.ts to flag the run secret_in_output.

import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { ScrapeHarnessT } from '../../contracts/competition.ts';
import {
  SCRAPE_HEAT_FORMAT,
  SCRAPE_HEAT_STAGES,
  SCRAPE_TRIALS_FORMAT,
  ScrapeEntryId,
  ScrapeHeat,
  ScrapeHeatConfig,
  ScrapeHeatId,
  ScrapeNetwork,
  ScrapeResolution,
  ScrapeTrials,
  scrapeTrialsHeatIssues,
  type ScrapeCassetteT,
  type ScrapeHeatConfigT,
  type ScrapeHeatRoundT,
  type ScrapeHeatT,
  type ScrapeNetworkT,
  type ScrapePerformanceT,
  type ScrapeStageT,
  type ScrapeTrialRecordT,
  type ScrapeTrialsT,
} from '../../contracts/scrape.ts';
import { compareCodeUnits } from '../../sim/canonical.ts';
import type { SecretOutputHit } from '../agent.ts';
import type { FormSet } from '../gateway/secret-mask.ts';
import type { OutputBlobs } from '../program.ts';
import { ScorerError } from '../program-scores.ts';
import { entrySecretForms, redactSecrets, type LimitsT } from '../run.ts';
import type { Runtime, Sandbox } from '../sandbox/types.ts';
import { createHeatCa, hostLeaves } from './ca.ts';
import { compareScrapeRuns, judgeScrapeTrial, ScorerDisagreementError, scrapePerformance, type JudgeScrapeTrialOptions, type ScrapeScored, type ScrapeScorerSetup, type ScrapeTrialRun as ScrapeJudgedRun } from './score.ts';
import { runScrapeTrial, type ScrapeFaultStatus, type ScrapeTrialHeat, type ScrapeTrialOptions, type ScrapeTrialOutcome, type ScrapeVoidReason } from './trial.ts';

// ---------------------------------------------------------------- constants

/** The seed's domain: the heat record's format. */
export const SCRAPE_HEAT_SEED_DOMAIN = SCRAPE_HEAT_FORMAT;
/** How many times a void re-runs at the end of its round (and again at the end of its make-up round). */
export const SCRAPE_MAX_VOID_RERUNS = 3;
/** How many times the house's reference read is tried before the heat stops. */
export const SCRAPE_REFERENCE_ATTEMPTS = 1 + SCRAPE_MAX_VOID_RERUNS;
/** The entry id the reference read runs under (its trial owner `scrape-<heat>.house-reference.0`); no entrant may take it. */
export const SCRAPE_REFERENCE_ENTRY = 'house-reference';
/** How many times a trial is judged when the scorer faults without disagreeing with itself. */
export const SCRAPE_JUDGE_ATTEMPTS = 2;
/** Why the heat voids a run at its judging (the header's judged voids): incorrect against the heat's reference read, correct against its own cassette. */
export const SCRAPE_JUDGED_VOID = 'reference_only';
export type ScrapeJudgedVoid = typeof SCRAPE_JUDGED_VOID;
/** The host lease's name under its directory (its row's key: one name, one egress), and the holder info's format. */
export const SCRAPE_LEASE_FILE = 'scrape-heat.lease';
export const SCRAPE_LEASE_FORMAT = 'agent-fun/scrape-lease/v1';
/** How long a lease row lives without a heartbeat: a pod killed mid-heat leaves it to expire. */
export const SCRAPE_LEASE_TTL_MS = 180_000;
/** How often a held lease's row is pushed out (a third of its life), while the heat runs. */
export const SCRAPE_LEASE_HEARTBEAT_MS = SCRAPE_LEASE_TTL_MS / 3;
/** A minute, in ms. */
const MINUTE_MS = 60_000;
/** The most addresses one resolution holds (ScrapeResolution). */
const MAX_IPS = 8;
/** A drand signature: quicknet's 48 bytes, lowercase hex. */
const SIGNATURE_RE = /^[0-9a-f]{96}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

type ScrapeHeatStageT = (typeof SCRAPE_HEAT_STAGES)[number];
type ScrapeResolutionT = z.infer<typeof ScrapeResolution>;

// ---------------------------------------------------------------- errors

/** The heat cannot go on: a trial voided past its re-runs, the reference read failed, a bucket too small for a cap, a host that would not resolve. */
export class ScrapeHeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrapeHeatError';
  }
}

/** Another heat holds this egress's lease. */
export class ScrapeLeaseBusyError extends Error {
  readonly holder: ScrapeLeaseInfo | null;

  constructor(holder: ScrapeLeaseInfo | null, message: string) {
    super(message);
    this.name = 'ScrapeLeaseBusyError';
    this.holder = holder;
  }
}

/** The lease is no longer this heat's: another heat took the egress (the row was released or expired, then taken). */
export class ScrapeLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrapeLeaseLostError';
  }
}

// ---------------------------------------------------------------- the seed and the orders

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** The heat's seed (the header): sha256(utf8(SCRAPE_HEAT_SEED_DOMAIN) || u64be(round) || the signature's 48 bytes), lowercase hex. RangeError on a malformed round or signature. */
export function scrapeHeatSeed(round: number, signature: string): string {
  if (!Number.isSafeInteger(round) || round < 1) throw new RangeError(`drand round ${String(round)} is not a whole number from 1`);
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) throw new RangeError('a drand signature is 96 lowercase hex (48 bytes)');
  const r = Buffer.alloc(8);
  r.writeBigUInt64BE(BigInt(round));
  return createHash('sha256').update(Buffer.from(SCRAPE_HEAT_SEED_DOMAIN, 'utf8')).update(r).update(Buffer.from(signature, 'hex')).digest('hex');
}

/** sha256 of a drand signature's bytes: the heat record's drand.signature_sha256. */
export function scrapeSignatureSha256(signature: string): string {
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) throw new RangeError('a drand signature is 96 lowercase hex (48 bytes)');
  return createHash('sha256').update(Buffer.from(signature, 'hex')).digest('hex');
}

/** A draw of j uniform in 0..bound-1 from the round's byte stream (the header), as a closure over its position. */
function drawStream(seed: string, stage: ScrapeHeatStageT, round: number): (bound: number) => number {
  const prefix = Buffer.concat([Buffer.from(seed, 'hex'), Buffer.from(stage, 'utf8'), Buffer.from([0]), u32be(round)]);
  let counter = 0;
  let block = Buffer.alloc(0);
  let at = 0;
  const word = (): number => {
    if (at + 4 > block.length) {
      block = createHash('sha256').update(prefix).update(u32be(counter)).digest();
      counter++;
      at = 0;
    }
    const x = block.readUInt32BE(at);
    at += 4;
    return x;
  };
  return (bound) => {
    const limit = 2 ** 32 - (2 ** 32 % bound);
    for (;;) {
      const x = word();
      if (x < limit) return x % bound;
    }
  };
}

/**
 * The order of `stage` round `round` (the header): a Fisher-Yates permutation of `field` sorted by
 * code units, drawn from the seed. The field is entry ids, each once. RangeError or TypeError on a
 * malformed argument.
 */
export function scrapeHeatOrder(seed: string, stage: ScrapeHeatStageT, round: number, field: readonly string[]): string[] {
  if (typeof seed !== 'string' || !SHA256_RE.test(seed)) throw new RangeError('the seed is 64 lowercase hex');
  if (!(SCRAPE_HEAT_STAGES as readonly string[]).includes(stage)) throw new RangeError(`stage ${JSON.stringify(stage)} is not one of ${SCRAPE_HEAT_STAGES.join(', ')}`);
  if (!Number.isSafeInteger(round) || round < 0 || round > 0xffff_ffff) throw new RangeError(`round ${String(round)} is not a whole number from 0 to ${0xffff_ffff}`);
  if (!Array.isArray(field) || field.length === 0) throw new TypeError('a round orders at least one entry');
  for (const id of field) if (!ScrapeEntryId.safeParse(id).success) throw new TypeError(`${JSON.stringify(id)} is not an entry id (1..40 of a-z 0-9 -)`);
  if (new Set(field).size !== field.length) throw new TypeError('the field lists an entry twice');
  const order = [...field].sort(compareCodeUnits);
  const draw = drawStream(seed, stage, round);
  for (let i = order.length - 1; i > 0; i--) {
    const j = draw(i + 1);
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  return order;
}

// ---------------------------------------------------------------- the host lease

/** What a held lease reports: who took the egress for which heat, and the nonce only the holder knows. */
export interface ScrapeLeaseInfo {
  format: typeof SCRAPE_LEASE_FORMAT;
  heat: string;
  pid: number;
  hostname: string;
  nonce: string;
  acquired_at: string;
}

/**
 * What this module needs of a database for the lease: one statement, its rows back (a drizzle Db, server/db/client.ts
 * Db). A caller hands its own in; with none the module opens DATABASE_URL's (environmentLeaseDb), loaded by a URL the
 * kit's command line's bundler does not follow, so no driver rides in it (cli/regrade.ts imports this module).
 */
export interface ScrapeLeaseDb {
  execute(query: SQL): Promise<unknown>;
}

/** What names a lease: the host's one lease directory, and the database its row lives in (none: DATABASE_URL's, else this process alone). */
export interface ScrapeLeaseWhere {
  /** The host's lease directory: `<dir>/SCRAPE_LEASE_FILE` is the lease's name, one per egress. */
  dir: string;
  db?: ScrapeLeaseDb;
}

export interface ScrapeHostLease {
  readonly info: ScrapeLeaseInfo;
  /** The lease's name: its row's key. */
  readonly name: string;
  /** Rejects with ScrapeLeaseLostError unless the lease is still this take's and unexpired. */
  check(): Promise<void>;
  /** Push the lease's expiry out once (what its timer does while it is held); false when it is no longer this take's (a beat that could not run counts true: it proves nothing either way). */
  heartbeat(): Promise<boolean>;
  /** Give the lease up (idempotent; never throws). */
  release(): Promise<void>;
}

/** What a live lease reports: its holder's info, or null for a row that does not read (held, but not tellable). */
export interface ScrapeHeldLease {
  info: ScrapeLeaseInfo | null;
  live: true;
}

/** What a take found: the lease is this take's, or another's (null when it went as it was read). */
type Taken = { kind: 'taken'; info: ScrapeLeaseInfo } | { kind: 'busy'; holder: ScrapeLeaseInfo | null };

/** A lease, wherever its row lives: the database every pod of the egress shares, or this process's own memory. */
interface ScrapeLeases {
  /** Take `lease` for `heat` when it is free (no row, or one whose expiry has passed). */
  take(o: { lease: string; heat: string; nonce: string; now: number }): Promise<Taken>;
  /** The live lease of `name`, whoever holds it; null when none. */
  holder(name: string): Promise<ScrapeHeldLease | null>;
  /** Push the row's expiry out; false when it is no longer this take's (released, expired or taken over). */
  heartbeat(name: string, nonce: string): Promise<boolean>;
  /** Drop the row when it is still this take's. */
  release(name: string, nonce: string): Promise<void>;
}

/** The pod's name in a lease row: os.hostname(), which is the pod's name under Kubernetes, or the machine's. */
function holderName(): string {
  return osHostname() || 'unknown';
}

/** A lease row as the holder reports it; null for a row whose columns do not read (never one this module wrote). */
function leaseInfo(row: Record<string, unknown>): ScrapeLeaseInfo | null {
  const { heat, nonce, holder } = row;
  const pid = Number(row.pid);
  const at = row.acquired_at;
  const acquired = at instanceof Date ? at : typeof at === 'string' ? new Date(at) : null;
  if (typeof heat !== 'string' || typeof nonce !== 'string' || typeof holder !== 'string') return null;
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (acquired === null || Number.isNaN(acquired.getTime())) return null;
  return { format: SCRAPE_LEASE_FORMAT, heat, pid, hostname: holder, nonce, acquired_at: acquired.toISOString() };
}

/** A statement's rows: node-postgres and PGlite both answer `{ rows }`. */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/** The lease's name in its store: the host's lease directory, and SCRAPE_LEASE_FILE's name, which already named one egress. */
function leaseName(dir: string): string {
  return join(dir, SCRAPE_LEASE_FILE);
}

/** Who holds a lease, in words: what a busy heat and a waiting job say. */
function heldBy(info: ScrapeLeaseInfo | null): string {
  return info === null ? 'a lease that went as it was read' : `heat ${info.heat} (pid ${info.pid} on ${info.hostname}, since ${info.acquired_at})`;
}

/** The lease rows of every pod sharing a database (scrape_heat_lease, server/db/schema.ts). */
function databaseLeases(db: ScrapeLeaseDb): ScrapeLeases {
  const ttl = SCRAPE_LEASE_TTL_MS / 1000;
  const readHolder = async (name: string): Promise<ScrapeHeldLease | null> => {
    const rows = rowsOf(await db.execute(sql`select heat, holder, pid, nonce, acquired_at from scrape_heat_lease where lease = ${name} and expires_at > now()`));
    if (rows[0] === undefined) return null;
    return { info: leaseInfo(rows[0]), live: true };
  };
  return {
    async take(o) {
      // One statement: the insert makes the row, or updates one whose expiry has passed and leaves a live one alone.
      const rows = rowsOf(
        await db.execute(sql`
          insert into scrape_heat_lease (lease, holder, heat, pid, nonce, acquired_at, expires_at)
          values (${o.lease}, ${holderName()}, ${o.heat}, ${process.pid}, ${o.nonce}, ${new Date(o.now)}, now() + make_interval(secs => ${ttl}))
          on conflict (lease) do update
            set holder = excluded.holder, heat = excluded.heat, pid = excluded.pid, nonce = excluded.nonce,
                acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
            where scrape_heat_lease.expires_at <= now()
          returning heat, holder, pid, nonce, acquired_at
        `),
      );
      const info = rows[0] === undefined ? null : leaseInfo(rows[0]);
      return info === null ? { kind: 'busy', holder: (await readHolder(o.lease))?.info ?? null } : { kind: 'taken', info };
    },
    holder: readHolder,
    async heartbeat(name, nonce) {
      // An expired row is not revived: another pod may have taken it in the gap, which this lease cannot tell.
      const rows = rowsOf(await db.execute(sql`update scrape_heat_lease set expires_at = now() + make_interval(secs => ${ttl}) where lease = ${name} and nonce = ${nonce} and expires_at > now() returning lease`));
      return rows.length > 0;
    },
    async release(name, nonce) {
      await db.execute(sql`delete from scrape_heat_lease where lease = ${name} and nonce = ${nonce}`);
    },
  };
}

/** The lease rows of this process alone, by name: a heat handed no database has only its own process to tell. */
const processRows = new Map<string, { info: ScrapeLeaseInfo; expiresAt: number }>();

function processLeases(): ScrapeLeases {
  return {
    async take(o) {
      const held = processRows.get(o.lease);
      // A lease's life is the process's wall clock, never the heat's (a test's clock starts wherever it likes): only
      // acquired_at reports the caller's now.
      if (held !== undefined && held.expiresAt > Date.now()) return { kind: 'busy', holder: held.info };
      const info: ScrapeLeaseInfo = {
        format: SCRAPE_LEASE_FORMAT,
        heat: o.heat,
        pid: process.pid,
        hostname: holderName(),
        nonce: o.nonce,
        acquired_at: new Date(o.now).toISOString(),
      };
      processRows.set(o.lease, { info, expiresAt: Date.now() + SCRAPE_LEASE_TTL_MS });
      return { kind: 'taken', info };
    },
    async holder(name) {
      const held = processRows.get(name);
      if (held === undefined) return null;
      if (held.expiresAt <= Date.now()) {
        processRows.delete(name);
        return null;
      }
      return { info: held.info, live: true };
    },
    async heartbeat(name, nonce) {
      const held = processRows.get(name);
      if (held === undefined || held.info.nonce !== nonce || held.expiresAt <= Date.now()) return false;
      held.expiresAt = Date.now() + SCRAPE_LEASE_TTL_MS;
      return true;
    },
    async release(name, nonce) {
      if (processRows.get(name)?.info.nonce === nonce) processRows.delete(name);
    },
  };
}

/** The store a lease lives in: the database the heat was handed, else this process's memory alone (PGlite's one process). */
function leasesOf(db: ScrapeLeaseDb | undefined): ScrapeLeases {
  return db === undefined ? processLeases() : databaseLeases(db);
}

/** The stores this process made for DATABASE_URL, and the handles that open them (one per process, as served-repo leases). */
const envStores = new Map<string, ScrapeLeaseDb>();

/**
 * The database a lease of this process's goes in when no caller hands one in: DATABASE_URL's, as the served-repo leases'
 * (server/repos/served-repo.ts servedRepoLeases), or null when there is none to share (no DATABASE_URL, or a pglite:
 * one: PGlite is one process's by contract, and the config refuses it in production). Every heat, every rejudge the
 * admin route runs, and every chain job's window check reads the same rows there, whichever module they are called from.
 */
async function environmentLeaseDb(): Promise<ScrapeLeaseDb | null> {
  const url = (process.env.DATABASE_URL ?? '').trim();
  if (!/^postgres(ql)?:\/\//i.test(url)) return null;
  const made = envStores.get(url);
  if (made !== undefined) return made;
  // Loaded by a URL esbuild does not follow: the kit's command line bundles this module (cli/regrade.ts) and carries no
  // database driver (server/kit/cli-bundle.ts). No kit command runs a heat, so nothing there comes this way.
  const clientUrl = new URL('../../server/db/client.ts', import.meta.url).href;
  const client = (await import(clientUrl)) as typeof import('../../server/db/client.ts');
  const handle = await client.openDb(url, { poolMax: 2, role: 'job' });
  envStores.set(url, handle.db);
  return handle.db;
}

/**
 * Who holds the lease of `o.dir` live: the row of the database the egress's pods share, this process's own take, or
 * null when no one does. A `dir` alone reads this process's own takes, and DATABASE_URL's rows when it names a shared
 * database (every pod of one egress runs on one). A worker takes no other scraping job while a live lease is held. A
 * database that cannot answer throws: a heat that cannot tell who holds the egress must not start beside one.
 */
export async function scrapeHostLeaseHolder(o: string | ScrapeLeaseWhere): Promise<ScrapeHeldLease | null> {
  const where = typeof o === 'string' ? { dir: o } : o;
  const name = leaseName(where.dir);
  const db = where.db ?? (await environmentLeaseDb());
  if (db !== undefined && db !== null) {
    const held = await databaseLeases(db).holder(name);
    if (held !== null) return held;
  }
  return processLeases().holder(name);
}

/**
 * Take the lease of `o.dir` for heat `o.heat` (the header): one insert, which wins when no live row holds it, so a
 * live lease rejects with ScrapeLeaseBusyError (a row whose expiry has passed is taken over). The row is the database's
 * the heat was handed, else DATABASE_URL's; with neither, the lease is this process's own, in memory. The holder
 * heartbeats it until it releases it.
 */
export async function acquireScrapeHostLease(o: ScrapeLeaseWhere & { heat: string; now?: number }): Promise<ScrapeHostLease> {
  if (!ScrapeHeatId.safeParse(o.heat).success) throw new TypeError(`heat ${JSON.stringify(o.heat)} is not a heat id (1..40 of a-z 0-9 -)`);
  const name = leaseName(o.dir);
  const store = leasesOf(o.db ?? (await environmentLeaseDb()) ?? undefined);
  const taken = await store.take({ lease: name, heat: o.heat, nonce: randomBytes(16).toString('hex'), now: o.now ?? Date.now() });
  if (taken.kind === 'busy') {
    throw new ScrapeLeaseBusyError(taken.holder, `the scrape host lease ${name} is held by ${heldBy(taken.holder)}: one heat at a time against one egress`);
  }
  return hostLease({ store, name, info: taken.info });
}

/** A taken lease: heartbeated until released, checked on demand (the heat checks it before every trial). */
function hostLease(o: { store: ScrapeLeases; name: string; info: ScrapeLeaseInfo }): ScrapeHostLease {
  const { store, name, info } = o;
  let released = false;
  let lost = false;
  const lostError = (): ScrapeLeaseLostError => new ScrapeLeaseLostError(`heat ${info.heat} no longer holds the scrape host lease ${name}: another heat took the egress`);
  const beat = async (): Promise<boolean> => {
    const ours = await store.heartbeat(name, info.nonce).catch(() => true); // a beat that could not run is no proof of a loss
    if (!ours) lost = true;
    return ours;
  };
  const timer = setInterval(() => void beat(), SCRAPE_LEASE_HEARTBEAT_MS);
  timer.unref();
  return Object.freeze({
    info: Object.freeze({ ...info }),
    name,
    heartbeat: beat,
    async check() {
      if (released) throw lostError();
      const held = await store.holder(name);
      if (lost || held === null || held.info?.nonce !== info.nonce) {
        lost = true;
        throw lostError();
      }
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await store.release(name, info.nonce).catch(() => undefined);
    },
  });
}

// ---------------------------------------------------------------- pacing

/** A host's IP-wide limiter no header shows (the header's paced hosts). */
export interface ScrapeHostPace {
  /** The most calls a minute the heat makes on the host. */
  per_minute: number;
  /** The most calls the heat lets happen at once. */
  burst: number;
}

export interface ScrapePacing {
  /** The share of a metered bucket the heat takes a minute at most, in percent (#2192: 70). */
  budget_pct: number;
  /** Bucket sizes by route id, known before a cassette names one (a cassette's x-ratelimit-limit wins once seen). */
  limits: Readonly<Record<string, number>>;
  /** Hosts with an IP-wide limiter no header shows. */
  hosts: Readonly<Record<string, ScrapeHostPace>>;
  /** How far the grader's clock may be from the upstream's, ms. */
  skew_ms: number;
}

/** Roblox's, as measured (the header): games.roblox.com's hidden limiter at the root's ruling, 70% of every metered bucket. */
export const SCRAPE_PACING_DEFAULTS: ScrapePacing = Object.freeze({
  budget_pct: 70,
  limits: Object.freeze({}),
  hosts: Object.freeze({ 'games.roblox.com': Object.freeze({ per_minute: 14, burst: 2 }) }),
  skew_ms: 1000,
});

const isWhole = (n: unknown, min: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;

function checkPacing(p: ScrapePacing): ScrapePacing {
  if (!isWhole(p.budget_pct, 1) || p.budget_pct > 100) throw new TypeError(`pacing.budget_pct ${String(p.budget_pct)} is not a whole percent from 1 to 100`);
  if (!isWhole(p.skew_ms, 0) || p.skew_ms > 10_000) throw new TypeError(`pacing.skew_ms ${String(p.skew_ms)} is not whole milliseconds from 0 to 10000`);
  for (const [route, limit] of Object.entries(p.limits)) if (!isWhole(limit, 1)) throw new TypeError(`pacing.limits.${route} ${String(limit)} is not a whole number from 1`);
  for (const [host, pace] of Object.entries(p.hosts)) {
    if (!isWhole(pace.per_minute, 1) || !isWhole(pace.burst, 1)) throw new TypeError(`pacing.hosts.${host} is not {per_minute, burst}, whole numbers from 1`);
  }
  return p;
}

/** The leading whole number of a rate-limit header ("50, 50;w=60" -> 50), or null. */
function headerInt(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^\s*([0-9]{1,15})/.exec(v);
  return m === null ? null : Number(m[1]);
}

/** Requests that reached (or were sent to) the upstream: what its buckets counted. */
const sentUpstream = (e: ScrapeCassetteT['entries'][number]): boolean => e.route !== null && (e.outcome === 'forwarded' || e.outcome === 'upstream_error');

/** The UTC minute (minutes since the epoch) of `ms`. */
const minuteOf = (ms: number): number => Math.floor(ms / MINUTE_MS);

interface HostDebt {
  host: string;
  cap: number;
  burst: number;
  /** ms per call: 60000 / per_minute. */
  interval: number;
  /** The virtual schedule's theoretical arrival time, ms (the header). */
  tat: number;
}

interface Bucket {
  route: string;
  cap: number;
  /** The bucket's size: a cassette's x-ratelimit-limit, else pacing.limits'. */
  limit: number | null;
  /** The last cassette's lowest x-ratelimit-remaining and the minute it is counted in; null until one is seen. */
  seen: { remaining: number; minute: number } | null;
}

/** Why the heat waits, and how long. */
export interface ScrapeWait {
  ms: number;
  why: string;
}

/**
 * The heat's pacing (the header's Pacing): `wait(now)` says how long the next trial must wait (null:
 * it may start now), `ran` charges a trial that ran from `start` to `end` with what its cassette shows,
 * `settled` marks the end of the last activity (the trial, or its judging) the cooldown counts from.
 */
export class ScrapePacer {
  readonly #capMs: number;
  readonly #cooldownMs: number;
  readonly #pacing: ScrapePacing;
  readonly #hosts: HostDebt[] = [];
  readonly #buckets = new Map<string, Bucket>();
  readonly #routeHost = new Map<string, string>();
  #metered = false;
  #settledAt: number | null = null;
  #holdUntil = Number.NEGATIVE_INFINITY;

  constructor(network: ScrapeNetworkT, heat: Pick<ScrapeHeatConfigT, 'cap_ms' | 'cooldown_ms'>, pacing: ScrapePacing = SCRAPE_PACING_DEFAULTS) {
    this.#capMs = heat.cap_ms;
    this.#cooldownMs = heat.cooldown_ms;
    this.#pacing = checkPacing(pacing);
    for (const r of network.routes) {
      this.#routeHost.set(r.id, r.host);
      const limit = Object.hasOwn(pacing.limits, r.id) ? pacing.limits[r.id]! : null;
      const cap = network.request_caps[r.id]!;
      if (limit !== null) {
        this.#metered = true;
        this.#checkBudget(r.id, cap, limit);
      }
      this.#buckets.set(r.id, { route: r.id, cap, limit, seen: null });
    }
    for (const host of network.hosts) {
      const pace = Object.hasOwn(pacing.hosts, host) ? pacing.hosts[host]! : undefined;
      if (pace === undefined) continue;
      const routes = network.routes.filter((r) => r.host === host);
      const cap = routes.reduce((s, r) => s + network.request_caps[r.id]!, 0);
      if (cap > pace.burst) {
        throw new ScrapeHeatError(
          `the routes on ${host} allow ${cap} requests a trial (${routes.map((r) => `${r.id} ${network.request_caps[r.id]}`).join(', ')}), more than its burst of ${pace.burst}: ${host} takes at most ${pace.burst} calls at once (its limiter shows in no header), so its routes' caps add up to at most ${pace.burst}`,
        );
      }
      this.#hosts.push({ host, cap, burst: pace.burst, interval: MINUTE_MS / pace.per_minute, tat: Number.NEGATIVE_INFINITY });
    }
  }

  /** A route whose cap cannot fit budget_pct of its bucket can never run. */
  #checkBudget(route: string, cap: number, limit: number): void {
    const budget = Math.floor((limit * this.#pacing.budget_pct) / 100);
    if (cap > budget || cap + 1 > limit) {
      throw new ScrapeHeatError(`the route ${route} allows ${cap} requests a trial, more than ${this.#pacing.budget_pct}% of its bucket of ${limit} a minute (${budget}): no trial could ever start`);
    }
  }

  /** The bucket's reserve: what a trial leaves of it, at least 1 (the header). */
  #reserve(limit: number): number {
    return Math.max(1, limit - Math.floor((limit * this.#pacing.budget_pct) / 100));
  }

  /** How long the next trial must wait at `now`, and why (the longest rule); null when it may start. */
  wait(now: number): ScrapeWait | null {
    let best: ScrapeWait | null = null;
    const need = (until: number, why: string): void => {
      const ms = Math.ceil(until - now);
      if (ms > 0 && (best === null || ms > best.ms)) best = { ms, why };
    };
    const skew = this.#pacing.skew_ms;
    if (this.#settledAt !== null) need(this.#settledAt + this.#cooldownMs, `cooldown: ${this.#cooldownMs} ms between trials`);
    need(this.#holdUntil, 'an upstream error voided the last trial: waiting for the next :00');
    for (const h of this.#hosts) need(h.tat - (h.burst - h.cap) * h.interval, `${h.host}: at most ${Math.round(MINUTE_MS / h.interval)} calls a minute, ${h.burst} at once`);
    for (const b of this.#buckets.values()) {
      if (b.seen === null) continue;
      const resetAt = (b.seen.minute + 1) * MINUTE_MS + skew;
      if (now >= resetAt || b.limit === null) {
        if (now < resetAt && b.seen.remaining < b.cap + 1) need(resetAt, `${b.route}: ${b.seen.remaining} left this minute, under its cap ${b.cap} + 1: waiting for :00`);
        continue;
      }
      const floor = b.cap + this.#reserve(b.limit);
      if (b.seen.remaining < floor) need(resetAt, `${b.route}: ${b.seen.remaining} of ${b.limit} left this minute, under cap ${b.cap} + ${floor - b.cap} (${this.#pacing.budget_pct}% a minute): waiting for :00`);
    }
    if (this.#metered) {
      const into = ((now % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
      const boundary = now - into;
      if (into < skew) need(boundary + skew, 'a minute boundary: the upstream may not have reset yet');
      else if (into > MINUTE_MS - this.#capMs - skew) need(boundary + MINUTE_MS + skew, `less than cap_ms (${this.#capMs} ms) to the buckets' reset: waiting for :00`);
    }
    return best;
  }

  /**
   * Charge a trial that ran from `start` to `end` (the header): its calls on each paced host at its
   * end, each metered route's lowest remaining, and an upstream error's hold. A void without a
   * cassette is charged its hosts' whole caps. ScrapeHeatError when a bucket turns out too small.
   */
  ran(outcome: Pick<ScrapeTrialOutcome, 'kind' | 'cassette'> & { reason?: ScrapeVoidReason }, start: number, end: number): void {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new RangeError(`a trial ran from ${start} to ${end}`);
    const cassette = outcome.cassette;
    for (const h of this.#hosts) {
      const calls = cassette === null ? h.cap : cassette.entries.filter((e) => sentUpstream(e) && this.#routeHost.get(e.route!) === h.host).length;
      if (calls > 0) h.tat = Math.max(h.tat, end) + calls * h.interval;
    }
    const minute = minuteOf(end + this.#pacing.skew_ms);
    if (cassette !== null) {
      const seen = new Map<string, { remaining: number | null; limit: number | null }>();
      for (const e of cassette.entries) {
        if (e.route === null || !this.#buckets.has(e.route)) continue;
        const remaining = headerInt(e.headers['x-ratelimit-remaining']);
        const limit = headerInt(e.headers['x-ratelimit-limit']);
        if (remaining === null && limit === null) continue;
        const s = seen.get(e.route) ?? { remaining: null, limit: null };
        if (remaining !== null) s.remaining = s.remaining === null ? remaining : Math.min(s.remaining, remaining);
        if (limit !== null) s.limit = limit;
        seen.set(e.route, s);
      }
      for (const [route, s] of seen) {
        const b = this.#buckets.get(route)!;
        this.#metered = true;
        if (s.limit !== null && s.limit > 0) {
          b.limit = s.limit;
          this.#checkBudget(route, b.cap, s.limit);
        }
        if (s.remaining !== null) b.seen = { remaining: s.remaining, minute };
      }
    }
    if (outcome.kind === 'void' && outcome.reason === 'upstream_error') this.#holdUntil = Math.max(this.#holdUntil, (minute + 1) * MINUTE_MS + this.#pacing.skew_ms);
    this.settled(end);
  }

  /** The last activity on the host ended at `at`: the cooldown counts from the latest. */
  settled(at: number): void {
    this.#settledAt = this.#settledAt === null ? at : Math.max(this.#settledAt, at);
  }
}

/**
 * The least idle time (ms) pacing holds between a trial's end and the next start when the trial makes
 * every call its caps allow (the header's arithmetic): cooldown_ms, or each paced host's cap x 60000 /
 * per_minute, rounded up, whichever is longer.
 */
export function scrapeTrialGapMs(network: ScrapeNetworkT, heat: Pick<ScrapeHeatConfigT, 'cooldown_ms'>, pacing: ScrapePacing = SCRAPE_PACING_DEFAULTS): number {
  let gap = heat.cooldown_ms;
  for (const host of network.hosts) {
    const pace = Object.hasOwn(pacing.hosts, host) ? pacing.hosts[host]! : undefined;
    if (pace === undefined) continue;
    const cap = network.routes.filter((r) => r.host === host).reduce((s, r) => s + network.request_caps[r.id]!, 0);
    gap = Math.max(gap, Math.ceil((cap * MINUTE_MS) / pace.per_minute));
  }
  return gap;
}

/** The trials a heat of `runs` entrants runs when nothing voids: the reference read, warm-up and main rounds for every run, and the playoff for min(places, runs) when it runs (the header). */
export function scrapeHeatTrialCount(heat: Pick<ScrapeHeatConfigT, 'rounds' | 'warmup_rounds' | 'playoff'>, runs: number): number {
  if (!isWhole(runs, 1)) throw new RangeError(`${String(runs)} runs: a heat runs at least one`);
  const finalists = heat.playoff.places > 0 && heat.playoff.rounds > 0 ? Math.min(heat.playoff.places, runs) : 0;
  return 1 + runs * (heat.warmup_rounds + heat.rounds) + (finalists >= 2 ? finalists * heat.playoff.rounds : 0);
}

// ---------------------------------------------------------------- the heat's options and results

/** One entrant: its submission id and its snapshot. */
export interface ScrapeHeatEntry {
  /** Its submission id (ScrapeEntryId), the house baseline's too. */
  id: string;
  /** The snapshot mounted at /bot, its runtime, and the image digest to run it in (default the pinned one). */
  dir: string;
  runtime: Runtime;
  imageDigest?: string | null;
  /** Its entrant's env-lane entry secrets, NAME to value (the header's entry secrets): every trial of it runs with them. Absent or empty: none. */
  secrets?: Readonly<Record<string, string>>;
}

/** The heat's clock: Unix ms, and a sleep that an abort ends early (rejecting with the signal's reason). */
export interface ScrapeHeatClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type ScrapeJudge = (o: JudgeScrapeTrialOptions) => Promise<{ record: ScrapeTrialRecordT; scored: ScrapeScored | null }>;

/** What runScrapeHeat calls out to (tests replace them). */
export interface ScrapeHeatDeps {
  runTrial?: (o: ScrapeTrialOptions) => Promise<ScrapeTrialOutcome>;
  judge?: ScrapeJudge;
  /** A host's IPv4 addresses (default node:dns lookup, all, family 4). */
  resolve?: (host: string) => Promise<string[]>;
  clock?: ScrapeHeatClock;
}

export interface ScrapeHeatOptions {
  /** The heat (ScrapeHeatId): every trial's owner `scrape-<id>.<entry>.<round>` names it. */
  id: string;
  /** Every entrant, the house baseline among them, in receipt order (an exact tie at the playoff's cut goes to the earlier). */
  entries: readonly ScrapeHeatEntry[];
  /** The bundle's harness: what the gateway lets through and how the heat runs. */
  harness: Pick<ScrapeHarnessT, 'network' | 'heat'>;
  /** The drand round the orders are drawn from (the caller fetched and verified it): its chain's hash, the round, its signature (hex). */
  drand: { chain: string; round: number; signature: string };
  /** The house's reader for the heat's reference read (the header): the house baseline's snapshot, run with no entry secret. */
  reference: Omit<ScrapeHeatEntry, 'id' | 'secrets'>;
  sandbox: Sandbox;
  /** The competition's limits: each entry runs under them, and the scorer. */
  limits: LimitsT;
  /** The gateway's bundle (grader/scrape/bundle.ts scrapeGatewayBundle). */
  gateway: { dir: string; script: string };
  /** The node22 house's launch.ts, as text (trial.ts ScrapeTrialOptions.launcherSource). */
  launcherSource: string;
  /** A directory the heat's trials and judging may use. */
  workDir: string;
  /** The blob store: every cassette, body, output, tail and scores.json goes in. */
  blobs: OutputBlobs;
  /** The bundle's sealed scorer (and the sandbox it runs in: default `sandbox`). */
  scoring: { setup: ScrapeScorerSetup; sandbox?: Sandbox };
  /** The host's lease: one name for every heat of the egress (the directory that names it), and the database its row lives in. */
  lease: { dir: string; db?: ScrapeLeaseDb };
  /** Default SCRAPE_PACING_DEFAULTS. */
  pacing?: ScrapePacing;
  /**
   * Every trial's pods reserve their CPU (trial.ts ScrapeTrialOptions.reserveCpu, the reference read's and every entry's;
   * the header's host lease): what grader/worker.ts sets under the `egress` lease scope, where other grading runs beside
   * the heat. Default off: no trial is handed the key.
   */
  reserveCpu?: boolean;
  /**
   * Passed to every trial as they are (trial.ts ScrapeTrialOptions): on the `pod` layout the lanes' `hosted` and `door`
   * among them (both or neither, trial.ts's One pod; a heat on the one-pod view, grader/worker.ts runScrapeHeatFor).
   */
  trial?: Pick<ScrapeTrialOptions, 'docker' | 'isolation' | 'onReap' | 'upstreamPort' | 'upstreamCa' | 'userAgent' | 'interpreter' | 'timing' | 'hosted' | 'door'>;
  signal?: AbortSignal;
  onEvent?: (e: ScrapeHeatEvent) => void;
  deps?: ScrapeHeatDeps;
}

/** One trial attempt, as the heat ran it: the heat's log (voids and warm-ups included). */
export interface ScrapeHeatAttempt {
  stage: ScrapeHeatStageT | 'reference';
  round: number;
  entry: string;
  position: number;
  /** 1-based among this trial's attempts. */
  attempt: number;
  /** It ran in its stage's make-up round. */
  makeup: boolean;
  started_at: string;
  ended_at: string;
  outcome: 'run' | 'void';
  fault: ScrapeFaultStatus | null;
  void_reason: ScrapeVoidReason | null;
  /**
   * A run the heat voided at its judging (the header's judged voids) and so ran again: SCRAPE_JUDGED_VOID; null otherwise.
   * Its outcome stays 'run', so the voids review, which counts outcome 'void', counts it apart.
   */
  judged_void: ScrapeJudgedVoid | null;
  /** A fault's detail or a void's message. */
  message: string | null;
  wall_ns: number | null;
  cassette_sha256: string | null;
}

export type ScrapeHeatEvent =
  | { type: 'resolved'; host: string; ips: string[]; why: 'start' | 'dial_failure' }
  | { type: 'stage'; stage: ScrapeHeatStageT | 'reference'; field: string[] }
  | { type: 'wait'; ms: number; why: string }
  | { type: 'attempt'; attempt: ScrapeHeatAttempt };

/** A scorer fault met judging one of a run's trials. */
export interface ScrapeScorerFault {
  stage: ScrapeStageT;
  round: number;
  name: string;
  message: string;
}

/** One entrant's run. */
export interface ScrapeHeatRun {
  entry: string;
  /** Its listed trials unjudged (score.ts ScrapeTrialRun), main then playoff, in round order: what an L1 re-judging takes. */
  runs: ScrapeJudgedRun[];
  /** Its trials manifest (its action log); null when a trial could not be judged (scorer_faults). */
  trials: ScrapeTrialsT | null;
  scorer_faults: ScrapeScorerFault[];
  /** Its main stage's standing (scrapePerformance stage 'main'), what the playoff was drawn from; null when unjudged. */
  main: ScrapePerformanceT | null;
  /** Its performance over every listed trial, a finalist's main and playoff alike; null when unjudged. */
  performance: ScrapePerformanceT | null;
  voids_rerun: number;
  finalist: boolean;
  /**
   * Where its trials' /output held a form of one of its entry secrets (the header's entry secrets), every attempt's (warm-ups
   * and voids included): the secret's NAME and `<stage>/<round>/<attempt>/output/<path>`, in run order; [] when nowhere or
   * with no secrets.
   */
  secret_hits: SecretOutputHit[];
}

export interface ScrapeHeatResult {
  heat: ScrapeHeatT;
  /** The heat's reference read: its cassette (every trial was judged against it at /reference/heat/; the heat record's reference_cassette_sha256), its scores.json, and how many tries it took. */
  reference: { cassette_sha256: string; scores_sha256: string; attempts: number };
  /** sha256 of the heat CA's certificate DER (never its key). */
  ca_sha256: string;
  /** One per entry, in the heat record's order (code units). */
  runs: ScrapeHeatRun[];
  attempts: ScrapeHeatAttempt[];
  started_at: string;
  ended_at: string;
}

// ---------------------------------------------------------------- the heat

const realClock: ScrapeHeatClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal!));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const err = new Error('the scrape heat was aborted');
  err.name = 'AbortError';
  return err;
}

async function resolveIpv4(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true, family: 4 });
  return [...new Set(found.map((a) => a.address))];
}

interface Checked {
  network: ScrapeNetworkT;
  heat: ScrapeHeatConfigT;
  entries: ScrapeHeatEntry[];
  /** Entry id -> its place in `entries` as given (the tie-break). */
  given: Map<string, number>;
  /** Entry id -> every form of its entry secrets (grader/run.ts entrySecretForms), null with none: what its trials' words are masked of. */
  forms: Map<string, FormSet | null>;
  pacing: ScrapePacing;
}

function checkHeatOptions(o: ScrapeHeatOptions): Checked {
  if (!ScrapeHeatId.safeParse(o.id).success) throw new TypeError(`heat ${JSON.stringify(o.id)} is not a heat id (1..40 of a-z 0-9 -)`);
  if (!Array.isArray(o.entries) || o.entries.length === 0) throw new TypeError('a heat runs at least one entry');
  if (o.reserveCpu !== undefined && typeof o.reserveCpu !== 'boolean') throw new TypeError(`reserveCpu ${JSON.stringify(o.reserveCpu)} is not a boolean`);
  const given = new Map<string, number>();
  const forms = new Map<string, FormSet | null>();
  o.entries.forEach((e, i) => {
    if (!ScrapeEntryId.safeParse(e.id).success) throw new TypeError(`entry ${JSON.stringify(e.id)} is not an entry id (its submission id: 1..40 of a-z 0-9 -)`);
    if (e.id === SCRAPE_REFERENCE_ENTRY) throw new TypeError(`${SCRAPE_REFERENCE_ENTRY} is the house's reference read's id, never an entrant's`);
    if (given.has(e.id)) throw new TypeError(`entry ${e.id} is listed twice`);
    if (typeof e.dir !== 'string' || e.dir.length === 0) throw new TypeError(`entry ${e.id} names no snapshot directory`);
    // Its shape here; each trial checks the rest as a sandbox's secrets are checked (trial.ts), never quoting a value.
    const s: unknown = e.secrets;
    if (s !== undefined && (typeof s !== 'object' || s === null || Array.isArray(s) || !Object.values(s).every((v) => typeof v === 'string'))) {
      throw new TypeError(`entry ${e.id}'s secrets are not a map of names to values`);
    }
    given.set(e.id, i);
    forms.set(e.id, entrySecretForms(e.secrets));
  });
  if (typeof o.reference?.dir !== 'string' || o.reference.dir.length === 0) throw new TypeError("the heat's reference read names no reader directory");
  if ((o.reference as Partial<ScrapeHeatEntry>).secrets !== undefined) throw new TypeError("the heat's reference read is the house's: it runs with no entry secret");
  if (typeof o.drand?.chain !== 'string' || !SHA256_RE.test(o.drand.chain)) throw new TypeError("the drand chain's hash is 64 lowercase hex");
  scrapeHeatSeed(o.drand.round, o.drand.signature);
  const network = ScrapeNetwork.parse(o.harness.network);
  const heat = ScrapeHeatConfig.parse(o.harness.heat);
  const pacing = checkPacing(o.pacing ?? SCRAPE_PACING_DEFAULTS);
  return { network, heat, entries: [...o.entries], given, forms, pacing };
}

/** The trial facts score.ts judges (its ScrapeTrialRun) from trial.ts's run. */
function judgedRun(run: Extract<ScrapeTrialOutcome, { kind: 'run' }>, stage: ScrapeStageT): ScrapeJudgedRun {
  return {
    round: run.trial.round,
    stage,
    position: run.trial.position,
    wall_ns: run.wall_ns,
    exit: run.exit,
    outputs: run.outputs,
    cassette_sha256: run.cassette_sha256,
    fault: run.fault,
  };
}

/** The hosts a void's cassette shows a dial failure to (upstream_unavailable), in order. */
function dialFailures(cassette: ScrapeCassetteT | null, network: ScrapeNetworkT): string[] {
  if (cassette === null) return [];
  const hostOf = new Map(network.routes.map((r) => [r.id, r.host]));
  const hosts: string[] = [];
  for (const e of cassette.entries) {
    if (e.outcome !== 'upstream_error' || e.reason !== 'upstream_unavailable') continue;
    const host = (e.route === null ? undefined : hostOf.get(e.route)) ?? e.sni;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

interface Slot {
  entry: string;
  round: number;
  position: number;
  voids: number;
}

/** Each entrant's state while the heat runs. */
interface RunState {
  entry: ScrapeHeatEntry;
  main: Map<number, { run: ScrapeJudgedRun; record: ScrapeTrialRecordT | null }>;
  playoff: Map<number, { run: ScrapeJudgedRun; record: ScrapeTrialRecordT | null }>;
  faults: ScrapeScorerFault[];
  voids: number;
}

/**
 * Run one scrape heat (see the header): the reference read, the warm-up, the main stage, the playoff,
 * every trial paced and the host held for the whole of it. Resolves with each entry's run and the heat
 * record; rejects with ScrapeHeatError when the heat cannot go on, ScrapeLeaseBusyError when another
 * heat holds the host, ScrapeLeaseLostError when the host was taken mid-heat, the signal's reason on
 * abort, a TypeError on a malformed option, and whatever a trial rejects with (IsolationRefusal).
 */
export async function runScrapeHeat(o: ScrapeHeatOptions): Promise<ScrapeHeatResult> {
  const c = checkHeatOptions(o);
  const { network, heat } = c;
  const clock = o.deps?.clock ?? realClock;
  const runTrial = o.deps?.runTrial ?? runScrapeTrial;
  const judge: ScrapeJudge = o.deps?.judge ?? judgeScrapeTrial;
  const resolve = o.deps?.resolve ?? resolveIpv4;
  const signal = o.signal;
  const emit = (e: ScrapeHeatEvent): void => {
    try {
      o.onEvent?.(e);
    } catch {
      // A listener's fault is never the heat's.
    }
  };
  const aborted = (): void => {
    if (signal?.aborted) throw abortReason(signal);
  };
  aborted();
  const pacer = new ScrapePacer(network, heat, c.pacing);
  const seed = scrapeHeatSeed(o.drand.round, o.drand.signature);
  const startedAt = clock.now();

  const lease = await acquireScrapeHostLease({ dir: o.lease.dir, db: o.lease.db, heat: o.id, now: startedAt });
  try {
    aborted();
    // One CA and one resolution per heat.
    const ca = createHeatCa({ hosts: network.hosts, label: o.id, now: startedAt });
    const leaves: Record<string, { cert: string; key: string }> = {};
    for (const [host, leaf] of Object.entries(hostLeaves(ca, network.hosts))) leaves[host] = { cert: leaf.cert, key: leaf.key };
    const upstream: ScrapeResolutionT[] = [];
    const resolveHost = async (host: string, why: 'start' | 'dial_failure'): Promise<void> => {
      let ips: string[];
      try {
        ips = (await resolve(host)).slice(0, MAX_IPS);
      } catch (err) {
        if (why === 'start') throw new ScrapeHeatError(`${host} did not resolve before the heat's first trial: ${(err as Error).message}`);
        return;
      }
      const checked = ScrapeResolution.safeParse({ host, ips });
      if (!checked.success) {
        if (why === 'start') throw new ScrapeHeatError(`${host} resolved to ${JSON.stringify(ips)}: ${checked.error.issues[0]!.message}`);
        return;
      }
      upstream.push(checked.data);
      emit({ type: 'resolved', host, ips: [...checked.data.ips], why });
    };
    for (const host of network.hosts) await resolveHost(host, 'start');
    const trialHeat = (): ScrapeTrialHeat => ({ caCert: ca.cert, leaves, upstream: upstream.map((r) => ({ host: r.host, ips: [...r.ips] })) });

    const attempts: ScrapeHeatAttempt[] = [];
    const counts = new Map<string, number>();
    /** Entry id -> where its trials' /output held a form of one of its secrets (the header's entry secrets). */
    const hitsOf = new Map<string, SecretOutputHit[]>();

    /** `text` masked of entry `id`'s secrets (the header's entry secrets); as it is for an entry with none, and the reference read. */
    const redactOf = (id: string, text: string): string => {
      const forms = c.forms.get(id) ?? null;
      return forms === null ? text : redactSecrets(text, forms);
    };

    /** An attempt into the heat's log, and to the listener. */
    const logAttempt = (a: ScrapeHeatAttempt): void => {
      attempts.push(a);
      emit({ type: 'attempt', attempt: a });
    };

    /**
     * One trial, paced: the lease checked, the wait slept, the trial run and charged, a dial failure re-resolved. A void is
     * logged at once; a run's attempt comes back unlogged, for the caller to log once it is judged (its judged_void known).
     */
    const attempt = async (stage: ScrapeHeatStageT | 'reference', slot: Omit<Slot, 'voids'>, entry: Omit<ScrapeHeatEntry, 'id'>, makeup: boolean): Promise<{ outcome: ScrapeTrialOutcome; record: ScrapeHeatAttempt }> => {
      for (;;) {
        aborted();
        await lease.check();
        const w = pacer.wait(clock.now());
        if (w === null) break;
        emit({ type: 'wait', ms: w.ms, why: w.why });
        await clock.sleep(w.ms, signal);
      }
      const start = clock.now();
      // Its own secrets and nobody else's; the reference read, the house's, none (the header's entry secrets).
      const secrets = stage === 'reference' || entry.secrets === undefined || Object.keys(entry.secrets).length === 0 ? null : entry.secrets;
      const outcome = await runTrial({
        ...o.trial,
        sandbox: o.sandbox,
        trial: { heat: o.id, entry: slot.entry, stage: stage === 'reference' ? 'warmup' : stage, round: slot.round, position: slot.position },
        entry: { dir: entry.dir, runtime: entry.runtime, imageDigest: entry.imageDigest ?? null },
        harness: { network, heat },
        limits: { cpus: o.limits.cpus, memory_mb: o.limits.memory_mb, pids: o.limits.pids },
        heat: trialHeat(),
        gateway: o.gateway,
        launcherSource: o.launcherSource,
        workDir: o.workDir,
        blobs: o.blobs,
        signal,
        ...(secrets === null ? {} : { secrets }),
        ...(o.reserveCpu === true ? { reserveCpu: true } : {}),
      });
      const end = clock.now();
      pacer.ran({ kind: outcome.kind, cassette: outcome.cassette, ...(outcome.kind === 'void' ? { reason: outcome.reason } : {}) }, start, end);
      const key = `${stage}/${slot.round}/${slot.entry}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (secrets !== null && outcome.secret_hits !== undefined && outcome.secret_hits.length > 0) {
        const hits = hitsOf.get(slot.entry) ?? [];
        for (const h of outcome.secret_hits) hits.push({ name: h.name, file: `${stage}/${slot.round}/${n}/${h.file}` });
        hitsOf.set(slot.entry, hits);
      }
      const said = outcome.kind === 'run' ? outcome.detail : outcome.message;
      const a: ScrapeHeatAttempt = {
        stage,
        round: slot.round,
        entry: slot.entry,
        position: slot.position,
        attempt: n,
        makeup,
        started_at: new Date(start).toISOString(),
        ended_at: new Date(end).toISOString(),
        outcome: outcome.kind,
        fault: outcome.kind === 'run' ? outcome.fault : null,
        void_reason: outcome.kind === 'void' ? outcome.reason : null,
        judged_void: null,
        message: said === null || secrets === null ? said : redactOf(slot.entry, said),
        wall_ns: outcome.kind === 'run' ? outcome.wall_ns : null,
        cassette_sha256: outcome.cassette_sha256,
      };
      if (outcome.kind === 'void') {
        logAttempt(a);
        for (const host of dialFailures(outcome.cassette, network)) await resolveHost(host, 'dial_failure');
      }
      return { outcome, record: a };
    };

    /** Judge a run's trial, a ScorerError that is not a disagreement tried once more; the scores.json kept in the blob store. */
    const judgeTrial = async (run: ScrapeJudgedRun, referenceSha256: string): Promise<{ record: ScrapeTrialRecordT; scored: ScrapeScored | null }> => {
      for (let n = 1; ; n++) {
        try {
          const judged = await judge({
            sandbox: o.scoring.sandbox ?? o.sandbox,
            setup: o.scoring.setup,
            trial: run,
            heatReferenceSha256: referenceSha256,
            blobs: o.blobs,
            limits: o.limits,
            workDir: o.workDir,
          });
          if (judged.scored !== null) {
            const put = await o.blobs.put(judged.scored.scores_json);
            if (put.sha256 !== judged.scored.scores_sha256) throw new Error(`the blob store named scores.json of sha256 ${judged.scored.scores_sha256} ${put.sha256}`);
          }
          return judged;
        } catch (err) {
          if (err instanceof ScorerError && !(err instanceof ScorerDisagreementError) && n < SCRAPE_JUDGE_ATTEMPTS) continue;
          throw err;
        } finally {
          pacer.settled(clock.now());
        }
      }
    };

    /**
     * The header's judged voids: a run the scorer found incorrect against the heat's reference read, judged once more with
     * its own cassette as the reference read; true when it is correct then. A fault there voids nothing (false); a
     * disagreement is thrown, the run's scorer fault as on its first judging.
     */
    const judgedVoid = async (run: ScrapeJudgedRun): Promise<boolean> => {
      try {
        return (await judgeTrial(run, run.cassette_sha256)).record.status === 'correct';
      } catch (err) {
        if (err instanceof ScorerError && !(err instanceof ScorerDisagreementError)) return false;
        throw err;
      }
    };

    // The reference read.
    emit({ type: 'stage', stage: 'reference', field: [SCRAPE_REFERENCE_ENTRY] });
    let reference: ScrapeHeatResult['reference'] | null = null;
    const refusals: string[] = [];
    for (let n = 1; n <= SCRAPE_REFERENCE_ATTEMPTS && reference === null; n++) {
      const { outcome, record } = await attempt('reference', { entry: SCRAPE_REFERENCE_ENTRY, round: 0, position: 0 }, o.reference, false);
      if (outcome.kind === 'run') logAttempt(record);
      if (outcome.kind === 'void') {
        refusals.push(`void ${outcome.reason}: ${outcome.message}`);
        continue;
      }
      if (outcome.fault !== null) {
        refusals.push(`${outcome.fault}: ${outcome.detail ?? ''}`);
        continue;
      }
      let judged: { record: ScrapeTrialRecordT; scored: ScrapeScored | null };
      try {
        judged = await judgeTrial(judgedRun(outcome, 'main'), outcome.cassette_sha256);
      } catch (err) {
        if (err instanceof ScorerError) throw new ScrapeHeatError(`the scorer could not judge the heat's reference read (cassette ${outcome.cassette_sha256}): ${err.message}`);
        throw err;
      }
      if (judged.record.status !== 'correct' || judged.scored === null) {
        refusals.push(`the scorer found the house's own read ${judged.record.status}`);
        continue;
      }
      reference = { cassette_sha256: outcome.cassette_sha256, scores_sha256: judged.scored.scores_sha256, attempts: n };
    }
    if (reference === null) throw new ScrapeHeatError(`the heat's reference read failed ${SCRAPE_REFERENCE_ATTEMPTS} times, so no trial can be judged: ${refusals.join('; ')}`);
    const referenceSha256 = reference.cassette_sha256;

    const field = c.entries.map((e) => e.id).sort(compareCodeUnits);
    const byId = new Map(c.entries.map((e) => [e.id, e]));
    const state = new Map<string, RunState>(field.map((id) => [id, { entry: byId.get(id)!, main: new Map(), playoff: new Map(), faults: [], voids: 0 }]));
    const rounds: ScrapeHeatRoundT[] = [];

    /**
     * Run a round's slots: a void, an infrastructure fault's or a judged one (the header), re-runs at the end of the round, at
     * most SCRAPE_MAX_VOID_RERUNS times (warm-up: never). The slots still void after that.
     */
    const runRound = async (stage: ScrapeHeatStageT, slots: Slot[], makeup: boolean): Promise<Slot[]> => {
      const queue = slots.map((s) => ({ ...s, voids: 0 }));
      const left: Slot[] = [];
      while (queue.length > 0) {
        const slot = queue.shift()!;
        const s = state.get(slot.entry)!;
        const { outcome, record: attempted } = await attempt(stage, slot, s.entry, makeup);
        if (stage === 'warmup') {
          if (outcome.kind === 'run') logAttempt(attempted);
          continue;
        }
        let voided = outcome.kind === 'void';
        if (outcome.kind === 'run') {
          const run = judgedRun(outcome, stage);
          const listed = stage === 'main' ? s.main : s.playoff;
          try {
            if (s.faults.length > 0) listed.set(slot.round, { run, record: null });
            else {
              const { record } = await judgeTrial(run, referenceSha256);
              voided = record.status === 'incorrect' && (await judgedVoid(run));
              if (!voided) listed.set(slot.round, { run, record });
            }
          } catch (err) {
            if (!(err instanceof ScorerError)) throw err;
            // A scorer may quote what the entry wrote: its message masked of the entry's secrets (the header's entry secrets).
            s.faults.push({ stage, round: slot.round, name: err.name, message: redactOf(slot.entry, err.message) });
            listed.set(slot.round, { run, record: null });
          } finally {
            logAttempt(voided ? { ...attempted, judged_void: SCRAPE_JUDGED_VOID } : attempted);
          }
        }
        if (voided) {
          s.voids++;
          slot.voids++;
          if (slot.voids <= SCRAPE_MAX_VOID_RERUNS) queue.push(slot);
          else left.push(slot);
        }
      }
      return left;
    };

    /** A stage's rounds, drawn in order, then its make-up round for whatever stayed void. */
    const runStage = async (stage: ScrapeHeatStageT, count: number, entrants: readonly string[]): Promise<void> => {
      if (count === 0) return;
      emit({ type: 'stage', stage, field: [...entrants] });
      const makeup: Slot[] = [];
      for (let r = 0; r < count; r++) {
        const order = scrapeHeatOrder(seed, stage, r, entrants);
        rounds.push({ stage, round: r, order });
        makeup.push(...(await runRound(stage, order.map((entry, position) => ({ entry, round: r, position, voids: 0 })), false)));
      }
      if (makeup.length === 0) return;
      const still = await runRound(stage, makeup, true);
      if (still.length > 0) {
        const s = still[0]!;
        throw new ScrapeHeatError(
          `${s.entry}'s ${stage} round ${s.round} voided ${2 * (1 + SCRAPE_MAX_VOID_RERUNS)} times, in its round and in the ${stage} stage's make-up round: the heat cannot list it (${still.length} trial${still.length === 1 ? '' : 's'} left void)`,
        );
      }
    };

    await runStage('warmup', heat.warmup_rounds, field);
    await runStage('main', heat.rounds, field);

    // The main stage's standing, and the playoff drawn from it.
    const listedOf = (s: RunState, stage: ScrapeStageT): ScrapeTrialRecordT[] | null => {
      if (s.faults.length > 0) return null;
      const m = stage === 'main' ? s.main : s.playoff;
      return [...m.keys()].sort((a, b) => a - b).map((r) => m.get(r)!.record!);
    };
    const standing = new Map<string, ScrapePerformanceT | null>();
    for (const [id, s] of state) {
      const main = listedOf(s, 'main');
      standing.set(id, main === null ? null : scrapePerformance({ trials: main, voids_rerun: s.voids }, heat.trim, 'main'));
    }
    const ranked = field
      .filter((id) => (standing.get(id)?.scores.time_ms ?? null) !== null)
      .sort((a, b) => compareScrapeRuns(standing.get(a)!, standing.get(b)!) || c.given.get(a)! - c.given.get(b)!);
    const places = heat.playoff.rounds > 0 ? heat.playoff.places : 0;
    const finalists = ranked.length >= 2 && places > 0 ? ranked.slice(0, places).sort(compareCodeUnits) : [];
    if (finalists.length > 0) await runStage('playoff', heat.playoff.rounds, finalists);

    // The records.
    const record = ScrapeHeat.parse({
      format: SCRAPE_HEAT_FORMAT,
      id: o.id,
      drand: { chain: o.drand.chain, round: o.drand.round, signature_sha256: scrapeSignatureSha256(o.drand.signature) },
      seed,
      entries: field,
      rounds,
      playoff: finalists,
      upstream,
      reference_cassette_sha256: reference.cassette_sha256,
    });
    const runs: ScrapeHeatRun[] = field.map((id) => {
      const s = state.get(id)!;
      const finalist = finalists.includes(id);
      const unjudged = [...[...s.main.entries()].sort(([a], [b]) => a - b), ...[...s.playoff.entries()].sort(([a], [b]) => a - b)].map(([, t]) => t.run);
      const main = listedOf(s, 'main');
      const playoff = listedOf(s, 'playoff');
      let trials: ScrapeTrialsT | null = null;
      let performance: ScrapePerformanceT | null = null;
      if (main !== null && playoff !== null) {
        trials = ScrapeTrials.parse({ format: SCRAPE_TRIALS_FORMAT, heat: o.id, entry: id, trials: [...main, ...playoff], voids_rerun: s.voids });
        const issues = scrapeTrialsHeatIssues(record, trials);
        if (issues.length > 0) throw new Error(`the heat's own records disagree for ${id}: ${issues.join('; ')}`);
        performance = scrapePerformance(trials, heat.trim);
      }
      return { entry: id, runs: unjudged, trials, scorer_faults: [...s.faults], main: standing.get(id) ?? null, performance, voids_rerun: s.voids, finalist, secret_hits: [...(hitsOf.get(id) ?? [])] };
    });
    return { heat: record, reference, ca_sha256: ca.sha256, runs, attempts, started_at: new Date(startedAt).toISOString(), ended_at: new Date(clock.now()).toISOString() };
  } finally {
    await lease.release();
  }
}
