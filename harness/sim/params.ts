// The replay's parameters as the bot's hello carries them, with the pilot's defaults: 10 SOL start,
// at most 5 open positions, the buys on one mint in one reply at most 1% of its real SOL reserve
// together, no shorts or leverage, latency 2 slots, Global fee fallbacks 95 + 30 bps, 5000-lamport
// base fee. The universe always excludes mayhem-mode and cashback-enabled coins (sim/universe.ts).

import { Hello, PROTOCOL, type CapsT, type FeesT, type HelloT } from '../contracts/protocol.ts';
import { PUMP_PROGRAM_ID } from '../contracts/events.ts';
import type { UniverseSampleT } from './universe.ts';

export const DEFAULT_CAPITAL_LAMPORTS = '10000000000';
export const DEFAULT_LATENCY_SLOTS = 2;

export const DEFAULT_CAPS: CapsT = {
  max_open_positions: 5,
  max_order_bps_of_real_reserve: 100,
  max_orders_per_batch: 16,
  shorts: false,
  leverage: false,
};

export const DEFAULT_FEES: FeesT = {
  protocol_bps_fallback: 95,
  creator_bps_fallback: 30,
  base_fee_lamports: '5000',
  priority_fee_lamports: '0',
  failed_tx_bps: 0,
};

export interface HelloParams {
  seed: string;
  sample: UniverseSampleT;
  capital_lamports?: string;
  caps?: Partial<CapsT>;
  latency_slots?: number;
  fees?: Partial<FeesT>;
}

/** A validated hello from the run seed, the dataset's sample rule and the competition's numbers. */
export function makeHello(p: HelloParams): HelloT {
  return Hello.parse({
    type: 'hello',
    protocol: PROTOCOL,
    seed: p.seed,
    universe: { program: PUMP_PROGRAM_ID, quote: 'SOL', mayhem: 'excluded', exclude_cashback: true, sample: p.sample },
    capital: { lamports: p.capital_lamports ?? DEFAULT_CAPITAL_LAMPORTS },
    caps: { ...DEFAULT_CAPS, ...p.caps },
    latency_slots: p.latency_slots ?? DEFAULT_LATENCY_SLOTS,
    fees: { ...DEFAULT_FEES, ...p.fees },
  });
}
