// Test support for the grader's own tests (tests/unit/grader-*.test.ts, tests/integration/
// docker-sandbox.test.ts): throwaway bot repositories, a small synthetic dataset, the replay harness
// config of the shipped competitions, an empty cost. Never imported by the server.
//
// The bars fixture (bars-replay/v1): a frozen bars window as collector/bars freezes one
// (freezeSyntheticBars: pool-state samples of two Raydium AMM v4 USDC pools built byte for byte by
// tests/fixtures/collector/bars/accounts.ts, so verifyBarsDataset re-derives every price, bar and
// pool depth; a one-hop AMM v4 pool's depth is its USDC reserve),
// the bars harness over its universe (barsFixtureHarness) and a competition bundle around it
// (barsFixtureBundle).
//
// The clmm fixture (clmm-replay/v1): a `cli.ts record --fee-growth` recording of one SOL/USDC Orca
// Whirlpool as collector/bars/record.ts lays one out (writeClmmFixtureRecording: record.json with
// fee_growth: true, a one-pool pools.json, raw/SOL.ndjson, ticks.ndjson), its samples
// (clmmFixtureSamples) eight hours every 10 s across UTC midnight, the pool's liquidity moving every
// sample, fee counter A wrapping past 2^128, a 30-sample excursion about 300 ticks up and a 40 s
// hole; frozen by collector/bars/clmm-freeze.ts (freezeSyntheticClmm), so verifyClmmDataset
// re-derives every bar from the rows. A competition bundle around a clmm harness (clmmFixtureBundle),
// and the clmm baselines' directories (CLMM_BASELINES).
//
// A tick lockstep (tickLockstep): the smallest engine of the lockstep shape and its line codec, for grader/run.ts
// executeLockstep's own tests (whose turn the clock charges): `batches` batches {type: 'batch', seq}, each reply
// {type: 'reply', seq, orders: []} echoing its seq, and an engine that can stall (a synchronous busy wait, as an event
// loop pinned by other replays stalls) before each batch, so its turns take real time on the grader's loop.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { barsWindow } from '../collector/bars/bars.ts';
import { freezeClmmRecording } from '../collector/bars/clmm-freeze.ts';
import { chainPrice, isqrt, sqrtPriceRatio } from '../collector/bars/decode.ts';
import { freezeBars } from '../collector/bars/freeze.ts';
import { BARS_POOLS_SCHEMA, BarsPoolsFile, poolsFileBytes, type BarsPoolsFileT, type BarsPoolT } from '../collector/bars/pools.ts';
import { RAW_DIR, RECORD_FILE, RECORD_SCHEMA, TICKS_FILE } from '../collector/bars/record.ts';
import { BarsSample, sampleFromAccounts, sampleLine, samplePrice, type AccountRead, type BarsSampleT } from '../collector/bars/samples.ts';
import { MANIFEST_FILE } from '../collector/manifest.ts';
import type { BarsDatasetManifestT } from '../contracts/bars-dataset.ts';
import { BAR_INTERVAL_MS, type BarsReplayHarnessT } from '../contracts/bars-protocol.ts';
import type { ClmmDatasetManifestT } from '../contracts/clmm-dataset.ts';
import { CLMM_BAR_MS, type ClmmReplayHarnessT } from '../contracts/clmm-protocol.ts';
import { CompetitionBundle, type CompetitionBundleT, type ReplayHarness } from '../contracts/competition.ts';
import type { CostT } from '../contracts/score.ts';
import { pricingRev } from '../pricing/price.ts';
import { loadCompetition } from '../server/competitions/load.ts';
import type { LockstepEngine } from '../sim/bars/engine.ts';
import { syntheticBarsHarness } from '../sim/bars/synthetic.ts';
import { canonicalSha256, sha256Hex } from '../sim/canonical.ts';
import { tickAtSqrtPrice } from '../sim/clmm/position.ts';
import type { ReplayDataset } from '../sim/engine.ts';
import { generateDataset } from '../sim/synthetic.ts';
import type { UniverseSampleT } from '../sim/universe.ts';
import { AMM_V4, ammV4Account, fakeKey, SPL_PROGRAM, tokenAccount, USDC, WHIRLPOOL, WSOL } from '../tests/fixtures/collector/bars/accounts.ts';
import { computeCost } from './cost.ts';
import type { LimitsT, LockstepProtocol, LockstepRun } from './run.ts';
import type { EligibilityRules } from './score.ts';
import { PROJECT_ROOT } from './version.ts';

export const SDK_TS = join(PROJECT_ROOT, 'sdk/ts/makefun-bot.ts');
export const BOTS_DIR = join(PROJECT_ROOT, 'bots');
export const FIZZBUZZ_DIR = join(PROJECT_ROOT, 'tests/fixtures/competitions/fizzbuzz-loc');

/** Every mint is in the universe. */
export const ALL_MINTS: UniverseSampleT = { hash: 'sha256', modulus: 1, residue: 0 };

/** Small limits for tests (the wall budget is what matters on the process driver). */
export const TEST_LIMITS: LimitsT = { cpus: 1, memory_mb: 512, pids: 64, wall_budget_sec: 60 };

export const TEST_RULES: EligibilityRules = { min_authored_coverage: 0.8, transcripts_required: true };

/** A bot repository: main.ts plus the TS SDK vendored at vendor/makefun-bot.ts. */
export function writeSdkBot(dir: string, main: string): string {
  mkdirSync(join(dir, 'vendor'), { recursive: true });
  copyFileSync(SDK_TS, join(dir, 'vendor/makefun-bot.ts'));
  writeFileSync(join(dir, 'main.ts'), main);
  return dir;
}

/** A bot repository with only main.ts (speaks the wire itself). */
export function writeRawBot(dir: string, main: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'main.ts'), main);
  return dir;
}

/**
 * A raw bot that answers each batch with whatever `reply(msg)` (a JS expression over `msg`, the
 * parsed batch) evaluates to, written as one line; `onDone` runs at done before it exits.
 */
export function rawReplyBot(dir: string, reply: string, extra: { onDone?: string; prelude?: string } = {}): string {
  return writeRawBot(
    dir,
    [
      "import { createInterface } from 'node:readline';",
      extra.prelude ?? '',
      'const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });',
      'for await (const line of rl) {',
      '  const msg = JSON.parse(line);',
      `  if (msg.type === 'batch') process.stdout.write(${reply});`,
      `  if (msg.type === 'done') { ${extra.onDone ?? ''} break; }`,
      '}',
      'rl.close();',
      '',
    ].join('\n'),
  );
}

/** A synthetic chain log (every mint in the universe), as a ReplayDataset named by its canonical digest. */
export function syntheticDataset(opts: { seed?: bigint; curves?: number; trades?: number } = {}): ReplayDataset {
  const gen = generateDataset({ seed: opts.seed ?? 11n, curves: opts.curves ?? 10, tradesPerCurve: opts.trades ?? 30, completing: [2], createSpread: 120 });
  return { sha256: canonicalSha256(gen.events), events: gen.events };
}

/**
 * The replay harness config of solana-memecoin-bot-01: the pilot's, but that its guardrails count
 * round trips and it sets counterparties: true, so a score graded under it carries the
 * distinct-counterparties metric (contracts/score.ts Counterparties).
 */
export function botHarness(): z.infer<typeof ReplayHarness> {
  const loaded = loadCompetition(join(PROJECT_ROOT, 'competitions/solana-memecoin-bot-01'));
  if (loaded.bundle.harness.kind !== 'pumpfun-replay/v2') throw new Error('solana-memecoin-bot-01 is not a replay competition');
  return loaded.bundle.harness;
}

/** The cost of an entry with no transcript. */
export function emptyCost(): CostT {
  return computeCost([], { pricingRev, provenance: 'none' });
}

// ---------------------------------------------------------------- bars-replay/v1

/** 2026-11-02T00:00:00Z: the fixture window's first bar's open time. */
export const BARS_FIXTURE_START_MS = Date.parse('2026-11-02T00:00:00Z');
/** The fixture poller's cadence: 10 minutes, six samples a bar. */
export const BARS_FIXTURE_TICK_MS = 600_000;
const HOUR_MS = BAR_INTERVAL_MS['1h'];
/** The real JUP mint: the fixture's second ticker names it (SOL names the wrapped-SOL mint). */
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

/** One fixture pool: a Raydium AMM v4 pool pairing the asset (coin) with USDC (pc), its reserves at tick k. */
interface FixturePool {
  pool: BarsPoolT;
  /** The asset's raw reserve, constant. */
  coin: bigint;
  /** The USDC raw reserve at tick k: a deterministic walk with a drift. */
  pc: (k: number) => bigint;
}

function fixturePool(asset: string, mint: string, decimals: number, priceScale: number, coin: bigint, pc: (k: number) => bigint): FixturePool {
  const key = (part: string) => fakeKey(`grader-bars:${asset}:${part}`);
  return {
    coin,
    pc,
    pool: {
      asset,
      mint,
      decimals,
      quote: 'USDC',
      venue: 'raydium-amm-v4',
      program_id: AMM_V4,
      pool: key('pool'),
      mint_a: mint,
      mint_b: USDC,
      vault_a: key('coin-vault'),
      vault_b: key('pc-vault'),
      tick_spacing: null,
      sol_usdc: null,
      price_scale: priceScale,
      price_at_freeze: '1',
      depth_usdc_at_freeze: '2000000.000000',
      depth_sol_at_freeze: null,
    },
  };
}

/**
 * The fixture universe, in code-unit order: JUP (6 decimals, prices at scale 8, about 0.50 USDC,
 * drifting up) and SOL (9 decimals, prices at scale 7, about 102.50 USDC, drifting down), each the
 * coin side of a Raydium AMM v4 USDC pool whose USDC reserve walks tick by tick.
 */
function barsFixturePools(): FixturePool[] {
  return [
    fixturePool('JUP', JUP_MINT, 6, 8, 10_000_000_000_000n, (k) => 5_000_000_000_000n + BigInt(k) * 4_000_000_000n + BigInt(((k * 7919) % 13) - 6) * 15_000_000_000n),
    fixturePool('SOL', WSOL, 9, 7, 40_000_000_000_000n, (k) => 4_100_000_000_000n - BigInt(k) * 2_500_000_000n + BigInt(((k * 104_729) % 11) - 5) * 9_000_000_000n),
  ];
}

/** The fixture's pools.json. */
export function barsFixturePoolsFile(): BarsPoolsFileT {
  return { schema: BARS_POOLS_SCHEMA, created_at: '2026-11-01T00:00:00.000Z', slot: 900, min_depth_usdc: '1000000.000000', pools: barsFixturePools().map((p) => p.pool), rejected: [] };
}

/** Every account one read of the fixture chain returns at tick k: each pool and its two vaults. */
function fixtureAccounts(k: number): Map<string, AccountRead> {
  const out = new Map<string, AccountRead>();
  for (const { pool: p, coin, pc } of barsFixturePools()) {
    out.set(p.pool, { owner: AMM_V4, data: ammV4Account({ coinDecimals: p.decimals, pcDecimals: 6, coinVault: p.vault_a, pcVault: p.vault_b, coinMint: p.mint, pcMint: USDC }) });
    out.set(p.vault_a, { owner: SPL_PROGRAM, data: tokenAccount({ mint: p.mint, amount: coin }) });
    out.set(p.vault_b, { owner: SPL_PROGRAM, data: tokenAccount({ mint: USDC, amount: pc(k) }) });
  }
  return out;
}

export interface FrozenBars {
  dir: string;
  manifest: BarsDatasetManifestT;
  /** The RFC 8785 canonical sha256 of manifest.json as written: the dataset row's sha256, and the run's dataset_sha256. */
  sha256: string;
}

/**
 * Freeze the fixture window into `dir` (it must not hold a manifest yet), as collector/bars freezes a
 * recording: `hours` whole 1h bars from BARS_FIXTURE_START_MS (default 24), a sample of both pools
 * every 10 minutes. Deterministic: the same arguments write the same bytes, so the same digests.
 */
export function freezeSyntheticBars(dir: string, opts: { hours?: number; id?: string } = {}): FrozenBars {
  const hours = opts.hours ?? 24;
  const pools = barsFixturePools().map((p) => p.pool);
  const samples = new Map<string, BarsSampleT[]>(pools.map((p) => [p.asset, []]));
  const end = BARS_FIXTURE_START_MS + hours * HOUR_MS;
  let slot = 1_000;
  for (let k = 0, ts = BARS_FIXTURE_START_MS; ts < end; k++, ts += BARS_FIXTURE_TICK_MS) {
    slot += 1_500;
    const accounts = fixtureAccounts(k);
    for (const p of pools) {
      const r = sampleFromAccounts(p, accounts, { ts: ts + 137, slot });
      if (!('sample' in r)) throw new Error(`the bars fixture has no ${p.asset} sample at tick ${k}: ${r.error}`);
      samples.get(p.asset)!.push(r.sample);
    }
  }
  const { manifest } = freezeBars({
    dir,
    id: opts.id ?? 'bars-fixture',
    poolsBytes: poolsFileBytes(barsFixturePoolsFile()),
    samples,
    window: barsWindow(BARS_FIXTURE_START_MS, end, HOUR_MS),
    everyMs: BARS_FIXTURE_TICK_MS,
    now: () => new Date(end + HOUR_MS),
  });
  return { dir, manifest, sha256: canonicalSha256(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))) };
}

/**
 * The bars harness over the fixture universe (JUP, SOL): sim/bars/synthetic.ts syntheticBarsHarness's
 * defaults (10,000 USDC, 4 open positions, 8 orders a bar, 30 bps fees, 10 bps slippage, no
 * guardrail), each key of `patch` replacing the default's whole.
 */
export function barsFixtureHarness(patch: Partial<BarsReplayHarnessT> = {}): BarsReplayHarnessT {
  const symbols = barsFixturePools().map(({ pool: p }) => ({ symbol: p.asset, mint: p.mint, price_scale: p.price_scale, qty_scale: p.decimals, bars: [] }));
  return syntheticBarsHarness({ interval: '1h', symbols }, patch);
}

/**
 * A bars-replay/v1 competition bundle around `harness` (default barsFixtureHarness()): bot-01's
 * competition, phases, rules and limits under the slug bars-fixture, without its hold-cash flag (the
 * pump replay's alone), ranked on net PnL in quote units.
 */
export function barsFixtureBundle(harness: BarsReplayHarnessT = barsFixtureHarness()): CompetitionBundleT {
  const base = loadCompetition(join(PROJECT_ROOT, 'competitions/solana-memecoin-bot-01')).bundle;
  const { prize_requires_beating_hold_cash: _holdCash, prize_gate: _gate, ...rest } = base;
  return CompetitionBundle.parse({
    ...rest,
    competition: { ...base.competition, slug: 'bars-fixture', title: 'Bars fixture' },
    harness,
    leaderboard: {
      title: 'Results',
      primary_index: 0,
      columns: [
        { key: 'net_pnl', title: 'Net PnL (USDC units)', index: 0, sorting: 'desc', precision: 0, source: 'performance.metrics.net_pnl_quote_units' },
        { key: 'max_drawdown', title: 'Max drawdown', index: 1, sorting: 'asc', precision: 4, source: 'performance.metrics.max_drawdown' },
        { key: 'trades', title: 'Trades', index: 2, sorting: 'desc', precision: 0, source: 'performance.metrics.trades' },
      ],
    },
  });
}

// ---------------------------------------------------------------- clmm-replay/v1

/** 2026-11-09T22:00:00Z: the clmm fixture window's first hour's open time. */
export const CLMM_FIXTURE_START_MS = Date.parse('2026-11-09T22:00:00Z');
/**
 * 2026-11-10T06:00:00Z: its last hour's close, eight hours on, across UTC midnight: CLMM_MIN_BLOCKS
 * whole blocks of an hour, the fewest a clmm harness's interval resamples (contracts/clmm-protocol.ts
 * clmmBlockHoursIssue), so a harness on it takes 1-hour blocks (sim/clmm/synthetic.ts syntheticClmmHarness).
 */
export const CLMM_FIXTURE_END_MS = Date.parse('2026-11-10T06:00:00Z');
/** The fixture window's hours: eight, one batch each. */
export const CLMM_FIXTURE_HOURS = (CLMM_FIXTURE_END_MS - CLMM_FIXTURE_START_MS) / CLMM_BAR_MS;
/** The fixture poller's cadence: 10 s, as the recordings are made. */
export const CLMM_FIXTURE_EVERY_MS = 10_000;
/** Scheduled ticks 900 to 902 (00:30Z, hour 2) unanswered: one 40 s interval. */
export const CLMM_FIXTURE_HOLE = (k: number): boolean => k >= 900 && k <= 902;
/** Samples 800 to 829 (from 00:13:20Z, hour 2) read about 300 ticks higher: 1.0001^150 on the sqrt price. */
export const CLMM_FIXTURE_EXCURSION = (k: number): boolean => k >= 800 && k < 830;
const CLMM_EXCURSION_NUM = 1_015_112n;
const CLMM_EXCURSION_DEN = 1_000_000n;
/** Per-sample fee growth steps [A, B] (Q64.64 per unit of liquidity). */
export const CLMM_FIXTURE_FEE_GROWTH_STEP: readonly [bigint, bigint] = [2_000_000_000n, 300_000_000n];
/** Counter A starts this many steps below 2^128, so it wraps at 23:40Z (hour 1). */
export const CLMM_FIXTURE_WRAP_AT = 600n;
const Q128 = 1n << 128n;
/** 0.15 USDC raw per lamport: SOL at 150 USDC. */
const CLMM_SQRT0 = isqrt((Q128 * 15n) / 100n);

/** The fixture pool: SOL/USDC on an Orca Whirlpool (SOL token A, 9 decimals; USDC token B), tick spacing 4, prices at scale 7, 28M USDC deep. */
export function clmmFixturePool(): BarsPoolT {
  const key = (part: string) => fakeKey(`clmm-freeze-replay:sol-whirlpool${part}`);
  const price = chainPrice([{ ratio: sqrtPriceRatio(CLMM_SQRT0), baseIsA: true }], 9, 7)!;
  return {
    asset: 'SOL',
    mint: WSOL,
    decimals: 9,
    quote: 'USDC',
    venue: 'orca-whirlpool',
    program_id: WHIRLPOOL,
    pool: key(''),
    mint_a: WSOL,
    mint_b: USDC,
    vault_a: key(':vault-a'),
    vault_b: key(':vault-b'),
    tick_spacing: 4,
    sol_usdc: null,
    price_scale: 7,
    price_at_freeze: String(price),
    depth_usdc_at_freeze: '28000000.000000',
    depth_sol_at_freeze: null,
    depth_basis: 'in_range',
  };
}

/** The fixture's pools.json bytes: the one pool `cli.ts universe --pool` pins. */
export function clmmFixturePoolsBytes(): Buffer {
  return poolsFileBytes(BarsPoolsFile.parse({ schema: BARS_POOLS_SCHEMA, created_at: '2026-11-09T21:59:00.000Z', slot: 462_000_000, min_depth_usdc: '1000000.000000', pools: [clmmFixturePool()], rejected: [] }));
}

/** A sample as the recorder writes it with --fee-growth: priced from its sqrt price, its tick that price's, with its liquidity, vaults and fee growth. */
function clmmFixtureSample(pool: BarsPoolT, k: number, s: { ts: number; slot: number; sqrt: bigint; liquidity: bigint; vaults: [bigint, bigint]; fg: [bigint, bigint] }): BarsSampleT {
  const sqrt = s.sqrt.toString();
  const price = samplePrice({ venue: pool.venue, sqrt_price_x64: sqrt, reserve_a: null, reserve_b: null, sol_usdc: null }, pool)!;
  return BarsSample.parse({
    ts: s.ts,
    slot: s.slot,
    asset: pool.asset,
    venue: pool.venue,
    pool: pool.pool,
    price: price.toString(),
    sqrt_price_x64: sqrt,
    liquidity: s.liquidity.toString(),
    tick: tickAtSqrtPrice(s.sqrt),
    reserve_a: null,
    reserve_b: null,
    vaults: [s.vaults[0].toString(), s.vaults[1].toString()],
    fee_growth: [s.fg[0].toString(), s.fg[1].toString()],
    data_sha256: [sha256Hex(`pool:${k}`), sha256Hex(`vault-a:${k}`), sha256Hex(`vault-b:${k}`)],
    sol_usdc: null,
  });
}

/**
 * The fixture's samples, one per scheduled tick k (answered 200 to 700 ms after it): the sqrt price
 * walking by at most 0.005% a step (about a tick), the liquidity moving every sample (5 to 17 x
 * 10^12), the vaults drifting, counter A wrapping past 2^128, B climbing. The counters keep moving
 * through the hole (CLMM_FIXTURE_HOLE); the excursion (CLMM_FIXTURE_EXCURSION) reads higher.
 */
export function clmmFixtureSamples(): BarsSampleT[] {
  const pool = clmmFixturePool();
  const [stepA, stepB] = CLMM_FIXTURE_FEE_GROWTH_STEP;
  const out: BarsSampleT[] = [];
  let sqrt = CLMM_SQRT0;
  let fgA = Q128 - CLMM_FIXTURE_WRAP_AT * stepA - 12_345n;
  let fgB = 1_717_628_453_198_323_491n;
  let seed = 11;
  for (let k = 0; CLMM_FIXTURE_START_MS + k * CLMM_FIXTURE_EVERY_MS < CLMM_FIXTURE_END_MS; k++) {
    seed = (seed * 48_271) % 2_147_483_647;
    sqrt += (sqrt * BigInt((seed % 5) - 2)) / 40_000n;
    fgA = (fgA + stepA + BigInt(k % 7)) % Q128;
    fgB = (fgB + stepB + BigInt(k % 11)) % Q128;
    if (CLMM_FIXTURE_HOLE(k)) continue;
    const at = CLMM_FIXTURE_START_MS + k * CLMM_FIXTURE_EVERY_MS;
    out.push(
      clmmFixtureSample(pool, k, {
        ts: at + 200 + ((k * 37) % 500),
        slot: 462_000_000 + k * 25,
        sqrt: CLMM_FIXTURE_EXCURSION(k) ? (sqrt * CLMM_EXCURSION_NUM) / CLMM_EXCURSION_DEN : sqrt,
        liquidity: 5_000_000_000_000n + BigInt(k % 13) * 1_000_000_000_000n,
        vaults: [100_000n * 10n ** 9n + BigInt(k) * 10n ** 6n, 15_000_000n * 10n ** 6n - BigInt(k) * 1_000n],
        fg: [fgA, fgB],
      }),
    );
  }
  return out;
}

/**
 * Write a `cli.ts record --fee-growth` recording directory of `samples` into `dir` (collector/bars/
 * record.ts's layout): record.json with fee_growth: true, the fixture's pools.json, raw/SOL.ndjson and
 * a tick line per scheduled time over the fixture window. Returns `dir`.
 */
export function writeClmmFixtureRecording(dir: string, samples: readonly BarsSampleT[] = clmmFixtureSamples()): string {
  mkdirSync(join(dir, RAW_DIR), { recursive: true });
  const bytes = clmmFixturePoolsBytes();
  writeFileSync(join(dir, 'pools.json'), bytes);
  const meta = { schema: RECORD_SCHEMA, pools_sha256: sha256Hex(bytes), start_ms: CLMM_FIXTURE_START_MS, end_ms: CLMM_FIXTURE_END_MS, sample_every_ms: CLMM_FIXTURE_EVERY_MS, fee_growth: true, endpoint: 'https://api.mainnet.solana.com', created_at: '2026-11-09T21:59:30.000Z' };
  writeFileSync(join(dir, RECORD_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(dir, RAW_DIR, 'SOL.ndjson'), samples.map(sampleLine).join(''));
  const ticks: string[] = [];
  for (let at = CLMM_FIXTURE_START_MS; at < CLMM_FIXTURE_END_MS; at += CLMM_FIXTURE_EVERY_MS) {
    const n = samples.filter((s) => s.ts >= at && s.ts < at + CLMM_FIXTURE_EVERY_MS).length;
    ticks.push(`${JSON.stringify({ ts: at, at: at + 800, ok: n > 0, slot: n > 0 ? 462_000_000 : null, samples: n, missed: 0, errors: n > 0 ? [] : ['SOL: no read'] })}\n`);
  }
  writeFileSync(join(dir, TICKS_FILE), ticks.join(''));
  return dir;
}

export interface FrozenClmm {
  dir: string;
  manifest: ClmmDatasetManifestT;
  /** The RFC 8785 canonical sha256 of manifest.json as written: the dataset row's sha256, and the run's dataset_sha256. */
  sha256: string;
}

/**
 * Record the fixture into `<dir>.recording` and freeze it into `dir` (it must not hold a manifest yet)
 * with collector/bars/clmm-freeze.ts freezeClmmRecording, as `cli.ts freeze-clmm` does: eight whole 1h
 * bars and every kept sample as a row, a rows file per UTC day. Deterministic: the same arguments
 * write the same bytes, so the same digests.
 */
export function freezeSyntheticClmm(dir: string, opts: { id?: string } = {}): FrozenClmm {
  const recordDir = writeClmmFixtureRecording(`${dir}.recording`);
  const { manifest } = freezeClmmRecording({ recordDir, dir, id: opts.id ?? 'clmm-fixture', now: () => new Date(CLMM_FIXTURE_END_MS + 5 * 60_000) });
  return { dir, manifest, sha256: canonicalSha256(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))) };
}

/** The clmm baselines, laid out as entrants' repositories (clmm/baselines/<name>/main.ts). */
export const CLMM_BASELINES = Object.freeze({
  passiveRange: join(PROJECT_ROOT, 'clmm/baselines/passive-range'),
  recenter: join(PROJECT_ROOT, 'clmm/baselines/recenter'),
});

/**
 * A clmm-replay/v1 competition bundle around `harness`: bot-01's competition, phases, rules and
 * limits under the slug clmm-fixture, without its hold-cash flag and rehearsal gate (the pump
 * replay's alone), its prizes gated on the baseline, ranked on hedged PnL in quote units.
 */
export function clmmFixtureBundle(harness: ClmmReplayHarnessT): CompetitionBundleT {
  const base = loadCompetition(join(PROJECT_ROOT, 'competitions/solana-memecoin-bot-01')).bundle;
  const { prize_requires_beating_hold_cash: _holdCash, prize_gate: _gate, ...rest } = base;
  return CompetitionBundle.parse({
    ...rest,
    competition: { ...base.competition, slug: 'clmm-fixture', title: 'CLMM fixture' },
    harness,
    leaderboard: {
      title: 'Results',
      primary_index: 0,
      columns: [
        { key: 'hedged_pnl', title: 'Hedged PnL (USDC units)', index: 0, sorting: 'desc', precision: 0, source: 'performance.metrics.hedged_pnl_quote_units' },
        { key: 'fees', title: 'Fees (USDC units)', index: 1, sorting: 'desc', precision: 0, source: 'performance.metrics.fees_quote_units' },
        { key: 'lvr', title: 'LVR (USDC units)', index: 2, sorting: 'asc', precision: 0, source: 'performance.metrics.lvr_quote_units' },
        { key: 'in_range_share', title: 'In-range share', index: 3, sorting: 'desc', precision: 4, source: 'performance.metrics.in_range_share' },
      ],
    },
    prize_requires_beating_baseline: true,
  });
}

// ---------------------------------------------------------------- a tick lockstep

export interface TickHello {
  type: 'hello';
  batches: number;
}
export interface TickBatch {
  type: 'batch';
  seq: number;
}
export interface TickDone {
  type: 'done';
}
export interface TickReply {
  type: 'reply';
  seq: number;
  orders: unknown[];
}
/** The tick lockstep's action log: each reply's seq, in order. */
export interface TickLog {
  seqs: number[];
}

/** Block this thread for `ms` (a busy wait): the grader's event loop stalled, as one pinned by other replays is. */
export function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}

/**
 * The tick lockstep (the header): a fresh engine of `batches` batches that stalls the loop `stallMs` before each batch
 * and before done (the engine's turns), and its line codec (replies must echo the batch's seq, and carry an empty
 * orders list or none). A bot of testkit's rawReplyBot answers it with TICK_REPLY.
 */
export function tickLockstep(o: { batches: number; stallMs?: number }): {
  engine: LockstepEngine<TickHello, TickBatch, TickDone, LockstepRun<TickLog>>;
  protocol: LockstepProtocol<TickHello, TickBatch, TickDone, TickReply>;
} {
  const stall = o.stallMs ?? 0;
  const seqs: number[] = [];
  let next = 0;
  const engine: LockstepEngine<TickHello, TickBatch, TickDone, LockstepRun<TickLog>> = {
    hello: { type: 'hello', batches: o.batches },
    nextBatch() {
      if (stall > 0) busyWait(stall);
      return next < o.batches ? { type: 'batch', seq: next++ } : null;
    },
    submit(reply) {
      const r = reply as TickReply;
      if (r.seq !== next - 1) throw new Error(`reply to ${next - 1} echoes ${r.seq}`);
      seqs.push(r.seq);
    },
    finish() {
      return { done: { type: 'done' }, run: { aborted: null, action_log: { seqs } } };
    },
  };
  const protocol: LockstepProtocol<TickHello, TickBatch, TickDone, TickReply> = {
    encode: (msg) => `${JSON.stringify(msg)}\n`,
    parseLine(line) {
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        return { ok: false, reason: 'not JSON' };
      }
      const r = v as Partial<TickReply> | null;
      if (r === null || typeof r !== 'object' || r.type !== 'reply' || typeof r.seq !== 'number') return { ok: false, reason: 'not a reply' };
      return { ok: true, reply: { type: 'reply', seq: r.seq, orders: Array.isArray(r.orders) ? r.orders : [] } };
    },
    replyOrderCap: () => 64,
  };
  return { engine, protocol };
}

/** rawReplyBot's reply expression answering the tick lockstep (and the pump replay): an empty reply echoing the batch's seq. */
export const TICK_REPLY = '`${JSON.stringify({ type: "reply", seq: msg.seq, orders: [] })}\\n`';
