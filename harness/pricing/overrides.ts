// The cited override layer over the cosmos port: pricing/overrides.json, rows read off a vendor's
// own pricing pages where cosmos src/shared/model-pricing.ts lists a different rate or no row at
// all: OpenAI's; Google's Gemini API pages and Alibaba Cloud Model Studio's for the Gemini CLI and
// Qwen Code models; and, for the models the other harnesses' sessions name, Anthropic's Claude API
// table, Cognition's Devin model page, Z.ai's, the Kimi API platform's, MiniMax's, OpenCode Console's
// (Big Pickle, listed Free: a row at $0, cited like any other), GitHub Copilot's models-and-pricing
// page (MAI-Code-1.1-Flash and MAI-Code-2-Flash, which Microsoft bills at that list price), Upstage's,
// Mistral's and OpenRouter's (its `:free` variants, each listed at zero: one $0 row, last in the table;
// and, for an open-weight model whose maker publishes no per-token price, its models API `pricing`
// object, what OpenRouter bills by default). A maker's own per-token page always wins over OpenRouter's.
// pricing/port-from-cosmos.ts merges them into the source's table BEFORE it converts and
// parity-checks, so the source's own cost function prices the merged table and the engine is
// held to it exactly as for every other row; rows.json records the file's sha256 in
// `source.overrides`, so an edit here without a re-port is caught (`--check`, pricing.test.ts).
//
// Each row cites the page(s) it was read from: the URL, the instant it was retrieved and the
// verbatim lines it rests on; `pages` keeps each page's sha256 as read, so a later reader can tell
// whether a page has moved since.
//
//   replace  reprices the source row whose pattern is `match`; the port refuses once that row no
//            longer prices at `was` (cosmos changed it: re-read the page, then update or drop this).
//            `anchor`, when set, is the pattern the row carries after the merge in place of the source's
//            unanchored one (`gpt-6-astra` takes `gpt-6-astra-ultrafast` and `gpt-6-astra-law`, which the
//            page prices apart): it must take the row's own `model`, and the ids the source's pattern took
//            that it does not are released, each to price null or on a row of this layer (one a page prices
//            it on), never on another source row. It applies after every insert and Fast row, so their
//            `before` and `of` name the source's pattern; an alias names the anchored one.
//   insert   adds a row with pattern `match` ahead of the row whose pattern is `before`, or after every
//            row when `before` is null (a catch-all such as OpenRouter's `:free` ids, which must never
//            take an id a row above it lists); it may only price ids the source leaves null (the port
//            refuses one that takes an id from a row)
//   fast     the Fast-mode row of the Standard row whose pattern is `of` (after every replace and
//            insert): added right ahead of it, matching only that model's `-fast` spellings
//            (FAST_TOKEN), and priced at exactly `multiplier` × the Standard row on every rate and
//            tier it carries. The multiplier is the page's, row by row: OpenAI's Fast table is 2x
//            Standard except GPT-5.5 (2.5x) and GPT-5 mini (1.8x). A Fast row with no long-context
//            tier under a Standard row that has one (the page lists no long-context Fast rates for
//            GPT-5.5 / 5.4) must bill at least the Standard long-context rates at any size, so a
//            `-fast` id never prices below its Standard id. A model the Fast table does not list
//            has no Fast row, and its `-fast` spellings price null, never at Standard: the port
//            refuses a probe id that would (pricing/port-from-cosmos.ts checkFastSpellings).
//
// `promotion` records a promotional price whose end the page does not publish (GPT-5.6 Sol: "at
// least through November 21, 2026"): a cited line must name that day. The source's dated `intro`
// needs a last day, so the row bills the promotional rate until the page is re-read.
//
// `intro` is the source's own dated price (model-pricing.ts ModelPricing.intro): its rates through
// `until` (a UTC day, inclusive), the row's own from the next day. A cited line must name that next
// day as the page writes it ("starting December 1, 2026"), so the boundary is the page's, not ours.
// The source reads one intro and no nested one.
//
// `change` is a dated rate change (cosmos d74141126e ModelPricing.change; 115b45e predates it, so
// the port applies it): from `from` (a UTC day, inclusive) the WHOLE row bills as `change.pricing`,
// long tier included, and that pricing's own `intro` then applies; before it, the row (and its
// intro) is in force. A cited line must name `from` as the page writes it ("Effective December 1,
// 2026"), and the change's intro its next day, so a row has at most four dated periods. Used where
// a vendor reroutes a retired id to a successor and bills it at the successor's dated rates.
//
// `aliases` (beside `rows`) names ids no vendor prices that bill on a row the table already has, at
// its rates whatever they are: the port appends `match` to the pattern of the row whose pattern is
// `of` (`<of>|<match>`), after every row above is merged. It carries no rates and cites no page:
// `stand_in` says who decided it and when, and that no published price exists. Each of `ids` is a
// probe the port prices both ways and must bill on that row; it refuses an alias that takes an id
// another row prices, or one whose ids the source already prices.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const PRICING_OVERRIDES_SCHEMA = 'agent-fun/pricing-overrides/v1';
/** Where rows.json's `source.overrides.path` says the layer lives (repo-relative). */
export const OVERRIDES_REL_PATH = 'pricing/overrides.json';
export const OVERRIDES_PATH = fileURLToPath(new URL('./overrides.json', import.meta.url));

/** USD per million tokens, as the vendor prints it. */
const Usd = z.number().min(0).max(1_000_000);
const Instant = z.iso.datetime({ offset: false });

/** One tier's rates, in the cosmos source's field names (model-pricing.ts ModelPricing). */
const Tier = z.strictObject({
  input: Usd,
  output: Usd,
  /** The 30-minute cache write (OpenAI's default), billed on the cache_write_5m class. */
  cacheWrite: Usd,
  /** The 12-hour cache write, billed on the cache_write_1h class. */
  cacheWrite1h: Usd,
  cacheRead: Usd,
});

/** A calendar day, YYYY-MM-DD. */
const Day = z.iso.date();

const Tiered = z.strictObject({
  ...Tier.shape,
  /** Past `overTokens` of prompt (`strict`: over; else at or over) the WHOLE request reprices. */
  longContext: z.strictObject({ overTokens: z.int().min(0), strict: z.boolean(), pricing: Tier }).optional(),
});

/** The source's dated intro: `pricing` (long tier included) through `until`, the rates it rides on after. */
const Intro = z.strictObject({ until: Day, pricing: Tiered });

const Dated = z.strictObject({ ...Tiered.shape, intro: Intro.optional() });

const Pricing = z.strictObject({
  ...Dated.shape,
  /**
   * The source's dated change (cosmos d74141126e ModelPricing.change): from `from` (a UTC day,
   * inclusive) the WHOLE row bills as `pricing`, long tier and intro included; before it, this row.
   */
  change: z.strictObject({ from: Day, pricing: Dated }).optional(),
});

const Cite = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  retrieved_at: Instant,
  /** Verbatim lines of the page (table padding collapsed). */
  quote: z.array(z.string().min(1)).min(1),
});

const Common = {
  /** The id the row is for; it must match `match`. */
  model: z.string().min(1),
  /** A RegExp source, no flags, tested against the trimmed, effort-stripped, lowercased id. */
  match: z.string().min(1),
  pricing: Pricing,
  why: z.string().min(1),
  cites: z.array(Cite).min(1),
  /** A promotional price the page gives no end date for: in force at least through `through_at_least`. */
  promotion: z.strictObject({ through_at_least: Day, published_end: Day.nullable() }).optional(),
};

/** `anchor`: the pattern the merged row carries in place of `match` (see the header). */
const Replace = z.strictObject({ ...Common, op: z.literal('replace'), was: Pricing, anchor: z.string().min(1).optional() });
/** `before`: the pattern of the row it goes ahead of; null puts it after every row, the source's and the layer's. */
const Insert = z.strictObject({ ...Common, op: z.literal('insert'), before: z.string().min(1).nullable() });
const Fast = z.strictObject({
  ...Common,
  op: z.literal('fast'),
  /** The Standard row's pattern (as the merged table carries it). */
  of: z.string().min(1),
  /** Fast rate ÷ Standard rate, the same for every rate the Fast row carries. */
  multiplier: z.number().gt(1).max(100),
});

/** Ids that bill on an existing row (see the header). */
const Alias = z.strictObject({
  /** The ids as sessions write them; each matches `match` once trimmed and lowercased. */
  ids: z.array(z.string().min(1)).min(1),
  /** A RegExp source, no flags, tested as a row's pattern is. */
  match: z.string().min(1),
  /** The pattern of the row they bill on, as the merged table carries it. */
  of: z.string().min(1),
  why: z.string().min(1),
  /** No page prices these ids: who decided they bill on `of`, and when. */
  stand_in: z.strictObject({ decided_by: z.string().min(1), decided_on: Day, published_price: z.null() }),
});

/**
 * The Fast-mode word in a model id (`gpt-6.1-sol-fast`, Cursor's `gpt-5.5-high-fast`, a router's
 * `gpt-5.4-fast-xhigh`, `gpt-5.5-fast[1m]`, `gpt-5.4-fast(high)`): `-fast` as a whole decoration
 * word. `-ultrafast` and `-fastlane` are not it.
 */
export const FAST_TOKEN = /-fast(?=$|[-[(])/i;

/** The Standard spelling of a `-fast` id (its first fast word dropped), or null when it has none. */
export function standardSpelling(id: string): string | null {
  return FAST_TOKEN.test(id) ? id.replace(FAST_TOKEN, '') : null;
}

/** The UTC day after `day` (YYYY-MM-DD): the first day a row's own rates apply after its intro. */
export function dayAfter(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** "November 21, 2026" for 2026-11-21: how the pages write a day. */
export function pageDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}

export const PricingOverrides = z
  .strictObject({
    schema: z.literal(PRICING_OVERRIDES_SCHEMA),
    rate_unit: z.literal('usd_per_mtok'),
    about: z.string().min(1),
    pages: z.record(z.url({ protocol: /^https$/ }), z.strictObject({ retrieved_at: Instant, sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
    rows: z.array(z.discriminatedUnion('op', [Replace, Insert, Fast])).min(1),
    aliases: z.array(Alias),
  })
  .superRefine((doc, ctx) => {
    const aliased = new Set<string>();
    doc.aliases.forEach((a, i) => {
      const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['aliases', i], message });
      let re: RegExp | null = null;
      try {
        re = new RegExp(a.match);
      } catch (err) {
        issue(`match does not compile: ${(err as Error).message}`);
      }
      for (const id of a.ids) if (re && !re.test(id.trim().toLowerCase())) issue(`${id} does not match its own pattern /${a.match}/`);
      if (aliased.has(a.of)) issue(`/${a.of}/ is aliased twice`);
      aliased.add(a.of);
    });
    const seen = new Set<string>();
    const fastOf = new Map<string, string>();
    const compile = (source: string, what: string, issue: (m: string) => void): RegExp | null => {
      try {
        return new RegExp(source);
      } catch (err) {
        issue(`${what} does not compile: ${(err as Error).message}`);
        return null;
      }
    };
    doc.rows.forEach((row, i) => {
      const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['rows', i], message });
      const re = compile(row.match, 'match', issue);
      if (re && !re.test(row.model)) issue(`${row.model} does not match its own pattern /${row.match}/`);
      if (seen.has(row.match)) issue(`/${row.match}/ is overridden twice`);
      seen.add(row.match);
      if (row.op === 'replace' && row.anchor !== undefined) {
        const anchored = compile(row.anchor, 'anchor', issue);
        if (anchored && !anchored.test(row.model)) issue(`${row.model} does not match its own anchor /${row.anchor}/`);
        if (row.anchor === row.match) issue(`its anchor is its source pattern /${row.match}/`);
        if (seen.has(row.anchor)) issue(`/${row.anchor}/ is overridden twice`);
        seen.add(row.anchor);
      }
      for (const cite of row.cites) {
        const page = doc.pages[cite.url];
        if (!page) issue(`cites ${cite.url}, which pages does not list`);
        else if (page.retrieved_at !== cite.retrieved_at) issue(`cites ${cite.url} as retrieved ${cite.retrieved_at}; pages says ${page.retrieved_at}`);
      }
      if (row.promotion) {
        const { through_at_least: day, published_end: end } = row.promotion;
        const words = pageDay(day);
        if (!row.cites.some((c) => c.quote.some((q) => q.includes(words)))) issue(`promotion runs through ${day}, but no cited line says "${words}"`);
        if (end !== null && end < day) issue(`promotion ends ${end}, before ${day}`);
      }
      const cited = (day: string, what: string) => {
        const words = pageDay(day);
        if (!row.cites.some((c) => c.quote.some((q) => q.includes(words)))) issue(`${what}, but no cited line says "${words}"`);
      };
      const { intro, change } = row.pricing;
      if (intro) cited(dayAfter(intro.until), `its intro ends ${intro.until}`);
      if (change) {
        cited(change.from, `its change starts ${change.from}`);
        if (intro && dayAfter(intro.until) > change.from) issue(`its intro runs through ${intro.until}, past its change on ${change.from}`);
        const next = change.pricing.intro;
        if (next) {
          cited(dayAfter(next.until), `its change's intro ends ${next.until}`);
          if (next.until < change.from) issue(`its change's intro ends ${next.until}, before the change starts on ${change.from}`);
        }
      }
      const standard = standardSpelling(row.model);
      if (row.op !== 'fast') {
        if (standard !== null) issue(`${row.model} is a Fast-mode id; make it op "fast"`);
        return;
      }
      // A Fast row is ambiguous unless it names one Standard row, takes the fast spelling of that
      // model and not its Standard spelling, and is that row's only Fast row.
      if (standard === null || row.model !== row.model.toLowerCase()) {
        issue(`${row.model} is not a lowercase id carrying the fast word (${FAST_TOKEN.source})`);
        return;
      }
      const of = compile(row.of, 'of', issue);
      if (of && !of.test(standard)) issue(`its Standard id ${standard} does not match /${row.of}/`);
      if (re && re.test(standard)) issue(`/${row.match}/ also takes the Standard id ${standard}`);
      const other = fastOf.get(row.of);
      if (other !== undefined) issue(`/${row.of}/ already has a Fast row (${other})`);
      fastOf.set(row.of, row.model);
    });
  });

export type PricingOverridesT = z.infer<typeof PricingOverrides>;
export type OverrideRowT = PricingOverridesT['rows'][number];
export type OverridePricingT = z.infer<typeof Pricing>;
export type OverrideAliasT = PricingOverridesT['aliases'][number];

/** sha256 hex of the override file's bytes, as rows.json records it. */
export function overridesSha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read and validate the override layer. */
export function loadOverrides(file = OVERRIDES_PATH): { doc: PricingOverridesT; sha256: string } {
  const bytes = readFileSync(file);
  const doc = PricingOverrides.parse(JSON.parse(bytes.toString('utf8')));
  return { doc, sha256: overridesSha256(bytes) };
}
