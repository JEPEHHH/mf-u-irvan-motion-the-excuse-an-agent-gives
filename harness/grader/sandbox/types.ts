// The sandbox contract the harnesses drive: start one entry (or scorer) program with its code
// mounted read-only at /bot, talk to it over stdin/stdout, read its stderr, kill it. Three drivers,
// each meeting the whole contract below (a driver that cannot carry a spec refuses it):
//
//   docker.ts    `docker run` with the hardened flag set, an image pinned by digest (a host's grader)
//   k8s.ts       one gVisor pod per program on make.fun's cluster, the program exec'd into it (production)
//   process.ts   tests only: `node <dir>/<script>` on the host with the same explicit environment
//
// A program sees exactly: its code at /bot (read-only), the extra mounts below at fixed container
// paths, a writable /tmp, and the environment TZ=UTC, PYTHONHASHSEED=0, LANG=C.UTF-8 (never the
// host's) plus what its spec's `env` adds from a short allowlist (checkSandboxEnv) and its spec's
// `secrets` (checkSandboxSecrets: an entrant's env-lane entry secrets, contracts/entry-secrets.ts).
// Every mount also stands in for itself in the environment (MOUNT_POINTS' variable; containerMountEnv):
// the value is the mount's own path in a container and the host directory on the process driver, so a
// program that reads MAKEFUN_OUTPUT_DIR finds /output in the grader as it finds its output directory on
// the host. The two trial-service mounts whose variables a house program reads as its process-driver
// mark are the exception (CONTAINER_UNSET_MOUNTS).
//
// Mounts: what a host directory holds, and when (mounts.ts checkSandboxMounts checks a spec's for
// every driver). A read-only mount (and /bot, and a launcher's /house) holds what its host directory
// held when the program started; the harness changes nothing under it while the program runs. A
// writable mount's host directory holds what the program wrote there once `exited` has settled, at
// most what its `returns` lets back; while the program runs, it holds in step with the program only the
// files the mount names `live` (a `follow` one as an append-only file that grows as the program's
// does), and nothing else of it is promised: the harness reads nothing else there before `exited`, and
// meters the rest through meterTree. `finished` (SandboxProcess) is the program's own end, which may
// come before the driver has returned those files. The docker and process drivers bind the host
// directory itself, so every file is live and all of it already back: they meet the contract as it
// stands. A containerized driver that copies trees in and out (k8s.ts) keeps it by the copy.
//
// A secret is a variable like any other to the program, and nowhere else: every driver carries it out
// of band, never on an argv, in a pod spec or in a message. docker.ts writes the spawn's secrets to an
// --env-file (0600, in a 0700 directory of its own) and removes it once docker has created the
// container; k8s.ts carries them on the program's exec, after the nonce on its stdin's first line, and its
// wrapper exports them before the program runs (k8s.ts's header, Exec env: never in the pod or its Secret);
// process.ts sets them in the child's environment. A secret never shares a name with anything else a
// sandbox sets, because Docker and Kubernetes both let the later of two variables of one name win
// (#3341): checkSandboxSecrets refuses the collision, and every driver refuses what any driver could
// not carry, so a secret never runs on one driver and not another. No SandboxError quotes a value.
//
// A driver may also meter a program's writable mount while it runs (Sandbox.meterTree: docker.ts's
// meter container; k8s.ts's watch container in the program's own pod, asked for right after the spawn),
// so a harness holds the program to its output caps whatever modes it sets there. A meter that cannot
// read a directory says so (TreeUsage.unread), and the harness gives it a grace before it is a breach
// (k8s-watch.ts UnreadGrace).
//
// No network, unless the spec names a trial's network (grader/sandbox/network.ts): then the
// container sits on that trial's internal network only, under the aliases the spec gives it (an
// agent trial's `agent`, `store`, `llm`; a scrape trial's gateway also under the real host names it
// stands in for, `hosts`), and the forwarder or gateway alone also on the host's egress bridge. A
// containerized driver makes and removes those networks itself (Sandbox.networks, TrialNetworks). The
// process driver shares the host's loopback instead and isolates nothing.
//
// A scrape trial's entry runs under the house launcher (grader/scrape/launch.ts, a spec's
// `launcher`): the container's PID 1 is the launcher, which times the entry and drops it to the
// sandbox user; docker.ts gives that container the launcher privilege set. The launcher starts the
// entry with launch.json's env alone, never the container's, so a mount's stand-in reaches the entry
// only where launch.json's env carries it (a scrape trial's /output one does; grader/scrape/trial.ts).
// A `launcher` spec is the docker driver's alone: the process driver has no root to drop from, so
// there the launcher runs as the program itself (its script launch.ts, launch.json with no uid).
//
// A race's racer (grader/race.ts runRacer, a spec's `race`) is one program kept for a whole race
// window, which runs far past any grade's wall budget: a containerized driver ends it by its own
// deadline, never by the age at which the sweeps take what a crashed grader left (network.ts
// STALE_AFTER_MS). So its container carries no grader mark (docker.ts CONTAINER_LABEL, which every
// sweep and reap lists by) and is marked a race's instead: k8s.ts's pod `makefun.io/sandbox=race`
// with activeDeadlineSeconds its lifetime, docker.ts's container `makefun.race=<deadline>`, which
// network.ts sweepExpiredRaces (TrialNetworks.sweepRaces) removes once that deadline has passed. A
// race spec runs one lockstep bot alone: its code at /bot, no network, mount, env, secret or launcher.
//
// A patch/v1 run (a spec's `image`) runs in the competition's own repository image, pinned by digest,
// instead of a runtime's: the house runner at /bot, the sealed tree at /base and the owner's tests at
// /tests (both read-only), and the entrant's work in RAM at /work (a spec's `work`: a tmpfs of its
// size, counted in the container's memory limit, never on the grader's disk). The docker driver runs
// the image's argv in place of a runtime's interpreter, with no network; the process driver runs the
// spec's script under the host's /bin/sh, a fresh scratch directory standing in for /work
// (WORK_DIR_ENV); the k8s driver refuses it (SandboxError code `repo_image_unsupported`). The one image spec the k8s
// driver runs is a house image's: a sandbox made with K8sSandboxOptions.houseImages (the validated work desk's
// validator images, never a bundle's) runs a spec whose `<repository>@<digest>` is one of them, its argv under the
// program's exec wrapper, with no /work and no network (k8s.ts's header, house image); every other is refused so.
//
// A driver may also run an entry's programs as the containers of one sandbox (Sandbox.pods, a SandboxPodPlan:
// k8s.ts podPlanSpec): an agent trial's `entry` and `env`, a scrape heat's `entry` (under its launcher) with its
// /output metered (SandboxPodPlan.meter). Each member's mounts are its own: on k8s a disk volume each, staged in before
// any member exists and its writable ones collected back once its program ends, as a split pod's. A program/v1 grade is never a plan: each execution is one pod of its own (a per-file one's cases a session's, below). What that layout shares, plainly: the members of
// one pod share its network namespace (loopback ports, abstract unix sockets), its /dev/shm and its memory and CPU
// totals, and an env member's hidden state and house token sit in the same gVisor sandbox as the entrant's code,
// which is weaker than separate pods; each member keeps its own PID and mount namespaces, its own /tmp and its own
// uid (deploy/k8s/README.md, Measured: two containers in one gVisor pod). No model key is ever a member's: what holds
// one runs as a hosted lane (HostedServices) reached through the door (Door), and a plan carries the door's address
// and ports, never a key. A plan member has no `network` (its pod's names are the plan's `local` and `doors`), no
// `race`, `image` or `work` (checkSandboxPodPlan).
//
// A driver may also run programs of one spec one after another in one sandbox (Sandbox.sessions, a SandboxSession: the
// cases of a per-file program/v1 execution, grader/program.ts executePerCase). A session is opened with a template spec
// and runs one program at a time; each spawn's spec is the template's but for its mounts' host directories, its label and
// its wall budget (checkSessionRun refuses any other difference, a SandboxError before anything starts), and a template
// is a plain program's: no network, launcher, race, image or work (checkSessionTemplate). What a session's runs share:
// the sandbox itself (on k8s one pod: its code at /bot staged once, its image, limits, environment and secrets, its node).
// What each run gets fresh, as a program spawned on the sandbox itself would: its read-only mounts hold what its own host
// directories held when it started and nothing an earlier run was given; its writable mounts and /tmp start empty; no
// process of an earlier run is alive when it starts; and nothing an earlier run left in the sandbox (a file, shared
// memory, a SysV or POSIX IPC object, a keyring) is there for it to find. So a run's outcome (its exit, stdout, stderr,
// `started` and `finished`, what comes back of its writable mounts) is the one the same spec gives on the sandbox itself,
// and a run that wrecks its sandbox (out of memory, its PID 1 killed) loses itself alone: the driver gives the next run a
// fresh one. A driver offers sessions only where it keeps runs apart so, and runs as the sandbox itself would any run it
// cannot keep apart. close() ends a run still live and gives the sandbox up; it never throws. docker and process offer no
// sessions: each program is a container or a process of its own there already, and a harness spawns each run on the
// sandbox itself.

import { isIP } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import type { RUNTIMES } from '../../contracts/competition.ts';
import { checkSecretName, checkSecretValue, ENTRY_SECRET_MAX_COUNT, ENTRY_SECRET_TOTAL_MAX_BYTES, providerOfSecretName, utf8Bytes } from '../../contracts/entry-secrets.ts';

/** A sandbox runtime (contracts/competition.ts RUNTIMES). */
export type Runtime = (typeof RUNTIMES)[number];

/**
 * The container paths a harness may mount besides /bot, and the variable that stands in for each mount: the process
 * driver sets it to the mount's host directory (process.ts) and a containerized driver to the mount's own path
 * (docker.ts dockerRunArgs, k8s.ts sandboxPodSpec and podPlanSpec, through containerMountEnv below).
 */
export const MOUNT_POINTS = {
  '/input': 'MAKEFUN_INPUT_DIR',
  '/output': 'MAKEFUN_OUTPUT_DIR',
  '/reference': 'MAKEFUN_REFERENCE_DIR',
  '/scores': 'MAKEFUN_SCORES_DIR',
  // A scorer's replay of the trial's cassette (grader/program.ts scoreProgramWithChecks): read-only, and
  // never mounted for the entry itself.
  '/cassette': 'MAKEFUN_CASSETTE_DIR',
  // An agent trial's services (grader/sandbox/network.ts): the store env's code, its seed and its
  // state; the forwarder's config and what it records.
  '/env': 'MAKEFUN_ENV_DIR',
  '/env-data': 'MAKEFUN_ENV_DATA_DIR',
  '/state': 'MAKEFUN_STATE_DIR',
  '/config': 'MAKEFUN_CONFIG_DIR',
  '/record': 'MAKEFUN_RECORD_DIR',
  // A patch/v1 run (a spec's `image`): the sealed upstream tree and the owner's tests.
  '/base': 'MAKEFUN_BASE_DIR',
  '/tests': 'MAKEFUN_TESTS_DIR',
} as const;
export type MountPoint = keyof typeof MOUNT_POINTS;

/**
 * The mount points whose stand-in a containerized driver does not set: MAKEFUN_STATE_DIR and MAKEFUN_RECORD_DIR are
 * also how an agent trial's env (server/agent-env/listen.ts, and every contest env's copy of it) and its forwarder
 * (grader/gateway/main.ts) know they run on the process driver, each binding loopback when its variable is set. Those
 * two programs run in the very containers that mount /state and /record, so setting the variables there would move
 * them off the address a `split` layout's entry reaches them at (grader/sandbox/layout.ts: every contest without a
 * go-live instant runs `split`). Only the process driver sets the two, as it sets every mount's stand-in
 * (process.ts), which is the mark they read.
 */
export const CONTAINER_UNSET_MOUNTS: ReadonlySet<MountPoint> = new Set<MountPoint>(['/state', '/record']);

/**
 * The environment a containerized driver adds for the mounts a spec carries (docker.ts dockerRunArgs, k8s.ts
 * sandboxPodSpec and podPlanSpec): each mount's MOUNT_POINTS variable with the mount's own container path as its
 * value, in name order, less CONTAINER_UNSET_MOUNTS'. `mounts` is mounts.ts checkSandboxMounts' already (the caller
 * checks once); the process driver sets the same names to the host directories instead (process.ts).
 */
export function containerMountEnv(mounts: readonly SandboxMount[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of mounts) {
    if (CONTAINER_UNSET_MOUNTS.has(m.at)) continue;
    out.push([MOUNT_POINTS[m.at], m.at]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Where a spec's `work` tmpfs sits in the container, and the variable the process driver names its scratch directory by instead. */
export const WORK_DIR = '/work';
export const WORK_DIR_ENV = 'MAKEFUN_WORK_DIR';

/** The only environment a sandboxed program gets. */
export const SANDBOX_ENV: Readonly<Record<string, string>> = Object.freeze({ TZ: 'UTC', PYTHONHASHSEED: '0', LANG: 'C.UTF-8' });

/**
 * The variables a spec's `env` may set besides MAKEFUN_* ones: the base URLs and the dummy keys an
 * agent's SDKs read. Never a proxy, PATH, NODE_OPTIONS or anything the loader reads.
 */
export const SPEC_ENV_NAMES: ReadonlySet<string> = new Set(['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
const SPEC_ENV_MAKEFUN_RE = /^MAKEFUN_[A-Z0-9_]+$/;

/** The name stem of an agent trial's internal network (`makefun-net-<trial>`, network.ts trialNetworkName). */
export const TRIAL_NETWORK_PREFIX = 'makefun-net-';
/** A trial's label: lowercase [a-z0-9-], at most 41 characters (like a container label). */
export const TRIAL_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** The host's one egress bridge, which only a forwarder joins besides its trial network. */
export const EGRESS_NETWORK = 'makefun-egress';
const ALIAS_RE = /^[a-z][a-z0-9-]{0,62}$/;
/** One label of a host name: lowercase letters, digits and inner hyphens, 1 to 63 characters. */
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A host name's length cap (RFC 1035's 253 characters, no trailing dot). */
const HOST_NAME_MAX = 253;

/** The fixed interpreter command per runtime (the script path is appended). */
export const RUNTIME_COMMANDS: Readonly<Record<Runtime, readonly string[]>> = Object.freeze({
  node22: Object.freeze(['node']),
  // -P keeps /bot off sys.path, -s the user site; not -I, which implies -E and would ignore PYTHONHASHSEED.
  'python3.13': Object.freeze(['python3', '-P', '-s']),
});

/** The entry script per runtime, relative to /bot. */
export const ENTRY_SCRIPTS: Readonly<Record<Runtime, string>> = Object.freeze({ node22: 'main.ts', 'python3.13': 'main.py' });

export interface SandboxLimits {
  cpus: number;
  memory_mb: number;
  pids: number;
}

/** One mount of a spec (the header's Mounts; mounts.ts checkSandboxMounts). */
export interface SandboxMount {
  /** Absolute host directory. */
  host: string;
  at: MountPoint;
  readOnly: boolean;
  /**
   * A writable mount only: the files under it the harness reads while the program runs, which a driver keeps in step
   * with the program's (the header). Relative plain paths, each once, at most mounts.ts MAX_LIVE_FILES.
   */
  live?: readonly SandboxLiveFile[];
  /** A writable mount only: how much of it may come back once the program has ended. */
  returns?: SandboxReturns;
}

/** A `live` file of a writable mount. */
export interface SandboxLiveFile {
  /** Its path under the mount: relative POSIX components of [A-Za-z0-9._-], none starting with `.` or `-`. */
  path: string;
  /**
   * An append-only file (a house-clock log) mirrored as it grows: what the program appends is appended to the host
   * file, so a reader by offset sees it. Absent or false: a file written once (a ready file), kept whole each time it
   * settles.
   */
  follow?: boolean;
}

/**
 * How much of a writable mount may come back (SandboxMount.returns). A driver that copies the mount back stops once
 * past either, and says so; one that binds the host directory (docker, process) has nothing to copy and ignores it.
 */
export interface SandboxReturns {
  /** Its entries, every inode under it (the directory itself not counted): a positive integer. */
  maxEntries: number;
  /** Its regular files' bytes: a positive integer. */
  maxBytes: number;
}

export interface SandboxSpec {
  runtime: Runtime;
  /** Absolute host directory mounted read-only at /bot (a materialized snapshot, or a scorer's directory). */
  codeDir: string;
  /** Script under /bot to run; default ENTRY_SCRIPTS[runtime]. Relative POSIX path, no `..`. */
  script?: string;
  mounts?: readonly SandboxMount[];
  limits: SandboxLimits;
  /** Container name stem (a random suffix is added). */
  label: string;
  /** Run this image digest instead of the pinned one (an L2 regrade re-runs the stored digest). */
  imageDigest?: string | null;
  /** A trial's network to sit on (checkSandboxNetwork); absent, the program has no network at all. */
  network?: SandboxNetwork;
  /** Variables set after SANDBOX_ENV: MAKEFUN_* and SPEC_ENV_NAMES only (checkSandboxEnv). Never with a `launcher`. */
  env?: Readonly<Record<string, string>>;
  /**
   * An entrant's env-lane entry secrets (contracts/entry-secrets.ts), NAME to value: variables of the
   * program like `env`'s, carried by every driver out of band (the header) and never sharing a name with
   * anything else the sandbox sets (checkSandboxSecrets). Never with a `launcher` or a `race`.
   */
  secrets?: Readonly<Record<string, string>>;
  /**
   * Run the house launcher as the container's PID 1 instead of the script (a scrape trial's entry):
   * the docker driver's launcher privilege set, the house read-only at /house, and the entry the
   * launcher starts is launch.json's argv with launch.json's env. No `script` and no `env` with it.
   * The docker driver's alone (the process driver cannot drop privileges).
   */
  launcher?: SandboxLauncher;
  /**
   * A race's racer (the header; grader/race.ts runRacer): kept for its whole window and ended by the
   * driver at its own lifetime, never by the stale sweeps. No network, mount, env, secret or launcher
   * with it (checkSandboxRace).
   */
  race?: SandboxRace;
  /**
   * Run this repository image instead of the runtime's pinned one (a patch/v1 run, the header): its
   * argv in place of the interpreter and the script, no network, launcher, race or imageDigest with it
   * (checkSandboxImage). The process driver runs `/bin/sh <codeDir>/<script>` instead, so a spec it runs
   * names its script.
   */
  image?: SandboxImage;
  /** A writable tmpfs at WORK_DIR of this size (checkSandboxWork); the process driver gives a fresh scratch directory instead. */
  work?: SandboxWork;
  /**
   * `limits.cpus` is a ceiling the platform chose for a house role (the trial's env, network.ts ENV_LIMITS), never an
   * entrant's program, which gets exactly its contest's CPUs or the daemon's refusal. The docker driver then grants at
   * most the host's CPU count (docker.ts grantedCpus), so a host with fewer CPUs still starts it; k8s and process ignore it.
   */
  cpusCeiling?: boolean;
  /**
   * Be scheduled with the whole CPU limit, as a timed pod is (a scrape heat's entry and gateway under a lease that no
   * longer keeps other grading off the host: scrape/trial.ts ScrapeTrialOptions.reserveCpu): the k8s driver requests
   * cpu = the limit in place of min(limit, CPU_REQUEST_MAX_MILLI), a pod plan's member whatever the plan's `requests`
   * spread. Docker and process have no requests and ignore it. Absent or false: the request as ever.
   */
  reserveCpu?: boolean;
}

/** A spec's repository image (a competition's patch/v1 image, contracts/patch.ts). */
export interface SandboxImage {
  /** Lowercase `[registry[:port]/]path`, no tag and no `@`. */
  repository: string;
  /** `sha256:<64 hex>`: the image always runs by digest, never pulled. */
  digest: string;
  /** The container's command: argv[0] its entrypoint (a path or a command name), the rest its arguments. */
  argv: readonly string[];
}

/** A spec's /work tmpfs. */
export interface SandboxWork {
  /** Its size in MiB, a positive integer: what the program writes there counts in its memory limit. */
  mb: number;
}

/** A repository a spec's image names: docker's reference grammar, lowercase, an optional registry host (and port) first. */
const REPOSITORY_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
/** docker's cap on a repository name. */
const REPOSITORY_MAX = 255;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** An image argv's entrypoint: a path or a command name, never an option (docker's `--entrypoint` takes it whole). */
const ENTRYPOINT_RE = /^[A-Za-z0-9_./][A-Za-z0-9_./+-]*$/;
/** The most arguments an image argv carries (a house runner's command, never data). */
export const MAX_IMAGE_ARGV = 64;

/**
 * `<repository>@<digest>`, checked: a lowercase repository (REPOSITORY_RE, at most REPOSITORY_MAX
 * characters, so no tag and no `@`) and a sha256 digest.
 */
export function repoImageRef(repository: string, digest: string): string {
  if (typeof repository !== 'string' || repository.length > REPOSITORY_MAX || !REPOSITORY_RE.test(repository)) {
    throw new SandboxError(`image repository ${JSON.stringify(repository)} must be a lowercase [registry/]path of at most ${REPOSITORY_MAX} characters, no tag and no @`);
  }
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) throw new SandboxError(`image digest ${JSON.stringify(digest)} must be sha256:<64 hex>`);
  return `${repository}@${digest}`;
}

/**
 * The spec's image, checked: its reference (repoImageRef), and an argv of 1 to MAX_IMAGE_ARGV strings
 * without NUL whose first is an entrypoint (ENTRYPOINT_RE); and a spec with no launcher (the house's
 * runtime image), race (one lockstep bot), network (the run is offline) or imageDigest (the digest is
 * the image's own).
 */
export function checkSandboxImage(spec: Pick<SandboxSpec, 'image' | 'launcher' | 'race' | 'network' | 'imageDigest'>): SandboxImage {
  const image = spec.image;
  if (typeof image !== 'object' || image === null) throw new SandboxError(`image must be {repository, digest, argv}, not ${JSON.stringify(image)}`);
  repoImageRef(image.repository, image.digest);
  const argv = image.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_IMAGE_ARGV) throw new SandboxError(`image argv must be a list of 1 to ${MAX_IMAGE_ARGV} strings, not ${JSON.stringify(argv)}`);
  for (const a of argv) {
    if (typeof a !== 'string' || a.includes('\0')) throw new SandboxError(`image argv ${JSON.stringify(a)} must be a string without NUL`);
  }
  if (!ENTRYPOINT_RE.test(argv[0]!)) throw new SandboxError(`image argv[0] ${JSON.stringify(argv[0])} must be a path or a command name`);
  if (spec.launcher !== undefined) throw new SandboxError('an image spec runs its own argv: it has no launcher');
  if (spec.race !== undefined) throw new SandboxError('an image spec is never a race spec');
  if (spec.network !== undefined) throw new SandboxError('an image spec runs offline: it sits on no network');
  if (spec.imageDigest !== undefined && spec.imageDigest !== null) throw new SandboxError("an image spec runs its image's own digest, never an imageDigest");
  return image;
}

/** The spec's work tmpfs, checked: {mb} with mb a positive safe integer. */
export function checkSandboxWork(work: SandboxWork): SandboxWork {
  if (typeof work !== 'object' || work === null || !Number.isSafeInteger(work.mb) || work.mb <= 0) {
    throw new SandboxError(`work must be {mb} with mb a positive integer of MiB, not ${JSON.stringify(work)}`);
  }
  return work;
}

/** A race spec's lifetime (grader/race.ts raceLifetimeMs: the window still ahead, the think budget and RACE_DEADLINE_SLACK_MS). */
export interface SandboxRace {
  /**
   * How long the program may live, in ms from its spawn: past it a containerized driver ends it whatever
   * became of the harness (k8s: the pod's activeDeadlineSeconds; docker: the deadline label
   * sweepExpiredRaces reads). A positive safe integer, at most MAX_RACE_LIFETIME_MS.
   */
  lifetimeMs: number;
}

/** The longest a race spec may live: a race window is at most 72 h (contracts/competition.ts), so a week is ample for its slack. */
export const MAX_RACE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The spec's race, checked: a lifetime that is a positive safe integer of ms, at most
 * MAX_RACE_LIFETIME_MS, and a spec with no network, mount, env, secret or launcher (a racer is one
 * lockstep bot with its code at /bot and nothing else, so nothing of it is a trial's for a reap to take,
 * and the racer holds no seal key to open a secret with).
 */
export function checkSandboxRace(spec: Pick<SandboxSpec, 'race' | 'network' | 'mounts' | 'env' | 'secrets' | 'launcher' | 'work'>): SandboxRace {
  const race = spec.race;
  if (typeof race !== 'object' || race === null) throw new SandboxError(`race must be {lifetimeMs}, not ${JSON.stringify(race)}`);
  const ms = race.lifetimeMs;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_RACE_LIFETIME_MS) throw new SandboxError(`a race's lifetime ${JSON.stringify(ms)} must be a positive integer of ms, at most ${MAX_RACE_LIFETIME_MS}`);
  if (spec.network !== undefined) throw new SandboxError('a race spec runs its bot alone: it sits on no network');
  if (spec.launcher !== undefined) throw new SandboxError('a race spec runs its bot alone: it has no launcher');
  if (spec.mounts !== undefined && spec.mounts.length > 0) throw new SandboxError('a race spec runs its bot alone: nothing is mounted but its code at /bot');
  if (spec.env !== undefined && Object.keys(spec.env).length > 0) throw new SandboxError('a race spec runs its bot alone: it takes no env beyond SANDBOX_ENV');
  if (hasSecrets(spec.secrets)) throw new SandboxError('a race spec runs its bot alone: it takes no secrets');
  if (spec.work !== undefined) throw new SandboxError('a race spec runs its bot alone: it has no /work');
  return race;
}

/** Whether a spec's `secrets` holds any (anything but undefined or an empty map: a malformed one counts, for checkSandboxSecrets to refuse). */
function hasSecrets(secrets: SandboxSpec['secrets']): boolean {
  if (secrets === undefined) return false;
  return typeof secrets !== 'object' || secrets === null || Array.isArray(secrets) || Object.keys(secrets).length > 0;
}

/** A container's place on a trial's network (grader/sandbox/network.ts). */
export interface SandboxNetwork {
  /** The trial's internal network, `makefun-net-<trial>` (network.ts trialNetworkName). */
  name: string;
  /** Names the trial's other containers reach this one by (`agent`, `store`, `llm`): DNS labels. */
  aliases?: readonly string[];
  /**
   * Real host names this container answers for on the trial network (a scrape trial's gateway:
   * `apis.roblox.com`, network.ts scrapeAttachment): dotted lowercase DNS names, given to docker as
   * more aliases after `aliases`.
   */
  hosts?: readonly string[];
  /** Also on the host's egress bridge, EGRESS_NETWORK: the forwarder or the gateway only. */
  egress?: true;
}

/** The house launcher of a spec (grader/scrape/launch.ts). */
export interface SandboxLauncher {
  /**
   * Absolute host directory mounted read-only at /house: the runtime's launcher (launch.ts or
   * launch.py), launch.json and ca.pem, as launch.ts houseFor makes them (writeHouse writes it
   * 0755 with 0644 files: the launcher is root without CAP_DAC_OVERRIDE).
   */
  houseDir: string;
}

/**
 * A host name, checked: dotted lowercase DNS labels, at least two, at most 253 characters, no
 * trailing dot, and a last label that is not all digits (never an IPv4 address).
 */
export function checkHostName(name: string): string {
  const labels = typeof name === 'string' ? name.split('.') : [];
  if (
    typeof name !== 'string' ||
    name.length > HOST_NAME_MAX ||
    labels.length < 2 ||
    !labels.every((l) => HOST_LABEL_RE.test(l)) ||
    /^\d+$/.test(labels.at(-1)!)
  ) {
    throw new SandboxError(`host name ${JSON.stringify(name)} must be a dotted lowercase DNS name (two labels or more, at most ${HOST_NAME_MAX} characters)`);
  }
  return name;
}

/**
 * The spec's network, checked: a trial network by name (never `none`, `host`, `bridge`, the egress
 * bridge or a container's namespace), DNS-label aliases and dotted host names (checkHostName)
 * without repeats among them, and `egress` true or absent.
 */
export function checkSandboxNetwork(network: SandboxNetwork): SandboxNetwork {
  const trial = network.name.startsWith(TRIAL_NETWORK_PREFIX) ? network.name.slice(TRIAL_NETWORK_PREFIX.length) : '';
  if (!TRIAL_RE.test(trial)) throw new SandboxError(`network ${JSON.stringify(network.name)} is not a trial network (${TRIAL_NETWORK_PREFIX}<trial>)`);
  const aliases = network.aliases ?? [];
  for (const a of aliases) {
    if (!ALIAS_RE.test(a)) throw new SandboxError(`network alias ${JSON.stringify(a)} must be a lowercase DNS label`);
  }
  if (new Set(aliases).size !== aliases.length) throw new SandboxError(`network aliases ${JSON.stringify(aliases)} repeat`);
  const hosts = network.hosts ?? [];
  if (!Array.isArray(hosts)) throw new SandboxError(`network hosts must be a list, not ${JSON.stringify(hosts)}`);
  for (const h of hosts) checkHostName(h);
  if (new Set([...aliases, ...hosts]).size !== aliases.length + hosts.length) throw new SandboxError(`network hosts ${JSON.stringify(hosts)} repeat`);
  if (network.egress !== undefined && network.egress !== true) throw new SandboxError(`network egress must be true or absent, not ${JSON.stringify(network.egress)}`);
  return network;
}

/**
 * The spec's launcher, checked: a house directory safe for a `-v` argument (checkHostPath), and a
 * spec with no `script`, no `env` and no `secrets` (the entry the launcher starts takes its argv and env
 * from launch.json, and the launcher itself runs as root with the container's environment).
 */
export function checkSandboxLauncher(spec: Pick<SandboxSpec, 'launcher' | 'script' | 'env' | 'secrets'>): SandboxLauncher {
  const launcher = spec.launcher;
  if (typeof launcher !== 'object' || launcher === null) throw new SandboxError(`launcher must be {houseDir}, not ${JSON.stringify(launcher)}`);
  if (spec.script !== undefined) throw new SandboxError(`a launcher spec runs launch.json's argv; it takes no script (${JSON.stringify(spec.script)})`);
  if (spec.env !== undefined && Object.keys(spec.env).length > 0) throw new SandboxError("a launcher spec's entry gets launch.json's env (grader/scrape/launch.ts houseFor), not the spec's");
  if (hasSecrets(spec.secrets)) throw new SandboxError("a launcher spec's entry gets launch.json's env (grader/scrape/launch.ts houseFor): it takes no secrets");
  checkHostPath(launcher.houseDir);
  return launcher;
}

/**
 * The spec's extra environment, checked: only MAKEFUN_* names and SPEC_ENV_NAMES, never a mount
 * variable (MOUNT_POINTS and WORK_DIR_ENV: every driver sets those from the spec's mounts — a container
 * to the mount's own path, the process driver to its host directory), no NUL in a value. Its entries in name
 * order, so the argv does not depend on how the object was built.
 */
export function checkSandboxEnv(env: Readonly<Record<string, string>> | undefined): Array<[string, string]> {
  if (env === undefined) return [];
  const mountVars = new Set<string>([...Object.values(MOUNT_POINTS), WORK_DIR_ENV]);
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (!SPEC_ENV_MAKEFUN_RE.test(name) && !SPEC_ENV_NAMES.has(name)) throw new SandboxError(`environment variable ${JSON.stringify(name)} is not allowed in a sandbox (MAKEFUN_* or ${[...SPEC_ENV_NAMES].join(', ')})`);
    if (mountVars.has(name)) throw new SandboxError(`environment variable ${name} is a mount variable (the driver sets it from the spec's mounts)`);
    if (typeof value !== 'string' || value.includes('\0')) throw new SandboxError(`environment variable ${name} must be a string without NUL`);
    out.push([name, value]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** An English ordinal: 1st, 2nd, 3rd, 4th, 11th, 21st. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * The spec's secrets, checked: none on a race or launcher spec; at most ENTRY_SECRET_MAX_COUNT; each
 * named by the contract's rule and on none of its reserved lists (checkSecretName; its sandbox group
 * holds the names these drivers' own processes read or set: k8s.ts's wrapper variables, KUBERNETES_*,
 * PERL*, LOCPATH and the docker CLI's proxy variables), on the env lane (a provider-lane value reaches a
 * model only through a trial's gateway forwarder, never a sandbox), and sharing no name with
 * SANDBOX_ENV, SPEC_ENV_NAMES, the spec's env or a mount variable (MOUNT_POINTS),
 * since Docker and Kubernetes both let the later of two variables of one name win (#3341); each value one the contract takes (checkSecretValue: 8 characters
 * to 8192 bytes of UTF-8, no NUL), and ENTRY_SECRET_TOTAL_MAX_BYTES of names and values in all. Its
 * entries in name order. A SandboxError names a secret by its name, or by its place for a name that
 * fails the name rule (which may be a value pasted where its name belongs), and never quotes a value.
 */
export function checkSandboxSecrets(spec: Pick<SandboxSpec, 'secrets' | 'env' | 'race' | 'launcher'>): Array<[string, string]> {
  const secrets = spec.secrets;
  if (!hasSecrets(secrets)) return [];
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) throw new SandboxError('secrets must be a {NAME: value} map');
  if (spec.race !== undefined) throw new SandboxError('a race spec runs its bot alone: it takes no secrets');
  if (spec.launcher !== undefined) throw new SandboxError("a launcher spec's entry gets launch.json's env (grader/scrape/launch.ts houseFor): it takes no secrets");
  const entries = Object.entries(secrets);
  if (entries.length > ENTRY_SECRET_MAX_COUNT) throw new SandboxError(`a sandbox takes at most ${ENTRY_SECRET_MAX_COUNT} secrets, not ${entries.length}`);
  const env = spec.env ?? {};
  const mountVars = new Set<string>(Object.values(MOUNT_POINTS));
  let total = 0;
  const out: Array<[string, string]> = [];
  for (const [i, [name, value]] of entries.entries()) {
    const named = checkSecretName(name, i + 1);
    if (named?.check === 'secret_name') throw new SandboxError(`the ${ordinal(i + 1)} secret's name is not a secret name (letters, digits and _, starting with a letter or _, at most 128 characters)`);
    if (Object.hasOwn(SANDBOX_ENV, name)) throw new SandboxError(`secret ${name} is a SANDBOX_ENV variable, which every sandbox sets`);
    if (SPEC_ENV_NAMES.has(name)) throw new SandboxError(`secret ${name} is one of the variables a spec's env sets for an agent's SDKs (SPEC_ENV_NAMES)`);
    if (Object.hasOwn(env, name)) throw new SandboxError(`secret ${name} is also in the spec's env: Docker and Kubernetes let the later of the two win`);
    if (mountVars.has(name)) throw new SandboxError(`secret ${name} is a mount variable (the driver sets it from the spec's mounts)`);
    if (named !== null) throw new SandboxError(`secret ${named.reason}`);
    if (providerOfSecretName(name) !== null) throw new SandboxError(`secret ${name} is a provider-lane name: its value reaches a model only through a trial's gateway forwarder, never a sandbox`);
    const limits = checkSecretValue(value);
    if (limits !== null) throw new SandboxError(`secret ${name}'s value is no secret value: ${limits.reason}`);
    total += utf8Bytes(name) + utf8Bytes(value);
    out.push([name, value]);
  }
  if (total > ENTRY_SECRET_TOTAL_MAX_BYTES) throw new SandboxError(`the spec's secrets hold ${total} bytes of names and values: a sandbox takes at most ${ENTRY_SECRET_TOTAL_MAX_BYTES}`);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface SandboxExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the driver could not start the program at all (e.g. the docker CLI is missing). */
  error?: string;
}

export interface SandboxProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Settles once the program has exited and its stdio has closed. */
  readonly exited: Promise<SandboxExit>;
  /**
   * Set by a driver whose program begins well after spawn (k8s: a pod to create and see Ready, then the
   * exec): resolves as the program itself starts, which is when its wall budget starts (Supervisor). It
   * never rejects, and never resolves for a program that never ran (`exited` says why). Absent, the
   * program runs from spawn.
   */
  readonly started?: Promise<void>;
  /**
   * Set by a driver with work between the program's end and `exited` (k8s: returning a writable mount's files, then
   * removing the pod): resolves as the program itself ends, which is when its wall time ends (Supervisor), before
   * the driver returns files and removes its container. It never rejects, and resolves no later than `exited`.
   * Absent, the program ends at `exited`.
   */
  readonly finished?: Promise<void>;
  /** Stop it now (idempotent); resolves once it is gone. */
  kill(): Promise<void>;
}

export interface Sandbox {
  /** The driver: `docker` and `k8s` run each program in a container (containerized), `process` on the host. */
  readonly kind: 'docker' | 'process' | 'k8s';
  /** `sha256:<hex>` of the image a runtime runs in (null for the process driver). */
  imageDigest(runtime: Runtime): string | null;
  /** Fail early (missing image, unreachable daemon, refused driver) before anything is executed. */
  preflight(runtime: Runtime, imageDigest?: string | null): Promise<void>;
  spawn(spec: SandboxSpec): SandboxProcess;
  /**
   * True when a non-zero exit code means the driver itself failed (docker run's 125: the daemon
   * refused or the container could not start), so the harness throws instead of blaming the entry.
   */
  isDriverFailure(exit: SandboxExit): boolean;
  /**
   * Delete a directory a sandboxed program could write into. What the program created there may
   * belong to the sandbox user (65534) rather than to this process, or sit deeper than this process
   * can reach by path (ENAMETOOLONG), so the docker driver falls back to deleting it from inside a
   * container running as that user.
   */
  removeTree(dir: string): Promise<void>;
  /**
   * Count what a program writes into `dir`, one of its writable mounts, while it starts and runs,
   * whatever modes it leaves there (docker.ts meterTree: a meter container; k8s.ts meterTree: the
   * `watch` container of the pod that mounts `dir`, so it is asked for right after that program's spawn,
   * and a `dir` no running program of the sandbox mounts writable is refused). Throws SandboxError on a
   * malformed argument, before anything starts. Absent on a driver with no such view (the process
   * driver): the harness then has only its own watch over what it can read.
   */
  meterTree?(dir: string, opts: TreeMeterOptions): TreeMeter;
  /**
   * The driver's trial networks (TrialNetworks below): absent on the process driver, which makes no
   * network and shares the host's loopback.
   */
  readonly networks?: TrialNetworks;
  /**
   * One sandbox for an entry's programs (the header; a SandboxPodPlan, its members the containers of one pod): absent on
   * a driver that runs each program apart, which is every driver today but the k8s driver's one-pod view.
   */
  readonly pods?: SandboxPods;
  /**
   * Programs of one spec run one after another in one sandbox (the header's sessions; a SandboxSession): absent on a
   * driver that runs each program apart (docker, process), where a harness spawns each run on the sandbox itself.
   */
  readonly sessions?: SandboxSessions;
  /**
   * A program and the meter over `dir`, one of its writable mounts, in one sandbox: spawn and meterTree in one call.
   * Throws SandboxError on a malformed argument, before anything starts. No driver has it (the k8s one-pod view's went
   * when program/v1 left the `pod` layout), and no harness calls it: each makes the two calls, spawn then meterTree.
   */
  spawnMetered?(spec: SandboxSpec, dir: string, meterOpts: TreeMeterOptions): MeteredProcess;
}

/** What Sandbox.spawnMetered starts: the program, and the meter over its writable mount. */
export interface MeteredProcess {
  process: SandboxProcess;
  meter: TreeMeter;
}

/** A driver's one-sandbox runs (Sandbox.pods). */
export interface SandboxPods {
  /** Make the plan's pod (checkSandboxPodPlan; a SandboxError on a malformed plan, before anything is made); its members start by SandboxPod.spawn. */
  open(plan: SandboxPodPlan): SandboxPod;
}

/** A driver's runs of one spec in one sandbox (Sandbox.sessions; the header's sessions). */
export interface SandboxSessions {
  /**
   * A session for programs of `template`'s spec, named for its label: a SandboxError on a template checkSessionTemplate
   * refuses, before anything is made. Its runs start by SandboxSession.spawn, one at a time; its caller closes it once
   * the last has ended (or it gave up).
   */
  open(template: SandboxSpec): SandboxSession;
}

/**
 * The sandbox a session runs its programs in (Sandbox.sessions.open; the header's sessions): a Sandbox to the harness that
 * runs them, with no networks, pods, sessions or spawnMetered of its own, plus close().
 *
 * - spawn: starts one run, its spec the template's but for its mounts' host directories, its label and its wall budget
 *   (checkSessionRun), and only while no other run of the session is live: a SandboxError before anything starts
 *   otherwise. The run is what the same spec gives on the sandbox itself (the header), ended by its own kill().
 * - meterTree: the live run's writable mount, as the sandbox's own meter (absent where the sandbox has none).
 * - kind, imageDigest, preflight, isDriverFailure, removeTree: the sandbox's own.
 */
export interface SandboxSession extends Omit<Sandbox, 'networks' | 'pods' | 'sessions' | 'spawnMetered'> {
  /** Kill a run still live and give the sandbox up (idempotent); resolves once it is gone, and never rejects. */
  close(): Promise<void>;
}

/** What a session's template may not have: a session runs plain programs (the header's sessions). */
const SESSION_REFUSED = ['network', 'launcher', 'race', 'image', 'work'] as const;

/** A session's template, checked (the header's sessions): a plain program's spec, with no network, launcher, race, image or work. */
export function checkSessionTemplate(template: SandboxSpec): SandboxSpec {
  if (typeof template !== 'object' || template === null) throw new SandboxError(`a session's template must be a spec, not ${JSON.stringify(template)}`);
  for (const key of SESSION_REFUSED) {
    if (template[key] !== undefined) throw new SandboxError(`a session runs plain programs one after another: its template has a ${key}`);
  }
  return template;
}

/**
 * A session's run, checked against its template, driver-neutral (the header's sessions): the template a plain program's
 * (checkSessionTemplate), and `spec` the template's but for its mounts' host directories, its label and its wall budget.
 * The same runtime, code directory, script (the runtime's entry script when absent), image digest (null when absent),
 * env, secrets, limits.cpus, limits.memory_mb and limits.pids, cpusCeiling and reserveCpu (false when absent); the same
 * mount points, each with the same mode, returns and live files, in any order. A SandboxError naming what differs
 * (a variable or secret by its name, never its value) otherwise; `spec` when it holds.
 */
export function checkSessionRun(template: SandboxSpec, spec: SandboxSpec): SandboxSpec {
  checkSessionTemplate(template);
  const differs = (what: string): never => {
    throw new SandboxError(`a session's run is its template's spec but for its mounts' host directories, its label and its wall budget: its ${what} differs`);
  };
  if (typeof spec !== 'object' || spec === null) throw new SandboxError(`a session's run must be a spec, not ${JSON.stringify(spec)}`);
  for (const key of SESSION_REFUSED) {
    if (spec[key] !== undefined) differs(key);
  }
  if (spec.runtime !== template.runtime) differs('runtime');
  if (spec.codeDir !== template.codeDir) differs('code directory');
  if ((spec.script ?? ENTRY_SCRIPTS[spec.runtime]) !== (template.script ?? ENTRY_SCRIPTS[template.runtime])) differs('script');
  if ((spec.imageDigest ?? null) !== (template.imageDigest ?? null)) differs('image digest');
  for (const key of ['cpus', 'memory_mb', 'pids'] as const) {
    if (spec.limits?.[key] !== template.limits?.[key]) differs(`limits.${key}`);
  }
  if ((spec.cpusCeiling === true) !== (template.cpusCeiling === true)) differs('cpusCeiling');
  if ((spec.reserveCpu === true) !== (template.reserveCpu === true)) differs('reserveCpu');
  const sameEntries = (a: Array<[string, string]>, b: Array<[string, string]>, what: string): void => {
    const left = new Map(a);
    const right = new Map(b);
    for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      if (left.get(name) !== right.get(name)) differs(`${what} ${name}`);
    }
  };
  sameEntries(checkSandboxEnv(template.env), checkSandboxEnv(spec.env), 'environment variable');
  sameEntries(checkSandboxSecrets(template), checkSandboxSecrets(spec), 'secret');
  const own = template.mounts ?? [];
  const run = spec.mounts ?? [];
  if (!Array.isArray(own) || !Array.isArray(run)) differs('mounts');
  const liveOf = (m: SandboxMount): string => JSON.stringify((m.live ?? []).map((f) => [f.path, f.follow === true]));
  const returnsOf = (m: SandboxMount): string => JSON.stringify(m.returns === undefined ? null : [m.returns.maxEntries, m.returns.maxBytes]);
  // A malformed mount (no object) has no point: it matches none, and the run differs.
  const atOf = (m: unknown): unknown => (typeof m === 'object' && m !== null ? (m as SandboxMount).at : undefined);
  for (const t of own) {
    const matching = run.filter((m) => atOf(m) === atOf(t));
    if (atOf(t) === undefined || matching.length !== 1) differs(`mount ${String(atOf(t))}`);
    const m = matching[0]!;
    if (m.readOnly !== t.readOnly) differs(`mount ${t.at}'s mode`);
    if (returnsOf(m) !== returnsOf(t)) differs(`mount ${t.at}'s returns`);
    if (liveOf(m) !== liveOf(t)) differs(`mount ${t.at}'s live files`);
  }
  for (const m of run) {
    if (!own.some((t) => atOf(t) === atOf(m))) differs(`mount ${String(atOf(m))}`);
  }
  return spec;
}

/** The members a sandbox pod may hold, each a container named for it: an agent trial's entry and env, a program's main. */
export const POD_MEMBERS = Object.freeze(['entry', 'env', 'main'] as const);
export type PodMember = (typeof POD_MEMBERS)[number];

/** A plan member's spec: a SandboxSpec with no `network` (the pod's names are its plan's `local` and `doors`). */
export type PodMemberSpec = Omit<SandboxSpec, 'network'>;

/** A name the pod resolves to 127.0.0.1, the member that serves it there and its port (an agent trial's `store`, served by `env` on 8080). */
export interface PodLocalName {
  name: string;
  member: PodMember;
  port: number;
}

/** The door a pod's members reach the hosted lanes by (Door, in the lanes pod): its address, the names that resolve to it, and the port each member dials before its program. */
export interface PodDoors {
  /** The door's address (Door.address: the lanes pod's): an IP. */
  address: string;
  /** The names that resolve to it: an agent trial's `llm` and `house`, a scrape heat's hosts. */
  names: readonly string[];
  /** The door port each member dials until it is taken before its program starts (Door.ports); a member absent dials none. */
  ports: Readonly<Partial<Record<PodMember, number>>>;
}

/** A pod's total requests: CPU in millicores, memory in MiB. */
export interface PodRequests {
  cpuMilli: number;
  memoryMi: number;
}

/**
 * One sandbox for an entry's programs (the header): its members in the order their containers are listed (the
 * object's own key order), and what else the pod is made with. No member has a `network`, `race`, `image` or `work`.
 */
export interface SandboxPodPlan {
  /** The pod's name stem (a sandbox label: lowercase [a-z0-9-], at most 41 characters). */
  label: string;
  members: Readonly<Partial<Record<PodMember, PodMemberSpec>>>;
  /**
   * The member's writable mount SandboxPod.meter meters: on k8s read from the pod's house `watch` container (every
   * member's writable mounts read-only there), never a container of its own.
   */
  meter?: { member: PodMember; at: MountPoint };
  doors?: PodDoors;
  local?: readonly PodLocalName[];
  /** The pod's total requests, spread over its program members (a meter keeps its own); absent: each member's by the driver's rule. */
  requests?: PodRequests;
  /** The trial's owner (network.ts TRIAL_OWNER_RE): what a reap by owner finds the pod by. */
  owner?: string | null;
}

/** A program that can also be asked to stop (SIGTERM to everything it runs), resolving once that was sent. */
export interface TerminableProcess extends SandboxProcess {
  terminate(): Promise<void>;
}

/** The sandbox a SandboxPodPlan made (Sandbox.pods.open). */
export interface SandboxPod {
  /**
   * Resolves once the scheduler has placed the pod. Rejects with the driver's no-room failure for a pod the node had
   * no room for within its ready budget (k8s.ts NodeRoomError: backpressure, the job handed back), or a SandboxError
   * for one it could not make: nothing is minted or started for a pod not placed.
   */
  readonly scheduled: Promise<void>;
  /** The pod's IP once it is Ready (what Door.admit takes); rejects as `scheduled` does, or when it is never Ready. */
  readonly address: Promise<string>;
  /**
   * Start `member`'s program in its container: after its door dial, and after the driver's proof, from inside that
   * container, that it cannot bind a local name's port another member serves.
   */
  spawn(member: PodMember): TerminableProcess;
  /** Meter the plan's `meter` mount until stop() (a SandboxError for a plan with none). */
  meter(opts: TreeMeterOptions): TreeMeter;
  /**
   * Whether the sandbox ran out of memory (only the pod's total is enforced; every member then ends, and nothing of its
   * writable mounts comes back). On k8s a pod evicted for one of its own writable mounts' size limit reads so too: an
   * eviction the kubelet can make minutes after the limit is passed, a backstop behind the meter, never the bound.
   */
  readonly oom: boolean;
  /** Kill whatever still runs and delete the pod (idempotent); resolves once it is gone. */
  close(): Promise<void>;
}

/** A hosted lane's process (HostedServices.spawn): what Door.admit names it by, besides what any program has. */
export interface HostedProcess extends TerminableProcess {
  /** Its id among its host's processes. */
  readonly id: string;
}

/** What HostedServices.spawn starts: `node <dir>/<script>` with its config and record directories, under `label` in what is said of it. */
export interface HostedSpawn {
  dir: string;
  script: string;
  configDir: string;
  recordDir: string;
  label: string;
}

/** Programs that hold a model key (an agent trial's forwarders, a scrape heat's recording gateway), started outside every sandbox an entry runs in. */
export interface HostedServices {
  /** The directory every lane's config and record directories must lie under. */
  readonly root: string;
  spawn(opts: HostedSpawn): HostedProcess;
}

/** The lanes a door joins a pod to: an agent trial's entry and house lanes, a scrape heat's gateway. */
export type DoorLane = 'entry' | 'house' | 'scrape';

/**
 * The door: one TCP port per lane at `address` (`ports`), taking a connection only from a pod IP it admitted, and
 * joining it to the hosted process admitted for that IP on that lane.
 */
export interface Door {
  readonly address: string;
  readonly ports: Readonly<Record<DoorLane, number>>;
  /** Admit pod IP `ip` to each lane named, joined to that hosted process. */
  admit(ip: string, lanes: Readonly<Partial<Record<DoorLane, HostedProcess>>>): Promise<void>;
  /** Admit `ip` no more and cut its connections. */
  forget(ip: string): Promise<void>;
}

/** A DNS label a pod's name may be (a local name, an agent trial's door names). */
const POD_NAME_LABEL_RE = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * The plan, checked, driver-neutral: a sandbox label; at least one member, each one of POD_MEMBERS, with no `network`,
 * `race`, `image` or `work`; a meter over a mount its member makes writable; door names and local names that are DNS
 * labels or host names (checkHostName), none twice across the two, a door address that is an IP and door ports of
 * members; local names served by members on ports; requests of positive integers. Its members in order.
 */
export function checkSandboxPodPlan(plan: SandboxPodPlan): Array<[PodMember, PodMemberSpec]> {
  if (typeof plan !== 'object' || plan === null) throw new SandboxError(`a pod plan must be an object, not ${JSON.stringify(plan)}`);
  if (typeof plan.label !== 'string' || !TRIAL_RE.test(plan.label)) throw new SandboxError(`pod plan label ${JSON.stringify(plan.label)} must be lowercase [a-z0-9-], at most 41 characters`);
  const members = plan.members;
  if (typeof members !== 'object' || members === null || Array.isArray(members)) throw new SandboxError('a pod plan\'s members must be a {member: spec} map');
  const out: Array<[PodMember, PodMemberSpec]> = [];
  for (const [name, spec] of Object.entries(members)) {
    if (!(POD_MEMBERS as readonly string[]).includes(name)) throw new SandboxError(`pod member ${JSON.stringify(name)} is not one of ${POD_MEMBERS.join(', ')}`);
    if (typeof spec !== 'object' || spec === null) throw new SandboxError(`pod member ${name} has no spec`);
    const s = spec as SandboxSpec;
    if (s.network !== undefined) throw new SandboxError(`pod member ${name} has a network: a pod's names are its plan's local names and doors`);
    if (s.race !== undefined) throw new SandboxError(`pod member ${name} is a race's racer, which runs alone in a pod of its own`);
    if (s.image !== undefined) throw new SandboxError(`pod member ${name} runs a repository image (a patch/v1 run is the docker driver's)`, { code: 'repo_image_unsupported' });
    if (s.work !== undefined) throw new SandboxError(`pod member ${name} has a /work tmpfs (a patch/v1 run is the docker driver's)`);
    out.push([name as PodMember, spec]);
  }
  if (out.length === 0) throw new SandboxError('a pod plan has at least one member');
  const has = (m: unknown): m is PodMember => out.some(([n]) => n === m);
  if (plan.meter !== undefined) {
    const { member, at } = plan.meter;
    if (!has(member)) throw new SandboxError(`the pod's meter measures ${JSON.stringify(member)}, which is no member of the plan`);
    const mount = (members[member]!.mounts ?? []).find((m) => m.at === at);
    if (mount === undefined || mount.readOnly) throw new SandboxError(`the pod's meter measures ${JSON.stringify(at)}, which member ${member} does not mount writable`);
  }
  const names: string[] = [];
  const checkName = (name: string, what: string): void => {
    if (typeof name !== 'string' || !(POD_NAME_LABEL_RE.test(name) || isHostName(name))) throw new SandboxError(`${what} ${JSON.stringify(name)} must be a lowercase DNS label or host name`);
    if (names.includes(name)) throw new SandboxError(`${what} ${name} is named twice in the pod plan`);
    names.push(name);
  };
  const checkPort = (port: number, what: string): void => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SandboxError(`${what} ${JSON.stringify(port)} is not a port`);
  };
  for (const l of plan.local ?? []) {
    checkName(l.name, 'local name');
    if (!has(l.member)) throw new SandboxError(`local name ${l.name} is served by ${JSON.stringify(l.member)}, which is no member of the plan`);
    checkPort(l.port, `local name ${l.name}'s port`);
  }
  if (plan.doors !== undefined) {
    const d = plan.doors;
    if (typeof d.address !== 'string' || isIP(d.address) === 0) throw new SandboxError(`the door's address ${JSON.stringify(d.address)} is not an IP address`);
    if (!Array.isArray(d.names) || d.names.length === 0) throw new SandboxError('the door has at least one name');
    for (const n of d.names) checkName(n, 'door name');
    for (const [member, port] of Object.entries(d.ports ?? {})) {
      if (!has(member)) throw new SandboxError(`door port of ${JSON.stringify(member)}, which is no member of the plan`);
      checkPort(port, `member ${member}'s door port`);
    }
  }
  if (plan.requests !== undefined) {
    const r = plan.requests;
    if (typeof r !== 'object' || r === null || !Number.isSafeInteger(r.cpuMilli) || r.cpuMilli <= 0 || !Number.isSafeInteger(r.memoryMi) || r.memoryMi <= 0) {
      throw new SandboxError(`a pod's requests must be {cpuMilli, memoryMi}, positive integers, not ${JSON.stringify(r)}`);
    }
  }
  return out;
}

/** Whether `name` is a host name checkHostName takes. */
function isHostName(name: string): boolean {
  try {
    checkHostName(name);
    return true;
  } catch {
    return false;
  }
}

/** True when a driver runs each program in a container of its own (a trial's services reached by alias, its input at /input). */
export function containerized(kind: Sandbox['kind']): boolean {
  return kind !== 'process';
}

/**
 * A containerized driver's trial networks (docker.ts's on grader/sandbox/network.ts): what an agent
 * or scrape trial makes before its programs start and removes after them, and the engine check it
 * requires first. A trial makes its network (`create`), and the egress bridge when it goes live
 * (`ensureEgress`), before it spawns any of its programs, and spawns its services (an agent trial's
 * store env and forwarder, a scrape trial's gateway) before its entry, each attached by
 * SandboxSpec.network: a driver may make a service's alias resolvable only once that service is
 * spawned, and only to programs spawned after it (k8s's hostAliases, docker's /etc/hosts under
 * runsc-netstack: docker.ts NetstackNames), and the entry finds them by alias from its first
 * instruction.
 */
export interface TrialNetworks {
  /** Make trial `trial`'s internal network, labelled with its owner when one is given; its name. Refuses one that exists. */
  create(trial: string, opts: { owner: string | null }): Promise<string>;
  /** Remove trial `trial`'s network; one already gone is fine. */
  remove(trial: string): Promise<void>;
  /** Remove what a grader that died mid-pass left of trial `owner`; never throws for what it could not remove (the result says). */
  reap(owner: string): Promise<ReapResult>;
  /** Make the egress bridge a live trial's forwarder or gateway reaches the internet on, unless it exists. */
  ensureEgress(): Promise<void>;
  /** Remove the grader containers and trial networks a crashed grader left; never throws for one it could not remove. */
  sweepStale(): Promise<SweepResult>;
  /**
   * Remove the race containers (a spec's `race`) whose deadline has passed: what a racer that died left
   * of its bot, which sweepStale never takes (the header). Absent where the driver ends a race's program
   * itself (k8s: its pod's activeDeadlineSeconds). Never throws for one it could not remove.
   */
  sweepRaces?(): Promise<SweepResult>;
  /** The engine's verdict on keeping trials apart (kept per process); rejects with SandboxError when it could not find out. */
  isolation(): Promise<IsolationVerdict>;
}

/** What TrialNetworks.reap removed of one trial, and what it could not. */
export interface ReapResult {
  /** The trial's owner (the OWNER_LABEL value it reaped by). */
  owner: string;
  /** The containers removed, by name. */
  containers: string[];
  /** The networks removed, by name. */
  networks: string[];
  /** What could not be listed or removed (the reap goes on past each). */
  errors: string[];
}

/** What TrialNetworks.sweepStale removed, and what it could not. */
export interface SweepResult {
  /** Container ids removed. */
  containers: string[];
  /** Network names removed. */
  networks: string[];
  /** What could not be listed, dated or removed (the sweep goes on past each). */
  errors: string[];
}

/** What an isolation probe found not enforced (network.ts IsolationRefusal.fault): the docker driver's probe's, then the k8s driver's (k8s-network.ts). */
export type IsolationFault =
  /** The egress bridge carries enable_icc=false and a container there reached another: the daemon writes no iptables rule, or bridged traffic skips them. */
  | 'egress_icc_off'
  /** A container on the egress bridge reached another, and the bridge was made without enable_icc=false. */
  | 'egress_icc_unset'
  /** A container on an internal network made as a trial's had a default route, or reached the egress bridge. */
  | 'internal_route'
  /** A pod under the namespace's egress policy reached another: the cluster enforces none of the namespace's NetworkPolicies. */
  | 'policy_not_enforced'
  /** A pod on a trial's network (its NetworkPolicy) reached an egress pod or the world past it. */
  | 'trial_pod_escapes';

/** An engine's verdict: trials kept apart (what was tried), or not (what, and what fixes it). */
export type IsolationVerdict =
  | { enforced: true; engine: string; detail: string }
  | { enforced: false; engine: string; fault: IsolationFault; reason: string; fix: string };

/** What one meter pass counted under a writable mount. */
export interface TreeUsage {
  /** Its entries, every inode (files, directories, links, FIFOs; the directory itself not counted). */
  entries: number;
  /** Its regular files' size: the larger of their apparent total and their allocated total (512-byte blocks), so neither a sparse nor a preallocated file hides disk. */
  bytes: number;
  /** Its deepest entry's depth: 1 for one directly in it, 0 when it is empty. */
  depth: number;
  /** How many entries' paths, relative to it, are longer than maxPathBytes (a pass stops at the first). */
  longPaths: number;
  /**
   * How many directories under it the meter could not list or enter, so what they hold went uncounted. Absent or 0
   * from a meter that reads everything: docker.ts's, which runs as root with DAC_READ_SEARCH. k8s.ts's counts as the
   * grader's uid, so a directory the program closed to it is counted here; a caller gives it the grace of
   * k8s-watch.ts UnreadGrace before it is a breach.
   */
  unread?: number;
}

export interface TreeMeterOptions {
  /**
   * The program's runtime, and the image digest it runs (default: the runtime's pinned one): docker's meter runs in that
   * image (k8s's in its program's pod, whose image it is already).
   */
  runtime: Runtime;
  imageDigest?: string | null;
  /** The program's container name stem: docker's meter is `makefun-<label>-<hex>-meter`. */
  label: string;
  /** The program's wall budget: a meter nobody stops goes by itself METER_SLACK_MS after it. */
  budgetMs: number;
  /** ms between the end of one pass and the start of the next. */
  intervalMs: number;
  /** A pass stops counting once past any cap (or at the first long path): its reading is then over that cap. */
  maxEntries: number;
  maxBytes: number;
  maxDepth: number;
  maxPathBytes: number;
  /** Each pass's reading. */
  onUsage(usage: TreeUsage): void;
  /**
   * The meter failed before stop() was called (it could not start, it exited, it printed something that is not a
   * reading); called at most once. The driver's failure, never the program's: its caller throws a SandboxError. A
   * meter has no pod of its own on any layout (k8s.ts: it runs in its program's pod's `watch`), so it never waits for
   * room on a node.
   */
  onFault(message: string): void;
}

export interface TreeMeter {
  /** Stop metering (idempotent): nothing is reported once it is called; resolves once the meter is gone. */
  stop(): Promise<void>;
}

/**
 * What a SandboxError's `code` names, for a caller that acts on the kind of failure:
 * `repo_image_unsupported`, a driver that cannot run a spec's `image` (k8s.ts: any image but one of its house images).
 */
export type SandboxErrorCode = 'repo_image_unsupported';

/** The sandbox could not do its job (an infrastructure failure, never the entry's fault). */
export class SandboxError extends Error {
  /** The kind of failure when a caller acts on it (SandboxErrorCode); null for any other. */
  readonly code: SandboxErrorCode | null;

  constructor(message: string, options?: { cause?: unknown; code?: SandboxErrorCode }) {
    super(message, options);
    this.name = 'SandboxError';
    this.code = options?.code ?? null;
  }
}

/**
 * removeTree's failure when the driver deleted as the sandbox user and still could not delete what
 * the program left in `dir` (docker.ts: the reclaim container ran): the program's doing, not the
 * driver's (a SandboxError all the same, for a caller that cannot tell them apart).
 */
export class LeftoverError extends SandboxError {
  readonly dir: string;

  constructor(dir: string, message: string) {
    super(message);
    this.name = 'LeftoverError';
    this.dir = dir;
  }
}

const SCRIPT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const HOST_PATH_RE = /^\/[A-Za-z0-9._/-]*$/;

/** The script path, checked: relative, POSIX, no `..`, no dot-files (the bundle path rule). */
export function scriptOf(spec: Pick<SandboxSpec, 'runtime' | 'script'>): string {
  const script = spec.script ?? ENTRY_SCRIPTS[spec.runtime];
  if (!SCRIPT_RE.test(script)) throw new SandboxError(`script ${JSON.stringify(script)} is not a relative path inside /bot`);
  return script;
}

/**
 * A host path safe to put in a `-v` argument: absolute, and nothing a mount spec would split on (`:` or `,`). On
 * Windows (`platform` win32: process.platform's value, read only where the path is a drive-letter one, and '' with no
 * process, for the browser code that imports this module) a drive-letter path (`C:\Users\…\Temp\…`, either separator,
 * as os.tmpdir() and path.join make them) is taken too, returned with forward slashes (`C:/Users/…`): docker reads the
 * drive's colon as no separator. Past the drive it holds no `,` or `:` (what a mount spec splits on), nothing else
 * Windows refuses in a name (`<>"|?*`, a control character) and no `..` component; a space and a non-ASCII letter (a
 * user profile's name, which the temp directory sits under) are taken, as the argv element docker gets keeps them whole.
 */
export function checkHostPath(path: string, platform: string = hostPlatformOf(path)): string {
  if (platform === 'win32' && typeof path === 'string' && WIN_DRIVE_PATH_RE.test(path)) {
    const rest = path.slice(2).replace(/\\/g, '/');
    if (!rest.includes(',') && !WIN_RESERVED_RE.test(rest) && ![...rest].some((c) => c.charCodeAt(0) < 0x20) && !rest.split('/').includes('..')) return `${path.slice(0, 2)}${rest}`;
  }
  if (!HOST_PATH_RE.test(path) || path.split('/').includes('..')) throw new SandboxError(`host path ${JSON.stringify(path)} must be absolute and use only [A-Za-z0-9._/-]`);
  return path;
}

/** The host's platform for checkHostPath: process.platform where `path` is a drive-letter path and a process is there, else ''. */
function hostPlatformOf(path: string): string {
  if (typeof path !== 'string' || !WIN_DRIVE_PATH_RE.test(path)) return '';
  const p = (globalThis as { process?: { platform?: unknown } }).process?.platform;
  return typeof p === 'string' ? p : '';
}

/** A Windows drive-letter path's start: `C:\` or `C:/`. */
const WIN_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
/** What Windows refuses in a file name past the drive's colon. */
const WIN_RESERVED_RE = /[<>:"|?*]/;

/**
 * A host path the process driver (process.ts) takes. On Windows that is also a drive-letter path (`C:\Users\…\Temp\…`,
 * either separator, as os.tmpdir() and path.join make them): absolute, no `..` component, no character Windows refuses
 * in a name (`<>:"|?*` past the drive's colon, or a control character), spaces and non-ASCII letters allowed (a user
 * profile's name). That driver names a host path only in its child's cwd and environment, never in a mount spec a
 * `:` or `,` would split, and it isolates nothing, so it needs no more; every other driver mounts the path and keeps
 * checkHostPath, as does the process driver for every other path and on every other `platform` (process.platform's
 * value, as the caller passes it, handed on to checkHostPath).
 */
export function checkProcessHostPath(path: string, platform: string): string {
  if (platform !== 'win32' || typeof path !== 'string' || !WIN_DRIVE_PATH_RE.test(path)) return checkHostPath(path, platform);
  const rest = path.slice(2);
  if (WIN_RESERVED_RE.test(rest) || [...rest].some((c) => c.charCodeAt(0) < 0x20) || rest.split(/[\\/]/).includes('..')) {
    throw new SandboxError(`host path ${JSON.stringify(path)} must be absolute (on Windows a drive-letter path) with no .. component and none of <>:"|?* or a control character past the drive`);
  }
  return path;
}
