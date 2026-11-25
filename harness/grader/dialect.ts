// OpenAI Chat Completions to Anthropic Messages and back: how the house lane's forwarder
// (grader/gateway/server.ts) dials a Claude model in its own dialect for a sealed env that speaks Chat
// Completions, and the same for superbot-router's house models (superbot, superbot-fast) on the router's
// Anthropic Messages façade, streamed, for a caller that dials the router (chatToMessages itself stays Claude's
// alone, so a caller that reads it sends a router model on as it came). Pure: no I/O, no clock; each answer a
// function of the bytes given.
//
//   chatToMessages(body)       a Chat Completions request as a Messages request, or null when it says
//                              something Messages cannot say as it was meant (the forwarder then sends
//                              the request on as it came, on Chat Completions)
//   chatToRouterMessages(body) a Chat Completions request for a router house model as the streamed Messages
//                              request superbot-router takes (the `router` section below), or null
//   messagesStreamToMessage(bytes)
//                              an Anthropic Messages event stream assembled into the one Messages document a
//                              buffered answer would be, the error document an in-band error event is, or
//                              a fault (the `stream` section below)
//   messagesToChat(bytes, s)   a Messages answer (or error document) as the Chat Completions answer a
//                              Chat Completions client reads, with the status it is answered at
//   chatMessagesWithoutBlankTurns(messages)
//                              a Chat Completions request's turns with its empty or blank assistant
//                              turns left out and the user turns either side merged, as the Messages
//                              request below says them, for a request the forwarder sends on as Chat
//
// The request (Anthropic's docs, platform.claude.com, read 2026-11-10):
//   system      the leading system (or developer) messages as top-level `system` text blocks, the LAST
//               block carrying `cache_control: {type: 'ephemeral'}`: a breakpoint on the prefix every
//               call of a conversation shares. Never the top-level automatic breakpoint, which would sit
//               on the user turn, new every call. A prompt under the model's minimum (512 tokens on the
//               5.5 models) is simply not cached, with no error
//   messages    user and assistant turns, consecutive turns of one role merged into one; the first and
//               the last a user turn (a 5.5 model answers an assistant prefill 400). An empty or blank
//               assistant turn (a reply cut off before any text, or one of whitespace alone, sent back in
//               a retry) is left out, and the user turns either side of it merge: Messages takes no empty
//               turn, and an absent one says the same. A blank text part (empty, or whitespace alone) in a
//               message that holds other content is left out: Messages answers a text block of it 400
//               ("text content blocks must be non-empty", "... must contain non-whitespace text"; the
//               reference gives TextBlockParam.text minLength 1, the API refuses whitespace alone too, in
//               `messages` and in `system`). A user turn's image_url part with a base64 data URL (PNG,
//               JPEG, GIF, WebP) is an image block
//   max_tokens  max_completion_tokens, else max_tokens (thinking counts toward it, as on Chat)
//   effort      reasoning_effort low, medium, high, xhigh or max as `output_config.effort`, `thinking`
//               left out (adaptive: each model's default). Sent whenever the request names one, since
//               the defaults differ (medium on Haiku 5.5 and Opus 5.5, high on Sonnet 5.5). `none` and
//               `minimal` are effort low, with `thinking: {type: 'disabled'}` on a model that takes it
//               (Haiku 5.5, at high effort or below); Sonnet 5.5 and Opus 5.5 answer that 400 at any
//               effort, so there the lowest effort is all
//   sampling    temperature, top_p, top_k, frequency_penalty, presence_penalty and seed are dropped
//               (a 5.5 model may answer a sampling parameter 400)
//   tools       function tools as Messages tools (parameters as input_schema); tool_choice auto, none,
//               required as `any` and a named function as `tool` (Opus 5.5 and Sonnet 5.5 answer a forced
//               one 400 "tool_choice: type "tool" and "any" are not supported for this model.", as they do
//               through Chat Completions; Haiku 5.5 takes it and skips thinking); parallel_tool_calls false
//               as disable_parallel_tool_use
//   json        a json_schema response_format as `output_config.format` {type: json_schema, schema}
//               (structured outputs: constrained decoding, which a thinking model takes), its schema as
//               Anthropic's SDKs send one (messagesSchemaOf): the constraints Messages does not take moved
//               into the description as `{minimum: 1, maximum: 5}`, additionalProperties false on every
//               object. Read 2026-11-10 at platform.claude.com/docs/en/build-with-claude/structured-outputs
//               and /agents-and-tools/tool-use/define-tools (forcing tool use), /api/errors
// and null for anything else: a stream, n over 1, a json_object response_format (Messages has no "any
// JSON object"), a schema messagesSchemaOf cannot say, a tool call or tool result in the history, a part
// that is not text or a data-URL image, a user turn or system message with nothing but blank text (left
// out, it would say what Chat Completions did not; kept, Messages answers it 400), a system message after the conversation
// began, a field this file does not know, or a model not in MODEL_FACTS (whose effort and thinking rules it
// has not read).
//
// The answer: the text blocks joined as choices[0].message.content (thinking blocks dropped), tool_use
// blocks as tool_calls; stop_reason end_turn and stop_sequence `stop`, max_tokens and
// model_context_window_exceeded `length`, tool_use `tool_calls`, refusal `content_filter`, anything else
// `stop`. usage.prompt_tokens is input + cache read + cache write (every prompt token, as Chat counts
// them), prompt_tokens_details.cached_tokens the cache read, completion_tokens the output (thinking
// included), completion_tokens_details.reasoning_tokens the thinking when the usage names it. The id and
// model are the message's; `created` is 0 (no clock here). An Anthropic error document is the OpenAI
// error shape at the same status; a body that is neither is an upstream_error document, a 2xx one
// answered 502 (MessagesAnswer.kind `unreadable`). A message carrying superbot-router's in-band marker
// `sbr` (the stream section) adds a top-level `sbr: {model_version, tier}` to the Chat answer, never its
// `served_by` (which names the router's serving host); a message without one is answered as before.
//
// The router (superbot-router's Anthropic Messages façade, POST /v1/messages; probed live 2026-11-12 with
// the house-lane key, tests/fixtures/superbot-router/README.md). chatRequestToRouterMessages maps a request
// naming a router house model (ROUTER_MODELS: `superbot` and `superbot-fast`, and the spellings folded to
// them, `superbot-flash` and masq's `superbot-router/superbot` and `superbot-router/superbot-fast`) as
// chatRequestToMessages maps a Claude one, with these differences:
//   model       the bare router id ROUTER_MODELS folds the spelling to, never masq's (the router answers
//               `superbot-router/superbot` 403 model_not_allowed)
//   system      no `cache_control` on any block: a breakpoint is an instruction to Anthropic's prompt cache,
//               which the router is not
//   effort      reasoning_effort minimal, low, medium, high, xhigh or max as `output_config.effort`, the word
//               as written (the router folds it to its own rungs; a client never remaps a caller's effort),
//               and no `thinking` member: the router answers `thinking: {type: 'enabled'}` without a budget
//               400 ("`thinking.budget_tokens` is required for `enabled`"), and thinks at the effort named
//               (93 to 104 thinking tokens at low, live). `none` is `thinking: {type: 'disabled'}` alone, the
//               router's off. Unnamed, neither: the router's default
//   sampling    temperature and top_p (each 0 to 1) and top_k (a whole number) as they are, which the router
//               honours (target-pilot's sealed rules name its target at temperature 0); another value, and
//               frequency_penalty, presence_penalty or seed (no Messages word for any), is null
//   json        a json_schema response_format as `output_config.format`, its schema as messagesSchemaOf says
//               it, as for Claude
//   stream      `stream: true`, last: the router's public door cuts a buffered answer past 125 s, and its
//               house key is streaming_only
// and null for all the rest that is null for Claude: a request streamed by the env itself, n over 1, a tool
// turn in the history, a field this file does not know, no output cap. A request's `metadata.user_id` (the
// router's fairness bucket) is the caller's to add: it names who calls, which a body does not say.
//
// The stream (messagesStreamToMessage; Anthropic's streaming docs, platform.claude.com, read 2026-11-12, and
// the router's own captures in tests/fixtures/superbot-router/). Server-sent events, dispatched at a blank
// line as the SSE spec says (a last event the bytes end inside is never dispatched); comments (`: ready`,
// `: queued …`), `ping` and any event type this file does not know are skipped. `message_start`'s message
// with its members in their order; `content` its blocks in index order, each from its content_block_start
// with text_delta, thinking_delta and signature_delta joined into `text`, `thinking` and `signature`, and a
// tool_use block's input_json_delta joined and parsed as its `input` at content_block_stop; `stop_reason`
// and `stop_sequence` the message_delta's; `usage` message_start's with each message_delta's members laid
// over it field by field (message_start's counters are all 0 on the router, wire.md W42; a delta's are
// cumulative); then `sbr`, the router's marker on the final message_delta ({served_by, model_version,
// tier}). An `error` event is the error document it is (`{type: 'error', error: {type, message, details}}`,
// `details.retry_after` and `details.shed` kept), answered at the status Anthropic answers its type at
// (messagesErrorStatus). Anything else is a fault, never a finished answer: no message_stop (a cut stream),
// no stop_reason, no message_start or a second one, a frame that is no JSON object, a block that never
// started or never stopped, a delta of another block's kind, a tool input that is no JSON object.

/** The Messages API version the translated request is sent under (its `anthropic-version` header). */
export const MESSAGES_API_VERSION = '2023-06-01';

/** The effort levels Messages takes (`output_config.effort`). */
export const EFFORT_LEVELS: readonly string[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** What each Claude model this file translates for takes: whether `thinking: {type: 'disabled'}` is allowed (at high effort or below). */
export interface ModelFacts {
  thinking_off: boolean;
}

/** The models chatToMessages translates for, by id (a dated snapshot of one reads as it): their effort and thinking rules, from the docs above. */
export const MODEL_FACTS: Readonly<Record<string, Readonly<ModelFacts>>> = Object.freeze({
  'claude-haiku-5-5': Object.freeze({ thinking_off: true }),
  'claude-sonnet-5-5': Object.freeze({ thinking_off: false }),
  'claude-opus-5-5': Object.freeze({ thinking_off: false }),
});

const RELEASE_DATE = /-\d{8}$/;

/** A model's MODEL_FACTS row: the id itself, or it under a release date; null for any other model. */
export function modelFacts(model: string): Readonly<ModelFacts> | null {
  const id = model.replace(RELEASE_DATE, '');
  return Object.hasOwn(MODEL_FACTS, id) ? MODEL_FACTS[id]! : null;
}

/**
 * The router's house models chatRequestToRouterMessages translates for (the header's `router`), by every spelling a
 * request may name one with, each folded to the bare id the Messages body names: `superbot` and `superbot-fast`
 * themselves, `superbot-flash` (the flash row's old name) and masq's routed ids `superbot-router/superbot` and
 * `superbot-router/superbot-fast` (a bundle stored before the house lane left masq names them). Exact spellings only:
 * masq's routing grammar (`superbot(high)`, `Superbot`, a vendor path) is no router id.
 */
export const ROUTER_MODELS: Readonly<Record<string, string>> = Object.freeze({
  superbot: 'superbot',
  'superbot-fast': 'superbot-fast',
  'superbot-flash': 'superbot-fast',
  'superbot-router/superbot': 'superbot',
  'superbot-router/superbot-fast': 'superbot-fast',
});

/** The bare router id ROUTER_MODELS folds `model` to; null for a model that is no router house model. */
export function routerModel(model: string): string | null {
  return typeof model === 'string' && Object.hasOwn(ROUTER_MODELS, model) ? ROUTER_MODELS[model]! : null;
}

/** The effort words the router takes as `output_config.effort`, as written (the header's `router`). */
export const ROUTER_EFFORT_LEVELS: readonly string[] = Object.freeze(['minimal', ...EFFORT_LEVELS]);

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const said = (v: unknown): boolean => v !== undefined && v !== null;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The request fields chatToMessages reads; any other field present makes it null. */
const REQUEST_KEYS = new Set([
  'model',
  'messages',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
  'stream',
  'n',
  'stop',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'service_tier',
  'store',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  // Sampling: dropped.
  'temperature',
  'top_p',
  'top_k',
  'frequency_penalty',
  'presence_penalty',
  'seed',
]);

/** A Messages content block: text, or a base64 image. */
type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** A base64 data URL of an image type Messages takes. */
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** An image_url part as an image block: a data URL of a type Messages takes, detail unsaid or auto; null otherwise. */
function imageOf(part: Json): Block | null {
  if (Object.keys(part).some((k) => k !== 'type' && k !== 'image_url') || !isRecord(part.image_url)) return null;
  const img = part.image_url;
  if (Object.keys(img).some((k) => k !== 'url' && k !== 'detail') || (said(img.detail) && img.detail !== 'auto')) return null;
  const m = typeof img.url === 'string' ? IMAGE_DATA_URL.exec(img.url) : null;
  return m === null ? null : { type: 'image', source: { type: 'base64', media_type: m[1]!, data: m[2]! } };
}

/** Text Messages takes in no text block: empty, or whitespace alone (the header). */
const blank = (text: string): boolean => text.trim() === '';

/** A text part as Chat says one: `{type: 'text', text}` and nothing else. */
const isTextPart = (part: unknown): part is { type: 'text'; text: string } =>
  isRecord(part) && part.type === 'text' && typeof part.text === 'string' && Object.keys(part).every((k) => k === 'type' || k === 'text');

/**
 * A message's blocks: a string with text in it, or text parts and, when `images`, data-URL image parts (a blank text
 * part left out, the message keeping at least one block); null for anything else.
 */
function blocksOf(content: unknown, images: boolean): Block[] | null {
  if (typeof content === 'string') return blank(content) ? null : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return null;
  const out: Block[] = [];
  for (const part of content) {
    if (!isRecord(part)) return null;
    if (images && part.type === 'image_url') {
      const image = imageOf(part);
      if (image === null) return null;
      out.push(image);
      continue;
    }
    if (!isTextPart(part)) return null;
    if (!blank(part.text)) out.push({ type: 'text', text: part.text });
  }
  return out.length === 0 ? null : out;
}

/** A message's text: blocksOf with no images, as strings. */
function textOf(content: unknown): string[] | null {
  const blocks = blocksOf(content, false);
  return blocks === null ? null : blocks.map((b) => (b as { text: string }).text);
}

/**
 * An assistant turn that says nothing: no text (empty or blank, null, or no parts but blank text parts) and nothing else
 * (no tool call, refusal, name or audio). Left out of a Messages request (chatRequestToMessages) and, on the house lane,
 * out of a Chat Completions request sent on as Chat (chatMessagesWithoutBlankTurns).
 */
export const emptyAssistant = (m: Json): boolean =>
  m.role === 'assistant' &&
  onlyKeys(m, ['role', 'content']) &&
  (!said(m.content) || (typeof m.content === 'string' && blank(m.content)) || (Array.isArray(m.content) && m.content.every((p) => isTextPart(p) && blank(p.text))));

/** Whether a message says nothing but `keys` (a field null, absent or an empty list says nothing). */
const onlyKeys = (doc: Json, keys: readonly string[]): boolean => Object.entries(doc).every(([k, v]) => keys.includes(k) || !said(v) || (Array.isArray(v) && v.length === 0));

/** A user turn two may merge into: a role and its content (a string or a list of parts), nothing else said. */
const mergeableUser = (m: unknown): m is Json & { content: string | unknown[] } =>
  isRecord(m) && m.role === 'user' && onlyKeys(m, ['role', 'content']) && (typeof m.content === 'string' || Array.isArray(m.content));

/** A user turn's content as Chat Completions parts: a string as one text part, a list as it is. */
const partsOf = (content: string | unknown[]): unknown[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

/**
 * A Chat Completions request's `messages` with every assistant turn that says nothing (emptyAssistant) left out, and the
 * user turns either side of each one merged into one user turn whose content is the parts of both in order (a string
 * as one text part): what Chat Completions says when such a turn goes, as chatRequestToMessages says it on Messages. A
 * user turn that says more than its role and content is not merged (two user turns stand). Null when no turn is left
 * out, so the caller sends the request as it came. The retry an env makes after a reply cut off before any text sends
 * that reply back as an empty or blank assistant turn, which masq answers 400 for superbot ("carries no content, no
 * reasoning and no tool call") and Anthropic's Chat Completions 400 when blank ("text content blocks must contain
 * non-whitespace text"). Pure: `messages` is never changed.
 */
export function chatMessagesWithoutBlankTurns(messages: readonly unknown[]): unknown[] | null {
  const out: unknown[] = [];
  let dropped = false;
  let gap = false;
  for (const m of messages) {
    if (isRecord(m) && emptyAssistant(m)) {
      dropped = true;
      gap = true;
      continue;
    }
    const last = out.at(-1);
    if (gap && mergeableUser(last) && mergeableUser(m)) out[out.length - 1] = { role: 'user', content: [...partsOf(last.content), ...partsOf(m.content)] };
    else out.push(m);
    gap = false;
  }
  return dropped ? out : null;
}

/** max_completion_tokens, else max_tokens: a positive integer; both, they agree. */
function outputCap(doc: Json): number | null {
  const a = doc.max_completion_tokens;
  const b = doc.max_tokens;
  if (said(a) && said(b) && a !== b) return null;
  const cap = said(a) ? a : b;
  return isCount(cap) && cap > 0 ? cap : null;
}

/** tools and tool_choice as Messages says them; null when it cannot. */
function toolsOf(doc: Json): { tools?: Json[]; tool_choice?: Json } | null {
  const parallel = doc.parallel_tool_calls;
  if (said(parallel) && typeof parallel !== 'boolean') return null;
  if (!said(doc.tools)) return said(doc.tool_choice) || said(parallel) ? null : {};
  if (!Array.isArray(doc.tools) || doc.tools.length === 0) return null;
  const tools: Json[] = [];
  for (const t of doc.tools) {
    if (!isRecord(t) || t.type !== 'function' || !isRecord(t.function) || Object.keys(t).some((k) => k !== 'type' && k !== 'function')) return null;
    const f = t.function;
    if (Object.keys(f).some((k) => !['name', 'description', 'parameters', 'strict'].includes(k)) || (said(f.strict) && f.strict !== false)) return null;
    if (typeof f.name !== 'string' || f.name === '') return null;
    if (said(f.description) && typeof f.description !== 'string') return null;
    if (said(f.parameters) && !isRecord(f.parameters)) return null;
    tools.push({
      name: f.name,
      ...(typeof f.description === 'string' && f.description !== '' ? { description: f.description } : {}),
      input_schema: isRecord(f.parameters) ? f.parameters : { type: 'object', properties: {} },
    });
  }
  const choice = doc.tool_choice;
  let tool_choice: Json;
  if (!said(choice) || choice === 'auto') tool_choice = { type: 'auto' };
  else if (choice === 'none') tool_choice = { type: 'none' };
  else if (choice === 'required') tool_choice = { type: 'any' };
  else if (isRecord(choice) && choice.type === 'function' && Object.keys(choice).length === 2 && isRecord(choice.function) && Object.keys(choice.function).length === 1) {
    const name = choice.function.name;
    if (typeof name !== 'string' || !tools.some((t) => t.name === name)) return null;
    tool_choice = { type: 'tool', name };
  } else return null;
  if (parallel === false && tool_choice.type !== 'none') tool_choice.disable_parallel_tool_use = true;
  return { tools, tool_choice };
}

// ------------------------------------------------------------------ structured outputs

/** The types a schema names (structured outputs' supported features). */
const SCHEMA_TYPES: readonly string[] = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
/** The string formats Messages takes; another is moved into the description. */
const STRING_FORMATS: readonly string[] = ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid'];
/** Constraints Messages does not take: moved into the description, as Anthropic's SDKs move them. */
const NOTED_KEYS: readonly string[] = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties'];
/** The deepest schema messagesSchemaOf walks. */
const SCHEMA_DEPTH = 32;

const isPrimitive = (v: unknown): boolean => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** One schema node as Messages takes it (messagesSchemaOf); null when it cannot. */
function schemaNode(node: unknown, depth: number): Json | null {
  if (!isRecord(node) || depth > SCHEMA_DEPTH) return null;
  const sub = (v: unknown): Json | null => schemaNode(v, depth + 1);
  const subs = (v: unknown): Json[] | null => {
    if (!Array.isArray(v) || v.length === 0) return null;
    const out = v.map(sub);
    return out.some((s) => s === null) ? null : (out as Json[]);
  };
  const map = (v: unknown): Json | null => {
    if (!isRecord(v)) return null;
    const out: Json = {};
    for (const [k, s] of Object.entries(v)) {
      const t = sub(s);
      if (t === null) return null;
      out[k] = t;
    }
    return out;
  };
  const out: Json = {};
  const notes: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    let kept: unknown = v;
    switch (k) {
      case 'type':
        if (!(typeof v === 'string' ? SCHEMA_TYPES.includes(v) : Array.isArray(v) && v.length > 0 && v.every((t) => typeof t === 'string' && SCHEMA_TYPES.includes(t)))) return null;
        break;
      case 'description':
      case 'pattern':
        if (typeof v !== 'string') return null;
        break;
      case 'required':
        if (!Array.isArray(v) || !v.every((r) => typeof r === 'string')) return null;
        break;
      case 'additionalProperties':
        if (v !== false) return null;
        break;
      case 'enum':
        if (!Array.isArray(v) || v.length === 0 || !v.every(isPrimitive)) return null;
        break;
      case 'const':
        if (!isPrimitive(v)) return null;
        break;
      case 'default':
        break;
      case '$ref':
        if (typeof v !== 'string' || !v.startsWith('#')) return null;
        break;
      case 'items':
        kept = sub(v);
        break;
      case 'anyOf':
      case 'allOf':
        kept = subs(v);
        break;
      case 'properties':
      case '$defs':
      case 'definitions':
        kept = map(v);
        break;
      case 'format':
        if (typeof v !== 'string') return null;
        if (!STRING_FORMATS.includes(v)) {
          notes.push(`${k}: ${JSON.stringify(v)}`);
          continue;
        }
        break;
      default:
        if (!NOTED_KEYS.includes(k)) return null;
        if (k === 'minItems' && (v === 0 || v === 1)) break;
        notes.push(`${k}: ${JSON.stringify(v)}`);
        continue;
    }
    if (kept === null) return null;
    out[k] = kept;
  }
  const isObject = node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object')) || said(node.properties);
  if (isObject) {
    // An object Messages holds to additionalProperties false: one that names no property and does not say so is open to
    // any key, which it could not be.
    const named = isRecord(node.properties) && Object.keys(node.properties).length > 0;
    if (!named && node.additionalProperties !== false) return null;
    if (!('additionalProperties' in out)) out.additionalProperties = false;
  }
  if (notes.length > 0) {
    const note = `{${notes.join(', ')}}`;
    out.description = typeof out.description === 'string' && out.description !== '' ? `${out.description}\n\n${note}` : note;
  }
  return out;
}

/**
 * A JSON schema as structured outputs take it (the header's `json`), or null when it says something they cannot: an
 * object open to other keys, a keyword they do not know, or a root that is not an object schema.
 */
export function messagesSchemaOf(schema: unknown): Json | null {
  if (!isRecord(schema) || schema.type !== 'object') return null;
  return schemaNode(schema, 0);
}

/** response_format as `output_config.format`: undefined for none or text, null for one Messages cannot say. */
function formatOf(doc: Json): Json | null | undefined {
  const f = doc.response_format;
  if (!said(f)) return undefined;
  if (!isRecord(f)) return null;
  if (f.type === 'text' && Object.keys(f).length === 1) return undefined;
  if (f.type !== 'json_schema' || Object.keys(f).length !== 2 || !isRecord(f.json_schema)) return null;
  const js = f.json_schema;
  if (Object.keys(js).some((k) => !['name', 'strict', 'schema'].includes(k)) || (said(js.strict) && typeof js.strict !== 'boolean')) return null;
  const schema = messagesSchemaOf(js.schema);
  return schema === null ? null : { type: 'json_schema', schema };
}

/** reasoning_effort as `output_config` and `thinking`; null for a value Messages has no word for. */
function effortOf(doc: Json, facts: Readonly<ModelFacts>): { output_config?: Json; thinking?: Json } | null {
  const e = doc.reasoning_effort;
  if (!said(e)) return {};
  if (typeof e !== 'string') return null;
  if (EFFORT_LEVELS.includes(e)) return { output_config: { effort: e } };
  if (e === 'none' || e === 'minimal') return facts.thinking_off ? { thinking: { type: 'disabled' }, output_config: { effort: 'low' } } : { output_config: { effort: 'low' } };
  return null;
}

/** stop as stop_sequences; null for an empty or blank one. */
function stopOf(doc: Json): string[] | null | undefined {
  const s = doc.stop;
  if (!said(s)) return undefined;
  const list = typeof s === 'string' ? [s] : Array.isArray(s) ? s : null;
  if (list === null || list.length === 0) return null;
  for (const v of list) if (typeof v !== 'string' || v.trim() === '') return null;
  return list as string[];
}

/** reasoning_effort as the router takes it (the header's `router`): a word it takes as `output_config.effort` as written, `none` as thinking disabled alone; null for any other value. */
function routerEffortOf(doc: Json): { output_config?: Json; thinking?: Json } | null {
  const e = doc.reasoning_effort;
  if (!said(e)) return {};
  if (e === 'none') return { thinking: { type: 'disabled' } };
  return typeof e === 'string' && ROUTER_EFFORT_LEVELS.includes(e) ? { output_config: { effort: e } } : null;
}

const inUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** The sampling members the router takes (the header's `router`): temperature, top_p, top_k as they are; null for a value out of range, or a member Messages has no word for. */
function routerSamplingOf(doc: Json): Json | null {
  if (said(doc.frequency_penalty) || said(doc.presence_penalty) || said(doc.seed)) return null;
  const out: Json = {};
  if (said(doc.temperature)) {
    if (!inUnit(doc.temperature)) return null;
    out.temperature = doc.temperature;
  }
  if (said(doc.top_p)) {
    if (!inUnit(doc.top_p)) return null;
    out.top_p = doc.top_p;
  }
  if (said(doc.top_k)) {
    if (!isCount(doc.top_k)) return null;
    out.top_k = doc.top_k;
  }
  return out;
}

/** What the Messages request says differently for a Claude model and for the router (the header's `router`). */
interface MessagesTarget {
  /** The id the body names. */
  model: string;
  /** reasoning_effort as `output_config` and `thinking`; null for a value it has no word for. */
  effort: (doc: Json) => { output_config?: Json; thinking?: Json } | null;
  /** The sampling members the body carries; null for a value it cannot say. */
  sampling: (doc: Json) => Json | null;
  /** Whether the last system block carries the cache breakpoint. */
  cache: boolean;
  /** Whether the body asks a stream. */
  stream: boolean;
}

/** A parsed Chat Completions request as a Messages request (see the header), or null. */
export function chatRequestToMessages(doc: unknown): Json | null {
  if (!isRecord(doc)) return null;
  for (const k of Object.keys(doc)) if (!REQUEST_KEYS.has(k)) return null;
  const model = doc.model;
  if (typeof model !== 'string') return null;
  const facts = modelFacts(model);
  if (facts === null) return null;
  return messagesRequestOf(doc, { model, effort: (d) => effortOf(d, facts), sampling: () => ({}), cache: true, stream: false });
}

/**
 * A parsed Chat Completions request naming a router house model (ROUTER_MODELS) as the streamed Messages request
 * superbot-router takes (the header's `router`), or null: for a model that is no router house model, and for whatever
 * chatRequestToMessages is null for.
 */
export function chatRequestToRouterMessages(doc: unknown): Json | null {
  if (!isRecord(doc)) return null;
  for (const k of Object.keys(doc)) if (!REQUEST_KEYS.has(k)) return null;
  const model = routerModel(doc.model as string);
  if (model === null) return null;
  return messagesRequestOf(doc, { model, effort: routerEffortOf, sampling: routerSamplingOf, cache: false, stream: true });
}

/** `doc` (a Chat Completions request whose fields are all REQUEST_KEYS) as a Messages request for `target`, or null. */
function messagesRequestOf(doc: Json, target: MessagesTarget): Json | null {
  if (said(doc.stream) && doc.stream !== false) return null;
  if (said(doc.n) && doc.n !== 1) return null;
  if (said(doc.logprobs) && doc.logprobs !== false) return null;
  if (said(doc.top_logprobs)) return null;
  if (said(doc.logit_bias) && !(isRecord(doc.logit_bias) && Object.keys(doc.logit_bias).length === 0)) return null;
  if (said(doc.store) && doc.store !== false) return null;
  if (said(doc.service_tier) && doc.service_tier !== 'auto' && doc.service_tier !== 'default') return null;
  const format = formatOf(doc);
  if (format === null) return null;
  const max_tokens = outputCap(doc);
  if (max_tokens === null) return null;
  const effort = target.effort(doc);
  if (effort === null) return null;
  const sampling = target.sampling(doc);
  if (sampling === null) return null;
  const tools = toolsOf(doc);
  if (tools === null) return null;
  const stop = stopOf(doc);
  if (stop === null) return null;

  if (!Array.isArray(doc.messages) || doc.messages.length === 0) return null;
  const system: string[] = [];
  const turns: { role: 'user' | 'assistant'; blocks: Block[] }[] = [];
  for (const m of doc.messages) {
    if (!isRecord(m)) return null;
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      // Messages has one system prompt, before the conversation.
      if (turns.length > 0 || !onlyKeys(m, ['role', 'content'])) return null;
      const text = textOf(m.content);
      if (text === null) return null;
      system.push(...text);
      continue;
    }
    // An empty or blank reply sent back in a retry: left out, so the user turns either side merge.
    if (emptyAssistant(m)) continue;
    // A tool turn, or a name, refusal, tool call or audio on a turn, is not text this file carries.
    if ((role !== 'user' && role !== 'assistant') || !onlyKeys(m, ['role', 'content'])) return null;
    const blocks = blocksOf(m.content, role === 'user');
    if (blocks === null) return null;
    const last = turns.at(-1);
    if (last !== undefined && last.role === role) last.blocks.push(...blocks);
    else turns.push({ role, blocks: [...blocks] });
  }
  if (turns.length === 0 || turns[0]!.role !== 'user' || turns.at(-1)!.role !== 'user') return null;

  const out: Json = { model: target.model, max_tokens };
  if (system.length > 0) {
    out.system = system.map((text, i) => (target.cache && i === system.length - 1 ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text }));
  }
  out.messages = turns.map((t) => ({ role: t.role, content: t.blocks.length === 1 && t.blocks[0]!.type === 'text' ? t.blocks[0]!.text : t.blocks }));
  if (tools.tools !== undefined) {
    out.tools = tools.tools;
    out.tool_choice = tools.tool_choice;
  }
  if (stop !== undefined) out.stop_sequences = stop;
  Object.assign(out, sampling);
  if (effort.thinking !== undefined) out.thinking = effort.thinking;
  if (effort.output_config !== undefined || format !== undefined) out.output_config = { ...effort.output_config, ...(format !== undefined ? { format } : {}) };
  if (target.stream) out.stream = true;
  return out;
}

const encoder = new TextEncoder();

/** A Chat Completions request body as a Messages request body (see the header), or null when it is not one this file can say faithfully. */
export function chatToMessages(body: Uint8Array): Uint8Array | null {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  }
  const out = chatRequestToMessages(doc);
  return out === null ? null : encoder.encode(JSON.stringify(out));
}

/** A Chat Completions request body for a router house model as the streamed Messages body superbot-router takes (the header's `router`), or null when it is none this file can say faithfully. */
export function chatToRouterMessages(body: Uint8Array): Uint8Array | null {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  }
  const out = chatRequestToRouterMessages(doc);
  return out === null ? null : encoder.encode(JSON.stringify(out));
}

// ------------------------------------------------------------------ the answer

/** Messages' stop_reason as Chat's finish_reason (see the header). */
export function finishReason(stop: unknown): string {
  switch (stop) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** Messages usage as Chat usage (see the header); null when it carries no counts. */
export function chatUsage(usage: unknown): Json | null {
  if (!isRecord(usage)) return null;
  const n = (v: unknown): number => (isCount(v) ? v : 0);
  const input = n(usage.input_tokens);
  const read = n(usage.cache_read_input_tokens);
  const write = n(usage.cache_creation_input_tokens);
  const output = n(usage.output_tokens);
  const prompt = input + read + write;
  const out: Json = { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, prompt_tokens_details: { cached_tokens: read } };
  const thinking = isRecord(usage.output_tokens_details) ? usage.output_tokens_details.thinking_tokens : undefined;
  if (isCount(thinking)) out.completion_tokens_details = { reasoning_tokens: thinking };
  return out;
}

/** An OpenAI error document. */
function chatError(message: string, type: string): Json {
  return { error: { message, type, param: null, code: type } };
}

/** What messagesToChat answers: the status and body the Chat client gets, and what the bytes were. */
export interface MessagesAnswer {
  status: number;
  body: Uint8Array;
  /** `message` a Messages answer, `error` an error document, `unreadable` neither (a 2xx one answered 502). */
  kind: 'message' | 'error' | 'unreadable';
}

/** A Messages answer at `status` as a Chat Completions answer (see the header). */
export function messagesToChat(bytes: Uint8Array, status: number): MessagesAnswer {
  let doc: unknown = null;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    doc = null;
  }
  const ok = status >= 200 && status < 300;
  const done = (s: number, d: Json, kind: MessagesAnswer['kind']): MessagesAnswer => ({ status: s, body: encoder.encode(JSON.stringify(d)), kind });
  if (isRecord(doc) && (doc.type === 'error' || isRecord(doc.error))) {
    const e = isRecord(doc.error) ? doc.error : {};
    const type = typeof e.type === 'string' && e.type !== '' ? e.type : 'api_error';
    const message = typeof e.message === 'string' ? e.message : `the model provider answered HTTP ${status} with an error`;
    return done(status, chatError(message, type), 'error');
  }
  if (!isRecord(doc) || doc.type !== 'message' || !Array.isArray(doc.content)) {
    const message = `the model provider answered HTTP ${status} with a body that is no Messages ${ok ? 'answer' : 'error document'}`;
    return done(ok ? 502 : status, chatError(message, 'upstream_error'), 'unreadable');
  }
  const text: string[] = [];
  const calls: Json[] = [];
  for (const block of doc.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
    }
  }
  const message: Json = { role: 'assistant', content: text.length === 0 && calls.length > 0 ? null : text.join(''), refusal: null };
  if (calls.length > 0) message.tool_calls = calls;
  const usage = chatUsage(doc.usage);
  const mark = isRecord(doc.sbr) ? routerMarkOf(doc.sbr) : null;
  return done(
    status,
    {
      id: typeof doc.id === 'string' ? doc.id : '',
      object: 'chat.completion',
      created: 0,
      model: typeof doc.model === 'string' ? doc.model : '',
      choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason(doc.stop_reason) }],
      ...(usage === null ? {} : { usage }),
      ...(mark === null ? {} : { sbr: mark }),
    },
    'message',
  );
}

/** The router's marker as the Chat answer carries it (the header's answer): its model_version and tier, each when it is a string; never served_by. */
function routerMarkOf(sbr: Json): Json {
  const out: Json = {};
  if (typeof sbr.model_version === 'string') out.model_version = sbr.model_version;
  if (typeof sbr.tier === 'string') out.tier = sbr.tier;
  return out;
}

// ------------------------------------------------------------------ the stream

/**
 * The HTTP status Anthropic answers an error `type` at (platform.claude.com/docs/en/api/errors, read 2026-11-12): the
 * status an in-band error event of that type would have had as a whole answer. A type it does not list is 500, an
 * api_error's.
 */
export const MESSAGES_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  conflict_error: 409,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
});

/** The status an error document of `type` is answered at (MESSAGES_ERROR_STATUS; 500 for a type it does not list). */
export function messagesErrorStatus(type: unknown): number {
  return typeof type === 'string' && Object.hasOwn(MESSAGES_ERROR_STATUS, type) ? MESSAGES_ERROR_STATUS[type]! : 500;
}

/** What messagesStreamToMessage makes of a stream (the header's `stream`). */
export type MessagesStream =
  /** The one Messages document a buffered answer would be. */
  | { kind: 'message'; message: Json }
  /** An in-band `error` event: the error document it carries, and the status its type is answered at. */
  | { kind: 'error'; error: Json; status: number }
  /** No finished answer: why. */
  | { kind: 'fault'; fault: string };

/** One server-sent event: its `event` field (null when it names none) and its data, its lines joined by \n. */
interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * The events of a server-sent event stream, as the SSE spec (WHATWG HTML §9.2.6) dispatches them: at each blank line,
 * an event with data (comment lines and fields other than `event` and `data` skipped; one space after the colon
 * dropped; CRLF, LF and CR each end a line). The last event, when the text ends inside it, is never dispatched.
 */
function sseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let event: string | null = null;
  let data: string[] | null = null;
  const lines = (text.startsWith('\uFEFF') ? text.slice(1) : text).split(/\r\n|\r|\n/);
  // The text after the last line end is a line the stream had not finished: never dispatched.
  lines.pop();
  for (const line of lines) {
    if (line === '') {
      if (data !== null) events.push({ event, data: data.join('\n') });
      event = null;
      data = null;
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') (data ??= []).push(value);
    else if (field === 'event') event = value;
  }
  return events;
}

/** The event types messagesStreamToMessage reads (`error` apart); any other is skipped. */
const STREAM_EVENTS: ReadonlySet<string> = new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);

/** A stream's block index: a whole number from 0, else null. */
const blockIndex = (v: unknown): number | null => (isCount(v) ? v : null);

/**
 * An Anthropic Messages event stream (the bytes of a streamed answer, comments and all) as the one Messages document a
 * buffered answer would be, the error document an in-band error event carries, or a fault (the header's `stream`).
 * Pure: the same bytes, the same answer.
 */
export function messagesStreamToMessage(bytes: Uint8Array): MessagesStream {
  const fault = (why: string): MessagesStream => ({ kind: 'fault', fault: why });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fault('the stream is not UTF-8 text');
  }
  let message: Json | null = null;
  let usage: Json | null = null;
  let stopReason: unknown = null;
  let stopSequence: unknown = null;
  let sbr: unknown;
  let stopped = false;
  const blocks = new Map<number, Json>();
  const inputs = new Map<number, string>();
  const open = new Set<number>();
  for (const [n, ev] of sseEvents(text).entries()) {
    let frame: unknown;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return fault(`the stream's event ${n + 1} is no JSON: it was cut mid-frame, or is no Messages stream`);
    }
    if (!isRecord(frame)) return fault(`the stream's event ${n + 1} is no JSON object`);
    const type = typeof frame.type === 'string' ? frame.type : ev.event;
    if (type === 'error') {
      if (!isRecord(frame.error)) return fault(`the stream's error event (event ${n + 1}) carries no error object`);
      return { kind: 'error', error: frame, status: messagesErrorStatus(frame.error.type) };
    }
    // ping, and any event type this file does not know: nothing of the answer.
    if (type === null || !STREAM_EVENTS.has(type)) continue;
    if (type === 'message_start') {
      if (message !== null) return fault(`the stream's event ${n + 1} is a second message_start`);
      if (!isRecord(frame.message)) return fault('the stream\'s message_start carries no message');
      message = { ...frame.message };
      usage = isRecord(message.usage) ? { ...message.usage } : null;
      continue;
    }
    if (message === null) return fault(`the stream's event ${n + 1} (${type}) comes before any message_start: it is no Messages stream`);
    const index = blockIndex(frame.index);
    switch (type) {
      case 'content_block_start': {
        if (index === null || !isRecord(frame.content_block) || blocks.has(index)) return fault(`the stream's event ${n + 1} starts no new content block`);
        const block = { ...frame.content_block };
        blocks.set(index, block);
        open.add(index);
        if (block.type === 'tool_use' || block.type === 'server_tool_use') inputs.set(index, '');
        break;
      }
      case 'content_block_delta': {
        const block = index === null ? undefined : blocks.get(index);
        if (index === null || block === undefined || !open.has(index)) return fault(`the stream's event ${n + 1} is a delta for a content block that is not open`);
        const delta = frame.delta;
        if (!isRecord(delta)) return fault(`the stream's event ${n + 1} carries no delta`);
        const join = (kind: string, key: string, more: unknown): MessagesStream | null => {
          if (block.type !== kind || typeof more !== 'string') return fault(`the stream's event ${n + 1} is a ${String(delta.type)} for a ${String(block.type)} block`);
          block[key] = (typeof block[key] === 'string' ? block[key] : '') + more;
          return null;
        };
        let bad: MessagesStream | null = null;
        if (delta.type === 'text_delta') bad = join('text', 'text', delta.text);
        else if (delta.type === 'thinking_delta') bad = join('thinking', 'thinking', delta.thinking);
        else if (delta.type === 'signature_delta') bad = join('thinking', 'signature', delta.signature);
        else if (delta.type === 'input_json_delta') {
          if (!inputs.has(index) || typeof delta.partial_json !== 'string') bad = fault(`the stream's event ${n + 1} is an input_json_delta for a ${String(block.type)} block`);
          else inputs.set(index, inputs.get(index)! + delta.partial_json);
        }
        // Any other delta type (citations, a kind this file does not know) says nothing a Chat answer carries.
        if (bad !== null) return bad;
        break;
      }
      case 'content_block_stop': {
        if (index === null || !open.has(index)) return fault(`the stream's event ${n + 1} stops a content block that is not open`);
        open.delete(index);
        const json = inputs.get(index);
        if (json !== undefined && json !== '') {
          let input: unknown;
          try {
            input = JSON.parse(json);
          } catch {
            input = undefined;
          }
          if (!isRecord(input)) return fault(`the stream's tool input at block ${index} is no JSON object`);
          blocks.get(index)!.input = input;
        }
        break;
      }
      case 'message_delta': {
        if (isRecord(frame.delta)) {
          if (frame.delta.stop_reason !== undefined) stopReason = frame.delta.stop_reason;
          if (frame.delta.stop_sequence !== undefined) stopSequence = frame.delta.stop_sequence;
        }
        if (isRecord(frame.usage)) usage = { ...(usage ?? {}), ...frame.usage };
        if (frame.sbr !== undefined && frame.sbr !== null) sbr = frame.sbr;
        break;
      }
      case 'message_stop':
        stopped = true;
        break;
    }
    if (stopped) break;
  }
  if (message === null) return fault('the stream holds no message_start: it is no Messages answer');
  if (!stopped) return fault('the stream ended before message_stop: it was cut off before the answer finished');
  if (open.size > 0) return fault(`the stream's content block ${[...open][0]} never stopped`);
  if (stopReason === null) return fault('the stream ended with no stop_reason');
  const doc: Json = { ...message };
  doc.content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
  doc.stop_reason = stopReason;
  doc.stop_sequence = stopSequence;
  if (usage !== null) doc.usage = usage;
  if (sbr !== undefined) doc.sbr = sbr;
  return { kind: 'message', message: doc };
}
