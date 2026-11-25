// How a reward pool splits by place: the three ways the new proposal page offers (the cards Winner takes most,
// Recommended, Spread wide) and the one split of a pool over the top places, in cents, that the page, the server and the
// suggest service all compute the same way, so a pool turned into `prizes[]` anywhere pays the same cents.
//
// The most places a bounty pays depends on its kind (PlacesKind): a judged bounty and a code-fastest bounty pay at most
// PAYOUT_MAX_PLACES, every other measured kind at most PAYOUT_MEASURED_MAX_PLACES (contracts/sponsor-proposal.ts placesKindOf
// names a proposal's kind). A leaf: no imports at all, so the server, the cli and the web app all read it.

/**
 * The most places a judged bounty or a code-fastest bounty pays, and the usual count they start on. It holds where a real
 * limit binds: a judged bounty's playoff and its private rounds grow with its places (server/proposals/judged-house.ts
 * HOUSE_JUDGED_MAX_PLACES, the sponsor contract's bound), and a code-fastest bounty's timing heat is sized on the most places
 * a proposal may pay (server/proposals/checks.ts PACK_HEAT_FIELD). A Something else brief takes the same bound until the
 * make.fun team sets its kind, which may be either of these.
 */
export const PAYOUT_MAX_PLACES = 10;
export const PAYOUT_USUAL_PLACES = 10;

/**
 * The most places every other measured kind pays: best test score, smallest code, the trading boards, first to pass,
 * cheapest to build (the owner, 2026-11-22: "by default ... more prize places always"). Its usual count is the same.
 */
export const PAYOUT_MEASURED_MAX_PLACES = 20;
export const PAYOUT_MEASURED_USUAL_PLACES = 20;

/** Which places cap a bounty's kind falls under: 'capped' (a judged kind, code-fastest, Something else) or 'measured'. */
export type PlacesKind = 'capped' | 'measured';

/** The most places a bounty of `kind` pays. */
export const placesMostOf = (kind: PlacesKind): number => (kind === 'measured' ? PAYOUT_MEASURED_MAX_PLACES : PAYOUT_MAX_PLACES);

/** The places a bounty of `kind` pays when it names no count (the usual): the most a split pays, cut by placesAtFloorOf. */
export const placesUsualOf = (kind: PlacesKind): number => (kind === 'measured' ? PAYOUT_MEASURED_USUAL_PLACES : PAYOUT_USUAL_PLACES);

/**
 * The least a place pays where the pool can pay it: $1 (the owner, 2026-11-22: "give top 50, 100 participants something
 * >= $1", server/proposals/judged-house.ts; judged-dossier.ts holds each judged placement to it). A usual count of places
 * is cut to the most a pool pays at this floor (placesAtFloorOf); the split itself still floors each place at a cent
 * (maxPlacesOf, splitPool).
 */
export const PAYOUT_PLACE_FLOOR_CENTS = 100;

/**
 * The prizes step's ways to split the pool (the owner's picks, 2026-11-05: the 'Presets' mockup, with the 'Slider'
 * mockup's places bar for more say): each place pays `ratio` of the one above it, and a pick starts on `places` places.
 * These counts are the capped kinds' (placesMostOf and placesUsualOf 'capped'); payoutShapePlacesOf reads a kind's own.
 */
export const PAYOUT_SHAPES = Object.freeze({
  top: { places: 3, ratio: 0.45 },
  balanced: { places: PAYOUT_USUAL_PLACES, ratio: 0.7 },
  flat: { places: PAYOUT_MAX_PLACES, ratio: 0.9 },
});
export type PayoutShape = keyof typeof PAYOUT_SHAPES;
/** The shapes as the page lays out their cards, left to right. */
export const PAYOUT_ORDER: readonly PayoutShape[] = ['top', 'balanced', 'flat'];
/** The shape the page pre-selects (its Recommended card), and the one a split read back prefers when several fit. */
export const RECOMMENDED_PAYOUT_SHAPE: PayoutShape = 'balanced';

/** The places a shape starts on for a bounty of `kind`: Winner takes most keeps 3, Recommended the usual, Spread wide the most. */
export function payoutShapePlacesOf(shape: PayoutShape, kind: PlacesKind): number {
  return shape === 'top' ? PAYOUT_SHAPES.top.places : shape === 'balanced' ? placesUsualOf(kind) : placesMostOf(kind);
}

/** The steps a split rounds places 2 on to, coarsest first, in cents: $100 down to the cent. */
const PAYOUT_STEPS = [10_000, 5_000, 1_000, 500, 100, 1] as const;

/** The most places a pool of `cents` pays (at most `most`): at least a cent a place. */
export const maxPlacesOf = (cents: number, most: number = PAYOUT_MAX_PLACES): number => Math.max(1, Math.min(most, cents));

/**
 * The most places (at most `most`, at least 1) a pool of `cents` pays by `shape` with its last place at `floorCents` or
 * more (PAYOUT_PLACE_FLOOR_CENTS: $1): the largest count whose split (splitPool) holds the last place to the floor. The
 * last place is the smallest share, and it shrinks as places are added, so the first count from the top that holds
 * is the most. `most` is also the cap the split holds to (a bounty kind's most places). A pool that cannot pay even two
 * places at the floor pays one.
 */
export function placesAtFloorOf(cents: number, shape: PayoutShape, most: number, floorCents: number = PAYOUT_PLACE_FLOOR_CENTS): number {
  for (let n = Math.min(Math.max(1, Math.round(most)), maxPlacesOf(cents, most)); n > 1; n--) {
    if (splitPool(cents, shape, n, most)[n - 1]! >= floorCents) return n;
  }
  return 1;
}

/**
 * `cents` split over the top `places` places (within maxPlacesOf at `most`) by `shape`, in cents, place 1 first: places 2
 * on rounded to the coarsest step under a tenth of the smallest share (round numbers, each within 5% of its share), else
 * to whole dollars while the smallest share is one, else to the cent; place 1 takes what the rounding leaves, so the split
 * adds up to the pool and never pays a place more than the one above. `most` defaults to the capped kinds' most.
 */
export function splitPool(cents: number, shape: PayoutShape, places: number, most: number = PAYOUT_MAX_PLACES): number[] {
  const n = Math.min(Math.max(1, Math.round(places)), maxPlacesOf(cents, most));
  const ratio = PAYOUT_SHAPES[shape].ratio;
  const weights = Array.from({ length: n }, (_, i) => ratio ** i);
  const total = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (cents * w) / total);
  const smallest = exact[n - 1]!;
  for (const step of PAYOUT_STEPS.filter((s) => (s > 100 ? s * 10 : s) <= smallest || s === 1)) {
    const rest = exact.slice(1).map((v) => Math.max(step, Math.round(v / step) * step));
    const first = cents - rest.reduce((a, b) => a + b, 0);
    if (n === 1 || first >= rest[0]!) return [first, ...rest];
  }
  // A pool of a few cents a place: as even as whole cents go, the remainder to place 1.
  const even = Math.floor(cents / n);
  return [cents - even * (n - 1), ...Array<number>(n - 1).fill(even)];
}
