/**
 * Preflight gate: identity-bound verdicts and identity-based record selection.
 *
 * Why this matters (issue 1219 requirement 1): the #1212 pilot selected its gate record by
 * directory PRESENCE (`preflight/<task>/preflight.env` else `preflight-retry1/...`) and
 * copied `preflight_verdict` into the ledger without comparing it to `OK:`. On disk that
 * produced a contradictory row: `EXCLUDE:oracle-or-grader` beside `reward=1`,
 * `ctrf=present`, `validity_1167=VALID`. These tests pin the three fixes:
 *   - required test 3: a record whose run identity drifted is REJECTED, not accepted;
 *   - required test 4: selection is by explicit identity, never a directory fallback;
 *   - required test 9: an `EXCLUDE:*` verdict is an explicit exclusion, and a gate failure
 *     is distinguishable from a task failure.
 */
import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";

import {
  decisionFromRecord,
  detectNetworkFailureMarker,
  explainVerdict,
  judgeMeasurement,
  runGate,
  selectGateRecord,
  type GateRecord,
  type PreflightMeasurement,
} from "../../../../scripts/eval/terminal-bench-2.1/preflight.ts";
import {
  cleanupTempRoots,
  identityFor,
  PASSING_GRADER_LOG,
  tempRoot,
} from "./fixtures.ts";
import { PROBE_FAILED } from "../../../../scripts/eval/terminal-bench-2.1/smoke-types.ts";

afterAll(cleanupTempRoots);

/** A fully passing measurement: wiring proven, library at floor, grader exit 0. */
function passingMeasurement(
  overrides: Partial<PreflightMeasurement> = {}
): PreflightMeasurement {
  return {
    glibcxxMeasured: "GLIBCXX_3.4.31",
    bundleGlibcxxFloor: "GLIBCXX_3.4.31",
    runnerWiringOk: true,
    graderExit: 0,
    oracleReward: "1",
    ctrfBytes: 2878,
    resultLine: "7 passed",
    networkFailureMarker: false,
    ...overrides,
  };
}

function record(
  measurement: Partial<PreflightMeasurement> = {},
  identity = identityFor(),
  recordedAtEpochMs = 1_700_000_000_000
): GateRecord {
  const full = passingMeasurement(measurement);
  const verdict = judgeMeasurement(full);
  return {
    identity,
    verdict,
    reasons: explainVerdict(verdict, full),
    measurement: full,
    recordedAtEpochMs,
  };
}

describe("preflight verdict", () => {
  it("passes only when library, wiring, exit status, CTRF, result line and network state all agree", () => {
    assert.equal(
      judgeMeasurement(passingMeasurement()),
      "OK:oracle-passes-grader",
      "a fully proven measurement must pass"
    );
  });

  it("refuses a green verdict when reward is 1 but the grader never exited cleanly", () => {
    const verdict = judgeMeasurement(
      passingMeasurement({
        graderExit: null,
        oracleReward: "1",
        ctrfBytes: 2878,
      })
    );

    assert.equal(
      verdict,
      "EXCLUDE:oracle-or-grader",
      "reward alone must not establish that tests ran"
    );
  });

  it("refuses a green verdict when reward is 1 but CTRF was not retained", () => {
    const verdict = judgeMeasurement(passingMeasurement({ ctrfBytes: 0 }));

    assert.equal(
      verdict,
      "EXCLUDE:oracle-or-grader",
      "a reward with no retained CTRF must not read as a pass"
    );
  });

  it("refuses a green verdict when the result line is empty", () => {
    const verdict = judgeMeasurement(passingMeasurement({ resultLine: "" }));

    assert.equal(
      verdict,
      "EXCLUDE:oracle-or-grader",
      "no result line means no proven test run"
    );
  });

  it("refuses a green verdict when a network-failure marker is present", () => {
    const verdict = judgeMeasurement(
      passingMeasurement({ networkFailureMarker: true })
    );

    assert.equal(
      verdict,
      "EXCLUDE:oracle-or-grader",
      "a network failure invalidates the result line even when reward is 1"
    );
  });

  it("excludes a measured library ceiling below the bundle floor", () => {
    const verdict = judgeMeasurement(
      passingMeasurement({ glibcxxMeasured: "GLIBCXX_3.4.30" })
    );

    assert.equal(
      verdict,
      "EXCLUDE:glibcxx",
      "3.4.30 is below the 3.4.31 floor"
    );
  });

  it("accepts a measured library ceiling above the bundle floor", () => {
    assert.equal(
      judgeMeasurement(
        passingMeasurement({ glibcxxMeasured: "GLIBCXX_3.4.32" })
      ),
      "OK:oracle-passes-grader",
      "3.4.32 satisfies a 3.4.31 floor"
    );
  });

  it("excludes an absent library ceiling rather than assuming compatibility", () => {
    const verdict = judgeMeasurement(
      passingMeasurement({ glibcxxMeasured: "ABSENT" })
    );

    assert.equal(
      verdict,
      "EXCLUDE:glibcxx",
      "an unreadable ceiling is not a pass"
    );
  });

  it("excludes unproven runner wiring ahead of any task-level judgement", () => {
    const verdict = judgeMeasurement(
      passingMeasurement({ runnerWiringOk: false })
    );

    assert.equal(
      verdict,
      "EXCLUDE:runner-wiring",
      "wiring is an infrastructure property and is judged first"
    );
  });

  it("attaches explicit reasons to every exclusion", () => {
    const measurement = passingMeasurement({
      ctrfBytes: 0,
      resultLine: "",
      graderExit: 2,
    });
    const reasons = explainVerdict("EXCLUDE:oracle-or-grader", measurement);

    assert.ok(
      reasons.includes("ctrf=absent") &&
        reasons.includes("result_line=missing"),
      `expected both reasons; got: ${JSON.stringify(reasons)}`
    );
  });
});

describe("an unmeasured library ceiling is UNRESOLVED, not an exclusion (required test 9)", () => {
  it("leaves a failed probe unresolved instead of excluding the task", () => {
    const verdict = judgeMeasurement(
      passingMeasurement({ glibcxxMeasured: PROBE_FAILED })
    );

    assert.equal(
      verdict,
      "UNRESOLVED:glibcxx-unmeasured",
      "a probe that never ran leaves this task's ceiling unknown, so it must not be " +
        `published as the EXCLUDE:glibcxx exclusion that would blame the task; got: ${verdict}`
    );
  });

  it("tells a failed probe apart from a genuinely absent library", () => {
    const failed = judgeMeasurement(
      passingMeasurement({ glibcxxMeasured: PROBE_FAILED })
    );
    const absent = judgeMeasurement(
      passingMeasurement({ glibcxxMeasured: "ABSENT" })
    );

    assert.equal(
      absent,
      "EXCLUDE:glibcxx",
      "a probe that RAN and found no library is a measured property of the task, so it stays an exclusion"
    );
    assert.notEqual(
      failed,
      absent,
      "one excluded library was measured and the other was never measured at all"
    );
  });

  it("renders an explicit reason for an unresolved ceiling", () => {
    const reasons = explainVerdict(
      "UNRESOLVED:glibcxx-unmeasured",
      passingMeasurement({ glibcxxMeasured: PROBE_FAILED })
    );

    assert.ok(
      reasons.some((reason) =>
        reason.includes(`glibcxx_measured=${PROBE_FAILED}`)
      ),
      `the reason must carry the raw measurement; got: ${JSON.stringify(reasons)}`
    );
    assert.ok(
      reasons.some((reason) => reason.includes("bundle_glibcxx_floor=")),
      `the reason must carry the floor the unknown ceiling would be judged against; got: ${JSON.stringify(reasons)}`
    );
  });

  it("stops the driver on an unresolved ceiling and never calls it an exclusion", () => {
    const decision = decisionFromRecord(
      record({ glibcxxMeasured: PROBE_FAILED })
    );

    assert.equal(
      decision.kind,
      "reject",
      "an unresolved ceiling is a gate fault, not a task verdict"
    );
    assert.equal(
      decision.excluded,
      false,
      "an unresolved ceiling excludes nothing; there is no measured library to blame on the task"
    );
    assert.equal(
      decision.stopDriver,
      true,
      "a driver must stop on an unresolved ceiling exactly as it stops on a gate failure"
    );
  });

  it("carries an unresolved ceiling through runGate as a first-class outcome", async () => {
    const decision = await runGate(
      identityFor(),
      async () => passingMeasurement({ glibcxxMeasured: PROBE_FAILED }),
      1
    );

    assert.equal(
      decision.verdict,
      "UNRESOLVED:glibcxx-unmeasured",
      "runGate must surface the unresolved state verbatim, not as an exclusion"
    );
    assert.equal(
      decision.stopDriver,
      true,
      "runGate must stop the driver rather than dispatch on an unresolved ceiling"
    );
    assert.ok(
      decision.reasons.length > 0,
      `an unresolved ceiling must carry reasons; got: ${JSON.stringify(decision.reasons)}`
    );
  });

  it("keeps unproven wiring ahead of an unresolved ceiling", () => {
    const verdict = judgeMeasurement(
      passingMeasurement({
        runnerWiringOk: false,
        glibcxxMeasured: PROBE_FAILED,
      })
    );

    assert.equal(
      verdict,
      "EXCLUDE:runner-wiring",
      "wiring stays the infrastructure property judged first"
    );
  });

  it("keeps every real exclusion vocabulary entry intact", () => {
    const verdicts = [
      judgeMeasurement(passingMeasurement()),
      judgeMeasurement(passingMeasurement({ glibcxxMeasured: "ABSENT" })),
      judgeMeasurement(
        passingMeasurement({ glibcxxMeasured: "GLIBCXX_3.4.30" })
      ),
      judgeMeasurement(passingMeasurement({ ctrfBytes: 0 })),
      judgeMeasurement(passingMeasurement({ runnerWiringOk: false })),
    ];

    assert.deepEqual(
      verdicts,
      [
        "OK:oracle-passes-grader",
        "EXCLUDE:glibcxx",
        "EXCLUDE:glibcxx",
        "EXCLUDE:oracle-or-grader",
        "EXCLUDE:runner-wiring",
      ],
      `the established vocabulary must not shift; got: ${JSON.stringify(verdicts)}`
    );
  });
});

describe("network-failure marker detection", () => {
  it("finds a real network marker in grader output", () => {
    assert.equal(
      detectNetworkFailureMarker(
        "curl: (7) Failed to connect to pypi.org\n1 failed"
      ),
      true,
      "a connect failure must be detected"
    );
  });

  it("does not flag clean grader output", () => {
    assert.equal(
      detectNetworkFailureMarker(PASSING_GRADER_LOG),
      false,
      "clean output must not be flagged as a network failure"
    );
  });
});

describe("gate record selection by explicit run identity (required test 4)", () => {
  it("selects the identity-matching record and never consults a directory name", () => {
    const ok = record({}, identityFor(), 1_700_000_100_000);
    const decision = selectGateRecord([ok], identityFor());

    assert.equal(
      decision.kind,
      "pass",
      "the matching OK record must be selected"
    );
    assert.equal(
      decision.record,
      ok,
      "selection must return the matching record itself"
    );
  });

  it("does not fall back to a retry record when the primary record is stale", () => {
    // The exact #1212 shape: `preflight/<task>` holds a stale EXCLUDE, `preflight-retry1`
    // holds a newer OK. The runner must REJECT the stale one instead of reading it.
    const stale = record(
      { ctrfBytes: 0 },
      identityFor({ datasetCommit: "c".repeat(40) }),
      1
    );
    const retryOk = record({}, identityFor(), 2);

    const decision = selectGateRecord([stale, retryOk], identityFor());

    assert.equal(
      decision.kind,
      "pass",
      "only the identity-matching retry record may be used"
    );
    assert.equal(
      decision.record,
      retryOk,
      "the selected record must be the fresh retry"
    );
  });

  it("rejects every supplied record when none matches the run identity (required test 3)", () => {
    const staleOk = record({}, identityFor({ imageDigest: "sha256:ddd444" }));

    const decision = selectGateRecord([staleOk], identityFor());

    assert.equal(
      decision.kind,
      "reject",
      "a stale OK record must be rejected, not accepted"
    );
    assert.equal(
      decision.verdict,
      "REJECT:stale-identity",
      "verdict must name staleness"
    );
    assert.equal(
      decision.record,
      null,
      "a rejected decision carries no usable record"
    );
    assert.ok(
      decision.reasons[0]?.includes("imageDigest"),
      `reason must name the drifted field; got: ${JSON.stringify(decision.reasons)}`
    );
  });

  it("rejects when no record at all was supplied", () => {
    const decision = selectGateRecord([], identityFor());

    assert.equal(
      decision.kind,
      "reject",
      "an absent gate record is never a pass"
    );
    assert.equal(
      decision.verdict,
      "REJECT:no-record",
      "verdict must distinguish absence"
    );
    assert.equal(
      decision.excluded,
      false,
      "absence is not an exclusion, it is a gate fault"
    );
  });

  it("rejects a null record set instead of reading as a pass", () => {
    const decision = selectGateRecord([], identityFor());

    assert.notEqual(
      decision.kind,
      "pass",
      "an empty set must never select a pass"
    );
  });
});

describe("gate semantics (required test 9)", () => {
  it("marks an EXCLUDE verdict as an explicit exclusion, not a green check", () => {
    const decision = decisionFromRecord(record({ ctrfBytes: 0 }));

    assert.equal(
      decision.kind,
      "exclude",
      "an exclusion must not read as a pass"
    );
    assert.equal(
      decision.excluded,
      true,
      "the exclusion must be flagged explicitly"
    );
    assert.ok(
      decision.reasons.length > 0,
      `an exclusion must carry a reason; got: ${JSON.stringify(decision.reasons)}`
    );
  });

  it("keeps a task exclusion from aborting the whole driver", () => {
    const decision = decisionFromRecord(
      record({ glibcxxMeasured: "GLIBCXX_3.4.30" })
    );

    assert.equal(
      decision.stopDriver,
      false,
      "a task exclusion skips this slot but the frozen list continues"
    );
  });

  it("keeps a task exclusion distinguishable from a task failure", () => {
    const exclusion = decisionFromRecord(record({ graderExit: 2 }));
    const rejection = selectGateRecord(
      [record({}, identityFor({ runId: "other" }))],
      identityFor()
    );

    assert.equal(
      exclusion.kind,
      "exclude",
      "a measured oracle/grader fault is an exclusion"
    );
    assert.equal(
      rejection.kind,
      "reject",
      "an untrustworthy record is a gate fault"
    );
    assert.notEqual(
      exclusion.verdict,
      rejection.verdict,
      "exclusion and gate rejection must not collapse into one verdict"
    );
  });

  it("stops the whole driver when no trustworthy record exists", () => {
    const decision = selectGateRecord([], identityFor());

    assert.equal(
      decision.stopDriver,
      true,
      "a missing gate record must stop the driver"
    );
  });
});

describe("gate execution through the injected provisioning port", () => {
  it("probes once per identity and returns a record bound to that identity", async () => {
    const probed: string[] = [];
    const decision = await runGate(
      identityFor(),
      async (identity) => {
        probed.push(identity.runId);
        return passingMeasurement();
      },
      1_700_000_000_000
    );

    assert.deepEqual(
      probed,
      ["run-1219"],
      "the probe must receive the run identity"
    );
    assert.equal(
      decision.kind,
      "pass",
      "a proven measurement must pass the gate"
    );
    assert.equal(
      decision.record?.identity.task,
      "db-wal-recovery",
      "the retained record must carry the probed identity"
    );
  });

  it("propagates a wiring failure as a HARNESS fault, not a task exclusion", async () => {
    const decision = await runGate(
      identityFor(),
      async () => passingMeasurement({ runnerWiringOk: false }),
      1
    );

    assert.equal(
      decision.verdict,
      "EXCLUDE:runner-wiring",
      "wiring fault must surface verbatim"
    );
    // The provisioning path did not prove itself. That is a property of the harness, so it
    // must stop the driver and be charged to no task — an exclusion here would let the run
    // advance to the next slot and still exit 0, which is the #1212 defect.
    assert.equal(
      decision.kind,
      "reject",
      "a wiring fault is not a dispatchable, excludable slot"
    );
    assert.equal(
      decision.excluded,
      false,
      "a harness fault must never be charged to the task as an exclusion"
    );
    assert.equal(
      decision.stopDriver,
      true,
      "a harness fault must stop the whole driver"
    );
  });

  it("reads the library ceiling from an ABSENT probe without inventing a value", async () => {
    const decision = await runGate(
      identityFor(),
      async () => passingMeasurement({ glibcxxMeasured: "ABSENT" }),
      1
    );

    assert.equal(
      decision.verdict,
      "EXCLUDE:glibcxx",
      "an absent ceiling must exclude"
    );
  });

  it("keeps a temp root available for probe-side artifact tests", () => {
    // Guards the fixture contract the probe port relies on: real directories, no network.
    const root = tempRoot("preflight-probe");
    assert.ok(
      root.length > 0,
      `expected a temp root path; got: ${JSON.stringify(root)}`
    );
  });
});
