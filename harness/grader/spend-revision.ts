// The one pricing revision an agent/v1 run's spend is stated on, when its trials' cassettes name more than one.
//
// A trial's cassette is stamped with the pricing revision of the grader that recorded it (grader/gateway/meter.ts
// pricing_rev, the bundled rows.json: pricing/price.ts pricingRev), so a release that changes rows.json while a
// final is graded leaves a run's early trials on the old table and its later ones on the new. aggregateTrials
// (grader/agent-score.ts) states a run's spend on one revision, its first trial's, and refuses trials priced on two;
// that check stays as it is. spendOnFirstTrialRevision restates such a run's trials on its first trial's revision
// when, and only when, nothing the run spent could read differently on another:
//
//   held        every revision among the run's cassettes (each trial's own and, where a trial has one, its house
//               lane's) is one this server holds (pricing/revs.ts pricerOfRev not null), and
//   agree       every one of them bills every call recorded in those cassettes that names a model exactly as the
//               first trial's revision bills it: the model resolves to the same row index in both (both unpriced
//               agrees too; priced in one and not the other does not), and that row's period in force at the
//               call's `at` (its base rates, its long-context threshold and rates) is the same JSON in both.
//
// Same row and same period is the strongest agreement the pricer can state, and the one sound without the billing
// tier: a cassette entry stores its usage and its micro_usd, never the tier it billed at (contracts/agent.ts
// CassetteEntry: the tier the response reported, else the one the request named; grader/gateway/policy.ts
// priceAtTier). A tier's rates are derived from the list period of the row and the row's published tiers, keyed by
// the row's index (policy.ts tierPricer, publishedByRow), so two tables that resolve a call to the same row index
// with the same period price it alike at every tier and every usage, which comparing one usage at the list rate
// cannot show. A call naming no model (a `models` listing, a refusal naming none) is priced by no table. A refused
// call that names one is held to it too, though it costs 0 by the contract: what a run's calls name is weighed
// whole, never a part of it.
//
// What is restated is only the NAME of the revision each trial's spend is stated on: every stored micro_usd stands as
// it was metered, never re-priced, so the run's spend totals are its cassettes' own sums. A run whose trials name one
// revision comes back as it was (the same values), and so does a run either rule refuses, which aggregateTrials then
// refuses with its own message. Its callers are every place that hands cassette-derived trials to aggregateTrials:
// the fan-in (grader/worker.ts finish) and the L1 regrade (grader/regrade.ts regradeAgentL1, which the public
// verifier's cli/verify-result.ts regradeAgentPublishedRun runs), so a run finished this way regrades the same.
//
// runPricingRev keeps a run from splitting in the first place: it names the revision a trial of a run is metered on
// (grader/gateway/policy.ts GatewayPolicy.pricing_rev), the one its lowest-index recorded trial's cassette names
// (trial 0's once recorded), so a trial recorded by a grader bundling another table is still priced on the run's.
// A run none of whose trials is recorded starts on `first` (the bundled revision unless the caller names one). A
// revision this server holds no table of is PricingRevisionNotHeldError there, before the trial runs: the
// platform's fault, never the fan-in's.

import type { CassetteT } from '../contracts/agent.ts';
import { createPricer, PRICING_ROWS, pricingRev as bundledPricingRev, type Pricer } from '../pricing/price.ts';
import { pricerOfRev } from '../pricing/revs.ts';
import { canonicalJson } from '../sim/canonical.ts';
import { PricingRevisionNotHeldError, pricingTableOf } from './gateway/policy.ts';
import type { AgentTrialResult } from './agent-score.ts';

/** One trial of a run: its result as it is handed to aggregateTrials, and its cassettes, read only when the run's trials name more than one revision. */
export interface SpendTrial {
  result: AgentTrialResult;
  /** Its own cassette and, where it has one, its house lane's. */
  cassettes: () => Promise<readonly CassetteT[]>;
}

let bundledRows: Pricer | null = null;

/**
 * The pricer of revision `rev` that names a model's row and its period (pricing/engine.ts Pricer), or null when this
 * server holds no such table: the bundled rows for the bundled revision, a held table's pricer for a held one
 * (pricing/revs.ts builds each with pricing/engine.ts createPricer), null for any other.
 */
function rowPricerOf(rev: string): Pricer | null {
  if (rev === bundledPricingRev) return (bundledRows ??= createPricer(PRICING_ROWS));
  const held = pricerOfRev(rev);
  if (held === null || held.pricingRev !== rev || !('resolveRow' in held) || !('periodAt' in held)) return null;
  return held as Pricer;
}

/** Whether `a` and `b` bill a call naming `model` at `at` alike: the same row index (or both none) and the same period in force there. */
function billAlike(a: Pricer, b: Pricer, model: string, at: string): boolean {
  const row = a.resolveRow(model);
  if (row !== b.resolveRow(model)) return false;
  return row === null || canonicalJson(a.periodAt(row, at)) === canonicalJson(b.periodAt(row, at));
}

/**
 * The run's trial results (`trials`, in index order) with each one's spend stated on its first trial's pricing revision
 * when its cassettes name more than one, every one held here, and they agree on every call those cassettes record (the
 * header); else the results as they came. `log` is told one line when a run is restated: the run, the revisions found,
 * the one stated.
 */
export async function spendOnFirstTrialRevision(run: string, trials: readonly SpendTrial[], log: (line: string) => void): Promise<AgentTrialResult[]> {
  const results = trials.map((t) => t.result);
  if (results.length === 0) return results;
  const stated = results[0]!.pricing_rev;
  if (results.every((r) => r.pricing_rev === stated)) return results;
  const cassettes = (await Promise.all(trials.map((t) => t.cassettes()))).flat();
  const found = [...new Set([...results.map((r) => r.pricing_rev), ...cassettes.map((c) => c.pricing_rev)])];
  const pricers = new Map<string, Pricer>();
  for (const rev of found) {
    const pricer = rowPricerOf(rev);
    if (pricer === null) return results;
    pricers.set(rev, pricer);
  }
  const first = pricers.get(stated)!;
  for (const c of cassettes) {
    for (const e of c.entries) {
      if (e.model === null) continue;
      for (const [rev, pricer] of pricers) if (rev !== stated && !billAlike(first, pricer, e.model, e.at)) return results;
    }
  }
  log(
    `[grade] run ${run}'s trials were priced on ${found.length} pricing revisions (${found.join(', ')}), which bill every call its cassettes record alike: its spend is stated on ${stated}, its first trial's, every micro_usd as metered`,
  );
  return results.map((r) => (r.pricing_rev === stated ? r : { ...r, pricing_rev: stated }));
}

/** A recorded trial of a run, as runPricingRev reads it: its index, and the pricing_rev its cassette names, read only for the lowest index. */
export interface RecordedTrialRev {
  index: number;
  pricingRev: () => Promise<string>;
}

/**
 * The pricing revision a trial of a run is metered on (the header's runPricingRev): the one the lowest-index trial of
 * `recorded` (the run's trials with a cassette) names, else `first` (default the bundled revision). Throws
 * PricingRevisionNotHeldError when this server holds no table of it (grader/gateway/policy.ts pricingTableOf).
 */
export async function runPricingRev(recorded: readonly RecordedTrialRev[], first: string = bundledPricingRev): Promise<string> {
  let earliest: RecordedTrialRev | null = null;
  for (const t of recorded) if (earliest === null || t.index < earliest.index) earliest = t;
  const rev = earliest === null ? first : await earliest.pricingRev();
  if (pricingTableOf(rev) === null) throw new PricingRevisionNotHeldError(rev);
  return rev;
}
