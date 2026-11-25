// Port cosmos's list-price table into frozen pricing rows.
//
//   node pricing/port-from-cosmos.ts [--repo <cosmos checkout>] [--rev <commit-ish>] [--check]
//
// Reads src/shared/model-pricing.ts — and the modules it imports for its alias fallback
// (claude-flagship, model-knobs, oauth-gateway, and what they import) — at ONE cosmos commit
// (default HEAD), straight out of git: every source file is served by `git show <sha>:<path>`
// through a module hook, so the working tree's edits never leak in. The REAL modules run; this
// script reads their tables (appending `export { … }` for the module-private ones) and resolves
// at port time what the source resolves at call time:
//   - each row's intro price, and an override row's dated `change`, become dated periods
//     (effective_from inclusive, effective_to exclusive, UTC), each with its base rates and
//     long-context tier, audio folded in;
//   - each generation-less family shorthand (`opus`) becomes the row its flagship bills on;
//   - the id grammar's tables (family words, decoration words, provider prefix, gateway ids).
// Rates become integers in micro-USD per million tokens; a rate finer than that aborts the port.
//
// pricing/overrides.json (validated by pricing/overrides.ts) is merged into the source's table
// first: rows read off a vendor's own pricing pages (OpenAI's, Google's Gemini API, Alibaba Cloud
// Model Studio's, Anthropic's, Devin's, Z.ai's, the Kimi API's, MiniMax's, OpenCode Console's, GitHub Copilot's, xAI's, Inception's,
// Agnes AI's, Upstage's, Mistral's, OpenRouter's: its `:free` variants, and its models API for open-weight models whose maker
// publishes no per-token price), each cited with its URL, retrieval instant and
// the verbatim lines it rests on, that reprice a source row (refused once cosmos no longer lists
// the rates the override says it replaces), add one for an id the source prices null (refused if
// it would take an id another row prices), or add a model's Fast-mode row right ahead of its
// Standard row (refused unless it is exactly its multiplier × that row, and unless every probed
// `-fast` id of an OpenAI model bills on its own model's Fast row or nowhere); a replace may also
// anchor its source row's pattern (`anchor`), releasing the ids the source's took and it does not to
// price null or on a row of the layer, never on another source row. Its `aliases` widen
// a row's pattern last, for ids no page prices that bill on that row (each a probe here, refused if
// the source prices it or if it lands on another row; checks read the widened row by its own
// pattern). Everything below —
// conversion, parity, the probe coverage rule — runs over the merged table, and rows.json names
// the override file by sha256.
//
// Before writing, a probe corpus (model ids × instants × usages) is priced twice — by the
// source's own `baseModelPricing` / `listPriceCostUsd` and by pricing/engine.ts over the new
// rows — and any disagreement in row or cost aborts. The source's answers are written to
// pricing/parity.json so tests/unit/pricing.test.ts can hold the port to them without cosmos.
// Every row must be hit by some probe, so a new source or override row forces a new probe here.
//
// Deterministic: one commit and one override file always yield byte-identical rows.json and
// parity.json. `--check` regenerates in memory and fails if the files on disk differ.
//
// A port that moves the pricing revision keeps the rows.json it replaces, byte for byte, as
// pricing/revs/<its revision>.json (entries received under it are still priced under it:
// pricing/revs.ts), and fails until pricing/revs.ts lists it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createPricer,
  PRICING_ROWS_SCHEMA,
  RATE_UNIT,
  type PeriodT,
  type PricingRowsDocT,
  type RatesT,
  type TokenCounts,
} from './engine.ts';
import { loadOverrides, OVERRIDES_PATH, OVERRIDES_REL_PATH, standardSpelling, type OverrideAliasT, type OverrideRowT } from './overrides.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROWS_PATH = path.join(HERE, 'rows.json');
const PARITY_PATH = path.join(HERE, 'parity.json');
const REVS_DIR = path.join(HERE, 'revs');
const SOURCE_PATH = 'src/shared/model-pricing.ts';
export const PARITY_SCHEMA = 'agent-fun/pricing-parity/v1';
/** Source floats × 1e6 vs. our exact half-up rounding: at most half a micro-dollar apart. */
export const PARITY_TOLERANCE_MICRO_USD = 0.501;

// ------------------------------------------------------------------ probe corpus

const PROBE_MODELS: readonly string[] = [
  // Anthropic wire ids, point releases and the rows they must not steal.
  'claude-fable-5-1', 'claude-fable-5.1', 'claude-fable-5-10', 'claude-fable-5', 'claude-fable5',
  'claude-mythos-5-1', 'claude-mythos-5.1', 'claude-mythos-5',
  'claude-opus-5-5', 'claude-opus-5.5', 'claude-opus-5-50', 'claude-opus-5', 'claude-opus-4-8',
  'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-6',
  'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4',
  'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-haiku-5', 'claude-haiku-3-5',
  // Spellings: routes, vendor prefixes, window tags, effort suffixes, case, whitespace, dates.
  'router/claude-fable-5-1', 'anthropic/claude-opus-5-5', 'anthropic:claude-sonnet-5-5',
  'claude-opus-5-5[1m]', 'claude-opus-5-5(high)', 'Claude-Opus-5-5', '  claude-opus-5-5  ',
  'claude-opus-20250514', 'claude-fable-latest', '~anthropic/claude-opus-latest', 'router/claude-opus-7',
  // Router shorthands (the alias fallback).
  'opus', 'sonnet', 'haiku', 'fable', 'mythos', 'opus1m-xhigh', 'anthropic:fable1m-high(high)',
  'opus-xhigh[1m]', 'sonnet-fast', 'haiku:max', 'fable1m', 'mythos1m-high', 'router/opus', 'OPUS',
  // OpenAI.
  'gpt-6.1-sol', 'gpt-6-1-sol', 'gpt-6-astra', 'router/gpt-6-astra', 'gpt-6-astra(high)', 'gpt-6-sol',
  'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5-5', 'gpt-5.5-high',
  'gpt-5.5[fast]', 'gpt-5.5-pro', 'gpt-5.5-mini', 'gpt-5.3-codex', 'gpt-5-3-codex', 'gpt-5',
  'openai:gpt-6-sol', 'gpt-audio', 'gpt-audio-1.5', 'gpt-audio-2026-08-28', 'gpt-audio-mini',
  'gpt-audio-mini-2026-08-28', 'gpt-audio-2',
  // OpenAI rows the override layer adds (pricing/overrides.json), the decorations Codex, Cursor
  // and the router put on them, and the siblings they must leave null.
  'gpt-6.1-terra', 'gpt-6-1-terra', 'gpt-6.1-terra(high)', 'router/gpt-6.1-terra', 'gpt-5.6', 'gpt-5.6-high',
  'gpt-5.6-cyber', 'gpt-5.6-sol-high-fast', 'gpt-5.5-pro-xhigh', 'gpt-5.5-cyber', 'gpt-5.5-high-fast',
  'gpt-5.5-2026-04-23', 'gpt-5.4', 'gpt-5-4', 'gpt-5.4-xhigh', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
  'gpt-5.4-none', 'gpt-5.2', 'gpt-5.2-pro', 'gpt-5.2-codex', 'gpt-5.2-codex-high-grind', 'gpt-5.1', 'gpt-5.1-codex',
  'gpt-5.1-codex-max', 'gpt-5.1-codex-max-xhigh', 'gpt-5.1-codex-mini', 'gpt-5-high', 'openai/gpt-5', 'gpt-5-mini',
  'gpt-5-nano', 'gpt-5-pro', 'gpt-5-codex', 'gpt-5-codex-mini', 'gpt-5-search-api', 'gpt-5-chat-latest', 'gpt-5-fast',
  // Fast mode (the override layer's `fast` rows): every Fast row under the spellings Cursor
  // (`-high-fast`), a router (`router/`, `openai:`, `-fast-xhigh`, `(high)`, `[1m]`) and case put
  // on it, and the -fast ids of models OpenAI's Fast table does not list, which price null.
  'gpt-6.1-sol-fast', 'gpt-6-1-sol-fast', 'router/gpt-6.1-sol-fast', 'gpt-6.1-sol-fast(high)', 'gpt-6.1-sol-xhigh-fast',
  'gpt-6.1-terra-high-fast', 'gpt-6-astra-fast', 'gpt-6-astra-fast-xhigh', 'gpt-6-sol-fast', 'gpt-6-luna-fast',
  'gpt-5.6-sol-fast', 'GPT-5.6-SOL-FAST', 'gpt-5.6-terra-fast', 'gpt-5.6-luna-low-fast', 'gpt-5.6-fast', 'gpt-5.6-high-fast',
  'gpt-5.5-fast', 'gpt-5-5-fast', 'gpt-5.5-fast[1m]', 'openai:gpt-5.5-xhigh-fast', 'gpt-5.4-fast', 'gpt-5.4-mini-fast',
  'gpt-5.3-codex-fast', 'gpt-5.2-xhigh-fast', 'gpt-5.1-fast', 'gpt-5-high-fast', 'gpt-5-mini-fast',
  'gpt-5.6-cyber-fast', 'gpt-5.5-pro-fast', 'gpt-5.4-nano-fast', 'gpt-5-nano-fast', 'gpt-5.1-codex-max-high-fast', 'gpt-5.2-codex-fast',
  // Codex's Auto-review reviewer slug (pricing/overrides.json aliases: on the gpt-5.4 row), and spellings it must leave null.
  'codex-auto-review', 'openai/codex-auto-review', 'codex-auto-review-fast', 'codex-auto-reviewer',
  // xAI.
  'grok-4.6', 'grok-4-7', 'grok-4.60', 'grok-4.5', 'grok-4.3', 'grok-build-0.1', 'grok-3', 'xai:grok-4.6',
  // Google.
  'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3-6-flash', 'gemini-3.8-flash-lite',
  'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro', 'gemini-2.5-pro',
  // Google rows the override layer adds for Gemini CLI's models, and the siblings they must leave
  // null: a shut-down preview, Code Assist's own gemini-3-flash, TTS / image ids, retired snapshots.
  'gemini-2.5-pro-high', 'google/gemini-2.5-pro', 'gemini-2.5-pro-preview-tts', 'gemini-2.5-pro-preview-06-05',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts',
  'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3-5-flash', 'gemini-3.7-flash', 'gemini-3-flash',
  'gemini-3-pro-preview', 'gemini-3.1-pro-preview', 'gemini-3.8-flash-lite-tts',
  // Gemini 4 Hydrogen and Carbon (override layer) in the spellings Antigravity, Gemini CLI and a local router write:
  // the slug, its effort words, a `models/` / `google/` prefix or a router's (`ag/`, as Pi's usage records name it),
  // `(high)`, a window tag, case; and the ids that stay null: siblings the page does not list, and Antigravity's
  // display-name fallback ("Gemini 4 Hydrogen (High)"), which is no API id.
  'gemini-4-hydrogen', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh',
  'ag/gemini-4-hydrogen-high', 'models/gemini-4-hydrogen', 'google/gemini-4-hydrogen', 'gemini-4-hydrogen(high)', 'gemini-4-hydrogen[1m]', 'GEMINI-4-HYDROGEN',
  'gemini-4-hydrogen-preview-tts', 'gemini-4-hydrogen-lite', 'Gemini 4 Hydrogen (High)',
  'gemini-4-carbon', 'gemini-4-carbon-low', 'gemini-4-carbon-medium', 'gemini-4-carbon-high', 'gemini-4-carbon-xhigh',
  'ag/gemini-4-carbon-high', 'models/gemini-4-carbon', 'google/gemini-4-carbon', 'gemini-4-carbon(high)', 'gemini-4-carbon[1m]',
  'gemini-4-carbon-preview', 'Gemini 4 Carbon',
  // Gemini 4 Neon (override layer), laid out as Carbon; prod's `gemini-4-neon-xhigh` among them.
  'gemini-4-neon', 'gemini-4-neon-low', 'gemini-4-neon-medium', 'gemini-4-neon-high', 'gemini-4-neon-xhigh',
  'ag/gemini-4-neon-xhigh', 'models/gemini-4-neon', 'google/gemini-4-neon', 'gemini-4-neon(high)', 'gemini-4-neon[1m]',
  'gemini-4-neon-preview', 'gemini-4-neon-lite', 'Gemini 4 Neon',
  'gemini-4-argon-high', 'google/gemini-4-argon',
  // Qwen (Alibaba Cloud Model Studio, override layer): Qwen Code's API default and the Plus tiers,
  // dated snapshots; its OAuth alias, retired coder ids and ids no published cache price covers stay null.
  'qwen3.7-max', 'qwen3.7-max-2026-06-08', 'qwen3-7-max', 'qwen3.7-max-preview', 'qwen3.8-max',
  'qwen3.7-plus', 'qwen3.7-plus-2026-05-26', 'qwen3.6-plus', 'qwen3.6-plus-2026-04-02', 'qwen3.5-plus',
  'qwen3-coder-plus', 'qwen3-coder-flash', 'coder-model',
  // DeepSeek and the names it is served under.
  'deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash',
  'divineintellect9/DeepSeek-V4.1-Flash-Uncensored', 'superbot', 'superbot-fast', 'superbot-high',
  'router/superbot', 'superbot-helper', 'di9', 'deepseek-v4-pro', 'deepseek-chat',
  // Meta, and the ids the Muse app's usage rows and its own model names carry (pricing/overrides.json aliases).
  'muse-wonder-1.0', 'muse-wonder-full', 'muse-wonder-1.0-contributor', 'muse-spark-1.0-contributor',
  'muse-spark-1.0', 'ipnext/avocado-5.17-v2', 'ipnext/watermelon-v0', 'Muse Spark', 'Muse Spark 1.3', 'muse spark 2',
  // Models the other harnesses' sessions name (override layer, #137) and the siblings they must
  // leave null. Claude Sonnet 4 in the spellings Copilot, opencode, Zed, Bedrock and Kiro write;
  // Warp's family-last Claude ids; Junie's GPT-4.1 snapshots; Devin's SWE-2 and SWE-2 Flash (a
  // Fusion composite id stays on its lead model's row); CodeBuddy's GLM-5.3 and Kimi K3; Z.ai's GLM-5.3-Flash /
  // -FlashX and MiniMax's M3.1-Flash / M3 (GLM-5.3-FlashX-Legal stays null; MiniMax's retired M2.7 prices since 2026-11-18, below); OpenCode's
  // Big Pickle (listed Free) and Microsoft's MAI-Code-1.1-Flash (MAI-Code-1-Flash, which no page prices, stays null).
  'claude-sonnet-4-20250514', 'claude-sonnet-4-0', 'CLAUDE_SONNET_4_20250514_V1_0', 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  'claude-sonnet-4-latest', 'copilot/claude-sonnet-4', 'claude-sonnet-4-1', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4',
  'CLAUDE_3_7_SONNET_20250219_V1_0', 'claude-4-5-sonnet', 'claude-4.6-sonnet-thinking', 'claude-4-sonnet', 'claude-4-7-opus',
  'claude-4-6-opus-high', 'claude-4-1-opus', 'claude-4-5-haiku', 'claude-4-5-haiku-20251001',
  'gpt-4.1', 'gpt-4.1-2025-04-14', 'gpt-4-1', 'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-4.1-nano', 'gpt-4-1106-preview',
  'swe-2-medium', 'swe-2-high', 'swe-2-max', 'swe-2', 'devin/swe-2-high', 'swe-2-flash-medium', 'swe-2-flash-max',
  'fusion-claude-fable-5-1-medium-sidekick-swe-2-medium', 'swe-1.6', 'compactor',
  'glm-5.3', 'z-ai/glm-5.3', 'glm-5.3-high', 'glm-5.3-flash', 'glm-5.2', 'kimi-k3', 'moonshotai/kimi-k3', 'kimi-k3.1-pro',
  'kimi-for-coding', 'kimi-code/kimi-for-coding', 'hy3', 'default-model', 'auto', 'efficient', 'meta/muse-glimmer-30b',
  'GLM-5.3-Flash', 'z-ai/glm-5.3-flash', 'glm-5.3-flash-high', 'glm-5.3-flashx', 'GLM-5.3-FlashX', 'z-ai/glm-5.3-flashx', 'GLM-5.3-FlashX-Legal',
  'MiniMax-M3.1-Flash', 'minimax-m3.1-flash', 'minimax/minimax-m3.1-flash', 'minimax-m3.1-flash-high', 'MiniMax-M3', 'minimax/minimax-m3',
  'minimax-m3-high', 'minimax-m3.1', 'MiniMax-M2.7',
  'big-pickle', 'opencode/big-pickle', 'Big-Pickle', 'big-pickle-high', 'big-pickle-2',
  'mai-code-1.1-flash', 'MAI-Code-1.1-Flash', 'copilot/mai-code-1.1-flash', 'mai-code-1-1-flash', 'mai-code-1-flash', 'mai-code-1.10-flash',
  // OpenRouter's `:free` variants (override layer, the last row: $0), in the spellings Hermes, Kilo Code and opencode
  // write; the paid id, the bare slug, the free router, other variants and a misplaced `:free` stay null (OpenCode's
  // `-free` name bills on OpenCode Console's row); a `:free` spelling of a model a row above prices (or the Claude
  // family fallback does) keeps that price.
  'baidu/ernie-5.5-flash-preview:free', 'nvidia/nemotron-3.5-super-vl:free', 'google/gemma-4-31b-it:free',
  'thinkingmachines/inkling-2-small:free', 'cohere/north-mini-code:free', 'recursive/flint-v1.0:free',
  'openrouter/baidu/ernie-5.5-flash-preview:free', 'openrouter:google/gemma-4-31b-it:free', 'NVIDIA/Nemotron-3.5-Super-VL:free',
  'nvidia/nemotron-3.5-super-vl:free[1m]', 'nvidia/nemotron-3.5-super-vl:free(high)',
  'baidu/ernie-5.5-flash-preview', 'ernie-5.5-flash-preview:free', 'nemotron-3.5-super-vl-free', 'hy4-free', 'openrouter/free',
  'google/gemma-4-31b-it:batch', 'nvidia/nemotron-3.5-super-vl:free:thinking', 'nvidia/nemotron-3.5-super-vl:freebie', 'nvidia/:free',
  'deepseek/deepseek-v4-flash:free', 'anthropic/claude-opus-latest:free', 'anthropic/claude-opus-5-5:free', 'meta/muse-spark-1.0:free',
  'ipnext/watermelon-v0:free',
  // The hosted models entrants' prod sessions named unpriced (2026-11-02 … 11-16, item #14), each prod spelling, and the
  // siblings they must leave null. OpenCode Console's `-free` ids ($0); OpenAI's GPT-4o and GPT-4o mini; xAI's grok-4
  // (its retired id bills at grok-4.3's rates); Inception's Mercury 3; the Kimi API's kimi-k3.1-pro (its open-weights
  // `moonshotai/` spellings name no one host and stay null); Agnes AI's Agnes 3.0 / 2.5 Flash. Null with them: ids
  // whose host is ambiguous (open weights: nvidia/…, openai/gpt-oss-120b, google/diffusiongemma, mistralai/…, Beam 1.0,
  // MiniMax M2.7; the Nemotron, gpt-oss, Mistral Large 4 and M2.7 ids price since 2026-11-18, below), a bare `:free` no platform's id form matches, retired ids no page prices (claude-3-5-sonnet,
  // deepseek-chat), DeepSeek spellings its API does not take, and ids no page prices (k2d8-preview, hy4-free).
  'glm-5.3-flash-free', 'opencode/glm-5.3-flash-free', 'GLM-5.3-Flash-Free', 'glm-5.3-flash-free-high', 'iceman-free',
  'inkling-2-small-free', 'minimax-m3.1-flash-free', 'beam-free', 'flint-40b-free', 'longcat-2.5-free', 'hy4-flash-free',
  'mimo-v2.6-flash-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'opencode/nemotron-3.5-super-vl-free',
  'deepseek-v4.1-flash-free', 'jev-1.13-free', 'beam-free-2', 'free', 'glm-5.3-flash:free', 'gemini-3-flash:free',
  'gpt-4o', 'gpt-4o-2024-08-06', 'openai/gpt-4o', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18', 'gpt-4o-2024-05-13',
  'chatgpt-4o-latest', 'gpt-4o-mini-tts', 'gpt-4o-audio-preview', 'gpt-4o-search-preview',
  'grok-4', 'grok-4-0709', 'xai/grok-4', 'x-ai/grok-4', 'grok-4-fast-reasoning', 'grok-4-1-fast-reasoning',
  'mercury-3', 'inception/mercury-3', 'mercury-3-high', 'mercury-2.5', 'mercury-2', 'mercury-30',
  'kimi-k3.1-pro-high', 'moonshotai/Kimi-K3.1-Pro', 'moonshotai/kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed',
  'agnes-3.0-flash', 'agnes-2.5-flash', 'agnes-ai/agnes-3.0-flash', 'agnes-2.5-pro', 'agnes-2.5-pro-beta', 'agnes-3.0-pro',
  'beam-1.0', 'k2d8-preview', 'nvidia/nemotron-3.5-super-vl-120b-a12b', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'nvidia/nemotron-3-ultra-550b-a55b', 'nemotron-3-ultra-550b-a55b', 'openai/gpt-oss-120b', 'claude-3-5-sonnet-20241022',
  'minimax-m2.7', 'deepseek-v4.1', 'deepseek-4.1-flash', 'google/diffusiongemma-26b-a4b-it', 'mistralai/mistral-large-4-1t-a52b',
  // GPT-6.2 Sol and GPT-6.2 Astra (override layer; Codex writes the bare ids, prod 2026-11-17/18), their Fast rows and
  // GPT-6.2 Astra for Law, in the spellings Codex, Cursor and a router write; null with them: their Ultrafast ids (no
  // row), the Law configuration's `-fast` (the Fast table lists none), gpt-6.2 ids OpenAI does not list (terra, luna,
  // mini, pro, the bare family), dated or lookalike spellings, and bare `gpt-6`, which OpenAI publishes no price for.
  // The pricing page lists GPT-5.5 Cyber as gpt-5.5-cyber-preview now: that id bills on the gpt-5.5-cyber row.
  'gpt-6.2-sol', 'gpt-6-2-sol', 'GPT-6.2-Sol', 'gpt-6.2-sol(high)', 'gpt-6.2-sol-xhigh', 'gpt-6.2-sol[1m]',
  'router/gpt-6.2-sol', 'openai/gpt-6.2-sol', 'openai:gpt-6.2-sol',
  'gpt-6.2-astra', 'gpt-6-2-astra', 'gpt-6.2-astra(high)', 'gpt-6.2-astra-high', 'router/gpt-6.2-astra', 'openai/gpt-6.2-astra',
  'gpt-6.2-sol-fast', 'gpt-6-2-sol-fast', 'GPT-6.2-SOL-FAST', 'gpt-6.2-sol-fast(high)', 'gpt-6.2-sol-xhigh-fast', 'gpt-6.2-sol-fast-xhigh',
  'router/gpt-6.2-sol-fast', 'gpt-6.2-sol-fast[1m]',
  'gpt-6.2-astra-fast', 'gpt-6-2-astra-fast', 'gpt-6.2-astra-fast(high)', 'gpt-6.2-astra-xhigh-fast', 'router/gpt-6.2-astra-fast',
  'gpt-6.2-astra-law', 'gpt-6.2-astra-law-high', 'openai/gpt-6.2-astra-law',
  'gpt-6.2-astra-law-fast', 'gpt-6.2-sol-ultrafast', 'gpt-6.2-astra-ultrafast', 'gpt-6.2-sol-ultrafast(high)',
  'gpt-6.2-terra', 'gpt-6.2-luna', 'gpt-6.2-terra-fast', 'gpt-6.2-luna-fast', 'gpt-6.2', 'gpt-6.2-fast', 'gpt-6.2-high',
  'gpt-6.2-sol-mini', 'gpt-6.2-sol-mini-fast', 'gpt-6.2-sol-pro', 'gpt-6.2-astra-pro', 'gpt-6.2-sol-2026-11-01', 'gpt-6.20-sol',
  'gpt-6.2-solar', 'gpt-6.2-astral', 'gpt-6.2-astra-cyber',
  'gpt-6', 'openai/gpt-6', 'gpt-6-high', 'gpt-6(high)', 'gpt-6-fast', 'GPT-6',
  'gpt-5.5-cyber-preview', 'gpt-5-5-cyber-preview', 'gpt-5.5-cyber-preview-fast',
  // The gpt-6 / gpt-6.1 rows, anchored (override layer, 2026-11-18): GPT-6 Astra for Law and the Ultrafast ids the
  // pricing page lists flat (gpt-6-astra, gpt-6.1-sol) on their own rows; a dated snapshot keeps its row; the others'
  // Ultrafast ids, a `:batch` id and ids OpenAI does not list now price null, never at Standard.
  'gpt-6-astra-law', 'gpt-6-astra-law-high', 'openai/gpt-6-astra-law', 'gpt-6-astra-law-fast',
  'gpt-6-astra-ultrafast', 'gpt-6-astra-high-ultrafast', 'router/gpt-6-astra-ultrafast', 'gpt-6.1-sol-ultrafast', 'gpt-6-1-sol-ultrafast',
  'gpt-6.1-sol-ultrafast(high)', 'gpt-6-sol-ultrafast', 'gpt-6-luna-ultrafast', 'gpt-6.1-terra-ultrafast', 'gpt-6-sol-2026-09-22',
  'gpt-6-sol-2026-09-22-fast', 'openai/gpt-6.1-terra:batch', 'gpt-6.1-terra-pro', 'gpt-6-astra-pro', 'gpt-6-astra-cyber', 'gpt-6-luna-mini',
  // The other hosted models entrants' prod sessions named unpriced (2026-11-11 … 11-18, item #4's dossier), each prod spelling,
  // and the siblings that must stay null. A maker's own per-token page: GitHub Copilot's MAI-Code-2-Flash (dated promotion),
  // Z.ai's GLM-5.2, GLM-4.5 and free GLM-4.7-Flash / GLM-4.5-Flash, Kimi K2.7 Code, Model Studio's Qwen3.8-27B, Upstage's Solar Pro
  // 4, Mistral Large 4; else OpenRouter's catalog price for open weights (Nemotron, gpt-oss, Gemma 4, Beam, MiniMax-M2.7,
  // DeepSeek-V3.1, Qwen3-Next, Qwen3-Coder, Tencent's Hy4). Aliases: gemini-flash-lite-latest, Antigravity's Hydrogen tier
  // spelling, glm-5.3-flash:dev, agnes-3.0-flash-angel. Null with them: ids whose cache rates (qwen-3.8-max, Qwen3.8-Flash), tiers
  // (qwen3-coder-flash) or output mode (qwen-plus) the page does not settle, CNY-only Spark X2.x, retired or unlisted ids, internal
  // names, an auth-walled page (Poolside), a router namespace the grammar does not strip (wmy300/), the `:free` / `-free` /
  // `:batch` / `:cloud` variants and local runtime tags.
  'mai-code-2-flash', 'MAI-Code-2-Flash', 'copilot/mai-code-2-flash', 'mai-code-2-flash-high', 'mai-code-2', 'mai-code-2-flashx',
  'cbai/glm-5.2', 'z-ai/glm-5.2', 'glm-5.2-high', 'glm-4.5', 'zai-glm45', 'z-ai/glm-4.5', 'glm-4.5-air', 'glm-4.5-x', 'glm-4.5-airx',
  'glm-4.5-flash', 'glm-4.7-flash', 'GLM-4.7-Flash', 'z-ai/glm-4.7-flash', 'glm-4.7-flashx', 'glm-4.7', 'zai-glm-4.7',
  'kimi-k2.7-code', 'kimi-k2-7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'moonshotai/kimi-k2.7-code',
  'solar-pro4', 'solar-pro4-260806', 'upstage/solar-pro4', 'solar-pro3', 'solar-mini4',
  'mistral-large-4', 'mistral-large-4-0', 'mistral-large-latest', 'mistral-large-3',
  'qwen/qwen3.8-27b', 'qwen3.8-27b', 'qwen3.6-27b', 'qwen-3.8-max', 'Qwen/Qwen3.8-Flash', 'qwen3.8-flash', 'qwen-plus',
  'nvidia/nemotron-3-ultra-550b-a55b:free', 'nemotron-3.5-super-vl-120b', 'nvidia/nemotron-3.5-super-vl', 'nemotron-3.5-super-vl',
  'nvidia/nemotron-3.5-lightning', 'nvidia/nemotron-3-super-120b-a12b',
  'gpt-oss-120b', 'openai/gpt-oss-20b', 'gpt-oss-20b', 'openai/gpt-oss-120b:batch', 'gpt-oss:20b', 'gpt-oss:120b-cloud', 'openai/gpt-oss-safeguard-20b',
  'Gemma-4-31B-IT', 'google/gemma-4-31b-it', 'gemma-4-31b-it', 'google/gemma-4-26b-a4b-it',
  'Beam-501B-A23B', 'reflection/beam-1.0-501b-a23b',
  'minimax/minimax-m2.7', 'minimax-m2.7:cloud', 'opencode/minimax-m2.7', 'minimax/minimax-m2.5', 'mmcn/MiniMax-M3.1-Flash-Preview',
  'deepseek/deepseek-chat-v3.1', 'deepseek/deepseek-chat', 'deepseek/deepseek-chat-v3-0324',
  'qwen3-next-80b-a3b-instruct', 'qwen/qwen3-next-80b-a3b-instruct', 'qwen/qwen3-coder', 'qwen3-coder', 'qwen/qwen3-coder-30b', 'qwen/qwen3-coder-next',
  'hy4', 'hy4-flash', 'tencent/hy4', 'tencent/hy4-flash', 'Hy4', 'hy4-preview',
  'spark-x2.6', 'spark-x2.5', 'gemini-flash-worker-agy', 'gemini-pro-orchestrator-g1-pro', '9rvda/poolside/laguna-xs-2.1', 'wmy300/kimi-k3.1-pro',
  'gemini-flash-lite-latest', 'gemini-flash-lite-latest-2', 'gemini-4-hydrogen-tiered-high', 'gemini-4-hydrogen-tiered',
  'glm-5.3-flash:dev', 'glm-5.3-flash:dev2', 'agnes-3.0-flash-angel', 'agnes-2.5-flash-angel',
  // Nothing: Qoder's recorded ids (no page names their model or prices them per token) and models run on one's own machine.
  '', 'unknown-model', 'llama-4-maverick', 'qmodel_latest', 'dfmodel', 'llama3.2:3b-instruct-q4_K_M',
];

/** Instants around every intro boundary in the table, plus the two real payloads' own. */
const PROBE_INSTANTS: readonly string[] = [
  '2026-10-25T19:49:34.449Z',
  '2025-01-01T00:00:00.000Z',
  '2026-10-26T02:04:15.003Z',
  '2026-11-30T23:59:59.999Z',
  '2026-12-01T00:00:00.000Z',
  '2026-12-31T23:59:59.999Z',
  '2027-01-01T00:00:00.000Z',
  // MAI-Code-2-Flash's promotion: its last day and the first of its list rates.
  '2027-05-16T23:59:59.999Z',
  '2027-05-17T00:00:00.000Z',
];

const t = (p: Partial<TokenCounts>): TokenCounts => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  reasoning: 0,
  audio_input: 0,
  audio_output: 0,
  ...p,
});

/** One request each; the prompt (input + cache read + writes) straddles every long-context line. */
const PROBE_USAGES: readonly TokenCounts[] = [
  t({ input: 1200, output: 800, cache_read: 5000, cache_write_5m: 3000, cache_write_1h: 2000 }),
  t({ input: 2, output: 4175, cache_read: 42659, cache_write_1h: 32230 }),
  t({ input: 19162, output: 453, cache_read: 20736 }),
  t({ input: 150000, output: 2000, cache_read: 140000, cache_write_5m: 10000, cache_write_1h: 5000 }),
  t({ input: 60000, output: 100, cache_read: 40000 }),
  t({ input: 60001, output: 100, cache_read: 40000 }),
  t({ input: 120000, output: 100, cache_read: 80000 }),
  t({ input: 120001, output: 100, cache_read: 80000 }),
  t({ input: 172000, output: 100, cache_read: 100000 }),
  t({ input: 172001, output: 100, cache_read: 100000 }),
  t({ input: 156000, output: 100, cache_read: 100000 }),
  t({ input: 156001, output: 100, cache_read: 100000 }),
  t({ input: 312000, output: 100, cache_read: 200000 }),
  t({ input: 312001, output: 100, cache_read: 200000 }),
  t({ input: 3000, output: 900, cache_read: 500, audio_input: 1200, audio_output: 400 }),
  t({ input: 250, output: 249, cache_read: 1 }),
  t({}),
];

// ------------------------------------------------------------------ source shapes

interface SrcPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
  longContext?: { overTokens: number; strict: boolean; pricing: SrcPricing };
  intro?: { until: string; pricing: SrcPricing };
  change?: { from: string; pricing: SrcPricing };
  audio?: { input: number; output: number };
}

interface SrcCostUsage {
  in: number;
  out: number;
  cacheRead?: number;
  cacheCreation?: number;
  cacheCreation1h?: number;
  audioIn?: number;
  audioOut?: number;
}

interface SrcPricingModule {
  ROWS: Array<{ match: RegExp; pricing: SrcPricing }>;
  rowPricing(id: string): SrcPricing | null;
  baseModelPricing(model: string): SrcPricing | null;
  listPriceCostUsd(model: string, usage: SrcCostUsage, opts: { promptTokens?: number; at?: string }): number | null;
  promptTokensOf(usage: SrcCostUsage): number;
}

/** Module-private bindings the port reads, exported by appending `export { … }` at load time. */
const EXTRA_EXPORTS: Record<string, readonly string[]> = {
  'src/shared/model-pricing.ts': ['ROWS', 'rowPricing'],
  'src/shared/oauth-gateway.ts': ['CLAUDE_FAMILY_ALIAS', 'CLAUDE_WIRE_FAMILY', 'ALIAS_EFFORT', 'PROVIDER_PREFIX'],
};

/**
 * Literals inside source functions that the runtime grammar mirrors (model-match.ts). A rewrite
 * of either line must be read and mirrored by hand, so the port refuses until it is.
 */
const MIRRORED_LITERALS: Record<string, readonly string[]> = {
  'src/shared/oauth-gateway.ts': ["for (const word of ['fast', ...ALIAS_EFFORT])", "for (const sep of [':', '-'])"],
};

// ------------------------------------------------------------------ git-backed module loading

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function loadSourceAt(repo: string, sha: string) {
  const vroot = `file:///cosmos-at-${sha}/`;
  const files = new Set(git(repo, ['ls-tree', '-r', '--name-only', '-z', sha]).split('\0').filter(Boolean));
  const texts = new Map<string, string>();
  const text = (rel: string): string => {
    let s = texts.get(rel);
    if (s === undefined) {
      s = git(repo, ['show', `${sha}:${rel}`]);
      texts.set(rel, s);
    }
    return s;
  };
  const formatOf = (rel: string) => (rel.endsWith('.json') ? ('json' as const) : ('module-typescript' as const));
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(vroot)) return { url: specifier, format: formatOf(specifier), shortCircuit: true };
      const parent = context.parentURL;
      if (!parent?.startsWith(vroot)) return nextResolve(specifier, context);
      let base: string | null = null;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        base = path.posix.normalize(path.posix.join(path.posix.dirname(parent.slice(vroot.length)), specifier));
      } else if (specifier.startsWith('@shared/')) {
        base = `src/shared/${specifier.slice('@shared/'.length)}`;
      }
      if (base === null) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      const hit = [base, `${base}.ts`, `${base}/index.ts`].find((c) => files.has(c) && /\.(ts|json)$/.test(c));
      if (!hit) throw new Error(`port: ${specifier} (from ${parent.slice(vroot.length)}) is not a .ts/.json file at ${sha}`);
      return { url: vroot + hit, format: formatOf(hit), shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(vroot)) return nextLoad(url, context);
      const rel = url.slice(vroot.length);
      const extra = EXTRA_EXPORTS[rel];
      const source = extra ? `${text(rel)}\nexport { ${extra.join(', ')} };\n` : text(rel);
      return { format: formatOf(rel), source, shortCircuit: true };
    },
  });
  return { vroot, text, deregister: () => hooks.deregister() };
}

// ------------------------------------------------------------------ conversion

const PRICING_KEYS = new Set(['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead', 'longContext', 'intro', 'change', 'audio']);

function assertKeys(obj: object, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(`port: ${where} has field \`${key}\`, which the rows do not model; extend the port`);
  }
}

/** USD per MTok → integer micro-USD per MTok, refusing anything finer. */
function micro(usdPerMtok: unknown, where: string): number {
  if (typeof usdPerMtok !== 'number' || !Number.isFinite(usdPerMtok) || usdPerMtok < 0) {
    throw new Error(`port: ${where} is ${String(usdPerMtok)}, not a non-negative rate`);
  }
  const scaled = usdPerMtok * 1e6;
  const r = Math.round(scaled);
  if (Math.abs(scaled - r) > 1e-6 || !Number.isSafeInteger(r)) {
    throw new Error(`port: ${where} = $${usdPerMtok}/MTok is finer than a micro-dollar per MTok`);
  }
  return r;
}

function rates(p: SrcPricing, rowAudio: SrcPricing['audio'], where: string): RatesT {
  assertKeys(p, PRICING_KEYS, where);
  // model-pricing.ts listPriceCostUsd: `pricing.audio ?? row.audio`.
  const audio = p.audio ?? rowAudio;
  if (audio) assertKeys(audio, new Set(['input', 'output']), `${where}.audio`);
  return {
    input: micro(p.input, `${where}.input`),
    output: micro(p.output, `${where}.output`),
    cache_write_5m: micro(p.cacheWrite, `${where}.cacheWrite`),
    cache_write_1h: micro(p.cacheWrite1h, `${where}.cacheWrite1h`),
    cache_read: micro(p.cacheRead, `${where}.cacheRead`),
    audio: audio ? { input: micro(audio.input, `${where}.audio.input`), output: micro(audio.output, `${where}.audio.output`) } : null,
  };
}

/** The rates one in-force price bills at (model-pricing.ts requestPricing, after inForce). */
function tiers(p: SrcPricing, row: SrcPricing, where: string): Pick<PeriodT, 'base' | 'long_context'> {
  const long = p.longContext;
  if (long) {
    assertKeys(long, new Set(['overTokens', 'strict', 'pricing']), `${where}.longContext`);
    if (!Number.isSafeInteger(long.overTokens) || long.overTokens < 0) throw new Error(`port: ${where}.longContext.overTokens is not a token count`);
    if (typeof long.strict !== 'boolean') throw new Error(`port: ${where}.longContext.strict is not a boolean`);
    if (long.pricing.longContext || long.pricing.intro) throw new Error(`port: ${where}.longContext.pricing nests a tier; requestPricing never reads one`);
  }
  return {
    base: rates(p, row.audio, where),
    long_context: long
      ? { over_tokens: long.overTokens, strict: long.strict, rates: rates(long.pricing, row.audio, `${where}.longContext.pricing`) }
      : null,
  };
}

/**
 * A row's dated periods. A `change` (cosmos d74141126e's ModelPricing.change; the override layer's
 * own field at 115b45e, which predates it) cuts the row's own periods at 00:00 UTC of `from` and
 * continues with the periods of `change.pricing`, its own intro included.
 */
function periods(row: SrcPricing, where: string): PeriodT[] {
  const change = row.change;
  if (!change) return introPeriods(row, where);
  assertKeys(change, new Set(['from', 'pricing']), `${where}.change`);
  if (change.pricing.change) throw new Error(`port: ${where}.change.pricing nests a change; extend the port`);
  const start = new Date(`${change.from}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(change.from) || Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== change.from) {
    throw new Error(`port: ${where}.change.from ${change.from} is not a calendar day`);
  }
  const at = start.toISOString();
  const { change: _change, ...own } = row;
  const before = introPeriods(own, where)
    .filter((p) => p.effective_from === null || p.effective_from < at)
    .map((p) => ({ ...p, effective_to: p.effective_to === null || p.effective_to > at ? at : p.effective_to }));
  const after = introPeriods({ ...change.pricing, audio: change.pricing.audio ?? row.audio }, `${where}.change.pricing`)
    .filter((p) => p.effective_to === null || p.effective_to > at)
    .map((p) => ({ ...p, effective_from: p.effective_from === null || p.effective_from < at ? at : p.effective_from }));
  return [...before, ...after];
}

function introPeriods(row: SrcPricing, where: string): PeriodT[] {
  const intro = row.intro;
  if (!intro) return [{ effective_from: null, effective_to: null, ...tiers(row, row, where) }];
  assertKeys(intro, new Set(['until', 'pricing']), `${where}.intro`);
  if (intro.pricing.intro) throw new Error(`port: ${where}.intro.pricing nests an intro; inForce never reads one`);
  // inForce: `utcDay(at) <= intro.until` — through the end of that UTC day, inclusive.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(intro.until)) throw new Error(`port: ${where}.intro.until ${intro.until} is not YYYY-MM-DD`);
  const end = new Date(`${intro.until}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== intro.until) {
    throw new Error(`port: ${where}.intro.until ${intro.until} is not a calendar day`);
  }
  end.setUTCDate(end.getUTCDate() + 1);
  const boundary = end.toISOString();
  return [
    { effective_from: null, effective_to: boundary, ...tiers(intro.pricing, row, `${where}.intro.pricing`) },
    { effective_from: boundary, effective_to: null, ...tiers(row, row, where) },
  ];
}

// ------------------------------------------------------------------ the override layer

type SrcRow = SrcPricingModule['ROWS'][number];

/** The one row whose pattern source is `source`; none or several aborts. */
function rowIndex(rows: readonly SrcRow[], source: string, what: string, sha: string): number {
  const hits = rows.flatMap((r, i) => (r.match.source === source ? [i] : []));
  if (hits.length !== 1) {
    throw new Error(`port: ${what} names /${source}/, which ${hits.length ? `${hits.length} rows` : 'no row'} at cosmos ${sha} carry; re-read the source and update pricing/overrides.json`);
  }
  return hits[0]!;
}

const RATE_KEYS = ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead'] as const;

/**
 * Refuse a Fast row that is not exactly `m` × its Standard row (overrides.ts `fast`): every rate of
 * every tier it carries, to the micro-dollar. One that drops the Standard row's long-context tier
 * must bill at least the Standard long-context rates, so past the line it never prices below the
 * Standard id either.
 */
function checkFastPricing(fast: SrcPricing, std: SrcPricing, m: number, where: string): void {
  for (const k of ['intro', 'change', 'audio'] as const) {
    if (fast[k] || std[k]) throw new Error(`port: ${where}: a Fast row over a row with ${k} pricing is not modelled; extend the port`);
  }
  const scaled = (f: SrcPricing, s: SrcPricing, tier: string) => {
    for (const k of RATE_KEYS) {
      const want = micro(s[k], `${where} Standard${tier}.${k}`) * m;
      if (Math.abs(micro(f[k], `${where}${tier}.${k}`) - want) > 1e-3) {
        throw new Error(`port: ${where}${tier}.${k} is $${f[k]}/MTok, not ${m} x the Standard row's $${s[k]}: re-read the Fast table`);
      }
    }
  };
  scaled(fast, std, '');
  const fl = fast.longContext;
  const sl = std.longContext;
  if (fl) {
    if (!sl) throw new Error(`port: ${where} carries a long-context tier its Standard row does not`);
    if (fl.overTokens !== sl.overTokens || fl.strict !== sl.strict) throw new Error(`port: ${where} reprices past another line than its Standard row`);
    scaled(fl.pricing, sl.pricing, '.longContext.pricing');
  } else if (sl) {
    for (const k of RATE_KEYS) {
      if (micro(fast[k], `${where}.${k}`) < micro(sl.pricing[k], `${where} Standard.longContext.pricing.${k}`)) {
        throw new Error(`port: ${where} has no long-context tier and its ${k} $${fast[k]} is below the Standard row's long-context $${sl.pricing[k]}: past ${sl.overTokens} tokens a -fast id would price below its Standard id`);
      }
    }
  }
}

/**
 * Merge the override rows into the source's own ROWS array: first each `replace` and `insert` in
 * file order — a `replace` swaps the pricing of the row with that pattern (only while it still
 * prices at `was`), an `insert` adds a row ahead of `before` (after every row when it is null) — then each `fast` row, ahead of the
 * Standard row it names, once that row's rates are final; last each alias, widening the pattern of
 * the row it names to `<of>|<match>`, its pricing object kept. In place, so the source's rowPricing /
 * baseModelPricing / listPriceCostUsd price the merged table; the caller restores the array.
 * Returns each widened pattern's own.
 */
function applyOverrides(rows: SrcRow[], list: readonly OverrideRowT[], aliases: readonly OverrideAliasT[], sha: string): Map<string, string> {
  for (const o of list) {
    const where = `pricing/overrides.json ${o.model}`;
    if (o.op === 'replace') {
      const i = rowIndex(rows, o.match, `${where} (replace)`, sha);
      const row = rows[i]!;
      if (row.match.flags !== '') throw new Error(`port: ${where} replaces /${o.match}/${row.match.flags}; overrides carry no flags`);
      const now = JSON.stringify(periods(row.pricing, `ROWS[${i}] ${row.match}`));
      if (now !== JSON.stringify(periods(o.was, `${where}.was`))) {
        throw new Error(`port: cosmos ${sha} no longer prices /${o.match}/ at the rates ${where} replaces: re-read its cited pages, then update or drop the override`);
      }
      rows[i] = { match: row.match, pricing: o.pricing };
    } else if (o.op === 'insert') {
      if (rows.some((r) => r.match.source === o.match)) throw new Error(`port: ${where} inserts /${o.match}/, which cosmos ${sha} already lists; make it a replace`);
      const at = o.before === null ? rows.length : rowIndex(rows, o.before, `${where} (insert before)`, sha);
      rows.splice(at, 0, { match: new RegExp(o.match), pricing: o.pricing });
    }
  }
  for (const o of list) {
    if (o.op !== 'fast') continue;
    const where = `pricing/overrides.json ${o.model}`;
    if (rows.some((r) => r.match.source === o.match)) throw new Error(`port: ${where} adds /${o.match}/, which the merged table already lists`);
    const i = rowIndex(rows, o.of, `${where} (fast of)`, sha);
    if (rows[i]!.match.flags !== '') throw new Error(`port: ${where} is the Fast row of /${o.of}/${rows[i]!.match.flags}; overrides carry no flags`);
    checkFastPricing(o.pricing, rows[i]!.pricing, o.multiplier, where);
    rows.splice(i, 0, { match: new RegExp(o.match), pricing: o.pricing });
  }
  const own = new Map<string, string>();
  // An anchored replace narrows its source row's pattern last of the rows, so `before` and `of` above named the source's.
  for (const o of list) {
    if (o.op !== 'replace' || o.anchor === undefined) continue;
    const where = `pricing/overrides.json ${o.model} (anchor)`;
    if (rows.some((r) => r.match.source === o.anchor)) throw new Error(`port: ${where} anchors /${o.match}/ as /${o.anchor}/, which the merged table already lists`);
    const i = rowIndex(rows, o.match, where, sha);
    rows[i] = { match: new RegExp(o.anchor), pricing: rows[i]!.pricing };
    own.set(o.anchor, o.match);
  }
  for (const a of aliases) {
    const where = `pricing/overrides.json alias of /${a.of}/`;
    const i = rowIndex(rows, a.of, where, sha);
    const row = rows[i]!;
    if (row.match.flags !== '') throw new Error(`port: ${where} widens /${a.of}/${row.match.flags}; aliases carry no flags`);
    rows[i] = { match: new RegExp(`${row.match.source}|${a.match}`), pricing: row.pricing };
    own.set(rows[i]!.match.source, a.of);
  }
  return own;
}

/**
 * Every probed id carrying the fast word, read against its Standard spelling (overrides.ts
 * standardSpelling). One that bills on a Fast row must be a spelling of THAT row's Standard model;
 * one whose Standard spelling bills on an OpenAI row of the override layer must bill on that row's
 * Fast row or nowhere — never at the Standard rate (an unanchored source row would otherwise take
 * `gpt-5.6-sol-high-fast`), and never at another model's. Ids outside the layer keep their own
 * reading: `superbot-fast` is a model name, `sonnet-fast` the router's Claude grammar.
 */
function checkFastSpellings(models: readonly string[], billedOn: (m: string) => string | null, list: readonly OverrideRowT[]): string[] {
  const standardOf = new Map<string, string>();
  const fastOf = new Map<string, string>();
  const layered = new Set<string>();
  for (const o of list) {
    if (o.op === 'fast') {
      standardOf.set(o.match, o.of);
      fastOf.set(o.of, o.match);
    } else layered.add(o.match);
  }
  return models.flatMap((m) => {
    const std = standardSpelling(m.trim());
    if (std === null) return [];
    const row = billedOn(m);
    const stdRow = billedOn(std);
    const problems: string[] = [];
    if (row !== null && standardOf.has(row) && standardOf.get(row) !== stdRow) {
      problems.push(`${JSON.stringify(m)} bills on the Fast row of /${standardOf.get(row)}/, but its Standard spelling ${JSON.stringify(std)} bills on ${stdRow === null ? 'nothing' : `/${stdRow}/`}`);
    }
    if (stdRow !== null && layered.has(stdRow) && row !== null && row !== fastOf.get(stdRow)) {
      const want = fastOf.get(stdRow);
      problems.push(`${JSON.stringify(m)} is a Fast spelling of ${JSON.stringify(std)} (/${stdRow}/) but bills on /${row}/, not ${want === undefined ? 'null (it has no Fast row: add the Fast table\'s, or it must price null)' : `its Fast row /${want}/`}`);
    }
    return problems;
  });
}

function originOf(repo: string): string {
  try {
    return git(repo, ['remote', 'get-url', 'origin']).trim().replace(/\/\/[^@/]*@/, '//');
  } catch {
    return path.basename(repo);
  }
}

// ------------------------------------------------------------------ port

export interface PortResult {
  doc: PricingRowsDocT;
  rowsText: string;
  parityText: string;
  pricingRev: string;
  cases: number;
}

export async function port(repo: string, rev: string, overridesPath = OVERRIDES_PATH): Promise<PortResult> {
  const sha = git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]).trim();
  const committedAt = git(repo, ['show', '-s', '--format=%cI', sha]).trim();
  const overrides = loadOverrides(overridesPath);
  const src = loadSourceAt(repo, sha);
  let restore = () => {};
  try {
    for (const [rel, needles] of Object.entries(MIRRORED_LITERALS)) {
      for (const needle of needles) {
        if (!src.text(rel).includes(needle)) {
          throw new Error(`port: ${rel} at ${sha} no longer contains \`${needle}\`; re-read it and update pricing/model-match.ts and this port`);
        }
      }
    }
    const pricing = (await import(`${src.vroot}${SOURCE_PATH}`)) as SrcPricingModule;
    const flagship = (await import(`${src.vroot}src/shared/claude-flagship.ts`)) as { CLAUDE_FAMILY_FLAGSHIP: Record<string, string> };
    const oauth = (await import(`${src.vroot}src/shared/oauth-gateway.ts`)) as {
      CLAUDE_FAMILY_ALIAS: readonly string[];
      CLAUDE_WIRE_FAMILY: readonly string[];
      ALIAS_EFFORT: readonly string[];
      PROVIDER_PREFIX: RegExp;
    };
    const gateway = (await import(`${src.vroot}src/shared/model-gateway.ts`)) as { GATEWAY_IDS: readonly string[] };

    // The row each probe bills on in the source alone, then the merged table.
    const pristine = [...pricing.ROWS];
    restore = () => void pricing.ROWS.splice(0, pricing.ROWS.length, ...pristine);
    // A row an alias widened is read by its own pattern.
    let ownPattern = new Map<string, string>();
    const billedOn = (model: string): string | null => {
      const hit = pricing.baseModelPricing(model);
      if (!hit) return null;
      const source = pricing.ROWS.find((r) => r.pricing === hit)!.match.source;
      return ownPattern.get(source) ?? source;
    };
    const sourceRow = new Map(PROBE_MODELS.map((m) => [m, billedOn(m)]));
    ownPattern = applyOverrides(pricing.ROWS, overrides.doc.rows, overrides.doc.aliases, sha);
    // An alias prices only ids the source leaves null, each a probe, each on its own row.
    const misaliased = overrides.doc.aliases.flatMap((a) =>
      a.ids.flatMap((id) => {
        if (!sourceRow.has(id)) return [`${JSON.stringify(id)} is no probe: add it to PROBE_MODELS`];
        if (sourceRow.get(id) !== null) return [`${JSON.stringify(id)} already bills on /${sourceRow.get(id)}/ in the source: drop it from the alias`];
        const now = billedOn(id);
        return now === a.of ? [] : [`${JSON.stringify(id)} bills on ${now === null ? 'nothing' : `/${now}/`}, not /${a.of}/`];
      }),
    );
    if (misaliased.length) throw new Error(`port: pricing/overrides.json aliases:\n  ${misaliased.join('\n  ')}`);
    const fastStandard = new Map(overrides.doc.rows.flatMap((o) => (o.op === 'fast' ? [[o.match, o.of] as const] : [])));
    // An anchored replace releases the ids its source pattern took and its anchor does not (as matched:
    // trimmed, a `(level)` suffix dropped, lowercased): each prices null or on a row of the layer.
    const anchors = new Map(overrides.doc.rows.flatMap((o) => (o.op === 'replace' && o.anchor !== undefined ? [[o.match, new RegExp(o.anchor)] as const] : [])));
    const layerRows = new Set(overrides.doc.rows.flatMap((o) => (o.op === 'replace' ? [] : [o.match])));
    const released = (m: string, was: string, now: string | null) => {
      const anchor = anchors.get(was);
      return anchor !== undefined && !anchor.test(m.trim().replace(/\([^)]*\)$/, '').toLowerCase()) && (now === null || layerRows.has(now));
    };
    const moved = PROBE_MODELS.flatMap((m) => {
      const was = sourceRow.get(m)!;
      const now = billedOn(m);
      // A Fast row takes its own Standard row's -fast spellings (checkFastSpellings says which).
      if (was === null || now === was || (now !== null && fastStandard.get(now) === was) || released(m, was, now)) return [];
      return [`${JSON.stringify(m)}: /${was}/ -> ${now === null ? 'null' : `/${now}/`}`];
    });
    if (moved.length) throw new Error(`port: pricing/overrides.json takes ids from the rows that price them (an insert may only price what the source leaves null, a Fast row only its Standard row's -fast ids):\n  ${moved.join('\n  ')}`);
    // ...and each override's own id bills on its row, not on one above it (an effort word can be a
    // model suffix: `-max` in gpt-5.1-codex-max); a Fast row's Standard id bills on its Standard row.
    const shadowed = overrides.doc.rows.flatMap((o) => {
      const out = billedOn(o.model) === o.match ? [] : [`${o.model} bills on /${billedOn(o.model)}/, not /${o.match}/`];
      if (o.op === 'fast') {
        const std = standardSpelling(o.model)!;
        if (billedOn(std) !== o.of) out.push(`${std} bills on /${billedOn(std)}/, not its Standard row /${o.of}/`);
      }
      return out;
    });
    if (shadowed.length) throw new Error(`port: pricing/overrides.json rows shadowed by a row above them; reorder:\n  ${shadowed.join('\n  ')}`);
    const fastProblems = checkFastSpellings(PROBE_MODELS, billedOn, overrides.doc.rows);
    if (fastProblems.length) throw new Error(`port: -fast ids priced off their model's Fast row (pricing/overrides.json):\n  ${fastProblems.join('\n  ')}`);

    const rows = pricing.ROWS.map((r, i) => {
      assertKeys(r, new Set(['match', 'pricing']), `ROWS[${i}]`);
      if (!(r.match instanceof RegExp)) throw new Error(`port: ROWS[${i}].match is not a RegExp`);
      if (/[gy]/.test(r.match.flags)) throw new Error(`port: ROWS[${i}].match has stateful flags ${r.match.flags}`);
      return { match: { source: r.match.source, flags: r.match.flags }, periods: periods(r.pricing, `ROWS[${i}] ${r.match}`) };
    });

    const flagships: PricingRowsDocT['aliases']['flagships'] = [];
    for (const [family, model] of Object.entries(flagship.CLAUDE_FAMILY_FLAGSHIP)) {
      const hit = pricing.rowPricing(model);
      // A flagship no row lists prices null in the source; leaving it out does the same here.
      if (!hit) continue;
      const row = pricing.ROWS.findIndex((r) => r.pricing === hit);
      if (row < 0) throw new Error(`port: rowPricing(${model}) returned a pricing object no ROWS entry holds`);
      flagships.push({ family, model, row });
    }

    const doc: PricingRowsDocT = {
      schema: PRICING_ROWS_SCHEMA,
      rate_unit: RATE_UNIT,
      source: {
        repo: originOf(repo),
        path: SOURCE_PATH,
        sha,
        committed_at: committedAt,
        ported_by: 'pricing/port-from-cosmos.ts',
        overrides: { path: OVERRIDES_REL_PATH, sha256: overrides.sha256, rows: overrides.doc.rows.length },
      },
      rows,
      aliases: {
        flagships,
        alias_families: [...oauth.CLAUDE_FAMILY_ALIAS],
        wire_families: [...oauth.CLAUDE_WIRE_FAMILY],
        decoration_words: ['fast', ...oauth.ALIAS_EFFORT],
        decoration_separators: [':', '-'],
        provider_prefix: { source: oauth.PROVIDER_PREFIX.source, flags: oauth.PROVIDER_PREFIX.flags },
        gateway_ids: [...gateway.GATEWAY_IDS],
      },
    };
    const pricer = createPricer(doc);

    // Parity: the source's own answers vs. the engine over the new rows.
    const cases: Array<[number, number, number, number | null, number | null]> = [];
    const plan: Array<[number, number, number]> = [];
    PROBE_MODELS.forEach((_, m) => {
      PROBE_USAGES.forEach((_, u) => plan.push([m, 0, u]));
      PROBE_INSTANTS.forEach((_, i) => i > 0 && plan.push([m, i, 0]));
    });
    const hitRows = new Set<number>();
    const mismatches: string[] = [];
    for (const [m, i, u] of plan) {
      const model = PROBE_MODELS[m]!;
      const at = PROBE_INSTANTS[i]!;
      const tk = PROBE_USAGES[u]!;
      const usage: SrcCostUsage = {
        in: tk.input,
        out: tk.output,
        cacheRead: tk.cache_read,
        cacheCreation: tk.cache_write_5m + tk.cache_write_1h,
        cacheCreation1h: tk.cache_write_1h,
        audioIn: tk.audio_input,
        audioOut: tk.audio_output,
      };
      // A row's dated `change` (overrides.ts), as cosmos d74141126e's inForce reads it: from its
      // UTC day on the row bills as its `change.pricing`, whose own intro then applies. 115b45e's
      // inForce predates the field, so each changed row is swapped for its in-force pricing while
      // the source's own cost function prices this instant, and swapped back after.
      const day = at.slice(0, 10);
      const swapped = pricing.ROWS.flatMap((r, k) => (r.pricing.change && day >= r.pricing.change.from ? [[k, r] as const] : []));
      for (const [k, r] of swapped) pricing.ROWS[k] = { match: r.match, pricing: r.pricing.change!.pricing };
      const base = pricing.baseModelPricing(model);
      const srcRow = base ? pricing.ROWS.findIndex((r) => r.pricing === base) : null;
      if (srcRow === -1) throw new Error(`port: baseModelPricing(${JSON.stringify(model)}) returned a pricing object no ROWS entry holds`);
      const usd = pricing.listPriceCostUsd(model, usage, { promptTokens: pricing.promptTokensOf(usage), at });
      for (const [k, r] of swapped) pricing.ROWS[k] = r;
      if (srcRow !== null) hitRows.add(srcRow);
      cases.push([m, i, u, srcRow, usd]);
      const ours = pricer.priceUsage({ model, at, format: 'tokens', usage: tk });
      const ourRow = pricer.resolveRow(model);
      const costOk =
        usd === null ? ours.microUsd === null : ours.microUsd !== null && Math.abs(Number(ours.microUsd) - usd * 1e6) <= PARITY_TOLERANCE_MICRO_USD;
      if (ourRow !== srcRow || !costOk) {
        mismatches.push(`${JSON.stringify(model)} @ ${at} usage#${u}: source row ${srcRow} $${usd}, ported row ${ourRow} ${ours.microUsd}µ$`);
      }
    }
    if (mismatches.length) throw new Error(`port: ${mismatches.length} parity mismatches:\n  ${mismatches.slice(0, 30).join('\n  ')}`);
    const unhit = rows.map((r, i) => (hitRows.has(i) ? null : `ROWS[${i}] /${r.match.source}/`)).filter((x) => x !== null);
    if (unhit.length) throw new Error(`port: no probe model bills on ${unhit.join(', ')}; add one to PROBE_MODELS`);

    const rowsText = `${JSON.stringify(doc, null, 2)}\n`;
    const parityHead = {
      schema: PARITY_SCHEMA,
      source: doc.source,
      pricing_rev: pricer.pricingRev,
      tolerance_micro_usd: PARITY_TOLERANCE_MICRO_USD,
      case_fields: ['model', 'instant', 'usage', 'row', 'usd'],
      models: PROBE_MODELS,
      instants: PROBE_INSTANTS,
      usages: PROBE_USAGES,
    };
    const headText = JSON.stringify(parityHead, null, 2);
    const parityText = `${headText.slice(0, -2)},\n  "cases": [\n${cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]\n}\n`;
    JSON.parse(parityText);
    return { doc, rowsText, parityText, pricingRev: pricer.pricingRev, cases: cases.length };
  } finally {
    restore();
    src.deregister();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: process.env.COSMOS_REPO ?? '/Users/toor/Documents/GitHub/cosmos' },
      rev: { type: 'string', default: 'HEAD' },
      check: { type: 'boolean', default: false },
    },
  });
  const result = await port(values.repo, values.rev);
  const layered = result.doc.source.overrides;
  const summary = `cosmos ${result.doc.source.sha} + ${layered?.path} (${layered?.rows} rows, sha256 ${layered?.sha256.slice(0, 12)}…): ${result.doc.rows.length} rows, ${result.doc.aliases.flagships.length} flagships, ${result.cases} parity cases, pricing_rev ${result.pricingRev}`;
  if (values.check) {
    const stale = [
      [ROWS_PATH, result.rowsText],
      [PARITY_PATH, result.parityText],
    ].filter(([file, text]) => {
      try {
        return readFileSync(file!, 'utf8') !== text;
      } catch {
        return true;
      }
    });
    if (stale.length) {
      console.error(`stale: ${stale.map(([f]) => path.relative(process.cwd(), f!)).join(', ')} (${summary})`);
      process.exitCode = 1;
      return;
    }
    console.log(`up to date: ${summary}`);
    return;
  }
  const replaced = readFileSync(ROWS_PATH);
  let replacedRev: string | null = null;
  try {
    replacedRev = createPricer(JSON.parse(replaced.toString('utf8'))).pricingRev;
  } catch {
    // A rows.json that does not load was never served, so no entry was received under it: nothing of it to keep.
  }
  writeFileSync(ROWS_PATH, result.rowsText);
  writeFileSync(PARITY_PATH, result.parityText);
  console.log(`wrote pricing/rows.json and pricing/parity.json: ${summary}`);
  if (replacedRev === null || replacedRev === result.pricingRev) return;
  const kept = path.join(REVS_DIR, `${replacedRev}.json`);
  if (!existsSync(kept)) {
    mkdirSync(REVS_DIR, { recursive: true });
    writeFileSync(kept, replaced);
    console.log(`kept the replaced table (pricing_rev ${replacedRev}) as pricing/revs/${replacedRev}.json`);
  }
  // Loaded only now, over the rows just written: a rows.json that does not load never stops the port that rewrites it.
  const { HELD_PRICING_REVS } = await import('./revs.ts');
  if (!HELD_PRICING_REVS.some((t) => t.rev === replacedRev)) {
    console.error(`pricing/revs.ts does not list pricing/revs/${replacedRev}.json: add it to HELD with replacedBy ${result.pricingRev}, or every entry received under ${replacedRev} and not yet ingested is refused at ingest`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
