// The scrape heat's house certificate authority: one P-256 CA per heat, and one leaf per listed host
// for the recording TLS gateway (grader/scrape/gateway.ts) to answer that host's ClientHello with.
//
//   createHeatCa({hosts})   a fresh CA: a new P-256 key and a self-signed certificate
//                           (basicConstraints critical CA:TRUE pathlen 0, keyUsage critical
//                           keyCertSign + cRLSign, subjectKeyIdentifier, and nameConstraints
//                           permitting only the heat's hosts, so even this CA can vouch for nothing
//                           else)
//   ca.issueLeaf(host)      a fresh P-256 key (PEM pkcs8) and its certificate for `host`
//                           (subjectAltName dNSName, basicConstraints critical CA:FALSE, keyUsage
//                           critical digitalSignature, extendedKeyUsage serverAuth, subject and
//                           authority key identifiers): what the gateway's /config/gateway.json
//                           holds under hosts.<host>.cert and .key. A test fixture may ask for
//                           several names on one leaf; a heat issues one per host
//   hostLeaves(ca, hosts)   one leaf per host, keyed by host
//
// Both certificates pass OpenSSL's X509_V_FLAG_X509_STRICT checks (CA key usage and SKID, a
// critical CA basicConstraints, the leaf's AKID), which Python 3.13's default SSL context turns on,
// as well as Node's default verification.
//
// The CA's private key never leaves the object createHeatCa returns: it is held in a closure, not a
// property, and nothing here exports it, so it is in no PEM, no JSON and no file. It lives in the
// heat's memory for the heat, and the next heat makes a new one (a CA is never reused across
// heats). Only leaf keys are written, into the gateway's /config.
//
// The DER writer is the one tests/unit/gateway-server.test.ts selfSignedCert writes by hand, grown to
// a CA and its leaves (the planner's /tmp/claude/mitm-proof/proof.mjs). Serials are 16 random bytes
// (positive, minimal), validity starts an hour back for clock skew, and every time before 2050 is a
// UTCTime (RFC 5280 4.1.2.5).
//
// Stdlib only (node:crypto): the scrape gateway bundle (grader/scrape/bundle.ts) inlines this file.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** How long a heat CA (and so each of its leaves) is valid by default: a heat runs for hours, never days. */
export const HEAT_CA_VALIDITY_MS = 2 * 86_400_000;
/** How far back validity starts, for a clock that runs behind. */
export const HEAT_CA_BACKDATE_MS = 3_600_000;
/** The most hosts one heat CA permits. */
export const MAX_HEAT_HOSTS = 8;

export class HeatCaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeatCaError';
  }
}

/**
 * True for an exact lowercase DNS name of two or more labels: letters, digits and inner hyphens, each
 * label 1-63 characters, 253 at most in all, no trailing dot, no wildcard and no IP literal.
 */
export function isHostName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 253) return false;
  const labels = name.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  // A name whose last label is all digits reads as an IPv4 literal to a resolver.
  return !/^[0-9]+$/.test(labels[labels.length - 1]!);
}

// ---------------------------------------------------------------- DER

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  if (n < 0x10000) return Buffer.from([0x82, n >> 8, n & 0xff]);
  if (n < 0x1000000) return Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  throw new HeatCaError(`a DER value of ${n} bytes is too long for a certificate`);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
const octets = (...parts: Buffer[]): Buffer => tlv(0x04, ...parts);
const DER_TRUE = tlv(0x01, Buffer.from([0xff]));

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a! + b!];
  for (let v of rest) {
    const base128 = [v & 0x7f];
    for (v = Math.floor(v / 128); v > 0; v = Math.floor(v / 128)) base128.unshift((v & 0x7f) | 0x80);
    bytes.push(...base128);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A small non-negative INTEGER. */
const smallInt = (n: number): Buffer => tlv(0x02, Buffer.from([n]));

/** UTCTime before 2050, GeneralizedTime from then on (RFC 5280 4.1.2.5), to the second. */
function derTime(d: Date): Buffer {
  const digits = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
}

/** A Name of one or two RDNs: O (when given) then CN, each a UTF8String. */
function derName(cn: string, o?: string): Buffer {
  const rdns: Buffer[] = [];
  if (o !== undefined) rdns.push(set(seq(oid('2.5.4.10'), tlv(0x0c, Buffer.from(o, 'utf8')))));
  rdns.push(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));
  return seq(...rdns);
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(oid(id), DER_TRUE, octets(value)) : seq(oid(id), octets(value));
}

/** RFC 5280 4.2.1.2 method 1: SHA-1 of the subjectPublicKey BIT STRING's bits (the uncompressed EC point). */
function keyIdentifier(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // A P-256 SubjectPublicKeyInfo ends with the 65-byte uncompressed point.
  return createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
}

/** A positive, minimally encoded 16-byte serial. */
function serialNumber(): Buffer {
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  return tlv(0x02, serial);
}

function pem(der: Buffer, label: string): string {
  const lines = der.toString('base64').match(/.{1,64}/g)!;
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

interface CertSpec {
  subject: Buffer;
  issuer: Buffer;
  publicKey: KeyObject;
  signingKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: Buffer[];
}

function certificate(spec: CertSpec): Buffer {
  const tbs = seq(
    tlv(0xa0, smallInt(2)),
    serialNumber(),
    ECDSA_SHA256,
    spec.issuer,
    seq(derTime(spec.notBefore), derTime(spec.notAfter)),
    spec.subject,
    spec.publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...spec.extensions)),
  );
  return seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sign('sha256', tbs, spec.signingKey)));
}

const p256 = (): { publicKey: KeyObject; privateKey: KeyObject } => generateKeyPairSync('ec', { namedCurve: 'P-256' });

// ---------------------------------------------------------------- the heat CA

/** A leaf: what the gateway config holds per host. */
export interface HostLeaf {
  /** The certificate, PEM. */
  cert: string;
  /** Its private key, PEM pkcs8. */
  key: string;
  /** The names its subjectAltName lists. */
  hosts: string[];
}

export interface HeatCa {
  /** The CA certificate, PEM: what the entry's image trusts. */
  readonly cert: string;
  /** sha256 of the certificate's DER, lowercase hex: what a heat record names. */
  readonly sha256: string;
  /** The hosts its nameConstraints permit, sorted. */
  readonly hosts: readonly string[];
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** Issue a leaf for `host`, or for several names (a test fixture's upstream): each must be one of `hosts`. */
  issueLeaf(host: string | readonly string[]): HostLeaf;
}

export interface HeatCaOptions {
  /** The hosts the heat's gateway answers for (1..MAX_HEAT_HOSTS exact lowercase DNS names). */
  hosts: readonly string[];
  /** Names the CA in its subject ("makefun scrape heat CA <label>"): the heat id, say. */
  label?: string;
  /** Milliseconds since the epoch the validity is reckoned from (default now). */
  now?: number;
  /** How long it is valid from `now` (default HEAT_CA_VALIDITY_MS). */
  validityMs?: number;
}

function checkHosts(hosts: readonly string[], what: string): string[] {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new HeatCaError(`${what} names no host`);
  for (const h of hosts) if (!isHostName(h)) throw new HeatCaError(`${what}: ${JSON.stringify(h)} is not an exact lowercase DNS name`);
  const unique = [...new Set(hosts)].sort();
  if (unique.length !== hosts.length) throw new HeatCaError(`${what} names a host twice`);
  return unique;
}

/** A new heat CA (see the header). */
export function createHeatCa(opts: HeatCaOptions): HeatCa {
  const hosts = checkHosts(opts.hosts, 'a heat CA');
  if (hosts.length > MAX_HEAT_HOSTS) throw new HeatCaError(`a heat CA permits at most ${MAX_HEAT_HOSTS} hosts, not ${hosts.length}`);
  const label = opts.label ?? randomBytes(4).toString('hex');
  if (typeof label !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(label)) throw new HeatCaError('the CA label is 1-64 printable ASCII characters');
  const now = opts.now ?? Date.now();
  const validityMs = opts.validityMs ?? HEAT_CA_VALIDITY_MS;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(validityMs) || validityMs <= 0) throw new HeatCaError('now and validityMs are positive integer milliseconds');
  const notBefore = new Date(now - HEAT_CA_BACKDATE_MS);
  const notAfter = new Date(now + validityMs);

  const { publicKey, privateKey } = p256();
  const skid = keyIdentifier(publicKey);
  const name = derName(`makefun scrape heat CA ${label}`, 'make.fun');
  const caDer = certificate({
    subject: name,
    issuer: name,
    publicKey,
    signingKey: privateKey,
    notBefore,
    notAfter,
    extensions: [
      extension('2.5.29.19', true, seq(DER_TRUE, smallInt(0))),
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x01, 0x06]))),
      extension('2.5.29.14', false, octets(skid)),
      extension('2.5.29.35', false, seq(tlv(0x80, skid))),
      extension('2.5.29.30', true, seq(tlv(0xa0, ...hosts.map((h) => seq(tlv(0x82, Buffer.from(h, 'ascii'))))))),
    ],
  });
  const caPem = pem(caDer, 'CERTIFICATE');
  const permitted = new Set(hosts);

  const issueLeaf = (host: string | readonly string[]): HostLeaf => {
    const names = checkHosts(typeof host === 'string' ? [host] : host, 'a leaf');
    const outside = names.filter((n) => !permitted.has(n));
    if (outside.length > 0) throw new HeatCaError(`this heat CA does not permit ${outside.join(', ')}`);
    const leafKeys = p256();
    const leafDer = certificate({
      subject: derName(names[0]!),
      issuer: name,
      publicKey: leafKeys.publicKey,
      signingKey: privateKey,
      notBefore,
      notAfter,
      extensions: [
        extension('2.5.29.19', true, seq()),
        extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))),
        extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
        extension('2.5.29.17', false, seq(...names.map((n) => tlv(0x82, Buffer.from(n, 'ascii'))))),
        extension('2.5.29.14', false, octets(keyIdentifier(leafKeys.publicKey))),
        extension('2.5.29.35', false, seq(tlv(0x80, skid))),
      ],
    });
    return { cert: pem(leafDer, 'CERTIFICATE'), key: leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, hosts: names };
  };

  return Object.freeze({
    cert: caPem,
    sha256: createHash('sha256').update(caDer).digest('hex'),
    hosts: Object.freeze(hosts),
    notBefore,
    notAfter,
    issueLeaf,
  });
}

/** One leaf per host (see the header), keyed by host. */
export function hostLeaves(ca: HeatCa, hosts: readonly string[]): Record<string, HostLeaf> {
  const out: Record<string, HostLeaf> = {};
  for (const h of checkHosts(hosts, 'hostLeaves')) out[h] = ca.issueLeaf(h);
  return out;
}
