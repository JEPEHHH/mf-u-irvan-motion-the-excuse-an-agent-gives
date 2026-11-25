// List-price cost of one transcript line, against the frozen rows in pricing/rows.json (ported
// from cosmos src/shared/model-pricing.ts by pricing/port-from-cosmos.ts, with the cited OpenAI
// rows of pricing/overrides.json merged in; the commit is `PRICING_ROWS.source.sha`, the override
// file's hash `PRICING_ROWS.source.overrides`). Every line is priced at its OWN timestamp — `at` is required and
// there is no clock fallback — and a model with no row prices to null, never 0n, but for a request a session
// sent to a runtime on the entrant's own machine, which priceSessionUsage prices at $0 (see below). That $0 reaches
// thinking_priced's price check only, never an entry's build cost or a cost rank: ingest's usage lines, regrades and
// authorship price by the table alone, so a local record's cost stays unpriced there (cost_unpriced).
//
//   priceUsage({ model: 'claude-opus-5-5', at: line.timestamp, format: 'anthropic', usage: message.usage })
//   priceUsage({ model, at: event.timestamp, format: 'openai', usage: payload.info.last_token_usage })
//
// `pricingRev` names the rows a figure was priced under; store it beside every figure.

import rowsJson from './rows.json' with { type: 'json' };
import { createPricer, type PriceUsageArgs, type PricedUsage, type Pricer } from './engine.ts';

export {
  createPricer,
  normalizeUsage,
  pricingRevOf,
  PricingRowsDoc,
  PRICING_ROWS_SCHEMA,
  RATE_UNIT,
  type NormalizedUsage,
  type PeriodT,
  type PriceUsageArgs,
  type PricedUsage,
  type Pricer,
  type PricingRowsDocT,
  type RatesT,
  type TokenCounts,
  type UsageFormat,
} from './engine.ts';

const bundled = createPricer(rowsJson);

/** The bundled rows document, validated. */
export const PRICING_ROWS = bundled.doc;

/** sha256 hex of the bundled rows' canonical JSON (provenance excluded); see pricingRevOf. */
export const pricingRev: string = bundled.pricingRev;

/** Price one request's usage at the bundled rows. */
export function priceUsage(args: PriceUsageArgs): PricedUsage {
  return bundled.priceUsage(args);
}

/** The bundled row index `model` bills on, or null when it is unpriced. */
export function resolveRow(model: string): number | null {
  return bundled.resolveRow(model);
}

// ------------------------------------------------------------------ a model run on the entrant's own machine
//
// A request a session sent to a model runtime on the entrant's own machine costs nothing (the owner's decision of
// 2026-11-13: "local models at $0"), so a usage record of one prices at $0 instead of null. Where the call went is
// read only from what the session's reader recorded about it (transcripts/types.ts NormalizedSession: its
// `source` and agent.extra's model_provider and api_base), never from the model's name, which is the entrant's to
// choose. In order:
//
//   chat-log     a log the entrant exported itself (DECLARED_SOURCES): its provider is typed, never local.
//   api_base     a base URL the reader recorded that is not a loopback host (localhost, 127.0.0.0/8, ::1, 0.0.0.0):
//                the calls went over the network, so nothing is local. Every recorded one loopback: local.
//   model_cloud  "true" among the Ollama app's per-message cloud flags (transcripts/ollama.ts): not local.
//   source       a reader of a local runtime's own store (LOCAL_SOURCES: LM Studio's conversations, oMLX's chats).
//   model_provider  every provider the session names is a local runtime (LOCAL_PROVIDERS: Codex's built-in OSS
//                providers `ollama` and `lmstudio`, which codex-rs model-provider-info built_in_model_providers
//                points at localhost and does not let a config override, and the ids other harnesses give
//                Ollama, LM Studio and llama.cpp). A session naming any other provider beside them is local only
//                where every base URL it records is loopback (above): else its records cannot be told apart.
//
// Two limits keep a hosted call from pricing at $0. A record whose model the table prices keeps its list price
// whatever the session says (a loopback proxy in front of a hosted model, such as a local router, still bills the
// hosted model). And a model id carrying Ollama's cloud tag (`gemma4:cloud`, `gpt-oss:120b-cloud`: docs.ollama.com
// /cloud/models, "use the `:cloud` name") runs in Ollama's cloud though the session calls the local server, so it
// stays unpriced.

/** What a session records about where its model calls went (NormalizedSession's `source` and `agent.extra`). */
export interface CallSite {
  source: string;
  agent: { extra: Readonly<Record<string, string>> };
}

/** Readers whose store is a local runtime's own (transcripts/lmstudio.ts, transcripts/omlx.ts), by source. */
export const LOCAL_SOURCES: Readonly<Record<string, string>> = Object.freeze({ lmstudio: 'LM Studio', omlx: 'oMLX' });

/** Provider ids naming a runtime on the entrant's machine, lowercase, and the runtime each names. */
export const LOCAL_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  'lm-studio': 'LM Studio',
  'lm studio': 'LM Studio',
  'llama.cpp': 'llama.cpp',
  llamacpp: 'llama.cpp',
  'llama-cpp': 'llama.cpp',
});

/**
 * Readers whose provider and base URL are what the entrant typed into a file it wrote (transcripts/chat-log.ts: a
 * self-exported log's `provider`), the entrant's to choose like a model name, so they say nothing of where a call went.
 */
const DECLARED_SOURCES: ReadonlySet<string> = new Set(['chat-log']);

/** Ollama's cloud tag: a model the local server forwards to Ollama's cloud. */
const OLLAMA_CLOUD_TAG = /[:-]cloud$/i;

const listOf = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** The host of a recorded api_base (a host, host:port or a URL), lowercase, without brackets; null when unreadable. */
function hostOfBase(base: string): string | null {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `http://${base}`);
    return url.hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Whether a host is this machine: localhost (and *.localhost), 127.0.0.0/8, ::1 or 0.0.0.0. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '0.0.0.0') return true;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return v4 !== null && v4.slice(1).every((o) => Number(o) <= 255);
}

/**
 * The runtime on the entrant's own machine a session's calls went to (see the header above), or null when the
 * session does not record one, or records a call that went elsewhere.
 */
export function localRuntimeOf(site: CallSite): string | null {
  if (DECLARED_SOURCES.has(site.source)) return null;
  const extra = site.agent.extra;
  const bases = listOf(extra.api_base);
  const hosts = bases.map(hostOfBase);
  if (hosts.some((h) => h === null || !isLoopbackHost(h))) return null;
  if (listOf(extra.model_cloud).some((v) => v.toLowerCase() === 'true')) return null;
  const providers = listOf(extra.model_provider).map((p) => p.toLowerCase());
  const named = providers.map((p) => (Object.hasOwn(LOCAL_PROVIDERS, p) ? LOCAL_PROVIDERS[p]! : null));
  if (named.some((n) => n === null)) {
    // A provider that is no local runtime: local only where every recorded base URL says so.
    return hosts.length > 0 ? `a loopback server (${bases.join(', ')})` : null;
  }
  if (Object.hasOwn(LOCAL_SOURCES, site.source)) return LOCAL_SOURCES[site.source]!;
  if (named.length > 0) return [...new Set(named)].join(', ');
  return hosts.length > 0 ? `a loopback server (${bases.join(', ')})` : null;
}

/** A priced usage record, and the local runtime that made it cost $0 (null: priced, or left unpriced, by the table). */
export interface SitePricedUsage extends PricedUsage {
  local: string | null;
}

/**
 * Price one usage record of a session with `pricer`: the table's list price when it prices the model; else $0
 * when the session ran it on the entrant's own machine (localRuntimeOf) and the id carries no Ollama cloud tag;
 * else unpriced (null), never 0n. Throws as `pricer.priceUsage` does on a record it refuses.
 */
export function priceSessionUsage(pricer: Pick<Pricer, 'priceUsage'>, site: CallSite, record: PriceUsageArgs): SitePricedUsage {
  const priced = pricer.priceUsage({ model: record.model, at: record.at, format: record.format, usage: record.usage });
  if (priced.microUsd !== null) return { ...priced, local: null };
  const runtime = localRuntimeOf(site);
  if (runtime === null || OLLAMA_CLOUD_TAG.test(record.model.trim())) return { ...priced, local: null };
  return { ...priced, microUsd: 0n, tier: 'base', local: runtime };
}
