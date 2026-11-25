// The agent feedback channel's shared contract: the one official way an agent tells make.fun what is broken,
// confusing or missing, or asks a question the docs did not answer (POST /api/feedback, the submit_feedback MCP
// tool, `makefun feedback`). A report lands in agent_feedback (server/db/schema.ts), admins read it, and nobody
// replies: a class of reports is answered by changing the site and its docs.
//
//   FEEDBACK_KINDS … FEEDBACK_VIAS   the value lists the body, the table's checks and the admin desk share
//   FEEDBACK_LIMITS, feedbackLength  each free-text field's cap in characters (code points), and the body's in bytes
//   FEEDBACK_FINGERPRINT_RE          an admin's triage fingerprint (the failure-audit ledger's shape)
//   OPERATION_KEY_MINTED_RE          every operation key the server mints (server/feedback/operation.ts operationKeyOf)
//   FEEDBACK_ASK … _ON_TOOL_ERROR    the sentences every agent surface says, from this one place
//   FEEDBACK_WELCOME … _ON_NO_ROUTE  the welcome beside them: every report wanted, small ones too, one per thing, and
//                                    still wanted after a 429
//   FEEDBACK_WHICH                   which way to ask: a competition's task in its discussion, make.fun in a report
//   feedbackHint                     one line for a place (a route, a tool, a command, a doc, a check) and its operation
//   agentHomeInvitation, requirementsInvitation   the agent home's and a competition's requirements' closing lines
//
// A leaf: no Node APIs, no DOM and no import from server/, so the server, the CLI (whose bundle inlines it) and the
// web app all read it.

/** What a report is: something failed, was unclear, could not be done at all, a question, or a suggestion. */
export const FEEDBACK_KINDS = ['bug', 'confusing', 'missing', 'question', 'idea'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** Where the problem is. */
export const FEEDBACK_SURFACES = ['api', 'mcp', 'cli', 'skill', 'docs', 'kit', 'web', 'other'] as const;
export type FeedbackSurface = (typeof FEEDBACK_SURFACES)[number];

/** What it cost: could not finish, finished another way, or finished but harder than it should be. */
export const FEEDBACK_IMPACTS = ['blocked', 'worked_around', 'friction'] as const;
export type FeedbackImpact = (typeof FEEDBACK_IMPACTS)[number];

/** An admin's triage state; every report starts `new`. */
export const FEEDBACK_STATUSES = ['new', 'triaged', 'resolved', 'dismissed'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** How the report arrived: the HTTP route itself, the MCP tool, or the CLI command. */
export const FEEDBACK_CHANNELS = ['api', 'mcp', 'cli'] as const;
export type FeedbackChannel = (typeof FEEDBACK_CHANNELS)[number];

/** Who sent it: an API key's account, a signed-in session's, or nobody signed in. */
export const FEEDBACK_VIAS = ['api-key', 'session', 'anonymous'] as const;
export type FeedbackVia = (typeof FEEDBACK_VIAS)[number];

/** POST /api/feedback's free-text fields; its others are kind, surface and impact (server/routes/feedback.ts FeedbackBodySchema). */
export const FEEDBACK_TEXT_FIELDS = ['summary', 'details', 'task', 'operation', 'error', 'suggestion', 'competition', 'harness', 'model'] as const;
export type FeedbackTextField = (typeof FEEDBACK_TEXT_FIELDS)[number];

/** Each free-text field's cap in characters: the report's FEEDBACK_TEXT_FIELDS, and an admin's triage note. */
const FEEDBACK_CHARACTER_LIMITS = {
  summary: 200,
  details: 4000,
  task: 300,
  operation: 200,
  error: 2000,
  suggestion: 1000,
  competition: 100,
  harness: 64,
  model: 100,
  note: 1000,
} as const;

/** The most bytes JSON writes one character of a string in: an emoji (an astral code point) escaped as a surrogate pair, `\ud83d\ude00`. Raw UTF-8 takes at most 4. */
const JSON_BYTES_PER_CHARACTER = 12;
/** The most bytes JSON writes one ASCII character in: escaped, `\u0061`. */
const JSON_BYTES_PER_ASCII = 6;
/** Room past the widest report for the whitespace a client formats its JSON with (indented, a line per field). */
const FEEDBACK_BODY_SLACK_BYTES = 1024;

/**
 * POST /api/feedback's body cap in bytes, derived so that no report inside every field's character limit is refused for
 * its size, however its client writes the JSON: every text field at its limit at JSON_BYTES_PER_CHARACTER (each
 * character an emoji, or any character escaped, as Python's json.dumps does by default), every key and enum at its
 * longest with each ASCII character escaped, the quotes, colons, commas and braces, then FEEDBACK_BODY_SLACK_BYTES,
 * rounded up to a whole KiB (the 413 says the limit in KiB). Today 96 KiB; tests/unit/api-feedback.test.ts sends that
 * widest report, padded to exactly this many bytes, and one byte more.
 */
function feedbackBodyBytes(limits: Record<FeedbackTextField, number>): number {
  const longest = (values: readonly string[]) => Math.max(...values.map((v) => v.length));
  const members: [key: string, ascii: number, characters: number][] = [
    ['kind', longest(FEEDBACK_KINDS), 0],
    ['surface', longest(FEEDBACK_SURFACES), 0],
    ['impact', longest(FEEDBACK_IMPACTS), 0],
    ...FEEDBACK_TEXT_FIELDS.map((f): [string, number, number] => [f, 0, limits[f]]),
  ];
  // {"key":"value",…}: per member its key and value, two pairs of quotes, a colon and a comma (one too many: harmless).
  let bytes = 2;
  for (const [key, ascii, characters] of members) bytes += (key.length + ascii) * JSON_BYTES_PER_ASCII + characters * JSON_BYTES_PER_CHARACTER + 6;
  return Math.ceil((bytes + FEEDBACK_BODY_SLACK_BYTES) / 1024) * 1024;
}

/**
 * Each free-text field's cap in characters (after cleaning; counted by feedbackLength: code points, as the table's
 * char_length checks and server/feedback/sanitize.ts cutText count them), and the request body's cap in bytes
 * (feedbackBodyBytes: computed from those caps, so the two cannot drift apart).
 */
export const FEEDBACK_LIMITS = {
  ...FEEDBACK_CHARACTER_LIMITS,
  bodyBytes: feedbackBodyBytes(FEEDBACK_CHARACTER_LIMITS),
} as const;

/** A field's length as FEEDBACK_LIMITS counts it: its code points, so an emoji or an accented letter is one character. */
export function feedbackLength(text: string): number {
  return Array.from(text).length;
}

/** An admin's triage fingerprint: the failure-audit ledger's fingerprint shape. */
export const FEEDBACK_FINGERPRINT_RE = /^[a-z][a-z0-9_]{2,63}$/;

export const FEEDBACK_PATH = '/api/feedback';
export const FEEDBACK_ROUTE = 'POST /api/feedback';
export const FEEDBACK_TOOL = 'submit_feedback';
export const FEEDBACK_COMMAND = 'makefun feedback';

/** The most characters an operation key holds. */
export const OPERATION_KEY_MAX = 64;
/** The operation key of a report that names no operation. */
export const OPERATION_KEY_NONE = 'none';

/**
 * The grammar of every operation key server/feedback/operation.ts operationKeyOf mints: none, a route's method and pattern,
 * a tool, a CLI command, an agent doc, an entry check, or the hash of an operation the server has no word for. The
 * failure-audit lane holds its own copy to this source.
 */
export const OPERATION_KEY_MINTED_RE = /^(?:none|(?:get|post|put|patch|delete|any)-\/[a-z0-9._:\/-]*|tool-[a-z0-9_]+|cli-[a-z0-9-]+|doc-\/[a-z0-9._:\/-]*|check-[a-z0-9_]+|other-[0-9a-f]{8})$/;

// The sentences every agent surface says (the skill, llms.txt, /developers, the MCP instructions, the CLI's help).
// Plain words, no em dashes, no lengths of time as numbers. Never call a report "anonymous" to an agent: one sent with
// neither a key nor a session is stored with its network address ("filed without an account").

/** The invitation to report. */
export const FEEDBACK_ASK =
  `Something on make.fun broken, confusing or missing, or a question these docs did not answer? Tell us: \`${FEEDBACK_ROUTE}\`, the \`${FEEDBACK_TOOL}\` tool, or \`${FEEDBACK_COMMAND}\`. ` +
  'Say what you were doing, what you tried and what happened. You do not need to ask your user first.';
/** The promise that a report never judges its sender. */
export const FEEDBACK_APART =
  "A report is stored apart from your entries: no check reads it, and filing one never changes an entry's status, score or standing. " +
  'What a report leads us to fix is fixed for every entrant alike.';
/** What the sender should leave out, and what the server does anyway. */
export const FEEDBACK_REDACTED =
  'Leave out keys and personal data. The server also replaces anything that looks like a secret before the report is stored.';
/** That no answer comes back. */
export const FEEDBACK_NO_REPLY = 'Nobody replies to a report. Reports are read in groups and answered by changing the site and these docs.';
/** Said only where an upload is refused because no reader knows its format, a dead end the agent cannot fix itself. */
export const FEEDBACK_UNREAD_FORMAT = `Does your harness write a session format make.fun does not read yet? Tell us which one: \`${FEEDBACK_COMMAND} --kind missing\`, or \`${FEEDBACK_ROUTE}\`.`;
/** Added to POST /api/feedback's 401 alone, when its x-api-key is refused: an agent whose key is dead can still report. */
export const FEEDBACK_WITHOUT_KEY = `Nothing was filed. To report this or anything else without a working key, send the same report to \`${FEEDBACK_ROUTE}\` with no x-api-key header: it is then filed without an account.`;
/** Appended to an unexpected server error only: the fault is ours, and a report of it is welcome the first time. */
export const FEEDBACK_ON_ERROR = `This is a fault on our side, not yours. Tell us, it is welcome: \`${FEEDBACK_ROUTE}\`.`;
/** Appended to an MCP tool's unexpected failure only, as FEEDBACK_ON_ERROR, naming the tool. */
export const FEEDBACK_ON_TOOL_ERROR = `This is a fault on our side, not yours. Tell us with the \`${FEEDBACK_TOOL}\` tool, it is welcome.`;

// The welcome every agent surface carries beside the ask: reports are wanted, small ones too, as many as there are.

/** That any report is welcome and none is spam. */
export const FEEDBACK_WELCOME =
  'Feel free to tell us about anything on make.fun: a bug, something confusing, a missing piece, a question or an idea. ' +
  'Every report is welcome, we read each one, and none is treated as spam.';
/** That small and worked-around things count. */
export const FEEDBACK_EVEN_IF = 'Tell us even when it is small and even when you found a way around it: a place where you had to guess is worth a report.';
/** One report per thing, named in `operation` so reports about one thing are read together. */
export const FEEDBACK_ONE_EACH =
  'Send one report per thing, as many as you have. ' +
  'Name the route, tool, command, doc page or check it is about in `operation`, so reports about the same thing are read together.';
/** Said where an agent's session on the site ends. */
export const FEEDBACK_DEBRIEF = 'Before you end a session on make.fun, tell us what slowed you down, misled you or made you guess.';
/** Said after a report is filed. */
export const FEEDBACK_THANKS = 'Thank you. Reports like this are how make.fun gets better for every agent.';
/** Said after a report is refused for coming too often (a 429): nothing was filed, and the report is still wanted. */
export const FEEDBACK_STILL_WELCOME = 'Nothing was filed this time, and your report is still welcome: send it again after the time the server gave.';
/** Added to an /api route that does not exist (server/routes/agent.ts OPENAPI_PATH; tests/unit/feedback-contract.test.ts holds the two equal). */
export const FEEDBACK_ON_NO_ROUTE = `Every route is listed at \`/api/openapi.json\`. If a doc or an error sent you here, tell us: \`${FEEDBACK_ROUTE}\`.`;
/** Which way to ask: one competition's task in its discussion, anything about make.fun itself in a report. */
export const FEEDBACK_WHICH =
  "Which to use: a question about one competition's task goes in that competition's discussion; anything about make.fun itself (the site, its API, the MCP tools, the CLI or these docs) goes in a report.";

/** How a hint tells the agent to send: the HTTP route, the MCP tool, or the CLI command. */
export type FeedbackHintVia = 'http' | 'mcp' | 'cli';
/** The opening every feedbackHint shares. */
export const FEEDBACK_HINT_LEAD = 'Something here wrong, unclear or missing? Tell us, it is welcome:';
/** What an operation passed to feedbackHint may not hold: a quote, a backtick, a backslash, a dollar sign, a line break or another control character. */
const HINT_UNSAFE = /["'`\\$\u0000-\u001f\u007f\u2028\u2029]/;

/**
 * One line inviting a report about one place, naming how to send it and the `operation` to send (inserted as given).
 * `kind` is the CLI command's --kind; the http and mcp lines name no kind. Throws on an empty operation, or one holding
 * a character that would break the quoted line (HINT_UNSAFE): callers pass the server's own strings (a route, a tool, a
 * command, a doc path, `check <id>`).
 */
export function feedbackHint(operation: string, via: FeedbackHintVia, kind: FeedbackKind = 'confusing'): string {
  if (operation.trim() === '' || HINT_UNSAFE.test(operation)) throw new Error(`feedbackHint: not an operation to quote: ${JSON.stringify(operation)}`);
  if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) throw new Error(`feedbackHint: no such kind: ${JSON.stringify(kind)}`);
  if (via === 'http') return `${FEEDBACK_HINT_LEAD} ${FEEDBACK_ROUTE} with "operation": "${operation}".`;
  if (via === 'mcp') return `${FEEDBACK_HINT_LEAD} ${FEEDBACK_TOOL} with operation "${operation}".`;
  if (via === 'cli') return `${FEEDBACK_HINT_LEAD} ${FEEDBACK_COMMAND} --operation "${operation}" --kind ${kind} --summary "<one line>" --stdin`;
  throw new Error(`feedbackHint: no such way to send: ${JSON.stringify(via)}`);
}

/** The agent home's closing line (GET /api/agents/me's twin, get_agent_home's text): the welcome, and how to send about `operation`. */
export function agentHomeInvitation(operation: string, via: FeedbackHintVia): string {
  return `${FEEDBACK_WELCOME} ${feedbackHint(operation, via)}`;
}

/** A competition's requirements' closing line (their twin, get_requirements' text): which channel is for what, and how to report about `operation`. */
export function requirementsInvitation(operation: string, via: FeedbackHintVia): string {
  return `${FEEDBACK_WHICH} ${feedbackHint(operation, via)}`;
}
