// Canonical JSON per RFC 8785 (JSON Canonicalization Scheme): the ONE implementation the sim, the
// grader and the API hash with (result_sha256, action_log_sha256, dataset manifests).
//
//   - no whitespace; object properties sorted recursively by their UTF-16 code units (unsigned
//     value comparison, shorter prefix first); array order kept
//   - strings serialized as ECMAScript JSON.stringify does (\b \t \n \f \r, other U+0000-U+001F as
//     lowercase \u00hh, \" and \\, everything else as is); a lone surrogate is an error
//   - numbers serialized as ECMAScript Number-to-String (JSON.stringify), -0 as 0; NaN and
//     Infinity are errors
//   - the output is UTF-8 encoded before hashing
//
// Input is JSON data only: null, booleans, finite numbers, strings, arrays and plain objects. Anything
// else (undefined, bigint, functions, symbols, Date, Map, class instances, sparse array holes) is
// refused with CanonicalJsonError naming its path, so a hash never silently drops or coerces a
// value. Large integers travel as decimal strings (RFC 8785 Appendix D), as every contract here does.

import { createHash } from 'node:crypto';

export class CanonicalJsonError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

/** Code-unit comparison (what Array.prototype.sort does by default for strings), spelled out. */
export function compareCodeUnits(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function serializeString(s: string, path: string): string {
  if (hasLoneSurrogate(s)) throw new CanonicalJsonError('lone surrogate in string', path);
  return JSON.stringify(s);
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string, out: string[], seen: Set<object>): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`${value} is not a JSON number`, path);
      out.push(JSON.stringify(value));
      return;
    case 'string':
      out.push(serializeString(value, path));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`${typeof value} is not JSON data`, path);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError('cycle', path);
  seen.add(obj);
  if (Array.isArray(obj)) {
    out.push('[');
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) throw new CanonicalJsonError('sparse array hole', `${path}[${i}]`);
      if (i > 0) out.push(',');
      serialize(obj[i], `${path}[${i}]`, out, seen);
    }
    out.push(']');
  } else {
    if (!isPlainObject(obj)) throw new CanonicalJsonError(`${obj.constructor?.name ?? 'exotic object'} is not a plain object`, path);
    if (Object.getOwnPropertySymbols(obj).length > 0) throw new CanonicalJsonError('symbol-keyed property', path);
    const keys = Object.keys(obj).sort(compareCodeUnits);
    out.push('{');
    keys.forEach((k, i) => {
      if (i > 0) out.push(',');
      const childPath = `${path}.${k}`;
      out.push(serializeString(k, childPath), ':');
      serialize((obj as Record<string, unknown>)[k], childPath, out, seen);
    });
    out.push('}');
  }
  seen.delete(obj);
}

/** The RFC 8785 canonical form of JSON data, as a string. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  serialize(value, '$', out, new Set());
  return out.join('');
}

/** The canonical form, UTF-8 encoded: the bytes that get hashed. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/** Lowercase hex sha256 of bytes or of a string's UTF-8 encoding. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 (hex) of the canonical form: result_sha256, action_log_sha256 and friends. */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

/** True when `text` is already exactly the canonical form of the JSON it holds. */
export function isCanonicalJson(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  try {
    return canonicalJson(parsed) === text;
  } catch {
    return false;
  }
}
