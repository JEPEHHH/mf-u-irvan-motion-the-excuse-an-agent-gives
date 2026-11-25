// The house tree stream: directory trees on one byte stream, between the grader and a claim-less sandbox pod, in both
// directions (the plan's D20: a house format in perl-base, not tar). Four ends, two per direction:
//
//   staging, grader to pod:  packTrees (node, here) -> TREE_UNPACK_SCRIPT (perl, in the pod's `stage` container)
//   collect, pod to grader:  TREE_PACK_SCRIPT (perl, in the pod's `watch` container) -> readTrees (node, here)
//
// The perl scripts use perl-base's modules alone (POSIX, Fcntl; Errno through %!), as CPU_LAUNCHER_SCRIPT in k8s.ts
// does, so both pinned images run them with no install; they run as `perl -e <script> -- <args...>`
// (treeUnpackArgv, treePackArgv).
//
// The format, makefun-tree/1. Every frame is one header line of ASCII fields split by single spaces and ended by "\n",
// at most TREE_MAX_LINE bytes, then, for some frames, raw bytes whose length the header gives. A number is decimal,
// `0` or up to 15 digits with no leading zero (below 2^53, exact in both languages).
//
//   makefun-tree/1\n                                     the opening frame
//   M <mount>\n                                          a tree begins: its mount point, a plain absolute path (/output)
//   E <type> <mode> <size> <blocks> <len>\n<path>[<data>]  one entry of that tree
//   C <entries> <bytes> <cut>\n                          the tree ends: its entries, its files' data bytes, and `-`,
//                                                        or the cap it stopped at (depth | path | entries | bytes)
//   Z <trees> <entries> <bytes>\n                        the closing frame: the stream's totals
//
// An entry's path is relative to its mount point: `len` (1 to TREE_MAX_PATH_BYTES) raw bytes, segments split by `/`,
// none empty, `.` or `..`, none holding NUL or longer than TREE_MAX_NAME_BYTES; any other byte, UTF-8 or not, is
// carried as it is and never decoded. Its parent is the mount point or a directory an earlier entry of the same tree
// made. `mode` is four octal digits (st_mode & 07777); `size` and `blocks` are lstat's (blocks of 512 bytes), which the
// collect packer clamps so that every figure fits whatever the filesystem says (a sparse file of an exabyte has a size
// of 19 digits and no blocks): a regular file's to one past its tree's bytes cap (maxBytes + 1 bytes, and
// ceil((maxBytes + 1) / 512) blocks), which only the file a tree stops at can pass, any other entry's to
// TREE_MAX_NUMBER. Types:
//
//   d  a directory                f  a regular file, then its `size` bytes of data
//   l  a symbolic link, then its target: `size` bytes, 1 to TREE_MAX_LINK_BYTES, no NUL
//   F  a regular file whose bytes are not sent (unreadable, or the entry a tree stopped at)
//   D  a directory the packer could not list or enter (nothing of it is sent)
//   p  a FIFO     s  a socket     c  a character device     b  a block device      (never opened)
//
// Staging sends d, f and l only: packTrees walks host directories without following a link (a snapshot may hold
// links: server/repos/index-tar.ts materializeSnapshot) and refuses any other type; the unpacker writes only below the
// mount points its argv names and only into directories it made in this run, so it never writes through a link (each
// file O_EXCL|O_NOFOLLOW, each directory by mkdir, each link by symlink, all of which refuse an existing name); it sets
// each file's mode (& 0777) after its data and every directory's last, deepest first, checks each tree's and the
// stream's closing totals, and prints one line: `ok <entries> <bytes>` and exit 0, or `no <why>` and exit 1
// (parseUnpackAck). It answers once the closing frame is read; it never waits for the end of its stdin. Nothing else
// of it reaches stdout, since its one stdout line is the verdict. It prints no sign that it started: the agent's
// `:status 200` is the sign that an exec opened in the pod (k8s-transfer.ts).
//
// Collect sends every type. The packer runs as the uid its container gives it (10001 in `watch`, never root: it
// refuses euid 0) and reads by the kernel's own check, emulating no rule about mode bits: a regular file is opened
// O_RDONLY|O_NOFOLLOW|O_NONBLOCK, then fstat'd to be the same regular file before its bytes are sent, and EACCES or
// EPERM makes it `F`; a directory is opendir'd and entered by fchdir on that handle (read and search), and EACCES or
// EPERM on either makes it `D`. Links, FIFOs, sockets and devices are never opened (a link's target is read with
// readlink). It walks each mount with its caps (entries of every type; the larger of its regular files' apparent and
// allocated totals; depth; path bytes): it sends every entry within them and the first entry that breaks one, with
// no data (a file as `F`) and nothing under it, then closes the tree with that cap as its `cut`. Its cut is decided on
// lstat's own figures, never the clamped ones, and the clamped ones reach the same cut in the reader (a clamped file
// still passes the cap). Every other number it prints fits by its caps, which it takes only when each tree's
// maxEntries and maxBytes are below TREE_MAX_NUMBER and the trees' (maxEntries + 1) and maxBytes each sum to at most
// it (fullCaps, treePackArgv): a tree closes on at most maxEntries + 1 entries and maxBytes data bytes, the stream on
// their sums. Anything else it cannot do (an I/O error, a tree that changes under it) is `tree pack: <why>` on stderr
// and exit 1 with no closing frame, so the reader sees a cut stream; caps it does not take are that exit before it
// prints anything. It writes in 64 KiB blocks.
//
// readTrees rebuilds a bounded replica of each tree in an empty host directory of the grader's own: it never follows
// a link, creates every entry with O_EXCL|O_NOFOLLOW (files), mkdir (directories) or symlink (placeholders) under a
// directory it made itself, checks every name, and holds each tree to its caps while it reads, with the packer's own
// rule (the cap an entry breaks is checked in the order depth, path, entries, bytes, after the entry is counted), so
// a stream that sends data past a cap, an entry past the cut, or a cut the reader does not find itself is refused.
// What it writes, every mode normalised:
//
//   d -> a directory, 0755             f -> the file with its bytes, 0644 (0755 when any execute bit was set)
//   F -> the first placeholder: a mode-000 file of the same apparent size (sparse; never more than maxBytes + 1, and
//        the bytes cap's own entry at least what puts the tree's apparent total past it)
//   D -> the second: an empty mode-000 directory
//   l, p, s, c, b -> the third: a dangling link to `/dev/null/<type name>` (a path under a device never resolves)
//
// so a walker of the replica (program.ts walkOutputs, collectOutputs) gives today's verdicts: a link or special file
// is not a regular file, a placeholder is not readable (for the grader's non-root uid), and a cut tree holds the one
// entry past its cap. Its report per tree (ReturnedTree) carries the stream's own figures, the cut among them. A
// stream that is cut, lies about a length or a total, or breaks a rule above is a TreeStreamError, and the partial
// replica stays (all of it the grader's own, for the caller to remove).

import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, symlink, type FileHandle } from 'node:fs/promises';

export const TREE_STREAM_FORMAT = 'makefun-tree/1';
/** The longest header line, its "\n" not counted. */
export const TREE_MAX_LINE = 512;
/** The longest entry path (Linux's PATH_MAX). */
export const TREE_MAX_PATH_BYTES = 4096;
/** The longest name (NAME_MAX). */
export const TREE_MAX_NAME_BYTES = 255;
/** The longest link target. */
export const TREE_MAX_LINK_BYTES = 4095;
/** A returned tree's depth cap when its caps name none: grader/program.ts MAX_OUTPUT_DEPTH (held equal by the tests). */
export const DEFAULT_RETURN_DEPTH = 32;
/** A returned tree's path cap when its caps name none: grader/program.ts MAX_OUTPUT_PATH_BYTES (held equal by the tests). */
export const DEFAULT_RETURN_PATH_BYTES = 1024;
/** The largest number the format carries (15 digits). */
export const TREE_MAX_NUMBER = 999_999_999_999_999;
/** The largest maxEntries or maxBytes a returned tree takes: the figure one past it (a cut tree's count, a cut file's size) must fit the format. */
export const TREE_MAX_COUNT_CAP = TREE_MAX_NUMBER - 1;

/** What the dangling placeholder links point at: under a character device, so no path resolves. */
export const PLACEHOLDER_LINK_PREFIX = '/dev/null/';

/** A tree stream that is cut, malformed or hostile, or a tree that cannot be staged or rebuilt. */
export class TreeStreamError extends Error {
  override name = 'TreeStreamError';
}

/** A cap a returned tree stopped at. */
export type TreeCap = 'depth' | 'path' | 'entries' | 'bytes';

export interface TreeTotals {
  trees: number;
  entries: number;
  /** Regular files' data bytes sent. */
  bytes: number;
}

const MOUNT_RE = /^(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;
const NUM_SRC = '(?:0|[1-9][0-9]{0,14})';
const SLASH = Buffer.from('/');
const NUL = 0x00;
const SLASH_BYTE = 0x2f;
const CHUNK = 1024 * 1024;

/** A byte string as a message shows it: at most 80 bytes, everything but printable ASCII as \xNN, quoted. */
export function shownBytes(b: Buffer | string): string {
  const buf = typeof b === 'string' ? Buffer.from(b) : b;
  let s = '';
  for (const c of buf.subarray(0, 80)) s += c > 0x20 && c < 0x7f && c !== 0x22 && c !== 0x5c ? String.fromCharCode(c) : `\\x${c.toString(16).padStart(2, '0')}`;
  return `"${s}${buf.length > 80 ? '…' : ''}"`;
}

function checkMounts(mounts: readonly string[]): void {
  if (mounts.length === 0) throw new TreeStreamError('no mount point given');
  const seen: string[] = [];
  for (const m of mounts) {
    if (m.length > TREE_MAX_NAME_BYTES || !MOUNT_RE.test(m)) throw new TreeStreamError(`mount point ${shownBytes(m)} is not a plain absolute path`);
    for (const o of seen) {
      if (o === m) throw new TreeStreamError(`mount point ${m} is given twice`);
      if (`${m}/`.startsWith(`${o}/`) || `${o}/`.startsWith(`${m}/`)) throw new TreeStreamError(`mount points ${o} and ${m} nest`);
    }
    seen.push(m);
  }
}

function header(type: string, mode: number, size: number, blocks: number, path: Buffer): Buffer {
  const line = `E ${type} ${(mode & 0o7777).toString(8).padStart(4, '0')} ${size} ${blocks} ${path.length}\n`;
  return Buffer.concat([Buffer.from(line, 'latin1'), path]);
}

// ---------------------------------------------------------------- staging: the node packer

/** A host directory staged at a pod's mount point. */
export interface StageTree {
  mount: string;
  dir: string;
}

/** A staging stream: iterate it once; `totals` holds what was sent so far, the whole stream's once it has ended. */
export interface TreePack extends AsyncIterable<Buffer> {
  readonly totals: Readonly<TreeTotals>;
}

/**
 * The staging stream of `trees`, each host directory sent as the tree at its mount point: its directories, regular
 * files (mode, data) and links (target), in byte order of their names, never following a link. A FIFO, socket or
 * device, a name or path past the format's bounds, or a file that changes while it is read is a TreeStreamError
 * thrown from the iteration; a host directory's own failures (ENOENT, EACCES) are thrown as they are.
 */
export function packTrees(trees: readonly StageTree[]): TreePack {
  checkMounts(trees.map((t) => t.mount));
  const totals: TreeTotals = { trees: 0, entries: 0, bytes: 0 };
  let started = false;
  return {
    totals,
    [Symbol.asyncIterator]() {
      if (started) throw new TreeStreamError('a tree pack streams once');
      started = true;
      return packStream(trees, totals);
    },
  };
}

async function listSorted(dir: Buffer): Promise<Buffer[]> {
  const names = await readdir(dir, { encoding: 'buffer' });
  return names.sort(Buffer.compare);
}

async function* packStream(trees: readonly StageTree[], totals: TreeTotals): AsyncGenerator<Buffer> {
  yield Buffer.from(`${TREE_STREAM_FORMAT}\n`);
  for (const tree of trees) {
    const root = Buffer.from(tree.dir);
    const rootSt = await lstat(root);
    if (!rootSt.isDirectory()) throw new TreeStreamError(`${tree.dir} (for ${tree.mount}) is not a directory`);
    yield Buffer.from(`M ${tree.mount}\n`);
    let entries = 0;
    let bytes = 0;
    const stack: { rel: Buffer | null; names: Buffer[]; i: number }[] = [{ rel: null, names: await listSorted(root), i: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.i >= top.names.length) {
        stack.pop();
        continue;
      }
      const name = top.names[top.i++]!;
      const rel = top.rel === null ? name : Buffer.concat([top.rel, SLASH, name]);
      const shown = () => `${tree.dir}/${shownBytes(rel)}`;
      if (name.length > TREE_MAX_NAME_BYTES) throw new TreeStreamError(`${shown()}: a name is longer than ${TREE_MAX_NAME_BYTES} bytes`);
      if (rel.length > TREE_MAX_PATH_BYTES) throw new TreeStreamError(`${shown()}: the path is longer than ${TREE_MAX_PATH_BYTES} bytes`);
      const abs = Buffer.concat([root, SLASH, rel]);
      const st = await lstat(abs);
      entries += 1;
      if (st.isDirectory()) {
        yield header('d', st.mode, st.size, st.blocks, rel);
        stack.push({ rel, names: await listSorted(abs), i: 0 });
      } else if (st.isSymbolicLink()) {
        const to = await readlink(abs, { encoding: 'buffer' });
        if (to.length < 1 || to.length > TREE_MAX_LINK_BYTES || to.includes(NUL)) throw new TreeStreamError(`${shown()}: a link target of ${to.length} bytes`);
        yield Buffer.concat([header('l', st.mode, to.length, st.blocks, rel), to]);
      } else if (st.isFile()) {
        const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const fst = await fh.stat();
          if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev || fst.size !== st.size) throw new TreeStreamError(`${shown()} changed while it was staged`);
          yield header('f', st.mode, st.size, st.blocks, rel);
          let left = st.size;
          while (left > 0) {
            const chunk = Buffer.allocUnsafe(Math.min(left, CHUNK));
            const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) throw new TreeStreamError(`${shown()} changed while it was staged`);
            left -= bytesRead;
            yield bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
          }
        } finally {
          await fh.close();
        }
        bytes += st.size;
      } else {
        const kind = st.isFIFO() ? 'a FIFO' : st.isSocket() ? 'a socket' : 'a device';
        throw new TreeStreamError(`${shown()} is ${kind}: a staged tree holds only directories, regular files and links`);
      }
      totals.entries += 1;
    }
    yield Buffer.from(`C ${entries} ${bytes} -\n`);
    totals.trees += 1;
    totals.bytes += bytes;
  }
  yield Buffer.from(`Z ${totals.trees} ${totals.entries} ${totals.bytes}\n`);
}

// ---------------------------------------------------------------- staging: the perl unpacker

/**
 * The staging unpacker (the header): `perl -e TREE_UNPACK_SCRIPT -- <mount point>...` reads one stream on stdin and
 * writes each tree into its mount point, which must exist as a directory; every mount point given must be staged.
 */
export const TREE_UNPACK_SCRIPT = String.raw`use strict;
use warnings;
use Fcntl qw(:mode O_WRONLY O_CREAT O_EXCL O_NOFOLLOW);
binmode STDIN;
binmode STDOUT;
$| = 1;
my $MAXLINE = 512;
my $NUM = qr/(?:0|[1-9][0-9]{0,14})/;
sub refuse { my ($why) = @_; $why =~ s/[^\x20-\x7e]/?/g; print STDOUT "no $why\n"; exit 1 }
sub shown { my ($s) = @_; my $t = substr($s, 0, 80); $t =~ s/([^\x21-\x7e]|["\\])/sprintf('\\x%02x', ord $1)/ge; return '"' . $t . (length($s) > 80 ? '..."' : '"') }
my @mounts = @ARGV;
refuse('usage: perl -e <unpacker> -- <mount point>...') unless @mounts;
my %staged;
for my $m (@mounts) {
  refuse('mount point ' . shown($m) . ' is not a plain absolute path') unless length($m) <= 255 && $m =~ m{\A(?:/[A-Za-z0-9_][A-Za-z0-9._-]*)+\z};
  refuse("mount point $m is given twice") if exists $staged{$m};
  for my $o (keys %staged) { refuse("mount points $o and $m nest") if index("$m/", "$o/") == 0 || index("$o/", "$m/") == 0 }
  my @st = lstat($m);
  refuse("mount point $m: $!") unless @st;
  refuse("mount point $m is not a directory") unless S_ISDIR($st[2]);
  $staged{$m} = 0;
}
my $buf = '';
sub fill { for (;;) { my $n = sysread(STDIN, $buf, 65536, length $buf); return $n if defined $n; next if $!{EINTR}; refuse("reading the stream: $!") } }
sub line {
  for (;;) {
    my $i = index(substr($buf, 0, $MAXLINE + 1), "\n");
    if ($i >= 0) { my $l = substr($buf, 0, $i); substr($buf, 0, $i + 1, ''); return $l }
    refuse('a frame line is too long') if length($buf) > $MAXLINE;
    refuse('the stream was cut') unless fill();
  }
}
sub take { my ($n) = @_; while (length($buf) < $n) { refuse('the stream was cut') unless fill() } my $s = substr($buf, 0, $n); substr($buf, 0, $n, ''); return $s }
sub copy_to {
  my ($fh, $n, $what) = @_;
  while ($n > 0) {
    if ($buf eq '') { refuse('the stream was cut') unless fill() }
    my $k = length($buf) < $n ? length($buf) : $n;
    my $off = 0;
    while ($off < $k) { my $w = syswrite($fh, $buf, $k - $off, $off); if (!defined $w) { next if $!{EINTR}; refuse("writing $what: $!") } $off += $w }
    substr($buf, 0, $k, '');
    $n -= $k;
  }
}
refuse('not a makefun-tree/1 stream') unless line() eq 'makefun-tree/1';
my ($trees, $entries, $bytes) = (0, 0, 0);
my @dirs;
for (;;) {
  my $l = line();
  if ($l =~ /\AZ ($NUM) ($NUM) ($NUM)\z/) {
    refuse("the stream closed on $1 trees, $2 entries and $3 bytes, but it carried $trees, $entries and $bytes") unless $1 == $trees && $2 == $entries && $3 == $bytes;
    for my $m (@mounts) { refuse("mount point $m was not staged") unless $staged{$m} }
    for my $d (sort { $b->[2] <=> $a->[2] } @dirs) { chmod($d->[1], $d->[0]) or refuse('chmod ' . shown($d->[0]) . ": $!") }
    print STDOUT "ok $entries $bytes\n";
    exit 0;
  }
  refuse('expected a tree or the closing frame') unless $l =~ m{\AM (.*)\z};
  my $m = $1;
  refuse('tree ' . shown($m) . ' is not at a mount point given') unless exists $staged{$m};
  refuse("tree $m comes twice") if $staged{$m};
  $staged{$m} = 1;
  $trees++;
  my %made = ('' => 1);
  my %seen;
  my ($te, $tb) = (0, 0);
  for (;;) {
    my $h = line();
    if ($h =~ /\AC ($NUM) ($NUM) (\S+)\z/) {
      refuse("tree $m closed on $1 entries and $2 bytes, but it carried $te and $tb") unless $1 == $te && $2 == $tb;
      refuse("tree $m was cut at its $3 cap") unless $3 eq '-';
      last;
    }
    my @e = $h =~ /\AE ([dfl]) ([0-7]{4}) ($NUM) ($NUM) ($NUM)\z/;
    refuse("expected an entry of tree $m or its end") unless @e;
    my ($t, $mode, $size, $plen) = ($e[0], oct($e[1]) & 0777, $e[2] + 0, $e[4] + 0);
    refuse('an entry path is empty or longer than 4096 bytes') unless $plen >= 1 && $plen <= 4096;
    my $path = take($plen);
    for my $seg (split m{/}, $path, -1) {
      refuse("entry $m/" . shown($path) . ' is not a plain relative path') if $seg eq '' || $seg eq '.' || $seg eq '..' || index($seg, "\0") >= 0;
      refuse("entry $m/" . shown($path) . ' has a name longer than 255 bytes') if length($seg) > 255;
    }
    refuse("entry $m/" . shown($path) . ' comes twice') if $seen{$path}++;
    my $at = rindex($path, '/');
    refuse("entry $m/" . shown($path) . ' is not under a directory this stream made') unless $made{$at < 0 ? '' : substr($path, 0, $at)};
    my $abs = "$m/$path";
    $te++;
    if ($t eq 'd') {
      mkdir($abs, 0700) or refuse('mkdir ' . shown($abs) . ": $!");
      $made{$path} = 1;
      push @dirs, [$abs, $mode, ($path =~ tr{/}{})];
    } elsif ($t eq 'f') {
      sysopen(my $fh, $abs, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or refuse('create ' . shown($abs) . ": $!");
      copy_to($fh, $size, shown($abs));
      chmod($mode, $fh) or refuse('chmod ' . shown($abs) . ": $!");
      close($fh) or refuse('close ' . shown($abs) . ": $!");
      $tb += $size;
    } else {
      refuse("link $m/" . shown($path) . ' has a target of no or more than 4095 bytes') unless $size >= 1 && $size <= 4095;
      my $to = take($size);
      refuse("link $m/" . shown($path) . ' has a NUL in its target') if index($to, "\0") >= 0;
      symlink($to, $abs) or refuse('symlink ' . shown($abs) . ": $!");
    }
  }
  $entries += $te;
  $bytes += $tb;
}
`;

/** The argv that runs the staging unpacker over `mounts` (mount points in the pod). */
export function treeUnpackArgv(mounts: readonly string[]): string[] {
  checkMounts(mounts);
  return ['perl', '-e', TREE_UNPACK_SCRIPT, '--', ...mounts];
}

/** The unpacker's one line: `ok <entries> <bytes>`, `no <why>`, or null for any other line. */
export type UnpackAck = { ok: true; entries: number; bytes: number } | { ok: false; why: string };

export function parseUnpackAck(line: string): UnpackAck | null {
  const ok = new RegExp(`^ok (${NUM_SRC}) (${NUM_SRC})$`).exec(line);
  if (ok) return { ok: true, entries: Number(ok[1]), bytes: Number(ok[2]) };
  const no = /^no ([\x20-\x7e]+)$/.exec(line);
  if (no) return { ok: false, why: no[1]! };
  return null;
}

// ---------------------------------------------------------------- collect: the perl packer

/** How much of a writable mount may come back. */
export interface ReturnCaps {
  /** Entries of every type, directories included (the mount point not counted). */
  maxEntries: number;
  /** The larger of its regular files' apparent and allocated (512-byte blocks) totals. */
  maxBytes: number;
  /** The deepest entry: 1 for one directly in the mount (default DEFAULT_RETURN_DEPTH). */
  maxDepth?: number;
  /** An entry's path bytes, relative to the mount (default DEFAULT_RETURN_PATH_BYTES). */
  maxPathBytes?: number;
}

/** A writable mount's caps with every default filled in, each checked: maxEntries and maxBytes at most TREE_MAX_COUNT_CAP. */
export function fullCaps(caps: ReturnCaps): Required<ReturnCaps> {
  const full = { maxEntries: caps.maxEntries, maxBytes: caps.maxBytes, maxDepth: caps.maxDepth ?? DEFAULT_RETURN_DEPTH, maxPathBytes: caps.maxPathBytes ?? DEFAULT_RETURN_PATH_BYTES };
  for (const [k, v] of Object.entries(full)) {
    const max = k === 'maxEntries' || k === 'maxBytes' ? TREE_MAX_COUNT_CAP : TREE_MAX_NUMBER;
    if (!Number.isSafeInteger(v) || v < 0 || v > max) throw new TreeStreamError(`cap ${k} is not a whole number from 0 to ${max}`);
  }
  if (full.maxPathBytes > TREE_MAX_PATH_BYTES - TREE_MAX_NAME_BYTES - 1) throw new TreeStreamError(`cap maxPathBytes is past ${TREE_MAX_PATH_BYTES - TREE_MAX_NAME_BYTES - 1}`);
  return full;
}

/**
 * Every tree's caps (fullCaps), checked together: the stream's closing totals are at most the trees' (maxEntries + 1)
 * and maxBytes summed, so each sum must fit the format.
 */
function checkCapTotals(list: readonly ReturnCaps[]): Required<ReturnCaps>[] {
  const full = list.map(fullCaps);
  const entries = full.reduce((n, c) => n + c.maxEntries + 1, 0);
  const bytes = full.reduce((n, c) => n + c.maxBytes, 0);
  if (entries > TREE_MAX_NUMBER || bytes > TREE_MAX_NUMBER) throw new TreeStreamError(`the trees' caps sum past ${TREE_MAX_NUMBER} (each tree's maxEntries + 1, or maxBytes): the closing frame could not carry the totals`);
  return full;
}

/**
 * The collect packer (the header): `perl -e TREE_PACK_SCRIPT -- {<mount> <maxEntries> <maxBytes> <maxDepth>
 * <maxPathBytes>}...` writes one stream of those trees on stdout.
 */
export const TREE_PACK_SCRIPT = String.raw`use strict;
use warnings;
use Fcntl qw(:mode O_RDONLY O_NOFOLLOW O_NONBLOCK);
binmode STDOUT;
sub fail { my ($why) = @_; $why =~ s/[^\x20-\x7e]/?/g; print STDERR "tree pack: $why\n"; exit 1 }
sub shown { my ($s) = @_; my $t = substr($s, 0, 80); $t =~ s/([^\x21-\x7e]|["\\])/sprintf('\\x%02x', ord $1)/ge; return '"' . $t . (length($s) > 80 ? '..."' : '"') }
fail('it runs as root, which reads what the grader cannot') if $> == 0;
my @args = @ARGV;
fail('usage: perl -e <packer> -- {<mount> <maxEntries> <maxBytes> <maxDepth> <maxPathBytes>}...') unless @args && @args % 5 == 0;
my $MAXN = 999999999999999;
my ($sumE, $sumB) = (0, 0);
for (my $i = 0; $i < @args; $i += 5) {
  my ($m, @c) = @args[$i .. $i + 4];
  fail('mount ' . shown($m) . ' is not a plain absolute path') unless length($m) <= 255 && $m =~ m{\A(?:/[A-Za-z0-9_][A-Za-z0-9._-]*)+\z};
  for my $c (@c) { fail("mount $m: cap " . shown($c) . ' is not a number') unless $c =~ /\A(?:0|[1-9][0-9]{0,14})\z/ }
  fail("mount $m: an entries or bytes cap of $MAXN leaves no number for the entry past it") unless $c[0] < $MAXN && $c[1] < $MAXN;
  $sumE += $c[0] + 1;
  $sumB += $c[1];
}
fail("the trees' caps sum past $MAXN") if $sumE > $MAXN || $sumB > $MAXN;
my $ob = '';
sub flush_out { my $off = 0; my $n = length $ob; while ($off < $n) { my $w = syswrite(STDOUT, $ob, $n - $off, $off); if (!defined $w) { next if $!{EINTR}; fail("writing the stream: $!") } $off += $w } $ob = '' }
sub out { $ob .= $_[0]; flush_out() if length($ob) >= 65536 }
my ($mount, $maxE, $maxB, $maxD, $maxP);
my ($count, $app, $alloc, $sent);
sub fit { return $_[0] > $_[1] ? $_[1] : $_[0] }
# Every figure fits the reader: a regular file's are clamped by the caller (walk), the rest here.
sub entry { my ($t, $mode, $size, $blocks, $path) = @_; out(sprintf("E %s %04o %d %d %d\n", $t, $mode & 07777, fit($size, $MAXN), fit($blocks, $MAXN), length $path) . $path) }
sub link_entry {
  my ($name, $path, $st) = @_;
  my $to = readlink($name);
  fail(shown($path) . ": readlink: $!") unless defined $to;
  fail(shown($path) . ' has a link target of no or more than 4095 bytes') unless length($to) >= 1 && length($to) <= 4095;
  entry('l', $st->[2], length $to, $st->[12] || 0, $path);
  out($to);
}
sub file_entry {
  my ($name, $path, $st) = @_;
  my $fh;
  if (!sysopen($fh, $name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)) {
    fail(shown($path) . ": open: $!") unless $!{EACCES} || $!{EPERM};
    entry('F', $st->[2], $st->[7], $st->[12] || 0, $path);
    return;
  }
  my @f = stat($fh);
  fail(shown($path) . ' changed while it was read') unless @f && S_ISREG($f[2]) && $f[0] == $st->[0] && $f[1] == $st->[1] && $f[7] == $st->[7];
  entry('f', $st->[2], $st->[7], $st->[12] || 0, $path);
  my $left = $st->[7];
  while ($left > 0) {
    my $n = sysread($fh, my $b, $left < 65536 ? $left : 65536);
    if (!defined $n) { next if $!{EINTR}; fail(shown($path) . ": read: $!") }
    fail(shown($path) . ' changed while it was read') if $n == 0;
    out($b);
    $left -= $n;
  }
  close $fh;
  $sent += $st->[7];
}
sub walk {
  my ($dh, $rel, $depth) = @_;
  while (defined(my $name = readdir $dh)) {
    next if $name eq '.' || $name eq '..';
    my $path = $rel eq '' ? $name : "$rel/$name";
    my @st = lstat($name);
    fail(shown("$mount/$path") . ": lstat: $!") unless @st;
    my $m = $st[2];
    my $t = S_ISDIR($m) ? 'd' : S_ISREG($m) ? 'f' : S_ISLNK($m) ? 'l' : S_ISFIFO($m) ? 'p' : S_ISSOCK($m) ? 's' : S_ISCHR($m) ? 'c' : S_ISBLK($m) ? 'b' : '';
    fail(shown("$mount/$path") . ' is of no type the stream carries') if $t eq '';
    $count++;
    my ($size, $blocks) = ($st[7], $st[12] || 0);
    if ($t eq 'f') {
      # The sums that decide the cut take lstat's figures; what is printed is clamped to one past the cap, which a file
      # within the caps never reaches and a clamped file still passes, so the reader finds the same cut.
      $app += $size;
      $alloc += $blocks * 512;
      ($size, $blocks) = (fit($size, $maxB + 1), fit($blocks, int(($maxB + 512) / 512)));
    }
    my $over = $depth + 1 > $maxD ? 'depth' : length($path) > $maxP ? 'path' : $count > $maxE ? 'entries' : ($t eq 'f' && ($app > $maxB || $alloc > $maxB)) ? 'bytes' : '';
    if ($over ne '') {
      if ($t eq 'l') { link_entry($name, $path, \@st) } else { entry($t eq 'f' ? 'F' : $t, $m, $size, $blocks, $path) }
      return $over;
    }
    if ($t eq 'f') { file_entry($name, $path, \@st); next }
    if ($t eq 'l') { link_entry($name, $path, \@st); next }
    if ($t ne 'd') { entry($t, $m, $st[7], $st[12] || 0, $path); next }
    my $sub;
    if (!opendir($sub, $name)) {
      fail(shown("$mount/$path") . ": opendir: $!") unless $!{EACCES} || $!{EPERM};
      entry('D', $m, $st[7], $st[12] || 0, $path);
      next;
    }
    if (!chdir($sub)) {
      fail(shown("$mount/$path") . ": chdir: $!") unless $!{EACCES} || $!{EPERM};
      closedir $sub;
      entry('D', $m, $st[7], $st[12] || 0, $path);
      next;
    }
    my @here = lstat('.');
    fail(shown("$mount/$path") . ' changed while it was read') unless @here && $here[0] == $st[0] && $here[1] == $st[1];
    entry('d', $m, $st[7], $st[12] || 0, $path);
    my $r = walk($sub, $path, $depth + 1);
    chdir($dh) or fail(shown($rel eq '' ? $mount : "$mount/$rel") . ": chdir back: $!");
    closedir $sub;
    return $r if $r ne '';
  }
  return '';
}
my ($trees, $entries, $bytes) = (0, 0, 0);
out("makefun-tree/1\n");
while (@args) {
  ($mount, $maxE, $maxB, $maxD, $maxP) = splice(@args, 0, 5);
  my @st = lstat($mount);
  fail("mount $mount: $!") unless @st;
  fail("mount $mount is not a directory") unless S_ISDIR($st[2]);
  opendir(my $dh, $mount) or fail("mount $mount: opendir: $!");
  chdir($dh) or fail("mount $mount: chdir: $!");
  my @here = lstat('.');
  fail("mount $mount changed while it was read") unless @here && $here[0] == $st[0] && $here[1] == $st[1];
  ($count, $app, $alloc, $sent) = (0, 0, 0, 0);
  out("M $mount\n");
  my $cut = walk($dh, '', 0);
  closedir $dh;
  out("C $count $sent " . ($cut eq '' ? '-' : $cut) . "\n");
  $trees++;
  $entries += $count;
  $bytes += $sent;
}
out("Z $trees $entries $bytes\n");
flush_out();
exit 0;
`;

/** The argv that runs the collect packer over `trees` (mount points in the pod, each with its caps). */
export function treePackArgv(trees: readonly { mount: string; caps: ReturnCaps }[]): string[] {
  checkMounts(trees.map((t) => t.mount));
  const caps = checkCapTotals(trees.map((t) => t.caps));
  return [
    'perl',
    '-e',
    TREE_PACK_SCRIPT,
    '--',
    ...trees.flatMap((t, i) => {
      const c = caps[i]!;
      return [t.mount, String(c.maxEntries), String(c.maxBytes), String(c.maxDepth), String(c.maxPathBytes)];
    }),
  ];
}

// ---------------------------------------------------------------- collect: the node reader

/** A writable mount to rebuild: its mount point in the stream, the empty host directory its replica goes in, its caps. */
export interface ReturnTree {
  mount: string;
  dir: string;
  caps: ReturnCaps;
}

/** What readTrees made of one tree, by the stream's own figures. */
export interface ReturnedTree {
  mount: string;
  dir: string;
  /** Entries written, the one past a cap included. */
  entries: number;
  /** The larger of its regular files' (f and F) apparent and allocated totals, by the stream's figures (a file past the bytes cap clamped to one past it: the header). */
  bytes: number;
  /** Its deepest entry: 1 for one directly in the mount, 0 when empty. */
  depth: number;
  /** Regular files the packer could not open (F within the caps): mode-000 placeholders. */
  unreadableFiles: number;
  /** Directories the packer could not list or enter (D): empty mode-000 placeholders. */
  unreadDirs: number;
  /** Links, FIFOs, sockets and devices: dangling placeholder links. */
  specials: number;
  /** The cap the packer stopped at, or null for a whole tree. */
  cut: TreeCap | null;
}

const SPECIAL_NAMES: Record<string, string> = { l: 'link', p: 'fifo', s: 'socket', c: 'char-device', b: 'block-device' };

/** A pull reader over an async byte source, its header lines bounded. */
class StreamIn {
  private readonly it: AsyncIterator<Uint8Array>;
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(src: AsyncIterable<Uint8Array>) {
    this.it = src[Symbol.asyncIterator]();
  }
  private async more(): Promise<boolean> {
    while (!this.done) {
      const r = await this.it.next();
      if (r.done) {
        this.done = true;
        break;
      }
      const v = r.value;
      if (v.byteLength === 0) continue;
      const chunk = Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      return true;
    }
    return false;
  }
  async line(): Promise<string> {
    for (;;) {
      const i = this.buf.subarray(0, TREE_MAX_LINE + 1).indexOf(0x0a);
      if (i >= 0) {
        const l = this.buf.subarray(0, i).toString('latin1');
        this.buf = this.buf.subarray(i + 1);
        return l;
      }
      if (this.buf.length > TREE_MAX_LINE) throw new TreeStreamError('a frame line is too long');
      if (!(await this.more())) throw new TreeStreamError('the stream was cut');
    }
  }
  async take(n: number): Promise<Buffer> {
    while (this.buf.length < n) if (!(await this.more())) throw new TreeStreamError('the stream was cut');
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }
  async copyTo(fh: FileHandle, n: number): Promise<void> {
    while (n > 0) {
      if (this.buf.length === 0 && !(await this.more())) throw new TreeStreamError('the stream was cut');
      const k = Math.min(this.buf.length, n);
      let off = 0;
      while (off < k) off += (await fh.write(this.buf, off, k - off)).bytesWritten;
      this.buf = this.buf.subarray(k);
      n -= k;
    }
  }
  async atEnd(): Promise<boolean> {
    return this.buf.length === 0 && !(await this.more());
  }
}

function num(s: string | undefined, what: string): number {
  if (s === undefined || !new RegExp(`^${NUM_SRC}$`).test(s)) throw new TreeStreamError(`${what} is not a number`);
  return Number(s);
}

async function checkReturnDirs(trees: readonly ReturnTree[]): Promise<void> {
  checkMounts(trees.map((t) => t.mount));
  checkCapTotals(trees.map((t) => t.caps));
  const real = new Set<string>();
  for (const t of trees) {
    const st = await lstat(t.dir);
    if (!st.isDirectory()) throw new TreeStreamError(`${t.dir} (for ${t.mount}) is not a directory`);
    if ((await readdir(t.dir)).length > 0) throw new TreeStreamError(`${t.dir} (for ${t.mount}) is not empty`);
    const r = await realpath(t.dir);
    if (real.has(r)) throw new TreeStreamError(`${t.dir} (for ${t.mount}) is another mount's directory too`);
    real.add(r);
  }
}

/**
 * Rebuild the trees of a collect stream (the header), each in its ReturnTree's directory, which must exist and be
 * empty. Every tree asked for must come once, and no other. Resolves to one report per tree, in `trees`' order, once
 * the closing frame and the end of the stream are read; a cut, malformed or hostile stream, or a replica entry the
 * host refuses (a name its filesystem cannot hold), is a TreeStreamError.
 */
export async function readTrees(source: AsyncIterable<Uint8Array>, trees: readonly ReturnTree[]): Promise<ReturnedTree[]> {
  await checkReturnDirs(trees);
  const s = new StreamIn(source);
  if ((await s.line()) !== TREE_STREAM_FORMAT) throw new TreeStreamError(`not a ${TREE_STREAM_FORMAT} stream`);
  const byMount = new Map(trees.map((t) => [t.mount, t]));
  const done = new Map<string, { report: ReturnedTree; data: number }>();
  let entries = 0;
  let data = 0;
  for (;;) {
    const l = await s.line();
    const z = /^Z (\S+) (\S+) (\S+)$/.exec(l);
    if (z) {
      const [zt, ze, zb] = [num(z[1], 'a closing count'), num(z[2], 'a closing count'), num(z[3], 'a closing count')];
      if (zt !== done.size || ze !== entries || zb !== data) throw new TreeStreamError(`the stream closed on ${zt} trees, ${ze} entries and ${zb} bytes, but it carried ${done.size}, ${entries} and ${data}`);
      for (const t of trees) if (!done.has(t.mount)) throw new TreeStreamError(`tree ${t.mount} did not come`);
      if (!(await s.atEnd())) throw new TreeStreamError('the stream goes on past its closing frame');
      return trees.map((t) => done.get(t.mount)!.report);
    }
    const m = /^M (.*)$/.exec(l);
    if (!m) throw new TreeStreamError('expected a tree or the closing frame');
    const tree = byMount.get(m[1]!);
    if (tree === undefined) throw new TreeStreamError(`tree ${shownBytes(m[1]!)} was not asked for`);
    if (done.has(tree.mount)) throw new TreeStreamError(`tree ${tree.mount} comes twice`);
    const got = await readTree(s, tree);
    done.set(tree.mount, got);
    entries += got.report.entries;
    data += got.data;
  }
}

async function readTree(s: StreamIn, tree: ReturnTree): Promise<{ report: ReturnedTree; data: number }> {
  const caps = fullCaps(tree.caps);
  const root = Buffer.from(tree.dir);
  const made = new Set<string>(['']);
  const seen = new Set<string>();
  const dirs: { abs: Buffer; mode: number; depth: number }[] = [];
  const r: ReturnedTree = { mount: tree.mount, dir: tree.dir, entries: 0, bytes: 0, depth: 0, unreadableFiles: 0, unreadDirs: 0, specials: 0, cut: null };
  let apparent = 0;
  let allocated = 0;
  let data = 0;
  for (;;) {
    const h = await s.line();
    const c = /^C (\S+) (\S+) (\S+)$/.exec(h);
    if (c) {
      const [ce, cb] = [num(c[1], 'a tree count'), num(c[2], 'a tree count')];
      if (ce !== r.entries || cb !== data) throw new TreeStreamError(`tree ${tree.mount} closed on ${ce} entries and ${cb} bytes, but it carried ${r.entries} and ${data}`);
      const said = c[3] === '-' ? null : c[3];
      if (said !== r.cut) throw new TreeStreamError(`tree ${tree.mount} closed as cut at ${shownBytes(c[3]!)}, but it reached ${r.cut ?? 'no cap'}`);
      break;
    }
    if (r.cut !== null) throw new TreeStreamError(`tree ${tree.mount} goes on past its ${r.cut} cap`);
    const e = /^E ([dfFDlpscb]) ([0-7]{4}) (\S+) (\S+) (\S+)$/.exec(h);
    if (!e) throw new TreeStreamError(`expected an entry of tree ${tree.mount} or its end`);
    const t = e[1]!;
    const mode = parseInt(e[2]!, 8);
    const size = num(e[3], 'an entry size');
    const blocks = num(e[4], 'an entry block count');
    const plen = num(e[5], 'an entry path length');
    if (plen < 1 || plen > TREE_MAX_PATH_BYTES) throw new TreeStreamError(`an entry path of tree ${tree.mount} is empty or longer than ${TREE_MAX_PATH_BYTES} bytes`);
    const path = await s.take(plen);
    const at = `${tree.mount}/${shownBytes(path)}`;
    let segs = 0;
    let start = 0;
    for (let i = 0; i <= path.length; i++) {
      if (i < path.length && path[i] !== SLASH_BYTE) continue;
      const seg = path.subarray(start, i);
      if (seg.length === 0 || (seg.length === 1 && seg[0] === 0x2e) || (seg.length === 2 && seg[0] === 0x2e && seg[1] === 0x2e) || seg.includes(NUL)) {
        throw new TreeStreamError(`entry ${at} is not a plain relative path`);
      }
      if (seg.length > TREE_MAX_NAME_BYTES) throw new TreeStreamError(`entry ${at} has a name longer than ${TREE_MAX_NAME_BYTES} bytes`);
      segs += 1;
      start = i + 1;
    }
    const key = path.toString('latin1');
    if (seen.has(key)) throw new TreeStreamError(`entry ${at} comes twice`);
    seen.add(key);
    const slash = path.lastIndexOf(SLASH_BYTE);
    if (!made.has(slash < 0 ? '' : key.slice(0, slash))) throw new TreeStreamError(`entry ${at} is not under a directory this stream made`);
    r.entries += 1;
    const regular = t === 'f' || t === 'F';
    const apparentBefore = apparent;
    if (regular) {
      apparent += size;
      allocated += blocks * 512;
    }
    const cap: TreeCap | null =
      segs > caps.maxDepth ? 'depth' : plen > caps.maxPathBytes ? 'path' : r.entries > caps.maxEntries ? 'entries' : regular && Math.max(apparent, allocated) > caps.maxBytes ? 'bytes' : null;
    if (cap !== null && t === 'f') throw new TreeStreamError(`entry ${at} carries data past the tree's ${cap} cap`);
    r.depth = Math.max(r.depth, segs);
    const abs = Buffer.concat([root, SLASH, path]);
    try {
      if (t === 'd' || t === 'D') {
        await mkdir(abs, { mode: 0o700 });
        if (t === 'd' && cap === null) made.add(key);
        dirs.push({ abs, mode: t === 'd' ? 0o755 : 0, depth: segs });
        if (t === 'D') r.unreadDirs += 1;
      } else if (regular) {
        const fh = await open(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          if (t === 'f') {
            await s.copyTo(fh, size);
            data += size;
            await fh.chmod(mode & 0o111 ? 0o755 : 0o644);
          } else {
            let shown = Math.min(size, caps.maxBytes + 1);
            if (cap === 'bytes') shown = Math.max(shown, caps.maxBytes + 1 - apparentBefore);
            await fh.truncate(shown);
            await fh.chmod(0);
            if (cap === null) r.unreadableFiles += 1;
          }
        } finally {
          await fh.close();
        }
      } else {
        if (t === 'l') {
          if (size < 1 || size > TREE_MAX_LINK_BYTES) throw new TreeStreamError(`link ${at} has a target of no or more than ${TREE_MAX_LINK_BYTES} bytes`);
          if ((await s.take(size)).includes(NUL)) throw new TreeStreamError(`link ${at} has a NUL in its target`);
        }
        await symlink(`${PLACEHOLDER_LINK_PREFIX}${SPECIAL_NAMES[t]!}`, abs);
        r.specials += 1;
      }
    } catch (err) {
      if (err instanceof TreeStreamError) throw err;
      const code = (err as NodeJS.ErrnoException | null)?.code ?? String(err);
      throw new TreeStreamError(`cannot write ${at} into ${tree.dir}: ${code}`, { cause: err });
    }
    if (cap !== null) r.cut = cap;
  }
  r.bytes = Math.max(apparent, allocated);
  for (const d of dirs.sort((a, b) => b.depth - a.depth)) {
    try {
      await chmod(d.abs, d.mode);
    } catch (err) {
      throw new TreeStreamError(`cannot set the mode of a directory of ${tree.mount} in ${tree.dir}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`, { cause: err });
    }
  }
  return { report: r, data };
}
