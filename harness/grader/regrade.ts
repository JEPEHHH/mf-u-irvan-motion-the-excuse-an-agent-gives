// Regrading a stored run, two levels:
//
//   L1  re-score the stored action log (the blob named by run.action_log_sha256, verified and
//       canonical) with the plan's scorer and rebuild the score JSON from the run's recorded facts
//       (harness_version, image digest, dataset digest, seed, determinism verdict, flags) and the
//       cost and authorship passed in (under a program/v1 size count, the entry's code size too:
//       RegradeL1Request.size). Reproduced iff the new score's canonical bytes equal the
//       stored result's, whose own sha256 must still be run.result_sha256. Nothing is executed.
//       The plan must hold the run's fail key (the failed-tx draw's key, which the action log does
//       not carry): a stored fail_key that differs refuses the regrade (`fail_key`) at L1 and L2.
//   L2  re-execute the entry once from its snapshot, in the image digest the run recorded, require the
//       new action log's sha256 to equal run.action_log_sha256, then L1. Under a harness_version that is
//       not the run's (different harness code or Node version) it re-executes all the same, and reproduces
//       only on equality, flagged `harness_moved`; anything else there is inconclusive (the versions, below).
//       Under a house dossier (harnesses.ts HarnessPlan.houseDossier; grade.ts's header `The house dossier`) the run
//       recorded the log with the house's dossier at the path, never the program's own: the re-execution's log takes
//       the same step (grade.ts houseDossierLogOf, from the record the caller hands, else the stored run's, else none)
//       before it is compared, so an honest entry reproduces; a dossier missing by the house's fault throws as the
//       grade does (HouseDossierFault), never a verdict on the entry. Under house counts (HarnessPlan.houseCounts;
//       grade.ts's header `The house counts`: a YouTube video's or an X post's) it takes that step next (grade.ts
//       houseCountsLogOf), with the reading of its run's own phase (EntryFacts.entry_link_reading, the caller's: a dev
//       run's the intake check's, a final run's the deadline one, a video's read at the final lock, a post's by the
//       deadline pass after it), from the same record; counts the house cannot write throw HouseCountsFault.
//
//   The versions. What either level holds the run to is its own stamp against this process's: L2 its
//   harness_version against version.ts harnessVersion(), L1 its scorer_version as the rebuilt score
//   carries it (buildScore writes this process's, so the bytes match only under the same one). Both
//   digest code, not bytes (grader/version.ts: a comment or whitespace edit names no new harness or
//   scorer, so every run graded before such an edit still regrades; any token changed names new
//   ones, and a run graded before that re-executes at L2 under a moved harness (below), and differs at L1 at
//   $.scorer_version, which fails it unless the platform scorer's digest alone moved and the rest re-derives byte for
//   byte: below). A run graded before the digests were over code recorded its versions over bytes: when its
//   scorer_version's code digest (version.ts codeVersionOf, grader/version-history.json's table of every byte digest a
//   grader recorded) is this process's, the rebuilt score carries the run's (regradeScorerVersion), so
//   it still reproduces. L2 compares harness_version exactly, a byte digest too, and names the code digest a
//   recorded byte digest is over (recordedHarness), which shows the harness's code moved.
//   The harness's digest (`harness@`: every token of grader/, sim/, contracts/ and pricing/, and the Node version) moves
//   with every grader deploy, and an escrowed final's L2s may be owed days after its grade, past many deploys. An L2
//   under a harness_version that is not the run's runs as under the run's own (the erased-secret and fail-key refusals
//   first, the run's recorded image, the same preflight and re-execution, then L1) and accepts only on equality
//   (underMovedHarness):
//     reproduced (the re-execution's action log the run's byte for byte, or each agent/v1 trial its stored verdict, and
//       the L1 after it reproducing): `finished`, its result the stored bytes (L1 rebuilds with the run's own
//       harness_version), flagged `harness_moved` (HARNESS_MOVED_FLAG), its error a line naming both harnesses, its
//       own harness_version this process's. The grade ran twice to byte-equal logs under the recorded harness; a third
//       execution of the same entry in the same image to the same log and score under later harness code agrees with
//       it, and the flag says which code
//     anything else (a timeout, a failed re-execution, another action log, a trial off its verdict, an L1 that
//       differs): `failed`, never `nondeterministic` or `timeout`, differing at `$.harness.version` first and then
//       where it differed, its error opening `harness_version differs:` and saying the re-execution under this harness
//       did not reproduce the run and proves nothing about the entry, flagged `harness_moved`: a difference the moved
//       harness may have made is never held against the entry. A thrown fault stays thrown, for the job to retry
//   Under the run's own harness every verdict is as before. An eras run carries harness_moved exactly when a window
//   does, reproduced or inconclusive alike.
//   The platform scorer's digest (`scorer@`: every token of sim/, contracts/ and the grader's score modules) moves with
//   any deploy touching them, so a final graded before such a deploy and regraded after it would fail L1 at
//   $.scorer_version alone, its score re-derived to the same bytes by the new code (2026-11-10, jailbreak-the-vault-01's
//   final: every would-be winner's L1 failed so, and its results were held). An L1 whose rebuilt score differs from the
//   stored one at $.scorer_version and nowhere else, the two versions differing in their `scorer@` digest alone (their
//   ` program@` and ` image@` parts the same), reproduces (scorerMovedOf): its outcome carries the stored result's bytes
//   (stamped with the run's scorer_version, so its result_sha256 is the run's, as payouts/onchain.ts reproducedBy and
//   every verifier compare it), the flag `scorer_moved` (SCORER_MOVED_FLAG), and an error line naming both digests; its
//   own scorer_version is the one it re-scored under. Any other difference (a point, a level, a program@ or image@ that
//   moved) fails as before. The stored run is never rewritten.
//
//   The trace. L1's re-score also recomputes the run's trace (harnesses.ts Scored.trace, grader/trace.ts),
//   which the regrade's outcome carries and record.ts stores as a grade's. When the run stored one
//   (run.trace_sha256), the two are compared as canonical JSON, the stored blob decompressed, never by
//   the blob's hash (gzip bytes another zlib may write otherwise): a trace that differs, or a stored
//   one that is missing, corrupt or no gzip JSON, adds the flag `trace_differs` (TRACE_DIFFERS_FLAG) to
//   the regrade's flags. The status never moves with it: reproduced is the result's verdict alone, the
//   trace living beside the result, never in it. A run that stored no trace (before traces, a harness
//   with none) is compared with nothing. When the re-score's breakdown makes no trace (Scored.traceIssue:
//   a malformed checks.json), why is told to RegradeL1Request.onTraceIssue (else logged), and the
//   regrade carries none, as the grade logged it and stored none.
//
//   The timing. A program/v1 harness naming a timing heat (a code-fastest bounty's: score.ts EligibilityRules.timing)
//   scores an entry that passed its gate with its heat's verdict (grader/code-heat.ts), which the action log does not
//   carry: the CPU time was measured once, by the heat, on the house's machine, and no regrade times anything again
//   (another machine's CPU times would be other numbers). L1, and L2's re-score once its execution reproduced the
//   action log, rebuild the verdict and hand it to buildScore (timingVerdictOf):
//     a run naming a heat record (StoredRun.code_heat_sha256, run.code_heat_sha256: migration 0044) reads it back
//       (loadCodeHeatRecord: the blob verified, kept as its canonical JSON, and holding: grader/code-heat.ts
//       parseCodeHeatRecord re-derives every order, matched flag and finalist from the rest), takes its field's entry
//       of the run's submission (StoredRun.submission_id; absent, the one entry whose graded action log is the run's),
//       holds it to the run (its graded action log the run's action_log_sha256, the record's phase seed the run's seed,
//       its timing numbers the rules') and builds with that entry's verdict (codeHeatVerdictOf: its timing, or
//       TIMING_OUTPUTS_DIFFER). A record missing, corrupt, out of shape, not holding or not timing this run is a
//       RegradeError: nothing is re-derived without the measurement the score was built from
//     a run naming none whose stored score carries a verdict no record holds (storedTimingOf: the dev phase's
//       provisional timing, codeTimingProvisional, or its TIMING_OUTPUTS_DIFFER; grader/worker.ts
//       withProvisionalTiming keeps no record of a dev grade's three timed runs) has it carried over, as its cost and
//       authorship are; nothing re-derives it
//     a run naming none whose stored score carries a heat's timing (rounds a heat times) gets no verdict: the rebuilt
//       score differs at $.performance.timing and the regrade fails saying why, a heat's timing being re-derived from
//       its record or not at all
//     any other run (no timing: the heat has not timed it, the entry did not pass, a harness with no heat) none, as its
//       grade had none
//   A verdict that the re-scored outputs cannot carry (they no longer pass the gate: score.ts timingOf's TypeError)
//   fails the regrade at $.performance.passed. A regrade that read a record says which (RegradeOutcome.code_heat_sha256).
//
//   The judge. A program/v1 harness naming a judge heat (a judged bounty's: contracts/competition.ts ProgramJudge)
//   scores an entry that passed its gate with its heat's verdict (grader/judge-heat.ts; performance.judge), which the
//   action log does not carry either: the house judge was called once, by the heat, and no regrade calls a model (a
//   model's answers are no function of its inputs). L1, and L2's re-score, rebuild the verdict from the record and hand
//   it to buildScore in the performance (judgeVerdictOf):
//     a run naming a judge heat record (StoredRun.judge_heat_sha256, run.judge_heat_sha256: migration 0058) reads it
//       back (loadJudgeHeatRecord: verified, kept as its canonical JSON, and holding: parseJudgeHeatRecord re-derives
//       its schedule, games and finalists from its calls), holds it to the bundle's judge (RegradeL1Request.judge: its
//       judge directory, model call, artifact and schedule) and to the run (its phase seed the run's seed; the member
//       of the run's entry judged on the artifact the run's action log holds) and builds with that entry's verdict
//       (judgeRecordVerdictOf). A record missing, corrupt, not holding or not judging this run is a RegradeError
//     a dev run that reused the verdict of an earlier entry's byte-identical artifact links that entry's provisional
//       record, whose field names the other entry: its member is the field's one entrant member, judged on the run's
//       artifact, and its verdict that artifact's (reusedMemberOf). A final record refuses an entry it does not name
//     a dev run's v3 record (a provisional heat on the bundle's ladder: judge-heat.ts JUDGE_HEAT_FORMAT_V3) is held to
//       that ladder besides (holdJudgeLadderRecord): the harness seals one (judge.ladder) and the record names it, and
//       its `ladder` block is what the ladder reads as (RegradeL1Request.judgeLadder, grader/judge-ladder-tree.ts
//       readJudgeLadder; judgeLadderBlock: the calibration's digest, every other member's fixed strength, the
//       dispersion, the bundle's games and spread) with at most the bundle's rounds (a budget-short day's fewer). Its
//       verdict is a function of its calls and those numbers, rebuilt with no model called. A record on another ladder,
//       a ladder that does not read, or none read, is a RegradeError. A v1 or v2 record never reads the ladder. A v3
//       record's money-place scrutiny (ladder.scrutiny: a screened bundle's dev heat played its extra rounds) is held
//       to the bundle's screened.dev_rounds: a bundle screening no final, or another count, is a RegradeError
//     a screened final's v4 record (judge-heat.ts JUDGE_HEAT_FORMAT_V4) is held to the bundle's screened block besides
//       (holdScreenedRecord): its screen's z and its race's numbers (z, phi_margin, epsilon, race_cap, race_cap_max,
//       epoch_calls, top_repeats) the block's, and its line M and race tiers what the bundle's prizes give
//       (RegradeL1Request.judgePrizes: judgeShortlistPlaces over the last paid place, judgeRaceTiers over the placement
//       prizes; absent, M is held to the record's own last tier). Its verdicts are judgeHeatEntryVerdicts' as every
//       final's: a shortlisted entry's from the final games, a screened-out entry's (screened_out) carried from its
//       house-only dev rating in the record's screen (never a contender sub-rating, which carries no score). A v1 or v2
//       final record under a bundle that screens its final is a RegradeError
//     a v4 record whose screen names the sealed dev contender chain (screen.contender: its head and rounds,
//       agent-fun/judge-contender/v1, grader/judge-contender.ts) has that chain read back (holdContenderChain): from the
//       head through each record's `prev` to round 0 (RegradeL1Request.judgeContender, else the request's blobs), each
//       verified, kept as its canonical JSON and holding on its own, then each held against the chain before it and
//       folded in (judgeContenderHold); every member snapshot a round lists held to its ladder record
//       (judgeContenderSnapshotOf of loadJudgeHeatRecord; under `carried` only where the store holds it, as a final kit
//       carries only the screen's dev records); the chain held to the bundle's judge, its sealed ladder (judgeLadder)
//       and its screened block and prizes (games = contender_games, M, z, phi_margin, epsilon:
//       judge-screen-inputs.ts judgeScreenContenderOf); and the screen's contender sub-ratings re-derived by its rule
//       (judgeScreenContenderRatings: the chain's judge one of the final's, a rated member carrying one exactly when it
//       is a chain member with a contender game), each such sub-rating and the screen's `contender` block exactly the
//       chain's (judgeScreenChainIssues). A chain missing a round, a round that does not hold, a snapshot its record does
//       not give, or a sub-rating the chain does not give, is a RegradeError. The chain held is remembered per store, so
//       every run of one final holds it once. A v4 record whose screen names none is held as above, nothing more.
//       judgeScreenDevIssues holds a screen's house-only dev ratings (every rated member's, a contender sub-rating
//       beside it or not) to their dev records where they are at hand: cli/verify-result.ts holds them from the final kit;
//       under blind rounds a rating names a judged round's heat record instead (a final-stage v4, v5 or v6 one), and
//       is re-derived from it (judge-screen-inputs.ts judgeScreenInputsFromRound) and held byte for byte
//     a panel final's v5 record (judge-heat.ts JUDGE_HEAT_FORMAT_V5: a screened final whose judge block also names
//       `panel`) is held as a v4 record is (holdScreenedRecord, its contender chain and dev ratings alike, each screen
//       rated on the final's Swiss judge alone: judge-screen-inputs.ts judgeScreenJudgesOf), and its drawn panel besides
//       (holdPanelRecord): its pool_sha256 the bundle's (harness.judge.panel), its pool the sealed `<judge.dir>/panel.json`
//       as the regrade read it (RegradeL1Request.judgePanel, readRegradeJudgePanel: its own canonical JSON, hashing to
//       that sha256), its beacon's chain quicknet (or the grader's dev-auth test chain, named explicitly: worker.ts
//       instanceChainOptions), its round the round rule's (server/judging/panel.ts judgePanelRound: the first round
//       emitted at or after the bundle's final starts_at + 60 s and, escrowed, more than 60 s after the escrow's
//       committed entries_deadline; a record drawn on any other round, an earlier one included, is refused), and its
//       signature that chain's signature of the round,
//       checked offline from the record's own bytes, off the event loop (holdPanelBeacon: server/repos/fetch.ts
//       verifyDrandRoundOffLoop; no relay asked, no model called). The draw, the order and the seated judges are the
//       record's own to hold (judge-heat.ts judgeHeatSetupIssues). A v5 record under a bundle drawing no panel, a v4
//       record under one that does, a pool file missing or not the sealed one, or none read, is a RegradeError
//     a dealt panel final's v6 record (judge-heat.ts JUDGE_HEAT_FORMAT_V6: a panel final whose judge block's panel
//       names `deal: true`) is held as a v5 record is (holdScreenedRecord, holdPanelRecord, holdPanelBeacon, its
//       contender chain and dev ratings alike); its judges, every pool member in the draw's order at weight 1 and then the
//       Swiss judge, and its games dealt over them, are the record's own to hold (judge-heat.ts parseJudgeHeatRecord). The
//       format a screened final's record must carry is the bundle's (judge-heat.ts judgeHeatFinalFormatOf: v4 under
//       `screened` alone, v5 under a panel, v6 under a dealt one; holdFinalFormat): a v5 record under a dealt panel, a v6
//       one under an undealt panel, or either under no panel, is a RegradeError naming the bundle's format. A bundle
//       that never names deal (every v5 kit's) holds its v5 records as before
//     a run naming a final heat's record that left it out (grader/worker.ts judgeHeatInputs: it wrote no artifact, or
//       one the judge cannot read; the heat links its run with no verdict) is held to it alike, to the judge and the
//       seed, and gets no verdict when no member of the record's field holds the run's entry (judgeRecordNamesRun:
//       absent its submission_id, none is judged on its artifact) and its stored score carries none, as its grade had
//       none. A stored verdict the record does not hold is the RegradeError above
//     a run naming none whose stored score carries a provisional verdict (the dev phase's) has it carried over
//     a run naming none whose stored score carries a final verdict is refused (RegradeError): a final verdict is
//       rebuilt from its record, never judged again
//     any other run none, as its grade had none
//   A verdict the re-scored outputs cannot carry (they no longer pass the gate) fails the regrade at
//   $.performance.passed. A regrade that read a record says which (RegradeOutcome.judge_heat_sha256).
//
//   The entry's launch block. A program/v1 score carries performance.entry_link (contracts/score.ts
//   ProgramEntryLinkScore) when the entry's submission has a stored entry-link record that verified a launch
//   (a pump.fun coin's: server/db/schema.ts EntryLinkRecord), never as a function of the scorer. L1, and L2's
//   re-score, re-derive it in order of truth: from the record the caller hands (EntryFacts.entry_link, the
//   pipeline's regrade: the submission row as it stands now, so a record that moved fails the L1 at
//   $.performance.entry_link), else from that record as loadStoredRun read it (StoredRun.entry_link), else
//   from the block its own stored score carries (entryLinkOfScore: the same value, the record stored once at
//   intake and never rewritten), so a caller that read no row still reproduces byte for byte. A record that
//   reads as another platform or as an unverified launch leaves the block off, as the grade left it. None can
//   fail a regrade for reading: a block that differs is reported at $.performance.entry_link as any score
//   field is.
//
// A dev run on practice windows (contracts/competition.ts Phase.practice_windows; grader/worker.ts gradeEras: the run's
// `run_era` rows, one a window it graded) regrades window by window through regradeErasL1 and regradeErasL2, which
// grader/worker.ts routes it to. Each window is a StoredRun of its own (its row's dataset, seed, action log, Score, trace
// and the public fail key of its seed, a dev phase's), regraded by regradeL1 or regradeL2 on a plan of its own dataset
// (ErasRegradeWindow.plan: resolved by the unique dataset.sha256 of the row, loaded one window at a time):
//   L1  re-scores every window's stored action log, rebuilds the run's result from the windows' rebuilt Scores
//       (erasResult: grader/score.ts aggregateEras) and requires its canonical bytes to equal run.result's
//   L2  re-executes every window once, each window asserted against its own stored action log, then the same L1
//       (under a moved harness, each window and the run flagged harness_moved: the versions, above)
// Every window is regraded, one failing included, so the regrade's record names each window's outcome: the regrade
// run's own `run_era` rows (grader/record.ts eraOfRegrade; ErasRegradeOutcome.windows). The regrade's run row is the
// aggregate's: the result rebuilt, the median window's digests, the executions and wall time summed over the windows,
// reproduced iff every window reproduced and the rebuilt result is the stored one byte for byte.
//
// An agent/v1 run (K trials, contracts/agent.ts; its action log the trials manifest) regrades through
// its own two levels, which grader/worker.ts routes it to; nothing of either calls a model:
//
//   L1  regradeAgentL1: no execution of the entry and no spend. For every trial of the manifest, its
//       stored state export (the manifest's outputs, each file's blob verified) re-scored by the
//       bundle's scorer on its instance's reference/ (grader/agent.ts scoreTrialWithChecks; a timeout scores 0
//       by rule, its export unread), its cassette read for its pricing_rev and meter (requests,
//       spend) and its model calls (gateway/cassette.ts cassetteModelCalls, the LLM agent floor's
//       count off the stored cassette's bytes), and its void re-runs as the run's trial rows count
//       them; then aggregateTrials handed the entry's facts (AgentRegradeL1Request.entry) with the
//       harness's waivers of the floor read off the setup's harness (a target, model_calls: optional:
//       agent-score.ts agentHarnessFloorFacts), so an entrant's silent trial scores 0 on every column
//       as the fan-in scored it (agent-score.ts agentTrialSilent), and the score rebuilt from the run's recorded facts as the fan-in built
//       it (grader/worker.ts finish: no execution or performance flags, determinism the trials'),
//       compared byte for byte with the stored result as L1 does. Each re-score keeps the per-check
//       rows its scorer wrote (grader/agent.ts scoreTrialWithChecks), and the run's checks trace is
//       recomputed from them as the fan-in built it (agent-score.ts agentChecksBreakdown, the same
//       entry facts), then compared with the stored one and flagged `trace_differs` as above; rows that
//       make none are told to onTraceIssue with why (else logged). A state export that is missing or
//       does not hash to its name, or a cassette that does not read, fails the regrade (`failed`,
//       the trial's path named).
//   L2  regradeAgentL2: under the stored image digest (another refused up front as L2 refuses it; under
//       a moved harness, reproduced only flagged harness_moved, else inconclusive: the versions, above),
//       every trial the run replayed (finished, nondeterministic; a timeout was
//       never replayed and scores 0 by rule) replayed once more: the forwarder in replay mode serving
//       the stored cassette, no upstream and no spend (grader/agent.ts runTrial mode replay). Each must
//       reach its stored verdict: a finished trial its state.json sha byte-equal with the cassette
//       wholly consumed, a nondeterministic one nondeterministic again; any other is
//       `nondeterministic`. A run whose trials ran once (the run flag replay_skipped:
//       REPLAY_SKIPPED_FLAG): a dev-phase run (grader/worker.ts `practice once`), or a staged final's
//       entry that stopped at its qualifying trials (grader/worker.ts `staged final`: its one trial,
//       cut at the line, or on a final that names earlier cuts the trials of every stage it ran up
//       to the cut that stopped it, each ended as a practice trial does), replays every listed
//       finished trial here for the first time, held to their live passes as any: one that differs is `nondeterministic` too, its
//       error saying the trial was never replayed when graded (a practice trial, or a final entry that
//       stopped at the qualifying trial: AgentRegradeL2Request.phaseKey picks the words, one or several
//       trials alike), so it reads as the first check of that pass, never as a trial off a verdict a
//       replay had checked. Its L1 re-scores its stored trials as any run's, to the same bytes. Each replay copies the brief its
//       live pass read (recordedBrief): the manifest's prompt_sha256 names it, and of the instance's
//       two (input/prompt.txt, and a house baseline's reference/baseline-prompt.txt) the one hashing
//       to it is replayed, the entry's
//       baseline flag (`entry.baseline`) tried first; so a flag changed since the grade still replays
//       what ran, and only L1's score shows the change. A manifest written before briefs were
//       recorded replays the brief the flag picks; one whose prompt_sha256 neither brief hashes to
//       fails the regrade (the trial's path named). A replay that cannot read its cassette (a
//       tampered or missing blob) fails the regrade; an instance that is not the trial's is a
//       RegradeError; any other infrastructure fault is thrown, for the job to retry. Then L1. It is
//       never a live re-run. Under a harness with a target (contracts/competition.ts AgentTarget) each
//       trial replays two cassettes, its own and its house lane's (the manifest's
//       house_cassette_sha256, which the env's calls to the target recorded): both served whole, and
//       a finished trial needs both wholly consumed; a record naming no house cassette under a target
//       (or one under a harness with none) fails the regrade, the trial's path named. L1 reads only
//       the outputs, so it rescores a target's run unchanged.
//   top-up  a practice top-up run (run.kind top_up, grader/worker.ts `top-up`) regrades at both levels as above, on its
//       own round's trials, and only once its competition's results are out: before them the run is sealed
//       (server/routes/_lib/visibility.ts topUpsPublished) and no regrade run of it is written. readTopUpRegrade reads its
//       practice_top_up row, held to the stored bundle's staged.top_up (sealed, no row, a corrupt record since the grader
//       writes the two in one transaction, or a row whose units are not the bundle's, is refused by name), and the worker plans it on practice trials 1 + (round - 1) x units to round x
//       units, so its stored dataset_sha256 is the plan's and its result rebuilds as a dev grade's. Its band is said on the
//       outcome beside its verdict, never a refusal (topUpBandNote): the line, M and within its row holds as sent, and that
//       the entry was inside it then, a fact of the round, not of the regrade: only the rule's sends write a round
//       (server/grading/practice-top-up.ts, final-cut-job.ts), each to an entry it found owed, so inside the band. Nothing
//       here decides it: grader/ runs no part of the rule (guard: tests/unit/top-up-boundary.test.ts).
// A scrape/v1 run (a heat's timed trials, contracts/scrape.ts; its action log the trials manifest)
// regrades at L1 only, from the record:
//
//   L1  regradeScrapeL1: no trial runs again and no upstream is asked. The heat record (the blob the
//       run's dataset_sha256 names, canonical, a ScrapeHeat) and the heat's log (the blob its
//       stderr_sha256 names, record.ts ScrapeHeatLog, of that heat, its reference read the one the record
//       names: reference_cassette_sha256) read back; the manifest held to the
//       heat record (contracts/scrape.ts scrapeTrialsHeatIssues: its entry, its rounds, its positions);
//       then every listed trial judged again from the blob store as the heat judged it (grader/scrape/
//       score.ts judgeScrapeTrial: its outputs at /output, its cassette and the heat's reference read,
//       the cassette the heat record names, at
//       /reference, the bundle's sealed scorer twice, byte-equal), a faulted trial keeping its fault
//       unscored. A listed void (a re-judging's: below) is judged again from its record as the
//       re-judging judged it: against the heat's reference read, then, incorrect there, against its own
//       cassette, and correct there it is the void again (contracts/scrape.ts scrapeVoidRecord, both
//       scores.json digests); judged otherwise either time it reproduces nothing. Every rebuilt record
//       must equal the stored one (its status and its scores.json digests), the
//       rebuilt manifest's canonical bytes the stored action log's, and the score rebuilt from them
//       (scrapePerformance over the heat's trim, no execution flags, determinism true: a scored run's
//       scorer agreed on every trial) the stored result byte for byte. A trial whose blobs cannot be
//       read, or whose scorer faults or disagrees with itself, fails the regrade (`failed`, its path
//       named). The heat record or log missing, corrupt or of another heat, or a log whose reference
//       read is not the one the record names, is a RegradeError. A trial the heat voided at its judging
//       (heat.ts judged voids: incorrect against the reference read, correct against its own cassette;
//       judged_void in the log) is never listed, as no void a heat meets is: its slot's re-run is, and the manifest's
//       voids_rerun counts it, so L1 re-judges exactly what the heat listed and reproduces such a heat as
//       any (tests/unit/grader-scrape-pipeline.test.ts, a short window)
//   L2  refused (SCRAPE_L2_REFUSAL): a heat's timings were measured against the live upstream once,
//       and no re-run measures them again; L1 re-scores the record.
//   rejudge  rejudgeScrapeRun, for a run its scorer left unscored (a disagreement, or a fault twice:
//       grader/scrape/heat.ts; the run recorded failed, no manifest, flagged scrape_scorer_fault): no
//       trial runs again and no upstream is asked. The heat record and log read back and held to each
//       other as L1 holds them; the run's trials the heat kept unjudged in its log (ScrapeHeatLogRuns:
//       runs[].unjudged, main then playoff) judged in order from the blob store with the bundle's
//       sealed scorer as the heat judges a trial (judgeScrapeTrial: twice, byte-equal), against the
//       heat's reference read the heat record names (reference_cassette_sha256), a ScorerError that
//       is not a disagreement tried once more (SCRAPE_REJUDGE_ATTEMPTS, as the heat's
//       SCRAPE_JUDGE_ATTEMPTS), each scores.json kept in the blob store. A trial its scorer still
//       cannot judge ends the re-judging there, as the heat stops judging a faulted run (`failed`,
//       the fault listed, nothing built). An incorrect trial is judged once more against its own
//       cassette, as the heat judges one (its judged voids): a fault there voids nothing (it stays
//       incorrect), a disagreement is the run's fault as above, and correct then it is a judged
//       void (judged_voids: where, its cassette, both scores.json digests, why), never the
//       scorer's fault. A heat voids such a trial and runs it again; a re-judging runs no trial, so
//       it is listed void (contracts/scrape.ts SCRAPE_VOID_STATUS, scrapeVoidRecord: its round
//       still lists one trial, both scores.json named) and the judging goes on with the run's other
//       trials. A void counts for nothing: the run's times, counts and trim leave it out, so it is
//       scored on its other rounds; voids that leave fewer main trials to count than a run is scored
//       on (scrapeFewestCountedMain) leave it unscored (`judged_void`: every trial judged, nothing
//       built), held, never marked incorrect; a later fault is `failed` with its judged voids listed
//       too. Every trial judged, the trials manifest is built (the
//       heat's voids_rerun) and held to the heat record (scrapeTrialsHeatIssues), and the score
//       built from it as a heat builds a run's (scrapeScoreOf, which L1 builds with too: an L1 of
//       the run judged again re-derives it byte for byte), under the scorer_version it was judged
//       with (the current scorer and image). The caller (server/routes/admin/scrape-holds.ts)
//       records it. A log keeping no unjudged trials of the entry, or a heat record or log missing,
//       corrupt or of another heat, is a RegradeError.
//
// A referral/v1 run (an entry's sign-up evidence, grader/score.ts ReferralActionLog) regrades at L1 only, from the log:
//
//   L1  regradeReferralL1: nothing executes and no sandbox is read. The action log (the blob its run names) is read
//       back, held to ReferralActionLog and its hash, and the score rebuilt from it (buildScore counts its counted
//       sign-ups; the run's facts and the kind's constants are the score's other inputs), held to the stored result
//       byte for byte. A log missing, corrupt or not a log, or a run with no scored log, is a RegradeError.
//   L2  refused (REFERRAL_L2_REFUSAL): a count is the facts at the grade's read; L1 re-scores the stored log.
//
// A desk/v1 run (what a campaign's desk decided for an entrant in the window, grader/score.ts DeskActionLog) regrades
// the same way, at L1 only, from the log:
//
//   L1  regradeDeskL1: nothing executes and no desk table is read. The action log is read back, held to DeskActionLog
//       and its hash, and the score rebuilt from it (buildScore counts its credited weights under the bundle's
//       min_points; the run's facts and the kind's constants are the score's other inputs), held to the stored result
//       byte for byte. A log missing, corrupt or not a log, or a run with no scored log, is a RegradeError.
//   L2  refused (DESK_L2_REFUSAL): a count is the desk's decisions at the grade's read; L1 re-scores the stored log.
//
//   owner  a regrade that names its owner (RegradeL1Request.owner: the pipeline's worker.ts
//       regradeOwner, `regrade-<job id>`, the same on every attempt of the job and no other job's)
//       picks up after an attempt that died mid-way: its scratch under the work root is named for
//       the owner and what a dead attempt left there is removed first, before anything else runs (a
//       folder whose heartbeat says an attempt may still be live is left: reapScratch). An
//       L1 or L2 of any other kind (a replay's, a bars', a clmm's, a program's) names its
//       re-execution's and its scorer's `exec-<owner>-XXXXXX` and `score-<owner>-XXXXXX` (grade.ts
//       EXEC_SCRATCH_PREFIX, SCORE_SCRATCH_PREFIX) and removes a dead attempt's so named
//       (grade.ts reapGradeScratch). An agent/v1 regrade names its own
//       `regrade-agent-<owner>-XXXXXX` (ownedScratch: L2's snapshot and replays, L1's scorer) and
//       removes a dead attempt's so named (reapScratch); L2 replays trial t
//       under owner `<owner>.<t>` (regradeTrialOwner, grader/agent.ts RunTrialOptions.owner), so on
//       the docker driver each replay first removes what a dead attempt's replay of that trial left
//       running (its containers and network: grader/sandbox/network.ts reapTrial). Each removal is
//       told to onScratchReap (and onReap). Never another regrade's or a grade's: theirs carry other
//       owners. Absent: none of this, as before.
//
//   stopping  an L1 or L2 handed its job attempt's signal (RegradeL1Request.signal: the pipeline's
//       worker.ts hands JobContext.signal, which pg-boss aborts once it gives the attempt up at its
//       expiry) stops as a grade does (grade.ts `Stopping`). Aborted before it starts, it runs nothing,
//       not even the reap. Aborted while it runs, the program running is killed (L2's re-execution, a
//       program/v1 scorer: executeOnce and scoreOnce run each in a sandbox bound to the signal) and
//       nothing starts after it: a run per case stops between cases, and L2's re-score never starts
//       after a stopped re-execution. Its scratch is removed as ever, and regradeL1 / regradeL2 reject
//       with the signal's reason in place of whatever the stopped run threw or returned (stoppable).
//       No outcome is handed back, so nothing is recorded, and the error is no RegradeError, so the
//       job's retry regrades afresh. An agent/v1 L2's replays stop alike (AgentRegradeL2Request.signal).
//       An agent/v1 L1 and a scrape/v1 L1 take no signal: their requests omit it. With no signal, a
//       regrade is never stopped, as before.
//
//   entry secrets  an L2 re-executes the entry with exactly the env-lane entry secrets its run recorded
//       (run.entry_secret_ids; an agent/v1 trial's run_trial.entry_secret_ids), retained rows included, which
//       grader/worker.ts re-opens and hands in: RegradeL2Request.snapshot's secrets (grade.ts
//       SnapshotSource.secrets: the re-execution's sandbox gets them, every case of a run per case and every
//       window of an eras run alike), AgentRegradeL2Request.trialSecrets (each trial's replay, grader/agent.ts
//       RunTrialOptions.secrets). The re-execution is masked of them as a grade's is (grade.ts executeOnce),
//       and so is whatever regradeL2 throws. Once one of them is erased (replaced, deleted, purged:
//       server/secrets/store.ts names it among the read's `erased`), the L2 cannot run as the grade did: it is
//       refused before anything executes (secretsErased), a failed outcome with no execution, its error led by
//       ENTRY_SECRETS_ERASED and its run flagged with it, differing at `entry_secret_ids`; an eras L2 so refused
//       regrades no window. The run's L1 stands: it re-scores the stored action log and needs no secret. An L1
//       rebuilds the score with the run's flags but RUN_ONLY_FLAGS (secret_in_output, which grader/worker.ts
//       raises on a run after its score was built), so a run flagged so still reproduces.
//
//   layout  a run whose entry ran on the `pod` sandbox layout (grader/sandbox/layout.ts: one sandbox pod an entry)
//       carries ONE_POD_FLAG beside its score, never in it (RUN_ONLY_FLAGS), so an L1 rebuilds the same score with or
//       without it. An L2 re-runs the entry on the run's own layout (storedRunLayout), whatever the layout table says
//       now: grader/worker.ts hands a flagged agent/v1 run's L2 the k8s sandbox's one-pod view, and its replays the
//       lane host and the door besides (AgentRegradeL2Request.hosted, .door); only agent/v1 and scrape/v1 runs carry
//       the flag (a program/v1 grade is one pod on `split` and never takes `pod`, and a scrape run is never re-run);
//       a process that cannot host that layout refuses the job as the platform's fault and never re-runs the entry on
//       `split`, whose CPU and memory room differ. An unflagged run's L2 runs on the sandbox as ever. Each agent/v1
//       replay hands the entry the key its live pass handed it, read from the trial's record (AgentTrialRecord
//       .entry_key: present exactly on a trial that ran one pod, the run's own key for it), on the pod layout and on
//       the split one (the public kit's replay of a one-pod run) alike; on the pod layout a trial whose record has
//       none fails the L2. So no L2 needs the server's secret, and a rotated one changes no finished run's replays.
//
//   once  a run graded under run_once (grade.ts GradeRequest.executions 1) executed its entry once and carries
//       EXECUTED_ONCE_FLAG beside its score, never in it (RUN_ONLY_FLAGS), so an L1 rebuilds the same score; its
//       stored exec_count (1) and wall_ms hand the scorer the same run time. An L2 of it is the run's first second
//       execution: a log that differs is `nondeterministic` as on any run, its error saying the run executed once
//       when graded.
//
// Outcomes: `finished` when reproduced; `failed` when the result (or the inputs it depends on)
// differs, with the differing JSON paths; an L2 whose execution fails or times out takes that
// status, and one whose action log differs is `nondeterministic` (under a moved harness each of those is
// `failed`, flagged harness_moved: the versions, above). Authorship and cost can be
// re-derived under the stored pricing_rev first (regradeAuthorship, cost.ts repriceCostLines with
// createPricer(doc)), so a regrade never silently uses newer prices; authorship also under the
// stored algorithm version (transcripts/authorship.ts runs every version a stored ledger may name)
// and with the diff a patch entry's competition's policy names (AuthorshipRegradeRequest.patchDiff),
// whose added lines its ledger counted at ingest, and with the pack sources ingest kept
// (AuthorshipRegradeRequest.packs), whose verdicts a version 8 or later ledger lists (one listing any is
// refused without them).
// Under a build meter the cost handed in is priced from exactly the metered requests the grade
// counted (grader/entry-cost.ts `the list`, named by the stored cost.metered.requests_sha256), so a
// request masq recorded late and the house stored since never moves a regrade at `$.cost`.

import type { Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { TrialOutputs, type AgentTrialRecordT, type AgentTrialsT, type CassetteT } from '../contracts/agent.ts';
import { judgeShortlistPlaces, ProgramTiming, stagedTopUpOf, type CompetitionBundleT, type PrizeT, type ProgramJudgeT, type ProgramTimingT } from '../contracts/competition.ts';
import { SECRET_IN_OUTPUT_FLAG } from '../contracts/entry-secrets.ts';
import { Sha256Hex } from '../contracts/primitives.ts';
import { Score, type AuthorshipSummaryT, type CostT, type ProgramEntryLinkScoreT, type ProgramJudgeScoreT, type ScoreSizeT, type ScoreT } from '../contracts/score.ts';
import {
  SCRAPE_TRIALS_FORMAT,
  SCRAPE_VOID_STATUS,
  scrapeCountedTrials,
  ScrapeEntryId,
  scrapeFewestCountedMain,
  ScrapeHeat,
  ScrapeHeatId,
  ScrapeHeatStage,
  ScrapeStage,
  ScrapeTrials,
  ScrapeTrialStatus,
  scrapeTrialsHeatIssues,
  scrapeVoidRecord,
  type ScrapeHeatT,
  type ScrapePerformanceT,
  type ScrapeTrialRecordT,
} from '../contracts/scrape.ts';
import type { Pricer } from '../pricing/price.ts';
import type { BlobStore } from '../server/blobstore.ts';
import { DRAW_MARGIN_SECONDS } from '../server/competitions/instance.ts';
import { lastPaidPlace } from '../server/competitions/load.ts';
import type { Db } from '../server/db/client.ts';
import { JUDGE_PANEL_POOL_FILE, JUDGE_PANEL_POOL_MAX_BYTES, JudgePanelPoolError, judgePanelPoolRead, judgePanelRound } from '../server/judging/panel.ts';
import { verifyDrandRoundOffLoop } from '../server/repos/fetch.ts';
import { DRAND_QUICKNET, type DrandChain } from '../server/repos/freshness.ts';
import { materializeSnapshot, removeMaterialized, type SnapshotIndex } from '../server/repos/index-tar.ts';
import { canonicalJson, compareCodeUnits, sha256Hex } from '../sim/canonical.ts';
import {
  AUTHORSHIP_ALGO_VERSION,
  AUTHORSHIP_ALGO_VERSIONS,
  authorshipSha256,
  computeAuthorship,
  readSnapshotContent,
  type AuthorshipAlgoVersion,
  type AuthorshipLedger,
  type AuthorshipPack,
  type AuthorshipSession,
} from '../transcripts/authorship.ts';
import type { AgentSetup, TrialPass, TrialScored } from './agent.ts';
import { agentChecksBreakdown, agentDeterministic, agentHarnessFloorFacts, aggregateTrials, type AgentLeaderboard, type AgentTrialResult } from './agent-score.ts';
import { CodeHeatError, codeHeatRecordDigest, codeHeatVerdicts, codeTimingProvisional, parseCodeHeatRecord, type CodeHeatRecordT } from './code-heat.ts';
import type { GatewayBundle } from './gateway/bundle.ts';
import { beatingScratch, entryLinkFactsOf, entryLinkOfScore, EXECUTED_ONCE_FLAG, executeOnce, holdScratch, houseCountsLogOf, houseDossierLogOf, keepScratchAlive, preflight, reapGradeScratch, redactThrown, releaseScratch, removeScratch, SCORE_SCRATCH_PREFIX, SCRATCH_HEARTBEAT_FILE, SCRATCH_HEARTBEAT_MS, SCRATCH_LIVE_MS, scoreOnce, traceIssueLine, withEntryLink, type EntryFacts, type EntryLinkRecordFacts, type ExecutionSummary, type SnapshotSource } from './grade.ts';
import { scorerVersionOf, type HarnessPlan } from './harnesses.ts';
import { JudgeArtifactRefused, judgeUserContent, type JudgeArtifact } from './judge-call.ts';
import { judgeContenderHold, judgeContenderRecordDigest, judgeContenderSnapshotOf, parseJudgeContenderRecord, type JudgeContenderDesignT, type JudgeContenderFoldT, type JudgeContenderLadderT, type JudgeContenderRecordT } from './judge-contender.ts';
import { JUDGE_HEAT_FORMAT_V3, JUDGE_HEAT_FORMAT_V4, JUDGE_HEAT_FORMAT_V5, JUDGE_HEAT_FORMAT_V6, JudgeHeatError, judgeHeatFinalFormatOf, judgeHeatPanelFormat, judgeHeatScreenedFormat, judgeHeatEntryVerdicts, judgeHeatEntryVerdictsOf, judgeHeatJudgesOf, judgeHeatRecordDigest, judgeHeatVerdicts, parseJudgeHeatRecord, type JudgeHeatLadderT, type JudgeHeatRecordT, type JudgeHeatScreenedFormatT, type JudgeScreenRatingT } from './judge-heat.ts';
import { judgeCutScoreIssue, type JudgeCutView } from './judge-cut.ts';
import { judgeHeatRecordLoadOffThread, type JudgeHeatRecordHeadT, type JudgeRecordLoadAnswer } from './judge-heat-tasks.ts';
import { judgeContenderDesignOf, judgeScreenContenderOf, judgeScreenContenderRatings, judgeScreenInputs, judgeScreenInputsFromRound, judgeScreenJudgesOf, type JudgeScreenContenderT, type JudgeScreenEntryT } from './judge-screen-inputs.ts';
import { judgeLadderBlock, type JudgeLadderInputs } from './judge-ladder-tree.ts';
import { judgeRaceTiers } from './judge-race.ts';
import { readOutputFile, type OutputBlobs, type ProgramRunTime } from './program.ts';
import { entrySecretForms, type LimitsT } from './run.ts';
import { aggregateEras, buildScore, DESK_COST, DESK_DATASET_SHA256, deskActionLogOf, deskPerformanceOf, jsonDifferences, REFERRAL_COST, REFERRAL_DATASET_SHA256, referralActionLogOf, referralPerformanceOf, scoreDigest, TIMING_OUTPUTS_DIFFER, type EligibilityRules, type DeskActionLogT, type EraWindowScore, type ReferralActionLogT, type TimingVerdictT } from './score.ts';
import { ONE_POD_FLAG, type SandboxLayout } from './sandbox/layout.ts';
import type { ReapResult } from './sandbox/network.ts';
import type { ScrapeScorerSetup } from './scrape/score.ts';
import type { Door, HostedServices, PodRequests, Runtime, Sandbox } from './sandbox/types.ts';
import { spendOnFirstTrialRevision, type SpendTrial } from './spend-revision.ts';
import { encodeTrace, readStoredTrace } from './trace.ts';
import { codeVersionOf, harnessVersion, scorerVersion } from './version.ts';

/**
 * The stored run's measured run time as its grade handed it to the scorer (grade.ts gradeIn; program.ts RUN_FILE): its
 * executions' total wall time and count, or null when it stores no total or no execution.
 */
export function storedRunTime(stored: Pick<StoredRun, 'wall_ms' | 'exec_count'>): ProgramRunTime | null {
  if (stored.wall_ms === null || stored.wall_ms === undefined || stored.exec_count === null || stored.exec_count === undefined || stored.exec_count < 1) return null;
  return { wall_ms_total: stored.wall_ms, executions: stored.exec_count };
}

/**
 * The launch a stored run's score carries (contracts/score.ts ProgramPerformance.entry_link), if it is one: the block
 * the grade filled from the submission's entry_link record, which result_sha256 hashes, so a regrade handed no record
 * (cli/verify-result.ts's L1 of an export) rebuilds the score with it and reproduces byte for byte. Null when the score
 * carries none.
 */
function storedLaunchOf(result: unknown): ProgramEntryLinkScoreT | null {
  return entryLinkOfScore(result) ?? null;
}

/** What a regrade reads from the run it re-derives (server/db/schema.ts run). */
export interface StoredRun {
  id: string;
  status: string;
  harness_version: string | null;
  scorer_version: string | null;
  image_digest: string | null;
  dataset_sha256: string | null;
  seed: string | null;
  /**
   * The failed-tx draw's key the run was graded with (grade.ts fail_key, kept in run.fail_key by
   * record.ts; null on a row recorded before the column, absent in a hand-built StoredRun). The plan
   * must hold the same key (the worker builds it from this, never from the server secret when it is
   * stored, so a rotated secret still regrades), or the regrade is refused.
   */
  fail_key?: string | null;
  action_log_sha256: string | null;
  result: unknown;
  result_sha256: string | null;
  flags: readonly string[];
  /**
   * The run's stderr blob (record.ts): a scrape/v1 run's names its heat's log (record.ts
   * SCRAPE_HEAT_LOG_FORMAT), which holds the heat's reference read an L1 regrade rebuilds. Absent in a
   * hand-built StoredRun.
   */
  stderr_sha256?: string | null;
  /**
   * The run's executions' total wall time and count (record.ts: run.wall_ms, run.exec_count), which an L1 regrade re-hands
   * a program/v1 scorer as the grade did (storedRunTime; program.ts RUN_FILE). Absent in a hand-built StoredRun: no file.
   */
  wall_ms?: number | null;
  exec_count?: number | null;
  /**
   * The run's trace blob (record.ts: run.trace_sha256, the gzip of the trace's canonical JSON); null when the run
   * stored none, absent in a hand-built StoredRun. L1 compares the trace it recomputes with it (the header's trace).
   */
  trace_sha256?: string | null;
  /**
   * The entry the run grades (run.submission_id): the id a code-fastest heat's record names it by (grader/code-heat.ts
   * CodeHeatRecord.entries). Absent in a hand-built StoredRun: then the record's one field entry whose graded action
   * log is the run's stands for it (the header's timing), and a regrade of a run whose log two entries share is refused.
   */
  submission_id?: string;
  /**
   * The code-fastest timing heat whose verdict the run's score carries (run.code_heat_sha256, migration 0044): the
   * sha256 of the record's canonical JSON, a blob in the blob store, from which L1 rebuilds the timing (the header's
   * timing). Null when the run names none; absent in a hand-built StoredRun, read as none.
   */
  code_heat_sha256?: string | null;
  /**
   * The judge heat whose verdict the run's score carries (run.judge_heat_sha256, migration 0058): the sha256 of the
   * record's canonical JSON, a blob in the blob store, from which L1 rebuilds the verdict (the header's judge). Null
   * when the run names none; absent in a hand-built StoredRun, read as none.
   */
  judge_heat_sha256?: string | null;
  /**
   * The entry_secret rows the run's executions ran the entry with (run.entry_secret_ids: grader/worker.ts records them),
   * which an L2 re-opens and re-executes with (the header's entry secrets). Null or absent: none (a run recorded before
   * entry secrets, or with none).
   */
  entry_secret_ids?: readonly string[] | null;
  /**
   * The submission's stored entry-link record (submission.entry_link: record.ts loadStoredRun reads the run's submission
   * row with it), from which a program/v1 run's performance.entry_link is re-derived (contracts/score.ts
   * ProgramEntryLinkScore; the header's entry link). Null or absent: no record, a hand-built StoredRun, or a caller that
   * did not read it: the block the stored score carries stands (entryLinkOfScore), which is the same value (the record is
   * stored once, at intake), so an L1 still reproduces byte for byte.
   */
  entry_link?: EntryLinkRecordFacts | null;
}

/** The flag a regrade adds when the trace it recomputed is not the one the run stored (the header's trace); its status never moves with it. */
export const TRACE_DIFFERS_FLAG = 'trace_differs';

/**
 * The run flag an agent/v1 grade carries when a trial of it ran once: a dev-phase grade (grader/worker.ts `practice once`),
 * or a staged final's entry that stopped at its qualifying trials (grader/worker.ts `staged final`): its one trial,
 * or, on a final that names earlier cuts, every trial of each stage it ran before the cut that stopped it, which may be
 * several trials. Each one's live pass was scored and the trial finished with no replay (run_trial replay_started_at and
 * replay_finished_at null), so nothing checked that pass against a replay of it; the flag is the run's, and true of every
 * trial it lists, since no trial of a stopped run is replayed. Beside the score, never in it (RUN_ONLY_FLAGS): the result claims
 * no replay either way (it carries no `nondeterministic` flag, as no replay differed: none ran, grader/score.ts
 * standingOf), and a reader tells a once-run practice grade from a replayed one by this flag
 * (server/routes/archive/entry.ts agentTrialsOf: such a trial's replay_matched is null, never true). Public: it states
 * nothing but how the trial ran. Every other final-phase trial is replayed, and its run never carries it: a staged
 * final's contender (a finalist, on a final with earlier cuts) replays every trial, its qualifying ones included.
 */
export const REPLAY_SKIPPED_FLAG = 'replay_skipped';

/**
 * Run flags a grade run carries beside its score, never an execution's (the header's entry secrets): secret_in_output,
 * which grader/worker.ts raises on a run whose outputs hold a form of an entry secret after its score was built,
 * replay_skipped (REPLAY_SKIPPED_FLAG), which says how a once-run agent/v1 grade's trials ran (a practice grade, or a
 * staged final's entry that stopped at its qualifying trials), one_pod (grader/sandbox/layout.ts ONE_POD_FLAG),
 * which says the run's entry ran on the `pod` sandbox layout (the header's layout), and executed_once (grade.ts
 * EXECUTED_ONCE_FLAG), which says a run_once grade executed its entry once (the header's once). L1
 * rebuilds the score with the run's flags but these, as the grade built it.
 */
export const RUN_ONLY_FLAGS: ReadonlySet<string> = new Set([SECRET_IN_OUTPUT_FLAG, REPLAY_SKIPPED_FLAG, ONE_POD_FLAG, EXECUTED_ONCE_FLAG]);

/** The sandbox layout a stored run's entry ran on (the header's layout): `pod` when the run carries ONE_POD_FLAG, else `split`. */
export function storedRunLayout(stored: Pick<StoredRun, 'flags'>): SandboxLayout {
  return stored.flags.includes(ONE_POD_FLAG) ? 'pod' : 'split';
}

/**
 * Why an L2 is refused unexecuted once an entry secret its run recorded is erased (the header's entry secrets): the
 * refusal's error leads with it and its run is flagged with it. The same reason grader/worker.ts voids an agent/v1 live
 * pass with when such a secret is erased before its replay (worker.ts ENTRY_SECRETS_ERASED_VOID_REASON).
 */
export const ENTRY_SECRETS_ERASED = 'entry_secrets_erased';

/** An L2 refused unexecuted on `out`'s run because a secret it recorded is erased (`why`: which, by NAME and row, never a value). */
function erasedRefusal(out: RegradeOutcome, why: string): RegradeOutcome {
  return { ...out, status: 'failed', reproduced: false, error: `${ENTRY_SECRETS_ERASED}: ${why}`, differences: ['entry_secret_ids'], flags: withFlag(out.flags, ENTRY_SECRETS_ERASED), finished_at: new Date() };
}

/** A regrade cannot even start (nothing to re-derive, a stored blob missing or corrupt). */
export class RegradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegradeError';
  }
}

export type RegradeStatus = 'finished' | 'failed' | 'timeout' | 'nondeterministic';

export interface RegradeOutcome {
  kind: 'regrade_l1' | 'regrade_l2';
  reproduces_run_id: string;
  status: RegradeStatus;
  reproduced: boolean;
  error: string | null;
  /** JSON paths where the new result differs from the stored one. */
  differences: string[];
  result: ScoreT | null;
  result_sha256: string | null;
  /** The trace the re-score recomputed (grade.ts GradeOutcome.trace_json), canonical JSON; null when it made none. */
  trace_json: string | null;
  /** sha256 of its blob (grader/trace.ts traceBlob), what the regrade run's trace_sha256 names. */
  trace_sha256: string | null;
  action_log_sha256: string | null;
  harness_version: string | null;
  scorer_version: string;
  image_digest: string | null;
  dataset_sha256: string | null;
  seed: string | null;
  /** The fail key the regrade re-derived the run under (the plan's). */
  fail_key: string | null;
  /**
   * The code-fastest heat record whose verdict the rebuilt score carries (StoredRun.code_heat_sha256, read back and
   * held to the run: the header's timing); present only on a regrade that read one.
   */
  code_heat_sha256?: string;
  /**
   * The judge heat record whose verdict the rebuilt score carries (StoredRun.judge_heat_sha256, read back and held to
   * the run: the header's judge); present only on a regrade that read one.
   */
  judge_heat_sha256?: string;
  flags: string[];
  exec_count: number;
  wall_ms: number;
  executions: ExecutionSummary[];
  stderr: Buffer;
  started_at: Date;
  finished_at: Date;
}

export interface RegradeL1Request {
  stored: StoredRun;
  plan: HarnessPlan;
  sandbox: Sandbox;
  /** Holds the stored action log and any program/v1 outputs. */
  blobs: OutputBlobs & Pick<BlobStore, 'get'>;
  limits: LimitsT;
  workRoot: string;
  cost: CostT;
  authorship: AuthorshipSummaryT | null;
  /**
   * The entry: its facts, and its submission's entry_link record as it stands now (EntryFacts.entry_link). Handed one,
   * the rebuilt score's launch is re-derived from it (grade.ts entryLinkFactsOf, contracts/score.ts
   * ProgramPerformance.entry_link), so a record that moved since the grade makes the L1 differ at
   * `$.performance.entry_link` (its slot, say): the score says what the house read then, and the regrade says so too or
   * fails. With none, the record the stored run's submission row names stands in (StoredRun.entry_link, loadStoredRun),
   * and with neither (a CLI, or cli/verify-result.ts's L1 of an export) the stored score's own block (storedLaunchOf):
   * the score reproduces byte for byte.
   */
  entry: EntryFacts;
  rules: EligibilityRules;
  /**
   * The entry's code size (grader/size.ts codeSize over the run's snapshot and the kit's starter; under the compressed
   * count weighCodeSize, grader/size-weigh.ts snapshotCodeSize, the same bytes weighed to the same thousandth), counted
   * upstream as the grade counted it (grade.ts GradeRequest.size): given exactly when the rules name a size count (rules.size), and
   * absent under none (score.ts buildScore refuses either otherwise). A count that is not the stored score's differs at
   * `$.size`, as a cost that is not its own differs at `$.cost`.
   */
  size?: ScoreSizeT;
  /**
   * The judge heat the bundle's program/v1 harness names (ProgramHarness.judge), which a judged run's heat record is
   * held to (the header's judge): absent under none, and a run naming a judge heat record is then refused.
   */
  judge?: ProgramJudgeT;
  /**
   * The ladder the bundle's judge heat seals (`judge.ladder`), as grader/judge-ladder-tree.ts readJudgeLadder read it
   * (or why it refused), which a dev run's v3 provisional heat record is held to (the header's judge): its own value, or
   * a function reading it, called only when a v3 record is held. Absent: a v3 record is refused, nothing being there to
   * hold it to; a v1 or v2 record never reads it.
   */
  judgeLadder?: RegradeJudgeLadder | (() => RegradeJudgeLadder);
  /**
   * The bundle's prizes, which a screened final's v4 record's line M and race tiers are held to (the header's judge:
   * judgeShortlistPlaces over the last paid place, judgeRaceTiers over the placement prizes). Absent: M is held to the
   * record's own last tier, the tiers' shape being the record's own to hold (judge-heat.ts judgeHeatSetupIssues); no
   * other record reads them.
   */
  judgePrizes?: readonly Pick<PrizeT, 'kind' | 'place' | 'amount_usd'>[];
  /**
   * Where a screened final's sealed dev contender chain (a v4 record whose screen names one: the header's judge) is read
   * from, and how its members' ladder records are held: `all`, each one must be there (the grader's store, which kept
   * every one); `carried`, each one there is held and one that is not is left (a final kit carries only the dev records
   * the screen rated from, cli/verify-result.ts). Absent: this request's `blobs`, `all`. The chain held is remembered per
   * source (by `blobs` object), so every run of one final reads and holds it once.
   */
  judgeContender?: RegradeContenderSource;
  /**
   * What a panel final's v5 or v6 record's drawn panel is held to (the header's judge): the bundle's sealed pool file as
   * read from its judge directory (readRegradeJudgePanel), the bundle's final phase's starts_at and the dev-auth test
   * chain, if any (or why the file did not read): its own value, or a function reading it, called only when a v5 or v6
   * record is held. Absent: a v5 or v6 record is refused, nothing being there to hold it to; no other record reads it.
   */
  judgePanel?: RegradeJudgePanel | (() => RegradeJudgePanel);
  /**
   * A capped judged final's contender cut (contracts/competition.ts ProgramJudge.contenders), as its heat stored it
   * (grader/worker.ts storedJudgeContenderCut, its late decisions folded in: judge-cut.ts judgeCutViewOf), which a cut
   * run's stored score is held to (judgeVerdictOf: the screened-out score of the rating the cut kept for its entry, on
   * its artifact, byte for byte). Absent: a final run a capped final's record leaves out with a screened-out score is
   * refused, nothing being there to hold it to; an uncapped judge never reads it.
   */
  judgeCut?: JudgeCutView;
  /**
   * Whose regrade this is, as a label value (grader/sandbox/network.ts TRIAL_OWNER_RE), the same on every attempt of
   * the regrade and no other's (the pipeline's worker.ts regradeOwner, `regrade-<job id>`): the re-execution's and the
   * scorer's scratch is named for it (`exec-<owner>-XXXXXX`, `score-<owner>-XXXXXX`), and what a dead attempt of it left
   * under `workRoot` is removed before anything runs (grade.ts reapGradeScratch; the header's `owner`). Give one only
   * where no other attempt of the owner can be live. Absent: as before. A TypeError when it is no label value.
   */
  owner?: string;
  /** Told what the removal of a dead attempt's scratch took (and could not), each time it ran (an owner given). */
  onScratchReap?: (reaped: ScratchReap) => void;
  /**
   * Told why the breakdown the re-score recomputed made no trace (harnesses.ts Scored.traceIssue: a program/v1 scorer's
   * malformed checks.json; agent-score.ts agentChecksBreakdown's reason on an agent/v1 run), the regrade then carrying
   * none and its verdict the result's alone (the header's trace). Default: a line on stderr (grade.ts traceIssueLine).
   */
  onTraceIssue?: (issue: string) => void;
  /**
   * The job attempt's signal (server/jobs.ts JobContext.signal; the header's `stopping`). Once it aborts, the program
   * running (L2's re-execution, a program/v1 scorer) is killed and nothing more starts. regradeL1 and regradeL2 then
   * reject with its reason and hand back no outcome. The agent/v1 and scrape/v1 L1 requests omit it. Absent: never
   * stopped.
   */
  signal?: AbortSignal;
}

/**
 * `run`'s outcome under a regrade's signal (the header's `stopping`). Aborted before it starts, `run` never runs.
 * Aborted before it ends, no outcome comes back: the signal's reason is thrown in place of whatever the stopped run threw
 * or returned. By then executeOnce and scoreOnce have killed the program running and started nothing after it. With no
 * signal, `run` as it is.
 */
async function stoppable(signal: AbortSignal | undefined, run: () => Promise<RegradeOutcome>): Promise<RegradeOutcome> {
  if (signal === undefined) return run();
  signal.throwIfAborted();
  let outcome: RegradeOutcome;
  try {
    outcome = await run();
  } catch (err) {
    throw signal.aborted ? signal.reason : err;
  }
  signal.throwIfAborted();
  return outcome;
}

/** Tell `req` why its re-score's breakdown made no trace (RegradeL1Request.onTraceIssue, else a line on stderr). */
function tellTraceIssue(req: RegradeL1Request, kind: RegradeOutcome['kind'], issue: string): void {
  (req.onTraceIssue ?? ((i: string) => console.warn(traceIssueLine(`${kind} of run ${req.stored.id}`, i))))(issue);
}

/**
 * What a dead attempt of the regrade's owner left under its work root, removed and told to onScratchReap (the header's
 * `owner`): an execution's and a scorer's scratch named for it (grade.ts reapGradeScratch). Nothing without an owner.
 */
async function reapRegradeScratch(req: RegradeL1Request): Promise<void> {
  if (req.owner === undefined) return;
  req.onScratchReap?.(await reapGradeScratch(req.sandbox, req.workRoot, req.owner));
}

/** The run statuses with a scored action log to re-derive (the regrade route checks the same before it queues one). */
export const RESCORABLE: ReadonlySet<string> = new Set(['finished', 'nondeterministic']);

/** Why the plan cannot reproduce the run's failed-tx draws (the keys differ; neither is printed), or null. */
function failKeyMismatch(stored: StoredRun, plan: HarnessPlan): string | null {
  if (stored.fail_key === undefined || stored.fail_key === null || stored.fail_key === plan.failKey) return null;
  return `the fail key differs: run ${stored.id} was graded under another failed-transaction draw than the plan holds`;
}

/** The stored action log: the blob must hash to its name and be canonical JSON. */
export async function loadActionLog(blobs: Pick<BlobStore, 'get'>, sha256: string): Promise<unknown> {
  const bytes = await blobs.get(sha256, { verify: true }).catch((err: unknown) => {
    throw new RegradeError(`action log ${sha256} is corrupt: ${(err as Error).message}`);
  });
  if (bytes === null) throw new RegradeError(`action log ${sha256} is missing from the blob store`);
  if (sha256Hex(bytes) !== sha256) throw new RegradeError(`action log ${sha256} is corrupt: its bytes hash to ${sha256Hex(bytes)}`);
  const text = Buffer.from(bytes).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RegradeError(`action log ${sha256} is not JSON`);
  }
  if (canonicalJson(parsed) !== text) throw new RegradeError(`action log ${sha256} is not canonical JSON`);
  return parsed;
}

/**
 * The scorer_version a regrade rebuilds `stored`'s score under (the header's versions): this process's (scorerVersionOf
 * the plan and the sandbox), or the run's own when the run recorded a byte digest whose code digest is exactly that
 * (version.ts codeVersionOf: graded before the digests were over code, by the same scorer code). Any other stored
 * scorer_version is not this process's: the rebuilt score carries this process's, and differs at $.scorer_version.
 */
export function regradeScorerVersion(stored: Pick<StoredRun, 'scorer_version'>, plan: Pick<HarnessPlan, 'scorerVersion' | 'extraRuntimes'>, sandbox: Pick<Sandbox, 'imageDigest'>): string {
  const current = scorerVersionOf(plan, sandbox);
  if (stored.scorer_version === null || stored.scorer_version === current) return current;
  return codeVersionOf(stored.scorer_version) === current ? stored.scorer_version : current;
}

/** The flag an L1 regrade carries when it reproduced its run with only the platform scorer's `scorer@` digest moved (the header's versions: scorerMovedOf). */
export const SCORER_MOVED_FLAG = 'scorer_moved';

/** A scorer_version: its `scorer@` digest, then the rest (` program@<sha256>`, ` image@<digest>`…), empty when there is none. */
const SCORER_STAMP = /^scorer@([0-9a-f]{64})((?: .*)?)$/s;

/**
 * The two `scorer@` digests when scorer_versions `recorded` and `current` differ in that digest alone, the rest of each
 * (a ` program@`, an ` image@`) the same to the byte; null when they are equal, differ anywhere else, or either is no
 * `scorer@` version (the header's versions).
 */
export function scorerDigestMoved(recorded: string, current: string): { recorded: string; current: string } | null {
  const a = SCORER_STAMP.exec(recorded);
  const b = SCORER_STAMP.exec(current);
  if (a === null || b === null || a[1] === b[1] || a[2] !== b[2]) return null;
  return { recorded: a[1]!, current: b[1]! };
}

/** An L1 that reproduced its run with the platform scorer moved (scorerMovedOf). */
export interface ScorerMoved {
  /** The rebuilt score stamped with the run's scorer_version: the stored result, byte for byte. */
  result: ScoreT;
  digest: { json: string; sha256: string };
  /** The regrade's error line: both digests named. */
  note: string;
}

/**
 * Whether `rebuilt` (an L1's score, stamped with the scorer_version it re-scored under) reproduces `stored` with only
 * the platform scorer's digest moved (the header's versions): the run recorded a scorer_version, its stored result
 * carries that one, the two differ in their `scorer@` digest alone (scorerDigestMoved), and `rebuilt` stamped with the
 * run's is `storedJson` (the stored result's canonical JSON) byte for byte. Null otherwise: the regrade fails as before.
 */
export function scorerMovedOf(stored: Pick<StoredRun, 'id' | 'scorer_version' | 'result'>, storedJson: string, rebuilt: ScoreT): ScorerMoved | null {
  const recorded = stored.scorer_version;
  if (recorded === null || (stored.result as { scorer_version?: unknown } | null)?.scorer_version !== recorded) return null;
  const moved = scorerDigestMoved(recorded, rebuilt.scorer_version);
  if (moved === null) return null;
  const result: ScoreT = { ...rebuilt, scorer_version: recorded };
  const digest = scoreDigest(result);
  if (digest.json !== storedJson) return null;
  const rest = recorded.slice(`scorer@${moved.recorded}`.length).trim();
  return {
    result,
    digest,
    note:
      `${SCORER_MOVED_FLAG}: run ${stored.id} reproduces with the platform scorer moved: graded under scorer@${moved.recorded}, re-scored under scorer@${moved.current}` +
      `${rest === '' ? '' : ` (${rest} the same)`}, and its result re-derives byte for byte but that stamp, which is kept as the run recorded it`,
  };
}

/** An L1's verdict on `rebuilt` against the stored result (`storedJson`, its canonical JSON): byte for byte, or with the platform scorer moved (scorerMovedOf). */
function l1Verdict(stored: StoredRun, storedJson: string, rebuilt: ScoreT): { result: ScoreT; digest: { json: string; sha256: string }; reproduced: boolean; differences: string[]; moved: ScorerMoved | null } {
  const digest = scoreDigest(rebuilt);
  if (digest.json === storedJson) return { result: rebuilt, digest, reproduced: true, differences: [], moved: null };
  const moved = scorerMovedOf(stored, storedJson, rebuilt);
  if (moved !== null) return { result: moved.result, digest: moved.digest, reproduced: true, differences: [], moved };
  return { result: rebuilt, digest, reproduced: false, differences: jsonDifferences(stored.result, rebuilt), moved: null };
}

/**
 * A recorded harness_version as an L2 refusal names it (the header's versions): a byte digest with the code digest it
 * is over beside it (version.ts codeVersionOf), so the refusal shows the harness's code moved; any other as it is.
 */
function recordedHarness(recorded: string | null): string {
  const code = recorded === null ? null : codeVersionOf(recorded);
  return code === null ? String(recorded) : `${recorded} (over code ${code})`;
}

/** The flag an L2 regrade carries when this process's harness_version is not the run's (the header's versions: underMovedHarness). */
export const HARNESS_MOVED_FLAG = 'harness_moved';

/** Why an L2 cannot hold the run to its own harness: the sentence a refusal under another harness said before the harness could move (the header's versions). */
function harnessDiffers(stored: Pick<StoredRun, 'harness_version'>, current: string): string {
  return `harness_version differs: the run was graded by ${recordedHarness(stored.harness_version)}, this grader is ${current}`;
}

/**
 * An L2's verdict once it ran under a harness_version (`current`) that is not the run's (the header's versions): it
 * accepts only on equality. Reproduced (the re-execution's action log the run's byte for byte, or every trial its stored
 * verdict, and the L1 after it reproducing): `finished` as it came, flagged `harness_moved`, its error a line naming both
 * harnesses (before any line L1 wrote, a scorer_moved one). Anything else, whatever its status (a timeout, a failed
 * execution, another action log, a trial off its verdict, an L1 that differs): `failed`, never `nondeterministic` or
 * `timeout`, differing at `$.harness.version` first and then where it differed, its error opening with the refusal's
 * sentence and saying the re-execution under this harness did not reproduce the run and proves nothing about the entry,
 * flagged `harness_moved`: a difference the moved harness may have made is never held against the entry.
 */
export function underMovedHarness(outcome: RegradeOutcome, stored: Pick<StoredRun, 'id' | 'harness_version'>, current: string): RegradeOutcome {
  const flags = withFlag(outcome.flags, HARNESS_MOVED_FLAG);
  if (outcome.reproduced && outcome.status === 'finished') {
    const note = `${HARNESS_MOVED_FLAG}: run ${stored.id} reproduces with the harness moved: graded by ${recordedHarness(stored.harness_version)}, re-executed by ${current}, its re-execution and its result re-derived byte for byte`;
    return { ...outcome, error: outcome.error === null ? note : `${note}; ${outcome.error}`, flags };
  }
  const why = outcome.error ?? `regraded ${outcome.status}`;
  return {
    ...outcome,
    status: 'failed',
    reproduced: false,
    error: `${harnessDiffers(stored, current)}; the re-execution under this harness did not reproduce the run (${outcome.status}: ${why}), which proves nothing about the entry`,
    differences: ['$.harness.version', ...outcome.differences.filter((d) => d !== '$.harness.version')],
    flags,
  };
}

function emptyOutcome(kind: RegradeOutcome['kind'], stored: StoredRun, plan: HarnessPlan, sandbox: Sandbox, startedAt: Date): RegradeOutcome {
  return {
    kind,
    reproduces_run_id: stored.id,
    status: 'failed',
    reproduced: false,
    error: null,
    differences: [],
    result: null,
    result_sha256: null,
    trace_json: null,
    trace_sha256: null,
    action_log_sha256: stored.action_log_sha256,
    harness_version: stored.harness_version,
    scorer_version: regradeScorerVersion(stored, plan, sandbox),
    image_digest: stored.image_digest,
    dataset_sha256: stored.dataset_sha256,
    seed: stored.seed,
    fail_key: plan.failKey,
    flags: [...stored.flags],
    exec_count: 0,
    wall_ms: 0,
    executions: [],
    stderr: Buffer.alloc(0),
    started_at: startedAt,
    finished_at: startedAt,
  };
}

/**
 * L1: re-score the stored action log and compare the rebuilt score with the stored one byte for byte. With an owner,
 * what a dead attempt of it left under the work root goes first (the header's `owner`). If its signal aborts before
 * it ends (the header's `stopping`), the scorer is killed and it rejects with the signal's reason, no outcome.
 */
export async function regradeL1(req: RegradeL1Request, kind: RegradeOutcome['kind'] = 'regrade_l1', startedAt = new Date()): Promise<RegradeOutcome> {
  return stoppable(req.signal, async () => {
    await reapRegradeScratch(req);
    return rescore(req, kind, startedAt);
  });
}

/** L1's re-score and comparison (regradeL1), and L2's once its re-execution reproduced the action log: no reap, the regrade's own having run. */
async function rescore(req: RegradeL1Request, kind: RegradeOutcome['kind'], startedAt: Date): Promise<RegradeOutcome> {
  const { stored, plan } = req;
  const out = emptyOutcome(kind, stored, plan, req.sandbox, startedAt);
  const fail = (error: string, differences: string[] = []): RegradeOutcome => ({ ...out, status: 'failed', error, differences, finished_at: new Date() });

  if (!RESCORABLE.has(stored.status) || stored.result === null || stored.result === undefined || stored.action_log_sha256 === null) {
    throw new RegradeError(`run ${stored.id} (${stored.status}) has no scored action log to re-derive`);
  }
  if (stored.harness_version === null || stored.seed === null) throw new RegradeError(`run ${stored.id} lacks its harness_version or seed`);
  const storedJson = canonicalJson(stored.result);
  if (stored.result_sha256 !== sha256Hex(storedJson)) return fail(`run ${stored.id}'s stored result no longer hashes to its result_sha256`);
  if (stored.dataset_sha256 !== plan.datasetSha256) {
    return fail(`dataset_sha256 differs: the run used ${stored.dataset_sha256}, the plan holds ${plan.datasetSha256}`, ['$.dataset_sha256']);
  }
  const keyed = failKeyMismatch(stored, plan);
  if (keyed !== null) return fail(keyed, ['fail_key']);
  // A code-fastest score's timing verdict (the header's timing), read before anything is scored: a heat record that
  // does not hold, or does not time this run, is the RegradeError that stops it.
  const timing = await timingVerdictOf(req);
  // A judged score's verdict (the header's judge), alike: a record that does not hold, or does not judge this run, stops it.
  const judged = await judgeVerdictOf(req);

  const log = plan.parseLog(await loadActionLog(req.blobs, stored.action_log_sha256));
  // The run time the grade's scorer read (program.ts RUN_FILE), re-handed from the stored run: none when it stores none.
  const run = storedRunTime(stored);
  // The entry's launch (contracts/score.ts ProgramEntryLinkScore), in order of truth: the submission's record the caller
  // hands (the pipeline's EntryFacts.entry_link, so a record that moved fails the L1 at $.performance.entry_link.slot),
  // else the record loadStoredRun read from the run's submission row, else the block the stored score carries (an
  // export's L1, cli/verify-result.ts, which has neither). A record that no longer reads as a verified launch leaves the
  // block off and the difference is reported; the score is rebuilt with the same launch, so it reproduces byte for byte.
  const launch =
    req.entry.entry_link !== undefined
      ? entryLinkFactsOf(req.entry.entry_link)
      : stored.entry_link !== undefined && stored.entry_link !== null
        ? entryLinkFactsOf(stored.entry_link)
        : storedLaunchOf(stored.result);
  const scored = await scoreOnce(plan, { sandbox: req.sandbox, blobs: req.blobs, limits: req.limits, ...(run === null ? {} : { run }) }, req.workRoot, log, req.owner, req.signal);
  const rebuilt = judged.verdict === undefined || scored.performance.kind !== 'program/v1' ? scored.performance : { ...scored.performance, judge: judged.verdict };
  let result: ScoreT;
  try {
    result = buildScore(
      {
        harness: { kind: plan.kind, version: stored.harness_version },
        image_digest: stored.image_digest,
        dataset_sha256: stored.dataset_sha256,
        seed: stored.seed,
        deterministic: stored.status !== 'nondeterministic',
        // The run's own flags but those it carries beside its score, never an execution's (RUN_ONLY_FLAGS: secret_in_output).
        execution_flags: stored.flags.filter((f) => !RUN_ONLY_FLAGS.has(f)),
        house: req.entry.house,
        baseline: req.entry.baseline,
      },
      {
        action_log_sha256: stored.action_log_sha256,
        // The entry's launch, as the stored score carried it or as the submission's record now reads (contracts/score.ts
        // ProgramPerformance.entry_link), so the rebuilt score is the stored one byte for byte where nothing moved.
        performance: withEntryLink(rebuilt, launch),
        performance_flags: scored.flags,
        cost: req.cost,
        authorship: req.authorship,
        size: req.size,
        ...(timing.verdict === undefined ? {} : { timing: timing.verdict }),
      },
      req.rules,
      out.scorer_version,
    );
  } catch (err) {
    // A judge verdict the re-scored outputs cannot carry (contracts/score.ts: a verdict is an entry's that passed the gate).
    if (judged.verdict !== undefined && err instanceof z.ZodError && err.issues.some((i) => i.path.includes('judge'))) {
      const from = judged.heat === null ? 'the judge verdict its stored score carries' : `its verdict in judge heat record ${judged.heat}`;
      return { ...fail(`run ${stored.id}'s re-scored outputs cannot take ${from}: they do not pass the gate`, ['$.performance.passed']), ...heatOf(timing), ...judgeHeatOf(judged) };
    }
    // A verdict the re-scored outputs cannot carry (score.ts timingOf): they no longer pass the gate the stored score's did.
    if (timing.verdict === undefined || !(err instanceof TypeError) || !/\btiming\b/.test(err.message)) throw err;
    const from = timing.heat === null ? 'the timing verdict its stored score carries' : `its verdict in heat record ${timing.heat}`;
    return { ...fail(`run ${stored.id}'s re-scored outputs cannot take ${from}: ${err.message}`, [/did not pass/.test(err.message) ? '$.performance.passed' : '$.performance.timing']), ...heatOf(timing) };
  }
  // Byte for byte, or with the platform scorer moved alone (the header's versions).
  const verdict = l1Verdict(stored, storedJson, result);
  const { reproduced, differences, moved } = verdict;
  // The trace beside the result (the header's trace): compared, flagged, never part of the verdict.
  const trace = scored.trace === undefined ? null : encodeTrace(scored.trace);
  if (scored.traceIssue !== undefined) tellTraceIssue(req, kind, scored.traceIssue);
  const differs = await traceDiffers(req.blobs, stored.trace_sha256 ?? null, trace?.json ?? null);
  const why = `the result differs from run ${stored.id}'s at ${differences.join(', ')}`;
  const flags = moved === null ? out.flags : withFlag(out.flags, SCORER_MOVED_FLAG);
  return {
    ...out,
    ...heatOf(timing),
    ...judgeHeatOf(judged),
    status: reproduced ? 'finished' : 'failed',
    reproduced,
    error: reproduced ? (moved?.note ?? null) : timing.why === undefined ? why : `${timing.why}; ${why}`,
    differences,
    result: verdict.result,
    result_sha256: verdict.digest.sha256,
    trace_json: trace?.json ?? null,
    trace_sha256: trace?.sha256 ?? null,
    flags: differs ? withFlag(flags, TRACE_DIFFERS_FLAG) : flags,
    finished_at: new Date(),
  };
}

// ---------------------------------------------------------------- program/v1: a timing heat's verdict

/**
 * A code-fastest heat record as stored (the header's timing): the blob `sha256` names read back verified, kept as its
 * canonical JSON (grader/code-heat.ts codeHeatRecordDigest, the bytes the heat stored), and a record that holds
 * (parseCodeHeatRecord: every order, matched flag and finalist re-derived from the rest). RegradeError when it is
 * missing, corrupt, kept in other bytes, or no record that holds.
 */
export async function loadCodeHeatRecord(blobs: Pick<BlobStore, 'get'>, sha256: string): Promise<CodeHeatRecordT> {
  if (!Sha256Hex.safeParse(sha256).success) throw new RegradeError(`the heat record link ${JSON.stringify(sha256)} is no sha256`);
  const bytes = await blobs.get(sha256, { verify: true }).catch((err: unknown) => {
    throw new RegradeError(`heat record ${sha256} is corrupt: ${(err as Error).message}`);
  });
  if (bytes === null) throw new RegradeError(`heat record ${sha256} is missing from the blob store`);
  if (sha256Hex(bytes) !== sha256) throw new RegradeError(`heat record ${sha256} is corrupt: its bytes hash to ${sha256Hex(bytes)}`);
  let record: CodeHeatRecordT;
  try {
    record = parseCodeHeatRecord(bytes);
  } catch (err) {
    if (err instanceof CodeHeatError) throw new RegradeError(`heat record ${sha256} is refused: ${err.message}`);
    throw err;
  }
  if (codeHeatRecordDigest(record).json !== Buffer.from(bytes).toString('utf8')) throw new RegradeError(`heat record ${sha256} is not kept as its canonical JSON (grader/code-heat.ts codeHeatRecordDigest)`);
  return record;
}

/** A run as codeHeatVerdictOf reads its verdict for it. */
export interface HeatTimedRun {
  id: string;
  /** The entry it grades (run.submission_id); absent: the record's one field entry whose graded action log is the run's. */
  submission_id?: string;
  action_log_sha256: string;
  seed: string;
}

/**
 * A run's verdict in its heat's record (the header's timing): the record's field entry of the run's submission (absent:
 * the one entry whose graded action log is the run's), held to the run (that entry's graded action log the run's, the
 * record's phase seed the run's seed) and to the harness's timing heat `timing` (the record ran those numbers), and its
 * verdict (grader/code-heat.ts codeHeatVerdicts: its timing over its main and playoff runs, or TIMING_OUTPUTS_DIFFER).
 * `record` is one that holds (loadCodeHeatRecord, parseCodeHeatRecord); `sha256` names it in the refusals. RegradeError
 * when the record does not time this run.
 */
export function codeHeatVerdictOf(record: CodeHeatRecordT, sha256: string, run: HeatTimedRun, timing: ProgramTimingT | undefined): { entry: string; verdict: TimingVerdictT } {
  const what = `heat record ${sha256}`;
  if (timing === undefined) throw new RegradeError(`run ${run.id} names ${what}, but its harness names no timing heat: a heat's verdict is a code-fastest score's alone`);
  const ruled = canonicalJson(ProgramTiming.parse(timing));
  if (canonicalJson(record.timing) !== ruled) throw new RegradeError(`${what} timed its field under ${canonicalJson(record.timing)}, and the harness's timing heat is ${ruled}: it is no heat of these rules`);
  if (record.phase_seed !== run.seed) throw new RegradeError(`${what} drew its orders from phase seed ${record.phase_seed}, and run ${run.id} was graded under seed ${run.seed}: it is no heat of this run's phase`);
  let entry: CodeHeatRecordT['entries'][number] | undefined;
  if (run.submission_id !== undefined) {
    const id = run.submission_id.toLowerCase();
    entry = record.entries.find((e) => e.entry === id);
    if (entry === undefined) throw new RegradeError(`${what} does not time entry ${id}, whose run ${run.id} names it: its field is ${record.entries.length} other entr${record.entries.length === 1 ? 'y' : 'ies'}`);
  } else {
    const same = record.entries.filter((e) => e.action_log_sha256 === run.action_log_sha256);
    if (same.length !== 1) {
      throw new RegradeError(
        same.length === 0
          ? `${what} times no entry on run ${run.id}'s graded action log ${run.action_log_sha256}: it is not this run's heat`
          : `${what} times ${same.length} entries on run ${run.id}'s graded action log (${same.map((e) => e.entry).join(', ')}): which one is the run's is its entry's id (StoredRun.submission_id)`,
      );
    }
    entry = same[0]!;
  }
  if (entry.action_log_sha256 !== run.action_log_sha256) {
    throw new RegradeError(`${what} timed entry ${entry.entry} on graded action log ${entry.action_log_sha256}, and run ${run.id}'s is ${run.action_log_sha256}: it timed another grade of the entry`);
  }
  let verdicts: Map<string, TimingVerdictT>;
  try {
    verdicts = codeHeatVerdicts(record);
  } catch (err) {
    if (err instanceof CodeHeatError) throw new RegradeError(`${what} is refused: ${err.message}`);
    throw err;
  }
  const verdict = verdicts.get(entry.entry);
  if (verdict === undefined) throw new RegradeError(`${what} lists entry ${entry.entry} in its field and holds no run of it`);
  return { entry: entry.entry, verdict };
}

/**
 * The timing a stored score carries, as a regrade reads it (the header's timing): `carried`, a verdict no record holds
 * (the dev phase's provisional timing, codeTimingProvisional, or TIMING_OUTPUTS_DIFFER with no timing); `heat`, a heat's
 * timing, which only its record re-derives; else `none` (no program/v1 score, or one with no timing).
 */
export function storedTimingOf(result: unknown): { kind: 'none' } | { kind: 'carried'; verdict: TimingVerdictT } | { kind: 'heat'; rounds: number } {
  const parsed = Score.safeParse(result);
  if (!parsed.success || parsed.data.performance.kind !== 'program/v1') return { kind: 'none' };
  const t = parsed.data.performance.timing;
  if (t !== undefined) return codeTimingProvisional(t) ? { kind: 'carried', verdict: t } : { kind: 'heat', rounds: t.rounds };
  return parsed.data.eligibility.reasons.includes(TIMING_OUTPUTS_DIFFER) ? { kind: 'carried', verdict: TIMING_OUTPUTS_DIFFER } : { kind: 'none' };
}

/** What rescore builds a program/v1 score with (timingVerdictOf): the verdict, the heat record it came from, and why a stored timing has none. */
interface TimingVerdict {
  verdict?: TimingVerdictT;
  /** The heat record read (StoredRun.code_heat_sha256); null when none was. */
  heat: string | null;
  /** Why a heat's timing the stored score carries is not re-derived (no record named): told beside the differences. */
  why?: string;
}

/** The outcome's link to the heat record a regrade read (RegradeOutcome.code_heat_sha256), when it read one. */
function heatOf(t: TimingVerdict): { code_heat_sha256?: string } {
  return t.heat === null ? {} : { code_heat_sha256: t.heat };
}

/**
 * The timing verdict a run is re-scored with (the header's timing): from the heat record it names, held to it
 * (loadCodeHeatRecord, codeHeatVerdictOf); else a verdict no record holds carried over from its stored score
 * (storedTimingOf), under a timing heat only; else none, with why when the stored score carries a heat's timing. A
 * record that does not hold or does not time the run is a RegradeError.
 */
async function timingVerdictOf(req: RegradeL1Request): Promise<TimingVerdict> {
  const { stored } = req;
  const link = stored.code_heat_sha256 ?? null;
  if (link !== null) {
    const record = await loadCodeHeatRecord(req.blobs, link);
    const run: HeatTimedRun = { id: stored.id, action_log_sha256: stored.action_log_sha256!, seed: stored.seed!, ...(stored.submission_id === undefined ? {} : { submission_id: stored.submission_id }) };
    return { verdict: codeHeatVerdictOf(record, link, run, req.rules.timing).verdict, heat: link };
  }
  if (req.rules.timing === undefined) return { heat: null };
  const carried = storedTimingOf(stored.result);
  if (carried.kind === 'carried') return { verdict: carried.verdict, heat: null };
  if (carried.kind === 'heat') {
    return { heat: null, why: `run ${stored.id}'s stored score carries a heat's timing over ${carried.rounds} runs, and the run names no heat record (code_heat_sha256): a heat's timing is re-derived from its record, never carried over` };
  }
  return { heat: null };
}

/**
 * A judge heat record as stored (the header's judge): the blob `sha256` names read back verified, kept as its canonical
 * JSON (grader/judge-heat.ts judgeHeatRecordDigest, the bytes the heat stored), and a record that holds
 * (parseJudgeHeatRecord: its schedule, games and finalists re-derived from its calls). RegradeError when it is missing,
 * corrupt, kept in other bytes, or no record that holds. The bytes are hashed, parsed and held off this thread
 * (grader/judge-heat-tasks.ts judgeHeatRecordLoadOffThread), and the whole record comes back: a regrade reads the
 * record's head and scores alone (loadHeldJudgeHeatRecord).
 */
export async function loadJudgeHeatRecord(blobs: Pick<BlobStore, 'get'>, sha256: string): Promise<JudgeHeatRecordT> {
  const read = await readJudgeHeatRecord(blobs, sha256, true);
  return read.record!;
}

/** A stored judge heat record read back off this thread (loadJudgeHeatRecord's checks, its RegradeErrors), its head, and its scores or its whole record. */
async function readJudgeHeatRecord(blobs: Pick<BlobStore, 'get'>, sha256: string, whole: boolean): Promise<Extract<JudgeRecordLoadAnswer, { head: unknown }>> {
  if (!Sha256Hex.safeParse(sha256).success) throw new RegradeError(`the judge heat record link ${JSON.stringify(sha256)} is no sha256`);
  // Read unverified: the thread hashes the bytes (a BlobStore's verify would hash them here), and words a mismatch as it does.
  const bytes = await blobs.get(sha256).catch((err: unknown) => {
    throw new RegradeError(`judge heat record ${sha256} is corrupt: ${(err as Error).message}`);
  });
  if (bytes === null) throw new RegradeError(`judge heat record ${sha256} is missing from the blob store`);
  const read = await judgeHeatRecordLoadOffThread({ sha256, bytes, whole });
  if ('corrupt' in read) throw new RegradeError(`judge heat record ${sha256} is corrupt: blob ${sha256} hashes to ${read.corrupt}`);
  if ('refused' in read) throw new RegradeError(`judge heat record ${sha256} is refused: ${read.refused}`);
  if ('uncanonical' in read) throw new RegradeError(`judge heat record ${sha256} is not kept as its canonical JSON (grader/judge-heat.ts judgeHeatRecordDigest)`);
  return read;
}

/**
 * A judge heat record read back for its verdicts (loadHeldJudgeHeatRecord): `sha256` its name, `record` its head (every
 * key but its calls, games and spares: what a regrade holds it to, judgeHeldVerdictOf), and `scores` every member's
 * score by artifact (grader/judge-heat.ts judgeHeatVerdicts), or why they do not derive.
 */
export interface HeldJudgeHeatRecord {
  sha256: string;
  record: JudgeHeatRecordHeadT;
  scores: ReadonlyMap<string, ProgramJudgeScoreT> | { refused: string };
}

/** The held records this process read, by blob store, then by sha256, the most recently read last (HELD_JUDGE_RECORDS_KEPT of them a store). */
const heldJudgeRecords = new WeakMap<object, Map<string, Promise<HeldJudgeHeatRecord>>>();
const HELD_JUDGE_RECORDS_KEPT = 16;

/**
 * A judge heat record `sha256` of `blobs` read back held (loadJudgeHeatRecord's checks and RegradeErrors) with its
 * scores, all off this thread, once a process: a record is named by its bytes, so a final's every run regraded, or every
 * dev grade that looks for a verdict to reuse, reads it once (a final's 22 MB record took 1-2 s of this thread a read,
 * a read a run). Only a record that reads back is kept; a read in flight is joined.
 */
export function loadHeldJudgeHeatRecord(blobs: Pick<BlobStore, 'get'>, sha256: string): Promise<HeldJudgeHeatRecord> {
  let kept = heldJudgeRecords.get(blobs);
  if (kept === undefined) {
    kept = new Map();
    heldJudgeRecords.set(blobs, kept);
  }
  const hit = kept.get(sha256);
  if (hit !== undefined) {
    kept.delete(sha256);
    kept.set(sha256, hit);
    return hit;
  }
  const store = kept;
  const read = readJudgeHeatRecord(blobs, sha256, false).then((r): HeldJudgeHeatRecord => ({ sha256, record: r.head, scores: r.scores ?? { refused: r.scoresIssue ?? 'its scores were not derived' } }));
  store.set(sha256, read);
  read.catch(() => {
    if (store.get(sha256) === read) store.delete(sha256);
  });
  while (store.size > HELD_JUDGE_RECORDS_KEPT) store.delete(store.keys().next().value!);
  return read;
}

/** A run as judgeRecordVerdictOf reads its verdict for it: StoredRun's own fields. */
export interface HeatJudgedRun {
  id: string;
  /** The entry it grades (run.submission_id); absent: the record's member judged on the run's artifact, when it holds one entry. */
  submission_id?: string;
  seed: string;
  /** The sha256 of the artifact the run's outputs hold (ProgramJudge.artifact in its action log). */
  artifact_sha256: string;
  /** Its size in bytes: held to the member's artifact_bytes a v2 record carries (an exact tie's second link). */
  artifact_bytes?: number;
}

/**
 * A run's verdict in its judge heat's record (the header's judge): the record held to the bundle's judge heat `judge`
 * (its judge directory, model call, media, artifact and schedule: the record ran those) and to the run (the record's
 * phase seed the run's seed; the member of the run's entry, absent the one entry judged on its artifact, judged on the
 * artifact the run's outputs hold, and of the size they hold where the run names it and the record carries one), and
 * that entry's verdict (judge-heat.ts judgeHeatEntryVerdicts). A v3 record, a dev entry's provisional heat on a
 * ladder, is held to the bundle's ladder besides: `ladder`, what readJudgeLadder read of it (holdJudgeLadderRecord).
 * A v4 record, a screened final's, is held to the bundle's screened block and `prizes` (holdScreenedRecord), and a v5
 * or v6 record, a panel final's or a dealt one's, besides to the bundle's sealed pool and the round rule (`panel`:
 * holdPanelRecord; its beacon's signature is regradeL1's to check, off the event loop: holdPanelBeacon), each in the
 * format the bundle's judge writes (holdFinalFormat); an entry
 * its screen left out has the verdict its dev rating carries (screened_out).
 * A provisional record whose field lists no member of the run's entry judges a run that reused its verdict (a dev
 * artifact byte-identical to one judged in the phase: reusedMemberOf): its member is the field's one entrant member,
 * judged on the artifact the run's outputs hold, and the verdict is that artifact's (judge-heat.ts judgeHeatVerdicts).
 * A final record never: it refuses an entry it does not name.
 * `record` is one that holds (loadJudgeHeatRecord); `sha256` names it in the refusals. RegradeError when the record
 * does not judge this run, or not under this judge.
 */
export function judgeRecordVerdictOf(
  record: JudgeHeatRecordT,
  sha256: string,
  run: HeatJudgedRun,
  judge: ProgramJudgeT | undefined,
  ladder?: RegradeJudgeLadder | (() => RegradeJudgeLadder),
  prizes?: RegradeL1Request['judgePrizes'],
  panel?: RegradeL1Request['judgePanel'],
): { entry: string; verdict: ProgramJudgeScoreT } {
  return verdictInRecord(record, sha256, run, judge, ladder, prizes, panel, () => recordScoresOf(record));
}

/** judgeRecordVerdictOf over a record read back held (loadHeldJudgeHeatRecord): its head held, its verdict from its scores. */
export function judgeHeldVerdictOf(
  held: HeldJudgeHeatRecord,
  run: HeatJudgedRun,
  judge: ProgramJudgeT | undefined,
  ladder?: RegradeJudgeLadder | (() => RegradeJudgeLadder),
  prizes?: RegradeL1Request['judgePrizes'],
  panel?: RegradeL1Request['judgePanel'],
): { entry: string; verdict: ProgramJudgeScoreT } {
  return verdictInRecord(held.record, held.sha256, run, judge, ladder, prizes, panel, () => {
    if ('refused' in held.scores) throw new JudgeHeatError(String(held.scores.refused));
    return held.scores as ReadonlyMap<string, ProgramJudgeScoreT>;
  });
}

/**
 * Every member's score of a whole record (judge-heat.ts judgeHeatVerdicts), once per record object: a caller that holds
 * one record to each of its runs (cli/verify-result.ts, a test) derives them once. The record is never changed once read.
 */
const recordScores = new WeakMap<object, ReadonlyMap<string, ProgramJudgeScoreT> | { refused: string }>();
function recordScoresOf(record: JudgeHeatRecordT): ReadonlyMap<string, ProgramJudgeScoreT> {
  let kept = recordScores.get(record);
  if (kept === undefined) {
    try {
      kept = judgeHeatVerdicts(record);
    } catch (err) {
      if (!(err instanceof JudgeHeatError)) throw err;
      kept = { refused: err.message };
    }
    recordScores.set(record, kept);
  }
  if ('refused' in kept) throw new JudgeHeatError(String(kept.refused));
  return kept as ReadonlyMap<string, ProgramJudgeScoreT>;
}

/** Each entry's verdict from its members' scores (judge-heat.ts judgeHeatEntryVerdicts), once per scores map. */
const entryVerdicts = new WeakMap<object, Map<string, ProgramJudgeScoreT>>();
function entryVerdictsOf(record: JudgeHeatRecordHeadT, scores: ReadonlyMap<string, ProgramJudgeScoreT>): Map<string, ProgramJudgeScoreT> {
  let kept = entryVerdicts.get(scores);
  if (kept === undefined) {
    kept = judgeHeatEntryVerdictsOf(record.field, scores);
    entryVerdicts.set(scores, kept);
  }
  return kept;
}

/** judgeRecordVerdictOf's work over a record's head, `scoresOf` its members' scores (a JudgeHeatError when they do not derive). */
function verdictInRecord(
  record: JudgeHeatRecordHeadT,
  sha256: string,
  run: HeatJudgedRun,
  judge: ProgramJudgeT | undefined,
  ladder: RegradeJudgeLadder | (() => RegradeJudgeLadder) | undefined,
  prizes: RegradeL1Request['judgePrizes'],
  panel: RegradeL1Request['judgePanel'],
  scoresOf: () => ReadonlyMap<string, ProgramJudgeScoreT>,
): { entry: string; verdict: ProgramJudgeScoreT } {
  const what = `judge heat record ${sha256}`;
  holdJudgeHeatRecord(record, what, run, judge, ladder, prizes, panel);
  let entry: string;
  let member: JudgeHeatRecordT['field'][number] | undefined;
  let reused = false;
  if (run.submission_id !== undefined) {
    entry = run.submission_id.toLowerCase();
    member = record.field.find((m) => m.entries.includes(entry));
    if (member === undefined) {
      // A dev run that took the verdict of an earlier entry's byte-identical artifact: the provisional record judged that entry.
      member = reusedMemberOf(record, run.artifact_sha256);
      if (member === undefined) throw new RegradeError(`${what} does not judge entry ${entry}, whose run ${run.id} names it`);
      reused = true;
    }
    if (member.artifact_sha256 !== run.artifact_sha256) {
      throw new RegradeError(`${what} judged entry ${entry} on artifact ${member.artifact_sha256}, and run ${run.id}'s outputs hold ${run.artifact_sha256}: it judged another grade of the entry`);
    }
  } else {
    member = record.field.find((m) => m.artifact_sha256 === run.artifact_sha256);
    if (member === undefined || member.entries.length !== 1) {
      throw new RegradeError(
        member === undefined
          ? `${what} judges no member on run ${run.id}'s artifact ${run.artifact_sha256}: it is not this run's heat`
          : `${what} judges ${member.entries.length} entries on run ${run.id}'s artifact (${member.entries.join(', ') || 'a house anchor'}): which one is the run's is its entry's id (StoredRun.submission_id)`,
      );
    }
    entry = member.entries[0]!;
  }
  if (member.artifact_bytes !== undefined && run.artifact_bytes !== undefined && member.artifact_bytes !== run.artifact_bytes) {
    throw new RegradeError(`${what} records entry ${entry}'s artifact ${member.artifact_sha256} as ${member.artifact_bytes} bytes, and run ${run.id}'s outputs hold ${run.artifact_bytes}: its exact-tie size is not the artifact's`);
  }
  let verdicts: ReadonlyMap<string, ProgramJudgeScoreT>;
  try {
    // A reused verdict is keyed by the artifact (judgeHeatVerdicts), the record's field naming another entry on it.
    const scores = scoresOf();
    verdicts = reused ? scores : entryVerdictsOf(record, scores);
  } catch (err) {
    if (err instanceof JudgeHeatError) throw new RegradeError(`${what} is refused: ${err.message}`);
    throw err;
  }
  const verdict = verdicts.get(reused ? member.artifact_sha256 : entry);
  if (verdict === undefined) {
    throw new RegradeError(
      reused
        ? `${what} lists artifact ${member.artifact_sha256}, whose verdict run ${run.id} of entry ${entry} reused, in its field and holds no game of it`
        : `${what} lists entry ${entry} in its field and holds no game of it`,
    );
  }
  return { entry, verdict };
}

/**
 * The member of a provisional record (a dev entry's heat) judged on `artifactSha256` when its field lists no member of
 * the run's entry: a run that reused the verdict of an earlier entry's byte-identical artifact links the record that
 * judged that entry. A provisional field holds exactly one entrant member (its anchors and rungs hold none), so the
 * member is that one, and only when it was judged on the run's artifact. Undefined for a final record, which names
 * every entry it judges, or for any other artifact.
 */
function reusedMemberOf(record: JudgeHeatRecordHeadT, artifactSha256: string | null): JudgeHeatRecordT['field'][number] | undefined {
  if (record.stage !== 'provisional' || artifactSha256 === null) return undefined;
  const entrants = record.field.filter((m) => m.entries.length > 0);
  return entrants.length === 1 && entrants[0]!.artifact_sha256 === artifactSha256 ? entrants[0] : undefined;
}

/**
 * Whether a judge heat record's field names a run (judgeVerdictOf): the run's entry among a member's entries (its
 * submission_id), absent a member judged on the artifact the run's outputs hold (null: they hold none). The record is
 * held first, as judgeRecordVerdictOf holds it, to the bundle's judge heat and to the run's phase seed: a RegradeError
 * when it is no heat of these rules or of this run's phase. A final heat's field names no entry it left out (worker.ts
 * judgeHeatInputs: it wrote no artifact, or one the judge cannot read), whose run it links all the same.
 */
function judgeRecordNamesRun(
  record: JudgeHeatRecordHeadT,
  sha256: string,
  run: Omit<HeatJudgedRun, 'artifact_sha256'> & { artifact_sha256: string | null },
  judge: ProgramJudgeT | undefined,
  ladder: RegradeJudgeLadder | (() => RegradeJudgeLadder) | undefined,
  prizes: RegradeL1Request['judgePrizes'],
  panel: RegradeL1Request['judgePanel'],
): boolean {
  holdJudgeHeatRecord(record, `judge heat record ${sha256}`, run, judge, ladder, prizes, panel);
  if (run.submission_id !== undefined) {
    const entry = run.submission_id.toLowerCase();
    // A provisional record also names a run that reused its entry's verdict on the same artifact (reusedMemberOf); a final record never.
    return record.field.some((m) => m.entries.includes(entry)) || reusedMemberOf(record, run.artifact_sha256) !== undefined;
  }
  return run.artifact_sha256 !== null && record.field.some((m) => m.artifact_sha256 === run.artifact_sha256);
}

/**
 * A judge heat record held to the bundle's judge heat `judge` (its judge directory, model call, media, artifact and, a
 * final heat's, its schedule), to the run's phase seed (judgeRecordVerdictOf, judgeRecordNamesRun), a v3 record's to
 * the bundle's ladder (holdJudgeLadderRecord: `ladder`, read only then), a v4, v5 or v6 record's to the bundle's
 * screened block and `prizes` (holdScreenedRecord), and a v5 or v6 record's drawn panel to the bundle's sealed pool and
 * the round rule (holdPanelRecord: `panel`, read only then; its beacon's signature is holdPanelBeacon's, off the event
 * loop, which judgeVerdictOf awaits); `what` names the record in the refusals. RegradeError when it is no heat of these
 * rules or of this run's phase: a final record whose format is not the one the bundle's judge writes
 * (judgeHeatFinalFormatOf: v4 exactly when it screens its final and draws no panel, v5 exactly when it screens its final
 * and draws an undealt panel, v6 exactly when its panel names deal: true; holdFinalFormat) among them.
 */
function holdJudgeHeatRecord(
  record: JudgeHeatRecordHeadT,
  what: string,
  run: { id: string; seed: string },
  judge: ProgramJudgeT | undefined,
  ladder: RegradeJudgeLadder | (() => RegradeJudgeLadder) | undefined,
  prizes: RegradeL1Request['judgePrizes'],
  panel: RegradeL1Request['judgePanel'],
): asserts judge is ProgramJudgeT {
  if (judge === undefined) throw new RegradeError(`run ${run.id} names ${what}, but its harness names no judge heat: a judge heat's verdict is a judged score's alone`);
  // The record's judge and schedule beside the harness's: a provisional heat runs no schedule of the harness's (its rounds 0), and playoff_places is held when the harness pins it (else it follows from the prizes).
  const pairs: [string, unknown, unknown][] = [
    ['agent', canonicalJson(record.agent), canonicalJson(judge.agent)],
    ['judge_sha256', record.judge_sha256, judge.judge_sha256],
    ['media', record.media, judge.media],
    ['artifact', record.artifact, judge.artifact],
  ];
  if (record.stage === 'final') {
    pairs.push(['rounds', record.rounds, judge.rounds], ['playoff_repeats', record.playoff_repeats, judge.playoff_repeats], ['invalid_share_max', record.invalid_share_max, judge.invalid_share_max]);
    if (judge.playoff_places !== undefined) pairs.push(['playoff_places', record.playoff_places, judge.playoff_places]);
  }
  const differs = pairs.filter(([, a, b]) => a !== b).map(([k]) => k);
  if (differs.length > 0) throw new RegradeError(`${what} judged its field under another judge heat than the harness's (${differs.join(', ')} differ): it is no heat of these rules`);
  if (record.phase_seed !== run.seed) throw new RegradeError(`${what} drew its schedule from phase seed ${record.phase_seed}, and run ${run.id} was graded under seed ${run.seed}: it is no heat of this run's phase`);
  if (record.format === JUDGE_HEAT_FORMAT_V3) holdJudgeLadderRecord(record, what, judge, ladder);
  else if (judgeHeatScreenedFormat(record.format)) {
    // A screened final's record exactly in the format the bundle's judge writes: v5 is v4's screened final plus the
    // panel, v6 v5's with every Swiss and race game dealt over the pool's members.
    holdFinalFormat(record.format, what, judge);
    holdScreenedRecord(record, what, judge, prizes);
    if (judgeHeatPanelFormat(record.format)) holdPanelRecord(record, what, judge, panel);
  } else if (record.stage === 'final' && judge.screened !== undefined) {
    throw new RegradeError(`${what} is a ${record.format} final heat's record, and the harness's judge heat screens its final (harness.judge.screened), whose record is ${judgeHeatFinalFormatOf(judge)}: it is no heat of these rules`);
  }
}

/**
 * A screened final's record format (v4, v5 or v6) held to the one the bundle's judge writes (judge-heat.ts
 * judgeHeatFinalFormatOf, the one copy of the rule): v4 under `screened` alone, v5 under a `panel` too, v6 under a panel
 * with deal: true. So a bundle that never names deal (every v5 kit's) holds its v5 records as before, and a dealt
 * bundle holds v6 alone. A panel format under a bundle drawing no panel, a v4 under one drawing a panel, a v5 under a
 * dealt panel and a v6 under an undealt one are each a RegradeError naming the bundle's format. A v4, v5 or v6 record
 * under a bundle screening no final but naming a panel is holdScreenedRecord's to refuse.
 */
function holdFinalFormat(format: JudgeHeatScreenedFormatT, what: string, judge: ProgramJudgeT): void {
  const want = judgeHeatFinalFormatOf(judge);
  if (format === want) return;
  const rules = 'it is no heat of these rules';
  if (judgeHeatPanelFormat(format) && judge.panel === undefined) {
    const kind = format === JUDGE_HEAT_FORMAT_V6 ? "a dealt panel final's" : "a panel final's";
    throw new RegradeError(`${what} is ${kind} ${format} record, and the harness's judge heat draws no playoff panel (harness.judge.panel): ${rules} (its final's record is ${want})`);
  }
  if (judge.screened === undefined) return;
  if (format === JUDGE_HEAT_FORMAT_V4) {
    throw new RegradeError(`${what} is a screened final's ${format} record, and the harness's judge heat draws its playoff panel (harness.judge.panel), whose record is ${want}: ${rules}`);
  }
  if (format === JUDGE_HEAT_FORMAT_V5) {
    throw new RegradeError(`${what} is a panel final's ${format} record, and the harness's judge heat deals its final's Swiss and race games over its playoff pool (harness.judge.panel.deal), whose record is ${want}: ${rules}`);
  }
  throw new RegradeError(`${what} is a dealt panel final's ${format} record, and the harness's judge heat deals no game over its playoff pool (harness.judge.panel names no deal), whose record is ${want}: ${rules}`);
}

/**
 * A screened final's v4 record (or a panel final's v5 or v6 one) held to the bundle's screened block (the header's judge): its
 * screen's z and its race's numbers the block's, and its line M and race tiers the ones `prizes` give
 * (judgeShortlistPlaces over the last paid place; judgeRaceTiers over the placement prizes at the block's race_cap and
 * race_cap_max), as judge-heat.ts judgeHeatSetup wrote them. With no prizes named, M is held to the record's own last
 * tier (the last paid place: the last place whose prize exceeds the next one's), the tiers' shape being the record's to
 * hold (judgeHeatSetupIssues).
 * The screen's members and anchor strengths are the record's own (the dev ratings fixed before its first call); the
 * shortlist, every pairing, epoch and the finalists are re-derived from them as the record is read (parseJudgeHeatRecord).
 * RegradeError when the bundle screens no final or another way.
 */
function holdScreenedRecord(record: JudgeHeatRecordHeadT, what: string, judge: ProgramJudgeT, prizes: RegradeL1Request['judgePrizes']): void {
  const sc = judge.screened;
  if (sc === undefined) throw new RegradeError(`${what} is a screened final's ${record.format} record, and the harness's judge heat screens no final (harness.judge.screened): it is no heat of these rules`);
  const { screen, race } = record;
  if (record.stage !== 'final' || screen === undefined || race === undefined) {
    throw new RegradeError(`${what} is a ${record.stage} heat's ${record.format} record${screen === undefined || race === undefined ? ' naming no screen or race' : ''}: a ${record.format} record is a screened final's`);
  }
  const pairs: [string, unknown, unknown][] = [
    ['screen.z', screen.z, sc.z],
    ['race.z', race.z, sc.z],
    ['race.phi_margin', race.phi_margin, sc.phi_margin],
    ['race.epsilon', race.epsilon, sc.epsilon],
    ['race.race_cap', race.race_cap, sc.race_cap],
    ['race.race_cap_max', race.race_cap_max, sc.race_cap_max],
    ['race.epoch_calls', race.epoch_calls, sc.epoch_calls],
    ['race.top_repeats', race.top_repeats, sc.top_repeats],
  ];
  if (prizes === undefined) pairs.push(['screen.line_places', screen.line_places, judgeShortlistPlaces(sc, race.tiers.at(-1)?.place ?? 0)]);
  else {
    const placement = prizes.filter((p) => p.kind === 'placement' && p.place !== null).map((p) => ({ place: p.place!, amount: p.amount_usd }));
    let tiers: { place: number; cap: number }[];
    try {
      tiers = judgeRaceTiers(placement, sc.race_cap, sc.race_cap_max);
    } catch (err) {
      if (err instanceof RangeError) throw new RegradeError(`${what}: the harness's prizes give a screened final no race tiers: ${err.message}`);
      throw err;
    }
    pairs.push(['screen.line_places', screen.line_places, judgeShortlistPlaces(sc, lastPaidPlace(prizes))], ['race.tiers', canonicalJson(race.tiers), canonicalJson(tiers)]);
  }
  const differs = pairs.filter(([, a, b]) => a !== b).map(([k]) => k);
  if (differs.length > 0) {
    throw new RegradeError(`${what} screened and raced its final under other numbers than the harness's screened block and prizes give (${differs.join(', ')} differ): it is no heat of these rules`);
  }
}

// ---------------------------------------------------------------- a panel final's drawn panel

/**
 * What a regrade holds a panel final's v5 or v6 record's drawn panel to (RegradeL1Request.judgePanel; the header's judge): the
 * bundle's sealed pool file as read from its judge directory (`<judge.dir>/panel.json`: readRegradeJudgePanel), the
 * bundle's final phase's starts_at and, on an escrowed competition, the escrow's committed entries_deadline (the round
 * rule's: grader/worker.ts panelEntriesDeadlineOf, cli/verify-result.ts the escrow account's; absent, no escrow holds
 * it), and the drand test chain a dev-auth grader draws on, named explicitly (grader/worker.ts instanceChainOptions'
 * testChain; absent, quicknet alone); or why the file did not read.
 */
export type RegradeJudgePanel = { pool_bytes: Uint8Array; final_starts_at: Date; entries_deadline?: Date; testChain?: DrandChain } | { refused: string };

/**
 * The pool file a v5 or v6 record is held to, read from the bundle's judge directory `judgeDir` (as the grade materialized
 * it): `<judgeDir>/panel.json`'s bytes, a regular file (never through a link) of at most JUDGE_PANEL_POOL_MAX_BYTES,
 * with the final phase's starts_at, the escrow's entries_deadline and the test chain, if any, beside them. A file that is
 * missing, not a regular file or too large is the refusal holdPanelRecord words; any other I/O fault is thrown, for the
 * job to retry.
 */
export async function readRegradeJudgePanel(judgeDir: string, o: { finalStartsAt: Date; entriesDeadline?: Date; testChain?: DrandChain }): Promise<RegradeJudgePanel> {
  const path = join(judgeDir, JUDGE_PANEL_POOL_FILE);
  let st: Stats;
  try {
    st = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return { refused: `the judge directory holds no ${JUDGE_PANEL_POOL_FILE}` };
    throw err;
  }
  if (!st.isFile()) return { refused: `the judge directory's ${JUDGE_PANEL_POOL_FILE} is not a regular file` };
  if (st.size > JUDGE_PANEL_POOL_MAX_BYTES) return { refused: `the judge directory's ${JUDGE_PANEL_POOL_FILE} is ${st.size} bytes, past the ${JUDGE_PANEL_POOL_MAX_BYTES} a pool file is read to` };
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength > JUDGE_PANEL_POOL_MAX_BYTES) return { refused: `the judge directory's ${JUDGE_PANEL_POOL_FILE} grew past the ${JUDGE_PANEL_POOL_MAX_BYTES} a pool file is read to while it was read` };
  return { pool_bytes: bytes, final_starts_at: o.finalStartsAt, ...(o.entriesDeadline === undefined ? {} : { entries_deadline: o.entriesDeadline }), ...(o.testChain === undefined ? {} : { testChain: o.testChain }) };
}

/** `panel` read once: its value, or the one its function gives on the first call (none when absent). */
function panelReadOnce(panel: RegradeL1Request['judgePanel']): RegradeL1Request['judgePanel'] {
  if (typeof panel !== 'function') return panel;
  let read: RegradeJudgePanel | undefined;
  return () => (read ??= panel());
}

/** The panel read a v5 or v6 record is held to: RegradeError when none was read, or the pool file did not read. */
function panelReadOf(record: JudgeHeatRecordHeadT, what: string, panel: RegradeL1Request['judgePanel']): Exclude<RegradeJudgePanel, { refused: string }> {
  const sealed = record.panel?.pool_sha256 ?? '(none)';
  if (panel === undefined) throw new RegradeError(`${what} drew its playoff panel from the harness's sealed pool ${sealed}, and this regrade read no pool file to hold it to (RegradeL1Request.judgePanel)`);
  const read = typeof panel === 'function' ? panel() : panel;
  if ('refused' in read) throw new RegradeError(`${what} drew its playoff panel from the harness's sealed pool ${sealed}, whose ${JUDGE_PANEL_POOL_FILE} does not read here: ${read.refused}`);
  return read;
}

/**
 * The drand chain a v5 or v6 record's beacon names: quicknet, or the test chain the regrade names explicitly (a dev-auth
 * grader's: RegradeJudgePanel.testChain). RegradeError on any other: a panel is drawn on quicknet.
 */
function panelChainOf(record: JudgeHeatRecordHeadT, what: string, read: Exclude<RegradeJudgePanel, { refused: string }>): DrandChain {
  const hash = record.panel!.beacon.chain;
  if (hash === DRAND_QUICKNET.hash) return DRAND_QUICKNET;
  if (read.testChain !== undefined && hash === read.testChain.hash) return read.testChain;
  throw new RegradeError(
    `${what} drew its playoff panel on drand chain ${hash}, which is not quicknet (${DRAND_QUICKNET.hash})${read.testChain === undefined ? '' : ` nor this grader's test chain (${read.testChain.hash})`}: a panel is drawn on quicknet`,
  );
}

/**
 * A panel final's v5 or v6 record's drawn panel held to the bundle (the header's judge): its pool_sha256 the judge block's
 * (harness.judge.panel); the pool file as the regrade read it (`panel`, read only now) its own canonical JSON
 * (server/judging/panel.ts judgePanelPoolRead), hashing to that sha256, and the record's pool exactly it; its beacon's
 * chain quicknet or the regrade's named test chain (panelChainOf); and its round the round rule's for the bundle's final
 * starts_at and the escrow's entries_deadline when the read names one (judgePanelRound: the first round emitted at or
 * after the starts_at + DRAW_MARGIN_SECONDS and more than DRAW_MARGIN_SECONDS after the entries_deadline; a record drawn
 * on an earlier round, entries still open when its signature was public, is refused as any other). The draw, the order and the
 * seated judges (a v6 record's every pool member, at weight 1) were held as the record was read (judge-heat.ts
 * judgeHeatSetupIssues); the beacon's signature is holdPanelBeacon's. RegradeError when any does not hold. `judge` names a panel (holdJudgeHeatRecord checked).
 */
function holdPanelRecord(record: JudgeHeatRecordHeadT, what: string, judge: ProgramJudgeT, panel: RegradeL1Request['judgePanel']): void {
  const block = judge.panel!;
  const p = record.panel;
  if (p === undefined) throw new RegradeError(`${what} is a ${record.format} record naming no playoff panel: a ${record.format} record names the panel its playoff drew`);
  if (p.pool_sha256 !== block.pool_sha256) {
    throw new RegradeError(`${what} drew its playoff panel from pool ${p.pool_sha256}, and the harness's judge heat seals pool ${block.pool_sha256} (harness.judge.panel.pool_sha256): it is no heat of these rules`);
  }
  const read = panelReadOf(record, what, panel);
  let pool: ReturnType<typeof judgePanelPoolRead>;
  try {
    pool = judgePanelPoolRead(read.pool_bytes);
  } catch (err) {
    if (err instanceof JudgePanelPoolError) throw new RegradeError(`${what} drew its playoff panel from the harness's sealed pool, and the judge directory's pool file does not read: ${err.message}`);
    throw err;
  }
  const sha = sha256Hex(read.pool_bytes);
  if (sha !== block.pool_sha256) {
    throw new RegradeError(`${what} drew its playoff panel from the harness's sealed pool ${block.pool_sha256}, and the judge directory's ${JUDGE_PANEL_POOL_FILE} hashes to ${sha}: it is not the sealed pool`);
  }
  if (canonicalJson(pool) !== canonicalJson(p.pool)) throw new RegradeError(`${what}'s playoff panel pool is not the judge directory's sealed ${JUDGE_PANEL_POOL_FILE}: it is no heat of these rules`);
  const chain = panelChainOf(record, what, read);
  let want: number;
  try {
    want = judgePanelRound(read.final_starts_at, chain, read.entries_deadline).round;
  } catch (err) {
    if (err instanceof RangeError) throw new RegradeError(`${what}: the final phase's starts_at${read.entries_deadline === undefined ? '' : " and the escrow's entries_deadline"} give no drand round to hold its playoff panel's to: ${err.message}`);
    throw err;
  }
  if (p.beacon.round !== want) {
    const starts = read.final_starts_at.toISOString();
    const escrowed = read.entries_deadline === undefined ? '' : `, and more than ${DRAW_MARGIN_SECONDS} s after the escrow's entries_deadline ${read.entries_deadline.toISOString()}`;
    throw new RegradeError(
      `${what} drew its playoff panel on drand round ${p.beacon.round}, and the round rule gives round ${want} (the first round of chain ${chain.hash} emitted at or after the final phase's starts_at ${starts} + ${DRAW_MARGIN_SECONDS} s${escrowed}): it is no heat of these rules`,
    );
  }
}

/**
 * A v5 or v6 record's beacon held (the header's judge): its signature its chain's signature of its round (the BLS check of
 * server/repos/freshness.ts verifyDrandRound, run off the event loop by server/repos/fetch.ts verifyDrandRoundOffLoop,
 * a round the process verified before answered from its memo), from the record's own bytes: no relay is asked. Run once
 * holdPanelRecord held the record (its chain is one the regrade names). RegradeError when it does not verify; the
 * pool's OffThreadError rejects, for the job to retry.
 */
async function holdPanelBeacon(record: JudgeHeatRecordHeadT, what: string, panel: RegradeL1Request['judgePanel'], signal?: AbortSignal): Promise<void> {
  const read = panelReadOf(record, what, panel);
  const chain = panelChainOf(record, what, read);
  const { round, signature } = record.panel!.beacon;
  if (!(await verifyDrandRoundOffLoop(chain, round, signature, signal === undefined ? {} : { signal }))) {
    throw new RegradeError(`${what} drew its playoff panel on a signature of drand round ${round} that does not verify against chain ${chain.hash}'s key: no round drand emitted drew it`);
  }
}

// ---------------------------------------------------------------- a screened final's contender chain and dev ratings

/** Where a screened final's contender chain is read from (RegradeL1Request.judgeContender). */
export interface RegradeContenderSource {
  blobs: Pick<BlobStore, 'get'>;
  /** `all`: every chain member's ladder record must be in `blobs`; `carried`: each one there is held, one that is not left. */
  ladderRecords: 'all' | 'carried';
}

/**
 * The sealed ladder a contender chain rates by (grader/judge-contender.ts JudgeContenderLadder, as grader/worker.ts
 * judgeContenderLadderOf builds it), from the bundle's ladder as read (readJudgeLadder) and the judge anchors (a final
 * field's anchor members, each a ladder member): its digests, every member's fixed strength and the anchors, each in
 * sha256 order, and phi.
 */
export function judgeContenderLadderFrom(read: Pick<JudgeLadderInputs, 'ladder_sha256' | 'calibration_sha256' | 'strengths' | 'dispersion'>, anchors: readonly string[]): JudgeContenderLadderT {
  return {
    ladder_sha256: read.ladder_sha256,
    calibration_sha256: read.calibration_sha256,
    strengths: read.strengths.map((s) => ({ artifact_sha256: s.artifact_sha256, strength: s.strength })).sort((x, y) => compareCodeUnits(x.artifact_sha256, y.artifact_sha256)),
    anchors: [...new Set(anchors)].sort(compareCodeUnits),
    dispersion: read.dispersion,
  };
}

/** What judgeScreenChainIssues and judgeScreenDevIssues hold a v4, v5 or v6 record's screen to. */
export interface JudgeScreenHoldOptions {
  /** The bundle's judge (its screened block, ladder design, judge directory, media and artifact). */
  judge: ProgramJudgeT;
  /** The bundle's prizes (the chain's line M); absent, M is the record's own screen.line_places (holdScreenedRecord held it). */
  prizes?: readonly Pick<PrizeT, 'kind' | 'place' | 'amount_usd'>[];
  /** The bundle's ladder as read (readJudgeLadder): its digests, every member's fixed strength and phi. */
  ladder: Pick<JudgeLadderInputs, 'ladder_sha256' | 'calibration_sha256' | 'strengths' | 'dispersion'>;
}

/** A contender chain as judgeScreenChainIssues held it. */
export interface JudgeScreenChainT {
  /** The chain folded, every round held (judgeContenderHold); null when a round does not hold. */
  fold: JudgeContenderFoldT | null;
  /** The chain's ratings as the screen reads them (judge-screen-inputs.ts judgeScreenContenderOf); null when it is not this bundle's. */
  held: JudgeScreenContenderT | null;
  /** The final screen's rated members the chain gives a contender sub-rating (step 8's rule, re-derived). */
  flagged: number;
  /** Each member snapshot (a round's `members`, by ladder record and artifact), held to its ladder record, or not at hand. */
  snapshots: { held: number; unheld: number };
  /** What does not hold, each naming where; [] when the chain and the screen's contender ratings hold. */
  issues: string[];
}

/** The final's entrant members and their entries, as judgeScreenInputs takes them, each entry's dev record `devOf`'s. */
function screenEntriesOf(record: JudgeHeatRecordHeadT, devOf: (artifact: string) => JudgeScreenEntryT['dev']): JudgeScreenEntryT[] {
  return record.field.filter((m) => m.entries.length > 0).flatMap((m) => m.entries.map((entry) => ({ entry, artifact_sha256: m.artifact_sha256, dev: devOf(m.artifact_sha256) })));
}

/** The screen's judge options (judge-screen-inputs.ts JudgeScreenInputsOptions) for a v4 record under `o`. */
function screenOptionsOf(record: JudgeHeatRecordHeadT, o: JudgeScreenHoldOptions, sc: NonNullable<ProgramJudgeT['screened']>) {
  return {
    anchors: record.field.filter((m) => m.anchor).map((m) => m.artifact_sha256),
    judge: { judge_sha256: o.judge.judge_sha256, media: o.judge.media, artifact: o.judge.artifact, screened: { z: sc.z, contender_games: sc.contender_games } },
    ladder: { ladder_sha256: o.ladder.ladder_sha256, calibration_sha256: o.ladder.calibration_sha256, rounds: o.judge.ladder?.rounds ?? 0, games: o.judge.ladder?.games ?? 0, strengths: o.ladder.strengths },
  };
}

/**
 * A screened final's contender chain (the header's judge) held, from its rounds at hand (`chain`, round 0 first, each
 * its record and the sha256 its bytes hash to) and its members' ladder records at hand (`ladderRecords`, by sha256: one
 * absent is the caller's to refuse or leave): the record's screen names a chain of `chain.length` rounds whose last is
 * its head; each round of the round it stands at, held against the chain before it and folded in
 * (judge-contender.ts judgeContenderHold: its shape, seed, links, every player's eligibility, schedule, games, totals
 * and invalid share); each member snapshot a round lists, whose ladder record is at hand, that record's
 * (judgeContenderSnapshotOf: its subject and games) on the chain's judge directory, media, artifact and ladder; the
 * chain the bundle's (judgeScreenContenderOf: its judge directory, media and artifact, its ladder judgeContenderLadderFrom
 * of `o.ladder` and the field's anchors, its design judgeContenderDesignOf of the screened block and the prizes); and the
 * screen's contender sub-ratings re-derived by step 8's rule (judgeScreenContenderRatings over the final's entrants with
 * the chain's ratings and the final's Swiss judge(s), judgeScreenJudgesOf of judgeHeatJudgesOf): every rated member whose artifact the chain rates
 * carries exactly that sub-rating (strength, se and the head; no millionths), no other member carries one, and the
 * screen's `contender` block names the chain exactly when some member carries one. A rated member's own numbers are
 * its house-only dev rating (judgeScreenDevIssues'), never the chain's. Pure: never throws for a mismatch.
 */
export function judgeScreenChainIssues(
  record: JudgeHeatRecordHeadT,
  chain: readonly { sha256: string; record: JudgeContenderRecordT }[],
  ladderRecords: ReadonlyMap<string, JudgeHeatRecordT>,
  o: JudgeScreenHoldOptions,
): JudgeScreenChainT {
  const issues: string[] = [];
  const out = (fold: JudgeContenderFoldT | null, held: JudgeScreenContenderT | null, flagged: number, snapshots: JudgeScreenChainT['snapshots']): JudgeScreenChainT => ({ fold, held, flagged, snapshots, issues });
  const named = judgeHeatScreenedFormat(record.format) ? record.screen?.contender : undefined;
  if (named === undefined) return { ...out(null, null, 0, { held: 0, unheld: 0 }), issues: ['the record is no screened final whose screen names a contender chain'] };
  if (chain.length !== named.rounds) {
    issues.push(`the screen names a contender chain of ${named.rounds} round(s) headed by ${named.record_sha256}, and ${chain.length} are at hand`);
    return out(null, null, 0, { held: 0, unheld: 0 });
  }
  chain.forEach((c, k) => {
    if (c.record.round !== k) issues.push(`the chain's round ${k} is record ${c.sha256}, which is round ${c.record.round}'s`);
  });
  if (chain.at(-1)?.sha256 !== named.record_sha256) issues.push(`the chain's last round is record ${chain.at(-1)?.sha256 ?? '(none)'}, and the screen names its head ${named.record_sha256}`);
  if (issues.length > 0) return out(null, null, 0, { held: 0, unheld: 0 });
  // Every round held against the chain before it and folded in, round 0 first.
  let fold: JudgeContenderFoldT | null = null;
  for (const c of chain) {
    try {
      fold = judgeContenderHold(fold, c.record);
    } catch (err) {
      if (!(err instanceof JudgeHeatError) && !(err instanceof RangeError)) throw err;
      issues.push(`the chain's round ${c.record.round} (record ${c.sha256}) does not hold: ${err.message}`);
      return out(null, null, 0, { held: 0, unheld: 0 });
    }
    if (fold.head_sha256 !== c.sha256) issues.push(`the chain's round ${c.record.round} digests to ${fold.head_sha256}, not the ${c.sha256} it is named by`);
  }
  const chainFold = fold!;
  // Each member snapshot a round lists, held to its ladder record where that is at hand.
  const snapshots = { held: 0, unheld: 0 };
  const seen = new Set<string>();
  for (const c of chain) {
    c.record.members.forEach((m, k) => {
      const key = `${m.ladder_record_sha256}\0${m.artifact_sha256}`;
      if (seen.has(key)) return;
      seen.add(key);
      const where = `the chain's round ${c.record.round} members.${k} (${m.artifact_sha256})`;
      const rec = ladderRecords.get(m.ladder_record_sha256);
      if (rec === undefined) {
        snapshots.unheld++;
        return;
      }
      snapshots.held++;
      let snap: ReturnType<typeof judgeContenderSnapshotOf>;
      try {
        snap = judgeContenderSnapshotOf(rec);
      } catch (err) {
        if (!(err instanceof JudgeHeatError)) throw err;
        issues.push(`${where} names ladder record ${m.ladder_record_sha256}, which is no snapshot's: ${err.message}`);
        return;
      }
      const j = chainFold.judge;
      if (rec.judge_sha256 !== j.judge_sha256 || rec.media !== j.media || rec.artifact !== j.artifact) issues.push(`${where} names ladder record ${m.ladder_record_sha256}, judged on another judge directory, media or artifact than the chain's`);
      if (rec.ladder?.ladder_sha256 !== chainFold.ladder.ladder_sha256 || rec.ladder?.calibration_sha256 !== chainFold.ladder.calibration_sha256) issues.push(`${where} names ladder record ${m.ladder_record_sha256}, rated on another ladder than the chain's`);
      if (snap.artifact_sha256 !== m.artifact_sha256) issues.push(`${where} names ladder record ${m.ladder_record_sha256}, whose subject is ${snap.artifact_sha256}`);
      else if (canonicalJson(snap.ladder_games) !== canonicalJson(m.ladder_games)) issues.push(`${where}'s ladder_games are not ladder record ${m.ladder_record_sha256}'s games from its side: ${canonicalJson(snap.ladder_games).slice(0, 300)}`);
      const subject = rec.field.find((f) => f.entries.length > 0);
      if (subject?.artifact_bytes !== undefined && subject.artifact_bytes !== m.artifact_bytes) issues.push(`${where} is ${m.artifact_bytes} bytes, and ladder record ${m.ladder_record_sha256} records ${subject.artifact_bytes}`);
    });
  }
  // The chain the bundle's: its judge, ladder and design.
  const sc = o.judge.screened;
  if (sc === undefined) {
    issues.push("the harness's judge heat screens no final (harness.judge.screened), so no contender chain rates its members");
    return out(chainFold, null, 0, snapshots);
  }
  const design: JudgeContenderDesignT =
    o.prizes === undefined ? { games: sc.contender_games, line_places: record.screen!.line_places, z: sc.z, phi_margin: sc.phi_margin, epsilon: sc.epsilon } : judgeContenderDesignOf(sc, o.prizes);
  const opts = screenOptionsOf(record, o, sc);
  const held = judgeScreenContenderOf(chainFold, { judge: o.judge, ladder: judgeContenderLadderFrom(o.ladder, opts.anchors), design });
  if ('refused' in held) {
    issues.push(`the chain is not this bundle's: ${held.refused}`);
    return out(chainFold, null, 0, snapshots);
  }
  // Step 8's rule over the final's entrants, the final's judges, and the chain's ratings: the sub-rating each artifact takes.
  let expected: ReturnType<typeof judgeScreenContenderRatings>;
  try {
    expected = judgeScreenContenderRatings({ entries: screenEntriesOf(record, () => null), judge: opts.judge, judges: judgeScreenJudgesOf(judgeHeatJudgesOf(record)), contender: held });
  } catch (err) {
    if (!(err instanceof JudgeHeatError) && !(err instanceof RangeError) && !(err instanceof TypeError)) throw err;
    issues.push(`the final's field and the chain make no screen: ${err.message}`);
    return out(chainFold, held, 0, snapshots);
  }
  // A rated member (its house-only rating judgeScreenDevIssues') carries the chain's sub-rating exactly when the chain
  // rates its artifact, byte for byte; an unrated one carries none (the schema has no room for one).
  let flagged = 0;
  record.screen!.members.forEach((m, k) => {
    if (!('rated' in m)) return;
    const got = m.rated.contender;
    const w = expected.rated.get(m.artifact_sha256);
    if (w !== undefined) flagged++;
    if (w === undefined && got !== undefined) issues.push(`screen.members.${k} (${m.artifact_sha256}) carries a contender sub-rating, and the chain rates it none (${expected.off ?? 'it is no chain member with a contender game'})`);
    else if (w !== undefined && got === undefined) issues.push(`screen.members.${k} (${m.artifact_sha256}) is rated and a chain member with a contender game, and the screen does not carry its contender sub-rating ${canonicalJson(w)}`);
    else if (w !== undefined && canonicalJson(got) !== canonicalJson(w)) issues.push(`screen.members.${k} (${m.artifact_sha256})'s contender sub-rating is not the chain's: ${canonicalJson(w)}`);
  });
  const block = flagged > 0 ? { record_sha256: held.head_sha256, rounds: held.rounds } : null;
  if (canonicalJson(record.screen!.contender ?? null) !== canonicalJson(block)) {
    const why = flagged > 0 ? '' : ` (${expected.off ?? 'every final member the chain rates is unrated on its ladder record'})`;
    issues.push(`screen.contender is not what the chain gives: ${canonicalJson(block)}${why}`);
  }
  return out(chainFold, held, flagged, snapshots);
}

/** A screen's dev ratings as judgeScreenDevIssues held them. */
export interface JudgeScreenDevT {
  /** The members the screen rates on a dev ladder record: every rated member (a contender sub-rating is judgeScreenChainIssues'). */
  rated: number;
  /** Those whose record was at hand, each re-derived from it; and those whose record was not. */
  held: number;
  unheld: number;
  /** Each member whose rating its record does not give, naming it; [] when every one held. */
  issues: string[];
}

/**
 * The ratings `record`'s screen reads from blind rounds' heat records at hand (judgeScreenDevIssues' `onRounds`: each a
 * rated member and its rating, the record it names a final-stage v4, v5 or v6 one), each round's re-derived once by
 * judge-screen-inputs.ts judgeScreenInputsFromRound over the members it rates, under the bundle's judge and ladder, and
 * each held to the screen's byte for byte (canonical JSON); every mismatch pushed onto `issues`.
 */
function roundScreenIssues(
  record: JudgeHeatRecordHeadT,
  devRecords: ReadonlyMap<string, JudgeHeatRecordT>,
  o: JudgeScreenHoldOptions,
  onRounds: readonly { k: number; m: { artifact_sha256: string }; rating: Omit<JudgeScreenRatingT, 'contender'> }[],
  issues: string[],
): void {
  const byRound = new Map<string, (typeof onRounds)[number][]>();
  for (const r of onRounds) byRound.set(r.rating.record_sha256, [...(byRound.get(r.rating.record_sha256) ?? []), r]);
  for (const [sha, members] of byRound) {
    const label = `blind round record ${sha}`;
    const artifacts = new Set(members.map((r) => r.m.artifact_sha256));
    let got: ReturnType<typeof judgeScreenInputsFromRound>;
    try {
      got = judgeScreenInputsFromRound({
        entries: screenEntriesOf(record, () => null)
          .filter((e) => artifacts.has(e.artifact_sha256))
          .map((e) => ({ entry: e.entry, artifact_sha256: e.artifact_sha256 })),
        // Only the members are held here: the anchors' strengths are the final setup's own to hold.
        anchors: [],
        judge: o.judge,
        ladder: { strengths: o.ladder.strengths },
        round: { label, record_sha256: sha, record: devRecords.get(sha)! },
      });
    } catch (err) {
      if (!(err instanceof JudgeHeatError) && !(err instanceof RangeError) && !(err instanceof TypeError)) throw err;
      issues.push(`the screen's ${label} makes no screen: ${err.message}`);
      continue;
    }
    const derived = new Map(got.inputs.members.map((m) => [m.artifact_sha256, m]));
    const why = new Map(got.entries.flatMap((e) => ('unrated' in e ? [[e.artifact_sha256, e.why] as const] : [])));
    for (const { k, m, rating } of members) {
      const d = derived.get(m.artifact_sha256);
      if (d === undefined || !('rated' in d)) issues.push(`screen.members.${k} (${m.artifact_sha256}) is rated on ${label}, which rates it none: ${why.get(m.artifact_sha256) ?? 'the screen judges no entry of it'}`);
      else if (canonicalJson(d.rated) !== canonicalJson(rating)) issues.push(`screen.members.${k} (${m.artifact_sha256})'s rating is not what ${label} gives: ${canonicalJson(d.rated)}`);
    }
  }
}

/**
 * A v4, v5 or v6 record's dev ratings (every member its screen rates: each one's house-only rating is a dev ladder record's, a
 * contender sub-rating beside it or not) held to the records at hand (`devRecords`, by sha256; one absent is left,
 * counted unheld): each such member's house-only rating re-derived from its record (judge-screen-inputs.ts
 * judgeScreenInputs with no contender chain, each of its entries on that record, under the bundle's judge directory,
 * media, artifact, ladder and z and the final's Swiss judge(s), judgeScreenJudgesOf of judgeHeatJudgesOf) is the one the screen holds, byte for byte:
 * its record sha256, strength, se and millionths, the numbers a screened-out score carries. Its `contender` sub-rating
 * is judgeScreenChainIssues' to hold. Pure: never throws for a mismatch.
 *
 * A member rated under blind rounds names a blind round's heat record instead (a final-stage v4, v5 or v6 record: the
 * kit carries it under `<base>/dev/` as it carries a dev record): its rating is re-derived from that record by
 * judge-screen-inputs.ts judgeScreenInputsFromRound (fitted on the round's games, or carried from its screen) under the
 * bundle's judge and ladder, and held to the screen's byte for byte as canonical JSON. Every other record (a v3
 * provisional ladder heat's) takes the path above.
 */
export function judgeScreenDevIssues(record: JudgeHeatRecordHeadT, devRecords: ReadonlyMap<string, JudgeHeatRecordT>, o: JudgeScreenHoldOptions): JudgeScreenDevT {
  const issues: string[] = [];
  const screen = judgeHeatScreenedFormat(record.format) ? record.screen : undefined;
  const rated = (screen?.members ?? []).flatMap((m, k) => {
    if (!('rated' in m)) return [];
    const { contender: _sub, ...rating } = m.rated;
    return [{ k, m, rating }];
  });
  const all = rated.filter((r) => devRecords.has(r.rating.record_sha256));
  const result = (): JudgeScreenDevT => ({ rated: rated.length, held: all.length, unheld: rated.length - all.length, issues });
  const sc = o.judge.screened;
  if (all.length === 0 || sc === undefined) return result();
  // A blind round's record (a final heat's, of a screened format) is held as the round rates; every other as a dev record.
  const roundOf = (sha: string): boolean => {
    const r = devRecords.get(sha)!;
    return r.stage === 'final' && judgeHeatScreenedFormat(r.format);
  };
  const onRounds = all.filter((r) => roundOf(r.rating.record_sha256));
  if (onRounds.length > 0) roundScreenIssues(record, devRecords, o, onRounds, issues);
  const at = all.filter((r) => !roundOf(r.rating.record_sha256));
  if (at.length === 0) return result();
  const byArtifact = new Map(at.map((r) => [r.m.artifact_sha256, r.rating.record_sha256]));
  let got: ReturnType<typeof judgeScreenInputs>;
  try {
    const entries = screenEntriesOf(record, (artifact) => {
      const sha = byArtifact.get(artifact);
      return sha === undefined ? null : { record_sha256: sha, record: devRecords.get(sha)! };
    }).filter((e) => byArtifact.has(e.artifact_sha256));
    // The final's Swiss judge(s) alone: a panel final's panel never rates or unrates a dev record (judgeScreenJudgesOf).
    got = judgeScreenInputs({ ...screenOptionsOf(record, o, sc), entries, judges: judgeScreenJudgesOf(judgeHeatJudgesOf(record)) });
  } catch (err) {
    if (!(err instanceof JudgeHeatError) && !(err instanceof RangeError) && !(err instanceof TypeError)) throw err;
    issues.push(`the screen's dev records make no screen: ${err.message}`);
    return result();
  }
  const derived = new Map(got.inputs.members.map((m) => [m.artifact_sha256, m]));
  const why = new Map(got.entries.flatMap((e) => ('unrated' in e ? [[e.artifact_sha256, e.why] as const] : [])));
  for (const { k, m, rating } of at) {
    const d = derived.get(m.artifact_sha256);
    if (d === undefined || !('rated' in d)) issues.push(`screen.members.${k} (${m.artifact_sha256}) is rated on dev record ${rating.record_sha256}, which rates it none: ${why.get(m.artifact_sha256) ?? 'the record judges no entry of it'}`);
    else if (canonicalJson(d.rated) !== canonicalJson(rating)) issues.push(`screen.members.${k} (${m.artifact_sha256})'s dev rating is not what its record ${rating.record_sha256} gives: ${canonicalJson(d.rated)}`);
  }
  return result();
}

/** Each source's chains held (holdContenderChain), by key: so every run of one final reads and holds its chain once. */
const contenderHolds = new WeakMap<object, Map<string, Promise<void>>>();
/** The most chains a source remembers. */
const CONTENDER_HOLDS_KEPT = 8;

/**
 * A screened final's contender chain held (the header's judge) for the v4 record `record` (named `sha256`, its screen
 * naming the chain): its rounds read from `source.blobs`, walking `prev` from the head back to round 0, each blob
 * verified, a contender record that holds on its own (parseJudgeContenderRecord) and kept as its canonical JSON; each
 * member's ladder record read (loadJudgeHeatRecord), every one under `all`, those there under `carried`; then
 * judgeScreenChainIssues against the bundle's judge, prizes and ladder (`ladder`, read only now). A RegradeError when a
 * round is missing, corrupt or does not hold, a ladder record under `all` is missing, the ladder does not read, or the
 * chain or the screen's contender ratings do not hold.
 */
async function holdContenderChain(
  source: RegradeContenderSource,
  record: JudgeHeatRecordHeadT,
  sha256: string,
  judge: ProgramJudgeT,
  ladder: RegradeJudgeLadder | (() => RegradeJudgeLadder) | undefined,
  prizes: RegradeL1Request['judgePrizes'],
): Promise<void> {
  const what = `judge heat record ${sha256}`;
  const named = record.screen!.contender!;
  if (ladder === undefined) throw new RegradeError(`${what}'s screen names contender chain ${named.record_sha256}, rated on the harness's ladder, and this regrade read no ladder to hold it to (RegradeL1Request.judgeLadder)`);
  const read = typeof ladder === 'function' ? ladder() : ladder;
  if ('refused' in read) throw new RegradeError(`${what}'s screen names contender chain ${named.record_sha256}, rated on the harness's ladder, which does not read here: ${read.refused}`);
  const key = canonicalJson({ sha256, ladderRecords: source.ladderRecords, judge, prizes: prizes ?? null, ladder: { ladder_sha256: read.ladder_sha256, calibration_sha256: read.calibration_sha256, strengths: read.strengths, dispersion: read.dispersion } });
  const held = contenderHolds.get(source.blobs) ?? new Map<string, Promise<void>>();
  contenderHolds.set(source.blobs, held);
  const was = held.get(key);
  if (was !== undefined) return was;
  const run = (async () => {
    const chain: { sha256: string; record: JudgeContenderRecordT }[] = [];
    let at: string | null = named.record_sha256;
    for (let round = named.rounds - 1; round >= 0; round--) {
      const where = `${what}'s contender chain ${named.record_sha256}: round ${round}'s record`;
      if (at === null) throw new RegradeError(`${where} follows no record: the chain holds ${named.rounds - 1 - round} round(s), and the screen names ${named.rounds}`);
      const sha: string = at;
      const bytes = await source.blobs.get(sha, { verify: true }).catch((err: unknown) => {
        throw new RegradeError(`${where} ${sha} is corrupt: ${(err as Error).message}`);
      });
      if (bytes === null) throw new RegradeError(`${where} ${sha} is missing from the blob store`);
      if (sha256Hex(bytes) !== sha) throw new RegradeError(`${where} ${sha} is corrupt: its bytes hash to ${sha256Hex(bytes)}`);
      let c: JudgeContenderRecordT;
      try {
        c = parseJudgeContenderRecord(bytes);
      } catch (err) {
        if (err instanceof JudgeHeatError) throw new RegradeError(`${where} ${sha} is refused: ${err.message}`);
        throw err;
      }
      if (judgeContenderRecordDigest(c).json !== Buffer.from(bytes).toString('utf8')) throw new RegradeError(`${where} ${sha} is not kept as its canonical JSON (grader/judge-contender.ts judgeContenderRecordDigest)`);
      chain.push({ sha256: sha, record: c });
      at = c.prev;
    }
    if (at !== null) throw new RegradeError(`${what}'s contender chain ${named.record_sha256}: its round 0 follows record ${at}, and the screen names ${named.rounds} round(s)`);
    chain.reverse();
    const ladderRecords = new Map<string, JudgeHeatRecordT>();
    for (const sha of [...new Set(chain.flatMap((c) => c.record.members.map((m) => m.ladder_record_sha256)))].sort(compareCodeUnits)) {
      if (source.ladderRecords === 'carried') {
        const there = await source.blobs.get(sha).catch(() => null);
        if (there === null) continue;
      }
      ladderRecords.set(sha, await loadJudgeHeatRecord(source.blobs, sha));
    }
    const checked = judgeScreenChainIssues(record, chain, ladderRecords, { judge, ...(prizes === undefined ? {} : { prizes }), ladder: read });
    if (checked.issues.length > 0) {
      throw new RegradeError(`${what}'s screen names contender chain ${named.record_sha256}, which does not hold or does not give its contender ratings: ${checked.issues.slice(0, 3).join('; ')}${checked.issues.length > 3 ? `; and ${checked.issues.length - 3} more` : ''}`);
    }
  })();
  held.set(key, run);
  if (held.size > CONTENDER_HOLDS_KEPT) held.delete(held.keys().next().value!);
  // A refusal is said again on each read (a store mended since may hold): only a chain that held is remembered.
  run.catch(() => held.delete(key));
  return run;
}

/**
 * The ladder a regrade holds a v3 provisional record to (RegradeL1Request.judgeLadder): the bundle's sealed ladder as
 * grader/judge-ladder-tree.ts readJudgeLadder read it (its digest, its calibration record's sha256, every member's fixed
 * strength and the dispersion), or why it refused.
 */
export type RegradeJudgeLadder = Pick<JudgeLadderInputs, 'ladder_sha256' | 'calibration_sha256' | 'strengths' | 'dispersion'> | { refused: string };

/**
 * A v3 judge heat record held to the bundle's ladder (the header's judge): a dev entry's provisional heat on the ladder
 * the harness seals (`judge.ladder`), never a calibration's record. Its `ladder` block is the one the heat's setup takes
 * from what readJudgeLadder read of that ladder (judge-ladder-tree.ts judgeLadderBlock, the entry's member's own
 * strength left out): the same ladder and calibration digests, the same fixed strengths and dispersion, the bundle's
 * games and spread, and at most the bundle's rounds (a budget-short day plays fewer whole rounds: grader/worker.ts);
 * its money-place scrutiny, when it records one, the bundle's screened.dev_rounds rounds (its line, the board's when the
 * heat set up, is the record's own).
 * The record's verdict is then a function of its calls and these numbers alone (judge-heat.ts ladderScoresOf), so it is
 * rebuilt with no model called. `ladder` is read only once the record names the bundle's ladder. RegradeError when the
 * record rates its entry against another ladder, or the ladder is not there to hold it to.
 */
function holdJudgeLadderRecord(record: JudgeHeatRecordHeadT, what: string, judge: ProgramJudgeT, ladder: RegradeJudgeLadder | (() => RegradeJudgeLadder) | undefined): void {
  if (record.stage !== 'provisional') throw new RegradeError(`${what} is a ${record.stage} heat's ${JUDGE_HEAT_FORMAT_V3} record: a run's judge heat is a final heat or a dev entry's provisional one, never a ladder's calibration`);
  const block = record.ladder;
  if (block === undefined) throw new RegradeError(`${what} is a ${JUDGE_HEAT_FORMAT_V3} provisional heat's record that names no ladder: a heat on a ladder names the ladder it rates by`);
  const sealed = judge.ladder;
  if (sealed === undefined) {
    throw new RegradeError(`${what} rated its entry on ladder ${block.ladder_sha256}, and the harness's judge heat names no ladder (harness.judge.ladder): it is no heat of these rules`);
  }
  if (block.ladder_sha256 !== sealed.ladder_sha256) {
    throw new RegradeError(`${what} rated its entry on ladder ${block.ladder_sha256}, and the harness seals ladder ${sealed.ladder_sha256}: it is no heat of these rules`);
  }
  if (block.rounds > sealed.rounds) {
    throw new RegradeError(`${what} played ${block.rounds} adaptive rounds, and the harness's ladder plays at most ${sealed.rounds}: it is no heat of these rules`);
  }
  // Money-place scrutiny (judge-heat.ts JudgeHeatLadderScrutiny): a screened bundle's dev heats play screened.dev_rounds
  // more rounds past the line, and a bundle with none (dev_rounds 0, or no screened block) records none.
  if (block.scrutiny !== undefined && judge.screened?.dev_rounds !== block.scrutiny.rounds) {
    const plays = judge.screened === undefined ? 'screens no final (harness.judge.screened), so its dev heats play none' : `plays ${judge.screened.dev_rounds} (harness.judge.screened.dev_rounds)`;
    throw new RegradeError(`${what} played ${block.scrutiny.rounds} money-place scrutiny round(s) past its line, and the harness's judge heat ${plays}: it is no heat of these rules`);
  }
  if (ladder === undefined) throw new RegradeError(`${what} rated its entry on the harness's ladder ${sealed.ladder_sha256}, and this regrade read no ladder to hold it to (RegradeL1Request.judgeLadder)`);
  const read = typeof ladder === 'function' ? ladder() : ladder;
  if ('refused' in read) throw new RegradeError(`${what} rated its entry on the harness's ladder ${sealed.ladder_sha256}, which does not read here: ${read.refused}`);
  if (read.ladder_sha256 !== sealed.ladder_sha256) {
    throw new RegradeError(`${what} rated its entry on the harness's ladder ${sealed.ladder_sha256}, and the ladder read for this regrade is ${read.ladder_sha256}: it is held to the harness's alone`);
  }
  // The entry's member: the one member of a ladder heat's field that holds an entry (judge-heat.ts setupIssuesOf).
  const subject = record.field.find((m) => m.entries.length > 0);
  if (subject === undefined) throw new RegradeError(`${what} is a ladder heat's record whose field holds no entry: it rates no run`);
  let want: JudgeHeatLadderT;
  try {
    want = judgeLadderBlock(read, { rounds: block.rounds, games: sealed.games, spread: sealed.spread }, subject.artifact_sha256);
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) throw new RegradeError(`${what}: the harness's ladder design is no heat's: ${err.message}`);
    throw err;
  }
  const keys = ['ladder_sha256', 'calibration_sha256', 'strengths', 'dispersion', 'games', 'spread'] as const;
  const differs = keys.filter((k) => canonicalJson(block[k]) !== canonicalJson(want[k]));
  if (differs.length > 0) {
    throw new RegradeError(`${what} rated its entry against another ladder than the harness's (${differs.join(', ')} differ from what its ladder ${sealed.ladder_sha256} reads as): it is no heat of these rules`);
  }
}

/** What rescore builds a program/v1 score's performance with (judgeVerdictOf): the judge verdict, and the judge heat record it came from. */
interface JudgeVerdict {
  verdict?: ProgramJudgeScoreT;
  /** The judge heat record read (StoredRun.judge_heat_sha256); null when none was. */
  heat: string | null;
}

/** The outcome's link to the judge heat record a regrade read (RegradeOutcome.judge_heat_sha256), when it read one. */
function judgeHeatOf(j: JudgeVerdict): { judge_heat_sha256?: string } {
  return j.heat === null ? {} : { judge_heat_sha256: j.heat };
}

/** The judge verdict a stored score carries (performance.judge), or undefined under none. */
function storedJudgeOf(result: unknown): ProgramJudgeScoreT | undefined {
  const parsed = Score.safeParse(result);
  return parsed.success && parsed.data.performance.kind === 'program/v1' ? parsed.data.performance.judge : undefined;
}

/**
 * The judge verdict a run is re-scored with (the header's judge): from the judge heat record it names, held to it
 * (loadJudgeHeatRecord, judgeRecordVerdictOf), the run's artifact read from its action log (program.ts
 * readOutputFile); none from a final heat's record that left the run out (judgeRecordNamesRun: no member of its field
 * holds the run's entry, and the stored score carries no verdict) for the reason the heat has (judgeLeftOutWhy: no
 * artifact, or one the judge cannot read); else a provisional verdict its stored score carries, carried over; else
 * none. A record that does not hold or does not judge the run, a run it left out whose artifact the judge reads, and
 * a final verdict its stored score carries with no record named, are a RegradeError: a final verdict is rebuilt from
 * its record or not at all, and nothing here calls a model.
 */
async function judgeVerdictOf(req: RegradeL1Request): Promise<JudgeVerdict> {
  const { stored } = req;
  const link = stored.judge_heat_sha256 ?? null;
  if (link === null) {
    const carried = storedJudgeOf(stored.result);
    if (carried === undefined) return { heat: null };
    if (carried.provisional) return { verdict: carried, heat: null };
    throw new RegradeError(
      `run ${stored.id}'s stored score carries a final judge verdict, and the run names no judge heat record (judge_heat_sha256): a final verdict is rebuilt from its record, never judged again`,
    );
  }
  // Read back once a process (loadHeldJudgeHeatRecord): a final's every run regraded holds the one record to itself.
  const held = await loadHeldJudgeHeatRecord(req.blobs, link);
  const record = held.record;
  if (req.judge === undefined) throw new RegradeError(`run ${stored.id} names judge heat record ${link}, but its harness names no judge heat: a judge heat's verdict is a judged score's alone`);
  let art: Awaited<ReturnType<typeof readOutputFile>>;
  try {
    art = await readOutputFile(req.blobs, stored.action_log_sha256!, req.judge.artifact);
  } catch (err) {
    throw new RegradeError(`run ${stored.id}'s outputs do not read: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A run the final heat left out (worker.ts judgeHeatInputs: no artifact, or one the judge cannot read): linked to the
  // record, named nowhere in its field, its score with no verdict, and only for that reason. One whose stored score
  // carries a verdict is held to the record below, which refuses it.
  const named = { id: stored.id, seed: stored.seed!, artifact_sha256: art?.sha256 ?? null, ...(stored.submission_id === undefined ? {} : { submission_id: stored.submission_id }) };
  // A screened final whose screen names the sealed dev contender chain: the chain read and held, and the screen's
  // contender ratings re-derived from it (holdContenderChain), once the record is held to the bundle's judge.
  const chained = judgeHeatScreenedFormat(record.format) && record.screen?.contender !== undefined;
  const judge = req.judge;
  // A panel final's pool file, read once however many holds read it (holdPanelRecord, holdPanelBeacon).
  const panel = panelReadOnce(req.judgePanel);
  // Once the record is held: a panel final's beacon signature checked off the event loop (holdPanelBeacon), then the chain.
  const holdChain = async (): Promise<void> => {
    if (judgeHeatPanelFormat(record.format)) await holdPanelBeacon(record, `judge heat record ${link}`, panel, req.signal);
    if (chained) await holdContenderChain(req.judgeContender ?? { blobs: req.blobs, ladderRecords: 'all' }, record, link, judge, req.judgeLadder, req.judgePrizes);
  };
  // A run a capped final's contender cap cut (worker.ts judgeContenderCut; contracts/competition.ts ProgramJudge.contenders):
  // linked to the record, named nowhere in its field, its stored score its kept dev rating screened out
  // (judge-cut.ts judgeContenderCutScore), held to the cut the heat stored (RegradeL1Request.judgeCut): the entry is one
  // the cut kept out, and the score is the one its kept rating gives on this run's artifact, byte for byte. Nothing here
  // calls a model.
  const storedVerdict = storedJudgeOf(stored.result);
  if (record.stage === 'final' && req.judge.contenders !== undefined && storedVerdict?.screened_out === true && storedVerdict.matches === 0 && !judgeRecordNamesRun(record, link, named, req.judge, req.judgeLadder, req.judgePrizes, panel)) {
    if (req.judgeCut === undefined) throw new RegradeError(`run ${stored.id} carries a capped final's cut score, and the regrade is given no contender cut (phase.cut) to hold it to`);
    if (stored.submission_id === undefined) throw new RegradeError(`run ${stored.id} carries a capped final's cut score, and names no entry for the cut to be read for`);
    if (art === null) throw new RegradeError(`run ${stored.id} carries a capped final's cut score, and its outputs hold no ${req.judge.artifact}, the artifact its score names`);
    const issue = judgeCutScoreIssue(req.judgeCut, stored.submission_id, { sha256: art.sha256, bytes: art.size }, storedVerdict);
    if (issue !== null) throw new RegradeError(`run ${stored.id} names judge heat record ${link}, which leaves it out as cut by its contender cap, and ${issue}`);
    await holdChain();
    return { verdict: storedVerdict, heat: link };
  }
  if (record.stage === 'final' && storedJudgeOf(stored.result) === undefined && !judgeRecordNamesRun(record, link, named, req.judge, req.judgeLadder, req.judgePrizes, panel)) {
    if (judgeLeftOutWhy(record, req.judge.artifact, art) === null) {
      throw new RegradeError(
        `run ${stored.id} names judge heat record ${link}, which leaves it out of its field, and its outputs' ${req.judge.artifact} (${art!.size} bytes, sha256 ${art!.sha256}) is one the judge reads as ${record.media}: the heat had it to judge, so it was wrongly left out`,
      );
    }
    await holdChain();
    return { heat: link };
  }
  if (art === null) throw new RegradeError(`run ${stored.id} names judge heat record ${link}, and its outputs hold no ${req.judge.artifact}: the heat judged no artifact of this run`);
  const run: HeatJudgedRun = { id: stored.id, seed: stored.seed!, artifact_sha256: art.sha256, artifact_bytes: art.size, ...(stored.submission_id === undefined ? {} : { submission_id: stored.submission_id }) };
  const verdict = judgeHeldVerdictOf(held, run, req.judge, req.judgeLadder, req.judgePrizes, panel).verdict;
  await holdChain();
  return { verdict, heat: link };
}

/**
 * Why a final heat (its `record`) could leave a run out (grader/worker.ts judgeHeatInputs): its outputs hold no
 * `artifact` (`art` null), or hold one judge-call refuses in the record's media (judgeUserContent throws
 * JudgeArtifactRefused, as the worker's judgeArtifactRefusal asks it). Null when the judge reads the artifact: no heat
 * leaves that run out.
 */
export function judgeLeftOutWhy(record: Pick<JudgeHeatRecordT, 'media' | 'house_text'>, artifact: string, art: JudgeArtifact | null): string | null {
  if (art === null) return `its outputs name no ${artifact}`;
  try {
    judgeUserContent(record.media, art, art, record.house_text);
  } catch (err) {
    if (err instanceof JudgeArtifactRefused) return `the judge cannot read its ${artifact}: ${err.message}`;
    throw err;
  }
  return null;
}

/**
 * Whether the trace a regrade recomputed (its canonical JSON, null when it made none) is not the one the run stored
 * (its blob's sha256, null when it stored none): compared as canonical JSON, the stored blob decompressed
 * (grader/trace.ts readStoredTrace), never by the blob's hash. A stored blob that is missing, corrupt or no gzip
 * JSON differs; a run that stored none differs from nothing.
 */
async function traceDiffers(blobs: Pick<BlobStore, 'get'>, storedSha256: string | null, json: string | null): Promise<boolean> {
  if (storedSha256 === null) return false;
  if (json === null) return true;
  const stored = await readStoredTrace(blobs, storedSha256);
  return !('json' in stored) || stored.json !== json;
}

/** `flags` with `flag` added once, the list in code-unit order. */
function withFlag(flags: readonly string[], flag: string): string[] {
  return [...new Set([...flags, flag])].sort(compareCodeUnits);
}

export interface RegradeL2Request extends RegradeL1Request {
  runtime: Runtime;
  /** The entry, and (SnapshotSource.secrets) the env-lane entry secrets its run recorded, re-opened: what the re-execution runs with (the header's entry secrets). */
  snapshot: SnapshotSource;
  label?: string;
  /**
   * Why the run's recorded entry secrets cannot be opened again (one of them erased since: replaced, deleted or purged),
   * by NAME and row, never a value: the L2 is refused unexecuted (ENTRY_SECRETS_ERASED), and the run's L1 stands. Absent:
   * the re-execution runs with the snapshot's secrets.
   */
  secretsErased?: string;
  /**
   * Told what the house dossier step did to the re-execution's log (grade.ts GradeRequest.onHouseDossier), on a plan
   * naming a dossier path (HarnessPlan.houseDossier). Default: a line on stdout (grade.ts houseDossierLine).
   */
  onHouseDossier?: (note: string) => void;
  /**
   * Told what the house counts step did to the re-execution's log (grade.ts GradeRequest.onHouseCounts), on a plan
   * naming a counts path (HarnessPlan.houseCounts). Default: a line on stdout.
   */
  onHouseCounts?: (note: string) => void;
}

/**
 * L2: re-execute once in the recorded image, assert the action log hash, then L1; under a harness_version that is not
 * the run's, reproduced only flagged harness_moved and anything else inconclusive (underMovedHarness). With
 * an owner, what a dead attempt of it left under the work root goes first (the header's `owner`). If its signal
 * aborts before it ends (the header's `stopping`), the re-execution or the scorer running is killed and nothing after
 * it starts. It then rejects with the signal's reason, no outcome. A run whose recorded entry secret is erased is
 * refused before anything runs (RegradeL2Request.secretsErased); whatever it throws says none of the snapshot's secrets.
 */
export async function regradeL2(req: RegradeL2Request): Promise<RegradeOutcome> {
  try {
    return await stoppable(req.signal, () => reexecute(req));
  } catch (err) {
    throw redactThrown(err, entrySecretForms(req.snapshot.secrets));
  }
}

/** regradeL2's reap, refusals, re-execution and L1, under the signal's checks there (stoppable). */
async function reexecute(req: RegradeL2Request): Promise<RegradeOutcome> {
  const startedAt = new Date();
  const { stored, plan } = req;
  await reapRegradeScratch(req);
  const out = emptyOutcome('regrade_l2', stored, plan, req.sandbox, startedAt);
  if (stored.action_log_sha256 === null || !RESCORABLE.has(stored.status)) throw new RegradeError(`run ${stored.id} (${stored.status}) has no action log to reproduce`);
  if (req.secretsErased !== undefined) return erasedRefusal(out, req.secretsErased);
  // A harness that is not the run's is remembered, and the L2 goes on as under the run's own (the header's versions).
  const current = harnessVersion();
  const keyed = failKeyMismatch(stored, plan);
  if (keyed !== null) return { ...out, error: keyed, differences: ['fail_key'], finished_at: new Date() };
  const sandboxDigest = req.sandbox.imageDigest(req.runtime);
  if ((stored.image_digest === null) !== (sandboxDigest === null)) {
    return { ...out, error: `the run used image ${stored.image_digest ?? 'none (process driver)'}; this sandbox runs ${sandboxDigest ?? 'no image (process driver)'}`, differences: ['$.image_digest'], finished_at: new Date() };
  }
  const outcome = await executeAndRescore(req, out, startedAt, current);
  return stored.harness_version === current ? outcome : underMovedHarness(outcome, stored, current);
}

/** reexecute past its refusals: the preflight, the one re-execution in the run's recorded image, the action log held to the run's, then L1. */
async function executeAndRescore(req: RegradeL2Request, out: RegradeOutcome, startedAt: Date, current: string): Promise<RegradeOutcome> {
  const { stored, plan } = req;
  await preflight(plan, req.sandbox, req.runtime, stored.image_digest);
  const exec = await executeOnce({
    plan,
    sandbox: req.sandbox,
    runtime: req.runtime,
    snapshot: req.snapshot,
    limits: req.limits,
    workRoot: req.workRoot,
    blobs: req.blobs,
    label: req.label ?? 'regrade',
    imageDigest: stored.image_digest,
    ...(req.owner === undefined ? {} : { owner: req.owner }),
    ...(req.signal === undefined ? {} : { signal: req.signal }),
  });
  const summary: ExecutionSummary = {
    status: exec.status,
    error: exec.error,
    wall_ms: exec.wall_ms,
    flags: exec.flags,
    action_log_sha256: exec.log_sha256,
    exit_code: exec.exit?.code ?? null,
    stderr_bytes: exec.stderr.length,
  };
  const ran = { ...out, exec_count: 1, wall_ms: exec.wall_ms, executions: [summary], stderr: exec.stderr, flags: exec.flags, action_log_sha256: exec.log_sha256 };
  if (exec.status !== 'ok') {
    return { ...ran, status: exec.status === 'timeout' ? 'timeout' : 'failed', error: `the re-execution ${exec.status === 'timeout' ? 'timed out' : `failed: ${exec.error}`}`, finished_at: new Date() };
  }
  // The house dossier (the header's L2): the log the run recorded has the house's dossier at the plan's path, so the
  // re-execution's takes the same step from the entry's record (the caller's, else the stored run's, else none) before
  // the comparison. A plan naming no dossier compares the re-execution's log as it ran.
  const record = (req.entry.entry_link ?? stored.entry_link ?? null) as EntryFacts['entry_link'];
  const dossier = await houseDossierLogOf(
    {
      plan,
      entry: { entry_link: record },
      blobs: req.blobs,
      ...(req.onHouseDossier === undefined ? {} : { onHouseDossier: req.onHouseDossier }),
    },
    exec,
    req.label ?? 'regrade',
  );
  // The house counts (the header's L2): the reading of the run's own phase, from the same record, refused where the
  // caller says the entry's entry_link check refused its link (EntryFacts.entry_link_refused: a record a re-check
  // rebuilt, or one written before the deadline write's stamp, carries no `refused` of its own).
  const graded = await houseCountsLogOf(
    {
      plan,
      entry: {
        entry_link: record,
        ...(req.entry.entry_link_reading === undefined ? {} : { entry_link_reading: req.entry.entry_link_reading }),
        ...(req.entry.entry_link_refused === undefined ? {} : { entry_link_refused: req.entry.entry_link_refused }),
      },
      blobs: req.blobs,
      ...(req.onHouseCounts === undefined ? {} : { onHouseCounts: req.onHouseCounts }),
    },
    dossier,
    req.label ?? 'regrade',
  );
  if (graded.sha256 !== stored.action_log_sha256) {
    // A run graded once (the header's once) had no second execution: this one is its first, and it differs.
    const once = stored.flags.includes(EXECUTED_ONCE_FLAG)
      ? `; run ${stored.id} executed its entry once when graded (${EXECUTED_ONCE_FLAG}), and this re-execution is its first second run`
      : '';
    return {
      ...ran,
      action_log_sha256: graded.sha256,
      status: 'nondeterministic',
      error: `the re-execution's action log ${graded.sha256} differs from run ${stored.id}'s ${stored.action_log_sha256}${once}`,
      differences: ['$.action_log_sha256'],
      finished_at: new Date(),
    };
  }
  const l1 = await rescore(req, 'regrade_l2', startedAt);
  return { ...l1, exec_count: 1, wall_ms: exec.wall_ms, executions: [summary], stderr: exec.stderr, harness_version: current };
}

// ---------------------------------------------------------------- practice windows: an eras run, window by window

/**
 * The result of a dev run on practice windows from its windows' own Scores (the header's practice windows): what
 * grader/worker.ts gradeEras records as run.result, and the regrade rebuilds. The first window by key that is not
 * ranked (it did not finish, or its two runs disagreed, or an unmetered cost leaves it unranked) is the run's result
 * as it is: its own Score, which carries its reasons and flags and no eras, and a grade that stopped there has graded
 * no window after it. Otherwise every window is in, and the result is score.ts aggregateEras over them, `hours` long
 * each (null: the run's result names none, which is a TypeError once every window is ranked).
 */
export function erasResult(scores: readonly EraWindowScore[], hours: number | null): ScoreT {
  const unranked = [...scores].sort((a, b) => compareCodeUnits(a.key, b.key)).find((w) => !w.score.eligibility.ranked);
  if (unranked !== undefined) return unranked.score;
  if (hours === null) throw new TypeError('every window is ranked, and the run\'s result names no window length (performance.eras.hours) to aggregate them with');
  return aggregateEras(scores, hours);
}

/** One window of an eras run to regrade: its run_era row as a run of its own, and the plan of its own dataset. */
export interface ErasRegradeWindow {
  key: string;
  datasetId: string;
  datasetSha256: string;
  seed: string;
  /** The row as a stored run: its dataset, seed and fail key (a dev phase's public key of the seed), action log, Score and trace. */
  stored: StoredRun;
  /** The window's plan, its dataset loaded when asked: the regrade holds one window's dataset at a time. */
  plan: () => Promise<HarnessPlan>;
}

/** An eras L1's request: regradeL1's, with the run and a window each in place of its one stored run and plan. */
export interface ErasRegradeL1Request extends Omit<RegradeL1Request, 'stored' | 'plan'> {
  /** The eras run: its result is the aggregate the windows' rebuilt Scores must make. */
  stored: StoredRun;
  /** The run's windows, in key order. */
  windows: readonly ErasRegradeWindow[];
}

export interface ErasRegradeL2Request extends ErasRegradeL1Request {
  runtime: Runtime;
  /** The entry, and the env-lane entry secrets its run recorded, re-opened: what every window's re-execution runs with. */
  snapshot: SnapshotSource;
  label?: string;
  /** As RegradeL2Request.secretsErased: the whole L2 refused unexecuted, no window regraded, and the run's L1 stands. */
  secretsErased?: string;
}

/** One window's regrade (ErasRegradeOutcome.windows). */
export interface ErasWindowRegrade {
  key: string;
  datasetId: string;
  datasetSha256: string;
  seed: string;
  outcome: RegradeOutcome;
}

/**
 * An eras regrade: the run's outcome (the aggregate; grader/record.ts recordRegrade's run row) and every window's
 * (its `run_era` row on that run: eraOfRegrade).
 */
export interface ErasRegradeOutcome {
  outcome: RegradeOutcome;
  windows: ErasWindowRegrade[];
}

/** regradeL1 on a window of `req`: its stored run and plan in place of the run's. */
function windowRequest(req: ErasRegradeL1Request, w: ErasRegradeWindow, plan: HarnessPlan): RegradeL1Request {
  const { stored: _stored, windows: _windows, ...rest } = req;
  return { ...rest, stored: w.stored, plan };
}

/**
 * L1 of an eras run (the header's practice windows): every window re-scored from its stored action log
 * (regradeL1), the run's result rebuilt from their Scores (erasResult) and held to run.result byte for byte. A
 * RegradeError when the run has no scored result or no window to rebuild it from. If its signal aborts (the
 * header's `stopping`), it rejects with the signal's reason, no outcome.
 */
export async function regradeErasL1(req: ErasRegradeL1Request): Promise<ErasRegradeOutcome> {
  return regradeWindows(req, 'regrade_l1', (w, plan) => regradeL1(windowRequest(req, w, plan), 'regrade_l1'));
}

/**
 * L2 of an eras run: every window re-executed once and asserted against its own stored action log, then L1's rebuild
 * (regradeL2 on each window, regradeErasL1's comparison after). Under a harness_version that is not the run's, a window
 * re-executed so carries harness_moved (underMovedHarness), and so does the run: reproduced, or `failed` at
 * `$.harness.version` first, inconclusive.
 */
export async function regradeErasL2(req: ErasRegradeL2Request): Promise<ErasRegradeOutcome> {
  const { runtime, snapshot, label, secretsErased, ...l1 } = req;
  if (secretsErased !== undefined) {
    // Refused before any window runs (the header's entry secrets): one refusal for the run, and no window row.
    req.signal?.throwIfAborted();
    const { stored } = req;
    if (!RESCORABLE.has(stored.status) || stored.result === null || stored.result === undefined) {
      throw new RegradeError(`run ${stored.id} (${stored.status}) has no scored result to rebuild from its windows`);
    }
    if (req.windows.length === 0) throw new RegradeError(`run ${stored.id} graded no practice window`);
    const plan = await req.windows[0]!.plan();
    return { outcome: erasedRefusal(emptyOutcome('regrade_l2', stored, plan, req.sandbox, new Date()), secretsErased), windows: [] };
  }
  return regradeWindows(l1, 'regrade_l2', (w, plan) => regradeL2({ ...windowRequest(l1, w, plan), runtime, snapshot, label: `${label ?? 'regrade'}-${w.key}` }));
}

/** The window length an eras run's result names (performance.eras.hours), null for a result with no eras (a run that stopped at an unranked window). */
function erasHoursOf(result: unknown): number | null {
  const hours = (result as { performance?: { eras?: { hours?: unknown } } } | null)?.performance?.eras?.hours;
  return typeof hours === 'number' ? hours : null;
}

/** Regrade each window of `req` by `regrade`, one after another, then compare the result they make with the run's. */
async function regradeWindows(req: ErasRegradeL1Request, kind: RegradeOutcome['kind'], regrade: (w: ErasRegradeWindow, plan: HarnessPlan) => Promise<RegradeOutcome>): Promise<ErasRegradeOutcome> {
  const { stored } = req;
  const startedAt = new Date();
  if (!RESCORABLE.has(stored.status) || stored.result === null || stored.result === undefined) {
    throw new RegradeError(`run ${stored.id} (${stored.status}) has no scored result to rebuild from its windows`);
  }
  if (req.windows.length === 0) throw new RegradeError(`run ${stored.id} graded no practice window`);
  const windows: ErasWindowRegrade[] = [];
  for (const w of req.windows) {
    req.signal?.throwIfAborted();
    windows.push({ key: w.key, datasetId: w.datasetId, datasetSha256: w.datasetSha256, seed: w.seed, outcome: await regrade(w, await w.plan()) });
  }

  const outcomes = windows.map((w) => w.outcome);
  const storedJson = canonicalJson(stored.result);
  const scores = windows.flatMap((w) => (w.outcome.result === null ? [] : [{ key: w.key, score: w.outcome.result }]));
  let rebuilt: ScoreT | null = null;
  let refused: string | null = null;
  if (stored.result_sha256 !== sha256Hex(storedJson)) {
    refused = `run ${stored.id}'s stored result no longer hashes to its result_sha256`;
  } else if (scores.length === windows.length) {
    try {
      rebuilt = erasResult(scores, erasHoursOf(stored.result));
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      refused = `run ${stored.id}'s windows do not make a result: ${err.message}`;
    }
  }
  const bad = windows.find((w) => w.outcome.status !== 'finished');
  const digest = rebuilt === null ? null : scoreDigest(rebuilt);
  const aggregateDiffers = digest !== null && digest.json !== storedJson;
  const differences = [...windows.flatMap((w) => w.outcome.differences.map((d) => `${w.key}:${d}`)), ...(aggregateDiffers ? jsonDifferences(stored.result, rebuilt) : [])];
  const reproduced = refused === null && bad === undefined && digest !== null && !aggregateDiffers;

  // The window the run's digests are: the median's (the rebuilt result's rank window, or the unranked window it is the Score of), else the window that did not finish.
  const eras = rebuilt === null || rebuilt.performance.kind !== 'pumpfun-replay/v2' ? undefined : rebuilt.performance.eras;
  const rankKey = eras?.rank_window ?? scores.find((w) => w.score === rebuilt)?.key;
  const rank = windows.find((w) => w.key === rankKey) ?? bad ?? windows[0]!;
  // The windows that reproduced with the platform scorer moved alone (the header's versions): the run's too, once it reproduced.
  const moved = windows.filter((w) => w.outcome.flags.includes(SCORER_MOVED_FLAG));
  // The windows an L2 re-executed under a harness that is not the run's (the header's versions: underMovedHarness).
  const harnessMoved = windows.filter((w) => w.outcome.flags.includes(HARNESS_MOVED_FLAG));
  let error: string | null = null;
  if (!reproduced) {
    if (refused !== null) error = refused;
    else if (bad !== undefined) error = `window ${bad.key}: ${bad.outcome.error ?? `regraded ${bad.outcome.status}`}`;
    else error = `the result rebuilt from the windows differs from run ${stored.id}'s at ${differences.join(', ')}`;
    if (harnessMoved.length > 0) {
      error = `${harnessDiffers(stored, harnessVersion())}; the re-execution of its windows under this harness did not reproduce the run (${error}), which proves nothing about the entry`;
    }
  } else if (harnessMoved.length > 0) {
    error = `${HARNESS_MOVED_FLAG}: run ${stored.id}'s window${harnessMoved.length === 1 ? '' : 's'} ${harnessMoved.map((w) => w.key).join(', ')} reproduced with the harness moved; window ${harnessMoved[0]!.key}: ${harnessMoved[0]!.outcome.error ?? ''}`;
  } else if (moved.length > 0) {
    error = `${SCORER_MOVED_FLAG}: run ${stored.id}'s window${moved.length === 1 ? '' : 's'} ${moved.map((w) => w.key).join(', ')} reproduced with the platform scorer moved; window ${moved[0]!.key}: ${moved[0]!.outcome.error ?? ''}`;
  }
  // The run carries scorer_moved exactly when it reproduced with a window so (never from the rank window's flags alone);
  // harness_moved exactly when a window carries it, reproduced or not: then nothing it did not reproduce is held against the entry.
  const traced = outcomes.some((o) => o.flags.includes(TRACE_DIFFERS_FLAG)) ? withFlag(rank.outcome.flags, TRACE_DIFFERS_FLAG) : rank.outcome.flags;
  const unmoved = traced.filter((f) => f !== SCORER_MOVED_FLAG && f !== HARNESS_MOVED_FLAG);
  const scorerFlagged = reproduced && moved.length > 0 ? withFlag(unmoved, SCORER_MOVED_FLAG) : unmoved;
  const flags = harnessMoved.length > 0 ? withFlag(scorerFlagged, HARNESS_MOVED_FLAG) : scorerFlagged;
  const outcome: RegradeOutcome = {
    ...rank.outcome,
    kind,
    reproduces_run_id: stored.id,
    status: reproduced ? 'finished' : harnessMoved.length > 0 ? 'failed' : (bad?.outcome.status ?? 'failed'),
    reproduced,
    error,
    differences: !reproduced && harnessMoved.length > 0 ? ['$.harness.version', ...differences.filter((d) => d !== '$.harness.version')] : differences,
    result: rebuilt,
    result_sha256: digest?.sha256 ?? null,
    flags,
    exec_count: outcomes.reduce((n, o) => n + o.exec_count, 0),
    wall_ms: outcomes.reduce((n, o) => n + o.wall_ms, 0),
    executions: outcomes.flatMap((o) => o.executions),
    started_at: startedAt,
    finished_at: new Date(),
  };
  return { outcome, windows };
}

// ---------------------------------------------------------------- scrape/v1: L1 from the record

/** Why a scrape/v1 run has no L2 (the header): grader/worker.ts refuses an L2 regrade job of one with it. */
export const SCRAPE_L2_REFUSAL = 'a scrape/v1 measurement cannot be re-run; L1 re-scores the record';

/** The format of a scrape/v1 heat's log (record.ts recordScrapeRuns): what a scrape run's stderr_sha256 names. */
export const SCRAPE_HEAT_LOG_FORMAT = 'agent-fun/scrape-heat-log/v1';

/** A heat's log as an L1 regrade reads it back (grader/worker.ts scrapeHeatLog writes the whole of it; the rest is for people). */
export const ScrapeHeatLog = z.object({
  format: z.literal(SCRAPE_HEAT_LOG_FORMAT),
  /** The heat record's canonical sha256: every run of the heat's dataset_sha256. */
  heat_sha256: Sha256Hex,
  heat: ScrapeHeatId,
  /** practice (a dev phase's heat of one entry beside the house baseline) or final (the final phase's one heat). */
  purpose: z.enum(['practice', 'final']),
  /** The heat's reference read: its cassette (what every trial was judged against at /reference/heat/), its scores.json, and its tries. */
  reference: z.object({ cassette_sha256: Sha256Hex, scores_sha256: Sha256Hex, attempts: z.int().min(1) }),
});
export type ScrapeHeatLogT = z.infer<typeof ScrapeHeatLog>;

/** A scrape/v1 L1's request: no signal, regradeScrapeL1 judging every listed trial to its end (the header's `stopping`). */
export interface ScrapeRegradeL1Request extends Omit<RegradeL1Request, 'signal'> {
  /** The entry the run is (its submission id): the trials manifest's entrant. */
  entryId: string;
  /** The bundle's sealed scorer and the competition directory it sits in. */
  setup: ScrapeScorerSetup;
  /** The bundle's heat.trim: what the performance is held to. */
  trim: number;
  /**
   * grader/scrape/score.ts's judge and performance, as the caller loaded it: regrade.ts never imports that module, which
   * imports grader/scrape/gateway-main.ts, a module that starts itself inside a one-file bundle (the kit's command line
   * bundles this one).
   */
  scoring: Pick<typeof import('./scrape/score.ts'), 'judgeScrapeTrial' | 'scrapeFaultOf' | 'scrapePerformance'>;
}

/** A canonical JSON blob, parsed: a RegradeError naming `what` when it is missing, corrupt, no JSON or not canonical. */
async function canonicalBlob(blobs: Pick<BlobStore, 'get'>, sha256: string, what: string): Promise<unknown> {
  try {
    return await loadActionLog(blobs, sha256);
  } catch (err) {
    if (err instanceof RegradeError) throw new RegradeError(`${what}: ${err.message.replace(/^action log /, '')}`);
    throw err;
  }
}

/**
 * L1 of a scrape/v1 run (see the header): its heat record and heat log read back, every listed trial judged again from
 * the blob store, the manifest and the score rebuilt and compared byte for byte with the stored ones. No trial runs
 * again and no upstream is asked. With an owner, what a dead attempt of it left under the work root goes first and the
 * scorer works in a scratch named for it (`score-<owner>-XXXXXX`).
 */
export async function regradeScrapeL1(req: ScrapeRegradeL1Request, kind: RegradeOutcome['kind'] = 'regrade_l1', startedAt = new Date()): Promise<RegradeOutcome> {
  const { stored, plan } = req;
  const out: RegradeOutcome = { ...emptyOutcome(kind, stored, plan, req.sandbox, startedAt), flags: [...stored.flags] };
  const fail = (error: string, differences: string[] = []): RegradeOutcome => ({ ...out, status: 'failed', error, differences, finished_at: new Date() });
  if (plan.kind !== 'scrape/v1') throw new RegradeError(`run ${stored.id}'s plan is ${plan.kind}, not scrape/v1`);
  if (!RESCORABLE.has(stored.status) || stored.result === null || stored.result === undefined || stored.action_log_sha256 === null) {
    throw new RegradeError(`run ${stored.id} (${stored.status}) has no scored trials manifest to re-derive`);
  }
  if (stored.harness_version === null || stored.seed === null) throw new RegradeError(`run ${stored.id} lacks its harness_version or seed`);
  if (stored.dataset_sha256 === null) throw new RegradeError(`run ${stored.id} names no heat record (dataset_sha256)`);
  if (stored.stderr_sha256 === undefined || stored.stderr_sha256 === null) throw new RegradeError(`run ${stored.id} names no heat log (stderr_sha256): the heat's reference read cannot be rebuilt`);
  const storedJson = canonicalJson(stored.result);
  if (stored.result_sha256 !== sha256Hex(storedJson)) return fail(`run ${stored.id}'s stored result no longer hashes to its result_sha256`);
  if (stored.dataset_sha256 !== plan.datasetSha256) {
    return fail(`dataset_sha256 differs: the run ran in heat ${stored.dataset_sha256}, the plan holds ${plan.datasetSha256}`, ['$.dataset_sha256']);
  }
  await reapRegradeScratch(req);

  const { heat } = await scrapeHeatRecordsOf({ ...stored, dataset_sha256: stored.dataset_sha256, stderr_sha256: stored.stderr_sha256 }, req.blobs, ScrapeHeatLog);

  const manifestParsed = ScrapeTrials.safeParse(await loadActionLog(req.blobs, stored.action_log_sha256));
  if (!manifestParsed.success) return fail(`run ${stored.id}'s action log is not a scrape trials manifest: ${manifestParsed.error.issues[0]!.message}`, ['$.action_log_sha256']);
  const manifest = manifestParsed.data;
  if (manifest.entry !== req.entryId) return fail(`run ${stored.id}'s trials manifest is entry ${manifest.entry}'s, not ${req.entryId}'s`, ['$.action_log_sha256']);
  const issues = scrapeTrialsHeatIssues(heat, manifest);
  if (issues.length > 0) return fail(`run ${stored.id}'s trials manifest disagrees with its heat record: ${issues.join('; ')}`, ['$.action_log_sha256']);

  const { judgeScrapeTrial, scrapeFaultOf, scrapePerformance } = req.scoring;
  const { ScorerError } = await import('./program-scores.ts');
  const scoring = await scoringScratch(req);
  const rebuilt: typeof manifest.trials = [];
  const differences: string[] = [];
  try {
    for (const [i, t] of manifest.trials.entries()) {
      const at = `$.trials[${i}]`;
      const trial = { round: t.round, stage: t.stage, position: t.position, wall_ns: t.wall_ns, exit: t.exit, outputs: t.outputs, cassette_sha256: t.cassette_sha256, fault: scrapeFaultOf(t.status) };
      const judgeAgainst = (reference: string) => judgeScrapeTrial({ sandbox: req.sandbox, setup: req.setup, trial, heatReferenceSha256: reference, blobs: req.blobs, limits: req.limits, workDir: scoring });
      let record: ScrapeTrialRecordT;
      try {
        record = (await judgeAgainst(heat.reference_cassette_sha256)).record;
        // A listed void (a re-judging's): incorrect against the heat's reference read again, it is judged again against its
        // own cassette as the re-judging judged it, and correct there it is the void again, both scores.json as recorded.
        if (t.status === SCRAPE_VOID_STATUS && record.status === 'incorrect') {
          const own = (await judgeAgainst(t.cassette_sha256)).record;
          if (own.status === 'correct') record = scrapeVoidRecord(record, own);
        }
      } catch (err) {
        if (err instanceof ScorerError) return fail(`${t.stage} round ${t.round} cannot be judged again: ${err.message}`, [at]);
        throw err;
      }
      if (canonicalJson(record) !== canonicalJson(t)) differences.push(...jsonDifferences(t, record, 20, at));
      rebuilt.push(record);
    }
  } finally {
    await removeScratch(req.sandbox, scoring);
  }
  if (differences.length > 0) return fail(`the trials judge otherwise than run ${stored.id}'s manifest at ${differences.join(', ')}`, differences);
  const again = ScrapeTrials.parse({ ...manifest, trials: rebuilt });
  if (canonicalJson(again) !== canonicalJson(manifest)) return fail(`the rebuilt trials manifest differs from run ${stored.id}'s action log`, ['$.action_log_sha256']);

  let performance;
  try {
    performance = scrapePerformance(again, req.trim);
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) return fail(`the trials do not make a performance under trim ${req.trim}: ${err.message}`, ['$.performance']);
    throw err;
  }
  const result = scrapeScoreOf(
    { harness_version: stored.harness_version, image_digest: stored.image_digest, dataset_sha256: stored.dataset_sha256, seed: stored.seed },
    { action_log_sha256: stored.action_log_sha256, performance },
    req,
    out.scorer_version,
  );
  // Byte for byte, or with the platform scorer moved alone (the header's versions).
  const verdict = l1Verdict(stored, storedJson, result);
  const { reproduced, differences: diffs, moved } = verdict;
  return {
    ...out,
    status: reproduced ? 'finished' : 'failed',
    reproduced,
    error: reproduced ? (moved?.note ?? null) : `the result differs from run ${stored.id}'s at ${diffs.join(', ')}`,
    differences: diffs,
    result: verdict.result,
    result_sha256: verdict.digest.sha256,
    flags: moved === null ? out.flags : withFlag(out.flags, SCORER_MOVED_FLAG),
    finished_at: new Date(),
  };
}

/**
 * The score of a scrape/v1 run (see the header): built as the heat builds every run's (grader/worker.ts) from the run's
 * recorded facts and its trials' performance, the run scored only when its scorer agreed with itself on every trial
 * (deterministic), no execution or performance flags. What L1 re-derives and a re-judging builds.
 */
export function scrapeScoreOf(
  facts: { harness_version: string; image_digest: string | null; dataset_sha256: string; seed: string },
  inputs: { action_log_sha256: string; performance: ScrapePerformanceT },
  req: Pick<RegradeL1Request, 'entry' | 'cost' | 'authorship' | 'rules' | 'size'>,
  scorerVersion: string,
): ScoreT {
  // A size given here is buildScore's TypeError (no scrape/v1 harness names a size count), never dropped unread.
  return buildScore(
    {
      harness: { kind: 'scrape/v1', version: facts.harness_version },
      image_digest: facts.image_digest,
      dataset_sha256: facts.dataset_sha256,
      seed: facts.seed,
      deterministic: true,
      execution_flags: [],
      house: req.entry.house,
      baseline: req.entry.baseline,
    },
    { action_log_sha256: inputs.action_log_sha256, performance: inputs.performance, performance_flags: [], cost: req.cost, authorship: req.authorship, size: req.size },
    req.rules,
    scorerVersion,
  );
}

/** One trial a heat ran and its scorer left unjudged (grader/scrape/score.ts ScrapeTrialRun), as the heat's log keeps it (grader/worker.ts scrapeHeatLog). */
export const ScrapeUnjudgedTrial = z.object({
  round: z.int().min(0),
  stage: ScrapeStage,
  position: z.int().min(0),
  wall_ns: z.int().min(0),
  exit: z.int().min(0).max(255).nullable(),
  outputs: TrialOutputs,
  cassette_sha256: Sha256Hex,
  /** The harness's fault (a grader/scrape/score.ts SCRAPE_FAULT_STATUSES status), or null when only the scorer was left to judge it. */
  fault: ScrapeTrialStatus.exclude(['correct', 'incorrect']).nullable(),
});
export type ScrapeUnjudgedTrialT = z.infer<typeof ScrapeUnjudgedTrial>;

/**
 * A scorer fault met judging a run's trial (grader/scrape/heat.ts ScrapeScorerFault): its stage and round, the error's name and
 * message. A judged void is none (a re-judging lists it apart: ScrapeRejudgedVoidT).
 */
export const ScrapeScorerFaultRecord = z.object({ stage: ScrapeStage, round: z.int().min(0), name: z.string(), message: z.string() });
export type ScrapeScorerFaultRecordT = z.infer<typeof ScrapeScorerFaultRecord>;

/** A heat's run as its log keeps it: a run its scorer left unscored keeps every listed trial unjudged (trials_sha256 null). */
export const ScrapeHeatLogRun = z.object({
  entry: ScrapeEntryId,
  finalist: z.boolean(),
  voids_rerun: z.int().min(0),
  scorer_faults: z.array(ScrapeScorerFaultRecord),
  trials_sha256: Sha256Hex.nullable(),
  unjudged: z.array(ScrapeUnjudgedTrial),
});
export type ScrapeHeatLogRunT = z.infer<typeof ScrapeHeatLogRun>;

/** A heat's log with its attempts and runs, as a re-judging reads it back (grader/worker.ts scrapeHeatLog writes it whole). */
export const ScrapeHeatLogRuns = ScrapeHeatLog.extend({
  /** Every attempt the heat ran (warm-ups, voids and the reference read included): what the voids review counts. */
  attempts: z.array(z.object({ stage: z.union([ScrapeHeatStage, z.literal('reference')]), entry: z.string(), outcome: z.enum(['run', 'void']) })),
  runs: z.array(ScrapeHeatLogRun),
});
export type ScrapeHeatLogRunsT = z.infer<typeof ScrapeHeatLogRuns>;

/** How many times a re-judging judges a trial when the scorer faults without disagreeing with itself: grader/scrape/heat.ts SCRAPE_JUDGE_ATTEMPTS, as the heat judged it. */
export const SCRAPE_REJUDGE_ATTEMPTS = 2;

/**
 * Why a heat voids a trial at its judging: grader/scrape/heat.ts SCRAPE_JUDGED_VOID (incorrect against the heat's reference
 * read, correct against its own cassette), written out here as SCRAPE_REJUDGE_ATTEMPTS is (regrade.ts never imports the heat).
 */
export const SCRAPE_REJUDGE_JUDGED_VOID = 'reference_only';

/** Why a re-judging judged a kept trial void (ScrapeRejudgedVoidT.message), as its answer and audit rows carry it (server/routes/admin/scrape-holds.ts). */
export function scrapeRejudgeVoidMessage(t: Pick<ScrapeUnjudgedTrialT, 'cassette_sha256'>, heatReferenceSha256: string): string {
  return (
    `judged void (${SCRAPE_REJUDGE_JUDGED_VOID}): incorrect against the heat's reference read ${heatReferenceSha256} and correct judged against its own cassette ${t.cassette_sha256}, ` +
    'so it failed on the reference read alone, on how the upstream served the same request since the heat began (a chart served short), never on what the entry wrote. ' +
    "A heat voids such a trial and runs it again; a re-judging runs no trial, so it is listed void: the run's times, counts and trim leave it out, and the run is scored on its other rounds"
  );
}

/**
 * A kept trial a re-judging judged void (the header's rejudge): incorrect against the heat's reference read, correct judged
 * again against its own cassette, and listed void (contracts/scrape.ts scrapeVoidRecord). Where it ran (its stage, round and
 * place in the round's order), its cassette, the digests of the scores.json each judging wrote (both kept in the blob store,
 * and named by its listed record: scores_sha256 and own_scores_sha256), and why (scrapeRejudgeVoidMessage).
 */
export interface ScrapeRejudgedVoidT {
  stage: ScrapeTrialRecordT['stage'];
  round: number;
  position: number;
  cassette_sha256: string;
  /** Its scores.json judged against the heat's reference read (incorrect), and against its own cassette (correct). */
  reference_scores_sha256: string;
  own_scores_sha256: string;
  message: string;
}

export interface ScrapeRejudgeRequest extends Omit<ScrapeRegradeL1Request, 'scoring'> {
  /** grader/scrape/score.ts's judge, performance and disagreement error, as the caller loaded it (regrade.ts never imports that module: ScrapeRegradeL1Request.scoring). */
  scoring: Pick<typeof import('./scrape/score.ts'), 'judgeScrapeTrial' | 'scrapePerformance' | 'ScorerDisagreementError'>;
}

/** A re-judging's outcome (rejudgeScrapeRun): the run's trials judged, and its manifest and score when every one was. */
export interface ScrapeRejudgeOutcome {
  /**
   * finished: every kept trial judged, the run scored, a judged void (judged_voids) listed void and left out of its times,
   * counts and trim, so it is scored on its other rounds; judged_void: every kept trial judged, none faulted, but its judged
   * voids leave fewer main trials to count than a run is scored on (contracts/scrape.ts scrapeFewestCountedMain), which a heat
   * would have run again and no re-judging can: the run unscored still, never marked incorrect; failed: a trial its scorer
   * still could not judge (faults), the run unscored still.
   */
  status: 'finished' | 'judged_void' | 'failed';
  heat: ScrapeHeatT;
  log: ScrapeHeatLogRunsT;
  /** The run as the heat's log keeps it. */
  run: ScrapeHeatLogRunT;
  /** The kept unjudged trials, and how many were judged (its judged voids among them): every one unless failed, those before the fault else. */
  trials: number;
  judged: number;
  /** The fault a trial was left with (one: the re-judging ends at it); none unless failed. */
  faults: ScrapeScorerFaultRecordT[];
  /** The trials judged void, in the order judged (before the fault when failed); each listed void in the manifest when finished. */
  judged_voids: ScrapeRejudgedVoidT[];
  /** The trials manifest's canonical JSON (the run's action log) and its sha256; null when failed. */
  action_log_json: string | null;
  action_log_sha256: string | null;
  result: ScoreT | null;
  result_sha256: string | null;
  /** The scorer_version the trials were judged under (scorerVersionOf the plan and sandbox: the bundle's sealed scorer now, and its image). */
  scorer_version: string;
  /** The run's main standing (scrapePerformance stage 'main'), what the heat drew its playoff from; null when failed. */
  main: ScrapePerformanceT | null;
  started_at: Date;
  finished_at: Date;
}

/** A scrape/v1 run's heat record and log, read back and held to each other and to the run (the header's L1): a RegradeError when they are not. */
async function scrapeHeatRecordsOf<L extends typeof ScrapeHeatLog | typeof ScrapeHeatLogRuns>(
  stored: StoredRun & { dataset_sha256: string; stderr_sha256: string },
  blobs: Pick<BlobStore, 'get'>,
  schema: L,
): Promise<{ heat: ScrapeHeatT; log: z.infer<L> }> {
  const heatParsed = ScrapeHeat.safeParse(await canonicalBlob(blobs, stored.dataset_sha256, `run ${stored.id}'s heat record`));
  if (!heatParsed.success) throw new RegradeError(`run ${stored.id}'s heat record ${stored.dataset_sha256} is not a scrape heat record: ${heatParsed.error.issues[0]!.message}`);
  const heat = heatParsed.data;
  const logParsed = schema.safeParse(await canonicalBlob(blobs, stored.stderr_sha256, `run ${stored.id}'s heat log`));
  if (!logParsed.success) throw new RegradeError(`run ${stored.id}'s heat log ${stored.stderr_sha256} is not a scrape heat log: ${logParsed.error.issues[0]!.message}`);
  const log = logParsed.data as z.infer<L>;
  if (log.heat_sha256 !== stored.dataset_sha256 || log.heat !== heat.id) throw new RegradeError(`run ${stored.id}'s heat log ${stored.stderr_sha256} is heat ${log.heat}'s (${log.heat_sha256}), not the run's ${heat.id} (${stored.dataset_sha256})`);
  // The reference read every trial is judged against is the one the heat record names; a log naming another is not this heat's.
  if (log.reference.cassette_sha256 !== heat.reference_cassette_sha256) {
    throw new RegradeError(`run ${stored.id}'s heat log ${stored.stderr_sha256} names the reference read ${log.reference.cassette_sha256}, the heat record ${stored.dataset_sha256} names ${heat.reference_cassette_sha256}`);
  }
  return { heat, log };
}

/**
 * Judge again the trials a scrape/v1 run's scorer left unjudged (the header's rejudge): from the heat's log and the
 * blob store, with the bundle's sealed scorer as it is now, against the heat's reference read the heat record names.
 * No trial runs again and no upstream is asked. Every trial judged: the run's manifest and score, built as a heat builds
 * them. One a heat would void at its judging (incorrect, and correct judged again against its own cassette: only a heat can
 * run it again) is a judged void, listed void in the manifest (contracts/scrape.ts scrapeVoidRecord), so the run is scored
 * on its other rounds; voids that leave fewer main trials to count than a run is scored on: `judged_void`, nothing built.
 * A trial still unjudgeable: `failed`, its fault listed. Nothing is recorded here.
 */
export async function rejudgeScrapeRun(req: ScrapeRejudgeRequest, startedAt = new Date()): Promise<ScrapeRejudgeOutcome> {
  const { stored, plan } = req;
  if (plan.kind !== 'scrape/v1') throw new RegradeError(`run ${stored.id}'s plan is ${plan.kind}, not scrape/v1`);
  if (stored.status !== 'failed' || stored.action_log_sha256 !== null || (stored.result !== null && stored.result !== undefined)) {
    throw new RegradeError(`run ${stored.id} (${stored.status}) is no run its scorer left unscored: it has a trials manifest, which an L1 regrade re-derives`);
  }
  const { harness_version: harnessVersion, seed, dataset_sha256: datasetSha256 } = stored;
  const stderrSha256 = stored.stderr_sha256 ?? null;
  if (harnessVersion === null || seed === null) throw new RegradeError(`run ${stored.id} lacks its harness_version or seed`);
  if (datasetSha256 === null) throw new RegradeError(`run ${stored.id} names no heat record (dataset_sha256)`);
  if (stderrSha256 === null) throw new RegradeError(`run ${stored.id} names no heat log (stderr_sha256): its unjudged trials cannot be read back`);
  if (datasetSha256 !== plan.datasetSha256) throw new RegradeError(`run ${stored.id} ran in heat ${datasetSha256}, the plan holds ${plan.datasetSha256}`);
  await reapRegradeScratch(req);

  const { heat, log } = await scrapeHeatRecordsOf({ ...stored, dataset_sha256: datasetSha256, stderr_sha256: stderrSha256 }, req.blobs, ScrapeHeatLogRuns);
  const kept = log.runs.find((r) => r.entry === req.entryId);
  if (kept === undefined) throw new RegradeError(`heat ${heat.id}'s log ${stderrSha256} keeps no run of entry ${req.entryId}`);
  if (kept.trials_sha256 !== null) throw new RegradeError(`heat ${heat.id} judged entry ${req.entryId}'s run whole (its trials manifest ${kept.trials_sha256}): nothing was left unjudged`);
  if (kept.unjudged.length === 0) throw new RegradeError(`heat ${heat.id}'s log ${stderrSha256} keeps no unjudged trial of entry ${req.entryId}`);

  const { judgeScrapeTrial, scrapePerformance, ScorerDisagreementError } = req.scoring;
  const { ScorerError } = await import('./program-scores.ts');
  const scorerVersion = scorerVersionOf(plan, req.sandbox);
  const records: ScrapeTrialRecordT[] = [];
  const faults: ScrapeScorerFaultRecordT[] = [];
  const judgedVoids: ScrapeRejudgedVoidT[] = [];
  const scoring = await scoringScratch(req);
  type Judged = Awaited<ReturnType<typeof judgeScrapeTrial>>;
  /**
   * Judge a kept trial against `reference` as the heat judges one (grader/scrape/heat.ts judgeTrial): a ScorerError that is
   * not a disagreement tried once more, the scores.json kept in the blob store. The fault it is left with, else its verdict.
   */
  const judgeKept = async (t: ScrapeUnjudgedTrialT, reference: string): Promise<{ judged: Judged } | { fault: ScrapeScorerFaultRecordT; disagreement: boolean }> => {
    for (let n = 1; ; n++) {
      let judged: Judged;
      try {
        judged = await judgeScrapeTrial({ sandbox: req.sandbox, setup: req.setup, trial: t, heatReferenceSha256: reference, blobs: req.blobs, limits: req.limits, workDir: scoring });
      } catch (err) {
        // A trial out of shape is the log's, which no scorer mends.
        if (err instanceof RangeError || err instanceof TypeError) throw new RegradeError(`heat ${heat.id}'s log keeps entry ${req.entryId}'s ${t.stage} round ${t.round} out of shape: ${err.message}`);
        if (!(err instanceof ScorerError)) throw err;
        const disagreement = err instanceof ScorerDisagreementError;
        if (!disagreement && n < SCRAPE_REJUDGE_ATTEMPTS) continue;
        return { fault: { stage: t.stage, round: t.round, name: err.name, message: err.message }, disagreement };
      }
      if (judged.scored !== null) {
        const put = await req.blobs.put(judged.scored.scores_json);
        if (put.sha256 !== judged.scored.scores_sha256) throw new Error(`the blob store named scores.json of sha256 ${judged.scored.scores_sha256} ${put.sha256}`);
      }
      return { judged };
    }
  };
  try {
    for (const t of kept.unjudged) {
      const first = await judgeKept(t, heat.reference_cassette_sha256);
      // The scorer still cannot judge it: the run stays unscored, and its later trials wait for the next re-judging.
      if ('fault' in first) {
        faults.push(first.fault);
        break;
      }
      // Incorrect: judged once more against its own cassette, as the heat judges it (its judged voids). Correct then, a heat
      // voids it and runs it again, which no re-judging can: a judged void, listed void (both scores.json named) and counting
      // for nothing, and the judging goes on. A second judging that faults voids nothing (the trial stays incorrect); one
      // that disagrees with itself is the run's fault.
      if (first.judged.record.status === 'incorrect') {
        const second = await judgeKept(t, t.cassette_sha256);
        if ('fault' in second && second.disagreement) {
          faults.push(second.fault);
          break;
        }
        if ('judged' in second && second.judged.record.status === 'correct') {
          const listed = scrapeVoidRecord(first.judged.record, second.judged.record);
          judgedVoids.push({
            stage: t.stage,
            round: t.round,
            position: t.position,
            cassette_sha256: t.cassette_sha256,
            reference_scores_sha256: listed.scores_sha256!,
            own_scores_sha256: listed.own_scores_sha256!,
            message: scrapeRejudgeVoidMessage(t, heat.reference_cassette_sha256),
          });
          records.push(listed);
          continue;
        }
      }
      records.push(first.judged.record);
    }
  } finally {
    await removeScratch(req.sandbox, scoring);
  }
  const judgedOf = { heat, log, run: kept, trials: kept.unjudged.length, judged: records.length, judged_voids: judgedVoids, scorer_version: scorerVersion, started_at: startedAt };
  const unbuilt = { action_log_json: null, action_log_sha256: null, result: null, result_sha256: null, main: null } as const;
  // A trial its scorer still cannot judge: the run's later trials wait, so nothing is built.
  if (faults.length > 0) return { ...judgedOf, status: 'failed', faults, ...unbuilt, finished_at: new Date() };
  // Judged voids that leave fewer main trials to count than a run is scored on: no performance, so nothing is built.
  const countedMain = scrapeCountedTrials(records.filter((t) => t.stage === 'main')).length;
  if (judgedVoids.length > 0 && countedMain < scrapeFewestCountedMain(req.trim)) return { ...judgedOf, status: 'judged_void', faults, ...unbuilt, finished_at: new Date() };

  const manifestParsed = ScrapeTrials.safeParse({ format: SCRAPE_TRIALS_FORMAT, heat: heat.id, entry: req.entryId, trials: records, voids_rerun: kept.voids_rerun });
  if (!manifestParsed.success) throw new RegradeError(`entry ${req.entryId}'s judged trials make no trials manifest: ${manifestParsed.error.issues[0]!.message}`);
  const manifest = manifestParsed.data;
  const issues = scrapeTrialsHeatIssues(heat, manifest);
  if (issues.length > 0) throw new RegradeError(`entry ${req.entryId}'s judged trials disagree with heat ${heat.id}'s record: ${issues.join('; ')}`);
  let performance: ScrapePerformanceT;
  let main: ScrapePerformanceT;
  try {
    performance = scrapePerformance(manifest, req.trim);
    main = scrapePerformance(manifest, req.trim, 'main');
  } catch (err) {
    if (err instanceof RangeError || err instanceof TypeError) throw new RegradeError(`entry ${req.entryId}'s judged trials make no performance under trim ${req.trim}: ${err.message}`);
    throw err;
  }
  const actionLogJson = canonicalJson(manifest);
  const actionLogSha256 = sha256Hex(actionLogJson);
  const result = scrapeScoreOf({ harness_version: harnessVersion, image_digest: stored.image_digest, dataset_sha256: datasetSha256, seed }, { action_log_sha256: actionLogSha256, performance }, req, scorerVersion);
  return {
    ...judgedOf,
    status: 'finished',
    faults: [],
    action_log_json: actionLogJson,
    action_log_sha256: actionLogSha256,
    result,
    result_sha256: scoreDigest(result).sha256,
    main,
    finished_at: new Date(),
  };
}

// ---------------------------------------------------------------- referral/v1: L1 from the stored action log

/** Why a referral/v1 run has no L2 (the header): grader/worker.ts refuses an L2 regrade job of one with it. */
export const REFERRAL_L2_REFUSAL = 'a referral/v1 count cannot be re-run; L1 re-scores the stored action log';

/** What a referral/v1 L1 regrade reads: the stored run, the blob store its action log is in, and the facts its score was built under. */
export interface ReferralRegradeL1Request {
  stored: StoredRun;
  /** Holds the run's stored action log (`stored.action_log_sha256`). */
  blobs: Pick<BlobStore, 'get'>;
  /** The bundle's eligibility rules (score.ts eligibilityRulesOf): a referral/v1 score reads none of them, but buildScore takes them. */
  rules: EligibilityRules;
  /** The entry's facts as its grade read them (standingsHouse, baseline): the score's eligibility is these alone. */
  entry: EntryFacts;
  /** When this attempt started (RegradeOutcome.started_at). */
  startedAt?: Date;
}

/**
 * The scorer_version a referral/v1 L1 re-scores under (regradeScorerVersion's rule, without a plan or an image): this
 * process's, or the run's when its scorer code is this process's and only comments or whitespace moved since.
 */
function referralScorerVersion(stored: Pick<StoredRun, 'scorer_version'>): string {
  const current = scorerVersion();
  if (stored.scorer_version === null || stored.scorer_version === current) return current;
  return codeVersionOf(stored.scorer_version) === current ? stored.scorer_version : current;
}

/**
 * L1 of a referral/v1 run (the header): read the stored action log, held to ReferralActionLog and to the hash its run
 * names, re-derive the score from it (buildScore counts its counted sign-ups; the run's recorded facts and the kind's
 * constants are the score's other inputs), and hold it to the stored result byte for byte (l1Verdict). Nothing executes
 * and no sandbox is read: the log is the whole evidence. A run with no scored log, or a log missing, corrupt or not a
 * log, is a RegradeError.
 */
export async function regradeReferralL1(req: ReferralRegradeL1Request): Promise<RegradeOutcome> {
  const { stored } = req;
  const startedAt = req.startedAt ?? new Date();
  const out: RegradeOutcome = {
    kind: 'regrade_l1',
    reproduces_run_id: stored.id,
    status: 'failed',
    reproduced: false,
    error: null,
    differences: [],
    result: null,
    result_sha256: null,
    trace_json: null,
    trace_sha256: null,
    action_log_sha256: stored.action_log_sha256,
    harness_version: stored.harness_version,
    scorer_version: referralScorerVersion(stored),
    image_digest: stored.image_digest,
    dataset_sha256: stored.dataset_sha256,
    seed: stored.seed,
    fail_key: null,
    flags: [],
    exec_count: 0,
    wall_ms: 0,
    executions: [],
    stderr: Buffer.alloc(0),
    started_at: startedAt,
    finished_at: new Date(),
  };
  const fail = (error: string, differences: string[] = []): RegradeOutcome => ({ ...out, status: 'failed', error, differences, finished_at: new Date() });
  if (!RESCORABLE.has(stored.status) || stored.result === null || stored.result === undefined || stored.action_log_sha256 === null) {
    throw new RegradeError(`run ${stored.id} (${stored.status}) has no scored action log to re-derive`);
  }
  if (stored.harness_version === null || stored.seed === null) throw new RegradeError(`run ${stored.id} lacks its harness_version or seed`);
  const storedJson = canonicalJson(stored.result);
  if (stored.result_sha256 !== sha256Hex(storedJson)) return fail(`run ${stored.id}'s stored result no longer hashes to its result_sha256`);
  if (stored.dataset_sha256 !== REFERRAL_DATASET_SHA256) {
    return fail(`dataset_sha256 differs: the run used ${stored.dataset_sha256}, a referral/v1 score carries ${REFERRAL_DATASET_SHA256}`, ['$.dataset_sha256']);
  }
  let log: ReferralActionLogT;
  try {
    log = referralActionLogOf(await loadActionLog(req.blobs, stored.action_log_sha256));
  } catch (err) {
    if (err instanceof RegradeError) throw err;
    throw new RegradeError(`run ${stored.id}'s action log is not a referral/v1 log: ${err instanceof Error ? err.message : String(err)}`);
  }
  let rebuilt: ScoreT;
  try {
    rebuilt = buildScore(
      {
        harness: { kind: 'referral/v1', version: stored.harness_version },
        image_digest: stored.image_digest,
        dataset_sha256: stored.dataset_sha256,
        seed: stored.seed,
        deterministic: stored.status !== 'nondeterministic',
        execution_flags: stored.flags.filter((f) => !RUN_ONLY_FLAGS.has(f)),
        house: req.entry.house,
        baseline: req.entry.baseline,
      },
      { action_log_sha256: stored.action_log_sha256, performance: referralPerformanceOf(log), referral_log: log, performance_flags: [], cost: REFERRAL_COST, authorship: null },
      req.rules,
      out.scorer_version,
    );
  } catch (err) {
    if (err instanceof TypeError || err instanceof z.ZodError) return fail(`run ${stored.id}'s stored action log does not rebuild its score: ${err.message}`);
    throw err;
  }
  const verdict = l1Verdict(stored, storedJson, rebuilt);
  const { reproduced, differences, moved } = verdict;
  const flags = moved === null ? out.flags : withFlag(out.flags, SCORER_MOVED_FLAG);
  return {
    ...out,
    status: reproduced ? 'finished' : 'failed',
    reproduced,
    error: reproduced ? (moved?.note ?? null) : `the result differs from run ${stored.id}'s at ${differences.join(', ')}`,
    differences,
    result: verdict.result,
    result_sha256: verdict.digest.sha256,
    flags,
    finished_at: new Date(),
  };
}

// ---------------------------------------------------------------- desk/v1: L1 from the stored action log

/** Why a desk/v1 run has no L2 (the header): grader/worker.ts refuses an L2 regrade job of one with it, server/routes/admin/grading.ts before it is queued. */
export const DESK_L2_REFUSAL = 'a desk/v1 count cannot be re-run; L1 re-scores the stored action log';

/** What a desk/v1 L1 regrade reads: referral/v1's request (the stored run, its blob store, the rules and the entry's facts). */
export type DeskRegradeL1Request = ReferralRegradeL1Request;

/**
 * L1 of a desk/v1 run (the header): read the stored action log, held to DeskActionLog and to the hash its run names,
 * re-derive the score from it (buildScore counts its credited weights, ranked against the rules' min_points; the run's
 * recorded facts and the kind's constants are the score's other inputs), and hold it to the stored result byte for byte
 * (l1Verdict). Nothing executes and no desk table is read: the log is the whole evidence, so a credit revoked since the
 * grade moves nothing here (a fresh grade reads the desk again). A run with no scored log, or a log missing, corrupt or
 * not a log, is a RegradeError.
 */
export async function regradeDeskL1(req: DeskRegradeL1Request): Promise<RegradeOutcome> {
  const { stored } = req;
  const startedAt = req.startedAt ?? new Date();
  const out: RegradeOutcome = {
    kind: 'regrade_l1',
    reproduces_run_id: stored.id,
    status: 'failed',
    reproduced: false,
    error: null,
    differences: [],
    result: null,
    result_sha256: null,
    trace_json: null,
    trace_sha256: null,
    action_log_sha256: stored.action_log_sha256,
    harness_version: stored.harness_version,
    scorer_version: referralScorerVersion(stored),
    image_digest: stored.image_digest,
    dataset_sha256: stored.dataset_sha256,
    seed: stored.seed,
    fail_key: null,
    flags: [],
    exec_count: 0,
    wall_ms: 0,
    executions: [],
    stderr: Buffer.alloc(0),
    started_at: startedAt,
    finished_at: new Date(),
  };
  const fail = (error: string, differences: string[] = []): RegradeOutcome => ({ ...out, status: 'failed', error, differences, finished_at: new Date() });
  if (!RESCORABLE.has(stored.status) || stored.result === null || stored.result === undefined || stored.action_log_sha256 === null) {
    throw new RegradeError(`run ${stored.id} (${stored.status}) has no scored action log to re-derive`);
  }
  if (stored.harness_version === null || stored.seed === null) throw new RegradeError(`run ${stored.id} lacks its harness_version or seed`);
  const storedJson = canonicalJson(stored.result);
  if (stored.result_sha256 !== sha256Hex(storedJson)) return fail(`run ${stored.id}'s stored result no longer hashes to its result_sha256`);
  if (stored.dataset_sha256 !== DESK_DATASET_SHA256) {
    return fail(`dataset_sha256 differs: the run used ${stored.dataset_sha256}, a desk/v1 score carries ${DESK_DATASET_SHA256}`, ['$.dataset_sha256']);
  }
  let log: DeskActionLogT;
  try {
    log = deskActionLogOf(await loadActionLog(req.blobs, stored.action_log_sha256));
  } catch (err) {
    if (err instanceof RegradeError) throw err;
    throw new RegradeError(`run ${stored.id}'s action log is not a desk/v1 log: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The grade stores the log as its canonical JSON (gradeDesk): the parsed log written again is those bytes, or the log
  // was not the one the grade wrote.
  if (sha256Hex(canonicalJson(log)) !== stored.action_log_sha256) {
    return fail(`run ${stored.id}'s action log is not the canonical JSON of the log it holds: its bytes are not the ones the grade wrote`, ['$.action_log_sha256']);
  }
  let rebuilt: ScoreT;
  try {
    rebuilt = buildScore(
      {
        harness: { kind: 'desk/v1', version: stored.harness_version },
        image_digest: stored.image_digest,
        dataset_sha256: stored.dataset_sha256,
        seed: stored.seed,
        deterministic: stored.status !== 'nondeterministic',
        execution_flags: stored.flags.filter((f) => !RUN_ONLY_FLAGS.has(f)),
        house: req.entry.house,
        baseline: req.entry.baseline,
      },
      { action_log_sha256: stored.action_log_sha256, performance: deskPerformanceOf(log), desk_log: log, performance_flags: [], cost: DESK_COST, authorship: null },
      req.rules,
      out.scorer_version,
    );
  } catch (err) {
    if (err instanceof TypeError || err instanceof z.ZodError) return fail(`run ${stored.id}'s stored action log does not rebuild its score: ${err.message}`);
    throw err;
  }
  const verdict = l1Verdict(stored, storedJson, rebuilt);
  const { reproduced, differences, moved } = verdict;
  const flags = moved === null ? out.flags : withFlag(out.flags, SCORER_MOVED_FLAG);
  return {
    ...out,
    status: reproduced ? 'finished' : 'failed',
    reproduced,
    error: reproduced ? (moved?.note ?? null) : `the result differs from run ${stored.id}'s at ${differences.join(', ')}`,
    differences,
    result: verdict.result,
    result_sha256: verdict.digest.sha256,
    flags,
    finished_at: new Date(),
  };
}

// ---------------------------------------------------------------- agent/v1: L1 rescore, L2 replay

/** One trial of the run as the regrade reads it besides its manifest record: where its instance is, and its voided passes. */
export interface AgentTrialSource {
  /** The trial's index (the manifest's). */
  index: number;
  /** The instance's directory (input/, reference/): it must digest to the manifest's instance_sha256. */
  instanceDir: string;
  /** Live passes that voided and re-ran before the one that counts (its run_trial row's attempt - 1). */
  voids: number;
}

/** An agent/v1 L1's request: no signal, regradeAgentL1 re-scoring every trial to its end; L2's replays take one (AgentRegradeL2Request.signal). */
export interface AgentRegradeL1Request extends Omit<RegradeL1Request, 'signal'> {
  /** The bundle's side of a trial: its scorer (and, for L2, its env), the harness and the leaderboard's columns. */
  setup: AgentSetup;
  /** The leaderboard the performance aggregates on (its primary column and scored columns). */
  leaderboard: AgentLeaderboard;
  /** Every trial of the manifest: its instance and void count. */
  trials: readonly AgentTrialSource[];
  /**
   * Whose regrade this is, as a label value (grader/sandbox/network.ts TRIAL_OWNER_RE), the same on
   * every attempt of the regrade and no other's (the pipeline's worker.ts regradeOwner,
   * `regrade-<job id>`): its scratch is named for it (`regrade-agent-<owner>-XXXXXX`, not an L1's or
   * L2's `exec-`/`score-`) and what a dead attempt left is removed first, and L2 replays trial t
   * under owner `<owner>.<t>` (the header's `owner`). Absent: as before.
   */
  owner?: string;
  /** Told what the removal of a dead attempt's scratch took (and could not), each time it ran. */
  onScratchReap?: (reaped: ScratchReap) => void;
  /** A practice top-up run's own record (readTopUpRegrade, the header's `top-up`): its band said on the outcome. */
  topUp?: AgentTopUpRegrade;
}

// ---------------------------------------------------------------- a practice top-up's run (the header's `top-up`)

/** A practice top-up run as its regrade reads it (readTopUpRegrade): the trials its plan runs on, its row's numbers. */
export interface AgentTopUpRegrade {
  /** Its round's practice trials, 1 + (round - 1) x units to round x units (grader/worker.ts agentPhaseTrials' `practice`). */
  practice: number[];
  round: number;
  units: number;
  /** The line its sweep read (line_points_sum / line_units), the M-th best rating, M = line_rank. */
  line: { points_sum: number; units: number };
  line_rank: number;
  within: number;
}

/** Why a practice top-up run is not regraded before its competition's results (server/routes/admin.ts says it alike). */
export function topUpSealedRefusal(runId: string): string {
  return `run ${runId} is a practice top-up run, sealed until its competition's results (its ranking phase finalized): regrade it after them`;
}

/**
 * Practice top-up run `stored`'s regrade (the header's `top-up`) under the stored `bundle`, or why it is refused: its
 * competition's results not out (the run sealed, topUpSealedRefusal), no practice_top_up row (the grader writes a
 * top-up run and its row in one transaction, so none is a corrupt record), or a row whose units are not the bundle's
 * staged.top_up's (one that names none included).
 */
export async function readTopUpRegrade(db: Db, stored: { id: string; submissionId: string; phaseId: string }, bundle: CompetitionBundleT): Promise<AgentTopUpRegrade | { refused: string }> {
  const { asc, eq } = await import('drizzle-orm');
  const { phase, practiceTopUp } = await import('../server/db/schema.ts');
  const { topUpsPublished } = await import('../server/routes/_lib/visibility.ts');
  // Sealed until results (visibility.ts topUpsPublished): no regrade run of it is written before them.
  const [home] = await db.select({ competitionId: phase.competitionId }).from(phase).where(eq(phase.id, stored.phaseId));
  const phases = home === undefined ? [] : await db.select({ key: phase.key, finalizedAt: phase.finalizedAt }).from(phase).where(eq(phase.competitionId, home.competitionId)).orderBy(asc(phase.startsAt), asc(phase.key));
  if (!topUpsPublished(phases)) return { refused: topUpSealedRefusal(stored.id) };
  const [row] = await db.select().from(practiceTopUp).where(eq(practiceTopUp.runId, stored.id));
  if (row === undefined) return { refused: `run ${stored.id} is a practice top-up run with no practice_top_up row, which the grader writes in the run's own transaction: its record is corrupt, and which practice trials it ran is not on it` };
  const key = stagedTopUpOf(bundle);
  if (key === null || key.units !== row.units) {
    return { refused: `run ${stored.id} is round ${row.round} of a practice top-up of ${row.units} unit(s), and the stored bundle ${key === null ? 'names no staged.top_up' : `names staged.top_up of ${key.units} unit(s)`}: its trials are not the bundle's` };
  }
  const practice = Array.from({ length: row.units }, (_, i) => 1 + (row.round - 1) * row.units + i);
  return { practice, round: row.round, units: row.units, line: { points_sum: row.linePointsSum, units: row.lineUnits }, line_rank: row.lineRank, within: row.within };
}

/** The band its row holds, in words (the header's `top-up`): what the round was sent at, said, never a verdict. */
export function topUpBandNote(t: AgentTopUpRegrade): string {
  return `practice top-up round ${t.round} (line ${t.line.points_sum}/${t.line.units}, the M-th best rating, M = ${t.line_rank}; within ${t.within}): sent as owed, so the entry was inside the band below that line when the round was sent`;
}

// ---------------------------------------------------------------- a dead attempt's scratch (the header's `owner`)

/** An agent/v1 regrade's scratch under the work root: `regrade-agent-XXXXXX`, with an owner `regrade-agent-<owner>-XXXXXX`. */
export const REGRADE_SCRATCH_PREFIX = 'regrade-agent-';

/** What reapScratch removed of an owner's scratch under a root, what it left to a live attempt, and what it could not. */
export interface ScratchReap {
  /** The owner it reaped by. */
  owner: string;
  /** The directories removed, by path. */
  dirs: string[];
  /** What could not be listed or removed (the reap goes on past each). */
  errors: string[];
  /**
   * The directories left because an attempt of the owner may still be live in them (reapScratch: a heartbeat younger than
   * grade.ts SCRATCH_LIVE_MS, none yet on an empty directory made inside that bound, or one this process still beats), each
   * `<path>: <why>`. Present only when it left one, so a
   * reap that left nothing reads as it did before.
   */
  left?: string[];
}

/** How reapScratch reads the time and where it says what it left (tests hand a clock; callers keep the defaults). */
export interface ScratchReapOptions {
  /** The time now, in ms since the epoch, a heartbeat's age is read against (default Date.now). */
  now?: () => number;
  /** Where each directory left to a live attempt is said (default a line on stdout). */
  log?: (line: string) => void;
}

/** The six letters and digits mkdtemp ends a directory's name with. */
const MKDTEMP_SUFFIX_RE = /^[A-Za-z0-9]{6}$/;

/**
 * Whether `name` is a directory ownedScratch made for `owner` under `prefix`: `<prefix><owner>-` then
 * mkdtemp's six characters, so never another owner's (one this owner is a prefix of included: its name
 * is longer) nor an ownerless `<prefix>XXXXXX`.
 */
export function isOwnedScratch(name: string, prefix: string, owner: string): boolean {
  const head = `${prefix}${owner}-`;
  return name.length === head.length + 6 && name.startsWith(head) && MKDTEMP_SUFFIX_RE.test(name.slice(head.length));
}

/**
 * A fresh scratch directory under `root` named for its owner (a label value: network.ts
 * checkTrialOwner), `<root>/<prefix><owner>-XXXXXX`, where the owner's next run finds it should this
 * one's process die (reapScratch). It is handed out beating (grade.ts keepScratchAlive): its
 * `.alive` (SCRATCH_HEARTBEAT_FILE) written now and every ten minutes after while this process
 * lives, until grade.ts removeScratch takes it (every caller's own removal, as its run ends) or a
 * beat finds it gone. So the workers' start (server/pipeline/index.ts sweepDeadWork), which removes
 * owned scratch no active job on its database holds only once nothing in it changed for six hours,
 * never takes a live run's, whoever's database its job is on and whether or not its processes can
 * be seen (the docker driver's run in containers).
 */
export async function ownedScratch(root: string, prefix: string, owner: string): Promise<string> {
  const { checkTrialOwner } = await import('./sandbox/network.ts');
  const dir = await mkdtemp(join(root, `${prefix}${checkTrialOwner(owner)}-`));
  await keepScratchAlive(dir);
  return dir;
}

/** `ms` as a person reads an age: whole seconds under two minutes, else whole minutes. */
function ageWords(ms: number): string {
  return ms < 120_000 ? `${Math.floor(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`;
}

/**
 * Why an attempt of the owner may still be live in owned scratch `dir` (reapScratch), or null when none can be: this
 * process still beats its heartbeat (grade.ts beatingScratch), or its `.alive` (SCRATCH_HEARTBEAT_FILE) was written less
 * than SCRATCH_LIVE_MS before `now` (a time ahead of `now`, a clock apart, reads as fresh). A directory with no `.alive`
 * that holds nothing yet is read by its own time: ownedScratch writes the first beat into its mkdtemp's directory before
 * it hands the directory out, so between the two the directory is empty, and an empty one made less than SCRATCH_LIVE_MS
 * ago may be a run's being handed out right now, and is left. One with no `.alive` that holds anything (no run writes
 * into its directory before its first beat), or an empty one older than that, is a dead run's (one from before the
 * heartbeat, or whose first beat never landed). Its own time is its mtime, never earlier than its creation (birthtime,
 * which not every Linux filesystem keeps, could read as unknown). An `.alive` or a directory that cannot be read is left,
 * as a live one is, and the workers' start sweeps it (server/pipeline/index.ts sweepDeadWork).
 */
async function scratchLiveness(dir: string, now: number): Promise<string | null> {
  if (beatingScratch().includes(resolve(dir))) return 'this process still beats its heartbeat (a run of it here is live)';
  const within = `inside ${SCRATCH_LIVE_MS / 60_000} min (twice the ${SCRATCH_HEARTBEAT_MS / 60_000}-minute heartbeat)`;
  const ago = (age: number): string => (age < 1000 ? 'just now' : `${ageWords(age)} ago`);
  let aliveMs: number;
  try {
    aliveMs = (await lstat(join(dir, SCRATCH_HEARTBEAT_FILE))).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return `its ${SCRATCH_HEARTBEAT_FILE} could not be read (${(err as Error).message}), so it may be live`;
    let madeMs: number;
    try {
      if ((await readdir(dir)).length > 0) return null;
      madeMs = (await lstat(dir)).mtimeMs;
    } catch (e) {
      return `it has no ${SCRATCH_HEARTBEAT_FILE} and could not be read itself (${(e as Error).message}), so it may be live`;
    }
    const age = now - madeMs;
    if (age >= SCRATCH_LIVE_MS) return null;
    return `it is empty, with no ${SCRATCH_HEARTBEAT_FILE} yet, and was made ${ago(age)}, ${within}, so a run may be handing it out (ownedScratch writes the first beat into it before anything else)`;
  }
  const age = now - aliveMs;
  if (age >= SCRATCH_LIVE_MS) return null;
  return `its ${SCRATCH_HEARTBEAT_FILE} was written ${ago(age)}, ${within}, so an attempt of it may still run there`;
}

/**
 * What a dead run of `owner` left under `root`: every directory ownedScratch made for `prefix` and
 * `owner` but `keep`, removed as its run would have removed it (a snapshot materialized at bot/
 * unlocked first, then grade.ts removeScratch: what the sandbox user wrote goes through the sandbox).
 * Never another owner's, an ownerless one, or a link, and never one a live run of `owner` may still work in
 * (scratchLiveness: its `.alive` younger than grade.ts SCRATCH_LIVE_MS, twice the heartbeat, none yet on an empty
 * directory made inside that bound, or one this process beats), which is left, in `left` and said on `opts.log`: every grader pod mounts the one work root, and pg-boss starts a
 * job's retry while the attempt it took for dead (a heartbeat that lapsed in a drain) still runs on another grader, so
 * an owner's earlier attempt is not dead because a new one started (job f86c2803, 2026-11-15: the retry removed the live
 * attempt's folder, which then failed on ENOENT). A dead run's directory left so goes at the owner's next reap past
 * SCRATCH_LIVE_MS after its last beat, else at the first workers' start that finds it untouched for six hours with no
 * active job holding the owner (server/pipeline/index.ts sweepDeadWork). Every caller makes its own fresh directory
 * after the reap, so none assumes the owner has none. What it removed is released from the
 * sandbox's daemon in one go once the reap is done (grade.ts releaseScratch, its header's Releasing: a dead run's
 * directory is no root this process holds, so its removal releases nothing on its own), or, given `released`, handed
 * there for the caller to release with the rest (grade.ts reapGradeScratch, a live trial pass). Never throws: what it
 * could not list or remove is in `errors`; a root that is not there holds nothing.
 */
export async function reapScratch(
  sandbox: Sandbox,
  root: string,
  prefix: string,
  owner: string,
  keep: string | null = null,
  released?: string[],
  opts: ScratchReapOptions = {},
): Promise<ScratchReap> {
  const res: ScratchReap = { owner, dirs: [], errors: [] };
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && isOwnedScratch(e.name, prefix, owner)).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') res.errors.push(`${root} could not be listed: ${(err as Error).message}`);
    return res;
  }
  const removed: string[] = released ?? [];
  const now = (opts.now ?? Date.now)();
  const log = opts.log ?? ((line: string) => console.log(line));
  for (const name of names.sort()) {
    const dir = join(root, name);
    if (keep !== null && dir === keep) continue;
    const live = await scratchLiveness(dir, now);
    if (live !== null) {
      (res.left ??= []).push(`${dir}: ${live}`);
      log(`[scratch] left ${dir} (owner ${owner}) to a live attempt, never removed: ${live}; this attempt works in its own, and the workers' start sweeps it once nothing in it has changed for six hours and no active job holds the owner`);
      continue;
    }
    try {
      await removeMaterialized(join(dir, 'bot'));
      await removeScratch(sandbox, dir, removed);
      res.dirs.push(dir);
    } catch (err) {
      res.errors.push(`${dir}: ${(err as Error).message}`);
    }
  }
  if (released === undefined) await releaseScratch(sandbox, removed);
  return res;
}

/** The owner a regrade's replay of trial `index` runs under: `<owner>.<index>` (the header's `owner`); a TypeError when that is no label value. */
export async function regradeTrialOwner(owner: string, index: number): Promise<string> {
  const { TRIAL_OWNER_RE } = await import('./sandbox/network.ts');
  const o = `${owner}.${index}`;
  if (!Number.isSafeInteger(index) || index < 0 || !TRIAL_OWNER_RE.test(o)) throw new TypeError(`regrade owner ${JSON.stringify(owner)} makes trial ${index}'s ${JSON.stringify(o)}, which is no label value: lowercase [a-z0-9._-], at most 128 characters`);
  return o;
}

/**
 * A fresh ownerless scratch root under `root` (`<prefix>XXXXXX`), held (grade.ts holdScratch, its header's Releasing)
 * until grade.ts removeScratch takes it, which then releases it from the sandbox's daemon in one go, everything removed
 * under it meanwhile with it: as an owned one (ownedScratch) is, beating.
 */
export async function heldScratch(root: string, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(root, prefix));
  holdScratch(dir);
  return dir;
}

/** A scrape re-judging's scorer scratch under its work root: one named for its owner (ownedScratch), else held (heldScratch). */
function scoringScratch(req: { workRoot: string; owner?: string }): Promise<string> {
  return req.owner === undefined ? heldScratch(req.workRoot, SCORE_SCRATCH_PREFIX) : ownedScratch(req.workRoot, SCORE_SCRATCH_PREFIX, req.owner);
}

/** A regrade's scratch under its work root: with an owner, what a dead attempt left removed first, then one named for it; else a held one (heldScratch). */
async function regradeScratch(req: AgentRegradeL1Request): Promise<string> {
  if (req.owner === undefined) return heldScratch(req.workRoot, REGRADE_SCRATCH_PREFIX);
  const { checkTrialOwner } = await import('./sandbox/network.ts');
  try {
    checkTrialOwner(req.owner);
  } catch (err) {
    throw new TypeError((err as Error).message);
  }
  req.onScratchReap?.(await reapScratch(req.sandbox, req.workRoot, REGRADE_SCRATCH_PREFIX, req.owner));
  return ownedScratch(req.workRoot, REGRADE_SCRATCH_PREFIX, req.owner);
}

/** A failed agent regrade, before or after the rebuild: the error and the paths it names. */
type AgentFail = (error: string, differences?: string[]) => RegradeOutcome;

/** The stored trials manifest, its trials each matched to their source; a RegradeError when the run cannot be re-derived. */
async function agentManifestOf(req: AgentRegradeL1Request): Promise<{ manifest: AgentTrialsT; sources: Map<number, AgentTrialSource> }> {
  const { stored, plan } = req;
  if (plan.kind !== 'agent/v1') throw new RegradeError(`run ${stored.id}'s plan is ${plan.kind}, not agent/v1`);
  const manifest = plan.parseLog(await loadActionLog(req.blobs, stored.action_log_sha256!)) as AgentTrialsT;
  const sources = new Map(req.trials.map((t) => [t.index, t]));
  const { instanceSha256Async } = await import('./agent.ts');
  for (const t of manifest.trials) {
    const src = sources.get(t.index);
    if (src === undefined) throw new RegradeError(`run ${stored.id}'s trials manifest lists trial ${t.index}, which the run holds no trial row of`);
    let digest: string;
    try {
      digest = await instanceSha256Async(src.instanceDir);
    } catch (err) {
      throw new RegradeError(`trial ${t.index}'s instance ${src.instanceDir} cannot be read: ${(err as Error).message}`);
    }
    if (digest !== t.instance_sha256) throw new RegradeError(`trial ${t.index}'s instance ${src.instanceDir} is ${digest}, not the run's ${t.instance_sha256}`);
  }
  return { manifest, sources };
}

/** The state export's canonical store state (grader/agent.ts STATE_FILE; agent.ts is loaded only when an agent regrade runs). */
const STATE_FILE = 'state.json';

/** A trial's stored state export, every file's blob there and hashing to its name; the reason when it is not. */
async function exportFault(blobs: Pick<BlobStore, 'get'>, t: AgentTrialRecordT): Promise<string | null> {
  const state = t.outputs.files.find((f) => f.path === STATE_FILE);
  if (state === undefined || state.sha256 !== t.state_sha256) return `trial ${t.index}'s state export lists no state.json ${t.state_sha256}`;
  for (const f of t.outputs.files) {
    let bytes: Uint8Array | null;
    try {
      bytes = await blobs.get(f.sha256, { verify: true });
    } catch (err) {
      return `trial ${t.index}'s state export file ${f.path} (${f.sha256}) is corrupt: ${(err as Error).message}`;
    }
    if (bytes === null) return `trial ${t.index}'s state export file ${f.path} (${f.sha256}) is missing from the blob store`;
    if (sha256Hex(bytes) !== f.sha256 || bytes.byteLength !== f.size) return `trial ${t.index}'s state export file ${f.path} (${f.sha256}) does not hold its bytes`;
  }
  return null;
}

/** A trial's stored cassette (its own, or a target's house lane's), it and every response body it lists there and hashing to its name; the reason when not. */
async function cassetteFault(blobs: Pick<BlobStore, 'get'>, sha256: string): Promise<string | null> {
  const { CassetteError, readCassette } = await import('./gateway/cassette.ts');
  let cassette: CassetteT;
  try {
    cassette = await readCassette(blobs, sha256);
  } catch (err) {
    if (err instanceof CassetteError) return err.message;
    throw err;
  }
  for (const body of new Set(cassette.entries.map((e) => e.body_sha256))) {
    let bytes: Uint8Array | null;
    try {
      bytes = await blobs.get(body, { verify: true });
    } catch (err) {
      return `its response body ${body} is corrupt: ${(err as Error).message}`;
    }
    if (bytes === null) return `its response body ${body} is missing from the blob store`;
    if (sha256Hex(bytes) !== body) return `its response body ${body} does not hold its bytes`;
  }
  return null;
}

/**
 * L1 of an agent/v1 run (see the header): every trial's stored state export re-scored, the trials re-aggregated, the
 * score rebuilt, its canonical bytes compared with the stored result's, and the run's checks trace recomputed and
 * compared with the stored one (trace_differs). Nothing of the entry runs; no model is called.
 */
export async function regradeAgentL1(req: AgentRegradeL1Request, kind: RegradeOutcome['kind'] = 'regrade_l1', startedAt = new Date()): Promise<RegradeOutcome> {
  const { stored, plan } = req;
  const out: RegradeOutcome = { ...emptyOutcome(kind, stored, plan, req.sandbox, startedAt), flags: [] };
  const fail: AgentFail = (error, differences = []) => ({ ...out, status: 'failed', error, differences, finished_at: new Date() });

  if (!RESCORABLE.has(stored.status) || stored.result === null || stored.result === undefined || stored.action_log_sha256 === null) {
    throw new RegradeError(`run ${stored.id} (${stored.status}) has no scored trials manifest to re-derive`);
  }
  if (stored.harness_version === null || stored.seed === null) throw new RegradeError(`run ${stored.id} lacks its harness_version or seed`);
  const storedJson = canonicalJson(stored.result);
  if (stored.result_sha256 !== sha256Hex(storedJson)) return fail(`run ${stored.id}'s stored result no longer hashes to its result_sha256`);
  if (stored.dataset_sha256 !== plan.datasetSha256) {
    return fail(`dataset_sha256 differs: the run's trials ran on ${stored.dataset_sha256}, the phase's instances are ${plan.datasetSha256}`, ['$.dataset_sha256']);
  }
  const { manifest, sources } = await agentManifestOf(req);
  const { scoreTrialWithChecks } = await import('./agent.ts');
  const { CassetteError, cassetteModelCalls, readCassette } = await import('./gateway/cassette.ts');

  const read: SpendTrial[] = [];
  // With an owner the scorer works in the regrade's own scratch (the header's `owner`); else in the work root, as before.
  const scoring = req.owner === undefined ? null : await regradeScratch(req);
  try {
    for (const [pos, t] of manifest.trials.entries()) {
      const at = `$.performance.trials[${pos}]`;
      let cassette: CassetteT;
      try {
        cassette = await readCassette(req.blobs, t.cassette_sha256);
      } catch (err) {
        if (err instanceof CassetteError) return fail(`trial ${t.index}'s cassette cannot be read: ${err.message}`, [`${at}.cassette_sha256`]);
        throw err;
      }
      let scored: TrialScored | null = null;
      if (t.status !== 'timeout') {
        const fault = await exportFault(req.blobs, t);
        if (fault !== null) return fail(fault, [`${at}.state_sha256`]);
        scored = await scoreTrialWithChecks({ sandbox: req.sandbox, setup: req.setup, instanceDir: sources.get(t.index)!.instanceDir, outputs: t.outputs, blobs: req.blobs, limits: req.limits, workDir: scoring ?? req.workRoot, cassette_sha256: t.cassette_sha256 });
      }
      const own = cassette;
      const house = t.house_cassette_sha256;
      read.push({
        result: {
          index: t.index,
          instance_sha256: t.instance_sha256,
          cassette_sha256: t.cassette_sha256,
          state_sha256: t.state_sha256,
          status: t.status,
          scores: scored?.scores ?? null,
          // The rows its scorer wrote beside those scores, as the fan-in kept them: the run's checks trace, never its score.
          checks: scored?.checks ?? null,
          checks_issue: scored?.checks_issue ?? null,
          pricing_rev: cassette.pricing_rev,
          requests: cassette.totals.requests,
          // The LLM agent floor's count, off the stored cassette alone, as the fan-in counted it.
          model_calls: cassetteModelCalls(cassette),
          spend_micro_usd: String(cassette.totals.micro_usd),
          voids: sources.get(t.index)!.voids,
        },
        // Its house lane's cassette too, where it has one: read only for a run whose trials name two revisions.
        cassettes: async () => {
          if (house === undefined) return [own];
          try {
            return [own, await readCassette(req.blobs, house)];
          } catch (err) {
            throw err instanceof CassetteError ? new CassetteError(`trial ${t.index}'s house lane cassette cannot be read: ${err.message}`) : err;
          }
        },
      });
    }
  } finally {
    if (scoring !== null) await removeScratch(req.sandbox, scoring);
  }
  // Trials priced on two tables that bill every call they record alike, stated on the first trial's as the fan-in stated them (spend-revision.ts).
  let results: AgentTrialResult[];
  try {
    results = await spendOnFirstTrialRevision(stored.id, read, (line) => console.warn(line));
  } catch (err) {
    if (err instanceof CassetteError) return fail(err.message, ['$.performance']);
    throw err;
  }
  // The entry's facts and the harness's waivers of the floor (a target, model_calls: optional), as the fan-in read them.
  const entry = { ...req.entry, ...agentHarnessFloorFacts(req.setup.harness) };
  let performance;
  try {
    // The entry's facts hold an entrant's run to the LLM agent floor, as the fan-in held it (agent-score.ts agentTrialSilent).
    performance = aggregateTrials(results, req.leaderboard, entry);
  } catch (err) {
    // Trials priced on two revisions, out of order or out of range: not what the fan-in aggregated.
    if (err instanceof RangeError || err instanceof TypeError) return fail(`the trials do not aggregate: ${err.message}`, ['$.performance']);
    throw err;
  }
  const result = buildScore(
    {
      harness: { kind: 'agent/v1', version: stored.harness_version },
      image_digest: stored.image_digest,
      dataset_sha256: stored.dataset_sha256,
      seed: stored.seed,
      deterministic: agentDeterministic(performance),
      execution_flags: [],
      house: req.entry.house,
      baseline: req.entry.baseline,
    },
    // A size given here is buildScore's TypeError (no agent/v1 harness names a size count), never dropped unread.
    { action_log_sha256: stored.action_log_sha256, performance, performance_flags: [], cost: req.cost, authorship: req.authorship, size: req.size },
    req.rules,
    out.scorer_version,
  );
  // Byte for byte, or with the platform scorer moved alone (the header's versions).
  const verdict = l1Verdict(stored, storedJson, result);
  const { reproduced, differences, moved } = verdict;
  // The run's checks trace recomputed as the fan-in built it (agent-score.ts agentChecksBreakdown, the entry's facts
  // alike), then compared and flagged as L1 compares a trace (the header's trace): never part of the verdict.
  const breakdown = agentChecksBreakdown(results, entry);
  if (breakdown.reason !== null) tellTraceIssue(req, kind, breakdown.reason);
  const trace = breakdown.trace === null ? null : encodeTrace(breakdown.trace);
  const differs = await traceDiffers(req.blobs, stored.trace_sha256 ?? null, trace?.json ?? null);
  const flags = moved === null ? out.flags : withFlag(out.flags, SCORER_MOVED_FLAG);
  const error = reproduced ? (moved?.note ?? null) : `the result differs from run ${stored.id}'s at ${differences.join(', ')}`;
  // A top-up's band, said beside the verdict (the header's `top-up`).
  const band = req.topUp === undefined ? null : topUpBandNote(req.topUp);
  return {
    ...out,
    status: reproduced ? 'finished' : 'failed',
    reproduced,
    error: band === null ? error : error === null ? band : `${error}; ${band}`,
    differences,
    result: verdict.result,
    result_sha256: verdict.digest.sha256,
    trace_json: trace?.json ?? null,
    trace_sha256: trace?.sha256 ?? null,
    flags: differs ? withFlag(flags, TRACE_DIFFERS_FLAG) : flags,
    finished_at: new Date(),
  };
}

/**
 * An agent/v1 L2's request: on the `pod` layout its lane host and its door, both, or neither (AgentRegradeL2Fields
 * .hosted and .door). The entry's lane key of each trial is its record's (AgentTrialRecord.entry_key), never asked for.
 */
export type AgentRegradeL2Request = AgentRegradeL2Fields & ({ hosted: HostedServices; door: Door } | { hosted?: undefined; door?: undefined });

interface AgentRegradeL2Fields extends AgentRegradeL1Request {
  runtime: Runtime;
  snapshot: SnapshotSource;
  /** The gateway forwarder the replays serve their cassettes through (grader/gateway/bundle.ts gatewayBundle). */
  gateway: Pick<GatewayBundle, 'dir' | 'script'>;
  /** Stops every replay at once. */
  signal?: AbortSignal;
  /** With an owner: told what each replay's removal of a dead attempt's replay of its trial took (grader/agent.ts RunTrialOptions.onReap), with the trial's index. */
  onReap?: (trialIndex: number, reaped: ReapResult) => void;
  /**
   * Each trial's env-lane entry secrets by its index, NAME to value: the ones its live pass recorded (run_trial
   * .entry_secret_ids, the env lane's only), re-opened, which its replay runs with as its live pass and its grade's
   * replay ran (grader/agent.ts RunTrialOptions.secrets: the entry's variables, and its forwarder's request mask, so the
   * replay keys each request as live did). A trial absent here, or with none, replays with none (the header's entry
   * secrets).
   */
  trialSecrets?: ReadonlyMap<number, Readonly<Record<string, string>>>;
  /**
   * Why a trial's recorded entry secrets cannot be opened again (one erased since), by trial, NAME and row, never a
   * value: the L2 is refused before any trial replays (ENTRY_SECRETS_ERASED), and the run's L1 stands.
   */
  secretsErased?: string;
  /**
   * The key of the phase the run graded, for the words of a once-run trial's first replay alone (the header's L2):
   * `final` names a staged final's entry that stopped at its qualifying trials (grader/worker.ts `staged final`: one,
   * or several on a final that names earlier cuts, the words the same), any other phase, or none, a practice trial.
   * Words only: no verdict reads it.
   */
  phaseKey?: string;
  /**
   * The `pod` layout's lane host and door (the header's layout; grader/agent.ts RunTrialOptions.hosted and .door), both
   * or neither: handed in by grader/worker.ts for a run that carries ONE_POD_FLAG, with `sandbox` the k8s sandbox's
   * one-pod view, so each trial replays on one pod as its live pass ran; the regrade run is then flagged ONE_POD_FLAG
   * too. Absent: every replay runs on `sandbox` as ever.
   */
  hosted?: HostedServices;
  door?: Door;
  /** Each replay's one pod's requests (grader/sandbox/layout.ts podRequestsOf), with `hosted`; absent, the driver's rule. */
  podRequests?: PodRequests;
}

/** The trial verdicts a replay reproduces: a trial the run replayed (a timeout never was). */
const REPLAYED: ReadonlySet<string> = new Set(['finished', 'nondeterministic']);

/**
 * The brief a replay of a trial on `instanceDir` must copy, as the RunTrialOptions.baseline that picks it (grader/agent.ts
 * trialBriefSource): the one whose bytes hash to `promptSha256`, the brief its live pass read (the trials manifest's
 * prompt_sha256, a kept run's record). `flag`'s brief is tried first (the entry's baseline flag, the usual case), then the
 * other's, so a flag changed since the live pass still replays what that pass read. With no digest recorded (a run
 * recorded before briefs were), `flag`. Null when neither brief of the instance hashes to it. A brief the instance cannot
 * be read for throws grader/agent.ts TrialFault (`instance`), as the replay itself would.
 */
export async function recordedBrief(instanceDir: string, promptSha256: string | null | undefined, flag: boolean): Promise<boolean | null> {
  if (promptSha256 === null || promptSha256 === undefined) return flag;
  const { trialBriefSource } = await import('./agent.ts');
  for (const baseline of [flag, !flag]) {
    if ((await trialBriefSource(instanceDir, baseline)).sha256 === promptSha256) return baseline;
  }
  return null;
}

/**
 * L2 of an agent/v1 run (see the header): under the stored image digest, every replayed trial replayed again from its
 * stored cassette (no upstream, no spend) to its stored verdict, then L1; under a harness_version that is not the run's,
 * reproduced only flagged harness_moved and anything else inconclusive (underMovedHarness). Under a harness
 * with a target each trial replays its house lane's cassette beside its own (AgentTrialRecord.house_cassette_sha256),
 * both served whole and both wholly consumed (grader/agent.ts ReplaySource: either left unconsumed replays
 * nondeterministic); a trial whose record names a house cassette the harness does not take, or none it does, fails.
 * Each replay hands the entry its record's entry key when it has one (AgentTrialRecord.entry_key), on either layout; on
 * the pod layout (`hosted` and `door`) a trial whose record has none fails.
 */
export async function regradeAgentL2(req: AgentRegradeL2Request): Promise<RegradeOutcome> {
  const startedAt = new Date();
  const { stored, plan } = req;
  if ((req.hosted === undefined) !== (req.door === undefined)) throw new TypeError('an agent/v1 L2 on the pod layout takes its lane host and its door together (hosted and door), or neither');
  const out: RegradeOutcome = { ...emptyOutcome('regrade_l2', stored, plan, req.sandbox, startedAt), flags: [] };
  if (stored.action_log_sha256 === null || !RESCORABLE.has(stored.status)) throw new RegradeError(`run ${stored.id} (${stored.status}) has no trials manifest to replay`);
  if (req.secretsErased !== undefined) return erasedRefusal(out, req.secretsErased);
  // A harness that is not the run's is remembered, and the L2 goes on as under the run's own (the header's versions).
  const current = harnessVersion();
  const sandboxDigest = req.sandbox.imageDigest(req.runtime);
  if ((stored.image_digest === null) !== (sandboxDigest === null)) {
    return { ...out, error: `the run used image ${stored.image_digest ?? 'none (process driver)'}; this sandbox runs ${sandboxDigest ?? 'no image (process driver)'}`, differences: ['$.image_digest'], finished_at: new Date() };
  }
  const outcome = await replayTrials(req, out, startedAt, current);
  return stored.harness_version === current ? outcome : underMovedHarness(outcome, stored, current);
}

/** regradeAgentL2 past its refusals: the preflight, every replayed trial replayed to its stored verdict, then L1. */
async function replayTrials(req: AgentRegradeL2Request, out: RegradeOutcome, startedAt: Date, current: string): Promise<RegradeOutcome> {
  const { stored, plan } = req;
  await preflight(plan, req.sandbox, req.runtime, stored.image_digest);
  const { manifest, sources } = await agentManifestOf(req);
  const { runTrial, TrialFault } = await import('./agent.ts');
  // Each replay's owner (the header's `owner`), every one a label value before anything runs.
  const owners = new Map<number, string>();
  if (req.owner !== undefined) for (const t of manifest.trials) owners.set(t.index, await regradeTrialOwner(req.owner, t.index));

  const target = req.setup.harness.target !== undefined;
  const onePod = req.hosted !== undefined && req.door !== undefined;
  // A practice grade whose trials ran once (the header's L2): its finished trials meet their first replay here (a
  // nondeterministic one of it was replayed when graded, and reads as any run's).
  const onceRun = stored.flags.includes(REPLAY_SKIPPED_FLAG);
  const scratch = await regradeScratch(req);
  const botDir = join(scratch, 'bot');
  const workDir = join(scratch, 'work');
  const executions: ExecutionSummary[] = [];
  let wall = 0;
  const ran = () => ({ ...out, exec_count: executions.length, wall_ms: wall, executions: [...executions] });
  try {
    await materializeSnapshot(req.snapshot.index, req.snapshot.blobs, botDir);
    await mkdir(workDir, { mode: 0o700 });
    for (const [pos, t] of manifest.trials.entries()) {
      if (!REPLAYED.has(t.status)) continue;
      const at = `$.performance.trials[${pos}]`;
      const house = t.house_cassette_sha256;
      // A target's trial replays with its house lane's cassette, and only a target's: a record that disagrees is no replay of the run.
      if (target !== (house !== undefined)) {
        const why = target ? 'names no house lane cassette, and the harness has a target: its replay serves the env one' : `names the house lane cassette ${house}, and the harness has no target to serve it to`;
        return { ...ran(), status: 'failed', error: `trial ${t.index} ${why}`, differences: [`${at}.house_cassette_sha256`], finished_at: new Date() };
      }
      // The key its live pass handed the entry, as its record carries it (AgentTrialRecord.entry_key: every trial of a run that ran one pod).
      const entryKey = t.entry_key;
      if (onePod && entryKey === undefined) {
        return { ...ran(), status: 'failed', error: `trial ${t.index}'s record names no entry key, and the run ran one pod: its replay cannot hand the entry the key its live pass handed it`, differences: [`${at}.entry_key`], finished_at: new Date() };
      }
      // A cassette the replay could not serve whole (tampered, or gone) is no replay of the run: the regrade fails.
      const fault = await cassetteFault(req.blobs, t.cassette_sha256);
      if (fault !== null) return { ...ran(), status: 'failed', error: `trial ${t.index}'s replay cannot serve its cassette ${t.cassette_sha256}: ${fault}`, differences: [`${at}.cassette_sha256`], finished_at: new Date() };
      const houseFault = house === undefined ? null : await cassetteFault(req.blobs, house);
      if (houseFault !== null) return { ...ran(), status: 'failed', error: `trial ${t.index}'s replay cannot serve its house lane cassette ${house}: ${houseFault}`, differences: [`${at}.house_cassette_sha256`], finished_at: new Date() };
      // The brief its live pass read, as the manifest names it (the header's L2).
      const instanceDir = sources.get(t.index)!.instanceDir;
      let baseline: boolean | null;
      try {
        baseline = await recordedBrief(instanceDir, t.prompt_sha256, req.entry.baseline);
      } catch (err) {
        if (err instanceof TrialFault) throw new RegradeError(`trial ${t.index}'s replay refused its instance: ${err.message}`);
        throw err;
      }
      if (baseline === null) {
        return { ...ran(), status: 'failed', error: `trial ${t.index}'s live pass read the brief ${t.prompt_sha256}, and its instance ${instanceDir} holds no brief of those bytes: the replay cannot copy it`, differences: [at], finished_at: new Date() };
      }
      const owner = owners.get(t.index);
      // The env-lane secrets its live pass recorded, re-opened (the header's entry secrets): the replay runs as live did.
      const secrets = req.trialSecrets?.get(t.index);
      const p: TrialPass = await runTrial({
        mode: 'replay',
        sandbox: req.sandbox,
        snapshot: { dir: botDir, runtime: req.runtime, imageDigest: stored.image_digest },
        instanceDir,
        trial: { index: t.index, instance_sha256: t.instance_sha256 },
        baseline,
        setup: req.setup,
        limits: req.limits,
        cassette: { cassette_sha256: t.cassette_sha256, state_sha256: t.state_sha256, ...(house === undefined ? {} : { house_cassette_sha256: house }) },
        gateway: req.gateway,
        workDir,
        blobs: req.blobs,
        ...(secrets === undefined || Object.keys(secrets).length === 0 ? {} : { secrets }),
        ...(req.signal === undefined ? {} : { signal: req.signal }),
        ...(owner === undefined ? {} : { owner, onReap: (r: ReapResult) => req.onReap?.(t.index, r) }),
        // On the run's own layout (the header's layout): one pod a replay, its lanes in the lanes pod, when the run's live passes ran so.
        ...(req.hosted === undefined || req.door === undefined ? {} : { hosted: req.hosted, door: req.door, ...(req.podRequests === undefined ? {} : { podRequests: req.podRequests }) }),
        // The recorded key, on either layout (the header's layout): a split replay of a one-pod run hands it too.
        ...(entryKey === undefined ? {} : { entryKey }),
      });
      const wallMs = p.entry?.wall_ms ?? 0;
      wall += wallMs;
      executions.push({ status: p.status === 'void' ? 'failed' : 'ok', error: p.error, wall_ms: wallMs, flags: [], action_log_sha256: null, exit_code: p.entry?.exit?.code ?? null, stderr_bytes: 0 });
      if (p.status === 'void') {
        if (p.reason === 'cassette') {
          const served = house === undefined ? `its cassette ${t.cassette_sha256}` : `its cassettes ${t.cassette_sha256} and ${house} (the house lane's)`;
          return { ...ran(), status: 'failed', error: `trial ${t.index}'s replay cannot serve ${served}: ${p.error ?? 'no detail'}`, differences: [`${at}.cassette_sha256`], finished_at: new Date() };
        }
        if (p.reason === 'instance') throw new RegradeError(`trial ${t.index}'s replay refused its instance: ${p.error ?? 'no detail'}`);
        throw new Error(`trial ${t.index}'s replay voided (${p.reason}): ${p.error ?? 'no detail'}; the regrade's job tries again`);
      }
      const matched = p.status === t.status && (t.status !== 'finished' || p.state_sha256 === t.state_sha256);
      if (!matched) {
        const replayed = `${p.status}${p.reason === null ? '' : ` (${p.reason}: ${p.error ?? 'no detail'})`}`;
        const state = p.state_sha256 === null ? '' : `; its state.json is ${p.state_sha256}, the live pass's ${t.state_sha256}`;
        return {
          ...ran(),
          status: 'nondeterministic',
          // A trial of a once-run grade (the header's L2: a practice trial, or a final entry that stopped at its
          // qualifying trials, one or several, each run once) had no replay to be off: this is its first.
          error: onceRun && t.status === 'finished'
            ? `trial ${t.index} ran once when graded (${req.phaseKey === 'final' ? 'a final entry that stopped at the qualifying trial' : 'a practice trial'}, ${REPLAY_SKIPPED_FLAG}: its stored finished is its live pass's, which no replay checked), and this replay, its first, came back ${replayed}${state}`
            : `trial ${t.index} replayed ${replayed}, not its stored ${t.status}${p.state_sha256 === null ? '' : `; its state.json is ${p.state_sha256}, the run's ${t.state_sha256}`}`,
          differences: [p.state_sha256 !== t.state_sha256 ? `${at}.state_sha256` : `${at}.status`],
          finished_at: new Date(),
        };
      }
    }
  } finally {
    await removeMaterialized(botDir).catch(() => undefined);
    await removeScratch(req.sandbox, scratch);
  }
  const l1 = await regradeAgentL1(req, 'regrade_l2', startedAt);
  // Replayed on one pod a trial: the regrade run says so as its grade run does (ONE_POD_FLAG, never in the score).
  const flags = req.hosted === undefined ? l1.flags : withFlag(l1.flags, ONE_POD_FLAG);
  return { ...l1, exec_count: executions.length, wall_ms: wall, executions, harness_version: current, flags };
}

// ---------------------------------------------------------------- authorship under a stored pricing_rev

export interface AuthorshipRegradeRequest {
  index: SnapshotIndex;
  blobs: Pick<BlobStore, 'get'>;
  sessions: readonly AuthorshipSession[];
  /** The pricer of the stored pricing_rev: createPricer(doc) for the rows document it names. */
  pricer: Pick<Pricer, 'pricingRev' | 'priceUsage'>;
  /**
   * The stored ledger's pricing_rev, sha256 (authorshipSha256) and algorithm version (the
   * authorship_summary row's algo_version), when one was stored: it is recomputed under that version.
   * `packs`: how many declarations the stored ledger's `packs` lists (0 for none, an older ledger's absent list
   * included); required, so no caller leaves the refusal unread: from version 8, one that lists any recomputes
   * only with req.packs, and is refused without them.
   */
  expected?: { pricing_rev: string; sha256: string; algo_version: number; packs: number };
  /**
   * The snapshot path of a patch entry's diff, as ingest passed it: its competition's policy's
   * (server/entries/policy.ts diffEntrypointOf(thinkingPolicyOf({ slug, harness })): patch.diff under
   * patch/v1), whose counted lines are the lines it adds. Absent or null under every other harness,
   * whose ledger is the same bytes either way.
   */
  patchDiff?: string | null;
  /**
   * The packs ingest passed (server/pipeline/ingest.ts packSourcesOf reads them back from the blob store by
   * the stored ledger's source_sha256): a version 8 or later ledger with packs recomputes only with them,
   * and absent is refused for one whose expected.packs counts any; versions 4 to 7 ignore them. Absent
   * otherwise: none.
   */
  packs?: readonly AuthorshipPack[];
  /**
   * The competition's kit starter ingest passed as the ledger's base (server/pipeline/ingest.ts kitStarterBase, for a
   * competition of authorship version 12: server/entries/policy.ts authorshipVersionFor): a version 12 ledger
   * recomputes only over it; versions 4 to 11 ignore it. Absent or null: none.
   */
  base?: ReadonlyMap<string, Uint8Array> | null;
}

export interface AuthorshipRegrade {
  ledger: AuthorshipLedger;
  sha256: string;
  /** Null when nothing was expected. */
  reproduced: boolean | null;
}

/**
 * Recompute the authorship ledger from the snapshot and sessions under the stored rows document and
 * the stored algorithm version (the current one when nothing was stored), a patch entry's diff read
 * as ingest read it (req.patchDiff), the packs ingest passed (req.packs) and the kit starter it passed as base
 * (req.base, read by version 12 alone). A version this build no longer
 * runs is a RegradeError, as is a stored ledger of version 8 or later listing packs (expected.packs) with
 * req.packs absent.
 */
export async function regradeAuthorship(req: AuthorshipRegradeRequest): Promise<AuthorshipRegrade> {
  if (req.expected !== undefined && req.expected.pricing_rev !== req.pricer.pricingRev) {
    throw new RegradeError(`the pricer is ${req.pricer.pricingRev}, the stored authorship was priced under ${req.expected.pricing_rev}`);
  }
  const version = req.expected?.algo_version ?? AUTHORSHIP_ALGO_VERSION;
  if (!(AUTHORSHIP_ALGO_VERSIONS as readonly number[]).includes(version)) {
    throw new RegradeError(`the stored authorship is algorithm ${version}; this build runs ${AUTHORSHIP_ALGO_VERSIONS.join(', ')}`);
  }
  // A ledger listing packs recomputed without their sources would only ever fail to reproduce: say so instead.
  const listed = req.expected?.packs ?? 0;
  if (version >= 8 && listed > 0 && req.packs === undefined) {
    throw new RegradeError(`the stored authorship (algorithm ${version}) lists ${listed} pack ${listed === 1 ? 'declaration' : 'declarations'}, and no pack sources were passed (server/pipeline/ingest.ts packSourcesOf reads them back)`);
  }
  const content = await readSnapshotContent(req.index.files, req.blobs);
  const ledger = computeAuthorship({ files: req.index.files, content, sessions: req.sessions, pricer: req.pricer, algoVersion: version as AuthorshipAlgoVersion, patchDiff: req.patchDiff ?? null, packs: req.packs ?? [], base: req.base ?? null });
  const sha256 = authorshipSha256(ledger);
  return { ledger, sha256, reproduced: req.expected === undefined ? null : sha256 === req.expected.sha256 };
}
