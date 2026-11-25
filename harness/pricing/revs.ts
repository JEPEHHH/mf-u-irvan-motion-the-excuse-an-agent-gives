// The pricing tables this server holds besides the bundled one (pricing/price.ts): each a rows.json an earlier release
// bundled, kept byte for byte as pricing/revs/<pricing_rev>.json. An entry is priced under the revision its receipt
// names (server/repos/receipt.ts pricing_rev), and an entry received before a deploy is ingested after it, so a change
// to rows.json ships with the table it replaces kept here (pricing/port-from-cosmos.ts writes the file; it is listed in
// HELD below with the revision that replaced it). Each is validated and its revision recomputed at load: a file whose
// content does not hash to its name throws here, and the server does not start.
// A held table may be dropped once no entry received under it is still unpriced.
// A job meets a revision through pricingOfRev: one this process holds no table of (a grader of the release before the one
// that shipped it, mid-roll) is handed back for PRICING_REV_HAND_BACK_MS, and only past that refused and paged.

import { createPricer, pricingRev as bundledPricingRev, priceUsage as bundledPriceUsage, type Pricer } from './price.ts';
import rev1ea1b8ea from './revs/1ea1b8ea1c4a66de7ef740880c266a2c0e119de11f1651873f3b1a55f3caeec9.json' with { type: 'json' };
import rev69078b05 from './revs/69078b05507d9cba63e9ad6c57d47dd8983a943336be350318027f20f106ebdc.json' with { type: 'json' };
import reve5434d8a from './revs/e5434d8a7e0120d3859eabcee31ea34bddd76c7d9f6356192e528eba454aaf93.json' with { type: 'json' };
import revdcb80a1b from './revs/dcb80a1bb9517e245c6e2e44e2f19b68000c8508c58f8d207e8e4532cbaedae0.json' with { type: 'json' };
import rev472b48ba from './revs/472b48ba54ffaf5d3f3c9230050ef16360d2fb9280d6b299e549e2bd8e0b6393.json' with { type: 'json' };
import rev45c98b74 from './revs/45c98b74084333decd95ac81760727274d419136ce7bd158336eaf0667c03491.json' with { type: 'json' };
import revc6fcfac2 from './revs/c6fcfac2cd8c1a316582690b02362df43ca26403f81019dbc528d75df1fb04e0.json' with { type: 'json' };
import rev6a262a9d from './revs/6a262a9d0245fc1bb135c62775a6abd481aace3029ff2857a45310eb172ac899.json' with { type: 'json' };

/** What prices an entry's usage and authorship under one revision. */
export type RevPricer = Pick<Pricer, 'pricingRev' | 'priceUsage'>;

/** A held table: its revision (its file's name), the revision that replaced it in rows.json, and the document. */
interface HeldTable {
  rev: string;
  replacedBy: string;
  doc: unknown;
}

/** Oldest first; each one's `replacedBy` is the next one's `rev`, the last one's the bundled revision. */
const HELD: readonly HeldTable[] = [
  { rev: '1ea1b8ea1c4a66de7ef740880c266a2c0e119de11f1651873f3b1a55f3caeec9', replacedBy: '69078b05507d9cba63e9ad6c57d47dd8983a943336be350318027f20f106ebdc', doc: rev1ea1b8ea },
  { rev: '69078b05507d9cba63e9ad6c57d47dd8983a943336be350318027f20f106ebdc', replacedBy: 'e5434d8a7e0120d3859eabcee31ea34bddd76c7d9f6356192e528eba454aaf93', doc: rev69078b05 },
  { rev: 'e5434d8a7e0120d3859eabcee31ea34bddd76c7d9f6356192e528eba454aaf93', replacedBy: 'dcb80a1bb9517e245c6e2e44e2f19b68000c8508c58f8d207e8e4532cbaedae0', doc: reve5434d8a },
  { rev: 'dcb80a1bb9517e245c6e2e44e2f19b68000c8508c58f8d207e8e4532cbaedae0', replacedBy: '472b48ba54ffaf5d3f3c9230050ef16360d2fb9280d6b299e549e2bd8e0b6393', doc: revdcb80a1b },
  { rev: '472b48ba54ffaf5d3f3c9230050ef16360d2fb9280d6b299e549e2bd8e0b6393', replacedBy: '45c98b74084333decd95ac81760727274d419136ce7bd158336eaf0667c03491', doc: rev472b48ba },
  { rev: '45c98b74084333decd95ac81760727274d419136ce7bd158336eaf0667c03491', replacedBy: 'c6fcfac2cd8c1a316582690b02362df43ca26403f81019dbc528d75df1fb04e0', doc: rev45c98b74 },
  { rev: 'c6fcfac2cd8c1a316582690b02362df43ca26403f81019dbc528d75df1fb04e0', replacedBy: '6a262a9d0245fc1bb135c62775a6abd481aace3029ff2857a45310eb172ac899', doc: revc6fcfac2 },
  { rev: '6a262a9d0245fc1bb135c62775a6abd481aace3029ff2857a45310eb172ac899', replacedBy: '34d1007cd9dd19a1d751a8b87e79e95c181a94b3e791b1a546de6dac11435dbe', doc: rev6a262a9d },
];

/** The pricer of held table `doc`, kept as pricing/revs/<rev>.json: validated, and refused unless it prices under `rev`. */
export function heldPricerOf(rev: string, doc: unknown): Pricer {
  const pricer = createPricer(doc);
  if (pricer.pricingRev !== rev) throw new Error(`pricing/revs/${rev}.json prices under ${pricer.pricingRev}, not the revision its name says`);
  return pricer;
}

const heldPricers = new Map(HELD.map((t) => [t.rev, heldPricerOf(t.rev, t.doc)]));

/** The held revisions (never the bundled one), oldest first, each with the revision that replaced it. */
export const HELD_PRICING_REVS: readonly { rev: string; replacedBy: string }[] = Object.freeze(HELD.map((t) => Object.freeze({ rev: t.rev, replacedBy: t.replacedBy })));

const bundled: RevPricer = Object.freeze({ pricingRev: bundledPricingRev, priceUsage: bundledPriceUsage });

/** The pricer of revision `rev`: the bundled table's for the bundled revision, a held table's for a held one, null for any other. */
export function pricerOfRev(rev: string): RevPricer | null {
  if (rev === bundledPricingRev) return bundled;
  return heldPricers.get(rev) ?? null;
}

/** Whether this server can price under `rev` (pricerOfRev is not null). */
export function holdsPricingRev(rev: string): boolean {
  return pricerOfRev(rev) !== null;
}

/** Every revision this server can price under: the bundled one, then the held ones oldest first. */
export function heldPricingRevs(): string[] {
  return [bundledPricingRev, ...HELD.map((t) => t.rev).filter((rev) => rev !== bundledPricingRev)];
}

/**
 * How long a job that meets a pricing revision its server holds no table of is handed back, from when that revision was
 * first asked of it (`since`: an entry's receipt or its latest ingest re-send, a trial's row or its latest re-queue),
 * before it is refused and paged. Only a process of a release before the one that shipped the revision meets it, mid-roll,
 * and that grader takes jobs only until the roll reaches it, then lives at most its drain (deploy/k8s/base/grader.yaml
 * terminationGracePeriodSeconds 9300: MAKEFUN_DRAIN_SECONDS 9000 and 300 s of close), taking no new job. The revision
 * was live by `since` (a receipt priced on it), so the roll had begun by then: past that drain and half an hour more for
 * the roll to reach the last old grader, no grader of the release before is left, and a revision no process holds is a
 * rollback's, which a hand-back never mends. 11,100 s.
 */
export const PRICING_REV_HAND_BACK_MS = (9300 + 1800) * 1000;

/** How often a job handed back for its pricing revision looks again: it goes to the next slot of this length, so whichever grader takes it then, one of the release that holds the table among them, runs it. */
export const PRICING_REV_RECHECK_MS = 60_000;

/** The recheck slot a job handed back at `atMs` for its pricing revision goes to (PRICING_REV_RECHECK_MS): it starts at slot x PRICING_REV_RECHECK_MS. */
export function pricingRevRecheckSlot(atMs: number): number {
  return Math.ceil((atMs + PRICING_REV_RECHECK_MS) / PRICING_REV_RECHECK_MS);
}

/** What a job does on meeting a pricing revision (pricingOfRev). */
export type RevPricing<P extends RevPricer = RevPricer> =
  /** This process prices under it. */
  | { kind: 'held'; pricer: P }
  /** Not held, inside the hand-back window: hand the job back for recheck slot `slot`, starting `until`; met here from `holdAt` it is refused. */
  | { kind: 'hand-back'; rev: string; slot: number; until: Date; holdAt: Date }
  /** Not held, the window spent (`holdAt`), or a caller with no job to hand back (`holdAt` null): refused, the platform's fault. */
  | { kind: 'unheld'; rev: string; holdAt: Date | null };

/**
 * The one way a job prices under pricing revision `rev`: its pricer when this process holds it (`fixed` alone when given,
 * a test's or a CLI's pricer that prices every entry), else a hand-back while `since` (when the revision was first asked
 * of the job, see PRICING_REV_HAND_BACK_MS) is less than PRICING_REV_HAND_BACK_MS before `now`, so a grader of the release
 * mid-roll hands the job on to one that holds the table instead of refusing what the next build prices; past that, or
 * with no `since` (nothing to hand back), unheld.
 */
export function pricingOfRev<P extends RevPricer = RevPricer>(rev: string, opts: { fixed?: P; since?: Date; now?: Date } = {}): RevPricing<P | RevPricer> {
  const pricer = opts.fixed === undefined ? pricerOfRev(rev) : opts.fixed.pricingRev === rev ? opts.fixed : null;
  if (pricer !== null) return { kind: 'held', pricer };
  if (opts.since === undefined) return { kind: 'unheld', rev, holdAt: null };
  const now = (opts.now ?? new Date()).getTime();
  const holdAt = new Date(opts.since.getTime() + PRICING_REV_HAND_BACK_MS);
  if (now >= holdAt.getTime()) return { kind: 'unheld', rev, holdAt };
  const slot = pricingRevRecheckSlot(now);
  return { kind: 'hand-back', rev, slot, until: new Date(slot * PRICING_REV_RECHECK_MS), holdAt };
}
