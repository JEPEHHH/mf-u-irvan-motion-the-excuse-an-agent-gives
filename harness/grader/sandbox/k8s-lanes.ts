// The lanes pod: one gVisor sandbox pod a grader makes for itself, holding a `pod` trial's key-holding programs (an
// agent trial's two forwarders, a scrape heat's recording gateway) and the door as children of ONE root program the
// grader reaches by ONE exec stream over the pod's own `watch` agent (server/sandbox-host/lanes.ts; the grader's client
// is server/sandbox-host/services.ts). This file is the pod and nothing else: its spec (lanesPodSpec) and its driver
// (lanesPodOf, K8sLanesPod), over what grader/sandbox/k8s.ts exports, which it does not edit; its size is its caller's
// (server/pipeline/index.ts lanesPodSizeOf, deploy/k8s/base/grader.yaml's arithmetic, from the floors named here). What weakens against `split`, plainly: a grader's lanes share one gVisor sandbox where today each
// forwarder is a sandbox of its own; uids stand between them, not a sandbox. A replay lane shares the pod's egress,
// where a replay forwarder's pod has none today.
//
// The pod (lanesPodSpec) is a shim program pod's shape (k8s.ts podObject, sandboxPodSpec with `shim`: release 2) but
// where a sandbox that lives as long as its grader and holds many lanes needs otherwise, each difference for a reason:
//
//   name makefun-sbx-lanes-<8 hex> (podName('lanes'): the admission policy's prefix, and `<pod>-llm` its policy name)
//   labels makefun.io/role=sandbox (makefun-sandbox-deny selects it), makefun.io/sandbox=lanes, makefun.egress=1 (a
//     live forwarder's reach: the egress policy's public internet and cluster DNS, an entrant's own provider key being
//     dialled there) and makefun.pod=<name> (its own `-llm` policy selects it by it; one pod a grader mints one
//     Cilium identity a grader, not one a trial). NOT makefun.grader=1: sweepStale and `makefun-k8s.sh reap` take
//     whatever carries it past six hours (STALE_AFTER_MS), and a grader's lanes pod lives as long as the grader (the
//     race pod's precedent, k8s.ts's header); nor does its Secret carry it (lanesEnvSecret)
//   the creator annotation (CREATOR_ANNOTATION), so K8sSandbox.reapOrphans takes it, with its Secret and `-llm`
//     policy, once its grader is no running pod; ownerReferences naming the creator's pod and uid, blockOwnerDeletion
//     false (ownedByPod, as an env Secret is owned by its pod), so the garbage collector deletes it once the grader
//     pod's object is gone: after the whole drain (probe L8: it stays through its owner's grace and is gone 16 ms after
//     the object), and at once on a force delete. Only where the grader runs in the pod's own namespace: a grader in
//     another (MAKEFUN_K8S_SANDBOX_NAMESPACE apart from its own, K8sSandbox.ownNamespace) gives it no owner, since the
//     garbage collector reads a namespaced owner in another namespace as absent and would delete the pod at once; the
//     reap (which reads the live creators in the grader's namespace) and close() bound its life then
//   NO activeDeadlineSeconds: podObject's six hours would end a grader's every lane at once, mid-drain or not; the
//     owner reference, the reap and close() bound its life instead
//   runtimeClassName required (the pod is a gVisor sandbox or nothing: under runc its root and DAC_OVERRIDE would be
//     the node's), and the sandbox's nodeSelector (MAKEFUN_K8S_NODE_SELECTOR, makefun.io/gvisor=true: the gVisor pool)
//     as every other sandbox pod takes it. It mounts no claim (protocol v2: the grader and its lanes pod share no
//     directory), so nothing ties it to the claim's node; while it mounted one, the claim's node affinity alone placed
//     it, and a lanes pod carrying the selector stayed Pending (2026-11-14: `1 node(s) didn't match Pod's node
//     affinity/selector, 3 node(s) didn't match PersistentVolume's node affinity`). No spread and no preferred node,
//     as a forwarder's. serviceAccountName with automountServiceAccountToken false, enableServiceLinks false,
//     restartPolicy Never, terminationGracePeriodSeconds 0, as podObject
//   dnsPolicy ClusterFirst with ndots 0: an egress pod's (a forwarder's) resolver
//   runAsUser/Group 0, runAsNonRoot false, seccomp RuntimeDefault, for the pod; three containers, as every shim pod:
//     `stage`, its init container (k8s.ts stageContainer: the agent image, `makefun-agent stage --install`, uid
//       10001, its key from the pod's own Secret), which installs the shim's binary into the pod's agent-bin emptyDir
//       and holds LANES_POD_ROOT read-write for the staging (LANES_STAGE_MOUNT: one empty tree, nothing written; its exec is
//       the arrival and its release that `stage`'s agent waits for, the pod failing by itself past STAGE_ARRIVAL_S
//       without one); `main`'s resources, as an init container's add nothing to the pod's
//     `main`: the pinned node22 image by digest, imagePullPolicy IfNotPresent (imagePullSecrets makefun-registry);
//       command the shim (k8s.ts shimCommand(main): PID 1, one task, linking to `watch` over the pod's loopback and
//       running each exec `watch` relays to it, as its user with its capabilities); it reaps every child, so an orphan
//       a lane leaves is reparented to it and never a zombie (sandbox-agent shim.rs; probe L8z ran the perl reaper it
//       replaces); the binary held read-only at AGENT_BIN_DIR. env SANDBOX_ENV alone: no key and no spec env sits in
//       `main`, what a lane needs reaches it over the stream; allowPrivilegeEscalation false, readOnlyRootFilesystem,
//       capabilities drop ALL and add LANES_CAPS: SETUID and SETGID for the drop to each lane's own uid (probe L1),
//       KILL to end a lane's processes, DAC_OVERRIDE to copy a lane's config in and its record out across uids (L3);
//       all four admitted by the cluster kit's admission policy and by Pod Security baseline, none a launcher's pod
//       lacks but DAC_OVERRIDE, which the meter's has; only `main` has them
//     `watch` (k8s.ts watchContainer: `makefun-agent serve`, uid 10001, its key from the pod's own Secret,
//       MAKEFUN_AGENT_CONTAINERS=main, mounting nothing), which every exec into `main` goes through
//   requests and limits of `main` as its caller gives them (required, requests never past limits: the pipeline's
//     lanesPodSizeOf), read each time a pod is made when the caller gives a function: a raise in the grader's trial
//     width widens the next pod (the one a moved gateway or a loss replaces), while a pod already made keeps the size
//     it was made with. `watch` adds its own (WATCH_CPU_*, shimWatchMemory(1): its memory and the shim's), as in every
//     shim pod
//   mounts: emptyDirs alone, no claim (the cluster kit's admission policy admits an emptyDir-only pod): the pod's own
//     root LANES_POD_ROOT (`/lanes`, protocol.ts) on disk, where the bootstrap writes the program off the stream and
//     the lanes' bundles and configs are put (the container's root filesystem is read-only); `/tmp` an emptyDir of
//     medium Memory, LANES_TMP_SIZE (charged to the pod's memory, L5: lanes do not work there); `/work` an emptyDir on
//     disk, where each lane's private directory lives (L5: not charged as the pod's memory); agent-bin (k8s.ts
//     agentBinVolume). No /bot, no house, no /dev/shm mount. The grader's lanes directory (`<work root>/lanes/<grader
//     pod>`) is its client's alone (server/sandbox-host/services.ts): a lane's config goes in and its record comes back
//     on the stream
//
// The pod's Secret (lanesEnvSecret, `<pod>-env`): its agents' key K alone (k8s.ts sandboxEnvSecret: MAKEFUN_AGENT_KEY,
// 32 bytes of this process's crypto.randomBytes), read by secretKeyRef only by `stage` and `watch`, never by `main`;
// labelled makefun.pod=<name> alone (no makefun.grader: above); made first, in the pod's own create, and given the pod
// as its owner by a patch after (k8s.ts's header, Secret first).
//
// The driver (lanesPodOf → K8sLanesPod). A pod is, for each open() (each `kubectl` line below the API server's own
// call asked in-process in a pod or a burst grader: k8s-count.ts apiExec, its GET, list and DELETEs, kubectl only
// where the in-process client cannot be asked; the Ready wait the pod's watch, k8s.ts awaitPod):
//
//   (the node22 preflight, K8sSandbox.preflight: once per process)
//   kubectl -n <ns> get pod/<creator> -o jsonpath={.metadata.uid}         the owner's uid
//   kubectl -n <ns> get pods -l makefun.io/sandbox=lanes -o json          this creator's lanes pods left by an earlier
//   kubectl -n <ns> delete pod/<p> secret/<p>-env networkpolicy/<p>-llm   run of the same pod (a container restart
//                                                                         keeps the pod's name; reapOrphans cannot
//                                                                         see it), deleted first
//   (the agents' spec, K8sSandbox.agentSpec: the agent image and their peer)
//   the boot's first half (k8s.ts bootToAgent, as a program pod's Fast boot): the Secret, then the pod, in one create
//     (in a pod the API server's POSTs over its own token, else ONE `kubectl create -f -` List), the Secret's owner
//     patched off the critical path, the pod's IP from its watch, `stage`'s agent dialled and its first answer
//   with an LLM gateway: kubectl -n <ns> get pod/<pod> -o jsonpath={.metadata.uid}, then its <pod>-llm policy
//     (gatewayPolicy for the addresses resolved now) created, owned by the pod, while the boot goes on
//   the boot's second half (k8s.ts bootFromAgent): the staging over `stage` (LANES_STAGE_MOUNT's empty tree, its release ending `stage`),
//     Ready, `watch`'s agent dialled (the session the driver holds for the pod's life), the shim gate (`watch` lists
//     `main` before any exec goes into it)
//   with an LLM gateway, the policy wait (below), over `watch` into `main`: then open() resolves { address }
//   exec(): ONE stream over `watch` into `main` for the pod's life (agent-client.ts AgentSession.stream)
//   kubectl -n <ns> delete pod/<pod> secret/<pod>-env [networkpolicy/<pod>-llm] ...   close(), once; `watch`'s session
//                                                                         closed after it
//
// One stream a pod. The lanes program is ONE process for the pod's life, so exec() runs once a pod, nothing here execs
// into it to poll or probe on a hot path (what the program must say it says on the stream), and a second exec() is
// refused. When the stream ends the driver never opens another into the same pod: its client (services.ts) ends every
// hosted process as a driver failure, says so in one `[grader] ALERT:` line, and close()s the pod; the next open()
// makes a fresh one under a new name. The one other exec is the policy wait, ONE a pod at its creation, run to its end
// before open() resolves (so before the stream or any lane exists), never repeated for the pod's life. No exec of this
// pod crosses the API server (kubectl exec's API server, Konnectivity and kubelet: the plan's #701): both go over the
// pod's `watch` agent, dialled at <pod IP>:9011 directly (agent-client.ts: TLS 1.3 pinned to HKDF(K), every request
// HMAC'd with K), which relays them to `main`'s shim; neither is ever sent twice (agent-client.ts's no re-send). The
// lanes protocol (protocol.ts, v2's frames) rides that stream as it rode kubectl's: stdin to the program, its stdout
// and stderr back, its end the stream's.
//
// The policy wait. A lanes pod's `-llm` policy is owned by the pod, so it is made AFTER the pod, where a forwarder's
// comes first; until the CNI enforces it the pod's dial to the gateway is refused, and a lane's first upstream call
// would meet that. So with an LLM gateway, once the pod is Ready and its shim linked, the pod dials each address its
// policy names on the gateway's port from inside (POLICY_WAIT_ARGV in node22, the pod's runtime, within POLICY_WAIT_MS:
// an entry pod's policy wait, k8s.ts), measured, never assumed from Ready: one exec over `watch` into `main` (k8s.ts
// agentMember), bounded by POLICY_WAIT_MS + KUBECTL_TIMEOUT_MS as an entry's. All taking a connection is the pass;
// none within the wait, or a wait that did not run (its exec refused, lost or never opened over the agent), is the
// driver's failure: what was made is deleted and open() throws a SandboxError, no stream opened and no lane started. A
// SandboxError is a `sandbox` hold, the platform's, by grader/worker.ts trialFaultHoldReason; no wait is the control
// plane's (k8s.ts ExecUnstartedError) any more, as no exec crosses it. With no gateway there is no wait and no exec.
//
// The pace. The pod's create (the Secret and the pod, bootToAgent) and its `-llm` policy's wait for a slot of the
// sandbox's own pace (k8s.ts SandboxPace, K8sSandbox.pace: the process's one in a grader), as every other sandbox pod's
// create does, so a final's lock that replaces a lanes pod queues it behind no flood unpaced and a 429 any of them meets
// cuts the one limiter. Nothing else of the pod is paced: its execs ride its agent and cross no API server.
//
// What ends a lanes pod no delete reached. The shared delete's warning (deleteObjects) names activeDeadlineSeconds,
// which a lanes pod has not; the driver's warnings say instead what ends it (LANES_LEFT_BEHIND).
//
// One driver a process. open() deletes every lanes pod this creator's annotation names, so two drivers of one creator
// would delete each other's: a second driver's open() is refused while another of the same namespace and creator
// holds a pod (LANES_HELD).
//
// The gateway's address. A forwarder pod's `-llm` policy is made from the gateway host resolved at its trial, so a
// moved gateway is picked up by the next trial. A lanes pod lives as long as its grader, so gatewayMoved() (called at
// each lane start) resolves a configured host that is a name again and compares it with the addresses the pod's policy
// was made with: on a change it says so in ONE `[grader] ALERT:` line and answers true from then on, and the client
// replaces the pod once it holds no lane, however long its lanes run (replaceKind() 'gateway-moved'), new lanes waiting
// for the new pod; nothing here deletes or re-makes a policy
// under live lanes. A literal address is never resolved, and nothing of this runs for it.
//
// A dead door. A one-pod trial's member dials the lanes pod's door before its program (k8s.ts K8sPodProcess's door
// dial, from inside the trial's pod), and a lanes pod can stay Running 2/2, its agent session alive, while its door
// takes no connection from any trial pod (prod 2026-11-21: four trials in 17 s on one door, all timed out, the pod 155
// min old; no loss fires, as the stream lives). So each dial that ran and took no connection is reported here
// (k8s.ts reportLanesDoorMiss → lanesDoorUnreachable(miss), to whichever driver's open pod has that address). One
// miss is not enough: a trial pod's own network may not be programmed yet (a new pod's endpoint, the same cause as a
// policy wait's dropped dials, common on prod 2026-11-21), which says nothing of the door. So a miss only counts (one
// plain warning line), counted by the trial it ran for, not by its pod: the plan's owner (k8s.ts DoorMissReport.trial,
// `<run id>.<trial index>` for a pipeline trial, the same on every pass and every re-run of it, each of which gets a
// fresh pod), so one trial whose own new pods keep an unprogrammed network counts once however often it runs again; a
// plan with no owner (none in the pipeline) is counted by its pod's name instead. Once misses from
// LANES_DOOR_MISS_TRIALS different trials fall within LANES_DOOR_MISS_WINDOW_MS of each other (a count older than the
// window is dropped), the grader dials the door itself, from its own pod's network (a TCP connect to the address and
// the door port the last trial dialled, within LANES_DOOR_GRADER_DIAL_MS; LanesPodOfOptions.doorDial, default
// dialDoor): a connection taken (the door accepts and then drops a peer it never admitted, door.ts) says the door is
// alive and the misses were the trials' own networks, so the count is cleared, in one plain warning line, and nothing
// is marked; reports that come while that dial runs share its outcome. Only a grader dial that fails too marks the pod
// dead (that dial needs the lanes pods' ingress on the door's ports to admit the grader's pod, makefun-sandbox-lanes,
// deploy/k8s/sandbox/networkpolicies.yaml, naming the grader's app namespace; where it does not, the grader's dial is dropped and fails, and the mark stands as the
// two trials' misses alone made it). Once marked: ONE `[grader] ALERT:` line, and gatewayMoved() answers true for it
// (replaceReason() names why), the client's (services.ts) one retirement path: it hands the pod out no more, ends and
// close()s it once its last lane is gone (the delete above, never a kubectl of its own), and the next open makes a
// fresh pod under a new name. Lanes already running in it finish where they are, for at most the client's
// LANES_RETIRE_DRAIN_MS (10 min; replaceKind() 'dead-door' says so, where a moved gateway's 'gateway-moved' waits for
// its lanes, which still work): past it the client ends them (driver failures: their trials void as platform faults,
// `sandbox`, and run again) and closes the pod all the same. A report naming an address no open pod has (a pod already
// replaced, an address since handed to another pod), or a pod closed while the grader's dial ran, counts nothing.

import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LANES_POD_ROOT } from '../../server/sandbox-host/protocol.ts';
import { LANES_RETIRE_DRAIN_MS, type LanesReplaceKind } from '../../server/sandbox-host/services.ts';
import { imageFor, imageRef, type ImageTableT } from '../images.ts';
import { formatPeers } from './agent-wire.ts';
import {
  AGENT_BIN_DIR,
  apiClientEnv,
  AGENT_BIN_VOLUME,
  agentBinVolume,
  agentMember,
  bootFromAgent,
  bootToAgent,
  CONTAINER,
  createPodObjects,
  CREATOR_ANNOTATION,
  deleteObjects,
  dialAgent,
  envSecretName,
  gatewayPolicy,
  GATEWAY_POLICY_SUFFIX,
  IMAGE_PULL_POLICY,
  IMAGE_PULL_SECRET,
  kubectl,
  KUBECTL_TIMEOUT_MS,
  kubectlExec,
  NodeRoomError,
  ownContextOf,
  ownedByPod,
  paceSlot,
  POD_LABEL,
  POD_PREFIX,
  PodNames,
  podName,
  POLICY_WAIT_ARGV,
  POLICY_WAIT_MS,
  READY_TIMEOUT_MS,
  ROLE_LABEL,
  SANDBOX_KIND_LABEL,
  sandboxEnvSecret,
  shimCommand,
  stageContainer,
  STAGE_CONTAINER,
  watchContainer,
  WATCH_CONTAINER,
  why,
  type AgentBootFailed,
  type AgentDial,
  type DoorMissReport,
  type K8sContext,
  type K8sObject,
  type K8sSandbox,
  type KubectlChild,
  type KubectlExec,
  type PodAgentSession,
  type PodAgentSpec,
  type PodPlacement,
} from './k8s.ts';
import { apiExec, inClusterApiCreate, inClusterApiObjects, inClusterApiPatch, processApiWatch, type ApiCreate, type ApiObjects, type ApiPatch, type ApiWatch } from './k8s-count.ts';
import { EGRESS_LABEL } from './network.ts';
import type { StageTree } from './tree-stream.ts';
import { SANDBOX_ENV, SandboxError } from './types.ts';

/** The lanes pod's kind (SANDBOX_KIND_LABEL) and its name's label: makefun-sbx-lanes-<8 hex>. */
export const LANES_KIND = 'lanes';
/** The root program's capabilities: the drop to each lane's uid (SETUID, SETGID), ending lanes (KILL), the copy in and out across uids (DAC_OVERRIDE). */
export const LANES_CAPS: readonly string[] = Object.freeze(['SETUID', 'SETGID', 'KILL', 'DAC_OVERRIDE']);
/** The memory `/tmp`'s size: charged to the pod's memory (probe L5), so small; a lane works on `/work`. */
export const LANES_TMP_SIZE = '64Mi';
/** Where the pod's on-disk emptyDir is mounted: each lane's private directory lives under it. */
export const LANES_WORK_DIR = '/work';
/**
 * What `stage` stages into a lanes pod (the header's `stage`): ONE tree, empty, at LANES_POD_ROOT, its arrival and
 * release all `stage`'s agent waits for (the program reaches the pod on its stream, not here). k8s-transfer.ts
 * stageStream takes no staging without a mount point, and the unpacker writes nothing for an empty tree.
 */
export const LANES_STAGE_MOUNT = LANES_POD_ROOT;
/** The floor of the pod's CPU request (server/pipeline/index.ts lanesPodSizeOf), the most podObject ever requests. */
export const LANES_CPU_REQUEST_MIN_MILLI = 250;
/** The floor of the pod's CPU limit, in millicores: two whole cores. */
export const LANES_CPU_LIMIT_MIN_MILLI = 2000;
/** The step a memory limit is rounded up to. */
export const LANES_MEMORY_STEP_MI = 64;
/** A lane's CPU headroom in the limit over its measured cost. */
export const LANES_CPU_HEADROOM = 2;
/**
 * What a lanes pod's delete that never succeeded says ends the pod, in place of the shared warning's
 * activeDeadlineSeconds, which a lanes pod has not (lanesPodSpec).
 */
export const LANES_LEFT_BEHIND =
  "a lanes pod has no activeDeadlineSeconds: its owner reference ends it once its grader's pod is gone, K8sSandbox.reapOrphans takes it once its creator is no running pod, and its creator's next open() sweeps it";

const [EGRESS_KEY, EGRESS_VALUE] = EGRESS_LABEL.split('=') as [string, string];
const ROOT_VOLUME = 'lanes';
const TMP_VOLUME = 'tmp';
const WORK_VOLUME = 'work';
const LANES_NAME_RE = new RegExp(`^${POD_PREFIX}${LANES_KIND}-[a-z0-9]([-a-z0-9]{0,42}[a-z0-9])?$`);
const DNS_SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const IMAGE_REF_RE = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/;
const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * How many different trials' door dials (each trial by its run and index, however many pods its passes and re-runs
 * made) must take no connection, within LANES_DOOR_MISS_WINDOW_MS, for the grader to dial the door itself, whose
 * failure too marks the lanes pod's door dead (the header's A dead door).
 */
export const LANES_DOOR_MISS_TRIALS = 2;
/** The window those misses fall within: ten minutes. */
export const LANES_DOOR_MISS_WINDOW_MS = 10 * 60_000;
/** How long the grader's own dial of the door has to be taken (the header's A dead door): five seconds. */
export const LANES_DOOR_GRADER_DIAL_MS = 5_000;
/**
 * What a door miss did (lanesDoorUnreachable): counted toward LANES_DOOR_MISS_TRIALS (or, at the threshold, cleared
 * by the grader's own dial, which the door took), or the pod is (or was already) marked dead and being replaced.
 */
export type LanesDoorMiss = 'counted' | 'replacing';
/**
 * The grader's own dial of a door (the header's A dead door): a TCP connect from this process to `address`:`port`
 * within `timeoutMs`, resolving null once the connection was taken, else what failed. Never rejects.
 */
export type LanesDoorDial = (address: string, port: number, timeoutMs: number) => Promise<string | null>;

/**
 * The default LanesDoorDial: node's TCP connect from this process's own network, the socket destroyed at once,
 * whether it connected or not (the door drops a peer it never admitted before reading a byte, door.ts, so nothing
 * of a lane is reached).
 */
export const dialDoor: LanesDoorDial = (address, port, timeoutMs) =>
  new Promise<string | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const socket = createConnection({ host: address, port });
    const end = (said: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      socket.destroy();
      resolve(said);
    };
    timer = setTimeout(() => end(`no connection within ${timeoutMs} ms`), timeoutMs);
    socket.once('connect', () => end(null));
    socket.once('error', (err: NodeJS.ErrnoException) => end(err.code ?? err.message));
  });
/** Where deleteObjects' warning names activeDeadlineSeconds: the driver's warnings say LANES_LEFT_BEHIND from there on. */
const SHARED_DEADLINE = '; its activeDeadlineSeconds';
/** The uid a pod is only built with to be checked (the driver's constructor), never sent. */
const CHECK_UID = '00000000-0000-0000-0000-000000000000';

/** A lanes pod's CPU and memory, requests and limits: its caller's (server/pipeline/index.ts lanesPodSizeOf). */
export interface LanesPodResources {
  requests: { cpuMilli: number; memoryMi: number };
  limits: { cpuMilli: number; memoryMi: number };
}

/** A lanes pod's size as its caller gave it, checked: whole positive millicores and Mi, requests never past limits. */
function checkResources(r: LanesPodResources): LanesPodResources {
  const n = (v: number, what: string): number => {
    if (!Number.isInteger(v) || v < 1) throw new SandboxError(`lanes pod ${what} ${v} is not a positive integer`);
    return v;
  };
  const out = {
    requests: { cpuMilli: n(r?.requests?.cpuMilli, 'CPU request'), memoryMi: n(r?.requests?.memoryMi, 'memory request') },
    limits: { cpuMilli: n(r?.limits?.cpuMilli, 'CPU limit'), memoryMi: n(r?.limits?.memoryMi, 'memory limit') },
  };
  if (out.requests.cpuMilli > out.limits.cpuMilli || out.requests.memoryMi > out.limits.memoryMi) {
    throw new SandboxError(`lanes pod requests (${out.requests.cpuMilli}m, ${out.requests.memoryMi}Mi) exceed its limits (${out.limits.cpuMilli}m, ${out.limits.memoryMi}Mi)`);
  }
  return out;
}

/** A lanes pod's agents' spec (PodPlacement.agent), checked: required, an image by digest, at least one peer, each an IP. */
function checkAgent(agent: PodAgentSpec | undefined, pod: string): PodAgentSpec {
  if (agent === undefined || agent === null) {
    throw new SandboxError(`lanes pod ${pod}: no agent image to run its ${STAGE_CONTAINER} and ${WATCH_CONTAINER} containers (grader/images.json pins none, or the agents' peer is not known yet)`);
  }
  if (typeof agent.image !== 'string' || !IMAGE_REF_RE.test(agent.image)) throw new SandboxError(`lanes pod ${pod}: agent image ${JSON.stringify(agent.image)} is not <image>@sha256:<64 hex>`);
  try {
    formatPeers(agent.peers);
  } catch (err) {
    throw new SandboxError(`lanes pod ${pod}: the agents' ${(err as Error).message}`);
  }
  return agent;
}

/** A lanes pod's own (lanesPodSpec): its placement (a RuntimeClass, a creator and the agents' spec required), name, image, owner's uid and size. */
export interface LanesPodOptions extends PodPlacement {
  name: string;
  image: string;
  digest: string;
  /** The creator's pod's uid, which the pod's ownerReferences name (in the creator's namespace alone). */
  creatorUid: string;
  /**
   * The creator's pod's namespace (the process's own: K8sSandbox.ownNamespace). Absent or `namespace`: the pod is owned
   * by it. Another: no ownerReferences, since the garbage collector treats an owner in another namespace as absent and
   * would delete the pod at once; the creator-annotation reap and close() bound its life alone (the header).
   */
  creatorNamespace?: string;
  resources: LanesPodResources;
}

/** The lanes pod (the header), pure: every field pinned by tests/unit/sandbox-k8s-lanes.test.ts. */
export function lanesPodSpec(opts: LanesPodOptions): K8sObject {
  if (typeof opts.name !== 'string' || !LANES_NAME_RE.test(opts.name) || opts.name.length > 62) {
    throw new SandboxError(`lanes pod name ${JSON.stringify(opts.name)} is not ${POD_PREFIX}${LANES_KIND}-<suffix> (podName('${LANES_KIND}'))`);
  }
  if (opts.runtimeClass === null || opts.runtimeClass === undefined) throw new SandboxError('a lanes pod runs under a gVisor RuntimeClass or not at all: the sandbox has none');
  const creator = opts.creator;
  if (typeof creator !== 'string' || !DNS_SUBDOMAIN_RE.test(creator)) throw new SandboxError(`a lanes pod is owned by its creator's pod: creator ${JSON.stringify(creator ?? null)} is no pod name`);
  const r = checkResources(opts.resources);
  const agent = checkAgent(opts.agent, opts.name);
  const resources = {
    limits: { cpu: `${r.limits.cpuMilli}m`, memory: `${r.limits.memoryMi}Mi` },
    requests: { cpu: `${r.requests.cpuMilli}m`, memory: `${r.requests.memoryMi}Mi` },
  };
  const spec: Record<string, unknown> = { runtimeClassName: opts.runtimeClass };
  if (opts.nodeSelector !== null && Object.keys(opts.nodeSelector).length > 0) spec.nodeSelector = { ...opts.nodeSelector };
  spec.serviceAccountName = opts.serviceAccount;
  spec.imagePullSecrets = [{ name: IMAGE_PULL_SECRET }];
  spec.automountServiceAccountToken = false;
  spec.enableServiceLinks = false;
  spec.restartPolicy = 'Never';
  spec.terminationGracePeriodSeconds = 0;
  spec.dnsPolicy = 'ClusterFirst';
  spec.dnsConfig = { options: [{ name: 'ndots', value: '0' }] };
  spec.securityContext = { runAsUser: 0, runAsGroup: 0, runAsNonRoot: false, seccompProfile: { type: 'RuntimeDefault' } };
  // `stage` takes `main`'s resources (an init container's add nothing to the pod's), installs the shim, and holds the
  // staging's one mount point.
  spec.initContainers = [stageContainer(agent, opts.name, resources, [{ name: ROOT_VOLUME, mountPath: LANES_STAGE_MOUNT }], true)];
  spec.containers = [
    {
      name: CONTAINER,
      image: imageRef({ image: opts.image }, opts.digest),
      imagePullPolicy: IMAGE_PULL_POLICY,
      command: shimCommand(CONTAINER),
      env: Object.entries(SANDBOX_ENV).map(([name, value]) => ({ name, value })),
      resources,
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'], add: [...LANES_CAPS] } },
      volumeMounts: [
        { name: ROOT_VOLUME, mountPath: LANES_POD_ROOT },
        { name: TMP_VOLUME, mountPath: '/tmp' },
        { name: WORK_VOLUME, mountPath: LANES_WORK_DIR },
        { name: AGENT_BIN_VOLUME, mountPath: AGENT_BIN_DIR, readOnly: true },
      ],
    },
    watchContainer(agent, opts.name, [], [CONTAINER]),
  ];
  spec.volumes = [
    { name: ROOT_VOLUME, emptyDir: {} },
    { name: TMP_VOLUME, emptyDir: { medium: 'Memory', sizeLimit: LANES_TMP_SIZE } },
    { name: WORK_VOLUME, emptyDir: {} },
    agentBinVolume(),
  ];
  const pod: K8sObject = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      labels: { [ROLE_LABEL]: 'sandbox', [SANDBOX_KIND_LABEL]: LANES_KIND, [EGRESS_KEY]: EGRESS_VALUE, [POD_LABEL]: opts.name },
      annotations: { [CREATOR_ANNOTATION]: creator },
    },
    spec,
  };
  if (opts.creatorNamespace !== undefined && opts.creatorNamespace !== opts.namespace) return pod;
  return ownedByPod(pod, { name: creator, uid: opts.creatorUid });
}

/**
 * A lanes pod's `<pod>-env` Secret (the header's The pod's Secret): its agents' key K alone (`agentKey`, else a fresh
 * one), labelled makefun.pod=<name> alone, never makefun.grader (the stale sweep's mark, which the pod has not either).
 */
export function lanesEnvSecret(opts: { name: string; namespace: string; agentKey?: string }): K8sObject {
  return sandboxEnvSecret({}, { name: opts.name, namespace: opts.namespace, labels: { [POD_LABEL]: opts.name }, ...(opts.agentKey === undefined ? {} : { agentKey: opts.agentKey }) });
}

/** A lanes pod's `-llm` policy (gatewayPolicy): egress to the gateway's addresses on its port, labelled makefun.pod alone, owned by the pod. */
export function lanesGatewayPolicy(opts: { name: string; namespace: string; uid: string; addresses: readonly string[]; port: number }): K8sObject {
  const policy = gatewayPolicy({ name: opts.name, namespace: opts.namespace, labels: { [POD_LABEL]: opts.name }, addresses: opts.addresses, port: opts.port });
  return ownedByPod(policy, { name: opts.name, uid: opts.uid });
}

/**
 * What of a K8sSandbox the driver reads: where its pods go, its images, gateway, creator, warnings and preflight, its
 * agents' spec (agentSpec: read as each pod is made; agentCheckSpec: a pod built only to be checked), and its pace (the
 * header's The pace; absent or null: none, as a sandbox given its own `exec` has).
 */
export type LanesSandbox = Pick<K8sSandbox, 'placement' | 'images' | 'llmGateway' | 'creator' | 'warn' | 'preflight' | 'agentSpec' | 'agentCheckSpec'> &
  Partial<Pick<K8sSandbox, 'pace' | 'ownNamespace'>>;

export interface LanesPodOfOptions {
  /**
   * The pod's requests and limits: a value fixes the size of every pod this driver makes; a function is read each
   * time one is made (server/pipeline/index.ts lanesPodSizeOf on the width in force then), so a replacement after a
   * loss or a moved gateway is sized afresh rather than at the boot figure.
   */
  resources: LanesPodResources | (() => LanesPodResources);
  /** The kubectl CLI for the default below (default `kubectl`). */
  kubectl?: string;
  /** How to run kubectl to its end (default kubectlExec(kubectl)); tests pass a fake. */
  exec?: KubectlExec;
  /** How a pod's agent is dialled (default k8s.ts dialAgent: agent-client.ts AgentSession.open); tests pass a fake agent's. */
  dial?: AgentDial;
  /**
   * The API server's pod watch (k8s.ts K8sContext.apiWatch: its IP, its Ready wait); absent: this process's own
   * (k8s-count.ts processApiWatch: its pod's token, else a burst grader's kubeconfig) when `exec` is absent, else kubectl wait.
   */
  apiWatch?: ApiWatch | null;
  /**
   * The driver's other calls asked in-process (k8s-count.ts apiExec: the uid reads, the sweep's list, the deletes);
   * absent: this process's own (inClusterApiObjects) when `exec` is absent, else every one kubectl's.
   */
  apiObjects?: ApiObjects | null;
  /** The API server's merge patch of the Secret's owner (K8sContext.apiPatch); absent as apiWatch. */
  apiPatch?: ApiPatch | null;
  /** The API server's create of the Secret, the pod and its policy (K8sContext.apiCreate); absent as apiWatch. */
  apiCreate?: ApiCreate | null;
  /** A host name's addresses (default the system resolver's). */
  lookup?: (host: string) => Promise<string[]>;
  /** How long the pod may take, from its create to its shim linked, the staging aside (default READY_TIMEOUT_MS, the sandbox's own default). */
  readyTimeoutMs?: number;
  /** The clock door misses are counted on (the header's A dead door; default Date.now). */
  now?: () => number;
  /** The grader's own dial of the door once LANES_DOOR_MISS_TRIALS trials missed it (the header's A dead door; default dialDoor); tests pass a stand-in. */
  doorDial?: LanesDoorDial;
}

/** What open() resolves: the pod's IP, the door's address. */
export interface LanesPodOpen {
  address: string;
}

/** The pods of the namespace and creators a driver holds a lanes pod for (the header's One driver a process). */
const LANES_HELD = new Map<string, K8sLanesPod>();

interface Session {
  readonly name: string;
  readonly abort: AbortController;
  opening: Promise<LanesPodOpen>;
  address: string | null;
  /** The addresses its `-llm` policy was made with (null: no gateway, or not made yet). */
  policy: readonly string[] | null;
  created: boolean;
  /** Its `watch` agent's session once booted, held for the pod's life: the policy wait and the stream go over it. */
  watch: PodAgentSession | null;
  stream: KubectlChild | null;
  moved: boolean;
  /** Each trial (its owner, else its pod's name) whose door dial took no connection, at its latest miss (the header's A dead door). */
  readonly doorMisses: Map<string, number>;
  /** The grader's own dial of the door while it runs (the header's A dead door): what every miss reported meanwhile did. */
  doorCheck: Promise<LanesDoorMiss | null> | null;
  /** Why its door was marked dead (the header's A dead door), else null. */
  doorDead: string | null;
  resolveSaid: string | null;
  closing: Promise<void> | null;
  ended: Promise<void> | null;
}

/**
 * What a door miss is counted under (the header's A dead door): its trial (the plan's owner: one trial's passes and
 * re-runs, each on a pod of its own, are one), else, where its plan named none, its pod's name; null when it names
 * neither.
 */
function doorMissKey(miss: DoorMissReport): string | null {
  if (typeof miss.trial === 'string' && miss.trial !== '') return miss.trial;
  if (typeof miss.pod === 'string' && miss.pod !== '') return miss.pod;
  return null;
}

/** A door miss's dialler in a warning line: its trial and its pod, or its pod alone where its plan named no trial. */
function doorMissWho(miss: DoorMissReport): string {
  const pod = typeof miss.pod === 'string' && miss.pod !== '' ? miss.pod : null;
  if (typeof miss.trial === 'string' && miss.trial !== '') return pod === null ? `trial ${miss.trial}` : `trial ${miss.trial} (pod ${pod})`;
  return `trial pod ${pod ?? '(unnamed)'}`;
}

/** The lanes pod's driver (the header): open(), one exec(), close(), gatewayMoved(), doorUnreachable(). */
export class K8sLanesPod {
  readonly #sandbox: LanesSandbox;
  /** Every call's context: its warn says LANES_LEFT_BEHIND in place of the shared activeDeadlineSeconds line. */
  readonly #ctx: K8sContext;
  readonly #placement: PodPlacement & { creator: string; runtimeClass: string };
  readonly #creator: string;
  /** The creator's pod's namespace (LanesSandbox.ownNamespace, else the placement's). */
  readonly #ownNamespace: string;
  readonly #key: string;
  /** Its size now: a given value returned as it is, or its caller's function read afresh at each pod (LanesPodOfOptions.resources). */
  readonly #resources: () => LanesPodResources;
  readonly #image: { image: string; digest: string };
  readonly #gateway: { host: string; port: number } | null;
  readonly #lookup: (host: string) => Promise<string[]>;
  readonly #now: () => number;
  readonly #doorDial: LanesDoorDial;
  #session: Session | null = null;

  constructor(sandbox: LanesSandbox, opts: LanesPodOfOptions) {
    const placement = sandbox.placement;
    if (placement.runtimeClass === null) throw new SandboxError('a lanes pod runs under a gVisor RuntimeClass or not at all: this sandbox has none (MAKEFUN_K8S_RUNTIME_CLASS)');
    const creator = sandbox.creator;
    if (creator === null) throw new SandboxError("a lanes pod is owned by its creator's pod: a process that names no pod of its own (POD_NAME) makes none, nothing would bound its life");
    this.#sandbox = sandbox;
    this.#creator = creator;
    // The sandbox's own placement, its nodeSelector included (the gVisor pool): the pod mounts no claim (the header).
    // The agents' spec is read as each pod is made (agentSpec), never the placement's.
    const { agent: _agent, ...where } = placement;
    this.#placement = { ...where, runtimeClass: placement.runtimeClass, creator };
    // The creator's own namespace, where its uid is read; another than the pod's drops the pod's owner (lanesPodSpec).
    const ownNamespace = sandbox.ownNamespace ?? placement.namespace;
    this.#ownNamespace = ownNamespace;
    this.#key = `${placement.namespace}\n${creator}`;
    const given = opts.resources;
    this.#resources = typeof given === 'function' ? given : () => given;
    const entry = imageFor('node22', sandbox.images as ImageTableT);
    this.#image = { image: entry.image, digest: entry.digest };
    this.#gateway = sandbox.llmGateway;
    this.#lookup = opts.lookup ?? (async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address));
    this.#now = opts.now ?? Date.now;
    this.#doorDial = opts.doorDial ?? dialDoor;
    const cli = opts.kubectl ?? 'kubectl';
    const inPod = opts.exec === undefined;
    const objects = opts.apiObjects !== undefined ? opts.apiObjects : inPod ? inClusterApiObjects(apiClientEnv()) : null;
    const run = opts.exec ?? kubectlExec(cli);
    this.#ctx = {
      namespace: placement.namespace,
      ownNamespace,
      exec: objects === null ? run : apiExec(objects, run, { timeoutMs: KUBECTL_TIMEOUT_MS, warn: (line) => sandbox.warn(line) }),
      names: new PodNames(),
      warn: (line) => {
        const at = line.indexOf(SHARED_DEADLINE);
        sandbox.warn(at < 0 ? line : `${line.slice(0, at)}; ${LANES_LEFT_BEHIND}`);
      },
      readyTimeoutMs: opts.readyTimeoutMs ?? READY_TIMEOUT_MS,
      // The sandbox's own pace (the header's The pace): the pod's create and its policy's wait for a slot as the
      // sandbox's own pods' do.
      pace: sandbox.pace ?? null,
      dial: opts.dial ?? dialAgent,
      apiWatch: opts.apiWatch !== undefined ? opts.apiWatch : inPod ? processApiWatch(apiClientEnv()) : null,
      apiPatch: opts.apiPatch !== undefined ? opts.apiPatch : inPod ? inClusterApiPatch(apiClientEnv()) : null,
      apiCreate: opts.apiCreate !== undefined ? opts.apiCreate : inPod ? inClusterApiCreate(apiClientEnv()) : null,
    };
    // Built now so a bad size, or no agent image, throws here, not at the first lane.
    this.#spec(podName(LANES_KIND), CHECK_UID, sandbox.agentCheckSpec());
  }

  /** The current (or last) pod's name; null before the first open(). */
  get name(): string | null {
    return this.#session?.name ?? null;
  }

  #spec(name: string, creatorUid: string, agent: PodAgentSpec): K8sObject {
    return lanesPodSpec({ ...this.#placement, agent, name, image: this.#image.image, digest: this.#image.digest, creatorUid, creatorNamespace: this.#ownNamespace, resources: this.#resources() });
  }

  #refs(name: string): string[] {
    return [`pod/${name}`, `secret/${envSecretName(name)}`, ...(this.#gateway === null ? [] : [`networkpolicy/${name}${GATEWAY_POLICY_SUFFIX}`])];
  }

  /**
   * The pod, booted and Ready, its shim linked and, with an LLM gateway, its policy made and waited for (the header's
   * calls and The policy wait), resolving its address. While a pod is opening or open, the same promise; after close()
   * (or an open that failed, whose pod is deleted) a fresh pod under a new name. A pod the node has no room for is
   * deleted and thrown as a NodeRoomError; any other failure (a policy wait no address passed included) deletes what
   * was made and throws a SandboxError.
   */
  open(): Promise<LanesPodOpen> {
    const prev = this.#session;
    if (prev !== null && prev.closing === null) return prev.opening;
    const s: Session = {
      name: podName(LANES_KIND),
      abort: new AbortController(),
      opening: Promise.resolve({ address: '' }),
      address: null,
      policy: null,
      created: false,
      watch: null,
      stream: null,
      moved: false,
      doorMisses: new Map(),
      doorCheck: null,
      doorDead: null,
      resolveSaid: null,
      closing: null,
      ended: null,
    };
    this.#session = s;
    const before = prev?.closing ?? Promise.resolve();
    s.opening = before.then(() => this.#open(s));
    s.opening.catch(() => undefined);
    return s.opening;
  }

  async #open(s: Session): Promise<LanesPodOpen> {
    const closed = (): SandboxError => new SandboxError(`lanes pod ${s.name} was closed before it was ready`);
    const signal = s.abort.signal;
    const killed = (): boolean => signal.aborted;
    const failed = (b: AgentBootFailed): Error => {
      if (b.killed) return closed();
      const message = `lanes pod ${s.name}: ${b.error}`;
      return b.noRoom === null ? new SandboxError(message) : new NodeRoomError(message, b.noRoom);
    };
    let empty: string | null = null;
    try {
      if (killed()) throw closed();
      const holder = LANES_HELD.get(this.#key);
      if (holder !== undefined && holder !== this) {
        throw new SandboxError(`another lanes pod driver of creator ${this.#creator} holds a pod in namespace ${this.#ctx.namespace}: one driver a process, since each open() deletes its creator's lanes pods`);
      }
      LANES_HELD.set(this.#key, this);
      await this.#sandbox.preflight('node22');
      if (killed()) throw closed();
      const ownerUid = await this.#creatorUid();
      await this.#sweep();
      if (killed()) throw closed();
      const addresses = this.#gateway === null ? null : await this.#addressesOf(this.#gateway.host);
      const agent = await this.#sandbox.agentSpec();
      const pod = this.#spec(s.name, ownerUid, agent);
      const secret = lanesEnvSecret({ name: s.name, namespace: this.#ctx.namespace });
      // The staging's one tree: an empty directory of this process's own, read by the staging alone.
      empty = await mkdtemp(join(tmpdir(), 'makefun-lanes-stage-'));
      const trees: StageTree[] = [{ mount: LANES_STAGE_MOUNT, dir: empty }];
      if (killed()) throw closed();
      s.created = true;
      // The boot's first half (k8s.ts bootToAgent): the Secret, then the pod; the IP; `stage`'s first answer.
      const reached = await bootToAgent(this.#ctx, { name: s.name, objects: [pod], secret, trees, signal, killed, init: null });
      if (!reached.ok) throw failed(reached);
      // Its `-llm` policy, owned by the pod, made while the staging, Ready and `watch` go on.
      const policyMade = this.#gateway === null || addresses === null ? Promise.resolve(null) : this.#makePolicy(s, addresses, this.#gateway.port).then(() => null, (err: unknown) => err as Error);
      const booted = await bootFromAgent(this.#ctx, reached, { trees, signal, killed });
      if (booted.ok) s.watch = booted.watch;
      const policyFailed = await policyMade;
      if (!booted.ok) throw failed(booted);
      if (policyFailed !== null) throw policyFailed;
      if (killed()) throw closed();
      if (s.watch === null) throw new SandboxError(`lanes pod ${s.name} booted without its ${WATCH_CONTAINER} agent's session`);
      if (this.#gateway !== null && s.policy !== null) {
        const missed = await this.#reachGateway(s, s.watch, s.policy, this.#gateway.port);
        if (killed()) throw closed();
        if (missed !== null) throw new SandboxError(`lanes pod ${s.name} could not reach its LLM gateway within ${POLICY_WAIT_MS} ms of Ready, so its ${GATEWAY_POLICY_SUFFIX} policy is not enforced for it (${missed})`);
      }
      s.address = booted.ip;
      return { address: booted.ip };
    } catch (err) {
      // Cut by close() (read before the end below aborts it too): the failure is the close, whatever the call said.
      const cut = killed();
      const end = this.#end(s);
      s.closing ??= end;
      await end;
      throw cut && !(err instanceof NodeRoomError) ? closed() : err;
    } finally {
      if (empty !== null) await rm(empty, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * The pod's `-llm` policy (lanesGatewayPolicy for `addresses` on `port`), owned by the pod: its uid read once its
   * boot's first half has made it, then the policy created (k8s.ts createPodObjects: in a pod the API server's POST,
   * else `kubectl create -f -`). A SandboxError when either fails.
   */
  async #makePolicy(s: Session, addresses: readonly string[], port: number): Promise<void> {
    const r = await kubectl(this.#ctx, ['get', `pod/${s.name}`, '-o', 'jsonpath={.metadata.uid}'], { signal: s.abort.signal });
    const uid = r.stdout.trim();
    if (r.code !== 0 || r.error !== undefined || !UID_RE.test(uid)) {
      throw new SandboxError(`lanes pod ${s.name}'s uid, which its ${GATEWAY_POLICY_SUFFIX} policy is owned by, could not be read: ${r.code === 0 && r.error === undefined ? JSON.stringify(uid.slice(0, 200)) : why(r)}`);
    }
    const policy = lanesGatewayPolicy({ name: s.name, namespace: this.#ctx.namespace, uid, addresses, port });
    const slot = await paceSlot(this.#ctx, 'create', s.abort.signal);
    if (slot === null) throw new SandboxError(`lanes pod ${s.name}'s ${GATEWAY_POLICY_SUFFIX} policy was cut off before its create`);
    try {
      const made = await createPodObjects(this.#ctx, [policy], slot);
      if (made.failed !== null) throw new SandboxError(`lanes pod ${s.name}'s ${GATEWAY_POLICY_SUFFIX} policy could not be created: ${made.failed.said}`);
    } finally {
      slot.release();
    }
    s.policy = addresses;
  }

  /**
   * The policy wait (the header's): ONE exec over the pod's `watch` agent into `main` (k8s.ts agentMember), from inside
   * the pod each address its policy names takes a connection on the gateway's port (POLICY_WAIT_ARGV in node22, the
   * pod's runtime) within POLICY_WAIT_MS, bounded as an entry's by POLICY_WAIT_MS + KUBECTL_TIMEOUT_MS. Null once all
   * did, else what failed: the address that did not, or why the wait did not run.
   */
  async #reachGateway(s: Session, watch: PodAgentSession, addresses: readonly string[], port: number): Promise<string | null> {
    const targets = addresses.flatMap((a) => [a, String(port)]);
    const r = await agentMember(watch, s.name, CONTAINER).run([...POLICY_WAIT_ARGV.node22, String(POLICY_WAIT_MS), ...targets], {
      signal: s.abort.signal,
      timeoutMs: POLICY_WAIT_MS + KUBECTL_TIMEOUT_MS,
    });
    if (r.code === 0 && r.error === undefined) return null;
    const said = r.stdout.trim().split('\n').at(-1) ?? '';
    const [at] = said.split(' ');
    if (r.code === 1 && r.error === undefined && addresses.some((a) => `${a}:${port}` === at)) return `the gateway at ${said}`;
    return `the wait did not run: ${why(r)}`;
  }

  /** This process's own pod's uid, read in its own namespace: what the pod's ownerReferences name where that is the pod's. */
  async #creatorUid(): Promise<string> {
    const r = await kubectl(ownContextOf(this.#ctx), ['get', `pod/${this.#creator}`, '-o', 'jsonpath={.metadata.uid}']);
    if (r.code !== 0 || r.error !== undefined) throw new SandboxError(`kubectl get pod/${this.#creator} (the lanes pod's owner): ${why(r)}`);
    return r.stdout.trim();
  }

  /** Delete every lanes pod this creator's annotation names, with its Secret and `-llm` policy: an earlier run of the same pod left them. */
  async #sweep(): Promise<void> {
    const list = await kubectl(this.#ctx, ['get', 'pods', '-l', `${SANDBOX_KIND_LABEL}=${LANES_KIND}`, '-o', 'json']);
    if (list.code !== 0 || list.error !== undefined) throw new SandboxError(`kubectl get pods -l ${SANDBOX_KIND_LABEL}=${LANES_KIND}: ${why(list)}`);
    let items: unknown;
    try {
      items = (JSON.parse(list.stdout) as { items?: unknown }).items;
    } catch {
      items = undefined;
    }
    if (!Array.isArray(items)) throw new SandboxError(`kubectl get pods -l ${SANDBOX_KIND_LABEL}=${LANES_KIND} printed no list: ${JSON.stringify(list.stdout.slice(0, 200))}`);
    type Item = { metadata?: { name?: unknown; annotations?: Record<string, unknown> } };
    const left = (items as Item[])
      .map((i) => ({ name: i?.metadata?.name, creator: i?.metadata?.annotations?.[CREATOR_ANNOTATION] }))
      .filter((i): i is { name: string; creator: string } => typeof i.name === 'string' && i.name.startsWith(POD_PREFIX) && i.creator === this.#creator)
      .map((i) => i.name);
    if (left.length === 0) return;
    this.#sandbox.warn(`k8s lanes: deleting lanes pod(s) an earlier run of ${this.#creator} left (${left.join(' ')})`);
    await deleteObjects(
      this.#ctx,
      left.flatMap((n) => [`pod/${n}`, `secret/${envSecretName(n)}`, `networkpolicy/${n}${GATEWAY_POLICY_SUFFIX}`]),
    );
  }

  /** A host's addresses, sorted and unique: itself when it is one. */
  async #addressesOf(host: string): Promise<string[]> {
    if (isIP(host) !== 0) return [host];
    let addresses: string[];
    try {
      addresses = await this.#lookup(host);
    } catch (err) {
      throw new SandboxError(`the LLM gateway's host ${host} does not resolve: ${(err as Error).message}`);
    }
    const out = [...new Set(addresses)].sort();
    if (out.length === 0) throw new SandboxError(`the LLM gateway's host ${host} resolves to no address`);
    return out;
  }

  /**
   * The pod's ONE stream (the header's One stream a pod): `argv` exec'd once in `main`, over its `watch` agent (k8s.ts
   * agentMember: agent-client.ts AgentSession.stream, relayed to `main`'s shim), its stdin open until the caller ends
   * it. A SandboxError before open() resolved, after close(), or for a second exec into the same pod.
   */
  exec(argv: readonly string[]): KubectlChild {
    const s = this.#session;
    if (s === null || s.address === null) throw new SandboxError('the lanes pod is not open: open() it first');
    if (s.closing !== null) throw new SandboxError(`lanes pod ${s.name} is closed: open() a fresh one`);
    if (s.stream !== null) throw new SandboxError(`lanes pod ${s.name} has had its one exec (its program runs once for the pod's life): close it and open a fresh one`);
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) throw new SandboxError('a lanes pod exec takes a non-empty argv of strings');
    s.stream = agentMember(s.watch, s.name, CONTAINER).stream(argv);
    return s.stream;
  }

  /** Cut the stream, delete the pod, its Secret and its policy, and close its agent's session, once; idempotent, resolving once the delete was sent. */
  close(): Promise<void> {
    const s = this.#session;
    if (s === null) return Promise.resolve();
    s.closing ??= (async () => {
      s.abort.abort();
      s.stream?.kill();
      await s.opening.catch(() => undefined);
      await this.#end(s);
    })();
    return s.closing;
  }

  /** A session's end, once: its stream cut, what its create made deleted, its `watch` session closed after, the process's hold released. */
  #end(s: Session): Promise<void> {
    s.ended ??= (async () => {
      s.abort.abort();
      s.stream?.kill();
      if (s.created) await deleteObjects(this.#ctx, this.#refs(s.name));
      if (s.watch !== null) await s.watch.close().catch(() => undefined);
      if (LANES_HELD.get(this.#key) === this) LANES_HELD.delete(this.#key);
    })();
    return s.ended;
  }

  /**
   * A trial's door dial to `miss.address`:`miss.port` ran and took no connection (`miss.said`: what the dial said)
   * (the header's A dead door). When the open pod's address is `miss.address`, the miss is counted under its trial
   * (`miss.trial`, else its pod `miss.pod` where the plan named no trial), one warning line: 'counted'. Once misses
   * from LANES_DOOR_MISS_TRIALS different trials fall within LANES_DOOR_MISS_WINDOW_MS, the grader dials the door
   * itself (LanesPodOfOptions.doorDial, within LANES_DOOR_GRADER_DIAL_MS): taken, the count is cleared (one warning
   * line) and nothing is marked: 'counted'; not taken, the pod is marked dead (ONE `[grader] ALERT:` line) and
   * gatewayMoved() answers true for it from then on, so its client replaces it once it holds no lane, or
   * LANES_RETIRE_DRAIN_MS (services.ts) into its retirement with its lanes ended: 'replacing' (and for every report
   * after). A report that comes while the grader's dial runs is counted and resolves with that dial's outcome. Null,
   * counting nothing, when no pod is open at that address (none open, still opening, closing, or another; or closed
   * while the grader's dial ran), or the report names no trial and no pod, or no door port.
   */
  async doorUnreachable(miss: DoorMissReport): Promise<LanesDoorMiss | null> {
    const s = this.#session;
    const address = miss?.address;
    if (s === null || s.closing !== null || s.address === null || typeof address !== 'string' || s.address !== address) return null;
    if (s.doorDead !== null) return 'replacing';
    const key = doorMissKey(miss);
    const port = miss.port;
    if (key === null || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
    const said = miss.said;
    const what = typeof said === 'string' && said.trim() !== '' ? said.trim().slice(0, 300) : 'no connection';
    const now = this.#now();
    for (const [k, at] of s.doorMisses) if (now - at > LANES_DOOR_MISS_WINDOW_MS) s.doorMisses.delete(k);
    s.doorMisses.delete(key);
    s.doorMisses.set(key, now);
    const window = `${LANES_DOOR_MISS_WINDOW_MS / 60_000} min`;
    if (s.doorCheck !== null) return await s.doorCheck;
    const trials = [...s.doorMisses.keys()];
    if (trials.length < LANES_DOOR_MISS_TRIALS) {
      this.#sandbox.warn(
        `k8s lanes: lanes pod ${s.name}'s door at ${address} took no connection from ${doorMissWho(miss)}'s dial (${what}): counted (${trials.length} of ${LANES_DOOR_MISS_TRIALS} trials within ${window}, then the grader dials it itself)`,
      );
      return 'counted';
    }
    const check = this.#checkDoor(s, address, port, trials, what);
    s.doorCheck = check;
    try {
      return await check;
    } finally {
      if (s.doorCheck === check) s.doorCheck = null;
    }
  }

  /**
   * The grader's own dial of session `s`'s door at `address`:`port`, once `trials` missed it within the window (the
   * header's A dead door; `what`: the last trial's dial's words): taken, the misses cleared, 'counted'; else the pod
   * marked dead, 'replacing'; null when the pod closed (or another opened) while it ran.
   */
  async #checkDoor(s: Session, address: string, port: number, trials: readonly string[], what: string): Promise<LanesDoorMiss | null> {
    const window = `${LANES_DOOR_MISS_WINDOW_MS / 60_000} min`;
    let failed: string | null;
    try {
      failed = await this.#doorDial(address, port, LANES_DOOR_GRADER_DIAL_MS);
    } catch (err) {
      failed = `the dial failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (this.#session !== s || s.closing !== null) return null;
    if (s.doorDead !== null) return 'replacing';
    if (failed === null) {
      s.doorMisses.clear();
      this.#sandbox.warn(
        `k8s lanes: lanes pod ${s.name}'s door at ${address} took no connection from trials ${trials.join(' ')} within ${window} (the last: ${what}), but took the grader's own dial of ${address}:${port}: counted, the door alive from the grader, so the misses were the trials' own pods' network and the count is cleared`,
      );
      return 'counted';
    }
    const grader = typeof failed === 'string' && failed.trim() !== '' ? failed.trim().slice(0, 300) : 'no connection';
    s.doorDead = `its door took no connection from ${trials.length} trials' dials within ${window}, nor from the grader's own`;
    this.#sandbox.warn(
      `[grader] ALERT: lanes pod ${s.name}'s door at ${address} took no connection from trials ${trials.join(' ')} within ${window} (the last: ${what}), nor from the grader's own dial of ${address}:${port} (${grader}): it starts no new lane and is replaced once it holds none; the lanes running in it finish there, for at most ${LANES_RETIRE_DRAIN_MS / 60_000} min after it stops taking new lanes, then end as platform faults (their trials void and run again)`,
    );
    return 'replacing';
  }

  /**
   * Why the open pod is being replaced, once gatewayMoved() has answered true for it (its client's words for it,
   * services.ts): its door marked dead, or the LLM gateway moved. Null while it is not.
   */
  replaceReason(): string | null {
    const s = this.#session;
    if (s === null) return null;
    if (s.doorDead !== null) return s.doorDead;
    return s.moved ? 'the LLM gateway moved' : null;
  }

  /**
   * What kind of replacement the open pod is to have, once gatewayMoved() has answered true for it (its client's
   * retirement, services.ts): 'dead-door' (its wait for its lanes bounded at LANES_RETIRE_DRAIN_MS, the lanes past it
   * ended) or 'gateway-moved' (its lanes still work: it waits for them). A dead door wins over a moved gateway. Null
   * while it is not to be replaced.
   */
  replaceKind(): LanesReplaceKind | null {
    const s = this.#session;
    if (s === null) return null;
    if (s.doorDead !== null) return 'dead-door';
    return s.moved ? 'gateway-moved' : null;
  }

  /**
   * Whether the open pod must be replaced once it holds no lane (its client's retirement, services.ts): its door was
   * reported dead (doorUnreachable: true at once, nothing resolved), or the LLM gateway moved off the addresses its
   * `-llm` policy was made with (the header's The gateway's address): a configured host that is a name resolved again
   * and compared; on a change ONE `[grader] ALERT:` line, and true from then on for this pod. False with no open pod,
   * or a live door and no gateway, a literal address, or a resolve that fails (said once: the policy is kept).
   */
  async gatewayMoved(): Promise<boolean> {
    const s = this.#session;
    const gateway = this.#gateway;
    if (s === null || s.closing !== null || s.address === null) return false;
    if (s.doorDead !== null) return true;
    if (s.policy === null || gateway === null || isIP(gateway.host) !== 0) return false;
    if (s.moved) return true;
    let now: string[];
    try {
      now = await this.#addressesOf(gateway.host);
    } catch (err) {
      const said = (err as Error).message;
      if (s.resolveSaid !== said) this.#sandbox.warn(`k8s lanes: lanes pod ${s.name} keeps its ${GATEWAY_POLICY_SUFFIX} policy (${s.policy.join(' ')}): ${said}`);
      s.resolveSaid = said;
      return false;
    }
    if (now.length === s.policy.length && now.every((a, i) => a === s.policy![i])) return false;
    if (s.moved) return true;
    s.moved = true;
    this.#sandbox.warn(
      `[grader] ALERT: the LLM gateway ${gateway.host} moved from ${s.policy.join(' ')} to ${now.join(' ')}: lanes pod ${s.name}'s ${GATEWAY_POLICY_SUFFIX} policy reaches only the old addresses, so it is replaced once it holds no lane and new lanes wait for the new pod`,
    );
    return true;
  }
}

/**
 * The lanes pod driver for `sandbox` (the header): refused for a sandbox with no RuntimeClass, no creator or no agent
 * image, or a size lanesPodSpec refuses.
 */
export function lanesPodOf(sandbox: LanesSandbox, opts: LanesPodOfOptions): K8sLanesPod {
  return new K8sLanesPod(sandbox, opts);
}

/**
 * A trial's door dial ran and took no connection (`miss`; the header's A dead door), reported by a caller that holds
 * no driver (k8s.ts reportLanesDoorMiss): K8sLanesPod.doorUnreachable on each driver of this process holding a pod
 * (LANES_HELD); what it did to the one whose open pod has that address (the grader's own dial of the door awaited
 * where the miss reached the threshold), else null.
 */
export async function lanesDoorUnreachable(miss: DoorMissReport): Promise<LanesDoorMiss | null> {
  const results = await Promise.all([...new Set(LANES_HELD.values())].map((driver) => driver.doorUnreachable(miss)));
  let out: LanesDoorMiss | null = null;
  for (const r of results) if (r === 'replacing' || (r === 'counted' && out === null)) out = r;
  return out;
}
