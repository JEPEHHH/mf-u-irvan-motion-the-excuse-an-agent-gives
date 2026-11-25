// A dossier: the judged artifact of a program/v1 judge harness whose medium is 'dossier'
// (contracts/competition.ts PROGRAM_JUDGE_MEDIA, ProgramJudge.media). One JSON file, UTF-8, that holds what
// the house judge reads of an entry: a text and its images, one of them the cover. Wherever the dossier is shown
// publicly its images are, each redrawn as WebP, the cover first (server/routes/archive/artifact.ts, image= by index);
// where one picture stands for it (a share card, a page's lead image, the final kit's heat record at
// <run>/dossier-cover.*) that is the cover alone. Its text and its bytes as sent follow the entry's code rule.
//
//   schema   DOSSIER_SCHEMA, exactly
//   cover    the index in `images` of the cover image
//   text     what the judge reads after the images (for a Roblox game: the place's facts and its scripts)
//   images   1 to DOSSIER_MAX_IMAGES images, each a file name, its media type (PNG or JPEG), the sha256 of
//            its bytes and the bytes in canonical base64 (padded, no line breaks, one spelling per bytes)
//
// parseDossier reads a dossier's bytes and refuses, naming why, anything over DOSSIER_MAX_BYTES (before it
// decodes a byte), bytes that are not UTF-8 JSON, more than DOSSIER_MAX_IMAGES images, a cover that is not
// an index of the list, two images of one name, an image whose bytes are not canonical base64, are not of
// its media type, or do not hash to its sha256. Its writer is sdk/roblox/makefun-roblox.ts buildDossier;
// its readers the grader's judge (grader/judge-call.ts) and the loader's anchor check.
//
// It imports nothing but zod and the primitives: every reader may take it without pulling in the bundle
// contract. It hashes with node:crypto, looked up when a dossier is parsed (process.getBuiltinModule, so
// parsing stays synchronous and the module imports no other).

import { z } from 'zod';
import { Sha256Hex } from './primitives.ts';

/** A dossier's schema tag (Dossier.schema). */
export const DOSSIER_SCHEMA = 'makefun/dossier/v1';

/** The most bytes a dossier file holds: 4 MiB. */
export const DOSSIER_MAX_BYTES = 4 * 1024 * 1024;

/** The most images a dossier holds (Dossier.images). */
export const DOSSIER_MAX_IMAGES = 8;

/** The media types a dossier image is (DossierImage.media_type). */
export const DOSSIER_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg'] as const;
export type DossierImageMediaTypeT = (typeof DOSSIER_IMAGE_MEDIA_TYPES)[number];

/** Each media type's leading bytes: a PNG's signature, a JPEG's start-of-image marker and the next marker's 0xFF. */
const MAGIC: Readonly<Record<DossierImageMediaTypeT, readonly number[]>> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

/** An image's file name: a letter, digit or _ first, then letters, digits and . _ -, 1 to 128 of them, no directory. */
export const DossierImageName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/, 'expected a file name: letters, digits and . _ -, 1 to 128 characters, no directory');

/** One image of a dossier: its file name, its media type, the sha256 of its bytes and its bytes in canonical base64. */
export const DossierImage = z.strictObject({
  name: DossierImageName,
  media_type: z.enum(DOSSIER_IMAGE_MEDIA_TYPES),
  sha256: Sha256Hex,
  /** Canonical: exactly what its bytes encode to in standard padded base64 (checked by decoding it, not by a pattern, which a 4 MiB string would overrun). */
  base64: z.string().min(1),
});

/** Run a refinement only on a value whose shape already parsed. */
const whenValid = { when: (payload: { issues: readonly unknown[] }): boolean => payload.issues.length === 0 };

/** The sha256 of `bytes`, lowercase hex (node:crypto, looked up on first use). */
function sha256Hex(bytes: Uint8Array): string {
  const crypto = process.getBuiltinModule('node:crypto');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Whether `bytes` opens with `magic`. */
const opensWith = (bytes: Uint8Array, magic: readonly number[]): boolean => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

/** A dossier (the header): its schema, its cover's index, its text and its images. */
export const Dossier = z
  .strictObject({
    schema: z.literal(DOSSIER_SCHEMA),
    cover: z.int().min(0),
    text: z.string(),
    images: z.array(DossierImage).min(1, 'a dossier holds at least one image: its cover').max(DOSSIER_MAX_IMAGES, `a dossier holds at most ${DOSSIER_MAX_IMAGES} images`),
  })
  .superRefine((d, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (d.cover >= d.images.length) issue(['cover'], `cover ${d.cover} is not an index of images (0 to ${d.images.length - 1})`);
    const names = new Set<string>();
    d.images.forEach((img, i) => {
      if (names.has(img.name)) issue(['images', i, 'name'], `${img.name} is the name of an earlier image: each image has a name of its own`);
      names.add(img.name);
      const bytes = Buffer.from(img.base64, 'base64');
      if (bytes.toString('base64') !== img.base64) {
        issue(['images', i, 'base64'], `${img.name}: not canonical base64: standard alphabet, padded with =, no line breaks or spaces, unused bits 0 (one spelling per bytes)`);
        return;
      }
      if (!opensWith(bytes, MAGIC[img.media_type])) issue(['images', i, 'media_type'], `${img.name}: its bytes are not ${img.media_type === 'image/png' ? 'a PNG' : 'a JPEG'}`);
      const sha256 = sha256Hex(bytes);
      if (sha256 !== img.sha256) issue(['images', i, 'sha256'], `${img.name}: its bytes hash to ${sha256}, not ${img.sha256}`);
    });
  }, whenValid);
export type DossierT = z.infer<typeof Dossier>;
export type DossierImageT = z.infer<typeof DossierImage>;

/** What parseDossier throws: why a dossier's bytes are refused, each issue `path: message` (or the message alone at the top). */
export class DossierRefused extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`not a dossier (${DOSSIER_SCHEMA}): ${issues.join('; ')}`);
    this.name = 'DossierRefused';
    this.issues = issues;
  }
}

/**
 * A dossier's bytes, parsed (the header), or DossierRefused naming why not: over DOSSIER_MAX_BYTES (refused
 * before a byte is decoded), not UTF-8, not JSON, or not a Dossier.
 */
export function parseDossier(bytes: Uint8Array): DossierT {
  if (bytes.byteLength > DOSSIER_MAX_BYTES) throw new DossierRefused([`${bytes.byteLength} bytes, over the ${DOSSIER_MAX_BYTES} a dossier holds`]);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new DossierRefused(['not UTF-8']);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new DossierRefused([`not JSON: ${(err as Error).message}`]);
  }
  const r = Dossier.safeParse(json);
  if (!r.success) throw new DossierRefused(r.error.issues.map((i) => (i.path.length === 0 ? i.message : `${i.path.join('.')}: ${i.message}`)));
  return r.data;
}
