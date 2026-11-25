// The mail inbox's shared contract: what the hi@make.fun Cloudflare Email Worker's mail becomes in
// email_thread and email_message (server/db/schema.ts), how the triager sorts a thread, and what the
// admin Email inbox shows. A leaf: no Node APIs, no DOM and no import from server/, so the server, the
// worker's types and the web app all read it.
//
//   MAIL_THREAD_STATUSES, MAIL_CATEGORIES      the value lists email_thread.status and .category check
//                                              against, and the admin desk filters by
//   MAIL_CATEGORY_WORDS                        what each category means, as the triager's prompt says it
//   MAIL_DIRECTIONS                            which way an email_message went
//   MAIL_LIMITS, MAIL_MAX_BYTES                every stored field's cap in characters, and a raw MIME's
//                                              cap in bytes
//   MAIL_MAX_AUTO_REPLIES, MAIL_MAX_REPLIES_PER_DAY   the reply budgets: one thread's automatic replies,
//                                              and every reply the inbox sends in a day
//   MAIL_REPLY_SIGNATURE                       what server/mail/send.ts appends to every reply

/**
 * Where a thread stands:
 *   - open: it holds mail with no decision yet (new mail, or a reply that reopened it)
 *   - answered: a reply went out, automatic or a person's
 *   - needs_human: a person must act (escalated); the owner is told, and nothing is sent until they reply
 *   - closed: finished
 */
export const MAIL_THREAD_STATUSES = ['open', 'answered', 'needs_human', 'closed'] as const;
export type MailThreadStatus = (typeof MAIL_THREAD_STATUSES)[number];

/** What a thread is about, as the triager sorted it: each one's meaning is MAIL_CATEGORY_WORDS'. */
export const MAIL_CATEGORIES = ['support', 'bug', 'account', 'billing', 'listing', 'partnership', 'automated', 'spam', 'other'] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

/**
 * What each category means, the words the triager's prompt sorts by (server/mail/prompt.ts). `listing` and
 * `partnership` are the owner's business asks (the failure audit's designed class mail-business-ask keeps them off its
 * board), so an entrant's own case never goes there: the words "a contest or entry listing" once read as "my entry's
 * listing", and every listing thread makefun-prod held by 2026-11-19 (9) was an entrant's own rank, grade, entry limit,
 * late entry or contest rule, none a business ask; those are support, else bug or other.
 */
export const MAIL_CATEGORY_WORDS: Readonly<Record<MailCategory, string>> = {
  support:
    "a question about using make.fun (entering, an entry's status, grade, rank or limits, a contest's rules) or anything else the sheet answers",
  bug: 'something broken',
  account: 'sign-in, deletion, a merge',
  billing: 'a payout, fee or invoice',
  listing:
    "an organisation or a person asking make.fun to list or host their own contest, bounty or product: a business ask, never an entrant's question or appeal about an entry, its grade, rank or limits, or a contest's rules",
  partnership: 'sponsors and press',
  automated: "a notification or a robot's mail, never answered",
  spam: 'a cold pitch or junk',
  other: 'anything else',
};

/** Which way a message went: in (a sender's mail, parsed from the raw MIME) or out (a reply make.fun sent). */
export const MAIL_DIRECTIONS = ['in', 'out'] as const;
export type MailDirection = (typeof MAIL_DIRECTIONS)[number];

/**
 * Each stored text field's cap in characters (code points): the length server/db/schema.ts holds every
 * email_thread and email_message text column to, and what server/mail clips to before it writes one.
 * `address` is RFC 5321's 320 for one mailbox; `messageId` RFC 5322's 998 for one id; `references` the
 * joined References chain of a reply (Resend's documented recipe caps it at 100 entries).
 */
export const MAIL_LIMITS = {
  subject: 500,
  text: 100_000,
  html: 200_000,
  summary: 1000,
  reason: 1000,
  address: 320,
  name: 200,
  messageId: 998,
  references: 4000,
} as const;

/** The largest raw MIME message the inbox ingests (2 MiB); the worker forwards a bigger one to the owner untouched. */
export const MAIL_MAX_BYTES = 2 * 1024 * 1024;

/** The most automatic replies one thread gets; past it the thread escalates to a person instead of answering again. */
export const MAIL_MAX_AUTO_REPLIES = 3;

/** The most replies the inbox sends in any 24 hours, automatic and a person's alike, counted from email_message. */
export const MAIL_MAX_REPLIES_PER_DAY = 60;

/** What every reply ends with, so the reader knows who wrote: server/mail/send.ts appends it, never the model. */
export const MAIL_REPLY_SIGNATURE = '\n\nThanks,\nThe make.fun team';
