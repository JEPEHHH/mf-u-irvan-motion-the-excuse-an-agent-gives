// The hello of a bars-replay/v1 run: the harness block's numbers (contracts/bars-protocol.ts
// BarsReplayHarness), the phase seed, and what only the dataset knows: each universe symbol's scales
// and the window's first close. The harness's guardrails and interval stay with the scorer
// (sim/metrics.ts BarsMetricsParams); the bot is never told them.

import { BAR_INTERVAL_MS, BARS_PROTOCOL, BarsHello, BarsReplayHarness, type BarsHelloT, type BarsReplayHarnessT } from '../../contracts/bars-protocol.ts';
import { SimDataError, type BarsDataset } from './engine.ts';

/**
 * hello for a harness over a dataset: the universe is the harness's symbols, each carried by the
 * dataset under the same mint (SimDataError otherwise) with the dataset's scales; first_close_ms is
 * the window's first bar's close (the warm-up's first, when the harness has warmup_bars: the dataset's
 * window then holds the warm-up bars before the scored ones), and warmup_bars is copied only when set.
 */
export function makeBarsHello(input: { harness: BarsReplayHarnessT; dataset: Pick<BarsDataset, 'interval' | 'window' | 'symbols'>; seed: string }): BarsHelloT {
  const h = BarsReplayHarness.parse(input.harness);
  const ds = input.dataset;
  if (ds.interval !== h.bar_interval) throw new SimDataError(`the dataset's interval is ${ds.interval}, the harness's ${h.bar_interval}`);
  const series = new Map(ds.symbols.map((s) => [s.symbol, s]));
  const symbols = h.symbols.map((u) => {
    const s = series.get(u.symbol);
    if (s === undefined) throw new SimDataError(`the dataset carries no ${u.symbol}`);
    if (s.mint !== u.mint) throw new SimDataError(`${u.symbol} is ${s.mint} in the dataset, ${u.mint} in the harness`);
    return { symbol: u.symbol, mint: u.mint, price_scale: s.price_scale, qty_scale: s.qty_scale };
  });
  return BarsHello.parse({
    type: 'hello',
    protocol: BARS_PROTOCOL,
    seed: input.seed,
    symbols,
    capital: h.capital,
    bar_interval: h.bar_interval,
    first_close_ms: ds.window.start_ms + BAR_INTERVAL_MS[h.bar_interval],
    caps: h.caps,
    fees: h.fees,
    latency_bars: h.latency_bars,
    // Only when the harness has one: a hello without a warm-up keeps its bytes.
    ...(h.warmup_bars === undefined ? {} : { warmup_bars: h.warmup_bars }),
  });
}
