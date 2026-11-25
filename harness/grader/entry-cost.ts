// What an entry cost to build, as a score's `cost` (contracts/score.ts Cost) states it: the entry's usage lines
// (usage_line) priced under its pricing_rev (the bundled one when it names none), with the provenance and the ids of its
// transcript sessions (grader/cost.ts computeCost). Read by every grade that builds a score (grader/worker.ts) and by
// an admin's re-judging of a scrape/v1 run its scorer left unscored (server/routes/admin/scrape-holds.ts), so the score
// a re-judging builds carries the cost the heat's own scores carry, and an L1 regrade of it re-derives the same.
//
// Under a bundle with a build meter (contracts/competition.ts BuildMeter: a code-cheapest bounty's), the cost is what
// the house's masq meter saw instead (grader/metered.ts meteredCostOf): the entrant's metered_request rows in the
// competition counted through the submission's created_at (its receipt), matched against the entry's usage lines,
// with its sessions' tiers for the provenance. Read from the stored rows alone, never from masq: a fresh grade syncs
// the entrant's build keys first (grader/worker.ts, server/metering/sync.ts syncEntrantKeys). The pricingRev answered
// stays the submission's (its authorship summary is priced under it); the metered cost's own pricing_rev is
// METERED_PRICING_REV.
//
//   the list        a grade counts the rows stored when it reads them, and masq can record a request late (a row
//                   with ts at or before the receipt that it answers only later: why the metering job's cap guard
//                   reaches back CAP_GUARD_LOOKBACK_MS), so a row the metering job stores after the grade would move
//                   a regrade that read the stored rows again. So the grade keeps the list of the requests it counted
//                   (their masq request ids, ascending, as canonical JSON: meteredRequestsJson) as a blob, and names
//                   it in the cost (Cost.metered.requests_sha256); a regrade (MeteredPricing.counted: the stored
//                   run's cost.metered) prices from exactly the stored rows the list names, read by masq request id,
//                   so it re-derives the same cost byte for byte whatever was stored since. A list the store no
//                   longer holds, that is no such list, or that names a row no longer stored is a MeteredCountError:
//                   the regrade cannot price what the grade counted. A stored cost that names no list (priced before
//                   the list was kept) is counted as it was: the stored rows through the receipt.

import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { CompetitionBundleT } from '../contracts/competition.ts';
import { MeteredCost, type CostT, type MeteredCostT } from '../contracts/score.ts';
import { pricingRev as bundledPricingRev } from '../pricing/price.ts';
import type { BlobStore } from '../server/blobstore.ts';
import type { Db } from '../server/db/client.ts';
import { meteredRequest, transcriptSession, usageLine, type submission } from '../server/db/schema.ts';
import { canonicalJson, sha256Hex } from '../sim/canonical.ts';
import { computeCost, costLinesFromRows, provenanceOf } from './cost.ts';
import { meteredCostOf, type MeteredLine, type MeteredRequest } from './metered.ts';

/** A submission row. */
type SubmissionRow = typeof submission.$inferSelect;

/** What entryCostOf reads of the submission (under a build meter: its competition, account and receipt time too). */
export type CostSubmission = Pick<SubmissionRow, 'id' | 'pricingRev'>;
export type MeteredSubmission = CostSubmission & Pick<SubmissionRow, 'competitionId' | 'userId' | 'createdAt'>;

/** An entry's cost, and the pricing_rev its authorship summary is read under. */
export interface EntryCost {
  cost: CostT;
  pricingRev: string;
}

/** How a metered cost is priced (the header's `the list`). */
export interface MeteredPricing {
  /** Where a grade keeps the list of the requests it counted, and a regrade reads it from. */
  blobs: Pick<BlobStore, 'put' | 'get'>;
  /**
   * A regrade's: the metered cost the stored run was priced with (its score's cost.metered, storedMeteredCost). With a
   * list (requests_sha256) the cost is priced from exactly the requests it names; naming none (priced before the list
   * was kept), from the stored requests through the receipt, and the cost names no list, as that grade's did. Absent: a
   * grade's, the stored requests through the receipt, whose list it keeps.
   */
  counted?: MeteredCostT;
}

/** A regrade cannot price what its grade counted (the header's `the list`): the list or a row it names is gone, or it is no list. */
export class MeteredCountError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MeteredCountError';
  }
}

/** The most masq request ids one read of the listed rows names (a list's rows are read in chunks of it). */
const LISTED_READ_CHUNK = 1_000;

/** A usage_line row as the meter's match reads it. */
export function meteredLineOf(r: typeof usageLine.$inferSelect): MeteredLine {
  return {
    message_id: r.messageId,
    model: r.model,
    at: r.at.toISOString(),
    input: r.input,
    output: r.output,
    cache_read: r.cacheRead,
    cache_write_5m: r.cacheWrite5m,
    cache_write_1h: r.cacheWrite1h,
    reasoning: r.reasoning,
    session: r.sessionId,
  };
}

/** A metered_request row as the meter's match and sum read it. */
export function meteredRequestOf(r: typeof meteredRequest.$inferSelect): MeteredRequest {
  return {
    id: r.masqRequestId,
    ts: r.ts.toISOString(),
    model_requested: r.modelRequested,
    model: r.model,
    input: r.input,
    output: r.output,
    reasoning: r.reasoning,
    cache_read: r.cacheRead,
    cache_creation: r.cacheCreation,
    list_cost_micro_usd: r.listCostMicroUsd,
    pricing_fallback: r.pricingFallback,
    upstream_response_id: r.upstreamResponseId,
  };
}

/** The counted requests' list (the header's `the list`): their masq request ids, ascending, as canonical JSON. Cost.metered.requests_sha256 is its sha256. */
export function meteredRequestsJson(ids: readonly number[]): string {
  return canonicalJson([...ids].sort((a, b) => a - b));
}

/** The metered cost a stored run's score was priced with (its cost.metered), or undefined when it holds none (no score, or no meter). */
export function storedMeteredCost(result: unknown): MeteredCostT | undefined {
  const metered = (result as { cost?: { metered?: unknown } } | null | undefined)?.cost?.metered;
  if (metered === undefined) return undefined;
  const parsed = MeteredCost.safeParse(metered);
  return parsed.success ? parsed.data : undefined;
}

/** The masq request ids a list's bytes name: a canonical, ascending JSON array of distinct masq request ids; else a MeteredCountError. */
function listedIds(bytes: Uint8Array, sha256: string, what: string): number[] {
  const text = Buffer.from(bytes).toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new MeteredCountError(`${what}: its counted requests' list ${sha256} is no JSON`, { cause: err });
  }
  if (!Array.isArray(value) || !value.every((id) => Number.isSafeInteger(id) && (id as number) >= 0)) {
    throw new MeteredCountError(`${what}: its counted requests' list ${sha256} is no list of masq request ids`);
  }
  const ids = value as number[];
  if (ids.some((id, i) => i > 0 && id <= ids[i - 1]!) || meteredRequestsJson(ids) !== text) {
    throw new MeteredCountError(`${what}: its counted requests' list ${sha256} is not ascending, distinct and canonical`);
  }
  return ids;
}

/** The stored rows of the requests `ids` names in competition `competitionId`, each once; a MeteredCountError when one is no longer stored there. */
async function listedRows(db: Pick<Db, 'select'>, competitionId: string, ids: readonly number[], what: string): Promise<(typeof meteredRequest.$inferSelect)[]> {
  const rows: (typeof meteredRequest.$inferSelect)[] = [];
  for (let i = 0; i < ids.length; i += LISTED_READ_CHUNK) {
    const chunk = ids.slice(i, i + LISTED_READ_CHUNK);
    rows.push(...(await db.select().from(meteredRequest).where(and(eq(meteredRequest.competitionId, competitionId), inArray(meteredRequest.masqRequestId, chunk)))));
  }
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.masqRequestId));
    const gone = ids.filter((id) => !found.has(id));
    throw new MeteredCountError(`${what}: ${gone.length} of the ${ids.length} requests its grade counted (masq ${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ', …' : ''}) are no longer stored in competition ${competitionId}`);
  }
  return rows.sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.masqRequestId - b.masqRequestId);
}

/**
 * What an entry cost to build (the header): its usage lines priced under its pricing_rev (the bundled one when it names
 * none), with the provenance and the ids of its transcript sessions; under a bundle with a build meter, the meter's cost
 * of the entrant's stored metered requests through the submission's receipt, vouched for against those lines, with the
 * list of the requests it counted kept in `meter.blobs` and named in the cost; for a regrade (`meter.counted` naming a
 * list), of exactly the requests that list names (the header's `the list`; a MeteredCountError when it cannot).
 */
export async function entryCostOf(db: Pick<Db, 'select'>, sub: CostSubmission): Promise<EntryCost>;
export async function entryCostOf(db: Pick<Db, 'select'>, sub: MeteredSubmission, bundle: Pick<CompetitionBundleT, 'build_meter'>, meter?: MeteredPricing): Promise<EntryCost>;
export async function entryCostOf(db: Pick<Db, 'select'>, sub: CostSubmission | MeteredSubmission, bundle?: Pick<CompetitionBundleT, 'build_meter'>, meter?: MeteredPricing): Promise<EntryCost> {
  const usage = await db.select().from(usageLine).where(eq(usageLine.submissionId, sub.id));
  const sessions = await db
    .select({ id: transcriptSession.id, provenance: transcriptSession.provenance })
    .from(transcriptSession)
    .where(eq(transcriptSession.submissionId, sub.id));
  const pricingRev = sub.pricingRev ?? bundledPricingRev;
  if (bundle?.build_meter !== undefined) {
    const s = sub as MeteredSubmission;
    if (s.competitionId === undefined || s.userId === undefined || !(s.createdAt instanceof Date)) {
      throw new TypeError(`submission ${sub.id}'s metered cost is read by its competition, account and receipt time, and they were not given`);
    }
    if (meter === undefined) throw new TypeError(`submission ${sub.id}'s metered cost keeps the list of the requests it counts in the blob store, and none was given`);
    const listed = meter.counted?.requests_sha256;
    let requests: (typeof meteredRequest.$inferSelect)[];
    if (listed === undefined) {
      requests = await db
        .select()
        .from(meteredRequest)
        .where(and(eq(meteredRequest.competitionId, s.competitionId), eq(meteredRequest.userId, s.userId), lte(meteredRequest.ts, s.createdAt)))
        .orderBy(asc(meteredRequest.ts), asc(meteredRequest.masqRequestId));
    } else {
      const what = `submission ${sub.id}'s metered cost cannot be priced from the requests its grade counted`;
      let bytes: Uint8Array | null;
      try {
        bytes = await meter.blobs.get(listed, { verify: true });
      } catch (err) {
        throw new MeteredCountError(`${what}: its counted requests' list ${listed} cannot be read from the blob store (${err instanceof Error ? err.message : String(err)})`, { cause: err });
      }
      if (bytes === null) throw new MeteredCountError(`${what}: the blob store holds no counted requests' list ${listed}`);
      requests = await listedRows(db, s.competitionId, listedIds(bytes, listed, what), what);
    }
    const cost = meteredCostOf(usage.map(meteredLineOf), requests.map(meteredRequestOf), s.createdAt, sessions);
    // A regrade of a cost priced before the list was kept names none, as that grade did.
    if (meter.counted !== undefined && listed === undefined) return { cost, pricingRev };
    // The list of the requests the cost counts (those through the receipt, as meteredCostOf counts them), by its digest:
    // kept by a grade, re-derived by a regrade (the same bytes when it priced the same requests).
    const through = s.createdAt.getTime();
    const json = meteredRequestsJson(requests.filter((r) => r.ts.getTime() <= through).map((r) => r.masqRequestId));
    const sha256 = listed === undefined ? (await meter.blobs.put(json)).sha256 : sha256Hex(json);
    return { cost: { ...cost, metered: { ...cost.metered!, requests_sha256: sha256 } }, pricingRev };
  }
  const cost = computeCost(costLinesFromRows(usage), {
    pricingRev,
    provenance: provenanceOf(sessions.map((s) => s.provenance)),
    sessions: sessions.map((s) => s.id),
  });
  return { cost, pricingRev };
}
