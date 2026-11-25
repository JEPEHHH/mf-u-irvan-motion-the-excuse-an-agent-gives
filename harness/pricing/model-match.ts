// Which pricing row a transcript's model id bills on.
//
// A port of cosmos `baseModelPricing` (src/shared/model-pricing.ts) and the id grammar it reads
// through: `stripEffortSuffix` / `stripProviderPrefix` / `stripAliasGrammar` / `claudeAliasFamily`
// (src/shared/oauth-gateway.ts), `parseClaudeWireModel` (src/shared/model-knobs.ts) and
// `claudeUpstreamId` / `parseGatewayModel` (src/shared/model-gateway.ts). The control flow is
// ported here; every table it consults (family words, decoration words, the provider prefix, the
// gateway ids, and which row each generation-less family shorthand bills on) was read out of the
// source modules by pricing/port-from-cosmos.ts and lives in rows.json, so a re-port carries a
// changed table and pricing_rev covers it. pricing/parity.json holds the source's own answers for
// a probe corpus; tests/unit/pricing.test.ts holds this port to them.

export interface AliasGrammar {
  /** Each generation-less family shorthand and the row its flagship wire id bills on. */
  flagships: Array<{ family: string; model: string; row: number }>;
  /** Family words a router shorthand may spell (`opus`, `fable1m-high`). */
  alias_families: string[];
  /** Families a `claude-<family>-<version>` wire id may name (the shorthand's plus Mythos). */
  wire_families: string[];
  /** Trailing decoration words the shorthand grammar strips (`-fast`, `-xhigh`, `:max`). */
  decoration_words: string[];
  /** Separators a decoration word may follow. */
  decoration_separators: string[];
  /** A router's `vendor:` / `vendor/` routing prefix. */
  provider_prefix: { source: string; flags: string };
  /** Cosmos's own gateway namespaces (`router/…`), stripped before reading a Claude wire id. */
  gateway_ids: string[];
}

export interface CompiledGrammar {
  flagshipRow: ReadonlyMap<string, number>;
  aliasFamilies: ReadonlySet<string>;
  wireFamilies: ReadonlySet<string>;
  decorationTags: readonly string[];
  providerPrefix: RegExp;
  gatewayIds: ReadonlySet<string>;
}

export function compileGrammar(g: AliasGrammar): CompiledGrammar {
  const decorationTags: string[] = [];
  // Word-major, separator-minor: the source's loop order (oauth-gateway.ts stripAliasGrammar).
  for (const word of g.decoration_words) {
    for (const sep of g.decoration_separators) decorationTags.push(`${sep}${word}`);
  }
  return {
    flagshipRow: new Map(g.flagships.map((f) => [f.family, f.row])),
    aliasFamilies: new Set(g.alias_families),
    wireFamilies: new Set(g.wire_families),
    decorationTags,
    providerPrefix: new RegExp(g.provider_prefix.source, g.provider_prefix.flags),
    gatewayIds: new Set(g.gateway_ids),
  };
}

/** Strip a `(level)` effort suffix (oauth-gateway.ts stripEffortSuffix). */
function stripEffortSuffix(modelId: string): string {
  return modelId.replace(/\([^)]*\)$/, '');
}

/** The router's naming grammar down to the name underneath (oauth-gateway.ts stripAliasGrammar). */
function stripAliasGrammar(rawId: string, g: CompiledGrammar): string {
  let id = rawId.trim().replace(g.providerPrefix, '').toLowerCase();
  for (let changed = true; changed; ) {
    changed = false;
    const tagged = id.replace(/\[[^\]]*\]$/, '');
    if (tagged !== id) {
      id = tagged;
      changed = true;
    }
    for (const tag of g.decorationTags) {
      if (id.length > tag.length && id.endsWith(tag)) {
        id = id.slice(0, -tag.length);
        changed = true;
      }
    }
  }
  // `opus1m`: the stem form, which exists only on a family shorthand.
  const stem = /^([a-z]+)1m$/.exec(id);
  if (stem && g.aliasFamilies.has(stem[1]!)) return stem[1]!;
  return id;
}

/** Which Claude family an id names, in shorthand or wire spelling (oauth-gateway.ts claudeAliasFamily). */
function claudeAliasFamily(id: string, g: CompiledGrammar): string | null {
  const bare = stripAliasGrammar(id, g);
  if (g.aliasFamilies.has(bare)) return bare;
  const wire = /^claude-([a-z]+)/.exec(bare);
  return wire && g.wireFamilies.has(wire[1]!) ? wire[1]! : null;
}

/** The slug under a known gateway namespace, else the id (model-gateway.ts upstreamModelId). */
function upstreamModelId(model: string, g: CompiledGrammar): string {
  const slash = model.indexOf('/');
  if (slash <= 0) return model;
  if (!g.gatewayIds.has(model.slice(0, slash))) return model;
  const modelId = model.slice(slash + 1);
  return modelId || model;
}

/**
 * Whether the id carries a Claude generation (model-knobs.ts parseClaudeWireModel's `version`,
 * read through model-gateway.ts claudeUpstreamId). An all-date tail (`claude-opus-20250514`) has
 * none: an 8-digit run is a snapshot date, not a version component.
 */
function hasClaudeVersion(wire: string, g: CompiledGrammar): boolean {
  const upstream = upstreamModelId(wire.trim(), g);
  if (!upstream) return false;
  const bare = upstream.replace(/^~?anthropic\//i, '').replace(/^anthropic:/i, '');
  if (!/^claude-/i.test(bare)) return false;
  const m = /^claude-([a-z]+)((?:[-.]\d+)+)/.exec(bare.replace(/\[[^\]]*\]$/, ''));
  if (!m) return false;
  return m[2]!.split(/[-.]/).some((p) => p !== '' && !/^\d{8}$/.test(p));
}

/**
 * The index of the row `model` bills on, or null when it has none (model-pricing.ts
 * baseModelPricing): the first row whose pattern matches the trimmed, effort-stripped,
 * lowercased id; failing that, a Claude FAMILY named with no generation (`opus`,
 * `anthropic:fable1m-high`, `claude-fable-latest`) bills on its flagship's row. A versioned id no
 * row lists (`claude-opus-6`) and anything that is not Claude stay null.
 */
export function matchRow(model: string, patterns: readonly RegExp[], g: CompiledGrammar): number | null {
  const id = stripEffortSuffix(model.trim()).toLowerCase();
  const listed = patterns.findIndex((p) => p.test(id));
  if (listed >= 0) return listed;
  const family = claudeAliasFamily(id, g);
  if (!family || hasClaudeVersion(id, g)) return null;
  return g.flagshipRow.get(family) ?? null;
}
