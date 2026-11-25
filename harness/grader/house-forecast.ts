// The house's model entry in a forecast contest: ONE house-paid model call through masq (superbot-router, dialled
// directly, for a model it serves while the pair is set: `router` below) per instance, recorded, then
// replayed by a fixed entry (grader/house-forecast-entry/main.ts) that never calls a model. Modelled on the house
// judge's call (grader/judge-call.ts) and its key (grader/gateway/masq.ts):
//
//   prompt      a system prompt (HOUSE_FORECAST_SYSTEM) and one user message (houseForecastPrompt): the bundle's
//               rules text, the instance's task.json as it is, the output contract, the compact history
//               (compactChartHistory for a Roblox chart contest, its chart's rows; compactPumpHistory for a pump.fun
//               top-5 one, each mark's top rows), then HOUSE_FORECAST_ANSWER_LINE ("answer with the
//               JSON only"). The caller hands each in; nothing here reads a bundle. The prompt is stored as a blob
//               (houseForecastPromptBytes, canonical JSON {system, user}) and the record names its sha256.
//   preflight   houseForecastPreflight: the worst case of HOUSE_FORECAST_ATTEMPTS requests at the largest body any
//               form can send (grader/gateway/policy.ts worstCaseMicroUsd: body bytes / 3 input tokens at the
//               dearest input class, plus max_output_tokens), kept in the record's budget; no dollar figure refuses
//               it: house-paid judging has no spend cap (the owner, 2026-11-11), so max_output_tokens and
//               HOUSE_FORECAST_ATTEMPTS bound the call. A model with no pricing row is held (nothing could price its
//               record or retire its key against a meter): nothing is minted, sent or stored.
//   key         broker.mintJudgeKey (masq.ts judgeKeyRequest): label makefun/<slug>/judge/<phase>/<attempt>, the
//               pinned model alone, no dollar cap, for under 24 h. A dedicated house-forecast label segment needs
//               a masq.ts change; until then the judge segment carries it (a forecast contest has no judge heat to
//               share it with). The key is retired (retireTrialKey) against the call's priced meter as soon as the call ends, a fault included.
//   call        one POST <origin>/v1/chat/completions on the key with MASQ_REVIEW_HEADERS (x-masq-policy off,
//               x-masq-verbatim 1) and x-cosmos-side-spawn (HOUSE_FORECAST_SIDE_SPAWN: a one-shot, so masq places
//               no cache breakpoint of its own). Its form is the judge's: response_format json_object
//               (the superbot family: a non-strict json_schema of the output schema as its grammar takes it,
//               superbotGrammarSchemaOf), or the plain answer for a model that takes no forced tool (judgeFormsOf on
//               the mint's model card). reasoning_effort is the agent's: a flag's, else on the house model
//               (superbot, the default) the house effort, high (houseForecastAgent), named in the record; an agent
//               that names none (a stored record's from before) sends none to the superbot family and nothing to any
//               other model.
//   grammar     superbot's json_schema is compiled to a grammar that refuses a keyword it would ignore, the whole
//               request with it (HTTP 400 "Failed to compile json grammar: JSON Schema at #/properties/top10 is not
//               supported by xgrammar: keyword(s) uniqueItems would be ignored", the dev site, 2026-11-11T04:25Z):
//               that one json_schema leaves out SUPERBOT_GRAMMAR_REFUSED's keywords and says each in its node's
//               description instead, as grader/dialect.ts says a keyword structured outputs do not take. The
//               bundle's parse, which judges the forecast, still refuses what the keyword said (a repeated id).
//               The forced tool's parameters are the schema as it is (masq answered that form 200 on the same
//               schema), and every other model's request is the bytes it always was.
//   budget      superbot pays its reasoning out of max_tokens, and at reasoning_effort max it thinks past the
//               default budget (the dev site's 2026-11-11T04:25Z forecast: cut at 16000): a new forecast on the
//               superbot family at max with no --max-output-tokens of its own gets
//               HOUSE_FORECAST_MAX_EFFORT_OUTPUT_TOKENS (houseForecastAgent), named in the agent, the record and the
//               preflight's worst case alike.
//   dialect     a Claude model is asked on masq's POST /v1/messages in its own dialect (houseForecastWire,
//               judge-call.ts's rule: the key as x-api-key, the body grader/dialect.ts chatToMessages makes of
//               the request, `answer` asking the output schema as structured output where Chat asked
//               json_object), its answer read back as Chat Completions; the attempt says so (`dialect:
//               'messages'`; absent, it went on Chat Completions, as every record from before did), and
//               houseForecastRequestJson rebuilds each attempt's bytes in its own dialect. A request the
//               dialect cannot say (an output schema structured outputs cannot hold) and every superbot call
//               go on Chat Completions byte for byte.
//   router      a key the broker minted at superbot-router (server/superbot-router.ts: routerOfKey(minted), its static
//               key, for a model routerServesModel names while MAKEFUN_SUPERBOT_ROUTER_URL and _KEY are set) is asked at
//               routerOfKey(minted).origin with routerHeaders alone (no x-masq-*, no x-cosmos-side-spawn;
//               x-sbr-speed flex), the same Chat Completions body streamed (the model as routerWireModel names it): on
//               POST /v1/messages as the Messages body server/superbot-router.ts routerMessagesBody makes of it
//               wherever it maps, else on POST /v1/chat/completions (routerWire, the bytes request_sha256 names). The
//               blob stored and read is the document routerAnswerIn assembles from the stream (a Messages one read as
//               the Chat Completions answer it says); a 2xx stream that ended on an error frame, was cut, or holds a
//               frame that is not JSON is an answer that could not be read (`faults`): nothing stored, no attempt.
//               The attempt says `dialect: 'router-messages'` or `'router'`. The forecast's timeout holds the
//               router's head alone: a flex ask may park for the batch lane's 600 s, and the router's own first-byte
//               bound and idle cut end the read (routerDial). The router's card for the
//               model on the key caps the answer (capabilities.max_output_tokens, which the router clamps a request
//               to, cutting and billing it): a card under the agent's max_output_tokens faults before anything is
//               sent. No fresh-key wait: the key is static, so a 401 is a fault at once. The router's one named wait is
//               honoured once a call (clients.md §4.5, CL-2), the forecast's own rule (a judge heat's call, since
//               judge-call.ts's `router`, waits out every one the router names, with no count and no ceiling): a 429,
//               503 or 529 routerResendable allows with a retry-after (routerNamedWaitMs), or a 2xx stream whose
//               in-band error came before any content, names retry_after and does not say retryable false
//               (routerInBandWaitMs), of at most JUDGE_RATE_LIMIT_WAIT_MS, is sent again once, the same bytes, after
//               exactly that wait, no attempt; the second answer is taken whatever it is, and a longer wait is not
//               waited. Nothing else the router answered is sent again. One log line a
//               router call (the options' `log`, default stderr; never a record field) names its answers' served
//               tier (usage.speed), x-sbr-lane and x-sbr-ignored (routerServedWords). Every other key is masq's, byte
//               for byte as above.
//   retry       an answer that gives no valid forecast (unparseable, refused, answered by another model, an HTTP
//               400/413/422, or a forecast the caller's validate refuses) is asked ONCE more, the same messages, as
//               a forced NAMED tool (HOUSE_FORECAST_TOOL, the output schema as its parameters; tool_auto for a model
//               that takes no forced tool, or once masq refused a forced form). Never a third request. An answer cut
//               at finish_reason length ends the call there: the retry would be the same budget, which the answer
//               and its reasoning did not fit, so it is never spent on one (the record says so, and the CLI names a
//               larger --max-output-tokens).
//   fresh key   a 401 on a masq key minted less than MASQ_KEY_WARMUP_MS ago is re-sent, the same bytes, after a wait:
//               no model saw it, so it is no attempt (judge-call.ts's rule).
//   faults      masq (superbot-router on a router key) unreachable, an answer whose body could not be read (on a
//               router key also a 2xx stream routerAnswerIn faults, its message naming the answer's request-id), or
//               any other non-2xx status throws HouseForecastFault, the attempts that completed, the upstream and the
//               retired key on it: no record is made.
//   scope       a 403 that is masq's scope refusal (`this key is not scoped for model <id>`: the minted key's
//               allowedModels, not the call) also pages a `[model-key] ALERT: ` line (server/house-model.ts
//               watchMasqScope), once for every forecast's minted key until a forecast call answers again, never the key;
//               the router's, in the same words, pages its own fix (upstream superbot-router, MAKEFUN_SUPERBOT_ROUTER_KEY).
//
// Every response body is stored as a blob (blobs.put) before it is read; each attempt's usage is priced by
// pricing/price.ts priceUsage at the attempt's own instant, and the record names pricingRev.
//
// The forecast is read from the tool call's arguments, else the message's text past any think block: the JSON it
// holds (answerJsonOf: the whole text, a fenced block or the outermost {...}) re-serialised compactly with a newline,
// or, when it holds none, the text as it came. The caller's validate (the bundle's own vendored scorer parse, wired
// by the CLI: grader/ never imports a bundle) decides whether it is valid; it is recorded either way. The forecast
// kept is the first valid one, else the last answer that held any text from the pinned model.
//
// The record (agent-fun/house-forecast-record/v1, HouseForecastRecord, canonical JSON) is keyed by the sha256 of the
// instance's exact task.json bytes. writeHouseEntry writes it and the forecast into an entry tree built from the
// template (grader/house-forecast-entry/: main.ts, LICENSE, forecasts/, records/), merging with what the tree
// already holds, so a practice instance and the final share one tree. A regrade replays the file; masq is never
// called again for an instance.
//
// per-file    a program/v1 instance with `cases: per-file` (polymarket-nvidia-ceo-forecast-01: one /input/<id>.in a
//             case, makefun/polymarket-case/v1, each case run in a pod of its own) has no task.json. The caller hands
//             a house-built descriptor in its place (polymarketInstanceBytes: competition, phase, deadline, the
//             history cut, the horizon, the market ids and the history document's sha256), shown under
//             HOUSE_FORECAST_CASES_TASK_HEADING with HOUSE_FORECAST_CASES_SYSTEM; its sha256 is the record's key as a
//             task.json's is. The history is compactPolymarketHistory of ONE case-shaped document cut at the history's
//             end (a practice case file, or the final's backfill), the contract polymarketForecastContract, the schema
//             polymarketForecastSchema ({forecasts: [{id, sigma, drift}]} a market, no uniqueItems), the validate
//             parsePolymarketForecast. The record names per_case (the cut, the markets, the history document's blob).
//             writeHouseEntry writes it from grader/house-forecast-entry-cases/ (main.ts, LICENSE) into a tree that
//             holds that one record alone; its main.ts applies the forecast to every <id>.in it is run on,
//             polymarketCaseOutputBytes byte for byte: q = clamp(x + drift*h/60 + z*sigma*sqrt(h), 0, 1) at 6
//             decimals from each case's last price x, the baseline's sigma 0.0025 and drift 0 for a market the
//             forecast lacks and for every market of a case before the cut.
//             A Twitch viewers instance (per_case.kind twitch-ccu: grader/house-forecast-twitch-ccu.ts) and a GTA VI
//             trophy rarity one (per_case.kind gta6-trophies: the trophy section below, its template
//             grader/house-forecast-entry-gta6-trophies/) are per-file the same way, each with a template of its own.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseMarkLines, type MarkLineT } from '../collector/pump-forecast/market.ts';
import { chartRowsOf, parseSnapshots, TRENDING_CHART, type ForecastChart } from '../collector/roblox/chart.ts';
import { CassetteUsage, type CassetteUsageT } from '../contracts/agent.ts';
import { ModelId, REASONING_EFFORTS } from '../contracts/competition.ts';
import { IsoDateTime, Sha256Hex } from '../contracts/primitives.ts';
import { priceUsage, pricingRev } from '../pricing/price.ts';
import {
  answerJsonOf,
  MASQ_REVIEW_HEADERS,
  MASQ_TIMEOUT_MS,
  masqAnswerText,
  masqAuthHeaders,
  masqMessagesBody,
  masqSkipsJsonMode,
  masqWire,
  SUPERBOT_UNNAMED_EFFORT,
  withoutThinking,
  type MasqDialect,
  type MasqWire,
} from '../server/entries/ai-review.ts';
import { HOUSE_MODEL, HOUSE_REASONING_EFFORT, watchMasqScope } from '../server/house-model.ts';
import { canonicalJson } from '../sim/canonical.ts';
import { MASQ_KEY_WARMUP_GAP_MS, MASQ_KEY_WARMUP_MS, retireTrialKey, type JudgeKeyPhase, type MasqJudgeKeyBroker, type RetiredTrialKey } from './gateway/masq.ts';
import { worstCaseMicroUsd } from './gateway/policy.ts';
import { isServedModel, MASQ_MODEL_HEADER } from './gateway/upstream.ts';
import { JUDGE_FORCED_FORMS, JUDGE_RATE_LIMIT_WAIT_MS, JUDGE_UNFORCED_FORMS, judgeFormsOf, judgeModelCard, judgeUsageOf, type JudgeBlobs, type JudgeForm, type JudgeForms } from './judge-call.ts';
import {
  ROUTER_DIALECT,
  ROUTER_MESSAGES_DIALECT,
  routerAnswerIn,
  routerDial,
  routerHeaders,
  routerInBandOf,
  routerInBandWaitMs,
  routerNamedWaitMs,
  routerOfKey,
  routerOutputCeiling,
  routerRequestJsonIn,
  routerServedOf,
  routerServedWords,
  routerServesModel,
  routerWire,
  routerWireModel,
  type RouterAnswer,
  type RouterDial,
  type RouterServed,
} from '../server/superbot-router.ts';

/** The record's schema. */
export const HOUSE_FORECAST_RECORD_SCHEMA = 'agent-fun/house-forecast-record/v1';
/**
 * The model a forecast calls when its flags name none: the house model, superbot (server/house-model.ts, the owner's
 * call of 2026-11-09), asked for the house effort (houseForecastAgent). The CLI (scripts/competitions/house-forecast.ts)
 * names its --model always.
 */
export const HOUSE_FORECAST_MODEL = HOUSE_MODEL;
/**
 * The answer's token budget: a flag, this its default. Room for about 900 rows of {universe_id, place, p} at the
 * house's 3 bytes a token; a reasoning_effort's thinking is paid out of it too (the house model at high thought at
 * most 10478 tokens in the live probe of 2026-11-09, on a smaller prompt: server/seeding/llm.ts).
 */
export const HOUSE_FORECAST_MAX_OUTPUT_TOKENS = 16_000;
/**
 * The answer's token budget of a new forecast on the superbot family at reasoning_effort max that names none
 * (houseForecastAgent): its reasoning is paid out of it, and at max it ran past 16,000 on the dev site's forecast of
 * 2026-11-11T04:25Z (25,762 input tokens) and to 32,949 on the house judge's two-text verdicts (540 calls,
 * news-summary-01's judge, whose 49,500 cap is 1.5 times that). 64,000 holds that reasoning 1.5 times over and about
 * 14,500 tokens of answer (about 900 rows of {universe_id, place, p}). On superbot ($0.30 / $1.20 a million input /
 * output tokens) two requests of the dev forecast's prompt at it are a worst case of 2 x (7,729 + 76,800) µUSD =
 * $0.169.
 */
export const HOUSE_FORECAST_MAX_EFFORT_OUTPUT_TOKENS = 64_000;
/** Requests one call may send: the answer, then one format retry. */
export const HOUSE_FORECAST_ATTEMPTS = 2;
/** The forced tool's name, and the json_schema's. */
export const HOUSE_FORECAST_TOOL = 'forecast';
/** x-cosmos-side-spawn's value: a one-shot side spawn, on which masq places no cache breakpoint. */
export const HOUSE_FORECAST_SIDE_SPAWN = 'makefun-house-forecast';
/** The rows of each read the compact history keeps. */
export const HOUSE_FORECAST_HISTORY_TOP_N = 30;
/** The output schema when the caller names none: a JSON object, its shape the output contract's to say. */
export const HOUSE_FORECAST_DEFAULT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({ type: 'object' });

/** The system prompt every house forecast call sends. */
export const HOUSE_FORECAST_SYSTEM = [
  "You are make.fun's house forecaster. You enter a forecasting competition as the house's own model entry, scored by exactly the rules every entrant is scored by.",
  'The user message holds the competition rules, the task.json of the instance you forecast, the output contract your forecast must meet, and the history every entrant is given.',
  'Forecast as well as you can from them, then answer with the forecast document alone: one JSON object exactly as the output contract describes, with no prose, no code fence and nothing before or after it.',
].join('\n');

/** The user message's last line. */
export const HOUSE_FORECAST_ANSWER_LINE = 'Answer with the JSON only: the one forecast document the output contract describes, nothing before or after it.';

/** The forced tool's description. */
export const HOUSE_FORECAST_TOOL_DESCRIPTION = 'Submit your forecast: its arguments are the forecast document itself, exactly as the output contract describes.';

/** The entry template: main.ts, LICENSE, forecasts/ and records/. */
export const HOUSE_ENTRY_TEMPLATE_DIR = fileURLToPath(new URL('./house-forecast-entry/', import.meta.url));
/** The template's files, copied into every entry tree as they are. */
export const HOUSE_ENTRY_TEMPLATE_FILES = Object.freeze(['main.ts', 'LICENSE', 'forecasts/README.md', 'records/README.md'] as const);
/**
 * A per-file instance's entry template (a Polymarket price forecast: the header's `per-file`): main.ts and LICENSE.
 * Its tree ships exactly ONE record and its forecast, which main.ts applies to every case it is run on.
 */
export const HOUSE_ENTRY_CASES_TEMPLATE_DIR = fileURLToPath(new URL('./house-forecast-entry-cases/', import.meta.url));
/** The per-file template's files, copied into its entry tree as they are. */
export const HOUSE_ENTRY_CASES_TEMPLATE_FILES = Object.freeze(['main.ts', 'LICENSE'] as const);
/**
 * A Twitch viewers instance's entry template (gta6-twitch-ccu-forecast-01, grader/house-forecast-twitch-ccu.ts): main.ts
 * and LICENSE, its tree one record alone as the per-file template's, picked by the record's per_case.kind.
 */
export const HOUSE_ENTRY_TWITCH_CCU_TEMPLATE_DIR = fileURLToPath(new URL('./house-forecast-entry-twitch-ccu/', import.meta.url));
/**
 * A GTA VI trophy rarity instance's entry template (gta6-trophy-rarity-forecast-01, the trophy section below): main.ts and
 * LICENSE, its tree one record alone as the per-file template's, picked by the record's per_case.kind.
 */
export const HOUSE_ENTRY_GTA6_TROPHIES_TEMPLATE_DIR = fileURLToPath(new URL('./house-forecast-entry-gta6-trophies/', import.meta.url));

/** A file name a task.json's `output` may give (the entry's main.ts holds the same rule). */
const OUTPUT_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
/** A forced form masq refuses for its model (HTTP 400): Anthropic's "tool_choice: type "tool" and "any" are not supported for this model." */
const FORCED_TOOL_REFUSED = /tool_choice\b.*\bnot supported\b/is;
/** HTTP statuses that refuse this one request: answer-level, so retried, then recorded invalid. */
const ANSWER_LEVEL_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const isoOf = (ms: number): string => new Date(ms).toISOString();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ------------------------------------------------------------------ the agent and the input

export type HouseForecastEffort = (typeof REASONING_EFFORTS)[number];

/** The model call's flags: what the record names. */
export interface HouseForecastAgent {
  model: string;
  max_output_tokens: number;
  /**
   * Sent as reasoning_effort when set; unset, the superbot family's off switch (SUPERBOT_UNNAMED_EFFORT, none) on it and
   * nothing otherwise. houseForecastAgent sets it for a new forecast on the house model, so unset is a stored record's
   * agent that named none, rebuilt as it was sent.
   */
  reasoning_effort?: HouseForecastEffort;
}

/**
 * A new forecast's flags with their defaults filled, each checked: HOUSE_FORECAST_MODEL, the answer's budget, and on
 * the house model (exactly HOUSE_MODEL) the house effort (HOUSE_REASONING_EFFORT, high), named in the agent so the
 * record names it; no reasoning_effort on any other model. The budget is HOUSE_FORECAST_MAX_OUTPUT_TOKENS, but on the
 * superbot family at reasoning_effort max HOUSE_FORECAST_MAX_EFFORT_OUTPUT_TOKENS (the header's `budget`); a flag's
 * wins. Never used to rebuild a stored record's request: an agent built from a record names only the effort and the
 * budget the record does (houseForecastRequestBody sends `none` to the superbot family for one that names none, as it
 * was sent).
 */
export function houseForecastAgent(flags: Partial<HouseForecastAgent> = {}): HouseForecastAgent {
  const model = flags.model ?? HOUSE_FORECAST_MODEL;
  if (!ModelId.safeParse(model).success) throw new TypeError(`the house forecast model is an exact model id, got ${JSON.stringify(model)}`);
  const effort = flags.reasoning_effort ?? (model === HOUSE_MODEL ? HOUSE_REASONING_EFFORT : undefined);
  if (effort !== undefined && !(REASONING_EFFORTS as readonly string[]).includes(effort)) throw new TypeError(`reasoning_effort is one of ${REASONING_EFFORTS.join(', ')}, got ${JSON.stringify(effort)}`);
  const max = flags.max_output_tokens ?? (effort === 'max' && masqSkipsJsonMode(model) ? HOUSE_FORECAST_MAX_EFFORT_OUTPUT_TOKENS : HOUSE_FORECAST_MAX_OUTPUT_TOKENS);
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError(`max_output_tokens is a whole number from 1, got ${max}`);
  return { model, max_output_tokens: max, ...(effort !== undefined ? { reasoning_effort: effort } : {}) };
}

/** What one instance's prompt is built from: the caller reads each (the CLI from the bundle and the instance's input/). */
export interface HouseForecastInput {
  /** The bundle's rules text. */
  rules: string;
  /**
   * The instance's /input/task.json, its exact bytes: their sha256 is the record's key. A per-file instance, which has
   * none, hands its house-built descriptor instead (polymarketInstanceBytes).
   */
  task: Uint8Array;
  /** The output contract: what the forecast document must be. */
  contract: string;
  /** The history entrants are given, compacted for the prompt (compactChartHistory, compactPumpHistory, compactPolymarketHistory). */
  history: string;
  /** The system prompt; default HOUSE_FORECAST_SYSTEM (a per-file instance's: HOUSE_FORECAST_CASES_SYSTEM). */
  system?: string;
  /** The heading `task` is shown under; default `task.json` (a per-file instance's descriptor: HOUSE_FORECAST_CASES_TASK_HEADING). */
  taskHeading?: string;
}

/** A task.json as the house reads it: its key, its text and the output file name it gives. */
export interface HouseForecastTask {
  sha256: string;
  text: string;
  output: string;
}

/** The task's key (sha256 of its exact bytes), text and `output` name; a task that is not UTF-8 JSON naming a plain output file name throws. */
export function houseForecastTaskOf(task: Uint8Array): HouseForecastTask {
  let text: string;
  try {
    text = utf8.decode(task);
  } catch {
    throw new TypeError('task.json is not UTF-8 text');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new TypeError(`task.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const output = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>).output : undefined;
  if (typeof output !== 'string' || !OUTPUT_NAME.test(output)) throw new TypeError(`task.json names no plain output file name (output ${JSON.stringify(output)})`);
  return { sha256: sha256Hex(task), text, output };
}

// ------------------------------------------------------------------ the history

/** A name as one cell of the compact table: control characters (a tab, a newline) become spaces, so a row stays one line of four cells. */
const cellOf = (name: string): string => name.replace(/[\u0000-\u001f\u007f]/g, ' ');

/**
 * A Roblox chart history (history.ndjson: makefun/roblox-chart-snapshot/v1 lines, collector/roblox/chart.ts) as the
 * prompt's compact table: a header line, then each read that holds `chart` (default Top Trending; an Up-and-Coming
 * contest's is Up-and-Coming, its line's up_and_coming rows, the context charts left out), oldest first, as a line
 * `read <at> <source>` and its first `topN` rows as `rank<TAB>universe_id<TAB>name<TAB>playing` (`-` where the read
 * gave no player count). Reads that failed are left out and counted in the header. Every line is checked as the
 * collector checks it; a last line without its newline is read too (a history handed to an entrant is whole).
 *
 * A read costs about 1.5 KB at the top 30, so the preflight's $2 holds a call of 16,000 output tokens on
 * claude-opus-5-5 past about 145 reads: `lastReads` keeps only the latest that many (the header says how many of how
 * many), for a caller whose history is longer.
 */
export function compactChartHistory(historyNdjson: string, topN: number = HOUSE_FORECAST_HISTORY_TOP_N, lastReads?: number, chart: ForecastChart = TRENDING_CHART): string {
  if (!Number.isSafeInteger(topN) || topN < 1) throw new RangeError(`topN is a whole number from 1, got ${topN}`);
  if (lastReads !== undefined && (!Number.isSafeInteger(lastReads) || lastReads < 1)) throw new RangeError(`lastReads is a whole number from 1, got ${lastReads}`);
  const text = historyNdjson === '' || historyNdjson.endsWith('\n') ? historyNdjson : `${historyNdjson}\n`;
  const all = parseSnapshots(text, 'the history');
  const ok = all
    .map((s, i) => ({ s, i, ms: Date.parse(s.at) }))
    .filter(({ s }) => s.ok && chartRowsOf(s, chart) !== null)
    .sort((a, b) => a.ms - b.ms || a.i - b.i);
  const reads = lastReads === undefined ? ok : ok.slice(-lastReads);
  const failed = all.length - ok.length;
  const lines = [
    `${chart.title} chart history: ${reads.length === ok.length ? `${ok.length} reads` : `the last ${reads.length} of ${ok.length} reads`}, oldest first${failed > 0 ? ` (${failed} failed reads left out)` : ''}. ` +
      `Each read is a line "read <time, UTC> <source>", then its top ${topN} rows as rank<TAB>universe_id<TAB>name<TAB>playing (players in the game at the read; - when the read gave none).`,
  ];
  for (const { s } of reads) {
    lines.push('', `read ${s.at} ${s.source}`);
    const rows = [...(chartRowsOf(s, chart) ?? [])].sort((a, b) => a.rank - b.rank).slice(0, topN);
    for (const r of rows) lines.push(`${r.rank}\t${r.universe_id}\t${cellOf(r.name)}\t${r.playing ?? '-'}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The marks a pump.fun top-5 history (compactPumpHistory) shows when the caller names no --last-reads: the latest 12,
 * two hours at the recorder's 10-minute cadence. The rows a mark shows are HOUSE_FORECAST_HISTORY_TOP_N's 30.
 */
export const HOUSE_FORECAST_PUMP_LAST_READS = 12;
/**
 * The most characters (code points) of a coin's symbol a pump.fun row shows: a symbol is its creator's free text,
 * which the mark line does not bound, and the preflight's worst case is sized on it (at most 4 UTF-8 bytes each).
 */
export const HOUSE_FORECAST_PUMP_SYMBOL_CHARS = 16;

/**
 * The marks of a pump.fun top-5 history (history.ndjson: makefun/pumpfun-top5-forecast/mark/v1 lines,
 * collector/pump-forecast/market.ts MarkLine), every line checked as the recorder writes it (a last line without its
 * newline is read too: a history handed to an entrant is whole): the ok ones oldest first, and how many were not ok.
 */
export function pumpHistoryMarksOf(historyNdjson: string): { ok: MarkLineT[]; failed: number } {
  const text = historyNdjson === '' || historyNdjson.endsWith('\n') ? historyNdjson : `${historyNdjson}\n`;
  const all = parseMarkLines(text, 'the history');
  const ok = all
    .map((m, i) => ({ m, i, ms: Date.parse(m.at) }))
    .filter(({ m }) => m.ok)
    .sort((a, b) => a.ms - b.ms || a.i - b.i)
    .map(({ m }) => m);
  return { ok, failed: all.length - ok.length };
}

const LAMPORTS_PER_SOL = 1_000_000_000n;
const LAMPORTS_PER_CENTISOL = 10_000_000n;

/** A cap in lamports (a decimal integer string) as SOL with 2 decimals, rounded down, exactly (never through a float). */
export function solText(lamports: string): string {
  const v = BigInt(lamports);
  return `${v / LAMPORTS_PER_SOL}.${String((v % LAMPORTS_PER_SOL) / LAMPORTS_PER_CENTISOL).padStart(2, '0')}`;
}

/**
 * A pump.fun top-5 history (pumpHistoryMarksOf) as the prompt's compact table: a header line, then each ok mark, oldest
 * first, as a line `mark <at> <eligible> eligible, <graduated> graduated` (the coins created from t0 the read knew, and
 * how many of them had graduated) and its first `topN` rows by rank as
 * `rank<TAB>mint<TAB>symbol<TAB>age_min<TAB>cap_sol<TAB>venue`: the mint whole (an entry names a coin by it), the symbol
 * cut to HOUSE_FORECAST_PUMP_SYMBOL_CHARS, age_min the whole minutes from the coin's creation (its CreateEvent) to the
 * mark, cap_sol its market cap in SOL rounded down to 2 decimals (solText), venue curve, migrating or pool. Marks that
 * failed are left out and counted in the header (the freeze writes ok marks alone, so a frozen history has none).
 * `lastReads` keeps only the latest that many marks (the header says how many of how many); undefined keeps them all.
 * The row's slot, name, quote reserves and flags, the mark's other counts and the rows past `topN` are left out: the
 * history file holds them.
 *
 * A row costs at most about 140 bytes (a 44-character mint, 16 four-byte symbol characters, a 10-million-SOL cap, a
 * 9-character venue), so a mark at the top 30 about 4.2 KB. Measured on that worst case with a 36 KB rules text
 * (tests/unit/house-forecast-pump.test.ts; the preflight's worst case of two requests): the default 12 marks are $0.17
 * on superbot at --reasoning-effort max (64,000 output tokens) and $1.16 on claude-opus-5-5 (16,000); all 66 marks a
 * final's 11 hours hold are $0.22 on superbot and $2.42 on claude-opus-5-5.
 */
export function compactPumpHistory(historyNdjson: string, topN: number = HOUSE_FORECAST_HISTORY_TOP_N, lastReads?: number): string {
  if (!Number.isSafeInteger(topN) || topN < 1) throw new RangeError(`topN is a whole number from 1, got ${topN}`);
  if (lastReads !== undefined && (!Number.isSafeInteger(lastReads) || lastReads < 1)) throw new RangeError(`lastReads is a whole number from 1, got ${lastReads}`);
  const { ok, failed } = pumpHistoryMarksOf(historyNdjson);
  const marks = lastReads === undefined ? ok : ok.slice(-lastReads);
  const lines = [
    `pump.fun market-cap chart history: ${marks.length === ok.length ? `${ok.length} marks` : `the last ${marks.length} of ${ok.length} marks`}, oldest first${failed > 0 ? ` (${failed} failed marks left out)` : ''}. ` +
      `Each mark is a line "mark <time, UTC> <n> eligible, <n> graduated" (the coins created from t0 the read knew, and how many of them had graduated), ` +
      `then its top ${topN} rows by market cap as rank<TAB>mint<TAB>symbol<TAB>age_min<TAB>cap_sol<TAB>venue: age_min the whole minutes from the coin's creation to the mark, ` +
      `cap_sol its market cap in SOL rounded down to 2 decimals, venue curve, migrating or pool; a symbol longer than ${HOUSE_FORECAST_PUMP_SYMBOL_CHARS} characters is cut there.`,
  ];
  for (const m of marks) {
    const at = Date.parse(m.at);
    lines.push('', `mark ${m.at} ${m.counts.eligible} eligible, ${m.counts.graduated} graduated`);
    const rows = [...m.rows].sort((a, b) => a.rank - b.rank).slice(0, topN);
    for (const r of rows) {
      const symbol = Array.from(cellOf(r.symbol)).slice(0, HOUSE_FORECAST_PUMP_SYMBOL_CHARS).join('');
      const age = Math.max(0, Math.floor((at - Date.parse(r.created_at)) / 60_000));
      lines.push(`${r.rank}\t${r.mint}\t${symbol}\t${age}\t${solText(r.market_cap_lamports)}\t${r.venue}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------------ a per-file instance: the Polymarket price forecast

/** A Polymarket case file's schema: one /input/<id>.in of a per-file instance (polymarket-nvidia-ceo-forecast-01). */
export const POLYMARKET_CASE_SCHEMA = 'makefun/polymarket-case/v1';
/** The house-built descriptor a per-file instance stands for its task.json with (polymarketInstanceBytes): its sha256 is the record's key. */
export const POLYMARKET_INSTANCE_SCHEMA = 'makefun/house-forecast/polymarket-instance/v1';
/** The descriptor's `output`: the forecast document the entry applies (each case's own output is <id>.out). */
export const POLYMARKET_FORECAST_FILE = 'forecast.json';
/** The quantile levels every case forecasts, in a row's order. */
export const POLYMARKET_QUANTILES: readonly number[] = Object.freeze([0.05, 0.25, 0.5, 0.75, 0.95]);
/** The standard normal's quantile at each level, to 6 decimals: the persistence baseline's, digit for digit. */
export const POLYMARKET_Z: readonly number[] = Object.freeze([-1.644854, -0.67449, 0, 0.67449, 1.644854]);
/** The persistence baseline's spread (price units per square-root minute) and drift (price units per hour): a market the forecast lacks gets them. */
export const POLYMARKET_BASELINE_SIGMA = 0.0025;
export const POLYMARKET_BASELINE_DRIFT = 0;
/** The largest sigma, and the largest |drift|, a forecast may give. */
export const POLYMARKET_SIGMA_MAX = 0.05;
export const POLYMARKET_DRIFT_MAX = 0.2;
/** The compact history's hourly closes, and its last one-minute prices, when the caller names no other. */
export const HOUSE_FORECAST_POLYMARKET_HOURS = 48;
export const HOUSE_FORECAST_POLYMARKET_MINUTES = 120;
/** The largest <id>.out a case may write (the contest's output contract). */
export const POLYMARKET_MAX_OUTPUT_BYTES = 1024 * 1024;
/** The longest horizon a case may name, minutes. */
const POLYMARKET_MAX_HORIZON = 1440;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The system prompt of a per-file instance's call: its descriptor, not a task.json, and a history compacted from a case file. */
export const HOUSE_FORECAST_CASES_SYSTEM = [
  "You are make.fun's house forecaster. You enter a forecasting competition as the house's own model entry, scored by exactly the rules every entrant is scored by.",
  "The user message holds the competition rules, the instance you forecast (the house's descriptor of it), the output contract your forecast must meet, and the history every entrant is given, compacted.",
  'Forecast as well as you can from them, then answer with the forecast document alone: one JSON object exactly as the output contract describes, with no prose, no code fence and nothing before or after it.',
].join('\n');
/** The heading a per-file instance's descriptor is shown under. */
export const HOUSE_FORECAST_CASES_TASK_HEADING = 'The instance';

/** A Polymarket case's market: its Yes price on the 1-minute grid from `start` to the case's `at`, inclusive. */
export const PolymarketCaseMarket = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string(),
  yes_token: z.string().min(1),
  start: IsoDateTime,
  prices: z.array(z.number().min(0).max(1)).min(1),
});
/** A Polymarket case file (makefun/polymarket-case/v1), read as the contest's case contract writes it; other keys are left out. */
export const PolymarketCase = z.object({
  schema: z.literal(POLYMARKET_CASE_SCHEMA),
  competition: z.string().min(1),
  case: z.string().min(1),
  at: IsoDateTime,
  horizon_minutes: z.int().min(1).max(POLYMARKET_MAX_HORIZON),
  quantiles: z.array(z.number()),
  event: z.object({ slug: z.string(), title: z.string() }),
  markets: z.array(PolymarketCaseMarket).min(1),
});
export type PolymarketCaseT = z.infer<typeof PolymarketCase>;

/**
 * A case file's bytes (or text) as a Polymarket case, every rule of the case contract checked: UTF-8 JSON of the schema,
 * the quantile levels POLYMARKET_QUANTILES, `at` and every market's `start` whole UTC minutes, each market's prices one a
 * minute from its start to `at` inclusive (so the last one is the price at the checkpoint), no market id twice. Throws a
 * TypeError naming `where` and the first rule broken.
 */
export function parsePolymarketCase(bytes: Uint8Array | string, where = 'the case'): PolymarketCaseT {
  let text: string;
  try {
    text = typeof bytes === 'string' ? bytes : utf8.decode(bytes);
  } catch {
    throw new TypeError(`${where} is not UTF-8 text`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new TypeError(`${where} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = PolymarketCase.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TypeError(`${where} is not a ${POLYMARKET_CASE_SCHEMA} case: ${issue === undefined ? 'invalid' : `${issue.path.join('.') || '(the case)'}: ${issue.message}`}`);
  }
  const c = parsed.data;
  if (c.quantiles.length !== POLYMARKET_QUANTILES.length || c.quantiles.some((t, j) => t !== POLYMARKET_QUANTILES[j])) {
    throw new TypeError(`${where} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(POLYMARKET_QUANTILES)}`);
  }
  const at = Date.parse(c.at);
  if (at % MINUTE_MS !== 0) throw new TypeError(`${where}'s at ${c.at} is not a whole UTC minute`);
  const seen = new Set<string>();
  for (const m of c.markets) {
    if (seen.has(m.id)) throw new TypeError(`${where} names market ${m.id} twice`);
    seen.add(m.id);
    const start = Date.parse(m.start);
    if (start % MINUTE_MS !== 0 || start > at) throw new TypeError(`${where}'s market ${m.id} starts at ${m.start}, not a whole UTC minute at or before ${c.at}`);
    const minutes = (at - start) / MINUTE_MS + 1;
    if (m.prices.length !== minutes) throw new TypeError(`${where}'s market ${m.id} holds ${m.prices.length} prices from ${m.start} to ${c.at}, not one a minute (${minutes})`);
  }
  return c;
}

/** A price as the compact history writes it: as the case holds it (JSON's shortest form). */
const priceCell = (p: number): string => JSON.stringify(p);

/**
 * A Polymarket case (parsePolymarketCase: a case file of the instance, or the house's own history document cut at the
 * same minute) as the prompt's compact history: a header, then per market in the case's order a line
 * `market <id><TAB><name><TAB>last <price at at><TAB>grid from <start>`, a line `hourly<TAB>` and the `hours` hourly
 * closes ending at `at` (the price at at-(hours-1)h, ..., at-1h, at; `-` before the market's grid starts), and a line
 * `minutes<TAB>` and its last `minutes` one-minute prices, the last one at `at` (fewer when its grid is shorter). Every
 * price as the case holds it.
 *
 * At the defaults (48 closes, 120 minutes) a market costs about 1.2 KB, so 24 markets about 29 KB.
 */
export function compactPolymarketHistory(c: PolymarketCaseT, hours: number = HOUSE_FORECAST_POLYMARKET_HOURS, minutes: number = HOUSE_FORECAST_POLYMARKET_MINUTES): string {
  if (!Number.isSafeInteger(hours) || hours < 1) throw new RangeError(`hours is a whole number from 1, got ${hours}`);
  if (!Number.isSafeInteger(minutes) || minutes < 1) throw new RangeError(`minutes is a whole number from 1, got ${minutes}`);
  const at = Date.parse(c.at);
  const lines = [
    `Polymarket price history of the event "${cellOf(c.event.title)}" (${cellOf(c.event.slug)}) to ${c.at}, the cut: the last minute this forecast sees. ` +
      `${c.markets.length} markets, each its Yes price (0 to 1) as Polymarket's public price history gives it, on a 1-minute UTC grid, forward-filled. ` +
      `For each market a line "market <id><TAB><name><TAB>last <the price at the cut><TAB>grid from <its first minute>", ` +
      `then "hourly<TAB>" and its ${hours} hourly closes ending at the cut, oldest first (the price at each whole hour back from the cut; - before its grid starts), ` +
      `then "minutes<TAB>" and its last ${minutes} one-minute prices, oldest first, the last one at the cut.`,
  ];
  for (const m of c.markets) {
    const start = Date.parse(m.start);
    const priceAt = (t: number): string => (t < start ? '-' : priceCell(m.prices[(t - start) / MINUTE_MS]!));
    const closes = Array.from({ length: hours }, (_, k) => priceAt(at - (hours - 1 - k) * HOUR_MS));
    lines.push('', `market ${cellOf(m.id)}\t${cellOf(m.name)}\tlast ${priceCell(m.prices.at(-1)!)}\tgrid from ${m.start}`, `hourly\t${closes.join(' ')}`, `minutes\t${m.prices.slice(-minutes).map(priceCell).join(' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** What a per-file instance's descriptor names (polymarketInstanceBytes). */
export interface PolymarketInstance {
  competition: string;
  phase: 'dev' | 'final';
  /** The competition's deadline, ISO. */
  deadline: string;
  /** The history cut: the last minute the forecast sees (the history document's `at`), ISO. */
  history_until: string;
  /** Each case's horizon, minutes (the cases' horizon_minutes). */
  horizon_minutes: number;
  /** The universe's market ids, in its order. */
  markets: string[];
  /** sha256 of the history document's exact bytes (a practice case file, or the final's backfill cut at history_until). */
  history_sha256: string;
}

/**
 * The descriptor a per-file instance stands for its task.json with (it has none): canonical JSON {schema
 * POLYMARKET_INSTANCE_SCHEMA, competition, phase, deadline, history_until, horizon_minutes, quantiles, markets,
 * history_sha256, output POLYMARKET_FORECAST_FILE} and a newline. Its sha256 is the record's key (task_sha256) and the
 * entry's file names; it is the same bytes for the same instance and the same history.
 */
export function polymarketInstanceBytes(i: PolymarketInstance): Uint8Array {
  return new TextEncoder().encode(
    `${canonicalJson({
      schema: POLYMARKET_INSTANCE_SCHEMA,
      competition: i.competition,
      phase: i.phase,
      deadline: i.deadline,
      history_until: i.history_until,
      horizon_minutes: i.horizon_minutes,
      quantiles: [...POLYMARKET_QUANTILES],
      markets: [...i.markets],
      history_sha256: i.history_sha256,
      output: POLYMARKET_FORECAST_FILE,
    })}\n`,
  );
}

/**
 * The forecast document's JSON schema for a universe of `marketIds`: {forecasts: exactly one row a market,
 * {id (one of the universe's), sigma (0 to POLYMARKET_SIGMA_MAX), drift (-POLYMARKET_DRIFT_MAX to POLYMARKET_DRIFT_MAX)}}.
 * It holds no uniqueItems (superbot's grammar refuses it: the header's `grammar`): the array's description says each
 * id comes once, and parsePolymarketForecast refuses a repeated one.
 */
export function polymarketForecastSchema(marketIds: readonly string[]): Record<string, unknown> {
  const n = marketIds.length;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['forecasts'],
    properties: {
      forecasts: {
        type: 'array',
        minItems: n,
        maxItems: n,
        description: `One row per market of the universe: each of its ${n} market ids exactly once, no id twice.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'sigma', 'drift'],
          properties: {
            id: { type: 'string', enum: [...marketIds], description: "The market's id (its conditionId), as the history names it." },
            sigma: { type: 'number', minimum: 0, maximum: POLYMARKET_SIGMA_MAX, description: "The spread of the market's Yes price moves, in price units per square-root minute (the persistence baseline's is 0.0025)." },
            drift: { type: 'number', minimum: -POLYMARKET_DRIFT_MAX, maximum: POLYMARKET_DRIFT_MAX, description: "The expected move of the market's Yes price, in price units per hour, positive up (the persistence baseline's is 0)." },
          },
        },
      },
    },
  };
}

/** A market's recorded parameters: sigma in price units per square-root minute, drift in price units per hour. */
export interface PolymarketParams {
  sigma: number;
  drift: number;
}

/** The persistence baseline's parameters: what a market the forecast lacks, or a case before the cut, gets. */
export const POLYMARKET_BASELINE_PARAMS: Readonly<PolymarketParams> = Object.freeze({ sigma: POLYMARKET_BASELINE_SIGMA, drift: POLYMARKET_BASELINE_DRIFT });

/**
 * A forecast document's bytes for a universe of `marketIds` (the house's own parse: the bundle's scorer reads the
 * cases' <id>.out, not this): UTF-8 JSON {forecasts} and no other key, each row exactly {id, sigma, drift}, the id one of
 * the universe's and never twice, every universe market present, sigma a finite number from 0 to POLYMARKET_SIGMA_MAX,
 * drift one from -POLYMARKET_DRIFT_MAX to POLYMARKET_DRIFT_MAX. The parameters by market id, or why not.
 */
export function parsePolymarketForecast(bytes: Uint8Array, marketIds: readonly string[]): { ok: true; params: Map<string, PolymarketParams> } | { ok: false; why: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(utf8.decode(bytes));
  } catch {
    return { ok: false, why: 'the forecast is not UTF-8 JSON' };
  }
  if (!isRecord(doc)) return { ok: false, why: 'the forecast is not a JSON object' };
  const top = Object.keys(doc);
  if (top.length !== 1 || top[0] !== 'forecasts') return { ok: false, why: `the forecast's keys are ${JSON.stringify(top)}, not exactly ["forecasts"]` };
  const rows = doc.forecasts;
  if (!Array.isArray(rows)) return { ok: false, why: 'forecasts is not an array' };
  const universe = new Set(marketIds);
  const params = new Map<string, PolymarketParams>();
  for (const [k, row] of rows.entries()) {
    if (!isRecord(row)) return { ok: false, why: `forecasts[${k}] is not an object` };
    const keys = Object.keys(row).sort();
    if (keys.length !== 3 || keys[0] !== 'drift' || keys[1] !== 'id' || keys[2] !== 'sigma') return { ok: false, why: `forecasts[${k}]'s keys are ${JSON.stringify(Object.keys(row))}, not exactly id, sigma and drift` };
    const { id, sigma, drift } = row;
    if (typeof id !== 'string' || !universe.has(id)) return { ok: false, why: `forecasts[${k}] names ${JSON.stringify(id)}, no market of the universe` };
    if (params.has(id)) return { ok: false, why: `forecasts[${k}] names market ${id} a second time` };
    if (typeof sigma !== 'number' || !Number.isFinite(sigma) || sigma < 0 || sigma > POLYMARKET_SIGMA_MAX) return { ok: false, why: `market ${id}'s sigma ${JSON.stringify(sigma)} is not a number from 0 to ${POLYMARKET_SIGMA_MAX}` };
    if (typeof drift !== 'number' || !Number.isFinite(drift) || drift < -POLYMARKET_DRIFT_MAX || drift > POLYMARKET_DRIFT_MAX) return { ok: false, why: `market ${id}'s drift ${JSON.stringify(drift)} is not a number from ${-POLYMARKET_DRIFT_MAX} to ${POLYMARKET_DRIFT_MAX}` };
    params.set(id, { sigma, drift });
  }
  const missing = marketIds.filter((id) => !params.has(id));
  if (missing.length > 0) return { ok: false, why: `no row for market(s) ${missing.join(', ')}` };
  return { ok: true, params };
}

/**
 * The output contract of a per-file Polymarket instance: what the forecast document is and how the house's entry applies
 * it to every case (polymarketCaseOutputBytes), then the schema, as houseForecastContract prints one.
 */
export function polymarketForecastContract(schema: Readonly<Record<string, unknown>>, horizonMinutes: number): string {
  return [
    'Answer one row per market of the universe, {id, sigma, drift}, once: the house\'s entry calls no model. For every case it is graded on (a checkpoint `at` and each market\'s Yes price on the 1-minute grid up to `at`), it takes each market\'s last price x and writes, for each minute h = 1 to ' +
      `${horizonMinutes} after \`at\`, the quantiles at the levels ${POLYMARKET_QUANTILES.join(', ')}:`,
    '',
    `    q = clamp(x + drift * h / 60 + z * sigma * sqrt(h), 0, 1), rounded to 6 decimals, z = ${POLYMARKET_Z.map((z) => z.toFixed(6)).join(', ')}`,
    '',
    `sigma is the spread of the price's moves in price units per square-root minute (0 to ${POLYMARKET_SIGMA_MAX}); drift its expected move in price units per hour (-${POLYMARKET_DRIFT_MAX} to ${POLYMARKET_DRIFT_MAX}). ` +
      `With sigma ${POLYMARKET_BASELINE_SIGMA} and drift 0 the entry is the persistence baseline, which every prize must beat. The same sigma and drift apply to every case from the history's cut on, each from its own last price, ` +
      "and each case is scored as the rules say: the pinball loss of each quantile against the market's actual grid price at each minute. Every market of the universe appears exactly once.",
    '',
    'The forecast document, as a JSON schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

/** A price clamped to [0,1] and rounded to 6 decimals (0, never -0): the persistence baseline's rounding, the same expression. */
const price6 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 1e6) / 1e6 + 0;

/**
 * One market's rows: for h = 1..horizon, the quantiles clamp(x + drift*h/60 + z*sigma*sqrt(h), 0, 1) at 6 decimals,
 * in POLYMARKET_Z's order (non-decreasing, as sigma is at least 0). At the baseline's parameters they are the
 * persistence baseline's numbers exactly.
 */
export function polymarketRows(x: number, p: Readonly<PolymarketParams>, horizon: number): number[][] {
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) rows.push(POLYMARKET_Z.map((z) => price6(x + (p.drift * h) / 60 + z * p.sigma * Math.sqrt(h))));
  return rows;
}

/**
 * The <id>.out the house's per-file entry writes for case `c` (grader/house-forecast-entry-cases/main.ts computes the
 * same bytes): {forecasts: each market in the case's order, its rows from its last price}, compact JSON and a newline.
 * A case at or after `historyUntil` (ms: the record's cut) takes `params` for each market it holds (the baseline's for
 * a market it lacks); an earlier case, or `params` null, takes the baseline's for every market, so the entry never
 * applies a forecast made on history after the case's checkpoint.
 */
export function polymarketCaseOutputBytes(c: PolymarketCaseT, params: ReadonlyMap<string, PolymarketParams> | null, historyUntil: number): Uint8Array {
  const apply = params !== null && Date.parse(c.at) >= historyUntil;
  const forecasts = c.markets.map((m) => ({ id: m.id, q: polymarketRows(m.prices.at(-1)!, (apply ? params.get(m.id) : undefined) ?? POLYMARKET_BASELINE_PARAMS, c.horizon_minutes) }));
  return new TextEncoder().encode(`${JSON.stringify({ forecasts })}\n`);
}

/**
 * Why `bytes` is not a valid <id>.out for case `c` (the contest's output contract), or null: at most
 * POLYMARKET_MAX_OUTPUT_BYTES of UTF-8 JSON {forecasts} and no other key, each row exactly {id, q}, every market of the
 * case exactly once and no other id, q exactly horizon_minutes rows of one finite number in [0,1] per level,
 * non-decreasing.
 */
export function polymarketOutputIssue(bytes: Uint8Array, c: PolymarketCaseT): string | null {
  if (bytes.byteLength > POLYMARKET_MAX_OUTPUT_BYTES) return `it is ${bytes.byteLength} bytes, over the ${POLYMARKET_MAX_OUTPUT_BYTES}-byte cap`;
  let doc: unknown;
  try {
    doc = JSON.parse(utf8.decode(bytes));
  } catch {
    return 'it is not UTF-8 JSON';
  }
  if (!isRecord(doc)) return 'it is not a JSON object';
  const top = Object.keys(doc);
  if (top.length !== 1 || top[0] !== 'forecasts') return `its keys are ${JSON.stringify(top)}, not exactly ["forecasts"]`;
  if (!Array.isArray(doc.forecasts)) return 'forecasts is not an array';
  const ids = new Set(c.markets.map((m) => m.id));
  const seen = new Set<string>();
  for (const [k, f] of doc.forecasts.entries()) {
    if (!isRecord(f)) return `forecasts[${k}] is not an object`;
    const keys = Object.keys(f).sort();
    if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'q') return `forecasts[${k}]'s keys are ${JSON.stringify(Object.keys(f))}, not exactly id and q`;
    if (typeof f.id !== 'string' || !ids.has(f.id)) return `forecasts[${k}] names ${JSON.stringify(f.id)}, no market of the case`;
    if (seen.has(f.id)) return `forecasts[${k}] names market ${f.id} a second time`;
    seen.add(f.id);
    if (!Array.isArray(f.q) || f.q.length !== c.horizon_minutes) return `market ${f.id}'s q is not exactly ${c.horizon_minutes} rows`;
    for (const [h, row] of f.q.entries()) {
      if (!Array.isArray(row) || row.length !== POLYMARKET_QUANTILES.length) return `market ${f.id} row ${h} is not ${POLYMARKET_QUANTILES.length} numbers`;
      for (const [j, v] of row.entries()) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return `market ${f.id} row ${h} quantile ${j} is not a finite number in [0,1]`;
        if (j > 0 && v < (row[j - 1] as number)) return `market ${f.id} row ${h} is not non-decreasing`;
      }
    }
  }
  const missing = [...ids].filter((id) => !seen.has(id));
  return missing.length > 0 ? `no forecast for market(s) ${missing.join(', ')}` : null;
}

// ------------------------------------------------------------------ a per-file instance: the GTA VI trophy rarity forecast
//
// gta6-trophy-rarity-forecast-01 (program/v1, `cases: per-file`, each case /input/<id>.in of schema
// makefun/gta6-trophies-case/v1, the bundle's scorer/forecast.ts CASE_SCHEMA). The model is asked ONCE a phase
// (callHouseForecast) for every case it is shown and each of that case's trophies: a median earn rate m (percent) at
// the case's target and a spread s (the standard deviation of the rate's logit there). The house's entry
// (grader/house-forecast-entry-gta6-trophies/main.ts, the same arithmetic) applies that one answer to every case it is
// run on, with no model call, as the rules state it:
//
//   q_tau = 100 / (1 + exp(-(logit(m) + z_tau x s))), rounded to 4 decimals, z = -1.645, -0.674, 0, 0.674, 1.645
//
// logit(x) = ln(c / (100 - c)) of c = x clamped to [0.01, 99.99] (the scorer's clamp, and the persistence baseline's
// expression digit for digit). A case id the answer lacks, or a trophy of a case the answer lacks (one Exophase listed
// after the forecast's cut), takes the persistence baseline's numbers: m the trophy's rate in the case's last read
// (0 where that read lacked it), s 0.5 x sqrt(horizon in days), the kit's starter's bytes exactly. Dev: one call over
// the practice cases. Final: one call on the case cut two hours before the deadline (f00 with the history to the cut,
// its horizon to the contest's target), replayed on f00 as the freeze writes it: the forecast is of the rates at the
// target, which the two cuts share.

/** A trophy case file's schema (the bundle's scorer/forecast.ts CASE_SCHEMA). */
export const GTA6_TROPHIES_CASE_SCHEMA = 'makefun/gta6-trophies-case/v1';
/** The house-built descriptor a trophy instance stands for its task.json with: its sha256 is the record's key. */
export const GTA6_TROPHIES_INSTANCE_SCHEMA = 'makefun/house-forecast/gta6-trophies-instance/v1';
/** The descriptor's `output`: the forecast document the entry applies (each case's own output is <id>.out). */
export const GTA6_TROPHIES_FORECAST_FILE = 'forecast.json';
/** The quantile levels every trophy row forecasts, in order. */
export const GTA6_TROPHIES_LEVELS: readonly number[] = Object.freeze([0.05, 0.25, 0.5, 0.75, 0.95]);
/** The standard normal's quantile at each level: the scorer's Z and the baselines'. */
export const GTA6_TROPHIES_Z: readonly number[] = Object.freeze([-1.645, -0.674, 0, 0.674, 1.645]);
/** The persistence baseline's spread, logit units per square-root day (the starter's SIGMA). */
export const GTA6_TROPHIES_BASELINE_SIGMA = 0.5;
/** The largest spread a forecast may give, logit units (the persistence baseline's over the final's 4.75 days is 1.09). */
export const GTA6_TROPHIES_SPREAD_MAX = 5;
/** A rate is clamped to [GTA6_TROPHIES_RATE_FLOOR, GTA6_TROPHIES_RATE_CEIL] percent before its logit (the scorer's clamp). */
export const GTA6_TROPHIES_RATE_FLOOR = 0.01;
export const GTA6_TROPHIES_RATE_CEIL = 99.99;
/** The largest <id>.out a case may write (the scorer's MAX_FORECAST_BYTES). */
export const GTA6_TROPHIES_MAX_OUTPUT_BYTES = 65_536;
const DAY_MINUTES = 1440;

/** A trophy as a case lists it. */
export interface Gta6Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

/** One read of a case's history: `rates` in the order of the case's trophies, null where that read lacked one. */
export interface Gta6TrophiesRead {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}

/** A trophy case as the house reads it (the fields it uses; the bundle's scorer holds the whole contract). */
export interface Gta6TrophiesCase {
  schema: string;
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Gta6Trophy[];
  history: Gta6TrophiesRead[];
}

const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

/**
 * A case file's bytes (or text) as a trophy case, or a TypeError naming `where` and what is off: UTF-8 JSON of the
 * schema, a string id, `at` and `target` ISO times, horizon_minutes a whole number from 1, the levels
 * GTA6_TROPHIES_LEVELS, at least one trophy, each a whole id from 1 listed once, and every history read's rates one a
 * trophy (a rate from 0 to 100, or null).
 */
export function parseGta6TrophiesCase(bytes: Uint8Array | string, where = 'the case'): Gta6TrophiesCase {
  let doc: unknown;
  try {
    doc = JSON.parse(typeof bytes === 'string' ? bytes : utf8.decode(bytes));
  } catch {
    throw new TypeError(`${where} is not UTF-8 JSON`);
  }
  if (!isRecord(doc) || doc.schema !== GTA6_TROPHIES_CASE_SCHEMA) throw new TypeError(`${where} is not a ${GTA6_TROPHIES_CASE_SCHEMA} case`);
  for (const k of ['id', 'at', 'target']) if (typeof doc[k] !== 'string' || doc[k] === '') throw new TypeError(`${where}'s ${k} is not a string`);
  if (!Number.isFinite(Date.parse(doc.at as string)) || !Number.isFinite(Date.parse(doc.target as string))) throw new TypeError(`${where}'s at or target is not an ISO time`);
  if (!Number.isSafeInteger(doc.horizon_minutes) || (doc.horizon_minutes as number) < 1) throw new TypeError(`${where}'s horizon_minutes is not a whole number from 1`);
  const levels = doc.levels;
  if (!Array.isArray(levels) || levels.length !== GTA6_TROPHIES_LEVELS.length || levels.some((t, j) => t !== GTA6_TROPHIES_LEVELS[j])) throw new TypeError(`${where} asks for levels ${JSON.stringify(levels)}, not ${JSON.stringify(GTA6_TROPHIES_LEVELS)}`);
  const trophies = doc.trophies;
  if (!Array.isArray(trophies) || trophies.length === 0) throw new TypeError(`${where} lists no trophies`);
  const seen = new Set<number>();
  for (const [i, t] of trophies.entries()) {
    if (!isRecord(t) || !Number.isSafeInteger(t.id) || (t.id as number) < 1) throw new TypeError(`${where}'s trophy ${i} has no whole id from 1`);
    if (seen.has(t.id as number)) throw new TypeError(`${where} lists trophy ${String(t.id)} twice`);
    seen.add(t.id as number);
  }
  if (!Array.isArray(doc.history)) throw new TypeError(`${where}'s history is not a list`);
  for (const [i, r] of doc.history.entries()) {
    if (!isRecord(r) || typeof r.slot !== 'string' || !Array.isArray(r.rates) || r.rates.length !== trophies.length || r.rates.some((x) => x !== null && !isRate(x))) {
      throw new TypeError(`${where}'s history read ${i} is not {slot, rates} with one rate (0 to 100, or null) a trophy`);
    }
  }
  return doc as unknown as Gta6TrophiesCase;
}

/** What a trophy instance's descriptor names (gta6TrophiesInstanceBytes). */
export interface Gta6TrophiesInstance {
  competition: string;
  phase: 'dev' | 'final';
  /** The competition's deadline, ISO. */
  deadline: string;
  /** The history cut: the last instant the forecast sees, ISO. */
  history_until: string;
  /** The case ids the model forecasts, in order. */
  cases: string[];
  /** sha256 of the history document's exact bytes (the practice case files in name order, or the final's case cut at history_until). */
  history_sha256: string;
}

/** The descriptor: canonical JSON {schema, competition, phase, deadline, history_until, levels, cases, history_sha256, output} and a newline. */
export function gta6TrophiesInstanceBytes(i: Gta6TrophiesInstance): Uint8Array {
  return new TextEncoder().encode(
    `${canonicalJson({
      schema: GTA6_TROPHIES_INSTANCE_SCHEMA,
      competition: i.competition,
      phase: i.phase,
      deadline: i.deadline,
      history_until: i.history_until,
      levels: [...GTA6_TROPHIES_LEVELS],
      cases: [...i.cases],
      history_sha256: i.history_sha256,
      output: GTA6_TROPHIES_FORECAST_FILE,
    })}\n`,
  );
}

/** A case the forecast is asked for: its id and its trophies' ids, in the case's order. */
export interface Gta6TrophiesAsked {
  id: string;
  trophyIds: readonly number[];
}

/** The cases a forecast is asked for, as gta6TrophiesForecastSchema and parseGta6TrophiesForecast take them. */
export const gta6TrophiesAskedOf = (cases: readonly Pick<Gta6TrophiesCase, 'id' | 'trophies'>[]): Gta6TrophiesAsked[] => cases.map((c) => ({ id: c.id, trophyIds: c.trophies.map((t) => t.id) }));

/**
 * The forecast document's JSON schema for the cases asked: {cases: one row a case, {id (one of the case ids), trophies:
 * one row a trophy of the case, {id (a trophy id), median (0 to 100), spread (0 to GTA6_TROPHIES_SPREAD_MAX)}}}. It holds
 * no uniqueItems (superbot's grammar refuses it: the header's `grammar`): the descriptions say each id comes once, and
 * parseGta6TrophiesForecast refuses a repeated one.
 */
export function gta6TrophiesForecastSchema(asked: readonly Gta6TrophiesAsked[]): Record<string, unknown> {
  const n = asked.length;
  const counts = asked.map((c) => c.trophyIds.length);
  const trophyIds = [...new Set(asked.flatMap((c) => c.trophyIds))].sort((a, b) => a - b);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['cases'],
    properties: {
      cases: {
        type: 'array',
        minItems: n,
        maxItems: n,
        description: `One row per case: each of its ${n} case ids exactly once, no id twice.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'trophies'],
          properties: {
            id: { type: 'string', enum: asked.map((c) => c.id), description: 'The case id, as the history names it.' },
            trophies: {
              type: 'array',
              minItems: Math.min(...counts),
              maxItems: Math.max(...counts),
              description: "One row per trophy of the case: each of the case's trophy ids exactly once, no id twice.",
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'median', 'spread'],
                properties: {
                  id: { type: 'integer', enum: trophyIds, description: "The trophy's id, as the case's trophies list names it." },
                  median: { type: 'number', minimum: 0, maximum: 100, description: "The median of the trophy's earn rate at the case's target, in percent of the players Exophase tracks (the last read's rate is the persistence baseline's)." },
                  spread: {
                    type: 'number',
                    minimum: 0,
                    maximum: GTA6_TROPHIES_SPREAD_MAX,
                    description: `The standard deviation of the rate's logit at the target, in logit units, around the median (the persistence baseline's is ${GTA6_TROPHIES_BASELINE_SIGMA} x sqrt(the horizon in days)).`,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

/** One trophy's recorded parameters: its median rate at the target (percent) and its logit spread. */
export interface Gta6TrophyParams {
  median: number;
  spread: number;
}

/**
 * A forecast document's bytes for the cases asked (the house's own parse: the bundle's scorer reads the cases' <id>.out,
 * not this): UTF-8 JSON exactly {cases}, each row exactly {id, trophies}, the id one of the cases asked and never twice,
 * each trophy row exactly {id, median, spread}, every trophy of its case once and no other, median a finite number from
 * 0 to 100, spread one from 0 to GTA6_TROPHIES_SPREAD_MAX, every case asked present. The parameters by case id and
 * trophy id, or why not.
 */
export function parseGta6TrophiesForecast(bytes: Uint8Array, asked: readonly Gta6TrophiesAsked[]): { ok: true; params: Map<string, Map<number, Gta6TrophyParams>> } | { ok: false; why: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(utf8.decode(bytes));
  } catch {
    return { ok: false, why: 'the forecast is not UTF-8 JSON' };
  }
  if (!isRecord(doc)) return { ok: false, why: 'the forecast is not a JSON object' };
  const top = Object.keys(doc);
  if (top.length !== 1 || top[0] !== 'cases') return { ok: false, why: `the forecast's keys are ${JSON.stringify(top)}, not exactly ["cases"]` };
  if (!Array.isArray(doc.cases)) return { ok: false, why: 'cases is not an array' };
  const wanted = new Map(asked.map((c) => [c.id, c.trophyIds]));
  const params = new Map<string, Map<number, Gta6TrophyParams>>();
  for (const [k, row] of doc.cases.entries()) {
    if (!isRecord(row)) return { ok: false, why: `cases[${k}] is not an object` };
    const keys = Object.keys(row).sort();
    if (keys.join(',') !== 'id,trophies') return { ok: false, why: `cases[${k}]'s keys are ${JSON.stringify(Object.keys(row))}, not exactly id and trophies` };
    const id = row.id;
    const ids = typeof id === 'string' ? wanted.get(id) : undefined;
    if (typeof id !== 'string' || ids === undefined) return { ok: false, why: `cases[${k}] names ${JSON.stringify(id)}, no case asked` };
    if (params.has(id)) return { ok: false, why: `cases[${k}] names case ${id} a second time` };
    if (!Array.isArray(row.trophies)) return { ok: false, why: `case ${id}'s trophies is not an array` };
    const own = new Set(ids);
    const byTrophy = new Map<number, Gta6TrophyParams>();
    for (const [j, t] of row.trophies.entries()) {
      if (!isRecord(t)) return { ok: false, why: `case ${id}'s trophies[${j}] is not an object` };
      const tk = Object.keys(t).sort();
      if (tk.join(',') !== 'id,median,spread') return { ok: false, why: `case ${id}'s trophies[${j}]'s keys are ${JSON.stringify(Object.keys(t))}, not exactly id, median and spread` };
      const { id: trophy, median, spread } = t;
      if (typeof trophy !== 'number' || !own.has(trophy)) return { ok: false, why: `case ${id}'s trophies[${j}] names ${JSON.stringify(trophy)}, no trophy of the case` };
      if (byTrophy.has(trophy)) return { ok: false, why: `case ${id} names trophy ${trophy} a second time` };
      if (!isRate(median)) return { ok: false, why: `case ${id}'s trophy ${trophy}'s median ${JSON.stringify(median)} is not a number from 0 to 100` };
      if (typeof spread !== 'number' || !Number.isFinite(spread) || spread < 0 || spread > GTA6_TROPHIES_SPREAD_MAX) return { ok: false, why: `case ${id}'s trophy ${trophy}'s spread ${JSON.stringify(spread)} is not a number from 0 to ${GTA6_TROPHIES_SPREAD_MAX}` };
      byTrophy.set(trophy, { median, spread });
    }
    const lacking = ids.filter((t) => !byTrophy.has(t));
    if (lacking.length > 0) return { ok: false, why: `case ${id} has no row for trophy(s) ${lacking.join(', ')}` };
    params.set(id, byTrophy);
  }
  const missing = asked.filter((c) => !params.has(c.id)).map((c) => c.id);
  if (missing.length > 0) return { ok: false, why: `no row for case(s) ${missing.join(', ')}` };
  return { ok: true, params };
}

/** The output contract the prompt states: what the document is, how the entry applies it, then the schema. */
export function gta6TrophiesForecastContract(schema: Readonly<Record<string, unknown>>): string {
  return [
    "Answer one row per case, {id, trophies}, and in it one row per trophy of the case, {id, median, spread}, once: the house's entry calls no model. For every case it is graded on, it writes for each trophy the quantiles at the levels 0.05, 0.25, 0.5, 0.75 and 0.95 of the trophy's earn rate at the case's target, in percent:",
    '',
    `    q = 100 / (1 + exp(-(logit(median) + z x spread))), rounded to 4 decimals, z = ${GTA6_TROPHIES_Z.join(', ')}, logit(x) = ln(c / (100 - c)) of c = x clamped to [${GTA6_TROPHIES_RATE_FLOOR}, ${GTA6_TROPHIES_RATE_CEIL}]`,
    '',
    `median is the trophy's median earn rate at the target (0 to 100 percent); spread the standard deviation of its logit there (0 to ${GTA6_TROPHIES_SPREAD_MAX} logit units). ` +
      `With every median the trophy's rate in the case's last read and every spread ${GTA6_TROPHIES_BASELINE_SIGMA} x sqrt(the horizon in days) the entry is the persistence baseline, which every prize must beat. ` +
      "Each case is scored as the rules say: the pinball loss on the logit scale of each quantile against the trophy's rate in the read that answers the case. A final forecast is made two hours before the deadline and replayed on the final's case f00, whose target is the same: forecast the rates at the target the case names. Every case asked, and every trophy of each, appears exactly once.",
    '',
    'The forecast document, as a JSON schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

const trophyCell = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
const rateCell = (r: number | null): string => (r === null ? '-' : JSON.stringify(r));
const sameRead = (a: Gta6TrophiesRead, b: Gta6TrophiesRead): boolean => a.players_tracked === b.players_tracked && a.trophies_earned === b.trophies_earned && a.rates.length === b.rates.length && a.rates.every((r, i) => r === b.rates[i]);

/** The reads a case's compact history shows: all of them, or those whose slot is in the last `lastHours` hours before its checkpoint. */
export function gta6TrophiesReadsShown(c: Pick<Gta6TrophiesCase, 'at' | 'history'>, lastHours?: number): Gta6TrophiesRead[] {
  if (lastHours === undefined) return c.history;
  const from = Date.parse(c.at) - lastHours * HOUR_MS;
  return c.history.filter((r) => Date.parse(r.slot) >= from);
}

/**
 * The cases as the prompt gives them: for each case a line naming its id, checkpoint, target and horizon; its trophies
 * (id, tier, points, whether PSN hides it, name and description; a later case listing the same trophies says so instead
 * of listing them again); then its reads, oldest first, each `slot<TAB>players_tracked<TAB>trophies_earned<TAB>` and the
 * rates in the trophies' order (`-` where the read lacked one), a run of reads equal to the one before shown as one line
 * naming the run. `lastHours` keeps only the reads of the last that many hours before each checkpoint; undefined keeps
 * every read (the rules': every read recorded to the cut).
 */
export function compactGta6TrophiesHistory(cases: readonly Gta6TrophiesCase[], lastHours?: number): string {
  if (lastHours !== undefined && (!Number.isSafeInteger(lastHours) || lastHours < 1)) throw new RangeError(`lastHours is a whole number from 1, got ${lastHours}`);
  const lines: string[] = [
    "Exophase's earn rates for Grand Theft Auto VI's PS5 trophies as the house recorded them: a rate is the percent of the players Exophase tracks for the game who have earned the trophy, to 2 decimals. " +
      `For each case: its id, its checkpoint (at: the history holds the reads before it), its target (the instant forecast) and its horizon; its trophies as id<TAB>tier<TAB>points<TAB>hidden<TAB>name<TAB>description; then its reads${lastHours === undefined ? '' : ` of the last ${lastHours} hours before the checkpoint`}, oldest first, ` +
      'as slot<TAB>players_tracked<TAB>trophies_earned<TAB>the rates in the order of the trophies (- where the read lacked one); a run of reads equal to the one before is one line "<first slot> to <last slot><TAB>unchanged (<n> reads)".',
  ];
  let prev: Gta6TrophiesCase | null = null;
  for (const c of cases) {
    const shown = gta6TrophiesReadsShown(c, lastHours);
    lines.push('', `case ${trophyCell(c.id)}\tat ${c.at}\ttarget ${c.target}\thorizon ${c.horizon_minutes} minutes\t${shown.length === c.history.length ? `${c.history.length} reads` : `the last ${shown.length} of ${c.history.length} reads`}`);
    if (prev !== null && JSON.stringify(prev.trophies) === JSON.stringify(c.trophies)) lines.push(`trophies: the ${c.trophies.length} of case ${trophyCell(prev.id)}, in the same order`);
    else {
      lines.push(`trophies: ${c.trophies.length}`);
      for (const t of c.trophies) lines.push(`${t.id}\t${trophyCell(String(t.tier))}\t${t.points}\t${t.secret ? 'hidden' : 'shown'}\t${trophyCell(String(t.name))}\t${trophyCell(String(t.description))}`);
    }
    lines.push('reads:');
    for (let i = 0; i < shown.length; ) {
      const r = shown[i]!;
      lines.push(`${r.slot}\t${r.players_tracked}\t${r.trophies_earned}\t${r.rates.map(rateCell).join(' ')}`);
      let j = i + 1;
      while (j < shown.length && sameRead(shown[j]!, r)) j++;
      if (j - i > 1) lines.push(`${shown[i + 1]!.slot} to ${shown[j - 1]!.slot}\tunchanged (${j - i - 1} reads)`);
      i = j;
    }
    prev = c;
  }
  return `${lines.join('\n')}\n`;
}

/** A rate's logit, clamped first: the persistence baseline's expression (ln(c / (100 - c))) digit for digit. */
const trophyLogit = (pct: number): number => {
  const c = Math.min(GTA6_TROPHIES_RATE_CEIL, Math.max(GTA6_TROPHIES_RATE_FLOOR, pct));
  return Math.log(c / (100 - c));
};
/** x rounded to 4 decimals: the persistence baseline's round4. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** One trophy's five quantiles from its parameters: 100 / (1 + exp(-(logit(m) + z s))) at 4 decimals, non-decreasing. */
export function gta6TrophyQuantiles(p: Readonly<Gta6TrophyParams>): number[] {
  const l = trophyLogit(p.median);
  return GTA6_TROPHIES_Z.map((z) => round4(100 / (1 + Math.exp(-(l + z * p.spread)))));
}

/** The persistence baseline's parameters of trophy `i` of case `c`: its rate in the last read (0 where it lacked one), 0.5 x sqrt(the horizon in days). */
export function gta6TrophyBaselineParams(c: Pick<Gta6TrophiesCase, 'horizon_minutes' | 'history'>, i: number): Gta6TrophyParams {
  const last = c.history.at(-1);
  if (last === undefined) throw new TypeError('the case has no history: the persistence baseline has no last rate');
  return { median: last.rates[i] ?? 0, spread: GTA6_TROPHIES_BASELINE_SIGMA * Math.sqrt(c.horizon_minutes / DAY_MINUTES) };
}

/**
 * The <id>.out the house's entry writes for case `c` (grader/house-forecast-entry-gta6-trophies/main.ts computes the
 * same bytes): {trophies: each of the case's trophies in its order, {id, q}} compact JSON and a newline, each trophy's
 * parameters `params`' row for the case id and trophy id, else the persistence baseline's (params null, a case id it
 * lacks, a trophy it lacks). With params null the bytes are the kit's starter's. A trophy left to the baseline in a case
 * with no history throws (the starter has no output for it either).
 */
export function gta6TrophiesCaseOutputBytes(c: Gta6TrophiesCase, params: ReadonlyMap<string, ReadonlyMap<number, Gta6TrophyParams>> | null): Uint8Array {
  const own = params?.get(c.id);
  const trophies = c.trophies.map((t, i) => ({ id: t.id, q: gta6TrophyQuantiles(own?.get(t.id) ?? gta6TrophyBaselineParams(c, i)) }));
  return new TextEncoder().encode(`${JSON.stringify({ trophies })}\n`);
}

// ------------------------------------------------------------------ the prompt and the request

/** The two messages one call sends. */
export interface HouseForecastPrompt {
  system: string;
  user: string;
}

/** The prompt of one instance (the header): the rules, task.json, the output contract and the history, under headings, then the answer line. */
export function houseForecastPrompt(input: HouseForecastInput): HouseForecastPrompt {
  const task = houseForecastTaskOf(input.task);
  const user = [
    '## The competition rules',
    '',
    input.rules.trim(),
    '',
    `## ${input.taskHeading ?? 'task.json'}`,
    '',
    task.text.trim(),
    '',
    '## The output contract',
    '',
    input.contract.trim(),
    '',
    '## The history',
    '',
    input.history.trimEnd(),
    '',
    HOUSE_FORECAST_ANSWER_LINE,
  ].join('\n');
  return { system: input.system ?? HOUSE_FORECAST_SYSTEM, user };
}

/** The prompt as stored: canonical JSON {system, user}, UTF-8. Its sha256 is the record's prompt_sha256. */
export function houseForecastPromptBytes(prompt: HouseForecastPrompt): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ system: prompt.system, user: prompt.user }));
}

/** The forced (or offered) tool: the output schema as its parameters. */
function forecastTool(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { type: 'function', function: { name: HOUSE_FORECAST_TOOL, description: HOUSE_FORECAST_TOOL_DESCRIPTION, parameters: schema } };
}

/**
 * The keywords superbot's json_schema grammar refuses (the header's `grammar`), each with what its node's description
 * says instead (null: nothing to say, as uniqueItems false asks nothing). Only a keyword masq has refused goes here.
 */
export const SUPERBOT_GRAMMAR_REFUSED: Readonly<Record<string, (value: unknown) => string | null>> = Object.freeze({
  uniqueItems: (v: unknown) => (v === true ? 'Its items are distinct: no value appears twice.' : null),
});

/** The keywords whose value is a map of schemas, a schema, or a list of schemas: where a schema's nodes are. */
const SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_ONE_KEYS: ReadonlySet<string> = new Set(['items', 'additionalItems', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties']);
const SCHEMA_LIST_KEYS: ReadonlySet<string> = new Set(['items', 'prefixItems', 'anyOf', 'allOf', 'oneOf']);
/** The deepest node superbotGrammarSchemaOf walks: an output schema is a few levels deep. */
const GRAMMAR_SCHEMA_DEPTH = 64;

function grammarNode(node: unknown, depth: number): unknown {
  if (node === null || typeof node !== 'object' || Array.isArray(node) || depth > GRAMMAR_SCHEMA_DEPTH) return node;
  const out: Record<string, unknown> = {};
  const notes: string[] = [];
  let changed = false;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const refused = Object.hasOwn(SUPERBOT_GRAMMAR_REFUSED, k) ? SUPERBOT_GRAMMAR_REFUSED[k] : undefined;
    if (refused !== undefined) {
      const note = refused(v);
      if (note !== null) notes.push(note);
      changed = true;
      continue;
    }
    let kept: unknown = v;
    if (SCHEMA_LIST_KEYS.has(k) && Array.isArray(v)) {
      const list = v.map((s) => grammarNode(s, depth + 1));
      if (list.some((s, i) => s !== v[i])) kept = list;
    } else if (SCHEMA_MAP_KEYS.has(k) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>).map(([n, s]) => [n, grammarNode(s, depth + 1), s] as const);
      if (entries.some(([, t, s]) => t !== s)) kept = Object.fromEntries(entries.map(([n, t]) => [n, t]));
    } else if (SCHEMA_ONE_KEYS.has(k)) kept = grammarNode(v, depth + 1);
    if (kept !== v) changed = true;
    out[k] = kept;
  }
  if (!changed) return node;
  if (notes.length > 0) {
    const note = notes.join(' ');
    // In the description's own place when the node has one, else last.
    out.description = typeof out.description === 'string' && out.description !== '' ? `${out.description} ${note}` : note;
  }
  return out;
}

/**
 * `schema` as superbot's json_schema grammar takes it (the header's `grammar`): every node's SUPERBOT_GRAMMAR_REFUSED
 * keyword left out and said in its description instead, every other key in its place. A schema that holds none is
 * returned as it is, the same object, so its request is the bytes it always was.
 */
export function superbotGrammarSchemaOf(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return grammarNode(schema, 0) as Readonly<Record<string, unknown>>;
}

/**
 * The chat-completions body of one request (deterministic: the same input gives the same bytes): the two messages,
 * max_tokens, reasoning_effort when the agent names one (SUPERBOT_UNNAMED_EFFORT, none, on the superbot family
 * otherwise, so a stored record that named none rebuilds byte for byte), then by form (judge-call.ts's forms): `answer`
 * asks for a JSON object (the superbot family: a non-strict json_schema of `schema` as its grammar takes it,
 * superbotGrammarSchemaOf), `tool` forces the
 * named forecast tool, `answer_plain` adds nothing, `tool_auto` offers the tool with tool_choice auto. `dialect`
 * `messages` is the body the Messages request is made of (the header's `dialect`): its `answer` asks `schema` of every
 * model.
 */
export function houseForecastRequestBody(
  agent: HouseForecastAgent,
  prompt: HouseForecastPrompt,
  form: JudgeForm,
  schema: Readonly<Record<string, unknown>> = HOUSE_FORECAST_DEFAULT_SCHEMA,
  dialect: MasqDialect = 'chat',
): Record<string, unknown> {
  const superbot = masqSkipsJsonMode(agent.model);
  const effort = agent.reasoning_effort ?? (superbot ? SUPERBOT_UNNAMED_EFFORT : undefined);
  const base: Record<string, unknown> = {
    model: agent.model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    max_tokens: agent.max_output_tokens,
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
  };
  if (form === 'tool') return { ...base, tools: [forecastTool(schema)], tool_choice: { type: 'function', function: { name: HOUSE_FORECAST_TOOL } } };
  if (form === 'tool_auto') return { ...base, tools: [forecastTool(schema)], tool_choice: 'auto' };
  if (form === 'answer_plain') return base;
  if (superbot) return { ...base, response_format: { type: 'json_schema', json_schema: { name: HOUSE_FORECAST_TOOL, strict: false, schema: superbotGrammarSchemaOf(schema) } } };
  return { ...base, response_format: dialect === 'messages' ? { type: 'json_schema', json_schema: { name: HOUSE_FORECAST_TOOL, strict: false, schema } } : { type: 'json_object' } };
}

/** The request one attempt sends masq (the header's `dialect`): on Messages when the dialect can say it, else houseForecastRequestBody's on Chat Completions. */
export function houseForecastWire(agent: HouseForecastAgent, prompt: HouseForecastPrompt, form: JudgeForm, schema: Readonly<Record<string, unknown>> = HOUSE_FORECAST_DEFAULT_SCHEMA): MasqWire {
  return masqWire(houseForecastRequestBody(agent, prompt, form, schema), houseForecastRequestBody(agent, prompt, form, schema, 'messages'));
}

/** The dialect an attempt went in: masq's two (MasqDialect), or superbot-router's own two (ROUTER_DIALECT on Chat Completions, ROUTER_MESSAGES_DIALECT on Messages: the header's `router`). */
export type HouseForecastDialect = MasqDialect | typeof ROUTER_DIALECT | typeof ROUTER_MESSAGES_DIALECT;

/** One request as sent: its dialect, its path on the upstream, and its body text (the bytes request_sha256 names). */
export interface HouseForecastWire {
  dialect: HouseForecastDialect;
  path: string;
  body: string;
}

/** The request one attempt sends superbot-router (the header's `router`): houseForecastRequestBody's Chat Completions body, streamed, on Messages where it maps (routerWire). */
export function houseForecastRouterWire(agent: HouseForecastAgent, prompt: HouseForecastPrompt, form: JudgeForm, schema: Readonly<Record<string, unknown>> = HOUSE_FORECAST_DEFAULT_SCHEMA): HouseForecastWire {
  return routerWire(houseForecastRequestBody(agent, prompt, form, schema));
}

/**
 * The bytes a recorded attempt sent, rebuilt in its own dialect (its `dialect`, absent `chat`): what its request_sha256
 * names. Null when the request cannot be said on Messages.
 */
export function houseForecastRequestJson(
  dialect: HouseForecastDialect,
  agent: HouseForecastAgent,
  prompt: HouseForecastPrompt,
  form: JudgeForm,
  schema: Readonly<Record<string, unknown>> = HOUSE_FORECAST_DEFAULT_SCHEMA,
): string | null {
  if (dialect === 'chat') return JSON.stringify(houseForecastRequestBody(agent, prompt, form, schema));
  if (dialect === ROUTER_DIALECT || dialect === ROUTER_MESSAGES_DIALECT) return routerRequestJsonIn(dialect, houseForecastRequestBody(agent, prompt, form, schema));
  return masqMessagesBody(houseForecastRequestBody(agent, prompt, form, schema, 'messages'));
}

// ------------------------------------------------------------------ the preflight

/** Why a call does not start: its model is unpriced. No dollar figure holds one (the header's `preflight`). */
export interface HouseForecastHold {
  kind: 'unpriced';
  /** What holds it, in an admin's words. */
  why: string;
}

/** The preflight's figures (µUSD), recorded; none of them is weighed against a cap. */
export interface HouseForecastBudget {
  /** HOUSE_FORECAST_ATTEMPTS: the most requests the call sends. */
  requests: number;
  /** The largest body any form sends, bytes. */
  bodyBytes: number;
  /** ceil(bodyBytes / 3): the input tokens the worst case bills. */
  inputTokens: number;
  /** worstCaseMicroUsd of the largest body and max_output_tokens; null for an unpriced model. */
  requestMicroUsd: bigint | null;
  /** requests × requestMicroUsd; null for an unpriced model. */
  worstMicroUsd: bigint | null;
}

const ALL_FORMS: readonly JudgeForm[] = [...JUDGE_FORCED_FORMS, ...JUDGE_UNFORCED_FORMS];

/**
 * The call's worst case (the header): HOUSE_FORECAST_ATTEMPTS requests, each at the largest body any form sends on any
 * route the model may take (masq's dialects, and superbot-router's streamed body for a model routerServesModel names:
 * the route is known only once the key is minted). The hold when the model is unpriced; null otherwise, whatever the
 * worst case comes to.
 */
export function houseForecastPreflight(input: {
  agent: HouseForecastAgent;
  prompt: HouseForecastPrompt;
  schema?: Readonly<Record<string, unknown>>;
  /** The pricing instant, ISO 8601. */
  at: string;
}): { budget: HouseForecastBudget; hold: HouseForecastHold | null } {
  // Every dialect's body, whichever is larger (a superbot request has Chat's, and the router's when it may go there).
  const routed = routerServesModel(input.agent.model);
  const bodyBytes = Math.max(
    ...ALL_FORMS.flatMap((form) => [
      Buffer.byteLength(JSON.stringify(houseForecastRequestBody(input.agent, input.prompt, form, input.schema))),
      Buffer.byteLength(houseForecastWire(input.agent, input.prompt, form, input.schema).body),
      ...(routed ? [Buffer.byteLength(houseForecastRouterWire(input.agent, input.prompt, form, input.schema).body)] : []),
    ]),
  );
  const budget: HouseForecastBudget = { requests: HOUSE_FORECAST_ATTEMPTS, bodyBytes, inputTokens: 0, requestMicroUsd: null, worstMicroUsd: null };
  let one: bigint;
  try {
    const worst = worstCaseMicroUsd({ model: input.agent.model, at: input.at, body_bytes: bodyBytes, output_tokens: input.agent.max_output_tokens });
    budget.inputTokens = worst.input_estimate;
    one = worst.micro_usd;
  } catch (err) {
    return { budget, hold: { kind: 'unpriced', why: `the model ${input.agent.model} cannot be priced (${err instanceof Error ? err.message : String(err)}), so neither the record nor the key's retirement could be metered` } };
  }
  budget.requestMicroUsd = one;
  budget.worstMicroUsd = one * BigInt(HOUSE_FORECAST_ATTEMPTS);
  return { budget, hold: null };
}

// ------------------------------------------------------------------ the record

const MicroUsd = z.string().regex(/^(0|[1-9][0-9]*)$/, 'expected µUSD as a decimal string');

/** One request of the call. */
export const HouseForecastAttempt = z.strictObject({
  form: z.enum(['answer', 'tool', 'answer_plain', 'tool_auto']),
  /** `messages`: sent on masq's Messages route (the header's `dialect`); `router` / `router-messages`: sent to superbot-router, streamed, on Chat Completions / Messages (the header's `router`); absent, on masq's Chat Completions. */
  dialect: z.union([z.literal('messages'), z.literal(ROUTER_DIALECT), z.literal(ROUTER_MESSAGES_DIALECT)]).optional(),
  /** sha256 of the exact body bytes sent (houseForecastRequestJson in the attempt's dialect). */
  request_sha256: Sha256Hex,
  request_bytes: z.int().min(0),
  /** When it was sent: its pricing instant. */
  at: IsoDateTime,
  status: z.int(),
  /** sha256 of the response body: the blob it was stored as, before it was read. */
  response_body_sha256: Sha256Hex,
  /** The completion's `model`, else x-masq-model (a model masq swapped in by its header first); null when neither names one. */
  model_answered: z.string().nullable(),
  finish_reason: z.string().nullable(),
  usage: CassetteUsage.nullable(),
  /** Its price (priceUsage at `at`); '0' for a refused status with no usage; null when a 2xx answer carried no usage it could be priced by. */
  micro_usd: MicroUsd.nullable(),
  /** Why it gave no valid forecast; null for the one that did. */
  invalid: z.string().nullable(),
});
export type HouseForecastAttemptT = z.infer<typeof HouseForecastAttempt>;

/** The forecast an answer held, as the record names it. */
export const HouseForecastKept = z.strictObject({
  /** The attempt it came from, from 1. */
  attempt: z.int().min(1).max(HOUSE_FORECAST_ATTEMPTS),
  sha256: Sha256Hex,
  bytes: z.int().min(0),
  /** Whether the caller's validate (the bundle's own scorer parse) took it. */
  valid: z.boolean(),
  /** Why it did not; null when valid. */
  why: z.string().nullable(),
});

export const HouseForecastRecord = z
  .strictObject({
    schema: z.literal(HOUSE_FORECAST_RECORD_SCHEMA),
    competition: z.string().min(1),
    phase: z.enum(['dev', 'final', 'local']),
    /** sha256 of the instance's exact task.json bytes: the record's key and the forecast's file name. */
    task_sha256: Sha256Hex,
    /** The file name task.json's `output` gives: where the entry writes the forecast. */
    output: z.string().regex(OUTPUT_NAME),
    model: z.string().min(1),
    max_output_tokens: z.int().min(1),
    reasoning_effort: z.enum(REASONING_EFFORTS).nullable(),
    /** sha256 of houseForecastPromptBytes: the prompt blob. */
    prompt_sha256: Sha256Hex,
    rules_sha256: Sha256Hex,
    contract_sha256: Sha256Hex,
    history_sha256: Sha256Hex,
    /** The output schema the answer and tool forms were sent with (canonical JSON), by sha256. */
    schema_sha256: Sha256Hex,
    /**
     * The preflight's figures, µUSD as decimal strings. cap_micro_usd is a record's from before house-paid judging lost
     * its spend cap (the owner, 2026-11-11): the per-call cap it was held to then; a new record names none.
     */
    budget: z.strictObject({
      requests: z.int().min(1),
      body_bytes: z.int().min(0),
      input_tokens: z.int().min(0),
      request_micro_usd: MicroUsd,
      worst_micro_usd: MicroUsd,
      cap_micro_usd: MicroUsd.optional(),
    }),
    /**
     * The key the call was sent on, never its secret. daily_limit_usd is a record's from before, its key's masq cap then;
     * a new record's key has none.
     */
    key: z.strictObject({ id: z.string().min(1), label: z.string().min(1), daily_limit_usd: z.number().optional(), expires_at: IsoDateTime }),
    attempts: z.array(HouseForecastAttempt).min(1).max(HOUSE_FORECAST_ATTEMPTS),
    /** The response blob the forecast came from (the last attempt's when none held one). */
    response_sha256: Sha256Hex,
    /** Every attempt's usage summed; null when none carried any. */
    usage: CassetteUsage.nullable(),
    /** Every attempt's price summed, µUSD: the meter the key was retired against. */
    cost_micro_usd: MicroUsd,
    /** pricing/price.ts pricingRev: the rows every figure was priced under. */
    pricing_rev: Sha256Hex,
    /** masq's settled spend on the key once retired; null when the retirement failed (retire_error says why). */
    masq_spend: z.strictObject({ micro_usd: MicroUsd, settled: z.boolean(), mismatch: z.boolean(), flags: z.array(z.string()) }).nullable(),
    retire_error: z.string().nullable(),
    forecast: HouseForecastKept.nullable(),
    created_at: IsoDateTime,
    /** A per-file instance's (HouseForecastPerCase); absent on a task.json instance's record, as on every record from before. */
    per_case: z
      .strictObject({
        /** The history cut (the descriptor's history_until): the entry applies the forecast to a case at or after it, the baseline's parameters to an earlier one. */
        history_until: IsoDateTime,
        /** The universe's market ids the forecast was asked for, in its order. */
        markets: z.array(z.string().min(1)).min(1),
        /** The history document the compact history was built from (a practice case file, or the final's backfill cut at history_until), stored as a blob: its sha256 and size. */
        source_sha256: Sha256Hex,
        source_bytes: z.int().min(0),
        /**
         * The per-file kind when it is not Polymarket's: 'twitch-ccu' (its markets are the case ids; its template
         * HOUSE_ENTRY_TWITCH_CCU_TEMPLATE_DIR) or 'gta6-trophies' (its markets are the case ids; its template
         * HOUSE_ENTRY_GTA6_TROPHIES_TEMPLATE_DIR). Absent: a Polymarket instance, as every record from before.
         */
        kind: z.enum(['twitch-ccu', 'gta6-trophies']).optional(),
      })
      .optional(),
  })
  .refine((r) => r.forecast === null || r.forecast.attempt <= r.attempts.length, { message: "the forecast's attempt is one of the record's", path: ['forecast', 'attempt'] });

/** What a per-file instance's record names beside the rest (the record's per_case). */
export type HouseForecastPerCase = NonNullable<z.infer<typeof HouseForecastRecord>['per_case']>;
export type HouseForecastRecordT = z.infer<typeof HouseForecastRecord>;

/** A record as written: its canonical JSON and a newline, checked first. */
export function houseForecastRecordBytes(record: HouseForecastRecordT): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(HouseForecastRecord.parse(record))}\n`);
}

// ------------------------------------------------------------------ the call

/** What the caller's validate answers: the bundle's own scorer parse, run on the forecast's bytes. */
export type HouseForecastValidation = { ok: true } | { ok: false; why: string };
export type HouseForecastValidate = (bytes: Uint8Array) => HouseForecastValidation;

/** The upstream a house forecast call goes to: masq, or superbot-router dialled directly (the header's `router`). */
export type HouseForecastUpstream = 'masq' | 'superbot-router';

/**
 * masq (superbot-router on a router key) unreachable, an answer whose body could not be read, a status that is no
 * answer, a router stream that faulted, or a router key whose card cannot hold the budget: the platform's failure. No
 * record is made.
 */
export class HouseForecastFault extends Error {
  /** The status the upstream answered; null when no answer was read. */
  readonly status: number | null;
  /** The attempts that completed before the fault (each priced, its body stored). */
  readonly attempts: readonly HouseForecastAttemptT[];
  /** The upstream that faulted (default masq). */
  readonly upstream: HouseForecastUpstream;
  /** What an operator does about it when a run again will not (a router key's output ceiling); null otherwise. */
  readonly fix: string | null;
  /** The key retired against their meter; null until retired, or when the retirement failed too. */
  retired: RetiredTrialKey | null = null;
  constructor(message: string, status: number | null, attempts: readonly HouseForecastAttemptT[], options?: { cause?: unknown; upstream?: HouseForecastUpstream; fix?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HouseForecastFault';
    this.status = status;
    this.attempts = attempts;
    this.upstream = options?.upstream ?? 'masq';
    this.fix = options?.fix ?? null;
  }
}

export interface HouseForecastCallOptions {
  /** Where the key is minted: masq's judge-key broker, or server/superbot-router.ts judgeKeyBroker's (a key it mints at the router is a RouterJudgeKey: routerOfKey). */
  broker: MasqJudgeKeyBroker;
  /** The competition's slug: the key's label. */
  slug: string;
  /** The instance's phase: the key's label. */
  phase: JudgeKeyPhase;
  /** The key's nth try for the phase, from 1 (default 1): a re-run after a fault mints anew under the next. */
  attempt?: number;
  /** The model flags (houseForecastAgent fills the defaults). */
  agent?: Partial<HouseForecastAgent>;
  input: HouseForecastInput;
  /** The forecast's JSON schema: the forced tool's parameters and the superbot family's json_schema (default a JSON object). */
  outputSchema?: Readonly<Record<string, unknown>>;
  /** The bundle's own scorer parse on the forecast's bytes (a per-file instance's: parsePolymarketForecast). A validate that throws is read as refusing it. */
  validate: HouseForecastValidate;
  /** A per-file instance's history cut, markets and history document (the record's per_case); absent for a task.json instance. */
  perCase?: HouseForecastPerCase;
  /** Where the prompt and every response body are stored (server/blobstore.ts BlobStore fits). */
  blobs: JudgeBlobs;
  fetch?: typeof fetch;
  /** Each request's bound, ms (default MASQ_TIMEOUT_MS); on a router key its head's alone (the header's `router`). */
  timeoutMs?: number;
  /** The clock (ms), default Date.now. */
  now?: () => number;
  /** The wait before a fresh key's 401, or the router's one named wait (the header's `router`), is re-sent, default a timer; it rejects when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  signal?: AbortSignal;
  /** Where a scope refusal's `[model-key] ALERT: ` page goes (default console.error: the alert forwarder reads stderr). */
  page?: (line: string) => void;
  /** Where a router call's one served line goes (the header's `router`), default console.warn (a report, not an error: server/ops/errors.ts counts every console.error as a server error). */
  log?: (line: string) => void;
}

/**
 * The scope page's words for a house forecast key masq refuses its model (the header's `scope`, server/house-model.ts
 * watchMasqScope): what fails, the key, and the episode every forecast's minted key shares, so one refused mint
 * configuration pages once, not once a forecast.
 */
const FORECAST_SCOPE_FAILS = 'the house forecast (each call faults with HTTP 403, so no forecast contest gets its house entry)';
const FORECAST_SCOPE_KEYS = "the house forecast key minted per call, makefun/<slug>/judge/<phase>/<attempt>: its allowedModels are grader/gateway/masq.ts judgeKeyRequest's";
/** The key a router call's scope page names: superbot-router's one static key (the header's `router`). */
const FORECAST_ROUTER_SCOPE_KEYS = 'MAKEFUN_SUPERBOT_ROUTER_KEY';
const FORECAST_SCOPE_EPISODE = 'minted house forecast keys';

export type HouseForecastOutcome =
  | { held: HouseForecastHold; budget: HouseForecastBudget }
  | {
      held: null;
      record: HouseForecastRecordT;
      /** The forecast's bytes (record.forecast names them); null when no answer held any. */
      forecast: Uint8Array | null;
      prompt: HouseForecastPrompt;
      budget: HouseForecastBudget;
      /** The key retired against the meter; null when the retirement failed (record.retire_error). */
      retired: RetiredTrialKey | null;
    };

/** A forecast an answer held. */
interface Candidate {
  attempt: number;
  bytes: Uint8Array;
  valid: boolean;
  why: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// The completion masq answers with, or the one superbot-router's stream assembles to, read leniently: only what a
// forecast needs.
const ChatCompletion = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.union([z.string(), z.null()]).optional(),
            refusal: z.union([z.string(), z.null()]).optional(),
            tool_calls: z.array(z.object({ function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() })).nullable().optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: z.unknown().optional(),
  error: z.unknown().optional(),
});

/** The price of `usage` at `at`: on the model that answered when it has a pricing row, else on the model asked for. */
function priceOf(asked: string, answered: string | null, at: string, usage: CassetteUsageT): bigint | null {
  for (const model of answered !== null && answered !== asked ? [answered, asked] : [asked]) {
    const priced = priceUsage({ model, at, format: 'tokens', usage });
    if (priced.microUsd !== null) return priced.microUsd;
  }
  return null;
}

function sumUsage(all: readonly (CassetteUsageT | null)[]): CassetteUsageT | null {
  let sum: CassetteUsageT | null = null;
  for (const u of all) {
    if (u === null) continue;
    sum ??= { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, reasoning: 0 };
    for (const k of Object.keys(sum) as (keyof CassetteUsageT)[]) sum[k] += u[k];
  }
  return sum;
}

/** The meter of a call's attempts, µUSD: every priced attempt summed. */
export function houseForecastMeterMicroUsd(attempts: readonly HouseForecastAttemptT[]): bigint {
  let sum = 0n;
  for (const t of attempts) if (t.micro_usd !== null) sum += BigInt(t.micro_usd);
  return sum;
}

/** The forecast an answer's text holds (the header): its JSON re-serialised with a newline, else the text as it came; null when it holds nothing. */
export function houseForecastBytesOf(content: string): Uint8Array | null {
  const read = answerJsonOf(content);
  if (read.ok) return new TextEncoder().encode(`${JSON.stringify(read.json)}\n`);
  const text = withoutThinking(content);
  return text === '' ? null : new TextEncoder().encode(text);
}

const sleepFor = (ms: number, signal: AbortSignal | undefined): Promise<void> => delay(ms, undefined, signal === undefined ? {} : { signal });

interface SendOptions {
  origin: string;
  apiKey: string;
  agent: HouseForecastAgent;
  prompt: HouseForecastPrompt;
  schema: Readonly<Record<string, unknown>>;
  forms: JudgeForms;
  validate: HouseForecastValidate;
  blobs: JudgeBlobs;
  fetch: typeof fetch;
  timeoutMs: number;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  signal: AbortSignal | undefined;
  keyMintedAt: number;
  /** Whether the key is superbot-router's (the header's `router`): its wire, its answer, no fresh-key wait. */
  router: boolean;
  /** Each attempt as it completes: the call's meter, a fault's included. */
  attempts: HouseForecastAttemptT[];
  /** On a router key, what each answer read said of how it was served (routerServedOf), a refused or dropped one's included. */
  served: RouterServed[];
  page: ((line: string) => void) | undefined;
}

/** The call's requests (the header): the answer, then at most one retry. Throws HouseForecastFault on a platform fault. */
async function sendHouseForecast(o: SendOptions): Promise<{ taken: Candidate | null; last: Candidate | null }> {
  const quote = (text: string, max: number): string => (o.apiKey === '' ? text : text.split(o.apiKey).join('[the house key]')).slice(0, max);
  const attempts = o.attempts;
  const upstream: HouseForecastUpstream = o.router ? 'superbot-router' : 'masq';
  const fault = (message: string, status: number | null, cause?: unknown): HouseForecastFault => new HouseForecastFault(message, status, attempts, { upstream, ...(cause === undefined ? {} : { cause }) });
  // The model the upstream is asked for, and answers as: on the router, its own id for it.
  const wireModel = o.router ? routerWireModel(o.agent.model) : o.agent.model;
  let forms: JudgeForms = o.forms;
  let taken: Candidate | null = null;
  let last: Candidate | null = null;
  let waited = 0;
  let gap = MASQ_KEY_WARMUP_GAP_MS;
  // The router's one named wait, honoured once a call (the header's `router`).
  let routerResent = false;
  // An answer cut at the budget ends the call: the retry would be the same budget (the header's `retry`).
  let cut = false;
  for (let i = 0; i < HOUSE_FORECAST_ATTEMPTS && taken === null && !cut; i++) {
    const form = forms[i === 0 ? 0 : 1];
    // Sent as this string, which fetch writes as its UTF-8 bytes: the bytes request_sha256 names.
    const masqWireOf = o.router ? null : houseForecastWire(o.agent, o.prompt, form, o.schema);
    const wire: HouseForecastWire = masqWireOf ?? houseForecastRouterWire(o.agent, o.prompt, form, o.schema);
    const routerDialect = wire.dialect === ROUTER_DIALECT || wire.dialect === ROUTER_MESSAGES_DIALECT ? wire.dialect : null;
    const json = wire.body;
    const endpoint = new URL(wire.path, o.origin).href;
    // The router reads its Bearer key alone and ignores masq's headers, so none is sent (the header's `router`).
    const headers =
      masqWireOf === null
        ? routerHeaders(o.apiKey, routerDialect ?? ROUTER_DIALECT)
        : { ...masqAuthHeaders(masqWireOf.dialect, o.apiKey), 'content-type': 'application/json', accept: 'application/json', ...MASQ_REVIEW_HEADERS, 'x-cosmos-side-spawn': HOUSE_FORECAST_SIDE_SPAWN };
    let at: string;
    let res: Response;
    let raw: Uint8Array;
    // A router answer is the document assembled from its stream (the header's `router`); null on masq.
    let routed: RouterAnswer | null = null;
    for (;;) {
      at = isoOf(o.now());
      // On the router the call's bound holds its head alone, then the router's own (the header's `router`); on masq the whole call.
      const dial: RouterDial | null = o.router ? routerDial({ headMs: o.timeoutMs, ...(o.signal === undefined ? {} : { signal: o.signal }) }) : null;
      const timeout = dial === null ? AbortSignal.timeout(o.timeoutMs) : null;
      const signal = dial !== null ? dial.signal : o.signal === undefined ? timeout! : AbortSignal.any([o.signal, timeout!]);
      try {
        res = await o.fetch(endpoint, { method: 'POST', headers, body: json, signal });
      } catch (err) {
        dial?.done();
        throw fault(`${upstream} could not be reached: ${quote(err instanceof Error ? err.message : String(err), 300)}`, null, err);
      }
      try {
        raw = dial === null ? new Uint8Array(await res.arrayBuffer()) : await dial.read(res);
      } catch (err) {
        throw fault(`${upstream}'s answer (${res.status}) could not be read: ${quote(err instanceof Error ? err.message : String(err), 300)}`, null, err);
      } finally {
        dial?.done();
      }
      if (routerDialect !== null) {
        routed = routerAnswerIn(routerDialect, raw);
        o.served.push(routerServedOf(res.status, res.headers, routed.text));
        // The router's one named wait (the header's `router`): a refused status's retry-after, or an in-band error's
        // retry_after before any content; once a call, whole, at most JUDGE_RATE_LIMIT_WAIT_MS. Nothing else is sent again,
        // and the router's key is static, never fresh: its 401 is a fault at once.
        const band = res.ok && routed.fault !== null ? routerInBandOf(routerDialect, routed.text) : null;
        const named = band !== null ? routerInBandWaitMs(band) : res.ok ? null : routerNamedWaitMs(res.status, res.headers, o.now());
        if (named === null || routerResent || named > JUDGE_RATE_LIMIT_WAIT_MS) break;
        routerResent = true;
        const why = band !== null ? `superbot-router shed it in band (${band.shed ?? 'an error frame'})` : `superbot-router refused it (${res.status})`;
        try {
          await o.sleep(named, o.signal);
        } catch (err) {
          if (o.signal?.aborted) throw new HouseForecastFault(`the house forecast call was aborted while ${why}`, null, attempts, { upstream, cause: err });
          throw err;
        }
        if (o.signal?.aborted) throw new HouseForecastFault(`the house forecast call was aborted while ${why}`, null, attempts, { upstream });
        continue;
      }
      if (res.status !== 401) break;
      const age = Math.max(o.now() - o.keyMintedAt, waited);
      if (age >= MASQ_KEY_WARMUP_MS) break;
      // masq does not know the fresh key yet: no model saw the request, so it is sent again, not recorded.
      const wait = Math.min(gap, MASQ_KEY_WARMUP_MS - age);
      try {
        await o.sleep(wait, o.signal);
      } catch (err) {
        if (o.signal?.aborted) throw new HouseForecastFault('the house forecast call was aborted while masq did not yet know the fresh key', null, attempts, { cause: err });
        throw err;
      }
      if (o.signal?.aborted) throw new HouseForecastFault('the house forecast call was aborted while masq did not yet know the fresh key', null, attempts);
      waited += wait;
      gap *= 2;
    }
    // A router answer is the document assembled from its stream (the header's `router`): that text is what is stored
    // and read, a Messages one as a masq Messages answer is.
    if (res.ok && routed !== null && routed.fault !== null) {
      // A 2xx stream that is no answer (an in-band shed, a cut stream, a frame that is not JSON) is an answer that could not
      // be read: nothing stored, no attempt, not metered (the header's `faults`).
      const requestId = res.headers.get('request-id');
      throw fault(`superbot-router's answer (${res.status}) could not be read: ${quote(routed.fault, 300)}${requestId === null ? '' : ` (request-id ${quote(requestId, 100)})`}`, null);
    }
    const body = routed === null ? raw : new TextEncoder().encode(routed.text);
    // Stored before it is read: the record names the blob, and a forecast is never taken from a body the house does not keep.
    const stored = await o.blobs.put(body);
    const text = routed === null ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8') : routed.text;
    // A key the upstream refuses its model pages once an episode (the header's `scope`); an answer re-arms it.
    watchMasqScope({
      url: endpoint,
      model: wireModel,
      key: o.apiKey,
      ...(o.router ? { upstream: 'superbot-router' as const } : { episode: FORECAST_SCOPE_EPISODE }),
      status: res.status,
      body: text,
      fails: FORECAST_SCOPE_FAILS,
      keyNames: o.router ? FORECAST_ROUTER_SCOPE_KEYS : FORECAST_SCOPE_KEYS,
      ...(o.page ? { page: o.page } : {}),
    });
    let doc: z.infer<typeof ChatCompletion> | null = null;
    try {
      // A Messages answer is read as the Chat Completions answer it says (the header's `dialect`).
      const parsed = ChatCompletion.safeParse(JSON.parse(wire.dialect === 'messages' || wire.dialect === ROUTER_MESSAGES_DIALECT ? masqAnswerText('messages', text) : text));
      if (parsed.success) doc = parsed.data;
    } catch {
      doc = null;
    }
    // The router names the model in its answer alone; x-masq-model is masq's.
    const header = o.router ? null : res.headers.get(MASQ_MODEL_HEADER);
    // A model masq swapped in (x-masq-model) is the one that answered and billed, whatever the body names.
    const swapped = header !== null && !isServedModel(o.agent.model, header) ? header : null;
    const answered = swapped ?? (doc?.model !== undefined && doc.model.trim() !== '' ? doc.model : header);
    const usage = judgeUsageOf(doc?.usage);
    const priced = usage === null ? null : priceOf(o.agent.model, answered, at, usage);
    const attempt: HouseForecastAttemptT = {
      form,
      ...(wire.dialect === 'chat' ? {} : { dialect: wire.dialect }),
      request_sha256: sha256Hex(json),
      request_bytes: Buffer.byteLength(json),
      at,
      status: res.status,
      response_body_sha256: stored.sha256,
      model_answered: answered,
      finish_reason: doc?.choices?.[0]?.finish_reason ?? null,
      usage,
      micro_usd: priced !== null ? priced.toString() : res.ok ? null : '0',
      invalid: null,
    };
    if (!res.ok && !ANSWER_LEVEL_STATUSES.has(res.status)) {
      attempts.push(attempt);
      throw fault(`${upstream} answered ${res.status}: ${quote(text, 300)}`, res.status);
    }
    attempt.invalid = res.ok ? null : quote(`${upstream} refused the request (${res.status}): ${text}`, 300);
    // masq refuses a forced tool to a model that always thinks: the retry offers it instead.
    if (res.status === 400 && (form === 'answer' || form === 'tool') && FORCED_TOOL_REFUSED.test(text)) forms = [form, 'tool_auto'];
    if (attempt.invalid === null) {
      const choice = doc?.choices?.[0];
      const message = choice?.message;
      const call = message?.tool_calls?.find((t) => t.function?.name === HOUSE_FORECAST_TOOL)?.function?.arguments;
      const content = call ?? message?.content ?? '';
      if (doc === null) attempt.invalid = quote(`${upstream} answered ${res.status} with a body that is not a chat completion: ${text}`, 300);
      else if (doc.error !== undefined) attempt.invalid = quote(`${upstream} answered an error: ${JSON.stringify(doc.error)}`, 300);
      else if (swapped !== null) attempt.invalid = `masq answered with ${swapped} (${MASQ_MODEL_HEADER}), not ${o.agent.model}, the house's pinned model`;
      else if (!isServedModel(wireModel, doc.model ?? '')) attempt.invalid = `${upstream}'s answer ${doc.model === undefined || doc.model.trim() === '' ? 'names no model' : `was served by ${doc.model}`}, not ${wireModel}, the house's pinned model`;
      else if (choice?.finish_reason === 'length') {
        attempt.invalid = `the answer was cut off at the ${o.agent.max_output_tokens}-token budget (finish_reason length): a cut answer is never read as a forecast, and is not asked again at the same budget`;
        cut = true;
      }
      else if (typeof message?.refusal === 'string' && message.refusal.trim() !== '') attempt.invalid = quote(`the model refused: ${message.refusal}`, 300);
      else if (choice?.finish_reason === 'content_filter' || choice?.finish_reason === 'refusal') attempt.invalid = `the model refused (finish_reason ${choice?.finish_reason})`;
      else {
        const bytes = houseForecastBytesOf(content);
        if (bytes === null) {
          attempt.invalid = `the answer holds no content${call === undefined && (form === 'tool' || form === 'tool_auto') ? ' and no forecast tool call' : ''} (finish_reason ${choice?.finish_reason ?? 'none'})`;
        } else {
          let verdict: HouseForecastValidation;
          try {
            verdict = o.validate(bytes);
          } catch (err) {
            verdict = { ok: false, why: `the validator threw: ${err instanceof Error ? err.message : String(err)}` };
          }
          const why = verdict.ok ? null : quote(verdict.why, 600);
          last = { attempt: i + 1, bytes, valid: verdict.ok, why };
          if (verdict.ok) taken = last;
          else attempt.invalid = `the forecast does not meet the output contract: ${why}`;
        }
      }
    }
    attempts.push(attempt);
  }
  return { taken, last };
}

/**
 * One instance's house forecast (the header): the preflight, the key, the call, the key's retirement, the record.
 * A hold answers `held` and nothing is minted, sent or stored. Throws HouseForecastFault on a platform fault (the key
 * retired first), the broker's own error when the mint fails, and a TypeError on a task.json that is not UTF-8 JSON
 * naming a plain output file name.
 */
export async function callHouseForecast(opts: HouseForecastCallOptions): Promise<HouseForecastOutcome> {
  const now = opts.now ?? Date.now;
  const agent = houseForecastAgent(opts.agent);
  const task = houseForecastTaskOf(opts.input.task);
  const prompt = houseForecastPrompt(opts.input);
  const schema = opts.outputSchema ?? HOUSE_FORECAST_DEFAULT_SCHEMA;
  const pre = houseForecastPreflight({ agent, prompt, schema, at: isoOf(now()) });
  if (pre.hold !== null) return { held: pre.hold, budget: pre.budget };
  const budget = pre.budget;

  const promptBlob = await opts.blobs.put(houseForecastPromptBytes(prompt));
  const signalOpt = opts.signal !== undefined ? { signal: opts.signal } : {};
  // Minted with no dollar cap, as every judge key is (masq.ts judgeKeyRequest).
  const minted = await opts.broker.mintJudgeKey({ slug: opts.slug, phase: opts.phase, attempt: opts.attempt ?? 1, model: agent.model }, { now: now(), ...signalOpt });
  const mintedAt = now();
  // A router key (the header's `router`) is asked at its own origin, and lists the model under the router's id for it.
  const router = routerOfKey(minted);
  const card = minted.models === undefined ? null : judgeModelCard(minted.models, router === null ? agent.model : routerWireModel(agent.model));
  const forms = judgeFormsOf(card);

  const attempts: HouseForecastAttemptT[] = [];
  const served: RouterServed[] = [];
  // A router call's one served line (the header's `router`), once it is done, a fault's included; never a record field.
  const logServed = (): void => {
    if (router === null || served.length === 0) return;
    (opts.log ?? ((line: string) => console.warn(line)))(`[house-forecast] ${minted.label} on superbot-router (${routerWireModel(agent.model)}): ${routerServedWords(served)}`);
  };
  let sent: { taken: Candidate | null; last: Candidate | null };
  try {
    if (router !== null) {
      const ceiling = routerOutputCeiling(card);
      if (ceiling !== null && ceiling < agent.max_output_tokens) {
        const wireModel = routerWireModel(agent.model);
        throw new HouseForecastFault(
          `superbot-router's card for ${wireModel} on the router key caps an answer at ${ceiling} output tokens, under the forecast's max_output_tokens of ${agent.max_output_tokens}: ` +
            'the router would clamp the request to it (x-sbr-ignored: max_tokens) and cut and bill the answer, so nothing was sent',
          null,
          attempts,
          { upstream: 'superbot-router', fix: `raise the router key's max_tokens ceiling for ${wireModel} to at least ${agent.max_output_tokens} at superbot-router (the key is MAKEFUN_SUPERBOT_ROUTER_KEY), then run this again` },
        );
      }
    }
    sent = await sendHouseForecast({
      origin: router?.origin ?? opts.broker.origin,
      router: router !== null,
      apiKey: minted.key,
      agent,
      prompt,
      schema,
      forms,
      validate: opts.validate,
      blobs: opts.blobs,
      fetch: opts.fetch ?? globalThis.fetch,
      timeoutMs: opts.timeoutMs ?? MASQ_TIMEOUT_MS,
      now,
      sleep: opts.sleep ?? sleepFor,
      signal: opts.signal,
      keyMintedAt: mintedAt,
      attempts,
      served,
      page: opts.page,
    });
    logServed();
  } catch (err) {
    logServed();
    // Whatever was sent is retired against what it was priced at, so nothing more is spent on the key.
    const retired = await retireTrialKey(opts.broker, minted.id, houseForecastMeterMicroUsd(attempts), signalOpt).catch(() => null);
    if (err instanceof HouseForecastFault) err.retired = retired;
    throw err;
  }

  const meter = houseForecastMeterMicroUsd(attempts);
  let retired: RetiredTrialKey | null = null;
  let retireError: string | null = null;
  try {
    retired = await retireTrialKey(opts.broker, minted.id, meter, signalOpt);
  } catch (err) {
    retireError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  }
  const kept = sent.taken ?? sent.last;
  const from = attempts[(kept?.attempt ?? attempts.length) - 1];
  if (from === undefined) throw new Error('a house forecast call sends at least one request');
  const record: HouseForecastRecordT = {
    schema: HOUSE_FORECAST_RECORD_SCHEMA,
    competition: opts.slug,
    phase: opts.phase,
    task_sha256: task.sha256,
    output: task.output,
    model: agent.model,
    max_output_tokens: agent.max_output_tokens,
    reasoning_effort: agent.reasoning_effort ?? null,
    prompt_sha256: promptBlob.sha256,
    rules_sha256: sha256Hex(opts.input.rules),
    contract_sha256: sha256Hex(opts.input.contract),
    history_sha256: sha256Hex(opts.input.history),
    schema_sha256: sha256Hex(canonicalJson(schema)),
    budget: {
      requests: budget.requests,
      body_bytes: budget.bodyBytes,
      input_tokens: budget.inputTokens,
      request_micro_usd: String(budget.requestMicroUsd),
      worst_micro_usd: String(budget.worstMicroUsd),
    },
    key: { id: minted.id, label: minted.label, expires_at: isoOf(minted.expiresAt) },
    attempts,
    response_sha256: from.response_body_sha256,
    usage: sumUsage(attempts.map((t) => t.usage)),
    cost_micro_usd: meter.toString(),
    pricing_rev: pricingRev,
    masq_spend: retired === null ? null : { micro_usd: retired.spend.microUsd.toString(), settled: retired.settled, mismatch: retired.mismatch, flags: [...retired.flags] },
    retire_error: retireError,
    forecast: kept === null ? null : { attempt: kept.attempt, sha256: sha256Hex(kept.bytes), bytes: kept.bytes.byteLength, valid: kept.valid, why: kept.why },
    created_at: isoOf(now()),
    ...(opts.perCase === undefined ? {} : { per_case: { ...opts.perCase, markets: [...opts.perCase.markets] } }),
  };
  return { held: null, record: HouseForecastRecord.parse(record), forecast: kept?.bytes ?? null, prompt, budget, retired };
}

// ------------------------------------------------------------------ the entry tree

/** What writeHouseEntry wrote. */
export interface HouseEntryWritten {
  dir: string;
  /** records/<task sha256>.json. */
  record: string;
  /** forecasts/<task sha256>.json; null when the record holds no forecast. */
  forecast: string | null;
  /** Whether it replaced a different record for the same task (opts.replace). */
  replaced: boolean;
}

/** Write `bytes` to `path` through a sibling temporary file and a rename, so a reader never sees half a file. */
function writeWhole(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

const sameBytes = (path: string, bytes: Uint8Array): boolean => existsSync(path) && Buffer.compare(readFileSync(path), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) === 0;

/**
 * Write one instance's record and forecast into the entry tree at `dir` (the header), creating it from the template
 * or merging with what it holds: the template's files are written as they are, records/<task sha256>.json and
 * forecasts/<task sha256>.json for this instance, and every other instance's files are left alone, so a practice
 * instance and the final share one tree. The same record again is a no-op; a different record (or forecast) for
 * the same task is refused unless `replace`, which also removes a forecast the new record no longer holds. The
 * forecast must be the bytes the record names (null when it names none).
 *
 * A per-file instance's record (one naming per_case) is written from the per-file template
 * (HOUSE_ENTRY_CASES_TEMPLATE_DIR) into a tree that holds it alone: its main.ts applies the one forecast it ships to
 * every case, so a tree holding another instance's record or forecast is refused, `replace` or not.
 */
export function writeHouseEntry(dir: string, record: HouseForecastRecordT, forecast: Uint8Array | null, opts: { replace?: boolean } = {}): HouseEntryWritten {
  const checked = HouseForecastRecord.parse(record);
  const perCase = checked.per_case !== undefined;
  if (perCase) {
    const others = ['records', 'forecasts'].flatMap((sub) =>
      existsSync(join(dir, sub))
        ? readdirSync(join(dir, sub))
            .filter((f) => /^[0-9a-f]{64}\.json$/.test(f) && f !== `${checked.task_sha256}.json`)
            .map((f) => `${sub}/${f}`)
        : [],
    );
    if (others.length > 0) throw new Error(`the house entry at ${dir} holds another instance (${others.join(', ')}): a per-file instance's entry ships exactly one record, which its main.ts applies to every case`);
  }
  if ((forecast === null) !== (checked.forecast === null)) {
    throw new TypeError(checked.forecast === null ? 'the record holds no forecast, but forecast bytes were given' : `the record names forecast ${checked.forecast.sha256}, but no forecast bytes were given`);
  }
  if (forecast !== null && checked.forecast !== null && (sha256Hex(forecast) !== checked.forecast.sha256 || forecast.byteLength !== checked.forecast.bytes)) {
    throw new TypeError(`the forecast bytes hash to ${sha256Hex(forecast)} (${forecast.byteLength} bytes), not the record's ${checked.forecast.sha256} (${checked.forecast.bytes} bytes)`);
  }
  const recordBytes = houseForecastRecordBytes(checked);
  const recordPath = join(dir, 'records', `${checked.task_sha256}.json`);
  const forecastPath = join(dir, 'forecasts', `${checked.task_sha256}.json`);
  const holdsRecord = existsSync(recordPath);
  const holdsForecast = existsSync(forecastPath);
  const same = (!holdsRecord || sameBytes(recordPath, recordBytes)) && (forecast === null ? !holdsForecast : !holdsForecast || sameBytes(forecastPath, forecast));
  if (!same && opts.replace !== true) {
    throw new Error(
      `the house entry at ${dir} already holds a different ${holdsRecord && !sameBytes(recordPath, recordBytes) ? 'record' : 'forecast'} for task ${checked.task_sha256}: ` +
        'pass replace to overwrite it (an entered tree is never rewritten: enter the replaced tree as a new entry)',
    );
  }
  for (const sub of ['forecasts', 'records']) mkdirSync(join(dir, sub), { recursive: true });
  const [templateDir, templateFiles]: readonly [string, readonly string[]] = perCase
    ? [checked.per_case?.kind === 'twitch-ccu' ? HOUSE_ENTRY_TWITCH_CCU_TEMPLATE_DIR : checked.per_case?.kind === 'gta6-trophies' ? HOUSE_ENTRY_GTA6_TROPHIES_TEMPLATE_DIR : HOUSE_ENTRY_CASES_TEMPLATE_DIR, HOUSE_ENTRY_CASES_TEMPLATE_FILES]
    : [HOUSE_ENTRY_TEMPLATE_DIR, HOUSE_ENTRY_TEMPLATE_FILES];
  for (const file of templateFiles) {
    const to = join(dir, file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(templateDir, file), to);
  }
  if (forecast !== null) writeWhole(forecastPath, forecast);
  else rmSync(forecastPath, { force: true });
  writeWhole(recordPath, recordBytes);
  return { dir, record: recordPath, forecast: forecast === null ? null : forecastPath, replaced: !same && (holdsRecord || holdsForecast) };
}
