#!/bin/sh
# The house patch agent's workspace (agent/patch-agent/workspace.ts drives it): the one long-lived
# container of a witness trial, in the competition's repository image (image argv `/bin/sh
# /bot/shell.sh`; the process driver runs it under the host's sh instead), its /work the
# repository for the whole trial.
#
# At start it copies /base (the sealed upstream tree) into /work, overlays /tests/overlay (the dev
# tree's tests) and commits that under the house identity as the base, then answers one frame whose
# stdout is the base commit. Then one request line at a time on stdin, until EOF:
#   run <timeout_sec> <cap_bytes> <base64 command>  the command under bash (sh where the image has
#                                                   none) in /work, its stdin /dev/null, killed at
#                                                   timeout_sec
#   stage <cap_bytes>                               git add -A, then the paths changed since the
#                                                   base, NUL-separated (no renames)
#   drop <base64 path>                              the path's index entry back to the base's
#   diff <cap_bytes>                                the staged diff from the base
# each answered by one frame on stdout:
#   frame <exit> <stdout_len> <stdout_total> <stderr_len> <stderr_total>\n<stdout><stderr>
# each stream cut to its first cap_bytes, *_total its whole size. Nothing else reaches stdout:
# whatever runs writes to files under /work/.makefun, which git never sees (info/exclude) and
# grader/patch/diff.ts refuses in a patch. A request it cannot read ends it (exit 2), stderr saying
# why.
#
# The image provides sh, cp, git, base64, head and wc. GNU coreutils' timeout, where the image has it,
# ends a command's whole process group at its timeout; elsewhere a watchdog kills the command alone.
set -u
umask 022

WORK=${MAKEFUN_WORK_DIR:-/work}
BASE=${MAKEFUN_BASE_DIR:-/base}
TESTS=${MAKEFUN_TESTS_DIR:-/tests}
HOUSE=$WORK/.makefun
S=$HOUSE/shell

# The process driver passes no PATH (grader/sandbox/types.ts SANDBOX_ENV); an image keeps its own.
PATH=${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
HOME=$HOUSE/home
TMPDIR=$HOUSE/tmp
GIT_CONFIG_NOSYSTEM=1
GIT_TERMINAL_PROMPT=0
GIT_PAGER=cat
PAGER=cat
export PATH HOME TMPDIR GIT_CONFIG_NOSYSTEM GIT_TERMINAL_PROMPT GIT_PAGER PAGER

# The base commit's identity and date: the same tree commits to the same sha on every trial.
HOUSE_NAME='make.fun house'
HOUSE_EMAIL=house@make-fun.invalid
HOUSE_DATE='2000-01-01T00:00:00+0000'

fault() {
  printf 'shell.sh: %s\n' "$1" >&2
  exit 2
}

num() {
  case $1 in
  '' | *[!0-9]*) fault "expected a number of seconds or bytes, not '$1'" ;;
  esac
}

# The answer to one request, from $S/out and $S/err; $1 the exit code, $2 the cap on each stream.
frame() {
  head -c "$2" "$S/out" >"$S/out.cut"
  head -c "$2" "$S/err" >"$S/err.cut"
  printf 'frame %s %s %s %s %s\n' "$1" $(($(wc -c <"$S/out.cut"))) $(($(wc -c <"$S/out"))) $(($(wc -c <"$S/err.cut"))) $(($(wc -c <"$S/err")))
  cat "$S/out.cut" "$S/err.cut"
}

# Fresh files every time: a background process a command left behind keeps writing to the old ones.
fresh() {
  rm -f "$S/out" "$S/err" "$S/out.cut" "$S/err.cut"
}

setup() {
  cp -RP "$BASE/." "$WORK/" || return 1
  # The sealed base materializes read-only: make the copy writable before the overlay lands in its directories.
  chmod -R u+w "$WORK" || return 1
  if [ -d "$TESTS/overlay" ]; then
    cp -RP "$TESTS/overlay/." "$WORK/" || return 1
  fi
  chmod -R u+w "$WORK" || return 1
  printf '[user]\n\tname = %s\n\temail = %s\n[safe]\n\tdirectory = *\n\tdirectory = %s\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n' \
    "$HOUSE_NAME" "$HOUSE_EMAIL" "$WORK" >"$HOME/.gitconfig" || return 1
  cd "$WORK" || return 1
  git -c init.defaultBranch=main init -q || return 1
  mkdir -p .git/info || return 1
  printf '/.makefun/\n' >>.git/info/exclude || return 1
  git add -A || return 1
  GIT_AUTHOR_NAME=$HOUSE_NAME GIT_AUTHOR_EMAIL=$HOUSE_EMAIL GIT_AUTHOR_DATE=$HOUSE_DATE \
    GIT_COMMITTER_NAME=$HOUSE_NAME GIT_COMMITTER_EMAIL=$HOUSE_EMAIL GIT_COMMITTER_DATE=$HOUSE_DATE \
    git commit -q --no-verify --allow-empty -m base || return 1
  git rev-parse HEAD
}

if command -v bash >/dev/null 2>&1; then RUN_SH=bash; else RUN_SH=sh; fi
case $(timeout --version 2>/dev/null) in
*coreutils*) TIMEOUT=timeout ;;
*) TIMEOUT= ;;
esac

# $1 the timeout in seconds; the command is $S/cmd.
run_cmd() {
  fresh
  if [ -n "$TIMEOUT" ]; then
    (cd "$WORK" && exec "$TIMEOUT" -k 5 "$1" "$RUN_SH" "$S/cmd") </dev/null >"$S/out" 2>"$S/err"
    return
  fi
  (cd "$WORK" && exec "$RUN_SH" "$S/cmd") </dev/null >"$S/out" 2>"$S/err" &
  pid=$!
  (sleep "$1" && kill -KILL "$pid") </dev/null >/dev/null 2>&1 &
  dog=$!
  wait "$pid" 2>/dev/null
  code=$?
  kill -KILL "$dog" 2>/dev/null
  wait "$dog" 2>/dev/null
  return "$code"
}

stage() {
  cd "$WORK" && git add -A && git diff --cached --name-only -z --no-renames "$BASE_SHA" --
}

# $S/path holds the path, its bytes as they are (a trailing newline included).
drop() {
  p=$(cat "$S/path" && printf x) || return 1
  cd "$WORK" && GIT_LITERAL_PATHSPECS=1 git reset -q "$BASE_SHA" -- "${p%x}"
}

diff_base() {
  cd "$WORK" && git -c core.quotePath=true -c diff.noprefix=false -c diff.mnemonicPrefix=false \
    diff --cached --no-color --no-ext-diff --no-textconv --no-renames --src-prefix=a/ --dst-prefix=b/ "$BASE_SHA" --
}

mkdir -p "$S" "$HOME" "$TMPDIR" || fault "cannot make $HOUSE"
fresh
setup </dev/null >"$S/out" 2>"$S/err"
code=$?
frame "$code" 16384
[ "$code" -eq 0 ] || exit 1
BASE_SHA=$(cat "$S/out")

while IFS=' ' read -r op a b c; do
  case $op in
  run)
    num "$a"
    num "$b"
    printf '%s\n' "$c" | base64 -d >"$S/cmd" 2>/dev/null || fault 'run: the command is not base64'
    run_cmd "$a"
    frame $? "$b"
    ;;
  stage)
    num "$a"
    fresh
    stage </dev/null >"$S/out" 2>"$S/err"
    frame $? "$a"
    ;;
  drop)
    printf '%s\n' "$a" | base64 -d >"$S/path" 2>/dev/null || fault 'drop: the path is not base64'
    fresh
    drop </dev/null >"$S/out" 2>"$S/err"
    frame $? 16384
    ;;
  diff)
    num "$a"
    fresh
    diff_base </dev/null >"$S/out" 2>"$S/err"
    frame $? "$a"
    ;;
  *) fault "unknown request '$op'" ;;
  esac
done
