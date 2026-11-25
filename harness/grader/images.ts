// The images the sandbox runs, pinned by digest in grader/images.json. The runtime images, which entries run in:
//
//   node22       node:22-slim     `node /bot/main.ts` (Node >= 22.18 strips types natively)
//   python3.13   python:3.13-slim `python3 -P -s /bot/main.py` with PYTHONHASHSEED=0
//
// and, beside them under the key `agent` (AGENT_IMAGE_KEY, never a runtime: imageFor takes runtimes alone,
// agentImage() this one), the house agent's image: sandbox-agent/Dockerfile, makefun-agent (agent/v1) on debian slim
// with perl-base, which a sandbox pod's `stage` and `watch` containers run. Its image is
// ghcr.io/makedotfun/makefun-agent, its tag the commit it was built from (the agent-image workflow tags each build by
// that 40-character sha, write-once), its version the crate's (sandbox-agent/Cargo.toml, what `makefun-agent version`
// prints). The table holds no agent entry until a build has a digest to pin; agentImage() refuses until then.
//
// Each digest is the OCI image INDEX digest (multi-arch: the same pin runs on arm64 and amd64; the agent image is
// built for linux/amd64 alone, under an index all the same), as `docker pull <image>:<tag>` then
// `docker image inspect --format '{{json .Descriptor}}'` report it (the agent's: its build's run summary). The sandbox
// runs `<image>@<digest>`, never a tag, so what runs is what the pin names and nothing resolves a moving tag. Nothing
// pre-pulls the table onto a host: the docker sandbox pulls an image its daemon lacks by that digest
// (DockerSandbox.preflight, then `--pull missing` on the run: grader/sandbox/docker.ts PULL_POLICY), and on k8s a node
// pulls an image it lacks by that digest once (imagePullPolicy IfNotPresent, through the registry's pull Secret:
// grader/sandbox/k8s.ts's header), the preflight pod proving the pull. To move a runtime pin:
// pull the tag, inspect it, update the entry (digest, version, resolved_at) and re-run
// tests/integration/docker-sandbox.test.ts, which checks the interpreter version inside each image. This file and
// images.json are harness sources (grader/version.ts), so moving any pin, the agent's included, names a new
// harness_version.

import { z } from 'zod';
import { IsoDateTime } from '../contracts/primitives.ts';
import { RUNTIMES } from '../contracts/competition.ts';
import type { Runtime } from './sandbox/types.ts';
import imagesJson from './images.json' with { type: 'json' };

export const IMAGES_FORMAT = 'agent-fun/images/v1';

export const ImageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256:<64 hex>');

export const ImageEntry = z.strictObject({
  /** Repository, e.g. `node` (Docker Hub library images) or `ghcr.io/org/name`. */
  image: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/, 'expected a lowercase image repository'),
  /** The tag the digest was resolved from (documentation only: the sandbox never runs a tag). */
  tag: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/),
  digest: ImageDigest,
  /**
   * The version of what the image carries: a runtime's interpreter (node --version without the v; python3 --version),
   * the agent image's makefun-agent (sandbox-agent/Cargo.toml's package version).
   */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  resolved_at: IsoDateTime,
});

/** The key of the agent image's entry in the table's `images`, beside the runtimes' (the header). */
export const AGENT_IMAGE_KEY = 'agent';
if ((RUNTIMES as readonly string[]).includes(AGENT_IMAGE_KEY)) throw new Error(`grader/images.ts: "${AGENT_IMAGE_KEY}" is a runtime`);

/** The agent image: its own repository, tagged by the full commit sha it was built from. */
export const AgentImageEntry = ImageEntry.extend({
  image: z.literal('ghcr.io/makedotfun/makefun-agent'),
  tag: z.string().regex(/^[0-9a-f]{40}$/, 'expected the full 40-character commit sha the image was built from'),
});

export const ImageTable = z.strictObject({
  format: z.literal(IMAGES_FORMAT),
  images: z.strictObject({
    ...(Object.fromEntries(RUNTIMES.map((r) => [r, ImageEntry])) as Record<Runtime, typeof ImageEntry>),
    /** Absent until a build of sandbox-agent/Dockerfile has a digest to pin (agentImage). */
    [AGENT_IMAGE_KEY]: AgentImageEntry.optional(),
  }),
});

export type ImageEntryT = z.infer<typeof ImageEntry>;
export type AgentImageEntryT = z.infer<typeof AgentImageEntry>;
export type ImageTableT = z.infer<typeof ImageTable>;

/** grader/images.json, validated at load. */
export const IMAGES: ImageTableT = ImageTable.parse(imagesJson);

/** The pinned image of a runtime. */
export function imageFor(runtime: Runtime, table: ImageTableT = IMAGES): ImageEntryT {
  return table.images[runtime];
}

/** The pinned agent image (the header); throws while the table pins none. */
export function agentImage(table: ImageTableT = IMAGES): AgentImageEntryT {
  const entry = table.images[AGENT_IMAGE_KEY];
  if (entry === undefined) {
    throw new Error(
      `grader/images.json pins no ${AGENT_IMAGE_KEY} image: build sandbox-agent/Dockerfile (the agent-image workflow) and pin the digest its run prints`,
    );
  }
  return entry;
}

/** `<image>@sha256:<hex>`: the only form the sandbox runs (a digest, never a tag). */
export function imageRef(entry: Pick<ImageEntryT, 'image'>, digest: string): string {
  ImageDigest.parse(digest);
  return `${entry.image}@${digest}`;
}

/** The lowest Node the node22 runtime may carry: type stripping is on by default from 22.18. */
export const MIN_NODE_VERSION = [22, 18, 0] as const;

/** True when `version` ("22.23.4" or "v22.23.4") is at least `min`. */
export function versionAtLeast(version: string, min: readonly [number, number, number]): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== min[i]!) return v[i]! > min[i]!;
  }
  return true;
}
