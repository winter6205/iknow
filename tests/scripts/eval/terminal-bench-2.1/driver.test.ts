/**
 * Driver loop boundary and required-check gating.
 *
 * Why this matters (issue 1219 requirement 1, required regression 2): `run-arms.py` ended
 * its gate check with a `break` that sat inside `for slot in pr["slots"]` (line 128), so the
 * outer `for pr in pairs` loop (line 126) simply advanced to the NEXT task. A wiring failure
 * did not stop the driver — it skipped one arm and kept spending. The same defect sat on the
 * ceiling check and the provision abort. These tests pin that a gate failure stops the
 * WHOLE driver and returns nonzero, verified both in-process and through a REAL child
 * process whose exit code is observed.
 *
 * Also required regression 9 (verdict half): a failed required check must prevent an
 * unconditional `usable` verdict.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it } from "vitest";

import {
  evaluateChecks,
  isUnconditionallyUsable,
  usableVerdict,
  type ChecksInput,
} from "../../../../scripts/eval/terminal-bench-2.1/checks.ts";
import {
  driverSlotsOf,
  type DriverSlot,
  type EvalManifest,
} from "../../../../scripts/eval/terminal-bench-2.1/config.ts";
import {
  runDriver,
  type DriverDeps,
} from "../../../../scripts/eval/terminal-bench-2.1/driver.ts";
import {
  decisionFromRecord,
  selectGateRecord,
  type GateDecision,
  type GateRecord,
} from "../../../../scripts/eval/terminal-bench-2.1/preflight.ts";
import type {
  EvidenceAssessment,
  EvidenceFailure,
} from "../../../../scripts/eval/terminal-bench-2.1/evidence.ts";
import {
  buildReport,
  retainGateOutcome,
  type RunReport,
} from "../../../../scripts/eval/terminal-bench-2.1/report.ts";
import { cleanupTempRoots, identityFor, tempRoot } from "./fixtures.ts";

afterAll(cleanupTempRoots);
const stagingDirs: string[] = [];
afterEach(() => {
  for (const dir of stagingDirs.splice(0, stagingDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Repo root derived from this file's own location.
 *
 * Why not a literal: these cases spawn a REAL child that imports the modules under test. A
 * hardcoded checkout path makes the case depend on one operator's machine — off that machine
 * `spawn` fails ENOENT and reports a false failure, and on it the child validates whatever is
 * checked out THERE instead of the tree under review.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPT_DIR = join(REPO_ROOT, "scripts/eval/terminal-bench-2.1");

function slotsFor(tasks: ReadonlyArray<string>): DriverSlot[] {
  const manifest = {
    runId: "run-1219",
    datasetCommit: "dc",
    bundleSha256: "bs",
    nodeArchiveSha256: "ns",
    runnerVersion: "v",
    outputLayout: "o",
    frozenBeforeAnyOutcome: true,
    slots: tasks.map((task, index) => ({
      task,
      image: "python:3.11-slim",
      imageDigest: `sha256:d${index}`,
      maxTurns: 40,
      arm: `arm40-${index}`,
    })),
  } as unknown as EvalManifest;
  return [...driverSlotsOf(manifest)];
}

/** How a slot's gate is scripted: a pass, a task exclusion, a harness fault, or no record. */
type GateMode = "pass" | "exclude" | "reject" | "wiring";

/** A gate decision set built from a per-slot plan, so no docker is involved. */
function gatePlan(
  plan: ReadonlyMap<string, GateMode>
): (slot: DriverSlot) => Promise<GateDecision> {
  return async (slot) => {
    const mode = plan.get(slot.slotKey) ?? "pass";
    if (mode === "reject") {
      return selectGateRecord([], identityFor({ task: slot.task }));
    }
    if (mode === "wiring") {
      const record: GateRecord = {
        identity: identityFor({ task: slot.task }),
        verdict: "EXCLUDE:runner-wiring",
        reasons: ["runner wiring unproven on the real provisioning path"],
        measurement: {
          glibcxxMeasured: "GLIBCXX_3.4.31",
          bundleGlibcxxFloor: "GLIBCXX_3.4.31",
          runnerWiringOk: false,
          graderExit: null,
          oracleReward: null,
          ctrfBytes: 0,
          resultLine: "",
          networkFailureMarker: false,
        },
        recordedAtEpochMs: 1,
      };
      return decisionFromRecord(record);
    }
    if (mode === "exclude") {
      const record: GateRecord = {
        identity: identityFor({ task: slot.task }),
        verdict: "EXCLUDE:glibcxx",
        reasons: ["glibcxx_measured=GLIBCXX_3.4.30"],
        measurement: {
          glibcxxMeasured: "GLIBCXX_3.4.30",
          bundleGlibcxxFloor: "GLIBCXX_3.4.31",
          runnerWiringOk: true,
          graderExit: 0,
          oracleReward: "1",
          ctrfBytes: 2878,
          resultLine: "7 passed",
          networkFailureMarker: false,
        },
        recordedAtEpochMs: 1,
      };
      return decisionFromRecord(record);
    }
    const record: GateRecord = {
      identity: identityFor({ task: slot.task }),
      verdict: "OK:oracle-passes-grader",
      reasons: [],
      measurement: {
        glibcxxMeasured: "GLIBCXX_3.4.31",
        bundleGlibcxxFloor: "GLIBCXX_3.4.31",
        runnerWiringOk: true,
        graderExit: 0,
        oracleReward: "1",
        ctrfBytes: 2878,
        resultLine: "7 passed",
        networkFailureMarker: false,
      },
      recordedAtEpochMs: 1,
    };
    return decisionFromRecord(record);
  };
}

function depsFor(
  slots: ReadonlyArray<DriverSlot>,
  plan: ReadonlyMap<string, GateMode>,
  dispatched: string[]
): DriverDeps {
  return {
    slots,
    identityFor: (slot) => identityFor({ task: slot.task }),
    gate: gatePlan(plan),
    dispatch: async (slot) => {
      dispatched.push(slot.slotKey);
    },
    mayDispatchMore: () => true,
    budgetReason: () => "in budget",
  };
}

describe("whole-driver stop on a gate failure (required test 2)", () => {
  it("dispatches nothing further and returns nonzero when the FIRST slot's gate is untrustworthy", async () => {
    const slots = slotsFor(["task-a", "task-b", "task-c"]);
    const dispatched: string[] = [];
    const plan = new Map([[slots[0]!.slotKey, "reject" as const]]);

    const exit = await runDriver(depsFor(slots, plan, dispatched));

    assert.equal(exit.code, 1, "a gate failure must return nonzero");
    assert.equal(
      exit.stopReason,
      "gate-failure",
      "the stop reason must name the gate"
    );
    assert.deepEqual(
      dispatched,
      [],
      "no slot may be dispatched after a gate failure"
    );
  });

  it("stops the WHOLE driver and returns nonzero on a WIRING fault, not just a bad record", async () => {
    // The distinction the issue exists to enforce: a fault of the HARNESS is not a property of
    // the task, so it may not be absorbed as a per-slot exclusion. Before the fix this verdict
    // mapped to `exclude`, the driver advanced to the next slot, and the run exited 0.
    const slots = slotsFor(["task-a", "task-b", "task-c"]);
    const dispatched: string[] = [];
    const plan = new Map([[slots[1]!.slotKey, "wiring" as const]]);

    const exit = await runDriver(depsFor(slots, plan, dispatched));

    assert.equal(
      exit.code,
      1,
      "a wiring fault is a gate failure and must return nonzero"
    );
    assert.equal(
      exit.stopReason,
      "gate-failure",
      "the stop reason must name the gate"
    );
    assert.deepEqual(
      dispatched,
      [slots[0]!.slotKey],
      "no slot after a wiring fault may be dispatched"
    );
    assert.deepEqual(
      exit.excluded,
      [],
      "a harness fault must not be charged to the task as an exclusion"
    );
  });

  it("still skips exactly one slot and continues on a genuine task exclusion", async () => {
    // The counterpart, so the wiring fix cannot be over-applied into "any EXCLUDE stops the run".
    const slots = slotsFor(["task-a", "task-b", "task-c"]);
    const dispatched: string[] = [];
    const plan = new Map([[slots[0]!.slotKey, "exclude" as const]]);

    const exit = await runDriver(depsFor(slots, plan, dispatched));

    assert.equal(exit.code, 0, "a task exclusion is not a driver stop");
    assert.deepEqual(
      exit.excluded,
      [slots[0]!.slotKey],
      "the excluded slot must still be recorded"
    );
    assert.deepEqual(
      dispatched,
      [slots[1]!.slotKey, slots[2]!.slotKey],
      "the frozen list continues past a task exclusion"
    );
  });

  it("stops the whole driver when a LATER slot's gate is untrustworthy", async () => {
    // This is the exact #1212 defect: the failure sat inside the inner slot loop, so the
    // outer task loop advanced instead of stopping.
    const slots = slotsFor(["task-a", "task-b", "task-c"]);
    const dispatched: string[] = [];
    const plan = new Map([[slots[1]!.slotKey, "reject" as const]]);

    const exit = await runDriver(depsFor(slots, plan, dispatched));

    assert.equal(
      exit.code,
      1,
      "the driver must return nonzero on a later gate failure"
    );
    assert.deepEqual(
      dispatched,
      [slots[0]!.slotKey],
      `only the slot before the failure may be dispatched; got: ${JSON.stringify(dispatched)}`
    );
    assert.equal(
      exit.stoppedAt,
      slots[1]!.slotKey,
      "the stop must name the offending slot"
    );
  });

  it("does not dispatch any later slot in the outer list after the failure", async () => {
    const slots = slotsFor(["task-a", "task-b", "task-c", "task-d", "task-e"]);
    const dispatched: string[] = [];
    const plan = new Map([[slots[2]!.slotKey, "reject" as const]]);

    await runDriver(depsFor(slots, plan, dispatched));

    assert.deepEqual(
      dispatched,
      [slots[0]!.slotKey, slots[1]!.slotKey],
      `slots after the failure must never run; got: ${JSON.stringify(dispatched)}`
    );
  });

  it("stops the whole driver when the budget is exhausted at a later slot", async () => {
    const slots = slotsFor(["task-a", "task-b", "task-c"]);
    const dispatched: string[] = [];
    const deps: DriverDeps = {
      ...depsFor(slots, new Map(), dispatched),
      mayDispatchMore: () => dispatched.length < 2,
    };

    const exit = await runDriver(deps);

    assert.equal(exit.code, 1, "an exhausted budget must return nonzero");
    assert.equal(
      exit.stopReason,
      "ceiling",
      "the stop reason must name the budget"
    );
    assert.equal(dispatched.length, 2, "the third slot must not be dispatched");
  });

  it("runs to completion with exit code 0 when every gate passes", async () => {
    const slots = slotsFor(["task-a", "task-b"]);
    const dispatched: string[] = [];

    const exit = await runDriver(depsFor(slots, new Map(), dispatched));

    assert.equal(
      exit.code,
      0,
      `a clean run must exit 0; got: ${JSON.stringify(exit)}`
    );
    assert.equal(dispatched.length, 2, "every slot must be dispatched");
    assert.equal(
      exit.stopReason,
      "completed",
      "the stop reason must be completion"
    );
  });

  it("skips an excluded slot but continues the frozen list", async () => {
    const slots = slotsFor(["task-a", "task-b", "task-c"]);
    const dispatched: string[] = [];
    const plan = new Map([[slots[1]!.slotKey, "exclude" as const]]);

    const exit = await runDriver(depsFor(slots, plan, dispatched));

    assert.equal(exit.code, 0, "an exclusion is not a driver fault");
    assert.deepEqual(
      dispatched,
      [slots[0]!.slotKey, slots[2]!.slotKey],
      `an exclusion must skip only its own slot; got: ${JSON.stringify(dispatched)}`
    );
    assert.deepEqual(
      [...exit.excluded],
      [slots[1]!.slotKey],
      "the exclusion must stay visible"
    );
  });

  it("runs a gate check before every dispatch, never only once", async () => {
    const slots = slotsFor(["task-a", "task-b"]);
    const gated: string[] = [];
    const deps: DriverDeps = {
      ...depsFor(slots, new Map(), []),
      gate: async (slot) => {
        gated.push(slot.slotKey);
        return gatePlan(new Map())(slot);
      },
    };

    await runDriver(deps);

    assert.deepEqual(
      gated,
      [slots[0]!.slotKey, slots[1]!.slotKey],
      "the gate is mandatory per slot"
    );
  });

  it("dispatches nothing at all when the first slot is excluded", async () => {
    const slots = slotsFor(["task-a"]);
    const dispatched: string[] = [];
    const plan = new Map([[slots[0]!.slotKey, "exclude" as const]]);

    const exit = await runDriver(depsFor(slots, plan, dispatched));

    assert.equal(exit.code, 0, "excluding every slot is a complete, empty run");
    assert.deepEqual(dispatched, [], "an excluded slot must never dispatch");
  });

  it("exits nonzero in a REAL child process when a gate fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-driver-exit-"));
    stagingDirs.push(dir);
    const script = join(dir, "run.mts");
    writeFileSync(
      script,
      `import { runDriver } from "${SCRIPT_DIR}/driver.ts";
import { decisionFromRecord } from "${SCRIPT_DIR}/preflight.ts";
import { identityFor } from "${REPO_ROOT}/tests/scripts/eval/terminal-bench-2.1/fixtures.ts";

const slots = [
  { slotKey: "task-a:arm40:40", task: "task-a", image: "i", imageDigest: "d", maxTurns: 40, arm: "arm40" },
  { slotKey: "task-b:arm40:40", task: "task-b", image: "i", imageDigest: "d", maxTurns: 40, arm: "arm40" },
];
const dispatched = [];
const exit = await runDriver({
  slots,
  identityFor: (slot) => identityFor({ task: slot.task }),
  // The SECOND slot's record is stale, so the driver must reject it and stop entirely.
  gate: async (slot) =>
    slot.task === "task-b"
      ? decisionFromRecord({
          identity: identityFor({ task: "task-b", datasetCommit: "stale" }),
          verdict: "EXCLUDE:glibcxx",
          reasons: ["stale"],
          measurement: {
            glibcxxMeasured: "GLIBCXX_3.4.30",
            bundleGlibcxxFloor: "GLIBCXX_3.4.31",
            runnerWiringOk: true, graderExit: 0, oracleReward: "1",
            ctrfBytes: 1, resultLine: "1 passed", networkFailureMarker: false,
          },
          recordedAtEpochMs: 1,
        })
      : decisionFromRecord({
          identity: identityFor({ task: "task-a" }),
          verdict: "OK:oracle-passes-grader",
          reasons: [],
          measurement: {
            glibcxxMeasured: "GLIBCXX_3.4.31",
            bundleGlibcxxFloor: "GLIBCXX_3.4.31",
            runnerWiringOk: true, graderExit: 0, oracleReward: "1",
            ctrfBytes: 2878, resultLine: "7 passed", networkFailureMarker: false,
          },
          recordedAtEpochMs: 1,
        }),
  dispatch: async (slot) => { dispatched.push(slot.slotKey); },
  mayDispatchMore: () => true,
  budgetReason: () => "in budget",
});
console.log(JSON.stringify({ code: exit.code, stopReason: exit.stopReason, dispatched }));
process.exitCode = exit.code;
`
    );

    const { code, stdout } = await runNode(script);
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");

    assert.equal(
      code,
      1,
      `the child must exit nonzero on a gate failure; got: ${code}`
    );
    assert.equal(
      parsed.stopReason,
      "gate-failure",
      `expected a gate stop; got: ${JSON.stringify(parsed)}`
    );
    assert.deepEqual(
      parsed.dispatched,
      ["task-a:arm40:40"],
      `only the pre-failure slot may have run; got: ${JSON.stringify(parsed.dispatched)}`
    );
  }, 20_000);
});

interface ChildResult {
  readonly code: number;
  readonly stdout: string;
}

function runNode(script: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout: stdout + stderr })
    );
  });
}

describe("required checks gate the verdict (required test 9)", () => {
  function cleanInput(overrides: Partial<ChecksInput> = {}): ChecksInput {
    return {
      unfinishedAttempts: 0,
      tornLedgerLines: 0,
      declaredSlots: 2,
      attemptedStimuli: 2,
      acceptedStimuli: 2,
      settledStimuli: 2,
      evidence: [assessment("complete", []), assessment("complete", [])],
      protocol: {
        frozenBeforeAnyOutcome: true,
        oneAttemptPerSlot: true,
        noRetries: true,
        originalGraderUsed: true,
      },
      gateFailures: 0,
      ...overrides,
    };
  }

  it("reports usable only when every required check passes", () => {
    const report = evaluateChecks(cleanInput());

    assert.equal(
      report.usable,
      true,
      `expected usable; failed: ${JSON.stringify(report.failedCheckIds)}`
    );
    assert.equal(
      usableVerdict(report),
      "usable",
      "the verdict must agree with the report"
    );
    assert.deepEqual(
      [...report.failedCheckIds],
      [],
      "a clean report has no failed checks"
    );
  });

  it("fails clean-stop when an attempt never settled", () => {
    const report = evaluateChecks(cleanInput({ unfinishedAttempts: 1 }));

    assert.equal(
      report.usable,
      false,
      "an unsettled attempt blocks a usable verdict"
    );
    assert.ok(
      report.failedCheckIds.includes("clean-stop"),
      `expected clean-stop to fail; got: ${JSON.stringify(report.failedCheckIds)}`
    );
  });

  it("fails clean-stop when the ledger has a torn line from a kill mid-append", () => {
    const report = evaluateChecks(cleanInput({ tornLedgerLines: 1 }));

    assert.ok(
      report.failedCheckIds.includes("clean-stop"),
      `a torn ledger line is not a clean stop; got: ${JSON.stringify(report.failedCheckIds)}`
    );
  });

  it("fails stimuli-settled when an accepted stimulus never settled", () => {
    const report = evaluateChecks(
      cleanInput({ settledStimuli: 1, acceptedStimuli: 2 })
    );

    assert.ok(
      report.failedCheckIds.includes("stimuli-settled"),
      `expected stimuli-settled to fail; got: ${JSON.stringify(report.failedCheckIds)}`
    );
  });

  it("keeps pre-dispatch gate failures visible in the stimuli detail without failing it", () => {
    const report = evaluateChecks(
      cleanInput({ gateFailures: 1, settledStimuli: 2, acceptedStimuli: 2 })
    );

    const check = report.checks.find((entry) => entry.id === "stimuli-settled");
    assert.ok(check !== undefined, "the stimuli check must exist");
    assert.equal(
      check.ok,
      true,
      "a gate exclusion is not an unsettled stimulus"
    );
    assert.ok(
      check.detail.includes("gate failure"),
      `the exclusion must stay visible; got: ${JSON.stringify(check.detail)}`
    );
  });

  it("fails evidence-complete when an attempt retained incomplete evidence", () => {
    const report = evaluateChecks(
      cleanInput({
        evidence: [
          assessment("failed", [
            { code: "missing-blob", detail: "1 blob absent" },
          ]),
        ],
      })
    );

    assert.ok(
      report.failedCheckIds.includes("evidence-complete"),
      `expected evidence-complete to fail; got: ${JSON.stringify(report.failedCheckIds)}`
    );
  });

  it("fails protocol-compliance when a protocol clause was violated", () => {
    const report = evaluateChecks(
      cleanInput({
        protocol: {
          frozenBeforeAnyOutcome: true,
          oneAttemptPerSlot: false,
          noRetries: true,
          originalGraderUsed: true,
        },
      })
    );

    assert.ok(
      report.failedCheckIds.includes("protocol-compliance"),
      `expected protocol-compliance to fail; got: ${JSON.stringify(report.failedCheckIds)}`
    );
    const check = report.checks.find(
      (entry) => entry.id === "protocol-compliance"
    );
    assert.ok(
      check?.detail.includes("oneAttemptPerSlot"),
      `the violated clause must be named; got: ${JSON.stringify(check?.detail)}`
    );
  });

  it("prevents an unconditional usable verdict when any required check fails", () => {
    for (const overrides of [
      { unfinishedAttempts: 1 },
      { tornLedgerLines: 2 },
      { settledStimuli: 0 },
      {
        evidence: [
          assessment("failed", [
            { code: "broken-reference", detail: "1 broken" },
          ]),
        ],
      },
      {
        protocol: {
          frozenBeforeAnyOutcome: false,
          oneAttemptPerSlot: true,
          noRetries: true,
          originalGraderUsed: true,
        },
      },
    ]) {
      const report = evaluateChecks(
        cleanInput(overrides as Partial<ChecksInput>)
      );

      assert.equal(
        isUnconditionallyUsable(report),
        false,
        `expected no unconditional verdict; failed: ${JSON.stringify(report.failedCheckIds)}`
      );
      assert.equal(
        usableVerdict(report),
        "not-usable",
        `expected not-usable; got ${JSON.stringify(report)}`
      );
    }
  });

  it("reports every failed check id, not only the first", () => {
    const report = evaluateChecks(
      cleanInput({
        unfinishedAttempts: 1,
        settledStimuli: 0,
        evidence: [
          assessment("failed", [
            { code: "parse-failure", detail: "1 parse failure" },
          ]),
        ],
      })
    );

    assert.equal(
      report.failedCheckIds.length,
      3,
      `expected three failures; got: ${JSON.stringify(report.failedCheckIds)}`
    );
  });
});

function assessment(
  status: "complete" | "failed",
  failures: ReadonlyArray<EvidenceFailure>
): EvidenceAssessment {
  return {
    status,
    failures,
    outcome: { reward: "1", graderExit: 0 },
    integrityOnlyNote: "note",
  };
}

const CLEAN_PROTOCOL = {
  frozenBeforeAnyOutcome: true,
  oneAttemptPerSlot: true,
  noRetries: true,
  originalGraderUsed: true,
} as const;

/**
 * A run that measured NOTHING must never read green (review defect, High).
 *
 * Why it matters: every required check is an equality or an emptiness test over what the run
 * produced, so a run that produced nothing satisfied all of them vacuously. An all-excluded run
 * reported `usable: true` / `unconditional: true` with zero tokens — the exact opposite of the
 * truth, and a direct violation of this module's own header contract that a `usable` verdict is
 * mechanically conditional on checks. There was no check that put a FLOOR under the run.
 */
describe("a run that measured nothing can never be usable", () => {
  function input(overrides: Partial<ChecksInput> = {}): ChecksInput {
    return {
      unfinishedAttempts: 0,
      tornLedgerLines: 0,
      declaredSlots: 2,
      attemptedStimuli: 0,
      acceptedStimuli: 0,
      settledStimuli: 0,
      evidence: [],
      protocol: CLEAN_PROTOCOL,
      gateFailures: 0,
      ...overrides,
    };
  }

  it("fails the floor check when the manifest declared slots but the run produced none", () => {
    const report = evaluateChecks(input());

    assert.equal(
      report.usable,
      false,
      `a void run is not usable; failed: ${JSON.stringify(report.failedCheckIds)}`
    );
    assert.ok(
      report.failedCheckIds.includes("run-measured"),
      `expected run-measured to fail; got: ${JSON.stringify(report.failedCheckIds)}`
    );
    assert.equal(
      isUnconditionallyUsable(report),
      false,
      "a void run may never be stated unconditionally"
    );
    assert.equal(
      usableVerdict(report),
      "not-usable",
      "the verdict must refuse a run that measured nothing"
    );
  });

  it("names the void in the run-measured detail rather than passing silently", () => {
    const report = evaluateChecks(input({ declaredSlots: 3 }));

    const check = report.checks.find((entry) => entry.id === "run-measured");
    assert.ok(check !== undefined, "the run-measured check must exist");
    assert.equal(
      check.ok,
      false,
      "3 declared slots and 0 attempts is a void run"
    );
    assert.ok(
      check.detail.includes("3") && check.detail.includes("0"),
      `the detail must state both counts; got: ${JSON.stringify(check.detail)}`
    );
  });

  it("fails the floor check when MORE stimuli settled than were accepted", () => {
    // The over-settlement half. `Math.min(settled, accepted)` used to absorb the excess, so a
    // protocol fault read as a clean match.
    const report = evaluateChecks(
      input({
        declaredSlots: 2,
        attemptedStimuli: 3,
        acceptedStimuli: 2,
        settledStimuli: 3,
      })
    );

    assert.equal(
      report.usable,
      false,
      "over-settlement is a protocol fault, not a clean match"
    );
    assert.ok(
      report.failedCheckIds.includes("run-measured"),
      `expected run-measured to fail; got: ${JSON.stringify(report.failedCheckIds)}`
    );
  });

  it("keeps a genuinely empty run legal when the manifest declares ZERO slots", () => {
    // The boundary the floor must NOT cross: a manifest with no slots has nothing to measure,
    // so there is nothing for the floor to fail. Only a declared-but-unmeasured run is the defect.
    const report = evaluateChecks(input({ declaredSlots: 0 }));

    assert.equal(
      report.usable,
      true,
      `an empty manifest is a complete run; failed: ${JSON.stringify(report.failedCheckIds)}`
    );
    assert.equal(
      usableVerdict(report),
      "usable",
      "a zero-slot manifest may state a usable verdict"
    );
  });

  it("keeps a partially measured run usable once at least one attempt settled", () => {
    const report = evaluateChecks(
      input({
        declaredSlots: 2,
        attemptedStimuli: 1,
        acceptedStimuli: 2,
        settledStimuli: 1,
        evidence: [assessment("complete", [])],
      })
    );

    assert.ok(
      !report.failedCheckIds.includes("run-measured"),
      `the floor is satisfied by any attempt; failed: ${JSON.stringify(report.failedCheckIds)}`
    );
    assert.ok(
      report.failedCheckIds.includes("stimuli-settled"),
      "the unsettled half of the list is still named by stimuli-settled"
    );
  });
});

/** A manifest whose identity fields match `identityFor`, so a retained gate record selects. */
function reportManifest(tasks: ReadonlyArray<string>): EvalManifest {
  return {
    runId: "run-1219",
    datasetCommit: "7131e4375048a0e408a8fb404b5f499d726b695b",
    bundleSha256:
      "1525d540457b0cb5a68535890eb2960319fcb4a25126c62b51273954ac1b27e7",
    nodeArchiveSha256:
      "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    runnerVersion: "tb2.1-attempt/1",
    outputLayout: "trace/ logs/ process/ meta/",
    frozenBeforeAnyOutcome: true,
    slots: tasks.map((task) => ({
      task,
      image: "python:3.11-slim",
      imageDigest: "sha256:aaa111",
      maxTurns: 40,
      arm: "arm40",
    })),
  };
}

interface ReportRun {
  readonly runRoot: string;
  readonly ledgerPath: string;
  readonly manifest: EvalManifest;
}

/** A run root plus its ledger path — the on-disk world `buildReport` reads. */
function reportRun(tasks: ReadonlyArray<string>): ReportRun {
  const runRoot = tempRoot("checks-floor");
  return {
    runRoot,
    ledgerPath: join(runRoot, "ledger.jsonl"),
    manifest: reportManifest(tasks),
  };
}

/** A real `EXCLUDE:glibcxx` gate decision, timestamped so two calls get distinct attempt ids. */
function gateExcludeDecision(
  slot: DriverSlot,
  recordedAtEpochMs: number
): GateDecision {
  return decisionFromRecord({
    identity: identityFor({ task: slot.task }),
    verdict: "EXCLUDE:glibcxx",
    reasons: ["glibcxx_measured=GLIBCXX_3.4.30"],
    measurement: {
      glibcxxMeasured: "GLIBCXX_3.4.30",
      bundleGlibcxxFloor: "GLIBCXX_3.4.31",
      runnerWiringOk: true,
      graderExit: 0,
      oracleReward: "1",
      ctrfBytes: 2878,
      resultLine: "7 passed",
      networkFailureMarker: false,
    },
    recordedAtEpochMs,
  });
}

/** Record one gate outcome through the production retention path (record + ledger row). */
function recordGateOutcomeFor(
  run: ReportRun,
  slot: DriverSlot,
  recordedAtEpochMs: number
): void {
  retainGateOutcome(
    {
      runRoot: run.runRoot,
      ledgerPath: run.ledgerPath,
      bundlePath: join(run.runRoot, "bundle.tgz"),
      settingsPath: join(run.runRoot, "settings.json"),
      identityFor: (target) => identityFor({ task: target.task }),
    },
    slot,
    gateExcludeDecision(slot, recordedAtEpochMs)
  );
}

/** Derive the report the CLI would emit for this run root, with no loop re-run. */
function reportFor(run: ReportRun): RunReport {
  return buildReport({
    mode: "report-only",
    ledgerPath: run.ledgerPath,
    runRoot: run.runRoot,
    manifest: run.manifest,
    identityFor: (slot) => identityFor({ task: slot.task }),
    ceiling: null,
    exit: null,
  });
}

function checkById(report: RunReport, id: string) {
  const check = report.checks.checks.find((entry) => entry.id === id);
  assert.ok(check !== undefined, `the ${id} check must exist in the report`);
  return check;
}

/**
 * Report-level regressions for the two review defects, built through the REAL writers so the
 * ledger rows are the shape production writes.
 */
describe("a report may not hide a void run or charge gate rows as attempts", () => {
  it("refuses `usable` for a run whose every declared slot was gate-excluded", () => {
    // The defect end to end: one declared slot, excluded by the gate, zero attempts.
    const run = reportRun(["sqlite-wal-mode"]);
    const slot = driverSlotsOf(run.manifest)[0]!;
    recordGateOutcomeFor(run, slot, 1_700_000_000_000);

    const report = reportFor(run);

    assert.equal(
      report.denominator.attempted,
      0,
      "the exclusion must not be counted as an attempt"
    );
    assert.equal(
      report.checks.usable,
      false,
      `a run that measured nothing may not be usable; failed: ${JSON.stringify(report.checks.failedCheckIds)}`
    );
    assert.equal(
      report.checks.verdict,
      "not-usable",
      "the verdict must refuse a run that measured nothing"
    );
    assert.equal(
      report.checks.unconditional,
      false,
      "an unmeasured run may never be stated unconditionally"
    );
    assert.ok(
      report.checks.failedCheckIds.includes("run-measured" as never),
      `expected run-measured to fail; got: ${JSON.stringify(report.checks.failedCheckIds)}`
    );
  });

  it("does not count a re-gated slot as two attempts (restart scenario)", () => {
    // The restart the issue requires supporting: one slot gated twice in one run root, each
    // outcome carrying a FRESH synthetic attempt id, and zero model attempts. Before the fix
    // `attemptsPerSlot` saw both ids as two attempts, so `protocol-compliance` failed
    // `oneAttemptPerSlot` with no re-drive possible.
    const run = reportRun(["db-wal-recovery"]);
    const slot = driverSlotsOf(run.manifest)[0]!;
    recordGateOutcomeFor(run, slot, 1_700_000_000_000);
    recordGateOutcomeFor(run, slot, 1_700_000_500_000);

    const report = reportFor(run);

    assert.equal(
      report.denominator.attempted,
      0,
      "a gate record is never an attempt"
    );
    const check = checkById(report, "protocol-compliance");
    assert.equal(
      check.ok,
      true,
      `gate rows must stay in the gate bucket; got: ${JSON.stringify(check.detail)}`
    );
  });

  it("does not count a re-gated slot as two settlements (noRetries clause)", () => {
    // The second predicate, pinned separately: a gate row settled twice under one attempt id
    // used to read as `noRetries` violated, again blaming a slot that never dispatched a model.
    const run = reportRun(["db-wal-recovery"]);
    const slot = driverSlotsOf(run.manifest)[0]!;
    recordGateOutcomeFor(run, slot, 1_700_000_000_000);
    recordGateOutcomeFor(run, slot, 1_700_000_000_000);

    const report = reportFor(run);

    const check = checkById(report, "protocol-compliance");
    assert.equal(
      check.ok,
      true,
      `gate rows must not be settlements; got: ${JSON.stringify(check.detail)}`
    );
  });
});
