// What the kit CLI tells the server about itself on a submit, in one request header
// (SUBMIT_CLIENT_HEADER): base64url of this JSON. Self-reported telemetry, never a credential and
// never trusted for a verdict: the server records it beside the request (submission_request.client),
// and a header that does not decode is recorded with its error, not refused. One refusal reads it, by
// the owner's ruling (2026-11-23): a cli.version stating a kit level (`+kit.<level>`) below the
// full-context level is refused uncounted at intake, telling the copy to download the current kit
// (server/routes/submissions.ts oldKitRefusalOf); a header stating no level, or none at all, is never
// refused by it. Both the CLI and the server import this file, so it imports nothing from either.

import { z } from 'zod';
import { IsoDateTime, Sha256Hex } from './primitives.ts';

export const SUBMIT_CLIENT_HEADER = 'x-makefun-client';
/** Longest accepted header value (the base64url text), characters. */
export const MAX_SUBMIT_CLIENT_CHARS = 8192;

const Text = (max: number) => z.string().min(1).max(max);
const Count = z.int().min(0);
const Counts = z.record(Text(64), Count);

export const SubmitClient = z.strictObject({
  v: z.literal(1),
  cli: z.strictObject({ name: Text(64), version: Text(64), build: Text(128).nullable() }),
  /** process.version. */
  node: Text(32),
  /** `<platform> <arch>`. */
  os: Text(64),
  host: Text(64),
  /** The agent harness the CLI detected it runs under. */
  harness: Text(32).nullable(),
  /** The environment markers that detection read (variable names, never values). */
  markers: z.array(Text(64)).max(32),
  ci: z.boolean(),
  tty: z.boolean(),
  term_program: Text(64).nullable(),
  timezone: Text(64).nullable(),
  locale: Text(64).nullable(),
  kit: z.strictObject({ slug: Text(128), sha256: Sha256Hex.nullable() }).nullable(),
  /** The flag names the command was run with, never their values. */
  flags: z.array(Text(64)).max(64),
  bundle: z
    .strictObject({
      sha256: Sha256Hex,
      bytes: Count,
      created_at: IsoDateTime.nullable(),
      sessions: Count,
      by_source: Counts,
      by_collected: Counts,
      context_files: Count,
      declared: z
        .strictObject({
          harness: Text(64).nullable(),
          harness_version: Text(64).nullable(),
          model: Text(128).nullable(),
          provider: Text(64).nullable(),
          reasoning_effort: Text(32).nullable(),
        })
        .nullable(),
    })
    .nullable(),
  started_at: IsoDateTime,
});

export type SubmitClientT = z.infer<typeof SubmitClient>;

/** The header value for `c`: base64url of its JSON. Throws when `c` is invalid or encodes past MAX_SUBMIT_CLIENT_CHARS. */
export function encodeSubmitClient(c: SubmitClientT): string {
  const json = JSON.stringify(SubmitClient.parse(c));
  const value = base64url(new TextEncoder().encode(json));
  if (value.length > MAX_SUBMIT_CLIENT_CHARS) throw new Error(`${SUBMIT_CLIENT_HEADER} is ${value.length} characters, over ${MAX_SUBMIT_CLIENT_CHARS}`);
  return value;
}

/** A header value read back. Never throws: a bad value is the error to record beside the request. */
export function decodeSubmitClient(value: string): { ok: true; client: SubmitClientT } | { ok: false; error: string } {
  if (value.length > MAX_SUBMIT_CLIENT_CHARS) return { ok: false, error: `over ${MAX_SUBMIT_CLIENT_CHARS} characters (${value.length})` };
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return { ok: false, error: 'not base64url' };
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unbase64url(value)));
  } catch (e) {
    return { ok: false, error: `not UTF-8 JSON: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
  const r = SubmitClient.safeParse(doc);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
    return { ok: false, error: `invalid: ${issues.join('; ')}`.slice(0, 500) };
  }
  return { ok: true, client: r.data };
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
