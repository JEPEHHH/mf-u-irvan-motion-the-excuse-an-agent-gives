// The transcript bundle: a .tar.gz the CLI (`makefun bundle`) writes and the server ingests.
// It holds manifest.json (this schema) at the archive root plus every raw original session file
// under sessions/, byte for byte, and the instruction files the agent ran under (system prompt,
// AGENTS.md / CLAUDE.md, agent definitions, skills, settings…) under context/. The server re-derives everything from the originals (parsing,
// usage, redaction, pricing, authorship); the manifest only says what each file is and where it
// came from, so nothing client-normalized is ever trusted. A packed entrypoint (one `makefun compress`
// wrote) travels with the readable source it was packed from under packs/, each listed in the
// manifest's packs: the server re-packs that source and compares the bytes with the committed entry.
// The manifest's run record (contracts/run-record.ts) holds what a reviewer needs to recreate the run
// beyond the agent facts in declared: the person's opening prompt, where the system prompt is, the MCP
// servers the agent used.
// Two lists widen it for kits that write them: context_sessions, the sessions an evidence session was
// started from or continued (its manager, the session it resumed…), each under context-sessions/ and
// never evidence; and a session's attachments, the sidecar files its log points at (Claude Code's
// tool-results/<tool_use id>.txt, an image a log names by its sha256), each under attachments/. Ingest reads context sessions only through
// their own list, so no evidence reader can take one for evidence.

import { z } from 'zod';
import { GitSha, IsoDateTime, Sha256Hex } from './primitives.ts';
import { BundleDeclared, RunRecord } from './run-record.ts';

export const BUNDLE_FORMAT = 'agent-fun/transcript-bundle/v1';
export const BUNDLE_MANIFEST_PATH = 'manifest.json';
export const BUNDLE_SESSIONS_DIR = 'sessions/';
export const BUNDLE_CONTEXT_DIR = 'context/';
export const BUNDLE_PACKS_DIR = 'packs/';
export const BUNDLE_CONTEXT_SESSIONS_DIR = 'context-sessions/';
export const BUNDLE_ATTACHMENTS_DIR = 'attachments/';
/** The context sessions one bundle may list. */
export const MAX_CONTEXT_SESSIONS = 8;
/** The furthest link a context session may sit from the evidence session it was linked from: 1 is its direct parent. */
export const MAX_CONTEXT_DEPTH = 4;
/** The attachments one session (evidence or context) may list. */
export const MAX_SESSION_ATTACHMENTS = 2000;
/**
 * The packer a pack names: the kit's `makefun compress`, version 1 (transcripts/compress.ts states the
 * same string; contracts import nothing from transcripts/).
 */
export const PACK_FORMAT = 'makefun-compress/v1';
/** The packs one bundle may list. */
export const MAX_PACKS = 16;
/** The largest pack source, bytes. */
export const MAX_PACK_SOURCE_BYTES = 256 * 1024;
/** The longest repo-relative path a pack names (its entry, its source), characters. */
export const MAX_PACK_REPO_PATH_CHARS = 512;
/** A context file over this is left out at ingest (a warning, never a refusal). */
export const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;
/** The context files of one bundle, together: a file that would pass this is left out at ingest. */
export const MAX_CONTEXT_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_CONTEXT_FILES = 400;
/**
 * One context session (a parent chat a run began from) at most this many bytes as sent: every account's cap, unless
 * the site raises it for the account or the competition (GET /api/competitions/:slug/context-limits answers the caller's).
 */
export const MAX_CONTEXT_SESSION_BYTES = 128 * 1024 * 1024;
/** A trusted account's cap on one context session (server/entries/context-limits.ts). */
export const TRUSTED_CONTEXT_SESSION_BYTES = 256 * 1024 * 1024;
/**
 * The most any cap on one context session may be, a raise included: the kit reads a session up to it and the ingest
 * keeps one up to it, so a part the intake took is never dropped later.
 */
export const CONTEXT_SESSION_BYTES_CEILING = 256 * 1024 * 1024;
/** The context sessions of one upload together, at every cap. */
export const MAX_CONTEXT_SESSIONS_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * The caps an upload's context parts are held to: begun-before sessions (count, each, together) and
 * instruction/system-prompt files (count, each, together).
 */
export interface ContextLimits {
  sessions: number;
  sessionBytes: number;
  sessionTotalBytes: number;
  files: number;
  fileBytes: number;
  fileTotalBytes: number;
}
/** Every account's caps, unless the site raises one for the account or the competition. */
export const DEFAULT_CONTEXT_LIMITS: Readonly<ContextLimits> = Object.freeze({
  sessions: MAX_CONTEXT_SESSIONS,
  sessionBytes: MAX_CONTEXT_SESSION_BYTES,
  sessionTotalBytes: MAX_CONTEXT_SESSIONS_TOTAL_BYTES,
  files: MAX_CONTEXT_FILES,
  fileBytes: MAX_CONTEXT_FILE_BYTES,
  fileTotalBytes: MAX_CONTEXT_TOTAL_BYTES,
});

/**
 * GET /api/competitions/:slug/context-limits' answer: the caller's caps in that competition. z.object (not strict) so a
 * field added later never breaks an older kit.
 */
export const ContextLimitsWire = z.object({
  sessions: z.int().min(1).max(MAX_CONTEXT_SESSIONS),
  session_bytes: z.int().min(1).max(CONTEXT_SESSION_BYTES_CEILING),
  session_total_bytes: z.int().min(1).max(MAX_CONTEXT_SESSIONS_TOTAL_BYTES),
  files: z.int().min(1).max(MAX_CONTEXT_FILES),
  file_bytes: z.int().min(1).max(MAX_CONTEXT_FILE_BYTES),
  file_total_bytes: z.int().min(1).max(MAX_CONTEXT_TOTAL_BYTES),
});
export type ContextLimitsWireT = z.infer<typeof ContextLimitsWire>;

/** The wire form of a set of caps. */
export function contextLimitsWireOf(l: ContextLimits): ContextLimitsWireT {
  return {
    sessions: l.sessions,
    session_bytes: l.sessionBytes,
    session_total_bytes: l.sessionTotalBytes,
    files: l.files,
    file_bytes: l.fileBytes,
    file_total_bytes: l.fileTotalBytes,
  };
}

/** The caps a parsed wire answer names. */
export function contextLimitsOfWire(w: ContextLimitsWireT): ContextLimits {
  return {
    sessions: w.sessions,
    sessionBytes: w.session_bytes,
    sessionTotalBytes: w.session_total_bytes,
    files: w.files,
    fileBytes: w.file_bytes,
    fileTotalBytes: w.file_total_bytes,
  };
}
/**
 * Largest accepted upload (bundle or loose files), bytes: 256 MiB, the owner's ruling (2026-11-23; 200 MiB before, which an
 * entrant's complete set of 219,637,160 bytes ran past). It weighs a bundle compressed and unpacked alike. The edge in front of
 * the site takes no request body past 200 MB (decimal), so an upload above that reaches the site only compressed: a
 * `.tar.gz` bundle, or loose files the kit sends `Content-Encoding: gzip`.
 */
export const MAX_TRANSCRIPT_UPLOAD_BYTES = 256 * 1024 * 1024;

export const TRANSCRIPT_SOURCES = [
  'claude-code',
  'codex',
  'cursor',
  'specstory',
  'chatgpt-export',
  'claude-export',
  'copilot-cli',
  'copilot-vscode',
  'gemini-cli',
  'opencode',
  'cline',
  'aider',
  'atif',
  'pi',
  'omp',
  'dsh',
  'zed',
  'continue',
  'amazon-q',
  'devin',
  'grok-build',
  'zazen',
  'hermes',
  'openclaw',
  't3code',
  'codex-cloud',
  'cursor-cloud',
  'devin-cloud',
  'copilot-agent',
  'ollama',
  'lmstudio',
  'omlx',
  'jan',
  'open-webui',
  'anythingllm',
  'cherry-studio',
  'chatbox',
  'deepseek-export',
  'perplexity',
  'kiro',
  'goose',
  'kimi-code',
  'factory-droid',
  'junie',
  'antigravity',
  'openhands',
  'mistral-vibe',
  'crush',
  'codebuddy',
  'muse-code',
  'muse-app',
  'qoder',
  'superbot',
  'jules-cloud',
  'openhands-cloud',
  'warp-cloud',
  'amp',
  'jan-agent',
  'chat-log',
  'claude-stream',
] as const;
export const TranscriptSource = z.enum(TRANSCRIPT_SOURCES);

/** A file inside the archive under sessions/: relative, POSIX, no `..`, no empty or dot segments. */
export const SessionPath = z
  .string()
  .max(512)
  .regex(/^sessions\/[A-Za-z0-9_][A-Za-z0-9._@-]*(\/[A-Za-z0-9_][A-Za-z0-9._@-]*)*$/, 'expected sessions/<relative path>');

/** A file inside the archive under context/, by SessionPath's rules. */
export const ContextPath = z
  .string()
  .max(512)
  .regex(/^context\/[A-Za-z0-9_][A-Za-z0-9._@-]*(\/[A-Za-z0-9_][A-Za-z0-9._@-]*)*$/, 'expected context/<relative path>');

/** A file inside the archive under packs/, by SessionPath's rules. */
export const PackPath = z
  .string()
  .max(512)
  .regex(/^packs\/[A-Za-z0-9_][A-Za-z0-9._@-]*(\/[A-Za-z0-9_][A-Za-z0-9._@-]*)*$/, 'expected packs/<relative path>');

/** A file inside the archive under context-sessions/, by SessionPath's rules. */
export const ContextSessionPath = z
  .string()
  .max(512)
  .regex(/^context-sessions\/[A-Za-z0-9_][A-Za-z0-9._@-]*(\/[A-Za-z0-9_][A-Za-z0-9._@-]*)*$/, 'expected context-sessions/<relative path>');

/** A file inside the archive under attachments/, by SessionPath's rules. */
export const AttachmentPath = z
  .string()
  .max(512)
  .regex(/^attachments\/[A-Za-z0-9_][A-Za-z0-9._@-]*(\/[A-Za-z0-9_][A-Za-z0-9._@-]*)*$/, 'expected attachments/<relative path>');

/**
 * Why `p` is not a repo-relative POSIX path a pack may name, or null when it is: no leading slash,
 * backslash, drive letter or NUL, no empty, `.` or `..` segment, no `.git` segment (any case), at most
 * MAX_PACK_REPO_PATH_CHARS. Any other character a real file name holds (spaces, unicode) is kept, so a
 * real source is never unsendable.
 */
export function packRepoPathIssue(p: string): string | null {
  if (p === '') return 'is empty';
  if (p.length > MAX_PACK_REPO_PATH_CHARS) return `is longer than ${MAX_PACK_REPO_PATH_CHARS} characters`;
  if (p.startsWith('/')) return 'is absolute';
  if (/^[A-Za-z]:/.test(p)) return 'starts with a drive letter';
  if (p.includes('\\')) return 'holds a backslash';
  if (p.includes('\0')) return 'holds a NUL';
  for (const seg of p.split('/')) {
    if (seg === '..') return 'holds a `..` segment';
    if (seg === '' || seg === '.') return 'holds an empty or `.` segment';
    if (seg.toLowerCase() === '.git') return 'is .git or under it';
  }
  return null;
}

/** A path inside the repository, by packRepoPathIssue's rules. */
const PackRepoPath = z.string().superRefine((p, ctx) => {
  const why = packRepoPathIssue(p);
  if (why !== null) ctx.addIssue({ code: 'custom', message: `a repo-relative path: this one ${why}` });
});

/** Where a path the CLI found sits, home-relative (`~/...`); never an absolute home path. */
const OriginalPath = z.string().min(1).refine((p) => !/^(\/Users\/|\/home\/|[A-Za-z]:\\)/.test(p), 'original_path must not reveal a home directory');

export const CONTEXT_KINDS = ['system-prompt', 'instructions', 'agent-definition', 'skill', 'command', 'settings', 'memory', 'other'] as const;
export const ContextKind = z.enum(CONTEXT_KINDS);

/** An instruction file the agent ran under, raw as found (ingest redacts it). */
export const BundleContextFile = z.strictObject({
  path: ContextPath,
  kind: ContextKind,
  /** repo: inside the repository; user: the user's own config (`~/.claude/…`); explicit: named on the command line. */
  scope: z.enum(['repo', 'user', 'explicit']),
  /** The harness the file configures (`claude-code`, `codex`…), null when it is shared (AGENTS.md). */
  harness: z.string().min(1).max(64).nullable(),
  sha256: Sha256Hex,
  bytes: z.int().min(0),
  original_path: OriginalPath,
  collected_by: z.enum(['explicit', 'discovered']),
});

/**
 * The readable source a packed entrypoint was written from (`makefun compress`), uploaded beside the
 * sessions and never redacted or published: ingest re-packs it and compares the bytes with the entry.
 */
export const BundlePack = z.strictObject({
  /** Where the source sits in the archive. */
  path: PackPath,
  /** The packed entrypoint, a snapshot path (`main.py`). */
  entry: PackRepoPath,
  /** Where the source sits in the repository, repo-relative (`src/bot.py`). */
  source_path: PackRepoPath,
  format: z.literal(PACK_FORMAT),
  /** The source's, as archived. */
  sha256: Sha256Hex,
  bytes: z.int().min(0).max(MAX_PACK_SOURCE_BYTES),
});

/**
 * What an attachment is. tool-result: a tool's output the harness kept beside the log rather than in it
 * (Claude Code `<session>/tool-results/<tool_use id>.txt`, the log holding only a preview). image: an image the log
 * refers to by the sha256 of its bytes and keeps elsewhere (CodeBuddy's image_blob_ref, its bytes in CodeBuddy's blob
 * store), named by that sha256; ingest keeps it only where its bytes are a PNG, JPEG, GIF or WebP.
 */
export const ATTACHMENT_KINDS = ['tool-result', 'image'] as const;
export const AttachmentKind = z.enum(ATTACHMENT_KINDS);

/** A sidecar file a session's log points at, raw as found (ingest verifies and redacts it). */
export const BundleAttachment = z.strictObject({
  /** Where the file sits in the archive. */
  path: AttachmentPath,
  kind: AttachmentKind,
  /** What the log names it by: a tool-result's tool_use id (or its key below the session's directory), an image's sha256. */
  name: z.string().min(1).max(256),
  sha256: Sha256Hex,
  bytes: z.int().min(0),
});

export const BundleSession = z.strictObject({
  /** Where the original sits in the archive. */
  path: SessionPath,
  source: TranscriptSource,
  sha256: Sha256Hex,
  bytes: z.int().min(0),
  /** The tool's own session id, when the file names one. */
  session_id: z.string().min(1).nullable(),
  /** Set for subagent transcripts (Claude Code `<sessionId>/subagents/agent-*.jsonl`). */
  parent_session_id: z.string().min(1).nullable(),
  agent_id: z.string().min(1).nullable(),
  /** Where the CLI found it, home-relative (`~/...`); never an absolute home path. */
  original_path: OriginalPath,
  /**
   * explicit: named with --session; repo-match: found by its cwd's git common dir; repo-reference: a
   * session started in a directory above the repository that names the repository in a tool call (any
   * local harness's but Aider's and Amp's: cli/above-session.ts);
   * family: the parent or a subagent of a collected session, taken with it; read-source: an earlier
   * session, in a directory outside the repository, that wrote (or worked on, from a directory holding
   * it) a file a collected session read from there (cli/collect.ts). A kit from before read-source
   * writes none of them, so the enum only widened.
   */
  collected_by: z.enum(['explicit', 'repo-match', 'repo-reference', 'family', 'read-source']),
  first_at: IsoDateTime.nullable(),
  last_at: IsoDateTime.nullable(),
  /** The sidecar files its log points at; a kit from before attachments writes none. */
  attachments: z.array(BundleAttachment).max(MAX_SESSION_ATTACHMENTS).optional(),
});

/**
 * How a context session relates to the evidence session it was linked from (`of`). ancestor: a session
 * that started it, or started that one (a manager briefing a worker, `depth` steps up); sibling: another
 * session the same ancestor started; requester: the session that asked for it (a Muse requester);
 * continued-from: the session it resumed (`/resume`); begun-before: a session of the run that began
 * before a strict recording did, so is never evidence.
 */
export const CONTEXT_SESSION_ROLES = ['ancestor', 'sibling', 'requester', 'continued-from', 'begun-before'] as const;
export const ContextSessionRole = z.enum(CONTEXT_SESSION_ROLES);

/** recorded: the logs name the link (a parent session id); inferred: the CLI matched it (a brief's text, a resume's timing). */
export const CONTEXT_SESSION_LINKS = ['recorded', 'inferred'] as const;
export const ContextSessionLink = z.enum(CONTEXT_SESSION_LINKS);

/**
 * A session the evidence was started from or continued, carried for its context and never as evidence
 * (manifest context_sessions): the same facts as a BundleSession, minus how it was collected, plus how
 * it was linked.
 */
export const BundleContextSession = z.strictObject({
  /** Where the original sits in the archive. */
  path: ContextSessionPath,
  source: TranscriptSource,
  sha256: Sha256Hex,
  bytes: z.int().min(0),
  session_id: z.string().min(1).nullable(),
  parent_session_id: z.string().min(1).nullable(),
  agent_id: z.string().min(1).nullable(),
  /** Where the CLI found it, home-relative (`~/...`); never an absolute home path. */
  original_path: OriginalPath,
  first_at: IsoDateTime.nullable(),
  last_at: IsoDateTime.nullable(),
  role: ContextSessionRole,
  link: ContextSessionLink,
  /** Links from `of` to it: 1 for a direct parent, at most MAX_CONTEXT_DEPTH. */
  depth: z.int().min(1).max(MAX_CONTEXT_DEPTH),
  /** The evidence session it was linked from, by its path in sessions. */
  of: SessionPath,
  /** The sidecar files its log points at, as a BundleSession's. */
  attachments: z.array(BundleAttachment).max(MAX_SESSION_ATTACHMENTS).optional(),
});

/** Turns the entrant asks to leave out (e.g. a manager's brief to a subagent), by message id. */
export const ExcludedTurns = z.strictObject({
  path: SessionPath,
  turns: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
});

/**
 * How the entrant says the agent was run (`makefun bundle`'s flags); unverified. Defined in contracts/run-record.ts,
 * whose loose run file carries it too, and re-exported here as it always was.
 */
export { BundleDeclared };

/** What the CLI detected about where it ran when it bundled. */
export const BundleClient = z.strictObject({
  /** The agent harness the CLI ran inside, when its environment names one. */
  harness: z.string().max(32).nullable(),
  /** The environment markers that named it. */
  markers: z.array(z.string().max(64)).max(32),
  os: z.string().max(32),
  node: z.string().max(32),
  build: z.string().max(64).nullable(),
  ci: z.boolean(),
  tty: z.boolean(),
});

/** What collection found and took, by how; its warnings are the CLI's own notes. */
export const BundleCollection = z.strictObject({
  explicit: z.int().min(0),
  discovered: z.int().min(0),
  family: z.int().min(0),
  unmatched: z.int().min(0),
  vanished_cwds: z.int().min(0),
  context_files: z.int().min(0),
  warnings: z.array(z.string().max(400)).max(50),
});

/**
 * Kits already downloaded keep writing the manifest they shipped with, so a field added after v1 is
 * optional here and the format string stays as it is: a required one would refuse their bundles.
 */
export const BundleManifest = z
  .strictObject({
    format: z.literal(BUNDLE_FORMAT),
    created_at: IsoDateTime,
    tool: z.strictObject({
      name: z.literal('makefun-cli'),
      version: z.string().min(1),
      client: BundleClient.optional(),
    }),
    repo: z.strictObject({
      /** The remote the entry is submitted from, if the checkout has one. */
      remote_url: z.string().min(1).nullable(),
      commit: GitSha.nullable(),
      /** Uncommitted changes in the checkout at bundling time. */
      dirty: z.boolean(),
    }),
    sessions: z.array(BundleSession).min(1),
    excluded_turns: z.array(ExcludedTurns).default([]),
    declared: BundleDeclared.optional(),
    context: z.array(BundleContextFile).max(MAX_CONTEXT_FILES).optional(),
    collection: BundleCollection.optional(),
    /** The sources of the packed entrypoints, one an entry; a kit from before level 6 writes none. */
    packs: z.array(BundlePack).max(MAX_PACKS).optional(),
    /**
     * The run record (contracts/run-record.ts): the person's opening prompt, where the system prompt is and the MCP
     * servers the agent used; the agent facts stay in `declared`. A kit from before it writes none.
     */
    run: RunRecord.optional(),
    /**
     * The sessions the evidence was started from or continued, carried as context and never as evidence;
     * a kit from before context sessions writes none.
     */
    context_sessions: z.array(BundleContextSession).max(MAX_CONTEXT_SESSIONS).optional(),
  })
  .superRefine((m, ctx) => {
    // One archive file one listing: a path is unique across sessions, context sessions, attachments,
    // context files and packs (each kind's own directory keeps the kinds apart, the attachments of
    // two sessions are not).
    const paths = new Set<string>();
    const claim = (p: string, at: (string | number)[]) => {
      if (paths.has(p)) ctx.addIssue({ code: 'custom', path: at, message: `duplicate path ${p}` });
      paths.add(p);
    };
    const ordered = (first_at: string | null, last_at: string | null, at: (string | number)[]) => {
      if (first_at !== null && last_at !== null && Date.parse(first_at) > Date.parse(last_at)) {
        ctx.addIssue({ code: 'custom', path: at, message: 'last_at is before first_at' });
      }
    };
    const sessionPaths = new Set<string>();
    m.sessions.forEach((s, i) => {
      claim(s.path, ['sessions', i, 'path']);
      sessionPaths.add(s.path);
      ordered(s.first_at, s.last_at, ['sessions', i, 'last_at']);
      s.attachments?.forEach((a, j) => claim(a.path, ['sessions', i, 'attachments', j, 'path']));
    });
    m.excluded_turns.forEach((e, i) => {
      if (!sessionPaths.has(e.path)) ctx.addIssue({ code: 'custom', path: ['excluded_turns', i, 'path'], message: `no session at ${e.path}` });
    });
    m.context_sessions?.forEach((c, i) => {
      claim(c.path, ['context_sessions', i, 'path']);
      ordered(c.first_at, c.last_at, ['context_sessions', i, 'last_at']);
      if (!sessionPaths.has(c.of)) ctx.addIssue({ code: 'custom', path: ['context_sessions', i, 'of'], message: `no session at ${c.of}` });
      c.attachments?.forEach((a, j) => claim(a.path, ['context_sessions', i, 'attachments', j, 'path']));
    });
    m.context?.forEach((c, i) => claim(c.path, ['context', i, 'path']));
    // One pack an entry and an archive file a pack (PackPath keeps each under packs/); one source may
    // feed two entries, but only as the same bytes.
    const packEntries = new Set<string>();
    const sourceSha = new Map<string, string>();
    m.packs?.forEach((p, i) => {
      claim(p.path, ['packs', i, 'path']);
      if (packEntries.has(p.entry)) ctx.addIssue({ code: 'custom', path: ['packs', i, 'entry'], message: `duplicate entry ${p.entry}` });
      packEntries.add(p.entry);
      const seen = sourceSha.get(p.source_path);
      if (seen !== undefined && seen !== p.sha256) ctx.addIssue({ code: 'custom', path: ['packs', i, 'sha256'], message: `${p.source_path} is named with two different sha256` });
      if (seen === undefined) sourceSha.set(p.source_path, p.sha256);
    });
  });

export type BundleManifestT = z.infer<typeof BundleManifest>;
export type BundleSessionT = z.infer<typeof BundleSession>;
export type TranscriptSourceT = z.infer<typeof TranscriptSource>;
export type ContextKindT = z.infer<typeof ContextKind>;
export type BundleContextFileT = z.infer<typeof BundleContextFile>;
export type BundleDeclaredT = z.infer<typeof BundleDeclared>;
export type BundleClientT = z.infer<typeof BundleClient>;
export type BundleCollectionT = z.infer<typeof BundleCollection>;
export type BundlePackT = z.infer<typeof BundlePack>;
export type AttachmentKindT = z.infer<typeof AttachmentKind>;
export type BundleAttachmentT = z.infer<typeof BundleAttachment>;
export type ContextSessionRoleT = z.infer<typeof ContextSessionRole>;
export type ContextSessionLinkT = z.infer<typeof ContextSessionLink>;
export type BundleContextSessionT = z.infer<typeof BundleContextSession>;
