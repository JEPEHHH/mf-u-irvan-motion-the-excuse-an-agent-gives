// The production sandbox: one `docker run` per program, built as an argv array (never a shell
// string), every program started the same way:
//
//   docker run -i --rm --name makefun-<label>-<hex> --label makefun.grader=1 --pull missing
//     --network none --cap-drop ALL --security-opt no-new-privileges --read-only
//     --tmpfs /tmp:rw,size=256m -u 65534:65534
//     --memory <memory_mb>m --memory-swap <memory_mb>m --cpus <cpus> --pids-limit <pids>
//                                                       (a spec with cpusCeiling: at most the host's CPUs, grantedCpus)
//     --log-driver none -e TZ=UTC -e PYTHONHASHSEED=0 -e LANG=C.UTF-8
//     [--runtime runsc]                                 when MAKEFUN_DOCKER_RUNTIME names one
//                                                       (then --pids-limit 32 + 3 × pids: RUNTIME_PIDS)
//     -v <code dir>:/bot:ro [-v <dir>:/input:ro ...]    the snapshot, and program/v1's mounts
//     -e MAKEFUN_<MOUNT>=<mount point>                  each of the spec's mounts but /state and /record
//                                                       (types.ts containerMountEnv): its stand-in variable,
//                                                       set to the mount's own path as the process driver
//                                                       sets it to the host directory
//     --entrypoint node|python3 <image>@sha256:<digest> [-P -s] /bot/<script>
//
// No network, no capabilities, no privilege escalation, a read-only root with a 256 MB /tmp, the
// nobody user, memory without swap, CPU and process caps from the competition's limits, and no
// container log (stdio is attached, so the harness still reads it). The environment is exactly the
// three variables above, the mounts' stand-ins and what the image itself sets: nothing of the host's.
// The entrypoint is
// fixed per runtime (`--entrypoint` overrides any image ENTRYPOINT, e.g. node's docker-entrypoint.sh),
// the image is a digest (never a tag). Nothing pre-pulls the pinned images onto a docker host:
// preflight (DockerSandbox.preflight) pulls one the daemon lacks, by its digest, before anything runs
// in it, and `--pull missing` (PULL_POLICY) lets the daemon fetch it by that digest should it be gone
// by the run; either way what runs is what grader/images.json pins, and the container itself still
// has no network. The dataset is never mounted: replay events reach the bot only over stdin.
//
// Under gVisor (MAKEFUN_DOCKER_RUNTIME=runsc, s7) every flag stays, the internal networks and the
// egress bridge included. The runtime must be registered with `--network=host`, because gVisor's own
// network stack cannot reach Docker's embedded DNS, which the trial networks' aliases need. The host
// pids cgroup `--pids-limit` sets also holds the sandbox's own tasks, so a runtime that has them gets
// room for them on top of the competition's pids (pidsLimit, RUNTIME_PIDS). The sentry's ~10 MiB
// counts against `--memory` too, which stays as given.
//
// Or under gVisor on its own network stack (MAKEFUN_DOCKER_RUNTIME=runsc-netstack, NETSTACK_RUNTIME:
// the same runsc registered without --network=host): the sandbox answers its interfaces itself, so the
// host kernel's TCP/IP never handles what a program sends. Every flag stays, the pids as under runsc,
// but Docker's embedded DNS (127.0.0.11, an iptables rule in the container's namespace) never answers
// inside such a sandbox, so a container on a trial network gets its peers' names in /etc/hosts instead
// (NetstackNames), and an egress container a resolver of the operator's:
//
//     --ip <address>                                    after the trial network's aliases
//     [--add-host <name>:<address> ...]                 after the network flags: every name a
//                                                       container on that network took before it
//     [--mount type=bind,src=<file>,dst=/etc/resolv.conf,readonly]
//                                                       an egress container's, after the mounts, when
//                                                       MAKEFUN_DOCKER_RESOLV_CONF names a host file
//
// The address is the next of the subnet the daemon gave the network (`docker network inspect`, once
// per network), host 2 on, one per container in spawn order; its aliases and hosts go to every
// container spawned on that network after it. So a name reaches only later containers: a trial
// spawns its services before its entry (types.ts's Sandbox contract, as on k8s), the entry calls the
// store and `llm` by name, and with a target the env calls `house`, which agent.ts spawns, and waits
// ready, before the env. Without the resolv.conf an egress container resolves nothing (the scrape
// gateway never does; a forwarder given masq by name is refused at its trial's start, agent.ts).
// #95 and #96 measured it on s7 (Docker 29.4.1, runsc release-20261102.0): an --add-host name
// resolves through getaddrinfo (Node's dns.lookup, getent, Python's), while a --network-alias does
// not (EAI_AGAIN) and dns.resolve4 is refused (ECONNREFUSED); --ip takes an address of the subnet the
// daemon allocated, the internal network's inhibit_ipv4 bridge reserving no gateway; the gateway
// binds 0.0.0.0:443 as 65534 with no capability; a container on both networks routes out by the
// egress bridge alone; `--dns` changes nothing (resolv.conf keeps 127.0.0.11 on a user-defined
// network), and a bind-mounted resolv.conf naming 1.1.1.1 resolves example.com.
//
// An agent trial's containers (grader/sandbox/network.ts) differ in two places, everything else kept:
// `--network none` becomes the trial's internal network, first, with the spec's aliases, and for the
// forwarder the host's egress bridge after it (the legacy `--network-alias` attaches to the first
// `--network`, so the alias is never on the egress bridge):
//
//     --network makefun-net-<trial> [--network-alias <alias> ...] [--network makefun-egress]
//
// and the spec's `env` (MAKEFUN_*, the base URLs, the dummy keys: types.ts checkSandboxEnv) follows
// the three variables, in name order. A scrape trial's gateway sits the same way, its `hosts` (the
// real host names it answers for) given as more `--network-alias` flags after its aliases.
//
// A scrape trial's entry runs under the house launcher (a spec with a `launcher`; grader/scrape/
// launch.ts): the launcher is the container's PID 1, times the entry and drops it to 65534:65534,
// so the container differs from the hardened set in exactly these places (#2208 measured this set):
//
//     --dns-opt ndots:0                                 after the network flags (a spec with a network)
//     --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL
//     -u 0:0                                            root, holding only those three
//     -v <house dir>:/house:ro                          after /bot: the launcher, launch.json, ca.pem
//     --entrypoint node <image> /house/launch.ts        or python3 <image> /house/launch.py
//
// no-new-privileges, the read-only root, the 256 MB /tmp, the limits, `--pull missing` and the rest
// stay. The entry the launcher starts gets launch.json's argv and env, so such a spec has no `script`
// and no `env`. The container is attached like every other (`docker run -i`, stdin and stdout held
// by the grader): grader/scrape/launch.ts LauncherSession reads `ready` and the result there and
// writes `go`. No `--init`: PID 1 is the launcher, and the leftovers it kills stay zombies until the
// container goes.
//
// A race's racer (a spec's `race`, grader/race.ts runRacer, types.ts's header) is the same long-lived container,
// attached the same way for the whole race window, with one difference: in place of `--label makefun.grader=1`
//
//     --label makefun.race=<deadline>                   RACE_LABEL; the deadline is epoch ms, its spawn plus
//                                                       race.lifetimeMs
//
// so sweepStale (network.ts), which takes grader containers older than six hours, never sees it, and
// sweepExpiredRaces (network.ts, TrialNetworks.sweepRaces) removes it once that deadline has passed: what a
// racer that died left running, its `docker run` client gone (its bot sees stdin close; one that ignores it
// runs on to the deadline).
//
// Secrets: a spec's `secrets` (types.ts checkSandboxSecrets) never go on the argv, which any user of the host
// can read (ps), nor into the docker CLI's own environment (`-e NAME` alone takes the value from there), where a
// secret's name would be one of the CLI's own variables (DOCKER_HOST, DOCKER_CONFIG, the proxies). They go in an
// env file, after the spec's env:
//
//     --env-file <dir>/secrets.env --cidfile <dir>/container.id
//
// <dir> is the spawn's own directory (mkdtemp, 0700) under DockerSandboxOptions.secretsDir, the env file 0600 with
// one NAME=value line a secret in name order (secretsEnvFile). The CLI reads the env file before it asks the daemon
// to create the container (docker/cli's parse, then createContainer), and writes the new container's id to the cid
// file once the daemon has created it. So the directory is removed as soon as the id is there (looked for every
// SECRETS_POLL_MS, doubling to SECRETS_POLL_MAX_MS), or once the client has ended, whichever comes first, and at
// the latest when this process exits. docker's env-file format (docker/cli pkg/kvfile) has no quoting or escape,
// so a value holding a line break (CR or LF) cannot be carried: such a spec is a SandboxError naming the secret,
// before anything is written (k8s.ts and process.ts carry one). The values stay in the container's config, which
// `docker inspect` shows whoever holds the daemon's socket, as every `-e` value does.
//
// A patch/v1 run (a spec's `image`, types.ts's header) runs in the competition's repository image by its
// digest, no network, with every hardening flag kept; it differs in these places:
//
//     --pull never                                      in place of `--pull missing` (REPO_IMAGE_PULL_POLICY):
//                                                       the pack check found it on this host, and a grading
//                                                       never fetches a competition's image
//
//     --tmpfs /work:rw,exec,nosuid,size=<mb>m,mode=1777  after /tmp: a spec's `work` (any spec may take one)
//     -v <dir>:/base:ro -v <dir>:/tests:ro              its mounts, as any spec's
//     --entrypoint <argv[0]> <repository>@<digest> <argv[1..]>
//                                                       the image's argv in place of the interpreter
//                                                       and /bot/<script>
//
// /work is a tmpfs, so what the entrant writes there is RAM in the container's memory cgroup (held to
// `--memory` with /tmp's), never the grader's disk; exec, since the repository's own build runs there.
// The pack check asks imagePresent whether the daemon holds a competition's image before it runs one.
//
// Killing: a container outlives a killed `docker run` client, so kill() removes it by name
// (`docker rm -f`), and goes on removing it until docker has it gone (removeContainer). A kill can land
// before the daemon has created the container (a loaded one takes seconds): rm then finds nothing, the
// container is created after it and runs to its own end, its client SIGKILLed or not (with -i the
// client going only closes the container's stdin; --rm removes it once it exits). So while the client
// runs, rm -f is sent again (REMOVE_BACKOFF_MS, doubling) until one removes the container; the client
// then exits by itself, since `docker run --rm` exits only once its container is removed, which is
// docker's own word that it is gone. A client still there after CLIENT_KILL_MS is SIGKILLed, and as a
// create or start it sent may land yet, removal goes on until an rm -f removes the container or finds it
// gone after one found it there: for REMOVE_CONFIRM_MS from the kill at most, a container docker never
// said was gone then warned of. The meter, the CPU clock and a reclaim cut off go the same way.
// `docker rm -f` answers for itself: it prints the name when it removed the container, and nothing
// (Docker 23 on: exit 0) or `No such container` (before) when there is none.
//
// Reclaiming: on Linux what a program writes into a writable mount belongs to 65534, so this
// process cannot delete it once it made a directory there; and a tree nested past PATH_MAX (made by
// chdir) is out of reach of rm's paths (ENAMETOOLONG) whoever owns it. removeTree then deletes it from
// a reclaim container running as that user with only that mount (reclaimArgs): it gives that user's
// own directories their rwx back first (a program may leave one read-only), then deletes everything
// (chmod -R and find walk by file descriptor, so no depth is too deep for them). The
// directory handed over must be one that user can enter (a writable mount is 0777); one of this
// process's private directories above it is not, so callers hand over the mounts themselves
// (grade.ts removeScratch, instance.ts removeRun).
//
// Releasing (a daemon in a VM, Docker Desktop's on macOS): a host path reaches the VM through its file sharing, and
// the share's server (VirtioFS: Apple's Virtualization.framework serves it from its com.apple.Virtualization.
// VirtualMachine process) holds one host file descriptor, so one vnode, for every file and directory the VM's kernel
// keeps in its dentry cache: every path a container looked up or made, through any bind mount, its own container long
// removed. The kernel keeps an unused entry until memory runs short or until it looks the name up again past the
// share's entry timeout and the share says it is gone; a removal on the host tells it nothing. So a tree this process
// removes after containers used it stays open in the VM process, entry for entry, until Docker restarts: #204's
// seeding run left 61,103 on 24 deleted compile scratch roots (5,348 for a slider-captcha compile: a run directory,
// its output directory and its output for each of 1,151 program runs, the rest its cases, checker runs and code),
// and with the host's vnodes run dry an open fails ENFILE (#204's first attempt, the Mac down within a minute).
// releaseRemoved looks each removed tree up from inside the VM, from one release container (releaseArgs) holding the
// tree's parent read-only: the lookup misses, the kernel drops the entry and everything it cached under it, and the
// server closes those descriptors. A lookup within the entry timeout of the last one answers from the cache (the tree
// still there), so the container looks again every RELEASE_POLL_MS, at most RELEASE_POLLS times. It runs as nobody
// with no capability, no network, a read-only root and only that parent mounted, read-only (the share serves every
// file as the user who reads it, so nobody may look a name up in a directory that is 0700 on the host), and only where
// the daemon's host paths come through a VM (DockerSandboxOptions.sharesHostFiles, default any host but Linux): on
// Linux a bind mount is the host's own directory and holds nothing once its container is gone.
// Measured for #226 (2026-11-05, Docker Desktop 4.96.3, engine 29.9.2, LinuxKit 7.0.14, VirtioFS): a tree of 322
// entries one container read held 322 fds after the host's rm -rf, 33 s later as at once; one lookup from its parent
// released all but 4 within a second, and those with the VM's next release: the last few dozen entries a release lets
// go of stay open until the VM lets go of more, so a few dozen at most are ever left. A stale entry lasted under
// 0.5 s past the host's rm. A removal from inside the VM (rm -rf, or rmdir of a tree the host removed) releases the
// same, but needs the parent writable. One release container over #204's 24 dead roots took 1 s and closed 60,763 of the VM's 63,166 fds (the host's free vnodes 153,751 to 212,960). With the release in
// server/seeding/compile.ts and server/proposals/packs.ts, a slider-captcha compile peaked at 2,974 and ended at 36
// (#204: 5,348, all kept), a captcha-ocr one peaked at 1,425 and ended at 1.
//
// Metering: on Linux a program can make a directory in its writable mount that no other uid can look
// into (0700, or 0000 around a file it still holds open), so this process cannot count what it writes
// there until it exits. meterTree counts the whole mount while the program runs, whatever modes it set,
// from a meter container started beside it (meterArgs):
//
//   docker run -i --rm --name makefun-<label>-<hex>-meter --label makefun.grader=1 --pull missing
//     --network none --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges
//     --read-only -u 0:0 --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 16 --log-driver none
//     [--runtime runsc] -v <dir>:/measure:ro --entrypoint sh <the program's image> -c <METER script>
//
// (its --pids-limit 80 under runsc: pidsLimit). It runs as root with one capability, DAC_READ_SEARCH,
// which lets it read any file and list or enter any directory and nothing more, over the mount
// read-only; it runs in the program's own image (present, since the program just started in it).
// Every interval it prints `<entries> <bytes> <depth> <long paths>`: how many entries /measure holds
// (every inode: files, directories, links, FIFOs), its regular files' size (the larger of their
// apparent and their allocated totals), its deepest entry's depth and how many paths are past the
// path cap (find, never below the depth cap plus one; a pass stops counting once past the caps it
// was given).
// It goes when its stdin closes (stop(), or this process dying), or by itself once the program's
// budget plus METER_SLACK_MS is spent. A kernel-enforced cap would be the alternative, but none exists
// on both platforms: a size-limited tmpfs mount lives and dies inside the container, so the grader
// could not read the outputs back; a loop or quota filesystem needs root on the host; and Docker
// Desktop's file sharing has no size limit at all. A meter container works the same way wherever
// `docker run -v` does. On Docker Desktop for Mac a host path reaches the VM through that file
// sharing, which serves files as the macOS user. There a 0700 directory is the grader's own, which it
// reads itself, but one the program left without its owner's search bit (0000) stays closed to the
// meter too, until the program exits and program.ts calls it a violation. Linux paths have no such
// gap (a Linux host, or a volume inside Docker Desktop's VM).
//
// Timing (a program/v1 timing heat, grader/code-heat.ts): the CPU time a timed run's containers spent,
// read host-side from cgroup v2, never from inside the container. A timed sandbox (openCpuClock: a
// DockerSandbox with a cgroupParent) starts every entry container under one parent cgroup of its own,
// made for that clock alone:
//
//     --cgroup-parent /makefun-timing-<hex>            after --pids-limit (the cgroupfs driver), or
//     --cgroup-parent makefun_timing_<hex>.slice       under the systemd driver
//
// and nothing else goes there: its meter and reclaim containers never take the parent. cgroup v2 folds a
// child's CPU into its parent's cpu.stat usage_usec and keeps it there once the child is removed, so the
// parent's usage after a run minus its usage before is every CPU microsecond (user and system) the run's
// containers spent, however short their lives. Read by container id instead, a child's own cpu.stat is
// gone the moment its container is (`--rm`), so it can only be polled while it runs and misses the tail.
// The parent is read by a clock container (cpuClockArgs) holding /sys/fs/cgroup read-only: on a Linux
// host the host's own tree, on Docker Desktop the VM's, where the grader's process cannot look. One line
// on its stdin, one reading on its stdout (CPU_CLOCK_SCRIPT): usage_usec; `missing` while the parent does
// not exist yet (nothing ran under it: 0); `none` for a cpu.stat without it. It runs as 65534, read-only,
// with no capability and no network, under runc named outright (`--runtime runc`, CPU_CLOCK_RUNTIME), never
// the entries' runtime (MAKEFUN_DOCKER_RUNTIME) nor the daemon's default: under gVisor (runsc, the
// default on a daemon that sets default-runtime to it) the container's /sys/fs/cgroup is the sandbox's own
// sysfs, not the host's tree, and the parent's usage_usec would read gVisor's, never the entries'.
//
// Measured for #37 (2026-11-03) on this machine's sandbox: Docker Desktop 29.9.2 on macOS, LinuxKit
// kernel 7.0.14, cgroup v2, the cgroupfs driver, runc 1.5.2 (runsc is not installed here, and the remote
// box has no docker access). A 30 s probe ran a node22 container under `--cpus 1` burning 1.5 s of CPU.
// By container id (/sys/fs/cgroup/<parent>/<id>/cpu.stat), polled every 250 ms: 1 390 643 µs at the last
// poll while it ran, then missing once it exited. The parent (/sys/fs/cgroup/makefun-timing-probe-<hex>/
// cpu.stat) once it was gone: 1 514 307 µs, against 1 508 564 µs of process.cpuUsage() inside it (the
// rest is node's start before that call, and its exit). So the parent's delta is the path that works,
// and the one this driver takes. Under runsc the parent would hold the sandbox's own processes (its
// Sentry and gofer), so the CPU time would be the whole sandbox's; that and the systemd driver are
// unprobed here. grader/code-heat.ts refuses a heat whose clock reads no CPU for a run (zero), so a host
// where the path does not work stops the heat rather than rank on nothing. The parent stays behind once
// the clock closes (an empty cgroup), unless this process may remove it itself (root on a Linux host).

import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm, rmdir } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { Readable } from 'node:stream';
import { IMAGES, imageFor, imageRef, type ImageTableT } from '../images.ts';
import { CA_FILE, HOUSE_DIR, LAUNCH_CONFIG, LAUNCHER_ARGV, LAUNCHER_FILES } from '../scrape/launch.ts';
import {
  checkHostPath,
  checkSandboxImage,
  checkSandboxLauncher,
  checkSandboxRace,
  checkSandboxWork,
  containerMountEnv,
  LeftoverError,
  repoImageRef,
  RUNTIME_COMMANDS,
  SANDBOX_ENV,
  SandboxError,
  scriptOf,
  WORK_DIR,
  type Runtime,
  type Sandbox,
  type SandboxExit,
  type SandboxProcess,
  type SandboxSpec,
  type TreeMeter,
  type TreeMeterOptions,
  type TrialNetworks,
} from './types.ts';
import { checkSandboxEnv, checkSandboxNetwork, checkSandboxSecrets, EGRESS_NETWORK, type SandboxNetwork } from './types.ts';
import { checkSandboxMounts } from './mounts.ts';

/** docker run's own failure code: the daemon refused, or the container could not be created or started. */
export const DOCKER_RUN_FAILURE = 125;
export const TMPFS_SIZE = '256m';
export const NOBODY = '65534:65534';
export const CONTAINER_LABEL = 'makefun.grader=1';
/**
 * `docker run --pull` of every container in a pinned grader/images.json image (a program's, the reclaim, release,
 * meter and clock containers): the daemon fetches `<image>@<digest>` when it lacks it, by that digest, so nothing
 * moves. Nothing pre-pulls those images onto a docker host; DockerSandbox.preflight pulls a missing one before the
 * run, so the run itself finds it there. Never a tag: the reference is a digest whatever the policy.
 */
export const PULL_POLICY = 'missing';
/**
 * `docker run --pull` of a patch/v1 run in a competition's repository image (a spec's `image`): never, since the pack
 * check (imagePresent) refuses a host that does not hold it before one runs, and a grading never fetches it.
 */
export const REPO_IMAGE_PULL_POLICY = 'never';
/** How long preflight's `docker pull` of a missing pinned image may take before it is killed and the preflight fails. */
export const PULL_TIMEOUT_MS = 10 * 60_000;
/** A race container's mark in place of CONTAINER_LABEL (the header): `makefun.race=<deadline, epoch ms>`. */
export const RACE_LABEL = 'makefun.race';

/** A race container's deadline (RACE_LABEL's value): `now` (epoch ms) plus its lifetime, as a decimal of whole ms. */
export function raceDeadlineAt(now: number, lifetimeMs: number): string {
  const at = Math.ceil(now) + lifetimeMs;
  if (!Number.isSafeInteger(at) || at <= 0) throw new SandboxError(`a race's deadline ${now} + ${lifetimeMs} ms is out of range`);
  return String(at);
}
/** The capabilities the house launcher holds, and nothing else: drop the entry to 65534 (SETUID, SETGID) and kill what it leaves (KILL). */
export const LAUNCHER_CAPS: readonly string[] = Object.freeze(['SETUID', 'SETGID', 'KILL']);
/** The house launcher's user: root, holding only LAUNCHER_CAPS. */
export const LAUNCHER_USER = '0:0';
/** The entry's resolver option under the launcher: every name it looks up is tried as given first (Docker 29 writes the same itself; this pins it). */
export const LAUNCHER_DNS_OPT = 'ndots:0';
const RUNTIME_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export interface DockerSandboxOptions {
  /** The docker CLI (default `docker`). */
  docker?: string;
  /** `--runtime` for every container (e.g. runsc); default MAKEFUN_DOCKER_RUNTIME, unset = Docker's default. */
  runtime?: string | null;
  images?: ImageTableT;
  /**
   * `--cgroup-parent` for every entry container this sandbox spawns, never its meter or reclaim containers
   * (the header's Timing): a timed sandbox's, from openCpuClock. Default none.
   */
  cgroupParent?: string | null;
  /** Where a container no kill could confirm removed is reported (the header's Killing); default console.warn. */
  warn?: (line: string) => void;
  /**
   * The host file (the daemon resolves it) an egress container gets as /etc/resolv.conf under NETSTACK_RUNTIME,
   * where Docker's embedded DNS never answers (the header); default MAKEFUN_DOCKER_RESOLV_CONF, unset = none.
   * Any other runtime ignores it.
   */
  resolvConf?: string | null;
  /**
   * Whether the daemon reaches host paths through a VM's file sharing, whose server holds what the VM cached of a tree
   * this process removed until releaseRemoved looks it up again (the header's Releasing). Default: on any host but Linux.
   */
  sharesHostFiles?: boolean;
  /**
   * Where a spawn with secrets makes its own 0700 directory for its env file (the header's Secrets), a directory on
   * the docker CLI's host (the CLI reads the file, never the daemon); absolute. Default the OS's temporary directory.
   */
  secretsDir?: string;
  /**
   * Reads the host's CPU count, the most a cpusCeiling spec's `--cpus` is granted (grantedCpus), at each such spawn and
   * never for any other spec. Default os.availableParallelism(): this process's count, not the daemon's (a Docker
   * Desktop VM may have fewer).
   */
  hostCpus?: () => number;
}

/**
 * The runtime that runs gVisor on its own network stack: runsc registered without --network=host (the
 * header). Under it a trial network's names come from /etc/hosts (NetstackNames), not Docker's DNS.
 */
export const NETSTACK_RUNTIME = 'runsc-netstack';

/** A timing parent (the header's Timing): `/makefun-timing-<hex>` under the cgroupfs driver, `makefun_timing_<hex>.slice` under systemd. */
const CGROUP_PARENT_RE = /^(?:\/makefun-timing-[0-9a-f]{12}|makefun_timing_[0-9a-f]{12}\.slice)$/;

/** The parent, checked: one of the two shapes a timing clock makes (CGROUP_PARENT_RE), never any other cgroup. */
export function checkCgroupParent(parent: string): string {
  if (typeof parent !== 'string' || !CGROUP_PARENT_RE.test(parent)) {
    throw new SandboxError(`cgroup parent ${JSON.stringify(parent)} is not a timing parent (/makefun-timing-<12 hex>, or makefun_timing_<12 hex>.slice under systemd)`);
  }
  return parent;
}

/** The `--runtime` named by the environment (MAKEFUN_DOCKER_RUNTIME), or null. */
export function dockerRuntimeFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.MAKEFUN_DOCKER_RUNTIME?.trim() ?? '';
  if (v === '') return null;
  if (!RUNTIME_NAME_RE.test(v)) throw new SandboxError(`MAKEFUN_DOCKER_RUNTIME ${JSON.stringify(v)} is not a runtime name like runsc`);
  return v;
}

/** The resolv.conf named by the environment (MAKEFUN_DOCKER_RESOLV_CONF, a host path), or null. */
export function dockerResolvConfFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.MAKEFUN_DOCKER_RESOLV_CONF?.trim() ?? '';
  return v === '' ? null : checkHostPath(v);
}

/** A sandbox label, checked: lowercase [a-z0-9-], at most 41 characters (what a container or pod name carries). */
export function checkSandboxLabel(label: string): string {
  if (typeof label !== 'string' || !LABEL_RE.test(label)) throw new SandboxError(`sandbox label ${JSON.stringify(label)} must be lowercase [a-z0-9-], at most 41 characters`);
  return label;
}

/** A fresh container name for a label. */
export function containerName(label: string): string {
  return `makefun-${checkSandboxLabel(label)}-${randomBytes(6).toString('hex')}`;
}

/** A CPU limit as `--cpus` takes it: more than 0, at most 64, to a thousandth. */
export function formatCpus(cpus: number): string {
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 64) throw new SandboxError(`cpus ${cpus} is out of range`);
  return String(Math.round(cpus * 1000) / 1000);
}

/**
 * The CPUs a cpusCeiling spec's container is granted: its limit (formatCpus's range), or the host's CPU count where that
 * is fewer, since the daemon refuses a `--cpus` above the CPUs it has ("range of CPUs is from 0.01 to N"). So the env
 * role's two (network.ts ENV_LIMITS) still start on a 1-CPU host, on all of it; null host = no cap. Any other spec, an
 * entrant's above all, keeps its limit exactly (dockerRunArgs never calls this for it).
 */
export function grantedCpus(cpus: number, hostCpus: number | null): number {
  const limit = Number(formatCpus(cpus));
  if (hostCpus === null) return limit;
  if (!Number.isSafeInteger(hostCpus) || hostCpus < 1) throw new SandboxError(`host CPU count ${hostCpus} is not a positive integer`);
  return Math.min(limit, hostCpus);
}

/** `n` as a flag takes it: a positive safe integer, else a SandboxError naming `what`. */
export function positiveInt(n: number, what: string): string {
  if (!Number.isSafeInteger(n) || n <= 0) throw new SandboxError(`${what} ${n} must be a positive integer`);
  return String(n);
}

/**
 * What a runtime's own tasks add to the host pids cgroup `--pids-limit` caps, which counts every host
 * task of the container. runc's are the program's alone, so its cap is the pids as given. gVisor's
 * (runsc, systrap) are its sentry's and gofer's, 27-28 whatever the program runs or its CPUs, plus a
 * stub of 2-4 per program process (a program's threads cost none), measured on s7 with runsc
 * release-20261102.0: a cap of 16 never starts the sandbox ("the sandbox exited before the container
 * started"), one of 64 kills it at its eleventh process. A runtime named here gets
 * `base + perPid × pids`, room for every task the program could hold under runc and the sandbox's
 * own; any other gets the pids as given.
 */
export const RUNTIME_PIDS: Readonly<Record<string, Readonly<{ base: number; perPid: number }>>> = Object.freeze({
  runsc: Object.freeze({ base: 32, perPid: 3 }),
  // The same sandbox on its own network stack: a cap of 16 never starts it either (#95, s7), one of 32 does.
  [NETSTACK_RUNTIME]: Object.freeze({ base: 32, perPid: 3 }),
});

/** The `--pids-limit` value for a program's pids cap under a runtime (RUNTIME_PIDS; null = Docker's default, runc). */
export function pidsLimit(pids: number, runtime: string | null): string {
  const n = Number(positiveInt(pids, 'pids'));
  const own = runtime !== null && Object.hasOwn(RUNTIME_PIDS, runtime) ? RUNTIME_PIDS[runtime]! : null;
  return String(own === null ? n : own.base + own.perPid * n);
}

/** A container's place among its trial network's names under NETSTACK_RUNTIME (NetstackNames.attach, the header). */
export interface NetstackAttachment {
  /** Its address on the trial network (`--ip`). */
  ip: string;
  /** Every name a container on that network took before it, with that container's address (`--add-host`), in spawn order. */
  hosts: readonly (readonly [name: string, ip: string])[];
}

/** An IPv4 subnet as `docker network inspect` gives it (`172.24.0.0/16`): its first address and its size, or null for anything else. */
export function parseSubnet(cidr: string): { base: number; size: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (m === null) return null;
  const [a, b, c, d] = m.slice(1, 5).map(Number) as [number, number, number, number];
  const prefix = Number(m[5]);
  if (a > 255 || b > 255 || c > 255 || d > 255 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const addr = a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
  return { base: addr - (addr % size), size };
}

/** An IPv4 address from its number. */
function ipv4(n: number): string {
  return [Math.floor(n / 2 ** 24), Math.floor(n / 2 ** 16) % 256, Math.floor(n / 2 ** 8) % 256, n % 256].join('.');
}

/** The first host number NetstackNames gives out: the subnet's first host may be its bridge's gateway. */
export const NETSTACK_FIRST_HOST = 2;

/**
 * Who holds which address and names on each trial network under NETSTACK_RUNTIME (the header). One
 * per process (NETSTACK_NAMES): every sandbox of this process spawning on a network counts its
 * addresses from the same place, a timed one (openCpuClock) included.
 */
export class NetstackNames {
  readonly #nets = new Map<string, { base: number; size: number; next: number; held: Map<string, { ip: string; names: readonly string[] }> }>();

  /**
   * `container`'s address on `network`, the next of its subnet from NETSTACK_FIRST_HOST (`subnet` answers
   * the subnet the first time a network is attached to), and the names of every container holding an
   * address there now; `names` (its aliases and hosts) go to the containers attached after it. A
   * SandboxError when the subnet is not IPv4 or has no address left.
   */
  attach(network: string, container: string, names: readonly string[], subnet: () => string): NetstackAttachment {
    let net = this.#nets.get(network);
    if (net === undefined) {
      const cidr = subnet();
      const s = parseSubnet(cidr);
      if (s === null) throw new SandboxError(`network ${network}'s subnet ${JSON.stringify(cidr)} is not an IPv4 subnet, so no address can be given on it`);
      net = { ...s, next: NETSTACK_FIRST_HOST, held: new Map() };
      this.#nets.set(network, net);
    }
    if (net.held.has(container)) throw new SandboxError(`container ${container} already holds an address on ${network}`);
    // The last number is the subnet's broadcast address.
    if (net.next >= net.size - 1) throw new SandboxError(`network ${network}'s subnet has no address left for ${container}`);
    const hosts = [...net.held.values()].flatMap((h) => h.names.map((n) => [n, h.ip] as const));
    const ip = ipv4(net.base + net.next++);
    net.held.set(container, { ip, names: [...names] });
    return { ip, hosts };
  }

  /** `container` has left `network`: its names go to no later container, and the network is forgotten once nothing holds an address on it. */
  detach(network: string, container: string): void {
    const net = this.#nets.get(network);
    if (net === undefined) return;
    net.held.delete(container);
    if (net.held.size === 0) this.#nets.delete(network);
  }

  /** The networks held now. */
  networks(): string[] {
    return [...this.#nets.keys()];
  }
}

/** This process's NetstackNames, which every DockerSandbox under NETSTACK_RUNTIME attaches through. */
export const NETSTACK_NAMES = new NetstackNames();

/** A network's IPv4 subnet as the daemon allocated it (`docker network inspect`), for NetstackNames. */
export function networkSubnet(docker: string, network: string): string {
  const r = spawnSync(docker, ['network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', network], { encoding: 'utf8', timeout: 60_000, env: dockerCliEnv() });
  if (r.error !== undefined || r.status !== 0) {
    throw new SandboxError(`docker network inspect ${network} did not answer, so no address can be given on it: ${(r.stderr || r.error?.message || '').trim().split('\n')[0] ?? ''}`);
  }
  const subnets = r.stdout.trim().split(/\s+/);
  return subnets.find((s) => parseSubnet(s) !== null) ?? subnets.join(' ');
}

/**
 * The `--network` flags for a spec: `none` without a network; else the trial network first with its
 * aliases and then its hosts (the legacy `--network-alias` attaches to the first `--network`), and
 * with `names` (a NETSTACK_RUNTIME container's) its address there (`--ip`, legacy alike), then the
 * egress bridge when the spec asks for it, then with `names` the names of the containers before it
 * (`--add-host`).
 */
export function networkArgs(network: SandboxNetwork | undefined, names: NetstackAttachment | null = null): string[] {
  if (network === undefined) {
    if (names !== null) throw new SandboxError('a spec with no network takes no address');
    return ['--network', 'none'];
  }
  const net = checkSandboxNetwork(network);
  if (names !== null) {
    for (const ip of [names.ip, ...names.hosts.map(([, a]) => a)]) {
      if (!isIPv4(ip)) throw new SandboxError(`${JSON.stringify(ip)} is not an IPv4 address`);
    }
    for (const [n] of names.hosts) {
      if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(n)) throw new SandboxError(`${JSON.stringify(n)} is not a host name an --add-host takes`);
    }
  }
  return [
    '--network', net.name,
    ...[...(net.aliases ?? []), ...(net.hosts ?? [])].flatMap((a) => ['--network-alias', a]),
    ...(names === null ? [] : ['--ip', names.ip]),
    ...(net.egress === true ? ['--network', EGRESS_NETWORK] : []),
    ...(names === null ? [] : names.hosts.flatMap(([n, ip]) => ['--add-host', `${n}:${ip}`])),
  ];
}

/**
 * The full `docker run` argv (without the leading `docker`) for one program: pure, so the flag set
 * is unit-tested exactly. `name` is the container name, `digest` the image digest to run. A spec with
 * a `launcher` gets the launcher privilege set and the house (the header). A `cgroupParent` (a timed
 * sandbox's, the header's Timing) adds `--cgroup-parent` after `--pids-limit`; none adds nothing.
 * `names` (a NETSTACK_RUNTIME container's, NetstackNames.attach) adds its address and its peers' names
 * to the network flags (networkArgs), and `resolvConf` is an egress spec's /etc/resolv.conf under
 * NETSTACK_RUNTIME, mounted after the spec's mounts; any other spec or runtime ignores it. A race spec (its `race`)
 * takes `--label makefun.race=<now + lifetimeMs>` in place of CONTAINER_LABEL (the header), `now` (epoch ms) default
 * Date.now(), and no cgroup parent. A spec with secrets takes `secrets`, where DockerSandbox.spawn staged them (the
 * header's Secrets), as `--env-file` and `--cidfile` after its env; a spec without takes none. A spec's `work` adds
 * its /work tmpfs after /tmp (workTmpfs). Its mounts add their stand-in variables after their `-v` flags (types.ts
 * containerMountEnv: MAKEFUN_OUTPUT_DIR=/output, less /state's and /record's), so a program reads the mount where the
 * process driver reads its host directory. An image spec (its `image`, checkSandboxImage) runs its repository@digest
 * in place of opts.image and opts.digest, its argv in place of the runtime's interpreter and the script.
 */
export function dockerRunArgs(
  spec: SandboxSpec,
  opts: {
    name: string;
    image: string;
    digest: string;
    runtime: string | null;
    cgroupParent?: string | null;
    names?: NetstackAttachment | null;
    resolvConf?: string | null;
    now?: number;
    secrets?: SecretsFiles | null;
    /** The host's CPU count, the most a cpusCeiling spec's `--cpus` grants (grantedCpus); ignored for any other spec; undefined or null = no cap. */
    hostCpus?: number | null;
  },
): string[] {
  const script = scriptOf(spec);
  const launcher = spec.launcher === undefined ? null : checkSandboxLauncher(spec);
  const race = spec.race === undefined ? null : checkSandboxRace(spec);
  const image = spec.image === undefined ? null : checkSandboxImage(spec);
  const work = spec.work === undefined ? null : checkSandboxWork(spec.work);
  if (race !== null && opts.cgroupParent !== undefined && opts.cgroupParent !== null) throw new SandboxError("a timed sandbox runs a program/v1 timing heat's entries, never a race's racer");
  const memory = `${positiveInt(spec.limits.memory_mb, 'memory_mb')}m`;
  const env = checkSandboxEnv(spec.env);
  const files = opts.secrets ?? null;
  const secrets = checkSandboxSecrets(spec);
  if (secrets.length > 0) {
    secretsEnvFile(secrets);
    if (files === null) throw new SandboxError('a spec with secrets runs with its env file (DockerSandbox.spawn stages it), and none was given');
  } else if (files !== null) throw new SandboxError('a spec with no secrets takes no env file');
  const args = [
    'run', '-i', '--rm',
    '--name', opts.name,
    '--label', race === null ? CONTAINER_LABEL : `${RACE_LABEL}=${raceDeadlineAt(opts.now ?? Date.now(), race.lifetimeMs)}`,
    '--pull', image === null ? PULL_POLICY : REPO_IMAGE_PULL_POLICY,
    ...networkArgs(spec.network, opts.names ?? null),
    ...(launcher !== null && spec.network !== undefined ? ['--dns-opt', LAUNCHER_DNS_OPT] : []),
    '--cap-drop', 'ALL',
    ...(launcher === null ? [] : LAUNCHER_CAPS.flatMap((c) => ['--cap-add', c])),
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', `/tmp:rw,size=${TMPFS_SIZE}`,
    ...(work === null ? [] : ['--tmpfs', workTmpfs(work.mb)]),
    '-u', launcher === null ? NOBODY : LAUNCHER_USER,
    '--memory', memory,
    '--memory-swap', memory,
    '--cpus', formatCpus(spec.cpusCeiling === true ? grantedCpus(spec.limits.cpus, opts.hostCpus ?? null) : spec.limits.cpus),
    '--pids-limit', pidsLimit(spec.limits.pids, opts.runtime),
    ...(opts.cgroupParent === undefined || opts.cgroupParent === null ? [] : ['--cgroup-parent', checkCgroupParent(opts.cgroupParent)]),
    '--log-driver', 'none',
  ];
  for (const [k, v] of Object.entries(SANDBOX_ENV)) args.push('-e', `${k}=${v}`);
  for (const [k, v] of env) args.push('-e', `${k}=${v}`);
  if (files !== null) args.push('--env-file', checkSecretsPath(files.envFile), '--cidfile', checkSecretsPath(files.cidFile));
  if (opts.runtime !== null) {
    if (!RUNTIME_NAME_RE.test(opts.runtime)) throw new SandboxError(`docker runtime ${JSON.stringify(opts.runtime)} is not a runtime name`);
    args.push('--runtime', opts.runtime);
  }
  args.push('-v', `${checkHostPath(spec.codeDir)}:/bot:ro`);
  if (launcher !== null) args.push('-v', `${launcher.houseDir}:${HOUSE_DIR}:ro`);
  // A bind mount is the host directory itself: every file of a writable one is live, and all of it is back at the
  // exit, so `live` and `returns` are checked (every driver refuses what any could not carry) and need nothing more.
  const mounts = checkSandboxMounts(spec.mounts);
  for (const m of mounts) args.push('-v', `${m.host}:${m.at}:${m.readOnly ? 'ro' : 'rw'}`);
  // Each mount stands in for itself in the program's environment (types.ts containerMountEnv): MAKEFUN_OUTPUT_DIR=/output
  // here, as the process driver's MAKEFUN_OUTPUT_DIR is its host directory, so a program reading it with no fallback
  // resolves the mount under either driver. A launcher spec's entry gets launch.json's env and never this container's.
  for (const [name, value] of containerMountEnv(mounts)) args.push('-e', `${name}=${value}`);
  if (opts.runtime === NETSTACK_RUNTIME && spec.network?.egress === true && opts.resolvConf !== undefined && opts.resolvConf !== null) {
    args.push('--mount', `type=bind,src=${checkHostPath(opts.resolvConf)},dst=/etc/resolv.conf,readonly`);
  }
  if (image !== null) {
    const [entrypoint, ...rest] = image.argv;
    args.push('--entrypoint', entrypoint!, repoImageRef(image.repository, image.digest), ...rest);
    return args;
  }
  const ref = imageRef({ image: opts.image }, opts.digest);
  if (launcher !== null) {
    const [interpreter, ...rest] = LAUNCHER_ARGV[spec.runtime];
    args.push('--entrypoint', interpreter!, ref, ...rest);
    return args;
  }
  const [interpreter, ...flags] = RUNTIME_COMMANDS[spec.runtime];
  args.push('--entrypoint', interpreter!, ref, ...flags, `/bot/${script}`);
  return args;
}

/** Where a spawn's secrets are while its `docker run` client needs them (the header's Secrets): the env file it reads, the cid file it writes. */
export interface SecretsFiles {
  envFile: string;
  cidFile: string;
}

/** A spawn's secrets directory's name stem (mkdtemp adds six characters), and the two files in it. */
export const SECRETS_DIR_PREFIX = 'makefun-secrets-';
export const SECRETS_ENV_FILE = 'secrets.env';
export const SECRETS_CID_FILE = 'container.id';
/** How soon a spawn's cid file is first looked at for the container's id, and the most between two looks (the wait doubles). */
export const SECRETS_POLL_MS = 10;
export const SECRETS_POLL_MAX_MS = 100;

/** A path of a spawn's secrets as `--env-file` or `--cidfile` takes it: absolute, one line. */
function checkSecretsPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new SandboxError(`a secrets file's path ${JSON.stringify(path)} must be absolute, on one line`);
  return path;
}

/**
 * The env file of a spec's secrets (checkSandboxSecrets's entries, the header's Secrets): `NAME=value\n` a secret, in
 * the order given. docker reads each line as it is past its leading whitespace (a name has none) and splits it at the
 * first `=` (a name holds none), with no quoting, escape or interpolation (docker/cli pkg/kvfile), so a value is carried
 * byte for byte unless it holds a line break: a value with a CR or LF is a SandboxError naming its secret, never quoting it.
 */
export function secretsEnvFile(secrets: readonly (readonly [name: string, value: string])[]): string {
  let text = '';
  for (const [name, value] of secrets) {
    if (/[\r\n]/.test(value)) {
      throw new SandboxError(`secret ${name}'s value spans lines, which docker's --env-file cannot carry (one NAME=value line a variable, no quoting): this driver runs no such secret (the k8s driver does)`);
    }
    text += `${name}=${value}\n`;
  }
  return text;
}

/** The secrets directories this process has staged and not yet removed: what its exit removes (StagedSecrets). */
const STAGED_SECRETS = new Set<string>();
let stagedExitHook = false;

/** `dir` removed at this process's exit unless removed before (a staged spawn whose client never ended). */
function removeAtExit(dir: string): void {
  STAGED_SECRETS.add(dir);
  if (stagedExitHook) return;
  stagedExitHook = true;
  process.once('exit', () => {
    for (const d of STAGED_SECRETS) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // Nothing more can be done at exit.
      }
    }
  });
}

/**
 * One spawn's secrets on disk (the header's Secrets): a 0700 directory of its own under `root` holding the 0600 env
 * file, and where the docker CLI writes the container's id. remove() is idempotent; watch() removes it once the id
 * is there or the client has ended.
 */
export class StagedSecrets implements SecretsFiles {
  readonly dir: string;
  readonly envFile: string;
  readonly cidFile: string;
  readonly #warn: (line: string) => void;
  #removed = false;
  #timer: NodeJS.Timeout | null = null;

  /** Stage `text` (secretsEnvFile's) under `root`; a SandboxError naming `root` when it cannot be written. */
  constructor(root: string, text: string, warn: (line: string) => void) {
    this.#warn = warn;
    if (!isAbsolute(root)) throw new SandboxError(`the secrets directory ${JSON.stringify(root)} must be absolute`);
    let dir: string;
    try {
      dir = mkdtempSync(join(root, SECRETS_DIR_PREFIX));
    } catch (err) {
      throw new SandboxError(`the docker sandbox could not make a directory for a spawn's secrets under ${root}: ${(err as Error).message}`);
    }
    this.dir = dir;
    removeAtExit(dir);
    this.envFile = join(dir, SECRETS_ENV_FILE);
    this.cidFile = join(dir, SECRETS_CID_FILE);
    try {
      // mkdtemp makes it 0700 already; said again in case a platform's does not.
      chmodSync(this.dir, 0o700);
      writeFileSync(this.envFile, text, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      this.remove();
      throw new SandboxError(`the docker sandbox could not stage a spawn's secrets in ${this.dir}: ${(err as Error).message}`);
    }
  }

  /**
   * Remove the directory once docker has written the container's id to the cid file (the container exists: its env
   * file was read before it was asked for), or once `client` has ended (closed, or failed to start), whichever comes
   * first.
   */
  watch(client: ChildProcess): void {
    client.once('close', () => this.remove());
    client.once('error', () => {
      if (client.pid === undefined) this.remove();
    });
    let wait = SECRETS_POLL_MS;
    const look = (): void => {
      this.#timer = null;
      if (this.#removed) return;
      let size = 0;
      try {
        size = statSync(this.cidFile, { throwIfNoEntry: false })?.size ?? 0;
      } catch {
        // Unreadable for now: looked at again, and removed at the client's end at the latest.
      }
      if (size > 0) {
        this.remove();
        return;
      }
      this.#timer = setTimeout(look, wait);
      wait = Math.min(wait * 2, SECRETS_POLL_MAX_MS);
    };
    this.#timer = setTimeout(look, wait);
  }

  /** Remove the directory and everything in it (idempotent); a failure is warned of, never thrown. */
  remove(): void {
    if (this.#removed) return;
    this.#removed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    try {
      rmSync(this.dir, { recursive: true, force: true });
      STAGED_SECRETS.delete(this.dir);
    } catch (err) {
      this.#warn(`docker sandbox: a spawn's secrets directory ${this.dir} could not be removed (this process's exit tries again): ${(err as Error).message}`);
    }
  }
}

/**
 * A spec's /work tmpfs (`--tmpfs`'s value): writable and executable (the repository's own build runs there), no
 * setuid, `mb` MiB, and 1777 so the sandbox user owns what it makes there.
 */
export function workTmpfs(mb: number): string {
  return `${WORK_DIR}:rw,exec,nosuid,size=${mb}m,mode=1777`;
}

/**
 * Whether the daemon holds `<repository>@<digest>` (`docker image inspect`): what the pack check asks of a
 * competition's repository image, which grading never pulls. False for an image it does not hold; throws
 * SandboxError for a malformed reference (repoImageRef), a docker that does not run, or any other answer.
 */
export function imagePresent(repository: string, digest: string, docker = 'docker'): boolean {
  const ref = repoImageRef(repository, digest);
  const r = spawnSync(docker, ['image', 'inspect', '--format', '{{.Id}}', ref], { encoding: 'utf8', timeout: 60_000, env: dockerCliEnv() });
  if (r.error) throw new SandboxError(`docker is not runnable: ${r.error.message}`, { cause: r.error });
  if (r.status === 0) return true;
  const said = (r.stderr || '').trim();
  if (/no such image/i.test(said)) return false;
  throw new SandboxError(`docker could not inspect ${ref} (exit ${r.status ?? r.signal}): ${said.split('\n')[0] ?? ''}`);
}

/** The files a launcher spec's house must hold before its container starts: the runtime's launcher, launch.json, ca.pem. */
export function houseFilesMissing(spec: SandboxSpec): string[] {
  if (spec.launcher === undefined) return [];
  const dir = checkSandboxLauncher(spec).houseDir;
  return [LAUNCHER_FILES[spec.runtime], LAUNCH_CONFIG, CA_FILE].filter((f) => !existsSync(join(dir, f)));
}

/**
 * The reclaim's exit status when find could not delete everything: not 1, which the docker CLI
 * exits with when it cannot reach the daemon, nor docker run's own 125, 126 and 127.
 */
export const RECLAIM_REFUSED = 3;
/**
 * What the reclaim container runs, as the sandbox user, over the one directory mounted at /reclaim:
 * first that user's own directories under it made enterable and writable again (a program may leave
 * one 0555, or 0000: chmod -R changes a directory before it reads it, never follows a link, and fails
 * quietly on anything another user owns), then everything under /reclaim deleted. It exits 0, or
 * RECLAIM_REFUSED when find could not delete everything.
 */
export const RECLAIM_SCRIPT = `chmod -R u+rwX /reclaim 2>/dev/null; find /reclaim -mindepth 1 -delete || exit ${RECLAIM_REFUSED}`;
export const RECLAIM_TIMEOUT_MS = 120_000;

/**
 * The `docker run` argv (without the leading `docker`) of the reclaim container that deletes what a
 * program left in `dir`: the same hardening as a program's, the sandbox user, the pinned node22 image
 * (any image with sh, chmod and find would do), nothing mounted but `dir` at /reclaim.
 */
export function reclaimArgs(dir: string, opts: { name: string; images?: ImageTableT; runtime: string | null }): string[] {
  if (opts.runtime !== null && !RUNTIME_NAME_RE.test(opts.runtime)) throw new SandboxError(`docker runtime ${JSON.stringify(opts.runtime)} is not a runtime name`);
  const entry = imageFor('node22', opts.images ?? IMAGES);
  return [
    'run', '--rm', '--name', opts.name, '--label', CONTAINER_LABEL, '--pull', PULL_POLICY,
    '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '-u', NOBODY, '--log-driver', 'none',
    ...(opts.runtime === null ? [] : ['--runtime', opts.runtime]),
    '-v', `${checkHostPath(dir)}:/reclaim:rw`,
    '--entrypoint', 'sh', imageRef(entry, entry.digest), '-c', RECLAIM_SCRIPT,
  ];
}

/** Where a release container holds the parent of the trees it releases, read-only (the header's Releasing). */
export const RELEASE_MOUNT = '/release';
/** How often a release container looks a removed tree up again while the VM still answers from its cache. */
export const RELEASE_POLL_MS = 250;
/** How many times it looks again before it says the VM still sees the tree (10 s). */
export const RELEASE_POLLS = 40;
/** The most trees one release container takes, so its argv stays far under any ARG_MAX. */
export const RELEASE_BATCH = 256;
/** How long one release container may take before it is removed by name and warned of. */
export const RELEASE_TIMEOUT_MS = 60_000;
export const RELEASE_MEMORY = '64m';
export const RELEASE_CPUS = '0.25';
export const RELEASE_PIDS = 16;
/** The most of a release container's stdout and stderr kept, each. */
const RELEASE_OUTPUT_BYTES = 16_384;
/** A tree's name as a release container takes it: one path component, as checkHostPath's characters make one. */
const RELEASE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The release container's script (dash, as the images' sh), its arguments the names of removed trees under
 * RELEASE_MOUNT: each looked up (`[ -e ]`, a stat through the VM's file sharing) until the VM sees it gone, again every
 * RELEASE_POLL_MS at most RELEASE_POLLS times; `seen <name>` printed for each still there after that. Exits 0.
 */
export const RELEASE_SCRIPT = [
  'for n in "$@"; do',
  '  i=0',
  `  while [ -e "${RELEASE_MOUNT}/$n" ]; do`,
  `    if [ "$i" -ge ${RELEASE_POLLS} ]; then echo "seen $n"; break; fi`,
  `    i=$((i + 1)); sleep ${(RELEASE_POLL_MS / 1000).toFixed(3)}`,
  '  done',
  'done',
].join('\n');

/**
 * The `docker run` argv (without the leading `docker`) of the release container over `parent`, looking up each of
 * `names` (the trees under it this process removed) from inside the VM (the header's Releasing): the sandbox user, no
 * capability, no network, a read-only root, its own small limits, `parent` read-only at RELEASE_MOUNT and nothing
 * else mounted, the pinned node22 image (any image with sh, [ and sleep would do).
 */
export function releaseArgs(parent: string, names: readonly string[], opts: { name: string; images?: ImageTableT; runtime: string | null }): string[] {
  if (opts.runtime !== null && !RUNTIME_NAME_RE.test(opts.runtime)) throw new SandboxError(`docker runtime ${JSON.stringify(opts.runtime)} is not a runtime name`);
  if (names.length === 0 || names.length > RELEASE_BATCH) throw new SandboxError(`a release container takes 1 to ${RELEASE_BATCH} trees, not ${names.length}`);
  for (const n of names) {
    if (!RELEASE_NAME_RE.test(n) || n === '.' || n === '..') throw new SandboxError(`${JSON.stringify(n)} is not a tree's name (one path component of [A-Za-z0-9._-])`);
  }
  const entry = imageFor('node22', opts.images ?? IMAGES);
  return [
    'run', '--rm', '--name', opts.name, '--label', CONTAINER_LABEL, '--pull', PULL_POLICY,
    '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '-u', NOBODY, '--memory', RELEASE_MEMORY, '--memory-swap', RELEASE_MEMORY, '--cpus', RELEASE_CPUS, '--pids-limit', pidsLimit(RELEASE_PIDS, opts.runtime), '--log-driver', 'none',
    ...(opts.runtime === null ? [] : ['--runtime', opts.runtime]),
    '-v', `${checkHostPath(parent)}:${RELEASE_MOUNT}:ro`,
    '--entrypoint', 'sh', imageRef(entry, entry.digest), '-c', RELEASE_SCRIPT, 'sh', ...names,
  ];
}

/** Whether `path` is there (a dangling link counts): lstat, never following it. */
function present(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/**
 * What release containers look up for `dirs`, trees this process removed (the header's Releasing): by the nearest
 * ancestor of each that is still there (what the container mounts), the name under it of the topmost one gone (the VM
 * drops everything it cached under that), each once and in code-unit order, the parents too. A dir still there, or one
 * no sandbox could have mounted (checkHostPath refuses it), is left out: nothing of it to release.
 */
export function releaseTargets(dirs: readonly string[], exists: (path: string) => boolean = present): [parent: string, names: string[]][] {
  const by = new Map<string, Set<string>>();
  for (const dir of dirs) {
    try {
      checkHostPath(dir);
    } catch {
      continue;
    }
    let top = resolvePath(dir);
    if (exists(top)) continue;
    while (dirname(top) !== top && !exists(dirname(top))) top = dirname(top);
    const parent = dirname(top);
    // A tree directly under the host's root (or the root) is left alone: its release would mount the root itself.
    if (parent === top || parent === '/') continue;
    const names = by.get(parent) ?? new Set<string>();
    names.add(basename(top));
    by.set(parent, names);
  }
  const byUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...by.entries()].sort(([a], [b]) => byUnits(a, b)).map(([parent, names]) => [parent, [...names].sort(byUnits)]);
}

/** How long past the program's budget a meter that nobody stopped keeps going (a grader that died without closing its stdin). */
export const METER_SLACK_MS = 120_000;
export const METER_MEMORY = '256m';
export const METER_CPUS = '0.5';
export const METER_PIDS = 16;
/** How long stop() waits for the meter to go after closing its stdin, before it removes the container by name. */
export const METER_STOP_MS = 5_000;
const METER_LINE_RE = /^(\d+) (\d+) (\d+) (\d+)$/;
/** The most of a meter's stderr kept for its fault. */
export const METER_STDERR_BYTES = 4096;
/** The longest unfinished line a meter may hold before it is not a reading. */
const METER_PARTIAL_CHARS = 64;
/** The largest depth or path cap a meter takes: Linux's PATH_MAX, past which a cap means nothing. */
const METER_PATH_CAP_LIMIT = 4096;

/**
 * The meter's shell script (dash, as the images' sh): a TERM trap that exits, a watcher that sends
 * that TERM once stdin closes, then `passes` passes, `intervalMs` apart. Each pass is one find over
 * /measure (never below maxDepth + 1) printing every entry's type, depth, apparent size and allocated
 * 512-byte blocks, and whether its path is past maxPathBytes (a `-path` glob of that many `?` plus
 * one, each one byte under LC_ALL=C and matching `/` too), summed by awk, which stops at the first
 * entry past a cap. Its bytes are the larger of the regular files' apparent total and allocated total
 * (a sparse file reports more than it holds, a preallocated one holds more than it reports). The pass
 * and the sleep run in the background under `wait`, so the TERM ends the meter at once, mid-pass.
 */
export function meterScript(o: { intervalMs: number; passes: number; maxEntries: number; maxBytes: number; maxDepth: number; maxPathBytes: number }): string {
  const seconds = (Number(positiveInt(o.intervalMs, 'meter interval')) / 1000).toFixed(3);
  const passes = positiveInt(o.passes, 'meter passes');
  const maxEntries = positiveInt(o.maxEntries, 'meter entry cap');
  const maxBytes = positiveInt(o.maxBytes, 'meter byte cap');
  const maxDepth = Number(positiveInt(o.maxDepth, 'meter depth cap'));
  const maxPathBytes = Number(positiveInt(o.maxPathBytes, 'meter path cap'));
  if (maxDepth > METER_PATH_CAP_LIMIT || maxPathBytes > METER_PATH_CAP_LIMIT) throw new SandboxError(`meter depth and path caps must be at most ${METER_PATH_CAP_LIMIT}`);
  const long = `/measure/${'?'.repeat(maxPathBytes + 1)}*`;
  const find = `LC_ALL=C find /measure -mindepth 1 -maxdepth ${maxDepth + 1} \\( -path '${long}' -printf '%y %d %s %b 1\\n' \\) -o -printf '%y %d %s %b 0\\n'`;
  const awk = [
    'BEGIN { n = 0; s = 0; a = 0; d = 0; l = 0 }',
    `{ n++; if ($1 == "f") { s += $3; a += $4 * 512 }; if ($2 > d) d = $2; l += $5; if (n > ${maxEntries} || s > ${maxBytes} || a > ${maxBytes} || d > ${maxDepth} || l > 0) exit }`,
    'END { printf "%.0f %.0f %.0f %.0f\\n", n, (s > a ? s : a), d, l }',
  ].join(' ');
  return [
    "trap 'exit 0' TERM",
    'exec 3<&0',
    '(read -r _ <&3; kill -TERM $$) &',
    'i=0',
    `while [ "$i" -lt ${passes} ]; do`,
    `  ${find} 2>/dev/null | awk '${awk}' & wait $!`,
    '  i=$((i + 1))',
    `  sleep ${seconds} & wait $!`,
    'done',
  ].join('\n');
}

/**
 * The `docker run` argv (without the leading `docker`) of the meter container over `dir`: root with
 * only DAC_READ_SEARCH, `dir` read-only at /measure and nothing else mounted, no network, read-only
 * root, its own small memory, CPU and pids limits, stdin attached (closing it stops the meter).
 */
export function meterArgs(dir: string, opts: { name: string; image: string; digest: string; runtime: string | null; script: string }): string[] {
  if (opts.runtime !== null && !RUNTIME_NAME_RE.test(opts.runtime)) throw new SandboxError(`docker runtime ${JSON.stringify(opts.runtime)} is not a runtime name`);
  return [
    'run', '-i', '--rm', '--name', opts.name, '--label', CONTAINER_LABEL, '--pull', PULL_POLICY,
    '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges', '--read-only',
    '-u', '0:0', '--memory', METER_MEMORY, '--memory-swap', METER_MEMORY, '--cpus', METER_CPUS, '--pids-limit', pidsLimit(METER_PIDS, opts.runtime), '--log-driver', 'none',
    ...(opts.runtime === null ? [] : ['--runtime', opts.runtime]),
    '-v', `${checkHostPath(dir)}:/measure:ro`,
    '--entrypoint', 'sh', imageRef({ image: opts.image }, opts.digest), '-c', opts.script,
  ];
}

// ---------------------------------------------------------------- the CPU clock (the header's Timing)

/** The cgroup drivers a timing clock can name its parent for (`docker info`'s CgroupDriver). */
export const CGROUP_DRIVERS = ['cgroupfs', 'systemd'] as const;
export type CgroupDriverT = (typeof CGROUP_DRIVERS)[number];

/** Where the clock container sees the host's cgroup tree (/sys/fs/cgroup, read-only). */
export const CPU_CLOCK_MOUNT = '/cgroup';
/** The clock container's runtime, named outright (the header's Timing): runc, whose mount of /sys/fs/cgroup is the host's tree. */
export const CPU_CLOCK_RUNTIME = 'runc';
export const CPU_CLOCK_MEMORY = '64m';
export const CPU_CLOCK_CPUS = '0.25';
export const CPU_CLOCK_PIDS = 16;
/** How long one reading may take before the clock is the sandbox's fault. */
export const CPU_CLOCK_READ_MS = 30_000;
/** A settling read (CpuClock.settled): readings this far apart, at most this many, until two in a row agree. */
export const CPU_CLOCK_SETTLE_MS = 50;
export const CPU_CLOCK_SETTLE_READS = 20;
const CPU_CLOCK_STDERR_BYTES = 4096;

/**
 * The clock container's script (dash, as the images' sh), its one argument the parent's cpu.stat: for each
 * line on stdin one line out, the parent's usage_usec, `missing` while there is no such file (no container
 * has run under the parent yet), `none` for a cpu.stat without usage_usec.
 */
export const CPU_CLOCK_SCRIPT = [
  'while read -r _; do',
  '  if [ -r "$1" ]; then v=$(sed -n "s/^usage_usec //p" "$1"); echo "${v:-none}"; else echo missing; fi',
  'done',
].join('\n');

const TIMING_HEX_RE = /^[0-9a-f]{12}$/;

/**
 * A timing parent for `driver` (the header's Timing) from 12 hex digits: what `--cgroup-parent` names, and its
 * path under /sys/fs/cgroup. cgroupfs: `/makefun-timing-<hex>` at makefun-timing-<hex>; systemd:
 * `makefun_timing_<hex>.slice` at the same name (no dash, so systemd nests it under no other slice).
 */
export function timingCgroup(driver: CgroupDriverT, hex: string): { parent: string; path: string } {
  if (typeof hex !== 'string' || !TIMING_HEX_RE.test(hex)) throw new SandboxError(`a timing parent is named by 12 lowercase hex digits, not ${JSON.stringify(hex)}`);
  if (driver === 'cgroupfs') return { parent: `/makefun-timing-${hex}`, path: `makefun-timing-${hex}` };
  if (driver === 'systemd') return { parent: `makefun_timing_${hex}.slice`, path: `makefun_timing_${hex}.slice` };
  throw new SandboxError(`cgroup driver ${JSON.stringify(driver)} is not one a timing clock names a parent for (${CGROUP_DRIVERS.join(', ')})`);
}

/**
 * The `docker run` argv (without the leading `docker`) of the clock container over the timing parent at `path`
 * (timingCgroup's): runc (CPU_CLOCK_RUNTIME, whatever the entries' runtime or the daemon's default), the sandbox
 * user, no capability, no network, a read-only root, its own small limits, /sys/fs/cgroup read-only at
 * CPU_CLOCK_MOUNT and nothing else mounted, stdin attached (one line in, one reading out; closing it ends the clock).
 */
export function cpuClockArgs(path: string, opts: { name: string; image: string; digest: string }): string[] {
  checkCgroupParent(path.startsWith('makefun-timing-') ? `/${path}` : path);
  return [
    'run', '-i', '--rm', '--name', opts.name, '--label', CONTAINER_LABEL, '--pull', PULL_POLICY, '--runtime', CPU_CLOCK_RUNTIME,
    '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '-u', NOBODY, '--memory', CPU_CLOCK_MEMORY, '--memory-swap', CPU_CLOCK_MEMORY, '--cpus', CPU_CLOCK_CPUS, '--pids-limit', String(CPU_CLOCK_PIDS), '--log-driver', 'none',
    '-v', `/sys/fs/cgroup:${CPU_CLOCK_MOUNT}:ro`,
    '--entrypoint', 'sh', imageRef({ image: opts.image }, opts.digest), '-c', CPU_CLOCK_SCRIPT, 'sh', `${CPU_CLOCK_MOUNT}/${path}/cpu.stat`,
  ];
}

/** One line the clock printed, read: its usage_usec, 0 for `missing` (nothing ran under the parent yet); null for anything else. */
export function cpuClockReading(line: string): bigint | null {
  if (line === 'missing') return 0n;
  return /^(?:0|[1-9][0-9]{0,19})$/.test(line) ? BigInt(line) : null;
}

/** What a timing heat reads its runs' CPU time from: the timing parent's usage_usec, cumulative, in µs. */
export interface CpuClock {
  /** Where it reads, as the heat record states it: `cgroup-v2 <driver> <runtime or default> <parent>`. */
  readonly source: string;
  /** The parent's usage_usec now (0 before anything ran under it). SandboxError when it cannot be read. */
  read(): Promise<bigint>;
  /** read() until two readings in a row agree, CPU_CLOCK_SETTLE_MS apart, at most CPU_CLOCK_SETTLE_READS: a removed child's last CPU folded in. */
  settled(): Promise<bigint>;
  /** Stop the clock (idempotent); the parent is removed when this process may. */
  close(): Promise<void>;
}

/**
 * TrialNetworks that load what runs them on the first call: network.ts imports this module, so this one
 * loads it only once a trial needs a network, never as it loads (grader/worker.ts's header Loading).
 */
function lazyTrialNetworks(load: () => Promise<TrialNetworks>): TrialNetworks {
  let loaded: Promise<TrialNetworks> | null = null;
  const of = (): Promise<TrialNetworks> => (loaded ??= load());
  return {
    create: async (trial, opts) => (await of()).create(trial, opts),
    remove: async (trial) => (await of()).remove(trial),
    reap: async (owner) => (await of()).reap(owner),
    ensureEgress: async () => (await of()).ensureEgress(),
    sweepStale: async () => (await of()).sweepStale(),
    sweepRaces: async () => {
      const nets = await of();
      return nets.sweepRaces === undefined ? { containers: [], networks: [], errors: [] } : nets.sweepRaces();
    },
    isolation: async () => (await of()).isolation(),
  };
}

/** A timing sandbox (DockerSandbox.openCpuClock): every entry container it spawns runs under the clock's parent. */
export interface TimedDockerSandbox {
  clock: CpuClock;
  sandbox: DockerSandbox;
}

export class DockerSandbox implements Sandbox {
  readonly kind = 'docker' as const;
  readonly docker: string;
  readonly runtime: string | null;
  readonly images: ImageTableT;
  /** `--cgroup-parent` of every entry container (a timed sandbox's), or null. */
  readonly cgroupParent: string | null;
  /** Where a container no kill could confirm removed is reported (removeContainer). */
  readonly warn: (line: string) => void;
  /** An egress container's /etc/resolv.conf under NETSTACK_RUNTIME (a host file), or null for none. */
  readonly resolvConf: string | null;
  /** Whether the daemon reaches host paths through a VM's file sharing, so releaseRemoved has something to release (the header's Releasing). */
  readonly sharesHostFiles: boolean;
  /** Where a spawn with secrets makes its own directory for them (the header's Secrets). */
  readonly secretsDir: string;
  /** Reads the host's CPU count for a cpusCeiling spec's `--cpus` (DockerSandboxOptions.hostCpus). */
  readonly hostCpus: () => number;
  /** Its trial networks: network.ts dockerTrialNetworks on its CLI, runtime and images (lazyTrialNetworks). */
  readonly networks: TrialNetworks = lazyTrialNetworks(async () => {
    const { dockerTrialNetworks } = await import('./network.ts');
    return dockerTrialNetworks({ docker: this.docker, runtime: this.runtime, images: this.images });
  });

  constructor(opts: DockerSandboxOptions = {}) {
    this.docker = opts.docker ?? 'docker';
    this.runtime = opts.runtime === undefined ? dockerRuntimeFromEnv() : opts.runtime;
    if (this.runtime !== null && !RUNTIME_NAME_RE.test(this.runtime)) throw new SandboxError(`docker runtime ${JSON.stringify(this.runtime)} is not a runtime name`);
    this.images = opts.images ?? IMAGES;
    this.cgroupParent = opts.cgroupParent === undefined || opts.cgroupParent === null ? null : checkCgroupParent(opts.cgroupParent);
    this.warn = opts.warn ?? ((line) => console.warn(line));
    this.resolvConf = opts.resolvConf === undefined ? dockerResolvConfFromEnv() : opts.resolvConf === null ? null : checkHostPath(opts.resolvConf);
    this.sharesHostFiles = opts.sharesHostFiles ?? process.platform !== 'linux';
    this.secretsDir = opts.secretsDir ?? tmpdir();
    if (!isAbsolute(this.secretsDir)) throw new SandboxError(`the secrets directory ${JSON.stringify(this.secretsDir)} must be absolute`);
    this.hostCpus = opts.hostCpus ?? availableParallelism;
  }

  /**
   * A timed sandbox and its CPU clock (the header's Timing). `docker info` must report cgroup v2 under the cgroupfs
   * or systemd driver (SandboxError otherwise: CPU time is not readable host-side there); a fresh parent named for
   * that driver (timingCgroup) holds every entry container the returned sandbox spawns, and the clock container
   * (cpuClockArgs, in `runtime`'s pinned image) reads it. Close the clock when the heat is done.
   */
  openCpuClock(runtime: Runtime): TimedDockerSandbox {
    const info = spawnSync(this.docker, ['info', '--format', '{{.CgroupVersion}} {{.CgroupDriver}}'], { encoding: 'utf8', timeout: 60_000, env: dockerCliEnv() });
    if (info.error !== undefined || info.status !== 0) {
      throw new SandboxError(`docker info did not answer, so no CPU clock can start: ${(info.stderr || info.error?.message || '').trim().split('\n')[0] ?? ''}`);
    }
    const [version, driver] = info.stdout.trim().split(/\s+/);
    if (version !== '2') throw new SandboxError(`CPU time is read host-side from cgroup v2, and this docker host runs cgroup v${version ?? '?'}: no timing heat can run here`);
    if (!(CGROUP_DRIVERS as readonly string[]).includes(driver ?? '')) {
      throw new SandboxError(`this docker host's cgroup driver is ${JSON.stringify(driver ?? '')}, not one a timing clock names a parent for (${CGROUP_DRIVERS.join(', ')})`);
    }
    const { parent, path } = timingCgroup(driver as CgroupDriverT, randomBytes(6).toString('hex'));
    const entry = imageFor(runtime, this.images);
    const name = containerName('cpu-clock');
    const child = spawn(this.docker, cpuClockArgs(path, { name, image: entry.image, digest: entry.digest }), { stdio: ['pipe', 'pipe', 'pipe'], env: dockerCliEnv() });
    const clock = new DockerCpuClock(child, this.docker, name, path, `cgroup-v2 ${driver} ${this.runtime ?? 'default'} ${parent}`, this.warn);
    return {
      clock,
      sandbox: new DockerSandbox({
        docker: this.docker,
        runtime: this.runtime,
        images: this.images,
        cgroupParent: parent,
        warn: this.warn,
        resolvConf: this.resolvConf,
        sharesHostFiles: this.sharesHostFiles,
        secretsDir: this.secretsDir,
      }),
    };
  }

  imageDigest(runtime: Runtime): string {
    return imageFor(runtime, this.images).digest;
  }

  /**
   * The image is present locally under its digest: `docker image inspect`, and when the daemon lacks it, `docker pull
   * <image>@<digest>` (pullImage: by the digest, so what arrives is what the pin names, at most PULL_TIMEOUT_MS), so
   * the run's own `--pull missing` (PULL_POLICY) finds it there and no program's clock pays for a pull. A SandboxError
   * when docker does not run, does not answer the inspect, or cannot fetch the image.
   */
  async preflight(runtime: Runtime, imageDigest: string | null = null): Promise<void> {
    const entry = imageFor(runtime, this.images);
    const ref = imageRef(entry, imageDigest ?? entry.digest);
    const r = spawnSync(this.docker, ['image', 'inspect', '--format', '{{.Id}}', ref], { encoding: 'utf8', timeout: 60_000, env: dockerCliEnv() });
    if (r.error) throw new SandboxError(`docker is not runnable: ${r.error.message}`, { cause: r.error });
    if (r.status === 0) return;
    const said = (r.stderr || '').trim();
    if (!/no such image/i.test(said)) throw new SandboxError(`docker could not inspect ${ref} (exit ${r.status ?? r.signal}): ${said.split('\n')[0] ?? ''}`);
    await pullImage(this.docker, ref);
  }

  isDriverFailure(exit: SandboxExit): boolean {
    return exit.code === DOCKER_RUN_FAILURE;
  }

  /**
   * Delete `dir`, a directory the sandbox user can enter (a writable mount, 0777): with rm, else (what
   * rm may not delete, or a tree nested past its reach: ENAMETOOLONG) from a reclaim container
   * (reclaimArgs) running as that user, then what is left (this process's own) with rm. Throws
   * LeftoverError when the reclaim ran and still could not delete what the program left there, a
   * plain SandboxError when docker could not run it.
   */
  async removeTree(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTEMPTY' && code !== 'ENAMETOOLONG') throw err;
    }
    const name = containerName('reclaim');
    const r = spawnSync(this.docker, reclaimArgs(dir, { name, images: this.images, runtime: this.runtime }), { encoding: 'utf8', timeout: RECLAIM_TIMEOUT_MS, env: dockerCliEnv() });
    const why = (r.stderr || r.error?.message || (r.signal === null ? '' : `killed by ${r.signal}`)).trim().split('\n')[0] ?? '';
    if (r.error !== undefined || r.status === null) {
      // A reclaim cut off (the timeout) keeps running without its client: removed by name until docker has it gone (its
      // client was killed, so its create may land yet). A CLI that never started (pid 0: no docker) made nothing.
      await removeContainer({
        docker: this.docker,
        name,
        clientEnd: Promise.resolve({ ran: r.pid > 0, code: r.status, signal: r.signal ?? 'SIGKILL' }),
        killClient: () => undefined,
        warn: this.warn,
      });
      throw new SandboxError(`docker could not reclaim ${dir}: ${why}`);
    }
    if (r.status === RECLAIM_REFUSED) throw new LeftoverError(dir, `the sandbox user could not delete what is left in ${dir}: ${why}`);
    if (r.status !== 0) throw new SandboxError(`docker could not reclaim ${dir} (exit ${r.status}): ${why}`);
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * Make the daemon's VM let go of what it holds of `dirs`, trees this process removed after containers used them (the
   * header's Releasing): where the daemon's host paths come through a VM (sharesHostFiles), one release container
   * (releaseArgs) per parent and RELEASE_BATCH trees (releaseTargets), each awaited in turn; elsewhere nothing. A dir
   * still there is left alone. Never throws: a release docker could not run, or a tree the VM still sees after
   * RELEASE_POLLS looks, is warned of (one line), and costs nothing but the VM's handles.
   */
  async releaseRemoved(dirs: readonly string[]): Promise<void> {
    if (!this.sharesHostFiles) return;
    for (const [parent, names] of releaseTargets(dirs)) {
      for (let i = 0; i < names.length; i += RELEASE_BATCH) await this.#release(parent, names.slice(i, i + RELEASE_BATCH));
    }
  }

  /** One release container over `parent` for `names` (releaseArgs), to its end: removed by name past RELEASE_TIMEOUT_MS. */
  async #release(parent: string, names: string[]): Promise<void> {
    const what = names.length === 1 ? `${parent}/${names[0]}` : `${names.length} removed trees under ${parent}`;
    const name = containerName('release');
    let args: string[];
    try {
      args = releaseArgs(parent, names, { name, images: this.images, runtime: this.runtime });
    } catch (err) {
      this.warn(`docker sandbox: ${what} not released: ${(err as Error).message}`);
      return;
    }
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(this.docker, args, { stdio: ['ignore', 'pipe', 'pipe'], env: dockerCliEnv() });
    } catch (err) {
      this.warn(`docker sandbox: ${what} not released: ${(err as Error).message}`);
      return;
    }
    const end = clientEndOf(child);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (s: string) => {
      if (out.length < RELEASE_OUTPUT_BYTES) out += s;
    });
    child.stderr.setEncoding('utf8').on('data', (s: string) => {
      if (err.length < RELEASE_OUTPUT_BYTES) err += s;
    });
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    if (!(await settlesWithin(end, RELEASE_TIMEOUT_MS))) {
      // Cut off: removed by name until docker has it gone, its client SIGKILLed if it stays (the header's Killing).
      await removeContainer({ docker: this.docker, name, clientEnd: end, killClient: () => child.kill('SIGKILL'), warn: this.warn });
      this.warn(`docker sandbox: ${what} not released: the release container ran past ${RELEASE_TIMEOUT_MS} ms`);
      return;
    }
    const e = await end;
    if (!e.ran || e.code !== 0) {
      const why = err.trim().split('\n')[0] ?? '';
      this.warn(`docker sandbox: ${what} not released: ${!e.ran ? 'docker did not run' : e.signal !== null ? `signal ${e.signal}` : `exit ${e.code}`}${why === '' ? '' : `: ${why}`}`);
      return;
    }
    const seen = out.split('\n').flatMap((l) => (l.startsWith('seen ') ? [l.slice(5)] : []));
    if (seen.length > 0) this.warn(`docker sandbox: the VM still sees ${seen.length} removed tree(s) under ${parent} after ${RELEASE_POLLS} looks (${seen.slice(0, 5).join(', ')}${seen.length > 5 ? ', …' : ''}): what it holds of them stays`);
  }

  spawn(spec: SandboxSpec): SandboxProcess {
    const entry = imageFor(spec.runtime, this.images);
    const name = containerName(spec.label);
    // Under gVisor's own network stack a container on a trial network takes its address and its peers' names here (the header).
    const net = this.runtime === NETSTACK_RUNTIME && spec.network !== undefined ? checkSandboxNetwork(spec.network) : null;
    const names = net === null ? null : NETSTACK_NAMES.attach(net.name, name, [...(net.aliases ?? []), ...(net.hosts ?? [])], () => networkSubnet(this.docker, net.name));
    let child: ChildProcessWithoutNullStreams;
    let staged: StagedSecrets | null = null;
    try {
      const opts = { name, image: entry.image, digest: spec.imageDigest ?? entry.digest, runtime: this.runtime, cgroupParent: this.cgroupParent, names, resolvConf: this.resolvConf, hostCpus: spec.cpusCeiling === true ? this.hostCpus() : null };
      const secrets = checkSandboxSecrets(spec);
      // With secrets, the whole argv is checked before any is written (its files' paths stand in), then built on them.
      let args = dockerRunArgs(spec, { ...opts, secrets: secrets.length === 0 ? null : { envFile: '/secrets.env', cidFile: '/container.id' } });
      // A launcher container with no launcher, config or CA would die before `ready`, a void with no reason.
      const missing = houseFilesMissing(spec);
      if (missing.length > 0) throw new SandboxError(`the house ${spec.launcher!.houseDir} lacks ${missing.join(', ')} (launch.ts houseFor, writeHouse)`);
      if (secrets.length > 0) {
        staged = new StagedSecrets(this.secretsDir, secretsEnvFile(secrets), this.warn);
        args = dockerRunArgs(spec, { ...opts, secrets: staged });
      }
      // The CLI's own environment: the host's PATH and DOCKER_* so it finds the daemon. None of it
      // reaches the container: only `-e` and the env file above do.
      child = spawn(this.docker, args, { stdio: ['pipe', 'pipe', 'pipe'], env: dockerCliEnv() });
    } catch (err) {
      staged?.remove();
      if (net !== null) NETSTACK_NAMES.detach(net.name, name);
      throw err;
    }
    // Before the process's own listeners, so the secrets are gone by the time `exited` settles.
    staged?.watch(child);
    const proc = new DockerProcess(child, this.docker, name, this.warn);
    if (net !== null) void proc.exited.finally(() => NETSTACK_NAMES.detach(net.name, name)).catch(() => undefined);
    return proc;
  }

  /** Meter `dir` from a meter container (meterArgs, the header's Metering) until stop(). */
  meterTree(dir: string, opts: TreeMeterOptions): TreeMeter {
    const entry = imageFor(opts.runtime, this.images);
    const name = `${containerName(opts.label)}-meter`;
    if (!Number.isFinite(opts.budgetMs) || opts.budgetMs < 0) throw new SandboxError(`meter budget ${opts.budgetMs} is out of range`);
    const interval = Number(positiveInt(opts.intervalMs, 'meter interval'));
    const passes = Math.ceil((opts.budgetMs + METER_SLACK_MS) / interval);
    const script = meterScript({ intervalMs: interval, passes, maxEntries: opts.maxEntries, maxBytes: opts.maxBytes, maxDepth: opts.maxDepth, maxPathBytes: opts.maxPathBytes });
    const args = meterArgs(dir, { name, image: entry.image, digest: opts.imageDigest ?? entry.digest, runtime: this.runtime, script });
    const child = spawn(this.docker, args, { stdio: ['pipe', 'pipe', 'pipe'], env: dockerCliEnv() });
    return new DockerMeter(child, this.docker, name, opts, this.warn);
  }
}

/**
 * `sandbox.releaseRemoved(dirs)` (DockerSandbox's, the header's Releasing) when `sandbox` has one: a caller holding any
 * Sandbox hands over the trees it removed, and a driver whose daemon holds nothing of them (the process and k8s
 * drivers, a Linux docker host) does nothing. Never throws.
 */
export async function releaseRemovedTrees(sandbox: Sandbox, dirs: readonly string[]): Promise<void> {
  const release = (sandbox as Partial<Pick<DockerSandbox, 'releaseRemoved'>>).releaseRemoved;
  if (typeof release !== 'function' || dirs.length === 0) return;
  try {
    await release.call(sandbox, dirs);
  } catch {
    // DockerSandbox's never throws; a wrapper's fault costs the VM's handles, never the caller's work.
  }
}

/** What the docker CLI itself needs from the host environment (daemon address, config, PATH). */
export function dockerCliEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR' || k.startsWith('DOCKER_') || k === 'XDG_RUNTIME_DIR') out[k] = v;
  }
  return out;
}

/** The pulls under way, by docker CLI and reference: preflights of one missing image at once share one `docker pull`. */
const pulling = new Map<string, Promise<void>>();
/** The most of a pull's stderr kept for its error. */
const PULL_STDERR_BYTES = 4096;

/**
 * `docker pull <ref>` (a pinned `<image>@sha256:<digest>`, never a tag), without blocking this process: resolves once the
 * daemon holds it; a SandboxError when docker does not run, the pull fails, or it is not done in `timeoutMs` (then the
 * client is killed; the daemon's partial layers stay for the next pull). Concurrent calls for one reference share one pull.
 */
export function pullImage(docker: string, ref: string, timeoutMs: number = PULL_TIMEOUT_MS): Promise<void> {
  const key = `${docker}\0${ref}`;
  const held = pulling.get(key);
  if (held !== undefined) return held;
  const pull = new Promise<void>((resolve, reject) => {
    const child = spawn(docker, ['pull', ref], { stdio: ['ignore', 'ignore', 'pipe'], env: dockerCliEnv() });
    let stderr = '';
    let timedOut = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s: string) => {
      if (stderr.length < PULL_STDERR_BYTES) stderr += s.slice(0, PULL_STDERR_BYTES - stderr.length);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new SandboxError(`docker is not runnable: ${err.message}`, { cause: err }));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const said = stderr.trim().split('\n').find((l) => l.trim() !== '') ?? '';
      const how = timedOut ? `did not finish in ${Math.round(timeoutMs / 1000)} s` : `exited ${code ?? signal}`;
      reject(new SandboxError(`image ${ref} is not present, and docker pull ${how}${said === '' ? '' : `: ${said}`}`));
    });
  }).finally(() => pulling.delete(key));
  pulling.set(key, pull);
  return pull;
}

/** How long removeContainer gives a `docker run` client to exit by itself before it SIGKILLs it (the header's Killing). */
export const CLIENT_KILL_MS = 10_000;
/** How long removeContainer goes on removing a container docker has not said is gone, from its first `docker rm -f`. */
export const REMOVE_CONFIRM_MS = 60_000;
/** removeContainer's first wait between two removals, doubled each round up to REMOVE_BACKOFF_MAX_MS. */
export const REMOVE_BACKOFF_MS = 250;
export const REMOVE_BACKOFF_MAX_MS = 2_000;
/** How long one `docker rm -f` may take before it is SIGKILLed and counted as no answer. */
export const REMOVE_CALL_MS = 20_000;
const REMOVE_OUTPUT_BYTES = 4096;

/** How a `docker run` client ended: `ran` false when it never started (no such CLI), else its exit code or the signal that ended it. */
export interface ClientEnd {
  ran: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** `child`'s end, once it is gone: a spawn that failed (no pid) as soon as it fails, else its close. */
export function clientEndOf(child: ChildProcess): Promise<ClientEnd> {
  return new Promise<ClientEnd>((resolve) => {
    // An 'error' with a pid is a kill or a write that failed: the close still comes.
    child.once('error', () => {
      if (child.pid === undefined) resolve({ ran: false, code: null, signal: null });
    });
    child.once('close', (code, signal) => resolve({ ran: child.pid !== undefined, code, signal }));
  });
}

/**
 * What one `docker rm -f <name>` found: `removed` (it printed the name), `absent` (nothing there: no output and exit 0, or
 * `No such container`), `removing` (a removal already under way: it was there), `unknown` (any other answer, or none within
 * `callMs`: the daemon unreachable or stuck), `unrunnable` (no such CLI). `why`: the first line of what it said.
 */
interface Removal {
  found: 'removed' | 'absent' | 'removing' | 'unknown' | 'unrunnable';
  why: string;
}

function removeOnce(docker: string, name: string, callMs: number): Promise<Removal> {
  return new Promise<Removal>((resolve) => {
    let out = '';
    let err = '';
    const rm = spawn(docker, ['rm', '-f', name], { stdio: ['ignore', 'pipe', 'pipe'], env: dockerCliEnv() });
    const timer = setTimeout(() => rm.kill('SIGKILL'), callMs);
    rm.stdout.setEncoding('utf8').on('data', (s: string) => {
      if (out.length < REMOVE_OUTPUT_BYTES) out += s;
    });
    rm.stderr.setEncoding('utf8').on('data', (s: string) => {
      if (err.length < REMOVE_OUTPUT_BYTES) err += s;
    });
    rm.once('error', (e) => {
      if (rm.pid !== undefined) return;
      clearTimeout(timer);
      resolve({ found: 'unrunnable', why: e.message });
    });
    rm.once('close', (code, signal) => {
      clearTimeout(timer);
      const said = err.trim().split('\n')[0] ?? '';
      if (out.split('\n').some((l) => l.trim() === name)) resolve({ found: 'removed', why: said });
      else if (/already in progress/i.test(err)) resolve({ found: 'removing', why: said });
      else if (/no such container/i.test(err) || (code === 0 && signal === null)) resolve({ found: 'absent', why: said });
      else resolve({ found: 'unknown', why: said !== '' ? said : signal === null ? `exit ${code}` : `no answer within ${callMs} ms` });
    });
  });
}

export interface RemoveContainerOptions {
  docker: string;
  /** The container's name, as `docker run --name` gave it. */
  name: string;
  /** The `docker run` client's end (clientEndOf). */
  clientEnd: Promise<ClientEnd>;
  /** SIGKILL the client: it did not go within `clientMs`. */
  killClient: () => void;
  /** Where a container docker never said was gone is reported, one line. */
  warn: (line: string) => void;
  /** Defaults CLIENT_KILL_MS, REMOVE_CONFIRM_MS, REMOVE_BACKOFF_MS, REMOVE_BACKOFF_MAX_MS, REMOVE_CALL_MS. */
  clientMs?: number;
  confirmMs?: number;
  backoffMs?: number;
  backoffMaxMs?: number;
  callMs?: number;
}

/**
 * Remove the container a `docker run --rm --name <name>` client runs, for good (the header's Killing): `docker rm -f`, then
 * again with backoff while the client runs until one removes the container (the client exits by itself once it is gone),
 * the client SIGKILLed after `clientMs`. A client that exited by itself is docker's word that its container is gone (or
 * never made); one that never started made nothing. A killed client may have sent a create or start that lands yet, so
 * removal goes on until an rm -f removes the container or finds it gone after one found it there, until `confirmMs` from
 * the start; a container then not confirmed gone (an answer other than "none there") is warned of. Never rejects.
 */
export async function removeContainer(o: RemoveContainerOptions): Promise<void> {
  const clientMs = o.clientMs ?? CLIENT_KILL_MS;
  const confirmMs = o.confirmMs ?? REMOVE_CONFIRM_MS;
  const backoffMaxMs = o.backoffMaxMs ?? REMOVE_BACKOFF_MAX_MS;
  const callMs = o.callMs ?? REMOVE_CALL_MS;
  const deadline = Date.now() + confirmMs;
  let wait = o.backoffMs ?? REMOVE_BACKOFF_MS;
  const nextWait = (): number => {
    const w = wait;
    wait = Math.min(wait * 2, backoffMaxMs);
    return w;
  };
  let ended = false;
  void o.clientEnd.then(() => {
    ended = true;
  });
  let killed = false;
  const timer = setTimeout(() => {
    if (ended) return;
    killed = true;
    o.killClient();
  }, clientMs);
  timer.unref();
  // seen: a removal found the container there, so its create has landed and the next "none there" is final.
  const s: { seen: boolean; last: Removal } = { seen: false, last: { found: 'absent', why: '' } };
  const remove = async (): Promise<Removal> => {
    const r = await removeOnce(o.docker, o.name, callMs);
    if (r.found === 'removed' || r.found === 'removing') s.seen = true;
    s.last = r;
    return r;
  };
  try {
    // While the client runs: remove until a removal finds the container, then only wait for the client to go.
    for (;;) {
      if (!s.seen && s.last.found !== 'unrunnable') await remove();
      if (await settlesWithin(o.clientEnd, nextWait())) break;
    }
  } finally {
    clearTimeout(timer);
  }
  const end = await o.clientEnd;
  if (!end.ran || (!killed && end.signal === null)) return;
  // The client was killed: a create or start it sent may land yet.
  for (;;) {
    const r = await remove();
    if (r.found === 'unrunnable') return;
    if (r.found === 'removed' || (s.seen && r.found === 'absent')) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(nextWait(), Math.max(0, deadline - Date.now()))));
  }
  if (s.last.found === 'absent') return;
  o.warn(`docker sandbox: container ${o.name} may still be there: no docker rm -f confirmed it gone within ${confirmMs} ms of its kill (${s.last.found}${s.last.why === '' ? '' : `: ${s.last.why}`})`);
}

class DockerProcess implements SandboxProcess {
  readonly stdin;
  readonly stdout;
  readonly stderr;
  readonly exited: Promise<SandboxExit>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #docker: string;
  readonly #name: string;
  readonly #end: Promise<ClientEnd>;
  readonly #warn: (line: string) => void;
  #killing: Promise<void> | null = null;

  constructor(child: ChildProcessWithoutNullStreams, docker: string, name: string, warn: (line: string) => void) {
    this.#child = child;
    this.#docker = docker;
    this.#name = name;
    this.#warn = warn;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.exited = new Promise<SandboxExit>((resolve) => {
      // The CLI could not be started at all: report it as docker run's own failure.
      child.once('error', (err) => resolve({ code: DOCKER_RUN_FAILURE, signal: null, error: `docker: ${err.message}` }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    this.#end = clientEndOf(child);
  }

  kill(): Promise<void> {
    this.#killing ??= (async () => {
      // Removed by name until docker has it gone, even when this kill came before the daemon created it (the header's Killing).
      await removeContainer({ docker: this.#docker, name: this.#name, clientEnd: this.#end, killClient: () => this.#child.kill('SIGKILL'), warn: this.#warn });
      await this.exited;
    })();
    return this.#killing;
  }
}

/** True when `p` settles within `ms`. */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
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

/** Where MeterReadings reports: each reading, the fault, and whether reporting has stopped. */
export interface MeterSink {
  onUsage: TreeMeterOptions['onUsage'];
  fault(message: string): void;
  /** True once stop() was called or the fault reported: nothing more is read. */
  quiet(): boolean;
}

/**
 * A meter's stdout as readings, whichever sandbox runs the meter script: each whole line one reading
 * (METER_LINE_RE) to onUsage, anything else (or an unfinished line past METER_PARTIAL_CHARS) the fault.
 */
export class MeterReadings {
  readonly #sink: MeterSink;
  #partial = '';

  constructor(sink: MeterSink) {
    this.#sink = sink;
  }

  push(s: string): void {
    if (this.#sink.quiet()) return;
    const lines = (this.#partial + s).split('\n');
    this.#partial = lines.pop()!;
    for (const line of lines) {
      const m = METER_LINE_RE.exec(line);
      if (m === null) {
        this.#sink.fault(`the meter printed ${JSON.stringify(line.slice(0, 80))}, not a reading`);
        return;
      }
      this.#sink.onUsage({ entries: Number(m[1]), bytes: Number(m[2]), depth: Number(m[3]), longPaths: Number(m[4]) });
      if (this.#sink.quiet()) return;
    }
    if (this.#partial.length > METER_PARTIAL_CHARS) this.#sink.fault(`the meter printed ${JSON.stringify(this.#partial.slice(0, 80))}, not a reading`);
  }
}

class DockerMeter implements TreeMeter {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #docker: string;
  readonly #name: string;
  readonly #opts: TreeMeterOptions;
  readonly #closed: Promise<void>;
  readonly #end: Promise<ClientEnd>;
  readonly #warn: (line: string) => void;
  readonly #readings: MeterReadings;
  /** stop() was called, or the fault reported: nothing more is reported. */
  #quiet = false;
  #stopping: Promise<void> | null = null;
  #stderr = '';

  constructor(child: ChildProcessWithoutNullStreams, docker: string, name: string, opts: TreeMeterOptions, warn: (line: string) => void) {
    this.#child = child;
    this.#docker = docker;
    this.#name = name;
    this.#opts = opts;
    this.#warn = warn;
    this.#end = clientEndOf(child);
    this.#readings = new MeterReadings({ onUsage: (u) => opts.onUsage(u), fault: (m) => this.#fault(m), quiet: () => this.#quiet });
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.stdout.setEncoding('utf8').on('data', (s: string) => this.#readings.push(s));
    child.stderr.setEncoding('utf8').on('data', (s: string) => {
      if (this.#stderr.length < METER_STDERR_BYTES) this.#stderr += s.slice(0, METER_STDERR_BYTES - this.#stderr.length);
    });
    this.#closed = new Promise<void>((resolve) => {
      child.once('error', (err) => {
        this.#fault(`docker: ${err.message}`);
        resolve();
      });
      child.once('close', (code, signal) => {
        const why = this.#stderr.trim().split('\n')[0] ?? '';
        this.#fault(`the meter container exited (${signal === null ? `code ${code}` : `signal ${signal}`})${why === '' ? '' : `: ${why}`}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      this.#quiet = true;
      // Its stdin closing is what ends it (the script's watcher), even when the container is not up yet.
      this.#child.stdin.end();
      if (await settlesWithin(this.#closed, METER_STOP_MS)) return;
      // A meter that did not go (its client cut off from the daemon, or its container not made yet): removed by name until
      // docker has it gone, its client SIGKILLed if it stays (the header's Killing).
      await removeContainer({ docker: this.#docker, name: this.#name, clientEnd: this.#end, killClient: () => this.#child.kill('SIGKILL'), warn: this.#warn });
      await this.#closed;
    })();
    return this.#stopping;
  }

  /** Report the meter's failure (once, never after stop()), then make sure it is gone. */
  #fault(message: string): void {
    if (this.#quiet) return;
    this.#quiet = true;
    this.#opts.onFault(message);
    void this.stop();
  }
}

/** A reading asked for and not yet answered. */
interface PendingReading {
  resolve(v: bigint): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** The clock container (the header's Timing, cpuClockArgs) behind CpuClock: one line in, one reading out, in order. */
class DockerCpuClock implements CpuClock {
  readonly source: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #docker: string;
  readonly #name: string;
  readonly #path: string;
  readonly #exited: Promise<void>;
  readonly #end: Promise<ClientEnd>;
  readonly #warn: (line: string) => void;
  readonly #pending: PendingReading[] = [];
  #partial = '';
  #stderr = '';
  /** Why no more readings are answered (the clock failed or was closed), or null while it runs. */
  #dead: string | null = null;
  #closing: Promise<void> | null = null;

  constructor(child: ChildProcessWithoutNullStreams, docker: string, name: string, path: string, source: string, warn: (line: string) => void) {
    this.#child = child;
    this.#docker = docker;
    this.#name = name;
    this.#path = path;
    this.source = source;
    this.#warn = warn;
    this.#end = clientEndOf(child);
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.stdout.setEncoding('utf8').on('data', (s: string) => this.#onStdout(s));
    child.stderr.setEncoding('utf8').on('data', (s: string) => {
      if (this.#stderr.length < CPU_CLOCK_STDERR_BYTES) this.#stderr += s.slice(0, CPU_CLOCK_STDERR_BYTES - this.#stderr.length);
    });
    this.#exited = new Promise<void>((resolve) => {
      child.once('error', (err) => {
        this.#fail(`docker: ${err.message}`);
        resolve();
      });
      child.once('close', (code, signal) => {
        const why = this.#stderr.trim().split('\n')[0] ?? '';
        this.#fail(`the CPU clock container exited (${signal === null ? `code ${code}` : `signal ${signal}`})${why === '' ? '' : `: ${why}`}`);
        resolve();
      });
    });
  }

  read(): Promise<bigint> {
    if (this.#dead !== null) return Promise.reject(new SandboxError(`CPU time is unreadable host-side: ${this.#dead}`));
    return new Promise<bigint>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(`the CPU clock gave no reading within ${CPU_CLOCK_READ_MS} ms`), CPU_CLOCK_READ_MS);
      this.#pending.push({ resolve, reject, timer });
      this.#child.stdin.write('\n');
    });
  }

  async settled(): Promise<bigint> {
    let last = await this.read();
    for (let i = 1; i < CPU_CLOCK_SETTLE_READS; i++) {
      await new Promise((r) => setTimeout(r, CPU_CLOCK_SETTLE_MS));
      const next = await this.read();
      if (next === last) return next;
      last = next;
    }
    throw new SandboxError(`CPU time is unreadable host-side: the timing parent's usage_usec still moved after ${CPU_CLOCK_SETTLE_READS} readings ${CPU_CLOCK_SETTLE_MS} ms apart (something else runs under it)`);
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#refuse('the clock was closed');
    this.#closing = (async () => {
      // Its stdin closing is what ends it (the script's read loop).
      this.#child.stdin.end();
      if (!(await settlesWithin(this.#exited, METER_STOP_MS))) {
        // Removed by name until docker has it gone, its client SIGKILLed if it stays (the header's Killing).
        await removeContainer({ docker: this.#docker, name: this.#name, clientEnd: this.#end, killClient: () => this.#child.kill('SIGKILL'), warn: this.#warn });
      }
      // The parent is empty now; only a process allowed to (root on a Linux host) removes it, and nothing is lost when it stays.
      await rmdir(join('/sys/fs/cgroup', this.#path)).catch(() => undefined);
    })();
    return this.#closing;
  }

  #onStdout(s: string): void {
    const lines = (this.#partial + s).split('\n');
    this.#partial = lines.pop()!;
    for (const line of lines) {
      const p = this.#pending.shift();
      if (p === undefined) {
        this.#fail(`the CPU clock printed ${JSON.stringify(line.slice(0, 80))} unasked`);
        return;
      }
      clearTimeout(p.timer);
      const v = cpuClockReading(line);
      if (v === null) {
        const err = new SandboxError(`CPU time is unreadable host-side: the CPU clock read ${JSON.stringify(line.slice(0, 80))}, not the timing parent's usage_usec`);
        p.reject(err);
        this.#fail(err.message);
        return;
      }
      p.resolve(v);
    }
    if (this.#partial.length > 64) this.#fail(`the CPU clock printed ${JSON.stringify(this.#partial.slice(0, 80))}, not a reading`);
  }

  /** No reading is answered from now on (the first why stands): every one asked for is refused with it. */
  #refuse(why: string): void {
    if (this.#dead !== null) return;
    this.#dead = why;
    for (const p of this.#pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(new SandboxError(`CPU time is unreadable host-side: ${why}`));
    }
  }

  /** The clock failed: #refuse, then make sure its container is gone. */
  #fail(why: string): void {
    this.#refuse(why);
    void this.close();
  }
}
