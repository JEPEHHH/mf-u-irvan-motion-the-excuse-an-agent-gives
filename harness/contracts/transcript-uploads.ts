// The loose transcript files an entry may upload (no bundle), as the API's upload check takes them
// (transcripts/formats.ts LOOSE_UPLOAD_NAME and LOOSE_UPLOAD_KINDS, read by transcripts/ingest.ts and
// server/routes/submissions.ts), for the web entry form's file picker and checks (src/lib/submissionSpec.ts).
// A leaf: no imports, no Node or DOM APIs, so the browser bundle can import it where it cannot import
// transcripts/formats.ts (the adapters behind it read node: modules). Web code imports it extensionless
// (`../../contracts/transcript-uploads`), server code as `../contracts/transcript-uploads.ts`.
// tests/unit/web-submissionSpec.test.ts pins it equal to transcripts/formats.ts.

/**
 * Each loose kind's file-name ending: JSON lines and JSON documents, a text
 * format's file (Aider's `.aider.chat.history.md`, a Perplexity or Cherry Studio Markdown export, a Copilot coding
 * agent `.sse` log), a SQLite store (`.db`, `.sqlite`, `.sqlite3`, Cursor's `.vscdb`), and a compressed log (an
 * oh-my-pi `.jsonl.gz`, a dsh `.jsonl.zstd`, a Codex or OpenClaw `.jsonl.zst`).
 */
export const LOOSE_UPLOAD_EXTENSIONS = ['.jsonl', '.json', '.md', '.sse', '.db', '.sqlite', '.sqlite3', '.vscdb', '.jsonl.gz', '.jsonl.zst', '.jsonl.zstd'] as const;

/** A file name that ends in one of LOOSE_UPLOAD_EXTENSIONS, any case. */
export const LOOSE_UPLOAD_NAME = new RegExp(`\\.(${LOOSE_UPLOAD_EXTENSIONS.map((e) => e.slice(1).replaceAll('.', '\\.')).join('|')})$`, 'i');

/** LOOSE_UPLOAD_EXTENSIONS in words, for the texts that tell an entrant what to upload. */
export const LOOSE_UPLOAD_KINDS =
  '.jsonl / .json transcripts, Markdown chat histories and exports (.md: Aider, Perplexity, Cherry Studio), a Copilot coding agent log (.sse), SQLite stores (.db / .sqlite / .sqlite3 / .vscdb) and compressed logs (.jsonl.gz / .jsonl.zst / .jsonl.zstd)';
