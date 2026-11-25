// The scrape gateway as one file: esbuild bundles grader/scrape/gateway-main.ts, with gateway.ts and
// ca.ts inlined, into scrape-gateway.mjs (an ES module for Node 22 whose only imports are Node's
// built-ins). The gateway container mounts the bundle's directory read-only at /bot in the pinned
// node22 image and runs `node /bot/scrape-gateway.mjs` (grader/scrape/gateway-main.ts says what it
// reads and writes). It is shaped as grader/gateway/bundle.ts is:
//
//   scrapeGatewayBundle({cacheDir})   the bundle in <cacheDir>/scrape-gateway-<source_digest>/: built
//                                     there once, then reused by every trial and every process while
//                                     the digest holds
//   buildScrapeGatewayBundle()        a fresh build in memory (what the cache stores)
//   scrapeGatewaySourceDigest()       the digest that names it
//
// The source digest is sha256 over this format, the entry, the Node target, the esbuild version and
// grader/version.ts sourceDigest of SCRAPE_GATEWAY_BUNDLE_SOURCES: grader/scrape/ca.ts, gateway.ts,
// gateway-main.ts and this file (so a change to how it builds names a new bundle too), and nothing
// else. The gateway is stdlib only: it inlines no package and no other repository code (not
// contracts/, not the launcher beside it), and a build that reads any file outside those sources is
// refused, so the digest always covers everything the bundle holds. All of them sit under grader/, a
// harness source (grader/version.ts HARNESS_SOURCES), so harness_version moves whenever the bundle
// may.
//
// The cached directory holds scrape-gateway.mjs (0444) and bundle.json (SCRAPE_GATEWAY_BUNDLE_FORMAT:
// digest, sha256, size, esbuild version, inputs); a directory whose bundle no longer hashes to its
// manifest's sha256 is rebuilt. It is written beside its final name and renamed into place, so a
// reader never sees half of one and concurrent builders converge on one. The same sources and
// esbuild version make the same bytes wherever the checkout sits.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { join } from 'node:path';
import { sealStaged, STAGED_OWNER_DIRS } from '../program.ts';
import { PROJECT_ROOT, sourceDigest, sourceFiles } from '../version.ts';

export const SCRAPE_GATEWAY_BUNDLE_FORMAT = 'agent-fun/scrape-gateway-bundle/v1';
/** The gateway's entry module, relative to the project root. */
export const SCRAPE_GATEWAY_ENTRY = 'grader/scrape/gateway-main.ts';
/** The bundle's file name in its directory: the script the gateway container runs from /bot. */
export const SCRAPE_GATEWAY_BUNDLE_FILE = 'scrape-gateway.mjs';
export const SCRAPE_GATEWAY_MANIFEST_FILE = 'bundle.json';
/** The Node the bundle runs on (the harness runtimes' node22). */
export const SCRAPE_GATEWAY_NODE_TARGET = 'node22';
/** Every file the bundle may inline, relative to the project root. */
export const SCRAPE_GATEWAY_BUNDLE_SOURCES: readonly string[] = Object.freeze(['grader/scrape/ca.ts', 'grader/scrape/gateway.ts', 'grader/scrape/gateway-main.ts', 'grader/scrape/bundle.ts']);

export class ScrapeGatewayBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrapeGatewayBundleError';
  }
}

/** A fresh build, in memory. */
export interface BuiltScrapeGatewayBundle {
  bytes: Buffer;
  /** sha256 of `bytes`, lowercase hex. */
  sha256: string;
  /** Every file esbuild read, relative to the project root ('/'-separated), sorted. */
  inputs: string[];
  esbuild: string;
}

/** The bundle where a gateway container mounts it from. */
export interface ScrapeGatewayBundle {
  /** The directory to mount read-only at /bot. */
  dir: string;
  /** The script in it: SCRAPE_GATEWAY_BUNDLE_FILE. */
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
    throw new ScrapeGatewayBundleError(`esbuild is not installed (a dependency of this package: npm ci installs it): ${(err as Error).message}`);
  }
}

const requireHere = createRequire(import.meta.url);

function esbuildVersion(): string {
  return (requireHere('esbuild/package.json') as { version: string }).version;
}

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

/** The digest that names the bundle (see the header). */
export function scrapeGatewaySourceDigest(): string {
  const lines = [
    `format ${SCRAPE_GATEWAY_BUNDLE_FORMAT}`,
    `entry ${SCRAPE_GATEWAY_ENTRY}`,
    `target ${SCRAPE_GATEWAY_NODE_TARGET}`,
    `esbuild ${esbuildVersion()}`,
    `sources ${sourceDigest(SCRAPE_GATEWAY_BUNDLE_SOURCES)}`,
  ];
  return sha256(`${lines.join('\n')}\n`);
}

/** Build the bundle in memory. Throws ScrapeGatewayBundleError when it cannot be built or reads outside its sources. */
export async function buildScrapeGatewayBundle(): Promise<BuiltScrapeGatewayBundle> {
  const esbuild = await loadEsbuild();
  const version = esbuildVersion();
  let result: Awaited<ReturnType<Esbuild['build']>>;
  try {
    result = await esbuild.build({
      absWorkingDir: PROJECT_ROOT,
      entryPoints: [SCRAPE_GATEWAY_ENTRY],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: SCRAPE_GATEWAY_NODE_TARGET,
      outfile: SCRAPE_GATEWAY_BUNDLE_FILE,
      write: false,
      metafile: true,
      charset: 'utf8',
      legalComments: 'eof',
      preserveSymlinks: true,
      logLevel: 'silent',
      banner: {
        js: `// ${SCRAPE_GATEWAY_BUNDLE_FILE}: the scrape gateway, built by grader/scrape/bundle.ts from ${SCRAPE_GATEWAY_ENTRY} with esbuild ${version}. Do not edit: rebuild it.`,
      },
    });
  } catch (err) {
    const errors = (err as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors;
    const detail = errors?.map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text)).join('; ') ?? (err as Error).message;
    throw new ScrapeGatewayBundleError(`esbuild could not build ${SCRAPE_GATEWAY_ENTRY}: ${detail}`);
  }
  const out = result.outputFiles?.find((f) => f.path.endsWith('.mjs'));
  if (out === undefined) throw new ScrapeGatewayBundleError('esbuild wrote no bundle');
  const meta = result.metafile!;
  const externals = [...new Set(Object.values(meta.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path)))];
  const foreign = externals.filter((x) => !isBuiltin(x));
  if (foreign.length > 0) throw new ScrapeGatewayBundleError(`the bundle would import ${foreign.join(', ')} from outside itself`);
  const inputs = Object.keys(meta.inputs)
    .filter((p) => !p.includes(':'))
    .map((p) => p.split('\\').join('/'))
    .sort();
  const covered = new Set(sourceFiles(SCRAPE_GATEWAY_BUNDLE_SOURCES));
  const uncovered = inputs.filter((p) => !covered.has(p));
  if (uncovered.length > 0) {
    throw new ScrapeGatewayBundleError(`the bundle reads ${uncovered.join(', ')}, which its source digest does not cover: the gateway is stdlib only (SCRAPE_GATEWAY_BUNDLE_SOURCES)`);
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
async function readCached(dir: string, digest: string): Promise<ScrapeGatewayBundle | null> {
  let manifest: Manifest;
  let bytes: Buffer;
  try {
    manifest = JSON.parse(await readFile(join(dir, SCRAPE_GATEWAY_MANIFEST_FILE), 'utf8')) as Manifest;
    bytes = await readFile(join(dir, SCRAPE_GATEWAY_BUNDLE_FILE));
  } catch {
    return null;
  }
  if (manifest.format !== SCRAPE_GATEWAY_BUNDLE_FORMAT || manifest.source_digest !== digest || manifest.sha256 !== sha256(bytes) || manifest.size !== bytes.length) return null;
  return {
    dir,
    script: SCRAPE_GATEWAY_BUNDLE_FILE,
    path: join(dir, SCRAPE_GATEWAY_BUNDLE_FILE),
    sha256: manifest.sha256,
    size: manifest.size,
    source_digest: digest,
    esbuild: manifest.esbuild,
    inputs: manifest.inputs,
    cached: true,
  };
}

async function bundleIn(cacheDir: string): Promise<ScrapeGatewayBundle> {
  const digest = scrapeGatewaySourceDigest();
  const dir = join(cacheDir, `scrape-gateway-${digest}`);
  const cached = await readCached(dir, digest);
  if (cached !== null) return cached;
  const built = await buildScrapeGatewayBundle();
  await mkdir(cacheDir, { recursive: true });
  const tmp = join(cacheDir, `.scrape-gateway-${digest}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  const manifest: Manifest = { format: SCRAPE_GATEWAY_BUNDLE_FORMAT, source_digest: digest, sha256: built.sha256, size: built.bytes.length, esbuild: built.esbuild, inputs: built.inputs };
  try {
    await mkdir(tmp);
    await writeFile(join(tmp, SCRAPE_GATEWAY_BUNDLE_FILE), built.bytes, { mode: 0o444 });
    await writeFile(join(tmp, SCRAPE_GATEWAY_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
    // The gateway container (65534) reads the bundle from /bot: its files 0444 whatever the umask, the directory 0755
    // so a stale one is still this process's to remove (program.ts sealStaged, STAGED_OWNER_DIRS).
    await sealStaged(tmp, STAGED_OWNER_DIRS);
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
  if (placed === null) throw new ScrapeGatewayBundleError(`the bundle in ${dir} is not whole after it was written`);
  return { ...placed, cached: false };
}

const memo = new Map<string, Promise<ScrapeGatewayBundle>>();

/** The bundle under `cacheDir` (see the header), once per process and cache directory. */
export function scrapeGatewayBundle(opts: { cacheDir: string }): Promise<ScrapeGatewayBundle> {
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

/** Forget the process's bundles: the next scrapeGatewayBundle() looks at its cache directory again. */
export function forgetScrapeGatewayBundle(): void {
  memo.clear();
}
