// The k8s sandbox's recurring list reads (k8s.ts's header, Room on the node) asked of the API server in-process, not of
// a kubectl spawned for each. A grader reads the nodes and the pods bound to each (K8sSandbox.nodePodRooms), its live
// graders (runningGraders) and the sandbox pods its namespace holds (sandboxPodsHeld) every few seconds, idle or not.
// Measured on makefun-prod (2026-11-12): kubectl decodes every pod whole even for `-o name` (0.54 s of CPU for s18's
// 1.07 MB list, about 0.94 s for one room read), so those reads cost a grader about 0.135 cores idle, 17% of its CPU,
// and 0.47 cores a process while jobs wait for room. The same counts asked as a Table (`Accept:
// application/json;as=Table;g=meta.k8s.io;v=v1`, `includeObject=None`: one row of cells per object, 16 KB for s18) cost
// 1.3-1.6 ms each, with the same `list` verbs the Role and node-read.yaml grant already.
//
// apiListExec is a KubectlExec over the API server: it answers the argv shapes of those reads, `[-n <ns>] get
// pods|nodes [--all-namespaces] [-l <sel>] [--field-selector <sel>] -o name|json`, as kubectl would print them (`pod/<name>`
// lines from the Table's first cell; the API server's own JSON list), and hands every other argv to kubectl. A 403 is
// kubectl's `Error from server (Forbidden): <message>` (what K8sSandbox's refusal path reads); a call its budget or its
// signal cut is kubectl's cut (`error`), never sent again. A shed (HTTP 429, or any 5xx: the API server's Priority and
// Fairness rejecting a queued request, its own timeout, etcd's) is a cut too, never handed to kubectl: kubectl's full
// JSON list is the heavier ask of the same congested flow, and its client-go retries a 429 up to ten times itself. The
// shed opens a streak (said once, and once more when a list answers again): no list is asked until its Retry-After
// (APF's: 1 to 32 s) or LIST_SHED_FIRST_MS doubling on each shed in a row, whichever is longer, up to LIST_SHED_MAX_MS;
// meanwhile each list read answers the streak's cut at once, which every caller reads as unknown. Each list asks with
// `timeout=` a little under its budget (listTimeoutParam), so the API server stops a request no one waits for, and
// APF's queue holds it at most a quarter of that before it answers 429 rather than leave the budget to cut it. Any
// other failure (a token or CA that cannot be read, TLS, a connection refused, another status, a body that is no
// list), the in-process client unable to ask, is that one call sent to kubectl, said once until it changes. In a pod
// (KUBERNETES_SERVICE_HOST and _PORT set, no KUBECONFIG, the service-account token mounted: inClusterApiGet) it reads
// the token and CA from the mount on every call, since a projected token rotates. Node's https alone: no client
// library. Each shed answer (a list's, a watch's, an object request's) counts on makefun_k8s_api_sheds_total{resource,code}
// (apiShedCounts, registered with the client's other counters: registerApiClientMetrics), which the Capacity board and
// the k8s-api-sheds rule read.
//
// A `-o json` list is never parsed on the event loop: s18's pod lists run to megabytes, and a JSON.parse of one held a
// grader's and the worker's loop 60-80 ms, twice over (once here to see it is a list, once by the caller to read it).
// projectListBody, run on the off-thread pool (projectListTask, server/offthread), parses the body and hands back only
// the fields a caller reads (ListKeep: the caller's paths into each item), as a ListDoc. apiListExec keeps the doc it
// made with the result (listedDocOf), so the caller that asked under the same keep reads it with no second parse; any
// other list's stdout (kubectl's) is projected by its caller off the loop the same way (listDocOf). The pool saturated
// or failing is the list's cut (`error`), which every caller reads as unknown: never parsed on the loop instead.
//
// watchPod is a sandbox pod's boot read (the pod's IP, or why it will never have one) without a kubectl spawned: in a
// pod, one `watch=true` on the pod by fieldSelector `metadata.name` (the Role's `watch` on pods), over the same
// service-account token and CA as the lists (apiWatch, inClusterApiWatch), its events handed to the caller's verdict
// (`until`: an IP, a stopped container, no room; the driver's, so awaitPod's verdicts stand) and the request closed at
// once after one. A stream the server ends is watched on from its last resourceVersion; a 410 Gone re-lists (a watch
// with none, whose first events are the pod as it is). A shed watch, or any failure of the in-process client, is that
// call's `kubectl wait` instead, said once until it changes, a shed holding in-process watches off as a shed list
// does. Outside a pod (a burst grader's KUBECONFIG, the e2e rig, the tests) it is today's `kubectl wait`, as the lists
// are kubectl's there.
//
// apiCreate is a create asked in-process: a POST of an object's JSON (JSON_TYPE) into its collection, its answer handed
// back as it came. k8s.ts bootAgentPod makes a sandbox pod's `<pod>-env` Secret and then the pod so, over the same
// credentials as apiPatch below (inClusterApiCreate: the pod's own token, else a burst grader's kubeconfig), in place of
// a `kubectl create -f -` spawned for each pod (makefun-prod 2026-11-17: the grader's `created` phase 0.27-0.68 s mean,
// a Go binary started, its config and discovery read, for two POSTs of a few ms); the Role grants `create` on pods,
// secrets and networkpolicies already.
//
// apiPatch is the other write asked in-process: a merge patch (MERGE_PATCH_TYPE) of an object by its path, its answer
// handed back as it came. k8s.ts patchSecretOwner gives a pod's `<pod>-env` Secret its owner so, over the pod's own
// token (inClusterApiPatch), where `kubectl patch` would GET the Secret first: the Role grants secrets only create,
// delete and patch (a get returns the Secret's data), so kubectl's patch failed on every pod. A PATCH needs `patch`
// alone. A burst grader (KUBECONFIG, no service-account token: deploy/k8s/burst/grader-spec.ts) asks it the same
// way over its kubeconfig (kubeconfigApiTarget: the burst API, its CA and makefun-worker's token, read from the
// mounted file on every call, so a renewed token or a moved server is taken at once), as the burst kit's Role is
// create, delete and patch too. Anywhere else it is null and the driver's kubectl patch stands (a kubeconfig with no bearer token, as the
// e2e rig's admin one, a list of kubeconfigs, or one that is not JSON; the tests, which hand the driver a fake).
//
// apiExec is the rest: a KubectlExec that answers in-process, over the same credentials (inClusterApiObjects: the pod's
// own token, else a burst grader's kubeconfig), every other call the driver writes as kubectl's argv (k8s.ts, k8s-network.ts,
// k8s-lanes.ts, the pending room read, the address sweep): an object's GET (`-o json`, a jsonpath of it), a list of
// objects' metadata for a template that reads no more (reap's, the stale sweep's), each DELETE by name or by a label's
// list of names (apiDelete), a delete --raw, the single-object creates (a trial policy, the preflight pod), the server
// version, and listRead's lists through apiListExec; kubectl takes the rest and any call the client cannot ask, said
// once. With the pod watch (processApiWatch, k8s.ts awaitPod) no kubectl runs at all in a grader that can ask in-process.
//
// Every GET, PATCH, POST and DELETE rides a keep-alive agent of apiMaxSockets sockets (the pace's width, 4 to 64), and a
// request's budget (`no answer within`) starts once the agent hands it a socket, never while it waits behind the others
// for one: a final's lock creates and deletes dozens of pods a second, and a budget armed at the call spent itself in
// the client's queue, the request cut as unanswered without ever being sent. The wait for a socket is bounded apart
// (API_SOCKET_WAIT_MS, 15 s: a quarter of a create's budget, so a create unsent at it is re-sent with the rest) and its
// end, like a signal's cut while waiting, is ApiUnsent: an ApiCut known never sent. The
// watch's agent keeps no socket and caps none, so no watch waits for one.
//
// Neither the client's way out is silent (registerApiClientMetrics, on the process's registry from its first apiRequest
// or apiExec, every verb 0 from then, on the thread that serves that registry alone: never an off-thread pool thread's,
// which nothing scrapes): makefun_k8s_api_fallback_total{verb} counts each call apiExec handed kubectl
// (kubectlFallbacks: a grader that asks in-process reads 0, a rise names the verb still spawning kubectl), and
// makefun_k8s_api_unsent_total{verb} each request that waited for a socket and left unsent (apiUnsentRequests, by API
// verb, apiVerbOf: create, delete, get, list, patch), a burst of which is every socket held by a backed-up API server.

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { Agent, request } from 'node:https';
import type { LookupFunction } from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { defineOffThreadTask, inMainThread, runOffThread } from '../../server/offthread/index.ts';
import { sandboxPaceWidthOf } from '../../server/pipeline/capacity.ts';
import type { Registry } from '@prometheus-io/client';
import type { KubectlCallOptions, KubectlExec, KubectlResult, PodJson } from './k8s.ts';

/** Where a pod's service-account token, CA and namespace are mounted. */
export const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** A list as a Table (meta.k8s.io/v1): one row per object, its cells the printer's columns, the name first. */
export const TABLE_ACCEPT = 'application/json;as=Table;g=meta.k8s.io;v=v1';
export const JSON_ACCEPT = 'application/json';

/** One answer of the API server: its status and its body. */
export interface ApiAnswer {
  status: number;
  body: string;
  /** Its Retry-After header, when it sent one (APF's 429 does: whole seconds). */
  retryAfter?: string;
}

/** The least wait after a shed list with no longer Retry-After: doubled for each shed in a row. */
export const LIST_SHED_FIRST_MS = 2_000;
/** The longest wait after a shed list, its Retry-After's included. */
export const LIST_SHED_MAX_MS = 60_000;

/** Whether an answer's status is a shed: 429, or any 5xx. */
export const isShed = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

/** A Retry-After header (delay-seconds or an HTTP-date) in ms from `now`, or 0 when absent or unreadable. */
export function retryAfterMs(value: string | undefined, now: number = Date.now()): number {
  if (value === undefined) return 0;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

/** The wait after the `streak`-th shed in a row (1 the first): its Retry-After or the doubled floor, the longer, capped. */
export function shedWaitMs(streak: number, retryAfter: number, first: number = LIST_SHED_FIRST_MS, max: number = LIST_SHED_MAX_MS): number {
  const floor = first * 2 ** Math.min(Math.max(0, streak - 1), 20);
  return Math.min(max, Math.max(retryAfter, floor));
}

/**
 * The `timeout` query value of a list asked within `budgetMs`: 90% of it in whole seconds, at least one. The API server
 * ends the request there (its request deadline), and APF's queue holds it at most a quarter of that.
 */
export function listTimeoutParam(budgetMs: number): string {
  return `${Math.max(1, Math.floor((budgetMs * 0.9) / 1000))}s`;
}

export interface ApiGetOptions {
  accept: string;
  /** No answer within it: an ApiCut. */
  timeoutMs: number;
  /** Aborting it cuts the request: an ApiCut. */
  signal?: AbortSignal;
}

/** A GET of `path` (with its query) on the API server; throws ApiCut when cut, any other Error when it could not be asked. */
export type ApiGet = (path: string, opts: ApiGetOptions) => Promise<ApiAnswer>;

/** A JSON merge patch's content type (RFC 7386; `kubectl patch --type=merge`'s). */
export const MERGE_PATCH_TYPE = 'application/merge-patch+json';

export interface ApiPatchOptions {
  /** No answer within it: an ApiCut. */
  timeoutMs: number;
  /** Aborting it cuts the request: an ApiCut. */
  signal?: AbortSignal;
}

/**
 * A merge patch (MERGE_PATCH_TYPE) of the object at `path` with `body` (its JSON), answered as JSON; throws ApiCut when
 * cut, any other Error when it could not be asked. Its answer is the caller's to read: any status, as it came.
 */
export type ApiPatch = (path: string, body: string, opts: ApiPatchOptions) => Promise<ApiAnswer>;

/** A JSON body's content type (a create's POST: k8s.ts bootAgentPod). */
export const JSON_TYPE = 'application/json';

/**
 * A create (POST) of the object `body` (its JSON) into the collection at `path` (with its query), answered as JSON;
 * throws ApiCut when cut, any other Error when it could not be asked. Its answer is the caller's to read: any status,
 * as it came.
 */
export type ApiCreate = (path: string, body: string, opts: ApiPatchOptions) => Promise<ApiAnswer>;

/** A request its budget or its signal cut: kubectl's SIGKILL, said the same way, and not asked again. */
export class ApiCut extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCut';
  }
}

/** The API server and the credentials apiGet reads per call. */
export interface ApiTarget {
  host: string;
  port: number;
  /** The bearer token's file, read on every call (unless `credentials` is given). */
  tokenFile: string;
  /** The CA bundle the server's certificate is checked against, read on every call (unless `credentials` is given). */
  caFile: string;
  /**
   * In place of the two files: the token, the CA and (where they moved) the server, read on every call
   * (kubeconfigApiTarget's, from a kubeconfig file).
   */
  credentials?: () => Promise<{ bearer: string; ca: string; host?: string; port?: number }>;
  /** How `host` resolves (default the system's); tests point a name at a local server. */
  lookup?: LookupFunction;
  /** Sockets each keep-alive agent of apiGet, apiPatch, apiCreate and apiDelete holds open at once (default apiMaxSockets()). */
  maxSockets?: number;
  /** The longest a request of theirs waits for a socket before it gives up unsent (default API_SOCKET_WAIT_MS). */
  socketWaitMs?: number;
}

/**
 * GETs on `target`: the token and CA read fresh each call, over one keep-alive agent per CA (a new CA, a new agent),
 * the request destroyed at its budget or its signal.
 */
export function apiGet(target: ApiTarget): ApiGet {
  const ask = apiRequest(target);
  return (path, opts) => ask('GET', path, opts, null);
}

/** Merge patches on `target` (ApiPatch), each asked as apiGet asks: the token and CA read fresh, the budget and signal held. */
export function apiPatch(target: ApiTarget): ApiPatch {
  const ask = apiRequest(target);
  return (path, body, opts) => ask('PATCH', path, { accept: JSON_ACCEPT, ...opts }, { type: MERGE_PATCH_TYPE, body });
}

/** Creates on `target` (ApiCreate), each asked as apiGet asks: the token and CA read fresh, the budget and signal held. */
export function apiCreate(target: ApiTarget): ApiCreate {
  const ask = apiRequest(target);
  return (path, body, opts) => ask('POST', path, { accept: JSON_ACCEPT, ...opts }, { type: JSON_TYPE, body });
}

/** The token, the CA and the server a call on `target` asks with: its credentials', else its two files read now. */
async function targetCredentials(target: ApiTarget): Promise<{ bearer: string; ca: string; host: string; port: number }> {
  if (target.credentials !== undefined) {
    const c = await target.credentials();
    if (c.bearer.trim() === '') throw new Error('the API token is empty');
    return { bearer: c.bearer.trim(), ca: c.ca, host: c.host ?? target.host, port: c.port ?? target.port };
  }
  const [token, ca] = await Promise.all([readFile(target.tokenFile, 'utf8'), readFile(target.caFile, 'utf8')]);
  const bearer = token.trim();
  if (bearer === '') throw new Error(`the service-account token ${target.tokenFile} is empty`);
  return { bearer, ca, host: target.host, port: target.port };
}

/**
 * A delete (DELETE) of the object at `path` (with its query), `body` its DeleteOptions' JSON (null: none sent), answered
 * as JSON; throws ApiCut when cut, any other Error when it could not be asked. Its answer is the caller's to read: any
 * status, as it came.
 */
export type ApiDelete = (path: string, body: string | null, opts: ApiPatchOptions) => Promise<ApiAnswer>;

/** Deletes on `target` (ApiDelete), each asked as apiGet asks: the token and CA read fresh, the budget and signal held. */
export function apiDelete(target: ApiTarget): ApiDelete {
  const ask = apiRequest(target);
  return (path, body, opts) => ask('DELETE', path, { accept: JSON_ACCEPT, ...opts }, body === null ? null : { type: JSON_TYPE, body });
}

/**
 * A request cut before it held a socket (apiRequest): its socket wait ran out (API_SOCKET_WAIT_MS), or its signal cut it
 * while it waited. Nothing of it reached the API server, so a create cut so may be asked again with no object left behind.
 * An ApiCut all the same: every reader of a cut reads it as one.
 */
export class ApiUnsent extends ApiCut {
  readonly unsent = true;
  constructor(message: string) {
    super(message);
    this.name = 'ApiUnsent';
  }
}

/** How apiRequest says a request cut at its budget once sent (an ApiCut): `no answer within <ms> ms`, kubectl's kill's words too. */
export const API_NO_ANSWER_WORDS = 'no answer within';
/** How apiRequest says a request its socket wait ran out on (an ApiUnsent): `no socket to the API server within <ms> ms (all <n> busy): not sent`. */
export const API_NO_SOCKET_WORDS = 'no socket to the API server within';

/**
 * Whether `error` (a KubectlResult's, which carries a cut's words, not its class) says the API server did not answer
 * in time: a request cut at its budget (API_NO_ANSWER_WORDS) or one that never got a socket because every one was held
 * (API_NO_SOCKET_WORDS: ApiUnsent's), both ApiCuts; a reader backing off a slow API server (the address sweep's shed)
 * reads either as one.
 */
export function apiCutSays(error: string): boolean {
  return error.includes(API_NO_ANSWER_WORDS) || error.includes(API_NO_SOCKET_WORDS);
}

/**
 * `one` (a create's POST, asked with what is left of its budget), asked once more should it end known never sent (an
 * ApiUnsent: its socket wait ran out) while `deadline` leaves time and `signal` has not cut it: nothing of it reached
 * the API server, so the re-send can make no second object. A cut once it was sent (a plain ApiCut, its budget or its
 * signal) may have made it and is thrown as it came, never sent again; so is a second ApiUnsent, and a signal's.
 */
export function resentOnceUnsent<T>(one: (timeoutMs: number) => Promise<T>, deadline: number, signal?: AbortSignal): (timeoutMs: number) => Promise<T> {
  let resent = false;
  return async (timeoutMs) => {
    try {
      return await one(timeoutMs);
    } catch (err) {
      if (resent || !(err instanceof ApiUnsent) || signal?.aborted === true) throw err;
      const left = deadline - Date.now();
      if (left <= 0) throw err;
      resent = true;
      return one(left);
    }
  };
}

/** The fewest sockets an apiRequest agent holds open at once to the API server (apiMaxSockets). */
export const API_MIN_SOCKETS = 4;
/** The most sockets an apiRequest agent holds open at once to the API server (apiMaxSockets), whatever the pace's width. */
export const API_MAX_SOCKETS = 64;

/**
 * How many sockets each apiRequest agent (apiGet's, apiPatch's, apiCreate's, apiDelete's) holds open at once: the
 * grader's pace width (capacity.ts sandboxPaceWidthOf: its pod budget, the most pod creates it has in flight), held to
 * API_MIN_SOCKETS..API_MAX_SOCKETS. A final's lock creates a pace's width of pods at once and deletes as many, each a
 * request or three, so fewer sockets than that queue them in the client, unseen by the pace and APF alike.
 */
export function apiMaxSockets(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return Math.min(API_MAX_SOCKETS, Math.max(API_MIN_SOCKETS, sandboxPaceWidthOf(env).width));
}

/**
 * The longest a request waits for one of its agent's sockets (every one busy with the requests before it) before it
 * gives up unsent (ApiUnsent). Its answer's budget (timeoutMs) starts only once it holds one, so a burst queued behind
 * the sockets never spends it waiting; this bound is the wait's own: a socket frees as each request ahead answers or is
 * cut at its own budget, so a request that gets none of its agent's (32 by default, apiMaxSockets) in 15 s finds the API
 * server badly backed up. It is a quarter of a create's budget (k8s.ts KUBECTL_TIMEOUT_MS, 60 s), so a create unsent
 * at it is re-sent (resentOnceUnsent) with the three quarters left: at 60 s, the budget's whole, the first wait spent the
 * deadline and the re-send never had time to run. A target's socketWaitMs overrides it.
 */
export const API_SOCKET_WAIT_MS = 15_000;

/**
 * One request on `target` (apiGet's, apiPatch's, apiCreate's, apiDelete's), its body sent whole with its type and
 * length, over a keep-alive agent of `target.maxSockets` (apiMaxSockets) sockets. Its budget (opts.timeoutMs, `no answer
 * within`) is armed when the agent hands it a socket (a kept one, or a fresh one still to connect, its connect inside
 * the budget), never while it waits for one: that wait is bounded apart (target.socketWaitMs, API_SOCKET_WAIT_MS) and,
 * like a signal's cut before a socket, throws ApiUnsent, the request known never sent.
 */
function apiRequest(target: ApiTarget): (method: 'GET' | 'PATCH' | 'POST' | 'DELETE', path: string, opts: ApiGetOptions, content: { type: string; body: string } | null) => Promise<ApiAnswer> {
  let held: { ca: string; agent: Agent } | null = null;
  const maxSockets = target.maxSockets ?? apiMaxSockets();
  const socketWaitMs = target.socketWaitMs ?? API_SOCKET_WAIT_MS;
  void registerApiClientMetrics();
  return async (method, path, opts, content) => {
    const aborted = (): boolean => opts.signal?.aborted === true;
    if (aborted()) throw new ApiUnsent('cut off');
    const { bearer, ca, host, port } = await targetCredentials(target);
    // A signal that aborted while the credentials were read fires no listener added after: cut here, unsent.
    if (aborted()) throw new ApiUnsent('cut off');
    if (held === null || held.ca !== ca) {
      held?.agent.destroy();
      held = { ca, agent: new Agent({ keepAlive: true, maxSockets, ca }) };
    }
    const agent = held.agent;
    return new Promise<ApiAnswer>((resolve, reject) => {
      let cut: string | null = null;
      let socketed = false;
      let unsent = false;
      let settled = false;
      // The wait for a socket, bounded apart; the answer's budget is armed once the agent hands one over.
      const waiting = setTimeout(() => stop(`${API_NO_SOCKET_WORDS} ${socketWaitMs} ms (all ${maxSockets} busy): not sent`), socketWaitMs);
      waiting.unref();
      let timer: NodeJS.Timeout | null = null;
      const onAbort = (): void => stop('cut off');
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(waiting);
        if (timer !== null) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const fail = (err: Error): void => {
        if (!finish()) return;
        if (cut !== null && unsent) {
          // Queued behind the agent's sockets and left unsent: makefun_k8s_api_unsent_total{verb}.
          const verb = apiVerbOf(method, path);
          UNSENT.set(verb, (UNSENT.get(verb) ?? 0) + 1);
        }
        reject(cut === null ? err : unsent ? new ApiUnsent(cut) : new ApiCut(cut));
      };
      const req = request(
        {
          hostname: host,
          port,
          path,
          method,
          agent,
          headers: {
            accept: opts.accept,
            authorization: `Bearer ${bearer}`,
            ...(content === null ? {} : { 'content-type': content.type, 'content-length': String(Buffer.byteLength(content.body)) }),
          },
          ...(target.lookup === undefined ? {} : { lookup: target.lookup }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (b: Buffer) => chunks.push(b));
          res.on('error', fail);
          res.on('end', () => {
            const retryAfter = res.headers['retry-after'];
            if (finish()) resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), ...(typeof retryAfter === 'string' ? { retryAfter } : {}) });
          });
          res.on('close', () => {
            if (!res.complete) fail(new Error('the API server closed its answer before its end'));
          });
        },
      );
      function stop(why: string): void {
        if (cut === null) {
          cut = why;
          unsent = !socketed;
        }
        req.destroy(new Error(why));
        // Settled now, not at the request's 'error': one destroyed while it waits for a socket emits that only once
        // the agent frees one for it, which may be long after (every socket held by an API server that answers nothing).
        fail(new Error(why));
      }
      req.once('socket', () => {
        if (settled || cut !== null) return;
        socketed = true;
        clearTimeout(waiting);
        timer = setTimeout(() => stop(`${API_NO_ANSWER_WORDS} ${opts.timeoutMs} ms`), opts.timeoutMs);
        timer.unref();
      });
      req.on('error', fail);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (content === null) req.end();
      else req.end(content.body);
    });
  };
}

/**
 * The API server this process's pod reaches with its own service account, as kubectl's in-cluster config finds it:
 * KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT set, no KUBECONFIG (kubectl would read that instead), and the
 * token mounted in `dir`. Null anywhere else (a run from outside the cluster, the e2e rig, k3s from a shell).
 */
export function inClusterApiGet(env: NodeJS.ProcessEnv = process.env, dir: string = SERVICE_ACCOUNT_DIR): ApiGet | null {
  const target = inClusterApiTarget(env, dir);
  return target === null ? null : apiGet(target);
}

/**
 * The merge patches this process asks: with its pod's own service account (inClusterApiTarget), else with the bearer
 * token of its KUBECONFIG (kubeconfigApiTarget: a burst grader's), else null (the driver's kubectl patch).
 */
export function inClusterApiPatch(env: NodeJS.ProcessEnv = process.env, dir: string = SERVICE_ACCOUNT_DIR): ApiPatch | null {
  const target = inClusterApiTarget(env, dir) ?? kubeconfigApiTarget(env);
  return target === null ? null : apiPatch(target);
}

/**
 * The creates this process asks (k8s.ts bootAgentPod's Secret and pod): with its pod's own service account
 * (inClusterApiTarget), else with the bearer token of its KUBECONFIG (kubeconfigApiTarget: a burst grader's), else null
 * (the driver's `kubectl create -f -`).
 */
export function inClusterApiCreate(env: NodeJS.ProcessEnv = process.env, dir: string = SERVICE_ACCOUNT_DIR): ApiCreate | null {
  const target = inClusterApiTarget(env, dir) ?? kubeconfigApiTarget(env);
  return target === null ? null : apiCreate(target);
}

/** A kubeconfig's current context as kubeconfigApiTarget reads it: its server's host and port, its token and CA. */
interface KubeconfigCredentials {
  host: string;
  port: number;
  bearer: string;
  ca: string;
}

/**
 * The current context of a kubeconfig's text: an https:// server, its CA inline (certificate-authority-data) and a
 * bearer token inline (users[].user.token). Anything else (YAML that is not JSON, a client certificate, a CA file, no
 * context) is `{ why }`, saying which.
 */
export function kubeconfigCredentials(text: string): KubeconfigCredentials | { why: string } {
  let doc: {
    clusters?: { name?: unknown; cluster?: { server?: unknown; 'certificate-authority-data'?: unknown } }[];
    users?: { name?: unknown; user?: { token?: unknown } }[];
    contexts?: { name?: unknown; context?: { cluster?: unknown; user?: unknown } }[];
    'current-context'?: unknown;
  };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    return { why: 'it is not JSON' };
  }
  if (doc === null || typeof doc !== 'object') return { why: 'it is no object' };
  const ctx = (Array.isArray(doc.contexts) ? doc.contexts : []).find((c) => c?.name === doc['current-context'])?.context;
  if (ctx === undefined) return { why: 'it has no current context' };
  const cluster = (Array.isArray(doc.clusters) ? doc.clusters : []).find((c) => c?.name === ctx.cluster)?.cluster;
  const user = (Array.isArray(doc.users) ? doc.users : []).find((u) => u?.name === ctx.user)?.user;
  let url: URL;
  try {
    url = new URL(String(cluster?.server));
  } catch {
    return { why: 'its server is no URL' };
  }
  if (url.protocol !== 'https:' || url.pathname.replace(/\/+$/, '') !== '') return { why: 'its server is no https:// API server' };
  const caData = cluster?.['certificate-authority-data'];
  if (typeof caData !== 'string' || caData === '') return { why: 'its cluster has no inline CA' };
  const token = user?.token;
  if (typeof token !== 'string' || token.trim() === '') return { why: 'its user has no bearer token' };
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port === '' ? 443 : Number(url.port),
    bearer: token.trim(),
    ca: Buffer.from(caData, 'base64').toString('utf8'),
  };
}

/**
 * The API server and credentials of KUBECONFIG's current context (kubeconfigCredentials), read from the file on every
 * call: a burst grader's mounted Secret makefun-burst-kubeconfig, whose token `burst up`, extend and the autoscaler
 * renew in place. Null when KUBECONFIG is unset, names more than one file, or the file is missing or not such a kubeconfig now.
 */
export function kubeconfigApiTarget(env: NodeJS.ProcessEnv = process.env, o: { lookup?: LookupFunction } = {}): ApiTarget | null {
  const file = env.KUBECONFIG;
  if (file === undefined || file === '' || file.includes(':')) return null;
  let first: KubeconfigCredentials | { why: string };
  try {
    first = kubeconfigCredentials(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if ('why' in first) return null;
  return {
    host: first.host,
    port: first.port,
    tokenFile: file,
    caFile: file,
    credentials: async () => {
      const c = kubeconfigCredentials(await readFile(file, 'utf8'));
      if ('why' in c) throw new Error(`the kubeconfig ${file} cannot be asked with: ${c.why}`);
      return c;
    },
    ...(o.lookup === undefined ? {} : { lookup: o.lookup }),
  };
}

/** The API server and the service-account credentials inClusterApiGet, inClusterApiPatch, inClusterApiCreate and inClusterApiWatch ask with, or null outside a pod (a burst grader's patch and create: kubeconfigApiTarget). */
export function inClusterApiTarget(env: NodeJS.ProcessEnv = process.env, dir: string = SERVICE_ACCOUNT_DIR): ApiTarget | null {
  if (env.KUBECONFIG !== undefined && env.KUBECONFIG !== '') return null;
  return serviceAccountApiTarget(env, dir);
}

/**
 * The API server of this process's pod with the pod's own service account (the service host and port, the token mounted
 * in `dir`), whatever KUBECONFIG names: `kubectl --kubeconfig=/dev/null`'s in-cluster config (the burst autoscaler's,
 * whose KUBECONFIG is the burst cluster's: deploy/k8s/burst/autoscaler-upkeep.ts). Null outside a pod.
 */
export function serviceAccountApiTarget(env: NodeJS.ProcessEnv = process.env, dir: string = SERVICE_ACCOUNT_DIR): ApiTarget | null {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = Number(env.KUBERNETES_SERVICE_PORT);
  if (host === undefined || host === '' || !Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  const tokenFile = join(dir, 'token');
  if (!existsSync(tokenFile)) return null;
  return { host, port, tokenFile, caFile: join(dir, 'ca.crt') };
}

/** The API server this process asks as its own (apiExec's, the pod watch's): its pod's service account, else its KUBECONFIG's bearer token (a burst grader's), else null. */
export function processApiTarget(env: NodeJS.ProcessEnv = process.env, dir: string = SERVICE_ACCOUNT_DIR): ApiTarget | null {
  return inClusterApiTarget(env, dir) ?? kubeconfigApiTarget(env);
}

/** One list read apiListExec answers: what it asks and how kubectl would print the answer. */
export interface ListRead {
  resource: ListResource;
  path: string;
  accept: string;
  /** `-o name` (a Table, printed by `print`) or `-o json` (the server's list as it sent it, once projectListBody reads one). */
  output: 'name' | 'json';
  /** `-o name`'s lines (null: no list in it); null for `-o json`, whose list is read off the loop (projectListBody). */
  print: ((body: string) => string | null) | null;
}

/** The resources a list read asks for (listRead): the driver's pods, nodes and policies, and the address sweep's CiliumEndpoints. */
export type ListResource = 'pods' | 'nodes' | 'networkpolicies' | 'ciliumendpoints';

/** Each list resource by the words kubectl takes for it: its collection's API prefix, whether it is namespaced, and how `-o name` prints it. */
const LIST_RESOURCES: ReadonlyMap<string, { resource: ListResource; api: string; plural: string; namespaced: boolean; printed: string }> = new Map(
  (
    [
      [['pods'], { resource: 'pods', api: '/api/v1', plural: 'pods', namespaced: true, printed: 'pod' }],
      [['nodes'], { resource: 'nodes', api: '/api/v1', plural: 'nodes', namespaced: false, printed: 'node' }],
      [['networkpolicies', 'networkpolicies.networking.k8s.io'], { resource: 'networkpolicies', api: '/apis/networking.k8s.io/v1', plural: 'networkpolicies', namespaced: true, printed: 'networkpolicy.networking.k8s.io' }],
      [['ciliumendpoints', 'ciliumendpoints.cilium.io'], { resource: 'ciliumendpoints', api: '/apis/cilium.io/v2', plural: 'ciliumendpoints', namespaced: true, printed: 'ciliumendpoint.cilium.io' }],
    ] as const
  ).flatMap(([words, r]) => words.map((w) => [w, r] as const)),
);

/**
 * Whether `doc` is a list the API server answered with no items: an object of a list kind (`PodList`,
 * `PartialObjectMetadataList`, kubectl's `List`) whose `items` is null or absent, as Go writes an empty one. Read as `[]`,
 * as kubectl reads it, never as a body that is no list.
 */
function emptyListOf(doc: unknown): boolean {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const { kind, items } = doc as { kind?: unknown; items?: unknown };
  return typeof kind === 'string' && kind.endsWith('List') && (items === null || items === undefined);
}

/** `-o name` from a Table (cells[0] of each row; none when its rows are null or absent), or from a plain list should the server answer one: `<kind>/<name>` lines. */
function printNames(kind: string, body: string): string | null {
  let doc: { kind?: unknown; rows?: unknown; items?: unknown };
  try {
    doc = JSON.parse(body) as typeof doc;
  } catch {
    return null;
  }
  let names: unknown[];
  if (doc?.kind === 'Table' && Array.isArray(doc.rows)) names = doc.rows.map((r: { cells?: unknown[] } | null) => r?.cells?.[0]);
  else if (doc?.kind === 'Table' && (doc.rows === null || doc.rows === undefined)) names = [];
  else if (Array.isArray(doc?.items)) names = doc.items.map((i: { metadata?: { name?: unknown } } | null) => i?.metadata?.name);
  else if (emptyListOf(doc)) names = [];
  else return null;
  if (!names.every((n): n is string => typeof n === 'string' && n !== '')) return null;
  return names.map((n) => `${kind}/${n}\n`).join('');
}

// ---------------------------------------------------------------- a JSON list, off the loop

/**
 * Paths into a listed object, one per field a caller reads: keys in order, `*` for each element of an array (its keys
 * then apply to every element). A path that ends keeps its value whole.
 */
export type ListKeep = readonly (readonly string[])[];

/**
 * A `-o json` list as projectListBody reads it: `parsed` false when the text is no JSON. Otherwise `doc` is the
 * parsed document cut to what a caller reads: `null` or a primitive as it was; an object as `{ items }` alone (absent
 * when the document has none), `items` an array of each item cut to `keep` (a field a path names copied where it is
 * present: an object or array descended into, anything else as it was), or, when it is no array, as it was. So
 * `doc?.items` and every `item?.a?.b` a path names read as they would on the whole document. A list kind's null or
 * absent `items` (the API server's empty list, emptyListOf) is `{ items: [] }`, `emptied` saying so: kubectl reads it
 * as no items, and prints them as `[]`.
 */
export type ListDoc = { parsed: false } | { parsed: true; doc: unknown; emptied?: true };

type KeepTrie = { [key: string]: KeepTrie } | null;

function keepTrie(keep: ListKeep): KeepTrie {
  const root: { [key: string]: KeepTrie } = {};
  let whole = false;
  for (const path of keep) {
    if (path.length === 0) whole = true;
    let at: { [key: string]: KeepTrie } = root;
    for (let i = 0; i < path.length; i++) {
      const key = path[i]!;
      const last = i === path.length - 1;
      const next = Object.hasOwn(at, key) ? at[key]! : undefined;
      if (last) {
        at[key] = null;
        break;
      }
      if (next === null) break; // a shorter path keeps it whole already
      at = at[key] = next ?? {};
    }
  }
  return whole ? null : root;
}

function project(value: unknown, trie: KeepTrie): unknown {
  if (trie === null || value === null || typeof value !== 'object') return value;
  const keys = Object.keys(trie);
  if (Object.hasOwn(trie, '*')) {
    if (!Array.isArray(value)) return value;
    const each = trie['*']!;
    return value.map((v) => project(v, each));
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = Array.isArray(value) ? ([] as unknown as Record<string, unknown>) : {};
  for (const key of keys) if (Object.hasOwn(src, key)) out[key] = project(src[key], trie[key]!);
  return out;
}

/** A `-o json` list's text read and cut to `keep` (ListDoc). Pure: the off-thread task projectListTask runs it. */
export function projectListBody(input: { body: string; keep: ListKeep }): ListDoc {
  let doc: unknown;
  try {
    doc = JSON.parse(input.body);
  } catch {
    return { parsed: false };
  }
  if (doc === null || typeof doc !== 'object') return { parsed: true, doc };
  if (emptyListOf(doc)) return { parsed: true, doc: { items: [] }, emptied: true };
  if (!Object.hasOwn(doc, 'items')) return { parsed: true, doc: {} };
  const items = (doc as { items: unknown }).items;
  if (!Array.isArray(items)) return { parsed: true, doc: { items } };
  const trie = keepTrie(input.keep);
  return { parsed: true, doc: { items: items.map((item) => project(item, trie)) } };
}

/** projectListBody on the off-thread pool: a list's parse never holds the event loop. */
export const projectListTask = defineOffThreadTask<typeof projectListBody>('k8s.list-project', import.meta.url, 'projectListBody', { timeoutMs: 30_000 });

/** The ListDoc apiListExec made of a result's list, and the keep it was cut to. */
const listedDocs = new WeakMap<KubectlResult, { keep: ListKeep; doc: ListDoc }>();

/** The ListDoc apiListExec made of `result`'s list under `keep` (the same array), or null. */
export function listedDocOf(result: KubectlResult, keep: ListKeep): ListDoc | null {
  const kept = listedDocs.get(result);
  return kept !== undefined && kept.keep === keep ? kept.doc : null;
}

/**
 * `result`'s `-o json` stdout as a ListDoc cut to `keep`: apiListExec's own when it made one under that keep, else
 * projectListBody of it run off the loop. Rejects with the pool's OffThreadError when the pool cannot run it (the
 * caller reads the list as unknown), never parses on the loop.
 */
export async function listDocOf(result: KubectlResult, keep: ListKeep): Promise<ListDoc> {
  return listedDocOf(result, keep) ?? (await runOffThread(projectListTask, { body: result.stdout, keep }));
}

/** A list's items from a ListDoc as `(JSON.parse(stdout) as { items?: unknown } | null)?.items` reads them; undefined for a text that is no JSON. */
export function listItemsOf(listed: ListDoc): unknown {
  return listed.parsed ? (listed.doc as { items?: unknown } | null)?.items : undefined;
}

/**
 * The list read an argv asks for, or null for every argv apiListExec leaves to kubectl: `[-n|--namespace <ns>] get
 * pods|nodes|networkpolicies|ciliumendpoints.cilium.io` with only `--all-namespaces`/`-A`, `-n`/`--namespace` (once, before
 * the verb or among the flags), `-l`/`--selector`, `--field-selector` (each as one word with `=` or as two) and
 * `-o`/`--output` name or json. A namespaced resource needs a namespace or every one; nodes take neither.
 */
export function listRead(args: readonly string[]): ListRead | null {
  let i = 0;
  let namespace: string | null = null;
  if (args[0] === '-n' || args[0] === '--namespace') {
    namespace = args[1] ?? null;
    if (namespace === null || namespace === '') return null;
    i = 2;
  }
  if (args[i] !== 'get') return null;
  const named = LIST_RESOURCES.get(args[i + 1] ?? '');
  if (named === undefined) return null;
  const resource = named.resource;
  let all = false;
  let labels: string | null = null;
  let fields: string | null = null;
  let output: string | null = null;
  for (let j = i + 2; j < args.length; j++) {
    const a = args[j]!;
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const inline = flag === a ? null : a.slice(eq + 1);
    if (flag === '--all-namespaces' || flag === '-A') {
      if (inline !== null) return null;
      all = true;
      continue;
    }
    const value = inline ?? args[++j];
    if (value === undefined) return null;
    if (flag === '-l' || flag === '--selector') labels = value;
    else if (flag === '--field-selector') fields = value;
    else if (flag === '-o' || flag === '--output') output = value;
    else if (flag === '-n' || flag === '--namespace') {
      if (namespace !== null || value === '') return null;
      namespace = value;
    } else return null;
  }
  if (output !== 'name' && output !== 'json') return null;
  let base: string;
  if (!named.namespaced) {
    if (namespace !== null || all) return null;
    base = `${named.api}/${named.plural}`;
  } else if (all) base = `${named.api}/${named.plural}`;
  else if (namespace !== null) base = `${named.api}/namespaces/${encodeURIComponent(namespace)}/${named.plural}`;
  else return null;
  const query = new URLSearchParams();
  if (labels !== null && labels !== '') query.set('labelSelector', labels);
  if (fields !== null && fields !== '') query.set('fieldSelector', fields);
  if (output === 'name') query.set('includeObject', 'None');
  const q = query.toString();
  const kind = named.printed;
  return {
    resource,
    path: q === '' ? base : `${base}?${q}`,
    accept: output === 'name' ? TABLE_ACCEPT : JSON_ACCEPT,
    output,
    print: output === 'name' ? (body) => printNames(kind, body) : null,
  };
}

/** A Status body's message (a refusal's words), else the body's first line. */
function statusMessage(body: string): string {
  try {
    const m = (JSON.parse(body) as { message?: unknown })?.message;
    if (typeof m === 'string' && m !== '') return m;
  } catch {
    // not a Status
  }
  return body.trim().split('\n')[0]?.slice(0, 300) ?? '';
}

export interface ApiListOptions {
  /** A call's budget when it names none (kubectlExec's: KUBECTL_TIMEOUT_MS). */
  timeoutMs: number;
  /** Where a fall back to kubectl, and a shed streak's start and end, are said, once until its reason changes. */
  warn: (line: string) => void;
  /** The clock a shed's wait is timed by (default Date.now). */
  now?: () => number;
  /**
   * What the callers of a `-o json` list read of each item, by resource (ListKeep): the doc apiListExec makes of the
   * list is cut to it and kept with the result (listedDocOf), so the caller reads it with no second parse. None: the
   * list is read whole by its caller (listDocOf), this read only seeing that it is one.
   */
  keep?: Partial<Record<ListRead['resource'], ListKeep>>;
}

/** The keep a list is checked under when its caller named none: nothing of an item. */
const NO_FIELDS: ListKeep = [];

/** What `kubectl get <list> -o json` prints for a list with no items. */
export const EMPTY_LIST_JSON = `${JSON.stringify({ apiVersion: 'v1', items: [], kind: 'List', metadata: { resourceVersion: '' } }, null, 4)}\n`;

/** A KubectlExec that answers the list reads listRead knows from `get` and hands everything else to `kubectl` (the header). */
export function apiListExec(get: ApiGet, kubectl: KubectlExec, opts: ApiListOptions): KubectlExec {
  const now = opts.now ?? Date.now;
  let said: string | null = null;
  // The open shed streak: how many in a row, the first one's words, and when a list is asked again.
  let shed: { streak: number; problem: string; until: number } | null = null;
  const shedCut = (resource: string, problem: string): KubectlResult => ({
    code: null,
    stdout: '',
    stderr: '',
    error: `kubectl get ${resource}: the API server shed the in-process lists (${problem}): none is asked until it may be again`,
  });
  return async (args, call = {}) => {
    const read = call.input === undefined ? listRead(args) : null;
    if (read === null) return kubectl(args, call);
    if (shed !== null && now() < shed.until) return shedCut(read.resource, shed.problem);
    const viaKubectl = (problem: string): Promise<KubectlResult> => {
      if (problem !== said) opts.warn(`k8s sandbox: the API server's list of ${read.resource} could not be read in-process (${problem}): kubectl reads it instead until it can`);
      said = problem;
      return kubectl(args, call);
    };
    const budget = call.timeoutMs ?? opts.timeoutMs;
    const path = `${read.path}${read.path.includes('?') ? '&' : '?'}timeout=${listTimeoutParam(budget)}`;
    let answer: ApiAnswer;
    try {
      answer = await get(path, { accept: read.accept, timeoutMs: budget, ...(call.signal === undefined ? {} : { signal: call.signal }) });
    } catch (err) {
      if (err instanceof ApiCut) return { code: null, stdout: '', stderr: '', error: `kubectl get ${read.resource}: ${err.message}` };
      return viaKubectl((err as Error).message);
    }
    if (isShed(answer.status)) {
      // makefun_k8s_api_sheds_total: every shed answer, where the line below says only a streak's first.
      countApiShed(read.resource, answer.status);
      const problem = `HTTP ${answer.status}: ${statusMessage(answer.body)}`;
      const streak = (shed?.streak ?? 0) + 1;
      const wait = shedWaitMs(streak, retryAfterMs(answer.retryAfter, now()));
      if (shed === null) {
        opts.warn(
          `k8s sandbox: the API server shed the in-process list of ${read.resource} (${problem}${answer.retryAfter === undefined ? '' : `, Retry-After ${answer.retryAfter}`}): no list is asked of it for ${wait} ms, longer while it sheds, and each list read answers unknown meanwhile; kubectl is not asked instead`,
        );
      }
      shed = { streak, problem: shed?.problem ?? problem, until: now() + wait };
      return shedCut(read.resource, shed.problem);
    }
    const answered = (): void => {
      if (shed !== null) opts.warn(`k8s sandbox: the API server answers the in-process lists again, after ${shed.streak} shed in a row`);
      shed = null;
    };
    if (answer.status === 403) {
      answered();
      said = null;
      return { code: 1, stdout: '', stderr: `Error from server (Forbidden): ${statusMessage(answer.body)}\n` };
    }
    if (answer.status !== 200) return viaKubectl(`HTTP ${answer.status}: ${statusMessage(answer.body)}`);
    const noList = (): Promise<KubectlResult> => viaKubectl(`HTTP 200 with no list: ${JSON.stringify(answer.body.slice(0, 120))}`);
    if (read.print !== null) {
      const stdout = read.print(answer.body);
      if (stdout === null) return noList();
      answered();
      said = null;
      return { code: 0, stdout, stderr: '' };
    }
    // -o json: the body is the stdout as kubectl prints it, once the pool has read it as a list (and cut it to the keep)
    const keep = opts.keep?.[read.resource] ?? NO_FIELDS;
    let listed: ListDoc;
    try {
      listed = await runOffThread(projectListTask, { body: answer.body, keep }, call.signal === undefined ? {} : { signal: call.signal });
    } catch (err) {
      return { code: null, stdout: '', stderr: '', error: `kubectl get ${read.resource}: its list could not be read off the event loop (${(err as Error).message})` };
    }
    if (!Array.isArray(listItemsOf(listed))) return noList();
    answered();
    said = null;
    // An empty list the server wrote with null items is printed as kubectl prints one (EMPTY_LIST_JSON), so a reader of
    // the stdout finds `items: []` too.
    const result: KubectlResult = { code: 0, stdout: listed.parsed && listed.emptied === true ? EMPTY_LIST_JSON : answer.body, stderr: '' };
    listedDocs.set(result, { keep, doc: listed });
    return result;
  };
}

// ---------------------------------------------------------------- a pod watched in-process

/** One watch's answer: its status, and a 200's events as they arrive (a non-200's body read whole). */
export interface ApiWatchAnswer {
  status: number;
  /** A non-200's body ('' for a 200, whose body is `lines`). */
  body: string;
  /** Its Retry-After header, when it sent one. */
  retryAfter?: string;
  /** A 200's events, one line of JSON each, until the server ends the stream; throws ApiCut once the signal cuts it. */
  lines: AsyncIterable<string>;
  /** Ends the request at once, its socket destroyed: nothing more is read of it. */
  close(): void;
}

export interface ApiWatchOptions {
  /** No answer's head within it: an ApiCut. The stream after the head stays open until close(), the signal or the server's end. */
  timeoutMs: number;
  /** Aborting it cuts the request, the stream too: an ApiCut. */
  signal?: AbortSignal;
}

/** A streamed GET of `path` (a `watch=true` query) on the API server; throws ApiCut when cut, any other Error when it could not be asked. */
export type ApiWatch = (path: string, opts: ApiWatchOptions) => Promise<ApiWatchAnswer>;

const NO_LINES: AsyncIterable<string> = { [Symbol.asyncIterator]: async function* () {} };

/** `res`'s body cut at each newline, blank lines dropped; a cut of the request thrown as ApiCut, an unfinished body as an Error. */
async function* streamLines(res: IncomingMessage, cutOf: () => string | null, end: () => void): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  try {
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) {
        rest += decoder.write(chunk);
        for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
          const line = rest.slice(0, i).trim();
          rest = rest.slice(i + 1);
          if (line !== '') yield line;
        }
      }
    } catch (err) {
      const cut = cutOf();
      throw cut === null ? err : new ApiCut(cut);
    }
    const cut = cutOf();
    if (cut !== null) throw new ApiCut(cut);
    if (!res.complete) throw new Error('the API server closed the watch before its end');
    const last = (rest + decoder.end()).trim();
    if (last !== '') yield last;
  } finally {
    end();
  }
}

/**
 * Streamed GETs on `target` (a watch): the token and CA read fresh each call as apiGet's are, over an agent per CA that
 * keeps no socket (a watch is closed by destroying it), the request destroyed when its head is late, its signal aborts
 * or the caller closes it.
 */
export function apiWatch(target: ApiTarget): ApiWatch {
  let held: { ca: string; agent: Agent } | null = null;
  return async (path, opts) => {
    if (opts.signal?.aborted === true) throw new ApiCut('cut off');
    const { bearer, ca, host, port } = await targetCredentials(target);
    if (held === null || held.ca !== ca) {
      held?.agent.destroy();
      held = { ca, agent: new Agent({ keepAlive: false, ca }) };
    }
    const agent = held.agent;
    return new Promise<ApiWatchAnswer>((resolve, reject) => {
      let cut: string | null = null;
      let headed = false;
      let ended = false;
      const timer = setTimeout(() => stop(`no answer within ${opts.timeoutMs} ms`), opts.timeoutMs);
      timer.unref();
      const onAbort = (): void => stop('cut off');
      const end = (): void => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const close = (): void => {
        stop('closed');
        end();
      };
      const req = request(
        {
          hostname: host,
          port,
          path,
          method: 'GET',
          agent,
          headers: { accept: JSON_ACCEPT, authorization: `Bearer ${bearer}` },
          ...(target.lookup === undefined ? {} : { lookup: target.lookup }),
        },
        (res) => {
          clearTimeout(timer);
          res.on('error', () => undefined); // what a cut stream throws reaches its reader; none read, it is dropped
          const status = res.statusCode ?? 0;
          const retryAfter = res.headers['retry-after'];
          const head = { status, ...(typeof retryAfter === 'string' ? { retryAfter } : {}) };
          if (status === 200) {
            headed = true;
            resolve({ ...head, body: '', lines: streamLines(res, () => cut, end), close });
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (b: Buffer) => chunks.push(b));
          res.on('end', () => {
            if (headed) return;
            headed = true;
            end();
            resolve({ ...head, body: Buffer.concat(chunks).toString('utf8'), lines: NO_LINES, close });
          });
          res.on('close', () => {
            if (!res.complete) fail(new Error('the API server closed its answer before its end'));
          });
        },
      );
      function fail(err: Error): void {
        if (headed) return;
        headed = true;
        end();
        reject(cut === null ? err : new ApiCut(cut));
      }
      function stop(why: string): void {
        cut ??= why;
        req.destroy(new Error(why));
      }
      req.on('error', fail);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      req.end();
    });
  };
}

/** The watch this process's pod asks with its own service account (inClusterApiTarget), or null outside a pod: watchPod's kubectl wait. */
export function inClusterApiWatch(env: NodeJS.ProcessEnv = process.env, dir: string = SERVICE_ACCOUNT_DIR): ApiWatch | null {
  const target = inClusterApiTarget(env, dir);
  return target === null ? null : apiWatch(target);
}

/** What watchPod needs of the driver's K8sContext (which has each field), and the watch it asks in a pod. */
export interface PodWatchContext {
  namespace: string;
  /** kubectl, for the wait outside a pod (each argv led by `-n <namespace>`, as kubectl() sends it). */
  exec: KubectlExec;
  /** Where a fall back to kubectl, and a shed watch, are said, once until the reason changes. */
  warn: (line: string) => void;
  /** The pace the kubectl calls are shown to, as kubectl() shows an unpaced verb's (a fault it names cuts the pace). */
  pace?: { readonly epoch: number; observe(r: KubectlResult, startedAt: number): void } | null;
  /** The API server's watch, in a pod (inClusterApiWatch); absent or null: kubectl wait. */
  apiWatch?: ApiWatch | null;
}

/** A pod as a watch event or `kubectl get pod -o json` carries it: PodJson, with the name and resourceVersion the watch reads. */
export type WatchedPod = PodJson & { metadata?: { name?: string; resourceVersion?: string } };

/** What watchPod waits on: its verdict over a pod read (an IP, a stopped container, no room: the caller's), or null/undefined to wait on. */
export type PodUntil<T> = (pod: WatchedPod) => T | null | undefined;

/**
 * How watchPod ended: `until`'s verdict over `pod`, the read it answered; the pod deleted or not found (`gone`); or the
 * signal's cut, with the last read of the pod (null: none seen) and, when the last try to read it failed, why (`unread`).
 */
export type PodWatchEnd<T> =
  | { verdict: T; pod: WatchedPod }
  | { gone: string; last: WatchedPod | null }
  | { cut: true; last: WatchedPod | null; unread?: string };

/** The jsonpath watchPod's kubectl wait reads by default: met once the pod has an IP. */
export const POD_IP_JSONPATH = '{.status.podIP}';
/** How long a watch has for its answer's head before kubectl stands in for it. */
export const WATCH_ANSWER_MS = 10_000;
/** One kubectl wait's slice, in seconds, outside a pod: the pod is read and `until` asked between two (awaitPod's WAIT_SLICE_S). */
export const WATCH_WAIT_SLICE_S = 5;
/** The least time between two reads of the pod outside a pod (awaitPod's WAIT_PAUSE_MS). */
export const WATCH_PAUSE_MS = 500;
/** How many watches in a row may end with no event before kubectl stands in for them. */
export const WATCH_EMPTY_ENDS = 2;

export interface WatchPodOptions {
  /** kubectl wait's `--for` outside a pod (default `jsonpath=POD_IP_JSONPATH`). */
  waitFor?: string;
  /** Default WATCH_WAIT_SLICE_S. */
  sliceS?: number;
  /** Default WATCH_PAUSE_MS. */
  pauseMs?: number;
  /** Default WATCH_ANSWER_MS. */
  answerMs?: number;
  /** The clock a shed's hold is timed by (default Date.now). */
  now?: () => number;
  /**
   * The pod as the caller has just read it (a GET, after `until` was asked of it): the watch starts from its
   * resourceVersion, so nothing between that read and the watch is lost and the pod as it was is not handed to `until`
   * again (a 410 Gone re-lists as ever); it is the wait's `last` until an event says more.
   */
  from?: { version: string; pod: WatchedPod };
  /**
   * A fresh read of the pod, asked when a watch's resourceVersion is too old (410 Gone) in place of a re-list, at most
   * WATCH_REREAD_TRIES times a wait: the pod gone ends it so (`gone`), a pod read is handed to `until` and watched
   * from its own resourceVersion, null (it could not be read) re-lists as ever, as do the tries past the last.
   */
  reread?: () => Promise<{ gone: string } | { version: string; pod: WatchedPod } | null>;
}

/** How many times a wait re-reads its pod after a 410 Gone (WatchPodOptions.reread) before it re-lists. */
export const WATCH_REREAD_TRIES = 3;

/** Per watch: the fall back last said (said once until it changes), and the shed streak holding in-process watches off. */
const watchStates = new WeakMap<ApiWatch, { said: string | null; shed: { streak: number; until: number } | null }>();

/** kubectl's words for a call that failed (k8s.ts why's, kept here: this module imports no value of the driver). */
function kubectlSaid(r: KubectlResult): string {
  const said = r.stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('Warning:'));
  return r.error ?? said ?? (r.code === null ? 'no answer' : `exit ${r.code}`);
}

/** How the in-process watch ended: watchPod's end, or why kubectl waits instead (`heldMs`: a shed, in-process watches held off that long). */
type InProcessEnd<T> = { end: PodWatchEnd<T> } | { fallback: string; heldMs?: number };

/**
 * Wait on pod `name` until `until` gives a verdict over it, `signal` cuts the wait, or the pod is gone. In a pod
 * (ctx.apiWatch): one `watch=true` on the pod by fieldSelector `metadata.name` with no resourceVersion, whose first
 * events are the pod as it is (the API server's state, then each change), each handed to `until`; the request closed
 * at once after a verdict. A stream the server ends is watched again from the last resourceVersion seen (bookmarks
 * asked); a 410 Gone (its status or an ERROR event: that version is compacted away) re-lists, a watch again with none.
 * A shed (429, any 5xx) is counted (makefun_k8s_api_sheds_total), said once and holds in-process watches off for its
 * Retry-After or the doubled floor (shedWaitMs), and that call, like any other failure (a token or CA unreadable, TLS,
 * another status, an event that is no JSON, WATCH_EMPTY_ENDS streams in a row with no event), waits by kubectl for
 * the rest. Outside a pod, today's `kubectl wait --for=<waitFor> pod/<name>` in slices, the pod read and `until` asked
 * after each (in a pod, apiExec's polled wait: no kubectl). With opts.from (a read the caller just made) the watch starts
 * at that read's resourceVersion, the read its `last`.
 */
export async function watchPod<T>(ctx: PodWatchContext, name: string, until: PodUntil<T>, signal?: AbortSignal, opts: WatchPodOptions = {}): Promise<PodWatchEnd<T>> {
  const watch = ctx.apiWatch ?? null;
  const seen: { last: WatchedPod | null } = { last: opts.from?.pod ?? null };
  if (watch !== null) {
    const now = opts.now ?? Date.now;
    let state = watchStates.get(watch);
    if (state === undefined) watchStates.set(watch, (state = { said: null, shed: null }));
    if (state.shed === null || now() >= state.shed.until) {
      const r = await watchInProcess(watch, ctx, name, until, signal, opts, seen, state);
      if ('end' in r) {
        if (!('cut' in r.end)) state.said = null;
        return r.end;
      }
      if (r.fallback !== state.said) {
        ctx.warn(
          r.heldMs === undefined
            ? `k8s sandbox: the API server's watch of pod ${name} could not be read in-process (${r.fallback}): kubectl wait stands in for it until it can`
            : `k8s sandbox: the API server shed the in-process watch of pod ${name} (${r.fallback}): kubectl wait stands in for it, and for every pod watch of the next ${r.heldMs} ms, longer while it sheds`,
        );
      }
      state.said = r.fallback;
    }
  }
  return waitByKubectl(ctx, name, until, signal, opts, seen.last);
}

/** Whether `signal` has aborted (a call, not a property read TypeScript narrows across an await). */
const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

async function watchInProcess<T>(
  watch: ApiWatch,
  ctx: PodWatchContext,
  name: string,
  until: PodUntil<T>,
  signal: AbortSignal | undefined,
  opts: WatchPodOptions,
  seen: { last: WatchedPod | null },
  state: { shed: { streak: number; until: number } | null },
): Promise<InProcessEnd<T>> {
  const now = opts.now ?? Date.now;
  const cutEnd = (): InProcessEnd<T> => ({ end: { cut: true, last: seen.last } });
  const shedFallback = async (status: number, problem: string, retryAfter: string | undefined): Promise<InProcessEnd<T>> => {
    countApiShed('pods', status);
    const streak = (state.shed?.streak ?? 0) + 1;
    const heldMs = shedWaitMs(streak, retryAfterMs(retryAfter, now()));
    state.shed = { streak, until: now() + heldMs };
    return { fallback: problem, heldMs };
  };
  let version: string | null = opts.from?.version ?? null;
  let empty = 0;
  let rereads = 0;
  /** A 410 Gone of the watch's resourceVersion: the pod read afresh (opts.reread) and watched from it, else re-listed. */
  const expired = async (): Promise<InProcessEnd<T> | null> => {
    empty = 0;
    if (opts.reread !== undefined && rereads < WATCH_REREAD_TRIES) {
      rereads++;
      const read = await opts.reread();
      if (read !== null && 'gone' in read) return { end: { gone: read.gone, last: seen.last } };
      if (read !== null) {
        seen.last = read.pod;
        const verdict = until(read.pod);
        if (verdict !== null && verdict !== undefined) return { end: { verdict, pod: read.pod } };
        version = read.version;
        return null;
      }
    }
    version = null; // re-list
    return null;
  };
  for (;;) {
    if (aborted(signal)) return cutEnd();
    const query = new URLSearchParams({ fieldSelector: `metadata.name=${name}`, watch: 'true', allowWatchBookmarks: 'true' });
    if (version !== null) query.set('resourceVersion', version);
    let answer: ApiWatchAnswer;
    try {
      answer = await watch(`/api/v1/namespaces/${encodeURIComponent(ctx.namespace)}/pods?${query}`, {
        timeoutMs: opts.answerMs ?? WATCH_ANSWER_MS,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      if (aborted(signal)) return cutEnd();
      return { fallback: (err as Error).message };
    }
    try {
      if (answer.status === 410 && version !== null) {
        const ended = await expired();
        if (ended !== null) return ended;
        continue;
      }
      if (isShed(answer.status)) return await shedFallback(answer.status, `HTTP ${answer.status}: ${statusMessage(answer.body)}`, answer.retryAfter);
      if (answer.status !== 200) return { fallback: `HTTP ${answer.status}: ${statusMessage(answer.body)}` };
      state.shed = null;
      let events = 0;
      let relist = false;
      try {
        for await (const line of answer.lines) {
          events++;
          let event: { type?: unknown; object?: unknown };
          try {
            event = JSON.parse(line) as typeof event;
          } catch {
            return { fallback: `a watch event that is no JSON: ${JSON.stringify(line.slice(0, 120))}` };
          }
          const object = (event?.object ?? null) as (WatchedPod & { code?: unknown; message?: unknown }) | null;
          if (event?.type === 'ERROR') {
            const code = typeof object?.code === 'number' ? object.code : 0;
            const message = typeof object?.message === 'string' ? object.message : 'no message';
            if (code === 410 && version !== null) {
              relist = true;
              break;
            }
            if (isShed(code)) return await shedFallback(code, `an ERROR event ${code}: ${message}`, undefined);
            return { fallback: `an ERROR event ${code}: ${message}` };
          }
          if (object === null || typeof object !== 'object') continue;
          const rv = object.metadata?.resourceVersion;
          if (typeof rv === 'string' && rv !== '') version = rv;
          if (event.type === 'BOOKMARK' || object.metadata?.name !== name) continue;
          if (event.type === 'DELETED') return { end: { gone: `pod ${name} was deleted`, last: seen.last ?? object } };
          if (event.type !== 'ADDED' && event.type !== 'MODIFIED') continue;
          seen.last = object;
          const verdict = until(object);
          if (verdict !== null && verdict !== undefined) return { end: { verdict, pod: object } };
        }
      } catch (err) {
        if (aborted(signal) || err instanceof ApiCut) return cutEnd();
        return { fallback: (err as Error).message };
      }
      if (relist) {
        const ended = await expired();
        if (ended !== null) return ended;
        continue;
      }
      empty = events === 0 ? empty + 1 : 0;
      if (empty >= WATCH_EMPTY_ENDS) return { fallback: `${empty} watches in a row ended with no event` };
    } finally {
      answer.close();
    }
  }
}

/** watchPod outside a pod (or after the watch failed): `kubectl wait` slices, the pod read and `until` asked after each. */
async function waitByKubectl<T>(ctx: PodWatchContext, name: string, until: PodUntil<T>, signal: AbortSignal | undefined, opts: WatchPodOptions, seen: WatchedPod | null): Promise<PodWatchEnd<T>> {
  const sliceS = Math.max(1, Math.floor(opts.sliceS ?? WATCH_WAIT_SLICE_S));
  const pauseMs = opts.pauseMs ?? WATCH_PAUSE_MS;
  const waitFor = `--for=${opts.waitFor ?? `jsonpath=${POD_IP_JSONPATH}`}`;
  const sig = signal === undefined ? {} : { signal };
  const run = async (args: readonly string[], call: KubectlCallOptions): Promise<KubectlResult> => {
    const pace = ctx.pace ?? null;
    const startedAt = pace?.epoch ?? 0;
    const r = await ctx.exec(['-n', ctx.namespace, ...args], call);
    pace?.observe(r, startedAt);
    return r;
  };
  let last = seen;
  let unread: string | undefined;
  const cut = (): PodWatchEnd<T> => ({ cut: true, last, ...(unread === undefined ? {} : { unread }) });
  for (;;) {
    if (aborted(signal)) return cut();
    const started = Date.now();
    await run(['wait', waitFor, `pod/${name}`, `--timeout=${sliceS}s`], { ...sig, timeoutMs: (sliceS + 30) * 1000 });
    if (aborted(signal)) return cut();
    const r = await run(['get', `pod/${name}`, '-o', 'json'], sig);
    if (aborted(signal)) return cut();
    if (r.code === 0 && r.error === undefined) {
      let pod: unknown = null;
      try {
        pod = JSON.parse(r.stdout);
      } catch {
        // said below
      }
      if (pod === null || typeof pod !== 'object') unread = 'kubectl get printed no pod';
      else {
        last = pod as WatchedPod;
        unread = undefined;
        const verdict = until(last);
        if (verdict !== null && verdict !== undefined) return { verdict, pod: last };
      }
    } else if (/\(NotFound\)|not found/i.test(r.stderr)) return { gone: kubectlSaid(r), last };
    else unread = kubectlSaid(r);
    const pause = pauseMs - (Date.now() - started);
    if (pause > 0) {
      try {
        await sleep(pause, undefined, sig);
      } catch {
        return cut();
      }
    }
  }
}

// ---------------------------------------------------------------- the driver's other calls, in-process

/** What apiExec asks the API server with: its reads (lists and objects), its creates and its deletes, over one target. */
export interface ApiObjects {
  get: ApiGet;
  create: ApiCreate;
  delete: ApiDelete;
}

/** apiExec's calls on `target`: its GETs, POSTs and DELETEs, each as apiGet asks (the token and CA read fresh). */
export function apiObjects(target: ApiTarget): ApiObjects {
  return { get: apiGet(target), create: apiCreate(target), delete: apiDelete(target) };
}

/**
 * The calls apiExec asks as this process (processApiTarget): its pod's own service account, else its KUBECONFIG's
 * bearer token (a burst grader's: the burst kit's Role is the home Role's verbs), else null (kubectl's alone: the e2e
 * rig's admin kubeconfig, a run from a shell, the tests).
 */
export function inClusterApiObjects(env: NodeJS.ProcessEnv = process.env, dir: string = SERVICE_ACCOUNT_DIR): ApiObjects | null {
  const target = processApiTarget(env, dir);
  return target === null ? null : apiObjects(target);
}

/**
 * The pod watch this process asks (watchPod's, and the readiness wait's: k8s.ts awaitPod): its pod's own service
 * account, else its KUBECONFIG's bearer token (a burst grader's), else null (kubectl wait). inClusterApiWatch is the
 * first alone.
 */
export function processApiWatch(env: NodeJS.ProcessEnv = process.env, dir: string = SERVICE_ACCOUNT_DIR): ApiWatch | null {
  const target = processApiTarget(env, dir);
  return target === null ? null : apiWatch(target);
}

/** A list of objects' metadata alone (meta.k8s.io/v1 PartialObjectMetadataList): no spec, no status. */
export const METADATA_LIST_ACCEPT = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1';
/** How many times apiExec asks a call the API server shed with a 429 (APF's: never executed), inside its budget, as kubectl's client-go retries one. */
export const OBJECT_SHED_TRIES = 5;
/** The least wait before a shed call is asked again (its Retry-After when longer). */
export const OBJECT_SHED_WAIT_MS = 1_000;

/** A kind apiExec reads, makes or deletes: its group-version, its collection's API prefix and plural, and how kubectl prints it. */
interface ObjectKind {
  kind: string;
  apiVersion: string;
  api: string;
  plural: string;
  printed: string;
}

const POD_KIND: ObjectKind = { kind: 'Pod', apiVersion: 'v1', api: '/api/v1', plural: 'pods', printed: 'pod' };
const SECRET_KIND: ObjectKind = { kind: 'Secret', apiVersion: 'v1', api: '/api/v1', plural: 'secrets', printed: 'secret' };
const POLICY_KIND: ObjectKind = { kind: 'NetworkPolicy', apiVersion: 'networking.k8s.io/v1', api: '/apis/networking.k8s.io/v1', plural: 'networkpolicies', printed: 'networkpolicy.networking.k8s.io' };

/** Each kind by the words kubectl takes for it. */
const OBJECT_KINDS: ReadonlyMap<string, ObjectKind> = new Map([
  ...['pod', 'pods', 'po'].map((w) => [w, POD_KIND] as const),
  ...['secret', 'secrets'].map((w) => [w, SECRET_KIND] as const),
  ...['networkpolicy', 'networkpolicies', 'netpol', 'networkpolicy.networking.k8s.io', 'networkpolicies.networking.k8s.io'].map((w) => [w, POLICY_KIND] as const),
]);

/** The collection of `kind` in `namespace`, or (with `name`) the object. */
function objectPath(kind: ObjectKind, namespace: string, name?: string): string {
  return `${kind.api}/namespaces/${encodeURIComponent(namespace)}/${kind.plural}${name === undefined ? '' : `/${encodeURIComponent(name)}`}`;
}

// ---- a jsonpath template, the part kubectl's `-o jsonpath=` the driver writes

/** One step of a jsonpath: a key, then an index into it (`[N]`), every element (`[*]`), or none. */
type JsonpathStep = { key: string; index: number | '*' | null };
/** A jsonpath template: literal text, a path printed, a range over a path with its body. */
export type JsonpathNode = { text: string } | { path: JsonpathStep[] } | { range: JsonpathStep[]; body: JsonpathNode[] };

const STEP_RE = /^([A-Za-z_$][A-Za-z0-9_$-]*)(?:\[(\d+|\*)\])?$/;

function jsonpathPath(text: string): JsonpathStep[] | null {
  if (text === '.') return [];
  if (!text.startsWith('.')) return null;
  const steps: JsonpathStep[] = [];
  for (const part of text.slice(1).split('.')) {
    const m = STEP_RE.exec(part);
    if (m === null) return null;
    steps.push({ key: m[1]!, index: m[2] === undefined ? null : m[2] === '*' ? '*' : Number(m[2]) });
  }
  return steps;
}

/**
 * A jsonpath template (the text after `jsonpath=`) as kubectl reads the shapes the driver writes: text, `{.a.b[0]}`,
 * `{"…"}` (a quoted string, its escapes read), `{range .items[*]}` … `{end}`. Null for anything else (a filter, a
 * recursive descent, an escaped key, an unclosed range): kubectl's then.
 */
export function parseJsonpath(template: string): JsonpathNode[] | null {
  const root: JsonpathNode[] = [];
  const stack: JsonpathNode[][] = [root];
  let i = 0;
  while (i < template.length) {
    const top = stack.at(-1)!;
    const open = template.indexOf('{', i);
    if (open < 0) {
      top.push({ text: template.slice(i) });
      break;
    }
    if (open > i) top.push({ text: template.slice(i, open) });
    let close: number;
    if (template[open + 1] === '"') {
      let j = open + 2;
      while (j < template.length && template[j] !== '"') j += template[j] === '\\' ? 2 : 1;
      if (template[j + 1] !== '}') return null;
      close = j + 1;
    } else close = template.indexOf('}', open + 1);
    if (close < 0) return null;
    const inner = template.slice(open + 1, close).trim();
    if (inner === 'end') {
      if (stack.length === 1) return null;
      stack.pop();
    } else if (inner.startsWith('range ')) {
      const path = jsonpathPath(inner.slice(6).trim());
      if (path === null) return null;
      const node = { range: path, body: [] as JsonpathNode[] };
      top.push(node);
      stack.push(node.body);
    } else if (inner.startsWith('"')) {
      let text: unknown;
      try {
        text = JSON.parse(inner);
      } catch {
        return null;
      }
      if (typeof text !== 'string') return null;
      top.push({ text });
    } else {
      const path = jsonpathPath(inner);
      if (path === null) return null;
      top.push({ path });
    }
    i = close + 1;
  }
  return stack.length === 1 ? root : null;
}

/** What `steps` select of `data`: none where a key is missing (kubectl get's allowMissingKeys), each element for `[*]`. */
function jsonpathSelect(data: unknown, steps: readonly JsonpathStep[]): unknown[] {
  let at: unknown[] = [data];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const v of at) {
      if (v === null || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, step.key)) continue;
      const got = (v as Record<string, unknown>)[step.key];
      if (step.index === null) next.push(got);
      else if (!Array.isArray(got)) continue;
      else if (step.index === '*') next.push(...got);
      else if (step.index < got.length) next.push(got[step.index]);
    }
    at = next;
  }
  return at;
}

/** A selected value as kubectl prints it: a string as it is, a number or boolean in words, null as nothing, anything else as JSON. */
function jsonpathPrint(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** A template printed over `data` as kubectl prints it: a path's several values a space apart, a range's body once per element. */
export function printJsonpath(nodes: readonly JsonpathNode[], data: unknown): string {
  let out = '';
  for (const node of nodes) {
    if ('text' in node) out += node.text;
    else if ('path' in node) out += jsonpathSelect(data, node.path).map(jsonpathPrint).join(' ');
    else for (const item of jsonpathSelect(data, node.range)) out += printJsonpath(node.body, item);
  }
  return out;
}

/**
 * The metadata paths a list template reads (a ListKeep), when all it reads is each item's `kind` and `metadata`: text,
 * and ranges over `.items[*]` whose bodies are text, `{.kind}` and `{.metadata.…}` paths of plain keys. Null for any
 * other template: it needs the objects whole.
 */
export function metadataTemplateKeep(nodes: readonly JsonpathNode[]): ListKeep | null {
  const keep: string[][] = [];
  let ranges = 0;
  for (const node of nodes) {
    if ('text' in node) continue;
    if ('path' in node) return null;
    if (node.range.length !== 1 || node.range[0]!.key !== 'items' || node.range[0]!.index !== '*') return null;
    ranges++;
    for (const inner of node.body) {
      if ('text' in inner) continue;
      if (!('path' in inner)) return null;
      const steps = inner.path;
      if (steps.some((s) => s.index !== null)) return null;
      if (steps.length === 1 && steps[0]!.key === 'kind') continue;
      if (steps.length < 2 || steps[0]!.key !== 'metadata') return null;
      keep.push(steps.map((s) => s.key));
    }
  }
  return ranges === 0 ? null : keep;
}

// ---- the argv apiExec reads

/** The flags apiExec reads, by kubectl's words for them: those taking a value, and the booleans (`--x` or `--x=<bool>`). */
const VALUE_FLAGS: ReadonlyMap<string, string> = new Map([
  ['-n', 'namespace'],
  ['--namespace', 'namespace'],
  ['-l', 'selector'],
  ['--selector', 'selector'],
  ['-o', 'output'],
  ['--output', 'output'],
  ['-f', 'filename'],
  ['--filename', 'filename'],
  ['--raw', 'raw'],
  ['--grace-period', 'grace-period'],
  ['--for', 'for'],
  ['--timeout', 'timeout'],
]);
const BOOL_FLAGS: ReadonlyMap<string, string> = new Map([
  ['--ignore-not-found', 'ignore-not-found'],
  ['--wait', 'wait'],
  ['--validate', 'validate'],
]);

/** An argv as apiExec reads it: its namespace, verb, words and flags, each flag's own words kept to hand on to kubectl. */
interface Argv {
  namespace: string | null;
  verb: string;
  words: string[];
  flags: ReadonlyMap<string, string>;
  flagWords: ReadonlyArray<{ flag: string; words: readonly string[] }>;
}

function readArgv(args: readonly string[]): Argv | null {
  let i = 0;
  let namespace: string | null = null;
  if (args[0] === '-n' || args[0] === '--namespace') {
    namespace = args[1] ?? null;
    if (namespace === null || namespace === '') return null;
    i = 2;
  }
  const verb = args[i];
  if (verb === undefined || verb.startsWith('-')) return null;
  const words: string[] = [];
  const flags = new Map<string, string>();
  const flagWords: Array<{ flag: string; words: readonly string[] }> = [];
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j]!;
    if (!a.startsWith('-')) {
      words.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const word = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const inline = word === a ? null : a.slice(eq + 1);
    const bool = BOOL_FLAGS.get(word);
    if (bool !== undefined) {
      if (flags.has(bool)) return null;
      flags.set(bool, inline ?? 'true');
      flagWords.push({ flag: bool, words: [a] });
      continue;
    }
    const valued = VALUE_FLAGS.get(word);
    if (valued === undefined) return null;
    const value = inline ?? args[++j];
    if (value === undefined) return null;
    if (valued === 'namespace') {
      if (namespace !== null || value === '') return null;
      namespace = value;
      continue;
    }
    if (flags.has(valued)) return null;
    flags.set(valued, value);
    flagWords.push({ flag: valued, words: inline === null ? [a, value] : [a] });
  }
  return { namespace, verb, words, flags, flagWords };
}

/** The argv of `a` with its words replaced and the flags in `drop` left out: what kubectl is handed for the rest of a call. */
function argvOf(a: Argv, words: readonly string[], drop: ReadonlySet<string> = new Set()): string[] {
  return [...(a.namespace === null ? [] : ['-n', a.namespace]), a.verb, ...words, ...a.flagWords.filter((f) => !drop.has(f.flag)).flatMap((f) => f.words)];
}

/** Whether `a` names only flags in `allowed`. */
const onlyFlags = (a: Argv, allowed: readonly string[]): boolean => [...a.flags.keys()].every((f) => allowed.includes(f));

/** One object a call names: its kind, its name, and the word that named it (`pod/<name>`). */
interface ObjectRef {
  kind: ObjectKind;
  name: string;
  word: string;
}

function objectRef(word: string): ObjectRef | null {
  const slash = word.indexOf('/');
  if (slash <= 0) return null;
  const kind = OBJECT_KINDS.get(word.slice(0, slash));
  const name = word.slice(slash + 1);
  return kind === undefined || name === '' || name.includes('/') ? null : { kind, name, word };
}

function kindsOf(word: string | undefined): ObjectKind[] | null {
  if (word === undefined || word === '') return null;
  const kinds = word.split(',').map((w) => OBJECT_KINDS.get(w));
  return kinds.every((k): k is ObjectKind => k !== undefined) ? kinds : null;
}

/** A delete's options from its flags: the grace (`--grace-period`, a whole number from 1), whether NotFound is fine, `-o name`; null for any other. */
function deleteFlags(a: Argv, pods: boolean): { grace: number | null; ignore: boolean; names: boolean } | null {
  const output = a.flags.get('output');
  if (output !== undefined && output !== 'name') return null;
  const ignore = a.flags.get('ignore-not-found') ?? 'false';
  if (ignore !== 'true' && ignore !== 'false') return null;
  const wait = a.flags.get('wait');
  // kubectl's own default waits for a pod to be gone; only a delete that waits for nothing is answered here.
  if (wait !== undefined ? wait !== 'false' : pods) return null;
  const g = a.flags.get('grace-period');
  let grace: number | null = null;
  if (g !== undefined) {
    if (!/^\d{1,6}$/.test(g) || Number(g) < 1) return null;
    grace = Number(g);
  }
  return { grace, ignore: ignore === 'true', names: output === 'name' };
}

/** What apiExec answers of a call: none (the lists, then kubectl, take it), or one of its shapes. */
type ExecPlan =
  | { op: 'get'; ref: ObjectRef; jsonpath: JsonpathNode[] | null }
  | { op: 'metadata'; kinds: ObjectKind[]; selector: string | null; template: JsonpathNode[]; keep: ListKeep }
  | { op: 'delete'; refs: ObjectRef[]; flags: NonNullable<ReturnType<typeof deleteFlags>> }
  | { op: 'delete-selected'; kinds: ObjectKind[]; selector: string; flags: NonNullable<ReturnType<typeof deleteFlags>> }
  | { op: 'delete-raw'; path: string; body: string }
  | { op: 'create'; kind: ObjectKind; name: string; body: string }
  | { op: 'wait'; ref: ObjectRef; met: (pod: unknown) => boolean; waitMs: number }
  | { op: 'version' };

/**
 * What a `kubectl wait --for=<for>` waits for, as a test of the pod read: `condition=<type>[=<status>]` (the condition
 * of that type with that status, True by default, as kubectl compares it, case aside), `jsonpath=<template>[=<value>]`
 * (the template printed over the pod non-empty, or that value). Null for anything else (`delete`, a template
 * parseJsonpath does not read): kubectl's.
 */
export function waitTest(spec: string): ((pod: unknown) => boolean) | null {
  if (spec.startsWith('condition=')) {
    const [type, want = 'True', ...more] = spec.slice('condition='.length).split('=');
    if (type === undefined || type === '' || more.length > 0) return null;
    return (pod) => {
      const conditions = (pod as { status?: { conditions?: unknown } } | null)?.status?.conditions;
      return Array.isArray(conditions) && conditions.some((c: { type?: unknown; status?: unknown } | null) => c?.type === type && typeof c.status === 'string' && c.status.toLowerCase() === want.toLowerCase());
    };
  }
  if (spec.startsWith('jsonpath=')) {
    const m = /^(\{.*\})(?:=(.*))?$/.exec(spec.slice('jsonpath='.length));
    const nodes = m === null ? null : parseJsonpath(m[1]!);
    if (m === null || nodes === null) return null;
    const want = m[2];
    return (pod) => {
      const printed = printJsonpath(nodes, pod);
      return want === undefined ? printed !== '' : printed === want;
    };
  }
  return null;
}

/** The plan of an argv (and its stdin), or null: every argv apiExec leaves to the lists and to kubectl. */
export function execPlan(args: readonly string[], input: string | undefined): ExecPlan['op'] | null {
  return planOf(args, input)?.plan.op ?? null;
}

function planOf(args: readonly string[], input: string | undefined): { argv: Argv; plan: ExecPlan } | null {
  const a = readArgv(args);
  if (a === null) return null;
  const plan = ((): ExecPlan | null => {
    if (a.verb === 'version') return a.words.length === 0 && onlyFlags(a, ['output']) && a.flags.get('output') === 'json' && input === undefined ? { op: 'version' } : null;
    if (a.verb === 'delete' && a.flags.has('raw')) {
      const path = a.flags.get('raw')!;
      if (a.words.length !== 0 || !onlyFlags(a, ['raw', 'filename']) || a.flags.get('filename') !== '-' || input === undefined || !path.startsWith('/') || /[?#\s]/.test(path)) return null;
      return { op: 'delete-raw', path, body: input };
    }
    if (a.namespace === null) return null;
    if (a.verb === 'get') {
      if (a.words.length !== 1 || !onlyFlags(a, ['output', 'selector']) || input !== undefined) return null;
      const output = a.flags.get('output');
      if (output === undefined) return null;
      const ref = objectRef(a.words[0]!);
      if (ref !== null) {
        if (a.flags.has('selector')) return null;
        if (output === 'json') return { op: 'get', ref, jsonpath: null };
        const jsonpath = output.startsWith('jsonpath=') ? parseJsonpath(output.slice('jsonpath='.length)) : null;
        return jsonpath === null ? null : { op: 'get', ref, jsonpath };
      }
      const kinds = kindsOf(a.words[0]);
      if (kinds === null || !output.startsWith('jsonpath=')) return null;
      const template = parseJsonpath(output.slice('jsonpath='.length));
      const keep = template === null ? null : metadataTemplateKeep(template);
      return template === null || keep === null ? null : { op: 'metadata', kinds, selector: a.flags.get('selector') ?? null, template, keep };
    }
    if (a.verb === 'delete') {
      if (input !== undefined || !onlyFlags(a, ['ignore-not-found', 'grace-period', 'wait', 'output', 'selector'])) return null;
      const selector = a.flags.get('selector');
      if (selector !== undefined) {
        const kinds = a.words.length === 1 ? kindsOf(a.words[0]) : null;
        const flags = kinds === null || selector === '' ? null : deleteFlags(a, kinds.includes(POD_KIND));
        return kinds === null || flags === null ? null : { op: 'delete-selected', kinds, selector: selector!, flags };
      }
      const refs = a.words.map(objectRef);
      if (refs.length === 0 || !refs.every((r): r is ObjectRef => r !== null)) return null;
      const flags = deleteFlags(a, refs.some((r) => r.kind === POD_KIND));
      return flags === null ? null : { op: 'delete', refs, flags };
    }
    if (a.verb === 'wait') {
      const ref = a.words.length === 1 ? objectRef(a.words[0]!) : null;
      const spec = a.flags.get('for');
      const timeout = /^(\d{1,5})s$/.exec(a.flags.get('timeout') ?? '');
      if (ref === null || ref.kind !== POD_KIND || spec === undefined || timeout === null || !onlyFlags(a, ['for', 'timeout']) || input !== undefined) return null;
      const met = waitTest(spec);
      return met === null ? null : { op: 'wait', ref, met, waitMs: Number(timeout[1]) * 1000 };
    }
    if (a.verb === 'create') {
      if (a.words.length !== 0 || !onlyFlags(a, ['filename', 'validate']) || a.flags.get('filename') !== '-' || a.flags.get('validate') !== 'false' || input === undefined) return null;
      let obj: { apiVersion?: unknown; kind?: unknown; metadata?: { name?: unknown; namespace?: unknown } } | null;
      try {
        obj = JSON.parse(input) as typeof obj;
      } catch {
        return null;
      }
      const kind = [POD_KIND, SECRET_KIND, POLICY_KIND].find((k) => k.kind === obj?.kind && k.apiVersion === obj?.apiVersion);
      const name = obj?.metadata?.name;
      const ns = obj?.metadata?.namespace;
      if (kind === undefined || typeof name !== 'string' || name === '' || (ns !== undefined && ns !== a.namespace)) return null;
      return { op: 'create', kind, name, body: input };
    }
    return null;
  })();
  return plan === null ? null : { argv: a, plan };
}

/** A Status body's reason and message (each '' when it has none). */
function statusOf(body: string): { reason: string; message: string } {
  try {
    const doc = JSON.parse(body) as { reason?: unknown; message?: unknown } | null;
    return { reason: typeof doc?.reason === 'string' ? doc.reason : '', message: typeof doc?.message === 'string' ? doc.message.slice(0, 600) : '' };
  } catch {
    return { reason: '', message: '' };
  }
}

/** An answer the API server refused, as kubectl prints it: `Error from server (<reason>): <message>`, the HTTP status where the body says neither. */
export function serverSaid(answer: { status: number; body: string }, doing = ''): string {
  const { reason, message } = statusOf(answer.body);
  return `Error from server (${reason === '' ? `HTTP ${answer.status}` : reason}): ${doing}${message === '' ? `HTTP ${answer.status}` : message}`;
}

/** The second-last step of an object's path (its resource's plural): what a shed is counted under. */
function resourceOfPath(path: string): string {
  const steps = path.split('?')[0]!.split('/').filter((s) => s !== '');
  return steps.at(-2) ?? 'raw';
}

/**
 * `ask` within the budget to `deadline`: a shed answer counted (makefun_k8s_api_sheds_total), a 429 asked again after
 * OBJECT_SHED_WAIT_MS or its Retry-After, whichever is longer, up to OBJECT_SHED_TRIES times while the budget lasts
 * (kubectl's client-go retries one so); any other answer as it came. Throws ApiCut once the budget or the signal cuts it.
 */
async function askShedRetried(ask: (timeoutMs: number) => Promise<ApiAnswer>, resource: string, budgetMs: number, deadline: number, signal: AbortSignal | undefined): Promise<ApiAnswer> {
  for (let tries = 1; ; tries++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new ApiCut(`no answer within ${budgetMs} ms`);
    const answer = await ask(left);
    if (!isShed(answer.status)) return answer;
    countApiShed(resource, answer.status);
    if (answer.status !== 429 || tries >= OBJECT_SHED_TRIES) return answer;
    const wait = Math.max(OBJECT_SHED_WAIT_MS, retryAfterMs(answer.retryAfter));
    if (Date.now() + wait >= deadline) return answer;
    try {
      await sleep(wait, undefined, signal === undefined ? undefined : { signal });
    } catch {
      throw new ApiCut('cut off');
    }
  }
}

/** The Table's names (cells[0] of each row, or a plain list's items' names), or null when it is no list of names. */
function tableNames(body: string): string[] | null {
  const printed = printNames('x', body);
  return printed === null ? null : printed.split('\n').filter((l) => l !== '').map((l) => l.slice(2));
}

/** How often apiExec's `wait` reads the pod while its condition is not met. */
export const WAIT_POLL_MS = 1_000;

/** The verb of an argv (after a leading `-n <ns>`): what a kubectl fall back is counted under. */
function verbOf(args: readonly string[]): string {
  return (args[0] === '-n' || args[0] === '--namespace' ? args[2] : args[0]) ?? '';
}

/** Every argv every apiExec of this process handed kubectl, by verb (kubectlFallbacks). */
const FALLBACKS = new Map<string, number>();

/**
 * How many calls apiExec handed kubectl in this process, by verb: one it has no in-process form of, or one the client
 * could not ask. A grader that can ask in-process should read none; a count that grows names what still spawns kubectl.
 */
export function kubectlFallbacks(): Record<string, number> {
  return Object.fromEntries(FALLBACKS);
}

// ---- the client's own counts on the process's registry (registerApiClientMetrics) ----------------------------------

/**
 * The client's counters' names: kubectl's fall backs (kubectlFallbacks), the requests that left unsent
 * (apiUnsentRequests) and the answers the API server shed (apiShedCounts).
 */
export const API_CLIENT_METRICS = Object.freeze({
  fallback: 'makefun_k8s_api_fallback_total',
  unsent: 'makefun_k8s_api_unsent_total',
  sheds: 'makefun_k8s_api_sheds_total',
});

/** The kubectl verbs apiExec answers in-process: makefun_k8s_api_fallback_total's series, every one 0 from its registration. */
export const API_FALLBACK_VERBS = Object.freeze(['create', 'delete', 'get', 'version', 'wait'] as const);
/** The API verbs apiRequest asks (apiVerbOf): makefun_k8s_api_unsent_total's series, every one 0 from its registration. */
export const API_UNSENT_VERBS = Object.freeze(['create', 'delete', 'get', 'list', 'patch'] as const);

/** Every request of this process that left an apiRequest agent's queue unsent, by API verb (apiUnsentRequests). */
const UNSENT = new Map<string, number>();

/**
 * How many requests of this process waited for one of their agent's sockets and left unsent (ApiUnsent), by API verb
 * (apiVerbOf): the socket wait run out, or a signal's cut while it waited. A request its signal had cut before it was
 * handed to the agent (an ApiUnsent too, never queued) is no count: it is the caller's cut, not the agent's backlog.
 */
export function apiUnsentRequests(): Record<string, number> {
  return Object.fromEntries(UNSENT);
}

/** A shed answer's code label: 429, or any 5xx. */
export type ApiShedCode = '429' | '5xx';

/** Every answer of this process the API server shed (isShed), by resource and code (apiShedCounts), keyed `<resource> <code>`. */
const SHEDS = new Map<string, { resource: string; code: ApiShedCode; count: number }>();

/**
 * Count one answer the API server shed (`status`: 429, or a 5xx) of a read or request on `resource` (pods, nodes, the
 * object's): a list's (apiListExec), a pod watch's (watchPod) or an object request's (askShedRetried). Kept here and
 * read at every scrape (registerApiClientMetrics, makefun_k8s_api_sheds_total), so counting loads nothing and costs the
 * shed path no await. Never throws.
 */
function countApiShed(resource: string, status: number): void {
  const code: ApiShedCode = status === 429 ? '429' : '5xx';
  const key = `${resource} ${code}`;
  const was = SHEDS.get(key);
  if (was === undefined) SHEDS.set(key, { resource, code, count: 1 });
  else was.count++;
  void registerApiClientMetrics();
}

/**
 * How many answers of this process the API server shed (HTTP 429, or any 5xx), by resource and code, in the order each
 * was first counted: what makefun_k8s_api_sheds_total{resource,code} reads.
 */
export function apiShedCounts(): { resource: string; code: ApiShedCode; count: number }[] {
  return [...SHEDS.values()].map((s) => ({ ...s }));
}

/**
 * The API verb of a request apiRequest asks: POST create, PATCH patch, DELETE delete, a GET of a collection list (the
 * path's steps after `/api/<v>` or `/apis/<group>/<v>` one resource, or `namespaces/<ns>/<resource>`), any other GET get.
 */
export function apiVerbOf(method: string, path: string): string {
  if (method === 'POST') return 'create';
  if (method === 'PATCH') return 'patch';
  if (method === 'DELETE') return 'delete';
  const steps = path.split('?')[0]!.split('/').filter((s) => s !== '');
  const rest = steps[0] === 'api' ? steps.slice(2) : steps[0] === 'apis' ? steps.slice(3) : [];
  return rest.length === 1 || (rest.length === 3 && rest[0] === 'namespaces') ? 'list' : 'get';
}

/** A verb as a label: a word of the driver's (kubectl's verbs, the API's), anything else `other`. */
const verbLabel = (verb: string): string => (/^[a-z][a-z-]{0,23}$/.test(verb) ? verb : 'other');

/** `counts` by label, every one of `zero` present (0 when none counted). */
function seriesOf(zero: readonly string[], counts: ReadonlyMap<string, number>): Map<string, number> {
  const series = new Map<string, number>(zero.map((v) => [v, 0]));
  for (const [verb, n] of counts) {
    const label = verbLabel(verb);
    series.set(label, (series.get(label) ?? 0) + n);
  }
  return series;
}

/** The process registry's registration, once a thread (registerApiClientMetrics with no registry). */
let processRegistration: Promise<void> | null = null;

/** Where registerApiClientMetrics' failure is said: opts.warn, else console.warn; never throws. */
function sayUnregistered(warn: ((line: string) => void) | undefined, err: unknown): void {
  try {
    (warn ?? console.warn)(`k8s sandbox: the API client's metrics could not be registered (its fall backs and unsent requests go uncounted): ${err instanceof Error ? err.message : String(err)}`);
  } catch {
    // Said or not, only the metrics are lost.
  }
}

/**
 * Register the client's counters on `opts.registry`, or with none on the process's (server/ops/metrics.ts
 * metricsRegistry, where the sandbox pace's are), each read from this module's counts at every scrape, every verb of
 * its list 0 from the start and the counts taken before it registered in it at once:
 *   makefun_k8s_api_fallback_total{verb}   calls apiExec handed kubectl (kubectlFallbacks), by kubectl verb: one it has
 *                                          no in-process form of, or one the client could not ask (API_FALLBACK_VERBS,
 *                                          and any other verb as it is counted); a grader that asks in-process reads 0
 *   makefun_k8s_api_unsent_total{verb}     requests that waited for a socket and left unsent (apiUnsentRequests), by API
 *                                          verb (API_UNSENT_VERBS): every socket held, the API server backed up
 *   makefun_k8s_api_sheds_total{resource,code}  answers the API server shed (apiShedCounts), by resource and code
 *                                          (429 | 5xx), each label pair from its first count: a list answered
 *                                          unknown (its streak cutting the next until its wait ends), a pod watch
 *                                          handed to `kubectl wait`, an object request asked again (a 429) or
 *                                          answered as it came
 * Called by every apiRequest and apiExec made and by every shed counted, so a process that asks in-process shows the
 * three from its first client. On the process's registry only through metrics.ts onScrapedRegistry: registered on the
 * thread that serves it (its main thread, once startMetricsServer listens). On any other thread (an off-thread pool thread: projectListTask's import
 * this module) it does nothing and imports nothing, so a thread never loads metrics.ts (its default collectors
 * started for series nobody scrapes) for a client it builds. Never rejects: a failure is said (opts.warn, else
 * console.warn) and drops only the metrics.
 */
export function registerApiClientMetrics(opts: { registry?: Registry; warn?: (line: string) => void } = {}): Promise<void> {
  if (opts.registry === undefined) return (processRegistration ??= registerOnScraped(opts.warn));
  const registry = opts.registry;
  return import('@prometheus-io/client').then(
    ({ Counter }) => registerOn(registry, Counter, opts.warn),
    (err: unknown) => sayUnregistered(opts.warn, err),
  );
}

/**
 * The process's registration: handed to metrics.ts onScrapedRegistry, run on the thread that serves the registry alone;
 * off the main thread nothing (no thread serves it, and none loads metrics.ts: server/offthread inMainThread).
 */
async function registerOnScraped(warn: ((line: string) => void) | undefined): Promise<void> {
  if (!inMainThread) return;
  try {
    const [{ onScrapedRegistry }, { Counter }] = await Promise.all([import('../../server/ops/metrics.ts'), import('@prometheus-io/client')]);
    onScrapedRegistry((registry) => registerOn(registry, Counter, warn));
  } catch (err) {
    sayUnregistered(warn, err);
  }
}

function registerOn(registry: Registry, Counter: typeof import('@prometheus-io/client').Counter, warn: ((line: string) => void) | undefined): void {
  try {
    if (registry.getSingleMetric(API_CLIENT_METRICS.fallback) !== undefined) return;
    new Counter({
      name: API_CLIENT_METRICS.sheds,
      help: 'Answers the API server shed to the in-process client (HTTP 429, or any 5xx: Priority and Fairness, its own timeout, etcd), by resource (pods, nodes, an object request\'s) and code (429 | 5xx): a list answered unknown, a pod watch handed to kubectl wait, an object request asked again (a 429) or answered as it came.',
      labelNames: ['resource', 'code'] as const,
      registers: [registry],
      collect() {
        this.reset();
        for (const { resource, code, count } of SHEDS.values()) this.inc({ resource, code }, count);
      },
    });
    new Counter({
      name: API_CLIENT_METRICS.fallback,
      help: 'Calls the in-process API client handed kubectl, by kubectl verb: one with no in-process form, or one the client could not ask (a token or CA unread, TLS, a refused connection). A grader that asks in-process reads 0.',
      labelNames: ['verb'] as const,
      registers: [registry],
      collect() {
        this.reset();
        for (const [verb, n] of seriesOf(API_FALLBACK_VERBS, FALLBACKS)) this.inc({ verb }, n);
      },
    });
    new Counter({
      name: API_CLIENT_METRICS.unsent,
      help: "In-process API requests that waited for one of their agent's sockets and left unsent (ApiUnsent: the socket wait ran out, or a cut while waiting), by API verb (create, delete, get, list, patch): every socket held by an API server backed up.",
      labelNames: ['verb'] as const,
      registers: [registry],
      collect() {
        this.reset();
        for (const [verb, n] of seriesOf(API_UNSENT_VERBS, UNSENT)) this.inc({ verb }, n);
      },
    });
  } catch (err) {
    sayUnregistered(warn, err);
  }
}

export interface ApiExecOptions {
  /** A call's budget when it names none (kubectlExec's: KUBECTL_TIMEOUT_MS). */
  timeoutMs: number;
  /** Told of every argv handed to kubectl (beside kubectlFallbacks' count): its verb and the argv. */
  onKubectl?: (verb: string, args: readonly string[]) => void;
  /** Where a call handed to kubectl is said, once until its reason changes. */
  warn: (line: string) => void;
  /** The list reads' keep (apiListExec's ApiListOptions.keep). */
  keep?: ApiListOptions['keep'];
  /** The clock the lists' shed hold is timed by (default Date.now). */
  now?: () => number;
}

/**
 * A KubectlExec that asks the API server in-process (`api`) what the driver asks kubectl, as kubectl would print the
 * answer, and hands everything else to `kubectl` (the shapes below; any other argv, a flag it does not read, a jsonpath
 * it does not print, an object of another kind). Every one needs a namespace (`-n`) but `version` and `delete --raw`:
 *
 *   get <kind>/<name> -o json|jsonpath=<template>   a GET of the object: its JSON as it came, or the template printed
 *                                                   over it (parseJsonpath's shapes; a missing key prints nothing)
 *   get <kind>[,<kind>] [-l <sel>] -o jsonpath=<template>   when the template reads only each item's kind and metadata
 *                                                   (metadataTemplateKeep: reap's REAP_LIST_JSONPATH, the stale
 *                                                   sweep's): each kind's PartialObjectMetadataList, read off the loop
 *                                                   (projectListTask, cut to what it reads), its items in kind order
 *   delete <kind>/<name>... [--ignore-not-found] [--grace-period=<s>] [--wait=false] [-o name]
 *                                                   a DELETE of each in turn, propagationPolicy Background (kubectl's
 *                                                   default cascade) and the grace said; a pod only with --wait=false
 *   delete <kind>[,<kind>] -l <sel> <the same flags>   each kind's names listed by label (a Table, includeObject=None),
 *                                                   then each deleted as above
 *   delete --raw <path> -f -                         a DELETE of the path with stdin as its body (the address sweep's)
 *   create -f - --validate=false                     stdin's one Pod, Secret or NetworkPolicy POSTed into its collection
 *                                                   (fieldValidation=Ignore, kubectl's --validate=false)
 *   wait --for=<condition|jsonpath> pod/<name> --timeout=<n>s   the pod's GET every WAIT_POLL_MS until waitTest
 *                                                   holds (`condition met`) or the timeout (`timed out waiting for the
 *                                                   condition`, exit 1): awaitPod's kubectl loop and watchPod's
 *                                                   kubectl wait, where no watch is asked, never a kubectl
 *   version -o json                                  GET /version, as kubectl's `serverVersion`
 *   get <list> -o name|json, and the rest of listRead's   apiListExec's (over `api.get`, then kubectl)
 *
 * Kinds: pods, secrets, networkpolicies (kubectl's words for each). A refusal is kubectl's words (`Error from server
 * (<reason>): <message>`, a NotFound's `pods "x" not found` among them; a create's `error when creating "STDIN": …`), so
 * every reader of kubectl's stderr reads it the same (NOT_FOUND_RE, EXISTS_RE, NO_ROOM_RE, TOKEN_REFUSED_RE, the pace's
 * paceFaultOf). A 429 is asked again inside the budget (askShedRetried, as client-go waits one out), and a shed still
 * answered is kubectl's last words of it, `(TooManyRequests)`: the pace's `shed`. A call its budget or its signal cut is
 * kubectl's cut (`error`), never sent again, save a create known never sent (ApiUnsent: its socket wait ran out), asked
 * once more inside its budget (resentOnceUnsent). A call the in-process client could not ask (a token or CA that does not
 * read, TLS, a connection refused or reset) is kubectl's, said once until it changes: a delete's from the object it
 * could not ask on (those before it deleted), a create's after kubectl deletes by name what the POST may have made.
 * Every argv handed to kubectl is counted by verb (kubectlFallbacks, opts.onKubectl), and one with no in-process form at
 * all is said once a verb: a new call the driver writes that apiExec cannot answer shows, never spawns kubectl unseen.
 */
export function apiExec(api: ApiObjects, run: KubectlExec, opts: ApiExecOptions): KubectlExec {
  let said: string | null = null;
  // makefun_k8s_api_fallback_total: every verb 0 from the first apiExec, so a fall back shows as a rise, never as a new series.
  void registerApiClientMetrics({ warn: opts.warn });
  // The one way to kubectl: every argv handed it counted by verb (kubectlFallbacks, opts.onKubectl).
  const kubectl: KubectlExec = (args, call) => {
    const verb = verbOf(args);
    FALLBACKS.set(verb, (FALLBACKS.get(verb) ?? 0) + 1);
    opts.onKubectl?.(verb, args);
    return run(args, call);
  };
  // An argv with no in-process form at all (neither apiExec's nor a list's): said once a verb, never silent.
  const unanswered = new Set<string>();
  const unplanned: KubectlExec = (args, call) => {
    const verb = verbOf(args);
    if (listRead(args) === null && !unanswered.has(verb)) {
      unanswered.add(verb);
      opts.warn(`k8s sandbox: kubectl ${verb} has no in-process form (${JSON.stringify(args.slice(0, 6))}): kubectl runs it`);
    }
    return kubectl(args, call);
  };
  const lists = apiListExec(api.get, unplanned, { timeoutMs: opts.timeoutMs, warn: opts.warn, ...(opts.keep === undefined ? {} : { keep: opts.keep }), ...(opts.now === undefined ? {} : { now: opts.now }) });
  const viaKubectl = (what: string, problem: string, args: readonly string[], call: KubectlCallOptions): Promise<KubectlResult> => {
    if (problem !== said) opts.warn(`k8s sandbox: the API server's ${what} could not be asked in-process (${problem}): kubectl asks it instead until it can`);
    said = problem;
    return kubectl(args, call);
  };
  return async (args, call = {}) => {
    const planned = planOf(args, call.input);
    if (planned === null) return lists(args, call);
    const { argv, plan } = planned;
    const budget = call.timeoutMs ?? opts.timeoutMs;
    const deadline = Date.now() + budget;
    const signal = call.signal;
    const sig = signal === undefined ? {} : { signal };
    const ask = (resource: string, one: (timeoutMs: number) => Promise<ApiAnswer>): Promise<ApiAnswer> => askShedRetried(one, resource, budget, deadline, signal);
    const cutOf = (what: string, err: ApiCut, so: { stdout?: string; stderr?: string } = {}): KubectlResult => ({ code: null, stdout: so.stdout ?? '', stderr: so.stderr ?? '', error: `kubectl ${what}: ${err.message}` });
    const refusal = (answer: ApiAnswer, doing = ''): KubectlResult => ({ code: 1, stdout: '', stderr: `${serverSaid(answer, doing)}\n` });
    const answered = <T>(r: T): T => {
      said = null;
      return r;
    };
    const ns = argv.namespace ?? '';
    switch (plan.op) {
      case 'version': {
        let answer: ApiAnswer;
        try {
          answer = await ask('version', (timeoutMs) => api.get('/version', { accept: JSON_ACCEPT, timeoutMs, ...sig }));
        } catch (err) {
          if (err instanceof ApiCut) return cutOf('version', err);
          return viaKubectl('version', (err as Error).message, args, call);
        }
        if (answer.status !== 200) return answered(refusal(answer));
        let serverVersion: unknown;
        try {
          serverVersion = JSON.parse(answer.body);
        } catch {
          return viaKubectl('version', `HTTP 200 with no version: ${JSON.stringify(answer.body.slice(0, 120))}`, args, call);
        }
        return answered({ code: 0, stdout: `${JSON.stringify({ serverVersion }, null, 2)}\n`, stderr: '' });
      }
      case 'wait': {
        const { ref } = plan;
        const until = Date.now() + plan.waitMs;
        for (;;) {
          let answer: ApiAnswer;
          try {
            answer = await ask(ref.kind.plural, (timeoutMs) => api.get(objectPath(ref.kind, ns, ref.name), { accept: JSON_ACCEPT, timeoutMs, ...sig }));
          } catch (err) {
            if (err instanceof ApiCut) return cutOf(`wait ${ref.word}`, err);
            return viaKubectl(`wait for ${ref.word}`, (err as Error).message, args, call);
          }
          if (answer.status !== 200) return answered(refusal(answer));
          let pod: unknown;
          try {
            pod = JSON.parse(answer.body);
          } catch {
            return viaKubectl(`wait for ${ref.word}`, `HTTP 200 with no object: ${JSON.stringify(answer.body.slice(0, 120))}`, args, call);
          }
          said = null;
          if (plan.met(pod)) return { code: 0, stdout: `${ref.kind.printed}/${ref.name} condition met\n`, stderr: '' };
          if (Date.now() + WAIT_POLL_MS > until || Date.now() + WAIT_POLL_MS >= deadline) return { code: 1, stdout: '', stderr: `error: timed out waiting for the condition on ${ref.kind.plural}/${ref.name}\n` };
          try {
            await sleep(WAIT_POLL_MS, undefined, sig);
          } catch {
            return cutOf(`wait ${ref.word}`, new ApiCut('cut off'));
          }
        }
      }
      case 'get': {
        const { ref } = plan;
        let answer: ApiAnswer;
        try {
          answer = await ask(ref.kind.plural, (timeoutMs) => api.get(objectPath(ref.kind, ns, ref.name), { accept: JSON_ACCEPT, timeoutMs, ...sig }));
        } catch (err) {
          if (err instanceof ApiCut) return cutOf(`get ${ref.word}`, err);
          return viaKubectl(`read of ${ref.word}`, (err as Error).message, args, call);
        }
        if (answer.status !== 200) return answered(refusal(answer));
        if (plan.jsonpath === null) return answered({ code: 0, stdout: answer.body.endsWith('\n') ? answer.body : `${answer.body}\n`, stderr: '' });
        let obj: unknown;
        try {
          obj = JSON.parse(answer.body);
        } catch {
          return viaKubectl(`read of ${ref.word}`, `HTTP 200 with no object: ${JSON.stringify(answer.body.slice(0, 120))}`, args, call);
        }
        return answered({ code: 0, stdout: printJsonpath(plan.jsonpath, obj), stderr: '' });
      }
      case 'metadata': {
        const items: unknown[] = [];
        const what = `list of ${plan.kinds.map((k) => k.plural).join(',')}`;
        for (const kind of plan.kinds) {
          const query = new URLSearchParams();
          if (plan.selector !== null && plan.selector !== '') query.set('labelSelector', plan.selector);
          query.set('timeout', listTimeoutParam(budget));
          let answer: ApiAnswer;
          try {
            answer = await ask(kind.plural, (timeoutMs) => api.get(`${objectPath(kind, ns)}?${query}`, { accept: METADATA_LIST_ACCEPT, timeoutMs, ...sig }));
          } catch (err) {
            if (err instanceof ApiCut) return cutOf(`get ${kind.plural}`, err);
            return viaKubectl(what, (err as Error).message, args, call);
          }
          if (answer.status !== 200) return answered(refusal(answer));
          let listed: ListDoc;
          try {
            listed = await runOffThread(projectListTask, { body: answer.body, keep: plan.keep }, sig);
          } catch (err) {
            return { code: null, stdout: '', stderr: '', error: `kubectl get ${kind.plural}: its list could not be read off the event loop (${(err as Error).message})` };
          }
          const got = listItemsOf(listed);
          if (!Array.isArray(got)) return viaKubectl(what, `HTTP 200 with no list: ${JSON.stringify(answer.body.slice(0, 120))}`, args, call);
          for (const item of got) items.push({ ...(item !== null && typeof item === 'object' ? item : {}), kind: kind.kind });
        }
        return answered({ code: 0, stdout: printJsonpath(plan.template, { kind: 'List', items }), stderr: '' });
      }
      case 'delete-raw': {
        let answer: ApiAnswer;
        try {
          answer = await ask(resourceOfPath(plan.path), (timeoutMs) => api.delete(plan.path, plan.body, { timeoutMs, ...sig }));
        } catch (err) {
          if (err instanceof ApiCut) return cutOf(`delete --raw ${plan.path}`, err);
          return viaKubectl(`delete of ${plan.path}`, (err as Error).message, args, call);
        }
        if (answer.status < 200 || answer.status > 299) return answered(refusal(answer));
        return answered({ code: 0, stdout: answer.body, stderr: '' });
      }
      case 'create': {
        const word = `${plan.kind.printed}/${plan.name}`;
        let answer: ApiAnswer;
        try {
          // One known never sent (its socket wait ran out) is asked once more: it made nothing (resentOnceUnsent).
          answer = await ask(plan.kind.plural, resentOnceUnsent((timeoutMs) => api.create(`${objectPath(plan.kind, ns)}?fieldValidation=Ignore`, plan.body, { timeoutMs, ...sig }), deadline, signal));
        } catch (err) {
          if (err instanceof ApiCut) return cutOf(`create ${word}`, err);
          // The POST may have been made all the same (a reset after the server took it): what it named is deleted by
          // name first, so kubectl's create never meets it as AlreadyExists; a delete that fails ends the create here.
          const problem = (err as Error).message;
          const cleared = await kubectl(['-n', ns, 'delete', word, '--ignore-not-found', '--wait=false', ...(plan.kind === POD_KIND ? ['--grace-period=1'] : [])], { ...sig, timeoutMs: Math.max(1, deadline - Date.now()) });
          if (cleared.code !== 0 || cleared.error !== undefined) {
            const words = cleared.error ?? cleared.stderr.split('\n').find((l) => l.trim() !== '' && !l.startsWith('Warning:'))?.trim() ?? `exit ${cleared.code}`;
            return { code: 1, stdout: '', stderr: `error: the in-process create of ${word} could not be asked (${problem}), and the delete of what it may have made before kubectl's create failed: ${words}\n` };
          }
          return viaKubectl(`create of ${word}`, problem, args, call);
        }
        if (answer.status < 200 || answer.status > 299) return answered(refusal(answer, 'error when creating "STDIN": '));
        return answered({ code: 0, stdout: `${word} created\n`, stderr: '' });
      }
      case 'delete-selected':
      case 'delete': {
        let refs: ObjectRef[];
        if (plan.op === 'delete') refs = plan.refs;
        else {
          refs = [];
          for (const kind of plan.kinds) {
            const query = new URLSearchParams({ labelSelector: plan.selector, includeObject: 'None', timeout: listTimeoutParam(budget) });
            let answer: ApiAnswer;
            try {
              answer = await ask(kind.plural, (timeoutMs) => api.get(`${objectPath(kind, ns)}?${query}`, { accept: TABLE_ACCEPT, timeoutMs, ...sig }));
            } catch (err) {
              if (err instanceof ApiCut) return cutOf(`delete ${kind.plural} -l ${plan.selector}`, err);
              return viaKubectl(`delete of ${kind.plural} by label`, (err as Error).message, args, call);
            }
            if (answer.status !== 200) return answered(refusal(answer));
            const names = tableNames(answer.body);
            if (names === null) return viaKubectl(`delete of ${kind.plural} by label`, `HTTP 200 with no list: ${JSON.stringify(answer.body.slice(0, 120))}`, args, call);
            for (const name of names) refs.push({ kind, name, word: `${kind.printed}/${name}` });
          }
        }
        const options = JSON.stringify({ kind: 'DeleteOptions', apiVersion: 'v1', propagationPolicy: 'Background', ...(plan.flags.grace === null ? {} : { gracePeriodSeconds: plan.flags.grace }) });
        let stdout = '';
        let stderr = '';
        let code = 0;
        for (const [i, ref] of refs.entries()) {
          let answer: ApiAnswer;
          try {
            answer = await ask(ref.kind.plural, (timeoutMs) => api.delete(objectPath(ref.kind, ns, ref.name), options, { timeoutMs, ...sig }));
          } catch (err) {
            if (err instanceof ApiCut) return cutOf(`delete ${ref.word}`, err, { stdout, stderr });
            // The rest, from this one on, by kubectl (by name: a label's list is already read).
            const rest = await viaKubectl(`delete of ${ref.word}`, (err as Error).message, argvOf(argv, refs.slice(i).map((r) => r.word), new Set(['selector'])), call);
            return { code: rest.code === 0 ? code : rest.code, stdout: stdout + rest.stdout, stderr: stderr + rest.stderr, ...(rest.error === undefined ? {} : { error: rest.error }) };
          }
          if (answer.status >= 200 && answer.status <= 299) stdout += plan.flags.names ? `${ref.kind.printed}/${ref.name}\n` : `${ref.kind.printed} "${ref.name}" deleted\n`;
          else if (answer.status === 404 && plan.flags.ignore) continue;
          else {
            stderr += `${serverSaid(answer)}\n`;
            code = 1;
          }
        }
        return answered({ code, stdout, stderr });
      }
    }
  };
}
