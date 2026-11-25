// Every form an entry secret's value can take in what a run prints, and the masker that takes them out.
// The server, the grader, the gateway forwarder and the CLI all share it, so it imports Node's built-ins
// only (grader/gateway/bundle.ts inlines it into the forwarder's one-file bundle).
//
//   secretForms(value)          every form of the value at least SECRET_FORM_MIN_CHARS long, deduped,
//                               longest first: the value (and the value trimmed); each line of a
//                               multi-line value, trimmed (PEM armor lines are public and left out);
//                               base64, standard and URL-safe, padded and unpadded, at all 3 byte
//                               alignments, each down to its stable inner run (below); percent-encoding
//                               (encodeURIComponent, its `+`-for-space variant, RFC 3986's strict set
//                               with and without `+`, and the WHATWG form encoding URLSearchParams
//                               writes); the JSON string escape (JSON.stringify's, and the ASCII-only
//                               one Python's json.dumps writes); hex, lower and upper case; and the
//                               value's sha256 as hex (both cases) and as base64 (standard and
//                               URL-safe, padded and unpadded).
//   new FormSet(forms)          forms compiled once into the matcher, an Aho-Corasick automaton built on
//                               first use: over UTF-16 code units for text and over UTF-8 bytes for
//                               buffers, or one for both when every form is ASCII. Every function below
//                               takes a FormSet or a plain list (compiled for that one call).
//   maskText(text, forms, mark) every maximal run of text that some occurrence of some form covers,
//                               replaced by one `mark`, in one pass of one combined matcher: overlapping
//                               and adjacent occurrences merge, so a longer form always wins over a
//                               shorter one inside it and no character of any occurrence survives.
//   maskBytes(buf, forms, mark) the same over bytes, each form matched as its UTF-8 bytes.
//   TextMasker / BytesMasker    the streaming masker for stdout, stderr and bodies: push(chunk) answers
//                               what is final, end() the rest. A chunk's tail is held back only while it
//                               could still begin an occurrence (the matcher's live suffix: at most the
//                               longest form − 1 units, and nothing at all once no form can continue it,
//                               so a line end no form holds is never kept waiting). However the stream is
//                               cut, the output is byte for byte maskText's (or maskBytes') of the whole.
//   findForms(buf, formsByName) for scans: which NAME's forms occur and where ([start, end) in the
//                               input's units: bytes for a buffer, UTF-16 code units for a string),
//                               overlapping and adjacent occurrences of one name merged. A hit holds the
//                               name and the offsets only, never the value or the form that matched.
//
// Base64's stable inner run. A value embedded in a longer byte stream starts at some offset whose
// remainder mod 3 (its alignment) decides which base64 characters its bytes land in. Characters that
// mix a value bit with a neighbour's bit change with the neighbour; the run of characters built from
// value bits alone is the same wherever the value sits at that alignment. That inner run is the form
// that always appears, as the GitHub runner's Base64StringEscape/Shift1/Shift2 encoders mask each
// alignment; the tail forms (the run plus the partial character, padded or not) appear where the value
// ends the encoded data, and are longer, so they are masked whole there.

import { createHash } from 'node:crypto';

/** The fewest characters (code points) a form has: a shorter one cannot be masked reliably (contracts/entry-secrets.ts ENTRY_SECRET_VALUE_MIN_CHARS). */
export const SECRET_FORM_MIN_CHARS = 8;
/** What stands in for a masked run unless a caller names another mark (the GitHub runner's). */
export const SECRET_MARK = '***';

// ------------------------------------------------------------------ forms

export interface SecretFormsOptions {
  /**
   * Each line of a multi-line value as a form of its own (default true). A scan for a value pasted
   * elsewhere may turn it off: a line such as `"type": "service_account",` of a JSON credential is
   * masked harmlessly but would make a false hit.
   */
  lines?: boolean;
}

/** A PEM (or PGP, or OpenSSH) armor line: the same in every key of its kind, so no form of the secret. */
const PEM_ARMOR_RE = /^-----(?:BEGIN|END) [A-Z0-9][A-Z0-9 ]*-----$/;
const LINE_BREAK_RE = /\r\n|\r|\n/;

/** Whether `form` has at least SECRET_FORM_MIN_CHARS code points. */
function longEnough(form: string): boolean {
  if (form.length < SECRET_FORM_MIN_CHARS) return false;
  // A code point is at most two UTF-16 code units.
  if (form.length >= 2 * SECRET_FORM_MIN_CHARS) return true;
  let n = 0;
  for (const _ of form) if (++n >= SECRET_FORM_MIN_CHARS) return true;
  return false;
}

/** The URL-safe alphabet's spelling of standard base64 (padding kept). */
function base64url(standard: string): string {
  return standard.replaceAll('+', '-').replaceAll('/', '_');
}

/**
 * `bytes` in base64 at alignments 0, 1 and 2 (the value starting at a stream offset ≡ 0, 1 or 2 mod 3),
 * each as the padded tail, the unpadded tail and the stable inner run, in both alphabets. At alignment
 * a, character k covers stream bits [6k, 6k + 6) and the value bits [8a, 8a + 8n): the run is the
 * characters wholly inside, from ⌈8a/6⌉ to ⌊(8a + 8n)/6⌋.
 */
function base64Forms(bytes: Buffer): string[] {
  const out: string[] = [];
  for (let a = 0; a < 3; a++) {
    const encoded = (a === 0 ? bytes : Buffer.concat([Buffer.alloc(a), bytes])).toString('base64');
    const bits = 8 * (a + bytes.length);
    const from = Math.ceil((8 * a) / 6);
    const tails = [encoded.slice(from), encoded.slice(from, Math.ceil(bits / 6)), encoded.slice(from, Math.floor(bits / 6))];
    for (const form of tails) out.push(form, base64url(form));
  }
  return out;
}

/** encodeURIComponent's output with `!'()*` escaped too, leaving only RFC 3986's unreserved characters, as Python's quote(safe='') writes. */
function strictPercent(uric: string): string {
  return uric.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `text` percent-encoded the ways URLs, query strings and form bodies spell it. */
function percentForms(text: string): string[] {
  const uric = encodeURIComponent(text);
  const strict = strictPercent(uric);
  const form = new URLSearchParams([['', text]]).toString().slice(1);
  return [uric, uric.replaceAll('%20', '+'), strict, strict.replaceAll('%20', '+'), form];
}

/** `text` inside a JSON string: JSON.stringify's escape, and the ASCII-only one (every code unit past 0x7e as \uXXXX, lowercase, as Python's json.dumps writes). */
function jsonForms(text: string): string[] {
  const json = JSON.stringify(text).slice(1, -1);
  const ascii = json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return [json, ascii];
}

/** Every encoded form of one spelling of the value. */
function encodedForms(base: string): string[] {
  const text = base.isWellFormed() ? base : base.toWellFormed();
  const bytes = Buffer.from(text, 'utf8');
  const hex = bytes.toString('hex');
  const digest = createHash('sha256').update(bytes).digest();
  const digestHex = digest.toString('hex');
  const digest64 = digest.toString('base64');
  const digest64url = digest.toString('base64url');
  return [
    base,
    ...base64Forms(bytes),
    ...percentForms(text),
    ...jsonForms(base),
    hex,
    hex.toUpperCase(),
    digestHex,
    digestHex.toUpperCase(),
    digest64,
    digest64.replace(/=+$/, ''),
    digest64url,
    `${digest64url}=`,
  ];
}

/**
 * Every form of `value` at least SECRET_FORM_MIN_CHARS code points long, deduped, longest first (ties in
 * code unit order). The value's leading and trailing whitespace is trimmed off for a second spelling
 * with forms of its own (a PEM pushed with its final newline is printed without it as often as with).
 */
export function secretForms(value: string, opts: SecretFormsOptions = {}): string[] {
  const forms = new Set<string>();
  const add = (form: string): void => {
    if (longEnough(form)) forms.add(form);
  };
  for (const base of new Set([value, value.trim()])) {
    if (base !== '') for (const form of encodedForms(base)) add(form);
  }
  if (opts.lines !== false && LINE_BREAK_RE.test(value)) {
    for (const line of value.split(LINE_BREAK_RE)) {
      const trimmed = line.trim();
      if (!PEM_ARMOR_RE.test(trimmed)) add(trimmed);
    }
  }
  return [...forms].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

// ------------------------------------------------------------------ the matcher

/**
 * An Aho-Corasick automaton over code units (alphabet 65536) or bytes (256). State 0 is the root. In
 * a trie every other state has exactly one incoming edge, so a state's number names its edge too:
 * `unit[t]` is the unit on the edge into t and `sibling[t]` the next child of t's parent.
 */
interface Automaton {
  /** The state after reading a unit at the root (0: the root itself). */
  root: Int32Array;
  /** A state's first child (0: none). */
  child: Int32Array;
  sibling: Int32Array;
  unit: Uint16Array;
  /** The state of the longest proper suffix of a state's string that is a state too. */
  fail: Int32Array;
  /** A state's string length. */
  depth: Int32Array;
  /** The longest pattern that is a suffix of a state's string, by length (0: none). */
  out: Int32Array;
  /** The deepest state on a state's fail chain (itself included) with a child, by depth: how much of what was read could still begin a match. */
  live: Int32Array;
  /** The pattern ending exactly at a state, by index (-1: none). */
  pattern: Int32Array;
  /** The nearest state on a state's proper fail chain that ends a pattern (-1: none). */
  dict: Int32Array;
  /** The longest pattern, in units. */
  maxLength: number;
}

function buildAutomaton(patterns: readonly (string | Uint8Array)[], alphabet: number): Automaton {
  let capacity = 1;
  for (const p of patterns) capacity += p.length;
  const child = new Int32Array(capacity);
  const sibling = new Int32Array(capacity);
  const unit = new Uint16Array(capacity);
  const depth = new Int32Array(capacity);
  const pattern = new Int32Array(capacity).fill(-1);
  const root = new Int32Array(alphabet);
  let n = 1;
  let maxLength = 0;
  for (let index = 0; index < patterns.length; index++) {
    const p = patterns[index];
    const text = typeof p === 'string';
    let s = 0;
    for (let i = 0; i < p.length; i++) {
      const c = text ? p.charCodeAt(i) : (p as Uint8Array)[i];
      let t: number;
      if (s === 0) t = root[c];
      else for (t = child[s]; t !== 0 && unit[t] !== c; t = sibling[t]);
      if (t === 0) {
        t = n++;
        unit[t] = c;
        depth[t] = depth[s] + 1;
        sibling[t] = child[s];
        child[s] = t;
        if (s === 0) root[c] = t;
      }
      s = t;
    }
    if (s !== 0) pattern[s] = index;
    if (p.length > maxLength) maxLength = p.length;
  }

  const fail = new Int32Array(n);
  const out = new Int32Array(n);
  const live = new Int32Array(n);
  const dict = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let t = child[0]; t !== 0; t = sibling[t]) queue[tail++] = t;
  // Breadth first, so a state's fail target (shallower) is done before the state itself.
  while (head < tail) {
    const s = queue[head++];
    const f0 = fail[s];
    out[s] = pattern[s] >= 0 ? depth[s] : out[f0];
    live[s] = child[s] !== 0 ? depth[s] : live[f0];
    dict[s] = pattern[f0] >= 0 ? f0 : dict[f0];
    for (let t = child[s]; t !== 0; t = sibling[t]) {
      const c = unit[t];
      let g = 0;
      for (let f = f0; ; f = fail[f]) {
        if (f === 0) {
          g = root[c];
          break;
        }
        for (g = child[f]; g !== 0 && unit[g] !== c; g = sibling[g]);
        if (g !== 0) break;
      }
      fail[t] = g;
      queue[tail++] = t;
    }
  }
  return {
    root,
    child: child.slice(0, n),
    sibling: sibling.slice(0, n),
    unit: unit.slice(0, n),
    fail,
    depth: depth.slice(0, n),
    out,
    live,
    pattern: pattern.slice(0, n),
    dict,
    maxLength,
  };
}

/** What a scan tells of each position where some pattern ends: its end (absolute), the longest such pattern's length, and the state. */
interface Sink {
  hit(end: number, length: number, state: number): void;
}

/** Run `a` over `text` from `state`, `base` being text[0]'s absolute position; the state it ends in. */
function scanText(a: Automaton, text: string, state: number, base: number, sink: Sink): number {
  const { root, child, sibling, unit, fail, out } = a;
  let s = state;
  for (let i = 0, n = text.length; i < n; i++) {
    const c = text.charCodeAt(i);
    for (;;) {
      if (s === 0) {
        s = root[c];
        break;
      }
      let t = child[s];
      while (t !== 0 && unit[t] !== c) t = sibling[t];
      if (t !== 0) {
        s = t;
        break;
      }
      s = fail[s];
    }
    if (out[s] !== 0) sink.hit(base + i + 1, out[s], s);
  }
  return s;
}

/** scanText over bytes. */
function scanBytes(a: Automaton, bytes: Uint8Array, state: number, base: number, sink: Sink): number {
  const { root, child, sibling, unit, fail, out } = a;
  let s = state;
  for (let i = 0, n = bytes.length; i < n; i++) {
    const c = bytes[i];
    for (;;) {
      if (s === 0) {
        s = root[c];
        break;
      }
      let t = child[s];
      while (t !== 0 && unit[t] !== c) t = sibling[t];
      if (t !== 0) {
        s = t;
        break;
      }
      s = fail[s];
    }
    if (out[s] !== 0) sink.hit(base + i + 1, out[s], s);
  }
  return s;
}

const automata = new WeakMap<object, { text?: Automaton; bytes?: Automaton }>();
const ASCII_RE = /^[\x00-\x7f]*$/;

/**
 * The automaton of `owner`'s patterns for one alphabet, built on first use. ASCII patterns are the same
 * units as text and as bytes, so then one automaton (over code units, which a byte indexes as well)
 * serves both.
 */
function automatonOf(owner: object, patterns: readonly string[], kind: 'text' | 'bytes'): Automaton {
  let held = automata.get(owner);
  if (held === undefined) automata.set(owner, (held = {}));
  const built = held[kind];
  if (built !== undefined) return built;
  const ascii = patterns.every((p) => ASCII_RE.test(p));
  const automaton =
    kind === 'text' || ascii ? buildAutomaton(patterns, 0x10000) : buildAutomaton(patterns.map((p) => Buffer.from(p, 'utf8')), 0x100);
  held[kind] = automaton;
  if (ascii) held.text = held.bytes = automaton;
  return automaton;
}

/** A set of forms compiled for masking, reusable across every call and stream. */
export class FormSet {
  /** The forms, deduped, empty strings dropped, in the order given. */
  readonly forms: readonly string[];

  constructor(forms: Iterable<string>) {
    this.forms = Object.freeze([...new Set(forms)].filter((f) => f !== ''));
  }

  /** The longest form in UTF-16 code units: a TextMasker holds back at most one fewer. */
  get maxChars(): number {
    return automatonOf(this, this.forms, 'text').maxLength;
  }

  /** The longest form in UTF-8 bytes: a BytesMasker holds back at most one fewer. */
  get maxBytes(): number {
    return automatonOf(this, this.forms, 'bytes').maxLength;
  }
}

function formSet(forms: readonly string[] | FormSet): FormSet {
  return forms instanceof FormSet ? forms : new FormSet(forms);
}

// ------------------------------------------------------------------ the masker

/**
 * Add [start, end) to `runs` (flat [start, end) pairs, ascending, never touching), `end` being at least
 * every end already there: the new run swallows every run it reaches, adjacent ones included. The
 * common case (it reaches only the last run) updates that run in place, so a stream where a form ends
 * at every position never reallocates the array.
 */
function addRun(runs: number[], start: number, end: number): void {
  let n = runs.length;
  if (n === 0 || runs[n - 1] < start) {
    runs.push(start, end);
    return;
  }
  let s = runs[n - 2] < start ? runs[n - 2] : start;
  n -= 2;
  while (n !== 0 && runs[n - 1] >= s) {
    if (runs[n - 2] < s) s = runs[n - 2];
    n -= 2;
  }
  runs[n] = s;
  runs[n + 1] = end;
  if (runs.length !== n + 2) runs.length = n + 2;
}

/**
 * A stream's masking state, whatever its units. Positions are absolute (units since the stream began).
 * `runs` holds the covered runs not yet wholly written ([start, end) pairs, flat, ascending, never
 * touching: adjacent ones merge); everything before `emitted` is written, everything from it to `pos`
 * is held.
 */
class MaskCore implements Sink {
  readonly automaton: Automaton;
  state = 0;
  pos = 0;
  emitted = 0;
  /** Whether the last unit written was covered (so a run continuing past the write point gets no second mark). */
  inMark = false;
  runs: number[] = [];

  constructor(automaton: Automaton) {
    this.automaton = automaton;
  }

  hit(end: number, length: number): void {
    addRun(this.runs, end - length, end);
  }

  /** How far the stream is final: a later occurrence starts no earlier than the live suffix of what was read. */
  get final(): number {
    return this.pos - this.automaton.live[this.state];
  }

  /** Write [emitted, upto): raw(from, to) for each uncovered stretch, mark() once per covered run. */
  render(upto: number, raw: (from: number, to: number) => void, mark: () => void): void {
    const runs = this.runs;
    let cursor = this.emitted;
    let done = 0;
    for (let k = 0; k < runs.length; k += 2) {
      const start = runs[k];
      const end = runs[k + 1];
      if (start >= upto) break;
      const from = start > cursor ? start : cursor;
      if (from > cursor) {
        raw(cursor, from);
        this.inMark = false;
      }
      if (!this.inMark) mark();
      this.inMark = true;
      cursor = end < upto ? end : upto;
      if (end > upto) break;
      done = k + 2;
    }
    if (done !== 0) runs.splice(0, done);
    if (cursor < upto) {
      raw(cursor, upto);
      this.inMark = false;
    }
    this.emitted = upto;
  }

  reset(): void {
    this.state = 0;
    this.pos = 0;
    this.emitted = 0;
    this.inMark = false;
    this.runs = [];
  }
}

/**
 * Masks forms out of a text stream (stdout, stderr, a decoded body): push(chunk) answers the text that is
 * final, end() the rest, and the whole output equals maskText of the whole input however it was cut.
 * end() makes it ready for a new stream.
 */
export class TextMasker {
  readonly #core: MaskCore | null;
  readonly #mark: string;
  #held = '';

  constructor(forms: readonly string[] | FormSet, mark: string = SECRET_MARK) {
    const set = formSet(forms);
    this.#core = set.forms.length === 0 ? null : new MaskCore(automatonOf(set, set.forms, 'text'));
    this.#mark = mark;
  }

  /** How many code units are held back, waiting on the next chunk. */
  get held(): number {
    return this.#held.length;
  }

  push(chunk: string): string {
    const core = this.#core;
    if (core === null || chunk.length === 0) return chunk;
    const window = this.#held + chunk;
    core.state = scanText(core.automaton, chunk, core.state, core.pos, core);
    core.pos += chunk.length;
    return this.#write(window, core.final);
  }

  end(): string {
    const core = this.#core;
    if (core === null) return '';
    const out = this.#write(this.#held, core.pos);
    core.reset();
    return out;
  }

  #write(window: string, upto: number): string {
    const core = this.#core!;
    const w0 = core.emitted;
    let out = '';
    core.render(
      upto,
      (from, to) => {
        out += window.slice(from - w0, to - w0);
      },
      () => {
        out += this.#mark;
      },
    );
    this.#held = window.slice(upto - w0);
    return out;
  }
}

/**
 * TextMasker over bytes (a body as it arrives, a raw stderr pipe), each form matched as its UTF-8 bytes,
 * so a chunk may cut a character anywhere. What push answers may share memory with the chunk passed in.
 */
export class BytesMasker {
  readonly #core: MaskCore | null;
  readonly #mark: Buffer;
  #held: Buffer = Buffer.alloc(0);

  constructor(forms: readonly string[] | FormSet, mark: string | Uint8Array = SECRET_MARK) {
    const set = formSet(forms);
    this.#core = set.forms.length === 0 ? null : new MaskCore(automatonOf(set, set.forms, 'bytes'));
    this.#mark = typeof mark === 'string' ? Buffer.from(mark, 'utf8') : Buffer.from(mark);
  }

  /** How many bytes are held back, waiting on the next chunk. */
  get held(): number {
    return this.#held.length;
  }

  push(chunk: Uint8Array): Buffer {
    const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const core = this.#core;
    if (core === null || view.length === 0) return view;
    const window = this.#held.length === 0 ? view : Buffer.concat([this.#held, view]);
    core.state = scanBytes(core.automaton, view, core.state, core.pos, core);
    core.pos += view.length;
    return this.#write(window, core.final);
  }

  end(): Buffer {
    const core = this.#core;
    if (core === null) return Buffer.alloc(0);
    const out = this.#write(this.#held, core.pos);
    core.reset();
    return out;
  }

  #write(window: Buffer, upto: number): Buffer {
    const core = this.#core!;
    const w0 = core.emitted;
    const parts: Buffer[] = [];
    core.render(
      upto,
      (from, to) => {
        parts.push(window.subarray(from - w0, to - w0));
      },
      () => {
        parts.push(this.#mark);
      },
    );
    // A copy: the window may be the caller's chunk, which it is free to reuse.
    this.#held = Buffer.from(window.subarray(upto - w0));
    // One raw stretch goes out as it is; the mark itself never does, so no caller can change it.
    return parts.length === 1 && parts[0] !== this.#mark ? parts[0] : Buffer.concat(parts);
  }
}

/** `text` with every maximal run covered by an occurrence of a form replaced by `mark`. */
export function maskText(text: string, forms: readonly string[] | FormSet, mark: string = SECRET_MARK): string {
  const masker = new TextMasker(forms, mark);
  return masker.push(text) + masker.end();
}

/** maskText over bytes: `bytes` with every maximal covered run replaced by `mark`. */
export function maskBytes(bytes: Uint8Array, forms: readonly string[] | FormSet, mark: string | Uint8Array = SECRET_MARK): Buffer {
  const masker = new BytesMasker(forms, mark);
  const head = masker.push(bytes);
  const tail = masker.end();
  return tail.length === 0 ? Buffer.from(head) : Buffer.concat([head, tail]);
}

// ------------------------------------------------------------------ scans

/** Where one name's forms occur: [start, end) in the scanned input's units. Never the value. */
export interface FormHit {
  name: string;
  start: number;
  end: number;
}

export type FormsByName = Readonly<Record<string, readonly string[]>> | ReadonlyMap<string, readonly string[]>;

/** Every name's forms compiled once into one matcher, for findForms over many inputs. */
export class FormIndex {
  /** The names, in the order given. */
  readonly names: readonly string[];
  /** Every distinct form across the names. */
  readonly patterns: readonly string[];
  /** The names whose forms hold pattern p: ownerIds[ownerStart[p]] up to ownerIds[ownerStart[p + 1]], by index into `names`. */
  readonly ownerStart: Int32Array;
  readonly ownerIds: Int32Array;

  constructor(formsByName: FormsByName) {
    const entries: [string, readonly string[]][] =
      formsByName instanceof Map
        ? [...(formsByName as ReadonlyMap<string, readonly string[]>).entries()]
        : Object.entries(formsByName as Readonly<Record<string, readonly string[]>>);
    const names: string[] = [];
    const patterns: string[] = [];
    const owners: number[][] = [];
    const indexOf = new Map<string, number>();
    for (const [name, forms] of entries) {
      const id = names.push(name) - 1;
      for (const form of new Set(forms)) {
        if (form === '') continue;
        let p = indexOf.get(form);
        if (p === undefined) {
          p = patterns.push(form) - 1;
          indexOf.set(form, p);
          owners.push([]);
        }
        owners[p].push(id);
      }
    }
    this.names = Object.freeze(names);
    this.patterns = Object.freeze(patterns);
    this.ownerStart = new Int32Array(patterns.length + 1);
    for (let p = 0; p < owners.length; p++) this.ownerStart[p + 1] = this.ownerStart[p] + owners[p].length;
    this.ownerIds = Int32Array.from(owners.flat());
  }
}

export interface FindFormsOptions {
  /** The most hits answered per name (default 100), the earliest; the scan still covers the whole input for every other name. */
  limit?: number;
}

/** The hits of a scan: per name, merged runs as flat [start, end) pairs. */
class ScanSink implements Sink {
  readonly pattern: Int32Array;
  readonly dict: Int32Array;
  readonly depth: Int32Array;
  readonly ownerStart: Int32Array;
  readonly ownerIds: Int32Array;
  /** Twice the most runs a name holds (runs are flat pairs). */
  readonly cap: number;
  /** Per name, the end it was last credited at: one credit per name per end, its longest form there. */
  readonly stamp: Float64Array;
  /** Per name, its runs as flat [start, end) pairs. */
  readonly runs: number[][];

  constructor(automaton: Automaton, index: FormIndex, limit: number) {
    this.pattern = automaton.pattern;
    this.dict = automaton.dict;
    this.depth = automaton.depth;
    this.ownerStart = index.ownerStart;
    this.ownerIds = index.ownerIds;
    this.cap = 2 * limit;
    this.stamp = new Float64Array(index.names.length).fill(-1);
    this.runs = Array.from({ length: index.names.length }, () => []);
  }

  hit(end: number, _length: number, state: number): void {
    const { pattern, dict, depth, ownerStart, ownerIds, stamp, runs, cap } = this;
    // Down the chain of patterns ending here, longest first.
    for (let u = pattern[state] >= 0 ? state : dict[state]; u >= 0; u = dict[u]) {
      const p = pattern[u];
      const start = end - depth[u];
      for (let k = ownerStart[p], last = ownerStart[p + 1]; k < last; k++) {
        const id = ownerIds[k];
        if (stamp[id] === end) continue;
        stamp[id] = end;
        const r = runs[id];
        const n = r.length;
        if (n !== 0 && r[n - 1] >= start && r[n - 2] <= start) r[n - 1] = end;
        // Past the limit only a hit that reaches the name's last run still counts.
        else if (n < cap || r[n - 1] >= start) addRun(r, start, end);
      }
    }
  }
}

/**
 * Which names' forms occur in `input` and where: one hit per maximal run that one name's occurrences
 * cover (overlapping and adjacent ones merged), ordered by start, then end, then name. Offsets are bytes
 * for a buffer (each form matched as its UTF-8 bytes) and UTF-16 code units for a string.
 */
export function findForms(input: Uint8Array | string, formsByName: FormsByName | FormIndex, opts: FindFormsOptions = {}): FormHit[] {
  const index = formsByName instanceof FormIndex ? formsByName : new FormIndex(formsByName);
  const limit = opts.limit ?? 100;
  if (!(limit >= 1) || (!Number.isInteger(limit) && limit !== Infinity)) throw new RangeError('findForms: limit is a whole number of hits (at least 1), or Infinity');
  if (index.patterns.length === 0 || input.length === 0) return [];
  const automaton = automatonOf(index, index.patterns, typeof input === 'string' ? 'text' : 'bytes');
  const sink = new ScanSink(automaton, index, limit);
  if (typeof input === 'string') scanText(automaton, input, 0, 0, sink);
  else scanBytes(automaton, input, 0, 0, sink);
  const hits: FormHit[] = [];
  sink.runs.forEach((runs, id) => {
    for (let k = 0; k < runs.length; k += 2) hits.push({ name: index.names[id], start: runs[k], end: runs[k + 1] });
  });
  return hits.sort((a, b) => a.start - b.start || a.end - b.end || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
