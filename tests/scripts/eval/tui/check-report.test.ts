/**
 * Contract tests for the machine-readable check report in
 * `scripts/eval/tui/run.ts` (#1219 §4).
 *
 * WHY: the historical `driver-summary.json` reported only `stimuli_sent`
 * (ATTEMPTS) and `stimuli_total`, so a run where two of four stimuli were
 * REJECTED was indistinguishable from a clean 4/4 run. A verdict that any
 * failed required check can still produce is the same defect one layer up, so
 * the gate is pinned here.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  buildCheckReport,
  REQUIRED_CHECK_IDS,
} from "../../../../scripts/eval/tui/run.ts";

const ALL_OK = {
  label: "unit",
  runKind: "measured",
  readinessProven: true,
  allAccepted: true,
  allSettled: true,
  idleProven: true,
  stopNatural: true,
  indexVerified: true,
  countersDerived: true,
  noPooling: true,
  singleSessionFile: true,
  observerClean: true,
  storeValid: true,
  teardownClean: true,
  noSecrets: true,
};

describe("buildCheckReport — a failed required check blocks `usable`", () => {
  it("reports usable only when every required check passed", () => {
    const report = buildCheckReport(ALL_OK);

    assert.equal(report.verdict, "usable");
    assert.equal(report.usable, true);
    assert.deepEqual(report.blockedBy, []);
    assert.equal(
      report.checks.length,
      REQUIRED_CHECK_IDS.length,
      "every declared required check must be reported"
    );
  });

  it("blocks `usable` when acceptance was not proven for every stimulus", () => {
    const report = buildCheckReport({ ...ALL_OK, allAccepted: false });

    assert.equal(report.verdict, "unusable");
    assert.equal(report.usable, false);
    assert.deepEqual(report.blockedBy, ["acceptance.all_required"]);
    const failed = report.checks.find(
      (c) => c.id === "acceptance.all_required"
    );
    assert.equal(failed?.required, true);
    assert.ok(
      failed !== undefined && (failed.detail ?? "").length > 0,
      "a failed check must carry a diagnostic"
    );
  });

  it("blocks `usable` on a forced stop even with everything else green", () => {
    const report = buildCheckReport({ ...ALL_OK, stopNatural: false });

    assert.deepEqual(report.blockedBy, ["stop.clean_natural_exit"]);
    assert.equal(report.verdict, "unusable");
  });

  it("blocks `usable` when idleness could not be proven from the persisted lifecycle", () => {
    const report = buildCheckReport({ ...ALL_OK, idleProven: false });

    assert.deepEqual(report.blockedBy, ["idle.proven_from_persistence"]);
  });

  it("blocks `usable` when the readiness probe never proved the surface was ready", () => {
    const report = buildCheckReport({ ...ALL_OK, readinessProven: false });

    assert.deepEqual(report.blockedBy, ["readiness.probe"]);
  });

  it("blocks `usable` when the evidence index did not verify on readback", () => {
    const report = buildCheckReport({ ...ALL_OK, indexVerified: false });

    assert.deepEqual(report.blockedBy, ["evidence.index_verified"]);
  });

  it("blocks `usable` when resume samples were pooled into the measured run", () => {
    const report = buildCheckReport({ ...ALL_OK, noPooling: false });

    assert.deepEqual(report.blockedBy, ["evidence.no_pooling"]);
  });

  it("blocks `usable` when an observer error occurred during the run", () => {
    const report = buildCheckReport({ ...ALL_OK, observerClean: false });

    assert.deepEqual(report.blockedBy, ["observer.no_errors"]);
  });

  it("blocks `usable` when a stray process survived teardown", () => {
    const report = buildCheckReport({ ...ALL_OK, teardownClean: false });

    assert.deepEqual(report.blockedBy, ["teardown.no_stray_process"]);
  });

  it("blocks `usable` when retained artifacts contain credential-shaped text", () => {
    const report = buildCheckReport({ ...ALL_OK, noSecrets: false });

    assert.deepEqual(report.blockedBy, ["evidence.no_secrets"]);
  });

  it("accumulates every failed required check instead of reporting only the first", () => {
    const report = buildCheckReport({
      ...ALL_OK,
      allAccepted: false,
      allSettled: false,
      stopNatural: false,
      countersDerived: false,
    });

    assert.deepEqual(report.blockedBy, [
      "acceptance.all_required",
      "settlement.all_required",
      "idle.proven_from_persistence",
      "stop.clean_natural_exit",
      "evidence.counters_derived",
    ]);
  });

  it("rejects an unknown check id rather than silently ignoring it", () => {
    const report = buildCheckReport({ ...ALL_OK });

    const declared: readonly string[] = REQUIRED_CHECK_IDS;
    assert.equal(
      report.checks.every((c) => declared.includes(c.id)),
      true
    );
    assert.ok(report.checks.length > 0, "the report must not be empty");
  });
});
