// patch/v1's scorer: a run log (grader/patch/junit.ts PatchRunLog, one status per ratified test id)
// read against its phase's lists.json into the run's PatchPerformance (contracts/patch.ts). The
// statuses split back into the four lists by their lengths, in ratifiedIds order: fail_to_pass,
// pass_to_pass, then the canaries must_fail and must_pass.
//
//   f2p, p2p   the fail-to-pass and pass-to-pass tests that passed (P) of those listed; a failed
//              (F), skipped (S) or missing (M) test did not pass
//   tampered   the patch applied and a must_fail canary passed or a must_pass canary did not, or the
//              tests' exit status contradicts their report (the log's exit_check, patchExitCheck): the
//              run is not the ratified tests' honest verdict. A patch that did not apply ran nothing
//              (every status M), so it tampered with nothing. The report is the run's own (the code
//              under test runs as the tests do and can write it), so the canaries hold only while the
//              run cannot tell them from the rest (the lists stay host-side: execute.ts mounts the
//              phase's overlay alone at /tests), and the exit check holds the report to the exit
//              status the house's runner (runner/run.sh) saw, as SWE-bench's harness reads the run's
//              own status beside its log: a forger that writes the report must end the tests with
//              the exit it implies, not by a signal (killing the runner) or with exit 0 beside the
//              canary failures it cannot tell from its own
//   resolved   applied, not tampered, and every fail-to-pass and pass-to-pass test passed
//              (contracts/patch.ts patchResolved, the gate): scores.resolved and passed
//
// Counts only: the performance names no test, as the final lists are sealed. A log whose statuses
// do not number the lists' ids is another phase's (or a fault), refused with an Error naming the two
// counts, never an id.

import { patchPerformanceOf, type PatchListsT, type PatchPerformanceT, type PatchTallyT } from '../../contracts/patch.ts';
import { PatchRunLog, type JunitReport, type PatchExitCheckT, type PatchRunLogT } from './junit.ts';

/** A run's statuses split by list, each a run of P F S M in its lists.json order. */
export interface PatchRunStatuses {
  fail_to_pass: string;
  pass_to_pass: string;
  must_fail: string;
  must_pass: string;
}

/** Split a run log's statuses by the lists it ran under; throws when their counts disagree. */
export function patchRunStatuses(lists: PatchListsT, log: Pick<PatchRunLogT, 'statuses'>): PatchRunStatuses {
  const lengths = [lists.fail_to_pass.length, lists.pass_to_pass.length, lists.canaries.must_fail.length, lists.canaries.must_pass.length];
  const total = lengths.reduce((a, b) => a + b, 0);
  if (log.statuses.length !== total) {
    throw new Error(`the run log holds ${log.statuses.length} statuses where its lists ratify ${total} tests: a log of other lists`);
  }
  const [f2p, p2p, mustFail] = lengths as [number, number, number, number];
  const s = log.statuses;
  return {
    fail_to_pass: s.slice(0, f2p),
    pass_to_pass: s.slice(f2p, f2p + p2p),
    must_fail: s.slice(f2p + p2p, f2p + p2p + mustFail),
    must_pass: s.slice(f2p + p2p + mustFail),
  };
}

const tally = (statuses: string): PatchTallyT => ({ passed: statuses.split('P').length - 1, total: statuses.length });

/** Whether a run's canaries caught tampering: an applied patch's must_fail canary passed, or its must_pass canary did not. */
export function patchTampered(applied: boolean, s: Pick<PatchRunStatuses, 'must_fail' | 'must_pass'>): boolean {
  return applied && (s.must_fail.includes('P') || /[^P]/.test(s.must_pass));
}

/**
 * How a run's tests ended against the report they left (junit.ts PatchExitCheck), from run.sh's frame:
 * the exit code (null: no test ran) and the signal that ended them (null: none). A signal is never the
 * tests' own verdict, report or none; exit 0 holds only beside a report in which no testcase failed, a
 * non-zero exit only beside one in which some testcase did (any testcase: unnamed, unlisted, a canary).
 * null when there is nothing to hold the exit against: no test ran, or no report was read (every
 * status is M then, so nothing resolves either way). An honest final run fails its must_fail canaries,
 * so it exits non-zero: consistent.
 */
export function patchExitCheck(run: { exit: number | null; signal: number | null }, report: Pick<JunitReport, 'failed'> | null): PatchExitCheckT | null {
  if (run.signal !== null) return 'signal';
  if (run.exit === null || report === null) return null;
  if (run.exit === 0) return report.failed ? 'exit_zero_with_failure' : 'consistent';
  return report.failed ? 'consistent' : 'exit_nonzero_without_failure';
}

/** Whether a run log's exit check caught tampering: its tests' exit contradicts their report. A log with none (the header) passes. */
export function patchExitContradicts(log: Pick<PatchRunLogT, 'exit_check'>): boolean {
  return log.exit_check !== undefined && log.exit_check !== 'consistent';
}

/**
 * Score one run (the header). The log is parsed again (a stored one, read back for a regrade, is
 * data); throws (zod) on a log no run writes and (Error) on one of other lists.
 */
export function scorePatch(lists: PatchListsT, log: PatchRunLogT): PatchPerformanceT {
  const run = PatchRunLog.parse(log);
  const s = patchRunStatuses(lists, run);
  return patchPerformanceOf({
    refused: run.refused,
    tampered: patchTampered(run.applied, s) || patchExitContradicts(run),
    f2p: tally(s.fail_to_pass),
    p2p: tally(s.pass_to_pass),
  });
}
