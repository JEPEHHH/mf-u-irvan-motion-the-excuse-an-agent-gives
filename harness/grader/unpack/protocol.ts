// The packed-payload unpacker's caps and wire: the one source both sides read. The Python fold script
// (grader/unpack/script.ts UNPACK_PY_SOURCE) has these numbers interpolated into its source, and the
// grader-side driver that spawns it in the python3.13 sandbox checks its untrusted output against them
// again. Nothing here imports anything: it is plain data, so the web process may read it too.
//
// The script reads the candidate files at /input/<i> (i = 0..n-1), never runs, imports or compiles
// them, folds each exec / eval / compile site's source argument statically (script.ts's header lists
// what a fold reads, a module-level `N = E0; N += E1; ...` concatenation run among it), and answers
// on stdout:
//
//   line 1   one JSON object (UnpackHead) of at most UNPACK_HEAD_MAX_BYTES, ASCII, no newline inside;
//   then     the layers' UTF-8 text back to back in `n` order, each exactly its `utf8_len` bytes.
//
// It exits 0 whenever it wrote a head, UNPACK_EXIT_TIMEOUT when its own alarm (UNPACK_SCRIPT_MS)
// fired first (no head), UNPACK_EXIT_HEAD_TOO_LARGE when the head would pass its cap (no head; the
// caps below make that unreachable). Anything else (a traceback) is a failed run.
//
// Beside its candidates it reads the entry's other Python text files, the tree files, at /input/t<j>.py
// (UNPACK_TREE_PREFIX, UNPACK_PY_TREE_KIND; j = 0..m-1), for its tree rule only (script.ts's header): never
// folded and never in the head (whose `files` list the candidates alone). A candidate unpacks only when
// every Python text of the entry, candidates and tree files alike, passes the rule; the candidates and tree
// files together are held to UNPACK_MAX_FILES, UNPACK_MAX_FILE_BYTES and UNPACK_MAX_INPUT_BYTES, and a tree
// that does not fit leaves each candidate `over_cap` (the driver spawns nothing).
//
// The node22 fold (a house ES module run as `node /bot/unpack.mjs`, parsing with the vendored
// grader/unpack/vendor/acorn-8.19.0.mjs, which the host only ever reads as text) answers on the same wire
// under the same caps, exit codes and UNPACK_SITE_FAILURES, with three differences, all below the Python
// tables: its inputs are /input/<i>.<kind> (UNPACK_NODE_KINDS), its head names `node` where Python's names
// `python` (UnpackNodeHead), and its layers' `via` hold UNPACK_NODE_VIA names, never UNPACK_VIA ones. Beside
// its candidates it reads the entry's other node-language text files, the tree files, at /input/t<j>.<kind>
// (j = 0..m-1), for its tree rule only: never folded and never in the head (whose `files` list the candidates
// alone); the candidates and tree files together are held to UNPACK_MAX_FILES, UNPACK_MAX_FILE_BYTES and
// UNPACK_MAX_INPUT_BYTES. Beside both it reads the entry's path manifest at /input/<UNPACK_NODE_PATHS> (UnpackNodePaths:
// paths only, never content, at most UNPACK_MAX_PATHS_BYTES), so a relative specifier passes its loader rule only when it
// names, from the importing input's own entry path, a node-language or .json file the snapshot holds inside its root.

/** Wire version: the head's `v`. */
export const UNPACK_WIRE_VERSION = 1;

/** The prefix of a tree file's input name: /input/t<j>.<kind>, read by a program for its tree rule only. */
export const UNPACK_TREE_PREFIX = 't';
/** The suffix of a Python tree file's input name: /input/t<j>.py (node's are UNPACK_NODE_KINDS). */
export const UNPACK_PY_TREE_KIND = 'py';
/**
 * The node fold's path manifest: /input/paths.json (UnpackNodePaths), beside its candidates and tree files. Its name
 * matches neither an input's (<i>.<kind>) nor a tree file's (t<j>.<kind>).
 */
export const UNPACK_NODE_PATHS = 'paths.json';
/**
 * The manifest's UTF-8 bytes at most. A manifest past it is never written: the node tree cannot be handed whole, so every
 * node candidate is `over_cap` (the driver spawns nothing). The program reads at most this many bytes of it.
 */
export const UNPACK_MAX_PATHS_BYTES = 4_194_304;

/**
 * At most this many files a run (/input/0 .. /input/15); a file past it is `over_cap`. A program's tree files count with
 * its candidates: a tree past it leaves every candidate `over_cap`.
 */
export const UNPACK_MAX_FILES = 16;
/** One input file's bytes at most (a tree file's too); a larger file is `over_cap`, unparsed. */
export const UNPACK_MAX_FILE_BYTES = 262_144;
/** All input files' bytes together at most (tree files included); the file that passes it, and every later one, is `over_cap`. */
export const UNPACK_MAX_INPUT_BYTES = 1_048_576;
/** Layers nest at most this deep: a file's own payload is depth 1; a site inside a depth-8 layer is `too_deep`. */
export const UNPACK_MAX_DEPTH = 8;
/** Layers a run at most, across all its files; a site past it is `over_cap`. */
export const UNPACK_MAX_LAYERS = 32;
/**
 * One layer's UTF-8 text at most, and every value the fold builds on the way (a decoder's output, a
 * concatenation, a slice), in bytes for bytes and in characters for str; past it the site is `over_cap`.
 * Every decompressor is a streaming one cut at this many output bytes.
 */
export const UNPACK_MAX_LAYER_BYTES = 524_288;
/** All layers' UTF-8 text a run at most (what follows the head); a layer that would pass it is `over_cap`. */
export const UNPACK_MAX_TEXT_BYTES = 1_048_576;
/** The head line's bytes at most (the newline not counted). */
export const UNPACK_HEAD_MAX_BYTES = 65_536;
/**
 * The largest LZMA dictionary a decode may need: a raw-format `filters` literal whose LZMA1/LZMA2 filter
 * asks for a larger `dict_size` (or a preset implying one) is `over_cap`, and the .xz / .lzma decoders
 * run with memlimit UNPACK_DECODER_MEM_BYTES + UNPACK_DECODER_MEM_SLACK_BYTES.
 */
export const UNPACK_DECODER_MEM_BYTES = 67_108_864;
/**
 * liblzma's own state beyond the dictionary. A 64 MiB dictionary (xz preset 9, which the house baseline
 * competitions/tiny-chess-01/agent/sunfish-4k/main.py uses) needs 64 MiB + about 66 KiB of memlimit in
 * the pinned python3.13 image (measured: the .lzma stream decodes at memlimit 67_174_848 and not below),
 * so a memlimit of exactly UNPACK_DECODER_MEM_BYTES would refuse every preset-9 payload.
 */
export const UNPACK_DECODER_MEM_SLACK_BYTES = 1_048_576;
/** The script's own wall clock: an interval timer (SIGALRM) exits it with UNPACK_EXIT_TIMEOUT at this many ms. */
export const UNPACK_SCRIPT_MS = 8_000;
/** Lambda applications nest at most this deep in one fold (an immediately applied or name-bound lambda). */
export const UNPACK_MAX_LAMBDA_NESTING = 4;
/** Failed sites listed in a run's head at most; past it a file counts the rest in `failed_more`. */
export const UNPACK_MAX_FAILED = 64;

/** Exit codes besides 0 (a head written). */
export const UNPACK_EXIT_TIMEOUT = 3;
export const UNPACK_EXIT_HEAD_TOO_LARGE = 4;

/**
 * The standard-library decoders a fold may call, by module. `codecs.decode` takes a literal codec
 * (hex, base64, zlib or bz2, under any of their codec aliases); `lzma.decompress` a literal `format`
 * and `filters` and no `memlimit`. The script's table is interpolated from this one.
 */
export const UNPACK_DECODERS = Object.freeze({
  base64: Object.freeze(['b64decode', 'standard_b64decode', 'urlsafe_b64decode', 'b32decode', 'b16decode', 'a85decode', 'b85decode'] as const),
  binascii: Object.freeze(['unhexlify', 'a2b_hex', 'a2b_base64'] as const),
  codecs: Object.freeze(['decode'] as const),
  zlib: Object.freeze(['decompress'] as const),
  gzip: Object.freeze(['decompress'] as const),
  bz2: Object.freeze(['decompress'] as const),
  lzma: Object.freeze(['decompress'] as const),
});
export type UnpackDecoderModule = keyof typeof UNPACK_DECODERS;

/**
 * Every name a layer's `via` may hold: `<module>.<function>` for each listed decoder, and `bytes.fromhex`.
 * A layer's `via` lists the decoders its fold applied, each once, in the order first applied (innermost
 * first): `exec(lzma.decompress(base64.b85decode(p)))` is ["base64.b85decode", "lzma.decompress"].
 */
export const UNPACK_VIA = Object.freeze([
  ...(Object.entries(UNPACK_DECODERS) as [UnpackDecoderModule, readonly string[]][]).flatMap(([m, fns]) => fns.map((f) => `${m}.${f}`)),
  'bytes.fromhex',
]);
export type UnpackVia = string;

/**
 * Why a site (or a whole file, `line` 0) was not unpacked:
 * - `not_literal`: the source argument is not built only from what a fold may read (literals, names
 *   bound once, names bound by one module-level run `N = E0; N += E1; ...` read after its last `+=`,
 *   `+`, literal slices, `.decode`/`.encode`/`.replace`, `bytes.fromhex`, the listed decoders, applied lambdas;
 *   and, in Python, a local def whose body is one return, applied at a call; a def's parameter read as the
 *   argument of its one call; `.join` of a folded list or tuple of strings or bytes; `bytes(x)` of a folded bytes
 *   value; a name bound once by `compile(...)` and run once), or folds to neither str nor bytes; any other
 *   rebinding (`-=`, `*=`, a `+=` in a loop, branch or function, a second assignment, a `del`, a read before
 *   the last `+=`) stays `not_literal`; so (Python) does a dunder name (its value the module's or the class
 *   body's own), a `_` whose binding may not have run, a compile given flags, dont_inherit or optimize, and a
 *   text run in a namespace other than plain dicts (a mapping of the entry's own, or a class body's left out);
 * - `rebound`: the file (or a layer under it) binds exec, eval, compile or __import__ (but as a class
 *   attribute its own class body never reads: a method named eval), rebinds or patches
 *   a decoder module's alias, names builtins / __builtins__ / setattr / globals (and their like; Python lets
 *   globals() through only called bare as an exec or eval call's namespace), imports (Python) anything but the
 *   standard library (and of it a star import but of script.ts STAR_EXPORTS, or an inline __import__ of a held module
 *   that is not a decoder one; nor the codec package, inspect, or a held module's private name), or binds a
 *   name another module of the file's tree folded through (Python: but inside a def, lambda, class or comprehension,
 *   or in a layer of the one site that read it, once that site's call ran, evaluated once in a text that runs once);
 *   nothing is unpacked for that file. The node fold answers it too for a file whose own fold left any site unresolved
 *   (each of its own sites keeps the failure it had, else `rebound`), and for a file whose texts load what the audit
 *   was not handed or reach the loader (its loader and reach rules, which hold for the exempt last layer as well: a
 *   relative specifier naming no node-language or .json file of UnpackNodePaths inside the entry, require other than
 *   called on a literal, module other than its exports). The Python fold judges the whole entry's tree: when any other Python
 *   text of the entry (a candidate, or a tree file) fails the same rule, holds an exec / eval / compile site
 *   of its own, does not parse, or a candidate left a site it could not fold (`not_literal`, `over_cap`,
 *   `too_deep`), no candidate unpacks and each site of each is `rebound` (a site the fold itself failed on keeps
 *   that reason);
 * - `decode_failed`: the fold's own evaluation raised (bad base64, a truncated stream, str + bytes): the
 *   call the entry makes would raise too;
 * - `over_cap`: a value, a layer, the run's layer count or text, a file or the input passed its cap (for
 *   either fold, a candidate whose tree of Python or node files, candidates included, does not fit the file,
 *   size and input caps is `over_cap` whole);
 * - `too_deep`: a site inside a layer at UNPACK_MAX_DEPTH;
 * - `not_text`: the folded bytes do not read as Python source (importlib.util.decode_source), or the text
 *   holds NUL or is not encodable as UTF-8;
 * - `syntax_error`: the file, or the layer `parent` names, does not parse; the layer itself is still
 *   returned.
 * Never a quote of entry bytes.
 */
export const UNPACK_SITE_FAILURES = Object.freeze(['not_literal', 'rebound', 'decode_failed', 'over_cap', 'too_deep', 'not_text', 'syntax_error'] as const);
export type UnpackSiteFailure = (typeof UNPACK_SITE_FAILURES)[number];

/** One unpacked layer. */
export interface UnpackHeadLayer {
  /** 1-based, counted across the run's files in output order. */
  n: number;
  /** 0: the file itself; else the `n` of the layer it was unpacked from (always an earlier layer of the same file). */
  parent: number;
  /** The 1-based line, in the parent's text, of the exec / eval / compile call. */
  line: number;
  /** 1 for a file's own payload, parent's depth + 1 below; at most UNPACK_MAX_DEPTH. */
  depth: number;
  /** The decoders applied (UNPACK_VIA names), each once, innermost first. */
  via: UnpackVia[];
  /** The size of the literals the payload was folded from: bytes for a bytes literal, characters for a str literal. */
  bytes_in: number;
  /** The layer text's UTF-8 bytes: exactly what follows the head for it. */
  utf8_len: number;
}

/** One site (or file) that was not unpacked. */
export interface UnpackHeadFailed {
  /** 0: the file itself; else the `n` of the layer the site sits in. */
  parent: number;
  /** The site's 1-based line in that text (a syntax error's line); 0 for the file as a whole. */
  line: number;
  why: UnpackSiteFailure;
}

export interface UnpackHeadFile {
  /** The input's index: /input/<i>. */
  i: number;
  layers: UnpackHeadLayer[];
  failed: UnpackHeadFailed[];
  /** Failed sites past UNPACK_MAX_FAILED, counted and not listed; absent when none. */
  failed_more?: number;
}

/** The head line. */
export interface UnpackHead {
  v: typeof UNPACK_WIRE_VERSION;
  /** platform.python_version() of the interpreter that folded (the pinned image's, e.g. 3.13.17). */
  python: string;
  /** One entry per input file read, in index order. */
  files: UnpackHeadFile[];
}

// ---------------------------------------------------------------- the node22 fold

/**
 * The suffix the driver gives each node input, /input/<i>.<kind>, chosen from the snapshot path's own extension (the
 * script never sees a file name): `mjs`/`mts` parse as a module, `cjs`/`cts` as CommonJS, `js`/`ts` as a module first
 * and CommonJS second; `ts`, `mts` and `cts` are stripped of their types first, as node22 runs them. The suffix, not
 * the text, says which input is TypeScript: `eval<string>(s)` is a call once stripped and a comparison in JavaScript.
 */
export const UNPACK_NODE_KINDS = Object.freeze(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'] as const);
export type UnpackNodeKind = (typeof UNPACK_NODE_KINDS)[number];

/**
 * The decoders a node fold may record in a layer's `via`, by what it calls them on. Each is the very node function the
 * entry's call names, evaluated on the fold's own values; each zlib one through an alias bound once to `zlib` or
 * `node:zlib`, with no options argument of the entry's and `{ maxOutputLength: UNPACK_MAX_LAYER_BYTES }` of the fold's.
 * A conversion that decodes nothing (`Buffer.from(s, 'utf8')`, `.toString()`, `+`, a slice) names no `via`.
 */
export const UNPACK_NODE_DECODERS = Object.freeze({
  /** `Buffer.from(string, <encoding>)` by its literal encoding: `Buffer.from:<encoding>`. */
  'Buffer.from': Object.freeze(['base64', 'base64url', 'hex'] as const),
  /** Globals called bare: their own name. */
  globals: Object.freeze(['atob', 'unescape', 'decodeURIComponent', 'decodeURI'] as const),
  /** Static members of String: `String.<function>`. */
  String: Object.freeze(['fromCharCode', 'fromCodePoint'] as const),
  /** `new TextDecoder(label?, options?).decode(bytes)`: `TextDecoder.decode`. */
  TextDecoder: Object.freeze(['decode'] as const),
  /** node:zlib's sync convenience decoders: `zlib.<function>`. */
  zlib: Object.freeze(['inflateSync', 'inflateRawSync', 'gunzipSync', 'unzipSync', 'brotliDecompressSync', 'zstdDecompressSync'] as const),
});
export type UnpackNodeDecoderGroup = keyof typeof UNPACK_NODE_DECODERS;

/**
 * Every name a node layer's `via` may hold, each passing the audit note's DECODER_NAME (server/defender/triage.ts) and
 * none an UNPACK_VIA name, so a head naming the other runtime's decoder is malformed. Ordered and recorded as Python's:
 * each once, innermost first: an eval of the inflated bytes of a base64 string, read back as text, is
 * ["Buffer.from:base64", "zlib.inflateSync"].
 */
export const UNPACK_NODE_VIA = Object.freeze([
  ...UNPACK_NODE_DECODERS['Buffer.from'].map((e) => `Buffer.from:${e}`),
  ...UNPACK_NODE_DECODERS.globals,
  ...UNPACK_NODE_DECODERS.String.map((f) => `String.${f}`),
  ...UNPACK_NODE_DECODERS.TextDecoder.map((f) => `TextDecoder.${f}`),
  ...UNPACK_NODE_DECODERS.zlib.map((f) => `zlib.${f}`),
]);

/**
 * The node fold's path manifest, /input/UNPACK_NODE_PATHS: one JSON object of paths only, never a byte of content.
 * Each path is a snapshot path (relative POSIX, from the entry's root). The program resolves a relative specifier from the
 * importing input's own entry path (`files[i]` for /input/<i>.<kind> and each layer under it, `tree[j]` for
 * /input/t<j>.<kind>) and lets it load only a path of `paths` with a node-language or .json extension; a specifier that
 * climbs out of the root, holds an empty segment, `%`, `?`, `#`, a backslash or a control character, or names no listed
 * file (a directory, a file the entry writes at run time, a path beside which node would try other extensions) trips the
 * rule. A manifest that is missing, over UNPACK_MAX_PATHS_BYTES or not of this shape lists nothing: every relative
 * specifier trips then.
 */
export interface UnpackNodePaths {
  /**
   * The entry's files by path, sorted by their UTF-8 bytes, each once: every regular file of the snapshot whose path ends
   * in a node-language extension (UNPACK_NODE_KINDS) or `.json`, never a symlink (node loads a symlink's target under
   * the target's own extension).
   */
  paths: string[];
  /** The entry path of each candidate: `files[i]` is /input/<i>.<kind>'s. */
  files: string[];
  /** The entry path of each tree file: `tree[j]` is /input/t<j>.<kind>'s. */
  tree: string[];
}

/**
 * The node fold's head line: UnpackHead with `node` in place of `python`. Its files, layers and failures are
 * UnpackHeadFile's, `i` naming /input/<i>.<kind>, `line` the eval / Function / vm call's line in its parent's text.
 */
export interface UnpackNodeHead {
  v: typeof UNPACK_WIRE_VERSION;
  /** process.versions.node of the runtime that folded (the pinned image's, e.g. 22.23.4). */
  node: string;
  /** One entry per input file read, in index order. */
  files: UnpackHeadFile[];
}

// ---------------------------------------------------------------- the data decode
//
// A second python3.13 program (grader/unpack/script-decode.ts DECODE_PY_SOURCE) decodes an entry's DATA files (a binary
// sidecar such as tiny-chess-01's `engine.lzma`, or a text file that is wholly an encoding) to text, as data: it applies
// standard-library decoders to the bytes and never parses, imports, compiles or runs them. The driver (./run.ts
// decodeData, server/defender/decode.ts DataDecoder) hands the files at /input/<i> (i = 0..n-1) under the caps below,
// in the same sandbox, limits, budget, deadline and exit codes (UNPACK_EXIT_TIMEOUT, UNPACK_EXIT_HEAD_TOO_LARGE) as the
// fold, and the program answers on stdout:
//
//   line 1   one JSON object (DecodeHead) of at most UNPACK_HEAD_MAX_BYTES, ASCII, no newline inside;
//   then     the decoded files' UTF-8 text back to back in input order, each exactly its `utf8_len` bytes.
//
// Per file it searches chains of DECODE_VIA decoders, at most DECODE_MAX_DEPTH long, depth first in the script's order,
// and keeps the first chain whose last output is text no strong decoder (DECODE_FAILURES says which are weak) takes
// further. Text is strict UTF-8 holding no control character but tab, line feed, vertical tab, form feed and carriage
// return (DECODE_TEXT_CONTROLS). A file is never "decoded" by an empty chain: one no decoder takes is `no_decoder`,
// and a text a strong decoder takes is never kept itself (a payload nested past the depth is `too_deep`, never its last
// encoding read as text).

/** The decode's wire version: its head's `v`. */
export const DECODE_WIRE_VERSION = 1;
/** At most this many files a decode (/input/0 .. /input/15); a file past it comes back undecoded `over_cap`. */
export const DECODE_MAX_FILES = 16;
/** One handed file's bytes at most; a larger file comes back undecoded `over_cap`, unsent. */
export const DECODE_MAX_FILE_BYTES = 1_048_576;
/** All handed files' bytes together at most; the file that passes it, and every later one, is `over_cap`, unsent. */
export const DECODE_MAX_INPUT_BYTES = 4_194_304;
/**
 * One file's text at most, and every value a chain builds on the way (each decompressor is a streaming one cut at this
 * many output bytes): the unpack's text cap. Past it the file is `over_cap` (a decompression bomb).
 */
export const DECODE_MAX_TEXT_BYTES = UNPACK_MAX_TEXT_BYTES;
/** All decoded files' text together at most (what follows the head); a file whose text would pass it is `over_cap`. */
export const DECODE_MAX_TOTAL_TEXT_BYTES = 4_194_304;
/** A chain applies at most this many decoders; a file whose bytes a decoder still takes at that depth is `too_deep`. */
export const DECODE_MAX_DEPTH = 4;
/**
 * The decodes one file's search may make, every chain it tries counted; past it the file is `too_deep`. A real payload
 * takes one chain; the bound keeps a file that many decoders half-take from spending the run's clock.
 */
export const DECODE_MAX_STEPS = 64;
/**
 * The base-n and hex decoders read an ASCII file (or value) only when at least this many bytes are left once ASCII
 * whitespace is removed: a short word or number is no wholly-encoded payload ("2024" is valid hex for " $").
 */
export const DECODE_MIN_ASCII_BYTES = 16;
/** The control characters a text may hold: tab, line feed, vertical tab, form feed, carriage return. */
export const DECODE_TEXT_CONTROLS = Object.freeze([0x09, 0x0a, 0x0b, 0x0c, 0x0d] as const);

/**
 * Every name a decoded file's `via` may hold, outermost first (the decoder applied to the file's own bytes first), each
 * passing the audit note's DECODER_NAME (server/defender/triage.ts). The script tries them at each step in this order:
 * - `lzma.decompress`: lzma.FORMAT_AUTO (an .xz or .lzma stream), then lzma.FORMAT_ALONE, with memlimit
 *   UNPACK_DECODER_MEM_BYTES + UNPACK_DECODER_MEM_SLACK_BYTES (a 64 MiB dictionary, xz preset 9, decodes); every stream
 *   joined, what follows the last ignored, as the one-shot call does;
 * - `gzip.decompress` (the 1f 8b magic), `bz2.decompress` (`BZh1`..`BZh9`), `zlib.decompress` (a valid zlib header);
 * - on ASCII bytes with ASCII whitespace removed (DECODE_MIN_ASCII_BYTES left): `binascii.unhexlify`,
 *   `base64.b64decode` (validate=True), `base64.urlsafe_b64decode` (its alphabet only, padded), `base64.b85decode`,
 *   `base64.a85decode` (adobe=True inside `<~ ~>`);
 * - the raw streams, which carry no magic: `lzma.decompress:raw-lzma2` (lzma.FORMAT_RAW with one FILTER_LZMA2 of
 *   dict_size UNPACK_DECODER_MEM_BYTES, the stream's own props setting lc/lp/pb; read only when the first byte is a
 *   chunk liblzma accepts first, 0x01 or 0xe0..0xff; tiny-chess-01's held `engine.lzma` is one) and
 *   `zlib.decompress:raw-deflate` (wbits -15); each must end its stream exactly at the file's last byte.
 * A decoder whose output is empty does not take the bytes.
 */
export const DECODE_VIA = Object.freeze([
  'lzma.decompress',
  'gzip.decompress',
  'bz2.decompress',
  'zlib.decompress',
  'binascii.unhexlify',
  'base64.b64decode',
  'base64.urlsafe_b64decode',
  'base64.b85decode',
  'base64.a85decode',
  'lzma.decompress:raw-lzma2',
  'zlib.decompress:raw-deflate',
] as const);
export type DecodeVia = (typeof DECODE_VIA)[number];

/**
 * Why a handed file decoded to no text, the first that holds of: `over_cap` (a cap the file or a value a chain built
 * passed: a decompression bomb, an .xz or plausible .lzma stream needing more decoder memory, or the run's caps),
 * `too_deep` (a decoder still took the bytes DECODE_MAX_DEPTH deep, or the search passed DECODE_MAX_STEPS), `not_text`
 * (a chain decoded, but to bytes that are no text), `decode_failed` (a stream its own magic or header names did not
 * decode: a truncated .xz, gzip, bz2 or zlib stream), else `no_decoder` (no decoder took the bytes: text already, or
 * binary of no known format). The weak decoders (b85, a85 and the raw streams, which take many byte strings by chance)
 * count only when a chain through them ends in text, or passes a cap. Never a quote of entry bytes.
 */
export const DECODE_FAILURES = Object.freeze(['no_decoder', 'not_text', 'over_cap', 'too_deep', 'decode_failed'] as const);
export type DecodeFailure = (typeof DECODE_FAILURES)[number];

/** One handed file that decoded to text: the chain applied and its text's UTF-8 length. */
export interface DecodeHeadDecoded {
  /** The input's index: /input/<i>. */
  i: number;
  /** The decoders applied (DECODE_VIA names), outermost first, 1 to DECODE_MAX_DEPTH of them (a name may repeat). */
  via: DecodeVia[];
  /** The input file's size in bytes. */
  bytes_in: number;
  /** The text's UTF-8 bytes: exactly what follows the head for it (at least 1). */
  utf8_len: number;
}

/** One handed file that did not. */
export interface DecodeHeadUndecoded {
  i: number;
  why: DecodeFailure;
}

/** The decode's head line. */
export interface DecodeHead {
  v: typeof DECODE_WIRE_VERSION;
  /** platform.python_version() of the interpreter that decoded (the pinned image's). */
  python: string;
  /** One entry per input file, in index order. */
  files: (DecodeHeadDecoded | DecodeHeadUndecoded)[];
}
