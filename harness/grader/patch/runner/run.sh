#!/bin/sh
# The house runner of a patch/v1 run (grader/patch/execute.ts executePatch): POSIX sh, run by the
# repository's own test image (`/bin/sh /bot/run.sh`) as the sandbox user, with no network. The
# image provides sh, cp, git, mkdir, chmod, rm, wc and head; nothing else is assumed.
#
#   /bot     this script and test.sh (execute.ts writes it: the test argv as makefun_test, the
#            report path and the caps), and with a patch patch.numstat and patch.numstat-R (what
#            git apply --numstat -z must print of it, forward and with -R: diff.ts patchNumstat),
#            all read-only
#   /base    the sealed upstream tree (repo.base_tree_sha256), read-only
#   /tests   the phase tree's overlay/ alone (an empty directory when it holds none), read-only:
#            never its lists.json nor salt, which the code under test must not read (execute.ts)
#   /input   patch.diff alone, or nothing (the base as sealed: the pack check's base run)
#   /work    an empty tmpfs (work_mb), where the tests run
#
# Under the process driver each of those is the directory its MAKEFUN_*_DIR variable names (and
# PATH may be unset), so every path below is read from the environment first.
#
#   1. cp -RP /base/. /work/, made writable; the house's own HOME, TMPDIR and scratch under
#      /work/.makefun/ (a segment no patch may touch: diff.ts)
#   2. /input/patch.diff, when there is one: `git apply --numstat -z`, forward and with -R, must
#      print patch.numstat and patch.numstat-R byte for byte (git reads the paths in it that
#      diff.ts read, a rename's both), else it is refused unapplied (apply unsafe); then
#      `git apply --check`, then `git apply` (-p1, --whitespace=nowarn, never --unsafe-paths);
#      refused, nothing else runs
#   3. cp -RP /tests/. /work/: the overlay lands after the patch, so the ratified tests are
#      always the pack's bytes; failing, no test runs (every status M)
#   4. whatever the trees hold at the report path removed, then the test argv in /work, stdin
#      /dev/null, stdout and stderr to the house's test.log; its exit code kept, and whether it ended
#      by a signal: POSIX sh reports a command a signal ended as a status above 128 (128 + the
#      signal's number), and that is the one test this shell can make, so a status above 128 reads
#      as signal (status - 128), never as an exit the tests chose. Only a report the run itself
#      wrote is read, and the grade holds the exit against it (score.ts patchExitCheck)
#   5. one frame on stdout (execute.ts readFrame), written only once the tests have exited:
#
#        makefun-patch-run/v1
#        apply none|ok|failed|unsafe
#        overlay none|ok|failed
#        exit <code>|none
#        signal <n>|none      n when the code is 128 + n (n > 0); none when not, or no test ran
#        report <n>|none      then n bytes of the report (at most makefun_report_max) and a newline;
#                             none when no test ran
#        apply_log <n>|none   git apply's own stderr (at most makefun_apply_log_max), likewise
#        log <n>|none         test.log (at most makefun_log_max), likewise
#        end
#
# No host directory is mounted writable (no /output): what the code under test writes stays in the
# container, and what reaches the grader is the frame, capped by its Supervisor. This script's stderr carries
# only its own lines; the tests' output never reaches it. Exit 0 with the frame; exit 3 when the
# house's own setup failed before the patch was looked at (a fault never blamed on the entry).

set -u
umask 022
PATH=${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
export PATH

bot=${0%/*}
base=${MAKEFUN_BASE_DIR:-/base}
tests=${MAKEFUN_TESTS_DIR:-/tests}
input=${MAKEFUN_INPUT_DIR:-/input}
work=${MAKEFUN_WORK_DIR:-/work}
house=$work/.makefun

say() {
  printf 'run.sh: %s\n' "$*" >&2
}

setup_failed() {
  say "$*"
  exit 3
}

# Every entry under $1 writable by its owner, never following a link: $1 itself is left as it is
# (/work's tmpfs root is not the sandbox user's), and a symlink needs no mode.
writable() {
  for f in "$1"/* "$1"/.*; do
    case ${f##*/} in
      . | ..) continue ;;
    esac
    if [ -L "$f" ] || [ ! -e "$f" ]; then continue; fi
    chmod -R u+w "$f" || return 1
  done
}

# `<name> <n>`, then n bytes of file $2 (at most $3) and a newline; `<name> none` when there is no
# such regular file.
emit() {
  if [ -f "$2" ]; then
    n=$(wc -c <"$2") || return 1
    n=$(($n))
    if [ "$n" -gt "$3" ]; then n=$3; fi
    printf '%s %s\n' "$1" "$n" || return 1
    # (BSD head refuses -c 0.)
    if [ "$n" -gt 0 ]; then head -c "$n" "$2" || return 1; fi
    printf '\n'
  else
    printf '%s none\n' "$1"
  fi
}

[ -r "$bot/test.sh" ] || setup_failed "$bot/test.sh is not readable"
makefun_report=
makefun_report_max=
makefun_apply_log_max=
makefun_log_max=
. "$bot/test.sh"
[ -n "$makefun_report" ] && [ -n "$makefun_report_max" ] && [ -n "$makefun_apply_log_max" ] && [ -n "$makefun_log_max" ] ||
  setup_failed "$bot/test.sh does not set the report path and the caps"

# 1. The base, writable; the house's directories.
[ -d "$base" ] || setup_failed "the base tree $base is not a directory"
[ -d "$tests" ] || setup_failed "the overlay $tests is not a directory"
[ -d "$work" ] || setup_failed "the work tree $work is not a directory"
cp -RP "$base/." "$work/" || setup_failed 'the base tree did not copy into the work tree'
writable "$work" || setup_failed 'the work tree could not be made writable'
if [ -e "$house" ] || [ -L "$house" ]; then setup_failed 'the base tree holds .makefun'; fi
mkdir "$house" "$house/home" "$house/tmp" "$house/run" || setup_failed "$house could not be made"
HOME=$house/home
TMPDIR=$house/tmp
export HOME TMPDIR
cd "$work" || setup_failed "cannot enter $work"

# git reads no configuration but its defaults, and finds no repository above the work tree.
house_git() {
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CEILING_DIRECTORIES=${work%/*} git "$@"
}

apply_patch() {
  house_git apply "$@" -p1 --whitespace=nowarn "$input/patch.diff"
}

# Whether files $1 and $2 hold the same bytes, by git's blob id of each (the image has no cmp); the run
# fails when git cannot read one.
same_bytes() {
  a=$(house_git hash-object --no-filters -- "$1" 2>/dev/null) && b=$(house_git hash-object --no-filters -- "$2" 2>/dev/null) || {
    say "git hash-object could not read $1 or $2"
    exit 1
  }
  [ "$a" = "$b" ]
}

# 2. The patch: git must read in it the paths diff.ts read, before anything is applied. A numstat run
# git refuses is the apply's failure, its stderr the apply log; --check starts the log afresh.
apply=none
if [ -e "$input/patch.diff" ] || [ -L "$input/patch.diff" ]; then
  [ -r "$bot/patch.numstat" ] && [ -r "$bot/patch.numstat-R" ] || setup_failed "$bot/patch.numstat or $bot/patch.numstat-R is not readable"
  if ! apply_patch --numstat -z >"$house/run/numstat" 2>"$house/run/apply.log" ||
    ! apply_patch -R --numstat -z >"$house/run/numstat-R" 2>>"$house/run/apply.log"; then
    apply=failed
  elif ! same_bytes "$house/run/numstat" "$bot/patch.numstat" || ! same_bytes "$house/run/numstat-R" "$bot/patch.numstat-R"; then
    apply=unsafe
  elif apply_patch --check 2>"$house/run/apply.log" && apply_patch 2>>"$house/run/apply.log"; then
    apply=ok
  else
    apply=failed
  fi
fi

# 3. The overlay; 4. the tests.
overlay=none
code=none
signal=none
if [ "$apply" = none ] || [ "$apply" = ok ]; then
  if cp -RP "$tests/." "$work/" 2>"$house/run/overlay.log" && writable "$work" 2>>"$house/run/overlay.log"; then
    overlay=ok
  else
    overlay=failed
  fi
  if [ "$overlay" != failed ]; then
    if rm -rf "$work/$makefun_report" 2>"$house/run/report.log"; then
      (makefun_test) </dev/null >"$house/run/test.log" 2>&1
      code=$?
      if [ "$code" -gt 128 ]; then signal=$((code - 128)); fi
    fi
  fi
fi

# 5. The frame.
{
  printf 'makefun-patch-run/v1\napply %s\noverlay %s\nexit %s\nsignal %s\n' "$apply" "$overlay" "$code" "$signal" &&
    if [ "$code" = none ]; then printf 'report none\n'; else emit report "$work/$makefun_report" "$makefun_report_max"; fi &&
    emit apply_log "$house/run/apply.log" "$makefun_apply_log_max" &&
    emit log "$house/run/test.log" "$makefun_log_max" &&
    printf 'end\n'
} || {
  say 'the frame could not be written'
  exit 1
}
exit 0
