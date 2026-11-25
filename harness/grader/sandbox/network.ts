// An agent trial's networks (docker driver). The entry reaches exactly two services, the store env
// and the LLM forwarder, and only the forwarder reaches past them (#1268 measured this on Docker 29.x):
//
//   per trial   docker network create --internal --ipv6=false
//                 -o com.docker.network.bridge.inhibit_ipv4=true
//                 --label makefun.grader=1 --label makefun.net=<trial>
//                 [--label makefun.trial=<owner>] makefun-net-<trial>
//   per host    docker network create --driver bridge --ipv6=false
//                 -o com.docker.network.bridge.enable_icc=false
//                 --label makefun.grader=1 --label makefun.egress=1 makefun-egress
//
// `--internal` gives the trial's containers no route off their network, and Docker's embedded DNS
// answers only the network's own names there (external names fail on 29.x; the integration test
// tests/integration/sandbox-egress.test.ts pins both). inhibit_ipv4 leaves the bridge itself without
// an address: on Linux a container on a plain --internal network still reaches every host service
// listening on 0.0.0.0 through the bridge's gateway IP, and with no address there is no gateway to
// reach. IPv6 is off on both networks, explicitly, whatever the daemon's default-network-opts say.
// The egress bridge is the plain kind with outbound NAT; enable_icc=false keeps the forwarders of
// concurrent trials from reaching one another across it.
//
// The three containers of a trial (trialAttachment), each with docker.ts's hardened flag set
// unchanged (--cap-drop ALL, no-new-privileges, --read-only, --tmpfs /tmp, -u 65534:65534,
// --pull missing, the pinned digest, --log-driver none):
//
//   entry       the trial network only, alias `agent`; the competition's limits
//   env         the trial network only, alias `store`; ENV_LIMITS
//   forwarder   the trial network with alias `llm`, then the egress bridge; SERVICE_LIMITS
//
// and a fourth when the competition has a target (contracts/competition.ts AgentTarget):
//
//   house       the house lane's forwarder: the trial network with alias `house`, then the egress
//               bridge; SERVICE_LIMITS
//
// The trial network leaves inter-container traffic at docker's default (on), so every role reaches
// every other's alias: the forwarders tell their callers apart by a credential
// (grader/gateway/server.ts GatewayClient), not by address.
//
// Services listen on 0.0.0.0:8080 in their container, never on `localhost` (Node resolves it to ::1
// first, which no other container reaches). The process driver shares the host's loopback: there
// they listen on 127.0.0.1 ports the harness picks (serviceEndpoint, freeLoopbackPort).
//
// A scrape trial (scrape/v1) has two containers on a trial network made the same way
// (scrapeAttachment):
//
//   gateway     the trial network under one alias per listed host (`apis.roblox.com`, ...), then the
//               egress bridge: the recording TLS gateway, docker.ts's hardened set, listening on
//               0.0.0.0:443 as 65534 with no capability
//   entry       the trial network only, alias `agent`, under the house launcher (docker.ts, a spec
//               with a `launcher`: root with SETUID/SETGID/KILL, --dns-opt ndots:0, the house at
//               /house); the competition's limits
//
// The entry reaches the real hosts' names only, and they lead to the gateway. #2208 measured it on
// Docker Desktop 4.96.3 (Engine 29.9.2) in the pinned node22 and python3.13 images: from a container
// on such a network, both aliases of the gateway resolve through getaddrinfo, dns.resolve4 and
// Python's getaddrinfo to the gateway's IPv4 address alone (AAAA: NODATA; an AF_INET6 lookup: none),
// and any other name fails (SERVFAIL, EAI_AGAIN); the gateway, as 65534 with --cap-drop ALL, binds
// 0.0.0.0:443 with no sysctl (moby opens the unprivileged ports per network namespace); the entry
// trusts the heat CA through NODE_EXTRA_CA_CERTS (fetch, https, http2) and SSL_CERT_FILE (urllib)
// alone, so no system bundle is bind-mounted; Python 3.13's default context (VERIFY_X509_STRICT)
// refuses a leaf without an Authority Key Identifier. --dns-opt ndots:0 lands in resolv.conf
// (`options ndots:0`), which Docker writes there anyway on an internal network.
//
// Under gVisor's own network stack (docker.ts NETSTACK_RUNTIME) that embedded DNS never answers inside
// the sandbox, so the networks above stay as they are and every container on a trial network gets an
// address of its own there and the names of the containers spawned before it in /etc/hosts (docker.ts
// NetstackNames): the entry finds `store` and `llm`, or each of the gateway's hosts, through
// getaddrinfo as above, while dns.resolve4, a DNS query that reads no /etc/hosts, is refused, and any
// other name fails as before.
//
// Cleanup: removeTrialNetwork removes whatever is still attached to the trial's network, then the
// network (idempotent). A grader that dies mid-pass removes nothing: its trial's containers keep
// running (a container outlives a killed `docker run` client) on a network named for that pass alone.
// A pass that names its owner (agent.ts RunTrialOptions.owner) labels its network
// makefun.trial=<owner>, and reapTrial, before the trial's next pass makes its own (the job's retry,
// the replay that picks the trial up, a rerun), removes every network carrying exactly that label and
// each grader container still on one, and names them. Every agent trial path names one, each trial's
// passes running one at a time under it: the pipeline's trial `<run id>.<trial index>` (worker.ts
// trialOwner), an L2 regrade's replay `regrade-<job id>.<trial index>` (worker.ts regradeOwner,
// regrade.ts regradeTrialOwner), grade-local's `local-<16 hex>.<trial index>` (cli/grade-local.ts
// localTrialOwner) and the pilot's `pilot-<agent>-r<repeat>.<t>` (scripts/agent/pilot.ts pilotOwner).
// Never another trial's: docker's label filter matches the whole value, each network's value is
// checked again, and a container is taken only off such a network. sweepStale, at a grader's start,
// removes grader containers and trial networks older than six hours (what a crashed worker left that
// no resume reaped: a pass with no owner, a trial never resumed). The egress bridge carries no
// makefun.net label and is never swept.
//
// A race's racer (types.ts's header, docker.ts's: one container for a whole race window, far past six
// hours) carries no makefun.grader label, so sweepStale never takes it, and no trial network, so no reap
// does: it is left to its own deadline, the makefun.race=<epoch ms> label docker.ts gives it, and
// sweepExpiredRaces (TrialNetworks.sweepRaces) removes every race container past that deadline (what a
// racer that died left of its bot), nothing before it and nothing else.
//
// Isolation (probeIsolation, EngineIsolation): enable_icc=false is a rule the daemon writes into
// iptables, and only bridged traffic that passes through iptables meets it. A Linux daemon run with
// iptables off ("iptables": false in daemon.json, dockerd --iptables=false), or one whose bridged
// traffic skips iptables (br_netfilter not loaded), makes the egress bridge with the option and
// enforces nothing: every container on it reaches every other, the forwarders of concurrent trials
// included. `docker info` does not tell (Docker 29.6.1 run with "iptables": false still reports its
// FirewallBackend as iptables), so probeIsolation asks the bridge itself, in containers of the pinned
// node22 image under the hardened flags and SERVICE_LIMITS (isolationRunArgs):
//
//   listener   makefun-isolation-<hex>, on the egress bridge, listening on 0.0.0.0:8080; it exits
//              by itself after ISOLATION_LISTENER_S
//   control    `docker exec` in the listener, before the sibling and after it: it must reach its own
//              address there both times, else the sibling's miss proves nothing and the probe throws
//   sibling    on the egress bridge: it must not reach the listener's address (enable_icc=false)
//   inside     on an internal network made as a trial's (isolation-<hex>): no default route, and the
//              listener's address out of its reach
//
// An internal network keeps a trial's containers in by giving them no route out (and inhibit_ipv4
// the host no address on it), which no iptables rule makes; `inside` checks that on this engine all
// the same. Docker Desktop's VM runs its daemon with iptables on and passes; s4's daemon ("iptables":
// false) fails `sibling` and passes `inside` (#1312; both measured 2026-10-29). A refusal
// (IsolationRefusal) names what is not enforced, the engine by its driver (a verdict's `driver`:
// docker's names none, k8s-network.ts's says k8s), and the setting that fixes it. EngineIsolation keeps
// the verdict for the process (engineIsolation: one per docker CLI, runtime and image): one that
// holds for good, a refusal for ISOLATION_RECHECK_MS (the trials run once the daemon is mended, with
// no restart), a probe that could not finish (the daemon down, the image absent: a SandboxError) for
// nothing.
//
// The k8s driver's `pod` layout (grader/sandbox/layout.ts; k8s.ts's header, Two layouts) is beside all of this, not in
// it: there an agent trial's entry and env are two containers of one gVisor pod, on its own loopback, with no trial
// network, and the forwarders (SERVICE_LIMITS' caps carried over as a lane's: server/sandbox-host/protocol.ts LANE_PROCS
// and LANE_HEAP_MB) run as lanes in the grader's lanes pod, reached through its door. What shares a sandbox there,
// plainly: the env's hidden state (/env-data, /state, its memory) and the house token with the entrant's code, the
// network namespace (loopback ports, abstract unix sockets) and the CPU and memory totals shared outright, weaker than
// the env's container of its own here; and a grader's lanes with one another (their kernel, loopback, egress, CPU and
// memory total and root program), weaker than a forwarder's sandbox of its own. The docker and process drivers have no
// `pod` layout: every trial they run is as this header says.
//
// The harnesses reach these through the driver's TrialNetworks (types.ts Sandbox.networks):
// dockerTrialNetworks is the docker driver's, on one CLI (DockerSandbox.networks, on its own),
// k8s-network.ts's K8sTrialNetworks the k8s driver's (NetworkPolicies, its probe cached by an
// EngineIsolation too), and isolationCheck makes an IsolationCheck of any driver's.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { IMAGES, imageFor, imageRef, type ImageTableT } from '../images.ts';
import { CONTAINER_LABEL, containerName, dockerCliEnv, NOBODY, PULL_POLICY, RACE_LABEL } from './docker.ts';
import {
  checkHostName,
  containerized,
  EGRESS_NETWORK,
  SandboxError,
  TRIAL_NETWORK_PREFIX,
  TRIAL_RE,
  type IsolationFault,
  type IsolationVerdict,
  type ReapResult,
  type Sandbox,
  type SandboxLimits,
  type SandboxNetwork,
  type SweepResult,
  type TrialNetworks,
} from './types.ts';

export type { IsolationFault, IsolationVerdict, ReapResult, SweepResult } from './types.ts';

/** The label key naming a trial network's trial (`makefun.net=<trial>`); the sweep's mark. */
export const NETWORK_LABEL = 'makefun.net';
/** The egress bridge's own label (it carries no NETWORK_LABEL, so the sweep never takes it). */
export const EGRESS_LABEL = 'makefun.egress=1';
/** The label key naming whose trial a pass's network is (`makefun.trial=<owner>`): what reapTrial finds a dead grader's leftovers by. */
export const OWNER_LABEL = 'makefun.trial';
/**
 * A trial's owner, the OWNER_LABEL value: lowercase [a-z0-9._-], at most 128 characters (the pipeline's `<run id>.<trial index>`;
 * the header's Cleanup names every path's; a scrape trial's `scrape-<heat>.<entry>.<round>` runs past 63). A docker label takes it
 * whole; a Kubernetes label value is at most 63 characters, so the k8s driver labels by k8s.ts ownerLabel of it.
 */
export const TRIAL_OWNER_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** How often reapTrial lists and removes a network's containers before it gives up on the network (a dead grader's `docker run` client may still add one). */
export const REAP_ROUNDS = 3;
/** What sweepStale treats as left behind: older than this. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** Each docker CLI call's budget. */
export const DOCKER_CLI_TIMEOUT_MS = 60_000;

/** The port a trial's services listen on inside their containers. */
export const SERVICE_PORT = 8080;
/** The port a scrape trial's gateway listens on in its container (the real hosts' HTTPS port: scrape/trial.ts). */
export const SCRAPE_GATEWAY_PORT = 443;
/**
 * The forwarder containers' fixed limits (the entry runs under the competition's). A `pod`-layout lane's caps follow
 * them (server/sandbox-host/protocol.ts: LANE_PROCS is pids, LANE_HEAP_MB three quarters of memory_mb), and
 * tests/unit/sandbox-host.test.ts holds the pairs together.
 */
export const SERVICE_LIMITS: Readonly<SandboxLimits> = Object.freeze({ cpus: 0.5, memory_mb: 256, pids: 64 });
/**
 * The env container's fixed limits: two CPUs, since an env may compute the house side in-process (tiny-chess-01's
 * engines). At one, gVisor's threads and node's GC helpers throttled it in 85-95% of periods in production; a gVisor
 * bench of the same moves at two cut the slowdown 1.13x->1.07x idle (throttled 1099/1105->0/1044), 1.40x->1.22x loaded.
 * A ceiling: agent.ts spawns it with cpusCeiling, so docker grants at most the host's CPUs; a pod's limit is 2000m on any
 * node and its request stays k8s.ts CPU_REQUEST_MAX_MILLI (250m). An entrant keeps exactly its contest's limits.
 */
export const ENV_LIMITS: Readonly<SandboxLimits> = Object.freeze({ cpus: 2, memory_mb: 256, pids: 64 });
/** The alias each container of a trial is reached by on the trial network (`house`: the house lane's forwarder, a trial with a target only). */
export const ROLE_ALIASES = Object.freeze({ entry: 'agent', env: 'store', forwarder: 'llm', house: 'house' } as const);
export type TrialRole = keyof typeof ROLE_ALIASES;
/** The roles that forward to the LLM gateway: on the egress bridge as well as the trial network. */
export const FORWARDER_ROLES: readonly TrialRole[] = Object.freeze(['forwarder', 'house'] as const);

/** One docker CLI call's outcome. `error` is set when it could not run or was cut off. */
export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Runs the docker CLI with an argv (no leading `docker`). */
export type DockerExec = (args: readonly string[]) => Promise<DockerResult>;

export interface NetworkOptions {
  /** The docker CLI (default `docker`); ignored when `exec` is given. */
  docker?: string;
  /** How to run it (default dockerExec(docker)); tests pass a fake. */
  exec?: DockerExec;
}

/** The docker CLI as a DockerExec: the host's PATH and DOCKER_* only, cut off after `timeoutMs`. */
export function dockerExec(docker = 'docker', timeoutMs = DOCKER_CLI_TIMEOUT_MS): DockerExec {
  return (args) =>
    new Promise<DockerResult>((resolve) => {
      const child = spawn(docker, args, { stdio: ['ignore', 'pipe', 'pipe'], env: dockerCliEnv() });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.stderr.on('data', (b: Buffer) => err.push(b));
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      timer.unref();
      child.once('error', (e) => {
        clearTimeout(timer);
        resolve({ code: null, stdout: '', stderr: '', error: `docker: ${e.message}` });
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        const res: DockerResult = { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
        if (signal !== null) res.error = `docker ${args.slice(0, 2).join(' ')} killed by ${signal} (after ${timeoutMs} ms)`;
        resolve(res);
      });
    });
}

function execOf(opts: NetworkOptions): DockerExec {
  return opts.exec ?? dockerExec(opts.docker ?? 'docker');
}

function why(r: DockerResult): string {
  return (r.error ?? r.stderr.trim().split('\n')[0] ?? '').trim() || `exit ${r.code}`;
}

function lines(s: string): string[] {
  return s.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

const NOT_FOUND_RE = /not found|no such network/i;

/** The trial's network name, `makefun-net-<trial>`; a trial is lowercase [a-z0-9-], at most 41 characters. */
export function trialNetworkName(trial: string): string {
  if (!TRIAL_RE.test(trial)) throw new SandboxError(`trial ${JSON.stringify(trial)} must be lowercase [a-z0-9-], at most 41 characters`);
  return `${TRIAL_NETWORK_PREFIX}${trial}`;
}

/** The owner, checked as a docker label value (TRIAL_OWNER_RE; the k8s driver's label is k8s.ts ownerLabel of it). */
export function checkTrialOwner(owner: string): string {
  if (typeof owner !== 'string' || !TRIAL_OWNER_RE.test(owner)) throw new SandboxError(`trial owner ${JSON.stringify(owner)} must be lowercase [a-z0-9._-], at most 128 characters`);
  return owner;
}

/**
 * `docker network create` argv (no leading `docker`) for a trial's internal network: pure, unit-tested
 * exactly. With an owner it also carries makefun.trial=<owner> (the header's Cleanup).
 */
export function trialNetworkCreateArgs(trial: string, owner: string | null = null): string[] {
  const name = trialNetworkName(trial);
  return [
    'network', 'create',
    '--internal',
    '--ipv6=false',
    '-o', 'com.docker.network.bridge.inhibit_ipv4=true',
    '--label', CONTAINER_LABEL,
    '--label', `${NETWORK_LABEL}=${trial}`,
    ...(owner === null ? [] : ['--label', `${OWNER_LABEL}=${checkTrialOwner(owner)}`]),
    name,
  ];
}

/** `docker network create` argv (no leading `docker`) for the host's egress bridge. */
export function egressNetworkCreateArgs(): string[] {
  return [
    'network', 'create',
    '--driver', 'bridge',
    '--ipv6=false',
    '-o', 'com.docker.network.bridge.enable_icc=false',
    '--label', CONTAINER_LABEL,
    '--label', EGRESS_LABEL,
    EGRESS_NETWORK,
  ];
}

/** Where a container of the trial sits: the trial network under its role's alias, a forwarder (FORWARDER_ROLES) also on the egress bridge. */
export function trialAttachment(trial: string, role: TrialRole): SandboxNetwork {
  const name = trialNetworkName(trial);
  return FORWARDER_ROLES.includes(role) ? { name, aliases: [ROLE_ALIASES[role]], egress: true } : { name, aliases: [ROLE_ALIASES[role]] };
}

/** A scrape trial's two containers (the header's scrape trial). */
export const SCRAPE_ROLES = Object.freeze(['gateway', 'entry'] as const);
export type ScrapeRole = (typeof SCRAPE_ROLES)[number];

/**
 * Where a container of a scrape trial sits: the gateway on the trial network under one alias per
 * host (`hosts`: one or more dotted lowercase DNS names, no repeats), then the egress bridge; the
 * entry on the trial network only, as `agent`. The hosts are checked whichever the role.
 */
export function scrapeAttachment(trial: string, role: ScrapeRole, hosts: readonly string[]): SandboxNetwork {
  const name = trialNetworkName(trial);
  if (!Array.isArray(hosts) || hosts.length === 0) throw new SandboxError(`a scrape trial needs one host or more, not ${JSON.stringify(hosts)}`);
  for (const h of hosts) checkHostName(h);
  if (new Set(hosts).size !== hosts.length) throw new SandboxError(`scrape hosts ${JSON.stringify(hosts)} repeat`);
  if (role === 'gateway') return { name, hosts: [...hosts], egress: true };
  if (role === 'entry') return { name, aliases: [ROLE_ALIASES.entry] };
  throw new SandboxError(`scrape role ${JSON.stringify(role)} is not one of ${SCRAPE_ROLES.join(', ')}`);
}

/** Where a trial service listens, and the origin the trial's other programs reach it at. */
export interface ServiceEndpoint {
  host: string;
  port: number;
  origin: string;
}

/**
 * A service's endpoint under a driver: in a container it listens on 0.0.0.0:8080 and is reached by
 * its alias (`http://store:8080`); under the process driver it listens on 127.0.0.1:<loopbackPort>
 * and is reached there.
 */
export function serviceEndpoint(kind: Sandbox['kind'], role: Exclude<TrialRole, 'entry'>, loopbackPort?: number): ServiceEndpoint {
  if (containerized(kind)) return { host: '0.0.0.0', port: SERVICE_PORT, origin: `http://${ROLE_ALIASES[role]}:${SERVICE_PORT}` };
  if (loopbackPort === undefined || !Number.isSafeInteger(loopbackPort) || loopbackPort < 1 || loopbackPort > 65535) {
    throw new SandboxError(`the process driver needs a loopback port for the ${role} service, not ${loopbackPort}`);
  }
  return { host: '127.0.0.1', port: loopbackPort, origin: `http://127.0.0.1:${loopbackPort}` };
}

/** A loopback port free right now (the process driver's services; another process may still take it). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr !== null && typeof addr === 'object' ? resolve(addr.port) : reject(new SandboxError('no loopback port'))));
    });
  });
}

/** What a refused create of a trial network that exists says besides the engine's error (every driver's). */
export const NETWORK_EXISTS_HINT = ' (a trial still running, or one a crash left: removeTrialNetwork it first)';

export interface TrialNetworkOptions extends NetworkOptions {
  /** Whose trial it is (makefun.trial=<owner>, what reapTrial finds it by); null or absent: no owner label. */
  owner?: string | null;
}

/**
 * Create the trial's internal network and return its name. Refuses one that already exists (a trial
 * still running, or what a crash left: removeTrialNetwork it first).
 */
export async function createTrialNetwork(trial: string, opts: TrialNetworkOptions = {}): Promise<string> {
  const args = trialNetworkCreateArgs(trial, opts.owner ?? null);
  const name = args.at(-1)!;
  const r = await execOf(opts)(args);
  if (r.code !== 0) {
    const hint = /already exists/i.test(r.stderr) ? NETWORK_EXISTS_HINT : '';
    throw new SandboxError(`docker could not create network ${name}: ${why(r)}${hint}`);
  }
  return name;
}

interface InspectedNetwork {
  Name?: string;
  Driver?: string;
  Internal?: boolean;
  Labels?: Record<string, string> | null;
  Options?: Record<string, string> | null;
}

async function inspectNetwork(exec: DockerExec, name: string): Promise<InspectedNetwork | null> {
  const r = await exec(['network', 'inspect', '--format', '{{json .}}', name]);
  if (r.code !== 0) {
    if (r.error === undefined && NOT_FOUND_RE.test(r.stderr)) return null;
    throw new SandboxError(`docker could not inspect network ${name}: ${why(r)}`);
  }
  try {
    return JSON.parse(r.stdout) as InspectedNetwork;
  } catch {
    throw new SandboxError(`docker network inspect ${name} printed no JSON: ${r.stdout.slice(0, 200)}`);
  }
}

function checkEgress(net: InspectedNetwork): void {
  const [key, value] = EGRESS_LABEL.split('=') as [string, string];
  if (net.Driver !== 'bridge' || net.Internal !== false || net.Labels?.[key] !== value) {
    throw new SandboxError(
      `network ${EGRESS_NETWORK} exists but is not the grader's egress bridge (driver ${net.Driver}, internal ${net.Internal}, labels ${JSON.stringify(net.Labels ?? {})}): remove it or let the grader create it`,
    );
  }
}

/** Make sure the host's egress bridge exists (created once per host, kept); returns its name. */
export async function ensureEgressNetwork(opts: NetworkOptions = {}): Promise<string> {
  const exec = execOf(opts);
  const found = await inspectNetwork(exec, EGRESS_NETWORK);
  if (found !== null) {
    checkEgress(found);
    return EGRESS_NETWORK;
  }
  const r = await exec(egressNetworkCreateArgs());
  if (r.code !== 0) {
    // Another grader on this host created it first.
    const raced = /already exists/i.test(r.stderr) ? await inspectNetwork(exec, EGRESS_NETWORK) : null;
    if (raced === null) throw new SandboxError(`docker could not create network ${EGRESS_NETWORK}: ${why(r)}`);
    checkEgress(raced);
  }
  return EGRESS_NETWORK;
}

/**
 * Remove the trial's network: first every container still attached to it (the harness kills its own;
 * this is the backstop), then the network. A network already gone is fine.
 */
export async function removeTrialNetwork(trial: string, opts: NetworkOptions = {}): Promise<void> {
  const name = trialNetworkName(trial);
  const exec = execOf(opts);
  const ps = await exec(['ps', '-aq', '--no-trunc', '--filter', `network=${name}`]);
  if (ps.code !== 0) throw new SandboxError(`docker could not list the containers on ${name}: ${why(ps)}`);
  const attached = lines(ps.stdout);
  // A container that left on its own meanwhile fails `rm` harmlessly; the network removal is the check.
  if (attached.length > 0) await exec(['rm', '-f', ...attached]);
  const r = await exec(['network', 'rm', name]);
  if (r.code !== 0 && !(r.error === undefined && NOT_FOUND_RE.test(r.stderr))) throw new SandboxError(`docker could not remove network ${name}: ${why(r)}`);
}

/**
 * Remove what a grader that died mid-pass left of trial `owner` (the header's Cleanup): every network
 * labelled makefun.grader=1 and makefun.trial=<owner>, its value checked again and its name a trial
 * network's, each after the grader containers still on it (`docker rm -f`); the containers listed
 * again, REAP_ROUNDS times in all, while the network will not go (one that joined meanwhile). Nothing
 * else: no network another trial owns or none does, no container on no such network. A network or
 * container gone meanwhile is fine. Run it only while no pass of the trial runs (the trial's next pass
 * runs it before it makes its own network). Never throws for what it could not list or remove: the
 * result says; an owner that is no label value is a SandboxError.
 */
export async function reapTrial(owner: string, opts: NetworkOptions = {}): Promise<ReapResult> {
  checkTrialOwner(owner);
  const exec = execOf(opts);
  const res: ReapResult = { owner, containers: [], networks: [], errors: [] };
  const ls = await exec(['network', 'ls', '--filter', `label=${CONTAINER_LABEL}`, '--filter', `label=${OWNER_LABEL}=${owner}`, '--format', `{{.Name}} {{.Label "${OWNER_LABEL}"}}`]);
  if (ls.code !== 0) {
    res.errors.push(`docker network ls: ${why(ls)}`);
    return res;
  }
  const networks = new Set<string>();
  for (const line of lines(ls.stdout)) {
    const [name, value, ...rest] = line.split(' ');
    if (rest.length === 0 && value === owner && name !== undefined && name.startsWith(TRIAL_NETWORK_PREFIX) && TRIAL_RE.test(name.slice(TRIAL_NETWORK_PREFIX.length))) networks.add(name);
  }
  for (const network of [...networks].sort()) await reapNetwork(exec, network, res);
  return res;
}

/** One of reapTrial's networks: its grader containers, then it (see reapTrial). */
async function reapNetwork(exec: DockerExec, network: string, res: ReapResult): Promise<void> {
  let failed = '';
  for (let round = 1; round <= REAP_ROUNDS; round++) {
    const ps = await exec(['ps', '-a', '--no-trunc', '--filter', `network=${network}`, '--filter', `label=${CONTAINER_LABEL}`, '--format', '{{.ID}} {{.Names}}']);
    if (ps.code !== 0) {
      res.errors.push(`docker ps on ${network}: ${why(ps)}`);
      return;
    }
    const attached = lines(ps.stdout)
      .map((l) => l.split(' '))
      .filter((p): p is [string, string] => p.length === 2);
    let rmFailed = '';
    if (attached.length > 0) {
      const rm = await exec(['rm', '-f', ...attached.map(([id]) => id)]);
      const removed = new Set(lines(rm.stdout));
      for (const [id, name] of attached) if (removed.has(id)) res.containers.push(name);
      // One that went meanwhile (its own --rm) fails here harmlessly: the network's removal is the check.
      if (rm.code !== 0) rmFailed = `; docker rm: ${why(rm)}`;
    }
    const r = await exec(['network', 'rm', network]);
    if (r.code === 0) {
      res.networks.push(network);
      return;
    }
    if (r.error === undefined && NOT_FOUND_RE.test(r.stderr)) return;
    failed = `docker network rm ${network}: ${why(r)}${rmFailed}`;
  }
  res.errors.push(`${failed} (after ${REAP_ROUNDS} tries)`);
}

export interface SweepOptions extends NetworkOptions {
  /** Older than this is stale (default STALE_AFTER_MS). */
  maxAgeMs?: number;
  /** The clock (default Date.now()). */
  now?: number;
  /** Extra label filters (`key` or `key=value`) narrowing the sweep, e.g. to one test's own. */
  labels?: readonly string[];
}

const LABEL_FILTER_RE = /^[a-z0-9][a-z0-9._-]*(=[A-Za-z0-9._-]*)?$/;

/** A docker `Created` time (RFC 3339, nanoseconds) in ms, or null when it is not one (or is Go's zero time). */
export function parseDockerTime(s: unknown): number | null {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** `<id> <json created>` lines (plus a name for networks) from an inspect, the stale ones' ids or names. */
function staleOf(out: string, cutoff: number, errors: string[], what: string): string[] {
  const stale: string[] = [];
  for (const line of lines(out)) {
    const parts = line.split(' ');
    const created = parts.at(-1)!;
    const key = parts.at(-2)!;
    let t: number | null = null;
    try {
      t = parseDockerTime(JSON.parse(created));
    } catch {
      t = null;
    }
    if (t === null) errors.push(`${what} ${key}: unreadable creation time ${created}`);
    else if (t < cutoff) stale.push(key);
  }
  return stale;
}

/**
 * Remove grader containers (makefun.grader=1) and trial networks (makefun.net) created more than
 * `maxAgeMs` ago: what a crashed grader left. Containers first, so their networks come free. Never
 * throws for one it could not remove; the result lists what it removed and what it could not.
 */
export async function sweepStale(opts: SweepOptions = {}): Promise<SweepResult> {
  const exec = execOf(opts);
  const maxAge = opts.maxAgeMs ?? STALE_AFTER_MS;
  if (!Number.isFinite(maxAge) || maxAge < 0) throw new SandboxError(`maxAgeMs ${maxAge} is out of range`);
  const cutoff = (opts.now ?? Date.now()) - maxAge;
  const extra: string[] = [];
  for (const l of opts.labels ?? []) {
    if (!LABEL_FILTER_RE.test(l)) throw new SandboxError(`label filter ${JSON.stringify(l)} is not key or key=value`);
    extra.push('--filter', `label=${l}`);
  }
  const res: SweepResult = { containers: [], networks: [], errors: [] };

  const ps = await exec(['ps', '-aq', '--no-trunc', '--filter', `label=${CONTAINER_LABEL}`, ...extra]);
  if (ps.code !== 0) res.errors.push(`docker ps: ${why(ps)}`);
  else if (lines(ps.stdout).length > 0) {
    // A container gone between the list and the inspect is missing from stdout; the rest still print.
    const ins = await exec(['container', 'inspect', '--format', '{{.Id}} {{json .Created}}', ...lines(ps.stdout)]);
    if (ins.code !== 0 && lines(ins.stdout).length === 0) res.errors.push(`docker container inspect: ${why(ins)}`);
    const stale = staleOf(ins.stdout, cutoff, res.errors, 'container');
    if (stale.length > 0) {
      const rm = await exec(['rm', '-f', ...stale]);
      const removed = new Set(lines(rm.stdout));
      res.containers.push(...stale.filter((id) => removed.has(id)));
      if (rm.code !== 0) res.errors.push(`docker rm: ${why(rm)}`);
    }
  }

  const ls = await exec(['network', 'ls', '-q', '--no-trunc', '--filter', `label=${CONTAINER_LABEL}`, '--filter', `label=${NETWORK_LABEL}`, ...extra]);
  if (ls.code !== 0) res.errors.push(`docker network ls: ${why(ls)}`);
  else if (lines(ls.stdout).length > 0) {
    const ins = await exec(['network', 'inspect', '--format', '{{.Name}} {{json .Created}}', ...lines(ls.stdout)]);
    if (ins.code !== 0 && lines(ins.stdout).length === 0) res.errors.push(`docker network inspect: ${why(ins)}`);
    const stale = staleOf(ins.stdout, cutoff, res.errors, 'network').filter((n) => n.startsWith(TRIAL_NETWORK_PREFIX) && n !== EGRESS_NETWORK);
    if (stale.length > 0) {
      const rm = await exec(['network', 'rm', ...stale]);
      const removed = new Set(lines(rm.stdout));
      res.networks.push(...stale.filter((n) => removed.has(n)));
      if (rm.code !== 0) res.errors.push(`docker network rm: ${why(rm)}`);
    }
  }
  return res;
}

export interface RaceSweepOptions extends NetworkOptions {
  /** The clock, epoch ms (default Date.now()). */
  now?: number;
}

const RACE_DEADLINE_RE = /^[1-9][0-9]{0,15}$/;

/**
 * Remove every race container (docker.ts RACE_LABEL) whose deadline, its label's value, has passed (the
 * header): `docker ps` by the label, one inspect for each one's deadline, `docker rm -f` of those past it.
 * A container gone between the list and the inspect is missing from the inspect and fine; a deadline that
 * is not epoch ms is an error, and that container is left. Never throws: the result lists what it removed
 * (container ids) and what it could not.
 */
export async function sweepExpiredRaces(opts: RaceSweepOptions = {}): Promise<SweepResult> {
  const exec = execOf(opts);
  const now = opts.now ?? Date.now();
  const res: SweepResult = { containers: [], networks: [], errors: [] };
  const ps = await exec(['ps', '-aq', '--no-trunc', '--filter', `label=${RACE_LABEL}`]);
  if (ps.code !== 0) {
    res.errors.push(`docker ps: ${why(ps)}`);
    return res;
  }
  const ids = lines(ps.stdout);
  if (ids.length === 0) return res;
  const ins = await exec(['container', 'inspect', '--format', `{{.Id}} {{index .Config.Labels "${RACE_LABEL}"}}`, ...ids]);
  if (ins.code !== 0 && lines(ins.stdout).length === 0) {
    res.errors.push(`docker container inspect: ${why(ins)}`);
    return res;
  }
  const expired: string[] = [];
  for (const line of lines(ins.stdout)) {
    const [id, deadline, ...rest] = line.split(' ');
    if (id === undefined || id === '') continue;
    if (rest.length > 0 || deadline === undefined || !RACE_DEADLINE_RE.test(deadline)) res.errors.push(`container ${id}: unreadable race deadline ${JSON.stringify(line.slice(id.length + 1))}`);
    else if (Number(deadline) < now) expired.push(id);
  }
  if (expired.length === 0) return res;
  const rm = await exec(['rm', '-f', ...expired]);
  const removed = new Set(lines(rm.stdout));
  res.containers.push(...expired.filter((id) => removed.has(id)));
  if (rm.code !== 0) res.errors.push(`docker rm: ${why(rm)}`);
  return res;
}

// ---------------------------------------------------------------- isolation (the header's Isolation)

/**
 * How long one reach probe tries: the control waits up to this for the listener to listen; a sibling whose SYN is
 * dropped waits all of it. The k8s probe's allowed pair is no reach: it waits a fresh pod's first connect (k8s.ts
 * FIRST_CONNECT_WAIT_MS).
 */
export const ISOLATION_PROBE_MS = 3_000;
/** The probe's listener exits by itself after this many seconds, so a grader that dies mid-probe leaves it no longer. */
export const ISOLATION_LISTENER_S = 120;
/** A refusal is kept this long; the next check after it probes the engine again. */
export const ISOLATION_RECHECK_MS = 5 * 60_000;
/** The egress bridge's option enable_icc, as `docker network inspect` shows it. */
export const ICC_OPTION = 'com.docker.network.bridge.enable_icc';

/**
 * The listener (`node -e`, argv: seconds to live): answers every connection on 0.0.0.0:8080 by closing it, its server
 * bound to `server`. The one listener of both drivers: k8s-network.ts ISOLATION_LISTENER_POD_SCRIPT is this script with
 * a pod's lines around it.
 */
export const ISOLATION_LISTENER_SCRIPT = [
  "const server = require('node:net').createServer((s) => s.end());",
  `server.listen(${SERVICE_PORT}, '0.0.0.0');`,
  'setTimeout(() => process.exit(0), Number(process.argv[1]) * 1000);',
].join('\n');

/**
 * A reach probe (`node -e`, argv: host, port, ms): TCP to host:port until it connects (reached), is
 * cut off by the deadline, or fails other than by a refusal (a refusal is tried again every 100 ms:
 * the listener may not listen yet). Prints one line, {reached, how, defaultRoute}: how it ended (the
 * error code), and whether the container has a default route (/proc/net/route).
 */
export const ISOLATION_REACH_SCRIPT = [
  "const net = require('node:net');",
  "const fs = require('node:fs');",
  'const [host, port, ms] = process.argv.slice(1);',
  'const deadline = Date.now() + Number(ms);',
  'let routes = [];',
  "try { routes = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\\n').slice(1).map((l) => l.split('\\t')[1]); } catch {}",
  'const done = (reached, how) => {',
  "  process.stdout.write(JSON.stringify({ reached, how, defaultRoute: routes.includes('00000000') }) + '\\n');",
  '  process.exit(0);',
  '};',
  'const attempt = () => {',
  '  const s = net.connect({ host, port: Number(port) });',
  "  const timer = setTimeout(() => { s.destroy(); done(false, 'TIMEOUT'); }, Math.max(1, deadline - Date.now()));",
  "  s.once('connect', () => { clearTimeout(timer); s.destroy(); done(true, 'connect'); });",
  "  s.once('error', (e) => {",
  '    clearTimeout(timer);',
  "    if (e.code === 'ECONNREFUSED' && Date.now() + 100 < deadline) setTimeout(attempt, 100);",
  '    else done(false, String(e.code || e.message));',
  '  });',
  '};',
  'attempt();',
].join('\n');

/**
 * `docker run` argv (no leading `docker`) of one isolation probe container: the hardened flags a
 * trial's services run under, SERVICE_LIMITS, `node -e <script> <args>` in `image` (the pinned node22, so `--pull
 * missing` as docker.ts's PULL_POLICY: a probe that runs before any preflight fetches it by its digest); `detach` for
 * the listener. Pure: unit-tested exactly.
 */
export function isolationRunArgs(o: { name: string; network: string; image: string; runtime: string | null; detach: boolean; script: string; args: readonly string[] }): string[] {
  const memory = `${SERVICE_LIMITS.memory_mb}m`;
  return [
    'run', ...(o.detach ? ['-d'] : []), '--rm',
    '--name', o.name,
    '--label', CONTAINER_LABEL,
    '--pull', PULL_POLICY,
    '--network', o.network,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '-u', NOBODY,
    '--memory', memory,
    '--memory-swap', memory,
    '--cpus', String(SERVICE_LIMITS.cpus),
    '--pids-limit', String(SERVICE_LIMITS.pids),
    '--log-driver', 'none',
    ...(o.runtime === null ? [] : ['--runtime', o.runtime]),
    '--entrypoint', 'node', o.image, '-e', o.script, ...o.args,
  ];
}

export type IsolationRefused = Extract<IsolationVerdict, { enforced: false }>;

/** What a refusal calls the engine, by the driver whose probe found it. */
export const ISOLATION_ENGINES = Object.freeze({ docker: 'Docker engine', k8s: 'Kubernetes cluster' } as const);
export type IsolationDriver = keyof typeof ISOLATION_ENGINES;
/** A verdict naming the driver that probed: one naming none is docker's (probeIsolation's). */
export type DriverVerdict = IsolationVerdict & { driver?: IsolationDriver };

/**
 * This engine does not keep agent trials apart: an operator's fault, never a trial's. Not a
 * SandboxError, which a trial pass records as a void (grader/agent.ts): a refusal voids nothing.
 */
export class IsolationRefusal extends Error {
  readonly fault: IsolationFault;
  readonly engine: string;
  readonly driver: IsolationDriver;
  constructor(v: IsolationRefused & { driver?: IsolationDriver }) {
    const driver = v.driver ?? 'docker';
    super(`this ${ISOLATION_ENGINES[driver]} (${v.engine}) does not keep agent trials apart (${v.fault}): ${v.reason}. Fix: ${v.fix}`);
    this.name = 'IsolationRefusal';
    this.fault = v.fault;
    this.engine = v.engine;
    this.driver = driver;
  }
}

export interface IsolationOptions extends NetworkOptions {
  /** The probe containers' image, a digest reference (default the pinned node22, the trial services' own). */
  image?: string;
  /** `--runtime` for them (the sandbox's; default none). */
  runtime?: string | null;
  /** How long each reach probe tries (default ISOLATION_PROBE_MS). */
  probeMs?: number;
}

/** What one reach probe (ISOLATION_REACH_SCRIPT) found. */
export interface Reach {
  reached: boolean;
  how: string;
  defaultRoute: boolean;
}

/** Run one reach probe (a `docker run` or `docker exec` argv) and read its line. */
async function reach(exec: DockerExec, args: readonly string[], what: string): Promise<Reach> {
  const r = await exec(args);
  if (r.code !== 0) throw new SandboxError(`the isolation probe's ${what} did not run: ${why(r)}`);
  return readReach(r.stdout, what);
}

/** A reach probe's line (its stdout's last): SandboxError when it printed anything else. */
export function readReach(stdout: string, what: string): Reach {
  let doc: Partial<Reach> | null = null;
  try {
    doc = JSON.parse(lines(stdout).at(-1) ?? '') as Partial<Reach> | null;
  } catch {
    doc = null;
  }
  if (doc === null || typeof doc !== 'object' || typeof doc.reached !== 'boolean' || typeof doc.how !== 'string' || typeof doc.defaultRoute !== 'boolean') {
    throw new SandboxError(`the isolation probe's ${what} printed ${JSON.stringify(stdout.slice(0, 200))}, not what it found`);
  }
  return { reached: doc.reached, how: doc.how, defaultRoute: doc.defaultRoute };
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** A running container's IPv4 address on the egress bridge. */
async function egressAddressOf(exec: DockerExec, name: string): Promise<string> {
  const r = await exec(['container', 'inspect', '--format', '{{json .NetworkSettings.Networks}}', name]);
  if (r.code !== 0) throw new SandboxError(`docker could not inspect the isolation probe's listener ${name}: ${why(r)}`);
  let ip: unknown;
  try {
    ip = (JSON.parse(r.stdout) as Record<string, { IPAddress?: unknown } | undefined> | null)?.[EGRESS_NETWORK]?.IPAddress;
  } catch {
    ip = undefined;
  }
  if (typeof ip !== 'string' || !IPV4_RE.test(ip)) throw new SandboxError(`the isolation probe's listener ${name} has no IPv4 address on ${EGRESS_NETWORK}: ${r.stdout.slice(0, 200)}`);
  return ip;
}

const ICC_OFF_FIX =
  'run the daemon with iptables on ("iptables": true in /etc/docker/daemon.json, or in Docker Desktop\'s Settings > Docker Engine; no --iptables=false on dockerd) ' +
  'and bridged traffic through iptables (the br_netfilter module loaded, net.bridge.bridge-nf-call-iptables=1), then restart dockerd';
const ICC_UNSET_FIX = `remove ${EGRESS_NETWORK} while no trial runs (docker network rm ${EGRESS_NETWORK}): the grader makes it again with ${ICC_OPTION}=false`;
const INTERNAL_FIX = "grade agent/v1 on Docker's own bridge driver (Docker Engine on Linux, or Docker Desktop), which gives an --internal network's containers no route out";

/**
 * Probe whether this engine keeps agent trials apart (the header's Isolation): the egress bridge made
 * if missing (ensureEgressNetwork), a listener on it, the control, the sibling, the control again,
 * then the inside probe on an internal network of its own; every container and that network removed
 * after. Answers the verdict; throws SandboxError when the probe could not finish or proves nothing.
 */
export async function probeIsolation(opts: IsolationOptions = {}): Promise<IsolationVerdict> {
  const exec = execOf(opts);
  const node = IMAGES.images.node22;
  const image = opts.image ?? imageRef(node, node.digest);
  const runtime = opts.runtime ?? null;
  const probeMs = opts.probeMs ?? ISOLATION_PROBE_MS;
  if (!Number.isSafeInteger(probeMs) || probeMs <= 0) throw new SandboxError(`probeMs ${probeMs} is out of range`);

  const info = await exec(['info', '--format', '{{.ServerVersion}}|{{.OperatingSystem}}']);
  if (info.code !== 0) throw new SandboxError(`docker could not say which engine it is: ${why(info)}`);
  const [version = '', system = ''] = info.stdout.trim().split('|');
  const engine = `${system.trim() || 'an unnamed system'}, Docker ${version.trim() || 'of no version'}`;
  await ensureEgressNetwork({ exec });

  const listener = containerName('isolation');
  const trial = listener.slice('makefun-'.length);
  const sibling = `${listener}-sibling`;
  const inside = `${listener}-inside`;
  const runArgs = (name: string, network: string, detach: boolean, script: string, args: readonly string[]) => isolationRunArgs({ name, network, image, runtime, detach, script, args });
  let made = false;
  try {
    const up = await exec(runArgs(listener, EGRESS_NETWORK, true, ISOLATION_LISTENER_SCRIPT, [String(ISOLATION_LISTENER_S)]));
    if (up.code !== 0) throw new SandboxError(`the isolation probe could not start its listener on ${EGRESS_NETWORK}: ${why(up)}`);
    const ip = await egressAddressOf(exec, listener);
    const target = [ip, String(SERVICE_PORT), String(probeMs)];
    const at = `${ip}:${SERVICE_PORT}`;
    const control = (when: string) => reach(exec, ['exec', listener, 'node', '-e', ISOLATION_REACH_SCRIPT, ...target], `control (${when} the sibling)`);

    const before = await control('before');
    if (!before.reached) throw new SandboxError(`the isolation probe's listener did not answer at its own address ${at} (${before.how}): the probe proves nothing`);
    const fromSibling = await reach(exec, runArgs(sibling, EGRESS_NETWORK, false, ISOLATION_REACH_SCRIPT, target), 'sibling');
    const after = await control('after');
    if (!after.reached) throw new SandboxError(`the isolation probe's listener no longer answered at its own address ${at} after the sibling tried (${after.how}): the probe proves nothing`);
    if (fromSibling.reached) {
      // The option as the bridge holds it; unreadable, it is taken as set (ensureEgressNetwork sets it).
      const icc = await inspectNetwork(exec, EGRESS_NETWORK).then(
        (n) => (n === null ? null : (n.Options?.[ICC_OPTION] ?? 'unset')),
        () => null,
      );
      const unset = icc !== null && icc !== 'false';
      const reason = `a container on ${EGRESS_NETWORK} reached another one there (${at}), so the forwarders of concurrent trials reach one another`;
      return unset
        ? { enforced: false, engine, fault: 'egress_icc_unset', reason: `${reason}: the bridge was made with ${ICC_OPTION}=${icc}`, fix: ICC_UNSET_FIX }
        : { enforced: false, engine, fault: 'egress_icc_off', reason: `${reason}: the bridge's ${ICC_OPTION}=false is not enforced`, fix: ICC_OFF_FIX };
    }

    await createTrialNetwork(trial, { exec });
    made = true;
    const fromInside = await reach(exec, runArgs(inside, trialNetworkName(trial), false, ISOLATION_REACH_SCRIPT, target), 'inside probe');
    if (fromInside.reached || fromInside.defaultRoute) {
      const what = [fromInside.defaultRoute ? 'has a default route' : null, fromInside.reached ? `reached ${at} on ${EGRESS_NETWORK}` : null].filter((s) => s !== null).join(' and ');
      return { enforced: false, engine, fault: 'internal_route', reason: `a container on an internal network made as a trial's (--internal, inhibit_ipv4) ${what}, so a trial's entry is not kept to its network`, fix: INTERNAL_FIX };
    }
    return {
      enforced: true,
      engine,
      detail: `a container on ${EGRESS_NETWORK} did not reach another there (${at}: ${fromSibling.how}), and one on an internal network had no route out (${fromInside.how})`,
    };
  } finally {
    // The listener, and a probe container its CLI call was cut off from; the ones that ended are gone already.
    await exec(['rm', '-f', listener, sibling, inside]).catch(() => undefined);
    if (made) await removeTrialNetwork(trial, { exec }).catch(() => undefined);
  }
}

export interface EngineIsolationOptions extends IsolationOptions {
  /** How long a refusal is kept (default ISOLATION_RECHECK_MS). */
  recheckMs?: number;
  /** The clock (default Date.now). */
  now?: () => number;
  /** The driver's own probe in place of probeIsolation (k8s-network.ts's of a cluster); the docker options above are then unread. */
  probe?: () => Promise<IsolationVerdict>;
}

/** What a caller of EngineIsolation needs (a test hands in its own). */
export type IsolationCheck = Pick<EngineIsolation, 'verdict' | 'require'>;

/**
 * One engine's isolation verdict, kept (the header's Isolation): callers at once share one probe; a
 * verdict that holds is kept for good, a refusal for `recheckMs`, a probe that threw for nothing.
 */
export class EngineIsolation {
  readonly #opts: EngineIsolationOptions;
  #current: Promise<IsolationVerdict> | null = null;
  #refusedAt: number | null = null;

  constructor(opts: EngineIsolationOptions = {}) {
    this.#opts = opts;
  }

  /** The engine's verdict, probed when none is kept. Rejects with the probe's SandboxError when it could not finish. */
  verdict(): Promise<IsolationVerdict> {
    const now = this.#opts.now ?? Date.now;
    const recheck = this.#opts.recheckMs ?? ISOLATION_RECHECK_MS;
    if (this.#current !== null && (this.#refusedAt === null || now() - this.#refusedAt < recheck)) return this.#current;
    const probing = this.#opts.probe !== undefined ? this.#opts.probe() : probeIsolation(this.#opts);
    this.#current = probing;
    this.#refusedAt = null;
    probing.then(
      (v) => {
        if (this.#current === probing && !v.enforced) this.#refusedAt = now();
      },
      () => {
        if (this.#current === probing) this.#current = null;
      },
    );
    return probing;
  }

  /** The verdict when the engine keeps trials apart; else throws IsolationRefusal (or the probe's SandboxError). */
  async require(): Promise<Extract<IsolationVerdict, { enforced: true }>> {
    const v = await this.verdict();
    if (!v.enforced) throw new IsolationRefusal(v);
    return v;
  }
}

const engines = new Map<string, EngineIsolation>();

/** This process's EngineIsolation of a docker CLI, runtime and image: one probe per grader process. */
export function engineIsolation(opts: { docker?: string; runtime?: string | null; image?: string } = {}): EngineIsolation {
  const key = JSON.stringify([opts.docker ?? 'docker', opts.runtime ?? null, opts.image ?? null]);
  let found = engines.get(key);
  if (found === undefined) {
    found = new EngineIsolation({ ...opts });
    engines.set(key, found);
  }
  return found;
}

/** An IsolationCheck of a driver's TrialNetworks.isolation: its verdict, and require's IsolationRefusal when it holds no isolation. */
export function isolationCheck(networks: Pick<TrialNetworks, 'isolation'>): IsolationCheck {
  return {
    verdict: () => networks.isolation(),
    async require() {
      const v = await networks.isolation();
      if (!v.enforced) throw new IsolationRefusal(v);
      return v;
    },
  };
}

// ---------------------------------------------------------------- the docker driver's TrialNetworks

export interface DockerTrialNetworksOptions extends NetworkOptions {
  /** The sandbox's `--runtime`, the isolation probe's too (default none). */
  runtime?: string | null;
  /** The sandbox's image table: the isolation probe runs its node22 (default IMAGES). */
  images?: ImageTableT;
}

/**
 * The docker driver's TrialNetworks (types.ts) on one docker CLI: createTrialNetwork,
 * removeTrialNetwork, reapTrial, ensureEgressNetwork and sweepStale on it, and its isolation this
 * process's EngineIsolation of the CLI, runtime and node22 image (engineIsolation; on an `exec`, one
 * of its own).
 */
export function dockerTrialNetworks(o: DockerTrialNetworksOptions = {}): TrialNetworks {
  const net: NetworkOptions = o.exec !== undefined ? { exec: o.exec } : { docker: o.docker ?? 'docker' };
  let own: EngineIsolation | null = null;
  return {
    create: (trial, { owner }) => createTrialNetwork(trial, { ...net, owner }),
    remove: (trial) => removeTrialNetwork(trial, net),
    reap: (owner) => reapTrial(owner, net),
    async ensureEgress() {
      await ensureEgressNetwork(net);
    },
    sweepStale: () => sweepStale(net),
    sweepRaces: () => sweepExpiredRaces(net),
    isolation() {
      const node = imageFor('node22', o.images ?? IMAGES);
      const probe = { runtime: o.runtime ?? null, image: imageRef(node, node.digest) };
      const engine = net.exec === undefined ? engineIsolation({ docker: net.docker, ...probe }) : (own ??= new EngineIsolation({ exec: net.exec, ...probe }));
      return engine.verdict();
    },
  };
}

/**
 * The networks a harness's trial makes on `sandbox` (agent.ts runTrial, scrape/trial.ts
 * runScrapeTrial): none on the process driver; the docker driver's on `exec` when the trial names
 * its own docker CLI (`overridden`: their `docker` option) or the sandbox has none of its own (a
 * test's stand-in); else the sandbox's own (Sandbox.networks).
 */
export function trialNetworksOf(sandbox: Sandbox, exec: DockerExec, overridden: boolean): TrialNetworks | null {
  if (!containerized(sandbox.kind)) return null;
  return overridden || sandbox.networks === undefined ? dockerTrialNetworks({ exec }) : sandbox.networks;
}
