// Where a pump.fun entry link's metadata document was read from, worded once for both desks that print it: the admin
// panel's 'Metadata read from' row (src/components/admin/EntryLinkRow.tsx) and its markdown twin (server/entry-link/admin.ts
// renderAdminEntryLink). The panel prints the sentence as the row's value and, for a transcripts reading, the copy note on
// a line of its own; the twin prints the sentence with the note inlined as a lowercase parenthetical, mid-sentence. Both
// read this module, so the words cannot drift; the admin wire type is server/entry-link/types.ts PumpfunMetadataSource.
//
// A leaf: no imports at all, so the server and the web app both read it.

/**
 * The four sources a pump.fun record's metadata_source names, in the order the entry-link stage tries them
 * (server/entry-link/types.ts PumpfunMetadataSource). Repeated here because contracts/ reads nothing from server/; a
 * source added to the wire type stops type-checking at both callers until it is added here and given its wording.
 */
export const METADATA_SOURCES = ['uri', 'pumpfun-api', 'archive', 'transcripts'] as const;
export type MetadataSource = (typeof METADATA_SOURCES)[number];

/**
 * The sentence for each source: the create transaction's own uri, pump.fun's coin API for the mint, an archived copy of
 * the uri, or the entry's own transcripts. The transcripts reading carries TRANSCRIPTS_COPY_NOTE as well; the panel
 * prints the note on its own line, the twin inlines it as a lowercase parenthetical.
 */
export const METADATA_SOURCE_TEXT: Record<MetadataSource, string> = {
  uri: "the coin's own metadata uri",
  'pumpfun-api': "pump.fun's coin API for the mint",
  archive: 'an archived copy of the metadata uri',
  transcripts: "the entry's own transcripts",
};

/**
 * The line under a transcripts reading: the copy is the entrant's own, evidence rather than proof, so a dispute reads it
 * against the coin's live page. Sentence case, as the admin panel prints its notes; the twin lowercases its first letter
 * in the parenthetical it inlines.
 */
export const TRANSCRIPTS_COPY_NOTE = "The entrant's own copy, evidence rather than proof: a dispute should read it against the coin's live page.";

/**
 * Where a record names no source: the field is absent on a record written before it was recorded, or null where no
 * source supplied the document. Lowercase, the twin's mid-sentence form; the panel sentence-cases it as it does its
 * other absent values ('Not answered', 'Not read').
 */
export const METADATA_NOT_RECORDED = 'not recorded';

/**
 * Which desk is reading: the admin panel starts its value as a sentence of its own, so an absent source reads
 * 'Not recorded'; the markdown twin writes mid-sentence, so it stays 'not recorded'.
 */
export type MetadataSourceSurface = 'panel' | 'twin';

/** The two pieces of the wording: the sentence, and the transcripts reading's copy note where it has one. */
export interface MetadataSourceCopy {
  /** The source's sentence, or that the record does not say, in `surface`'s case. */
  sentence: string;
  /** The transcripts reading's copy note in the panel's sentence case (TRANSCRIPTS_COPY_NOTE); null for every other source and for an absent one. */
  note: string | null;
}

/** `s` with its first letter upper-cased: the panel's sentence case for an absent value's one sentence. */
const sentenceCase = (s: string): string => (s === '' ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`);

/** `s` with its first letter lower-cased, where it starts a word: the twin's mid-sentence parenthetical. */
const midSentence = (s: string): string => (/^[A-Z](?![A-Z])/.test(s) ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : s);

/** The note as a parenthetical clause: mid-sentence, and without the sentence's final period (the twin's line ends at the ')'). */
const clause = (s: string): string => midSentence(s.endsWith('.') ? s.slice(0, -1) : s);

/**
 * Where a pump.fun record's metadata document was read from (its metadata_source), as `surface` prints it: the source's
 * sentence, or the not-recorded sentence in the surface's case where the record names none, and the transcripts
 * reading's copy note for that one source alone.
 */
export function metadataSourceCopy(source: MetadataSource | null | undefined, surface: MetadataSourceSurface): MetadataSourceCopy {
  const notRecorded = surface === 'panel' ? sentenceCase(METADATA_NOT_RECORDED) : METADATA_NOT_RECORDED;
  if (source === null || source === undefined) return { sentence: notRecorded, note: null };
  // A source this build does not know (a record written by a newer stage) reads as one the record does not name.
  const sentence = METADATA_SOURCE_TEXT[source];
  if (sentence === undefined) return { sentence: notRecorded, note: null };
  return { sentence, note: source === 'transcripts' ? TRANSCRIPTS_COPY_NOTE : null };
}

/**
 * The markdown twin's whole sentence for the source: metadataSourceCopy in the twin's case, its transcripts note inlined
 * as a lowercase parenthetical clause (the panel prints that note as a sentence on a line of its own, never inline).
 */
export function metadataSourceTwinText(source: MetadataSource | null | undefined): string {
  const copy = metadataSourceCopy(source, 'twin');
  return copy.note === null ? copy.sentence : `${copy.sentence} (${clause(copy.note)})`;
}
