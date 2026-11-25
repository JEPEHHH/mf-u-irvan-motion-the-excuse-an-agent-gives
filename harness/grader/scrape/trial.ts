// One scrape/v1 trial (contracts/scrape.ts): an entry run once, timed by the house launcher
// (grader/scrape/launch.ts), with only the recording TLS gateway (grader/scrape/gateway.ts) to reach
// the network through. runScrapeTrial runs it and says how it ended: a run the heat lists (with the
// fault the house saw, or none, which leaves the verdict to the sealed scorer), or a void (an
// infrastructure fault: never listed, the heat re-runs it). scrapeTrialRecord turns a run and the
// scorer's verdict into the trials manifest's record.
//
// A trial, on the docker driver (grader/sandbox/network.ts has the networks and the two roles):
//   1. what a grader that died mid-trial left of this trial removed (network.ts reapTrial) under its
//      owner `scrape-<heat>.<entry>.<round>` (scrapeTrialOwner), told to onReap
//   2. the engine's isolation required (network.ts EngineIsolation.require) before anything is made,
//      so it fails closed: a refusal rejects the call with IsolationRefusal (never a void: the heat
//      stops, as the agent pipeline does), a probe that could not finish is a Docker error (void
//      sandbox), and neither makes a network or starts a program; then the trial's internal network,
//      labelled with the owner (createTrialNetwork), and the host's egress bridge (ensureEgressNetwork)
//   3. the gateway on it under one alias per listed host, then the egress bridge (scrapeAttachment):
//      its bundle's directory at /bot read-only (grader/scrape/bundle.ts scrapeGatewayBundle), /config
//      read-only holding gateway.json (scrapeGatewayConfig: the heat's leaf and resolved addresses per
//      host, the harness's routes, request caps, connection and byte caps and upstream mode, the house
//      User-Agent, listen port 443), a fresh /record writable, SERVICE_LIMITS. It is ready when it
//      writes /record/ready.json, within SCRAPE_READY_MS of its program's start
//   4. the entry on it as `agent` under the house launcher (a spec with a `launcher`: docker.ts runs
//      the launcher as PID 1, root with SETUID/SETGID/KILL): the snapshot at /bot read-only, the house
//      at /house read-only (the runtime's launcher, launch.json from launch.ts launchConfig at the
//      heat's cap_ms dropping the entry to 65534, and ca.pem, the heat CA's certificate), a fresh
//      /output writable, the competition's limits. launch.json's env also carries MAKEFUN_OUTPUT_DIR
//      naming the mount's own path (/output), since a launcher's entry gets launch.json's env alone,
//      never its container's. The launcher says `ready` within SCRAPE_READY_MS of its program's start
//   5. `go` (launch.ts LauncherSession), and the launcher's one result line within cap_ms +
//      SCRAPE_RESULT_SLACK_MS; its container then exits 0 within SCRAPE_EXIT_MS
// A program's start is its spawn on docker and the process driver, and on k8s its process's `started` (the wrapper's
// start line: k8s.ts K8sProcess, once its pod was made, its trees staged into it and it was seen Ready). The pod's start
// is the driver's to bound (its readyTimeoutMs and the staging's own budget): a pod that never runs ends its process as
// the driver's failure, the sandbox's void (or a NodeRoomError), never a `gateway` or `launcher` one. Likewise a wait for
// a program's end after its SIGTERM or its result (SCRAPE_STOP_MS, SCRAPE_EXIT_MS) bounds the program's own end (the
// process's `finished` where its driver sets one) and leaves what the driver does after it (on k8s, a writable mount's
// collect and the pod's delete) to the driver's own bounds.
//   6. /output held to program.ts's output caps while the entry runs (its walkOutputs watch every
//      OUTPUT_WATCH_MS and the sandbox's meter where it has one, read by program.ts outputReadingBroken:
//      its caps, and on k8s a directory the meter cannot read kept so past the grace) and
//      collected after with program.ts collectOutputs into the blob store. On docker a cap broken
//      mid-run removes the entry's container at once, the only way to stop the writes; its result
//      then has the host's clock from `go` to the kill as wall_ns, exit null and signal SIGKILL
//   7. SIGTERM to the gateway (`docker kill --signal TERM`), which settles what is open, writes the
//      cassette and the decoded bodies to /record and exits 0 within SCRAPE_STOP_MS. The cassette must
//      be canonical JSON and a ScrapeCassette, and every body it names present with its sha256 and
//      size; the cassette's bytes and each body go into the blob store, the cassette as stored is
//      cassette_sha256
//   8. torn down whatever happened (an abort and a throw included): the meter and the watch
//      stopped, every program still running killed, the trial network removed, the scratch deleted
//      (grade.ts removeScratch; held from its mkdtemp, grade.ts holdScratch, so that removal releases it)
// The gateway is SIGTERMed once the entry has ended, before /output is collected, so the trial's end
// in the cassette is the entry's own and not however long the collection took.
//
// The process driver (tests, a kit's local run) runs the same two programs as host processes with no
// network of their own and isolates nothing: no reap, no isolation, no network. The gateway listens
// on 127.0.0.1 at a port it picks (listen_port 0, MAKEFUN_GATEWAY_HOST), under agent.ts's service
// launcher, which turns the end of its stdin into the SIGTERM. The process sandbox runs no launcher
// spec (there is no root to drop the entry from), so the house's launch.ts runs as the program itself
// (codeDir the house, script launch.ts, launch.json with uid null): the entry gets
// MAKEFUN_OUTPUT_DIR for /output (its host directory here, the mount's own path in a container) and
// MAKEFUN_SCRAPE_GATEWAY (SCRAPE_GATEWAY_ENV), the gateway's
// 127.0.0.1:<port>, since no DNS here leads a host name to the gateway; it dials that with the host
// as SNI and authority. leftover is null there (no sandbox user to sweep): no leftover_process.
//
// One pod (the `pod` layout beside today's `split` one; ScrapeTrialOptions.hosted and .door, on a sandbox with `pods`:
// the k8s driver's one-pod view, k8s.ts K8sSandbox.onePod). The recording gateway cannot share the entry's pod (its
// way out would be the entrant's code's), so it runs as a lane child outside every sandbox (HostedServices: the lanes
// container of the grader's pod) under the process driver's contract, and the entry's pod reaches it only through the
// door (Door), which admits the pod's IP alone and joins a connection to the gateway only once its first byte comes.
//   1. before anything starts, every address the heat resolved held to what the gateway's pod had by policy: one in a
//      range makefun-sandbox-egress excepts (grader/sandbox/egress-ranges.ts SANDBOX_EGRESS_EXCEPT), or any IPv6
//      address (the policy opens none), voids the trial as a `gateway` fault naming the host, before any spawn
//   2. the entry's runtime's preflight (no node22 one for the gateway, which runs in no sandbox), the scratch's /output
//      and house; the reap by owner and the engine's isolation as above (the namespace's static policies are what hold
//      the entry's pod), and no trial network, NetworkPolicy or egress policy made
//   3. the house as on docker, then ONE pod (SandboxPods.open, label SCRAPE_POD_LABEL, the trial's owner): `entry`
//      the launcher spec (the snapshot at /bot, the house at /house, a fresh /output, the competition's limits; root
//      with the launcher's capabilities, the entry dropped to 65534; /output declares OUTPUT_RETURNS, the cap its
//      collect is held to) and the house's `watch`, which meters /output, each listed host
//      resolving to the door's address, the entry dialling the door's scrape port (SCRAPE_GATEWAY_PORT, a host's own
//      HTTPS port) before its launcher starts. Nothing more is made before the scheduler has placed it (a pod with no
//      room is a NodeRoomError, thrown as above)
//   4. the gateway by HostedServices.spawn of the same bundle: its config (gateway.json 0400, listen port 0) and a
//      fresh record directory under HostedServices.root, ready by ready.json within SCRAPE_READY_MS; any exit of it
//      before its SIGTERM, the lane host's loss included, is a `gateway` void, never the sandbox's
//   5. the pod's IP admitted at the door to that gateway alone (Door.admit, lane `scrape`), then the entry's launcher by
//      SandboxPod.spawn('entry') and steps 5 and 6 as on docker, the meter the pod's own (SandboxPod.meter). A cap
//      broken mid-run closes the pod at once (its forget and close below), the only way to stop the writes
//   6. the stop order as on docker: the meter, the entry, then SIGTERM to the gateway child (HostedProcess.terminate)
//      within SCRAPE_STOP_MS (else it is killed, a `gateway` void); once it has exited, the IP forgotten at the door
//      and the pod closed (deleted); then
//      error.json, the cassette and its bodies read from the record directory as in step 7, /output collected.
//      The pod out of memory (SandboxPod.oom: gVisor enforces only the pod's total, which is the entry's memory cap)
//      once `go` was sent is the entry's: a run, `crashed` with agent.ts TRIAL_MEMORY_DETAIL, stopped and read as
//      above, the meter's end then no fault; so too once the launcher had given its result (its clock and tails kept,
//      /output read: the pod's mount, never lost); out of memory before `go`, nothing of the entry's ran: a `launcher`
//      void as before, judged from the launcher's end alone (the meter's end then no fault either).
//      A launcher whose stdout closed after `go` with no result, or after its result with no exit status, has
//      POD_EXIT_MS for its exit, not SETTLE_EXIT_MS or SCRAPE_EXIT_MS alone: the driver decides that exit from the
//      pod's status, which may come a while after the exec's end
//   7. torn down whatever happened: the meter stopped, every program killed (the gateway child too) and gone, the IP
//      forgotten, the pod closed, the lane directory and the scratch removed
// The order on every path but a cap's break: the gateway child stopped (exited on its SIGTERM, else killed) and the IP
// forgotten at the door before the pod is closed, at step 6's stop, at a void or a throw, and at an abort (step 7). The
// door tells pods apart by their address alone, and the node hands a deleted pod's address to the next pod it makes,
// so an IP still admitted once its pod is gone would join that next pod to this trial's gateway. A cap's break forgets
// the IP before it closes the pod and stops the gateway after (step 6, its cassette still the trial's), and the IP
// admitted no more then reaches nothing. The pod found gone or failed by the driver while the trial runs (the
// launcher's driver-failure exit: deleted behind the driver's back, evicted, its node gone): the IP forgotten and the
// gateway killed at once, before anything else of the teardown, the trial the sandbox's void; a fault of its meter (the
// pod's end as the driver may see it first), and the launcher's killed exit the trial did not ask for (the pod out of
// memory, SandboxPod.oom, every member then ended K8S_KILLED; or a kill not the trial's), forget the IP at once, before
// any wait of the trial's, the gateway stopped as above (out of memory after `go` its cassette is still the trial's).
// The lanes program also forgets an address once every lane it names has exited (server/sandbox-host/lanes.ts).
// The scrape lane holds no secret a peer must present: the entry dials a listed host's name on 443 and the gateway
// terminates TLS for it. So the door's admission by address is all that stands between the trial's gateway and any
// other pod, and two pods that hold one address while both live cannot be told apart there: a pod sharing a live
// scrape trial's address could add requests and connections to that trial's cassette for as long as both live. A
// node's network layer handing one address to two live pods is the platform's fault, which nothing here detects.
// The process cap. The entry member's pids are the competition's (ScrapeTrialOptions.limits.pids, as on its own pod),
// and the driver caps the launcher's exec at pids + k8s.ts POD_OWN_TASKS (K8sPod.spawn). The launcher is root in a
// gVisor sandbox, which counts a uid's tasks across the whole sandbox (gVisor kernel.go incRLimitNProc, threads
// included; probe d), so that cap must hold the launcher's root tasks; the pod's `watch`, which meters /output, is
// uid 10001, counted apart (probe d2). The launcher's, at most: PID 1, the exec's wrapper, the launcher (node22's node at 11 threads:
// 7 at start and 11 once libuv's pool of 4 has run, measured on node 22.23.2 linux-x64; launch.py at 4), the entry's
// first process (forked as root, and gVisor leaves a task counted on the uid it was created under after its setuid),
// and a signal's exec: 15 for node22, 8 for python3.13. So 22 at most, against 66 at the scrape contests' pids of 64
// (competitions/roblox-top-chart-02 and roblox-top100-scrape-01). The entry, 65534, is counted apart, as on its own
// pod. What shares the entry's sandbox here: only the house's `watch` (10001, no capability), reading /output.
//
// The CPU reservation (ScrapeTrialOptions.reserveCpu, default off). A trial's pods request min(limit, 250m) of CPU
// (k8s.ts CPU_REQUEST_MAX_MILLI), so beside other grading on the node its wall time is measured on a quarter share; a
// lease that keeps other grading off the host is what has kept it quiet. With reserveCpu, the trial's sandbox programs
// ask for their whole CPU limit, as a timed pod does (types.ts SandboxSpec.reserveCpu): the entry (its own pod, or the
// `entry` member of the one pod: the meter keeps today's request) and, on the split layout, the gateway's pod. The
// one-pod layout's gateway is a lane child in no pod: nothing of it changes. Docker and the process driver have no
// requests, so it changes nothing there. Off, every spec is what it always was, byte for byte.
//
// The node22 house's launch.ts is the caller's text (ScrapeTrialOptions.launcherSource), never read
// here through launch.ts's own import.meta.url (launch.ts launcherSource): inside the kit's one-file
// command line every module's import.meta is the bundle's (tests/unit/kit-cli-launcher.test.ts), so the
// kit hands in the copy it carries. For the same reason nothing here imports gateway-main.ts, which
// starts itself when it is the file node runs: its file names are GATEWAY_FILES (a test holds them
// equal).
//
// How a trial ends (in this order; the first that holds decides):
//   void upstream_error  the cassette holds an upstream_error other than `unfinished` (the upstream's
//                        own 429 or 5xx, one it could not reach, a reset, a header it would not
//                        forward): the measurement is spoiled whatever the entry did. An `unfinished`
//                        one (the trial stopped before the upstream answered: the entry left, or ran
//                        out its cap, without its answer) is the entry's doing and voids nothing, so an
//                        entry cannot void its own slow trial by leaving a request open
//   void gateway         the gateway exited before it was ready or while the trial ran, was not ready
//                        in time, did not exit 0 on its SIGTERM, wrote error.json, or wrote no cassette,
//                        one that is not canonical or not a ScrapeCassette, or a body missing or wrong
//   void launcher        the launcher refused ({"error"}), printed a line that is not its protocol,
//                        closed its stdout first, gave no ready or no result in time, or its container
//                        did not exit 0 after its result (but for the split k8s layout's pod ending it
//                        once `go` was sent, before its result or after, or on one pod the pod out of
//                        memory: crashed, below)
//   void sandbox         a Docker error: a SandboxError anywhere (preflight, a network, a spawn, the
//                        meter), or the driver's own failure exit (docker run's 125). Not a NodeRoomError
//                        (k8s: the node had no room for one of the trial's pods, so it never ran): that is
//                        thrown, its heat's job handed back for later (server/jobs.ts `node room`)
//   off_route            a request the gateway refused as off the routes (refused_route), or a
//                        connection it refused before TLS as no listed host's (not_tls,
//                        bad_client_hello, no_sni, unknown_sni)
//   over_cap             a request refused at a cap (refused_cap), or a connection refused or destroyed
//                        by one (max_connections, max_bytes_up, max_bytes_down, max_entries)
//   invalid_output       /output broke program.ts's output caps, while the entry ran or after
//   timeout              the launcher SIGKILLed it at cap_ms
//   crashed              a non-zero exit, or a signal that was not the cap's (on one pod, the pod out of
//                        memory once `go` was sent: TRIAL_MEMORY_DETAIL). On the split k8s layout, the
//                        entry's pod ending its process K8S_KILLED once the launcher had given its result
//                        (killedByItsPod): exit null and SIGKILL, the launcher's clock and tails kept,
//                        nothing of /output read, worded by its cause (SCRAPE_POD_KILL_DETAIL): out of
//                        memory as /output was collected, the memory-backed files the entry left, /tmp
//                        and /dev/shm, charged to the pod (SCRAPE_COLLECT_MEMORY_DETAIL); evicted for an
//                        /output past its size limit (SCRAPE_VOLUME_EVICTED_DETAIL); or its container's
//                        first process killed by the entry (SCRAPE_PID1_KILLED_DETAIL). The same pod's
//                        end once `go` was sent but before the launcher's result (its stdout cut, its
//                        exit read on the driver's bounds once its program's end came within
//                        SETTLE_EXIT_MS) is crashed the same way, with the host's clock from `go` to the
//                        launcher's stdout end and no tails, worded by SCRAPE_POD_KILL_RUN_DETAIL (out of
//                        memory as it ran: SCRAPE_RUN_MEMORY_DETAIL). Never a void: else an entry could
//                        void any run it dislikes by leaving memory-backed files behind, overfilling
//                        /output or killing PID 1, before its result or after
//   leftover_process     it exited 0 within the cap but left processes of the sandbox user behind
//                        (the launcher killed and counted them)
//   no fault             it exited 0 within the cap breaking nothing: the scorer decides correct or
//                        incorrect (scrapeTrialRecord takes its verdict)
// The house's own observations rank first: a request off the routes or over a cap is the entry's rule
// break whatever followed (the 403 or 429 it got often makes it crash or time out). Leftovers rank
// last: an entry killed at the cap or crashed leaves its children behind by being killed, while an
// entry that exits 0 and leaves a daemon is what leftover_process is for.
//
// Abort (opts.signal): every program of the trial is killed at once, the trial torn down, and
// runScrapeTrial rejects with the signal's reason.
//
// Entry secrets (ScrapeTrialOptions.secrets: the entrant's env-lane ones, contracts/entry-secrets.ts,
// grader/worker.ts opens them; the heat hands each entry its own, the house's reference read none):
//   in        variables of the entry's own process, nobody else's: their NAMEs in launch.json
//             (launch.ts launchConfig's secret_names), their values on the launcher's stdin before
//             `ready` (LauncherSession), so no value is in any file of the house, the gateway's config
//             or a sandbox spec, on any driver. They are checked as a sandbox's are
//             (sandbox/types.ts checkSandboxSecrets: names the contract takes and the env lane's alone)
//   masked    every form of every value (grader/run.ts entrySecretForms; secret-mask.ts SECRET_MARK,
//             the same mark in every round) out of the record the gateway wrote, before any of it is
//             stored (gateway.ts maskScrapeRecording: the cassette, the scrape answer key, and its
//             bodies), out of both launcher tails (maskLaunchTail: a tail cut at its start keeps no end
//             of a value the cut split), and out of a void's message and a fault's detail (run.ts
//             redactSecrets, REDACTED_MARK)
//   scanned   /output is scored byte for byte, so it is scanned, never masked: every file the trial
//             stores, as it is stored, and every path, for the forms of each value by NAME (agent.ts
//             secretScanIndex). Where one turns up, the outcome's secret_hits names the secret and the
//             file (`output/<path>`, its path masked), never the value; grader/worker.ts flags the run
//             secret_in_output. A void that collected /output first (upstream_error) says so too

import { randomBytes, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { z } from 'zod';
import { TRIAL_OUTPUTS_FORMAT, type TrialOutputsT } from '../../contracts/agent.ts';
import type { ScrapeHarnessT } from '../../contracts/competition.ts';
import {
  SCRAPE_HEAT_STAGES,
  ScrapeCassette,
  ScrapeEntryId,
  ScrapeHeatConfig,
  ScrapeHeatId,
  ScrapeNetwork,
  ScrapeResolution,
  ScrapeTrialRecord,
  type ScrapeCassetteT,
  type ScrapeNetworkT,
  type ScrapeTrialRecordT,
  type ScrapeTrialStatusT,
} from '../../contracts/scrape.ts';
import { compareCodeUnits, isCanonicalJson, sha256Hex } from '../../sim/canonical.ts';
import { GATEWAY_CONFIG_DIR_MODE, GATEWAY_CONFIG_FILE_MODES, LAUNCHER_SCRIPT, PRIVATE_DIR_MODE, launcherSource as serviceLauncherSource, secretScanIndex, TRIAL_MEMORY_DETAIL, type SecretOutputHit } from '../agent.ts';
import { findForms, FormSet, maskBytes, maskText, SECRET_MARK, TextMasker, type FormIndex } from '../gateway/secret-mask.ts';
import { holdScratch, removeScratch } from '../grade.ts';
import {
  collectOutputs,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_DEPTH,
  MAX_OUTPUT_FILES,
  MAX_OUTPUT_PATH_BYTES,
  OUTPUT_RETURNS,
  OUTPUT_WATCH_MS,
  outputReadingBroken,
  sealStaged,
  walkOutputs,
  type OutputBlobs,
} from '../program.ts';
import { driverFailure, entrySecretForms, redactSecrets } from '../run.ts';
import { DockerSandbox } from '../sandbox/docker.ts';
import { describeExit } from '../sandbox/io.ts';
import { sandboxEgressRefusal } from '../sandbox/egress-ranges.ts';
import { K8S_KILLED, k8sTerminate, KUBECTL_TIMEOUT_MS, NodeRoomError, type PodKill } from '../sandbox/k8s.ts';
import { UnreadGrace } from '../sandbox/k8s-watch.ts';
import { RECORD_RETURNS } from '../sandbox/mounts.ts';
import {
  dockerExec,
  isolationCheck,
  SCRAPE_GATEWAY_PORT,
  scrapeAttachment,
  SERVICE_LIMITS,
  trialNetworkName,
  trialNetworksOf,
  TRIAL_OWNER_RE,
  type DockerExec,
  type IsolationCheck,
  type NetworkOptions,
  type ReapResult,
} from '../sandbox/network.ts';
import {
  checkSandboxSecrets,
  containerized,
  MOUNT_POINTS,
  SandboxError,
  type Door,
  type HostedProcess,
  type HostedServices,
  type PodMemberSpec,
  type Runtime,
  type Sandbox,
  type SandboxExit,
  type SandboxLimits,
  type SandboxPod,
  type SandboxPods,
  type SandboxProcess,
  type SandboxSpec,
  type TreeMeter,
  type TreeMeterOptions,
  type TrialNetworks,
} from '../sandbox/types.ts';
import { cassetteJson, maskScrapeRecording, parseScrapeGatewayConfig, SCRAPE_GATEWAY_CONFIG_FORMAT, type ScrapeCassette as GatewayCassette, type ScrapeGatewayConfig, type ScrapeRecordingMask } from './gateway.ts';
import { CA_FILE, LAUNCH_CONFIG, launchConfig, LAUNCHER_FILES, LauncherError, LauncherSession, PYTHON_LAUNCHER_SOURCE, SANDBOX_UID, writeHouse, type LaunchConfig, type LaunchResult } from './launch.ts';

// ---------------------------------------------------------------- constants

/** The containers' name stems (docker.ts containerName: makefun-<label>-<hex>). */
export const SCRAPE_TRIAL_LABELS = Object.freeze({ gateway: 'scrape-gateway', entry: 'scrape-entry' } as const);
/** A trial owner's stem: `scrape-<heat>.<entry>.<round>` (scrapeTrialOwner). */
export const SCRAPE_OWNER_PREFIX = 'scrape-';
/** How long the gateway has to write its ready file, and the launcher to say `ready`, from its program's start (the header). */
export const SCRAPE_READY_MS = 30_000;
/** How long past cap_ms the launcher has for its result: its sweep, its pipes' close grace (launch.ts CLOSE_GRACE_MS), the line. */
export const SCRAPE_RESULT_SLACK_MS = 15_000;
/** How long the gateway has to exit after its SIGTERM (it writes the cassette and the bodies): to its program's end (the header). */
export const SCRAPE_STOP_MS = 30_000;
/** How long the launcher's container has to exit after its result: to its program's end (the header). */
export const SCRAPE_EXIT_MS = 10_000;
/** The port the gateway listens on in its container (the real hosts' HTTPS port; network.ts holds it, the k8s driver's entry dials it), and the port it dials upstream. */
export { SCRAPE_GATEWAY_PORT };
export const SCRAPE_UPSTREAM_PORT = 443;
/** The process driver's entry variable naming the gateway's 127.0.0.1:<port> (the header's process driver). */
export const SCRAPE_GATEWAY_ENV = 'MAKEFUN_SCRAPE_GATEWAY';
/** The house User-Agent every upstream request carries in place of the entry's (Roblox's Terms ask API users not to mask who they are). */
export const SCRAPE_USER_AGENT = 'makefun-scrape-gateway/1 (the make.fun scrape contest; +https://make.fun)';
/**
 * grader/scrape/gateway-main.ts's file names: CONFIG_FILE, READY_FILE, CASSETTE_FILE, BODIES_DIR and
 * ERROR_FILE there (a test holds them equal). Not imported: gateway-main.ts starts itself when it is
 * the file node runs, which inside the kit's one-file command line every module is.
 */
export const GATEWAY_FILES = Object.freeze({ config: 'gateway.json', ready: 'ready.json', cassette: 'cassette.json', bodies: 'bodies', error: 'error.json' } as const);
/** The one-pod layout's pod name stem (k8s.ts podPlanSpec: makefun-sbx-<label>-<8 hex>): its `entry` and its `watch`. */
export const SCRAPE_POD_LABEL = 'scrape-trial';
/** The largest cassette read back (MAX_ENTRIES entries are far below it). */
export const MAX_CASSETTE_BYTES = 64 * 1024 * 1024;
/**
 * How long a launcher that closed its stdout has to end (its program's end: programExitWithin), so a driver failure (125)
 * or its pod's kill (killedByItsPod) is told from the launcher's own.
 */
const SETTLE_EXIT_MS = 2_000;
/**
 * One pod: how long the entry's exit has once the launcher's stdout closed after `go` with no result. Its exit says
 * whether the pod ran out of memory, and the driver decides it from the pod's status (k8s.ts K8sPodProcess: an exec
 * ended with no sentinel re-reads the pod for up to KUBECTL_TIMEOUT_MS, the read in flight then bounded by the same),
 * so the wait is those two, plus SETTLE_EXIT_MS for the exit to land as on the split layout.
 */
const POD_EXIT_MS = 2 * KUBECTL_TIMEOUT_MS + SETTLE_EXIT_MS;
const POLL_MS = 50;
/** A program's stdout and stderr kept for a fault's message: the last this many bytes. */
const LOG_BYTES = 16 * 1024;

/** The faults the house sees, in the order they rank (the header's How a trial ends). */
export const SCRAPE_FAULT_ORDER = Object.freeze(['off_route', 'over_cap', 'invalid_output', 'timeout', 'crashed', 'leftover_process'] as const);
export type ScrapeFaultStatus = (typeof SCRAPE_FAULT_ORDER)[number];
/** Why a trial is void (the header). */
export const SCRAPE_VOID_REASONS = Object.freeze(['upstream_error', 'gateway', 'launcher', 'sandbox'] as const);
export type ScrapeVoidReason = (typeof SCRAPE_VOID_REASONS)[number];

/** Connections the gateway refused before TLS as no listed host's: off the routes. */
const ROUTE_CONNECTION_REFUSALS: ReadonlySet<string> = new Set(['not_tls', 'bad_client_hello', 'no_sni', 'unknown_sni']);
/** Connections refused or destroyed by a trial cap. */
const CAP_CONNECTION_REFUSALS: ReadonlySet<string> = new Set(['max_connections', 'max_bytes_up', 'max_bytes_down', 'max_entries']);

const EMPTY_OUTPUTS: TrialOutputsT = Object.freeze({ format: TRIAL_OUTPUTS_FORMAT, files: [] }) as TrialOutputsT;

// ---------------------------------------------------------------- types

type ScrapeHeatStageT = (typeof SCRAPE_HEAT_STAGES)[number];
type ScrapeResolutionT = z.infer<typeof ScrapeResolution>;

/** Which trial of the heat this is. */
export interface ScrapeTrialRef {
  /** The heat (contracts/scrape.ts ScrapeHeatId) and the entry (its submission id, ScrapeEntryId). */
  heat: string;
  entry: string;
  /** A warm-up trial runs like any other and is never listed. */
  stage: ScrapeHeatStageT;
  /** 0-based within its stage. */
  round: number;
  /** The entry's 0-based place in the round's order. */
  position: number;
}

/** What the heat holds for every trial (one CA and one host resolution per heat). */
export interface ScrapeTrialHeat {
  /** The heat CA's certificate, PEM (ca.ts HeatCa.cert): the house's ca.pem, what the entry trusts. Never its key. */
  caCert: string;
  /** One leaf per listed host (ca.ts hostLeaves): what the gateway answers that host's ClientHello with. */
  leaves: Readonly<Record<string, { readonly cert: string; readonly key: string }>>;
  /** Each listed host's addresses as the heat resolved them (ScrapeResolution), in order: the gateway dials only a host's last. */
  upstream: readonly ScrapeResolutionT[];
}

/** Where the trial's records go (server/blobstore.ts BlobStore fits). */
export type ScrapeTrialBlobs = Pick<OutputBlobs, 'put'>;

export interface ScrapeTrialOptions {
  sandbox: Sandbox;
  trial: ScrapeTrialRef;
  /** The snapshot mounted read-only at /bot, its runtime, and the image digest to run it in (default the pinned one). */
  entry: { dir: string; runtime: Runtime; imageDigest?: string | null };
  /** The bundle's harness: what the gateway lets through (network) and the per-trial cap (heat.cap_ms). */
  harness: Pick<ScrapeHarnessT, 'network' | 'heat'>;
  /** The competition's limits for the entry. */
  limits: SandboxLimits;
  heat: ScrapeTrialHeat;
  /** The gateway's bundle (grader/scrape/bundle.ts scrapeGatewayBundle): its directory and script. */
  gateway: { dir: string; script: string };
  /** The node22 house's launch.ts, as text (the header): launch.ts launcherSource() in the grader's tree, the kit's own copy in the kit. A python3.13 house takes launch.ts PYTHON_LAUNCHER_SOURCE. */
  launcherSource: string;
  /** A directory the trial may use: its scratch is made in it and deleted before runScrapeTrial settles. */
  workDir: string;
  blobs: ScrapeTrialBlobs;
  /** The docker CLI for the networks and the gateway's SIGTERM (default: the docker sandbox's own CLI). */
  docker?: NetworkOptions;
  /** Docker: the engine's isolation check (default the sandbox's own, isolationCheck of its Sandbox.networks: on a DockerSandbox this process's EngineIsolation of its engine; required for a sandbox with none). */
  isolation?: IsolationCheck;
  /** Told what the reap took (and could not), each time it ran. */
  onReap?: (reaped: ReapResult) => void;
  /** Aborting it kills every program of the trial, and runScrapeTrial rejects with its reason. */
  signal?: AbortSignal;
  /** The port the gateway dials upstream and the CA bundle it trusts there (default SCRAPE_UPSTREAM_PORT and Node's roots; a test's own). */
  upstreamPort?: number;
  upstreamCa?: string | null;
  /** The house User-Agent (default SCRAPE_USER_AGENT); it must name make.fun. */
  userAgent?: string;
  /** The process driver: the entry's interpreter (default this node). */
  interpreter?: string;
  /** Tests: the waits (defaults SCRAPE_READY_MS, SCRAPE_RESULT_SLACK_MS, SCRAPE_STOP_MS, SCRAPE_EXIT_MS, and one pod's POD_EXIT_MS). */
  timing?: { readyMs?: number; resultSlackMs?: number; stopMs?: number; exitMs?: number; podExitMs?: number };
  /**
   * The entry's env-lane entry secrets, NAME to value (the header's entry secrets): its own process's variables, masked
   * out of what the trial stores and says, its /output scanned for them. Absent or empty: none, and the trial is what it
   * always was.
   */
  secrets?: Readonly<Record<string, string>>;
  /**
   * The one-pod layout (the header's One pod): where the recording gateway runs, a lane child outside every sandbox
   * (the lanes client's HostedServices), and the door the entry's pod reaches it through (its Door). Both or neither;
   * with both and a sandbox that has `pods`, the trial is one pod of `entry` and `watch`. Absent, or on a sandbox with
   * no `pods`: the trial is what it always was.
   */
  hosted?: HostedServices;
  door?: Door;
  /**
   * The CPU reservation (the header's): the entry's and the split layout's gateway's specs carry reserveCpu, so the k8s
   * driver requests their whole CPU limit. Default false: every spec as it always was.
   */
  reserveCpu?: boolean;
}

/** What the trial stored, by sha256. */
export interface ScrapeTrialBlobRefs {
  /** The cassette's bytes as the gateway wrote them: cassette_sha256. */
  cassette: string;
  /** Each decoded body the cassette names, sorted. */
  bodies: string[];
  /** Each output file (the outputs manifest's), sorted, once each. */
  outputs: string[];
  /** The launcher's tails of the entry's stdout and stderr; null when the launcher gave no result (killed for its output, or its pod's kill). */
  stdout_tail: string | null;
  stderr_tail: string | null;
}

/** A trial the heat lists: how it ran, and the fault the house saw (or none: the scorer decides). */
export interface ScrapeTrialRun {
  kind: 'run';
  trial: ScrapeTrialRef;
  owner: string;
  /** The house's verdict (the header), or null: it exited 0 within the cap breaking nothing, and the scorer says correct or incorrect. */
  fault: ScrapeFaultStatus | null;
  /** Why, with a fault. */
  detail: string | null;
  /** The launcher's clock from spawn to exit, ns (the host's from `go` to the kill when the launcher gave no result). */
  wall_ns: number;
  exit: number | null;
  signal: string | null;
  timed_out: boolean;
  /** Processes of the sandbox user it left, all killed; null without one (the process driver) or when it was killed for its output. */
  leftover: number | null;
  /** /output as program outputs (empty when it broke the caps, or its pod's kill lost it: killedByItsPod). */
  outputs: TrialOutputsT;
  /** The trial's cassette, as the scorer reads it, and the sha256 of its stored bytes. */
  cassette: ScrapeCassetteT;
  cassette_sha256: string;
  blobs: ScrapeTrialBlobRefs;
  /**
   * With entry secrets (ScrapeTrialOptions.secrets), where its /output held a form of one (the header's entry secrets):
   * the secret's NAME and `output/<path>` (the path masked), in file order then name order, [] when nowhere. Absent
   * without secrets.
   */
  secret_hits?: SecretOutputHit[];
}

/** A trial that does not count: an infrastructure fault (the header). */
export interface ScrapeTrialVoid {
  kind: 'void';
  trial: ScrapeTrialRef;
  owner: string;
  reason: ScrapeVoidReason;
  message: string;
  /** The cassette, when the gateway wrote one (an upstream_error void's holds the upstream's rate-limit headers, which the heat paces by); else null. */
  cassette: ScrapeCassetteT | null;
  cassette_sha256: string | null;
  /** With entry secrets, as a run's (ScrapeTrialRun.secret_hits): what the /output it collected before it was void held ([] when it collected none). */
  secret_hits?: SecretOutputHit[];
}

export type ScrapeTrialOutcome = ScrapeTrialRun | ScrapeTrialVoid;

/** An infrastructure fault met on the way: the trial is void. */
class ScrapeVoid extends Error {
  readonly reason: ScrapeVoidReason;

  constructor(reason: ScrapeVoidReason, message: string) {
    super(message);
    this.name = 'ScrapeVoid';
    this.reason = reason;
  }
}

/** The entry's container was removed for its output: what its launcher's broken protocol then means. */
class KilledForOutput extends Error {}
/** The go step's launcher failure on one pod once the pod ran out of memory (the header's One pod, step 6): the entry's. */
class OutOfMemory extends Error {}
/**
 * The go step's launcher failure on the split layout once the entry's own pod ended its process before the launcher gave
 * its result (killedByItsPod: out of memory, evicted for /output, its container's first process killed): the entry's.
 */
class KilledByItsPod extends Error {
  readonly kill: PodKill;
  constructor(kill: PodKill) {
    super(`the entry's pod ended it before its result (${kill})`);
    this.kill = kill;
  }
}

/** Why waiting stopped: the trial was aborted. */
class TrialAborted extends Error {
  constructor() {
    super('the scrape trial was aborted');
    this.name = 'AbortError';
  }
}

// ---------------------------------------------------------------- pure parts

/**
 * The trial's owner `scrape-<heat>.<entry>.<round>` (network.ts TRIAL_OWNER_RE), its parts checked. The heat
 * records it as it is; it runs past a Kubernetes label value's 63 characters (a practice heat's reference read,
 * `scrape-practice-<31 hex>.house-reference.0`, is 65), so the k8s driver labels its objects by k8s.ts ownerLabel
 * of it (a hash of one that long) and keeps it whole in their makefun.io/trial-owner annotation.
 */
export function scrapeTrialOwner(t: Pick<ScrapeTrialRef, 'heat' | 'entry' | 'round'>): string {
  if (!ScrapeHeatId.safeParse(t.heat).success) throw new TypeError(`heat ${JSON.stringify(t.heat)} is not a heat id (1..40 of a-z 0-9 -)`);
  if (!ScrapeEntryId.safeParse(t.entry).success) throw new TypeError(`entry ${JSON.stringify(t.entry)} is not an entry id (1..40 of a-z 0-9 -)`);
  if (!Number.isSafeInteger(t.round) || t.round < 0) throw new TypeError(`round ${String(t.round)} is not a 0-based integer`);
  const owner = `${SCRAPE_OWNER_PREFIX}${t.heat}.${t.entry}.${t.round}`;
  if (!TRIAL_OWNER_RE.test(owner)) throw new TypeError(`trial owner ${JSON.stringify(owner)} is not a trial owner (network.ts TRIAL_OWNER_RE)`);
  return owner;
}

/**
 * The gateway's /config/gateway.json for a trial (gateway.ts ScrapeGatewayConfig, checked by its
 * parseScrapeGatewayConfig, which throws ScrapeGatewayConfigError): each listed host's leaf and its
 * last resolved addresses, the harness's routes, caps and upstream mode, the house User-Agent, and
 * listen port 443 in a container or 0 (any) on the host.
 */
export function scrapeGatewayConfig(
  o: { network: ScrapeNetworkT; heat: Pick<ScrapeTrialHeat, 'leaves' | 'upstream'>; kind: Sandbox['kind']; upstreamPort?: number; upstreamCa?: string | null; userAgent?: string },
  now: number = Date.now(),
): ScrapeGatewayConfig {
  const resolved = new Map<string, string[]>();
  for (const r of o.heat.upstream) resolved.set(r.host, [...r.ips]);
  const hosts: ScrapeGatewayConfig['hosts'] = {};
  for (const host of o.network.hosts) {
    const leaf = Object.hasOwn(o.heat.leaves, host) ? o.heat.leaves[host] : undefined;
    if (leaf === undefined) throw new TypeError(`the heat has no leaf for ${host}`);
    const ips = resolved.get(host);
    if (ips === undefined) throw new TypeError(`the heat resolved no address for ${host}`);
    hosts[host] = { ips, cert: leaf.cert, key: leaf.key };
  }
  return parseScrapeGatewayConfig(
    {
      format: SCRAPE_GATEWAY_CONFIG_FORMAT,
      hosts,
      routes: o.network.routes.map((r) => ({ id: r.id, host: r.host, method: r.method, path: r.path, query: { ...r.query } })),
      request_caps: { ...o.network.request_caps },
      max_connections: o.network.max_connections,
      max_concurrent: o.network.max_concurrent,
      max_bytes_down: o.network.max_bytes_down,
      max_bytes_up: o.network.max_bytes_up,
      upstream: o.network.upstream,
      upstream_port: o.upstreamPort ?? SCRAPE_UPSTREAM_PORT,
      upstream_ca: o.upstreamCa ?? null,
      user_agent: o.userAgent ?? SCRAPE_USER_AGENT,
      listen_port: containerized(o.kind) ? SCRAPE_GATEWAY_PORT : 0,
    },
    now,
  );
}

/** The upstream error that voids a trial (the header), as a line; null when none does. */
export function scrapeUpstreamVoid(cassette: Pick<ScrapeCassetteT, 'entries'>): string | null {
  const e = cassette.entries.find((x) => x.outcome === 'upstream_error' && x.reason !== 'unfinished');
  if (e === undefined) return null;
  return `request ${e.seq} (route ${e.route ?? 'none'}) met an upstream error: ${e.reason ?? 'no reason'}${e.status === null ? '' : `, status ${e.status}`}`;
}

/** What the launcher said of the entry's run. */
export interface ScrapeLaunchFacts {
  exit: number | null;
  signal: string | null;
  timed_out: boolean;
  leftover: number | null;
}

/** The fault the house saw (the header's order, after the voids), or null: the scorer decides. */
export function scrapeTrialFault(o: { launch: ScrapeLaunchFacts; violation: string | null; cassette: Pick<ScrapeCassetteT, 'entries' | 'connections'> }): { status: ScrapeFaultStatus; detail: string } | null {
  const request = (e: ScrapeCassetteT['entries'][number]): string => `request ${e.seq} (${e.method} ${e.authority ?? '(no authority)'}${e.path ?? ''})`;
  const connection = (c: ScrapeCassetteT['connections'][number]): string => `connection ${c.id} (SNI ${c.sni ?? 'none'})`;
  const route = o.cassette.entries.find((e) => e.outcome === 'refused_route');
  if (route !== undefined) return { status: 'off_route', detail: `${request(route)} is off the routes: ${route.reason ?? 'refused'}` };
  const unknown = o.cassette.connections.find((c) => c.refused !== null && ROUTE_CONNECTION_REFUSALS.has(c.refused));
  if (unknown !== undefined) return { status: 'off_route', detail: `${connection(unknown)} was refused as no listed host's: ${unknown.refused}` };
  const capped = o.cassette.entries.find((e) => e.outcome === 'refused_cap');
  if (capped !== undefined) return { status: 'over_cap', detail: `${request(capped)} was over a cap: ${capped.reason ?? 'refused'}` };
  const over = o.cassette.connections.find((c) => c.refused !== null && CAP_CONNECTION_REFUSALS.has(c.refused));
  if (over !== undefined) return { status: 'over_cap', detail: `${connection(over)} was refused at a cap: ${over.refused}` };
  if (o.violation !== null) return { status: 'invalid_output', detail: `output violation: ${o.violation}` };
  const l = o.launch;
  if (l.timed_out) return { status: 'timeout', detail: 'the launcher killed it at the cap' };
  if (l.exit !== 0) return { status: 'crashed', detail: l.exit === null ? `a signal ended it (${l.signal ?? 'none named'})` : `it exited with code ${l.exit}` };
  if (l.leftover !== null && l.leftover > 0) return { status: 'leftover_process', detail: `it left ${l.leftover} process${l.leftover === 1 ? '' : 'es'} behind (killed)` };
  return null;
}

const POD_KILLS: ReadonlySet<unknown> = new Set<PodKill>(['memory', 'volume', 'pid1']);

/**
 * How the entry's pod ended it on the split layout, when `exit` is that kill and not the program's own status, else
 * null: K8S_KILLED from a process whose pod ended it, its writable mounts' host directories then emptied, by the cause
 * the driver read (k8s.ts K8sProcess.podKill; its podKilled is only whether there was one). `memory`: out of memory,
 * as a pod that a program left a hair under its memory total with memory-backed files (/tmp, /dev/shm) is when /output
 * is collected after the program has ended. `volume`: evicted for its own writable volume, /output past its sizeLimit.
 * `pid1`: the entry killed its container's first process (`kill -KILL 1`), which ended the container. Each is worded by
 * its own detail (SCRAPE_POD_KILL_DETAIL): only `memory` says the memory ran out. Read structurally: only a K8sProcess
 * carries podKill, so on docker, the process driver and one pod (K8sPodProcess) it is always null.
 */
export function killedByItsPod(proc: SandboxProcess, exit: SandboxExit): PodKill | null {
  if (exit.code !== K8S_KILLED || exit.signal !== null || exit.error !== undefined || !('podKill' in proc)) return null;
  return POD_KILLS.has(proc.podKill) ? (proc.podKill as PodKill) : null;
}

/** What a run whose pod ran out of memory once the launcher had given its result says (runEntry; killedByItsPod `memory`). */
export const SCRAPE_COLLECT_MEMORY_DETAIL = `${TRIAL_MEMORY_DETAIL} once it had exited, as its /output was collected (what it leaves in memory-backed files, /tmp and /dev/shm, counts against its memory): nothing of its /output was kept`;

/** What a run whose pod was evicted for its /output past its size limit says (runEntry; killedByItsPod `volume`). */
export const SCRAPE_VOLUME_EVICTED_DETAIL = 'its /output passed its size limit, so its pod was evicted: nothing of its /output was kept';

/** What a run that killed its container's first process says (runEntry; killedByItsPod `pid1`). */
export const SCRAPE_PID1_KILLED_DETAIL = "it killed its container's first process, which ended its container: nothing of its /output was kept";

/** A crashed run's detail by how its pod ended it once the launcher had given its result (killedByItsPod). */
export const SCRAPE_POD_KILL_DETAIL: Readonly<Record<PodKill, string>> = {
  memory: SCRAPE_COLLECT_MEMORY_DETAIL,
  volume: SCRAPE_VOLUME_EVICTED_DETAIL,
  pid1: SCRAPE_PID1_KILLED_DETAIL,
};

/** What a run whose pod ran out of memory before the launcher had given its result says (runEntry; killedByItsPod `memory`). */
export const SCRAPE_RUN_MEMORY_DETAIL = `${TRIAL_MEMORY_DETAIL} as it ran, before its launcher gave its result: nothing of its /output was kept`;

/**
 * A crashed run's detail by how its pod ended it before the launcher had given its result (killedByItsPod): the
 * eviction's and the PID-1 kill's as after it; out of memory said as it ran, never as /output was collected.
 */
export const SCRAPE_POD_KILL_RUN_DETAIL: Readonly<Record<PodKill, string>> = {
  memory: SCRAPE_RUN_MEMORY_DETAIL,
  volume: SCRAPE_VOLUME_EVICTED_DETAIL,
  pid1: SCRAPE_PID1_KILLED_DETAIL,
};

/**
 * The trials manifest's record of a listed run (contracts/scrape.ts ScrapeTrialRecord): the fault as
 * its status, else the scorer's verdict (correct or incorrect); scores_sha256 the scorer's
 * scores.json, or null when it did not run on the trial. A warm-up trial is never listed (TypeError),
 * and a run with no fault needs the verdict.
 */
export function scrapeTrialRecord(run: ScrapeTrialRun, verdict: { correct: boolean; scores_sha256: string } | null): ScrapeTrialRecordT {
  const stage = run.trial.stage;
  if (stage !== 'main' && stage !== 'playoff') throw new TypeError(`a ${stage} trial is never listed`);
  if (run.fault === null && verdict === null) throw new TypeError("a trial with no fault takes the scorer's verdict: correct or incorrect");
  const status: ScrapeTrialStatusT = run.fault ?? (verdict!.correct ? 'correct' : 'incorrect');
  return ScrapeTrialRecord.parse({
    round: run.trial.round,
    stage,
    position: run.trial.position,
    status,
    wall_ns: run.wall_ns,
    exit: run.exit,
    outputs: run.outputs,
    cassette_sha256: run.cassette_sha256,
    scores_sha256: verdict?.scores_sha256 ?? null,
  });
}

// ---------------------------------------------------------------- the trial's programs

/** A program of the trial: its process, its exit once it has one, and the tail of what it printed on `streams`. */
class Program {
  readonly proc: SandboxProcess;
  readonly exited: Promise<SandboxExit>;
  exit: SandboxExit | null = null;
  #log: Buffer = Buffer.alloc(0);

  constructor(proc: SandboxProcess, streams: readonly Readable[]) {
    this.proc = proc;
    for (const s of streams) {
      s.on('data', (b: Buffer | string) => this.#keep(typeof b === 'string' ? Buffer.from(b) : b));
      s.on('error', () => undefined);
    }
    proc.stdin.on('error', () => undefined);
    this.exited = proc.exited.then((e) => {
      this.exit = e;
      return e;
    });
  }

  #keep(b: Buffer): void {
    const all = Buffer.concat([this.#log, b]);
    this.#log = all.length > LOG_BYTES ? Buffer.from(all.subarray(all.length - LOG_BYTES)) : all;
  }

  /** The last of what it printed, for a fault's message ('' when nothing). */
  logTail(): string {
    const text = this.#log.toString('utf8').trim();
    return text.length <= 500 ? text : `…${text.slice(-500)}`;
  }
}

function abortReasonOf(signal: AbortSignal): unknown {
  return signal.reason ?? new TrialAborted();
}

/** `p`'s value, or null when `ms` passes first. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A program's start, as a wait that counts from it reads it: `since` (performance.now()) is now for a process with no
 * `started` (docker, the process driver: it runs from spawn), else null until its `started` resolves (k8s: the
 * wrapper's start line, once its pod was made, staged and seen Ready and its exec opened, all of which the driver bounds
 * itself, ending the process as its failure when the program never runs). `begun` settles then; it is undefined for a
 * process with no `started`, whose program started already.
 */
function startClock(proc: SandboxProcess): { readonly since: number | null; readonly begun: Promise<void> | undefined } {
  const clock: { since: number | null; begun: Promise<void> | undefined } = { since: null, begun: undefined };
  if (proc.started === undefined) clock.since = performance.now();
  else
    clock.begun = proc.started.then(() => {
      clock.since = performance.now();
    });
  return clock;
}

/**
 * A program's exit, or null when the program itself did not end within `ms`: on a driver with work between the program's
 * end and its exit (SandboxProcess.finished: k8s, collecting its writable mounts back and deleting its pod), `ms` bounds
 * the program's end alone and the exit then comes on the driver's own bounds (k8s-transfer.ts collectBudgetMs, its
 * delete's), as io.ts's Supervisor leaves it to the driver; with no `finished`, `ms` bounds the exit, as ever.
 */
async function programExitWithin(prog: Program, ms: number): Promise<SandboxExit | null> {
  const finished = prog.proc.finished;
  if (finished === undefined) return settleWithin(prog.exited, ms);
  const ended = await settleWithin(Promise.race([finished, prog.exited]).then(() => true), ms);
  return ended === null ? null : await prog.exited;
}

/** One trial's state: what it started, what it made, and what went wrong outside the step being waited on. */
class Pass {
  readonly sandbox: Sandbox;
  /** The docker CLI the gateway's SIGTERM goes through. */
  readonly net: NetworkOptions & { exec: DockerExec };
  /** The trial's networks (network.ts trialNetworksOf); null on the process driver. */
  readonly networks: TrialNetworks | null;
  readonly name: string;
  readonly procs = new Set<SandboxProcess>();
  readonly stop = new AbortController();
  /** The trial network was made and is not removed yet. */
  network = false;
  watch: { stop(): Promise<void> } | null = null;
  /** The cassette, once read (a void reports it too). */
  cassette: ScrapeCassetteT | null = null;
  cassetteSha: string | null = null;
  /** With entry secrets, what /output held once it was collected (a void reports it too). */
  secretHits: SecretOutputHit[] = [];
  /** The one-pod layout's (the header's One pod): the trial's pod once opened, the door and the IP admitted at it, the gateway lane's directory. */
  pod: SandboxPod | null = null;
  door: Door | null = null;
  admitted: string | null = null;
  laneDir: string | null = null;
  /** The trial asked for the entry's kill (runEntry's; an abort's and the teardown's are its stop signal's): its end after it is the trial's own. */
  entryKillAsked = false;
  #forgetting: Promise<void> | null = null;
  #releasing: Promise<void> | null = null;
  readonly #trouble: Promise<never>;
  #fail: (err: unknown) => void = () => undefined;

  constructor(sandbox: Sandbox, net: NetworkOptions & { exec: DockerExec }, networks: TrialNetworks | null, name: string) {
    this.sandbox = sandbox;
    this.net = net;
    this.networks = networks;
    this.name = name;
    this.#trouble = new Promise<never>((_, reject) => {
      this.#fail = reject;
    });
    this.#trouble.catch(() => undefined);
  }

  /** Something went wrong outside the step being waited on (the gateway died, the meter failed): the first one is the trial's. */
  fail(err: unknown): void {
    this.#fail(err);
  }

  spawn(spec: SandboxSpec): SandboxProcess {
    return this.track(this.sandbox.spawn(spec));
  }

  /** A program the trial started some other way (a pod's member, a hosted lane): killed with the rest. */
  track<P extends SandboxProcess>(p: P): P {
    this.procs.add(p);
    void p.exited.then(() => this.procs.delete(p));
    return p;
  }

  /** The one-pod layout's IP forgotten at the door (the header's One pod); once, every caller awaiting the same forget, never throwing. */
  forgetPod(): Promise<void> {
    if (this.#forgetting === null && this.door !== null && this.admitted !== null) this.#forgetting = this.door.forget(this.admitted).catch(() => undefined);
    return this.#forgetting ?? Promise.resolve();
  }

  /** The one-pod layout's end of the pod (the header's One pod): its IP forgotten at the door, then the pod closed; once, never throwing. */
  releasePod(): Promise<void> {
    // The launcher's end by this close is the trial's own: it forgets nothing out of this order.
    this.entryKillAsked = true;
    this.#releasing ??= (async () => {
      await this.forgetPod();
      await this.pod?.close().catch(() => undefined);
    })();
    return this.#releasing;
  }

  /**
   * `p`, or a rejection: the trial's trouble, the abort, or with `ms` the `late` error, `ms` counted from now or, with
   * `from`, from when `from` settles (a program's start: startClock's `begun`; never, while it has not).
   */
  async wait<T>(p: Promise<T>, ms: number | null = null, late?: () => Error, from?: Promise<void>): Promise<T> {
    p.catch(() => undefined);
    const signal = this.stop.signal;
    if (signal.aborted) throw new TrialAborted();
    let timer: NodeJS.Timeout | undefined;
    let over = false;
    let onAbort: (() => void) | undefined;
    const racers: Promise<T>[] = [p, this.#trouble];
    racers.push(
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new TrialAborted());
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    );
    if (ms !== null) {
      racers.push(
        new Promise<never>((_, reject) => {
          const arm = (): void => {
            if (!over) timer = setTimeout(() => reject(late!()), ms);
          };
          if (from === undefined) arm();
          else void from.then(arm);
        }),
      );
    }
    try {
      return await Promise.race(racers);
    } finally {
      over = true;
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Stop at once: every wait rejects, every program is killed. */
  abort(): void {
    this.stop.abort();
    for (const p of this.procs) void p.kill().catch(() => undefined);
  }

  /** The header's step 8, but the scratch (runScrapeTrial's). Never throws. */
  async teardown(): Promise<void> {
    this.stop.abort();
    await this.watch?.stop().catch(() => undefined);
    this.watch = null;
    await Promise.all([...this.procs].map((p) => p.kill().catch(() => undefined)));
    if (this.network && this.networks !== null) {
      await this.networks.remove(this.name).catch(() => undefined);
      this.network = false;
    }
    if (this.pod !== null) await this.releasePod();
    if (this.laneDir !== null) {
      await rm(this.laneDir, { recursive: true, force: true }).catch(() => undefined);
      this.laneDir = null;
    }
  }
}

/** The one-pod layout's three (the header's One pod): the sandbox's pods, the lane host, the door. */
interface PodHosting {
  pods: SandboxPods;
  hosted: HostedServices;
  door: Door;
}

/**
 * The one-pod layout when the options ask for it (the header's One pod): `hosted` and `door` together (one without
 * the other is a TypeError) on a sandbox with `pods`; null for today's path (neither given, or a sandbox with no
 * `pods`). Refused (TypeError): a door whose scrape port is not SCRAPE_GATEWAY_PORT (the entry dials a listed host's
 * HTTPS port, its name resolving to the door).
 */
function podHostingOf(o: ScrapeTrialOptions): PodHosting | null {
  if (o.hosted === undefined && o.door === undefined) return null;
  if (o.hosted === undefined || o.door === undefined) throw new TypeError("a scrape trial on one pod takes both `hosted` and `door` (the lanes client's HostedServices and Door), or neither");
  const pods = o.sandbox.pods;
  if (pods === undefined) return null;
  if (o.door.ports.scrape !== SCRAPE_GATEWAY_PORT) throw new TypeError(`the door's scrape port is ${o.door.ports.scrape}: the entry dials a listed host's port ${SCRAPE_GATEWAY_PORT}, which its pod resolves to the door`);
  return { pods, hosted: o.hosted, door: o.door };
}

function checkOptions(o: ScrapeTrialOptions): { network: ScrapeNetworkT; capMs: number; pod: PodHosting | null } {
  const t = o.trial;
  scrapeTrialOwner(t);
  if (!(SCRAPE_HEAT_STAGES as readonly string[]).includes(t.stage)) throw new TypeError(`stage ${JSON.stringify(t.stage)} is not one of ${SCRAPE_HEAT_STAGES.join(', ')}`);
  if (!Number.isSafeInteger(t.position) || t.position < 0) throw new TypeError(`position ${String(t.position)} is not a 0-based integer`);
  const network = ScrapeNetwork.parse(o.harness.network);
  const capMs = ScrapeHeatConfig.parse(o.harness.heat).cap_ms;
  if (o.entry.runtime === 'node22' && (typeof o.launcherSource !== 'string' || o.launcherSource.length === 0)) throw new TypeError('a node22 house needs the launcher source (launch.ts launcherSource, or the kit\'s copy)');
  // The process driver's house runs its launch.ts as the program, on this node: a python3.13 entry runs only inside Docker.
  if (o.sandbox.kind === 'process' && o.entry.runtime !== 'node22') throw new TypeError(`the process driver runs node22 entries only (${o.entry.runtime} runs only inside Docker)`);
  for (const r of o.heat.upstream) {
    const checked = ScrapeResolution.safeParse(r);
    if (!checked.success) throw new TypeError(`the heat's resolution ${JSON.stringify(r).slice(0, 200)} is not one: ${checked.error.issues[0]!.message}`);
  }
  // Checked as a sandbox's secrets are (the header's entry secrets); its words name a secret, never quote a value.
  try {
    checkSandboxSecrets({ secrets: o.secrets });
  } catch (err) {
    throw new TypeError(`the entry's secrets: ${(err as Error).message}`);
  }
  if (o.reserveCpu !== undefined && typeof o.reserveCpu !== 'boolean') throw new TypeError(`reserveCpu ${JSON.stringify(o.reserveCpu)} is not a boolean`);
  return { network, capMs, pod: podHostingOf(o) };
}

/** What the trial's reserving specs carry (the header's CPU reservation): reserveCpu with the option on, nothing with it off. */
function reserveOf(o: ScrapeTrialOptions): { reserveCpu?: true } {
  return o.reserveCpu === true ? { reserveCpu: true } : {};
}

// ---------------------------------------------------------------- entry secrets

/** A trial's entry secrets, compiled once (the header's entry secrets): their values for the launcher, every form to mask, and the scan by NAME. */
interface TrialSecrets {
  values: Readonly<Record<string, string>>;
  forms: FormSet;
  scan: FormIndex;
  mask: ScrapeRecordingMask;
}

function trialSecretsOf(secrets: Readonly<Record<string, string>> | undefined): TrialSecrets | null {
  const forms = entrySecretForms(secrets);
  if (forms === null || secrets === undefined) return null;
  return { values: secrets, forms, scan: secretScanIndex(secrets), mask: { text: (s) => maskText(s, forms), body: (b) => maskBytes(b, forms) } };
}

/** Each form set's forms with their UTF-8 bytes reversed, one byte a code unit (latin1): a matcher over a tail read backwards. */
const reversedForms = new WeakMap<FormSet, FormSet>();

function reversedFormsOf(forms: FormSet): FormSet {
  let r = reversedForms.get(forms);
  if (r === undefined) {
    r = new FormSet(forms.forms.map((f) => Buffer.from(f, 'utf8').reverse().toString('latin1')));
    reversedForms.set(forms, r);
  }
  return r;
}

/**
 * How many of `tail`'s first bytes could be the end of a form a cut at its start split: the longest prefix of `tail` that
 * is a proper suffix of one of `forms`, in bytes (0: none). Read backwards, that prefix is the live suffix a streaming
 * masker holds back at the end, waiting for the rest of a form (secret-mask.ts TextMasker.held).
 */
export function formEndAtStart(tail: Uint8Array, forms: FormSet): number {
  if (forms.forms.length === 0 || tail.length === 0) return 0;
  const reversed = reversedFormsOf(forms);
  const span = Math.min(tail.length, reversed.maxChars - 1);
  if (span <= 0) return 0;
  const masker = new TextMasker(reversed);
  masker.push(Buffer.from(tail.subarray(0, span)).reverse().toString('latin1'));
  return masker.held;
}

/**
 * One of the launcher's tails of the entry's stdout or stderr (its stream's last `tailBytes`) as it may be stored, every
 * form of `forms` masked (SECRET_MARK). A tail as long as tailBytes may be a stream cut at its start, which would keep the
 * end of a value the cut split, and no whole form matches an end: its first bytes that could be one (formEndAtStart) go,
 * one SECRET_MARK in their place. A tail's end is its stream's own, never cut. `forms` null: the tail as it is.
 */
export function maskLaunchTail(tail: Buffer, forms: FormSet | null, tailBytes: number): Buffer {
  if (forms === null || tail.length === 0) return tail;
  const lead = tail.length >= tailBytes ? formEndAtStart(tail, forms) : 0;
  const masked = maskBytes(tail.subarray(lead), forms);
  return lead === 0 ? masked : Buffer.concat([Buffer.from(SECRET_MARK, 'utf8'), masked]);
}

/** `blobs`, every file it stores scanned as it is stored for the forms of the secrets by NAME (`found`: its sha256 to the NAMEs). */
function scanningBlobs(blobs: ScrapeTrialBlobs, scan: FormIndex, found: Map<string, ReadonlySet<string>>): ScrapeTrialBlobs {
  return {
    async put(data) {
      const put = await blobs.put(data);
      if (!found.has(put.sha256)) found.set(put.sha256, new Set(findForms(data, scan, { limit: 1 }).map((h) => h.name)));
      return put;
    },
  };
}

/** Where /output held a form of a secret (the header's entry secrets): a file's bytes (`found`) or its path, as `output/<path>` with the path masked; file order, then name order. */
function outputSecretHits(outputs: TrialOutputsT, found: ReadonlyMap<string, ReadonlySet<string>>, s: TrialSecrets): SecretOutputHit[] {
  const hits: SecretOutputHit[] = [];
  for (const f of outputs.files) {
    const names = new Set(found.get(f.sha256) ?? []);
    for (const h of findForms(f.path, s.scan, { limit: 1 })) names.add(h.name);
    const file = `output/${maskText(f.path, s.forms)}`;
    for (const name of [...names].sort(compareCodeUnits)) hits.push({ name, file });
  }
  return hits;
}

/** The heat CA's certificate for the house: one PEM certificate of a CA, nothing else (no key). */
function checkCaCert(pem: string): string {
  const blocks = typeof pem === 'string' ? (pem.match(/-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g) ?? []) : [];
  if (blocks.length !== 1 || pem.replace(blocks[0]!, '').trim() !== '') throw new TypeError("the heat CA's certificate is one PEM certificate and nothing else");
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(blocks[0]!);
  } catch {
    throw new TypeError("the heat CA's certificate does not parse");
  }
  if (!cert.ca) throw new TypeError("the heat CA's certificate is not a CA's");
  return pem.endsWith('\n') ? pem : `${pem}\n`;
}

/** The house's files (launch.ts houseFor's three), the node22 launcher from the caller's text (the header). */
function houseFiles(runtime: Runtime, config: LaunchConfig, launcher: string, caCert: string): Record<string, string> {
  return {
    [LAUNCHER_FILES[runtime]]: runtime === 'node22' ? launcher : PYTHON_LAUNCHER_SOURCE,
    [LAUNCH_CONFIG]: `${JSON.stringify(config, null, 2)}\n`,
    [CA_FILE]: checkCaCert(caCert),
  };
}

/**
 * Write the gateway's config as <parent>/config/gateway.json and return that directory: `parent`
 * 0700, the directory 0711, the file 0444 in a container (the gateway runs as 65534) or 0400 on the
 * host, as agent.ts writes its forwarder's (gateway-main.ts refuses one group or others may write).
 */
async function writeGatewayConfig(parent: string, config: ScrapeGatewayConfig, kind: Sandbox['kind']): Promise<string> {
  await mkdir(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(parent, PRIVATE_DIR_MODE);
  const dir = join(parent, 'config');
  await mkdir(dir, { mode: GATEWAY_CONFIG_DIR_MODE });
  await chmod(dir, GATEWAY_CONFIG_DIR_MODE);
  const file = join(dir, GATEWAY_FILES.config);
  await writeFile(file, `${JSON.stringify(config)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(file, GATEWAY_CONFIG_FILE_MODES[kind]);
  return dir;
}

/** The process driver's gateway: agent.ts's service launcher around the bundle's script, in its own directory. */
async function writeServiceLauncher(dir: string, target: string): Promise<{ codeDir: string; script: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, LAUNCHER_SCRIPT), serviceLauncherSource(target), { mode: 0o444 });
  // The script 0444 whatever the umask (program.ts sealStaged), as agent.ts writeLauncher seals its own; its directory stays this process's alone.
  await sealStaged(join(dir, LAUNCHER_SCRIPT));
  return { codeDir: dir, script: LAUNCHER_SCRIPT };
}

/** A JSON file a program wrote whole: its value, null when it is not there, or `{unparsable}`. */
async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { unparsable: text.slice(0, 200) };
  }
}

/** What the gateway said went wrong (/record/error.json), as `: <message>`, or ''. */
async function gatewaySaid(recordDir: string, gw: Program): Promise<string> {
  const doc = await readJson(join(recordDir, GATEWAY_FILES.error)).catch(() => null);
  const error = doc !== null && typeof doc === 'object' && typeof (doc as { error?: unknown }).error === 'string' ? (doc as { error: string }).error : null;
  const said = [error, gw.logTail()].filter((s) => s !== null && s !== '').join('; ');
  return said === '' ? '' : `: ${said}`;
}

/**
 * What runs the gateway, as its death is read: the trial's sandbox, or on the one-pod layout the lane host, whose every
 * exit (the lanes program's loss included) is the gateway's (LANE_DRIVER).
 */
type GatewayDriver = Pick<Sandbox, 'isDriverFailure'>;
const LANE_DRIVER: GatewayDriver = Object.freeze({ isDriverFailure: () => false });

/** The gateway's death as the trial's fault: the sandbox's when the driver failed to run it, else the gateway's own, with what it said. */
async function gatewayDeath(sandbox: GatewayDriver, recordDir: string, gw: Program, exit: SandboxExit, when: string): Promise<Error> {
  const said = await gatewaySaid(recordDir, gw);
  return sandbox.isDriverFailure(exit) ? driverFailure(gw.proc, `the sandbox failed running the gateway (${describeExit(exit)})${said}`) : new ScrapeVoid('gateway', `the gateway exited ${when} (${describeExit(exit)})${said}`);
}

/**
 * The gateway's ready file's port, polled until it is there, the gateway exits, or `ms` pass from its program's start
 * (startClock: the process's `started` where its driver sets one, so a k8s pod's create, staging and Ready wait are the
 * driver's to bound, and a pod that never runs is the exit's to say, gatewayDeath's driver failure; else from now).
 */
async function gatewayReady(sandbox: GatewayDriver, recordDir: string, gw: Program, ms: number, signal: AbortSignal): Promise<number> {
  const clock = startClock(gw.proc);
  for (;;) {
    const doc = await readJson(join(recordDir, GATEWAY_FILES.ready));
    if (doc !== null) {
      const port = (doc as { port?: unknown }).port;
      if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new ScrapeVoid('gateway', `the gateway's ready file names no port: ${JSON.stringify(doc).slice(0, 200)}`);
      return port;
    }
    if (gw.exit !== null) throw await gatewayDeath(sandbox, recordDir, gw, gw.exit, 'before it was ready');
    if (clock.since !== null && performance.now() > clock.since + ms) throw new ScrapeVoid('gateway', `the gateway was not ready within ${ms} ms${await gatewaySaid(recordDir, gw)}`);
    if (signal.aborted) throw new TrialAborted();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** SIGTERM to the gateway in its container: `docker kill --signal TERM` on the one container of its label on the trial's network. */
async function dockerTerm(exec: DockerExec, network: string, label: string): Promise<void> {
  const ps = await exec(['ps', '--no-trunc', '--filter', `network=${network}`, '--format', '{{.ID}} {{.Names}}']);
  if (ps.code !== 0) throw new SandboxError(`docker could not list the containers on ${network}: ${(ps.error ?? ps.stderr).trim().split('\n')[0] ?? ''}`);
  const name = new RegExp(`^makefun-${label}-[0-9a-f]{12}$`);
  const ids = ps.stdout
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter((p) => p.length === 2 && name.test(p[1]!))
    .map((p) => p[0]!);
  // A container that went meanwhile refuses the kill; its exit is the check.
  if (ids.length > 0) await exec(['kill', '--signal', 'TERM', ...ids]);
}

/** Store bytes and check the store named them by their sha256. */
async function putChecked(blobs: ScrapeTrialBlobs, bytes: Uint8Array): Promise<string> {
  const sha256 = sha256Hex(bytes);
  const put = await blobs.put(bytes);
  if (put.sha256 !== sha256) throw new Error(`the blob store named bytes of sha256 ${sha256} ${put.sha256}`);
  return sha256;
}

/**
 * The gateway's record (the header's step 7), checked as the gateway wrote it, masked of the entry's secrets with `mask`
 * (gateway.ts maskScrapeRecording; the header's entry secrets) when there are any, and stored: the cassette, its stored
 * sha256, and its bodies'. Nothing of the record is stored unmasked.
 */
async function storeRecording(recordDir: string, blobs: ScrapeTrialBlobs, mask: ScrapeRecordingMask | null): Promise<{ cassette: ScrapeCassetteT; sha256: string; bodies: string[] }> {
  const file = join(recordDir, GATEWAY_FILES.cassette);
  const st = await lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (st === null) throw new ScrapeVoid('gateway', 'the gateway wrote no cassette');
  if (!st.isFile() || st.size > MAX_CASSETTE_BYTES) throw new ScrapeVoid('gateway', `the gateway's cassette is not a regular file of at most ${MAX_CASSETTE_BYTES} bytes`);
  const bytes = await readFile(file);
  const text = bytes.toString('utf8');
  if (!isCanonicalJson(text)) throw new ScrapeVoid('gateway', "the gateway's cassette is not canonical JSON");
  const parsed = ScrapeCassette.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ScrapeVoid('gateway', `the gateway's cassette is not a scrape cassette: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  let cassette = parsed.data;
  const sizes = new Map<string, number>();
  for (const e of cassette.entries) {
    if (e.body_sha256 === null) continue;
    const size = sizes.get(e.body_sha256);
    if (size !== undefined && size !== e.body_bytes) throw new ScrapeVoid('gateway', `the cassette names body ${e.body_sha256} with two sizes`);
    sizes.set(e.body_sha256, e.body_bytes!);
  }
  let bodies = new Map<string, Buffer>();
  for (const [sha256, size] of [...sizes].sort(([a], [b]) => compareCodeUnits(a, b))) {
    const at = join(recordDir, GATEWAY_FILES.bodies, sha256);
    const body = await lstat(at).then(
      (s) => (s.isFile() ? readFile(at) : null),
      () => null,
    );
    if (body === null) throw new ScrapeVoid('gateway', `the gateway wrote no body ${sha256}, which its cassette names`);
    if (body.length !== size || sha256Hex(body) !== sha256) throw new ScrapeVoid('gateway', `the gateway's body ${sha256} is not the one its cassette names (${body.length} bytes, ${size} named)`);
    bodies.set(sha256, body);
  }
  let stored: Buffer = bytes;
  if (mask !== null) {
    // Checked above as a ScrapeCassette, so it is the gateway's own shape.
    const masked = maskScrapeRecording({ cassette: JSON.parse(text) as GatewayCassette, bodies }, mask);
    const maskedText = cassetteJson(masked.cassette);
    // A body masked is named again, so a record whose text is unchanged has every body unchanged too.
    if (maskedText !== text) {
      const again = ScrapeCassette.safeParse(JSON.parse(maskedText));
      if (!again.success) {
        const issue = again.error.issues[0]!;
        throw new Error(`the cassette masked of the entry's secrets is no scrape cassette: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      cassette = again.data;
      stored = Buffer.from(maskedText, 'utf8');
      bodies = masked.bodies;
    }
  }
  const named: string[] = [];
  for (const [, body] of [...bodies].sort(([a], [b]) => compareCodeUnits(a, b))) named.push(await putChecked(blobs, body));
  return { cassette, sha256: await putChecked(blobs, stored), bodies: named };
}

/**
 * Hold /output to program.ts's output caps while the entry runs (the header's step 6): its walkOutputs
 * watch and, where the sandbox has one (or `meter` makes one: a one-pod trial's pod.meter), its meter read by
 * outputReadingBroken (its caps, and a directory it cannot read kept so for the grace: UnreadGrace). onBreak takes the
 * first cap broken, onFault a meter that failed; neither is called once stop() is. `finished` (the
 * entry's SandboxProcess.finished) ends the walkOutputs watch's judging at the program's end.
 */
function watchOutputs(
  o: { sandbox: Sandbox; outputDir: string; runtime: Runtime; imageDigest: string | null; budgetMs: number; meter?: (opts: TreeMeterOptions) => TreeMeter | null; finished?: Promise<void> | undefined },
  onBreak: (message: string) => void,
  onFault: (message: string) => void,
): { stop(): Promise<void> } {
  const meterOf = o.meter ?? ((opts: TreeMeterOptions) => o.sandbox.meterTree?.(o.outputDir, opts) ?? null);
  let stopped = false;
  let walking = false;
  let broke = false;
  // The walker judges only while the program runs: from its `finished` (k8s: then the driver fills the host directory
  // with /output's replica, the collection's to judge) a tick does nothing and a walk in flight is dropped. A driver
  // with no `finished` (docker, process) is walked until stop(), as ever. The meter's reports are not held by this.
  let ended = false;
  void o.finished?.then(
    () => (ended = true),
    () => (ended = true),
  );
  const broken = (message: string): void => {
    if (stopped || broke) return;
    broke = true;
    onBreak(message);
  };
  const timer = setInterval(() => {
    if (stopped || walking || broke || ended) return;
    walking = true;
    void walkOutputs(o.outputDir, true)
      .then((w) => {
        if ('violation' in w && !ended) broken(w.violation);
      })
      .catch(() => undefined)
      .finally(() => {
        walking = false;
      });
  }, OUTPUT_WATCH_MS);
  let meter: TreeMeter | null = null;
  const grace = new UnreadGrace(OUTPUT_WATCH_MS);
  try {
    meter = meterOf({
      runtime: o.runtime,
      imageDigest: o.imageDigest,
      label: SCRAPE_TRIAL_LABELS.entry,
      budgetMs: o.budgetMs,
      intervalMs: OUTPUT_WATCH_MS,
      maxEntries: MAX_OUTPUT_FILES,
      maxBytes: MAX_OUTPUT_BYTES,
      maxDepth: MAX_OUTPUT_DEPTH,
      maxPathBytes: MAX_OUTPUT_PATH_BYTES,
      onUsage: (u) => {
        const why = outputReadingBroken(u, grace);
        if (why !== null) broken(why);
      },
      onFault: (why) => {
        if (!stopped) onFault(why);
      },
    }) ?? null;
  } catch (err) {
    clearInterval(timer);
    throw err;
  }
  let stopping: Promise<void> | null = null;
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      stopping ??= meter === null ? Promise.resolve() : meter.stop();
      return stopping;
    },
  };
}

// ---------------------------------------------------------------- the trial

/**
 * Run one scrape trial (see the header). An infrastructure fault is a `void` outcome, never thrown, but for a node with
 * no room for one of its pods (a NodeRoomError, thrown as it is: the header's `void sandbox`); a
 * malformed option is a TypeError (or the gateway config's ScrapeGatewayConfigError), an engine that
 * does not keep trials apart rejects with network.ts IsolationRefusal, an abort with the signal's
 * reason, and anything else thrown is this process's own fault (its blob store, a bug).
 */
export async function runScrapeTrial(opts: ScrapeTrialOptions): Promise<ScrapeTrialOutcome> {
  const { network, capMs, pod } = checkOptions(opts);
  const secrets = trialSecretsOf(opts.secrets);
  const owner = scrapeTrialOwner(opts.trial);
  const isolation = isolationOf(opts);
  const external = opts.signal;
  if (external?.aborted) throw abortReasonOf(external);
  const exec = opts.docker?.exec ?? dockerExec(opts.docker?.docker ?? (opts.sandbox instanceof DockerSandbox ? opts.sandbox.docker : 'docker'));
  const pass = new Pass(opts.sandbox, { exec }, trialNetworksOf(opts.sandbox, exec, opts.docker !== undefined), `scrape-${randomBytes(6).toString('hex')}`);
  const onAbort = (): void => pass.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(join(opts.workDir, 'scrape-trial-'));
    // Held (../grade.ts holdScratch, its header's Releasing): its removal below, once the pass is torn down, releases it
    // in one go, unless its caller holds a root above it (a heat's, a CLI's), whose own release takes it.
    holdScratch(scratch);
    return await runPass(opts, pass, { scratch, owner, network, capMs, isolation, secrets, pod });
  } catch (err) {
    if (external?.aborted) throw abortReasonOf(external);
    // The node had no room for a pod of the trial's (a preflight's, the gateway's or the entry's: run.ts driverFailure),
    // so nothing of it ran: backpressure, not the trial's fault. Thrown, so its heat's job is handed back for later
    // (server/jobs.ts `node room`) instead of voiding trial after trial on a full node.
    if (err instanceof NodeRoomError) throw err;
    const reason: ScrapeVoidReason | null = err instanceof ScrapeVoid ? err.reason : err instanceof LauncherError ? 'launcher' : err instanceof SandboxError ? 'sandbox' : null;
    if (reason === null) throw err;
    const said = err instanceof ScrapeVoid ? err.message : `${(err as Error).name}: ${(err as Error).message}`;
    // What a program printed may hold a value (a launcher's or a gateway's log tail): redacted (the header's entry secrets).
    const message = secrets === null ? said : redactSecrets(said, secrets.forms);
    return { kind: 'void', trial: { ...opts.trial }, owner, reason, message, cassette: pass.cassette, cassette_sha256: pass.cassetteSha, ...(secrets === null ? {} : { secret_hits: pass.secretHits }) };
  } finally {
    external?.removeEventListener('abort', onAbort);
    await pass.teardown();
    if (scratch !== null) await removeScratch(opts.sandbox, scratch);
  }
}

/** The engine check a docker trial requires (the header's step 2); null on the process driver, which makes no network. */
function isolationOf(o: ScrapeTrialOptions): IsolationCheck | null {
  if (!containerized(o.sandbox.kind)) return null;
  if (o.isolation !== undefined && o.isolation !== null) return o.isolation;
  if (o.sandbox.networks !== undefined) return isolationCheck(o.sandbox.networks);
  throw new TypeError("a docker scrape trial requires its engine's isolation: pass `isolation` (grader/sandbox/network.ts EngineIsolation)");
}

interface PassPlan {
  scratch: string;
  owner: string;
  network: ScrapeNetworkT;
  capMs: number;
  isolation: IsolationCheck | null;
  /** The entry's secrets, compiled (trialSecretsOf); null with none. */
  secrets: TrialSecrets | null;
  /** The one-pod layout (podHostingOf), or null for today's path. */
  pod: PodHosting | null;
}

async function runPass(o: ScrapeTrialOptions, p: Pass, plan: PassPlan): Promise<ScrapeTrialRun> {
  const { sandbox } = o;
  if (plan.pod !== null) return runPodPass(o, p, plan, plan.pod);
  const { scratch, owner, network, capMs, secrets } = plan;
  const kind = sandbox.kind;
  const onHost = kind === 'process';
  const readyMs = o.timing?.readyMs ?? SCRAPE_READY_MS;
  const stopMs = o.timing?.stopMs ?? SCRAPE_STOP_MS;
  const imageDigest = o.entry.imageDigest ?? null;

  await p.wait(sandbox.preflight('node22'));
  await p.wait(sandbox.preflight(o.entry.runtime, imageDigest));

  // The scratch: /record and /output writable for the sandbox user, the house, the gateway's config.
  const recordDir = join(scratch, 'record');
  const outputDir = join(scratch, 'output');
  const houseDir = join(scratch, 'house');
  for (const d of [recordDir, outputDir]) {
    await mkdir(d, { mode: 0o700 });
    await chmod(d, 0o777);
  }
  await mkdir(houseDir, { mode: 0o755 });
  const configDir = await writeGatewayConfig(join(scratch, 'private'), scrapeGatewayConfig({ network, heat: o.heat, kind, upstreamPort: o.upstreamPort, upstreamCa: o.upstreamCa, userAgent: o.userAgent }), kind);

  // Steps 1 and 2: what a dead grader left of this trial, the engine's isolation, the networks.
  if (p.networks !== null) {
    const reaped = await p.wait(p.networks.reap(owner));
    o.onReap?.(reaped);
    await p.wait(plan.isolation!.require());
    await p.wait(p.networks.create(p.name, { owner }));
    p.network = true;
    await p.wait(p.networks.ensureEgress());
  }
  const trialNetwork = trialNetworkName(p.name);

  // Step 3: the gateway.
  const gwCode = onHost ? await writeServiceLauncher(join(scratch, 'launch'), join(o.gateway.dir, o.gateway.script)) : { codeDir: o.gateway.dir, script: o.gateway.script };
  const gwProc = p.spawn({
    runtime: 'node22',
    ...gwCode,
    mounts: [
      { host: configDir, at: '/config', readOnly: true },
      // The ready file is all the trial reads of it while the gateway runs (gatewayReady); the cassette, its bodies and
      // error.json come back once it has exited.
      { host: recordDir, at: '/record', readOnly: false, live: [{ path: GATEWAY_FILES.ready }], returns: RECORD_RETURNS },
    ],
    limits: SERVICE_LIMITS,
    label: SCRAPE_TRIAL_LABELS.gateway,
    network: scrapeAttachment(p.name, 'gateway', network.hosts),
    ...(onHost ? { env: { MAKEFUN_GATEWAY_HOST: '127.0.0.1' } } : {}),
    ...reserveOf(o),
  });
  const gw = new Program(gwProc, [gwProc.stdout, gwProc.stderr]);
  let gatewayStopping = false;
  let gatewayReadyYet = false;
  void gw.exited.then(async (exit) => {
    if (!gatewayStopping) p.fail(await gatewayDeath(sandbox, recordDir, gw, exit, gatewayReadyYet ? 'while the trial ran' : 'before it was ready'));
  });
  const port = await p.wait(gatewayReady(sandbox, recordDir, gw, readyMs, p.stop.signal));
  gatewayReadyYet = true;

  // Step 4: the house and the entry under its launcher: the secrets' NAMEs in launch.json, their values for its stdin alone.
  // A container's entry gets exactly launch.json's env, never its container's (and never the mount stand-in the driver puts
  // there): so /output's stand-in goes in launch.json, naming the mount's own path as it does for any containerized program.
  const config = launchConfig(o.entry.runtime, {
    capMs,
    user: onHost ? null : SANDBOX_UID,
    ...(onHost
      ? {
          codeDir: o.entry.dir,
          houseDir,
          interpreter: o.interpreter ?? process.execPath,
          env: { [MOUNT_POINTS['/output']]: outputDir, [SCRAPE_GATEWAY_ENV]: `127.0.0.1:${port}` },
        }
      : { env: { [MOUNT_POINTS['/output']]: '/output' } }),
    ...(secrets === null ? {} : { secrets: secrets.values }),
  });
  writeHouse(houseDir, { files: houseFiles(o.entry.runtime, config, o.launcherSource, o.heat.caCert) });
  const outputMount = { host: outputDir, at: '/output' as const, readOnly: false, returns: OUTPUT_RETURNS };
  const entryLimits: SandboxLimits = { cpus: o.limits.cpus, memory_mb: o.limits.memory_mb, pids: o.limits.pids };
  const entrySpec: SandboxSpec = onHost
    ? { runtime: o.entry.runtime, codeDir: houseDir, script: LAUNCHER_FILES.node22, mounts: [outputMount], limits: entryLimits, label: SCRAPE_TRIAL_LABELS.entry, network: scrapeAttachment(p.name, 'entry', network.hosts), ...reserveOf(o) }
    : {
        runtime: o.entry.runtime,
        codeDir: o.entry.dir,
        mounts: [outputMount],
        limits: entryLimits,
        label: SCRAPE_TRIAL_LABELS.entry,
        imageDigest,
        network: scrapeAttachment(p.name, 'entry', network.hosts),
        launcher: { houseDir },
        ...reserveOf(o),
      };
  const entryProc = p.spawn(entrySpec);
  const ran = await runEntry(o, p, plan, {
    entryProc,
    outputDir,
    imageDigest,
    // A cap broken on docker removes the entry's container at once (step 6).
    stopForOutput: onHost ? null : () => entryProc.kill().catch(() => undefined),
    quietAfterBreak: false,
  });

  // Step 7: the gateway's SIGTERM, and its record.
  gatewayStopping = true;
  if (gw.exit === null) {
    if (onHost) gwProc.stdin.end();
    else if (kind === 'k8s') await p.wait(k8sTerminate(gwProc));
    else await p.wait(dockerTerm(p.net.exec, trialNetwork, SCRAPE_TRIAL_LABELS.gateway));
  }
  // stopMs bounds the gateway's own end (on k8s its /record is collected and its pod deleted after: the driver's bounds).
  const gwExit = await p.wait(programExitWithin(gw, stopMs));
  if (gwExit === null) {
    await p.wait(gwProc.kill());
    throw new ScrapeVoid('gateway', `the gateway did not exit within ${stopMs} ms of its SIGTERM${await gatewaySaid(recordDir, gw)}`);
  }
  if (sandbox.isDriverFailure(gwExit)) throw driverFailure(gwProc, `the sandbox failed running the gateway (${describeExit(gwExit)})${await gatewaySaid(recordDir, gw)}`);
  if (gwExit.code !== 0) throw new ScrapeVoid('gateway', `the gateway exited with ${describeExit(gwExit)} on its SIGTERM${await gatewaySaid(recordDir, gw)}`);
  return judgeTrial(o, p, plan, { recordDir, outputDir, ran, tailBytes: config.tail_bytes });
}

/** What the entry's run under its launcher came to (runEntry): its result, whether it was killed for its output, and the first cap it broke. */
interface EntryRun {
  result: LaunchResult;
  killed: boolean;
  /** The output cap broken while it ran, or null. */
  violation: string | null;
  wallNs: number;
  /** One pod's: the pod ran out of memory once `go` was sent (the header's One pod, step 6). */
  memory: boolean;
  /** The launcher gave its result (its clock and tails), whatever ended its container after. */
  reported: boolean;
  /**
   * The split layout's: how the entry's pod ended it once `go` was sent (killedByItsPod: out of memory, as it ran or as
   * its /output was collected, evicted for /output past its size limit, or its container's first process killed), so
   * /output is lost; null when it did not. Its result then says exit null, signal SIGKILL: the pod's kill.
   */
  lost: PodKill | null;
}

/**
 * Steps 4 to 6 past the spawn, on every layout: the launcher's session (its `ready`, `go` and result), the watch on
 * /output from the start, the launcher's exit, the watch stopped. `stopForOutput` stops the entry's writes once a cap
 * is broken (null on the process driver, which cannot); `meter` makes the watch's meter in place of the sandbox's
 * meterTree; `quietAfterBreak` drops a meter fault that comes once a cap was broken (the one-pod layout's, whose stop
 * for the output closes the pod, its `watch` with it). `oom` (one pod's: `read` its SandboxPod.oom) makes the go
 * step's launcher failure, and a meter fault after `go`, the entry's memory once it reads true; with it, a launcher
 * whose stdout closed after `go` with no result has `exitMs` for its exit (the driver reads the pod's status to decide
 * it), a wait the result's own bound does not cut.
 */
async function runEntry(
  o: ScrapeTrialOptions,
  p: Pass,
  plan: PassPlan,
  a: {
    entryProc: SandboxProcess;
    outputDir: string;
    imageDigest: string | null;
    stopForOutput: (() => Promise<void>) | null;
    meter?: (opts: TreeMeterOptions) => TreeMeter | null;
    quietAfterBreak: boolean;
    oom?: { read: () => boolean; exitMs: number };
  },
): Promise<EntryRun> {
  const { sandbox } = o;
  const { capMs, secrets } = plan;
  const { entryProc, outputDir, imageDigest } = a;
  const readyMs = o.timing?.readyMs ?? SCRAPE_READY_MS;
  const resultSlackMs = o.timing?.resultSlackMs ?? SCRAPE_RESULT_SLACK_MS;
  const exitMs = o.timing?.exitMs ?? SCRAPE_EXIT_MS;
  const entry = new Program(entryProc, [entryProc.stderr]);
  // The launcher's ready wait counts from its program's start (startClock: on k8s, once its pod was made, staged and Ready).
  const entryStart = startClock(entryProc);
  const session = new LauncherSession({ stdin: entryProc.stdin, stdout: entryProc.stdout }, { secrets: secrets?.values ?? null });
  let stdoutEnded = false;
  /** When the launcher's stdout ended (process.hrtime.bigint()): its program's end, for a run its pod ended before its result. */
  let stdoutEndedAt: bigint | null = null;
  for (const ev of ['end', 'close'] as const)
    entryProc.stdout.once(ev, () => {
      stdoutEnded = true;
      stdoutEndedAt ??= process.hrtime.bigint();
    });

  // Step 6's watch, from the start.
  const broke: { message: string | null; at: bigint | null } = { message: null, at: null };
  let stopping: Promise<void> | null = null;
  /** `go` was sent: an out-of-memory end from here on is the entry's (one pod). */
  let went = false;
  const outOfMemory = (): boolean => went && a.oom !== undefined && a.oom.read();
  const watch = watchOutputs(
    { sandbox, outputDir, runtime: o.entry.runtime, imageDigest, budgetMs: readyMs + capMs + resultSlackMs, finished: entryProc.finished, ...(a.meter === undefined ? {} : { meter: a.meter }) },
    (message) => {
      broke.message = message;
      broke.at = process.hrtime.bigint();
      stopping = a.stopForOutput?.() ?? null;
    },
    (why) => {
      if (a.quietAfterBreak && broke.message !== null) return;
      // The pod out of memory ends its meter with the entry: the entry's run, judged below (one pod).
      if (outOfMemory()) return;
      p.fail(new SandboxError(`the sandbox could not meter /output: ${why}`));
    },
  );
  p.watch = watch;

  /**
   * A launcher step, its LauncherError told apart: the entry's container removed for its output, or its
   * pod's end of it (on `go` only: before it nothing of the entry's ran), the driver's failure, or the
   * launcher's own. A launcher whose stdout closed is going: its exit, which comes at once (on k8s once
   * the driver has read the pod: the program's end bounded, the exit then on the driver's own bounds),
   * says whose failure it was; one that printed what is not its protocol is still running, and is the
   * launcher's. On one pod, after `go`, that exit waits for the pod's status (the driver's word on its
   * memory), so it has `oom.exitMs`, not SETTLE_EXIT_MS.
   */
  const launcherStep = async <T>(step: Promise<T>, killable: boolean): Promise<T> => {
    try {
      return await step;
    } catch (err) {
      if (!(err instanceof LauncherError)) throw err;
      if (killable && broke.message !== null && a.stopForOutput !== null) throw new KilledForOutput();
      // A program that never started (its process's `started` never came: a k8s pod that never ran, whose stdout ends
      // before its pod is deleted) has its exit on the driver's own bounds: waited for whole, so that the driver's
      // failure is the sandbox's, never the launcher's. One whose stdout ended has SETTLE_EXIT_MS for its program's end
      // (programExitWithin): on k8s its exit then comes once the driver has read why the exec ended (k8s.ts
      // #podVerdict, POD_SETTLE_MS and more), which a bound on the exit itself would cut short, voiding the pod's kill.
      // On one pod after `go` the exit itself has oom.exitMs: the driver decides it from the pod's status.
      const settle = (): Promise<SandboxExit | null> => (killable && a.oom !== undefined ? settleWithin(entry.exited, a.oom.exitMs) : programExitWithin(entry, SETTLE_EXIT_MS));
      const exit = entryStart.since === null ? await entry.exited : stdoutEnded ? await settle() : entry.exit;
      // Read once the exit settled: the driver has read the pod's containerStatuses by then (k8s.ts K8sPodProcess).
      if (killable && outOfMemory()) throw new OutOfMemory();
      // Split layout: the entry's own pod ended it once `go` was sent (killedByItsPod): out of memory, evicted for
      // /output past its size limit, or the entry killed its container's first process. The entry's run, crashed and
      // its /output lost, never a void it could pick by ending its pod before its result.
      const podKill = killable && exit !== null ? killedByItsPod(entryProc, exit) : null;
      if (podKill !== null) throw new KilledByItsPod(podKill);
      const tail = entry.logTail();
      if (exit !== null && sandbox.isDriverFailure(exit)) throw driverFailure(entryProc, `the sandbox failed running the launcher (${describeExit(exit)})${tail === '' ? '' : `: ${tail}`}`);
      throw new ScrapeVoid('launcher', `${err.message}${exit === null ? '' : ` (${describeExit(exit)})`}${tail === '' ? '' : `: ${tail}`}`);
    }
  };
  await p.wait(launcherStep(session.ready(), false), readyMs, () => new ScrapeVoid('launcher', `the launcher did not say ready within ${readyMs} ms`), entryStart.begun);

  // Step 5: go, and the result.
  const goAt = process.hrtime.bigint();
  let result: LaunchResult;
  let killed = false;
  let memory = false;
  let lost: PodKill | null = null;
  went = true;
  const noResult = (): ScrapeVoid => new ScrapeVoid('launcher', `the launcher gave no result within ${capMs + resultSlackMs} ms of go`);
  try {
    // One pod: the result's bound is the result's alone; the exit's wait once the stdout closed without one is oom.exitMs.
    result =
      a.oom === undefined
        ? await p.wait(launcherStep(session.go(), true), capMs + resultSlackMs, noResult)
        : await p.wait(launcherStep(p.wait(session.go(), capMs + resultSlackMs, noResult), true));
  } catch (err) {
    if (!(err instanceof KilledForOutput) && !(err instanceof OutOfMemory) && !(err instanceof KilledByItsPod)) throw err;
    killed = err instanceof KilledForOutput;
    memory = err instanceof OutOfMemory;
    if (err instanceof KilledByItsPod) lost = err.kill;
    // The launcher reported nothing: the host's clock from `go` to the kill (the cap's break, the out-of-memory end seen,
    // or the end of the launcher's stdout its pod's kill cut).
    const killedAt = broke.at ?? (lost !== null ? stdoutEndedAt : null) ?? process.hrtime.bigint();
    result = { wallNs: killedAt - goAt, exit: null, signal: 'SIGKILL', timedOut: false, leftover: null, stdoutTail: Buffer.alloc(0), stderrTail: Buffer.alloc(0) };
  }
  if (!entryProc.stdin.destroyed && !entryProc.stdin.writableEnded) entryProc.stdin.end();
  /**
   * The launcher gave its result line (its clock and tails stand), even where its end then was the pod's: not when it
   * was killed for its output, gone with one pod's memory, or cut by its split pod's kill before its result.
   */
  const reported = !killed && !memory && lost === null;
  // Out of memory, the sandbox is gone already (the launcher's exec ended K8S_KILLED: k8s.ts K8sPodProcess); the kill is a no-op then.
  if (killed || memory) {
    p.entryKillAsked = true;
    await p.wait(entryProc.kill());
    // What stopped the writes has ended (on one pod, its close: the pod deleted) before the trial goes on.
    if (stopping !== null) await p.wait(stopping);
  } else if (lost === null) {
    // exitMs bounds the launcher's own end (on k8s its /output is collected and its pod deleted after: the driver's bounds).
    let exit = await p.wait(programExitWithin(entry, exitMs));
    // One pod: a launcher whose exec ended (its stdout closed) without its exit status has oom.exitMs for it, as the go
    // step's has: the driver decides it from the pod's status, which may come a while after the exec's end.
    if (exit === null && a.oom !== undefined && stdoutEnded) exit = await p.wait(settleWithin(entry.exited, a.oom.exitMs));
    if (exit === null) {
      p.entryKillAsked = true;
      await p.wait(entryProc.kill());
      throw new ScrapeVoid('launcher', `the launcher's container did not exit within ${exitMs} ms of its result`);
    }
    if (sandbox.isDriverFailure(exit)) throw driverFailure(entryProc, `the sandbox failed running the launcher (${describeExit(exit)})`);
    if (exit.code !== 0) {
      if (outOfMemory()) {
        // One pod: the pod out of memory once `go` was sent, after the launcher's result (the entry's memory-backed files
        // are the pod's memory): the entry's run, crashed with the memory detail, never a void it could pick. Its /output
        // is the pod's mount on the data volume, read as ever; the launcher's clock and tails stand.
        memory = true;
        result = { ...result, exit: null, signal: 'SIGKILL' };
      } else {
        // Split layout: the pod ended it (killedByItsPod): out of memory as /output was collected, the entry's own
        // memory-backed files charged to it; evicted for /output past its size limit; or the entry killed its container's
        // first process. The entry's run, crashed and its /output lost, never a void it could pick.
        lost = killedByItsPod(entryProc, exit);
        if (lost === null) throw new ScrapeVoid('launcher', `the launcher exited with ${describeExit(exit)} after its result`);
        // The launcher's clock and tails stand (the entry ran to its end); its end is the pod's kill.
        result = { ...result, exit: null, signal: 'SIGKILL' };
      }
    }
  }
  await watch.stop();
  p.watch = null;
  const wallNs = Number(result.wallNs);
  if (!Number.isSafeInteger(wallNs)) throw new ScrapeVoid('launcher', `the launcher's wall_ns ${result.wallNs} is past a safe integer`);
  return { result, killed, violation: broke.message, wallNs, memory, lost, reported };
}

/**
 * Step 7's record and step 6's collection once the gateway has exited 0, on every layout, and how the trial ended:
 * error.json refused, the cassette checked, masked and stored, /output collected (what a cap broken mid-run left is
 * not kept; with secrets, every file scanned as it is stored), both tails stored, then the header's order.
 */
async function judgeTrial(o: ScrapeTrialOptions, p: Pass, plan: PassPlan, a: { recordDir: string; outputDir: string; ran: EntryRun; tailBytes: number }): Promise<ScrapeTrialRun> {
  const { owner, secrets } = plan;
  const { recordDir, outputDir, ran } = a;
  const { result, wallNs } = ran;
  const errorDoc = await readJson(join(recordDir, GATEWAY_FILES.error));
  if (errorDoc !== null) throw new ScrapeVoid('gateway', `the gateway wrote ${GATEWAY_FILES.error}: ${JSON.stringify(errorDoc).slice(0, 300)}`);
  const recording = await p.wait(storeRecording(recordDir, o.blobs, secrets?.mask ?? null));
  p.cassette = recording.cassette;
  p.cassetteSha = recording.sha256;

  // Step 6's collection: what a cap broken mid-run left is not kept, nor anything of an /output its pod's kill lost (the
  // driver emptied it; nothing there is read either way). With secrets, every file scanned as it is stored.
  let violation: string | null = ran.violation;
  let outputs: TrialOutputsT = EMPTY_OUTPUTS;
  if (violation === null && ran.lost === null) {
    const found = new Map<string, ReadonlySet<string>>();
    const collected = await p.wait(collectOutputs(outputDir, secrets === null ? o.blobs : scanningBlobs(o.blobs, secrets.scan, found)));
    if ('violation' in collected) violation = collected.violation;
    else outputs = collected.outputs;
    if (secrets !== null) p.secretHits = outputSecretHits(outputs, found, secrets);
  }
  // A launcher killed for the output, gone with the pod's memory, or cut by its pod's kill before its result, reported no tails.
  const tailless = !ran.reported;
  const stdoutTail = tailless ? null : await p.wait(putChecked(o.blobs, maskLaunchTail(result.stdoutTail, secrets?.forms ?? null, a.tailBytes)));
  const stderrTail = tailless ? null : await p.wait(putChecked(o.blobs, maskLaunchTail(result.stderrTail, secrets?.forms ?? null, a.tailBytes)));

  // How it ended.
  const upstream = scrapeUpstreamVoid(recording.cassette);
  if (upstream !== null) throw new ScrapeVoid('upstream_error', upstream);
  const launch: ScrapeLaunchFacts = { exit: result.exit, signal: result.signal, timed_out: result.timedOut, leftover: result.leftover };
  const seen = scrapeTrialFault({ launch, violation, cassette: recording.cassette });
  // Out of memory (one pod once `go` was sent), or the split layout's pod ending it once `go` was sent (out of memory as
  // it ran or as its /output was collected, evicted for /output, its container's first process killed): its SIGKILL
  // ranks where a crash does, and says what ended it, by the cause the driver read and whether the result came first.
  const killDetail = ran.memory ? TRIAL_MEMORY_DETAIL : ran.lost !== null ? (ran.reported ? SCRAPE_POD_KILL_DETAIL : SCRAPE_POD_KILL_RUN_DETAIL)[ran.lost] : null;
  const fault = seen !== null && seen.status === 'crashed' && killDetail !== null ? { status: seen.status, detail: killDetail } : seen;
  // A violation names /output's paths: redacted (the cassette's paths are masked already).
  const detail = fault === null ? null : secrets === null ? fault.detail : redactSecrets(fault.detail, secrets.forms);
  return {
    kind: 'run',
    trial: { ...o.trial },
    owner,
    fault: fault?.status ?? null,
    detail,
    wall_ns: wallNs,
    ...launch,
    outputs,
    cassette: recording.cassette,
    cassette_sha256: recording.sha256,
    blobs: {
      cassette: recording.sha256,
      bodies: recording.bodies,
      outputs: [...new Set(outputs.files.map((f) => f.sha256))].sort(),
      stdout_tail: stdoutTail,
      stderr_tail: stderrTail,
    },
    ...(secrets === null ? {} : { secret_hits: p.secretHits }),
  };
}

// ---------------------------------------------------------------- one pod

/**
 * The trial on the one-pod layout (the header's One pod): the upstream addresses held to the egress policy, one pod of
 * `entry` and `watch`, the gateway a lane child behind the door. Every step a void or a throw as on the split layout.
 */
async function runPodPass(o: ScrapeTrialOptions, p: Pass, plan: PassPlan, hosting: PodHosting): Promise<ScrapeTrialRun> {
  const { sandbox } = o;
  const { scratch, owner, network, capMs, secrets } = plan;
  const { hosted, door } = hosting;
  const readyMs = o.timing?.readyMs ?? SCRAPE_READY_MS;
  const stopMs = o.timing?.stopMs ?? SCRAPE_STOP_MS;
  const imageDigest = o.entry.imageDigest ?? null;

  // 1. Before anything starts: what the gateway pod had by policy (egress-ranges.ts), now that the gateway runs in none.
  for (const r of o.heat.upstream) {
    for (const ip of r.ips) {
      const why = sandboxEgressRefusal(ip);
      if (why !== null) throw new ScrapeVoid('gateway', `the heat resolved ${r.host} to ${ip}, which the sandbox egress policy does not open (${why}): the gateway may dial only what its pod could`);
    }
  }

  // 2. The entry's image (the gateway's node runs in the lanes container, no sandbox); the scratch: /output, the house.
  await p.wait(sandbox.preflight(o.entry.runtime, imageDigest));
  const outputDir = join(scratch, 'output');
  const houseDir = join(scratch, 'house');
  await mkdir(outputDir, { mode: 0o700 });
  await chmod(outputDir, 0o777);
  await mkdir(houseDir, { mode: 0o755 });

  // 3. What a dead grader left of this trial (its pod, by owner), and the engine's isolation: the static policies are
  // what hold the entry's pod, so they are required as a trial network's are. No trial network, no egress policy.
  if (p.networks !== null) {
    const reaped = await p.wait(p.networks.reap(owner));
    o.onReap?.(reaped);
    if (plan.isolation !== null) await p.wait(plan.isolation.require());
  }

  // 4. The house (the gateway's port is not in it: the entry dials a listed host's 443, its pod naming the door; /output's
  // stand-in is, naming the mount's own path: a launcher's entry gets launch.json's env, never its container's), then the
  // pod: `entry` the launcher, its /output metered from the pod's `watch`, each listed host resolving to the door's address.
  const config = launchConfig(o.entry.runtime, {
    capMs,
    user: SANDBOX_UID,
    env: { [MOUNT_POINTS['/output']]: '/output' },
    ...(secrets === null ? {} : { secrets: secrets.values }),
  });
  writeHouse(houseDir, { files: houseFiles(o.entry.runtime, config, o.launcherSource, o.heat.caCert) });
  const entrySpec: PodMemberSpec = {
    runtime: o.entry.runtime,
    codeDir: o.entry.dir,
    mounts: [{ host: outputDir, at: '/output', readOnly: false, returns: OUTPUT_RETURNS }],
    limits: { cpus: o.limits.cpus, memory_mb: o.limits.memory_mb, pids: o.limits.pids },
    label: SCRAPE_TRIAL_LABELS.entry,
    imageDigest,
    launcher: { houseDir },
    ...reserveOf(o),
  };
  p.door = door;
  const pod = hosting.pods.open({
    label: SCRAPE_POD_LABEL,
    owner,
    members: { entry: entrySpec },
    meter: { member: 'entry', at: '/output' },
    doors: { address: door.address, names: [...network.hosts], ports: { entry: door.ports.scrape } },
  });
  p.pod = pod;
  // Nothing is staged or started for a pod the scheduler has not placed (a NodeRoomError: thrown, the job handed back).
  await p.wait(pod.scheduled);

  // 5. The gateway, a lane child: its config and record under the lane host's root, its own port on its loopback.
  const laneDir = await mkdtemp(join(hosted.root, 'scrape-'));
  p.laneDir = laneDir;
  await chmod(laneDir, PRIVATE_DIR_MODE);
  const recordDir = join(laneDir, 'record');
  await mkdir(recordDir, { mode: PRIVATE_DIR_MODE });
  // `process`: the lane child listens on 127.0.0.1 at a port it picks and reads a 0400 config, as a host process does.
  const configDir = await writeGatewayConfig(join(laneDir, 'private'), scrapeGatewayConfig({ network, heat: o.heat, kind: 'process', upstreamPort: o.upstreamPort, upstreamCa: o.upstreamCa, userAgent: o.userAgent }), 'process');
  const gwProc: HostedProcess = p.track(hosted.spawn({ dir: o.gateway.dir, script: o.gateway.script, configDir, recordDir, label: SCRAPE_TRIAL_LABELS.gateway }));
  const gw = new Program(gwProc, [gwProc.stdout, gwProc.stderr]);
  let gatewayStopping = false;
  let gatewayReadyYet = false;
  void gw.exited.then(async (exit) => {
    if (!gatewayStopping) p.fail(await gatewayDeath(LANE_DRIVER, recordDir, gw, exit, gatewayReadyYet ? 'while the trial ran' : 'before it was ready'));
  });
  await p.wait(gatewayReady(LANE_DRIVER, recordDir, gw, readyMs, p.stop.signal));
  gatewayReadyYet = true;

  // 6. The pod's IP admitted at the door, joined to this gateway alone; then the entry (its door dial first).
  const ip = await p.wait(pod.address);
  p.admitted = ip;
  await p.wait(door.admit(ip, { scrape: gwProc }));
  const entryProc = p.track(pod.spawn('entry'));
  // The pod found gone or failed by the driver (the launcher's driver-failure exit: deleted behind its back, evicted,
  // its node gone): the IP forgotten and the gateway stopped at once, before anything else of the teardown. The trial
  // is the sandbox's void (runEntry says it from that exit); the gateway's end by this kill is no `gateway` fault.
  // The launcher killed when the trial did not ask for it (the pod out of memory: SandboxPod.oom, every member ended
  // K8S_KILLED; or any kill not the trial's): the pod's sandbox is over or may be, so the IP is forgotten at once too,
  // before any wait of the trial's, the gateway left to its stop (its cassette is still the trial's).
  void entryProc.exited.then((exit) => {
    if (sandbox.isDriverFailure(exit)) {
      gatewayStopping = true;
      void p.forgetPod();
      void gwProc.kill().catch(() => undefined);
      return;
    }
    const killedExit = exit.code === K8S_KILLED && exit.signal === null && exit.error === undefined;
    if (pod.oom || (killedExit && !p.entryKillAsked && !p.stop.signal.aborted)) void p.forgetPod();
  });
  const ran = await runEntry(o, p, plan, {
    entryProc,
    outputDir,
    imageDigest,
    // A cap broken closes the pod at once: the only way to stop the writes, as docker removes the container.
    stopForOutput: () => p.releasePod(),
    // The meter's fault is the pod's end as the driver saw it first (gone, failed, or out of memory): the IP forgotten
    // at once. The gateway runs on to its stop, since out of memory after `go` its cassette is still the trial's. Out of
    // memory the fault is not the trial's to judge: the launcher's own end (the driver ends it K8S_KILLED with the meter)
    // judges it, before `go` a `launcher` void, after it the entry's run, so one rule decides it, never a race of two.
    meter: (opts) =>
      pod.meter({
        ...opts,
        onFault: (message) => {
          void p.forgetPod();
          if (pod.oom) return;
          opts.onFault(message);
        },
      }),
    quietAfterBreak: true,
    // Out of memory once `go` was sent: the entry's run (the header's One pod, step 6).
    // Its exit, once the launcher's stdout closed after `go` with no result, waits for the pod's status (POD_EXIT_MS).
    oom: { read: () => pod.oom, exitMs: o.timing?.podExitMs ?? POD_EXIT_MS },
  });

  // 7. SIGTERM to the gateway child; once it has exited (else killed and gone), the IP forgotten and the pod closed;
  // then its record.
  gatewayStopping = true;
  if (gw.exit === null) await p.wait(gwProc.terminate());
  const gwExit = await p.wait(settleWithin(gw.exited, stopMs));
  if (gwExit === null) await p.wait(gwProc.kill());
  await p.wait(p.releasePod());
  if (gwExit === null) throw new ScrapeVoid('gateway', `the gateway did not exit within ${stopMs} ms of its SIGTERM${await gatewaySaid(recordDir, gw)}`);
  if (gwExit.code !== 0) throw new ScrapeVoid('gateway', `the gateway exited with ${describeExit(gwExit)} on its SIGTERM${await gatewaySaid(recordDir, gw)}`);
  return judgeTrial(o, p, plan, { recordDir, outputDir, ran, tailBytes: config.tail_bytes });
}
