// What a sandbox pod labelled makefun.egress=1 may NOT reach: the `except` list of NetworkPolicy makefun-sandbox-egress
// (deploy/k8s/base/networkpolicies.yaml), as CIDRs, in the yaml's order. tests/unit/grader-scrape-pod.test.ts holds the
// list equal to the yaml's, so an edit of one without the other fails.
//
// Why a copy is needed here: on the split layout a scrape heat's recording gateway is a sandbox pod under that policy,
// so an upstream address the harness resolved into one of these ranges (the pod, service or node networks, the
// tailnet, link-local and metadata, loopback, the fleet's own servers, the special-purpose blocks) is simply not
// reached. On the `pod` layout the gateway is a lane child in the grader pod's `lanes` container, which no sandbox
// policy selects, so grader/scrape/trial.ts refuses such an address itself before the gateway starts, from this list:
// the gateway is held to what it had by policy. The policy names no IPv6 block, so it opens no IPv6 address but the
// DNS pods' (which the gateway never dials): every IPv6 address is refused too, an IPv4-mapped one by its IPv4 form.
//
// Imports nothing but node:net, so any harness may read it.

import { isIPv4, isIPv6 } from 'node:net';

/** makefun-sandbox-egress's `except` list (deploy/k8s/base/networkpolicies.yaml), in its order. */
export const SANDBOX_EGRESS_EXCEPT: readonly string[] = Object.freeze([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '127.0.0.0/8',
  '0.0.0.0/8',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '74.1.1.0/24',
  '45.33.2.206/32',
  '69.164.203.183/32',
]);

/** An IPv4 address as an unsigned 32-bit number; null for what is not one in dotted decimal. */
function ipv4Number(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

/** A CIDR of SANDBOX_EGRESS_EXCEPT as its base and mask, checked once. */
const RANGES: ReadonlyArray<{ cidr: string; base: number; mask: number }> = SANDBOX_EGRESS_EXCEPT.map((cidr) => {
  const [addr, bits] = cidr.split('/') as [string, string];
  const base = ipv4Number(addr);
  const prefix = Number(bits);
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`SANDBOX_EGRESS_EXCEPT holds ${cidr}, which is no IPv4 CIDR`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  if (((base & mask) >>> 0) !== base) throw new Error(`SANDBOX_EGRESS_EXCEPT holds ${cidr}, whose address has bits past its prefix`);
  return { cidr, base, mask };
});

/** The IPv4 form of an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), else null. */
function mappedIpv4(ip: string): string | null {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m !== null && isIPv4(m[1]!) ? m[1]! : null;
}

/**
 * Why makefun-sandbox-egress would not let a sandbox reach `ip`: the excepted CIDR it lies in, `IPv6` for an IPv6
 * address (the policy opens none), or `not an IP address`; null for an address the policy opens.
 */
export function sandboxEgressRefusal(ip: string): string | null {
  const v4 = isIPv4(ip) ? ip : isIPv6(ip) ? mappedIpv4(ip) : null;
  if (v4 === null) return isIPv6(ip) ? 'IPv6 (the policy opens no IPv6 address)' : 'not an IP address';
  const n = ipv4Number(v4)!;
  const hit = RANGES.find((r) => ((n & r.mask) >>> 0) === r.base);
  return hit === undefined ? null : hit.cidr;
}
