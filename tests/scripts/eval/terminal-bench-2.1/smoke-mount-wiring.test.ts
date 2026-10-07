/**
 * `mountsUnified` was the smoke's headline proof #1, and it could not fail.
 *
 * `smoke-oracle.ts` computed `deepEqual(preflightMounts(spec), sharedMounts(spec))` — but
 * `preflightMounts` in `runner.ts` is literally `return sharedMounts(spec)`. Comparing a
 * function with itself is a tautology that is structurally always `true`, so:
 *
 *   - the field was a measurement in name only, and
 *   - the severity-high "mount lists diverge" finding could NEVER fire, which means a run
 *     with genuinely drifted wiring published "none observed" — a false all-clear from the
 *     one report whose whole job is to describe the state of the instrument.
 *
 * `runner.ts` is owned elsewhere, so the smoke cannot change what `preflightMounts` does.
 * The fix is therefore to make the smoke's statement TRUE instead of dropping it: the run
 * compares the REAL `sharedMounts(spec)` against a mount list the smoke declares
 * independently, and the report says plainly that preflight/attempt identity is guaranteed
 * BY CONSTRUCTION (one function) rather than verified at run time.
 *
 * These tests pin the honesty of the CLAIM, including by reading the source: a tautology is
 * invisible in a rendered report, so the defect has to be pinned where it lives.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import {
  findingsFrom,
  NOTES,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-report.ts";
import {
  expectedMounts,
  mountWiringMatches,
} from "../../../../scripts/eval/terminal-bench-2.1/smoke-tasks.ts";
import { sharedMounts } from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import type { ProvisionSpec } from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import type { ValidityVerdict } from "../../../../scripts/eval/terminal-bench-2.1/accounting.ts";
import type { TaskVerdict } from "../../../../scripts/eval/terminal-bench-2.1/smoke-types.ts";

const VALID: ValidityVerdict = {
  valid: true,
  failedClauses: [],
  label: "VALID",
};

function verdict(overrides: Partial<TaskVerdict> = {}): TaskVerdict {
  return {
    task: "db-wal-recovery",
    image: "alexgshaw/db-wal-recovery:20251031",
    curlInImage: "ABSENT | /usr/bin/tar",
    mountsUnified: true,
    provisionExit: 0,
    bootVerified: true,
    logsMountWritable: true,
    glibcxxMeasured: "GLIBCXX_3.4.33",
    graderWallSec: 1500,
    graderExit: 0,
    reward: "0",
    hostReward: "0",
    hostCtrfBytes: 6475,
    resultLine: "7 failed",
    networkFailureMarker: false,
    validity: VALID,
    gateVerdict: "EXCLUDE:oracle-or-grader",
    gateReasons: [],
    retainedFiles: ["logs/verifier/reward.txt"],
    passed: true,
    failures: [],
    ...overrides,
  };
}

function sourceOf(module: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(
        `../../../../scripts/eval/terminal-bench-2.1/${module}`,
        import.meta.url
      )
    ),
    "utf8"
  );
}

describe("the smoke no longer measures the attempt mount list against itself", () => {
  it("never compares preflightMounts(spec) with sharedMounts(spec)", () => {
    const source = sourceOf("smoke-oracle.ts");

    assert.doesNotMatch(
      source,
      /import \{[^}]*preflightMounts[^}]*\} from "\.\/runner\.js"/s,
      "importing the delegating function is how the tautology got in; it must not be a dependency of the oracle case"
    );
    assert.doesNotMatch(
      source,
      /preflightMounts\(/,
      `preflightMounts(spec) is sharedMounts(spec), so calling it can only reproduce the list it is compared against; source: ${source.match(/.*preflightMounts.*/g)?.join(" | ")}`
    );
    assert.match(
      source,
      /mountWiringMatches\(sharedMounts\(spec\), spec\)/,
      "the real list must be measured against the independently declared one"
    );
  });

  it("keeps reporting the wiring as a finding, because the detector still matters", () => {
    const findings = findingsFrom([verdict({ mountsUnified: false })]);

    assert.equal(
      findings.length,
      1,
      `a run whose real mount list drifted must still publish a finding; got: ${JSON.stringify(findings)}`
    );
    assert.equal(
      findings[0]?.severity,
      "high",
      "a drifted /logs bind mount is the #1212 A4 fault and stays high severity"
    );
  });
});

describe("the report states which mount claim is guaranteed and which is measured", () => {
  it("no longer claims the preflight list diverges from the attempt list", () => {
    const text = findingsFrom([verdict({ mountsUnified: false })])
      .map((finding) => `${finding.where} ${finding.finding}`)
      .join(" ");

    assert.doesNotMatch(
      text,
      /preflight/i,
      `there is no preflight list to diverge: preflightMounts IS sharedMounts, so this finding text asserts a comparison the run does not make; got: ${text}`
    );
    assert.match(
      text,
      /sharedMounts/,
      `the finding must still name the function that actually builds the mounts; got: ${text}`
    );
    assert.match(
      text,
      /declar/i,
      `the finding must name the independent list the real one is measured against, so a reader knows what "unified" means; got: ${text}`
    );
  });

  it("tells the reader that preflight/attempt identity is by construction, not verified", () => {
    const notes = NOTES.join(" ");

    assert.match(
      notes,
      /by construction/i,
      `the report must say where mount identity comes from, or a reader takes a tautology for a measurement; notes: ${notes}`
    );
    assert.match(
      notes,
      /same `?sharedMounts`?|one mount list|same function/i,
      `the guarantee is that both plans come from ONE function; notes: ${notes}`
    );
    assert.match(
      notes,
      /declar/i,
      `the report must also name what IS measured, i.e. the independently declared list; notes: ${notes}`
    );
  });
});

/**
 * The replacement measurement, written as its own contract: an INDEPENDENT declaration of the
 * wiring the attempt is supposed to get, compared against the list `sharedMounts` really
 * builds. It is falsifiable in both directions, which is exactly what the tautology was not.
 *
 * The declaration is pinned here in the test's own words, so a `sharedMounts` change and an
 * `expectedMounts` change that agree with each other still fail: the two must not drift into
 * the same mistake together.
 */
function spec(outDir = "/out/graded/db-wal-recovery"): ProvisionSpec {
  return {
    identity: {
      runId: "1219-smoke-tb21-1",
      task: "db-wal-recovery",
      image: "alexgshaw/db-wal-recovery:20251031",
      imageDigest:
        "sha256:unresolved-local-tag:alexgshaw/db-wal-recovery:20251031",
      datasetCommit: "sha256:unresolved-local-dataset",
      bundleSha256: "b".repeat(64),
      nodeArchiveSha256: "a".repeat(64),
      runnerVersion: "tb2.1-docker/1",
      outputLayout: "smoke/out=/out",
    },
    taskDir: "/dataset/tasks/db-wal-recovery",
    outDir,
    bundlePath: "/bundle.tgz",
    nodeArchivePath: "/node-dist.tar.gz",
    settingsPath: "/out/meta/smoke-settings.json",
  };
}

const DECLARED_WIRING = [
  {
    hostPath: "/dataset/tasks/db-wal-recovery/tests",
    containerPath: "/tests",
    readOnly: true,
  },
  {
    hostPath: "/out/graded/db-wal-recovery/logs",
    containerPath: "/logs",
    readOnly: false,
  },
  {
    hostPath: "/bundle.tgz",
    containerPath: "/opt/iknow-bundle.tgz",
    readOnly: true,
  },
  {
    hostPath: "/node-dist.tar.gz",
    containerPath: "/opt/node-dist.tar.gz",
    readOnly: true,
  },
  {
    hostPath: "/out/graded/db-wal-recovery",
    containerPath: "/artifacts",
    readOnly: false,
  },
];

describe("the declared wiring is an independent list, in the test's own words", () => {
  it("declares the /tests, /logs, bundle, node and /artifacts mounts the run depends on", () => {
    assert.deepEqual(
      expectedMounts(spec()),
      DECLARED_WIRING,
      "the declaration is the smoke's own statement of the wiring; if it no longer matches these words, that change needs its own justification"
    );
  });

  it("mounts /logs read-write, because the graders write their verdict there", () => {
    const logs = expectedMounts(spec()).find(
      (mount) => mount.containerPath === "/logs"
    );

    assert.ok(
      logs,
      "the /logs bind mount is load-bearing and must be declared"
    );
    assert.equal(
      logs.readOnly,
      false,
      "a read-only /logs would make every task's grader write to a dead path, silently"
    );
  });
});

describe("the measurement can fail, which is the whole point of replacing the tautology", () => {
  it("agrees with the real mount list for an unwired spec", () => {
    const current = spec();

    assert.equal(
      mountWiringMatches(sharedMounts(current), current),
      true,
      "the real list and the declared list must agree on a healthy runner"
    );
  });

  it("fails when the real list drops the /logs bind mount", () => {
    const current = spec();
    const drifted = sharedMounts(current).filter(
      (mount) => mount.containerPath !== "/logs"
    );

    assert.equal(
      mountWiringMatches(drifted, current),
      false,
      "this is the #1212 A4 fault; under the old tautology it was reported as unified"
    );
  });

  it("fails when a declared mount is turned read-only", () => {
    const current = spec();
    const drifted = sharedMounts(current).map((mount) =>
      mount.containerPath === "/logs" ? { ...mount, readOnly: true } : mount
    );

    assert.equal(
      mountWiringMatches(drifted, current),
      false,
      "a read-only /logs breaks every grader write, so the comparison must see it"
    );
  });

  it("fails when the real list drops a mount the run does not read as optional", () => {
    const current = spec();
    const drifted = sharedMounts(current).slice(0, 4);

    assert.equal(
      mountWiringMatches(drifted, current),
      false,
      "a shorter list is a different list, and a shorter list is the drift this watches for"
    );
  });

  it("follows the output directory, so a renamed mount source is still measured", () => {
    const moved = spec("/out/graded/other-task");

    assert.equal(
      mountWiringMatches(sharedMounts(moved), moved),
      true,
      `the declaration must be derived from the spec, not hardcoded; got: ${JSON.stringify(expectedMounts(moved))}`
    );
    assert.equal(
      expectedMounts(moved)[1]?.hostPath,
      "/out/graded/other-task/logs",
      "the /logs source is the attempt directory: pin it, or the declaration drifts from the runner"
    );
  });
});
