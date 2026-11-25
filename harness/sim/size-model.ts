// The compressed size of a program: what a size count that packing cannot undercut ranks an entry by. Pure and
// versioned (SIZE_MODEL_VERSION): a function of the files' paths and bytes alone, in integer arithmetic only, so a
// grade, every regrade and an entrant's own machine count the same number to the thousandth of a byte.
//
//   compressedSizeMilli(files)     the size, in whole thousandths of a byte (a safe integer, rounded up)
//   sizeModelStreamBytes(files)    the length of the stream the files make, from their paths and sizes alone
//   SIZE_MODEL_MODELED_BYTES       the bound (1 MiB of stream): files past it have NO compressed size, and
//                                  compressedSizeMilli refuses them (SizeModelBoundError), nothing weighed
//   SIZE_MODEL_PRIMER_BYTES        the primer's length as the model reads it (the primer itself: size-model-primer.ts)
//   compressedSizeMilliWeakened    the gate's control alone, never a count: the model with parts switched off
//
// What is weighed: one stream, the files in path code-unit order, each as its UTF-8 path, a 0 byte, its bytes and a
// 0 byte. Every byte of every file and every name counts (grader/size.ts says why: whatever a count leaves out is
// where the program moves). The size is the cost, in bits, of coding that stream under one adaptive model, summed
// as an arithmetic coder would spend them, over 8, the model having first read its primer (below), which costs
// nothing. The 0 byte closing each file's bytes is charged 8 bits flat (the model still learns it): so bytes appended
// at the end of the stream (to the last file in path order, or a file whose path sorts after every other) only ever
// add cost, as every coded bit costs a positive amount and nothing coded before them moves. Bytes added anywhere else
// change what the model has learned by the time it reaches the later files, so no such promise holds there.
//
// The bound: a stream longer than SIZE_MODEL_MODELED_BYTES has no compressed size. No byte of it is charged at a flat
// rate and no part of it is weighed: a flat rate past the bound let a packed form (kept under the bound) undercut its
// own plain program (an outside audit, 2026-11-22: 1.57 MB of TypeScript at 719,557 against its brotli form's 349,785).
// The grader refuses such an entry (grader/size.ts weighCodeSize), and the intake before it (grader/size.ts
// compressedCountIssue). One weigh takes about 7 s at the bound on an M-series core and holds the stream, the model's
// tables (about 34 MB) and the state after the primer (another 34 MB, built at a process's first weigh in 0.26 s and
// kept, so each weigh starts from a copy of it).
//
// The primer (sim/size-model-primer.ts SIZE_MODEL_PRIMER, 27,154 bytes as read): common English words, prose of the
// kinds a program carries, the licence notices source files carry and the two languages' common code, laid out as
// files of the stream and read before an entry's first byte. Without it the model met plain prose cold while brotli
// brings a built-in dictionary of English, so a program printing a paragraph could be packed below itself (the same
// audit: 1.5 KB of the Apache-2.0 text printed, plain 599.732, brotli-packed 559.867). It holds no decoder idiom (no
// compression call, no base64, no eval or exec), so it makes cheap what a plain program writes, never what a packed
// one adds.
//
// Why a model and not the byte count: a byte count lets a packer win. A program shipped as an LZMA, brotli, zstd or
// deflate payload behind a small decoding stub is fewer bytes than the program, so under a byte count the bounty
// rewards whoever runs the best stock packer, not whoever writes the smallest program. Weighed by a model that
// codes plain source tighter than those packers do, a payload's bytes cost about what they are (8 bits each when
// raw, 6 a character in base64: a packer's output looks random to any model) and the stub costs more on top, so the
// packed form weighs more than the program it unpacks to. tests/unit/size-model-gate.test.ts holds it for the
// competitions' programs, the audit's counterexamples, a prose set, programs up to the bound and a held-out set
// picked before the primer was written and weighed only after (every packer the pinned images offer, every way to
// carry a payload, and for a program that prints a text, that text packed and printed), and shows the gate failing
// a weakened model. And a size in thousandths of a byte rarely ties: two different programs of one byte length
// almost always weigh differently, so a size-ranked board has a clear first, second and third.
//
// The model: bitwise context mixing. Each byte is coded as 8 binary decisions, high bit first. For each decision
// twelve contexts predict the bit from what followed them before, each context being the bits of the current byte
// seen so far together with:
//   - order 0 and order 1 (nothing, the last byte), indexed directly; order 0 starts from a fixed prior over byte
//     values (PRIOR_RANKS) instead of even odds, so a byte never seen costs by how common it is in source;
//   - hashed: orders 2, 3, 4, 6 and 8; the two bytes before the last (a sparse context); the identifier being
//     written (the run of letters, digits, `_`, `$` and non-ASCII bytes) with the last byte, with the byte before
//     that and with the identifier before it; the line's column with the last byte and the byte above in the
//     previous line (indentation). Each nibble of a context finds a bucket of 16 slots in one table of 2^22 slots,
//     two ways, an 8-bit tag telling contexts apart and the least used way replaced.
// A slot holds two probabilities and a count n: one stepping 1/(n+1.5) of the way to each bit, never slower than
// 1/256.5, one never slower than 1/11.5. A match model adds two more inputs: the longest earlier occurrence of the
// last bytes (found by a hash of the last 4, its length verified backwards) predicts the byte that followed it,
// its confidence learned by match length. The stretched predictions (ln(p/(1-p)) in 1/256ths) feed three gated
// linear mixers, choosing their weights by the partial byte, by the match length and how many of the hashed
// contexts were seen before, and by the last byte; a final mixer, chosen by the partial byte, weighs their outputs.
// Three adaptive probability maps refine that (by the partial byte, with the last byte, with a hash of the last
// two: 33 knots a context over stretch, interpolated, both knots around the input learning by their shares); the
// bit is charged -log2 of the average of the four.
//
// Integer only: probabilities are 12-bit (1..4095) at the mixers and 16-bit in the slots, stretched values are
// 1/256ths of a nat clipped to +-2047, weights 16.16 fixed point clipped to +-256, and every product and sum stays
// a safe integer (a sum of 27 products of a 12-bit input and a 25-bit weight; the total cost of 2^23 bits of at
// most 12 bits each, in 1/65536ths of a bit, times 1000). Every table is derived at module load by integer code from
// its definition: log2 by repeated squaring of 24-bit mantissas (integers, exact in a double), -log2 of a probability
// and stretch from it (ln 2 as one fixed integer ratio), squash as stretch's nearest inverse by a monotone search, and
// the probability maps' starting knots from squash. No Math.log, Math.exp, Math.pow or floating-point state, so
// every platform gives the same number. A change to any constant here, or to a byte of the primer, is a new
// SIZE_MODEL_VERSION.
//
// Provenance. The method is the PAQ family's (Mahoney), each part following its published description in M. Mahoney,
// "Data Compression Explained" (mattmahoney.net/dc/dce.html): the byte coded as 8 decisions with the partial byte in
// every context, and the direct adaptive counter p += (y - p)/(n + delta) (section 4.1.2); context hashes looked up
// once a nibble, an 8-bit check confirming the context and the least used entry replaced (4.1.3); logistic mixing,
// stretch(p) = ln(p/(1-p)) and squash its inverse, weights trained by w += rate * (y - p) * stretch(p) and chosen by a
// small context (4.3.2); secondary estimation over interpolated knots, both around the input updated, starting at the
// identity (4.3.3); the match model, a hash of the last bytes pointing into the history and the predicted bit's
// confidence learned by match length (4.3.5). No code, table or constant was copied from a PAQ source. The first build
// of this file transcribed lpaq1.cpp's 33-entry squash table and its two functions squash (interpolating that table)
// and stretch (inverting squash by search), and moved a probability map's nearer knot by that file's update: all were
// removed and re-derived, STRETCH from its definition round(256 * ln(p / (4096 - p))) by integer log2, SQUASH as
// STRETCH's nearest inverse, and the map's update from section 4.3.3's description (both knots, by share). The hash
// multipliers are published general-purpose ones: 0x9e3779b9 (2^32 over the golden ratio) and 0x9e3779b1 (the prime
// beside it), as multiplicative hashing uses them, 0x85ebca6b and 0xc2b2ae35 (MurmurHash3's finalizer), 0x85ebca77
// (xxHash32's second prime), 0x01000193 (the 32-bit FNV prime) and 0x7ed55d16 (from Bob Jenkins's 32-bit integer hash);
// none of them, nor 0x2f0b4c27 or LN2_NUM, appears in lpaq1.cpp. Numerically the same as lpaq1's: 12-bit probabilities
// with stretch in 1/256ths clipped to +-2047, the fixed-point representation section 4.3.2 gives for PAQ (a standard
// choice); the counter step 1/(n + 1.5), section 4.1.2's update with delta 1/2 counted after the increment, which ZPAQ
// fixes too (a standard choice); a nibble's bucket of 16 slots, one for its use count and fifteen for the contexts its
// bits spell, with an 8-bit check, as in section 4.1.3's ZPAQ table (forced by coding a nibble's 15 partial contexts
// together); mixer weights in 16.16 fixed point with the dot product shifted down 16 (the scale that keeps a 12-bit
// input times a weight of 1.0 a 12-bit output); and match lengths kept exact below 16 and by fours from 16 to 63, the
// quantization lpaq1's own description gives (a choice, not forced: lengths change the confidence most while short).
// Not lpaq1's: its indirect bit-history states (here every slot holds probabilities directly), its 24-level probability
// maps updating the nearer level alone (here 33 knots, both updated), its single mixer layer, learning rate, weight
// start and contexts.

import { SIZE_MODEL_PRIMER } from './size-model-primer.ts';

/** This model, its stream, its primer and its constants, by number: a change to any of them is a new version. */
export const SIZE_MODEL_VERSION = 1;

/**
 * The bound: the longest stream (the entry's files, each as its UTF-8 path, a 0 byte, its bytes and a 0 byte) the
 * model weighs. A longer one has no compressed size (SizeModelBoundError): nothing of it is weighed.
 */
export const SIZE_MODEL_MODELED_BYTES = 1 << 20;

/** One file of a program: its path (relative, '/'-separated, as the snapshot names it) and its bytes, all of them. */
export interface SizeModelFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Files whose stream is longer than the bound (SIZE_MODEL_MODELED_BYTES): they have no compressed size, and nothing of
 * them is weighed. `streamBytes` is the stream's length; the message says it in words a grade's failure can carry.
 */
export class SizeModelBoundError extends RangeError {
  readonly streamBytes: number;
  readonly bound: number;
  constructor(streamBytes: number) {
    super(
      `the counted files make a stream of ${streamBytes} bytes (each file's path, its bytes and two separator bytes), past the size model's bound of ${SIZE_MODEL_MODELED_BYTES} bytes (1 MiB): code this large has no compressed size, so it cannot be weighed or ranked under the compressed count`,
    );
    this.name = 'SizeModelBoundError';
    this.streamBytes = streamBytes;
    this.bound = SIZE_MODEL_MODELED_BYTES;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tables, from integer code at module load.

/** floor(2^16 * log2(k)) for an integer 1 <= k < 2^24, by repeated squaring of a 24-bit mantissa. */
function log2Fixed16(k: number): number {
  const ONE = 1 << 24;
  let e = 0;
  let m = k; // normalised below to [2^24, 2^25): k / 2^(e - 24)
  while (m >= 2 * ONE) {
    m = Math.floor(m / 2);
    e += 1;
  }
  while (m < ONE) {
    m *= 2;
    e -= 1;
  }
  e += 24;
  let frac = 0;
  for (let i = 0; i < 16; i += 1) {
    m = Math.floor((m * m) / ONE); // m^2 < 2^50: exact
    frac *= 2;
    if (m >= 2 * ONE) {
      m = Math.floor(m / 2);
      frac += 1;
    }
  }
  return e * 65536 + frac;
}

/**
 * ln 2 as LN2_NUM / 2^32: round(ln 2 * 2^32) = 2977044472, above ln 2 by 4.2e-11 (6.1e-11 of it). Over the largest
 * difference of logs below (12 bits) that moves a stretch by under 1e-7 of a unit; log2Fixed16's truncation (under
 * 2^-16 bit a term) moves it by under 0.006 of a unit.
 */
const LN2_NUM = 2977044472;
const TWO_40 = 1099511627776; // 2^40: 2^16 (log2Fixed16's scale) * 2^32 (LN2_NUM's) / 2^8 (stretch's 1/256ths)

/**
 * stretch(p) for p in 0..4095: round(256 * ln(p / (4096 - p))), half away from zero, clipped to -2047..2047; stretch(0)
 * is stretch(1). The difference of the two logs (in 1/65536ths of a bit, |D| <= 12 * 2^16) times LN2_NUM stays under
 * 2^53, so the product and the rounding are exact.
 */
const STRETCH = new Int16Array(4096);
for (let p = 1; p < 4096; p += 1) {
  const d = (log2Fixed16(p) - log2Fixed16(4096 - p)) * LN2_NUM;
  const r = d >= 0 ? Math.floor((d + TWO_40 / 2) / TWO_40) : -Math.floor((TWO_40 / 2 - d) / TWO_40);
  STRETCH[p] = r > 2047 ? 2047 : r < -2047 ? -2047 : r;
}
STRETCH[0] = STRETCH[1]!;

/**
 * squash(d) for d in -2048..2047, at SQUASH[d + 2048]: the probability p in 1..4095 whose stretch is nearest d, the
 * lowest such p on a tie. STRETCH never decreases over 1..4095, so one pointer walks it once: it moves from the first
 * p of one stretch value to the first p of the next while that one is strictly nearer.
 */
const SQUASH = new Int16Array(4096);
{
  let p = 1;
  for (let d = -2048; d < 2048; d += 1) {
    for (;;) {
      let q = p + 1;
      while (q < 4096 && STRETCH[q] === STRETCH[p]) q += 1;
      if (q < 4096 && Math.abs(STRETCH[q]! - d) < Math.abs(STRETCH[p]! - d)) p = q;
      else break;
    }
    SQUASH[d + 2048] = p;
  }
}

/** squash(d) for any d: SQUASH, held at its ends past -2048..2047. */
function squashAt(d: number): number {
  return SQUASH[(d < -2048 ? -2048 : d > 2047 ? 2047 : d) + 2048]!;
}

/** COST[k]: -log2(k / 4096) in 1/65536ths of a bit, for a bit given probability k/4096 (1..4095). */
const COST = new Int32Array(4097);
for (let k = 1; k <= 4096; k += 1) COST[k] = 12 * 65536 - log2Fixed16(k);

/** Counter step at count n, in 1/16384ths: 1/(n + 1.5). */
const RATE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) RATE[n] = Math.floor(32768 / (2 * n + 3));

// ---------------------------------------------------------------------------------------------------------------
// The model.

/**
 * The model's prior over a fresh byte: printable ASCII, tab and newline in the order of their frequency in program
 * source (the competitions' programs and the house's own TypeScript), every other byte after them in byte order.
 * Rank r weighs floor(2^20 / (r + 4)), so no two byte values weigh the same: a byte never seen before costs by its
 * rank, and two programs differing only in such a byte do not tie.
 */
const PRIOR_RANKS = " etsnoria\ncl,hd.()p=fum;gb':\"-vy01EwS[]_k/{}#ATx2*PORN+IU3L6>M5BC4DH`q87|<F&!$Kj?\t9WzGVZ\\QJX^Y%~@";

/** PRIOR[c0]: the probability, in 1/65536ths, that the next bit is 1 after the partial byte c0 (1..255), under the prior. */
const PRIOR = new Uint16Array(256);
{
  const weight = new Array<number>(256).fill(0);
  const ranked: number[] = [];
  for (let i = 0; i < PRIOR_RANKS.length; i += 1) ranked.push(PRIOR_RANKS.charCodeAt(i));
  for (let b = 0; b < 256; b += 1) if (!ranked.includes(b)) ranked.push(b);
  for (let r = 0; r < 256; r += 1) weight[ranked[r]!] = Math.floor((1 << 20) / (r + 4));
  // Subtree sums: node c0 (1..255) covers the bytes whose top bits, after a leading 1, spell c0.
  const sum = new Array<number>(512).fill(0);
  for (let b = 0; b < 256; b += 1) sum[256 + b] = weight[b]!;
  for (let c = 255; c >= 1; c -= 1) sum[c] = sum[2 * c]! + sum[2 * c + 1]!;
  for (let c = 1; c < 256; c += 1) {
    const p = Math.floor((sum[2 * c + 1]! * 65536) / sum[c]!);
    PRIOR[c] = p < 1 ? 1 : p > 65535 ? 65535 : p;
  }
}

const HASH_BITS = 22;
const DIRECT = 256 + 65536; // order 0 (256 slots), then order 1 (65536)
const SLOTS = DIRECT + (1 << HASH_BITS);
const SLOW_LIMIT = 255;
const FAST_LIMIT = 10;
const MATCH_MIN = 4;
const MATCH_HASH_BITS = 20;
const MATCH_MAX = 65535;
const MIXER_SHIFT = 14;
const MIXER_LR = 12;
const W_INIT = 8192;
const W_MAX = (1 << 24) - 1;
const APM_RATE = 7;
/** First-layer mixers. */
const NM = 3;
const FINAL_LR = 2;

/** The hashed contexts, and every context (orders 0 and 1 besides them). */
const NH = 10;
const NC = NH + 2;
/** Mixer inputs: two a context, two from the match model, one bias. */
const NI = 2 * NC + 3;

function mix32(x: number, k: number): number {
  let h = Math.imul(x ^ Math.imul(k, 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

function isWordByte(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x24 || c >= 0x80;
}

/** An APM context's starting knots: the identity map, squash at stretch -2048, -1920, ..., 2048, in 1/65536ths. */
const APM_ROW = new Uint16Array(33);
for (let j = 0; j < 33; j += 1) APM_ROW[j] = squashAt((j - 16) * 128) * 16;

/**
 * An adaptive probability map: per context, 33 knots over stretch -2048..2048 (one each 128), read by linear
 * interpolation between the two knots around the input's stretch; learning moves both of them towards the bit, each
 * by its share of the interpolation.
 */
class Apm {
  readonly knots: Uint16Array;
  private at = 0; // the lower knot read last
  private share = 0; // the upper knot's share of it, in 1/128ths

  /** A map of `contexts` contexts, each the identity; or a copy of `from` as it stands. */
  constructor(contexts: number, from?: Apm) {
    if (from !== undefined) {
      this.knots = from.knots.slice();
      return;
    }
    const knots = new Uint16Array(contexts * 33);
    knots.set(APM_ROW);
    for (let filled = 33; filled < knots.length; filled *= 2) knots.copyWithin(filled, 0, Math.min(filled, knots.length - filled));
    this.knots = knots;
  }

  refine(pr: number, cx: number): number {
    const s = STRETCH[pr]! + 2048; // 1..4095
    this.at = cx * 33 + (s >> 7);
    this.share = s & 127;
    const k = this.knots;
    const v = (k[this.at]! * (128 - this.share) + k[this.at + 1]! * this.share) >> 11;
    return v < 1 ? 1 : v > 4095 ? 4095 : v;
  }

  learn(y: number): void {
    const target = y ? 65535 : 0;
    const k = this.knots;
    const lo = this.at;
    k[lo] = k[lo]! + (((target - k[lo]!) * (128 - this.share)) >> (APM_RATE + 7));
    k[lo + 1] = k[lo + 1]! + (((target - k[lo + 1]!) * this.share) >> (APM_RATE + 7));
  }
}

/**
 * The model's whole state: every table it learns into and the few values it carries from byte to byte. `code` runs it
 * over a buffer; a copy (`new Model(from)`) goes on from where `from` stands, so the state after the primer is built
 * once and each weigh starts from a copy of it.
 */
class Model {
  readonly slow: Uint16Array;
  readonly fast: Uint16Array;
  readonly count: Uint8Array;
  readonly tag: Uint8Array;
  readonly w: Int32Array;
  readonly wf: Int32Array;
  readonly matchTable: Int32Array;
  readonly matchSlow: Uint16Array;
  readonly matchCount: Uint8Array;
  readonly apm1: Apm;
  readonly apm2: Apm;
  readonly apm3: Apm;
  c4 = 0; // the last four bytes, newest lowest
  c8 = 0; // the four before them
  word = 0; // hash of the identifier being written, 0 outside one
  prevWord = 0;
  col = 0; // bytes since the last newline
  lineStart = 0; // position after the last newline
  prevLineStart = -1;
  matchPtr = 0;
  matchLen = 0;

  constructor(from?: Model) {
    if (from !== undefined) {
      this.slow = from.slow.slice();
      this.fast = from.fast.slice();
      this.count = from.count.slice();
      this.tag = from.tag.slice();
      this.w = from.w.slice();
      this.wf = from.wf.slice();
      this.matchTable = from.matchTable.slice();
      this.matchSlow = from.matchSlow.slice();
      this.matchCount = from.matchCount.slice();
      this.apm1 = new Apm(0, from.apm1);
      this.apm2 = new Apm(0, from.apm2);
      this.apm3 = new Apm(0, from.apm3);
      this.c4 = from.c4;
      this.c8 = from.c8;
      this.word = from.word;
      this.prevWord = from.prevWord;
      this.col = from.col;
      this.lineStart = from.lineStart;
      this.prevLineStart = from.prevLineStart;
      this.matchPtr = from.matchPtr;
      this.matchLen = from.matchLen;
      return;
    }
    this.slow = new Uint16Array(SLOTS).fill(32768);
    this.fast = new Uint16Array(SLOTS).fill(32768);
    this.count = new Uint8Array(SLOTS);
    this.tag = new Uint8Array(1 << (HASH_BITS - 4));
    for (let c = 1; c < 256; c += 1) {
      this.slow[c] = PRIOR[c]!;
      this.fast[c] = PRIOR[c]!;
    }
    this.w = new Int32Array((256 + 64 + 256) * NI).fill(W_INIT);
    this.wf = new Int32Array(256 * NM).fill(Math.floor(65536 / NM));
    this.matchTable = new Int32Array(1 << MATCH_HASH_BITS);
    this.matchSlow = new Uint16Array(64 * 2).fill(32768);
    this.matchCount = new Uint8Array(64 * 2);
    this.apm1 = new Apm(256);
    this.apm2 = new Apm(65536);
    this.apm3 = new Apm(1 << 16);
  }

  /**
   * Codes `buf` from `from` to its end, every earlier byte of it being what the model has already coded (the match
   * model and the column context look back into them), and returns the cost, in 1/65536ths of a bit, of the bytes at
   * `chargeFrom` and after whose `flat` mark (at their offset from `chargeFrom`) is 0: a byte before `chargeFrom`, or
   * marked, is learned from and costs nothing here. With `hashed` false the hashed contexts give no input and learn
   * nothing (the gate's weakened control alone).
   */
  code(buf: Uint8Array, from: number, chargeFrom: number, flat: Uint8Array | null, hashed: boolean): number {
    const n = buf.length;
    const { slow, fast, count, tag, w, wf, matchTable, matchSlow, matchCount, apm1, apm2, apm3 } = this;
    const nh = hashed ? NH : 0;
    const base = new Int32Array(NH);
    let seen = 0;
    let nib = 1;
    const idx = new Int32Array(NC);
    const ctx = new Int32Array(NH);
    const x = new Int32Array(NI);
    const sel = new Int32Array(NM);
    const dm = new Int32Array(NM);
    const pmx = new Int32Array(NM);

    let total = 0;
    let { c4, c8, word, prevWord, col, lineStart, prevLineStart, matchPtr, matchLen } = this;

    for (let pos = from; pos < n; pos += 1) {
      // Contexts of this byte, from the bytes before it.
      const c1 = c4 & 255;
      ctx[0] = mix32(c4 & 0xffff, 2);
      ctx[1] = mix32(c4 & 0xffffff, 3);
      ctx[2] = mix32(c4, 4);
      ctx[3] = mix32(c4 ^ mix32(c8 & 0xffff, 16), 6);
      ctx[4] = mix32(word ^ Math.imul(c1, 0x2f0b4c27), 7);
      ctx[5] = mix32(word ^ mix32(prevWord, 17), 8);
      let above = 0;
      if (prevLineStart >= 0 && prevLineStart + col < lineStart) above = buf[prevLineStart + col]! + 1;
      ctx[6] = mix32((above << 8) | c1 | (Math.min(col, 255) << 17), 9);
      ctx[7] = mix32(c4 ^ mix32(c8, 18), 10);
      ctx[8] = mix32(c4 & 0xffff00, 11);
      ctx[9] = mix32(word ^ mix32(c4 & 0xff00, 19), 12);

      // The match model: extend the match, or look one up.
      if (matchLen > 0 && pos > 0 && buf[matchPtr] === c1) {
        matchPtr += 1;
        if (matchLen < MATCH_MAX) matchLen += 1;
      } else {
        matchLen = 0;
      }
      if (pos >= MATCH_MIN) {
        let h = 0;
        for (let k = 1; k <= MATCH_MIN; k += 1) h = Math.imul(h ^ buf[pos - k]!, 0x01000193) + 0x7ed55d16;
        h = (Math.imul(h, 0x9e3779b1) >>> (32 - MATCH_HASH_BITS)) & ((1 << MATCH_HASH_BITS) - 1);
        if (matchLen === 0) {
          const cand = matchTable[h]!;
          if (cand > 0) {
            let len = 0;
            while (len < MATCH_MAX && len < cand && buf[cand - 1 - len] === buf[pos - 1 - len]) len += 1;
            if (len >= MATCH_MIN) {
              matchLen = len;
              matchPtr = cand;
            }
          }
        }
        matchTable[h] = pos;
      }
      const lenBucket = matchLen === 0 ? 0 : matchLen < 16 ? matchLen : matchLen < 64 ? 16 + ((matchLen - 16) >> 2) : 28 + Math.min(3, (matchLen - 64) >> 6);
      const expected = matchLen > 0 ? buf[matchPtr]! : 0;
      let matchLive = matchLen > 0;

      const byte = buf[pos]!;
      const charged = pos >= chargeFrom && (flat === null || flat[pos - chargeFrom] === 0);
      let c0 = 1;
      for (let bit = 7; bit >= 0; bit -= 1) {
        const y = (byte >> bit) & 1;
        // Slots: order 0 and 1 direct, the rest hashed (two ways a bucket, tagged).
        idx[0] = c0;
        idx[1] = 256 + ((c1 << 8) | c0);
        if (bit === 7 || bit === 3) {
          // A new nibble: find each hashed context's bucket of 16 slots (two ways, tagged), slot 0 its use count.
          seen = 0;
          nib = 1;
          for (let j = 0; j < nh; j += 1) {
            const hc = ctx[j]! ^ Math.imul(c0, 0x2f0b4c27);
            const a = DIRECT + ((Math.imul(hc, 0x9e3779b1) >>> (32 - HASH_BITS)) & ~15);
            const t = (Math.imul(hc, 0x85ebca77) >>> 24) | 1;
            const bucket = (a - DIRECT) >> 4;
            let s: number;
            if (tag[bucket] === t) s = a;
            else if (tag[bucket ^ 1] === t) s = a ^ 16;
            else {
              s = count[a]! <= count[a ^ 16]! ? a : a ^ 16;
              tag[(s - DIRECT) >> 4] = t;
              slow.fill(32768, s, s + 16);
              fast.fill(32768, s, s + 16);
              count.fill(0, s, s + 16);
            }
            if (count[s]! > 0 && j < 4) seen += 1;
            if (count[s]! < 255) count[s] = count[s]! + 1;
            base[j] = s;
          }
        }
        for (let j = 0; j < nh; j += 1) idx[j + 2] = base[j]! + nib;
        const live = 2 + nh;
        for (let j = 0; j < live; j += 1) {
          const s = idx[j]!;
          x[2 * j] = STRETCH[slow[s]! >> 4]!;
          x[2 * j + 1] = STRETCH[fast[s]! >> 4]!;
        }
        for (let j = live; j < NC; j += 1) {
          x[2 * j] = 0;
          x[2 * j + 1] = 0;
        }
        // The match model's two inputs.
        let mctx = -1;
        let ebit = 0;
        if (matchLive) {
          if (((expected | 256) >> (bit + 1)) === c0) {
            ebit = (expected >> bit) & 1;
            mctx = lenBucket * 2 + ebit;
            const st = STRETCH[matchSlow[mctx]! >> 4]!;
            x[2 * NC] = st;
            const conf = Math.min(matchLen, 32) * 32;
            x[2 * NC + 1] = ebit ? conf : -conf;
          } else {
            matchLive = false;
            matchLen = 0;
          }
        }
        if (mctx < 0) {
          x[2 * NC] = 0;
          x[2 * NC + 1] = 0;
        }
        x[2 * NC + 2] = 256;

        // First-layer mixers, each choosing its weights by its own context; a final mixer weighs their outputs.
        sel[0] = c0 * NI;
        sel[1] = (256 + (matchLen === 0 ? 0 : 1 + Math.min(lenBucket >> 2, 6)) * 8 + Math.min(seen * 2, 7)) * NI;
        sel[2] = (256 + 64 + c1) * NI;
        let df = 0;
        const fb = c0 * NM;
        for (let m = 0; m < NM; m += 1) {
          const b = sel[m]!;
          let d = 0;
          for (let i = 0; i < NI; i += 1) d += x[i]! * w[b + i]!;
          d = Math.floor(d / 65536);
          if (d > 2047) d = 2047;
          else if (d < -2047) d = -2047;
          dm[m] = d;
          pmx[m] = SQUASH[d + 2048]!;
          df += d * wf[fb + m]!;
        }
        df = Math.floor(df / 65536);
        if (df > 2047) df = 2047;
        else if (df < -2047) df = -2047;
        const pm = SQUASH[df + 2048]!;

        // Refinement.
        const a1 = apm1.refine(pm, c0);
        const a2 = apm2.refine(pm, (c1 << 8) | c0);
        const a3 = apm3.refine(pm, ((Math.imul(c4 & 0xffff, 0x9e3779b1) >>> 24) << 8) | c0);
        let pr = (pm + a1 + a2 + a3 + 2) >> 2;
        if (pr < 1) pr = 1;
        else if (pr > 4095) pr = 4095;

        if (charged) total += COST[y ? pr : 4096 - pr]!;

        // Update.
        for (let m = 0; m < NM; m += 1) {
          const e = ((y << 12) - pmx[m]!) * MIXER_LR;
          const b = sel[m]!;
          for (let i = 0; i < NI; i += 1) {
            const v = w[b + i]! + ((x[i]! * e) >> MIXER_SHIFT);
            w[b + i] = v > W_MAX ? W_MAX : v < -W_MAX ? -W_MAX : v;
          }
        }
        {
          const e = ((y << 12) - pm) * FINAL_LR;
          for (let m = 0; m < NM; m += 1) {
            const v = wf[fb + m]! + ((dm[m]! * e) >> MIXER_SHIFT);
            wf[fb + m] = v > W_MAX ? W_MAX : v < -W_MAX ? -W_MAX : v;
          }
        }
        apm1.learn(y);
        apm2.learn(y);
        apm3.learn(y);
        const target = y ? 65535 : 0;
        for (let j = 0; j < live; j += 1) {
          const s = idx[j]!;
          const k = count[s]!;
          slow[s] = slow[s]! + (((target - slow[s]!) * RATE[k < SLOW_LIMIT ? k : SLOW_LIMIT]!) >> 14);
          fast[s] = fast[s]! + (((target - fast[s]!) * RATE[k < FAST_LIMIT ? k : FAST_LIMIT]!) >> 14);
          if (k < 255) count[s] = k + 1;
        }
        if (mctx >= 0) {
          const k = matchCount[mctx]!;
          const t = y ? 65535 : 0;
          matchSlow[mctx] = matchSlow[mctx]! + (((t - matchSlow[mctx]!) * RATE[k < SLOW_LIMIT ? k : SLOW_LIMIT]!) >> 14);
          if (k < 255) matchCount[mctx] = k + 1;
        }
        c0 = (c0 << 1) | y;
        nib = (nib << 1) | y;
      }

      // After the byte.
      c8 = (c8 << 8) | (c4 >>> 24);
      c4 = (c4 << 8) | byte;
      if (isWordByte(byte)) word = Math.imul(word ^ byte, 0x01000193) + 1;
      else if (word !== 0) {
        prevWord = word;
        word = 0;
      }
      if (byte === 0x0a) {
        prevLineStart = lineStart;
        lineStart = pos + 1;
        col = 0;
      } else col += 1;
    }
    this.c4 = c4;
    this.c8 = c8;
    this.word = word;
    this.prevWord = prevWord;
    this.col = col;
    this.lineStart = lineStart;
    this.prevLineStart = prevLineStart;
    this.matchPtr = matchPtr;
    this.matchLen = matchLen;
    return total;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The primer.

const UTF8 = new TextEncoder();

/**
 * The primer as the model reads it: each of SIZE_MODEL_PRIMER's files laid out as the stream lays out an entry's (its
 * UTF-8 path, a 0 byte, its text as UTF-8, a 0 byte), in the order listed.
 */
const PRIMER_BYTES: Uint8Array = (() => {
  const parts: Uint8Array[] = [];
  for (const [path, text] of SIZE_MODEL_PRIMER) parts.push(UTF8.encode(path), new Uint8Array(1), UTF8.encode(text), new Uint8Array(1));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
})();

/** The primer's length in bytes, as the model reads it (each file's path, its text and two 0 bytes). */
export const SIZE_MODEL_PRIMER_BYTES = PRIMER_BYTES.length;

/** The model as it stands after reading the primer, built at the first weigh and never changed: each weigh codes on a copy. */
let primed: Model | null = null;

function primedModel(): Model {
  if (primed === null) {
    const m = new Model();
    m.code(PRIMER_BYTES, 0, PRIMER_BYTES.length, null, true);
    primed = m;
  }
  return new Model(primed);
}

// ---------------------------------------------------------------------------------------------------------------
// The count.

function byPath(a: { readonly path: string }, b: { readonly path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * The length of the stream `files` make (each file's UTF-8 path, a 0 byte, its `size` bytes and a 0 byte), whatever
 * it is: within the bound (SIZE_MODEL_MODELED_BYTES) they can be weighed, past it they cannot (SizeModelBoundError).
 * A path that is not a string, a path named twice, or a size that is not a whole number of bytes is a TypeError. It
 * reads paths and sizes alone, so a caller holding only an index (a snapshot's) can tell before reading a byte.
 */
export function sizeModelStreamBytes(files: readonly { readonly path: string; readonly size: number }[]): number {
  return layout(files, 'sizeModelStreamBytes').length;
}

/** `files` in path code-unit order and the stream's length; a bad path or size, or a path named twice, is a TypeError. */
function layout<F extends { readonly path: string; readonly size: number }>(files: readonly F[], what: string): { sorted: F[]; length: number } {
  for (const f of files) {
    if (typeof f.path !== 'string') throw new TypeError(`${what}: a path is not a string`);
    if (!Number.isSafeInteger(f.size) || f.size < 0) throw new TypeError(`${what}: the size of ${JSON.stringify(f.path)} is ${String(f.size)}, not a whole number of bytes`);
  }
  const sorted = [...files].sort(byPath);
  let length = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i]!.path === sorted[i - 1]!.path) throw new TypeError(`${what}: the path ${JSON.stringify(sorted[i]!.path)} is named twice`);
    length += UTF8.encode(sorted[i]!.path).length + sorted[i]!.size + 2;
  }
  return { sorted, length };
}

/** Which parts of the model run: both in every count; the gate's weakened control alone turns them off. */
interface ModelParts {
  readonly primer: boolean;
  readonly hashed: boolean;
}

function weigh(files: readonly SizeModelFile[], parts: ModelParts, what: string): number {
  for (const f of files) {
    if (typeof f.path !== 'string') throw new TypeError(`${what}: a path is not a string`);
    if (!(f.bytes instanceof Uint8Array)) throw new TypeError(`${what}: the bytes of ${JSON.stringify(f.path)} are not a Uint8Array`);
  }
  const { sorted, length } = layout(
    files.map((f) => ({ path: f.path, size: f.bytes.length, bytes: f.bytes })),
    what,
  );
  if (length > SIZE_MODEL_MODELED_BYTES) throw new SizeModelBoundError(length);
  const lead = parts.primer ? PRIMER_BYTES.length : 0;
  const buf = new Uint8Array(lead + length);
  if (parts.primer) buf.set(PRIMER_BYTES);
  const flat = new Uint8Array(length);
  let at = lead;
  for (const f of sorted) {
    const path = UTF8.encode(f.path);
    buf.set(path, at);
    at += path.length + 1; // the path, then its 0
    buf.set(f.bytes, at);
    at += f.bytes.length;
    flat[at - lead] = 1; // the 0 closing the file's bytes: 8 bits flat
    at += 1;
  }
  const model = parts.primer ? primedModel() : new Model();
  const units = model.code(buf, lead, lead, flat, parts.hashed);
  return Math.ceil((units * 1000) / 524288) + 1000 * sorted.length;
}

/**
 * The compressed size of `files`, in whole thousandths of a byte (rounded up): the model's cost, after the primer, of
 * the stream of them in path code-unit order (each file's UTF-8 path, a 0 byte, its bytes, a 0 byte), over 8. The
 * order `files` come in never matters. A stream past the bound (SIZE_MODEL_MODELED_BYTES) is SizeModelBoundError,
 * nothing weighed; a path named twice, a path that is not a string or bytes that are not a Uint8Array is a TypeError.
 */
export function compressedSizeMilli(files: readonly SizeModelFile[]): number {
  return weigh(files, { primer: true, hashed: true }, 'compressedSizeMilli');
}

/**
 * NEVER A COUNT: the gate's control (tests/unit/size-model-gate.test.ts), compressedSizeMilli with parts of the model
 * switched off, `primer` false reading no primer and `hashed` false giving the hashed contexts (orders 2 to 8, the
 * sparse, word and column contexts) no say, so the gate can be shown to fail a weaker model. Bound and checks as
 * compressedSizeMilli's.
 */
export function compressedSizeMilliWeakened(files: readonly SizeModelFile[], parts: ModelParts): number {
  return weigh(files, parts, 'compressedSizeMilliWeakened');
}
