// A case session's pod (types.ts's header: sessions; grader/program.ts executePerCase): the cases of one per-file
// program/v1 execution run one after another in ONE sandbox pod, each by its own exec into `main`, where a sandbox pod
// each ran them before. This file is the session's pure pieces: the pod (sessionPodSpec), `main`'s PID 1
// (SESSION_PID1_COMMAND: the shim as the session reaper), the per-case namespace launcher (CASE_LAUNCHER_SCRIPT) and the exec wrapper around it
// (SESSION_EXEC_WRAPPER), the reset between two cases (SESSION_RESET_SCRIPT) and the restage of each case's read-only
// mounts (restageCommand), and what drives them (K8sSession, the session runtime: K8sSandbox.sessions.open with
// K8sSandboxOptions.caseSessions true), over what grader/sandbox/k8s.ts exports (k8s-lanes.ts's precedent; k8s.ts's
// header: Case sessions). k8s.ts imports K8sSession from here and this file imports k8s.ts, so nothing at this file's top
// level reads a value of k8s.ts's (k8s-network.ts's cycle, the same): SESSION_EXEC_WRAPPER and SESSION_REPORT_TAG are
// defined there, beside SentinelScanner, which reads the report, and re-exported here.
//
// What a session makes, per execution (K8sSession; each run a K8sProcess in its session mode, k8s.ts Launch.session):
//
//   once, at the first spawn (bootPod, as a program pod's boot: k8s.ts's header, Secret first and Fast boot; or, with the
//   sandbox's warm pool, a booted session pod of the session's shape taken from it, k8s.ts's header: Warm pool, and
//   everything below from the staging on run on that pod: K8sSession #boot):
//   POST /api/v1/namespaces/<ns>/secrets, then POST /api/v1/namespaces/<ns>/pods   its env Secret (the agents' K
//                                                      alone), then the session pod (sessionPodSpec), in-process over
//                                                      this pod's token (k8s.ts createPodObjects; outside a pod ONE
//                                                      `kubectl create -f -` List of the two)
//   PATCH /api/v1/namespaces/<ns>/secrets/<pod>-env        the pod made the Secret's owner, off the critical path
//                                                      (`kubectl patch` outside a pod)
//   the pod's IP from its watch; its `stage` agent dialled, and over that session:
//     exec stage: /bin/sh -c <STAGE_EXEC_SCRIPT> sh 1 perl -e <unpacker> -- /bot
//                                                      (`stage` installs the shim's binary into agent-bin before it serves)
//   the Ready wait; its `watch` agent dialled, that session kept for the pod's life; the shim gate: `watch`'s /v1/health
//   lists `main`, whose shim has linked (k8s.ts awaitShims), before anything is exec'd into `main`
//   over the `watch` session: exec main: /bin/sh -c <SESSION_EXEC_WRAPPER> sh <pids> perl -e <launcher> -- 65534 65534 perl -e <loopback probe>
//                                                      the launcher check, relayed by `watch` to `main`'s shim, nonce on
//                                                      stdin: exactly the start line, `RS<nonce>iok` and the sentinel 0
//                                                      (the probe carried a byte over 127.0.0.1 inside the case's own
//                                                      network namespace), or the session degrades (below)
//   per case, its spawn:
//   over the `watch` session: exec main: perl -e <SESSION_RESET_SCRIPT> -- <writable mount points...>
//                                                      the reset, relayed to `main`'s shim, nonce on stdin, but before a
//                                                      pod's first case
//   over the `watch` session: exec watch: perl -e <SESSION_RESTAGE_SCRIPT> -- <n> /restage/input ... <unpacker...>
//                                                      the restage of its read-only mounts (stageStream into `watch`)
//   over the `watch` session: exec watch: perl -e <WATCH_SCRIPT> ...   its meters, beside the next one
//   over the `watch` session: exec main: /bin/sh -c <SESSION_EXEC_WRAPPER> sh <pids> perl -e <launcher> -- 65534 65534 <program...>
//                                                      the case's exec, K8sProcess's in its session mode (k8s.ts #member:
//                                                      agentMember on SessionPrepared.watch, relayed to `main`'s shim, as
//                                                      every run's), the case's secrets after the nonce on stdin's first
//                                                      line (k8s.ts's header, Exec env), never in the pod or its Secret
//   over the `watch` session: exec watch: perl -e <packer> -- /output <caps...>   the collect of its writable mounts
//   once, at close() (or when the pod is spent):
//   kubectl -n <ns> delete pod/<pod> secret/<pod>-env --ignore-not-found --grace-period=1 --wait=false
//                                                      then its `watch` session closed
//
// What the cases share: the pod (its node, its image and digest, its limits and environment, one env Secret: the agents'
// K), the template's secrets (each case's exec carries them),
// /bot staged once, the shim as `main`'s PID 1 (the session reaper) and `watch`. What each gets fresh: its /input restaged from its own
// host directory (emptied first, so nothing of an earlier case's is there), its /output, /tmp and /dev/shm emptied by the
// reset (and its /output's host directory empty, or the spawn is refused: `watch` mounts /output read-only, so no seed
// file of the host's could reach `main`), no process of an earlier case's (the reset's kill, then its verify), its own
// user, IPC and network namespaces (the case launcher: so its own loopback, with no earlier case's port in TIME_WAIT
// and no earlier case's abstract unix socket), and an empty /dev/termination-log (the reset's). A run's `started` and
// `finished` are its exec's start line and sentinel, as a program pod's: the reset and the restage are before
// `started`, no case's wall time.
//
// A spent pod: its run's pod ended it (podKill `memory`, `volume` or `pid1`), the run's end was the driver's failure,
// or a kill that failed left its program possibly running; the reset says dirty or is cut off; a reset or restage exec
// finds `main` ended by its own program or the pod out of memory (k8s.ts readPodVerdict). The spent pod is deleted and a
// fresh one booted, for the case whose reset or restage found it so (that case then runs in the new pod, its first, no
// reset) or for the next spawn; the run that spent it ends as it ended, the program's and never a void it could force.
// Any other failure of the create, the staging, the reset or the restage is that run's K8S_DRIVER_FAILURE (the pod
// spent with it), as a staging failure is a program pod's; no room on the node is the run's noRoom (k8s.ts noRoomOf), so
// grader/run.ts throws a NodeRoomError and the job is handed back. A launcher check that fails (the launcher cannot run,
// or the loopback probe it runs finds no working 127.0.0.1 in the case's network namespace) degrades the session: the
// case the pod was booted for runs there alone under EXEC_WRAPPER (a fresh pod, nothing before it), the pod is deleted
// once it has ended, and every later spawn is the sandbox's own program pod; it is said once on the driver's warning
// channel (ctx.warn). One run at a time: a spawn while a run is live, a spec checkSessionRun refuses, a writable mount's
// host directory that is not empty, or a spawn after close() is a SandboxError before anything starts. kill() of a run is
// a program pod's (`kill -KILL -1` in `main`, the collect) but keeps the pod. close() kills a live run, deletes the
// pod once, and never throws.
//
// The pod (sessionPodSpec) is sandboxPodSpec's split program pod for the session's template (types.ts
// checkSessionTemplate: a plain program's spec, no network, launcher, race, image or work; never timed, so a timing
// heat's runs stay a pod each), a shim pod as every program pod the driver makes (k8s.ts's header, The pod: `stage`
// installs the agent's binary into agent-bin, `main` holds it read-only at AGENT_BIN_DIR, `watch` takes `main`'s shim
// link, MAKEFUN_AGENT_CONTAINERS=main, with SHIM_MEMORY_MI more memory), every field of it kept but three:
//
//   `main`'s command        SESSION_PID1_COMMAND: the shim (k8s.ts shimCommand(main)) with `--session-reaper`, in
//                           place of a program pod's plain shim. The wrapper's `kill -KILL -1` ends what a case left,
//                           and each killed orphan is reparented to PID 1, which reaps it: RLIMIT_NPROC counts a uid's
//                           zombies too (deploy/k8s/README.md, Measured: two containers in one gVisor pod, rows a2 and
//                           d), so unreaped they would start the next case's `ulimit -u` short of what a fresh pod gives.
//                           Every shim reaps every child on SIGCHLD; `--session-reaper` takes what the perl reaper it
//                           replaces (release 1's `main`) did besides: a reap once a second as well, and
//                           every catchable signal that would end it (HUP INT QUIT TERM USR1 USR2 ALRM) caught and
//                           ignored (sandbox-agent/src/shim.rs), so no case ends `main` by one. It is one task, as the
//                           perl was (the wrapper's cap counts PID 1 as one: POD_OWN_TASKS), forks nothing, holds no
//                           key, and is not dumpable (PR_SET_DUMPABLE 0). gVisor lets a program signal its container's
//                           PID 1: a case that kills it (`kill -KILL 1`, 137) ends `main`, the case's own crash
//                           (mainKilledFromWithin) and a spent pod, as with a program pod's shim; `kill -TERM 1`, which
//                           the perl took as its exit 0, is ignored now. So the delete that ends a spent or closed
//                           session pod ends `main` with the pod (its link's end, or the kubelet's KILL after the
//                           delete's grace), never Completed: nothing reads a deleted session pod.
//                           Its command line is SESSION_PID1_CMDLINE exactly, which is how the reset knows it is in a
//                           session pod (below)
//   `stage`                 stages /bot alone (and installs the shim's binary, as in every shim pod): the code is the
//                           session's, one tree for every case (checkSessionRun holds the code directory the template's).
//                           Its read-only mounts (/input) are restaged per case through `watch`; its writable ones
//                           (/output) start empty, as the kubelet makes them, and the reset empties them again between
//                           two cases
//   `watch`                 the pod's agent (k8s.ts watchContainer: `makefun-agent serve`, taking `main`'s shim link),
//                           each writable mount read-only at its mount point, as in every pod with one (the collect, the
//                           meter and the live files read them there), plus each read-only mount's volume READ-WRITE at a
//                           path of its own, restageMountPath (`/restage/input`). Every session pod has it, whatever its
//                           mounts (a shim pod's), so a template with none has a `watch` that mounts nothing
//
// Labels, annotations and everything else are a program pod's (makefun.grader=1, makefun.io/role=sandbox,
// makefun.io/sandbox=program, the creator annotation when the process names its pod), so reapOrphans takes a dead
// grader's session pod as it takes its program pods, and the stale sweep and activeDeadlineSeconds stay its backstops.
//
// Why `watch` may write /input here. In a program pod nothing that holds an input read-write is alive while the program
// runs: `stage` holds them and is gone before `main` exists. A session's cases each need their own /input, and the pod
// outlives them, so something must write it between two cases; `watch` is that one container. It is the house's (the
// grader's uid, WATCH_UID, the same as STAGE_UID, so a restaged file shows the owner and modes a staged one does), no
// program of the entrant's is ever exec'd into it, and it writes only by the restage exec, which runs between two cases:
// after the reset found the previous case's processes all dead (and its /output collected and wiped), before the next
// case's exec starts. `main` mounts the same volume read-only, so no case can write its input, and its restaged path is
// outside every mount `main` has, so none can reach it there. What `watch` writes is what the next case's own host
// directory holds, nothing more: a case never sees an earlier case's input, nor a later one's.
//
// Each case runs under the case launcher (CASE_LAUNCHER_SCRIPT, by SESSION_EXEC_WRAPPER): perl, as perl-base is in both
// pinned images, which unshares a user, an IPC and a network namespace of the case's own (one unshare call,
// CLONE_NEWUSER|CLONE_NEWIPC|CLONE_NEWNET, by raw syscall per machine as the CPU launcher's are), denies setgroups, maps
// 65534 to 65534 and nothing else in uid_map and gid_map, brings the new network namespace's `lo` up (one rtnetlink
// RTM_NEWLINK, `ip link set lo up`: CASE_LAUNCHER_LO_LIB), reports `ok` on descriptor 4 (close-on-exec), then execs the
// program in its own place. The program's uid is 65534 inside and out (its files are 65534's to every container), and
// exec drops every capability the new namespace gave the launcher, since its uid there is not 0 (probe K3 is what
// measures it: CapEff and CapPrm 0 after the exec). What it closes: SysV shared memory, semaphores and message queues,
// POSIX message queues and keyrings outlive the process that made them in the pod-wide IPC namespace (research #30), and
// none can be erased by a sweep (mqueues are not enumerable, keyrings have no erase); made in the case's own IPC
// namespace, they go with it. And the network: a loopback TCP connection's TIME_WAIT holds its port for about 60 s
// after the close in the pod's network namespace (probe K7: a bind without SO_REUSEADDR refused until +61 s), and gVisor
// lists no TIME_WAIT in /proc/net/tcp, so no reset could wait it out; abstract unix sockets are per network namespace
// too. The case's own network namespace has its own `lo`, with no earlier case's port held or socket bound, and it
// takes nothing a case may use: a session's template has no network (checkSessionTemplate), so the pod's interface
// reaches nothing a case is given, its DNS 127.0.0.1. That `lo` comes up only when the launcher brings it up: a Linux
// kernel, and gVisor from release-20261109.0, make a new network namespace's `lo` DOWN with no address (every bind to
// 127.0.0.1 there EADDRNOTAVAIL, "Cannot assign requested address"); gVisor up to release-20261102.0 made it up with
// 127.0.0.1 and ::1 (deploy/k8s/README.md K7b). Its own failure (no unshare, no maps, no `lo`, no descriptor 4) is its
// words on stderr, nothing on descriptor 4 and exit 125, and the wrapper then prints no report: a sentinel with no `ok`
// report is the driver's failure, never the case's, and where the launcher cannot run (a cluster that refuses any of
// the three namespaces, or an `lo` it cannot bring up) the session gives every run a pod of its own instead (the
// session runtime's launcher check), never cases in one pod without it. The same check runs the loopback probe
// (CASE_LOOPBACK_PROBE: a listener on 127.0.0.1, a connection to it, a byte across) as its case: a runtime whose new
// network namespace's `lo` stays down, or carries no 127.0.0.1, would give each case no loopback at all, so a probe
// that fails there degrades the session the same way.
//
// SESSION_EXEC_WRAPPER is TIMED_EXEC_WRAPPER's shape: EXEC_WRAPPER up to the start line, then the launcher in a command
// substitution holding descriptor 4 (its stdout and stderr the real ones), `kill -KILL -1` once it has ended, then the
// launcher's report as `RS<nonce>i<word>\n` (`RSi` and a word of lower-case letters: `ok`) before the sentinel. The
// program, 65534 in a namespace of its own, can read neither the wrapper's nonce nor descriptor 4 (closed at its exec),
// so it cannot forge the report. The wrapper's process cap is a fresh pod's: PID 1 (the shim, one task) and the
// wrapper, POD_OWN_TASKS, the launcher being the program's own task until it execs. It claims its case's exec first, as
// every wrapper does (k8s.ts's header: the once-guard, EXEC_CLAIM_LINES), so a case's try that opens late beside the
// try run again never runs the case twice; the claim is 65534's, in /tmp, so the reset before the next case wipes it
// with the rest of /tmp (the case it guarded is over by then: the reset kills every process first).
//
// The reset (SESSION_RESET_SCRIPT, by sessionResetArgv: `perl -e <reset> -- <writable mount point>...`, exec'd into
// `main` over the pod's `watch` session, which relays it to `main`'s shim, so it runs as 65534, `main`'s user, with
// the nonce on stdin's first line, the exec's only process) runs before every case but a pod's first, and forks nothing. Its steps, in order, each named in the script so a channel found later is one more step:
//
//   1. refuse        unless /proc/1/cmdline is SESSION_PID1_CMDLINE (the shim as the session reaper: a program pod's
//                    plain shim is refused too) and PID 1 is 65534's, and the reset itself runs
//                    as 65534 (never as root): so it can never kill on a host, where kill(-1) would end every process
//                    of the user running it. A refusal is `dirty refused: ...`, nothing killed
//   2. kill          kill(-1, SIGKILL) by raw syscall, then /proc read again, in rounds (SESSION_RESET_ROUNDS,
//                    SESSION_RESET_PAUSE_MS apart) until no process but PID 1 and the reset is left, live or zombie:
//                    under gVisor kill(-1) races fork (research #30), so one kill may leave a child a storm forked
//                    meanwhile, and the shim reaps each zombie as its SIGCHLD comes (once a second besides)
//   3. wipe          every entry 65534 owns under the writable mount points, /tmp and /dev/shm (SESSION_SHARED_ROOTS:
//                    pod-shared, mode 1777) is removed, a directory given u+rwx first, emptied, then removed. The walk
//                    goes by chdir and never follows a link, so a tree nested past PATH_MAX is still removed. Another
//                    uid's entry is never removed: it is named (and gone into for 65534's entries where it may be)
//   4. termination-log  /dev/termination-log (SESSION_TERMINATION_LOG, the kubelet's terminationMessagePath for
//                    `main`) truncated to 0 bytes, opened write-only with O_TRUNC and never created: probe K1 found it
//                    the one file outside /output, /tmp and /dev/shm that 65534 may write, and it outlives every exec,
//                    so a case could leave the next one a message there. Not there is nothing to carry
//   5. verify        no process but PID 1 and the reset, no zombie, nothing of 65534's left under those directories,
//                    nor any entry of another uid's (none is ever there in a session pod: a surprise spends the pod
//                    rather than be kept), and /dev/termination-log empty
//
// It prints one line, `RS<nonce>clean\n`, or `RS<nonce>dirty <why>\n` (printable ASCII, at most about 600 characters),
// and exits 0 or 1 (parseSessionReset reads it); with no nonce it prints nothing and exits 2. What the per-case
// namespaces cover (SysV, mqueues, keyrings; a loopback port's TIME_WAIT, which gVisor never lists in /proc/net/tcp
// (probe K7), and abstract unix sockets) it does not sweep. Its file steps alone are SESSION_WIPE_SCRIPT (the same
// subroutines, SESSION_SWEEP_LIB, over the directories and uid given, killing nothing), which is what runs on a host tree
// in the unit tests; its kill step runs only in a session pod.
//
// The restage (restageCommand: k8s-transfer.ts stageStream's `command` hook, the exec into `watch`) empties each
// restaged directory it is given (SESSION_RESTAGE_SCRIPT: the same chdir walk, umask 022, directories given u+rwx
// first; it prints `no <why>` in the unpacker's words when it cannot), then execs the tree unpacker into them, whose ack
// stays the first line and the verdict. It signals no PID 1: `watch`'s is the agent, and nothing waits for a release.
// A kill while the restage streams cuts it off, and the pod is spent with it: its /input may be half written.
//
// Every exec the session itself makes goes over the pod's `watch` agent session (bootPod's, held by the session for the
// pod's life and closed after the pod's delete), as the run's watch execs and its collect do (k8s.ts's header: Agent
// sessions): the restage into `watch` itself, the launcher check and the reset into `main` (mainExec), and each case's
// exec and its signals and kill (K8sProcess's session mode, k8s.ts #member), which `watch` relays to `main`'s shim
// (k8s.ts agentMember), each sent once and never again (agent-client.ts's no re-send: a stream
// lost with the session or the shim is that exec's end). None touches the control plane, so none holds a slot of the
// sandbox pace and nothing one says cuts it (k8s.ts's header: the pace), and a failure's message, which may quote the
// entrant's restaged paths, is only ever the run's words. What is left of kubectl in a session is the driver's
// create, patch, wait, get and delete: no exec at all.

import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { imageFor, type ImageTableT } from '../images.ts';
import { recordInit } from './agent-client.ts';
import { AGENT_KEY_ENV } from './agent-wire.ts';
import { checkSandboxLabel, positiveInt } from './docker.ts';
import type { K8sWarmPool } from './k8s-pool.ts';
import {
  AGENT_BIN_VOLUME,
  agentMember,
  bootPod,
  bootTakenPod,
  checkPodMounts,
  checkUnderDataRoot,
  CONTAINER,
  deleteObjects,
  EXEC_WRAPPER,
  failure,
  K8S_DRIVER_FAILURE,
  K8sProcess,
  killedExit,
  mountVolumeName,
  POD_OWN_TASKS,
  podName,
  readPodVerdict,
  sandboxPodSpec,
  SENTINEL_MARK,
  SESSION_EXEC_WRAPPER,
  shapeKeyOf,
  SESSION_REPORT_TAG,
  shimMembersOf,
  STAGE_CONTAINER,
  WATCH_CONTAINER,
  why,
  type K8sContext,
  type K8sObject,
  type K8sPoolShape,
  type KubectlResult,
  type NodePreference,
  type PodAgentSession,
  type PodAgentSpec,
  type PodPlacement,
  type SandboxPodOptions,
  type SessionLaunch,
  type SessionPrepared,
  type SessionRunEnd,
} from './k8s.ts';
import { stageStream } from './k8s-transfer.ts';
import { checkSandboxMounts } from './mounts.ts';
import { treeUnpackArgv } from './tree-stream.ts';
import {
  checkHostPath,
  checkSandboxSecrets,
  checkSessionRun,
  checkSessionTemplate,
  RUNTIME_COMMANDS,
  SandboxError,
  scriptOf,
  type Runtime,
  type Sandbox,
  type SandboxExit,
  type SandboxMount,
  type SandboxProcess,
  type SandboxSession,
  type SandboxSpec,
  type TreeMeter,
  type TreeMeterOptions,
} from './types.ts';

/** The session wrapper and its report line's tag live in k8s.ts beside their reader (SentinelScanner): the header. */
export { SESSION_EXEC_WRAPPER, SESSION_REPORT_TAG };

/** The uid and gid every case runs as, inside its namespace and out (`main`'s, the sandbox user's), and the reset's. */
export const SESSION_UID = 65534;
/** The code directory: what `stage` stages in a session pod, alone. */
export const SESSION_CODE_DIR = '/bot';
/** The pod-shared directories the reset wipes besides the writable mounts: /tmp (a Memory emptyDir) and /dev/shm. */
export const SESSION_SHARED_ROOTS: readonly string[] = Object.freeze(['/tmp', '/dev/shm']);
/** Where `watch` holds each read-only mount's volume read-write in a session pod: `/restage<mount point>` (restageMountPath). */
export const SESSION_RESTAGE_ROOT = '/restage';
/** The most kill rounds of the reset (each a kill(-1) and a /proc read). */
export const SESSION_RESET_ROUNDS = 50;
/** The pause between a round's kill and its /proc read. */
export const SESSION_RESET_PAUSE_MS = 20;
/** `main`'s termination message file (the kubelet's default terminationMessagePath), which the reset empties. */
export const SESSION_TERMINATION_LOG = '/dev/termination-log';
/** The reset's verdict words: `RS<nonce>clean` or `RS<nonce>dirty <why>`. */
export const SESSION_RESET_CLEAN = 'clean';
export const SESSION_RESET_DIRTY = 'dirty';
/** The case launcher's one report on descriptor 4, printed by the wrapper as `RS<nonce>i<word>`. */
export const CASE_LAUNCHER_OK = 'ok';

/** The shim's flag that makes it the session reaper (sandbox-agent/src/shim.rs): its 1 s reap, the signals it ignores. */
export const SESSION_REAPER_FLAG = '--session-reaper';
/**
 * `main`'s command in a session pod (the header): the shim, `stage`'s copy of the agent at k8s.ts SHIM_BIN, as
 * shimCommand(CONTAINER) words it, with SESSION_REAPER_FLAG. Written out here rather than built from k8s.ts's values:
 * this file's top level reads none of them (the import cycle, the header), and SESSION_RESET_SCRIPT carries its command
 * line. The session tests hold it to `[...shimCommand(CONTAINER), SESSION_REAPER_FLAG]` word for word.
 */
export const SESSION_PID1_COMMAND: readonly string[] = Object.freeze(['/run/makefun-agent/makefun-agent', 'shim', '--container', 'main', SESSION_REAPER_FLAG]);
/** What /proc/1/cmdline reads in a session pod's `main`: the command's words, each ended by a NUL. */
export const SESSION_PID1_CMDLINE = `${SESSION_PID1_COMMAND.join('\0')}\0`;

/**
 * The launcher's loopback (the header), perl with perl-base's modules alone, no top-level act: CASE_LAUNCHER_SCRIPT's
 * part that brings the case's network namespace's `lo` up once the namespace is made, before the report. A Linux
 * kernel, and gVisor from release-20261109.0 (its commit 80f80e7a, "create loopback addresses on interface up"), make a
 * new network namespace's `lo` administratively DOWN with no address, and only bringing it up gives it 127.0.0.1 and
 * ::1, as `ip link set lo up` does; gVisor up to release-20261102.0 made it up with both already (deploy/k8s/README.md
 * K7b) and takes the same request as a no-op. Without it every bind to 127.0.0.1 there is EADDRNOTAVAIL (`Cannot
 * assign requested address`), so the launcher check's probe fails and the session runs a pod per case.
 *
 * - lo_up(): one rtnetlink RTM_NEWLINK on an AF_NETLINK NETLINK_ROUTE socket to the kernel (pid 0), NLM_F_REQUEST and
 *   NLM_F_ACK, seq 1; its ifinfomsg AF_UNSPEC, index 0, ifi_flags and ifi_change IFF_UP, the device named by its
 *   IFLA_IFNAME `lo`. The launcher holds CAP_NET_ADMIN over the new network namespace (its own user namespace's)
 *   until its exec. '' when the answer is the acknowledgement (NLMSG_ERROR of seq 1, error 0), else why not; the
 *   exchange (lo_ask()) runs under a SIGALRM of CASE_LAUNCHER_LO_SECONDS, cleared before lo_up() returns (an alarm
 *   would outlive the exec), so a kernel that never answers is `timed out`, a refusal, and never a case exec stalled.
 * - lo_bound(): '' when a TCP socket binds 127.0.0.1:0, else why not.
 * - lo_ready(): '' once lo_up() is acknowledged, or when it is not but 127.0.0.1 binds all the same (a runtime that
 *   refuses the request whose `lo` is already up: the launcher is never stricter than it was before it brought `lo`
 *   up), else both reasons.
 */
export const CASE_LAUNCHER_LO_SECONDS = 2;
export const CASE_LAUNCHER_LO_LIB = [
  'sub lo_up {',
  '  my $why = eval {',
  "    local $SIG{ALRM} = sub { die \"timed out\\n\" };",
  `    alarm ${CASE_LAUNCHER_LO_SECONDS};`,
  '    my $r = lo_ask();',
  '    alarm 0;',
  '    $r;',
  '  };',
  '  alarm 0;',
  '  return $why if defined $why;',
  '  my $e = $@;',
  '  chomp $e;',
  "  return $e eq 'timed out' ? $e : \"failed: $e\";",
  '}',
  'sub lo_ask {',
  "  socket(my $nl, 16, Socket::SOCK_RAW(), 0) or return \"socket(AF_NETLINK): $!\";",
  "  my $name = \"lo\\0\";",
  "  my $attr = pack('SS', 4 + length($name), 3) . $name;",
  '  $attr .= "\\0" x ((4 - length($attr) % 4) % 4);',
  "  my $body = pack('CCSlLL', 0, 0, 0, 0, 1, 1) . $attr;",
  "  my $kernel = pack('SSLL', 16, 0, 0, 0);",
  "  defined(send($nl, pack('LSSLL', 16 + length($body), 16, 5, 1, 0) . $body, 0, $kernel)) or return \"send RTM_NEWLINK: $!\";",
  "  my $got = '';",
  "  defined(recv($nl, $got, 8192, 0)) or return \"receive: $!\";",
  "  my ($len, $type, $flags, $seq) = length($got) >= 20 ? unpack('LSSL', $got) : (0, 0, 0, 0);",
  "  return 'its answer is no acknowledgement (' . length($got) . ' bytes)' unless $type == 2 && $seq == 1 && $len >= 20;",
  "  my $err = unpack('l', substr($got, 16, 4));",
  "  return '' if $err == 0;",
  '  $! = -$err;',
  '  return "RTM_NEWLINK: $!";',
  '}',
  'sub lo_bound {',
  "  socket(my $s, Socket::PF_INET(), Socket::SOCK_STREAM(), 0) or return \"socket: $!\";",
  "  bind($s, Socket::pack_sockaddr_in(0, Socket::INADDR_LOOPBACK())) or return \"bind 127.0.0.1:0: $!\";",
  "  return '';",
  '}',
  'sub lo_ready {',
  '  my $down = lo_up();',
  "  return '' if $down eq '';",
  '  my $bound = lo_bound();',
  "  return $bound eq '' ? '' : \"$down; $bound\";",
  '}',
].join('\n');

/**
 * The case launcher (the header), perl with perl-base's modules alone, run as
 * `perl -e CASE_LAUNCHER_SCRIPT -- <uid> <gid> <argv...>` with descriptor 4 its report: it must run as uid:gid alone; it
 * unshares CLONE_NEWUSER|CLONE_NEWIPC|CLONE_NEWNET by raw syscall (x86_64, aarch64: the pinned images' two), denies
 * setgroups (a kernel with no setgroups file has no such gate), maps uid to uid and gid to gid and nothing else, reads
 * both maps back, brings the new network namespace's `lo` up (CASE_LAUNCHER_LO_LIB), writes `ok` on descriptor 4
 * (close-on-exec, and closed) and execs argv (a PATH search, as the wrapper's `exec` does).
 * A failure of its own before the report goes to stderr as `case launcher: ...`, nothing on descriptor 4, and exit 125.
 * An exec that fails after it is the program's, as the plain wrapper's `exec` failing is: 127 when it is not found,
 * else 126, its words on stderr.
 */
export const CASE_LAUNCHER_SCRIPT = [
  'use strict;',
  'use warnings;',
  'use POSIX ();',
  'use Fcntl ();',
  'use Socket ();',
  'sub fail { print STDERR "case launcher: $_[0]\\n"; exit 125 }',
  'my ($uid, $gid, @argv) = @ARGV;',
  "fail('usage: perl -e <launcher> -- <uid> <gid> <argv...>') unless defined $gid && @argv && $uid =~ /\\A[1-9][0-9]*\\z/ && $gid =~ /\\A[1-9][0-9]*\\z/;",
  "open(my $report, '>&=', 4) or fail(\"no report descriptor 4: $!\");",
  'my $fl = fcntl($report, Fcntl::F_GETFD(), 0);',
  '(defined $fl && fcntl($report, Fcntl::F_SETFD(), $fl | Fcntl::FD_CLOEXEC())) or fail("descriptor 4: $!");',
  'sub alone { return POSIX::getuid() == $uid && POSIX::geteuid() == $uid && POSIX::getgid() == $gid && POSIX::getegid() == $gid }',
  'fail("the launcher runs as $uid:$gid alone, not " . POSIX::getuid() . ":" . POSIX::getgid()) unless alone();',
  'my $machine = (POSIX::uname())[4];',
  'my %NR = (x86_64 => 272, aarch64 => 97);',
  'my $nr = $NR{$machine} or fail("no syscall numbers for $machine");',
  // CLONE_NEWUSER 0x10000000 | CLONE_NEWIPC 0x08000000 | CLONE_NEWNET 0x40000000, in one call: the IPC and network
  // namespaces are the new user namespace's. The network one gives the case a loopback of its own: no port an earlier
  // case's connection holds in TIME_WAIT (gVisor lists none, so no reset can wait it out) and no abstract unix socket
  // of an earlier case's; the session pod has no network beyond loopback for a case anyway.
  'syscall($nr, 0x58000000) == 0 or fail("unshare(CLONE_NEWUSER|CLONE_NEWIPC|CLONE_NEWNET): $!");',
  'sub put {',
  '  my ($path, $text, $optional) = @_;',
  '  my $f;',
  '  if (!sysopen($f, $path, Fcntl::O_WRONLY())) { return if $optional && $!{ENOENT}; fail("$path: $!") }',
  '  my $w = syswrite($f, $text);',
  '  fail("$path: " . (defined $w ? "a short write" : $!)) unless defined $w && $w == length $text;',
  '  close($f) or fail("$path: $!");',
  '}',
  "put('/proc/self/setgroups', \"deny\\n\", 1);",
  "put('/proc/self/uid_map', \"$uid $uid 1\\n\");",
  "put('/proc/self/gid_map', \"$gid $gid 1\\n\");",
  'sub mapped {',
  '  my ($path, $id) = @_;',
  "  open(my $f, '<', $path) or return 0;",
  '  my @l = <$f>;',
  '  close $f;',
  "  return @l == 1 && join(' ', split(' ', $l[0])) eq \"$id $id 1\";",
  '}',
  "fail('the namespace maps more than its own ids') unless mapped('/proc/self/uid_map', $uid) && mapped('/proc/self/gid_map', $gid) && alone();",
  CASE_LAUNCHER_LO_LIB,
  // The case's `lo` (CASE_LAUNCHER_LO_LIB), before the report: a launcher that says `ok` has given its case a loopback.
  'my $lo = lo_ready();',
  "fail(\"lo up: $lo\") unless $lo eq '';",
  'my $said = syswrite($report, "ok\\n");',
  'fail("descriptor 4: $!") unless defined $said && $said == 3;',
  'close $report;',
  "{ no warnings 'exec'; exec { $argv[0] } @argv; }",
  'my $missing = $!{ENOENT};',
  'print STDERR "case launcher: exec $argv[0]: $!\\n";',
  'exit($missing ? 127 : 126);',
].join('\n');

/**
 * The loopback probe (the header's launcher check), perl with perl-base's modules alone (Socket, as BIND_PROOF_ARGV's),
 * run under the case launcher so it runs in a case's own network namespace: a TCP listener bound to 127.0.0.1 on a port
 * the kernel picks, a second socket connected to it, the connection accepted, and one byte carried across it. Nothing on
 * stdout (the check reads its stdout whole); exit 0 when the byte arrived, else its words on stderr as
 * `loopback probe: ...` and exit 1, within CASE_LOOPBACK_PROBE_SECONDS. A namespace whose `lo` is down (a fresh network
 * namespace on a Linux kernel or under gVisor from release-20261109.0, where the launcher could not bring it up) fails
 * it at the bind (EADDRNOTAVAIL: no 127.0.0.1) or the connect, so a case would find no loopback there: the session then
 * runs its cases a pod each.
 */
export const CASE_LOOPBACK_PROBE_SECONDS = 10;
export const CASE_LOOPBACK_PROBE_SCRIPT = [
  'use strict;',
  'use warnings;',
  'use Socket qw(PF_INET SOCK_STREAM inet_aton pack_sockaddr_in unpack_sockaddr_in);',
  'sub fail { print STDERR "loopback probe: $_[0]\\n"; exit 1 }',
  `$SIG{ALRM} = sub { fail('no answer within ${CASE_LOOPBACK_PROBE_SECONDS} s') };`,
  `alarm ${CASE_LOOPBACK_PROBE_SECONDS};`,
  "my $lo = inet_aton('127.0.0.1') or fail('no address 127.0.0.1');",
  'socket(my $l, PF_INET, SOCK_STREAM, 0) or fail("socket: $!");',
  'bind($l, pack_sockaddr_in(0, $lo)) or fail("bind 127.0.0.1:0: $!");',
  'listen($l, 1) or fail("listen: $!");',
  'my $at = getsockname($l) or fail("getsockname: $!");',
  'my ($port) = unpack_sockaddr_in($at);',
  'socket(my $c, PF_INET, SOCK_STREAM, 0) or fail("socket: $!");',
  'connect($c, pack_sockaddr_in($port, $lo)) or fail("connect 127.0.0.1:$port: $!");',
  'accept(my $a, $l) or fail("accept: $!");',
  'my $w = syswrite($c, "x");',
  'fail("send: " . (defined $w ? "nothing sent" : $!)) unless defined $w && $w == 1;',
  'my $r = sysread($a, my $got, 1);',
  'fail("receive: " . (defined $r ? "nothing came" : $!)) unless defined $r && $r == 1 && $got eq "x";',
  'exit 0;',
].join('\n');
/** The program the launcher check runs under the case launcher: the loopback probe. */
export const CASE_LOOPBACK_PROBE: readonly string[] = Object.freeze(['perl', '-e', CASE_LOOPBACK_PROBE_SCRIPT]);

/** The argv a session's wrapper runs for `program`: the case launcher, as SESSION_UID:SESSION_UID. */
export function caseLauncherArgv(program: readonly string[]): string[] {
  if (program.length === 0) throw new SandboxError('a case launcher needs a program to run');
  return ['perl', '-e', CASE_LAUNCHER_SCRIPT, '--', String(SESSION_UID), String(SESSION_UID), ...program];
}

/**
 * The reset's subroutines (the header), perl with perl-base's modules alone, no top-level act: SESSION_RESET_SCRIPT's
 * and SESSION_WIPE_SCRIPT's common part.
 *
 * - wipe_files($uid, @roots): every entry $uid owns under each root removed (the root kept), a directory given u+rwx
 *   first; returns what could not be done.
 * - check_files($uid, @roots): '' when no root holds an entry of $uid's or another uid's, else why not.
 * - others(): every process but PID 1 and this one, as ([live pids], [zombie pids], undef), or an error third.
 * - truncate_file($path): the file emptied, opened write-only with O_TRUNC, never created; '' when done or not there,
 *   else why not. file_left($path): '' when the file is empty or not there, else why not.
 */
export const SESSION_SWEEP_LIB = String.raw`use strict;
use warnings;
no warnings 'recursion';
use POSIX ();
use Fcntl qw(:mode);
sub shown { my ($s) = @_; $s = substr($s, 0, 200) . '...' if length($s) > 200; $s =~ s/[^\x20-\x7e]/?/g; return $s }
sub said { my ($what, $l) = @_; my $last = $#$l < 4 ? $#$l : 4; return "$what " . join(', ', @$l[0 .. $last]) . (@$l > 5 ? ' and ' . (@$l - 5) . ' more' : '') }
sub pause { select(undef, undef, undef, $_[0]) }
sub err { my ($r, $what, $p, $why) = @_; push @{ $r->{err} }, "$what " . shown($p) . ": $why" }
sub enter {
  my ($n, $p, $st, $uid, $remove, $r, $own) = @_;
  if (!chdir($n)) { err($r, 'chdir', $p, "$!") if $own; return 0 }
  my @here = stat('.');
  die 'the walk lost its way at ' . shown($p) . "\n" unless @here && $here[0] == $st->[0] && $here[1] == $st->[1];
  sweep_here($p, $uid, $remove, $r);
  chdir('..') or die 'the walk could not come back up from ' . shown($p) . ": $!\n";
  return 1;
}
sub sweep_here {
  my ($at, $uid, $remove, $r) = @_;
  my $h;
  if (!opendir($h, '.')) { err($r, 'opendir', $at, "$!"); return }
  my @names = grep { $_ ne '.' && $_ ne '..' } readdir $h;
  closedir $h;
  for my $n (@names) {
    my $p = "$at/$n";
    my @st = lstat($n);
    if (!@st) { err($r, 'lstat', $p, "$!") unless $!{ENOENT}; next }
    my $dir = S_ISDIR($st[2]);
    if ($st[4] != $uid) {
      push @{ $r->{other} }, shown($p) . " (uid $st[4])";
      enter($n, $p, \@st, $uid, $remove, $r, 0) if $dir;
      next;
    }
    if (!$remove) { push @{ $r->{left} }, shown($p); next }
    if (!$dir) { unlink($n) or err($r, 'unlink', $p, "$!"); next }
    if (!chmod(0700, $n)) { err($r, 'chmod', $p, "$!"); next }
    enter($n, $p, \@st, $uid, $remove, $r, 1) or next;
    rmdir($n) or err($r, 'rmdir', $p, "$!");
  }
}
sub sweep_root {
  my ($root, $uid, $remove, $r) = @_;
  my @st = lstat($root);
  if (!@st) { err($r, 'lstat', $root, "$!") unless $!{ENOENT}; return }
  if (!S_ISDIR($st[2])) { push @{ $r->{err} }, shown($root) . ' is not a directory'; return }
  if (!chdir($root)) { err($r, 'chdir', $root, "$!"); return }
  my @here = stat('.');
  if (@here && $here[0] == $st[0] && $here[1] == $st[1]) {
    if (!eval { sweep_here($root, $uid, $remove, $r); 1 }) { my $e = $@; $e =~ s/\n\z//; push @{ $r->{err} }, $e }
  } else {
    push @{ $r->{err} }, shown($root) . ' moved under the walk';
  }
  chdir('/') or die "chdir /: $!\n";
}
sub wipe_files {
  my ($uid, @roots) = @_;
  my %r = (left => [], other => [], err => []);
  sweep_root($_, $uid, 1, \%r) for @roots;
  return @{ $r{err} };
}
sub check_files {
  my ($uid, @roots) = @_;
  my %r = (left => [], other => [], err => []);
  sweep_root($_, $uid, 0, \%r) for @roots;
  my @why;
  push @why, said("uid $uid still owns", $r{left}) if @{ $r{left} };
  push @why, said('another uid owns', $r{other}) if @{ $r{other} };
  push @why, said('could not sweep:', $r{err}) if @{ $r{err} };
  return join('; ', @why);
}
sub others {
  my (@live, @zombie);
  my $d;
  return ([], [], "opendir /proc: $!") unless opendir($d, '/proc');
  for my $p (readdir $d) {
    next unless $p =~ /\A[0-9]+\z/;
    next if $p == 1 || $p == $$;
    open(my $f, '<', "/proc/$p/stat") or next;
    my $s = <$f>;
    close $f;
    next unless defined $s;
    my $at = rindex($s, ')');
    next if $at < 0;
    my ($state) = split ' ', substr($s, $at + 1);
    next if !defined $state || $state eq 'X';
    if ($state eq 'Z') { push @zombie, $p } else { push @live, $p }
  }
  closedir $d;
  return (\@live, \@zombie, undef);
}
sub procs_left {
  my ($live, $zombie) = @_;
  my @why;
  push @why, said('processes left:', $live) if @$live;
  push @why, said('zombies left:', $zombie) if @$zombie;
  return join('; ', @why);
}
sub truncate_file {
  my ($path) = @_;
  my $f;
  if (!sysopen($f, $path, Fcntl::O_WRONLY() | Fcntl::O_TRUNC())) { return $!{ENOENT} ? '' : 'truncate ' . shown($path) . ": $!" }
  close($f) or return 'truncate ' . shown($path) . ": $!";
  return '';
}
sub file_left {
  my ($path) = @_;
  my @st = stat($path);
  if (!@st) { return $!{ENOENT} ? '' : 'stat ' . shown($path) . ": $!" }
  return $st[7] == 0 ? '' : shown($path) . " holds $st[7] bytes";
}
`;

const PID1_CMDLINE_HEX = Buffer.from(SESSION_PID1_CMDLINE, 'latin1').toString('hex');

/**
 * The reset between two cases (the header's five steps), run as `perl -e SESSION_RESET_SCRIPT -- <writable mount
 * point>...` (sessionResetArgv) in `main` as SESSION_UID, the nonce on stdin's first line: one line,
 * `RS<nonce>clean` (exit 0) or `RS<nonce>dirty <why>` (exit 1); with no nonce, nothing on stdout and exit 2. It forks
 * nothing, and its first act after the nonce is the refusal of any process tree that is not a session pod's `main`.
 */
export const SESSION_RESET_SCRIPT =
  SESSION_SWEEP_LIB +
  String.raw`my $nonce = <STDIN>;
if (!defined $nonce || $nonce !~ /\A[0-9a-f]{32}\n?\z/) { print STDERR "session reset: no nonce on stdin's first line\n"; exit 2 }
chomp $nonce;
$| = 1;
sub verdict {
  my ($why) = @_;
  $why =~ s/[^\x20-\x7e]/?/g;
  $why = substr($why, 0, 600) . '...' if length($why) > 600;
  print STDOUT "\x1e$nonce", ($why eq '' ? '${SESSION_RESET_CLEAN}' : "${SESSION_RESET_DIRTY} $why"), "\n";
  exit($why eq '' ? 0 : 1);
}
# Step refuse: PID 1 must be the session reaper (the shim with --session-reaper), 65534's, and the reset 65534 itself, never root.
my $cmdline;
if (open(my $c, '<', '/proc/1/cmdline')) { local $/; $cmdline = <$c>; close $c }
verdict('refused: PID 1 is not the session reaper') unless defined $cmdline && $cmdline eq pack('H*', '${PID1_CMDLINE_HEX}');
my $pid1;
if (open(my $s, '<', '/proc/1/status')) { while (my $l = <$s>) { if ($l =~ /\AUid:\s+([0-9]+)\s+([0-9]+)/) { $pid1 = [$1, $2]; last } } close $s }
verdict('refused: PID 1 is not the session reaper') unless $pid1 && $pid1->[0] == ${SESSION_UID} && $pid1->[1] == ${SESSION_UID};
verdict('refused: the reset runs as uid ${SESSION_UID} alone') unless $< == ${SESSION_UID} && $> == ${SESSION_UID};
for my $m (@ARGV) { verdict('refused: ' . shown($m) . ' is no writable mount point') unless $m =~ m{\A/[a-z][a-z0-9-]*\z} }
my %NR = (x86_64 => 62, aarch64 => 129);
my $machine = (POSIX::uname())[4];
my $kill = $NR{$machine};
verdict("refused: no kill syscall number for $machine") unless defined $kill;
# Step kill: kill(-1, SIGKILL) and /proc again, in rounds, until nothing but PID 1 and this is left, live or zombie.
my ($live, $zombie, $err) = ([], [], undef);
my $settled = 0;
for my $round (1 .. ${SESSION_RESET_ROUNDS}) {
  verdict("kill(-1, SIGKILL): $!") if syscall($kill, -1, 9) != 0 && !$!{ESRCH};
  pause(${SESSION_RESET_PAUSE_MS / 1000});
  ($live, $zombie, $err) = others();
  verdict($err) if defined $err;
  if (!@$live && !@$zombie) { $settled = 1; last }
}
verdict(procs_left($live, $zombie)) unless $settled;
# Step wipe: 65534's entries under the writable mounts, /tmp and /dev/shm.
my @roots = (@ARGV, ${SESSION_SHARED_ROOTS.map((r) => `'${r}'`).join(', ')});
my @wiped = wipe_files(${SESSION_UID}, @roots);
# Step termination-log: the kubelet's message file, the one other file 65534 may write, emptied (never created).
my $truncated = truncate_file('${SESSION_TERMINATION_LOG}');
# Step verify: no process but PID 1 and this, no zombie, nothing of 65534's or another uid's in those directories,
# and the termination log empty.
($live, $zombie, $err) = others();
verdict($err) if defined $err;
verdict(procs_left($live, $zombie)) if @$live || @$zombie;
my $files = check_files(${SESSION_UID}, @roots);
$files .= '; ' . said('could not wipe:', \@wiped) if $files ne '' && @wiped;
my $log = file_left('${SESSION_TERMINATION_LOG}');
$log .= " ($truncated)" if $log ne '' && $truncated ne '';
verdict(join('; ', grep { $_ ne '' } $files, $log));
`;

/**
 * The reset's file steps alone (wipe, then verify), run as `perl -e SESSION_WIPE_SCRIPT -- <uid> <directory>...`: one
 * line, `clean` (exit 0) or `dirty <why>` (exit 1); a usage fault, exit 2. It kills nothing and reads no /proc: what the
 * unit tests run on a host tree.
 */
export const SESSION_WIPE_SCRIPT =
  SESSION_SWEEP_LIB +
  String.raw`my ($uid, @roots) = @ARGV;
if (!defined $uid || $uid !~ /\A[0-9]+\z/ || !@roots || grep { !m{\A/} } @roots) { print STDERR "usage: perl -e <wipe> -- <uid> <absolute directory>...\n"; exit 2 }
my @wiped = wipe_files($uid, @roots);
my $why = check_files($uid, @roots);
$why .= '; ' . said('could not wipe:', \@wiped) if $why ne '' && @wiped;
print STDOUT ($why eq '' ? "${SESSION_RESET_CLEAN}\n" : "${SESSION_RESET_DIRTY} $why\n");
exit($why eq '' ? 0 : 1);
`;

/** The argv of a session pod's reset for `spec` (the session's template): SESSION_RESET_SCRIPT over its writable mount points. */
export function sessionResetArgv(spec: SandboxSpec): string[] {
  const writable = checkSandboxMounts(spec.mounts)
    .filter((m) => !m.readOnly)
    .map((m) => {
      mountVolumeName(m.at);
      return m.at;
    });
  return ['perl', '-e', SESSION_RESET_SCRIPT, '--', ...writable];
}

/** What a reset said (parseSessionReset). */
export type SessionResetVerdict = { clean: true } | { clean: false; why: string };

const NONCE_RE = /^[0-9a-f]{32}$/;
const WHY_RE = /^[\x20-\x7e]+$/;

/**
 * A reset exec's whole stdout read against its nonce: `{ clean: true }` for `RS<nonce>clean\n`, `{ clean: false, why }`
 * for `RS<nonce>dirty <why>\n`, null for anything else (no line, another nonce, more than the one line), which its
 * caller reads as a reset cut off.
 */
export function parseSessionReset(stdout: string, nonce: string): SessionResetVerdict | null {
  if (!NONCE_RE.test(nonce)) throw new SandboxError(`a reset's nonce is 32 hex digits, not ${JSON.stringify(nonce)}`);
  const head = `${SENTINEL_MARK}${nonce}`;
  if (stdout === `${head}${SESSION_RESET_CLEAN}\n`) return { clean: true };
  const dirty = `${head}${SESSION_RESET_DIRTY} `;
  if (!stdout.startsWith(dirty) || !stdout.endsWith('\n')) return null;
  const why = stdout.slice(dirty.length, -1);
  return WHY_RE.test(why) ? { clean: false, why } : null;
}

/** Where `watch` holds read-only mount `at`'s volume read-write in a session pod: `/restage/input` for `/input`. */
export function restageMountPath(at: string): string {
  mountVolumeName(at);
  return `${SESSION_RESTAGE_ROOT}${at}`;
}

/**
 * The restage's emptying, perl, run as `perl -e SESSION_RESTAGE_SCRIPT -- <n> <directory>... <unpacker argv...>`
 * (restageCommand): umask 022, each of the n absolute directories emptied (the directory kept; a directory in it given
 * u+rwx first, emptied, then removed; nothing followed through a link), then the rest of the argv exec'd in its place.
 * It prints nothing on stdout but, when it cannot, `no <why>` in the unpacker's words, and exits 1.
 */
export const SESSION_RESTAGE_SCRIPT = String.raw`use strict;
use warnings;
no warnings 'recursion';
use Fcntl qw(:mode);
umask 022;
$| = 1;
sub refuse { my ($why) = @_; $why = substr($why, 0, 400) if length($why) > 400; $why =~ s/[^\x20-\x7e]/?/g; print STDOUT "no restage: $why\n"; exit 1 }
my $n = shift @ARGV;
refuse('usage: perl -e <restage> -- <n> <directory>... <argv...>') unless defined $n && $n =~ /\A[1-9][0-9]{0,2}\z/ && @ARGV > $n;
my @dirs = splice(@ARGV, 0, $n);
sub empty_here {
  my ($at) = @_;
  my $h;
  opendir($h, '.') or refuse("opendir $at: $!");
  my @names = grep { $_ ne '.' && $_ ne '..' } readdir $h;
  closedir $h;
  for my $e (@names) {
    my $p = "$at/$e";
    my @st = lstat($e);
    if (!@st) { next if $!{ENOENT}; refuse("lstat $p: $!") }
    if (!S_ISDIR($st[2])) { unlink($e) or refuse("unlink $p: $!"); next }
    chmod(0700, $e) or refuse("chmod $p: $!");
    chdir($e) or refuse("chdir $p: $!");
    my @here = stat('.');
    refuse("$p moved under the walk") unless @here && $here[0] == $st[0] && $here[1] == $st[1];
    empty_here($p);
    chdir('..') or refuse("chdir .. from $p: $!");
    rmdir($e) or refuse("rmdir $p: $!");
  }
}
for my $d (@dirs) {
  refuse("$d is not an absolute path") unless $d =~ m{\A/};
  my @st = lstat($d);
  refuse("lstat $d: $!") unless @st;
  refuse("$d is not a directory") unless S_ISDIR($st[2]);
  chdir($d) or refuse("chdir $d: $!");
  empty_here($d);
  chdir('/') or refuse("chdir /: $!");
}
{ no warnings 'exec'; exec { $ARGV[0] } @ARGV; }
refuse("exec $ARGV[0]: $!");
`;

const RESTAGE_DIR_RE = new RegExp(`^${SESSION_RESTAGE_ROOT}/[a-z0-9][-a-z0-9]*$`);

/**
 * The restage exec's argv (the header; k8s-transfer.ts stageStream's `command` hook, the exec into `-c watch`): `unpack`
 * must be treeUnpackArgv of restaged directories alone (restageMountPath's), each of which SESSION_RESTAGE_SCRIPT
 * empties before it execs the unpacker into them. No PID 1 is signalled. Anything else is a SandboxError.
 */
export function restageCommand(unpack: readonly string[]): string[] {
  const dirs = unpack.slice(4);
  for (const d of dirs) {
    if (!RESTAGE_DIR_RE.test(d)) throw new SandboxError(`a restage writes only ${SESSION_RESTAGE_ROOT}/<volume>, not ${JSON.stringify(d)}`);
  }
  let own: string[];
  try {
    own = treeUnpackArgv(dirs);
  } catch (err) {
    throw new SandboxError(`a restage wraps the tree unpacker over its directories: ${(err as Error).message}`, { cause: err });
  }
  if (own.length !== unpack.length || own.some((a, i) => a !== unpack[i])) throw new SandboxError('a restage wraps the tree unpacker (treeUnpackArgv) and nothing else');
  return ['perl', '-e', SESSION_RESTAGE_SCRIPT, '--', String(dirs.length), ...dirs, ...unpack];
}

interface VolumeMountShape {
  name: string;
  mountPath: string;
  readOnly?: boolean;
}

interface ContainerShape {
  name: string;
  image: string;
  command: string[];
  volumeMounts?: VolumeMountShape[];
  [field: string]: unknown;
}

interface PodSpecShape {
  initContainers?: ContainerShape[];
  containers: ContainerShape[];
  volumes?: Array<Record<string, unknown>>;
  [field: string]: unknown;
}

/**
 * A session's pod (the header), pure: sandboxPodSpec(spec, opts)'s split program pod for the session's template, a shim
 * pod whatever opts.shim says (k8s.ts's header, The pod: agent-bin, `stage`'s install, `watch` taking `main`'s link),
 * with `main`'s command SESSION_PID1_COMMAND (the shim as the session reaper), `stage` holding /bot (and agent-bin)
 * alone, and `watch` holding each read-only mount's volume read-write at restageMountPath besides each writable mount
 * read-only; everything else, labels and annotations included, a program pod's. A template checkSessionTemplate refuses,
 * a timed pod or one with a policy of its own is a SandboxError, before anything is made.
 */
export function sessionPodSpec(spec: SandboxSpec, opts: SandboxPodOptions): K8sObject {
  checkSessionTemplate(spec);
  if (opts.timed === true) throw new SandboxError("a session pod is never timed: a timing heat's runs are a pod each");
  if (opts.ownPolicy === true) throw new SandboxError('a session pod has no policy of its own: it has no network');
  const pod = sandboxPodSpec(spec, { ...opts, shim: true });
  const podSpec = pod.spec as PodSpecShape;
  const main = podSpec.containers.find((c) => c.name === CONTAINER);
  const stage = podSpec.initContainers?.find((c) => c.name === STAGE_CONTAINER);
  const watch = podSpec.containers.find((c) => c.name === WATCH_CONTAINER);
  // A shim pod always has all three (sandboxPodSpec refused one with no agent to run `stage` and `watch` already); this
  // says so again rather than assume it.
  const missing = main === undefined ? CONTAINER : stage === undefined ? STAGE_CONTAINER : watch === undefined ? WATCH_CONTAINER : null;
  if (missing !== null) throw new SandboxError(`pod ${opts.name}: a program pod with no ${missing} is no session pod`);
  main!.command = [...SESSION_PID1_COMMAND];
  stage!.volumeMounts = (stage!.volumeMounts ?? []).filter((m) => m.mountPath === SESSION_CODE_DIR || m.name === AGENT_BIN_VOLUME);
  const restaged: VolumeMountShape[] = checkSandboxMounts(spec.mounts)
    .filter((m) => m.readOnly)
    .map((m) => ({ name: mountVolumeName(m.at), mountPath: restageMountPath(m.at), readOnly: false }));
  if (restaged.length > 0) watch!.volumeMounts = [...(watch!.volumeMounts ?? []), ...restaged];
  checkPodMounts(
    opts.name,
    [...(podSpec.initContainers ?? []), ...podSpec.containers].flatMap((c) => c.volumeMounts ?? []),
    podSpec.volumes ?? [],
  );
  return pod;
}

// ---------------------------------------------------------------- the session runtime

/**
 * How much a reset exec may take, from the call: two minutes, twice the launcher check's, since its wipe walks whatever
 * a case left under /output, /tmp and /dev/shm, file by file under gVisor. It waits on nothing else: its kill rounds are
 * at most SESSION_RESET_ROUNDS × SESSION_RESET_PAUSE_MS (1 s).
 */
export const SESSION_RESET_TIMEOUT_MS = 120_000;
/** How much the launcher check's exec may take, from the call: its probe gives up within CASE_LOOPBACK_PROBE_SECONDS. */
export const SESSION_CHECK_TIMEOUT_MS = 60_000;
/** The tail of a session's label (grader/program.ts executePerCase opens it as `<label>-cases`), kept when the label is cut to fit. */
export const SESSION_LABEL_TAIL = '-cases';
/** The longest sandbox label (docker.ts checkSandboxLabel: what a pod name carries). */
const SANDBOX_LABEL_MAX = 41;

/**
 * The label a session's pods are named for (podName): `label` when it is a sandbox label (docker.ts checkSandboxLabel),
 * else its stem (less a SESSION_LABEL_TAIL) cut so that it and the tail fit SANDBOX_LABEL_MAX, trailing dashes dropped,
 * then the tail: a session label longer than a pod name takes (`grade-dev-<window key>-<n>-cases`) never fails a grade
 * whose per-case labels (`<label>-c<i>`) fit. A label with anything a sandbox label may not hold is a SandboxError, as
 * its per-case pods' would be.
 */
export function sessionPodLabel(label: string): string {
  if (typeof label !== 'string') throw new SandboxError(`a session's label must be a string, not ${JSON.stringify(label)}`);
  try {
    return checkSandboxLabel(label);
  } catch {
    const stem = label.endsWith(SESSION_LABEL_TAIL) ? label.slice(0, -SESSION_LABEL_TAIL.length) : label;
    return checkSandboxLabel(`${stem.slice(0, SANDBOX_LABEL_MAX - SESSION_LABEL_TAIL.length).replace(/-+$/, '')}${SESSION_LABEL_TAIL}`);
  }
}

/** What a K8sSession is given of its sandbox (k8s.ts K8sSandbox #sessionHost). */
export interface K8sSessionHost {
  readonly ctx: K8sContext;
  readonly placement: PodPlacement;
  readonly images: ImageTableT;
  readonly runtimeClass: string | null;
  /** The sandbox itself: kind, imageDigest, preflight, isDriverFailure, removeTree, and a degraded session's spawns. */
  readonly sandbox: Sandbox;
  /** The drawn placement of a pod about to be made (k8s.ts's header: Room on the node), or null for none. */
  prefer(pod: string): Promise<NodePreference | null>;
  /** A session pod's env Secret (k8s.ts sandboxEnvSecret, a program pod's marks: its agents' K), or null when the spec has nothing for one. */
  envSecret(spec: SandboxSpec, pod: string): K8sObject | null;
  /**
   * The agents' spec of a session pod (k8s.ts PodAgentSpec): `read`, the one a pod is made with, read as it is made
   * (K8sSandbox.agentSpec); `check`, the one a pod is only built with to be checked (K8sSandbox.agentCheckSpec), the two
   * K8sSandbox #sessionHost hands in. Absent: the placement's `agent` (sessionAgentOf).
   */
  readonly agent?: SessionAgentSource;
  /**
   * One run's process, a K8sProcess in its session mode (k8s.ts Launch.session), its pod readied by `session`; `env`
   * its program's own variables (its spec's secrets, the template's: k8s.ts's header, Exec env), which its exec carries.
   */
  spawnRun(run: { name: string; mounts: readonly SandboxMount[]; pids: number; env: ReadonlyArray<readonly [string, string]>; session: SessionLaunch }): K8sProcess;
  /**
   * The sandbox's warm pool (k8s.ts's header: Warm pool; k8s-pool.ts), which a session's boot asks for a pod of its
   * session pod's shape before it makes one (K8sSession #boot), or absent/null: every session pod made for its boot.
   */
  readonly pool?: K8sWarmPool<K8sPoolShape> | null;
}

/** Where a session's pods get their agents' spec (K8sSessionHost.agent). */
export interface SessionAgentSource {
  check(): PodAgentSpec;
  read(): Promise<PodAgentSpec>;
}

/**
 * `host`'s agents' spec (K8sSessionHost.agent): its own source (a K8sSandbox's agentCheckSpec and agentSpec, which
 * #sessionHost hands in); else the placement's `agent`, as known when the session opened; else none, and
 * sandboxPodSpec refuses the pod (no agent image).
 */
export function sessionAgentOf(host: Pick<K8sSessionHost, 'agent' | 'placement'>): { check(): PodAgentSpec | undefined; read(): Promise<PodAgentSpec | undefined> } {
  if (host.agent !== undefined) {
    const own = host.agent;
    return { check: () => own.check(), read: () => own.read() };
  }
  const placed = host.placement.agent;
  return { check: () => placed, read: () => Promise.resolve(placed) };
}

/**
 * One exec of `argv` into session pod `pod`'s `main` (the header: the launcher check, the reset) over its `watch` agent
 * session (`watch`; null: none, the exec ended at once, nothing sent), which relays it to `main`'s shim (k8s.ts
 * agentMember): `input` on its stdin, then EOF, and its end as a KubectlResult, stdout and stderr whole. `error` says
 * an end that is no exit: cut at `timeoutMs` from the call or once `signal` aborts (the exec killed), never opened, or
 * lost with the session or the shim. Sent once, never again (agent-client.ts's no re-send).
 */
export async function mainExec(watch: PodAgentSession | null, pod: string, argv: readonly string[], o: { input: string; timeoutMs: number; signal: AbortSignal }): Promise<KubectlResult> {
  const child = agentMember(watch, pod, CONTAINER).stream(argv);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (b: Buffer) => out.push(b));
  child.stderr.on('data', (b: Buffer) => err.push(b));
  child.stdin.on('error', () => undefined);
  let cut: string | null = null;
  const stop = (said: string): void => {
    cut ??= said;
    child.kill();
  };
  const timer = setTimeout(() => stop(`no exit within ${o.timeoutMs} ms`), o.timeoutMs);
  timer.unref();
  const onAbort = (): void => stop('cut off');
  o.signal.addEventListener('abort', onAbort, { once: true });
  if (o.signal.aborted) onAbort();
  child.stdin.end(o.input);
  const end = await child.closed;
  clearTimeout(timer);
  o.signal.removeEventListener('abort', onAbort);
  const r: KubectlResult = { code: end.code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  if (cut !== null) r.error = `pod ${pod}: exec ${CONTAINER}: ${cut}`;
  else if (end.error !== undefined) r.error = end.error;
  else if (end.code === null) r.error = `pod ${pod}: exec ${CONTAINER}: ended by ${end.signal ?? 'nothing'}`;
  return r;
}

/** A session's pod (K8sSession), from its boot until it is spent or the session closed. */
interface SessionPod {
  readonly name: string;
  /** What its boot made (`pod/<name>`, its Secret): deleted once. */
  readonly refs: readonly string[];
  /**
   * Its `watch` agent's session (bootPod's; every session pod has `watch`, so null only where a boot says so), held for
   * the pod's life: each run's watch execs, collect and watch probe (SessionPrepared.watch), the restage, and the
   * launcher check and resets into `main` (mainExec) go over it; closed after the pod's delete.
   */
  readonly watch: PodAgentSession | null;
  /** The case launcher runs in it (the launcher check): its cases run under SESSION_EXEC_WRAPPER. False: it runs the one case it was booted for, then goes. */
  readonly isolated: boolean;
  /** A case's program was started in it: the next run's reset comes first. */
  used: boolean;
  /** Its delete was sent. */
  retired: boolean;
}

/** One run's hold on its session pod: the pod it was readied in (prepare), until it is settled. */
interface RunHold {
  pod: SessionPod | null;
}

/** Why the pod could not take a run (#reset, #restage): spent (another pod may), or the run's own driver failure. */
type PodTrouble = { spent: true; why: string } | { spent: false; exit: SandboxExit };

/**
 * A case session on the k8s driver (the header; types.ts SandboxSession): the runs of one per-file program/v1 execution,
 * one after another in one session pod. Opened by K8sSandbox.sessions.open: a template checkSessionTemplate refuses, a
 * label no pod name can carry, or a pod sessionPodSpec refuses is a SandboxError here, before anything is made. Nothing
 * reaches the cluster until the first spawn.
 */
export class K8sSession implements SandboxSession {
  readonly kind = 'k8s' as const;
  readonly #host: K8sSessionHost;
  readonly #template: SandboxSpec;
  /** What its pods are named for (sessionPodLabel). */
  readonly #label: string;
  readonly #image: string;
  readonly #digest: string;
  /** The wrapper's process cap (a fresh pod's: the run's pids and POD_OWN_TASKS; 0 under no RuntimeClass). */
  readonly #pids: number;
  /** The program a run's wrapper starts, under the case launcher or alone. */
  readonly #program: readonly string[];
  /** The template's writable mounts' volume names (readPodVerdict's evictions). */
  readonly #writable: readonly string[];
  /** Its pods' agents' spec (sessionAgentOf). */
  readonly #agent: ReturnType<typeof sessionAgentOf>;
  /** The shims its pods declare (k8s.ts shimMembersOf: `main`), which a taken warm pod's boot holds to the shim gate. */
  readonly #members: readonly string[];
  #pod: SessionPod | null = null;
  /** Its session pods' warm pool shape (#poolShapeOf), or null: no pool, or a Secret holding more than K. */
  readonly #shape: K8sPoolShape | null;
  /** The name the next boot makes its pod by, minted by a spawn with no pod (the run's pod until it is readied). */
  #nextName: string | null = null;
  #live: SandboxProcess | null = null;
  /** The launcher check failed: every spawn from here is the sandbox's own program pod. */
  #degraded = false;
  #warned = false;
  #closed = false;
  #closing: Promise<void> | null = null;
  /** Deletes sent and not yet answered: a boot waits for them, close() too. */
  readonly #retiring = new Set<Promise<void>>();

  constructor(host: K8sSessionHost, template: SandboxSpec) {
    checkSessionTemplate(template);
    this.#host = host;
    this.#template = template;
    this.#label = sessionPodLabel(template.label);
    const entry = imageFor(template.runtime, host.images);
    this.#image = entry.image;
    this.#digest = template.imageDigest ?? entry.digest;
    this.#agent = sessionAgentOf(host);
    // Built now so a template the pod refuses throws here, as a spawn's does (its agents' spec the one a pod is only
    // checked with); built again as each pod is made, on the agents' spec read then.
    this.#members = Object.freeze(shimMembersOf(sessionPodSpec(template, this.#podOptions(podName(this.#label), null, this.#agent.check()))));
    this.#pids = host.runtimeClass === null ? 0 : Number(positiveInt(template.limits.pids, 'pids')) + POD_OWN_TASKS;
    this.#program = Object.freeze([...RUNTIME_COMMANDS[template.runtime], `/bot/${scriptOf(template)}`]);
    this.#writable = Object.freeze(
      checkSandboxMounts(template.mounts)
        .filter((m) => !m.readOnly)
        .map((m) => mountVolumeName(m.at)),
    );
    this.#shape = (host.pool ?? null) === null ? null : this.#poolShapeOf();
  }

  /**
   * Its session pod's warm pool shape (k8s.ts's header: Pool-ready and Warm pool): keyed by shapeKeyOf of the pod and
   * Secret as made (on the agents' spec it is checked with), its refills built for their own names from the template
   * with its secrets taken out (they are each run's exec's), their own drawn placement and the agents' spec read then;
   * null when its Secret would hold anything but K.
   */
  #poolShapeOf(): K8sPoolShape | null {
    const { secrets: _secrets, ...template } = this.#template;
    const probe = podName(this.#label);
    const secret = this.#host.envSecret(template, probe);
    if (secret === null || Object.keys((secret.stringData as Record<string, unknown> | undefined) ?? {}).join(',') !== AGENT_KEY_ENV) return null;
    const key = shapeKeyOf(sessionPodSpec(template, this.#podOptions(probe, null, this.#agent.check())), secret);
    return {
      key,
      label: this.#label,
      build: async (name) => {
        let prefer: NodePreference | null;
        try {
          prefer = await this.#host.prefer(name);
        } catch {
          prefer = null;
        }
        const pod = sessionPodSpec(template, { ...this.#podOptions(name, prefer, await this.#agent.read()), pool: key });
        const made = this.#host.envSecret(template, name);
        if (made === null) throw new SandboxError(`pod ${name}: a session pod's Secret holds its agents' K`);
        return { pod, secret: made };
      },
    };
  }

  imageDigest(runtime: Runtime): string | null {
    return this.#host.sandbox.imageDigest(runtime);
  }

  preflight(runtime: Runtime, imageDigest?: string | null): Promise<void> {
    return this.#host.sandbox.preflight(runtime, imageDigest);
  }

  isDriverFailure(exit: SandboxExit): boolean {
    return this.#host.sandbox.isDriverFailure(exit);
  }

  removeTree(dir: string): Promise<void> {
    return this.#host.sandbox.removeTree(dir);
  }

  /**
   * One run (the header): its spec checkSessionRun's, its mounts under the data root, each writable mount's host
   * directory empty, no run live and the session open, else a SandboxError before anything starts. A K8sProcess in its
   * session mode, readied in the session's pod; a degraded session's, the sandbox's own program pod.
   */
  spawn(spec: SandboxSpec): SandboxProcess {
    if (this.#closed) throw new SandboxError(`session ${this.#label} is closed: it runs nothing more`);
    if (this.#live !== null) throw new SandboxError(`session ${this.#label} runs one program at a time, and one is live`);
    checkSessionRun(this.#template, spec);
    const mounts = checkSandboxMounts(spec.mounts);
    for (const m of mounts) checkUnderDataRoot(this.#host.placement.dataRoot, m.host);
    for (const m of mounts) {
      if (m.readOnly) continue;
      let names: string[];
      try {
        names = readdirSync(m.host);
      } catch (err) {
        throw new SandboxError(`session ${this.#label}: ${m.host} (for ${m.at}) does not read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      }
      // `watch` holds a writable mount read-only: no seed file of the host's could reach `main`, so none may be there.
      if (names.length > 0) throw new SandboxError(`session ${this.#label}: a session's run starts with its writable mounts empty, and ${m.host} (for ${m.at}) holds ${names.length} entries`);
    }
    let proc: SandboxProcess;
    if (this.#degraded) proc = this.#host.sandbox.spawn(spec);
    else {
      const hold: RunHold = { pod: null };
      proc = this.#host.spawnRun({
        name: this.#pod?.name ?? (this.#nextName ??= podName(this.#label)),
        mounts,
        pids: this.#pids,
        env: checkSandboxSecrets(spec),
        session: {
          prepare: (signal) => this.#prepare(hold, mounts, signal),
          settle: (end) => this.#settle(hold, end),
        },
      });
    }
    this.#live = proc;
    void proc.exited.finally(() => {
      if (this.#live === proc) this.#live = null;
    });
    return proc;
  }

  /** The live run's writable mount `dir` (its K8sProcess.meter): a SandboxError when no live run mounts it writable. */
  meterTree(dir: string, opts: TreeMeterOptions): TreeMeter {
    checkHostPath(dir);
    const live = this.#live;
    if (live instanceof K8sProcess && !live.programOver && live.writableAt(dir) !== null) return live.meter(dir, opts);
    throw new SandboxError(`no live run of session ${this.#label} mounts ${dir} writable: its meter runs in the watch container of the run's pod, asked for right after its spawn`);
  }

  /** Kill a run still live, delete the pod once (and any spent one not yet answered); never rejects. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#closed = true;
      const live = this.#live;
      if (live !== null) await live.kill();
      const pod = this.#pod;
      if (pod !== null) this.#retire(pod);
      await Promise.all([...this.#retiring]);
    })().catch(() => undefined);
    return this.#closing;
  }

  #podOptions(name: string, prefer: NodePreference | null, agent: PodAgentSpec | undefined): SandboxPodOptions {
    return {
      ...this.#host.placement,
      name,
      image: this.#image,
      digest: this.#digest,
      hostAliases: [],
      owner: null,
      ...(agent === undefined ? {} : { agent }),
      ...(prefer === null ? {} : { prefer }),
    };
  }

  /** SessionLaunch.prepare: never rejects (a throw is the run's driver failure). */
  async #prepare(hold: RunHold, mounts: readonly SandboxMount[], signal: AbortSignal): Promise<SessionPrepared> {
    try {
      return await this.#ready(hold, mounts, signal);
    } catch (err) {
      return {
        ok: false,
        exit: failure(`session ${this.#label}: ${err instanceof Error ? err.message : String(err)}`),
      };
    }
  }

  /**
   * The pod for one run (the header): booted when there is none (no reset then), else reset when a case ran in it; its
   * read-only mounts restaged. A pod the reset or the restage found spent is deleted and a fresh one booted for this same
   * run, once: a fresh pod's restage that fails is the run's failure.
   */
  async #ready(hold: RunHold, mounts: readonly SandboxMount[], signal: AbortSignal): Promise<SessionPrepared> {
    let fresh = false;
    for (;;) {
      if (signal.aborted) return { ok: false, exit: killedExit() };
      if (this.#closed)
        return {
          ok: false,
          exit: failure(`session ${this.#label} was closed before its run started`),
        };
      let pod = this.#pod;
      if (pod === null) {
        const booted = await this.#boot(signal);
        if (!booted.ok) return { ok: false, exit: booted.exit, noRoom: booted.noRoom };
        pod = booted.pod;
        fresh = true;
      } else if (pod.used) {
        const trouble = await this.#reset(pod, signal);
        if (trouble !== null) {
          this.#retire(pod);
          if (signal.aborted) return { ok: false, exit: killedExit() };
          if (trouble.spent) continue;
          return { ok: false, exit: trouble.exit };
        }
      }
      const trouble = await this.#restage(pod, mounts, signal);
      if (trouble !== null) {
        this.#retire(pod);
        if (signal.aborted) return { ok: false, exit: killedExit() };
        if (trouble.spent && !fresh) continue;
        return {
          ok: false,
          exit: trouble.spent ? failure(`pod ${pod.name}, fresh: ${trouble.why}`) : trouble.exit,
        };
      }
      hold.pod = pod;
      return pod.isolated
        ? {
            ok: true,
            pod: pod.name,
            wrapper: SESSION_EXEC_WRAPPER,
            argv: caseLauncherArgv(this.#program),
            report: CASE_LAUNCHER_OK,
            watch: pod.watch,
          }
        : {
            ok: true,
            pod: pod.name,
            wrapper: EXEC_WRAPPER,
            argv: [...this.#program],
            report: null,
            watch: pod.watch,
          };
    }
  }

  /**
   * A fresh session pod (the header's boot): what a spent pod's delete was waiting on answered, its Secret and the pod
   * (sessionPodSpec, on the agents' spec read now) made in one List, /bot staged over its `stage` agent, Ready, its `watch`
   * agent's session opened (bootPod), then the launcher check. Whatever fails, what it made is deleted and that session
   * closed.
   */
  async #boot(signal: AbortSignal): Promise<{ ok: true; pod: SessionPod } | { ok: false; exit: SandboxExit; noRoom: string | null }> {
    await Promise.all([...this.#retiring]);
    const ctx = this.#host.ctx;
    const pool = this.#host.pool ?? null;
    const bootAt = Date.now();
    const trees = [{ mount: SESSION_CODE_DIR, dir: this.#template.codeDir }];
    // Its warm pool first (k8s.ts's header: Warm pool): a pod it hands over is this session's pod from here, booted on
    // from its `stage` agent (bootTakenPod: /bot staged, Ready, `watch`); none, one made for it as before.
    const taken = this.#shape === null || pool === null || signal.aborted ? null : await pool.take(this.#shape);
    let name: string;
    let refs: readonly string[];
    let booted: Awaited<ReturnType<typeof bootPod>>;
    if (taken !== null) {
      this.#nextName = null;
      name = taken.name;
      refs = taken.refs;
      // The warm init clock: from this boot's call (its first run's prepare) to the taken pod's agent at the claim.
      recordInit('agent', (Date.now() - bootAt) / 1000, 'warm');
      // Its shims (`main`'s, the session reaper) held to the shim gate: a warm pod keeps no spec to read them from.
      booted = await bootTakenPod(ctx, taken, { trees, signal, killed: () => signal.aborted, members: this.#members });
    } else {
      name = this.#nextName ?? podName(this.#label);
      this.#nextName = null;
      let prefer: NodePreference | null;
      try {
        prefer = await this.#host.prefer(name);
      } catch {
        prefer = null;
      }
      const spec = sessionPodSpec(this.#template, this.#podOptions(name, prefer, await this.#agent.read()));
      const secret = this.#host.envSecret(this.#template, name);
      refs = [`pod/${name}`, ...(secret === null ? [] : [`secret/${secret.metadata.name}`])];
      booted = await bootPod(ctx, {
        name,
        objects: [spec],
        secret,
        trees,
        signal,
        killed: () => signal.aborted,
        ...(pool === null ? {} : { onAgent: (ms: number) => pool.noteBoot(ms) }),
      });
    }
    if (!booted.ok) {
      await deleteObjects(ctx, refs);
      return booted;
    }
    const unchecked = await this.#launcherFails(name, booted.watch, signal);
    if (signal.aborted) {
      await deleteObjects(ctx, refs);
      await booted.watch?.close().catch(() => undefined);
      return { ok: false, exit: killedExit(), noRoom: null };
    }
    if (unchecked !== null) {
      this.#degraded = true;
      if (!this.#warned) {
        this.#warned = true;
        ctx.warn(`k8s sandbox: session ${this.#label}: the case launcher does not run in pod ${name}, or gives its case no loopback (${unchecked}): its first case runs there alone, and every later case in a pod of its own`);
      }
    }
    const pod: SessionPod = {
      name,
      refs,
      watch: booted.watch,
      isolated: unchecked === null,
      used: false,
      retired: false,
    };
    this.#pod = pod;
    return { ok: true, pod };
  }

  /**
   * The launcher check (the header): the loopback probe (CASE_LOOPBACK_PROBE) under SESSION_EXEC_WRAPPER and the case
   * launcher, in `main` over the pod's `watch` session (mainExec), so both the launcher and a loopback inside the case's
   * own network namespace are proven. Null when its stdout is the start line, `RS<nonce>iok` and the sentinel 0,
   * exactly, and the exec exited 0; else what it said (its stdout, the exec's end, and the first line of its stderr,
   * where the launcher and the probe say why).
   */
  async #launcherFails(pod: string, watch: PodAgentSession | null, signal: AbortSignal): Promise<string | null> {
    const nonce = randomBytes(16).toString('hex');
    const r = await mainExec(watch, pod, ['/bin/sh', '-c', SESSION_EXEC_WRAPPER, 'sh', String(this.#pids), ...caseLauncherArgv(CASE_LOOPBACK_PROBE)], {
      input: `${nonce}\n`,
      signal,
      timeoutMs: SESSION_CHECK_TIMEOUT_MS,
    });
    const head = `${SENTINEL_MARK}${nonce}`;
    if (r.code === 0 && r.error === undefined && r.stdout === `${head}\n${head}${SESSION_REPORT_TAG}${CASE_LAUNCHER_OK}\n${head}0\n`) return null;
    const hide = (s: string): string => JSON.stringify(s.split(nonce).join('<nonce>').slice(0, 200));
    const said = r.stderr
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '' && !l.startsWith('Warning:'));
    const end = r.error ?? (r.code === null ? 'no answer' : `exit ${r.code}`);
    return `its check printed ${hide(r.stdout)}, ${end}${said === undefined ? '' : `, stderr ${hide(said)}`}`;
  }

  /**
   * The reset before a case (the header), in `main` over the pod's `watch` session (mainExec): null once it says clean.
   * Spent when it says dirty, is cut off or lost (its stream ended with no exit: the session, the shim or the pod gone),
   * or fails in a pod readPodVerdict finds out of memory, evicted for its own volume, or with `main` ended by its own
   * program; any other failure the run's driver failure.
   */
  async #reset(pod: SessionPod, signal: AbortSignal): Promise<PodTrouble | null> {
    const ctx = this.#host.ctx;
    const nonce = randomBytes(16).toString('hex');
    const r = await mainExec(pod.watch, pod.name, sessionResetArgv(this.#template), { input: `${nonce}\n`, signal, timeoutMs: SESSION_RESET_TIMEOUT_MS });
    if (signal.aborted) return { spent: true, why: 'the reset was cut off by the kill' };
    const verdict = r.error === undefined ? parseSessionReset(r.stdout, nonce) : null;
    if (verdict !== null) {
      if (verdict.clean && r.code === 0) return null;
      return {
        spent: true,
        why: verdict.clean ? `the reset said clean but exited ${r.code}` : `the reset found it dirty: ${verdict.why}`,
      };
    }
    if (r.error !== undefined) return { spent: true, why: `the reset was cut off: ${r.error}` };
    const read = await readPodVerdict(ctx, pod.name, {
      writable: this.#writable,
      ownKill: true,
      watch: pod.watch,
    });
    if (read.killed)
      return {
        spent: true,
        why: `the reset failed (${why(r)}) in a pod ended by ${read.kill}`,
      };
    return {
      spent: false,
      exit: failure(`pod ${pod.name}: the reset between two cases failed (${why(r)}); ${read.said}`),
    };
  }

  /**
   * The restage of a run's read-only mounts (the header; stageStream into `watch` over the pod's `watch` agent session,
   * restageCommand): null once acked, or when it has none. It holds no slot of the sandbox pace and cuts nothing there:
   * an agent exec never touches the control plane (k8s.ts's header: the pace). A kill while it streams spends the pod. A
   * failure in a pod readPodVerdict finds out of memory, evicted for its own volume, or with `main` ended by its own
   * program spends it; any other (a pod with no `watch` session among them) is the run's driver failure.
   */
  async #restage(pod: SessionPod, mounts: readonly SandboxMount[], signal: AbortSignal): Promise<PodTrouble | null> {
    const trees = mounts.filter((m) => m.readOnly).map((m) => ({ mount: restageMountPath(m.at), dir: m.host }));
    if (trees.length === 0) return null;
    const ctx = this.#host.ctx;
    let lost: string;
    if (pod.watch === null) lost = `pod ${pod.name}: no ${WATCH_CONTAINER} agent session to restage its read-only mounts over`;
    else {
      try {
        await stageStream(
          { agent: pod.watch, warn: ctx.warn },
          {
            pod: pod.name,
            container: WATCH_CONTAINER,
            trees,
            signal,
            command: (unpack) => restageCommand(unpack),
          },
        );
        return null;
      } catch (err) {
        lost = err instanceof Error ? err.message : String(err);
      }
    }
    if (signal.aborted) return { spent: true, why: 'the restage was cut off by the kill' };
    const read = await readPodVerdict(ctx, pod.name, {
      writable: this.#writable,
      ownKill: true,
      watch: pod.watch,
    });
    if (read.killed) return { spent: true, why: `${lost}, in a pod ended by ${read.kill}` };
    return { spent: false, exit: failure(`${lost}; ${read.said}`) };
  }

  /**
   * SessionLaunch.settle: a run's end. Its pod is spent (deleted; the next spawn boots a fresh one) when the pod ended it
   * (podKill), its end is the driver's failure, its kill failed, or the pod has no launcher (it ran its one case); kept
   * otherwise, used once the run's exec started.
   */
  #settle(hold: RunHold, end: SessionRunEnd): void {
    const pod = hold.pod;
    hold.pod = null;
    if (pod === null || this.#pod !== pod) return;
    const driverFailed = end.exit.code === K8S_DRIVER_FAILURE && end.exit.error !== undefined;
    if (!pod.isolated || end.podKill !== null || end.killFailed || driverFailed) {
      this.#retire(pod);
      return;
    }
    if (end.execStarted) pod.used = true;
  }

  /**
   * The pod given up: no run is readied in it again, its delete is sent once (deleteObjects warns of one that never
   * took), and its `watch` agent's session closed once that delete has answered.
   */
  #retire(pod: SessionPod): void {
    if (this.#pod === pod) this.#pod = null;
    if (pod.retired) return;
    pod.retired = true;
    const sent: Promise<void> = deleteObjects(this.#host.ctx, pod.refs)
      .catch(() => undefined)
      .then(() => pod.watch?.close())
      .catch(() => undefined)
      .finally(() => this.#retiring.delete(sent));
    this.#retiring.add(sent);
  }
}
