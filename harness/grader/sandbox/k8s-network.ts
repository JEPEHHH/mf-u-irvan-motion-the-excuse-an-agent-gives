// The k8s driver's trial networks (MAKEFUN_SANDBOX=k8s, K8sSandbox.networks): network.ts's docker networks
// in NetworkPolicy form. A trial's network is one NetworkPolicy in the worker's namespace, made before any
// of the trial's pods (deploy/k8s/README.md d4: a fresh pod's first connect can get out before Ready):
//
//   makefun-net-<trial>   labels makefun.grader=1, makefun.net=<trial>[, makefun.trial=<ownerLabel(owner)>]
//     [annotation makefun.io/trial-owner=<owner>]
//     podSelector makefun.net=<trial>; policyTypes Ingress and Egress;
//     ingress from and egress to podSelector makefun.net=<trial>
//
// NetworkPolicies only add allows to the sandbox namespace's own (deploy/k8s/sandbox/networkpolicies.yaml):
// makefun-sandbox-deny selects every sandbox pod and allows nothing, makefun-sandbox-egress lets a pod
// labelled makefun.egress=1 out to the world minus every private range and the fleet's servers. So a
// trial's pods reach one another, its forwarders (`llm`, and `house` with a target) or scrape gateway the
// world besides (and a forwarder its LLM gateway: k8s.ts gatewayPolicy), and nothing reaches a trial's pod
// from outside its trial; within it the forwarders admit their callers by a credential
// (grader/gateway/server.ts GatewayClient). The names its pods answer to are K8sSandbox's PodNames
// (hostAliases); its owner is what its pods are labelled with:
// k8s.ts ownerLabel of it (the owner itself when it is a label value, else a hash of it: a label value is at
// most 63 characters, an owner up to 128), the owner whole in the annotation makefun.io/trial-owner.
//
// remove deletes the trial's pods (makefun.net=<trial>), then its policy; reap every pod and policy of an
// owner (makefun.trial=<ownerLabel(owner)>), listed again REAP_ROUNDS times while any is left; sweepStale every grader
// pod and policy (makefun.grader=1) older than STALE_AFTER_MS. Each pod delete is k8s.ts KUBECTL_DELETE_FLAGS' graceful
// one, so a pod deleted is listed (a metadata.deletionTimestamp) until the kubelet has ended it: reap counts it as
// gone, and sweepStale passes over it. Each pod's env Secret `<pod>-env` goes by its name beside it: remove, reap and
// sweepStale delete the Secret of every sandbox pod they delete (remove's and reap's label deletes print the pods they
// took, `-o name`). A Secret is owned by its pod (k8s.ts patchSecretOwner) only once the patch after its create has
// landed, which a creator that died before it never made (and which failed on every pod while the owner was `kubectl
// patch`, which GETs first: makefun-prod 2026-11-16 held 589 makefun-sbx-*-env Secrets no pod owned), and the Role may
// not list Secrets (a list returns their data), so a Secret whose pod went by a label delete that did not name it would
// be found by nothing. ensureEgress only checks that
// makefun-sandbox-egress is there: the worker's Role may not write the namespace's own policies, and
// `makefun-k8s.sh bootstrap` applies them.
//
// Every call here is written as kubectl's argv and run by the context's exec: in a pod (and a burst grader) that is
// k8s-count.ts apiExec, which asks the API server in-process (the policy's POST, the label deletes as a list of names
// then a DELETE each, reap's and sweepStale's lists as their objects' metadata alone, the egress policy's GET, the
// version read), kubectl only where the in-process client cannot be asked; elsewhere (the e2e rig, the tests) kubectl.
//
// All of the above is the `split` layout's (grader/sandbox/layout.ts), which a contest born before the `pod` layout's
// go-live, or listed on SPLIT_COMPETITIONS, keeps for its whole life. Beside it, a `pod` trial makes no trial network:
// its one pod's members reach one another on the pod's own loopback (`store` a hostAlias of 127.0.0.1), its pod carries
// makefun.egress=lanes and no makefun.net or makefun.trial, and its one way out of itself is the door of the lanes pods
// (makefun.io/sandbox=lanes) on the door's three ports: two static policies of the kit's own, makefun-sandbox-to-lanes
// and makefun-sandbox-lanes (deploy/k8s/sandbox/networkpolicies.yaml), which nothing here makes or deletes. Its reap by owner is
// k8s.ts K8sOnePodTrialNetworks: this file's reap, then its plan pods by the owner annotation. A grader's lanes pod
// keeps a forwarder pod's reach (makefun.egress=1 and its own `<pod>-llm`). What shares a sandbox on `pod`: the env's
// hidden state and house token with the entrant's code, sharing the network namespace (loopback, abstract unix sockets)
// and the CPU and memory totals; and a grader's lanes with one another (their kernel, loopback, egress, CPU and memory
// total and root program). Both are weaker than `split`, and no NetworkPolicy stands between the members of one sandbox.
//
// Isolation (probeK8sIsolation) is network.ts's probe in pod form, five roles in four node22 pods made once the probe
// trial's policy is (the policy first, as a trial's always is), each pod the driver's release 2 shape
// (isolationAgentPodSpec, k8s.ts's header The pod): its Secret `<pod>-env` first in its create (the agents' K alone),
// `stage` on the agent image installing the shim into agent-bin, `main` (node22) with the shim as its PID 1 and agent-bin
// read-only, and `watch` taking `main`'s shim link. Each is booted as a program pod is (k8s.ts bootToAgent: the IP from
// its watch, the `stage` agent's first answer), its `stage` released with nothing staged (releaseStage: STAGE_EXEC_SCRIPT
// around `true`), then Ready, its `watch` agent dialled and the shim gate passed (k8s.ts bootFromAgent). Every exec of
// the probe goes over the pod's `watch` session into `main` (k8s.ts agentMember, relayed to `main`'s shim), none
// through the API server: the listeners, the reaches and the pair's dial. The agents' image and peers are
// K8sTrialNetworksOptions.agent's, read as each probe runs (else its placement's), and a probe with none fails before
// anything is made. A pod that does not come up ends the others' boots; whatever the end, the listeners' execs are
// ended, the pods, their Secrets and the policy deleted, then every session closed.
//
//   listener  an egress pod (as a forwarder is) running ISOLATION_LISTENER_POD_SCRIPT on SERVICE_PORT, one exec held
//             open for the probe's life, which says `listening` once it does; the quiet pods run nothing but the shim
//   control   the listener reaches its own address: the probe works at all
//   pair      the allowed pair: a pod on the probe trial's network (`inside`, as an entry is) must reach another on
//             it (`peer`, running the same listener, as a service is), the two kept apart by their own soft spread
//             (k8s.ts pairSpread), so they prefer two nodes; dialled as the entry's policy wait dials
//             (ISOLATION_PAIR_SCRIPT), with its budget (k8s.ts FIRST_CONNECT_WAIT_MS: both pods were just Ready,
//             and a fresh pod's first connect can lag Ready by seconds under load), never a reach's, and timed
//   sibling   another egress pod must not reach the listener: the egress pods of concurrent trials are
//             kept apart (docker's enable_icc=false), so the namespace's policies are enforced at all
//   inside    the pair's pod on the probe trial's network must reach neither the listener nor the world
//             (ISOLATION_WORLD)
//
// The control runs again after the sibling, so a listener that died is not taken for a kept-apart pair. A trial's pods
// may sit on different nodes (s18 and s9), so the pair runs first, and a pair that did not connect is a fault of its
// own, never read as enforcement (a SandboxError naming both pods' nodes; the peer's own control tells a listener that
// never answered from routing that failed). The pair's spread is a preference: on dsh-makefun s18 is often out of pod
// addresses, so the pair may share s9. Such a probe still gives its verdict on the reaches as it always did, a blocked
// reach between nodes included, and a verdict that holds says the pair shared a node and routing between nodes is not
// proven by it; failing it instead would leave every agent trial waiting on a probe that cannot pass. Every verdict
// names the node each of the probe's pods ran on, and one that holds says how long after both pair pods were Ready (each
// booted to its shim gate, as an entry's pod is before its policy wait) and the peer listened its first connect came, at
// most: the driver's clock from the last of those to the dial's exec, plus the dial's own time on the pod's clock (what
// POLICY_WAIT_MS, k8s.ts, is set from). Its verdict is kept as docker's is (an EngineIsolation of
// this probe): one that holds for the process, a refusal for ISOLATION_RECHECK_MS; a probe that could not run rejects
// with a SandboxError and is run again by the next ask. A refusal's faults are the k8s driver's own (types.ts
// IsolationFault): policy_not_enforced (an egress pod reached another) and trial_pod_escapes (a pod on a trial's
// network got past it); its verdicts say driver k8s.
//
// k8s.ts imports this module for K8sSandbox and this one k8s.ts for its kubectl, pod and boot helpers: nothing here reads
// a k8s.ts binding as the module loads, only once called.

import { randomBytes } from 'node:crypto';
import { imageFor, type ImageTableT } from '../images.ts';
import { CONTAINER_LABEL } from './docker.ts';
import {
  AGENT_BIN_DIR,
  AGENT_BIN_VOLUME,
  agentBinVolume,
  agentMember,
  bootFromAgent,
  bootToAgent,
  CONTAINER,
  deleteObjects,
  envSecretName,
  FIRST_CONNECT_WAIT_MS,
  IMAGE_REF_RE,
  isolationPodSpec,
  kubectl,
  KUBECTL_CREATE,
  KUBECTL_DELETE_FLAGS,
  labelValue,
  ownerAnnotations,
  ownerLabel,
  POD_LABEL,
  POD_PREFIX,
  podName,
  readPod,
  sandboxEnvSecret,
  shimCommand,
  STAGE_CONTAINER,
  stageCommand,
  stageContainer,
  WATCH_CONTAINER,
  watchContainer,
  why,
  type AuxPodOptions,
  type K8sContext,
  type K8sObject,
  type KubectlChild,
  type KubectlEnd,
  type KubectlResult,
  type PodAgentSession,
  type PodAgentSpec,
  type PodPlacement,
} from './k8s.ts';
import {
  EGRESS_LABEL,
  EngineIsolation,
  ISOLATION_LISTENER_S,
  ISOLATION_LISTENER_SCRIPT,
  ISOLATION_PROBE_MS,
  ISOLATION_REACH_SCRIPT,
  ISOLATION_RECHECK_MS,
  NETWORK_EXISTS_HINT,
  NETWORK_LABEL,
  OWNER_LABEL,
  parseDockerTime,
  readReach,
  REAP_ROUNDS,
  SERVICE_PORT,
  STALE_AFTER_MS,
  trialNetworkName,
  type DriverVerdict,
  type Reach,
} from './network.ts';
import { SandboxError, TRIAL_NETWORK_PREFIX, type IsolationVerdict, type ReapResult, type SweepResult, type TrialNetworks } from './types.ts';

/** The sandbox namespace's egress policy (deploy/k8s/sandbox/networkpolicies.yaml): what ensureEgress checks is there. */
export const EGRESS_POLICY = 'makefun-sandbox-egress';
/** Where the isolation probe's inside pod must not get to: an address the world answers on (README e1). */
export const ISOLATION_WORLD: Readonly<{ host: string; port: number }> = Object.freeze({ host: '1.1.1.1', port: 443 });
/** The line the probe's listener prints once it listens (ISOLATION_LISTENER_POD_SCRIPT). */
export const ISOLATION_LISTENING = 'listening';
/**
 * The probe's listener in a pod (the listener's and the peer's exec into `main`, `node -e`, argv: seconds to live):
 * network.ts's ISOLATION_LISTENER_SCRIPT itself (the same server on SERVICE_PORT ending itself at the same time), after
 * a SIGTERM handler that exits 0 (so the delete's TERM, should it reach it before its container ends, ends it 0), and
 * printing ISOLATION_LISTENING once it listens (a net server's 'listening' comes after the script's synchronous
 * lines, so the handler set after its listen() hears it): what the probe waits for before any reach of it.
 */
export const ISOLATION_LISTENER_POD_SCRIPT = [
  "process.on('SIGTERM', () => process.exit(0));",
  ISOLATION_LISTENER_SCRIPT,
  `server.once('listening', () => process.stdout.write('${ISOLATION_LISTENING}\\n'));`,
].join('\n');
/** How long a listener's exec has to say ISOLATION_LISTENING (node's start in `main` under gVisor, then its bind). */
export const ISOLATION_LISTENER_UP_MS = 15_000;
/**
 * What a reach's or the pair's exec has beyond its own budget before it is cut, the probe's failure (node's start in
 * `main` under gVisor, the relay through `watch` and `main`'s shim): its script ends itself at its budget.
 */
export const ISOLATION_EXEC_SLACK_MS = 15_000;
/**
 * The allowed pair's dial (`node -e`, argv: host, port, ms), as an entry's policy wait dials (k8s.ts POLICY_WAIT_ARGV:
 * 250 ms an attempt, 20 ms apart, any failure tried again), so what it times is what that wait sees: until host:port
 * takes a connection or the deadline passes. Prints one line, {reached, how, ms, attempts}: how it ended (`connect`, or
 * the last attempt's error code), the ms from the script's start to that end, and how many attempts it made.
 */
export const ISOLATION_PAIR_SCRIPT = [
  "const net = require('node:net');",
  'const [host, port, ms] = process.argv.slice(1);',
  'const start = Date.now();',
  'const deadline = start + Number(ms);',
  'let attempts = 0;',
  'const done = (reached, how) => {',
  "  process.stdout.write(JSON.stringify({ reached, how, ms: Date.now() - start, attempts }) + '\\n');",
  '  process.exit(0);',
  '};',
  'const attempt = () => {',
  '  attempts += 1;',
  '  let over = false;',
  '  const s = net.connect({ host, port: Number(port) });',
  '  const end = (how) => {',
  '    if (over) return;',
  '    over = true;',
  '    clearTimeout(timer);',
  '    s.destroy();',
  "    if (how === 'connect') done(true, how);",
  '    else if (Date.now() + 20 < deadline) setTimeout(attempt, 20);',
  '    else done(false, how);',
  '  };',
  "  const timer = setTimeout(() => end('TIMEOUT'), Math.max(1, Math.min(250, deadline - Date.now())));",
  "  s.once('connect', () => end('connect'));",
  "  s.once('error', (e) => end(String(e.code || e.message)));",
  '};',
  'attempt();',
].join('\n');

/** What the allowed pair's dial (ISOLATION_PAIR_SCRIPT) found. */
export interface PairDial {
  reached: boolean;
  how: string;
  /** From the script's start to its end, on the pod's clock. */
  ms: number;
  attempts: number;
}
/** The kubectl resource name of a NetworkPolicy, as `-o name` prints it. */
const POLICY_RESOURCE = 'networkpolicy.networking.k8s.io';
/**
 * reap's list: one line per pod or policy, `<kind>/<name>`, then its metadata.deletionTimestamp after a space when it is
 * being deleted (kubectl prints nothing for a missing key); nothing at all for none.
 */
export const REAP_LIST_JSONPATH = 'jsonpath={range .items[*]}{.kind}/{.metadata.name} {.metadata.deletionTimestamp}{"\\n"}{end}';
/**
 * sweepStale's list: one line per pod or policy, `<kind>/<name> <metadata.creationTimestamp>`, then its
 * metadata.deletionTimestamp after a space when it is being deleted. Like reap's, it reads each object's kind and
 * metadata alone, so in a pod it is asked as their metadata (k8s-count.ts apiExec), never the pods whole.
 */
export const STALE_LIST_JSONPATH = 'jsonpath={range .items[*]}{.kind}/{.metadata.name} {.metadata.creationTimestamp} {.metadata.deletionTimestamp}{"\\n"}{end}';
const NOT_FOUND_RE = /\(NotFound\)|not found/i;
const EXISTS_RE = /\(AlreadyExists\)|already exists/i;

/**
 * Trial `trial`'s NetworkPolicy (the header's): its pods reach one another, both ways, and nothing else it
 * allows. Labelled with its owner's label when one is given (ownerLabel: what reap finds it by), and
 * annotated with the owner whole.
 */
export function trialPolicy(trial: string, opts: { namespace: string; owner: string | null }): K8sObject {
  const name = trialNetworkName(trial);
  const net = labelValue(trial, 'trial');
  const [graderKey, graderValue] = CONTAINER_LABEL.split('=') as [string, string];
  const labels: Record<string, string> = { [graderKey]: graderValue, [NETWORK_LABEL]: net };
  if (opts.owner !== null) labels[OWNER_LABEL] = ownerLabel(opts.owner);
  const annotations = ownerAnnotations(opts.owner);
  const peers = () => ({ podSelector: { matchLabels: { [NETWORK_LABEL]: net } } });
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace: opts.namespace, labels, ...(annotations === undefined ? {} : { annotations }) },
    spec: {
      podSelector: { matchLabels: { [NETWORK_LABEL]: net } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [peers()] }],
      egress: [{ to: [peers()] }],
    },
  };
}

export interface K8sTrialNetworksOptions {
  /** kubectl in the sandbox's namespace, and its PodNames (K8sSandbox's). */
  ctx: K8sContext;
  /** Where the isolation probe's pods run: the sandbox's own placement. */
  placement: PodPlacement;
  /** The image table the probe's node22 image comes from. */
  images: ImageTableT;
  /** Age past which sweepStale removes a grader pod or policy (default STALE_AFTER_MS). */
  staleAfterMs?: number;
  /** The clock (default Date.now). */
  now?: () => number;
  /** Each reach's budget in the isolation probe (default ISOLATION_PROBE_MS). */
  probeMs?: number;
  /** The allowed pair's dial's budget in the isolation probe (default FIRST_CONNECT_WAIT_MS, k8s.ts). */
  pairMs?: number;
  /** How long a refusal is kept before the probe runs again (default ISOLATION_RECHECK_MS). */
  recheckMs?: number;
  /** Where the probe's inside pod must not get to (default ISOLATION_WORLD). */
  world?: { host: string; port: number };
  /**
   * The agents the probe's pods run (k8s.ts PodAgentSpec: K8sSandbox.agentSpec, read as each probe runs, so a relay's
   * peer is asked then). Absent: `placement.agent` as the probe runs; a probe with neither is a SandboxError.
   */
  agent?: () => PodAgentSpec | Promise<PodAgentSpec>;
  /** How long each listener's exec has to say it listens (default ISOLATION_LISTENER_UP_MS). */
  listenerUpMs?: number;
}

/** The k8s driver's TrialNetworks (the header's). */
export class K8sTrialNetworks implements TrialNetworks {
  readonly #opts: K8sTrialNetworksOptions;
  readonly #isolation: EngineIsolation;

  constructor(opts: K8sTrialNetworksOptions) {
    this.#opts = opts;
    this.#isolation = new EngineIsolation({ probe: () => this.#probe(), recheckMs: opts.recheckMs, now: opts.now });
  }

  get #ctx(): K8sContext {
    return this.#opts.ctx;
  }

  async create(trial: string, opts: { owner: string | null }): Promise<string> {
    const policy = trialPolicy(trial, { namespace: this.#ctx.namespace, owner: opts.owner });
    const name = policy.metadata.name;
    const r = await kubectl(this.#ctx, KUBECTL_CREATE, { input: JSON.stringify(policy) });
    if (failed(r)) {
      const hint = r.error === undefined && EXISTS_RE.test(r.stderr) ? NETWORK_EXISTS_HINT : '';
      throw new SandboxError(`kubectl could not create network policy ${name}: ${why(r)}${hint}`);
    }
    this.#ctx.names.forget(name);
    if (opts.owner !== null) this.#ctx.names.setOwner(name, opts.owner);
    return name;
  }

  /**
   * Every pod still on the trial's network first (the harness kills its own: this is the backstop), each sandbox pod it
   * deleted with its env Secret by name (one never given its owner would otherwise outlive it, found by nothing), then
   * its policy; any gone already is fine. A Secret delete that fails is warned of, never the removal's failure.
   */
  async remove(trial: string): Promise<void> {
    const name = trialNetworkName(trial);
    const net = labelValue(trial, 'trial');
    const pods = await kubectl(this.#ctx, ['delete', 'pods', '-l', `${NETWORK_LABEL}=${net}`, ...KUBECTL_DELETE_FLAGS, '-o', 'name']);
    const secrets = sandboxPodsOf(lines(pods.stdout)).map((pod) => `secret/${envSecretName(pod)}`);
    if (secrets.length > 0) {
      const envs = await kubectl(this.#ctx, ['delete', ...secrets, ...KUBECTL_DELETE_FLAGS]);
      if (failed(envs)) this.#ctx.warn(`k8s sandbox: ${secrets.join(' ')} may still be there: network ${name}'s remove could not delete them (${why(envs)})`);
    }
    const policy = await kubectl(this.#ctx, ['delete', `networkpolicy/${name}`, '--ignore-not-found']);
    this.#ctx.names.forget(name);
    const problems = [...(failed(pods) ? [`its pods: ${why(pods)}`] : []), ...(failed(policy) ? [`its policy: ${why(policy)}`] : [])];
    if (problems.length > 0) throw new SandboxError(`kubectl could not remove network ${name} (${problems.join('; ')})`);
  }

  /**
   * Every pod and policy labelled makefun.trial=<ownerLabel(owner)> (an exact match, the label every object of
   * the owner's was made with; what is no trial owner is a SandboxError), listed, deleted, and listed again:
   * REAP_ROUNDS deletes in all while any is left (one made meanwhile). A pod already being deleted is not left: the
   * graceful delete (KUBECTL_DELETE_FLAGS) keeps it listed, with its deletionTimestamp (REAP_LIST_JSONPATH), until the
   * kubelet has ended it. Each sandbox pod it deleted takes its env Secret by name, in one delete once the rounds are
   * done (a Secret is labelled with its owner too, but the Role may not list Secrets, so none goes by the label). Never
   * throws for what it could not list or delete: the result says.
   */
  async reap(owner: string): Promise<ReapResult> {
    const selector = `${OWNER_LABEL}=${ownerLabel(owner)}`;
    const res: ReapResult = { owner, containers: [], networks: [], errors: [] };
    const secrets = new Set<string>();
    const rounds = async (): Promise<void> => {
      for (let round = 0; ; round++) {
        const ls = await kubectl(this.#ctx, ['get', 'pods,networkpolicies', '-l', selector, '-o', REAP_LIST_JSONPATH]);
        if (failed(ls)) {
          res.errors.push(`kubectl get pods,networkpolicies -l ${selector}: ${why(ls)}`);
          return;
        }
        const left = notBeingDeleted(ls.stdout);
        if (left.length === 0) return;
        if (round === REAP_ROUNDS) {
          res.errors.push(`${left.join(' ')} still there (after ${REAP_ROUNDS} tries)`);
          return;
        }
        const del = await kubectl(this.#ctx, ['delete', 'pods,networkpolicies', '-l', selector, ...KUBECTL_DELETE_FLAGS, '-o', 'name']);
        const gone = lines(del.stdout);
        record(res, gone);
        for (const pod of sandboxPodsOf(gone)) secrets.add(`secret/${envSecretName(pod)}`);
        if (failed(del)) res.errors.push(`kubectl delete pods,networkpolicies -l ${selector}: ${why(del)}`);
      }
    };
    await rounds();
    if (secrets.size > 0) {
      const del = await kubectl(this.#ctx, ['delete', ...secrets, ...KUBECTL_DELETE_FLAGS]);
      if (failed(del)) res.errors.push(`kubectl delete ${[...secrets].join(' ')}: ${why(del)}`);
    }
    return res;
  }

  /** The namespace's egress policy is there and is the grader's; the worker never makes it (its Role may not). */
  async ensureEgress(): Promise<void> {
    await ensureEgressPolicy(this.#ctx);
  }

  /**
   * Every grader pod (makefun-sbx-*) and grader policy (a trial's, or a forwarder's makefun-sbx-*-llm) older
   * than staleAfterMs: what a crashed grader left, each pod with its env Secret by name (the header's). Never throws for
   * one it could not remove.
   */
  async sweepStale(): Promise<SweepResult> {
    const res: SweepResult = { containers: [], networks: [], errors: [] };
    const cutoff = (this.#opts.now ?? Date.now)() - (this.#opts.staleAfterMs ?? STALE_AFTER_MS);
    const ls = await kubectl(this.#ctx, ['get', 'pods,networkpolicies', '-l', CONTAINER_LABEL, '-o', STALE_LIST_JSONPATH]);
    if (failed(ls)) {
      res.errors.push(`kubectl get pods,networkpolicies -l ${CONTAINER_LABEL}: ${why(ls)}`);
      return res;
    }
    const stale: string[] = [];
    for (const item of staleListed(ls.stdout)) {
      const { name } = item;
      const ref = item.kind === 'Pod' ? 'pod' : item.kind === 'NetworkPolicy' ? 'networkpolicy' : null;
      if (ref === null) continue;
      if (!name.startsWith(POD_PREFIX) && !(ref === 'networkpolicy' && name.startsWith(TRIAL_NETWORK_PREFIX))) continue;
      // Already being deleted (a graceful delete, KUBECTL_DELETE_FLAGS): going, never deleted again.
      if (item.deleting) continue;
      const created = parseDockerTime(item.created);
      if (created === null) res.errors.push(`${ref}/${name}: no creation time`);
      else if (created < cutoff) stale.push(`${ref}/${name}`, ...(ref === 'pod' ? [`secret/${envSecretName(name)}`] : []));
    }
    if (stale.length === 0) return res;
    const del = await kubectl(this.#ctx, ['delete', ...stale, ...KUBECTL_DELETE_FLAGS, '-o', 'name']);
    record(res, lines(del.stdout));
    if (failed(del)) res.errors.push(`kubectl delete ${stale.join(' ')}: ${why(del)}`);
    return res;
  }

  isolation(): Promise<IsolationVerdict> {
    return this.#isolation.verdict();
  }

  async #probe(): Promise<DriverVerdict> {
    const { image, digest } = imageFor('node22', this.#opts.images);
    const agent = this.#opts.agent === undefined ? (this.#opts.placement.agent ?? null) : await this.#opts.agent();
    return await probeK8sIsolation({
      ctx: this.#ctx,
      placement: this.#opts.placement,
      image,
      digest,
      agent,
      probeMs: this.#opts.probeMs ?? ISOLATION_PROBE_MS,
      pairMs: this.#opts.pairMs ?? FIRST_CONNECT_WAIT_MS,
      world: this.#opts.world ?? ISOLATION_WORLD,
      ...(this.#opts.listenerUpMs === undefined ? {} : { listenerUpMs: this.#opts.listenerUpMs }),
    });
  }
}

/** The namespace's egress policy, checked (ensureEgress); a SandboxError naming the bootstrap when it is missing or not the grader's. */
export async function ensureEgressPolicy(ctx: K8sContext): Promise<void> {
  const r = await kubectl(ctx, ['get', `networkpolicy/${EGRESS_POLICY}`, '-o', 'json']);
  if (failed(r)) {
    if (r.error === undefined && NOT_FOUND_RE.test(r.stderr)) {
      throw new SandboxError(`network policy ${EGRESS_POLICY} is missing from namespace ${ctx.namespace}, so no forwarder or gateway can reach out: run \`makefun-k8s.sh bootstrap\` on that namespace's overlay (deploy/k8s/sandbox/networkpolicies.yaml)`);
    }
    throw new SandboxError(`kubectl could not read network policy ${EGRESS_POLICY}: ${why(r)}`);
  }
  type Policy = { spec?: { podSelector?: { matchLabels?: Record<string, unknown> }; policyTypes?: unknown } };
  let policy: Policy | null = null;
  try {
    policy = JSON.parse(r.stdout) as Policy | null;
  } catch {
    policy = null;
  }
  const [key, value] = EGRESS_LABEL.split('=') as [string, string];
  const types = policy?.spec?.policyTypes;
  if (policy?.spec?.podSelector?.matchLabels?.[key] !== value || !Array.isArray(types) || !types.includes('Egress')) {
    throw new SandboxError(
      `network policy ${EGRESS_POLICY} exists but is not the grader's egress policy (podSelector ${JSON.stringify(policy?.spec?.podSelector ?? null)}, policyTypes ${JSON.stringify(types ?? null)}): run \`makefun-k8s.sh bootstrap\` on that namespace's overlay (deploy/k8s/sandbox/networkpolicies.yaml)`,
    );
  }
}

export interface K8sIsolationOptions {
  ctx: K8sContext;
  placement: PodPlacement;
  /** The probe's node22 image and its digest. */
  image: string;
  digest: string;
  /** The agents its pods run (`stage`, `watch`, `main`'s shim); null: none known, the probe's SandboxError before anything is made. */
  agent: PodAgentSpec | null;
  /** Each reach's budget. */
  probeMs: number;
  /**
   * The allowed pair's dial's budget: a fresh pod's first-connect wait (k8s.ts FIRST_CONNECT_WAIT_MS, the entry's
   * policy wait's and the door dial's), never a reach's, since the pair's pods were just Ready.
   */
  pairMs: number;
  /** Where the inside pod must not get to. */
  world: { host: string; port: number };
  /** How long each listener's exec has to say it listens (default ISOLATION_LISTENER_UP_MS). */
  listenerUpMs?: number;
}

/** The probe's roles, each one pod (the header's). */
type ProbeRole = 'listener' | 'sibling' | 'inside' | 'peer';

/** An isolation probe pod's own (isolationPodSpec's, `main`'s command aside) and the agents it runs. */
export interface IsolationAgentPodOptions extends AuxPodOptions {
  trial: string | null;
  egress: boolean;
  apart?: boolean;
  agent: PodAgentSpec;
}

/**
 * An isolation probe's pod in the driver's release 2 shape (the header's; k8s.ts's header The pod): k8s.ts
 * isolationPodSpec's pod (its labels, egress mark, trial, spread, no DNS, the sandbox user, AUX limits) with `main`'s
 * PID 1 the shim (shimCommand `main`) and agent-bin read-only at AGENT_BIN_DIR, `stage` its init container on the agent
 * image (stageContainer: `main`'s resources, nothing staged, `--install` filling agent-bin), `watch` after `main`
 * (watchContainer: MAKEFUN_AGENT_CONTAINERS=main, its memory with the shim's), and agent-bin a volume. The agents read
 * their K from the pod's own Secret (isolationSecret). A SandboxError for an agent image not by digest or a peer not an IP.
 */
export function isolationAgentPodSpec(opts: IsolationAgentPodOptions): K8sObject {
  const agent = opts.agent;
  if (typeof agent?.image !== 'string' || !IMAGE_REF_RE.test(agent.image)) {
    throw new SandboxError(`isolation pod ${opts.name}: agent image ${JSON.stringify(agent?.image)} is not <image>@sha256:<64 hex>`);
  }
  const pod = isolationPodSpec({ ...opts, command: shimCommand(CONTAINER) });
  const spec = pod.spec as { containers: Array<Record<string, unknown>>; volumes?: Array<Record<string, unknown>>; initContainers?: unknown };
  const main = spec.containers[0]!;
  if (spec.containers.length !== 1 || main.name !== CONTAINER || spec.initContainers !== undefined) {
    throw new SandboxError(`isolation pod ${opts.name}: isolationPodSpec gave containers ${JSON.stringify(spec.containers.map((c) => c.name))}, not ${CONTAINER} alone`);
  }
  let watch: Record<string, unknown>;
  try {
    watch = watchContainer(agent, opts.name, [], [CONTAINER]);
  } catch (err) {
    throw new SandboxError(`isolation pod ${opts.name}: the agents' ${err instanceof Error ? err.message : String(err)}`);
  }
  main.volumeMounts = [...((main.volumeMounts as unknown[] | undefined) ?? []), { name: AGENT_BIN_VOLUME, mountPath: AGENT_BIN_DIR, readOnly: true }];
  spec.initContainers = [stageContainer(agent, opts.name, main.resources as Record<string, unknown>, [], true)];
  spec.containers = [main, watch];
  spec.volumes = [...(spec.volumes ?? []), agentBinVolume()];
  return pod;
}

/**
 * An isolation probe pod's Secret `<pod>-env` (k8s.ts sandboxEnvSecret, nothing of a spec's): the agents' K alone, a
 * fresh one, labelled as a program pod's Secret is (the grader's mark, makefun.pod=<pod>, its trial's makefun.net).
 */
export function isolationSecret(pod: string, opts: { namespace: string; trial: string | null }): K8sObject {
  const [graderKey, graderValue] = CONTAINER_LABEL.split('=') as [string, string];
  const labels: Record<string, string> = { [graderKey]: graderValue, [POD_LABEL]: pod, ...(opts.trial === null ? {} : { [NETWORK_LABEL]: labelValue(opts.trial, 'trial') }) };
  return sandboxEnvSecret({}, { name: pod, namespace: opts.namespace, labels });
}

/** Where one of the probe's pods ran, once Ready: its address and its node. */
interface Placed {
  ip: string;
  node: string;
}

/**
 * The cluster's verdict on keeping trials apart (the header's roles); a SandboxError when it could not find out, a
 * pair that did not connect among those. The probe trial's policy is made first, then the four pods booted at once
 * (bootProbePod), one that does not come up ending the others' boots; then the listener's and the peer's listeners
 * (listenIn), then each pod's address and node, then the reaches, every exec over its pod's `watch` session. Removes
 * what it made, whatever happens: the listeners' execs ended, the pods, their Secrets and the policy deleted, then the
 * sessions closed.
 */
export async function probeK8sIsolation(o: K8sIsolationOptions): Promise<DriverVerdict> {
  const ctx = o.ctx;
  const engine = await clusterEngine(ctx, o.placement.runtimeClass);
  await ensureEgressPolicy(ctx);
  if (o.agent === null) throw new SandboxError("the isolation probe's pods run the agent (stage, watch, main's shim), and no agent image is pinned or its peer is not known yet");
  const agent = o.agent;
  const trial = `isolation-${randomBytes(4).toString('hex')}`;
  const pods: Record<ProbeRole, string> = { listener: podName('isolation'), sibling: podName('isolation'), inside: podName('isolation'), peer: podName('isolation') };
  const roles = Object.entries(pods) as Array<[ProbeRole, string]>;
  const trialOf = (role: ProbeRole): string | null => (role === 'inside' || role === 'peer' ? trial : null);
  // Built before anything is made: a pod the agent spec cannot make fails the probe with nothing to delete.
  const objects = Object.fromEntries(
    roles.map(([role, name]) => {
      const onTrial = trialOf(role);
      const pod = isolationAgentPodSpec({ ...o.placement, name, image: o.image, digest: o.digest, trial: onTrial, egress: onTrial === null, agent, ...(onTrial === null ? {} : { apart: true }) });
      return [role, { pod, secret: isolationSecret(name, { namespace: ctx.namespace, trial: onTrial }) }] as const;
    }),
  ) as Record<ProbeRole, { pod: K8sObject; secret: K8sObject }>;
  const policy = trialPolicy(trial, { namespace: ctx.namespace, owner: null });
  const refs = [...roles.flatMap(([, pod]) => [`pod/${pod}`, `secret/${envSecretName(pod)}`]), `networkpolicy/${trialNetworkName(trial)}`];
  const cut = new AbortController();
  const sessions: PodAgentSession[] = [];
  const held: KubectlChild[] = [];
  try {
    // The policy before any pod of its trial (the header's: a fresh pod's first connect can get out before Ready).
    const made = await kubectl(ctx, KUBECTL_CREATE, { input: JSON.stringify(policy) });
    if (failed(made)) throw new SandboxError(`kubectl could not create the isolation probe's network policy ${policy.metadata.name}: ${why(made)}`);
    // When each pod came up (Ready, its `watch` agent answering, the shim gate passed): the pair's first connect is
    // timed from the last of its two and its peer's listening.
    const readyAt = {} as Record<ProbeRole, number>;
    const watch = {} as Record<ProbeRole, PodAgentSession>;
    const boots = await Promise.all(
      roles.map(async ([role]) => {
        const b = await bootProbePod(ctx, objects[role].pod, objects[role].secret, cut.signal);
        if (b.ok) {
          sessions.push(b.watch);
          watch[role] = b.watch;
          readyAt[role] = Date.now();
        } else if (!b.killed) cut.abort();
        return b;
      }),
    );
    for (const [i, b] of boots.entries()) {
      if (!b.ok && !b.killed) throw new SandboxError(`the isolation probe's ${roles[i]![0]} pod did not come up: ${b.error}`);
    }
    if (boots.some((b) => !b.ok)) throw new SandboxError("the isolation probe's pods were cut off while they came up");
    const up = o.listenerUpMs ?? ISOLATION_LISTENER_UP_MS;
    const [listening, peerListening] = await Promise.all([listenIn(watch.listener, pods.listener, 'listener', up, held), listenIn(watch.peer, pods.peer, 'peer', up, held)]);
    if (!listening.ok) throw new SandboxError(listening.error);
    if (!peerListening.ok) throw new SandboxError(peerListening.error);
    const placed = Object.fromEntries(await Promise.all(roles.map(async ([role, pod]) => [role, await placedOf(ctx, role, pod)] as const))) as Record<ProbeRole, Placed>;
    const ran = `the probe's pods ran on: ${roles.map(([role]) => `${role} ${placed[role].node}`).join(', ')}`;
    const ip = placed.listener.ip;
    const at = `${ip}:${SERVICE_PORT}`;
    const reach = (role: ProbeRole, host: string, port: number, what: string) => reachIn(watch[role], pods[role], host, port, o.probeMs, what);
    const fix = 'enforce NetworkPolicies on the cluster (k3s: its embedded network policy controller, never --disable-network-policy; or a CNI that enforces them) and apply deploy/k8s/sandbox/networkpolicies.yaml in the sandbox namespace (makefun-k8s.sh bootstrap on its overlay)';

    // The allowed pair first: until it has connected, no blocked reach below says anything about a policy.
    const { inside: from, peer: to } = placed;
    const across = from.node !== to.node;
    const pairAt = `${to.ip}:${SERVICE_PORT}`;
    const pairReadyAt = Math.max(readyAt.inside, readyAt.peer, peerListening.at);
    const dialAt = Date.now();
    const pair = await dialIn(watch.inside, pods.inside, to.ip, SERVICE_PORT, o.pairMs);
    if (!pair.reached) {
      const own = await reach('peer', to.ip, SERVICE_PORT, 'peer control');
      if (!own.reached) throw new SandboxError(`the isolation probe's peer did not answer at its own address ${pairAt} (${own.how}): its allowed pair proves nothing (${ran})`);
      const between = across ? `between nodes ${from.node} and ${to.node}` : `between pods on node ${from.node}`;
      throw new SandboxError(
        `the isolation probe's allowed pair did not connect: its inside pod on node ${from.node} did not reach its peer on node ${to.node} (${pairAt}), both on the probe trial's network, within ${o.pairMs} ms (${pair.how}, ${pair.attempts} attempts), though the peer answers at its own address, so routing ${between} failed and no blocked reach would prove a policy held: fix pod-to-pod routing ${between} (the CNI) (${ran})`,
      );
    }
    const afterReadyMs = Math.max(0, dialAt - pairReadyAt) + pair.ms;

    const control = await reach('listener', ip, SERVICE_PORT, 'control');
    if (!control.reached) throw new SandboxError(`the isolation probe's listener did not answer at its own address ${at} (${control.how}): the probe proves nothing`);
    const sibling = await reach('sibling', ip, SERVICE_PORT, 'sibling');
    if (sibling.reached) {
      return {
        enforced: false,
        driver: 'k8s',
        engine,
        fault: 'policy_not_enforced',
        reason: `a pod under ${EGRESS_POLICY} reached another (${at}), so concurrent trials' forwarders and gateways reach one another: the namespace's NetworkPolicies are not enforced (${ran})`,
        fix,
      };
    }
    const again = await reach('listener', ip, SERVICE_PORT, 'control');
    if (!again.reached) throw new SandboxError(`the isolation probe's listener stopped answering at ${at} (${again.how}): the sibling's result proves nothing`);
    const inside = await reach('inside', ip, SERVICE_PORT, 'inside');
    const world = inside.reached ? null : await reach('inside', o.world.host, o.world.port, 'inside');
    if (inside.reached || world?.reached === true) {
      const where = inside.reached ? `an egress pod (${at})` : `${o.world.host}:${o.world.port}`;
      return {
        enforced: false,
        driver: 'k8s',
        engine,
        fault: 'trial_pod_escapes',
        reason: `a pod on a trial's network (NetworkPolicy ${trialNetworkName(trial)}) reached ${where} past it, so a trial's entry is not kept to its trial (${ran})`,
        fix,
      };
    }
    const where = across ? `across nodes, ${from.node} to ${to.node}` : `on one node, ${from.node}`;
    // A pair that shared a node (its spread a preference: the other may have no room) proves no routing between nodes,
    // and the verdict stands on the reaches alone, saying so.
    const shared = across ? '' : `; the allowed pair shared node ${from.node}: routing between nodes not proven by this probe`;
    return {
      enforced: true,
      driver: 'k8s',
      engine,
      detail: `a pod on a trial's network reached another on it (${pairAt}, ${where}: its first connect at most ${afterReadyMs} ms after both were Ready and the peer listened, the dial's own ${pair.ms} ms in ${pair.attempts} attempts); an egress pod did not reach another (${at}: ${sibling.how}); a pod on a trial's network reached neither it (${inside.how}) nor ${o.world.host}:${o.world.port} (${world!.how})${shared}; ${ran}`,
    };
  } finally {
    cut.abort();
    for (const child of held) child.kill();
    await deleteObjects(ctx, refs);
    await Promise.allSettled(sessions.map((s) => s.close()));
  }
}

/** One probe pod's boot (bootProbePod): its `watch` agent's session once it is up, or why not (`killed`: the probe's own cut). */
type ProbeBoot = { ok: true; watch: PodAgentSession } | { ok: false; killed: boolean; error: string };

/**
 * One probe pod booted as a program pod is (the header's): k8s.ts bootToAgent (its Secret then the pod, its IP, its
 * `stage` agent's first answer; no init clock, as a warm pool's refill: the probe's pods are no spawn's), its `stage`
 * released with nothing staged (releaseStage), then k8s.ts bootFromAgent (Ready, its `watch` agent dialled, the shim
 * gate), within ctx.readyTimeoutMs from its create. `signal` cuts it (another pod of the probe did not come up). The
 * caller deletes what it made, and closes the session it is handed.
 */
async function bootProbePod(ctx: K8sContext, pod: K8sObject, secret: K8sObject, signal: AbortSignal): Promise<ProbeBoot> {
  const name = pod.metadata.name;
  const killed = (): boolean => signal.aborted;
  const cutOff: ProbeBoot = { ok: false, killed: true, error: `pod ${name} was cut off` };
  const reached = await bootToAgent(ctx, { name, objects: [pod], secret, trees: [], signal, killed, init: null });
  if (!reached.ok) return reached.killed ? cutOff : { ok: false, killed: false, error: reached.error };
  const stage = reached.stage;
  if (stage === null) return { ok: false, killed: false, error: `pod ${name}: no ${STAGE_CONTAINER} agent session to release it over` };
  const unreleased = await releaseStage(stage, name, Math.max(1, ctx.readyTimeoutMs - (Date.now() - reached.createdAt)), signal);
  void stage.close();
  if (killed()) return cutOff;
  if (unreleased !== null) return { ok: false, killed: false, error: unreleased };
  const booted = await bootFromAgent(ctx, { ...reached, stage: null }, { trees: null, signal, killed });
  if (!booted.ok) return booted.killed ? cutOff : { ok: false, killed: false, error: booted.error };
  if (booted.watch === null) return { ok: false, killed: false, error: `pod ${name} came up with no ${WATCH_CONTAINER} agent to exec over` };
  return { ok: true, watch: booted.watch };
}

/**
 * The release of a probe pod's `stage` with nothing staged: one exec over its `stage` session, k8s.ts stageCommand around
 * `true` (STAGE_EXEC_SCRIPT: the arrival, then the release every STAGE_RELEASE_EVERY_MS until `stage` is gone), which
 * ends as `stage` does under it. Null once it has ended so (the Ready wait after it is the verdict on the release);
 * else why not: never sent, its release exiting non-zero, or no end within `budgetMs` (it is cut).
 */
async function releaseStage(stage: PodAgentSession, pod: string, budgetMs: number, signal: AbortSignal): Promise<string | null> {
  const child = stage.stream(STAGE_CONTAINER, stageCommand(['true']));
  // Its open settles before its end (agent-client.ts): a release that opened ends with `stage`, no exit trailer, its
  // normal end (released(), as the staging's); one that never opened says why.
  const open: { why: string | null } = { why: null };
  child.opened.then(
    () => child.released?.(),
    (err: unknown) => {
      open.why = err instanceof Error ? err.message : String(err);
    },
  );
  const end = await endOf(child, budgetMs, signal);
  if (open.why !== null) return `pod ${pod}: its ${STAGE_CONTAINER}'s release could not be sent: ${open.why}`;
  if (end.cut !== null) return `pod ${pod}: its ${STAGE_CONTAINER} was not released: ${end.cut}`;
  if (end.end.code !== null && end.end.code !== 0) return `pod ${pod}: its ${STAGE_CONTAINER}'s release exited ${end.end.code}${end.stderr === '' ? '' : ` (${end.stderr})`}`;
  return null;
}

/**
 * `child` (an exec just made, its stdin closed here) to its end, its stdout drained and its stderr kept (the first 500
 * characters), killed at `budgetMs` or once `signal` aborts (`cut` then says which).
 */
async function endOf(child: KubectlChild, budgetMs: number, signal: AbortSignal): Promise<{ end: KubectlEnd; cut: string | null; stderr: string }> {
  let stderr = '';
  child.stdin.on('error', () => undefined);
  child.stdin.end();
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  child.stdout.resume();
  child.stderr.on('data', (b: Buffer) => {
    if (stderr.length < 500) stderr = (stderr + b.toString('utf8')).slice(0, 500);
  });
  let cut: string | null = null;
  const stop = (why: string): void => {
    cut ??= why;
    child.kill();
  };
  const timer = setTimeout(() => stop(`no end within ${budgetMs} ms`), budgetMs);
  const onAbort = (): void => stop('cut off');
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const end = await child.closed;
  clearTimeout(timer);
  signal.removeEventListener('abort', onAbort);
  return { end, cut, stderr: stderr.trim() };
}

/** A listener's exec, once it listens (`at`: when the driver read its ISOLATION_LISTENING), or why it did not. */
type Listening = { ok: true; at: number } | { ok: false; error: string };

/**
 * The listener in `pod` (the listener's or the peer's, `role`): ISOLATION_LISTENER_POD_SCRIPT for ISOLATION_LISTENER_S,
 * one exec into `main` over its `watch` session, held open (`held`: the probe ends it) once its stdout says
 * ISOLATION_LISTENING within `budgetMs`. Never rejects: an exec that ends first, or does not say it in time (then
 * killed), is the probe's failure in its words.
 */
async function listenIn(watch: PodAgentSession, pod: string, role: 'listener' | 'peer', budgetMs: number, held: KubectlChild[]): Promise<Listening> {
  const child = agentMember(watch, pod, CONTAINER).stream(['node', '-e', ISOLATION_LISTENER_POD_SCRIPT, String(ISOLATION_LISTENER_S)]);
  held.push(child);
  child.stdin.on('error', () => undefined);
  child.stdin.end();
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  let out = '';
  let stderr = '';
  child.stderr.on('data', (b: Buffer) => {
    if (stderr.length < 500) stderr = (stderr + b.toString('utf8')).slice(0, 500);
  });
  const what = `the isolation probe's ${role} (${pod})`;
  return await new Promise<Listening>((resolve) => {
    let settled = false;
    const settle = (l: Listening): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(l);
    };
    const timer = setTimeout(() => {
      settle({ ok: false, error: `${what} did not say it listens on ${SERVICE_PORT} within ${budgetMs} ms${stderr === '' ? '' : ` (${stderr.trim()})`}` });
      child.kill();
    }, budgetMs);
    child.stdout.on('data', (b: Buffer) => {
      if (settled) return;
      out = (out + b.toString('utf8')).slice(-200);
      if (out.split('\n').slice(0, -1).includes(ISOLATION_LISTENING)) settle({ ok: true, at: Date.now() });
    });
    void child.closed.then((end) => {
      const how = end.error ?? (end.signal === null ? `exit ${end.code}` : `ended by ${end.signal}`);
      settle({ ok: false, error: `${what} ended before it listened on ${SERVICE_PORT} (${how})${stderr === '' ? '' : `: ${stderr.trim()}`}` });
    });
  });
}

/**
 * The exec of `script` (`node -e`, argv: host, port, ms) in pod `pod`'s `main`, over its `watch` session (k8s.ts
 * agentMember), cut ISOLATION_EXEC_SLACK_MS past `ms`; `what` names it in a SandboxError when it did not run.
 */
async function probeExec(watch: PodAgentSession, pod: string, script: string, host: string, port: number, ms: number, what: string): Promise<KubectlResult> {
  const r = await agentMember(watch, pod, CONTAINER).run(['node', '-e', script, host, String(port), String(ms)], { timeoutMs: ms + ISOLATION_EXEC_SLACK_MS });
  if (failed(r)) throw new SandboxError(`the isolation probe's ${what} did not run: ${why(r)}`);
  return r;
}

/** One reach of the probe, by exec in `pod` (ISOLATION_REACH_SCRIPT): what it found, or a SandboxError when it did not run. */
async function reachIn(watch: PodAgentSession, pod: string, host: string, port: number, ms: number, what: string): Promise<Reach> {
  return readReach((await probeExec(watch, pod, ISOLATION_REACH_SCRIPT, host, port, ms, what)).stdout, what);
}

/** The allowed pair's dial, by exec in `pod` (ISOLATION_PAIR_SCRIPT): what it found, or a SandboxError when it did not run. */
async function dialIn(watch: PodAgentSession, pod: string, host: string, port: number, ms: number): Promise<PairDial> {
  return readPairDial((await probeExec(watch, pod, ISOLATION_PAIR_SCRIPT, host, port, ms, 'allowed pair')).stdout);
}

/** The pair's dial line (its stdout's last): SandboxError when it printed anything else. */
export function readPairDial(stdout: string): PairDial {
  let doc: Partial<PairDial> | null = null;
  try {
    doc = JSON.parse(lines(stdout).at(-1) ?? '') as Partial<PairDial> | null;
  } catch {
    doc = null;
  }
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (doc === null || typeof doc !== 'object' || typeof doc.reached !== 'boolean' || typeof doc.how !== 'string' || !count(doc.ms) || !count(doc.attempts)) {
    throw new SandboxError(`the isolation probe's allowed pair printed ${JSON.stringify(stdout.slice(0, 200))}, not what it found`);
  }
  return { reached: doc.reached, how: doc.how, ms: doc.ms, attempts: doc.attempts };
}

/** A probe pod's address and node, once Ready. */
async function placedOf(ctx: K8sContext, role: ProbeRole, pod: string): Promise<Placed> {
  const read = await readPod(ctx, pod);
  const ip = 'pod' in read ? read.pod.status?.podIP : undefined;
  const node = 'pod' in read ? read.pod.spec?.nodeName : undefined;
  const said = 'pod' in read ? 'none in its status' : 'gone' in read ? read.gone : read.error;
  if (typeof ip !== 'string' || ip === '') throw new SandboxError(`the isolation probe's ${role} pod ${pod} is ready without an IP (${said})`);
  if (typeof node !== 'string' || node === '') throw new SandboxError(`the isolation probe's ${role} pod ${pod} is ready without a node (${'pod' in read ? 'none in its spec' : said})`);
  return { ip, node };
}

/** What the verdict calls the cluster: its server version and the pods' RuntimeClass. */
async function clusterEngine(ctx: K8sContext, runtimeClass: string | null): Promise<string> {
  const r = await kubectl(ctx, ['version', '-o', 'json']);
  let version: unknown;
  try {
    version = (JSON.parse(r.stdout) as { serverVersion?: { gitVersion?: unknown } }).serverVersion?.gitVersion;
  } catch {
    version = undefined;
  }
  if (failed(r) || typeof version !== 'string') throw new SandboxError(`kubectl version gave no server version: ${failed(r) ? why(r) : JSON.stringify(r.stdout.slice(0, 200))}`);
  return `${version}, RuntimeClass ${runtimeClass ?? 'none'}`;
}

/** Each `kind/name` kubectl printed into the result: pods as containers, policies as networks. */
function record(res: { containers: string[]; networks: string[] }, refs: readonly string[]): void {
  for (const ref of refs) {
    const slash = ref.indexOf('/');
    const [kind, name] = [ref.slice(0, slash), ref.slice(slash + 1)];
    if (slash < 0 || name === '') continue;
    if (kind === 'pod' && !res.containers.includes(name)) res.containers.push(name);
    else if (kind === POLICY_RESOURCE && !res.networks.includes(name)) res.networks.push(name);
  }
}

/** sweepStale's list (STALE_LIST_JSONPATH's lines) read: each object's kind, name, creation time ('' for none) and whether it is being deleted. */
function staleListed(stdout: string): Array<{ kind: string; name: string; created: string; deleting: boolean }> {
  const out: Array<{ kind: string; name: string; created: string; deleting: boolean }> = [];
  for (const line of lines(stdout)) {
    const [ref = '', created = '', deleting = ''] = line.split(' ', 3);
    const slash = ref.indexOf('/');
    if (slash <= 0 || slash === ref.length - 1) continue;
    out.push({ kind: ref.slice(0, slash), name: ref.slice(slash + 1), created, deleting: deleting !== '' });
  }
  return out;
}

/**
 * Of reap's list (REAP_LIST_JSONPATH's lines, `<kind>/<name>[ <deletionTimestamp>]`), each pod or policy not being
 * deleted, named as `kubectl -o name` prints it (`pod/<name>`, `networkpolicy.networking.k8s.io/<name>`).
 */
function notBeingDeleted(stdout: string): string[] {
  const left: string[] = [];
  for (const line of lines(stdout)) {
    const [ref = '', deleting = ''] = line.split(/\s+/, 2);
    const slash = ref.indexOf('/');
    const [kind, name] = [ref.slice(0, slash), ref.slice(slash + 1)];
    if (slash < 0 || name === '' || deleting !== '') continue;
    left.push(kind === 'Pod' ? `pod/${name}` : kind === 'NetworkPolicy' ? `${POLICY_RESOURCE}/${name}` : ref);
  }
  return left;
}

/** The sandbox pods (POD_PREFIX) among `kubectl delete -o name`'s lines (`pod/<name>`): whose env Secrets go with them. */
function sandboxPodsOf(refs: readonly string[]): string[] {
  return refs.filter((r) => r.startsWith('pod/') && r.slice(4).startsWith(POD_PREFIX)).map((r) => r.slice(4));
}

function failed(r: KubectlResult): boolean {
  return r.code !== 0 || r.error !== undefined;
}

function lines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}
