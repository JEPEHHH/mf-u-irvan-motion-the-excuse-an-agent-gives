// pump.fun bonding-curve events, mirroring contracts/idl/pump.json exactly (pump-fun/pump-public-docs
// at 639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22; provenance in contracts/idl/pump.source.json).
//
//   *_LAYOUT          the IDL's field list per event, in borsh order, with the IDL's own type
//                     notation: what a decoder walks (tests/unit/contracts.test.ts asserts it
//                     equals the IDL byte for byte)
//   *EventFields      zod objects with exactly those fields, in that order
//   *EventRecord      a decoded event as the collector stores it: `event` (the IDL name) + the fields
//                     + the collector's slot, signature, block_time, chain_seq
//   ChainEvent        the union of the three records, discriminated by `event`
//   decodeEventData   Borsh decoder walking the layouts (a `Program data:` payload, or a self-CPI
//                     inner instruction via decodeCpiEventData)
//
// Wire mapping: pubkey -> base58 string; u64 and i64 -> canonical decimal strings (read with
// BigInt); u8/u16 -> numbers; bool -> boolean; string -> string; vec<Shareholder> -> array.
//
// What the events do and do not carry (it decides the sim's and the collector's math):
//   TradeEvent     reserves are POST-trade only (virtual/real SOL, token and quote); pre-trade state
//                  is derived from the amounts, never read. Fees come with their bps. The *_quote_*
//                  fields are authoritative: on SOL-quoted curves every *_sol_* field equals its
//                  *_quote_* twin (a mismatch is a data error, see solQuoteMismatches); on other
//                  curves sol_amount and the *_sol_* reserves are 0.
//   CreateEvent    initial virtual token/SOL/quote reserves and real token reserves; no real SOL or
//                  quote reserves (they start at 0).
//   CompleteEvent  no reserves and no fees: it only marks the curve complete.
//
// Settled from 982 live mainnet TradeEvents (2026-10-26): every TradeEvent carries 8 trailing bytes
// after creator_fee_unclaimed that the IDL does not name (0 so far). Decoders stop after the last
// named field and ignore what follows (never assert an exact length); an event SHORTER than the
// layout (an older program version) is refused. A SOL-quoted curve's events carry quote_mint =
// Pubkey::default() (11111111111111111111111111111111), not wSOL.

import { z } from 'zod';
import { Pubkey, Signature, Slot, U16, U64, U8, I64 } from './primitives.ts';

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** Anchor event discriminators (sha256("event:<Name>")[0..8]), hex. */
export const EVENT_DISCRIMINATORS = {
  TradeEvent: 'bddb7fd34ee661ee',
  CreateEvent: '1b72a94ddeeb6376',
  CompleteEvent: '5f72619cd42e9808',
} as const;

/** Anchor's emit_cpi! instruction tag: self-CPI event data = this tag + discriminator + borsh body. */
export const EVENT_CPI_TAG = 'e445a52e51cb9a1d';

export type EventName = keyof typeof EVENT_DISCRIMINATORS;
export const EVENT_NAMES = Object.keys(EVENT_DISCRIMINATORS) as EventName[];

/** An IDL field type, in the IDL's notation. */
export type IdlType = 'pubkey' | 'u64' | 'i64' | 'u8' | 'u16' | 'bool' | 'string' | { vec: { defined: { name: 'Shareholder' } } };
export type IdlField = { readonly name: string; readonly type: IdlType };

export const SHAREHOLDER_LAYOUT = [
  { name: 'address', type: 'pubkey' },
  { name: 'share_bps', type: 'u16' },
] as const satisfies readonly IdlField[];

export const TRADE_EVENT_LAYOUT = [
  { name: 'mint', type: 'pubkey' },
  { name: 'sol_amount', type: 'u64' },
  { name: 'token_amount', type: 'u64' },
  { name: 'is_buy', type: 'bool' },
  { name: 'user', type: 'pubkey' },
  { name: 'timestamp', type: 'i64' },
  { name: 'virtual_sol_reserves', type: 'u64' },
  { name: 'virtual_token_reserves', type: 'u64' },
  { name: 'real_sol_reserves', type: 'u64' },
  { name: 'real_token_reserves', type: 'u64' },
  { name: 'fee_recipient', type: 'pubkey' },
  { name: 'fee_basis_points', type: 'u64' },
  { name: 'fee', type: 'u64' },
  { name: 'creator', type: 'pubkey' },
  { name: 'creator_fee_basis_points', type: 'u64' },
  { name: 'creator_fee', type: 'u64' },
  { name: 'track_volume', type: 'bool' },
  { name: 'total_unclaimed_tokens', type: 'u64' },
  { name: 'total_claimed_tokens', type: 'u64' },
  { name: 'current_sol_volume', type: 'u64' },
  { name: 'last_update_timestamp', type: 'i64' },
  { name: 'ix_name', type: 'string' },
  { name: 'mayhem_mode', type: 'bool' },
  { name: 'cashback_fee_basis_points', type: 'u64' },
  { name: 'cashback', type: 'u64' },
  { name: 'buyback_fee_basis_points', type: 'u64' },
  { name: 'buyback_fee', type: 'u64' },
  { name: 'shareholders', type: { vec: { defined: { name: 'Shareholder' } } } },
  { name: 'quote_mint', type: 'pubkey' },
  { name: 'quote_amount', type: 'u64' },
  { name: 'virtual_quote_reserves', type: 'u64' },
  { name: 'real_quote_reserves', type: 'u64' },
  { name: 'holder_rewards_bps', type: 'u64' },
  { name: 'holder_rewards', type: 'u64' },
  { name: 'creator_fee_unclaimed', type: 'u64' },
] as const satisfies readonly IdlField[];

export const CREATE_EVENT_LAYOUT = [
  { name: 'name', type: 'string' },
  { name: 'symbol', type: 'string' },
  { name: 'uri', type: 'string' },
  { name: 'mint', type: 'pubkey' },
  { name: 'bonding_curve', type: 'pubkey' },
  { name: 'user', type: 'pubkey' },
  { name: 'creator', type: 'pubkey' },
  { name: 'timestamp', type: 'i64' },
  { name: 'virtual_token_reserves', type: 'u64' },
  { name: 'virtual_sol_reserves', type: 'u64' },
  { name: 'real_token_reserves', type: 'u64' },
  { name: 'token_total_supply', type: 'u64' },
  { name: 'token_program', type: 'pubkey' },
  { name: 'is_mayhem_mode', type: 'bool' },
  { name: 'is_cashback_enabled', type: 'bool' },
  { name: 'quote_mint', type: 'pubkey' },
  { name: 'virtual_quote_reserves', type: 'u64' },
  { name: 'creator_fee_bps', type: 'u64' },
  { name: 'is_holder_reward', type: 'bool' },
  { name: 'depth', type: 'u8' },
] as const satisfies readonly IdlField[];

export const COMPLETE_EVENT_LAYOUT = [
  { name: 'user', type: 'pubkey' },
  { name: 'mint', type: 'pubkey' },
  { name: 'bonding_curve', type: 'pubkey' },
  { name: 'timestamp', type: 'i64' },
  { name: 'quote_mint', type: 'pubkey' },
] as const satisfies readonly IdlField[];

export const EVENT_LAYOUTS = {
  TradeEvent: TRADE_EVENT_LAYOUT,
  CreateEvent: CREATE_EVENT_LAYOUT,
  CompleteEvent: COMPLETE_EVENT_LAYOUT,
} as const;

export const Shareholder = z.strictObject({
  address: Pubkey,
  share_bps: U16,
});

export const TradeEventFields = z.strictObject({
  mint: Pubkey,
  sol_amount: U64,
  token_amount: U64,
  is_buy: z.boolean(),
  user: Pubkey,
  timestamp: I64,
  virtual_sol_reserves: U64,
  virtual_token_reserves: U64,
  real_sol_reserves: U64,
  real_token_reserves: U64,
  fee_recipient: Pubkey,
  fee_basis_points: U64,
  fee: U64,
  creator: Pubkey,
  creator_fee_basis_points: U64,
  creator_fee: U64,
  track_volume: z.boolean(),
  total_unclaimed_tokens: U64,
  total_claimed_tokens: U64,
  current_sol_volume: U64,
  last_update_timestamp: I64,
  /** The IDL documents "buy" | "sell" | "buy_exact_sol_in"; typed as the IDL's string. */
  ix_name: z.string(),
  mayhem_mode: z.boolean(),
  cashback_fee_basis_points: U64,
  cashback: U64,
  buyback_fee_basis_points: U64,
  buyback_fee: U64,
  shareholders: z.array(Shareholder),
  quote_mint: Pubkey,
  quote_amount: U64,
  virtual_quote_reserves: U64,
  real_quote_reserves: U64,
  holder_rewards_bps: U64,
  holder_rewards: U64,
  creator_fee_unclaimed: U64,
});

export const CreateEventFields = z.strictObject({
  name: z.string(),
  symbol: z.string(),
  uri: z.string(),
  mint: Pubkey,
  bonding_curve: Pubkey,
  user: Pubkey,
  creator: Pubkey,
  timestamp: I64,
  virtual_token_reserves: U64,
  virtual_sol_reserves: U64,
  real_token_reserves: U64,
  token_total_supply: U64,
  token_program: Pubkey,
  is_mayhem_mode: z.boolean(),
  is_cashback_enabled: z.boolean(),
  quote_mint: Pubkey,
  virtual_quote_reserves: U64,
  creator_fee_bps: U64,
  is_holder_reward: z.boolean(),
  depth: U8,
});

export const CompleteEventFields = z.strictObject({
  user: Pubkey,
  mint: Pubkey,
  bonding_curve: Pubkey,
  timestamp: I64,
  quote_mint: Pubkey,
});

export const EVENT_FIELD_SCHEMAS = {
  TradeEvent: TradeEventFields,
  CreateEvent: CreateEventFields,
  CompleteEvent: CompleteEventFields,
} as const;

/** What the collector adds to every decoded event. */
export const ChainMeta = {
  /** The slot of the transaction that emitted the event. */
  slot: Slot,
  /** That transaction's signature. */
  signature: Signature,
  /** Its block time (unix seconds), null when the RPC reported none. */
  block_time: z.int().nullable(),
  /**
   * 0-based position of the event in its mint's event chain, in chain order (assigned by the
   * collector after the per-token chain check). Datasets sort by (slot, mint, chain_seq).
   */
  chain_seq: z.int().min(0),
} as const;
export const COLLECTOR_FIELDS = Object.keys(ChainMeta) as (keyof typeof ChainMeta)[];

export const TradeEventRecord = z.strictObject({
  event: z.literal('TradeEvent'),
  ...TradeEventFields.shape,
  ...ChainMeta,
});
export const CreateEventRecord = z.strictObject({
  event: z.literal('CreateEvent'),
  ...CreateEventFields.shape,
  ...ChainMeta,
});
export const CompleteEventRecord = z.strictObject({
  event: z.literal('CompleteEvent'),
  ...CompleteEventFields.shape,
  ...ChainMeta,
});

export const ChainEvent = z.discriminatedUnion('event', [TradeEventRecord, CreateEventRecord, CompleteEventRecord]);

export type ShareholderT = z.infer<typeof Shareholder>;
export type TradeEvent = z.infer<typeof TradeEventFields>;
export type CreateEvent = z.infer<typeof CreateEventFields>;
export type CompleteEvent = z.infer<typeof CompleteEventFields>;
export type TradeEventRecordT = z.infer<typeof TradeEventRecord>;
export type CreateEventRecordT = z.infer<typeof CreateEventRecord>;
export type CompleteEventRecordT = z.infer<typeof CompleteEventRecord>;
export type ChainEventT = z.infer<typeof ChainEvent>;

/** Wrapped SOL: an instruction account for SOL-paired coins (pump docs, instructions/BUY.md), never an event's quote_mint. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Pubkey::default(): the quote_mint of every SOL-paired curve, in its account and in its events. */
export const DEFAULT_PUBKEY = '11111111111111111111111111111111';

/** True when an event's (or curve's) quote_mint means "traded against SOL". */
export function isSolQuoted(quoteMint: string): boolean {
  return quoteMint === DEFAULT_PUBKEY;
}

/** The *_sol_* / *_quote_* pairs of a TradeEvent. */
export const SOL_QUOTE_PAIRS = [
  ['sol_amount', 'quote_amount'],
  ['virtual_sol_reserves', 'virtual_quote_reserves'],
  ['real_sol_reserves', 'real_quote_reserves'],
] as const;

/**
 * Data errors in a TradeEvent's legacy SOL fields: on a SOL-quoted curve each *_sol_* field must
 * equal its *_quote_* twin; on any other curve the *_sol_* fields must be 0. Returns the offending
 * field names (empty when consistent). The *_quote_* fields are the ones to compute with.
 */
export function solQuoteMismatches(e: Pick<TradeEvent, 'quote_mint' | (typeof SOL_QUOTE_PAIRS)[number][number]>): string[] {
  const sol = isSolQuoted(e.quote_mint);
  return SOL_QUOTE_PAIRS.filter(([s, q]) => (sol ? e[s] !== e[q] : e[s] !== '0')).map(([s]) => s);
}

// ---------------------------------------------------------------- Borsh decoding

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Map([...B58].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = B58_INDEX.get(c);
    if (v === undefined) throw new EventDecodeError(`not base58: ${JSON.stringify(c)}`);
    n = n * 58n + v;
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export class EventDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventDecodeError';
  }
}

export interface DecodedEvent {
  event: EventName;
  /** Exactly the IDL's fields for that event, in the wire mapping above (parse with EVENT_FIELD_SCHEMAS). */
  fields: Record<string, unknown>;
  /** Bytes after the last named field (live TradeEvents carry 8). Ignored by the contract. */
  trailing: Uint8Array;
}

const DISCRIMINATOR_TO_EVENT = new Map<string, EventName>(EVENT_NAMES.map((n) => [EVENT_DISCRIMINATORS[n], n]));

function readLayout(layout: readonly IdlField[], bytes: Uint8Array, start: number): { fields: Record<string, unknown>; end: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let o = start;
  const need = (n: number, name: string) => {
    if (o + n > bytes.byteLength) throw new EventDecodeError(`event ends inside ${name} (needs ${o + n} bytes, has ${bytes.byteLength})`);
  };
  const fields: Record<string, unknown> = {};
  for (const { name, type } of layout) {
    if (typeof type === 'object') {
      need(4, name);
      const len = dv.getUint32(o, true);
      o += 4;
      const items: Record<string, unknown>[] = [];
      for (let i = 0; i < len; i++) {
        const r = readLayout(SHAREHOLDER_LAYOUT, bytes, o);
        items.push(r.fields);
        o = r.end;
      }
      fields[name] = items;
      continue;
    }
    switch (type) {
      case 'pubkey':
        need(32, name);
        fields[name] = base58Encode(bytes.subarray(o, o + 32));
        o += 32;
        break;
      case 'u64':
        need(8, name);
        fields[name] = dv.getBigUint64(o, true).toString();
        o += 8;
        break;
      case 'i64':
        need(8, name);
        fields[name] = dv.getBigInt64(o, true).toString();
        o += 8;
        break;
      case 'u16':
        need(2, name);
        fields[name] = dv.getUint16(o, true);
        o += 2;
        break;
      case 'u8':
        need(1, name);
        fields[name] = dv.getUint8(o);
        o += 1;
        break;
      case 'bool': {
        need(1, name);
        const b = dv.getUint8(o);
        if (b > 1) throw new EventDecodeError(`${name}: bool byte ${b}`);
        fields[name] = b === 1;
        o += 1;
        break;
      }
      case 'string': {
        need(4, name);
        const len = dv.getUint32(o, true);
        o += 4;
        need(len, name);
        try {
          fields[name] = utf8.decode(bytes.subarray(o, o + len));
        } catch {
          throw new EventDecodeError(`${name}: not UTF-8`);
        }
        o += len;
        break;
      }
    }
  }
  return { fields, end: o };
}

/**
 * Decode an event payload: 8-byte discriminator + Borsh body (a `Program data: <base64>` log line,
 * base64-decoded). Null when the discriminator is not one of the three events. Throws
 * EventDecodeError when the body is shorter than its layout or malformed.
 */
export function decodeEventData(data: Uint8Array): DecodedEvent | null {
  if (data.byteLength < 8) return null;
  const event = DISCRIMINATOR_TO_EVENT.get(bytesToHex(data.subarray(0, 8)));
  if (event === undefined) return null;
  const { fields, end } = readLayout(EVENT_LAYOUTS[event], data, 8);
  return { event, fields, trailing: data.subarray(end) };
}

/** Decode a self-CPI event instruction's data: EVENT_CPI_TAG + discriminator + body. */
export function decodeCpiEventData(data: Uint8Array): DecodedEvent | null {
  if (data.byteLength < 16 || bytesToHex(data.subarray(0, 8)) !== EVENT_CPI_TAG) return null;
  return decodeEventData(data.subarray(8));
}
