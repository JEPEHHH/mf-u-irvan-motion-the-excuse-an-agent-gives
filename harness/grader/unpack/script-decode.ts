// The data decoder's Python program, held as a string the way ./script.ts holds the fold's: the driver (./run.ts
// decodeData) writes it to `<scratch>/code/decode.py` and runs it in the pinned python3.13 image
// (python3 -P -s /bot/decode.py) with the handed data files read-only at /input/<i>, no network, no env and the fold's
// CPU, memory, pids and output caps. The host never runs Python (.cosmos/rules/project-context.mdc), so the program is
// proven only in Docker (tests/unit/defender-decode-run.test.ts).
//
// What it does: for each /input/<i> it searches chains of standard-library decoders (protocol.ts DECODE_VIA, in that
// order at each step, at most DECODE_MAX_DEPTH long, at most DECODE_MAX_STEPS decodes a file) and keeps the first chain
// whose last output is text no strong decoder takes further (protocol.ts's header says what text is). It treats every
// byte as data: it never parses, imports, compiles or runs what it reads, and calls nothing that would. Each
// decompressor is the streaming one cut at DECODE_MAX_TEXT_BYTES of output, so a bomb is `over_cap` before it is built.
//
// Memory: the spawn's 256 MiB (run.ts UNPACK_LIMITS) holds the interpreter (~15 MiB), the inputs (at most
// DECODE_MAX_INPUT_BYTES, one file read at a time), the texts kept (at most DECODE_MAX_TOTAL_TEXT_BYTES), a chain's values
// (each at most DECODE_MAX_TEXT_BYTES, DECODE_MAX_DEPTH of them alive) and one decompressor at a time: an .xz / .lzma
// decoder held to memlimit UNPACK_DECODER_MEM_BYTES + UNPACK_DECODER_MEM_SLACK_BYTES (65 MiB: a 64 MiB dictionary,
// xz preset 9 as the house baseline's, decodes; protocol.ts says why the slack), the raw LZMA2 decoder's dictionary of
// UNPACK_DECODER_MEM_BYTES (allocated, touched only as far as the output reaches), bz2's few MiB. About 100 MiB at
// worst, inside the cap with room.

import {
  DECODE_MAX_DEPTH,
  DECODE_MAX_FILE_BYTES,
  DECODE_MAX_FILES,
  DECODE_MAX_INPUT_BYTES,
  DECODE_MAX_STEPS,
  DECODE_MAX_TEXT_BYTES,
  DECODE_MAX_TOTAL_TEXT_BYTES,
  DECODE_MIN_ASCII_BYTES,
  DECODE_TEXT_CONTROLS,
  DECODE_WIRE_VERSION,
  UNPACK_DECODER_MEM_BYTES,
  UNPACK_DECODER_MEM_SLACK_BYTES,
  UNPACK_EXIT_HEAD_TOO_LARGE,
  UNPACK_EXIT_TIMEOUT,
  UNPACK_HEAD_MAX_BYTES,
  UNPACK_SCRIPT_MS,
} from './protocol.ts';

/** The program's file name under the spawn's codeDir (/bot). */
export const DECODE_SCRIPT = 'decode.py';

/** The control bytes a text may hold, as a Python tuple literal. */
const TEXT_CONTROLS_PY = `(${DECODE_TEXT_CONTROLS.join(', ')})`;

/**
 * decode.py: stdlib only, the caps interpolated from protocol.ts. It never calls the builtins that run or build code
 * from text, and imports nothing that spawns, dials or deserialises objects.
 */
export const DECODE_PY_SOURCE = String.raw`# make.fun's data decoder (grader/unpack/script-decode.ts DECODE_PY_SOURCE), run as
# python3 -P -s /bot/decode.py in the pinned python3.13 image, the handed data files read-only at
# /input/<i>. It decodes bytes as data with standard-library decoders: it never parses, imports, compiles
# or runs what it reads. Stdlib only; the caps and the wire are grader/unpack/protocol.ts's.
import base64
import binascii
import bz2
import gzip
import io
import json
import lzma
import os
import platform
import signal
import struct
import sys
import zlib

WIRE_VERSION = ${DECODE_WIRE_VERSION}
MAX_FILES = ${DECODE_MAX_FILES}
MAX_FILE_BYTES = ${DECODE_MAX_FILE_BYTES}
MAX_INPUT_BYTES = ${DECODE_MAX_INPUT_BYTES}
MAX_TEXT_BYTES = ${DECODE_MAX_TEXT_BYTES}
MAX_TOTAL_TEXT_BYTES = ${DECODE_MAX_TOTAL_TEXT_BYTES}
MAX_DEPTH = ${DECODE_MAX_DEPTH}
MAX_STEPS = ${DECODE_MAX_STEPS}
MIN_ASCII_BYTES = ${DECODE_MIN_ASCII_BYTES}
DECODER_MEM_BYTES = ${UNPACK_DECODER_MEM_BYTES}
DECODER_MEMLIMIT = ${UNPACK_DECODER_MEM_BYTES + UNPACK_DECODER_MEM_SLACK_BYTES}
SCRIPT_MS = ${UNPACK_SCRIPT_MS}
EXIT_TIMEOUT = ${UNPACK_EXIT_TIMEOUT}
EXIT_HEAD_TOO_LARGE = ${UNPACK_EXIT_HEAD_TOO_LARGE}
HEAD_MAX_BYTES = ${UNPACK_HEAD_MAX_BYTES}
INPUT_DIR = "/input"

XZ_MAGIC = b"\xfd7zXZ\x00"
GZIP_MAGIC = b"\x1f\x8b"
BZ2_MAGIC = b"BZh"
URLSAFE_ALPHABET = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
TEXT_CONTROLS = ${TEXT_CONTROLS_PY}
CONTROL_BYTES = tuple(bytes((c,)) for c in list(range(32)) + [127] if c not in TEXT_CONTROLS)
# The first failure that holds names a file that decoded to no text (protocol.ts DECODE_FAILURES).
FAILURE_ORDER = ("over_cap", "too_deep", "not_text", "decode_failed")


class OverCap(Exception):
    pass


class Broken(Exception):
    # A stream its own magic or header names that does not decode: decode_failed.
    pass


class NotTaken(Exception):
    # The decoder does not take these bytes.
    pass


class SearchCap(Exception):
    pass


def on_alarm(signum, frame):
    os._exit(EXIT_TIMEOUT)


def is_text(data):
    # Strict UTF-8 holding no control character but tab, line feed, vertical tab, form feed and carriage return.
    try:
        data.decode("utf-8", "strict")
    except UnicodeDecodeError:
        return False
    for c in CONTROL_BYTES:
        if c in data:
            return False
    return True


# ---------------------------------------------------------------- bounded decompressors


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
    # A zlib decompressobj fed data, its output cut at room bytes (one more is over_cap), drained of what it holds.
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
        if dec.eof or (not buf and not chunk):
            break
    return b"".join(parts), n


def is_memlimit(err):
    return str(err) == "Memory usage limit exceeded"


def alone_plausible(data):
    # An .lzma header as an encoder writes one: a properties byte under 225, a dictionary of 2^n or 2^n + 2^(n-1)
    # bytes, and an uncompressed size unknown or under 256 GiB. Only such a header that needs more decoder memory
    # than DECODER_MEMLIMIT is over_cap; any other bytes the .lzma decoder refuses are no .lzma stream at all.
    if len(data) < 13 or data[0] >= 225:
        return False
    size = int.from_bytes(data[1:5], "little")
    if size < 4096:
        return False
    top = 1 << (size.bit_length() - 1)
    if size != top and size != top + (top >> 1):
        return False
    length = int.from_bytes(data[5:13], "little")
    return length == (1 << 64) - 1 or length < (1 << 38)


def lzma_streams(data, fmt):
    # lzma.decompress(data, fmt, memlimit): every stream; data after the last that is not a stream is ignored.
    results = []
    total = 0
    while True:
        dec = lzma.LZMADecompressor(fmt, DECODER_MEMLIMIT)
        try:
            out, n = drain(dec, data, MAX_TEXT_BYTES - total)
        except lzma.LZMAError as err:
            if is_memlimit(err) or not results:
                raise
            break
        results.append(out)
        total += n
        if not dec.eof:
            raise lzma.LZMAError("compressed data ended before the end-of-stream marker was reached")
        data = dec.unused_data
        if not data:
            break
    return b"".join(results)


def lzma_decode(data):
    # lzma.decompress: FORMAT_AUTO (.xz or .lzma), then FORMAT_ALONE, each held to DECODER_MEMLIMIT.
    signed = data.startswith(XZ_MAGIC)
    for fmt in (lzma.FORMAT_AUTO, lzma.FORMAT_ALONE):
        try:
            return lzma_streams(data, fmt)
        except lzma.LZMAError as err:
            if is_memlimit(err) and (signed or alone_plausible(data)):
                raise OverCap()
    if signed:
        raise Broken()
    raise NotTaken()


def lzma2_raw_decode(data):
    # lzma.decompress(data, FORMAT_RAW, filters=[{"id": FILTER_LZMA2, "dict_size": DECODER_MEM_BYTES}]): one raw
    # LZMA2 stream ending exactly at the last byte. Its first chunk must reset the dictionary (0x01, or an LZMA chunk
    # 0xe0..0xff that also sets lc / lp / pb), which is all liblzma accepts first; a larger dictionary than the
    # encoder's decodes the same.
    if not data or not (data[0] == 0x01 or data[0] >= 0xE0):
        raise NotTaken()
    dec = lzma.LZMADecompressor(lzma.FORMAT_RAW, None, [{"id": lzma.FILTER_LZMA2, "dict_size": DECODER_MEM_BYTES}])
    try:
        out, _ = drain(dec, data, MAX_TEXT_BYTES)
    except lzma.LZMAError:
        raise NotTaken()
    if not dec.eof or dec.unused_data:
        raise NotTaken()
    return out


def gzip_decode(data):
    # gzip.decompress: every member, the zero padding between them skipped, each CRC and length checked.
    if not data.startswith(GZIP_MAGIC):
        raise NotTaken()
    try:
        members = []
        total = 0
        while True:
            fp = io.BytesIO(data)
            if gzip._read_gzip_header(fp) is None:
                return b"".join(members)
            dec = zlib.decompressobj(wbits=-zlib.MAX_WBITS)
            out, n = zdrain(dec, data[fp.tell():], MAX_TEXT_BYTES - total)
            if not dec.eof or len(dec.unused_data) < 8:
                raise EOFError("compressed file ended before the end-of-stream marker was reached")
            crc, length = struct.unpack("<II", dec.unused_data[:8])
            if crc != zlib.crc32(out) or length != (len(out) & 0xFFFFFFFF):
                raise EOFError("a gzip member's CRC or length does not match")
            members.append(out)
            total += n
            data = dec.unused_data[8:].lstrip(b"\x00")
    except (OSError, EOFError, ValueError, zlib.error, struct.error):
        raise Broken()


def bz2_decode(data):
    # bz2.decompress: every stream; data after the last that is not a stream is ignored.
    if not (len(data) >= 4 and data.startswith(BZ2_MAGIC) and 0x31 <= data[3] <= 0x39):
        raise NotTaken()
    results = []
    total = 0
    try:
        while data:
            dec = bz2.BZ2Decompressor()
            try:
                out, n = drain(dec, data, MAX_TEXT_BYTES - total)
            except OSError:
                if results:
                    break
                raise
            results.append(out)
            total += n
            if not dec.eof:
                raise EOFError("compressed data ended before the end-of-stream marker was reached")
            data = dec.unused_data
    except (OSError, EOFError, ValueError):
        raise Broken()
    return b"".join(results)


def zlib_header(data):
    # A zlib header: deflate, a window of at most 32 KiB, its check bits right.
    return len(data) >= 2 and (data[0] & 0x0F) == 8 and (data[0] >> 4) <= 7 and ((data[0] << 8) | data[1]) % 31 == 0


def zlib_decode(data):
    # zlib.decompress: one stream with a zlib header; what follows its end is ignored.
    if not zlib_header(data):
        raise NotTaken()
    dec = zlib.decompressobj(zlib.MAX_WBITS)
    try:
        out, _ = zdrain(dec, data, MAX_TEXT_BYTES)
    except zlib.error:
        raise Broken()
    if not dec.eof:
        raise Broken()
    return out


def deflate_raw_decode(data):
    # zlib.decompress(data, wbits=-15): one raw deflate stream ending exactly at the last byte.
    dec = zlib.decompressobj(-zlib.MAX_WBITS)
    try:
        out, _ = zdrain(dec, data, MAX_TEXT_BYTES)
    except zlib.error:
        raise NotTaken()
    if not dec.eof or dec.unused_data:
        raise NotTaken()
    return out


# ---------------------------------------------------------------- the ASCII decoders


def squeezed(data):
    # The bytes with ASCII whitespace removed, when every byte is ASCII and MIN_ASCII_BYTES are left; else None.
    if not data.isascii():
        return None
    s = b"".join(data.split())
    return s if len(s) >= MIN_ASCII_BYTES else None


def hex_decode(s):
    try:
        return binascii.unhexlify(s)
    except (binascii.Error, ValueError):
        raise NotTaken()


def b64_decode(s):
    try:
        return base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        raise NotTaken()


def urlsafe_decode(s):
    # Its own alphabet only (a '-' or '_' in it, else it is b64decode's), padded to a multiple of four.
    if b"-" not in s and b"_" not in s:
        raise NotTaken()
    body = s.rstrip(b"=")
    if body.translate(None, URLSAFE_ALPHABET) or len(s) % 4 or len(s) - len(body) > 2:
        raise NotTaken()
    try:
        return base64.urlsafe_b64decode(s)
    except (binascii.Error, ValueError):
        raise NotTaken()


def b85_decode(s):
    try:
        return base64.b85decode(s)
    except (binascii.Error, ValueError):
        raise NotTaken()


def a85_decode(s):
    try:
        return base64.a85decode(s, adobe=s.startswith(b"<~") and s.endswith(b"~>"))
    except (binascii.Error, ValueError):
        raise NotTaken()


def decoders(data):
    # (via name, decoder of data, strong) in protocol.ts DECODE_VIA's order. A strong decoder names its stream itself
    # (a magic, a header, or the whole input in a strict alphabet): a chain through it that ends in no text is
    # not_text. A weak one takes many byte strings by chance, so such a chain says nothing.
    out = [
        ("lzma.decompress", lambda: lzma_decode(data), True),
        ("gzip.decompress", lambda: gzip_decode(data), True),
        ("bz2.decompress", lambda: bz2_decode(data), True),
        ("zlib.decompress", lambda: zlib_decode(data), True),
    ]
    s = squeezed(data)
    if s is not None:
        out += [
            ("binascii.unhexlify", lambda: hex_decode(s), True),
            ("base64.b64decode", lambda: b64_decode(s), True),
            ("base64.urlsafe_b64decode", lambda: urlsafe_decode(s), True),
            ("base64.b85decode", lambda: b85_decode(s), False),
            ("base64.a85decode", lambda: a85_decode(s), False),
        ]
    out += [
        ("lzma.decompress:raw-lzma2", lambda: lzma2_raw_decode(data), False),
        ("zlib.decompress:raw-deflate", lambda: deflate_raw_decode(data), False),
    ]
    return out


# ---------------------------------------------------------------- the search


class Search:
    # One file's search: the first chain, in decoders() order depth first, whose last output is text that no strong
    # decoder takes further. A text a strong decoder takes (base64 of a payload, say) is never the answer itself: its
    # chain's own failure is, so a payload nested past MAX_DEPTH is too_deep, never its last encoding read as text.

    def __init__(self):
        self.steps = 0

    def run(self, data, depth):
        # (via, text bytes) of the chain found, else (None, the failures seen on the way).
        text = is_text(data)
        failures = set()
        taken = False
        for name, decode, strong in decoders(data):
            try:
                out = decode()
            except NotTaken:
                continue
            except Broken:
                # A text that happens to open like a stream's header is no broken stream.
                if not text:
                    failures.add("decode_failed")
                continue
            except (OverCap, MemoryError):
                failures.add("over_cap")
                taken = taken or strong
                continue
            except Exception:
                continue
            if not out:
                continue
            self.steps += 1
            if self.steps > MAX_STEPS:
                raise SearchCap()
            if depth == MAX_DEPTH:
                if strong:
                    failures.add("too_deep")
                    taken = True
                continue
            via, found = self.run(out, depth + 1)
            out = None
            if via is not None:
                return [name] + via, found
            if strong:
                taken = True
                failures |= found or {"not_text"}
            elif "over_cap" in found:
                failures.add("over_cap")
        if text and depth > 0 and not taken:
            return [], data
        return None, failures


def why_of(failures):
    for why in FAILURE_ORDER:
        if why in failures:
            return why
    return "no_decoder"


def input_count():
    # The inputs /input/0 .. /input/<n-1>, as the driver writes them.
    n = 0
    while os.path.isfile(os.path.join(INPUT_DIR, str(n))):
        n += 1
    return n


def main():
    signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, SCRIPT_MS / 1000.0)
    files = []
    texts = []
    total_in = 0
    total_text = 0
    for i in range(input_count()):
        with open(os.path.join(INPUT_DIR, str(i)), "rb") as fh:
            raw = fh.read(MAX_FILE_BYTES + 1)
        total_in += len(raw)
        if i >= MAX_FILES or len(raw) > MAX_FILE_BYTES or total_in > MAX_INPUT_BYTES:
            files.append({"i": i, "why": "over_cap"})
            continue
        try:
            via, found = Search().run(raw, 0)
        except SearchCap:
            via, found = None, {"too_deep"}
        except MemoryError:
            via, found = None, {"over_cap"}
        if via is None:
            files.append({"i": i, "why": why_of(found)})
            continue
        if total_text + len(found) > MAX_TOTAL_TEXT_BYTES:
            files.append({"i": i, "why": "over_cap"})
            continue
        total_text += len(found)
        files.append({"i": i, "via": via, "bytes_in": len(raw), "utf8_len": len(found)})
        texts.append(found)
        raw = found = None
    signal.setitimer(signal.ITIMER_REAL, 0)
    head = json.dumps(
        {"v": WIRE_VERSION, "python": platform.python_version(), "files": files},
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("ascii")
    if len(head) > HEAD_MAX_BYTES:
        sys.stderr.write("decode: the head is over its cap\n")
        sys.stderr.flush()
        os._exit(EXIT_HEAD_TOO_LARGE)
    out = sys.stdout.buffer
    out.write(head + b"\n")
    for data in texts:
        out.write(data)
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
