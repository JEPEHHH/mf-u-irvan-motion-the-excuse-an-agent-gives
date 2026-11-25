// Rehost: an open bounty on an upstream GitHub issue that the house runs as a patch/v1 competition,
// and the accord its upstream owner ratifies.
//
//   Rehost            the bundle's block (competition.rehost: contracts/competition.ts, re-exported
//                     here): the upstream issue and its bounty (RehostUpstream), the sha256 of the
//                     accord (accordSha256), when the house submits upstream, how many days the owner
//                     reviews, and the house's cost of running it
//   RehostAccord      agent-fun/rehost-accord/v1, the terms the owner ratifies: the template version,
//                     the slug, the upstream (as the bundle names it), the payee (the house), the owner,
//                     the issue's reservation, the grader (the patch/v1 harness's repo, image, test argv
//                     and pack trees, and the digests of the final lists), the acceptance terms (the
//                     review window, silence as acceptance, the only grounds a patch may be rejected on,
//                     a regression window and its penalty) and the waivers of the program's own-work and
//                     automation clauses (each a literal true)
//   RehostAcceptance  how the owner accepted it: the transport, a reference (a URL or a sha256), the
//                     words quoted, when, and by whom
//   AccordFile        competitions/<slug>/accord.json: the accord, and its acceptance (null until the
//                     owner accepts)
//
// accord.json lives in git beside the bundle, so the accord carries the digests of the hidden lists
// (accordListsSha256), never their ids: a pack never enters git, and the owner reads the plaintext lists
// in the drafted terms, which are never committed either.
//
// The bundle's block is contracts/competition.ts's so the bundle contract stays zod only and
// browser-safe: this module hashes (accordSha256: sim/canonical.ts, node:crypto), so it is Node's, as
// contracts/program-dataset.ts is, and contracts/index.ts does not export it.

import { z } from 'zod';
import { canonicalSha256 } from '../sim/canonical.ts';
import { HttpsUrl, REHOST_MAX_REVIEW_DAYS, RehostUpstream } from './competition.ts';
import { PatchImage, PatchPhaseTree, PatchRepo, PatchTest, type PatchListsT } from './patch.ts';
import { IsoDateTime, Sha256Hex, Slug } from './primitives.ts';

export {
  HttpsUrl,
  isHttpsUrl,
  REHOST_MAX_REVIEW_DAYS,
  REHOST_OPS_COST_USD,
  REHOST_PLATFORMS,
  Rehost,
  RehostPlatform,
  RehostUpstream,
  UsdDecimal,
  type RehostT,
  type RehostUpstreamT,
} from './competition.ts';

/** Run a refinement only on a value whose shape already parsed. */
const whenValid = { when: (payload: { issues: readonly unknown[] }): boolean => payload.issues.length === 0 };

export const REHOST_ACCORD_SCHEMA = 'agent-fun/rehost-accord/v1';

/**
 * The only grounds the upstream owner may reject a patch on (RehostAccord.acceptance.rejection_grounds
 * names a subset): it fails the owner's own CI; its license or a CLA the house cannot sign; malicious
 * code; a test the owner adds that it fails (a counterexample).
 */
export const REHOST_REJECTION_GROUNDS = ['fails_owner_ci', 'license_or_cla', 'malicious_code', 'counterexample_test'] as const;
export const RehostRejectionGround = z.enum(REHOST_REJECTION_GROUNDS);

/** The longest regression window after acceptance, in days (RehostAccord.acceptance.regression). */
export const REHOST_MAX_REGRESSION_WINDOW_DAYS = 30;

/** The largest share of the bounty a regression inside its window forfeits, in percent. */
export const REHOST_MAX_REGRESSION_PENALTY_PCT = 50;

/** How the owner accepted the accord (RehostAcceptance.transport). */
export const REHOST_ACCEPTANCE_TRANSPORTS = ['signed', 'program-terms', 'issue-comment', 'house-dry-run'] as const;
export const RehostAcceptanceTransport = z.enum(REHOST_ACCEPTANCE_TRANSPORTS);

/** A GitHub login: 1 to 39 letters, digits or hyphens, not starting with a hyphen (as patch.ts reads a repo's owner). */
export const GitHubLogin = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, 'expected a GitHub login: 1 to 39 letters, digits or hyphens, not starting with a hyphen');

/** A name or a role on one line: not blank, no line break. */
const Line = z
  .string()
  .max(200)
  .refine((s) => /\S/.test(s) && !/[\r\n\u2028\u2029]/.test(s), 'one line: not blank, no line break');

/**
 * The grader the owner ratifies: the bundle's patch/v1 harness's repo (its URL, base commit and base
 * tree), image, test argv and the pack's dev and final trees, with the digests of the final phase's
 * fail_to_pass and pass_to_pass lists (accordListsSha256) in place of the hidden ids.
 */
export const RehostGrader = z
  .strictObject({
    repo: PatchRepo,
    image: PatchImage,
    test: PatchTest.pick({ argv: true }),
    f2p_ids_sha256: Sha256Hex,
    p2p_ids_sha256: Sha256Hex,
    pack: z.strictObject({ dev: PatchPhaseTree, final: PatchPhaseTree }),
  })
  .superRefine((g, ctx) => {
    if (g.pack.final.tree_sha256 === g.pack.dev.tree_sha256) {
      ctx.addIssue({ code: 'custom', path: ['pack', 'final', 'tree_sha256'], message: 'the final tree is the dev tree: the final phase grades hidden tests the dev tree does not hold' });
    }
    if (g.p2p_ids_sha256 === g.f2p_ids_sha256) {
      ctx.addIssue({ code: 'custom', path: ['p2p_ids_sha256'], message: 'is f2p_ids_sha256: the final fail_to_pass is never empty and the lists are disjoint, so their digests differ' });
    }
  }, whenValid);

/** The terms on which the owner accepts a patch. */
export const RehostAcceptanceTerms = z
  .strictObject({
    /** Days the owner reviews a submitted patch (Rehost.review_days). */
    review_days: z.int().min(1).max(REHOST_MAX_REVIEW_DAYS),
    /** A patch the owner has not rejected when review_days run out is accepted. */
    silence_is_acceptance: z.literal(true),
    /** The only grounds a rejection may name: each at most once, in REHOST_REJECTION_GROUNDS's order. */
    rejection_grounds: z.array(RehostRejectionGround).max(REHOST_REJECTION_GROUNDS.length),
    /** A regression the accepted patch causes within window_days forfeits penalty_pct of the bounty. */
    regression: z.strictObject({
      window_days: z.int().min(0).max(REHOST_MAX_REGRESSION_WINDOW_DAYS),
      penalty_pct: z.int().min(0).max(REHOST_MAX_REGRESSION_PENALTY_PCT),
    }),
  })
  .superRefine((a, ctx) => {
    a.rejection_grounds.forEach((g, i) => {
      if (i > 0 && REHOST_REJECTION_GROUNDS.indexOf(g) <= REHOST_REJECTION_GROUNDS.indexOf(a.rejection_grounds[i - 1]!)) {
        ctx.addIssue({ code: 'custom', path: ['rejection_grounds', i], message: `each ground at most once, in the order ${REHOST_REJECTION_GROUNDS.join(', ')}` });
      }
    });
  }, whenValid);

/**
 * What the owner accepts of a rehosted patch, each a literal true: an AI agent built it, a competitor
 * (not the house) wrote it, and the program's own-work and automation clauses do not apply to it.
 */
export const RehostWaivers = z.strictObject({
  ai_built_work_accepted: z.literal(true),
  third_party_work_accepted: z.literal(true),
  own_work_clause_waived: z.literal(true),
  automation_clause_waived: z.literal(true),
});

/**
 * The accord (agent-fun/rehost-accord/v1): what the upstream owner ratifies, hashed into the bundle's
 * rehost.accord_sha256 (accordSha256). The payee is the house, the party the bounty pays; the owner is
 * the upstream maintainer who accepts; the reservation is the issue's assignment to the house until a
 * time. Its grader's repo is the upstream's.
 */
export const RehostAccord = z
  .strictObject({
    schema: z.literal(REHOST_ACCORD_SCHEMA),
    template_version: Line,
    slug: Slug,
    upstream: RehostUpstream,
    payee: z.strictObject({ legal_name: Line, github_login: GitHubLogin }),
    owner: z.strictObject({ name: Line, github_login: GitHubLogin, role: Line }),
    reservation: z.strictObject({ assignee_login: GitHubLogin, until: IsoDateTime }),
    grader: RehostGrader,
    acceptance: RehostAcceptanceTerms,
    waivers: RehostWaivers,
  })
  .superRefine((a, ctx) => {
    const repo = `https://github.com/${a.upstream.repo}`;
    if (a.grader.repo.url !== repo) {
      ctx.addIssue({ code: 'custom', path: ['grader', 'repo', 'url'], message: `the grader grades the upstream's repo, ${repo}: not ${a.grader.repo.url}` });
    }
  }, whenValid);
export type RehostAccordT = z.infer<typeof RehostAccord>;

/**
 * How the owner accepted the accord: 'signed' (a signed copy), 'program-terms' (the bounty program's own
 * terms), 'issue-comment' (a comment on the upstream issue), or 'house-dry-run' (the house accepting its
 * own accord, in a rehearsal); ref is where the acceptance is (a URL) or its sha256, quote its words.
 */
export const RehostAcceptance = z.strictObject({
  transport: RehostAcceptanceTransport,
  ref: z.union([Sha256Hex, HttpsUrl]),
  quote: z.string().refine((s) => /\S/.test(s), 'the words of the acceptance: not blank'),
  accepted_at: IsoDateTime,
  accepted_by: Line,
});
export type RehostAcceptanceT = z.infer<typeof RehostAcceptance>;

/** competitions/<slug>/accord.json: the accord, and the owner's acceptance of it (null until then). */
export const AccordFile = z.strictObject({
  accord: RehostAccord,
  acceptance: RehostAcceptance.nullable(),
});
export type AccordFileT = z.infer<typeof AccordFile>;

/** The accord's sha256 (Rehost.accord_sha256): the canonical JSON of the accord. */
export function accordSha256(accord: RehostAccordT): string {
  return canonicalSha256(accord);
}

/** The grader's list digests (RehostGrader): the final phase lists.json's fail_to_pass and pass_to_pass, each as canonical JSON. */
export function accordListsSha256(final: PatchListsT): { f2p_ids_sha256: string; p2p_ids_sha256: string } {
  return { f2p_ids_sha256: canonicalSha256(final.fail_to_pass), p2p_ids_sha256: canonicalSha256(final.pass_to_pass) };
}
