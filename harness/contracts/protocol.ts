// agent-fun/replay/v2: the line protocol between the grader's replay harness and an entrant's bot.
// One JSON object per line (UTF-8, `\n`-terminated, the `\n` not counted in the limits) on the bot's
// stdin (harness -> bot, at most MAX_HARNESS_LINE_BYTES per line) and stdout (bot -> harness, at most
// MAX_BOT_LINE_BYTES per line). Every message is zod-strict: an unknown key, a missing key or a
// malformed value is a protocol violation.
//
//   harness -> bot   hello                       once, first
//   harness -> bot   batch {seq, slot, ...}      once per slot that carries universe events, in order
//   bot -> harness   reply {seq, orders[]}       exactly one per batch, echoing its seq, before the
//                                                next batch is sent (lockstep)
//   harness -> bot   done                        once, last; the bot exits without replying
//
// Market model (the sim implements it; the bot is told the numbers in hello):
//   - Universe: SOL-quoted pump.fun curves that are neither mayhem-mode nor cashback-enabled and
//     created inside the window, sampled by sha256 of the mint (hello.universe).
//   - Orders decided on the batch for slot s fill at slot s + latency_slots, after that mint's last
//     recorded trade in that slot, against that trade's POST-trade reserves (constant product,
//     BigInt). With no trade for the mint in that slot, the latest earlier post-trade reserves.
//   - Persistent self-impact: on a bonding curve the price is a pure function of the reserves, so
//     the bot's own trades move it for good. Per mint the replay keeps the bot's net flow into the
//     curve (SOL its buys put in minus SOL its sells and closes took out; tokens its buys took out
//     minus tokens its sells and closes put back), and every later fill, close and mark on that mint
//     uses the recorded reserves shifted by it. Within a slot that is the curve advanced by the bot's
//     earlier fills there (reply order); across slots the shift rides on the recorded reserves of the
//     moment. So splitting an order, in one reply or over many slots, never buys more than sending it
//     whole. The shift is capped so the reserves never go below zero: when the recorded trades have
//     bought the curve's real tokens below the bot's net position (or sold its real SOL below what
//     the bot took out), the shift is scaled down to fit, so the bot's net position never counts
//     for more than the curve's real token reserve and a completed curve is met as recorded. Other
//     traders' recorded trades replay as they happened: no order ever moves a recorded event.
//   - Size: the buys on one mint in one reply may together spend at most
//     caps.max_order_bps_of_real_reserve of its decision-time real SOL reserve. In reply order, a buy
//     whose quote_lamports would take that total past the cap is rejected (max_order_size) and does
//     not count toward it. A sell whose curve output exceeds the real SOL reserve it fills against is
//     rejected (max_order_size) too: the curve cannot pay it.
//   - Count: orders past caps.max_orders_per_batch in one reply are rejected one by one (reason
//     max_orders_per_batch); a reply carrying more than replyOrderCap(hello) = max(64, 4 x
//     max_orders_per_batch) orders is a protocol violation that fails the run. The SDK shims refuse
//     a reply over max_orders_per_batch locally, so a bot sees the cap before the grader does.
//   - max_slippage_bps is measured against the output the decision-time reserves (the batch's
//     marks: the reserves the bot meets, its own impact included) would give; a worse fill beyond
//     it is rejected (reason max_slippage).
//   - A buy's quote_lamports is the SOL spent including curve fees; a sell's token_amount is the
//     tokens sold. Fees: the bps on the TradeEvent the fill lands on; when that event reports 0
//     bps, or there is none, the fallbacks in hello.fees (the fill is flagged fee_fallback).
//   - Each order pays base + priority tx fees; a seeded share of orders fail (status failed:
//     tx fees paid, nothing traded). Which ones is decided per (batch seq, order index) by a fail
//     key that is NOT hello.seed and is never sent to the bot (sim/rng.ts txFails). On the dev
//     phase the key is public (derived from the phase seed, so a kit's local grade reproduces dev
//     scores); on the final phase it is derived on the server from a secret (HKDF-SHA256 of the
//     server secret, label agent-fun/fail-key, over the phase seed: grader/worker.ts failKeyFor), so
//     nothing a bot is sent lets it predict which of its final-window orders fail.
//   - A CompleteEvent ends a mint's tradable life; positions are closed at its last trade's
//     post-trade reserves, and everything left is flattened when the replay ends. Those closes come
//     back as sell fills with client_id `_complete_<n>` or `_flatten_<n>`; a close whose proceeds
//     after curve fees would not cover its tx fees is abandoned instead (`_writeoff_<n>`: tokens
//     written off, nothing paid). Client ids starting with `_` are reserved for them: an order
//     carrying one is a protocol violation.
//
// u64 amounts are canonical decimal strings (read them with BigInt); slots are integers.

import { z } from 'zod';
import { ChainEvent, PUMP_PROGRAM_ID } from './events.ts';
import { Pubkey, Slot, U64 } from './primitives.ts';

export const PROTOCOL = 'agent-fun/replay/v2';
/** Harness -> bot lines (hello, batch, done) are at most this many UTF-8 bytes, `\n` not counted (1 MiB). */
export const MAX_HARNESS_LINE_BYTES = 1_048_576;
/** Bot -> harness lines (replies) are at most this many UTF-8 bytes, `\n` not counted (64 KiB). */
export const MAX_BOT_LINE_BYTES = 65_536;
export const PROTOCOL_SCHEMA_ID = 'https://make.fun/schemas/agent-fun/replay/v2.json';

export const Bps = z.int().min(0).max(10_000);
/** An order's id: 1-64 of [A-Za-z0-9_-], never starting with `_` (reserved for the harness's closes). */
export const ClientOrderId = z
  .string()
  .regex(/^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/, 'client_id: 1-64 of [A-Za-z0-9_-], not starting with _ (reserved for harness closes)');
/** The kinds of close the harness reports as fills, with client_id `_<kind>_<n>` (n counts closes from 0). */
export const HARNESS_CLOSE_KINDS = ['complete', 'flatten', 'writeoff'] as const;
/** A fill's client_id: the order's, or a harness close's `_complete_<n>`, `_flatten_<n>` or `_writeoff_<n>`. */
export const FillClientId = z
  .string()
  .max(64)
  .regex(/^(?:[A-Za-z0-9-][A-Za-z0-9_-]{0,63}|_(?:complete|flatten|writeoff)_(?:0|[1-9][0-9]*))$/, 'client_id: an order id or _complete_<n>, _flatten_<n>, _writeoff_<n>');
export const Seq = z.int().min(0);

/**
 * Which mints the replay delivers. A mint is in the universe iff its curve is SOL-quoted (the
 * CreateEvent's quote_mint is Pubkey::default(), events.ts isSolQuoted), not mayhem-mode
 * (is_mayhem_mode false) and not cashback-enabled (is_cashback_enabled false), all three read from
 * its CreateEvent, and sha256(UTF-8 bytes of the base58 mint), read as a big-endian unsigned integer,
 * mod `modulus` equals `residue`. Create-time facts only, so the sample carries no outcome bias.
 */
export const UniverseSample = z
  .strictObject({
    hash: z.literal('sha256'),
    modulus: z.int().min(1),
    residue: z.int().min(0),
  })
  .refine((s) => s.residue < s.modulus, 'residue must be below modulus');

export const Universe = z.strictObject({
  program: z.literal(PUMP_PROGRAM_ID),
  quote: z.literal('SOL'),
  /** Mayhem-mode coins (CreateEvent is_mayhem_mode) are never delivered. */
  mayhem: z.literal('excluded'),
  /** Cashback-enabled coins (CreateEvent is_cashback_enabled) are never delivered. */
  exclude_cashback: z.literal(true),
  sample: UniverseSample,
});

export const Capital = z.strictObject({
  /** Starting cash. */
  lamports: U64,
});

export const Caps = z.strictObject({
  max_open_positions: z.int().min(1),
  /**
   * The buys on one mint in one reply may together spend at most this share (bps) of the mint's real
   * SOL reserve at decision time; in reply order, a buy that would take the total past it is rejected
   * (reason max_order_size) and does not count toward it.
   */
  max_order_bps_of_real_reserve: Bps,
  /**
   * Orders beyond this many in one reply are rejected one by one (reason max_orders_per_batch); a
   * reply with more than replyOrderCap = max(64, 4 x this) orders fails the run.
   */
  max_orders_per_batch: z.int().min(0),
  shorts: z.literal(false),
  leverage: z.literal(false),
});

export const Fees = z.strictObject({
  /** Protocol fee used when the landing TradeEvent reports 0 bps or there is none (Global: 95). */
  protocol_bps_fallback: Bps,
  /** Creator fee used in the same cases (Global: 30). */
  creator_bps_fallback: Bps,
  base_fee_lamports: U64,
  priority_fee_lamports: U64,
  /**
   * Share of orders whose transaction fails, in bps. The draw is keyed by the run's fail key, not
   * by hello.seed (see the header): secret on the final phase.
   */
  failed_tx_bps: Bps,
});

export const Hello = z.strictObject({
  type: z.literal('hello'),
  protocol: z.literal(PROTOCOL),
  /**
   * The phase's seed (u64), the same for every entry of a phase: seed the bot's own randomness from
   * it. The failed-transaction draw is not keyed by it (see the header).
   */
  seed: U64,
  universe: Universe,
  capital: Capital,
  caps: Caps,
  /** L: orders decided at slot s fill at slot s + L. */
  latency_slots: z.int().min(0),
  fees: Fees,
});

/**
 * The reserves the bot meets on a mint it holds or has an order pending in: the latest recorded
 * post-trade reserves, shifted by the bot's own net flow into the curve (see the header). Without
 * fills of its own on the mint, exactly the recorded ones.
 */
export const Mark = z.strictObject({
  mint: Pubkey,
  /** Slot of the recorded trade these reserves follow. */
  slot: Slot,
  virtual_token_reserves: U64,
  virtual_quote_reserves: U64,
  real_token_reserves: U64,
  real_quote_reserves: U64,
});

export const Position = z.strictObject({
  mint: Pubkey,
  token_amount: U64,
  /** SOL spent on the tokens still held (fees included). */
  cost_lamports: U64,
});

export const Account = z.strictObject({
  cash_lamports: U64,
  positions: z.array(Position),
});

export const Side = z.enum(['buy', 'sell']);

export const REJECT_REASONS = [
  'max_slippage',
  'max_open_positions',
  'max_order_size',
  'max_orders_per_batch',
  'insufficient_cash',
  'insufficient_tokens',
  'not_in_universe',
  'token_complete',
  'zero_amount',
  'duplicate_client_id',
  'after_end',
] as const;
export const RejectReason = z.enum(REJECT_REASONS);

/**
 * How an order resolved: filled, rejected (nothing paid), or failed (tx fees paid, nothing traded).
 * The harness's closes are fills too: side sell, status filled, decided_slot = slot = the closing
 * slot, client_id `_complete_<n>` (the curve completed), `_flatten_<n>` (the replay ended) or
 * `_writeoff_<n>` (the close would not cover its tx fees: tokens written off, quote_lamports 0).
 */
export const Fill = z.strictObject({
  /** The order's client_id, or a harness close's (see above). */
  client_id: FillClientId,
  mint: Pubkey,
  side: Side,
  status: z.enum(['filled', 'rejected', 'failed']),
  /** Set exactly when status is rejected. */
  reason: RejectReason.nullable(),
  /** Slot of the batch the order was decided on. */
  decided_slot: Slot,
  /** Slot it resolved at (decided_slot + latency_slots). */
  slot: Slot,
  /** Buy: SOL spent, fees included. Sell: SOL received, fees deducted. "0" unless filled. */
  quote_lamports: U64,
  /** Buy: tokens received. Sell: tokens sold. "0" unless filled. */
  token_amount: U64,
  /** Curve fees (protocol + creator + any other fee the event charges). */
  fee_lamports: U64,
  /** Base + priority transaction fees. */
  tx_fee_lamports: U64,
  fee_fallback: z.boolean(),
});

export const Batch = z.strictObject({
  type: z.literal('batch'),
  seq: Seq,
  slot: Slot,
  /** This slot's universe events in chain order. */
  events: z.array(ChainEvent),
  marks: z.array(Mark),
  /** Orders that resolved since the previous batch, in resolution order. */
  fills: z.array(Fill),
  /** The bot's account after those fills. */
  account: Account,
});

export const Done = z.strictObject({
  type: z.literal('done'),
  seq: Seq,
  reason: z.enum(['end_of_data', 'aborted']),
  /** The final account after flattening. */
  account: Account,
});

export const BuyOrder = z.strictObject({
  side: z.literal('buy'),
  client_id: ClientOrderId,
  mint: Pubkey,
  /** SOL to spend, curve fees included. */
  quote_lamports: U64,
  max_slippage_bps: Bps,
});

export const SellOrder = z.strictObject({
  side: z.literal('sell'),
  client_id: ClientOrderId,
  mint: Pubkey,
  token_amount: U64,
  max_slippage_bps: Bps,
});

export const Order = z.discriminatedUnion('side', [BuyOrder, SellOrder]);

export const Reply = z.strictObject({
  type: z.literal('reply'),
  /** The seq of the batch this answers. */
  seq: Seq,
  orders: z.array(Order),
});

export const HarnessMessage = z.discriminatedUnion('type', [Hello, Batch, Done]);
export const BotMessage = Reply;

export type HelloT = z.infer<typeof Hello>;
export type BatchT = z.infer<typeof Batch>;
export type DoneT = z.infer<typeof Done>;
export type ReplyT = z.infer<typeof Reply>;
export type OrderT = z.infer<typeof Order>;
export type FillT = z.infer<typeof Fill>;
export type MarkT = z.infer<typeof Mark>;
export type AccountT = z.infer<typeof Account>;
export type CapsT = z.infer<typeof Caps>;
export type FeesT = z.infer<typeof Fees>;
export type UniverseT = z.infer<typeof Universe>;
export type HarnessMessageT = z.infer<typeof HarnessMessage>;
export type RejectReasonT = z.infer<typeof RejectReason>;

/** The floor of replyOrderCap: a reply may always carry this many orders without failing the run. */
export const MIN_REPLY_ORDER_CAP = 64;

/**
 * The most orders one reply may carry before it is a protocol violation that fails the run:
 * max(64, 4 x caps.max_orders_per_batch). Orders past max_orders_per_batch but within it are
 * rejected one by one (reason max_orders_per_batch).
 */
export function replyOrderCap(hello: { caps: Pick<CapsT, 'max_orders_per_batch'> }): number {
  return Math.max(MIN_REPLY_ORDER_CAP, 4 * hello.caps.max_orders_per_batch);
}

/**
 * Parse one line from the bot: size cap, JSON, then the strict Reply schema. Returns the reply or
 * a reason string (the grader turns a reason into a protocol-violation failure).
 */
export function parseBotLine(line: string): { ok: true; reply: ReplyT } | { ok: false; reason: string } {
  const bytes = new TextEncoder().encode(line).byteLength;
  if (bytes > MAX_BOT_LINE_BYTES) return { ok: false, reason: `line is ${bytes} bytes (max ${MAX_BOT_LINE_BYTES})` };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  const parsed = Reply.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `not a reply: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}` };
  }
  return { ok: true, reply: parsed.data };
}

/**
 * The protocol as one JSON Schema (draft 2020-12) document: `$defs.harness_message` is what the
 * bot reads, `$defs.bot_message` what it writes. Published in every competition kit.
 */
export function protocolJsonSchema(): Record<string, unknown> {
  const strip = (schema: Record<string, unknown>) => {
    const { $schema: _drop, ...rest } = schema;
    return rest;
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: PROTOCOL_SCHEMA_ID,
    title: PROTOCOL,
    description:
      `makefun replay protocol v2: newline-delimited JSON, harness -> bot on stdin (hello, batch..., done), bot -> harness on stdout (one reply per batch, echoing its seq). Harness lines are at most ${MAX_HARNESS_LINE_BYTES} bytes, bot lines at most ${MAX_BOT_LINE_BYTES} bytes (UTF-8, the newline not counted). Client ids starting with _ are reserved for the harness's closes. u64 values are decimal strings.`,
    $defs: {
      harness_message: strip(z.toJSONSchema(HarnessMessage, { io: 'output' }) as Record<string, unknown>),
      bot_message: strip(z.toJSONSchema(BotMessage, { io: 'input' }) as Record<string, unknown>),
    },
  };
}
