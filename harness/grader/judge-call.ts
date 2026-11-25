// The house judge's model call: the only code that sends a judge request (a ProgramJudge heat).
//
// A heat opens (openJudgeHeat) in three steps, each of which can hold it before anything is spent:
//
//   preflight   judgePreflight: the heat's planned calls (judgeHeatCalls, the caller's figure), each
//               sent at most JUDGE_CALL_ATTEMPTS times, at the worst case of the dearest body any of
//               them can send (grader/gateway/policy.ts worstCaseMicroUsd, the gateway's own pricing:
//               body bytes / 3 input tokens at the dearest input class, an image by its pixels instead
//               (judgeImageTokens), a dossier's text by its bytes and each of its images by its pixels,
//               plus max_output_tokens): the heat's figures, and the request ledger
//               its calls are sent against (JudgeHeat.requestsLeft: the planned calls × JUDGE_CALL_ATTEMPTS).
//               The pinned model has no pricing row: the heat is held (JudgeHold `unpriced`) and nothing is
//               minted. No spend figure holds a heat: every heat (final, provisional or local) opens whatever
//               its worst case and sends every call its schedule plans, held by nothing but `unpriced` and
//               `vision`.
//   key        broker.mintJudgeKey (grader/gateway/masq.ts judgeKeyRequest): label
//               makefun/<slug>/judge/<phase>/<attempt>, the pinned model alone, for under 24 h, with no
//               dollar cap: its ledger, max_output_tokens, the one pinned model and its life bound it.
//               It resolves once masq answers the new key (masq.ts: a fresh key reads 401 for a few
//               seconds), with masq's model list (GET /v1/models) as the key read it: the live card.
//   vision      an image or dossier heat on masq reads the pinned model's card (the mint's list; a broker that read
//               none, GET /v1/models on the key), else the card of an id masq routes it to (server/house-model.ts
//               masqAllowedModels): capabilities.supports_vision not true holds the heat (JudgeHold `vision`), its
//               key retired with nothing spent on it. No card at all holds it too. (A superbot-family judge, whose
//               card masq does not list, never gets here: the `no router` paragraph refuses it first.) An OpenRouter
//               heat reads its pin's vision instead (the `openrouter` paragraph). A vendor capability precondition,
//               never a content check.
//
// A held heat is the caller's to defer and page (judgeHoldPage; worker.ts holdJudgeHeat).
//
//   paged       a heat's artifacts are a list, every one held, or paged (JudgeArtifactPages: a final's field, read by
//               grader/worker.ts judgeHeatInputs): then nothing holds the field. The preflight reads each in turn
//               (judgePreflightsPaged), checks it to its name and weighs it, keeping only the two largest and the two
//               dearest it has met (the very pair a list's stable sort ranks first), in one walk of the field: a pool
//               heat's walk weighs every judge's preflight and hands each to its heat (JudgeHeatOptions.weighed), which
//               walks none of its own. Each call reads its two (judgeArtifactPager keeps the JUDGE_ARTIFACT_PAGES_KEPT
//               asked last). On a view heat a page is the artifact's judge view alone (judgeViewPage: no artifact
//               bytes, the view being what a dossier heat sends), held to the view's name. The figures, the refusals
//               and the bytes sent are a list's of the same artifacts. A parsed dossier is memoized on its bytes'
//               object (dossierOf), so it goes when its artifact's page does.
//
// Each call (JudgeHeat.call) sends one POST <MAKEFUN_LLM_GATEWAY_URL>/v1/chat/completions (a Claude model's
// /v1/messages: `dialect` below) on the heat's key with MASQ_REVIEW_HEADERS (x-masq-policy: off, no cross-vendor hop; x-masq-verbatim: 1, no
// request rewrite) and x-cosmos-side-spawn (JUDGE_SIDE_SPAWN: a one-shot request, so masq places no
// cache breakpoint of its own and writes no cache the chat answer could not report; see judgeUsageOf),
// modelled on server/entries/ai-review.ts masqProvider:
//
//   system      the HouseAgent prompt file, then JUDGE_VERDICT_INSTRUCTIONS (the house suffix): one JSON
//               object, reason first, {"reason": ≤ JUDGE_REASON_MAX characters, "winner": "A"|"B", "margin":
//               1..5} (verdict v2: the comparison written before the pick, then how far the winner is ahead,
//               1 by a hair to 5 overwhelmingly), never a tie, and nothing about the entries' content: what an
//               entry may say to the judge is the owner's prompt's to rule on. Verdict v1 ({"winner",
//               "reason"}: JUDGE_HOUSE_TEXT_V1, JUDGE_VERDICT_SCHEMA_V1) is what agent-fun/judge-heat/v1
//               records were sent in; it stays only so they rebuild byte for byte (judgeRequestBody's `verdict`,
//               judgeVerdictOf), and no heat asks it again.
//   user        "Entry A" then "Entry B", each under its heading (JUDGE_ENTRY_HEADING). A text artifact is
//               wrapped in a tag named after its own sha256 (entryDataTag) under one neutral line
//               (JUDGE_ENTRY_FRAME), framing only: nothing is filtered or rewritten. An image is its exact
//               bytes in an image_url part, a base64 data URL whose media type is read from its magic bytes
//               (judgeImageType), never re-encoded. A dossier (contracts/dossier.ts parseDossier) is its
//               images, each its exact bytes in an image_url part (its own base64 in a data URL of its
//               media_type), then its text framed as a text artifact is. A dossier artifact that carries its
//               judge view (JudgeArtifact.view: server/judging/dossier-view.ts, dossier-view/v1, itself a dossier,
//               stored as a blob and named in the heat setup's judge_view, grader/judge-heat.ts) is sent as its
//               view in its place, the same framing (heading, images, framed text), and priced by the preflight as
//               the view; one with none is sent whole, as every heat planned before the view was (a setup naming no
//               judge_view hands none, so its requests are the bytes they were). A view heat's house text frames
//               its entries in JUDGE_DOSSIER_VIEW_ENTRY_FRAME (JUDGE_HOUSE_TEXT_DOSSIER_VIEW). The message ends with
//               JUDGE_ANSWER_LINE.
//   house text  those four and the verdict tool's description (JUDGE_HOUSE_TEXT) are what a heat's setup
//               records (house_text), and a heat builds its requests from the text it is handed, so a
//               record is rebuilt from its own. The verdict's JSON schema and the tag are structure, not text.
//   compact     a contest in JUDGE_DOSSIER_TEXT_MAX (the owner's call, 2026-11-14: "truncate and swap it out with a
//               much smaller, more compact prompt") has each dossier's text cut to that many characters before it
//               is framed (judgeDossierText: what stands before its first file whole, then the start of every
//               file), its images untouched. The cap is its house text's dossier_text_max, so a record rebuilds on it.
//   answer      superbot-fast (masqSkipsJsonMode): a json_schema response_format with strict false
//               (strict answers HTTP 400) and reasoning_effort none unless the HouseAgent names one;
//               every other model: response_format json_object, as ai-review asks. Temperature only
//               when the HouseAgent sets one; never a seed (masq keeps it only between same-dialect hops).
//   dialect     a Claude model is asked on masq's POST /v1/messages in its own dialect (judgeWire,
//               server/entries/ai-review.ts masqWire: the key as x-api-key, anthropic-version), the body
//               grader/dialect.ts chatToMessages makes of the request above, its `answer` asking the
//               verdict's schema as structured output (output_config.format) where Chat asked json_object,
//               and the system prompt under one cache breakpoint; its answer read back as Chat Completions
//               (masqAnswerText). A request the dialect cannot say, and every superbot-family call, goes
//               on Chat Completions byte for byte as before. request_sha256 names the bytes sent either way.
//   retry       an answer that is not a verdict (unparseable, refused, cut at finish_reason length,
//               answered by another model, a verdict whose reason closes on the other entry (judgeVerdictOf,
//               judgeReasonPickOf: a final heat's call stood at the letter its own reasoning argued against,
//               gta6-meme-x-01, 2026-11-23), or an HTTP 400/413/422) is asked once more as a forced NAMED
//               tool call (tool_choice {type: function, function: {name: verdict}}: masq downgrades
//               any/required to auto on DeepSeek); still none, the call is recorded with verdict null.
//   no force    a model that takes no forced tool (its card's capabilities.reasoning.can_disable is
//               false: it always thinks, and Anthropic refuses a forced tool to a thinking model;
//               masq's json_object is a forced tool there too) is asked in the unforced pair instead
//               (judgeFormsOf): the answer with no response_format (the system prompt alone asks for
//               the JSON), then the verdict tool offered with tool_choice auto. A forced form masq
//               refuses so (HTTP 400 "tool_choice … not supported") is retried as tool_auto, and the
//               heat's later calls are asked in the unforced pair. Each attempt records its form.
//   fresh key   a 401 on a key minted less than MASQ_KEY_WARMUP_MS ago is re-sent, the same bytes,
//               after a wait (MASQ_KEY_WARMUP_GAP_MS, doubling): masq not yet knowing the key is no
//               attempt, neither stored nor recorded (masq refused it before any model saw it).
//   rate limit  a 429 (masq: no pooled capacity for the request), or a 503 naming its Retry-After, is
//               re-sent, the same bytes, after the Retry-After (capped at JUDGE_RETRY_AFTER_MAX_MS) or,
//               naming none, JUDGE_RATE_LIMIT_GAP_MS doubling, jittered ±25%: at most
//               JUDGE_RATE_LIMIT_RESENDS re-sends and JUDGE_RATE_LIMIT_WAIT_MS waited a call, past which the
//               last answer is the fault. A heat sends many calls at once (worker.ts JUDGE_HEAT_CONCURRENCY), and
//               a burst of 429s must not spend its one resend. Like a fresh key's 401, a rate-limited request
//               reached no model and masq bills none: no attempt, neither stored, recorded nor metered, so the
//               call's record is a serial run's. masq's 402 (the key's cap) is never re-sent. Each re-send is
//               the pool pushing back: the heat counts it (JudgeHeat.pushbacks, through onRateLimited), and
//               its sender narrows on it (worker.ts sendJudgeHeatCalls). Each wait is slept inside the call, on the
//               call's signal, the call keeping its place in its sender's width the while; the caller's `resends`
//               gate (JudgeResendGate: a heat's sender, whose run is over or whose attempt is already doomed) ends
//               it there unsent, at once, never final, and never sent again, its fault marked the gate's
//               (JudgeCallFault.gated): no fault, so its heat's take stops there, no re-send spent, nothing failed.
//   faults      masq unreachable, an answer whose body could not be read (the connection cut, the
//               timeout), or any other non-2xx status (a key, cap, rate or upstream fault, the rate limits
//               above once their re-sends are spent), throws JudgeCallFault: the platform's failure, never
//               the entries'.
//   scope       a 403 that is masq's scope refusal (`this key is not scoped for model <id>`: the minted key's
//               allowedModels, not the call) also pages a `[model-key] ALERT: ` line (server/house-model.ts
//               watchMasqScope), once for every heat's minted key until a judge call answers again, never the key.
//   timeout     each request is bounded by JUDGE_CALL_TIMEOUT_MS (240 s), its answer read included, unless the
//               caller names another: a judge's reasoning comes out of max_output_tokens, and a bundle's 12,100
//               takes ~220 s at the ~55 tokens a second superbot/high streams. masq's model list keeps MASQ_TIMEOUT_MS.
//               The read holds the bound itself, whatever the fetch ties its signal to (a door's fetch, a test's):
//               at the bound a read still waiting on the next chunk is cancelled and ends as the signal's reason,
//               the same unread fault a cut answer is (an image call's stream stalled 403 s mid-answer on
//               OpenRouter and was only ended 422 s after its send, 2026-11-21). Its body is read chunk by chunk to
//               time how it comes (JudgeAnswerTiming: to the headers, the first byte, the first data byte past the `: OPENROUTER
//               PROCESSING` comments, the longest gaps, the whole; JudgeCallResult.timings, JudgeCallFault.timing),
//               and, on OpenRouter GLM alone (judgeAnswerStallMsOf), to bound a stall from that data: a request whose
//               headers do not come within JUDGE_ANSWER_STALL_MS of its send, or whose next data byte does not come
//               within it of its headers or its last data byte (a comment is none), is aborted there, an answer left
//               unread; and a heat's request still unread past its answer bound (judgeAnswerBoundMs: 2x its completed
//               answers' p99, 35 s to 240 s; a runaway generation streams data the whole time) is aborted as one too,
//               but for the one send after an unread answer, held to the whole-call and stall bounds alone.
//               A 2xx answer that ends unread (its body cut or timed out
//               mid-read, a stream assembling to no answer: threejs-fps-02's final, 2026-11-17, cut a 200 at the bound
//               four minutes after its send), or a request stalled past that bound, is JudgeCallFault.unread, its words naming how it came and the provider its
//               first data chunk named.
//   no router   judging never dials superbot-router (the owner's order, 2026-11-17: "no make.fun judges should go to
//               superbot-router, it should all go to openrouter on glm-5.3 flash no matter what"): openJudgeHeat
//               refuses a judge on a model the router serves, or masq's spelling of one, before anything is read,
//               minted or sent, and a key a broker minted at the router all the same is retired unused, both a
//               JudgeRouterRefusal (server/superbot-router.ts judgeRouterRefusal: a broker fault, the platform's, the
//               job retried), and sendJudgeCall has no router wire. judgeRequestJson still rebuilds the router's
//               streamed bodies (ROUTER_DIALECT, ROUTER_MESSAGES_DIALECT), so a record an older release sent there
//               re-derives.
//   final       a fault OpenRouter (every heat now) answered is sent again by no layer but its transient refusals' re-sends
//               (the `openrouter` paragraph), once they are spent: any refused status, a 2xx that is no answer, a body cut mid-read, a dial that
//               timed out or reset is JudgeCallFault.final, and an OpenRouter heat (JudgeHeat.call) refuses its fault
//               re-send of that call (the same ordered pair) unsent, a final fault with no attempt and no request of the
//               ledger, but twice: an answer begun and left unread (JudgeCallFault.unread: no verdict read, so none
//               chosen against) may be sent again, the heat's sender doing so at once (grader/worker.ts
//               sendJudgeHeatCalls), JUDGE_PAIR_SENDS_MAX sends a pair in all, the last not held to the answer bound,
//               and that last send's fault is refused as any final one. Only what OpenRouter
//               never saw stays open to the heat's one fault re-send: a refused connect
//               (routerRefusedConnect), which on any door is JudgeCallFault.unseen, never final: a second one in a heat
//               ends the attempt for the queue to retry, not the heat (grader/worker.ts sendJudgeHeat). A masq fault is
//               never final. Every fault names the upstream it came from (JudgeCallFault.upstream), which the heat's
//               words say.
//   openrouter  a heat whose key OpenRouter's broker minted (openRouterOfKey(minted): server/openrouter-judge.ts
//               openRouterJudgeBroker, a static key) is opened on the pin it is handed (JudgeHeatOptions.pin, a
//               JudgePin): no model list is read, its forms are the pin's, an image or dossier heat on a pin whose model reads
//               no images is the `vision` hold, a judge asking past the pin's max_output_tokens or an effort it
//               does not list faults the opening with nothing sent, and its preflight never holds for a missing
//               price (its dollar figures stay null). Each request POSTs openRouterRequestJson of the `messages`
//               body to <openRouterApiBase(origin)>/chat/completions with openRouterHeaders (Superbot's app attribution: the referer, title and categories), bounded
//               by the call's timeout as on masq (the `timeout` paragraph), the stream read whole and stored as the document it
//               assembles to (openRouterAnswerOf). A transient refusal (openRouterTransientRefusal: a 429, 503 or 529,
//               a 402 of the in-flight budget, or a 2xx whose stream ended on an error coded 429, 503 or 529 before any
//               content or reasoning came: no answer, no generation billed) is re-sent, the same bytes, as masq's rate
//               limits are (the `rate limit` paragraph), the call sleeping in place: after the longer of its named wait
//               (its Retry-After, else the error body's: openRouterBodyWaitMs) and this re-send's backoff step
//               (JUDGE_RATE_LIMIT_GAP_MS doubling, jittered ±25%), so a wait named 0 still backs off, at most
//               JUDGE_RATE_LIMIT_RESENDS re-sends and JUDGE_RATE_LIMIT_WAIT_MS waited a call (a longer wait waited what
//               is left of it, and what is left counted spent once it is under the step): each a pushback, no attempt, no request of the ledger; the refusal that finds them spent
//               is final. A stream that ended on such an error after a content or reasoning chunk came may have billed
//               its tokens: an answer left unread, final, as any other cut stream (the `final` paragraph). Everything else
//               OpenRouter answered is final (the `final` paragraph: a 402 of credits or the key's limit, a request
//               weighing past the whole budget, every other refused status; a 400, 413 or 422 stays answer-level; only
//               a refused connect stays open to the heat's re-send),
//               a 2xx that is no answer is a fault with no attempt. An answer from another model, or from a
//               provider not the pin's (openRouterServedByPin), is no verdict. The attempt records the provider
//               the answer names (`provider`, its display name: two endpoints of one provider read alike and the
//               answer never names its quantization, so the endpoint's tag and quantization are the heat's
//               `judges`' to record) and usage.cost as micro_usd (else priceOf); the call sums what its answers'
//               usage.cost_details names by kind into micro_usd_by_kind (input: the prompt inference, output: the
//               completion), null when none names one.
//
// Every response body is stored as a blob (JudgeBlobs.put) before it is read, and each attempt's usage
// is priced by pricing/price.ts priceUsage at the attempt's instant: the heat's meter, which retire()
// hands to retireTrialKey so masq's settled spend is checked against it (its flags go in the record).
// The model that answered is checked on the x-masq-model header and the completion's `model`
// (isServedModel): a release-dated alias of the pinned model is the pinned model.

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CassetteUsageT } from '../contracts/agent.ts';
import type { HouseAgentT } from '../contracts/competition.ts';
import { DossierRefused, parseDossier, type DossierT } from '../contracts/dossier.ts';
import { priceUsage } from '../pricing/price.ts';
import {
  answerJsonOf,
  entryDataTag,
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
import { setTimeout as delay } from 'node:timers/promises';
import {
  MASQ_KEY_WARMUP_GAP_MS,
  MASQ_KEY_WARMUP_MS,
  MASQ_MODELS_PATH,
  retireTrialKey,
  type BrokerCallOptions,
  type JudgeKeyPhase,
  type JudgeKeySpec,
  type MasqJudgeKeyBroker,
  type MasqModelCard,
  type RetiredTrialKey,
} from './gateway/masq.ts';
import { BYTES_PER_INPUT_TOKEN, worstCaseMicroUsd } from './gateway/policy.ts';
import { isServedModel, MASQ_MODEL_HEADER } from './gateway/upstream.ts';
import {
  ROUTER_DIALECT,
  ROUTER_MESSAGES_DIALECT,
  routerFailureCode,
  JudgeRouterRefusal,
  judgeRouterRefusal,
  routerOfKey,
  routerRefusedConnect,
  routerRequestJson,
  routerRequestJsonIn,
  routerRetryAfterMs,
  routerServesModel,
  routerWire,
} from '../server/superbot-router.ts';
import { masqAllowedModels, watchMasqScope } from '../server/house-model.ts';
import { countJudgeCall, type JudgeCallRole, type JudgeDoor, type JudgeTokenKind } from '../server/ops/metrics.ts';
import {
  OPENROUTER_CHAT_PATH,
  OPENROUTER_DIALECT,
  OPENROUTER_IN_FLIGHT_BUDGET,
  isNanoGptPin,
  openRouterAnswerOf,
  openRouterApiBase,
  openRouterHeaders,
  openRouterOfKey,
  openRouterRequestJson,
  openRouterServedByPin,
  openRouterServedOf,
  openRouterSpendSplitOf,
  type JudgePin,
  type OpenRouterAnswer,
  type OpenRouterServed,
} from '../server/openrouter-judge.ts';
import { judgeText } from '../server/judging/judge-text.ts';

/** The longest reason a verdict keeps, in characters; a longer one is cut here. */
export const JUDGE_REASON_MAX = 600;

/** The forced tool's name, and the json_schema's. */
export const JUDGE_VERDICT_TOOL = 'verdict';
/** Requests one call may send: the answer, then one forced-tool retry. */
export const JUDGE_CALL_ATTEMPTS = 2;
/**
 * One judge request's bound, ms (the header's `timeout`), unless the caller names another: a judge reasons before it
 * answers, and its reasoning is paid out of max_output_tokens. superbot at high effort as the judge (2026-11-09, 128
 * calls) reasoned to 7,921 tokens at p99 and streamed 51-59 tokens a second on its slow calls, so a bundle pins
 * max_output_tokens 12,100 (1.5 × p99), which at ~55 tokens a second takes ~220 s: past MASQ_TIMEOUT_MS (120 s, the
 * AI review's, shared by the house calls), which stays as it is. masq's model list keeps that shorter bound.
 */
export const JUDGE_CALL_TIMEOUT_MS = 240_000;
/**
 * How long a request may wait for its headers, then for each data byte (the header's `timeout`), before it is aborted as
 * an answer left unread (JudgeCallFault.unread), which a heat's sender sends again (JUDGE_PAIR_SENDS_MAX sends a pair);
 * JUDGE_CALL_TIMEOUT_MS stays the outer bound. Only the net for a dead socket: the last unread answer of one call is
 * final and ends the heat's attempt, so it must not cut a provider that queues under load. Measured on
 * best-heist-game-20261122-0559's round 1 (2026-11-22, 12,498 calls on OpenRouter GLM): over ~4,000 answers that completed, headers came by 10 s at most (p99
 * 1.3-6.1 s), the first data by 15 s, and no gap between chunks passed 4.9 s (p99 0.4-1.6 s); 60 s is 4x that
 * first-data wait and 12x that gap.
 */
export const JUDGE_ANSWER_STALL_MS = 60_000;
/**
 * The judge models the stall bound's figures were measured on (JUDGE_ANSWER_STALL_MS): every other judge (a panel member,
 * a door's pin, masq's) keeps the whole-call bound alone until its answers are measured.
 */
export const JUDGE_ANSWER_STALL_MODELS: readonly string[] = ['z-ai/glm-5.3-flash'];
/**
 * A heat's answer bound (judgeAnswerBoundMs; on the judges JUDGE_ANSWER_STALL_MODELS lists): a request still unread this
 * long after its send is aborted as an answer left unread, and sent again, JUDGE_PAIR_SENDS_MAX sends a pair in all: the
 * first resend held to it as the first send was, the second and last not (openJudgeHeat's unreadSends:
 * JUDGE_CALL_TIMEOUT_MS and JUDGE_ANSWER_STALL_MS alone, since its fault is final and ends the heat's attempt). The hung
 * answers of best-heist-game-20261122-0559's round 1 were never silent: each streamed data the whole
 * 240 s (3,922,091 and 2,747,574 bytes, no gap past 1.1 s), a runaway generation toward the judge's max_output_tokens cut
 * only by JUDGE_CALL_TIMEOUT_MS; under that 240 s bound answers did complete at 140.2 s and 167.2 s. Its round 2
 * (2026-11-22, 3,816 calls at width 128) was bimodal: per minute p50 5.7-8.4 s, p99 16.8-25.6 s, and past 25 s only the 17
 * requests the then 90 s bound cut (0.44%, each resent, all but one to a verdict) and one answer of 57.6 s, so nearly
 * nothing completes between 30 s and 90 s, while each cut answer held its batch's tail the whole bound (of its calls'
 * 9 min 53 s, ~3.7 min was flow). So the bound is JUDGE_ANSWER_BOUND_P99_TIMES the p99 of every answer the heat has
 * completed so far, never under JUDGE_ANSWER_BOUND_FLOOR_MS (35-51 s at round 2's p99) nor past JUDGE_CALL_TIMEOUT_MS,
 * and JUDGE_ANSWER_BOUND_COLD_MS until JUDGE_ANSWER_BOUND_SAMPLE_MIN answers have completed (judgeAnswerBoundReader).
 * Over the whole heat, not its newest answers: the newest 1,000 completions of a draining stretch (a batch's end, a
 * narrowed width) are its slow ones, the fast ones long settled, so a windowed p99 read the heat's tail as its body. In
 * the card game's third batch (2026-11-22) the newest 1,000's p99 rose from 22 s to 39 s inside one minute, the bound
 * with it, and that batch's last two tails waited 74.7 s and 78.1 s for answers a 45 s bound would have cut and resent.
 * Its risk, a provider that slows for a whole heat, rides on worker.ts JUDGE_FINAL_WIDTH_RUNAWAY_SHARE (5%) and on the
 * unheld third send. Modelled on 3,000 answers at round 2's shape (p99 22 s) and then every answer slower, 384 in flight
 * (worker.ts JUDGE_FINAL_WIDTH_CEILING; tests/unit/judge-call-stall-bound.test.ts (e)): slowed 2x, the bound all but
 * covers the slowed p99 from the first slowed answer (43.9 s against 44 s: it was already 2x the old p99; N = 400, none
 * cut meanwhile), an answer passing it only where it was in the old top 1%: 11 of 1,111 sends cut, at most 11 of any 500
 * settled, under the 5%, so the width holds and each cut call is judged by its resend; slowed 4x, N = 1,000 slowed
 * answers complete before the bound covers the slowed p99 (88 s), 114 of the 1,114 sends settled meanwhile cut (10.2%),
 * past the 5% (21 of the last 408 settled), so the width halves, and 3 calls of 1,100 are judged by their third send.
 * Its cost, stated plainly: an answer cut at the bound is discarded (its tokens billed, kept as a spare) and asked again,
 * about 0.5% of requests; a bound this low is acceptable only because the last send is not held to it. The first resend
 * is held to it too: unheld, the slow resends of 2026-11-22 ran 93.3 s (round 3), 112.1 s (the final), 214.6 s and 240 s
 * (round 1), each holding its batch's tail well past the bound; held, a cut call waits two bounds at most before its
 * last send, which only a second cut in a row reaches (about 1 call in 40,000 at 0.5% a send, were cuts independent).
 * 35 s, not 45 s: replaying production's eight heats of 2026-11-22/23, 23 of 32 batches ended on a send cut at the floor;
 * at 35 s their calls took 11% less (2,109.9 s to 1,878.9 s), 26 batches ending 3.8-10.0 s sooner, none later, 5 more cuts.
 */
export const JUDGE_ANSWER_BOUND_FLOOR_MS = 35_000;
/**
 * The sends one call of a pair gets while each ends on an answer left unread (JudgeCallFault.unread), its first among
 * them (openJudgeHeat's unreadSends): the first two held to the heat's answer bound (JUDGE_ANSWER_BOUND_FLOOR_MS), the
 * last under JUDGE_CALL_TIMEOUT_MS and JUDGE_ANSWER_STALL_MS alone, its unread fault final. A record's own bound on a
 * call's sends, grader/judge-heat.ts JUDGE_HEAT_MAX_SENDS, is the same number (a test holds them equal), so each unread
 * send fits the record as a faulted spare.
 */
export const JUDGE_PAIR_SENDS_MAX = 3;
/** The multiple of the completed answers' p99 a heat's answer bound is (JUDGE_ANSWER_BOUND_FLOOR_MS): 2 x 16.8-25.6 s is 34-51 s, so 35-51 s. */
export const JUDGE_ANSWER_BOUND_P99_TIMES = 2;
/** The completed answers a heat needs before its answer bound reads their p99 (JUDGE_ANSWER_BOUND_FLOOR_MS). */
export const JUDGE_ANSWER_BOUND_SAMPLE_MIN = 100;
/** The completed answers between two reads of a heat's known answer bound (judgeAnswerBoundReader). */
export const JUDGE_ANSWER_BOUND_REREAD = 50;
/**
 * A heat's answer bound before JUDGE_ANSWER_BOUND_SAMPLE_MIN answers completed, ms: half the whole-call bound. Only a
 * send's first deadline: once the bound is known, a send still in flight is held to its send time + it, never later
 * (openJudgeHeat; JudgeSendOptions.answerBoundLater). Round 3 of best-heist-game-20261122-0559 (2026-11-22): one answer
 * sent before 100 had completed ran the whole 120 s while the known bound was 45 s, holding its first batch ~125 s.
 * Not lowered: a slow judge's first hundred answers must not be cut at 35 s, and its known bound is 2x its p99.
 */
export const JUDGE_ANSWER_BOUND_COLD_MS = 120_000;

/**
 * A heat's answer bound, ms, from every answer it has completed (their whole times, JudgeAnswerTiming.total_ms, in any
 * order): JUDGE_ANSWER_BOUND_P99_TIMES x their p99, held to [JUDGE_ANSWER_BOUND_FLOOR_MS, JUDGE_CALL_TIMEOUT_MS];
 * JUDGE_ANSWER_BOUND_COLD_MS with fewer than JUDGE_ANSWER_BOUND_SAMPLE_MIN of them. A heat's totals stay whole, at most
 * its calls x JUDGE_CALL_ATTEMPTS (about 25,000 for round 1's 12,498 calls): sorted as a Float64Array, natively, a
 * millisecond or so, read once each JUDGE_ANSWER_BOUND_REREAD answers.
 */
export function judgeAnswerBoundMs(totals: readonly number[]): number {
  const v = Float64Array.from(totals.filter((ms) => Number.isFinite(ms) && ms >= 0));
  if (v.length < JUDGE_ANSWER_BOUND_SAMPLE_MIN) return JUDGE_ANSWER_BOUND_COLD_MS;
  v.sort();
  const p99 = v[Math.min(v.length - 1, Math.ceil(0.99 * v.length) - 1)]!;
  return Math.min(JUDGE_CALL_TIMEOUT_MS, Math.max(JUDGE_ANSWER_BOUND_FLOOR_MS, Math.ceil(JUDGE_ANSWER_BOUND_P99_TIMES * p99)));
}

/** A heat's answer bound as its answers complete (judgeAnswerBoundReader). */
export interface JudgeAnswerBoundReader {
  /** The bound in force, ms (judgeAnswerBoundMs over the answers noted when it was last read). */
  readonly ms: number;
  /** The answers noted so far. */
  readonly answers: number;
  /** Note completed answers' whole times: true when the bound was read again and moved. */
  note(totals: readonly number[]): boolean;
}

/**
 * The answer bound one heat keeps (openJudgeHeat): every completed answer's whole time kept, the bound read
 * (judgeAnswerBoundMs) at each note until JUDGE_ANSWER_BOUND_SAMPLE_MIN answers, then once each JUDGE_ANSWER_BOUND_REREAD.
 */
export function judgeAnswerBoundReader(): JudgeAnswerBoundReader {
  const totals: number[] = [];
  let ms = judgeAnswerBoundMs(totals);
  let sinceRead = 0;
  return {
    get ms() {
      return ms;
    },
    get answers() {
      return totals.length;
    },
    note(more) {
      const was = totals.length;
      for (const t of more) totals.push(t);
      sinceRead += more.length;
      if (sinceRead < JUDGE_ANSWER_BOUND_REREAD && was >= JUDGE_ANSWER_BOUND_SAMPLE_MIN) return false;
      const before = ms;
      ms = judgeAnswerBoundMs(totals);
      sinceRead = 0;
      return ms !== before;
    },
  };
}
/**
 * The most times one call re-sends a rate-limited request (the header's `rate limit`; on OpenRouter a transient refusal,
 * the header's `openrouter`): a heat sends hundreds of calls at once (worker.ts JUDGE_FINAL_WIDTH_CEILING), and a burst
 * of refusals must not end its attempt. Backoff steps of 2, 4, 8 and 16 s (±25%) put about 30 s between a call's first
 * refusal and its last re-send, three of the sender's 10 s width steps: its width has halved by then. Each wait is slept
 * in place, the call holding its place in the sender's width, so a storm never has more calls open than the width.
 */
export const JUDGE_RATE_LIMIT_RESENDS = 4;
/**
 * The most one call waits out rate limits (on OpenRouter, transient refusals), ms, its waits summed: past it the refused
 * answer is the fault. A wait longer than what is left of it is waited what is left.
 */
export const JUDGE_RATE_LIMIT_WAIT_MS = 120_000;
/**
 * The first backoff step before a rate-limited request is re-sent, ms: doubling each re-send, jittered ±25%. masq's
 * wait is its Retry-After where it names one, else the step; OpenRouter's the longer of its named wait and the step, so a
 * wait named 0 (a `Retry-After: 0`, a past date) never sends the re-sends back to back.
 */
export const JUDGE_RATE_LIMIT_GAP_MS = 2_000;
/** The longest Retry-After a call waits, ms: a longer one is waited this long. */
export const JUDGE_RETRY_AFTER_MAX_MS = 30_000;

/**
 * A Retry-After header's wait, ms, read at `nowMs` (RFC 9110 §10.2.3: delay-seconds, or an HTTP-date), capped at
 * JUDGE_RETRY_AFTER_MAX_MS; null when there is none or it does not read.
 */
export function judgeRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const v = header.trim();
  if (v === '') return null;
  let ms: number;
  if (/^[0-9]+$/.test(v)) ms = Number(v) * 1000;
  else {
    // An HTTP-date names its day and zone in letters; V8 reads bare numbers ("1.5") as dates.
    if (!/[a-z]/i.test(v)) return null;
    const at = Date.parse(v);
    if (Number.isNaN(at)) return null;
    ms = Math.max(0, at - nowMs);
  }
  return Math.min(ms, JUDGE_RETRY_AFTER_MAX_MS);
}

/** masq's model list (grader/gateway/masq.ts): where a heat reads its model's card. */
export { MASQ_MODELS_PATH };
/**
 * x-cosmos-side-spawn's value on every judge call: masq reads a request that names itself a side spawn, with no
 * x-cosmos-chat, as a one-shot (cache-hints.ts isOneShotSideSpawn) and places no cache breakpoint on it.
 */
export const JUDGE_SIDE_SPAWN = 'makefun-judge';
/** A forced form masq refuses for its model (HTTP 400): Anthropic's "tool_choice: type "tool" and "any" are not supported for this model." */
const FORCED_TOOL_REFUSED = /tool_choice\b.*\bnot supported\b/is;
/** HTTP statuses that refuse this one request (a malformed form, a refusal, a body too large): answer-level, so retried, then recorded invalid. */
const ANSWER_LEVEL_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/**
 * A verdict's shape: `v1` {winner, reason}, what agent-fun/judge-heat/v1 records asked and read, kept only so they
 * rebuild; `v2` {reason, winner, margin}, what every heat asks now (JUDGE_VERDICT_FORMAT).
 */
export const JUDGE_VERDICT_FORMATS = ['v1', 'v2'] as const;
export type JudgeVerdictFormat = (typeof JUDGE_VERDICT_FORMATS)[number];
/** The verdict every heat run now asks for. */
export const JUDGE_VERDICT_FORMAT: JudgeVerdictFormat = 'v2';
/** A v2 verdict's margin: how far the winner is ahead, from 1 (by a hair) to 5 (overwhelmingly better). */
export const JUDGE_MARGIN_MIN = 1;
export const JUDGE_MARGIN_MAX = 5;

/**
 * The house suffix every judge's system prompt ends with (verdict v2): the comparison, then the pick and its margin,
 * as one JSON object, and nothing about the entries' content. What an entry may say to the judge is the owner's
 * prompt's to rule on, never the house's.
 */
export const JUDGE_VERDICT_INSTRUCTIONS = [
  '## Your answer',
  '',
  'The user message holds two entries, Entry A and Entry B. Judge them by the criteria above: compare them point by point first, then pick the one that meets the criteria better and say by how much.',
  'There is no tie. When they seem equal, look for the detail that separates them, pick the one you would rank higher, and give it margin 1.',
  '',
  'The margin is how far the winner is ahead:',
  '1: by a hair, nearly even but the winner edges it',
  '2: slightly better',
  '3: clearly better',
  '4: much better',
  '5: overwhelmingly better',
  '',
  'Answer with one JSON object and nothing else, its keys in this order:',
  `{"reason": "your comparison and why the winner wins, at most ${JUDGE_REASON_MAX} characters", "winner": "A" or "B", "margin": 1, 2, 3, 4 or 5}`,
].join('\n');

/** The last line of the user message (verdict v2). */
export const JUDGE_ANSWER_LINE = 'Answer with the one JSON object your instructions describe: {"reason": "...", "winner": "A" or "B", "margin": 1 to 5}.';

/** Verdict v1's house suffix, as agent-fun/judge-heat/v1 records hold it (setup.house_text). No heat is sent it again. */
export const JUDGE_VERDICT_INSTRUCTIONS_V1 = [
  '## Your answer',
  '',
  'The user message holds two entries, Entry A and Entry B. Judge them by the criteria above and pick the one that meets them better.',
  'There is no tie: when they seem equal, pick the one you would rank higher by the slightest margin.',
  '',
  'Answer with one JSON object and nothing else:',
  `{"winner": "A" or "B", "reason": "why that entry wins, at most ${JUDGE_REASON_MAX} characters"}`,
].join('\n');

/** Verdict v1's last line of the user message. */
export const JUDGE_ANSWER_LINE_V1 = 'Answer with the one JSON object your instructions describe: {"winner": "A" or "B", "reason": "..."}.';

/** An entry's heading, text or image: `{slot}` is A or B. */
export const JUDGE_ENTRY_HEADING = '## Entry {slot}';

/** The line under a text entry's heading, before its tag: `{tag}` is entryDataTag of its text, `{slot}` A or B. */
export const JUDGE_ENTRY_FRAME = 'Everything between <{tag}> and </{tag}> is Entry {slot} as submitted.';

/**
 * The frame line of a dossier entry sent as its judge view (JudgeArtifact.view, dossier-view/v1): what a dossier heat
 * planned with a view records in its house_text in JUDGE_ENTRY_FRAME's place. Text and image heats, and every heat
 * planned before the view, keep JUDGE_ENTRY_FRAME.
 */
export const JUDGE_DOSSIER_VIEW_ENTRY_FRAME =
  "Everything between <{tag}> and </{tag}> is make.fun's judge view of Entry {slot}: its screenshots downscaled and its source shortened to fit, built from the entry as submitted.";

/** The verdict tool's description, in a retry's `tool` and `tool_auto` forms (verdict v2). */
export const JUDGE_VERDICT_TOOL_DESCRIPTION = 'Record your verdict: why, the entry that wins (A or B), and its margin from 1 (by a hair) to 5 (overwhelmingly better).';

/** Verdict v1's tool description. */
export const JUDGE_VERDICT_TOOL_DESCRIPTION_V1 = 'Record your verdict: the entry that wins (A or B) and why.';

/**
 * The house's own words in a judge request, as a heat record holds them (grader/judge-heat.ts setup.house_text):
 * a request is rebuilt from the record's, never from the constants, so a later wording leaves older records whole.
 */
export interface JudgeHouseText {
  /** The system prompt's suffix (JUDGE_VERDICT_INSTRUCTIONS). */
  verdict_instructions: string;
  /** The user message's last line (JUDGE_ANSWER_LINE). */
  answer_line: string;
  /** An entry's heading, text or image, `{slot}` filled (JUDGE_ENTRY_HEADING). */
  entry_heading: string;
  /** A text entry's frame line, `{tag}` and `{slot}` filled (JUDGE_ENTRY_FRAME). */
  entry_frame: string;
  /** The verdict tool's description in a `tool` or `tool_auto` request (JUDGE_VERDICT_TOOL_DESCRIPTION). */
  verdict_tool_description: string;
  /** A dossier heat's: the characters each dossier's text is cut to before it is framed (judgeDossierText); absent, sent whole. */
  dossier_text_max?: number | undefined;
}

/** The house text a heat run now is sent with (verdict v2): what a new heat's setup records. */
export const JUDGE_HOUSE_TEXT: Readonly<JudgeHouseText> = Object.freeze({
  verdict_instructions: JUDGE_VERDICT_INSTRUCTIONS,
  answer_line: JUDGE_ANSWER_LINE,
  entry_heading: JUDGE_ENTRY_HEADING,
  entry_frame: JUDGE_ENTRY_FRAME,
  verdict_tool_description: JUDGE_VERDICT_TOOL_DESCRIPTION,
});

/**
 * The house text a dossier heat planned with a judge view is sent with (verdict v2, its entries framed in
 * JUDGE_DOSSIER_VIEW_ENTRY_FRAME): what such a heat's setup records (grader/judge-heat.ts judgeHeatSetup's `view`).
 */
export const JUDGE_HOUSE_TEXT_DOSSIER_VIEW: Readonly<JudgeHouseText> = Object.freeze({
  ...JUDGE_HOUSE_TEXT,
  entry_frame: JUDGE_DOSSIER_VIEW_ENTRY_FRAME,
});

/** The house text agent-fun/judge-heat/v1 heats were sent with (verdict v1): what their setups record. */
export const JUDGE_HOUSE_TEXT_V1: Readonly<JudgeHouseText> = Object.freeze({
  verdict_instructions: JUDGE_VERDICT_INSTRUCTIONS_V1,
  answer_line: JUDGE_ANSWER_LINE_V1,
  entry_heading: JUDGE_ENTRY_HEADING,
  entry_frame: JUDGE_ENTRY_FRAME,
  verdict_tool_description: JUDGE_VERDICT_TOOL_DESCRIPTION_V1,
});

/**
 * The verdict's JSON schema (v2): the json_schema response_format's and the forced tool's parameters. Its keys in the
 * order the model writes them: the reason first, so the comparison comes before the pick, then the winner and margin.
 */
export const JUDGE_VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    reason: Object.freeze({ type: 'string', maxLength: JUDGE_REASON_MAX, description: `Your comparison and why the winner wins, at most ${JUDGE_REASON_MAX} characters.` }),
    winner: Object.freeze({ type: 'string', enum: Object.freeze(['A', 'B']), description: 'The entry that wins: A or B. Never a tie.' }),
    margin: Object.freeze({
      type: 'integer',
      minimum: JUDGE_MARGIN_MIN,
      maximum: JUDGE_MARGIN_MAX,
      description: 'How far the winner is ahead: 1 by a hair, 2 slightly, 3 clearly, 4 much, 5 overwhelmingly better.',
    }),
  }),
  required: Object.freeze(['reason', 'winner', 'margin']),
  additionalProperties: false,
});

/** Verdict v1's JSON schema, byte for byte what agent-fun/judge-heat/v1 requests carried. */
export const JUDGE_VERDICT_SCHEMA_V1 = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    winner: Object.freeze({ type: 'string', enum: Object.freeze(['A', 'B']), description: 'The entry that wins: A or B. Never a tie.' }),
    reason: Object.freeze({ type: 'string', maxLength: JUDGE_REASON_MAX, description: `Why that entry wins, at most ${JUDGE_REASON_MAX} characters.` }),
  }),
  required: Object.freeze(['winner', 'reason']),
  additionalProperties: false,
});

/** The JSON schema a request in verdict `format` carries. */
export function judgeVerdictSchema(format: JudgeVerdictFormat): typeof JUDGE_VERDICT_SCHEMA | typeof JUDGE_VERDICT_SCHEMA_V1 {
  if (format === 'v1') return JUDGE_VERDICT_SCHEMA_V1;
  if (format === 'v2') return JUDGE_VERDICT_SCHEMA;
  throw new RangeError(`verdict format ${JSON.stringify(format)} is not one of ${JUDGE_VERDICT_FORMATS.join(', ')}`);
}

const Winner = z.string().trim().toUpperCase().pipe(z.enum(['A', 'B']));
const Reason = z.string().transform((s) => judgeText(s.trim().slice(0, JUDGE_REASON_MAX)));
/** A margin as an answer gives it: a JSON integer, or a string of one digit (trimmed); 1 to 5 either way. */
const Margin = z
  .union([z.int(), z.string().trim().regex(/^[0-9]$/, 'one digit').transform(Number)])
  .pipe(z.int().min(JUDGE_MARGIN_MIN).max(JUDGE_MARGIN_MAX));

/**
 * A v2 verdict as read from an answer: the winner A or B (any case, trimmed), the margin an integer 1 to 5 (a JSON
 * integer, or a string of one digit, trimmed), the reason cut at JUDGE_REASON_MAX. A margin missing or out of range is
 * no verdict.
 */
export const JudgeVerdictAnswer = z.object({
  reason: Reason,
  winner: Winner,
  margin: Margin,
});

/** A v1 verdict as read from an answer (agent-fun/judge-heat/v1): the winner A or B (any case, trimmed), the reason cut at JUDGE_REASON_MAX. */
export const JudgeVerdictAnswerV1 = z.object({
  winner: Winner,
  reason: Reason,
});

/** A verdict read off an answer: v1's carries margin null. */
export type JudgeVerdictRead = { ok: true; winner: 'A' | 'B'; reason: string; margin: number | null } | { ok: false; why: string };

/** How judgeVerdictOf reads an answer. */
export interface JudgeVerdictReading {
  /**
   * Whether a verdict whose reason closes on the other entry is none (judgeReasonPickOf): default true in v2, false in
   * v1 (agent-fun/judge-heat/v1 records rebuild as they were read). False reads the letter alone, as every release
   * before the check did.
   */
  checkReason?: boolean;
  /**
   * Which release of the reason check reads it (JUDGE_REASON_CHECKS; default `current`): a record's verifier
   * (cli/verify-result.ts) holds a recorded refusal in any release's words, as the heat that made it read it.
   */
  reasonCheck?: JudgeReasonCheck;
}

/**
 * The releases of the reason check (judgeVerdictOf), oldest first: `first` (judgeReasonPickOf's first reading, live on
 * production from 2026-11-23 17:53Z, 6b852f1d, through d840d00b), `current` (judgeReasonPickOf). A heat reads with the
 * newest alone; a refusal recorded by an older one is in its words.
 */
export const JUDGE_REASON_CHECKS = Object.freeze(['first', 'current'] as const);
export type JudgeReasonCheck = (typeof JUDGE_REASON_CHECKS)[number];

// The reason's closing sentence, read for the entry it closes on (judgeReasonPickOf). Every word list is matched whole and
// case-blind on its first letter only; an entry's letter is A or B in capitals.
const capFirst = (w: string): string => (/^[a-z]/.test(w) ? `[${w[0]!.toUpperCase()}${w[0]}]${w.slice(1)}` : w);
const wordsOf = (words: readonly string[]): string => `(?:${words.map(capFirst).join('|')})`;
/** Nouns a reason names an entry by before its letter ("Entry B", "answer A", "slot A"). */
const REASON_ENTRY_NOUNS = wordsOf(['entry', 'option', 'response', 'submission', 'image', 'meme', 'candidate', 'answer', 'dossier', 'video', 'output', 'version', 'slot', 'side', 'text', 'story', 'poem', 'joke', 'clip', 'picture', 'photo', 'design', 'game']);
/** A capital letter after an entry's noun: its index is the letter's. */
const REASON_NAMED_LETTER = new RegExp(String.raw`(?<![\p{L}\p{N}_])${REASON_ENTRY_NOUNS}\s+([AB])(?![\p{L}\p{N}_/-])`, 'gu');
/** A bare capital A or B standing alone (never one of A/B, A-grade, B's own word). */
const REASON_BARE_LETTER = /(?<![\p{L}\p{N}_'’/-])([AB])(?![\p{L}\p{N}_/-])/gu;
/**
 * A bare capital A is an entry, but where it may be the article: opening the sentence or a clause after a colon or dash
 * ("A clear win for B"), and followed by a word. There it is an entry only before a possessive, punctuation or the
 * sentence's end, a verb (one listed, or a word ending in s as a verb does: "A earns", never "A series" or "A canvas"),
 * or an adverb ("A clearly beats B", "A also lands"). A bare B is always an entry.
 */
const BARE_A_OPENS = /(?:^|[:;–—-])[^\p{L}\p{N}]*$/u;
const BARE_A_AFTER = new RegExp(
  String.raw`^(?:['’]s\b|\s*(?:[)\].,;:!?"”]|$)|\s+${wordsOf([
    'is', 'was', 'wins', 'won', 'edges', 'edged', 'takes', 'took', 'has', 'had', 'does', 'did', 'beats', 'beat', 'outperforms', 'outshines', 'surpasses',
    'prevails', 'remains', 'comes', 'delivers', 'offers', 'nails', 'stands', 'excels', 'leads', 'keeps', 'captures', 'makes', 'shows', 'feels',
    'reads', 'lands', 'scores', 'gets', 'holds', 'loses', 'lost', 'falls', 'lacks', 'fails', 'trails', 'would', 'should', 'could', 'can', 'will',
    'clearly', 'plainly', 'simply', 'easily', 'really', 'truly', 'genuinely', 'slightly', 'narrowly', 'comfortably', 'decisively', 'definitely',
    'certainly', 'obviously', 'consistently', 'actually', 'arguably', 'marginally', 'squarely', 'handily', 'also', 'still', 'just', 'even', 'again',
  ])}\b|\s+(?!${wordsOf([
    'series', 'species', 'means', 'news', 'lens', 'physics', 'maths', 'ethics', 'politics', 'graphics', 'lyrics', 'mechanics', 'dynamics', 'economics',
    'aesthetics', 'optics', 'logistics', 'basics', 'thanks', 'odds', 'pants', 'shorts', 'pros', 'cons',
  ])}\b)\p{L}*[^\P{L}sauioSAUIO]s\b)`,
  'u',
);
/** The reason's winner said outright ("the winner is B", "Verdict: Entry A"). */
const REASON_DECLARED = new RegExp(
  String.raw`(?<![\p{L}])${wordsOf(['winner', 'verdict', 'pick', 'choice', 'preference'])}\s*(?:is|goes\s+to|[:=–—-])\s*(?:clearly\s+|plainly\s+)?(?:the\s+)?(${REASON_ENTRY_NOUNS}\s+)?([AB])(?![\p{L}\p{N}_/-])`,
  'u',
);
/** Words that turn a sentence against itself or its entry, or hedge it: its pick is not read. */
const REASON_CONTRAST = new RegExp(
  String.raw`(?<![\p{L}])${wordsOf(['but', 'however', 'although', 'though', 'while', 'whereas', 'despite', 'yet', 'except', 'unlike', 'if', 'unless', 'could', 'would', 'should', 'might', 'needs', 'need', 'too', 'overly'])}(?![\p{L}])`,
  'u',
);
const REASON_NEGATION = new RegExp(String.raw`(?<![\p{L}])(?:${wordsOf(['not', 'no', 'never', 'neither', 'nor', 'nothing', 'nowhere', 'hardly', 'barely'])}|\p{L}+n['’]t)(?![\p{L}])`, 'u');
/** A sentence naming one entry, said for it. */
const REASON_FOR = new RegExp(
  String.raw`(?<![\p{L}])(?:${wordsOf([
    'better', 'best', 'stronger', 'strongest', 'superior', 'win', 'wins', 'winner', 'winning', 'won', 'edge', 'edges', 'edged', 'outperforms', 'outshines',
    'beats', 'surpasses', 'prevails', 'prefer', 'preferred', 'preferable', 'favor', 'favored', 'favour', 'favoured', 'ahead', 'excels', 'funnier', 'sharper',
    'clearer', 'cleaner', 'tighter', 'richer', 'smarter', 'fresher', 'bolder', 'stands out',
  ])})(?![\p{L}])`,
  'u',
);
/** A sentence naming one entry, said against it. */
const REASON_AGAINST = new RegExp(
  String.raw`(?<![\p{L}])${wordsOf([
    'worse', 'worst', 'weaker', 'weakest', 'inferior', 'lose', 'loses', 'losing', 'lost', 'falls', 'fall', 'behind', 'lacks', 'lack', 'lacking', 'fails',
    'fail', 'failed', 'less', 'poor', 'poorly', 'flat', 'weak', 'bland', 'generic', 'trails', 'outdone', 'outclassed', 'beaten',
  ])}(?![\p{L}])`,
  'u',
);
/** Between two entries named, words that put the first over the second ("A outshines B", "B wins over A"). */
const REASON_FIRST_OVER = new RegExp(
  String.raw`(?<![\p{L}])${wordsOf(['better', 'stronger', 'superior', 'outperforms', 'outshines', 'beats', 'surpasses', 'edges', 'edged', 'over', 'ahead', 'wins', 'preferred', 'preferable'])}(?![\p{L}])`,
  'u',
);
/** Between two entries named, words that put the first under the second ("A falls short of B", "A is worse than B"). */
const REASON_FIRST_UNDER = new RegExp(String.raw`(?<![\p{L}])${wordsOf(['worse', 'weaker', 'inferior', 'loses', 'lost', 'falls', 'trails', 'behind', 'outdone', 'outclassed', 'beaten'])}(?![\p{L}])`, 'u');
/** An -er comparative said before "than" ("B is blander than A"): it puts its entry over or under the other only when it is one of the lists below. */
const REASON_ER_THAN = /(?<![\p{L}])(\p{L}+er)\s+than(?![\p{L}])/gu;
/** "more" or "less" and the word after it ("B is more predictable than A", "A has less punch than B"). */
const REASON_MORE_LESS = /(?<![\p{L}])([Mm]ore|[Ll]ess)\s+(\p{L}[\p{L}'’-]*)/gu;
/** -er comparatives that put an entry over another ("B is funnier than A"). Any -er word on neither list says nothing (longer, louder, darker). */
const REASON_OVER_ER: ReadonlySet<string> = new Set([
  'better', 'stronger', 'funnier', 'sharper', 'clearer', 'cleaner', 'tighter', 'richer', 'smarter', 'fresher', 'bolder', 'cleverer', 'wittier', 'punchier',
  'catchier', 'crisper', 'livelier', 'nicer', 'greater', 'cooler', 'prettier', 'sleeker', 'snappier', 'deeper', 'truer', 'closer',
]);
/** -er comparatives that put an entry under another ("B is blander than A"). */
const REASON_UNDER_ER: ReadonlySet<string> = new Set([
  'weaker', 'blander', 'duller', 'flatter', 'staler', 'plainer', 'poorer', 'lazier', 'messier', 'clunkier', 'sloppier', 'muddier', 'blurrier', 'lesser',
  'tamer', 'wordier', 'stiffer', 'cheaper', 'uglier', 'lamer', 'rougher', 'cruder', 'thinner', 'flimsier', 'shallower', 'vaguer', 'looser', 'tackier',
  'cheesier',
]);
/** Faults a judge holds against an entry: "more" of one puts it under ("B is more predictable than A"), "less" of one over ("A is less generic than B"). */
const REASON_FAULTS: ReadonlySet<string> = new Set([
  'predictable', 'generic', 'forgettable', 'cliched', 'clichéd', 'derivative', 'confusing', 'cluttered', 'boring', 'repetitive', 'awkward', 'bland',
  'muddled', 'stale', 'obvious', 'formulaic', 'conventional', 'basic', 'flat', 'dull', 'simplistic', 'tired', 'lazy', 'juvenile', 'cheesy', 'cringe', 'cringey',
  'cringy', 'forced', 'clumsy', 'cheap', 'crude', 'messy', 'vague', 'garbled', 'incoherent', 'offensive', 'off-topic', 'distracting', 'sloppy', 'amateurish',
  'contrived', 'heavy-handed', 'tedious', 'trite', 'hackneyed', 'mundane', 'ordinary', 'wordy', 'verbose', 'dated', 'unfunny', 'unclear',
  'uninspired', 'unoriginal', 'mediocre', 'lifeless', 'noisy', 'monotonous', 'rambling', 'robotic', 'stiff', 'overdone', 'overused', 'overwrought',
  'pedestrian', 'limited', 'expected', 'foreseeable', 'errors', 'mistakes', 'flaws', 'problems', 'issues', 'artifacts', 'noise', 'clutter', 'filler',
  'padding', 'setup', 'machinery', 'exposition', 'explanation', 'explaining', 'waste',
]);
/** Clause marks of the judge's final weighing ("B looks better, A is funnier overall"): the clause carrying one decides. */
const REASON_WEIGHED = /(?<![\p{L}])(?:[Oo]verall|[Uu]ltimately|[Ii]n the end|[Oo]n balance|[Aa]ll told|[Aa]ll in all|[Oo]n the whole|[Ii]n sum)(?![\p{L}])/u;
/** A turn whose after-part decides ("B is bolder, but A is cleaner"): the sentence's last one is read. */
const REASON_TURN = /(?<![\p{L}])(?:[Bb]ut|[Yy]et|[Hh]owever)(?![\p{L}])/gu;
/** A sentence's end: its stop, then any closing quote or bracket. */
const REASON_SENTENCE_ENDS = /[.!?…]["”')\]]*$/u;
/** Where a sentence's clauses part: a comma, a semicolon, a dash. */
const REASON_CLAUSE_BREAK = /\s*[,;–—]\s*|\s+-\s+/u;
/** The word joining a clause on, leading it (but, yet, however, and, so). */
const REASON_JOINED = /^(?:[Bb]ut|[Yy]et|[Hh]owever|[Aa]nd|[Ss]o)\s+/u;

/** The sentences of a reason, in order, trimmed, none empty. */
function reasonSentencesOf(reason: string): string[] {
  return reason
    .split(/(?<=[.!?…])["”')\]]*\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** The entries a sentence names, in the order it names them (each letter at its first naming); `aAfter` reads an opening A (BARE_A_AFTER). */
function reasonEntriesOf(sentence: string, aAfter: RegExp = BARE_A_AFTER): { letter: 'A' | 'B'; index: number }[] {
  const at = new Map<number, 'A' | 'B'>();
  for (const m of sentence.matchAll(REASON_NAMED_LETTER)) {
    const index = m.index + m[0].length - 1;
    at.set(index, m[1] as 'A' | 'B');
  }
  for (const m of sentence.matchAll(REASON_BARE_LETTER)) {
    if (at.has(m.index)) continue;
    const letter = m[1] as 'A' | 'B';
    if (letter === 'A' && BARE_A_OPENS.test(sentence.slice(0, m.index)) && !aAfter.test(sentence.slice(m.index + 1))) continue;
    at.set(m.index, letter);
  }
  const named: { letter: 'A' | 'B'; index: number }[] = [];
  for (const [index, letter] of [...at.entries()].sort((x, y) => x[0] - y[0])) {
    if (!named.some((n) => n.letter === letter)) named.push({ letter, index });
  }
  return named;
}

/** A word as its list keeps it: its first letter lower-cased (the lists match case-blind on it alone). */
const listWordOf = (w: string): string => `${w[0]!.toLowerCase()}${w.slice(1)}`;

/**
 * Which way the words of `text` put an entry before them against one after (`over`, `under`; both or neither: no
 * way): a word for or against it (outshines, beats; worse, falls ...), an -er comparative before "than" on
 * REASON_OVER_ER or REASON_UNDER_ER ("funnier than"; "blander than"; any other -er word says nothing), "more" of a
 * word (over) unless that word is a fault (REASON_FAULTS: "more predictable", under), "less" of a word (under) unless
 * it is a fault ("less generic", over).
 */
function reasonSidesOf(text: string): { over: boolean; under: boolean } {
  let over = REASON_FIRST_OVER.test(text);
  let under = REASON_FIRST_UNDER.test(text);
  for (const m of text.matchAll(REASON_ER_THAN)) {
    const w = listWordOf(m[1]!);
    if (REASON_UNDER_ER.has(w)) under = true;
    else if (REASON_OVER_ER.has(w)) over = true;
  }
  for (const m of text.matchAll(REASON_MORE_LESS)) {
    const fault = REASON_FAULTS.has(listWordOf(m[2]!));
    if ((listWordOf(m[1]!) === 'more') !== fault) over = true;
    else under = true;
  }
  return { over, under };
}

/**
 * The entry one clause (or a whole sentence) is plainly said for, or null: no turn or hedge (but, while, could,
 * needs ...) and no negation in it; naming one entry with no word against it (REASON_AGAINST, or a word putting it
 * under: reasonSidesOf), the entry when what follows its naming says something for it (better, stronger, wins,
 * funnier ...: never "... is funnier than A's gentle irony", where the entry is the one put under); naming both,
 * the first when what stands between them puts it over the second ("B is funnier than A", "A is less generic than
 * B"), the second when it puts the first under ("A falls short of B", "B is blander than A").
 */
function reasonPlainPickOf(clause: string): 'A' | 'B' | null {
  if (REASON_CONTRAST.test(clause) || REASON_NEGATION.test(clause)) return null;
  const named = reasonEntriesOf(clause);
  if (named.length === 1) {
    // Said for it only after it is named: before, the entry is what another is said over ("Freshness beats A's rhythm").
    const entry = named[0]!;
    if (REASON_AGAINST.test(clause) || reasonSidesOf(clause).under || !REASON_FOR.test(clause.slice(entry.index + 1))) return null;
    return entry.letter;
  }
  if (named.length === 2) {
    const [first, second] = named as [{ letter: 'A' | 'B'; index: number }, { letter: 'A' | 'B'; index: number }];
    const { over, under } = reasonSidesOf(clause.slice(first.index + 1, second.index));
    if (under === over) return null;
    return under ? second.letter : first.letter;
  }
  return null;
}

/**
 * The entry a judge's reason closes on, or null when its closing sentence settles none: the entry the sentence declares
 * the winner ("the winner is B"); else, where the sentence turns or weighs, the part that decides read plainly
 * (reasonPlainPickOf): after its last turn (but, yet, however: "B is bolder, but A is cleaner" closes on A), and the
 * one clause marked as the final weighing (overall, ultimately, on balance ...: "B looks better, A is funnier overall"
 * closes on A), the two agreeing where both are there, a turn whose after-part names no entry settling none; else a
 * sentence whose clauses name the two entries apart with nothing to weigh them ("B looks better, A is funnier")
 * settles none; else the whole sentence read plainly. A reason cut at JUDGE_REASON_MAX (`cut`) closes on its last
 * whole sentence (its last one, when that ends as a sentence does); one with no whole sentence settles none. Read
 * only to refuse a verdict its reason argues against (judgeVerdictOf): anything less than plain is null, never a guess.
 */
export function judgeReasonPickOf(reason: string, cut: boolean = false): { pick: 'A' | 'B'; closing: string } | null {
  const sentences = reasonSentencesOf(reason);
  if (cut && !REASON_SENTENCE_ENDS.test(sentences.at(-1) ?? '')) sentences.pop();
  const closing = sentences.at(-1);
  if (closing === undefined) return null;
  // A declared A with no noun before it is the article where no verb or stop follows it ("Verdict: A clear win for B").
  const declared = REASON_DECLARED.exec(closing);
  const declaredLetter = declared?.[2] as 'A' | 'B' | undefined;
  if (declared !== null && declaredLetter !== undefined && (declaredLetter === 'B' || declared[1] !== undefined || BARE_A_AFTER.test(closing.slice(declared.index + declared[0].length)))) {
    return { pick: declaredLetter, closing };
  }
  const deciding: ('A' | 'B' | null)[] = [];
  const turn = [...closing.matchAll(REASON_TURN)].at(-1);
  if (turn !== undefined) {
    const after = closing.slice(turn.index + turn[0].length).replace(/^[\s,;:–—-]+/u, '');
    if (reasonEntriesOf(after).length === 0) return null;
    deciding.push(reasonPlainPickOf(after));
  }
  // Each clause without the word joining it on ("..., but A is funnier overall" weighs "A is funnier overall").
  const clauses = closing
    .split(REASON_CLAUSE_BREAK)
    .map((c) => c.trim().replace(REASON_JOINED, ''))
    .filter((c) => c !== '');
  const naming = clauses.map((c) => new Set(reasonEntriesOf(c).map((n) => n.letter))).filter((s) => s.size > 0);
  const weighed = clauses.filter((c) => REASON_WEIGHED.test(c) && reasonEntriesOf(c).length > 0);
  if (weighed.length > 1) return null;
  if (weighed.length === 1) deciding.push(reasonPlainPickOf(weighed[0]!));
  if (deciding.length > 0) {
    const pick = deciding[0]!;
    return pick !== null && deciding.every((d) => d === pick) ? { pick, closing } : null;
  }
  // Clauses naming the two entries apart, nothing marking which decides: a contrast, never read as one comparison.
  const apart = (letter: 'A' | 'B'): boolean => naming.some((s) => s.size === 1 && s.has(letter));
  if (apart('A') && apart('B')) return null;
  const pick = reasonPlainPickOf(closing);
  return pick === null ? null : { pick, closing };
}

// The reason check's first release (JUDGE_REASON_CHECKS `first`: live 2026-11-23 17:53Z, 6b852f1d, until the release
// after d840d00b), kept word for word so a record its heats made still verifies (cli/verify-result.ts): a refusal is
// recorded in its words. It read an opening A before any unlisted word as the article, a lone entry said for wherever
// the word stood, any -er or "more" word before "than" as over, and missed a reason the tool cut at exactly
// JUDGE_REASON_MAX. Never read live.
const FIRST_BARE_A_AFTER = new RegExp(
  String.raw`^(?:['’]s\b|\s*(?:[)\].,;:!?"”]|$)|\s+${wordsOf([
    'is', 'was', 'wins', 'won', 'edges', 'edged', 'takes', 'took', 'has', 'had', 'does', 'did', 'beats', 'beat', 'outperforms', 'outshines', 'surpasses',
    'prevails', 'remains', 'comes', 'delivers', 'offers', 'nails', 'stands', 'excels', 'leads', 'keeps', 'captures', 'makes', 'shows', 'feels',
    'reads', 'lands', 'scores', 'gets', 'holds', 'loses', 'lost', 'falls', 'lacks', 'fails', 'trails', 'would', 'should', 'could', 'can', 'will',
  ])}\b)`,
  'u',
);
const FIRST_NEGATION = new RegExp(String.raw`(?<![\p{L}])(?:${wordsOf(['not', 'no', 'never', 'neither', 'nor', 'nothing', 'hardly', 'barely'])}|\p{L}+n['’]t)(?![\p{L}])`, 'u');
const FIRST_OVER = new RegExp(
  String.raw`(?<![\p{L}])(?:${wordsOf(['better', 'stronger', 'superior', 'outperforms', 'outshines', 'beats', 'surpasses', 'edges', 'edged', 'over', 'ahead', 'wins', 'preferred', 'preferable'])}|\p{L}+er\s+than|more\s+\p{L}+\s+than)(?![\p{L}])`,
  'u',
);
const FIRST_UNDER = new RegExp(String.raw`(?<![\p{L}])(?:${wordsOf(['worse', 'weaker', 'inferior', 'loses', 'lost', 'falls', 'trails', 'behind', 'less', 'outdone', 'outclassed', 'beaten'])})(?![\p{L}])`, 'u');

/** judgeReasonPickOf as the reason check's first release read it (the paragraph above). */
function reasonPickOfFirst(reason: string, cut: boolean): { pick: 'A' | 'B'; closing: string } | null {
  const sentences = reasonSentencesOf(reason);
  if (cut) sentences.pop();
  const closing = sentences.at(-1);
  if (closing === undefined) return null;
  const declared = REASON_DECLARED.exec(closing);
  const declaredLetter = declared?.[2] as 'A' | 'B' | undefined;
  if (declared !== null && declaredLetter !== undefined && (declaredLetter === 'B' || declared[1] !== undefined || FIRST_BARE_A_AFTER.test(closing.slice(declared.index + declared[0].length)))) {
    return { pick: declaredLetter, closing };
  }
  if (REASON_CONTRAST.test(closing) || FIRST_NEGATION.test(closing)) return null;
  const named = reasonEntriesOf(closing, FIRST_BARE_A_AFTER);
  if (named.length === 1) {
    if (REASON_AGAINST.test(closing) || !REASON_FOR.test(closing)) return null;
    return { pick: named[0]!.letter, closing };
  }
  if (named.length === 2) {
    const [first, second] = named as [{ letter: 'A' | 'B'; index: number }, { letter: 'A' | 'B'; index: number }];
    const between = closing.slice(first.index + 1, second.index);
    const under = FIRST_UNDER.test(between);
    const over = FIRST_OVER.test(between);
    if (under === over) return null;
    return { pick: under ? second.letter : first.letter, closing };
  }
  return null;
}

/**
 * What an answer's text reads as in verdict `format` (default JUDGE_VERDICT_FORMAT): the verdict (a v1 verdict's margin
 * null), or why it is none. The one reading sendJudgeCall takes, and a record's verifier re-reads its bodies with.
 * In v2 (unless `reading.checkReason` is false) a verdict whose reason closes on the other entry (judgeReasonPickOf) is
 * none, as an unparseable answer is: the call asks once more (its forced-tool retry), and a retry that answers so again
 * is recorded with verdict null (the header's `retry`), never the letter its own reason argues against. The check's
 * release is `reading.reasonCheck`'s (default `current`; JUDGE_REASON_CHECKS).
 */
export function judgeVerdictOf(text: string, format: JudgeVerdictFormat = JUDGE_VERDICT_FORMAT, reading: JudgeVerdictReading = {}): JudgeVerdictRead {
  if (!(JUDGE_VERDICT_FORMATS as readonly string[]).includes(format)) throw new RangeError(`verdict format ${JSON.stringify(format)} is not one of ${JUDGE_VERDICT_FORMATS.join(', ')}`);
  const read = answerJsonOf(text);
  if (!read.ok) return { ok: false, why: read.why.toWellFormed() };
  const notOne = (shape: string, error: z.ZodError): JudgeVerdictRead => ({
    ok: false,
    why: judgeText(`not a verdict ${shape}: ${error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`.slice(0, 300)),
  });
  // The reason as the answer gave it reached what the verdict keeps: longer, cut here, or at it, where the tool's own
  // maxLength stopped the model mid-sentence ("... A's punchline is a w"): its last sentence is cut, never its closing.
  const rawReason = isRecord(read.json) && typeof read.json.reason === 'string' ? read.json.reason.trim() : '';
  const against = (winner: 'A' | 'B', reason: string): JudgeVerdictRead | null => {
    const closes = reading.reasonCheck === 'first' ? reasonPickOfFirst(reason, rawReason.length > JUDGE_REASON_MAX) : judgeReasonPickOf(reason, rawReason.length >= JUDGE_REASON_MAX);
    if (closes === null || closes.pick === winner) return null;
    return {
      ok: false,
      why: judgeText(`the verdict names ${winner}, and its reason closes on ${closes.pick}: "${closes.closing.slice(0, 160)}"; a verdict its own reason argues against is none`.slice(0, 300)),
    };
  };
  if (format === 'v1') {
    const v1 = JudgeVerdictAnswerV1.safeParse(read.json);
    if (!v1.success) return notOne('{"winner": "A"|"B", "reason": string}', v1.error);
    if (reading.checkReason === true) {
      const refused = against(v1.data.winner, v1.data.reason);
      if (refused !== null) return refused;
    }
    return { ok: true, winner: v1.data.winner, reason: v1.data.reason, margin: null };
  }
  const v2 = JudgeVerdictAnswer.safeParse(read.json);
  if (!v2.success) return notOne('{"reason": string, "winner": "A"|"B", "margin": 1..5}', v2.error);
  if (reading.checkReason !== false) {
    const refused = against(v2.data.winner, v2.data.reason);
    if (refused !== null) return refused;
  }
  return { ok: true, winner: v2.data.winner, reason: v2.data.reason, margin: v2.data.margin };
}

/** What a judge call sends of the HouseAgent (contracts/competition.ts). */
export type JudgeAgent = Pick<HouseAgentT, 'model' | 'max_output_tokens' | 'reasoning_effort' | 'temperature'>;

/** A heat's media (ProgramJudge.media, contracts/competition.ts PROGRAM_JUDGE_MEDIA). */
export type JudgeMedia = 'text' | 'image' | 'dossier';

/** Every media a heat may judge in, in PROGRAM_JUDGE_MEDIA's order. */
export const JUDGE_MEDIA: readonly JudgeMedia[] = Object.freeze(['text', 'image', 'dossier'] as const);

/** `media`, or a RangeError when it is no JudgeMedia (a record or caller naming another medium is judged in none). */
export function judgeMediaOf(media: string): JudgeMedia {
  if (!(JUDGE_MEDIA as readonly string[]).includes(media)) throw new RangeError(`judge media ${JSON.stringify(media)} is not one of ${JUDGE_MEDIA.join(', ')}`);
  return media as JudgeMedia;
}

/** A heat of `media`, in an admin's words ("a text heat", "an image heat", "a dossier heat"). */
export function judgeHeatNoun(media: JudgeMedia): string {
  switch (judgeMediaOf(media)) {
    case 'text':
      return 'a text heat';
    case 'image':
      return 'an image heat';
    case 'dossier':
      return 'a dossier heat';
  }
}

/** One entry's (or anchor's) artifact, as judged. */
export interface JudgeArtifact {
  /** The sha256 of `bytes` (lowercase hex): what a verdict and the record name. */
  sha256: string;
  /** Its exact bytes. */
  bytes: Uint8Array;
  /**
   * A dossier artifact's judge view (server/judging/dossier-view.ts, dossier-view/v1: itself a dossier, its sha256 the
   * blob the heat setup's judge_view names), which a dossier heat sends in the artifact's place (the header's `user`).
   * Absent: the dossier is sent whole. A text or image heat never reads it.
   */
  view?: { sha256: string; bytes: Uint8Array };
  /**
   * True on a page that carries its judge view alone (judgeViewPage: grader/worker.ts judgeHeatArtifactPages on a view
   * heat): `bytes` is empty and never read, since a dossier heat sends the view in the artifact's place (dossierOf), so
   * judgeArtifactNamed holds it to its view's name alone. Absent on every other artifact, whose `bytes` are its own.
   */
  viewOnly?: true;
}

/**
 * A heat's artifacts read as its calls need them, never held together (the header's `paged`): a final's field
 * (threejs-fps-02's 6,156 dossiers, 411 KB on average, held whole beside their parsed dossiers, took its grader past its
 * 4 GiB heap at every try on 2026-11-17). `shas` names every artifact a call may carry, in the order a list of them
 * would give (what the preflight's ties go by), each once; `get` answers one of them, its bytes and its view held to
 * their names, or on a view heat its view alone (judgeViewPage), the heat checking each as it opens, as it checks a list
 * (judgeArtifactNamed). A store's fault is a plain Error (the job retries it), never a JudgeArtifactRefused.
 */
export interface JudgeArtifactPages {
  readonly shas: readonly string[];
  get(sha256: string): Promise<JudgeArtifact>;
}

/** A heat's artifacts: every one held (a list), or paged (JudgeArtifactPages). */
export type JudgeArtifactsOf = readonly JudgeArtifact[] | JudgeArtifactPages;

/** Whether `artifacts` are paged (JudgeArtifactPages), not a list. */
export function judgeArtifactsPaged(artifacts: JudgeArtifactsOf): artifacts is JudgeArtifactPages {
  return !Array.isArray(artifacts);
}

/**
 * The most artifacts judgeArtifactPager keeps read beside those its calls are carrying: twice a heat's width
 * (grader/worker.ts JUDGE_HEAT_CONCURRENCY, 64), so a call's two are usually still held when the next call of either
 * comes. What a paged heat holds is this many, plus the two of each call in flight: never its field. Not raised with
 * an adaptive final's width (worker.ts JUDGE_FINAL_WIDTH_CEILING, 384): a game's two calls (both slot orders) go out
 * back to back, so the second asks its two while the first holds them (or still reads them), and a member is read once a
 * round at any width; its next ask is another round's, which no keep short of the field holds.
 */
export const JUDGE_ARTIFACT_PAGES_KEPT = 128;

/**
 * JudgeArtifactPages over `shas`, each artifact read by `load` when first asked, the `keep` asked last kept (the
 * oldest dropped past it), one read at a time an artifact (a second ask while it is read waits on the same read). A
 * read that fails is not kept: the next ask reads again. An sha256 not in `shas` is a TypeError.
 */
export function judgeArtifactPager(shas: readonly string[], load: (sha256: string) => Promise<JudgeArtifact>, keep: number = JUDGE_ARTIFACT_PAGES_KEPT): JudgeArtifactPages {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new RangeError(`a pager keeps a whole number of artifacts from 0, got ${keep}`);
  const list = [...shas];
  const known = new Set(list);
  if (known.size !== list.length) throw new TypeError("a heat's paged artifacts name each sha256 once");
  // The reads in flight, and those read: insertion order is recency (an ask moves its artifact to the end), the oldest dropped first.
  const reading = new Map<string, Promise<JudgeArtifact>>();
  const held = new Map<string, Promise<JudgeArtifact>>();
  return {
    shas: list,
    get(sha256) {
      if (!known.has(sha256)) return Promise.reject(new TypeError(`artifact ${sha256} is not one of the heat's paged artifacts`));
      const hit = held.get(sha256);
      if (hit !== undefined) {
        held.delete(sha256);
        held.set(sha256, hit);
        return hit;
      }
      const pending = reading.get(sha256);
      if (pending !== undefined) return pending;
      const read = load(sha256);
      reading.set(sha256, read);
      read.then(
        () => {
          reading.delete(sha256);
          if (keep === 0) return;
          held.set(sha256, read);
          while (held.size > keep) held.delete(held.keys().next().value!);
        },
        () => reading.delete(sha256),
      );
      return read;
    },
  };
}

/** Where every response body is stored before it is read (server/blobstore.ts BlobStore fits). */
export interface JudgeBlobs {
  put(data: Uint8Array): Promise<{ sha256: string }>;
}

/**
 * Which request form an attempt sent (the header): the answer asked for as a response_format (`answer`) and the
 * forced-tool retry (`tool`), or, for a model that takes no forced tool, the answer the system prompt alone asks for
 * (`answer_plain`) and the retry that offers the verdict tool (`tool_auto`, tool_choice auto).
 */
export type JudgeForm = 'answer' | 'tool' | 'answer_plain' | 'tool_auto';

/** A call's two forms in the order sent: its answer, then its retry. */
export type JudgeForms = readonly [answer: JudgeForm, retry: JudgeForm];
/** The forms a call is asked in by default. */
export const JUDGE_FORCED_FORMS = Object.freeze(['answer', 'tool'] as const);
/** The forms a model that takes no forced tool is asked in (judgeFormsOf). */
export const JUDGE_UNFORCED_FORMS = Object.freeze(['answer_plain', 'tool_auto'] as const);
/** Every form a request can be sent in: the preflight weighs the dearest. */
const JUDGE_FORMS: readonly JudgeForm[] = [...JUDGE_FORCED_FORMS, ...JUDGE_UNFORCED_FORMS];

/** An artifact no judge request can carry: text that is not UTF-8, an image of a type masq does not take, or bytes that are no dossier. */
export class JudgeArtifactRefused extends Error {
  readonly sha256: string;
  constructor(sha256: string, message: string) {
    super(message);
    this.name = 'JudgeArtifactRefused';
    this.sha256 = sha256;
  }
}

/** The upstream a judge call went to, by the name its sentences give it: OpenRouter (every judge heat now) or masq. */
export type JudgeFaultUpstream = 'OpenRouter' | 'masq';

/** masq unreachable, an answer whose body could not be read, or a status that is no answer (a key, cap, rate or upstream fault): the platform's failure. */
export class JudgeCallFault extends Error {
  /** The status masq answered; null when no answer was read (masq could not be reached, or its answer's body could not be read: a request sent, perhaps billed, with no attempt to show for it). */
  readonly status: number | null;
  /** The attempts of the call that did complete before the fault (each priced, its body stored). */
  readonly attempts: readonly JudgeAttempt[];
  /**
   * Whether no layer may send the call again (the header's `final`): OpenRouter answered it, and nothing re-sends that
   * answer past the call's transient refusals' re-sends. False for every masq fault, and for a fault OpenRouter never saw
   * (a refused connect), which the heat's one fault re-send may dial again.
   */
  readonly final: boolean;
  /**
   * Whether the upstream never saw the request (the header's `final`): a refused connect (nothing reached it, on any
   * door). Never final: the heat's one fault re-send may dial it again, and a second such fault ends the attempt for the
   * queue, not the heat (grader/worker.ts sendJudgeHeat), whichever upstream it was.
   */
  readonly unseen: boolean;
  /**
   * Whether the upstream began a 2xx answer that ended unread (the header's `timeout`): its body cut or timed out
   * mid-read, or a stream that assembled to no answer; or a request stalled past JUDGE_ANSWER_STALL_MS, its headers
   * included, or still unread past its heat's answer bound (judgeAnswerBoundMs). No verdict was read, so none is chosen
   * against: a heat's sender
   * sends such a call again (grader/worker.ts sendJudgeHeatCalls, the header's `final`), each unread send kept as a
   * faulted spare, JUDGE_PAIR_SENDS_MAX sends in all; the last ends it, and a final heat's attempt then sends the rest
   * of its round before it hands on (sendJudgeHeat's `aside`). Never with `unseen`.
   */
  readonly unread: boolean;
  /**
   * Whether an unread answer was cut at its heat's answer bound (judgeAnswerBoundMs) while its data still came
   * (judgeStallWatch, JUDGE_ANSWER_STREAMING_MS): a runaway generation, told apart from a stall (the stall bound's cut,
   * or a stream silent when the answer bound cut it) and from a body that broke. A heat's adaptive width counts it at its
   * own share (grader/worker.ts JUDGE_FINAL_WIDTH_RUNAWAY_SHARE). Always with `unread`; the message is an unread one's.
   */
  readonly runaway: boolean;
  /** The provider an unread answer's first data chunk named (the header's `timeout`); null when it named none, and on any other fault. */
  readonly provider: string | null;
  /** How the faulted request's answer came, as far as it came (JudgeAnswerTiming); null when no answer's headers came. */
  readonly timing: JudgeAnswerTiming | null;
  /** The upstream the call went to (sendJudgeCall's, openJudgeHeat's); null for a fault made with none named. */
  readonly upstream: JudgeFaultUpstream | null;
  /**
   * Whether the caller's own re-send gate ended the call unsent (JudgeSendOptions.resends, JudgeResendGate: its run over,
   * or its attempt already doomed), not the upstream nor the platform: nothing faulted, so a heat's take never spends its
   * one fault re-send on it nor fails on it, and stops there (grader/worker.ts sendJudgeHeat, the provisional heat, the
   * contender round). Never final, unread or unseen; its status null.
   */
  readonly gated: boolean;
  constructor(
    message: string,
    status: number | null,
    attempts: readonly JudgeAttempt[],
    options?: { cause?: unknown; final?: boolean; unseen?: boolean; unread?: boolean; runaway?: boolean; gated?: boolean; provider?: string | null; timing?: JudgeAnswerTiming | null; upstream?: JudgeFaultUpstream },
  ) {
    // Well-formed (each lone surrogate U+FFFD): a faulted send's spare records this message, which may quote a cut answer.
    super(message.toWellFormed(), options !== undefined && 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'JudgeCallFault';
    this.status = status;
    this.attempts = attempts;
    this.final = options?.final ?? false;
    this.unseen = options?.unseen ?? false;
    this.unread = options?.unread ?? false;
    this.runaway = options?.runaway ?? false;
    if (this.runaway && !this.unread) throw new TypeError('a judge call fault cut as a runaway is an answer left unread');
    this.provider = options?.provider ?? null;
    this.timing = options?.timing ?? null;
    if (this.final && this.unseen) throw new TypeError('a judge call fault the upstream never saw is never final');
    if (this.unread && this.unseen) throw new TypeError('a judge call fault whose answer began was seen by its upstream');
    this.gated = options?.gated ?? false;
    if (this.gated && (this.final || this.unread || this.unseen || status !== null)) throw new TypeError('a judge call its re-send gate ended unsent is no upstream fault: never final, unread or unseen, with no status');
    this.upstream = options?.upstream ?? null;
  }
}

// ------------------------------------------------------------------ the request

const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** The media type an image's magic bytes name (PNG, JPEG, GIF, WebP: what masq's vendors take), or null. */
export function judgeImageType(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** ignoreBOM keeps a leading U+FEFF: the judge sees the entry as submitted, the character the gate counted included. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A text artifact's text: its bytes as UTF-8, or JudgeArtifactRefused. */
function textOf(a: JudgeArtifact): string {
  try {
    return utf8.decode(a.bytes);
  } catch {
    throw new JudgeArtifactRefused(a.sha256, `artifact ${a.sha256} is not UTF-8 text, so a text heat cannot send it`);
  }
}

/** An image artifact's data URL: data:<type>;base64,<its exact bytes>, or JudgeArtifactRefused. */
function dataUrlOf(a: JudgeArtifact): string {
  const type = judgeImageType(a.bytes);
  if (type === null) throw new JudgeArtifactRefused(a.sha256, `artifact ${a.sha256} is not a PNG, JPEG, GIF or WebP image, so an image heat cannot send it`);
  return `data:${type};base64,${Buffer.from(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength).toString('base64')}`;
}

/** Each artifact's bytes' dossier once read: a heat builds the same artifact's content many times (the preflight, each call). */
const dossiers = new WeakMap<Uint8Array, DossierT>();

/**
 * The dossier a dossier heat sends for an artifact (contracts/dossier.ts parseDossier): its judge view's when it carries
 * one (JudgeArtifact.view), else its own; JudgeArtifactRefused naming why the bytes are none.
 */
function dossierOf(a: JudgeArtifact): DossierT {
  const bytes = a.view?.bytes ?? a.bytes;
  const known = dossiers.get(bytes);
  if (known !== undefined) return known;
  let dossier: DossierT;
  try {
    dossier = parseDossier(bytes);
  } catch (err) {
    if (err instanceof DossierRefused) {
      throw new JudgeArtifactRefused(a.sha256, a.view === undefined ? `artifact ${a.sha256} cannot be sent in a dossier heat: ${err.message}` : `artifact ${a.sha256}'s judge view ${a.view.sha256} cannot be sent in a dossier heat: ${err.message}`);
    }
    throw err;
  }
  dossiers.set(bytes, dossier);
  return dossier;
}

/**
 * `artifacts` with each one's judge view attached (JudgeArtifact.view) as a heat setup's judge_view names it
 * (grader/judge-heat.ts JudgeHeatJudgeView: artifact sha256 to view sha256), each view's bytes read by `get` (the blob
 * store: a stored view, never one made again, so a rebuild holds whatever made it) and held to its name. `views`
 * undefined (a setup naming no judge_view): the artifacts as they are, so such a heat sends and rebuilds whole
 * dossiers. A view the setup names that `get` does not answer, or whose bytes hash to another sha256, throws
 * JudgeArtifactRefused: a request built without it would not be the one recorded.
 */
export async function judgeArtifactsViewed(
  artifacts: readonly JudgeArtifact[],
  views: Readonly<Record<string, string>> | undefined,
  get: (sha256: string) => Promise<Uint8Array | null>,
): Promise<JudgeArtifact[]> {
  if (views === undefined) return [...artifacts];
  return Promise.all(
    artifacts.map(async (a) => {
      const sha256 = views[a.sha256];
      if (sha256 === undefined) throw new JudgeArtifactRefused(a.sha256, `the heat's judge_view names no view of artifact ${a.sha256}`);
      const bytes = await get(sha256);
      if (bytes === null) throw new JudgeArtifactRefused(a.sha256, `artifact ${a.sha256}'s judge view ${sha256} is not in the blob store`);
      if (sha256Hex(bytes) !== sha256) throw new JudgeArtifactRefused(a.sha256, `artifact ${a.sha256}'s judge view's bytes hash to ${sha256Hex(bytes)}, not ${sha256}`);
      return { sha256: a.sha256, bytes: a.bytes, view: { sha256, bytes } };
    }),
  );
}

/** A dossier artifact's image `part`'s data URL: data:<its media_type>;base64,<its own canonical base64>, its bytes as written. */
function dossierUrlOf(a: JudgeArtifact, part: number): string {
  const image = dossierOf(a).images[part];
  if (image === undefined) throw new RangeError(`dossier ${a.sha256} has no image ${part}`);
  return `data:${image.media_type};base64,${image.base64}`;
}

/** Image part `part`'s URL of an artifact (its image parts in order; an image artifact is one part, 0). */
type PartUrlOf = (art: JudgeArtifact, part: number) => string;

/** The data URL of each image part of an artifact in `media`: an image's own bytes, a dossier's images[part]; a text has none. */
function partUrlOf(media: JudgeMedia): PartUrlOf {
  switch (judgeMediaOf(media)) {
    case 'image':
      return (art) => dataUrlOf(art);
    case 'dossier':
      return dossierUrlOf;
    case 'text':
      return (art) => {
        throw new TypeError(`a text heat sends no image of artifact ${art.sha256}`);
      };
  }
}

/** The system prompt of a heat: the HouseAgent prompt file's text, then the house's verdict instructions (default JUDGE_VERDICT_INSTRUCTIONS). */
export function judgeSystemPrompt(prompt: string, house: Pick<JudgeHouseText, 'verdict_instructions'> = JUDGE_HOUSE_TEXT): string {
  return `${prompt.trimEnd()}\n\n${house.verdict_instructions}`;
}

export type JudgeContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/**
 * The user message of one call: Entry A (`a`), then Entry B (`b`), in the house text given (default
 * JUDGE_HOUSE_TEXT). Throws JudgeArtifactRefused on an artifact it cannot carry (in a dossier heat, one parseDossier
 * refuses), and RangeError on a media that is no JudgeMedia.
 */
export function judgeUserContent(media: JudgeMedia, a: JudgeArtifact, b: JudgeArtifact, house: JudgeHouseText = JUDGE_HOUSE_TEXT): string | JudgeContentPart[] {
  return userContentOf(media, a, b, partUrlOf(media), house);
}

/** An entry's heading: the template with `{slot}` filled. */
export function judgeEntryHeading(template: string, slot: 'A' | 'B'): string {
  return template.replace(/\{slot\}/g, () => slot);
}

/** A text entry's frame line: the template with `{tag}` and `{slot}` filled, in one pass (a filled value is never read again). */
export function judgeEntryFrame(template: string, tag: string, slot: 'A' | 'B'): string {
  return template.replace(/\{(tag|slot)\}/g, (_, k: string) => (k === 'tag' ? tag : slot));
}

/** A text framed for the judge: the frame line, then the text inside a tag named after it (entryDataTag), nothing filtered or rewritten. */
function framedText(house: JudgeHouseText, slot: 'A' | 'B', text: string): string {
  const tag = entryDataTag(text);
  return [judgeEntryFrame(house.entry_frame, tag, slot), `<${tag}>`, text, `</${tag}>`].join('\n');
}

/** The fewest characters a house text may cut a dossier's text to. */
export const JUDGE_DOSSIER_TEXT_MIN = 1_000;

/**
 * The contests whose judge is sent a compact dossier, and the characters of each dossier's text it is sent (the header's
 * `compact`). Named here, not in the bundle: an open escrow freezes a bundle's bytes. A contender round keeps its chain's text.
 */
export const JUDGE_DOSSIER_TEXT_MAX: Readonly<Record<string, number>> = Object.freeze({ 'threejs-fps-01': 12_000, 'threejs-fps-02': 12_000 });

/** The house text a heat of `slug` judging `media` is set up with now: JUDGE_HOUSE_TEXT, under the contest's dossier cap when it has one. */
export function judgeHouseTextOf(slug: string, media: JudgeMedia): Readonly<JudgeHouseText> {
  const max = Object.hasOwn(JUDGE_DOSSIER_TEXT_MAX, slug) ? JUDGE_DOSSIER_TEXT_MAX[slug] : undefined;
  return max === undefined || judgeMediaOf(media) !== 'dossier' ? JUDGE_HOUSE_TEXT : Object.freeze({ ...JUDGE_HOUSE_TEXT, dossier_text_max: max });
}

/** The characters a cut piece keeps back for its closing fence and its cut line. */
const DOSSIER_CUT_RESERVE = 96;

/** The least a cut file is given: a text with more files than the cap has room for at this each is cut as one piece. */
const DOSSIER_FILE_FLOOR = 2 * DOSSIER_CUT_RESERVE;

/** `piece` in at most `keep` characters: whole when it fits, else its start to a line's end, an open code fence closed, then how much was left out. */
function cutPiece(piece: string, keep: number): string {
  if (piece.length <= keep) return piece;
  let cut = piece.slice(0, Math.max(0, keep - DOSSIER_CUT_RESERVE));
  const line = cut.lastIndexOf('\n');
  if (line > cut.length / 2) cut = cut.slice(0, line);
  // never half a surrogate pair
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const fences = cut.split('\n').filter((l) => l.startsWith('```')).length;
  return `${cut}${fences % 2 === 1 ? '\n```' : ''}\n[cut: ${piece.length - cut.length} more characters not shown]\n\n`;
}

/**
 * A dossier's text as the judge is sent it under a cap of `max` characters (a house text's dossier_text_max; undefined:
 * whole). Whole when it fits; else what stands before its first file heading (a `### ` line, as the dossier libraries
 * write one a file) in up to a quarter of the cap, then the start of every file: the rest shared evenly, a short file's
 * unused share passed on, each cut saying how much it left out. Deterministic, and never longer than `max`.
 */
export function judgeDossierText(text: string, max: number | undefined): string {
  if (max === undefined || text.length <= max) return text;
  if (!Number.isSafeInteger(max) || max < JUDGE_DOSSIER_TEXT_MIN) throw new RangeError(`a dossier's text is cut to a whole number of characters from ${JUDGE_DOSSIER_TEXT_MIN}, got ${max}`);
  const heading = /^### /gm;
  const starts: number[] = [];
  while (heading.exec(text) !== null) starts.push(heading.lastIndex - 4);
  if (starts.length === 0) return cutPiece(text, max);
  const head = cutPiece(text.slice(0, starts[0]), Math.floor(max / 4));
  const files = starts.map((at, i) => text.slice(at, starts[i + 1] ?? text.length));
  // Shortest first: each takes its own length or an even share of the room left, whichever is less.
  const share = new Array<number>(files.length).fill(0);
  let room = max - head.length;
  const order = files.map((f, i) => ({ i, n: f.length })).sort((x, y) => x.n - y.n || x.i - y.i);
  order.forEach((o, k) => {
    const take = Math.min(o.n, Math.floor(room / (order.length - k)));
    share[o.i] = take;
    room -= take;
  });
  if (files.some((f, i) => share[i]! < f.length && share[i]! < DOSSIER_FILE_FLOOR)) return cutPiece(text, max);
  return head + files.map((f, i) => cutPiece(f, share[i]!)).join('');
}

/**
 * judgeUserContent with each image part's URL from `urlOf` (the preflight empties the ones it prices by their pixels):
 * an image heat's two images, each under its entry's heading; a dossier heat's entries each under its heading, its
 * images in order then its text framed as a text entry's; a text heat's one string. RangeError on any other media.
 */
function userContentOf(media: JudgeMedia, a: JudgeArtifact, b: JudgeArtifact, urlOf: PartUrlOf, house: JudgeHouseText): string | JudgeContentPart[] {
  const medium = judgeMediaOf(media);
  if (medium === 'image') {
    return [
      { type: 'text', text: judgeEntryHeading(house.entry_heading, 'A') },
      { type: 'image_url', image_url: { url: urlOf(a, 0) } },
      { type: 'text', text: judgeEntryHeading(house.entry_heading, 'B') },
      { type: 'image_url', image_url: { url: urlOf(b, 0) } },
      { type: 'text', text: house.answer_line },
    ];
  }
  if (medium === 'dossier') {
    const entry = (slot: 'A' | 'B', art: JudgeArtifact): JudgeContentPart[] => {
      const dossier = dossierOf(art);
      return [
        { type: 'text', text: judgeEntryHeading(house.entry_heading, slot) },
        ...dossier.images.map((_, part): JudgeContentPart => ({ type: 'image_url', image_url: { url: urlOf(art, part) } })),
        { type: 'text', text: framedText(house, slot, judgeDossierText(dossier.text, house.dossier_text_max)) },
      ];
    };
    return [...entry('A', a), ...entry('B', b), { type: 'text', text: house.answer_line }];
  }
  const block = (slot: 'A' | 'B', art: JudgeArtifact): string => {
    const text = textOf(art);
    const tag = entryDataTag(text);
    return [judgeEntryHeading(house.entry_heading, slot), judgeEntryFrame(house.entry_frame, tag, slot), `<${tag}>`, text, `</${tag}>`].join('\n');
  };
  return [block('A', a), '', block('B', b), '', house.answer_line].join('\n');
}

/** The verdict tool a retry names (`tool`) or offers (`tool_auto`), under the house text's description, its parameters `schema`. */
function verdictTool(description: string, schema: ReturnType<typeof judgeVerdictSchema>): Record<string, unknown> {
  return { type: 'function', function: { name: JUDGE_VERDICT_TOOL, description, parameters: schema } };
}

/**
 * The chat-completions body of one request (deterministic: the same input gives the same bytes, so a
 * record's request_sha256 can be checked against its artifacts): the two messages and max_tokens,
 * temperature when the HouseAgent sets one, reasoning_effort when it names one (none on superbot-fast
 * otherwise), then by form (the header): `answer` asks for the verdict as a response_format, `tool`
 * forces the named verdict tool, `answer_plain` adds nothing (the system prompt asks for the JSON), and
 * `tool_auto` offers the verdict tool with tool_choice auto. The tool is described in `house`'s words
 * (default JUDGE_HOUSE_TEXT): the heat setup's house_text, as the user message is. The verdict's schema
 * (the json_schema's and the tool's) is `verdict`'s (default JUDGE_VERDICT_FORMAT): a record's own
 * (grader/judge-heat.ts judgeHeatVerdictFormat of its format), so an agent-fun/judge-heat/v1 record's
 * requests rebuild in v1's schema. `dialect` `messages` is the body the Messages request is made of (the
 * header's `dialect`): its `answer` asks the verdict's json_schema of every model, as structured output.
 */
export function judgeRequestBody(
  agent: JudgeAgent,
  system: string,
  user: string | JudgeContentPart[],
  form: JudgeForm,
  house: Pick<JudgeHouseText, 'verdict_tool_description'> = JUDGE_HOUSE_TEXT,
  verdict: JudgeVerdictFormat = JUDGE_VERDICT_FORMAT,
  dialect: MasqDialect = 'chat',
): Record<string, unknown> {
  const schema = judgeVerdictSchema(verdict);
  const superbot = masqSkipsJsonMode(agent.model);
  const effort = agent.reasoning_effort ?? (superbot ? SUPERBOT_UNNAMED_EFFORT : undefined);
  const base: Record<string, unknown> = {
    model: agent.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: agent.max_output_tokens,
    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
  };
  if (form === 'tool') return { ...base, tools: [verdictTool(house.verdict_tool_description, schema)], tool_choice: { type: 'function', function: { name: JUDGE_VERDICT_TOOL } } };
  if (form === 'tool_auto') return { ...base, tools: [verdictTool(house.verdict_tool_description, schema)], tool_choice: 'auto' };
  if (form === 'answer_plain') return base;
  return {
    ...base,
    response_format: superbot || dialect === 'messages' ? { type: 'json_schema', json_schema: { name: JUDGE_VERDICT_TOOL, strict: false, schema } } : { type: 'json_object' },
  };
}

/**
 * The request one attempt sends (the header's `dialect`): on Messages when grader/dialect.ts can say judgeRequestBody's
 * `messages` body (a Claude model's, its images as data URLs), else judgeRequestBody's body on Chat Completions, the
 * bytes every judge request was before. Deterministic, as judgeRequestBody is.
 */
export function judgeWire(
  agent: JudgeAgent,
  system: string,
  user: string | JudgeContentPart[],
  form: JudgeForm,
  house: Pick<JudgeHouseText, 'verdict_tool_description'> = JUDGE_HOUSE_TEXT,
  verdict: JudgeVerdictFormat = JUDGE_VERDICT_FORMAT,
): MasqWire {
  return masqWire(judgeRequestBody(agent, system, user, form, house, verdict), judgeRequestBody(agent, system, user, form, house, verdict, 'messages'));
}

/**
 * The bytes a stored request sent in `dialect` rebuilds to (a verifier's: a record holds no dialect, its request_sha256
 * tells which it was): Chat Completions' judgeRequestBody, the Messages body judgeWire sends, or
 * superbot-router's streamed body of the Chat Completions one, on Chat Completions (ROUTER_DIALECT) or on Messages
 * (ROUTER_MESSAGES_DIALECT: routerRequestJsonIn; what an older release sent a router heat on, kept so its records
 * re-derive: the header's `no router`), or OpenRouter's on `pin` (OPENROUTER_DIALECT: the header's `openrouter`); null
 * when the request cannot be said on Messages.
 */
export function judgeRequestJson(
  dialect: MasqDialect | typeof ROUTER_DIALECT | typeof ROUTER_MESSAGES_DIALECT | typeof OPENROUTER_DIALECT,
  agent: JudgeAgent,
  system: string,
  user: string | JudgeContentPart[],
  form: JudgeForm,
  house: Pick<JudgeHouseText, 'verdict_tool_description'> = JUDGE_HOUSE_TEXT,
  verdict: JudgeVerdictFormat = JUDGE_VERDICT_FORMAT,
  /** OPENROUTER_DIALECT's pin (the header's `openrouter`): the bytes openRouterRequestJson makes of the `messages` body on it. */
  pin?: Pick<JudgePin, 'providers'>,
): string | null {
  if (dialect === OPENROUTER_DIALECT) {
    if (pin === undefined) throw new TypeError('an OpenRouter request rebuilds on its pin');
    return openRouterRequestJson(judgeRequestBody(agent, system, user, form, house, verdict, 'messages'), pin);
  }
  if (dialect === 'chat') return JSON.stringify(judgeRequestBody(agent, system, user, form, house, verdict));
  if (dialect === ROUTER_DIALECT || dialect === ROUTER_MESSAGES_DIALECT) return routerRequestJsonIn(dialect, judgeRequestBody(agent, system, user, form, house, verdict));
  return masqMessagesBody(judgeRequestBody(agent, system, user, form, house, verdict, 'messages'));
}

// ------------------------------------------------------------------ an image's tokens
//
// The preflight prices an image by its pixels, never by its data URL's bytes (a 1 MiB 1024 × 1024 PNG is
// ~466,000 tokens at BYTES_PER_INPUT_TOKEN, and bills ~1,400): at the most that any vendor rule masq can
// bill the pinned model by charges an image of its size. The rules as published (read 2026-11-06):
//
//   anthropic  ⌈w/28⌉ × ⌈h/28⌉ visual tokens, after a downscale to fit the model's tier (high-resolution,
//              Claude 4.7 and later: 2,576 px and 4,784 tokens; standard: 1,568 px and 1,568), so at most
//              4,784. https://platform.claude.com/docs/en/build-with-claude/vision
//   openai     patches: ⌈w/32⌉ × ⌈h/32⌉ (auto keeps an image's size on the newest models; past 30,000
//              patches the request is refused) × the model's multiplier (1.2, or OPENAI_PATCH_MULTIPLIERS);
//              tiles: fit 2048 × 2048, the shortest side to 768, base + each 512-px tile (85 + 170, or
//              gpt-4o-mini's 2,833 + 5,667). The larger of the two.
//              https://developers.openai.com/api/docs/guides/images-vision
//   google     ≤ 384 px both ways 258; larger, 258 a 768 × 768 tile; Gemini 3 and 4 allot an image 1,120
//              at the default media resolution. The larger of the two.
//              https://ai.google.dev/gemini-api/docs/tokens, https://ai.google.dev/gemini-api/docs/media-resolution
//
// masq's own image estimate (masq src/token-mix.ts imageVisualTokens) reads the same constants for its
// token mix; it estimates, where these bound (it keeps OpenAI to a 6,144-patch budget, auto does not).
// A judge request is never sent across vendors (x-masq-policy: off), so a claude-*, gpt-* / o<n> or
// gemini-* model is bounded by its own vendor's rule, and any other id (superbot-fast, an alias) by all three.

/** An image's size in pixels. */
export interface JudgeImageSize {
  width: number;
  height: number;
}

type ImageFamily = 'anthropic' | 'openai' | 'google';

/** OpenAI's patch multipliers other than its 1.2, by model id prefix. */
const OPENAI_PATCH_MULTIPLIERS: readonly (readonly [RegExp, number])[] = [
  [/^gpt-4\.1-nano/, 2.46],
  [/^o4-mini/, 1.72],
  [/^gpt-4\.1-mini/, 1.62],
  [/^gpt-5-nano/, 1.5],
];

const sizeOf = (width: number, height: number): JudgeImageSize | null => (width >= 1 && height >= 1 ? { width, height } : null);

/** A JPEG's frame size: its first SOFn segment's, walking the segments from SOI (null at SOS or EOI first, or a broken segment). */
function jpegSize(b: Buffer): JudgeImageSize | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) {
      i += 1; // a fill byte
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2; // TEM, RSTn, SOI: no length
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0–SOF15, but DHT (C4), JPG (C8) and DAC (CC): length, precision, then height and width.
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return i + 9 <= b.length ? sizeOf(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)) : null;
    i += 2 + len;
  }
  return null;
}

/** A WebP's canvas size: its VP8 frame header's, VP8L's, or VP8X's. */
function webpSize(b: Buffer): JudgeImageSize | null {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return sizeOf(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return sizeOf((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X' && b.length >= 30) return sizeOf(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  return null;
}

/** An image's pixel size as its header gives it (PNG IHDR, JPEG SOFn, GIF's logical screen, WebP VP8/VP8L/VP8X), or null when it does not read. */
export function judgeImageSize(bytes: Uint8Array): JudgeImageSize | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (judgeImageType(b)) {
    case 'image/png':
      return b.length >= 24 && b.readUInt32BE(8) === 13 && b.toString('latin1', 12, 16) === 'IHDR' ? sizeOf(b.readUInt32BE(16), b.readUInt32BE(20)) : null;
    case 'image/jpeg':
      return jpegSize(b);
    case 'image/gif':
      return b.length >= 10 ? sizeOf(b.readUInt16LE(6), b.readUInt16LE(8)) : null;
    case 'image/webp':
      return webpSize(b);
    default:
      return null;
  }
}

/** The most one w × h image bills on `model` under `family`'s rule (the section header). */
function familyImageTokens(family: ImageFamily, model: string, w: number, h: number): number {
  switch (family) {
    case 'anthropic':
      return Math.min(Math.ceil(w / 28) * Math.ceil(h / 28), 4784);
    case 'openai': {
      const multiplier = OPENAI_PATCH_MULTIPLIERS.find(([re]) => re.test(model))?.[1] ?? 1.2;
      const patches = Math.ceil(Math.min(Math.ceil(w / 32) * Math.ceil(h / 32), 30_000) * multiplier);
      // Fit 2048 × 2048, then the shortest side to 768; pixels rounded up, so no rounding of OpenAI's counts more tiles.
      let s = Math.min(1, 2048 / Math.max(w, h));
      s *= Math.min(1, 768 / Math.min(w * s, h * s));
      const tiles = Math.ceil(Math.ceil(w * s) / 512) * Math.ceil(Math.ceil(h * s) / 512);
      const [base, tile] = model.startsWith('gpt-4o-mini') ? [2833, 5667] : [85, 170];
      return Math.max(patches, base + tile * tiles);
    }
    case 'google':
      return Math.max(258 * (w <= 384 && h <= 384 ? 1 : Math.ceil(w / 768) * Math.ceil(h / 768)), 1120);
  }
}

/**
 * The most input tokens one image of `size` bills on `model`: the largest of the vendor rules masq can
 * bill it by (the section header), its own vendor's for a claude-*, gpt-* / o<n> or gemini-* id, all three
 * for any other.
 */
export function judgeImageTokens(model: string, size: JudgeImageSize): number {
  const id = model.toLowerCase();
  const families: readonly ImageFamily[] = id.startsWith('claude') ? ['anthropic'] : /^(gpt|chatgpt|o\d)/.test(id) ? ['openai'] : id.startsWith('gemini') ? ['google'] : ['anthropic', 'openai', 'google'];
  return Math.max(...families.map((f) => familyImageTokens(f, id, size.width, size.height)));
}

// ------------------------------------------------------------------ the holds

/** Why a heat does not start: its model is unpriced, or masq's card says it cannot see images. */
export interface JudgeHold {
  kind: 'unpriced' | 'vision';
  /** What holds it, in an admin's words. */
  why: string;
}

/** The preflight's figures (µUSD). */
export interface JudgeBudget {
  /** The heat's planned calls (judgeHeatCalls). */
  calls: number;
  /** calls × JUDGE_CALL_ATTEMPTS: the most requests the heat sends. */
  requests: number;
  /** The largest request body any call can send, bytes (the two largest artifacts, the larger form). */
  bodyBytes: number;
  /**
   * The most input tokens any call's request can carry (the two dearest artifacts, the larger form): its
   * text and JSON at BYTES_PER_INPUT_TOKEN bytes a token, each image at judgeImageTokens of its size (one
   * whose size does not read, judgeImageSize null, at its data URL's bytes).
   */
  inputTokens: number;
  /** worstCaseMicroUsd of inputTokens and max_output_tokens; null for an unpriced model. */
  requestMicroUsd: bigint | null;
  /** requests × requestMicroUsd; null for an unpriced model. */
  worstMicroUsd: bigint | null;
}

export interface JudgePreflightInput {
  agent: JudgeAgent;
  /** judgeSystemPrompt's text. */
  system: string;
  media: JudgeMedia;
  /** The house text the user messages are framed in (default JUDGE_HOUSE_TEXT): the heat setup's house_text. */
  house?: JudgeHouseText;
  /** Every artifact a call of the heat may carry. */
  artifacts: readonly JudgeArtifact[];
  /** The heat's planned calls (judgeHeatCalls). */
  calls: number;
  /** The pricing instant, ISO 8601. */
  at: string;
  /** `allow`: an unpriced model is no hold, its dollar figures null (an OpenRouter heat: the header's `openrouter`). Default `hold`. */
  unpriced?: 'hold' | 'allow';
  /** An OpenRouter heat's pin: its bodies (openRouterRequestJson) are weighed beside the others. */
  pin?: Pick<JudgePin, 'providers'>;
}

// ------------------------------------------------------------------ the preflight's sizes
//
// The preflight weighs every body a call can send (each form, each wire) for the heat's largest and dearest pair, and
// ranks every artifact by its user content's size: built whole, each a JSON of megabytes of base64 images, that held a
// grader's event loop 275-557 ms a heat (2026-11-13). It never builds them whole. An image part's URL is
// `data:<type>;base64,<payload>`, and every body says that payload verbatim some fixed number of times (a JSON string
// escapes none of base64's characters; Messages' image block takes the payload as it is), so a body's bytes are linear
// in the payload's length: the same content built twice with a short stand-in payload of each part (STAND_IN_FILLS
// `A`s, valid base64 every wire takes as the real one) gives the line, and the real payloads' lengths (an image's
// 4 * ceil(bytes / 3), a dossier image's canonical base64's) give each body's bytes, exactly. A pair of stand-ins that
// does not give a whole number of copies per part is no line: that body is built whole.

/** The two stand-in payload lengths, in base64 characters (each a whole number of quanta). */
const STAND_IN_FILLS = [4, 8] as const;

/** An image part's URL as the preflight sizes it: its prefix (`data:<type>;base64,`) and its payload's length. */
interface SizedPart {
  prefix: string;
  payload: number;
}

/** An image part's SizedPart, or null for a part whose URL is used as it is (a priced part's empty one). */
type SizedPartOf = (art: JudgeArtifact, part: number) => SizedPart | null;

/** An image artifact's SizedPart: its data URL's prefix and its base64's length, the image never encoded. JudgeArtifactRefused as dataUrlOf. */
function imageSizedPart(a: JudgeArtifact): SizedPart {
  const type = judgeImageType(a.bytes);
  if (type === null) throw new JudgeArtifactRefused(a.sha256, `artifact ${a.sha256} is not a PNG, JPEG, GIF or WebP image, so an image heat cannot send it`);
  return { prefix: `data:${type};base64,`, payload: 4 * Math.ceil(a.bytes.byteLength / 3) };
}

/** A dossier artifact's image `part`'s SizedPart: its canonical base64 (parseDossier checks it) is the payload. */
function dossierSizedPart(a: JudgeArtifact, part: number): SizedPart {
  const image = dossierOf(a).images[part];
  if (image === undefined) throw new RangeError(`dossier ${a.sha256} has no image ${part}`);
  return { prefix: `data:${image.media_type};base64,`, payload: image.base64.length };
}

/**
 * The byte lengths `lengths` gives the content `build` makes with each image part's real URL (`urlOf`), where
 * `sized` names a part's SizedPart (the section header): from two stand-in builds, else from the real one.
 */
function sizedLengths(build: (urlOf: PartUrlOf) => string | JudgeContentPart[], urlOf: PartUrlOf, sized: SizedPartOf | null, lengths: (user: string | JudgeContentPart[]) => number[]): number[] {
  if (sized === null) return lengths(build(urlOf));
  const probe = (fill: number) => {
    const stub = 'A'.repeat(fill);
    let parts = 0;
    let payload = 0;
    const user = build((art, part) => {
      const p = sized(art, part);
      if (p === null) return urlOf(art, part);
      parts++;
      payload += p.payload;
      return p.prefix + stub;
    });
    return { parts, payload, lengths: lengths(user) };
  };
  const [lo, hi] = STAND_IN_FILLS;
  const a = probe(lo);
  if (a.parts === 0) return a.lengths;
  const b = probe(hi);
  const step = (hi - lo) * a.parts;
  const out: number[] = [];
  for (let i = 0; i < a.lengths.length; i++) {
    const rise = b.lengths[i]! - a.lengths[i]!;
    // each part said `copies` times in this body; a rise that is no whole number of copies is no line: build it whole
    if (b.parts !== a.parts || b.payload !== a.payload || rise < 0 || rise % step !== 0) return lengths(build(urlOf));
    const copies = rise / step;
    out.push(a.lengths[i]! + copies * (a.payload - lo * a.parts));
  }
  return out;
}

/** How much of a dossier image's base64 the preflight decodes first to read its size: 64 KiB of bytes (a multiple of 4 characters). */
const SIZE_PREFIX_CHARS = 4 * Math.ceil((64 * 1024) / 3);

/**
 * A dossier image's pixel size (judgeImageSize of its bytes), decoding only the start of its canonical base64 when the
 * size reads there (a header reads the same bytes in the same order on a prefix, and answers no size where it would
 * read past it), else all of it.
 */
function dossierImageSize(base64: string): JudgeImageSize | null {
  if (base64.length > SIZE_PREFIX_CHARS) {
    const size = judgeImageSize(Buffer.from(base64.slice(0, SIZE_PREFIX_CHARS), 'base64'));
    if (size !== null) return size;
  }
  return judgeImageSize(Buffer.from(base64, 'base64'));
}

/**
 * The heat's worst case (the header): its figures, and the hold when the model is unpriced (null otherwise, and with
 * `unpriced: 'allow'`). Throws JudgeArtifactRefused on an artifact no call can carry.
 */
export function judgePreflight(input: JudgePreflightInput): { budget: JudgeBudget; hold: JudgeHold | null } {
  const core = preflightCore(input);
  for (const a of input.artifacts) core.measure(a);
  // A body is its framing plus each artifact's part, so the largest (and the dearest) is the two largest
  // (dearest) parts' in either order and either form.
  const two = (n: (a: JudgeArtifact) => number): [JudgeArtifact, JudgeArtifact] | null => {
    const ranked = input.artifacts.map((a) => ({ a, n: n(a) })).sort((x, y) => y.n - x.n);
    const first = ranked[0]?.a;
    return first === undefined ? null : [first, ranked[1]?.a ?? first];
  };
  const largest = two(core.largestOf);
  const dearest = two(core.dearestOf);
  return core.end(largest, dearest);
}

/**
 * The two artifacts a list's stable sort by `n` (descending) ranks first, met one at a time (the header's `paged`):
 * the first met of the greatest n, then the next met of an equal n, else the first met of the next greatest.
 */
class TopTwo {
  first: { a: JudgeArtifact; n: number } | null = null;
  second: { a: JudgeArtifact; n: number } | null = null;
  offer(a: JudgeArtifact, n: number): void {
    if (this.first === null) this.first = { a, n };
    else if (n > this.first.n) {
      this.second = this.first;
      this.first = { a, n };
    } else if (this.second === null || n > this.second.n) this.second = { a, n };
  }
  holds(a: JudgeArtifact): boolean {
    return this.first?.a === a || this.second?.a === a;
  }
  pair(): [JudgeArtifact, JudgeArtifact] | null {
    return this.first === null ? null : [this.first.a, (this.second ?? this.first).a];
  }
}

/**
 * judgePreflight of each of `inputs` (one a judge: a pool heat's) over paged artifacts (the header's `paged`): every
 * artifact of `pages` read in turn, held to its name (its bytes' sha256, and its view's: JudgeArtifactRefused, as
 * openJudgeHeat refuses a list's), weighed by every input, then dropped but for the two largest and the two dearest each
 * input has met. Its answers are judgePreflight's on a list of the same artifacts in the same order, figure for figure;
 * an artifact no call can carry is refused as it reaches it. The inputs' own `artifacts` are not read.
 */
export async function judgePreflightsPaged(inputs: readonly Omit<JudgePreflightInput, 'artifacts'>[], pages: JudgeArtifactPages): Promise<{ budget: JudgeBudget; hold: JudgeHold | null }[]> {
  const cores = inputs.map((input) => ({ core: preflightCore(input), largest: new TopTwo(), dearest: new TopTwo() }));
  for (const sha256 of pages.shas) {
    const a = await pages.get(sha256);
    judgeArtifactNamed(a, sha256);
    for (const c of cores) {
      c.core.measure(a);
      c.largest.offer(a, c.core.largestOf(a));
      c.dearest.offer(a, c.core.dearestOf(a));
      // What is weighed of an artifact no longer ranked goes with it: its page is free to drop.
      for (const held of [...c.core.measured()]) if (!c.largest.holds(held) && !c.dearest.holds(held)) c.core.forget(held);
    }
  }
  return cores.map((c) => c.core.end(c.largest.pair(), c.dearest.pair()));
}

/** The pages judgeViewPage made: each one's view read and held to its name by its reader, so not hashed again. */
const viewPagesHeld = new WeakSet<JudgeArtifact>();

/**
 * Artifact `sha256`'s page on a view heat (JudgeArtifact.viewOnly): its judge view `view` alone, no artifact bytes, as
 * a dossier heat sends the view in the artifact's place (dossierOf) and its request, request_sha256 and record are built
 * from the view. `view.bytes` must be those its reader held to `view.sha256` as it read them (grader/worker.ts
 * judgeHeatArtifactPages: the store's read, hashed once and off the loop by judgeHeatMemberRead, a gone or rotted view
 * the store's fault), which judgeArtifactNamed takes as held and hashes no more. The page and its view are frozen.
 */
export function judgeViewPage(sha256: string, view: { sha256: string; bytes: Uint8Array }): JudgeArtifact {
  const page: JudgeArtifact = Object.freeze({ sha256, bytes: new Uint8Array(0), view: Object.freeze({ sha256: view.sha256, bytes: view.bytes }), viewOnly: true as const });
  viewPagesHeld.add(page);
  return page;
}

/**
 * JudgeArtifactRefused unless artifact `a` is `sha256`'s and its bytes (and its view's) hash to their names: what
 * openJudgeHeat and the pool's preflight hold every artifact to before anything is minted. A page carrying its view
 * alone (JudgeArtifact.viewOnly) is held to its view's name alone: one judgeViewPage made was held as it was read, and
 * is hashed no more; any other is hashed here. Such a page with no view is a TypeError.
 */
export function judgeArtifactNamed(a: JudgeArtifact, sha256: string = a.sha256): void {
  if (a.sha256 !== sha256) throw new TypeError(`artifact ${sha256} was asked, and ${a.sha256} answered`);
  if (a.viewOnly === true) {
    if (a.view === undefined) throw new TypeError(`artifact ${a.sha256} is paged as its judge view alone, and carries no view`);
    if (!viewPagesHeld.has(a) && sha256Hex(a.view.bytes) !== a.view.sha256) throw new JudgeArtifactRefused(a.sha256, `artifact ${a.sha256}'s judge view's bytes hash to ${sha256Hex(a.view.bytes)}, not its name ${a.view.sha256}`);
    return;
  }
  if (sha256Hex(a.bytes) !== a.sha256) throw new JudgeArtifactRefused(a.sha256, `artifact ${a.sha256}'s bytes hash to ${sha256Hex(a.bytes)}, not its name`);
  if (a.view !== undefined && sha256Hex(a.view.bytes) !== a.view.sha256) throw new JudgeArtifactRefused(a.sha256, `artifact ${a.sha256}'s judge view's bytes hash to ${sha256Hex(a.view.bytes)}, not its name ${a.view.sha256}`);
}

/**
 * The preflight of `input` but its artifacts (judgePreflight, judgePreflightsPaged): `measure` reads an artifact's
 * image parts' tokens (JudgeArtifactRefused on a dossier that does not parse), `largestOf` and `dearestOf` rank it,
 * `forget` drops what was measured of it, and `end` weighs the two largest and the two dearest.
 */
function preflightCore(input: Omit<JudgePreflightInput, 'artifacts'>): {
  measure(a: JudgeArtifact): void;
  measured(): Iterable<JudgeArtifact>;
  forget(a: JudgeArtifact): void;
  largestOf(a: JudgeArtifact): number;
  dearestOf(a: JudgeArtifact): number;
  end(largest: [JudgeArtifact, JudgeArtifact] | null, dearest: [JudgeArtifact, JudgeArtifact] | null): { budget: JudgeBudget; hold: JudgeHold | null };
} {
  if (!Number.isSafeInteger(input.calls) || input.calls < 0) throw new RangeError(`a heat's planned calls are a whole number from 0, got ${input.calls}`);
  const requests = input.calls * JUDGE_CALL_ATTEMPTS;
  // An image part whose size reads (an image artifact, or each image of a dossier) is priced by its pixels: its URL is
  // emptied from the body, and its tokens enter the gateway's pricing as BYTES_PER_INPUT_TOKEN bytes each. Everything
  // else (a text, a dossier's text, the framing) prices by its bytes. Each artifact's parts' tokens, null where unread.
  const media = judgeMediaOf(input.media);
  const partTokens = new Map<JudgeArtifact, readonly (number | null)[]>();
  const tokensOf = (size: JudgeImageSize | null): number | null => (size === null ? null : judgeImageTokens(input.agent.model, size));
  const measure = (a: JudgeArtifact): void => {
    if (media === 'image') partTokens.set(a, [tokensOf(judgeImageSize(a.bytes))]);
    else if (media === 'dossier') partTokens.set(a, dossierOf(a).images.map((image) => tokensOf(dossierImageSize(image.base64))));
  };
  const urlOf = partUrlOf(media);
  const priced = (art: JudgeArtifact, part: number): boolean => (partTokens.get(art)?.[part] ?? null) !== null;
  const pricedUrl = (art: JudgeArtifact, part: number): string => (priced(art, part) ? '' : urlOf(art, part));
  // Each part's URL sized, never encoded (the section above): every part for the bodies as sent, the unpriced ones for the priced bodies.
  const sizedPart: SizedPartOf | null = media === 'image' ? (art) => imageSizedPart(art) : media === 'dossier' ? dossierSizedPart : null;
  const sizedUnpriced: SizedPartOf | null = sizedPart === null ? null : (art, part) => (priced(art, part) ? null : sizedPart(art, part));
  const contentBytes = (user: string | JudgeContentPart[]): number[] => [Buffer.byteLength(JSON.stringify(user))];
  const pixelBytes = (...arts: JudgeArtifact[]): number => arts.reduce((n, art) => n + (partTokens.get(art) ?? []).reduce<number>((m, t) => m + (t ?? 0), 0) * BYTES_PER_INPUT_TOKEN, 0);
  const house = input.house ?? JUDGE_HOUSE_TEXT;
  // Either dialect's body, whichever is larger (a superbot request has the one), and superbot-router's streamed one for a
  // model the router serves (a budget weighed for such a judge keeps the figure an older release's router heat weighed;
  // openJudgeHeat opens none: the header's `no router`).
  const routed = routerServesModel(input.agent.model);
  const bodyLengths = (user: string | JudgeContentPart[]): number[] =>
    JUDGE_FORMS.flatMap((form) => [
      Buffer.byteLength(JSON.stringify(judgeRequestBody(input.agent, input.system, user, form, house))),
      Buffer.byteLength(judgeWire(input.agent, input.system, user, form, house).body),
      ...(routed ? [Buffer.byteLength(routerRequestJson(judgeRequestBody(input.agent, input.system, user, form, house))), Buffer.byteLength(routerWire(judgeRequestBody(input.agent, input.system, user, form, house)).body)] : []),
      ...(input.pin !== undefined ? [Buffer.byteLength(openRouterRequestJson(judgeRequestBody(input.agent, input.system, user, form, house, JUDGE_VERDICT_FORMAT, 'messages'), input.pin))] : []),
    ]);
  const bodyOf = (build: (urlOf: PartUrlOf) => string | JudgeContentPart[], urls: PartUrlOf, sized: SizedPartOf | null): number => Math.max(...sizedLengths(build, urls, sized, bodyLengths));
  // JSON.stringify(judgeUserContent(media, a, a, house)) and the priced content's bytes, sized the same way
  const largestOf = (a: JudgeArtifact): number => sizedLengths((u) => userContentOf(input.media, a, a, u, house), urlOf, sizedPart, contentBytes)[0]!;
  const dearestOf = (a: JudgeArtifact): number => sizedLengths((u) => userContentOf(input.media, a, a, u, house), pricedUrl, sizedUnpriced, contentBytes)[0]! + pixelBytes(a, a);
  const end = (largest: [JudgeArtifact, JudgeArtifact] | null, dearest: [JudgeArtifact, JudgeArtifact] | null): { budget: JudgeBudget; hold: JudgeHold | null } => {
    const bodyBytes = largest === null ? 0 : bodyOf((u) => userContentOf(input.media, ...largest, u, house), urlOf, sizedPart);
    const inputBytes = dearest === null ? 0 : bodyOf((u) => userContentOf(input.media, ...dearest, u, house), pricedUrl, sizedUnpriced) + pixelBytes(...dearest);
    const inputTokens = Math.ceil(inputBytes / BYTES_PER_INPUT_TOKEN);
    const budget: JudgeBudget = { calls: input.calls, requests, bodyBytes, inputTokens, requestMicroUsd: null, worstMicroUsd: null };
    let one: bigint;
    try {
      one = worstCaseMicroUsd({ model: input.agent.model, at: input.at, body_bytes: inputBytes, output_tokens: input.agent.max_output_tokens }).micro_usd;
    } catch (err) {
      if (input.unpriced === 'allow') return { budget, hold: null };
      return {
        budget,
        hold: { kind: 'unpriced', why: `the judge model ${input.agent.model} cannot be priced (${err instanceof Error ? err.message : String(err)}), so no worst case bounds the heat` },
      };
    }
    budget.requestMicroUsd = one;
    budget.worstMicroUsd = one * BigInt(requests);
    return { budget, hold: null };
  };
  return { measure, measured: () => partTokens.keys(), forget: (a) => void partTokens.delete(a), largestOf, dearestOf, end };
}

// The model list masq answers (openai dialect): each card's id and capabilities, read leniently.
const ModelList = z.object({
  data: z.array(z.object({ id: z.string(), capabilities: z.object({ supports_vision: z.unknown().optional() }).loose().nullable().optional() }).loose()),
});

/** Where a heat's key and calls are: masq, or OpenRouter (the header's `openrouter`). */
export type JudgeUpstream = 'masq' | 'openrouter';

export interface JudgeVisionOptions {
  /** masq's origin (MAKEFUN_LLM_GATEWAY_URL). */
  origin: string;
  /** Who answers at `origin`, as a fault names it (default masq). */
  upstream?: JudgeUpstream;
  /** The heat's judge key. */
  apiKey: string;
  /** The pinned model. */
  model: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** The model list read's bound, ms (default MASQ_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** The pinned model's card in masq's model list: its exact id, else a release-dated alias of it (isServedModel); null when masq lists none. */
export function judgeModelCard(cards: readonly MasqModelCard[], model: string): MasqModelCard | null {
  return cards.find((m) => m.id === model) ?? cards.find((m) => isServedModel(model, m.id)) ?? null;
}

/** A card's capability `name` as masq's card spells it; undefined when the card carries none. */
function capabilityOf(card: MasqModelCard, name: string): unknown {
  return isRecord(card.capabilities) ? card.capabilities[name] : undefined;
}

/**
 * The card an image heat's vision is read from (the header): the pinned model's (judgeModelCard), else the card of the
 * first id masq routes it to that masq lists (server/house-model.ts masqAllowedModels, the model itself first); null
 * when masq lists none of them.
 */
export function judgeVisionCard(cards: readonly MasqModelCard[], model: string): MasqModelCard | null {
  for (const id of masqAllowedModels(model)) {
    const card = judgeModelCard(cards, id);
    if (card !== null) return card;
  }
  return null;
}

/**
 * The vision hold of an image (or dossier) heat on its model's card (the header; judgeVisionCard): null when the card says
 * supports_vision true; no card holds it too. Its sentence names `upstream`, the list the card was read from (default
 * masq), and the heat's `media` (default image).
 */
export function judgeVisionHoldOf(card: MasqModelCard | null, model: string, upstream: JudgeUpstream = 'masq', media: Exclude<JudgeMedia, 'text'> = 'image'): JudgeHold | null {
  if (card === null) return { kind: 'vision', why: `${upstream} lists no model card for ${model}, so whether it reads images cannot be told` };
  const vision = capabilityOf(card, 'supports_vision');
  if (vision === true) return null;
  return { kind: 'vision', why: `${upstream}'s model card for ${card.id} says supports_vision ${JSON.stringify(vision ?? null)}, not true, so ${judgeHeatNoun(media)} cannot be judged on it` };
}

/**
 * The forms a call on the model `card` describes is asked in (the header): the unforced pair when the card
 * says capabilities.reasoning.can_disable false (the model always thinks, so takes no forced tool), else the
 * forced pair, as with no card at all. The same card always gives the same forms.
 */
export function judgeFormsOf(card: MasqModelCard | null): JudgeForms {
  const reasoning = card === null ? undefined : capabilityOf(card, 'reasoning');
  return isRecord(reasoning) && reasoning.can_disable === false ? JUDGE_UNFORCED_FORMS : JUDGE_FORCED_FORMS;
}

/**
 * The vision hold of an image heat (the header): null when masq's live card for the pinned model (or for an id masq
 * routes it to) says supports_vision true; a JudgeHold when the card says anything else or masq lists no card for it.
 * masq unreachable, a list whose body could not be read, or a list that is not one, throws JudgeCallFault.
 */
export async function judgeVisionHold(opts: JudgeVisionOptions): Promise<JudgeHold | null> {
  return judgeVisionHoldOf(judgeVisionCard(await judgeModelCards(opts), opts.model), opts.model);
}

/**
 * masq's model list read on the heat's key (GET /v1/models): for a heat
 * whose broker handed none on with the key. masq unreachable, a list whose body could not be read, or a list that is not
 * one, throws JudgeCallFault.
 */
export async function judgeModelCards(opts: Omit<JudgeVisionOptions, 'model'>): Promise<MasqModelCard[]> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? MASQ_TIMEOUT_MS);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);
  const quote = (text: string): string => judgeText((opts.apiKey === '' ? text : text.split(opts.apiKey).join('[the judge key]')).slice(0, 300));
  const who = opts.upstream ?? 'masq';
  let res: Response;
  try {
    res = await doFetch(new URL(MASQ_MODELS_PATH, opts.origin).href, { method: 'GET', headers: { authorization: `Bearer ${opts.apiKey}`, accept: 'application/json' }, signal });
  } catch (err) {
    throw new JudgeCallFault(`${who} could not be reached for its model list: ${quote(err instanceof Error ? err.message : String(err))}`, null, [], { cause: err });
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new JudgeCallFault(`${who}'s model list (${res.status}) could not be read: ${quote(err instanceof Error ? err.message : String(err))}`, null, [], { cause: err });
  }
  if (!res.ok) throw new JudgeCallFault(`${who} answered ${res.status} for its model list: ${quote(text)}`, res.status, []);
  let list: z.infer<typeof ModelList>;
  try {
    list = ModelList.parse(JSON.parse(text));
  } catch {
    throw new JudgeCallFault(`${who}'s model list is not {data: [{id, capabilities}]}: ${quote(text)}`, res.status, []);
  }
  return list.data;
}

/**
 * The page of a held heat, in an admin's words: what did not start and
 * why, what happens meanwhile (`until`: when the caller weighs it again; null: never), and the ways out.
 */
export function judgeHoldPage(input: { slug: string; phase: JudgeKeyPhase; attempt: number; hold: JudgeHold; until: Date | null }): string {
  const meanwhile =
    input.until === null
      ? 'The competition is resolved, so nothing is sent again: the heat stays unjudged.'
      : `The heat is weighed again at ${input.until.toISOString()}, so it starts on its own once nothing holds it.`;
  const fix = {
    unpriced: 'add the model to pricing/ or pin a priced model in judge.agent.model',
    vision: "pin a model that reads images in judge.agent.model, or wait for masq's card to say supports_vision true",
  }[input.hold.kind];
  return (
    `[grade] ALERT: ${input.slug}: the ${input.phase === 'local' ? 'local' : `${input.phase}-phase`} judge heat (try ${input.attempt}) waits: it did not start, since ${input.hold.why}. ` +
    `Nothing was sent to the judge model and nothing was spent. ${meanwhile} Fix: ${fix}`
  );
}

// ------------------------------------------------------------------ the answer

/** One request of a call, as the record keeps it. */
export interface JudgeAttempt {
  form: JudgeForm;
  /** sha256 of the exact body bytes sent (judgeRequestBody, deterministic). */
  request_sha256: string;
  request_bytes: number;
  /** When it was sent, ISO 8601: its pricing instant. */
  at: string;
  /** The HTTP status masq answered. */
  status: number;
  /** sha256 of the response body: the blob it was stored as, before it was read. */
  response_body_sha256: string;
  /** The model that answered (the completion's `model`, else x-masq-model); null when neither names one. */
  model_answered: string | null;
  finish_reason: string | null;
  /** Its usage in the cassette's token classes; null when the answer carried none. */
  usage: CassetteUsageT | null;
  /** Its price (priceUsage at `at`), µUSD; '0' for a refused status with no usage; null when a 2xx answer carried no usage it could be priced by. */
  micro_usd: string | null;
  /** Why it gave no verdict; null for the attempt that did. */
  invalid: string | null;
  /**
   * On OpenRouter (the header's `openrouter`): the provider the answer names (openRouterServedOf), its display name
   * (`Z.AI`), never an endpoint's tag; absent when it names none, and on masq.
   */
  provider?: string;
}

/** One call: the verdict on Entry A (`a_sha256`) against Entry B (`b_sha256`), and every request it took. */
export interface JudgeCallResult {
  a_sha256: string;
  b_sha256: string;
  /** The slot that won; null when no attempt gave a verdict. */
  verdict: 'A' | 'B' | null;
  /** How far the winner is ahead, JUDGE_MARGIN_MIN (1, by a hair) to JUDGE_MARGIN_MAX (5); null exactly when verdict is. */
  margin: number | null;
  /** The sha256 of the winning artifact (the slot mapped back); null with verdict. */
  winner_sha256: string | null;
  reason: string | null;
  /** Why the last attempt gave no verdict; null when one did. */
  invalid: string | null;
  /** The last attempt's request, response blob and answering model. */
  request_sha256: string;
  response_body_sha256: string;
  model_answered: string | null;
  /** Every attempt's usage summed; null when none carried any. */
  usage: CassetteUsageT | null;
  /** Every attempt's price summed, µUSD (an unpriced attempt adds nothing: see JudgeAttempt.micro_usd). */
  micro_usd: string;
  /**
   * What its answers split their own cost by kind, µUSD (OpenRouter's usage.cost_details: the prompt inference and the
   * completion inference), summed over the attempts that named it; absent when none did, as on masq. It sits
   * on the call, never the attempt: a heat's record keeps attempts in grader/judge-heat.ts JudgeHeatAttempt's shape.
   */
  micro_usd_by_kind?: Record<JudgeTokenKind, bigint> | null;
  /**
   * How each attempt's answer came (JudgeAnswerTiming), index for index with `attempts`: like micro_usd_by_kind on the
   * call, never an attempt (grader/judge-heat.ts JudgeHeatAttempt is strict, and a record keeps no timing: a finished
   * final's or blind round's send times go to its sends sidecar, grader/worker.ts judgeHeatSendsKey). Absent when the
   * call was not timed (a test's hand-made result).
   */
  timings?: JudgeAnswerTiming[];
  attempts: JudgeAttempt[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const tokenCount = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * A chat completion's usage in the cassette's classes: prompt_tokens is masq's input + cache reads +
 * cache writes (its openai-chat adapter), cached_tokens the reads; reasoning is inside completion_tokens.
 * The writes are what the usage names in Anthropic's words beside them (cache_creation_input_tokens, split
 * by cache_creation's ephemeral_5m_input_tokens and ephemeral_1h_input_tokens; a part the split does not
 * name is a 1-hour write, the dearer, as masq's own breakpoints are), and input is the rest. masq's
 * openai-chat answer names no writes, so a write there would read as input: a judge call is a one-shot
 * (JUDGE_SIDE_SPAWN), on which masq writes none. A Messages answer (the header's `dialect`, whose system
 * prompt carries its own breakpoint) names them, carried beside by masqAnswerText. Null when it names no
 * prompt and completion count.
 */
export function judgeUsageOf(usage: unknown): CassetteUsageT | null {
  if (!isRecord(usage)) return null;
  const prompt = tokenCount(usage.prompt_tokens);
  const completion = tokenCount(usage.completion_tokens);
  if (prompt === null || completion === null) return null;
  const pd = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cd = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  const cc = isRecord(usage.cache_creation) ? usage.cache_creation : {};
  const cached = Math.min(tokenCount(pd.cached_tokens) ?? 0, prompt);
  const split5m = tokenCount(cc.ephemeral_5m_input_tokens) ?? 0;
  const split1h = tokenCount(cc.ephemeral_1h_input_tokens) ?? 0;
  // Never more writes than the prompt holds past its reads: the 5-minute part first, the dearer rest as 1-hour writes.
  const written = Math.min(Math.max(tokenCount(usage.cache_creation_input_tokens) ?? 0, split5m + split1h), prompt - cached);
  const write5m = Math.min(split5m, written);
  const reasoning = Math.min(tokenCount(cd.reasoning_tokens) ?? tokenCount(usage.reasoning_tokens) ?? 0, completion);
  return { input: prompt - cached - written, output: completion, cache_read: cached, cache_write_5m: write5m, cache_write_1h: written - write5m, reasoning };
}

/** The price of `usage` at `at`: on the model that answered when it has a pricing row, else on the model asked for. */
function priceOf(asked: string, answered: string | null, at: string, usage: CassetteUsageT): bigint | null {
  for (const model of answered !== null && answered !== asked ? [answered, asked] : [asked]) {
    const priced = priceUsage({ model, at, format: 'tokens', usage });
    if (priced.microUsd !== null) return priced.microUsd;
  }
  return null;
}

// The completion masq answers with, or the one OpenRouter's stream assembles to, read leniently: only what a verdict
// needs.
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

export interface JudgeSendOptions {
  /** masq's origin (MAKEFUN_LLM_GATEWAY_URL), or OpenRouter's (`openrouter`). */
  origin: string;
  /** The heat's judge key. */
  apiKey: string;
  /**
   * The key is OpenRouter's (the header's `openrouter`: openRouterOfKey(minted), `origin` its bare origin): every request
   * goes on OpenRouter's wire pinned to `pin`, `label` (the heat key's label) its x-session-id. Unset: masq's.
   */
  openrouter?: { pin: JudgePin; label: string };
  agent: JudgeAgent;
  system: string;
  media: JudgeMedia;
  /** The house text the user message is framed in (default JUDGE_HOUSE_TEXT): the heat setup's house_text. */
  house?: JudgeHouseText;
  blobs: JudgeBlobs;
  fetch?: typeof fetch;
  /** Each request's bound, ms (default JUDGE_CALL_TIMEOUT_MS), its answer read included. */
  timeoutMs?: number;
  /**
   * The heat's answer bound, ms (JudgeHeat's judgeAnswerBoundMs over its completed answers): a request still unread that
   * long after its send, however its answer flows, is aborted as an answer left unread. Ignored at or past `timeoutMs`.
   */
  answerBoundMs?: number;
  /**
   * The heat's later answer bounds (openJudgeHeat, each time it reads its answers again), heard by a request `answerBoundMs`
   * holds: one under the bound it runs to holds it to its send time (`now`'s clock) + that bound, never later.
   */
  answerBoundLater?: JudgeAnswerBoundLater;
  now?: () => number;
  signal?: AbortSignal;
  /** The forms the call is asked in (judgeFormsOf), default JUDGE_FORCED_FORMS. */
  forms?: JudgeForms;
  /** When the key was minted (ms, `now`'s clock): a 401 within MASQ_KEY_WARMUP_MS of it is re-sent (the header). Unset: a 401 is a fault at once. */
  keyMintedAt?: number;
  /**
   * The wait before a fresh key's 401 or a rate-limited request is re-sent (default a timer), slept inside the call; it
   * is handed `signal` joined to `resends.signal`, and rejects when either aborts.
   */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /** Whether the caller still takes a re-send after a wait (JudgeResendGate); absent: always, until `signal` aborts. */
  resends?: JudgeResendGate;
  /** The jitter on a rate limit's wait when masq names none, in [0, 1) (default Math.random). */
  random?: () => number;
  /** Called with each attempt as it completes (a heat's meter). */
  onAttempt?: (attempt: JudgeAttempt) => void;
  /** Called when masq refuses a forced form for the model (the header): the heat asks its later calls unforced. */
  onForcedToolRefused?: () => void;
  /**
   * Called with the status each time a rate-limited request (a 429, or a 503 naming its Retry-After: the header's
   * `rate limit`; on OpenRouter a transient refusal, the header's `openrouter`, a stream's by its error's code) is to be re-sent, before its wait; never
   * for a fresh key's 401, nor for the answer that spends masq's re-sends. The heat counts them (JudgeHeat.pushbacks): the pool's pushback its sender narrows on. What it throws is
   * swallowed: the re-send goes on as before.
   */
  onRateLimited?: (status: number) => void;
  /** Where a scope refusal's `[model-key] ALERT: ` page goes (default console.error: the alert forwarder reads stderr). */
  page?: (line: string) => void;
  /**
   * The part of judging the call serves (server/ops/metrics.ts JUDGE_CALL_ROLES: dev, swiss, dealt, panel, shadow), as
   * its count's makefun_judge_role_* series name it; absent: 'other'. Counted only: no byte of any request moves.
   */
  role?: JudgeCallRole;
}

/**
 * The scope page's words for a judge key masq refuses its model (the header's `scope`, server/house-model.ts
 * watchMasqScope): what fails, the key, and the episode every heat's minted key shares, so one refused mint
 * configuration pages once, not once a heat.
 */
const JUDGE_SCOPE_FAILS = 'the house judge (every judge call of a heat on that model faults with HTTP 403, so no judged heat finishes)';
const JUDGE_SCOPE_KEYS = "the judge key minted per heat, makefun/<slug>/judge/<phase>/<attempt>: its allowedModels are grader/gateway/masq.ts judgeKeyRequest's";
const JUDGE_SCOPE_EPISODE = 'minted judge keys';

/**
 * A caller's say over a call's re-sends after a wait (a fresh key's 401, a rate limit, on OpenRouter a transient
 * refusal: the header's `rate limit`), never over a request in flight. A heat's sender (grader/worker.ts
 * sendJudgeHeatCalls) gives each send one: once its run is over, or a call planned before this one has already doomed
 * its attempt, nothing the call would send again is ever taken.
 */
export interface JudgeResendGate {
  /** Aborted once no re-send may go out: a wait it cuts short ends the call there, at once, unsent. */
  readonly signal: AbortSignal;
  /** Asked as each wait begins and again as it ends, before the re-send: false ends the call there, unsent. */
  open(): boolean;
}

const sleepFor = (ms: number, signal: AbortSignal | undefined): Promise<void> => delay(ms, undefined, signal === undefined ? {} : { signal });

/** `p`, or a rejection with `signal`'s reason as soon as it aborts (a sleep that ignores its signal is not waited for). */
function untilAborted(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return p;
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * The stall bound a call's requests are held to (JUDGE_ANSWER_STALL_MS), or null for the whole-call bound alone: only
 * on OpenRouter's key, on a pin no door serves, for a judge model JUDGE_ANSWER_STALL_MODELS lists.
 */
export function judgeAnswerStallMsOf(o: Pick<JudgeSendOptions, 'openrouter' | 'agent'>): number | null {
  if (o.openrouter === undefined || isNanoGptPin(o.openrouter.pin)) return null;
  return JUDGE_ANSWER_STALL_MODELS.includes(o.agent.model) ? JUDGE_ANSWER_STALL_MS : null;
}

/** Hands `listen` each later answer bound of a heat (ms) until the function it answers is called (JudgeSendOptions.answerBoundLater). */
export type JudgeAnswerBoundLater = (listen: (ms: number) => void) => () => void;

/**
 * How recently an answer cut at its heat's answer bound must have had a data chunk to be a runaway (JudgeCallFault.runaway:
 * still streaming, not silent), ms. Over ~4,000 answers that completed on 2026-11-22 no gap between data chunks passed
 * 4.9 s (JUDGE_ANSWER_STALL_MS), and the answers the bound cut that day streamed with no gap past 0.7 s; 10 s is twice
 * that longest gap. A silent stall the bound cuts has had none for longer (the bound is 35 s at least, and headers or a
 * keep-alive comment are no data).
 */
export const JUDGE_ANSWER_STREAMING_MS = 10_000;

/**
 * One request's watch: its signal aborts, a TimeoutError its reason, once `stallMs` pass with no poke (the stall
 * bound, JUDGE_ANSWER_STALL_MS; each poke, the headers or a data chunk (`data`), starts that wait again), or `wholeMs`
 * after the send however the answer flows (the heat's answer bound, JudgeSendOptions.answerBoundMs), or sooner, `later`'s
 * send time + a lower bound of the heat's heard after it (JudgeSendOptions.answerBoundLater); stop disarms them.
 * `runaway` says the answer bound cut it (not the stall bound) while its data still came: a data chunk within the
 * last JUDGE_ANSWER_STREAMING_MS when it fired.
 */
function judgeStallWatch(
  stallMs: number | null,
  wholeMs: number | null,
  later?: { sentAt: number; now: () => number; listen: JudgeAnswerBoundLater },
): { signal: AbortSignal; fired: () => boolean; runaway: () => boolean; poke: () => void; data: () => void; stop: () => void } {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // With an answer bound: whether a data chunk came within the last JUDGE_ANSWER_STREAMING_MS (each one starts that
  // wait again), and whether the bound cut the answer while one had.
  let flowing = false;
  let runaway = false;
  let flow: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (stallMs === null) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      ctl.abort(new DOMException(`the answer stalled ${stallMs / 1000} s (the stall bound)`, 'TimeoutError'));
    }, stallMs);
  };
  arm();
  // The bound the request runs to: the one it was sent under, or a lower one heard since.
  let boundMs = wholeMs ?? 0;
  let whole: ReturnType<typeof setTimeout> | null = null;
  const armWhole = (ms: number): void => {
    if (whole !== null) clearTimeout(whole);
    whole = setTimeout(() => {
      whole = null;
      if (!ctl.signal.aborted) runaway = flowing;
      if (flow !== null) clearTimeout(flow);
      flow = null;
      ctl.abort(new DOMException(`the answer ran past ${(boundMs / 1000).toFixed(1)} s (the heat's answer bound)`, 'TimeoutError'));
    }, ms);
  };
  let unlisten: (() => void) | null = null;
  if (wholeMs !== null) {
    armWhole(wholeMs);
    if (later !== undefined) {
      const { sentAt, now } = later;
      unlisten = later.listen((ms) => {
        if (stopped || ctl.signal.aborted || !Number.isFinite(ms) || ms <= 0 || ms >= boundMs) return;
        boundMs = ms;
        armWhole(Math.max(0, sentAt + ms - now()));
      });
    }
  }
  return {
    signal: ctl.signal,
    fired: () => ctl.signal.aborted,
    runaway: () => runaway,
    poke: () => {
      if (!stopped && !ctl.signal.aborted) arm();
    },
    data: () => {
      if (stopped || ctl.signal.aborted) return;
      arm();
      if (wholeMs === null) return;
      flowing = true;
      if (flow !== null) clearTimeout(flow);
      flow = setTimeout(() => {
        flow = null;
        flowing = false;
      }, JUDGE_ANSWER_STREAMING_MS);
    },
    stop: () => {
      stopped = true;
      unlisten?.();
      if (timer !== null) clearTimeout(timer);
      if (whole !== null) clearTimeout(whole);
      if (flow !== null) clearTimeout(flow);
      timer = null;
      whole = null;
      flow = null;
    },
  };
}

/**
 * How one request's answer arrived (the header's `timeout`), measured to set the stall bound from data:
 * ms from the send to the response headers, to the body's first byte and to its first data byte (any byte off an SSE
 * comment line: `: OPENROUTER PROCESSING` is none), the longest wait between two body chunks (the headers counting as
 * the first, the read's end as the last) and between two data chunks (so a stalled answer's is its stall), the whole read, the bytes read, and what served it as the answer's start named
 * it (its first data chunk's `provider`, its x-generation-id header). A field the read never reached is null.
 */
export interface JudgeAnswerTiming {
  headers_ms: number;
  first_byte_ms: number | null;
  first_data_ms: number | null;
  longest_gap_ms: number | null;
  longest_data_gap_ms: number | null;
  total_ms: number;
  bytes: number;
  provider: string | null;
  generation: string | null;
}

/** A timing's words in a fault (judgeAnswerRead): what came when, so a cut answer names its provider and how it stalled. */
function judgeTimingWords(t: JudgeAnswerTiming): string {
  const s = (ms: number | null): string => (ms === null ? 'none' : `${(ms / 1000).toFixed(1)} s`);
  return [
    ...(t.provider === null ? [] : [`provider ${t.provider}`]),
    ...(t.generation === null ? [] : [`generation ${t.generation}`]),
    `headers ${s(t.headers_ms)}`,
    `first byte ${s(t.first_byte_ms)}`,
    `first data ${s(t.first_data_ms)}`,
    `longest gap ${s(t.longest_gap_ms)}`,
    `longest data gap ${s(t.longest_data_gap_ms)}`,
    `${t.bytes} bytes in ${s(t.total_ms)}`,
  ].join(', ');
}

/**
 * Read an answer's body whole (the header's `timeout`), as arrayBuffer() read it (the request's signal errors it as the
 * fetch ties them), chunk by chunk only to measure how it came (`timing`, from `sentAt`, performance.now's clock, its
 * headers' time already in it), `onData` told of each chunk holding a data byte (the stall watch's poke). The request's
 * `signal` (its bounds and the caller's) ends the read
 * itself, not only through the fetch: when it aborts, a read waiting on the next chunk is cancelled and the signal's
 * reason thrown, so a stalled stream ends at the bound on every door, whatever its fetch ties to the body.
 */
async function judgeAnswerRead(res: Response, sentAt: number, timing: JudgeAnswerTiming, signal?: AbortSignal, onData?: () => void): Promise<Uint8Array> {
  const body = res.body;
  const headersAt = sentAt + timing.headers_ms;
  if (body === null) {
    const whole = new Uint8Array(await res.arrayBuffer());
    timing.bytes = whole.byteLength;
    timing.total_ms = performance.now() - sentAt;
    return whole;
  }
  const reader = body.getReader();
  // Cancelling settles a pending read as done; `cut` tells that end from the body's own.
  let cut = false;
  const onAbort = (): void => {
    cut = true;
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  const chunks: Uint8Array[] = [];
  // The SSE line state across chunks: at a line's start, and inside a comment line.
  let lineStart = true;
  let comment = false;
  let lastAt = headersAt;
  let lastDataAt = headersAt;
  // The first data lines' text, read for the provider they name (bounded).
  let head = '';
  try {
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    for (;;) {
      const { done, value } = await reader.read();
      if (cut) throw signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      const at = performance.now();
      chunks.push(value);
      timing.bytes += value.byteLength;
      timing.first_byte_ms ??= at - sentAt;
      timing.longest_gap_ms = Math.max(timing.longest_gap_ms ?? 0, at - lastAt);
      lastAt = at;
      let data = false;
      for (let k = 0; k < value.length; k++) {
        const byte = value[k]!;
        if (byte === 0x0a) {
          lineStart = true;
          continue;
        }
        if (lineStart) comment = byte === 0x3a;
        lineStart = false;
        if (!comment && byte !== 0x0d) data = true;
      }
      if (data) {
        onData?.();
        timing.first_data_ms ??= at - sentAt;
        timing.longest_data_gap_ms = Math.max(timing.longest_data_gap_ms ?? 0, at - lastDataAt);
        lastDataAt = at;
        if (timing.provider === null && head.length < 16_384) {
          head += Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
          timing.provider = providerNamedIn(head);
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // The wait from the last chunk (and the last data chunk) to the read's end counts as a gap: a stalled answer's longest.
    const end = performance.now();
    timing.total_ms = end - sentAt;
    timing.longest_gap_ms = Math.max(timing.longest_gap_ms ?? 0, end - lastAt);
    timing.longest_data_gap_ms = Math.max(timing.longest_data_gap_ms ?? 0, end - lastDataAt);
  }
  const out = new Uint8Array(timing.bytes);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The provider the first complete `data:` line (or the one document) of an answer's start names, or null. */
function providerNamedIn(text: string): string | null {
  const lines = text.startsWith('{') ? [text] : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (const line of lines.slice(0, 8)) {
    try {
      const doc: unknown = JSON.parse(line);
      if (isRecord(doc) && typeof doc.provider === 'string' && doc.provider.trim() !== '') return judgeText(doc.provider.trim().slice(0, 100));
    } catch {
      // not whole yet, or no JSON: the next line, or none
    }
  }
  return null;
}

/** The error codes of an OpenRouter refusal that carries no answer and bills no generation (openRouterTransientRefusal). */
const OPENROUTER_TRANSIENT_CODES: ReadonlySet<number> = new Set([429, 503, 529]);
/** The in-flight budget's reason for a request weighing past the whole budget: never transient, whatever its limit_source. */
const OPENROUTER_WEIGHT_EXCEEDS_BUDGET = 'weight_exceeds_budget';

/**
 * Whether OpenRouter's answer is a transient refusal (the header's `openrouter`): no answer and no generation billed, so
 * the same bytes may be sent again. A refused status (`ok` false, `text` its body): a 429 (the provider at capacity), a
 * 503 or 529, or a 402 whose error.metadata.limit_source is OPENROUTER_IN_FLIGHT_BUDGET and whose reason is not
 * weight_exceeds_budget (OpenRouter's limits page: transient, a Retry-After named). A 2xx (`ok` true, `text` the document
 * its stream assembled to, openRouterAnswerOf, read only when that is a fault): its `error.code` 429, 503 or 529, a
 * rate limit after the stream began, and only while no data came before it (openRouterAnswerBegun: no content,
 * reasoning, tool call or refusal); after any, the generation may have billed its tokens, and the stream is the answer
 * left unread it was before (final, its resends the sender's). Everything else is not: a 402 of credits or of the
 * key's limit, any other status or error.
 */
export function openRouterTransientRefusal(ok: boolean, status: number, text: string): boolean {
  let doc: unknown = null;
  let err: Record<string, unknown> | null = null;
  try {
    doc = JSON.parse(text);
    err = isRecord(doc) && isRecord(doc.error) ? doc.error : null;
  } catch {
    err = null;
  }
  if (ok) {
    const code = err === null ? NaN : typeof err.code === 'number' ? err.code : typeof err.code === 'string' && /^[0-9]{3}$/.test(err.code.trim()) ? Number(err.code.trim()) : NaN;
    return OPENROUTER_TRANSIENT_CODES.has(code) && !openRouterAnswerBegun(doc);
  }
  if (OPENROUTER_TRANSIENT_CODES.has(status)) return true;
  if (status !== 402) return false;
  const meta = err !== null && isRecord(err.metadata) ? err.metadata : null;
  return meta !== null && meta.limit_source === OPENROUTER_IN_FLIGHT_BUDGET && meta.reason !== OPENROUTER_WEIGHT_EXCEEDS_BUDGET;
}

/**
 * Whether the document a 2xx assembled to (openRouterAnswerOf) carries any data its stream sent before it ended: a
 * non-empty content, reasoning or refusal, a reasoning detail or a tool call in its first choice's message. The empty
 * content of a stream's opening role chunk is none.
 */
function openRouterAnswerBegun(doc: unknown): boolean {
  if (!isRecord(doc) || !Array.isArray(doc.choices)) return false;
  const choice: unknown = doc.choices[0];
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
  if (message === null) return false;
  const said = (v: unknown): boolean => typeof v === 'string' && v !== '';
  const listed = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
  return said(message.content) || said(message.reasoning) || said(message.refusal) || listed(message.reasoning_details) || listed(message.tool_calls);
}

/**
 * The wait a refused OpenRouter answer names in its body, ms, read at `nowMs` (the header's `openrouter`): on a status
 * that waits (a 429, 503 or 529, or a 402 whose error.metadata.limit_source is OPENROUTER_IN_FLIGHT_BUDGET), its
 * error.metadata.retry_after_seconds, else its error.metadata.headers' Retry-After (routerRetryAfterMs); null otherwise.
 * An overloaded provider's 429 may name it there and send no Retry-After header. Read only when the Retry-After header
 * reads none; it belongs beside that header read in server/openrouter-judge.ts.
 */
export function openRouterBodyWaitMs(status: number, text: string, nowMs: number): number | null {
  let meta: Record<string, unknown> | null;
  try {
    const doc: unknown = JSON.parse(text);
    const err = isRecord(doc) && isRecord(doc.error) ? doc.error : null;
    meta = err !== null && isRecord(err.metadata) ? err.metadata : null;
  } catch {
    return null;
  }
  if (meta === null) return null;
  if (!(status === 429 || status === 503 || status === 529 || (status === 402 && meta.limit_source === OPENROUTER_IN_FLIGHT_BUDGET))) return null;
  const seconds = meta.retry_after_seconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const named = isRecord(meta.headers) ? Object.entries(meta.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1] : undefined;
  return typeof named === 'string' || typeof named === 'number' ? routerRetryAfterMs(String(named), nowMs) : null;
}

/**
 * One judge call: Entry A `a` against Entry B `b`, the answer form first and, when it gives no verdict,
 * the retry form once (the header; a forced form masq refuses for its model is retried as tool_auto).
 * Throws JudgeCallFault on a platform fault and JudgeArtifactRefused on an artifact it cannot carry; every
 * other outcome is a result, verdict null when no attempt gave one.
 *
 * Each call that sends is counted once at its settle (server/ops/metrics.ts countJudgeCall): its door, model and
 * outcome in makefun_judge_requests_total, its first send to its verdict in makefun_judge_request_seconds, and, when it
 * settled on an answer, its attempts' tokens in makefun_judge_tokens_total, their prices in
 * makefun_judge_spend_micro_usd_total, and the cost their answers split by kind (OpenRouter's usage.cost_details) in
 * makefun_judge_spend_by_kind_micro_usd_total. On OpenRouter it also counts in the makefun_openrouter_* series (lane judge):
 * its attempts' cache reads (cached_tokens) and the HTTP status of each send refused (refusals: a rate limit waited
 * out and sent again, opts.onRateLimited's, and each attempt answered 400 or above). Its request and spend count again
 * by opts.role (absent: 'other') in makefun_judge_role_requests_total and makefun_judge_role_spend_micro_usd_total. The
 * count never changes the call.
 */
export async function sendJudgeCall(opts: JudgeSendOptions, a: JudgeArtifact, b: JudgeArtifact): Promise<JudgeCallResult> {
  const clock: SendJudgeCallClock = { sentAtMs: null };
  const door: JudgeDoor = opts.openrouter !== undefined ? 'openrouter' : 'masq';
  const now = opts.now ?? Date.now;
  // The sends a rate limit refused and the call sent again (no attempt records them), told on to the caller's hook.
  const limited: number[] = [];
  const given = opts.onRateLimited;
  const counted: JudgeSendOptions = {
    ...opts,
    onRateLimited: (status: number) => {
      limited.push(status);
      given?.(status);
    },
  };
  const refusalsOf = (attempts: readonly JudgeAttempt[]): number[] => [...limited, ...attempts.filter((t) => t.status >= 400).map((t) => t.status)];
  try {
    const result = await sendJudgeCallOnce(counted, a, b, clock);
    countJudgeCall({
      door,
      ...(opts.role === undefined ? {} : { role: opts.role }),
      model: opts.agent.model,
      provider: result.attempts.at(-1)?.provider ?? '',
      outcome: 'ok',
      seconds: clock.sentAtMs === null ? 0 : (now() - clock.sentAtMs) / 1000,
      micro_usd: judgeMeterMicroUsd(result.attempts),
      micro_usd_by_kind: result.micro_usd_by_kind ?? null,
      tokens: judgeTokensOf(result.attempts),
      cached_tokens: judgeCachedTokensOf(result.attempts),
      refusals: refusalsOf(result.attempts),
    });
    return result;
  } catch (err) {
    if (err instanceof JudgeCallFault && clock.sentAtMs !== null) {
      countJudgeCall({
        door,
        ...(opts.role === undefined ? {} : { role: opts.role }),
        model: opts.agent.model,
        provider: '',
        outcome: 'fault',
        seconds: (now() - clock.sentAtMs) / 1000,
        micro_usd: 0n,
        tokens: { input: 0n, output: 0n },
        refusals: refusalsOf(err.attempts),
      });
    }
    throw err;
  }
}

/**
 * The tokens a call's attempts took, by kind: input is everything the model was sent (its prompt, cache reads and cache
 * writes), output its completion tokens (reasoning inside them, as judgeUsageOf's). An attempt with no usage adds nothing.
 */
function judgeTokensOf(attempts: readonly JudgeAttempt[]): { input: bigint; output: bigint } {
  let input = 0n;
  let output = 0n;
  for (const attempt of attempts) {
    const usage = attempt.usage;
    if (usage === null) continue;
    input += BigInt(usage.input + usage.cache_read + usage.cache_write_5m + usage.cache_write_1h);
    output += BigInt(usage.output);
  }
  return { input, output };
}

/** The cache reads among a call's attempts' input tokens (their usage's cache_read); an attempt with no usage adds nothing. */
function judgeCachedTokensOf(attempts: readonly JudgeAttempt[]): bigint {
  let cached = 0n;
  for (const attempt of attempts) if (attempt.usage !== null) cached += BigInt(attempt.usage.cache_read);
  return cached;
}

/**
 * An attempt as the call keeps it: every string its answer or upstream wrote (the model that answered, finish_reason,
 * why it gave no verdict, the provider) well formed (judgeText), the attempt itself when each already is.
 */
function keptAttempt(t: JudgeAttempt): JudgeAttempt {
  const text = (s: string | null): string | null => (s === null ? null : judgeText(s));
  const kept: JudgeAttempt = {
    ...t,
    model_answered: text(t.model_answered),
    finish_reason: text(t.finish_reason),
    invalid: text(t.invalid),
    ...(t.provider === undefined ? {} : { provider: judgeText(t.provider) }),
  };
  return kept.model_answered === t.model_answered && kept.finish_reason === t.finish_reason && kept.invalid === t.invalid && kept.provider === t.provider ? t : kept;
}

/** When a judge call's first request went out (ms, the caller's clock); null until then. */
interface SendJudgeCallClock {
  sentAtMs: number | null;
}

async function sendJudgeCallOnce(opts: JudgeSendOptions, a: JudgeArtifact, b: JudgeArtifact, clock: SendJudgeCallClock): Promise<JudgeCallResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const quote = (text: string, max: number): string => judgeText((opts.apiKey === '' ? text : text.split(opts.apiKey).join('[the judge key]')).slice(0, max));
  // A transport failure in words: its message, and the code undici names (`fetch failed (UND_ERR_SOCKET)`) when its message does not.
  const failed = (err: unknown): string => {
    const text = quote(err instanceof Error ? err.message : String(err), 300);
    const code = routerFailureCode(err);
    return code === null || text.includes(code) ? text : `${text} (${code})`;
  };
  const user = judgeUserContent(opts.media, a, b, opts.house ?? JUDGE_HOUSE_TEXT);
  const sleep = opts.sleep ?? sleepFor;
  // OpenRouter's key (the header's `openrouter`): its wire on its pin, its transient refusals' re-sends (up to
  // JUDGE_RATE_LIMIT_RESENDS within JUDGE_RATE_LIMIT_WAIT_MS waited), its name in every sentence.
  const openRouter = opts.openrouter ?? null;
  const who: JudgeFaultUpstream = openRouter !== null ? 'OpenRouter' : 'masq';
  const stallMs = judgeAnswerStallMsOf(opts);
  // The heat's answer bound (JudgeSendOptions.answerBoundMs), where it is under the call's own; a lower one heard later holds each request too.
  const boundMs = opts.answerBoundMs !== undefined && Number.isFinite(opts.answerBoundMs) && opts.answerBoundMs > 0 && opts.answerBoundMs < (opts.timeoutMs ?? JUDGE_CALL_TIMEOUT_MS) ? opts.answerBoundMs : null;
  const attempts: JudgeAttempt[] = [];
  // How each attempt's answer came (the header's `timeout`), index for index with `attempts`; the last request's.
  const timings: JudgeAnswerTiming[] = [];
  let timing: JudgeAnswerTiming | null = null;
  // OpenRouter's own cost split (usage.cost_details), by kind, summed over the answers that name one: null when none does.
  const spendByKind: Record<JudgeTokenKind, bigint> = { input: 0n, output: 0n };
  let splitSeen = false;
  let taken: { winner: 'A' | 'B'; reason: string; margin: number } | null = null;
  let forms: JudgeForms = opts.forms ?? JUDGE_FORCED_FORMS;
  // A fresh key's 401s waited out across the call (by the clock, and by the waits summed should the clock stand still).
  let waited = 0;
  let gap = MASQ_KEY_WARMUP_GAP_MS;
  // The rate limits (on OpenRouter, transient refusals) waited out across the call: the re-sends, the waits summed, and
  // the next wait when the upstream names none.
  const random = opts.random ?? Math.random;
  let rateResends = 0;
  let rateWaited = 0;
  let rateGap = JUDGE_RATE_LIMIT_GAP_MS;
  for (let i = 0; i < JUDGE_CALL_ATTEMPTS; i++) {
    const form = forms[i === 0 ? 0 : 1];
    // Sent as this string, which fetch writes as its UTF-8 bytes: the bytes request_sha256 names. On OpenRouter's key the
    // `messages` body on its pin (the header's `openrouter`; judgeRequestJson OPENROUTER_DIALECT); on masq's, judgeWire's dialect.
    const openRouterJson = openRouter !== null ? openRouterRequestJson(judgeRequestBody(opts.agent, opts.system, user, form, opts.house ?? JUDGE_HOUSE_TEXT, JUDGE_VERDICT_FORMAT, 'messages'), openRouter.pin) : null;
    const wire = openRouterJson !== null ? null : judgeWire(opts.agent, opts.system, user, form, opts.house ?? JUDGE_HOUSE_TEXT);
    const json = openRouterJson ?? wire!.body;
    const endpoint = openRouterJson !== null ? `${openRouterApiBase(opts.origin)}${OPENROUTER_CHAT_PATH}` : new URL(wire!.path, opts.origin).href;
    const headers =
      openRouterJson !== null
        ? openRouterHeaders(opts.apiKey, openRouter!.label)
        : { ...masqAuthHeaders(wire!.dialect, opts.apiKey), 'content-type': 'application/json', accept: 'application/json', ...MASQ_REVIEW_HEADERS, 'x-cosmos-side-spawn': JUDGE_SIDE_SPAWN };
    let at: string;
    let res: Response;
    let raw: Uint8Array;
    // On OpenRouter: the document a 2xx answer assembles to (openRouterAnswerOf); null for a refused status, and elsewhere.
    let assembled: OpenRouterAnswer | null = null;
    for (;;) {
      const sentAt = now();
      at = new Date(sentAt).toISOString();
      clock.sentAtMs ??= sentAt;
      // The call's bound holds the whole request, its answer read included; the stall bound, where it holds, each wait
      // for the headers and the next data byte (judgeAnswerStallMsOf).
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? JUDGE_CALL_TIMEOUT_MS);
      const stall = stallMs === null && boundMs === null ? null : judgeStallWatch(stallMs, boundMs, opts.answerBoundLater === undefined ? undefined : { sentAt, now, listen: opts.answerBoundLater });
      const bounds = [...(opts.signal === undefined ? [] : [opts.signal]), timeout, ...(stall === null ? [] : [stall.signal])];
      const signal = bounds.length === 1 ? timeout : AbortSignal.any(bounds);
      // How the answer comes (the header's `timeout`): measured from here on performance.now's clock.
      const sentClock = performance.now();
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers,
          body: json,
          signal,
        });
      } catch (err) {
        stall?.stop();
        // Stalled before its headers came: OpenRouter saw it and never answered, an answer left unread (sent again).
        if (stall?.fired()) throw new JudgeCallFault(`${who}'s answer could not be read: ${failed(err)} before its headers came`, null, attempts, { cause: err, upstream: who, unread: true, final: true });
        // A refused connect reached no upstream (JudgeCallFault.unseen); on OpenRouter it is the one dial failure that is
        // no answer of its (the header's `final`).
        const unseen = routerRefusedConnect(err);
        throw new JudgeCallFault(`${who} could not be reached: ${failed(err)}`, null, attempts, { cause: err, upstream: who, unseen, ...(openRouter !== null ? { final: !unseen } : {}) });
      }
      stall?.poke();
      timing = {
        headers_ms: performance.now() - sentClock,
        first_byte_ms: null,
        first_data_ms: null,
        longest_gap_ms: null,
        longest_data_gap_ms: null,
        total_ms: 0,
        bytes: 0,
        provider: null,
        generation: res.headers.get('x-generation-id'),
      };
      try {
        // A stream is read whole, under the same bounds (held by the read itself too), chunk by chunk to time it, each
        // data chunk starting the stall bound's wait again.
        raw = await judgeAnswerRead(res, sentClock, timing, signal, stall?.data);
      } catch (err) {
        // A body cut off (the connection dropped, the timeout) is a transport fault, never an empty answer: it would read
        // as no verdict. A 2xx cut so, or any answer stalled past the stall bound, is an answer begun and left unread
        // (JudgeCallFault.unread), named with how it came and what served it as far as its start said; one the heat's
        // answer bound cut while its data still came is a runaway too (JudgeCallFault.runaway), its message the same.
        throw new JudgeCallFault(`${quote(`${who}'s answer (${res.status}) could not be read: ${failed(err)}`, 300)} (${quote(judgeTimingWords(timing), 400)})`, null, attempts, {
          cause: err,
          upstream: who,
          ...(res.ok || stall?.fired() ? { unread: true } : {}),
          ...(stall?.runaway() ? { runaway: true } : {}),
          ...(openRouter !== null ? { final: true } : {}),
          provider: timing.provider,
          timing,
        });
      } finally {
        stall?.stop();
      }
      assembled = openRouter !== null && res.ok ? openRouterAnswerOf(raw) : null;
      // Each re-send below is no attempt: masq refused the request before any model saw it, so it is neither stored,
      // recorded nor metered, and the call's attempts are a serial run's whatever was waited out.
      let wait: number;
      let why: string;
      // The pushback to count once the re-send is sure to be waited for (null: a fresh key's 401, none).
      let pushback: number | null = null;
      if (res.status === 401 && opts.keyMintedAt !== undefined) {
        const age = Math.max(now() - opts.keyMintedAt, waited);
        if (age >= MASQ_KEY_WARMUP_MS) break;
        // masq does not know the key yet (the header).
        wait = Math.min(gap, MASQ_KEY_WARMUP_MS - age);
        waited += wait;
        gap *= 2;
        why = 'masq did not yet know the fresh key';
      } else if (openRouter !== null) {
        // OpenRouter's transient refusal (the header's `openrouter`): a refused status, or a 2xx whose stream ended on a
        // rate limit before any data. Re-sent, the same bytes, after the longer of its named wait (its Retry-After, else
        // its error body's) and this re-send's backoff step (jittered, doubling), within the call's re-sends and waits;
        // the refusal that finds them spent, or any other, is final below.
        if (res.ok && (assembled === null || assembled.fault === null)) break;
        const body = assembled !== null ? assembled.text : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
        if (!openRouterTransientRefusal(res.ok, res.status, body)) break;
        if (rateResends >= JUDGE_RATE_LIMIT_RESENDS || rateWaited >= JUDGE_RATE_LIMIT_WAIT_MS) break;
        // A stream's refusal is named by its error's code (its body's wait read as that status's).
        const code = res.ok ? Number((JSON.parse(body) as { error: { code: number | string } }).error.code) : res.status;
        const named = (res.ok ? null : routerRetryAfterMs(res.headers.get('retry-after'), now())) ?? openRouterBodyWaitMs(code, body, now());
        // Never less than the step: a wait named 0 (or a date already past) would send the re-sends back to back, and so
        // would what is left of the bound once it is under the step, so that remainder counts as spent and the refusal
        // is final. Else the wait is the longer of the two, cut to what is left of the bound.
        const step = Math.round(rateGap * (0.75 + 0.5 * random()));
        if (JUDGE_RATE_LIMIT_WAIT_MS - rateWaited < step) break;
        wait = Math.min(Math.max(named ?? 0, step), JUDGE_RATE_LIMIT_WAIT_MS - rateWaited);
        rateWaited += wait;
        rateGap *= 2;
        rateResends++;
        pushback = code;
        why = `${who} refused it for now (${res.ok ? `its stream ended on a ${code}` : res.status})`;
      } else {
        // Rate limited (the header's `rate limit`): a 429, or a 503 naming its Retry-After.
        const after = res.status === 429 || res.status === 503 ? judgeRetryAfterMs(res.headers.get('retry-after'), now()) : null;
        if (res.status !== 429 && after === null) break;
        if (rateResends >= JUDGE_RATE_LIMIT_RESENDS || rateWaited >= JUDGE_RATE_LIMIT_WAIT_MS) break;
        wait = Math.min(after ?? Math.round(rateGap * (0.75 + 0.5 * random())), JUDGE_RATE_LIMIT_WAIT_MS - rateWaited);
        rateWaited += wait;
        rateGap *= 2;
        rateResends++;
        pushback = res.status;
        why = `${who} rate-limited it (${res.status})`;
      }
      // The caller's gate (JudgeResendGate): a call it closes on ends here, unsent, never final, and is never sent again,
      // marked as the gate's (JudgeCallFault.gated) so no heat's take reads it as a fault to send again or fail on; its
      // refusals were no attempt, so it holds only what an unanswered fault holds of the ledger (openJudgeHeat). A gate
      // whose open() throws is read as open: the re-send goes on as before.
      const gate = opts.resends;
      const gateOpen = (): boolean => {
        if (gate === undefined) return true;
        if (gate.signal.aborted) return false;
        try {
          return gate.open();
        } catch {
          return true;
        }
      };
      const notSent = (): JudgeCallFault => new JudgeCallFault(`the judge call was not sent again after ${why}: its heat takes no more re-sends (its run is over, or its attempt already doomed)`, null, attempts, { upstream: who, gated: true });
      if (!gateOpen()) throw notSent();
      if (pushback !== null) {
        try {
          opts.onRateLimited?.(pushback);
        } catch {
          // The hook only counts: it never changes a re-send.
        }
      }
      // Slept in place on the call's signal and the gate's: an abort mid-wait ends the call with the signal's reason
      // (never a final fault, never slept on), the gate's at once as above, and nothing more is sent. A sleep that does not
      // honour its signal is not waited for.
      const waitSignal = gate === undefined ? opts.signal : opts.signal === undefined ? gate.signal : AbortSignal.any([opts.signal, gate.signal]);
      try {
        await untilAborted(sleep(wait, waitSignal), waitSignal);
      } catch (err) {
        if (opts.signal?.aborted) throw new JudgeCallFault(`the judge call was aborted while ${why}`, null, attempts, { cause: opts.signal.reason ?? err, upstream: who });
        if (gate?.signal.aborted) throw notSent();
        throw err;
      }
      if (opts.signal?.aborted) throw new JudgeCallFault(`the judge call was aborted while ${why}`, null, attempts, { cause: opts.signal.reason, upstream: who });
      if (!gateOpen()) throw notSent();
    }
    // OpenRouter's answer is the document its stream assembles to (the header's `openrouter`), read as chat; masq's in
    // judgeWire's dialect.
    const readAs: MasqDialect = wire !== null ? wire.dialect : 'chat';
    if (assembled !== null && assembled.fault !== null) {
      // OpenRouter's 2xx that is no answer (an error document or chunk, finish_reason error, a cut; a rate limit's once
      // its re-sends are spent): final, with nothing stored, recorded or metered (the header's `openrouter`).
      const generation = res.headers.get('x-generation-id');
      throw new JudgeCallFault(`${who}'s answer (${res.status}) could not be read: ${quote(assembled.fault, 300)}${generation === null ? '' : ` (generation ${quote(generation, 100)})`}`, null, attempts, {
        final: true,
        unread: true,
        upstream: who,
        provider: timing?.provider ?? providerNamedIn(Buffer.from(raw.buffer, raw.byteOffset, Math.min(raw.byteLength, 16_384)).toString('utf8')),
        ...(timing === null ? {} : { timing }),
      });
    }
    // Stored before it is read: the record names the blob, and a verdict is never taken from a body the house does not keep.
    const assembledText = assembled?.text ?? null;
    const stored = await opts.blobs.put(assembledText === null ? raw : Buffer.from(assembledText, 'utf8'));
    const text = assembledText === null ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8') : assembledText;
    // A key masq refuses its model pages once an episode (the header's `scope`); an answer re-arms it. OpenRouter's key
    // has no masq scope.
    if (openRouter === null) {
      watchMasqScope({
        url: endpoint,
        model: opts.agent.model,
        key: opts.apiKey,
        episode: JUDGE_SCOPE_EPISODE,
        status: res.status,
        body: text,
        fails: JUDGE_SCOPE_FAILS,
        keyNames: JUDGE_SCOPE_KEYS,
        ...(opts.page ? { page: opts.page } : {}),
      });
    }
    let doc: z.infer<typeof ChatCompletion> | null = null;
    try {
      // A Messages answer is read as the Chat Completions answer it says (the header's `dialect`).
      const parsed = ChatCompletion.safeParse(JSON.parse(masqAnswerText(readAs, text)));
      if (parsed.success) doc = parsed.data;
    } catch {
      doc = null;
    }
    // OpenRouter sends no x-masq-model: the body's model is the one that answered.
    const header = openRouter !== null ? null : res.headers.get(MASQ_MODEL_HEADER);
    // A model masq swapped in (x-masq-model) is the one that answered and billed, whatever the body names.
    const swapped = header !== null && !isServedModel(opts.agent.model, header) ? header : null;
    const answered = swapped ?? (doc?.model !== undefined && doc.model.trim() !== '' ? doc.model : header);
    const usage = judgeUsageOf(doc?.usage);
    // On OpenRouter who served it and what it cost (usage.cost) are the answer's own (the header's `openrouter`).
    const served: OpenRouterServed | null = openRouter !== null ? openRouterServedOf(text) : null;
    const priced = served?.micro_usd != null ? BigInt(served.micro_usd) : usage === null ? null : priceOf(opts.agent.model, answered, at, usage);
    // OpenRouter's own split of that cost by kind: each kind an answer names is summed; an answer with no
    // cost_details (every masq answer) adds nothing, and a refused status bills nothing.
    const split = openRouter !== null && res.ok ? openRouterSpendSplitOf(text) : null;
    if (split !== null) {
      if (split.input !== null) {
        spendByKind.input += BigInt(split.input);
        splitSeen = true;
      }
      if (split.output !== null) {
        spendByKind.output += BigInt(split.output);
        splitSeen = true;
      }
    }
    const attempt: JudgeAttempt = {
      form,
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
      ...(served?.provider != null ? { provider: served.provider } : {}),
    };
    if (!res.ok && !ANSWER_LEVEL_STATUSES.has(res.status)) {
      const kept = keptAttempt(attempt);
      attempts.push(kept);
      if (timing !== null) timings.push(timing);
      opts.onAttempt?.(kept);
      // On OpenRouter every refused answer that gets here is final (the header's `final`: a transient one once its
      // re-sends are spent); on masq none is.
      throw new JudgeCallFault(`${who} answered ${res.status}: ${quote(text, 300)}`, res.status, attempts, { upstream: who, ...(openRouter !== null ? { final: true } : {}) });
    }
    attempt.invalid = res.ok ? null : quote(`${who} refused the request (${res.status}): ${text}`, 300);
    // masq refuses a forced tool to a model that always thinks: the retry offers it instead (the header).
    if (res.status === 400 && (form === 'answer' || form === 'tool') && FORCED_TOOL_REFUSED.test(text)) {
      forms = [form, 'tool_auto'];
      opts.onForcedToolRefused?.();
    }
    if (attempt.invalid === null) {
      const choice = doc?.choices?.[0];
      const message = choice?.message;
      const call = message?.tool_calls?.find((t) => t.function?.name === JUDGE_VERDICT_TOOL)?.function?.arguments;
      const content = call ?? message?.content ?? '';
      if (doc === null) attempt.invalid = quote(`${who} answered ${res.status} with a body that is not a chat completion: ${text}`, 300);
      else if (doc.error !== undefined) attempt.invalid = quote(`${who} answered an error: ${JSON.stringify(doc.error)}`, 300);
      else if (swapped !== null) attempt.invalid = `masq answered with ${swapped} (${MASQ_MODEL_HEADER}), not ${opts.agent.model}, the judge's pinned model`;
      else if (!isServedModel(opts.agent.model, doc.model ?? ''))
        attempt.invalid = `${who}'s answer ${doc.model === undefined || doc.model.trim() === '' ? 'names no model' : `was served by ${doc.model}`}, not ${opts.agent.model}, the judge's pinned model`;
      else if (openRouter !== null && !openRouterServedByPin(served?.provider ?? null, openRouter.pin))
        attempt.invalid = quote(
          `${who}'s answer ${served?.provider == null ? 'names no provider' : `was served by ${served.provider}`}, not one of the pin's endpoints (${openRouter.pin.providers.map((p) => `${p.name}, ${p.tag}`).join('; ')})`,
          300,
        );
      else if (choice?.finish_reason === 'length') attempt.invalid = `the answer was cut off at the ${opts.agent.max_output_tokens}-token budget (finish_reason length): a cut answer is never read as a verdict`;
      else if (typeof message?.refusal === 'string' && message.refusal.trim() !== '') attempt.invalid = quote(`the model refused: ${message.refusal}`, 300);
      else if (choice?.finish_reason === 'content_filter' || choice?.finish_reason === 'refusal') attempt.invalid = `the model refused (finish_reason ${choice?.finish_reason})`;
      else if (withoutThinking(content) === '') attempt.invalid = `the answer holds no content${call === undefined && (form === 'tool' || form === 'tool_auto') ? ' and no verdict tool call' : ''} (finish_reason ${choice?.finish_reason ?? 'none'})`;
      else {
        const verdict = judgeVerdictOf(content, JUDGE_VERDICT_FORMAT);
        if (!verdict.ok) attempt.invalid = verdict.why;
        else if (verdict.margin === null) throw new Error('a v2 verdict reads with its margin');
        else taken = { winner: verdict.winner, reason: verdict.reason, margin: verdict.margin };
      }
    }
    const kept = keptAttempt(attempt);
    attempts.push(kept);
    if (timing !== null) timings.push(timing);
    opts.onAttempt?.(kept);
    if (taken !== null) break;
  }
  const last = attempts.at(-1);
  if (last === undefined) throw new Error('a judge call sends at least one request');
  return {
    a_sha256: a.sha256,
    b_sha256: b.sha256,
    verdict: taken?.winner ?? null,
    margin: taken?.margin ?? null,
    winner_sha256: taken === null ? null : taken.winner === 'A' ? a.sha256 : b.sha256,
    reason: taken?.reason ?? null,
    invalid: taken === null ? last.invalid : null,
    request_sha256: last.request_sha256,
    response_body_sha256: last.response_body_sha256,
    model_answered: last.model_answered,
    usage: sumUsage(attempts.map((t) => t.usage)),
    micro_usd: judgeMeterMicroUsd(attempts).toString(),
    micro_usd_by_kind: splitSeen ? spendByKind : null,
    ...(timings.length === attempts.length ? { timings } : {}),
    attempts,
  };
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

/**
 * The house meter of a heat's requests, µUSD: every attempt's price summed (`attempts` of each call, or
 * the attempts themselves), an unpriced one adding nothing. What retireTrialKey checks masq's spend against.
 */
export function judgeMeterMicroUsd(items: readonly (JudgeAttempt | Pick<JudgeCallResult, 'attempts'>)[]): bigint {
  let sum = 0n;
  for (const item of items) {
    const attempts = 'attempts' in item ? item.attempts : [item];
    for (const t of attempts) if (t.micro_usd !== null) sum += BigInt(t.micro_usd);
  }
  return sum;
}

// ------------------------------------------------------------------ the heat

export interface JudgeHeatOptions {
  /** Where the heat's key is minted and retired: OpenRouter's (server/openrouter-judge.ts openRouterJudgeBroker), or masq's; a key minted at superbot-router is refused. */
  broker: MasqJudgeKeyBroker;
  /** The key's label: the competition, phase and heat attempt. Every heat's key is minted with no dollar cap. */
  key: Pick<JudgeKeySpec, 'slug' | 'phase' | 'attempt'>;
  agent: JudgeAgent;
  /** The HouseAgent prompt file's text. */
  prompt: string;
  media: JudgeMedia;
  /**
   * The house text its requests are built from: the heat setup's house_text (grader/judge-heat.ts), default
   * JUDGE_HOUSE_TEXT, which is what judgeHeatSetup records.
   */
  house?: JudgeHouseText;
  /** Every artifact the heat's calls may carry, held or paged (the header's `paged`): a call names two of them by sha256. */
  artifacts: JudgeArtifactsOf;
  /** The heat's planned calls (judgeHeatCalls): the most it may send. */
  calls: number;
  blobs: JudgeBlobs;
  fetch?: typeof fetch;
  /** Each call's request bound and the model list read's, ms (default: JUDGE_CALL_TIMEOUT_MS for a call, MASQ_TIMEOUT_MS for the list). */
  timeoutMs?: number;
  /** The clock (ms), default Date.now. */
  now?: () => number;
  /** The wait before a fresh key's 401 or a rate-limited request is re-sent (sendJudgeCall), default a timer. */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /** The jitter on a rate limit's wait when masq names none (sendJudgeCall), default Math.random. */
  random?: () => number;
  signal?: AbortSignal;
  /**
   * An OpenRouter heat's pin (the header's `openrouter`; server/openrouter-judge.ts JudgePin, as the judge-overflow
   * setting's `pins` hold it): its forms, vision, ceilings and the endpoints every call is pinned to. Given exactly when
   * `broker` mints an OpenRouter key (openRouterJudgeBroker): either without the other retires the key and throws a
   * TypeError, nothing sent. Its preflight never holds for a missing price.
   */
  pin?: JudgePin;
  /**
   * The heat's preflight, weighed already (server/judging/pool-heat.ts openJudgePoolHeat: the pool's one walk of its
   * paged artifacts weighs every judge's, the header's `paged`): the heat takes its budget and hold as handed and reads
   * no artifact before its mint. Its input must be the very one this heat weighs (judgeHeatPreflightInput of these
   * options at its `at`), else a TypeError, nothing minted. Absent, the heat weighs its own.
   */
  weighed?: JudgeHeatWeighed;
}

/** A heat's preflight weighed before the heat opens (JudgeHeatOptions.weighed): what it was weighed on, and its answer. */
export interface JudgeHeatWeighed {
  input: Omit<JudgePreflightInput, 'artifacts'>;
  budget: JudgeBudget;
  hold: JudgeHold | null;
}

/**
 * The preflight input but its artifacts of a heat on `opts` priced at `at` (ISO 8601): what openJudgeHeat weighs, and
 * what the pool's preflight weighs for each of its judges (server/judging/pool-heat.ts), built here alone so the two
 * are one. An OpenRouter heat (the header's `openrouter`): its bodies weighed too, and no hold for a missing price.
 */
export function judgeHeatPreflightInput(opts: Pick<JudgeHeatOptions, 'agent' | 'prompt' | 'media' | 'house' | 'calls' | 'pin'>, at: string): Omit<JudgePreflightInput, 'artifacts'> & { house: JudgeHouseText } {
  const house = opts.house ?? JUDGE_HOUSE_TEXT;
  return {
    agent: opts.agent,
    system: judgeSystemPrompt(opts.prompt, house),
    media: opts.media,
    house,
    calls: opts.calls,
    at,
    ...(opts.pin !== undefined ? { unpriced: 'allow' as const, pin: opts.pin } : {}),
  };
}

/** A heat that started: its key, and its calls. */
export interface JudgeHeat {
  /** The judge key as minted, never its secret (dailyLimitUsd absent: a key with no dollar cap). */
  readonly key: { id: string; prefix: string; label: string; expiresAt: number; dailyLimitUsd?: number };
  readonly system: string;
  readonly budget: JudgeBudget;
  /** The forms its next call is asked in (judgeFormsOf on the model's card; unforced from the first forced form masq refused). */
  forms(): JudgeForms;
  /** The heat's meter so far: every attempt's price (judgeMeterMicroUsd). */
  meterMicroUsd(): bigint;
  /**
   * One call, Entry A the artifact `aSha256`, Entry B `bSha256` (sendJudgeCall). The heat may send its
   * planned calls × JUDGE_CALL_ATTEMPTS requests, what the preflight weighed: a call holds
   * JUDGE_CALL_ATTEMPTS of them while it runs and gives back those it did not send (a request that
   * faulted unanswered counts as sent; a fresh key's 401 or a rate limit, re-sent, counts as none: no model saw it), and
   * a call with too few left is refused, as is one after retire or on an artifact not the heat's. On an OpenRouter key
   * a call whose fault was final (JudgeCallFault.final) is never sent again: calling it once more throws a final
   * JudgeCallFault at once, nothing sent and no request spent (the header's `final`). `judge`
   * is a pool heat's index of the judge to send it to (the schedule's planned call's `judge`); a single heat ignores it.
   * `role` is the part of judging the call serves (JudgeSendOptions.role), counted only: no request byte moves.
   * `resends` is its sender's gate on the call's re-sends after a wait (JudgeSendOptions.resends, JudgeResendGate): a call
   * it closes on while it waits ends there unsent, never final, holding one request of the ledger as an unanswered fault does.
   */
  call(aSha256: string, bSha256: string, opts?: { signal?: AbortSignal; judge?: number; role?: JudgeCallRole; resends?: JudgeResendGate }): Promise<JudgeCallResult>;
  /**
   * The requests the heat may still send: planned calls × JUDGE_CALL_ATTEMPTS, less what the calls flying hold and
   * the settled calls sent (call's ledger). A call needs JUDGE_CALL_ATTEMPTS of them to start. Optional on the type, as
   * `pushbacks` is: an opened heat always has both (OpenedJudgeHeat); a hand-made one (a test's) may keep neither, and
   * grader/worker.ts sendJudgeHeatCalls then holds no backup back for the ledger and never narrows.
   */
  requestsLeft?(): number;
  /**
   * The rate-limited requests its calls have re-sent so far (sendJudgeCall's onRateLimited, across every call of the
   * heat): masq's pool pushing back, which grader/worker.ts sendJudgeHeatCalls narrows the heat's width on. A re-send is
   * still no attempt and no request of the ledger.
   */
  pushbacks?(): number;
  /** Retire the key against the heat's meter (retireTrialKey): its flags go in the record. Again: masq's disable is idempotent. */
  retire(opts?: BrokerCallOptions): Promise<RetiredTrialKey>;
}

/**
 * Why judge `agent` cannot be sent on OpenRouter's `pin` as asked (the header's `openrouter`), or null: a
 * max_output_tokens past the pin's (its endpoints' least max_completion_tokens), an effort the model does not list, or
 * no effort where it lists some (glm-5.3-flash reasons at `max` when unasked: server/judging/pool.ts judgeEffortFor
 * names one).
 */
export function openRouterOpeningFault(pin: Pick<JudgePin, 'providers' | 'efforts' | 'max_output_tokens'>, agent: JudgeAgent): string | null {
  const on = `OpenRouter's pin of ${agent.model} (${pin.providers.map((p) => p.tag).join(', ')})`;
  if (agent.max_output_tokens > pin.max_output_tokens) {
    return `the judge asks max_output_tokens ${agent.max_output_tokens}, past the ${pin.max_output_tokens} ${on} takes; nothing was sent`;
  }
  const effort = agent.reasoning_effort;
  if (effort !== undefined && !pin.efforts.includes(effort)) {
    return `the judge asks reasoning_effort ${effort}, which ${on} does not list (${pin.efforts.join(', ') || 'none'}); nothing was sent`;
  }
  if (effort === undefined && pin.efforts.length > 0) {
    return `the judge names no reasoning_effort, and ${on} lists ${pin.efforts.join(', ')}: an unasked effort runs at the model's own; nothing was sent`;
  }
  return null;
}

/** A heat openJudgeHeat opened: its ledger (requestsLeft) and its pushback count are always there. */
export type OpenedJudgeHeat = JudgeHeat & Required<Pick<JudgeHeat, 'requestsLeft' | 'pushbacks'>>;

export type JudgeHeatOpening =
  | { held: JudgeHold; budget: JudgeBudget; /** The key a vision hold retired (nothing spent on it); null for a hold before the mint. */ retired: RetiredTrialKey | null }
  | { held: null; heat: OpenedJudgeHeat };

/**
 * Open a heat (the header): the preflight, the key, for an image or dossier heat the vision check, and the forms its
 * calls are asked in (judgeFormsOf on the model's card, the mint's list; the forced pair when the broker
 * handed none on and the heat read none). A hold answers `held` and mints nothing (a vision hold retires
 * the key it read the card with); otherwise the heat, whose calls the caller sends and whose key it
 * retires when the heat ends. Throws JudgeArtifactRefused on an artifact no call can carry (before
 * anything is minted), JudgeCallFault when masq's model list cannot be read, and the broker's own error
 * when the mint fails (masq never answering the new key included). A judge on a model superbot-router serves, or a key
 * a broker minted at the router, is a JudgeRouterRefusal (the header's `no router`; the key retired unused). A key
 * OpenRouter's broker minted (openRouterOfKey(minted)) opens on `pin`, reading no list (the header's `openrouter`).
 */
export async function openJudgeHeat(opts: JudgeHeatOptions): Promise<JudgeHeatOpening> {
  // Judging never dials superbot-router (the owner's order, 2026-11-17): a judge on a model the router serves, or on
  // masq's spelling of one, is refused before anything is read, minted or sent (server/judging/plan.ts plans every heat
  // on OpenRouter, and moves a heat fixed on the router there before its next call).
  const refused = judgeRouterRefusal(opts.agent.model);
  if (refused !== null) throw new JudgeRouterRefusal(opts.agent.model, refused);
  const now = opts.now ?? Date.now;
  // A list's artifacts held by sha256, each checked to its name now; paged ones (the header's `paged`) checked as the
  // preflight reads them, and read again by each call that carries them.
  const paged = judgeArtifactsPaged(opts.artifacts) ? opts.artifacts : null;
  const artifacts = new Map<string, JudgeArtifact>();
  if (!judgeArtifactsPaged(opts.artifacts)) {
    for (const a of opts.artifacts) {
      judgeArtifactNamed(a);
      artifacts.set(a.sha256, a);
    }
  }
  const pagedShas = paged === null ? null : new Set(paged.shas);
  // The preflight weighed before the heat opened (a pool heat's one walk, the header's `paged`) is taken as handed, its
  // input held to the one this heat weighs at the instant it was priced; else this heat weighs its own.
  const handed = opts.weighed ?? null;
  const preInput = judgeHeatPreflightInput(opts, handed?.input.at ?? new Date(now()).toISOString());
  if (handed !== null && !isDeepStrictEqual(handed.input, preInput)) {
    throw new TypeError(`judge heat on ${opts.agent.model}: the preflight it was handed was weighed on another input than its own (agent, prompt, house text, media, calls, pin); nothing was minted`);
  }
  const { house, system } = preInput;
  const pre = handed !== null ? { budget: handed.budget, hold: handed.hold } : paged === null ? judgePreflight({ ...preInput, artifacts: [...artifacts.values()] }) : (await judgePreflightsPaged([preInput], paged))[0]!;
  if (pre.hold !== null) return { held: pre.hold, budget: pre.budget, retired: null };

  const signalOpt = opts.signal !== undefined ? { signal: opts.signal } : {};
  const minted = await opts.broker.mintJudgeKey({ slug: opts.key.slug, phase: opts.key.phase, attempt: opts.key.attempt, model: opts.agent.model }, { now: now(), ...signalOpt });
  const mintedAt = now();
  // A broker that minted the key at superbot-router all the same: retired unused, and refused as above.
  if (routerOfKey(minted) !== null) {
    await retireTrialKey(opts.broker, minted.id, 0n, signalOpt).catch(() => undefined);
    throw new JudgeRouterRefusal(opts.agent.model);
  }
  // A key OpenRouter's broker minted (the header's `openrouter`): its calls go to the key's origin on the heat's pin, and
  // no model list is read. The pin comes with such a key and no other.
  const openRouterKey = openRouterOfKey(minted);
  const pin = opts.pin ?? null;
  if ((openRouterKey !== null) !== (pin !== null)) {
    await retireTrialKey(opts.broker, minted.id, 0n, signalOpt).catch(() => undefined);
    throw new TypeError(
      openRouterKey !== null
        ? `judge heat ${minted.label}: its key is OpenRouter's, and an OpenRouter heat is opened on its pin (JudgeHeatOptions.pin); nothing was sent`
        : `judge heat ${minted.label}: a pin is an OpenRouter heat's, and its key is masq's; nothing was sent`,
    );
  }
  const origin = openRouterKey?.origin ?? opts.broker.origin;
  let cards: readonly MasqModelCard[] | null = minted.models ?? null;
  if (pin !== null) {
    // A judge the pin cannot serve as asked is the platform's to fix: a fault, its key retired, nothing sent.
    const fault = openRouterOpeningFault(pin, opts.agent);
    if (fault !== null) {
      await retireTrialKey(opts.broker, minted.id, 0n, signalOpt).catch(() => undefined);
      throw new JudgeCallFault(fault, null, [], { upstream: 'OpenRouter' });
    }
    // An image or a dossier heat sends images (the header's `vision`).
    if (opts.media !== 'text' && !pin.vision) {
      const why = `OpenRouter's pin of ${opts.agent.model} (${pin.providers.map((p) => p.tag).join(', ')}) says vision false: the model's input modalities hold no image, so ${judgeHeatNoun(opts.media)} cannot be judged on it`;
      return { held: { kind: 'vision', why }, budget: pre.budget, retired: await retireTrialKey(opts.broker, minted.id, 0n, signalOpt) };
    }
  } else if (opts.media !== 'text') {
    let vision: JudgeHold | null;
    try {
      cards ??= await judgeModelCards({ origin, apiKey: minted.key, fetch: opts.fetch, timeoutMs: opts.timeoutMs, ...signalOpt });
      vision = judgeVisionHoldOf(judgeVisionCard(cards, opts.agent.model), opts.agent.model, 'masq', opts.media);
    } catch (err) {
      await retireTrialKey(opts.broker, minted.id, 0n, signalOpt).catch(() => undefined);
      throw err;
    }
    // Nothing was sent on the key: its meter is truly 0.
    if (vision !== null) return { held: vision, budget: pre.budget, retired: await retireTrialKey(opts.broker, minted.id, 0n, signalOpt) };
  }
  let forms: JudgeForms = pin !== null ? (pin.forms === 'unforced' ? JUDGE_UNFORCED_FORMS : JUDGE_FORCED_FORMS) : judgeFormsOf(cards === null ? null : judgeModelCard(cards, opts.agent.model));

  const attempts: JudgeAttempt[] = [];
  let requestsLeft = opts.calls * JUDGE_CALL_ATTEMPTS;
  let pushbacks = 0;
  let retired = false;
  // On OpenRouter (the header's `final`): the calls whose fault was final, by their ordered pair, so the heat's fault
  // re-send of one is refused unsent.
  const finalFaults = new Map<string, JudgeCallFault>();
  // The answers each pair's sends left unread (JudgeCallFault.unread) since its last answer read, counted: the pair is
  // sent again after each, up to JUDGE_PAIR_SENDS_MAX sends; its last send is not held to the answer bound, and its fault
  // is final (finalFaults).
  const unreadSends = new Map<string, number>();
  const pairOf = (aSha256: string, bSha256: string): string => `${aSha256}>${bSha256}`;
  // The answer bound (judgeAnswerBoundMs), on OpenRouter for a judge JUDGE_ANSWER_STALL_MODELS lists: every completed
  // answer's whole time this heat, and the bound read from them all (judgeAnswerBoundReader: at each answer until
  // JUDGE_ANSWER_BOUND_SAMPLE_MIN, then every JUDGE_ANSWER_BOUND_REREAD). Each new bound is told to the bounded sends in
  // flight (JudgeSendOptions.answerBoundLater), so a send made under the cold bound, or under a higher bound read
  // earlier, is held to the lower one heard later, never later than its own.
  const bounded = pin !== null && !isNanoGptPin(pin) && JUDGE_ANSWER_STALL_MODELS.includes(opts.agent.model);
  const answerBound = judgeAnswerBoundReader();
  const boundListeners = new Set<(ms: number) => void>();
  const answerBoundLater: JudgeAnswerBoundLater = (listen) => {
    boundListeners.add(listen);
    return () => boundListeners.delete(listen);
  };
  const noteAnswers = (timings: readonly JudgeAnswerTiming[] | undefined): void => {
    if (!answerBound.note((timings ?? []).map((t) => t.total_ms))) return;
    for (const listen of [...boundListeners]) listen(answerBound.ms);
  };
  const heat: OpenedJudgeHeat = {
    key: { id: minted.id, prefix: minted.prefix, label: minted.label, expiresAt: minted.expiresAt },
    system,
    budget: pre.budget,
    forms: () => forms,
    meterMicroUsd: () => judgeMeterMicroUsd(attempts),
    requestsLeft: () => requestsLeft,
    pushbacks: () => pushbacks,
    async call(aSha256, bSha256, callOpts = {}) {
      // Why the call may not be sent now, or null: the key retired, or (the header's `final`) OpenRouter answered this
      // call finally, so the heat's fault re-send of it faults at once, nothing sent, no request of the ledger spent.
      // Asked before anything is held, and again right before the send: a paged call's reads (the header's `paged`)
      // let a retire or a final answer land between.
      const refusal = (): Error | null => {
        if (retired) return new Error(`judge heat ${minted.label}: its key is retired, so it sends no more calls`);
        const before = finalFaults.get(pairOf(aSha256, bSha256));
        if (before === undefined) return null;
        return new JudgeCallFault(
          judgeText(`OpenRouter's answer to this call was final, so it is not sent again (its re-sends after refusals spent, and nothing re-sends what OpenRouter answered); nothing was sent. It was: ${before.message}`.slice(0, 600)),
          before.status,
          [],
          { final: true, upstream: 'OpenRouter', ...(before.unread ? { unread: true } : {}), ...(before.runaway ? { runaway: true } : {}) },
        );
      };
      if (retired) throw refusal()!;
      const isOurs = (sha256: string): boolean => (pagedShas === null ? artifacts.has(sha256) : pagedShas.has(sha256));
      if (!isOurs(aSha256) || !isOurs(bSha256)) throw new TypeError(`judge heat ${minted.label}: artifact ${!isOurs(aSha256) ? aSha256 : bSha256} is not one of the heat's, whose worst case the preflight weighed`);
      const refused = refusal();
      if (refused !== null) throw refused;
      if (requestsLeft < JUDGE_CALL_ATTEMPTS) {
        throw new RangeError(
          `judge heat ${minted.label}: its ${opts.calls} planned calls' ${opts.calls * JUDGE_CALL_ATTEMPTS} requests are sent but ${requestsLeft}, and a call may take ${JUDGE_CALL_ATTEMPTS}; the preflight weighed no more`,
        );
      }
      requestsLeft -= JUDGE_CALL_ATTEMPTS;
      const signal = callOpts.signal ?? opts.signal;
      // A paged artifact read for this call (the header's `paged`): a read that fails sent nothing, and spends no request.
      let a: JudgeArtifact;
      let b: JudgeArtifact;
      if (paged === null) {
        a = artifacts.get(aSha256)!;
        b = artifacts.get(bSha256)!;
      } else {
        try {
          [a, b] = await Promise.all([paged.get(aSha256), paged.get(bSha256)]);
        } catch (err) {
          requestsLeft += JUDGE_CALL_ATTEMPTS;
          throw err;
        }
        // Asked again after the reads, as the list's call is asked right before its send: retired, or answered finally
        // meanwhile, it sends nothing and gives its requests back.
        const late = refusal();
        if (late !== null) {
          requestsLeft += JUDGE_CALL_ATTEMPTS;
          throw late;
        }
      }
      // A pair's last send (unreadSends: JUDGE_PAIR_SENDS_MAX - 1 answers left unread before it) is not held to the answer
      // bound: its fault is final and ends the attempt, and answers did complete at 140.2 s and 167.2 s (2026-11-22,
      // round 1), so it runs under the call's whole bound and the stall bound alone, as every send did before the answer
      // bound (judgeAnswerBoundMs). The first resend is held to it as the first send is (JUDGE_ANSWER_BOUND_FLOOR_MS).
      const last = (unreadSends.get(pairOf(aSha256, bSha256)) ?? 0) >= JUDGE_PAIR_SENDS_MAX - 1;
      let result: JudgeCallResult;
      try {
        result = await sendJudgeCall(
          {
            origin,
            apiKey: minted.key,
            agent: opts.agent,
            system,
            media: opts.media,
            house,
            blobs: opts.blobs,
            fetch: opts.fetch,
            timeoutMs: opts.timeoutMs,
            ...(bounded && !last ? { answerBoundMs: answerBound.ms, answerBoundLater } : {}),
            now,
            ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
            ...(opts.random !== undefined ? { random: opts.random } : {}),
            ...(signal !== undefined ? { signal } : {}),
            ...(callOpts.role !== undefined ? { role: callOpts.role } : {}),
            ...(callOpts.resends !== undefined ? { resends: callOpts.resends } : {}),
            forms,
            // OpenRouter's static key has no warm-up; a key masq minted may not be known yet.
            ...(pin !== null ? { openrouter: { pin, label: minted.label } } : { keyMintedAt: mintedAt }),
            onAttempt: (t) => attempts.push(t),
            onForcedToolRefused: () => {
              forms = JUDGE_UNFORCED_FORMS;
            },
            onRateLimited: () => {
              pushbacks++;
            },
          },
          a,
          b,
        );
      } catch (err) {
        // A fault's answered attempts were sent; so may an unanswered request have been (masq may bill it).
        if (err instanceof JudgeCallFault) requestsLeft += JUDGE_CALL_ATTEMPTS - Math.min(JUDGE_CALL_ATTEMPTS, err.attempts.length + (err.status === null ? 1 : 0));
        if (pin !== null && err instanceof JudgeCallFault && err.final) {
          const pair = pairOf(aSha256, bSha256);
          const unread = err.unread ? (unreadSends.get(pair) ?? 0) + 1 : JUDGE_PAIR_SENDS_MAX;
          if (unread < JUDGE_PAIR_SENDS_MAX) unreadSends.set(pair, unread);
          else finalFaults.set(pair, err);
        }
        throw err;
      }
      requestsLeft += JUDGE_CALL_ATTEMPTS - result.attempts.length;
      // An answer read: the pair's unread count starts afresh, so a game a later round plays on it again gets its own
      // JUDGE_PAIR_SENDS_MAX sends, its first two held to the answer bound.
      unreadSends.delete(pairOf(aSha256, bSha256));
      if (bounded) noteAnswers(result.timings);
      return result;
    },
    async retire(retireOpts = {}) {
      retired = true;
      return retireTrialKey(opts.broker, minted.id, judgeMeterMicroUsd(attempts), retireOpts);
    },
  };
  return { held: null, heat };
}
