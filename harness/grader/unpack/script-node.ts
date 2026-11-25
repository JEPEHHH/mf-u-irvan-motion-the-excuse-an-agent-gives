// The packed-payload unpacker's node22 program, held as a string the way ./script.ts holds UNPACK_PY_SOURCE: the
// driver writes it to `<scratch>/code/unpack.mjs`, the vendored parser beside it as `acorn.mjs` (unpackNodeFiles), and
// runs `node /bot/unpack.mjs` in the pinned node22 image with the candidate files read-only at /input/<i>.<kind> and
// every other node-language text file of the entry at /input/t<j>.<kind> (the tree files, read for the tree rule
// only), no network, no env and capped CPU, memory, pids and output. The host never evaluates either text: the parser
// (./vendor/acorn-8.19.0.mjs, pinned by tests/unit/defender-unpack-boundary.test.ts rule 6) is only read here as
// text, and the program is proven only in Docker (tests/integration/docker-defender-unpack-node.test.ts).
//
// What it does: a static fold, the node twin of the Python one. For each /input/<i>.<kind> it decodes the bytes as
// node reads a module (UTF-8, a leading BOM dropped), strips a TypeScript input's types as node22 runs it
// (node:module stripTypeScriptTypes, mode strip), parses it with acorn (module, commonjs, or both for js/ts: a text
// both accept with different trees is refused), refuses a text outside a strict lexical profile (acorn is not V8),
// finds each eval, Function and vm call, and folds its source argument when it is built only from what the header of
// UNPACK_NODE_SOURCE lists, calling the very node function the entry's call names on the fold's own values (each
// zlib decoder with { maxOutputLength: UNPACK_MAX_LAYER_BYTES }). Each layer is parsed and folded again, to
// UNPACK_MAX_DEPTH. A text that rebinds, patches or reaches behind what the fold reads (the soundness rule in the
// script's header) is `rebound` and nothing is unpacked for its file, nor for a file with any site left unresolved.
// The rule is per text, but another file of the same entry can patch a builtin the fold calls before a site in a
// different file runs, so it holds tree-wide too (the tree rule in the script's header): no candidate unpacks unless
// every node text of the tree was handed inside the caps and passes. A text may load only what the audit hands or what
// is inert: node's own modules, and a relative path that names, from the importing file's own entry path, a
// node-language or .json file of the entry's path manifest (/input/paths.json, ./protocol.ts UnpackNodePaths) inside its
// root. That loader rule, and the reach rule around the loader (require other than called on a literal, module other than
// its exports, the loader's own words, the code runners as values), hold for the exempt last layer of a chain too, so it
// cannot reload its own file or load one written at run time. The wire is ./protocol.ts's (UnpackNodeHead); its head
// lists the candidates only.

import { readFileSync } from 'node:fs';
import {
  UNPACK_EXIT_HEAD_TOO_LARGE,
  UNPACK_EXIT_TIMEOUT,
  UNPACK_HEAD_MAX_BYTES,
  UNPACK_MAX_DEPTH,
  UNPACK_MAX_FAILED,
  UNPACK_MAX_FILE_BYTES,
  UNPACK_MAX_FILES,
  UNPACK_MAX_INPUT_BYTES,
  UNPACK_MAX_LAMBDA_NESTING,
  UNPACK_MAX_LAYER_BYTES,
  UNPACK_MAX_LAYERS,
  UNPACK_MAX_PATHS_BYTES,
  UNPACK_MAX_TEXT_BYTES,
  UNPACK_NODE_DECODERS,
  UNPACK_NODE_KINDS,
  UNPACK_NODE_PATHS,
  UNPACK_SCRIPT_MS,
  UNPACK_WIRE_VERSION,
} from './protocol.ts';

/** The program's file name under the spawn's codeDir (/bot). */
export const UNPACK_NODE_SCRIPT = 'unpack.mjs';
/** The vendored parser's file name beside it: the program imports it as `./acorn.mjs`. */
export const UNPACK_NODE_PARSER = 'acorn.mjs';

/** The vendored parser, read as text only (never imported on the host). */
const PARSER_URL = new URL('./vendor/acorn-8.19.0.mjs', import.meta.url);

/**
 * unpack.mjs: node builtins and the vendored parser only, the caps interpolated from protocol.ts. It never calls
 * eval, Function, a vm function, require or a dynamic import, imports nothing but node:fs, node:zlib, node:module and
 * ./acorn.mjs, and never compiles entry text (tests/unit/defender-unpack-boundary.test.ts holds it to that).
 */
export const UNPACK_NODE_SOURCE = String.raw`// make.fun's packed-payload unpacker for node22 entries (grader/unpack/script-node.ts UNPACK_NODE_SOURCE), run as
// node /bot/unpack.mjs in the pinned node22 image, the candidate files read-only at /input/<i>.<kind>. A static fold
// over the syntax tree of the vendored acorn (./acorn.mjs, beside it): it never runs, imports or compiles the entry's
// text, and the only functions it calls on the entry's values are the node functions the entry's own call names.
// The caps and the wire are grader/unpack/protocol.ts's.
//
// Sites: an eval call (and the indirect (0, eval) form), a Function call or construction, and runInThisContext,
// runInNewContext, runInContext, compileFunction and the Script construction of a vm alias (the module: a default,
// namespace or { default as } import, a require, an inline require, or a namespace import's .default member; or one
// of those functions bound by name). eval and vm run only a string (folded bytes there are not_text); a Function
// site's layer is the source the constructor builds, "function anonymous(<params joined by ,>\n) {\n<body>\n}", each
// argument coerced by String as the constructor does. A vm site's options (after the code for runInThisContext and
// Script, after the context or params for the other three) are absent, a string (the filename) or an object literal
// of plain keys, none of them cachedData or __proto__, else the site is not_literal: V8 runs cached data's bytecode
// in place of compiling the source, checking only the source's length, so the layer shown would not be what runs.
// The sites inside a layer of runInNewContext, runInContext, compileFunction or Script run against a context or
// scope the fold cannot see, so each of them is not_literal.
//
// A fold reads: string literals with plain escapes; decimal or 0x integer literals (a minus before one); a template
// whose substitutions fold to strings; a name with exactly one binding in the text, a top-level const, let or var with
// an initialiser, whose statement runs before the expression that reads it (before the site, and before the initialiser
// of another name that reads it: a var read earlier is undefined), and not a var for a site inside a function
// declaration, which is hoisted and can run before the var's statement (an array or bytes bound so only when every other
// reference to it only reads it);
// one top-level run "N = E0; N += E1; ..." read at the top level after its last +=; + on strings; slice, substring,
// substr, concat, trim, replace and replaceAll (string pattern, replacement without $), split, reverse, join and an
// array literal; String.fromCharCode and fromCodePoint over integers or one spread array; Buffer.from(string,
// encoding), Buffer.from(array), Buffer.concat(array), a Uint8Array construction over an array; toString on bytes;
// a TextDecoder construction (label, literal fatal / ignoreBOM options) read by its decode; atob, unescape,
// decodeURIComponent, decodeURI; the zlib sync decoders through an alias bound once to zlib or node:zlib (default,
// namespace or { default as } import, a namespace import's .default member, a require, an inline require, or by
// name), with no options argument; arrow functions with
// identifier parameters and an expression body, applied at once or bound once, at most MAX_LAMBDA deep (one around
// the site included).
//
// Soundness: a text is flagged, and nothing is unpacked for its file, when (a) a guarded global or a zlib / vm alias
// appears anywhere but as the callee of a call or construction, or the object of a member read or called with a
// literal key (a module alias's member only when called, or a namespace import's .default only as the object of a
// called member; a function alias, one zlib or vm function bound by name, never as the object of any member, so its
// call, apply and bind trip; a guarded global's member only in the exact call shapes a fold reads:
// String.fromCharCode, String.fromCodePoint, Buffer.from and Buffer.concat), or a vm function is called or
// constructed in any shape but a site's (VM_INERT excepted: a construction of runInThisContext and a call of the
// undocumented createScript run code too), or the name arguments is used (it holds require in a CommonJS file); (b) it
// names a back door, or a member that hands over what the fold never reads:
// .buffer and .parent (the ArrayBuffer behind a Buffer, which every small Buffer shares with the others of its pool
// slab, so a second view could rewrite bytes the fold already read) and .caller, and constructor as a member or as a
// destructuring key (the engine's Function: { constructor: F } = fn reads it as a dot does); (c) it writes,
// updates or deletes through a member whose chain names a guarded global, an alias, a method the fold evaluates or a
// name a builtin it calls reads (PATCHABLE, ignoreBOM and fatal included), or through a computed key that is not a
// literal, or calls such a computed member, or reads through one (a key that is a number by construction excepted: it
// names an element, never a property): a computed read reaches whatever its key names, and a name bound to what it
// reached is an alias no name above catches. A private name (this.#x, other.#x) is a literal key, read with its #: it
// names a member of a class of the text and never a property of a builtin, so #from, #buffer or #exports is none of
// from, buffer or exports, while the chain around it is checked as any other (this.#b.toString = f names toString,
// Buffer.#x = f names Buffer); (d) it uses with, a require or dynamic import of a specifier that is not
// a literal, imports zlib or vm dynamically, re-exports from zlib or vm (export ... from, export * from: a file that
// imports the name from it calls vm's or zlib's function under a name no alias of its own gives away), imports zlib or vm
// under a name the text binds again (no alias, so every check on aliases passes its calls by), or imports one
// of FLAGGED_MODULES or a subpath of one (node:inspector/promises is the inspector); (e) it loads anything but a node
// module or a relative path to a file the audit hands as a node-language text (.js .mjs .cjs .ts .mts .cts) or to a
// .json, that file named by the entry's path manifest (/input/paths.json): the specifier resolved from the importing
// file's own entry path (a layer's is its file's) must land inside the entry's root (no .. past it), with no empty
// segment and no %, ?, #, backslash or control character (an ES module's specifier is a URL: it decodes %, splits off ?
// and #, reads a backslash as a slash and keys its module map by the unnormalised URL, so .//main.mjs runs main.mjs a
// second time), on a path the manifest lists. Anything else can name a file the fold never read: a file the entry
// writes at run time, a directory (its package.json main or index.js), a missing x.js beside which node tries x.js.js
// and x.js.node, an unknown extension and an extensionless file (CommonJS), a .node file (native code), a bare name
// (node_modules), a #name (package.json imports), and an absolute path or a file: or data: URL anywhere; (f) it reaches
// the loader by another door: require anywhere but as the callee of a call (require.cache, require.main,
// require.resolve, require.extensions, a require passed as a value, module.require), module anywhere but as the
// object of .exports or under typeof (module.constructor is the loader, module.children and module.parent its
// modules), or one of LOADER_WORDS (getBuiltinModule, createRequire, mainModule, _load, _compile, dlopen) as a name or
// a string. The file is always checked. The last layer of a single chain (each text one site, that site run at most
// once by construction) is exempt from (a) to (c), which ordinary programs trip, but never from the loader and reach
// rules: the specifiers of (d) and (e), (f), and the code runners and the words that hand them over (eval, Function and
// a vm alias anywhere but as a site's callee, a vm function called or constructed in any shape but a site's, an
// inline require of vm used as a value, .constructor, .caller,
// arguments outside any function of the text (the CommonJS wrapper's, which holds require), prepareStackTrace, and a
// string naming eval, Function, require, constructor or caller as a member), each of
// which could run its own file's text again (its require.cache entry deleted and __filename required anew, an import
// of main.mjs?2, a vm run of the file's text) or load a file it wrote, so that a site the fold showed runs other text. Every
// other layer is checked whole. The exempt layer is shown, and runs after everything the fold read; a last layer that
// trips refuses its file exactly as a checked text does. A file that is not UTF-8, or outside the lexical profile, is
// refused whole (rebound).
//
// A layer is parsed as V8 reads it: a hashbang is accepted at its start, and a direct eval inside strict code (a
// module, a class, a program or function under use strict) is parsed as strict code, as the engine runs it. A file
// whose own fold left any site unresolved, at any depth (a computed payload, a layer that does not parse, too deep,
// over a cap ...), unpacks none of its sites: that site runs code nothing has read, which can patch a builtin before a
// later site of the same file runs. Each of its own sites answers the failure it had, else rebound.
//
// The tree rule: the rule is per text, but another file of the same entry can patch a builtin the fold calls before a
// site in a different file runs. So the driver hands every other node-language text file of the entry at
// /input/t<j>.<kind> (never folded, never in the head), each with its entry path in the manifest (a tree file's
// relative specifiers resolve from its own), and a candidate unpacks only when every input was read inside
// the caps (else each candidate is over_cap), every text of the tree, candidates and tree files alike, is UTF-8,
// parses, keeps the profile and passes the rule, no tree file holds a site of its own (else each is rebound), and no
// OTHER candidate is tainted: one that left a site unpacked (code the fold never saw runs there) or whose layers hold
// a text outside the profile or tripping the rule, its own exempt last layer included (else it is rebound). A
// candidate alone is judged as before. A manifest that is missing, over MAX_PATHS_BYTES or not of its shape lists
// nothing, and every relative specifier then trips (e).
import { closeSync, openSync, readdirSync, readSync, statSync, writeSync } from 'node:fs';
import { builtinModules, stripTypeScriptTypes } from 'node:module';
import * as zlib from 'node:zlib';
import { parse } from './acorn.mjs';

// stripTypeScriptTypes warns that it is experimental; the program's stderr stays empty.
process.removeAllListeners('warning');

const WIRE_VERSION = ${UNPACK_WIRE_VERSION};
const MAX_FILES = ${UNPACK_MAX_FILES};
const MAX_FILE_BYTES = ${UNPACK_MAX_FILE_BYTES};
const MAX_INPUT_BYTES = ${UNPACK_MAX_INPUT_BYTES};
const MAX_DEPTH = ${UNPACK_MAX_DEPTH};
const MAX_LAYERS = ${UNPACK_MAX_LAYERS};
const MAX_LAYER_BYTES = ${UNPACK_MAX_LAYER_BYTES};
const MAX_TEXT_BYTES = ${UNPACK_MAX_TEXT_BYTES};
const HEAD_MAX_BYTES = ${UNPACK_HEAD_MAX_BYTES};
const SCRIPT_MS = ${UNPACK_SCRIPT_MS};
const MAX_LAMBDA = ${UNPACK_MAX_LAMBDA_NESTING};
const MAX_FAILED = ${UNPACK_MAX_FAILED};
const EXIT_TIMEOUT = ${UNPACK_EXIT_TIMEOUT};
const EXIT_HEAD_TOO_LARGE = ${UNPACK_EXIT_HEAD_TOO_LARGE};
const INPUT_DIR = '/input';
const PATHS_NAME = ${JSON.stringify(UNPACK_NODE_PATHS)};
const MAX_PATHS_BYTES = ${UNPACK_MAX_PATHS_BYTES};

const KINDS = ${JSON.stringify(UNPACK_NODE_KINDS)};
const DECODERS = ${JSON.stringify(UNPACK_NODE_DECODERS)};

// How deep one fold may recurse through the syntax tree before it gives up (not_literal).
const MAX_FOLD_DEPTH = 2000;

const TS_KINDS = new Set(['ts', 'mts', 'cts']);
const ZLIB_DECODERS = new Set(DECODERS.zlib);
const BUFFER_VIA = new Set(DECODERS['Buffer.from']);
const GLOBAL_DECODERS = new Set(DECODERS.globals);
const STRING_DECODERS = new Set(DECODERS.String);
const GLOBAL_FNS = new Map(DECODERS.globals.map((name) => [name, globalThis[name]]));

const MODULE_SPECS = { zlib: ['zlib', 'node:zlib'], vm: ['vm', 'node:vm'] };
const VM_CALLS = new Set(['runInThisContext', 'runInNewContext', 'runInContext', 'compileFunction']);
const VM_SCRIPT = 'Script';
// The vm sites whose layer runs where the fold cannot see the globals (nested sites there are not_literal).
const VM_FOREIGN = new Set(['runInNewContext', 'runInContext', 'compileFunction', VM_SCRIPT]);
// The vm functions that run no code: a call of any other vm function in a shape that is not a site (a construction of
// runInThisContext, which is an ordinary function and runs its code; the undocumented createScript; a Script call)
// trips the loader and reach rules.
const VM_INERT = new Set(['createContext', 'isContext', 'measureMemory']);
// Where a vm site's options sit: after the code for runInThisContext and Script, after the context or params for the
// other three. cachedData there is bytecode V8 runs in place of compiling the code (checked only against its length).
const VM_OPTIONS_AT = new Map([['runInThisContext', 1], [VM_SCRIPT, 1], ['runInNewContext', 2], ['runInContext', 2], ['compileFunction', 2]]);

// The globals a fold reads or a site names.
const GUARDED = new Set(['eval', 'Function', 'Buffer', 'Uint8Array', 'String', 'TextDecoder', 'atob', 'unescape', 'decodeURIComponent', 'decodeURI', 'require']);
// Names that reach the global object, a prototype or the loader behind the fold's back. assign, _extend and
// getPrototypeOf patch an object the text reached without naming what it patches; the next six list or look up what
// no name was given for (the non-enumerable statics of Object, the accessors of its prototype), so a text could index
// its way to defineProperty or assign as a function value without writing either word; prepareStackTrace hands the
// functions on the stack (the CommonJS wrapper, whose arguments object holds require) to the text.
const BACKDOORS = new Set([
  'globalThis', 'global', 'prototype', '__proto__', 'defineProperty', 'defineProperties', 'setPrototypeOf',
  '__defineGetter__', '__defineSetter__', 'Reflect', 'Proxy', 'binding', 'mainModule', 'getBuiltinModule', 'dlopen',
  'createRequire', '_load', '_compile', 'assign', '_extend', 'getPrototypeOf',
  'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'getOwnPropertySymbols', '__lookupGetter__', '__lookupSetter__',
  'prepareStackTrace',
]);
const CONSTRUCTOR = 'constructor';
// Importing one of these, or a subpath of one (inspector/promises, test/reporters), reaches the loader, the engine or
// another thread, or (test: mock.method) replaces a method of any object it is handed by name, or (sqlite: a
// DatabaseSync opened with allowExtension, then loadExtension) loads native code from a file the fold never reads.
const FLAGGED_MODULES = new Set(['module', 'v8', 'inspector', 'repl', 'worker_threads', 'test', 'sqlite']);
// What a text may load (specOk): node's own modules, and a relative path to a file the audit hands as a node-language
// text (a name of at least one character before one of the six extensions) or to a .json (data), that file one the
// entry's path manifest lists (resolveHanded).
const BUILTINS = new Set(builtinModules);
const HANDED_PATH = new RegExp('^\\.{1,2}/(?:.*/)?[^/]+\\.(?:' + KINDS.join('|') + ')$');
const JSON_PATH = /^\.{1,2}\/(?:.*\/)?[^/]+\.json$/;
// A specifier's characters an ES module's URL resolution reads otherwise than a path: % decodes, ? and # split off,
// a backslash is a slash, a tab or newline is dropped; and the other control characters.
const UNPATHLIKE = /[\u0000-\u001f\u007f%?#\\]/;
// The loader's own words: a name or a string naming one reaches the module loader or native code behind a specifier.
const LOADER_WORDS = new Set(['getBuiltinModule', 'createRequire', 'mainModule', '_load', '_compile', 'dlopen', 'prepareStackTrace']);
// Strings naming a member that hands over a code runner or the loader: obj['eval'], fn['caller'], module['require'].
const RUNNER_MEMBERS = new Set(['eval', 'Function', 'require', 'constructor', 'caller']);
// Member names that hand over what the fold never reads: .buffer and .parent (the ArrayBuffer behind a Buffer: every
// small Buffer shares one pool slab, so a second view can rewrite bytes the fold already read) and .caller (the calling
// function, whose arguments object holds require in a CommonJS file).
const REACH_MEMBERS = new Set(['buffer', 'parent', 'caller']);
// The operators whose result is never a string: a computed key built by one names an element, not a property.
const NUMERIC_OPS = new Set(['-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>']);
const NUMERIC_ASSIGN = new Set(['-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);
// The methods a fold evaluates: a write through a member chain naming one is a patch.
const EVALUATED = new Set([
  'from', 'concat', 'fromCharCode', 'fromCodePoint', 'slice', 'substring', 'substr', 'trim', 'replace', 'replaceAll',
  'split', 'reverse', 'join', 'toString', 'valueOf', 'decode',
  ...DECODERS.zlib, ...DECODERS.globals, ...VM_CALLS, VM_SCRIPT,
]);
// What a write through a member chain may not name: the guarded globals, the evaluated methods, and every data
// property along the prototype chains of the builtins a fold calls and of what they call in turn (a Buffer's
// utf8Slice, a zlib engine's stream methods), read from this pristine process. A text that reached one of those
// objects by a computed read could patch it by such a name. Accessors are left out (an assignment cannot replace
// one), and so are the names every function or array carries.
const UNPATCHABLE = new Set(['length', 'name', 'constructor', 'prototype', 'caller', 'arguments']);
// ignoreBOM and fatal: new TextDecoder(label, options) reads both off the options object the entry passes, and an
// absent one is found on Object.prototype, which no builtin's own properties list; cachedData is read so off a vm
// site's options object.
const PATCHABLE = new Set([...GUARDED, ...EVALUATED, 'createContext', 'isContext', 'createCachedData', 'ignoreBOM', 'fatal', 'cachedData']);
function chainNames(obj) {
  for (let o = obj; o !== null && o !== undefined; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (d !== undefined && 'value' in d && !UNPATCHABLE.has(k)) PATCHABLE.add(k);
    }
  }
}
// The array iterator too: a spread and a Uint8Array built from an array walk it.
for (const o of [String, String.prototype, Array.prototype, Object.getPrototypeOf([][Symbol.iterator]()), Function.prototype, Buffer, Buffer.prototype, Uint8Array, TextDecoder.prototype]) chainNames(o);
for (const k of Object.getOwnPropertyNames(zlib.default)) {
  const d = Object.getOwnPropertyDescriptor(zlib.default, k);
  if (!UNPATCHABLE.has(k)) PATCHABLE.add(k);
  if (d !== undefined && typeof d.value === 'function' && d.value.prototype) chainNames(d.value.prototype);
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const CLASS_TYPES = new Set(['ClassBody', 'ClassDeclaration', 'ClassExpression', 'StaticBlock', 'PropertyDefinition', 'MethodDefinition']);

const HEX2 = /^[0-9a-fA-F]{2}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEXN = /^[0-9a-fA-F]+$/;
const INT_RAW = /^(?:0|[1-9][0-9]*|0[xX][0-9a-fA-F]+)$/;
const SIMPLE_ESCAPES = 'nrtbfv\\\'"' + String.fromCharCode(96);
const NAME_RE = new RegExp('^(0|[1-9][0-9]{0,5})\\.(' + KINDS.join('|') + ')$');
// A tree file: another node-language text file of the entry, read for the tree rule only, never folded or answered.
const TREE_RE = new RegExp('^t(0|[1-9][0-9]{0,5})\\.(' + KINDS.join('|') + ')$');

class Fail {
  constructor(why) {
    this.why = why;
  }
}

function fail(why) {
  throw new Fail(why);
}

// The cooperative clock (node has no SIGALRM): from the process's start, checked before each file, site and layer
// and every so often inside a fold. The driver's budget is the hard stop.
function tick() {
  if (performance.now() > SCRIPT_MS) process.exit(EXIT_TIMEOUT);
}

// A node function the entry's own call makes, on the fold's own values: what it throws, the entry's call throws too.
function guarded(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Fail) throw err;
    if (err && err.code === 'ERR_BUFFER_TOO_LARGE') fail('over_cap');
    if (err && (err.code === 'ERR_STRING_TOO_LONG' || (err instanceof RangeError && /Invalid (?:string|array) length|allocation failed/.test(String(err.message))))) fail('over_cap');
    fail('decode_failed');
  }
}

function sizeOf(v) {
  if (typeof v === 'string' || v instanceof Uint8Array || Array.isArray(v)) return v.length;
  return 0;
}

function capped(v) {
  if (sizeOf(v) > MAX_LAYER_BYTES) fail('over_cap');
  return v;
}

function room(n) {
  if (n > MAX_LAYER_BYTES) fail('over_cap');
}

const isBytes = (v) => v instanceof Uint8Array;
const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);
const isMutable = (v) => Array.isArray(v) || isBytes(v);

// ---------------------------------------------------------------- the lexical profile

function isAscii(text, from, to) {
  for (let i = from; i < to; i++) if (text.charCodeAt(i) > 0x7f) return false;
  return true;
}

// A text acorn and V8 read alike: ASCII outside string and template literals (comments and whitespace included), no
// escaped identifier or keyword, no U+2028 / U+2029 anywhere, no HTML-like comment.
function lexicalOk(text, tokens, comments) {
  if (text.includes('\u2028') || text.includes('\u2029')) return false;
  for (const at of comments) if (text.startsWith('<!--', at) || text.startsWith('-->', at)) return false;
  let prev = 0;
  for (const t of tokens) {
    if (!isAscii(text, prev, t.start)) return false;
    const label = t.type.label;
    if (label !== 'string' && label !== 'template' && label !== 'invalidTemplate') {
      if (!isAscii(text, t.start, t.end)) return false;
      if (label !== 'regexp' && text.slice(t.start, t.end).includes('\\')) return false;
    }
    prev = Math.max(prev, t.end);
  }
  return isAscii(text, prev, text.length);
}

// A string or template's raw text (delimiters off) with only plain escapes, no line continuation and no raw CR.
function plainEscapes(raw) {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 13) return false;
    if (c !== 92) continue;
    const d = raw[i + 1];
    if (d === 'x') {
      if (!HEX2.test(raw.slice(i + 2, i + 4))) return false;
      i += 3;
    } else if (d === 'u') {
      if (raw[i + 2] === '{') {
        const close = raw.indexOf('}', i + 3);
        if (close < 0 || !HEXN.test(raw.slice(i + 3, close))) return false;
        i = close;
      } else {
        if (!HEX4.test(raw.slice(i + 2, i + 6))) return false;
        i += 5;
      }
    } else if (d === '0') {
      const e = raw.charCodeAt(i + 2);
      if (e >= 48 && e <= 57) return false;
      i += 1;
    } else if (d !== undefined && SIMPLE_ESCAPES.includes(d)) {
      i += 1;
    } else {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- parsing

// A hashbang is accepted at the start of any text, as V8 accepts one at the start of a file, of eval and vm text, and of a
// compileFunction body (a Function layer starts with the word function, so none sits at its start). strict: the text is
// strict code, as a direct eval inside strict code is.
function parseWith(text, sourceType, layer, strict) {
  const tokens = [];
  const comments = [];
  const ast = parse(text, {
    ecmaVersion: 'latest',
    sourceType,
    locations: true,
    allowHashBang: true,
    strict: strict === true,
    allowReturnOutsideFunction: layer === 'body',
    onToken: tokens,
    onComment: (block, body, start) => comments.push(start),
  });
  return { ast, tokens, comments };
}

function errorLine(err) {
  return err && err.loc && Number.isInteger(err.loc.line) && err.loc.line > 0 ? err.loc.line : 0;
}

// Every node's type and span, in walk order: two parses of one text that agree on it agree on the tree.
function fingerprint(ast) {
  const out = [];
  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    out.push(node.type + ':' + node.start + ':' + node.end + (node.type === 'Identifier' || node.type === 'Literal' ? ':' + String(node.name ?? node.raw) : ''));
    const kids = [];
    childNodes(node, (child) => kids.push(child));
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k][0]);
  }
  return out.join('|');
}

function childNodes(node, visit) {
  for (const key in node) {
    if (key === 'loc' || key === 'type' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const x of v) if (x !== null && typeof x === 'object' && typeof x.type === 'string') visit([x, key]);
    } else if (v !== null && typeof v === 'object' && typeof v.type === 'string') {
      visit([v, key]);
    }
  }
}

// One text parsed as its kind says: { ok, ast, tokens, comments } or { ok: false, line } or { ok: false, ambiguous }.
function parseText(text, kind) {
  if (kind === 'mjs' || kind === 'mts') return parseOne(text, 'module', 'file');
  if (kind === 'cjs' || kind === 'cts') return parseOne(text, 'commonjs', 'file');
  if (kind === 'js' || kind === 'ts') {
    const mod = parseOne(text, 'module', 'file');
    const cjs = parseOne(text, 'commonjs', 'file');
    if (mod.ok && cjs.ok) {
      // node tries CommonJS first and a module second; a text both accept must read the same either way.
      if (fingerprint(mod.ast) !== fingerprint(cjs.ast)) return { ok: false, ambiguous: true, sites: cjs };
      return cjs;
    }
    if (cjs.ok) return cjs;
    if (mod.ok) return mod;
    return cjs;
  }
  return parseOne(text, 'script', kind);
}

function parseOne(text, sourceType, layer, strict) {
  try {
    return { ok: true, ...parseWith(text, sourceType, layer, strict) };
  } catch (err) {
    if (err instanceof Fail) throw err;
    return { ok: false, line: err instanceof SyntaxError ? errorLine(err) : 0 };
  }
}

// ---------------------------------------------------------------- one text's facts

function isStringLit(node) {
  return node !== null && node !== undefined && node.type === 'Literal' && typeof node.value === 'string';
}

// A member's literal key: its name, its string or number literal, else null (a computed key that is not a literal). A
// private name (this.#x) is a fixed key too, kept with its # so it never equals a public one: it names a member of a class
// of the text, never a property of a builtin or of the global object (#from is not Buffer.from, #exports not
// module.exports), and every rule on a member with a literal key holds for it as written.
function memberKey(m) {
  if (!m.computed) {
    if (m.property.type === 'Identifier') return m.property.name;
    if (m.property.type === 'PrivateIdentifier') return '#' + m.property.name;
    return null;
  }
  const p = m.property;
  if (p.type === 'Literal' && (typeof p.value === 'string' || typeof p.value === 'number')) return String(p.value);
  return null;
}

function moduleOf(spec) {
  for (const m of Object.keys(MODULE_SPECS)) if (MODULE_SPECS[m].includes(spec)) return m;
  return null;
}

// The entry's path manifest (/input/paths.json, read once by main before any text): the node-language and .json files
// of the entry by path, and the entry path of each input. null until read, and when it is missing, over its cap or not
// of its shape: nothing is listed then.
let ENTRY = null;

// A path as the manifest may list one: relative, no empty, . or .. segment, no control character.
function cleanPath(p) {
  if (typeof p !== 'string' || p === '' || /[\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// The entry path a relative specifier names from the file at entry path from, when that path is a file the manifest
// lists, inside the entry's root; else null. Resolved as both of node's loaders resolve it (a path's dot segments
// folded, nothing else), so the file node loads is that one: no .. past the root, no empty segment, and none of the
// characters an ES module's URL reads otherwise (UNPATHLIKE).
function resolveHanded(from, spec) {
  if (ENTRY === null || typeof from !== 'string' || !cleanPath(from) || UNPATHLIKE.test(spec)) return null;
  const parts = from.split('/');
  parts.pop();
  for (const s of spec.split('/')) {
    if (s === '.') continue;
    if (s === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    if (s === '') return null;
    parts.push(s);
  }
  const path = parts.join('/');
  return ENTRY.paths.has(path) ? path : null;
}

// Whether a text at entry path from may load spec: a node module, or a relative path to a file the audit hands (it
// reads every node-language text of the entry as a tree file) or to a .json (data), that file one the manifest lists.
// Any other specifier can name a file the fold never read: a file written at run time, a directory, a path past the
// root, an unknown extension and an extensionless file load as CommonJS, a .node file is native code, a bare name
// resolves into node_modules whose package.json names any main, a #name through its imports, and an absolute path or a
// file: or data: URL anywhere.
function specOk(spec, from) {
  if (spec.startsWith('node:')) return BUILTINS.has(spec) || BUILTINS.has(spec.slice(5));
  if (BUILTINS.has(spec)) return true;
  return (HANDED_PATH.test(spec) || JSON_PATH.test(spec)) && resolveHanded(from, spec) !== null;
}

// A require call of one string literal: that literal, else null.
function requiredSpec(node) {
  if (
    node &&
    node.type === 'CallExpression' &&
    !node.optional &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    node.arguments.length === 1 &&
    isStringLit(node.arguments[0])
  ) {
    return node.arguments[0].value;
  }
  return null;
}

class Text {
  // One parsed text (a file or a layer): every node's parent, every binding and reference by name, its aliases, its
  // sites, and whether it trips the soundness rule (flagged) and, of it, the loader and reach rules (loads), which hold
  // for the exempt last layer too. from: the entry path of the file the text is or sits in, its relative specifiers'
  // base (null: none resolves).
  constructor(ast, sourceText, layer, strict, from) {
    this.ast = ast;
    this.source = sourceText;
    this.layer = layer === true;
    this.strict = strict === true;
    this.from = typeof from === 'string' ? from : null;
    this.loads = false;
    this.directEval = false;
    this.numericMemo = new Map();
    this.readOnlyNames = new Map();
    this.up = new Map();
    this.bindings = new Map();
    this.refs = new Map();
    this.aliases = new Map();
    // The module aliases bound by a namespace import, whose .default member is the module too.
    this.namespaces = new Set();
    this.exempt = new Set();
    this.aliasInits = new Set();
    this.sites = [];
    this.flagged = false;
    this.memo = new Map();
    this.busy = new Set();
    const nodes = [];
    const stack = [[ast, null, null]];
    while (stack.length > 0) {
      const [node, parent, key] = stack.pop();
      if (this.up.has(node)) continue;
      this.up.set(node, [parent, key]);
      nodes.push(node);
      childNodes(node, ([child, k]) => stack.push([child, node, k]));
    }
    const idents = nodes.filter((n) => n.type === 'Identifier');
    for (const id of idents) this.classify(id);
    this.findAliases(nodes);
    for (const node of nodes) this.siteOf(node);
    this.sites.sort((a, b) => a.node.start - b.node.start);
    this.siteNodes = new Set(this.sites.map((s) => s.node));
    this.directEval = this.sites.some((s) => s.direct);
    for (const id of idents) this.checkName(id);
    for (const node of nodes) this.checkNode(node);
  }

  parentOf(node) {
    const e = this.up.get(node);
    return e ? e[0] : null;
  }

  keyOf(node) {
    const e = this.up.get(node);
    return e ? e[1] : null;
  }

  flag() {
    this.flagged = true;
  }

  // A trip of the loader or reach rules (the header's (d) specifiers, (e), (f) and the code runners): the text is
  // flagged, and the exempt last layer of a chain is not exempt from it.
  load() {
    this.loads = true;
    this.flagged = true;
  }

  // An identifier's role: 'member' (a member's name), 'key' (an object or class key), 'label', 'name' (an import's
  // or export's outside name), 'meta', 'bind' (a binding, recorded) or 'ref'.
  classify(id) {
    const p = this.parentOf(id);
    const k = this.keyOf(id);
    let role = null;
    if (p.type === 'MemberExpression' && k === 'property' && !p.computed) role = 'member';
    else if ((p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && k === 'key' && !p.computed) role = 'key';
    else if (p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') role = 'label';
    else if (p.type === 'MetaProperty') role = 'meta';
    else if (p.type === 'ImportSpecifier') role = p.local === id ? 'bind' : 'name';
    else if (p.type === 'ImportDefaultSpecifier' || p.type === 'ImportNamespaceSpecifier') role = 'bind';
    else if (p.type === 'ExportSpecifier') role = p.local === id && !this.parentOf(p).source ? 'ref' : 'name';
    else if (p.type === 'ExportAllDeclaration') role = 'name';
    id.role = role;
    if (role === 'bind') {
      this.bind(id, { kind: 'import', node: id, pattern: false });
      return;
    }
    if (role !== null) return;
    const b = this.bindingOf(id);
    if (b !== null) {
      id.role = 'bind';
      this.bind(id, b);
      return;
    }
    id.role = 'ref';
    const list = this.refs.get(id.name);
    if (list) list.push(id);
    else this.refs.set(id.name, [id]);
  }

  bind(id, b) {
    const list = this.bindings.get(id.name);
    if (list) list.push(b);
    else this.bindings.set(id.name, [b]);
  }

  // The binding an identifier makes, climbing out of any destructuring pattern, else null (a reference).
  bindingOf(id) {
    let child = id;
    let p = this.parentOf(id);
    let k = this.keyOf(id);
    for (;;) {
      if (p.type === 'ArrayPattern' || p.type === 'ObjectPattern' || p.type === 'RestElement' || (p.type === 'AssignmentPattern' && k === 'left')) {
        child = p;
      } else if (p.type === 'Property' && k === 'value' && this.parentOf(p).type === 'ObjectPattern') {
        child = p;
      } else {
        break;
      }
      k = this.keyOf(child);
      p = this.parentOf(child);
    }
    const pattern = child !== id;
    switch (p.type) {
      case 'VariableDeclarator':
        if (k === 'id') return { kind: 'decl', node: id, pattern, declarator: p };
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (k === 'params') return { kind: 'param', node: id, pattern, fn: p };
        if (k === 'id') return { kind: 'function', node: id, pattern };
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (k === 'id') return { kind: 'class', node: id, pattern };
        break;
      case 'CatchClause':
        if (k === 'param') return { kind: 'catch', node: id, pattern };
        break;
      case 'AssignmentExpression':
        if (k === 'left') return { kind: 'assign', node: id, pattern, expr: p };
        break;
      case 'UpdateExpression':
        return { kind: 'update', node: id, pattern };
      case 'ForInStatement':
      case 'ForOfStatement':
        if (k === 'left') return { kind: 'forleft', node: id, pattern };
        break;
      default:
        break;
    }
    return null;
  }

  // The zlib and vm aliases: a name bound once, by an import of the module or a declarator whose initialiser is a
  // require of it (an identifier, or a destructuring of plain names). A default import and an import of default by
  // name bind the module itself (its module.exports), as a namespace import does (whose .default is the module again).
  findAliases(nodes) {
    const found = new Map();
    const add = (name, sig, exempt, namespace) => {
      if (found.has(name)) found.set(name, null);
      else found.set(name, { sig, exempt, namespace: namespace === true });
    };
    for (const node of nodes) {
      if (node.type === 'ImportDeclaration' && isStringLit(node.source)) {
        const m = moduleOf(node.source.value);
        if (m === null) continue;
        for (const s of node.specifiers) {
          if (s.type === 'ImportSpecifier') {
            const imported = s.imported.type === 'Identifier' ? s.imported.name : String(s.imported.value);
            add(s.local.name, imported === 'default' ? m : m + '.' + imported, [s.local, s.imported]);
          } else {
            add(s.local.name, m, [s.local], s.type === 'ImportNamespaceSpecifier');
          }
        }
      } else if (node.type === 'VariableDeclarator' && node.init) {
        const spec = requiredSpec(node.init);
        const m = spec === null ? null : moduleOf(spec);
        if (m === null) continue;
        if (node.id.type === 'Identifier') {
          add(node.id.name, m, [node.id]);
          node.init.aliasInit = true;
        } else if (node.id.type === 'ObjectPattern' && node.id.properties.every((p) => p.type === 'Property' && !p.computed && p.key.type === 'Identifier' && p.value.type === 'Identifier')) {
          for (const p of node.id.properties) add(p.value.name, m + '.' + p.key.name, [p.key, p.value]);
          node.init.aliasInit = true;
        }
      }
    }
    for (const [name, a] of found) {
      const binds = this.bindings.get(name) || [];
      if (a === null || binds.length !== 1) continue;
      this.aliases.set(name, a.sig);
      if (a.namespace) this.namespaces.add(name);
      for (const n of a.exempt) this.exempt.add(n);
    }
    // A require of zlib or vm establishes an alias only when every name it binds is one.
    for (const node of nodes) {
      if (node.type !== 'VariableDeclarator' || !node.init || !node.init.aliasInit) continue;
      const names = node.id.type === 'Identifier' ? [node.id.name] : node.id.properties.map((p) => p.value.name);
      if (names.every((n) => this.aliases.has(n))) this.aliasInits.add(node.init);
    }
  }

  // The zlib / vm module an expression names: an alias of the module, a namespace import's .default member, or an
  // inline require of it.
  moduleNamed(node) {
    if (node.type === 'Identifier') {
      const sig = this.aliases.get(node.name);
      return sig !== undefined && !sig.includes('.') ? sig : null;
    }
    if (node.type === 'MemberExpression') return this.namespaceDefault(node);
    const spec = requiredSpec(node);
    return spec === null ? null : moduleOf(spec);
  }

  // The module a namespace import's .default member is (ns.default, ns['default']: the module's module.exports), else null.
  namespaceDefault(member) {
    if (memberKey(member) !== 'default' || member.object.type !== 'Identifier' || !this.namespaces.has(member.object.name)) return null;
    return this.aliases.get(member.object.name);
  }

  // The zlib / vm function a callee names: { mod, fn, alias } for a module's member or a function alias, else null;
  // alias is the name the module or function is bound to (null for an inline require).
  functionNamed(callee) {
    if (callee.type === 'Identifier') {
      const sig = this.aliases.get(callee.name);
      if (sig === undefined || !sig.includes('.')) return null;
      const dot = sig.indexOf('.');
      return { mod: sig.slice(0, dot), fn: sig.slice(dot + 1), alias: callee.name };
    }
    if (callee.type === 'MemberExpression') {
      const key = memberKey(callee);
      const mod = key === null ? null : this.moduleNamed(callee.object);
      if (mod === null) return null;
      let root = callee.object;
      if (root.type === 'MemberExpression') root = root.object;
      return { mod, fn: key, alias: root.type === 'Identifier' ? root.name : null };
    }
    return null;
  }

  // Whether a call or construction of a vm function is a site, or calls one of VM_INERT: any other (a construction of
  // runInThisContext, which runs its code as a call does; createScript; a Script call) trips the loader and reach rules.
  vmCallOk(node) {
    const f = this.functionNamed(node.callee);
    return f === null || f.mod !== 'vm' || this.siteNodes.has(node) || (node.type === 'CallExpression' && VM_INERT.has(f.fn));
  }

  isCallee(node) {
    const p = this.parentOf(node);
    return p !== null && (p.type === 'CallExpression' || p.type === 'NewExpression') && this.keyOf(node) === 'callee';
  }

  // Rules (a), (b) and (f), and the code runners, on one identifier.
  checkName(id) {
    const name = id.name;
    if (BACKDOORS.has(name)) this.flag();
    if (LOADER_WORDS.has(name)) this.load();
    // .constructor, and { constructor: F } = fn or { constructor } = fn: a pattern key reads the member as a dot does.
    if (name === CONSTRUCTOR && (id.role === 'member' || this.patternKey(id))) this.load();
    // arguments outside any function of the text is the CommonJS wrapper's (it holds require); inside one it is that
    // function's own, which rule (a) alone holds.
    if (name === 'arguments' && id.role !== 'member' && id.role !== 'key') {
      if (this.inFunction(id)) this.flag();
      else this.load();
    }
    if (REACH_MEMBERS.has(name) && (id.role === 'member' || this.patternKey(id))) {
      if (name === 'caller') this.load();
      else this.flag();
    }
    if (name === 'module') this.checkModule(id);
    const alias = this.aliases.get(name);
    if (!GUARDED.has(name) && alias === undefined) return;
    if (this.exempt.has(id)) return;
    // eval, Function and a vm alias run text, require loads a file: a use of one the fold does not read is a trip the
    // exempt last layer is held to as well; any other guarded global or alias is rule (a) alone.
    const runner = name === 'eval' || name === 'Function' || name === 'require' || (alias !== undefined && alias.split('.')[0] === 'vm');
    const trip = () => (runner ? this.load() : this.flag());
    if (id.role !== 'ref') return trip();
    const p = this.parentOf(id);
    const k = this.keyOf(id);
    if (this.isCallee(id)) return;
    if (p.type === 'MemberExpression' && k === 'object' && memberKey(p) !== null) {
      if (alias === undefined) {
        if (!this.readShape(id, p)) trip();
        return;
      }
      // A function alias is one zlib or vm function: any member of it (call, apply, bind, a read) runs or hands over
      // that function in a shape no site or fold reads.
      if (alias.includes('.')) return trip();
      if (this.isCallee(p)) return;
      // A namespace import's .default is the module: allowed as the object of a member with a literal key, called.
      if (this.namespaceDefault(p) !== null) {
        const q = this.parentOf(p);
        if (q.type === 'MemberExpression' && this.keyOf(p) === 'object' && memberKey(q) !== null && this.isCallee(q)) return;
      }
      return trip();
    }
    if (name === 'eval' && p.type === 'SequenceExpression' && p.expressions[p.expressions.length - 1] === id && this.isCallee(p)) return;
    trip();
  }

  // Whether node sits inside a function declaration, at any depth. A declaration is hoisted: a call placed before a top-level
  // var's statement, or one made from such a call, runs it while that var is still undefined (a var read by a site there
  // is not the value its initialiser gives), however far after the var the declaration is written.
  inDeclaration(node) {
    for (let p = this.parentOf(node); p !== null; p = this.parentOf(p)) {
      if (p.type === 'FunctionDeclaration') return true;
    }
    return false;
  }

  // Whether node sits inside a function of the text that binds its own arguments (an arrow does not).
  inFunction(node) {
    for (let p = this.parentOf(node); p !== null; p = this.parentOf(p)) {
      if (p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression') return true;
    }
    return false;
  }

  // Rule (f) on module: it may stand only as the object of a literal .exports member (module.exports, module['exports'])
  // or under typeof. module.constructor is the loader itself; module.require, module.children and module.parent load or
  // hand over modules.
  checkModule(id) {
    if (id.role !== 'ref') return;
    const p = this.parentOf(id);
    if (p.type === 'MemberExpression' && this.keyOf(id) === 'object' && memberKey(p) === 'exports') return;
    if (p.type === 'UnaryExpression' && p.operator === 'typeof') return;
    this.load();
  }

  // Whether id is the key of an object destructuring pattern: { buffer } and { buffer: b } read that member.
  patternKey(id) {
    const p = this.parentOf(id);
    return id.role === 'key' && p !== null && p.type === 'Property' && this.parentOf(p).type === 'ObjectPattern';
  }

  // A guarded global as the object of a member is one of the exact callee shapes the fold reads, called: String.fromCharCode
  // and String.fromCodePoint, Buffer.from and Buffer.concat. Any other member of one (a call, apply or bind of eval or Function, require.cache,
  // Buffer.alloc ...) can run or reach what the fold does not read.
  readShape(id, member) {
    const call = this.parentOf(member);
    if (call === null || call.type !== 'CallExpression' || this.keyOf(member) !== 'callee') return false;
    const key = memberKey(member);
    if (id.name === 'String') return STRING_DECODERS.has(key);
    return id.name === 'Buffer' && (key === 'from' || key === 'concat');
  }

  // Whether e can only be a number or a BigInt: a number, a unary - + or ~, an update, a binary operator that never builds
  // a string, a sum of two such, a conditional or logical of such, and a name whose every binding is a numeric
  // initialiser, an update or a numeric assignment (not in a layer, which shares its global names with the other texts,
  // nor beside a direct eval, which can assign to the names around it).
  numeric(e, depth) {
    if (depth > 6) return false;
    switch (e.type) {
      case 'Literal':
        return typeof e.value === 'number' || typeof e.value === 'bigint';
      case 'UnaryExpression':
        return e.operator === '-' || e.operator === '+' || e.operator === '~';
      case 'UpdateExpression':
        return true;
      case 'BinaryExpression':
        if (NUMERIC_OPS.has(e.operator)) return true;
        return e.operator === '+' && this.numeric(e.left, depth + 1) && this.numeric(e.right, depth + 1);
      case 'ConditionalExpression':
        return this.numeric(e.consequent, depth + 1) && this.numeric(e.alternate, depth + 1);
      case 'LogicalExpression':
        return this.numeric(e.left, depth + 1) && this.numeric(e.right, depth + 1);
      case 'SequenceExpression':
        return this.numeric(e.expressions[e.expressions.length - 1], depth + 1);
      case 'Identifier':
        return !this.layer && !this.directEval && this.numericName(e.name, depth);
      default:
        return false;
    }
  }

  // Whether every binding of a name is numeric, once per name (a name that depends on itself is not numeric).
  numericName(name, depth) {
    if (this.numericMemo.has(name)) return this.numericMemo.get(name);
    const binds = this.bindings.get(name);
    if (binds === undefined || depth > 6) return false;
    this.numericMemo.set(name, false);
    const ok = binds.every((b) => this.numericBinding(b, depth));
    this.numericMemo.set(name, ok);
    return ok;
  }

  numericBinding(b, depth) {
    if (b.pattern) return false;
    if (b.kind === 'update') return true;
    if (b.kind === 'decl') return b.declarator.init !== null && b.declarator.init !== undefined && this.numeric(b.declarator.init, depth + 1);
    if (b.kind !== 'assign') return false;
    const op = b.expr.operator;
    if (NUMERIC_ASSIGN.has(op)) return true;
    return (op === '=' || op === '+=' || op === '||=' || op === '&&=' || op === '??=') && this.numeric(b.expr.right, depth + 1);
  }

  // Whether a string literal is the key of a member: obj['buffer'], or { 'buffer': b } in a pattern.
  namesMember(node) {
    const p = this.parentOf(node);
    if (p === null) return false;
    if (p.type === 'MemberExpression') return this.keyOf(node) === 'property';
    return p.type === 'Property' && this.keyOf(node) === 'key';
  }

  // Rules (b) and (f) on literals, (c), (d) and (e), and the inline requires of zlib and vm.
  checkNode(node) {
    switch (node.type) {
      case 'Literal':
        if (typeof node.value === 'string') {
          const v = node.value;
          if (LOADER_WORDS.has(v) || v === CONSTRUCTOR) this.load();
          else if (BACKDOORS.has(v)) this.flag();
          if (RUNNER_MEMBERS.has(v) && this.namesMember(node)) this.load();
          else if (REACH_MEMBERS.has(v) && this.namesMember(node)) this.flag();
        }
        break;
      case 'MemberExpression':
        // A computed key that is not a literal can name any property: it reaches what no flagged word names. Only a key
        // that is a number by construction names an element, never a property.
        if (node.computed && memberKey(node) === null && !this.numeric(node.property, 0)) this.flag();
        break;
      case 'Property':
        if (node.computed && node.key.type !== 'Literal' && this.parentOf(node).type === 'ObjectPattern') this.flag();
        break;
      case 'TemplateElement': {
        const v = node.value.cooked ?? node.value.raw;
        if (LOADER_WORDS.has(v) || v === CONSTRUCTOR) this.load();
        else if (BACKDOORS.has(v)) this.flag();
        break;
      }
      case 'AssignmentExpression':
        this.checkTarget(node.left);
        break;
      case 'UpdateExpression':
        this.checkTarget(node.argument);
        break;
      case 'UnaryExpression':
        if (node.operator === 'delete') this.checkTarget(node.argument);
        break;
      case 'ForInStatement':
      case 'ForOfStatement':
        if (node.left.type !== 'VariableDeclaration') this.checkTarget(node.left);
        break;
      case 'CallExpression':
      case 'NewExpression':
        this.checkCallee(node.callee);
        if (!this.vmCallOk(node)) this.load();
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          // A specifier that is not one literal (__filename, a built path) can name any file, its own included.
          const spec = requiredSpec(node);
          if (spec === null) this.load();
          else this.checkSpec(spec);
          const m = spec === null ? null : moduleOf(spec);
          if (m !== null && !this.aliasInits.has(node)) {
            const p = this.parentOf(node);
            if (!(p.type === 'MemberExpression' && this.keyOf(node) === 'object' && memberKey(p) !== null && this.isCallee(p))) {
              if (m === 'vm') this.load();
              else this.flag();
            }
          }
        }
        break;
      case 'TaggedTemplateExpression':
        this.checkCallee(node.tag);
        break;
      case 'ImportExpression':
        // Not one literal (import.meta.url, a built URL): it can name any module, its own included.
        if (!isStringLit(node.source)) this.load();
        else {
          this.checkSpec(node.source.value);
          const m = moduleOf(node.source.value);
          if (m === 'vm') this.load();
          else if (m !== null) this.flag();
        }
        break;
      case 'ImportDeclaration':
        if (node.source) {
          this.checkSpec(String(node.source.value));
          // A name an import of vm or zlib binds is an alias only when the text binds it nowhere else (findAliases). One
          // that is bound again (a parameter or a local of the same name in some function) is no alias, and then every
          // check on aliases passes it by: a call of vm's runInThisContext is neither a site nor a trip. Such an import trips
          // as a require of the module that is no alias does.
          const m = moduleOf(String(node.source.value));
          if (m !== null && node.specifiers.some((s) => !this.aliases.has(s.local.name))) {
            if (m === 'vm') this.load();
            else this.flag();
          }
        }
        break;
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
        if (node.source) {
          this.checkSpec(String(node.source.value));
          // A re-export hands vm's or zlib's functions to the files that import it, under names no alias of theirs
          // gives away: export { runInThisContext } from 'node:vm', export * from 'node:vm', export { default } ...
          const m = moduleOf(String(node.source.value));
          if (m === 'vm') this.load();
          else if (m !== null) this.flag();
        }
        break;
      case 'WithStatement':
        this.flag();
        break;
      default:
        break;
    }
  }

  // A flagged module is compared by its first segment: node:inspector/promises is the inspector, test/reporters the
  // test runner's.
  checkSpec(spec) {
    const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
    if (FLAGGED_MODULES.has(bare.split('/')[0]) || !specOk(spec, this.from)) this.load();
  }

  // Rule (c) on a call: a computed member that is not a literal, called.
  checkCallee(callee) {
    let c = callee;
    while (c.type === 'ChainExpression') c = c.expression;
    if (c.type === 'MemberExpression' && memberKey(c) === null) this.flag();
  }

  // Rule (c) on a write target: a member, or each member inside a destructuring target.
  checkTarget(target) {
    const stack = [target];
    while (stack.length > 0) {
      const t = stack.pop();
      if (t.type === 'MemberExpression' || t.type === 'ChainExpression') this.checkChain(t);
      else if (t.type === 'ArrayPattern') for (const e of t.elements) e && stack.push(e);
      else if (t.type === 'ObjectPattern') for (const p of t.properties) stack.push(p.type === 'Property' ? p.value : p);
      else if (t.type === 'RestElement') stack.push(t.argument);
      else if (t.type === 'AssignmentPattern') stack.push(t.left);
    }
  }

  checkChain(target) {
    let c = target;
    for (;;) {
      if (c.type === 'ChainExpression') {
        c = c.expression;
      } else if (c.type === 'MemberExpression') {
        const key = memberKey(c);
        if (key === null || PATCHABLE.has(key) || this.aliases.has(key)) return this.flag();
        c = c.object;
      } else if (c.type === 'CallExpression' || c.type === 'NewExpression') {
        c = c.callee;
      } else {
        break;
      }
    }
    if (c.type === 'Identifier' && (GUARDED.has(c.name) || EVALUATED.has(c.name) || this.aliases.has(c.name))) this.flag();
  }

  // An eval, Function or vm site at node.
  siteOf(node) {
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
    const callee = node.callee;
    const isNew = node.type === 'NewExpression';
    let kind = null;
    let fn = null;
    if (callee.type === 'Identifier' && callee.name === 'Function') kind = 'function';
    else if (!isNew && callee.type === 'Identifier' && callee.name === 'eval') kind = 'eval';
    else if (!isNew && callee.type === 'SequenceExpression' && callee.expressions.length > 1) {
      const last = callee.expressions[callee.expressions.length - 1];
      if (last.type === 'Identifier' && last.name === 'eval') kind = 'eval';
    } else {
      const f = this.functionNamed(callee);
      if (f !== null && f.mod === 'vm' && (isNew ? f.fn === VM_SCRIPT : VM_CALLS.has(f.fn))) {
        kind = 'vm';
        fn = f;
      }
    }
    if (kind === null) return;
    this.sites.push({ node, kind, fn, line: node.loc.start.line, foreign: fn !== null && VM_FOREIGN.has(fn.fn), body: fn !== null && fn.fn === 'compileFunction', direct: kind === 'eval' && callee.type === 'Identifier' });
  }

  // Whether the code at node is strict: in a module, in a layer parsed as strict code, in a class, or under a use strict
  // directive of the program or of a function around it. A direct eval there runs its text as strict code too.
  strictAt(node) {
    if (this.strict || this.ast.sourceType === 'module') return true;
    for (let p = this.parentOf(node); p !== null; p = this.parentOf(p)) {
      if (p.type === 'ClassDeclaration' || p.type === 'ClassExpression') return true;
      let body = null;
      if (p.type === 'Program') body = p.body;
      else if (FUNCTION_TYPES.has(p.type) && p.body.type === 'BlockStatement') body = p.body.body;
      if (body === null) continue;
      for (const s of body) {
        if (s.type !== 'ExpressionStatement' || s.directive === undefined) break;
        if (s.directive === 'use strict') return true;
      }
    }
    return false;
  }

  // A site that runs at most once by construction: no loop, function, class body or arrow that is not applied at
  // once between it and the top of its text.
  once(site) {
    let child = site.node;
    for (let p = this.parentOf(child); p !== null; child = p, p = this.parentOf(p)) {
      if (LOOP_TYPES.has(p.type) || CLASS_TYPES.has(p.type)) return false;
      if (p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression') return false;
      if (p.type === 'ArrowFunctionExpression' && !(this.parentOf(p) && this.parentOf(p).type === 'CallExpression' && this.keyOf(p) === 'callee')) return false;
    }
    return true;
  }

  inside(node, outer) {
    return node.start >= outer.start && node.end <= outer.end;
  }

  // A top-level statement's declarator: its VariableDeclaration sits directly in the program (or an export there).
  topLevel(declarator) {
    const decl = this.parentOf(declarator);
    if (decl === null || decl.type !== 'VariableDeclaration') return null;
    let p = this.parentOf(decl);
    if (p !== null && p.type === 'ExportNamedDeclaration') p = this.parentOf(p);
    return p !== null && p.type === 'Program' ? decl : null;
  }
}

// ---------------------------------------------------------------- the fold

function val(v, via, lits) {
  return { v, via: via || [], lits: lits || new Map() };
}

function mergeVia(...vias) {
  const out = [];
  for (const via of vias) for (const name of via) if (!out.includes(name)) out.push(name);
  return out;
}

function mergeLits(...lits) {
  const out = new Map();
  for (const m of lits) for (const [k, n] of m) out.set(k, n);
  return out;
}

class Fold {
  // One site's fold over its text. A value is { v, via, lits }: the node value, the decoders applied (UNPACK_NODE_VIA
  // names, innermost first), and the literal nodes it was built from with their sizes (characters of a string, one
  // for an integer read as data).
  constructor(text, site, deps) {
    this.t = text;
    // When the expression being folded runs: the site's position, or (inside a bound name's initialiser) the position of
    // that initialiser, which ran where it is written. A name folds only if its statement is before then.
    this.at = site.node.start;
    this.deps = deps;
    this.depth = 0;
    this.steps = 0;
    // A site inside a function declaration can run before the statement of a top-level var written above it (Text.inDeclaration).
    this.hoisted = text.inDeclaration(site.node);
  }

  value(node, env, lam) {
    if (++this.depth > MAX_FOLD_DEPTH) fail('not_literal');
    if ((++this.steps & 1023) === 0) tick();
    try {
      return this.value1(node, env, lam);
    } finally {
      this.depth -= 1;
    }
  }

  value1(node, env, lam) {
    switch (node.type) {
      case 'Literal':
        return this.literal(node);
      case 'TemplateLiteral':
        return this.template(node, env, lam);
      case 'Identifier':
        return this.name(node, env);
      case 'BinaryExpression': {
        if (node.operator !== '+') fail('not_literal');
        const a = this.value(node.left, env, lam);
        const b = this.value(node.right, env, lam);
        if (typeof a.v !== 'string' || typeof b.v !== 'string') fail('not_literal');
        room(a.v.length + b.v.length);
        return val(a.v + b.v, mergeVia(a.via, b.via), mergeLits(a.lits, b.lits));
      }
      case 'CallExpression':
        if (node.optional) fail('not_literal');
        return this.call(node, env, lam);
      case 'NewExpression':
        return this.construct(node, env, lam);
      case 'ArrayExpression': {
        const items = node.elements.map((e) => (e === null || e.type === 'SpreadElement' ? fail('not_literal') : this.value(e, env, lam)));
        return val(capped(items.map((x) => x.v)), mergeVia(...items.map((x) => x.via)), mergeLits(...items.map((x) => x.lits)));
      }
      case 'UnaryExpression': {
        if (node.operator !== '-' || node.argument.type !== 'Literal' || typeof node.argument.value !== 'number') fail('not_literal');
        const n = this.literal(node.argument);
        return val(-n.v, [], n.lits);
      }
      default:
        return fail('not_literal');
    }
  }

  literal(node) {
    if (typeof node.value === 'string') {
      if (!plainEscapes(node.raw.slice(1, -1))) fail('not_literal');
      return val(capped(node.value), [], new Map([[node, node.value.length]]));
    }
    if (typeof node.value === 'number') {
      if (!INT_RAW.test(node.raw) || !isInt(node.value)) fail('not_literal');
      return val(node.value, [], new Map([[node, 1]]));
    }
    if (typeof node.value === 'boolean') return val(node.value);
    return fail('not_literal');
  }

  template(node, env, lam) {
    const parts = [];
    const vias = [];
    const lits = [];
    let size = 0;
    for (let i = 0; i < node.quasis.length; i++) {
      const q = node.quasis[i];
      if (typeof q.value.cooked !== 'string' || !plainEscapes(q.value.raw)) fail('not_literal');
      parts.push(q.value.cooked);
      lits.push(new Map([[q, q.value.cooked.length]]));
      size += q.value.cooked.length;
      if (i < node.expressions.length) {
        const x = this.value(node.expressions[i], env, lam);
        if (typeof x.v !== 'string') fail('not_literal');
        parts.push(x.v);
        vias.push(x.via);
        lits.push(x.lits);
        size += x.v.length;
      }
      room(size);
    }
    return val(parts.join(''), mergeVia(...vias), mergeLits(...lits));
  }

  name(id, env) {
    const t = this.t;
    const nm = id.name;
    const binds = t.bindings.get(nm) || [];
    // An arrow's parameter: the nearest enclosing arrow declaring it, with nothing inside it binding the name again.
    for (let a = t.parentOf(id); a !== null; a = t.parentOf(a)) {
      if (a.type !== 'ArrowFunctionExpression') continue;
      const p = a.params.find((x) => x.type === 'Identifier' && x.name === nm);
      if (p === undefined) continue;
      if (binds.some((b) => b.node !== p && t.inside(b.node, a))) fail('not_literal');
      const frame = env.get(a);
      if (frame === undefined || !frame.has(nm)) fail('not_literal');
      return this.force(frame.get(nm));
    }
    if (binds.length === 1) {
      const d = this.declOf(binds[0]);
      if (d === null || d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression') fail('not_literal');
      // A let or const read before its statement throws (the site never runs); a var reads undefined. So a site a hoisted
      // function holds folds only names bound by let or const.
      if (this.hoisted && t.parentOf(d).kind === 'var') fail('not_literal');
      this.deps.push({ text: t, kind: 'name', name: nm });
      const found = this.assigned(d.init);
      if (isMutable(found.v)) {
        // Once per name and text: a site per reference to a bound array would otherwise read every reference each time.
        let only = t.readOnlyNames.get(nm);
        if (only === undefined) {
          only = (t.refs.get(nm) || []).every((ref) => this.readOnly(ref));
          t.readOnlyNames.set(nm, only);
        }
        if (!only) fail('not_literal');
        this.deps.push({ text: t, kind: 'mutable', name: nm });
      }
      return found;
    }
    const run = this.runOf(id, binds);
    if (run === null) fail('not_literal');
    this.deps.push({ text: t, kind: 'name', name: nm });
    return this.runValue(run);
  }

  force(thunk) {
    if (!thunk.done) {
      thunk.value = this.value(thunk.node, thunk.env, thunk.lam);
      thunk.done = true;
    }
    return thunk.value;
  }

  // The one binding's declarator when it is a plain top-level const, let or var with an initialiser, whose statement runs
  // before the expression being folded does (this.at): a var read by the initialiser of another name written above its
  // own statement reads undefined, whatever the site below it sees.
  declOf(b) {
    if (b.kind !== 'decl' || b.pattern || !b.declarator.init) return null;
    if (this.t.topLevel(b.declarator) === null) return null;
    if (b.declarator.end > this.at) return null;
    return b.declarator;
  }

  // A reference that only reads a bound array or bytes: an argument of a decoder, a copy or a site, the receiver of a
  // toString or join call, the spread of a fromCharCode / fromCodePoint, an element of a Buffer.concat list.
  readOnly(ref) {
    const t = this.t;
    let node = ref;
    let p = t.parentOf(node);
    if (p.type === 'ArrayExpression') {
      const call = t.parentOf(p);
      return call.type === 'CallExpression' && t.keyOf(p) === 'arguments' && this.shape(call) === 'Buffer.concat';
    }
    if (p.type === 'SpreadElement') {
      node = p;
      p = t.parentOf(p);
      return p.type === 'CallExpression' && t.keyOf(node) === 'arguments' && this.shape(p) === 'String.from';
    }
    if (p.type === 'MemberExpression' && t.keyOf(node) === 'object') {
      const key = memberKey(p);
      return (key === 'toString' || key === 'join') && t.isCallee(p) && t.parentOf(p).type === 'CallExpression';
    }
    if ((p.type === 'CallExpression' || p.type === 'NewExpression') && t.keyOf(node) === 'arguments') {
      if (t.sites.some((s) => s.node === p)) return true;
      const shape = this.shape(p);
      return shape === 'zlib' || shape === 'Buffer.from' || shape === 'Buffer.concat' || shape === 'decode' || shape === 'Uint8Array';
    }
    return false;
  }

  // What a call or construction is, by its callee's shape.
  shape(call) {
    const t = this.t;
    const c = call.callee;
    if (call.type === 'NewExpression') return c.type === 'Identifier' && c.name === 'Uint8Array' ? 'Uint8Array' : null;
    const f = t.functionNamed(c);
    if (f !== null) return f.mod === 'zlib' && ZLIB_DECODERS.has(f.fn) ? 'zlib' : null;
    if (c.type !== 'MemberExpression') return null;
    const key = memberKey(c);
    if (c.object.type === 'Identifier' && c.object.name === 'Buffer' && (key === 'from' || key === 'concat')) return 'Buffer.' + key;
    if (c.object.type === 'Identifier' && c.object.name === 'String' && STRING_DECODERS.has(key)) return 'String.from';
    if (key === 'decode' && c.object.type === 'NewExpression' && c.object.callee.type === 'Identifier' && c.object.callee.name === 'TextDecoder') return 'decode';
    return null;
  }

  // name bound as one top-level run "N = E0; N += E1; ..." (a let or var, then += statements, nothing else binding
  // N), read at the top level after the last +=: the run's right sides in order, else null.
  runOf(id, binds) {
    const t = this.t;
    if (binds.length < 2) return null;
    const decls = binds.filter((b) => b.kind === 'decl');
    const adds = binds.filter((b) => b.kind === 'assign');
    if (decls.length !== 1 || adds.length !== binds.length - 1) return null;
    const d = decls[0];
    if (d.pattern || !d.declarator.init) return null;
    const declaration = t.topLevel(d.declarator);
    if (declaration === null || declaration.kind === 'const') return null;
    const rights = [];
    let last = declaration.end;
    for (const a of adds.slice().sort((x, y) => x.node.start - y.node.start)) {
      const e = a.expr;
      if (a.pattern || e.operator !== '+=' || e.left !== a.node) return null;
      const s = t.parentOf(e);
      if (s.type !== 'ExpressionStatement' || t.parentOf(s).type !== 'Program' || s.start < last) return null;
      last = s.end;
      rights.push(e.right);
    }
    let top = id;
    for (;;) {
      const p = t.parentOf(top);
      if (p === null) return null;
      if (p.type === 'Program') break;
      if (FUNCTION_TYPES.has(p.type) || CLASS_TYPES.has(p.type)) return null;
      top = p;
    }
    if (top.start < last) return null;
    return [d.declarator.init, ...rights];
  }

  runValue(exprs) {
    const parts = exprs.map((e) => this.assigned(e));
    let size = 0;
    for (const p of parts) {
      if (typeof p.v !== 'string') fail('not_literal');
      size += p.v.length;
    }
    room(size);
    return val(parts.map((p) => p.v).join(''), mergeVia(...parts.map((p) => p.via)), mergeLits(...parts.map((p) => p.lits)));
  }

  // A bound expression's value, folded once per text.
  assigned(expr) {
    const memo = this.t.memo;
    if (memo.has(expr)) {
      const found = memo.get(expr);
      if (found instanceof Fail) throw found;
      return found;
    }
    if (this.t.busy.has(expr)) fail('not_literal');
    this.t.busy.add(expr);
    // The initialiser ran where it is written, in order: not at the site's time, and not out of order in a hoisted function.
    const [at, hoisted] = [this.at, this.hoisted];
    this.at = expr.start;
    this.hoisted = false;
    try {
      const found = this.value(expr, new Map(), 0);
      memo.set(expr, found);
      return found;
    } catch (err) {
      if (err instanceof Fail) memo.set(expr, err);
      throw err;
    } finally {
      [this.at, this.hoisted] = [at, hoisted];
      this.t.busy.delete(expr);
    }
  }

  args(call, env, lam) {
    if (call.arguments.some((a) => a.type === 'SpreadElement')) fail('not_literal');
    return call.arguments.map((a) => this.value(a, env, lam));
  }

  unbound(name) {
    if (this.t.bindings.has(name)) fail('not_literal');
  }

  call(node, env, lam) {
    const t = this.t;
    const c = node.callee;
    if (c.type === 'ArrowFunctionExpression') return this.apply(c, node, env, lam);
    const f = t.functionNamed(c);
    if (f !== null) {
      if (f.mod !== 'zlib' || !ZLIB_DECODERS.has(f.fn)) fail('not_literal');
      this.deps.push({ text: t, kind: 'alias', name: f.alias, sig: f.alias === null ? null : t.aliases.get(f.alias) });
      return this.inflate(f.fn, node, env, lam);
    }
    if (c.type === 'Identifier') {
      if (GLOBAL_DECODERS.has(c.name)) {
        this.unbound(c.name);
        const [s, ...rest] = this.args(node, env, lam);
        if (s === undefined || rest.length > 0 || typeof s.v !== 'string') fail('not_literal');
        const fn = GLOBAL_FNS.get(c.name);
        return val(capped(guarded(() => fn(s.v))), mergeVia(s.via, [c.name]), s.lits);
      }
      const binds = t.bindings.get(c.name) || [];
      if (binds.length === 1) {
        const d = this.declOf(binds[0]);
        if (d !== null && d.init.type === 'ArrowFunctionExpression') {
          this.deps.push({ text: t, kind: 'name', name: c.name });
          return this.apply(d.init, node, env, lam);
        }
      }
      return fail('not_literal');
    }
    if (c.type !== 'MemberExpression') return fail('not_literal');
    const key = memberKey(c);
    if (key === null) fail('not_literal');
    const obj = c.object;
    if (obj.type === 'Identifier' && obj.name === 'String' && STRING_DECODERS.has(key)) {
      this.unbound('String');
      return this.fromChars(key, node, env, lam);
    }
    if (obj.type === 'Identifier' && obj.name === 'Buffer' && (key === 'from' || key === 'concat')) {
      this.unbound('Buffer');
      return key === 'from' ? this.bufferFrom(node, env, lam) : this.bufferConcat(node, env, lam);
    }
    if (key === 'decode' && obj.type === 'NewExpression' && obj.callee.type === 'Identifier' && obj.callee.name === 'TextDecoder') {
      this.unbound('TextDecoder');
      return this.textDecode(obj, node, env, lam);
    }
    if (t.moduleNamed(obj) !== null) fail('not_literal');
    return this.method(this.value(obj, env, lam), key, node, env, lam);
  }

  construct(node, env, lam) {
    const c = node.callee;
    if (c.type === 'Identifier' && c.name === 'Uint8Array') {
      this.unbound('Uint8Array');
      const [a, ...rest] = this.args(node, env, lam);
      if (a === undefined || rest.length > 0 || !Array.isArray(a.v) || !a.v.every(isInt)) fail('not_literal');
      return val(new Uint8Array(a.v), a.via, a.lits);
    }
    return fail('not_literal');
  }

  apply(arrow, call, env, lam) {
    if (lam >= MAX_LAMBDA || arrow.async || !arrow.expression) fail('not_literal');
    if (arrow.params.some((p) => p.type !== 'Identifier')) fail('not_literal');
    if (call.arguments.length !== arrow.params.length || call.arguments.some((a) => a.type === 'SpreadElement')) fail('not_literal');
    const frame = new Map();
    arrow.params.forEach((p, i) => frame.set(p.name, { node: call.arguments[i], env, lam, done: false, value: null }));
    const inner = new Map(env);
    inner.set(arrow, frame);
    return this.value(arrow.body, inner, lam + 1);
  }

  // The frames of the arrows applied at once around the site, outermost first.
  siteEnv(site) {
    const t = this.t;
    const arrows = [];
    for (let a = t.parentOf(site.node); a !== null; a = t.parentOf(a)) if (a.type === 'ArrowFunctionExpression') arrows.push(a);
    let env = new Map();
    let lam = 0;
    for (const a of arrows.reverse()) {
      const call = t.parentOf(a);
      if (lam >= MAX_LAMBDA || call.type !== 'CallExpression' || t.keyOf(a) !== 'callee') continue;
      if (a.params.some((p) => p.type !== 'Identifier') || call.arguments.length !== a.params.length || call.arguments.some((x) => x.type === 'SpreadElement')) continue;
      const frame = new Map();
      const outer = env;
      a.params.forEach((p, i) => frame.set(p.name, { node: call.arguments[i], env: outer, lam, done: false, value: null }));
      env = new Map(env);
      env.set(a, frame);
      lam += 1;
    }
    return { env, lam };
  }

  inflate(fn, node, env, lam) {
    const [data, ...rest] = this.args(node, env, lam);
    if (data === undefined || rest.length > 0 || !(isBytes(data.v) || typeof data.v === 'string')) fail('not_literal');
    const out = guarded(() => zlib[fn](data.v, { maxOutputLength: MAX_LAYER_BYTES }));
    return val(capped(out), mergeVia(data.via, ['zlib.' + fn]), data.lits);
  }

  fromChars(key, node, env, lam) {
    let codes;
    let parts;
    if (node.arguments.length === 1 && node.arguments[0].type === 'SpreadElement') {
      const a = this.value(node.arguments[0].argument, env, lam);
      if (!Array.isArray(a.v)) fail('not_literal');
      codes = a.v;
      parts = [a];
    } else {
      parts = this.args(node, env, lam);
      codes = parts.map((p) => p.v);
    }
    if (!codes.every(isInt)) fail('not_literal');
    room(codes.length);
    const out = guarded(() => String[key](...codes));
    return val(capped(out), mergeVia(...parts.map((p) => p.via), ['String.' + key]), mergeLits(...parts.map((p) => p.lits)));
  }

  bufferFrom(node, env, lam) {
    const [data, enc, ...rest] = this.args(node, env, lam);
    if (data === undefined || rest.length > 0) fail('not_literal');
    if (typeof data.v === 'string') {
      if (enc !== undefined && typeof enc.v !== 'string') fail('not_literal');
      const encoding = enc === undefined ? undefined : enc.v;
      const out = guarded(() => (encoding === undefined ? Buffer.from(data.v) : Buffer.from(data.v, encoding)));
      const lower = encoding === undefined ? '' : encoding.toLowerCase();
      const via = BUFFER_VIA.has(lower) ? ['Buffer.from:' + lower] : [];
      return val(capped(out), mergeVia(data.via, enc === undefined ? [] : enc.via, via), data.lits);
    }
    if (Array.isArray(data.v) && enc === undefined && data.v.every(isInt)) return val(Buffer.from(data.v), data.via, data.lits);
    return fail('not_literal');
  }

  bufferConcat(node, env, lam) {
    const [list, ...rest] = this.args(node, env, lam);
    if (list === undefined || rest.length > 0 || !Array.isArray(list.v) || !list.v.every(isBytes)) fail('not_literal');
    room(list.v.reduce((n, b) => n + b.length, 0));
    return val(guarded(() => Buffer.concat(list.v)), list.via, list.lits);
  }

  textDecode(ctor, node, env, lam) {
    if (ctor.arguments.length > 2 || ctor.arguments.some((a) => a.type === 'SpreadElement')) fail('not_literal');
    let label;
    let options;
    const vias = [];
    if (ctor.arguments.length > 0) {
      const l = this.value(ctor.arguments[0], env, lam);
      if (typeof l.v !== 'string') fail('not_literal');
      label = l.v;
      vias.push(l.via);
    }
    if (ctor.arguments.length > 1) options = this.options(ctor.arguments[1]);
    const [bytes, ...rest] = this.args(node, env, lam);
    if (bytes === undefined || rest.length > 0 || !isBytes(bytes.v)) fail('not_literal');
    const out = guarded(() => new TextDecoder(label, options).decode(bytes.v));
    return val(capped(out), mergeVia(...vias, bytes.via, ['TextDecoder.decode']), bytes.lits);
  }

  // A TextDecoder's options: an object literal of fatal / ignoreBOM booleans.
  options(node) {
    if (node.type !== 'ObjectExpression') fail('not_literal');
    const out = {};
    for (const p of node.properties) {
      if (p.type !== 'Property' || p.computed || p.kind !== 'init' || p.method || p.shorthand) fail('not_literal');
      const key = p.key.type === 'Identifier' ? p.key.name : isStringLit(p.key) ? p.key.value : null;
      if ((key !== 'fatal' && key !== 'ignoreBOM') || p.value.type !== 'Literal' || typeof p.value.value !== 'boolean') fail('not_literal');
      out[key] = p.value.value;
    }
    return out;
  }

  method(recv, key, node, env, lam) {
    const v = recv.v;
    const args = this.args(node, env, lam);
    const strings = () => args.every((a) => typeof a.v === 'string');
    if (typeof v === 'string') {
      switch (key) {
        case 'slice':
        case 'substring':
        case 'substr':
          if (args.length > 2 || !args.every((a) => isInt(a.v))) fail('not_literal');
          return val(v[key](...args.map((a) => a.v)), recv.via, recv.lits);
        case 'trim':
          if (args.length > 0) fail('not_literal');
          return val(v.trim(), recv.via, recv.lits);
        case 'concat':
          if (!strings()) fail('not_literal');
          room(args.reduce((n, a) => n + a.v.length, v.length));
          return val(v.concat(...args.map((a) => a.v)), mergeVia(recv.via, ...args.map((a) => a.via)), mergeLits(recv.lits, ...args.map((a) => a.lits)));
        case 'replace':
        case 'replaceAll': {
          if (args.length !== 2 || !strings() || args[1].v.includes('$')) fail('not_literal');
          const [pat, rep] = [args[0].v, args[1].v];
          let hits = 0;
          if (key === 'replace') hits = v.includes(pat) ? 1 : 0;
          else if (pat === '') hits = v.length + 1;
          else for (let at = v.indexOf(pat); at >= 0 && hits <= MAX_LAYER_BYTES; at = v.indexOf(pat, at + pat.length)) hits += 1;
          room(v.length + hits * Math.max(0, rep.length - pat.length));
          return val(v[key](pat, rep), mergeVia(recv.via, ...args.map((a) => a.via)), recv.lits);
        }
        case 'split':
          if (args.length !== 1 || !strings()) fail('not_literal');
          return val(capped(v.split(args[0].v)), mergeVia(recv.via, args[0].via), recv.lits);
        default:
          return fail('not_literal');
      }
    }
    if (Array.isArray(v)) {
      if (key === 'reverse') {
        if (args.length > 0) fail('not_literal');
        return val(v.reverse(), recv.via, recv.lits);
      }
      if (key === 'join') {
        if (args.length > 1 || !strings() || !v.every((x) => typeof x === 'string' || isInt(x))) fail('not_literal');
        const sep = args.length > 0 ? args[0].v : ',';
        room(v.reduce((n, x) => n + String(x).length, 0) + Math.max(0, v.length - 1) * sep.length);
        return val(v.join(sep), mergeVia(recv.via, ...args.map((a) => a.via)), recv.lits);
      }
      return fail('not_literal');
    }
    if (isBytes(v) && key === 'toString') {
      if (args.length > 1 || !strings()) fail('not_literal');
      const enc = args.length > 0 ? args[0].v : undefined;
      return val(capped(guarded(() => (enc === undefined ? v.toString() : v.toString(enc)))), mergeVia(recv.via, ...args.map((a) => a.via)), recv.lits);
    }
    return fail('not_literal');
  }

  // A site's text: { text, via, lits }.
  site(site) {
    const { env, lam } = this.siteEnv(site);
    const node = site.node;
    if (site.kind === 'function') {
      const parts = this.args(node, env, lam);
      for (const p of parts) if (typeof p.v !== 'string' && !isBytes(p.v)) fail('not_literal');
      const strs = parts.map((p) => guarded(() => String(p.v)));
      room(strs.reduce((n, s) => n + s.length, 32));
      const body = strs.length > 0 ? strs[strs.length - 1] : '';
      const text = 'function anonymous(' + strs.slice(0, -1).join(',') + '\n) {\n' + body + '\n}';
      return { text, via: mergeVia(...parts.map((p) => p.via)), lits: mergeLits(...parts.map((p) => p.lits)) };
    }
    const a = node.arguments[0];
    if (a === undefined || a.type === 'SpreadElement') fail('not_literal');
    if (site.kind === 'vm') this.vmOptions(node, site.fn.fn);
    const x = this.value(a, env, lam);
    if (isBytes(x.v)) fail('not_text');
    if (typeof x.v !== 'string') fail('not_literal');
    return { text: x.v, via: x.via, lits: x.lits };
  }

  // A vm site's options: absent, a string (the filename), or an object literal of plain keys, none of them cachedData
  // (bytecode V8 runs in place of compiling the code, checked only against the code's length) or __proto__ (an
  // object it would inherit cachedData from). Anything else (a name, a spread, a computed key) can carry cachedData.
  vmOptions(node, fn) {
    if (node.arguments.some((x) => x.type === 'SpreadElement')) fail('not_literal');
    const o = node.arguments[VM_OPTIONS_AT.get(fn)];
    if (o === undefined || isStringLit(o)) return;
    if (o.type !== 'ObjectExpression') fail('not_literal');
    for (const p of o.properties) {
      if (p.type !== 'Property' || p.computed) fail('not_literal');
      const key = p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
      if (key === 'cachedData' || key === '__proto__') fail('not_literal');
    }
  }
}

// ---------------------------------------------------------------- a file's tree of layers

function utf8Of(text) {
  if (!text.isWellFormed() || text.includes('\0')) fail('not_text');
  return Buffer.from(text, 'utf8');
}

// A layer's text parsed and checked: { text, unparsed, line, refused }. from: its file's entry path (a layer's relative
// specifiers resolve from the file it runs in).
function layerText(source, site, strict, from) {
  const parsed = parseOne(source, 'script', site.body ? 'body' : 'layer', strict);
  if (!parsed.ok) return { text: null, unparsed: true, line: parsed.line, refused: false };
  const refused = !lexicalOk(source, parsed.tokens, parsed.comments);
  return { text: new Text(parsed.ast, source, true, strict, from), unparsed: false, line: 0, refused };
}

class Tree {
  // One file and the layers unpacked under it, numbered from 1 until the run commits them. from: the file's entry path.
  constructor(run, from) {
    this.run = run;
    this.from = from;
    this.layers = [];
    this.failed = [];
    this.deps = [];
    this.textBytes = 0;
    this.nodes = [];
    this.topFailed = new Map();
  }

  // A site left unpacked: [parent layer (0 for the file), line, why]; the file's own sites keep their why for the
  // answer of a file that unpacks none (refusal).
  fail(parent, line, why, site) {
    this.failed.push([parent, line, why]);
    if (parent === 0 && site !== undefined && !this.topFailed.has(site)) this.topFailed.set(site, why);
  }

  // The answer of a file that unpacks none of its sites: each site of the file's own text with the failure it had, else
  // rebound (its layer folded, but a site the fold could not resolve, at any depth, runs code nothing has read).
  refusal(file) {
    return file.text.sites.map((s) => [0, s.line, this.topFailed.get(s) ?? 'rebound']);
  }

  process(tnode, depth, foreign) {
    this.nodes.push(tnode);
    const text = tnode.text;
    for (const site of text.sites) {
      tick();
      const line = site.line;
      if (foreign) {
        this.fail(tnode.k, line, 'not_literal', site);
        continue;
      }
      if (depth + 1 > MAX_DEPTH) {
        this.fail(tnode.k, line, 'too_deep', site);
        continue;
      }
      let folded;
      let data;
      try {
        folded = new Fold(text, site, this.deps).site(site);
        data = utf8Of(folded.text);
      } catch (err) {
        if (!(err instanceof Fail)) throw err;
        this.fail(tnode.k, line, err.why, site);
        continue;
      }
      if (data.length > MAX_LAYER_BYTES || this.run.layers + this.layers.length >= MAX_LAYERS || this.run.textBytes + this.textBytes + data.length > MAX_TEXT_BYTES) {
        this.fail(tnode.k, line, 'over_cap', site);
        continue;
      }
      const k = this.layers.length + 1;
      let bytesIn = 0;
      for (const n of folded.lits.values()) bytesIn += n;
      this.layers.push([k, tnode.k, line, depth + 1, folded.via, bytesIn, data]);
      this.textBytes += data.length;
      tick();
      const child = { k, ...layerText(folded.text, site, site.direct && text.strictAt(site.node), this.from), site, children: [] };
      tnode.children.push(child);
      if (child.unparsed) {
        this.nodes.push(child);
        this.fail(k, child.line, 'syntax_error');
        continue;
      }
      this.process(child, depth + 1, foreign || site.foreign);
    }
  }

  // The text exempt from the soundness rule: the last of a single chain whose every site runs at most once, else null.
  exempt(file) {
    let t = file;
    for (;;) {
      if (t.unparsed || t.text.sites.length === 0) return t === file ? null : t;
      const sites = t.text.sites;
      if (sites.length !== 1 || t.children.length !== 1 || !t.text.once(sites[0])) return null;
      t = t.children[0];
    }
  }

  // Whether the tree stays sound: every text but the exempt one passes the rule, the exempt one passes its loader and
  // reach rules (it could otherwise run its own file again, or a file it wrote, after patching what a site read), and
  // no name a fold read is bound (or, for a bound array or bytes, named at all) by another text of the tree.
  sound(file) {
    const exempt = this.exempt(file);
    if (exempt !== null && !exempt.unparsed && exempt.text.loads) return false;
    const checked = this.nodes.filter((n) => n !== exempt);
    for (const n of checked) if (n !== file && (n.unparsed || n.refused || n.text.flagged)) return false;
    for (const dep of this.deps) {
      if (dep.name === null) continue;
      for (const n of checked) {
        if (n.unparsed || n.text === dep.text) continue;
        if (dep.kind === 'mutable' && n.text.refs.has(dep.name)) return false;
        const binds = n.text.bindings.get(dep.name);
        if (!binds) continue;
        if (dep.kind === 'alias' && n.text.aliases.get(dep.name) === dep.sig) continue;
        return false;
      }
    }
    return true;
  }

  // Whether running this file could change what a site of ANOTHER file folds to: it left a site unpacked (code the
  // fold never saw runs there), or one of its layers is outside the profile or trips the rule (the exempt last layer
  // of its own chain included: that exemption holds for this file's folds only).
  tainted(file) {
    if (this.failed.length > 0) return true;
    return this.nodes.some((n) => n !== file && (n.refused || (n.text !== null && n.text.flagged)));
  }
}

// One input's text as node runs it (UTF-8, a leading BOM dropped, a TypeScript input's types stripped), parsed and
// checked against the lexical profile and the rule: { ok: true, text, rebound } or { ok: false, failed }, where
// failed (or rebound, for a text that is sound but must not unpack) is its file's answer as a candidate. from: its
// entry path (the manifest's), or null.
function prepare(kind, raw, from) {
  let source = raw.toString('utf8');
  // Bytes that are not UTF-8 decode to replacement characters, which node's two loaders need not count alike.
  const wellFormed = Buffer.from(source, 'utf8').equals(raw);
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  if (TS_KINDS.has(kind)) {
    try {
      source = stripTypeScriptTypes(source, { mode: 'strip' });
    } catch {
      return { ok: false, failed: [[0, 0, 'syntax_error']] };
    }
  }
  const parsed = parseText(source, kind);
  if (!parsed.ok && !parsed.ambiguous) return { ok: false, failed: [[0, parsed.line, 'syntax_error']] };
  const p = parsed.ambiguous ? parsed.sites : parsed;
  const text = new Text(p.ast, source, false, false, from);
  const rebound = text.sites.map((s) => [0, s.line, 'rebound']);
  if (parsed.ambiguous || !wellFormed || !lexicalOk(source, p.tokens, p.comments) || text.flagged) return { ok: false, failed: rebound };
  return { ok: true, text, rebound };
}

class Run {
  constructor() {
    this.layers = 0;
    this.textBytes = 0;
    this.failed = 0;
    this.texts = [];
    this.files = [];
  }

  commit(i, treeLayers, treeFailed) {
    const base = this.layers;
    const entry = { i, layers: [], failed: [] };
    for (const [k, parent, line, depth, via, bytesIn, data] of treeLayers) {
      entry.layers.push({ n: base + k, parent: parent ? base + parent : 0, line, depth, via: [...via], bytes_in: bytesIn, utf8_len: data.length });
      this.texts.push(data);
      this.textBytes += data.length;
    }
    this.layers += treeLayers.length;
    let more = 0;
    for (const [parent, line, why] of treeFailed) {
      if (this.failed >= MAX_FAILED) {
        more += 1;
        continue;
      }
      entry.failed.push({ parent: parent ? base + parent : 0, line, why });
      this.failed += 1;
    }
    if (more > 0) entry.failed_more = more;
    this.files.push(entry);
  }
}

// The candidates (/input/<i>.<kind>) and the tree files (/input/t<j>.<kind>), each in index order.
function inputs() {
  let names;
  try {
    names = readdirSync(INPUT_DIR).sort();
  } catch {
    return { files: [], tree: [] };
  }
  const listed = (re) => {
    const found = new Map();
    for (const name of names) {
      const m = re.exec(name);
      if (m === null) continue;
      const i = Number(m[1]);
      if (!found.has(i)) found.set(i, { i, kind: m[2], path: INPUT_DIR + '/' + name });
    }
    return [...found.values()].sort((a, b) => a.i - b.i);
  };
  return { files: listed(NAME_RE), tree: listed(TREE_RE) };
}

function isFileAt(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The paths manifest (ENTRY): { paths: the Set of the entry's listed files, files: each candidate's entry path by i,
// tree: each tree file's by j }, or null when it is missing, over MAX_PATHS_BYTES, not JSON or not of that shape.
function entryPaths() {
  const path = INPUT_DIR + '/' + PATHS_NAME;
  if (!isFileAt(path)) return null;
  const raw = readCapped(path, MAX_PATHS_BYTES);
  if (raw.length > MAX_PATHS_BYTES) return null;
  let m;
  try {
    m = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  const strings = (a) => Array.isArray(a) && a.every((p) => typeof p === 'string');
  if (m === null || typeof m !== 'object' || !strings(m.paths) || !strings(m.files) || !strings(m.tree)) return null;
  return { paths: new Set(m.paths.filter(cleanPath)), files: m.files, tree: m.tree };
}

function readCapped(path, cap = MAX_FILE_BYTES) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function writeAll(buf) {
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (err) {
      if (!err || err.code !== 'EAGAIN') throw err;
    }
  }
}

// Every input read, then the tree rule (the header): the tree checked whole, the candidates folded in order with the
// run's caps counted as if each sound one is kept, then each candidate answered.
function main() {
  const { files, tree } = inputs();
  ENTRY = entryPaths();
  // An input's entry path: the manifest's for its index, or null (none of its relative specifiers resolves).
  const fromOf = (list, i) => (ENTRY !== null && typeof ENTRY[list][i] === 'string' ? ENTRY[list][i] : null);
  let total = 0;
  let count = 0;
  // Every input read inside the caps, and every text of the tree passing the profile and the rule.
  let whole = true;
  let clean = true;
  const cands = [];
  for (const input of files) {
    tick();
    if (!isFileAt(input.path)) continue;
    count += 1;
    let raw = null;
    if (count <= MAX_FILES) {
      raw = readCapped(input.path);
      total += raw.length;
      if (raw.length > MAX_FILE_BYTES || total > MAX_INPUT_BYTES) raw = null;
    }
    if (raw === null) whole = false;
    cands.push({ i: input.i, kind: input.kind, from: fromOf('files', input.i), raw, prep: null, tree: null, file: null, sound: false, tainted: false });
  }
  for (const input of tree) {
    tick();
    if (!isFileAt(input.path)) {
      whole = false;
      continue;
    }
    count += 1;
    if (count > MAX_FILES) {
      whole = false;
      continue;
    }
    const raw = readCapped(input.path);
    total += raw.length;
    if (raw.length > MAX_FILE_BYTES || total > MAX_INPUT_BYTES) {
      whole = false;
      continue;
    }
    const prep = prepare(input.kind, raw, fromOf('tree', input.i));
    if (!prep.ok || prep.text.sites.length > 0) clean = false;
  }
  for (const c of cands) {
    if (c.raw === null) continue;
    tick();
    c.prep = prepare(c.kind, c.raw, c.from);
    if (!c.prep.ok) clean = false;
  }
  // Each candidate's tree folded in order, the run's caps counted as if every sound one is kept.
  const folding = new Run();
  if (whole && clean) {
    for (const c of cands) {
      tick();
      c.tree = new Tree(folding, c.from);
      c.file = { k: 0, text: c.prep.text, unparsed: false, refused: false, site: null, children: [] };
      c.tree.process(c.file, 0, false);
      c.sound = c.tree.sound(c.file);
      c.tainted = c.tree.tainted(c.file);
      if (c.sound && c.tree.failed.length === 0) {
        folding.layers += c.tree.layers.length;
        folding.textBytes += c.tree.textBytes;
      }
    }
  }
  const run = new Run();
  for (const c of cands) {
    if (c.raw === null) run.commit(c.i, [], [[0, 0, 'over_cap']]);
    else if (!c.prep.ok) run.commit(c.i, [], c.prep.failed);
    else if (!whole) run.commit(c.i, [], [[0, 0, 'over_cap']]);
    else if (!clean || !c.sound || cands.some((o) => o !== c && o.tainted)) run.commit(c.i, [], c.prep.rebound);
    else if (c.tree.failed.length > 0) run.commit(c.i, [], c.tree.refusal(c.file));
    else run.commit(c.i, c.tree.layers, c.tree.failed);
  }
  const head = Buffer.from(JSON.stringify({ v: WIRE_VERSION, node: process.versions.node, files: run.files }), 'utf8');
  if (head.length > HEAD_MAX_BYTES || !isAscii(head.toString('latin1'), 0, head.length)) {
    writeSync(2, 'unpack: the head is over its cap\n');
    process.exit(EXIT_HEAD_TOO_LARGE);
  }
  writeAll(Buffer.concat([head, Buffer.from('\n'), ...run.texts]));
}

main();
`;

let parserText: string | null = null;

/** One file the spawn's code directory holds. */
export interface UnpackNodeFile {
  /** Its name under codeDir (/bot). */
  name: string;
  text: string;
}

/**
 * The files the node22 program's code directory holds, in the order to write them: the program (UNPACK_NODE_SCRIPT)
 * and the vendored parser beside it (UNPACK_NODE_PARSER), read as text once and cached. Neither is evaluated here.
 */
export function unpackNodeFiles(): readonly UnpackNodeFile[] {
  parserText ??= readFileSync(PARSER_URL, 'utf8');
  return Object.freeze([
    Object.freeze({ name: UNPACK_NODE_SCRIPT, text: UNPACK_NODE_SOURCE }),
    Object.freeze({ name: UNPACK_NODE_PARSER, text: parserText }),
  ]);
}
