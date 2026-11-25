// agent/v1: the wire between the grader and `makefun-agent`, the house agent inside every sandbox pod (the plan "Take
// kubectl exec out of grading", item #703). This header IS the spec: the grader's client (agent-client.ts), its fake
// agent (tests/helpers/fake-agent.ts) and the Rust agent (sandbox-agent/) are each held to it, and to the byte vectors
// in agent-wire.vectors.json (tests/unit/sandbox-agent-wire.test.ts here, sandbox-agent/tests/wire.rs there). The wire is
// kubectl exec's semantics and nothing new: one HTTP/2 stream per exec, stdin as the request body, framed stdout and
// stderr as the response, the exit status in a trailer.
//
// Imports nothing but node:crypto (and node:net, node:tls types), so any harness, test or tool may read it.
//
// The agent and its modes. One static binary, `makefun-agent <mode> ...`:
//
//   stage --arrival <s> [--install <dir>]   PID 1 of a program pod's `stage` init container (in place
//                                           of a shell PID 1). It keeps that shell's signals exactly: SIGUSR2 = the staging exec
//                                           has arrived; SIGUSR1 = the release, exit 0; no SIGUSR2 within <s> seconds
//                                           (k8s.ts STAGE_ARRIVAL_S) = exit 1; once arrived it waits for the release
//                                           with no deadline of its own. SIGTERM: exit 0 before the arrival (SIGUSR2),
//                                           143 between it and the release (SIGUSR1). It serves the wire meanwhile (the
//                                           staging exec is one: STAGE_EXEC_SCRIPT signals PID 1 as before). `--install`
//                                           (release 2) first copies the binary into <dir>.
//   serve                                   PID 1 of `watch`. It reaps every child, and serves until the pod ends.
//   relay --listen <addr> --pod-cidr <cidr> [--tls]
//                                           the burst cluster's CONNECT relay (Relay, below).
//   shim --container <name> [--policy-port <port>] [--session-reaper]
//                                           PID 1 of `main` or of a member (release 2: Shim link, below).
//   version                                 prints its version line and exits 0 (the preflight pod's init container).
//
// Transport. The agent listens on <its pod's own IP>:AGENT_PORT (9011), found from its interfaces, never the wildcard
// and never loopback. Before TLS it drops a TCP connection whose source address is not listed in MAKEFUN_AGENT_PEERS, or
// is its own pod IP or a loopback address. TLS 1.3 only (AGENT_TLS_VERSION), ALPN `h2` only (AGENT_ALPN): a client
// offering another version, or not offering h2, is refused in the handshake. The client dials an IP, so it sends no server name; the agent ignores
// any. Over TLS, HTTP/2 with H2_SETTINGS on both ends:
//
//   - SETTINGS_INITIAL_WINDOW_SIZE 1 MiB, the connection window raised to H2_CONNECTION_WINDOW (16 MiB), push off;
//   - the agent's SETTINGS_MAX_CONCURRENT_STREAMS 64 (the client queues past it, never fails);
//   - SETTINGS_MAX_HEADER_LIST_SIZE 256 KiB on the agent (an argv header carries whole perl scripts); a Node client
//     also raises maxSendHeaderBlockLength to it (Node refuses to send a block past 64000 bytes by default);
//   - a Node client's maxSessionMemory is at least H2_CLIENT_MAX_SESSION_MEMORY_MB (64): Node's default (10) tears a
//     busy session down with ENHANCE_YOUR_CALM, which the proof's 200-stream burst hit;
//   - the client PINGs every PING_EVERY_MS (10 s); PING_MISSES_DEAD (2) PINGs unanswered in a row = the session is dead.
//
// Dialling. One TCP attempt is bounded by DIAL_ATTEMPT_MS (150 ms): an attempt whose SYN gets no answer is abandoned and
// a new one made, so a SYN dropped while Cilium readies the endpoint never costs the kernel's 1 s SYN RTO; ECONNREFUSED
// (the agent not yet listening) re-dials after DIAL_REFUSED_RETRY_MS (20 ms). The attempts stop at the caller's budget.
//
// The credential. A per-pod key K, KEY_BYTES (32) random bytes, carried as base64url without padding (43 characters,
// canonical: encodeAgentKey / parseAgentKey) in MAKEFUN_AGENT_KEY of the pod's own `<pod>-env` Secret, referenced only by
// `stage` and `watch`. The agent reads it at start and removes it from its environment. From K, HKDF-SHA256 with an
// empty salt and 32 bytes of output:
//
//   server seed = HKDF(K, info `makefun-agent/v1 server-key`)   the agent's Ed25519 TLS key (the seed itself is the key:
//                                                                PKCS#8 DER is ED25519_PKCS8_PREFIX + seed)
//   client key  = HKDF(K, info `makefun-agent/v1 client-key`)   the request token's HMAC key
//
// The pin is the server key's SubjectPublicKeyInfo, DER (ED25519_SPKI_PREFIX + the 32-byte public key: 44 bytes). The
// agent's certificate is self-signed by that key (any name, any validity: the Rust agent's is rcgen's, the fake agent's
// selfSignedCertificate's); the client checks neither chain, name nor dates, only that the leaf's SPKI DER equals the
// pin, on secureConnect and before any request (checkAgentSocket). A recycled pod IP or a stolen port fails the pin.
//
// The token proves the caller holds K, bound to this TLS connection: with ekm = the connection's TLS exporter,
// exportKeyingMaterial(EXPORTER_BYTES = 32, label `EXPORTER-makefun-agent-v1`, an empty context,
// which TLS 1.3 holds the same as none: RFC 8446 7.5),
//
//   token = base64url(HMAC-SHA256(client key, ekm)), no padding (43 characters)
//
// sent on every request (health included) as the `makefun-agent-auth` header. The agent recomputes it per connection
// and compares in constant time; a request without it or with another answers 401, and the AUTH_FAILURES_GOAWAY'th
// (3rd) 401 on one connection ends it with GOAWAY ENHANCE_YOUR_CALM.
//
// Requests. Every request is authenticated first (401), then routed (404 for an unknown path, 405 for a known path
// with another method). An error status carries a short UTF-8 reason as its body and no trailer.
//
//   POST /v1/exec    run one program.
//     headers:  makefun-agent-auth   the token
//               makefun-argv         base64url, no padding, of the UTF-8 JSON array of argv's strings (encodeArgvHeader):
//                                    at least one string, argv[0] non-empty, none holding NUL, well-formed Unicode,
//                                    the header value at most ARGV_HEADER_MAX_BYTES; a missing or malformed one
//                                    answers 400
//               makefun-container    absent: the agent's own container. Present: a member container named in
//                                    MAKEFUN_AGENT_CONTAINERS whose shim is connected (Shim link); any other answers 404
//     body:     the program's stdin. END_STREAM on the request is stdin's EOF (the agent closes the child's stdin).
//     The child: argv as given; argv[0] without a `/` is looked up on the child's PATH (execvp). Its environment is
//     the agent's own start-up environment minus every MAKEFUN_AGENT_* variable (AGENT_ENV_PREFIX): the container's
//     env, which still holds the kubelet's eight KUBERNETES_* service variables (k8s.ts KUBERNETES_ENV), exactly what
//     kubectl exec gave it, and never the key. EXEC_WRAPPER unsets those eight for a program, as it does today; a raw
//     exec keeps them, as today. A shim's children get the shim's (the member's container env, which holds no key).
//     Its working directory and user are the agent's. stdin, stdout and stderr are pipes; nothing else is inherited.
//     response: `:status 200` once the child is spawned: the "opened" signal. A spawn that fails also answers 200, then
//               ends with the exit kubectl's path (`sh`'s `exec "$@"`) gave: 127 when argv[0] is not found (ENOENT,
//               ENOTDIR), 126 for any other failure (EACCES, ENOEXEC, ...): spawnFailureExit; its words (`<argv0>: <why>`)
//               on stderr. The body is frames, each [u8 channel][u32 big-endian length][length bytes] (encodeFrame /
//               FrameDecoder): channel 1 = stdout, 2 = stderr; 1 <= length <= FRAME_MAX_BYTES (64 KiB); a frame of any
//               other channel or length is a protocol error the client ends the stream on. Each channel's bytes come in
//               order; the two channels interleave as read. The agent reads a child's pipe only while the stream's send
//               window is open, so a slow reader holds the child (back-pressure end to end).
//     trailer:  `makefun-exit` once the child has exited AND both its pipes have reached EOF (every frame sent): the
//               decimal exit status, 0-255, no sign, no leading zero (encodeExit / parseExit); 128+n for a child ended
//               by signal n (exitOfSignal). After the trailer the agent may reset the request side with NO_ERROR (a
//               child that never read its stdin); the client takes that as normal.
//     lost:     a stream that ends without a `makefun-exit` trailer (a reset either way, a GOAWAY that cuts it, the
//               session dead, a shim lost under a forwarded exec) is lost: no exit, never re-sent by anyone. The agent
//               spawns once per request and never replays one; the client never re-sends an exec.
//     cancel:   a client RST_STREAM(CANCEL) closes the child's three pipes and never signals it, as kubectl's end did:
//               the child reads EOF and meets EPIPE; the agent still reaps it.
//
//   GET /v1/health   {"mode":"stage"|"serve","version":"<the agent's version>","containers":[<member names>],
//                    "uptimeMs":<ms since the process started>} as application/json (parseHealth). `containers` lists
//                    the members whose shims are connected now, in MAKEFUN_AGENT_CONTAINERS' order ([] in stage mode
//                    and in release 1). The first authenticated answer is the pod's init clock's last mark.
//
// Environment of the agent: MAKEFUN_AGENT_KEY (K); MAKEFUN_AGENT_PEERS, the addresses allowed to connect, comma-joined
// IP literals (formatPeers / parsePeers: the creating grader's own pod IP, or the burst relay's); MAKEFUN_AGENT_CONTAINERS
// (`serve`, release 2), the member containers whose shims it accepts, comma-joined container names. A burst grader's
// MAKEFUN_AGENT_RELAY_URL names the relay (below); MAKEFUN_AGENT_RELAY_TOKEN is the bearer both the grader and the
// relay hold.
//
// Relay (burst). A grader that cannot route to the pod network (the burst cluster's 10.42/16 from s18) dials
// MAKEFUN_AGENT_RELAY_URL (`https://<host>:<port>` for a relay started with --tls, else `http://<host>:<port>`;
// parseRelayUrl) and sends, over HTTP/1.1 (connectRequest), inside the relay's TLS for https:
//
//   CONNECT <podIP>:9011 HTTP/1.1  Host: <podIP>:9011  Authorization: Bearer <MAKEFUN_AGENT_RELAY_TOKEN>
//
// The relay answers 200 and splices bytes both ways (TLS stays end to end with the agent: the relay sees ciphertext
// only, and the pin and token hold through it); 401 for a missing or wrong bearer (compared in constant time); 403 for a
// target outside its --pod-cidr or a port other than 9011; 502 when its dial fails; 503 when its tunnel cap is full.
// `GET /v1/peer` with the same bearer answers {"ip":"<the relay's own pod IP>"} (parsePeerAnswer): the source the agents
// see, which the grader puts in MAKEFUN_AGENT_PEERS.
//
// The relay's TLS (--tls, an https:// URL), so the bearer never crosses the open network in clear (the relay's
// NodePort on the burst server is reached from s18 over the internet). Its key comes from the token, as an agent's comes
// from K: relay seed = HKDF-SHA256(the token's bytes, an empty salt, info `makefun-agent/v1 relay-key` (RELAY_KEY_INFO),
// 32 bytes) (deriveRelaySeed), the Ed25519 key whose seed it is, a certificate self-signed by it; the pin is its SPKI DER
// (relayPin). So the grader, which holds the token, holds the pin, and no other Secret or file carries one. TLS 1.3
// only, no ALPN, no session tickets. The client checks neither chain, name nor dates, only the version and that the
// leaf's SPKI DER is the pin, on secureConnect and before it sends a byte (checkRelaySocket): a host that is not the
// relay never sees the bearer. Inside it the HTTP/1.1 above is unchanged, and through a CONNECT's tunnel the agent's
// own TLS runs inside the relay's (TLS in TLS: the relay still sees only the agent's ciphertext). A relay started with
// --tls tells the two apart by a connection's first byte (0x16, a TLS handshake record, is TLS; anything else is the
// plain HTTP/1.1 above), so an http:// grader of an older release (a rollback) still reaches it; the grader's URL alone
// decides, and an https:// grader never sends a byte in clear nor falls back. The token is at least RELAY_TOKEN_MIN_BYTES
// (16) printable characters (checkRelayToken; the relay's own start check), so the key is never derived from a short
// secret; burst's are 64 hex characters (32 random bytes).
//
// Shim link (release 2). A member's shim dials TCP AGENT_SHIM_HOST:AGENT_SHIM_PORT (127.0.0.1:9012; the pod's loopback
// is shared), re-dialling every SHIM_REDIAL_MS (20 ms) until `watch`'s agent listens, and sends one line, ASCII
// `makefun-shim/v1 <container>\n` (shimHello; at most SHIM_HELLO_MAX_BYTES), then serves HTTP/2 in the SERVER role on that
// same connection, cleartext, no token. The agent reads the line (the bytes after its `\n` are the shim's h2), and acts
// as the h2 client: it forwards a `/v1/exec` whose `makefun-container` names that member to it, stream for stream,
// windows end to end, without the auth and container headers; status, frames and trailer come back as the shim sent
// them. Each container in MAKEFUN_AGENT_CONTAINERS is accepted once; a hello for an undeclared or already accepted name
// is closed unread; the listener closes once all are in. No reconnect: a lost shim is that container's end (its open
// execs lost, later ones 404).
//
// Ports: AGENT_PORT 9011 and AGENT_SHIM_PORT 9012 are clear of k8s.ts POLICY_PORT 9009, the members' 8080, 8090, 8091
// and 443.

import { createHmac, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, timingSafeEqual, X509Certificate, type KeyObject } from 'node:crypto';
import { isIP, isIPv6 } from 'node:net';
import type { TLSSocket } from 'node:tls';

/** The wire's name and version: the HKDF infos, the exporter label and the shim hello all carry it. */
export const AGENT_WIRE = 'makefun-agent/v1';

/** The agent's TCP port on its pod IP. */
export const AGENT_PORT = 9011;
/** The shim link's port (release 2), on AGENT_SHIM_HOST. */
export const AGENT_SHIM_PORT = 9012;
/** The shim link's address: the pod's shared loopback. */
export const AGENT_SHIM_HOST = '127.0.0.1';

/** The one ALPN protocol the agent speaks. */
export const AGENT_ALPN = 'h2';
/** The one TLS version: Node's minVersion and maxVersion both. */
export const AGENT_TLS_VERSION = 'TLSv1.3';

export const EXEC_PATH = '/v1/exec';
export const HEALTH_PATH = '/v1/health';
/** The relay's own route (Relay): its pod IP. */
export const PEER_PATH = '/v1/peer';

/** The request token's header. */
export const AUTH_HEADER = 'makefun-agent-auth';
/** The exec's argv header (encodeArgvHeader). */
export const ARGV_HEADER = 'makefun-argv';
/** The exec's member container header; absent = the agent's own container. */
export const CONTAINER_HEADER = 'makefun-container';
/** The exec's exit trailer (encodeExit). */
export const EXIT_TRAILER = 'makefun-exit';

export const AGENT_KEY_ENV = 'MAKEFUN_AGENT_KEY';
export const AGENT_PEERS_ENV = 'MAKEFUN_AGENT_PEERS';
export const AGENT_CONTAINERS_ENV = 'MAKEFUN_AGENT_CONTAINERS';
export const AGENT_RELAY_URL_ENV = 'MAKEFUN_AGENT_RELAY_URL';
export const AGENT_RELAY_TOKEN_ENV = 'MAKEFUN_AGENT_RELAY_TOKEN';
/** Every MAKEFUN_AGENT_* variable starts so: the agent removes each from the environment its children get. */
export const AGENT_ENV_PREFIX = 'MAKEFUN_AGENT_';

/** The h2 settings both ends advertise (the header's Transport). */
export const H2_SETTINGS = Object.freeze({
  initialWindowSize: 1 << 20,
  maxConcurrentStreams: 64,
  maxHeaderListSize: 256 << 10,
  enablePush: false,
});
/** The connection-level receive window each end raises itself to (Node: session.setLocalWindowSize). */
export const H2_CONNECTION_WINDOW = 16 << 20;
/** A Node client's least maxSessionMemory, in MB (Node's default 10 fails a 200-stream burst with ENHANCE_YOUR_CALM). */
export const H2_CLIENT_MAX_SESSION_MEMORY_MB = 64;
/** A Node client's maxSendHeaderBlockLength: the agent's header list size (Node's default 64000 is short of it). */
export const H2_MAX_SEND_HEADER_BLOCK_LENGTH = H2_SETTINGS.maxHeaderListSize;
/** The client's PING period. */
export const PING_EVERY_MS = 10_000;
/** PINGs unanswered in a row that make the session dead. */
export const PING_MISSES_DEAD = 2;

/** One TCP connect attempt's bound: past it the attempt is abandoned and a new one made, never the kernel's SYN RTO. */
export const DIAL_ATTEMPT_MS = 150;
/** The pause before re-dialling after ECONNREFUSED (the agent not yet listening). */
export const DIAL_REFUSED_RETRY_MS = 20;
/** A shim's re-dial period until the shim link listens. */
export const SHIM_REDIAL_MS = 20;
/** The 401 on one connection that ends it with GOAWAY ENHANCE_YOUR_CALM. */
export const AUTH_FAILURES_GOAWAY = 3;

/** K's length, in bytes. */
export const KEY_BYTES = 32;
export const SERVER_KEY_INFO = `${AGENT_WIRE} server-key`;
/** The relay's TLS key's HKDF info (the header's relay TLS): its seed is HKDF-SHA256(token, empty salt, this, 32). */
export const RELAY_KEY_INFO = `${AGENT_WIRE} relay-key`;
/** The fewest characters a relay token may have (the relay's start check, sandbox-agent/src/connect.rs TOKEN_MIN_BYTES). */
export const RELAY_TOKEN_MIN_BYTES = 16;
export const CLIENT_KEY_INFO = `${AGENT_WIRE} client-key`;
/** The TLS exporter's label (RFC 8446 7.5), used with an empty context (in TLS 1.3 the same as none). */
export const EXPORTER_LABEL = 'EXPORTER-makefun-agent-v1';
/** The TLS exporter's output length, in bytes. */
export const EXPORTER_BYTES = 32;
/** An Ed25519 private key's PKCS#8 DER before its 32-byte seed (Node's encoding, RFC 8410). */
export const ED25519_PKCS8_PREFIX = '302e020100300506032b657004220420';
/** An Ed25519 public key's SubjectPublicKeyInfo DER before its 32 bytes (RFC 8410): the pin is this and the key. */
export const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

/** The frame header: one channel byte and a u32 big-endian length. */
export const FRAME_HEADER_BYTES = 5;
/** The largest frame payload the agent sends and a client takes. */
export const FRAME_MAX_BYTES = 1 << 16;
export const STDOUT_CHANNEL = 1;
export const STDERR_CHANNEL = 2;
export type AgentChannel = typeof STDOUT_CHANNEL | typeof STDERR_CHANNEL;

/** The longest makefun-argv value: within H2_SETTINGS.maxHeaderListSize with room for the rest of the block. */
export const ARGV_HEADER_MAX_BYTES = 192 << 10;
/** The exit of a spawn whose argv[0] is not found (`sh`'s, and kubectl exec through it). */
export const EXIT_NOT_FOUND = 127;
/** The exit of a spawn that failed otherwise (not executable, not a valid binary, ...). */
export const EXIT_NOT_EXECUTABLE = 126;
/** A child ended by signal n exits EXIT_SIGNAL_BASE + n. */
export const EXIT_SIGNAL_BASE = 128;

/** The shim hello's text before the container name. */
export const SHIM_HELLO_PREFIX = 'makefun-shim/v1 ';
/** The longest shim hello line, its `\n` included: the prefix, a 63-character name and the newline. */
export const SHIM_HELLO_MAX_BYTES = SHIM_HELLO_PREFIX.length + 63 + 1;

/** A Kubernetes container name (an RFC 1123 label): what makefun-container, MAKEFUN_AGENT_CONTAINERS and a hello name. */
export const CONTAINER_NAME_RE = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

/** A value off the wire (or for it) that breaks this spec. */
export class AgentWireError extends Error {
  override name = 'AgentWireError';
}

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Bytes as base64url with no padding. */
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/** Canonical unpadded base64url to bytes: anything Node would read loosely (padding, other characters, stray bits) is refused. */
function fromBase64url(text: string, what: string): Buffer {
  if (!BASE64URL_RE.test(text) || text.length % 4 === 1) throw new AgentWireError(`${what}: not unpadded base64url`);
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw new AgentWireError(`${what}: not canonical base64url`);
  return bytes;
}

// The credential.

/** K as MAKEFUN_AGENT_KEY carries it. */
export function encodeAgentKey(raw: Uint8Array): string {
  if (raw.byteLength !== KEY_BYTES) throw new AgentWireError(`agent key: ${raw.byteLength} bytes, not ${KEY_BYTES}`);
  return base64url(raw);
}

/** A fresh K, encoded: what a pod's creator puts in its `<pod>-env` Secret. */
export function newAgentKey(): string {
  return encodeAgentKey(randomBytes(KEY_BYTES));
}

/** MAKEFUN_AGENT_KEY's value to K's 32 bytes, refusing any other length or a non-canonical encoding. */
export function parseAgentKey(text: string): Buffer {
  const raw = fromBase64url(text, 'agent key');
  if (raw.byteLength !== KEY_BYTES) throw new AgentWireError(`agent key: ${raw.byteLength} bytes, not ${KEY_BYTES}`);
  return raw;
}

function hkdf(key: Uint8Array, info: string): Buffer {
  if (key.byteLength !== KEY_BYTES) throw new AgentWireError(`agent key: ${key.byteLength} bytes, not ${KEY_BYTES}`);
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}

/** The agent's Ed25519 seed: HKDF-SHA256(K, empty salt, SERVER_KEY_INFO, 32). */
export function deriveServerSeed(key: Uint8Array): Buffer {
  return hkdf(key, SERVER_KEY_INFO);
}

/** The token's HMAC key: HKDF-SHA256(K, empty salt, CLIENT_KEY_INFO, 32). */
export function deriveClientKey(key: Uint8Array): Buffer {
  return hkdf(key, CLIENT_KEY_INFO);
}

/** The seed's PKCS#8 DER: ED25519_PKCS8_PREFIX + seed. */
export function serverPkcs8(seed: Uint8Array): Buffer {
  if (seed.byteLength !== 32) throw new AgentWireError(`server seed: ${seed.byteLength} bytes, not 32`);
  return Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, 'hex'), seed]);
}

/** The seed as a Node private key. */
export function serverPrivateKey(seed: Uint8Array): KeyObject {
  return createPrivateKey({ key: serverPkcs8(seed), format: 'der', type: 'pkcs8' });
}

/** The seed's private key as PEM (a Node TLS server's `key`). */
export function serverKeyPem(seed: Uint8Array): string {
  return serverPrivateKey(seed).export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** The seed's SubjectPublicKeyInfo DER (44 bytes): the pin. */
export function serverSpki(seed: Uint8Array): Buffer {
  return Buffer.from(createPublicKey(serverPrivateKey(seed)).export({ type: 'spki', format: 'der' }));
}

/** The pin a client holds for the agent keyed by K. */
export function agentPin(key: Uint8Array): Buffer {
  return serverSpki(deriveServerSeed(key));
}

/** A certificate's SubjectPublicKeyInfo DER, from its DER or a parsed X509Certificate. */
export function spkiOfCertificate(cert: Uint8Array | X509Certificate): Buffer {
  const x = cert instanceof X509Certificate ? cert : new X509Certificate(cert);
  return Buffer.from(x.publicKey.export({ type: 'spki', format: 'der' }));
}

/** Whether a certificate's SPKI DER is the pin, byte for byte. */
export function pinMatches(cert: Uint8Array | X509Certificate, pin: Uint8Array): boolean {
  let spki: Buffer;
  try {
    spki = spkiOfCertificate(cert);
  } catch {
    return false;
  }
  return spki.byteLength === pin.byteLength && timingSafeEqual(spki, pin);
}

/**
 * What is wrong with a client's TLS socket to an agent, on secureConnect and before any request: not TLS 1.3, not h2,
 * no certificate, or a leaf whose SPKI is not the pin. null when it is the agent keyed by the pin's K.
 */
export function checkAgentSocket(socket: TLSSocket, pin: Uint8Array): string | null {
  if (socket.getProtocol() !== AGENT_TLS_VERSION) return `TLS version ${socket.getProtocol() ?? 'none'}, not ${AGENT_TLS_VERSION}`;
  if (socket.alpnProtocol !== AGENT_ALPN) return `ALPN ${socket.alpnProtocol === false ? 'none' : socket.alpnProtocol}, not ${AGENT_ALPN}`;
  const cert = socket.getPeerX509Certificate();
  if (cert === undefined) return 'the agent sent no certificate';
  if (!pinMatches(cert, pin)) return "the agent's key is not the pinned one";
  return null;
}

/** A TLS connection's exporter value the token is bound to. */
export function connectionExporter(socket: TLSSocket): Buffer {
  return socket.exportKeyingMaterial(EXPORTER_BYTES, EXPORTER_LABEL, Buffer.alloc(0));
}

/** The token: base64url(HMAC-SHA256(client key, ekm)), unpadded. */
export function agentToken(clientKey: Uint8Array, exporter: Uint8Array): string {
  if (exporter.byteLength !== EXPORTER_BYTES) throw new AgentWireError(`exporter: ${exporter.byteLength} bytes, not ${EXPORTER_BYTES}`);
  return createHmac('sha256', clientKey).update(exporter).digest('base64url');
}

/** Whether a presented makefun-agent-auth value is the token, compared in constant time. */
export function tokenMatches(clientKey: Uint8Array, exporter: Uint8Array, presented: string | undefined): boolean {
  if (typeof presented !== 'string') return false;
  const want = Buffer.from(agentToken(clientKey, exporter), 'latin1');
  const got = Buffer.from(presented, 'latin1');
  return got.byteLength === want.byteLength && timingSafeEqual(got, want);
}

// A self-signed certificate for the seed, for a Node agent (the fake agent): X.509 v3, serial 1, issuer = subject =
// CN=makefun-agent, valid 1970-01-01 to 9999-12-31, no extensions, signed Ed25519. Deterministic for a seed (Ed25519 is).

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.byteLength), body]);
}

const ED25519_ALGORITHM = der(0x30, der(0x06, Buffer.from('2b6570', 'hex')));
const AGENT_CERT_NAME = der(0x30, der(0x31, der(0x30, der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('makefun-agent', 'ascii')))));

/** The seed's self-signed certificate, DER (above). */
export function selfSignedCertificate(seed: Uint8Array): Buffer {
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    ED25519_ALGORITHM,
    AGENT_CERT_NAME,
    der(0x30, der(0x17, Buffer.from('700101000000Z', 'ascii')), der(0x18, Buffer.from('99991231235959Z', 'ascii'))),
    AGENT_CERT_NAME,
    serverSpki(seed),
  );
  const signature = sign(null, tbs, serverPrivateKey(seed));
  return der(0x30, tbs, ED25519_ALGORITHM, der(0x03, Buffer.from([0]), signature));
}

/** A DER certificate as PEM (a Node TLS server's `cert`). */
export function certificatePem(certDer: Uint8Array): string {
  const b64 = Buffer.from(certDer).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

// Frames.

export interface AgentFrame {
  channel: AgentChannel;
  data: Buffer;
}

/** One frame's bytes: [channel][u32be length][data]. */
export function encodeFrame(channel: AgentChannel, data: Uint8Array): Buffer {
  if (channel !== STDOUT_CHANNEL && channel !== STDERR_CHANNEL) throw new AgentWireError(`frame: channel ${String(channel)}`);
  if (data.byteLength < 1 || data.byteLength > FRAME_MAX_BYTES) throw new AgentWireError(`frame: ${data.byteLength} bytes, not 1 to ${FRAME_MAX_BYTES}`);
  const head = Buffer.alloc(FRAME_HEADER_BYTES);
  head[0] = channel;
  head.writeUInt32BE(data.byteLength, 1);
  return Buffer.concat([head, data]);
}

/** Bytes of any length as frames of one channel, each at most FRAME_MAX_BYTES (none for no bytes). */
export function encodeFrames(channel: AgentChannel, data: Uint8Array): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < data.byteLength; at += FRAME_MAX_BYTES) out.push(encodeFrame(channel, data.subarray(at, Math.min(at + FRAME_MAX_BYTES, data.byteLength))));
  return out;
}

/**
 * An exec response body's reader: push each chunk as it comes and take the whole frames it completed; finish() at the
 * body's end refuses a frame cut short. Any bad header (a channel not 1 or 2, a length 0 or past FRAME_MAX_BYTES)
 * throws AgentWireError as soon as its 5 bytes are in, and the decoder refuses everything after.
 */
export class FrameDecoder {
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #failed: string | null = null;

  push(chunk: Uint8Array): AgentFrame[] {
    if (this.#failed !== null) throw new AgentWireError(this.#failed);
    if (chunk.byteLength === 0) return [];
    this.#pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.#pendingBytes += chunk.byteLength;
    let buf = this.#pending.length === 1 ? this.#pending[0]! : Buffer.concat(this.#pending, this.#pendingBytes);
    const frames: AgentFrame[] = [];
    let at = 0;
    while (buf.byteLength - at >= FRAME_HEADER_BYTES) {
      const channel = buf[at]!;
      const length = buf.readUInt32BE(at + 1);
      if (channel !== STDOUT_CHANNEL && channel !== STDERR_CHANNEL) return this.#fail(`frame: channel ${channel}`);
      if (length < 1 || length > FRAME_MAX_BYTES) return this.#fail(`frame: length ${length}, not 1 to ${FRAME_MAX_BYTES}`);
      if (buf.byteLength - at - FRAME_HEADER_BYTES < length) break;
      frames.push({ channel: channel as AgentChannel, data: Buffer.from(buf.subarray(at + FRAME_HEADER_BYTES, at + FRAME_HEADER_BYTES + length)) });
      at += FRAME_HEADER_BYTES + length;
    }
    buf = buf.subarray(at);
    this.#pending = buf.byteLength === 0 ? [] : [buf];
    this.#pendingBytes = buf.byteLength;
    return frames;
  }

  /** The body ended: refuses a frame cut short. */
  finish(): void {
    if (this.#failed !== null) throw new AgentWireError(this.#failed);
    if (this.#pendingBytes !== 0) this.#fail(`frame: the body ended ${this.#pendingBytes} bytes into a frame`);
  }

  #fail(why: string): never {
    this.#failed = why;
    this.#pending = [];
    this.#pendingBytes = 0;
    throw new AgentWireError(why);
  }
}

/** A whole body's frames. */
export function decodeFrames(body: Uint8Array): AgentFrame[] {
  const d = new FrameDecoder();
  const frames = d.push(body);
  d.finish();
  return frames;
}

// The argv header.

/** argv as makefun-argv's value: base64url (unpadded) of its UTF-8 JSON array. */
export function encodeArgvHeader(argv: readonly string[]): string {
  checkArgv(argv);
  const value = Buffer.from(JSON.stringify(argv), 'utf8').toString('base64url');
  if (value.length > ARGV_HEADER_MAX_BYTES) throw new AgentWireError(`argv: the header would be ${value.length} bytes, past ${ARGV_HEADER_MAX_BYTES}`);
  return value;
}

/** makefun-argv's value to argv, refusing a value encodeArgvHeader could not have made of some argv. */
export function decodeArgvHeader(value: string | undefined): string[] {
  if (typeof value !== 'string' || value === '') throw new AgentWireError('argv: no header');
  if (value.length > ARGV_HEADER_MAX_BYTES) throw new AgentWireError(`argv: the header is ${value.length} bytes, past ${ARGV_HEADER_MAX_BYTES}`);
  const bytes = fromBase64url(value, 'argv');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AgentWireError('argv: not UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentWireError('argv: not JSON');
  }
  if (!Array.isArray(parsed)) throw new AgentWireError('argv: not a JSON array');
  if (!parsed.every((a): a is string => typeof a === 'string')) throw new AgentWireError('argv: not every element a string');
  checkArgv(parsed);
  return parsed;
}

function checkArgv(argv: readonly string[]): void {
  if (argv.length === 0) throw new AgentWireError('argv: empty');
  for (const [i, a] of argv.entries()) {
    if (typeof a !== 'string') throw new AgentWireError(`argv[${i}]: not a string`);
    if (a.includes('\0')) throw new AgentWireError(`argv[${i}]: holds NUL`);
    if (!a.isWellFormed()) throw new AgentWireError(`argv[${i}]: a lone surrogate`);
  }
  if (argv[0] === '') throw new AgentWireError('argv[0]: empty');
}

// The exit trailer.

/** An exit status as makefun-exit's value. */
export function encodeExit(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 255) throw new AgentWireError(`exit: ${code} is not 0 to 255`);
  return String(code);
}

/** makefun-exit's value to the exit status: decimal 0-255, no sign, no leading zero, nothing around it. */
export function parseExit(value: string | undefined): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})$/.test(value)) throw new AgentWireError(`exit: ${JSON.stringify(value ?? null)} is not a status`);
  const code = Number(value);
  if (code > 255) throw new AgentWireError(`exit: ${value} is past 255`);
  return code;
}

/** The exit of a child ended by signal number n: 128 + n. */
export function exitOfSignal(signal: number): number {
  if (!Number.isInteger(signal) || signal < 1 || signal > 127) throw new AgentWireError(`exit: signal ${signal}`);
  return EXIT_SIGNAL_BASE + signal;
}

/** The exit of a spawn that failed with errno `code`: 127 not found (ENOENT, ENOTDIR), else 126. */
export function spawnFailureExit(code: string): number {
  return code === 'ENOENT' || code === 'ENOTDIR' ? EXIT_NOT_FOUND : EXIT_NOT_EXECUTABLE;
}

// The agent's environment lists.

/** MAKEFUN_AGENT_PEERS' value: IP literals, comma-joined. */
export function formatPeers(peers: readonly string[]): string {
  if (peers.length === 0) throw new AgentWireError('peers: none');
  for (const p of peers) if (isIP(p) === 0) throw new AgentWireError(`peers: ${JSON.stringify(p)} is not an IP address`);
  return peers.join(',');
}

/** MAKEFUN_AGENT_PEERS' value to its addresses: at least one, each an IPv4 or IPv6 literal, no spaces. */
export function parsePeers(value: string): string[] {
  const peers = value.split(',');
  if (value === '' || peers.some((p) => isIP(p) === 0)) throw new AgentWireError(`peers: ${JSON.stringify(value)} is not comma-joined IP addresses`);
  return peers;
}

/** MAKEFUN_AGENT_CONTAINERS' value: container names, comma-joined, each once. */
export function formatContainers(names: readonly string[]): string {
  if (names.length === 0) throw new AgentWireError('containers: none');
  for (const n of names) if (!CONTAINER_NAME_RE.test(n)) throw new AgentWireError(`containers: ${JSON.stringify(n)} is not a container name`);
  if (new Set(names).size !== names.length) throw new AgentWireError('containers: a name twice');
  return names.join(',');
}

/** MAKEFUN_AGENT_CONTAINERS' value to its names. */
export function parseContainers(value: string): string[] {
  const names = value.split(',');
  if (value === '' || names.some((n) => !CONTAINER_NAME_RE.test(n))) throw new AgentWireError(`containers: ${JSON.stringify(value)} is not comma-joined container names`);
  if (new Set(names).size !== names.length) throw new AgentWireError('containers: a name twice');
  return names;
}

// The shim hello.

/** A shim's hello line for its container: `makefun-shim/v1 <container>\n`, ASCII. */
export function shimHello(container: string): Buffer {
  if (!CONTAINER_NAME_RE.test(container)) throw new AgentWireError(`shim hello: ${JSON.stringify(container)} is not a container name`);
  return Buffer.from(`${SHIM_HELLO_PREFIX}${container}\n`, 'ascii');
}

/**
 * The container a shim's first bytes name, and how many bytes the hello took (what follows is the shim's h2); null when
 * no `\n` has come yet within SHIM_HELLO_MAX_BYTES (read on). Throws for a line that is no hello.
 */
export function parseShimHello(bytes: Uint8Array): { container: string; length: number } | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nl = view.subarray(0, SHIM_HELLO_MAX_BYTES).indexOf(0x0a);
  if (nl < 0) {
    if (view.byteLength >= SHIM_HELLO_MAX_BYTES) throw new AgentWireError(`shim hello: no newline within ${SHIM_HELLO_MAX_BYTES} bytes`);
    return null;
  }
  const line = view.subarray(0, nl).toString('latin1');
  if (!line.startsWith(SHIM_HELLO_PREFIX)) throw new AgentWireError(`shim hello: ${JSON.stringify(line)} does not start ${JSON.stringify(SHIM_HELLO_PREFIX)}`);
  const container = line.slice(SHIM_HELLO_PREFIX.length);
  if (!CONTAINER_NAME_RE.test(container)) throw new AgentWireError(`shim hello: ${JSON.stringify(container)} is not a container name`);
  return { container, length: nl + 1 };
}

// Health.

export interface AgentHealth {
  mode: 'stage' | 'serve';
  version: string;
  containers: string[];
  uptimeMs: number;
}

/** A /v1/health body (unknown keys ignored), refusing one that misses or mistypes a field. */
export function parseHealth(body: string): AgentHealth {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    throw new AgentWireError('health: not JSON');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new AgentWireError('health: not an object');
  const o = v as Record<string, unknown>;
  if (o.mode !== 'stage' && o.mode !== 'serve') throw new AgentWireError(`health: mode ${JSON.stringify(o.mode ?? null)}`);
  if (typeof o.version !== 'string' || o.version === '') throw new AgentWireError('health: no version');
  if (!Array.isArray(o.containers) || !o.containers.every((c) => typeof c === 'string' && CONTAINER_NAME_RE.test(c))) throw new AgentWireError('health: containers not a list of container names');
  if (typeof o.uptimeMs !== 'number' || !Number.isSafeInteger(o.uptimeMs) || o.uptimeMs < 0) throw new AgentWireError(`health: uptimeMs ${JSON.stringify(o.uptimeMs ?? null)}`);
  return { mode: o.mode, version: o.version, containers: [...(o.containers as string[])], uptimeMs: o.uptimeMs };
}

// The relay.

/** A relay as its URL names it: where, and whether it speaks TLS (https). */
export interface RelayAddress {
  host: string;
  port: number;
  /** An https:// URL: the relay's TLS (the header's relay TLS), its pin relayPin(token). */
  tls: boolean;
}

/**
 * A relay's URL (MAKEFUN_AGENT_RELAY_URL): `https://<host>:<port>` (a relay started with --tls) or `http://<host>:<port>`,
 * the port always written out, no path, credentials, query or fragment.
 */
export function parseRelayUrl(text: string): RelayAddress {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new AgentWireError(`relay URL ${JSON.stringify(text)}: not a URL`);
  }
  // The URL parser drops a port equal to the scheme's default (`http://h:80` reads port ''), so the port is read from
  // the text: what follows the authority's last `:` (after an IPv6 literal's `]`).
  const authority = /^https?:\/\/([^/?#]*)/i.exec(text)?.[1] ?? '';
  const port = /:([0-9]{1,5})$/.exec(authority.slice(authority.lastIndexOf(']') + 1))?.[1];
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || port === undefined || (u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') {
    throw new AgentWireError(`relay URL ${JSON.stringify(text)}: not https://<host>:<port> or http://<host>:<port>`);
  }
  const n = Number(port);
  if (n < 1 || n > 65535 || (u.port !== '' && Number(u.port) !== n)) throw new AgentWireError(`relay URL ${JSON.stringify(text)}: port ${port} is not 1 to 65535`);
  const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  return { host, port: n, tls: u.protocol === 'https:' };
}

/** A relay token as the relay takes one (its start check): one printable word, at least RELAY_TOKEN_MIN_BYTES long. */
export function checkRelayToken(token: string): void {
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) throw new AgentWireError('relay: the token is not one printable word');
  if (token.length < RELAY_TOKEN_MIN_BYTES) throw new AgentWireError(`relay: the token has ${token.length} characters, fewer than ${RELAY_TOKEN_MIN_BYTES}`);
}

/** The relay's Ed25519 seed (the header's relay TLS): HKDF-SHA256(the token's bytes, empty salt, RELAY_KEY_INFO, 32). */
export function deriveRelaySeed(token: string): Buffer {
  checkRelayToken(token);
  return Buffer.from(hkdfSync('sha256', Buffer.from(token, 'latin1'), Buffer.alloc(0), Buffer.from(RELAY_KEY_INFO, 'utf8'), 32));
}

/** The pin a client holds for the relay whose bearer is `token`: its key's SPKI DER. */
export function relayPin(token: string): Buffer {
  return serverSpki(deriveRelaySeed(token));
}

/**
 * What is wrong with a client's TLS socket to a relay, on secureConnect and before the bearer is sent: not TLS 1.3, no
 * certificate, or a leaf whose SPKI is not the pin. null when it is the relay holding the pin's token.
 */
export function checkRelaySocket(socket: TLSSocket, pin: Uint8Array): string | null {
  if (socket.getProtocol() !== AGENT_TLS_VERSION) return `TLS version ${socket.getProtocol() ?? 'none'}, not ${AGENT_TLS_VERSION}`;
  const cert = socket.getPeerX509Certificate();
  if (cert === undefined) return 'the relay sent no certificate';
  if (!pinMatches(cert, pin)) return "the relay's key is not the pinned one (not the relay this token is for)";
  return null;
}

/** `<ip>:<port>`, an IPv6 address bracketed: a CONNECT target and its Host. */
export function connectAuthority(ip: string, port = AGENT_PORT): string {
  if (isIP(ip) === 0) throw new AgentWireError(`relay: ${JSON.stringify(ip)} is not an IP address`);
  return isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
}

/** The relay request for an agent at `ip` (Relay, above), its blank line included. */
export function connectRequest(ip: string, token: string): string {
  if (!/^[\x21-\x7e]+$/.test(token)) throw new AgentWireError('relay: the token is not one printable word');
  const authority = connectAuthority(ip);
  return `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: Bearer ${token}\r\n\r\n`;
}

/** A relay's /v1/peer body to its pod IP. */
export function parsePeerAnswer(body: string): string {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    throw new AgentWireError('peer: not JSON');
  }
  const ip = typeof v === 'object' && v !== null ? (v as Record<string, unknown>).ip : undefined;
  if (typeof ip !== 'string' || isIP(ip) === 0) throw new AgentWireError(`peer: ${JSON.stringify(ip ?? null)} is not an IP address`);
  return ip;
}
