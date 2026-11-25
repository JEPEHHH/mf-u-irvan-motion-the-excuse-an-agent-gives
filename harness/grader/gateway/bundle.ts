// The gateway forwarder as one file: esbuild bundles grader/gateway/main.ts, with every module it
// imports inlined, into gateway.mjs (an ES module for Node 22 whose only imports are Node's
// built-ins). The forwarder container mounts the bundle's directory read-only at /bot and runs
// `node /bot/gateway.mjs` (grader/gateway/main.ts says what it reads and writes).
//
//   gatewayBundle({cacheDir})   the bundle in <cacheDir>/gateway-<source_digest>/: built there once,
//                               then reused by every trial and every process while the digest holds
//   buildGatewayBundle()        a fresh build in memory (what the cache stores)
//   gatewaySourceDigest()       the digest that names it
//
// The source digest is sha256 over this format, the entry, the Node target, the esbuild version, the
// version of each package the bundle may inline (GATEWAY_BUNDLE_PACKAGES) and grader/version.ts
// sourceDigest of GATEWAY_BUNDLE_SOURCES (every .ts and .json under them: this file included, so a
// change to how it builds names a new bundle too). A build that reads any file outside those sources
// and packages is refused, so the digest always covers everything the bundle holds. The sources
// (grader/gateway/, grader/dialect.ts, contracts/, sim/, pricing/ and server/blobstore.ts) are all harness sources
// (grader/version.ts HARNESS_SOURCES: grader/, sim/, contracts/, pricing/, server/blobstore.ts and
// server/repos/index-tar.ts), so harness_version moves whenever the bundle may.
//
// The cached directory holds gateway.mjs (0444) and bundle.json (GATEWAY_BUNDLE_FORMAT: digest,
// sha256, size, esbuild version, inputs); a directory whose gateway.mjs no longer hashes to its
// manifest's sha256 is rebuilt. It is written beside its final name and renamed into place, so a
// reader never sees half of one and concurrent builders converge on one.
//
// The same sources and esbuild version make the same bytes wherever the checkout sits: module paths
// in the bundle's comments are relative to the project root, links (a worktree's node_modules) are
// not followed, and nothing names the machine or the time.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { join } from 'node:path';
import { PROJECT_ROOT, sourceDigest, sourceFiles } from '../version.ts';

export const GATEWAY_BUNDLE_FORMAT = 'agent-fun/gateway-bundle/v1';
/** The forwarder's entry module, relative to the project root. */
export const GATEWAY_ENTRY = 'grader/gateway/main.ts';
/** The bundle's file name in its directory: the script the forwarder container runs from /bot. */
export const GATEWAY_BUNDLE_FILE = 'gateway.mjs';
export const GATEWAY_MANIFEST_FILE = 'bundle.json';
/** The Node the bundle runs on (the harness runtimes' node22). */
export const GATEWAY_NODE_TARGET = 'node22';
/** What the bundle may inline from the checkout (files or directories, relative to the project root). */
export const GATEWAY_BUNDLE_SOURCES: readonly string[] = Object.freeze(['grader/gateway', 'grader/dialect.ts', 'contracts', 'sim', 'pricing', 'server/blobstore.ts']);
/** The packages it may inline, each named by its version in the digest. */
export const GATEWAY_BUNDLE_PACKAGES: readonly string[] = Object.freeze(['zod']);

export class GatewayBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayBundleError';
  }
}

/** A fresh build, in memory. */
export interface BuiltGatewayBundle {
  bytes: Buffer;
  /** sha256 of `bytes`, lowercase hex. */
  sha256: string;
  /** Every file esbuild read, relative to the project root ('/'-separated), sorted. */
  inputs: string[];
  esbuild: string;
}

/** The bundle where a forwarder container mounts it from. */
export interface GatewayBundle {
  /** The directory to mount read-only at /bot (a SandboxSpec codeDir). */
  dir: string;
  /** The script in it (a SandboxSpec script): GATEWAY_BUNDLE_FILE. */
  script: string;
  /** dir/script. */
  path: string;
  sha256: string;
  size: number;
  source_digest: string;
  esbuild: string;
  inputs: string[];
  /** True when an earlier build was reused. */
  cached: boolean;
}

type Esbuild = typeof import('esbuild');

async function loadEsbuild(): Promise<Esbuild> {
  try {
    return await import('esbuild');
  } catch (err) {
    throw new GatewayBundleError(`esbuild is not installed (a dependency of this package: npm ci installs it): ${(err as Error).message}`);
  }
}

const requireHere = createRequire(import.meta.url);

function packageVersion(name: string): string {
  return (requireHere(`${name}/package.json`) as { version: string }).version;
}

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

/** The digest that names the bundle (see the header). */
export function gatewaySourceDigest(): string {
  const lines = [
    `format ${GATEWAY_BUNDLE_FORMAT}`,
    `entry ${GATEWAY_ENTRY}`,
    `target ${GATEWAY_NODE_TARGET}`,
    `esbuild ${packageVersion('esbuild')}`,
    ...GATEWAY_BUNDLE_PACKAGES.map((p) => `package ${p} ${packageVersion(p)}`),
    `sources ${sourceDigest(GATEWAY_BUNDLE_SOURCES)}`,
  ];
  return sha256(`${lines.join('\n')}\n`);
}

/** The package a node_modules path is in ('zod', '@scope/name'), or null. */
function packageOf(input: string): string | null {
  const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  return m === null ? null : m[1]!;
}

/** Build the bundle in memory. Throws GatewayBundleError when it cannot be built or reads outside its sources. */
export async function buildGatewayBundle(): Promise<BuiltGatewayBundle> {
  const esbuild = await loadEsbuild();
  const version = packageVersion('esbuild');
  let result: Awaited<ReturnType<Esbuild['build']>>;
  try {
    result = await esbuild.build({
      absWorkingDir: PROJECT_ROOT,
      entryPoints: [GATEWAY_ENTRY],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: GATEWAY_NODE_TARGET,
      outfile: GATEWAY_BUNDLE_FILE,
      write: false,
      metafile: true,
      charset: 'utf8',
      legalComments: 'eof',
      preserveSymlinks: true,
      logLevel: 'silent',
      banner: {
        js: [
          `// ${GATEWAY_BUNDLE_FILE}: the gateway forwarder, built by grader/gateway/bundle.ts from ${GATEWAY_ENTRY} with esbuild ${version}. Do not edit: rebuild it.`,
          "import { createRequire as __gatewayCreateRequire } from 'node:module';",
          'const require = __gatewayCreateRequire(import.meta.url);',
        ].join('\n'),
      },
    });
  } catch (err) {
    const errors = (err as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors;
    const detail = errors?.map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text)).join('; ') ?? (err as Error).message;
    throw new GatewayBundleError(`esbuild could not build ${GATEWAY_ENTRY}: ${detail}`);
  }
  const out = result.outputFiles?.find((f) => f.path.endsWith('.mjs'));
  if (out === undefined) throw new GatewayBundleError('esbuild wrote no bundle');
  const meta = result.metafile!;
  const externals = [...new Set(Object.values(meta.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path)))];
  const foreign = externals.filter((x) => !isBuiltin(x));
  if (foreign.length > 0) throw new GatewayBundleError(`the bundle would import ${foreign.join(', ')} from outside itself`);
  const inputs = Object.keys(meta.inputs)
    .filter((p) => !p.includes(':'))
    .map((p) => p.split('\\').join('/'))
    .sort();
  const covered = new Set(sourceFiles(GATEWAY_BUNDLE_SOURCES));
  const uncovered = inputs.filter((p) => {
    const pkg = packageOf(p);
    return pkg === null ? !covered.has(p) : !GATEWAY_BUNDLE_PACKAGES.includes(pkg);
  });
  if (uncovered.length > 0) {
    throw new GatewayBundleError(`the bundle reads ${uncovered.join(', ')}, which its source digest does not cover: add it to GATEWAY_BUNDLE_SOURCES or GATEWAY_BUNDLE_PACKAGES`);
  }
  const bytes = Buffer.from(out.contents);
  return { bytes, sha256: sha256(bytes), inputs, esbuild: version };
}

interface Manifest {
  format: string;
  source_digest: string;
  sha256: string;
  size: number;
  esbuild: string;
  inputs: string[];
}

/** The cached bundle in `dir` when it is whole and named `digest`, else null. */
async function readCached(dir: string, digest: string): Promise<GatewayBundle | null> {
  let manifest: Manifest;
  let bytes: Buffer;
  try {
    manifest = JSON.parse(await readFile(join(dir, GATEWAY_MANIFEST_FILE), 'utf8')) as Manifest;
    bytes = await readFile(join(dir, GATEWAY_BUNDLE_FILE));
  } catch {
    return null;
  }
  if (manifest.format !== GATEWAY_BUNDLE_FORMAT || manifest.source_digest !== digest || manifest.sha256 !== sha256(bytes) || manifest.size !== bytes.length) return null;
  return {
    dir,
    script: GATEWAY_BUNDLE_FILE,
    path: join(dir, GATEWAY_BUNDLE_FILE),
    sha256: manifest.sha256,
    size: manifest.size,
    source_digest: digest,
    esbuild: manifest.esbuild,
    inputs: manifest.inputs,
    cached: true,
  };
}

async function bundleIn(cacheDir: string): Promise<GatewayBundle> {
  const digest = gatewaySourceDigest();
  const dir = join(cacheDir, `gateway-${digest}`);
  const cached = await readCached(dir, digest);
  if (cached !== null) return cached;
  const built = await buildGatewayBundle();
  await mkdir(cacheDir, { recursive: true });
  const tmp = join(cacheDir, `.gateway-${digest}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  const manifest: Manifest = { format: GATEWAY_BUNDLE_FORMAT, source_digest: digest, sha256: built.sha256, size: built.bytes.length, esbuild: built.esbuild, inputs: built.inputs };
  try {
    await mkdir(tmp);
    await writeFile(join(tmp, GATEWAY_BUNDLE_FILE), built.bytes, { mode: 0o444 });
    await writeFile(join(tmp, GATEWAY_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
    await chmod(tmp, 0o755);
    // A stale or broken directory under the name goes first; a whole one another builder just
    // renamed into place is kept, and this build dropped.
    if ((await readCached(dir, digest)) === null) await rm(dir, { recursive: true, force: true });
    try {
      await rename(tmp, dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM') throw err;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const placed = await readCached(dir, digest);
  if (placed === null) throw new GatewayBundleError(`the bundle in ${dir} is not whole after it was written`);
  return { ...placed, cached: false };
}

const memo = new Map<string, Promise<GatewayBundle>>();

/** The bundle under `cacheDir` (see the header), once per process and cache directory. */
export function gatewayBundle(opts: { cacheDir: string }): Promise<GatewayBundle> {
  let p = memo.get(opts.cacheDir);
  if (p === undefined) {
    p = bundleIn(opts.cacheDir);
    memo.set(opts.cacheDir, p);
    p.catch(() => {
      if (memo.get(opts.cacheDir) === p) memo.delete(opts.cacheDir);
    });
  }
  return p;
}

/** Forget the process's bundles: the next gatewayBundle() looks at its cache directory again. */
export function forgetGatewayBundle(): void {
  memo.clear();
}
