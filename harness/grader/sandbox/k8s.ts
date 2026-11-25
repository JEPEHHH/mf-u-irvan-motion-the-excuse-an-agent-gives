// The Kubernetes sandbox (MAKEFUN_SANDBOX=k8s): docker.ts's twin on a cluster. Every program is a
// one-shot pod in the sandbox namespace (K8sSandboxOptions.namespace: the site's <site>-sbx, else the worker's own;
// the worker's own, ownNamespace, holds its creators), under the gVisor RuntimeClass, driven through the API server with the
// worker's own service-account token (in-cluster: no kubeconfig; a burst grader's kubeconfig token) and the Role in
// deploy/k8s/sandbox/rbac.yaml (makefun-grader, in the sandbox namespace; its own namespace's is
// deploy/k8s/base/rbac.yaml's makefun-worker-app), every call asked in-process (k8s-count.ts: apiExec, the pod watch, the creates and the
// patch), a kubectl spawned only where the in-process client cannot ask one (and outside a pod: the e2e rig, the tests),
// and through the pod's own house agent (`makefun-agent`, agent/v1: agent-wire.ts's header is the wire, agent-client.ts
// the grader's side), which the grader dials at <pod IP>:9011 directly over the pod network, never through the API
// server. A program is these calls, then one delete:
//
//   POST /api/v1/namespaces/<ns>/secrets?fieldValidation=Ignore, then (a forwarder's gateway policy) POST
//   /apis/networking.k8s.io/v1/namespaces/<ns>/networkpolicies, then POST /api/v1/namespaces/<ns>/pods
//                                                      its Secret <pod>-env, the forwarder's gateway policy when it
//                                                      has one, the pod (sandboxPodSpec), in that order (Secret first,
//                                                      below), each asked in-process over this pod's own token
//                                                      (createPodObjects; a burst grader's over its kubeconfig), or
//                                                      outside a pod ONE `kubectl -n <ns> create -f - --validate=false
//                                                      -o <CREATED_JSONPATH>` List of the three
//   PATCH /api/v1/namespaces/<ns>/secrets/<pod>-env <ownerPatch>   the pod as the Secret's owner, a merge patch off
//                                                      the critical path (patchSecretOwner; a burst grader's over its
//                                                      kubeconfig; `kubectl patch` elsewhere outside a pod)
//   GET /api/v1/namespaces/<ns>/pods?fieldSelector=metadata.name=<pod>&watch=true   its IP (Fast boot, below:
//                                                      k8s-count.ts watchPod; `kubectl wait` outside a pod)
//   agent `stage` at <pod IP>:9011: GET /v1/health, then  /bin/sh -c <STAGE_EXEC_SCRIPT> sh 1 perl -e <unpacker> -- <mounts...>
//                                                      the staging exec (Staging, below)
//   that watch again, until the pod is Ready           `stage` exited 0, `main` and `watch` running (awaitPod:
//                                                      awaitByWatch; `kubectl wait --for=condition=Ready` outside a pod)
//   agent `watch` at <pod IP>:9011: its session, kept for the pod's life (Agent sessions, below); GET /v1/health until
//                                                      it lists `main`'s shim (the shim gate, below)
//   agent `watch`, in main: <POLICY_WAIT_ARGV> ...      an entry's policy wait (below)
//   agent `watch`: perl -e <WATCH_SCRIPT> ...          the watch (below) of a pod with a meter or live files, beside
//                                                      the next one
//   agent `watch`, in main: /bin/sh -c <EXEC_WRAPPER> sh <pids> <argv...>
//                                                      the program's exec (a timed pod's TIMED_EXEC_WRAPPER: Timing,
//                                                      below); its signals and kills the same way, in main
//   agent `watch`: perl -e <packer> -- <mount caps...> the collect of a pod with a writable mount, once the
//                                                      program's exec has ended (Staging, below)
//   DELETE /api/v1/namespaces/<ns>/pods/<pod>, then secrets/<pod>-env [and networkpolicies/<pod>-llm]
//                                                      gracePeriodSeconds 1, NotFound fine (deleteObjects' `kubectl delete
//                                                      … KUBECTL_DELETE_FLAGS` argv, k8s-count.ts apiExec's DELETEs in a
//                                                      pod: graceful, never forced)
//
// Release 2 of the agent (the plan "Take kubectl exec out of grading"): the agent is PID 1 of `stage` and of `watch`,
// and the shim (the same binary, installed by `stage`) PID 1 of `main` and of each plan member. `watch`'s session
// carries every exec of a program's pod: the staging (over `stage`'s), the collect, the watch and the watch probe in
// `watch` itself, and every exec into `main` or a member (the policy wait, the program, its signals and kills, a
// one-pod member's door dial and bind proof), which `watch` relays to that container's shim over its link
// (agent-client.ts AgentSession.stream with the container named: agentMember). No exec of a pod the driver makes goes
// through the API server: what is left of the API server is the create, patch, watch, get, list and delete, each asked
// in-process in a pod. A case session's pod is a shim pod
// too, its `main`'s shim the session reaper (k8s-session.ts SESSION_PID1_COMMAND), and its runs, launcher check and
// resets go over its `watch` session the same way, as the lanes pod's (k8s-lanes.ts) do: no pod is exec'd by kubectl.
//
// Secret first. Every program pod, a race's and a plan's among them, has its Secret `<pod>-env` (sandboxEnvSecret,
// podPlanSecret), and it is made BEFORE the pod, the first object of the pod's create, so the kubelet never meets a
// missing Secret (no CreateContainerConfigError, no config-error back-off of about 10 s). It holds the pod's agent key
// K, MAKEFUN_AGENT_KEY (32 random bytes from this process, newAgentKey), which only `stage` and `watch` read, and the
// spec's *_API_KEY env values (a plan's members' secrets too), which `main` (a plan's members) reads; all by
// secretKeyRef, so no value sits in the pod spec. A program pod's own secrets (a spec's `secrets`, an entrant's
// env-lane values) are in neither: they are its program's exec's (Exec env, below), so a program pod's spec and Secret
// hold nothing of its run but its name and K (Pool-ready, below). The create (createPodObjects) is the API server's
// POST of the Secret, then of each object after it, asked in-process over this pod's own token (k8s-count.ts
// inClusterApiCreate; a burst grader's over its kubeconfig), the first refused or cut ending it, so no pod is asked for
// once its Secret was not made; outside a pod (the e2e rig's admin kubeconfig, the tests) ONE `kubectl create -f -` List
// of them, its values on kubectl's stdin alone (and, should a first POST not be asked, kubectl's after what it may have
// made is deleted by name). Either's failure is one wording, `could not create pod <name>: …` (CREATE_FAILED_WORDS),
// said with every value taken out (withoutValues), as kubectl prints a refusal (createRefusal: `Error from server
// (<reason>): …`, so a quota's no-room words and an APF shed read the same). Each object made is read with its uid (the object answered, or the List's
// CREATED_JSONPATH), the pod's among them, and the pod is then made the Secret's owner by a merge patch (patchSecretOwner, the Role's
// `patch` on secrets), off the critical path: nothing of the boot waits on it, a failed patch is tried once more after
// SECRET_PATCH_RETRY_MS and then warned of. In a pod the patch is the API server's PATCH asked in-process over this
// pod's token (k8s-count.ts inClusterApiPatch), never `kubectl patch`: kubectl GETs the object before it patches, and
// the Role may not get a Secret, so its patch failed on every pod (makefun-prod 2026-11-16: 2,501 `cannot get resource
// "secrets"` in 55 min on one grader, two spawns and a retry each). A burst grader asks the same PATCH over its
// KUBECONFIG's token (k8s-count.ts kubeconfigApiTarget), the burst kit's Role being create, delete and patch too; the
// e2e rig (an admin kubeconfig of client certificates) keeps kubectl's patch and create. Kubernetes' garbage collector deletes an owned Secret with its pod. The Role
// may create, patch and delete Secrets but not list them (a list returns their data), so what keeps one from leaking is
// its name: the pod's delete removes `<pod>-env` by name (deleteObjects), and so does reapOrphans' for a dead creator's
// pod, k8s-network.ts's reap and stale sweep for each sandbox pod they delete, and K8sOnePodTrialNetworks' reap for
// each plan pod; a create that fails once its
// Secret is made (or is cut before it says, or ends unknown) deletes that Secret before the failure is said. So a Secret outlives its pod
// only when it was never given its owner (its creator died between the create and the patch, or both patches failed)
// and the pod then goes by what does not name the Secret: k8s-network.ts's remove (its own process's pods, by label), a
// node's loss, or a creator that died between a failed create and that Secret's delete. Nothing lists Secrets to find
// one, as the Role may not.
//
// `main`'s own command is the shim (shimCommand: a served pod's with the policy port, below; a case session's pod's with
// `--session-reaper`, k8s-session.ts SESSION_PID1_COMMAND): the program arrives
// by exec into a pod already Ready, never as the pod's command, so it never runs before the namespace's
// default-deny policy holds (deploy/k8s/README.md, measured on k3s+gVisor: a fresh pod's first connect got
// out in 2 of 9 starts before Ready, none of 2623 after it) and nothing races an attach (containerd#14476).
// Never `kubectl run` (its --rm prints `pod "x" deleted` on stdout) and never `attach`. kubectl's stderr is
// never read as a failure: the API server's Pod Security warnings land there for the root launcher and timed
// pods; exit codes and the sentinel below are the only verdicts.
//
// The pod (sandboxPodSpec) is dockerRunArgs in pod form:
//
//   name makefun-sbx-<label>-<8 hex> (at most 62 characters: a pod name is also its hostname)
//   labels makefun.grader=1, makefun.io/role=sandbox (the namespace's default-deny selects it),
//     makefun.io/sandbox=program|preflight|isolation|race|desk (desk: a house image's pod, below), and when networked
//     makefun.net=<trial>, makefun.trial=<ownerLabel(owner)> (PodNames), makefun.egress=1 (the egress policy
//     selects it); makefun.pod=<name> only on a pod a policy of its own selects (SandboxPodOptions.ownPolicy: a
//     forwarder's <pod>-llm, below), since Cilium mints a security identity per distinct label set and a label unique
//     to each pod would mint one per pod (Pod identities, below); with an owner, the annotation
//     makefun.io/trial-owner=<owner> (OWNER_ANNOTATION); made by a process that names its own pod
//     (K8sSandboxOptions.creator, POD_NAME), the annotation makefun.io/creator=<that pod>
//     (CREATOR_ANNOTATION: Reaping, below)
//   runtimeClassName <runtime class>, nodeSelector, serviceAccountName <sandbox account> with
//     automountServiceAccountToken false, enableServiceLinks false, restartPolicy Never,
//     activeDeadlineSeconds STALE_AFTER_MS (the backstop for a pod no delete reached; a race pod's its lifetime, below),
//     terminationGracePeriodSeconds 0
//   dnsPolicy None, nameserver 127.0.0.1, ndots 0: no DNS at all (`--network none`'s twin); an egress pod
//     ClusterFirst with ndots 0 (Docker's embedded resolver sets it too); a networked pod's peers by
//     hostAliases (PodNames: every other registered name of its network, Docker's aliases; a pod registers
//     once Ready, so the harnesses' order, services before their entry, gives the entry all of them)
//   runAsUser/Group 65534, runAsNonRoot, seccomp RuntimeDefault; a launcher's or a timed pod's 0:0 with SETUID
//     SETGID KILL (Timing, below)
//   imagePullSecrets IMAGE_PULL_SECRET (makefun-registry, the app pods' own: the agent image is a GHCR package of this
//     private repository); every container's imagePullPolicy IMAGE_PULL_POLICY, IfNotPresent: a node pulls an image it
//     lacks, by its pinned digest, once (no pre-pull: a node's first pull of an image is that pod's init time, Fast boot)
//   one container `main`: <image>@<digest>, the shim as its PID 1 (shimCommand: `SHIM_BIN shim --container main`, the
//     agent's own binary from agent-bin, below; one task that holds the pod, reaps, takes `watch`'s execs into `main`
//     over its link and exits 0 on the delete's SIGTERM, so a finished pod ends Completed; a served pod's with
//     `--policy-port POLICY_PORT`, in POLICY_LISTENER_COMMAND's place; release 1's HOLD_COMMAND and the perl listener
//     before it, which SandboxPodOptions.shim false still builds, for no pod the driver makes), env SANDBOX_ENV then the
//     spec's env (any *_API_KEY from the Secret <pod>-env by secretKeyRef, so no key sits in the pod spec), never one of the spec's secrets (types.ts checkSandboxSecrets: the
//     program's exec carries them, Exec env below, so no value sits in the pod spec, its Secret, a kubectl argv or a
//     message), and each of
//     its mounts' stand-ins after the mounts (types.ts containerMountEnv: MAKEFUN_OUTPUT_DIR=/output, less /state's and
//     /record's, so a program reads the mount where the process driver reads its host directory),
//     limits cpu <cpus>, memory <memory_mb>Mi; requests memory = limit, cpu min(limit, 250m) (a timed pod's, and a spec's with
//     reserveCpu, the limit; a split-layout trial agent's min(limit, TRIAL_AGENT_CPU_REQUEST_MILLI 850m) and an agent
//     trial's forwarder's min(limit, FORWARDER_CPU_REQUEST_MILLI 50m), near what each uses: programCpuRequestMilli);
//     allowPrivilegeEscalation false, readOnlyRootFilesystem, capabilities drop ALL
//   volumes: a disk emptyDir per mount point (diskVolume, named for it by mountVolumeName): /bot (the code dir), /house
//     (a launcher's), the spec's mounts at their MOUNT_POINTS (mounts.ts checkSandboxMounts, every driver's check); a
//     writable mount's with a sizeLimit (mountSizeLimit, the plan's D14: twice its return cap, at least
//     MOUNT_SIZE_MIN_MI), an input's with none; and /tmp, an emptyDir of medium Memory, 256Mi, as before: a host tmpfs
//     the kubelet mounts (mode 1777, root's), bind-mounted into the sandbox, not one of gVisor's own; ENOSPC at its size.
//     No claim: nothing of the grader's disk is mounted, every tree is staged in (Staging, below). Every host path a
//     spec names (/bot's code dir, a launcher's house, each mount's host: what is staged from, and what a writable
//     mount's collect empties and writes into) must lie under the data root as it did on the claim (checkUnderDataRoot), or the
//     spec is a SandboxError naming it, thrown where the spawn first builds the pod, before anything is made. A disk
//     emptyDir is a directory of the node's disk under the kubelet's, served to gVisor by its gofer; not the pod's
//     memory. Its root is the kubelet's, 0:0 and mode 0777, which is what a mount point's own stat shows (the plan's D22)
//     and agent-bin (AGENT_BIN_VOLUME), a disk emptyDir of AGENT_BIN_SIZE that `stage` fills with the shim's binary
//   `main` mounts /bot and /house read-only, each of the spec's mounts read-only or not as it says, /tmp, and agent-bin
//     read-only at AGENT_BIN_DIR (the shim's binary, never writable from `main`)
//   an init container `stage` (STAGE_CONTAINER, stageContainer: an init container by the owner's ruling on the plan's
//     D21), before `main` and `watch` exist: the agent image (images.ts agentImage: sandbox-agent/Dockerfile, debian
//     slim with perl-base and AGENT_BIN), `makefun-agent stage --arrival STAGE_ARRIVAL_S --install AGENT_BIN_INSTALL_DIR`
//     as its PID 1 (it copies its own binary into agent-bin before it serves: the shim `main` runs), env agentEnv
//     alone (MAKEFUN_AGENT_KEY by secretKeyRef from `<pod>-env`, MAKEFUN_AGENT_PEERS the agents' peers), `main`'s
//     resources (an init container's add nothing to the pod's), uid and gid STAGE_UID set on the container (the plan's
//     D2: a staged file is the grader's 10001's, as on the claim; in a root pod too), runAsNonRoot, every capability
//     dropped, no privilege escalation, a read-only root; every mount point's emptyDir read-write at that point, and
//     agent-bin read-write at AGENT_BIN_INSTALL_DIR, nothing else (no /tmp)
//   a second container `watch` after `main` (WATCH_CONTAINER, the plan's D9b), in every pod (release 2: `main`'s shim
//     links to it; release 1 had it only with a writable mount): the agent image, `makefun-agent serve` as its PID 1
//     (it reaps every child), env agentEnv and MAKEFUN_AGENT_CONTAINERS=main (the shim links it takes), uid and gid
//     WATCH_UID set on the container itself (in a launcher's or a timed pod too, whose `main` is root), runAsNonRoot,
//     every capability dropped, no privilege escalation, a read-only root; each of the pod's writable mounts read-only at
//     its mount point and nothing else (no /bot, no /tmp; none at all without a writable mount); requests cpu
//     WATCH_CPU_REQUEST_MILLI, limits cpu WATCH_CPU_LIMIT_MILLI, memory WATCH_MEMORY_MI plus SHIM_MEMORY_MI for the shim
//     (shimWatchMemory: 39Mi), limit and request (the agent's serve mode fits WATCH_MEMORY: one static binary, one thread,
//     and the watcher's perl as before; the shim's 7Mi is `main`'s PID 1's, #747's spike measured 4.0-6.6 MiB, put here
//     since gVisor enforces only the pod's total, so the program keeps its memory_mb whole). Measured on makefun-dev
//     (the claim-less evaluation's second run): `watch` reads `main`'s mode-644
//     file in /output, cannot write the mount (Read-only file system), and is refused a mode-600 file, a mode-700
//     directory and what is in it; `main` and `watch` each have a PID 1 of their own and see only their own processes,
//     so `kill -KILL -1` in `main` never reaches the watcher. gVisor gives the pod one memory pool and one CPU quota: in
//     a pod with `main` at 256Mi and `watch` at 32Mi both containers read MemTotal 294912 kB (288 MiB), the pod's pooled
//     limit, so a program can use what of `watch`'s 32Mi the watcher leaves free, and up to its 50m of CPU while it
//     idles.
//
// A race's racer (a spec's `race`, grader/race.ts runRacer: one program for a whole race window, types.ts's header)
// differs in four places, everything else kept: labels makefun.io/role=sandbox and
// makefun.io/sandbox=race only, no makefun.grader=1, so no sweep or reap that lists the grader's objects by it
// (k8s-network.ts sweepStale's STALE_AFTER_MS, `makefun-k8s.sh reap`) ever takes it; activeDeadlineSeconds its
// lifetime (race.lifetimeMs, rounded up to whole seconds) in place of STALE_AFTER_MS, so the kubelet ends it there
// whatever became of its racer; requests cpu min(limit, RACE_CPU_REQUEST_MILLI) (it idles between bars), memory the
// limit as ever. It has no network, mount, env or secret (types.ts checkSandboxRace), and is never a timed pod; its
// Secret holds its agents' key alone (Secret first, above), since its `stage` is an agent's as every program pod's.
// Its node is the app node's by preference, outside that node's sandbox cap (Room on the node, below).
//
// A house image's program (a spec's `image` whose `<repository>@<digest>` is one of the sandbox's houseImages,
// K8sSandboxOptions.houseImages: the validated work desk's validator images, server/desk) differs in three places,
// everything else kept: `main` runs that image by its digest in place of the runtime's, the program's exec runs the
// image's argv under the same EXEC_WRAPPER in place of the interpreter and the script (sandboxProgramArgv), and the pod
// is labelled makefun.io/sandbox=desk (DESK_POD_KIND, a value of the existing key: the admission policy pins the
// label keys, never this one's values). Held to it as every program pod is: no network, launcher, race or imageDigest
// (types.ts checkSandboxImage), no /work tmpfs, never timed, never a warm pool's, a read-only root as the sandbox
// user, /tmp 256Mi of memory, an env of MAKEFUN_* names alone besides SANDBOX_ENV and no secrets (checkHouseImageSpec),
// its only writable space a writable mount's disk emptyDir of twice its return cap. A sandbox made with no houseImages
// (every grading sandbox) refuses every image spec, and one made with them every image not among them, with the
// SandboxError of code `repo_image_unsupported` as before: a bundle cannot name an image this driver runs.
// preflightImage proves a house image pulls and runs on the node within readyTimeoutMs (a multi-GB first pull).
//
// Docker's --pids-limit has no pod twin (the kubelet's pids cgroup is per node, not per pod), so the wrapper
// sets `ulimit -u` to the program's pids plus the pod's own two tasks (PID 1 and the wrapper): measured to
// hold under gVisor, whose kernel is the pod's alone. Under no RuntimeClass (runc) a uid's process count is
// the node's, shared by every sandbox pod, so there is no cap there (pids 0). `watch`'s tasks (its PID 1, the
// watcher and its meter children) are WATCH_UID's, and gVisor counts each user's tasks apart (Timing, below), so they
// take nothing from the cap.
//
// The exec (EXEC_WRAPPER, dash as the images' /bin/sh) reads a 128-bit nonce from the first line of its
// stdin, so the program can read it from no argv, environment or file; unsets the eight KUBERNETES_*
// variables the kubelet sets in every container even with enableServiceLinks false, so the program's
// environment is docker's (the image's own, SANDBOX_ENV, the spec's); caps processes; traps TERM (so
// terminate()'s `kill -TERM -1` reaches the program and not the wrapper); prints the start line
// `RS<nonce>\n` (RS the byte 036) as the first bytes of its stdout; runs the program in a subshell with the
// real stderr (the wrapper's own, dash's "Killed" included, goes to /dev/null); then kills everything else
// in its container but its PID 1 (the shim), as a container's end kills what its program left, and prints
// `RS<nonce><status>\n`. The
// status is the program's (128+n for a signal, as docker reports it). stdout is passed on through
// SentinelScanner, which strips the start line and the sentinel (even with no newline before it) and holds
// back only output that ends in what could start the sentinel (RS and the nonce's first digits), so a
// service's `ready` line is never held; stdin is piped to the exec at once, after the nonce's line (the wrapper reads
// nothing past it before the program runs). The start line is the process's `started`: the program's wall budget
// (Supervisor) runs from it, not from the pod's create, its Ready or the exec's own start, none of which is the
// program's time; an exec that has not printed it EXEC_START_TIMEOUT_MS after it was made is killed, the driver's
// failure. The exec is ONE stream over the pod's `watch` agent session (MemberExec, agentMember), sent once and never
// again, whatever its end (agent-client.ts's no re-send: a stream that did not end with its trailer may have run its
// program); it holds no slot of the pace and meets nothing of the control plane, a case session's run's as every
// other's (its session pod's `watch` session, SessionPrepared.watch). Release 1's kubectl exec ran it in tries (a hung backend dial killed and run again within the same budget); nothing here does
// any more.
// The once-guard stays in every wrapper (EXEC_WRAPPER, TIMED_EXEC_WRAPPER and SESSION_EXEC_WRAPPER byte for byte as
// before): the exec id, the first EXEC_ID_HEX digits of its nonce, and each wrapper, before anything else, claims it in
// its container (EXEC_CLAIM_LINES: `mkdir EXEC_CLAIM_DIR/<id>`, atomic): the exec that makes it runs the program, one
// that finds it made prints `RS<nonce>claimed\n` and exits EXEC_CLAIMED_STATUS having run nothing, which is the
// driver's failure in those words (claimedWords), never sent again. With one exec an id there is no second try to meet
// the claim; it is a guard that costs a mkdir. The claim lives in the container's /tmp for its life (only a session's
// reset, between two cases, wipes it as 65534's): a timed pod's wrapper is root and its claims sit in a directory of
// root's, mode 0700, which the program (65534) can neither list nor change; elsewhere the wrapper is the program's own
// uid. The exec id names only half the nonce: the other 64 bits, never written anywhere in the pod, are what the
// program would have to guess to forge a wrapper line. The sentinel is the process's `finished` (types.ts
// SandboxProcess.finished, the plan's D6): the program's wall time ends there, before its watch is stopped and its
// mounts collected; an exec that ends without one is `finished` as it ends.
//
// Exec env. A program pod's own secrets (its spec's `secrets`: an entrant's env-lane values, types.ts
// checkSandboxSecrets) are its program's exec's, never its pod's: the nonce's line on stdin carries them after the
// nonce, ` NAME=<word>` each (execEnvWords: the value's UTF-8 bytes, printable ASCII but the space and the backslash
// as themselves, every other byte printf %b's `\0ooo`, so a multi-line value is one word and comes back whole), and every
// wrapper (EXEC_WRAPPER, TIMED_EXEC_WRAPPER, SESSION_EXEC_WRAPPER) splits the line at the nonce's 32 digits
// (EXEC_NONCE_LINES) and, once KUBERNETES_* is unset and before its process cap, exports each (EXEC_ENV_LINES:
// `export "NAME=value"`, the value decoded by printf, nothing evaluated), so the program, and the CPU or case launcher
// before it, gets them as its environment as `main`'s secretKeyRef env gave them before. They touch only the
// wrapper's n, s and c, the names no secret can take (contracts/entry-secrets.ts RESERVED_SANDBOX_NAMES). An exec with
// none writes the nonce alone, as every other exec of the driver's does (a session's launcher check, a plan member's).
// Like the nonce they reach the exec on its stdin alone (the agent's stream): no argv,
// pod spec, Secret or message holds one. A plan pod's members keep their secrets in the pod's Secret (podPlanSecret).
//
// Pool-ready. So a program pod of the grade family (grade-dev, grade-final and its -cases- pods, scorer, trial-scorer,
// defender-unpack: no network) is the same pod for every run of one shape, the name and K aside: what sandboxPodSpec puts
// in it is the shape's alone (the runtime image and digest, the limits, the mount points and their sizeLimits, /bot,
// the labels, the RuntimeClass and selector, the agent image and its peers, the creator) or derived from its name
// (`<pod>-env` in the agents' secretKeyRef, the Secret's name and its POD_LABEL); its env is SANDBOX_ENV, the spec's
// env (MAKEFUN_BOT_DIR=/bot alone for an entry: grader/program.ts entryEnv) and its mounts' stand-ins; its Secret holds
// K alone; hostAliases, the owner's annotation and the trial's labels come only with a network. The drawn placement
// (`prefer`, Room on the node) is the create's, not the run's: drawn from the pod's own name and the nodes' room read
// as it is made. tests/unit/sandbox-k8s-pool-spec.test.ts pins it: two spawns of one shape give byte-identical pod and
// Secret objects, the name and K aside.
//
// Warm pool (k8s-pool.ts, whose header has the pool itself; K8sSandboxOptions.warmPool, a grader's alone:
// MAKEFUN_K8S_WARM_POOL_MAX). A spawn whose pod is pool-ready (untimed, no network, no race, no launcher, no reserved
// CPU, no trial agent's, its Secret K alone: #poolShapeOf) asks the sandbox's warm pool first for a pod of its shape
// (shapeKeyOf: the pod and Secret as made, the name and K aside), before anything is made (K8sProcess #start,
// Launch.warm); a case session's boot asks it the same for its session pod's shape (k8s-session.ts K8sSession #boot,
// its first run's prepare the warm clock's start). A pool pod is that shape's pod made as a cold one is, under a fresh
// name of the latest spawn's label, its own drawn placement, POOL_ANNOTATION naming the shape and the creator's
// annotation, booted by the first half of the
// boot (bootToAgent: the create under the pace, the IP, the `stage` agent's first authenticated answer, its pin on
// HKDF(K)) and held there. On a hit the process takes the pod whole (its name, refs, IP, K and `stage` session, the agent
// asked once more at the claim, re-dialled with its pin checked again when the kept session is gone) and goes on with
// the boot's second half on it (bootTakenPod, bootFromAgent: the staging over that session, Ready within
// ctx.readyTimeoutMs of the claim, `watch` dialled, the shim gate), then everything as a pod made for it: its exec,
// collect, failures and delete. A miss boots cold, unchanged. A pool pod is one spawn's, then deleted: never reused, never handed back,
// never adopted by another process (a restart sweeps its own: k8s-pool.ts). Every pool pod stands on a place of its
// process's pod budget taken early for the grade jobs in hand (k8s-pool.ts's places; server/pod-pool.ts's warm places):
// counted there, and its Pending pods in sandboxPodsHeld, and a grade job waiting only for those places takes a booted
// one's as its own. The init clock (agent-client.ts recordInit)
// says which: `cold` its four phases from the create call as before, `warm` its agent phase from the spawn call (the
// claim), and either's `started` from the spawn call to the program's start line, which on a hit still holds the
// staging, the `main`/`watch` start to Ready and the exec's start (release 1's shape: the record's §4, 0.5-1.6 s and
// 0.8-3.0 s p50 on makefun-prod), so a hit's `started` is never its `agent`. A pool boot is clocked by its pool alone
// (its refill times), never as a spawn's init.
//
// Fast boot (bootAgentPod; the plan's init target: about 1 s from the create to the agent's first authenticated answer,
// p50 1.0 s, p95 1.5 s). Nothing on the path waits on a retry or a back-off: the Secret exists before the pod (above);
// both are made in process over this pod's own token (createPodObjects: two POSTs on a kept-alive connection, a few ms of
// the loop, where `kubectl create` started a Go binary, read its config and discovery and took 0.27-0.68 s mean of
// `created` on makefun-prod 2026-11-17);
// the pod's IP comes from the API server's watch of the pod in process (k8s-count.ts watchPod: one `watch=true` by
// fieldSelector metadata.name over this pod's own token, no kubectl spawned; outside a pod, `kubectl wait` for its IP in
// slices), each event read for awaitPod's verdicts too (a container waiting for a NEVER_READY reason, a container or
// `stage` ended, the pod finished or gone: the boot fails at once; the scheduler's no-room words kept for a budget that
// runs out); and the `stage` agent is dialled at once (agent-client.ts: each attempt bounded by DIAL_ATTEMPT_MS, a SYN
// Cilium drops while it readies the endpoint costs a re-dial, never the kernel's 1 s), in STAGE_DIAL_SLICE_MS slices
// with the pod read once between two for the same verdicts. Its first authenticated answer (GET /v1/health) is the init
// clock's end. Each phase (created: the create answered; scheduled: the pod bound; ip: its IP seen; agent: that answer),
// timed from the create call, is recordInit's (makefun_k8s_sandbox_init_seconds{phase,source="cold"}), and a pod whose init passed
// INIT_WARN_MS is a warning line naming it and its phases, at most one line each INIT_WARN_EVERY_MS a sandbox
// (InitWarnings): the slow inits after it in that minute are counted and said as one line, how many and the slowest.
// Most inits pass INIT_WARN_MS today (makefun-prod 2026-11-16: 2,502 lines in 55 min on one grader, p50 7.0 s), so a
// line a pod flooded the log; the histogram keeps every one. A node's first pull of an image (IfNotPresent, no pre-pull)
// is in that pod's init: it delays the `stage` agent's start, and a pull that fails (ErrImagePull, ImagePullBackOff)
// fails the boot as any NEVER_READY reason does.
//
// Agent sessions (agent-client.ts AgentSession, one per agent instance of a pod). The `stage` session, opened at boot,
// carries the staging and is closed once the release has ended its exec (the agent exits with its container). The
// `watch` session, opened once the pod is Ready (WATCH_DIAL_MS) in a pod with `watch` (every shim pod), is kept for the
// pod's life and closed after its delete: every watch exec (ProgramWatch), the collect (collectProgram) and the watch probe
// (watchAnswers: its /v1/health within WATCH_PROBE_TIMEOUT_MS, which tells a pod killed whole from `main` ended alone)
// go over it, and so does every exec into `main` or a plan member (MemberExec, agentMember: the program, the policy wait,
// the signals and kills, a member's door dial and bind proof), which `watch` relays to that container's shim once the
// shim gate has let it (below). Neither ever re-sends an exec (agent-client.ts's no re-send): a stream that opened and
// stalls fails at its budget (the transfer's, the program's start bound, a one-shot exec's timeout), one that never
// opened fails at once.
//
// The agent's security model (agent-wire.ts's header has the wire). K is per pod, 32 bytes from this process's
// crypto.randomBytes, in the pod's own Secret alone, read by secretKeyRef only by `stage` and `watch` (uid 10001, each in
// its own mount and PID namespace): never in `main` or a member, the pod spec, a kubectl argv or a log, and the agent
// takes it out of the environment its children get. The grader pins the agent's TLS key (HKDF of K) on secureConnect,
// before any request, so a recycled pod IP or a stolen port fails the dial (AgentDialError `pin`, never re-dialled); every
// request carries an HMAC of K bound to that TLS connection, so the agent answers only a holder of K; the agent binds its
// pod's own IP alone and drops TCP from any source not in MAKEFUN_AGENT_PEERS (the creating grader's pod IP, or the burst
// relay's: agent-client.ts agentPeerIp, K8sSandbox.agentSpec). The namespace's ingress policy admits TCP 9011 into
// sandbox pods only from the grader, worker, racer and test components; no sandbox egress is added. An entrant who
// escapes `main` inside gVisor reaches only its own pod's agent, which holds nothing it could not already tamper with
// through `watch`.
//
// The shim gate (release 2; bootFromAgent, awaitShims). `watch`'s agent accepts each name in its MAKEFUN_AGENT_CONTAINERS
// once, over the pod's shared loopback (127.0.0.1:9012), and closes its link listener once all are in (#747 probe 4:
// a squatter then catches nothing). Until then any process in any member can run the mounted binary as `shim
// --container <a missing member>` and be taken for it, and `watch`'s health cannot tell (#747 probe 4b: the grader's
// exec to `env` ran in `main`). So no exec goes into any member (the program, the policy wait, the door dial, the bind
// proof, the signals and kills) before `watch`'s /v1/health lists every container its pod declares (shimMembersOf):
// the boot asks it SHIM_REDIAL_MS apart, within what is left of the ready budget (SHIM_GATE_MIN_MS at least), and a
// pod whose `watch` has not listed them all by then, or stops answering, is the driver's failure, nothing exec'd. A
// kill before it only deletes, as a kill before the program's exec always did. The members exist only once `stage`
// has exited 0 (an init container), with their shims as PID 1 and nothing else in them until an exec: so while no exec
// has run, only the members' own shims can have linked, and once `watch` lists every name the listener is shut.
//
// Staging (the plan's step 7; k8s-transfer.ts). Nothing of the grader's disk is mounted in a program pod: every tree it
// mounts is staged into it. The pod's init container `stage` runs `makefun-agent stage`, which keeps the signals of the
// shell PID 1 it replaced: SIGUSR2, the staging exec has arrived; SIGUSR1, the release, exit 0; with no arrival within
// STAGE_ARRIVAL_S it exits 1, so a pod whose creator died before staging fails by itself (restartPolicy Never) instead
// of sleeping on until activeDeadlineSeconds; once arrived it waits for the release with no deadline of its own (the
// driver holds the budget, and deletes the pod; a pod whose creator died mid-stage goes to reapOrphans, at last to
// activeDeadlineSeconds). SIGTERM: exit 0 before the arrival (SIGUSR2), 143 between it and the release (SIGUSR1). It
// serves the wire meanwhile. Once its agent answers (Fast boot, above), the driver stages: one
// exec over the `stage` session, k8s-transfer.ts stageStream, its command stageCommand (STAGE_EXEC_SCRIPT around the
// house unpacker: umask 022, SIGUSR2 to PID 1, the unpacker, then SIGUSR1 to PID 1 every STAGE_RELEASE_EVERY_MS until
// the container ends under it), carrying /bot, a launcher's /house and every mount, a writable mount's seed files (a
// scorer's /scores/run.json) with it. The verdict is the unpacker's ack line, never the exec's end (the release ends it
// with no exit). Then the Ready wait as before, which now means `stage` has exited 0 and `main` and
// `watch` run: the kubelet keeps `main` from existing until then, so nothing that holds an input read-write is alive
// while the program runs. Staged files are STAGE_UID's with the modes the stream carried: `main` (65534) reads them, a
// write is refused (Read-only file system), a chmod or an unlink too. Budgets: readyTimeoutMs runs from the create to
// the moment the program's exec may start (scheduling, the IP, `stage`'s agent, the Ready wait), and the staging exec's
// own (k8s-transfer.ts transferBudgetMs, which moves with the bytes) is added to it; the collect has collectBudgetMs.
// Once the program's exec has ended, its watch is stopped (its stop() awaited, so nothing of a live mirror is still being
// written), then a pod with a writable mount has them collected (k8s-transfer.ts collectMounts over the `watch` session:
// each into its host directory, held to its `returns`), then it is deleted, then `exited` settles. A staging or collect
// failure is the driver's (the job retried). Every program pod is staged so, the one-pod view's plain and timed spawns (the
// base's own) and its plan pods (One pod, below) among them: nothing makes a program's pod on the claim, and no option,
// environment or config value selects it. No pod the driver makes mounts the claim (removeTree makes none: Scratch,
// below), the lanes pod (k8s-lanes.ts) neither: it mounts emptyDirs alone since lanes protocol v2.
//
// No sentinel (the exec cut off, kubernetes#142461, or the pod gone): the pod is read, again for up to POD_SETTLE_MS
// while its status settles (up to EVICTION_SETTLE_MS for a Running pod with a writable mount whose `watch` is dead
// too). OOMKilled is 137 (gVisor ends the whole sandbox when the pod's limit is hit; under runc the kernel kills the
// program and the sentinel says 137), so is a program kill() ended, and so is a pod the kubelet evicted for a
// writable mount's sizeLimit (evictedFor: phase Failed, reason Evicted, `Usage of EmptyDir volume
// "<one of this pod's writable volumes>" exceeds the limit`, read from the pod's own status, since its containers are
// then ContainerStatusUnknown with no exit code). That eviction is a backstop, never the bound: the kubelet measures an
// emptyDir once every 1 to 2 minutes (volumeStatsAggPeriod 1m0s on s18, jittered up to double), so a sizeLimit eviction
// can come more than 2 minutes after the limit is passed (the one measurement was 22.6 s), a pod that lives under about
// a minute may never be measured at all, and a writer at disk speed overshoots by far meanwhile; a metered mount's
// bound is its live meter (`watch`). So is the program's kill of its container's first process (gVisor lets it `kill
// -KILL 1` its PID 1 there, the hold then and the shim now, which ends `main`; seen on makefun-dev 2026-11-12, the shim's
// the same under gVisor in #747's probe 1): its exec ended 137 with no
// sentinel, and the pod reads `main` terminated Error (exit 137; a `kill -TERM 1`, Completed exit 0) with nothing
// of the platform's on it
// (mainKilledFromWithin: not being deleted, nothing OOMKilled, no reason on the pod, no DisruptionTarget), at
// POD_SETTLE_MS and, in a pod with `watch`, once `watch` answers the probe; it is graded as the program's crash, never
// a void it could force. Anything else (a pull that failed, Unschedulable, no Ready in time, the exec lost,
// any other eviction) is K8S_DRIVER_FAILURE with an error naming the pod and what its status says. The files of a pod
// that died whole are lost (the plan's D8): nothing is collected then. So are a pod's that dies in the collect, which
// memory-backed files the program left (`/tmp`, the pod's `/dev/shm`, charged to the pod after it exits) can push past
// the pod's total: a collect that fails in a pod then read, as above, OOMKilled or evicted for its own writable volume
// is the program's kill, 137 whatever the sentinel said, each writable mount's host directory left empty (any other
// collect failure stays the driver's). kill() kills the local exec, everything in
// `main` (`kill -KILL -1`, so nothing of the program outlives the kill), collects the mounts from `watch` when the
// program's exec had started (the plan's D10; a kill before that only deletes), then deletes; every pod is deleted once
// its program has exited. Nothing is collected from a pod whose program may still run: a kill exec that fails (the
// script exits 0 once `kill` ran, whatever it said, so a failure is the exec's own: the pod or `main` gone, the API
// unreachable, SIGNAL_TIMEOUT_MS) collects nothing and reads the pod as above: OOMKilled or evicted for its own writable
// volume is the program's kill and a pod that is gone the kill done, each 137 with every writable mount's host directory
// emptied; a pod still there otherwise is K8S_DRIVER_FAILURE naming the kill.
//
// Room on the node. The node's pod addresses bind first: on dsh-makefun each node's pod range is one /24
// (`spec.podCIDR`, else `spec.podCIDRs[0]`, under Cilium's kubernetes IPAM, 254 assignable), every namespace's pods
// drawing from it, so the node refuses sandboxes (`FailedCreatePodSandBox … range is full`) once the range is gone,
// well under its kubelet's maxPods.
// The range, not a flat figure: on 2026-11-12 s18 refused sandboxes with only 151-158 pods holding an address because
// about 95 more were held by pods already deleted whose sandbox teardown lagged the API (a backlog that cleared 3-5
// minutes after pods stopped being made), while that afternoon s9 held 163 addresses of its /24 and took sandboxes
// still. So a node's ceiling is its own range less ADDRESS_HEADROOM for such a backlog.
// A pod the API still lists holds its address after its program exits: on makefun-prod 2026-11-13 11:14Z s9 listed 24
// sandbox pods Failed (`Error`, exit 143) and 21 Terminating, each with its status.podIP, while the kubelet tore their
// sandboxes down, and the room read, counting no Failed pod, read those addresses as free, so the queue admitted pods
// the CNI then refused (`range is full`). The address count is therefore every pod not finished (as the scheduler counts
// slots) plus each finished pod (phase Succeeded or Failed) still listed with a podIP that holds it
// (finishedPodHoldsAddress): one being deleted, until the object goes, and one nothing deleted for ADDRESS_RELEASE_MS
// after it finished, since the kubelet frees a finished pod's address without its delete and the object keeps its podIP
// (a Job's pods kept for its history: s18 listed 12 such that night, 7 of their addresses already a running pod's).
// The scheduler counts no pod address (the CNI hands one out after it places the pod): a pod it has placed whose sandbox
// gets none stays Pending, PodScheduled True, so noRoomIn does not read it as room and its ready budget ends a plain
// driver failure. A pod the scheduler finds no room for stays Pending, PodScheduled False with reason
// Unschedulable and words naming what ran out (`Too many pods`: the kubelet's maxPods, which every namespace's pods
// share, prod's, dev's and the races' alike; `Insufficient cpu|memory|…`: the requests); a create a ResourceQuota
// refuses says `exceeded quota`. Such a pod waits for room within the same ready budget (readyTimeoutMs) as any
// Pending pod, and one still short of room at its end fails as any driver failure does, its process marked
// (K8sProcess.noRoom, noRoomOf; a preflight's NodeRoomError) so that a caller can tell backpressure from a fault:
// grader/agent.ts makes it a node_capacity void, which grader/worker.ts never counts as a pass, handing the trial back. A
// meter has no pod or container of its own on either layout (it runs in its program's pod's `watch`), so it never waits
// for room, and its fault is always the caller's plain SandboxError.
// Before a job takes its pods at all, the node's free places are read (K8sSandbox.nodePodRoom: each node the selector
// picks that takes pods (nodeRefusal: a cordoned, Not Ready or NoSchedule/NoExecute-tainted node is no room at all, as
// the scheduler places nothing there; a burst box joining, drained or gone among them; each start, change of reason and
// end of a node's refusal is warned of once, never every read: noteNodeRefusals), max(0, min(status.allocatable.pods less the pods bound to it in every namespace and not finished, its range's
// addresses less ADDRESS_HEADROOM less those pods and its finished pods still holding an address)); the range is
// spec.podCIDR, else spec.podCIDRs[0]; a node naming neither, or no IPv4 range, falls back to its allocatable alone):
// server/jobs.ts waits on it before a job takes its sandbox pod budget, and the trial handler hands a trial
// on while the node lacks room for it. The address half is measured, not read: the CNI hands an address out after the
// scheduler places a pod and nothing lists the free ones, so a node's free places stop at its own range less the
// teardown headroom before either the kubelet's slots or its /24 runs out. The queue's other read of
// its namespace's Pending sandbox pods still covers a pod the scheduler placed past NO_ADDRESS_AFTER_MS and the CNI
// gave no address (server/pipeline/pod-room.ts noAddressIn). The node read needs get/list on nodes and list on pods
// across namespaces, which the namespaced Roles (deploy/k8s/sandbox/rbac.yaml, deploy/k8s/base/rbac.yaml) do not
// grant: refused, it says so once and answers unknown, and only the scheduler's
// verdict on each pod holds the node. A caller that keeps a headroom free on a node (server/jobs.ts NODE_POD_HEADROOM)
// hands it to the read, and each node then counts only past it (roomBesideHeadroom): a node inside its headroom lends
// a job nothing, so a single pod waits for room only when no node has any, while a job of several may still fit the
// nodes' sum and no one node, and the scheduler then places its pods on both. The Pending read's hold for a pod with
// no address is per node as well: its own node then gives the room nothing (`out`), and it holds the queue only while
// no other node its selector fits has room (server/pipeline/pod-room.ts uncoveredOf; unsparedOf where the nodes cannot
// be read). Across the nodes of its selector an untimed program pod carries a soft
// spread (SANDBOX_SPREAD: by kubernetes.io/hostname over the namespace's sandbox pods but the forwarders, maxSkew 1,
// ScheduleAnyway), so the scheduler prefers the node that holds fewer of them and neither node runs far ahead of the
// other; it is a preference and refuses nothing. A one-pod plan's pod carries it too unless it is timed; a timed pod
// carries none (its own selector keeps a heat on one node), nor does the lanes pod, one a grader: it takes the sandbox's
// nodeSelector (any gVisor node) but, like a forwarder, no spread and no preferred node (k8s-lanes.ts's header).
// The spread balances pod COUNTS, and the app node (APP_NODE_LABEL, s18) also carries Postgres, web and every timed pod,
// so beside it each untimed pod gets one preferred node (the driver's drawn placement, nodePreferenceAffinity: a
// preferred nodeAffinity term of weight 100, never a refusal). A forwarder (an agent trial's `llm`, the only pod that
// carries POD_LABEL) prefers a node without the app label and is not spread. A race's pod (makefun.io/sandbox=race)
// prefers the app node, no draw (racePodPreference), whenever the drawn placement is on (a share or a cap) and its
// selector's nodes are both with and without the label: a racer idles at about 0.002 cores between bars (64 race pods
// held 0.1 cores in all on makefun-prod 2026-11-13 12:11Z) but holds one of its node's pod slots for a whole race window,
// and s9 was then bound by its slots (224 of 250 pods, 34% CPU), not its CPU, while s18 had about 174 free addresses and
// CPU to spare; so the racers' slots are s18's and s9's go to grading. It is a preference: with no room on the app node
// the scheduler puts the race pod on s9. And it turns to `other` once the app node is at or under APP_NODE_ROOM_FLOOR
// free places (before its cap), as the share does: the floor is what keeps s18's /24 short of the CNI's refusal, which
// the scheduler never sees, and that range carries Postgres and web too. A race pod whose spec reserves its CPU
// (SandboxSpec.reserveCpu: a sweep session's, server/race/runner.ts reservingCpu, which replays bars back to back at
// about a core) is no idler: it takes a trial agent's placement below, REQUIRED off the app node (trialAgentPreference),
// its race labels kept. Every other untimed program pod, a plan's
// pod included, prefers the app node with probability K8sSandboxOptions.appNodeShare
// (MAKEFUN_K8S_APP_NODE_SHARE, default 0.4) and a node without it otherwise, drawn from a hash of its own name
// (drawsAppNode), so the many processes that make pods need no shared state and cannot herd. The draw reads the
// nodes' room as the pod is made (nodePodRooms, cached): with the app node at or under APP_NODE_ROOM_FLOOR free places
// the share is 0; with no read, or the selector's nodes not both with and without the label, no preference is set.
// Both are preferences, so once the other node is full the scheduler puts every pod on the app node; the hard bound
// is the app node's sandbox cap (K8sSandboxOptions.appNodeSandboxPods, MAKEFUN_K8S_APP_NODE_SANDBOX_PODS: makefun-prod
// 24 since 2026-11-13 15:25Z, 16 from 14:06Z, 40 from 13:10Z). A trial agent's pod (the entrant's program in an agent/v1 trial: the split layout's
// TRIAL_AGENT_SPEC_LABEL pod, the `pod` layout's TRIAL_AGENT_PLAN_LABEL pod that holds the entry) is the CPU work of
// grading, about a core each (8 of them took s18 to 95 % on 2026-11-13, while a grade pod used 0.0-0.2 cores), so
// whenever the drawn placement is on it is labelled TRIAL_AGENT_LABEL and REQUIRED off the app node
// (trialAgentPreference: `not-app` whatever the share, the cap or either node's room; none only when the nodes read
// one-sided or were never read), and the cap neither counts it nor needs to. Among the gVisor nodes, the split layout's
// trial agent requests that core (TRIAL_AGENT_CPU_REQUEST_MILLI, programCpuRequestMilli), so the scheduler's
// least-allocated score places it by the nodes' load and not their pod counts alone. Under the cap the room reads give the app
// node no more than the cap less every namespace's sandbox pods bound there and not finished, timed ones counted and
// race pods and trial agents not (CAPPED_SANDBOX_SELECTOR; appNodeCappedRoom;
// NodeRoom.uncapped keeps its places before the cap, which the floor above still reads), so server/jobs.ts's room line
// and the trial handler hold work at the cap instead of admitting it against the app node's whole room. A race pod
// costs the node next to no CPU, which is what the cap bounds, and counted, the racers preferring the app node would
// hold the cap shut on grading; it still takes a slot and an address, so the node's own room (and the floor) counts it.
// At the cap the share is 0, and with no place left
// under it the drawn placement is `not-app`: a REQUIRED term keeping the pod off the app node, so it waits for room
// on another node like any Pending pod. A timed pod (required onto the app node) and a forwarder (its own fixed
// preference) are counted and never kept off by the cap, a race pod neither counted nor kept off, a trial agent kept off
// always and never counted; the read is cached
// for NODE_ROOM_CACHE_MS, so the processes may place a few pods past the cap between two reads.
// Those recurring list reads (the nodes, each node's bound pods and its finished pods with an address, runningGraders,
// sandboxPodsHeld, graderPods and sandboxPodViews: K8sSandbox.listExec)
// go to the API server in-process inside a pod (k8s-count.ts, the pod's service-account token, the same `list` verbs):
// kubectl decodes every pod whole even for `-o name`, 0.54 s of CPU for s18's list and about 0.94 s a room read, which
// cost each grader about 0.135 cores idle (17% of its CPU, measured on makefun-prod 2026-11-12); a Table of names costs
// 1.3-1.6 ms. Same counts, a 403 still kubectl's Forbidden, a shed (429 or 5xx) a cut that waits out its Retry-After
// before the next list (never kubectl's heavier list into the same flow), any other failure that one read by kubectl.
// kubectl stays for everything else (create, wait, exec, delete, the reap sweeps) and for every read outside a pod; a
// kubectl call cut at its budget names the last line kubectl wrote to stderr, if any. Where the lists are kubectl's,
// one spawn each, and KUBECONFIG names the cluster (a burst grader's: a few nodes and a few hundred pods), the room
// read lists every bound pod once as JSON and counts each node's from it (RoomList `cluster`, nodePodCountsOf): two
// spawns a read whatever the nodes, against two or three a node. Each node it answers also carries its allocatable
// CPU (NodeRoom.cpuMilli), what a width sized from the nodes' CPU sums (roomCpuMilli).
//
// Reaping a dead creator's pods. A pod outlives the process that made it when that process dies with it running (a
// rollout's old grader killed past its grace, a crash, an eviction): its PID 1 holds its node slot until
// activeDeadlineSeconds, six hours, or until the stale sweep (k8s-network.ts sweepStale, STALE_AFTER_MS) at some grader's
// next start. A namespace holds several such processes at once (two graders, the worker, the racer), so none may take
// what it did not make on that ground alone: each pod names its maker instead. A process given its own pod's name
// (K8sSandboxOptions.creator: server/config.ts reads POD_NAME, which deploy/k8s/base's grader, worker and racer set from
// the downward API) annotates every pod it makes with it, CREATOR_ANNOTATION, and reaps (K8sSandbox.reapOrphans) at
// its start and every ORPHAN_REAP_EVERY_MS after: it lists the sandbox namespace's sandbox pods (makefun.io/role=sandbox,
// as JSON) and its own namespace's pods not finished (K8sSandboxOptions.ownNamespace, where the creators run, the
// sandbox namespace when it is the same one; `-o name`, phase neither Succeeded nor Failed: an evicted pod's object
// stays, its process gone), and deletes (deleteObjects: the pod, its `<pod>-env` Secret and `<pod>-llm` policy, and its
// trial's makefun-net-<trial> policy when no pod kept is on that trial) every sandbox pod whose creator is not among
// them and that is older than ORPHAN_GRACE_MS, so a pod whose maker is still starting is never taken. A pod already
// being deleted (a metadata.deletionTimestamp: KUBECTL_DELETE_FLAGS' graceful delete keeps it listed until the kubelet
// has ended it) is going: never deleted again, and it keeps no trial's policy. A pod with no creator annotation (made
// by a process with no POD_NAME, or by a release from before it) is never taken, and only the sandbox namespace's are.
// A listing that does not hold the reaping process's own pod is not trusted (its POD_NAME is no pod of its own
// namespace's) and reaps nothing. It is an annotation, not a label: the cluster kit's
// admission policy (deploy/k8s/cluster/admission-policy.yaml) admits podLabels' keys and no other on a worker's pod.
// The trial's own reap by owner (k8s-network.ts reap) is never used here: a dead grader's trial may already be graded
// again under the same owner by a live one. What this cannot see: a process whose container restarted inside the same
// pod keeps its name, so what its first run left waits for the stale sweep. The six-hour sweep stays the backstop.
//
// Its own pod's deletion deadline. A grader that drains on SIGTERM (server/server.ts drainJobsInHand) asks, every
// DRAIN_DEADLINE_READ_MS while it drains, when its own pod (the creator) is to be gone (K8sSandbox.ownDeletion: `kubectl
// get pod/<creator> -o jsonpath={.metadata.deletionTimestamp}`, the Role's `get` on pods): a rollout's delete sets it
// the pod's grace on, a deploy's cut (makefun-k8s.sh GRADER_STOP_GRACE) moves it to 30 s on, and the drain ends in time
// for its shutdown before it (server/server.ts watchOwnDeletion). An answer that the token is refused (TOKEN_REFUSED_RE:
// kubectl's `You must be logged in to the server (Unauthorized)`, which the API server answers a pod's token from a
// minute past that deadline) says nothing more can be done through the API, and ends the drain at once.
//
// The forwarder of an agent trial reaches masq (MAKEFUN_LLM_GATEWAY_SANDBOX_URL) as docker's does from the
// egress bridge. The namespace's egress policy keeps a sandbox off the fleet's own servers and every
// private range, where masq may sit, so a forwarder pod also gets a NetworkPolicy of its own,
// <pod>-llm (gatewayPolicy): egress to the gateway's addresses on its port and nothing else.
//
// Pod identities. Cilium gives each distinct set of a pod's labels a security identity (a CiliumIdentity object,
// allocated as the endpoint is made, and kept for its heartbeat timeout plus a GC interval after its last pod is
// gone), from a cluster-wide range of 16 bits on dsh-makefun. A label whose value is unique to the pod therefore
// mints one identity per pod: thousands an hour at the grader's pod rate, each costing the endpoint's create its
// allocation. So makefun.pod=<name> (POD_LABEL) is on a pod only when a NetworkPolicy of that pod's own selects it
// by it: a forwarder given a gateway policy (K8sSandbox #spawn passes SandboxPodOptions.ownPolicy exactly when it
// makes <pod>-llm). Every other pod is told apart by its name alone (no sweep, reap or delete selects by that label),
// and its labels repeat: every preflight and race pod, and every unnetworked program pod, shares one
// of a handful of identities; a networked pod's is its trial's (makefun.net), shared by the trial's pods that carry
// the same labels. The pod's Secret and its policy keep makefun.pod: they are no endpoint and mint nothing. A one-pod
// plan's pod (planPodLabels) carries no makefun.pod, makefun.net or makefun.trial either, no policy selecting it by one,
// so every plan pod of one kind (with doors or without) shares one identity; its owner is its annotation alone.
//
// A trial's owner (network.ts TRIAL_OWNER_RE: up to 128 characters, a scrape trial's
// `scrape-<heat>.<entry>.<round>` 65 and more) need not be a label value, which is at most 63 characters,
// alphanumeric at both ends. Its makefun.trial label is ownerLabel(owner): the owner itself when it is one
// (every agent trial's), else `h-` and the first 40 hex of its sha256. Every object of the trial's that is labelled
// with it (its policy, its networked pods, a pod's Secret and gateway policy; never a plan pod) and the reap's selector
// take that one function, so what is labelled is what is found, and an owner short enough keeps the label it had
// before; each object carries the owner whole as the annotation makefun.io/trial-owner (OWNER_ANNOTATION), which is
// what the one-pod view's reap finds a plan pod by (K8sOnePodTrialNetworks).
//
// A trial's network is a NetworkPolicy, makefun-net-<trial> (k8s-network.ts K8sTrialNetworks, made before any of the
// trial's pods): its pods (makefun.net=<trial>) reach one another and nothing else beyond what the namespace's policies
// allow. Before an entry's program runs, the policy wait measures that it holds for the pod: from inside it, in its own
// interpreter (POLICY_WAIT_ARGV), each service its hostAliases name (the served peers: PodNames.served) takes a
// connection within POLICY_WAIT_MS, or the spawn is the driver's failure; how long it took, the exec's start included,
// is the process's policyWaitMs (and in that failure's words). A trial's pods may sit on different nodes: hostAliases
// are pod IPs and the policy selects by label, so neither cares, and the isolation probe's allowed pair
// (k8s-network.ts) is what proves routing between nodes. Only the entry waits: it is spawned once its services are
// ready (listening), and it dials them as it starts. It dials each one's POLICY_PORT, never the port its program
// serves: a served pod's PID 1 takes it, accept and close (the shim's `--policy-port POLICY_PORT`, shimCommand; in
// release 1's shape, the perl POLICY_LISTENER_COMMAND), so the wait is no connection of the program's (a
// scrape gateway records every connection it accepts in its cassette, and counts it against max_connections; docker has
// no wait). The trial policy names no port, so PID 1 answering is the served port being allowed too.
//
// The meter (meterTree) runs in its program's own pod: K8sSandbox.meterTree registers it on the process whose writable
// mount is the metered directory (a directory no process of the sandbox mounts writable is a SandboxError), and the
// process runs k8s-watch.ts's watcher (planWatch, WATCH_SCRIPT) by its pod's `watch` agent (the pod's `watch` session:
// Agent sessions, above) beside the program's exec, every meter
// registered by then in one exec; a meter asked for once that exec started gets a watch exec of its own. Every caller
// asks right after its spawn, before the pod is Ready. LiveWatch hands each reading, `unread` in it, to the meter's
// onUsage; the watcher counts as uid WATCH_UID, so a directory the program closed to the grader is counted unread, and
// its callers give it the root's grace (k8s-watch.ts UnreadGrace) before it is a breach. The same exec mirrors every
// writable mount's `live` files (the harness's ready files, a replay's miss, a house-clock log) into their host
// directories, so a pod with live files and no meter gets a watch exec too, started before the program's exec as a
// meter's is; a meter's own later exec carries no live file (the first already does). The watcher's own end
// (WATCH_SCRIPT's lifetime) is what can still pass once its exec starts: the policy wait, the program's exec's start,
// its budget and METER_SLACK_MS; with live files and no meter, STALE_AFTER_MS, the pod's own deadline. The driver stops
// every watch itself once the program's exec has ended (the wrapper's kill reaches `main` alone), before the pod is
// signalled, collected or deleted. A watch that ends before it is stopped is each of its meters' onFault (a driver
// failure, the caller's SandboxError); one with live files and no meter to hand it to ends its process, the program's
// exec cut, as the driver's failure; either only unless the program's exec ends within WATCH_FAULT_SETTLE_MS of it: an
// OOM or an eviction ends the whole pod, and the program's own exit (137) is then what happened. That watch, its meters
// and its live files are one class (ProgramWatch), a K8sProcess's and each one-pod member's (K8sPodProcess) alike.
// preflight is a pod under the same RuntimeClass, account and node selector whose init container runs the agent image's
// `makefun-agent version` (PREFLIGHT_AGENT_CONTAINER) and whose `main` runs `true` in the runtime's image, both pulled
// IfNotPresent through the registry's pull Secret, so a node that cannot pull or run either fails the preflight, not a
// grade; once per runtime, digest and agent image per process. It asks no exec RBAC: no grading exec goes through the
// API server's pods/exec (release 2: each over its pod's agent).
//
// Scratch. Every tree a program wrote comes back through the collect's reader (tree-stream.ts readTrees) as this
// process's own files, mode-000 placeholders among them, so nothing in a scratch directory needs the sandbox user to
// delete it and removeTree makes no pod: it gives this process's own directories their owner's rwx back
// (unlock.ts unlockOwn), then deletes with rm. What rm still may not delete (EACCES, EPERM, ENOTEMPTY) is a tree
// another uid owns, which no pod of this driver writes: scratch a sandbox user of the previous pod shape (a pod on the
// claim, writing as 65534) left there, which only that release's driver or the sweep Job (makefun-k8s.sh
// sweep-old-scratch, run after a deploy's drain) removes. That is a SandboxError naming the directory, never a
// LeftoverError (nothing the program in hand did) nor a success; the reaps that meet one keep it in their `errors`. A
// tree nested past PATH_MAX is rm's own ENAMETOOLONG, thrown as it is, so grade.ts removeWritable lifts it.
//
// Timing (a program/v1 timing heat, grader/code-heat.ts; docker.ts's header has docker's clock): openCpuClock hands
// back a clock (K8sCpuClock) and a timed sandbox (K8sTimedSandbox), whose every program pod is a timed pod
// (SandboxPodOptions.timed): root with the launcher's SETUID, SETGID and KILL, as a scrape launcher's pod is, and its
// CPU limit (CODE_HEAT_CPUS, one) its request too, so the node reserves the whole CPU the run is held to. Every timed
// pod is placed by the timed node selector (K8sSandboxOptions.timedNodeSelector; absent, the plain one), so a heat's
// runs and its control read one host's CPUs while every other pod may go to any node the plain one picks. Its removeTree
// is its base's (no pod), and its `watch` is unprivileged as every pod's (its CPU is
// none of the launcher's reading: the launcher reads its own tree's). The program arrives by exec as every program
// does (never the pod's command: the default-deny race above), under TIMED_EXEC_WRAPPER, which is EXEC_WRAPPER with
// the house's CPU launcher (CPU_LAUNCHER_SCRIPT: perl, as perl-base is in both pinned images) between it and the
// program. The launcher makes itself the child subreaper of its tree (prctl PR_SET_CHILD_SUBREAPER), so whatever the
// program orphans is reparented to it and never escapes; forks the program as 65534:65534 with no supplementary group;
// waits for it; then SIGKILLs every descendant still alive (found by /proc's parent links) in rounds until it has
// reaped them all, and reports getrusage(RUSAGE_CHILDREN), user plus system in µs, on descriptor 4: the CPU of every
// process the program started, forked, detached or outliving it, each folded in as it was reaped. Descriptor 4 is the
// wrapper's command substitution, close-on-exec so the program never holds it, and the wrapper, root, prints the
// reading as `RS<nonce>c<µs>\n` before the sentinel. The program, 65534, can read neither the root wrapper's nonce nor
// the root launcher's descriptors, so it cannot forge the line. The launcher exits with the program's status (128+n
// for a signal). A launcher that cannot do its part (no subreaper, no report descriptor, a drop or exec that fails, a
// process that will not die) reports nothing and exits 125, and a timed exit with a sentinel and no reading is the
// driver's failure. gVisor counts each user's tasks apart (kernel.go UserCounters), and a timed pod's own tasks are
// root's, so the wrapper's cap (pids plus POD_OWN_TASKS, as for any pod) leaves the program, alone as 65534, its pids
// and those two more, as a scrape launcher's entry is left; root's own count reaches TIMED_ROOT_TASKS (PID 1, the
// wrapper, the launcher, the program before it drops), so a timed spawn under a RuntimeClass needs pids of at least
// TIMED_ROOT_TASKS less POD_OWN_TASKS.
//
// The clock is the sum of the readings of its timed sandbox's pods, each added once its process has exited; settled()
// waits for every one in flight (docker.ts CPU_CLOCK_READ_MS at most). A timed pod whose program ran and reported no
// reading (the exec lost, a kill that could not wait for it) faults the clock: every read after it throws SandboxError,
// so the heat stops rather than rank on a run counted short. One whose program never started adds 0. kill() of a timed
// process whose program runs first SIGKILLs every process of 65534 in its pod (TIMED_KILL_ARGV: what docker kill does
// to a container, the launcher aside), so the launcher still reaps and reports what the program spent up to its kill,
// as a docker timing parent keeps a killed container's CPU; only when no sentinel comes within TIMED_KILL_MS is the
// exec cut, as an untimed kill cuts it at once. The clock's source is `rusage-children k8s <runtime class|default>
// cpu-<12 hex>`, so code-heat.ts codeHeatClockKind's kind is its first three words.
//
// What gVisor reports, read from its source (google/gvisor master, 2026-11-06; no gVisor pod was run for this):
// getrusage RUSAGE_CHILDREN (pkg/sentry/syscalls/linux/sys_rusage.go, ThreadGroup.JoinedChildCPUStats, folded in at
// each wait in pkg/sentry/kernel/task_exit.go) and PR_SET_CHILD_SUBREAPER (sys_prctl.go; task_exit.go reparents an
// orphan to its nearest subreaper) behave as Linux's. The CPU times themselves are gVisor's estimate, not the host's:
// every 10 ms tick (linux.ClockTick) credits a whole tick to each of up to applicationCores tasks it finds running
// application or Sentry code (pkg/sentry/kernel/task_sched.go runCPUClockTicker), applicationCores being the pod's
// CPU quota rounded up but at least 2 (runsc --cpu-num-from-quota, on by default). So a reading is a multiple of 10 ms,
// a task the host preempted still accrues ticks, and two threads running at once both accrue them under a one-CPU
// quota. The cgroup would not read better: gVisor's cgroupfs is v1, its cpu controller's files are stubs (no cpu.stat
// usage_usec), and cpuacct.usage sums the same task estimates (fsimpl/cgroupfs/cpuacct.go); it would also need a
// cgroup of the launcher's own, which a read-only mount and no CAP_SYS_ADMIN deny. Under no RuntimeClass (runc) the
// reading is the host kernel's own accounting, to the µs. Every entry and the null-entry control are counted the same
// way on the same kind of clock, so the control still takes the fixed cost out of every run.
//
// Two layouts (grader/sandbox/layout.ts). `split`, every pod above: an agent trial's entry, env and entry forwarder a
// pod each, and with a house target its forwarder a fourth (3 a trial, 4 with a house target: grader/agent.ts trialPods;
// as many pod addresses), a scrape heat's entry and gateway 2, a program run 1 (plain, metered, timed or a generator),
// every /output meter a `watch` container in its program's own pod. `pod`, beside it and never in its place: one sandbox
// pod an entry (below), and the key-holding programs (an agent trial's two forwarders, a scrape heat's recording
// gateway) lanes in its grader's one lanes pod (grader/sandbox/k8s-lanes.ts, makefun-sbx-lanes-<8 hex>), which this file
// does not make; so a `pod` agent trial holds 1 address of the node's /24 plus its share of its grader's lanes pod. A
// grader's lanes share one gVisor sandbox, weaker than `split`'s sandbox a forwarder: shared outright are its kernel,
// its loopback (another lane's port can be dialled; an entry lane's key on `pod` is its run's own for that trial,
// grader/agent.ts podEntryLaneKey, public once the run is recorded in its trial record's entry_key), its egress (a replay
// lane's included), its CPU and memory total, and the root program; the per-lane uids are not isolation. Which layout a
// contest runs is the caller's (sandboxLayoutOf: agent/v1 and scrape/v1 alone; a program/v1 grade is one pod on `split`
// and never takes `pod`); nothing here picks it, and a `split` pod is the same with or without the `pod` layout live. Both
// layouts' sandbox pods are staged and claim-less (a `split` program pod, the one-pod view's plan pods and its plain and
// timed spawns), free to go to any node the plain selector picks (a timed one to the timed selector's); only the lanes
// pod still mounts the data claim, and lands where its volume is (the app node).
//
// One pod for an entry's programs (types.ts's header; K8sSandbox.onePod, K8sPod). The one-pod view is this sandbox in
// every way (its preflight, removeTree, meterTree, images, networks and reaping are its base's, and so is a plain
// spawn: the base's own staged pod, as a `pod` agent trial's scorer runs) but that it has `pods` and a CPU clock of its
// own (openCpuClock, below), and that its networks' reap by owner (K8sOnePodTrialNetworks) also takes the owner's plan
// pods, which carry no label of it (Pod identities, above): after the base's reap,
//
//   kubectl -n <ns> get pods -l makefun.grader=1,makefun.io/role=sandbox,makefun.io/sandbox=program -o json
//   kubectl -n <ns> delete pod/<each whose makefun.io/trial-owner is the owner> --ignore-not-found --grace-period=1 --wait=false -o name
//                                                      (KUBECTL_DELETE_FLAGS: graceful, never forced)
//
// listed again while any is left, REAP_ROUNDS deletes at most; one already being deleted (a deletionTimestamp: the
// graceful delete keeps it listed until the kubelet has ended it) is not left, as in the base's reap. That list is what a `pod` trial's start costs the API
// server: every program-kind sandbox pod of the namespace as JSON, once a reap (again only while one of the owner's is
// left), since no label names the trial (a label unique to it would mint a Cilium identity a trial: Pod identities).
// If the pod tier's trial rate ever makes that list heavy, it is the thing to change first: a pod name derived from the
// owner would make the reap a delete by name. A SandboxPodPlan's pod (podPlanSpec) is claim-less as a `split` pod is:
// each member's mount points a disk emptyDir of its own (`<mount volume>-<member>`, memberVolumeName; a writable one
// with its D14 sizeLimit), ONE init container `stage` holding every member's volumes read-write at
// `/m/<member><mount point>` (memberMountPath: two members' /bot apart) and installing the shim into agent-bin, one
// container a member, each the shim as its PID 1 (shimCommand <member>, agent-bin read-only at AGENT_BIN_DIR), each
// program exec'd into its own container, and ONE `watch` last, in every plan pod, taking every member's shim link
// (MAKEFUN_AGENT_CONTAINERS: the members in the plan's order, SHIM_MEMORY_MI each) and holding every member's writable
// volumes read-only at those paths, in place of a meter container; `stage` and `watch` the agent's, as a program pod's
// (The pod, above). A pod is (bootAgentPod, as a program pod's boot):
//
//   kubectl -n <ns> create -f - --validate=false -o <CREATED_JSONPATH>   ONE List: its Secret <pod>-env (podPlanSecret:
//                                                      its agents' K and every member's keys), then the pod (podPlanSpec)
//   PATCH …/secrets/<pod>-env <ownerPatch>                off the critical path (`kubectl patch` outside a pod)
//   GET …/pods?fieldSelector=metadata.name=<pod>&watch=true   `scheduled` once a read shows it placed, then its IP
//   agent `stage`: GET /v1/health, then  /bin/sh -c <STAGE_EXEC_SCRIPT> sh 1 perl -e <unpacker> -- /m/<member>/...
//                                                      ONE staging exec of every member's trees, then the release
//   kubectl -n <ns> wait --for=condition=Ready pod/<pod>           one Ready wait, all of it within readyTimeoutMs and
//                                                                  the staging exec's own budget; then `address`
//   agent `watch`: its session, kept until close(); GET /v1/health until it lists every member's shim (the shim gate)
//   then per member, its spawn, every exec over the `watch` session (in <member>: relayed to that member's shim):
//   agent `watch`, in <member>: <POLICY_WAIT_ARGV> ... <door address> <its door port>   the door dial
//   agent `watch`, in <member>: <BIND_PROOF_ARGV> 127.0.0.1 <port>    for each local name another serves
//   agent `watch`: perl -e <WATCH_SCRIPT> ... /m/<member>/...   its meters and live files
//   agent `watch`, in <member>: /bin/sh -c <EXEC_WRAPPER> sh <pids> <argv...>   its program (its signals and kills too)
//   agent `watch`: perl -e <packer> -- /m/<member>/<mount> <caps...>   its writable mounts' collect, once its exec ended
//   kubectl -n <ns> delete pod/<pod> secret/<pod>-env --ignore-not-found --grace-period=1 --wait=false   once, at close()
//
// `scheduled` resolves once a read of the pod on its watch shows it placed (PodScheduled True, a node, or its IP: nothing
// is minted, staged or started for a pod not placed) and rejects with a NodeRoomError when the node had no room for it
// within the ready budget (noRoomIn, or a create a quota refused), else a SandboxError; `address` resolves with the pod's
// IP once it is staged and Ready and rejects as `scheduled` does. Both carry a handler of their own, so a rejection nobody
// awaits is never an unhandled one. The boot fails at once for a container of either status list waiting for a
// NEVER_READY reason, any container ended, or `stage` ended before it was staged or with a code other than 0, and so
// does a staging exec that fails (k8s-transfer.ts stageStream): every member's program is then the driver's failure.
// Every member's host trees must be complete when the pod is opened (SandboxPods.open): they are staged once, before
// any member runs. A member's program (spawn) waits for Ready, then dials its door port (SandboxPodPlan.doors.ports:
// the lanes pod's address, POLICY_WAIT_ARGV in its own runtime within POLICY_WAIT_MS, measured as the entry's policy
// wait is, never assumed from Ready; a dial that ran and took no connection is the driver's failure and is also
// reported, off that path, to the lanes pod behind the door, under its trial (the plan's owner, else its pod's name):
// K8sContext.doorMissed, reportLanesDoorMiss, k8s-lanes.ts's A dead door, where two trials' misses within ten minutes
// have the grader dial the door itself, and that dial failing too replaces it), then proves, from inside its own container,
// that it cannot bind 127.0.0.1 at the port of each local name another member serves (`store`, the env's 8080):
// BIND_PROOF_ARGV binds it, in one exec, with SO_REUSEADDR set, with SO_REUSEPORT set and with both, each of which must
// be refused with EADDRINUSE. The probe (deploy/k8s/README.md, Measured: two containers in one gVisor pod, c2, c6)
// found gVisor's netstack lets a second socket bind a specific address beside a wildcard listener and take its
// connections, and refuse it once the env listens on 127.0.0.1 itself; and (The bind proof's reuse options, P5) that
// under gVisor another uid's SO_REUSEPORT bind joins an env listener that set SO_REUSEPORT and takes a share of its
// connections, which Linux would refuse. Any bind that succeeds (named by its option), or a proof that cannot run, is
// the driver's failure (a platform fault: the pass voids, never scored), and the program never starts. The harness
// spawns a served member (and has it listening) before the member that dials it, as the split layout does.
// Then the program, by an exec in <member> under EXEC_WRAPPER (a timed `main`'s TIMED_EXEC_WRAPPER: Timing, above), its
// nonce, start line and sentinel as K8sProcess's; `finished` at its sentinel. `started`, `exited`, stdio, kill() and
// terminate() act on that container alone: `kill -s <sig> -- -1` exec'd there reaches its own PID namespace, its shim
// spared as PID 1 (probe a2: another container's programs, under the same uid or not, keep running). Its process cap is its own pids plus
// POD_OWN_TASKS: RLIMIT_NPROC counts a uid's tasks across the whole sandbox (probe d) and a uid apart apart (d2), and
// podPlanSpec never gives two program members one uid; `watch` is WATCH_UID, counted apart, so a timed `main` needs
// TIMED_ROOT_TASKS alone. Its meters (pod.meter: one on the plan's meter member) and its writable mounts' live files run
// in a watch exec by the pod's `watch` agent, read at the member's own `/m/<member>` paths, by K8sProcess's mechanism
// (ProgramWatch, The meter above): meters asked for before its program's exec join one watch exec started just before it,
// a later one gets an exec of its own, and a watch's fault waits WATCH_FAULT_SETTLE_MS for the program's end. At its
// program's end or its kill (once its exec had started), its watch is stopped and awaited, its writable mounts collected
// over the `watch` session (collectMounts, at its `/m/<member>` paths) into their host directories, then `exited`
// settles; a member killed before it started collects nothing. A member's exit deletes nothing; close() kills what still
// runs (each collecting), deletes the pod once and closes its `watch` session.
// What shares the sandbox, plainly: on `pod` the env's hidden state (its /env-data, /state and memory) and the house
// token sit in the same gVisor sandbox as the entrant's code, which is weaker than `split`, where the env is a pod of its
// own. Between them stand gVisor's per-container PID and mount namespaces and the members' different uids, which
// gVisor's maintainers do not count as a strong boundary; a member's volumes are mounted in its own container alone (the
// env's /env-data and /state never in `entry`), and `stage`, holding every member's, is gone before any member exists.
// Shared outright: the network namespace (loopback ports, abstract unix sockets) and the CPU and memory totals. Each
// program member's container mounts a Memory emptyDir of its own at /dev/shm, `shm-<member>` (b5), and with it mounted
// the pod's own /dev/shm is reachable from `entry` at no path (the lanes probe's row S1, PASS); that is a mount over a
// path, not isolation. Only the pod's memory total is enforced (e1, e3), and past it gVisor ends every container
// `OOMKilled`, 137, in the pod's containerStatuses while each program's exec ends with no sentinel (e2: 128 by
// kubectl; over the agent a lost stream, `watch` and the shims ending with the pod). So an exec
// that ends with no sentinel reads the pod, again until its container's status says it ended (at most
// KUBECTL_TIMEOUT_MS: the kubelet's report lags the exec's end): any container OOMKilled marks the pod `oom`, and every
// member still live exits K8S_KILLED, nothing collected. A pod evicted for one of its own writable volumes' sizeLimit
// (evictedFor) is read the same way, as the plan's D14 has it (as an OOM); its eviction can come more than 2 minutes
// after the limit is passed (No sentinel, above), a backstop behind the meter, never the bound. A member whose container
// ended in a pod still Running has `watch` probed once: dead too, the pod is read on up to EVICTION_SETTLE_MS for its
// eviction; any other eviction is the driver's failure. The cost: on `pod` an exec lost for any other reason, while its
// container runs on, takes the whole KUBECTL_TIMEOUT_MS (60 s) to become the driver's failure, where a `split` pod's
// re-read is POD_SETTLE_MS (3 s). A collect that fails in a pod then out of memory or so evicted is the program's
// kill, its host directories emptied (collectProgram, as a K8sProcess's).
// What a member wrote comes back through the collect as the grader's own, whichever member's uid wrote it, so the
// view's removeTree is its base's (Scratch, above): no pod, the uid that wrote a tree no matter. The view's openCpuClock times a plan's `main` and a plain spawn (the base's timed pod) under TIMED_EXEC_WRAPPER, counted
// on its clock as a timed pod's program is; no grade reaches it: a program/v1 grade is one pod on `split` and never
// takes `pod`, its timing on the base's openCpuClock (grader/worker.ts `layout`). Sandbox.spawnMetered, a program and
// its meter in one call, has no implementation in this driver (types.ts: no harness calls it): a metered program is
// spawn then meterTree, one pod of `main` and `watch` on either view, the view's spawn being the base's own.
//
// Case sessions (types.ts's header: sessions; grader/program.ts executePerCase; k8s-session.ts K8sSession, which holds
// the pod, its scripts and the session's own calls). With K8sSandboxOptions.caseSessions true (absent or false: no
// `sessions`, every case its own program pod as above), K8sSandbox.sessions opens a session per per-file execution: its
// cases run one after another in ONE session pod (k8s-session.ts sessionPodSpec: a program pod whose `main` is the
// session reaper, `stage` holding /bot alone, `watch` holding each read-only mount's volume read-write at
// `/restage<mount point>`). Each run is still a K8sProcess, in a session mode (Launch.session): it makes and deletes
// nothing itself; its pod, wrapper and argv come from the session's prepare (the pod booted by bootPod as a program pod
// is, or reused: the reset, then the restage of its read-only mounts through `watch`), then its exec, under
// SESSION_EXEC_WRAPPER with the case launcher (SentinelScanner reads the launcher's `RS<nonce>i<word>` report, and a
// sentinel with no `i ok` is the driver's failure, never the case's), its meters in a watch exec beside it, `started`
// and `finished` as every program's, its writable mounts collected from `watch`, and `exited` once the session has been
// told how it ended (SessionLaunch.settle); the pod is kept. Its kill is every program's (`kill -KILL -1` in `main`, the
// collect), the pod kept. A pod its run's own end spent (podKill `memory`, `volume` or `pid1`; any driver's failure; a
// kill that failed) is deleted, and the next run boots a fresh one; the run that spent it is graded as it ended, the
// program's crash and never a void it could force. Before every case but a pod's first, the reset (k8s-session.ts
// SESSION_RESET_SCRIPT) kills what the last case left, wipes 65534's entries under the writable mounts, /tmp and /dev/shm,
// empties /dev/termination-log, then verifies all three; each case then runs under the case launcher in a user, IPC and
// network namespace of its own (its own SysV and POSIX IPC and keyrings, its own loopback: no earlier case's port in
// TIME_WAIT, no abstract unix socket; deploy/k8s/README.md § Measured: one container, many execs). Where the case
// launcher cannot run (the check right after a session pod's boot), the run it booted for runs there alone under
// EXEC_WRAPPER, the pod is then deleted, and every later run of the session is a program pod of its own: never two cases
// in one pod without the launcher's namespaces.
//
// The pace (SandboxPace; its policy server/pipeline/capacity.ts's: paceFaultOf, paceAfterFault, paceAfterClean). The
// room above bounds how many pods the nodes hold, never how fast a grader asks the control plane for them, and a final's
// lock asks for hundreds at once: on makefun-prod 2026-11-14 20:20Z the API server shed 429s (APF), exec upgrades failed
// `error dialing backend: dial timeout` and stagings ran out with no ack while the gVisor nodes sat near 20 % CPU. So one
// limiter a process (processSandboxPace; K8sContext.pace, absent for a sandbox given its own `exec`, as tests are, unless
// K8sSandboxOptions.pace names one) paces every pod create of its K8sSandbox and of its lanes pods (PaceKind `create`,
// the one kind): each waits for a slot, FIFO. Grading execs nothing over kubectl: every exec of a pod the driver makes
// goes over its pod's agent (release 2: the staging, the collect, the watch, the watch probe, and every exec into
// `main` or a member, the program, its policy wait, signals and kills, a one-pod member's door dial and bind proof, a
// case session's runs, launcher check and resets, the isolation probe's reaches, the lanes pod's one stream), which
// never touches the control plane and holds no slot (tests/unit/sandbox-no-kubectl-exec.test.ts guards it). Its
// limit starts at its width (sandboxPaceWidthOf: MAKEFUN_K8S_SANDBOX_PACE_WIDTH, else the release's
// MAKEFUN_K8S_SANDBOX_POD_BUDGET; on the burst grader alone (MAKEFUN_WORKER_QUEUES=burst, read as capacityCeilingsOf
// reads it: paceFollowsBudgetOf) a width not named by the first then follows the pod budget each capacity read sets,
// SandboxPace.followPodBudget, up to MAX_SANDBOX_PACE_WIDTH: held at the boot 24 while its capacity raised the budget,
// the burst grader of 2026-11-16 sat at 24 creates in flight with 20-48 waiting; a cut limit stays cut. A home grader
// keeps its boot width until a measured raise: following its budget would take it from 24 to some 60 creates in flight,
// and prod's home init clock already shows its `ip` phase at ~13 s p50, which tracks the create rate, the node's unseen
// CPU scaling with the sandbox start rate, .cosmos/rules/grading-capacity.mdc), halves (floor 2)
// on a fault that says the control plane is overloaded or down (capacity.ts SANDBOX_PACE_FAULTS, read by paceFaultOf: a
// 429, an API server that answers nothing), once a burst (a
// start let through before the cut cuts nothing more), holds every new start for the first Retry-After a cut names (up
// to 30 s), and grows back to its width by one every clean start above half its width and one every 4 at half or under
// (paceGrowEveryOf). A 429 or an unreachable API server any kubectl() call meets, paced or not, cuts it the same
// (SandboxPace.observe). An exec path's words (a backend dial failure, a failed upgrade) are no fault of the control
// plane's at all (capacity.ts controlPlaneFaultOfWords): no exec crosses it. Every fault is said, at most one line a
// PACE_FAULT_LINE_EVERY_MS: the faults that held the pace (a cutting one, a burst's later ones too) since the last
// line, by reason, with the limit then (#sayFaults). A slot is held by bootAgentPod's create (the Secret, a
// gateway policy and the pod: createPodObjects' POSTs, or its one List) to its answer, never through the boot's waits,
// dials or staging (an in-process create's 429 is the slot's `shed` at once, the POST asked again after its Retry-After
// inside the same slot: createPodObjects), and by any other `create` kubectl() runs, to its answer. Never
// by an exec over a pod's agent, a kubectl call sent `paced: false`, the watch probe, the Secret's owner patch, a pod read
// or a watch: those must not queue behind creates. Waiting is no
// fault: every budget a create has (the ready budget, a call's timeout) starts once it holds its slot, and a kill cuts
// the wait (the start then ends killed). A start the slot was cut short of (aborted while it waited) never ran. What it
// does is warned of when the limit moves, and the metrics carry it: makefun_k8s_sandbox_pace_limit, _width and _waiting,
// and makefun_k8s_sandbox_pace_backoffs_total{reason}
// (registerPaceMetrics, on the process's registry, server/ops/metrics.ts's). The pace is per process: a release's graders
// do not share one, and the live room's split over them (server/pipeline/capacity.ts) bounds the rest.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { realpathSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter as pathDelimiter, join, posix, resolve as resolvePath } from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENTRY_SECRET_VALUE_MIN_CHARS } from '../../contracts/entry-secrets.ts';
import {
  BURST_CAPACITY_CEILINGS,
  capacityCeilingsOf,
  controlPlaneFaultOfWords,
  paceAfterClean,
  paceAfterFault,
  paceAtWidth,
  paceFaultOf,
  paceFloorOf,
  retryAfterMsOf,
  SANDBOX_PACE_FAULTS,
  SANDBOX_PACE_MAX_HOLD_MS,
  sandboxPaceOf,
  sandboxPaceWidthOf,
  type ControlPlaneFault,
  type SandboxPaceFault,
  type SandboxPaceState,
  type SandboxPaceWidth,
} from '../../server/pipeline/capacity.ts';
import { agentImage, IMAGES, imageFor, imageRef, type ImageTableT } from '../images.ts';
import { HOUSE_DIR, LAUNCHER_ARGV, SANDBOX_UID } from '../scrape/launch.ts';
import {
  AGENT_PEER_IP_ENV,
  AgentDialError,
  agentPeerIp,
  agentRelayFromEnv,
  AgentSession,
  firstNonInternalIpv4,
  recordInit,
  registerAgentMetrics,
  type AgentChild,
  type AgentName,
  type InitPhase,
  type InitSource,
} from './agent-client.ts';
import { AGENT_CONTAINERS_ENV, AGENT_KEY_ENV, AGENT_PEERS_ENV, formatContainers, formatPeers, newAgentKey, parseAgentKey, parseContainers, SHIM_REDIAL_MS, type AgentHealth } from './agent-wire.ts';
import { spawnPiped } from './kubectl-broker.ts';
import { K8sWarmPool, POOL_NODE_HEADROOM, POOL_TTL_MS, registerPoolMetrics, type PoolBoot, type PoolShape, type WarmPod } from './k8s-pool.ts';
import {
  checkSandboxLabel,
  CONTAINER_LABEL,
  CPU_CLOCK_READ_MS,
  type CpuClock,
  formatCpus,
  houseFilesMissing,
  LAUNCHER_CAPS,
  METER_SLACK_MS,
  positiveInt,
  settlesWithin,
} from './docker.ts';
import {
  ApiCut,
  ApiUnsent,
  apiExec,
  apiListExec,
  inClusterApiCreate,
  inClusterApiGet,
  inClusterApiObjects,
  inClusterApiPatch,
  isShed,
  listDocOf,
  listItemsOf,
  retryAfterMs as retryAfterHeaderMs,
  processApiWatch,
  resentOnceUnsent,
  watchPod,
  type ApiCreate,
  type ApiGet,
  type ApiObjects,
  type ApiPatch,
  type ApiWatch,
  type ListDoc,
  type ListKeep,
  type WatchedPod,
} from './k8s-count.ts';
import { K8sTrialNetworks } from './k8s-network.ts';
import { K8sSession, type K8sSessionHost } from './k8s-session.ts';
import { collectMounts, type CollectMount, stageStream, WATCH_CONTAINER } from './k8s-transfer.ts';
import { LiveWatch, planWatch, type WatchMeterSpec } from './k8s-watch.ts';
import { checkSandboxMounts } from './mounts.ts';
import type { StageTree } from './tree-stream.ts';
import { checkTrialOwner, EGRESS_LABEL, NETWORK_LABEL, OWNER_LABEL, parseDockerTime, REAP_ROUNDS, ROLE_ALIASES, SCRAPE_GATEWAY_PORT, SERVICE_PORT, STALE_AFTER_MS, trialNetworkName } from './network.ts';
import {
  checkHostPath,
  checkSandboxEnv,
  checkSandboxImage,
  checkSandboxLauncher,
  checkSandboxNetwork,
  checkSandboxPodPlan,
  checkSandboxRace,
  checkSandboxSecrets,
  containerMountEnv,
  type MountPoint,
  repoImageRef,
  RUNTIME_COMMANDS,
  SANDBOX_ENV,
  SandboxError,
  scriptOf,
  TRIAL_NETWORK_PREFIX,
  type IsolationVerdict,
  type PodLocalName,
  type PodMember,
  type PodMemberSpec,
  type ReapResult,
  type Runtime,
  type Sandbox,
  type SandboxExit,
  type SandboxMount,
  type SandboxNetwork,
  type SandboxPod,
  type SandboxPodPlan,
  type SandboxPods,
  type SandboxProcess,
  type SandboxSessions,
  type SandboxSpec,
  type SweepResult,
  type TerminableProcess,
  type TreeMeter,
  type TreeMeterOptions,
  type TrialNetworks,
} from './types.ts';
import { unlockOwn } from './unlock.ts';

/** The exit code of a program the cluster could not run (docker run's own 125, DOCKER_RUN_FAILURE). */
export const K8S_DRIVER_FAILURE = 125;
/** The exit code of a program kill() ended, or the pod's memory limit did (OOMKilled): a SIGKILL's 128 + 9, as docker reports it. */
export const K8S_KILLED = 137;
/** Every sandbox pod's name starts so. */
export const POD_PREFIX = 'makefun-sbx-';
/** The program's container of a sandbox pod (every pod's, and an aux pod's only one). */
export const CONTAINER = 'main';
/** The house container a pod with a writable mount has beside `main` (the header): k8s-transfer.ts's one name, re-exported for the tests. */
export { WATCH_CONTAINER };
/** `watch`'s user and group: the grader's own (10001), neither 65534 nor root, so it sees a program's tree as the grader does. */
export const WATCH_UID = 10001;
export const WATCH_GID = 10001;
/**
 * `watch`'s resources (the plan's D9b): requests 10m and 32Mi, limits 50m and 32Mi; in a shim pod SHIM_MEMORY_MI more
 * memory for each shim (shimWatchMemory).
 */
export const WATCH_CPU_REQUEST_MILLI = 10;
export const WATCH_CPU_LIMIT_MILLI = 50;
export const WATCH_MEMORY_MI = 32;
export const WATCH_MEMORY = `${WATCH_MEMORY_MI}Mi`;
/**
 * How long a watch's fault waits for the program's exec to end before it is its meters' fault (the header): a pod that
 * ends whole (gVisor at the memory limit) ends both execs, and the program's exit says so. POD_SETTLE_MS's figure.
 */
export const WATCH_FAULT_SETTLE_MS = 3_000;
/**
 * A program pod's staging container (the header's The pod): an init container, by the owner's ruling on the plan's D21,
 * which takes the pod's trees over the staging exec and exits 0 once released, before `main` and `watch` exist.
 */
export const STAGE_CONTAINER = 'stage';
/** `stage`'s user and group (the plan's D2): the grader's own, so a staged file shows the owner it showed on the claim. */
export const STAGE_UID = 10001;
export const STAGE_GID = 10001;
/**
 * How long `stage`'s agent waits for the staging exec to arrive (its SIGUSR2) before it exits 1 and the pod fails
 * (`makefun-agent stage --arrival <s>`: agent-wire.ts's header). It bounds the exec's arrival, never the staging, whose
 * bytes have no cap: the driver holds that budget.
 */
export const STAGE_ARRIVAL_S = 300;
/** How often the staging exec repeats its release (SIGUSR1) until `stage`'s PID 1 is gone. */
export const STAGE_RELEASE_EVERY_MS = 20;
/** A writable mount's disk emptyDir's least sizeLimit, in MiB (mountSizeLimit: the plan's D14). */
export const MOUNT_SIZE_MIN_MI = 64;
/** The house agent in the agent image (sandbox-agent/Dockerfile): PID 1 of `stage` and of `watch` (the header's The pod). */
export const AGENT_BIN = '/usr/local/bin/makefun-agent';
/**
 * A long-running container's PID 1 where it only holds the pod open (release 1's `main` and plan members, which the
 * shim holds now: shimCommand, its contract this one's; `watch` is the agent's
 * `serve`, which exits 0 on SIGTERM itself): perl (perl-base, in every image
 * the table pins, as POLICY_LISTENER_COMMAND's), one task that exits 0 on SIGTERM, so the
 * delete that ends a finished pod (the kubelet's TERM) leaves it Completed, not Error (a bare `sleep infinity` as PID 1
 * ended 143), and otherwise reaps: every child on SIGCHLD and once a second besides, so what a program orphans and
 * ends is never a zombie its uid's process cap counts (deploy/k8s/README.md, probe K4: `sleep infinity` reaped none).
 * One task, never a shell and its `sleep` (two of the uid's tasks under the wrapper's process cap, where POD_OWN_TASKS
 * and TIMED_ROOT_TASKS count PID 1 as one): a program's `kill -KILL -1` never reaches PID 1, so only a signal to PID 1
 * itself ends the container: `kill -KILL 1` still ends it 137, a program's `kill -TERM 1` 0 (mainKilledFromWithin,
 * either).
 */
export const HOLD_SCRIPT =
  'use POSIX (); $SIG{TERM} = sub { exit 0 }; $SIG{CHLD} = sub { 1 while waitpid(-1, POSIX::WNOHANG()) > 0 }; for (;;) { 1 while waitpid(-1, POSIX::WNOHANG()) > 0; sleep 1 }';
/** HOLD_SCRIPT's argv: the command of every hold container. */
export const HOLD_COMMAND: readonly string[] = Object.freeze(['perl', '-e', HOLD_SCRIPT]);
/**
 * The shim pod's binary (the header's The pod, release 2): `stage` copies its own `makefun-agent` into the pod's
 * AGENT_BIN_VOLUME emptyDir, held read-write at AGENT_BIN_INSTALL_DIR in `stage` alone (`makefun-agent stage --install
 * AGENT_BIN_INSTALL_DIR`, before it serves), which `main` and every plan member hold read-only at AGENT_BIN_DIR, so the
 * shim (SHIM_BIN) runs in a runtime image that holds no agent. A disk emptyDir, AGENT_BIN_SIZE at most (the binary is
 * about 2.5 MB): never the pod's memory.
 */
export const AGENT_BIN_VOLUME = 'agent-bin';
export const AGENT_BIN_INSTALL_DIR = '/agent-bin';
export const AGENT_BIN_DIR = '/run/makefun-agent';
export const AGENT_BIN_SIZE = '16Mi';
/** The shim: `stage`'s copy of the agent in AGENT_BIN_DIR, PID 1 of `main` and of each plan member (shimCommand). */
export const SHIM_BIN = `${AGENT_BIN_DIR}/makefun-agent`;
/**
 * The pod memory a shim takes, in MiB (#747's spike, gVisor's VmRSS: 4.0-5.6 idle, 6.3-6.6 after 64 MiB through its
 * relay): added to `watch`'s memory limit and request once for each shim the pod runs (watchContainer), since gVisor
 * enforces only the pod's total (deploy/k8s/README.md e1), so a program keeps its memory_mb whole beside its PID 1.
 */
export const SHIM_MEMORY_MI = 7;
/**
 * The least time the shim gate (bootFromAgent) has, from `watch`'s agent answering, for its /v1/health to list every
 * shim the pod declares, whatever is left of the ready budget: each shim links within one SHIM_REDIAL_MS of `watch`'s
 * listener (#747: 0 ms p50, 16 ms the slowest), so a pod Ready at its budget's end is not failed for a link in flight.
 */
export const SHIM_GATE_MIN_MS = 1_000;

/**
 * The PID 1 of a shim pod's `main` or plan member `container` (the header's The pod): `SHIM_BIN shim --container
 * <container>`, with `--policy-port <policyPort>` for a served pod's `main`, in POLICY_LISTENER_COMMAND's place (the shim
 * takes its duty in the same task: accept, close; a listen that fails ends it, exit 2). One task, as HOLD_SCRIPT's perl:
 * it exits 0 on SIGTERM (the kubelet's stop, a program's `kill -TERM 1`), a program's `kill -KILL -1` never reaches it,
 * and `kill -KILL 1` ends its container 137 (mainKilledFromWithin reads both as before; #747 probe 1, #1398).
 */
export function shimCommand(container: string, policyPort: number | null = null): string[] {
  if (!DNS_LABEL_RE.test(container)) throw new SandboxError(`shim container ${JSON.stringify(container)} is not a container name`);
  if (policyPort !== null && (!Number.isSafeInteger(policyPort) || policyPort < 1 || policyPort > 65_535)) throw new SandboxError(`shim policy port ${policyPort} is out of range`);
  return [SHIM_BIN, 'shim', '--container', container, ...(policyPort === null ? [] : ['--policy-port', String(policyPort)])];
}
/**
 * Every sandbox container's pull policy (the header's The pod): a node pulls an image it lacks, by its pinned digest, once,
 * and runs what it holds after; no pod is ever held to a node's pre-pull. A pull on a node that never had the image is
 * part of that pod's init (the header's Fast boot).
 */
export const IMAGE_PULL_POLICY = 'IfNotPresent';
/**
 * The registry's pull Secret every sandbox pod names (imagePullSecrets), as the app pods do: the agent image is a GHCR
 * package of this private repository (a SealedSecret in each namespace: makefun-k8s.sh seal makefun-registry); the runtimes
 * are public.
 */
export const IMAGE_PULL_SECRET = 'makefun-registry';
/** The preflight pod's init container on the agent image (preflightPodSpec): `makefun-agent version`. */
export const PREFLIGHT_AGENT_CONTAINER = 'agent';
/** A pod whose init (its create to its agent's first authenticated answer) passes this is named on the warning channel. */
export const INIT_WARN_MS = 2_000;
/** The least time between two init warning lines of one sandbox (InitWarnings): the slow inits between are counted. */
export const INIT_WARN_EVERY_MS = 60_000;

/**
 * One sandbox's init warnings (the header's Fast boot), at most one line each `everyMs`: a slow init when no line was
 * said in the last `everyMs` is said whole at once (its pod and phases); each after it within that time is counted
 * instead, and at the window's end (a timer that holds no process open) the count is one line, with the slowest of
 * them, which starts the next window. A window with nothing counted ends with nothing said.
 */
export class InitWarnings {
  readonly #warn: (line: string) => void;
  readonly #everyMs: number;
  readonly #now: () => number;
  /** When the current window ends: a slow init before it is counted. */
  #until = -Infinity;
  #held = 0;
  #slowest: { pod: string; ms: number } | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(warn: (line: string) => void, everyMs: number = INIT_WARN_EVERY_MS, now: () => number = Date.now) {
    this.#warn = warn;
    this.#everyMs = everyMs;
    this.#now = now;
  }

  /** Pod `pod`'s init took `ms`, past INIT_WARN_MS; `line` is its whole warning. */
  slow(pod: string, ms: number, line: string): void {
    const now = this.#now();
    if (now >= this.#until) {
      if (this.#held > 0) this.#flush();
      else {
        this.#warn(line);
        this.#until = now + this.#everyMs;
        return;
      }
    }
    this.#held++;
    if (this.#slowest === null || ms > this.#slowest.ms) this.#slowest = { pod, ms };
    if (this.#timer === null) {
      this.#timer = setTimeout(() => this.#flush(), Math.max(1, this.#until - now));
      this.#timer.unref();
    }
  }

  /** Say what the window counted, if anything, and open the next window from now. */
  #flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const held = this.#held;
    const slowest = this.#slowest;
    this.#held = 0;
    this.#slowest = null;
    if (held === 0 || slowest === null) return;
    this.#until = this.#now() + this.#everyMs;
    this.#warn(
      `k8s sandbox: ${held} more pod${held === 1 ? "'s init" : "s' inits"} took past ${INIT_WARN_MS} ms within ${this.#everyMs / 1000} s of the last such line (the slowest pod ${slowest.pod}'s, ${slowest.ms} ms; one line each ${this.#everyMs / 1000} s)`,
    );
  }
}

/** Each sandbox's InitWarnings, by its warning channel (K8sContext.warn: one a sandbox). */
const initWarnings = new WeakMap<(line: string) => void, InitWarnings>();

/** The InitWarnings of the sandbox whose warning channel is `warn`, made at its first slow init. */
function initWarningsOf(warn: (line: string) => void): InitWarnings {
  let w = initWarnings.get(warn);
  if (w === undefined) initWarnings.set(warn, (w = new InitWarnings(warn)));
  return w;
}
/**
 * How long one dial of a pod's `stage` agent may try before the pod is read once (a container that will never run fails
 * the boot then, as awaitPod's verdicts did) and the dial goes on, inside the ready budget (bootAgentPod).
 */
export const STAGE_DIAL_SLICE_MS = 5_000;
/** How long the dial of a Ready pod's `watch` agent may take (its container runs: the agent listens already). */
export const WATCH_DIAL_MS = 10_000;
/** How long the patch of a Secret's ownerReference may take, and the pause before its one retry (patchSecretOwner). */
export const SECRET_PATCH_TIMEOUT_MS = 30_000;
export const SECRET_PATCH_RETRY_MS = 1_000;
/**
 * The peer a pod spec is built with when it is only checked, never sent (K8sSandbox #spawn's spawn-time build, K8sPod's
 * constructor): a documentation address (RFC 5737). The spec sent is built again with the agents' real peer.
 */
export const SPEC_CHECK_PEER = '192.0.2.1';
/**
 * The staging exec's wrapper of the unpacker (stageCommand: `/bin/sh -c STAGE_EXEC_SCRIPT sh <pid> <unpacker argv...>`):
 * umask 022; SIGUSR2 to <pid> (arrived); the unpacker, its status the script's when it fails; then SIGUSR1 to <pid>
 * every STAGE_RELEASE_EVERY_MS until <pid> is gone, which in the pod ends the container, and the exec, under it. It
 * prints nothing of its own on stdout: the unpacker's `ok` or `no` line is the first line and the verdict
 * (k8s-transfer.ts stageStream).
 */
export const STAGE_EXEC_SCRIPT = [
  'umask 022',
  'p=$1',
  'shift',
  'kill -s USR2 "$p" 2>/dev/null',
  '"$@" || exit $?',
  `while kill -s USR1 "$p" 2>/dev/null; do sleep ${STAGE_RELEASE_EVERY_MS / 1000}; done`,
].join('\n');
/** The label the sandbox namespace's policies select (deploy/k8s/sandbox/networkpolicies.yaml). */
export const ROLE_LABEL = 'makefun.io/role';
/**
 * The label naming a pod by its own name: what a pod's own policy (gatewayPolicy) selects it by, so only such a pod
 * carries it (SandboxPodOptions.ownPolicy; the header's Pod identities), and its Secret and policy do.
 */
export const POD_LABEL = 'makefun.pod';
/** The label naming what a sandbox pod is for. */
export const SANDBOX_KIND_LABEL = 'makefun.io/sandbox';
/** The annotation holding a trial's owner whole on every object labelled with it (OWNER_LABEL holds ownerLabel of it). */
export const OWNER_ANNOTATION = 'makefun.io/trial-owner';
/** The annotation naming the pod of the process that made a sandbox pod (the header's Reaping): what reapOrphans reads. */
export const CREATOR_ANNOTATION = 'makefun.io/creator';
/**
 * The annotation of a pod its grader's warm pool booted before any run asked for it (k8s-pool.ts K8sWarmPool, the
 * header's Warm pool): its shape's key (shapeKeyOf). The creator's own restart sweeps every pod with it and its own
 * creator (K8sSandbox's pool start), since no process adopts another run's pool pod.
 */
export const POOL_ANNOTATION = 'makefun.io/pool';
/** A pool pod's shape key (POOL_ANNOTATION's value): POOL_KEY_HEX hex of the shape's sha256. */
export const POOL_KEY_HEX = 32;
const POOL_KEY_RE = new RegExp(`^[0-9a-f]{${POOL_KEY_HEX}}$`);
/** How old a sandbox pod whose creator is gone must be before reapOrphans takes it: a creator still starting is never short of its pods. */
export const ORPHAN_GRACE_MS = 2 * 60_000;
/**
 * What every reader of a `-o json` pod list here reads of each pod (k8s-count.ts ListKeep): graderPods, sandboxPodViews,
 * reapOrphans, the one-pod view's reap and the room read's finished pods (finishedPodHoldsAddress). Each list is parsed
 * off the event loop and cut to these (listDocOf), never on it.
 */
export const POD_LIST_KEEP: ListKeep = Object.freeze([
  ['metadata', 'name'],
  ['metadata', 'creationTimestamp'],
  ['metadata', 'deletionTimestamp'],
  ['metadata', 'annotations', CREATOR_ANNOTATION],
  ['metadata', 'annotations', OWNER_ANNOTATION],
  ['metadata', 'annotations', POOL_ANNOTATION],
  ['metadata', 'labels', NETWORK_LABEL],
  ['spec', 'hostNetwork'],
  ['status', 'phase'],
  ['status', 'podIP'],
  ['status', 'conditions', '*', 'lastTransitionTime'],
  ['status', 'containerStatuses', '*', 'state', 'terminated', 'finishedAt'],
  ['status', 'initContainerStatuses', '*', 'state', 'terminated', 'finishedAt'],
]);
/**
 * What the room read reads of each node of a `-o json` node list (NodeJson), as POD_LIST_KEEP: whether it takes pods
 * (spec.unschedulable, spec.taints, the Ready condition: nodeTakesPods), its range, its pod slots, its CPU and its memory.
 */
export const NODE_LIST_KEEP: ListKeep = Object.freeze([
  ['metadata', 'name'],
  ['metadata', 'labels'],
  ['spec', 'unschedulable'],
  ['spec', 'taints'],
  ['spec', 'podCIDR'],
  ['spec', 'podCIDRs'],
  ['status', 'allocatable', 'pods'],
  ['status', 'allocatable', 'cpu'],
  ['status', 'allocatable', 'memory'],
  ['status', 'conditions', '*', 'type'],
  ['status', 'conditions', '*', 'status'],
]);

/**
 * A `-o json` list's document, cut to `keep`, read off the event loop (k8s-count.ts listDocOf): what a caller reads
 * where it read `JSON.parse(stdout)`. `unparsed` for a text that is no JSON; `failed` (with the pool's words) when
 * the pool could not read it, which the caller treats as a list it could not read.
 */
async function listDoc(r: KubectlResult, keep: ListKeep): Promise<{ doc: unknown } | { unparsed: true } | { failed: string }> {
  let listed: ListDoc;
  try {
    listed = await listDocOf(r, keep);
  } catch (err) {
    return { failed: `its list could not be read off the event loop: ${(err as Error).message}` };
  }
  return listed.parsed ? { doc: listed.doc } : { unparsed: true };
}
/** How often a process with a creator reaps (and once at its start). */
export const ORPHAN_REAP_EVERY_MS = 3 * 60_000;
/** An owner label that is a hash (ownerLabel): this, then the first OWNER_LABEL_HASH_HEX hex of the owner's sha256. */
export const OWNER_LABEL_HASH_PREFIX = 'h-';
export const OWNER_LABEL_HASH_HEX = 40;
export type SandboxPodKind = 'program' | 'preflight' | 'isolation' | 'race' | typeof DESK_POD_KIND;
/** A house image's program pod's SANDBOX_KIND_LABEL value (the header's house image): the existing key, a value of its own. */
export const DESK_POD_KIND = 'desk';
/** The CPU a race's pod asks to be scheduled with, at most (the header: it waits for each bar far longer than it thinks). */
export const RACE_CPU_REQUEST_MILLI = 50;
/** The env Secret's name is the pod's plus this; the gateway policy's, GATEWAY_POLICY_SUFFIX. */
export const ENV_SECRET_SUFFIX = '-env';
export const GATEWAY_POLICY_SUFFIX = '-llm';
/** A spec env variable whose value goes in the env Secret, never in the pod spec (every one of a spec's `secrets` does too). */
export const SECRET_ENV_RE = /_API_KEY$/;
/** /tmp's size, docker.ts's TMPFS_SIZE. */
export const TMP_SIZE = '256Mi';
/**
 * A pod member's own /dev/shm's sizeLimit, the container runtimes' default /dev/shm size. Under gVisor the mount does not
 * enforce it (the rig's df read half the node): what a member keeps there is charged to the pod's memory total, the only
 * memory bound a one-pod trial has.
 */
export const SHM_SIZE = '64Mi';
/** The CPU a program's pod asks to be scheduled with, at most (its limit is the competition's). */
export const CPU_REQUEST_MAX_MILLI = 250;
/**
 * The CPU a split-layout trial agent's pod (isTrialAgentSpec: the entrant's program in an agent/v1 trial) asks to be
 * scheduled with, at most: its limit below this. A trial agent is the CPU work of grading, and at
 * CPU_REQUEST_MAX_MILLI the scheduler saw a quarter of it, so it balanced pod counts and not load: on makefun-prod
 * 2026-11-13 at the 150-trial ceiling a tiny-chess-01 trial agent used about 0.84 core (stats/summary; 35-42 of each
 * node's 46-55 trial agents at 0.6 core or more, their median 0.96-0.98 at the one-core limit, at 19:10Z) while it
 * requested 250m, and s10 read 93 % CPU beside s11's 72 %. Requested near what it uses, the scheduler's least-allocated
 * score sees each node's real load. A role's rule, not a contest's row: the driver never sees the contest's slug
 * (grader/sandbox/layout.ts POD_TRIAL_REQUESTS is the `pod` layout's per-contest row, its plan's `requests`).
 */
export const TRIAL_AGENT_CPU_REQUEST_MILLI = 850;
/**
 * The CPU an agent trial's forwarder pod (isTrialForwarder: the entry's `llm` or the house lane's `house`, live or
 * replaying) asks to be scheduled with, at most. Measured on makefun-prod 2026-11-13: 148 forwarder pods held 0.5 core
 * in all (median 2m, p90 2m) under their 500m limit (network.ts SERVICE_LIMITS). It is cut from CPU_REQUEST_MAX_MILLI
 * with TRIAL_AGENT_CPU_REQUEST_MILLI's rise, so a trial's three pods (agent 850m, env 250m + its `watch`'s 10m,
 * forwarder 50m + 10m: 1,170m) times the 150-trial ceiling (MAKEFUN_TRIAL_SLOTS_MAX) fit three 64-core gVisor nodes
 * beside the race pods: 850m beside a 250m forwarder (1,370m a trial) would ask 205 cores of 192 and hold agents
 * Pending.
 */
export const FORWARDER_CPU_REQUEST_MILLI = 50;
/** The preflight's and the isolation probe's own limits: docker.ts's METER_CPUS and METER_MEMORY. */
export const AUX_CPU_MILLI = 500;
export const AUX_MEMORY = '256Mi';
/**
 * The tasks of a pod's that count against the wrapper's process cap besides the program's: PID 1 and the wrapper. PID 1 is
 * one task in every sandbox container a program runs in: the shim (shimCommand: tokio's current_thread runtime, no
 * blocking pool; #747 probe 2 counted it one task under gVisor, `Threads: 1`; a case session's `main` the same shim as its
 * session reaper, k8s-session.ts SESSION_PID1_COMMAND), and release 1's HOLD_COMMAND's perl and single-threaded policy
 * listener; never a shell with a child, which would be one more.
 */
export const POD_OWN_TASKS = 2;
/** Each kubectl call's budget (not the exec, which runs as long as its program). */
export const KUBECTL_TIMEOUT_MS = 60_000;
/**
 * How late kubectlExec's budget may fire and still be read as kubectl's silence: later than this, this process's own
 * main thread was held past it (a stall), and libuv runs a turn's expired timers before its poll reads the pipes, so the
 * answer (its exit, its stdout; through the broker, its messages) may be there unread. A budget that fires this late
 * is never the cut: kubectl gets KUBECTL_STALL_GRACE_MS more with the loop running (kubectl-broker.ts
 * KUBECTL_BROKER_STALL_MS's twin).
 */
export const KUBECTL_STALL_LATE_MS = 2_000;
/**
 * What kubectlExec gives a kubectl past a budget that fired KUBECTL_STALL_LATE_MS late, the loop running: its answer read
 * meanwhile settles the call; an exit already seen is never cut (STDIO_GRACE_MS closes what holds its stdio). Long
 * enough for the reads the stall held back (an answer past a pipe's buffer, a broker's backlog over IPC) to drain; a
 * grace that fires late itself is another stall, and gives it this again.
 */
export const KUBECTL_STALL_GRACE_MS = 2_000;
/** How long a pod may take to be Ready: its scheduling included (a node short of the requests holds it Pending). */
export const READY_TIMEOUT_MS = 120_000;
/** One `kubectl wait`'s budget, in seconds: between two, the pod is read for a failure that will never be Ready. */
export const WAIT_SLICE_S = 5;
/** The least time between two waits (one that failed at once: the pod read since). */
export const WAIT_PAUSE_MS = 500;
/**
 * How long a pod whose exec ended without its sentinel is re-read for its status to settle (an OOM is reported a moment
 * later); a plan pod's member waits for its container's status instead (K8sPodProcess #unexplained).
 */
export const POD_SETTLE_MS = 3_000;
const POD_SETTLE_POLL_MS = 500;
/**
 * How long, from the exec's end, a pod with a writable mount still Running past POD_SETTLE_MS whose `watch` is dead too
 * (an eviction kills every container) is re-read for its eviction: on makefun-dev's s9 the kubelet posted a sizeLimit
 * eviction 41 s after the write.
 */
export const EVICTION_SETTLE_MS = 60_000;
/** The budget of the watch probe (the `watch` agent's /v1/health) that tells a whole pod killed from `main` alone ended (#podVerdict). */
export const WATCH_PROBE_TIMEOUT_MS = 5_000;
/** How long the exec may stay open after the sentinel before it is cut off: the wrapper has nothing left to say. */
export const EXEC_DRAIN_MS = 5_000;
/**
 * How long a program's exec has, from the moment it is made, to print the wrapper's start line (its queue on the pod's
 * `watch` session, the relay to the container's shim, the spawn and the wrapper's first lines in between): the program's
 * budget only runs from it, so this bounds the wait instead. One exec, sent once (the header's exec): never tried again.
 */
export const EXEC_START_TIMEOUT_MS = KUBECTL_TIMEOUT_MS;
/**
 * How long a kubectl's stdio may stay open and silent after it exited (a child of its holding them) before they are
 * closed. kubectlExec counts it once, from the exit: it reads stdout and stderr eagerly into arrays, so nothing of
 * theirs waits for a reader when it fires.
 */
export const STDIO_GRACE_MS = 2_000;
/** The budget of the exec that signals everything in a pod (terminate, kill). */
export const SIGNAL_TIMEOUT_MS = 10_000;
/** How many times a delete is tried, DELETE_BACKOFF_MS apart and doubling, before it is warned of. */
export const DELETE_ATTEMPTS = 3;
export const DELETE_BACKOFF_MS = 250;
/** The preflight pod's budget, from create to Succeeded. */
export const PREFLIGHT_TIMEOUT_MS = 120_000;
/**
 * What a Pending pod's PodScheduled False message (reason Unschedulable), or a refused create's words, says when the node
 * had no room for it (the header's Room on the node): its pod slots (the kubelet's maxPods, the later bound), a resource
 * its requests name, or a ResourceQuota. The node's pod addresses are the CNI's, not the scheduler's: a pod short of one
 * is Pending with PodScheduled True, its sandbox refused `range is full`, which NO_ROOM_RE does not match. Anything else
 * Unschedulable (a selector no node matches, a volume's node affinity) is not room.
 */
export const NO_ROOM_RE = /\bToo many pods\b|\bInsufficient [A-Za-z0-9./_-]+|\bexceeded quota\b/;
/** How long a node-wide pod room read (K8sSandbox.nodePodRoom) is answered from what it last read. */
export const NODE_ROOM_CACHE_MS = 2_000;
/** How long a refused node-wide read (no RBAC for nodes, or for pods across namespaces) is not tried again. */
export const NODE_ROOM_REFUSED_MS = 10 * 60_000;
/**
 * The addresses of a node's pod range kept free for the CNI's teardown backlog. A deleted pod's address is freed by its
 * sandbox's teardown, which lags the API: on 2026-11-12 s18 refused sandboxes (`FailedCreatePodSandBox … range is
 * full`) with 151-158 pods holding an address and 43 scheduled pods holding none, about 95 of its /24's addresses held
 * by pods already gone from the API (a backlog that cleared 3-5 minutes after pods stopped being made), while later
 * that day s9 held 163 addresses of its /24 and still took sandboxes. nodePodRoom therefore reads each node's ceiling
 * from its own range (`spec.podCIDR`, else `spec.podCIDRs[0]`, 2^(32-prefix) less the network and broadcast addresses)
 * less this headroom, not from a flat figure. The headroom is for pods gone from the API only: a pod still listed with
 * its status.podIP, finished (Failed, Succeeded) or being deleted, is counted as holding its address
 * (finishedPodHoldsAddress).
 */
export const ADDRESS_HEADROOM = 8;
/**
 * How long after it finished a finished pod (phase Succeeded or Failed) that nothing deleted, still listed with its
 * status.podIP, is counted as holding that address (finishedPodHoldsAddress). The kubelet tears a finished pod's sandbox
 * down, the CNI freeing its address, without anything deleting the pod, and the object keeps its podIP after: on
 * makefun-prod 2026-11-13 11:18Z s18 listed 12 such pods (Jobs' pods kept for their history, finished 5 to 30 hours
 * before), and 7 of their 12 addresses were already a running pod's. A teardown backlog cleared 3-5 minutes after pods
 * stopped being made (s18, 2026-11-12: ADDRESS_HEADROOM), so this is the slow end of that.
 */
export const ADDRESS_RELEASE_MS = 5 * 60_000;
/**
 * The field selector, after `spec.nodeName=<node>,`, of a node's finished pods that may hold an address of its range:
 * phase Succeeded or Failed (neither Pending, Running nor Unknown: those are the bound read's), a status.podIP, and not
 * on the host's network (a hostNetwork pod's podIP is the node's own address).
 */
export const FINISHED_WITH_ADDRESS_SELECTOR = 'status.phase!=Pending,status.phase!=Running,status.phase!=Unknown,status.podIP!=,spec.hostNetwork!=true';
/**
 * How long a fresh pod has, once Ready, for its first allowed connect, read by every dial that waits for one: an
 * entry's policy wait (POLICY_WAIT_MS), a one-pod member's door dial, and the isolation probe's allowed pair
 * (k8s-network.ts probeK8sIsolation). deploy/k8s/README.md e3 measured a fresh pod's first allowed connect 7-59 ms
 * after its container started, so already by Ready, on a quiet cluster. Under load it is not: on makefun-prod
 * 2026-11-21, 7 of the 10 held trials were tiny-chess entry pods whose every dial to their peers' POLICY_PORT dropped
 * unanswered for the whole 2 s the policy wait once was (the exec running the wait answered at 2.3-2.6 s, so the pod
 * network, not the exec path), while each grader started 100-186 pods a minute slower than 2 s, the slowest 20-56 s;
 * in rollout bursts the probe's pair, then dialled on its 3 s reach budget (network.ts ISOLATION_PROBE_MS), failed
 * 45 times the same way. Each dial returns as soon as its peer answers, so a healthy start pays nothing for a longer
 * one, and a pod the network never takes fails some seconds later than it did: 15 s.
 */
export const FIRST_CONNECT_WAIT_MS = 15_000;
/**
 * How long a trial's entry pod has, once Ready, to reach every peer it dials as it starts (its trial policy
 * enforced for it) before its program runs: FIRST_CONNECT_WAIT_MS.
 */
export const POLICY_WAIT_MS = FIRST_CONNECT_WAIT_MS;
/**
 * Where a served pod's PID 1 takes the policy wait's connections (POLICY_LISTENER_COMMAND): a port no served
 * program uses (SERVICE_PORT, SCRAPE_GATEWAY_PORT), below the ephemeral range, unprivileged.
 */
export const POLICY_PORT = 9009;
/**
 * A served pod's own command in place of HOLD_COMMAND in release 1's shape (a shim pod's shim takes its duty:
 * shimCommand's `--policy-port`): perl (perl-base, in every image the table pins),
 * one thread, accepting on POLICY_PORT and closing each connection at once, forever; a listen that fails ends
 * it, and the pod with it; SIGTERM (the delete's) ends it 0, as HOLD_SCRIPT's. IPv4, as pod IPs are here.
 */
export const POLICY_LISTENER_COMMAND: readonly string[] = Object.freeze([
  'perl',
  '-e',
  `use IO::Socket::INET; $SIG{TERM} = sub { exit 0 }; my $s = IO::Socket::INET->new(LocalPort => ${POLICY_PORT}, Listen => 64, ReuseAddr => 1) or die "policy listener: $!\\n"; while (1) { my $c = $s->accept or next; close $c }`,
]);
/**
 * Every `kubectl create` the driver issues: the object on stdin, with kubectl's client-side validation off.
 * Validation on, each invocation first fetches the API server's OpenAPI documents (GET /openapi/v2|v3) and
 * fails the create, unsent, when that fetch is slow ("error validating data … context deadline exceeded").
 * Off, kubectl sends fieldValidation=Ignore: the API server still checks every object's types and the
 * worker's admission policy still denies a pod outside the sandbox shape; only kubectl's refusal of an
 * unknown field is given up, which these specs, built in code, do not need.
 */
export const KUBECTL_CREATE: readonly string[] = Object.freeze(['create', '-f', '-', '--validate=false']);
/**
 * The flags of every `kubectl delete` of a sandbox pod the driver issues (deleteObjects, and k8s-network.ts's remove,
 * reap and sweepStale): never a NotFound, never a wait, and a graceful delete of one second, never a forced one. A pod
 * spec's terminationGracePeriodSeconds is 0, so with no grace option the API server would remove the pod object at once,
 * as `--grace-period=0 --force` did: its CiliumEndpoint was then garbage-collected while the node still tore the pod
 * down, and the node's Cilium agent re-created it until its own endpoint was deleted (s18, 2026-11-12: about 260
 * re-creates a minute, its API client throttled, address releases slowed). With a grace of 1 the object stays, with a
 * deletionTimestamp, until the kubelet has ended the pod: its container gets SIGTERM, then SIGKILL a second later,
 * which never stops a program (the driver kills it by exec first, and collects before the delete). The 1 is said
 * outright, never left to kubectl's turning `--grace-period=0` without `--force` into 1. A Secret or NetworkPolicy in
 * the same call has no graceful deletion (the API server ignores the option for it) and goes at once. A pod already
 * being deleted is listed until the kubelet is done: the re-lists (reapOrphans, reap, sweepStale) pass over it.
 */
export const KUBECTL_DELETE_FLAGS: readonly string[] = Object.freeze(['--ignore-not-found', '--grace-period=1', '--wait=false']);

/** `kubectl create`'s output when the env Secret follows its pod: kind, name and uid per object made. */
export const CREATED_JSONPATH = 'jsonpath={.kind} {.metadata.name} {.metadata.uid}{"\\n"}';

/** What the kubelet sets in every container whatever enableServiceLinks says (kubelet_pods.go; deploy/k8s/README.md check i). */
export const KUBERNETES_ENV = Object.freeze([
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
  'KUBERNETES_SERVICE_PORT_HTTPS',
  'KUBERNETES_PORT',
  'KUBERNETES_PORT_443_TCP',
  'KUBERNETES_PORT_443_TCP_PROTO',
  'KUBERNETES_PORT_443_TCP_PORT',
  'KUBERNETES_PORT_443_TCP_ADDR',
] as const);

/**
 * Where a pod's exec claims (the header's exec: the once-guard): `<dir>/<exec id>`, a directory each wrapper makes
 * with mkdir (atomic: one try of an exec makes it, every other finds it made) before it runs anything of the program's.
 * In `main`'s /tmp (an emptyDir of the pod's own, mode 1777, root's), the directory itself mode 0700.
 */
export const EXEC_CLAIM_DIR = '/tmp/.makefun-exec';
/** How many of a nonce's 32 hex digits are its exec's id, the claim's name (the first ones; the rest are the try's own). */
export const EXEC_ID_HEX = 16;
/** What a wrapper that found its exec claimed prints after RS and its nonce, alone on a line, before it exits EXEC_CLAIMED_STATUS. */
export const EXEC_CLAIMED = 'claimed';
/** A refused wrapper's exit status: its exec was claimed by another try, so it ran nothing. */
export const EXEC_CLAIMED_STATUS = 121;

/**
 * The once-guard's lines (the header's exec), the same in every wrapper, after the nonce is read and before anything
 * else: the claim directory made once (0700), then the exec's own claim, `mkdir <dir>/<the nonce's first EXEC_ID_HEX
 * digits>`. Made: this try runs the program. Already there: another try of the exec has it, so this one prints
 * `RS<nonce>claimed\n` and exits EXEC_CLAIMED_STATUS, nothing of the program's run. Neither (no /tmp to write): the
 * wrapper's failure, its words and exit 125 with no start line. Only in a pod: where the kubelet set none of its
 * variables (KUBERNETES_ENV: a host's sh, the unit tests' runs) there is no pod's /tmp to claim in, and nothing is.
 */
const EXEC_CLAIM_LINES: readonly string[] = Object.freeze([
  `[ -z "\${KUBERNETES_SERVICE_HOST-}" ] || [ -d ${EXEC_CLAIM_DIR} ] || mkdir -m 700 ${EXEC_CLAIM_DIR}`,
  `[ -z "\${KUBERNETES_SERVICE_HOST-}" ] || mkdir "${EXEC_CLAIM_DIR}/\${n%${'?'.repeat(EXEC_ID_HEX)}}" || { [ -d "${EXEC_CLAIM_DIR}/\${n%${'?'.repeat(EXEC_ID_HEX)}}" ] || { echo "sandbox: could not claim the exec in ${EXEC_CLAIM_DIR}" >&3; exit 125; }; printf '\\036%s${EXEC_CLAIMED}\\n' "$n"; exit ${EXEC_CLAIMED_STATUS}; }`,
]);

/** A nonce's length in hex digits (NONCE_RE): where a wrapper splits stdin's first line (EXEC_NONCE_LINES). */
const NONCE_HEX = 32;

/**
 * Stdin's first line read and split (the header's exec and Exec env), the same in every wrapper, before anything
 * else: the nonce's NONCE_HEX digits into `n`, and what follows them, the exec's own variables as ` NAME=<word>`
 * (execEnvWords; nothing for an exec with none), into `s`. A wrapper assigns no variable but n, s and c, each a
 * reserved name no secret can take (contracts/entry-secrets.ts RESERVED_SANDBOX_NAMES).
 */
const EXEC_NONCE_LINES: readonly string[] = Object.freeze(['IFS= read -r n || exit 125', `s=\${n#${'?'.repeat(NONCE_HEX)}}`, 'n=${n%"$s"}']);

/**
 * The exec's own variables exported (the header's Exec env), in every wrapper after KUBERNETES_ENV is unset and
 * before the process cap and the start line: each ` NAME=<word>` of `s` in turn, its word decoded by printf's %b
 * (execEnvWords' `\0ooo` escapes) with a `.` after it so a trailing newline outlives the command substitution, then
 * exported whole (`export "NAME=value"`: nothing of it is ever evaluated); `c` cleared after, so no value stays in the
 * wrapper's own variables. Only `s` and `c` are touched: `n` keeps the nonce. Before the cap, so the substitutions'
 * forks never count against it.
 */
const EXEC_ENV_LINES: readonly string[] = Object.freeze([
  `while [ -n "$s" ]; do s=\${s# }; c=\${s%% *}; s=\${s#"$c"}; c=$(printf '%s=%b.' "\${c%%=*}" "\${c#*=}"); export "\${c%.}"; done`,
  'c=',
]);

/** The bytes an exec variable's word carries as themselves (execEnvWords): printable ASCII but the space and the backslash. */
const ENV_WORD_PLAIN = (b: number): boolean => b > 0x20 && b < 0x7f && b !== 0x5c;

/** A shell variable's name, as an exec's own variable takes it (every secret name: contracts/entry-secrets.ts ENTRY_SECRET_NAME_RE). */
const EXEC_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * The exec's own variables (`env`, a spec's secrets: checkSandboxSecrets' entries) as the words after the nonce on
 * stdin's first line (the header's Exec env): ` NAME=<word>` each, in order, the word the value's UTF-8 bytes, each
 * printable ASCII byte but the space and the backslash as itself and every other as printf %b's `\0ooo` (three octal
 * digits), so the line holds no space, newline or backslash of the value's and EXEC_ENV_LINES gives it back byte for
 * byte, multi-line values whole. '' for none. A name that is no shell variable's, or a value with a NUL (no
 * environment variable carries one), is a SandboxError naming the variable, never quoting its value.
 */
export function execEnvWords(env: ReadonlyArray<readonly [string, string]>): string {
  let out = '';
  for (const [name, value] of env) {
    if (!EXEC_ENV_NAME_RE.test(name)) throw new SandboxError(`exec variable ${JSON.stringify(name)} is no shell variable name`);
    if (value.includes('\0')) throw new SandboxError(`exec variable ${name}'s value holds a NUL, which no environment variable carries`);
    let word = '';
    for (const b of Buffer.from(value, 'utf8')) word += ENV_WORD_PLAIN(b) ? String.fromCharCode(b) : `\\0${b.toString(8).padStart(3, '0')}`;
    out += ` ${name}=${word}`;
  }
  return out;
}

/**
 * The exec's shell script (the header): `sh <pids> <argv...>` after `-c`, the nonce on stdin's first line.
 * A wrapper that cannot cap processes exits without the start line or the sentinel, which is the driver's failure.
 */
export const EXEC_WRAPPER = [
  'trap : TERM',
  ...EXEC_NONCE_LINES,
  'exec 3>&2 2>/dev/null',
  ...EXEC_CLAIM_LINES,
  `unset ${KUBERNETES_ENV.join(' ')}`,
  // dash exports PWD to what it runs; docker sets none.
  'unset PWD',
  ...EXEC_ENV_LINES,
  '[ "$1" = 0 ] || ulimit -u "$1" || ulimit -p "$1" || { echo "sandbox: could not cap processes at $1" >&3; exit 125; }',
  'shift',
  'printf \'\\036%s\\n\' "$n"',
  '( exec "$@" 2>&3 3>&- )',
  's=$?',
  'kill -s KILL -- -1',
  'printf \'\\036%s%d\\n\' "$n" "$s"',
].join('\n');

/** The start line's and the sentinel's first byte (RS, octal 036 in the wrapper's printf): what output must end in for any of it to be held back. */
export const SENTINEL_MARK = '\x1e';

/** The user and group a timed pod's launcher drops the program to (the sandbox user, every other pod's). */
export const TIMED_UID = 65534;
export const TIMED_GID = 65534;
/** A timed pod's root tasks under the wrapper's process cap: PID 1, the wrapper, the launcher, and the program until it drops (the header's Timing). */
export const TIMED_ROOT_TASKS = 4;
/** The most digits a CPU reading may have (µs, below 2^63). */
export const CPU_READING_DIGITS = 19;
/** How long a timed kill() waits for the launcher's reading once it has killed the program's processes, before it cuts the exec. */
export const TIMED_KILL_MS = 15_000;
/** The prefix of a timed sandbox's clock source: `rusage-children k8s <runtime class|default> cpu-<12 hex>`. */
export const K8S_CPU_CLOCK_SOURCE = 'rusage-children k8s';

/**
 * The house's CPU launcher (the header's Timing), perl with perl-base's modules alone, run as
 * `perl -e CPU_LAUNCHER_SCRIPT -- <uid|-> <gid|-> <argv...>` with descriptor 4 its report: it makes itself the child
 * subreaper, forks argv (dropped to uid:gid with no supplementary group; `-` drops nothing, a host run's: the unit
 * tests), waits for it, SIGKILLs every live descendant (by /proc's parent links) and reaps until it has no child left,
 * then writes getrusage(RUSAGE_CHILDREN) user plus system µs and a newline on descriptor 4 and exits with the program's
 * status (128+n for a signal). A failure of its own goes to stderr as `cpu launcher: ...`, nothing on descriptor 4, and
 * exit 125. SIGTERM (terminate()'s) is the program's: the launcher catches it and goes on. The syscalls are raw, so
 * their numbers are named per machine (x86_64, aarch64: the pinned images' two).
 */
export const CPU_LAUNCHER_SCRIPT = [
  'use strict;',
  'use warnings;',
  'use POSIX ();',
  'use Fcntl ();',
  '$SIG{TERM} = sub {};',
  'sub fail { print STDERR "cpu launcher: $_[0]\\n"; exit 125 }',
  'my ($uid, $gid, @argv) = @ARGV;',
  "fail('usage: perl -e <launcher> -- <uid|-> <gid|-> <argv...>') unless defined $gid && @argv;",
  "open(my $report, '>&=', 4) or fail(\"no report descriptor 4: $!\");",
  'my $fl = fcntl($report, Fcntl::F_GETFD(), 0);',
  '(defined $fl && fcntl($report, Fcntl::F_SETFD(), $fl | Fcntl::FD_CLOEXEC())) or fail("descriptor 4: $!");',
  'my $machine = (POSIX::uname())[4];',
  'my %NR = (x86_64 => [157, 98], aarch64 => [167, 165]);',
  'my $nr = $NR{$machine} or fail("no syscall numbers for $machine");',
  'syscall($nr->[0], 36, 1, 0, 0, 0) == 0 or fail("prctl(PR_SET_CHILD_SUBREAPER): $!");',
  'pipe(my $er, my $ew) or fail("pipe: $!");',
  'my $pid = fork();',
  'defined $pid or fail("fork: $!");',
  'if ($pid == 0) {',
  '  close $er;',
  '  my $why = sub { syswrite($ew, $_[0]); POSIX::_exit(125) };',
  "  if ($uid ne '-') {",
  '    $) = "$gid $gid";',
  '    POSIX::setgid($gid) or $why->("setgid($gid): $!");',
  '    POSIX::setuid($uid) or $why->("setuid($uid): $!");',
  '    $why->("the program is not $uid:$gid alone") unless POSIX::getuid() == $uid && POSIX::geteuid() == $uid && POSIX::getgid() == $gid && POSIX::getegid() == $gid && $) eq "$gid $gid";',
  '  }',
  "  { no warnings 'exec'; exec { $argv[0] } @argv; }",
  '  $why->("exec $argv[0]: $!");',
  '}',
  'close $ew;',
  "my $said = '';",
  'for (;;) { my $n = sysread($er, my $b, 4096); if (!defined $n) { next if $!{EINTR}; last } last if $n == 0; $said .= $b }',
  'close $er;',
  "if ($said ne '') { waitpid($pid, 0); fail($said) }",
  'waitpid($pid, 0) == $pid or fail("waitpid: $!");',
  'my $status = $?;',
  'sub descendants {',
  '  my %kids;',
  "  opendir(my $d, '/proc') or fail(\"/proc: $!\");",
  '  for my $p (readdir $d) {',
  '    next unless $p =~ /^[0-9]+$/;',
  "    open(my $f, '<', \"/proc/$p/stat\") or next;",
  '    my $s = <$f>;',
  '    close $f;',
  '    next unless defined $s;',
  "    my $at = rindex($s, ')');",
  '    next if $at < 0;',
  "    my ($state, $ppid) = (split ' ', substr($s, $at + 1))[0, 1];",
  '    next unless defined $ppid;',
  '    push @{ $kids{$ppid} }, [$p, $state];',
  '  }',
  '  closedir $d;',
  '  my @live;',
  '  my @todo = ($$);',
  '  while (@todo) {',
  '    my $q = shift @todo;',
  '    for my $k (@{ $kids{$q} || [] }) {',
  '      push @todo, $k->[0];',
  "      push @live, $k->[0] unless $k->[1] eq 'Z' || $k->[1] eq 'X';",
  '    }',
  '  }',
  '  return @live;',
  '}',
  'my $done = 0;',
  'for (1 .. 400) {',
  '  my @live = descendants();',
  "  kill 'KILL', @live if @live;",
  '  my $w;',
  '  do { $w = waitpid(-1, POSIX::WNOHANG()) } while $w > 0;',
  '  if ($w < 0) { fail("waitpid: $!") unless $!{ECHILD}; $done = 1; last }',
  '  select(undef, undef, undef, 0.005);',
  '}',
  "fail('the program left processes that would not die') unless $done;",
  'my $ru = "\\0" x 144;',
  'syscall($nr->[1], -1, $ru) == 0 or fail("getrusage(RUSAGE_CHILDREN): $!");',
  "my ($us, $uu, $ss, $su) = unpack('q4', $ru);",
  'syswrite($report, (($us + $ss) * 1000000 + $uu + $su) . "\\n") or fail("descriptor 4: $!");',
  'close $report;',
  'exit(POSIX::WIFEXITED($status) ? POSIX::WEXITSTATUS($status) : 128 + POSIX::WTERMSIG($status));',
].join('\n');

/** The argv a timed pod's wrapper runs for `program`: the CPU launcher, dropping it to TIMED_UID:TIMED_GID. */
export function cpuLauncherArgv(program: readonly string[]): string[] {
  return ['perl', '-e', CPU_LAUNCHER_SCRIPT, '--', String(TIMED_UID), String(TIMED_GID), ...program];
}

/**
 * A timed pod's exec script (the header's Timing): EXEC_WRAPPER, but the program, its argv the CPU launcher's
 * (cpuLauncherArgv), runs in a command substitution holding descriptor 4, its stdout and stderr the real ones, and the
 * launcher's reading, digits alone, is printed as `RS<nonce>c<µs>\n` after everything is killed and before the sentinel.
 */
export const TIMED_EXEC_WRAPPER = [
  'trap : TERM',
  ...EXEC_NONCE_LINES,
  'exec 3>&2 2>/dev/null',
  ...EXEC_CLAIM_LINES,
  `unset ${KUBERNETES_ENV.join(' ')}`,
  'unset PWD',
  ...EXEC_ENV_LINES,
  '[ "$1" = 0 ] || ulimit -u "$1" || ulimit -p "$1" || { echo "sandbox: could not cap processes at $1" >&3; exit 125; }',
  'shift',
  'printf \'\\036%s\\n\' "$n"',
  'exec 5>&1',
  'c=$(exec "$@" 4>&1 1>&5 5>&- 2>&3 3>&-)',
  's=$?',
  'kill -s KILL -- -1',
  'case $c in \'\'|*[!0-9]*) ;; *) printf \'\\036%sc%s\\n\' "$n" "$c" ;; esac',
  'printf \'\\036%s%d\\n\' "$n" "$s"',
].join('\n');

/** The letter after RS and the nonce that marks a session wrapper's launcher report line (TIMED_EXEC_WRAPPER's is `c`). */
export const SESSION_REPORT_TAG = 'i';
/** The longest launcher report word SentinelScanner takes (lower-case letters): a longer line is no report. */
export const SESSION_REPORT_MAX = 16;

/**
 * A session case's exec script (the header's Case sessions; k8s-session.ts's header): `sh <pids> <the case launcher's
 * argv...>` after `-c`, the nonce on stdin's first line. TIMED_EXEC_WRAPPER's lines, but the launcher's report, a word of
 * lower-case letters alone, is printed as `RS<nonce>i<word>\n` after everything is killed and before the sentinel; a
 * launcher that reported nothing gets no line. Defined here beside the wrapper's reader (SentinelScanner); k8s-session.ts
 * re-exports it.
 */
export const SESSION_EXEC_WRAPPER = [
  'trap : TERM',
  ...EXEC_NONCE_LINES,
  'exec 3>&2 2>/dev/null',
  ...EXEC_CLAIM_LINES,
  `unset ${KUBERNETES_ENV.join(' ')}`,
  'unset PWD',
  ...EXEC_ENV_LINES,
  '[ "$1" = 0 ] || ulimit -u "$1" || ulimit -p "$1" || { echo "sandbox: could not cap processes at $1" >&3; exit 125; }',
  'shift',
  'printf \'\\036%s\\n\' "$n"',
  'exec 5>&1',
  'c=$(exec "$@" 4>&1 1>&5 5>&- 2>&3 3>&-)',
  's=$?',
  'kill -s KILL -- -1',
  `case $c in ''|*[!a-z]*) ;; *) printf '\\036%s${SESSION_REPORT_TAG}%s\\n' "$n" "$c" ;; esac`,
  'printf \'\\036%s%d\\n\' "$n" "$s"',
].join('\n');

/**
 * A timed kill's first step (the header's Timing), exec'd in the pod as its root: drop to the program's user and
 * SIGKILL every process of it (kill -1 spares the caller), every 50 ms for 5 s, so one the launcher had yet to fork
 * dies too; the launcher, root, reaps them and reports. The wrapper's own `kill -1` ends it once the launcher has.
 */
export const TIMED_KILL_ARGV: readonly string[] = Object.freeze([
  'perl',
  '-e',
  [
    'use POSIX ();',
    'my ($uid, $gid) = @ARGV;',
    '$) = "$gid $gid";',
    'POSIX::setgid($gid) or exit 1;',
    'POSIX::setuid($uid) or exit 1;',
    'exit 1 unless POSIX::getuid() == $uid && POSIX::geteuid() == $uid;',
    "for (1 .. 100) { kill 'KILL', -1; select(undef, undef, undef, 0.05) }",
  ].join('\n'),
  '--',
  String(TIMED_UID),
  String(TIMED_GID),
]);

/**
 * The policy wait (POLICY_WAIT_MS) in an entry's own interpreter, argv: ms, then host and port per peer.
 * Each peer is dialled until it takes a connection (250 ms an attempt, 20 ms apart; a refusal is what an
 * unprogrammed policy gives); exit 0 once all did, else exit 1 at the deadline with one line, `host:port why`.
 */
export const POLICY_WAIT_ARGV: Readonly<Record<Runtime, readonly string[]>> = Object.freeze({
  node22: Object.freeze([
    'node',
    '-e',
    [
      "const net = require('node:net');",
      'const [ms, ...rest] = process.argv.slice(1);',
      'const deadline = Date.now() + Number(ms);',
      'const once = (host, port) => new Promise((done) => {',
      '  const s = net.connect({ host, port });',
      "  const timer = setTimeout(() => { s.destroy(); done('TIMEOUT'); }, 250);",
      "  s.once('connect', () => { clearTimeout(timer); s.destroy(); done(null); });",
      "  s.once('error', (e) => { clearTimeout(timer); done(e.code || e.message); });",
      '});',
      '(async () => {',
      '  for (let i = 0; i + 1 < rest.length; i += 2) {',
      '    const host = rest[i];',
      '    const port = Number(rest[i + 1]);',
      '    for (;;) {',
      '      const failed = await once(host, port);',
      '      if (failed === null) break;',
      '      if (Date.now() >= deadline) { process.stdout.write(`${host}:${port} ${failed}\\n`); process.exit(1); }',
      '      await new Promise((r) => setTimeout(r, 20));',
      '    }',
      '  }',
      '})();',
    ].join('\n'),
  ]),
  'python3.13': Object.freeze([
    'python3',
    '-c',
    [
      'import socket, sys, time',
      'ms, rest = int(sys.argv[1]), sys.argv[2:]',
      'deadline = time.monotonic() + ms / 1000',
      'for i in range(0, len(rest) - 1, 2):',
      '    host, port = rest[i], int(rest[i + 1])',
      '    while True:',
      '        try:',
      '            socket.create_connection((host, port), 0.25).close()',
      '            break',
      '        except OSError as e:',
      '            if time.monotonic() >= deadline:',
      "                print(f'{host}:{port} {type(e).__name__}: {e}')",
      '                sys.exit(1)',
      '            time.sleep(0.02)',
    ].join('\n'),
  ]),
});

/** What the bind proof prints when its bind was refused with EADDRINUSE (and exits 0): the one answer that passes it. */
export const BIND_PROOF_REFUSED = 'refused';
/**
 * What it prints when a bind succeeded (and exits 1), then a space and the option it was bound with (one of
 * BIND_PROOF_OPTIONS): the member could stand in for the one that serves the port.
 */
export const BIND_PROOF_BOUND = 'bound';
/** The socket options the bind proof tries, in its order, each its own socket: as it names them when one binds. */
export const BIND_PROOF_OPTIONS: readonly string[] = Object.freeze(['SO_REUSEADDR', 'SO_REUSEPORT', 'SO_REUSEADDR+SO_REUSEPORT']);

/**
 * The bind proof (the header's One pod), argv, then the address and the port: perl (perl-base, in every image the table
 * pins), from inside a member's own container, binds a TCP socket to the address and port three times, each a fresh
 * socket: with SO_REUSEADDR set (what node and Python's servers set, probe c2n), with SO_REUSEPORT set (gVisor lets
 * another uid join an env listener's SO_REUSEPORT group and take its connections, deploy/k8s/README.md P5), and with
 * both. Every one refused with EADDRINUSE: prints BIND_PROOF_REFUSED and exits 0. Any one bound: prints
 * `BIND_PROOF_BOUND <option>` (BIND_PROOF_OPTIONS) and exits 1 at once (the socket closes as it exits). Anything else
 * (no socket, no SO_REUSEPORT, another errno): one line saying what, and exit 2.
 */
export const BIND_PROOF_ARGV: readonly string[] = Object.freeze([
  'perl',
  '-e',
  [
    'use strict;',
    'use warnings;',
    'use Socket qw(PF_INET SOCK_STREAM SOL_SOCKET SO_REUSEADDR inet_aton pack_sockaddr_in);',
    'use Errno ();',
    'my ($host, $port) = @ARGV;',
    'defined $port && $port =~ /^[0-9]+$/ or do { print "usage: <address> <port>\\n"; exit 2 };',
    'my $addr = inet_aton($host) or do { print "no address $host\\n"; exit 2 };',
    'my $rp = eval { Socket::SO_REUSEPORT() };',
    'defined $rp or do { print "no SO_REUSEPORT here\\n"; exit 2 };',
    `for my $try (['${BIND_PROOF_OPTIONS[0]}', SO_REUSEADDR], ['${BIND_PROOF_OPTIONS[1]}', $rp], ['${BIND_PROOF_OPTIONS[2]}', SO_REUSEADDR, $rp]) {`,
    '  my ($name, @opts) = @$try;',
    '  socket(my $s, PF_INET, SOCK_STREAM, 0) or do { print "socket: $!\\n"; exit 2 };',
    "  for my $o (@opts) { setsockopt($s, SOL_SOCKET, $o, pack('i', 1)) or do { print \"setsockopt $name: $!\\n\"; exit 2 } }",
    `  if (bind($s, pack_sockaddr_in($port, $addr))) { print "${BIND_PROOF_BOUND} $name\\n"; exit 1 }`,
    '  $!{EADDRINUSE} or do { print "bind $name: $!\\n"; exit 2 };',
    '  close($s);',
    '}',
    `print "${BIND_PROOF_REFUSED}\\n";`,
    'exit 0;',
  ].join('\n'),
  '--',
]);

const [GRADER_LABEL_KEY, GRADER_LABEL_VALUE] = CONTAINER_LABEL.split('=') as [string, string];
const [EGRESS_LABEL_KEY, EGRESS_LABEL_VALUE] = EGRESS_LABEL.split('=') as [string, string];
const TMP_VOLUME = 'tmp';
const SHM_VOLUME = 'shm';
const NOBODY_ID = 65534;
const NDOTS_0 = Object.freeze({ name: 'ndots', value: '0' });
/**
 * A waiting container's reasons that never end in Ready: the pod is failed at once, not after READY_TIMEOUT_MS. A pull
 * that failed (ErrImagePull, then ImagePullBackOff: a digest the registry does not hold, or a pull Secret it refuses) is
 * one: the kubelet's back-off is no grade's to wait out. Not CreateContainerConfigError: the env Secret is made before
 * its pod (the header), so the kubelet meets it at once; a pod still waiting in it is left to its ready budget, as before.
 */
const NEVER_READY = new Set(['InvalidImageName', 'ErrImagePull', 'ImagePullBackOff', 'CreateContainerError', 'RunContainerError', 'CrashLoopBackOff']);
const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const LABEL_KEY_RE = /^(?:[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE_RE = /^(?:[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
/** After RS and the nonce: a timed wrapper's CPU line whole (`c<µs>\n`), and one cut short at the end of what came. */
const CPU_LINE_RE = new RegExp(`^c([0-9]{1,${CPU_READING_DIGITS}})\\n`);
const CPU_LINE_SO_FAR_RE = new RegExp(`^c[0-9]{0,${CPU_READING_DIGITS}}$`);
/** After RS and the nonce: a session wrapper's launcher report whole (`i<word>\n`), and one cut short at the end of what came. */
const REPORT_LINE_RE = new RegExp(`^${SESSION_REPORT_TAG}([a-z]{1,${SESSION_REPORT_MAX}})\\n`);
const REPORT_SO_FAR_RE = new RegExp(`^${SESSION_REPORT_TAG}[a-z]{0,${SESSION_REPORT_MAX}}$`);
/** After RS and the nonce, before the start line: a refused wrapper's line whole (the once-guard). */
const CLAIMED_LINE = `${EXEC_CLAIMED}\n`;
const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An image as a pod runs it: `<repository>@sha256:<64 hex>` (images.ts imageRef), never a tag. */
export const IMAGE_REF_RE = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/;
const EMPTY = Buffer.alloc(0);

// ---------------------------------------------------------------- kubectl

/** One kubectl call's outcome. `error` is set when it could not run or was cut off. */
export interface KubectlResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface KubectlCallOptions {
  /** Its stdin (none: closed at once). */
  input?: string;
  /** Cut it off (SIGKILL) when this aborts. */
  signal?: AbortSignal;
  /** Its budget (default the KubectlExec's). */
  timeoutMs?: number;
  /**
   * kubectl() only, never handed to the KubectlExec: the pace slot the caller already holds for it (the call runs at once
   * and tells the slot how it went), so a step of several calls waits once.
   */
  slot?: PaceSlot;
  /** kubectl() only: false runs a `create` unpaced, its faults still seen (every other verb runs unpaced always). */
  paced?: false;
}

/** Runs kubectl with an argv (no leading `kubectl`), to its end. */
export type KubectlExec = (args: readonly string[], opts?: KubectlCallOptions) => Promise<KubectlResult>;

/** How a streamed exec (over a pod's agent: agent-client.ts AgentSession.stream) ended: `error` when it never started. */
export interface KubectlEnd {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

/** A streamed exec (over a pod's agent): its stdio, its end (after its stdout and stderr ended), and a SIGKILL. */
export interface KubectlChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly closed: Promise<KubectlEnd>;
  kill(): void;
  /** When its process itself exited (Date.now()), null before; its stdio may close later. Absent on a stand-in that cannot tell. */
  exitedAt?(): number | null;
}

/**
 * An exec stream started by an argv in kubectl's exec shape (`exec -i <pod> -c <container> -- argv`): no driver path
 * takes one, as grading execs nothing over kubectl (tests/unit/sandbox-no-kubectl-exec.test.ts). A stand-in cluster's
 * shape alone: a test's fake answers its fake agents' execs through one (tests/helpers/k8s-agent-dial.ts fakeAgentHub).
 */
export type KubectlStream = (args: readonly string[]) => KubectlChild;

const KUBECTL_ENV = ['PATH', 'KUBERNETES_SERVICE_HOST', 'KUBERNETES_SERVICE_PORT', 'KUBECONFIG'] as const;

/**
 * What kubectl itself needs (docker.ts dockerCliEnv's twin): PATH, the API server's in-cluster address
 * (its token and CA are the mounted service account's), KUBECONFIG when one is named (a run from outside
 * the cluster), and HOME=/tmp for its cache. None of it reaches a pod.
 *
 * Under node's test runner (NODE_TEST_CONTEXT, in `env` or this process's) a KUBECONFIG any of whose entries is the
 * user's own ~/.kube/config is replaced by testNoKubeconfig(), a file that does not exist, so no test hands kubectl the
 * real cluster credentials (on this Mac, contexts a test must never reach) and kubectl reads no kubeconfig at all: not
 * the user's, and not the HOME fallback (/tmp/.kube/config) an unset KUBECONFIG would leave it. Outside a test the
 * KUBECONFIG passes as it is.
 */
export function kubectlEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { HOME: '/tmp' };
  for (const k of KUBECTL_ENV) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  if (out.KUBECONFIG !== undefined && (env.NODE_TEST_CONTEXT ?? process.env.NODE_TEST_CONTEXT) !== undefined && namesUserKubeconfig(out.KUBECONFIG)) {
    out.KUBECONFIG = testNoKubeconfig();
  }
  return out;
}

/**
 * The environment the in-process API client reads its credentials from (k8s-count.ts processApiTarget, by way of
 * inClusterApiObjects, processApiWatch, inClusterApiPatch and inClusterApiCreate): this process's, its KUBECONFIG the one
 * kubectlEnv hands kubectl, so under node's test runner a KUBECONFIG naming the user's own ~/.kube/config is never read
 * for a token, as kubectl never reads it there.
 */
export function apiClientEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  const kubeconfig = kubectlEnv(env).KUBECONFIG;
  if (kubeconfig === undefined) delete out.KUBECONFIG;
  else out.KUBECONFIG = kubeconfig;
  return out;
}

/** The KUBECONFIG kubectlEnv names in a test in place of the user's: under the temp dir, this process's own, never made. */
export function testNoKubeconfig(): string {
  return join(tmpdir(), `makefun-kubectl-no-kubeconfig-${process.pid}`);
}

/** The one path a path names, its symlinks followed where it exists (the path resolved as it is where it does not). */
function realPathOf(p: string): string {
  const abs = resolvePath(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Whether a KUBECONFIG list (entries split as kubectl splits them, empty ones skipped) names the user's own
 * ~/.kube/config: under $HOME, or under the account's home from the user database, where a test moved HOME elsewhere.
 */
export function namesUserKubeconfig(kubeconfig: string): boolean {
  const homes = [homedir()];
  try {
    homes.push(userInfo().homedir);
  } catch {
    // no user-database entry for this uid (a container's arbitrary uid): $HOME is the one home
  }
  const real = new Set(homes.filter((h) => h !== '').map((h) => realPathOf(posix.join(h, '.kube', 'config'))));
  return kubeconfig
    .split(pathDelimiter)
    .filter((entry) => entry !== '')
    .some((entry) => real.has(realPathOf(entry)));
}

/**
 * kubectl as a KubectlExec: kubectlEnv only, its input on stdin, SIGKILLed after `timeoutMs` or on abort; a budget that
 * fires past a stall of this process's main thread (KUBECTL_STALL_LATE_MS late) gives it KUBECTL_STALL_GRACE_MS more
 * first, so an answer that waited unread in the pipe is read, not cut, and a kubectl that exited is never cut by it.
 * Spawned by kubectl-broker.ts spawnPiped: from the kubectl broker where MAKEFUN_KUBECTL_BROKER=1 (the grader), else
 * here; a call whose broker went while its kubectl ran ends with that on its `error`.
 */
export function kubectlExec(kubectl = 'kubectl', timeoutMs = KUBECTL_TIMEOUT_MS): KubectlExec {
  return (args, opts = {}) =>
    new Promise<KubectlResult>((resolve) => {
      const child = spawnPiped(kubectl, args, kubectlEnv());
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.stderr.on('data', (b: Buffer) => err.push(b));
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input ?? '');
      const limit = opts.timeoutMs ?? timeoutMs;
      let cut: string | null = null;
      let exited = false;
      const stop = (why: string): void => {
        cut ??= why;
        child.kill('SIGKILL');
      };
      // The budget, read on the monotonic clock (performance.now) for how late it fired: within KUBECTL_STALL_LATE_MS it
      // is kubectl's silence, the cut; later, this process's main thread was held, so kubectl's answer may sit unread in
      // the pipe (libuv runs a turn's expired timers before its poll): it gets KUBECTL_STALL_GRACE_MS more with the loop
      // running, and a call whose exit came meanwhile is never cut.
      let timer: NodeJS.Timeout;
      const arm = (ms: number): void => {
        const due = performance.now() + ms;
        timer = setTimeout(() => {
          if (exited) return;
          if (performance.now() - due > KUBECTL_STALL_LATE_MS) arm(KUBECTL_STALL_GRACE_MS);
          else stop(`no answer within ${limit} ms`);
        }, ms);
        timer.unref();
      };
      arm(limit);
      const onAbort = (): void => stop('cut off');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted === true) onAbort();
      const settle = (res: KubectlResult): void => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(res);
      };
      child.once('error', (e) => {
        // An 'error' with a pid is a kill or a write that failed: the close still comes.
        if (child.pid === undefined) settle({ code: null, stdout: '', stderr: '', error: `kubectl: ${e.message}` });
      });
      child.once('exit', () => {
        // kubectl answered: its budget no longer cuts it. A fixed grace from the exit (STDIO_GRACE_MS) closes what
        // still holds its stdio: stdout and stderr are read eagerly into `out` and `err`, so nothing of theirs waits for
        // a reader when it fires.
        exited = true;
        const grace = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, STDIO_GRACE_MS);
        grace.unref();
        child.once('close', () => clearTimeout(grace));
      });
      child.once('close', (code: number | null) => {
        const res: KubectlResult = { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
        if (cut === null && child.lost != null) res.error = `kubectl ${args.filter((a) => !a.startsWith('-')).slice(1, 3).join(' ')}: ${child.lost}`;
        if (cut !== null) {
          // What kubectl last said before the cut (client-go's retries of a 429 are silent; a discovery read it could
          // not make is a logged line naming the API server's answer), so the fault says more than the budget.
          const said = lastSaid(res.stderr);
          res.error = `kubectl ${args.filter((a) => !a.startsWith('-')).slice(1, 3).join(' ')}: ${cut}${said === null ? '' : ` (kubectl said: ${said})`}`;
        }
        settle(res);
      });
    });
}

/**
 * The process's own KubectlExec: the API server asked in-process where this process can ask it (k8s-count.ts apiExec
 * over inClusterApiObjects: its pod's service account, else a burst grader's kubeconfig token), each call it cannot
 * answer or ask handed to kubectlExec(kubectl); kubectlExec alone anywhere else. What a caller with no exec of its own
 * runs (server/pipeline/pod-room.ts, server/ops/address-sweep.ts); `warn` hears a fall back to kubectl, once until it changes.
 */
export function processKubectlExec(warn: (line: string) => void, kubectl = 'kubectl', timeoutMs = KUBECTL_TIMEOUT_MS, env: NodeJS.ProcessEnv = process.env): KubectlExec {
  const cli = kubectlExec(kubectl, timeoutMs);
  const objects = inClusterApiObjects(apiClientEnv(env));
  return objects === null ? cli : apiExec(objects, cli, { timeoutMs, warn });
}

/** The last line of `stderr` that is not a warning (Pod Security's), at most 300 characters; null when none. */
function lastSaid(stderr: string): string | null {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('Warning:'))
    .at(-1);
  return line === undefined ? null : line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** What a failed call said: the first line of its stderr that is not a warning (Pod Security's), else why it ended. */
export function why(r: KubectlResult): string {
  const said = r.stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('Warning:'));
  return r.error ?? said ?? (r.code === null ? 'no answer' : `exit ${r.code}`);
}

// ---------------------------------------------------------------- the pace

/**
 * What a start waits for its slot as (the header's pace): a pod's `create`, the one kind, as grading execs nothing over
 * kubectl (every exec rides its pod's agent and holds no slot).
 */
export type PaceKind = 'create';

/**
 * One start's place in the pace (SandboxPace.acquire). Tell it how the start went, then release it: `ok` a clean start,
 * `failed` with what kubectl itself said (a fault paceFaultOf names cuts the pace at once, anything else is neutral;
 * never a failure's message that quotes what a stream carried), `fault` a fault
 * the caller names itself. Only its first fault counts; release is idempotent, and a slot released with no `ok` and no
 * fault grows nothing.
 */
export interface PaceSlot {
  ok(): void;
  failed(said: string): void;
  fault(reason: SandboxPaceFault, retryAfterMs?: number | null): void;
  /** `ok` for a call that exited 0 with no cut, else `failed` with its stderr and its cut. */
  note(r: KubectlResult): void;
  release(): void;
}

/** The slot of a context with no pace: everything a no-op. */
const NO_PACE_SLOT: PaceSlot = Object.freeze({ ok: () => undefined, failed: () => undefined, fault: () => undefined, note: () => undefined, release: () => undefined });

/** What a call said, for paceFaultOf: its stderr and its cut, if any. */
function saidOf(r: KubectlResult): string {
  return r.error === undefined ? r.stderr : `${r.stderr}\n${r.error}`;
}

export interface SandboxPaceOptions {
  /** Its width: the limit it starts at and grows back to (sandboxPaceOf holds it to 1..MAX_SANDBOX_PACE_WIDTH). */
  width: number;
  /**
   * Whether its width follows its process's pod budget as capacity reads move it (SandboxPace.followPodBudget; default
   * true). processSandboxPace passes paceFollowsBudgetOf: true on the burst grader alone, false on a home grader (kept at
   * its boot width) and for a width the operator named (MAKEFUN_K8S_SANDBOX_PACE_WIDTH), kept as named.
   */
  followsBudget?: boolean;
  /** Where a move of its limit is said (default console.warn). */
  warn?: (line: string) => void;
  /** Its clock (default Date.now). */
  now?: () => number;
  /** How often, at most, it says the faults it took (default PACE_FAULT_LINE_EVERY_MS). */
  faultLineEveryMs?: number;
}

/** How often a pace already at its floor says it is still cut (its backoffs count every one). */
const PACE_FLOOR_WARN_EVERY_MS = 60_000;

/** How often, at most, a pace says the faults it held on since its last such line (the header's pace). */
export const PACE_FAULT_LINE_EVERY_MS = 60_000;

/** `counts`' non-zero reasons as `reason n`, comma-joined; `none` with none. */
function faultCounts(counts: Record<SandboxPaceFault, number>): string {
  const said = SANDBOX_PACE_FAULTS.filter((f) => counts[f] > 0).map((f) => `${f} ${counts[f]}`);
  return said.length === 0 ? 'none' : said.join(', ');
}

/** A fresh count of each fault, at 0. */
function noFaults(): Record<SandboxPaceFault, number> {
  return Object.fromEntries(SANDBOX_PACE_FAULTS.map((f) => [f, 0])) as Record<SandboxPaceFault, number>;
}

/**
 * The AIMD pace of a process's pod creates (the header's pace): at most `limit` starts in flight, the rest waiting FIFO.
 * The limit moves by capacity.ts's paceAfterFault and paceAfterClean; a cut that names a Retry-After holds every new start until it has passed (once a cut). A waiter whose
 * signal aborts leaves the queue with no slot.
 */
export class SandboxPace {
  #state: SandboxPaceState;
  #inFlight = 0;
  readonly #waiting: Array<(slot: PaceSlot) => void> = [];
  #holdUntil = 0;
  #holdTimer: NodeJS.Timeout | null = null;
  #floorWarnedAt = Number.NEGATIVE_INFINITY;
  readonly #warn: (line: string) => void;
  readonly #now: () => number;
  readonly #faultLineEveryMs: number;
  /** Whether followPodBudget moves its width (SandboxPaceOptions.followsBudget). */
  readonly #followsBudget: boolean;
  /** The faults since its last fault line (#sayFaults): those that held it, from `since`. */
  #faults: { since: number; held: Record<SandboxPaceFault, number> } | null = null;
  #faultLineAt = Number.NEGATIVE_INFINITY;
  #faultLineTimer: NodeJS.Timeout | null = null;
  /** The cuts it took, by reason: makefun_k8s_sandbox_pace_backoffs_total. */
  readonly backoffs: Record<SandboxPaceFault, number> = noFaults();
  /** Told of every cut, after `backoffs` counts it (registerPaceMetrics' counter). */
  onBackoff: ((reason: SandboxPaceFault) => void) | null = null;

  constructor(opts: SandboxPaceOptions) {
    this.#state = sandboxPaceOf(opts.width);
    this.#warn = opts.warn ?? ((line) => console.warn(line));
    this.#now = opts.now ?? Date.now;
    this.#faultLineEveryMs = opts.faultLineEveryMs ?? PACE_FAULT_LINE_EVERY_MS;
    this.#followsBudget = opts.followsBudget ?? true;
  }

  get width(): number {
    return this.#state.width;
  }

  /**
   * Follow its process's pod budget, which a capacity read moves (server/jobs.ts reconcileCapacity, beside the sandbox
   * pool's resize): the width becomes the budget, held to 1..MAX_SANDBOX_PACE_WIDTH, by capacity.ts paceAtWidth (an
   * uncut pace moves with it; a cut one keeps its limit, so a raise never lifts it past a live cut, and regrows to the
   * new width as ever). A move is said, and a raise lets the waiters it makes room for through at once. A pace that
   * follows no budget (SandboxPaceOptions.followsBudget false: a home grader's, or a width the operator named) keeps its
   * width. Whether the width moved.
   */
  followPodBudget(podBudget: number): boolean {
    if (!this.#followsBudget) return false;
    const was = this.#state;
    const next = paceAtWidth(was, podBudget);
    if (next === was) return false;
    this.#state = next;
    const cut = next.limit < next.width ? `, its limit held at ${next.limit} under its cut` : '';
    this.#warn(`k8s sandbox: the pod budget is ${podBudget}, so the sandbox pace's width ${was.width} -> ${next.width} pod creates at once${cut}; ${this.#inFlight} in flight, ${this.waiting} waiting`);
    this.#pump();
    return true;
  }

  /** How many starts may be in flight now. */
  get limit(): number {
    return this.#state.limit;
  }

  /** Its cuts so far: what a start's fault is judged against (paceAfterFault). */
  get epoch(): number {
    return this.#state.epoch;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  /** Starts waiting for a slot. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /** A slot for a start of `_kind` (a create), once one is free (and no Retry-After holds); null when `signal` aborts first. */
  acquire(_kind: PaceKind, signal?: AbortSignal): Promise<PaceSlot | null> {
    if (signal?.aborted === true) return Promise.resolve(null);
    return new Promise<PaceSlot | null>((resolve) => {
      const queue = this.#waiting;
      const grant = (slot: PaceSlot): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(slot);
      };
      const onAbort = (): void => {
        const i = queue.indexOf(grant);
        if (i < 0) return;
        queue.splice(i, 1);
        resolve(null);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(grant);
      this.#pump();
    });
  }

  /** A call run outside any slot (any verb), let through at epoch `startedAt`: a fault it names cuts the pace all the same. */
  observe(r: KubectlResult, startedAt: number): void {
    if (r.code === 0 && r.error === undefined) return;
    const said = saidOf(r);
    const fault = paceFaultOf(said);
    if (fault !== null) this.#cut(fault, startedAt, retryAfterMsOf(said));
  }

  #slot(): PaceSlot {
    const startedAt = this.#state.epoch;
    let outcome: 'pending' | 'ok' | 'neutral' | 'fault' = 'pending';
    let released = false;
    const fault = (reason: SandboxPaceFault, retryAfterMs: number | null = null): void => {
      if (outcome === 'fault') return;
      outcome = 'fault';
      this.#cut(reason, startedAt, retryAfterMs);
    };
    const failed = (said: string): void => {
      const reason = paceFaultOf(said);
      if (reason !== null) fault(reason, retryAfterMsOf(said));
      else if (outcome !== 'fault') outcome = 'neutral';
    };
    return {
      ok: () => {
        if (outcome === 'pending') outcome = 'ok';
      },
      failed,
      fault,
      note: (r) => {
        if (r.code === 0 && r.error === undefined) {
          if (outcome === 'pending') outcome = 'ok';
        } else failed(saidOf(r));
      },
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight--;
        if (outcome === 'ok') this.#grow();
        this.#pump();
      },
    };
  }

  #cut(reason: SandboxPaceFault, startedAt: number, retryAfterMs: number | null): void {
    const was = this.#state;
    const next = paceAfterFault(was, startedAt);
    this.#faults ??= { since: this.#now(), held: noFaults() };
    this.#faults.held[reason]++;
    if (next === null) {
      // A burst's later fault cuts nothing more: it is said all the same.
      this.#sayFaults();
      return;
    }
    this.#state = next;
    this.backoffs[reason]++;
    this.onBackoff?.(reason);
    const hold = retryAfterMs !== null && retryAfterMs > 0 ? Math.min(retryAfterMs, SANDBOX_PACE_MAX_HOLD_MS) : 0;
    if (hold > 0) this.#holdUntil = Math.max(this.#holdUntil, this.#now() + hold);
    const held = hold > 0 ? `, every new start held ${hold} ms for its Retry-After` : '';
    if (next.limit < was.limit) {
      this.#warn(
        `k8s sandbox: the control plane refused a start (${reason}): the sandbox pace is cut to ${next.limit} pod creates at once of its ${next.width}${held}; ${this.#inFlight} in flight, ${this.waiting} waiting`,
      );
    } else if (this.#now() - this.#floorWarnedAt >= PACE_FLOOR_WARN_EVERY_MS) {
      this.#floorWarnedAt = this.#now();
      this.#warn(`k8s sandbox: the control plane still refuses starts (${reason}) with the sandbox pace at its floor of ${paceFloorOf(next.width)}${held}; ${this.#inFlight} in flight, ${this.waiting} waiting`);
    }
    this.#sayFaults();
    this.#pump();
  }

  /**
   * One line for the faults since the last (#faults), at most one a PACE_FAULT_LINE_EVERY_MS: at once when the last is that
   * old, else once it is (a timer that keeps no process alive), so a burst's later fault is read as well as its cut.
   */
  #sayFaults(): void {
    const faults = this.#faults;
    if (faults === null) return;
    const wait = this.#faultLineAt + this.#faultLineEveryMs - this.#now();
    if (wait > 0) {
      if (this.#faultLineTimer === null) {
        this.#faultLineTimer = setTimeout(() => {
          this.#faultLineTimer = null;
          this.#sayFaults();
        }, wait);
        this.#faultLineTimer.unref();
      }
      return;
    }
    this.#faults = null;
    this.#faultLineAt = this.#now();
    const count = (c: Record<SandboxPaceFault, number>): number => SANDBOX_PACE_FAULTS.reduce((n, f) => n + c[f], 0);
    this.#warn(
      `k8s sandbox: since ${new Date(faults.since).toISOString()} the sandbox pace held on ${count(faults.held)} control-plane faults (${faultCounts(faults.held)}); its limit is ${this.#state.limit} of ${this.#state.width}, ${this.#inFlight} in flight, ${this.waiting} waiting`,
    );
  }

  #grow(): void {
    const was = this.#state;
    this.#state = paceAfterClean(was);
    if (this.#state.limit === was.width && was.limit < was.width) this.#warn(`k8s sandbox: the sandbox pace is back to its width of ${was.width} pod creates at once`);
  }

  /** Let waiters through while there is room under the limit and no Retry-After holds, in order. */
  #pump(): void {
    const wait = this.#holdUntil - this.#now();
    if (wait > 0) {
      if (this.#holdTimer === null && this.waiting > 0) {
        this.#holdTimer = setTimeout(() => {
          this.#holdTimer = null;
          this.#pump();
        }, wait);
      }
      return;
    }
    while (this.#inFlight < this.#state.limit) {
      const grant = this.#waiting.shift();
      if (grant === undefined) return;
      this.#inFlight++;
      grant(this.#slot());
    }
  }
}

/** A slot of `ctx`'s pace for a start of `kind` (NO_PACE_SLOT with none); null when `signal` aborted while it waited. */
export function paceSlot(ctx: Pick<K8sContext, 'pace'>, kind: PaceKind, signal?: AbortSignal): Promise<PaceSlot | null> {
  const pace = ctx.pace ?? null;
  if (pace === null) return Promise.resolve(signal?.aborted === true ? null : NO_PACE_SLOT);
  return pace.acquire(kind, signal);
}

/** The process's pace (the header's): made by the first K8sSandbox that runs its own kubectl, its metrics registered then. */
let PROCESS_PACE: SandboxPace | null = null;

/**
 * Whether the pace of the process `env` describes follows the pod budget its capacity reads set
 * (SandboxPaceOptions.followsBudget), its width having come `from` where sandboxPaceWidthOf says: on the burst grader
 * alone (MAKEFUN_WORKER_QUEUES=burst, read as capacityCeilingsOf reads it: any case, trimmed), and never for a width
 * MAKEFUN_K8S_SANDBOX_PACE_WIDTH named. A home grader keeps its boot width until a measured raise (the header's pace).
 */
export function paceFollowsBudgetOf(env: Readonly<Record<string, string | undefined>>, from: SandboxPaceWidth['from']): boolean {
  return capacityCeilingsOf(env) === BURST_CAPACITY_CEILINGS && from !== 'pace';
}

/**
 * The process's one pace (PROCESS_PACE), at sandboxPaceWidthOf's width from the process environment; on the burst
 * grader that width follows the pod budget its capacity reads set (SandboxPace.followPodBudget) unless
 * MAKEFUN_K8S_SANDBOX_PACE_WIDTH named it; a home grader's stays at its boot width (paceFollowsBudgetOf).
 */
export function processSandboxPace(warn: (line: string) => void): SandboxPace {
  if (PROCESS_PACE !== null) return PROCESS_PACE;
  const width = sandboxPaceWidthOf(process.env);
  if (width.refused !== null) warn(`k8s sandbox: ${width.refused} is no whole number from 1 to the most pods a process holds: the sandbox pace's width is ${width.width} (${width.from})`);
  PROCESS_PACE = new SandboxPace({ width: width.width, followsBudget: paceFollowsBudgetOf(process.env, width.from), warn });
  void registerPaceMetrics(PROCESS_PACE, warn);
  return PROCESS_PACE;
}

/** The pace's metrics' names (the header's pace). */
export const PACE_METRICS = Object.freeze({
  limit: 'makefun_k8s_sandbox_pace_limit',
  width: 'makefun_k8s_sandbox_pace_width',
  waiting: 'makefun_k8s_sandbox_pace_waiting',
  backoffs: 'makefun_k8s_sandbox_pace_backoffs_total',
});

/**
 * Register `pace`'s metrics on the process's registry (server/ops/metrics.ts metricsRegistry): its limit, width and
 * waiting starts as gauges read at each scrape, and its cuts by reason as a counter (every reason 0 from the start, the
 * counts taken before it registered added at once). Imported here, not at the top, as k8s-count.ts does: the metrics module
 * starts collectors at import. Once a process; a failure is said and drops only the metrics.
 */
export async function registerPaceMetrics(pace: SandboxPace, warn: (line: string) => void): Promise<void> {
  try {
    const [{ metricsRegistry }, { Counter, Gauge }] = await Promise.all([import('../../server/ops/metrics.ts'), import('@prometheus-io/client')]);
    if (metricsRegistry.getSingleMetric(PACE_METRICS.limit) !== undefined) return;
    const gauge = (name: string, help: string, read: () => number): void => {
      new Gauge({
        name,
        help,
        registers: [metricsRegistry],
        collect() {
          this.set(read());
        },
      });
    };
    gauge(PACE_METRICS.limit, "The sandbox pace's limit now: the pod creates this process lets be in flight at once.", () => pace.limit);
    gauge(PACE_METRICS.width, "The sandbox pace's width: the limit it starts at and grows back to. On the burst grader it follows the process's pod budget; a home grader's stays at its boot width, as does one MAKEFUN_K8S_SANDBOX_PACE_WIDTH names.", () => pace.width);
    gauge(PACE_METRICS.waiting, 'Pod creates waiting for a slot of the sandbox pace.', () => pace.waiting);
    const backoffs = new Counter({
      name: PACE_METRICS.backoffs,
      help: "Cuts of the sandbox pace, which gates pod creates alone, by reason: shed (API server 429) and unreachable (the API server answering nothing). No exec is paced (since release 2 each goes over its pod's agent), and no exec's fault cuts it.",
      labelNames: ['reason'] as const,
      registers: [metricsRegistry],
    });
    for (const reason of SANDBOX_PACE_FAULTS) backoffs.inc({ reason }, pace.backoffs[reason]);
    pace.onBackoff = (reason) => backoffs.inc({ reason });
  } catch (err) {
    warn(`k8s sandbox: the sandbox pace's metrics could not be registered (the pace runs unmeasured): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------- the pod

/** A Kubernetes object as `kubectl create` takes it. */
export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; labels: Record<string, string>; annotations?: Record<string, string>; ownerReferences?: Array<Record<string, unknown>> };
  [field: string]: unknown;
}

/** What an object of the driver's is marked with besides its name: its labels and, with a trial owner, its annotations (ownerAnnotations). */
export interface ObjectMarks {
  labels: Record<string, string>;
  annotations?: Record<string, string>;
}

/** An object's metadata: its name and namespace, copies of its marks (no `annotations` key without any). */
function metadataOf(name: string, namespace: string, marks: ObjectMarks): K8sObject['metadata'] {
  return { name, namespace, labels: { ...marks.labels }, ...(marks.annotations === undefined ? {} : { annotations: { ...marks.annotations } }) };
}

/** One hostAliases entry: an address and the names it answers to there. */
export interface HostAlias {
  ip: string;
  hostnames: string[];
}

/** Where every sandbox pod goes and what it runs as (K8sSandboxOptions, checked). */
export interface PodPlacement {
  namespace: string;
  /** The ReadWriteOnce PVC the data root is: no sandbox pod's to mount, the lanes pod's neither since lanes protocol v2. */
  dataPvc: string;
  /** Where the worker mounts that PVC: every host path a pod is staged from or collected into lies under it. */
  dataRoot: string;
  /** The RuntimeClass (gvisor), or null for the node's default runtime. */
  runtimeClass: string | null;
  /** The account the pods run as (no token mounted). */
  serviceAccount: string;
  /** Where every sandbox pod goes, a grader's lanes pod included (k8s-lanes.ts's header: it mounts no claim). */
  nodeSelector: Readonly<Record<string, string>> | null;
  /** The pod of the process making the pods (CREATOR_ANNOTATION on each, the header's Reaping); absent or null: none. */
  creator?: string | null;
  /**
   * What a program pod's `stage` and `watch` run (the header's The pod): the agent image and the agents' peers. Every
   * program and plan pod needs it (a SandboxError without), an aux pod its image alone (preflightPodSpec); K8sSandbox's
   * placement carries it once the agent image is pinned and its peer known.
   */
  agent?: PodAgentSpec;
}

/** A program pod's agents (the header's The pod): `makefun-agent` runs as `stage` and `watch` from `image`, admitting `peers`. */
export interface PodAgentSpec {
  /** The agent image, `<image>@<digest>` (images.ts agentImage, imageRef). */
  image: string;
  /** MAKEFUN_AGENT_PEERS: the addresses the agents admit (agent-client.ts agentPeerIp: the creating grader's own pod IP, or the burst relay's). */
  peers: readonly string[];
}

/** `agent`, checked (an image ref by digest, at least one peer, each an IP), or a SandboxError naming pod `pod`. */
function checkPodAgent(agent: PodAgentSpec | undefined, pod: string): PodAgentSpec {
  if (agent === undefined) {
    throw new SandboxError(`pod ${pod}: no agent image to run its ${STAGE_CONTAINER} and ${WATCH_CONTAINER} containers (grader/images.json pins none, or the agents' peer is not known yet)`);
  }
  if (typeof agent.image !== 'string' || !IMAGE_REF_RE.test(agent.image)) throw new SandboxError(`pod ${pod}: agent image ${JSON.stringify(agent.image)} is not <image>@sha256:<64 hex>`);
  try {
    formatPeers(agent.peers);
  } catch (err) {
    throw new SandboxError(`pod ${pod}: the agents' ${(err as Error).message}`);
  }
  return agent;
}

/**
 * The env of a pod's `stage` and `watch` (the header's The pod), and of nothing else: MAKEFUN_AGENT_KEY from the pod's
 * own Secret by secretKeyRef (never a value in the spec), MAKEFUN_AGENT_PEERS the agents' peers.
 */
export function agentEnv(pod: string, agent: PodAgentSpec): Array<Record<string, unknown>> {
  return [
    { name: AGENT_KEY_ENV, valueFrom: { secretKeyRef: { name: envSecretName(pod), key: AGENT_KEY_ENV } } },
    { name: AGENT_PEERS_ENV, value: formatPeers(agent.peers) },
  ];
}

/** A program pod's own: its name, image and digest, its peers' addresses, its trial's owner. */
export interface SandboxPodOptions extends PodPlacement {
  name: string;
  image: string;
  digest: string;
  hostAliases?: readonly HostAlias[];
  owner?: string | null;
  /**
   * A timed pod's (the header's Timing): root with LAUNCHER_CAPS, for the CPU launcher, and its CPU limit its request.
   * Never with a spec's launcher.
   */
  timed?: boolean;
  /**
   * Whether a NetworkPolicy of the pod's own selects it (a forwarder's gatewayPolicy, `<pod>-llm`): only then does it
   * carry POD_LABEL (the header's Pod identities). Only a forwarder's (isForwarder) may be so; absent: false.
   */
  ownPolicy?: boolean;
  /**
   * The drawn placement of an untimed pod but a forwarder's (drawnNodePreference; the header's Room on the node): its
   * one node term (nodePreferenceAffinity: preferred, or required off the app node at its cap). Absent or null: none.
   * A timed pod's or a forwarder's is a SandboxError (a forwarder's preference is fixed, a timed pod's selector is its
   * node).
   */
  prefer?: NodePreference | null;
  /**
   * A trial agent's pod under the drawn placement (isTrialAgentSpec; K8sSandbox sets it with a share or a cap): it
   * carries TRIAL_AGENT_LABEL=true, which the app node's sandbox cap does not count (CAPPED_SANDBOX_SELECTOR); its
   * `prefer` is trialAgentPreference's. Only an untimed program pod but a forwarder's or a race's may be one. Absent: false.
   */
  trialAgent?: boolean;
  /**
   * A warm pool's pod (the header's Warm pool): its shape's key (shapeKeyOf), carried as POOL_ANNOTATION. Only an
   * untimed program pod with no network may be one. Absent: none.
   */
  pool?: string;
  /**
   * The shim pod (the header's The pod, release 2): `main`'s PID 1 the shim (shimCommand: a served pod's with
   * `--policy-port POLICY_PORT` in POLICY_LISTENER_COMMAND's place), its binary installed by `stage` into
   * AGENT_BIN_VOLUME and held read-only at AGENT_BIN_DIR, and `watch` in the pod whatever its writable mounts, taking
   * `main`'s link. Every program pod the driver makes is one (K8sSandbox #spawn, its warm pool's shapes, and a case
   * session's pod: k8s-session.ts sessionPodSpec, whose `main` is the shim as its session reaper); absent or false,
   * release 1's shape (HOLD_COMMAND, `watch` only with a writable mount), which no pod the driver makes takes any more.
   */
  shim?: boolean;
  /**
   * The house images a spec's `image` may name (the header's house image; K8sSandboxOptions.houseImages), each
   * `<repository>@sha256:<64 hex>`: a spec whose image is one runs it, labelled DESK_POD_KIND. Absent: every image spec
   * is refused `repo_image_unsupported`, as before.
   */
  houseImages?: ReadonlySet<string>;
}

/** An aux pod's own (preflight, isolation): it runs no agent, though preflight's init container runs the agent image's `version`. */
export interface AuxPodOptions extends PodPlacement {
  name: string;
  image: string;
  digest: string;
}

/** A fresh pod name for a label: makefun-sbx-<label>-<8 hex>, at most 62 characters. */
export function podName(label: string): string {
  return `${POD_PREFIX}${checkSandboxLabel(label)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Whether `host` lies below the data root (never the root itself): the containment every host path a sandbox pod is
 * staged from or collected into is held to (checkUnderDataRoot). What is not (a bundle's own trees in the image's
 * competitions/) the grader copies under it first (bundle-trees.ts, grader/worker.ts stageProgramSetup).
 */
export function underDataRoot(dataRoot: string, host: string): boolean {
  const rel = posix.relative(dataRoot, host);
  return !(rel === '' || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel));
}

/**
 * The containment alone (the header's volumes): `host` is a host path checkHostPath takes and lies below the data root,
 * else a SandboxError naming it. Every tree a sandbox pod is staged from (/bot's code dir, a launcher's house, each
 * mount's host) and every directory a collect empties and writes into is held to it, so no spec can name a tree of the
 * grader's outside the directory the grader keeps for its trials, though no sandbox pod mounts it.
 */
export function checkUnderDataRoot(dataRoot: string, host: string): void {
  checkHostPath(host);
  if (!underDataRoot(dataRoot, host)) {
    throw new SandboxError(`host path ${JSON.stringify(host)} is not under the data root ${dataRoot}, which every tree a sandbox pod is staged from or collected into lies under (MAKEFUN_K8S_DATA_ROOT)`);
  }
}

/**
 * `host`'s path inside the data PVC: checkUnderDataRoot, then that path. No pod the driver makes mounts the claim (the
 * lanes pod, the last that did, mounts emptyDirs alone since lanes protocol v2), so a sandbox pod's containment is
 * checkUnderDataRoot alone; this names a host path's place under the root (the tests read a staged tree's by it).
 */
export function subPathOf(dataRoot: string, host: string): string {
  checkUnderDataRoot(dataRoot, host);
  return posix.relative(dataRoot, host);
}

/** The env Secret's name for a pod. */
export function envSecretName(pod: string): string {
  return `${pod}${ENV_SECRET_SUFFIX}`;
}

/** A CPU limit in millicores (formatCpus's range and rounding; at least 1m). */
function cpuMilli(cpus: number): number {
  const milli = Math.round(Number(formatCpus(cpus)) * 1000);
  if (milli < 1) throw new SandboxError(`cpus ${cpus} is out of range`);
  return milli;
}

/** `value` as a label value: at most 63 characters, alphanumeric at both ends (what a docker label need not be). */
export function labelValue(value: string, what: string): string {
  if (!LABEL_VALUE_RE.test(value)) throw new SandboxError(`${what} ${JSON.stringify(value)} is not a Kubernetes label value (at most 63 characters, alphanumeric at both ends)`);
  return value;
}

/**
 * A trial owner's OWNER_LABEL value (the header): the owner itself when it is a label value, else
 * OWNER_LABEL_HASH_PREFIX and the first OWNER_LABEL_HASH_HEX hex of its sha256 (42 characters). What labels every
 * object of the owner's and what the reap selects by, so the two always agree; a SandboxError for what is no trial
 * owner (checkTrialOwner).
 */
export function ownerLabel(owner: string): string {
  checkTrialOwner(owner);
  if (LABEL_VALUE_RE.test(owner)) return owner;
  return `${OWNER_LABEL_HASH_PREFIX}${createHash('sha256').update(owner).digest('hex').slice(0, OWNER_LABEL_HASH_HEX)}`;
}

/** The annotations of an object of trial owner `owner`'s: the owner whole (OWNER_ANNOTATION), whatever its label is; none without one. */
export function ownerAnnotations(owner: string | null): Record<string, string> | undefined {
  return owner === null ? undefined : { [OWNER_ANNOTATION]: checkTrialOwner(owner) };
}

/** The trial a trial network is for (checkSandboxNetwork took its name). */
function trialOf(network: SandboxNetwork): string {
  return labelValue(network.name.slice(TRIAL_NETWORK_PREFIX.length), 'trial');
}

/** The labels of a pod's Secret and policy: the grader's mark, the pod's name, its trial's. */
function objectLabels(name: string, network: SandboxNetwork | null, owner: string | null): Record<string, string> {
  return {
    [GRADER_LABEL_KEY]: GRADER_LABEL_VALUE,
    [POD_LABEL]: name,
    ...(network === null ? {} : { [NETWORK_LABEL]: trialOf(network) }),
    ...(network === null || owner === null ? {} : { [OWNER_LABEL]: ownerLabel(owner) }),
  };
}

/** The marks of a pod's Secret and policy: objectLabels, and the owner whole when it is on a trial with one. */
function objectMarks(name: string, network: SandboxNetwork | null, owner: string | null): ObjectMarks {
  const annotations = network === null ? undefined : ownerAnnotations(owner);
  return { labels: objectLabels(name, network, owner), ...(annotations === undefined ? {} : { annotations }) };
}

/**
 * A sandbox pod's labels: objectLabels less POD_LABEL unless a policy of its own selects it (`ownPolicy`), so pods
 * alike share a Cilium identity (the header's Pod identities); the sandbox role, its kind, the egress mark.
 */
function podLabels(name: string, kind: SandboxPodKind, network: SandboxNetwork | null, owner: string | null, ownPolicy = false): Record<string, string> {
  const marks = objectLabels(name, network, owner);
  return {
    ...(ownPolicy ? marks : Object.fromEntries(Object.entries(marks).filter(([key]) => key !== POD_LABEL))),
    [ROLE_LABEL]: 'sandbox',
    [SANDBOX_KIND_LABEL]: kind,
    ...(network?.egress === true ? { [EGRESS_LABEL_KEY]: EGRESS_LABEL_VALUE } : {}),
  };
}

/**
 * A race pod's labels (the header): the sandbox role and kind race only, no grader mark, so no stale sweep lists it,
 * and no POD_LABEL, so every race pod shares one Cilium identity (no policy of its own selects it).
 */
function racePodLabels(): Record<string, string> {
  return { [ROLE_LABEL]: 'sandbox', [SANDBOX_KIND_LABEL]: 'race' };
}

/**
 * The soft spread an untimed program pod but a forwarder carries (the header's Room on the node): among the nodes its
 * selector picks the scheduler prefers the one that holds fewer of the namespace's sandbox pods (the forwarders not
 * counted), and places the pod all the same when
 * it cannot keep them within one of each other (ScheduleAnyway: a preference, never a refusal). Without it the
 * scheduler's resource score alone decides, which on dsh-makefun sent about 89% of production's sandbox pods to s9
 * (2026-11-12 14:47-14:57Z: s18 carries the app's own pods, so s9 always looked the emptier) until s9 was the slow one.
 */
export const SANDBOX_SPREAD = Object.freeze({
  maxSkew: 1,
  topologyKey: 'kubernetes.io/hostname',
  whenUnsatisfiable: 'ScheduleAnyway',
  // The forwarders (the only pods with POD_LABEL) are left out of the count: they carry their own preference for the
  // node without the app (nodePreferenceAffinity), and counted they would push the others back onto the app node.
  labelSelector: Object.freeze({
    matchLabels: Object.freeze({ [ROLE_LABEL]: 'sandbox' }),
    matchExpressions: Object.freeze([Object.freeze({ key: POD_LABEL, operator: 'DoesNotExist' })]),
  }),
});

/**
 * The label of the node that carries the app (deploy/k8s/cluster node-labels.yaml: s18, with Postgres, web and every
 * timed pod): the drawn placement's two sides are the nodes of the selector with it and those without (s9).
 */
export const APP_NODE_LABEL = 'makefun.io/app';

/** The weight of the drawn placement's one preferred term: the most a preferred nodeAffinity term may carry. */
export const NODE_PREFERENCE_WEIGHT = 100;

/**
 * The app node's free places (nodePodRooms' `free`) at or under which the drawn share is 0: server/jobs.ts
 * NODE_POD_HEADROOM (4) plus a margin of 96 (tests/unit/sandbox-k8s-placement.test.ts holds the sum). The margin is
 * that wide because the read counts s18's places against its /24 less ADDRESS_HEADROOM (246) less the pods the API
 * still lists, so the addresses the CNI's teardown backlog holds for pods already gone read as free: on 2026-11-12 s18
 * refused sandboxes from about 155 pods holding an address, while the read still showed about 91 free places. A floor
 * of the headroom plus 20 would turn the draw off at 222 listed pods, far past that refusal; this one turns it off from
 * 146, nine short of it, for what the processes place there between two reads (each answered from cache for
 * NODE_ROOM_CACHE_MS). Below the refusal it costs nothing: s18's ~69 pods of its own plus the share's ~62 sandbox pods
 * at a 77-trial load are 131 (the 2026-11-12 simulation).
 */
export const APP_NODE_ROOM_FLOOR = 100;

/**
 * Which side of the drawn placement a pod takes: it prefers the app node (APP_NODE_LABEL) or a node without it, or,
 * `not-app`, the pod may not land there: the app node is at its sandbox cap (K8sSandboxOptions.appNodeSandboxPods), or
 * the pod is a trial agent's (trialAgentPreference), whatever the cap.
 */
export type NodePreference = 'app' | 'other' | 'not-app';

/**
 * A pod's spec.affinity for `prefer` (the header's Room on the node): for `app` and `other` ONE preferred nodeAffinity
 * term of weight NODE_PREFERENCE_WEIGHT on APP_NODE_LABEL, Exists for the app node and DoesNotExist for the other; a
 * preference, so a pod still lands on whichever node has room when the preferred one has none. For `not-app` ONE
 * required term, APP_NODE_LABEL DoesNotExist: the app node at its sandbox cap refuses the pod, which waits for room on
 * another node as any Pending pod does. A fresh object each call.
 */
export function nodePreferenceAffinity(prefer: NodePreference): Record<string, unknown> {
  if (prefer === 'not-app') {
    return {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: APP_NODE_LABEL, operator: 'DoesNotExist' }] }] },
      },
    };
  }
  if (prefer !== 'app' && prefer !== 'other') throw new SandboxError(`node preference ${JSON.stringify(prefer)} is neither app, other nor not-app`);
  return {
    nodeAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [{ weight: NODE_PREFERENCE_WEIGHT, preference: { matchExpressions: [{ key: APP_NODE_LABEL, operator: prefer === 'app' ? 'Exists' : 'DoesNotExist' }] } }],
    },
  };
}

/** `share` as the drawn placement takes it (K8sSandboxOptions.appNodeShare): a finite number from 0 to 1. */
export function checkAppNodeShare(share: number): number {
  if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1) throw new SandboxError(`app node share ${share} is not a number from 0 to 1`);
  return share;
}

/**
 * Whether pod `name` draws the app node at `share`: the first 32 bits of the name's sha256 as a fraction of 2^32 below
 * the share. Stable for a name and stateless (the pod names' random suffix makes the draws independent), so every
 * process that makes pods draws the same share without asking another; 0 never draws it, 1 always does.
 */
export function drawsAppNode(name: string, share: number): boolean {
  checkAppNodeShare(share);
  return createHash('sha256').update(name).digest().readUInt32BE(0) / 2 ** 32 < share;
}

/** `pods` as the app node's sandbox cap takes it (K8sSandboxOptions.appNodeSandboxPods): a non-negative safe integer. */
export function checkAppNodeSandboxPods(pods: number): number {
  if (typeof pods !== 'number' || !Number.isSafeInteger(pods) || pods < 0) throw new SandboxError(`app node sandbox pods ${pods} is not a whole number of pods, 0 or more`);
  return pods;
}

/**
 * The label of a trial agent's split-layout pod: grader/agent.ts TRIAL_LABELS.entry, the entrant's program in an
 * agent/v1 trial (makefun-sbx-trial-agent-<8 hex>). k8s.ts does not import the grader that imports it, so
 * tests/unit/sandbox-k8s-placement.test.ts holds the two equal.
 */
export const TRIAL_AGENT_SPEC_LABEL = 'trial-agent';

/**
 * The label of an agent/v1 trial's one pod on the `pod` layout (grader/agent.ts TRIAL_POD_LABEL,
 * makefun-sbx-trial-<8 hex>): it holds the entry beside the env, so the whole pod is the trial agent's.
 * tests/unit/sandbox-k8s-placement.test.ts holds the two equal.
 */
export const TRIAL_AGENT_PLAN_LABEL = 'trial';

/**
 * The pod label a trial agent's pod carries while the drawn placement is on (a share or a cap; the header's Room on the
 * node), value `true`: it is always required off the app node (trialAgentPreference), and the app node's sandbox cap
 * does not count it (CAPPED_SANDBOX_SELECTOR).
 */
export const TRIAL_AGENT_LABEL = 'makefun.io/trial-agent';

/**
 * The label selector of the pods the app node's sandbox cap counts (the header's Room on the node): every sandbox pod
 * (ROLE_LABEL=sandbox) but a race's (SANDBOX_KIND_LABEL=race), which costs the node next to no CPU and prefers it
 * (racePodPreference), and a trial agent's (TRIAL_AGENT_LABEL), which never lands there (trialAgentPreference).
 * `!=` also matches a pod without the kind label; `!` matches a pod without the agent label.
 */
export const CAPPED_SANDBOX_SELECTOR = `${ROLE_LABEL}=sandbox,${SANDBOX_KIND_LABEL}!=race,!${TRIAL_AGENT_LABEL}`;

/**
 * The places an untimed sandbox pod may use on the app node under its sandbox cap (the header's Room on the node): the
 * lesser of the node's free places (`free`, never below 0) and the cap less the sandbox pods bound there now
 * (`sandboxPods`, every namespace's but the race pods and the trial agents, CAPPED_SANDBOX_SELECTOR; timed ones included),
 * never below 0.
 */
export function appNodeCappedRoom(free: number, cap: number, sandboxPods: number): number {
  return Math.max(0, Math.min(free, cap - sandboxPods));
}

/**
 * The drawn placement of an untimed pod named `name` that is neither a forwarder, a race's (racePodPreference) nor a
 * trial agent's (trialAgentPreference; the
 * header's Room on the node), from the nodes'
 * room as nodePodRooms read it: null (no preference) when the read is null or the nodes are not both with and without
 * APP_NODE_LABEL (one node, or no app node among them); `not-app` when every app node carries a sandbox cap
 * (NodeRoom.uncapped) and has no place left under it; else `app` when drawsAppNode at `share`, or at 0 while any app
 * node has APP_NODE_ROOM_FLOOR free places or fewer (its places before the cap, as without one) or none left under its
 * cap, and `other` otherwise.
 */
export function drawnNodePreference(name: string, share: number, rooms: readonly NodeRoom[] | null): NodePreference | null {
  checkAppNodeShare(share);
  if (rooms === null) return null;
  const app = rooms.filter((n) => Object.hasOwn(n.labels, APP_NODE_LABEL));
  if (app.length === 0 || app.length === rooms.length) return null;
  if (app.every((n) => n.uncapped !== undefined && n.free <= 0)) return 'not-app';
  const low = app.some((n) => (n.uncapped ?? n.free) <= APP_NODE_ROOM_FLOOR || (n.uncapped !== undefined && n.free <= 0));
  return drawsAppNode(name, low ? 0 : share) ? 'app' : 'other';
}

/**
 * The placement of a race's pod (the header's Room on the node), from the nodes' room as nodePodRooms read it: no draw
 * and no share, null (no preference) when the read is null or the nodes are not both with and without APP_NODE_LABEL;
 * `other` while any app node has APP_NODE_ROOM_FLOOR free places or fewer before its cap (NodeRoom.uncapped, else
 * `free`); else `app`. Never `not-app`: the sandbox cap neither counts a race pod (CAPPED_SANDBOX_SELECTOR) nor keeps it off.
 * Only a race pod that idles between bars takes it: one whose spec reserves its CPU (SandboxSpec.reserveCpu, a sweep
 * session's replay at about a core) takes trialAgentPreference instead, off the app node.
 */
export function racePodPreference(rooms: readonly NodeRoom[] | null): NodePreference | null {
  if (rooms === null) return null;
  const app = rooms.filter((n) => Object.hasOwn(n.labels, APP_NODE_LABEL));
  if (app.length === 0 || app.length === rooms.length) return null;
  return app.some((n) => (n.uncapped ?? n.free) <= APP_NODE_ROOM_FLOOR) ? 'other' : 'app';
}

/**
 * The placement of a trial agent's pod (TRIAL_AGENT_SPEC_LABEL's, or TRIAL_AGENT_PLAN_LABEL's plan pod; the header's
 * Room on the node), from the nodes' room as nodePodRooms read it: `not-app`, the app node REQUIRED away, whenever the
 * nodes are both with and without APP_NODE_LABEL, whatever the share, the cap or the room either side has. A trial agent
 * is the CPU work of grading (about a core each: 8 took s18 to 95 % on 2026-11-13), so it waits for room off the app node
 * like any Pending pod rather than take the site's CPU. A race pod whose spec reserves its CPU (SandboxSpec.reserveCpu:
 * a sweep session's, server/race/runner.ts reservingCpu, replaying bars back to back at about a core for up to a whole
 * race window, MAKEFUN_RACE_SWEEP_MAX_SESSIONS of them at once) takes it too, keeping its race labels: the cap does not
 * count it (CAPPED_SANDBOX_SELECTOR), nor need to. Null (no term) when the read is null or one-sided: a required
 * term on a cluster of app nodes alone would leave the pod unschedulable.
 */
export function trialAgentPreference(rooms: readonly NodeRoom[] | null): 'not-app' | null {
  if (rooms === null) return null;
  const app = rooms.filter((n) => Object.hasOwn(n.labels, APP_NODE_LABEL));
  return app.length === 0 || app.length === rooms.length ? null : 'not-app';
}

/** Whether a split-layout spec is a trial agent's (TRIAL_AGENT_SPEC_LABEL; a race's never is). */
export function isTrialAgentSpec(spec: Pick<SandboxSpec, 'label' | 'race'>): boolean {
  return spec.label === TRIAL_AGENT_SPEC_LABEL && spec.race === undefined;
}

/** Whether a plan's one pod is a trial agent's (TRIAL_AGENT_PLAN_LABEL: an agent/v1 trial's pod, its entry inside). */
export function isTrialAgentPlan(plan: Pick<SandboxPodPlan, 'label'>): boolean {
  return plan.label === TRIAL_AGENT_PLAN_LABEL;
}

/**
 * The isolation probe's allowed pair's own soft spread (k8s-network.ts probeK8sIsolation): SANDBOX_SPREAD's mechanism over
 * the pods of probe trial `trial` alone (makefun.net=<trial>), so its two pods prefer two nodes whatever else each node
 * holds. SANDBOX_SPREAD counts every sandbox pod of the namespace, so it would not by itself part two given pods; this
 * is a preference too (ScheduleAnyway), so on one node, or with no room on the other, both land together.
 */
export function pairSpread(trial: string): Record<string, unknown> {
  return {
    maxSkew: 1,
    topologyKey: 'kubernetes.io/hostname',
    whenUnsatisfiable: 'ScheduleAnyway',
    labelSelector: { matchLabels: { [NETWORK_LABEL]: labelValue(trial, 'trial') } },
  };
}

/** A container's mount of one of its pod's own volumes (no subPath: no sandbox pod mounts the claim). */
interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
}

interface PodShape {
  name: string;
  placement: PodPlacement;
  labels: Record<string, string>;
  /** A trial pod's owner whole (ownerAnnotations); none otherwise. */
  annotations?: Record<string, string>;
  /** `none`: no resolver at all; `cluster`: the cluster's DNS (an egress pod). */
  dns: 'none' | 'cluster';
  hostAliases: readonly HostAlias[];
  root: boolean;
  caps: readonly string[];
  image: string;
  command: readonly string[];
  env: Array<Record<string, unknown>>;
  cpuMilli: number;
  /**
   * The CPU it asks to be scheduled with (default min(cpuMilli, CPU_REQUEST_MAX_MILLI)); a program pod's is
   * programCpuRequestMilli's (a timed pod's, and a reserveCpu spec's, its limit).
   */
  cpuRequestMilli?: number;
  memory: string;
  mounts: VolumeMount[];
  tmp: boolean;
  /** Its activeDeadlineSeconds (default STALE_AFTER_MS's): a race pod's lifetime. */
  deadlineSeconds?: number;
  /** The writable mounts `watch` holds read-only (the header); none or empty: the pod has no `watch`, unless it is a shim pod. */
  watch?: readonly VolumeMount[];
  /**
   * A shim pod (the header's The pod, release 2; needs `stage`): `command` is `main`'s shim (shimCommand), `stage`
   * installs the binary into AGENT_BIN_VOLUME, which `main` holds read-only at AGENT_BIN_DIR, and the pod has `watch`
   * whatever its writable mounts, taking `main`'s link (its members: [CONTAINER]) with SHIM_MEMORY_MI more memory.
   */
  shim?: boolean;
  /** The mount-point volumes `stage` holds read-write (the header): with them the pod has `stage` as its init container. */
  stage?: readonly VolumeMount[];
  /**
   * The pod's mount-point emptyDirs (diskVolume), the volumes of `mounts`, `watch` and `stage`: no pod mounts the data
   * claim. A mount whose volume is none of them is a SandboxError (podObject).
   */
  disks?: readonly Record<string, unknown>[];
  /** The soft spread over its selector's nodes (SANDBOX_SPREAD): an untimed program pod's on the disk layout, no other pod's. */
  spread?: boolean;
  /** Its one preferred node (nodePreferenceAffinity): an untimed program pod's on the disk layout, no other pod's. */
  prefer?: NodePreference;
  /** What `stage` and `watch` run (checkPodAgent): needed by a pod with either. */
  agent?: PodAgentSpec;
  /** Init containers of its own, run before `main` (preflight's agent `version`); never beside `stage`. */
  init?: readonly Record<string, unknown>[];
}

/** A mount point's disk emptyDir's name in a pod (the header): the point less its slash, `/env-data`'s `env-data`. */
export function mountVolumeName(at: string): string {
  const name = at.slice(1);
  if (!at.startsWith('/') || !DNS_LABEL_RE.test(name) || name === TMP_VOLUME) throw new SandboxError(`mount point ${JSON.stringify(at)} names no volume`);
  return name;
}

/**
 * A writable mount's disk emptyDir's sizeLimit (the plan's D14): twice its return cap (`maxBytes`), rounded up to whole
 * MiB, and at least MOUNT_SIZE_MIN_MI: /output's 128Mi, /scores' 64Mi, /state's 512Mi, /record's 2048Mi.
 */
export function mountSizeLimit(maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new SandboxError(`return cap ${maxBytes} is out of range`);
  return `${Math.max(MOUNT_SIZE_MIN_MI, Math.ceil((2 * maxBytes) / (1024 * 1024)))}Mi`;
}

/**
 * A mount point's volume (the header): a disk emptyDir named `name`, with mountSizeLimit of `returnsMaxBytes` for a
 * writable mount's, none for an input's (null): the kubelet evicts a pod whose emptyDir passes its sizeLimit.
 */
export function diskVolume(name: string, returnsMaxBytes: number | null): Record<string, unknown> {
  return { name, emptyDir: returnsMaxBytes === null ? {} : { sizeLimit: mountSizeLimit(returnsMaxBytes) } };
}

/**
 * A pod's `stage` init container (the header): the agent image, `makefun-agent stage --arrival STAGE_ARRIVAL_S` as its
 * PID 1, agentEnv (its key from pod `pod`'s own Secret, its peers), `resources` (its `main`'s, so it adds nothing to the
 * pod's), as STAGE_UID with no capability, no privilege escalation and a read-only root, and each of `mounts` read-write
 * at its mount point, nothing else (no /tmp). A shim pod's (`install`) also copies its binary for the shims first
 * (`--install AGENT_BIN_INSTALL_DIR`), the pod's AGENT_BIN_VOLUME read-write there after `mounts`.
 */
export function stageContainer(
  agent: PodAgentSpec,
  pod: string,
  resources: Readonly<Record<string, unknown>>,
  mounts: readonly { name: string; mountPath: string }[],
  install = false,
): Record<string, unknown> {
  return {
    name: STAGE_CONTAINER,
    image: agent.image,
    imagePullPolicy: IMAGE_PULL_POLICY,
    command: [AGENT_BIN, 'stage', '--arrival', String(STAGE_ARRIVAL_S), ...(install ? ['--install', AGENT_BIN_INSTALL_DIR] : [])],
    env: agentEnv(pod, agent),
    resources: structuredClone(resources),
    securityContext: {
      runAsUser: STAGE_UID,
      runAsGroup: STAGE_GID,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    },
    volumeMounts: [...mounts.map((m) => ({ name: m.name, mountPath: m.mountPath })), ...(install ? [{ name: AGENT_BIN_VOLUME, mountPath: AGENT_BIN_INSTALL_DIR }] : [])],
  };
}

/** The staging exec's argv for the unpacker's (`unpack`, treeUnpackArgv): STAGE_EXEC_SCRIPT releasing `pid`, the pod's PID 1 (a host test's own process). */
export function stageCommand(unpack: readonly string[], pid = 1): string[] {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new SandboxError(`stage release pid ${pid} is out of range`);
  return ['/bin/sh', '-c', STAGE_EXEC_SCRIPT, 'sh', String(pid), ...unpack];
}

/**
 * A pod's `watch` container (the header): the agent image, `makefun-agent serve` as its PID 1, agentEnv (its key from
 * pod `pod`'s own Secret, its peers), unprivileged as WATCH_UID, each of `mounts` read-only (none: no volumeMounts),
 * nothing else. A shim pod's names its shims' containers, `members` (MAKEFUN_AGENT_CONTAINERS: the agent takes each
 * name's link once, then closes its shim listener), and takes SHIM_MEMORY_MI of memory for each beside its own
 * WATCH_MEMORY_MI (shimWatchMemory), limit and request alike.
 */
export function watchContainer(agent: PodAgentSpec, pod: string, mounts: readonly { name: string; mountPath: string; readOnly?: boolean }[], members: readonly string[] = []): Record<string, unknown> {
  const memory = shimWatchMemory(members.length);
  return {
    name: WATCH_CONTAINER,
    image: agent.image,
    imagePullPolicy: IMAGE_PULL_POLICY,
    command: [AGENT_BIN, 'serve'],
    env: [...agentEnv(pod, agent), ...(members.length === 0 ? [] : [{ name: AGENT_CONTAINERS_ENV, value: formatContainers(members) }])],
    resources: {
      limits: { cpu: `${WATCH_CPU_LIMIT_MILLI}m`, memory },
      requests: { cpu: `${WATCH_CPU_REQUEST_MILLI}m`, memory },
    },
    securityContext: {
      runAsUser: WATCH_UID,
      runAsGroup: WATCH_GID,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    },
    ...(mounts.length === 0 ? {} : { volumeMounts: mounts.map((m) => ({ ...m, readOnly: true })) }),
  };
}

/** `watch`'s memory, limit and request, in a pod of `shims` shims: WATCH_MEMORY_MI and SHIM_MEMORY_MI for each (`32Mi` with none). */
export function shimWatchMemory(shims: number): string {
  if (!Number.isSafeInteger(shims) || shims < 0) throw new SandboxError(`shim count ${shims} is out of range`);
  return `${WATCH_MEMORY_MI + SHIM_MEMORY_MI * shims}Mi`;
}

/**
 * The containers a pod's `watch` takes shim links from (its MAKEFUN_AGENT_CONTAINERS: watchContainer's `members`), in
 * that order; none for a pod without `watch` or whose `watch` declares none (release 1's shape).
 * What the shim gate (bootFromAgent) waits for `watch`'s /v1/health to list before any exec goes into a member.
 */
export function shimMembersOf(pod: K8sObject): string[] {
  const containers = (pod.spec as { containers?: Array<{ name?: unknown; env?: Array<{ name?: unknown; value?: unknown }> }> } | undefined)?.containers ?? [];
  const value = containers.find((c) => c.name === WATCH_CONTAINER)?.env?.find((e) => e.name === AGENT_CONTAINERS_ENV)?.value;
  if (value === undefined) return [];
  if (typeof value !== 'string') throw new SandboxError(`pod ${pod.metadata.name}: its ${WATCH_CONTAINER}'s ${AGENT_CONTAINERS_ENV} is not a value`);
  try {
    return parseContainers(value);
  } catch (err) {
    throw new SandboxError(`pod ${pod.metadata.name}: its ${WATCH_CONTAINER}'s ${errorWords(err)}`);
  }
}

/** A shim pod's AGENT_BIN_VOLUME (the header's The pod): a disk emptyDir of AGENT_BIN_SIZE, which `stage` fills. */
export function agentBinVolume(): Record<string, unknown> {
  return { name: AGENT_BIN_VOLUME, emptyDir: { sizeLimit: AGENT_BIN_SIZE } };
}

/** `main`'s or a plan member's mount of the shim's binary: AGENT_BIN_VOLUME read-only at AGENT_BIN_DIR. */
function agentBinMount(): VolumeMount {
  return { name: AGENT_BIN_VOLUME, mountPath: AGENT_BIN_DIR, readOnly: true };
}

/**
 * That every one of `mounts` (a pod's containers', /tmp's aside) names one of `volumes` (its mount-point emptyDirs,
 * PodShape.disks), else a SandboxError naming the pod, the mount and its point: no pod is built with a mount it has no
 * volume for, which the API server would refuse only at the create.
 */
export function checkPodMounts(pod: string, mounts: readonly { name: string; mountPath: string }[], volumes: readonly Record<string, unknown>[]): void {
  const names = new Set(volumes.map((v) => v.name));
  for (const m of mounts) {
    if (!names.has(m.name)) throw new SandboxError(`pod ${pod} mounts ${JSON.stringify(m.name)} at ${m.mountPath} but has no volume of that name`);
  }
}

function podObject(o: PodShape): K8sObject {
  checkPodMounts(o.name, [...o.mounts, ...(o.watch ?? []), ...(o.stage ?? [])], o.disks ?? []);
  const p = o.placement;
  const shim = o.shim === true;
  if (shim && o.stage === undefined) throw new SandboxError(`pod ${o.name}: a shim pod's binary is installed by its ${STAGE_CONTAINER}, which it lacks`);
  const watched = shim || (o.watch !== undefined && o.watch.length > 0);
  const agent = o.stage !== undefined || watched ? checkPodAgent(o.agent, o.name) : null;
  if (o.init !== undefined && o.stage !== undefined) throw new SandboxError(`pod ${o.name}: a pod with ${STAGE_CONTAINER} has no other init container`);
  const spec: Record<string, unknown> = {};
  if (p.runtimeClass !== null) spec.runtimeClassName = p.runtimeClass;
  if (p.nodeSelector !== null && Object.keys(p.nodeSelector).length > 0) spec.nodeSelector = { ...p.nodeSelector };
  if (o.spread === true) spec.topologySpreadConstraints = [structuredClone(SANDBOX_SPREAD)];
  if (o.prefer !== undefined) spec.affinity = nodePreferenceAffinity(o.prefer);
  spec.serviceAccountName = p.serviceAccount;
  spec.imagePullSecrets = [{ name: IMAGE_PULL_SECRET }];
  spec.automountServiceAccountToken = false;
  spec.enableServiceLinks = false;
  spec.restartPolicy = 'Never';
  spec.activeDeadlineSeconds = o.deadlineSeconds ?? STALE_AFTER_MS / 1000;
  spec.terminationGracePeriodSeconds = 0;
  spec.dnsPolicy = o.dns === 'none' ? 'None' : 'ClusterFirst';
  spec.dnsConfig = o.dns === 'none' ? { nameservers: ['127.0.0.1'], options: [{ ...NDOTS_0 }] } : { options: [{ ...NDOTS_0 }] };
  if (o.hostAliases.length > 0) spec.hostAliases = o.hostAliases.map((a) => ({ ip: a.ip, hostnames: [...a.hostnames] }));
  spec.securityContext = {
    runAsUser: o.root ? 0 : NOBODY_ID,
    runAsGroup: o.root ? 0 : NOBODY_ID,
    runAsNonRoot: !o.root,
    seccompProfile: { type: 'RuntimeDefault' },
  };
  const container: Record<string, unknown> = {
    name: CONTAINER,
    image: o.image,
    imagePullPolicy: IMAGE_PULL_POLICY,
    command: [...o.command],
  };
  if (o.env.length > 0) container.env = o.env;
  const resources = {
    limits: { cpu: `${o.cpuMilli}m`, memory: o.memory },
    requests: { cpu: `${o.cpuRequestMilli ?? Math.min(o.cpuMilli, CPU_REQUEST_MAX_MILLI)}m`, memory: o.memory },
  };
  container.resources = resources;
  container.securityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: o.caps.length > 0 ? { drop: ['ALL'], add: [...o.caps] } : { drop: ['ALL'] },
  };
  const mounts = [...o.mounts, ...(o.tmp ? [{ name: TMP_VOLUME, mountPath: '/tmp' }] : []), ...(shim ? [agentBinMount()] : [])];
  if (mounts.length > 0) container.volumeMounts = mounts;
  // `stage` takes `main`'s resources: an init container's add nothing to the pod's (its requests are the larger of the two).
  if (o.stage !== undefined) spec.initContainers = [stageContainer(agent!, o.name, resources, o.stage, shim)];
  else if (o.init !== undefined && o.init.length > 0) spec.initContainers = o.init.map((c) => structuredClone(c));
  spec.containers = watched ? [container, watchContainer(agent!, o.name, o.watch ?? [], shim ? [CONTAINER] : [])] : [container];
  const volumes: Array<Record<string, unknown>> = [];
  if (o.disks !== undefined) volumes.push(...o.disks.map((v) => structuredClone(v)));
  if (o.tmp) volumes.push({ name: TMP_VOLUME, emptyDir: { medium: 'Memory', sizeLimit: TMP_SIZE } });
  if (shim) volumes.push(agentBinVolume());
  if (volumes.length > 0) spec.volumes = volumes;
  const creator = p.creator === undefined || p.creator === null ? null : checkName(p.creator, DNS_SUBDOMAIN_RE, 'creator pod');
  const marks: ObjectMarks = creator === null ? o : { labels: o.labels, annotations: { ...o.annotations, [CREATOR_ANNOTATION]: creator } };
  return { apiVersion: 'v1', kind: 'Pod', metadata: metadataOf(o.name, p.namespace, marks), spec };
}

/** A house image's spec's env names besides SANDBOX_ENV (the header's house image): MAKEFUN_* alone. */
const HOUSE_ENV_NAME_RE = /^MAKEFUN_[A-Z0-9_]+$/;

/** The refusal of an image spec this driver runs no pod of: code `repo_image_unsupported`, no retry or re-queue mends it. */
function repoImageUnsupported(detail: string): SandboxError {
  return new SandboxError(`the k8s driver runs no repository image${detail} (a patch/v1 run is the docker driver's)`, { code: 'repo_image_unsupported' });
}

/**
 * A sandbox's house images (K8sSandboxOptions.houseImages), checked: each `<repository>@sha256:<64 hex>` exactly as
 * types.ts repoImageRef writes it (a lowercase repository, no tag), else a SandboxError naming it. A copy, so a caller's
 * later change to its set changes nothing here.
 */
export function checkHouseImages(refs: Iterable<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const ref of refs) {
    const at = typeof ref === 'string' ? ref.lastIndexOf('@') : -1;
    let ok = false;
    try {
      ok = at > 0 && repoImageRef(ref.slice(0, at), ref.slice(at + 1)) === ref;
    } catch {
      ok = false;
    }
    if (!ok) throw new SandboxError(`house image ${JSON.stringify(ref)} is not <repository>@sha256:<64 hex>`);
    out.add(ref);
  }
  return out;
}

/**
 * The `<repository>@<digest>` a spec's `image` runs on this driver (the header's house image): with no house images
 * (`houseImages` absent or empty: every grading sandbox) the SandboxError of code `repo_image_unsupported` at once,
 * before anything of the spec is read, as ever; else the image checked as every driver checks it (types.ts
 * checkSandboxImage: no network, launcher, race or imageDigest), refused `repo_image_unsupported` when it is none of
 * `houseImages`, and a plain SandboxError for a spec env name that is no MAKEFUN_* one or any secret.
 */
export function checkHouseImageSpec(spec: SandboxSpec, houseImages: ReadonlySet<string> | null | undefined): string {
  if (houseImages === undefined || houseImages === null || houseImages.size === 0) throw repoImageUnsupported('');
  const image = checkSandboxImage(spec);
  const ref = repoImageRef(image.repository, image.digest);
  if (!houseImages.has(ref)) throw repoImageUnsupported(` but its house images, and ${ref} is none of them`);
  for (const [name] of checkSandboxEnv(spec.env)) {
    if (!HOUSE_ENV_NAME_RE.test(name)) throw new SandboxError(`a house image's program takes MAKEFUN_* variables alone, not ${name}`);
  }
  if (spec.secrets !== undefined && Object.keys(spec.secrets).length > 0) throw new SandboxError("a house image's program takes no secrets");
  return ref;
}

/**
 * The argv a program pod's exec runs under its wrapper (K8sSandbox #spawn; the header's exec): a house image's own
 * argv (the header's house image), a launcher spec's LAUNCHER_ARGV, else the runtime's interpreter and `/bot/<script>`;
 * a timed one's under the CPU launcher (cpuLauncherArgv).
 */
export function sandboxProgramArgv(spec: SandboxSpec, timed: boolean): string[] {
  const program = spec.image !== undefined ? [...spec.image.argv] : spec.launcher === undefined ? [...RUNTIME_COMMANDS[spec.runtime], `/bot/${scriptOf(spec)}`] : [...LAUNCHER_ARGV[spec.runtime]];
  return timed ? cpuLauncherArgv(program) : program;
}

/**
 * The pod a program runs in (the header): pure, so its every field is unit-tested exactly, the twin of
 * dockerRunArgs. A spec with a launcher gets the launcher's user and capabilities and the house; a timed pod
 * (opts.timed) the same user and capabilities for the CPU launcher, no house, and its CPU limit as its request; a
 * spec with reserveCpu its CPU limit as its request too, nothing else changed; a race
 * spec (its `race`) a race pod's labels, deadline and CPU request (the header); POD_LABEL only with opts.ownPolicy, a
 * forwarder's alone (any other pod's is a SandboxError); any mount mounts.ts checkSandboxMounts refuses is a
 * SandboxError, and so is a host path checkHostPath refuses or one not under the data root (checkUnderDataRoot: every tree it
 * stages from, /bot, a launcher's house and each mount, and every host directory a collect empties and writes into lies
 * there, as when they were subPaths of the claim), naming the path. Each of its mounts also adds its stand-in variable
 * to `main`'s environment (types.ts containerMountEnv: MAKEFUN_OUTPUT_DIR=/output; /state's and /record's stay unset).
 * Its volumes are a disk emptyDir per mount point
 * (diskVolume: /bot, a launcher's /house, each mount; a writable one with its sizeLimit) and /tmp, no claim; `main`
 * mounts each at its point, read-only but for a writable mount; `stage`, its init container (stageContainer: the agent
 * image, `makefun-agent stage`), holds every one read-write. A spec with a writable mount gets `watch` after `main`
 * (watchContainer: the agent image, `makefun-agent serve`), each writable mount read-only there; both take opts.agent
 * (its image and the agents' peers; none is a SandboxError) and read their key from the pod's own Secret. Unless it is
 * timed, the pod gets its placement (the header's Room on the node): a forwarder's a preference for a node without
 * the app (nodePreferenceAffinity `other`) and no spread, any other's the soft spread over its selector's nodes
 * (SANDBOX_SPREAD) and opts.prefer's term when it has one. With opts.shim (every pod the driver makes: the header's The
 * pod), `main`'s PID 1 is the shim (shimCommand, a served pod's with `--policy-port POLICY_PORT`) in HOLD_COMMAND's
 * or the policy listener's place, `stage` installs it into agent-bin (`--install AGENT_BIN_INSTALL_DIR`, a disk
 * emptyDir of AGENT_BIN_SIZE), which `main` holds read-only at AGENT_BIN_DIR, and the pod has `watch` whatever its
 * writable mounts (none: it mounts nothing), MAKEFUN_AGENT_CONTAINERS=main and SHIM_MEMORY_MI more memory; `main`'s
 * user, capabilities, env and mounts are otherwise release 1's, and no MAKEFUN_AGENT_* variable is in it. A
 * patch/v1 spec is refused (the docker driver's alone, as deploy/prod runs it): one with an `image`
 * by a SandboxError of code `repo_image_unsupported`, one with a `work` tmpfs by a plain one. The one image spec it
 * runs is a house image's (the header's house image: checkHouseImageSpec over opts.houseImages): `main` runs that
 * `<repository>@<digest>` in the runtime image's place, labelled makefun.io/sandbox=DESK_POD_KIND, never timed, a
 * pool's or a trial agent's, everything else as above.
 */
export function sandboxPodSpec(spec: SandboxSpec, opts: SandboxPodOptions): K8sObject {
  const house = spec.image === undefined ? null : checkHouseImageSpec(spec, opts.houseImages);
  if (spec.work !== undefined) throw new SandboxError("the k8s driver gives no /work tmpfs (a patch/v1 run is the docker driver's)");
  scriptOf(spec);
  const timed = opts.timed === true;
  if (house !== null && (timed || opts.pool !== undefined || opts.trialAgent === true)) {
    throw new SandboxError(`a house image's pod is an untimed program pod of its own: never ${timed ? 'a timed pod' : opts.pool !== undefined ? "a warm pool's" : "a trial agent's"}`);
  }
  if (timed && spec.launcher !== undefined) throw new SandboxError("a timed pod runs a program/v1 entry under the CPU launcher, never a spec's own launcher");
  const race = spec.race === undefined ? null : checkSandboxRace(spec);
  if (timed && race !== null) throw new SandboxError("a timed pod runs a program/v1 timing heat's entry, never a race's racer");
  const launcher = spec.launcher === undefined ? null : checkSandboxLauncher(spec);
  const memory = `${positiveInt(spec.limits.memory_mb, 'memory_mb')}Mi`;
  const milli = cpuMilli(spec.limits.cpus);
  positiveInt(spec.limits.pids, 'pids');
  const network = spec.network === undefined ? null : checkSandboxNetwork(spec.network);
  const ownPolicy = opts.ownPolicy === true;
  const forwarder = isForwarder(network);
  if (ownPolicy && !forwarder) throw new SandboxError("only a forwarder's pod has a policy of its own (gatewayPolicy)");
  const prefer = opts.prefer ?? null;
  if (prefer !== null && (timed || forwarder)) throw new SandboxError(`a ${timed ? "timed pod's node is its own selector's" : "forwarder's preferred node is fixed"}: it takes no drawn placement`);
  const trialAgent = opts.trialAgent === true;
  if (trialAgent && (timed || forwarder || race !== null)) throw new SandboxError(`a ${timed ? 'timed pod' : forwarder ? 'forwarder' : "race's pod"} is no trial agent's: only an untimed program pod is kept off the app node as one`);
  const shim = opts.shim === true;
  const served = network !== null && servedPort(network) !== null;
  const secret = envSecretName(opts.name);
  const env: Array<Record<string, unknown>> = Object.entries(SANDBOX_ENV).map(([name, value]) => ({ name, value }));
  for (const [name, value] of checkSandboxEnv(spec.env)) {
    env.push(SECRET_ENV_RE.test(name) ? { name, valueFrom: { secretKeyRef: { name: secret, key: name } } } : { name, value });
  }
  // The spec's secrets are checked here, as every driver checks them, but are no part of the pod: its program's exec
  // carries them (the header's Exec env), so nothing of a run's sits in its pod or Secret (Pool-ready).
  checkSandboxSecrets(spec);
  // Each mount point's volume: its own emptyDir (a writable one with its sizeLimit).
  const mounts: VolumeMount[] = [];
  const disks: Array<Record<string, unknown>> = [];
  const add = (at: string, host: string, readOnly: boolean, returnsMaxBytes: number | null): VolumeMount => {
    const mount: VolumeMount = { name: mountVolumeName(at), mountPath: at, readOnly };
    // What is staged from, and what a writable mount is collected into (emptied first), lies under the data root too.
    checkUnderDataRoot(opts.dataRoot, host);
    disks.push(diskVolume(mount.name, returnsMaxBytes));
    mounts.push(mount);
    return mount;
  };
  add('/bot', spec.codeDir, true, null);
  if (launcher !== null) add(HOUSE_DIR, launcher.houseDir, true, null);
  // Every driver's mount check (mounts.ts), so this one refuses what docker and process refuse; the writable ones are `watch`'s too.
  const watch: VolumeMount[] = [];
  const specMounts = checkSandboxMounts(spec.mounts);
  for (const m of specMounts) {
    const mount = add(m.at, m.host, m.readOnly, m.readOnly ? null : m.returns!.maxBytes);
    if (!m.readOnly) watch.push({ ...mount, readOnly: true });
  }
  // Each mount stands in for itself in the program's environment (types.ts containerMountEnv), as dockerRunArgs sets
  // its own: MAKEFUN_OUTPUT_DIR=/output, so a program reading it with no fallback resolves the mount on every driver.
  for (const [name, value] of containerMountEnv(specMounts)) env.push({ name, value });
  const owner = network === null ? null : (opts.owner ?? null);
  const pool = opts.pool ?? null;
  if (pool !== null && (timed || network !== null || race !== null || !POOL_KEY_RE.test(pool))) {
    throw new SandboxError(`a warm pool's pod is an untimed program pod with no network, its shape key ${POOL_KEY_HEX} hex, not ${JSON.stringify(pool)}${timed ? ' (timed)' : network !== null ? ' (networked)' : race !== null ? " (a race's)" : ''}`);
  }
  const annotations = pool === null ? ownerAnnotations(owner) : { ...ownerAnnotations(owner), [POOL_ANNOTATION]: pool };
  return podObject({
    name: opts.name,
    placement: opts,
    labels: race === null ? { ...podLabels(opts.name, house === null ? 'program' : DESK_POD_KIND, network, owner, ownPolicy), ...(trialAgent ? { [TRIAL_AGENT_LABEL]: 'true' } : {}) } : racePodLabels(),
    ...(annotations === undefined ? {} : { annotations }),
    dns: network?.egress === true ? 'cluster' : 'none',
    hostAliases: network === null ? [] : (opts.hostAliases ?? []),
    root: launcher !== null || timed,
    caps: launcher === null && !timed ? [] : LAUNCHER_CAPS,
    image: house ?? imageRef({ image: opts.image }, opts.digest),
    command: shim ? shimCommand(CONTAINER, served ? POLICY_PORT : null) : served ? [...POLICY_LISTENER_COMMAND] : [...HOLD_COMMAND],
    env,
    cpuMilli: milli,
    cpuRequestMilli: programCpuRequestMilli(spec, milli, timed),
    memory,
    mounts,
    tmp: true,
    ...(race === null ? {} : { deadlineSeconds: raceDeadlineSeconds(race.lifetimeMs) }),
    watch,
    stage: mounts.map(({ name, mountPath }) => ({ name, mountPath })),
    ...(shim ? { shim } : {}),
    disks,
    ...(opts.agent === undefined ? {} : { agent: opts.agent }),
    // A timed pod is pinned to its own selector's node: it is neither spread nor given a preference. A forwarder
    // prefers a node without the app and is not spread; every other pod is spread, with the drawn node it was given.
    ...(timed ? {} : forwarder ? { prefer: 'other' as const } : { spread: true, ...(prefer === null ? {} : { prefer }) }),
  });
}

/**
 * The CPU a program pod (sandboxPodSpec) asks to be scheduled with, from its limit `limitMilli`: the limit for a timed
 * pod or a spec with reserveCpu; min(limit, RACE_CPU_REQUEST_MILLI) for a race's racer; min(limit,
 * TRIAL_AGENT_CPU_REQUEST_MILLI) for a split-layout trial agent's (isTrialAgentSpec); min(limit,
 * FORWARDER_CPU_REQUEST_MILLI) for an agent trial's forwarder (isTrialForwarder); min(limit, CPU_REQUEST_MAX_MILLI)
 * for every other (an agent trial's env, a scrape trial's entry and gateway, a grade or program/v1 pod).
 */
export function programCpuRequestMilli(spec: Pick<SandboxSpec, 'label' | 'race' | 'reserveCpu' | 'network'>, limitMilli: number, timed: boolean): number {
  if (timed || spec.reserveCpu === true) return limitMilli;
  if (spec.race !== undefined) return Math.min(limitMilli, RACE_CPU_REQUEST_MILLI);
  if (isTrialAgentSpec(spec)) return Math.min(limitMilli, TRIAL_AGENT_CPU_REQUEST_MILLI);
  if (isTrialForwarder(spec.network ?? null)) return Math.min(limitMilli, FORWARDER_CPU_REQUEST_MILLI);
  return Math.min(limitMilli, CPU_REQUEST_MAX_MILLI);
}

/** A race pod's activeDeadlineSeconds: its lifetime in whole seconds, rounded up (at least 1). */
export function raceDeadlineSeconds(lifetimeMs: number): number {
  return Math.max(1, Math.ceil(lifetimeMs / 1000));
}

/**
 * A pod's `<pod>-env` Secret over `keys` (a spec's or a plan's values) and the pod's agent key K, MAKEFUN_AGENT_KEY
 * (`agentKey`, else a fresh one: agent-wire.ts newAgentKey, crypto.randomBytes in this process), in name order. A value
 * of the spec's that would take the agent key's name is refused.
 */
function podSecret(keys: ReadonlyArray<readonly [string, string]>, opts: { name: string; namespace: string; agentKey?: string } & ObjectMarks): K8sObject {
  if (keys.some(([name]) => name === AGENT_KEY_ENV)) throw new SandboxError(`pod ${opts.name}: ${AGENT_KEY_ENV} is the agent's key in the pod's Secret, never a value of the spec's`);
  const key = opts.agentKey ?? newAgentKey();
  try {
    parseAgentKey(key);
  } catch (err) {
    throw new SandboxError(`pod ${opts.name}: the agent key is no ${AGENT_KEY_ENV} value (${(err as Error).message})`);
  }
  const data = [...keys, [AGENT_KEY_ENV, key] as const].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: metadataOf(envSecretName(opts.name), opts.namespace, opts),
    type: 'Opaque',
    stringData: Object.fromEntries(data),
  };
}

/**
 * The Secret `<pod>-env` every program pod has (the header's Secret first): its agent key MAKEFUN_AGENT_KEY (podSecret:
 * `opts.agentKey`, else a fresh K), which only `stage` and `watch` read, beside the spec's *_API_KEY env values
 * (SECRET_ENV_RE: a trial's forwarder's), which `main` reads by secretKeyRef, in name order. Never the spec's secrets
 * (checked here all the same): its program's exec carries them (the header's Exec env). A race's pod, and a grade's,
 * has one too: its agents' key alone.
 */
export function sandboxEnvSecret(spec: Pick<SandboxSpec, 'env' | 'secrets' | 'race' | 'launcher'>, opts: { name: string; namespace: string; agentKey?: string } & ObjectMarks): K8sObject {
  checkSandboxSecrets(spec);
  return podSecret(checkSandboxEnv(spec.env).filter(([name]) => SECRET_ENV_RE.test(name)), opts);
}

/** The agent key K a pod's Secret (sandboxEnvSecret, podPlanSecret) holds, or null when it holds none. */
export function agentKeyOf(secret: K8sObject | null): string | null {
  const key = (secret?.stringData as Record<string, unknown> | undefined)?.[AGENT_KEY_ENV];
  return typeof key === 'string' ? key : null;
}

/**
 * `text` (what kubectl said) with every value of `secret`'s (sandboxEnvSecret's) taken out, each whole and each line
 * of one of at least ENTRY_SECRET_VALUE_MIN_CHARS characters, as `[secret <NAME>]`: what a failure to create it may
 * say, never a value.
 */
export function withoutValues(text: string, secret: K8sObject | null): string {
  const data = (secret?.stringData ?? {}) as Record<string, string>;
  const forms: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(data)) {
    if (value !== '') forms.push([value, name]);
    for (const line of value.split(/\r?\n|\r/)) if (line !== value && line.length >= ENTRY_SECRET_VALUE_MIN_CHARS) forms.push([line, name]);
  }
  // The longest first, so a value never leaves part of itself behind a shorter one's mark.
  forms.sort(([a], [b]) => b.length - a.length);
  let out = text;
  for (const [form, name] of forms) out = out.split(form).join(`[secret ${name}]`);
  return out;
}

/** A pod as the owner of an object (metadata.ownerReferences' one entry, blocking nothing): its name and uid, checked. */
function podOwnerReference(owner: { name: string; uid: string }): Record<string, unknown> {
  if (!UID_RE.test(owner.uid)) throw new SandboxError(`pod ${owner.name}'s uid ${JSON.stringify(owner.uid)} is not a uid`);
  return { apiVersion: 'v1', kind: 'Pod', name: owner.name, uid: owner.uid, blockOwnerDeletion: false };
}

/**
 * `obj` owned by pod `owner` (metadata.ownerReferences, blocking nothing): Kubernetes' garbage collector deletes it with
 * the pod, or at once when the pod is gone already. The env Secret is made before its pod and given this owner by a patch
 * after (ownerPatch, patchSecretOwner: the header's Secret first); this is the object as that patch leaves it.
 */
export function ownedByPod(obj: K8sObject, owner: { name: string; uid: string }): K8sObject {
  return { ...obj, metadata: { ...obj.metadata, ownerReferences: [podOwnerReference(owner)] } };
}

/** The JSON merge patch (`kubectl patch --type=merge -p`) that makes pod `owner` an object's owner, as ownedByPod does. */
export function ownerPatch(owner: { name: string; uid: string }): string {
  return JSON.stringify({ metadata: { ownerReferences: [podOwnerReference(owner)] } });
}

/** Pod `pod`'s uid in what `kubectl create -o CREATED_JSONPATH` printed (one line per object made), or null. */
export function createdUid(stdout: string, pod: string): string | null {
  return createdOf(stdout, 'Pod', pod);
}

/** The uid of object `kind`/`name` in what `kubectl create -o CREATED_JSONPATH` printed, or null when it was not made. */
export function createdOf(stdout: string, kind: string, name: string): string | null {
  for (const line of stdout.split('\n')) {
    const [k, n, uid, ...rest] = line.trim().split(' ');
    if (k === kind && n === name && uid !== undefined && rest.length === 0 && UID_RE.test(uid)) return uid;
  }
  return null;
}

/**
 * preflight's pod: `true` in the image, as the sandbox user, nothing mounted; before it, one init container on the agent
 * image (PREFLIGHT_AGENT_CONTAINER: `makefun-agent version`, as STAGE_UID, AUX limits, nothing mounted), so the pull of
 * either image (the agent's through IMAGE_PULL_SECRET) and the agent's start under the RuntimeClass are proven before a
 * grade needs them.
 */
export function preflightPodSpec(opts: AuxPodOptions): K8sObject {
  const agent = opts.agent;
  if (agent === undefined || typeof agent.image !== 'string' || !IMAGE_REF_RE.test(agent.image)) {
    throw new SandboxError(`preflight pod ${opts.name}: no agent image to run its ${PREFLIGHT_AGENT_CONTAINER} container (grader/images.json pins none)`);
  }
  const resources = { limits: { cpu: `${AUX_CPU_MILLI}m`, memory: AUX_MEMORY }, requests: { cpu: `${Math.min(AUX_CPU_MILLI, CPU_REQUEST_MAX_MILLI)}m`, memory: AUX_MEMORY } };
  return podObject({
    name: opts.name,
    placement: opts,
    labels: podLabels(opts.name, 'preflight', null, null),
    dns: 'none',
    hostAliases: [],
    root: false,
    caps: [],
    image: imageRef({ image: opts.image }, opts.digest),
    command: ['true'],
    env: [],
    cpuMilli: AUX_CPU_MILLI,
    memory: AUX_MEMORY,
    mounts: [],
    tmp: false,
    init: [
      {
        name: PREFLIGHT_AGENT_CONTAINER,
        image: agent.image,
        imagePullPolicy: IMAGE_PULL_POLICY,
        command: [AGENT_BIN, 'version'],
        resources,
        securityContext: {
          runAsUser: STAGE_UID,
          runAsGroup: STAGE_GID,
          runAsNonRoot: true,
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
      },
    ],
  });
}

/**
 * An isolation probe's pod (k8s-network.ts probeK8sIsolation): the image as the sandbox user, nothing mounted,
 * no DNS, under the egress policy when `egress` (the listener and the sibling, as a forwarder is) and on trial
 * `trial`'s network when one is named (the inside one and its peer, as an entry and a service are), running `command`;
 * with `apart` (the allowed pair's two, on a trial), the soft spread of that trial's own pods (pairSpread).
 */
export function isolationPodSpec(opts: AuxPodOptions & { trial: string | null; egress: boolean; command: readonly string[]; apart?: boolean }): K8sObject {
  const network: SandboxNetwork | null = opts.trial === null ? null : { name: trialNetworkName(opts.trial) };
  if (opts.apart === true && opts.trial === null) throw new SandboxError(`isolation pod ${opts.name} is kept apart from its trial's other pod, but is on no trial`);
  const pod = podObject({
    name: opts.name,
    placement: opts,
    labels: { ...podLabels(opts.name, 'isolation', network, null), ...(opts.egress ? { [EGRESS_LABEL_KEY]: EGRESS_LABEL_VALUE } : {}) },
    dns: 'none',
    hostAliases: [],
    root: false,
    caps: [],
    image: imageRef({ image: opts.image }, opts.digest),
    command: opts.command,
    env: [],
    cpuMilli: AUX_CPU_MILLI,
    memory: AUX_MEMORY,
    mounts: [],
    tmp: false,
  });
  if (opts.apart === true) (pod.spec as Record<string, unknown>).topologySpreadConstraints = [pairSpread(opts.trial!)];
  return pod;
}

// ---------------------------------------------------------------- one pod for an entry's programs

/**
 * Each plan member's user, its program's own: the process cap (RLIMIT_NPROC) counts a uid's tasks across the whole
 * sandbox and a uid apart apart (probe d, d2), so the entry runs as the sandbox user and the env as one apart. A
 * launcher member's container (and a timed `main`'s) is root, its program dropped to SANDBOX_UID (TIMED_UID).
 */
export const POD_MEMBER_UIDS: Readonly<Record<PodMember, number>> = Object.freeze({ entry: NOBODY_ID, env: 65533, main: NOBODY_ID });
/**
 * The egress mark's value on a pod whose members dial the door (SandboxPodPlan.doors), the lanes pod's: what the
 * namespace's policy for the door selects; makefun-sandbox-egress selects `makefun.egress=1` and never this.
 */
export const LANES_EGRESS_VALUE = 'lanes';
/** Where a plan's local names resolve. */
export const LOOPBACK = '127.0.0.1';

/** A plan's pod's own (podPlanSpec): its name, the image table its members' runtimes are read from, whether its `main` is timed. */
export interface PodPlanOptions extends PodPlacement {
  /** makefun-sbx-<plan label>-<8 hex> (podName of the plan's label). */
  name: string;
  /** Default IMAGES. */
  images?: ImageTableT;
  /** Its `main` runs under the CPU launcher (the header's Timing): root with LAUNCHER_CAPS, its CPU limit its request. */
  timed?: boolean;
  /** Its drawn placement (SandboxPodOptions.prefer): its one node term (nodePreferenceAffinity); absent or null none, a timed pod's a SandboxError. */
  prefer?: NodePreference | null;
  /** A trial agent's plan pod under the drawn placement (isTrialAgentPlan; SandboxPodOptions.trialAgent): TRIAL_AGENT_LABEL=true; a timed pod's a SandboxError. Absent: false. */
  trialAgent?: boolean;
}

/** One member of a plan, checked: its container's user, the env's Secret names, what it mounts. */
interface PlanMember {
  member: PodMember;
  spec: PodMemberSpec;
  root: boolean;
  /** Its program's uid (a root container's drops to it). */
  uid: number;
  cpuMilli: number;
  memoryMi: number;
  /** The names its container reads from the pod's Secret: its *_API_KEY env values and its secrets. */
  secretNames: string[];
  /** Its spec's mounts, as mounts.ts checkSandboxMounts took them (every writable one with its `returns`). */
  mounts: readonly SandboxMount[];
}

/** Where `stage` and `watch` hold a plan member's mount point (podPlanSpec): `/m/<member><mount point>`, one path a member, two members' `/bot` apart. */
export function memberMountPath(member: PodMember, at: string): string {
  return `/m/${member}${at}`;
}

/** A plan member's mount point's disk emptyDir's name (podPlanSpec): mountVolumeName's, then the member, `/env-data`'s `env-data-env`. */
export function memberVolumeName(member: PodMember, at: string): string {
  return `${mountVolumeName(at)}-${member}`;
}

/**
 * The plan checked as podPlanSpec and podPlanSecret build it: checkSandboxPodPlan, a name of the plan's label, and per
 * member what sandboxPodSpec checks of a spec (its script, launcher, limits, env, secrets and mounts: mounts.ts
 * checkSandboxMounts, so a writable mount says its `returns`); a timed pod has a `main` with no launcher; two members
 * whose programs would run as one uid, or whose Secret values share a name, are refused.
 */
function checkPlan(plan: SandboxPodPlan, name: string, timed: boolean): PlanMember[] {
  const entries = checkSandboxPodPlan(plan);
  if (!new RegExp(`^${POD_PREFIX}${plan.label}-[0-9a-f]{8}$`).test(name)) throw new SandboxError(`pod ${JSON.stringify(name)} is not named ${POD_PREFIX}${plan.label}-<8 hex>`);
  if (timed && (plan.members.main === undefined || plan.members.main.launcher !== undefined)) throw new SandboxError("a timed pod times its `main` member under the CPU launcher: it has one, with no launcher of its own");
  const out: PlanMember[] = [];
  const secretOwner = new Map<string, PodMember>();
  for (const [member, spec] of entries) {
    scriptOf(spec);
    const launcher = spec.launcher === undefined ? null : checkSandboxLauncher(spec);
    const memoryMi = Number(positiveInt(spec.limits.memory_mb, `pod member ${member}'s memory_mb`));
    const milli = cpuMilli(spec.limits.cpus);
    positiveInt(spec.limits.pids, `pod member ${member}'s pids`);
    let mounts: readonly SandboxMount[];
    try {
      mounts = checkSandboxMounts(spec.mounts);
    } catch (err) {
      throw err instanceof SandboxError ? new SandboxError(`pod member ${member}: ${err.message}`) : err;
    }
    const secretNames = [...checkSandboxEnv(spec.env).filter(([n]) => SECRET_ENV_RE.test(n)), ...checkSandboxSecrets(spec)].map(([n]) => n);
    for (const n of secretNames) {
      const other = secretOwner.get(n);
      if (other !== undefined) throw new SandboxError(`pod members ${other} and ${member} both read ${n} from the pod's one Secret`);
      secretOwner.set(n, member);
    }
    const root = launcher !== null || (timed && member === 'main');
    const uid = launcher !== null ? SANDBOX_UID : root ? TIMED_UID : POD_MEMBER_UIDS[member];
    const twin = out.find((m) => m.uid === uid);
    if (twin !== undefined) throw new SandboxError(`pod members ${twin.member} and ${member} would both run as uid ${uid}: the process cap counts a uid across the whole sandbox`);
    out.push({ member, spec, root, uid, cpuMilli: milli, memoryMi, secretNames, mounts });
  }
  return out;
}

/** A plan member's trees as its pod holds them (podPlanSpec): /bot, a launcher's /house, then its spec's mounts, each with its host directory. */
function memberTrees(m: Pick<PlanMember, 'spec' | 'mounts'>): Array<{ at: string; host: string; readOnly: boolean; returns: SandboxMount['returns'] }> {
  return [
    { at: '/bot', host: m.spec.codeDir, readOnly: true, returns: undefined },
    ...(m.spec.launcher === undefined ? [] : [{ at: HOUSE_DIR, host: m.spec.launcher.houseDir, readOnly: true, returns: undefined }]),
    ...m.mounts.map((x) => ({ at: x.at, host: x.host, readOnly: x.readOnly, returns: x.returns })),
  ];
}

/**
 * `total` spread over `limits` in proportion to them, in whole units that sum to it (largest remainder, the earlier
 * first on a tie), none past its limit: each its limit when the total reaches their sum.
 */
export function spreadRequests(total: number, limits: readonly number[]): number[] {
  const sum = limits.reduce((a, b) => a + b, 0);
  if (total >= sum) return [...limits];
  const out = limits.map((l) => Math.floor((total * l) / sum));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = limits.map((l, i) => [i, (total * l) % sum] as const).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  for (const [i] of order) {
    if (left === 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

/**
 * The labels of a plan's pod: the grader's mark, the sandbox role and kind, and the door's egress mark when it dials one.
 * None is unique to the pod or its trial (no makefun.trial, makefun.pod or makefun.net: no policy selects a plan pod by
 * one), so every plan pod of one kind shares one Cilium identity (the header's Pod identities); its owner is the
 * OWNER_ANNOTATION alone, what K8sOnePodTrialNetworks.reap finds it by.
 */
function planPodLabels(plan: SandboxPodPlan): Record<string, string> {
  return {
    [GRADER_LABEL_KEY]: GRADER_LABEL_VALUE,
    [ROLE_LABEL]: 'sandbox',
    [SANDBOX_KIND_LABEL]: 'program',
    ...(plan.doors === undefined ? {} : { [EGRESS_LABEL_KEY]: LANES_EGRESS_VALUE }),
  };
}

/** A container's security context: its user (root or not), every capability dropped but `caps`, no escalation, a read-only root. */
function containerSecurity(uid: number, caps: readonly string[]): Record<string, unknown> {
  return {
    runAsUser: uid,
    runAsGroup: uid,
    runAsNonRoot: uid !== 0,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: caps.length > 0 ? { drop: ['ALL'], add: [...caps] } : { drop: ['ALL'] },
  };
}

/**
 * The pod a SandboxPodPlan runs in (types.ts's header; deploy/k8s/README.md, Measured: two containers in one gVisor
 * pod): pure, so its every field is unit-tested exactly, sandboxPodSpec's sibling. Named opts.name
 * (makefun-sbx-<label>-<8 hex>); labelled as a program pod (makefun.grader=1, the sandbox role, makefun.io/sandbox=program),
 * the owner annotation (no label of it: planPodLabels) with a plan owner, makefun.egress=lanes (LANES_EGRESS_VALUE) when it has doors,
 * the creator annotation as every pod; placement, account, lifetime and grace as every sandbox pod's, and unless it is
 * timed the soft spread over its selector's nodes (SANDBOX_SPREAD) and opts.prefer's one preferred node term when it
 * has one (nodePreferenceAffinity); no DNS (dnsPolicy None), its names by hostAliases:
 * the plan's local names at LOOPBACK, its door names (`llm`, `house`, a scrape heat's hosts) at the door's address, the
 * lanes pod's. The pod's securityContext is seccomp RuntimeDefault alone; each container its own user: a member
 * POD_MEMBER_UIDS's, a launcher member or a timed `main` root with LAUNCHER_CAPS, `stage` and `watch` STAGE_UID's and
 * WATCH_UID's with no capability. No claim: every member mount point is a disk emptyDir of its own (diskVolume),
 * `<mount volume>-<member>` (memberVolumeName: `bot-entry`, `house-entry`, `output-entry`, `bot-env`, `env-data-env`,
 * `state-env`), a writable one with its sizeLimit (mountSizeLimit, the plan's D14); every host path it is staged from or
 * collected into lies under the data root (checkUnderDataRoot), as on the claim. One container a member, in the plan's order and
 * named for it, its member's runtime image (its imageDigest, else the pinned one), the shim as its PID 1 (shimCommand of
 * the member: each program arrives by exec, through `watch`'s link to it), SANDBOX_ENV, its env, its secrets (every *_API_KEY and secret by secretKeyRef from the pod's one
 * Secret, podPlanSecret) and each of its mounts' stand-ins (types.ts containerMountEnv, as a program pod's `main`); its
 * own volumes alone at its mount points (/bot and a launcher's /house read-only, each mount
 * read-only or not as its spec says; no other member's: the env's /env-data and /state never in `entry`), a /tmp
 * emptyDir of its own, `tmp-<member>`, a /dev/shm one, `shm-<member>` (SHM_SIZE), and the pod's agent-bin read-only at
 * AGENT_BIN_DIR (the shim's binary, AGENT_BIN_VOLUME: one disk emptyDir of AGENT_BIN_SIZE); limits its spec's; requests by
 * today's rule (CPU min(limit, CPU_REQUEST_MAX_MILLI), a timed `main`'s and a reserveCpu member's its limit; memory the
 * limit), or with the plan's `requests` that total spread over the members in proportion to their limits (spreadRequests:
 * never past a limit; a timed `main`'s and a reserveCpu member's CPU its limit still). ONE init container `stage`
 * (stageContainer: the agent image, `makefun-agent stage --install AGENT_BIN_INSTALL_DIR`, the agents' env alone:
 * opts.agent), every member volume read-write at memberMountPath's `/m/<member><mount point>` and agent-bin at
 * AGENT_BIN_INSTALL_DIR, with the resources of the member whose memory limit is the largest (the first of them), so it
 * adds nothing to the pod's. ONE `watch` last, in every plan pod (watchContainer: the agent image, `makefun-agent
 * serve`, the agents' env and MAKEFUN_AGENT_CONTAINERS, every member in the plan's order, its own requests and limits
 * with SHIM_MEMORY_MI more memory a member), every member's writable volumes read-only at their `/m/<member><mount
 * point>` (none: no volumeMounts); the plan's `meter` is read there (K8sPod.meter), never in a container of its own.
 * Refused (SandboxError): what checkSandboxPodPlan refuses, a name not of the plan's label, a member mount
 * checkSandboxMounts refuses (a writable one with no `returns`), a host path outside the data root, two members whose
 * programs would share a uid or whose Secret names meet.
 */
export function podPlanSpec(plan: SandboxPodPlan, opts: PodPlanOptions): K8sObject {
  const timed = opts.timed === true;
  const members = checkPlan(plan, opts.name, timed);
  const agent = checkPodAgent(opts.agent, opts.name);
  const images = opts.images ?? IMAGES;
  const secret = envSecretName(opts.name);
  const imageOf = (spec: PodMemberSpec): string => {
    const entry = imageFor(spec.runtime, images);
    return imageRef(entry, spec.imageDigest ?? entry.digest);
  };
  const requests = plan.requests;
  const cpuRequests = requests === undefined ? null : spreadRequests(requests.cpuMilli, members.map((m) => m.cpuMilli));
  const memoryRequests = requests === undefined ? null : spreadRequests(requests.memoryMi, members.map((m) => m.memoryMi));
  // Every member's mount points: its own disk volumes, held by `stage` (all) and `watch` (the writable ones) at its own paths.
  const disks: Array<Record<string, unknown>> = [];
  const staged: Array<{ name: string; mountPath: string }> = [];
  const watched: VolumeMount[] = [];
  const containers: Array<Record<string, unknown>> = members.map((m, i) => {
    const { member, spec } = m;
    const env: Array<Record<string, unknown>> = Object.entries(SANDBOX_ENV).map(([name, value]) => ({ name, value }));
    for (const [name, value] of checkSandboxEnv(spec.env)) {
      env.push(SECRET_ENV_RE.test(name) ? { name, valueFrom: { secretKeyRef: { name: secret, key: name } } } : { name, value });
    }
    for (const [name] of checkSandboxSecrets(spec)) env.push({ name, valueFrom: { secretKeyRef: { name: secret, key: name } } });
    // Each of its own mounts stands in for itself in this member's environment (types.ts containerMountEnv), as on a
    // program pod: /bot's and a launcher's /house have no stand-in (they are not MOUNT_POINTS), and /state's and
    // /record's stay unset (CONTAINER_UNSET_MOUNTS).
    for (const [name, value] of containerMountEnv(m.mounts)) env.push({ name, value });
    const mounts: VolumeMount[] = [];
    for (const t of memberTrees(m)) {
      // What is staged from, and what a writable mount is collected into (emptied first), lies under the data root.
      checkUnderDataRoot(opts.dataRoot, t.host);
      const name = memberVolumeName(member, t.at);
      disks.push(diskVolume(name, t.readOnly ? null : t.returns!.maxBytes));
      mounts.push({ name, mountPath: t.at, readOnly: t.readOnly });
      staged.push({ name, mountPath: memberMountPath(member, t.at) });
      if (!t.readOnly) watched.push({ name, mountPath: memberMountPath(member, t.at), readOnly: true });
    }
    mounts.push({ name: `${TMP_VOLUME}-${member}`, mountPath: '/tmp' });
    mounts.push({ name: `${SHM_VOLUME}-${member}`, mountPath: '/dev/shm' });
    mounts.push(agentBinMount());
    const timedMain = timed && member === 'main';
    const cpuRequest = timedMain || spec.reserveCpu === true ? m.cpuMilli : cpuRequests === null ? Math.min(m.cpuMilli, CPU_REQUEST_MAX_MILLI) : cpuRequests[i]!;
    const memoryRequest = memoryRequests === null ? m.memoryMi : memoryRequests[i]!;
    return {
      name: member,
      image: imageOf(spec),
      imagePullPolicy: IMAGE_PULL_POLICY,
      command: shimCommand(member),
      env,
      resources: {
        limits: { cpu: `${m.cpuMilli}m`, memory: `${m.memoryMi}Mi` },
        requests: { cpu: `${cpuRequest}m`, memory: `${memoryRequest}Mi` },
      },
      securityContext: containerSecurity(m.root ? 0 : m.uid, m.root ? LAUNCHER_CAPS : []),
      volumeMounts: mounts,
    };
  });
  // `stage` takes the resources of the member with the largest memory limit: an init container's then add nothing to the pod's.
  const largest = members.reduce((a, b) => (b.memoryMi > a.memoryMi ? b : a));
  const stage = stageContainer(agent, opts.name, containers[members.indexOf(largest)]!.resources as Record<string, unknown>, staged, true);
  // `watch` in every plan pod: each member's shim links to it, and no member exec goes before all have (bootFromAgent).
  containers.push(watchContainer(agent, opts.name, watched, members.map((m) => m.member)));
  const hostAliases: HostAlias[] = [];
  const local = plan.local ?? [];
  if (local.length > 0) hostAliases.push({ ip: LOOPBACK, hostnames: local.map((l) => l.name) });
  if (plan.doors !== undefined) hostAliases.push({ ip: plan.doors.address, hostnames: [...plan.doors.names] });
  const p: PodPlacement = opts;
  const spec: Record<string, unknown> = {};
  if (p.runtimeClass !== null) spec.runtimeClassName = p.runtimeClass;
  if (p.nodeSelector !== null && Object.keys(p.nodeSelector).length > 0) spec.nodeSelector = { ...p.nodeSelector };
  // A timed pod is pinned to its own selector's node: it is neither spread nor given a preference.
  const prefer = opts.prefer ?? null;
  if (timed && prefer !== null) throw new SandboxError("a timed pod's node is its own selector's: it takes no drawn placement");
  const trialAgent = opts.trialAgent === true;
  if (trialAgent && timed) throw new SandboxError("a timed pod is no trial agent's: only an untimed plan pod is kept off the app node as one");
  if (!timed) spec.topologySpreadConstraints = [structuredClone(SANDBOX_SPREAD)];
  if (prefer !== null) spec.affinity = nodePreferenceAffinity(prefer);
  spec.serviceAccountName = p.serviceAccount;
  spec.imagePullSecrets = [{ name: IMAGE_PULL_SECRET }];
  spec.automountServiceAccountToken = false;
  spec.enableServiceLinks = false;
  spec.restartPolicy = 'Never';
  spec.activeDeadlineSeconds = STALE_AFTER_MS / 1000;
  spec.terminationGracePeriodSeconds = 0;
  spec.dnsPolicy = 'None';
  spec.dnsConfig = { nameservers: [LOOPBACK], options: [{ ...NDOTS_0 }] };
  if (hostAliases.length > 0) spec.hostAliases = hostAliases;
  spec.securityContext = { seccompProfile: { type: 'RuntimeDefault' } };
  spec.initContainers = [stage];
  spec.containers = containers;
  spec.volumes = [
    ...disks,
    ...members.flatMap((m) => [
      { name: `${TMP_VOLUME}-${m.member}`, emptyDir: { medium: 'Memory', sizeLimit: TMP_SIZE } },
      { name: `${SHM_VOLUME}-${m.member}`, emptyDir: { medium: 'Memory', sizeLimit: SHM_SIZE } },
    ]),
    agentBinVolume(),
  ];
  const owner = plan.owner ?? null;
  const creator = p.creator === undefined || p.creator === null ? null : checkName(p.creator, DNS_SUBDOMAIN_RE, 'creator pod');
  const annotations = { ...ownerAnnotations(owner), ...(creator === null ? {} : { [CREATOR_ANNOTATION]: creator }) };
  const marks: ObjectMarks = { labels: { ...planPodLabels(plan), ...(trialAgent ? { [TRIAL_AGENT_LABEL]: 'true' } : {}) }, ...(Object.keys(annotations).length === 0 ? {} : { annotations }) };
  return { apiVersion: 'v1', kind: 'Pod', metadata: metadataOf(opts.name, p.namespace, marks), spec };
}

/**
 * The one Secret of a plan's pod, `<pod>-env` (sandboxEnvSecret's sibling): its agent key MAKEFUN_AGENT_KEY (podSecret:
 * `opts.agentKey`, else a fresh K), which only `stage` and `watch` read, and every member's *_API_KEY env values and
 * secrets (no name two members share: checkPlan), which each member's container reads, all by secretKeyRef, in name
 * order; labelled with the grader's mark, makefun.pod and the trial owner's mark, annotated with the owner. Made before
 * its pod, and owned by it once patched (ownerPatch), as every pod's Secret is.
 */
export function podPlanSecret(plan: SandboxPodPlan, opts: { name: string; namespace: string; agentKey?: string }): K8sObject {
  const members = checkPlan(plan, opts.name, false);
  const keys: Array<[string, string]> = [];
  for (const { spec } of members) {
    keys.push(...checkSandboxEnv(spec.env).filter(([n]) => SECRET_ENV_RE.test(n)), ...checkSandboxSecrets(spec));
  }
  const owner = plan.owner ?? null;
  const annotations = ownerAnnotations(owner);
  const marks: ObjectMarks = {
    labels: { [GRADER_LABEL_KEY]: GRADER_LABEL_VALUE, [POD_LABEL]: opts.name, ...(owner === null ? {} : { [OWNER_LABEL]: ownerLabel(owner) }) },
    ...(annotations === undefined ? {} : { annotations }),
  };
  return podSecret(keys, { name: opts.name, namespace: opts.namespace, ...(opts.agentKey === undefined ? {} : { agentKey: opts.agentKey }), ...marks });
}

/** Where the LLM gateway is, from its origin: its host (an address or a name) and port. */
export function gatewayTarget(origin: string): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new SandboxError(`LLM gateway ${JSON.stringify(origin)} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SandboxError(`LLM gateway ${JSON.stringify(origin)} is not http(s)`);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return { host, port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port) };
}

/** A forwarder pod's own egress to the LLM gateway (the header): its addresses on its port, nothing else. */
export function gatewayPolicy(opts: { name: string; namespace: string; addresses: readonly string[]; port: number } & ObjectMarks): K8sObject {
  if (opts.addresses.length === 0) throw new SandboxError('the LLM gateway has no address');
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: metadataOf(`${opts.name}${GATEWAY_POLICY_SUFFIX}`, opts.namespace, opts),
    spec: {
      podSelector: { matchLabels: { [POD_LABEL]: opts.name } },
      policyTypes: ['Egress'],
      egress: [
        {
          to: opts.addresses.map((a) => {
            if (isIP(a) === 0) throw new SandboxError(`LLM gateway address ${JSON.stringify(a)} is not an IP address`);
            return { ipBlock: { cidr: `${a}/${isIP(a) === 6 ? 128 : 32}` } };
          }),
          ports: [{ protocol: 'TCP', port: opts.port }],
        },
      ],
    },
  };
}

/** True for an agent trial's forwarder, the entry's or the house lane's: on the egress policy, under its alias (network.ts trialAttachment). */
function isForwarder(network: SandboxNetwork | null): boolean {
  const aliases = network?.aliases ?? [];
  return network !== null && network.egress === true && (aliases.includes(ROLE_ALIASES.forwarder) || aliases.includes(ROLE_ALIASES.house));
}

/**
 * True for an agent trial's forwarder whether it forwards or replays (a cassette's forwarder is on the trial network
 * alone, grader/agent.ts forwarderNet): its alias `llm` or `house`, egress or not. Its CPU request is
 * FORWARDER_CPU_REQUEST_MILLI's (programCpuRequestMilli); its placement and policy stay isForwarder's.
 */
export function isTrialForwarder(network: SandboxNetwork | null): boolean {
  const aliases = network?.aliases ?? [];
  return aliases.includes(ROLE_ALIASES.forwarder) || aliases.includes(ROLE_ALIASES.house);
}

// ---------------------------------------------------------------- the name registry

/**
 * The trial networks of one K8sSandbox: each network's owner (TrialNetworks.create's, whole: its pods carry
 * ownerLabel of it as OWNER_LABEL and it as OWNER_ANNOTATION) and, for each of its pods once Ready, the pod's
 * IP and the names it answers to there (its aliases, then its hosts) and the port it serves the trial on (a service's; null for the entry). A networked spawn's pod
 * gets every other registered pod's names as hostAliases, in the order the pods registered (Docker's aliases
 * on a trial network); an entry's dials the served ones before its program runs (POLICY_WAIT_MS).
 */
export class PodNames {
  readonly #pods = new Map<string, Map<string, { ip: string; names: readonly string[]; port: number | null }>>();
  readonly #owners = new Map<string, string>();

  /** Record the network's owner (a SandboxError for what is no trial owner): its pods are labelled ownerLabel of it. */
  setOwner(network: string, owner: string): void {
    ownerLabel(owner);
    this.#owners.set(network, owner);
  }

  ownerOf(network: string): string | null {
    return this.#owners.get(network) ?? null;
  }

  register(network: string, pod: string, ip: string, names: readonly string[], port: number | null = null): void {
    if (isIP(ip) === 0) throw new SandboxError(`pod ${pod}'s IP ${JSON.stringify(ip)} is not an address`);
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new SandboxError(`pod ${pod}'s port ${port} is out of range`);
    let pods = this.#pods.get(network);
    if (pods === undefined) this.#pods.set(network, (pods = new Map()));
    pods.set(pod, { ip, names: [...names], port });
  }

  unregister(network: string, pod: string): void {
    const pods = this.#pods.get(network);
    if (pods === undefined) return;
    pods.delete(pod);
    if (pods.size === 0) this.#pods.delete(network);
  }

  /** Drop a network: its owner and every pod of it. */
  forget(network: string): void {
    this.#pods.delete(network);
    this.#owners.delete(network);
  }

  hostAliases(network: string): HostAlias[] {
    return [...(this.#pods.get(network)?.values() ?? [])].filter((p) => p.names.length > 0).map((p) => ({ ip: p.ip, hostnames: [...p.names] }));
  }

  /** The network's pods that serve it, in the order they registered: each one's address, port and names. */
  served(network: string): ServedPeer[] {
    return [...(this.#pods.get(network)?.values() ?? [])].flatMap((p) => (p.port === null ? [] : [{ ip: p.ip, port: p.port, names: [...p.names] }]));
  }
}

/** A registered pod that serves its trial (PodNames.served). */
export interface ServedPeer {
  ip: string;
  port: number;
  names: string[];
}

/**
 * The port a pod on `network` serves its trial on: a scrape gateway's (it answers for real hosts) or an agent
 * trial's store or forwarder (the house lane's too); null for the entry, which serves nothing.
 */
export function servedPort(network: SandboxNetwork): number | null {
  if ((network.hosts ?? []).length > 0) return SCRAPE_GATEWAY_PORT;
  const aliases = network.aliases ?? [];
  return aliases.includes(ROLE_ALIASES.env) || aliases.includes(ROLE_ALIASES.forwarder) || aliases.includes(ROLE_ALIASES.house) ? SERVICE_PORT : null;
}

/** True for a trial's entry (network.ts trialAttachment, scrapeAttachment): the pod that dials the others as it starts. */
export function isEntry(network: SandboxNetwork | null): boolean {
  return network !== null && (network.aliases ?? []).includes(ROLE_ALIASES.entry);
}

// ---------------------------------------------------------------- the exit sentinel

/**
 * The exec's stdout with the wrapper's start line `RS<nonce>\n` and its sentinel `RS<nonce><status>\n` taken
 * out (the header): push() returns what can be passed on now, and nothing once the sentinel came. All of a
 * chunk is passed on at once unless it ends in what could start either (RS and the nonce's first digits), so
 * a line a service prints is never held back; end() returns what is still held when the stream ends without
 * a sentinel (one cut short is dropped: it is the wrapper's). `started` is set once the start line came (the
 * first only: the program runs after it), `rc` is the status once the sentinel came. A timed pod's wrapper
 * (TIMED_EXEC_WRAPPER) prints `RS<nonce>c<µs>\n` between the two, the CPU launcher's reading: taken out too, the first
 * after the start line kept as `cpuUs`. A session case's wrapper (SESSION_EXEC_WRAPPER) prints `RS<nonce>i<word>\n`
 * there, the case launcher's report (at most SESSION_REPORT_MAX lower-case letters): taken out too, the first after the
 * start line kept as `report`. Before the start line, a wrapper that found its exec claimed by another try (the
 * once-guard: EXEC_CLAIM_LINES) prints `RS<nonce>claimed\n` and nothing else: taken out too, as `claimed`.
 */
export class SentinelScanner {
  /** RS and the nonce: what starts the start line and the sentinel. */
  readonly #nonce: Buffer;
  #held: Buffer = EMPTY;
  #started = false;
  #rc: number | null = null;
  #cpu: bigint | null = null;
  #report: string | null = null;
  #claimed = false;

  constructor(nonce: string) {
    if (!NONCE_RE.test(nonce)) throw new SandboxError('an exec nonce is 32 lowercase hex digits');
    this.#nonce = Buffer.from(`${SENTINEL_MARK}${nonce}`, 'latin1');
  }

  get started(): boolean {
    return this.#started;
  }

  get rc(): number | null {
    return this.#rc;
  }

  /** The CPU launcher's reading, µs, once its line came (a timed pod's: TIMED_EXEC_WRAPPER); null before or without one. */
  get cpuUs(): bigint | null {
    return this.#cpu;
  }

  /** The case launcher's report word, once its line came (a session case's: SESSION_EXEC_WRAPPER); null before or without one. */
  get report(): string | null {
    return this.#report;
  }

  /** The wrapper found its exec claimed by another try (the once-guard) and ran nothing: its refusal line came. */
  get claimed(): boolean {
    return this.#claimed;
  }

  push(chunk: Buffer): Buffer {
    if (this.#rc !== null) return EMPTY;
    const buf = this.#held.length === 0 ? chunk : Buffer.concat([this.#held, chunk]);
    const out: Buffer[] = [];
    let from = 0;
    for (;;) {
      const at = buf.indexOf(this.#nonce, from);
      if (at < 0) {
        const keep = this.#startAtEnd(buf, from);
        out.push(buf.subarray(from, buf.length - keep));
        this.#held = Buffer.from(buf.subarray(buf.length - keep));
        return Buffer.concat(out);
      }
      const after = at + this.#nonce.length;
      // Enough for the longest of the three lines: `c`, the reading's digits and the newline.
      const tail = buf.subarray(after, after + CPU_READING_DIGITS + 2).toString('latin1');
      const m = /^(\d{1,3})\n/.exec(tail);
      if (m !== null && Number(m[1]) <= 255) {
        out.push(buf.subarray(from, at));
        this.#rc = Number(m[1]);
        this.#held = EMPTY;
        return Buffer.concat(out);
      }
      if (!this.#started && tail.startsWith(CLAIMED_LINE)) {
        out.push(buf.subarray(from, at));
        this.#claimed = true;
        from = after + CLAIMED_LINE.length;
        continue;
      }
      if (!this.#started && tail.startsWith('\n')) {
        out.push(buf.subarray(from, at));
        this.#started = true;
        from = after + 1;
        continue;
      }
      const cpu = this.#started ? CPU_LINE_RE.exec(tail) : null;
      if (cpu !== null) {
        out.push(buf.subarray(from, at));
        this.#cpu ??= BigInt(cpu[1]!);
        from = after + cpu[0].length;
        continue;
      }
      const report = this.#started ? REPORT_LINE_RE.exec(tail) : null;
      if (report !== null) {
        out.push(buf.subarray(from, at));
        this.#report ??= report[1]!;
        from = after + report[0].length;
        continue;
      }
      if ((/^\d{0,3}$/.test(tail) || (this.#started ? CPU_LINE_SO_FAR_RE.test(tail) || REPORT_SO_FAR_RE.test(tail) : CLAIMED_LINE.startsWith(tail))) && after + tail.length === buf.length) {
        // The start line, the refusal, the CPU line, the report line or the sentinel so far: held until its newline.
        out.push(buf.subarray(from, at));
        this.#held = Buffer.from(buf.subarray(at));
        return Buffer.concat(out);
      }
      // The nonce, but not the wrapper's line: the program's bytes after all.
      out.push(buf.subarray(from, at + 1));
      from = at + 1;
    }
  }

  /** How many of `buf`'s last bytes (from `from` on) could start the sentinel: the longest suffix that is a prefix of it. */
  #startAtEnd(buf: Buffer, from: number): number {
    const mark = this.#nonce[0]!;
    for (let i = Math.max(from, buf.length - this.#nonce.length + 1); i < buf.length; i++) {
      if (buf[i] === mark && buf.subarray(i).equals(this.#nonce.subarray(0, buf.length - i))) return buf.length - i;
    }
    return 0;
  }

  end(): Buffer {
    if (this.#rc !== null) return EMPTY;
    const held = this.#held;
    this.#held = EMPTY;
    if (held.length >= this.#nonce.length && held.subarray(0, this.#nonce.length).equals(this.#nonce)) return EMPTY;
    return held;
  }
}

/**
 * Pass `src` on to `dst` (through `scanner` when given) with its backpressure, until `src` ends; then end
 * `dst`. A `dst` its reader destroyed stops nothing: the rest is drained unread. `onStart` runs once the
 * scanner has the start line, `onSentinel` once it has the status.
 */
export function forward(
  src: Readable,
  dst: PassThrough,
  scanner: SentinelScanner | null,
  onSentinel: () => void,
  onStart: () => void = () => undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let paused = false;
    const put = (b: Buffer): void => {
      if (b.length === 0 || dst.destroyed || dst.writableEnded) return;
      if (!dst.write(b) && !paused) {
        paused = true;
        src.pause();
        dst.once('drain', () => {
          paused = false;
          src.resume();
        });
      }
    };
    dst.once('close', () => src.resume());
    src.on('data', (b: Buffer) => {
      if (scanner === null) return put(b);
      const had = scanner.rc !== null;
      const began = scanner.started;
      const out = scanner.push(b);
      if (!began && scanner.started) onStart();
      put(out);
      if (!had && scanner.rc !== null) onSentinel();
    });
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      if (scanner !== null) put(scanner.end());
      if (!dst.writableEnded && !dst.destroyed) dst.end();
      resolve();
    };
    src.once('end', end);
    src.once('close', end);
    src.once('error', end);
  });
}

/**
 * How a process's execs reach the container its program runs in (the header's exec): agentMember, its pod's `watch`
 * agent session, which relays each to the container's shim (every pod the driver makes: a program pod's `main`, a
 * case session's among them, and each plan member). None crosses the control plane or holds a slot of the pace.
 */
export interface MemberExec {
  /** One exec of `argv` in the container over the pod's agent, its stdin open until the caller ends it. */
  stream(argv: readonly string[]): KubectlChild;
  /** One exec of `argv` to its end, its stdin closed: cut at `timeoutMs` from the call, or once `signal` aborts. */
  run(argv: readonly string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<KubectlResult>;
}

/**
 * `container`'s execs over its pod's `watch` agent session (`agent`; null: none, every exec ended at once, nothing sent):
 * agent-client.ts AgentSession.stream with the container named, which `watch` relays to that container's shim. Sent
 * once, never again (agent-client.ts's no re-send), and holding no slot of the pace.
 */
export function agentMember(agent: PodAgentSession | null, pod: string, container: string): MemberExec {
  const none = (): KubectlChild => unstartedChild(`pod ${pod} has no ${WATCH_CONTAINER} agent session to exec in ${container} through`);
  const stream = (argv: readonly string[]): KubectlChild => (agent === null ? none() : agent.stream(container, argv));
  return { stream, run: (argv, opts) => runChild(stream(argv), opts) };
}

/**
 * `child` (one exec, just made) to its end as a KubectlResult: its stdin closed, stdout and stderr whole, killed at
 * `timeoutMs` or once `signal` aborts (`error` then says so); any other end the exec's own words on `error`.
 */
async function runChild(child: KubectlChild, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<KubectlResult> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (b: Buffer) => out.push(b));
  child.stderr.on('data', (b: Buffer) => err.push(b));
  child.stdin.on('error', () => undefined);
  child.stdin.end();
  let cut: string | null = null;
  const stop = (why: string): void => {
    cut ??= why;
    child.kill();
  };
  const timer = setTimeout(() => stop(`no exit within ${opts.timeoutMs} ms`), opts.timeoutMs);
  timer.unref();
  const onAbort = (): void => stop('cut off');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted === true) onAbort();
  const end = await child.closed;
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onAbort);
  const res: KubectlResult = { code: end.code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  if (cut !== null) res.error = `the exec: ${cut}`;
  else if (end.error !== undefined) res.error = end.error;
  else if (end.code === null) res.error = `the exec ended by ${end.signal ?? 'nothing'}`;
  return res;
}

/** How an exec with no sentinel ended, for a failure's words: its own error, else its status or signal. */
function execEndWords(end: KubectlEnd): string {
  return end.error ?? (end.signal === null ? `the exec exited ${end.code}` : `the exec ended by ${end.signal}`);
}

/** A program's exec as runProgramExec runs it (K8sProcess's and a plan pod member's, K8sPodProcess's). */
interface ProgramExecRun {
  /** How it reaches the program's container (agentMember). */
  member: MemberExec;
  ctx: Pick<K8sContext, 'execStartTimeoutMs'>;
  /** The exec's argv (`/bin/sh -c <wrapper> sh <pids> <argv...>`); its nonce goes on stdin. */
  command: readonly string[];
  /**
   * The program's own variables (the header's Exec env: a program pod's spec's secrets), carried after the nonce on
   * stdin's first line (execEnvWords) and exported by the wrapper; absent or empty: the nonce alone.
   */
  env?: ReadonlyArray<readonly [string, string]>;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  /** Killed (a member's sandbox out of memory too): an exec made then is killed at once. */
  killed: () => boolean;
  /** The exec's child, as it is made: the one a kill reaches. */
  onChild: (child: KubectlChild) => void;
  /** The start line came: the program runs. */
  onStart: () => void;
  /** The sentinel came: the exec has EXEC_DRAIN_MS more, then is cut. */
  onSentinel: () => void;
}

/** How a program's exec ended (runProgramExec). */
interface ProgramExecEnd {
  child: KubectlChild;
  scanner: SentinelScanner;
  end: KubectlEnd;
  /** Cut at its start bound, with no start line. */
  unstarted: boolean;
  /** Refused by the once-guard (EXEC_CLAIM_LINES): its exec id already claimed in the container, so it ran nothing. */
  claimed: boolean;
  /** Its start bound, the failure's words (`within <startMs> ms`). */
  startMs: number;
  /** Settles once its stdout and stderr have been passed on. */
  flushed: Promise<void>;
}

/**
 * A program's exec (the header's exec), ONE exec sent once: a nonce of its own and the program's variables on its stdin's
 * first line, then `o.stdin` piped in; its stdout through a SentinelScanner, its stderr passed on. With no start line
 * EXEC_START_TIMEOUT_MS (ctx.execStartTimeoutMs) after it was made it is killed (`unstarted`), and never made again: an
 * exec over the agent that did not end with its trailer may have run its program (agent-client.ts's no re-send).
 * Resolves once the exec has ended. It holds no slot of the pace and meets nothing of the control plane (the header's
 * pace). The caller stops its watches, awaits `flushed`, then reads the scanner.
 */
async function runProgramExec(o: ProgramExecRun): Promise<ProgramExecEnd> {
  const startMs = o.ctx.execStartTimeoutMs ?? EXEC_START_TIMEOUT_MS;
  // The program's own variables after the nonce (a SandboxError for a bad one, before anything is sent).
  const envWords = execEnvWords(o.env ?? []);
  const nonce = randomBytes(16).toString('hex');
  const scanner = new SentinelScanner(nonce);
  const child = o.member.stream(o.command);
  o.onChild(child);
  child.stdin.on('error', () => undefined);
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  // The nonce on a line of its own, the program's variables after it, before anything of the program's: the wrapper
  // reads the line, the program never sees it (its variables only as its environment).
  child.stdin.write(`${nonce}${envWords}\n`);
  if (o.stdin.readableEnded) child.stdin.end();
  else o.stdin.pipe(child.stdin);
  // A cut that came before the exec was made, or while it was.
  if (o.killed()) child.kill();
  let drain: NodeJS.Timeout | undefined;
  let unstarted = false;
  const startCut = setTimeout(() => {
    unstarted = true;
    child.kill();
  }, startMs);
  const err = forward(child.stderr, o.stderr, null, () => undefined);
  const out = forward(
    child.stdout,
    o.stdout,
    scanner,
    () => {
      o.onSentinel();
      drain = setTimeout(() => child.kill(), EXEC_DRAIN_MS);
      drain.unref();
    },
    () => {
      clearTimeout(startCut);
      o.onStart();
    },
  );
  const end = await child.closed;
  clearTimeout(drain);
  clearTimeout(startCut);
  const claimed = !scanner.started && (scanner.claimed || (end.error === undefined && end.signal === null && end.code === EXEC_CLAIMED_STATUS));
  return { child, scanner, end, unstarted, claimed, startMs, flushed: Promise.all([out, err]).then(() => undefined) };
}

/**
 * The failure of an exec the once-guard refused (ProgramExecEnd.claimed): its exec id was already claimed in the
 * container, so its wrapper ran nothing, and the exec is never sent again.
 */
function claimedWords(at: string): string {
  return `${at}: the wrapper found the exec's id already claimed in its container and ran nothing (the once-guard); an exec is sent once, never again`;
}

/**
 * Settles once `r`'s reader has had everything (its 'end'), as a child process's 'close' waits for its stdio:
 * a stream nobody reads is resumed first (Node's flushStdio), so it never holds the exit back.
 */
function delivered(r: Readable): Promise<void> {
  if (r.readableEnded || r.destroyed) return Promise.resolve();
  if (r.listenerCount('data') === 0 && r.listenerCount('readable') === 0) r.resume();
  return new Promise<void>((resolve) => {
    r.once('end', () => resolve());
    r.once('close', () => resolve());
  });
}

// ---------------------------------------------------------------- reading a pod

interface ContainerStateJson {
  waiting?: { reason?: string; message?: string };
  running?: unknown;
  terminated?: { reason?: string; message?: string; exitCode?: number };
}

/** The part of `kubectl get pod -o json` the driver reads. */
export interface PodJson {
  /** Its deletionTimestamp once something deleted it (beingDeleted; mainKilledFromWithin). */
  metadata?: { deletionTimestamp?: unknown };
  /** The node the scheduler placed it on, once it has (PodWait's `node`). */
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    podIP?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    containerStatuses?: Array<{ name?: string; state?: ContainerStateJson; lastState?: ContainerStateJson }>;
    /** A program pod's `stage` (the header). */
    initContainerStatuses?: Array<{ name?: string; state?: ContainerStateJson; lastState?: ContainerStateJson }>;
  };
}

export type PodRead = { pod: PodJson } | { gone: string } | { error: string };

/** The part of `kubectl get nodes -o json`'s items K8sSandbox.nodePodRoom reads (NODE_LIST_KEEP). */
export interface NodeJson {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { unschedulable?: boolean; taints?: Array<{ key?: string; value?: string; effect?: string }>; podCIDR?: string; podCIDRs?: string[] };
  status?: { allocatable?: { pods?: string; cpu?: string; memory?: string }; conditions?: Array<{ type?: string; status?: string }> };
}

/** One node's free places as K8sSandbox.nodePodRooms reads them: its name, its labels (what a pod's node selector asks for), and the places free on it. */
export interface NodeRoom {
  node: string;
  labels: Readonly<Record<string, string>>;
  /**
   * The places an untimed sandbox pod may use: on an app node under a sandbox cap, appNodeCappedRoom of `uncapped` (a
   * race pod, which the cap does not count, reads `uncapped`: racePodPreference).
   */
  free: number;
  /**
   * Only on a node carrying APP_NODE_LABEL read under a sandbox cap (K8sSandboxOptions.appNodeSandboxPods): its free
   * places before the cap, what `free` would be without one. Absent: no cap, and `free` is all of them.
   */
  uncapped?: number;
  /**
   * The node's allocatable CPU in millicores (status.allocatable.cpu, cpuQuantityMilli): what a width sized from the
   * nodes' CPU sums (roomCpuMilli). Absent when the node prints none, or none this reads as a quantity.
   */
  cpuMilli?: number;
}

/**
 * The taint effects that keep a sandbox pod off a node: no sandbox pod carries a toleration (deploy/k8s/cluster/README.md:
 * the gVisor nodes carry no taints), so the scheduler places none on a node with either, and a node going away carries
 * one (`node.kubernetes.io/not-ready` or `unreachable` NoExecute, `node.kubernetes.io/unschedulable` NoSchedule, a
 * drain's or an autoscaler's own). PreferNoSchedule refuses nothing and is not one.
 */
export const ROOM_REFUSING_TAINT_EFFECTS: readonly string[] = Object.freeze(['NoSchedule', 'NoExecute']);

/**
 * Whether a node is room at all (the header's Room on the node), or why not: cordoned (spec.unschedulable), Not Ready
 * (its Ready condition says anything but True: False, or Unknown once the kubelet stops posting), or tainted with an
 * effect that keeps a sandbox pod off it (ROOM_REFUSING_TAINT_EFFECTS). A node that lists no Ready condition at all is
 * not read as Not Ready: nothing says it is. The scheduler would place nothing there, so its free slots are no room, and
 * a burst run's box that is joining, being drained or gone stops counting before its pods could be refused.
 */
export function nodeRefusal(node: NodeJson): string | null {
  if (node.spec?.unschedulable === true) return 'cordoned';
  const ready = (node.status?.conditions ?? []).find((c) => c?.type === 'Ready');
  if (ready !== undefined && ready.status !== 'True') return `Ready ${ready.status ?? 'unset'}`;
  const taint = (node.spec?.taints ?? []).find((t) => ROOM_REFUSING_TAINT_EFFECTS.includes(t?.effect ?? ''));
  if (taint !== undefined) return `tainted ${taint.key ?? ''}${taint.value === undefined || taint.value === '' ? '' : `=${taint.value}`}:${taint.effect}`;
  return null;
}

/**
 * A Kubernetes CPU quantity (status.allocatable.cpu: `64`, `63500m`, `0.5`) in whole millicores, rounded down; null
 * for anything else (an empty or negative one, an exponent or a binary suffix, which no node prints for CPU).
 */
export function cpuQuantityMilli(quantity: string | undefined): number | null {
  if (typeof quantity !== 'string') return null;
  const milli = /^(\d+)m$/.exec(quantity);
  if (milli !== null) return Number.isSafeInteger(Number(milli[1])) ? Number(milli[1]) : null;
  if (!/^\d+(\.\d+)?$/.test(quantity)) return null;
  const value = Math.floor(Number(quantity) * 1000);
  return Number.isSafeInteger(value) ? value : null;
}

/** The allocatable CPU of the nodes a room read answered (NodeRoom.cpuMilli), in millicores: a node that printed none adds nothing. */
export function roomCpuMilli(rooms: readonly NodeRoom[]): number {
  return rooms.reduce((sum, r) => sum + (r.cpuMilli ?? 0), 0);
}

/** One node's allocatable memory as the room read answers it (nodeMemoryMi): its name and the figure in MiB. */
export interface NodeMemoryRoom {
  node: string;
  /** status.allocatable.memory in whole MiB (memoryQuantityMi). */
  memoryMi: number;
}

/** The bytes a Kubernetes memory unit is worth (a memory quantity's suffix; none is bytes). */
const MEMORY_QUANTITY_UNITS: Readonly<Record<string, number>> = Object.freeze({
  '': 1,
  K: 1_000,
  M: 1_000_000,
  G: 1_000_000_000,
  T: 1_000_000_000_000,
  Ki: 1_024,
  Mi: 1_048_576,
  Gi: 1_073_741_824,
  Ti: 1_099_511_627_776,
});

/**
 * A Kubernetes memory quantity (status.allocatable.memory: `187585Mi`, `131869004Ki`, `197629M`, plain bytes) in whole
 * MiB, rounded down; null for anything else (empty, negative, a fraction, an exponent or a unit it does not know). The
 * scheduler sums what a pod asks of memory against this figure, so a room's memory term reads it as the CPU's is read
 * (cpuQuantityMilli).
 */
export function memoryQuantityMi(quantity: string | undefined): number | null {
  if (typeof quantity !== 'string') return null;
  const m = /^(\d+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(quantity);
  if (m === null) return null;
  const count = Number(m[1]);
  if (!Number.isSafeInteger(count)) return null;
  const bytes = count * MEMORY_QUANTITY_UNITS[m[2] ?? ''];
  if (!Number.isSafeInteger(bytes)) return null;
  const mi = Math.floor(bytes / 1_048_576);
  return Number.isSafeInteger(mi) ? mi : null;
}

/**
 * How the room read counts each node's pods (K8sSandboxOptions.roomList): `per-node`, a `-o name` list of its bound pods
 * and, for a ranged node, a `-o json` list of its finished pods with an address, each by a field selector on the
 * node (and a third, of its capped sandbox pods, on an app node under a cap): two or three lists a node, each a Table
 * of names when asked of the API server in-process (k8s-count.ts), where the cluster's pods run to megabytes (s18's
 * 1.07 MB list); or `cluster`, ONE `-o json` list of every bound pod in every namespace (ROOM_POD_LIST_KEEP), counted
 * per node here by the same rules, for a small cluster read by a kubectl spawned for each list (a burst grader under
 * KUBECONFIG: about 23 spawns a read at 10 nodes, every NODE_ROOM_CACHE_MS, per node, against 2 whatever the nodes).
 */
export type RoomList = 'per-node' | 'cluster';

/**
 * What the room read's one pod list (RoomList `cluster`) reads of each pod: finishedPodHoldsAddress's fields
 * (POD_LIST_KEEP's), the node it is bound to, whether it is on the host's network, and the labels CAPPED_SANDBOX_SELECTOR
 * selects on.
 */
export const ROOM_POD_LIST_KEEP: ListKeep = Object.freeze([
  ...POD_LIST_KEEP,
  ['spec', 'nodeName'],
  ['metadata', 'labels', ROLE_LABEL],
  ['metadata', 'labels', SANDBOX_KIND_LABEL],
  ['metadata', 'labels', TRIAL_AGENT_LABEL],
]);

/** A pod of the room read's one list (ROOM_POD_LIST_KEEP). */
interface RoomPodJson extends FinishedPodJson {
  metadata?: FinishedPodJson['metadata'] & { labels?: Record<string, string> };
  spec?: FinishedPodJson['spec'] & { nodeName?: string };
}

/** One node's pods as the room read counts them: bound and not finished, finished still holding an address, and the app node's capped sandbox pods. */
interface NodePodCounts {
  used: number;
  held: number;
  capped: number;
}

/**
 * Each node's pod counts from the room read's one list of every bound pod (RoomList `cluster`), by the rules the
 * per-node lists' selectors apply on the API server: `used` a pod whose phase is neither Succeeded nor Failed
 * (`status.phase!=Succeeded,status.phase!=Failed`); `held` one FINISHED_WITH_ADDRESS_SELECTOR picks that
 * finishedPodHoldsAddress counts at `now`; `capped` a used one CAPPED_SANDBOX_SELECTOR picks.
 */
export function nodePodCountsOf(pods: readonly unknown[], now: number): Map<string, NodePodCounts> {
  const counts = new Map<string, NodePodCounts>();
  for (const item of pods) {
    const pod = (item ?? {}) as RoomPodJson;
    const node = pod.spec?.nodeName;
    if (typeof node !== 'string' || node === '') continue;
    const c = counts.get(node) ?? { used: 0, held: 0, capped: 0 };
    counts.set(node, c);
    const phase = pod.status?.phase;
    if (phase !== 'Succeeded' && phase !== 'Failed') {
      c.used += 1;
      const labels = pod.metadata?.labels ?? {};
      if (labels[ROLE_LABEL] === 'sandbox' && labels[SANDBOX_KIND_LABEL] !== 'race' && !Object.hasOwn(labels, TRIAL_AGENT_LABEL)) c.capped += 1;
    }
    const picked = phase !== 'Pending' && phase !== 'Running' && phase !== 'Unknown' && (pod.status?.podIP ?? '') !== '' && pod.spec?.hostNetwork !== true;
    if (picked && finishedPodHoldsAddress(pod, now)) c.held += 1;
  }
  return counts;
}

/** The part of a finished pod (`kubectl get pods -o json`'s items) finishedPodHoldsAddress reads. */
export interface FinishedPodJson {
  metadata?: { deletionTimestamp?: unknown };
  spec?: { hostNetwork?: boolean };
  status?: {
    phase?: string;
    podIP?: string;
    conditions?: Array<{ lastTransitionTime?: string }>;
    containerStatuses?: Array<{ state?: { terminated?: { finishedAt?: string } } }>;
    initContainerStatuses?: Array<{ state?: { terminated?: { finishedAt?: string } } }>;
  };
}

/**
 * Whether a finished pod (phase Succeeded or Failed) the API still lists holds an address of its node's pod range at
 * `now` (the header's Room on the node): only one with a status.podIP and not on the host's network, and of those one
 * being deleted (metadata.deletionTimestamp set: the object goes once the kubelet has torn its sandbox down), or one
 * nothing deleted that finished less than ADDRESS_RELEASE_MS ago. It finished when the last of its containers did
 * (state.terminated.finishedAt), else, no container saying, when its last condition changed; a pod that says neither,
 * or a time that is no date, is counted, since nothing shows its address free. A pod not finished is never one: the
 * bound read counts it.
 */
export function finishedPodHoldsAddress(pod: FinishedPodJson, now: number): boolean {
  const status = pod.status;
  if (status === undefined || (status.phase !== 'Succeeded' && status.phase !== 'Failed')) return false;
  if (typeof status.podIP !== 'string' || status.podIP === '' || pod.spec?.hostNetwork === true) return false;
  const deleted = pod.metadata?.deletionTimestamp;
  if (deleted !== undefined && deleted !== null) return true;
  const latest = (times: Array<string | undefined>): number | null => {
    let at: number | null = null;
    for (const t of times) {
      if (t === undefined) continue;
      const ms = Date.parse(t);
      if (Number.isNaN(ms)) return Number.NaN;
      at = at === null ? ms : Math.max(at, ms);
    }
    return at;
  };
  const finished =
    latest([...(status.containerStatuses ?? []), ...(status.initContainerStatuses ?? [])].map((c) => c?.state?.terminated?.finishedAt)) ??
    latest((status.conditions ?? []).map((c) => c?.lastTransitionTime));
  if (finished === null || Number.isNaN(finished)) return true;
  return now - finished < ADDRESS_RELEASE_MS;
}

/**
 * The addresses an IPv4 pod range gives pods: 2^(32-prefix) less the network and broadcast addresses. Null when the
 * range is missing or is no IPv4 CIDR (an IPv6 range included), which leaves the node's allocatable the only bound.
 */
function podRangeAddresses(cidr: string | undefined): number | null {
  if (cidr === undefined) return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (m === null) return null;
  if (m.slice(1, 5).some((o) => Number(o) > 255)) return null;
  const prefix = Number(m[5]);
  if (prefix > 32) return null;
  return 2 ** (32 - prefix) - 2;
}

/** The common shape of the kubectl calls below (and k8s-network.ts's): always in the namespace. */
export interface K8sContext {
  /** The sandbox namespace: where its pods, their Secrets and policies go, and every call is made unless it reads its own. */
  namespace: string;
  /**
   * The process's own namespace (K8sSandboxOptions.ownNamespace): where its own pod (the creator) and the live creators
   * are read (ownContextOf). Absent: `namespace`, the one namespace for both.
   */
  ownNamespace?: string;
  exec: KubectlExec;
  names: PodNames;
  warn: (line: string) => void;
  readyTimeoutMs: number;
  /** How long a program's exec has, from the moment it is made, for the wrapper's start line (default EXEC_START_TIMEOUT_MS). */
  execStartTimeoutMs?: number;
  /** How long a timed kill() waits for the launcher's reading before it cuts the exec (default TIMED_KILL_MS). */
  timedKillMs?: number;
  /** How long an unexplained pod whose `watch` is dead too is re-read for its eviction (default EVICTION_SETTLE_MS). */
  evictionSettleMs?: number;
  /** The pace its pod creates wait on (the header's pace), or absent/null: none, every call at once. */
  pace?: SandboxPace | null;
  /** How a pod's agent is dialled (the header's Fast boot; default dialAgent: agent-client.ts AgentSession.open). */
  dial?: AgentDial;
  /**
   * The API server's pod watch (k8s-count.ts processApiWatch: a pod's token, or a burst grader's kubeconfig), or
   * absent/null: watchPod's kubectl wait, and awaitPod's and awaitPlanPod's.
   */
  apiWatch?: ApiWatch | null;
  /**
   * The API server's merge patch (k8s-count.ts inClusterApiPatch: a pod's token, or a burst grader's kubeconfig), or
   * absent/null: patchSecretOwner's kubectl patch.
   */
  apiPatch?: ApiPatch | null;
  /**
   * The API server's create (k8s-count.ts inClusterApiCreate: a pod's token, or a burst grader's kubeconfig), or
   * absent/null: bootAgentPod's `kubectl create -f -`.
   */
  apiCreate?: ApiCreate | null;
  /**
   * Where a one-pod member's door dial that ran and took no connection is reported (DoorMissReport): k8s-lanes.ts's
   * door miss count (reportLanesDoorMiss, the default), or a test's recorder. Called off the member's failure path,
   * never awaited; whatever it throws is dropped.
   */
  doorMissed?: (miss: DoorMissReport) => void;
}

/** A one-pod member's door dial that ran and took no connection (K8sContext.doorMissed; k8s-lanes.ts's A dead door). */
export interface DoorMissReport {
  /** The door's address (the lanes pod's IP: SandboxPodPlan.doors.address). */
  address: string;
  /** The door port the member dialled (SandboxPodPlan.doors.ports). */
  port: number;
  /** What the dial said (its last line). */
  said: string;
  /** The member's pod. */
  pod: string;
  /**
   * The trial the pod ran for, its plan's owner (SandboxPodPlan.owner: `<run id>.<trial index>` for a pipeline trial,
   * the same on every pass and re-run of it, each on a fresh pod), which the miss is counted under; null for a plan
   * that names none, counted under its pod's name instead.
   */
  trial: string | null;
}

/** The lanes module, loaded at the first door miss (it imports this module, so this one never imports it statically). */
let lanesModule: Promise<typeof import('./k8s-lanes.ts') | null> | null = null;

/**
 * A one-pod member's door dial ran and took no connection (`miss`): counted against the lanes pod open at that
 * address in this process (k8s-lanes.ts lanesDoorUnreachable: two trials' misses within its window have the grader
 * dial the door itself, and its dial failing too replaces it); resolves once that count (and any dial of the grader's
 * it started) is done. The lanes module imported lazily and cached; a failure to load it, or anything the count
 * throws, is dropped: the member's own failure is never held up or changed by it.
 */
export function reportLanesDoorMiss(miss: DoorMissReport): Promise<void> {
  lanesModule ??= import('./k8s-lanes.ts').catch(() => null);
  return lanesModule
    .then((m) => m?.lanesDoorUnreachable(miss))
    .then(
      () => undefined,
      // Dropped: the count is advice, the member's failure stands as it is.
      () => undefined,
    );
}

/**
 * One agent of a pod as the driver holds it (agent-client.ts AgentSession's shape: its execs, its health, its close):
 * the pod's `stage` agent while it stages, then its `watch` agent for the pod's life (the header's Agent sessions).
 */
export interface PodAgentSession {
  stream(container: string, argv: readonly string[]): AgentChild;
  health(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<AgentHealth>;
  close(graceMs?: number): Promise<void>;
  readonly alive: boolean;
}

/** One dial of pod `pod`'s `agent` at `ip` with its K (`key`), within `budgetMs` from the call. */
export interface AgentDialOptions {
  pod: string;
  ip: string;
  key: string;
  agent: AgentName;
  budgetMs: number;
  signal?: AbortSignal;
  /**
   * A `watch` dial of a shim pod's: the shims its pod declares (shimMembersOf), whose links its /v1/health lists once
   * they are in (the shim gate, bootFromAgent). The dial only hands it on (the driver's, dialAgent, needs nothing of
   * it; a stand-in cluster's agent answers its health with it); absent: none.
   */
  members?: readonly string[];
}

/** Opens a session with a pod's agent (an AgentDialError when it cannot: its `fault` says why). */
export type AgentDial = (o: AgentDialOptions) => Promise<PodAgentSession>;

/** The driver's dial: agent-client.ts AgentSession.open on the pod's IP (through MAKEFUN_AGENT_RELAY_URL's relay when one is named). */
export const dialAgent: AgentDial = (o) => AgentSession.open({ ip: o.ip, key: o.key, agent: o.agent, budgetMs: o.budgetMs, ...(o.signal === undefined ? {} : { signal: o.signal }) });

/** The one verb kubectl() paces (the header's pace), waiting as a `create`; a call sent `paced: false` never waits. */
const PACED_VERB = 'create';

/** `opts` with kubectl()'s own fields (slot, paced) taken out, for the KubectlExec. */
function execOptions(opts: KubectlCallOptions | undefined): KubectlCallOptions | undefined {
  if (opts === undefined || (opts.slot === undefined && opts.paced === undefined)) return opts;
  const { slot: _slot, paced: _paced, ...rest } = opts;
  return rest;
}

/**
 * `ctx` in its process's own namespace (K8sContext.ownNamespace): what reads the process's own pod and its namespace's
 * live pods (the creators) is run in, its pace and exec the same; `ctx` itself where the two namespaces are one.
 */
export function ownContextOf(ctx: K8sContext): K8sContext {
  const own = ctx.ownNamespace ?? ctx.namespace;
  return own === ctx.namespace ? ctx : { ...ctx, namespace: own };
}

/**
 * kubectl in the namespace. A `create` waits for a slot of ctx's pace first (the header's pace; none without one), its
 * timeout counted from the slot: under `opts.slot` it runs at once on the caller's; with `paced: false`
 * it runs at once on none. A wait `opts.signal` cuts is answered as a cut call that never ran. Every call's answer is
 * shown to the pace, so a fault any of them names (a `get` shed 429 too) cuts it.
 */
export async function kubectl(ctx: K8sContext, args: readonly string[], opts?: KubectlCallOptions): Promise<KubectlResult> {
  const full = ['-n', ctx.namespace, ...args];
  const call = execOptions(opts);
  const pace = ctx.pace ?? null;
  if (opts?.slot !== undefined) {
    const r = await ctx.exec(full, call);
    opts.slot.note(r);
    return r;
  }
  if (pace === null) return ctx.exec(full, call);
  if (args[0] !== PACED_VERB || opts?.paced === false) {
    const startedAt = pace.epoch;
    const r = await ctx.exec(full, call);
    pace.observe(r, startedAt);
    return r;
  }
  const slot = await pace.acquire(PACED_VERB, opts?.signal);
  if (slot === null) return { code: null, stdout: '', stderr: '', error: `kubectl ${args[0]}: cut off while it waited for the sandbox pace` };
  try {
    const r = await ctx.exec(full, call);
    slot.note(r);
    return r;
  } finally {
    slot.release();
  }
}

export async function readPod(ctx: K8sContext, name: string): Promise<PodRead> {
  const r = await kubectl(ctx, ['get', `pod/${name}`, '-o', 'json']);
  if (r.code === 0 && r.error === undefined) {
    try {
      return { pod: JSON.parse(r.stdout) as PodJson };
    } catch {
      return { error: 'kubectl get printed no pod' };
    }
  }
  if (/\(NotFound\)|not found/i.test(r.stderr)) return { gone: why(r) };
  return { error: why(r) };
}

function mainOf(pod: PodJson): { state?: ContainerStateJson; lastState?: ContainerStateJson } | undefined {
  return pod.status?.containerStatuses?.find((c) => c.name === CONTAINER);
}

function reasonText(reason: string | undefined, message: string | undefined): string {
  return `${reason ?? 'no reason'}${message === undefined || message === '' ? '' : `: ${message}`}`;
}

/** What a pod's status says, one line: its phase, reason and message, and its container's state. */
function describePod(pod: PodJson): string {
  const s = pod.status ?? {};
  const parts = [`phase ${s.phase ?? 'unknown'}`];
  if (s.reason !== undefined || s.message !== undefined) parts.push(reasonText(s.reason, s.message));
  const unscheduled = s.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False');
  if (unscheduled !== undefined) parts.push(reasonText(unscheduled.reason, unscheduled.message));
  const state = mainOf(pod)?.state;
  if (state?.waiting !== undefined) parts.push(`waiting ${reasonText(state.waiting.reason, state.waiting.message)}`);
  if (state?.terminated !== undefined) parts.push(`terminated ${reasonText(state.terminated.reason, state.terminated.message)} (exit ${state.terminated.exitCode ?? '?'})`);
  // Any other container's (`stage`'s, `watch`'s) only when it is not running, named; `stage` once it exited 0 is as it should be.
  for (const c of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
    if (c.name === CONTAINER) continue;
    if (c.name === STAGE_CONTAINER && c.state?.terminated?.exitCode === 0) continue;
    if (c.state?.waiting !== undefined) parts.push(`${c.name ?? 'a container'} waiting ${reasonText(c.state.waiting.reason, c.state.waiting.message)}`);
    if (c.state?.terminated !== undefined) parts.push(`${c.name ?? 'a container'} terminated ${reasonText(c.state.terminated.reason, c.state.terminated.message)} (exit ${c.state.terminated.exitCode ?? '?'})`);
  }
  return parts.join('; ');
}

/** The reason a container of the pod (`stage`, `main` or `watch`) waits for that never ends in Ready (NEVER_READY), or undefined. */
function neverReadyIn(pod: PodJson): string | undefined {
  for (const c of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
    const reason = c.state?.waiting?.reason;
    if (reason !== undefined && NEVER_READY.has(reason)) return reason;
  }
  return undefined;
}

/** True once the pod's container can no longer run anything: the pod finished, or its container did. */
function stopped(pod: PodJson): boolean {
  return pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded' || mainOf(pod)?.state?.terminated !== undefined;
}

/**
 * The scheduler's words when it found no room on the node for `pod` (the header's Room on the node): its PodScheduled
 * condition False, reason Unschedulable, with a message NO_ROOM_RE matches. Null for a pod scheduled, or unschedulable
 * for anything else.
 */
export function noRoomIn(pod: PodJson): string | null {
  const c = pod.status?.conditions?.find((x) => x.type === 'PodScheduled' && x.status === 'False');
  if (c === undefined || c.reason !== 'Unschedulable' || c.message === undefined || !NO_ROOM_RE.test(c.message)) return null;
  return c.message;
}

/** The kubelet's words when it evicts a pod for an emptyDir past its sizeLimit: `Usage of EmptyDir volume "<name>" exceeds the limit "<size>"`. */
const EMPTYDIR_EVICTION_RE = /\bUsage of EmptyDir volume "([^"]+)" exceeds the limit\b/;

/**
 * The volume of `volumes` (a pod's writable mounts' emptyDirs) the kubelet evicted `pod` for passing its sizeLimit (the
 * plan's D14: the program's kill, 137), read from the pod's own status (phase Failed, reason Evicted, a message naming
 * the volume), never from a container's exit code, which an eviction does not give; null for any other pod, any other
 * eviction among them.
 */
export function evictedFor(pod: PodJson, volumes: readonly string[]): string | null {
  const s = pod.status;
  if (s?.phase !== 'Failed' || s.reason !== 'Evicted' || s.message === undefined) return null;
  const m = EMPTYDIR_EVICTION_RE.exec(s.message);
  return m !== null && volumes.includes(m[1]!) ? m[1]! : null;
}

/**
 * A wait's end: Ready (or Succeeded, or the init container running), or why not, with `noRoom` the scheduler's words when
 * the pod was last seen held for room on the node (noRoomIn), when the budget ran out, `last`: what the pod said then,
 * and `node`: where the scheduler had placed a pod that will never get there (a missing image is one node's own).
 */
export type PodWait = { ok: true } | { ok: false; reason: string | null; why: string; noRoom?: string; last?: string; node?: string };

/** `{ node }` when the pod read says where the scheduler placed it, else nothing. */
function placedOn(pod: PodJson): { node?: string } {
  const node = pod.spec?.nodeName;
  return typeof node === 'string' && node !== '' ? { node } : {};
}

/** What awaitPod waits for: Ready (a program's pod), Succeeded (preflight's), or `stage`, its init container, running (InitRunning). */
export type PodTarget = 'Ready' | 'Succeeded' | 'InitRunning';

/** The jsonpath `kubectl wait` reads for InitRunning: it is met once the pod's first init container's state is `running`. */
export const INIT_RUNNING_JSONPATH = '{.status.initContainerStatuses[0].state.running}';

/**
 * Why a pod waited on for `target` will never get there, from its containers' states, or null (awaitPod): a container
 * of either list waiting for a NEVER_READY reason; for Ready or InitRunning, a container of `containers` terminated (each
 * is the shim, HOLD_COMMAND or the policy listener, which never end by themselves, a shim only with its link to
 * `watch`, and restartPolicy is Never); the init
 * container terminated before it was staged (InitRunning), or terminated with a code other than 0 (Ready).
 */
function neverThere(pod: PodJson, target: PodTarget): string | null {
  const never = neverReadyIn(pod);
  if (never !== undefined) return never;
  if (target === 'Succeeded') return null;
  for (const c of pod.status?.containerStatuses ?? []) {
    if (c.state?.terminated !== undefined) return c.state.terminated.reason ?? 'terminated';
  }
  const init = pod.status?.initContainerStatuses?.[0]?.state?.terminated;
  if (init !== undefined && (target === 'InitRunning' || init.exitCode !== 0)) return init.reason ?? 'terminated';
  return null;
}

/**
 * The kubectl wait condition of `target` (`--for=`'s value): what awaitPod's slices wait for, and watchPod's kubectl
 * wait where the in-process watch cannot be asked.
 */
function waitCondition(target: PodTarget): string {
  return target === 'Ready' ? 'condition=Ready' : target === 'InitRunning' ? `jsonpath=${INIT_RUNNING_JSONPATH}` : 'jsonpath={.status.phase}=Succeeded';
}

/** awaitPod's verdict over one read of the pod: there (`ok`), never there (neverThere, or finished short of it), or null to wait on. */
function podTargetStep(pod: PodJson, target: PodTarget): PodWait | null {
  const s = pod.status ?? {};
  if (target === 'Succeeded' && s.phase === 'Succeeded') return { ok: true };
  if (target === 'Ready' && s.phase === 'Running' && s.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') === true) return { ok: true };
  if (target === 'InitRunning' && s.initContainerStatuses?.[0]?.state?.running !== undefined) return { ok: true };
  const never = neverThere(pod, target);
  if (never !== null) return { ok: false, reason: never, why: describePod(pod), ...placedOn(pod) };
  if (s.phase === 'Failed' || s.phase === 'Succeeded') return { ok: false, reason: s.reason ?? null, why: describePod(pod), ...placedOn(pod) };
  return null;
}

/** Whether `signal` has aborted (a call, not a property read TypeScript narrows across an await). */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/**
 * A readiness wait in a pod (ctx.apiWatch: the watch the boot already reads the pod's IP from), awaitPod's and
 * awaitPlanPod's, in place of a `kubectl wait` spawned each WAIT_SLICE_S and a `get` between two: list, then watch. The
 * pod is read once (readPod: in a pod the API server's GET), so one already gone fails at once in the kubectl loop's
 * words (`the pod is gone (… NotFound …)`) and one already there (or never to be) ends the wait on that read (`step`);
 * then ONE watch of the pod (k8s-count.ts watchPod) from that read's resourceVersion, so no change between the two is
 * lost (a 410 Gone of it, the version compacted away, reads the pod again and watches from the new one: gone there
 * fails at once too; WATCH_REREAD_TRIES times, then a re-list), `step` read over each event until `deadline`, a DELETED event failing it at once as gone. A read that failed
 * any other way watches from now, the pod's first events its state. A watch that cannot be asked, or the API server
 * sheds, is watchPod's kubectl wait for `condition`, the pod read and `step` asked after each slice. The budget's end
 * says what the pod said last (`describe`, or why it could not be read) and, while the scheduler still finds no room
 * for it, so, as the kubectl loop says it.
 */
async function awaitByWatch(
  ctx: K8sContext,
  name: string,
  o: { deadline: number; budgetMs: number; signal: AbortSignal | undefined; condition: string; step: (pod: PodJson) => PodWait | null; describe: (pod: PodJson) => string; shown: () => string },
): Promise<PodWait> {
  if (o.signal?.aborted === true) return { ok: false, reason: null, why: 'cut off' };
  /** The pod read (readPod: in a pod the API server's GET): gone, the pod with the resourceVersion to watch from, or null (unread, or no version). */
  const reread = async (): Promise<{ gone: string } | { version: string; pod: WatchedPod } | null> => {
    const read = await readPod(ctx, name);
    if ('gone' in read) return { gone: read.gone };
    if (!('pod' in read)) return null;
    const version = (read.pod as WatchedPod).metadata?.resourceVersion;
    return typeof version === 'string' && version !== '' ? { version, pod: read.pod as WatchedPod } : null;
  };
  const read = await readPod(ctx, name);
  if ('gone' in read) return { ok: false, reason: null, why: `the pod is gone (${read.gone})` };
  if (isAborted(o.signal)) return { ok: false, reason: null, why: 'cut off' };
  let from: { version: string; pod: WatchedPod } | undefined;
  if ('pod' in read) {
    const verdict = o.step(read.pod);
    if (verdict !== null) return verdict;
    const version = (read.pod as WatchedPod).metadata?.resourceVersion;
    if (typeof version === 'string' && version !== '') from = { version, pod: read.pod as WatchedPod };
  }
  const timer = AbortSignal.timeout(Math.max(1, o.deadline - Date.now()));
  // A 410 Gone of that version (compacted away) reads the pod again and watches from the new one (watchPod's reread).
  const end = await watchPod(ctx, name, o.step, o.signal === undefined ? timer : AbortSignal.any([o.signal, timer]), { waitFor: o.condition, reread, ...(from === undefined ? {} : { from }) });
  if ('verdict' in end) return end.verdict;
  if ('gone' in end) return { ok: false, reason: null, why: `the pod is gone (${end.gone})` };
  // The caller's cut, not the budget's (a call: TypeScript narrows the read before the await).
  if (isAborted(o.signal)) return { ok: false, reason: null, why: 'cut off' };
  const last = end.unread !== undefined ? `could not read it: ${end.unread}` : end.last === null ? 'no answer yet' : o.describe(end.last);
  const noRoom = end.last === null ? null : noRoomIn(end.last);
  return { ok: false, reason: null, why: `not ${o.shown()} within ${o.budgetMs} ms (${last})`, last, ...(noRoom === null ? {} : { noRoom }) };
}

/**
 * Wait for a pod to be Ready (a program's), Succeeded (preflight's) or to have its init container running (InitRunning:
 * a program pod's `stage`, the header), within `budgetMs`, so one that will never get there (neverThere: a NEVER_READY
 * reason in either status list, a container ended, a finished pod, one gone) fails at once while one only Pending (a
 * node short of the requests, or of pod slots) waits on. One the budget ends on while the scheduler still finds no room
 * for it says so (`noRoom`). With ctx.apiWatch (a pod's own token, a burst grader's kubeconfig) one watch of the pod
 * (awaitByWatch); without, `kubectl wait` in WAIT_SLICE_S slices, the pod read between two.
 */
export async function awaitPod(ctx: K8sContext, name: string, target: PodTarget, budgetMs: number, signal?: AbortSignal): Promise<PodWait> {
  const deadline = Date.now() + budgetMs;
  const shown = target === 'InitRunning' ? `its ${STAGE_CONTAINER} container running` : target;
  if ((ctx.apiWatch ?? null) !== null) {
    return awaitByWatch(ctx, name, { deadline, budgetMs, signal, condition: waitCondition(target), step: (pod) => podTargetStep(pod, target), describe: describePod, shown: () => shown });
  }
  const condition = `--for=${waitCondition(target)}`;
  let last = 'no answer yet';
  let noRoom: string | null = null;
  const cut = (): boolean => signal?.aborted === true;
  for (;;) {
    if (cut()) return { ok: false, reason: null, why: 'cut off' };
    const slice = Math.max(1, Math.min(WAIT_SLICE_S, Math.ceil((deadline - Date.now()) / 1000)));
    const started = Date.now();
    const w = await kubectl(ctx, ['wait', condition, `pod/${name}`, `--timeout=${slice}s`], { signal, timeoutMs: (slice + 30) * 1000 });
    if (w.code === 0 && w.error === undefined) return { ok: true };
    if (cut()) return { ok: false, reason: null, why: 'cut off' };
    const read = await readPod(ctx, name);
    if ('gone' in read) return { ok: false, reason: null, why: `the pod is gone (${read.gone})` };
    if ('error' in read) last = `could not read it: ${read.error}`;
    else {
      const verdict = podTargetStep(read.pod, target);
      if (verdict !== null) return verdict;
      last = describePod(read.pod);
      noRoom = noRoomIn(read.pod);
    }
    if (Date.now() >= deadline) return { ok: false, reason: null, why: `not ${shown} within ${budgetMs} ms (${last})`, last, ...(noRoom === null ? {} : { noRoom }) };
    const pause = Math.min(WAIT_PAUSE_MS - (Date.now() - started), deadline - Date.now());
    if (pause > 0) {
      try {
        await sleep(pause, undefined, { signal });
      } catch {
        return { ok: false, reason: null, why: 'cut off' };
      }
    }
  }
}

/**
 * What a plan pod's status says, one line: its phase, reason and message, and each container's state not running, its
 * `stage` among them unless it exited 0 (describePod's sibling).
 */
export function describePlanPod(pod: PodJson): string {
  const s = pod.status ?? {};
  const parts = [`phase ${s.phase ?? 'unknown'}`];
  if (s.reason !== undefined || s.message !== undefined) parts.push(reasonText(s.reason, s.message));
  const unscheduled = s.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False');
  if (unscheduled !== undefined) parts.push(reasonText(unscheduled.reason, unscheduled.message));
  for (const c of [...(s.initContainerStatuses ?? []), ...(s.containerStatuses ?? [])]) {
    const state = c.state;
    if (c.name === STAGE_CONTAINER && state?.terminated?.exitCode === 0) continue;
    if (state?.waiting !== undefined) parts.push(`${c.name ?? '?'} waiting ${reasonText(state.waiting.reason, state.waiting.message)}`);
    if (state?.terminated !== undefined) parts.push(`${c.name ?? '?'} terminated ${reasonText(state.terminated.reason, state.terminated.message)} (exit ${state.terminated.exitCode ?? '?'})`);
  }
  return parts.join('; ');
}

/** True when the sandbox ran out of memory: any container of the pod OOMKilled, now or last (probe e2: under gVisor every container is), or the pod itself. */
export function podOomKilled(pod: PodJson): boolean {
  if (pod.status?.reason === 'OOMKilled') return true;
  return (pod.status?.containerStatuses ?? []).some((c) => c.state?.terminated?.reason === 'OOMKilled' || c.lastState?.terminated?.reason === 'OOMKilled');
}

/**
 * How its pod ended a K8sProcess's program (K8sProcess.podKill, #podVerdict's `killed`): `memory`, any container
 * OOMKilled (podOomKilled); `volume`, evicted for one of its own writable volumes' sizeLimit (evictedFor); `pid1`, its
 * program killed its `main` container's first process (mainKilledFromWithin). Each is the program's kill, K8S_KILLED,
 * and only `memory` says it ran out of memory: a caller that words the kill reads which.
 */
export type PodKill = 'memory' | 'volume' | 'pid1';

/**
 * Whether `pod` reads as its program's own kill of its `main` container's first process (`kill -KILL 1` of its shim,
 * a case session's shim as its session reaper among them, or of release 1's hold, HOLD_COMMAND, which gVisor lets it
 * send, and which ends the container; the shim's 137 and 0 are the hold's, #747 probe 1 and #1398; the session reaper
 * ignores TERM, so a session pod's `main` reads only as the 137): `main` terminated
 * with reason Error and exit K8S_KILLED, or, the program's `kill -TERM 1` (PID 1's own exit 0, the one the delete's
 * TERM gets), with reason Completed and exit 0. In a pod whose phase is Running (its `watch` runs on: every shim pod
 * has one) either; with `main` its one container (release 1's shape with no writable mount, having no `watch`), Failed for the 137 and Succeeded for the 0, the phase the pod takes when its last container
 * ends so; never Failed with `main` Completed, where a container beside it failed. That
 * nothing of the platform's ended: not being deleted (no deletionTimestamp), no container OOMKilled (podOomKilled), no
 * reason on the pod (Evicted, any eviction among them, evictedFor's included; DeadlineExceeded; a node's shutdown) and
 * no DisruptionTarget condition True (the kubelet's, the scheduler's, the taint manager's or the pod GC's kill). Read
 * only for a program whose exec ended K8S_KILLED with no sentinel (K8sProcess #podVerdict), and in a pod with a writable
 * mount only once `watch` answers (readPodVerdict's probe); the cluster's events are not read (the grader's Role has no `events`), every platform kill
 * named above writing its mark on the pod itself.
 */
export function mainKilledFromWithin(pod: PodJson): boolean {
  const s = pod.status;
  if (s?.phase !== 'Running' && s?.phase !== 'Failed' && s?.phase !== 'Succeeded') return false;
  if (beingDeleted(pod) || podOomKilled(pod) || (s.reason ?? '') !== '') return false;
  if (s.conditions?.some((c) => c.type === 'DisruptionTarget' && c.status === 'True') === true) return false;
  const ended = mainOf(pod)?.state?.terminated;
  const killed = ended?.reason === 'Error' && ended.exitCode === K8S_KILLED;
  // A program's TERM to PID 1 (the shim's, HOLD_SCRIPT's or the policy listener's handler; the session reaper ignores it) ends it 0, Completed: the same kill.
  const termed = ended?.reason === 'Completed' && ended.exitCode === 0;
  return s.phase === 'Running' ? killed || termed : s.phase === 'Failed' ? killed : termed;
}

/**
 * A plan pod's boot waits (the header's One pod), within `budgetMs` from `since` (default now): `kubectl wait
 * --for=condition=PodScheduled` in WAIT_SLICE_S slices until the scheduler has placed it (`onScheduled`, once: also when
 * a read between two slices sees the condition True, or the pod at its target; none with `placed`, a pod placed
 * already), then the target the same way, the pod read between two: `stage`, its init container, running
 * (InitRunning: `--for=jsonpath=INIT_RUNNING_JSONPATH`), or Ready (`stage` exited 0, every member and `watch` running).
 * One that will never get there fails at once (neverThere): a container of either list waiting for a NEVER_READY reason,
 * any container terminated (a member's shim never ends by itself while `watch` holds its link), `stage` ended before it was staged
 * (InitRunning) or with a code other than 0 (Ready), the pod finished or gone. One the budget ends on says what the pod
 * said last (`last`) and, while the scheduler still finds no room for it, so (`noRoom`), as awaitPod does. With
 * ctx.apiWatch, ONE watch of the pod for all of it (awaitByWatch): `onScheduled` once an event shows the pod placed.
 */
export async function awaitPlanPod(
  ctx: K8sContext,
  name: string,
  budgetMs: number,
  onScheduled: () => void,
  signal?: AbortSignal,
  opts: { target?: 'InitRunning' | 'Ready'; since?: number; placed?: boolean } = {},
): Promise<PodWait> {
  const target = opts.target ?? 'Ready';
  const deadline = (opts.since ?? Date.now()) + budgetMs;
  let scheduled = opts.placed === true;
  const placed = (): void => {
    if (scheduled) return;
    scheduled = true;
    onScheduled();
  };
  /** One read of the pod: placed once the scheduler has, then there, never there, or null to wait on. */
  const step = (pod: PodJson): PodWait | null => {
    const s = pod.status ?? {};
    if (s.conditions?.some((c) => c.type === 'PodScheduled' && c.status === 'True') === true) placed();
    if (target === 'Ready' && s.phase === 'Running' && s.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') === true) {
      placed();
      return { ok: true };
    }
    if (target === 'InitRunning' && s.initContainerStatuses?.[0]?.state?.running !== undefined) {
      placed();
      return { ok: true };
    }
    const never = neverThere(pod, target);
    if (never !== null) return { ok: false, reason: never, why: describePlanPod(pod), ...placedOn(pod) };
    if (s.phase === 'Failed' || s.phase === 'Succeeded') return { ok: false, reason: s.reason ?? null, why: describePlanPod(pod), ...placedOn(pod) };
    return null;
  };
  const shown = (): string => (!scheduled ? 'scheduled' : target === 'Ready' ? 'Ready' : `its ${STAGE_CONTAINER} container running`);
  if ((ctx.apiWatch ?? null) !== null) {
    return awaitByWatch(ctx, name, { deadline, budgetMs, signal, condition: waitCondition(target), step, describe: describePlanPod, shown });
  }
  let last = 'no answer yet';
  let noRoom: string | null = null;
  const cut = (): boolean => signal?.aborted === true;
  const reached = `--for=${waitCondition(target)}`;
  for (;;) {
    if (cut()) return { ok: false, reason: null, why: 'cut off' };
    const slice = Math.max(1, Math.min(WAIT_SLICE_S, Math.ceil((deadline - Date.now()) / 1000)));
    const started = Date.now();
    const condition = scheduled ? reached : '--for=condition=PodScheduled';
    const w = await kubectl(ctx, ['wait', condition, `pod/${name}`, `--timeout=${slice}s`], { signal, timeoutMs: (slice + 30) * 1000 });
    if (cut()) return { ok: false, reason: null, why: 'cut off' };
    if (w.code === 0 && w.error === undefined) {
      if (scheduled) return { ok: true };
      placed();
      noRoom = null;
      continue;
    }
    const read = await readPod(ctx, name);
    if ('gone' in read) return { ok: false, reason: null, why: `the pod is gone (${read.gone})` };
    if ('error' in read) last = `could not read it: ${read.error}`;
    else {
      const verdict = step(read.pod);
      if (verdict !== null) return verdict;
      last = describePlanPod(read.pod);
      noRoom = noRoomIn(read.pod);
    }
    if (Date.now() >= deadline) return { ok: false, reason: null, why: `not ${shown()} within ${budgetMs} ms (${last})`, last, ...(noRoom === null ? {} : { noRoom }) };
    const pause = Math.min(WAIT_PAUSE_MS - (Date.now() - started), deadline - Date.now());
    if (pause > 0) {
      try {
        await sleep(pause, undefined, { signal });
      } catch {
        return { ok: false, reason: null, why: 'cut off' };
      }
    }
  }
}

/**
 * Whether a listed object is already being deleted: its metadata.deletionTimestamp is set. A pod KUBECTL_DELETE_FLAGS
 * deleted stays listed so until the kubelet has ended it; a re-list passes over it rather than delete it again.
 */
export function beingDeleted(item: { metadata?: { deletionTimestamp?: unknown } } | null | undefined): boolean {
  const at = item?.metadata?.deletionTimestamp;
  return at !== undefined && at !== null && at !== '';
}

/**
 * The label selector of the release's home grader pods (deploy/k8s/base/grader.yaml's makefun-grader Deployment):
 * what K8sSandbox.runningGraders and graderPods list. The burst grader's pods carry makefun-grader-burst instead.
 */
export const GRADER_POD_SELECTOR = 'app.kubernetes.io/name=makefun-grader';

/** A grader pod as K8sSandbox.graderPods reads it (server/pipeline/capacity.ts GraderPodView): its name, and whether it is being deleted. */
export interface GraderPodRead {
  name: string;
  deleting: boolean;
}

/** A sandbox pod as K8sSandbox.sandboxPodViews reads it (server/pipeline/capacity.ts SandboxPodView): its name and its maker (CREATOR_ANNOTATION). */
export interface SandboxPodRead {
  name: string;
  creator: string | null;
}

type ListedPod = { metadata?: { name?: unknown; deletionTimestamp?: unknown; annotations?: Record<string, unknown> | null } } | null;

/** A pod list's items as printed by `-o json`, or null when it prints no list or an item names no pod. */
function listedPodsOf(stdout: string): Array<{ name: string; item: ListedPod }> | null {
  let items: unknown;
  try {
    items = (JSON.parse(stdout) as { items?: unknown } | null)?.items;
  } catch {
    return null;
  }
  return listedPodsIn(items);
}

/** listedPodsOf of a list's items (the parsed list's `items`, a ListDoc's: listItemsOf). */
function listedPodsIn(items: unknown): Array<{ name: string; item: ListedPod }> | null {
  if (!Array.isArray(items)) return null;
  const pods: Array<{ name: string; item: ListedPod }> = [];
  for (const item of items as ListedPod[]) {
    const name = item?.metadata?.name;
    if (typeof name !== 'string' || name === '') return null;
    pods.push({ name, item });
  }
  return pods;
}

/** The grader pods a `-o json` list prints (K8sSandbox.graderPods): each name and whether it is being deleted; null for no list. */
export function graderPodsOf(stdout: string): GraderPodRead[] | null {
  return graderPodsIn(listedPodsOf(stdout));
}

/** The sandbox pods a `-o json` list prints (K8sSandbox.sandboxPodViews): each name and its CREATOR_ANNOTATION (null for none); null for no list. */
export function sandboxPodsOf(stdout: string): SandboxPodRead[] | null {
  return sandboxPodsIn(listedPodsOf(stdout));
}

function graderPodsIn(pods: Array<{ name: string; item: ListedPod }> | null): GraderPodRead[] | null {
  return pods?.map(({ name, item }) => ({ name, deleting: beingDeleted(item) })) ?? null;
}

function sandboxPodsIn(pods: Array<{ name: string; item: ListedPod }> | null): SandboxPodRead[] | null {
  return (
    pods?.map(({ name, item }) => {
      const creator = item?.metadata?.annotations?.[CREATOR_ANNOTATION];
      return { name, creator: typeof creator === 'string' && creator !== '' ? creator : null };
    }) ?? null
  );
}

/** A `-o json` pod list's pods as listedPodsOf reads them, the list read off the event loop (POD_LIST_KEEP); null for no list or a pool that could not read it. */
async function listedPodsOffLoop(r: KubectlResult): Promise<Array<{ name: string; item: ListedPod }> | null> {
  let listed: ListDoc;
  try {
    listed = await listDocOf(r, POD_LIST_KEEP);
  } catch {
    return null;
  }
  return listedPodsIn(listItemsOf(listed));
}

/** Delete objects by `kind/name`, at once and without a get (the Role has no get on secrets); warned of when it never succeeds. */
export async function deleteObjects(ctx: K8sContext, refs: readonly string[]): Promise<void> {
  let last = '';
  for (let i = 0; i < DELETE_ATTEMPTS; i++) {
    const r = await kubectl(ctx, ['delete', ...refs, ...KUBECTL_DELETE_FLAGS]);
    if (r.code === 0 && r.error === undefined) return;
    last = why(r);
    if (i < DELETE_ATTEMPTS - 1) await sleep(DELETE_BACKOFF_MS * 2 ** i);
  }
  ctx.warn(`k8s sandbox: ${refs.join(' ')} may still be there: no delete succeeded in ${DELETE_ATTEMPTS} tries (${last}); its activeDeadlineSeconds ends the pod within ${STALE_AFTER_MS / 3_600_000} h (a race pod at its lifetime)`);
}

export function failure(error: string): SandboxExit {
  return { code: K8S_DRIVER_FAILURE, signal: null, error: `kubernetes: ${error}` };
}

export function killedExit(): SandboxExit {
  return { code: K8S_KILLED, signal: null };
}

/**
 * Empty each mount's host directory, keeping it (a real directory, never a link to one): what a collect cut off left
 * there (k8s-transfer.ts collectMounts empties them before its stream and writes as it reads) is no output of the
 * program's. Null once all are empty, else what could not be emptied.
 */
async function emptyHostDirs(mounts: readonly CollectMount[]): Promise<string | null> {
  for (const m of mounts) {
    try {
      const st = await lstat(m.dir);
      if (!st.isDirectory()) return `${m.dir} (for ${m.mount}) is not a directory`;
      for (const name of await readdir(m.dir)) await rm(posix.join(m.dir, name), { recursive: true, force: true });
    } catch (err) {
      return `${m.dir} (for ${m.mount}) could not be emptied: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- one program in one pod

/** What one K8sProcess runs: its pod, what is made with it, and the command. */
interface Launch {
  name: string;
  /** What `kubectl create` makes, the pod last: built as the process starts (the gateway's addresses are looked up). */
  objects: () => Promise<K8sObject[]>;
  /** The env Secret, made once the pod is (ownedByPod), or null for none. */
  secret?: K8sObject | null;
  /** `kind/name` of everything `objects` and `secret` make, the pod first: deleted once the program is done. */
  refs: readonly string[];
  argv: readonly string[];
  /**
   * The program's own variables (the header's Exec env: its spec's secrets, checkSandboxSecrets' entries), carried by
   * its exec, never in its pod or Secret; absent: none.
   */
  env?: ReadonlyArray<readonly [string, string]>;
  /** The wrapper's process cap; 0 for none. */
  pids: number;
  /** The trial network the pod joins, the names it answers to there and the port it serves on (servedPort), or null. */
  network: { name: string; names: readonly string[]; port?: number | null } | null;
  /**
   * An entry's policy wait (POLICY_WAIT_MS): its interpreter's POLICY_WAIT_ARGV and the peers it dials, as of
   * when `objects` built its hostAliases. Absent for any other pod.
   */
  reach?: { argv: readonly string[]; peers: () => readonly ServedPeer[] };
  /**
   * A timed pod's (the header's Timing): `argv` is the CPU launcher's (cpuLauncherArgv), the exec runs it under
   * TIMED_EXEC_WRAPPER, its reading is the process's cpuUs, and kill() lets the launcher report before the exec is cut.
   */
  timed?: boolean;
  /**
   * The spec's mounts (mounts.ts checkSandboxMounts took them): a meter may be registered on a writable one (meter), whose
   * pod then has `watch` (sandboxPodSpec). Absent: an aux pod's, which nothing meters.
   */
  mounts?: readonly SandboxMount[];
  /**
   * A program pod's staging and collect (the header; sandboxPodSpec gives it `stage`): the trees staged into `stage`
   * before the Ready wait, and the writable mounts collected from `watch` once the program's exec has ended. Absent:
   * nothing staged or collected.
   */
  stage?: { trees: readonly StageTree[]; collect: readonly CollectMount[] };
  /**
   * A case session's run (the header's Case sessions; k8s-session.ts K8sSession): nothing of `objects`, `secret`, `refs`,
   * `network` or `reach` is made, waited on or deleted; the session readies the pod (prepare) and is told how the run
   * ended (settle). `stage.trees` is unused, `stage.collect` the run's writable mounts.
   */
  session?: SessionLaunch;
  /**
   * A pool-ready spawn's warm pool (the header's Warm pool; K8sSandbox #spawn): `take` asked before anything is made, a
   * pod it hands over run in (its name and refs the process's from then on, `objects`, `secret` and `refs` unused), null
   * a cold boot as without it; `noteBoot` told a cold boot's create to its agent's answer (a refill time); `members` the
   * shims its shape declares (shimMembersOf), which a taken pod's boot waits for `watch` to list (the shim gate). Absent: cold.
   */
  warm?: { take(): Promise<WarmPod | null>; noteBoot(ms: number): void; members: readonly string[] };
}

/** What a case session's run is handed by its session (SessionLaunch.prepare): the pod it runs in and how, or the exit it ends with. */
export type SessionPrepared =
  | {
      ok: true;
      /** The session pod the run execs into (booted, or reset; its read-only mounts restaged for this run). */
      pod: string;
      /** The exec's script: SESSION_EXEC_WRAPPER (the case launcher's), or EXEC_WRAPPER where the launcher cannot run. */
      wrapper: string;
      /** What the wrapper runs: the case launcher's argv around the program, or the program's own. */
      argv: readonly string[];
      /** The launcher report word the wrapper must print before the sentinel (CASE_LAUNCHER_OK), or null for none. */
      report: string | null;
      /**
       * The session pod's `watch` agent (bootPod's, kept by the session for the pod's life): the run's watch execs, its
       * collect and its watch probe go over it. Absent or null: the run has none, and a collect or watch it needs fails.
       */
      watch?: PodAgentSession | null;
    }
  | {
      ok: false;
      exit: SandboxExit;
      /** The scheduler's or the API's words when the node had no room for the session's pod (K8sProcess.noRoom). */
      noRoom?: string | null;
    };

/** How a case session's run ended (SessionLaunch.settle), its collect done. */
export interface SessionRunEnd {
  exit: SandboxExit;
  /** How its pod ended it (K8sProcess.podKill), or null. */
  podKill: PodKill | null;
  /** Its program's exec was started in the pod. */
  execStarted: boolean;
  /** kill() was called. */
  killed: boolean;
  /** The kill of a program cut off failed: it may still run in the pod. */
  killFailed: boolean;
}

/** A case session's hooks into one run's K8sProcess (Launch.session). */
export interface SessionLaunch {
  /** Ready the session's pod for this run; `signal` aborts as the run is killed. Never rejects. */
  prepare(signal: AbortSignal): Promise<SessionPrepared>;
  /** The run is over (its collect done, nothing deleted), before its `exited` settles: called once, after prepare. */
  settle(end: SessionRunEnd): void;
}

/**
 * A pod's boot (bootPod): Ready, with its IP and its `watch` agent's session (null: the pod has no `watch`), which the
 * caller holds for the pod's life and closes at its end; or the exit its program ends with and, when the node had no room
 * for it, why.
 */
export type PodBooted = { ok: true; ip: string; watch: PodAgentSession | null } | { ok: false; exit: SandboxExit; noRoom: string | null };

/** Whether a pod's `watch` agent answers its /v1/health within WATCH_PROBE_TIMEOUT_MS (the watch probe); false with no session. */
export async function watchAnswers(watch: PodAgentSession | null): Promise<boolean> {
  if (watch === null || !watch.alive) return false;
  try {
    await watch.health({ timeoutMs: WATCH_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** The API path of Secret `secret` in `namespace` (patchSecretOwner's PATCH). */
export function secretPath(namespace: string, secret: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(secret)}`;
}

/** One try of a Secret's owner patch: owned, already gone, or failed (`again`: a shed, a cut or no answer, worth one more try). */
type OwnerPatchTry = { owned: true } | { gone: true } | { failed: string; again: boolean };

/** The patch asked of the API server in-process (K8sContext.apiPatch): a 2xx owned, a 404 gone, any other status said. */
async function ownerPatchByApi(patch: ApiPatch, ctx: K8sContext, secret: string, body: string): Promise<OwnerPatchTry> {
  let a;
  try {
    a = await patch(secretPath(ctx.namespace, secret), body, { timeoutMs: SECRET_PATCH_TIMEOUT_MS });
  } catch (err) {
    return { failed: `${err instanceof ApiCut ? 'cut' : 'could not be asked'}: ${errorWords(err)}`, again: true };
  }
  if (a.status >= 200 && a.status < 300) return { owned: true };
  if (a.status === 404) return { gone: true };
  return { failed: `HTTP ${a.status}${apiMessage(a.body)}`, again: isShed(a.status) };
}

/** `: <message>` of a Status body the API server answered (its own words, never the object), or '' when it has none. */
function apiMessage(body: string): string {
  try {
    const m = (JSON.parse(body) as { message?: unknown } | null)?.message;
    return typeof m === 'string' && m !== '' ? `: ${m.slice(0, 300)}` : '';
  } catch {
    return '';
  }
}

/** `kubectl patch secret <secret> --type=merge` (outside a pod: no apiPatch), read as one try. */
async function ownerPatchByKubectl(ctx: K8sContext, secret: string, body: string): Promise<OwnerPatchTry> {
  const r = await kubectl(ctx, ['patch', 'secret', secret, '--type=merge', '-p', body], { timeoutMs: SECRET_PATCH_TIMEOUT_MS });
  if (r.code === 0 && r.error === undefined) return { owned: true };
  if (r.error === undefined && /\(NotFound\)|not found/i.test(r.stderr)) return { gone: true };
  return { failed: why(r), again: true };
}

/**
 * Make pod `owner` the owner of its Secret `secret` (the header's Secret first: a merge patch of ownerPatch), off the
 * boot's critical path. In a pod (ctx.apiPatch) it is the API server's PATCH of /api/v1/namespaces/<ns>/secrets/<secret>,
 * which needs the Role's `patch` alone; outside one, `kubectl patch secret <pod>-env --type=merge`. A failure worth
 * another try (kubectl's any; the API's shed, cut or unanswered call) is tried once more SECRET_PATCH_RETRY_MS later;
 * then, or at once for any other status (a 403, a 422), one warning. A Secret already gone (NotFound: its pod's delete
 * took it) needs no owner and is said of nowhere. Never rejects; true once owned. Unowned, the Secret is still deleted
 * with its pod by name (deleteObjects), and by reapOrphans should its creator die.
 */
export async function patchSecretOwner(ctx: K8sContext, secret: string, owner: { name: string; uid: string }): Promise<boolean> {
  const api = ctx.apiPatch ?? null;
  const how = api === null ? 'kubectl patch' : 'PATCH';
  let last = '';
  let tries = 0;
  try {
    const body = ownerPatch(owner);
    for (let i = 0; i < 2; i++) {
      if (i > 0) await sleep(SECRET_PATCH_RETRY_MS);
      tries++;
      const t = api === null ? await ownerPatchByKubectl(ctx, secret, body) : await ownerPatchByApi(api, ctx, secret, body);
      if ('owned' in t) return true;
      if ('gone' in t) return false;
      last = t.failed;
      if (!t.again) break;
    }
  } catch (err) {
    last = errorWords(err);
  }
  ctx.warn(`k8s sandbox: secret/${secret} was not given pod ${owner.name} as its owner (${how}, tried ${tries === 1 ? 'once' : 'twice'}: ${last}): it goes with the pod's delete by name, or with reapOrphans should its creator die first`);
  return false;
}

/** One object a pod's create made (createPodObjects): its kind, name and uid. */
export interface MadeObject {
  kind: string;
  name: string;
  uid: string;
}

/**
 * How a pod's create ended (createPodObjects): every object it made, in order, and, when it did not make them all,
 * the failure's words (`said`: kubectl's, or the API server's Status as kubectl prints it) and whether what it asked
 * for last may have been made unsaid (`unknown`: a cut, or an answer that says nothing of it), so the Secret is deleted
 * as one made. `by` says who asked.
 */
export interface PodCreate {
  by: 'kubectl' | 'api';
  made: MadeObject[];
  failed: { said: string; unknown: boolean } | null;
}

/**
 * How a pod's failed create is said (bootAgentPod: `kubernetes: could not create pod <name>: <said>`), whether the API
 * server was asked in-process or kubectl ran: the words every reader classifies a create failure by
 * (.cosmos/skills/grading-health/snapshot.mjs SANDBOX_FAILURE; the exit is K8S_DRIVER_FAILURE either way).
 */
export const CREATE_FAILED_WORDS = 'could not create pod';

/** The query of every in-process create: kubectl's `--validate=false` (KUBECTL_CREATE), the API server's own checks kept. */
export const CREATE_QUERY = 'fieldValidation=Ignore';
/** How many times an in-process create the API server shed (HTTP 429, APF's: never executed) is asked again, inside its budget. */
export const CREATE_SHED_TRIES = 5;
/** The least wait before a shed create is asked again (its Retry-After when longer, up to SANDBOX_PACE_MAX_HOLD_MS). */
export const CREATE_SHED_WAIT_MS = 1_000;

/**
 * The API path of the collection object `obj` is created into in `namespace` (createPodObjects), or null for a kind
 * the in-process create does not make: a Secret, a Pod (v1) and a NetworkPolicy (networking.k8s.io/v1), the objects of
 * a pod's create, each with CREATE_QUERY.
 */
export function createPath(namespace: string, obj: Pick<K8sObject, 'apiVersion' | 'kind'>): string | null {
  const ns = encodeURIComponent(namespace);
  if (obj.apiVersion === 'v1' && obj.kind === 'Secret') return `/api/v1/namespaces/${ns}/secrets?${CREATE_QUERY}`;
  if (obj.apiVersion === 'v1' && obj.kind === 'Pod') return `/api/v1/namespaces/${ns}/pods?${CREATE_QUERY}`;
  if (obj.apiVersion === 'networking.k8s.io/v1' && obj.kind === 'NetworkPolicy') return `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies?${CREATE_QUERY}`;
  return null;
}

/**
 * What the API server answered a create that it refused (any status but 2xx), as kubectl prints it: `Error from server
 * (<reason>): error when creating <kind> <name>: <message>`, its Status' reason and message (at most 600 characters of
 * it), or the HTTP status where the body is no Status. So every reader of kubectl's words reads these the same:
 * NO_ROOM_RE (a quota's `exceeded quota`), capacity.ts paceFaultOf and controlPlaneFaultOfWords (`(TooManyRequests)`),
 * withoutValues.
 */
export function createRefusal(answer: { status: number; body: string }, obj: Pick<K8sObject, 'kind' | 'metadata'>): string {
  let reason = '';
  let message = '';
  try {
    const doc = JSON.parse(answer.body) as { reason?: unknown; message?: unknown } | null;
    if (typeof doc?.reason === 'string') reason = doc.reason;
    if (typeof doc?.message === 'string') message = doc.message.slice(0, 600);
  } catch {
    // No Status: the HTTP status alone says it.
  }
  const head = reason === '' ? `Error from server (HTTP ${answer.status})` : `Error from server (${reason})`;
  return `${head}: error when creating ${obj.kind} ${obj.metadata.name}: ${message === '' ? `HTTP ${answer.status}` : message}`;
}

/** The uid of the object a create answered (its body, the object as made), or null when it names none. */
function answeredUid(body: string): string | null {
  try {
    const uid = (JSON.parse(body) as { metadata?: { uid?: unknown } } | null)?.metadata?.uid;
    return typeof uid === 'string' && UID_RE.test(uid) ? uid : null;
  } catch {
    return null;
  }
}

/** Each object a `kubectl create -o CREATED_JSONPATH` printed (kind, name, uid a line), in its order. */
export function createdObjects(stdout: string): MadeObject[] {
  const made: MadeObject[] = [];
  for (const line of stdout.split('\n')) {
    const [kind, name, uid, ...rest] = line.trim().split(' ');
    if (kind !== undefined && kind !== '' && name !== undefined && uid !== undefined && rest.length === 0 && UID_RE.test(uid)) made.push({ kind, name, uid });
  }
  return made;
}

/** What the in-process create last could not ask, per create (said once until it changes; cleared by a create asked). */
const createUnasked = new WeakMap<ApiCreate, string>();

/**
 * A pod's objects made (bootAgentPod's create, the header's Secret first), `items` in their order (the Secret, a
 * forwarder's gateway policy, the pod), under the caller's `slot` of the pace, within KUBECTL_TIMEOUT_MS.
 *
 * With ctx.apiCreate (in a pod: its own token; a burst grader: its kubeconfig's), each is the API server's POST into
 * its collection (createPath, CREATE_QUERY), one after another, its uid read from the object answered; the first
 * refused or cut ends the create there, so no pod is asked for once its Secret was not made. A 429 (APF's shed, never
 * executed) is the pace's `shed` fault at once (its Retry-After held, slot.fault) and is asked again after
 * CREATE_SHED_WAIT_MS or its Retry-After, whichever is longer, up to CREATE_SHED_TRIES times while the budget lasts, as
 * kubectl's client-go waits out a shed itself; any other refusal is said as kubectl prints it (createRefusal) and shown
 * to the pace (slot.failed); a 5xx or a cut leaves what it asked for unknown. A POST known never sent (k8s-count.ts
 * ApiUnsent: its socket wait ran out with every socket held) made nothing, so it is asked once more inside the budget
 * (resentOnceUnsent), and unsent again it ends the create with nothing of it unknown. A first POST the in-process client could
 * not ask (a token or CA that does not read, TLS, a refused connection, or one reset or closed mid-answer, which the API
 * server may have executed all the same) is kubectl's, said once until it changes, as k8s-count.ts's reads fall back;
 * but never blind: the object it asked for is deleted by name first (`kubectl delete --ignore-not-found`, the Role's
 * `delete`: it has no `get` on Secrets to look first), so kubectl's create never meets it as AlreadyExists, and a
 * delete that fails ends the create there, its object unknown, with no fallback.
 *
 * Without one (the e2e rig, the tests), or for a kind createPath does not make: ONE `kubectl create -f -` of the List,
 * printing CREATED_JSONPATH (kubectl's own pace note). Never rejects.
 */
export async function createPodObjects(ctx: K8sContext, items: readonly K8sObject[], slot: PaceSlot): Promise<PodCreate> {
  const create = ctx.apiCreate ?? null;
  const paths = create === null ? null : items.map((o) => createPath(ctx.namespace, o));
  if (create !== null && paths !== null && paths.every((p) => p !== null)) {
    const asked = await createByApi(ctx, create, items, paths as string[], slot);
    if (asked !== null) return asked;
    // The first POST could not be asked, and may have been executed all the same (a reset after the server made it):
    // its object deleted by name before kubectl creates it again, or the create ends here, unknown.
    const first = items[0]!;
    const cleared = await kubectl(ctx, ['delete', `${first.kind.toLowerCase()}/${first.metadata.name}`, ...KUBECTL_DELETE_FLAGS]);
    if (cleared.code !== 0 || cleared.error !== undefined) {
      const said = `creating ${first.kind} ${first.metadata.name}: the in-process create could not be asked (${createUnasked.get(create) ?? 'unknown'}), and the delete of what it may have made before kubectl's create failed: ${why(cleared)}`;
      slot.failed(said);
      return { by: 'api', made: [], failed: { said, unknown: true } };
    }
  }
  const r = await kubectl(ctx, [...KUBECTL_CREATE, '-o', CREATED_JSONPATH], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }), slot });
  const made = createdObjects(r.stdout);
  if (r.code === 0 && r.error === undefined) return { by: 'kubectl', made, failed: null };
  return { by: 'kubectl', made, failed: { said: why(r), unknown: r.error !== undefined } };
}

/** createPodObjects' in-process create; null when it could not ask before anything was made (kubectl's then). */
async function createByApi(ctx: K8sContext, create: ApiCreate, items: readonly K8sObject[], paths: readonly string[], slot: PaceSlot): Promise<PodCreate | null> {
  const deadline = Date.now() + KUBECTL_TIMEOUT_MS;
  const made: MadeObject[] = [];
  const failed = (said: string, unknown: boolean): PodCreate => {
    slot.failed(said);
    return { by: 'api', made, failed: { said, unknown } };
  };
  for (const [i, obj] of items.entries()) {
    const what = `${obj.kind} ${obj.metadata.name}`;
    const body = JSON.stringify(obj);
    // A POST known never sent (ApiUnsent: every socket held past its wait) made nothing: asked once more inside the
    // budget; one cut after it was sent may have made it, and is never sent again.
    const ask = resentOnceUnsent((timeoutMs) => create(paths[i]!, body, { timeoutMs }), deadline);
    for (let shed = 0; ; shed++) {
      const left = deadline - Date.now();
      if (left <= 0) return failed(`creating ${what}: cut: no answer within ${KUBECTL_TIMEOUT_MS} ms`, true);
      let a;
      try {
        a = await ask(left);
      } catch (err) {
        // Unsent still (twice, or once with no budget left to ask again): nothing of it was made, so nothing is unknown.
        if (err instanceof ApiCut) return failed(`creating ${what}: cut: ${errorWords(err)}`, !(err instanceof ApiUnsent));
        if (i === 0 && shed === 0) {
          const words = errorWords(err);
          if (createUnasked.get(create) !== words) {
            createUnasked.set(create, words);
            ctx.warn(`k8s sandbox: the in-process create could not be asked (${words}): kubectl creates the pods' objects until it can`);
          }
          return null;
        }
        return failed(`creating ${what}: could not be asked: ${errorWords(err)}`, true);
      }
      if (a.status >= 200 && a.status < 300) {
        const uid = answeredUid(a.body);
        if (uid === null) return failed(`creating ${what}: the API server's answer (HTTP ${a.status}) names no uid`, true);
        made.push({ kind: obj.kind, name: obj.metadata.name, uid });
        if (i === 0) createUnasked.delete(create);
        break;
      }
      const said = createRefusal(a, obj);
      if (a.status === 429) {
        const waitMs = Math.min(SANDBOX_PACE_MAX_HOLD_MS, Math.max(CREATE_SHED_WAIT_MS, retryAfterHeaderMs(a.retryAfter) || (retryAfterMsOf(a.body) ?? 0)));
        slot.fault('shed', waitMs);
        if (shed + 1 < CREATE_SHED_TRIES && waitMs < deadline - Date.now()) {
          await sleep(waitMs);
          continue;
        }
      }
      return failed(said, a.status >= 500);
    }
  }
  slot.ok();
  return { by: 'api', made, failed: null };
}

/** The names of a pod object's containers (spec.containers). */
function containerNames(pod: K8sObject): string[] {
  const containers = (pod.spec as { containers?: Array<{ name?: unknown }> } | undefined)?.containers ?? [];
  return containers.map((c) => (typeof c.name === 'string' ? c.name : ''));
}

/** An error's words, for a message. */
function errorWords(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What a staged pod's boot is (bootAgentPod): its objects, its Secret, its trees, and its caller's cut. */
interface AgentBootOptions {
  name: string;
  /** What is made with the pod, the pod last (a forwarder's gateway policy before it). */
  objects: readonly K8sObject[];
  /** The pod's `<pod>-env` (sandboxEnvSecret, podPlanSecret), made first in the same List: its MAKEFUN_AGENT_KEY is the agents' K. */
  secret: K8sObject | null;
  /** What `stage` is sent; null: nothing staged (a pod with no `stage`). */
  trees: readonly StageTree[] | null;
  signal: AbortSignal;
  killed: () => boolean;
  /** Told once, as soon as a read of the pod shows it placed (a plan pod's `scheduled`). */
  onScheduled?: () => void;
  /** A plan pod's: its status said by describePlanPod, its Ready waited by awaitPlanPod. */
  plan?: boolean;
  /**
   * How its init is clocked (the header's Fast boot): `cold` (absent), each phase recordInit's (source cold) and an init
   * past INIT_WARN_MS warned of; null, neither (a warm pool's refill: k8s-pool.ts times its own boots).
   */
  init?: 'cold' | null;
  /** Told the create-to-agent time once its `stage` agent answered (a warm pool's refill sample: K8sProcess's cold boot). */
  onAgent?: (ms: number) => void;
}

/** bootAgentPod's end: Ready (its IP, its `watch` agent's session), the caller's cut, or the driver's failure (`noRoom`: the node's words). */
type AgentBoot = { ok: true; ip: string; watch: PodAgentSession | null } | { ok: false; killed: true } | { ok: false; killed: false; error: string; noRoom: string | null };

/** A boot that did not end Ready: the caller's cut, or the driver's failure. */
export type AgentBootFailed = { ok: false; killed: true } | { ok: false; killed: false; error: string; noRoom: string | null };

/**
 * A staged pod booted up to its `stage` agent's first authenticated answer (bootToAgent, the first half of
 * bootAgentPod; a warm pool's pod as it waits for a run, k8s-pool.ts): its IP, that agent's session (null for a pod with
 * no `stage`), the agents' K (null: its Secret holds none, as a pod with neither agent), whether it has `watch`, the
 * shims its `watch` declares, and when its create was asked (the ready budget's start).
 */
export interface AgentReached {
  ok: true;
  name: string;
  ip: string;
  stage: PodAgentSession | null;
  key: string | null;
  watched: boolean;
  /** The shims its `watch` declares (shimMembersOf: a shim pod's `main`, or every plan member), which the shim gate waits for; none: no gate. */
  members: readonly string[];
  createdAt: number;
}

/** What the second half of a staged pod's boot is told (bootFromAgent): its trees, its caller's cut, whether it is a plan pod's. */
export interface AgentStaging {
  trees: readonly StageTree[] | null;
  signal: AbortSignal;
  killed: () => boolean;
  plan?: boolean;
}

/**
 * A staged pod's boot (the header's Fast boot; bootPod's and K8sPod's). Under one `create` slot of the pace, the Secret,
 * then `objects` (a gateway policy, the pod), made by createPodObjects: in a pod (ctx.apiCreate) the API server's POST of
 * each in turn over this process's own token, no kubectl spawned; elsewhere ONE `kubectl create -f -` List printing
 * CREATED_JSONPATH. The pod's uid read from what was made, and its Secret given the pod as owner by patchSecretOwner, off
 * the critical path. A create that fails once the Secret is made (or may have) deletes the Secret before the failure is
 * said. Then, inside one budget (ctx.readyTimeoutMs from
 * the create, the staging's time added on top):
 *
 *   - the pod's IP from its watch (k8s-count.ts watchPod, in process in a pod: no kubectl spawned), each event read for
 *     awaitPod's verdicts too (a container of either list waiting for a NEVER_READY reason, one ended, `stage` ended, the
 *     pod finished or gone: the boot fails at once; the scheduler's words kept for a budget that runs out);
 *   - its `stage` agent dialled at <IP>:9011 (ctx.dial, the pod's K from the Secret) in STAGE_DIAL_SLICE_MS slices, the
 *     pod read once between two for the same verdicts, and its first authenticated answer (/v1/health) the init clock's
 *     end;
 *   - the staging (k8s-transfer.ts stageStream over that session, stageCommand: the release ends `stage`), the stage
 *     session closed once its exec has ended;
 *   - Ready (awaitPod, a plan pod's awaitPlanPod), then, in a pod with `watch`, its `watch` agent dialled
 *     (WATCH_DIAL_MS): the session the caller keeps for the pod's life;
 *   - in a shim pod, the shim gate (awaitShims, the header's): `watch`'s /v1/health asked until it lists every shim its
 *     pod declares (shimMembersOf), within what is left of the ready budget and SHIM_GATE_MIN_MS at least; a pod whose
 *     `watch` never does, or stops answering, is the driver's failure, nothing exec'd in any member.
 *
 * Each init phase (created, scheduled, ip, agent) is recordInit's, from the create call; an init past INIT_WARN_MS is a
 * warning line naming the pod and its phases, or counted into the next one (InitWarnings: one line a minute a sandbox). `killed` is read after each step (`signal` cuts the waits, the dials and
 * the staging). The caller deletes what it made, whatever the end.
 *
 * Two halves (the header's Warm pool): bootToAgent, the create up to the `stage` agent's first answer, which a warm
 * pool runs ahead of any run; and bootFromAgent, the staging on, which a spawn runs on the pod it made or took.
 */
async function bootAgentPod(ctx: K8sContext, o: AgentBootOptions): Promise<AgentBoot> {
  const reached = await bootToAgent(ctx, o);
  if (!reached.ok) return reached;
  return await bootFromAgent(ctx, reached, o);
}

/**
 * The first half of a staged pod's boot (bootAgentPod's, above): the create under its `create` slot of the pace, the
 * Secret's owner patch off the critical path, the IP from the pod's watch, and, for a pod with `stage` (trees not
 * null), that agent dialled and its first authenticated answer, each init phase clocked as o.init says. Ends with the
 * pod reached (AgentReached: what bootFromAgent goes on from), or failed or cut as bootAgentPod's would; the caller
 * deletes what it made, whatever the end (a reached pod's `stage` session is the caller's to close).
 */
export async function bootToAgent(ctx: K8sContext, o: AgentBootOptions): Promise<AgentReached | AgentBootFailed> {
  const name = o.name;
  const describe = o.plan === true ? describePlanPod : describePod;
  const killed: AgentBootFailed = { ok: false, killed: true };
  const fails = (error: string, noRoom: string | null = null): AgentBootFailed => (o.killed() ? killed : { ok: false, killed: false, error, noRoom });
  const clocked = o.init !== null;
  const pod = o.objects.at(-1);
  if (pod === undefined || pod.kind !== 'Pod' || pod.metadata.name !== name) return fails(`pod ${name}: what its create makes does not end with the pod`);
  const watched = containerNames(pod).includes(WATCH_CONTAINER);
  let members: string[];
  try {
    members = shimMembersOf(pod);
  } catch (err) {
    return fails(errorWords(err));
  }
  const key = agentKeyOf(o.secret);
  if ((o.trees !== null || watched) && key === null) return fails(`pod ${name}: its Secret holds no ${AGENT_KEY_ENV} for its agents`);
  const secretName = o.secret?.metadata.name ?? null;
  const dial = ctx.dial ?? dialAgent;
  // The create, the Secret's and the pod's in one List, under one slot of the pace (the header's), waited for before
  // the ready budget and the init clock start.
  const createSlot = await paceSlot(ctx, 'create', o.signal);
  if (createSlot === null) return fails(`pod ${name} was cut off while it waited for the sandbox pace`);
  const createdAt = Date.now();
  const readyBudgetMs = ctx.readyTimeoutMs;
  const left = (): number => readyBudgetMs - (Date.now() - createdAt);
  const marks: Partial<Record<InitPhase, number>> = {};
  const mark = (phase: InitPhase): void => {
    if (marks[phase] !== undefined) return;
    const ms = Date.now() - createdAt;
    marks[phase] = ms;
    if (clocked) recordInit(phase, ms / 1000, 'cold');
  };
  let uid: string;
  try {
    const items = [...(o.secret === null ? [] : [o.secret]), ...o.objects];
    const made = await createPodObjects(ctx, items, createSlot);
    const podUid = made.failed === null ? (made.made.find((m) => m.kind === 'Pod' && m.name === name)?.uid ?? null) : null;
    // What the create found of the control plane (ControlPlaneSeen), read with the Secret's values out: createRefusal
    // words the API server's refusal as kubectl prints it, so controlPlaneFaultOfWords reads either create's the same.
    noteControlPlane('api', made.failed === null ? null : controlPlaneFaultOfWords(withoutValues(made.failed.said, o.secret)));
    if (podUid === null) {
      // The Secret made ahead of a pod that was not (or a create cut before it said which): deleted before the failure
      // is said, so nothing of the pod's outlives it.
      if (secretName !== null && (made.failed?.unknown === true || made.made.some((m) => m.kind === 'Secret' && m.name === secretName))) await deleteObjects(ctx, [`secret/${secretName}`]);
      // One wording whichever made it (CREATE_FAILED_WORDS: what every reader of a failure classifies by); the API
      // server's refusal is said as kubectl prints it (createRefusal), a cut as `creating <kind> <name>: cut: …`.
      if (made.failed !== null) {
        const said = withoutValues(made.failed.said, o.secret);
        return fails(`${CREATE_FAILED_WORDS} ${name}: ${said}`, !made.failed.unknown && NO_ROOM_RE.test(said) ? said : null);
      }
      return fails(`the create did not say pod ${name}'s uid, which its env Secret is owned by (it made ${JSON.stringify(made.made.map((m) => `${m.kind} ${m.name}`))})`);
    }
    uid = podUid;
  } finally {
    createSlot.release();
  }
  mark('created');
  // Off the critical path: nothing below waits on the owner (the pod's delete takes the Secret by name meanwhile).
  if (secretName !== null) void patchSecretOwner(ctx, secretName, { name, uid });
  if (o.killed()) return killed;

  // The pod's IP, from its watch (no kubectl spawned in a pod), read for awaitPod's verdicts on the same events.
  let placed = false;
  let last = 'no answer yet';
  let noRoom: string | null = null;
  const placedOnce = (p: WatchedPod): void => {
    if (placed) return;
    const bound = p.status?.conditions?.some((c) => c.type === 'PodScheduled' && c.status === 'True') === true || (typeof p.spec?.nodeName === 'string' && p.spec.nodeName !== '') || typeof p.status?.podIP === 'string';
    if (!bound) return;
    placed = true;
    mark('scheduled');
    o.onScheduled?.();
  };
  /** Why a pod read says it will never run its `stage` (neverThere's InitRunning, a pod finished), or null. */
  const neverIn = (p: PodJson): string | null => (neverThere(p, 'InitRunning') !== null || p.status?.phase === 'Failed' || p.status?.phase === 'Succeeded' ? describe(p) : null);
  const untilIp = (p: WatchedPod): { ip: string } | { never: string } | null => {
    placedOnce(p);
    const never = neverIn(p);
    if (never !== null) return { never };
    const ip = p.status?.podIP;
    if (typeof ip === 'string' && isIP(ip) !== 0) return { ip };
    last = describe(p);
    noRoom = noRoomIn(p);
    return null;
  };
  // A plan pod never placed says so (its `scheduled` never came); any other is not Ready.
  const unstaged = (what: string): AgentBootFailed =>
    fails(`pod ${name} never became ready: not ${o.plan === true && !placed ? 'scheduled' : 'Ready'} within ${readyBudgetMs} ms (${last}): its ${STAGE_CONTAINER} ${what}, so nothing was staged`, noRoom);
  const seen = await watchPod(ctx, name, untilIp, AbortSignal.any([o.signal, AbortSignal.timeout(Math.max(1, left()))]));
  if (o.killed()) return killed;
  if ('gone' in seen) return fails(`pod ${name} never became ready: the pod is gone (${seen.gone})`);
  if ('cut' in seen) {
    if (seen.unread !== undefined && seen.last === null) last = `could not read it: ${seen.unread}`;
    return unstaged('container never ran');
  }
  if ('never' in seen.verdict) return fails(`pod ${name} never became ready: ${seen.verdict.never}`);
  const ip = seen.verdict.ip;
  mark('ip');

  if (o.trees === null) return { ok: true, name, ip, stage: null, key, watched, members, createdAt };
  // Its `stage` agent, dialled until it answers (a SYN dropped while Cilium readies the endpoint costs a re-dial, never
  // the kernel's 1 s): the pod read between two slices, so a `stage` that will never run fails the boot at once.
  let stage: PodAgentSession | null = null;
  while (stage === null) {
    if (o.killed()) return killed;
    const budgetMs = Math.min(STAGE_DIAL_SLICE_MS, left());
    if (budgetMs <= 0) return unstaged(`agent at ${ip} never answered`);
    try {
      stage = await dial({ pod: name, ip, key: key!, agent: STAGE_CONTAINER, budgetMs, signal: o.signal });
    } catch (err) {
      if (o.killed()) return killed;
      if (!(err instanceof AgentDialError) || err.fault !== 'budget') return fails(`pod ${name}: its ${STAGE_CONTAINER} agent at ${ip} could not be reached: ${errorWords(err)}`);
      const read = await readPod(ctx, name);
      if (o.killed()) return killed;
      if ('gone' in read) return fails(`pod ${name} never became ready: the pod is gone (${read.gone})`);
      if ('error' in read) last = `could not read it: ${read.error}`;
      else {
        const never = neverIn(read.pod);
        if (never !== null) return fails(`pod ${name} never became ready: ${never}`);
        last = describe(read.pod);
        noRoom = noRoomIn(read.pod);
      }
    }
  }
  const session = stage;
  try {
    await session.health({ timeoutMs: Math.max(1, Math.min(left(), WATCH_DIAL_MS)), signal: o.signal });
  } catch (err) {
    void session.close();
    if (o.killed()) return killed;
    return fails(`pod ${name}: its ${STAGE_CONTAINER} agent at ${ip} did not answer: ${errorWords(err)}`);
  }
  mark('agent');
  const initMs = marks.agent!;
  o.onAgent?.(initMs);
  if (clocked && initMs > INIT_WARN_MS) {
    const phases = (['created', 'scheduled', 'ip', 'agent'] as const).map((p) => `${p} ${marks[p] ?? '?'} ms`).join(', ');
    initWarningsOf(ctx.warn).slow(name, initMs, `k8s sandbox: pod ${name}'s init took ${initMs} ms, past ${INIT_WARN_MS} ms (${phases}; a node's first pull of an image is part of it)`);
  }
  return { ok: true, name, ip, stage: session, key, watched, members, createdAt };
}

/**
 * The second half of a staged pod's boot (bootAgentPod's, above), on a pod bootToAgent reached (`at`: its `stage`
 * session is this call's from here, closed whatever the end): the staging over that session (the release ends
 * `stage`), Ready, then a pod with `watch` its `watch` agent dialled and, in a shim pod (at.members), the shim gate,
 * all within ctx.readyTimeoutMs from at.createdAt (a warm pod's: from its claim) with the staging's own time added on
 * top, the gate SHIM_GATE_MIN_MS at least; a pod that declares shims but has no `watch` (a taken pod whose caller's
 * members its pod does not match) fails at once, nothing staged. Ends as bootAgentPod does: only a boot that ends ok
 * hands its caller a pod any member exec may go into.
 */
export async function bootFromAgent(ctx: K8sContext, at: AgentReached, o: AgentStaging): Promise<AgentBoot> {
  const { name, ip, createdAt } = at;
  const killed: AgentBoot = { ok: false, killed: true };
  const fails = (error: string, noRoom: string | null = null): AgentBoot => (o.killed() ? killed : { ok: false, killed: false, error, noRoom });
  const dial = ctx.dial ?? dialAgent;
  let readyBudgetMs = ctx.readyTimeoutMs;
  const left = (): number => readyBudgetMs - (Date.now() - createdAt);
  // Fail closed: shims declared (a taken pod's from its caller, `watched` from the pod itself, so the two can disagree,
  // as a warm pod made before the shim shape's roll) and no `watch` to list them is no gate, so no pod to run in.
  if (at.members.length > 0 && !at.watched) {
    if (at.stage !== null) void at.stage.close();
    return fails(`pod ${name} never became ready: it has no ${WATCH_CONTAINER} agent to list its shims (${at.members.join(', ')}), so no exec went into ${at.members.length === 1 ? 'it' : 'any of them'}`);
  }
  if (o.trees !== null) {
    const session = at.stage;
    if (session === null) return fails(`pod ${name}: no ${STAGE_CONTAINER} agent session to stage its trees over`);
    if (o.killed()) {
      void session.close();
      return killed;
    }
    // The staging (its own budget, transferBudgetMs, moving with the bytes) is added to the ready budget.
    const stagingAt = Date.now();
    try {
      const staged = await stageStream({ agent: session, warn: ctx.warn }, { pod: name, container: STAGE_CONTAINER, trees: o.trees, signal: o.signal, command: (unpack) => stageCommand(unpack) });
      // Released: `stage` ends under its exec, and its agent with it.
      void staged.ended.then(() => session.close());
    } catch (err) {
      void session.close();
      if (o.killed()) return killed;
      return fails(errorWords(err));
    }
    if (o.killed()) return killed;
    readyBudgetMs += Date.now() - stagingAt;
  } else if (at.stage !== null) void at.stage.close();

  // Ready: `main` and `watch` running, which with `stage` is only once it has exited 0.
  const ready = o.plan === true ? await awaitPlanPod(ctx, name, readyBudgetMs, () => undefined, o.signal, { target: 'Ready', since: createdAt, placed: true }) : await awaitPod(ctx, name, 'Ready', left(), o.signal);
  if (o.killed()) return killed;
  if (!ready.ok) return fails(`pod ${name} never became ready: ${ready.last === undefined ? ready.why : `not Ready within ${readyBudgetMs} ms (${ready.last})`}`, ready.noRoom ?? null);
  const { watched, key, members } = at;
  if (!watched) return { ok: true, ip, watch: null };
  // Its `watch` agent, kept for the pod's life: the watch execs, the collect, the watch probe.
  let watch: PodAgentSession;
  try {
    watch = await dial({ pod: name, ip, key: key!, agent: WATCH_CONTAINER, budgetMs: WATCH_DIAL_MS, signal: o.signal, ...(members.length === 0 ? {} : { members }) });
  } catch (err) {
    if (o.killed()) return killed;
    return fails(`pod ${name}: its ${WATCH_CONTAINER} agent at ${ip} could not be reached: ${errorWords(err)}`);
  }
  if (o.killed()) {
    void watch.close();
    return killed;
  }
  // The shim gate (the header's The pod): no exec goes into a member until `watch` lists every shim the pod declares.
  if (members.length > 0) {
    const gate = await awaitShims(watch, members, Math.max(left(), SHIM_GATE_MIN_MS), o.signal);
    if (o.killed()) {
      void watch.close();
      return killed;
    }
    if (gate !== null) {
      void watch.close();
      return fails(`pod ${name} never became ready: its ${WATCH_CONTAINER} agent at ${ip} ${gate}, so no exec went into ${members.length === 1 ? 'it' : 'any of them'}`);
    }
  }
  return { ok: true, ip, watch };
}

/**
 * The shim gate (the header's The pod; bootFromAgent): `watch`'s /v1/health asked until its `containers` lists every
 * one of `members`, SHIM_REDIAL_MS apart, within `budgetMs`. Null once it does; else what it last said (its listed
 * shims by the budget's end, or its health's failure, at once, but for an ask the budget's end itself cut: a session
 * that does not answer is no pod to run in).
 * Until every declared shim is in, `watch`'s link listener is open, and a process in any member may take a missing
 * member's name with the mounted binary (#747 probe 4b: health cannot tell it apart); once all are in, it is closed for
 * the pod's life (probe 4). So it is the one rule every member exec is held to, whatever it is.
 */
export async function awaitShims(watch: PodAgentSession, members: readonly string[], budgetMs: number, signal?: AbortSignal): Promise<string | null> {
  const until = Date.now() + budgetMs;
  let listed: readonly string[] = [];
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) break;
    let health: AgentHealth;
    try {
      health = await watch.health({ timeoutMs: Math.max(1, Math.min(left, WATCH_PROBE_TIMEOUT_MS)), ...(signal === undefined ? {} : { signal }) });
    } catch (err) {
      // An ask the budget's own end cut (its timeout the few ms left of it) said nothing new: the budget's words, below,
      // not a dead agent's.
      if (Date.now() >= until) break;
      return `did not answer while its shims linked (${members.join(', ')}): ${errorWords(err)}`;
    }
    listed = health.containers;
    if (members.every((m) => listed.includes(m))) return null;
    if (signal?.aborted === true) break;
    await sleep(Math.min(SHIM_REDIAL_MS, Math.max(1, until - Date.now())), undefined, signal === undefined ? undefined : { signal }).catch(() => undefined);
  }
  const missing = members.filter((m) => !listed.includes(m));
  return `listed ${listed.length === 0 ? 'no shim' : `only ${listed.join(', ')}`} within ${budgetMs} ms, not ${missing.join(', ')}`;
}

/**
 * A program pod's boot (the header's first calls: K8sProcess #start's, and a case session's pod's): bootAgentPod, its
 * end as a PodBooted: killed, killedExit; every failure the driver's (failure), `noRoom` set when the node had no room
 * for the pod (a quota's refusal of the create, or the scheduler's words at the end of the budget).
 */
export async function bootPod(
  ctx: K8sContext,
  o: { name: string; objects: readonly K8sObject[]; secret: K8sObject | null; trees: readonly StageTree[] | null; signal: AbortSignal; killed: () => boolean; onAgent?: (ms: number) => void },
): Promise<PodBooted> {
  return podBootedOf(await bootAgentPod(ctx, o));
}

/**
 * A warm pod's boot from its claim on (the header's Warm pool; K8sProcess #start's on a pool's hit): bootFromAgent on the
 * pod the pool took, its ready budget from the claim, its end as a PodBooted as bootPod's. `members`, the shims the
 * taken pod's shape declares (shimMembersOf of the spawn's own pod: a warm pod keeps no spec), held to the shim gate.
 * Required, with no default: a warm pod keeps no spec to read them from, so a caller that forgot them would hand out a
 * pod with its gate skipped (a program registering as a member it is not before the grader's execs); a caller whose pod
 * declares none says `[]` itself (release 1's shape). A case session's pod declares `main` (k8s-session.ts).
 */
export async function bootTakenPod(ctx: K8sContext, taken: WarmPod, o: { trees: readonly StageTree[]; signal: AbortSignal; killed: () => boolean; members: readonly string[] }): Promise<PodBooted> {
  const at: AgentReached = { ok: true, name: taken.name, ip: taken.ip, stage: taken.stage, key: taken.key, watched: taken.watched, members: o.members, createdAt: Date.now() };
  return podBootedOf(await bootFromAgent(ctx, at, o));
}

/** bootAgentPod's end as a PodBooted (bootPod's): killed, killedExit; every failure the driver's, its node's no-room words kept. */
function podBootedOf(b: AgentBoot): PodBooted {
  if (b.ok) return b;
  if (b.killed) return { ok: false, exit: killedExit(), noRoom: null };
  return { ok: false, exit: failure(b.error), noRoom: b.noRoom };
}

/**
 * What a program's pod says once something run in it ended unexplained (K8sProcess #podVerdict, K8sPod #verdict): the
 * program's kill (out of memory, or evicted for its own writable volume, or its own kill of `main`'s first process), or
 * what it says, `gone` when the pod is.
 */
export type PodVerdict = { killed: true } | { killed: false; said: string; gone?: true };

/** readPodVerdict's answer: PodVerdict, with which kill it was (PodKill). */
export type PodEnd = { killed: true; kill: PodKill } | { killed: false; said: string; gone?: true };

/**
 * Why something run in pod `pod` ended unexplained (K8sProcess #podVerdict, whose words below are; a case session's reset
 * or restage, k8s-session.ts), from the pod's status, re-read for up to POD_SETTLE_MS while it settles (an OOM or an
 * eviction reaches it a moment after the exec is cut), or up to ctx.evictionSettleMs (EVICTION_SETTLE_MS) when the probe
 * below finds `watch` dead. `killed`, the program's kill: the pod ran out of memory (any container OOMKilled,
 * podOomKilled: under gVisor every container of the pod shows it; under no RuntimeClass, runc, a lone `watch` out of
 * memory would read as the program's 137 too) or was evicted for one of its own writable volumes' sizeLimit (evictedFor,
 * of `writable`: their volume names). Else what the pod says, for the driver's failure: gone (`gone`), unreadable by the
 * deadline, finished, or still unfinished at it. A pod with a writable mount still Running at POD_SETTLE_MS has `watch`
 * probed once (`opts.watch`, its agent's /v1/health within WATCH_PROBE_TIMEOUT_MS: watchAnswers; a caller with no
 * session reads it dead): dead too, the kubelet may be evicting
 * the whole pod, whose status can come tens of seconds later, so it is re-read up to the eviction settle from the start;
 * alive, the program ended `main` alone, and the pod is what it says now. Only a Running pod is probed: one Pending or
 * Unknown (its node lost) is not being evicted by a kubelet that is posting. `ownKill` (an exec that ended K8S_KILLED with
 * no sentinel; a session's reset or restage that failed) admits one more `killed`, the program's kill of its container's
 * first process (mainKilledFromWithin), held to the same reads, so a platform's kill that reaches the status within them
 * is still told: in a pod with a writable mount, once the probe at POD_SETTLE_MS finds `watch` alive and the read after it
 * still says so (`watch` dead: the eviction's wait as above, then the driver's failure); in one without (no probe: its
 * `watch`, which every shim pod has, a case session's among them, holds nothing
 * an eviction for a volume would be read by), when the read at POD_SETTLE_MS still says so.
 */
export async function readPodVerdict(ctx: K8sContext, pod: string, opts: { writable: readonly string[]; ownKill?: boolean; watch: PodAgentSession | null }): Promise<PodEnd> {
  const writable = opts.writable;
  const ownKill = opts.ownKill === true;
  const start = Date.now();
  let deadline = start + POD_SETTLE_MS;
  let probed = false;
  let answered = false;
  // The probe is the pod's `watch` agent's /v1/health (watchAnswers): a caller with no session of it reads `watch` as dead.
  const watchAlive = (): Promise<boolean> => watchAnswers(opts.watch);
  for (;;) {
    const read = await readPod(ctx, pod);
    if ('gone' in read) return { killed: false, said: 'the pod is gone', gone: true };
    if ('pod' in read) {
      const platform: PodKill | null = podOomKilled(read.pod) ? 'memory' : evictedFor(read.pod, writable) !== null ? 'volume' : null;
      if (platform !== null) return { killed: true, kill: platform };
      const own = ownKill && mainKilledFromWithin(read.pod);
      if (own && (writable.length === 0 ? Date.now() >= deadline : answered)) return { killed: true, kill: 'pid1' };
      const s = read.pod.status;
      const finished = s?.phase === 'Failed' || s?.phase === 'Succeeded';
      if (s?.phase === 'Running' && Date.now() >= deadline && !probed && writable.length > 0) {
        probed = true;
        if (!(await watchAlive())) deadline = start + (ctx.evictionSettleMs ?? EVICTION_SETTLE_MS);
        else if (own) {
          // `watch` answers: the pod read once more, for a deletion, an OOM or an eviction the probe's time let in.
          answered = true;
          continue;
        }
      }
      // `main` ended by its own program in a pod with no writable mount (never probed): read on to POD_SETTLE_MS, finished or not.
      if (own && writable.length === 0) {
        await sleep(POD_SETTLE_POLL_MS);
        continue;
      }
      if (finished || Date.now() >= deadline) return { killed: false, said: `the pod: ${describePod(read.pod)}` };
      // A container ended in a pod still Running: one moment more for an OOM or an eviction to reach its status.
      if (stopped(read.pod) && writable.length === 0) return { killed: false, said: `the pod: ${describePod(read.pod)}` };
    } else if (Date.now() >= deadline) return { killed: false, said: `the pod could not be read: ${read.error}` };
    await sleep(POD_SETTLE_POLL_MS);
  }
}

/** One meter registered on a program's watch (ProgramWatch.meter): what the watcher is told, and where its fault goes. */
interface ProcessMeter {
  spec: WatchMeterSpec;
  /** Its program's wall budget (TreeMeterOptions.budgetMs): the watcher's lifetime is reckoned from it. */
  budgetMs: number;
  onFault(message: string): void;
  /** stop() was called, or its fault reported: nothing more reaches it. */
  quiet: boolean;
  /** The watch exec it is in, once that started. */
  watch: RunningWatch | null;
}

/** One watch exec into `watch`: the meters it carries, and whether it mirrors the pod's live files. */
interface RunningWatch {
  live: LiveWatch;
  meters: readonly ProcessMeter[];
  files: boolean;
}

/**
 * An exec that never started (KubectlChild's shape): its stdio ended, its end `why` at once. What a watch exec is when
 * its pod has no `watch` agent session to run it on (ProgramWatch): its LiveWatch faults with `why`.
 */
function unstartedChild(why: string): KubectlChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdin.resume();
  stdout.end();
  stderr.end();
  return { stdin, stdout, stderr, closed: Promise.resolve({ code: null, signal: null, error: why }), kill: () => undefined };
}

/**
 * One program's watch (the header's The meter): its meters and its writable mounts' `live` files, in watch execs by its
 * pod's `watch` agent (the session `agent()` names: the pod's, once booted). A K8sProcess has one over its spec's mounts;
 * a plan pod's member (K8sPodProcess) one over its own, each read in `watch` at the member's own path (`dirOf`:
 * podPlanSpec's `/m/<member><mount point>`). A meter registered before the program's exec (start) goes in one watch exec
 * started just before it, with the live files; one registered once that exec runs gets an exec of its own, which carries
 * no live file. The program's exec over (stop): every exec stopped and awaited, no meter taken any more. A watch that
 * ends before it is stopped (its exec lost, or no session to run it on) is each of its meters' fault, unless the
 * program's exec ends within WATCH_FAULT_SETTLE_MS (a pod that ended whole: its exit says what happened); one with live
 * files and no meter to hand it to is `onFilesFault`'s, the process's own failure, after the same wait.
 */
export class ProgramWatch {
  readonly #ctx: K8sContext;
  /** The pod its watch execs go into: a case session's run's is its session's (repoint), known once it is readied. */
  #pod: string;
  /** The pod's `watch` agent session (none before its boot, or in a pod without one). */
  #agent: () => PodAgentSession | null;
  readonly #mounts: readonly SandboxMount[];
  readonly #dirOf: ((mount: SandboxMount) => string) | undefined;
  readonly #onFilesFault: (message: string) => void;
  /** The meters registered before the program's exec, which its watch exec takes with it. */
  #pendingMeters: ProcessMeter[] = [];
  /** The watch execs started, each stopped once the program's exec has ended. */
  readonly #watches: RunningWatch[] = [];
  /** The program's exec was asked for and has not ended: a meter registered now gets a watch exec of its own. */
  #open = false;
  /** The program's exec ended, or the process ended without one: nothing more is metered. */
  #over = false;
  #markOver: () => void = () => undefined;
  /** Settles once the program is over (stop). */
  readonly #end: Promise<void>;

  constructor(
    ctx: K8sContext,
    pod: string,
    mounts: readonly SandboxMount[],
    opts: { dirOf?: (mount: SandboxMount) => string; onFilesFault: (message: string) => void; agent: () => PodAgentSession | null },
  ) {
    this.#ctx = ctx;
    this.#pod = pod;
    this.#agent = opts.agent;
    this.#mounts = mounts;
    this.#dirOf = opts.dirOf;
    this.#onFilesFault = opts.onFilesFault;
    this.#end = new Promise<void>((resolve) => {
      this.#markOver = resolve;
    });
  }

  /**
   * Its watch execs go into `pod` from now on, by `agent`'s session (a case session's run, once its session readied
   * the pod: before start()).
   */
  repoint(pod: string, agent: () => PodAgentSession | null): void {
    this.#pod = pod;
    this.#agent = agent;
  }

  /** The mount point at which the program mounts `dir` writable, or null (none, or read-only). */
  writableAt(dir: string): MountPoint | null {
    const want = posix.normalize(dir).replace(/(.)\/$/, '$1');
    const m = this.#mounts.find((x) => !x.readOnly && posix.normalize(x.host).replace(/(.)\/$/, '$1') === want);
    return m === undefined ? null : m.at;
  }

  /** Whether the program's exec has ended (or the process ended without one): a meter registered now would read nothing. */
  get over(): boolean {
    return this.#over;
  }

  /**
   * Meter `dir`, a writable mount of the program's: its readings to `opts.onUsage`, a watch that fails before stop() to
   * `opts.onFault` (once). SandboxError, before anything starts, for a `dir` the program does not mount writable, a
   * program already over, or an argument the watcher would refuse (planWatch).
   */
  meter(dir: string, opts: TreeMeterOptions): TreeMeter {
    const at = this.writableAt(dir);
    if (at === null) throw new SandboxError(`pod ${this.#pod} does not mount ${dir} writable: there is nothing of it to meter`);
    if (this.#over) throw new SandboxError(`pod ${this.#pod}'s program is over: there is nothing of ${dir} left to meter`);
    if (!Number.isFinite(opts.budgetMs) || opts.budgetMs < 0) throw new SandboxError(`meter budget ${opts.budgetMs} is out of range`);
    const m: ProcessMeter = {
      budgetMs: opts.budgetMs,
      quiet: false,
      watch: null,
      onFault: (message) => opts.onFault(message),
      spec: {
        at,
        intervalMs: opts.intervalMs,
        maxEntries: opts.maxEntries,
        maxBytes: opts.maxBytes,
        maxDepth: opts.maxDepth,
        maxPathBytes: opts.maxPathBytes,
        onUsage: (u) => {
          if (!m.quiet) opts.onUsage(u);
        },
      },
    };
    // Its argv built now, so a bad cap or interval throws here, before anything starts.
    this.#plan([m], false);
    if (this.#open) this.#startWatch([m], false);
    else this.#pendingMeters.push(m);
    return { stop: () => this.#stopMeter(m) };
  }

  /** The program's exec is asked for: the meters registered so far and the live files, in one watch exec beside it. */
  start(): void {
    if (this.#over) return;
    this.#open = true;
    const meters = this.#pendingMeters.filter((m) => !m.quiet);
    this.#pendingMeters = [];
    this.#startWatch(meters, true);
  }

  /** The program's exec is over (or the process ended without one): every watch stopped and awaited, no meter left waiting. */
  async stop(): Promise<void> {
    this.#over = true;
    this.#open = false;
    this.#markOver();
    this.#pendingMeters = [];
    await Promise.all(this.#watches.map((w) => w.live.stop()));
  }

  /**
   * The watch for `meters`, and with `files` every writable mount's `live` files, or null when that is nothing. Its
   * lifetime: with a meter, what can still pass once the exec starts (the policy wait or a door dial, the program's
   * exec's start, the program's budget, METER_SLACK_MS); live files alone, STALE_AFTER_MS, the pod's own
   * activeDeadlineSeconds.
   */
  #plan(meters: readonly ProcessMeter[], files: boolean): ReturnType<typeof planWatch> {
    const preStartMs = POLICY_WAIT_MS + KUBECTL_TIMEOUT_MS + (this.#ctx.execStartTimeoutMs ?? EXEC_START_TIMEOUT_MS);
    const lifetimeMs = meters.length === 0 ? STALE_AFTER_MS : Math.max(...meters.map((m) => m.budgetMs)) + METER_SLACK_MS + preStartMs;
    const mounts = this.#mounts.map(({ live, ...m }): SandboxMount => (files && live !== undefined ? { ...m, live } : m));
    return planWatch({ mounts, meters: meters.map((m) => m.spec), lifetimeMs, ...(this.#dirOf === undefined ? {} : { dirOf: this.#dirOf }) });
  }

  /**
   * Exec the watcher for `meters`, and with `files` the live files, by the pod's `watch` agent (the header); nothing when
   * that is nothing to watch. With no session to run it on, the exec is one that never started: the watch's fault.
   */
  #startWatch(meters: readonly ProcessMeter[], files: boolean): void {
    const plan = this.#plan(meters, files);
    if (plan === null) return;
    const agent = this.#agent();
    let child: KubectlChild;
    try {
      child = agent === null ? unstartedChild(`pod ${this.#pod} has no ${WATCH_CONTAINER} agent session to run its watcher on`) : agent.stream(WATCH_CONTAINER, plan.command);
    } catch (err) {
      child = unstartedChild(`the watch exec could not be made: ${errorWords(err)}`);
    }
    const w: RunningWatch = { meters, files: plan.files.length > 0, live: new LiveWatch(child, plan, { onFault: (message) => this.#watchFault(w, message) }) };
    for (const m of meters) m.watch = w;
    this.#watches.push(w);
  }

  /**
   * A watch ended before it was stopped (LiveWatch's fault): each of its meters' fault, unless the program's exec ends
   * within WATCH_FAULT_SETTLE_MS (a pod that ended whole: the program's exit says what happened). A watch of live files
   * with no meter left to hand it to is onFilesFault's instead, after the same wait: the program's own failure.
   */
  #watchFault(w: RunningWatch, message: string): void {
    void settlesWithin(this.#end, WATCH_FAULT_SETTLE_MS).then((over) => {
      if (over) return;
      let handed = false;
      for (const m of w.meters) {
        if (m.quiet) continue;
        m.quiet = true;
        handed = true;
        m.onFault(`pod ${this.#pod}: ${message}`);
      }
      if (handed || !w.files) return;
      this.#onFilesFault(`pod ${this.#pod}: ${message}`);
    });
  }

  /**
   * A meter's stop(): nothing more reaches it; its watch exec is stopped once none of its meters is left, unless that
   * exec also mirrors live files, which it goes on doing until the program's exec ends (stop).
   */
  async #stopMeter(m: ProcessMeter): Promise<void> {
    m.quiet = true;
    this.#pendingMeters = this.#pendingMeters.filter((x) => x !== m);
    const w = m.watch;
    if (w !== null && !w.files && w.meters.every((x) => x.quiet)) await w.live.stop();
  }
}

/**
 * A program in its pod (the header), returned before anything reached the cluster, as a DockerProcess is
 * before its container exists.
 */
export class K8sProcess implements SandboxProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exited: Promise<SandboxExit>;
  /** The wrapper's start line came: the program runs now, after its pod's create, Ready and policy wait. */
  readonly started: Promise<void>;
  /**
   * The program itself ended (types.ts SandboxProcess.finished): at the wrapper's sentinel, or once the program's exec
   * ended without one, or the process ended without an exec; before the watch is stopped, the mounts collected and the
   * pod deleted. Never rejects; settles no later than `exited`.
   */
  readonly finished: Promise<void>;
  /** Its pod's name (a case session's run's: its session's pod, once readied; the one it was spawned toward before). */
  #pod: string;
  readonly #markStarted: () => void;
  readonly #markFinished: () => void;
  /** Why a watch that mirrors live files ended unstopped with no meter to hand it to (ProgramWatch): the process's failure. */
  #watchFailure: string | null = null;
  readonly #ctx: K8sContext;
  readonly #launch: Launch;
  readonly #abort = new AbortController();
  /** The create was sent: the pod (and what came with it) is deleted at the end. */
  #created = false;
  /** The pod's IP is in PodNames. */
  #registered = false;
  /** The sentinel came: the wrapper has already ended everything the program started. */
  #reported = false;
  #killed = false;
  #done = false;
  #child: KubectlChild | null = null;
  #killing: Promise<void> | null = null;
  /** The wrapper's start line came: the program was handed to the shell to run. */
  #began = false;
  /** The sentinel came: the wrapper has nothing left to run. */
  #ended = false;
  /** A timed pod's launcher reading, once its exec ended with it. */
  #cpu: bigint | null = null;
  /** Why the node had no room for the pod, when that is why its program never ran (noRoom). */
  #noRoom: string | null = null;
  /** What its own calls last found of the control plane (controlPlane). */
  readonly #seen: ControlPlaneSeen = controlPlaneUnseen();
  /** How long the entry's policy wait took, once it ran (policyWaitMs). */
  #policyWaitMs: number | null = null;
  /** How the pod ended it, or null: out of memory, evicted for its own writable volume, or its program killed `main`'s first process (podKill, podKilled). */
  #podKill: PodKill | null = null;
  /** The kill of a program cut off failed (#cleanup): it may still run in the pod. */
  #killFailed = false;
  /** Its meters and its live files (ProgramWatch), over its spec's mounts. */
  readonly #watch: ProgramWatch;
  /**
   * Its pod's `watch` agent (the header's Agent sessions): its boot's, kept to its end and closed then; a case session's
   * run's, its session's (SessionPrepared.watch), never closed here. Null before the boot, or in a pod with no `watch`.
   */
  #watchAgent: PodAgentSession | null = null;
  /** What its end deletes (Launch.refs; a warm pod's, once taken). */
  #refs: readonly string[];
  /** The spawn call: a warm pod's init clock and every program's `started` run from it (agent-client.ts's init clock). */
  readonly #spawnedAt = Date.now();
  /** Where its pod came from (the init clock's source): a warm pool's pod taken, or one made for it. */
  #source: InitSource = 'cold';

  constructor(ctx: K8sContext, launch: Launch) {
    this.#ctx = ctx;
    this.#launch = launch;
    this.#pod = launch.name;
    this.#refs = launch.refs;
    let mark: () => void = () => undefined;
    this.started = new Promise<void>((resolve) => {
      mark = resolve;
    });
    this.#markStarted = mark;
    let end: () => void = () => undefined;
    this.finished = new Promise<void>((resolve) => {
      end = resolve;
    });
    this.#markFinished = end;
    // A watch of live files that ended unstopped with no meter to hand it to: the driver's failure, the program's exec cut.
    this.#watch = new ProgramWatch(ctx, launch.name, launch.mounts ?? [], {
      onFilesFault: (message) => {
        this.#watchFailure ??= message;
        this.#child?.kill();
      },
      agent: () => this.#watchAgent,
    });
    this.exited = CONTROL_PLANE_SEEN.run(this.#seen, () => this.#run());
  }

  /**
   * The control plane's fault its own last call of it met (ControlPlaneSeen: its API server's),
   * null once that call was answered: read once it exited as the driver's failure (controlPlaneOf), when that fault is why.
   */
  get controlPlane(): ControlPlaneFault | null {
    return controlPlaneFaultIn(this.#seen);
  }

  /** The pod's name. */
  get pod(): string {
    return this.#pod;
  }

  /** The mount point at which this process's pod mounts `dir` writable, or null (none, or read-only). */
  writableAt(dir: string): MountPoint | null {
    return this.#watch.writableAt(dir);
  }

  /** Whether the program's exec has ended (or the process ended without one): a meter registered now would read nothing. */
  get programOver(): boolean {
    return this.#watch.over;
  }

  /**
   * Meter `dir`, a writable mount of this process's (K8sSandbox.meterTree; the header): its readings to `opts.onUsage`, a
   * watch that fails before stop() to `opts.onFault` (once). Registered before the program's exec, it goes in the watch
   * exec beside it; once that exec runs, in a watch exec of its own (ProgramWatch). SandboxError, before anything starts,
   * for a `dir` this process does not mount writable, a program already over, or an argument the watcher would refuse.
   */
  meter(dir: string, opts: TreeMeterOptions): TreeMeter {
    return this.#watch.meter(dir, opts);
  }

  /** The program's exec is over: every watch stopped (the wrapper's kill reaches `main` alone), no meter left waiting. */
  async #stopWatches(): Promise<void> {
    await this.#watch.stop();
  }

  /** Whether the wrapper's start line came: the program ran, or was handed to the shell to run. */
  get programStarted(): boolean {
    return this.#began;
  }

  /** A timed pod's CPU launcher reading in µs (the header's Timing), once it exited with one; null otherwise. */
  get cpuUs(): bigint | null {
    return this.#cpu;
  }

  /**
   * Once it exited as the driver's failure because the node had no room for its pod (the header's Room on the node: the
   * scheduler held it Pending for room through its whole ready budget, or a quota refused its create), the scheduler's or
   * the API's words; null otherwise. Its program never ran then.
   */
  get noRoom(): string | null {
    return this.#noRoom;
  }

  /**
   * How long its policy wait took (the header's trial network paragraph), in ms on the grader's clock: from the moment its
   * exec was asked for to the moment it answered, so the exec's own start is in it, whether every peer took a connection
   * or the wait failed (its failure says the same figure). Null when no wait ran: a pod that is no entry, an entry with
   * no served peer, or one that ended before the wait.
   */
  get policyWaitMs(): number | null {
    return this.#policyWaitMs;
  }

  /**
   * Whether its pod ended it (#podVerdict, read once its program's exec ended with no sentinel or its collect failed):
   * out of memory (any container OOMKilled) or evicted for one of its own writable volumes' sizeLimit, or its program
   * killed its container's first process, ending `main` under it (mainKilledFromWithin). It then exited K8S_KILLED,
   * nothing of its mounts returned, and a caller can tell that from a 137 the program's own sentinel said. Which of the
   * three it was is podKill: only `memory` is out of memory, so a caller words the kill from that, never from this.
   */
  get podKilled(): boolean {
    return this.#podKill !== null;
  }

  /** How its pod ended it, once podKilled (PodKill: `memory`, `volume` or `pid1`); null otherwise. */
  get podKill(): PodKill | null {
    return this.#podKill;
  }

  kill(): Promise<void> {
    this.#killing ??= (async () => {
      this.#killed = true;
      this.#abort.abort();
      const child = this.#child;
      if (this.#launch.timed === true && child !== null && this.#began && !this.#ended && !this.#done) await this.#killTimed(child);
      else child?.kill();
      await this.exited;
    })();
    return this.#killing;
  }

  /**
   * A timed program's kill (the header's Timing): every process of its user SIGKILLed in the pod (TIMED_KILL_ARGV), the
   * launcher left to reap them and print its reading and the sentinel; the exec cut once those came, or at
   * TIMED_KILL_MS without them (no reading then: the clock faults).
   */
  async #killTimed(child: KubectlChild): Promise<void> {
    const stop = new AbortController();
    const soft = this.#member().run(TIMED_KILL_ARGV, { signal: stop.signal, timeoutMs: SIGNAL_TIMEOUT_MS });
    if (!(await settlesWithin(child.closed, this.#ctx.timedKillMs ?? TIMED_KILL_MS))) child.kill();
    // Its own loop ends with the wrapper's `kill -1`, or with the pod's delete.
    stop.abort();
    await soft;
  }

  /**
   * SIGTERM to the program and everything it started (`kill -TERM -1` in its pod; the wrapper ignores it):
   * docker kill --signal TERM's twin for a service's orderly stop. A no-op before the program runs or once it
   * has exited.
   */
  async terminate(): Promise<void> {
    if (this.#child === null || this.#done) return;
    await this.#signal('TERM');
  }

  /**
   * `sig` to everything in `main` but its PID 1: null once the signal ran there, else what failed. kill(-1) spares the
   * caller and the container's PID 1 (the shim; a case session's pod's, the shim as its session reaper); its own status says nothing (none
   * left to signal is fine), so the script exits 0 after it, and any other end is the exec's (`main` or its shim gone,
   * the agent's session dead, SIGNAL_TIMEOUT_MS): the signal never reached the program, which may still run.
   */
  async #signal(sig: 'TERM' | 'KILL'): Promise<string | null> {
    const r = await this.#member().run(['/bin/sh', '-c', `kill -s ${sig} -- -1; exit 0`], { timeoutMs: SIGNAL_TIMEOUT_MS });
    return r.code === 0 && r.error === undefined ? null : why(r);
  }

  /**
   * How its execs reach `main` (MemberExec): over its pod's `watch` agent session, relayed to `main`'s shim; a case
   * session's run's, over the session pod's `watch` session its prepare handed it (SessionPrepared.watch).
   */
  #member(): MemberExec {
    return agentMember(this.#watchAgent, this.pod, CONTAINER);
  }

  async #run(): Promise<SandboxExit> {
    let exit: SandboxExit;
    try {
      exit = await this.#start();
    } catch (err) {
      exit = failure(`pod ${this.pod}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The program is over, whatever ended it (at its sentinel `finished` came already).
    this.#markFinished();
    // Whatever ended it (a failure before the exec too), nothing is metered past here: every watch stopped, its stop()
    // awaited, so nothing of a live mirror is still being written when the collect empties the host directories.
    await this.#stopWatches();
    this.#done = true;
    // Nothing reads stdin any more: what is written now is dropped, never left blocking its writer.
    this.stdin.unpipe();
    this.stdin.resume();
    if (!this.stdout.writableEnded) this.stdout.end();
    if (!this.stderr.writableEnded) this.stderr.end();
    const after = await this.#cleanup();
    // A collect that failed is the driver's failure (the job retried), or in a pod out of memory the program's kill (137,
    // whatever its sentinel said; `finished` stays where it came), unless the run was a driver's failure already.
    if (after !== null && !(exit.code === K8S_DRIVER_FAILURE && exit.error !== undefined)) exit = after;
    // A case session's run: its session is told how it ended (is its pod spent?) before `exited` settles, so the next
    // run, spawned once this one has exited, finds the session knowing.
    const session = this.#launch.session;
    if (session !== undefined) {
      try {
        session.settle({ exit, podKill: this.#podKill, execStarted: this.#child !== null, killed: this.#killed, killFailed: this.#killFailed });
      } catch (err) {
        this.#ctx.warn(`k8s sandbox: pod ${this.pod}: its session could not be told how its run ended: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await Promise.all([delivered(this.stdout), delivered(this.stderr)]);
    return exit;
  }

  async #start(): Promise<SandboxExit> {
    const session = this.#launch.session;
    if (session !== undefined) return await this.#startSession(session);
    const stage = this.#launch.stage;
    const warm = this.#launch.warm;
    // A pool-ready spawn asks its warm pool first (the header's Warm pool): a pod it hands over is this process's from
    // here (its delete, collect and failures as a pod made for it), booted on from its `stage` agent; none, a cold boot.
    const taken = warm === undefined || stage === undefined || this.#killed ? null : await warm.take();
    let booted: PodBooted;
    if (taken !== null) {
      this.#source = 'warm';
      this.#pod = taken.name;
      this.#refs = taken.refs;
      this.#created = true;
      this.#watch.repoint(taken.name, () => this.#watchAgent);
      recordInit('agent', (Date.now() - this.#spawnedAt) / 1000, 'warm');
      if (this.#killed) {
        void taken.stage.close();
        return killedExit();
      }
      // The staging into the taken pod over its `stage` session, Ready, `watch`'s agent (bootTakenPod: the ready budget
      // from the claim, the staging exec's own on top).
      booted = await bootTakenPod(this.#ctx, taken, { trees: stage!.trees, signal: this.#abort.signal, killed: () => this.#killed, members: warm!.members });
    } else {
      const objects = await this.#launch.objects();
      if (this.#killed) return killedExit();
      this.#created = true;
      // The Secret and the pod, its IP, `stage`'s agent, the staging, Ready, `watch`'s agent (bootPod: one ready budget,
      // the staging exec's own on top).
      booted = await bootPod(this.#ctx, {
        name: this.pod,
        objects,
        secret: this.#launch.secret ?? null,
        trees: stage === undefined ? null : stage.trees,
        signal: this.#abort.signal,
        killed: () => this.#killed,
        ...(warm === undefined ? {} : { onAgent: (ms: number) => warm.noteBoot(ms) }),
      });
    }
    if (!booted.ok) {
      this.#noRoom = booted.noRoom;
      return booted.exit;
    }
    this.#watchAgent = booted.watch;
    const net = this.#launch.network;
    if (net !== null) {
      // Its IP as its boot saw it on the pod's watch: a pod keeps its IP for its life.
      this.#ctx.names.register(net.name, this.pod, booted.ip, net.names, net.port ?? null);
      this.#registered = true;
    }
    if (this.#killed) return killedExit();
    const reach = this.#launch.reach;
    if (reach !== undefined) {
      const missed = await this.#reachPeers(reach.argv, reach.peers());
      if (this.#killed) return killedExit();
      if (missed !== null) return failure(`pod ${this.pod} could not reach its trial's services within ${POLICY_WAIT_MS} ms of Ready, so its trial policy is not enforced for it (${missed}; the wait took ${this.#policyWaitMs} ms)`);
    }
    return await this.#exec();
  }

  /**
   * A case session's run (the header's Case sessions): the session readies its pod (SessionLaunch.prepare: a boot, or
   * the reset; then the restage), which this process neither makes nor deletes; then the exec as every program's, under
   * the wrapper and argv the session gives. A run the session could not ready ends as it says (the driver's failure, the
   * node's room in noRoom; killed, killedExit).
   */
  async #startSession(session: SessionLaunch): Promise<SandboxExit> {
    const ready = await session.prepare(this.#abort.signal);
    if (!ready.ok) {
      if (this.#killed) return killedExit();
      this.#noRoom = ready.noRoom ?? null;
      return ready.exit;
    }
    this.#pod = ready.pod;
    this.#watchAgent = ready.watch ?? null;
    this.#watch.repoint(ready.pod, () => this.#watchAgent);
    // The pod holds this run from here: its kill and collect act on it (its delete is the session's, never this one's).
    this.#created = true;
    if (this.#killed) return killedExit();
    return await this.#exec(ready);
  }

  /**
   * The policy wait: from inside the pod, each peer takes a connection (POLICY_WAIT_ARGV) on its POLICY_PORT
   * before the program runs, measured, never assumed from Ready. Null once all did (or there are none), else
   * what failed. How long it took is policyWaitMs. One exec over the pod's `watch` agent into `main` (#member): no
   * slot of the pace, nothing of the control plane.
   */
  async #reachPeers(argv: readonly string[], peers: readonly ServedPeer[]): Promise<string | null> {
    if (peers.length === 0) return null;
    const targets = peers.flatMap((p) => [p.ip, String(POLICY_PORT)]);
    const askedAt = Date.now();
    const r = await this.#member().run([...argv, String(POLICY_WAIT_MS), ...targets], { signal: this.#abort.signal, timeoutMs: POLICY_WAIT_MS + KUBECTL_TIMEOUT_MS });
    this.#policyWaitMs = Date.now() - askedAt;
    if (r.code === 0 && r.error === undefined) return null;
    const said = r.stdout.trim().split('\n').at(-1) ?? '';
    const [at] = said.split(' ');
    const peer = peers.find((p) => `${p.ip}:${POLICY_PORT}` === at);
    if (r.code === 1 && r.error === undefined && peer !== undefined) return `${peer.names[0] ?? 'a peer'} at ${said}`;
    return `the wait did not run: ${why(r)}`;
  }

  async #exec(session?: Extract<SessionPrepared, { ok: true }>): Promise<SandboxExit> {
    const timed = this.#launch.timed === true;
    const wrapper = session !== undefined ? session.wrapper : timed ? TIMED_EXEC_WRAPPER : EXEC_WRAPPER;
    const argv = session !== undefined ? session.argv : this.#launch.argv;
    // The meters registered so far and the live files, in one watch exec beside the program's; a meter registered from
    // now on gets one of its own.
    this.#watch.start();
    // The program's budget runs from the start line only, so the exec's own start is bounded here instead: one exec over
    // the pod's `watch` agent into `main` (#member), a case session's too, sent once, holding no slot of the pace.
    const { child, scanner, end, unstarted, claimed, startMs, flushed } = await runProgramExec({
      member: this.#member(),
      ctx: this.#ctx,
      command: ['/bin/sh', '-c', wrapper, 'sh', String(this.#launch.pids), ...argv],
      ...(this.#launch.env === undefined ? {} : { env: this.#launch.env }),
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      killed: () => this.#killed,
      onChild: (c) => {
        this.#child = c;
      },
      onStart: () => {
        this.#began = true;
        // A program pod's whole wait, from the spawn call to its start line, by where its pod came from (a case
        // session's run is clocked by none: its pod is its session's).
        if (session === undefined) recordInit('started', (Date.now() - this.#spawnedAt) / 1000, this.#source);
        this.#markStarted();
      },
      onSentinel: () => {
        this.#ended = true;
        // The program's own end (D6): its wall time stops here, before the watch is stopped and its mounts collected.
        this.#markFinished();
      },
    });
    this.#markFinished();
    // The program's exec is over: its watches are the driver's to stop (nothing in `main` reaches `watch`).
    await this.#stopWatches();
    await flushed;
    this.stdin.unpipe(child.stdin);
    if (scanner.rc !== null) {
      this.#reported = true;
      if (timed) {
        // The wrapper prints the reading only when the launcher wrote one: without it the run cannot be counted.
        this.#cpu = scanner.cpuUs;
        if (this.#cpu === null) return failure(`pod ${this.pod}: the CPU launcher reported no CPU time (the wrapper's status ${scanner.rc}; its own words, if any, end the program's stderr)`);
      }
      // A session case's sentinel with no `i ok` report: the case launcher did not run it (its namespaces not made), the
      // driver's failure, never the case's.
      if (session !== undefined && session.report !== null && scanner.report !== session.report) {
        return failure(`pod ${this.pod}: the case launcher reported ${scanner.report === null ? 'nothing' : JSON.stringify(scanner.report)}, not ${session.report} (the wrapper's status ${scanner.rc}; its own words, if any, end the program's stderr)`);
      }
      return { code: scanner.rc, signal: null };
    }
    if (this.#killed) return killedExit();
    if (this.#watchFailure !== null) return failure(this.#watchFailure);
    if (claimed) return failure(claimedWords(`pod ${this.pod}`));
    if (unstarted) return failure(`pod ${this.pod}: the exec did not start the program within ${startMs} ms`);
    return await this.#unexplained(end);
  }

  /**
   * The exec ended without the sentinel: the pod says why (the header), re-read for up to POD_SETTLE_MS while its status
   * settles (an OOM or an eviction is reported a moment after the exec is cut), or up to EVICTION_SETTLE_MS for a Running
   * pod with a writable mount whose `watch` is dead too (#podVerdict). Any container OOMKilled, or
   * evicted for a writable mount's sizeLimit (evictedFor), is 137, the program's kill; so is an exec that ended 137
   * where the program killed its container's first process (mainKilledFromWithin, `watch` answering when the pod has
   * one); anything else, a finished pod or none, the driver's failure.
   */
  async #unexplained(end: KubectlEnd): Promise<SandboxExit> {
    const exec = execEndWords(end);
    const verdict = await this.#podVerdict(end.code === K8S_KILLED && end.signal === null && end.error === undefined);
    return verdict.killed ? killedExit() : failure(`pod ${this.pod}: the program ended without its exit status (${exec}); ${verdict.said}`);
  }

  /**
   * Why something run in this pod ended unexplained (the program's exec with no sentinel, #unexplained; a collect that
   * failed, #cleanup): readPodVerdict over its writable mounts' volumes, its kill kept as podKill.
   * `ownKill` (#unexplained: the program's exec ended K8S_KILLED with no sentinel) admits the program's kill of its
   * container's first process (mainKilledFromWithin).
   */
  async #podVerdict(ownKill = false): Promise<PodVerdict> {
    const writable = (this.#launch.stage?.collect ?? []).map((m) => mountVolumeName(m.mount));
    // The watch probe over the pod's `watch` agent (none: no answer, `watch` read as dead).
    const v = await readPodVerdict(this.#ctx, this.pod, { writable, ownKill, watch: this.#watchAgent });
    if (!v.killed) return v;
    this.#podKill = v.kill;
    return { killed: true };
  }

  /**
   * After the program (#run): its name out of PodNames; a program cut off killed in `main`; a staged pod's writable
   * mounts collected from `watch` (collectMounts) when its program's exec ran and its pod still holds them (the sentinel
   * came, or kill() cut a program that had started); then the delete. Null once nothing failed. A collect that failed
   * in a pod out of memory or evicted for its own writable volume (#podVerdict, read before the delete) is the program's
   * kill, K8S_KILLED, every writable mount's host directory emptied (a cut collect leaves a partial replica there); any
   * other is the driver's failure. Nothing is collected from a pod whose program may still run: a kill exec that failed
   * (#signal) is followed by no collect but a read of the pod (#podVerdict): out of memory or evicted for its own
   * writable volume is the program's kill, K8S_KILLED, and a pod that is gone the kill done, K8S_KILLED, each with every
   * writable mount's host directory emptied (nothing returned); any other pod, alive or not, the driver's failure naming
   * the kill.
   */
  async #cleanup(): Promise<SandboxExit | null> {
    if (this.#registered) this.#ctx.names.unregister(this.#launch.network!.name, this.pod);
    if (!this.#created) return null;
    // A program cut off (killed, or its exec lost) may still run in the pod: everything there dies before
    // kill() returns, as everything in a removed container does.
    const unkilled = !this.#reported && this.#child !== null ? await this.#signal('KILL') : null;
    this.#killFailed = unkilled !== null;
    let after: SandboxExit | null = null;
    const collect = this.#launch.stage?.collect ?? [];
    const collecting = collect.length > 0 && (this.#reported || (this.#killed && this.#child !== null));
    if (collecting) {
      const collected = await collectProgram(this.#ctx, this.pod, collect, unkilled, () => this.#podVerdict(), this.#watchAgent);
      // A host directory that could not be emptied: the driver's failure (never read), not the program's kill.
      if (collected.kept) this.#podKill = null;
      after = collected.exit;
    }
    // A case session's pod is the session's to delete (SessionLaunch.settle, its close), never one run's, and so is its
    // `watch` agent's session; this pod's own goes with it.
    if (this.#launch.session === undefined) {
      await deleteObjects(this.#ctx, this.#refs);
      const agent = this.#watchAgent;
      this.#watchAgent = null;
      if (agent !== null) await agent.close();
    }
    return after;
  }
}

/**
 * A program's writable mounts once its exec has ended (the header's Staging; a K8sProcess's and a plan pod member's
 * alike): collected from `watch` (collectMounts, by the pod's `watch` agent `agent`: no pace slot, it never touches the
 * control plane) into their host directories; or, when the kill of a program cut off failed (`unkilled`, its words),
 * never collected, since it may still be writing while the packer reads, and its pod read instead (`verdict`). `exit` is
 * null once everything came back. A collect that failed (no session to run it on among the ways) in a pod out of memory
 * or evicted for its own writable volume is the program's kill, K8S_KILLED, every writable mount's host directory emptied
 * (a cut collect leaves a partial replica there); any other is the driver's failure. A failed kill: out of memory or
 * evicted for its own writable volume is the program's kill and a pod that is gone the kill done, each K8S_KILLED with
 * every host directory emptied (nothing returned); any other pod, alive or not, the driver's failure naming the kill.
 * `kept`: a host directory could not be emptied, which is the driver's failure (never read), not the program's kill.
 */
export async function collectProgram(
  ctx: K8sContext,
  pod: string,
  collect: readonly CollectMount[],
  unkilled: string | null,
  verdict: () => Promise<PodVerdict>,
  agent: PodAgentSession | null,
): Promise<{ exit: SandboxExit | null; kept: boolean }> {
  if (unkilled !== null) {
    const kill = `pod ${pod}: the kill of its program failed (${unkilled})`;
    const read = await verdict();
    if (!read.killed && read.gone !== true) return { exit: failure(`${kill}, so nothing was collected from a program that may still run; ${read.said}`), kept: false };
    const left = await emptyHostDirs(collect);
    if (left === null) return { exit: killedExit(), kept: false };
    return { exit: failure(`${kill}; ${read.killed ? 'the pod ran out of memory or was evicted for its own volume' : read.said}, and ${left}`), kept: true };
  }
  try {
    if (agent === null) throw new SandboxError(`pod ${pod}: the collect of ${collect.map((m) => m.mount).join(', ')} has no ${WATCH_CONTAINER} agent session to run on`);
    await collectMounts({ agent, warn: ctx.warn }, { pod, mounts: collect });
    return { exit: null, kept: false };
  } catch (err) {
    const lost = err instanceof Error ? err.message : String(err);
    const read = await verdict();
    if (!read.killed) return { exit: failure(`${lost}; ${read.said}`), kept: false };
    const left = await emptyHostDirs(collect);
    return left === null ? { exit: killedExit(), kept: false } : { exit: failure(`${lost}; the pod ran out of memory or was evicted for its own volume, and ${left}`), kept: true };
  }
}

/**
 * SIGTERM to a k8s sandbox's program and what it started (K8sProcess.terminate): the harnesses' orderly stop
 * of a service (agent.ts, scrape/trial.ts), docker kill --signal TERM's twin.
 */
export async function k8sTerminate(proc: SandboxProcess): Promise<void> {
  if (!(proc instanceof K8sProcess) && !(proc instanceof K8sPodProcess)) throw new SandboxError('a k8s sandbox\'s process is no K8sProcess: it cannot be sent SIGTERM');
  await proc.terminate();
}

/**
 * The pod slots a caller may count on the nodes whose free slots are `free`, when it keeps `headroom` of them free on
 * each node and takes that headroom off the answer itself (server/jobs.ts nodeHasRoom): each node's slots past the
 * headroom (never less than 0), summed, with the headroom given back once, or, when no node has more than it, the
 * freest node's slots. On one node, or with no headroom, that is the plain sum; on several, a node inside its headroom
 * lends nothing, where the plain sum would lend its last slots to a job no node has room for.
 */
export function roomBesideHeadroom(free: readonly number[], headroom: number): number {
  const past = free.reduce((sum, f) => sum + Math.max(0, f - headroom), 0);
  return past + Math.min(headroom, Math.max(0, ...free));
}

/**
 * Why the node had no room for a process's pod, when that is why it never ran (K8sProcess.noRoom: the header's Room on
 * the node; a plan pod's member, K8sPodProcess.noRoom); null for any other end, and for any other driver's process,
 * which no node holds back.
 */
export function noRoomOf(proc: SandboxProcess): string | null {
  return proc instanceof K8sProcess || proc instanceof K8sPodProcess ? proc.noRoom : null;
}

/** A preflight pod the node had no room for (the header's Room on the node): backpressure, never a fault of the image or the RBAC. */
export class NodeRoomError extends SandboxError {
  /** The scheduler's or the API's words. */
  readonly noRoom: string;
  constructor(message: string, noRoom: string) {
    super(message);
    this.name = 'NodeRoomError';
    this.noRoom = noRoom;
  }
}

/**
 * The control-plane fault kubectl call `r` met, by capacity.ts's reading of kubectl's words and its cut
 * (controlPlaneFaultOfWords over saidOf): `shed` an API-server 429, `unreachable` the API server answering nothing (its
 * dial refused or timed out, or it shutting down). Null for a call that exited 0 or failed any other way (a NotFound,
 * an exec path's words: no exec of grading crosses the API server). Hand it only a call whose stderr is kubectl's own,
 * never one that streams what an entry wrote (controlPlaneFaultOfWords' terms).
 */
export function execUnstartedOf(r: KubectlResult): ControlPlaneFault | null {
  if (r.code === 0 && r.error === undefined) return null;
  return controlPlaneFaultOfWords(saidOf(r));
}

/**
 * A driver failure whose cause is the control plane (`fault`, one of capacity.ts CONTROL_PLANE_FAULTS: execUnstartedOf,
 * controlPlaneFaultOfWords): the API server itself shedding (a 429), unreachable or shutting down under a create or a
 * read, so the start never came; never the harness's code or the entry, and never an exec's (no exec crosses the API
 * server). Thrown by grader/run.ts driverFailure for a process whose own last call of the control plane met one
 * (controlPlaneOf, ControlPlaneSeen), and by a plan pod whose boot did. A trial job that ends on
 * one is held `sandbox` (grader/worker.ts heldOnFault, trialFaultHoldReason's sandboxFaultOf), one of
 * PLATFORM_FAULT_HOLD_REASONS, so its run's fan-in re-queues it by itself once, then it waits for an admin; so is one
 * that ends on any other SandboxError on its cause chain (a wait that ran and missed included), but a LeftoverError or
 * one of code `repo_image_unsupported`, held `harness_fault` for an admin. It keeps the name SandboxError, so a stored
 * job output read by name (server/pipeline/stuck-running.ts PLATFORM_DEATH_NAMES) reads it as one; server/jobs.ts, which
 * never loads this module, tells it by its `controlPlane` mark and `fault` (controlPlaneFaultOf) and hands its grade
 * back instead of spending a retry (the `control plane` hand-back).
 */
export class ExecUnstartedError extends SandboxError {
  /** What failed of the control plane. */
  readonly fault: ControlPlaneFault;
  /** Its mark for a reader that does not load this module (server/jobs.ts controlPlaneFaultOf). */
  readonly controlPlane = true;
  constructor(message: string, fault: ControlPlaneFault) {
    super(message);
    this.fault = fault;
  }
}

// The control plane, as a process's own calls last found it (controlPlaneOf). Each K8sProcess, K8sPodProcess and K8sPod
// boot runs in its own ControlPlaneSeen (CONTROL_PLANE_SEEN, an AsyncLocalStorage, so a case session's boot inside a
// run is that run's), set as each of its calls of the API server answers (`api`): a `get` or `wait` (the K8sSandbox's
// exec, seenExec: what the pod watch's kubectl fall back and every pod read run) and its pod's create (bootAgentPod,
// read with the Secret's values taken out). Every exec of a pod the driver makes, a case session's among them, goes
// over its pod's agent, which is no control plane. Each answer replaces the last, so a fault the control plane
// recovered from names nothing. Never read: an exec (its stream is the agent's, its stderr the entry's once it started),
// a delete or patch (warned of, never the process's end), or a failure's message (it quotes the pod's own words, a
// termination message the entry may write).

/** What a process's own calls last found of the API server: a fault, or null once it answered (or nothing asked). */
interface ControlPlaneSeen {
  api: ControlPlaneFault | null;
}

/** A fresh ControlPlaneSeen: nothing asked yet. */
function controlPlaneUnseen(): ControlPlaneSeen {
  return { api: null };
}

/** What `seen` names: its API server's fault, else null. */
function controlPlaneFaultIn(seen: ControlPlaneSeen): ControlPlaneFault | null {
  return seen.api;
}

const CONTROL_PLANE_SEEN = new AsyncLocalStorage<ControlPlaneSeen>();

/** The verbs every answer of is noted (seenExec): reads, whose stderr is kubectl's own words alone. */
const SEEN_VERBS: ReadonlySet<string> = new Set(['get', 'wait']);

/** Note `fault` (null: the control plane answered) as what the calling process last found on `path`, when one is running. */
function noteControlPlane(path: keyof ControlPlaneSeen, fault: ControlPlaneFault | null): void {
  const seen = CONTROL_PLANE_SEEN.getStore();
  if (seen !== undefined) seen[path] = fault;
}

/** `exec` (a KubectlExec), each `get` and `wait` answer noted for the process it runs for (noteControlPlane, execUnstartedOf). */
export function seenExec(exec: KubectlExec): KubectlExec {
  return async (args, opts) => {
    const r = await exec(args, opts);
    const verb = args[0] === '-n' ? args[2] : args[0];
    if (verb !== undefined && SEEN_VERBS.has(verb)) noteControlPlane('api', execUnstartedOf(r));
    return r;
  };
}

/**
 * The control plane's fault a process's own last call of it met (ControlPlaneSeen), for a k8s process
 * that ended as the driver's failure: what grader/run.ts driverFailure throws an ExecUnstartedError for. Null when its last
 * call was answered, and for any other driver's process.
 */
export function controlPlaneOf(proc: SandboxProcess): ControlPlaneFault | null {
  return proc instanceof K8sProcess || proc instanceof K8sPodProcess ? proc.controlPlane : null;
}

// ---------------------------------------------------------------- the CPU clock

/** What the clock reads of a timed process (K8sProcess): its pod, its end, whether its program started, its reading. */
export type TimedProcess = Pick<K8sProcess, 'pod' | 'exited' | 'programStarted' | 'cpuUs'>;

/**
 * A timed sandbox's clock (the header's Timing): the sum of its pods' launcher readings, in µs, each added once its
 * process has exited. A pod whose program started and that exited with no reading faults it: read() and settled()
 * throw SandboxError from then on. One whose program never started adds 0.
 */
export class K8sCpuClock implements CpuClock {
  readonly source: string;
  readonly #settleMs: number;
  readonly #pending = new Set<Promise<void>>();
  #usage = 0n;
  #fault: string | null = null;
  #closed = false;

  /** `settleMs`: how long settled() waits for the processes in flight (default docker.ts CPU_CLOCK_READ_MS). */
  constructor(source: string, opts: { settleMs?: number } = {}) {
    this.source = source;
    this.#settleMs = opts.settleMs ?? CPU_CLOCK_READ_MS;
  }

  /** Count `proc`, a process of the timed sandbox's, once it has exited. */
  track(proc: TimedProcess): void {
    const counted = proc.exited.then(
      (exit) => {
        const us = proc.cpuUs;
        if (us !== null) this.#usage += us;
        else if (proc.programStarted) this.#fault ??= `pod ${proc.pod} ran its program and its CPU launcher reported no CPU time (${exit.error ?? (exit.signal === null ? `exit ${exit.code}` : `signal ${exit.signal}`)})`;
      },
      (err: unknown) => {
        this.#fault ??= `pod ${proc.pod}'s end could not be read: ${err instanceof Error ? err.message : String(err)}`;
      },
    );
    this.#pending.add(counted);
  }

  /** The readings of every timed process that has exited, summed (0 before any). SandboxError once closed or faulted. */
  async read(): Promise<bigint> {
    if (this.#closed) throw new SandboxError(`the CPU clock ${this.source} is closed`);
    if (this.#fault !== null) throw new SandboxError(`CPU time is unreadable: ${this.#fault}`);
    return this.#usage;
  }

  /** read() once every timed process in flight has exited and been counted (SandboxError past `settleMs`). */
  async settled(): Promise<bigint> {
    const deadline = Date.now() + this.#settleMs;
    while (this.#pending.size > 0) {
      const now = [...this.#pending];
      if (!(await settlesWithin(Promise.all(now), Math.max(0, deadline - Date.now())))) {
        throw new SandboxError(`CPU time is unreadable: ${this.#pending.size} timed ${this.#pending.size === 1 ? 'pod is' : 'pods are'} still running after ${this.#settleMs} ms (something else runs on the clock)`);
      }
      for (const p of now) this.#pending.delete(p);
    }
    return this.read();
  }

  /** Whether close() was called: its sandbox spawns nothing more. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Stop the clock (idempotent): there is nothing of it to remove. */
  async close(): Promise<void> {
    this.#closed = true;
  }
}

/**
 * A timed sandbox (K8sSandbox.openCpuClock): its base's in every way but spawn, whose every program is a timed pod
 * counted on the clock. Its removeTree is its base's (no pod); its meters are its base's too, which knows its pods
 * (meterTree: the timed pod's own `watch`).
 */
export class K8sTimedSandbox implements Sandbox {
  readonly kind = 'k8s' as const;
  readonly clock: K8sCpuClock;
  readonly #base: K8sSandbox;
  readonly #spawn: (spec: SandboxSpec) => K8sProcess;

  constructor(base: K8sSandbox, spawnTimed: (spec: SandboxSpec) => K8sProcess, clock: K8sCpuClock) {
    this.#base = base;
    this.#spawn = spawnTimed;
    this.clock = clock;
  }

  /** The base's data root (bundle-trees.ts k8sDataRoot reads it). */
  get dataRoot(): string {
    return this.#base.dataRoot;
  }

  get networks(): K8sTrialNetworks {
    return this.#base.networks;
  }

  imageDigest(runtime: Runtime): string {
    return this.#base.imageDigest(runtime);
  }

  preflight(runtime: Runtime, imageDigest: string | null = null): Promise<void> {
    return this.#base.preflight(runtime, imageDigest);
  }

  isDriverFailure(exit: SandboxExit): boolean {
    return this.#base.isDriverFailure(exit);
  }

  removeTree(dir: string): Promise<void> {
    return this.#base.removeTree(dir);
  }

  meterTree(dir: string, opts: TreeMeterOptions): TreeMeter {
    return this.#base.meterTree(dir, opts);
  }

  /** The program in a timed pod, counted on the clock once it exits. A SandboxError once the clock is closed. */
  spawn(spec: SandboxSpec): SandboxProcess {
    if (this.clock.closed) throw new SandboxError(`the CPU clock ${this.clock.source} is closed: its sandbox times nothing more`);
    const proc = this.#spawn(spec);
    this.clock.track(proc);
    return proc;
  }
}

/** A timed sandbox and its clock (K8sSandbox.openCpuClock): docker.ts TimedDockerSandbox's twin. */
export interface TimedK8sSandbox {
  clock: K8sCpuClock;
  sandbox: K8sTimedSandbox;
}

// ---------------------------------------------------------------- one pod's members

/**
 * A plan pod's boot (K8sPod): its IP once Ready, or why it never was, with the scheduler's words when the node had no
 * room, and what the boot's own last call of the control plane met (`controlPlane`: ControlPlaneSeen) once it failed.
 */
type PodBoot = { ok: true; ip: string } | { ok: false; error: string; noRoom: string | null; controlPlane?: ControlPlaneFault | null };

/**
 * What one read of a plan pod says to a member whose exec ended without its sentinel (K8sPod #read): its sandbox over
 * (out of memory, or evicted for one of its own writable volumes), gone, unread, or what it says: whether that member's
 * container has ended (or the pod finished), and whether the pod is still Running.
 */
type SandboxRead = { state: 'oom' } | { state: 'gone' } | { state: 'unread'; said: string } | { state: 'read'; said: string; ended: boolean; running: boolean };

/** What a plan pod hands each process it runs (K8sPod): its kubectl, its name, its boot, its OOM reading, its register. */
interface PodSide {
  readonly ctx: K8sContext;
  readonly name: string;
  /** Whether the pod has `watch` (a member with a writable mount). */
  readonly watched: boolean;
  /** The pod's boot, or null once `signal` aborted before it settled. */
  booted(signal: AbortSignal): Promise<PodBoot | null>;
  /** Whether the pod has been found out of memory (or evicted for one of its own writable volumes). */
  oom(): boolean;
  /** Read the pod once, for `container`: its sandbox over (marking the pod so, every live member cut), gone, or what it says. */
  read(container: string): Promise<SandboxRead>;
  /** Why the pod ended something run in it unexplained (a member's collect that failed): K8sPod #verdict. */
  verdict(): Promise<PodVerdict>;
  /** Whether the pod's `watch` still runs: its agent answers /v1/health within WATCH_PROBE_TIMEOUT_MS (watchAnswers). */
  watchAlive(): Promise<boolean>;
  /** The pod's `watch` agent session, once booted (null before, or in a pod without `watch`): its members' watches and collects. */
  agent(): PodAgentSession | null;
  /** Register a process: `cut` ends it as the sandbox's running out of memory does. */
  track(proc: K8sPodProcess, cut: () => void): void;
}

/** What one process of a plan pod runs: its container, the program's argv and cap, what comes before it and after it. */
interface MemberLaunch {
  /** The member's container (its name). */
  container: string;
  argv: readonly string[];
  /** The wrapper's process cap; 0 for none. */
  pids: number;
  /** A timed `main` (the header's Timing): `argv` is the CPU launcher's, under TIMED_EXEC_WRAPPER. */
  timed: boolean;
  /**
   * The door dial before the program (SandboxPodPlan.doors): its interpreter's POLICY_WAIT_ARGV, the door's address and
   * this member's port, and the trial a miss is counted under (the plan's owner, else null: DoorMissReport.trial).
   */
  dial: { argv: readonly string[]; address: string; port: number; trial: string | null } | null;
  /** The bind proofs before the program: each local name another member serves. */
  proofs: readonly PodLocalName[];
  /** Its meters and its writable mounts' live files (ProgramWatch, read in `watch` at its own paths), or null: it writes nothing. */
  watch: ProgramWatch | null;
  /** Where its watch's live-file fault goes once the process exists (K8sPod makes the watch before the process). */
  watchFault: { handle: ((message: string) => void) | null };
  /** Its writable mounts as `watch` holds them (`/m/<member><mount point>`) and their host directories: collected once its exec has ended. */
  collect: readonly CollectMount[];
}

/** A promise that resolves with null once `signal` aborts (at once when it has). */
function aborted(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener('abort', () => resolve(null), { once: true });
  });
}

/**
 * One program of a plan pod (the header's One pod) in its own container: returned before anything reached the cluster,
 * as a K8sProcess is. It waits for its pod's Ready, dials its door, proves its binds, then runs under the exec wrapper,
 * its meters and live files in a watch exec into `watch` beside it (ProgramWatch); its signals reach its own container
 * alone. At its program's end or its kill (once its exec had started), its watch stopped and its writable mounts
 * collected from `watch` into their host directories, then `exited`; its end deletes nothing (K8sPod.close does).
 */
export class K8sPodProcess implements TerminableProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exited: Promise<SandboxExit>;
  /** The wrapper's start line came: the program runs now, after its pod's Ready, its door dial and its bind proofs. */
  readonly started: Promise<void>;
  /**
   * The program itself ended (types.ts SandboxProcess.finished): at the wrapper's sentinel, or once the program's exec
   * ended without one, or the process ended without an exec; before its watch is stopped and its mounts collected. Never
   * rejects; settles no later than `exited`.
   */
  readonly finished: Promise<void>;
  /** The pod's name. */
  readonly pod: string;
  /** Its container's: the member's name. */
  readonly container: string;
  readonly #markStarted: () => void;
  readonly #markFinished: () => void;
  readonly #side: PodSide;
  readonly #launch: MemberLaunch;
  readonly #abort = new AbortController();
  #killed = false;
  /** The sandbox ran out of memory while this ran: it ends K8S_KILLED. */
  #oomCut = false;
  #done = false;
  #child: KubectlChild | null = null;
  #killing: Promise<void> | null = null;
  #began = false;
  #ended = false;
  #reported = false;
  #cpu: bigint | null = null;
  #noRoom: string | null = null;
  /** What its own calls last found of the control plane, its pod's boot's for a boot that failed (controlPlane). */
  readonly #seen: ControlPlaneSeen = controlPlaneUnseen();
  /** Why a watch that mirrors its live files ended unstopped with no meter to hand it to (ProgramWatch): its failure. */
  #watchFailure: string | null = null;

  constructor(side: PodSide, launch: MemberLaunch) {
    this.#side = side;
    this.#launch = launch;
    this.pod = side.name;
    this.container = launch.container;
    let mark: () => void = () => undefined;
    this.started = new Promise<void>((resolve) => {
      mark = resolve;
    });
    this.#markStarted = mark;
    let end: () => void = () => undefined;
    this.finished = new Promise<void>((resolve) => {
      end = resolve;
    });
    this.#markFinished = end;
    // A watch of its live files that ended unstopped with no meter to hand it to: the driver's failure, its exec cut.
    launch.watchFault.handle = (message) => {
      this.#watchFailure ??= message;
      this.#child?.kill();
    };
    side.track(this, () => this.#cutByOom());
    this.exited = CONTROL_PLANE_SEEN.run(this.#seen, () => this.#run());
  }

  /** As K8sProcess.controlPlane: the control plane's fault its own last call of it met, or its pod's failed boot's. */
  get controlPlane(): ControlPlaneFault | null {
    return controlPlaneFaultIn(this.#seen);
  }

  /** Whether the wrapper's start line came: the program ran, or was handed to the shell to run. */
  get programStarted(): boolean {
    return this.#began;
  }

  /** A timed `main`'s CPU launcher reading in µs (the header's Timing), once it exited with one; null otherwise. */
  get cpuUs(): bigint | null {
    return this.#cpu;
  }

  /** Once it exited as the driver's failure because the node had no room for its pod, the scheduler's or the API's words; null otherwise. */
  get noRoom(): string | null {
    return this.#noRoom;
  }

  kill(): Promise<void> {
    this.#killing ??= (async () => {
      this.#killed = true;
      this.#abort.abort();
      const child = this.#child;
      if (this.#launch.timed && child !== null && this.#began && !this.#ended && !this.#done) await this.#killTimed(child);
      else child?.kill();
      await this.exited;
    })();
    return this.#killing;
  }

  /** SIGTERM to the program and everything it started in its container (`kill -TERM -1` there): a no-op before it runs or once it has exited. */
  async terminate(): Promise<void> {
    if (this.#child === null || this.#done) return;
    await this.#signal('TERM');
  }

  /** The sandbox ran out of memory (K8sPod): the program is gone with it; its exec is cut and it ends K8S_KILLED. */
  #cutByOom(): void {
    if (this.#done) return;
    this.#oomCut = true;
    this.#abort.abort();
    this.#child?.kill();
  }

  /** As K8sProcess's timed kill, in this container: TIMED_KILL_ARGV, the launcher left to report, the exec cut at TIMED_KILL_MS. */
  async #killTimed(child: KubectlChild): Promise<void> {
    const stop = new AbortController();
    const soft = this.#member().run(TIMED_KILL_ARGV, { signal: stop.signal, timeoutMs: SIGNAL_TIMEOUT_MS });
    if (!(await settlesWithin(child.closed, this.#side.ctx.timedKillMs ?? TIMED_KILL_MS))) child.kill();
    stop.abort();
    await soft;
  }

  /**
   * `sig` to everything in this container but its PID 1: null once the signal ran there, else what failed (the exec's
   * own end: the container or its shim gone, the agent's session dead, SIGNAL_TIMEOUT_MS), when the program may still run.
   */
  async #signal(sig: 'TERM' | 'KILL'): Promise<string | null> {
    // kill(-1) in this container's own PID namespace: its PID 1 (the shim) and the caller spared, no other container's reached.
    const r = await this.#member().run(['/bin/sh', '-c', `kill -s ${sig} -- -1`], { timeoutMs: SIGNAL_TIMEOUT_MS });
    return r.code === 0 && r.error === undefined ? null : why(r);
  }

  /** How its execs reach its container (MemberExec): over its pod's `watch` agent session, relayed to the container's shim. */
  #member(): MemberExec {
    return agentMember(this.#side.agent(), this.pod, this.container);
  }

  /** Whether it is to end K8S_KILLED now: killed, or the sandbox ran out of memory. */
  #cut(): boolean {
    return this.#killed || this.#oomCut || this.#side.oom();
  }

  async #run(): Promise<SandboxExit> {
    let exit: SandboxExit;
    try {
      exit = await this.#start();
    } catch (err) {
      exit = failure(`pod ${this.pod} container ${this.container}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The program is over, whatever ended it (at its sentinel `finished` came already).
    this.#markFinished();
    // Nothing is metered past here: its watch stopped and its stop() awaited, so nothing of a live mirror is still being
    // written when the collect empties the host directories.
    await this.#launch.watch?.stop();
    this.#done = true;
    this.stdin.unpipe();
    this.stdin.resume();
    if (!this.stdout.writableEnded) this.stdout.end();
    if (!this.stderr.writableEnded) this.stderr.end();
    // A program cut off (killed, or its exec lost) may still run in its container: everything there dies first.
    const unkilled = !this.#reported && this.#child !== null && !this.#side.oom() ? await this.#signal('KILL') : null;
    // Its writable mounts from `watch` when its exec ran (the sentinel came, or kill() cut a program whose exec had
    // started) and the pod still holds them (not out of memory); a collect that fails in a pod out of memory or evicted
    // for one of its own volumes is the program's kill (collectProgram), any other the driver's failure, unless the run
    // was a driver's failure already.
    const collect = this.#launch.collect;
    const collecting = collect.length > 0 && !this.#oomCut && !this.#side.oom() && (this.#reported || (this.#killed && this.#child !== null));
    if (collecting) {
      const collected = await collectProgram(this.#side.ctx, this.pod, collect, unkilled, () => this.#side.verdict(), this.#side.agent());
      if (collected.exit !== null && !(exit.code === K8S_DRIVER_FAILURE && exit.error !== undefined)) exit = collected.exit;
    }
    await Promise.all([delivered(this.stdout), delivered(this.stderr)]);
    return exit;
  }

  async #start(): Promise<SandboxExit> {
    const boot = await this.#side.booted(this.#abort.signal);
    if (this.#cut() || boot === null) return killedExit();
    if (!boot.ok) {
      this.#noRoom = boot.noRoom;
      this.#seen.api = boot.controlPlane ?? null;
      return failure(boot.error);
    }
    const dial = this.#launch.dial;
    if (dial !== null) {
      const missed = await this.#dial(dial);
      if (this.#cut()) return killedExit();
      if (missed !== null) {
        // A dial that ran and took no connection counts against the lanes pod behind that door (k8s-lanes.ts's A dead
        // door), off this path; one that did not run says nothing of the door.
        if (missed.ran) {
          try {
            void (this.#side.ctx.doorMissed ?? reportLanesDoorMiss)({ address: dial.address, port: dial.port, said: missed.said, pod: this.pod, trial: dial.trial });
          } catch {
            // Dropped: the member's failure below stands as it is.
          }
        }
        return await this.#fault(`pod ${this.pod} container ${this.container} could not reach its door at ${dial.address}:${dial.port} within ${FIRST_CONNECT_WAIT_MS} ms of Ready, so the policy to the door is not enforced for it (${missed.said})`);
      }
    }
    for (const local of this.#launch.proofs) {
      const bound = await this.#prove(local);
      if (this.#cut()) return killedExit();
      if (bound !== null) return await this.#fault(bound);
    }
    return await this.#exec();
  }

  /** A step before the program failed: K8S_KILLED when the sandbox ran out of memory (the pod read once), else the driver's failure. */
  async #fault(message: string): Promise<SandboxExit> {
    if (this.#side.oom()) return killedExit();
    const read = await this.#side.read(this.container);
    return read.state === 'oom' ? killedExit() : failure(message);
  }

  /**
   * The door dial: from inside the container, the door's port takes a connection within FIRST_CONNECT_WAIT_MS. Null once it
   * did, else what failed and whether the dial ran (its own verdict on the door) or not (its exec failed). One exec over
   * the pod's `watch` agent (#member): nothing of the control plane.
   */
  async #dial(dial: NonNullable<MemberLaunch['dial']>): Promise<{ said: string; ran: boolean } | null> {
    const r = await this.#member().run([...dial.argv, String(FIRST_CONNECT_WAIT_MS), dial.address, String(dial.port)], { signal: this.#abort.signal, timeoutMs: FIRST_CONNECT_WAIT_MS + KUBECTL_TIMEOUT_MS });
    if (r.code === 0 && r.error === undefined) return null;
    const said = r.stdout.trim().split('\n').at(-1) ?? '';
    if (r.code === 1 && r.error === undefined && said.startsWith(`${dial.address}:${dial.port} `)) return { said, ran: true };
    return { said: `the dial did not run: ${why(r)}`, ran: false };
  }

  /**
   * The bind proof of `local` (the header's One pod): from inside the container, a bind of LOOPBACK at its port with
   * each of BIND_PROOF_OPTIONS set is refused with EADDRINUSE. Null when every one was, else the driver's words for why
   * the pod is not run (naming the option that bound).
   */
  async #prove(local: PodLocalName): Promise<string | null> {
    const r = await this.#member().run([...BIND_PROOF_ARGV, LOOPBACK, String(local.port)], { signal: this.#abort.signal, timeoutMs: KUBECTL_TIMEOUT_MS });
    const said = r.stdout.trim().split('\n').at(-1) ?? '';
    if (r.code === 0 && r.error === undefined && said === BIND_PROOF_REFUSED) return null;
    const option = said.startsWith(`${BIND_PROOF_BOUND} `) ? said.slice(BIND_PROOF_BOUND.length + 1) : '';
    if (r.code === 1 && r.error === undefined && BIND_PROOF_OPTIONS.includes(option)) {
      return `pod ${this.pod} container ${this.container} could bind ${LOOPBACK}:${local.port} with ${option} set, the port of \`${local.name}\`, which member ${local.member} serves, so it could stand in for ${local.member} (deploy/k8s/README.md probes c2, P5): the pod runs no program of it (does ${local.member} listen on ${LOOPBACK} itself, with no SO_REUSEPORT, and was it listening yet?)`;
    }
    return `pod ${this.pod} container ${this.container}: the bind proof of ${LOOPBACK}:${local.port} (\`${local.name}\`) did not run: ${said === '' ? why(r) : `${said} (${why(r)})`}`;
  }

  async #exec(): Promise<SandboxExit> {
    const timed = this.#launch.timed;
    const wrapper = timed ? TIMED_EXEC_WRAPPER : EXEC_WRAPPER;
    // Its meters registered so far and its live files, in one watch exec into `watch` beside its program's; a meter
    // registered from now on gets one of its own (ProgramWatch).
    this.#launch.watch?.start();
    // One exec over the pod's `watch` agent into its container (#member), sent once, holding no slot of the pace.
    const { child, scanner, end, unstarted, claimed, startMs, flushed } = await runProgramExec({
      member: this.#member(),
      ctx: this.#side.ctx,
      command: ['/bin/sh', '-c', wrapper, 'sh', String(this.#launch.pids), ...this.#launch.argv],
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      killed: () => this.#cut(),
      onChild: (c) => {
        this.#child = c;
      },
      onStart: () => {
        this.#began = true;
        this.#markStarted();
      },
      onSentinel: () => {
        this.#ended = true;
        // The program's own end (D6): its wall time stops here, before its watch is stopped and its mounts collected.
        this.#markFinished();
      },
    });
    this.#markFinished();
    // The program's exec is over: its watch is the driver's to stop (nothing in its container reaches `watch`).
    await this.#launch.watch?.stop();
    await flushed;
    this.stdin.unpipe(child.stdin);
    if (scanner.rc !== null) {
      this.#reported = true;
      if (timed) {
        this.#cpu = scanner.cpuUs;
        if (this.#cpu === null) return failure(`pod ${this.pod} container ${this.container}: the CPU launcher reported no CPU time (the wrapper's status ${scanner.rc}; its own words, if any, end the program's stderr)`);
      }
      return { code: scanner.rc, signal: null };
    }
    if (this.#cut()) return killedExit();
    if (this.#watchFailure !== null) return failure(this.#watchFailure);
    if (claimed) return failure(claimedWords(`pod ${this.pod} container ${this.container}`));
    if (unstarted) return failure(`pod ${this.pod} container ${this.container}: the exec did not start the program within ${startMs} ms`);
    return await this.#unexplained(end);
  }

  /**
   * The exec ended without the sentinel: the pod says why (the header's One pod). Any container OOMKilled (probe e2: the
   * exec ends 128 with a urpc error while every container ends `OOMKilled`, 137), or the pod evicted for one of its own
   * writable volumes' sizeLimit (evictedFor: the plan's D14, read as an OOM), is the sandbox's end, K8S_KILLED for every
   * live member; else the driver's failure with what the pod says once this container ended.
   * The wait is for the status, not for time: the exec's end comes before the kubelet's report of it, and a report later
   * than a fixed settle read as a void what was the entry's memory. The pod is re-read every POD_SETTLE_POLL_MS until
   * this container is no longer running (terminated, its pod's phase over) or the pod is gone; a status still unwritten
   * after KUBECTL_TIMEOUT_MS is the driver's failure. That bound is the budget the driver gives any one answer from the
   * cluster, and the status is such an answer (the kubelet's report through the API server); the rig's rows (deploy/k8s/
   * README.md e2, m2-m5) record the OOMKilled statuses and the exec's 128, not how long after the exec's end the status
   * came. A container whose program's exec was lost while the container ran on (its PID 1 never ends by itself) waits
   * the bound whole. A container ended in a pod still Running with `watch` has `watch` probed once (an eviction ends
   * every container before its mark reaches the pod, which can come tens of seconds later): dead too, the pod is read on
   * up to EVICTION_SETTLE_MS from the exec's end for its eviction; alive, this container ended alone, the driver's
   * failure. The eviction is a backstop, never the bound (the header's No sentinel: more than 2 minutes can pass).
   */
  async #unexplained(end: KubectlEnd): Promise<SandboxExit> {
    const exec = execEndWords(end);
    const lost = `pod ${this.pod} container ${this.container}: the program ended without its exit status (${exec})`;
    const start = Date.now();
    let deadline = start + KUBECTL_TIMEOUT_MS;
    let probed = false;
    let evicting = false;
    for (;;) {
      if (this.#cut()) return killedExit();
      const read = await this.#side.read(this.container);
      if (read.state === 'oom') return killedExit();
      if (read.state === 'gone') return failure(`${lost}; the pod is gone`);
      if (read.state === 'read' && read.ended) {
        if (!probed && read.running && this.#side.watched) {
          probed = true;
          evicting = !(await this.#side.watchAlive());
          if (evicting) deadline = Math.max(deadline, start + (this.#side.ctx.evictionSettleMs ?? EVICTION_SETTLE_MS));
        }
        if (!evicting || !read.running) return failure(`${lost}; the pod: ${read.said}`);
      }
      if (Date.now() >= deadline) return failure(read.state === 'read' ? `${lost}; the pod: ${read.said}` : `${lost}; the pod ${read.said}`);
      await sleep(POD_SETTLE_POLL_MS);
    }
  }
}

/** What a plan pod is made with besides its plan: its sandbox's kubectl, placement, images and RuntimeClass. */
export interface K8sPodHost {
  ctx: K8sContext;
  placement: PodPlacement;
  images: ImageTableT;
  runtimeClass: string | null;
  /**
   * The agents' spec (K8sSandbox's: the pinned agent image and the agents' peer): `check()` what a pod is built with only
   * to be checked as it is constructed (the peer SPEC_CHECK_PEER while it is not known), `read()` what it is created with
   * (the peer read now). Absent: `placement.agent` for both.
   */
  agent?: { check(): PodAgentSpec; read(): Promise<PodAgentSpec> };
  /**
   * The drawn placement of an untimed plan pod named `pod`, asked as it is made (K8sSandbox's, with an appNodeShare or an
   * appNodeSandboxPods: drawnNodePreference over its room read, or with `trialAgent` (isTrialAgentPlan)
   * trialAgentPreference, and the pod then carries TRIAL_AGENT_LABEL); absent, or a timed pod: none, and nothing is read.
   */
  prefer?: (pod: string, trialAgent: boolean) => Promise<NodePreference | null>;
}

/** K8sPod's own: whether its `main` is timed, and who hears of each member's process as it is spawned (the clock). */
export interface K8sPodOptions {
  timed?: boolean;
  onSpawn?: (member: PodMember, proc: K8sPodProcess) => void;
}

/** One member of a K8sPod: its spec and cap, its watch and collect (none without a writable mount), its mounts. */
interface PodMemberState {
  spec: PodMemberSpec;
  pids: number;
  mounts: readonly SandboxMount[];
  watch: ProgramWatch | null;
  watchFault: MemberLaunch['watchFault'];
  collect: readonly CollectMount[];
}

/**
 * A SandboxPodPlan's pod (the header's One pod), made as it is constructed: ONE create List of its Secret (podPlanSecret)
 * and the pod (podPlanSpec), the Secret's owner patched on after; `scheduled` and its IP from the pod's watch, `stage`'s
 * agent, ONE staging exec of every member's trees, `stage` released, one Ready wait, `watch`'s agent (bootAgentPod). A
 * malformed plan throws SandboxError before anything is sent. Its members start by spawn(), its meter by meter() (a
 * watch exec by the `watch` agent, on the plan's meter member); close() ends them (each collecting its writable mounts),
 * deletes the pod and closes its `watch` agent's session.
 */
export class K8sPod implements SandboxPod {
  readonly name: string;
  readonly scheduled: Promise<void>;
  readonly address: Promise<string>;
  readonly #ctx: K8sContext;
  readonly #plan: SandboxPodPlan;
  readonly #members: Map<PodMember, PodMemberState>;
  readonly #timed: boolean;
  readonly #runtimeClass: string | null;
  /** What its pod is built with (podPlanSpec), and the drawn placement asked for as the pod is made (K8sPodHost.prefer; null when timed or none). */
  readonly #specOptions: PodPlanOptions;
  readonly #prefer: ((pod: string, trialAgent: boolean) => Promise<NodePreference | null>) | null;
  /** The agents' spec the pod is created with (K8sPodHost.agent's read, else its placement's). */
  readonly #agent: () => Promise<PodAgentSpec | undefined>;
  /** Its `watch` agent's session once booted (bootAgentPod), kept until close(): its members' watches and collects. */
  #watchAgent: PodAgentSession | null = null;
  readonly #secret: K8sObject;
  readonly #refs: readonly string[];
  /** What `stage` is sent: every member's trees, each at its member's own path (memberMountPath). */
  readonly #trees: readonly StageTree[];
  /** Every member's writable volumes (memberVolumeName): an eviction for one of them is the sandbox's end, as an OOM. */
  readonly #writable: readonly string[];
  readonly #onSpawn: K8sPodOptions['onSpawn'];
  readonly #abort = new AbortController();
  readonly #side: PodSide;
  readonly #procs = new Map<K8sPodProcess, () => void>();
  readonly #spawned = new Set<PodMember>();
  readonly #boot: Promise<PodBoot>;
  #markScheduled: () => void = () => undefined;
  #failScheduled: (err: SandboxError) => void = () => undefined;
  #markAddress: (ip: string) => void = () => undefined;
  #failAddress: (err: SandboxError) => void = () => undefined;
  #created = false;
  #closing: Promise<void> | null = null;
  #deleting: Promise<void> | null = null;
  #oom = false;

  constructor(host: K8sPodHost, plan: SandboxPodPlan, opts: K8sPodOptions = {}) {
    const timed = opts.timed === true;
    this.#ctx = host.ctx;
    this.#plan = plan;
    this.#timed = timed;
    this.#runtimeClass = host.runtimeClass;
    this.#onSpawn = opts.onSpawn;
    checkSandboxPodPlan(plan);
    this.name = podName(plan.label);
    this.#specOptions = { ...host.placement, name: this.name, images: host.images, ...(timed ? { timed } : {}) };
    const checkAgent = host.agent === undefined ? host.placement.agent : host.agent.check();
    // Built now so a malformed plan throws here, before anything is sent; built again as the pod is made.
    podPlanSpec(plan, { ...this.#specOptions, ...(checkAgent === undefined ? {} : { agent: checkAgent }) });
    const hostAgent = host.agent;
    this.#agent = hostAgent === undefined ? async () => host.placement.agent : () => hostAgent.read();
    this.#prefer = timed ? null : (host.prefer ?? null);
    const members = checkPlan(plan, this.name, timed);
    this.#members = new Map();
    const trees: StageTree[] = [];
    const writable: string[] = [];
    for (const m of members) {
      // A launcher member with no launcher, config or CA would die before `ready`, a void with no reason.
      const missing = houseFilesMissing(m.spec as SandboxSpec);
      if (missing.length > 0) throw new SandboxError(`the house ${m.spec.launcher!.houseDir} lacks ${missing.join(', ')} (launch.ts houseFor, writeHouse)`);
      const pids = Number(positiveInt(m.spec.limits.pids, `pod member ${m.member}'s pids`));
      // `watch` is WATCH_UID, counted apart from root (probe d2): a timed `main`'s root tasks are TIMED_ROOT_TASKS alone.
      if (timed && m.member === 'main' && host.runtimeClass !== null && pids + POD_OWN_TASKS < TIMED_ROOT_TASKS) {
        throw new SandboxError(`a timed pod's root tasks number ${TIMED_ROOT_TASKS} under its process cap, so its pids must be at least ${TIMED_ROOT_TASKS - POD_OWN_TASKS}, not ${pids}`);
      }
      for (const t of memberTrees(m)) trees.push({ mount: memberMountPath(m.member, t.at), dir: t.host });
      const own = m.mounts.filter((x) => !x.readOnly);
      for (const x of own) writable.push(memberVolumeName(m.member, x.at));
      const watchFault: MemberLaunch['watchFault'] = { handle: null };
      const watch =
        own.length === 0
          ? null
          : new ProgramWatch(this.#ctx, this.name, m.mounts, { dirOf: (x) => memberMountPath(m.member, x.at), onFilesFault: (message) => watchFault.handle?.(message), agent: () => this.#watchAgent });
      const collect = own.map((x) => ({ mount: memberMountPath(m.member, x.at), dir: x.host, returns: x.returns! }));
      this.#members.set(m.member, { spec: m.spec, pids, mounts: m.mounts, watch, watchFault, collect });
    }
    this.#trees = Object.freeze(trees);
    this.#writable = Object.freeze(writable);
    this.#secret = podPlanSecret(plan, { name: this.name, namespace: this.#ctx.namespace });
    this.#refs = Object.freeze([`pod/${this.name}`, `secret/${this.#secret.metadata.name}`]);
    this.scheduled = new Promise<void>((resolve, reject) => {
      this.#markScheduled = resolve;
      this.#failScheduled = reject;
    });
    this.address = new Promise<string>((resolve, reject) => {
      this.#markAddress = resolve;
      this.#failAddress = reject;
    });
    // A rejection nobody awaits (a pod closed before its harness asked) is handled, never an unhandled one.
    this.scheduled.catch(() => undefined);
    this.address.catch(() => undefined);
    this.#side = {
      ctx: this.#ctx,
      name: this.name,
      watched: writable.length > 0,
      booted: (signal) => Promise.race([this.#boot, aborted(signal)]),
      oom: () => this.#oom,
      read: (container) => this.#read(container),
      verdict: () => this.#verdict(),
      watchAlive: () => this.#watchAlive(),
      agent: () => this.#watchAgent,
      track: (proc, cut) => {
        this.#procs.set(proc, cut);
      },
    };
    const seen = controlPlaneUnseen();
    this.#boot = CONTROL_PLANE_SEEN.run(seen, () => this.#start(seen));
  }

  /**
   * Whether the sandbox is over by its pod's memory (read when an exec ended without its sentinel, or a collect failed):
   * any container OOMKilled, or the pod evicted for one of its own writable volumes' sizeLimit (the plan's D14: as an
   * OOM). Every member then ended K8S_KILLED, nothing collected.
   */
  get oom(): boolean {
    return this.#oom;
  }

  /**
   * `member`'s program in its container (the header's One pod), started once the pod is Ready, after its door dial and
   * its bind proofs. Each member is spawned at most once; a SandboxError for a member not in the plan, one spawned
   * already, or a pod closed.
   */
  spawn(member: PodMember): K8sPodProcess {
    if (this.#closing !== null) throw new SandboxError(`pod ${this.name} is closed: it starts nothing more`);
    const m = this.#members.get(member);
    if (m === undefined) throw new SandboxError(`pod ${this.name} has no member ${JSON.stringify(member)}`);
    if (this.#spawned.has(member)) throw new SandboxError(`pod ${this.name}'s member ${member} was spawned already: a member runs one program`);
    this.#spawned.add(member);
    const spec = m.spec;
    const program = spec.launcher === undefined ? [...RUNTIME_COMMANDS[spec.runtime], `/bot/${scriptOf(spec)}`] : [...LAUNCHER_ARGV[spec.runtime]];
    const timed = this.#timed && member === 'main';
    const doors = this.#plan.doors;
    const port = doors?.ports[member];
    const proc = new K8sPodProcess(this.#side, {
      container: member,
      argv: timed ? cpuLauncherArgv(program) : program,
      pids: this.#runtimeClass === null ? 0 : m.pids + POD_OWN_TASKS,
      timed,
      dial: doors === undefined || port === undefined ? null : { argv: POLICY_WAIT_ARGV[spec.runtime], address: doors.address, port, trial: this.#plan.owner ?? null },
      proofs: (this.#plan.local ?? []).filter((l) => l.member !== member),
      watch: m.watch,
      watchFault: m.watchFault,
      collect: m.collect,
    });
    this.#onSpawn?.(member, proc);
    return proc;
  }

  /**
   * Meter the plan's `meter` mount until stop(): a meter registered on its member's watch (ProgramWatch.meter), read by
   * the watcher in `watch` at the member's own path, in the watch exec beside the member's program when asked before it
   * starts (one exec of its own once it runs). A SandboxError for a plan with none, a pod closed, or a member whose
   * program is over.
   */
  meter(opts: TreeMeterOptions): TreeMeter {
    const meter = this.#plan.meter;
    if (meter === undefined) throw new SandboxError(`pod ${this.name}'s plan has no meter`);
    if (this.#closing !== null) throw new SandboxError(`pod ${this.name} is closed: it starts nothing more`);
    const m = this.#members.get(meter.member)!;
    const mount = m.mounts.find((x) => x.at === meter.at)!;
    return m.watch!.meter(mount.host, opts);
  }

  /**
   * Kill whatever still runs (each collecting its writable mounts), delete the pod (and its Secret) and close its `watch`
   * agent's session, once; idempotent, resolving once the delete was sent.
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#abort.abort();
      await Promise.all([...this.#procs.keys()].map((p) => p.kill()));
      // A member never spawned: its watch (a meter registered on it, never started) is over all the same.
      await Promise.all([...this.#members.values()].map((m) => m.watch?.stop()));
      await this.#boot;
      await this.#delete();
      const agent = this.#watchAgent;
      this.#watchAgent = null;
      if (agent !== null) await agent.close();
    })();
    return this.#closing;
  }

  /** The one delete of what the create made (nothing when it was never sent). */
  #delete(): Promise<void> {
    if (!this.#created) return Promise.resolve();
    this.#deleting ??= deleteObjects(this.#ctx, this.#refs);
    return this.#deleting;
  }

  /** Its boot, once, in its own ControlPlaneSeen (`seen`), whose fault a failed one carries. */
  async #start(seen: ControlPlaneSeen): Promise<PodBoot> {
    let boot: PodBoot;
    try {
      boot = await this.#bootOnce();
    } catch (err) {
      boot = { ok: false, error: `pod ${this.name}: ${err instanceof Error ? err.message : String(err)}`, noRoom: null };
    }
    if (!boot.ok) boot = { ...boot, controlPlane: controlPlaneFaultIn(seen) };
    if (boot.ok) {
      this.#markScheduled();
      this.#markAddress(boot.ip);
    } else {
      const err =
        boot.noRoom !== null
          ? new NodeRoomError(boot.error, boot.noRoom)
          : boot.controlPlane !== null && boot.controlPlane !== undefined
            ? new ExecUnstartedError(boot.error, boot.controlPlane)
            : new SandboxError(boot.error);
      this.#failScheduled(err);
      this.#failAddress(err);
      // A pod that can run nothing holds no slot of the node's until its harness closes it.
      if (this.#closing === null) void this.#delete();
    }
    return boot;
  }

  async #bootOnce(): Promise<PodBoot> {
    const closed = (): PodBoot => ({ ok: false, error: `pod ${this.name} was closed before it was ready`, noRoom: null });
    this.#created = true;
    // The drawn placement (the header's Room on the node), read before the ready budget starts: a trial agent's pod
    // (isTrialAgentPlan) is labelled as one and kept off the app node (trialAgentPreference).
    const trialAgent = this.#prefer !== null && isTrialAgentPlan(this.#plan);
    const prefer = this.#prefer === null ? null : await this.#prefer(this.name, trialAgent);
    if (this.#abort.signal.aborted) return closed();
    // Built again with the agents' spec read now (their peer), and the placement drawn.
    const agent = await this.#agent();
    if (this.#abort.signal.aborted) return closed();
    const object = podPlanSpec(this.#plan, { ...this.#specOptions, ...(agent === undefined ? {} : { agent }), ...(prefer === null ? {} : { prefer }), ...(trialAgent ? { trialAgent } : {}) });
    // The Secret and the pod in one List, `scheduled` and its IP off its watch, `stage`'s agent, ONE staging exec of
    // every member's trees (each at its member's own path; its ack the verdict, then `stage` released), Ready, `watch`'s
    // agent: one budget, readyTimeoutMs, the staging's own on top, as a split pod's.
    const boot = await bootAgentPod(this.#ctx, {
      name: this.name,
      objects: [object],
      secret: this.#secret,
      trees: this.#trees,
      signal: this.#abort.signal,
      killed: () => this.#abort.signal.aborted,
      onScheduled: () => this.#markScheduled(),
      plan: true,
    });
    if (!boot.ok) return boot.killed ? closed() : { ok: false, error: boot.error, noRoom: boot.noRoom };
    this.#watchAgent = boot.watch;
    return { ok: true, ip: boot.ip };
  }

  /** Whether `pod` says its sandbox is over: any container OOMKilled (podOomKilled), or evicted for one of its own writable volumes (evictedFor). */
  #sandboxOver(pod: PodJson): boolean {
    return podOomKilled(pod) || evictedFor(pod, this.#writable) !== null;
  }

  async #read(container: string): Promise<SandboxRead> {
    const read = await readPod(this.#ctx, this.name);
    if ('gone' in read) return { state: 'gone' };
    if ('error' in read) return { state: 'unread', said: `could not be read: ${read.error}` };
    if (this.#sandboxOver(read.pod)) {
      this.#markOom();
      return { state: 'oom' };
    }
    const s = read.pod.status ?? {};
    const mine = s.containerStatuses?.find((c) => c.name === container);
    return { state: 'read', said: describePlanPod(read.pod), ended: s.phase === 'Failed' || s.phase === 'Succeeded' || mine?.state?.terminated !== undefined, running: s.phase === 'Running' };
  }

  /**
   * Why the pod ended a member's collect (collectProgram's verdict), K8sProcess #podVerdict's reading of a plan pod:
   * re-read for up to POD_SETTLE_MS while its status settles; its sandbox over (#sandboxOver: marked, every live member
   * cut) is the program's kill; a pod still Running at POD_SETTLE_MS has `watch` probed once, and dead too is re-read up
   * to EVICTION_SETTLE_MS from the start for its eviction. Else what it says: gone, unreadable by the deadline, finished,
   * or still unfinished at it.
   */
  async #verdict(): Promise<PodVerdict> {
    const start = Date.now();
    let deadline = start + POD_SETTLE_MS;
    let probed = false;
    for (;;) {
      const read = await readPod(this.#ctx, this.name);
      if ('gone' in read) return { killed: false, said: 'the pod is gone', gone: true };
      if ('pod' in read) {
        if (this.#sandboxOver(read.pod)) {
          this.#markOom();
          return { killed: true };
        }
        const phase = read.pod.status?.phase;
        const finished = phase === 'Failed' || phase === 'Succeeded';
        if (!finished && phase === 'Running' && Date.now() >= deadline && !probed && this.#writable.length > 0) {
          probed = true;
          if (!(await this.#watchAlive())) {
            deadline = start + (this.#ctx.evictionSettleMs ?? EVICTION_SETTLE_MS);
            continue;
          }
        }
        if (finished || Date.now() >= deadline) return { killed: false, said: `the pod: ${describePlanPod(read.pod)}` };
      } else if (Date.now() >= deadline) return { killed: false, said: `the pod could not be read: ${read.error}` };
      await sleep(POD_SETTLE_POLL_MS);
    }
  }

  /** Whether this pod's `watch` still runs: its agent answers /v1/health within WATCH_PROBE_TIMEOUT_MS (watchAnswers). */
  #watchAlive(): Promise<boolean> {
    return watchAnswers(this.#watchAgent);
  }

  /** The sandbox is over (out of memory, or evicted for its own volume): marked once, every live member cut (each ends K8S_KILLED). */
  #markOom(): void {
    if (this.#oom) return;
    this.#oom = true;
    for (const cut of this.#procs.values()) cut();
  }
}

/** What a one-pod view is a view of (K8sSandbox.onePod): its base, the base's context, and the one act only the base can do. */
interface OnePodBase extends K8sPodHost {
  base: K8sSandbox;
  /** The base's timed spawn (a timed pod under the CPU launcher, staged as every program pod of the base's). */
  spawnTimed(spec: SandboxSpec): K8sProcess;
  /** Where a timed plan pod goes: `placement` under the base's timed node selector (K8sSandbox.timedNodeSelector). */
  timedPlacement: PodPlacement;
}

/** What lists every plan pod (planPodLabels' repeating labels, the egress mark aside): K8sOnePodTrialNetworks.reap reads its owner annotation. */
export const PLAN_POD_SELECTOR = `${GRADER_LABEL_KEY}=${GRADER_LABEL_VALUE},${ROLE_LABEL}=sandbox,${SANDBOX_KIND_LABEL}=program`;

/**
 * The one-pod view's trial networks: its base's (K8sTrialNetworks) in every way but reap, which after the base's reap
 * by label also takes every plan pod of the owner's. A plan pod carries no label of its owner (planPodLabels), so it is
 * found by listing the plan pods (`get pods -l PLAN_POD_SELECTOR -o json`) and matching OWNER_ANNOTATION whole, then
 * deleted by name (KUBECTL_DELETE_FLAGS: graceful, as every sandbox-pod delete), listed again REAP_ROUNDS times while
 * any is left as the base's reap does; one already being deleted (beingDeleted) is not left. Its Secret `<pod>-env` is
 * named in the same delete (owned by the pod only once patchSecretOwner landed, and the Role may not list Secrets).
 * Never throws for what it could not list or delete: the result says.
 */
export class K8sOnePodTrialNetworks implements TrialNetworks {
  readonly #base: K8sTrialNetworks;
  readonly #ctx: K8sContext;

  constructor(base: K8sTrialNetworks, ctx: K8sContext) {
    this.#base = base;
    this.#ctx = ctx;
  }

  create(trial: string, opts: { owner: string | null }): Promise<string> {
    return this.#base.create(trial, opts);
  }

  remove(trial: string): Promise<void> {
    return this.#base.remove(trial);
  }

  ensureEgress(): Promise<void> {
    return this.#base.ensureEgress();
  }

  sweepStale(): Promise<SweepResult> {
    return this.#base.sweepStale();
  }

  isolation(): Promise<IsolationVerdict> {
    return this.#base.isolation();
  }

  async reap(owner: string): Promise<ReapResult> {
    const res = await this.#base.reap(owner);
    const failed = (r: KubectlResult): boolean => r.code !== 0 || r.error !== undefined;
    const list = `kubectl get pods -l ${PLAN_POD_SELECTOR}`;
    for (let round = 0; ; round++) {
      const ls = await kubectl(this.#ctx, ['get', 'pods', '-l', PLAN_POD_SELECTOR, '-o', 'json']);
      if (failed(ls)) {
        res.errors.push(`${list}: ${why(ls)}`);
        return res;
      }
      // read off the event loop (POD_LIST_KEEP); `(JSON.parse(stdout) as { items?: unknown }).items` as it was
      const read = await listDoc(ls, POD_LIST_KEEP);
      if ('failed' in read) {
        res.errors.push(`${list}: ${read.failed}`);
        return res;
      }
      const items = 'doc' in read && read.doc !== null && read.doc !== undefined ? (read.doc as { items?: unknown }).items : undefined;
      if (!Array.isArray(items)) {
        res.errors.push(`${list} printed no list: ${JSON.stringify(ls.stdout.slice(0, 200))}`);
        return res;
      }
      // A plan pod already being deleted (a deletionTimestamp: KUBECTL_DELETE_FLAGS' graceful delete keeps it listed
      // until the kubelet has ended it) is going, never left nor deleted again, as the base's reap does.
      const left = (items as Array<{ metadata?: { name?: unknown; annotations?: Record<string, unknown>; deletionTimestamp?: unknown } }>)
        .map((item) => (item?.metadata?.annotations?.[OWNER_ANNOTATION] === owner && !beingDeleted(item) ? item?.metadata?.name : undefined))
        .filter((name): name is string => typeof name === 'string' && name.startsWith(POD_PREFIX))
        .map((name) => `pod/${name}`);
      if (left.length === 0) return res;
      if (round === REAP_ROUNDS) {
        res.errors.push(`${left.join(' ')} still there (after ${REAP_ROUNDS} tries)`);
        return res;
      }
      // Each with its env Secret by name: one never given its owner (a creator dead before the patch) goes too.
      const refs = left.flatMap((pod) => [pod, `secret/${envSecretName(pod.slice(4))}`]);
      const del = await kubectl(this.#ctx, ['delete', ...refs, ...KUBECTL_DELETE_FLAGS, '-o', 'name']);
      for (const line of del.stdout.split('\n')) {
        const name = line.trim().startsWith('pod/') ? line.trim().slice(4) : '';
        if (name !== '' && !res.containers.includes(name)) res.containers.push(name);
      }
      if (failed(del)) res.errors.push(`kubectl delete ${refs.join(' ')}: ${why(del)}`);
    }
  }
}

/**
 * The one-pod view of a K8sSandbox (K8sSandbox.onePod; the header's One pod): the base in every way (preflight,
 * images, networks, meterTree, a plain spawn, the base's own staged pod, and its reaping), with `pods` (K8sPod), a
 * networks' reap that also takes the owner's plan pods (K8sOnePodTrialNetworks); its removeTree is the base's too (what
 * any member wrote came back as the grader's own). With a clock (its openCpuClock's), its `main` members and its plain spawns are timed
 * (the base's timed pod), each counted on the clock. Nothing of it makes a pod on the claim.
 */
export class K8sOnePodSandbox implements Sandbox {
  readonly kind = 'k8s' as const;
  /** The clock its timed runs are counted on (openCpuClock's view), or null for the untimed view. */
  readonly clock: K8sCpuClock | null;
  readonly pods: SandboxPods;
  /** Its base's trial networks, whose reap also takes the owner's plan pods (K8sOnePodTrialNetworks). */
  readonly networks: K8sOnePodTrialNetworks;
  readonly #host: OnePodBase;

  constructor(host: OnePodBase, clock: K8sCpuClock | null) {
    this.#host = host;
    this.clock = clock;
    this.networks = new K8sOnePodTrialNetworks(host.base.networks, host.ctx);
    this.pods = Object.freeze({ open: (plan: SandboxPodPlan): SandboxPod => this.open(plan) });
  }

  /** The base's data root (bundle-trees.ts k8sDataRoot reads it). */
  get dataRoot(): string {
    return this.#host.base.dataRoot;
  }

  imageDigest(runtime: Runtime): string {
    return this.#host.base.imageDigest(runtime);
  }

  preflight(runtime: Runtime, imageDigest: string | null = null): Promise<void> {
    return this.#host.base.preflight(runtime, imageDigest);
  }

  isDriverFailure(exit: SandboxExit): boolean {
    return this.#host.base.isDriverFailure(exit);
  }

  meterTree(dir: string, opts: TreeMeterOptions): TreeMeter {
    return this.#host.base.meterTree(dir, opts);
  }

  /** A program in a pod of its own (the base's spawn: its trees staged, its writable mounts collected); a timed one on a clock's view, counted on it. */
  spawn(spec: SandboxSpec): SandboxProcess {
    const clock = this.clock;
    if (clock === null) return this.#host.base.spawn(spec);
    if (clock.closed) throw new SandboxError(`the CPU clock ${clock.source} is closed: its sandbox times nothing more`);
    const proc = this.#host.spawnTimed(spec);
    clock.track(proc);
    return proc;
  }

  /** Delete `dir`: the base's removeTree (the header's Scratch), whichever member wrote it. */
  removeTree(dir: string): Promise<void> {
    return this.#host.base.removeTree(dir);
  }

  /** The plan's pod (K8sPod); on a clock's view its `main` timed and counted. */
  open(plan: SandboxPodPlan): K8sPod {
    const clock = this.clock;
    if (clock !== null && clock.closed) throw new SandboxError(`the CPU clock ${clock.source} is closed: its sandbox times nothing more`);
    const hasMain = typeof plan === 'object' && plan !== null && typeof plan.members === 'object' && plan.members !== null && plan.members.main !== undefined;
    const timed = clock !== null && hasMain;
    const podHost = timed ? { ...this.#host, placement: this.#host.timedPlacement } : this.#host;
    return new K8sPod(podHost, plan, timed ? { timed, onSpawn: (member, proc) => (member === 'main' ? clock.track(proc) : undefined) } : {});
  }

  /** A timed one-pod view and its CPU clock (the header's Timing): its `main` members and plain spawns timed, counted on it. */
  openCpuClock(runtime: Runtime): { clock: K8sCpuClock; sandbox: K8sOnePodSandbox } {
    if (this.clock !== null) throw new SandboxError(`a timed sandbox opens no second clock (its own is ${this.clock.source})`);
    imageFor(runtime, this.#host.images);
    const clock = new K8sCpuClock(`${K8S_CPU_CLOCK_SOURCE} ${this.#host.runtimeClass ?? 'default'} cpu-${randomBytes(6).toString('hex')}`);
    return { clock, sandbox: new K8sOnePodSandbox(this.#host, clock) };
  }
}

// ---------------------------------------------------------------- the sandbox

export interface K8sSandboxOptions {
  /** The namespace every pod goes in, with its Secret and policies (server/config.ts MAKEFUN_K8S_SANDBOX_NAMESPACE: the site's <site>-sbx). */
  namespace: string;
  /**
   * The process's own namespace (MAKEFUN_K8S_NAMESPACE), a DNS label: where its own pod (the creator: ownDeletion, a
   * lanes pod's owner) and the live creators the orphan reap trusts are read, and the grader pods counted
   * (runningGraders, graderPods). Absent: `namespace`, the one namespace for both (a burst grader's, the e2e rig's).
   */
  ownNamespace?: string;
  /** The data PVC and where the worker mounts it (PodPlacement). */
  dataPvc: string;
  dataRoot: string;
  /** The pods' RuntimeClass (gvisor), or null for the node's default (runc: no process cap, the header). */
  runtimeClass: string | null;
  /** The pods' service account. */
  serviceAccount: string;
  nodeSelector?: Readonly<Record<string, string>> | null;
  /** Where every timed pod goes (the header's Timing: openCpuClock's views); absent or null: `nodeSelector`. */
  timedNodeSelector?: Readonly<Record<string, string>> | null;
  /**
   * The share of its untimed program pods but the forwarders and the race pods that prefer the app node (the header's
   * Room on the node; server/config.ts MAKEFUN_K8S_APP_NODE_SHARE), from 0 to 1: each such pod's preference is drawn as
   * it is made, from the nodes' room (nodePodRooms) and its name (drawnNodePreference); a race pod's is
   * racePodPreference, whenever this or an appNodeSandboxPods is set. Absent or null: no drawn preference and, without
   * an appNodeSandboxPods, no room read as a pod is made, the driver as before (a forwarder's own preference stands either way).
   */
  appNodeShare?: number | null;
  /**
   * The most sandbox pods the app node (APP_NODE_LABEL) may hold before an untimed one is kept off it (the header's Room
   * on the node; server/config.ts MAKEFUN_K8S_APP_NODE_SANDBOX_PODS), a whole number from 0: every namespace's pods
   * labelled makefun.io/role=sandbox bound there and not finished count, timed ones included, which the cap never
   * refuses, race pods not (CAPPED_SANDBOX_SELECTOR), which it neither counts nor refuses, and trial agents not
   * (TRIAL_AGENT_LABEL), which the drawn placement keeps off the app node whatever the cap. The room reads (nodePodRoom, nodePodRooms) give the app node no more than the cap less those pods, and the
   * drawn placement keeps every untimed pod off it at the cap. Absent or null: no cap, the driver as before.
   */
  appNodeSandboxPods?: number | null;
  /** masq's origin as a forwarder reaches it (config.llmGatewaySandboxUrl), or null: no forwarder gets a gateway policy. */
  llmGateway?: string | null;
  /** The kubectl CLI (default `kubectl`); ignored when `exec` is given. */
  kubectl?: string;
  /** How to run kubectl to its end (default kubectlExec(kubectl)); tests pass a fake. No exec of a pod goes by kubectl. */
  exec?: KubectlExec;
  /**
   * The pace its pod creates wait on (the header's pace), or null for none. Default: the process's one pace
   * (processSandboxPace) when `exec` is not given, else none.
   */
  pace?: SandboxPace | null;
  /**
   * The API server the recurring list reads ask in-process (K8sSandbox.listExec, k8s-count.ts), or null for kubectl
   * alone. Default: inClusterApiGet() (this pod's service account) when `exec` is not given, else null.
   */
  api?: ApiGet | null;
  /**
   * How the room read counts each node's pods (RoomList). Default `cluster` when no `api` and no `exec` is given and
   * KUBECONFIG names a cluster (a burst grader's: a small cluster outside this pod's own, its lists asked over that
   * kubeconfig's token by the driver's apiExec), else `per-node`; a caller passing its own `exec` picks it here.
   */
  roomList?: RoomList;
  /** A host name's addresses (default the system resolver's). */
  lookup?: (host: string) => Promise<string[]>;
  /** removeTree's unlock of this process's own directories, before its delete (default unlock.ts unlockOwn). */
  unlock?: (dir: string) => Promise<void>;
  /** removeTree's delete, once this process's own directories are unlocked (default fs rm, recursive and forced). */
  rm?: (dir: string) => Promise<void>;
  images?: ImageTableT;
  /** How long a pod may take to be Ready (default READY_TIMEOUT_MS). */
  readyTimeoutMs?: number;
  /** How long a program's exec has, from the moment it is made, for the wrapper's start line (default EXEC_START_TIMEOUT_MS). */
  execStartTimeoutMs?: number;
  /** How long a timed program's kill() waits for its launcher's reading before it cuts the exec (default TIMED_KILL_MS). */
  timedKillMs?: number;
  /** How long an unexplained pod whose `watch` is dead too is re-read for its eviction (default EVICTION_SETTLE_MS). */
  evictionSettleMs?: number;
  /** Where a pod no delete removed is reported. */
  warn?: (line: string) => void;
  /**
   * This process's own pod in the namespace (POD_NAME, from the downward API), a DNS subdomain: every pod it makes is
   * annotated with it (CREATOR_ANNOTATION) and it reaps the pods of creators gone (reapOrphans, the header's Reaping).
   * Absent or null: no annotation and no reap, the driver as before.
   */
  creator?: string | null;
  /**
   * With a creator, how often it reaps (default ORPHAN_REAP_EVERY_MS), once at once and then on an unref'd timer, one
   * reaper per namespace and creator in the process however many sandboxes it builds; 0 starts none (reapOrphans still
   * runs when called).
   */
  orphanReapEveryMs?: number;
  /** The clock reapOrphans dates pods against (default Date.now). */
  now?: () => number;
  /**
   * Whether the sandbox offers case sessions (K8sSandbox.sessions; the header's Case sessions: a per-file execution's
   * cases one after another in one session pod). Absent or false: no `sessions`, every case a program pod of its own.
   */
  caseSessions?: boolean;
  /** How a pod's agent is dialled (default dialAgent: agent-client.ts AgentSession.open at <pod IP>:9011); tests pass the fake agent's. */
  agentDial?: AgentDial;
  /** Where a one-pod member's door dial that ran and missed is reported (K8sContext.doorMissed; default reportLanesDoorMiss); tests pass a recorder. */
  doorMissed?: (miss: DoorMissReport) => void;
  /**
   * MAKEFUN_AGENT_PEERS of every pod it makes: the addresses its agents admit. Default agent-client.ts agentPeerIp's
   * (MAKEFUN_AGENT_PEER_IP, else the relay's /v1/peer, else this process's first non-internal IPv4: its pod's IP).
   */
  agentPeers?: readonly string[];
  /**
   * The pod watch a boot reads its pod's IP from (k8s-count.ts watchPod) and every readiness wait waits on (awaitPod,
   * awaitPlanPod), or null for kubectl wait. Default: processApiWatch() (this pod's service account, else a burst
   * grader's kubeconfig token) when `exec` is not given, else null.
   */
  apiWatch?: ApiWatch | null;
  /**
   * What the driver's other calls of the API server ask in-process (k8s-count.ts apiExec: its object reads, its deletes,
   * the creates of a policy and the preflight pod, the version read, the reap's and sweep's lists), or null for kubectl.
   * Default: inClusterApiObjects() (this pod's service account, else a burst grader's kubeconfig token) when `exec`
   * is not given, else null; a test passes a fake beside its `exec`, which takes what apiExec hands kubectl.
   */
  apiObjects?: ApiObjects | null;
  /**
   * The merge patch a pod's Secret is given its owner by (patchSecretOwner), or null for `kubectl patch`. Default:
   * inClusterApiPatch() (this pod's service account, else a burst grader's kubeconfig token) when `exec` is not
   * given, else null.
   */
  apiPatch?: ApiPatch | null;
  /**
   * The create a pod's Secret and then the pod are made by (bootAgentPod), or null for `kubectl create -f -`. Default:
   * inClusterApiCreate() (this pod's service account, else a burst grader's kubeconfig token) when `exec` is not given,
   * else null.
   */
  apiCreate?: ApiCreate | null;
  /**
   * Its warm pool (the header's Warm pool; k8s-pool.ts K8sWarmPool), which needs a creator: `max`, the most pods it
   * holds booted ahead of its pool-ready spawns (server/config.ts MAKEFUN_K8S_WARM_POOL_MAX); `ttlMs`, how long one
   * waits untaken (default POOL_TTL_MS); `tickMs`, how often it re-sizes (default POOL_TICK_MS; 0, only as spawns and
   * boots move it: a test's); `room`, the nodes' free places it may count per grader (default: nodePodRoom beside
   * POOL_NODE_HEADROOM over runningGraders; a test's stand-in); `rateTauMs`, its take rates' time constant (default
   * POOL_RATE_TAU_MS; a test's shorter one). It holds nothing until its places are attached (K8sWarmPool.attach, with
   * server/jobs.ts JobQueue.attachWarmPool's answer). Absent or null: no pool, every spawn cold.
   */
  warmPool?: { max: number; ttlMs?: number; tickMs?: number; rateTauMs?: number; room?: () => Promise<number | null> } | null;
  /**
   * The house images a spec's `image` may name (the header's house image: server/desk's validator images, each
   * `<repository>@sha256:<64 hex>`, checkHouseImages): such a spec's pod runs that image, its exec the image's argv,
   * labelled makefun.io/sandbox=desk. Absent or empty (every grading sandbox): every image spec refused
   * `repo_image_unsupported`, the driver as before.
   */
  houseImages?: ReadonlySet<string> | null;
}

/**
 * A warm pool's shape as K8sSandbox makes its pods (k8s-pool.ts PoolShape): its key and label, and its pod and Secret
 * built for a pod name (a refill's), with that pod's own drawn placement and the agents' spec read then.
 */
export interface K8sPoolShape extends PoolShape {
  build(name: string): Promise<{ pod: K8sObject; secret: K8sObject }>;
}

/**
 * The creates a warm pool's refills may start now (k8s-pool.ts's header: opts.paceRoom): half the pace's slots no
 * start is in or waiting for, rounded down, so a refill never puts a spawn's own create or exec behind it; with no pace,
 * no bound.
 */
export function warmPoolPaceRoom(pace: Pick<SandboxPace, 'limit' | 'inFlight' | 'waiting'> | null): number {
  return pace === null ? Number.POSITIVE_INFINITY : Math.floor(Math.max(0, pace.limit - pace.inFlight - pace.waiting) / 2);
}

/**
 * A pool-ready pod's shape key (POOL_ANNOTATION; the header's Pool-ready and Warm pool): the first POOL_KEY_HEX hex of the
 * sha256 of the pod and its Secret as made, the pod's name and its agents' K replaced by placeholders, so two spawns of
 * one shape share it whatever run they are and anything the shape changes (the runtime digest, the limits, the mounts
 * and their sizeLimits, the agent image and peers, the creator) makes another.
 */
export function shapeKeyOf(pod: K8sObject, secret: K8sObject): string {
  const key = agentKeyOf(secret);
  let text = JSON.stringify([pod, secret]).split(pod.metadata.name).join('<pod>');
  if (key !== null) text = text.split(key).join('<K>');
  return createHash('sha256').update(text).digest('hex').slice(0, POOL_KEY_HEX);
}

/**
 * The agents' peer as this process knows it without asking anything (agent-client.ts agentPeerIp's two local answers):
 * MAKEFUN_AGENT_PEER_IP, else (no relay named) its first non-internal IPv4; null when a relay's /v1/peer must say it,
 * or nothing does.
 */
function agentPeersNow(env: NodeJS.ProcessEnv = process.env): readonly string[] | null {
  const forced = env[AGENT_PEER_IP_ENV];
  if (forced !== undefined && forced !== '') return isIP(forced) === 0 ? null : [forced];
  try {
    if (agentRelayFromEnv(env) !== null) return null;
  } catch {
    return null;
  }
  const ip = firstNonInternalIpv4();
  return ip === null ? null : [ip];
}

/** How long one read of this process's own pod's deletion deadline may take (K8sSandbox.ownDeletion): inside the drain's 10 s between reads. */
export const OWN_POD_READ_TIMEOUT_MS = 8_000;

/**
 * kubectl's words for a token the API server no longer takes: `error: You must be logged in to the server
 * (Unauthorized)`, an HTTP 401. A 403 (Forbidden: the Role's) is a refusal of the verb, not of the token, and is not this.
 */
export const TOKEN_REFUSED_RE = /\bUnauthorized\b/;

/**
 * When this process's own pod is to be gone (K8sSandbox.ownDeletion): `none` while no deletion is asked (no
 * metadata.deletionTimestamp), `deleting` with the deadline a deletion set (its grace on from the delete; a later delete
 * with a shorter grace moves it earlier), `refused` when the API server refuses the process's token (TOKEN_REFUSED_RE),
 * `unread` when the read failed any other way or printed no time (`why` says how).
 */
export type OwnPodDeletion = { state: 'none' } | { state: 'deleting'; deadline: Date } | { state: 'refused'; why: string } | { state: 'unread'; why: string };

/** The namespaces and creators a reaper already runs for in this process (K8sSandbox's constructor). */
const ORPHAN_REAPERS = new Set<string>();

function checkName(value: string, re: RegExp, what: string): string {
  if (typeof value !== 'string' || !re.test(value)) throw new SandboxError(`${what} ${JSON.stringify(value)} is not a Kubernetes name`);
  return value;
}

function checkNodeSelector(selector: Readonly<Record<string, string>> | null | undefined): Readonly<Record<string, string>> | null {
  if (selector === undefined || selector === null) return null;
  for (const [k, v] of Object.entries(selector)) {
    if (!LABEL_KEY_RE.test(k) || typeof v !== 'string' || !LABEL_VALUE_RE.test(v)) throw new SandboxError(`node selector ${JSON.stringify(k)}=${JSON.stringify(v)} is not a label`);
  }
  return Object.freeze({ ...selector });
}

export class K8sSandbox implements Sandbox {
  readonly kind = 'k8s' as const;
  /** The sandbox namespace: where every pod it makes goes (K8sSandboxOptions.namespace). */
  readonly namespace: string;
  /** The process's own namespace (K8sSandboxOptions.ownNamespace), `namespace` when none was given. */
  readonly ownNamespace: string;
  readonly dataPvc: string;
  readonly dataRoot: string;
  readonly runtimeClass: string | null;
  readonly serviceAccount: string;
  readonly nodeSelector: Readonly<Record<string, string>> | null;
  /** Every timed pod's node selector (K8sSandboxOptions.timedNodeSelector), `nodeSelector` when none was given. */
  readonly timedNodeSelector: Readonly<Record<string, string>> | null;
  /** The share of the drawn placement's pods that prefer the app node (K8sSandboxOptions.appNodeShare), or null: no draw. */
  readonly appNodeShare: number | null;
  /** The most sandbox pods the app node may hold before an untimed one is kept off it (K8sSandboxOptions.appNodeSandboxPods), or null: no cap. */
  readonly appNodeSandboxPods: number | null;
  /** The LLM gateway a forwarder pod may reach, or null. */
  readonly llmGateway: { host: string; port: number } | null;
  readonly images: ImageTableT;
  readonly warn: (line: string) => void;
  /** This process's own pod, which annotates every pod it makes and reaps for (K8sSandboxOptions.creator), or null. */
  readonly creator: string | null;
  /** Its trial networks' owners, pods and names (what its TrialNetworks fills and clears). */
  readonly names = new PodNames();
  /** Its trial networks: per-trial NetworkPolicies over its pods (k8s-network.ts). */
  readonly networks: K8sTrialNetworks;
  /**
   * What the recurring list reads run on (the header's Room on the node): the API server in-process where
   * K8sSandboxOptions.api names one (apiListExec), else the driver's own exec (apiExec's lists over a burst grader's
   * kubeconfig token; kubectl where no in-process client is); every other argv goes to the driver's exec.
   */
  readonly listExec: KubectlExec;
  /** How the room read counts each node's pods (K8sSandboxOptions.roomList). */
  readonly roomList: RoomList;
  /** The pace its pod creates wait on (K8sSandboxOptions.pace), or null: none. */
  readonly pace: SandboxPace | null;
  readonly #ctx: K8sContext;
  readonly #lookup: (host: string) => Promise<string[]>;
  readonly #unlock: (dir: string) => Promise<void>;
  readonly #rm: (dir: string) => Promise<void>;
  /** preflight's probe per runtime and digest: kept once it passed, dropped when it failed. */
  readonly #preflights = new Map<string, Promise<void>>();
  /** nodePodRoom's last read (null: unknown) and when; when a read was last refused; the read in flight. */
  #room: { at: number; nodes: readonly NodeRoom[] | null } | null = null;
  #roomRefusedAt: number | null = null;
  #roomRead: Promise<readonly NodeRoom[] | null> | null = null;
  /** The last node read that answered, however old (null: none yet): a trial agent's placement through a failed read. */
  #roomSeen: readonly NodeRoom[] | null = null;
  /** Each room node's allocatable memory in MiB from the last read that answered (nodeMemoryMi), absent for a node that printed none. */
  #memoryMi: ReadonlyMap<string, number> = new Map();
  /** Each listed node the room read last found refusing pods, and why (nodeRefusal): what noteNodeRefusals warns against. */
  readonly #refusedNodes = new Map<string, string>();
  /** runningGraders's last read (null: unknown) and when; the read in flight. */
  #graders: { at: number; value: number | null } | null = null;
  #gradersRead: Promise<number | null> | null = null;
  /** sandboxPodsHeld's last read (null: unknown) and when; the read in flight. */
  #held: { at: number; value: number | null } | null = null;
  #heldRead: Promise<number | null> | null = null;
  /** graderPods's last read (null: unknown) and when; the read in flight. */
  #graderPods: { at: number; value: readonly GraderPodRead[] | null } | null = null;
  #graderPodsRead: Promise<readonly GraderPodRead[] | null> | null = null;
  /** sandboxPodViews's last read (null: unknown) and when; the read in flight. */
  #sandboxPods: { at: number; value: readonly SandboxPodRead[] | null } | null = null;
  #sandboxPodsRead: Promise<readonly SandboxPodRead[] | null> | null = null;
  readonly #now: () => number;
  /** Its program processes not yet exited, in spawn order (a timed sandbox's too): what meterTree finds a mount's pod in. */
  readonly #live = new Set<K8sProcess>();
  /** Its one-pod view, once asked for (onePod). */
  #onePod: K8sOnePodSandbox | null = null;
  /**
   * Its case sessions (K8sSandboxOptions.caseSessions; the header's Case sessions, k8s-session.ts K8sSession): one
   * session pod a per-file execution. Absent unless caseSessions is true.
   */
  readonly sessions?: SandboxSessions;
  /** The agents' peers as given (K8sSandboxOptions.agentPeers), or null: agentPeerIp's. */
  readonly #agentPeers: readonly string[] | null;
  /** The agents' peers as known without asking (the given ones, else agentPeersNow at construction), or null: a relay's, read per pod. */
  readonly #agentPeersKnown: readonly string[] | null;
  /** Its warm pool (K8sSandboxOptions.warmPool; the header's Warm pool), or null: every spawn cold. */
  readonly warmPool: K8sWarmPool<K8sPoolShape> | null;
  /** The house images its image specs may name (K8sSandboxOptions.houseImages, checked), or null: none. */
  readonly houseImages: ReadonlySet<string> | null;

  constructor(opts: K8sSandboxOptions) {
    this.namespace = checkName(opts.namespace, DNS_LABEL_RE, 'namespace');
    this.ownNamespace = opts.ownNamespace === undefined ? this.namespace : checkName(opts.ownNamespace, DNS_LABEL_RE, 'own namespace');
    this.dataPvc = checkName(opts.dataPvc, DNS_SUBDOMAIN_RE, 'data PVC');
    const root = posix.normalize(checkHostPath(opts.dataRoot)).replace(/(.)\/$/, '$1');
    if (root === '/') throw new SandboxError('the data root cannot be /');
    this.dataRoot = root;
    this.runtimeClass = opts.runtimeClass === null ? null : checkName(opts.runtimeClass, DNS_SUBDOMAIN_RE, 'RuntimeClass');
    this.serviceAccount = checkName(opts.serviceAccount, DNS_SUBDOMAIN_RE, 'service account');
    this.nodeSelector = checkNodeSelector(opts.nodeSelector);
    this.timedNodeSelector = opts.timedNodeSelector === undefined || opts.timedNodeSelector === null ? this.nodeSelector : checkNodeSelector(opts.timedNodeSelector);
    this.appNodeShare = opts.appNodeShare === undefined || opts.appNodeShare === null ? null : checkAppNodeShare(opts.appNodeShare);
    this.appNodeSandboxPods = opts.appNodeSandboxPods === undefined || opts.appNodeSandboxPods === null ? null : checkAppNodeSandboxPods(opts.appNodeSandboxPods);
    this.llmGateway = opts.llmGateway === undefined || opts.llmGateway === null ? null : gatewayTarget(opts.llmGateway);
    this.images = opts.images ?? IMAGES;
    this.warn = opts.warn ?? ((line) => console.warn(line));
    this.creator = opts.creator === undefined || opts.creator === null ? null : checkName(opts.creator, DNS_SUBDOMAIN_RE, 'creator pod');
    const house = opts.houseImages === undefined || opts.houseImages === null ? null : checkHouseImages(opts.houseImages);
    this.houseImages = house === null || house.size === 0 ? null : house;
    this.#now = opts.now ?? Date.now;
    const reapEveryMs = opts.orphanReapEveryMs ?? ORPHAN_REAP_EVERY_MS;
    if (!Number.isFinite(reapEveryMs) || reapEveryMs < 0) throw new SandboxError(`orphan reap interval ${reapEveryMs} is out of range`);
    const kubectlCli = opts.kubectl ?? 'kubectl';
    this.pace = opts.pace !== undefined ? opts.pace : opts.exec === undefined ? processSandboxPace(this.warn) : null;
    if (opts.agentPeers !== undefined) {
      try {
        formatPeers(opts.agentPeers);
      } catch (err) {
        throw new SandboxError(`the agents' ${(err as Error).message}`);
      }
    }
    this.#agentPeers = opts.agentPeers === undefined ? null : Object.freeze([...opts.agentPeers]);
    this.#agentPeersKnown = this.#agentPeers ?? agentPeersNow();
    // The driver's calls asked of the API server in-process where this process can (apiExec), kubectl taking the rest.
    const objects = opts.apiObjects !== undefined ? opts.apiObjects : opts.exec === undefined ? inClusterApiObjects(apiClientEnv()) : null;
    const cli = opts.exec ?? kubectlExec(kubectlCli);
    this.#ctx = {
      namespace: this.namespace,
      ownNamespace: this.ownNamespace,
      exec: seenExec(objects === null ? cli : apiExec(objects, cli, { timeoutMs: KUBECTL_TIMEOUT_MS, warn: this.warn, keep: { pods: POD_LIST_KEEP, nodes: NODE_LIST_KEEP } })),
      names: this.names,
      warn: this.warn,
      readyTimeoutMs: opts.readyTimeoutMs ?? READY_TIMEOUT_MS,
      execStartTimeoutMs: opts.execStartTimeoutMs ?? EXEC_START_TIMEOUT_MS,
      timedKillMs: opts.timedKillMs ?? TIMED_KILL_MS,
      evictionSettleMs: opts.evictionSettleMs ?? EVICTION_SETTLE_MS,
      pace: this.pace,
      dial: opts.agentDial ?? dialAgent,
      apiWatch: opts.apiWatch !== undefined ? opts.apiWatch : opts.exec === undefined ? processApiWatch(apiClientEnv()) : null,
      apiPatch: opts.apiPatch !== undefined ? opts.apiPatch : opts.exec === undefined ? inClusterApiPatch(apiClientEnv()) : null,
      apiCreate: opts.apiCreate !== undefined ? opts.apiCreate : opts.exec === undefined ? inClusterApiCreate(apiClientEnv()) : null,
      doorMissed: opts.doorMissed ?? ((miss) => void reportLanesDoorMiss(miss)),
    };
    // The agent metrics on the process's registry, as the pace's (a process running its own kubectl: not a test's).
    if (opts.exec === undefined) void registerAgentMetrics(this.warn);
    const api = opts.api !== undefined ? opts.api : opts.exec === undefined ? inClusterApiGet() : null;
    this.listExec = api === null ? this.#ctx.exec : apiListExec(api, this.#ctx.exec, { timeoutMs: KUBECTL_TIMEOUT_MS, warn: this.warn, keep: { pods: POD_LIST_KEEP, nodes: NODE_LIST_KEEP } });
    const kubeconfig = process.env.KUBECONFIG;
    this.roomList = opts.roomList ?? (api === null && opts.exec === undefined && kubeconfig !== undefined && kubeconfig !== '' ? 'cluster' : 'per-node');
    if (this.roomList !== 'cluster' && this.roomList !== 'per-node') throw new SandboxError(`room list ${JSON.stringify(this.roomList)} is neither per-node nor cluster`);
    this.#lookup = opts.lookup ?? (async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address));
    this.#unlock = opts.unlock ?? unlockOwn;
    this.#rm = opts.rm ?? ((dir) => rm(dir, { recursive: true, force: true }));
    this.networks = new K8sTrialNetworks({ ctx: this.#ctx, placement: this.placement, images: this.images, agent: () => this.agentSpec() });
    if (this.creator !== null && reapEveryMs > 0) this.#startOrphanReap(reapEveryMs);
    if (opts.caseSessions === true) this.sessions = { open: (template) => new K8sSession(this.#sessionHost(), template) };
    const pool = opts.warmPool ?? null;
    if (pool !== null && this.creator === null) throw new SandboxError("a warm pool needs a creator (POD_NAME): its pods are swept at the creator's restart and reaped by its annotation");
    const room = pool?.room;
    this.warmPool =
      pool === null
        ? null
        : new K8sWarmPool<K8sPoolShape>({
            max: pool.max,
            ttlMs: pool.ttlMs ?? POOL_TTL_MS,
            ...(pool.tickMs === undefined ? {} : { tickMs: pool.tickMs }),
            ...(pool.rateTauMs === undefined ? {} : { rateTauMs: pool.rateTauMs }),
            boot: (shape, signal) => this.#poolBoot(shape, signal),
            remove: (refs) => deleteObjects(this.#ctx, refs),
            redial: (pod, budgetMs) => this.#poolRedial(pod, budgetMs),
            room: room ?? (() => this.#poolRoom()),
            paceRoom: () => warmPoolPaceRoom(this.pace),
            sweep: () => this.#sweepPoolPods(),
            warn: this.warn,
            now: this.#now,
          });
    if (this.warmPool !== null && opts.exec === undefined) void registerPoolMetrics(this.warn);
  }

  /**
   * One warm pod of `shape` (k8s-pool.ts's boot): a fresh name of its label, the pod and Secret built for it (its own
   * drawn placement, POOL_ANNOTATION), made and booted to its `stage` agent's first answer (bootToAgent, its init
   * unclocked: the pool times its refills), cut by `signal`. What it may have made is in its end's refs, the pod first.
   */
  async #poolBoot(shape: K8sPoolShape, signal: AbortSignal): Promise<PoolBoot> {
    const name = podName(shape.label);
    const refs = [`pod/${name}`, `secret/${envSecretName(name)}`];
    let built: { pod: K8sObject; secret: K8sObject };
    try {
      built = await shape.build(name);
    } catch (err) {
      return { ok: false, killed: false, error: `pod ${name}: ${errorWords(err)}`, noRoom: null, refs: [] };
    }
    const reached = await bootToAgent(this.#ctx, { name, objects: [built.pod], secret: built.secret, trees: [], signal, killed: () => signal.aborted, init: null });
    if (!reached.ok) return reached.killed ? { ok: false, killed: true, error: `pod ${name} was cut off`, noRoom: null, refs } : { ok: false, killed: false, error: reached.error, noRoom: reached.noRoom, refs };
    return { ok: true, pod: { name, refs, ip: reached.ip, key: reached.key!, stage: reached.stage!, watched: reached.watched, shape: shape.key } };
  }

  /** A claim's re-dial of a warm pod's `stage` agent (k8s-pool.ts's take): its pin checked again, then its /v1/health. */
  async #poolRedial(pod: WarmPod, budgetMs: number): Promise<PodAgentSession> {
    const session = await (this.#ctx.dial ?? dialAgent)({ pod: pod.name, ip: pod.ip, key: pod.key, agent: STAGE_CONTAINER, budgetMs });
    try {
      await session.health({ timeoutMs: budgetMs });
    } catch (err) {
      void session.close();
      throw err;
    }
    return session;
  }

  /** The nodes' free places a warm pool counts (k8s-pool.ts's room): nodePodRoom beside POOL_NODE_HEADROOM over runningGraders, or null. */
  async #poolRoom(): Promise<number | null> {
    const free = await this.nodePodRoom(POOL_NODE_HEADROOM);
    if (free === null) return null;
    const graders = await this.runningGraders();
    return Math.floor(free / Math.max(1, graders ?? 1));
  }

  /**
   * The warm pool's restart sweep (k8s-pool.ts's header): every sandbox pod annotated POOL_ANNOTATION whose creator is
   * this process's own pod, with its Secret, deleted: a run of this container before a restart left it, and no process
   * adopts a pool pod (its K died with that run). Before the pool's first refill, so none is this run's. A list that
   * fails is said, and leaves them to their `stage` agent's arrival deadline (STAGE_ARRIVAL_S) and the stale sweep.
   */
  async #sweepPoolPods(): Promise<void> {
    const listed = await kubectl(this.#ctx, ['get', 'pods', '-l', `${ROLE_LABEL}=sandbox`, '-o', 'json']);
    if (listed.code !== 0 || listed.error !== undefined) throw new Error(`kubectl get pods -l ${ROLE_LABEL}=sandbox: ${why(listed)}`);
    const read = await listDoc(listed, POD_LIST_KEEP);
    if (!('doc' in read)) throw new Error(`kubectl get pods -l ${ROLE_LABEL}=sandbox: ${'failed' in read ? read.failed : 'its list did not parse'}`);
    const items = (read.doc as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) throw new Error(`kubectl get pods -l ${ROLE_LABEL}=sandbox printed no list`);
    const ours = (items as Array<{ metadata?: { name?: unknown; annotations?: Record<string, unknown>; deletionTimestamp?: unknown } } | null>).flatMap((item) => {
      const name = item?.metadata?.name;
      const notes = item?.metadata?.annotations;
      return typeof name === 'string' && notes?.[POOL_ANNOTATION] !== undefined && notes[CREATOR_ANNOTATION] === this.creator && !beingDeleted(item) ? [name] : [];
    });
    if (ours.length === 0) return;
    await deleteObjects(this.#ctx, ours.flatMap((name) => [`pod/${name}`, `secret/${envSecretName(name)}`]));
    this.warn(`k8s sandbox: the warm pool deleted ${ours.length} pool pod(s) an earlier run of this process left (${ours.join(', ')}): a pool pod is never adopted`);
  }

  /**
   * What a case session is given of this sandbox (k8s-session.ts K8sSessionHost): its context and placement, the drawn
   * placement of a pod (as #spawn's untimed pods but a forwarder's), a session pod's env Secret (a program pod's, no
   * trial), its pods' agents' spec (agentCheckSpec and agentSpec, as onePod's), and each run's K8sProcess in its session
   * mode (Launch.session: no create or delete of its own, its writable mounts collected from `watch` as any program pod's).
   */
  #sessionHost(): K8sSessionHost {
    return {
      ctx: this.#ctx,
      placement: this.placement,
      images: this.images,
      runtimeClass: this.runtimeClass,
      sandbox: this,
      agent: { check: () => this.agentCheckSpec(), read: () => this.agentSpec() },
      prefer: (pod) => (this.appNodeShare === null && this.appNodeSandboxPods === null ? Promise.resolve(null) : this.#preferenceFor(pod)),
      envSecret: (spec, pod) => sandboxEnvSecret(spec, { name: pod, namespace: this.namespace, ...objectMarks(pod, null, null) }),
      pool: this.warmPool,
      spawnRun: (run) =>
        new K8sProcess(this.#ctx, {
          name: run.name,
          objects: async () => [],
          refs: [],
          argv: [],
          env: run.env,
          pids: run.pids,
          mounts: run.mounts,
          stage: { trees: [], collect: run.mounts.filter((m) => !m.readOnly).map((m) => ({ mount: m.at, dir: m.host, returns: m.returns! })) },
          network: null,
          session: run.session,
        }),
    };
  }

  /**
   * Where its pods go and what they run as; with a creator, who makes them (no `creator` key without one); the agents'
   * spec once the agent image is pinned and their peer known without asking (no `agent` key otherwise: a relay's peer is
   * read as each pod is made, agentSpec).
   */
  get placement(): PodPlacement {
    const peers = this.#agentPeersKnown;
    let image: string | null;
    try {
      image = this.agentImageRef();
    } catch {
      image = null;
    }
    return {
      namespace: this.namespace,
      dataPvc: this.dataPvc,
      dataRoot: this.dataRoot,
      runtimeClass: this.runtimeClass,
      serviceAccount: this.serviceAccount,
      nodeSelector: this.nodeSelector,
      ...(this.creator === null ? {} : { creator: this.creator }),
      ...(image === null || peers === null ? {} : { agent: { image, peers } }),
    };
  }

  /** The agent image every program pod's `stage` and `watch` run, `<image>@<digest>` (images.ts agentImage); a SandboxError while none is pinned. */
  agentImageRef(): string {
    let entry: ReturnType<typeof agentImage>;
    try {
      entry = agentImage(this.images);
    } catch (err) {
      throw new SandboxError(errorWords(err));
    }
    return imageRef(entry, entry.digest);
  }

  /**
   * The agents' spec a pod is created with (the header's The pod): the agent image and their peer, read now
   * (K8sSandboxOptions.agentPeers, else agent-client.ts agentPeerIp: a relay's /v1/peer, cached there). A SandboxError
   * when either cannot be had.
   */
  async agentSpec(): Promise<PodAgentSpec> {
    const image = this.agentImageRef();
    if (this.#agentPeers !== null) return { image, peers: this.#agentPeers };
    try {
      return { image, peers: [await agentPeerIp()] };
    } catch (err) {
      throw new SandboxError(`the agents' peer could not be read: ${errorWords(err)}`);
    }
  }

  /** The agents' spec a pod is built with only to be checked (never sent): the agent image, and their peer as known now or SPEC_CHECK_PEER. */
  agentCheckSpec(): PodAgentSpec {
    return { image: this.agentImageRef(), peers: this.#agentPeersKnown ?? [SPEC_CHECK_PEER] };
  }

  /**
   * reapOrphans now and every `everyMs` after, on an unref'd timer, a pass never started while one runs: once per
   * namespace and creator in the process. What it reaped is said; a failure is said once until it changes.
   */
  #startOrphanReap(everyMs: number): void {
    const key = `${this.namespace}\n${this.creator}`;
    if (ORPHAN_REAPERS.has(key)) return;
    ORPHAN_REAPERS.add(key);
    let running = false;
    let lastProblem = '';
    const pass = (): void => {
      if (running) return;
      running = true;
      this.reapOrphans()
        .then(
          (r) => {
            const problem = r.errors.join('; ');
            if (problem !== '' && problem !== lastProblem) this.warn(`k8s sandbox: the orphan reap in namespace ${this.namespace}: ${problem}`);
            lastProblem = problem;
          },
          (err: unknown) => this.warn(`k8s sandbox: the orphan reap in namespace ${this.namespace} failed: ${(err as Error).message}`),
        )
        .finally(() => {
          running = false;
        });
    };
    setTimeout(pass, 0).unref();
    setInterval(pass, everyMs).unref();
  }

  /**
   * Delete every sandbox pod in the namespace whose creator (CREATOR_ANNOTATION) is no pod still running in the
   * process's own namespace (ownNamespace: the creators live there, the sandbox namespace holds only their pods) and
   * that is older than ORPHAN_GRACE_MS, with its env Secret and gateway policy, and the trial policy of
   * each trial none of whose pods is kept (the header's Reaping). Never a pod already being deleted (beingDeleted: it
   * keeps no trial's policy either), never a pod with no creator, never another
   * namespace; nothing without a creator of its own, or when the own namespace's pods do not list it. Never throws: the
   * result says what it deleted (`containers` the pods, `networks` the trial policies) and what it could not read.
   */
  async reapOrphans(): Promise<SweepResult> {
    const res: SweepResult = { containers: [], networks: [], errors: [] };
    const self = this.creator;
    if (self === null) return res;
    const ctx = this.#ctx;
    const failed = (r: KubectlResult): boolean => r.code !== 0 || r.error !== undefined;
    const sandboxes = await kubectl(ctx, ['get', 'pods', '-l', `${ROLE_LABEL}=sandbox`, '-o', 'json']);
    if (failed(sandboxes)) {
      res.errors.push(`kubectl get pods -l ${ROLE_LABEL}=sandbox: ${why(sandboxes)}`);
      return res;
    }
    // read off the event loop (POD_LIST_KEEP): a namespace's sandbox pods run to megabytes of JSON
    const read = await listDoc(sandboxes, POD_LIST_KEEP);
    if ('failed' in read) {
      res.errors.push(`kubectl get pods -l ${ROLE_LABEL}=sandbox: ${read.failed}`);
      return res;
    }
    const items = 'doc' in read && read.doc !== null && read.doc !== undefined ? (read.doc as { items?: unknown }).items : undefined;
    if (!Array.isArray(items)) {
      res.errors.push(`kubectl get pods -l ${ROLE_LABEL}=sandbox printed no list: ${JSON.stringify(sandboxes.stdout.slice(0, 200))}`);
      return res;
    }
    // The creators are this process's own namespace's pods (the graders, the worker, the racer), never the sandbox one's.
    const live = await kubectl(ownContextOf(ctx), ['get', 'pods', '--field-selector', 'status.phase!=Succeeded,status.phase!=Failed', '-o', 'name']);
    if (failed(live)) {
      res.errors.push(`kubectl get pods -n ${this.ownNamespace} -o name: ${why(live)}`);
      return res;
    }
    const alive = new Set(
      live.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('pod/'))
        .map((l) => l.slice(4)),
    );
    if (!alive.has(self)) {
      res.errors.push(`this process's own pod ${self} is not among namespace ${this.ownNamespace}'s running pods, so their list is not trusted to say which creators are gone: nothing reaped`);
      return res;
    }
    const cutoff = this.#now() - ORPHAN_GRACE_MS;
    type Item = { metadata?: { name?: unknown; creationTimestamp?: unknown; deletionTimestamp?: unknown; labels?: Record<string, unknown>; annotations?: Record<string, unknown> } };
    const orphans: Array<{ name: string; trial: string | null }> = [];
    const keptTrials = new Set<string>();
    for (const item of items as Item[]) {
      const name = item?.metadata?.name;
      if (typeof name !== 'string') continue;
      const trial = item.metadata?.labels?.[NETWORK_LABEL];
      const trialOfPod = typeof trial === 'string' ? trial : null;
      const keep = (): void => {
        if (trialOfPod !== null) keptTrials.add(trialOfPod);
      };
      const creator = item.metadata?.annotations?.[CREATOR_ANNOTATION];
      if (!name.startsWith(POD_PREFIX) || typeof creator !== 'string' || alive.has(creator)) {
        keep();
        continue;
      }
      // Already being deleted (by its creator before it died, or by an earlier pass): going, listed until the kubelet is done.
      if (beingDeleted(item)) continue;
      const created = parseDockerTime(item.metadata?.creationTimestamp);
      if (created === null) {
        res.errors.push(`pod/${name}: no creation time`);
        keep();
      } else if (created > cutoff) keep();
      else orphans.push({ name, trial: trialOfPod });
    }
    if (orphans.length === 0) return res;
    const refs: string[] = [];
    for (const o of orphans) {
      refs.push(`pod/${o.name}`, `secret/${envSecretName(o.name)}`, `networkpolicy/${o.name}${GATEWAY_POLICY_SUFFIX}`);
      res.containers.push(o.name);
    }
    for (const trial of new Set(orphans.map((o) => o.trial))) {
      if (trial === null || keptTrials.has(trial)) continue;
      let policy: string;
      try {
        policy = trialNetworkName(trial);
      } catch {
        continue;
      }
      refs.push(`networkpolicy/${policy}`);
      res.networks.push(policy);
    }
    this.warn(`k8s sandbox: reaping ${orphans.length} sandbox pod(s) whose creator is gone (${orphans.map((o) => o.name).join(' ')})${res.networks.length === 0 ? '' : ` and trial policies ${res.networks.join(' ')}`}`);
    await deleteObjects(ctx, refs);
    return res;
  }

  /**
   * When this process's own pod (the creator) is to be gone: its metadata.deletionTimestamp, read once through the
   * driver's exec (in a pod its GET asked in-process: k8s-count.ts apiExec) within OWN_POD_READ_TIMEOUT_MS (the header's `Its own pod's deletion deadline`). Never throws: a
   * process with no pod of its own, a read that fails or prints no time is `unread`, one the API server refuses the
   * token of `refused`.
   */
  async ownDeletion(): Promise<OwnPodDeletion> {
    if (this.creator === null) return { state: 'unread', why: 'this process names no pod of its own (POD_NAME)' };
    let r: KubectlResult;
    try {
      r = await kubectl(ownContextOf(this.#ctx), ['get', `pod/${this.creator}`, '-o', 'jsonpath={.metadata.deletionTimestamp}'], { timeoutMs: OWN_POD_READ_TIMEOUT_MS });
    } catch (err) {
      return { state: 'unread', why: `kubectl get pod/${this.creator}: ${(err as Error).message}` };
    }
    if (r.code !== 0 || r.error !== undefined) {
      const said = `kubectl get pod/${this.creator}: ${why(r)}`;
      return TOKEN_REFUSED_RE.test(r.stderr) ? { state: 'refused', why: said } : { state: 'unread', why: said };
    }
    const text = r.stdout.trim();
    if (text === '') return { state: 'none' };
    const at = Date.parse(text);
    return Number.isFinite(at) ? { state: 'deleting', deadline: new Date(at) } : { state: 'unread', why: `kubectl get pod/${this.creator} printed no time: ${JSON.stringify(text.slice(0, 100))}` };
  }

  imageDigest(runtime: Runtime): string {
    return imageFor(runtime, this.images).digest;
  }

  /**
   * A timed sandbox and its CPU clock (the header's Timing), as docker.ts openCpuClock hands back: every program the
   * sandbox spawns runs in a timed pod under the CPU launcher, its reading added to the clock once it exits. Nothing
   * runs for the clock itself (the launcher is perl in the program's own image), so `runtime` is only checked as one the
   * image table pins. Close the clock when the heat is done.
   */
  openCpuClock(runtime: Runtime): TimedK8sSandbox {
    imageFor(runtime, this.images);
    const clock = new K8sCpuClock(`${K8S_CPU_CLOCK_SOURCE} ${this.runtimeClass ?? 'default'} cpu-${randomBytes(6).toString('hex')}`);
    return { clock, sandbox: new K8sTimedSandbox(this, (spec) => this.#spawn(spec, true), clock) };
  }

  /**
   * Both images pull and run on the node (a pod whose init container runs the agent image's `makefun-agent version` and
   * whose `main` runs `true` in the runtime's image, each IfNotPresent through the registry's pull Secret, under the same
   * RuntimeClass, account and selector, reaches Succeeded): once per runtime, digest and agent image. No exec RBAC is
   * asked: a grading exec goes over its pod's agent, never the API server's pods/exec.
   */
  async preflight(runtime: Runtime, imageDigest: string | null = null): Promise<void> {
    const entry = imageFor(runtime, this.images);
    const digest = imageDigest ?? entry.digest;
    const agent = this.agentImageRef();
    const key = `${runtime} ${imageRef(entry, digest)} ${agent}`;
    let done = this.#preflights.get(key);
    if (done === undefined) {
      done = this.#probe(entry.image, digest, agent);
      this.#preflights.set(key, done);
      done.catch(() => this.#preflights.delete(key));
    }
    return done;
  }

  /**
   * A house image (the header's house image: one of houseImages, else the SandboxError of code
   * `repo_image_unsupported`) and the agent image pull and run on the node, as preflight proves a runtime's: the same
   * pod, `true` in `<repository>@<digest>` as the sandbox user after the agent's `version`, within readyTimeoutMs in
   * place of PREFLIGHT_TIMEOUT_MS (a node's first pull of a multi-GB image is that long). Once per image and agent
   * image: kept once it passed, dropped when it failed.
   */
  async preflightImage(repository: string, digest: string): Promise<void> {
    const ref = repoImageRef(repository, digest);
    if (this.houseImages === null) throw repoImageUnsupported('');
    if (!this.houseImages.has(ref)) throw repoImageUnsupported(` but its house images, and ${ref} is none of them`);
    const agent = this.agentImageRef();
    const key = `house ${ref} ${agent}`;
    let done = this.#preflights.get(key);
    if (done === undefined) {
      done = this.#probe(repository, digest, agent, this.#ctx.readyTimeoutMs);
      this.#preflights.set(key, done);
      done.catch(() => this.#preflights.delete(key));
    }
    return done;
  }

  async #probe(image: string, digest: string, agent: string, budgetMs = PREFLIGHT_TIMEOUT_MS): Promise<void> {
    const ref = imageRef({ image }, digest);
    const name = podName('preflight');
    // The agent's peers are no part of a preflight (its agent only prints its version): the image alone is read.
    const made = await kubectl(this.#ctx, KUBECTL_CREATE, { input: JSON.stringify(preflightPodSpec({ ...this.placement, name, image, digest, agent: { image: agent, peers: [] } })) });
    try {
      if (made.code !== 0 || made.error !== undefined) {
        const said = why(made);
        const message = `kubectl could not create the preflight pod for ${ref} and ${agent}: ${said}`;
        throw made.error === undefined && NO_ROOM_RE.test(said) ? new NodeRoomError(message, said) : new SandboxError(message);
      }
      const done = await awaitPod(this.#ctx, name, 'Succeeded', budgetMs);
      if (!done.ok) {
        const message = `the preflight pod ${name} for ${ref} and ${agent} did not run${done.node === undefined ? '' : ` on node ${done.node}`}: ${done.why}`;
        throw done.noRoom === undefined ? new SandboxError(message) : new NodeRoomError(message, done.noRoom);
      }
    } finally {
      await deleteObjects(this.#ctx, [`pod/${name}`]);
    }
  }

  /**
   * The free places now on the nodes this sandbox's pods go to (the header's Room on the node): of each node its
   * selector picks (every node with none) that takes pods (nodeRefusal: not cordoned, not Not Ready, no NoSchedule or
   * NoExecute taint; such a node is no room at all and its pods are not read, and its refusal's start, change and end
   * are each warned of once: noteNodeRefusals), max(0, min(status.allocatable.pods (the kubelet's
   * slots, the bound `Too many pods` names) less the pods bound to it in every namespace and not finished (prod's,
   * dev's, the races', the platform's: the pods the scheduler counts), its spec.podCIDR's addresses, else
   * spec.podCIDRs[0]'s, less ADDRESS_HEADROOM (the CNI refuses a new sandbox once the node's range is out, which the
   * scheduler never counts) less those pods and its finished pods still holding an address (a second read,
   * FINISHED_WITH_ADDRESS_SELECTOR as JSON, counted by finishedPodHoldsAddress: a pod Failed or being deleted keeps its
   * address until the kubelet tears its sandbox down))), summed over the nodes. A node that names neither range, or no
   * IPv4 one, is bounded by its allocatable alone, and its finished pods are not read. Under a sandbox cap
   * (appNodeSandboxPods) a node carrying APP_NODE_LABEL gives no more than the cap less every namespace's sandbox pods
   * but the race pods and the trial agents bound there and not finished (a third read, CAPPED_SANDBOX_SELECTOR; appNodeCappedRoom), so once the other nodes are full
   * the room holds jobs at the cap instead of handing them the app node's whole room. The address
   * half is why a node with pod slots to spare reads as no room once its addresses are gone, and why the caps sized from
   * this read are sized the way the node refuses work; a pod the scheduler placed and the CNI gave no address is still
   * the queue's Pending read (server/pipeline/pod-room.ts noAddressIn). Answered from the last read for
   * NODE_ROOM_CACHE_MS, one read at a time. Null when it cannot be read: a refusal (the Role grants no nodes and no
   * pods outside the namespace) is warned of once and not tried again for NODE_ROOM_REFUSED_MS; any other failure is
   * tried again on the next ask after the cache. With `headroom`, the slots a caller keeps free on a node
   * (server/jobs.ts NODE_POD_HEADROOM), each node gives only what it has past it and the headroom is given back once
   * (roomBesideHeadroom): what nodeHasRoom takes its headroom off, so that it is kept free on every node, never only on
   * their sum, and a node inside its headroom lends a job nothing. A node named in `out` gives nothing at all: the
   * queue's Pending read names there each node whose placed pods wait for an address (server/pipeline/pod-room.ts),
   * which this arithmetic cannot see while the addresses are held by sandboxes already gone from the API. Those are the
   * per-node lists (RoomList `per-node`); under RoomList `cluster` the same counts come from one list of every bound pod
   * (nodePodCountsOf), two lists a read whatever the nodes.
   */
  nodePodRoom(headroom = 0, out: Iterable<string> = []): Promise<number | null> {
    const without = new Set(out);
    return this.nodePodRooms().then((nodes) => (nodes === null ? null : roomBesideHeadroom(nodes.filter((n) => !without.has(n.node)).map((n) => n.free), headroom)));
  }

  /**
   * Each node's free places as nodePodRoom reads them (its cache, its one read at a time), with the node's name, its
   * labels and its allocatable CPU (NodeRoom.cpuMilli; roomCpuMilli sums it), or null when they cannot be read: what
   * tells the queue whether a node, other than the one a pod waits on for an address, carries the labels that pod's
   * selector asks for and still has room (pod-room.ts uncoveredOf). Only the nodes that take pods are here (nodeRefusal).
   * The same read's allocatable memory is beside it (nodeMemoryMi): NodeRoom stays the places a pod may take, while the
   * memory a home grader's trial room sizes on is read from the same cached node list, never a second one.
   */
  nodePodRooms(): Promise<readonly NodeRoom[] | null> {
    const at = Date.now();
    if (this.#room !== null && at - this.#room.at < NODE_ROOM_CACHE_MS) return Promise.resolve(this.#room.nodes);
    if (this.#roomRefusedAt !== null && at - this.#roomRefusedAt < NODE_ROOM_REFUSED_MS) return Promise.resolve(null);
    this.#roomRead ??= this.#readRoom().finally(() => {
      this.#roomRead = null;
    });
    return this.#roomRead;
  }

  /**
   * Each room node's allocatable memory in MiB (status.allocatable.memory, memoryQuantityMi) as the room read last
   * answered it, read from the same cached node list as nodePodRooms (no second one); null when the nodes cannot be read,
   * exactly as nodePodRooms answers null. A node that prints no memory this reads as a quantity is absent, and
   * server/pipeline/capacity.ts's memory term then reads no figure at all (the trial slots size on CPU alone, never a
   * guessed memory): what a home grader's split trials may ask of a node's memory (trialCpuRoomOf).
   */
  nodeMemoryMi(): Promise<readonly NodeMemoryRoom[] | null> {
    return this.nodePodRooms().then((nodes) =>
      nodes === null ? null : nodes.flatMap((r) => {
        const memoryMi = this.#memoryMi.get(r.node);
        return memoryMi === undefined ? [] : [{ node: r.node, memoryMi }];
      }),
    );
  }

  /**
   * Warn once of each change in which listed nodes refuse pods (nodeRefusal), never every read: a node starting to refuse
   * (named with why), refusing for another reason (named with both), or taking pods again. A node gone from the list is
   * forgotten without a line (deleted, or no longer picked by the selector: neither is room coming back), so a burst run's
   * boxes leave no state behind. A node listed with no name cannot be named and is not tracked.
   */
  #noteNodeRefusals(listed: ReadonlyArray<{ node: NodeJson | null | undefined; refusal: string | null }>): void {
    const seen = new Set<string>();
    for (const { node, refusal } of listed) {
      const name = node?.metadata?.name;
      if (typeof name !== 'string' || name === '') continue;
      seen.add(name);
      const was = this.#refusedNodes.get(name);
      if (refusal === null) {
        if (was === undefined) continue;
        this.#refusedNodes.delete(name);
        this.warn(`k8s sandbox: node ${name} takes pods again (it was ${was}): the room read counts its free places again`);
      } else if (was !== refusal) {
        this.#refusedNodes.set(name, refusal);
        this.warn(
          was === undefined
            ? `k8s sandbox: node ${name} refuses pods (${refusal}): the room read counts it as no room until it takes pods again`
            : `k8s sandbox: node ${name} still refuses pods, now ${refusal} (it was ${was}): the room read counts it as no room`,
        );
      }
    }
    for (const name of [...this.#refusedNodes.keys()]) if (!seen.has(name)) this.#refusedNodes.delete(name);
  }

  async #readRoom(): Promise<readonly NodeRoom[] | null> {
    const refused = (r: KubectlResult): boolean => r.error === undefined && /\(Forbidden\)|\bforbidden\b/i.test(r.stderr);
    const unknown = (r: KubectlResult, what: string): null => {
      if (refused(r)) {
        this.#roomRefusedAt = Date.now();
        this.warn(
          `k8s sandbox: the node's free pod slots cannot be read (${what}: ${why(r)}): grant this account get and list on nodes and list on pods in every namespace for the check; until then each pod waits for the scheduler's room within its ready budget, and is not read again for ${NODE_ROOM_REFUSED_MS / 60_000} minutes`,
        );
      } else {
        this.#room = { at: Date.now(), nodes: null };
      }
      return null;
    };
    const selector = this.nodeSelector === null ? [] : ['-l', Object.entries(this.nodeSelector).map(([k, v]) => `${k}=${v}`).join(',')];
    const listed = await this.listExec(['get', 'nodes', ...selector, '-o', 'json']);
    if (listed.code !== 0 || listed.error !== undefined) return unknown(listed, 'kubectl get nodes');
    // read off the event loop (NODE_LIST_KEEP); `(JSON.parse(stdout) as { items?: NodeJson[] }).items ?? []` as it was
    const nodeDoc = await listDoc(listed, NODE_LIST_KEEP);
    if ('failed' in nodeDoc) return unknown({ code: null, stdout: '', stderr: '', error: nodeDoc.failed }, 'kubectl get nodes');
    if ('unparsed' in nodeDoc || nodeDoc.doc === null || nodeDoc.doc === undefined) {
      return unknown({ code: 1, stdout: '', stderr: 'printed no node list' }, 'kubectl get nodes');
    }
    const listedNodes: unknown = (nodeDoc.doc as { items?: unknown }).items ?? [];
    if (!Array.isArray(listedNodes)) return unknown({ code: 1, stdout: '', stderr: 'printed no node list' }, 'kubectl get nodes');
    // A node the scheduler places no sandbox pod on (cordoned, Not Ready, tainted) is no room, and its pods are not read.
    const refusals = (listedNodes as NodeJson[]).map((node) => ({ node, refusal: nodeRefusal(node ?? {}) }));
    this.#noteNodeRefusals(refusals);
    const nodes = refusals.filter((r) => r.refusal === null).map((r) => r.node);
    for (const node of nodes) {
      const name = node?.metadata?.name;
      const allocatable = Number(node?.status?.allocatable?.pods);
      if (typeof name !== 'string' || !DNS_SUBDOMAIN_RE.test(name) || !Number.isSafeInteger(allocatable) || allocatable < 0) {
        return unknown({ code: 1, stdout: '', stderr: `a node with no name or no allocatable pods: ${JSON.stringify(node?.metadata?.name ?? null)}` }, 'kubectl get nodes');
      }
    }
    // RoomList `cluster`: every bound pod in one list, counted per node here (nodePodCountsOf), for the per-node lists below.
    let counts: Map<string, NodePodCounts> | null = null;
    if (this.roomList === 'cluster' && nodes.length > 0) {
      const what = 'kubectl get pods on every node';
      const listed = await this.listExec(['get', 'pods', '--all-namespaces', '--field-selector', 'spec.nodeName!=', '-o', 'json']);
      if (listed.code !== 0 || listed.error !== undefined) return unknown(listed, what);
      // read off the event loop (ROOM_POD_LIST_KEEP)
      const podDoc = await listDoc(listed, ROOM_POD_LIST_KEEP);
      if ('failed' in podDoc) return unknown({ code: null, stdout: '', stderr: '', error: podDoc.failed }, what);
      const items = 'doc' in podDoc ? (podDoc.doc as { items?: unknown } | null)?.items : undefined;
      if (!Array.isArray(items)) return unknown({ code: 1, stdout: '', stderr: 'printed no pod list' }, what);
      counts = nodePodCountsOf(items, Date.now());
    }
    const rooms: NodeRoom[] = [];
    const memoryMi = new Map<string, number>();
    for (const node of nodes) {
      const name = node.metadata!.name!;
      const allocatable = Number(node.status!.allocatable!.pods);
      const cpu = cpuQuantityMilli(node.status?.allocatable?.cpu);
      const cpuOf = cpu === null ? {} : { cpuMilli: cpu };
      const memory = memoryQuantityMi(node.status?.allocatable?.memory);
      if (memory !== null) memoryMi.set(name, memory);
      const counted = counts === null ? null : (counts.get(name) ?? { used: 0, held: 0, capped: 0 });
      let used: number;
      if (counted !== null) {
        used = counted.used;
      } else {
        const bound = await this.listExec(['get', 'pods', '--all-namespaces', '--field-selector', `spec.nodeName=${name},status.phase!=Succeeded,status.phase!=Failed`, '-o', 'name']);
        if (bound.code !== 0 || bound.error !== undefined) return unknown(bound, `kubectl get pods on node ${name}`);
        used = bound.stdout.split('\n').filter((l) => l.trim() !== '').length;
      }
      const range = podRangeAddresses(node.spec?.podCIDR ?? node.spec?.podCIDRs?.[0]);
      let free = allocatable - used;
      if (range !== null && counted !== null) {
        free = Math.min(free, range - ADDRESS_HEADROOM - used - counted.held);
      } else if (range !== null) {
        const finished = await this.listExec(['get', 'pods', '--all-namespaces', '--field-selector', `spec.nodeName=${name},${FINISHED_WITH_ADDRESS_SELECTOR}`, '-o', 'json']);
        if (finished.code !== 0 || finished.error !== undefined) return unknown(finished, `kubectl get pods on node ${name}`);
        // read off the event loop (POD_LIST_KEEP)
        const finishedDoc = await listDoc(finished, POD_LIST_KEEP);
        if ('failed' in finishedDoc) return unknown({ code: null, stdout: '', stderr: '', error: finishedDoc.failed }, `kubectl get pods on node ${name}`);
        const items = 'doc' in finishedDoc ? (finishedDoc.doc as { items?: unknown } | null)?.items : undefined;
        if (!Array.isArray(items)) return unknown({ code: 1, stdout: '', stderr: 'printed no pod list' }, `kubectl get pods on node ${name}`);
        const now = Date.now();
        const held = (items as FinishedPodJson[]).filter((p) => finishedPodHoldsAddress(p ?? {}, now)).length;
        free = Math.min(free, range - ADDRESS_HEADROOM - used - held);
      }
      const labels = { ...(node.metadata?.labels ?? {}) };
      const cap = this.appNodeSandboxPods;
      if (cap !== null && Object.hasOwn(labels, APP_NODE_LABEL)) {
        // The app node's sandbox cap: every namespace's sandbox pods bound there and not finished, timed ones included,
        // race pods and trial agents not.
        let count: number;
        if (counted !== null) {
          count = counted.capped;
        } else {
          const sandboxes = await this.listExec(['get', 'pods', '--all-namespaces', '-l', CAPPED_SANDBOX_SELECTOR, '--field-selector', `spec.nodeName=${name},status.phase!=Succeeded,status.phase!=Failed`, '-o', 'name']);
          if (sandboxes.code !== 0 || sandboxes.error !== undefined) return unknown(sandboxes, `kubectl get pods -l ${CAPPED_SANDBOX_SELECTOR} on node ${name}`);
          count = sandboxes.stdout.split('\n').filter((l) => l.trim() !== '').length;
        }
        rooms.push({ node: name, labels, free: appNodeCappedRoom(Math.max(0, free), cap, count), uncapped: Math.max(0, free), ...cpuOf });
        continue;
      }
      rooms.push({ node: name, labels, free: Math.max(0, free), ...cpuOf });
    }
    this.#room = { at: Date.now(), nodes: rooms };
    this.#memoryMi = memoryMi;
    this.#roomSeen = rooms;
    this.#roomRefusedAt = null;
    return rooms;
  }

  /**
   * The release's live grader processes now: its own namespace's (ownNamespace) pods labelled `app.kubernetes.io/name=makefun-grader` and
   * Running, one `kubectl get pods -o name` line each (a rollout's draining old graders are live and counted too). A
   * caller's per-process share divides the room read above by it, so the caps are sized from the room each live process
   * can use; null when the read fails or is refused, and the caller then treats the release as one process. Answered
   * from the last read for NODE_ROOM_CACHE_MS, one read at a time (an unknown answer is cached the same way). The
   * namespace's Role grants list on pods (deploy/k8s/base/rbac.yaml), so this needs no cluster-scoped grant.
   */
  runningGraders(): Promise<number | null> {
    const at = Date.now();
    if (this.#graders !== null && at - this.#graders.at < NODE_ROOM_CACHE_MS) return Promise.resolve(this.#graders.value);
    this.#gradersRead ??= this.#readGraders().finally(() => {
      this.#gradersRead = null;
    });
    return this.#gradersRead;
  }

  async #readGraders(): Promise<number | null> {
    const listed = await this.listExec(['-n', this.ownNamespace, 'get', 'pods', '-l', GRADER_POD_SELECTOR, '--field-selector=status.phase=Running', '-o', 'name']);
    if (listed.code !== 0 || listed.error !== undefined) {
      this.#graders = { at: Date.now(), value: null };
      return null;
    }
    const count = listed.stdout.split('\n').filter((l) => l.trim() !== '').length;
    this.#graders = { at: Date.now(), value: count };
    return count;
  }

  /**
   * The sandbox pods this namespace holds now: its pods labelled `makefun.io/role=sandbox` and Running, one `kubectl
   * get pods -o name` line each (every process's pods in the namespace: the graders' program, preflight and race pods,
   * the worker's, an old draining release's among them). nodePodRoom answers only the free places across the nodes, which
   * falls as the fleet fills; a queue's capacity is those free places plus the places this namespace already holds, so
   * it adds this to the room read (free + held) before sizing. A process with a warm pool adds the namespace's Pending
   * pool pods (POOL_ANNOTATION, every grader's: one more JSON list of the Pending sandbox pods, 0 when it fails), which
   * hold their places while their `stage` waits. Null when the read fails or is refused. Answered from
   * the last read for NODE_ROOM_CACHE_MS, one read at a time (an unknown answer is cached the same way). The sandbox
   * namespace's Role grants list on pods (deploy/k8s/sandbox/rbac.yaml), so this needs no cluster-scoped grant.
   */
  sandboxPodsHeld(): Promise<number | null> {
    const at = Date.now();
    if (this.#held !== null && at - this.#held.at < NODE_ROOM_CACHE_MS) return Promise.resolve(this.#held.value);
    this.#heldRead ??= this.#readHeld().finally(() => {
      this.#heldRead = null;
    });
    return this.#heldRead;
  }

  async #readHeld(): Promise<number | null> {
    const listed = await this.listExec(['-n', this.namespace, 'get', 'pods', '-l', `${ROLE_LABEL}=sandbox`, '--field-selector=status.phase=Running', '-o', 'name']);
    if (listed.code !== 0 || listed.error !== undefined) {
      this.#held = { at: Date.now(), value: null };
      return null;
    }
    let count = listed.stdout.split('\n').filter((l) => l.trim() !== '').length;
    // A process with a warm pool counts the warm pools' pods too (the header's Warm pool): each is Pending while its
    // `stage` waits for a run, yet holds its node's place, so the room read beside this would read the budget low.
    if (this.warmPool !== null) count += await this.#readPendingPoolPods();
    this.#held = { at: Date.now(), value: count };
    return count;
  }

  /** The namespace's Pending sandbox pods annotated POOL_ANNOTATION (every grader's warm pools'), or 0 when the read fails. */
  async #readPendingPoolPods(): Promise<number> {
    const pending = await this.listExec(['-n', this.namespace, 'get', 'pods', '-l', `${ROLE_LABEL}=sandbox`, '--field-selector=status.phase=Pending', '-o', 'json']);
    if (pending.code !== 0 || pending.error !== undefined) return 0;
    const read = await listDoc(pending, POD_LIST_KEEP);
    const items = 'doc' in read ? (read.doc as { items?: unknown } | null)?.items : undefined;
    if (!Array.isArray(items)) return 0;
    return (items as Array<{ metadata?: { annotations?: Record<string, unknown> } } | null>).filter((i) => i?.metadata?.annotations?.[POOL_ANNOTATION] !== undefined).length;
  }

  /**
   * The release's live grader pods now, each with its name and whether it is being deleted (a rollout's draining old
   * grader: beingDeleted), from one JSON list of the pods runningGraders counts (GRADER_POD_SELECTOR, Running): what
   * server/pipeline/capacity.ts drainingHoldOf reads to split the pod budget and the trial width over the live graders
   * alone. The burst grader (makefun-grader-burst) carries its own app.kubernetes.io/name and is not listed. A grader
   * pod is a small object and a release runs a handful, so the JSON costs little more than the Table of names; the
   * answer also refreshes runningGraders's cache (the same pods, so the capacity read lists them once). Null when the
   * read fails, is refused or prints no list; answered from the last read for NODE_ROOM_CACHE_MS, one read at a time (an
   * unknown answer is cached the same way), as runningGraders is.
   */
  graderPods(): Promise<readonly GraderPodRead[] | null> {
    const at = Date.now();
    if (this.#graderPods !== null && at - this.#graderPods.at < NODE_ROOM_CACHE_MS) return Promise.resolve(this.#graderPods.value);
    this.#graderPodsRead ??= this.#readGraderPods().finally(() => {
      this.#graderPodsRead = null;
    });
    return this.#graderPodsRead;
  }

  async #readGraderPods(): Promise<readonly GraderPodRead[] | null> {
    const listed = await this.listExec(['-n', this.ownNamespace, 'get', 'pods', '-l', GRADER_POD_SELECTOR, '--field-selector=status.phase=Running', '-o', 'json']);
    const pods = listed.code !== 0 || listed.error !== undefined ? null : graderPodsIn(await listedPodsOffLoop(listed));
    const now = Date.now();
    this.#graderPods = { at: now, value: pods };
    if (pods !== null) this.#graders = { at: now, value: pods.length };
    return pods;
  }

  /**
   * The sandbox pods this namespace holds now (the pods sandboxPodsHeld counts: `makefun.io/role=sandbox`, Running), each
   * with its name and its maker (CREATOR_ANNOTATION, null for none), from one JSON list: what drainingHoldOf reads to
   * find the pods a draining grader still holds. A sandbox pod's JSON is far heavier than its row in a Table of names,
   * so the capacity read asks for it only while a grader drains (server/pipeline/index.ts queueCapacityReader) and
   * counts the held places from it then, in place of sandboxPodsHeld: its answer refreshes sandboxPodsHeld's cache. Null
   * when the read fails, is refused or prints no list; answered from the last read for NODE_ROOM_CACHE_MS, one read at a
   * time (an unknown answer is cached the same way).
   */
  sandboxPodViews(): Promise<readonly SandboxPodRead[] | null> {
    const at = Date.now();
    if (this.#sandboxPods !== null && at - this.#sandboxPods.at < NODE_ROOM_CACHE_MS) return Promise.resolve(this.#sandboxPods.value);
    this.#sandboxPodsRead ??= this.#readSandboxPods().finally(() => {
      this.#sandboxPodsRead = null;
    });
    return this.#sandboxPodsRead;
  }

  async #readSandboxPods(): Promise<readonly SandboxPodRead[] | null> {
    const listed = await this.listExec(['-n', this.namespace, 'get', 'pods', '-l', `${ROLE_LABEL}=sandbox`, '--field-selector=status.phase=Running', '-o', 'json']);
    const pods = listed.code !== 0 || listed.error !== undefined ? null : sandboxPodsIn(await listedPodsOffLoop(listed));
    const now = Date.now();
    this.#sandboxPods = { at: now, value: pods };
    // A pool process's held count adds its Pending pool pods (#readHeld): this Running list alone leaves its cache be.
    if (pods !== null && this.warmPool === null) this.#held = { at: now, value: pods.length };
    return pods;
  }

  /** The cluster could not run the program (K8S_DRIVER_FAILURE with the driver's error): never the program's own 125. */
  isDriverFailure(exit: SandboxExit): boolean {
    return exit.code === K8S_DRIVER_FAILURE && exit.error !== undefined;
  }

  /**
   * Delete `dir`, a tree of this process's own (the header's Scratch): no pod. This process's own directories in it get
   * their owner's rwx back (unlock.ts unlockOwn: the reader's mode-000 placeholders, a directory a program left
   * read-only), then rm. What the unlock or rm still may not touch (EACCES, EPERM, ENOTEMPTY) is another uid's, scratch a
   * sandbox user of the previous pod shape left on the claim: a SandboxError naming `dir`, never a LeftoverError. rm's
   * ENAMETOOLONG (a tree nested past PATH_MAX) and every other failure is the unlock's or rm's own, thrown as it is.
   */
  async removeTree(dir: string): Promise<void> {
    try {
      await this.#unlock(dir);
      await this.#rm(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
      throw new SandboxError(
        `${dir} is not this process's to delete (${(err as Error).message}): scratch a sandbox user of the previous pod shape (uid 65534, on the data claim) left, which only that release's driver or makefun-k8s.sh sweep-old-scratch removes`,
      );
    }
  }

  spawn(spec: SandboxSpec): SandboxProcess {
    return this.#spawn(spec, false);
  }

  /**
   * The one-pod view of this sandbox (K8sOnePodSandbox; the header's One pod): the same context, its preflight,
   * images, networks, reaping and removeTree, with `pods` and a CPU clock of its own. One view a sandbox, made once.
   */
  onePod(): K8sOnePodSandbox {
    this.#onePod ??= new K8sOnePodSandbox(
      {
        base: this,
        ctx: this.#ctx,
        placement: this.placement,
        images: this.images,
        runtimeClass: this.runtimeClass,
        spawnTimed: (spec) => this.#spawn(spec, true),
        timedPlacement: { ...this.placement, nodeSelector: this.timedNodeSelector },
        agent: { check: () => this.agentCheckSpec(), read: () => this.agentSpec() },
        ...(this.appNodeShare === null && this.appNodeSandboxPods === null ? {} : { prefer: (pod: string, trialAgent: boolean) => this.#preferenceFor(pod, trialAgent ? 'agent' : 'program') }),
      },
      null,
    );
    return this.#onePod;
  }

  /**
   * A program's pod (sandboxPodSpec, its trees staged and its writable mounts collected) and its process; a timed one's
   * under the CPU launcher (openCpuClock's sandbox, and the one-pod view's on a clock).
   */
  #spawn(spec: SandboxSpec, timed: boolean): K8sProcess {
    const entry = imageFor(spec.runtime, this.images);
    const name = podName(spec.label);
    const network = spec.network === undefined ? null : checkSandboxNetwork(spec.network);
    const owner = network === null ? null : this.names.ownerOf(network.name);
    // A forwarder's own egress to the gateway (gatewayPolicy, <pod>-llm), which alone selects its pod by POD_LABEL.
    const gateway = isForwarder(network) ? this.llmGateway : null;
    const podOptions = (): SandboxPodOptions => ({
      ...this.placement,
      name,
      image: entry.image,
      digest: spec.imageDigest ?? entry.digest,
      hostAliases: network === null ? [] : this.names.hostAliases(network.name),
      owner,
      ...(timed ? { timed, nodeSelector: this.timedNodeSelector } : {}),
      ...(gateway === null ? {} : { ownPolicy: true }),
      // Every program pod the driver makes is a shim pod (the header's The pod).
      shim: true,
      // A house image's spec runs that image (the header's house image); without them every image spec is refused.
      ...(this.houseImages === null ? {} : { houseImages: this.houseImages }),
    });
    // Built now so a bad spec throws here, as dockerRunArgs does (and so does an agent image not pinned); built again as
    // the pod is made, with the peers registered by then and the agents' peer read then.
    const checked = sandboxPodSpec(spec, { ...podOptions(), agent: this.agentCheckSpec() });
    // A job that took a free place may have left the warm pool over the pod budget: it re-sizes now (k8s-pool.ts).
    this.warmPool?.nudge();
    const mounts = checkSandboxMounts(spec.mounts);
    // What `stage` is sent (/bot, a launcher's /house, every mount, a writable one's seed files with it) and what comes
    // back from `watch` (each writable mount, held to its `returns` as it is).
    const stage = {
      trees: [
        { mount: '/bot', dir: spec.codeDir },
        ...(spec.launcher === undefined ? [] : [{ mount: HOUSE_DIR, dir: spec.launcher.houseDir }]),
        ...mounts.map((m) => ({ mount: m.at, dir: m.host })),
      ],
      collect: mounts.filter((m) => !m.readOnly).map((m) => ({ mount: m.at, dir: m.host, returns: m.returns! })),
    };
    // A launcher pod with no launcher, config or CA would die before `ready`, a void with no reason.
    const missing = houseFilesMissing(spec);
    if (missing.length > 0) throw new SandboxError(`the house ${spec.launcher!.houseDir} lacks ${missing.join(', ')} (launch.ts houseFor, writeHouse)`);
    const marks = objectMarks(name, network, owner);
    // Every pod's Secret, its agents' K first among it (the header's Secret first): made ahead of the pod, in its List.
    const secret = sandboxEnvSecret(spec, { name, namespace: this.namespace, ...marks });
    const refs = [`pod/${name}`, `secret/${secret.metadata.name}`, ...(gateway === null ? [] : [`networkpolicy/${name}${GATEWAY_POLICY_SUFFIX}`])];
    const argv = sandboxProgramArgv(spec, timed);
    const pids = this.runtimeClass === null ? 0 : Number(positiveInt(spec.limits.pids, 'pids')) + POD_OWN_TASKS;
    if (timed && pids !== 0 && pids < TIMED_ROOT_TASKS) {
      throw new SandboxError(`a timed pod's root tasks number ${TIMED_ROOT_TASKS} under its process cap, so its pids must be at least ${TIMED_ROOT_TASKS - POD_OWN_TASKS}, not ${spec.limits.pids}`);
    }
    // An entry's policy wait dials the served peers its hostAliases name: those registered as its pod is made.
    const dials = network !== null && isEntry(network) ? network.name : null;
    let peers: readonly ServedPeer[] = [];
    const pool = this.warmPool;
    // A house image's pod is never a pool's: a pool boots the runtime's image ahead of any spec.
    const shape = pool === null || timed || network !== null || spec.race !== undefined || spec.launcher !== undefined || spec.image !== undefined || spec.reserveCpu === true || isTrialAgentSpec(spec) ? null : this.#poolShapeOf(spec, checked, secret);
    const proc = new K8sProcess(this.#ctx, {
      name,
      refs,
      argv,
      env: checkSandboxSecrets(spec),
      pids,
      mounts,
      stage,
      ...(timed ? { timed } : {}),
      network: network === null ? null : { name: network.name, names: [...(network.aliases ?? []), ...(network.hosts ?? [])], port: servedPort(network) },
      secret,
      objects: async () => {
        const policy = gateway === null ? [] : [gatewayPolicy({ name, namespace: this.namespace, ...marks, addresses: await this.#addressesOf(gateway.host), port: gateway.port })];
        // The drawn placement (the header's Room on the node): never a timed pod's or a forwarder's (its own is fixed),
        // a race pod's the app node (racePodPreference), a trial agent's off it always (trialAgentPreference, and
        // labelled as one), and so a race pod that reserves its CPU (a sweep session's, server/race/runner.ts
        // reservingCpu: about a core for its whole replay), though it keeps the race's labels and is no trial agent;
        // without a share or a cap nothing is awaited, so the pods' creates keep the order they had.
        const drawn = !timed && !isForwarder(network) && (this.appNodeShare !== null || this.appNodeSandboxPods !== null);
        const trialAgent = drawn && isTrialAgentSpec(spec) && spec.image === undefined;
        const kind = spec.race !== undefined ? (spec.reserveCpu === true ? 'agent' : 'race') : trialAgent ? 'agent' : 'program';
        const prefer = drawn ? await this.#preferenceFor(name, kind) : null;
        const agent = await this.agentSpec();
        if (dials !== null) peers = this.names.served(dials);
        return [...policy, sandboxPodSpec(spec, { ...podOptions(), agent, ...(prefer === null ? {} : { prefer }), ...(trialAgent ? { trialAgent } : {}) })];
      },
      ...(dials === null ? {} : { reach: { argv: POLICY_WAIT_ARGV[spec.runtime], peers: () => peers } }),
      ...(pool === null || shape === null ? {} : { warm: { take: () => pool.take(shape), noteBoot: (ms: number) => pool.noteBoot(ms), members: shimMembersOf(checked) } }),
    });
    // Known to meterTree until it exits (its `exited` never rejects: #run turns every throw into a failure).
    this.#live.add(proc);
    void proc.exited.finally(() => this.#live.delete(proc));
    return proc;
  }

  /**
   * A pool-ready spec's warm pool shape (the header's Pool-ready and Warm pool), or null when its pod is not one: its
   * Secret holds anything but K. `checked` and `secret` are its spawn's pod (as built to be checked: no drawn
   * placement) and Secret, keyed by shapeKeyOf; a refill builds the pod again for its own name from the spec with its
   * secrets taken out (a pool keeps nothing of any run: they are the exec's, the header's Exec env), its own placement
   * drawn and the agents' spec read then, as #spawn's `objects` does.
   */
  #poolShapeOf(spec: SandboxSpec, checked: K8sObject, secret: K8sObject): K8sPoolShape | null {
    if (Object.keys((secret.stringData as Record<string, unknown> | undefined) ?? {}).join(',') !== AGENT_KEY_ENV) return null;
    const { secrets: _secrets, ...template } = spec;
    const key = shapeKeyOf(checked, secret);
    const entry = imageFor(template.runtime, this.images);
    const drawn = this.appNodeShare !== null || this.appNodeSandboxPods !== null;
    return {
      key,
      label: template.label,
      build: async (name) => {
        const prefer = drawn ? await this.#preferenceFor(name, 'program') : null;
        const agent = await this.agentSpec();
        const pod = sandboxPodSpec(template, { ...this.placement, name, image: entry.image, digest: template.imageDigest ?? entry.digest, hostAliases: [], owner: null, agent, pool: key, shim: true, ...(prefer === null ? {} : { prefer }) });
        return { pod, secret: sandboxEnvSecret(template, { name, namespace: this.namespace, ...objectMarks(name, null, null) }) };
      },
    };
  }

  /**
   * The drawn placement of untimed pod `pod` (the header's Room on the node): null without an appNodeShare or an
   * appNodeSandboxPods, else drawnNodePreference over the nodes' room now (nodePodRooms: its cache, one read at a time),
   * a read that throws taken as none; with a cap and no share only its `not-app`, never a drawn preference. A race's
   * pod (`race`) takes racePodPreference over the same read instead, with a share or a cap alike: no draw and no cap.
   * A trial agent's (`agent`), and a race pod's that reserves its CPU (SandboxSpec.reserveCpu: a sweep session's), takes
   * trialAgentPreference, with a share or a cap alike: off the app node whatever
   * either says; a read that fails then answers from the last one that did not (#roomSeen), so the agent stays off
   * the app node through a failed read, and only a process that never read the nodes sets it no term.
   */
  async #preferenceFor(pod: string, kind: 'program' | 'race' | 'agent' = 'program'): Promise<NodePreference | null> {
    const share = this.appNodeShare;
    if (share === null && this.appNodeSandboxPods === null) return null;
    let rooms: readonly NodeRoom[] | null;
    try {
      rooms = await this.nodePodRooms();
    } catch {
      rooms = null;
    }
    if (kind === 'race') return racePodPreference(rooms);
    if (kind === 'agent') return trialAgentPreference(rooms ?? this.#roomSeen);
    // A cap without a share draws nothing: the pod is only kept off the app node at its cap.
    if (share === null) return drawnNodePreference(pod, 0, rooms) === 'not-app' ? 'not-app' : null;
    return drawnNodePreference(pod, share, rooms);
  }

  /** A host's addresses, sorted: itself when it is one. */
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
   * Meter `dir` from the `watch` container of the pod that mounts it writable (the header): registered on the latest
   * process of this sandbox's not yet exited whose writable mount `dir` is (K8sProcess.meter), until stop(). Every caller
   * asks right after its spawn. SandboxError, before anything starts, for a `dir` no such process mounts or a malformed
   * argument. `runtime`, `imageDigest` and `label` are the process's own already: the watcher runs in its pod's image.
   */
  meterTree(dir: string, opts: TreeMeterOptions): TreeMeter {
    checkHostPath(dir);
    const proc = [...this.#live].reverse().find((p) => !p.programOver && p.writableAt(dir) !== null);
    if (proc === undefined) {
      throw new SandboxError(`no running program of this sandbox mounts ${dir} writable: a k8s meter runs in the watch container of the pod that mounts it, asked for right after its spawn`);
    }
    return proc.meter(dir, opts);
  }
}
