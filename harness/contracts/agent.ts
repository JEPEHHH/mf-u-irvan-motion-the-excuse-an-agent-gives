// The agent/v1 harness's records (contracts/competition.ts AgentHarness): what an LLM agent entry is
// graded from. A run is K trials, one per beacon-drawn instance that every entry of the phase shares
// (paired). Each trial runs the entry against the bundle's env (the store simulator) with one prompt,
// its model calls going only through the gateway forwarder, which meters each one against the
// trial's budget and records it in the trial's cassette. A LIVE pass records the cassette; a REPLAY
// pass serves it back with no upstream, and the store's canonical state.json must come out
// byte-equal.
//
//   cassette         agent-fun/cassette/v1 (Cassette): one trial's model traffic. Every request the
//                    forwarder answered is an entry, in arrival order: its route, its request key,
//                    model and streaming, how it ended (outcome), the response's status, content
//                    type and body digest (the body itself sits in the blob store, named by that
//                    sha256), its usage and its price. A refusal is an entry too, so a replay
//                    reproduces it. The totals add the entries up.
//   trials manifest  agent-fun/agent-trials/v1 (AgentTrials): the run's action log, the document
//                    run.action_log_sha256 names. Per trial that counts, in index order: its
//                    instance, how it ended, the digests of its cassette, its state export and its
//                    env log, the state export as program outputs (what the scorer reads at
//                    /output), and the digest of the brief its entry read (absent on a manifest
//                    written before that was recorded), and under a target harness the digest of
//                    its house cassette (the env's calls to the target's models, a Cassette too).
//                    An L1 regrade rescores the outputs; an L2 regrade replays each cassette. A void
//                    trial (an infrastructure fault) never appears: it re-runs on the same instance.
//   entry env        the variables a trial's entry runs with (AGENT_ENTRY_ENV, AGENT_GATEWAY_ENV);
//                    the house lane's go to the env alone (AGENT_HOUSE_ENV)
//
// Micro-USD are decimal strings (U64), token and request counts integers, as in contracts/score.ts.

import { z } from 'zod';
import { IsoDateTime, Sha256Hex, U64 } from './primitives.ts';

// ---------------------------------------------------------------- trial statuses

/**
 * How a trial that counts ended:
 *   - finished: the agent exited (a crash or a spent budget included) and its replay matched; the
 *     store it left is scored
 *   - timeout: the wall budget ran out; it scores 0 on every column
 *   - nondeterministic: its replay missed the cassette, left entries unconsumed or exported another
 *     state.json; the run is listed and unranked
 */
export const AGENT_TRIAL_STATUSES = ['finished', 'timeout', 'nondeterministic'] as const;
export const AgentTrialStatus = z.enum(AGENT_TRIAL_STATUSES);
export type AgentTrialStatusT = (typeof AGENT_TRIAL_STATUSES)[number];

const issuer =
  (ctx: { addIssue: (i: { code: 'custom'; path: (string | number)[]; message: string }) => void }) =>
  (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });

/** Run a refinement only on a value whose shape already parsed. */
const whenValid = { when: (payload: { issues: readonly unknown[] }): boolean => payload.issues.length === 0 };

/** Index-ordered trials, each on an instance of its own: what the manifest and the performance both list. */
export function checkTrialOrder(trials: readonly { index: number; instance_sha256: string }[], path: (string | number)[], issue: (path: (string | number)[], message: string) => void): void {
  const instances = new Set<string>();
  trials.forEach((t, i) => {
    if (i > 0 && t.index <= trials[i - 1]!.index) issue([...path, i, 'index'], `trial ${t.index} comes after trial ${trials[i - 1]!.index}: trials are listed once each, in index order`);
    if (instances.has(t.instance_sha256)) issue([...path, i, 'instance_sha256'], `instance ${t.instance_sha256} is another trial's: each trial runs on an instance of its own`);
    instances.add(t.instance_sha256);
  });
}

// ---------------------------------------------------------------- cassette

export const CASSETTE_FORMAT = 'agent-fun/cassette/v1';

/**
 * The forwarder's routes: POST /v1/messages (anthropic.messages), POST /v1/chat/completions
 * (openai.chat), POST /v1/responses (openai.responses) and GET /v1/models (models, answered from the
 * bundle's allowlist).
 */
export const CASSETTE_ROUTES = ['anthropic.messages', 'openai.chat', 'openai.responses', 'models'] as const;
export const CassetteRoute = z.enum(CASSETTE_ROUTES);

/**
 * How a request ended: upstream (the upstream answered it, or the forwarder did for `models`), refused
 * (the forwarder's policy refused it before forwarding: a model off the allowlist, a missing or
 * oversized max_tokens, a body over max_request_bytes, the request cap or the budget; or a body that
 * is not JSON), upstream_error (a 5xx, a 429 the policy did not raise, a 401/402/403 on the trial's key
 * or account, masq's own refusals among them, a connect failure or reset: what the void rule counts;
 * grader/gateway/meter.ts classifyOutcome has the whole list).
 */
export const CASSETTE_OUTCOMES = ['upstream', 'refused', 'upstream_error'] as const;
export const CassetteOutcome = z.enum(CASSETTE_OUTCOMES);

/** A response's token counts, normalised (pricing/engine.ts TokenCounts): reasoning is the subset of output a model reported as such. */
export const CassetteUsage = z
  .strictObject({
    /** Uncached, unwritten input. */
    input: z.int().min(0),
    output: z.int().min(0),
    cache_read: z.int().min(0),
    cache_write_5m: z.int().min(0),
    cache_write_1h: z.int().min(0),
    reasoning: z.int().min(0),
  })
  .refine((u) => u.reasoning <= u.output, { message: 'reasoning is a subset of output', path: ['reasoning'], ...whenValid });

export const CassetteEntry = z
  .strictObject({
    /** 0-based arrival order: entry i has seq i. */
    seq: z.int().min(0),
    /** When the forwarder took the request: the time it is priced at. */
    at: IsoDateTime,
    route: CassetteRoute,
    /**
     * The replay matcher's key: the sha256 of the canonical JSON of the request's route, its
     * anthropic-version, anthropic-beta and openai-beta headers and its parsed JSON body (no other
     * header, so an SDK's retry counter never moves it). Null only on a refused request whose body is
     * not JSON.
     */
    request_key: Sha256Hex.nullable(),
    /** The model the request named; null on `models` and on a refused request naming none. */
    model: z.string().min(1).nullable(),
    stream: z.boolean(),
    outcome: CassetteOutcome,
    /** The HTTP status the entry was answered with. */
    status: z.int().min(100).max(599),
    content_type: z.string().min(1),
    /** sha256 of the response body as the entry received it (streamed bytes included), the blob it is stored as. */
    body_sha256: Sha256Hex,
    /** Null when the response carried none (a refusal, `models`, an error before any usage). */
    usage: CassetteUsage.nullable(),
    /**
     * The request's price at `at`, at the service tier the call billed at (grader/gateway/policy.ts
     * priceAtTier; meter.ts billedTier: the tier the response reported, else the one the request
     * named); 0 when nothing was billed.
     */
    micro_usd: U64,
  })
  .superRefine((e, ctx) => {
    const issue = issuer(ctx);
    if (e.request_key === null && e.outcome !== 'refused') issue(['request_key'], 'only a refused request has no request key: every request the forwarder forwards is keyed');
    if (e.outcome === 'refused') {
      if (e.usage !== null) issue(['usage'], 'a refused request never reached the upstream: it has no usage');
      if (e.micro_usd !== '0') issue(['micro_usd'], 'a refused request never reached the upstream: it costs 0');
    }
    if (e.route === 'models') {
      if (e.model !== null) issue(['model'], 'a models request names no model');
      if (e.usage !== null) issue(['usage'], 'the forwarder answers a models request from the allowlist: it has no usage');
      if (e.micro_usd !== '0') issue(['micro_usd'], 'the forwarder answers a models request from the allowlist: it costs 0');
    }
  }, whenValid);

const ZERO_USAGE = { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, reasoning: 0 } as const;
const USAGE_KEYS = Object.keys(ZERO_USAGE) as (keyof typeof ZERO_USAGE)[];

/** What a cassette's entries add up to. */
export const CassetteTotals = z.strictObject({
  /** Every entry. */
  requests: z.int().min(0),
  /** The entries of each outcome: upstream + refused + upstream_errors = requests. */
  upstream: z.int().min(0),
  refused: z.int().min(0),
  upstream_errors: z.int().min(0),
  /** The entries' micro_usd summed. */
  micro_usd: U64,
  /** The entries' usage summed, each token class apart. */
  usage: CassetteUsage,
});

export const Cassette = z
  .strictObject({
    format: z.literal(CASSETTE_FORMAT),
    /** The trial it was recorded on: its index in the run and its instance. */
    trial: z.strictObject({ index: z.int().min(0), instance_sha256: Sha256Hex }),
    /** The pricing rows every entry was priced on (pricing/price.ts pricingRev). */
    pricing_rev: z.string().min(1),
    entries: z.array(CassetteEntry),
    totals: CassetteTotals,
  })
  .superRefine((c, ctx) => {
    const issue = issuer(ctx);
    const sum = { requests: c.entries.length, upstream: 0, refused: 0, upstream_errors: 0, micro_usd: 0n, usage: { ...ZERO_USAGE } as Record<keyof typeof ZERO_USAGE, number> };
    c.entries.forEach((e, i) => {
      if (e.seq !== i) issue(['entries', i, 'seq'], `entry ${i} has seq ${e.seq}: entries are in arrival order, seq 0, 1, 2, ...`);
      if (e.outcome === 'upstream') sum.upstream++;
      else if (e.outcome === 'refused') sum.refused++;
      else sum.upstream_errors++;
      sum.micro_usd += BigInt(e.micro_usd);
      if (e.usage !== null) for (const k of USAGE_KEYS) sum.usage[k] += e.usage[k];
    });
    const t = c.totals;
    for (const k of ['requests', 'upstream', 'refused', 'upstream_errors'] as const) {
      if (t[k] !== sum[k]) issue(['totals', k], `the entries hold ${sum[k]}, not totals.${k} ${t[k]}`);
    }
    if (BigInt(t.micro_usd) !== sum.micro_usd) issue(['totals', 'micro_usd'], `the entries cost ${sum.micro_usd}, not totals.micro_usd ${t.micro_usd}`);
    for (const k of USAGE_KEYS) {
      if (t.usage[k] !== sum.usage[k]) issue(['totals', 'usage', k], `the entries' usage holds ${sum.usage[k]} ${k} tokens, not ${t.usage[k]}`);
    }
  }, whenValid);

// ---------------------------------------------------------------- trials manifest

export const AGENT_TRIALS_FORMAT = 'agent-fun/agent-trials/v1';

/** The program outputs' format: grader/program.ts PROGRAM_OUTPUTS_FORMAT, whose ProgramOutputs a trial's outputs are. */
export const TRIAL_OUTPUTS_FORMAT = 'agent-fun/program-outputs/v1';

/**
 * A trial's state export as program outputs (grader/program.ts ProgramOutputs, the same shape): each
 * file under the export, its path relative to it, its size and the sha256 it is stored under in the
 * blob store. The scorer reads them at /output.
 */
export const TrialOutputs = z.strictObject({
  format: z.literal(TRIAL_OUTPUTS_FORMAT),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      size: z.int().min(0),
      sha256: Sha256Hex,
    }),
  ),
});

/** A trial's stand-in entry key as grader/agent.ts makes it (entryLaneKey, podEntryLaneKey): AGENT_TRIAL_DUMMY_KEY, `-` and 48 lower hex. */
export const AGENT_ENTRY_KEY_RE = /^makefun-trial-[0-9a-f]{48}$/;

export const AgentTrialRecord = z.strictObject({
  /** The trial's index in the run: the instance's trial index t of the draw. */
  index: z.int().min(0),
  /** The instance it ran on (the draw record's instance_sha256 of trial t). */
  instance_sha256: Sha256Hex,
  status: AgentTrialStatus,
  /** sha256 of the trial's canonical cassette JSON (Cassette), as stored. */
  cassette_sha256: Sha256Hex,
  /** sha256 of the state.json the live pass exported: the bytes the replay must reproduce. */
  state_sha256: Sha256Hex,
  /** sha256 of the env's call log (calls.ndjson), as stored. */
  env_log_sha256: Sha256Hex,
  outputs: TrialOutputs,
  /**
   * sha256 of the brief the live pass copied to the entry's /input/prompt.txt (grader/agent.ts
   * trialBriefSource): the instance's input/prompt.txt, or reference/baseline-prompt.txt for a
   * flagged baseline on an instance that has one. Optional: a manifest written before it was
   * recorded has none, and still parses.
   */
  prompt_sha256: Sha256Hex.optional(),
  /**
   * sha256 of the trial's house cassette's canonical JSON (Cassette), as stored: the calls the env made
   * to the target's models through the house lane (AGENT_HOUSE_ENV; contracts/competition.ts
   * AgentTarget), its totals on the cassette itself. Absent under a harness without a target, and no
   * key appears, so a record without it keeps its bytes.
   */
  house_cassette_sha256: Sha256Hex.optional(),
  /**
   * The stand-in key this trial's passes handed its entry in both API key variables (AGENT_GATEWAY_ENV; grader/agent.ts
   * podEntryLaneKey), present exactly on a trial whose entry ran one pod: a stand-in, never a credential (the forwarder
   * admits it, drops it and injects the real one), written so that every later replay, the public kit's included, hands
   * the entry the same one. Absent on the split layout, whose key derives from the trial (entryLaneKey), so a record
   * without it keeps its bytes.
   */
  entry_key: z.string().regex(AGENT_ENTRY_KEY_RE).optional(),
});

/** The run's action log: every trial that counts, in index order, each on an instance of its own. */
export const AgentTrials = z
  .strictObject({
    format: z.literal(AGENT_TRIALS_FORMAT),
    trials: z.array(AgentTrialRecord).min(1),
  })
  .superRefine((m, ctx) => checkTrialOrder(m.trials, ['trials'], issuer(ctx)), whenValid);

// ---------------------------------------------------------------- entry environment

/**
 * The variables a trial's entry runs with (grader/agent.ts sets them; the sandbox admits exactly
 * these besides its own). The shop token, the trial seed and the trial time derive from (instance,
 * trial), so a live pass and its replay see the same values.
 */
export const AGENT_ENTRY_ENV = Object.freeze({
  /**
   * The path of the one merchant brief, the only file the agent sees: the instance's input/prompt.txt
   * (a flagged baseline's: the instance's reference/baseline-prompt.txt when it has one, copied to the
   * same path).
   */
  promptFile: 'MAKEFUN_PROMPT_FILE',
  /** The store's Admin GraphQL endpoint (AGENT_SHOP_GRAPHQL_URL). */
  shopGraphqlUrl: 'MAKEFUN_SHOP_GRAPHQL_URL',
  /** The X-Shopify-Access-Token the store takes. */
  shopToken: 'MAKEFUN_SHOP_TOKEN',
  /** The supplier's REST API. */
  supplierUrl: 'MAKEFUN_SUPPLIER_URL',
  trialSeed: 'MAKEFUN_TRIAL_SEED',
  /** The instance's fixed opening time: the store's every timestamp. */
  trialNow: 'MAKEFUN_TRIAL_NOW',
  /** The env's origin (AGENT_ENV_URL), the same in every trial whatever the env simulates. */
  envUrl: 'MAKEFUN_ENV_URL',
} as const);

/**
 * The model SDKs' own variables, pointed at the gateway forwarder: base URLs, never HTTP_PROXY (Node's
 * fetch ignores it), and the trial's entry key in both API key variables: AGENT_TRIAL_DUMMY_KEY, `-`
 * and 48 hex, on the split layout derived from the trial (grader/agent.ts entryLaneKey), on one pod the
 * run's own for that trial (podEntryLaneKey), which its record carries (AgentTrialRecord.entry_key); on
 * both the same on its live pass, its replay and every regrade, the public kit's included. The forwarder
 * admits that key alone, drops it and injects the real one; on the split layout the gate is hygiene
 * against an env calling the entry's lane by mistake, not a secret boundary.
 */
export const AGENT_GATEWAY_ENV = Object.freeze({
  anthropicBaseUrl: 'ANTHROPIC_BASE_URL',
  openaiBaseUrl: 'OPENAI_BASE_URL',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
} as const);

/** Every variable name above, entry first: what a trial's entry environment holds, and nothing else of ours. */
export const AGENT_ENV_NAMES: readonly string[] = Object.freeze([...Object.values(AGENT_ENTRY_ENV), ...Object.values(AGENT_GATEWAY_ENV)]);

/**
 * The house lane's variables (contracts/competition.ts AgentTarget), which go to the env alone, never
 * to the entry (AGENT_ENV_NAMES holds neither): the house's model endpoint the env calls the target's
 * models through, and the token it presents there. A harness without a target gives the env neither.
 */
export const AGENT_HOUSE_ENV = Object.freeze({
  houseLlmUrl: 'MAKEFUN_HOUSE_LLM_URL',
  houseToken: 'MAKEFUN_HOUSE_TOKEN',
} as const);

/**
 * The stem of the API key every entry is given (AGENT_GATEWAY_ENV), never a real key: a trial's key is
 * this, `-` and 48 hex (AGENT_ENTRY_KEY_RE), derived from the trial on the split layout, on one pod the
 * run's own for that trial and carried in its record (AgentTrialRecord.entry_key).
 */
export const AGENT_TRIAL_DUMMY_KEY = 'makefun-trial';

/** The forwarder's base URLs on the trial network (its alias `llm`). */
export const AGENT_ANTHROPIC_BASE_URL = 'http://llm:8080';
export const AGENT_OPENAI_BASE_URL = 'http://llm:8080/v1';

/** The env's origin on the trial network (its alias `store`): MAKEFUN_ENV_URL. */
export const AGENT_ENV_URL = 'http://store:8080';

/** The store's Admin GraphQL endpoint on the trial network (its alias `store`). */
export const AGENT_SHOP_GRAPHQL_URL = 'http://store:8080/admin/api/2026-10/graphql.json';

export type CassetteT = z.infer<typeof Cassette>;
export type CassetteEntryT = z.infer<typeof CassetteEntry>;
export type CassetteUsageT = z.infer<typeof CassetteUsage>;
export type AgentTrialsT = z.infer<typeof AgentTrials>;
export type AgentTrialRecordT = z.infer<typeof AgentTrialRecord>;
export type TrialOutputsT = z.infer<typeof TrialOutputs>;
