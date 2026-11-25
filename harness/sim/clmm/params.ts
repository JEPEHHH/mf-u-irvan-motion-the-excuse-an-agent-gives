// The hello of a clmm-replay/v1 run: the harness block's numbers (contracts/clmm-protocol.ts
// ClmmReplayHarness), the phase seed, and what only the dataset knows: the pool's price_scale and the
// window's first close. The harness's guardrails and interval stay with the scorer
// (sim/clmm/metrics.ts); the bot is never told them.

import { ClmmDatasetPool, clmmPoolMismatch } from '../../contracts/clmm-dataset.ts';
import { CLMM_BAR_MS, CLMM_PROTOCOL, ClmmHello, ClmmReplayHarness, type ClmmHelloT, type ClmmReplayHarnessT } from '../../contracts/clmm-protocol.ts';
import { SimDataError, type ClmmDataset } from './engine.ts';

/**
 * hello for a harness over a dataset: the harness's pool, which must be the dataset's
 * (clmmPoolMismatch; SimDataError otherwise), at the dataset's price_scale; first_close_ms is the
 * window's first hour's close.
 */
export function makeClmmHello(input: { harness: ClmmReplayHarnessT; dataset: Pick<ClmmDataset, 'pool' | 'window'>; seed: string }): ClmmHelloT {
  const h = ClmmReplayHarness.parse(input.harness);
  const parsed = ClmmDatasetPool.safeParse(input.dataset.pool);
  if (!parsed.success) throw new SimDataError(`dataset pool: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const pool = parsed.data;
  const mismatch = clmmPoolMismatch(h.pool, pool);
  if (mismatch !== null) throw new SimDataError(mismatch);
  return ClmmHello.parse({
    type: 'hello',
    protocol: CLMM_PROTOCOL,
    seed: input.seed,
    pool: h.pool,
    price_scale: pool.price_scale,
    capital: h.capital,
    first_close_ms: input.dataset.window.start_ms + CLMM_BAR_MS,
    caps: h.caps,
    fees: h.fees,
  });
}
