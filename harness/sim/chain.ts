// The per-mint chain check a dataset must pass before a replay runs on it. A dataset is a list of
// ChainEvent records sorted by (slot, mint, chain_seq); each mint's events form one chain:
//
//   order               (slot, mint, chain_seq) strictly increases over the whole file
//   chain_seq           0-based position in the mint's chain: a CreateEvent is at 0, every next event
//                       of that mint is exactly one higher
//   reserves            each TradeEvent's post-trade reserves equal applyTrade(previous post-trade
//                       reserves, its amounts) (sim/curve.ts); the first previous state is the
//                       CreateEvent's initial reserves
//   sol / quote         the legacy *_sol_* fields equal their *_quote_* twins
//   quote mint          every event of a mint names its CreateEvent's quote_mint
//   lifecycle           one CreateEvent at most; nothing after the CompleteEvent
//   records             (opt-in) each record passes the strict ChainEvent schema
//
// Those are fatal: a replay refuses a dataset with any of them in its universe. Two findings are
// reported but not fatal, because the replay never reads them (it prices its own fills with
// sim/curve.ts and reads only post-trade reserves from the data):
//   formula             a trade's curve output or fees disagree with sim/curve.ts
//   complete_with_tokens  a CompleteEvent while the curve still holds real tokens

import { ChainEvent, type ChainEventT, type TradeEventRecordT } from '../contracts/events.ts';
import { applyTrade, createState, CurveDataError, sameState, stateToJson, tradeFormulaIssues, tradePostState, type CurveState } from './curve.ts';

export const FATAL_ISSUES = [
  'order',
  'chain_seq',
  'sol_quote_mismatch',
  'quote_mint_mismatch',
  'reserve_mismatch',
  'duplicate_create',
  'after_complete',
  'invalid_record',
] as const;
export const WARNING_ISSUES = ['formula', 'complete_with_tokens'] as const;
export type ChainIssueKind = (typeof FATAL_ISSUES)[number] | (typeof WARNING_ISSUES)[number];

export interface ChainIssue {
  kind: ChainIssueKind;
  fatal: boolean;
  /** Index of the offending record in the dataset. */
  index: number;
  mint: string | null;
  slot: number | null;
  chain_seq: number | null;
  signature: string | null;
  detail: string;
}

export interface ChainReport {
  events_checked: number;
  mints_checked: number;
  issues: ChainIssue[];
  /** No fatal issue. */
  ok: boolean;
}

export interface ChainCheckOptions {
  /** Check only these mints' chains (the order rule always covers every record). Default: all. */
  mints?: (mint: string) => boolean;
  /** Also parse each checked record with the strict ChainEvent schema. Default false. */
  schema?: boolean;
}

interface MintChain {
  lastSeq: number;
  state: CurveState | null;
  quoteMint: string | null;
  created: boolean;
  complete: boolean;
}

const FATAL = new Set<string>(FATAL_ISSUES);

function compareKey(a: ChainEventT, b: ChainEventT): number {
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.mint !== b.mint) return a.mint < b.mint ? -1 : 1;
  return a.chain_seq - b.chain_seq;
}

/** Run the chain check over a dataset's records. */
export function checkChain(events: readonly ChainEventT[], opts: ChainCheckOptions = {}): ChainReport {
  const want = opts.mints ?? (() => true);
  const issues: ChainIssue[] = [];
  const chains = new Map<string, MintChain>();
  let checked = 0;
  const add = (kind: ChainIssueKind, index: number, e: Partial<ChainEventT> | null, detail: string) =>
    issues.push({
      kind,
      fatal: FATAL.has(kind),
      index,
      mint: (e?.mint as string | undefined) ?? null,
      slot: (e?.slot as number | undefined) ?? null,
      chain_seq: (e?.chain_seq as number | undefined) ?? null,
      signature: (e?.signature as string | undefined) ?? null,
      detail,
    });

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (i > 0 && compareKey(events[i - 1]!, e) >= 0) {
      const p = events[i - 1]!;
      add('order', i, e, `(${e.slot}, ${e.mint}, ${e.chain_seq}) does not follow (${p.slot}, ${p.mint}, ${p.chain_seq})`);
    }
    if (!want(e.mint)) continue;
    checked++;
    if (opts.schema) {
      const parsed = ChainEvent.safeParse(e);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        add('invalid_record', i, e, issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid');
        continue;
      }
    }
    let c = chains.get(e.mint);
    if (c === undefined) {
      c = { lastSeq: e.chain_seq - 1, state: null, quoteMint: null, created: false, complete: false };
      chains.set(e.mint, c);
    }
    if (e.chain_seq !== c.lastSeq + 1) add('chain_seq', i, e, `chain_seq ${e.chain_seq} after ${c.lastSeq}`);
    c.lastSeq = e.chain_seq;
    if (c.complete) add('after_complete', i, e, `${e.event} after the CompleteEvent`);
    if (c.quoteMint !== null && e.quote_mint !== c.quoteMint) add('quote_mint_mismatch', i, e, `quote_mint ${e.quote_mint} != the CreateEvent's ${c.quoteMint}`);

    switch (e.event) {
      case 'CreateEvent': {
        if (c.created) add('duplicate_create', i, e, 'a second CreateEvent');
        else if (e.chain_seq !== 0) add('chain_seq', i, e, `CreateEvent at chain_seq ${e.chain_seq}, expected 0`);
        c.created = true;
        c.quoteMint = e.quote_mint;
        try {
          c.state = createState(e);
        } catch (err) {
          add('sol_quote_mismatch', i, e, (err as Error).message);
          c.state = { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: 0n, rt: BigInt(e.real_token_reserves) };
        }
        break;
      }
      case 'TradeEvent': {
        let post: CurveState;
        try {
          post = tradePostState(e);
        } catch (err) {
          if (!(err instanceof CurveDataError)) throw err;
          add('sol_quote_mismatch', i, e, err.message);
          post = { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: BigInt(e.real_quote_reserves), rt: BigInt(e.real_token_reserves) };
        }
        if (c.state !== null) {
          const expect = applyTrade(c.state, e);
          if (!sameState(expect, post)) {
            add('reserve_mismatch', i, e, `post ${JSON.stringify(stateToJson(post))} != applyTrade(previous post, amounts) ${JSON.stringify(stateToJson(expect))}`);
          } else {
            for (const f of tradeFormulaIssues(c.state, e as TradeEventRecordT)) add('formula', i, e, f);
          }
        }
        c.state = post;
        break;
      }
      case 'CompleteEvent': {
        if (c.state !== null && c.state.rt !== 0n) add('complete_with_tokens', i, e, `CompleteEvent with real_token_reserves ${c.state.rt}`);
        c.complete = true;
        break;
      }
    }
  }
  return { events_checked: checked, mints_checked: chains.size, issues, ok: !issues.some((x) => x.fatal) };
}
