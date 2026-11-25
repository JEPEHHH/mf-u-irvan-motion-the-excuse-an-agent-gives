// The sandbox layout of a contest's entries on the k8s driver: `split`, today's shape (an agent/v1 trial's entry, env
// and entry forwarder each a pod of their own, 3 a trial, and with a house target its forwarder a fourth: grader/agent.ts
// trialPods; a scrape/v1 heat's entry and recording gateway, 2, the entry's /output meter a `watch` container in the
// entry's own pod; a program/v1 execution 1 (a per-file one's cases one session pod, run one after another: Sandbox
// .sessions, sandbox/types.ts; a pod each case on a driver with no sessions), its /output meter a `watch` container in
// the program's pod), or `pod`, one
// sandbox pod an entry (the trial's `entry` and `env`, the heat's `entry` and its root `meter` container), its
// forwarders and gateway lanes in the grader's lanes pod (one gVisor sandbox pod a grader makes for itself,
// makefun-sbx-lanes-<8 hex>: grader/sandbox/k8s-lanes.ts). This file imports nothing (as grader/house-clock.ts), so
// server/jobs.ts can read it as well as the grader.
//
// The owner, 2026-11-12, verbatim: "always 1 pod max per entry for all future competitions pls"; "the only limit is max
// cpu/ram on the box"; "uhhh yeah i mean model keys need to stay fully isolated from the random code for sure..."; "and
// keep support for the 4/2 pod setups as is this should be like an alt config".
//
// So `split` stays, its code and behaviour untouched, for every contest that exists and every contest born before
// go-live, and `pod` is what a contest born after go-live runs, with no key in competition.yaml (the harness schemas are
// strict, contracts/ is scorer source and an opened bundle's hash is committed):
//
// - POD_LAYOUT_KINDS: the only harness kinds `pod` applies to, those whose `split` shape holds more than one pod at once.
//   A replay or patch grade is one plain spawn, one pod on either layout, so flagging it would only make its re-runs
//   need a host: every other kind is `split` whatever its contest's name or birth. program/v1 is not there (the root's
//   ruling, 2026-11-12, on the owner's "always 1 pod max per entry for all future competitions pls"): a program/v1
//   execution is one pod on `split` already (plain, metered, timed, a generator: its /output meter is a `watch`
//   container in its own pod since the claim-less build; a per-file execution one session pod its cases run in one
//   after another, where the driver offers sessions: grader/program.ts executePerCase), so `pod` would save it nothing
//   and put it on the one-pod view's claim-mounting pods, held to the claim's node, where `split`'s staged pods may go
//   to any gVisor node.
// - SPLIT_COMPETITIONS: the names that run `split`. It holds every directory under competitions/ as of this file's
//   landing, opened bundles and pilots alike. A name leaves it only for POD_COMPETITIONS (a bundle moved after go-live,
//   once its env is read for what `pod` requires of it). A name joins it only by its contest owner's order to keep the
//   contest's env out of the entrant's sandbox, that order quoted in a comment beside the name, in the change that lands
//   the bundle; the guard test holds its own copy of this list and fails on a name added without one.
// - POD_COMPETITIONS: bundles taken off SPLIT_COMPETITIONS after go-live. Empty until then.
// - Go-live's instant, `from`: never a constant in code. An instant fixed when this file is built is not the instant a
//   release starts serving, and a contest minted in between would change layout mid-life. It lives in the site setting
//   ONE_POD_FROM_SETTING (site_setting, key 'one-pod-from'), which an operator's act writes once, never a boot: go-live
//   is `makefun-k8s.sh -o <overlay> one-pod start` and then `restart grader`, so a release that carries the routing
//   does exactly what one without it does until then. The writer and every reader live outside grader/, none in this
//   file. A caller hands sandboxLayoutOf the setting's instant, or null while it has none, and with null every
//   contest, listed or not, is `split`.
//
// Why the competition row's birth (its created_at) is read and not the list alone: slugs are minted with no directory
// under competitions/. A release lane's launch inserts a competition row under a slug of its own each time
// (server/releases/launch.ts createCompetition), a sponsor's proposal does too (server/routes/sponsor/store.ts
// writeDraftCompetition), and a seeding export writes a new competitions/<slug>/ directory a later checkout takes in
// (server/seeding/export.ts ideaExportOf). By the list alone every such contest already running would take `pod` at
// go-live; by its birth it keeps `split`.
//
// What `pod` shares, plainly: on `pod` the env's hidden game state (its /env-data, /state and memory) and its house-lane
// token sit in the same gVisor sandbox as the entrant's code, which is weaker than `split`, where the env is another pod.
// Between them are only gVisor's per-container PID and mount namespaces and separate uids, which gVisor's maintainers do
// not count as a strong boundary; the network namespace (loopback ports, abstract unix sockets) is shared outright, and
// the entry's CPU and memory caps are the pod's total, shared with the env. Each member has a /dev/shm of its own by
// mount, and the pod's shared one is reachable from the entry at no path (deploy/k8s/README.md rows b5, S1): a mount
// over a path, not isolation. What `pod` keeps out of that sandbox: every model key, forwarder and gateway, which run
// as lanes in the grader's lanes pod. A grader's lanes share that one gVisor sandbox, weaker than `split`'s sandbox a
// forwarder: shared outright are its kernel, its loopback (another lane's port can be dialled; an entry lane's key on
// `pod` is its run's own for that trial, grader/agent.ts podEntryLaneKey, public once the run is recorded in its trial
// record's entry_key), its egress (a replay lane's included), its CPU and memory total, and the root program; the
// per-lane uids are not isolation.
//
// A run graded on `pod` carries the run-only flag ONE_POD_FLAG (run.flags; never in a score), and an L2 regrade re-runs
// under the run's own flag. The docker and process drivers ignore the layout: it is the k8s driver's shape, never a
// scoring input.

/**
 * `split`: today's pod per program (3 a trial, 4 with a house target; 2 a heat; 1 a program run, a per-file run's cases
 * one session pod). `pod`: one sandbox pod an entry.
 */
export type SandboxLayout = 'pod' | 'split';

/**
 * The harness kinds whose `split` shape is more than one pod at once (an agent/v1 trial's entry, env and forwarders; a
 * scrape/v1 heat's entry and gateway): only these take `pod`. Not program/v1: one pod an execution on `split` already
 * (a per-file one's cases one session pod), its /output meter a `watch` container in it (the header).
 */
export const POD_LAYOUT_KINDS: readonly string[] = Object.freeze(['agent/v1', 'scrape/v1']);

/** Every directory under competitions/ as of this file's landing: each runs `split`. See the header before editing. */
export const SPLIT_COMPETITIONS: readonly string[] = Object.freeze([
  'ai-joke-01',
  'ai-joke-02',
  'algotune-gzip-record-01',
  'btc-live-race-01',
  'btc-race-4h-01',
  'btc-race-rehearsal-02',
  'btc-race-sim-01',
  'btc-race-sim-bets-01',
  'btc-race-sim-bets-02',
  'captcha-solver-01',
  'chess-engine-01',
  'close-the-books-01',
  'code-tests-01',
  'cutest-cat-01',
  'cutest-dog-01',
  'dropship-store-agent-01',
  'jailbreak-the-vault-01',
  'judge-pilot',
  'judge-pilot-image',
  'loadtest-01',
  'makefun-sticker-01',
  'makefun-tagline-01',
  'markdown-render-speed-01',
  'memecoin-backtest-48h-01',
  'negotiation-agent-01',
  'news-summary-01',
  'payout-proof-01',
  'payout-proof-02',
  'payout-proof-03',
  'photo-geolocator-01',
  'pilot-pumpfun-replay',
  'poker-bot-01',
  'poker-husky-01',
  'pumpfun-top5-forecast-01',
  'python-date-parse-speed-01',
  'roblox-datastore-01',
  'roblox-top-chart-02',
  'roblox-top100-scrape-01',
  'roblox-trending-forecast-01',
  'roblox-up-and-coming-forecast-01',
  'shopify-store-01',
  'shortest-route-01',
  'solana-bars-1h-01',
  'solana-clmm-lp-01',
  'solana-memecoin-backtest-01',
  'solana-memecoin-bot-01',
  'solana-stocks-1h-01',
  'target-pilot',
  'team-test-memecoin-01',
  'tiny-chess-01',
  'vault-guard-01',
  'werewolf-agent-01',
  'xstocks-movers-forecast-01',
]);

/** Bundles moved off SPLIT_COMPETITIONS after go-live: each runs `pod` whenever its row was born. */
export const POD_COMPETITIONS: readonly string[] = Object.freeze([]);

/**
 * The site_setting key holding go-live's instant (`from`; see the header). Its writer and readers live outside
 * grader/: this file neither reads nor writes it.
 */
export const ONE_POD_FROM_SETTING = 'one-pod-from';

/** The run-only flag a run graded on `pod` carries (run.flags): in no score. */
export const ONE_POD_FLAG = 'one_pod';

/** A `pod` trial's requests: the contest's own measured p95 of entry + env, rounded up to 10m and 16 Mi. */
export interface PodTrialRequests {
  readonly cpuMilli: number;
  readonly memoryMi: number;
}

/**
 * Each contest's own pod requests, added with the contest once its `pod` trials are measured (its pilot's or its
 * first practice wave's), never copied from another contest's. Empty: no contest runs `pod` yet, so every contest
 * requests by the driver's rule.
 *
 * How a row is made. The p95, over that contest's own trials on `pod`, of each trial pod's CPU and of its memory as the
 * kubelet charges it: the POD's working set from `stats/summary` (the node proxy's
 * /api/v1/nodes/<node>/proxy/stats/summary, `pods[].memory.workingSetBytes` and `pods[].cpu.usageNanoCores`), read
 * every 15 s over at least 20 minutes of its pilot's or its first practice wave's trials, the entry and the env
 * together (on `pod` they are one pod and the limit is on its total). Rounded up to 10m and 16 Mi, with the read's
 * date, its trial count and its table in a comment beside the row. Not `kubectl top`: under gVisor top counts each
 * container's processes with the file-backed pages they map, about 90 MiB more than the pod is charged for a node
 * process, and never the pod's memory /tmp, which the limit does charge (200 MiB in /tmp cut an entry's reach from
 * about 490 to about 280 MiB of a 512Mi pod); and top leaves out a two-container gVisor pod while one of its containers
 * reads 0 CPU, so a pod missing from top is not an idle pod (deploy/k8s/README.md, What the memory limit counts). The
 * sandbox's own memory (14-16 MiB idle for one container, 20-21 for two) is inside the pod's working set and its
 * limit, so nothing is added for it. A contest with no row keeps today's rule (each container min(limit, 250m) and its
 * memory limit: 500m / 768 Mi on today's limits), so an unmeasured contest reserves more, never less.
 *
 * These rows are the `pod` layout's alone. On `split` no row is read (the driver never sees the contest): each pod
 * requests by its role (grader/sandbox/k8s.ts programCpuRequestMilli), the trial agent's pod min(limit, 850m)
 * (TRIAL_AGENT_CPU_REQUEST_MILLI: tiny-chess-01's entrant engine at about 0.84-0.98 core), each forwarder's min(limit,
 * 50m) (FORWARDER_CPU_REQUEST_MILLI), the env's min(limit, 250m) as before.
 *
 * The worked figures, step 2's read of two split contests on production: tiny-chess-01 1,080m / 759 Mi at p95 (41
 * trials, the engine at its one-core cap) and photo-geolocator-01 16m / 284 Mi (8 trials, thin). Both are `kubectl
 * top` readings, so their memory over-reads by the file pages each process maps (the production tiny-chess-01 entry
 * that read 870 Mi against its 512Mi limit and ran on is that over-read, not a missing limit), and neither is a row.
 * They are 70-fold apart in CPU, which is why no contest is sized by another's. A contest whose rules promise the entry
 * a CPU or memory amount of its own runs `split`, its name added to SPLIT_COMPETITIONS in the change that lands its
 * bundle as the header says: on `pod` the entry's caps are the pod's total, shared with the env.
 */
export const POD_TRIAL_REQUESTS: Readonly<Record<string, PodTrialRequests>> = Object.freeze({});

/** The two lists sandboxLayoutOf reads: POD_COMPETITIONS and SPLIT_COMPETITIONS unless a test hands its own. */
interface LayoutLists {
  readonly pod: readonly string[];
  readonly split: readonly string[];
}

const LISTS: LayoutLists = Object.freeze({ pod: POD_COMPETITIONS, split: SPLIT_COMPETITIONS });

/**
 * The layout a contest's entries run on. `kind` is its bundle's harness kind; `bornAt` is the competition row's
 * created_at; `from` is go-live's instant as the ONE_POD_FROM_SETTING site setting holds it, or null while it holds
 * none; `lists` is for tests alone (no caller passes it). `split` for a kind not in POD_LAYOUT_KINDS, nothing else read;
 * else `split` for every slug while `from` is null or an invalid Date, else `pod` for a slug in POD_COMPETITIONS
 * whenever born, else `split` for a slug in SPLIT_COMPETITIONS, for a contest born before `from` or for an invalid
 * `bornAt`, else `pod`.
 */
export function sandboxLayoutOf(slug: string, kind: string, bornAt: Date, from: Date | null, lists: LayoutLists = LISTS): SandboxLayout {
  if (!POD_LAYOUT_KINDS.includes(kind)) return 'split';
  if (from === null || !Number.isFinite(from.getTime())) return 'split';
  if (lists.pod.includes(slug)) return 'pod';
  if (lists.split.includes(slug)) return 'split';
  const born = bornAt.getTime();
  if (!Number.isFinite(born) || born < from.getTime()) return 'split';
  return 'pod';
}

/** The sandbox pods one entry's job holds at once: 1 on `pod`, `splitPods` (the job's split shape) on `split`. */
export function podsOf(layout: SandboxLayout, splitPods: number): number {
  return layout === 'pod' ? 1 : splitPods;
}

/** A contest's own `pod` requests, else null: the driver's rule of today. */
export function podRequestsOf(slug: string): PodTrialRequests | null {
  return Object.hasOwn(POD_TRIAL_REQUESTS, slug) ? POD_TRIAL_REQUESTS[slug]! : null;
}
