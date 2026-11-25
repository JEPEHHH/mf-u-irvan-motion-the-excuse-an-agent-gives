// The live watch (the plan's D9 and D9b; k8s.ts drives it): one house perl script exec'd into a program pod's `watch`
// container while the program runs, and its host side. It keeps in step with the program the few files the harness
// polls (a writable mount's `live` files: types.ts's header, mounts.ts checkLiveFiles), and meters the pod's writable
// mounts as docker.ts's meter container does. The exec is <plan.command> run by the pod's `watch` agent
// (agent-client.ts AgentSession.stream over the pod's `watch` session; k8s.ts ProgramWatch), built by the driver; this
// file is the script, its argv (planWatch, watchCommand) and the reader of what it prints (LiveWatch).
//
// What it sees and what it is trusted with:
//
// - It runs in `watch` as uid and gid 10001, with no capability, a read-only root and the pod's writable volumes
//   mounted read-only: it sees each tree as the grader sees it today, by the kernel's own check. It counts every entry
//   it can lstat, so a file the program made unreadable is still counted. A directory it cannot enter or list hides
//   what is under it: it is counted, not entered, and its count is the reading's `unread` (TreeUsage.unread). One of
//   them in a metered mount is a breach once it has stayed unreadable for UNREAD_GRACE_MS (the root's amendment to
//   D5b: UnreadGrace below, used by the harness callers), never at the first reading, so a directory made 0700 (as
//   mkdtemp makes it) and renamed or removed at once still passes. The script itself keeps no memory of earlier
//   readings: every reading says `unread` as it found it.
// - The program cannot reach it. It is another uid in another container: no signal, no trace, no write to its stdout.
//   Its readings are the cap, as the meter pod's are today. Between two passes a program can overshoot by one interval
//   of writes, as today. A tree that moves under a pass is counted as the pass finds it, as find counts it today.
// - The program does control what it reads. So a `live` path is walked one component at a time from the mount (each
//   directory entered and checked to be the one lstat saw, so no link is followed on the way), the file is opened
//   O_NOFOLLOW | O_NONBLOCK only once lstat says it is a regular file, and checked again on its descriptor; a link, a
//   FIFO, a socket or a directory there is never read. An appear-once file is sent only at LIVE_FILE_MAX_BYTES or less,
//   and a `follow` file's bytes only up to FOLLOW_MAX_BYTES in all.
// - When it ends before the driver stops it (its exec lost, silence past a bound, a line that is no protocol line) the
//   driver reports a failure, the job retried, as a meter fault is today. The program can cause none of them: nothing
//   it puts in a mount reaches the protocol but hex, its numbers and the fixed refusal words.
// - Nothing it mirrors is stored as the program's: the collect exec's copy, returned after the program ended,
//   replaces the mirror (the plan's collect).
//
// What it does, on one line protocol on its stdout (each line LF-ended, ASCII):
//
//   W 1 <files> <meters>                  first, once: it took its argv (protocol 1, that many files and meters)
//   F <file> <n>[ <hex>]                  an appear-once file, whole: its n bytes. Sent once two lstats WATCH_SETTLE_MS
//                                         apart agree on its device, inode, mode, size, mtime and ctime and a read of
//                                         exactly its size between two equal fstats and a third lstat agrees too; sent
//                                         again when it changes (its bytes differ from the last sent), looked at for
//                                         that every WATCH_IDLE_MS, its last look the first lstat. A file whose
//                                         ctime is within a second of its last read is read again on later polls, so a
//                                         rewrite of the same size in the same second is still seen (ctime is the
//                                         kernel's, no program can set it).
//   A <file> <offset> <n> <hex>           a `follow` file's next n bytes, from its offset: the bytes of the first
//                                         regular file found at its path, as they are appended, FOLLOW_CHUNK_BYTES a
//                                         line at most
//   X <file> <why>                        a file is not mirrored: `type` (not a regular file: a link, a FIFO, a socket,
//                                         a directory), `size` (past LIVE_FILE_MAX_BYTES), `unreadable` (its path or the
//                                         file cannot be opened); for a follow file, its last line: `replaced` (its path
//                                         no longer names the file followed), `truncated`, `cap` (FOLLOW_MAX_BYTES
//                                         sent). Said once each time the reason changes, never for a file still absent
//   R <meter> <entries> <bytes> <depth> <long> <unread>
//                                         a reading of a metered mount: meterScript's numbers over the same tree (every
//                                         entry under it, its regular files' bytes as the larger of apparent and
//                                         allocated, its deepest entry's depth, never looking below the depth cap plus
//                                         one, the paths past the path cap; a pass stops at the first entry past a cap)
//                                         and the directories it could not enter or list. A first pass at once, then one
//                                         `intervalMs` after each pass ends. Bytes past the byte cap are said as the
//                                         cap plus one, never the sum (a sparse file's size can pass 2^53; the caps'
//                                         verdict is the same), and every other figure is bounded by its cap: entries
//                                         by the entry cap plus one, depth by WATCH_MAX_DEPTH plus one, long paths by
//                                         one, unread by the entries plus one. Every cap is at most 15 digits
//                                         (watchCommand), so every figure is a safe integer; the host side reads one
//                                         that is not as a broken watcher (a fault), never as a reading.
//   H                                     a heartbeat, every WATCH_HEARTBEAT_MS (a second), whatever else is said
//
// Each live file is polled on its own cadence, so a watch that has sent what it waits for costs next to nothing: an
// appear-once file not yet sent about every LIVE_POLL_MS (two lstats WATCH_SETTLE_MS apart, then the reads, then a
// wait), as the harness polls a ready file; one already sent every WATCH_IDLE_MS (one lstat, held against the last); a
// follow file every FOLLOW_POLL_MS, quicker only while it is behind. Between polls it sleeps in a select on stdin and the
// meters' pipes until the soonest due, by its own clock (times(2)'s ticks; perl-base has no Time::HiRes), so a meter's
// line never brings a poll forward. Each meter runs in a child process of its own, which hands its lines to the
// parent over a pipe, so a pass over a large tree never holds the live files back and no two writers share stdout. A
// meter pass walks by fchdir (a descriptor per level: WATCH_MAX_DEPTH bounds it), never by path: it enters a directory
// by chdir to its name, checked to be the one lstat saw, lists it on a descriptor, and returns to its parent by that
// parent's descriptor. What the program does to a directory under a pass ends that directory's part of the pass, never
// the meter. A child it cannot enter is counted unread on EACCES or EPERM and skipped on any other errno, neither
// counted further nor marked: by removing or replacing it between the lstat and the chdir the program can cause
// ENOENT, ENOTDIR, ELOOP or ESTALE there, so none of them may end its meter. One entered that is another inode than
// lstat saw is not listed. A directory entered that it cannot list (EACCES, EPERM) is counted
// unread; one it can no longer return to (its search permission taken away while the pass is below it) ends that
// directory's listing and is counted unread; one gone or replaced (ENOENT, ESTALE, ENOTDIR) ends it and counts nothing
// more; the caller returns to its own directory by the same rule. An entry listed that it cannot lstat is skipped when
// gone or replaced since the listing (ENOENT, ESTALE, ENOTDIR: the program removed it between readdir and lstat); one
// it cannot look up (EACCES, EPERM: the directory's search permission taken away while the pass lists it) ends that
// directory's listing, counted unread once, so unread stays bounded by the entries plus one. Only a failed listing of,
// or return to, a directory already entered, or a failed lstat of an entry listed, ends the meter, as its own fault, on
// an errno that rule does not name (EMFILE, EIO). The live files' walk dies on nothing: each failure is a refusal or
// the file absent.
//
// It ends when its stdin closes (the driver's stop, or its agent's stream gone): exit 0. On its own only by a fault: an argv it
// does not take (exit 2, before or right after `W`), a meter child gone (3), its lifetime spent (4; a grader that died
// without stopping it), or its stdout failing (5). Each says why on stderr as `watch: ...`. A meter child goes with it:
// killed by the parent as it exits, or by its next write to the parent's pipe.
//
// The host side (LiveWatch) writes an appear-once file into the mount's host directory by rename (a sibling
// `.<name>.watch-<hex>` made O_EXCL first: a live path never starts with a dot), appends a follow file's bytes to its
// host file (made O_TRUNC | O_NOFOLLOW at its first bytes, each line's offset checked), and hands each reading to its
// meter's onUsage. The polling code reading those files (waitReady, the miss poll, HouseClockReader, gatewayReady) does
// not change. It reports a fault once (onFault) and stops: the exec ending before stop(), no `W` within startMs,
// nothing at all for silenceMs, a line that is no protocol line or does not fit the plan, a host write that fails, or
// anything else that throws while a line is acted on (a meter's onUsage included).

import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { KubectlChild } from './k8s.ts';
import { checkLiveFiles } from './mounts.ts';
import { checkHostPath, MOUNT_POINTS, SandboxError, type MountPoint, type SandboxMount, type TreeUsage } from './types.ts';

/** The protocol the script speaks (its `W` line, its first argument). */
export const WATCH_PROTOCOL = 1;
/** The most bytes of an appear-once file the watcher sends: a ready file or a replay's miss is a line of JSON. */
export const LIVE_FILE_MAX_BYTES = 64 * 1024;
/** The most bytes of a follow file one `A` line carries. */
export const FOLLOW_CHUNK_BYTES = 32 * 1024;
/** The most `A` lines one follow file gets per poll (so at most 8 × 32 KiB a poll). */
export const FOLLOW_LINES_PER_POLL = 8;
/** The most bytes of one follow file the watcher sends in all: an env's call log is a few MB. */
export const FOLLOW_MAX_BYTES = 64 * 1024 * 1024;
/** How far apart the two lstats of a poll are, which must agree before an appear-once file not yet sent is read. */
export const WATCH_SETTLE_MS = 20;
/** The wait after a poll's reads, before the next poll (the poll is about LIVE_POLL_MS from start to start). */
export const WATCH_WAIT_MS = 30;
/** About how often an appear-once file not yet sent is polled: as often as the harness polls a ready file (agent.ts READY_POLL_MS). */
export const LIVE_POLL_MS = WATCH_SETTLE_MS + WATCH_WAIT_MS;
/**
 * How often a follow file is polled (a backlog past one poll's FOLLOW_LINES_PER_POLL lines at the WATCH_WAIT_MS
 * cadence until it is caught up). Its reader, the house clock, reads every 5 s (house-clock.ts HOUSE_CLOCK_POLL_MS) and
 * once more at the entry's deadline, so the mirror lags the env's log by at most this then.
 */
export const FOLLOW_POLL_MS = 250;
/**
 * How often an appear-once file already sent is looked at again, for a change (the same file's last look its settle):
 * every reader takes the first version (ready files and a replay's miss are each written once, by rename), so this
 * only keeps a rewrite mirrored, never anyone waiting.
 */
export const WATCH_IDLE_MS = 1_000;
/** A heartbeat about this often, whatever else it says: well inside WATCH_SILENCE_MS. */
export const WATCH_HEARTBEAT_MS = 1_000;
/** The deepest depth cap a watch meter takes: its pass holds a descriptor per level, well inside any descriptor limit. */
export const WATCH_MAX_DEPTH = 256;
/** The largest path cap a watch meter takes (docker.ts meterScript's: Linux's PATH_MAX). */
export const WATCH_MAX_PATH_BYTES = 4096;
/** How long the watcher has for its `W` line once its exec is asked for (k8s.ts EXEC_START_TIMEOUT_MS's figure). */
export const WATCH_START_MS = 60_000;
/** How long the watcher may say nothing once it has started: its heartbeats come about every second. */
export const WATCH_SILENCE_MS = 30_000;
/** How long stop() waits for the exec to end once its stdin is closed, before it cuts it. */
export const WATCH_STOP_MS = 5_000;
/** The most of the watcher's stderr kept for a fault. */
export const WATCH_STDERR_BYTES = 4096;
/** How long a directory in a metered mount may stay unreadable before it is a breach (the root's amendment to D5b). */
export const UNREAD_GRACE_MS = 2_000;

/** Why the watcher says a file is not mirrored (its `X` line). */
export const WATCH_REFUSALS = ['type', 'size', 'unreadable', 'replaced', 'truncated', 'cap'] as const;
export type WatchRefusal = (typeof WATCH_REFUSALS)[number];

/**
 * The watcher (the header), perl with perl-base's modules alone (POSIX, Fcntl; no Time::HiRes, so it sleeps by
 * select), run as `perl -e WATCH_SCRIPT -- 1 <lifetime s> <spec>...`, each spec `f <dir> <path> <0|1 follow>` or
 * `m <dir> <interval ms> <max entries> <max bytes> <max depth> <max path bytes>` (watchCommand builds it). Files and
 * meters are numbered from 0 in the order given, each list apart.
 */
export const WATCH_SCRIPT = String.raw`use strict;
use warnings;
use POSIX ();
use Fcntl qw(O_RDONLY O_NOFOLLOW O_NONBLOCK S_ISREG S_ISDIR);
$| = 1;
my $LIVE_MAX = ${LIVE_FILE_MAX_BYTES};
my $CHUNK = ${FOLLOW_CHUNK_BYTES};
my $CHUNKS = ${FOLLOW_LINES_PER_POLL};
my $FOLLOW_MAX = ${FOLLOW_MAX_BYTES};
my $MAX_DEPTH = ${WATCH_MAX_DEPTH};
my $MAX_PATH = ${WATCH_MAX_PATH_BYTES};
my $IDLE = ${WATCH_IDLE_MS};
my $BEAT = ${WATCH_HEARTBEAT_MS};
# The loop's clock, in ms since the start: times(2)'s ticks (POSIX::times, perl-base's), never backwards, and never
# behind what whole seconds say less one, so a tick count that stalls or fails still moves it on, a second at a time.
my $HZ = POSIX::sysconf(POSIX::_SC_CLK_TCK());
$HZ = 100 unless defined $HZ && $HZ > 0;
my $T0 = (POSIX::times())[0];
my $S0 = time();
my $clock = 0;
sub now_ms {
  my $t = (POSIX::times())[0];
  my $ms = defined $t && defined $T0 ? ($t - $T0) * 1000 / $HZ : 0;
  my $by_s = (time() - $S0 - 1) * 1000;
  $ms = $by_s if $by_s > $ms;
  $clock = $ms if $ms > $clock;
  return $clock;
}
my @kids;
sub quit { my ($code, $why) = @_; for my $k (@kids) { kill 'KILL', $k->{pid} } for my $k (@kids) { waitpid($k->{pid}, 0) } print STDERR "watch: $why\n" if defined $why; exit $code }
sub fail { quit(2, $_[0]) }
sub out { my $s = $_[0]; my $o = 0; while ($o < length $s) { my $w = syswrite(STDOUT, $s, length($s) - $o, $o); if (!defined $w) { next if $!{EINTR}; quit(5, "stdout: $!") } $o += $w } }
my $DIR_RE = qr{\A/[A-Za-z0-9._/-]*\z};
my $REL_RE = qr{\A[A-Za-z0-9_][A-Za-z0-9._-]*(?:/[A-Za-z0-9_][A-Za-z0-9._-]*)*\z};
my $INT_RE = qr{\A[1-9][0-9]{0,14}\z};
sub dir_ok { my $d = $_[0]; return defined $d && $d =~ $DIR_RE && !grep { $_ eq '..' } split m{/}, $d }
my ($version, $lifetime, @spec) = @ARGV;
fail('it speaks protocol 1 only') unless defined $version && $version eq '1';
fail('its lifetime must be whole seconds') unless defined $lifetime && $lifetime =~ $INT_RE;
my $end = time() + $lifetime;
my (@files, @meters);
while (@spec) {
  my $kind = shift @spec;
  if ($kind eq 'f') {
    my ($at, $rel, $follow) = splice(@spec, 0, 3);
    fail('a file is f <dir> <path> <0|1>') unless defined $follow && dir_ok($at) && $rel =~ $REL_RE && length($rel) <= 255 && $follow =~ /\A[01]\z/;
    push @files, { id => scalar(@files), at => $at, rel => $rel, follow => $follow + 0, noted => '' };
  } elsif ($kind eq 'm') {
    my ($at, @n) = splice(@spec, 0, 6);
    fail('a meter is m <dir> <interval> <entries> <bytes> <depth> <path bytes>') unless @n == 5 && dir_ok($at) && !grep { !defined $_ || $_ !~ $INT_RE } @n;
    fail('a meter depth or path cap is too large') if $n[3] > $MAX_DEPTH || $n[4] > $MAX_PATH;
    push @meters, [$at, @n];
  } else {
    fail('a spec is f or m');
  }
}
fail('nothing to watch') unless @files || @meters;
out('W 1 ' . scalar(@files) . ' ' . scalar(@meters) . "\n");

# ---- the meter: one pass, in the child that runs it
my ($n, $s, $a, $d, $l, $u, $stop, $me, $mb, $md, $mp);
# After a listing of, a return to, or an entry's lstat in, the directory a pass is in failed: 2 when the program took it
# away (EACCES or EPERM: it is unread, counted here), 1 when it is gone or replaced (ENOENT, ESTALE, ENOTDIR: nothing to
# count), 0 for the meter's own fault.
sub lost { if ($!{EACCES} || $!{EPERM}) { $u++; return 2 } return $!{ENOENT} || $!{ESTALE} || $!{ENOTDIR} ? 1 : 0 }
sub visit {
  my ($plen, $depth) = @_;
  my $dh;
  if (!opendir($dh, '.')) { return if lost(); die "watch: a directory could not be listed: $!\n" }
  while (defined(my $name = readdir($dh))) {
    next if $name eq '.' || $name eq '..';
    my @st = lstat($name);
    # An entry gone or replaced since the listing is skipped; one it cannot look up (this directory's search permission
    # taken away) ends its listing, counted unread by lost(), once; any other errno is the meter's own fault.
    if (!@st) { my $why = lost() or die "watch: an entry could not be read: $!\n"; last if $why == 2; next }
    my $cd = $depth + 1;
    my $rl = $plen + length($name);
    $n++;
    if (S_ISREG($st[2])) { $s += $st[7]; $a += $st[12] * 512 }
    $d = $cd if $cd > $d;
    $l++ if $rl > $mp;
    if ($n > $me || $s > $mb || $a > $mb || $d > $md || $l > 0) { $stop = 1; last }
    next unless S_ISDIR($st[2]) && $cd <= $md;
    if (!chdir($name)) { $u++ if $!{EACCES} || $!{EPERM}; next }
    my @here = stat('.');
    visit($rl + 1, $cd) if @here && $here[0] == $st[0] && $here[1] == $st[1];
    # Its listing ends when the way back is gone; the caller returns to its own by the same rule.
    if (!chdir($dh)) { last if lost(); die "watch: could not return to a directory: $!\n" }
    last if $stop;
  }
  closedir($dh);
}
sub pass {
  my ($root);
  ($root, $me, $mb, $md, $mp) = @_;
  ($n, $s, $a, $d, $l, $u, $stop) = (0, 0, 0, 0, 0, 0, 0);
  if (chdir($root)) { visit(0, 0) } elsif ($!{EACCES} || $!{EPERM}) { $u++ } else { die "watch: $root: $!\n" }
  chdir('/');
  # Bytes past the cap are the cap plus one, never the sum: a sparse file's size can pass 2^53 (the header).
  my $bytes = $s > $a ? $s : $a;
  $bytes = $mb + 1 if $bytes > $mb;
  return sprintf('%.0f %.0f %.0f %.0f %.0f', $n, $bytes, $d, $l, $u);
}
for my $id (0 .. $#meters) {
  my ($at, $interval, @caps) = @{$meters[$id]};
  pipe(my $r, my $w) or fail("pipe: $!");
  my $pid = fork();
  fail("fork: $!") unless defined $pid;
  if ($pid == 0) {
    close $r;
    @kids = ();
    open(STDIN, '<', '/dev/null');
    my $parent = getppid();
    while (1) {
      my $line = "R $id " . pass($at, @caps) . "\n";
      my $o = 0;
      while ($o < length $line) { my $wr = syswrite($w, $line, length($line) - $o, $o); if (!defined $wr) { next if $!{EINTR}; POSIX::_exit(1) } $o += $wr }
      POSIX::_exit(0) if getppid() != $parent;
      select(undef, undef, undef, $interval / 1000);
    }
  }
  close $w;
  push @kids, { pid => $pid, fh => $r, id => $id, buf => '' };
}

# ---- the live files, in the parent
# Into the directory holding a file's last component, one component at a time: [name] or [undef, why].
sub walk {
  my ($f) = @_;
  if (!chdir($f->{at})) { return [undef, ($!{EACCES} || $!{EPERM}) ? 'unreadable' : 'absent'] }
  my @parts = split m{/}, $f->{rel};
  my $last = pop @parts;
  for my $p (@parts) {
    my @st = lstat($p);
    return [undef, ($!{EACCES} || $!{EPERM}) ? 'unreadable' : 'absent'] unless @st;
    return [undef, 'type'] unless S_ISDIR($st[2]);
    if (!chdir($p)) { return [undef, ($!{EACCES} || $!{EPERM}) ? 'unreadable' : 'absent'] }
    my @here = stat('.');
    return [undef, 'absent'] unless @here && $here[0] == $st[0] && $here[1] == $st[1];
  }
  return [$last];
}
sub sig { return "$_[0][0] $_[0][1] $_[0][2] $_[0][7] $_[0][9] $_[0][10]" }
# A file's lstat now: {st, sig} or {why}.
sub look {
  my ($f) = @_;
  my $w = walk($f);
  return { why => $w->[1] } unless defined $w->[0];
  my @st = lstat($w->[0]);
  return { why => ($!{EACCES} || $!{EPERM}) ? 'unreadable' : 'absent' } unless @st;
  return { st => \@st, sig => sig(\@st) };
}
# The file opened without following a link and without blocking: [fh, fstat] or [undef, why].
sub open_file {
  my ($f) = @_;
  my $w = walk($f);
  return [undef, $w->[1]] unless defined $w->[0];
  my $fh;
  if (!sysopen($fh, $w->[0], O_RDONLY | O_NOFOLLOW | O_NONBLOCK)) { return [undef, $!{ENOENT} ? 'absent' : ($!{EACCES} || $!{EPERM}) ? 'unreadable' : 'type'] }
  my @st = stat($fh);
  if (!@st || !S_ISREG($st[2])) { close $fh; return [undef, 'type'] }
  return [$fh, \@st];
}
sub note {
  my ($f, $why) = @_;
  $why = '' unless defined $why;
  return if $f->{noted} eq $why;
  $f->{noted} = $why;
  out("X $f->{id} $why\n") unless $why eq '' || $why eq 'absent';
}
sub poll_once {
  my ($f, $before) = @_;
  my $now = look($f);
  # What this poll saw: a sent file's next poll (WATCH_IDLE_MS on) holds it against this, as a settle a second long.
  $f->{seen} = $now;
  return note($f, $now->{why}) if defined $now->{why};
  return note($f, 'type') unless S_ISREG($now->{st}[2]);
  return note($f, 'size') if $now->{st}[7] > $LIVE_MAX;
  return unless defined $before->{sig} && $before->{sig} eq $now->{sig};
  return if defined $f->{rsig} && $f->{rsig} eq $now->{sig} && $now->{st}[10] < $f->{rtime} - 1;
  my $t = time();
  my $o = open_file($f);
  return note($f, $o->[1]) unless defined $o->[0];
  my $fh = $o->[0];
  if (sig($o->[1]) ne $now->{sig}) { close $fh; return }
  my $data = '';
  while (length($data) <= $LIVE_MAX) {
    my $got = sysread($fh, $data, $LIVE_MAX + 1 - length($data), length($data));
    if (!defined $got) { next if $!{EINTR} || $!{EAGAIN}; close $fh; return }
    last if $got == 0;
  }
  my @after = stat($fh);
  close $fh;
  return note($f, 'size') if length($data) > $LIVE_MAX;
  return unless @after && sig(\@after) eq $now->{sig} && length($data) == $now->{st}[7];
  my $again = look($f);
  return unless defined $again->{sig} && $again->{sig} eq $now->{sig};
  $f->{rsig} = $now->{sig};
  $f->{rtime} = $t;
  note($f, '');
  return if defined $f->{sent} && $f->{sent} eq $data;
  $f->{sent} = $data;
  $f->{due} = now_ms() + $IDLE;
  out("F $f->{id} " . length($data) . (length($data) ? ' ' . unpack('H*', $data) : '') . "\n");
}
sub unfollow { my ($f, $why) = @_; close $f->{fh} if $f->{fh}; $f->{fh} = undef; $f->{done} = 1; out("X $f->{id} $why\n") }
sub poll_follow {
  my ($f) = @_;
  $f->{behind} = 0;
  return if $f->{done};
  my $now = look($f);
  if (!$f->{fh}) {
    return note($f, $now->{why}) if defined $now->{why};
    return note($f, 'type') unless S_ISREG($now->{st}[2]);
    my $o = open_file($f);
    return note($f, $o->[1]) unless defined $o->[0];
    if ($o->[1][0] != $now->{st}[0] || $o->[1][1] != $now->{st}[1]) { close $o->[0]; return }
    $f->{fh} = $o->[0];
    $f->{ino} = "$o->[1][0] $o->[1][1]";
    $f->{off} = 0;
    note($f, '');
  }
  return unfollow($f, 'replaced') if defined $now->{why} || "$now->{st}[0] $now->{st}[1]" ne $f->{ino};
  my @st = stat($f->{fh});
  return unfollow($f, 'replaced') unless @st;
  return unfollow($f, 'truncated') if $st[7] < $f->{off};
  for (1 .. $CHUNKS) {
    last unless $st[7] > $f->{off};
    return unfollow($f, 'cap') if $f->{off} >= $FOLLOW_MAX;
    my $want = $st[7] - $f->{off};
    $want = $CHUNK if $want > $CHUNK;
    $want = $FOLLOW_MAX - $f->{off} if $want > $FOLLOW_MAX - $f->{off};
    my $data;
    my $got = sysread($f->{fh}, $data, $want);
    last unless $got;
    out("A $f->{id} $f->{off} $got " . unpack('H*', $data) . "\n");
    $f->{off} += $got;
  }
  # Its poll's lines spent with bytes still to send: polled again at the quick cadence until it has caught up.
  $f->{behind} = 1 if !$f->{done} && $st[7] > $f->{off};
}

# ---- the loop: each file polled on its own cadence, the meters' lines and stdin served between, a beat every second
my @once = grep { !$_->{follow} } @files;
my @follows = grep { $_->{follow} } @files;
my ($quick_due, $follow_due, $beat_due) = (0, 0, $BEAT);
while (1) {
  quit(4, 'its lifetime is spent') if time() >= $end;
  my @pending = grep { !defined $_->{sent} } @once;
  if (@pending && now_ms() >= $quick_due) {
    my %before = map { $_->{id} => look($_) } @pending;
    select(undef, undef, undef, ${WATCH_SETTLE_MS} / 1000);
    chdir('/');
    poll_once($_, $before{$_->{id}}) for @pending;
    chdir('/');
    $quick_due = now_ms() + ${WATCH_WAIT_MS};
  }
  my $now = now_ms();
  my @held = grep { defined $_->{sent} && $now >= $_->{due} } @once;
  if (@held) {
    for my $f (@held) { $f->{due} = $now + $IDLE; poll_once($f, $f->{seen}) }
    chdir('/');
  }
  my @following = grep { !$_->{done} } @follows;
  if (@following && $now >= $follow_due) {
    poll_follow($_) for @following;
    chdir('/');
    $follow_due = now_ms() + ((grep { $_->{behind} } @following) ? ${WATCH_WAIT_MS} : ${FOLLOW_POLL_MS});
  }
  $now = now_ms();
  if ($now >= $beat_due) { out("H\n"); $beat_due = $now + $BEAT }
  # Asleep until the soonest due: the beat, a file not yet sent, a follow file, a sent file's next look.
  my $next = $beat_due;
  $next = $quick_due if $quick_due < $next && grep { !defined $_->{sent} } @once;
  $next = $follow_due if $follow_due < $next && grep { !$_->{done} } @follows;
  for my $f (@once) { $next = $f->{due} if defined $f->{sent} && $f->{due} < $next }
  my $wait = $next - now_ms();
  $wait = 0 if $wait < 0;
  my $rin = '';
  vec($rin, fileno(STDIN), 1) = 1;
  vec($rin, fileno($_->{fh}), 1) = 1 for @kids;
  my $ready = select(my $rout = $rin, undef, undef, $wait / 1000);
  if ($ready > 0) {
    if (vec($rout, fileno(STDIN), 1)) {
      my $got = sysread(STDIN, my $x, 4096);
      quit(0) if defined $got && $got == 0;
      quit(0) if !defined $got && !$!{EINTR} && !$!{EAGAIN};
    }
    for my $k (@kids) {
      next unless vec($rout, fileno($k->{fh}), 1);
      my $got = sysread($k->{fh}, my $x, 4096);
      next if !defined $got && ($!{EINTR} || $!{EAGAIN});
      quit(3, "meter $k->{id} ended") unless $got;
      $k->{buf} .= $x;
      while ($k->{buf} =~ s/\A([^\n]*\n)//) { out($1) }
      quit(3, "meter $k->{id} printed no reading") if length($k->{buf}) > 256;
    }
  }
}
`;

/** One live file the watcher keeps in step: its mount, its host directory and its path under both. */
export interface WatchedFile {
  at: MountPoint;
  host: string;
  path: string;
  follow: boolean;
}

/** One metered mount: meterScript's caps and interval (TreeMeterOptions'), and its readings' sink. */
export interface WatchMeterSpec {
  at: MountPoint;
  intervalMs: number;
  maxEntries: number;
  maxBytes: number;
  maxDepth: number;
  maxPathBytes: number;
  onUsage(usage: TreeUsage): void;
}

/** What to exec into `watch` and what it will say about: its argv, its files (by id) and its meters (by id). */
export interface WatchPlan {
  command: readonly string[];
  files: readonly WatchedFile[];
  meters: readonly WatchMeterSpec[];
}

/** The script's own spec (watchCommand): directories as the script sees them, ids by order. */
export interface WatchScriptSpec {
  /** How long it may run unstopped: it exits by itself past it, rounded up to a second. */
  lifetimeMs: number;
  files: readonly { dir: string; path: string; follow: boolean }[];
  meters: readonly { dir: string; intervalMs: number; maxEntries: number; maxBytes: number; maxDepth: number; maxPathBytes: number }[];
}

/** The largest number the watcher's argv takes (its INT_RE: 15 digits), so a cap plus one is still a safe integer. */
export const WATCH_MAX_ARG = 999_999_999_999_999;

/**
 * The watcher's argv (`perl -e WATCH_SCRIPT -- ...`) for `spec`: each dir an absolute path checkHostPath takes, each
 * path one checkLiveFiles takes, each number a positive integer of at most WATCH_MAX_ARG, depth and path caps at most
 * WATCH_MAX_DEPTH and WATCH_MAX_PATH_BYTES, at least one file or meter. SandboxError otherwise.
 */
export function watchCommand(spec: WatchScriptSpec): string[] {
  if (!Number.isFinite(spec.lifetimeMs) || spec.lifetimeMs <= 0) throw new SandboxError(`watch lifetime ${spec.lifetimeMs} is out of range`);
  if (spec.files.length === 0 && spec.meters.length === 0) throw new SandboxError('a watch needs a live file or a meter');
  const argv = ['perl', '-e', WATCH_SCRIPT, '--', String(WATCH_PROTOCOL), argInt(Math.ceil(spec.lifetimeMs / 1000), 'watch lifetime')];
  for (const f of spec.files) {
    checkHostPath(f.dir);
    checkLiveFiles(f.dir, [{ path: f.path }]);
    argv.push('f', f.dir, f.path, f.follow ? '1' : '0');
  }
  for (const m of spec.meters) {
    checkHostPath(m.dir);
    const nums = [
      argInt(m.intervalMs, 'meter interval'),
      argInt(m.maxEntries, 'meter entry cap'),
      argInt(m.maxBytes, 'meter byte cap'),
      argInt(m.maxDepth, 'meter depth cap'),
      argInt(m.maxPathBytes, 'meter path cap'),
    ];
    if (m.maxDepth > WATCH_MAX_DEPTH) throw new SandboxError(`a watch meter's depth cap must be at most ${WATCH_MAX_DEPTH}`);
    if (m.maxPathBytes > WATCH_MAX_PATH_BYTES) throw new SandboxError(`a watch meter's path cap must be at most ${WATCH_MAX_PATH_BYTES}`);
    argv.push('m', m.dir, ...nums);
  }
  return argv;
}

/**
 * The watch for a pod's `mounts` (checked by mounts.ts checkSandboxMounts already): every writable mount's `live` files,
 * in mount order, and `meters`, each on a writable mount of `mounts` (SandboxError otherwise); null when there is
 * nothing to watch. `lifetimeMs`: how long the watcher may run unstopped (the program's budget and a slack, as a meter's).
 * `dirOf`: where `watch` holds a mount, the directory the watcher reads for it (default its mount point; a one-pod
 * plan's member's mount is at `/m/<member><mount point>` there, k8s.ts podPlanSpec).
 */
export function planWatch(opts: { mounts: readonly SandboxMount[]; meters?: readonly WatchMeterSpec[]; lifetimeMs: number; dirOf?: (mount: SandboxMount) => string }): WatchPlan | null {
  const dirOf = opts.dirOf ?? ((m: SandboxMount): string => m.at);
  const files: WatchedFile[] = [];
  const fileDirs: string[] = [];
  for (const m of opts.mounts) {
    if (m.readOnly || m.live === undefined) continue;
    for (const f of m.live) {
      files.push({ at: m.at, host: checkHostPath(m.host), path: f.path, follow: f.follow === true });
      fileDirs.push(dirOf(m));
    }
  }
  const meters = opts.meters ?? [];
  const meterDirs: string[] = [];
  for (const meter of meters) {
    if (!Object.hasOwn(MOUNT_POINTS, meter.at)) throw new SandboxError(`${JSON.stringify(meter.at)} is not a mount point`);
    const mount = opts.mounts.find((m) => m.at === meter.at && !m.readOnly);
    if (mount === undefined) throw new SandboxError(`no writable mount at ${meter.at} to meter`);
    meterDirs.push(dirOf(mount));
  }
  if (files.length === 0 && meters.length === 0) return null;
  const command = watchCommand({
    lifetimeMs: opts.lifetimeMs,
    files: files.map((f, i) => ({ dir: fileDirs[i]!, path: f.path, follow: f.follow })),
    meters: meters.map((m, i) => ({ dir: meterDirs[i]!, intervalMs: m.intervalMs, maxEntries: m.maxEntries, maxBytes: m.maxBytes, maxDepth: m.maxDepth, maxPathBytes: m.maxPathBytes })),
  });
  return { command, files, meters };
}

export interface LiveWatchOptions {
  /** The watch failed before stop() (the header): called at most once, never after stop(). The driver's failure. */
  onFault(message: string): void;
  /** A live file the watcher would not mirror, or stopped following (its `X` line). */
  onRefused?(file: WatchedFile, why: WatchRefusal): void;
  /** How long it has for its `W` line (default WATCH_START_MS), and may then say nothing (default WATCH_SILENCE_MS). */
  startMs?: number;
  silenceMs?: number;
  /** How long stop() waits for the exec to end before it cuts it (default WATCH_STOP_MS). */
  stopMs?: number;
}

const HELLO_RE = /^W (\d{1,6}) (\d{1,4}) (\d{1,4})$/;
const FILE_RE = /^F (\d{1,4}) (\d{1,9})(?: ((?:[0-9a-f]{2})+))?$/;
const APPEND_RE = /^A (\d{1,4}) (\d{1,15}) (\d{1,9}) ((?:[0-9a-f]{2})+)$/;
const READING_RE = /^R (\d{1,4}) (\d{1,20}) (\d{1,20}) (\d{1,20}) (\d{1,20}) (\d{1,20})$/;
const REFUSED_RE = /^X (\d{1,4}) ([a-z]+)$/;
/** The longest line the watcher prints: an appear-once file at its cap, in hex, and its words. */
const MAX_LINE_CHARS = 2 * LIVE_FILE_MAX_BYTES + 64;

/** A follow file's host side: its descriptor once its first bytes came, and how many have. */
interface Follow {
  fd: number | null;
  offset: number;
  done: boolean;
}

/**
 * The watch exec's host side (the header): it reads `child`'s stdout as the protocol, mirrors the plan's files into
 * their host directories and hands readings to their meters, until stop() or a fault.
 */
export class LiveWatch {
  readonly #child: KubectlChild;
  readonly #plan: WatchPlan;
  readonly #opts: LiveWatchOptions;
  readonly #follows: Follow[];
  readonly #silenceMs: number;
  #partial = '';
  #stderr = '';
  #started = false;
  /** stop() was called, or the fault reported: nothing more is read or reported. */
  #quiet = false;
  #stopping: Promise<void> | null = null;
  /** The start bound until the `W` line, then the silence bound, refreshed by every line. */
  #timer: NodeJS.Timeout;

  constructor(child: KubectlChild, plan: WatchPlan, opts: LiveWatchOptions) {
    this.#child = child;
    this.#plan = plan;
    this.#opts = opts;
    this.#follows = plan.files.map(() => ({ fd: null, offset: 0, done: false }));
    this.#silenceMs = opts.silenceMs ?? WATCH_SILENCE_MS;
    const startMs = opts.startMs ?? WATCH_START_MS;
    this.#timer = setTimeout(() => this.#fault(`the watcher did not start within ${startMs} ms`), startMs);
    this.#timer.unref();
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.stdout.setEncoding('latin1').on('data', (s: string) => this.#push(s));
    child.stderr.setEncoding('utf8').on('data', (s: string) => {
      if (this.#stderr.length < WATCH_STDERR_BYTES) this.#stderr += s.slice(0, WATCH_STDERR_BYTES - this.#stderr.length);
    });
    void child.closed.then((end) => {
      const said = this.#stderr.trim().split('\n')[0] ?? '';
      const how = end.error ?? (end.signal === null ? `code ${end.code}` : `signal ${end.signal}`);
      this.#fault(`the watch exec ended before it was stopped (${how})${said === '' ? '' : `: ${said}`}`);
    });
  }

  /** Stop watching (idempotent): nothing is read or reported once it is called; resolves once the exec has ended. */
  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      this.#quiet = true;
      clearTimeout(this.#timer);
      this.#closeFollows();
      // Its stdin closing is what ends it (the script's loop), even when the exec has not opened yet.
      this.#child.stdin.end();
      if (await settlesWithin(this.#child.closed, this.#opts.stopMs ?? WATCH_STOP_MS)) return;
      this.#child.kill();
      await this.#child.closed;
    })();
    return this.#stopping;
  }

  #fault(message: string): void {
    if (this.#quiet) return;
    this.#quiet = true;
    this.#opts.onFault(message);
    void this.stop();
  }

  #push(s: string): void {
    if (this.#quiet) return;
    const lines = (this.#partial + s).split('\n');
    this.#partial = lines.pop()!;
    if (lines.length > 0 && this.#started) this.#timer.refresh();
    for (const line of lines) {
      let why: string | null;
      try {
        why = this.#line(line);
      } catch (err) {
        // A throw while acting on a line (a host fs call, a meter's sink) is the watch's one fault, never the stdout handler's.
        why = `acting on the watcher's ${quote(line.slice(0, 1))} line failed: ${(err as Error)?.message ?? String(err)}`;
      }
      if (why !== null) {
        this.#fault(why);
        return;
      }
      if (this.#quiet) return;
    }
    if (this.#partial.length > MAX_LINE_CHARS) this.#fault(`the watcher printed ${quote(this.#partial)}, not a protocol line`);
  }

  /** Act on one line: null, or why it is a fault. */
  #line(line: string): string | null {
    const odd = `the watcher printed ${quote(line)}, not a protocol line`;
    if (!this.#started) {
      const m = HELLO_RE.exec(line);
      if (m === null) return odd;
      if (Number(m[1]) !== WATCH_PROTOCOL || Number(m[2]) !== this.#plan.files.length || Number(m[3]) !== this.#plan.meters.length) {
        return `the watcher took ${m[2]} files and ${m[3]} meters on protocol ${m[1]}, not the plan's ${this.#plan.files.length} and ${this.#plan.meters.length} on ${WATCH_PROTOCOL}`;
      }
      this.#started = true;
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.#fault(`the watcher said nothing for ${this.#silenceMs} ms`), this.#silenceMs);
      this.#timer.unref();
      return null;
    }
    switch (line[0]) {
      case 'H':
        return line === 'H' ? null : odd;
      case 'R': {
        const m = READING_RE.exec(line);
        const meter = m === null ? undefined : this.#plan.meters[Number(m[1])];
        if (m === null || meter === undefined) return odd;
        const nums = m.slice(2).map(Number);
        // The script says every figure as a safe integer (bytes past the cap as the cap plus one: the header), so one that
        // is not is a broken watcher, the driver's fault, never a reading past every cap held against the program.
        if (!nums.every(Number.isSafeInteger)) return odd;
        meter.onUsage({ entries: nums[0]!, bytes: nums[1]!, depth: nums[2]!, longPaths: nums[3]!, unread: nums[4]! });
        return null;
      }
      case 'F': {
        const m = FILE_RE.exec(line);
        const file = m === null ? undefined : this.#plan.files[Number(m[1])];
        if (m === null || file === undefined || file.follow) return odd;
        const data = Buffer.from(m[3] ?? '', 'hex');
        if (data.length !== Number(m[2]) || data.length > LIVE_FILE_MAX_BYTES) return odd;
        return this.#writeWhole(file, data);
      }
      case 'A': {
        const m = APPEND_RE.exec(line);
        const id = m === null ? -1 : Number(m[1]);
        const file = this.#plan.files[id];
        const follow = this.#follows[id];
        if (m === null || file === undefined || follow === undefined || !file.follow || follow.done) return odd;
        const data = Buffer.from(m[4]!, 'hex');
        const offset = Number(m[2]);
        if (data.length !== Number(m[3]) || data.length > FOLLOW_CHUNK_BYTES || offset !== follow.offset || offset + data.length > FOLLOW_MAX_BYTES) return odd;
        return this.#append(file, follow, data);
      }
      case 'X': {
        const m = REFUSED_RE.exec(line);
        const id = m === null ? -1 : Number(m[1]);
        const file = this.#plan.files[id];
        const why = m?.[2] as WatchRefusal | undefined;
        if (m === null || file === undefined || why === undefined || !WATCH_REFUSALS.includes(why)) return odd;
        const follow = this.#follows[id]!;
        // The three last words are a follow file's alone, and `size` an appear-once file's; nothing follows a last word.
        const ends = why === 'replaced' || why === 'truncated' || why === 'cap';
        if ((ends && !file.follow) || (why === 'size' && file.follow) || follow.done) return odd;
        if (ends) {
          if (follow.fd !== null) closeSync(follow.fd);
          follow.fd = null;
          follow.done = true;
        }
        this.#opts.onRefused?.(file, why);
        return null;
      }
      default:
        return odd;
    }
  }

  /** Write an appear-once file into its host directory by rename. */
  #writeWhole(file: WatchedFile, data: Buffer): string | null {
    const target = join(file.host, file.path);
    let tmp: string | null = null;
    try {
      const dir = hostDirFor(file);
      tmp = join(dir, `.${basename(file.path)}.watch-${randomBytes(4).toString('hex')}`);
      writeFileSync(tmp, data, { flag: 'wx', mode: 0o644 });
      renameSync(tmp, target);
      tmp = null;
      return null;
    } catch (err) {
      if (tmp !== null) rmSync(tmp, { force: true });
      return `could not mirror ${file.at}/${file.path}: ${(err as Error).message}`;
    }
  }

  /** Append a follow file's next bytes to its host file, made at its first bytes. */
  #append(file: WatchedFile, follow: Follow, data: Buffer): string | null {
    try {
      if (follow.fd === null) {
        hostDirFor(file);
        follow.fd = openSync(join(file.host, file.path), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644);
      }
      let at = 0;
      while (at < data.length) at += writeSync(follow.fd, data, at, data.length - at);
      follow.offset += data.length;
      return null;
    } catch (err) {
      return `could not mirror ${file.at}/${file.path}: ${(err as Error).message}`;
    }
  }

  #closeFollows(): void {
    for (const f of this.#follows) {
      if (f.fd === null) continue;
      try {
        closeSync(f.fd);
      } catch {
        // Closed already: nothing held.
      }
      f.fd = null;
    }
  }
}

/** The directory a file's host copy goes in, made if missing: every component under the mount's host directory a directory, never a link. */
function hostDirFor(file: WatchedFile): string {
  let dir = file.host;
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new SandboxError(`${dir} is not a directory`);
  const parts = dirname(file.path) === '.' ? [] : dirname(file.path).split('/');
  for (const p of parts) {
    dir = join(dir, p);
    const at = lstatSync(dir, { throwIfNoEntry: false });
    if (at === undefined) mkdirSync(dir, { mode: 0o755 });
    else if (!at.isDirectory()) throw new SandboxError(`${dir} is not a directory`);
  }
  return dir;
}

/** `n` as its decimal digits, when a positive safe integer (docker.ts positiveInt's rule; this file imports no driver, so a driver can import it). */
function positiveInt(n: number, what: string): string {
  if (!Number.isSafeInteger(n) || n <= 0) throw new SandboxError(`${what} ${n} must be a positive integer`);
  return String(n);
}

/** A number of the watcher's argv: positiveInt's, and at most WATCH_MAX_ARG (the script refuses a longer one at its start). */
function argInt(n: number, what: string): string {
  const s = positiveInt(n, what);
  if (n > WATCH_MAX_ARG) throw new SandboxError(`${what} ${n} must be a positive integer of at most ${WATCH_MAX_ARG}`);
  return s;
}

/** Whether `p` settles within `ms` (docker.ts settlesWithin's twin). */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

function quote(s: string): string {
  return JSON.stringify(s.slice(0, 80));
}

/**
 * The grace a directory a meter cannot read gets (the root's amendment to D5b), fed every reading of one meter in
 * order: true once `unread` has been above 0 in `readings` consecutive readings, ceil(UNREAD_GRACE_MS / intervalMs) of
 * them (four at the 500 ms cadence), so a directory has stayed unreadable for the grace; any reading with `unread` 0 or
 * absent (docker.ts's root meter reads everything) starts the count again. A reading whose directory is readable counts
 * its entries against the caps as ever: that is the caller's own check.
 */
export class UnreadGrace {
  readonly readings: number;
  #streak = 0;

  constructor(intervalMs: number) {
    this.readings = Math.ceil(UNREAD_GRACE_MS / Number(positiveInt(intervalMs, 'meter interval')));
  }

  /** Feed the next reading: whether a directory has now stayed unreadable for the grace. */
  breach(usage: TreeUsage): boolean {
    this.#streak = (usage.unread ?? 0) > 0 ? this.#streak + 1 : 0;
    return this.#streak >= this.readings;
  }
}
