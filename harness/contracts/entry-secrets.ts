// Entry secrets: NAME=value pairs an entrant pushes for one competition (a .env file through
// `makefun secrets push`, or a JSON map), never a condition of entering. Each value is HPKE-sealed to
// the grader and opened only by makefun-worker and makefun-grader; values go into our runs of the
// entrant's own code alone, and are erased once the challenge window ends.
//
// This module is the single authority for every rule a name or a value meets, wherever it is checked
// (the browser, the CLI, the web tier, the grader and the gateway forwarder bundle):
//
//   names     ENTRY_SECRET_NAME_RE, case-sensitive, and the reserved names (reservedSecretName), as literals
//   lanes     ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY and GEMINI_API_KEY or GOOGLE_API_KEY are
//             the provider lane (on agent/v1 the gateway forwarder's keys, never in a sandbox); every other
//             name is the env lane (an environment variable of the entry's own sandbox, at our runs of it); a
//             competition whose bundle says env_secrets: false (contracts/competition.ts envSecretsOpen) takes no
//             env-lane name (checkEntrySecrets' envSecrets, ENV_SECRETS_CLOSED_REASON)
//   limits    16 secrets an entrant and competition; a value 8 characters to 8192 bytes of UTF-8 with no
//             NUL; 32 KiB of names and values in all; a pushed .env of 64 KiB and 1,024 lines
//   .env      parseEnvFile's grammar
//   advice    the provider lane's shape warnings (adviseProviderKey); admin and build keys refused
//   hints     what make.fun shows of a value: a provider key's label, an env value's byte length alone
//   seal      the sealed record and its additional authenticated data (agent-fun/entry-secret-seal/v1)
//   state     EntrySecretState, the check ids, the run flags and the zero reason
//   models    which provider serves a model (providerOfModel, providersOfModels)
//
// zod only, no Node APIs: safe for the browser and the forwarder bundle. No problem, warning or error
// here quotes a value, nor a name that failed the name rule (a value pasted where its name belongs).

import { z } from 'zod';
import { IsoDateTime } from './primitives.ts';

// ------------------------------------------------------------------ names

/** The longest name. */
export const ENTRY_SECRET_NAME_MAX_CHARS = 128;

/**
 * A secret's name: an environment variable name every runtime and driver takes (letters, digits and _,
 * not starting with a digit), at most 128 characters. Case-sensitive, as Linux's environment is:
 * `api_key` and `API_KEY` are two secrets.
 */
export const ENTRY_SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const NAME_RULE = 'letters, digits and _, starting with a letter or _, at most 128 characters';

/** A name as ENTRY_SECRET_NAME_RE holds it (the entry_secret table checks the same pattern). */
export const EntrySecretName = z.string().regex(ENTRY_SECRET_NAME_RE, `expected a secret name: ${NAME_RULE}`);
export type EntrySecretName = z.infer<typeof EntrySecretName>;

// ------------------------------------------------------------------ reserved names

// A reserved name is refused (secret_reserved_name) whatever its value: an env-lane secret becomes an
// environment variable of the entry's sandbox, where the sandbox's own processes (the scrape launcher
// runs as root before it drops the entry; the k8s pod's shell wrapper) read it too, and Docker and k8s
// both let a later duplicate win (#3341). A pattern ending in * reserves every name it starts. Matching is
// case-sensitive, as names are. The provider-lane names are on no list: they are the provider lane.

/**
 * Every name the harness sets in a sandbox, so a secret never overrides one: contracts/agent.ts
 * AGENT_ENV_NAMES and AGENT_HOUSE_ENV, grader/sandbox/types.ts SANDBOX_ENV, SPEC_ENV_NAMES and the
 * process driver's MOUNT_POINTS variables, and grader/scrape/launch.ts LAUNCH_BASE_ENV and the rest of
 * launchConfig's entry env, less the provider-lane names (ANTHROPIC_API_KEY, OPENAI_API_KEY). A test
 * holds it equal to those modules' lists.
 */
export const RESERVED_HARNESS_NAMES = Object.freeze([
  // contracts/agent.ts AGENT_ENTRY_ENV and AGENT_GATEWAY_ENV (AGENT_ENV_NAMES)
  'MAKEFUN_PROMPT_FILE',
  'MAKEFUN_SHOP_GRAPHQL_URL',
  'MAKEFUN_SHOP_TOKEN',
  'MAKEFUN_SUPPLIER_URL',
  'MAKEFUN_TRIAL_SEED',
  'MAKEFUN_TRIAL_NOW',
  'MAKEFUN_ENV_URL',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  // contracts/agent.ts AGENT_HOUSE_ENV
  'MAKEFUN_HOUSE_LLM_URL',
  'MAKEFUN_HOUSE_TOKEN',
  // grader/sandbox/types.ts SANDBOX_ENV (and grader/scrape/launch.ts LAUNCH_BASE_ENV, held equal to it)
  'TZ',
  'PYTHONHASHSEED',
  'LANG',
  // grader/sandbox/types.ts MOUNT_POINTS: the process driver's stand-ins for the mounts
  'MAKEFUN_INPUT_DIR',
  'MAKEFUN_OUTPUT_DIR',
  'MAKEFUN_REFERENCE_DIR',
  'MAKEFUN_SCORES_DIR',
  'MAKEFUN_CASSETTE_DIR',
  'MAKEFUN_ENV_DIR',
  'MAKEFUN_ENV_DATA_DIR',
  'MAKEFUN_STATE_DIR',
  'MAKEFUN_CONFIG_DIR',
  'MAKEFUN_RECORD_DIR',
  'MAKEFUN_BASE_DIR',
  'MAKEFUN_TESTS_DIR',
  // grader/scrape/launch.ts launchConfig: the entry env past LAUNCH_BASE_ENV
  'PATH',
  'HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const);

/**
 * Names a program loader, a shell or a language runtime reads before any of the entry's code runs, to
 * load code or change what it trusts. The plan's list, then the same vectors it misses: Python reads
 * every PYTHON* name (PYTHONUSERBASE, PYTHONPLATLIBDIR and PYTHONWARNINGS with BROWSER all run code the
 * entry ships, in the scrape launcher's root Python too), Perl's PERL5OPT, Ruby's RUBYLIB, Java's
 * JDK_JAVA_OPTIONS, glibc's GCONV_PATH and GLIBC_TUNABLES, and bash's SHELLOPTS, BASHOPTS and PS4
 * (xtrace with a PS4 that runs a command).
 */
export const RESERVED_LOADER_NAMES = Object.freeze([
  'LD_*',
  'DYLD_*',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'GEM_HOME',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'CLASSPATH',
  'PERL5LIB',
  'BASH_ENV',
  'ENV',
  'PYTHON*',
  'BROWSER',
  'PERL5OPT',
  'RUBYLIB',
  'JDK_JAVA_OPTIONS',
  'GCONV_PATH',
  'GLIBC_TUNABLES',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
] as const);

/** The system's own names: what the shell, the C library and the locale read. */
export const RESERVED_SYSTEM_NAMES = Object.freeze([
  'PATH',
  'HOME',
  'PWD',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_*',
  'TERM',
  'IFS',
  'PS1',
  'HOSTNAME',
  'TZ',
  'PYTHONHASHSEED',
] as const);

/**
 * Names make.fun, git and CI keep: make.fun's own prefixes, git's and GitHub's, CI and PORT. And
 * __proto__, which a plain JavaScript object cannot hold as a key (an assignment to it sets the
 * object's prototype), so a push map would drop it without a word.
 */
export const RESERVED_PLATFORM_NAMES = Object.freeze(['GIT_*', 'GITHUB_*', 'CI', 'PORT', 'MAKEFUN_*', 'MAKE_*', '__proto__'] as const);

/**
 * Names the sandbox drivers' own processes read or set inside a sandbox (grader/sandbox/k8s.ts and
 * docker.ts), so every driver refuses them alike and a push never takes one only for its grade to fail:
 * k8s.ts EXEC_WRAPPER's and TIMED_EXEC_WRAPPER's n, s and c (a POSIX shell keeps an imported variable
 * exported through an assignment, so a secret named n would hand the program the wrapper's nonce, and with
 * it a forged exit status and CPU reading); KUBERNETES_*, which the kubelet sets and the wrapper unsets;
 * PERL* and LOCPATH, which the pods' root perl helpers and glibc's locale loader read as they start; and
 * the proxy variables the docker CLI sets from its own config after an --env-file's entries, so its value
 * would win over the secret's.
 */
export const RESERVED_SANDBOX_NAMES = Object.freeze([
  'n',
  's',
  'c',
  'KUBERNETES_*',
  'PERL*',
  'LOCPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'FTP_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'ftp_proxy',
  'no_proxy',
  'all_proxy',
] as const);

/** The reserved names by group, in the order reservedSecretName reads them. */
export const RESERVED_SECRET_NAME_GROUPS = Object.freeze({
  harness: RESERVED_HARNESS_NAMES as readonly string[],
  loader: RESERVED_LOADER_NAMES as readonly string[],
  system: RESERVED_SYSTEM_NAMES as readonly string[],
  platform: RESERVED_PLATFORM_NAMES as readonly string[],
  sandbox: RESERVED_SANDBOX_NAMES as readonly string[],
});
export type ReservedNameGroup = keyof typeof RESERVED_SECRET_NAME_GROUPS;
const RESERVED_GROUP_ORDER: readonly ReservedNameGroup[] = ['harness', 'loader', 'system', 'platform', 'sandbox'];

/** Every reserved name and pattern, each once. */
export const RESERVED_SECRET_NAMES: readonly string[] = Object.freeze([...new Set(RESERVED_GROUP_ORDER.flatMap((g) => RESERVED_SECRET_NAME_GROUPS[g]))]);

/** Whether `name` is `pattern`, or starts with a pattern's text before its *. */
function nameMatches(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/** The group and the name or pattern that reserves `name`, or null when nothing does. */
export function reservedSecretName(name: string): { group: ReservedNameGroup; pattern: string } | null {
  for (const group of RESERVED_GROUP_ORDER) {
    for (const pattern of RESERVED_SECRET_NAME_GROUPS[group]) if (nameMatches(pattern, name)) return { group, pattern };
  }
  return null;
}

const RESERVED_WHY: Readonly<Record<ReservedNameGroup, string>> = Object.freeze({
  harness: "make.fun's harness sets it in the entry's sandbox",
  loader: 'a program loader, shell or language runtime reads it before your code runs, to load code or change what it trusts',
  system: 'it is one of the system\'s own variables, which the shell, the C library and the locale read',
  platform: 'make.fun, git or CI keep it for themselves',
  sandbox: "make.fun's sandbox drivers read or set it inside the sandbox themselves",
});

// ------------------------------------------------------------------ providers and lanes

/** The providers whose keys go on the provider lane, in the fixed order every list of them keeps. */
export const SECRET_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;
/**
 * A provider. anthropic and openai are the gateway's vendors (grader/gateway/upstream.ts Vendor); google's and
 * openrouter's models are called on their OpenAI-compatible chat routes.
 */
export const SecretProvider = z.enum(SECRET_PROVIDERS);
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

/** Each provider's name in prose. */
export const SECRET_PROVIDER_NAME: Readonly<Record<SecretProvider, string>> = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
});

/**
 * The provider-lane names and the provider each serves. GEMINI_API_KEY and GOOGLE_API_KEY are both
 * Google's (Google's SDKs read either), and an entrant holds only one of the two at a time.
 */
export const PROVIDER_SECRET_NAMES = Object.freeze({
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  GEMINI_API_KEY: 'google',
  GOOGLE_API_KEY: 'google',
  OPENROUTER_API_KEY: 'openrouter',
} as const satisfies Record<string, SecretProvider>);
export type ProviderSecretName = keyof typeof PROVIDER_SECRET_NAMES;

/** The name each provider's key is pushed under in prose and examples (Google's first of its two). */
export const SECRET_PROVIDER_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
} as const satisfies Record<SecretProvider, ProviderSecretName>);

/** Google's two names, of which an entrant holds one at a time. */
export const GOOGLE_SECRET_NAMES = Object.freeze(['GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const);

/**
 * The two lanes: provider (a model provider's API key: on agent/v1 the gateway forwarder's key for the
 * entry's model calls, never a sandbox's variable) and env (an environment variable of the entry's own
 * sandbox at our runs of it).
 */
export const ENTRY_SECRET_LANES = ['provider', 'env'] as const;
export const EntrySecretLane = z.enum(ENTRY_SECRET_LANES);
export type EntrySecretLane = (typeof ENTRY_SECRET_LANES)[number];

/** The provider whose key `name` names, or null for every env-lane name. */
export function providerOfSecretName(name: string): SecretProvider | null {
  return Object.hasOwn(PROVIDER_SECRET_NAMES, name) ? PROVIDER_SECRET_NAMES[name as ProviderSecretName] : null;
}

/** The lane `name` goes on, with its provider on the provider lane. */
export function secretLane(name: string): { lane: 'provider'; provider: SecretProvider } | { lane: 'env'; provider: null } {
  const provider = providerOfSecretName(name);
  return provider === null ? { lane: 'env', provider: null } : { lane: 'provider', provider };
}

// ------------------------------------------------------------------ limits

/** The most secrets an entrant holds active in one competition, across both lanes. */
export const ENTRY_SECRET_MAX_COUNT = 16;
/** The fewest characters (code points) a value has: anything shorter cannot be masked reliably. */
export const ENTRY_SECRET_VALUE_MIN_CHARS = 8;
/** The fewest UTF-8 bytes a value has (8 characters are at least 8 bytes). */
export const ENTRY_SECRET_VALUE_MIN_BYTES = 8;
/** The most UTF-8 bytes a value has. */
export const ENTRY_SECRET_VALUE_MAX_BYTES = 8192;
/** The most UTF-8 bytes an entrant's active secrets in one competition hold, names and values together. */
export const ENTRY_SECRET_TOTAL_MAX_BYTES = 32 * 1024;
/** The largest .env parseEnvFile reads. */
export const ENV_FILE_MAX_BYTES = 64 * 1024;
/** The most lines a .env parseEnvFile reads has. */
export const ENV_FILE_MAX_LINES = 1024;

const UTF8 = new TextEncoder();

/** `text`'s length in UTF-8 bytes. */
export function utf8Bytes(text: string): number {
  return UTF8.encode(text).length;
}

/** A UTF-16 surrogate with no partner: text no UTF-8 encodes. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** How many code points `text` has, counting no further than `cap`. */
function codePointsUpTo(text: string, cap: number): number {
  let n = 0;
  for (const _ of text) if (++n >= cap) break;
  return n;
}

/**
 * Why `value` is no secret value (check secret_limits), or null when it is one: no NUL, valid UTF-8 (no
 * lone surrogate), at least 8 characters, at most 8192 bytes. Never quotes the value.
 */
export function checkSecretValue(value: unknown): { check: 'secret_limits'; reason: string; fix: string } | null {
  const refuse = (reason: string, fix: string) => ({ check: 'secret_limits' as const, reason, fix });
  if (typeof value !== 'string') return refuse('the value is not text', 'Send each value as a string.');
  if (value.includes('\0')) {
    return refuse('the value holds a NUL character, which no environment variable can carry', 'Remove it, or base64-encode a binary value and decode it in your code.');
  }
  if (LONE_SURROGATE.test(value)) {
    return refuse('the value is not valid UTF-8 text (it holds a lone UTF-16 surrogate)', 'Send the value as UTF-8 text; base64-encode binary data and decode it in your code.');
  }
  if (codePointsUpTo(value, ENTRY_SECRET_VALUE_MIN_CHARS) < ENTRY_SECRET_VALUE_MIN_CHARS) {
    return refuse(
      `the value is under ${ENTRY_SECRET_VALUE_MIN_CHARS} characters: too short for make.fun to mask in what your runs print`,
      `Keep non-secret config in your repo instead: a secret is at least ${ENTRY_SECRET_VALUE_MIN_CHARS} characters.`,
    );
  }
  // A UTF-16 code unit is at least one UTF-8 byte, so a longer string is over the cap unencoded.
  if (value.length > ENTRY_SECRET_VALUE_MAX_BYTES || utf8Bytes(value) > ENTRY_SECRET_VALUE_MAX_BYTES) {
    return refuse(
      `the value is over ${ENTRY_SECRET_VALUE_MAX_BYTES} bytes, the most a secret holds`,
      'Ship large data in your repo encrypted, and push the key that opens it as the secret.',
    );
  }
  return null;
}

// ------------------------------------------------------------------ keys make.fun never holds

/** A make.fun masq build key's prefix (`makefun build-key` exports one as ANTHROPIC_API_KEY and OPENAI_API_KEY). */
export const MASQ_BUILD_KEY_PREFIX = 'sk-masq-';

/**
 * Why make.fun refuses to hold `value` on any lane, or null: an admin key of either vendor
 * (sk-ant-admin…, sk-admin-), which can run the whole organisation (secret_admin_key), or a make.fun
 * masq build key (secret_build_key), which pays for building and never for an entry's runs. These
 * refuse that one secret, never the entry. Never quotes the value.
 */
export function refusedCredential(value: string): { check: 'secret_admin_key' | 'secret_build_key'; reason: string; fix: string } | null {
  const key = value.trimStart();
  if (key.startsWith('sk-ant-admin')) {
    return {
      check: 'secret_admin_key',
      reason: 'this is an Anthropic Admin API key: an admin key can run the whole organisation (its members, workspaces and keys), so make.fun never holds one',
      fix: 'Push a regular API key (sk-ant-api03-…) instead, made in a workspace with a spend limit.',
    };
  }
  if (key.startsWith('sk-admin-')) {
    return {
      check: 'secret_admin_key',
      reason: 'this is an OpenAI admin key: an admin key can run the whole organisation (its projects, members and keys), so make.fun never holds one',
      fix: 'Push a project key (sk-proj-…) instead, made in a project with a budget.',
    };
  }
  if (key.startsWith(MASQ_BUILD_KEY_PREFIX)) {
    return {
      check: 'secret_build_key',
      reason: "this is a make.fun masq build key (makefun build-key's), not your own provider's key: a build key pays for building, never for your entry's runs",
      fix: 'Push the key your provider issued you, from its console, not the one makefun build-key exported.',
    };
  }
  return null;
}

// ------------------------------------------------------------------ provider-lane advice

/** The longest text read as a provider key: no provider's key is that long. */
export const PROVIDER_KEY_MAX_CHARS = 256;

// The shapes are prefixes, never exact lengths, from gitleaks' default rules (anthropic-api-key,
// openai-api-key, gcp-api-key, openrouter-api-key), each with the key's alphabet and length bounds (at least 40
// characters past the prefix, Google's standard key's 35 exactly, OpenRouter's 64 lowercase hex), and one entropy
// floor of 2 bits a character over the body, which refuses placeholders. Google has two kinds of Gemini API key
// (aistudio.google.com/docs/api-key, read 2026-11-07): the older standard key, AIza and 35 more, and the
// auth key AI Studio has made since 2026-05-28, AQ. and 50 more (osv-scalibr
// veles/secrets/gcpexpressmode). OpenRouter's keys are sk-or-v1- and 64 lowercase hex (its API reference's authentication
// page, read 2026-11-14). The provider is the authority on a key: on this lane a shape is advice,
// a warning in the answer, never a refusal.
const KEY_SHAPES: Readonly<Record<SecretProvider, readonly RegExp[]>> = Object.freeze({
  anthropic: [/^sk-ant-api\d{2}-([A-Za-z0-9_-]{40,})$/],
  openai: [/^sk-(?:proj|svcacct|None)-([A-Za-z0-9_-]{40,})$/, /^sk-([A-Za-z0-9]{40,})$/],
  google: [/^AIza([A-Za-z0-9_-]{35})$/, /^AQ\.([A-Za-z0-9_-]{40,})$/],
  openrouter: [/^sk-or-v1-([a-f0-9]{64})$/],
});
/** The fewest bits a character the part of a key past its prefix carries. */
const MIN_BODY_ENTROPY = 2;
/** base64 of "OpenAI": OpenAI's keys carry it, so it marks an sk- key as OpenAI's; no shape requires it. */
const OPENAI_MARK = 'T3BlbkFJ';

/**
 * The provider whose key prefix `text` carries, or null: sk-ant- is Anthropic's, AIza and AQ. Google's,
 * sk-or-v1- OpenRouter's, and sk-proj-, sk-svcacct-, sk-None-, sk-admin- or an sk- key with T3BlbkFJ in it
 * OpenAI's. A prefix only: the key may still be of the wrong shape.
 */
export function detectKeyProvider(text: string): SecretProvider | null {
  const key = text.trim();
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('AIza') || key.startsWith('AQ.')) return 'google';
  if (key.startsWith('sk-or-v1-')) return 'openrouter';
  if (['sk-proj-', 'sk-svcacct-', 'sk-None-', 'sk-admin-'].some((p) => key.startsWith(p))) return 'openai';
  if (key.startsWith('sk-') && key.includes(OPENAI_MARK)) return 'openai';
  return null;
}

/** Shannon entropy in bits per character, as gitleaks computes a rule's `entropy`. */
function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether `key` has one of `provider`'s shapes (KEY_SHAPES), its body past the entropy floor. */
function hasProviderShape(provider: SecretProvider, key: string): boolean {
  return KEY_SHAPES[provider].some((shape) => {
    const body = shape.exec(key)?.[1];
    return body !== undefined && shannonEntropy(body) >= MIN_BODY_ENTROPY;
  });
}

/** Where each provider's keys are made, and what one looks like. */
const SHAPE_HELP: Readonly<Record<SecretProvider, { reason: string; fix: string }>> = Object.freeze({
  anthropic: {
    reason: 'this does not look like an Anthropic API key: one starts sk-ant-api03- and goes on for at least 40 more letters, digits, _ and -',
    fix: 'Push the whole key from the API keys page of the Anthropic Console (it is shown once, when it is made), with nothing around it.',
  },
  openai: {
    reason: "this does not look like an OpenAI API key: one starts sk-proj- (a project key) or sk-svcacct- (a service account's) and goes on for at least 40 more letters, digits, _ and -",
    fix: 'Push the whole key from the API keys page of the OpenAI dashboard (it is shown once, when it is made), with nothing around it.',
  },
  google: {
    reason:
      'this does not look like a Gemini API key: one starts AQ. and goes on for 50 more letters, digits, _ and - (an auth key, the kind Google AI Studio makes), or starts AIza and goes on for 35 more (an older standard key)',
    fix: 'Push the whole key from the API keys page of Google AI Studio, with nothing around it.',
  },
  openrouter: {
    reason: 'this does not look like an OpenRouter API key: one starts sk-or-v1- and goes on for 64 lowercase hex characters',
    fix: 'Push the whole key from the Keys page of OpenRouter (it is shown once, when it is made), with nothing around it.',
  },
});

/** A provider's name after "a" or "an". */
const withArticle = (name: string): string => `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}`;

/** A Claude subscription's sign-in tokens (access and refresh): not API keys. */
const CLAUDE_SIGN_IN_TOKEN = /^sk-ant-o(?:at|rt)\d/;

/** Why a provider-lane value may not work, as a warning: never a refusal. */
export const PROVIDER_KEY_WARNING_CAUSES = ['whitespace', 'other_provider', 'sign_in_token', 'shape'] as const;
export type ProviderKeyWarningCause = (typeof PROVIDER_KEY_WARNING_CAUSES)[number];

/**
 * A warning in a push's answer: the secret is stored, but its value may not work. `detected` is the
 * provider whose key prefix the value carries, when one does. Never quotes the value.
 */
export const EntrySecretWarning = z.strictObject({
  name: EntrySecretName,
  cause: z.enum(PROVIDER_KEY_WARNING_CAUSES),
  detected: SecretProvider.nullable(),
  reason: z.string().min(1),
  fix: z.string().min(1),
});
export type EntrySecretWarning = z.infer<typeof EntrySecretWarning>;

/**
 * Advice on a provider-lane value, by its shape alone (nothing is sent anywhere): whitespace around
 * it; another provider's key prefix; a Claude sign-in token; not the provider's shape (KEY_SHAPES), or
 * longer than any key. Every piece is a warning: the provider decides whether a key is real, and its
 * pre-flight (grader/gateway/providers.ts checkProviderKey) is the advisory check the state shows. An
 * env-lane name, an admin or build key (refusedCredential) and a value too short to hold (checkSecretValue)
 * get none.
 */
export function adviseProviderKey(name: string, value: string): EntrySecretWarning[] {
  const provider = providerOfSecretName(name);
  if (provider === null || refusedCredential(value) !== null || checkSecretValue(value) !== null) return [];
  const label = SECRET_PROVIDER_NAME[provider];
  const out: EntrySecretWarning[] = [];
  const warn = (cause: ProviderKeyWarningCause, detected: SecretProvider | null, reason: string, fix: string): void => {
    out.push({ name, cause, detected, reason, fix });
  };
  const key = value.trim();
  const detected = detectKeyProvider(key);
  if (key !== value) {
    warn('whitespace', detected, `the value has spaces or line breaks around it, which ${label} would refuse in a key`, 'Push the key alone, with nothing around it.');
  }
  if (key.length > PROVIDER_KEY_MAX_CHARS) {
    warn('shape', null, `this is longer than any API key (at most ${PROVIDER_KEY_MAX_CHARS} characters)`, SHAPE_HELP[provider].fix);
    return out;
  }
  if (detected !== null && detected !== provider) {
    const other = SECRET_PROVIDER_NAME[detected];
    warn(
      'other_provider',
      detected,
      `this looks like ${withArticle(other)} key, not ${withArticle(label)} one: ${name} goes to ${label}`,
      `Push it as ${SECRET_PROVIDER_ENV[detected]} instead, and your ${label} key as ${name}.`,
    );
    return out;
  }
  if (!hasProviderShape(provider, key)) {
    if (provider === 'anthropic' && CLAUDE_SIGN_IN_TOKEN.test(key)) {
      warn(
        'sign_in_token',
        detected,
        'this looks like a Claude sign-in token, not an API key: a Claude subscription does not pay for API calls',
        `Make an API key on the API keys page of the Anthropic Console and push that as ${name}.`,
      );
    } else {
      warn('shape', detected, SHAPE_HELP[provider].reason, SHAPE_HELP[provider].fix);
    }
  }
  return out;
}

// ------------------------------------------------------------------ hints

/**
 * The key prefixes a provider-lane hint keeps, most specific first. A Google auth key's AQ. is none of
 * them, so an auth key's hint is its last 4 characters alone (…k3_Z).
 */
export const PROVIDER_HINT_PREFIXES = ['sk-ant-api03-', 'sk-svcacct-', 'sk-proj-', 'sk-or-v1-', 'AIza', 'sk-'] as const;
/** How many of a key's last characters its hint shows. */
export const PROVIDER_HINT_TAIL = 4;
/** The fewest characters past the prefix a text must have before its hint shows any of them. */
const HINT_MIN_REST = 20;
const HINT_TAIL_CHARS = /^[A-Za-z0-9_-]{4}$/;

/**
 * A provider key's hint: its known prefix (PROVIDER_HINT_PREFIXES, else none),
 * an ellipsis and its last 4 characters (sk-ant-api03-…AbAA, sk-proj-…x9Q2, sk-or-v1-…f00d, AIza…k3_Z), and
 * nothing more. A text with fewer than 20 characters past its prefix, or a tail outside a key's alphabet, shows
 * no tail at all.
 */
export function providerKeyHint(text: string): string {
  const key = text.trim();
  const prefix = PROVIDER_HINT_PREFIXES.find((p) => key.startsWith(p)) ?? '';
  const rest = key.slice(prefix.length);
  const tail = rest.slice(-PROVIDER_HINT_TAIL);
  const shown = rest.length >= HINT_MIN_REST && HINT_TAIL_CHARS.test(tail) ? tail : '';
  return `${prefix}…${shown}`;
}

/**
 * What make.fun shows of a secret's value: on the provider lane its key's hint (providerKeyHint), on
 * the env lane nothing at all (''), its byte length (EntrySecretState.bytes) the only thing shown.
 */
export function entrySecretHint(name: string, value: string): string {
  return providerOfSecretName(name) === null ? '' : providerKeyHint(value);
}

const PROVIDER_HINT_RE = /^(?:sk-ant-api03-|sk-svcacct-|sk-proj-|sk-or-v1-|AIza|sk-)?…(?:[A-Za-z0-9_-]{4})?$/;

/** A provider-lane hint as providerKeyHint makes it: never more of a key than its prefix and last 4 characters. */
export const ProviderKeyHint = z.string().regex(PROVIDER_HINT_RE, 'expected a provider key hint: a key prefix, … and at most the last 4 characters');

/** A hint on either lane: a provider key's hint, or '' (an env-lane value shows none of its characters). */
export const EntrySecretHint = z.union([z.literal(''), ProviderKeyHint]);
export type EntrySecretHint = z.infer<typeof EntrySecretHint>;

// ------------------------------------------------------------------ problems and checks

/**
 * The problem check ids entry secrets answer with:
 * - secret_env_parse: a .env line parseEnvFile does not read (EnvFileProblem);
 * - secret_name: a pushed name that is not a secret name (ENTRY_SECRET_NAME_RE);
 * - secret_reserved_name: a reserved name (reservedSecretName);
 * - secret_limits: a value or a set past the limits, or both of Google's names, or an env-lane name pushed to a
 *   competition that takes no environment secrets (checkEntrySecrets' envSecrets);
 * - secret_admin_key, secret_build_key: a key make.fun never holds (refusedCredential);
 * - secret_shared: a provider key another account holds active in the competition;
 * - secret_rate_limited: too many pushes;
 * - committed_secret: a submitted value found in the entry's repository (any commit's files or message:
 *   make.fun publishes the whole history), on every harness: the one place a value refuses an entry. A
 *   transcript holding one is masked or withheld, never refused; a run whose outputs held one keeps its
 *   score while those outputs are withheld (SECRET_IN_OUTPUT_FLAG);
 * - committed_provider_key: a provider key's shape in an agent/v1 entry's tree (server/repos/intake.ts),
 *   whichever provider's.
 * None asks for a secret: pushing one is never a condition of entering.
 */
export const ENTRY_SECRET_CHECK_IDS = [
  'secret_env_parse',
  'secret_name',
  'secret_reserved_name',
  'secret_limits',
  'secret_admin_key',
  'secret_build_key',
  'secret_shared',
  'secret_rate_limited',
  'committed_secret',
  'committed_provider_key',
] as const;
export const EntrySecretCheckId = z.enum(ENTRY_SECRET_CHECK_IDS);
export type EntrySecretCheckId = (typeof ENTRY_SECRET_CHECK_IDS)[number];

/**
 * One refusal of a push: the secret's name (null for a name that failed the name rule, which may be a
 * value pasted in its place, and for a limit of the whole set), its check, why and the fix. Never a value.
 */
export const EntrySecretProblem = z.strictObject({
  name: EntrySecretName.nullable(),
  check: EntrySecretCheckId,
  reason: z.string().min(1),
  fix: z.string().min(1),
});
export type EntrySecretProblem = z.infer<typeof EntrySecretProblem>;

/** A pushed secret that passed every check, as make.fun records and shows it. */
export interface CheckedEntrySecret {
  name: string;
  lane: EntrySecretLane;
  provider: SecretProvider | null;
  hint: string;
  bytes: number;
}

/** What checkEntrySecrets makes of a push. */
export interface EntrySecretsCheck {
  ok: boolean;
  problems: EntrySecretProblem[];
  warnings: EntrySecretWarning[];
  /** The pushed secrets that passed, in push order. */
  secrets: CheckedEntrySecret[];
}

/** An English ordinal: 1st, 2nd, 3rd, 4th, 11th, 21st. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** Why `name` may not be pushed (secret_name or secret_reserved_name), or null. `position` is its place in the push, 1-based. */
export function checkSecretName(name: string, position = 1): EntrySecretProblem | null {
  if (typeof name !== 'string' || !ENTRY_SECRET_NAME_RE.test(name)) {
    return {
      name: null,
      check: 'secret_name',
      reason: `the ${ordinal(position)} name pushed is not a secret name: a name is ${NAME_RULE}`,
      fix: 'Rename it (MY_SERVICE_TOKEN, say): names like my-key or key.json are not environment variable names. If it is a value, push it under a name.',
    };
  }
  const reserved = reservedSecretName(name);
  if (reserved !== null) {
    const every = reserved.pattern.endsWith('*') ? ` (every ${reserved.pattern} name is reserved)` : '';
    return {
      name,
      check: 'secret_reserved_name',
      reason: `${name} is a reserved name${every}: ${RESERVED_WHY[reserved.group]}`,
      fix: "Rename it (prefix it with your project's name, say) and read the new name in your code.",
    };
  }
  return null;
}

/**
 * Why a competition that takes no environment secrets (its bundle's env_secrets: false, contracts/competition.ts
 * envSecretsOpen) refuses an env-lane name: the rule, in words naming no value.
 */
export const ENV_SECRETS_CLOSED_REASON =
  "this competition takes no environment secrets: an entry's code and data live in its repository, where they are counted and reviewed";

/** What a push refused under ENV_SECRETS_CLOSED_REASON is told to do. */
const ENV_SECRETS_CLOSED_FIX = `Remove it from the push, and commit what your entry reads to its repository instead (a value that must stay secret has no place in this competition). A model provider's key (${Object.keys(PROVIDER_SECRET_NAMES).join(', ')}) is no environment variable, and is still taken: on an agent competition, the key your entry's model calls run on.`;

/** What checkEntrySecrets weighs besides the push and the account's active secrets: the competition's own rules. */
export interface EntrySecretsCheckOptions {
  /**
   * Whether the competition takes env-lane secrets (contracts/competition.ts envSecretsOpen of its bundle). False: every
   * env-lane name pushed is refused (secret_limits, ENV_SECRETS_CLOSED_REASON). Absent or true: the env lane is open.
   */
  envSecrets?: boolean;
}

/**
 * Check a push, a `{NAME: value}` map, against every rule here, with the entrant's other active
 * secrets in the competition (`active`: those the push leaves as they are, by name and value bytes; a
 * name the push also holds is the push's). Per secret, in push order: its name (secret_name,
 * secret_reserved_name), on a competition that takes no environment secrets (`opts.envSecrets` false)
 * an env-lane name (secret_limits, ENV_SECRETS_CLOSED_REASON: refused whatever its value, which is not
 * read further), its value (secret_limits), then a key make.fun never holds (secret_admin_key,
 * secret_build_key); a provider-lane secret that passes gets its advice as warnings. Then the set the
 * push would leave: at most 16 secrets, at most 32 KiB of names and values, and one of Google's two
 * names (secret_limits, `name` null, or the Google name pushed). ok when no problem: the push is stored
 * whole or not at all. secret_shared and secret_rate_limited need the database: the store checks them.
 */
export function checkEntrySecrets(push: Readonly<Record<string, string>>, active: readonly { name: string; bytes: number }[] = [], opts: EntrySecretsCheckOptions = {}): EntrySecretsCheck {
  const envClosed = opts.envSecrets === false;
  const problems: EntrySecretProblem[] = [];
  const warnings: EntrySecretWarning[] = [];
  const secrets: CheckedEntrySecret[] = [];
  const pushed = Object.entries(push);
  let position = 0;
  for (const [name, value] of pushed) {
    position++;
    const nameProblem = checkSecretName(name, position);
    if (nameProblem !== null) problems.push(nameProblem);
    if (nameProblem === null && envClosed && providerOfSecretName(name) === null) {
      problems.push({ name, check: 'secret_limits', reason: `${name} is an environment variable, and ${ENV_SECRETS_CLOSED_REASON}`, fix: ENV_SECRETS_CLOSED_FIX });
      continue;
    }
    const known = nameProblem === null || nameProblem.check === 'secret_reserved_name' ? name : null;
    const limits = checkSecretValue(value);
    if (limits !== null) {
      problems.push({ name: known, ...limits });
      continue;
    }
    const credential = refusedCredential(value);
    if (credential !== null) {
      problems.push({ name: known, ...credential });
      continue;
    }
    if (nameProblem !== null) continue;
    warnings.push(...adviseProviderKey(name, value));
    const { lane, provider } = secretLane(name);
    secrets.push({ name, lane, provider, hint: entrySecretHint(name, value), bytes: utf8Bytes(value) });
  }

  // The set the push leaves: the push's names, and the active secrets it does not name.
  const pushedNames = new Set(pushed.map(([name]) => name));
  const kept = active.filter((s) => !pushedNames.has(s.name));
  const count = pushedNames.size + kept.length;
  if (count > ENTRY_SECRET_MAX_COUNT) {
    problems.push({
      name: null,
      check: 'secret_limits',
      reason: `this push would leave ${count} secrets in this competition: an entrant holds at most ${ENTRY_SECRET_MAX_COUNT}`,
      fix: 'Remove the secrets you no longer use (makefun secrets rm <slug> <NAME>), or keep related values in one secret.',
    });
  }
  let total = 0;
  for (const [name, value] of pushed) total += utf8Bytes(name) + (typeof value === 'string' ? utf8Bytes(value) : 0);
  for (const s of kept) total += utf8Bytes(s.name) + s.bytes;
  if (total > ENTRY_SECRET_TOTAL_MAX_BYTES) {
    problems.push({
      name: null,
      check: 'secret_limits',
      reason: `this push would leave ${total} bytes of names and values in this competition: at most ${ENTRY_SECRET_TOTAL_MAX_BYTES} (32 KiB)`,
      fix: 'Ship large data in your repo encrypted, and push the key that opens it as the secret.',
    });
  }
  const google = GOOGLE_SECRET_NAMES.filter((n) => pushedNames.has(n) || kept.some((s) => s.name === n));
  if (google.length > 1) {
    const mine = GOOGLE_SECRET_NAMES.filter((n) => pushedNames.has(n));
    problems.push({
      name: mine.length === 1 ? (mine[0] ?? null) : null,
      check: 'secret_limits',
      reason: 'GEMINI_API_KEY and GOOGLE_API_KEY would both be set: both name your Google key, and an entrant holds one of the two',
      fix: 'Push your Google key under one of the two names, and remove the other (makefun secrets rm <slug> GOOGLE_API_KEY).',
    });
  }
  return { ok: problems.length === 0, problems, warnings, secrets };
}

// ------------------------------------------------------------------ the .env grammar

/**
 * One secret read from a .env: its name, its value and the line its name is on (1-based). A name set
 * twice is the later line's (an EnvFileWarning names both).
 */
export interface EnvFileEntry {
  name: string;
  value: string;
  line: number;
}

/** A .env text parseEnvFile does not read: its line (null: the file as a whole), why and the fix. Never a value. */
export const EnvFileProblem = z.strictObject({
  line: z.int().min(1).nullable(),
  check: z.literal('secret_env_parse'),
  reason: z.string().min(1),
  fix: z.string().min(1),
});
export type EnvFileProblem = z.infer<typeof EnvFileProblem>;

/** A name a .env sets twice: the later line's value is the one read. */
export const EnvFileWarning = z.strictObject({
  line: z.int().min(1),
  earlier_line: z.int().min(1),
  name: EntrySecretName,
  reason: z.string().min(1),
  fix: z.string().min(1),
});
export type EnvFileWarning = z.infer<typeof EnvFileWarning>;

/** What parseEnvFile makes of a .env: its entries, or every problem it found. */
export type EnvFileParse = { ok: true; entries: EnvFileEntry[]; warnings: EnvFileWarning[] } | { ok: false; problems: EnvFileProblem[]; warnings: EnvFileWarning[] };

/** The escapes a double-quoted value takes; any other backslash stays as it is, with what follows it. */
const DOUBLE_QUOTED_ESCAPES: Readonly<Record<string, string>> = Object.freeze({ n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', $: '$' });

/** The characters a name's token stops at. */
const NAME_STOP = new Set(['=', ':', ' ', '\t', '#', '\n']);

const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t';

/** UTF-8 that refuses a malformed byte, and keeps a BOM for parseEnvFile to strip. */
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** `bytes` as text, or the first line (1-based, by LF) that is not valid UTF-8. */
function decodeUtf8(bytes: Uint8Array): string | number {
  try {
    return FATAL_UTF8.decode(bytes);
  } catch {
    let line = 1;
    let start = 0;
    for (let k = 0; k <= bytes.length; k++) {
      if (k < bytes.length && bytes[k] !== 0x0a) continue;
      try {
        FATAL_UTF8.decode(bytes.subarray(start, k));
      } catch {
        return line;
      }
      line++;
      start = k + 1;
    }
    return line;
  }
}

const PARSE = Object.freeze({
  tooBig: {
    reason: `the file is over ${ENV_FILE_MAX_BYTES} bytes (64 KiB), the largest .env make.fun reads`,
    fix: 'Push only the secrets this competition needs; keep the rest of your config in your repo.',
  },
  tooLong: {
    reason: `the file is over ${ENV_FILE_MAX_LINES} lines, the most a .env make.fun reads has`,
    fix: 'Push only the secrets this competition needs; keep the rest of your config in your repo.',
  },
  notUtf8: { reason: 'this line is not valid UTF-8 text', fix: 'Save the file as UTF-8.' },
  noName: { reason: 'this line has no name before its =', fix: 'Write each secret as NAME=value.' },
  colon: { reason: 'this line puts a : between its name and its value', fix: 'Write NAME=value: = is the only delimiter make.fun reads.' },
  bareWord: {
    reason: 'this line holds a word with no = after it: a name with no value, or a value with no name',
    fix: 'Write NAME=value, or delete the line.',
  },
  textBeforeEquals: {
    reason: 'this line has a space inside its name, or other text between its name and its =',
    fix: 'A name is one word of letters, digits and _: write NAME=value.',
  },
  badName: {
    reason: `this line's name is not a secret name: a name is ${NAME_RULE}`,
    fix: 'Rename it (MY_SERVICE_TOKEN, say): names like my-key or key.json are not environment variable names.',
  },
  unclosed: {
    reason: 'the quoted value that starts on this line has no closing quote',
    fix: 'Close the quote: a quoted value may span lines, so an unclosed one runs to the end of the file.',
  },
  afterQuote: {
    reason: 'there is text after the closing quote on this line',
    fix: 'Put the whole value inside the quotes: only a # comment may follow them.',
  },
  backtick: {
    reason: 'this value is in backticks, which make.fun does not read as quotes',
    fix: "Use single quotes, which keep a value exactly, or double quotes (with \\n, \\t, \\\\ and \\\" escapes).",
  },
  backtickBare: {
    reason: 'this unquoted value holds a backtick, which shells and .env loaders read differently',
    fix: 'Put the value in single quotes, which keep it exactly.',
  },
  hash: {
    reason: 'this unquoted value holds a # with no space before it: some .env loaders cut the value there, others keep it',
    fix: 'Put the value in quotes (single quotes keep it exactly).',
  },
  carriageReturn: {
    reason: 'this line holds a carriage return that does not end it',
    fix: 'Save the file with LF or CRLF line endings, or put the value in quotes.',
  },
});

/**
 * Read a .env (text, or bytes that must be UTF-8) into its secrets, or into every problem it holds
 * (check secret_env_parse, each at its line; none quotes a value or a name). The grammar, measured
 * against dotenv 17.4.2 and Node's util.parseEnv (#3340's probes) and refusing wherever the two, or
 * a shell sourcing the file, would read a line differently:
 * - UTF-8 at most 64 KiB and 1,024 lines; a leading BOM is stripped; LF and CRLF both end a line, and a
 *   carriage return anywhere else outside quotes is refused.
 * - Blank lines and lines whose first non-blank character is # are skipped; `export ` before a name is
 *   stripped. Blanks around the name and the = are allowed.
 * - A name follows the name rule; a : delimiter, a word with no =, and text between a name and its =
 *   are refused.
 * - A bare value runs to the end of its line and is trimmed. Blank space followed by # starts a comment;
 *   a # with no blank before it is refused (quote it), and so is a backtick.
 * - A single-quoted value is literal and may span lines.
 * - A double-quoted value may span lines and takes the escapes \n \r \t \\ \" \$ alone; any other \x
 *   stays as it is, backslash and all.
 * - A backtick-quoted value is refused. Nothing is interpolated ($HOME stays $HOME). After a closing
 *   quote only blanks and a # comment may follow.
 * - A name set twice is the later line's, with a warning naming both lines.
 * The names and values read here are not yet checked against the reserved names or the limits:
 * checkEntrySecrets does that.
 */
export function parseEnvFile(input: string | Uint8Array): EnvFileParse {
  const problems: EnvFileProblem[] = [];
  const warnings: EnvFileWarning[] = [];
  const refuse = (line: number | null, p: { reason: string; fix: string }): void => {
    problems.push({ line, check: 'secret_env_parse', reason: p.reason, fix: p.fix });
  };
  const failed = (): EnvFileParse => ({ ok: false, problems, warnings });

  // A UTF-16 code unit is at least one UTF-8 byte, so a longer string is over the cap unencoded.
  const tooBig = typeof input === 'string' ? input.length > ENV_FILE_MAX_BYTES || utf8Bytes(input) > ENV_FILE_MAX_BYTES : input.byteLength > ENV_FILE_MAX_BYTES;
  if (tooBig) {
    refuse(null, PARSE.tooBig);
    return failed();
  }
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    const decoded = decodeUtf8(input);
    if (typeof decoded === 'number') {
      refuse(decoded, PARSE.notUtf8);
      return failed();
    }
    text = decoded;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');
  const physical = text.split('\n');
  const lineCount = physical.length - (physical.at(-1) === '' ? 1 : 0);
  if (lineCount > ENV_FILE_MAX_LINES) {
    refuse(null, PARSE.tooLong);
    return failed();
  }
  physical.forEach((l, k) => {
    if (LONE_SURROGATE.test(l)) refuse(k + 1, PARSE.notUtf8);
  });
  if (problems.length > 0) return failed();

  const entries = new Map<string, EnvFileEntry>();
  const n = text.length;
  const endOfLine = (from: number): number => {
    const k = text.indexOf('\n', from);
    return k === -1 ? n : k;
  };
  let i = 0;
  let line = 1;
  while (i < n) {
    while (isBlank(text[i])) i++;
    if (i >= n) break;
    if (text[i] === '\n') {
      i++;
      line++;
      continue;
    }
    if (text[i] === '#') {
      i = endOfLine(i);
      continue;
    }
    const start = line;
    if (text.startsWith('export', i) && isBlank(text[i + 6])) {
      i += 6;
      while (isBlank(text[i])) i++;
    }
    const nameStart = i;
    while (i < n && !NAME_STOP.has(text[i] as string)) i++;
    const name = text.slice(nameStart, i);
    while (isBlank(text[i])) i++;
    const delimiter = text[i];
    if (delimiter !== '=') {
      if (delimiter === ':') refuse(start, PARSE.colon);
      else if (name === '') refuse(start, PARSE.noName);
      else if (delimiter === undefined || delimiter === '\n' || delimiter === '#') refuse(start, PARSE.bareWord);
      else refuse(start, PARSE.textBeforeEquals);
      i = endOfLine(i);
      continue;
    }
    // The name is checked now, and the value read whatever it is, so a multi-line value is skipped whole.
    if (name === '') refuse(start, PARSE.noName);
    else if (!ENTRY_SECRET_NAME_RE.test(name)) refuse(start, PARSE.badName);
    const named = name !== '' && ENTRY_SECRET_NAME_RE.test(name);
    i++;
    const blankAfterEquals = isBlank(text[i]);
    while (isBlank(text[i])) i++;

    let value: string | null = null;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const c = text[j] as string;
        if (c === quote) {
          closed = true;
          break;
        }
        if (c === '\n') line++;
        if (quote === '"' && c === '\\' && j + 1 < n) {
          const escape = text[j + 1] as string;
          if (Object.hasOwn(DOUBLE_QUOTED_ESCAPES, escape)) {
            out += DOUBLE_QUOTED_ESCAPES[escape];
            j += 2;
            continue;
          }
        }
        out += c;
        j++;
      }
      if (!closed) {
        refuse(start, PARSE.unclosed);
        break;
      }
      i = j + 1;
      while (isBlank(text[i])) i++;
      if (i < n && text[i] !== '\n' && text[i] !== '#') {
        refuse(line, PARSE.afterQuote);
        i = endOfLine(i);
        continue;
      }
      if (text[i] === '#') i = endOfLine(i);
      value = out;
    } else if (quote === '`') {
      refuse(start, PARSE.backtick);
      // Skip to the closing backtick, if there is one, and the rest of its line.
      const close = text.indexOf('`', i + 1);
      const to = endOfLine(close === -1 ? i : close);
      for (let k = i; k < to; k++) if (text[k] === '\n') line++;
      i = to;
      continue;
    } else {
      const end = endOfLine(i);
      const raw = text.slice(i, end);
      i = end;
      let cut = raw.length;
      let bad: { reason: string; fix: string } | null = null;
      for (let k = 0; k < raw.length; k++) {
        const c = raw[k];
        if (c === '#') {
          if (k === 0 ? blankAfterEquals : isBlank(raw[k - 1])) cut = k;
          else bad = PARSE.hash;
          break;
        }
        if (c === '`') {
          bad = PARSE.backtickBare;
          break;
        }
        if (c === '\r') {
          bad = PARSE.carriageReturn;
          break;
        }
      }
      if (bad !== null) {
        refuse(start, bad);
        continue;
      }
      value = raw.slice(0, cut).replace(/[ \t]+$/, '');
    }
    if (!named) continue;
    const earlier = entries.get(name);
    if (earlier !== undefined) {
      warnings.push({
        line: start,
        earlier_line: earlier.line,
        name,
        reason: `${name} is set on line ${earlier.line} and again on line ${start}: line ${start}'s value is the one read`,
        fix: 'Delete the line you do not mean.',
      });
      entries.delete(name);
    }
    entries.set(name, { name, value, line: start });
  }
  if (problems.length > 0) return failed();
  return { ok: true, entries: [...entries.values()], warnings };
}

// ------------------------------------------------------------------ the sealed record

/** The sealed record's format, also the HPKE info and the first field of its additional authenticated data. */
export const ENTRY_SECRET_SEAL_FORMAT = 'agent-fun/entry-secret-seal/v1';

/**
 * The HPKE suite v1 seals with (RFC 9180 base mode): DHKEM(X25519, HKDF-SHA256),
 * HKDF-SHA256 and AES-256-GCM, sealed to the grader's public key.
 */
export const ENTRY_SECRET_SEAL_SUITE = Object.freeze({ kem: 0x0020, kdf: 0x0001, aead: 0x0002 } as const);

/** The encapsulated key's length: an X25519 public key. */
export const ENTRY_SECRET_SEAL_ENC_BYTES = 32;
/** The AEAD tag's length, which every ciphertext carries after the sealed bytes. */
export const ENTRY_SECRET_SEAL_TAG_BYTES = 16;
/** The shortest ciphertext: the shortest value (ENTRY_SECRET_VALUE_MIN_BYTES) plus its tag. */
export const ENTRY_SECRET_SEAL_MIN_CT_BYTES = ENTRY_SECRET_VALUE_MIN_BYTES + ENTRY_SECRET_SEAL_TAG_BYTES;
/** The longest ciphertext: the longest value (ENTRY_SECRET_VALUE_MAX_BYTES) plus its tag. */
export const ENTRY_SECRET_SEAL_MAX_CT_BYTES = ENTRY_SECRET_VALUE_MAX_BYTES + ENTRY_SECRET_SEAL_TAG_BYTES;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** How many bytes canonical unpadded base64url `s` holds, or null when it is not that (padding, a stray character, a length no bytes make, set unused bits). */
function base64UrlBytes(s: string): number | null {
  if (!BASE64URL.test(s) || s.length % 4 === 1) return null;
  const rem = s.length % 4;
  if (rem !== 0) {
    const last = BASE64URL_ALPHABET.indexOf(s.charAt(s.length - 1));
    if ((last & (rem === 2 ? 0x0f : 0x03)) !== 0) return null;
  }
  return Math.floor((s.length * 3) / 4);
}

function base64UrlOf(min: number, max: number, what: string) {
  const message = `expected ${what}: unpadded base64url of ${min === max ? `${min} bytes` : `${min} to ${max} bytes`}`;
  return z
    .string()
    .max(Math.ceil((max * 4) / 3), { error: message, abort: true })
    .refine((s) => {
      const n = base64UrlBytes(s);
      return n !== null && n >= min && n <= max;
    }, message);
}

/** A sealing key's id: the first 16 hex of the sha256 of its raw X25519 public key. */
export const EntrySecretSealKid = z.string().regex(/^[0-9a-f]{16}$/, 'expected a seal key id: 16 lowercase hex');

/**
 * A value sealed to the grader: format, the sealing key's id (kid), HPKE's encapsulated key (enc) and
 * the ciphertext of the value's UTF-8 bytes with its tag (ct), both unpadded base64url. Opened only
 * under the additional authenticated data entrySecretAad makes for its row; the web tier never holds
 * the private key.
 */
export const SealedEntrySecret = z.strictObject({
  format: z.literal(ENTRY_SECRET_SEAL_FORMAT),
  kid: EntrySecretSealKid,
  enc: base64UrlOf(ENTRY_SECRET_SEAL_ENC_BYTES, ENTRY_SECRET_SEAL_ENC_BYTES, 'an encapsulated X25519 key'),
  ct: base64UrlOf(ENTRY_SECRET_SEAL_MIN_CT_BYTES, ENTRY_SECRET_SEAL_MAX_CT_BYTES, 'a ciphertext with its tag'),
});
export type SealedEntrySecret = z.infer<typeof SealedEntrySecret>;

// ------------------------------------------------------------------ the additional authenticated data

/** A uuid as Postgres prints it: lowercase and hyphenated, so the AAD's bytes are the same on both sides. */
const LowerUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lowercase hyphenated uuid');

/**
 * What a sealed value is bound to: the seal format, its owner, its competition, its name and its
 * entry_secret row. A sealed record moved to another row, user, competition or name does not open.
 */
export const EntrySecretAad = z.strictObject({
  format: z.literal(ENTRY_SECRET_SEAL_FORMAT),
  user_id: z.string().min(1).max(256),
  competition_id: LowerUuid,
  name: EntrySecretName,
  entry_secret_id: LowerUuid,
});
export type EntrySecretAad = z.infer<typeof EntrySecretAad>;

/** The fields entrySecretAad binds; the format is always ENTRY_SECRET_SEAL_FORMAT. */
export type EntrySecretAadFields = Omit<EntrySecretAad, 'format'>;

/**
 * The canonical additional authenticated data as text: JSON of format, user_id, competition_id, name
 * and entry_secret_id in that order, no whitespace. Throws on fields EntrySecretAad refuses.
 */
export function entrySecretAadText(fields: EntrySecretAadFields): string {
  const a = EntrySecretAad.parse({ ...fields, format: ENTRY_SECRET_SEAL_FORMAT });
  return JSON.stringify({ format: a.format, user_id: a.user_id, competition_id: a.competition_id, name: a.name, entry_secret_id: a.entry_secret_id });
}

/** The canonical additional authenticated data's bytes (UTF-8 of entrySecretAadText): what seal and open both pass HPKE. */
export function entrySecretAad(fields: EntrySecretAadFields): Uint8Array {
  return UTF8.encode(entrySecretAadText(fields));
}

// ------------------------------------------------------------------ the stored secret's state

/**
 * A stored secret's status: active (the one in use for its user, competition and name, the only one a
 * run gets), replaced (a newer value took its place) or deleted (its owner removed it), or purged (its
 * ciphertext erased at the competition's end or on an account merge). A replaced or deleted row reaches
 * no run from then on and is erased at once, unless a final-phase run of the entrant's ran with it: then
 * it keeps its ciphertext, sealed for a challenge's re-run of that run, until the competition's challenge
 * window closes, when the retention purge erases it and leaves its status as it was.
 */
export const ENTRY_SECRET_STATUSES = ['active', 'replaced', 'deleted', 'purged'] as const;
export const EntrySecretStatus = z.enum(ENTRY_SECRET_STATUSES);
export type EntrySecretStatus = (typeof ENTRY_SECRET_STATUSES)[number];

/**
 * A provider-lane value's advisory check, on the route that answers for the credential itself: the
 * provider's key route where it has one (grader/gateway/providers.ts PROVIDER_ROUTES keyCheck,
 * OpenRouter's GET /api/v1/key), else its models list (GET /v1/models, Google's GET /v1beta/models).
 * Valid (a key record, or every models-list page, answered 2xx), refused (it refused the key),
 * unreachable (no answer, or one that is neither a key record nor a models list) or unchecked (never
 * asked: past the pre-flight budget). Never a refusal of the push. A check's route must be one that
 * refuses a request without the credential (tests/unit/gateway-provider-keycheck-public.test.ts holds
 * it): a route a provider answers to anyone lists no key of the caller's and proves nothing about one.
 */
export const PROVIDER_KEY_CHECK_STATES = ['valid', 'refused', 'unreachable', 'unchecked'] as const;
export const ProviderKeyCheckState = z.enum(PROVIDER_KEY_CHECK_STATES);
export type ProviderKeyCheckState = (typeof PROVIDER_KEY_CHECK_STATES)[number];

/** An exact model id a provider listed (contracts/competition.ts ModelId's characters). */
const ListedModel = z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/, 'expected a model id');

const stateBase = {
  name: EntrySecretName,
  bytes: z.int().min(ENTRY_SECRET_VALUE_MIN_BYTES).max(ENTRY_SECRET_VALUE_MAX_BYTES),
  status: EntrySecretStatus,
  added_at: IsoDateTime,
  used_at: IsoDateTime.nullable(),
};

const ProviderSecretState = z
  .strictObject({
    ...stateBase,
    lane: z.literal('provider'),
    provider: SecretProvider,
    hint: ProviderKeyHint,
    check: ProviderKeyCheckState,
    checked_at: IsoDateTime.nullable(),
    listed_models: z.array(ListedModel).max(256),
  })
  .refine((s) => providerOfSecretName(s.name) === s.provider, { error: "expected the provider the secret's name serves", path: ['provider'] })
  .refine((s) => (s.check === 'unchecked') === (s.checked_at === null), { error: 'expected checked_at exactly when the key was checked', path: ['checked_at'] })
  .refine((s) => s.check === 'valid' || s.listed_models.length === 0, { error: 'expected listed models only from a valid key', path: ['listed_models'] });

const EnvSecretState = z
  .strictObject({
    ...stateBase,
    lane: z.literal('env'),
    provider: z.null(),
    hint: z.literal(''),
  })
  .refine((s) => providerOfSecretName(s.name) === null, { error: 'expected an env-lane name', path: ['name'] });

/**
 * What make.fun shows of a stored secret, and all it shows: its name, lane, provider (null on the env
 * lane), hint, value byte length, status, when it was added and last used by a run, and on the provider
 * lane the advisory check, when it was made and the allowlisted models the check listed then (none
 * from a key-record check: its route names the key, not a list). Never a value, a ciphertext or a
 * fingerprint.
 */
export const EntrySecretState = z.discriminatedUnion('lane', [ProviderSecretState, EnvSecretState]);
export type EntrySecretState = z.infer<typeof EntrySecretState>;

// ------------------------------------------------------------------ flags and reasons

/** The run flag (run.flags) a run carries while a trial waits for its entrant to replace a provider key the provider refused. */
export const ENTRY_SECRET_HELD_FLAG = 'entry_secret_held';

/** The run flag a run carries when a submitted value turned up in what it output (scanned, never masked: outputs are scored byte for byte). */
export const SECRET_IN_OUTPUT_FLAG = 'secret_in_output';

/** The reason a trial scores zero when its entrant's provider key stayed refused past the hold. */
export const PROVIDER_KEY_REFUSED = 'provider_key_refused';

// ------------------------------------------------------------------ which provider serves a model

// masq's provider prefixes on a model id, as grader/gateway/upstream.ts PROVIDER_PREFIX (:209) strips
// them (masq src/models.ts PROVIDER_PREFIX): routing, never which model it is.
const MASQ_PROVIDER_PREFIX = /^(?:anthropic|claude|openai|xai|x-ai|grok|google|gemini|meta)[:/]|^(?:openrouter|groq|compat|local):|^router[/:]/;

/** Each provider's model families: a model id belongs to one when it starts with the family's head. */
const MODEL_FAMILIES: readonly { provider: SecretProvider; prefix: string; digit?: true }[] = [
  { provider: 'anthropic', prefix: 'claude-' },
  { provider: 'openai', prefix: 'gpt-' },
  { provider: 'openai', prefix: 'chatgpt-' },
  /** o1, o3-mini, o4-mini…: an o and a digit. */
  { provider: 'openai', prefix: 'o', digit: true },
  { provider: 'google', prefix: 'gemini-' },
  /** OpenRouter's ids keep the vendor and model: openrouter/<vendor>/<model>, a free model's with :free. */
  { provider: 'openrouter', prefix: 'openrouter/' },
];

/** A model id or glob, lowercased and trimmed, with a masq provider prefix off. */
function bareModel(id: string): string {
  return id.trim().toLowerCase().replace(MASQ_PROVIDER_PREFIX, '');
}

function familyHolds(f: (typeof MODEL_FAMILIES)[number], id: string): boolean {
  return f.digit ? id.startsWith(f.prefix) && /\d/.test(id.charAt(f.prefix.length)) : id.startsWith(f.prefix);
}

/** Whether some model id starting with `head` belongs to family `f`. */
function familyReachable(f: (typeof MODEL_FAMILIES)[number], head: string): boolean {
  if (familyHolds(f, head)) return true;
  // head is shorter than the family's head: some id it starts can still be one (`c` → claude-…).
  return f.digit ? head === '' || head === f.prefix : f.prefix.startsWith(head);
}

/**
 * The provider whose key serves `model`: claude-* Anthropic; gpt-*, chatgpt-* and o<digit>* OpenAI;
 * gemini-* Google; openrouter/* OpenRouter (its ids keep the vendor and model, and a free one carries
 * :free); anything else (superbot-fast, which only masq serves, included) null. Case and a masq provider
 * prefix (anthropic/, openai:, router/…) do not matter.
 */
export function providerOfModel(model: string): SecretProvider | null {
  const id = bareModel(model);
  return MODEL_FAMILIES.find((f) => familyHolds(f, id))?.provider ?? null;
}

/**
 * The providers whose keys serve an allowlist's models (AgentInference.models), each once, in
 * SECRET_PROVIDERS' order. A glob's literal head (up to its first * or ?) decides: the providers of
 * every family a model id starting with that head can belong to, so claude-* is Anthropic, c* is
 * Anthropic and OpenAI (claude-…, chatgpt-…), openrouter/* is OpenRouter, and *-mini, with no head,
 * every provider. An exact id is providerOfModel's answer; one no provider serves adds none.
 */
export function providersOfModels(globs: readonly string[]): SecretProvider[] {
  const found = new Set<SecretProvider>();
  for (const glob of globs) {
    const id = bareModel(glob);
    const wild = id.search(/[*?]/);
    if (wild === -1) {
      const p = providerOfModel(id);
      if (p !== null) found.add(p);
      continue;
    }
    const head = id.slice(0, wild);
    for (const f of MODEL_FAMILIES) if (familyReachable(f, head)) found.add(f.provider);
  }
  return SECRET_PROVIDERS.filter((p) => found.has(p));
}
