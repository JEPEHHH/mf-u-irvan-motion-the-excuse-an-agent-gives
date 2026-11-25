// The X DM driver's wire (scripts/x-dm/driver.ts <-> server/xdm/routes.ts). Both requests are signed the Standard
// Webhooks way (webhook-id, webhook-timestamp, webhook-signature over `${id}.${timestamp}.${body}`) under
// MAKEFUN_DISCORD_XDM_DRIVER_SECRET (whsec_<base64>), as deploy/mail/src/sign.ts signs the mail worker's deliveries.
// A leaf: plain types and constants, no imports, so the server and scripts/ both read it.

export const XDM_SYNC_PATH = '/api/webhooks/x-dm/sync';
export const XDM_SENT_PATH = '/api/webhooks/x-dm/sent';
/** @makefunai's X user id: the conversation id's other half is the peer. */
export const XDM_ACCOUNT_USER_ID = '2117745311074693120';
export const XDM_ACCOUNT_HANDLE = 'makefunai';
export const XDM_CONVERSATION_ID_RE = /^[0-9]{1,20}-[0-9]{1,20}$/;
export const XDM_MAX_BODY_BYTES = 1_000_000;
export const XDM_MAX_CONVERSATIONS_PER_SYNC = 40;
export const XDM_MAX_MESSAGES_PER_CONVERSATION = 40;
export const XDM_MAX_MESSAGE_CHARS = 4000;
export const XDM_MAX_OUTBOX_PER_SYNC = 8;

export const XDM_KINDS = ['request', 'request_other', 'inbox'] as const;
export type XdmKind = (typeof XDM_KINDS)[number];
export const XDM_DRIVER_STATES = ['ok', 'signed_out', 'passcode', 'challenged', 'rate_limited', 'error'] as const;
export type XdmDriverState = (typeof XDM_DRIVER_STATES)[number];
export const XDM_ATTACHMENT_KINDS = ['photo', 'video', 'gif', 'file', 'link', 'post', 'other'] as const;
export type XdmAttachmentKind = (typeof XDM_ATTACHMENT_KINDS)[number];

export interface XdmMessageSnapshot {
  /** The bubble's id from data-testid="message-<id>": a uuid, or a numeric id for an older DM. */
  x_message_id: string;
  /** out: written from @makefunai (a person of the team or the bot); in: the peer. */
  direction: 'in' | 'out';
  /** The bubble's text, at most XDM_MAX_MESSAGE_CHARS; '' for a media-only message. */
  text: string;
  /** ISO time when the DOM shows one, else null. */
  at: string | null;
  attachments: { kind: XdmAttachmentKind; label: string | null }[];
}

export interface XdmConversationSnapshot {
  id: string;
  kind: XdmKind;
  peer: {
    x_user_id: string;
    handle: string | null;
    name: string | null;
    verified: boolean;
    followers: number | null;
    /** As X shows it, e.g. "June 2013". */
    joined: string | null;
  };
  /** Oldest first, the last XDM_MAX_MESSAGES_PER_CONVERSATION rendered. */
  messages: XdmMessageSnapshot[];
}

export interface XdmSyncBody {
  driver: { version: string; account: string; state: XdmDriverState; detail: string | null; at: string };
  /** Only conversations changed since the server's `known` (all on a first run), at most XDM_MAX_CONVERSATIONS_PER_SYNC. */
  conversations: XdmConversationSnapshot[];
}

export interface XdmOutboxItem {
  id: string;
  conversation_id: string;
  kind: XdmKind;
  reply: string;
  /** The newest inbound message this reply answers: a newer inbound one at send time makes the reply stale. */
  after_message_id: string;
}

export interface XdmSyncAnswer {
  mode: 'off' | 'shadow' | 'on';
  /** conversation id -> the newest x_message_id the server holds, for the 500 most recently active conversations. */
  known: Record<string, string>;
  /** Due replies, claimed for this driver; [] unless mode is on. */
  outbox: XdmOutboxItem[];
  /** The pacing the server asks for this tick. */
  limits: { min_gap_ms: number; max_gap_ms: number; max_sends: number };
}

export const XDM_SENT_OUTCOMES = ['sent', 'stale', 'failed'] as const;
export type XdmSentOutcome = (typeof XDM_SENT_OUTCOMES)[number];
export interface XdmSentBody {
  id: string;
  outcome: XdmSentOutcome;
  x_message_id: string | null;
  /** A short reason, at most 300 characters, never message text. */
  error: string | null;
}
