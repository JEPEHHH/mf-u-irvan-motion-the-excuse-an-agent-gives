// masq's key broker, from the grader's side: each agent/v1 live pass runs on a masq key of its own,
// minted for it before the pass, disabled after it, and its spend read back against the forwarder's
// own meter. The forwarder (grader/gateway/server.ts) calls masq on that key through upstream.ts
// masqUpstream, which puts MASQ_HEADERS on every forwarded request: x-masq-pin: strict (no
// substitution, no reroute; upstream errors pass through), x-masq-verbatim: 1, x-masq-policy: off.
//
// The broker's routes (masq src/admin-keys.ts, key-profile.ts), each called with the masq admin key
// presented as a header (x-api-key; masq refuses its dashboard cookie for these):
//
//   POST /admin/keys               mint: {label, dailyLimitUsd, allowedModels, expiresAt, notes}
//                                  -> 201 {id, key, prefix, label, expiresAt}. The body is strict on
//                                  masq's side (an unknown field is a 400), so it carries only these:
//                                    label          makefun/<slug>/<run>/<trial>/<attempt>, and
//                                                   /house after it for the pass's house lane key
//                                                   (TrialKeySpec.role: the env's calls to a target)
//                                    dailyLimitUsd  the trial's budget_usd_per_trial × 1.05: a backstop
//                                                   only, the forwarder enforcing the budget first
//                                                   (masq stops a key at 98% of its cap and reserves
//                                                   an estimate before each request)
//                                    allowedModels  the bundle's model globs (AgentInference.models),
//                                                   each `?` widened to masq's `*` (masqModelGlob)
//                                    expiresAt      now + 2 × wall_budget_sec + 1 h, in ms: under 24 h,
//                                                   so the daily cap is the key's lifetime cap
//                                    notes          what the key is for
//   POST /admin/keys/:id/disable   retire: -> 200 {id, disabledAt, alreadyDisabled}; idempotent
//   GET  /admin/key?id=&window=    spend: {window, key, hidden, spend, profile}. Two figures for a key:
//                                  its request log, profile.totals over the window (listCostUsd, every
//                                  request the key sent at list price; requests, their count), and its
//                                  cap ledger, spend.last24hUsd (a rolling 24 h). The ledger lags the
//                                  request log by minutes after a key's last request: #1669's pilot read
//                                  it straight after disable and under-read the forwarder's meter by 2%
//                                  to 41% on 16 of 18 passes, one key's ledger still stale minutes later,
//                                  while the request log equalled the meter on every key. So the figure
//                                  is the request log's: over the ledger's 24 h window while the key was
//                                  made within it, which covers all of its life, and over a window
//                                  reaching back to its creation for a key read later than that. The
//                                  ledger is the figure only where masq answers no request log for a
//                                  key; otherwise it is kept beside the figure, for the record.
//   GET  /admin/keys?label_prefix= every key masq holds, never its secret: {keys: [{id, prefix, label,
//                                  role, state, …, adminSources}]} (admin-keys.ts brokerKeyRow). Read
//                                  only to find the admin key's own row (below).
//
// The admin key is pinned to the grader host(s) (server/config.ts MAKEFUN_LLM_GATEWAY_ADMIN_KEY): a
// leaked admin key could mint keys with any budget, and masq's source pin (`masq keys admin-sources
// <id> <cidr,…>`, keys.ts adminSourceAllows) refuses it on /admin/* from any other address. Before it
// mints anything the broker reads that pin back (verifyAdminKey): its own row in the listing, found by
// masq's display prefix of the key (keys.ts displayPrefix / foreignPrefix), the one active admin key
// there with that prefix. An admin key with no pin, or one entry wider than a /24
// (MASQ_ADMIN_SOURCE_MIN_PREFIX, judged by masq's own matcher, so `0.0.0.0/0` is no pin), or a masq
// whose listing carries no adminSources at all, is a MasqAdminKeyRefusal: a configuration fault, never
// an infrastructure void, and no trial key is minted until the operator pins the key. A good answer
// holds for MASQ_ADMIN_KEY_RECHECK_MS; a refusal is never cached, so a pin set on the box is picked
// up by the next mint. openMasqBroker runs the same check when the grader starts.
//
// masq itself refuses that read when the grader's own address is not in the pin: a 403, `this admin
// key is restricted to other source addresses; this request came from <ip>` (src/server.ts). masq
// answered before the listing began, so there is no row to read the pin from. openMasqBroker (the
// start-of-grader check) reads that answer as the same MasqAdminKeyRefusal, problem `source`, with a
// message naming the address masq saw and the `masq keys admin-sources` line that adds it, so a
// grader whose egress moved pages the operator at start instead of logging. A mint's own read is the
// mint's fault as before (a MasqBrokerError, its pass void and re-run): only the start-of-grader
// check classifies it, so no trial's behaviour changes.
//
// After the pass, retireTrialKey disables the key, then reads its spend once masq has settled it: the
// spend read (MasqBroker.spend) reads the key at once, then again MASQ_SPEND_SETTLE_GAP_MS after each
// read until two reads agree on the figure and the request count, for at most MASQ_SPEND_SETTLE_CAP_MS
// from the first (grading is never held longer); a figure still moving then is kept as the last read
// gave it, unsettled. A settled figure is compared with the forwarder's meter (the cassette's
// totals.micro_usd): a gap of more than MASQ_SPEND_TOLERANCE_PERCENT of the meter (and more than masq's
// own rounding, MASQ_SPEND_ROUNDING_MICRO_USD) sets the run flag GATEWAY_SPEND_MISMATCH_FLAG, for
// admins. An unsettled figure is recorded as unsettled and never judged: never a mismatch, no flag.
// None of it ever changes a score.
//
// Every broker fault (no connection, TLS not verified, a timeout, a dropped connection, a status
// other than the route's 2xx, an answer that is not the route's shape) is a MasqBrokerError, an
// infrastructure fault and never the entry's: the trial is void and re-runs live on a fresh key.
// The admin key and every key minted are secrets: no message, error or log line carries one
// (MasqBrokerError's message is scrubbed of both), and a mint answer is the only place a trial key
// appears (MintedTrialKey.key, for the forwarder's config file and nothing else).
//
// Each request goes to the configured origin (parseOrigin: scheme, host and port only), verifies TLS
// whatever NODE_TLS_REJECT_UNAUTHORIZED says, follows no redirect (a 3xx is a fault), reads at most
// MAX_BROKER_RESPONSE_BYTES (the key listing MAX_BROKER_LISTING_BYTES: masq keeps every trial key
// listed after it is disabled; a request page MAX_BROKER_PAGE_BYTES) and gives up after
// MASQ_BROKER_TIMEOUT_MS.
//
// Build keys (a bounty with a build allowance, server/metering): the same broker mints each entrant
// one masq key to build with (MasqBuildKeyBroker.mintBuildKey), disables it, and pages every request
// masq metered on it (MasqBuildKeyBroker.requests), which the house stores and ranks on. Two more
// routes, on the same admin key and under the same rules:
//
//   POST /admin/keys               the mint above, with monthlyLimitUsd beside dailyLimitUsd:
//                                    label          makefun/<slug>/build/<user id>/<n>, n the
//                                                   entrant's nth key for the competition
//                                    dailyLimitUsd  = monthlyLimitUsd = the entrant's cap / 0.98, floored
//                                                   to the cent (buildKeyLimitMicroUsd): masq stops a key
//                                                   at 98% of each cap (meter.ts SPEND_CAP_SAFETY), so its
//                                                   stop never passes the cap. The smallest cap a key can
//                                                   hold is MASQ_BUILD_KEY_MIN_CAP_MICRO_USD (one cent,
//                                                   stopped at 98%: 9800 µUSD); one under it is refused.
//                                                   A key lives for weeks, so the daily cap is no
//                                                   lifetime cap and masq's monthly cap resets on the
//                                                   1st (UTC): the house disables a key whose lifetime
//                                                   spend reaches its cap
//                                    allowedModels  the bundle's build_meter.models as a trial key's are,
//                                                   or `*` alone (every model: BuildKeyModels) as it is
//                                    expiresAt      the caller's (the competition's deadline + 1 h), in
//                                                   the future, however far: masq sets a key no longest
//                                                   life (admin-keys.ts expiresField). A trial key keeps
//                                                   its under-24 h rule (trialKeyExpiresAt)
//   GET  /admin/requests?kind=key&value=<id>&window=&limit=&before=&beforeId=
//                                  the key's requests, newest first: {rows: [...], inflight: [...]}
//                                  (server.ts, meter.ts recentRequests). At most
//                                  MASQ_REQUESTS_PAGE_MAX rows a page; `before`/`beforeId`, the last
//                                  row's ts and id, resume the walk just past it (masq ignores a cursor
//                                  that is not both, and answers the newest page again, so the broker
//                                  sends both or neither and refuses a page that did not resume). Each
//                                  row's listCostUsd is recorded to 6 decimals (pricing.ts), so it is
//                                  exact µUSD (listCostMicroUsd) and the rows sum exactly; a key
//                                  profile's totals are rounded to 4 decimals (meter.ts keyProfile) and
//                                  are never the figure here. A row that is not exact µUSD, a row of
//                                  another key, or a page out of order is a `protocol` fault.
//                                  `inflight` is every request masq has started and not yet recorded,
//                                  every key's (meter.ts inflightNow, LiveStart: id, ts, keyId,
//                                  keyPrefix, keyLabel, …), read after the rows. The broker keeps those
//                                  that may be the key's (MasqRequestPage.inflight): each naming its id,
//                                  and each naming no key id at all (a start mirrored from a masq slot
//                                  on an older build sends none), kept with its keyPrefix and keyLabel
//                                  for the caller to match; one naming another key, or none (an open
//                                  request, keyId null), is dropped. A request in flight lands as a row
//                                  later, so a settle waits until none is in flight
//                                  (server/metering/sync.ts settleKey). An answer with no in-flight
//                                  list, or an entry that may be the key's not of LiveStart's shape, is
//                                  a `protocol` fault.
//
// A build key is a secret like a trial key: MintedBuildKey.key is the one place it appears, for the
// entrant once, and every broker message is scrubbed of it.
//
// A judge key (makefun/<slug>/judge/<phase>/<attempt>, judgeKeyRequest) carries a judge heat's house
// calls (grader/judge-call.ts): it allows the judge's one pinned model (with the id masq routes it to, for
// the superbot family: server/house-model.ts masqAllowedModels) for under 24 h, and is retired as a trial key
// is (retireTrialKey against the heat record's priced total). Every judge key, a judge heat's
// (grader/judge-call.ts openJudgeHeat: final, provisional or local) and a house forecast's
// (grader/house-forecast.ts) alike, carries no dollar cap, its body sending no dailyLimitUsd (masq
// admin-keys.ts mints a key with no limit): house-paid judging has no spend cap (the owner, 2026-11-11),
// so its request ledger, its max_output_tokens, the one pinned model and its under-24 h life bound it.
// MintedJudgeKey.key is the one place its secret appears. A local heat (makefun grade-local
// --judge) counts its attempts on no server ledger, so its phase segment is `local`, never `dev`: its
// label can never be a server heat's.
//
// A witness key (makefun/<slug>/witness/<n>/<attempt>, witnessKeyRequest) carries one trial of a
// patch pack's witness (scripts/patch/witness.ts: the house patch agent on the pack's dev tree): it
// allows the trial's one model, caps at the trial's cap × 1.05, lives 2 × the trial's wall budget +
// 1 h as a trial key does, and is retired as a trial key is (retireTrialKey against the trial's own
// priced total). MintedWitnessKey.key is the one place its secret appears.
//
// masq answers a key it minted a moment ago 401 ("unrecognised API key") on its OpenAI routes for a
// few seconds (2026-11-06: Bearer 401 at 1.6 s while x-api-key answered, 200 at 5.8 s). Every mint
// waits that out before it resolves, so no key's first use comes before masq knows it: a trial key
// (the entry lane's and the house lane's alike: the forwarder relays a 401 to the agent as it came,
// upstream.ts, and any house-lane upstream error voids the pass, grader/agent.ts), a judge key, a
// witness key and a build key. The shared mint reads masq's model list as the new key (GET /v1/models,
// Bearer; masq answers it unmetered and logs no request row) until masq answers 200, again after each
// 401, for at most MASQ_KEY_WARMUP_MS. A judge key hands the list on (MintedJudgeKey.models: the heat
// reads its model's card there), and a witness key too (MintedWitnessKey.models: the witness reads
// there that masq serves its model). A key masq never answers in that window is disabled and its mint fails (op
// key_ready), whatever the key was for: a trial's is an infrastructure void that re-runs.

import { request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { allowsEveryModel, EVERY_MODEL_GLOB, ModelGlob, ModelId } from '../../contracts/competition.ts';
import { Slug } from '../../contracts/primitives.ts';
import type { Config } from '../../server/config.ts';
import { masqAllowedModels } from '../../server/house-model.ts';
import { GATEWAY_USER_AGENT, MAX_UPSTREAM_HEADER_BYTES, parseOrigin, UpstreamKey, type UpstreamConfigT } from './upstream.ts';

/** The label's first segment: every trial key reads makefun/<slug>/<run>/<trial>/<attempt>. */
export const MASQ_KEY_LABEL_PREFIX = 'makefun';
/** dailyLimitUsd is the trial's budget × this / 100: a 5% backstop over the forwarder's own budget. */
export const MASQ_DAILY_LIMIT_PERCENT = 105n;
/** expiresAt is now + 2 × the wall budget + this. */
export const MASQ_KEY_GRACE_MS = 60 * 60_000;
/** A trial key lives strictly less than this, so its daily cap is its lifetime cap. */
export const MASQ_KEY_MAX_LIFETIME_MS = 24 * 60 * 60_000;
/** masq's cap ledger window (spend.last24hUsd): a rolling 24 h. */
export const MASQ_SPEND_LEDGER_MS = 24 * 60 * 60_000;
/** A key's spend is read again this long after each read until two reads agree: then it has settled. */
export const MASQ_SPEND_SETTLE_GAP_MS = 10_000;
/** The longest a spend read waits for the figure to settle, from its first read: a figure still moving then is kept, unsettled. */
export const MASQ_SPEND_SETTLE_CAP_MS = 5 * 60_000;
/** A masq spend more than this percent away from the forwarder's meter is a mismatch. */
export const MASQ_SPEND_TOLERANCE_PERCENT = 5n;
/** masq rounds its USD figures to 4 decimals: a gap within half of $0.0001 is its rounding, never a mismatch. */
export const MASQ_SPEND_ROUNDING_MICRO_USD = 50n;
/** The run flag a spend mismatch sets (admins only; never a score). */
export const GATEWAY_SPEND_MISMATCH_FLAG = 'gateway_spend_mismatch';
/** How long one broker request may take, connection included. */
export const MASQ_BROKER_TIMEOUT_MS = 30_000;
/** The largest broker answer read (a key's profile carries its top models and clients). */
export const MAX_BROKER_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The largest key listing read: every key masq holds, each disabled trial key included (about 700 bytes a key). */
export const MAX_BROKER_LISTING_BYTES = 64 * 1024 * 1024;
/** The widest admin-source entry an admin key may be pinned with: a /24 (256 addresses) at most. */
export const MASQ_ADMIN_SOURCE_MIN_PREFIX = 24;
/** How long a good read of the admin key's pin holds before a mint reads it again. */
export const MASQ_ADMIN_KEY_RECHECK_MS = 60 * 60_000;
/** masq's model list on a key (OpenAI's GET /v1/models): what every fresh key is asked until masq answers it. */
export const MASQ_MODELS_PATH = '/v1/models';
/** The longest a fresh key's mint waits for masq to answer the key (see the header), from its first read. */
export const MASQ_KEY_WARMUP_MS = 60_000;
/** The wait after a fresh key's first 401; each next wait doubles, the last cut to what is left of MASQ_KEY_WARMUP_MS. */
export const MASQ_KEY_WARMUP_GAP_MS = 500;
/** masq's longest label, notes and allowlist (admin-keys.ts MAX_LABEL, MAX_NOTES, MAX_MODELS). */
export const MASQ_MAX_LABEL = 200;
export const MASQ_MAX_NOTES = 2_000;
export const MASQ_MAX_MODELS = 200;
/** A build key's label's third segment, where a trial key's has its run id: makefun/<slug>/build/<user id>/<n>. */
export const MASQ_BUILD_KEY_SEGMENT = 'build';
/** A judge key's label's third segment, where a trial key's has its run id: makefun/<slug>/judge/<phase>/<attempt>. */
export const MASQ_JUDGE_KEY_SEGMENT = 'judge';
/** A witness key's label's third segment, where a trial key's has its run id: makefun/<slug>/witness/<n>/<attempt>. */
export const MASQ_WITNESS_KEY_SEGMENT = 'witness';
/** masq stops a key at this percent of each cap it carries (meter.ts SPEND_CAP_SAFETY, 0.98). */
export const MASQ_SPEND_CAP_SAFETY_PERCENT = 98n;
/**
 * The smallest cap a build key can hold, µUSD: buildKeyLimitMicroUsd's floor, a cap whose / 0.98 floors to one cent
 * (masq's stop at MASQ_SPEND_CAP_SAFETY_PERCENT of a one-cent cap), 9800 µUSD ($0.0098). Every build-key floor is this
 * one: the least key issued (server/metering/build-keys.ts) and the least share (server/config.ts).
 */
export const MASQ_BUILD_KEY_MIN_CAP_MICRO_USD = (10_000n * MASQ_SPEND_CAP_SAFETY_PERCENT) / 100n;
/** The most rows masq answers on one GET /admin/requests page (server.ts clamps `limit` to it). */
export const MASQ_REQUESTS_PAGE_MAX = 500;
/** The largest request page read: MASQ_REQUESTS_PAGE_MAX rows of masq's request detail (about 3 KB each) and its in-flight list. */
export const MAX_BROKER_PAGE_BYTES = 16 * 1024 * 1024;
/** masqWindowSince's margin past the instant it must reach: the two clocks may disagree, and a wider window costs nothing (rows are the key's alone). */
export const MASQ_WINDOW_MARGIN_MS = 60 * 60_000;

const MICRO_PER_CENT = 10_000n;
const MICRO_PER_USD = 1_000_000;

// ------------------------------------------------------------------ the mint request

/** What a trial key is minted for. */
export interface TrialKeySpec {
  /** The competition's slug. */
  slug: string;
  /** The run's id (run.id). */
  runId: string;
  /** The trial's index (run_trial.trial_index), from 0. */
  trialIndex: number;
  /** The live pass this key is for (run_trial.attempt once it starts), from 1: a void's re-run mints anew. */
  attempt: number;
  /** AgentInference.budget_usd_per_trial: USD above 0, at most two decimals. */
  budgetUsdPerTrial: number;
  /** AgentInference.models: the bundle's model globs. */
  models: readonly string[];
  /** The harness limits' wall_budget_sec. */
  wallBudgetSec: number;
  /**
   * `house`: the pass's house lane key (grader/agent.ts; contracts/competition.ts AgentTarget), its
   * label ending /house, its budget and models the target's. Absent: the entry's own key.
   */
  role?: 'house';
}

/** POST /admin/keys's body: exactly the fields masq takes (it refuses any other). */
export interface MintBody {
  label: string;
  /** The key's daily cap, USD; absent, masq mints the key with none (a final judge heat's: judgeKeyRequest). */
  dailyLimitUsd?: number;
  /** A build key's monthly cap (masq admin-keys.ts takes it beside dailyLimitUsd); a trial key's body has none. */
  monthlyLimitUsd?: number;
  allowedModels: string[];
  expiresAt: number;
  notes: string;
}

/** A mint body with a daily cap: every trial, build and witness key's. */
export type CappedMintBody = MintBody & { dailyLimitUsd: number };

const RUN_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** USD with at most two decimals, as whole cents; null when it is not such an amount above 0. */
function centsOf(usd: number): bigint | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  const cents = Math.round(usd * 100);
  if (Math.abs(usd * 100 - cents) >= 1e-6 || !Number.isSafeInteger(cents)) return null;
  return BigInt(cents);
}

/** The trial key's daily cap in µUSD: budget × MASQ_DAILY_LIMIT_PERCENT / 100, exact (a budget is whole cents). */
export function dailyLimitMicroUsd(budgetUsdPerTrial: number): bigint {
  const cents = centsOf(budgetUsdPerTrial);
  if (cents === null) throw new RangeError(`a trial budget is USD above 0 with at most two decimals, got ${budgetUsdPerTrial}`);
  return (cents * MICRO_PER_CENT * MASQ_DAILY_LIMIT_PERCENT) / 100n;
}

/** The key's label: makefun/<slug>/<run>/<trial>/<attempt>, and /house after it for a house lane key (TrialKeySpec.role). */
export function trialKeyLabel(spec: Pick<TrialKeySpec, 'slug' | 'runId' | 'trialIndex' | 'attempt' | 'role'>): string {
  if (!Slug.safeParse(spec.slug).success) throw new TypeError(`a trial key's slug is a competition slug, got ${JSON.stringify(spec.slug)}`);
  if (typeof spec.runId !== 'string' || !RUN_ID_RE.test(spec.runId)) throw new TypeError(`a trial key's run id is letters, digits and -, got ${JSON.stringify(spec.runId)}`);
  if (spec.runId === MASQ_BUILD_KEY_SEGMENT) throw new TypeError(`a trial key's run id is never ${JSON.stringify(MASQ_BUILD_KEY_SEGMENT)}: makefun/<slug>/${MASQ_BUILD_KEY_SEGMENT}/ labels the build keys`);
  if (spec.runId === MASQ_JUDGE_KEY_SEGMENT) throw new TypeError(`a trial key's run id is never ${JSON.stringify(MASQ_JUDGE_KEY_SEGMENT)}: makefun/<slug>/${MASQ_JUDGE_KEY_SEGMENT}/ labels the judge keys`);
  if (spec.runId === MASQ_WITNESS_KEY_SEGMENT) throw new TypeError(`a trial key's run id is never ${JSON.stringify(MASQ_WITNESS_KEY_SEGMENT)}: makefun/<slug>/${MASQ_WITNESS_KEY_SEGMENT}/ labels the witness keys`);
  if (!Number.isSafeInteger(spec.trialIndex) || spec.trialIndex < 0) throw new RangeError(`a trial index is a whole number from 0, got ${spec.trialIndex}`);
  if (!Number.isSafeInteger(spec.attempt) || spec.attempt < 1) throw new RangeError(`a live pass's attempt is a whole number from 1, got ${spec.attempt}`);
  if (spec.role !== undefined && spec.role !== 'house') throw new TypeError(`a trial key's role is house or absent, got ${JSON.stringify(spec.role)}`);
  const label = `${MASQ_KEY_LABEL_PREFIX}/${spec.slug}/${spec.runId}/${spec.trialIndex}/${spec.attempt}${spec.role === 'house' ? '/house' : ''}`;
  if (label.length > MASQ_MAX_LABEL) throw new RangeError(`the trial key's label is ${label.length} characters; masq takes at most ${MASQ_MAX_LABEL}`);
  return label;
}

/** The key's expiry (ms) for a pass starting at `now`: now + 2 × the wall budget + MASQ_KEY_GRACE_MS, refused at 24 h or more. */
export function trialKeyExpiresAt(wallBudgetSec: number, now: number): number {
  if (!Number.isSafeInteger(wallBudgetSec) || wallBudgetSec < 1) throw new RangeError(`a wall budget is whole seconds from 1, got ${wallBudgetSec}`);
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError(`now is milliseconds since the epoch, got ${now}`);
  const life = 2 * wallBudgetSec * 1000 + MASQ_KEY_GRACE_MS;
  if (life >= MASQ_KEY_MAX_LIFETIME_MS) {
    throw new RangeError(
      `a trial key lives 2 × the wall budget + 1 h, under 24 h so its daily cap is its lifetime cap; a wall budget of ${wallBudgetSec} s makes it ${(life / 3_600_000).toFixed(2)} h`,
    );
  }
  return now + life;
}

/** The usd figure of a µUSD amount, as masq takes it (a JSON number). */
function usdOf(microUsd: bigint): number {
  return Number(microUsd) / MICRO_PER_USD;
}

/**
 * A bundle model glob (contracts/competition.ts ModelGlob: `*` any run, `?` one character) as masq's
 * allowlist reads it (keys.ts modelAllowed: `*` only, any case; a `?` there is a literal). Each `?`
 * becomes `*`, so masq's allowlist is never narrower than the forwarder's, which enforces the exact
 * glob first: masq's is a backstop and must never refuse a model the bundle allows.
 */
export function masqModelGlob(glob: string): string {
  if (!ModelGlob.safeParse(glob).success) throw new TypeError(`a trial key's model glob is the bundle's (contracts/competition.ts ModelGlob), got ${JSON.stringify(glob)}`);
  return glob.replace(/\?/g, '*');
}

/** POST /admin/keys's body for the pass `spec` describes, starting at `now` (ms). Throws on a spec no key can be minted for. */
export function trialKeyRequest(spec: TrialKeySpec, now: number): CappedMintBody {
  const label = trialKeyLabel(spec);
  const daily = dailyLimitMicroUsd(spec.budgetUsdPerTrial);
  const expiresAt = trialKeyExpiresAt(spec.wallBudgetSec, now);
  const allowedModels = allowedModelsOf(spec.models, 'trial key');
  const notes =
    `makefun agent/v1 ${spec.role === 'house' ? 'house lane key' : 'trial key'}: competition ${spec.slug}, run ${spec.runId}, trial ${spec.trialIndex}, live pass ${spec.attempt}. ` +
    `Daily cap ${usdOf(daily)} USD, the trial budget ${spec.budgetUsdPerTrial} USD × 1.05, a backstop behind the gateway forwarder's own budget; ` +
    `it expires within 24 h, so the daily cap is its lifetime cap. Disabled when the pass ends.`;
  return { label, dailyLimitUsd: usdOf(daily), allowedModels, expiresAt, notes };
}

/** The model globs a key allows, as masq's allowlist reads them: 1 to MASQ_MAX_MODELS bundle globs, each `?` widened, duplicates dropped. */
function allowedModelsOf(models: readonly string[], what: string): string[] {
  if (!Array.isArray(models) || models.length === 0 || models.length > MASQ_MAX_MODELS) {
    throw new RangeError(`a ${what} allows 1 to ${MASQ_MAX_MODELS} model globs, got ${Array.isArray(models) ? models.length : typeof models}`);
  }
  return [...new Set(models.map(masqModelGlob))];
}

// ------------------------------------------------------------------ the build-key mint request

/** What a build key is minted for: one entrant's builds for one competition with a build allowance (server/metering). */
export interface BuildKeySpec {
  /** The competition's slug. */
  slug: string;
  /** The entrant's account id (user.id). */
  userId: string;
  /** The entrant's nth build key for the competition, from 1: a rotation mints the next. */
  n: number;
  /** The most the key may spend, µUSD above 0: what is left of the entrant's share of the allowance. */
  capMicroUsd: bigint;
  /** The bundle's build model globs (build_meter.models): ModelGlobs, or `*` alone, every model (BuildKeyModels). */
  models: readonly string[];
  /** When masq stops the key (ms): in the future, however far (masq sets no longest life). */
  expiresAt: number;
}

/** An account id as a label segment: letters, digits, _ and - (a user.id is a uuidv7). */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The build key's label: makefun/<slug>/build/<user id>/<n>. */
export function buildKeyLabel(spec: Pick<BuildKeySpec, 'slug' | 'userId' | 'n'>): string {
  if (!Slug.safeParse(spec.slug).success) throw new TypeError(`a build key's slug is a competition slug, got ${JSON.stringify(spec.slug)}`);
  if (typeof spec.userId !== 'string' || !USER_ID_RE.test(spec.userId)) throw new TypeError(`a build key's user id is letters, digits, _ and -, got ${JSON.stringify(spec.userId)}`);
  if (!Number.isSafeInteger(spec.n) || spec.n < 1) throw new RangeError(`a build key's number is a whole number from 1, got ${spec.n}`);
  const label = `${MASQ_KEY_LABEL_PREFIX}/${spec.slug}/${MASQ_BUILD_KEY_SEGMENT}/${spec.userId}/${spec.n}`;
  if (label.length > MASQ_MAX_LABEL) throw new RangeError(`the build key's label is ${label.length} characters; masq takes at most ${MASQ_MAX_LABEL}`);
  return label;
}

/**
 * A build key's daily and monthly cap in µUSD for a key that may spend `capMicroUsd`: the cap / 0.98,
 * floored to the cent. masq stops a key at MASQ_SPEND_CAP_SAFETY_PERCENT of each cap, so the spend it
 * stops the key at, 0.98 × this, is never past the cap. (masq admits each request against an estimate
 * of its cost, so what a key spends can pass that stop by its last request's overrun of the estimate
 * alone; the house's cap guard disables the key there.) Exact: cents = ⌊cap × 100 / (98 × 10^4)⌋. A
 * cap under one cent's stop (MASQ_BUILD_KEY_MIN_CAP_MICRO_USD, 9,800 µUSD) is refused.
 */
export function buildKeyLimitMicroUsd(capMicroUsd: bigint): bigint {
  if (typeof capMicroUsd !== 'bigint' || capMicroUsd <= 0n) throw new RangeError(`a build key's cap is µUSD above 0, got ${String(capMicroUsd)}`);
  const cents = (capMicroUsd * 100n) / (MASQ_SPEND_CAP_SAFETY_PERCENT * MICRO_PER_CENT);
  if (cents === 0n) throw new RangeError(`a build key's cap of ${capMicroUsd} µUSD is under masq's smallest cap: one cent, stopped at 98% (${MASQ_BUILD_KEY_MIN_CAP_MICRO_USD} µUSD)`);
  return cents * MICRO_PER_CENT;
}

/** The build key's expiry, checked: the caller's `expiresAt` (ms), in the future of `now`, however far (masq sets a key no longest life). */
export function buildKeyExpiresAt(expiresAt: number, now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError(`now is milliseconds since the epoch, got ${now}`);
  if (!Number.isSafeInteger(expiresAt)) throw new RangeError(`a build key's expiry is milliseconds since the epoch, got ${expiresAt}`);
  if (expiresAt <= now) throw new RangeError(`a build key's expiry is in the future: ${new Date(expiresAt).toISOString()} is not after ${new Date(now).toISOString()}`);
  return expiresAt;
}

/** POST /admin/keys's body for the build key `spec` describes, minted at `now` (ms). Throws on a spec no key can be minted for. */
export function buildKeyRequest(spec: BuildKeySpec, now: number): CappedMintBody {
  const label = buildKeyLabel(spec);
  const limit = buildKeyLimitMicroUsd(spec.capMicroUsd);
  const expiresAt = buildKeyExpiresAt(spec.expiresAt, now);
  // `*` alone is every model on a build key (contracts/competition.ts BuildKeyModels), sent as it is: masq reads it as any id.
  const allowedModels = allowsEveryModel(spec.models) ? [EVERY_MODEL_GLOB] : allowedModelsOf(spec.models, 'build key');
  const notes =
    `makefun build key: competition ${spec.slug}, entrant ${spec.userId}, key ${spec.n}, for the entrant's own model calls while building an entry; every request on it is metered and ranks the entry. ` +
    `Daily and monthly cap ${usdOf(limit)} USD: the entrant's cap ${usdOf(spec.capMicroUsd)} USD / 0.98, floored to the cent, so masq's stop at 98% never passes it; ` +
    `makefun disables the key once its lifetime spend reaches the cap (the monthly cap resets on the 1st, UTC). ` +
    `Expires ${new Date(expiresAt).toISOString()}; disabled sooner when entries close, the key is rotated or the account is merged.`;
  return { label, dailyLimitUsd: usdOf(limit), monthlyLimitUsd: usdOf(limit), allowedModels, expiresAt, notes };
}

// ------------------------------------------------------------------ the judge-key mint request

/**
 * What a judge key is minted for: one judge heat's house calls (grader/judge-call.ts), the house's own
 * spend and never an entrant's. The key allows the judge's one pinned model and nothing else, beside the id masq
 * routes that model to when it routes it (`superbot` → `superbot-router/superbot`: server/house-model.ts
 * masqAllowedModels), since masq checks a key against both.
 */
export interface JudgeKeySpec {
  /** The competition's slug. */
  slug: string;
  /**
   * The label's phase segment: the phase a server heat ranks (contracts/competition.ts PHASE_KEYS), or `local` for a
   * local heat (cli/grade-local.ts gradeJudgeLocal), whose attempts no server ledger counts.
   */
  phase: JudgeKeyPhase;
  /** The heat's nth try for the phase, from 1: a retried or re-run heat mints anew. */
  attempt: number;
  /** The judge's pinned model (judge.agent.model): an exact id, never a glob. */
  model: string;
}

/** A judge key's phase segment: a server heat's phase, or `local`. */
export type JudgeKeyPhase = 'dev' | 'final' | 'local';

const JUDGE_PHASES: ReadonlySet<string> = new Set<JudgeKeyPhase>(['dev', 'final', 'local']);

/** The judge key's label: makefun/<slug>/judge/<phase>/<attempt>. */
export function judgeKeyLabel(spec: Pick<JudgeKeySpec, 'slug' | 'phase' | 'attempt'>): string {
  if (!Slug.safeParse(spec.slug).success) throw new TypeError(`a judge key's slug is a competition slug, got ${JSON.stringify(spec.slug)}`);
  if (typeof spec.phase !== 'string' || !JUDGE_PHASES.has(spec.phase)) throw new TypeError(`a judge key's phase is dev, final or local, got ${JSON.stringify(spec.phase)}`);
  if (!Number.isSafeInteger(spec.attempt) || spec.attempt < 1) throw new RangeError(`a judge heat's attempt is a whole number from 1, got ${spec.attempt}`);
  const label = `${MASQ_KEY_LABEL_PREFIX}/${spec.slug}/${MASQ_JUDGE_KEY_SEGMENT}/${spec.phase}/${spec.attempt}`;
  if (label.length > MASQ_MAX_LABEL) throw new RangeError(`the judge key's label is ${label.length} characters; masq takes at most ${MASQ_MAX_LABEL}`);
  return label;
}

/** The judge key's expiry (ms) for a heat starting at `now`: now + 24 h − MASQ_KEY_GRACE_MS, under 24 h so a daily cap is its lifetime cap. */
export function judgeKeyExpiresAt(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError(`now is milliseconds since the epoch, got ${now}`);
  return now + MASQ_KEY_MAX_LIFETIME_MS - MASQ_KEY_GRACE_MS;
}

/**
 * POST /admin/keys's body for the judge key `spec` describes, minted at `now` (ms): no judge key has a dollar cap, so
 * the body carries no dailyLimitUsd. Throws on a spec no key can be minted for.
 */
export function judgeKeyRequest(spec: JudgeKeySpec, now: number): MintBody {
  const label = judgeKeyLabel(spec);
  const expiresAt = judgeKeyExpiresAt(now);
  if (!ModelId.safeParse(spec.model).success) {
    throw new TypeError(`a judge key allows the judge's one pinned model, an exact id (contracts/competition.ts ModelId), got ${JSON.stringify(spec.model)}`);
  }
  const heat = spec.phase === 'local' ? 'a local heat (makefun grade-local --judge)' : `${spec.phase} phase`;
  const notes =
    `makefun judge key: competition ${spec.slug}, ${heat}, judge heat ${spec.attempt}: the house's own calls to the judge model ${spec.model}, never an entrant's. ` +
    "No dollar cap: the heat's request ledger, its max_output_tokens and the one pinned model bound it; it expires within 24 h. Disabled when the heat ends.";
  const allowedModels = masqAllowedModels(spec.model);
  return { label, allowedModels, expiresAt, notes };
}

// ------------------------------------------------------------------ the witness-key mint request

/**
 * What a witness key is minted for: one trial of the house patch agent (agent/patch-agent) on a patch pack's dev
 * tree, the pack's witness (scripts/patch/witness.ts). It is the house's own spend and never an entrant's, so its
 * label has no run: makefun/<slug>/witness/<n>/<attempt>. The key allows the trial's one model, lives 2 × the
 * trial's wall budget + 1 h as a trial key does, and caps at the trial's cap × 1.05.
 */
export interface WitnessKeySpec {
  /** The pack's competition slug. */
  slug: string;
  /** The trial's number in the witness, from 1 (contracts/patch.ts PatchWitnessTrial.n). */
  n: number;
  /** The trial's nth key, from 1. */
  attempt: number;
  /** The trial's cap, USD above 0 with at most two decimals (the witness's --max-trial-usd). */
  capUsd: number;
  /** The model the agent calls: an exact id, never a glob. */
  model: string;
  /** The trial's wall budget, whole seconds (the agent's maxWallSec). */
  wallBudgetSec: number;
}

/** The witness key's label: makefun/<slug>/witness/<n>/<attempt>. Throws on a spec no label can be made for. */
export function witnessKeyLabel(spec: Pick<WitnessKeySpec, 'slug' | 'n' | 'attempt'>): string {
  if (!Slug.safeParse(spec.slug).success) throw new TypeError(`a witness key's slug is a competition slug, got ${JSON.stringify(spec.slug)}`);
  if (!Number.isSafeInteger(spec.n) || spec.n < 1) throw new RangeError(`a witness trial's number is a whole number from 1, got ${spec.n}`);
  if (!Number.isSafeInteger(spec.attempt) || spec.attempt < 1) throw new RangeError(`a witness trial's attempt is a whole number from 1, got ${spec.attempt}`);
  const label = `${MASQ_KEY_LABEL_PREFIX}/${spec.slug}/${MASQ_WITNESS_KEY_SEGMENT}/${spec.n}/${spec.attempt}`;
  if (label.length > MASQ_MAX_LABEL) throw new RangeError(`the witness key's label is ${label.length} characters; masq takes at most ${MASQ_MAX_LABEL}`);
  return label;
}

/** POST /admin/keys's body for the witness key `spec` describes, minted at `now` (ms). Throws on a spec no key can be minted for. */
export function witnessKeyRequest(spec: WitnessKeySpec, now: number): CappedMintBody {
  const label = witnessKeyLabel(spec);
  const cents = centsOf(spec.capUsd);
  if (cents === null) throw new RangeError(`a witness trial's cap is USD above 0 with at most two decimals, got ${spec.capUsd}`);
  const daily = (cents * MICRO_PER_CENT * MASQ_DAILY_LIMIT_PERCENT) / 100n;
  const expiresAt = trialKeyExpiresAt(spec.wallBudgetSec, now);
  if (!ModelId.safeParse(spec.model).success) {
    throw new TypeError(`a witness key allows the trial's one model, an exact id (contracts/competition.ts ModelId), got ${JSON.stringify(spec.model)}`);
  }
  const notes =
    `makefun witness key: competition ${spec.slug}, witness trial ${spec.n}, attempt ${spec.attempt}: the house patch agent's own calls to ${spec.model} on the pack's dev tree, never an entrant's. ` +
    `Daily cap ${usdOf(daily)} USD, the trial's cap ${spec.capUsd} USD × 1.05; it expires 2 × the trial's ${spec.wallBudgetSec} s wall budget + 1 h after the mint, ` +
    `under 24 h, so the daily cap is its lifetime cap. Disabled when the trial ends.`;
  return { label, dailyLimitUsd: usdOf(daily), allowedModels: [spec.model], expiresAt, notes };
}

/**
 * masq's `window` (`<n>m`) reaching from `nowMs` back past `sinceMs` (a key's creation, say), with
 * MASQ_WINDOW_MARGIN_MS to spare for the two clocks: what GET /admin/requests takes to cover a key's
 * whole life.
 */
export function masqWindowSince(sinceMs: number, nowMs: number): string {
  if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) throw new RangeError(`since is milliseconds since the epoch, got ${sinceMs}`);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError(`now is milliseconds since the epoch, got ${nowMs}`);
  return `${Math.ceil((Math.max(0, nowMs - sinceMs) + MASQ_WINDOW_MARGIN_MS) / 60_000)}m`;
}

/**
 * A row's list cost (USD, as masq answers it) in exact µUSD: masq records each request's list cost to
 * 6 decimals, so the double it answers is the nearest to a whole number of µUSD. Null when it is not
 * (more decimals, negative, not finite, or past 2^53 µUSD).
 */
export function exactMicroUsd(usd: number): bigint | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  const micro = Math.round(usd * MICRO_PER_USD);
  if (!Number.isSafeInteger(micro) || micro / MICRO_PER_USD !== usd) return null;
  return BigInt(micro);
}

// ------------------------------------------------------------------ faults

/**
 * admin_key: verifyAdminKey's read of the admin key's own pin (inside a mint, its faults are the mint's); requests: a page of a key's requests;
 * key_ready: a mint, of any key, reading masq's model list as the new key (see the header).
 */
export type MasqBrokerOp = 'mint' | 'disable' | 'spend' | 'admin_key' | 'requests' | 'key_ready';

/**
 * How a broker request failed: no connection (refused, unresolved), TLS not verified, timeout (no
 * answer within the deadline), reset (the connection dropped), status (an answer other than the
 * route's 2xx, a redirect included), protocol (an answer that is not the route's shape), aborted
 * (the caller's signal).
 */
export type MasqBrokerFailure = 'connect' | 'tls' | 'timeout' | 'reset' | 'status' | 'protocol' | 'aborted';

/** A broker fault: the platform's, never the entry's. The trial is void (an infrastructure fault) and re-runs live on a fresh key. */
export class MasqBrokerError extends Error {
  readonly op: MasqBrokerOp;
  readonly kind: MasqBrokerFailure;
  /** The broker's HTTP status, for `status` (and a `protocol` fault on an answer); null otherwise. */
  readonly status: number | null;
  /** Always true: what a caller voids the trial on. */
  readonly infrastructure = true;
  /** run_trial.void_reason for the void it causes: masq_<op>_failed. */
  readonly voidReason: string;

  constructor(op: MasqBrokerOp, kind: MasqBrokerFailure, status: number | null, message: string) {
    super(message);
    this.name = 'MasqBrokerError';
    this.op = op;
    this.kind = kind;
    this.status = status;
    this.voidReason = `masq_${op}_failed`;
  }
}

/**
 * Why the admin key is refused: unpinned (masq reports no admin-source pin), too_wide (an entry admits
 * more than a /24), unreported (this masq's listing carries no adminSources: it predates the pin),
 * ambiguous (more than one active admin key shows this key's display prefix, so which is this one is
 * unknown), or source (masq itself refused the read from this host's address: the pin is set, but not
 * to an address the grader reaches masq from).
 */
export type MasqAdminKeyProblem = 'unpinned' | 'too_wide' | 'unreported' | 'ambiguous' | 'source';

/**
 * The admin key is not pinned to the grader host(s) as server/config.ts requires (or masq refuses this
 * host's address for it: problem `source`): a configuration fault for the operator, never an
 * infrastructure void. No trial key is minted (and no trial re-runs) until the key is pinned on the
 * masq box. Its message names the key by id and label (its display prefix, where masq never let the
 * listing be read), never the secret.
 */
export class MasqAdminKeyRefusal extends Error {
  readonly problem: MasqAdminKeyProblem;
  /** masq's id of the admin key, when the listing named one. */
  readonly keyId: string | null;
  /** The pin masq reported (null when none). */
  readonly adminSources: readonly string[] | null;
  /** Always false: not a broker fault, so no trial is voided to re-run on it. */
  readonly infrastructure = false;

  constructor(problem: MasqAdminKeyProblem, keyId: string | null, adminSources: readonly string[] | null, message: string) {
    super(message);
    this.name = 'MasqAdminKeyRefusal';
    this.problem = problem;
    this.keyId = keyId;
    this.adminSources = adminSources;
  }
}

/** masq's display prefix of a key (keys.ts displayPrefix for its own sk-masq- keys, foreignPrefix for an imported one). */
export function masqKeyPrefix(key: string): string {
  const k = key.trim();
  if (k.startsWith('sk-masq-')) {
    const body = k.slice('sk-masq-'.length);
    return `sk-masq-${body.slice(0, 4)}…${body.slice(-4)}`;
  }
  if (k.length <= 12) return `${k.slice(0, 4)}…`;
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

/**
 * masq's answer when its admin key's source pin does not admit the caller (src/server.ts, a 403 before
 * any /admin route runs): `this admin key is restricted to other source addresses; this request came
 * from <ip>`, <ip> the address masq read as the caller's (publicCallerIp).
 */
const SOURCE_REFUSAL_RE = /this admin key is restricted to other source addresses; this request came from (\S+)/;

/**
 * The admin-key refusal `err` really is when it is masq's own source-pin 403 for this host
 * (SOURCE_REFUSAL_RE): the pin is set, but not to an address the grader reaches masq from, so the
 * listing the pin is read from never starts. Null for every other fault, which stays the broker's own
 * (a void pass, re-run). `origin` is masq's, as the broker spells it; `adminKey` is makefun's, of which
 * only the display prefix (masqKeyPrefix) joins the message, never the key.
 */
export function masqSourceRefusal(err: unknown, origin: string, adminKey: string): MasqAdminKeyRefusal | null {
  if (!(err instanceof MasqBrokerError) || err.kind !== 'status' || err.status !== 403) return null;
  const match = SOURCE_REFUSAL_RE.exec(err.message);
  if (match === null) return null;
  const from = match[1]!;
  const prefix = masqKeyPrefix(adminKey);
  const entry = `${from}${from.includes(':') ? '/128' : '/32'}`;
  return new MasqAdminKeyRefusal(
    'source',
    null,
    null,
    `masq at ${origin} refused makefun's admin key ${prefix} from this host's address ${from}: the key's source pin does not admit this address (masq: ${oneLine(match[0]!)}). ` +
      `No trial key is minted from this address until it does: on the masq box add this host's address to the key's pin with \`masq keys admin-sources ${prefix} <existing>,${entry}\` (the display prefix names the key), keeping the entries already pinned and adding this one, each an IPv4 address or a CIDR no wider than /${MASQ_ADMIN_SOURCE_MIN_PREFIX} (server/config.ts MAKEFUN_LLM_GATEWAY_ADMIN_KEY); the next mint reads the pin again and picks it up, since a refusal is never cached`,
  );
}

/** masq's IPv4 reading (keys.ts ipInCidr's v4), kept exact: Number() per part, so '' reads as 0. */
function masqV4(s: string): number | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

/**
 * How many leading address bits an admin-source entry pins, as masq's matcher (keys.ts ipInCidr)
 * reads it: the CIDR's bits for an IPv4 net (`10.0.0.0/8` 8, `0.0.0.0/0` 0, and `1.2.3.4/` 0, since
 * masq reads an empty suffix as 0); 32 for an entry masq matches only literally (a bare address, an
 * IPv6 one included) or never (a bad suffix, a non-IPv4 net), which admits one address at most.
 */
export function adminSourcePrefixBits(entry: string): number {
  const slash = entry.indexOf('/');
  if (slash === -1) return 32;
  const bits = Number(entry.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return 32;
  if (masqV4(entry.slice(0, slash)) === null) return 32;
  return bits;
}

/** The entries of an admin-source pin that admit more than a /24 (MASQ_ADMIN_SOURCE_MIN_PREFIX). */
export function wideAdminSources(sources: readonly string[]): string[] {
  return sources.filter((s) => adminSourcePrefixBits(s) < MASQ_ADMIN_SOURCE_MIN_PREFIX);
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ETIMEDOUT', 'EAI_FAIL', 'EAI_NONAME']);
const TLS_CODE_RE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_|ERR_OSSL)/;

function transportKind(err: unknown, phase: 'request' | 'body'): MasqBrokerFailure {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
  if (TLS_CODE_RE.test(code)) return 'tls';
  if (phase === 'request' && CONNECT_CODES.has(code)) return 'connect';
  if (code.startsWith('HPE_')) return 'protocol';
  return 'reset';
}

// ------------------------------------------------------------------ the broker's answers

/** A millisecond epoch as masq answers it: a number, or a decimal string (a Postgres bigint). */
const EpochMs = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,16}$/).transform(Number)]);
/** A key id that is safe in a path segment and a log line. */
const KeyId = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const Usd = z.number().finite().nonnegative();

const MintAnswer = z.object({ id: KeyId, key: UpstreamKey, prefix: z.string(), label: z.string(), expiresAt: EpochMs });
const DisableAnswer = z.object({ id: z.string(), disabledAt: EpochMs, alreadyDisabled: z.boolean() });
const KeyAnswer = z.object({
  window: z.object({ sinceMs: z.number().finite(), untilMs: z.number().finite() }),
  key: z.object({ id: z.string(), createdAt: z.union([z.string(), z.number()]), disabled: z.boolean().optional() }).nullable(),
  hidden: z.boolean(),
  spend: z.object({ last24hUsd: Usd }).nullable(),
  profile: z.object({ totals: z.object({ requests: z.number().int().nonnegative(), listCostUsd: Usd }) }).nullable(),
});
/** The key listing; each row is read only when its prefix is the admin key's. */
const ListingAnswer = z.object({ keys: z.array(z.unknown()) });
/** A listed key with the admin key's prefix. adminSources absent: a masq that predates the pin. */
const ListedKey = z.object({
  id: KeyId,
  prefix: z.string(),
  label: z.string(),
  role: z.string(),
  state: z.string(),
  adminSources: z.array(z.string()).nullable().optional(),
});
/** GET /admin/requests's answer; each row is read by RequestRowAnswer, each in-flight entry that may be the key's by InflightAnswer. */
const RequestsAnswer = z.object({ rows: z.array(z.unknown()), inflight: z.array(z.unknown()) });
/**
 * One of masq's in-flight requests (meter.ts LiveStart), the fields read of one that may be the key's. keyId absent:
 * a start mirrored from a masq slot on an older build; null: an open request (no key), never read this far.
 */
const InflightAnswer = z.object({
  id: z.string().min(1),
  ts: z.number().int().nonnegative().max(8_640_000_000_000_000),
  keyId: z.string().nullable().optional(),
  keyPrefix: z.string(),
  keyLabel: z.string(),
});
/** A count as masq answers it: a number, or a decimal string (a ClickHouse Int64). */
const Count = z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d{1,15}$/).transform(Number)]);
const PositiveCount = Count.refine((n) => n > 0, 'above 0');
/** One row of a request page: the columns of masq's request detail (meter.ts RequestDetail) a metered build is stored and ranked on. */
const RequestRowAnswer = z.object({
  id: PositiveCount,
  ts: PositiveCount,
  keyId: z.string().nullable(),
  model: z.string(),
  modelRequested: z.string(),
  modelResolved: z.string().nullable().optional(),
  status: Count,
  inputTokens: Count,
  outputTokens: Count,
  reasoningTokens: Count.nullable().optional(),
  cacheReadTokens: Count,
  /** Read plus written (meter.ts): the cache writes are cachedTokens − cacheReadTokens. */
  cachedTokens: Count,
  listCostUsd: z.number(),
  pricingFallback: z.boolean(),
  upstreamResponseId: z.string().nullable().optional(),
  clientRequestId: z.string().nullable().optional(),
});

/** A trial key, as minted. `key` is the secret: it goes into the forwarder's config file and nowhere else. */
export interface MintedTrialKey {
  /** masq's key id: the run_trial.masq_key_id kept, never the secret. */
  id: string;
  key: string;
  /** masq's display prefix (sk-masq-…). */
  prefix: string;
  label: string;
  expiresAt: number;
  dailyLimitUsd: number;
  allowedModels: string[];
}

export interface DisabledTrialKey {
  id: string;
  /** When masq stopped the key (ms); a second disable answers the first one's stamp. */
  disabledAt: number;
  alreadyDisabled: boolean;
}

/**
 * What masq metered for a key, at list price. The broker's own read fills in every field; the
 * optional ones are optional only so that a broker which does not say (a test's fake) still fits.
 */
export interface MasqKeySpend {
  id: string;
  /** In µUSD (masq's USD figure × 10^6, rounded). */
  microUsd: bigint;
  /** masq's USD figure as it answered. */
  usd: number;
  /**
   * log: the key's request log, profile.totals.listCostUsd over the ledger's 24 h window (the key was
   * made within it); window: the request log over a window back to the key's creation (a key read 24 h
   * or more after it was made); ledger: the cap ledger, spend.last24hUsd, only where masq answered no
   * request log for the key.
   */
  source: 'log' | 'window' | 'ledger';
  /** masq's clock at the last read (ms). */
  readAt: number;
  /**
   * Whether the figure had settled: two reads MASQ_SPEND_SETTLE_GAP_MS apart agreed on it (and on the
   * request count) within MASQ_SPEND_SETTLE_CAP_MS of the first read. False: it was still moving when
   * the cap ran out, and the last read's figure is kept. Absent: the broker does not say; taken as settled.
   */
  settled?: boolean;
  /** How many reads it took (each a GET /admin/key, or two for a `window` read). */
  reads?: number;
  /** The request log's request count at the last read; null for a `ledger` figure. */
  requests?: number | null;
  /** The cap ledger at the last read, µUSD, kept beside the figure (it lags the request log); null when masq answered none or the key is older than the ledger's window. */
  ledgerMicroUsd?: bigint | null;
}

export interface BrokerCallOptions {
  signal?: AbortSignal;
}

/** A build key, as minted. `key` is the secret: shown to the entrant once, and never stored, logged or read back. */
export interface MintedBuildKey {
  /** masq's key id: what the house keeps (build_key.masq_key_id), never the secret. */
  id: string;
  key: string;
  /** masq's display prefix. */
  prefix: string;
  label: string;
  expiresAt: number;
  /** The cap the key was minted for (BuildKeySpec.capMicroUsd). */
  capMicroUsd: bigint;
  /** masq's daily and monthly cap, one figure: buildKeyLimitMicroUsd(capMicroUsd) in USD (whole cents). */
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  allowedModels: string[];
}

/** A judge key, as minted. `key` is the secret: it lives in the judge job's memory for the heat and is never stored, logged or read back. */
export interface MintedJudgeKey {
  /** masq's key id: what the heat's record keeps, never the secret. */
  id: string;
  key: string;
  /** masq's display prefix. */
  prefix: string;
  label: string;
  expiresAt: number;
  /** masq's daily cap in USD: absent, as judgeKeyRequest mints every judge key with no dollar cap. */
  dailyLimitUsd?: number;
  /** The judge's pinned model, alone, or with the id masq routes it to (server/house-model.ts masqAllowedModels). */
  allowedModels: string[];
  /**
   * masq's model list as the key read it (GET /v1/models), once masq answered the key: where the heat reads its
   * model's card. Absent from a broker that reads none (a test's fake): the heat then reads the card itself where it
   * needs one.
   */
  models?: MasqModelCard[];
}

/** A minted witness key: what mintWitnessKey hands back, a judge key's fields for one witness trial. */
export interface MintedWitnessKey {
  /** masq's key id: what the witness record keeps (PatchWitnessTrial.masq_key_id), never the secret. */
  id: string;
  key: string;
  /** masq's display prefix. */
  prefix: string;
  label: string;
  expiresAt: number;
  /** masq's daily cap, the trial's cap × 1.05 in USD. */
  dailyLimitUsd: number;
  /** The trial's one model, alone. */
  allowedModels: string[];
  /**
   * masq's model list as the key read it (GET /v1/models), once masq answered the key: where the witness
   * reads that masq serves the model. Absent from a broker that reads none (a test's fake).
   */
  models?: MasqModelCard[];
}

/** One model of masq's model list (GET /v1/models): its id, and its card's capabilities as masq spells them (read by grader/judge-call.ts). */
export interface MasqModelCard {
  id: string;
  capabilities?: unknown;
}

/** GET /v1/models's answer, as far as a key's mint reads it. */
const ModelListAnswer = z.object({
  data: z.array(z.object({ id: z.string(), capabilities: z.unknown().optional() }).loose()),
});

/** One request masq metered on a key (a row of GET /admin/requests). */
export interface MasqRequestRow {
  /** masq's request id (requests.id): unique on that masq, and the keyset cursor's beforeId. */
  id: number;
  /** When masq recorded it (ms, masq's clock): the cursor's `before`. */
  ts: number;
  keyId: string;
  /** The model the caller named. */
  modelRequested: string;
  /** The model masq sent the request to; null when nothing resolved it (sent as named). */
  modelResolved: string | null;
  /** masq's fold of the two: modelResolved, else modelRequested. */
  model: string;
  /** The HTTP status masq answered. */
  status: number;
  inputTokens: number;
  outputTokens: number;
  /** Reasoning tokens, billed inside outputTokens. */
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Its list cost, exact µUSD (exactMicroUsd of masq's 6-decimal figure). */
  listCostMicroUsd: bigint;
  /** masq priced it by a fallback (an unknown model's rate), not the model's own. */
  pricingFallback: boolean;
  /** The vendor reply's own id (an Anthropic msg_… id), when the vendor gave one. */
  upstreamResponseId: string | null;
  /** The caller's x-cosmos-req trace id, when it sent one. */
  clientRequestId: string | null;
}

/** Where the next (older) page starts: the last row's ts and id. */
export interface MasqRequestCursor {
  before: number;
  beforeId: number;
}

/** A request masq reports still in flight (GET /admin/requests's `inflight`, meter.ts LiveStart): started, its row not recorded yet. */
export interface MasqInflightRequest {
  /** masq's in-flight id (f<n>): never a request id; the row that lands for it has its own. */
  id: string;
  /** When masq started it (ms, masq's clock). */
  ts: number;
  /**
   * The id of the key it runs on, as masq named it; null for a start mirrored from a masq slot on an older build,
   * which names none: then only keyPrefix and keyLabel tell whose it is.
   */
  keyId: string | null;
  /** masq's display prefix and label of the key it runs on. */
  keyPrefix: string;
  keyLabel: string;
}

/** One page of a key's requests, newest first. */
export interface MasqRequestPage {
  keyId: string;
  rows: MasqRequestRow[];
  /** Σ rows' listCostMicroUsd, exact. */
  listCostMicroUsd: bigint;
  /** The cursor for the next page (the last row's); null when this page was not full, so the walk is done. */
  next: MasqRequestCursor | null;
  /**
   * The requests masq reports still in flight that may be the key's, read after the rows (see the header): each
   * naming the key's id, and each naming no key id (keyId null here), for the caller to match by keyPrefix and
   * keyLabel. masq's broker always answers it; it is optional only so that a broker which does not say (a test's
   * fake) still fits, and absent, none is taken to be in flight.
   */
  inflight?: MasqInflightRequest[];
}

export interface MasqRequestPageOptions extends BrokerCallOptions {
  /**
   * How far back from masq's clock the page reaches: `<n>m`, `<n>h` or `<n>d`, n from 1 (masq's own
   * vocabulary; masqWindowSince covers a key's whole life). Required: masq reads anything else as 24 h.
   */
  window: string;
  /** The keyset cursor, both or neither (a previous page's `next`): the page starts just past that row. */
  before?: number;
  beforeId?: number;
  /** Rows a page, 1 to MASQ_REQUESTS_PAGE_MAX (default MASQ_REQUESTS_PAGE_MAX). */
  limit?: number;
}

/** masq's `window` vocabulary (server.ts windowFromQuery), n from 1. */
const MASQ_WINDOW_RE = /^[1-9]\d{0,8}[mhd]$/;

/** The admin key as masq lists it, its pin read back and found narrow enough. Never the secret. */
export interface MasqAdminKey {
  /** masq's id of the admin key (what `masq keys admin-sources <id>` takes). */
  id: string;
  /** masq's display prefix of it. */
  prefix: string;
  label: string;
  /** Its pin as masq holds it: never empty, no entry wider than a /24. */
  adminSources: string[];
  /** When it was read (the broker's clock, ms). */
  checkedAt: number;
}

export interface MasqBroker {
  /** The broker's origin, as URL.origin spells it. */
  readonly origin: string;
  /**
   * Read the admin key's own pin from masq's key listing (GET /admin/keys?label_prefix=). Resolves
   * when the key is pinned to source addresses none wider than a /24; rejects with a
   * MasqAdminKeyRefusal when it is not, and a MasqBrokerError (op admin_key) when masq cannot be asked
   * (openMasqBroker reads masq's own 403 source-pin refusal as a MasqAdminKeyRefusal, problem `source`).
   */
  verifyAdminKey(opts?: BrokerCallOptions): Promise<MasqAdminKey>;
  /**
   * Mint the key for one live pass (POST /admin/keys). `now` (ms) is the pass's start, default the
   * clock. The admin key's pin is read first (verifyAdminKey, a good read held MASQ_ADMIN_KEY_RECHECK_MS);
   * a MasqAdminKeyRefusal there mints nothing. It resolves once masq answers the new key (the header:
   * GET /v1/models as the key, a 401 waited out for at most MASQ_KEY_WARMUP_MS), so the pass's first
   * call, the entry lane's or the house lane's, is never a fresh key's 401; a key masq does not answer
   * is disabled, and the mint fails as key_ready.
   */
  mint(spec: TrialKeySpec, opts?: BrokerCallOptions & { now?: number }): Promise<MintedTrialKey>;
  /** Disable a key (POST /admin/keys/:id/disable); idempotent. */
  disable(id: string, opts?: BrokerCallOptions): Promise<DisabledTrialKey>;
  /**
   * Read a retired key's spend once masq has settled it (GET /admin/key?id=, see the header): read at
   * once, then again MASQ_SPEND_SETTLE_GAP_MS after each read until two reads agree, at most
   * MASQ_SPEND_SETTLE_CAP_MS from the first; a figure still moving then is answered with settled false.
   */
  spend(id: string, opts?: BrokerCallOptions): Promise<MasqKeySpend>;
}

/**
 * The broker's build-key half (a bounty with a build allowance, server/metering): mint an entrant's
 * build key, disable it, and page its requests. An interface of its own, beside MasqBroker, so a
 * trial-only fake stays a MasqBroker; masqBroker's broker is every half (MasqAdminBroker).
 */
export interface MasqBuildKeyBroker {
  /** The broker's origin, as URL.origin spells it. */
  readonly origin: string;
  /**
   * Mint an entrant's build key (POST /admin/keys, buildKeyRequest). `now` (ms) is the mint's instant
   * for the expiry's bounds, default the clock. The admin key's pin is read first, as for a trial key
   * (verifyAdminKey); a MasqAdminKeyRefusal there mints nothing. As a trial key's mint does, it
   * resolves once masq answers the new key, and a key masq does not answer is disabled (key_ready).
   */
  mintBuildKey(spec: BuildKeySpec, opts?: BrokerCallOptions & { now?: number }): Promise<MintedBuildKey>;
  /** Disable a key (POST /admin/keys/:id/disable); idempotent. */
  disable(id: string, opts?: BrokerCallOptions): Promise<DisabledTrialKey>;
  /**
   * One page of the key's requests, newest first (GET /admin/requests?kind=key&value=<id>): at most
   * `limit` rows within `window`, from just past the cursor when one is given. Walk on with `next`
   * until it is null. Every row is the key's own, in order, priced in exact µUSD, or the page is a
   * `protocol` fault. Beside the rows, the requests masq reports still in flight that may be the key's
   * (MasqRequestPage.inflight): what a settle waits on.
   */
  requests(id: string, opts: MasqRequestPageOptions): Promise<MasqRequestPage>;
}

/**
 * The broker's judge-key half (grader/judge-call.ts): mint a judge heat's key, then retire it as a
 * trial key is retired (retireTrialKey: disable, then the settled spend against the heat's own meter).
 * An interface of its own, so a judge-only fake needs nothing else.
 */
export interface MasqJudgeKeyBroker {
  /** The broker's origin, as URL.origin spells it: where the judge's calls go. */
  readonly origin: string;
  /**
   * Mint a judge heat's key (POST /admin/keys, judgeKeyRequest). `now` (ms) is the heat's start,
   * default the clock. The admin key's pin is read first, as for a trial key (verifyAdminKey); a
   * MasqAdminKeyRefusal there mints nothing. It resolves once masq answers the new key (the header:
   * GET /v1/models as the key, a 401 waited out for at most MASQ_KEY_WARMUP_MS), with that list as
   * `models`; a key masq does not answer is disabled, and the mint fails as key_ready.
   */
  mintJudgeKey(spec: JudgeKeySpec, opts?: BrokerCallOptions & { now?: number }): Promise<MintedJudgeKey>;
  /** Disable a key (POST /admin/keys/:id/disable); idempotent. */
  disable(id: string, opts?: BrokerCallOptions): Promise<DisabledTrialKey>;
  /** A retired key's settled spend (MasqBroker.spend). */
  spend(id: string, opts?: BrokerCallOptions): Promise<MasqKeySpend>;
}

/**
 * The broker's witness-key half (scripts/patch/witness.ts): mint a witness trial's key, then retire it
 * as a trial key is retired (retireTrialKey: disable, then the settled spend against the trial's own
 * meter). An interface of its own, so a witness-only fake needs nothing else.
 */
export interface MasqWitnessKeyBroker {
  /** The broker's origin, as URL.origin spells it: where the agent's calls go. */
  readonly origin: string;
  /**
   * Mint a witness trial's key (POST /admin/keys, witnessKeyRequest). `now` (ms) is the trial's start,
   * default the clock. The admin key's pin is read first, as for a trial key (verifyAdminKey); a
   * MasqAdminKeyRefusal there mints nothing. It resolves once masq answers the new key (GET /v1/models
   * as the key, a 401 waited out for at most MASQ_KEY_WARMUP_MS), with that list as `models`; a key
   * masq does not answer is disabled, and the mint fails as key_ready.
   */
  mintWitnessKey(spec: WitnessKeySpec, opts?: BrokerCallOptions & { now?: number }): Promise<MintedWitnessKey>;
  /** Disable a key (POST /admin/keys/:id/disable); idempotent. */
  disable(id: string, opts?: BrokerCallOptions): Promise<DisabledTrialKey>;
  /** A retired key's settled spend (MasqBroker.spend). */
  spend(id: string, opts?: BrokerCallOptions): Promise<MasqKeySpend>;
}

/** masqBroker's broker: the trial half, the build-key half, the judge-key half and the witness-key half. */
export type MasqAdminBroker = MasqBroker & MasqBuildKeyBroker & MasqJudgeKeyBroker & MasqWitnessKeyBroker;

export interface MasqBrokerOptions {
  /** masq's origin (parseOrigin: http(s), host, port, nothing else). */
  origin: string;
  /** The masq admin key: presented as x-api-key on every broker request but a fresh key's own read (key_ready), never anywhere else. */
  adminKey: string;
  timeoutMs?: number;
  /** Certificates to trust instead of Node's bundled CAs (tests). Verification is never off. */
  ca?: string | Buffer;
  /** The clock (ms), default Date.now. */
  now?: () => number;
  /**
   * The wait between a spend's reads (default a timer; a test hands in one that moves its `now`). It
   * rejects, or returns early, when `signal` aborts: the read then fails as `aborted`.
   */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/** A broker's text in a message: one line, at most 300 characters. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/** The message a broker's error answer carries: masq's {error: {message}} or {error: "..."}, else the body's start. */
function errorMessageOf(doc: unknown, text: string): string {
  const err = (doc as { error?: unknown } | null)?.error;
  if (typeof err === 'string') return oneLine(err);
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message === 'string') return oneLine(message);
  return text === '' ? 'an empty body' : oneLine(text);
}

/** The key's creation time (ms) as masq's key view spells it (an ISO date or an epoch); null when unreadable. */
function createdAtMs(v: string | number): number | null {
  const t = typeof v === 'number' ? v : /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function microUsdOf(usd: number): bigint {
  return BigInt(Math.round(usd * MICRO_PER_USD));
}

/** The most reads one spend read makes: one at once, then one per gap within the cap. */
const MAX_SETTLE_READS = Math.floor(MASQ_SPEND_SETTLE_CAP_MS / MASQ_SPEND_SETTLE_GAP_MS) + 1;

/** One read of a key's spend: its figure (the request log, or the cap ledger where masq answers no log), and the ledger beside it. */
interface SpendRead {
  source: MasqKeySpend['source'];
  usd: number;
  requests: number | null;
  ledgerUsd: number | null;
  readAt: number;
}

/** The broker at `opts.origin` on the admin key (see the header). */
export function masqBroker(opts: MasqBrokerOptions): MasqAdminBroker {
  const url = parseOrigin(opts.origin);
  const adminKey = UpstreamKey.parse(opts.adminKey);
  const timeoutMs = opts.timeoutMs ?? MASQ_BROKER_TIMEOUT_MS;
  const clock = opts.now ?? Date.now;
  const pause = opts.sleep ?? ((ms: number, signal: AbortSignal | undefined): Promise<void> => delay(ms, undefined, signal === undefined ? {} : { signal }));
  const tls = url.protocol === 'https:';
  /** Every secret this broker holds or has handed out: scrubbed from each message. */
  const secrets = new Set<string>([adminKey]);
  const scrub = (text: string): string => {
    let out = text;
    for (const s of secrets) out = out.split(s).join('[redacted]');
    return out;
  };
  const fault = (op: MasqBrokerOp, kind: MasqBrokerFailure, status: number | null, message: string): MasqBrokerError => new MasqBrokerError(op, kind, status, scrub(message));

  /**
   * One request: the status and the JSON answer (null when the body is not JSON), or a MasqBrokerError. It presents the
   * admin key, or `bearer` alone (a key this broker minted, reading as that key: key_ready).
   */
  const call = (
    op: MasqBrokerOp,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    maxBytes: number = MAX_BROKER_RESPONSE_BYTES,
    bearer?: string,
  ): Promise<{ status: number; doc: unknown; text: string }> => {
    const what = `${method} ${path.replace(/\?.*$/, '')}`;
    if (signal?.aborted) return Promise.reject(fault(op, 'aborted', null, `masq ${what}: aborted before it was sent`));
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers: OutgoingHttpHeaders = {
      ...(bearer === undefined ? { 'x-api-key': adminKey } : { authorization: `Bearer ${bearer}` }),
      accept: 'application/json',
      'accept-encoding': 'identity',
      'user-agent': GATEWAY_USER_AGENT,
      ...(method === 'POST' ? { 'content-length': String(bytes.byteLength) } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      let r: ClientRequest | null = null;
      let res: IncomingMessage | null = null;
      const done = (): void => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (err: MasqBrokerError): void => {
        if (settled) return;
        done();
        res?.destroy();
        r?.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(fault(op, 'timeout', null, `masq ${what}: no answer within ${timeoutMs} ms`)), timeoutMs);
      const onAbort = (): void => fail(fault(op, 'aborted', null, `masq ${what}: aborted`));
      signal?.addEventListener('abort', onAbort, { once: true });
      r = (tls ? httpsRequest : httpRequest)({
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port === '' ? (tls ? 443 : 80) : Number(url.port),
        method,
        path,
        headers,
        agent: false,
        maxHeaderSize: MAX_UPSTREAM_HEADER_BYTES,
        ...(tls ? { rejectUnauthorized: true, ...(opts.ca !== undefined ? { ca: opts.ca } : {}) } : {}),
      });
      r.on('error', (err: Error) => {
        const kind = transportKind(err, res === null ? 'request' : 'body');
        fail(fault(op, kind, res?.statusCode ?? null, `masq ${what}: ${kind === 'connect' ? 'no connection' : kind === 'tls' ? 'TLS not verified' : 'the connection failed'} (${(err as NodeJS.ErrnoException).code ?? err.message})`));
      });
      r.on('response', (answer: IncomingMessage) => {
        res = answer;
        const status = answer.statusCode ?? 0;
        const encoding = (answer.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        if (encoding !== '' && encoding !== 'identity') {
          fail(fault(op, 'protocol', status, `masq ${what}: answered ${status} encoded as ${JSON.stringify(encoding)}, not identity`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let ended = false;
        answer.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxBytes) {
            fail(fault(op, 'protocol', status, `masq ${what}: answered more than ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        answer.on('error', (err: Error) => fail(fault(op, transportKind(err, 'body'), status, `masq ${what}: the answer was cut off (${(err as NodeJS.ErrnoException).code ?? err.message})`)));
        answer.on('close', () => {
          if (!ended) fail(fault(op, 'reset', status, `masq ${what}: the connection dropped mid-answer`));
        });
        answer.on('end', () => {
          ended = true;
          if (settled) return;
          done();
          const text = Buffer.concat(chunks).toString('utf8');
          let doc: unknown = null;
          try {
            doc = text === '' ? null : JSON.parse(text);
          } catch {
            doc = null;
          }
          resolve({ status, doc, text });
        });
      });
      r.end(bytes.byteLength > 0 ? bytes : undefined);
    });
  };

  /** The answer of a route whose success is `ok`: any other status is a `status` fault naming the broker's own message. */
  const expect = async (
    op: MasqBrokerOp,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    ok: number,
    signal: AbortSignal | undefined,
    maxBytes?: number,
  ): Promise<unknown> => {
    const { status, doc, text } = await call(op, method, path, body, signal, maxBytes);
    if (status !== ok) {
      throw fault(op, 'status', status, `masq ${method} ${path.replace(/\?.*$/, '')} answered ${status}: ${errorMessageOf(doc, text)}`);
    }
    if (doc === null) throw fault(op, 'protocol', status, `masq ${method} ${path.replace(/\?.*$/, '')} answered ${status} with no JSON body`);
    return doc;
  };

  const disable = async (id: string, callOpts: BrokerCallOptions = {}): Promise<DisabledTrialKey> => {
    if (!KeyId.safeParse(id).success) throw new TypeError(`a masq key id is letters, digits and . _ -, got ${JSON.stringify(id)}`);
    const doc = await expect('disable', 'POST', `/admin/keys/${encodeURIComponent(id)}/disable`, undefined, 200, callOpts.signal);
    const parsed = DisableAnswer.safeParse(doc);
    if (!parsed.success || parsed.data.id !== id) throw fault('disable', 'protocol', 200, `masq's disable answer for key ${id} is not {id, disabledAt, alreadyDisabled} for that key`);
    return { id, disabledAt: parsed.data.disabledAt, alreadyDisabled: parsed.data.alreadyDisabled };
  };

  const readKey = async (id: string, window: string, signal: AbortSignal | undefined): Promise<z.infer<typeof KeyAnswer>> => {
    const doc = await expect('spend', 'GET', `/admin/key?id=${encodeURIComponent(id)}&window=${window}`, undefined, 200, signal);
    const parsed = KeyAnswer.safeParse(doc);
    if (!parsed.success) throw fault('spend', 'protocol', 200, `masq's answer for key ${id} is not a key profile ({window, key, hidden, spend, profile})`);
    const a = parsed.data;
    if (a.hidden) throw fault('spend', 'protocol', 200, `masq hides key ${id}'s spend from this admin key (an incognito key): its spend cannot be read`);
    if (a.key === null || a.key.id !== id) throw fault('spend', 'protocol', 200, `masq no longer holds key ${id} (deleted): its spend cannot be read whole`);
    return a;
  };

  /** One read of a key's spend (see the header): its request log over its whole life, the cap ledger beside it. */
  const readSpend = async (id: string, signal: AbortSignal | undefined): Promise<SpendRead> => {
    const first = await readKey(id, `${MASQ_SPEND_LEDGER_MS / 60_000}m`, signal);
    const created = createdAtMs(first.key!.createdAt);
    if (created === null) throw fault('spend', 'protocol', 200, `masq's key ${id} has no readable createdAt`);
    const readAt = first.window.untilMs;
    // The cap ledger covers the key's whole life while the key is younger than its window.
    const ledgerUsd = first.spend !== null && created >= readAt - MASQ_SPEND_LEDGER_MS ? first.spend.last24hUsd : null;
    if (created >= first.window.sinceMs) {
      // The read's window reaches back to the key's making: its request log is the key's whole log.
      if (first.profile !== null) return { source: 'log', usd: first.profile.totals.listCostUsd, requests: first.profile.totals.requests, ledgerUsd, readAt };
      if (ledgerUsd !== null) return { source: 'ledger', usd: ledgerUsd, requests: null, ledgerUsd, readAt };
    }
    // Read later than that: the request log since the key was made (a minute either side).
    const minutes = Math.ceil((readAt - created) / 60_000) + 1;
    const late = await readKey(id, `${minutes}m`, signal);
    if (late.profile === null) throw fault('spend', 'protocol', 200, `masq answered no profile for key ${id}`);
    if (late.window.sinceMs > created) throw fault('spend', 'protocol', 200, `masq's window for key ${id} starts after the key was made`);
    return { source: 'window', usd: late.profile.totals.listCostUsd, requests: late.profile.totals.requests, ledgerUsd: null, readAt: late.window.untilMs };
  };

  /** The wait before a spend's next read; the caller's abort ends it as an `aborted` fault. */
  const settleWait = async (id: string, signal: AbortSignal | undefined): Promise<void> => {
    const aborted = (): MasqBrokerError => fault('spend', 'aborted', null, `masq GET /admin/key: aborted while key ${id}'s spend settled`);
    if (signal?.aborted) throw aborted();
    try {
      await pause(MASQ_SPEND_SETTLE_GAP_MS, signal);
    } catch (err) {
      if (signal?.aborted) throw aborted();
      throw err;
    }
    if (signal?.aborted) throw aborted();
  };

  /**
   * Wait until masq answers a fresh key (see the header): its model list read as the key, again after each 401 (a wait
   * of MASQ_KEY_WARMUP_GAP_MS, doubling), until masq answers 200 or MASQ_KEY_WARMUP_MS has passed (by the clock, and by
   * the waits summed should the clock stand still). Any other answer fails at once. Its answer is the list.
   */
  const awaitKey = async (key: string, signal: AbortSignal | undefined): Promise<MasqModelCard[]> => {
    const start = clock();
    let waited = 0;
    let gap = MASQ_KEY_WARMUP_GAP_MS;
    for (;;) {
      const { status, doc, text } = await call('key_ready', 'GET', MASQ_MODELS_PATH, undefined, signal, MAX_BROKER_RESPONSE_BYTES, key);
      if (status === 200) {
        const parsed = ModelListAnswer.safeParse(doc);
        if (!parsed.success) throw fault('key_ready', 'protocol', 200, `masq GET ${MASQ_MODELS_PATH} answered the new key with no model list ({data: [{id}]})`);
        return parsed.data.data;
      }
      const spent = Math.max(clock() - start, waited);
      if (status !== 401 || spent >= MASQ_KEY_WARMUP_MS) {
        const still = status === 401 ? ` ${Math.round(spent / 1000)} s after the mint` : '';
        throw fault('key_ready', 'status', status, `masq GET ${MASQ_MODELS_PATH} answered the new key ${status}${still}: ${errorMessageOf(doc, text)}`);
      }
      const wait = Math.min(gap, MASQ_KEY_WARMUP_MS - spent);
      try {
        await pause(wait, signal);
      } catch (err) {
        if (signal?.aborted) throw fault('key_ready', 'aborted', null, `masq GET ${MASQ_MODELS_PATH}: aborted while masq did not yet answer the new key`);
        throw err;
      }
      if (signal?.aborted) throw fault('key_ready', 'aborted', null, `masq GET ${MASQ_MODELS_PATH}: aborted while masq did not yet answer the new key`);
      waited += wait;
      gap *= 2;
    }
  };

  const adminPrefix = masqKeyPrefix(adminKey);
  /** The last good read of the admin key's pin; a refusal or a fault is never kept. */
  let verified: MasqAdminKey | null = null;

  /** Read the admin key's pin (see the header); faults are `op`'s, the mint's when a mint asks. */
  const readAdminKey = async (op: MasqBrokerOp, signal: AbortSignal | undefined): Promise<MasqAdminKey> => {
    const doc = await expect(op, 'GET', '/admin/keys?label_prefix=', undefined, 200, signal, MAX_BROKER_LISTING_BYTES);
    const listing = ListingAnswer.safeParse(doc);
    if (!listing.success) throw fault(op, 'protocol', 200, "masq's key listing is not {keys: [...]}");
    const mine: z.infer<typeof ListedKey>[] = [];
    for (const row of listing.data.keys) {
      if ((row as { prefix?: unknown } | null)?.prefix !== adminPrefix) continue;
      const parsed = ListedKey.safeParse(row);
      if (!parsed.success) throw fault(op, 'protocol', 200, `masq's key listing has a row with this admin key's prefix ${adminPrefix} that is not {id, prefix, label, role, state}`);
      if (parsed.data.role === 'admin' && parsed.data.state === 'active') mine.push(parsed.data);
    }
    const pinHow = `pin it to the grader host(s) on the masq box with \`masq keys admin-sources <id> <grader-ip>[,<grader-ip>…]\`, each an IPv4 address or a CIDR no wider than /${MASQ_ADMIN_SOURCE_MIN_PREFIX} (server/config.ts MAKEFUN_LLM_GATEWAY_ADMIN_KEY); no trial key is minted on it until then`;
    if (mine.length === 0) {
      throw fault(op, 'protocol', 200, `masq's key listing has no active admin key with this admin key's prefix ${adminPrefix}: its source pin cannot be read`);
    }
    if (mine.length > 1) {
      throw new MasqAdminKeyRefusal(
        'ambiguous',
        null,
        null,
        scrub(`masq lists ${mine.length} active admin keys with this admin key's prefix ${adminPrefix} (${mine.map((k) => k.id).join(', ')}), so which one is this key, and whether it is pinned to source addresses, cannot be told: give makefun an admin key of its own and ${pinHow}`),
      );
    }
    const me = mine[0]!;
    const who = `masq admin key ${me.id} (${oneLine(me.label) || 'no label'})`;
    if (me.adminSources === undefined) {
      throw new MasqAdminKeyRefusal(
        'unreported',
        me.id,
        null,
        scrub(`masq at ${url.origin} does not report its admin keys' source pins (its key listing has no adminSources): it predates \`masq keys admin-sources\`, so whether ${who} can mint from anywhere cannot be told. Upgrade masq, then ${pinHow}`),
      );
    }
    const sources = me.adminSources ?? [];
    if (sources.length === 0) {
      throw new MasqAdminKeyRefusal(
        'unpinned',
        me.id,
        null,
        scrub(`${who} is not pinned to source addresses, so whoever holds it can mint keys with any budget from anywhere: ${pinHow.replace('<id>', me.id)}`),
      );
    }
    const wide = wideAdminSources(sources);
    if (wide.length > 0) {
      throw new MasqAdminKeyRefusal(
        'too_wide',
        me.id,
        sources,
        scrub(`${who} is pinned to ${oneLine(sources.join(', '))}, and ${oneLine(wide.join(', '))} admits more than a /${MASQ_ADMIN_SOURCE_MIN_PREFIX}: ${pinHow.replace('<id>', me.id)}`),
      );
    }
    return { id: me.id, prefix: me.prefix, label: me.label, adminSources: sources, checkedAt: clock() };
  };

  const verifyAdminKey = async (op: MasqBrokerOp, signal: AbortSignal | undefined): Promise<MasqAdminKey> => {
    verified = null;
    try {
      const read = await readAdminKey(op, signal);
      verified = read;
      return read;
    } catch (err) {
      // A concurrent read that came back good is dropped too: the latest word on the pin wins.
      verified = null;
      throw err;
    }
  };

  /**
   * Mint the key `body` asks for (POST /admin/keys), the admin key's pin read first unless a good read
   * is fresh. The secret joins the scrubbed set as soon as masq answers one; an answer that is not the
   * key asked for disables whatever masq minted and is a `protocol` fault. Every key, whatever it is
   * for, resolves only once masq answers it (awaitKey, see the header), with the model list it read;
   * a key masq never answered is disabled and its fault is the `key_ready` one.
   */
  const mintKey = async (body: MintBody, callOpts: BrokerCallOptions): Promise<z.infer<typeof MintAnswer> & { models: MasqModelCard[] }> => {
    const held = verified;
    if (held === null || clock() - held.checkedAt >= MASQ_ADMIN_KEY_RECHECK_MS || clock() < held.checkedAt) {
      await verifyAdminKey('mint', callOpts.signal);
    }
    const doc = await expect('mint', 'POST', '/admin/keys', body, 201, callOpts.signal);
    const parsed = MintAnswer.safeParse(doc);
    if (parsed.success) secrets.add(parsed.data.key);
    else {
      const key = (doc as { key?: unknown }).key;
      if (typeof key === 'string' && key !== '') secrets.add(key);
    }
    if (!parsed.success || parsed.data.label !== body.label || parsed.data.expiresAt !== body.expiresAt) {
      // masq may have minted a key all the same: stop it rather than leave it live until it expires.
      const id = (doc as { id?: unknown }).id;
      if (typeof id === 'string' && KeyId.safeParse(id).success) await disable(id, callOpts).catch(() => undefined);
      throw fault('mint', 'protocol', 201, `masq's mint answer is not {id, key, prefix, label, expiresAt} for the key asked for (${body.label}, expiring ${body.expiresAt})`);
    }
    try {
      return { ...parsed.data, models: await awaitKey(parsed.data.key, callOpts.signal) };
    } catch (err) {
      // A key masq never answered spent nothing: stop it rather than leave it live until it expires. Not on
      // the caller's signal, which may be the abort that ended the wait.
      await disable(parsed.data.id).catch(() => undefined);
      throw err;
    }
  };

  /** One page of a key's requests (see MasqBuildKeyBroker.requests and the header). */
  const requests = async (id: string, callOpts: MasqRequestPageOptions): Promise<MasqRequestPage> => {
    if (!KeyId.safeParse(id).success) throw new TypeError(`a masq key id is letters, digits and . _ -, got ${JSON.stringify(id)}`);
    const o: Partial<MasqRequestPageOptions> = callOpts ?? {};
    if (typeof o.window !== 'string' || !MASQ_WINDOW_RE.test(o.window)) {
      throw new RangeError(`a request page's window is <n>m, <n>h or <n>d with n from 1 (masqWindowSince covers a key's life), got ${JSON.stringify(o.window)}`);
    }
    const limit = o.limit ?? MASQ_REQUESTS_PAGE_MAX;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MASQ_REQUESTS_PAGE_MAX) throw new RangeError(`a request page holds 1 to ${MASQ_REQUESTS_PAGE_MAX} rows, got ${String(limit)}`);
    if ((o.before === undefined) !== (o.beforeId === undefined)) {
      throw new TypeError("a request page's cursor is before and beforeId together (the previous page's next), or neither: masq reads half a cursor as none and answers the newest page again");
    }
    let cursor: MasqRequestCursor | null = null;
    if (o.before !== undefined && o.beforeId !== undefined) {
      if (!Number.isSafeInteger(o.before) || o.before < 1 || !Number.isSafeInteger(o.beforeId) || o.beforeId < 1) {
        throw new RangeError(`a request page's cursor is a row's ts and id, each a whole number from 1, got ${String(o.before)} and ${String(o.beforeId)}`);
      }
      cursor = { before: o.before, beforeId: o.beforeId };
    }
    const query = new URLSearchParams({ kind: 'key', value: id, window: o.window, limit: String(limit) });
    if (cursor !== null) {
      query.set('before', String(cursor.before));
      query.set('beforeId', String(cursor.beforeId));
    }
    const doc = await expect('requests', 'GET', `/admin/requests?${query.toString()}`, undefined, 200, o.signal, MAX_BROKER_PAGE_BYTES);
    const page = `masq's request page for key ${id}`;
    const answer = RequestsAnswer.safeParse(doc);
    if (!answer.success) throw fault('requests', 'protocol', 200, `${page} is not {rows: [...], inflight: [...]}`);
    if (answer.data.rows.length > limit) throw fault('requests', 'protocol', 200, `${page} holds ${answer.data.rows.length} rows, past the ${limit} asked for`);
    const rows: MasqRequestRow[] = [];
    let sum = 0n;
    let above: { ts: number; id: number } | null = cursor === null ? null : { ts: cursor.before, id: cursor.beforeId };
    for (const [i, raw] of answer.data.rows.entries()) {
      const parsed = RequestRowAnswer.safeParse(raw);
      if (!parsed.success) {
        throw fault('requests', 'protocol', 200, `${page}: row ${i} is not a request row ({id, ts, keyId, model, modelRequested, status, the token counts, listCostUsd, pricingFallback})`);
      }
      const r = parsed.data;
      if (r.keyId !== id) throw fault('requests', 'protocol', 200, `${page}: row ${i} (request ${r.id}) is ${r.keyId === null ? 'keyless' : `key ${oneLine(r.keyId)}'s`}, not this key's: masq did not filter by key`);
      if (above !== null && !(r.ts < above.ts || (r.ts === above.ts && r.id < above.id))) {
        const what = i === 0 ? 'the cursor' : 'the row above it';
        throw fault('requests', 'protocol', 200, `${page}: row ${i} (request ${r.id} at ${r.ts}) is not past ${what} (request ${above.id} at ${above.ts}): masq walks newest first${i === 0 ? ', resuming past the cursor' : ''}`);
      }
      const cost = exactMicroUsd(r.listCostUsd);
      if (cost === null) throw fault('requests', 'protocol', 200, `${page}: request ${r.id}'s list cost ${r.listCostUsd} USD is not whole µUSD (masq records it to 6 decimals)`);
      if (r.cachedTokens < r.cacheReadTokens) {
        throw fault('requests', 'protocol', 200, `${page}: request ${r.id}'s cached tokens (${r.cachedTokens}, reads and writes) are fewer than its cache reads (${r.cacheReadTokens})`);
      }
      rows.push({
        id: r.id,
        ts: r.ts,
        keyId: id,
        modelRequested: r.modelRequested,
        modelResolved: r.modelResolved ?? null,
        model: r.model,
        status: r.status,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        reasoningTokens: r.reasoningTokens ?? 0,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cachedTokens - r.cacheReadTokens,
        listCostMicroUsd: cost,
        pricingFallback: r.pricingFallback,
        upstreamResponseId: r.upstreamResponseId ?? null,
        clientRequestId: r.clientRequestId ?? null,
      });
      sum += cost;
      above = { ts: r.ts, id: r.id };
    }
    // masq lists every key's in-flight requests: keep the ones that may be this key's (see the header).
    const inflight: MasqInflightRequest[] = [];
    for (const [i, raw] of answer.data.inflight.entries()) {
      const named = raw !== null && typeof raw === 'object' ? (raw as { keyId?: unknown }).keyId : undefined;
      if (named === null || (typeof named === 'string' && named !== id)) continue;
      const parsed = InflightAnswer.safeParse(raw);
      if (!parsed.success) {
        throw fault('requests', 'protocol', 200, `${page}: in-flight entry ${i} is not an in-flight request ({id, ts, keyId, keyPrefix, keyLabel}), so whether it runs on this key cannot be told`);
      }
      const f = parsed.data;
      inflight.push({ id: f.id, ts: f.ts, keyId: f.keyId ?? null, keyPrefix: f.keyPrefix, keyLabel: f.keyLabel });
    }
    const last = rows.at(-1);
    return { keyId: id, rows, listCostMicroUsd: sum, next: rows.length === limit && last !== undefined ? { before: last.ts, beforeId: last.id } : null, inflight };
  };

  return {
    origin: url.origin,

    async verifyAdminKey(callOpts = {}) {
      return verifyAdminKey('admin_key', callOpts.signal);
    },

    async mint(spec, callOpts = {}) {
      const body = trialKeyRequest(spec, callOpts.now ?? clock());
      const minted = await mintKey(body, callOpts);
      return {
        id: minted.id,
        key: minted.key,
        prefix: minted.prefix,
        label: minted.label,
        expiresAt: minted.expiresAt,
        dailyLimitUsd: body.dailyLimitUsd,
        allowedModels: body.allowedModels,
      };
    },

    async mintBuildKey(spec, callOpts = {}) {
      const body = buildKeyRequest(spec, callOpts.now ?? clock());
      const minted = await mintKey(body, callOpts);
      return {
        id: minted.id,
        key: minted.key,
        prefix: minted.prefix,
        label: minted.label,
        expiresAt: minted.expiresAt,
        capMicroUsd: spec.capMicroUsd,
        dailyLimitUsd: body.dailyLimitUsd,
        monthlyLimitUsd: body.monthlyLimitUsd ?? body.dailyLimitUsd,
        allowedModels: body.allowedModels,
      };
    },

    async mintJudgeKey(spec, callOpts = {}) {
      const body = judgeKeyRequest(spec, callOpts.now ?? clock());
      const minted = await mintKey(body, callOpts);
      return {
        id: minted.id,
        key: minted.key,
        prefix: minted.prefix,
        label: minted.label,
        expiresAt: minted.expiresAt,
        ...(body.dailyLimitUsd === undefined ? {} : { dailyLimitUsd: body.dailyLimitUsd }),
        allowedModels: body.allowedModels,
        models: minted.models,
      };
    },

    async mintWitnessKey(spec, callOpts = {}) {
      const body = witnessKeyRequest(spec, callOpts.now ?? clock());
      const minted = await mintKey(body, callOpts);
      return {
        id: minted.id,
        key: minted.key,
        prefix: minted.prefix,
        label: minted.label,
        expiresAt: minted.expiresAt,
        dailyLimitUsd: body.dailyLimitUsd,
        allowedModels: body.allowedModels,
        models: minted.models,
      };
    },

    requests,

    disable,

    async spend(id, callOpts = {}) {
      if (!KeyId.safeParse(id).success) throw new TypeError(`a masq key id is letters, digits and . _ -, got ${JSON.stringify(id)}`);
      const start = clock();
      let last = await readSpend(id, callOpts.signal);
      let reads = 1;
      let settled = false;
      // Read again after each gap until two reads agree; never past the cap (by the clock, and by count should the clock stand still).
      while (reads < MAX_SETTLE_READS && clock() - start + MASQ_SPEND_SETTLE_GAP_MS <= MASQ_SPEND_SETTLE_CAP_MS) {
        await settleWait(id, callOpts.signal);
        const next = await readSpend(id, callOpts.signal);
        reads++;
        const same = next.source === last.source && microUsdOf(next.usd) === microUsdOf(last.usd) && next.requests === last.requests;
        last = next;
        if (same) {
          settled = true;
          break;
        }
      }
      return {
        id,
        microUsd: microUsdOf(last.usd),
        usd: last.usd,
        source: last.source,
        readAt: last.readAt,
        settled,
        reads,
        requests: last.requests,
        ledgerMicroUsd: last.ledgerUsd === null ? null : microUsdOf(last.ledgerUsd),
      };
    },
  };
}

/** The broker the server's config names; null when MAKEFUN_LLM_GATEWAY is off. */
export function masqBrokerFromConfig(
  config: Pick<Config, 'llmGateway' | 'llmGatewayUrl' | 'llmGatewayAdminKey'>,
  opts: Omit<MasqBrokerOptions, 'origin' | 'adminKey'> = {},
): MasqAdminBroker | null {
  if (config.llmGateway === 'off') return null;
  if (config.llmGatewayUrl === null || config.llmGatewayAdminKey === null) {
    throw new TypeError('MAKEFUN_LLM_GATEWAY=masq needs MAKEFUN_LLM_GATEWAY_URL and MAKEFUN_LLM_GATEWAY_ADMIN_KEY (server/config.ts)');
  }
  return masqBroker({ ...opts, origin: config.llmGatewayUrl, adminKey: config.llmGatewayAdminKey });
}

/**
 * The broker the server's config names, its admin key's pin read first (verifyAdminKey): what the
 * grader starts the agent/v1 gateway with, so an admin key not pinned to the grader host(s) stops
 * agent/v1 grading at start rather than at its first trial. Null when MAKEFUN_LLM_GATEWAY is off;
 * rejects with a MasqAdminKeyRefusal (the key unpinned, pinned wider than a /24, a masq that reports
 * no pins, or one masq itself refuses from this host's address: its 403 source pin refusal, problem
 * `source`, naming the address and the fix) or a MasqBrokerError (op admin_key: masq could not be
 * asked).
 */
export async function openMasqBroker(
  config: Pick<Config, 'llmGateway' | 'llmGatewayUrl' | 'llmGatewayAdminKey'>,
  opts: Omit<MasqBrokerOptions, 'origin' | 'adminKey'> = {},
  callOpts: BrokerCallOptions = {},
): Promise<MasqAdminBroker | null> {
  const broker = masqBrokerFromConfig(config, opts);
  if (broker === null) return null;
  const adminKey = config.llmGatewayAdminKey;
  // masqBrokerFromConfig has refused a masq with no admin key; this reads the type.
  if (adminKey === null) throw new TypeError('MAKEFUN_LLM_GATEWAY=masq needs MAKEFUN_LLM_GATEWAY_ADMIN_KEY (server/config.ts)');
  try {
    await broker.verifyAdminKey(callOpts);
  } catch (err) {
    // masq's own source-pin refusal is the admin key's fault, not the broker's: the grader pages it at
    // start instead of logging, and a pin fixed on the box is picked up by the next read. Every other
    // fault stays the broker's own (MasqBrokerError), as before.
    throw masqSourceRefusal(err, broker.origin, adminKey) ?? err;
  }
  return broker;
}

/**
 * The forwarder's `upstream` and `key` (main.ts GatewayConfig) for a pass on `minted`: masq at
 * `origin`, the origin as the forwarder's container reaches it (which may differ from the broker's).
 */
export function masqUpstreamConfig(origin: string, minted: Pick<MintedTrialKey, 'key'>): { upstream: UpstreamConfigT; key: string } {
  return { upstream: { adapter: 'masq', origin: parseOrigin(origin).origin }, key: UpstreamKey.parse(minted.key) };
}

// ------------------------------------------------------------------ after the pass

/**
 * Whether masq's spend for a key and the forwarder's meter disagree: by more than masq's rounding
 * (MASQ_SPEND_ROUNDING_MICRO_USD) and by more than MASQ_SPEND_TOLERANCE_PERCENT of the meter. Exact,
 * in µUSD.
 */
export function spendMismatch(meterMicroUsd: bigint, masqMicroUsd: bigint): boolean {
  if (meterMicroUsd < 0n || masqMicroUsd < 0n) throw new RangeError(`spend is never negative: meter ${meterMicroUsd}, masq ${masqMicroUsd}`);
  const gap = masqMicroUsd > meterMicroUsd ? masqMicroUsd - meterMicroUsd : meterMicroUsd - masqMicroUsd;
  if (gap <= MASQ_SPEND_ROUNDING_MICRO_USD) return false;
  return gap * 100n > meterMicroUsd * MASQ_SPEND_TOLERANCE_PERCENT;
}

/** A trial key retired: disabled, its spend read once masq settled it and checked against the forwarder's meter. */
export interface RetiredTrialKey {
  id: string;
  disabled: DisabledTrialKey;
  spend: MasqKeySpend;
  /** The forwarder's meter for the pass (the cassette's totals.micro_usd). */
  meterMicroUsd: bigint;
  /** masq's spend minus the meter, µUSD (negative when masq metered less). */
  gapMicroUsd: bigint;
  /**
   * Whether masq's figure had settled (spend.settled; a broker that does not say is taken as settled).
   * An unsettled figure is recorded as such and never judged: no mismatch, no flag.
   */
  settled: boolean;
  /** A settled figure more than the tolerance away from the meter (spendMismatch); false for an unsettled one. */
  mismatch: boolean;
  /** The run flags it sets: GATEWAY_SPEND_MISMATCH_FLAG on a mismatch, else none. Admins only; never a score. */
  flags: readonly string[];
}

/**
 * Retire a pass's key (or a judge heat's, against its record's priced total): disable it first (so nothing more is spent on it), then read its spend once
 * masq has settled it (MasqBroker.spend: masq's cap ledger lags its request log after the key's last
 * request, so a figure read straight after disable under-reads) and check a settled figure against
 * the forwarder's meter. A broker fault in either is a MasqBrokerError; disabling again is harmless
 * (idempotent), so a caller may retry a retirement that failed.
 */
export async function retireTrialKey(broker: Pick<MasqBroker, 'disable' | 'spend'>, id: string, meterMicroUsd: bigint, opts: BrokerCallOptions = {}): Promise<RetiredTrialKey> {
  if (typeof meterMicroUsd !== 'bigint' || meterMicroUsd < 0n) throw new RangeError(`the forwarder's meter is µUSD from 0, got ${String(meterMicroUsd)}`);
  const disabled = await broker.disable(id, opts);
  const spend = await broker.spend(id, opts);
  const settled = spend.settled !== false;
  const mismatch = settled && spendMismatch(meterMicroUsd, spend.microUsd);
  return { id, disabled, spend, meterMicroUsd, gapMicroUsd: spend.microUsd - meterMicroUsd, settled, mismatch, flags: mismatch ? [GATEWAY_SPEND_MISMATCH_FLAG] : [] };
}
