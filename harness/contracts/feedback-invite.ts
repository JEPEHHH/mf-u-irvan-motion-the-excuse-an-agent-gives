// The invitation test (`feedback_invite`): does the wording of the invitation an agent reads on its own rejected or held
// entry's status change the share of accounts that then file a report. The control is FEEDBACK_INVITE_CONTROL, the
// `owner_reward` arm: every account reads its sentence, inside the test and out, and only the two treatments
// (agent_reward, draft) differ. The bare hint survives as the retired `control` arm, kept only for the exposure rows
// already recorded under it. The arms, their copy and the draft arm's ready-to-send report live here, in one place: the
// server renders them (server/feedback/invite-experiment.ts draws and records the arm; server/routes/entries.ts and
// server/mcp/tools.ts place the words), the makefun CLI prints them (cli/status.ts), and the admin readout names the
// arms by FEEDBACK_INVITE_ARM_LABELS.
//
//   FEEDBACK_INVITE_EXPERIMENT     the experiment's key; FEEDBACK_INVITE_SALT what its draw hashes ahead of the account id
//   FEEDBACK_INVITE_CONTROL        the arm every account reads, `owner_reward`: the test's baseline
//   FEEDBACK_INVITE_ARMS           every arm, control first; FEEDBACK_INVITE_TREATMENTS the two the draw picks among,
//                                  in draw order
//   FEEDBACK_INVITE_ARM_LABELS     each arm in plain words, for an admin (the retired `control` arm's is 'The invitation
//                                  alone': the hint with no added words)
//   FEEDBACK_INVITE_VIAS           the surfaces an arm is read on (http, mcp, cli); FEEDBACK_INVITE_VIA_LABELS each in
//                                  one word, for an admin
//   FEEDBACK_INVITE_SHOWN_HEADER   the request header by which a makefun CLI says it prints the invitation its status
//                                  read answers, and FEEDBACK_INVITE_SHOWN, its one value
//   FEEDBACK_INVITE_OWNER_REWARD … the two reward sentences, differing only in who benefits; the owner's is the control's
//   feedbackDraft                  the draft arm's report, ready to send once the agent writes its one blank
//   feedbackDraftCommand           the same report as a `makefun feedback` command, for the CLI: its details piped in
//   feedbackInviteWords            an arm's words, after the hint inside its one issue message ('' for the retired arm)
//   feedbackInviteTwin             the same for the markdown twin: the words after the hint line, and the draft's object
//                                  for its fenced json block or its command for a fenced sh block
//   feedbackInvitation             the invitation's one message: the hint, then the control's or an arm's words
//   isFeedbackInvitation           whether a message is that invitation worded for a surface
//
// The words ride the invitation's own issue (the one starting with FEEDBACK_HINT_LEAD), so an answer still carries
// exactly one invitation. A leaf like contracts/feedback.ts: no Node APIs, no DOM and no import from server/. Every
// sentence holds to the wording rules tests/unit/feedback-contract.test.ts holds the feedback sentences to. The arm's key
// is never sent to an agent: only its words are.
//
// The exposure (server/feedback/invite-experiment.ts feedbackInviteArmFor; feedback_invite_exposure, server/db/schema.ts):
// every account whose agent reads the invitation is recorded, at any share, 0 included. The row is every account that
// read the words, not only the accounts the share draws into a treatment: the share chooses which arm's words a read
// shows (the draw gives the control when it is 0; a row already written keeps its arm), never whether the read is
// recorded. That record is what a promised reward is granted on (server/feedback/admin.ts INVITE_REWARD_ARMS), so at
// a 0 share every account that reads the control's sentence holds its row.
//
// The makefun CLI is in the test only where it shows the words. `makefun status` used to print a closing line of its
// own and never the server's, so the server left every CLI read out. A CLI that prints the invitation its status read
// answers says so on that read with FEEDBACK_INVITE_SHOWN_HEADER, and only such a read is drawn, recorded (surface
// `cli`) and worded for the command line: at a 0 share those words are the control's sentence, on a line of their own
// after the hint. A CLI that sends no such header (every copy installed before this) stays outside the test, its answer
// worded for http (the hint alone, never the control's words) and its own closing line printed, nothing recorded. On
// the command line
// the hint ends in a command, so the arm's words follow it on a line of their own (feedbackInvitation), and the draft
// is a command to run, not an object to send (feedbackDraftCommand).

import { FEEDBACK_COMMAND, FEEDBACK_ROUTE, FEEDBACK_TOOL, feedbackHint, type FeedbackHintVia, type FeedbackKind } from './feedback.ts';

/** The experiment's key. */
export const FEEDBACK_INVITE_EXPERIMENT = 'feedback_invite';
/** What the draw hashes ahead of the account id (server/feedback/invite-experiment.ts inviteDrawOf). */
export const FEEDBACK_INVITE_SALT = `${FEEDBACK_INVITE_EXPERIMENT}:v1:`;

/** The arm every account reads, `owner_reward`: the control that every treatment arm is read against. */
export const FEEDBACK_INVITE_CONTROL = 'owner_reward';

/** Every arm, control first; then the retired `control` arm, then the treatments in draw order. */
export const FEEDBACK_INVITE_ARMS = [FEEDBACK_INVITE_CONTROL, 'control', 'agent_reward', 'draft'] as const;
export type FeedbackInviteArm = (typeof FEEDBACK_INVITE_ARMS)[number];
/** The arms the draw picks among, in draw order: an account in the test's share sees its one fixed treatment arm. */
export const FEEDBACK_INVITE_TREATMENTS = ['agent_reward', 'draft'] as const satisfies readonly Exclude<FeedbackInviteArm, typeof FEEDBACK_INVITE_CONTROL | 'control'>[];
export type FeedbackInviteTreatment = (typeof FEEDBACK_INVITE_TREATMENTS)[number];

/** Each arm in plain words, for an admin (never shown to an agent); `control` is the retired arm's key. */
export const FEEDBACK_INVITE_ARM_LABELS: Readonly<Record<FeedbackInviteArm, string>> = {
  owner_reward: 'A reward for the person the agent works for',
  control: 'The invitation alone',
  agent_reward: 'A reward for the agent',
  draft: 'A report ready to send',
};

/**
 * How the caller read the arm's words: the HTTP status route, the get_entry_status tool on POST /mcp, or `makefun
 * status` from a makefun CLI that prints the server's invitation (FEEDBACK_INVITE_SHOWN_HEADER).
 */
export const FEEDBACK_INVITE_VIAS = ['http', 'mcp', 'cli'] as const;
export type FeedbackInviteVia = (typeof FEEDBACK_INVITE_VIAS)[number];

/** Each surface in one word, for an admin (the readout's line of accounts by the surface that first showed them an arm). */
export const FEEDBACK_INVITE_VIA_LABELS: Readonly<Record<FeedbackInviteVia, string>> = { http: 'HTTP', mcp: 'MCP', cli: 'CLI' };

/**
 * The request header a makefun CLI sends on a status read whose answer it shows: `makefun status --submission`, which
 * prints the invitation the answer carries as its closing lines, or with --json passes the answer through whole
 * (cli/status.ts). The server draws and records a makefun CLI (by its User-Agent) only on a read that carries it
 * (server/feedback/invite-experiment.ts inviteViaOf), so an account is never recorded as shown words its client drops.
 * Named as the CLI's other headers are (x-makefun-client, x-makefun-kit-level).
 */
export const FEEDBACK_INVITE_SHOWN_HEADER = 'x-makefun-invitation';
/** That header's one value. */
export const FEEDBACK_INVITE_SHOWN = 'shown';

export function isFeedbackInviteArm(value: unknown): value is FeedbackInviteArm {
  return typeof value === 'string' && (FEEDBACK_INVITE_ARMS as readonly string[]).includes(value);
}

/** owner_reward's sentence: the control's words, read after the hint by every account. */
export const FEEDBACK_INVITE_OWNER_REWARD = 'A report that leads to a fix can earn the person you work for a reward, which this account can then claim.';
/** agent_reward's sentence: the same but for who benefits. */
export const FEEDBACK_INVITE_AGENT_REWARD = 'A report that leads to a fix can earn you a reward, which this account can then claim.';

/** The server's own facts about the status an arm is read on. */
export interface FeedbackInviteFacts {
  /** How the caller reads it: the HTTP route (surface api), the MCP tool (surface mcp) or the makefun CLI (surface cli). */
  via: FeedbackInviteVia;
  /** The entry's stage: only a rejected or held one is invited. */
  stage: 'rejected' | 'held';
  /** The first failed check's id: the hint's operation is `check <id>`. */
  check: string;
  /** The problem's title: the first failed check's, as the registry words it. */
  title: string;
  /** The competition's slug. */
  competition: string;
}

/**
 * draft's sentences, before the report it hands over: what the report is, its one blank, and how to send it. The `<id>`
 * and the send clause are the only parts that vary (feedbackInviteWords). For the CLI the report is a command on the
 * line below (feedbackDraftCommand), its one blank what is piped into it.
 */
export function feedbackDraftLead(check: string, via: FeedbackInviteVia): string {
  if (via === 'cli') {
    return (
      `The command below is filled in from this status, and reports about check ${check} are read together. ` +
      'Pipe what you tried, what happened and what you expected into it on standard input; change --kind to bug if the check judged your entry wrongly.'
    );
  }
  const send = via === 'mcp' ? `pass the object as the arguments of ${FEEDBACK_TOOL}` : `send the object as the body of ${FEEDBACK_ROUTE}`;
  return (
    `This report is filled in from this status, and reports about check ${check} are read together. ` +
    `Write in "details" what you tried, what happened and what you expected, then ${send}; set "kind" to "bug" if the check judged your entry wrongly.`
  );
}

/**
 * A report POST /api/feedback takes as its body and submit_feedback as its arguments once `details` holds the agent's
 * words. `details` is empty on purpose: both refuse an empty one, so a report sent unfilled is refused and stores nothing.
 */
export interface FeedbackDraft {
  kind: Extract<FeedbackKind, 'confusing'>;
  summary?: string;
  details: '';
  surface: 'api' | 'mcp' | 'cli';
  operation?: string;
  error?: string;
  competition?: string;
}

/** Whether `value` passes the quoting rule feedbackHint holds an operation to (no quote, backtick, backslash, dollar or control character). */
function quotable(value: string): boolean {
  try {
    feedbackHint(value, 'http');
    return true;
  } catch {
    return false;
  }
}

/**
 * The draft arm's report, keys in this order: kind, summary ("Entry rejected by check <id>" or "Entry held by check
 * <id>"), details (the one blank), surface (where the status was read: api, mcp or cli), operation (the hint's own
 * `check <id>`), error (the problem's title) and competition (the slug). Every filled value is the server's own string; one that fails feedbackHint's quoting rule
 * leaves its key out.
 */
export function feedbackDraft(facts: FeedbackInviteFacts): FeedbackDraft {
  const filled = (value: string): string | undefined => (quotable(value) ? value : undefined);
  const draft: FeedbackDraft = {
    kind: 'confusing',
    summary: filled(`Entry ${facts.stage} by check ${facts.check}`),
    details: '',
    surface: facts.via === 'http' ? 'api' : facts.via,
    operation: filled(`check ${facts.check}`),
    error: filled(facts.title),
    competition: filled(facts.competition),
  };
  return Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)) as unknown as FeedbackDraft;
}

/**
 * Whether `value` can stand as one double-quoted argument after its flag on a command line: it passes the quoting rule
 * (quotable), it holds no exclamation mark, which an interactive shell expands inside double quotes, and it does not
 * open with a dash, which `makefun feedback` (node:util parseArgs) would read as a flag.
 */
function argumentable(value: string): boolean {
  return quotable(value) && !value.includes('!') && !value.startsWith('-');
}

/**
 * The draft arm's report as a `makefun feedback` command, for a status read through the makefun CLI: the JSON draft's
 * fields in its order, each a flag of the command (kind, summary, surface cli, operation, error and competition), and
 * --stdin where the JSON draft has its blank: the agent's own account of what happened is piped in. Run with nothing
 * piped in it is refused before anything is sent (cli/feedback.ts), so an unfilled draft files nothing. Every filled
 * value is the server's own string in double quotes; one that fails the quoting rule, holds an exclamation mark or
 * opens with a dash leaves its flag out (argumentable).
 */
export function feedbackDraftCommand(facts: FeedbackInviteFacts): string {
  const flag = (name: string, value: string): string[] => (argumentable(value) ? [`--${name} "${value}"`] : []);
  return [
    FEEDBACK_COMMAND,
    '--kind confusing',
    ...flag('summary', `Entry ${facts.stage} by check ${facts.check}`),
    '--surface cli',
    ...flag('operation', `check ${facts.check}`),
    ...flag('error', facts.title),
    ...flag('competition', facts.competition),
    '--stdin',
  ].join(' ');
}

/**
 * An arm's words as the markdown twin places them: after the hint, and the draft's report in a fenced block under them
 * (its object as json, or for the CLI its command as sh).
 */
export interface FeedbackInviteTwin {
  /** What follows the hint (feedbackInvitation): the control's sentence, or '' for the retired `control` arm. */
  words: string;
  /** The draft's object as one line of JSON, the block after the hint line; null for every other arm, and for the CLI. */
  json: string | null;
  /** The draft's `makefun feedback` command, for the CLI alone; null for every other arm and surface. */
  command: string | null;
}

/** The markdown twin's form of an arm's words (see FeedbackInviteTwin). */
export function feedbackInviteTwin(arm: FeedbackInviteArm, facts: FeedbackInviteFacts): FeedbackInviteTwin {
  if (arm === FEEDBACK_INVITE_CONTROL) return { words: FEEDBACK_INVITE_OWNER_REWARD, json: null, command: null };
  if (arm === 'control') return { words: '', json: null, command: null };
  if (arm === 'agent_reward') return { words: FEEDBACK_INVITE_AGENT_REWARD, json: null, command: null };
  if (arm === 'draft') {
    const words = feedbackDraftLead(facts.check, facts.via);
    return facts.via === 'cli' ? { words, json: null, command: feedbackDraftCommand(facts) } : { words, json: JSON.stringify(feedbackDraft(facts)), command: null };
  }
  throw new Error(`feedbackInviteTwin: no such arm: ${JSON.stringify(arm)}`);
}

/**
 * An arm's words, set after the hint inside the invitation's one issue message (feedbackInvitation; server/entries/
 * problem.ts problemInvited): the control's reward sentence for FEEDBACK_INVITE_CONTROL, and '' for the retired `control`
 * arm, whose message is the hint alone. The draft's report follows its sentences in the same message: its object after
 * one space, or for the CLI its command on the next line, where it can be run as printed.
 */
export function feedbackInviteWords(arm: FeedbackInviteArm, facts: FeedbackInviteFacts): string {
  const { words, json, command } = feedbackInviteTwin(arm, facts);
  if (command !== null) return `${words}\n${command}`;
  return json === null ? words : `${words} ${json}`;
}

/**
 * What parts the hint from an arm's words inside the invitation's one message: one space, or for the CLI a line break,
 * since its hint ends in a command and words set after it on the same line would read as that command's arguments.
 */
const afterHint = (via: FeedbackHintVia): string => (via === 'cli' ? '\n' : ' ');

/**
 * The invitation's one message: feedbackHint(`operation`, `via`), then `words` (an arm's, feedbackInviteWords; the
 * control's sentence when a caller passes none, '' for the retired `control` arm's hint alone). Throws as feedbackHint
 * does on an operation that cannot be quoted.
 */
export function feedbackInvitation(operation: string, via: FeedbackHintVia, words = FEEDBACK_INVITE_OWNER_REWARD): string {
  const hint = feedbackHint(operation, via);
  return words === '' ? hint : `${hint}${afterHint(via)}${words}`;
}

/**
 * Whether `message` is the invitation for `operation` worded for `via`: feedbackHint's line alone, or followed by
 * words of its own (feedbackInvitation). False, never a throw, for an operation that cannot be quoted. The CLI tells
 * the server's invitation for the command line from the HTTP one an older server answers with.
 */
export function isFeedbackInvitation(message: string, operation: string, via: FeedbackHintVia): boolean {
  let hint: string;
  try {
    hint = feedbackHint(operation, via);
  } catch {
    return false;
  }
  return message === hint || message.startsWith(`${hint}${afterHint(via)}`);
}
