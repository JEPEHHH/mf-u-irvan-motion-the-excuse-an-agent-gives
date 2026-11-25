// The packed-payload unpacker's Python script, held as a string the way grader/scrape/launch.ts holds
// PYTHON_LAUNCHER_SOURCE: the driver writes it to `<scratch>/code/unpack.py` and runs it in the pinned
// python3.13 image (python3 -P -s /bot/unpack.py) with the candidate files read-only at /input, no
// network, no env and capped CPU, memory, pids and output. The host never runs Python
// (.cosmos/rules/project-context.mdc), so the script is proven only in Docker
// (tests/integration/docker-defender-unpack.test.ts).
//
// What it does: a static fold. For each /input/<i> it parses the raw bytes with CPython's own `ast`
// (the coding cookie honoured), finds each call of the builtin exec or eval and of compile, and folds
// the source argument when it is built only from str / bytes / int literals, names bound once (before
// the call, in a scope the call sees), names bound by one module-level run `N = E0` then `N += E1` ...
// `N += Ek` (every statement a direct child of the module body, no other binding of N anywhere, N read
// at module scope in a module-level statement after the last `+=`; folded as E0 + E1 + ... + Ek), `+`
// on str or bytes, slices with literal bounds, `.decode` / `.encode` / `.replace` with literal arguments
// (a `.replace` whose result would pass the cap is `over_cap` before it is built), `.join` of a str or bytes
// separator over a list or tuple of its own type (or of the empty str over a str: the str itself; a result past the
// cap is `over_cap` before it is built), the builtin `bytes` of one bytes value (the value itself), `bytes.fromhex`,
// the decoders of protocol.ts UNPACK_DECODERS
// (reached by `import m`, `import m as a`, `from m import f [as g]`, `a = __import__('m')` or an inline
// `__import__('m')`) and lambdas with positional parameters applied to such arguments (an immediately
// applied lambda around the call included), at most UNPACK_MAX_LAMBDA_NESTING deep. A plain def whose body is one
// `return E` (a docstring before it allowed) is applied like a lambda at a call of its name, its one binding run
// before the call. A site inside a plain def with parameters, at module scope, whose name the text reads once, as the
// callee of one call at module scope with one positional argument per parameter, reads each parameter as that
// call's argument (no parameter bound again in the def; no other module of the tree reads or binds the def's name),
// and a local of that def (its one binding an assignment in the def's body) is folded in the frame of that one call, so
// its value reads the parameters as the def's body does.
// A compile site's code bound once to a name the text reads once, as the first argument of an exec or eval after the
// binding in the same scope, is run by that exec or eval as if handed straight to it (no other module of the tree
// reads or binds a module-level such name). The decode helper is that code returned instead:
//   def _decode(p): s = zlib.decompress(base64.b85decode(p)); return compile(s, 'main.py', 'exec')
//   exec(_decode(b'...'))
// a plain def written in the module body whose body, a docstring aside, is one-name assignments of locals bound nowhere
// else and then `return compile(<source>, <str literal>, 'exec')`, its name bound once and read once in the text, as the
// callee of a call with one positional argument per parameter, handed straight as the first argument to an exec at module
// scope after the def. That compile is the site, run by that exec, which is no site of its own; its parameters are read
// from that call, and no other module of the tree reads or binds the def's name. Any other use of the def (called twice,
// its result kept or handed to anything but an exec, a mode other than 'exec', a global or any other statement in its
// body) leaves that exec a site of its own, which the fold does not read: `not_literal`. A loop that computes the payload
// (a base-n digit loop over ord, `*`, `-`, comparisons, int.to_bytes) is not folded: that site stays `not_literal`.
// Each decompressor is the streaming one cut at UNPACK_MAX_LAYER_BYTES of output, and joins concatenated streams exactly
// as the one-shot stdlib call does, so a layer is byte for byte what that call returns. Folded bytes
// become text as Python reads source (importlib.util.decode_source); each layer is parsed and folded
// again, to UNPACK_MAX_DEPTH. A file whose tree binds exec / eval / compile / __import__, rebinds or
// patches a decoder alias or names the builtins' back doors is `rebound` and nothing is unpacked for it. One binding of
// those names is let through: a class attribute (a store written in a class body itself, not its bases, keywords,
// decorators or type parameters, the name in no global, nonlocal or walrus), which no bare name read outside that class
// body resolves to (a method, a lambda or a nested class does not see class scope); a read of the name that sits directly
// in that class body (its defaults, decorators, annotations, bases and comprehensions included) is still `rebound`.
// It never runs, imports or compiles the entry. The wire is protocol.ts's.
//
// The tree rule: that rule is per text, but another file of the same entry can patch a decoder or a builtin
// before a site in a different file runs (the entry starts at one file and the rest load or run when it
// does). So the driver hands, beside its candidates, every other Python text file of the entry at
// /input/t<j>.py (read for this rule only: never folded, never in the head), and no candidate unpacks unless
// every input was read inside the caps (else each candidate is `over_cap`), every Python text of the tree,
// candidates and tree files alike, parses and passes the rule above, no tree file holds an exec / eval /
// compile site of its own (its payload is never read), and no candidate left a site it could not fold
// (`not_literal`, `over_cap`, `too_deep`: code the fold never saw runs there, and it can patch a decoder
// before a later site runs, in that file or in another). A tree that fails refuses every candidate: no layer,
// each site of the file listed as `rebound` (one its own fold failed on keeps its reason, so a file with one
// unresolved site reads as it always did; a candidate that does not parse keeps `syntax_error`). A candidate
// alone is judged as before, so a single file with one literal packed site unpacks as it always did.
//
// Across the modules of one file's tree (the file and its layers, which an exec runs in the file's globals), a name a
// fold read must not be bound by another module, with two exceptions that cannot change what a folded call runs. A
// binding that stays inside a def, lambda, class or comprehension (no global or nonlocal statement names it, no walrus
// binds it) never reaches the globals the fold read. And a binding at a layer's module level, when that layer runs under
// the very site whose fold read the name, that site's call is evaluated at most once (a bare expression or assignment
// statement of its text's module body, so in no loop, branch, def, lambda or comprehension) and its text runs at most
// once (the file itself, or a layer an exec runs from such a site in such a text): the call's arguments are evaluated
// before the layer exists and never again. Any other binding is `rebound`.
//
// A name is only what the fold read where nothing else can answer for it: no dunder (a docstring sets __doc__, a layer's
// included, and a class body its __module__ and __qualname__, with no binding the fold sees), and a `_` only once its
// binding has run (sys.displayhook sets the builtin). A compile site given flags, dont_inherit or optimize is not read
// (a future's grammar or top-level await reads the text differently), nor a site whose text runs in anything but plain
// dicts (a mapping class of the entry's answers the layer's names itself, and so does a class body's namespace a
// metaclass prepared).
//
// The rule also holds a decoder module's object where it stands: the name an import of a decoder module, of what the
// decoders lean on (struct, io, re, the codec registry ...) or of sys binds may stand only as the object of an attribute
// read, never handed on, held in a container or assigned to a name (m = base64; m.name = f is a store the keys do not
// list), and no attribute read hands out a module again (gzip.zlib is zlib, as shutil.zlib is; a builtin function's
// __self__ is its module; nor does a lookup by a literal name, getattr(gzip, 'zlib'), nor a name the standard library
// keeps one under, MODULE_ATTRS); a held module's private name (its decode tables and caches, which a method call
// changes with no store) is not read, imported or looked up. A lookup by a name that is not a
// literal str (getattr, operator.attrgetter, operator.methodcaller) can name any attribute at all, a function's globals
// included, so it is flagged, and so are the
// standard library's own evals of a str (typing and inspect on a quoted annotation, functools.singledispatch,
// logging.config's handler args, multiprocessing's generated proxy methods) and the entry points to frames.
//
// The same rule covers how code gets loaded. Each of these is flagged like a rebinding, in the script's own
// lists (BACKDOOR_ATTRS, BACKDOOR_STRINGS, PATCHED_KEYS, LOADER_MODULES, LOADER_ATTRS): an import of anything but the
// standard library (the image's sys.stdlib_module_names) or of a module that loads or patches code another way, or
// that module reached as an attribute of another or imported from one by name (rlcompleter.__main__ is the entry's own),
// relative imports included (a sibling file of the entry is no import the fold can allow: python3 -P -s keeps
// the entry's directory off sys.path, so a sibling loads only through sys.path or importlib, both refused by
// name, and a text that imports a sibling can write to its globals); sys.path and the other tables of the
// import machinery; a module's namespace reached through __dict__, setattr, globals, vars, frames or the
// collector; the codec registry and the codec package (its alias table and cache pick the codec a name decodes with);
// a function's code at all (types.FunctionType reruns it under other globals) and a module's __all__; a store to a
// function's defaults or a module's class; and exec, eval,
// compile or __import__ handed around as a value, which would run text the fold never reads. Three uses of those
// names are let through, each because it reaches nothing the text could not reach already: globals() called bare as
// the namespace argument of an exec or eval call (the namespace an exec at module scope runs in anyway; stored, read,
// copied or handed anywhere else it is still flagged); __import__ called on one str literal naming a module an import
// statement may name and whose object may travel (none of HELD_MODULES: the same module `import m` gives); and a star
// import of a module of STAR_EXPORTS, which binds there exactly the names listed, each held to the rule as if imported by
// name (any other star import binds names nobody listed, and is flagged).

import {
  UNPACK_DECODER_MEM_BYTES,
  UNPACK_DECODER_MEM_SLACK_BYTES,
  UNPACK_DECODERS,
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
  UNPACK_MAX_TEXT_BYTES,
  UNPACK_PY_TREE_KIND,
  UNPACK_SCRIPT_MS,
  UNPACK_TREE_PREFIX,
  UNPACK_WIRE_VERSION,
} from './protocol.ts';

/** The script's file name under the spawn's codeDir (/bot). */
export const UNPACK_SCRIPT = 'unpack.py';

/** The decoder table as a Python dict literal (JSON's strings and lists are Python's too). */
const DECODERS_PY = JSON.stringify(Object.fromEntries(Object.entries(UNPACK_DECODERS).map(([m, fns]) => [m, [...fns]])));

/**
 * unpack.py: stdlib only, the caps interpolated from protocol.ts. It never calls the builtins that run
 * or build code from text, and imports nothing that spawns, dials or deserialises objects
 * (tests/unit/defender-unpack-boundary.test.ts holds it to that).
 */
export const UNPACK_PY_SOURCE = String.raw`# make.fun's packed-payload unpacker (grader/unpack/script.ts UNPACK_PY_SOURCE), run as
# python3 -P -s /bot/unpack.py in the pinned python3.13 image, the candidate files read-only at
# /input/<i> and the entry's other Python files at /input/t<j>.py (read for the tree rule only). A
# static fold over CPython's own ast: it never runs, imports or builds code from the entry. Stdlib
# only; the caps and the wire are grader/unpack/protocol.ts's.
import ast
import base64
import binascii
import bz2
import encodings
import gzip
import importlib.util
import io
import json
import lzma
import operator
import os
import platform
import signal
import struct
import sys
import zlib

WIRE_VERSION = ${UNPACK_WIRE_VERSION}
MAX_FILES = ${UNPACK_MAX_FILES}
MAX_FILE_BYTES = ${UNPACK_MAX_FILE_BYTES}
MAX_INPUT_BYTES = ${UNPACK_MAX_INPUT_BYTES}
MAX_DEPTH = ${UNPACK_MAX_DEPTH}
MAX_LAYERS = ${UNPACK_MAX_LAYERS}
MAX_LAYER_BYTES = ${UNPACK_MAX_LAYER_BYTES}
MAX_TEXT_BYTES = ${UNPACK_MAX_TEXT_BYTES}
HEAD_MAX_BYTES = ${UNPACK_HEAD_MAX_BYTES}
DECODER_MEM_BYTES = ${UNPACK_DECODER_MEM_BYTES}
DECODER_MEMLIMIT = ${UNPACK_DECODER_MEM_BYTES + UNPACK_DECODER_MEM_SLACK_BYTES}
SCRIPT_MS = ${UNPACK_SCRIPT_MS}
MAX_LAMBDA = ${UNPACK_MAX_LAMBDA_NESTING}
MAX_FAILED = ${UNPACK_MAX_FAILED}
EXIT_TIMEOUT = ${UNPACK_EXIT_TIMEOUT}
EXIT_HEAD_TOO_LARGE = ${UNPACK_EXIT_HEAD_TOO_LARGE}
INPUT_DIR = "/input"
TREE_PREFIX = "${UNPACK_TREE_PREFIX}"
TREE_SUFFIX = ".${UNPACK_PY_TREE_KIND}"

DECODERS = ${DECODERS_PY}
MODULES = {"base64": base64, "binascii": binascii, "zlib": zlib, "gzip": gzip, "bz2": bz2, "lzma": lzma}

# The calls whose first argument is source text, and the names whose binding anywhere makes a file's
# sites unsound to fold.
SITE_RUNNERS = ("exec", "eval")
SITE_BUILDER = "compile"
IMPORTER = "__import__"
GUARDED_NAMES = frozenset(SITE_RUNNERS + (SITE_BUILDER, IMPORTER))
# Naming any of these (a name, an imported name, a def, a parameter) reaches the builtins or a module's
# namespace behind the fold's back.
BACKDOOR_NAMES = frozenset(("builtins", "__builtins__", "setattr", "delattr", "globals", "locals", "vars", "import_module"))
# Naming any of these as an attribute, an imported name or a part of a module path does the same through
# the import machinery's tables, a function's globals, the frames of running code, the collector's
# objects, the mock patcher and raw code objects. barry_as_FLUFL changes the grammar the text an exec
# runs is read in, so a layer ast.parse refuses could run.
BACKDOOR_ATTRS = BACKDOOR_NAMES | frozenset((
    "__dict__", "modules", "meta_path", "path_hooks", "path_importer_cache", "__setattr__", "__delattr__",
    "__globals__", "f_globals", "f_builtins", "f_locals", "get_referents", "get_referrers", "get_objects",
    "mock", "CodeType", "barry_as_FLUFL",
))
# The standard library functions that eval or exec a str the fold never reads (typing's and inspect's forward
# references, functools.singledispatch's annotations, logging.config's handler args, multiprocessing.managers'
# generated proxy methods), the entry points to frames and tracebacks (whose f_globals and f_locals are the
# namespaces above), and what hands out the module a function came from, a module's loader or an attribute
# looked up by a name in a str. Naming any of them, as an attribute, an imported name or a literal str, is the
# same trip as the names above.
EVAL_ATTRS = frozenset((
    "get_type_hints", "get_annotations", "evaluate_forward_ref", "ForwardRef", "singledispatch", "singledispatchmethod",
    "fileConfig", "dictConfig", "MakeProxyType",
))
FRAME_ATTRS = frozenset((
    "_getframe", "_current_frames", "currentframe", "getouterframes", "getinnerframes", "walk_stack", "walk_tb", "settrace", "setprofile",
    "f_back", "tb_frame", "gi_frame", "cr_frame", "ag_frame", "__traceback__",
))
REACH_ATTRS = frozenset((
    "getmodule", "getmembers", "get_field", "__loader__", "__spec__", "__getattribute__", "__self__", "__objclass__", "__func__",
    "__wrapped__", "__closure__", "__mro__", "__bases__", "__base__", "__subclasses__", "__cause__", "__context__",
))
# A function's code (or a generator's) runs again under any globals types.FunctionType is handed, so a site in it reads
# names the fold never saw; and a module's __all__ is what a star import of it binds (one appended to binds a name
# STAR_EXPORTS does not list).
CODE_ATTRS = frozenset(("__code__", "gi_code", "cr_code", "ag_code"))
STAR_ATTRS = frozenset(("__all__",))
BACKDOOR_ATTRS = BACKDOOR_ATTRS | EVAL_ATTRS | FRAME_ATTRS | REACH_ATTRS | CODE_ATTRS | STAR_ATTRS
# The same names as strings (getattr and the like reach them by a literal), the namespace and code ones.
BACKDOOR_STRINGS = frozenset((
    "builtins", "__builtins__", "setattr", "delattr", "__dict__", "__setattr__", "__delattr__", "__globals__",
    "__code__", "__defaults__", "__kwdefaults__", "f_globals", "f_locals", "f_builtins",
)) | EVAL_ATTRS | FRAME_ATTRS | REACH_ATTRS
# getattr, operator.attrgetter and operator.methodcaller look an attribute up by a name in a str: one that is not a
# literal can name any of the above (an object's own receiver included: a method can be called with any first argument),
# so a call whose name is computed trips, and so does one of them handed around.
DYNAMIC_ACCESS = frozenset(("getattr", "attrgetter", "methodcaller", "getattr_static"))
# The modules the decoders lean on besides the decoder modules themselves: what base64 and gzip (written in
# Python) call at run time, the C modules bz2 and lzma take their decompressors from when they are first
# imported, and the codec registry's package. A store through one of them changes what a decoder returns.
DECODER_DEPENDENCIES = ("struct", "_struct", "io", "_io", "re", "_sre", "_bz2", "_lzma", "_compression", "_codecs", "encodings")
# The codec registry decides which codec a name reaches, so changing it changes what codecs.decode decodes.
REGISTRY_MODULES = ("codecs", "_codecs")
REGISTRY_ROUTES = frozenset(("register", "unregister", "register_error"))
# Storing to an attribute or a string key named like these patches what a fold calls.
PATCHED_KEYS = frozenset(
    [fn for fns in DECODERS.values() for fn in fns] + list(DECODERS) + list(GUARDED_NAMES)
    + ["fromhex", "builtins", "__builtins__", "__code__", "__defaults__", "__kwdefaults__", "__class__"]
)
# An import loads the standard library (the image's own list of it) and nothing else, and of that none of
# these, which load or patch code another way: the import machinery and loaders by path, native calls,
# serialisers that rebuild code and callables, runners of source text given as data, the site hooks, and the
# module of the file the entry starts at (a name stored through it lands in that file's namespace).
STDLIB = sys.stdlib_module_names
LOADER_MODULES = frozenset(("importlib", "runpy", "zipimport", "pkgutil", "pydoc", "imp", "ctypes", "_ctypes", "builtins", "__builtin__", "marshal", "pickle", "_pickle", "shelve", "code", "codeop", "timeit", "doctest", "pdb", "bdb", "trace", "cProfile", "profile", "site", "__main__", "_frozen_importlib", "_frozen_importlib_external", "_imp", "_pyrepl", "idlelib", "_interpreters", "_interpqueues", "_interpchannels", "inspect"))
# The same modules reached as an attribute of an allowed one, imported from one by name, or looked up by a literal name:
# rlcompleter.__main__ is the module of the file the entry starts at (a store through it rebinds that file's names), and
# logging.handlers and inspect hand out a deserialiser and the import machinery. code, site, trace and profile are left
# out: they name common attributes (an HTTPError's code), and only modules refused above, or reached through __main__,
# hand them out.
LOADER_ATTRS = LOADER_MODULES - frozenset(("code", "site", "trace", "profile"))
# The attribute names under which a standard-library object hands out a held or loading module by another name (the
# image's list: enum.bltns is builtins, string._re is re, pprint._sys is sys, sre_compile._ is re._compiler), and
# unittest's TestProgram.module, the module of the file the entry starts at. Flagged as LOADER_ATTRS are.
MODULE_ATTRS = frozenset(("bltns", "_re", "_sys", "_", "module"))
# Submodules of an allowed package that eval a str (logging.config's handler args, the generated methods of
# multiprocessing's proxies and shared-memory properties) or patch an object by name (unittest.mock), and the codec
# package, whose alias table, cache and codec modules decide what a codec name decodes with.
REFUSED_SUBMODULES = ("logging.config", "multiprocessing.managers", "multiprocessing.sharedctypes", "unittest.mock", "encodings")
# The modules whose objects must not travel. A name an import of one binds may stand only as the object of an attribute
# read (zlib.decompress): a store through any other name for the same module (m = base64; m._bytes_from_decode_data = f,
# or the module handed to a function or held in a container) changes what the decoders call, and so does sys.path what
# an import loads. The decoder modules, what they lean on (DECODER_DEPENDENCIES), the codec registry and sys.
HELD_MODULES = frozenset(list(DECODERS) + list(DECODER_DEPENDENCIES) + list(REGISTRY_MODULES) + ["sys"])
# The modules a star import may name, each with the names it binds: the image's own __all__ of the module (the Docker test
# holds the list to it), every one a class or a function. A star import of any other module binds names nobody listed (a
# module without __all__ hands out the modules it imported, a held or a loading one among them), so it is flagged.
STAR_EXPORTS = {
    "urllib.request": frozenset((
        "Request", "OpenerDirector", "BaseHandler", "HTTPDefaultErrorHandler", "HTTPRedirectHandler", "HTTPCookieProcessor",
        "ProxyHandler", "HTTPPasswordMgr", "HTTPPasswordMgrWithDefaultRealm", "HTTPPasswordMgrWithPriorAuth",
        "AbstractBasicAuthHandler", "HTTPBasicAuthHandler", "ProxyBasicAuthHandler", "AbstractDigestAuthHandler",
        "HTTPDigestAuthHandler", "ProxyDigestAuthHandler", "HTTPHandler", "FileHandler", "FTPHandler", "CacheFTPHandler",
        "DataHandler", "UnknownHandler", "HTTPErrorProcessor", "urlopen", "install_opener", "build_opener", "pathname2url",
        "url2pathname", "getproxies", "urlretrieve", "urlcleanup", "URLopener", "FancyURLopener", "HTTPSHandler",
    )),
}

# codecs.decode's codecs a fold may name, under the aliases the codec registry answers to.
CODEC_ALIASES = {
    "hex": "hex", "hex_codec": "hex",
    "base64": "base64", "base_64": "base64", "base64_codec": "base64",
    "zlib": "zlib", "zip": "zlib", "zlib_codec": "zlib",
    "bz2": "bz2", "bz2_codec": "bz2",
}
# liblzma's dictionary size per preset level (lzma_lzma_preset), for a raw filter that names no dict_size.
PRESET_LEVEL_MASK = 0x1F  # LZMA_PRESET_LEVEL_MASK (the lzma module does not export it)
PRESET_DICT = (1 << 18, 1 << 20, 1 << 21, 1 << 22, 1 << 22, 1 << 23, 1 << 23, 1 << 24, 1 << 25, 1 << 26)

SCOPES = (
    ast.Module, ast.Expression, ast.Interactive, ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda,
    ast.ClassDef, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp,
)
TYPE_PARAMS = tuple(getattr(ast, n) for n in ("TypeVar", "ParamSpec", "TypeVarTuple") if hasattr(ast, n))


class NotLiteral(Exception):
    pass


class OverCap(Exception):
    pass


class DecodeFailed(Exception):
    pass


class NotText(Exception):
    pass


class TreeRebound(Exception):
    pass


class ParseFailed(Exception):
    def __init__(self, line):
        super().__init__(line)
        self.line = line


CONTROL = (NotLiteral, OverCap, DecodeFailed, NotText, TreeRebound)

# The reasons a site is left unfolded while the code it runs is unseen: it may patch a decoder before
# another site runs.
UNSEEN = frozenset(("not_literal", "over_cap", "too_deep"))


def on_alarm(signum, frame):
    os._exit(EXIT_TIMEOUT)


def guarded(fn, *args, **kwargs):
    # A stdlib call the entry's own call would make: what it raises, the entry's call raises too.
    try:
        return fn(*args, **kwargs)
    except CONTROL:
        raise
    except MemoryError:
        raise OverCap()
    except RecursionError:
        raise NotLiteral()
    except Exception:
        raise DecodeFailed()


def capped(value):
    if isinstance(value, (str, bytes, bytearray)) and len(value) > MAX_LAYER_BYTES:
        raise OverCap()
    return value


def replace_capped(recv, args, kwargs):
    # str.replace / bytes.replace, the result's length worked out first and held to MAX_LAYER_BYTES before it is built
    # (an empty old matches len + 1 times). Arguments of another shape go to the call, which raises on them.
    old = args[0] if len(args) > 0 else None
    new = args[1] if len(args) > 1 else None
    count = args[2] if len(args) > 2 else kwargs.get("count", -1)
    if type(old) is type(recv) and type(new) is type(recv) and isinstance(count, int):
        n = recv.count(old)
        if count >= 0:
            n = min(n, count)
        if len(recv) + n * (len(new) - len(old)) > MAX_LAYER_BYTES:
            raise OverCap()
    return recv.replace(*args, **kwargs)


# ---------------------------------------------------------------- bounded decoders


def drain(dec, data, room):
    # A bz2 / lzma decompressor fed data, its output cut at room bytes (one more is over_cap).
    parts = []
    n = 0
    chunk = dec.decompress(data, room + 1)
    while True:
        parts.append(chunk)
        n += len(chunk)
        if n > room:
            raise OverCap()
        if dec.eof or dec.needs_input:
            break
        chunk = dec.decompress(b"", room + 1 - n)
        if not chunk and not dec.eof and not dec.needs_input:
            break
    return b"".join(parts), n


def zdrain(dec, data, room):
    # A zlib decompressobj fed data, its output cut at room bytes (one more is over_cap).
    parts = []
    n = 0
    buf = data
    while True:
        chunk = dec.decompress(buf, room + 1 - n)
        parts.append(chunk)
        n += len(chunk)
        if n > room:
            raise OverCap()
        buf = dec.unconsumed_tail
        if dec.eof or not buf:
            break
    return b"".join(parts), n


def zlib_decompress(data, /, wbits=zlib.MAX_WBITS, bufsize=zlib.DEF_BUF_SIZE):
    # zlib.decompress: one stream; what follows its end is ignored; a stream that does not end raises.
    if bufsize < 0:
        raise ValueError("bufsize must be non-negative")
    dec = zlib.decompressobj(wbits)
    out, _ = zdrain(dec, data, MAX_LAYER_BYTES)
    if not dec.eof:
        raise zlib.error("incomplete or truncated stream")
    return out


def gzip_decompress(data):
    # gzip.decompress: every member, the zero padding between them skipped, each CRC and length checked.
    members = []
    total = 0
    while True:
        fp = io.BytesIO(data)
        if gzip._read_gzip_header(fp) is None:
            return b"".join(members)
        dec = zlib.decompressobj(wbits=-zlib.MAX_WBITS)
        out, n = zdrain(dec, data[fp.tell():], MAX_LAYER_BYTES - total)
        if not dec.eof or len(dec.unused_data) < 8:
            raise EOFError("compressed file ended before the end-of-stream marker was reached")
        crc, length = struct.unpack("<II", dec.unused_data[:8])
        if crc != zlib.crc32(out):
            raise gzip.BadGzipFile("CRC check failed")
        if length != (len(out) & 0xFFFFFFFF):
            raise gzip.BadGzipFile("incorrect length of data produced")
        members.append(out)
        total += n
        data = dec.unused_data[8:].lstrip(b"\x00")


def bz2_decompress(data):
    # bz2.decompress: every stream; data after the last that is not a stream is ignored.
    results = []
    total = 0
    while data:
        dec = bz2.BZ2Decompressor()
        try:
            out, n = drain(dec, data, MAX_LAYER_BYTES - total)
        except OSError:
            if results:
                break
            raise
        results.append(out)
        total += n
        if not dec.eof:
            raise ValueError("compressed data ended before the end-of-stream marker was reached")
        data = dec.unused_data
    return b"".join(results)


def raw_filters_fit(filters):
    # A raw LZMA1 / LZMA2 filter's dictionary, as liblzma would size it, must fit DECODER_MEM_BYTES.
    if not isinstance(filters, (list, tuple)):
        return
    for spec in filters:
        if not isinstance(spec, dict) or spec.get("id") not in (lzma.FILTER_LZMA1, lzma.FILTER_LZMA2):
            continue
        size = spec.get("dict_size")
        if size is None:
            preset = spec.get("preset", lzma.PRESET_DEFAULT)
            if isinstance(preset, int) and 0 <= (preset & PRESET_LEVEL_MASK) < len(PRESET_DICT):
                size = PRESET_DICT[preset & PRESET_LEVEL_MASK]
        if isinstance(size, int) and size > DECODER_MEM_BYTES:
            raise OverCap()


def is_memlimit(err):
    return str(err) == "Memory usage limit exceeded"


def lzma_decompress(data, format=lzma.FORMAT_AUTO, memlimit=None, filters=None):
    # lzma.decompress: every stream; data after the last that is not a stream is ignored. The decoder's
    # memory is held to DECODER_MEMLIMIT (raw: its filters' dictionary to DECODER_MEM_BYTES).
    if memlimit is not None:
        raise NotLiteral()
    if format == lzma.FORMAT_RAW:
        raw_filters_fit(filters)
        limit = None
    else:
        limit = DECODER_MEMLIMIT
    results = []
    total = 0
    while True:
        dec = lzma.LZMADecompressor(format, limit, filters)
        try:
            out, n = drain(dec, data, MAX_LAYER_BYTES - total)
        except lzma.LZMAError as err:
            if is_memlimit(err):
                raise OverCap()
            if results:
                break
            raise
        results.append(out)
        total += n
        if not dec.eof:
            raise lzma.LZMAError("compressed data ended before the end-of-stream marker was reached")
        data = dec.unused_data
        if not data:
            break
    return b"".join(results)


def codecs_decode(obj, encoding="utf-8", errors="strict"):
    # codecs.decode with a bytes-to-bytes codec named by a literal: the codec's own decode.
    if not isinstance(encoding, str):
        raise NotLiteral()
    codec = CODEC_ALIASES.get(encodings.normalize_encoding(encoding.lower()))
    if codec is None:
        raise NotLiteral()
    if errors != "strict":
        raise DecodeFailed()
    if codec == "hex":
        return binascii.a2b_hex(obj)
    if codec == "base64":
        return base64.decodebytes(obj)
    if codec == "zlib":
        return zlib_decompress(obj)
    return bz2_decompress(obj)


def decoder_impl(module, fn):
    if module == "codecs":
        return codecs_decode
    if module == "zlib":
        return zlib_decompress
    if module == "gzip":
        return gzip_decompress
    if module == "bz2":
        return bz2_decompress
    if module == "lzma":
        return lzma_decompress
    return getattr(MODULES[module], fn)


# ---------------------------------------------------------------- one module's facts


def import_call_module(node):
    # A call of the builtin importer with one str literal: the module it names, else None.
    if (
        type(node) is ast.Call
        and type(node.func) is ast.Name
        and node.func.id == IMPORTER
        and len(node.args) == 1
        and not node.keywords
        and type(node.args[0]) is ast.Constant
        and isinstance(node.args[0].value, str)
    ):
        return node.args[0].value
    return None


def execs(mod, call):
    # Whether the site whose call is call runs its layer as the site runs: an exec, or a compile handed straight to one,
    # kept in a name that one exec runs, or returned by a def whose one call one exec runs (Module.runner_of; a compile's
    # code kept any other way can run any number of times).
    runner = mod.runner_of(call)
    return runner is not None and runner.func.id == "exec"


# The scopes whose parameters a fold reads from the call that applies them: a lambda, or a def (Fold.def_of and
# Fold.once_called say which defs; an async def never).
FRAMED = (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef)


def plain_def(node):
    # A def the fold may apply: a plain synchronous def, no decorator (one could hand back any callable) and no type
    # parameter, its parameters positional with no default, and no yield or await anywhere in it (a generator's body
    # does not run at the call).
    if type(node) is not ast.FunctionDef or node.decorator_list or getattr(node, "type_params", None):
        return False
    a = node.args
    if a.vararg is not None or a.kwarg is not None or a.kwonlyargs or a.defaults:
        return False
    return not any(type(x) in (ast.Yield, ast.YieldFrom, ast.Await) for x in ast.walk(node))


def returned(fn):
    # The expression a def's body is: one return statement with a value, a docstring before it allowed. Else None.
    body = fn.body
    if body and type(body[0]) is ast.Expr and type(body[0].value) is ast.Constant and isinstance(body[0].value.value, str):
        body = body[1:]
    if len(body) != 1 or type(body[0]) is not ast.Return or body[0].value is None:
        return None
    return body[0].value


def is_decoder_sig(sig):
    return sig[0] in ("mod", "fn") and sig[1] in DECODERS


def private(name):
    # A module's private name (_cache, _b85dec), not a dunder.
    return name.startswith("_") and not (name.startswith("__") and name.endswith("__"))


def dunder(name):
    # A name the compiler, the import system or a class body binds by itself (__doc__ from a docstring, a layer's included,
    # __name__, __file__, a class body's __module__ and __qualname__), with a value no binding the fold reads gave it: the
    # fold never reads one.
    return len(name) > 4 and name.startswith("__") and name.endswith("__")


# The builtin whose value entry code sets (sys.displayhook stores what it shows in builtins._): read before its binding in
# the text has run (that binding in a branch, a loop, a handler or another scope, or after the read), it is that value.
# The fold reads it only where its binding has run (Module.precedes). Every other builtin, and NameError, is a value no
# entry chooses.
FALLBACK_NAMES = frozenset(("_",))


def import_allowed(module):
    # An import of the standard library, bar the modules that load or patch code another way.
    top = module.split(".")[0]
    if top not in STDLIB or top in LOADER_MODULES:
        return False
    return not any(module == m or module.startswith(m + ".") for m in REFUSED_SUBMODULES)


def plain_import(module):
    # A module the inline importer may name besides a decoder one: what an import statement may name, no part of it a
    # back door, and none whose object must not travel (the importer hands its module out as a value).
    if not isinstance(module, str) or not import_allowed(module):
        return False
    parts = module.split(".")
    return parts[0] not in HELD_MODULES and not any(part in BACKDOOR_ATTRS for part in parts)


class Site:
    __slots__ = ("call", "arg", "mode")

    def __init__(self, call, arg, mode):
        self.call = call
        self.arg = arg
        self.mode = mode


class Module:
    # One parsed text (a file or a layer): every binding by name, every scope, every site, and whether
    # it trips the soundness rule.

    def __init__(self, tree):
        self.scope = {}
        self.parents = {}
        self.bindings = {}
        # Each binding of a GUARDED_NAMES name: (name, scope, the node that binds it).
        self.guarded_binds = []
        # The ids of the statements of every def's and class's body (Module.class_attribute, Module.classes_seen).
        self.in_body = set()
        self.sites = []
        self.paths = []
        self.flagged = False
        self.memo = {}
        self.busy = set()
        self.chains = {}
        self.lambda_params = {}
        # The names a global or nonlocal statement declares, and those a walrus binds (in a comprehension, the scope
        # around it): a binding of one of them may leave the scope it is written in.
        self.declared = set()
        self.walrus = set()
        # What check() holds against HELD_MODULES: every name read, every attribute read, every call of the importer.
        self.name_loads = []
        self.attr_loads = []
        self.import_calls = []
        # The objects a private name is read from (an attribute or a literal getattr): held to the rule when one is a
        # held module.
        self.private_reads = []
        # Each compile site's runner by the site call's id (runner_of), and those whose code a name holds: (name, scope).
        self.runners = {}
        self.kept = {}
        self.loaded = None
        stores = []
        stack = [(tree, None, None)]
        while stack:
            node, parent, scope = stack.pop()
            self.parents[id(node)] = parent
            self.scope[id(node)] = scope
            self.visit(node, parent, scope, stores)
            inner = node if isinstance(node, SCOPES) else scope
            for child in ast.iter_child_nodes(node):
                stack.append((child, node, inner))
        self.keep_compiled()
        self.sites.sort(key=lambda s: (s.call.lineno, s.call.col_offset))
        self.check(stores)
        for site in self.sites:
            if not self.plain_namespaces(site.call):
                site.arg = None

    def bind(self, name, sig, scope, stmt=None, at=None):
        # at is the node that binds (Module.check places a guarded name's binding by it).
        self.bindings.setdefault(name, []).append((sig, scope, stmt))
        if name in GUARDED_NAMES:
            self.guarded_binds.append((name, scope, at))

    def named(self, name, names=BACKDOOR_NAMES):
        if name in names:
            self.flagged = True

    def visit(self, node, parent, scope, stores):
        t = type(node)
        if t is ast.Name:
            if not self.namespace_call(node, parent):
                self.named(node.id)
            if type(parent) is ast.NamedExpr and parent.target is node:
                self.walrus.add(node.id)
            if type(node.ctx) is ast.Load:
                self.name_loads.append((node, parent))
            if node.id in GUARDED_NAMES and type(node.ctx) is ast.Load and not self.callee(node, parent):
                # exec, eval, compile or __import__ handed around as a value runs text the fold never reads.
                self.flagged = True
            if node.id in DYNAMIC_ACCESS and type(node.ctx) is ast.Load and not (type(parent) is ast.Call and parent.func is node):
                # getattr handed around is a lookup by a name nobody reads.
                self.flagged = True
            if type(node.ctx) is not ast.Load:
                sig, stmt = self.store_sig(node, parent)
                self.bind(node.id, sig, scope, stmt, node)
        elif t is ast.Attribute:
            self.named(node.attr, BACKDOOR_ATTRS)
            if node.attr == "path" or node.attr in REGISTRY_ROUTES:
                self.paths.append(node)
            if type(node.ctx) is not ast.Load:
                stores.append(node)
            else:
                self.attr_loads.append(node)
                if node.attr in DYNAMIC_ACCESS and not (type(parent) is ast.Call and parent.func is node):
                    self.flagged = True
            if private(node.attr):
                self.private_reads.append(node.value)
        elif t is ast.Subscript:
            if type(node.ctx) is not ast.Load:
                stores.append(node)
        elif t is ast.arg:
            self.named(node.arg)
            self.bind(node.arg, ("param", id(node)), scope, None, node)
        elif t in (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef):
            self.named(node.name)
            self.in_body.update(id(s) for s in node.body)
            # The statement is the def itself (Fold.def_of applies it, Module.precedes places it).
            self.bind(node.name, ("def", id(node)), scope, node, node)
        elif t is ast.Import:
            for alias in node.names:
                if not import_allowed(alias.name):
                    self.flagged = True
                for part in alias.name.split("."):
                    self.named(part, BACKDOOR_ATTRS)
                if alias.asname is not None:
                    self.named(alias.asname, BACKDOOR_ATTRS)
                    name = alias.asname
                    sig = ("mod", alias.name) if alias.name in DECODERS else ("import", alias.name)
                else:
                    name = alias.name.split(".")[0]
                    sig = ("mod", alias.name) if alias.name in DECODERS else ("import", name)
                self.bind(name, sig, scope, node, node)
        elif t is ast.ImportFrom:
            if node.level > 0 or not import_allowed(node.module or ""):
                self.flagged = True
            for part in (node.module or "").split("."):
                self.named(part, BACKDOOR_ATTRS)
            for alias in node.names:
                if alias.name == "*":
                    exports = STAR_EXPORTS.get(node.module) if node.level == 0 else None
                    if exports is None:
                        self.flagged = True
                        continue
                    for name in sorted(exports):
                        if not import_allowed(node.module + "." + name):
                            self.flagged = True
                        self.named(name, BACKDOOR_ATTRS)
                        self.bind(name, ("from", node.module, 0, name), scope, node, node)
                    continue
                if node.level == 0 and not import_allowed((node.module or "") + "." + alias.name):
                    self.flagged = True
                if alias.name in LOADER_ATTRS or alias.name in MODULE_ATTRS:
                    self.flagged = True
                if node.level == 0 and (node.module or "").split(".")[0] in HELD_MODULES and private(alias.name):
                    self.flagged = True
                if node.level == 0 and node.module == "sys" and alias.name == "path":
                    self.flagged = True
                if node.level == 0 and node.module in REGISTRY_MODULES and alias.name in REGISTRY_ROUTES:
                    self.flagged = True
                self.named(alias.name, BACKDOOR_ATTRS)
                name = alias.asname if alias.asname is not None else alias.name
                self.named(name, BACKDOOR_ATTRS)
                if node.level == 0 and node.module in DECODERS:
                    sig = ("fn", node.module, alias.name)
                else:
                    sig = ("from", node.module, node.level, alias.name)
                self.bind(name, sig, scope, node, node)
        elif t is ast.Global or t is ast.Nonlocal:
            self.declared.update(node.names)
        elif t is ast.ExceptHandler:
            if node.name is not None:
                self.named(node.name)
                self.bind(node.name, ("opaque", id(node)), scope, None, node)
        elif t is ast.MatchAs or t is ast.MatchStar:
            if node.name is not None:
                self.named(node.name)
                self.bind(node.name, ("opaque", id(node)), scope, None, node)
        elif t is ast.MatchMapping:
            if node.rest is not None:
                self.named(node.rest)
                self.bind(node.rest, ("opaque", id(node)), scope, None, node)
        elif TYPE_PARAMS and t in TYPE_PARAMS:
            self.named(node.name)
            self.bind(node.name, ("opaque", id(node)), scope, None, node)
        elif t is ast.Constant:
            if isinstance(node.value, str) and node.value in BACKDOOR_STRINGS:
                self.flagged = True
        elif t is ast.Call:
            self.site_of(node)
            self.dynamic_access(node)
            if import_call_module(node) is not None:
                self.import_calls.append((node, parent))

    def store_sig(self, node, parent):
        if type(node.ctx) is ast.Del:
            return ("del", id(node)), None
        if type(parent) is ast.Assign and any(target is node for target in parent.targets):
            module = import_call_module(parent.value)
            if module in DECODERS:
                return ("mod", module), parent
            return ("assign", id(parent)), parent
        if type(parent) is ast.AnnAssign and parent.target is node and parent.value is not None and parent.simple:
            module = import_call_module(parent.value)
            if module in DECODERS:
                return ("mod", module), parent
            return ("assign", id(parent)), parent
        if type(parent) is ast.AugAssign and parent.target is node and type(parent.op) is ast.Add:
            # N += E: one link of a module-level concatenation run (Fold.run_of decides whether it folds).
            return ("augadd", id(parent)), parent
        return ("store", id(node)), None

    def top_stmt(self, node):
        # The direct child of the module body that holds node, else None (node in an expression tree).
        parent = self.parents.get(id(node))
        while parent is not None:
            if type(parent) is ast.Module:
                return node
            node = parent
            parent = self.parents.get(id(node))
        return None

    def callee(self, name, parent):
        # Whether a guarded name is the callee of a call the fold reads: a site, or the importer applied to
        # one decoder module's name or to one an import statement may name and whose object may travel.
        if type(parent) is not ast.Call or parent.func is not name:
            return False
        if name.id != IMPORTER:
            return True
        module = import_call_module(parent)
        return module in DECODERS or plain_import(module)

    def plain_namespaces(self, call):
        # Whether the exec or eval that runs a site's text (the site, or the exec or eval a compile site is handed to)
        # runs it in plain dicts: each namespace omitted, None, globals() called bare, a dict display, or a name bound
        # once to one before it, and not a class body's own. A mapping of the entry's own class (or a dict subclass)
        # answers the layer's names itself, its own imports included, so its sites call what the fold never read.
        runner = self.runner_of(call)
        if runner is None:
            return True
        spaces = list(runner.args[1:]) + [k.value for k in runner.keywords]
        if any(k.arg not in ("globals", "locals") for k in runner.keywords):
            return False
        if type(self.scope.get(id(runner))) is ast.ClassDef and all(type(ns) is ast.Constant and ns.value is None for ns in spaces):
            # In a class body the namespace left out is the class's own, which a metaclass's __prepare__ makes any mapping.
            return False
        for ns in spaces:
            if type(ns) is ast.Dict or (type(ns) is ast.Constant and ns.value is None):
                continue
            if type(ns) is ast.Call and type(ns.func) is ast.Name and ns.func.id == "globals" and not ns.args and not ns.keywords:
                continue
            binds = self.bindings.get(ns.id) if type(ns) is ast.Name else None
            if binds and len(binds) == 1 and binds[0][0][0] == "assign" and type(binds[0][2].value) is ast.Dict and not dunder(ns.id):
                if self.reached(ns, binds):
                    continue
            return False
        return True

    def runner_of(self, call):
        # The exec or eval that runs a site's text: an exec or eval site itself; for a compile site, the exec or eval it
        # is handed straight to, the one that runs the name its code is kept in, or the exec handed the one call of the def
        # that returns it (keep_compiled). Else None.
        if call.func.id in SITE_RUNNERS:
            return call
        return self.runners.get(id(call))

    def keep_compiled(self):
        # Each compile site's runner. A compile's code bound to a name and run by one exec or eval call, as kept_runner
        # says, or returned by a def whose one call an exec runs, as def_runner says, is the same site as a compile handed
        # straight to that runner: the runner is no site of its own.
        dropped = set()
        for site in self.sites:
            call = site.call
            if call.func.id != SITE_BUILDER:
                continue
            parent = self.parents.get(id(call))
            if type(parent) is ast.Call and type(parent.func) is ast.Name and parent.func.id in SITE_RUNNERS and parent.args and parent.args[0] is call:
                self.runners[id(call)] = parent
                continue
            found = self.kept_runner(call)
            if found is None:
                found = self.def_runner(call)
            if found is not None:
                runner, name, scope = found
                self.runners[id(call)] = runner
                self.kept[id(call)] = (name, scope)
                dropped.add(id(runner))
        if dropped:
            self.sites = [s for s in self.sites if id(s.call) not in dropped]

    def kept_runner(self, call):
        # A compile call assigned alone to one name, which nothing else binds (no global, nonlocal or walrus names it,
        # no dunder), read exactly once in the text, as the first argument of an exec or eval call in the same scope that
        # the assignment has run before (Module.precedes): that call runs this code and nothing else does. The
        # (runner, name, scope), else None.
        stmt = self.parents.get(id(call))
        if type(stmt) is not ast.Assign or stmt.value is not call or len(stmt.targets) != 1 or type(stmt.targets[0]) is not ast.Name:
            return None
        name = stmt.targets[0].id
        binds = self.bindings.get(name)
        if dunder(name) or not binds or len(binds) != 1 or name in self.declared or name in self.walrus:
            return None
        sig, scope, _ = binds[0]
        if sig[0] != "assign":
            return None
        loads = [(node, parent) for node, parent in self.name_loads if node.id == name]
        if len(loads) != 1:
            return None
        node, runner = loads[0]
        if type(runner) is not ast.Call or type(runner.func) is not ast.Name or runner.func.id not in SITE_RUNNERS or not runner.args or runner.args[0] is not node:
            return None
        if self.scope.get(id(runner)) is not scope or not self.precedes(stmt, node):
            return None
        return runner, name, scope

    def def_runner(self, call):
        # A compile call returned by a decode helper: a plain def (plain_def) written directly in the module body, whose
        # body, a docstring aside, is assignments each of one name to one value (each name bound nowhere else in the text,
        # no dunder, no global, nonlocal or walrus naming it) and then this one return; the call's arguments the source, a
        # str literal and the literal mode 'exec', with no flag. The def's name is bound once (no dunder, no global, nonlocal
        # or walrus names it) and read exactly once in the text, as the callee of a call with no keyword or starred
        # argument, one positional argument per parameter, handed straight as the first argument to an exec call at module
        # scope that the def has run before (Module.precedes): that exec runs the code this compile returns, and nothing
        # else does (Fold.site_env holds the def's name against the other modules of the tree, and once_called reads its
        # parameters from that call). The (runner, name, scope), else None.
        ret = self.parents.get(id(call))
        if type(ret) is not ast.Return or ret.value is not call:
            return None
        if len(call.args) != 3 or call.keywords or any(type(x) is ast.Starred for x in call.args):
            return None
        filename, mode = call.args[1], call.args[2]
        if type(filename) is not ast.Constant or type(filename.value) is not str or type(mode) is not ast.Constant or mode.value != "exec":
            return None
        fn = self.parents.get(id(ret))
        if not plain_def(fn) or type(self.parents.get(id(fn))) is not ast.Module:
            return None
        body = fn.body
        if body and type(body[0]) is ast.Expr and type(body[0].value) is ast.Constant and isinstance(body[0].value.value, str):
            body = body[1:]
        if not body or body[-1] is not ret:
            return None
        for stmt in body[:-1]:
            if type(stmt) is not ast.Assign or len(stmt.targets) != 1 or type(stmt.targets[0]) is not ast.Name:
                return None
            local = stmt.targets[0].id
            binds = self.bindings.get(local)
            if dunder(local) or local in self.declared or local in self.walrus or not binds or len(binds) != 1 or binds[0][1] is not fn:
                return None
        name = fn.name
        binds = self.bindings.get(name)
        if dunder(name) or not binds or len(binds) != 1 or binds[0][2] is not fn or name in self.declared or name in self.walrus:
            return None
        if not all(self.only_param(x, fn) for x in self.params_of(fn)):
            return None
        loads = [(node, parent) for node, parent in self.name_loads if node.id == name]
        if len(loads) != 1:
            return None
        node, applied = loads[0]
        if type(applied) is not ast.Call or applied.func is not node or applied.keywords:
            return None
        if any(type(x) is ast.Starred for x in applied.args) or len(applied.args) != len(fn.args.posonlyargs + fn.args.args):
            return None
        runner = self.parents.get(id(applied))
        if type(runner) is not ast.Call or type(runner.func) is not ast.Name or runner.func.id != "exec" or not runner.args or runner.args[0] is not applied:
            return None
        if type(self.scope.get(id(runner))) is not ast.Module or not self.precedes(fn, node):
            return None
        return runner, name, self.scope.get(id(fn))

    def binds_in(self, name, scope):
        # Whether a binding of name is made in scope itself.
        return any(s is scope for _, s, _ in self.bindings.get(name, ()))

    def only_param(self, name, fn):
        # Whether name, a parameter of the lambda or def fn, is bound by nothing else in it: no other binding in its scope,
        # no walrus (one in a comprehension binds the scope around it) and no global or nonlocal statement names it.
        if name in self.declared or name in self.walrus:
            return False
        return sum(1 for _, s, _ in self.bindings.get(name, ()) if s is fn) == 1

    def loaded_names(self):
        # Every name the text reads.
        if self.loaded is None:
            self.loaded = frozenset(node.id for node, _ in self.name_loads)
        return self.loaded

    def namespace_call(self, name, parent):
        # Whether name is globals called bare as the namespace argument of an exec or eval call: the namespace an exec at
        # module scope runs in anyway, handed to nothing else.
        if name.id != "globals" or type(name.ctx) is not ast.Load:
            return False
        if type(parent) is not ast.Call or parent.func is not name or parent.args or parent.keywords:
            return False
        runner = self.parents.get(id(parent))
        if type(runner) is ast.keyword:
            runner = self.parents.get(id(runner))
        if type(runner) is not ast.Call or type(runner.func) is not ast.Name or runner.func.id not in SITE_RUNNERS:
            return False
        if any(type(x) is ast.Starred for x in runner.args) or any(k.arg is None for k in runner.keywords):
            return False
        return any(x is parent for x in runner.args[1:3]) or any(k.value is parent and k.arg in ("globals", "locals") for k in runner.keywords)

    def is_import_of(self, node, modules):
        # Whether node is a name that an import of one of modules binds, or an inline importer call of one.
        if import_call_module(node) in modules:
            return True
        if type(node) is not ast.Name:
            return False
        for sig, _, _ in self.bindings.get(node.id, ()):
            if sig[0] in ("mod", "import") and sig[1].split(".")[0] in modules:
                return True
        return False

    def is_sys(self, node):
        # Whether node is the sys module: the name sys, a name an import of it binds, or the attribute .sys.
        if type(node) is ast.Attribute:
            return node.attr == "sys"
        return type(node) is ast.Name and (node.id == "sys" or self.is_import_of(node, ("sys",)))

    def site_of(self, call):
        func = call.func
        if type(func) is not ast.Name or func.id not in GUARDED_NAMES or func.id == IMPORTER:
            return
        arg = None
        if call.args and type(call.args[0]) is not ast.Starred:
            arg = call.args[0]
        elif func.id == SITE_BUILDER and not call.args:
            arg = next((k.value for k in call.keywords if k.arg == "source"), None)
        if func.id == SITE_BUILDER:
            mode = "exec"
            mode_node = call.args[2] if len(call.args) > 2 else next((k.value for k in call.keywords if k.arg == "mode"), None)
            if type(mode_node) is ast.Constant and mode_node.value in ("exec", "eval", "single"):
                mode = mode_node.value
            if len(call.args) > 3 or any(k.arg not in ("source", "filename", "mode") for k in call.keywords):
                # Flags (a future's grammar, top-level await), dont_inherit or optimize: the text is not read as the
                # fold parses it, and one the fold cannot parse still runs.
                arg = None
        else:
            # An exec or eval of a compile call: the compile call is the site.
            if type(arg) is ast.Call and type(arg.func) is ast.Name and arg.func.id == SITE_BUILDER:
                return
            mode = "eval" if func.id == "eval" else "exec"
        self.sites.append(Site(call, arg, mode))

    def dynamic_access(self, call):
        # getattr(obj, name), attrgetter(name, ...) and methodcaller(name, ...) with a name that is not a literal str
        # (or a literal that is one of the names above) look up whatever they are told to.
        func = call.func
        fname = func.id if type(func) is ast.Name else func.attr if type(func) is ast.Attribute else None
        if fname not in DYNAMIC_ACCESS:
            return
        if any(type(x) is ast.Starred for x in call.args) or any(k.arg is None for k in call.keywords):
            self.flagged = True
            return
        names = call.args[1:2] if fname == "getattr" else call.args[:1] if fname == "methodcaller" else call.args
        if fname == "getattr" and len(call.args) < 2:
            self.flagged = True
        for arg in names:
            if type(arg) is not ast.Constant or not isinstance(arg.value, str):
                self.flagged = True
            elif any(part in BACKDOOR_ATTRS or part in BACKDOOR_STRINGS or part in HELD_MODULES or part in LOADER_ATTRS or part in MODULE_ATTRS for part in arg.value.split(".")):
                # A literal name of a held or loading module hands that module out as an attribute read would.
                self.flagged = True
            elif fname == "getattr" and private(arg.value):
                self.private_reads.append(call.args[0])

    def held_names(self):
        # The names an import of a held module binds.
        found = set()
        for name, binds in self.bindings.items():
            for sig, _, _ in binds:
                if sig[0] in ("mod", "import") and sig[1].split(".")[0] in HELD_MODULES:
                    found.add(name)
        return found

    def class_attribute(self, name, scope, at):
        # Whether a binding of name is a class attribute: made in a class body's own scope, by a node written in that body
        # (a class's bases, keywords and decorators are evaluated, and a walrus there binds, in the scope around it; its
        # type parameters bind in an annotation scope its methods see), and no global, nonlocal or walrus names it (a
        # global statement in a class body makes its stores the module's).
        if type(scope) is not ast.ClassDef or at is None or name in self.declared or name in self.walrus:
            return False
        child = at
        parent = self.parents.get(id(child))
        while parent is not None and parent is not scope:
            child = parent
            parent = self.parents.get(id(child))
        return parent is scope and id(child) in self.in_body

    def classes_seen(self, node):
        # The class bodies a bare name read at node may resolve in: each class around node up to the first def, lambda or
        # class whose body holds it (those bodies do not see class scope). A def's defaults, decorators and annotations, a
        # lambda's defaults, a comprehension (its first iterable is evaluated in the class body) and a nested class's
        # bases, keywords, decorators and type parameters all read the class around them (the nested class itself is
        # counted too, though only a type parameter's bound reads anything of it).
        found = []
        child = node
        parent = self.parents.get(id(child))
        while parent is not None:
            if type(parent) is ast.ClassDef:
                found.append(parent)
            if type(parent) in (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef) and id(child) in self.in_body:
                break
            if type(parent) is ast.Lambda and parent.body is child:
                break
            child = parent
            parent = self.parents.get(id(child))
        return found

    def check(self, stores):
        # A binding of exec, eval, compile or __import__ makes every site unsound to fold, but for a class attribute
        # (class_attribute): methods and nested scopes never read it, so it refuses only a read of the name that the class
        # body itself makes (classes_seen), the site's callee or the importer's included.
        attributes = set()
        for name, scope, at in self.guarded_binds:
            if self.class_attribute(name, scope, at):
                attributes.add((name, id(scope)))
            else:
                self.flagged = True
        if attributes:
            for node, _ in self.name_loads:
                if node.id in GUARDED_NAMES and any((node.id, id(c)) in attributes for c in self.classes_seen(node)):
                    self.flagged = True
        for node in self.paths:
            if node.attr == "path":
                if self.is_sys(node.value):
                    self.flagged = True
            elif self.is_import_of(node.value, REGISTRY_MODULES):
                self.flagged = True
        for binds in self.bindings.values():
            sigs = [b[0] for b in binds]
            if any(is_decoder_sig(s) for s in sigs) and any(s != sigs[0] for s in sigs):
                self.flagged = True
        for node in stores:
            if type(node) is ast.Attribute and node.attr in PATCHED_KEYS:
                self.flagged = True
            if type(node) is ast.Subscript and type(node.slice) is ast.Constant and isinstance(node.slice.value, str) and node.slice.value in PATCHED_KEYS:
                self.flagged = True
            root = node
            while True:
                if type(root) in (ast.Attribute, ast.Subscript):
                    if import_call_module(root.value) is not None:
                        self.flagged = True
                    root = root.value
                elif type(root) is ast.Call:
                    root = root.func
                else:
                    break
            if type(root) is ast.Name:
                if root.id == "bytes" or any(is_decoder_sig(b[0]) for b in self.bindings.get(root.id, ())) or self.is_import_of(root, DECODER_DEPENDENCIES):
                    self.flagged = True
        # A held module's name may stand only as the object of an attribute read; what such a read hands out must not
        # be a module again (gzip.zlib is zlib, as shutil.zlib and zipfile.struct are: any module that imports one has it
        # for an attribute).
        held = self.held_names()
        for node, parent in self.name_loads:
            if node.id in held and not (type(parent) is ast.Attribute and parent.value is node):
                self.flagged = True
        for node, parent in self.import_calls:
            if import_call_module(node).split(".")[0] not in HELD_MODULES or (type(parent) is ast.Attribute and parent.value is node):
                continue
            # Naming the module with the inline importer is the alias form the fold reads; any other use of the call hands the module on.
            if not (type(parent) in (ast.Assign, ast.AnnAssign) and parent.value is node and import_call_module(node) in DECODERS):
                self.flagged = True
        for node in self.attr_loads:
            if node.attr in HELD_MODULES or node.attr in LOADER_ATTRS or node.attr in MODULE_ATTRS:
                self.flagged = True
        # A held module's private state (base64's decode table, re's pattern cache) changes what a decoder returns when a
        # method call mutates it in place, which no store shows: a private name read from one is flagged.
        for node in self.private_reads:
            while type(node) is ast.Attribute:
                node = node.value
            module = import_call_module(node)
            if (module is not None and module.split(".")[0] in HELD_MODULES) or (type(node) is ast.Name and node.id in held):
                self.flagged = True

    def chain(self, node):
        # The scopes enclosing node, nearest first.
        key = id(node)
        found = self.chains.get(key)
        if found is None:
            found = []
            s = self.scope.get(key)
            while s is not None:
                found.append(s)
                s = self.scope.get(id(s))
            self.chains[key] = found
        return found

    def precedes(self, stmt, node):
        # Whether stmt has run each time node is evaluated: stmt is a statement of a block (a body, an else, a finally)
        # that also holds, further on, the statement node is part of. One in a branch, a loop's else, a handler or a
        # with whose exit may swallow it, or after node, may not have run when node is read.
        block = self.parents.get(id(stmt))
        child = node
        parent = self.parents.get(id(child))
        while parent is not None and parent is not block:
            child = parent
            parent = self.parents.get(id(child))
        if parent is None:
            return False
        for field in ("body", "orelse", "finalbody"):
            seq = getattr(block, field, None)
            if not isinstance(seq, list):
                continue
            i = next((k for k, s in enumerate(seq) if s is stmt), None)
            j = next((k for k, s in enumerate(seq) if s is child), None)
            if i is not None and j is not None:
                return i < j
        return False

    def reached(self, node, binds):
        # Whether one of binds (each an import or an assignment) has run, in a scope node reads, whenever node is read.
        chain = self.chain(node)
        for _, scope, stmt in binds:
            if stmt is None or not any(s is scope for s in chain):
                continue
            if type(scope) is ast.ClassDef and chain[0] is not scope:
                continue
            if self.precedes(stmt, node):
                return True
        return False

    def inner(self, name, scope):
        # Whether a binding of name in scope stays inside a def, lambda, class or comprehension: no global or
        # nonlocal statement names it and no walrus binds it, so it never reaches the module's globals.
        return isinstance(scope, SCOPES) and type(scope) not in (ast.Module, ast.Expression, ast.Interactive) and name not in self.declared and name not in self.walrus

    def params_of(self, lam):
        found = self.lambda_params.get(id(lam))
        if found is None:
            a = lam.args
            found = frozenset(p.arg for p in a.posonlyargs + a.args + a.kwonlyargs) | frozenset(
                p.arg for p in (a.vararg, a.kwarg) if p is not None
            )
            self.lambda_params[id(lam)] = found
        return found


def parse_module(src, mode):
    try:
        tree = ast.parse(src, mode=mode)
    except SyntaxError as err:
        raise ParseFailed(err.lineno if isinstance(err.lineno, int) and err.lineno > 0 else 0)
    except CONTROL:
        raise
    except Exception:
        raise ParseFailed(0)
    return Module(tree)


# ---------------------------------------------------------------- the fold


def merge_via(*vias):
    out = []
    for via in vias:
        for name in via:
            if name not in out:
                out.append(name)
    return tuple(out)


def merge_lits(*lits):
    out = {}
    for d in lits:
        out.update(d)
    return out


def plain_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


class Thunk:
    __slots__ = ("node", "env", "lam", "done", "value")

    def __init__(self, node, env, lam):
        self.node = node
        self.env = env
        self.lam = lam
        self.done = False
        self.value = None


class Fold:
    # One site's fold. A value is (python value, via names, {literal node id: size}).

    def __init__(self, mod, site, deps):
        self.mod = mod
        self.site = site
        self.pos = (site.call.lineno, site.call.col_offset)
        # Where a module-scope name is read when the site sits in a def one call runs (once_called): at that call.
        self.call_pos = None
        self.deps = deps
        # A def's locals folded in a frame (framed): (statement id, frame id) -> (frame, value).
        self.frames = {}

    def dep(self, kind, name, sig):
        # A name this site's fold read, for the tree's cross check.
        self.deps.append((self.mod, kind, name, sig, self.site.call))

    def site_env(self, call):
        # Frames for what applies the scopes around the site: the one call of the def with parameters the site sits in at
        # module scope (once_called), then the immediately applied lambdas, outermost first.
        env = {}
        lam = 0
        kept = self.mod.kept.get(id(call))
        if kept is not None and not self.mod.inner(kept[0], kept[1]):
            # The code is kept in a module-level name: another module of the tree reading it could run it again anywhere.
            self.dep("held", kept[0], None)
        chain = self.mod.chain(call)
        if len(chain) >= 2 and type(chain[-1]) is ast.Module and type(chain[-2]) is ast.FunctionDef and self.mod.params_of(chain[-2]):
            fn = chain[-2]
            applied = self.once_called(fn)
            frame = self.frame(fn, applied.args, applied.keywords, env, lam) if applied is not None else None
            if frame is not None:
                # Another module of the tree that reads or binds the def's name could run the site with other arguments.
                self.dep("held", fn.name, None)
                self.call_pos = (applied.lineno, applied.col_offset)
                env = {id(fn): frame}
                lam = 1
        lambdas = [s for s in chain if type(s) is ast.Lambda]
        for node in reversed(lambdas):
            applied = self.mod.parents.get(id(node))
            if lam >= MAX_LAMBDA or type(applied) is not ast.Call or applied.func is not node:
                continue
            frame = self.frame(node, applied.args, applied.keywords, env, lam)
            if frame is None:
                continue
            env = dict(env)
            env[id(node)] = frame
            lam += 1
        return env, lam

    def frame(self, lam_node, args, keywords, env, lam):
        a = lam_node.args
        if a.vararg is not None or a.kwarg is not None or a.kwonlyargs or a.defaults or keywords:
            return None
        params = [p.arg for p in a.posonlyargs + a.args]
        if len(params) != len(args) or any(type(x) is ast.Starred for x in args):
            return None
        return {p: Thunk(x, env, lam) for p, x in zip(params, args)}

    def once_called(self, fn):
        # The one call that runs a plain def (plain_def) at module scope: its name bound once (no dunder, no global,
        # nonlocal or walrus names it) and read exactly once in the text, as the callee of a call at module scope that the
        # def has run before (Module.precedes), with one positional argument per parameter; no parameter bound again in
        # the def (no assignment, del, for, with, import, handler, walrus, global or nonlocal of its name). The call, else
        # None. A site in it reads each parameter as that call's argument, evaluated where the call stands.
        mod = self.mod
        if not plain_def(fn) or dunder(fn.name) or fn.name in mod.declared or fn.name in mod.walrus:
            return None
        binds = mod.bindings.get(fn.name)
        if not binds or len(binds) != 1:
            return None
        loads = [node for node, _ in mod.name_loads if node.id == fn.name]
        if len(loads) != 1:
            return None
        func = loads[0]
        call = mod.parents.get(id(func))
        if type(call) is not ast.Call or call.func is not func or type(mod.scope.get(id(call))) is not ast.Module:
            return None
        if not mod.precedes(fn, func):
            return None
        a = fn.args
        if call.keywords or any(type(x) is ast.Starred for x in call.args) or len(call.args) != len(a.posonlyargs + a.args):
            return None
        if not all(mod.only_param(p, fn) for p in mod.params_of(fn)):
            return None
        return call

    def def_of(self, func):
        # The def a called name applies: its one binding, a plain def (plain_def) whose body is one return (returned), in
        # a scope the call sees, and run whenever the call is evaluated (Module.precedes: before it, a builtin of the same
        # name answers the call, input among them). Else None.
        mod = self.mod
        binds = mod.bindings.get(func.id)
        if not binds or len(binds) != 1 or dunder(func.id):
            return None
        sig, scope, fn = binds[0]
        if sig[0] != "def" or not plain_def(fn) or returned(fn) is None:
            return None
        chain = mod.chain(func)
        if not any(s is scope for s in chain) or (type(scope) is ast.ClassDef and chain[0] is not scope):
            return None
        if not mod.precedes(fn, func):
            return None
        return fn

    def value(self, node, env, lam):
        t = type(node)
        if t is ast.Constant:
            v = node.value
            if isinstance(v, (str, bytes)):
                return capped(v), (), {id(node): len(v)}
            if v is None or isinstance(v, int):
                return v, (), {}
            raise NotLiteral()
        if t is ast.Name:
            return self.name(node, env, lam)
        if t is ast.Call:
            return self.call(node, env, lam)
        if t is ast.BinOp:
            return self.concat(node, env, lam)
        if t is ast.Subscript:
            return self.slice(node, env, lam)
        if t is ast.UnaryOp:
            if type(node.op) not in (ast.USub, ast.UAdd):
                raise NotLiteral()
            v, via, lits = self.value(node.operand, env, lam)
            if not plain_int(v):
                raise NotLiteral()
            return (-v if type(node.op) is ast.USub else v), via, lits
        if t is ast.Attribute:
            module = self.module_of(node.value)
            name = node.attr
            if module is None or module not in MODULES or name.startswith("_") or name != name.upper():
                raise NotLiteral()
            v = getattr(MODULES[module], name, None)
            if not plain_int(v):
                raise NotLiteral()
            return v, (), {}
        if t is ast.List or t is ast.Tuple:
            items = [self.value(x, env, lam) if type(x) is not ast.Starred else self.fail() for x in node.elts]
            seq = [x[0] for x in items]
            return (seq if t is ast.List else tuple(seq)), merge_via(*[x[1] for x in items]), merge_lits(*[x[2] for x in items])
        if t is ast.Dict:
            out = {}
            vias = []
            lits = []
            for k, x in zip(node.keys, node.values):
                if type(k) is not ast.Constant or not isinstance(k.value, str):
                    raise NotLiteral()
                v, via, lit = self.value(x, env, lam)
                out[k.value] = v
                vias.append(via)
                lits.append(lit)
            return out, merge_via(*vias), merge_lits(*lits)
        raise NotLiteral()

    def fail(self):
        raise NotLiteral()

    def concat(self, node, env, lam):
        if type(node.op) is not ast.Add:
            raise NotLiteral()
        a, va, la = self.value(node.left, env, lam)
        b, vb, lb = self.value(node.right, env, lam)
        if (isinstance(a, str) and isinstance(b, str)) or (isinstance(a, bytes) and isinstance(b, bytes)):
            if len(a) + len(b) > MAX_LAYER_BYTES:
                raise OverCap()
            return a + b, merge_via(va, vb), merge_lits(la, lb)
        if isinstance(a, (str, bytes)) or isinstance(b, (str, bytes)):
            raise DecodeFailed()
        raise NotLiteral()

    def slice(self, node, env, lam):
        s = node.slice
        if type(s) is not ast.Slice:
            raise NotLiteral()
        v, via, lits = self.value(node.value, env, lam)
        if not isinstance(v, (str, bytes)):
            raise NotLiteral()
        bounds = []
        for part in (s.lower, s.upper, s.step):
            if part is None:
                bounds.append(None)
                continue
            b, _, _ = self.value(part, env, lam)
            if b is not None and not isinstance(b, int):
                raise NotLiteral()
            bounds.append(b)
        return guarded(operator.getitem, v, slice(*bounds)), via, lits

    def name(self, node, env, lam):
        # Resolved as Python does, nearest scope first (a class body only for a read directly in it): a parameter of a
        # lambda or def is its frame's argument, while nothing else binds that name in that scope (an assignment, a
        # walrus, a nonlocal or global statement); a nearer scope that binds the name otherwise holds it as its own (a
        # local, a comprehension's variable), which unique_assign then reads (or refuses: the parameter is a second
        # binding), in the frame of the def it is local to when the fold has one (assigned).
        x = node.id
        chain = self.mod.chain(node)
        for s in chain:
            if type(s) in FRAMED and x in self.mod.params_of(s):
                frame = env.get(id(s))
                if frame is None or x not in frame or not self.mod.only_param(x, s):
                    raise NotLiteral()
                return self.force(frame[x])
            if self.mod.binds_in(x, s) and not (type(s) is ast.ClassDef and s is not chain[0]):
                break
        stmt = self.unique_assign(node)
        if stmt is not None:
            self.dep("name", x, None)
            return self.assigned(stmt, env, lam)
        run = self.run_of(node)
        if run is None:
            raise NotLiteral()
        self.dep("name", x, None)
        return self.run_value(run)

    def force(self, thunk):
        if not thunk.done:
            thunk.value = self.value(thunk.node, thunk.env, thunk.lam)
            thunk.done = True
        return thunk.value

    def unique_assign(self, node):
        # The one binding of node's name, when it is an assignment in a scope node sees, before the site (for _, one that
        # has run whenever node is read: FALLBACK_NAMES). No dunder: its value is the module's or the class body's own.
        if dunder(node.id):
            return None
        binds = self.mod.bindings.get(node.id)
        if not binds or len(binds) != 1:
            return None
        sig, scope, stmt = binds[0]
        if sig[0] != "assign" or stmt is None:
            return None
        chain = self.mod.chain(node)
        if not any(s is scope for s in chain):
            return None
        if type(scope) is ast.ClassDef and chain[0] is not scope:
            return None
        # A module-scope name is read as the code around it runs: at the site, or, for a site in a def one call runs
        # (once_called), at that call. A def's own local before the site in its body.
        limit = self.call_pos if self.call_pos is not None and type(scope) is ast.Module else self.pos
        if (stmt.end_lineno, stmt.end_col_offset) > limit:
            return None
        if node.id in FALLBACK_NAMES and not self.mod.precedes(stmt, node):
            return None
        return stmt

    def run_of(self, node):
        # node's name bound as one run N = E0; N += E1; ... N += Ek, in source order: every statement a
        # direct child of the module body (so each runs once, in order), no other binding of N anywhere,
        # and node read at module scope in a module-level statement after the last N +=. The run's
        # statements in source order, else None.
        binds = self.mod.bindings.get(node.id)
        if not binds or len(binds) < 2 or dunder(node.id):
            return None
        kinds = [b[0][0] for b in binds]
        if kinds.count("assign") != 1 or kinds.count("augadd") != len(binds) - 1:
            return None
        stmts = sorted((b[2] for b in binds), key=lambda s: (s.lineno, s.col_offset))
        if type(stmts[0]) not in (ast.Assign, ast.AnnAssign) or any(type(s) is not ast.AugAssign for s in stmts[1:]):
            return None
        if any(type(self.mod.parents.get(id(s))) is not ast.Module for s in stmts):
            return None
        if type(self.mod.scope.get(id(node))) is not ast.Module:
            return None
        top = self.mod.top_stmt(node)
        last = stmts[-1]
        if top is None or (top.lineno, top.col_offset) < (last.end_lineno, last.end_col_offset):
            return None
        return stmts

    def run_value(self, stmts):
        # E0 + E1 + ... + Ek, each Ei folded as an assignment's value, held to MAX_LAYER_BYTES.
        parts = [self.assigned(s) for s in stmts]
        acc = parts[0][0]
        total = len(acc) if isinstance(acc, (str, bytes)) else 0
        for v, _, _ in parts[1:]:
            if (isinstance(acc, str) and isinstance(v, str)) or (isinstance(acc, bytes) and isinstance(v, bytes)):
                total += len(v)
                if total > MAX_LAYER_BYTES:
                    raise OverCap()
                continue
            if isinstance(acc, (str, bytes)) or isinstance(v, (str, bytes)):
                raise DecodeFailed()
            raise NotLiteral()
        value = acc[:0].join(p[0] for p in parts)
        return value, merge_via(*[p[1] for p in parts]), merge_lits(*[p[2] for p in parts])

    def assigned(self, stmt, env=None, lam=0):
        # An assignment's value. One whose statement sits in a def the fold holds a frame for (the one call once_called
        # names) is folded in that frame, so it reads the def's parameters as that call's arguments, as the def's body
        # does when the call runs it (framed); any other is folded with no frame, once per module.
        scope = self.mod.scope.get(id(stmt))
        frame = env.get(id(scope)) if env and type(scope) in FRAMED else None
        if frame is not None:
            return self.framed(stmt, env, lam, frame)
        key = id(stmt)
        if key in self.mod.memo:
            found = self.mod.memo[key]
            if isinstance(found, Exception):
                raise type(found)()
            return found
        if key in self.mod.busy:
            raise NotLiteral()
        self.mod.busy.add(key)
        try:
            found = self.value(stmt.value, {}, 0)
        except (NotLiteral, DecodeFailed, OverCap) as err:
            self.mod.memo[key] = err
            raise
        finally:
            self.mod.busy.discard(key)
        self.mod.memo[key] = found
        return found

    def framed(self, stmt, env, lam, frame):
        # A def's local folded in the frame of the call that runs the def: memoised per statement and frame within this
        # site's fold (the memo holds the frame itself, so no other frame takes its id), never in the module's memo,
        # which holds values read with no frame.
        key = (id(stmt), id(frame))
        found = self.frames.get(key)
        if found is not None:
            return found[1]
        if id(stmt) in self.mod.busy:
            raise NotLiteral()
        self.mod.busy.add(id(stmt))
        try:
            value = self.value(stmt.value, env, lam)
        finally:
            self.mod.busy.discard(id(stmt))
        self.frames[key] = (frame, value)
        return value

    def module_of(self, node):
        # The decoder module node names: an alias every binding of which imports it, or an
        # inline call of the builtin importer.
        if type(node) is ast.Name:
            binds = self.mod.bindings.get(node.id)
            if not binds:
                return None
            sig = binds[0][0]
            if sig[0] != "mod" or sig[1] not in DECODERS or any(b[0] != sig for b in binds) or (node.id in FALLBACK_NAMES and not self.mod.reached(node, binds)):
                return None
            self.dep("alias", node.id, sig)
            return sig[1]
        module = import_call_module(node)
        if module in DECODERS:
            self.dep("builtin", IMPORTER, None)
            return module
        return None

    def arguments(self, call, env, lam):
        if any(type(x) is ast.Starred for x in call.args) or any(k.arg is None for k in call.keywords):
            raise NotLiteral()
        args = [self.value(x, env, lam) for x in call.args]
        kwargs = [(k.arg, self.value(k.value, env, lam)) for k in call.keywords]
        vias = [x[1] for x in args] + [x[1][1] for x in kwargs]
        lits = [x[2] for x in args] + [x[1][2] for x in kwargs]
        return [x[0] for x in args], {k: x[0] for k, x in kwargs}, vias, lits

    def call(self, node, env, lam):
        func = node.func
        t = type(func)
        if t is ast.Lambda:
            return self.apply(func, func.body, node, env, lam)
        if t is ast.Attribute:
            module = self.module_of(func.value)
            if module is not None:
                if func.attr not in DECODERS[module]:
                    raise NotLiteral()
                return self.decode(module, func.attr, node, env, lam)
            if type(func.value) is ast.Name and func.value.id == "bytes" and func.attr == "fromhex":
                if "bytes" in self.mod.bindings:
                    raise NotLiteral()
                self.dep("builtin", "bytes", None)
                args, kwargs, vias, lits = self.arguments(node, env, lam)
                out = guarded(bytes.fromhex, *args, **kwargs)
                return capped(out), merge_via(*vias, ("bytes.fromhex",)), merge_lits(*lits)
            if func.attr in ("decode", "encode"):
                recv, via, lit = self.value(func.value, env, lam)
                if not isinstance(recv, (str, bytes)):
                    raise NotLiteral()
                args, kwargs, vias, lits = self.arguments(node, env, lam)
                if not all(isinstance(x, str) for x in list(args) + list(kwargs.values())):
                    raise NotLiteral()
                out = guarded(getattr(recv, func.attr), *args, **kwargs) if hasattr(recv, func.attr) else self.decode_failed()
                # bytes_in counts the payload: the receiver, not the codec name.
                return capped(out), merge_via(via, *vias), lit
            if func.attr == "replace":
                # A method of the exact str or bytes the fold built: no entry code can patch it.
                recv, via, lit = self.value(func.value, env, lam)
                if not isinstance(recv, (str, bytes)):
                    raise NotLiteral()
                args, kwargs, vias, lits = self.arguments(node, env, lam)
                if not all(isinstance(x, (str, bytes, int)) for x in list(args) + list(kwargs.values())):
                    raise NotLiteral()
                out = guarded(replace_capped, recv, args, kwargs)
                # bytes_in counts the payload: the receiver, not what is replaced in it.
                return capped(out), merge_via(via, *vias), lit
            if func.attr == "join":
                return self.join(func, node, env, lam)
            raise NotLiteral()
        if t is ast.Name:
            for s in self.mod.chain(func):
                if type(s) in FRAMED and func.id in self.mod.params_of(s):
                    raise NotLiteral()
            if func.id == "bytes" and "bytes" not in self.mod.bindings:
                return self.as_bytes(node, env, lam)
            binds = self.mod.bindings.get(func.id)
            if binds:
                sig = binds[0][0]
                if sig[0] == "fn" and sig[1] in DECODERS and all(b[0] == sig for b in binds):
                    if sig[2] not in DECODERS[sig[1]] or (func.id in FALLBACK_NAMES and not self.mod.reached(func, binds)):
                        raise NotLiteral()
                    self.dep("alias", func.id, sig)
                    return self.decode(sig[1], sig[2], node, env, lam)
            stmt = self.unique_assign(func)
            if stmt is not None and type(stmt.value) is ast.Lambda:
                self.dep("name", func.id, None)
                return self.apply(stmt.value, stmt.value.body, node, env, lam)
            fn = self.def_of(func)
            if fn is not None:
                self.dep("name", func.id, None)
                return self.apply(fn, returned(fn), node, env, lam)
        raise NotLiteral()

    def decode_failed(self):
        raise DecodeFailed()

    def join(self, func, node, env, lam):
        # .join of the exact str or bytes the fold built (no entry code can patch its method): the separator over a list
        # or tuple of values of its own type, or the empty str over a str (its characters joined: the str itself). The
        # result's length is worked out and held to MAX_LAYER_BYTES before it is built.
        sep, via, _ = self.value(func.value, env, lam)
        if type(sep) not in (str, bytes):
            raise NotLiteral()
        args, kwargs, vias, lits = self.arguments(node, env, lam)
        if len(args) != 1 or kwargs:
            raise NotLiteral()
        items = args[0]
        # bytes_in counts the payload: what is joined, not the separator.
        if type(sep) is str and not sep and type(items) is str:
            return items, merge_via(via, *vias), merge_lits(*lits)
        if type(items) not in (list, tuple) or not all(type(x) is type(sep) for x in items):
            raise NotLiteral()
        if sum(len(x) for x in items) + len(sep) * max(len(items) - 1, 0) > MAX_LAYER_BYTES:
            raise OverCap()
        return capped(sep.join(items)), merge_via(via, *vias), merge_lits(*lits)

    def as_bytes(self, node, env, lam):
        # The builtin bytes (no binding of the name in the text; the tree's cross check holds the rest) of one bytes value
        # the fold built: a copy of it, so the value itself.
        self.dep("builtin", "bytes", None)
        args, kwargs, vias, lits = self.arguments(node, env, lam)
        if len(args) != 1 or kwargs or type(args[0]) is not bytes:
            raise NotLiteral()
        return args[0], merge_via(*vias), merge_lits(*lits)

    def apply(self, fn, body, call, env, lam):
        # A lambda or a def (def_of) applied at call: its parameters bound to the call's arguments, its body (body) folded.
        if lam >= MAX_LAMBDA:
            raise NotLiteral()
        frame = self.frame(fn, call.args, call.keywords, env, lam)
        if frame is None:
            raise NotLiteral()
        inner = dict(env)
        inner[id(fn)] = frame
        return self.value(body, inner, lam + 1)

    def decode(self, module, fn, call, env, lam):
        args, kwargs, vias, lits = self.arguments(call, env, lam)
        out = guarded(decoder_impl(module, fn), *args, **kwargs)
        if not isinstance(out, bytes):
            raise DecodeFailed()
        # bytes_in counts the payload: the data argument, not a codec name or an altchars literal.
        data_lits = lits[:1] if call.args else lits
        return capped(out), merge_via(*vias, (module + "." + fn,)), merge_lits(*data_lits)


# ---------------------------------------------------------------- a file's tree of layers


def to_text(value):
    # Folded bytes read as Python reads source; a str as it is. NUL, or no UTF-8 for it: not text.
    if isinstance(value, bytes):
        try:
            text = importlib.util.decode_source(value)
        except CONTROL:
            raise
        except Exception:
            raise NotText()
    else:
        text = value
    if "\x00" in text:
        raise NotText()
    try:
        data = text.encode("utf-8")
    except UnicodeError:
        raise NotText()
    return text, data


class Tree:
    # One file and the layers unpacked under it, numbered from 1 until the run commits them.

    def __init__(self, run):
        self.run = run
        self.layers = []
        self.failed = []
        self.modules = []
        self.deps = []
        # Each layer's module by id: the module and the site call it was unpacked from.
        self.origin = {}
        self.text_bytes = 0

    def fail(self, parent, line, why):
        self.failed.append((parent, line, why))

    def process(self, mod, depth, parent):
        self.modules.append(mod)
        for site in mod.sites:
            line = site.call.lineno
            if site.arg is None:
                self.fail(parent, line, "not_literal")
                continue
            if depth + 1 > MAX_DEPTH:
                self.fail(parent, line, "too_deep")
                continue
            try:
                fold = Fold(mod, site, self.deps)
                env, lam = fold.site_env(site.call)
                value, via, lits = fold.value(site.arg, env, lam)
                if not isinstance(value, (str, bytes)):
                    raise NotLiteral()
                text, data = to_text(value)
            except NotLiteral:
                self.fail(parent, line, "not_literal")
                continue
            except RecursionError:
                self.fail(parent, line, "not_literal")
                continue
            except DecodeFailed:
                self.fail(parent, line, "decode_failed")
                continue
            except (OverCap, MemoryError):
                self.fail(parent, line, "over_cap")
                continue
            except NotText:
                self.fail(parent, line, "not_text")
                continue
            if (
                len(data) > MAX_LAYER_BYTES
                or self.run.layers + len(self.layers) >= MAX_LAYERS
                or self.run.text_bytes + self.text_bytes + len(data) > MAX_TEXT_BYTES
            ):
                self.fail(parent, line, "over_cap")
                continue
            k = len(self.layers) + 1
            self.layers.append((k, parent, line, depth + 1, via, sum(lits.values()), data))
            self.text_bytes += len(data)
            source = text.lstrip(" \t") if site.mode == "eval" else text
            try:
                child = parse_module(source, site.mode)
            except ParseFailed as err:
                self.fail(k, err.line, "syntax_error")
                continue
            if child.flagged:
                raise TreeRebound()
            self.origin[id(child)] = (mod, site.call)
            self.process(child, depth + 1, k)

    def cross_check(self):
        # A name one module's fold read must not be bound by another module of the tree: exec shares
        # the module's globals, so a layer that binds it changes what the parent's later sites see. Two
        # bindings cannot: one kept inside a def, lambda, class or comprehension, and one in a layer of
        # the very site that read the name, when that site's call is evaluated once and before the layer exists.
        # A held name (the def a site's parameters came from, a module-level name a compile's code is kept in) is
        # neither read nor bound by another module at all: a read could run that site, or that code, again.
        for mod, kind, name, sig, call in self.deps:
            for other in self.modules:
                if kind == "held":
                    if other is not mod and (name in other.bindings or name in other.loaded_names()):
                        raise TreeRebound()
                    continue
                binds = other.bindings.get(name)
                if not binds:
                    continue
                if kind == "builtin":
                    raise TreeRebound()
                if other is mod:
                    continue
                if kind == "alias" and all(b[0] == sig for b in binds):
                    continue
                if all(other.inner(name, scope) for _, scope, _ in binds):
                    continue
                if self.under(other, call) and self.once_at(mod, call) and self.runs_once(mod):
                    continue
                raise TreeRebound()

    def under(self, mod, call):
        # Whether mod is a layer unpacked, at any depth, from the site whose call is call.
        while True:
            origin = self.origin.get(id(mod))
            if origin is None:
                return False
            if origin[1] is call:
                return True
            mod = origin[0]

    def once_at(self, mod, call):
        # Whether call is evaluated at most once each time mod's text runs: at module scope (in no def, class,
        # lambda or comprehension), inside a bare expression or assignment statement of the module body itself
        # (in no loop, branch, try or with: an expression evaluates each of its parts at most once).
        if type(mod.scope.get(id(call))) is not ast.Module:
            return False
        stmt = mod.parents.get(id(call))
        while stmt is not None and not isinstance(stmt, ast.stmt):
            stmt = mod.parents.get(id(stmt))
        return type(stmt) in (ast.Expr, ast.Assign) and type(mod.parents.get(id(stmt))) is ast.Module

    def runs_once(self, mod):
        # Whether mod's text runs at most once: the file itself, or a layer an exec runs (the site an exec,
        # or a compile handed straight to one or kept in a name one runs) from a site evaluated once, run by an exec
        # evaluated once, in a text that runs once. (A compile a def returns sits in the def, so it is never evaluated once
        # here: a layer of it binds no name the fold read.)
        while True:
            origin = self.origin.get(id(mod))
            if origin is None:
                return True
            parent, call = origin
            if not (execs(parent, call) and self.once_at(parent, call) and self.once_at(parent, parent.runner_of(call))):
                return False
            mod = parent

    def tainted(self):
        # Whether code the fold never saw may run: a site of the file or of one of its layers was left
        # unfolded, its payload not a literal, past a cap or too deep to read. (A payload that fails to
        # decode, to read as text or to parse runs nothing.)
        return any(why in UNSEEN for _, _, why in self.failed)


class Run:
    def __init__(self):
        self.layers = 0
        self.text_bytes = 0
        self.failed = 0
        self.texts = []
        self.files = []

    def commit(self, i, tree_layers, tree_failed):
        base = self.layers
        entry = {"i": i, "layers": [], "failed": []}
        for k, parent, line, depth, via, bytes_in, data in tree_layers:
            entry["layers"].append({
                "n": base + k,
                "parent": base + parent if parent else 0,
                "line": line,
                "depth": depth,
                "via": list(via),
                "bytes_in": bytes_in,
                "utf8_len": len(data),
            })
            self.texts.append(data)
            self.text_bytes += len(data)
        self.layers += len(tree_layers)
        more = 0
        for parent, line, why in tree_failed:
            if self.failed >= MAX_FAILED:
                more += 1
                continue
            entry["failed"].append({"parent": base + parent if parent else 0, "line": line, "why": why})
            self.failed += 1
        if more:
            entry["failed_more"] = more
        self.files.append(entry)


class Candidate:
    # One candidate file: its bytes (None when a cap kept them out), and what its fold found.
    __slots__ = ("i", "raw", "error", "sites", "layers", "failed")

    def __init__(self, i, raw):
        self.i = i
        self.raw = raw
        self.error = 0
        self.sites = None
        self.layers = []
        self.failed = []


class Reader:
    # The inputs read inside the caps, the candidates first and then the tree files: at most MAX_FILES,
    # each at most MAX_FILE_BYTES, MAX_INPUT_BYTES together. A file past a cap reads as None.

    def __init__(self):
        self.count = 0
        self.total = 0

    def read(self, path):
        self.count += 1
        if self.count > MAX_FILES:
            return None
        with open(path, "rb") as fh:
            raw = fh.read(MAX_FILE_BYTES + 1)
        self.total += len(raw)
        if len(raw) > MAX_FILE_BYTES or self.total > MAX_INPUT_BYTES:
            return None
        return raw


def index_of(digits):
    # The number digits spell (ASCII digits, no leading zero), else None.
    if digits.isascii() and digits.isdigit() and (digits == "0" or digits[0] != "0"):
        return int(digits)
    return None


def input_indexes():
    # The candidates /input/<i> and the tree files /input/t<j>.py, each as its numbers in order.
    try:
        names = os.listdir(INPUT_DIR)
    except OSError:
        return [], []
    files = []
    tree = []
    for name in names:
        if name.startswith(TREE_PREFIX) and name.endswith(TREE_SUFFIX):
            found = index_of(name[len(TREE_PREFIX):len(name) - len(TREE_SUFFIX)])
            if found is not None:
                tree.append(found)
        else:
            found = index_of(name)
            if found is not None:
                files.append(found)
    return sorted(files), sorted(tree)


def refused(c):
    # A candidate the tree refuses answers no layer. Each site of the file is listed as rebound, but one its
    # own fold failed on keeps its reason (a candidate alone is judged as before).
    why = {}
    for parent, line, reason in c.failed:
        if parent == 0:
            why.setdefault(line, reason)
    return [(0, line, why.get(line, "rebound")) for line in c.sites]


def tree_sound(raw):
    # A tree file passes when it parses, trips no rule and holds no site of its own: nothing would read
    # the payload of a site that is never folded.
    try:
        mod = parse_module(raw, "exec")
    except ParseFailed:
        return False
    return not mod.flagged and not mod.sites


def main():
    signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, SCRIPT_MS / 1000.0)
    files, tree = input_indexes()
    reader = Reader()
    cands = []
    whole = True
    for i in files:
        path = os.path.join(INPUT_DIR, str(i))
        if not os.path.isfile(path):
            continue
        raw = reader.read(path)
        if raw is None:
            whole = False
        cands.append(Candidate(i, raw))
    # The tree: every input read inside the caps and every Python text of it passing the rule, tree files
    # first (each parsed and dropped), then the candidates as they are folded.
    sound = True
    for j in tree:
        path = os.path.join(INPUT_DIR, TREE_PREFIX + str(j) + TREE_SUFFIX)
        raw = reader.read(path) if os.path.isfile(path) else None
        if raw is None:
            whole = False
        elif whole and sound and not tree_sound(raw):
            sound = False
    # Each candidate folded in order, the run's caps counted as if every one is kept; once the tree fails,
    # the rest are parsed (for the sites a refusal lists) and not folded.
    folding = Run()
    for c in cands:
        if c.raw is None or not whole:
            continue
        try:
            mod = parse_module(c.raw, "exec")
        except ParseFailed as err:
            c.error = err.line
            sound = False
            continue
        c.sites = [s.call.lineno for s in mod.sites]
        if mod.flagged:
            sound = False
        if not sound:
            continue
        folded = Tree(folding)
        try:
            folded.process(mod, 0, 0)
            folded.cross_check()
        except TreeRebound:
            sound = False
            continue
        c.layers = folded.layers
        c.failed = folded.failed
        if folded.tainted():
            sound = False
            continue
        folding.layers += len(folded.layers)
        folding.text_bytes += folded.text_bytes
    mod = folded = None
    run = Run()
    for c in cands:
        if c.raw is None or not whole:
            run.commit(c.i, [], [(0, 0, "over_cap")])
        elif c.sites is None:
            run.commit(c.i, [], [(0, c.error, "syntax_error")])
        elif not sound:
            run.commit(c.i, [], refused(c))
        else:
            run.commit(c.i, c.layers, c.failed)
    signal.setitimer(signal.ITIMER_REAL, 0)
    head = json.dumps(
        {"v": WIRE_VERSION, "python": platform.python_version(), "files": run.files},
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("ascii")
    if len(head) > HEAD_MAX_BYTES:
        sys.stderr.write("unpack: the head is over its cap\n")
        sys.stderr.flush()
        os._exit(EXIT_HEAD_TOO_LARGE)
    out = sys.stdout.buffer
    out.write(head + b"\n")
    for data in run.texts:
        out.write(data)
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
