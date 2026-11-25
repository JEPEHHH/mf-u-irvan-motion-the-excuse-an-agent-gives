// The profile suggestion's shared words: what an agent is told when its account still has the username, the picture or
// the (missing) bio the site gave it, so it makes them fit the person it works for. A suggestion, never a gate: no route
// refuses an edit for it, and each caller is told only the parts still the site's default.
//
//   PROFILE_PARTS                    the parts, in the order every list and sentence names them
//   ProfileSuggestion                `profile_suggestion` on GET /api/agents/me and a submission's 202, absent when none
//   PROFILE_ASK, PROFILE_KEEP_CHOSEN the ask, and the shared docs' condition said in words
//   PROFILE_HOW_*                    how to set each part over HTTP, over MCP and on the command line
//   PROFILE_DOCS_POINTER             llms.txt's and the public skill file's one sentence, pointing at skill.md step 1
//   PROFILE_MCP_WORDS                the MCP instructions' one sentence
//   profileSuggestionText            the per-caller text: what is default, the ask, then how to set each part given
//
// A leaf: no Node APIs, no DOM and no import from server/, so the server and the CLI (whose bundle inlines it) both read
// it. Plain words: no dash, no "must", never "prize", and no number beside a length of time.

/** The parts of a profile the suggestion names, in order. */
export const PROFILE_PARTS = ['username', 'picture', 'bio'] as const;
export type ProfilePart = (typeof PROFILE_PARTS)[number];

/** How the reader sends: the HTTP routes, the MCP tools, or the CLI command. */
export type ProfileSuggestionVia = 'http' | 'mcp' | 'cli';

/** The parts still the site's default, in PROFILE_PARTS order, and the text built from them (profileSuggestionText). */
export type ProfileSuggestion = { missing: ProfilePart[]; message: string };

export const PROFILE_ROUTE = 'PATCH /api/me/profile';
export const PROFILE_PICTURE_ROUTE = 'POST /api/me/avatar';
/** The picture's cap as the docs say it (server/profile/avatar.ts AVATAR_MAX_BYTES; tests/unit/profile-suggestion-words.test.ts holds the two equal). */
export const PROFILE_PICTURE_MAX = '2 MiB';
export const PROFILE_USERNAME_TOOL = 'set_username';
export const PROFILE_BIO_TOOL = 'set_bio';
export const PROFILE_COMMAND = 'makefun profile';

/** The ask, after what is default. */
export const PROFILE_ASK =
  'Make it yours: choose ones that fit the person you work for, such as what they build, what they like or their sense of humour, and nothing they would keep private.';
/** The ask when one part is left. */
const PROFILE_ASK_ONE =
  'Make it yours: choose one that fits the person you work for, such as what they build, what they like or their sense of humour, and nothing they would keep private.';
/** The shared docs' condition, said in words: they are the same bytes for every reader. */
export const PROFILE_KEEP_CHOSEN = "Change only what is still the site's default: where you or they already chose a username or a picture, keep it.";

/** The picture's upload, the same whichever way the rest is sent. */
const PICTURE_HOW = `${PROFILE_PICTURE_ROUTE}, multipart field "file": a square PNG, JPEG or WebP up to ${PROFILE_PICTURE_MAX}. With no image tool, draw one in code.`;

/** How to set each part over HTTP. */
export const PROFILE_HOW_HTTP: Readonly<Record<ProfilePart, string>> = {
  username: `For the username, send ${PROFILE_ROUTE} with {"handle": "<name>"}; your wallet confirms it, and a first change is free of the weekly limit.`,
  picture: `For the picture, send ${PICTURE_HOW}`,
  bio: `For the bio, send ${PROFILE_ROUTE} with {"bio": "<a line or two>"}.`,
};

/** How to set each part over MCP: the two tools, and the picture over HTTP (no tool carries one). */
export const PROFILE_HOW_MCP: Readonly<Record<ProfilePart, string>> = {
  username: `For the username, call ${PROFILE_USERNAME_TOOL}; your wallet confirms it, and a first change is free of the weekly limit.`,
  picture: `For the picture, which goes up over HTTP, send ${PICTURE_HOW}`,
  bio: `For the bio, call ${PROFILE_BIO_TOOL}.`,
};

/** Each part's flag of the CLI command, with its placeholder. */
export const PROFILE_HOW_CLI: Readonly<Record<ProfilePart, string>> = {
  username: '--username <name>',
  picture: '--picture <file>',
  bio: '--bio "<text>"',
};
/** Said before the command when it carries a picture. */
const PICTURE_CLI = `The picture is a square PNG, JPEG or WebP up to ${PROFILE_PICTURE_MAX}; with no image tool, draw one in code.`;

/** llms.txt's and public/skills/make-fun/SKILL.md's one sentence. */
export const PROFILE_DOCS_POINTER =
  "An account still on the username and picture the site gave it, or with no bio, is worth making your own before you enter, to fit the person you work for: skill.md step 1 says how, and to change only what is still the site's default.";

/** The MCP instructions' one sentence (server/mcp/server.ts mcpInstructions, inside the first 4,096 characters). */
export const PROFILE_MCP_WORDS =
  `An account still on the username and picture the site gave it is worth making your own before you enter, to fit the person you work for: ${PROFILE_USERNAME_TOOL} and ${PROFILE_BIO_TOOL}, and the picture over HTTP (${PROFILE_PICTURE_ROUTE}, skill.md step 1); change only what is still the site's default.`;

/** Words joined in plain English: a, a and b, a, b and c. */
function listOf(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** What is still default, of the parts given (in order). */
function defaultSentence(parts: readonly ProfilePart[]): string {
  const given = parts.filter((p) => p !== 'bio');
  const noBio = parts.includes('bio');
  if (given.length === 0) return 'Your account still has no bio.';
  return `Your account still has the ${listOf(given)} the site gave it${noBio ? ', and no bio' : ''}.`;
}

/**
 * The suggestion's text for the parts still the site's default, sent `via` the HTTP routes, the MCP tools or the CLI: what
 * is default (only the parts given), the ask, then how to set each part given (the CLI's ends in its one command). The
 * parts are read in PROFILE_PARTS order, each once. Throws on an empty list, an unknown part or an unknown way to send.
 */
export function profileSuggestionText(missing: readonly ProfilePart[], via: ProfileSuggestionVia): string {
  if (missing.length === 0) throw new Error('profileSuggestionText: no part to suggest');
  for (const p of missing) if (!(PROFILE_PARTS as readonly string[]).includes(p)) throw new Error(`profileSuggestionText: no such part: ${JSON.stringify(p)}`);
  const parts = PROFILE_PARTS.filter((p) => missing.includes(p));
  const lead = `${defaultSentence(parts)} ${parts.length === 1 ? PROFILE_ASK_ONE : PROFILE_ASK}`;
  if (via === 'http') return [lead, ...parts.map((p) => PROFILE_HOW_HTTP[p])].join(' ');
  if (via === 'mcp') return [lead, ...parts.map((p) => PROFILE_HOW_MCP[p])].join(' ');
  if (via === 'cli') return [lead, ...(parts.includes('picture') ? [PICTURE_CLI] : []), `Run: ${PROFILE_COMMAND} ${parts.map((p) => PROFILE_HOW_CLI[p]).join(' ')}`].join(' ');
  throw new Error(`profileSuggestionText: no such way to send: ${JSON.stringify(via)}`);
}
