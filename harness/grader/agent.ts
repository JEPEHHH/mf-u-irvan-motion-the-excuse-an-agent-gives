// One agent/v1 trial (contracts/agent.ts): an LLM agent entry run against one beacon-drawn instance of
// the bundle's env (the store simulator), its model calls going only through the gateway forwarder
// (grader/gateway/). runTrial runs one pass of a trial, LIVE or REPLAY; scoreTrial scores a pass's
// state export with the bundle's scorer, and scoreTrialWithChecks also returns the per-check rows the
// scorer wrote beside the scores (grader/program-scores.ts checks.json: each trial's part of the run's
// checks trace, agent-score.ts agentChecksBreakdown). A checks.json the scorer gets wrong is dropped
// with its reason (TrialPass.checks_issue) and never fails the scoring: a breakdown never fails a grade.
//
// A pass, on the docker driver (grader/sandbox/network.ts has the networks and the three roles):
//   1. the trial's internal network (createTrialNetwork); LIVE first makes sure the host's egress
//      bridge exists (ensureEgressNetwork). A pass that names its trial's owner (RunTrialOptions.owner:
//      the pipeline's `<run id>.<trial index>`) first removes what a grader that died mid-pass left of
//      that trial, every network labelled makefun.trial=<owner> and the containers on each (network.ts
//      reapTrial, told to onReap with their names), then labels its own network with it, so the
//      trial's next pass finds whatever this one leaves should its grader die
//   2. the env on it as `store`: the bundle's env directory at /bot read-only (the sandbox runs every
//      program from /bot), the instance's input/env/ at /env-data read-only (an empty one of the pass's
//      own when a matched instance has none: instanceEnvData), a fresh /state writable,
//      MAKEFUN_SHOP_TOKEN set, ENV_LIMITS (two CPUs, network.ts says why) as a cpusCeiling, so a
//      docker host with fewer CPUs grants all it has. On the k8s sandbox, whose pods mount the data
//      claim alone, the env directory and the scorer's are their stages there (AgentSetup.envDir and
//      compDir, copied byte for byte from the image and re-hashed to env_sha256 and scorer_sha256:
//      grader/worker.ts stageAgentSetup); the docker and process drivers mount the bundle's own
//   3. the forwarder on it as `llm` (LIVE also on the egress bridge; REPLAY never): the gateway bundle's
//      directory at /bot read-only (gateway.mjs), /config read-only, a fresh /record writable,
//      SERVICE_LIMITS. /config holds gateway.json (main.ts GatewayConfig: the trial, the policy from the
//      bundle's inference rules, and LIVE the upstream and its key, or on the entrant's own keys those
//      keys and the values masked with them, REPLAY the cassette's sha256; with the entrant's env-lane
//      entry secrets, their request_mask on either) and, REPLAY, blobs/: the cassette and every
//      response body it lists, copied from the blob store
//   4. both ready files, /state/ready and /record/ready, each within READY_TIMEOUT_MS (30 s) of its
//      program's start (SandboxProcess.started: on k8s once its pod is Ready and the exec began, so a pod
//      Pending for room on the node spends none of it; the driver bounds that wait itself); then the
//      forwarder's gateway.json is deleted (the config file, below)
//   5. the entry on it as `agent`: the snapshot at /bot read-only, /input holding only prompt.txt (the
//      pass's brief, below) read-only, stdin closed, the competition's limits and wall budget (on a house
//      clock moved out by the house's time past its stated bound: the house clock, below; stdout
//      and stderr capped as a program/v1 entry's), and in its environment, of ours, exactly
//      contracts/agent.ts AGENT_ENV_NAMES (entryEnvironment): the prompt's path, the store's Admin
//      GraphQL URL and supplier URL, the shop token, the trial seed and the trial now, the env's origin
//      (AGENT_ENV_URL in a container), the forwarder's base URLs (never HTTP_PROXY: Node's fetch
//      ignores it) and the trial's entry key in both API key variables (entryLaneKey: the same on
//      every pass of the trial; on one pod, or given RunTrialOptions.entryKey, the run's own for the trial, below; the forwarder admits it alone, the header's lanes); beside them, as
//      SandboxSpec.secrets, its entrant's env-lane entry secrets (below)
//   6. once the entry has exited, broken a limit or run out of wall budget (REPLAY: or the forwarder
//      wrote /record/replay-miss.json, when the entry is stopped at once): SIGTERM to the env (`docker
//      kill --signal TERM`), which writes /state/export/ and exits within SERVICE_STOP_MS (its program's own end,
//      SandboxProcess.finished where its driver sets one: on k8s the collect of its /state and the pod's delete
//      come after, on the driver's bounds; programExitWithin), and beside it
//      to the forwarder, which settles every exchange, writes the cassette (LIVE) or its verdict (REPLAY)
//      and /record/result.json, and exits (with a target the house lane's forwarder the same way, once
//      the env has exited: the env is its client); the network removed
//   7. into the blob store: LIVE the cassette and every response body it lists (BLOB_FANOUT bodies at a
//      time, each lane's cassette beside the other's, a cassette only once its bodies are in), then each
//      stored cassette's request log (below); on both passes the
//      env's call log (calls.ndjson), every file of its export (state.json, products.csv) and the
//      export's program-outputs manifest (contracts/agent.ts TrialOutputs, canonical JSON), and the last
//      STDERR_TAIL_BYTES of the entry's stderr, masked of its entrant's secrets first (below)
//
// The request log. LIVE each forwarder also keeps the trial's masked model requests as one zstd blob
// (gateway/requests.ts, agent-fun/requests/v1) in its /record/blobs and names it in result.json
// (requests_sha256; requests_fault when it kept none). finishPass copies it into the blob store beside
// the cassette stored for that lane (storeRequestLog), TrialPass.requests_sha256 and
// house_requests_sha256, which the trial row keeps. It is a record no replay, score or digest reads, so
// it never faults or voids a pass: a forwarder that kept none, a copy that fails or a lane with no stored
// cassette leaves its field null, the failure a line on RunTrialOptions.log. A replay keeps none.
//
// The lanes. A bundle whose harness names a target (contracts/competition.ts AgentTarget: the models its
// env calls, at the house's expense) gets a second forwarder, the house lane: on the trial network as
// `house` (LIVE also on the egress bridge), its own /config (gateway.json: the policy from the target,
// policy.ts policyFromTarget, its model ids exact; LIVE its own upstream and key, with TrialUpstream
// `masq` a key of its own labelled .../house: masq.ts TrialKeySpec.role; beside an entrant's own keys
// the house's alone, EntrantTrialUpstream.house, masq the same way; and for a target whose models
// superbot-router serves, the router on the house's router key, never masq: upstream.ts routerUpstream,
// given as the house lane's config, TrialUpstream `masq`'s `house` or EntrantTrialUpstream.house, a
// static key no pass mints or retires, held and masked as a masq key is) and its own /record and
// cassette. It starts beside the entry's forwarder and is ready before the env starts, as the env's environment names
// it (contracts/agent.ts AGENT_HOUSE_ENV: its origin and the house token) and the env calls it as it starts; the
// entry's never does. A trial network lets every
// role reach every other (network.ts; on k8s one policy per trial, k8s-network.ts), so each forwarder
// admits one caller by a credential (passCredentials; grader/gateway/server.ts GatewayClient): `llm`
// the entry's key, which its two API key variables carry, derived from the trial so every pass of it
// hands the entry the same one (entryLaneKey: hygiene against an env calling `llm` by mistake, not a
// secret boundary; on one pod the run's own key for the trial, podEntryLaneKey, the header's One pod), and `house` the env's
// house token, random each pass and held by the env alone,
// which is the boundary keeping the entry off the house's models. REPLAY the house forwarder serves the live pass's house cassette (ReplaySource
// .house_cassette_sha256), so the env gets the target's answers as live; a miss there or an entry left
// unconsumed is nondeterministic as on the entry's lane. Any upstream error on the house lane voids
// the pass (upstream_errors: the house's fault, never the entry's), whatever the bundle's
// void_upstream_error_share. Its spend is the house's: its cassette's totals, never TrialPass.totals.
//
// The process driver (tests, `grade-local --driver process`) runs the same three programs as host
// processes: the services listen on loopback ports they pick (MAKEFUN_ENV_PORT and
// MAKEFUN_GATEWAY_PORT 0), their ready files name the ports, and the entry's URLs point there. A host
// process gets no SIGTERM through the Sandbox interface, so each service runs under a launcher this
// file writes into the pass's scratch (LAUNCHER_SCRIPT): the service's own script, in the launcher's
// process, with the end of stdin turned into that SIGTERM (on Windows, where a real one ends a Node
// process before any handler runs, the service's own SIGTERM listeners run instead: launcherSource).
//
// One pod (RunTrialOptions.hosted and door, on a sandbox with `pods`: grader/sandbox/types.ts SandboxPodPlan, the
// layout grader/sandbox/layout.ts calls `pod`; without all three a pass runs as above, exactly). The entry and the env
// are the two containers of ONE sandbox pod, `makefun-sbx-trial-<8 hex>` (TRIAL_POD_LABEL), and each forwarder is a
// hosted lane outside it (HostedServices, the grader's lanes pod), which the pod reaches through the door (Door) at the
// lanes pod's address:
//   1. what a grader that died mid-pass left of the trial removed (TrialNetworks.reap by its owner, as above); no
//      network is made: the pod's names are its hostAliases, `store` at 127.0.0.1 (served by `env` on 8080), `llm`
//      (with a target `house` too) at the door's address
//   2. the pod made (Sandbox.pods.open): `env`, the env as above under ENV_LIMITS with MAKEFUN_ENV_HOST=127.0.0.1 (it
//      listens on the loopback alone), MAKEFUN_SHOP_TOKEN and, with a target, the house lane's origin
//      `http://house:<the door's house port>` and the house token, its /state declaring the split pass's live files
//      and STATE_RETURNS (what the pass reads of it while the env runs comes from the pod's `watch`, what it reads
//      after the pod's close is the copy collected at the env's end); `entry`, the entry as above with entryEnvironment's
//      `http://store:8080` and `http://llm:<the door's entry port>` and its entry secrets; the pod's requests
//      RunTrialOptions.podRequests. Nothing is minted, staged or started until the scheduler has placed it
//      (SandboxPod.scheduled): a pod the node has no room for is void node_capacity with no key made
//   3. then, while the pod comes up: the keys minted as above; each lane's config and record directory under
//      HostedServices.root (the config file 0400, as for the process driver; a replay's blobs beside it); both lanes
//      started (HostedServices.spawn), each ready by its ready file within READY_TIMEOUT_MS, its config deleted then.
//      A lane reaches its upstream as a forwarder pod does: masq at MasqTrialUpstream.origin (server/config.ts
//      llmGatewaySandboxUrl, which the lanes pod's own egress admits), so checkRunOptions refuses a loopback origin
//      for it as for a pod
//   4. the pod's address admitted at the door to its two lanes (Door.admit); the env started in its container and
//      ready by its ready file (on 8080, the port `store` names); then the entry, once the driver has proved from
//      inside the entry's container that it cannot bind the env's port (a bind that succeeds is the platform's fault:
//      void `sandbox`, the entry never started)
//   5. once the entry is over, the services stopped in the order above (the env's SIGTERM in its own container, the
//      lanes' through their host, each lane exited), the address forgotten at the door and the pod deleted
//      (SandboxPod.close), and only then the scorer's pod made, so the entry never has two pods at once
// The door tells pods apart by their address alone, and the node hands a deleted pod's address to the next pod it
// makes, so on every path the pass's lanes are stopped and its address forgotten at the door BEFORE its pod is closed:
// the end above; a void or a fault thrown, and an abort (releasePass: every program, the lanes among them, killed and
// gone, then the forget, then the pod's close, the abort's release awaited before the end's); and the pod found gone or
// failed by the driver while the pass runs (a member's driver-failure exit: deleted behind its back, evicted, its node
// gone), when the address is forgotten and the lanes killed at once, the pass the sandbox's fault (a lane so cut is no
// `gateway` fault). Any other member's end that says the sandbox is over or may be forgets the address at once as
// well, before any wait of the end's, the lanes left to their ordered stop (their records are still the pass's): the
// pod out of memory (SandboxPod.oom: every member ends K8S_KILLED, once the driver has read the pod's status), the env
// ending before the pass told it to stop, an entry killed before its program ran when the pass did not ask for it
// (runPodPass's podSandboxOver). An ordinary end (the entry's own exit, its own status 137 among them; the env
// answering its SIGTERM) keeps the order above. The lanes program forgets the address too once both lanes have exited
// (server/sandbox-host/lanes.ts).
// The entry's lane key on one pod is the run's own for the trial (podEntryLaneKey), not the trial's entryLaneKey, which
// every entry on an instance shares: derived under the server's secret from the run, the instance and the index.
// grader/worker.ts computes it and hands the pass the key alone (RunTrialOptions.entryKey), never the secret, so the
// trial's live pass and its in-job replay hand the entry the same key, every other run (another entry's, or a later run
// of the same entry) holds another, and no entrant can derive it while the trial's passes run. The door lets every trial
// pod dial every lanes pod, so a pod that reaches another trial's `llm` lane without that run's key for that trial is
// refused by the lane itself; a pass on one pod given no key is refused before anything is made. Once the run is
// recorded its trial records carry the key (contracts/agent.ts AgentTrialRecord.entry_key), and every later replay reads
// it from there and hands it in as entryKey (grader/regrade.ts regradeAgentL2), on one pod or on the split layout (the
// public kit's replay), whose `llm` lane then admits that key instead of entryLaneKey's: no later replay needs the
// secret, so a rotated one changes no finished run's replays. The forwarder keys a cassette entry on its route, three
// version headers and its body (cassette.ts requestKey), never on the key's headers, so the key moves no recorded request.
// What shares that sandbox, plainly: the env's hidden state (/env-data, /state, its memory) and the house token sit in
// the same gVisor sandbox as the entrant's code, with its network namespace (loopback ports, abstract unix sockets) and
// its CPU and memory totals shared outright; each keeps its own PID and mount namespaces, its own /tmp, its own uid (the
// env 65533, the entry 65534) and a /dev/shm of its own by a mount over the path (a memory emptyDir), the pod's own
// /dev/shm reachable from the entry at no path. That is weaker than the env's pod of its own above. No key is in the
// pod: the forwarders, their configs and every key run outside it, and the entry's stand-in lane key (podEntryLaneKey) is the
// only *_API_KEY there. Only the pod's total memory is enforced: a pod out of memory once the entry ran
// (SandboxPod.oom) is the entry's memory, never a fault: LIVE `timeout`, scored as a timeout (timeoutScores), the
// entry's detail TRIAL_MEMORY_DETAIL; REPLAY nondeterministic, replay_timeout. A lane that exits mid-pass voids the pass
// as a forwarder's exit does (`gateway`; `sandbox` when its host failed it).
//
// The brief (trialBriefSource): the bytes copied to the entry's /input/prompt.txt are the instance's
// input/prompt.txt, except on a pass flagged as the house baseline's (RunTrialOptions.baseline) on an
// instance that holds reference/baseline-prompt.txt (BASELINE_PROMPT_FILE: a worded draw's brief in
// the practice wording, the same facts), whose bytes are copied instead. An unflagged pass, or a
// flagged one on an instance without that file, reads input/prompt.txt; a baseline-prompt.txt that is
// there but is no readable regular file is an instance fault, never a fallback. Either way /input
// holds prompt.txt alone and MAKEFUN_PROMPT_FILE names that one path, so no entry ever sees
// reference/. Each pass records the sha256 of the bytes it copied and whether they were the baseline's
// (TrialPass.prompt_sha256, baseline_prompt): a replay must read the brief its live pass read, so its
// caller passes the live pass's choice, not the entry's flag as it stands at the replay.
//
// The trial values (trialValues): the shop token, the trial seed and the trial now derive from the
// instance and the trial index alone, so a live pass and its replay hand the entry the same ones. The
// now is the instance's opening time, the store's every timestamp: the env seed's `openedAt`
// (input/env/seed.json, storesim/seed/v1) when it names one, else an instant derived like the others.
//
// The forwarder's config file (writeGatewayConfig) sits in a 0711 directory under a 0700 one of this
// process's own. Under the process driver the forwarder runs as this process's user and the file is
// 0400 (grader/gateway/main.ts refuses a config group or others may write). In a container the
// forwarder runs as 65534, which on Linux cannot read a 0400 file another uid owns, so the file is
// 0444 there and the 0700 directory above it keeps it from every other user of the host. Once its
// forwarder is ready the file is deleted (forgetGatewayConfig: each forwarder's, the house lane's
// included, LIVE and REPLAY alike), so a key in it, a masq key minted for the pass, the house's router
// key (a router-served target's house lane) or an entrant's own, sits on disk for the seconds a forwarder takes to start: the forwarder read it whole before it wrote
// its ready file (main.ts reads it once, at start) and holds it in memory, and never restarts (a k8s
// sandbox pod's restartPolicy is Never; a forwarder that exits mid-pass voids it, a gateway fault).
//
// How a pass ends (TrialPass.status):
//   LIVE    live_done  the entry exited (a crash, a broken limit or a spent budget included): its
//                      state export is scored (scoreTrialWithChecks: TrialPass.scores and .checks),
//                      unless the caller asks for no score
//           timeout    the wall budget ran out (on a house clock, the deadline the credit moved it to):
//                      it scores 0 on every column (timeoutScores) and is not replayed
//           void       an infrastructure fault, never the entry's (TrialPass.reason says which):
//                      upstream errors at the bundle's void_upstream_error_share (at least
//                      VOID_MIN_UPSTREAM_ERRORS), a sandbox, env, forwarder, instance, cassette or
//                      scorer fault, or a masq broker fault (MasqBrokerError.voidReason); the entry
//                      cut at its house clock's ceiling with the house's time owed past it
//                      (HOUSE_CLOCK_VOID_REASON, below); or
//                      node_capacity (NODE_CAPACITY_VOID_REASON), which is no fault at all but
//                      backpressure: the k8s node had no room for one of the pass's pods (a
//                      service's, the entry's or a preflight's: grader/sandbox/k8s.ts noRoomOf,
//                      NodeRoomError, its header's Room on the node), so the entry never ran. Its
//                      caller hands the trial back, counting no pass (grader/worker.ts)
//   REPLAY  finished   every cassette entry consumed, no miss, and the same state.json bytes as LIVE
//           nondeterministic  a cassette_miss (the entry is stopped at the first), entries left
//                      unconsumed, another state.json, or the wall budget running out with no model
//                      latency to wait on (replay_timeout; on a house clock its moved deadline)
//           void       an infrastructure fault, as LIVE
// A void still says what the pass spent (its cassette's totals), for the trial's voided spend.
//
// The house clock (grader/house-clock.ts): a competition with a row there (AgentSetup.competition, its slug) has its
// house side burn compute inside the trial wall, so its wall is charged for the house's time only up to what its rules
// state. On such a pass, LIVE and REPLAY alike, the env's call log (ENV_LOG_FILE, in the state directory the harness
// reads) is read while the entry runs, every HOUSE_CLOCK_POLL_MS and once more as its deadline falls due (the
// Supervisor's atDeadline), and the entry's deadline moved out by the credit (house-clock.ts houseCredit: the house's ms
// past its bound, at most the ceiling less the wall; the Supervisor's extendBudget, never shortened). An entry cut at its
// moved deadline is `timeout` (REPLAY replay_timeout) as ever: its own time ran out. One cut at the ceiling with more of
// the house's time owed it than the ceiling holds is void, HOUSE_CLOCK_VOID_REASON: the house alone ran it out. Each such
// pass whose entry ran says what it ran on (TrialPass.house_clock: a run flag, never in its state, outputs, cassette or
// score). A pass of any other competition reads no log and moves no deadline: as it ever was.
//
// A live pass reaches a model one of two ways (RunTrialOptions.upstream, PassUpstream): house-paid
// through masq (TrialUpstream), or on the entrant's own keys (EntrantTrialUpstream, below). House-paid,
// masq is its only route to a model but one: the forwarder's upstream is masq on a masq key (a test's
// fake instead), or for a router-served target's house lane superbot-router on the house's router key
// (below), never a provider's API itself (grader/gateway/upstream.ts). With TrialUpstream
// `masq` the pass mints a key of its own before anything starts (grader/gateway/masq.ts), the
// forwarder calls masq at MasqTrialUpstream.origin (server/config.ts llmGatewaySandboxUrl: under the
// docker driver a loopback origin is refused before anything runs, as no container reaches the host's
// loopback, and so is one naming its host under gVisor's own network stack with no resolv.conf for the
// forwarder, which then resolves no name: docker.ts NETSTACK_RUNTIME), and once the pass is over its key is retired (disabled, its spend read against the
// forwarder's meter; with a target the house lane's key beside it, each with its own settle reads). A retirement that fails is retried MASQ_RETIRE_RETRIES times with doubling
// backoff (disabling is idempotent); one that still fails voids a pass that would otherwise count, with
// the broker's voidReason. A refused admin key (masq.ts MasqAdminKeyRefusal) voids nothing: the mint
// rejects with it, runTrial rejects with it, and the grader stops (grader/worker.ts).
// The one exception is a target whose models superbot-router serves: its house lane runs on the router,
// never masq, on the house's router key (TrialUpstream `masq`'s `house`, or EntrantTrialUpstream.house,
// a config on upstream.ts's `router` adapter and its key). That key is static, held and masked as a masq
// key is (passSecretForms): the pass mints no house key, retires nothing for the lane, and leaves
// TrialPass.house_masq null, the house cassette's totals its spend as on masq. The router's origin is
// public, reached over the egress bridge as a provider's is (on k8s makefun-sandbox-egress, no policy of
// its own), and checked as a provider's (checkRouterOrigin, as checkProviderOrigins): loopback refused
// under a containerized sandbox, a named host under gVisor's own network stack with no resolv.conf.
//
// The entrant's own keys (EntrantTrialUpstream: its provider-lane entry secrets; house money never pays
// for an entrant's model calls). The entry's forwarder runs upstream.ts's `provider` adapter
// (entrantLaneConfig) on `keys`, the entrant's own by provider, each request going to the provider its
// model names on that provider's key; with no key for that provider (none at all included, the entry
// then running model-free) the forwarder answers the call itself, a 401 naming the entry secret that
// carries one and how to push it (or, with EntrantKeys.entrySecrets `off`, the config's
// `entry_secrets`, that pushing one is not open on this deployment yet), recorded like any answer. Its
// `mask` values (the org and project ids the worker's key check learned, beside the entry's env-lane
// secrets) are masked with the keys, every form of each, of them those the config takes (forwarderMask:
// dropped, never thrown on). No masq key is
// minted for the entry lane (TrialPass.masq stays null) and none is needed: no broker, no masq origin. The pass reads its void
// rule on credential `entrant` (TrialPass.credential, passCredential): an upstream error answered 401,
// 402, 403, 407 or 429 there is the entrant's (a key refused, revoked, out of credit or rate-limited,
// or the forwarder's own no-key 401) and counts toward no void, so revoking a key never re-rolls a
// trial (meter.ts); a 5xx, a 529, a connect failure or a reset still does. The keys reach the
// forwarder's gateway.json alone, deleted once it is ready (the config file, above): never a
// SandboxSpec's env, whose *_API_KEY variables a k8s sandbox puts into the pod's Secret
// (grader/sandbox/k8s.ts SECRET_ENV_RE), and the entry keeps its trial's own key (entryEnvironment).
// With a target, EntrantTrialUpstream.house is required and runs the house lane on the house's key, as
// TrialUpstream does (on masq: a key minted with role house, the target's budget and models; for a
// router-served target the router config and the house's router key, nothing minted), never the
// entrant's (main.ts refuses the provider adapter on lane house). The forwarder reaches each provider it
// holds a key for at that provider's own origin (grader/gateway/providers.ts, the one platform module
// that names them) over the egress bridge (network.ts trialAttachment: on k8s makefun-sandbox-egress,
// the public internet, k8s-network.ts); under gVisor's own network stack it resolves that name only with a resolv.conf of its own,
// so a pass there with none is refused before anything runs (checkProviderOrigins), as a named masq
// origin is. A replay runs on no key at all: its cassette serves every answer, a forwarder's own 401
// included.
//
// The entrant's env-lane entry secrets (RunTrialOptions.secrets, NAME to value: contracts/entry-secrets.ts,
// every name but the provider lane's): variables of the entry's own sandbox (SandboxSpec.secrets, which
// every driver carries out of band: grader/sandbox/types.ts checkSandboxSecrets), the same on a live pass
// and its replay; never the env's, a forwarder's or the scorer's, and never a house-paid pass's (a masq or
// config upstream refuses them). The provider lane's keys never enter a sandbox (above). Every form of
// every value the pass holds (upstream.ts secretFormSet over the env lane's values, the keys and the
// ids their check learned) is masked out of what the pass stores or says: the entry's forwarder masks
// them out of every answer and the cassette (its `mask`), and the env lane's out of each request before
// it is keyed (its `request_mask`, the replay's forwarder given the same: grader/gateway/server.ts), so
// the replay keys each request as live did; the stored stderr tail is the masked stderr's tail
// (secret-mask.ts SECRET_MARK); and the pass's error, a fault's words included, is redacted
// (REDACTED_MARK). Every masq key a lane of the pass runs on (each key it mints, the house lane's beside
// an entrant's keys included, and a config's on the masq adapter, minted elsewhere), and the house's
// router key a config on the `router` adapter carries, in every variant, is masked out of those two as well (passSecretForms), house-paid or not: no entry is told one (it holds its trial's
// own key, entryLaneKey or on one pod podEntryLaneKey), so this is defence in depth; a `fake` or `none` config's key is no secret
// and is not. The env's export and call log are never masked, since they are scored and replayed
// byte for byte: a caller scans them (secretsInPassOutputs, secret-mask.ts findForms) and says which
// secret's NAME turned up where.
//
// Abort (opts.signal): every program of the pass is killed at once (entry, env, forwarder, scorer),
// the network removed (on one pod: once the lanes are gone, the address forgotten at the door, then the pod closed), the scratch
// deleted, a minted key disabled as well as it can be, and runTrial rejects with the signal's reason.
//
// Scratch: the pass's (runTrial) and a scoring's (scoreTrialWithChecks) are held from mkdtemp until
// removed (grade.ts holdScratch, its header's Releasing), so on a docker sandbox whose daemon is in a VM
// each is released once, after it is gone, with everything removed under it meanwhile: never while
// its pass runs, and not at all under a root its caller holds (worker.ts's, a CLI's), whose own
// release takes it.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, posix } from 'node:path';
import type { z } from 'zod';
import {
  AGENT_ENTRY_ENV,
  AGENT_ENTRY_KEY_RE,
  AGENT_ENV_NAMES,
  AGENT_GATEWAY_ENV,
  AGENT_HOUSE_ENV,
  AGENT_SHOP_GRAPHQL_URL,
  AGENT_TRIAL_DUMMY_KEY,
  TRIAL_OUTPUTS_FORMAT,
  TrialOutputs,
  type CassetteT,
  type TrialOutputsT,
} from '../contracts/agent.ts';
import { scorerDirOf, type AgentHarnessT, type AgentInferenceT, type AgentTargetT, type Leaderboard, type ProgramHarness } from '../contracts/competition.ts';
import { SECRET_PROVIDER_NAME, SECRET_PROVIDERS, type SecretProvider } from '../contracts/entry-secrets.ts';
import { Sha256Hex } from '../contracts/primitives.ts';
import { BlobStore } from '../server/blobstore.ts';
import { isLoopbackOrigin } from '../server/config.ts';
import { comparePaths } from '../server/repos/index-tar.ts';
import { canonicalJson, sha256Hex } from '../sim/canonical.ts';
import type { GatewayBundle } from './gateway/bundle.ts';
import { CassetteError, parseCassette, readCassette, type CassetteBlobs, type ReplayVerdict } from './gateway/cassette.ts';
import { BLOBS_DIR, CASSETTE_FILE, CONFIG_FILE, GATEWAY_CONFIG_FORMAT, GATEWAY_RESULT_FORMAT, GatewayConfig, MISS_FILE, READY_FILE, RESULT_FILE, type GatewayConfigT } from './gateway/main.ts';
import { MasqBrokerError, masqUpstreamConfig, retireTrialKey, type MasqBroker, type MintedTrialKey, type RetiredTrialKey, type TrialKeySpec } from './gateway/masq.ts';
import { ENTRANT_ERROR_STATUSES, voidVerdictOf, type Credential, type VoidVerdict } from './gateway/meter.ts';
import { policyFromInference, policyFromTarget, type GatewayPolicyT } from './gateway/policy.ts';
import { findForms, FormIndex, maskBytes, secretForms, type FormSet } from './gateway/secret-mask.ts';
import { MAX_LEARNED_IDS, MaskValue, redactForms, secretFormSet, UpstreamConfig, UpstreamKey, type EntrySecretsOpenT, type UpstreamConfigT } from './gateway/upstream.ts';
import { holdScratch, removeScratch } from './grade.ts';
import { HOUSE_CLOCK_POLL_MS, houseClockOf, houseCredit, houseMsOf, type HouseClockPass, type HouseClockRow, type HouseClocks, type HouseCredit } from './house-clock.ts';
import { scoreProgramBreakdown } from './harnesses.ts';
import { directoryManifest, directoryManifestAsync, MAX_OUTPUT_BYTES, MAX_OUTPUT_FILES, MAX_PROGRAM_STDOUT_BYTES, programDataDigest, sealStaged, type ProgramSetup } from './program.ts';
import { scoredColumns, ScorerError, type ProgramScores, type ScorerChecksT } from './program-scores.ts';
import { MAX_STDERR_BYTES, type LimitsT } from './run.ts';
import { DockerSandbox, NETSTACK_RUNTIME } from './sandbox/docker.ts';
import { describeExit, Stopped, Supervisor } from './sandbox/io.ts';
import { K8S_KILLED, k8sTerminate, LOOPBACK, NodeRoomError, noRoomOf } from './sandbox/k8s.ts';
import { RECORD_RETURNS, STATE_RETURNS } from './sandbox/mounts.ts';
import { podsOf, type SandboxLayout } from './sandbox/layout.ts';
import {
  dockerExec,
  ENV_LIMITS,
  ROLE_ALIASES,
  SERVICE_LIMITS,
  serviceEndpoint,
  trialAttachment,
  trialNetworkName,
  trialNetworksOf,
  TRIAL_OWNER_RE,
  type DockerExec,
  type NetworkOptions,
  type ReapResult,
} from './sandbox/network.ts';
import {
  checkSandboxSecrets,
  containerized,
  SandboxError,
  type Door,
  type HostedProcess,
  type HostedServices,
  type PodRequests,
  type Runtime,
  type Sandbox,
  type SandboxExit,
  type SandboxLiveFile,
  type SandboxMount,
  type SandboxNetwork,
  type SandboxPod,
  type SandboxPodPlan,
  type SandboxPods,
  type SandboxProcess,
  type SandboxSpec,
  type TerminableProcess,
  type TreeMeter,
  type TreeMeterOptions,
  type TrialNetworks,
} from './sandbox/types.ts';

// ---------------------------------------------------------------- constants

/** How long the env and the forwarder have to write their ready files, from their program's start (SandboxProcess.started). */
export const READY_TIMEOUT_MS = 30_000;
/** A void that is backpressure, not a fault: the node had no room for one of the pass's pods (the header's How a pass ends). */
export const NODE_CAPACITY_VOID_REASON = 'node_capacity';
/** A void that is the house's time, not the entry's: cut at its house clock's ceiling with more owed it (the header's house clock). */
export const HOUSE_CLOCK_VOID_REASON = 'house_clock';
/** How long a service has to exit after its SIGTERM (the env writes its export, the forwarder its cassette) before it is killed: to its program's end (programExitWithin). */
export const SERVICE_STOP_MS = 30_000;
const READY_POLL_MS = 50;
/** How often a replay looks for the forwarder's miss file while the entry runs. */
export const MISS_POLL_MS = 100;
/** The entry's stderr kept as a blob: its last this many bytes. */
export const STDERR_TAIL_BYTES = 64 * 1024;
/** A service's stdout and stderr kept for a fault's message: the last this many bytes. */
const SERVICE_LOG_BYTES = 16 * 1024;

/** The containers' name stems (docker.ts containerName: makefun-<label>-<hex>); `house` the house lane's forwarder. */
export const TRIAL_LABELS = Object.freeze({ entry: 'trial-agent', env: 'trial-env', forwarder: 'trial-llm', house: 'trial-house' } as const);

/** The stem of a trial's one pod (the header's One pod): makefun-sbx-trial-<8 hex>. */
export const TRIAL_POD_LABEL = 'trial';

/** The entry's detail (EntryRun.detail) of a pass whose one pod ran out of memory once the entry ran (the header's One pod). */
export const TRIAL_MEMORY_DETAIL = "the trial's memory ran out";

/**
 * The sandbox pods one pass of a trial has running at once on a containerized driver: on the `split` layout (the
 * default) the env, the forwarder and the entry, and with a target the house lane's forwarder (the header's lanes); on
 * `pod` the one pod (the header's One pod), with or without a target. What the node must have room for before a pass
 * sets out (grader/worker.ts).
 */
export function trialPods(harness: Pick<AgentHarnessT, 'target'>, layout: SandboxLayout = 'split'): number {
  return podsOf(layout, harness.target === undefined ? 3 : 4);
}

/** The env's process contract (competitions/<slug>/src/server/http.ts): what the harness reads of it. */
export const ENV_SEED_FILE = 'seed.json';
export const ENV_READY_FILE = 'ready';
export const ENV_LOG_FILE = 'calls.ndjson';
export const ENV_EXPORT_DIR = 'export';
/** The canonical state the replay must reproduce byte for byte. */
export const STATE_FILE = 'state.json';
/** The one file the entry sees under /input, the pass's brief: from the instance's input/ (see trialBriefSource). */
export const PROMPT_FILE = 'prompt.txt';
/**
 * A worded instance's brief in the practice wording (the same facts), under its reference/: what a
 * pass flagged as the house baseline's copies to /input/prompt.txt instead, when the instance has it
 * (see the header and trialBriefSource).
 */
export const BASELINE_PROMPT_FILE = 'baseline-prompt.txt';
/** The store's Admin GraphQL path (contracts/agent.ts AGENT_SHOP_GRAPHQL_URL's) and the supplier's REST root, on the store's origin. */
export const SHOP_GRAPHQL_PATH = new URL(AGENT_SHOP_GRAPHQL_URL).pathname;
export const SUPPLIER_PATH = '/supplier/v1';

/** The process driver's launcher, in its own directory per service (see the header). */
export const LAUNCHER_SCRIPT = 'launch.mjs';

/** The forwarder's config: its file's mode per driver, its directory's, and the private directory's above it (see the header). */
export const GATEWAY_CONFIG_FILE_MODES: Readonly<Record<Sandbox['kind'], number>> = Object.freeze({ process: 0o400, docker: 0o444, k8s: 0o444 });
export const GATEWAY_CONFIG_DIR_MODE = 0o711;
export const PRIVATE_DIR_MODE = 0o700;

/** A failed key retirement is retried this many times, the first after MASQ_RETIRE_BACKOFF_MS, each next one twice as late. */
export const MASQ_RETIRE_RETRIES = 3;
export const MASQ_RETIRE_BACKOFF_MS = 1_000;

/** The trial now when the instance names no opening time: an instant in the year from here (see trialValues). */
const TRIAL_NOW_EPOCH_MS = Date.UTC(2026, 0, 1);
const TRIAL_NOW_SPAN_S = 365 * 86_400;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------- types

type LeaderboardT = z.infer<typeof Leaderboard>;
type ProgramHarnessT = z.infer<typeof ProgramHarness>;

/** A trial: its index in the run (the draw's trial t) and the instance it runs on. */
export interface TrialRef {
  index: number;
  instance_sha256: string;
}

/** The bundle's side of a trial. */
export interface AgentSetup {
  /**
   * Absolute competition directory: holds the scorer the harness names, and the env unless envDir names it. On the k8s
   * sandbox, the scorer's stage on the data claim, which holds it at the bundle's own path (grader/worker.ts stageAgentSetup).
   */
  compDir: string;
  harness: AgentHarnessT;
  leaderboard: Pick<LeaderboardT, 'columns'>;
  /**
   * Absolute env directory, mounted at /bot for the env, when it is not the bundle's own under compDir: on the k8s
   * sandbox its stage on the data claim (grader/worker.ts stageAgentSetup), the same tree byte for byte.
   */
  envDir?: string;
  /**
   * The competition's slug, which its house clock is keyed by (grader/house-clock.ts; the header's house clock). Absent,
   * or a slug with no row there: the pass's wall budget is fixed, as ever.
   */
  competition?: string;
}

export interface TrialSnapshot {
  /** Host directory mounted read-only at /bot: a freshly materialized snapshot of the entry. */
  dir: string;
  runtime: Runtime;
  /** Run this image digest instead of the pinned one (an L2 regrade's stored digest). */
  imageDigest?: string | null;
}

/** masq on a key of the pass's own (see the header). */
export interface MasqTrialUpstream {
  broker: MasqBroker;
  /** What the key is minted for (its label, budget backstop, models and lifetime). */
  key: TrialKeySpec;
  /** masq's origin as the forwarder reaches it (server/config.ts llmGatewaySandboxUrl). */
  origin: string;
  /** ms before the first retry of a failed retirement, doubling after (default MASQ_RETIRE_BACKOFF_MS). */
  retireBackoffMs?: number;
}

/**
 * LIVE, house-paid: where the forwarder sends what its policy admits, which is masq and nothing else
 * but a router-served target's house lane (see the header): `masq` on a key the pass mints and retires
 * itself (and, with a target, the house lane's key besides, unless `house` gives the lane its own
 * upstream: superbot-router's config and the house's router key, when nothing is minted or retired for
 * the lane), or `config` and `key` as main.ts GatewayConfig carries them (masq on a key minted
 * elsewhere, or a test's `fake`; never the `provider` adapter, which runs on an entrant's keys:
 * EntrantTrialUpstream), with `house` the house lane's when the target has one of its own (absent: the
 * same config and key serve it).
 */
export type TrialUpstream =
  | { config: UpstreamConfigT; key: string; house?: { config: UpstreamConfigT; key: string } }
  | { masq: MasqTrialUpstream; house?: { config: UpstreamConfigT; key: string } };

/**
 * The entrant's own keys an entry lane runs on (see the header's entrant's own keys): `keys` by provider
 * (its provider-lane entry secrets, each a header-safe UpstreamKey; none at all runs the entry
 * model-free, each of its calls answered 401 by the forwarder itself), `mask` the values masked with
 * them (the org and project ids the worker's key check learned: forwarderMask keeps those the
 * forwarder's config takes), `origins` and `ca` a test's fake provider in place of each provider's own
 * origin (upstream.ts ProviderUpstreamConfig: https and verified TLS whatever they say), and
 * `entrySecrets` whether this deployment lets an entrant push a secret at all (upstream.ts
 * EntrySecretsOpen: `off` with no seal public key, the worker's entrantLane), which the config's
 * `entry_secrets` carries to the no-key 401's words (absent: `on`). The env lane's secrets are the pass's
 * own (RunTrialOptions.secrets), never here.
 */
export interface EntrantKeys {
  keys: Readonly<Partial<Record<SecretProvider, string>>>;
  mask: readonly string[];
  origins?: Readonly<Partial<Record<SecretProvider, string>>>;
  ca?: string;
  entrySecrets?: EntrySecretsOpenT;
}

/**
 * The house lane's upstream beside an entrant's keys, the house's and never the entrant's: `masq` on a
 * key the pass mints for it (MasqTrialUpstream.key the pass's own spec, from which the house key is
 * derived as on TrialUpstream `masq`: role house, the target's budget and models), or `config` and
 * `key` as main.ts GatewayConfig carries them (a router-served target's: the `router` adapter on the
 * house's router key, nothing minted; never the `provider` adapter).
 */
export type HouseLaneUpstream = { masq: MasqTrialUpstream } | { config: UpstreamConfigT; key: string };

/**
 * LIVE on the entrant's own keys (see the header): the entry lane on `provider`, with no masq key of
 * its own (no broker or masq origin is needed for it), and the house lane on `house`, which a target
 * requires and a trial without one refuses.
 */
export interface EntrantTrialUpstream {
  provider: EntrantKeys;
  house?: HouseLaneUpstream;
}

/** What a live pass runs on: house-paid (TrialUpstream), or the entrant's own keys (EntrantTrialUpstream). */
export type PassUpstream = TrialUpstream | EntrantTrialUpstream;

/** REPLAY: what the live pass recorded. */
export interface ReplaySource {
  /** Its cassette, in the blob store with every response body it lists. */
  cassette_sha256: string;
  /** The state.json it exported: the bytes the replay must reproduce. */
  state_sha256: string;
  /** With a target (and only then): its house lane's cassette (TrialPass.house_cassette_sha256), stored as the other is. */
  house_cassette_sha256?: string;
}

/** Where a pass's records go (server/blobstore.ts BlobStore fits); putFile, when there, stores a large env log without holding it. */
export interface TrialBlobs extends CassetteBlobs {
  putFile?(path: string): Promise<{ sha256: string }>;
}

export interface RunTrialOptions {
  mode: 'live' | 'replay';
  sandbox: Sandbox;
  snapshot: TrialSnapshot;
  /** The instance's directory: input/prompt.txt, input/env/ (the env's seed), reference/ (the scorer's). Its digest must be trial.instance_sha256. */
  instanceDir: string;
  trial: TrialRef;
  /**
   * The pass is the house baseline's (default false): it reads the instance's
   * reference/baseline-prompt.txt as its brief when the instance has one (trialBriefSource). A replay
   * takes its live pass's choice (TrialPass.baseline_prompt), so it reads the same brief.
   */
  baseline?: boolean;
  setup: AgentSetup;
  /** The competition's limits: the entry's resources and wall budget, and the scorer's. */
  limits: LimitsT;
  /** The forwarder's rules (default setup.harness.inference). */
  inference?: AgentInferenceT;
  /**
   * LIVE: the pricing revision both lanes meter the pass on (gateway/policy.ts GatewayPolicy.pricing_rev): its run's
   * (grader/spend-revision.ts runPricingRev, which grader/worker.ts names at the trial's start), so every trial of a run
   * and its house lane's cassette share one table whichever release's grader runs it. Absent: the bundled table.
   */
  pricingRev?: string;
  /** LIVE: the upstream, house-paid or the entrant's own keys (PassUpstream). */
  upstream?: PassUpstream;
  /**
   * The entrant's env-lane entry secrets, NAME to value (see the header): the entry's SandboxSpec.secrets, masked in every
   * form out of what the pass stores and says, and out of each request its forwarder keys. A replay takes exactly its live
   * pass's (run_trial.entry_secret_ids). Never with a house-paid upstream (masq, or a config and key).
   */
  secrets?: Readonly<Record<string, string>>;
  /** REPLAY: what the live pass recorded. */
  cassette?: ReplaySource;
  /** The forwarder (grader/gateway/bundle.ts gatewayBundle). */
  gateway: Pick<GatewayBundle, 'dir' | 'script'>;
  /** A directory the pass may use: its scratch is made in it and deleted before runTrial settles. */
  workDir: string;
  blobs: TrialBlobs;
  /** Aborting it kills every program of the pass, and runTrial rejects with its reason. */
  signal?: AbortSignal;
  /** LIVE: score a live_done pass's export (default true); false leaves its scores null, for scoreTrial later. */
  score?: boolean;
  /** The docker CLI for the network and the services' SIGTERM (default: the docker sandbox's own CLI). */
  docker?: NetworkOptions;
  /**
   * Whose trial this is, as a label value (network.ts TRIAL_OWNER_RE), under which the trial's passes
   * run one at a time (the pipeline's worker.ts trialOwner, `<run id>.<trial index>`). On the docker
   * driver the pass first removes every network labelled makefun.trial=<owner> and the containers on
   * each (what a grader that died mid-pass left: network.ts reapTrial), then labels its own network
   * with it. Absent: no label, nothing removed.
   */
  owner?: string;
  /** Told what that removal took (and could not), each time it ran. */
  onReap?: (reaped: ReapResult) => void;
  /** The house clocks the pass reads setup.competition's row from (default grader/house-clock.ts HOUSE_CLOCKS; tests hand their own). */
  houseClocks?: HouseClocks;
  /**
   * Where the pass's forwarders run outside every sandbox the entry runs in (the header's One pod: the grader's lanes).
   * With `door`, on a sandbox with `pods`, the pass runs on one pod; else it is ignored and the pass runs as ever.
   */
  hosted?: HostedServices;
  /** The door the one pod reaches its lanes by (the header's One pod), with `hosted`. */
  door?: Door;
  /**
   * The entry's lane key for this pass when it is not the trial's public one (entryLaneKey): AGENT_ENTRY_KEY_RE's shape,
   * on one pod the run's own for the trial (podEntryLaneKey, which grader/worker.ts computes; a later replay reads it from
   * the trial's record, AgentTrialRecord.entry_key). A pass given `hosted` and `door` requires it (refused before
   * anything is made without it); a pass without them that is given one (a replay on the split layout of a run that ran
   * one pod: the public kit's) hands the entry that key, and its `llm` lane admits it alone. Never the secret.
   */
  entryKey?: string;
  /** The one pod's total requests (SandboxPodPlan.requests: grader/sandbox/layout.ts podRequestsOf); absent, the driver's rule. */
  podRequests?: PodRequests;
  /**
   * Where a request log that is not kept is reported (storeRequestLog: its forwarder's fault or its copy's), a line
   * naming no secret; default console.warn (a report, not an error: server/ops/errors.ts counts every console.error).
   */
  log?: (line: string) => void;
}

export type TrialPassStatus = 'live_done' | 'timeout' | 'void' | 'finished' | 'nondeterministic';

/**
 * Why a pass is void (TrialPass.reason on a void): run_trial.void_reason. A masq_* reason is a broker
 * fault's (MasqBrokerError.voidReason, masq_<op>_failed: masqVoidReason), one for each MasqBrokerOp:
 *   masq_mint_failed       a key's mint (the pass's own, or the house lane's) failed, its admin-key pin read included
 *   masq_key_ready_failed  masq never answered a key it had just minted (masq.ts awaitKey: 401 past MASQ_KEY_WARMUP_MS, or another answer): that key is disabled
 *   masq_disable_failed    a key's retirement could not disable it, MASQ_RETIRE_RETRIES retries spent
 *   masq_spend_failed      a key's retirement could not read its settled spend, MASQ_RETIRE_RETRIES retries spent
 *   masq_requests_failed   a page of a key's requests could not be read: no pass reads one (server/metering/sync.ts does)
 *   masq_admin_key_failed  the admin key's own pin could not be read: no pass reads it alone (a mint's read fails as the mint)
 * and house_clock (HOUSE_CLOCK_VOID_REASON): the entry was cut at its house clock's ceiling with the house's time past
 * its bound owed beyond it (the header's house clock), the platform's fault.
 */
export type TrialVoidReason =
  | 'upstream_errors' | 'sandbox' | 'env' | 'gateway' | 'instance' | 'cassette' | 'scorer' | typeof NODE_CAPACITY_VOID_REASON | typeof HOUSE_CLOCK_VOID_REASON
  | 'masq_mint_failed' | 'masq_key_ready_failed' | 'masq_disable_failed' | 'masq_spend_failed' | 'masq_requests_failed' | 'masq_admin_key_failed';

/** What made a replay nondeterministic (TrialPass.reason). */
export type ReplayFault = 'cassette_miss' | 'cassette_unconsumed' | 'state_mismatch' | 'replay_timeout';

/** How the entry's run ended. */
export interface EntryRun {
  /** exited: on its own (any code); limit: stopped for a broken limit (stdout, stderr); timeout: the wall budget ran out; stopped: the harness stopped it (a replay miss, a service that died). */
  ended: 'exited' | 'limit' | 'timeout' | 'stopped';
  exit: SandboxExit | null;
  wall_ms: number;
  /** How it ended, in words; null for a clean exit 0. */
  detail: string | null;
}

export interface TrialPass {
  mode: 'live' | 'replay';
  status: TrialPassStatus;
  /** void: a TrialVoidReason; nondeterministic: a ReplayFault; otherwise null. */
  reason: string | null;
  /** The detail behind a void or a nondeterministic pass, for admins; null otherwise. */
  error: string | null;
  trial: TrialRef;
  /** The trial network's suffix (makefun-net-<name> on the docker driver). */
  name: string;
  /** sha256 of the brief copied to the entry's /input/prompt.txt (trialBriefSource); null when the pass ended before it was copied. */
  prompt_sha256: string | null;
  /** Whether that brief is the instance's reference/baseline-prompt.txt; false when it is input/prompt.txt, or none was copied. */
  baseline_prompt: boolean;
  /** Null when the entry never started. */
  entry: EntryRun | null;
  /** LIVE: the cassette recorded (stored); REPLAY: the one replayed. Null when none was written. */
  cassette_sha256: string | null;
  /** LIVE: the cassette's pricing revision and totals (what the pass spent, a void's included). */
  pricing_rev: string | null;
  totals: CassetteT['totals'] | null;
  /**
   * LIVE: whose key the entry lane ran on (passCredential), which decides whose fault a refused key is
   * (meter.ts Credential): `house` on masq (TrialUpstream), `entrant` on the entrant's own keys
   * (EntrantTrialUpstream). REPLAY: null, as a replay runs on no key.
   */
  credential: Credential | null;
  /** LIVE: the void rule's verdict over the cassette, read on `credential` (meter.ts voidVerdictOf: on `entrant` its entrant_errors count toward no void). */
  void_verdict: VoidVerdict | null;
  /** REPLAY: the forwarder's verdict. */
  replay: ReplayVerdict | null;
  /** The state.json the env exported this pass. */
  state_sha256: string | null;
  /** The export as program outputs, each file stored; and that manifest's canonical JSON, stored. */
  outputs: TrialOutputsT | null;
  outputs_sha256: string | null;
  /** The env's call log, stored. */
  env_log_sha256: string | null;
  /** The entry's stderr tail, stored. */
  stderr_sha256: string | null;
  /** LIVE: the scorer's scores (live_done), 0 on every scored column (timeout), else null. */
  scores: ProgramScores | null;
  /**
   * LIVE live_done: the per-check rows the scorer wrote beside those scores (scoreTrialWithChecks; the run's checks
   * trace), null when it wrote none or they were dropped (checks_issue); null on every other pass.
   */
  checks: ScorerChecksT | null;
  /** LIVE live_done: why the scorer's checks.json was dropped (malformed), the scores standing as without it; else null. */
  checks_issue: string | null;
  /** LIVE on masq: the key minted (its id, never the key), its retirement, and the run flags that sets. Null on the entrant's own keys, which mint none. */
  masq: { key_id: string; retired: RetiredTrialKey | null; flags: string[] } | null;
  /**
   * With a target: LIVE the house lane's cassette recorded (stored; its totals are the house's spend,
   * never the pass's), REPLAY the one replayed. Null without a target, or when none was written.
   */
  house_cassette_sha256: string | null;
  /** REPLAY with a target: the house forwarder's verdict. */
  house_replay: ReplayVerdict | null;
  /** LIVE on masq with a target: the house lane's key, as `masq` is the entry's (on the entrant's own keys too, its house lane on masq: EntrantTrialUpstream.house). */
  house_masq: { key_id: string; retired: RetiredTrialKey | null; flags: string[] } | null;
  /**
   * LIVE: the entry lane's request log (gateway/requests.ts, agent-fun/requests/v1), copied from its forwarder's record
   * into the blob store beside its cassette (storeRequestLog); null when the forwarder kept none, the log failed there,
   * its copy failed (logged, never a fault: the header's `request log`), or the cassette was not stored. REPLAY: null
   * (a replay keeps none). Set on every pass runTrial returns; optional only so a pass built by hand need not name it.
   */
  requests_sha256?: string | null;
  /** LIVE with a target: the house lane's request log, as requests_sha256 is the entry lane's (null beside no house_cassette_sha256). */
  house_requests_sha256?: string | null;
  /**
   * On a house clock (the header's), once the entry ran: the house's ms in the env's call log as the entry ended, the
   * bound its rules state, and the credit the entry's deadline stood at (a run flag: house-clock.ts houseClockFlag).
   * Absent on every other pass, which is as it ever was.
   */
  house_clock?: HouseClockPass;
}

/** An infrastructure fault that voids the pass (never the entry's): runTrial makes it a void pass with its reason; trialBriefSource throws it. */
export class TrialFault extends Error {
  readonly reason: TrialVoidReason;
  constructor(reason: TrialVoidReason, message: string) {
    super(message);
    this.name = 'TrialFault';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------- trial values and paths

/** The values a trial hands its entry, the same on its live pass and its replay (see the header). */
export interface TrialValues {
  /** MAKEFUN_SHOP_TOKEN: shpat_ and 32 hex digits. */
  shop_token: string;
  /** MAKEFUN_TRIAL_SEED: a u64, in decimal. */
  seed: string;
  /** MAKEFUN_TRIAL_NOW: an RFC 3339 UTC instant. */
  now: string;
}

function derived(purpose: string, trial: TrialRef): Buffer {
  return createHash('sha256').update(`agent-fun/trial-${purpose}/v1\n${trial.instance_sha256}\n${trial.index}`, 'utf8').digest();
}

/** The trial's values; `openedAt` is the instance's opening time (ISO-8601 UTC), or null to derive one. */
export function trialValues(trial: TrialRef, openedAt: string | null): TrialValues {
  checkTrial(trial);
  let now = openedAt;
  if (now === null) {
    const s = derived('now', trial).readUInt32BE(0) % TRIAL_NOW_SPAN_S;
    now = new Date(TRIAL_NOW_EPOCH_MS + s * 1000).toISOString().replace('.000Z', 'Z');
  } else if (!ISO_UTC_RE.test(now) || !Number.isFinite(Date.parse(now))) {
    throw new TypeError(`opening time ${JSON.stringify(now)} is not an ISO-8601 UTC instant`);
  }
  return {
    shop_token: `shpat_${derived('shop-token', trial).toString('hex').slice(0, 32)}`,
    seed: derived('seed', trial).readBigUInt64BE(0).toString(),
    now,
  };
}

/** The instance's opening time: its env seed's `openedAt`, when the seed is JSON naming an ISO-8601 UTC instant; else null. */
export async function instanceOpenedAt(instanceDir: string): Promise<string | null> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(join(instanceDir, 'input', 'env', ENV_SEED_FILE), 'utf8'));
  } catch {
    return null;
  }
  const v = doc !== null && typeof doc === 'object' ? (doc as Record<string, unknown>).openedAt : undefined;
  return typeof v === 'string' && ISO_UTC_RE.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * An instance's digest: grader/instance.ts's instance_sha256 (program.ts programDataSha256 over its input/ and reference/).
 * Each file's sum is kept for the process while its stat holds (version.ts treeFileSums): a tree checked again reads no file.
 * A tree with nothing at all at its path (not even a link) is the tree of no file, as an empty directory is: the digest
 * covers files alone, and a copy that carries files only drops a directory that holds none (the tier mirror off the
 * data claim, server/blob-tier/mirror.ts), so an instance whose input/ or reference/ the seal says is empty digests the
 * same on the claim and off it. A digest is only ever held to a record's, so a tree that is missing and was not empty
 * still digests otherwise and is refused there.
 */
export function instanceSha256(instanceDir: string): string {
  return programDataDigest(treeManifestOrEmpty(join(instanceDir, 'input')), treeManifestOrEmpty(join(instanceDir, 'reference')));
}

/** instanceSha256 with both trees walked and read on fs/promises (version.ts treeFileSumsAsync): what a trial checks its instance by. */
export async function instanceSha256Async(instanceDir: string): Promise<string> {
  const [input, reference] = await Promise.all([treeManifestOrEmptyAsync(join(instanceDir, 'input')), treeManifestOrEmptyAsync(join(instanceDir, 'reference'))]);
  return programDataDigest(input, reference);
}

const isEnoent = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

/** directoryManifest of `dir`, [] when nothing at all is there (instanceSha256: the tree of no file). An ENOENT under it (a file gone mid-walk, a link leading nowhere) is thrown. */
function treeManifestOrEmpty(dir: string): ReturnType<typeof directoryManifest> {
  try {
    return directoryManifest(dir);
  } catch (err) {
    if (isEnoent(err) && lstatSync(dir, { throwIfNoEntry: false }) === undefined) return [];
    throw err;
  }
}

/** treeManifestOrEmpty on fs/promises (directoryManifestAsync). */
async function treeManifestOrEmptyAsync(dir: string): Promise<ReturnType<typeof directoryManifest>> {
  try {
    return await directoryManifestAsync(dir);
  } catch (err) {
    if (isEnoent(err) && (await lstat(dir).then(() => false, isEnoent))) return [];
    throw err;
  }
}

/** The brief a pass copies to the entry's /input/prompt.txt (see the header). */
export interface TrialBrief {
  /** Where it was read from, relative to the instance: input/prompt.txt, or reference/baseline-prompt.txt. */
  path: string;
  /** Whether it is reference/baseline-prompt.txt (TrialPass.baseline_prompt). */
  baseline: boolean;
  /** Its bytes, the ones the pass copies. */
  bytes: Buffer;
  /** Their sha256 (TrialPass.prompt_sha256). */
  sha256: string;
}

/**
 * The brief a pass on `instanceDir` copies to /input/prompt.txt (see the header): with `baseline`,
 * the instance's reference/baseline-prompt.txt when that path is a regular file (a symlink to one
 * included, as instanceSha256 reads it), and input/prompt.txt when nothing is there (ENOENT); without
 * it, input/prompt.txt. A baseline-prompt.txt that is there but is no regular file or cannot be read
 * (any error but ENOENT), and an input/prompt.txt that is no readable regular file, are the
 * instance's fault: a TrialFault `instance`, which voids the pass.
 */
export async function trialBriefSource(instanceDir: string, baseline: boolean): Promise<TrialBrief> {
  if (baseline) {
    const own = await briefAt(instanceDir, `reference/${BASELINE_PROMPT_FILE}`, true);
    if (own !== null) return own;
  }
  return (await briefAt(instanceDir, `input/${PROMPT_FILE}`, false))!;
}

/**
 * The brief at <instanceDir>/<rel>; null when nothing at all is there (ENOENT) and it is the baseline's
 * own, which an instance may lack. A symlink is followed, as instanceSha256 follows it; one that leads
 * nowhere is there, so a fault.
 */
async function briefAt(instanceDir: string, rel: string, baseline: boolean): Promise<TrialBrief | null> {
  const file = join(instanceDir, ...rel.split('/'));
  const fault = (why: string): TrialFault => new TrialFault('instance', `the instance has no readable ${rel}: ${why}`);
  const why = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err as Error).message;
  try {
    await lstat(file);
  } catch (err) {
    if (baseline && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw fault(why(err));
  }
  let st: Stats;
  try {
    st = await stat(file);
  } catch (err) {
    throw fault(why(err));
  }
  if (!st.isFile()) throw fault('not a regular file');
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    throw fault(why(err));
  }
  return { path: rel, baseline, bytes, sha256: sha256Hex(bytes) };
}

function checkTrial(trial: TrialRef): void {
  if (!Number.isSafeInteger(trial.index) || trial.index < 0) throw new TypeError(`trial index ${trial.index} is not a whole number from 0`);
  if (!Sha256Hex.safeParse(trial.instance_sha256).success) throw new TypeError(`instance_sha256 ${JSON.stringify(trial.instance_sha256)} is not a sha256`);
}

/** A program of the bundle: its directory (mounted at /bot) and its script in it. */
function bundleProgram(compDir: string, entrypoint: string): { dir: string; script: string } {
  const dir = scorerDirOf(entrypoint);
  return { dir: dir === '.' ? compDir : join(compDir, ...dir.split('/')), script: posix.basename(entrypoint) };
}

/** The env's directory (mounted at /bot) and its script: the setup's envDir when it names one, else the bundle's own under compDir. */
export function envProgram(setup: Pick<AgentSetup, 'compDir' | 'harness' | 'envDir'>): { dir: string; script: string } {
  const own = bundleProgram(setup.compDir, setup.harness.env.entrypoint);
  return setup.envDir === undefined ? own : { dir: setup.envDir, script: own.script };
}

/**
 * The scorer's program/v1 setup for an instance: the bundle's scorer under the setup's compDir (on the k8s sandbox its
 * stage: AgentSetup.compDir), the instance's reference/ (program.ts ProgramSetup).
 */
export function trialProgramSetup(setup: AgentSetup, instanceDir: string): ProgramSetup {
  const h = setup.harness;
  const harness: ProgramHarnessT = {
    kind: 'program/v1',
    runtimes: [...h.runtimes],
    input_data: null,
    scorer: { runtime: h.scorer.runtime, entrypoint: h.scorer.entrypoint, reference_data: null },
    generator: { ...h.generator },
    scorer_sha256: h.scorer_sha256,
    generator_sha256: h.generator_sha256,
  };
  return { compDir: setup.compDir, harness, leaderboard: setup.leaderboard, referenceDir: join(instanceDir, 'reference') };
}

/** A pass's two lane credentials (see the header's lanes), never stored. */
export interface PassCredentials {
  /** The entry's API key (entryLaneKey; given RunTrialOptions.entryKey, that one: on one pod podEntryLaneKey), which the `llm` forwarder admits alone. */
  entryKey: string;
  /** The env's house token, fresh random bytes each pass, which the `house` forwarder admits alone. */
  houseToken: string;
}

/**
 * The entry's API key in a trial: `makefun-trial-` and 48 hex of sha256('agent-fun/entry-lane-key/v1',
 * 0x00, the trial's instance_sha256, 0x00, its index), so its live pass, its replay and every later
 * regrade hand the entry the same one, and an entry that writes its key down stays deterministic. The
 * `llm` forwarder's gate on it is hygiene, against an env calling the entry's lane by mistake, not a
 * secret boundary: the env is never handed the instance's digest, but nothing more keeps the key from
 * it. The boundary is the house token, which only the env holds. It is the same for every entry on an instance's
 * trial, so it is no credential between trials: on the split layout the trial's own network keeps every other
 * trial's pod off its `llm`; on one pod, where every trial pod may dial every door, the key is podEntryLaneKey's.
 */
export function entryLaneKey(trial: TrialRef): string {
  const digest = createHash('sha256').update(`agent-fun/entry-lane-key/v1\0${trial.instance_sha256}\0${trial.index}`, 'utf8').digest('hex');
  return `${AGENT_TRIAL_DUMMY_KEY}-${digest.slice(0, 48)}`;
}

/**
 * The entry's API key in a trial on one pod (the header's One pod): `makefun-trial-` and the first 48 lower hex of
 * HMAC-SHA256 under the server's secret (grader/worker.ts's fail-key secret, config.betterAuthSecret) of
 * 'agent-fun/pod-entry-lane-key/v1', 0x00, the run's id (the run row the trial row belongs to), 0x00, the trial's
 * instance_sha256, 0x00 and its index; its shape entryLaneKey's (AGENT_ENTRY_KEY_RE). The run's own for that trial: its
 * live pass and its in-job replay hand the entry the same one, every other run (another entry's, or a later run of the
 * same entry) holds another, and no entrant can derive it while the trial's passes run. The pass's `llm` lane admits it
 * alone, so a pod that reaches another trial's entry lane at the door (an address the door still admits for that
 * trial) is refused by the lane itself. Only the worker holds the secret and calls this; the key alone is handed on
 * (RunTrialOptions.entryKey), and the run's record carries it once the run is recorded (AgentTrialRecord.entry_key),
 * where every later replay reads it.
 */
export function podEntryLaneKey(secret: string, runId: string, trial: TrialRef): string {
  if (typeof secret !== 'string' || secret === '') throw new TypeError("an entry's lane key on one pod needs the server's secret");
  if (typeof runId !== 'string' || runId === '') throw new TypeError("an entry's lane key on one pod needs its run's id");
  checkTrial(trial);
  const digest = createHmac('sha256', secret).update(`agent-fun/pod-entry-lane-key/v1\0${runId}\0${trial.instance_sha256}\0${trial.index}`, 'utf8').digest('hex');
  return `${AGENT_TRIAL_DUMMY_KEY}-${digest.slice(0, 48)}`;
}

/**
 * A pass's lane credentials (main.ts GatewayClientConfig's token shape: visible ASCII, no space): the entry's key
 * `entryKey` when the pass is given one (RunTrialOptions.entryKey: on one pod, or a replay of a run that ran one pod),
 * else the trial's (entryLaneKey); the house token random each pass.
 */
export function passCredentials(trial: TrialRef, entryKey?: string): PassCredentials {
  if (entryKey !== undefined && (typeof entryKey !== 'string' || !AGENT_ENTRY_KEY_RE.test(entryKey))) throw new TypeError(`an entry's lane key is ${AGENT_ENTRY_KEY_RE.source}`);
  return { entryKey: entryKey ?? entryLaneKey(trial), houseToken: `makefun-house-${randomBytes(24).toString('hex')}` };
}

/**
 * The entry's environment, of ours (contracts/agent.ts AGENT_ENTRY_ENV and AGENT_GATEWAY_ENV, exactly
 * AGENT_ENV_NAMES): `store` and `llm` are the env's and the forwarder's origins as the entry reaches
 * them (network.ts serviceEndpoint; in a container `store` is AGENT_ENV_URL, the envUrl variable's
 * value), `promptFile` the prompt's path as the entry sees it, `llmKey` the API key in both key
 * variables (the trial's entryLaneKey).
 */
export function entryEnvironment(o: { store: string; llm: string; promptFile: string; values: TrialValues; llmKey: string }): Record<string, string> {
  return {
    [AGENT_ENTRY_ENV.promptFile]: o.promptFile,
    [AGENT_ENTRY_ENV.shopGraphqlUrl]: `${o.store}${SHOP_GRAPHQL_PATH}`,
    [AGENT_ENTRY_ENV.shopToken]: o.values.shop_token,
    [AGENT_ENTRY_ENV.supplierUrl]: `${o.store}${SUPPLIER_PATH}`,
    [AGENT_ENTRY_ENV.trialSeed]: o.values.seed,
    [AGENT_ENTRY_ENV.trialNow]: o.values.now,
    [AGENT_ENTRY_ENV.envUrl]: o.store,
    [AGENT_GATEWAY_ENV.anthropicBaseUrl]: o.llm,
    [AGENT_GATEWAY_ENV.openaiBaseUrl]: `${o.llm}/v1`,
    [AGENT_GATEWAY_ENV.anthropicApiKey]: o.llmKey,
    [AGENT_GATEWAY_ENV.openaiApiKey]: o.llmKey,
  };
}

/**
 * Write the forwarder's config as <parent>/config/gateway.json and return that directory: `parent`
 * made PRIVATE_DIR_MODE, the directory GATEWAY_CONFIG_DIR_MODE, the file the driver's mode
 * (GATEWAY_CONFIG_FILE_MODES; see the header). The config is checked first; a refusal names paths only,
 * never a value (the key is in it).
 */
export async function writeGatewayConfig(parent: string, config: GatewayConfigT, kind: Sandbox['kind']): Promise<string> {
  const checked = GatewayConfig.safeParse(config);
  if (!checked.success) throw new TypeError(`not a gateway config: ${checked.error.issues.map((i) => (i.path.length > 0 ? i.path.join('.') : '(root)')).join(', ')}`);
  await mkdir(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(parent, PRIVATE_DIR_MODE);
  const dir = join(parent, 'config');
  await mkdir(dir, { mode: GATEWAY_CONFIG_DIR_MODE });
  await chmod(dir, GATEWAY_CONFIG_DIR_MODE);
  const file = join(dir, CONFIG_FILE);
  await writeFile(file, `${JSON.stringify(checked.data)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(file, GATEWAY_CONFIG_FILE_MODES[kind]);
  return dir;
}

/**
 * Delete the gateway.json writeGatewayConfig wrote in `configDir` (anything beside it, a replay's blobs/,
 * stays), once its forwarder is ready: the forwarder read it whole before it wrote its ready file and
 * never reads it again (see the header's config file).
 */
export async function forgetGatewayConfig(configDir: string): Promise<void> {
  await rm(join(configDir, CONFIG_FILE));
}

/**
 * The values an entrant lane's forwarder config masks beside its keys (main.ts LiveGatewayConfig `mask`), every form of
 * each: first `env`, the pass's env-lane entry secrets, each once and none a key's twin (each key is masked as a key);
 * then of `mask`, the ids the key check learned, in order, each the config takes (upstream.ts MaskValue: at least 8
 * characters) that is no key and holds none, each once, at most MAX_LEARNED_IDS of them. Anything else is dropped, never
 * thrown on: an org name shorter than 8 characters is then simply not masked (the residual upstream.ts's header names).
 */
export function forwarderMask(mask: readonly unknown[], keys: readonly string[], env: readonly string[] = []): string[] {
  const held = keys.filter((k) => k !== '');
  const out: string[] = [];
  for (const v of env) {
    if (MaskValue.safeParse(v).success && !held.includes(v) && !out.includes(v)) out.push(v);
  }
  let ids = 0;
  for (const s of mask) {
    if (ids >= MAX_LEARNED_IDS) break;
    if (typeof s !== 'string' || !MaskValue.safeParse(s).success || out.includes(s) || held.some((k) => s.includes(k))) continue;
    out.push(s);
    ids++;
  }
  return out;
}

/** An entrant lane's forwarder config, less its trial, policy and client. */
export interface EntrantLaneConfig {
  /** The `provider` adapter: a test's origins and ca, and `entry_secrets` when EntrantKeys.entrySecrets is given. */
  upstream: UpstreamConfigT;
  /** The keys given, by provider. */
  keys: Partial<Record<SecretProvider, string>>;
  /** forwarderMask's values: the env lane's secrets, then the ids learned. */
  mask: string[];
  /** The env lane's secrets, masked out of each request before it is keyed (main.ts); absent with none. */
  request_mask?: string[];
}

/**
 * An entrant lane's forwarder config (EntrantLaneConfig) for the keys `p` and the pass's env-lane entry secrets `env`
 * (RunTrialOptions.secrets' values, in name order).
 */
export function entrantLaneConfig(p: EntrantKeys, env: readonly string[] = []): EntrantLaneConfig {
  const keys: Partial<Record<SecretProvider, string>> = {};
  const held: string[] = [];
  for (const provider of SECRET_PROVIDERS) {
    const key = p.keys[provider];
    if (key === undefined) continue;
    keys[provider] = key;
    held.push(key);
  }
  const requestMask = [...new Set(env)];
  return {
    upstream: {
      adapter: 'provider',
      ...(p.origins === undefined ? {} : { origins: { ...p.origins } }),
      ...(p.ca === undefined ? {} : { ca: p.ca }),
      ...(p.entrySecrets === undefined ? {} : { entry_secrets: p.entrySecrets }),
    },
    keys,
    mask: forwarderMask(p.mask, held, requestMask),
    ...(requestMask.length === 0 ? {} : { request_mask: requestMask }),
  };
}

/** The values of the env-lane entry secrets `secrets` (RunTrialOptions.secrets), in name order (code unit by code unit). */
export function secretValues(secrets: Readonly<Record<string, string>> | undefined): string[] {
  if (secrets === undefined) return [];
  return Object.keys(secrets)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => secrets[name]!);
}

/** One entry secret's value turning up in a pass's output (secretsInPassOutputs): the secret's NAME and the output's file, never the value. */
export interface SecretOutputHit {
  name: string;
  /** The output's path: an export file's (state.json, products.csv), or ENV_LOG_FILE for the env's call log. */
  file: string;
}

/** The secrets a pass's outputs are scanned for (secretsInPassOutputs): every form of each value (lines kept whole, as a scan wants), by NAME. */
export function secretScanIndex(secrets: Readonly<Record<string, string>>): FormIndex {
  const byName: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(secrets)) byName[name] = [value, ...secretForms(value, { lines: false })];
  return new FormIndex(byName);
}

/** The longest pattern of `index` in UTF-8 bytes: an occurrence spans at most that many, so a chunked scan carries one fewer over. */
function longestBytes(index: FormIndex): number {
  let n = 0;
  for (const p of index.patterns) n = Math.max(n, Buffer.byteLength(p, 'utf8'));
  return n;
}

/** The NAMEs whose forms occur in a byte stream, read chunk by chunk with the last (longest pattern − 1) bytes carried over, so no occurrence is cut. */
async function namesInStream(stream: AsyncIterable<Uint8Array>, index: FormIndex, carryBytes: number): Promise<Set<string>> {
  const names = new Set<string>();
  let carry = Buffer.alloc(0);
  for await (const chunk of stream) {
    const buf = carry.length === 0 ? Buffer.from(chunk) : Buffer.concat([carry, chunk]);
    for (const hit of findForms(buf, index, { limit: 1 })) names.add(hit.name);
    carry = Buffer.from(buf.subarray(Math.max(0, buf.length - carryBytes)));
  }
  return names;
}

/**
 * Which of a pass's entry secrets (`index`: secretScanIndex) turned up in its outputs, by NAME and file (never the
 * value): every file of the env's export (`outputs`: state.json and the rest, TrialPass.outputs) and the env's call log
 * (TrialPass.env_log_sha256), each read from `blobs` as it was stored. Never masked: they are scored and replayed byte
 * for byte, so the caller says what a hit means (the header's entry secrets). Hits in file order, then name order.
 */
export async function secretsInPassOutputs(
  blobs: { openRead(sha256: string): Promise<AsyncIterable<Uint8Array>> },
  pass: { outputs: TrialOutputsT | null; env_log_sha256: string | null },
  index: FormIndex,
): Promise<SecretOutputHit[]> {
  if (index.patterns.length === 0) return [];
  const files: { file: string; sha256: string }[] = [...(pass.outputs?.files ?? []).map((f) => ({ file: f.path, sha256: f.sha256 })), ...(pass.env_log_sha256 === null ? [] : [{ file: ENV_LOG_FILE, sha256: pass.env_log_sha256 }])];
  const carryBytes = Math.max(0, longestBytes(index) - 1);
  const hits: SecretOutputHit[] = [];
  for (const { file, sha256 } of files) {
    const names = await namesInStream(await blobs.openRead(sha256), index, carryBytes);
    for (const name of [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) hits.push({ name, file });
  }
  return hits;
}

/**
 * The exit code the process driver's launcher gives a service that registered no SIGTERM handler, on Windows
 * (launcherSource): 128 + 15, what a container ended by its default SIGTERM reports.
 */
export const LAUNCHER_WIN32_SIGTERM_EXIT = 143;

/**
 * The process driver's launcher for a service whose script is `target` (see the header). On POSIX stdin's end is a real
 * SIGTERM to this process. On Windows no signal reaches a Node process: `process.kill(pid, 'SIGTERM')` ends it at once
 * (TerminateProcess, exit 1), so the service's own handler (the env's state export, the forwarder's result) would never
 * run; there the launcher runs the service's SIGTERM listeners itself, and with none ends as a default SIGTERM would
 * (LAUNCHER_WIN32_SIGTERM_EXIT). The kit's `grade-local --driver process` writes this same text (its bundled agent.ts).
 */
export function launcherSource(target: string): string {
  return [
    "// grader/agent.ts's process-driver launcher: the service below in this process, and stdin's end as the SIGTERM a container gets.",
    "// On Windows a real SIGTERM ends the process before any handler runs, so there the service's own listeners run here.",
    "import { pathToFileURL } from 'node:url';",
    `const target = ${JSON.stringify(target)};`,
    'process.argv[1] = target;',
    'const sigterm = () => {',
    "  if (process.platform !== 'win32') return process.kill(process.pid, 'SIGTERM');",
    "  if (process.listenerCount('SIGTERM') === 0) process.exit(" + String(LAUNCHER_WIN32_SIGTERM_EXIT) + ');',
    "  process.emit('SIGTERM', 'SIGTERM');",
    '};',
    "process.stdin.on('end', sigterm);",
    "process.stdin.on('error', () => {});",
    'process.stdin.resume();',
    'await import(pathToFileURL(target).href);',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- scoring

/** A timeout's scores: 0 on every scored column. */
export function timeoutScores(leaderboard: Pick<LeaderboardT, 'columns'>): ProgramScores {
  return Object.fromEntries(scoredColumns(leaderboard).map((c) => [c, 0]));
}

export interface ScoreTrialOptions {
  sandbox: Sandbox;
  setup: AgentSetup;
  instanceDir: string;
  /** The pass's state export as program outputs (TrialPass.outputs). */
  outputs: TrialOutputsT;
  blobs: TrialBlobs;
  limits: LimitsT;
  /** A directory the scoring may use: its scratch is made in it and deleted after. */
  workDir: string;
  /**
   * The trial's gateway cassette (TrialPass.cassette_sha256, the trials manifest's), materialized read-only at /cassette
   * for the scorer. Absent or null, or a store that cannot give it back in full: /cassette is an empty directory
   * (materializeTrialCassette), so a trial that recorded no cassette still scores as it did without the mount.
   */
  cassette_sha256?: string | null;
}

/** The scratch directory a trial's cassette is materialized in, mounted read-only at /cassette (program.ts CASSETTE_MOUNT). */
const CASSETTE_SCRATCH_DIR = 'cassette';

/** Where a materialized cassette's response bodies sit, under /cassette: the layout scrape/score.ts materializeCassette gives a scrape scorer under /reference/cassette. */
export const CASSETTE_BODIES_DIR = 'bodies';

/**
 * Write a trial's cassette into `dir` for the scorer's /cassette (program.ts ProgramSetup.cassetteDir), read-only:
 * cassette.json, the bytes `cassetteSha256` names, and bodies/<sha256> for every response body its entries name, each
 * read back from `blobs` and verified. An agent/v1 trial records its own gateway cassette (contracts/agent.ts Cassette),
 * so a bundle's scorer proves which model really answered (the header's `model calls`) instead of trusting the entry's
 * account of it.
 *
 * A cassette the store cannot give back in full (none named, missing, corrupt, not an agent-fun/cassette/v1 document, a
 * missing or non-matching body) leaves `dir` empty: the scorer reads no cassette rather than half of one, and the trial's
 * score never fails for it. The entry never sees the tree: it is made under the scoring's scratch after the entry's pass
 * has ended, and mounted into the scorer's program alone.
 */
async function materializeTrialCassette(cassetteSha256: string | null | undefined, blobs: TrialBlobs, dir: string): Promise<void> {
  await mkdir(dir, { mode: 0o700 });
  try {
    if (cassetteSha256 !== null && cassetteSha256 !== undefined) {
      const bytes = await blobs.get(cassetteSha256, { verify: true });
      if (bytes === null) throw new CassetteError(`the blob store holds no cassette ${cassetteSha256}`);
      const cassette = parseCassette(bytes);
      const bodiesDir = join(dir, CASSETTE_BODIES_DIR);
      await mkdir(bodiesDir, { mode: 0o700 });
      await writeFile(join(dir, CASSETTE_FILE), bytes, { flag: 'wx', mode: 0o600 });
      const bodies = [...new Set(cassette.entries.map((e) => e.body_sha256))];
      await eachBounded(bodies, BLOB_FANOUT, async (body) => {
        const bodyBytes = await blobs.get(body, { verify: true });
        if (bodyBytes === null) throw new CassetteError(`the blob store holds no cassette body ${body}`);
        await writeFile(join(bodiesDir, body), bodyBytes, { flag: 'wx', mode: 0o600 });
      });
    }
  } catch {
    // Evidence the store could not produce is no reason to fail a trial: an empty /cassette is the contract (the header).
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { mode: 0o700 });
  } finally {
    // Read-only to all whatever the umask (program.ts sealStaged): the scorer reads it as the sandbox user.
    await sealStaged(dir);
  }
}

/** What the bundle's scorer gave a pass's state export (scoreTrialWithChecks): its scores, and its per-check rows unless they were dropped. */
export interface TrialScored {
  scores: ProgramScores;
  /** The scorer's checks.json (grader/program-scores.ts readChecks); null when it wrote none, or wrote one that was dropped. */
  checks: ScorerChecksT | null;
  /** Why that checks.json was dropped (malformed: harnesses.ts scoreProgramBreakdown), the scores standing as without it; null when it was not. */
  checks_issue: string | null;
}

/** The empty directory the scorer's scratch makes for an instance whose reference/ held no file (instanceReferenceDir). */
export const EMPTY_REFERENCE_DIR = 'reference-empty';

/**
 * The scorer's /reference of an instance (its reference/), as instanceEnvData is the env's seed directory: the
 * instance's reference/ when anything is there, and when nothing is at all, an empty directory of the scorer's scratch,
 * `<scratch>/reference-empty`, made 0755. The instance digest covers files alone (instanceSha256 reads a reference/ that
 * is not there as the tree of no file), so an instance whose sealed reference/ held no file and a copy that lost that
 * empty directory (the tier mirror off the data claim, server/blob-tier/mirror.ts) are the same instance, and the
 * scorer reads the same nothing from either. Anything else there is mounted as it is, as before. The instance itself is
 * never written.
 */
export async function instanceReferenceDir(instanceDir: string, scratch: string): Promise<string> {
  const at = join(instanceDir, 'reference');
  if (!(await lstat(at).then(() => false, isEnoent))) return at;
  const empty = join(scratch, EMPTY_REFERENCE_DIR);
  await mkdir(empty, { mode: 0o755 });
  await chmod(empty, 0o755);
  return empty;
}

/**
 * Score a pass's state export with the bundle's scorer (harnesses.ts scoreProgramBreakdown over program.ts
 * scoreProgramWithChecks): /output the export, /reference the instance's (an empty directory for one whose reference/
 * held no file: instanceReferenceDir), and /cassette the trial's gateway cassette
 * read-only (materializeTrialCassette; an empty directory when it has none to give). Its scores, and the per-check rows
 * its scorer wrote beside them (the run's checks trace: agent-score.ts agentChecksBreakdown), a checks.json it refuses
 * dropped with the reason and never failing the scoring. Any other scorer fault is a ScorerError: the competition's fault.
 */
export async function scoreTrialWithChecks(o: ScoreTrialOptions): Promise<TrialScored> {
  const outputs = TrialOutputs.parse(o.outputs);
  const dir = await mkdtemp(join(o.workDir, 'score-'));
  // Held (grade.ts holdScratch, its header's Releasing): the scorer's scratch removed under it waits for its removal
  // below, which releases it all in one go, unless a root its caller holds lies above it (the trial's, a grade's).
  holdScratch(dir);
  try {
    const cassetteDir = join(dir, CASSETTE_SCRATCH_DIR);
    await materializeTrialCassette(o.cassette_sha256, o.blobs, cassetteDir);
    const setup: ProgramSetup = { ...trialProgramSetup(o.setup, o.instanceDir), referenceDir: await instanceReferenceDir(o.instanceDir, dir), cassetteDir };
    const scored = await scoreProgramBreakdown({ sandbox: o.sandbox, setup, outputs, blobs: o.blobs, limits: o.limits, workDir: dir, label: 'trial-scorer' });
    return { scores: scored.scores, checks: scored.checks, checks_issue: scored.checksIssue };
  } finally {
    await removeScratch(o.sandbox, dir);
  }
}

/** A pass's state export's scores alone (scoreTrialWithChecks's): a ScorerError is the competition's fault; a malformed checks.json is none. */
export async function scoreTrial(o: ScoreTrialOptions): Promise<ProgramScores> {
  return (await scoreTrialWithChecks(o)).scores;
}

// ---------------------------------------------------------------- the pass's programs

/** The sandbox, with every program it starts held (and every pod it opens: Sandbox.pods), so an abort can kill them all. */
class TrackedSandbox implements Sandbox {
  readonly kind: Sandbox['kind'];
  readonly inner: Sandbox;
  readonly live = new Set<SandboxProcess>();
  /** The pods opened through `pods`, each closed by closePods. */
  readonly opened = new Set<SandboxPod>();
  readonly meterTree?: (dir: string, opts: TreeMeterOptions) => TreeMeter;
  readonly networks?: TrialNetworks;
  readonly pods?: SandboxPods;

  constructor(inner: Sandbox) {
    this.inner = inner;
    this.kind = inner.kind;
    if (inner.meterTree !== undefined) this.meterTree = (dir, opts) => inner.meterTree!(dir, opts);
    if (inner.networks !== undefined) this.networks = inner.networks;
    const pods = inner.pods;
    if (pods !== undefined) {
      this.pods = Object.freeze({
        open: (plan: SandboxPodPlan): SandboxPod => {
          const pod = pods.open(plan);
          this.opened.add(pod);
          return pod;
        },
      });
    }
  }

  /** Hold a program started elsewhere (a hosted lane), so killPrograms kills it too. */
  track<P extends SandboxProcess>(p: P): P {
    this.live.add(p);
    void p.exited.then(() => this.live.delete(p));
    return p;
  }

  imageDigest(runtime: Runtime): string | null {
    return this.inner.imageDigest(runtime);
  }

  preflight(runtime: Runtime, imageDigest?: string | null): Promise<void> {
    return this.inner.preflight(runtime, imageDigest);
  }

  spawn(spec: SandboxSpec): SandboxProcess {
    return this.track(this.inner.spawn(spec));
  }

  isDriverFailure(exit: SandboxExit): boolean {
    return this.inner.isDriverFailure(exit);
  }

  removeTree(dir: string): Promise<void> {
    return this.inner.removeTree(dir);
  }

  /** Kill every program still running (a hosted lane's included), and wait until each is gone. */
  async killPrograms(): Promise<void> {
    await Promise.all([...this.live].map((p) => p.kill().catch(() => undefined)));
  }

  /** Close every pod opened, and wait until each is gone. */
  async closePods(): Promise<void> {
    await Promise.all([...this.opened].map((p) => p.close().catch(() => undefined)));
  }
}

/**
 * runTrial's release of what a pass holds (its abort's and its end's, in this order on every path): every program
 * killed, the hosted lanes among them, and gone; then on one pod the address forgotten at the door; only then every pod
 * closed. So the door never admits the address of a pod already deleted, which the node may hand to another pod.
 */
async function releasePass(sandbox: TrackedSandbox, state: PassState, door: Door | undefined): Promise<void> {
  // Every member's end from here on is the pass's own (the pods' close kills them): none forgets out of this order.
  state.entryStopAsked = true;
  state.envStopAsked = true;
  await sandbox.killPrograms();
  await forgetAdmitted(state, door);
  await sandbox.closePods();
}

/**
 * On one pod: the pass's address forgotten at the door, once; every caller (the pass's own stop, its pod found failed,
 * its release) awaits the same forget, so none goes on to close the pod before the door has taken it. Never throws.
 */
function forgetAdmitted(state: PassState, door: Door | undefined): Promise<void> {
  const ip = state.admitted;
  if (ip !== null && door !== undefined) {
    state.admitted = null;
    state.forgetting = door.forget(ip).catch(() => undefined);
  }
  return state.forgetting ?? Promise.resolve();
}

type ServiceRole = 'env' | 'forwarder' | 'house';

/** The env or a forwarder (the entry's, or the house lane's): its process, its exit once it has one, and the tail of what it printed. */
class TrialService {
  readonly role: ServiceRole;
  readonly label: string;
  readonly proc: SandboxProcess;
  readonly exited: Promise<SandboxExit>;
  exit: SandboxExit | null = null;
  /**
   * When its program started (performance.now()): at spawn for a driver that runs it from there, else once its
   * `started` resolves (k8s: its pod Ready and the exec begun); null until then. Its ready file's wait runs from here.
   */
  startedAt: number | null = null;
  /** On one pod (the header's): the process its SIGTERM goes to itself (a pod member's, a hosted lane's); null where the driver's own way sends it. */
  readonly terminable: TerminableProcess | null;
  #log: Buffer = Buffer.alloc(0);

  constructor(role: ServiceRole, label: string, proc: SandboxProcess, terminable: TerminableProcess | null = null) {
    this.role = role;
    this.label = label;
    this.proc = proc;
    this.terminable = terminable;
    if (proc.started === undefined) this.startedAt = performance.now();
    else
      void proc.started.then(() => {
        this.startedAt = performance.now();
      });
    for (const s of [proc.stdout, proc.stderr]) {
      s.on('data', (b: Buffer) => this.#keep(b));
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
    this.#log = all.length > SERVICE_LOG_BYTES ? Buffer.from(all.subarray(all.length - SERVICE_LOG_BYTES)) : all;
  }

  /** The last lines it printed, for a fault's message. */
  logTail(): string {
    const text = this.#log.toString('utf8').trim();
    return text.length <= 500 ? text : `…${text.slice(-500)}`;
  }

  get name(): string {
    return this.role === 'env' ? 'the env' : this.role === 'house' ? 'the house forwarder' : 'the forwarder';
  }
}

/** Why waiting stopped: the pass was aborted. */
class PassAborted extends Error {
  constructor() {
    super('the trial was aborted');
    this.name = 'AbortError';
  }
}

function abortedReason(signal: AbortSignal): unknown {
  return signal.reason ?? new PassAborted();
}

/** `p`, or a PassAborted rejection as soon as `signal` aborts (p's own later rejection is then nobody's). */
function guard<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new PassAborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new PassAborted());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return guard(
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => clearTimeout(t), { once: true });
    }),
    signal,
  );
}

/** `p`'s value, or null when `ms` passes first. */
async function within<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await guard(Promise.race([p, late]), signal);
  } finally {
    clearTimeout(timer);
  }
}

/** A JSON document a service wrote, or null when the file is not there. */
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

/**
 * Wait for each service's ready file (both write theirs whole: a rename); each one's port, within READY_TIMEOUT_MS of
 * its program's start (TrialService.startedAt: before it, the driver's own budget for its pod bounds the wait and ends
 * the process when it runs out). A service that exits first is a fault: the sandbox's when the driver failed to run it
 * (node_capacity when the node had no room for its pod: noRoomOf), else its own, said in its output or (the forwarder,
 * which prints nothing) its result file's faults.
 */
async function waitReady(services: readonly { svc: TrialService; file: string; result?: string }[], driverFailure: (exit: SandboxExit) => boolean, signal: AbortSignal): Promise<number[]> {
  const ports: (number | null)[] = services.map(() => null);
  for (;;) {
    for (const [i, { svc, file, result }] of services.entries()) {
      if (ports[i] !== null) continue;
      const doc = await readJson(file);
      if (doc !== null) {
        const port = (doc as { port?: unknown }).port;
        if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
          throw new TrialFault(svc.role === 'env' ? 'env' : 'gateway', `${svc.name}'s ready file names no port: ${JSON.stringify(doc).slice(0, 200)}`);
        }
        ports[i] = port;
      } else if (svc.exit !== null) {
        const said = [svc.logTail(), ...(result === undefined ? [] : (gatewayResultOf(await readJson(result))?.faults ?? []))].filter((s) => s !== '').join('; ');
        const failed = driverFailure(svc.exit);
        const noRoom = failed ? noRoomOf(svc.proc) : null;
        const reason: TrialVoidReason = noRoom !== null ? NODE_CAPACITY_VOID_REASON : failed ? 'sandbox' : svc.role === 'env' ? 'env' : 'gateway';
        throw new TrialFault(reason, `${svc.name} exited before it was ready (${describeExit(svc.exit)})${noRoom !== null ? `: the node had no room for its pod (${noRoom})` : said === '' ? '' : `: ${said}`}`);
      }
    }
    if (ports.every((p) => p !== null)) return ports as number[];
    const at = performance.now();
    const late = services.filter(({ svc }, i) => ports[i] === null && svc.startedAt !== null && at > svc.startedAt + READY_TIMEOUT_MS).map(({ svc }) => svc);
    if (late.length > 0) {
      throw new TrialFault(late[0]!.role === 'env' ? 'env' : 'gateway', `${late.map((s) => s.name).join(' and ')} not ready within ${READY_TIMEOUT_MS} ms: ${late.map((s) => s.logTail()).join(' | ')}`);
    }
    await sleep(READY_POLL_MS, signal);
  }
}

/** SIGTERM to a service in its container: `docker kill --signal TERM` on the one container of its label on the trial's network. */
async function dockerTerm(exec: DockerExec, network: string, label: string): Promise<void> {
  const ps = await exec(['ps', '--no-trunc', '--filter', `network=${network}`, '--format', '{{.ID}} {{.Names}}']);
  if (ps.code !== 0) throw new SandboxError(`docker could not list the containers on ${network}: ${(ps.error ?? ps.stderr).trim().split('\n')[0] ?? ''}`);
  const name = new RegExp(`^makefun-${label}-[0-9a-f]{12}$`);
  const ids = ps.stdout
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter((p) => p.length === 2 && name.test(p[1]!))
    .map((p) => p[0]!);
  // A container that went meanwhile refuses the kill; waiting for its exit is the check.
  if (ids.length > 0) await exec(['kill', '--signal', 'TERM', ...ids]);
}

// ---------------------------------------------------------------- the pass

type Ending =
  | { kind: 'exited'; exit: SandboxExit }
  | { kind: 'limit'; message: string }
  | { kind: 'timeout' }
  | { kind: 'miss'; lane: Lane }
  | { kind: 'service'; svc: TrialService; exit: SandboxExit };

/** A forwarder's lane (see the header's lanes). */
type Lane = 'entry' | 'house';

/**
 * How the entry's run ends (see Ending): first come, first kept. `missFiles`: REPLAY, each lane's forwarder's miss file.
 * `ceilingMs`: on a house clock, the most the entry's moving deadline can reach (the header's house clock), which the
 * wait for its exit runs to in place of the budget it starts at; null, the budget, as ever.
 */
function entryEnding(sup: Supervisor, services: readonly TrialService[], missFiles: readonly { lane: Lane; file: string }[], ceilingMs: number | null = null): Promise<Ending> {
  return new Promise<Ending>((resolve, reject) => {
    let done = false;
    let poll: NodeJS.Timeout | null = null;
    const finish = (e: Ending): void => {
      if (done) return;
      done = true;
      if (poll !== null) clearInterval(poll);
      resolve(e);
    };
    sup.waitExit(Math.max(0, ceilingMs === null ? sup.remainingMs() : ceilingMs - sup.elapsedMs())).then(
      (exit) => finish(exit === 'grace' ? { kind: 'timeout' } : { kind: 'exited', exit }),
      (err: unknown) => {
        if (!(err instanceof Stopped)) {
          done = true;
          if (poll !== null) clearInterval(poll);
          reject(err);
          return;
        }
        const r = err.reason;
        finish(r.kind === 'timeout' ? { kind: 'timeout' } : r.kind === 'violation' ? { kind: 'limit', message: r.message } : { kind: 'exited', exit: r.exit });
      },
    );
    for (const svc of services) void svc.exited.then((exit) => finish({ kind: 'service', svc, exit }));
    if (missFiles.length > 0) {
      poll = setInterval(() => {
        const missed = missFiles.find((m) => existsSync(m.file));
        if (missed !== undefined) finish({ kind: 'miss', lane: missed.lane });
      }, MISS_POLL_MS);
    }
  });
}

/** How much of the env's call log a house clock reads at once. */
const HOUSE_LOG_CHUNK_BYTES = 64 * 1024;

/**
 * A pass's house clock (the header's): the env's call log read on from where the last read stopped, its complete lines'
 * house ms summed (house-clock.ts houseMsOf; a line still being written waits for the next read), and the budget the
 * entry's deadline stands at, the wall and the credit. One read at a time: a read asked for while one runs is that one.
 * A log not there yet, or a read that fails, counts nothing more, never throws.
 */
class HouseClockReader {
  readonly row: HouseClockRow;
  readonly wallMs: number;
  readonly #wallSec: number;
  readonly #file: string;
  #offset = 0;
  #houseMs = 0;
  #reading: Promise<void> | null = null;

  constructor(row: HouseClockRow, wallBudgetSec: number, file: string) {
    this.row = row;
    this.#wallSec = wallBudgetSec;
    this.wallMs = wallBudgetSec * 1000;
    this.#file = file;
  }

  /** The house's ms counted so far. */
  get houseMs(): number {
    return this.#houseMs;
  }

  /** Read on, or join the read that runs. */
  read(): Promise<void> {
    if (this.#reading === null) {
      this.#reading = this.#readOn().finally(() => {
        this.#reading = null;
      });
    }
    return this.#reading;
  }

  /** The read that runs, if any, settled. */
  async idle(): Promise<void> {
    if (this.#reading !== null) await this.#reading;
  }

  credit(): HouseCredit {
    return houseCredit(this.row, this.#wallSec, this.#houseMs);
  }

  /** The budget the entry's deadline stands at: the wall and the credit (house-clock.ts houseCredit). */
  budgetMs(): number {
    return this.wallMs + this.credit().credit_ms;
  }

  async #readOn(): Promise<void> {
    let fh: FileHandle;
    try {
      fh = await open(this.#file, 'r');
    } catch {
      return;
    }
    try {
      const buf = Buffer.alloc(HOUSE_LOG_CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, this.#offset);
        if (bytesRead === 0) return;
        const chunk = buf.subarray(0, bytesRead);
        const nl = chunk.lastIndexOf(0x0a);
        if (nl === -1) {
          // A partial line: the next read finishes it. A chunk-long one is no line of the log's (houseMsOf would skip
          // it): passed over, its tail then read as a malformed line and skipped.
          if (bytesRead < buf.length) return;
          this.#offset += bytesRead;
          continue;
        }
        this.#houseMs += houseMsOf(chunk.subarray(0, nl + 1).toString('utf8'));
        this.#offset += nl + 1;
        if (bytesRead < buf.length) return;
      }
    } catch {
      return;
    } finally {
      await fh.close().catch(() => undefined);
    }
  }
}

/** What a pass has recorded so far: what a void still reports. */
interface PassRecord {
  prompt_sha256: string | null;
  baseline_prompt: boolean;
  entry: EntryRun | null;
  cassette_sha256: string | null;
  pricing_rev: string | null;
  totals: CassetteT['totals'] | null;
  void_verdict: VoidVerdict | null;
  replay: ReplayVerdict | null;
  state_sha256: string | null;
  outputs: TrialOutputsT | null;
  outputs_sha256: string | null;
  env_log_sha256: string | null;
  stderr_sha256: string | null;
  scores: ProgramScores | null;
  checks: ScorerChecksT | null;
  checks_issue: string | null;
  masq: TrialPass['masq'];
  house_cassette_sha256: string | null;
  /** LIVE with a target: the house cassette's totals (the house key's meter) and its upstream errors (any voids). */
  house_totals: CassetteT['totals'] | null;
  house_void: VoidVerdict | null;
  house_replay: ReplayVerdict | null;
  house_masq: TrialPass['house_masq'];
  /** LIVE: each lane's request log as stored (TrialPass.requests_sha256, house_requests_sha256); else null. */
  requests_sha256: string | null;
  house_requests_sha256: string | null;
  /** On a house clock, once the entry ran (TrialPass.house_clock); else null. */
  house_clock: HouseClockPass | null;
  /** Infrastructure faults met on the way: the first one's reason voids the pass. */
  faults: { reason: TrialVoidReason; message: string }[];
}

function emptyRecord(): PassRecord {
  return {
    prompt_sha256: null,
    baseline_prompt: false,
    entry: null,
    cassette_sha256: null,
    pricing_rev: null,
    totals: null,
    void_verdict: null,
    replay: null,
    state_sha256: null,
    outputs: null,
    outputs_sha256: null,
    env_log_sha256: null,
    stderr_sha256: null,
    scores: null,
    checks: null,
    checks_issue: null,
    masq: null,
    house_cassette_sha256: null,
    house_totals: null,
    house_void: null,
    house_replay: null,
    house_masq: null,
    requests_sha256: null,
    house_requests_sha256: null,
    house_clock: null,
    faults: [],
  };
}

function checkRunOptions(o: RunTrialOptions): void {
  if (o.mode !== 'live' && o.mode !== 'replay') throw new TypeError(`mode ${JSON.stringify(o.mode)} is live or replay`);
  checkTrial(o.trial);
  if (o.baseline !== undefined && typeof o.baseline !== 'boolean') throw new TypeError(`baseline ${JSON.stringify(o.baseline)} is true or false`);
  if (o.owner !== undefined && (typeof o.owner !== 'string' || !TRIAL_OWNER_RE.test(o.owner))) throw new TypeError(`trial owner ${JSON.stringify(o.owner)} must be lowercase [a-z0-9._-], at most 128 characters`);
  if (o.setup.competition !== undefined && typeof o.setup.competition !== 'string') throw new TypeError(`setup.competition ${JSON.stringify(o.setup.competition)} is a competition's slug`);
  // A house clock's row is checked before anything runs (house-clock.ts houseClockOf: a RangeError for one that is no clock).
  houseClockOf(o.setup.competition, o.houseClocks);
  const r = o.podRequests;
  if (r !== undefined && (r === null || typeof r !== 'object' || !Number.isSafeInteger(r.cpuMilli) || r.cpuMilli <= 0 || !Number.isSafeInteger(r.memoryMi) || r.memoryMi <= 0)) {
    throw new TypeError(`podRequests ${JSON.stringify(r)} is {cpuMilli, memoryMi}, positive integers`);
  }
  if (o.entryKey !== undefined && (typeof o.entryKey !== 'string' || !AGENT_ENTRY_KEY_RE.test(o.entryKey))) {
    throw new TypeError(`the entryKey given is no entry lane key (${AGENT_ENTRY_KEY_RE.source})`);
  }
  if (o.hosted !== undefined && o.door !== undefined && o.entryKey === undefined) {
    throw new TypeError("a pass on one pod needs its entry's lane key for the trial (entryKey: podEntryLaneKey), so its entry is handed the run's own key on every pass");
  }
  if (o.mode === 'live' && o.upstream === undefined) throw new TypeError('a live pass needs an upstream');
  if (o.mode === 'live' && o.cassette !== undefined) throw new TypeError('a live pass records its cassette: it takes none');
  if (o.mode === 'replay' && o.upstream !== undefined) throw new TypeError('a replay has no upstream');
  const target = o.setup.harness.target !== undefined;
  if (o.mode === 'replay') {
    if (o.cassette === undefined) throw new TypeError('a replay needs the live pass\'s cassette and state');
    if (!Sha256Hex.safeParse(o.cassette.cassette_sha256).success || !Sha256Hex.safeParse(o.cassette.state_sha256).success) throw new TypeError('a replay source names its cassette and state by sha256');
    const house = o.cassette.house_cassette_sha256;
    if (target && (house === undefined || !Sha256Hex.safeParse(house).success)) throw new TypeError('a replay of a trial with a target needs its live pass\'s house cassette, by sha256');
    if (!target && house !== undefined) throw new TypeError('a replay of a trial without a target has no house cassette');
  }
  const u = o.upstream;
  const onProvider = (c: UpstreamConfigT): boolean => c.adapter === 'provider';
  const entrantOnly = "the provider adapter runs on an entrant's own keys alone: give them as `provider` (EntrantTrialUpstream), never as a config and key";
  if (u !== undefined && 'config' in u) {
    if (onProvider(u.config) || (u.house !== undefined && onProvider(u.house.config))) throw new TypeError(entrantOnly);
    if (u.house !== undefined && !target) throw new TypeError('a house upstream needs a target');
  }
  if (u !== undefined && 'masq' in u && u.house !== undefined) {
    if (onProvider(u.house.config)) throw new TypeError(entrantOnly);
    if (!target) throw new TypeError('a house upstream needs a target');
  }
  if (u !== undefined && 'provider' in u) {
    checkEntrantKeys(u.provider);
    if (u.house !== undefined && !target) throw new TypeError('a house upstream needs a target');
    if (u.house === undefined && target) throw new TypeError("a trial with a target needs a house upstream beside the entrant's keys: its house lane runs on the house's key, never the entrant's");
    if (u.house !== undefined && 'config' in u.house && onProvider(u.house.config)) throw new TypeError(entrantOnly);
    checkProviderOrigins(o, u.provider);
  }
  const masqOf = (c: UpstreamConfigT): string | null => (c.adapter === 'masq' ? c.origin : null);
  const houseOrigins = (h: HouseLaneUpstream | undefined): (string | null)[] => (h === undefined ? [] : 'masq' in h ? [h.masq.origin] : [masqOf(h.config)]);
  const masqOrigins = (u === undefined ? [] : 'masq' in u ? [u.masq.origin, ...houseOrigins(u.house)] : 'provider' in u ? houseOrigins(u.house) : [masqOf(u.config), ...houseOrigins(u.house)]).filter((x): x is string => x !== null);
  for (const masqOrigin of masqOrigins) checkMasqOrigin(o, masqOrigin);
  for (const config of laneConfigsOf(u)) if (config.adapter === 'router') checkRouterOrigin(o, config.origin);
  checkPassSecrets(o);
}

/** The configs a live pass's upstream gives its lanes as they are (main.ts GatewayConfig's), each lane's in turn: none for a key the pass mints (masq) or an entrant's keys (`provider`). */
function laneConfigsOf(u: PassUpstream | undefined): UpstreamConfigT[] {
  if (u === undefined) return [];
  const house = u.house !== undefined && 'config' in u.house ? [u.house.config] : [];
  return 'config' in u ? [u.config, ...house] : house;
}

/**
 * superbot-router's origin (a router-served target's house lane: the header's exception to masq) as its forwarder reaches
 * it, checked as a provider's is (checkProviderOrigins), never as masq's: the router is public, reached over the egress
 * bridge, so a test's origin on this host's loopback is refused under a containerized sandbox, and one naming its host
 * under gVisor's own network stack with no resolv.conf for the forwarder.
 */
function checkRouterOrigin(o: RunTrialOptions, origin: string): void {
  if (containerized(o.sandbox.kind) && isLoopbackOrigin(origin)) {
    throw new TypeError(`superbot-router's origin for the forwarder, ${origin}, is this host's loopback, which the forwarder's ${o.sandbox.kind === 'k8s' ? 'pod' : 'container'} cannot reach`);
  }
  if (o.sandbox instanceof DockerSandbox && o.sandbox.runtime === NETSTACK_RUNTIME && o.sandbox.resolvConf === null && isIP(new URL(origin).hostname.replace(/^\[|\]$/g, '')) === 0) {
    throw new TypeError(
      `superbot-router's origin for the forwarder, ${origin}, names its host, and under ${NETSTACK_RUNTIME} the forwarder resolves no name without a resolv.conf of its own: set MAKEFUN_DOCKER_RESOLV_CONF to a host file naming a nameserver the egress bridge reaches (grader/sandbox/docker.ts)`,
    );
  }
}

/**
 * The pass's env-lane entry secrets (RunTrialOptions.secrets), as the entry's sandbox takes them (grader/sandbox/types.ts
 * checkSandboxSecrets: a {NAME: value} map of env-lane names, none sharing a name with what a sandbox or the entry's
 * environment sets, each a secret value, 16 and 32 KiB at most), and on a live pass only beside an entrant's own keys:
 * a house-paid pass runs none. Never names a value.
 */
function checkPassSecrets(o: RunTrialOptions): void {
  const secrets = o.secrets;
  if (secrets === undefined) return;
  if (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) throw new TypeError("the entry's secrets are a {NAME: value} map");
  if (Object.keys(secrets).length === 0) return;
  if (o.mode === 'live' && o.upstream !== undefined && !('provider' in o.upstream)) {
    throw new TypeError("an entrant's entry secrets ride an entrant's own lane (EntrantTrialUpstream): a house-paid pass runs none");
  }
  const env = Object.fromEntries(AGENT_ENV_NAMES.map((n) => [n, '']));
  try {
    checkSandboxSecrets({ secrets, env });
  } catch (err) {
    if (err instanceof SandboxError) throw new TypeError(`the entry's secrets are not ones its sandbox takes: ${err.message}`);
    throw err;
  }
}

/** An entrant's keys as EntrantKeys has them: keys by a provider each, header-safe; a mask list; a test's origins and ca, and entrySecrets, as the forwarder's config takes them. Never names a key. */
function checkEntrantKeys(p: EntrantKeys): void {
  if (p === null || typeof p !== 'object' || p.keys === null || typeof p.keys !== 'object' || Array.isArray(p.keys)) throw new TypeError("an entrant's keys are an object of keys by provider (an empty one when none is pushed)");
  if (!Array.isArray(p.mask)) throw new TypeError("an entrant's keys carry `mask`, the values masked with them (an empty list when there are none)");
  for (const [provider, key] of Object.entries(p.keys)) {
    if (!(SECRET_PROVIDERS as readonly string[]).includes(provider)) throw new TypeError(`an entrant's key is for ${SECRET_PROVIDERS.join(', ')}, not ${JSON.stringify(provider)}`);
    if (key !== undefined && !UpstreamKey.safeParse(key).success) {
      throw new TypeError(`the entrant's ${SECRET_PROVIDER_NAME[provider as SecretProvider]} key is not one a header can carry: 1 to 4096 visible ASCII characters, no spaces`);
    }
  }
  const upstream = UpstreamConfig.safeParse(entrantLaneConfig(p).upstream);
  if (!upstream.success) throw new TypeError(`an entrant's fake provider (origins, ca) or entry_secrets is not one the forwarder takes: ${upstream.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
}

/**
 * Each provider an entrant's key is for (a provider with none is never dialled: the forwarder answers
 * its calls itself) at an origin its forwarder can reach from where the sandbox runs it, as
 * checkMasqOrigin is masq's: a test's origin on this host's loopback is refused under a containerized
 * sandbox, and under gVisor's own network stack with no resolv.conf for the forwarder, a provider's own
 * origin (which names its host) or a test's that names one.
 */
function checkProviderOrigins(o: RunTrialOptions, p: EntrantKeys): void {
  const netstackBlind = o.sandbox instanceof DockerSandbox && o.sandbox.runtime === NETSTACK_RUNTIME && o.sandbox.resolvConf === null;
  for (const provider of SECRET_PROVIDERS) {
    if (p.keys[provider] === undefined) continue;
    const name = SECRET_PROVIDER_NAME[provider];
    const given = p.origins?.[provider];
    if (given !== undefined && containerized(o.sandbox.kind) && isLoopbackOrigin(given)) {
      throw new TypeError(`${name}'s origin for the forwarder, ${given}, is this host's loopback, which the forwarder's ${o.sandbox.kind === 'k8s' ? 'pod' : 'container'} cannot reach`);
    }
    if (netstackBlind && (given === undefined || isIP(new URL(given).hostname.replace(/^\[|\]$/g, '')) === 0)) {
      throw new TypeError(
        `${given === undefined ? `${name}'s API, which the entrant's ${name} key is for,` : `${name}'s origin for the forwarder, ${given},`} names its host, and under ${NETSTACK_RUNTIME} the forwarder resolves no name without a resolv.conf of its own: set MAKEFUN_DOCKER_RESOLV_CONF to a host file naming a nameserver the egress bridge reaches (grader/sandbox/docker.ts)`,
      );
    }
  }
}

/** A masq origin the pass's forwarders can reach from where the sandbox runs them. */
function checkMasqOrigin(o: RunTrialOptions, masqOrigin: string): void {
  if (containerized(o.sandbox.kind) && isLoopbackOrigin(masqOrigin)) {
    throw new TypeError(
      o.sandbox.kind === 'k8s'
        ? `masq's origin for the forwarder, ${masqOrigin}, is this host's loopback, which the forwarder's pod cannot reach: set MAKEFUN_LLM_GATEWAY_SANDBOX_URL to masq's origin as the cluster's pods reach it (host.docker.internal is meaningless on Kubernetes)`
        : `masq's origin for the forwarder, ${masqOrigin}, is this host's loopback, which the forwarder's container cannot reach: set MAKEFUN_LLM_GATEWAY_SANDBOX_URL to masq's origin as containers reach it, like http://host.docker.internal:8787 on Docker Desktop (or the docker bridge's address on Linux)`,
    );
  }
  if (o.sandbox instanceof DockerSandbox && o.sandbox.runtime === NETSTACK_RUNTIME && o.sandbox.resolvConf === null && isIP(new URL(masqOrigin).hostname.replace(/^\[|\]$/g, '')) === 0) {
    throw new TypeError(
      `masq's origin for the forwarder, ${masqOrigin}, names its host, and under ${NETSTACK_RUNTIME} the forwarder resolves no name without a resolv.conf of its own: set MAKEFUN_DOCKER_RESOLV_CONF to a host file naming a nameserver the egress bridge reaches (grader/sandbox/docker.ts), or give masq's origin by its address`,
    );
  }
}

/**
 * Run one pass of a trial (see the header). Infrastructure faults are a `void` pass, never thrown;
 * a malformed option is a TypeError, an abort rejects with the signal's reason, and anything else
 * thrown is a fault of this process's own (its blob store, a refused masq admin key, a bug).
 */
export async function runTrial(opts: RunTrialOptions): Promise<TrialPass> {
  checkRunOptions(opts);
  const external = opts.signal;
  if (external?.aborted) throw abortedReason(external);
  const sandbox = new TrackedSandbox(opts.sandbox);
  const stop = new AbortController();
  const state: PassState = { network: false, sup: null, minted: null, retireTried: false, houseMinted: null, houseRetireTried: false, pod: null, admitted: null, forgetting: null, podFailed: false, entryStopAsked: false, envStopAsked: false, laneDir: null, memory: false };
  // The abort's release, in releasePass's order (the lanes, the door, the pods); the end's below waits for it first.
  const abortRelease: { done: Promise<void> | null } = { done: null };
  const onAbort = (): void => {
    stop.abort();
    abortRelease.done = releasePass(sandbox, state, opts.door);
  };
  external?.addEventListener('abort', onAbort, { once: true });
  const name = `t${opts.trial.index}-${opts.mode === 'live' ? 'l' : 'r'}-${randomBytes(6).toString('hex')}`;
  const rec = emptyRecord();
  const net: NetworkOptions & { exec: DockerExec } = { exec: opts.docker?.exec ?? dockerExec(opts.docker?.docker ?? (opts.sandbox instanceof DockerSandbox ? opts.sandbox.docker : 'docker')) };
  const networks = trialNetworksOf(opts.sandbox, net.exec, opts.docker !== undefined);
  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(join(opts.workDir, 'trial-'));
    // Held (grade.ts holdScratch, its header's Releasing): nothing removed under it during the pass (its scoring's
    // scratch) is released before the pass is over; its removal below releases it, unless its caller holds a root above.
    holdScratch(scratch);
    const c: PassContext = { sandbox, signal: stop.signal, name, rec, net, networks, state, scratch };
    // One pod (the header's): with its lanes' host and door, on a sandbox that makes pods; else as ever.
    if (opts.hosted !== undefined && opts.door !== undefined && sandbox.pods !== undefined) return await runPodPass(opts, c, { hosted: opts.hosted, door: opts.door, pods: sandbox.pods });
    return await runPass(opts, c);
  } catch (err) {
    if (external?.aborted) throw abortedReason(external);
    const fault = faultOf(err);
    if (fault === null) throw err;
    rec.faults.push(fault);
    return passOf(opts, { name, rec, state }, 'void', rec.faults[0]!.reason, rec.faults.map((f) => f.message).join('; '));
  } finally {
    external?.removeEventListener('abort', onAbort);
    stop.abort();
    if (state.sup !== null) await state.sup.kill().catch(() => undefined);
    // Every program (the hosted lanes too) gone, then on one pod its address forgotten at the door, then the pods closed.
    if (abortRelease.done !== null) await abortRelease.done;
    await releasePass(sandbox, state, opts.door);
    if (state.network && networks !== null) await networks.remove(name).catch(() => undefined);
    // A key the pass never got to retire (an abort, a throw) is at least disabled, so nothing more is spent on it.
    const entryMasq = entryMasqOf(opts.upstream);
    const houseMasq = houseMasqOf(opts.upstream);
    if (entryMasq !== null && state.minted !== null && !state.retireTried) await entryMasq.broker.disable(state.minted.id).catch(() => undefined);
    if (houseMasq !== null && state.houseMinted !== null && !state.houseRetireTried) await houseMasq.broker.disable(state.houseMinted.id).catch(() => undefined);
    try {
      // One pod: the lanes' configs and records, under the host's root.
      if (state.laneDir !== null) await removeScratch(opts.sandbox, state.laneDir);
    } finally {
      if (scratch !== null) await removeScratch(opts.sandbox, scratch);
    }
  }
}

/** The masq the entry lane's key is minted on: TrialUpstream `masq`'s; none on a config and key, or on the entrant's own keys. */
function entryMasqOf(u: PassUpstream | undefined): MasqTrialUpstream | null {
  return u !== undefined && 'masq' in u ? u.masq : null;
}

/**
 * The masq a target's house lane key is minted on: TrialUpstream `masq`'s unless its `house` gives the lane an upstream
 * of its own (superbot-router's), or EntrantTrialUpstream's `house` on masq; else none.
 */
function houseMasqOf(u: PassUpstream | undefined): MasqTrialUpstream | null {
  if (u === undefined) return null;
  if ('masq' in u) return u.house === undefined ? u.masq : null;
  if ('provider' in u && u.house !== undefined && 'masq' in u.house) return u.house.masq;
  return null;
}

/** Whose key a pass's entry lane runs on (TrialPass.credential): LIVE the entrant's on EntrantTrialUpstream, else the house's; REPLAY none. */
export function passCredential(opts: Pick<RunTrialOptions, 'mode' | 'upstream'>): Credential | null {
  if (opts.mode !== 'live') return null;
  return opts.upstream !== undefined && 'provider' in opts.upstream ? 'entrant' : 'house';
}

/** The void reason of an infrastructure fault, or null for anything else. */
function faultOf(err: unknown): { reason: TrialVoidReason; message: string } | null {
  const text = (e: Error): string => `${e.name}: ${e.message}`;
  if (err instanceof TrialFault) return { reason: err.reason, message: err.message };
  if (err instanceof MasqBrokerError) return { reason: masqVoidReason(err), message: text(err) };
  // A preflight pod the node had no room for (k8s.ts NodeRoomError): backpressure, before anything of the pass's ran.
  if (err instanceof NodeRoomError) return { reason: NODE_CAPACITY_VOID_REASON, message: text(err) };
  if (err instanceof SandboxError) return { reason: 'sandbox', message: text(err) };
  if (err instanceof ScorerError) return { reason: 'scorer', message: text(err) };
  if (err instanceof CassetteError) return { reason: 'cassette', message: text(err) };
  return null;
}

/**
 * A broker fault's void reason: MasqBrokerError.voidReason, spelled from its op as masq.ts spells it, so
 * that a MasqBrokerOp with no TrialVoidReason does not compile.
 */
function masqVoidReason(err: MasqBrokerError): TrialVoidReason {
  return `masq_${err.op}_failed`;
}

/**
 * Every form of every secret the pass holds (upstream.ts secretFormSet): its env-lane entry secrets; on an entrant's own
 * keys those keys and the ids their check learned; and every masq key a lane of it runs on, each key it minted (`minted`:
 * PassState's, the entry lane's and the house lane's, null until minted) and a config's on the masq adapter, and the
 * house's router key a config on the `router` adapter carries (upstreamMasqKeys).
 * Null when it holds none (a pass on a fake, a replay with no entry secrets, an entrant with none and no house lane on
 * masq): what its stored stderr tail and its error are masked of (the header's entry secrets).
 */
export function passSecretForms(opts: Pick<RunTrialOptions, 'secrets' | 'upstream'>, minted: readonly (Pick<MintedTrialKey, 'key'> | null)[] = []): FormSet | null {
  const u = opts.upstream;
  const own = u !== undefined && 'provider' in u ? u.provider : null;
  const values = [
    ...secretValues(opts.secrets ?? undefined),
    ...(own === null ? [] : Object.values(own.keys).filter((k): k is string => typeof k === 'string')),
    ...(own === null ? [] : own.mask.filter((m): m is string => typeof m === 'string')),
    ...upstreamMasqKeys(u),
    ...minted.flatMap((m) => (m === null ? [] : [m.key])),
  ].filter((v) => v !== '');
  return values.length === 0 ? null : secretFormSet(values);
}

/**
 * The masq and router keys an upstream names itself: each lane's given as a config on the masq adapter with its key
 * (minted elsewhere) or on the `router` adapter with the house's router key, in every variant: the house lane's beside
 * an entrant's keys or beside TrialUpstream `masq` included. None for a key the pass mints (passSecretForms' `minted`),
 * and none for a `fake` or `none` config, whose key is no secret (and would be masked whole whatever its length).
 */
function upstreamMasqKeys(u: PassUpstream | undefined): string[] {
  if (u === undefined) return [];
  const lanes: (HouseLaneUpstream | { config: UpstreamConfigT; key: string } | undefined)[] = 'config' in u ? [u, u.house] : [u.house];
  return lanes.flatMap((l) => (l !== undefined && 'config' in l && (l.config.adapter === 'masq' || l.config.adapter === 'router') ? [l.key] : []));
}

function passOf(opts: RunTrialOptions, c: Pick<PassContext, 'name' | 'rec' | 'state'>, status: TrialPassStatus, reason: string | null, error: string | null): TrialPass {
  const { name, rec } = c;
  const forms = error === null ? null : passSecretForms(opts, [c.state.minted, c.state.houseMinted]);
  return {
    mode: opts.mode,
    status,
    reason,
    error: error === null || forms === null ? error : redactForms(error, forms),
    trial: { index: opts.trial.index, instance_sha256: opts.trial.instance_sha256 },
    name,
    prompt_sha256: rec.prompt_sha256,
    baseline_prompt: rec.baseline_prompt,
    entry: rec.entry,
    cassette_sha256: rec.cassette_sha256,
    pricing_rev: rec.pricing_rev,
    totals: rec.totals,
    credential: passCredential(opts),
    void_verdict: rec.void_verdict,
    replay: rec.replay,
    state_sha256: rec.state_sha256,
    outputs: rec.outputs,
    outputs_sha256: rec.outputs_sha256,
    env_log_sha256: rec.env_log_sha256,
    stderr_sha256: rec.stderr_sha256,
    scores: status === 'void' ? null : rec.scores,
    checks: status === 'void' ? null : rec.checks,
    checks_issue: status === 'void' ? null : rec.checks_issue,
    masq: rec.masq,
    house_cassette_sha256: rec.house_cassette_sha256,
    house_replay: rec.house_replay,
    house_masq: rec.house_masq,
    // Each nulled beside a null cassette as a courtesy (a log without its cassette serves no export); no check requires it.
    requests_sha256: rec.cassette_sha256 === null ? null : rec.requests_sha256,
    house_requests_sha256: rec.house_cassette_sha256 === null ? null : rec.house_requests_sha256,
    ...(rec.house_clock === null ? {} : { house_clock: rec.house_clock }),
  };
}

interface PassContext {
  sandbox: TrackedSandbox;
  signal: AbortSignal;
  name: string;
  rec: PassRecord;
  /** The docker CLI the services' SIGTERM goes through (terminate). */
  net: NetworkOptions & { exec: DockerExec };
  /** The pass's trial networks (network.ts trialNetworksOf); null on the process driver. */
  networks: TrialNetworks | null;
  state: PassState;
  scratch: string;
}

/**
 * What runTrial's cleanup undoes: the network, the entry, and each key minted (the entry's, the house lane's) never
 * retired; on one pod (the header's) the pod's address admitted at the door and the lanes' directory. And, on one pod,
 * whether the entry's memory ran out (the sandbox's, once the entry ran: the header's One pod).
 */
interface PassState {
  network: boolean;
  sup: Supervisor | null;
  minted: MintedTrialKey | null;
  retireTried: boolean;
  houseMinted: MintedTrialKey | null;
  houseRetireTried: boolean;
  pod: SandboxPod | null;
  /** On one pod: the address admitted at the door and not yet forgotten (forgetAdmitted). */
  admitted: string | null;
  /** On one pod: the forget under way or done, which every later caller awaits (forgetAdmitted). */
  forgetting: Promise<void> | null;
  /** On one pod: the driver found the pod gone or failed (a member's driver failure), and the lanes were cut at once. */
  podFailed: boolean;
  /** The pass asked for the entry's end (its ending decided, its kill to follow: superviseEntry); on one pod a member's end after it is the pass's own. */
  entryStopAsked: boolean;
  /** The pass told the env to stop (stopServices); on one pod an end of the env's before it says its sandbox is over or may be. */
  envStopAsked: boolean;
  laneDir: string | null;
  memory: boolean;
}

/** What either shape of a pass reads of its options first: its mode, each lane's policy, its credentials, its entry secrets. */
interface PassLanes {
  live: boolean;
  policy: GatewayPolicyT;
  /** The house lane (see the header's lanes): a target's, else none. */
  target: AgentTargetT | null;
  housePolicy: GatewayPolicyT | null;
  creds: PassCredentials;
  /** The entrant's env-lane entry secrets (the header's): the entry's own variables, and the request mask of its forwarder. */
  secrets: Readonly<Record<string, string>> | null;
  envSecrets: string[];
}

/** The entry's lane key opts.entryKey when given (the header's One pod: the run's own for the trial), else the trial's. */
function passLanes(opts: RunTrialOptions): PassLanes {
  const inference = opts.inference ?? opts.setup.harness.inference;
  const target: AgentTargetT | null = opts.setup.harness.target ?? null;
  const secrets = opts.secrets !== undefined && Object.keys(opts.secrets).length > 0 ? opts.secrets : null;
  const pricing = opts.pricingRev === undefined ? {} : { pricing_rev: opts.pricingRev };
  return {
    live: opts.mode === 'live',
    policy: policyFromInference(inference, pricing),
    target,
    housePolicy: target === null ? null : policyFromTarget(target, pricing),
    creds: passCredentials(opts.trial, opts.entryKey),
    secrets,
    envSecrets: secretValues(secrets ?? undefined),
  };
}

/** The empty seed directory a pass makes in its scratch for an instance whose input/env/ held no file (instanceEnvData). */
export const EMPTY_ENV_DATA_DIR = 'env-data';

/**
 * The env's seed directory of an instance whose digest already matched the trial's (passInstance; never called before
 * that): its input/env/ when that is a directory; when nothing is there at all, an empty directory of the pass's own,
 * `<scratch>/env-data`, made 0755. The instance digest covers files alone (instanceSha256: an empty directory is no part
 * of it), so a matched instance with no input/env/ is the sealed one exactly: its input/env/ held no file, and a copy
 * that carries files only lost the empty directory (the tier mirror off the data claim, server/blob-tier/mirror.ts: the
 * tier keeps no directories; a kit, cli/kit-instance.ts). The env reads the same nothing from either, so a grader off
 * the claim runs every instance one on the claim runs. Anything else there (a file, a link to no directory) is the
 * instance's fault, as is a directory the digest cannot vouch for: that one is never reached, a mismatch voids first.
 * The instance itself is never written: on the claim it is the sealed pool, and off it the mirror's copy.
 */
export async function instanceEnvData(instanceDir: string, scratch: string): Promise<string> {
  const at = join(instanceDir, 'input', 'env');
  const absent = await lstat(at).then(
    () => false,
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
  );
  if (absent) {
    const empty = join(scratch, EMPTY_ENV_DATA_DIR);
    await mkdir(empty, { mode: 0o755 });
    await chmod(empty, 0o755);
    return empty;
  }
  if (!(await stat(at).catch(() => null))?.isDirectory()) throw new TrialFault('instance', `the instance has no input/env/ for the env to read its seed from`);
  return at;
}

/** The instance: its digest checked, the pass's brief, the env's seed directory (instanceEnvData) and the trial's values. */
async function passInstance(opts: RunTrialOptions, scratch: string): Promise<{ brief: TrialBrief; envData: string; values: TrialValues }> {
  let digest: string;
  try {
    digest = await instanceSha256Async(opts.instanceDir);
  } catch (err) {
    throw new TrialFault('instance', `cannot read the instance ${opts.instanceDir}: ${(err as Error).message}`);
  }
  if (digest !== opts.trial.instance_sha256) throw new TrialFault('instance', `the instance in ${opts.instanceDir} is ${digest}, not the trial's ${opts.trial.instance_sha256}`);
  const brief = await trialBriefSource(opts.instanceDir, opts.baseline === true);
  const envData = await instanceEnvData(opts.instanceDir, scratch);
  const values = trialValues(opts.trial, await instanceOpenedAt(opts.instanceDir));
  return { brief, envData, values };
}

/** The entry's /input in the scratch: prompt.txt alone, the brief's bytes (recorded as the pass's). */
async function stageInput(scratch: string, brief: TrialBrief, rec: PassRecord): Promise<string> {
  const inputDir = join(scratch, 'input');
  await mkdir(inputDir, { mode: 0o755 });
  await chmod(inputDir, 0o755);
  const promptCopy = join(inputDir, PROMPT_FILE);
  await writeFile(promptCopy, brief.bytes, { flag: 'wx', mode: 0o600 });
  await sealStaged(promptCopy);
  rec.prompt_sha256 = brief.sha256;
  rec.baseline_prompt = brief.baseline;
  return inputDir;
}

/** Directories a sandboxed program writes, as whichever user it runs as (the env's /state, a forwarder's /record). */
async function makeWritable(dirs: readonly string[]): Promise<void> {
  for (const d of dirs) {
    await mkdir(d, { mode: 0o700 });
    await chmod(d, 0o777);
  }
}

/** A live pass's lane upstreams (laneUpstreams): the entry lane's config and key, and with a target the house lane's. */
interface LaneUpstreams {
  entryLane: { upstream: UpstreamConfigT; key: string } | ReturnType<typeof entrantLaneConfig> | null;
  houseUpstream: { config: UpstreamConfigT; key: string } | null;
}

/**
 * LIVE: each lane's upstream. On masq the pass's own key, and with a target the house lane's, minted (PassState holds
 * each for runTrial's cleanup); on the entrant's own keys none for the entry lane, and with a target the house lane's
 * alone, as on masq. REPLAY: none.
 */
async function laneUpstreams(opts: RunTrialOptions, c: PassContext, l: PassLanes): Promise<LaneUpstreams> {
  const { signal, rec } = c;
  const target = l.target;
  let entryLane: LaneUpstreams['entryLane'] = null;
  let houseUpstream: LaneUpstreams['houseUpstream'] = null;
  const u = opts.upstream;
  const entryMasq = entryMasqOf(u);
  const houseMasq = houseMasqOf(u);
  if (u !== undefined) {
    if (entryMasq !== null) {
      const minted = await guard(entryMasq.broker.mint(entryMasq.key, { signal }), signal);
      c.state.minted = minted;
      rec.masq = { key_id: minted.id, retired: null, flags: [] };
      const e = masqUpstreamConfig(entryMasq.origin, minted);
      entryLane = { upstream: e.upstream, key: e.key };
    } else if ('provider' in u) {
      entryLane = entrantLaneConfig(u.provider, l.envSecrets);
    } else if ('config' in u) {
      entryLane = { upstream: u.config, key: u.key };
    }
    if (target !== null && houseMasq !== null) {
      const houseKey: TrialKeySpec = { ...houseMasq.key, role: 'house', budgetUsdPerTrial: target.budget_usd_per_trial, models: [...target.models] };
      const house = await guard(houseMasq.broker.mint(houseKey, { signal }), signal);
      c.state.houseMinted = house;
      rec.house_masq = { key_id: house.id, retired: null, flags: [] };
      const h = masqUpstreamConfig(houseMasq.origin, house);
      houseUpstream = { config: h.upstream, key: h.key };
    } else if (target !== null && 'masq' in u) {
      // houseMasqOf: TrialUpstream `masq` with a `house` of its own (superbot-router's), nothing minted for the lane.
      houseUpstream = u.house === undefined ? null : { config: u.house.config, key: u.house.key };
    } else if (target !== null && 'provider' in u) {
      // checkRunOptions: a target's house lane beside an entrant's keys is masq (above) or a config and key.
      houseUpstream = u.house !== undefined && 'config' in u.house ? { config: u.house.config, key: u.house.key } : null;
    } else if (target !== null && 'config' in u) {
      houseUpstream = u.house ?? { config: u.config, key: u.key };
    }
  }
  return { entryLane, houseUpstream };
}

/** Where a pass's forwarders find their configs (laneConfigs), and the house lane's record directory (with a target: made writable). */
interface LaneConfigDirs {
  configDir: string;
  houseConfigDir: string | null;
  houseRecordDir: string;
}

/**
 * The forwarders' configs under `root` (and, REPLAY, each one's cassette and its bodies beside it), each with its lane's
 * caller, written in `mode`'s file mode (GATEWAY_CONFIG_FILE_MODES); with a target the house lane's record directory.
 */
async function laneConfigs(opts: RunTrialOptions, l: PassLanes, up: LaneUpstreams, root: string, mode: Sandbox['kind']): Promise<LaneConfigDirs> {
  const { live, policy, housePolicy, creds, envSecrets } = l;
  const trial = { index: opts.trial.index, instance_sha256: opts.trial.instance_sha256 };
  const entryClient = { lane: 'entry', token: creds.entryKey } as const;
  const gatewayConfig: GatewayConfigT = live
    ? { format: GATEWAY_CONFIG_FORMAT, mode: 'live', trial, policy, ...up.entryLane!, client: entryClient }
    : {
        format: GATEWAY_CONFIG_FORMAT,
        mode: 'replay',
        trial,
        policy,
        cassette_sha256: opts.cassette!.cassette_sha256,
        ...(envSecrets.length === 0 ? {} : { request_mask: envSecrets }),
        // The replay's request log (gateway/main.ts ReplayGatewayConfig.capture_requests): its live pass's bytes, put
        // back by the replayed requests, so a trial recorded before the log existed gets one from its next replay.
        capture_requests: true,
        client: entryClient,
      };
  const configDir = await writeGatewayConfig(join(root, 'private'), gatewayConfig, mode);
  if (!live) await stageReplayBlobs(opts.blobs, opts.cassette!.cassette_sha256, join(configDir, BLOBS_DIR));
  let houseConfigDir: string | null = null;
  const houseRecordDir = join(root, 'house-record');
  if (housePolicy !== null) {
    const houseClient = { lane: 'house', token: creds.houseToken } as const;
    const houseCassette = opts.cassette?.house_cassette_sha256;
    const houseConfig: GatewayConfigT = live
      ? { format: GATEWAY_CONFIG_FORMAT, mode: 'live', trial, policy: housePolicy, upstream: up.houseUpstream!.config, key: up.houseUpstream!.key, client: houseClient }
      : { format: GATEWAY_CONFIG_FORMAT, mode: 'replay', trial, policy: housePolicy, cassette_sha256: houseCassette!, capture_requests: true, client: houseClient };
    houseConfigDir = await writeGatewayConfig(join(root, 'house-private'), houseConfig, mode);
    if (!live) await stageReplayBlobs(opts.blobs, houseCassette!, join(houseConfigDir, BLOBS_DIR));
    await makeWritable([houseRecordDir]);
  }
  return { configDir, houseConfigDir, houseRecordDir };
}

async function runPass(opts: RunTrialOptions, c: PassContext): Promise<TrialPass> {
  const { sandbox, signal, name, scratch } = c;
  const kind = sandbox.kind;
  const l = passLanes(opts);
  const { live, creds, secrets } = l;
  const { brief, envData, values } = await passInstance(opts, scratch);

  await guard(sandbox.preflight('node22'), signal);
  await guard(sandbox.preflight(opts.snapshot.runtime, opts.snapshot.imageDigest ?? null), signal);

  // The scratch: /input (prompt.txt only: the brief's bytes), /state and /record (writable for the sandbox user), the config.
  const inputDir = await stageInput(scratch, brief, c.rec);
  const stateDir = join(scratch, 'state');
  const recordDir = join(scratch, 'record');
  await makeWritable([stateDir, recordDir]);

  const up = await laneUpstreams(opts, c, l);
  const { configDir, houseConfigDir, houseRecordDir } = await laneConfigs(opts, l, up, scratch, kind);

  // The network: what a dead grader left of this trial removed first, then the pass's own, labelled with the trial's owner.
  if (c.networks !== null) {
    if (opts.owner !== undefined) {
      const reaped = await guard(c.networks.reap(opts.owner), signal);
      opts.onReap?.(reaped);
    }
    if (live) await guard(c.networks.ensureEgress(), signal);
    await guard(c.networks.create(name, { owner: opts.owner ?? null }), signal);
    c.state.network = true;
  }
  const network = trialNetworkName(name);

  // The services. Each one's writable mount names what the pass reads of it while it runs (SandboxMount.live): a
  // forwarder's ready file (waitReady) and, on a replay, its miss file (entryEnding); the env's ready file and, on a house
  // clock, its call log as it grows (HouseClockReader). The rest comes back once the service has exited.
  const houseRow = houseClockOf(opts.setup.competition, opts.houseClocks);
  const recordMount = (host: string): SandboxMount => ({
    host,
    at: '/record',
    readOnly: false,
    live: [{ path: READY_FILE }, ...(live ? [] : [{ path: MISS_FILE }])],
    returns: RECORD_RETURNS,
  });
  const stateLive: SandboxLiveFile[] = [{ path: ENV_READY_FILE }, ...(houseRow === null ? [] : [{ path: ENV_LOG_FILE, follow: true }])];
  const env = envProgram(opts.setup);
  const envCode = kind === 'process' ? await writeLauncher(join(scratch, 'launch', 'env'), join(env.dir, env.script)) : { codeDir: env.dir, script: env.script };
  const fwdCode = kind === 'process' ? await writeLauncher(join(scratch, 'launch', 'forwarder'), join(opts.gateway.dir, opts.gateway.script)) : { codeDir: opts.gateway.dir, script: opts.gateway.script };
  const forwarderNet: SandboxNetwork = live ? trialAttachment(name, 'forwarder') : { name: network, aliases: [ROLE_ALIASES.forwarder] };
  // The house lane's forwarder (with a target) and the entry's start together; the env once the house's is ready, never
  // beside it: its environment names the house's origin (the process driver's port is known only from its ready file;
  // on k8s and under docker's netstack a peer's name reaches only the pods made after it registered), and it calls the
  // house as it starts (a game's first house turns), so the house must be listening by then. The entry's forwarder
  // serves the entry alone, which starts once every service is ready.
  let houseSvc: TrialService | null = null;
  let houseEnv: Record<string, string> = {};
  if (houseConfigDir !== null) {
    houseSvc = new TrialService(
      'house',
      TRIAL_LABELS.house,
      sandbox.spawn({
        runtime: 'node22',
        ...fwdCode,
        mounts: [
          { host: houseConfigDir, at: '/config', readOnly: true },
          recordMount(houseRecordDir),
        ],
        limits: SERVICE_LIMITS,
        label: TRIAL_LABELS.house,
        network: live ? trialAttachment(name, 'house') : { name: network, aliases: [ROLE_ALIASES.house] },
        ...(kind === 'process' ? { env: { MAKEFUN_GATEWAY_PORT: '0' } } : {}),
      }),
    );
  }
  const fwdSvc = new TrialService(
    'forwarder',
    TRIAL_LABELS.forwarder,
    sandbox.spawn({
      runtime: 'node22',
      ...fwdCode,
      mounts: [
        { host: configDir, at: '/config', readOnly: true },
        recordMount(recordDir),
      ],
      limits: SERVICE_LIMITS,
      label: TRIAL_LABELS.forwarder,
      network: forwarderNet,
      ...(kind === 'process' ? { env: { MAKEFUN_GATEWAY_PORT: '0' } } : {}),
    }),
  );
  if (houseSvc !== null) {
    const [housePort] = await waitReady([{ svc: houseSvc, file: join(houseRecordDir, READY_FILE), result: join(houseRecordDir, RESULT_FILE) }], (exit) => sandbox.isDriverFailure(exit), signal);
    await forgetGatewayConfig(houseConfigDir!);
    houseEnv = {
      [AGENT_HOUSE_ENV.houseLlmUrl]: serviceEndpoint(kind, 'house', kind === 'process' ? housePort : undefined).origin,
      [AGENT_HOUSE_ENV.houseToken]: creds.houseToken,
    };
  }
  const envSvc = new TrialService(
    'env',
    TRIAL_LABELS.env,
    sandbox.spawn({
      runtime: 'node22',
      ...envCode,
      mounts: [
        { host: envData, at: '/env-data', readOnly: true },
        { host: stateDir, at: '/state', readOnly: false, live: stateLive, returns: STATE_RETURNS },
      ],
      limits: ENV_LIMITS,
      cpusCeiling: true,
      label: TRIAL_LABELS.env,
      network: trialAttachment(name, 'env'),
      env: { MAKEFUN_SHOP_TOKEN: values.shop_token, ...houseEnv, ...(kind === 'process' ? { MAKEFUN_ENV_PORT: '0' } : {}) },
    }),
  );
  const services = houseSvc === null ? [envSvc, fwdSvc] : [envSvc, fwdSvc, houseSvc];
  const [envPort, fwdPort] = await waitReady(
    [
      { svc: envSvc, file: join(stateDir, ENV_READY_FILE) },
      { svc: fwdSvc, file: join(recordDir, READY_FILE), result: join(recordDir, RESULT_FILE) },
    ],
    (exit) => sandbox.isDriverFailure(exit),
    signal,
  );
  await forgetGatewayConfig(configDir);

  // The entry.
  const store = serviceEndpoint(kind, 'env', kind === 'process' ? envPort : undefined).origin;
  const llm = serviceEndpoint(kind, 'forwarder', kind === 'process' ? fwdPort : undefined).origin;
  const promptFile = containerized(kind) ? `/input/${PROMPT_FILE}` : join(inputDir, PROMPT_FILE);
  const entryProc = sandbox.spawn({
    runtime: opts.snapshot.runtime,
    codeDir: opts.snapshot.dir,
    mounts: [{ host: inputDir, at: '/input', readOnly: true }],
    limits: { cpus: opts.limits.cpus, memory_mb: opts.limits.memory_mb, pids: opts.limits.pids },
    label: TRIAL_LABELS.entry,
    imageDigest: opts.snapshot.imageDigest ?? null,
    network: trialAttachment(name, 'entry'),
    env: entryEnvironment({ store, llm, promptFile, values, llmKey: creds.entryKey }),
    ...(secrets === null ? {} : { secrets }),
  });
  const missFiles = live ? [] : [{ lane: 'entry' as const, file: join(recordDir, MISS_FILE) }, ...(houseSvc === null ? [] : [{ lane: 'house' as const, file: join(houseRecordDir, MISS_FILE) }])];
  const { ending, sup } = await superviseEntry(opts, c, entryProc, services, missFiles, stateDir);
  const results = await stopServices(c, { envSvc, fwdSvc, houseSvc, recordDir, houseRecordDir }, ending, network);
  if (c.state.network && c.networks !== null) {
    await guard(c.networks.remove(name), signal);
    c.state.network = false;
  }
  return await finishPass(opts, c, { lanes: l, ...results, hasHouse: houseSvc !== null, recordDir, houseRecordDir, stateDir, sup, ending });
}

/**
 * The entry's run (the header's step 6 on), supervised to its end (see Ending): its wall budget, on a house clock moved
 * out by the credit; then its record (PassRecord.entry, house_clock) and the faults its end says: the house clock's
 * ceiling, the driver failing the entry (node_capacity when the node had no room for its pod), a service that exited
 * under it. On one pod, a sandbox out of memory once the entry ran is the entry's memory (PassState.memory: the
 * header's One pod), which says none of the faults its members' ends would.
 */
async function superviseEntry(
  opts: RunTrialOptions,
  c: PassContext,
  entryProc: SandboxProcess,
  services: readonly TrialService[],
  missFiles: readonly { lane: Lane; file: string }[],
  stateDir: string,
): Promise<{ ending: Ending; sup: Supervisor }> {
  const { sandbox, signal, rec } = c;
  // On a house clock (the header's), the env's call log read while the entry runs: every HOUSE_CLOCK_POLL_MS and once
  // more as its deadline falls due, the deadline moved out by the credit. Without one, the budget is fixed, as ever.
  const houseRow = houseClockOf(opts.setup.competition, opts.houseClocks);
  const clock = houseRow === null ? null : new HouseClockReader(houseRow, opts.limits.wall_budget_sec, join(stateDir, ENV_LOG_FILE));
  const sup = new Supervisor(entryProc, {
    budgetMs: opts.limits.wall_budget_sec * 1000,
    maxStderrBytes: MAX_STDERR_BYTES,
    stdout: { mode: 'capture', maxBytes: MAX_PROGRAM_STDOUT_BYTES },
    ...(clock === null
      ? {}
      : {
          atDeadline: async () => {
            await clock.read();
            return clock.budgetMs();
          },
        }),
  });
  c.state.sup = sup;
  sup.closeStdin();
  let ending: Ending;
  /** On a house clock: the budget the entry's deadline stood at as it ended (a read settling after cannot move it). */
  let endBudgetMs = sup.budgetMs;
  if (clock === null) ending = await guard(entryEnding(sup, services, missFiles), signal);
  else {
    const poll = setInterval(() => {
      void clock.read().then(() => sup.extendBudget(clock.budgetMs()));
    }, HOUSE_CLOCK_POLL_MS);
    poll.unref();
    try {
      ending = await guard(entryEnding(sup, services, missFiles, Math.max(clock.wallMs, clock.row.ceilingSec * 1000)), signal);
      endBudgetMs = sup.budgetMs;
    } finally {
      clearInterval(poll);
    }
    // The count as the entry ended: a read under way then settled, none begun after.
    await guard(clock.idle(), signal);
  }
  c.state.entryStopAsked = true;
  await guard(sup.kill(), signal);
  // One pod: only the pod's total memory is enforced, so a sandbox out of memory once the entry ran is the entry's.
  const memory = c.state.pod !== null && c.state.pod.oom && sup.runningAt !== null;
  c.state.memory = memory;
  rec.entry = memory ? { ended: 'limit', exit: sup.exit, wall_ms: Math.round(sup.elapsedMs()), detail: TRIAL_MEMORY_DETAIL } : entryRun(ending, sup);
  if (clock !== null && sup.runningAt !== null) {
    const owed = clock.credit();
    rec.house_clock = { house_ms: Math.round(clock.houseMs), bound_ms: clock.row.houseSec * 1000, credit_ms: Math.max(0, Math.round(endBudgetMs - clock.wallMs)) };
    // Cut with more of the house's time owed it than the ceiling holds: its own deadline lay past the ceiling, so the
    // house alone ran it out. The platform's fault, never the entry's: void, never scored 0 (a replay so cut, too).
    if (ending.kind === 'timeout' && owed.owed_ms > owed.credit_ms) {
      rec.faults.push({
        reason: HOUSE_CLOCK_VOID_REASON,
        message:
          `the house took ${Math.round(clock.houseMs)} ms of the pass, ${owed.owed_ms} ms past the ${clock.row.houseSec} s the rules state, ` +
          `and the entry was cut at the house clock's ${clock.row.ceilingSec} s ceiling with ${owed.owed_ms - owed.credit_ms} ms of it still owed: the house's time, never the entry's`,
      });
    }
  }
  if (!memory && ending.kind === 'exited' && sandbox.isDriverFailure(ending.exit)) {
    // The node had no room for the entry's pod: backpressure, never a fault (the header's How a pass ends).
    const noRoom = noRoomOf(entryProc);
    rec.faults.push(
      noRoom !== null
        ? { reason: NODE_CAPACITY_VOID_REASON, message: `the node had no room for the entry's pod, which never ran (${noRoom})` }
        : { reason: 'sandbox', message: `the sandbox failed running the entry (${describeExit(ending.exit)})` },
    );
  }
  // The env shares the one pod's memory: its end in a sandbox out of memory is the entry's memory, not its own fault.
  // A lane cut because the pod was found failed (runPodPass) ends by our kill: the sandbox's fault, never the lane's.
  if (ending.kind === 'service' && !(memory && ending.svc.role === 'env')) {
    const reason = sandbox.isDriverFailure(ending.exit) || (c.state.podFailed && ending.svc.role !== 'env') ? 'sandbox' : ending.svc.role === 'env' ? 'env' : 'gateway';
    rec.faults.push({ reason, message: `${ending.svc.name} exited while the entry ran (${describeExit(ending.exit)}): ${ending.svc.logTail()}` });
  }
  return { ending, sup };
}

/** A pass's services as they are stopped (stopServices) and their records read (finishPass): the env, the entry's forwarder and with a target the house's. */
interface PassServices {
  envSvc: TrialService;
  fwdSvc: TrialService;
  houseSvc: TrialService | null;
  recordDir: string;
  houseRecordDir: string;
}

/** Each forwarder's result.json as stopServices read it (null when it wrote none that is one). */
interface LaneResults {
  doc: GatewayResultDoc | null;
  houseDoc: GatewayResultDoc | null;
}

/**
 * The services stop: the env exports, each forwarder writes its cassette or verdict. The env and the entry's forwarder
 * side by side (neither is the other's client, and the entry is gone); the house's once the env has exited, never
 * before: the env is its client, and a house that stopped under it would fail the env's turns in flight, moving the
 * state it exports. The faults each one's stop says; the env's none when its sandbox's memory ran out under the entry
 * (PassState.memory), which ended it.
 */
async function stopServices(c: PassContext, s: PassServices, ending: Ending, network: string): Promise<LaneResults> {
  const { sandbox, rec } = c;
  const kind = sandbox.kind;
  const { envSvc, fwdSvc, houseSvc, recordDir, houseRecordDir } = s;
  c.state.envStopAsked = true;
  const envStop = terminate(envSvc, kind, c, network);
  const fwdStop = terminate(fwdSvc, kind, c, network);
  const houseFwd = houseSvc;
  const houseStop = houseFwd === null ? null : envStop.then(() => terminate(houseFwd, kind, c, network));
  const [envExit, fwdExit, houseExit] = await settledInOrder([envStop, fwdStop, houseStop]);
  if (c.state.memory) {
    // The env ended with its sandbox (the header's One pod): what its stop says is the entry's memory, not the env's.
  } else if (envExit === null) rec.faults.push({ reason: 'env', message: `the env did not exit within ${SERVICE_STOP_MS} ms of its SIGTERM: ${envSvc.logTail()}` });
  else if (ending.kind !== 'service' || ending.svc !== envSvc) {
    if (envExit.code !== 0) rec.faults.push({ reason: sandbox.isDriverFailure(envExit) ? 'sandbox' : 'env', message: `the env exited with ${describeExit(envExit)} on its SIGTERM: ${envSvc.logTail()}` });
  }
  if (fwdExit === null) rec.faults.push({ reason: 'gateway', message: `the forwarder did not exit within ${SERVICE_STOP_MS} ms of its SIGTERM: ${fwdSvc.logTail()}` });
  const result = await readJson(join(recordDir, RESULT_FILE));
  const doc = gatewayResultOf(result);
  if (doc === null) {
    rec.faults.push({ reason: 'gateway', message: `the forwarder wrote no result${fwdExit === null ? '' : ` (${describeExit(fwdExit)})`}: ${fwdSvc.logTail()}` });
  } else if (doc.faults.length > 0) {
    rec.faults.push({ reason: 'gateway', message: `the forwarder's faults: ${doc.faults.join('; ')}` });
  }
  let houseDoc: GatewayResultDoc | null = null;
  if (houseSvc !== null) {
    if (houseExit === null) rec.faults.push({ reason: 'gateway', message: `the house forwarder did not exit within ${SERVICE_STOP_MS} ms of its SIGTERM: ${houseSvc.logTail()}` });
    houseDoc = gatewayResultOf(await readJson(join(houseRecordDir, RESULT_FILE)));
    if (houseDoc === null) {
      rec.faults.push({ reason: 'gateway', message: `the house forwarder wrote no result${houseExit === null ? '' : ` (${describeExit(houseExit)})`}: ${houseSvc.logTail()}` });
    } else if (houseDoc.faults.length > 0) {
      rec.faults.push({ reason: 'gateway', message: `the house forwarder's faults: ${houseDoc.faults.join('; ')}` });
    }
  }
  return { doc, houseDoc };
}

/** What finishPass reads of a pass whose services have stopped. */
interface PassTail extends LaneResults {
  lanes: PassLanes;
  hasHouse: boolean;
  recordDir: string;
  houseRecordDir: string;
  stateDir: string;
  sup: Supervisor;
  ending: Ending;
}

/**
 * The records (the header's step 7), each masq key retired, and how the pass ended (the header's How a pass ends). On
 * one pod with the entry's memory run out (PassState.memory), the env's missing log or export is no fault of the env's,
 * and the pass ends as a timeout does (REPLAY replay_timeout).
 */
async function finishPass(opts: RunTrialOptions, c: PassContext, t: PassTail): Promise<TrialPass> {
  const { sandbox, signal, rec, scratch } = c;
  const { lanes, doc, houseDoc, hasHouse, recordDir, houseRecordDir, stateDir, sup, ending } = t;
  const { live, policy, housePolicy } = lanes;
  const credential: Credential = passCredential(opts) ?? 'house';
  const entryMasq = entryMasqOf(opts.upstream);
  const houseMasq = houseMasqOf(opts.upstream);
  const memory = c.state.memory;

  // The records. LIVE each lane's cassette stored side by side (each one's bodies before it: storeCassette); a store that
  // fails throws as it did one after the other, the entry lane's first.
  const entrySha = live && doc !== null ? doc.cassette_sha256 : null;
  const houseSha = live && houseDoc !== null ? houseDoc.cassette_sha256 : null;
  const [entryStored, houseStored] = await guard(
    settledInOrder([
      entrySha === null ? null : storeCassette(join(recordDir, BLOBS_DIR), entrySha, opts.blobs),
      houseSha === null ? null : storeCassette(join(houseRecordDir, BLOBS_DIR), houseSha, opts.blobs),
    ]),
    signal,
  );
  if (entrySha !== null && entryStored !== null) {
    const cassette = entryStored;
    rec.cassette_sha256 = entrySha;
    rec.pricing_rev = cassette.pricing_rev;
    rec.totals = cassette.totals;
    rec.void_verdict = voidVerdictOf(cassette.entries, policy.void_upstream_error_share, { credential });
  } else if (live && rec.faults.length === 0) {
    rec.faults.push({ reason: 'gateway', message: 'the forwarder recorded no cassette' });
  }
  if (!live) {
    rec.cassette_sha256 = opts.cassette!.cassette_sha256;
    rec.replay = doc?.replay ?? null;
    if (doc !== null && rec.replay === null && doc.faults.length === 0) rec.faults.push({ reason: 'gateway', message: 'the forwarder gave no replay verdict' });
  }
  // The house lane's cassette: its spend the house's (its own totals, never the pass's), any upstream error there a void.
  if (hasHouse && live) {
    if (houseSha !== null && houseStored !== null) {
      const cassette = houseStored;
      rec.house_cassette_sha256 = houseSha;
      rec.house_totals = cassette.totals;
      rec.house_void = voidVerdictOf(cassette.entries, housePolicy!.void_upstream_error_share);
    } else if (rec.faults.length === 0) {
      rec.faults.push({ reason: 'gateway', message: 'the house forwarder recorded no cassette' });
    }
  }
  if (hasHouse && !live) {
    rec.house_cassette_sha256 = opts.cassette!.house_cassette_sha256!;
    rec.house_replay = houseDoc?.replay ?? null;
    if (houseDoc !== null && rec.house_replay === null && houseDoc.faults.length === 0) rec.faults.push({ reason: 'gateway', message: 'the house forwarder gave no replay verdict' });
  }
  // LIVE each lane's request log, copied beside the cassette stored for it, side by side (storeRequestLog): one that is
  // not kept is a line on opts.log and null, never a fault, never a throw, so nothing else of the pass moves with it.
  // A REPLAY that captured its log (gateway/main.ts ReplayGatewayConfig.capture_requests, which the pass's replay configs
  // name) copies it alike, beside the cassette its live pass recorded: the replayed requests are the live pass's bytes, so
  // a trial recorded before the log existed gets one from its next replay. A replay that captured none has nothing to
  // copy and leaves both null (storeRequestLog reads a document naming no log as none).
  const capturedLog = (d: GatewayResultDoc | null): boolean => d !== null && d.requests_sha256 !== null;
  if ((live || capturedLog(doc) || capturedLog(houseDoc)) && (rec.cassette_sha256 !== null || rec.house_cassette_sha256 !== null)) {
    const forms = passSecretForms(opts, [c.state.minted, c.state.houseMinted]);
    const [entryLog, houseLog] = await settledInOrder([
      rec.cassette_sha256 === null ? null : storeRequestLog(opts, 'entry', join(recordDir, BLOBS_DIR), doc, forms),
      rec.house_cassette_sha256 === null ? null : storeRequestLog(opts, 'house', join(houseRecordDir, BLOBS_DIR), houseDoc, forms),
    ]);
    rec.requests_sha256 = entryLog;
    rec.house_requests_sha256 = houseLog;
  }
  const logFile = join(stateDir, ENV_LOG_FILE);
  if (existsSync(logFile)) rec.env_log_sha256 = await guard(putFile(opts.blobs, logFile), signal);
  else if (!memory) rec.faults.push({ reason: 'env', message: `the env wrote no ${ENV_LOG_FILE}` });
  const exported = await guard(storeExport(join(stateDir, ENV_EXPORT_DIR), opts.blobs), signal);
  if ('fault' in exported) {
    if (!memory) rec.faults.push({ reason: 'env', message: exported.fault });
  } else {
    rec.outputs = exported.outputs;
    rec.state_sha256 = exported.state_sha256;
    rec.outputs_sha256 = (await guard(opts.blobs.put(Buffer.from(canonicalJson(exported.outputs), 'utf8')), signal)).sha256;
  }
  // Masked whole before its tail is cut, so the cut never splits an occurrence the mask would have caught; of every
  // secret the pass holds, each masq key it minted included (passSecretForms).
  const forms = passSecretForms(opts, [c.state.minted, c.state.houseMinted]);
  const stderr = forms === null ? sup.stderr() : maskBytes(sup.stderr(), forms);
  rec.stderr_sha256 = (await guard(opts.blobs.put(stderr.subarray(Math.max(0, stderr.length - STDERR_TAIL_BYTES))), signal)).sha256;

  // LIVE on masq: each key minted retired, retried as it fails; a pass that would count is void when one cannot be. The
  // two retire side by side (each its own settle reads, masq.ts MASQ_SPEND_SETTLE_GAP_MS, none shortened), their
  // outcomes recorded in lane order, the entry's first.
  const entryKey = live && entryMasq !== null ? c.state.minted : null;
  const houseKey = live && houseMasq !== null ? c.state.houseMinted : null;
  // A retirement that throws (an abort, no broker fault) leaves its key untried, for runTrial's cleanup to disable.
  const retiring = (m: MasqTrialUpstream | null, key: MintedTrialKey | null, totals: CassetteT['totals'] | null, tried: () => void) => {
    if (m === null || key === null) return null;
    return retireWithRetries(m, key.id, totals === null ? 0n : BigInt(totals.micro_usd), signal).then((r) => {
      tried();
      return r;
    });
  };
  const [entryRetired, houseRetired] = await settledInOrder([
    retiring(entryMasq, entryKey, rec.totals, () => {
      c.state.retireTried = true;
    }),
    retiring(houseMasq, houseKey, rec.house_totals, () => {
      c.state.houseRetireTried = true;
    }),
  ]);
  if (entryKey !== null && entryRetired !== null) {
    const r = entryRetired;
    if ('retired' in r) {
      rec.masq = { key_id: entryKey.id, retired: r.retired, flags: [...r.retired.flags] };
    } else {
      rec.faults.push({ reason: masqVoidReason(r.error), message: `${r.error.name}: ${r.error.message}` });
    }
  }
  if (houseKey !== null && houseRetired !== null) {
    const r = houseRetired;
    if ('retired' in r) {
      rec.house_masq = { key_id: houseKey.id, retired: r.retired, flags: [...r.retired.flags] };
    } else {
      rec.faults.push({ reason: masqVoidReason(r.error), message: `the house lane's key: ${r.error.name}: ${r.error.message}` });
    }
  }

  // How it ended.
  if (rec.faults.length > 0) return passOf(opts, c, 'void', rec.faults[0]!.reason, rec.faults.map((f) => f.message).join('; '));
  if (live) {
    const v = rec.void_verdict!;
    if (v.void) {
      const entrants = v.entrant_errors === undefined || v.entrant_errors === 0 ? '' : `; ${v.entrant_errors} more answered ${ENTRANT_ERROR_STATUSES.join(', ')} on the entrant's own key, which are the entrant's and count toward no void`;
      return passOf(opts, c, 'void', 'upstream_errors', `${v.upstream_errors} of ${v.forwarded} forwarded requests met an upstream error, at least the void share ${v.share} (and at least 3)${entrants}`);
    }
    const h = rec.house_void;
    if (h !== null && h.upstream_errors > 0) {
      return passOf(opts, c, 'void', 'upstream_errors', `${h.upstream_errors} of ${h.forwarded} requests the house lane forwarded met an upstream error: any there voids the trial, the house's fault`);
    }
    // The entry's memory run out on one pod scores as its time run out: its sandbox's total is its cap.
    if (ending.kind === 'timeout' || memory) {
      rec.scores = timeoutScores(opts.setup.leaderboard);
      return passOf(opts, c, 'timeout', null, null);
    }
    if (opts.score !== false) {
      const scored = await guard(
        scoreTrialWithChecks({ sandbox, setup: opts.setup, instanceDir: opts.instanceDir, outputs: rec.outputs!, blobs: opts.blobs, limits: opts.limits, workDir: scratch, cassette_sha256: rec.cassette_sha256 }),
        signal,
      );
      rec.scores = scored.scores;
      rec.checks = scored.checks;
      rec.checks_issue = scored.checks_issue;
    }
    return passOf(opts, c, 'live_done', null, null);
  }
  // Each lane's verdict: the entry's, and with a target the house's (a fault above when either forwarder gave none).
  const verdicts: { lane: Lane; verdict: ReplayVerdict }[] = [{ lane: 'entry', verdict: rec.replay! }, ...(hasHouse ? [{ lane: 'house' as const, verdict: rec.house_replay! }] : [])];
  const cassetteOf = (lane: Lane): string => (lane === 'house' ? 'the house lane\'s cassette' : 'the cassette');
  const missed = ending.kind === 'miss' ? verdicts.find((v) => v.lane === ending.lane)! : verdicts.find((v) => !v.verdict.ok && v.verdict.fault === 'cassette_miss');
  if (missed !== undefined) {
    const misses = missed.verdict.ok ? [] : missed.verdict.misses;
    const where = misses.length > 0 ? ` (${misses[0]!.route}, key ${misses[0]!.request_key ?? 'none'})` : '';
    return passOf(opts, c, 'nondeterministic', 'cassette_miss', `the replay sent a request ${cassetteOf(missed.lane)} does not hold at that point${where}${ending.kind === 'miss' ? ': the entry was stopped there' : ''}`);
  }
  if (memory) return passOf(opts, c, 'nondeterministic', 'replay_timeout', `${TRIAL_MEMORY_DETAIL} on the replay, which its live pass's did not, with every model answer served at once`);
  if (ending.kind === 'timeout') return passOf(opts, c, 'nondeterministic', 'replay_timeout', 'the replay ran out of wall budget, which its live pass did not, with every model answer served at once');
  for (const { lane, verdict } of verdicts) {
    if (!verdict.ok) return passOf(opts, c, 'nondeterministic', verdict.fault, `the replay left ${verdict.unconsumed.length} ${lane === 'house' ? 'house lane ' : ''}cassette entries unconsumed (seq ${verdict.unconsumed.slice(0, 5).join(', ')}${verdict.unconsumed.length > 5 ? ', …' : ''})`);
  }
  if (rec.state_sha256 !== opts.cassette!.state_sha256) {
    return passOf(opts, c, 'nondeterministic', 'state_mismatch', `the replay exported state.json ${rec.state_sha256}, not the live pass's ${opts.cassette!.state_sha256}`);
  }
  return passOf(opts, c, 'finished', null, null);
}

/** The lanes' host, the door and the sandbox's pods a pass on one pod runs with (the header's One pod). */
interface OnePod {
  hosted: HostedServices;
  door: Door;
  pods: SandboxPods;
}

/**
 * One pass on one pod (the header's One pod): the entry and the env the two members of one sandbox pod, each forwarder a
 * hosted lane reached through the door. What it shares with runPass (the instance, the keys, the configs, the entry's
 * supervision, the services' stop and the records) is the same code; what differs is where each program runs and when
 * it starts.
 */
async function runPodPass(opts: RunTrialOptions, c: PassContext, one: OnePod): Promise<TrialPass> {
  const { sandbox, signal, scratch } = c;
  const { hosted, door, pods } = one;
  const kind = sandbox.kind;
  // The entry's lane key the run's own for the trial (opts.entryKey, which checkRunOptions required): every trial pod may dial every door.
  const l = passLanes(opts);
  const { live, target, creds, secrets } = l;
  const { brief, envData, values } = await passInstance(opts, scratch);

  await guard(sandbox.preflight('node22'), signal);
  await guard(sandbox.preflight(opts.snapshot.runtime, opts.snapshot.imageDigest ?? null), signal);

  // The scratch: /input (prompt.txt only: the brief's bytes) and /state (writable for the env's user).
  const inputDir = await stageInput(scratch, brief, c.rec);
  const stateDir = join(scratch, 'state');
  await makeWritable([stateDir]);

  // What a dead grader left of this trial (its pod among it) removed first; no network is made.
  if (c.networks !== null && opts.owner !== undefined) {
    const reaped = await guard(c.networks.reap(opts.owner), signal);
    opts.onReap?.(reaped);
  }

  // The pod: `env` serves `store` on 8080 at 127.0.0.1; `llm` (and with a target `house`) are the door's. Its /state
  // declares what the split pass's does: the live files the pass reads while the env runs (its ready file; with a house
  // clock, its call log as it grows), mirrored from the pod's `watch`, and STATE_RETURNS, what comes back once it exits.
  const houseRow = houseClockOf(opts.setup.competition, opts.houseClocks);
  const stateLive: SandboxLiveFile[] = [{ path: ENV_READY_FILE }, ...(houseRow === null ? [] : [{ path: ENV_LOG_FILE, follow: true }])];
  const env = envProgram(opts.setup);
  const store = serviceEndpoint(kind, 'env');
  const llm = `http://${ROLE_ALIASES.forwarder}:${door.ports.entry}`;
  const houseEnv: Record<string, string> = target === null ? {} : { [AGENT_HOUSE_ENV.houseLlmUrl]: `http://${ROLE_ALIASES.house}:${door.ports.house}`, [AGENT_HOUSE_ENV.houseToken]: creds.houseToken };
  const plan: SandboxPodPlan = {
    label: TRIAL_POD_LABEL,
    members: {
      env: {
        runtime: 'node22',
        codeDir: env.dir,
        script: env.script,
        mounts: [
          { host: envData, at: '/env-data', readOnly: true },
          { host: stateDir, at: '/state', readOnly: false, live: stateLive, returns: STATE_RETURNS },
        ],
        limits: ENV_LIMITS,
        label: TRIAL_LABELS.env,
        env: { MAKEFUN_ENV_HOST: LOOPBACK, MAKEFUN_SHOP_TOKEN: values.shop_token, ...houseEnv },
      },
      entry: {
        runtime: opts.snapshot.runtime,
        codeDir: opts.snapshot.dir,
        mounts: [{ host: inputDir, at: '/input', readOnly: true }],
        limits: { cpus: opts.limits.cpus, memory_mb: opts.limits.memory_mb, pids: opts.limits.pids },
        label: TRIAL_LABELS.entry,
        imageDigest: opts.snapshot.imageDigest ?? null,
        env: entryEnvironment({ store: store.origin, llm, promptFile: `/input/${PROMPT_FILE}`, values, llmKey: creds.entryKey }),
        ...(secrets === null ? {} : { secrets }),
      },
    },
    local: [{ name: ROLE_ALIASES.env, member: 'env', port: store.port }],
    doors: {
      address: door.address,
      names: target === null ? [ROLE_ALIASES.forwarder] : [ROLE_ALIASES.forwarder, ROLE_ALIASES.house],
      ports: { entry: door.ports.entry, ...(target === null ? {} : { env: door.ports.house }) },
    },
    ...(opts.podRequests === undefined ? {} : { requests: { cpuMilli: opts.podRequests.cpuMilli, memoryMi: opts.podRequests.memoryMi } }),
    owner: opts.owner ?? null,
  };
  const pod = pods.open(plan);
  c.state.pod = pod;
  // Nothing is minted, staged or started for a pod the scheduler has not placed (no room: node_capacity, no key made).
  await guard(pod.scheduled, signal);

  // While the pod comes up: the keys, the lanes' configs and records under the host's root, the lanes started.
  const up = await laneUpstreams(opts, c, l);
  const laneDir = await mkdtemp(join(hosted.root, 'trial-'));
  holdScratch(laneDir);
  c.state.laneDir = laneDir;
  const recordDir = join(laneDir, 'record');
  await makeWritable([recordDir]);
  // The config file 0400, as the process driver's: a lane reads it as its host hands it over, never as another user.
  const { configDir, houseConfigDir, houseRecordDir } = await laneConfigs(opts, l, up, laneDir, 'process');
  const lane = (role: 'forwarder' | 'house', label: string, cfg: string, record: string): { svc: TrialService; proc: HostedProcess } => {
    const proc = sandbox.track(hosted.spawn({ dir: opts.gateway.dir, script: opts.gateway.script, configDir: cfg, recordDir: record, label }));
    return { svc: new TrialService(role, label, proc, proc), proc };
  };
  const fwd = lane('forwarder', TRIAL_LABELS.forwarder, configDir, recordDir);
  const house = houseConfigDir === null ? null : lane('house', TRIAL_LABELS.house, houseConfigDir, houseRecordDir);
  await waitReady(
    [
      { svc: fwd.svc, file: join(recordDir, READY_FILE), result: join(recordDir, RESULT_FILE) },
      ...(house === null ? [] : [{ svc: house.svc, file: join(houseRecordDir, READY_FILE), result: join(houseRecordDir, RESULT_FILE) }]),
    ],
    (exit) => sandbox.isDriverFailure(exit),
    signal,
  );
  await forgetGatewayConfig(configDir);
  if (houseConfigDir !== null) await forgetGatewayConfig(houseConfigDir);

  // The pod Ready: its address admitted at the door to its own lanes alone.
  const ip = await guard(pod.address, signal);
  c.state.admitted = ip;
  await guard(door.admit(ip, { entry: fwd.proc, ...(house === null ? {} : { house: house.proc }) }), signal);

  // The pod found gone or failed by the driver (a member's exit its failure: the pod deleted behind its back, evicted,
  // its node gone): the address forgotten and the lanes stopped at once, before anything else of the pass's end, so no
  // pod the node hands that address to next is ever joined to them. The pass is the sandbox's fault (superviseEntry).
  // A member's end that says the sandbox is over or may be (podSandboxOver: the pod out of memory, the env ending
  // before the pass told it to stop, an entry that never ran killed unasked): the address forgotten at once too, the
  // lanes left to the end's ordered stop (their records are still the pass's).
  const lanesHeld = house === null ? [fwd.proc] : [fwd.proc, house.proc];
  const watchMember = (member: 'env' | 'entry', proc: SandboxProcess): void => {
    void proc.exited.then((exit) => {
      if (sandbox.isDriverFailure(exit)) {
        if (c.state.podFailed) return;
        c.state.podFailed = true;
        void forgetAdmitted(c.state, door);
        for (const p of lanesHeld) void p.kill().catch(() => undefined);
        return;
      }
      if (podSandboxOver(c.state, pod, member, exit)) void forgetAdmitted(c.state, door);
    });
  };

  // The env, then (its bind proof first, in the driver) the entry.
  const envProc = pod.spawn('env');
  watchMember('env', envProc);
  const envSvc = new TrialService('env', TRIAL_LABELS.env, envProc, envProc);
  const [envPort] = await waitReady([{ svc: envSvc, file: join(stateDir, ENV_READY_FILE) }], (exit) => sandbox.isDriverFailure(exit), signal);
  if (envPort !== store.port) throw new TrialFault('env', `the env's ready file names port ${envPort}: in the trial's pod it serves \`${ROLE_ALIASES.env}\` on ${store.port}`);
  const entryProc = pod.spawn('entry');
  watchMember('entry', entryProc);
  const services = house === null ? [envSvc, fwd.svc] : [envSvc, fwd.svc, house.svc];
  const missFiles = live ? [] : [{ lane: 'entry' as const, file: join(recordDir, MISS_FILE) }, ...(house === null ? [] : [{ lane: 'house' as const, file: join(houseRecordDir, MISS_FILE) }])];
  const { ending, sup } = await superviseEntry(opts, c, entryProc, services, missFiles, stateDir);
  const results = await stopServices(c, { envSvc, fwdSvc: fwd.svc, houseSvc: house?.svc ?? null, recordDir, houseRecordDir }, ending, '');

  // The lanes have exited (stopServices: each on its SIGTERM, else killed); then the address forgotten, then the pod
  // deleted, before anything else is made: the scorer's pod comes only after.
  await guard(forgetAdmitted(c.state, door), signal);
  await guard(pod.close(), signal);
  return await finishPass(opts, c, { lanes: l, ...results, hasHouse: house !== null, recordDir, houseRecordDir, stateDir, sup, ending });
}

/**
 * On one pod (the header's): whether `member`'s end (not the driver's failure, which runPodPass's watch reads first)
 * says the pod's sandbox is over or may be, so the address is forgotten at the door at once: the pod out of memory
 * (SandboxPod.oom: gVisor ends every member K8S_KILLED); the env ending before the pass told it to stop (stopServices);
 * the entry killed when the pass did not ask for it (neither its ending decided nor its Supervisor's stop) before its
 * program ran. A started entry's K8S_KILLED with the pod's memory intact is its program's own status (the driver ends
 * a running member K8S_KILLED only on a kill of the pass's or the pod's memory), an ordinary end: forgetting then would
 * cut the env's house turns in flight at the entrant's word.
 */
function podSandboxOver(state: PassState, pod: Pick<SandboxPod, 'oom'>, member: 'env' | 'entry', exit: SandboxExit): boolean {
  if (pod.oom) return true;
  if (member === 'env') return !state.envStopAsked;
  const killed = exit.code === K8S_KILLED && exit.signal === null && exit.error === undefined;
  const sup = state.sup;
  return killed && !state.entryStopAsked && (sup === null || (sup.stopped === null && sup.runningAt === null));
}

function entryRun(ending: Ending, sup: Supervisor): EntryRun {
  const wall_ms = Math.round(sup.elapsedMs());
  switch (ending.kind) {
    case 'exited':
      return { ended: 'exited', exit: ending.exit, wall_ms, detail: ending.exit.code === 0 && ending.exit.signal === null ? null : `the entry exited with ${describeExit(ending.exit)}` };
    case 'limit':
      return { ended: 'limit', exit: sup.exit, wall_ms, detail: `limit: ${ending.message}` };
    case 'timeout':
      return { ended: 'timeout', exit: sup.exit, wall_ms, detail: 'the wall budget ran out' };
    case 'miss':
      return { ended: 'stopped', exit: sup.exit, wall_ms, detail: `stopped at the replay's first ${ending.lane === 'house' ? 'house lane ' : ''}cassette miss` };
    case 'service':
      return { ended: 'stopped', exit: sup.exit, wall_ms, detail: `stopped: ${ending.svc.name} exited` };
  }
}

/**
 * SIGTERM a service and wait for it, its own end within SERVICE_STOP_MS (programExitWithin: on k8s its writable mounts'
 * collect and its pod's delete come after, on the driver's bounds); null (and killed) when it did not end.
 */
async function terminate(svc: TrialService, kind: Sandbox['kind'], c: PassContext, network: string): Promise<SandboxExit | null> {
  if (svc.exit !== null) return svc.exit;
  if (svc.terminable !== null) await guard(svc.terminable.terminate(), c.signal);
  else if (kind === 'process') svc.proc.stdin.end();
  else if (kind === 'k8s') await guard(k8sTerminate(svc.proc), c.signal);
  else await guard(dockerTerm(c.net.exec, network, svc.label), c.signal);
  const exit = await programExitWithin(svc.proc, svc.exited, SERVICE_STOP_MS, c.signal);
  if (exit === null) await guard(svc.proc.kill(), c.signal);
  return exit;
}

/**
 * `exited`'s exit, or null when the program itself did not end within `ms`: on a driver with work between the program's
 * end and its exit (SandboxProcess.finished: k8s, a split pod's program collecting its writable mounts back and deleting
 * its pod, a one-pod member's collecting its own from the pod's `watch`), `ms` bounds the program's end alone and the
 * exit then comes on the driver's own bounds (k8s-transfer.ts collectBudgetMs, a split pod's delete's), as io.ts's
 * Supervisor leaves it to the driver; with no `finished` (docker, the process driver, a hosted lane), `ms` bounds the
 * exit, as ever. An abort of `signal` rejects (PassAborted).
 */
export async function programExitWithin(proc: Pick<SandboxProcess, 'finished'>, exited: Promise<SandboxExit>, ms: number, signal: AbortSignal): Promise<SandboxExit | null> {
  const finished = proc.finished;
  if (finished === undefined) return within(exited, ms, signal);
  const ended = await within(
    Promise.race([finished, exited]).then(() => true),
    ms,
    signal,
  );
  return ended === null ? null : await guard(exited, signal);
}

async function writeLauncher(dir: string, target: string): Promise<{ codeDir: string; script: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, LAUNCHER_SCRIPT), launcherSource(target), { flag: 'wx', mode: 0o600 });
  // The script 0444 whatever the umask (program.ts sealStaged); its directory stays this process's alone.
  await sealStaged(join(dir, LAUNCHER_SCRIPT));
  return { codeDir: dir, script: LAUNCHER_SCRIPT };
}

interface GatewayResultDoc {
  ok: boolean;
  faults: string[];
  cassette_sha256: string | null;
  replay: ReplayVerdict | null;
  /** The request log the forwarder stored in its /record/blobs (requests.ts); null when it stored none, or wrote none (a forwarder before it). */
  requests_sha256: string | null;
  /** Why a request log it kept was not stored (redacted by the forwarder); never a fault of the pass's. */
  requests_fault: string | null;
}

/** result.json (main.ts resultDocument), or null when it is not one. */
export function gatewayResultOf(doc: unknown): GatewayResultDoc | null {
  if (doc === null || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  if (d.format !== GATEWAY_RESULT_FORMAT || typeof d.ok !== 'boolean' || !Array.isArray(d.faults)) return null;
  const cassette = typeof d.cassette_sha256 === 'string' && Sha256Hex.safeParse(d.cassette_sha256).success ? d.cassette_sha256 : null;
  const replay = d.replay !== null && typeof d.replay === 'object' ? (d.replay as ReplayVerdict) : null;
  // The request log's fields are read leniently: a document without them (or with one malformed) is a pass with no log, never a fault.
  const requests = typeof d.requests_sha256 === 'string' && Sha256Hex.safeParse(d.requests_sha256).success ? d.requests_sha256 : null;
  const requestsFault = typeof d.requests_fault === 'string' ? d.requests_fault : null;
  return { ok: d.ok, faults: d.faults.map(String), cassette_sha256: cassette, replay, requests_sha256: requests, requests_fault: requestsFault };
}

/** Put bytes and check the store named them `sha256`. */
async function putChecked(blobs: TrialBlobs, bytes: Uint8Array, sha256: string): Promise<void> {
  const put = await blobs.put(bytes);
  if (put.sha256 !== sha256) throw new Error(`the blob store named ${sha256}'s bytes ${put.sha256}`);
}

/** How many blobs a cassette's store (storeCassette) or stage (stageReplayBlobs) moves at once. */
export const BLOB_FANOUT = 8;

/**
 * `fn` over each item, at most `width` at once, started in order; once one fails no more start, and what is thrown,
 * once every one started has settled, is the earliest item's failure: the one a loop over them in order would have met.
 */
export async function eachBounded<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  const failed = new Map<number, unknown>();
  let next = 0;
  const lane = async (): Promise<void> => {
    while (failed.size === 0 && next < items.length) {
      const i = next++;
      try {
        await fn(items[i]!);
      } catch (err) {
        failed.set(i, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, () => lane()));
  if (failed.size > 0) throw failed.get(Math.min(...failed.keys()));
}

type SettledValue<P> = P extends Promise<infer V> ? V : null;

/**
 * Every promise settled (null stands for none and answers null), then their values in order, or the first rejection in
 * that order: what awaiting them one after the other would have thrown, with none of them left running.
 */
export async function settledInOrder<const T extends readonly (Promise<unknown> | null)[]>(ps: T): Promise<{ -readonly [K in keyof T]: SettledValue<T[K]> }> {
  const settled = await Promise.allSettled(ps.map((p) => p ?? Promise.resolve(null)));
  const out: unknown[] = [];
  for (const s of settled) {
    if (s.status === 'rejected') throw s.reason;
    out.push(s.value);
  }
  return out as { -readonly [K in keyof T]: SettledValue<T[K]> };
}

/**
 * LIVE: the cassette the forwarder left in /record/blobs, and every body it lists, into the blob store: the bodies
 * BLOB_FANOUT at a time, the cassette once all are in, so a stored cassette's bodies are always there.
 */
async function storeCassette(recordBlobs: string, sha256: string, blobs: TrialBlobs): Promise<CassetteT> {
  const rec = new BlobStore(recordBlobs);
  const cassette = await readCassette(rec, sha256);
  const bodies = [...new Set(cassette.entries.map((e) => e.body_sha256))];
  await eachBounded(bodies, BLOB_FANOUT, async (b) => {
    const bytes = await rec.get(b, { verify: true });
    if (bytes === null) throw new CassetteError(`the forwarder recorded no body ${b}`);
    await putChecked(blobs, bytes, b);
  });
  await putChecked(blobs, (await rec.get(sha256, { verify: true }))!, sha256);
  return cassette;
}

/**
 * LIVE: a lane's request log (gateway/requests.ts) from its forwarder's /record/blobs into the blob store, its name
 * checked (TrialPass.requests_sha256): streamed from the file where the store takes one (TrialBlobs.putFile), else read
 * whole (at most REQUEST_LOG_MAX_BYTES). The sha256 stored, or null when the forwarder named none or it is not stored:
 * each such failure a line on opts.log (redacted of `forms`), never a fault and never a throw. Nothing reads the log
 * for the pass: its cassette, scores and replay are the same with it or without it.
 */
export async function storeRequestLog(
  opts: Pick<RunTrialOptions, 'blobs' | 'trial' | 'log'>,
  lane: Lane,
  recordBlobs: string,
  doc: Pick<GatewayResultDoc, 'requests_sha256' | 'requests_fault'> | null,
  forms: FormSet | null = null,
): Promise<string | null> {
  const say = (line: string): void => {
    try {
      (opts.log ?? ((l: string) => console.warn(l)))(forms === null ? line : redactForms(line, forms));
    } catch {
      // A log that throws loses its line, nothing more.
    }
  };
  const what = `trial ${opts.trial.index} (instance ${opts.trial.instance_sha256.slice(0, 12)}): the ${lane} lane's request log`;
  if (doc === null) return null;
  const sha256 = doc.requests_sha256;
  if (sha256 === null) {
    if (doc.requests_fault !== null) say(`[grade] ${what} was not kept by its forwarder, stored as none: ${doc.requests_fault}`);
    return null;
  }
  try {
    const rec = new BlobStore(recordBlobs);
    const plain = rec.pathOf(sha256);
    const st = opts.blobs.putFile === undefined ? null : await stat(plain).catch(() => null);
    let stored: string;
    if (st !== null && st.isFile() && st.size > 0) stored = (await opts.blobs.putFile!(plain)).sha256;
    else {
      const bytes = await rec.get(sha256, { verify: true });
      if (bytes === null) throw new Error(`the forwarder recorded no blob ${sha256}`);
      stored = (await opts.blobs.put(bytes)).sha256;
    }
    if (stored !== sha256) throw new Error(`the blob store named its bytes ${stored}, not ${sha256}`);
    return sha256;
  } catch (err) {
    say(`[grade] ${what} ${sha256} was not stored, stored as none: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return null;
  }
}

/**
 * REPLAY: the cassette and every body it lists, from the blob store into the forwarder's /config/blobs (readable by
 * path only for others), BLOB_FANOUT at a time.
 */
async function stageReplayBlobs(blobs: TrialBlobs, sha256: string, dir: string): Promise<void> {
  const cassette = await readCassette(blobs, sha256);
  const store = new BlobStore(dir);
  await eachBounded([...new Set([...cassette.entries.map((e) => e.body_sha256), sha256])], BLOB_FANOUT, async (b) => {
    const bytes = await blobs.get(b, { verify: true });
    if (bytes === null) throw new CassetteError(`the blob store holds no ${b === sha256 ? 'cassette' : 'response body'} ${b}`);
    const put = await store.put(bytes);
    if (put.sha256 !== b) throw new CassetteError(`blob ${b} hashes to ${put.sha256}`);
  });
  await rm(join(dir, 'tmp'), { recursive: true, force: true });
  const walk = async (d: string): Promise<void> => {
    await chmod(d, GATEWAY_CONFIG_DIR_MODE);
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else await chmod(join(d, e.name), 0o444);
    }
  };
  await walk(dir);
}

async function putFile(blobs: TrialBlobs, file: string): Promise<string> {
  if (blobs.putFile !== undefined) return (await blobs.putFile(file)).sha256;
  return (await blobs.put(await readFile(file))).sha256;
}

/** The env's export (/state/export/), each regular file stored, as program outputs; or why it is not one. */
async function storeExport(dir: string, blobs: TrialBlobs): Promise<{ outputs: TrialOutputsT; state_sha256: string } | { fault: string }> {
  if (!(await stat(dir).catch(() => null))?.isDirectory()) return { fault: `the env exported nothing (no ${ENV_EXPORT_DIR}/)` };
  const files: TrialOutputsT['files'] = [];
  let bytes = 0;
  let count = 0;
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (!SEGMENT_RE.test(e.name)) return { fault: `the env exported ${JSON.stringify(path)}, not a plain name` };
      if (++count > MAX_OUTPUT_FILES) return { fault: `the env exported more than ${MAX_OUTPUT_FILES} files and directories` };
      const st = await lstat(join(dir, path));
      if (st.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!st.isFile()) return { fault: `the env exported ${JSON.stringify(path)}, not a regular file` };
      bytes += st.size;
      if (bytes > MAX_OUTPUT_BYTES) return { fault: `the env's export passed ${MAX_OUTPUT_BYTES} bytes` };
      const data = await readFile(join(dir, path));
      const put = await blobs.put(data);
      if (put.sha256 !== sha256Hex(data)) throw new Error(`the blob store named ${path}'s bytes ${put.sha256}`);
      files.push({ path, size: data.length, sha256: put.sha256 });
    }
  }
  files.sort((a, b) => comparePaths(a.path, b.path));
  const state = files.find((f) => f.path === STATE_FILE);
  if (state === undefined) return { fault: `the env exported no ${STATE_FILE}` };
  return { outputs: TrialOutputs.parse({ format: TRIAL_OUTPUTS_FORMAT, files }), state_sha256: state.sha256 };
}

/** retireTrialKey, retried MASQ_RETIRE_RETRIES times on a broker fault with doubling backoff; the last fault when every try failed. */
async function retireWithRetries(m: MasqTrialUpstream, id: string, meter: bigint, signal: AbortSignal): Promise<{ retired: RetiredTrialKey } | { error: MasqBrokerError }> {
  let delay = m.retireBackoffMs ?? MASQ_RETIRE_BACKOFF_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return { retired: await guard(retireTrialKey(m.broker, id, meter, { signal }), signal) };
    } catch (err) {
      if (!(err instanceof MasqBrokerError) || signal.aborted) throw err;
      if (attempt >= MASQ_RETIRE_RETRIES) return { error: err };
      await sleep(delay, signal);
      delay *= 2;
    }
  }
}
