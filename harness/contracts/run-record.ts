// The run record: what a reviewer needs to recreate an entry's run and check that it is real, beside the
// sessions that show the run itself. Four parts:
//   prompt         the person's own opening prompt, word for word (never an agent's summary, hand-off or brief),
//                  with how it reached the agent (RUN_PROMPT_ORIGINS) and, unless they typed it, what started it
//   system_prompt  where the system prompt the agent ran under is: uploaded as a context file, carried in a
//                  session, held by a harness make.fun trusts to keep it (a session that harness ran as its own
//                  agent stands for it), or (in a record from before the full-context cutoff) withheld with a
//                  one-line reason
//   instructions   whether the instruction files the agent ran under (CLAUDE.md, AGENTS.md, rules, skills, settings:
//                  a bundle's context files of every kind but system-prompt) are collected in the upload, the agent
//                  ran with none, or (before the cutoff) they are withheld with a one-line reason; optional, since a
//                  kit below level 14 (cli/version.ts INSTRUCTIONS_KIT_LEVEL) writes no such field and its records
//                  still parse
//   mcp_servers    every MCP server the agent used: its name as the agent's tool list shows it and how to reach it
//                  again (a URL, or a launch command and package), or builtin for one shipped inside the harness
// The rest of the system setup (harness and version, provider, model, effort) is the agent facts, BundleDeclared,
// defined here and kept in a bundle's manifest.declared (contracts/bundle.ts re-exports it). A bundle carries the
// record as manifest.run (contracts/bundle.ts); a loose upload, which has no manifest, carries it as one more file
// named LOOSE_RUN_FILE_NAME holding a LooseRunFile: the record plus the agent facts under `declared`.
//
// Full context. `withheld` still parses for both statuses, so stored records and the records old kits write keep
// parsing, but from server/entries/checks.ts FULL_CONTEXT_REQUIRED_FROM (the entry's receipt time) the
// transcripts_run_record check refuses a record that withholds the system prompt or the instruction files: the entry
// gives the full context the agent ran under or it is not a valid entry. Redacting secrets and personal details inside
// those files stays allowed; leaving the files out does not. A system-prompt file that is the one line
// `withheld: <why>` (withheldLineWhy) holds no system prompt, and kit and site both read it so. A handed-off run also
// carries its parent chats, every link up to the session the person's prompt opened (PARENT_CHAT_ROLES).
//
// A run file, a strict entry's (one beside sealed recordings) or a loose upload's, may also list, under `context`, the
// context files that ride beside it as their own parts, outside the signed recordings (RunContextFile): the run file
// names them, so the signature over it binds them. They are never evidence. From the cutoff they are what the site
// counts: an `instructions` part is an instruction file the upload carries (instructions `collected` stands on it) and
// a `system-prompt` part an uploaded system prompt (system_prompt `uploaded`). Before it they count only where the
// record says the files came that way (a system prompt `uploaded`, instruction files `collected`), so a stored part
// clears a fail it answers and never moves a status of none (server/entries/run-record.ts runRecordFileCountsAt). A
// list that breaks RunContextList reads as none, never a reason to refuse the run file.
//
// A leaf importing only zod: the kit's one-file CLI inlines it (server/kit/cli-bundle.ts), and contracts/bundle.ts
// imports it, so it imports nothing from contracts/bundle.ts (a cycle would leave one side's schema undefined at
// load) nor contracts/competition.ts (MCP_REGISTRY_NAME_RE below copies that file's McpRegistryName pattern).

import { z } from 'zod';

/** The record's format string; a change that would refuse an earlier record gets a new one. */
export const RUN_RECORD_FORMAT = 'makefun-run/1';
/** The loose upload's run file: its name exactly, beside the transcripts. */
export const LOOSE_RUN_FILE_NAME = 'makefun-run.json';
/** The longest opening prompt, characters. */
export const RUN_PROMPT_MAX_CHARS = 100_000;
/** The most MCP servers one record lists. */
export const RUN_MCP_MAX_SERVERS = 32;
/** The most arguments a stdio server's launch command takes. */
export const RUN_MCP_MAX_ARGS = 32;
/** The longest MCP server URL, characters. */
export const RUN_MCP_MAX_URL_CHARS = 2048;

const notBlank = (s: string): boolean => s.trim() !== '';
const oneLine = (s: string): boolean => !/[\r\n\u2028\u2029]/.test(s);
/** One line of 1..max characters, not blank. */
const line = (max: number) => z.string().min(1).max(max).refine((s) => notBlank(s) && oneLine(s), 'one line: not blank, no line break');

/**
 * How the opening prompt reached the agent:
 *   typed       the person typed it as the first message of an uploaded session
 *   scheduled   a scheduled or automated run fired it: the text is the task's configured prompt
 *   handed-off  another agent session started this one: the text is the person's prompt to THAT earlier session
 *   other       it reached the agent another way
 */
export const RUN_PROMPT_ORIGINS = ['typed', 'scheduled', 'handed-off', 'other'] as const;
export const RunPromptOrigin = z.enum(RUN_PROMPT_ORIGINS);

/**
 * The person's opening prompt. `text` is their words as they wrote them, any number of lines; `via` is one line
 * saying what started the run (the schedule, the session that handed off, the automation): required unless the
 * origin is typed, and null when it is.
 */
export const RunPrompt = z
  .strictObject({
    text: z.string().min(1).max(RUN_PROMPT_MAX_CHARS).refine(notBlank, 'not blank'),
    origin: RunPromptOrigin,
    via: line(300).nullable(),
  })
  .superRefine((p, ctx) => {
    if (p.origin === 'typed' && p.via !== null) ctx.addIssue({ code: 'custom', path: ['via'], message: 'a typed prompt has no via: null' });
    if (p.origin !== 'typed' && p.via === null) ctx.addIssue({ code: 'custom', path: ['via'], message: `a ${p.origin} prompt names what started it in via (one line)` });
  });

/**
 * Where the system prompt is:
 *   uploaded      a context file of kind system-prompt (bundle --system-prompt <file>) holds it
 *   in-session    an uploaded session carries it
 *   harness-held  the harness keeps its own system prompt off the entrant's machine, and make.fun trusts it to
 *                 (transcripts/coverage.ts PROMPT_HOLDING_HARNESSES: Superbot, superbot.gg, run by make.fun's
 *                 owners): no file holds it and no session's text does; it stands only where every top-level session
 *                 is a Superbot relay session superbot.gg attested (transcripts/superbot-provenance.ts,
 *                 transcripts/coverage.ts promptHeldBy, server/entries/run-record.ts uploadPromptHeld)
 *   withheld      it is not uploaded, for the one-line reason in `why`: it still parses (stored records, old kits),
 *                 and transcripts_run_record refuses it from server/entries/checks.ts FULL_CONTEXT_REQUIRED_FROM;
 *                 redact secrets and personal details inside the file rather than leave it out
 */
export const SYSTEM_PROMPT_STATUSES = ['uploaded', 'in-session', 'harness-held', 'withheld'] as const;
export const SystemPromptStatus = z.enum(SYSTEM_PROMPT_STATUSES);

/** The system prompt's status; `why` is required when it is withheld and null otherwise. */
export const RunSystemPrompt = z
  .strictObject({
    status: SystemPromptStatus,
    why: line(300).nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.status === 'withheld' && s.why === null) ctx.addIssue({ code: 'custom', path: ['why'], message: 'a withheld system prompt says why, in one line' });
    if (s.status !== 'withheld' && s.why !== null) ctx.addIssue({ code: 'custom', path: ['why'], message: `${s.status === 'harness-held' ? 'a' : 'an'} ${s.status} system prompt has no why: null` });
  });

/**
 * A system-prompt file that withholds the prompt rather than holding it: once a leading BOM is dropped and the text
 * trimmed, the one line `withheld: <why>` (`withheld` in any case). Its why, trimmed (`''` when the line names none),
 * or null for any other text, which is a system prompt. Kit (cli/bundle.ts) and site (server/entries/run-record.ts)
 * both read a file through this, so neither counts such a file as an uploaded system prompt the other would not.
 */
export function withheldLineWhy(text: string): string | null {
  const t = text.replace(/^\uFEFF/, '').trim();
  const m = /^withheld:[ \t]*(.*)$/i.exec(t);
  return m !== null && oneLine(t) ? m[1]!.trim() : null;
}

/**
 * Whether the instruction files the agent ran under (CLAUDE.md, AGENTS.md, rules, skills, settings) are in the upload:
 *   collected  the upload carries them: at least one context file of a kind other than system-prompt
 *   none       the agent ran with no instruction file, and the upload carries none
 *   withheld   they are not uploaded, for the one-line reason in `why`: it still parses (stored records, old kits),
 *              and transcripts_run_record refuses it from server/entries/checks.ts FULL_CONTEXT_REQUIRED_FROM; redact
 *              secrets and personal details inside the files rather than leave them out
 */
export const INSTRUCTIONS_STATUSES = ['collected', 'none', 'withheld'] as const;
export const InstructionsStatus = z.enum(INSTRUCTIONS_STATUSES);

/** The instruction files' status, the twin of RunSystemPrompt: `why` is required when they are withheld and null otherwise. */
export const RunInstructions = z
  .strictObject({
    status: InstructionsStatus,
    why: line(300).nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.status === 'withheld' && s.why === null) ctx.addIssue({ code: 'custom', path: ['why'], message: 'withheld instruction files say why, in one line' });
    if (s.status !== 'withheld' && s.why !== null) ctx.addIssue({ code: 'custom', path: ['why'], message: `instruction files marked ${s.status} have no why: null` });
  });

/**
 * What a context file riding beside a run file is (LooseRunFile.context):
 *   begun-before   a session of the run that is not evidence: one the agent began before a strict recording did, which
 *                  the seal left out, or, under a name parentChatPartOf reads (PARENT_CHAT_PART_DIR), a parent chat
 *   instructions   an instruction file the agent ran under (CLAUDE.md, AGENTS.md, rules, skills, settings)
 *   system-prompt  the system prompt the agent ran under, as a file
 * server/db/schema.ts TRANSCRIPT_CONTEXT_UPLOAD_ROLES, the roles submission.transcript_context_upload stores, is this list.
 * A parent chat has no role of its own here for that reason: a new role would change what that column stores, so a
 * parent chat rides as begun-before and its name carries its role and depth (parentChatPartName), which the intake
 * (server/pipeline/strict-context-task.ts) reads back into the context session's role and depth.
 */
export const RUN_CONTEXT_ROLES = ['begun-before', 'instructions', 'system-prompt'] as const;
export const RunContextRole = z.enum(RUN_CONTEXT_ROLES);
/** The most context files one run file lists. */
export const RUN_CONTEXT_MAX_FILES = 512;
/** The longest name a context file goes by, characters. */
export const RUN_CONTEXT_MAX_NAME_CHARS = 512;

/**
 * Why `name` is not a name a context file may go by, or null when it is: a relative path of `/`-separated parts, none
 * empty, `.` or `..`, with no backslash, control character or line break (two CLAUDE.md files from two directories
 * go by two names). It is the file name of the multipart part that carries the file.
 */
export function runContextNameIssue(name: string): string | null {
  if (name.length === 0 || name.length > RUN_CONTEXT_MAX_NAME_CHARS) return `is not 1 to ${RUN_CONTEXT_MAX_NAME_CHARS} characters`;
  if (/[\\\u0000-\u001f\u007f\u2028\u2029]/.test(name)) return 'holds a backslash, a control character or a line break';
  if (name.split('/').some((part) => part === '' || part === '.' || part === '..')) return 'is not a relative path of non-empty parts (no leading or doubled /, no . or ..)';
  return null;
}

/**
 * The context-session roles (contracts/bundle.ts CONTEXT_SESSION_ROLES, a subset of it) that make a parent chat: a
 * session that started the evidence one by a hand-off or a brief (ancestor, requester), or one it resumed
 * (continued-from). A handed-off run carries every link of its chain up to the session the person's prompt opened.
 */
export const PARENT_CHAT_ROLES = ['ancestor', 'continued-from', 'requester'] as const;
export type ParentChatRoleT = (typeof PARENT_CHAT_ROLES)[number];
/** The furthest link a parent chat may sit from its evidence session: contracts/bundle.ts MAX_CONTEXT_DEPTH, copied to keep this file a leaf. */
export const PARENT_CHAT_MAX_DEPTH = 4;
/** Where a parent chat's part name starts: `parent-chats/<role>/<depth>/<rest>` (parentChatPartName). */
export const PARENT_CHAT_PART_DIR = 'parent-chats/';

/** A parent chat's place in the chain a part name carries: its role, its depth (1 for the direct parent) and the rest of the name. */
export interface ParentChatPart {
  role: ParentChatRoleT;
  depth: number;
  rest: string;
}

/**
 * The name a parent chat rides under as a `begun-before` context part: `parent-chats/<role>/<depth>/<rest>`, `depth`
 * 1..PARENT_CHAT_MAX_DEPTH in decimal, `rest` the file's own relative path (`<source>/<file>`). Throws when `role` is no
 * PARENT_CHAT_ROLES role, `depth` is out of range, or the name would break runContextNameIssue: the kit builds the name
 * from what it collected, so a throw is the kit's own fault, never the entrant's.
 */
export function parentChatPartName(role: ParentChatRoleT, depth: number, rest: string): string {
  if (!(PARENT_CHAT_ROLES as readonly string[]).includes(role)) throw new Error(`parentChatPartName: ${JSON.stringify(role)} is not a parent chat role (${PARENT_CHAT_ROLES.join(', ')})`);
  if (!Number.isInteger(depth) || depth < 1 || depth > PARENT_CHAT_MAX_DEPTH) throw new Error(`parentChatPartName: depth ${depth} is not a whole number 1 to ${PARENT_CHAT_MAX_DEPTH}`);
  const name = `${PARENT_CHAT_PART_DIR}${role}/${depth}/${rest}`;
  const why = rest === '' ? 'has no rest' : runContextNameIssue(name);
  if (why !== null) throw new Error(`parentChatPartName: the name ${JSON.stringify(name)} ${why}`);
  return name;
}

/**
 * The parent chat a context part's name carries (parentChatPartName's name read back), or null when the name is not
 * one: it must open PARENT_CHAT_PART_DIR, name a PARENT_CHAT_ROLES role and a depth 1..PARENT_CHAT_MAX_DEPTH written as
 * parentChatPartName writes it (no sign, no leading zero), have a rest, and pass runContextNameIssue. A begun-before
 * part with any other name stays a session begun before the recording.
 */
export function parentChatPartOf(name: string): ParentChatPart | null {
  if (!name.startsWith(PARENT_CHAT_PART_DIR) || runContextNameIssue(name) !== null) return null;
  const m = /^([^/]+)\/([1-9][0-9]*)\/(.+)$/.exec(name.slice(PARENT_CHAT_PART_DIR.length));
  if (m === null) return null;
  const [, role, digits, rest] = m;
  if (!(PARENT_CHAT_ROLES as readonly string[]).includes(role!)) return null;
  const depth = Number(digits);
  if (depth > PARENT_CHAT_MAX_DEPTH) return null;
  return { role: role as ParentChatRoleT, depth, rest: rest! };
}

const RunContextName = z.string().superRefine((name, ctx) => {
  const why = runContextNameIssue(name);
  if (why !== null) ctx.addIssue({ code: 'custom', message: `a context file's name: this one ${why}` });
});

/**
 * One context file a strict entry's run file names: `name` its part's file name (unique in the list), `sha256` and
 * `bytes` the file's as sent, `role` RUN_CONTEXT_ROLES, and `kind`, when the kit names one, what narrows the role (the
 * harness a begun-before session came from, an instructions file's context kind: contracts/bundle.ts CONTEXT_KINDS).
 */
export const RunContextFile = z.strictObject({
  name: RunContextName,
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'a sha256: 64 lowercase hex characters'),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  role: RunContextRole,
  kind: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'a kind: 1 to 64 lowercase letters, digits, dots, dashes or underscores')
    .optional(),
});

/**
 * How the agent reached an MCP server:
 *   stdio            it launched the server: `command`, with `args`
 *   streamable-http  it connected to `url` over Streamable HTTP
 *   sse              it connected to `url` over the older HTTP+SSE transport
 *   builtin          the server ships inside the harness (Claude Code's `ide`, Cosmos's `cosmos`): the name alone
 */
export const MCP_RUN_TRANSPORTS = ['stdio', 'streamable-http', 'sse', 'builtin'] as const;
export const McpRunTransport = z.enum(MCP_RUN_TRANSPORTS);

/** contracts/competition.ts McpRegistryName's pattern, copied to keep this file a leaf. */
const MCP_REGISTRY_NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
/** A server's name in the MCP Registry (registry.modelcontextprotocol.io): a reverse-DNS namespace, a slash and a name. */
const RunMcpRegistryName = z
  .string()
  .min(3)
  .max(200)
  .regex(MCP_REGISTRY_NAME_RE, 'expected an MCP Registry name: a reverse-DNS namespace, a slash and a name, such as io.github.owner/server');

/** Why `u` is not an MCP server URL a record may hold, or null when it is: http or https, no user name or password in it. */
export function mcpUrlIssue(u: string): string | null {
  if (u.length > RUN_MCP_MAX_URL_CHARS) return `is longer than ${RUN_MCP_MAX_URL_CHARS} characters`;
  if (!oneLine(u) || u.trim() !== u) return 'holds a line break or surrounding space';
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return 'is not a URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'is not http or https';
  if (url.username !== '' || url.password !== '') return 'holds a user name or password';
  return null;
}

const RunMcpUrl = z.string().superRefine((u, ctx) => {
  const why = mcpUrlIssue(u);
  if (why !== null) ctx.addIssue({ code: 'custom', message: `an http(s) URL with no user name or password: this one ${why}` });
});

/**
 * One MCP server the agent used.
 *   name           its name as the agent's tool list shows it (`github` for `mcp__github__*`), matched to a used
 *                  name by mcpNameKey; unique in the record by it
 *   transport      MCP_RUN_TRANSPORTS
 *   url            where a streamable-http or sse server answers (required there, absent elsewhere)
 *   command, args  how a stdio server is launched (command required there; both absent elsewhere)
 *   package        what it runs from, when a package names it: `npm:@scope/pkg@1.2.3`, `pypi:name==1.0`
 *   registry_name  its MCP Registry name, or null when it is not listed there
 * A builtin server carries its name alone. No field holds an env value, a header, an API key, a token or any other
 * credential, and none may be added: the record is for recreating the run, and a reviewer supplies their own.
 */
export const RunMcpServer = z
  .strictObject({
    name: line(64),
    transport: McpRunTransport,
    url: RunMcpUrl.optional(),
    command: line(200).optional(),
    args: z.array(z.string().max(400).refine(oneLine, 'one line: no line break')).max(RUN_MCP_MAX_ARGS).optional(),
    package: line(200).optional(),
    registry_name: RunMcpRegistryName.nullable().optional(),
  })
  .superRefine((m, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const remote = m.transport === 'streamable-http' || m.transport === 'sse';
    if (remote && m.url === undefined) issue('url', `a ${m.transport} server names its url`);
    if (!remote && m.url !== undefined) issue('url', `a ${m.transport} server has no url`);
    if (m.transport === 'stdio' && m.command === undefined) issue('command', 'a stdio server names the command it is launched with');
    if (m.transport !== 'stdio' && m.command !== undefined) issue('command', `a ${m.transport} server has no command`);
    if (m.transport !== 'stdio' && m.args !== undefined) issue('args', `a ${m.transport} server has no args`);
    if (m.transport === 'builtin' && m.package !== undefined) issue('package', 'a builtin server carries its name alone');
    if (m.transport === 'builtin' && m.registry_name !== undefined && m.registry_name !== null) issue('registry_name', 'a builtin server carries its name alone');
  });

/**
 * How a used server's name is matched to a declared one: lowercase, with `-`, `_`, ` ` and `.` all read as `_`
 * (Claude Code writes the server `claude.ai Gmail` into its tool names as `claude_ai_Gmail`).
 */
export function mcpNameKey(name: string): string {
  return name.toLowerCase().replace(/[-_ .]/g, '_');
}

/** How an entrant says the agent was run (`makefun bundle`'s flags); unverified. A bundle keeps it as manifest.declared. */
export const BundleDeclared = z.strictObject({
  harness: z.string().max(64).nullable(),
  harness_version: z.string().max(64).nullable(),
  model: z.string().max(128).nullable(),
  provider: z.string().max(128).nullable(),
  reasoning_effort: z.string().max(32).nullable(),
  notes: z.string().max(2000).nullable(),
});

const runRecordShape = {
  format: z.literal(RUN_RECORD_FORMAT),
  prompt: RunPrompt,
  system_prompt: RunSystemPrompt,
  /**
   * The instruction files' status. Optional: a kit below level 14 writes none, and a required field would make every
   * record it wrote unparseable (the schema is strict); the site's check notes its absence and never fails on it.
   */
  instructions: RunInstructions.optional(),
  /** Every MCP server the agent used; empty when it used none. */
  mcp_servers: z.array(RunMcpServer).max(RUN_MCP_MAX_SERVERS),
};

/** A server is listed once: two names with one mcpNameKey are the same server. */
function uniqueServers(
  r: { mcp_servers: ReadonlyArray<{ name: string }> },
  ctx: { addIssue: (issue: { code: 'custom'; path: (string | number)[]; message: string }) => void },
): void {
  const seen = new Map<string, string>();
  r.mcp_servers.forEach((m, i) => {
    const key = mcpNameKey(m.name);
    const first = seen.get(key);
    if (first !== undefined) ctx.addIssue({ code: 'custom', path: ['mcp_servers', i, 'name'], message: `${m.name} is the server ${first} already listed` });
    else seen.set(key, m.name);
  });
}

/** The run record (see the header). */
export const RunRecord = z.strictObject(runRecordShape).superRefine(uniqueServers);

/**
 * A strict entry's context list as its writer must make it: RunContextFile entries, each name once (two entries with
 * one name are refused, naming the second), at most RUN_CONTEXT_MAX_FILES. A kit checks the list it writes with this;
 * LooseRunFile reads a list that fails it as absent.
 */
export const RunContextList = z
  .array(RunContextFile)
  .max(RUN_CONTEXT_MAX_FILES)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((c, i) => {
      if (seen.has(c.name)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `${c.name} is listed already` });
      else seen.add(c.name);
    });
  });

/**
 * A loose upload's makefun-run.json: the run record and the agent facts a bundle would keep in manifest.declared, and
 * the context files riding beside it, a strict entry's or a loose upload's (RunContextList; optional: a kit that sends
 * none writes none, and every run file written before it still parses). From the full-context cutoff those parts are
 * what the site counts (see the header): an `instructions` part an instruction file, a `system-prompt` part an
 * uploaded system prompt, a begun-before part named under PARENT_CHAT_PART_DIR a parent chat. Only the run file
 * carries `context`: the run record a bundle's manifest holds, and the one ingest stores (transcripts/ingest.ts
 * runRecordOf), never do.
 *
 * `context` is never a reason to refuse a run file, and so never one to refuse an entry: a value that is not a whole
 * RunContextList (null, a bad name, a name twice, past RUN_CONTEXT_MAX_FILES) reads as no list (`.catch(undefined)`:
 * the key parses to undefined), the intake then takes no context part, and every other field stays exactly as strict.
 * The whole list goes rather than its bad entries, so what the server takes is either the list the signed run file
 * names, as written, or nothing.
 */
export const LooseRunFile = z
  .strictObject({ ...runRecordShape, declared: BundleDeclared, context: RunContextList.optional().catch(undefined) })
  .superRefine(uniqueServers);

/**
 * Openings of a first user message that an agent or a harness wrote, not the person: a hand-off from another
 * session, or a continuation after the context was compacted. Each is an exact known opening, anchored at the
 * start: a false match would reject an honest entry's typed prompt, so nothing broader goes here.
 */
export const HANDOFF_PROMPT_MARKERS: readonly RegExp[] = [
  // A session another agent session started (the example entry https://make.fun/s/01a1dce6-af3f-70d6-9c6b-7f161cd050c7,
  // claude-code 2.1.321: its one session opens with this hand-off).
  /^\s*Background \(from the session that started this one\)/i,
  // Claude Code's continuation after compaction (tests/fixtures/transcripts/claude-stream/cowork-audit.jsonl,
  // tests/fixtures/transcripts/qoder/projects/-Users-user-projects-wordcount/5f0c2a9e-3b7d-4e1f-8a6c-9d2b4e7f1a30.jsonl).
  /^\s*This session is being continued from a previous conversation/i,
  // Goose's continuation after compaction (tests/fixtures/transcripts/goose/rows.json, its context_mgmt message).
  /^\s*Your context was compacted\. The previous message contains a summary of the conversation so far/i,
  // Devin's lead handing work to its sidekick (tests/fixtures/transcripts/devin/rows.json).
  /^\s*<lead_handoff>/i,
  // Hermes Agent's compaction hand-off, agent/context_compressor.py SUMMARY_PREFIX and LEGACY_SUMMARY_PREFIX
  // (tests/fixtures/transcripts/hermes/rows.json, the first row of session 20261108_150210_778899). The reader flags that
  // row itself (transcripts/hermes.ts: injected, compact_summary), so no session yields it as an opening; this holds a
  // record's own text to it, whatever its origin.
  /^\s*\[CONTEXT COMPACTION\b/,
  /^\s*\[CONTEXT SUMMARY\]:/,
];

/** Whether `text` opens as an agent's or a harness's hand-off rather than the person's own words (HANDOFF_PROMPT_MARKERS). */
export function isHandoffPrompt(text: string): boolean {
  return HANDOFF_PROMPT_MARKERS.some((re) => re.test(text));
}

/** A Cosmos chat's new session rebuilt from its earlier one's hand-off: a continuation, once the preambles are stripped. */
export const COSMOS_REBUILD_OPENING = /^\s*\[context-rebuild\]/;
/** A Cosmos worker brief's opening, once the preambles are stripped. */
export const COSMOS_BRIEF_OPENING = /^\s*\[goal-ledger\]/;
/**
 * Openings of a first user message, once stripHarnessPreambles has run, that a harness wrote to start a session from
 * another one's work: a Cosmos worker's brief and a Cosmos chat's rebuild. They are kept apart from
 * HANDOFF_PROMPT_MARKERS on purpose: that list decides whether a record's own prompt text is refused as a hand-off on
 * stored entries, and widening it would change those verdicts. These only tell that a session's opening is not the
 * person's prompt, so its parent chats must ride with it (opensAsBrief).
 */
export const BRIEF_OPENING_MARKERS: readonly RegExp[] = [COSMOS_BRIEF_OPENING, COSMOS_REBUILD_OPENING];

/** The harness wrappers stripped before an opening is read: whole tagged sections, and a block opening one never closed. */
const PREAMBLE_SECTIONS = /<(chat-instructions|system-reminder)>[\s\S]*?<\/\1>/g;
const UNCLOSED_PREAMBLE = /^\s*<(chat-instructions|system-reminder)>/;

/**
 * A first user message's text with the harness's wrappers taken out: every whole `<chat-instructions>` and
 * `<system-reminder>` section is removed, and a block that still opens one it never closed is dropped whole, as is a
 * block left blank. Given several blocks (a message's text parts), the ones left are joined by a blank line; `''` when
 * none is left.
 */
export function stripHarnessPreambles(text: string | readonly string[]): string {
  const blocks: string[] = [];
  for (const t of typeof text === 'string' ? [text] : text) {
    const s = t.replace(PREAMBLE_SECTIONS, '');
    if (UNCLOSED_PREAMBLE.test(s) || s.trim() === '') continue;
    blocks.push(s);
  }
  return blocks.join('\n\n');
}

/**
 * Whether a first user message opens as something other than the person's own prompt, once stripHarnessPreambles has
 * run: a hand-off or continuation (isHandoffPrompt) or a harness brief (BRIEF_OPENING_MARKERS). False when nothing is
 * left once the preambles go.
 */
export function opensAsBrief(text: string | readonly string[]): boolean {
  const s = stripHarnessPreambles(text);
  if (s.trim() === '') return false;
  return isHandoffPrompt(s) || BRIEF_OPENING_MARKERS.some((re) => re.test(s));
}

/**
 * Whether one user message's text blocks say `prompt`: joined by a line break as read, or with the harness's wrappers
 * taken out (stripHarnessPreambles: Claude Code in the desktop app stores an injected `<system-reminder>` block in the
 * same first message as the person's words). `same` compares two texts: samePrompt by default; the site passes its
 * promptOpens (server/entries/run-record.ts), which also takes one redacted under another context, and the kit's bundle
 * calls the site's reading (typedPromptMatches, holdsPrompt), so kit and site read an opening alike.
 */
export function saysPrompt(texts: readonly string[], prompt: string, same: (opening: string, prompt: string) => boolean = samePrompt): boolean {
  if (same(texts.join('\n'), prompt)) return true;
  const stripped = stripHarnessPreambles(texts);
  return stripped.trim() !== '' && same(stripped, prompt);
}

/**
 * Whether one user message's text blocks are `prompt` as the person's own words: they say it (saysPrompt) and open as
 * no hand-off or brief (isHandoffPrompt, opensAsBrief).
 */
export function isPersonPrompt(texts: readonly string[], prompt: string, same: (opening: string, prompt: string) => boolean = samePrompt): boolean {
  if (isHandoffPrompt(texts.join('\n')) || opensAsBrief(texts)) return false;
  return saysPrompt(texts, prompt, same);
}

/** `s` as samePrompt compares it: NFC, every run of whitespace (line breaks included) one space, trimmed. */
export function normalizePrompt(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Whether two prompts say the same words: equal once each is normalizePrompt'd. */
export function samePrompt(a: string, b: string): boolean {
  return normalizePrompt(a) === normalizePrompt(b);
}

export type RunPromptOriginT = z.infer<typeof RunPromptOrigin>;
export type RunPromptT = z.infer<typeof RunPrompt>;
export type SystemPromptStatusT = z.infer<typeof SystemPromptStatus>;
export type RunSystemPromptT = z.infer<typeof RunSystemPrompt>;
export type InstructionsStatusT = z.infer<typeof InstructionsStatus>;
export type RunInstructionsT = z.infer<typeof RunInstructions>;
export type McpRunTransportT = z.infer<typeof McpRunTransport>;
export type RunMcpServerT = z.infer<typeof RunMcpServer>;
export type RunRecordT = z.infer<typeof RunRecord>;
export type LooseRunFileT = z.infer<typeof LooseRunFile>;
export type RunContextRoleT = z.infer<typeof RunContextRole>;
export type RunContextFileT = z.infer<typeof RunContextFile>;
export type BundleDeclaredT = z.infer<typeof BundleDeclared>;
