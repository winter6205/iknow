/**
 * Contract tests for `scripts/eval/tui/stop-policy.ts` (#1219).
 *
 * WHY: run3 ended with `pty_eof`, `exit_status {code:143}`, `died_at_rel_s:null`
 * and NO quit record, and the old driver reported it as a run that had simply
 * ended. A forced stop dressed as a clean completion is the most expensive
 * defect in the set: it converts "we never finished" into "it worked". These
 * cases make the stop cause mandatory and keep `forced` structurally unable to
 * satisfy a natural-stop verdict.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  classifyStop,
  decideStop,
  type ExitStatus,
} from "../../../../scripts/eval/tui/stop-policy.ts";

const CLEAN: ExitStatus = {
  exited: true,
  code: 0,
  signaled: false,
  signal: null,
  detectedBy: "waitpid",
};

const HISTORICAL_TEARDOWN: ExitStatus = {
  exited: true,
  code: 143,
  signaled: false,
  signal: null,
  detectedBy: "teardown-waitpid",
};

const SETTLED = {
  requiredTags: ["S1", "S2"],
  acceptedTags: ["S1", "S2"],
  settledTags: ["S1", "S2"],
};

describe("classifyStop — the stop cause is never inferred", () => {
  it("is clean_quit only when /quit was sent and the process exited 0", () => {
    assert.equal(
      classifyStop({
        quitSent: true,
        exit: CLEAN,
        wallExceeded: false,
        forced: false,
      }),
      "clean_quit" as const
    );
  });

  it("is process_exit when the process died without an observed /quit (the run3 shape)", () => {
    assert.equal(
      classifyStop({
        quitSent: false,
        exit: HISTORICAL_TEARDOWN,
        wallExceeded: false,
        forced: false,
      }),
      "process_exit" as const,
      `a code-143 teardown discovery with no quit record is not a clean quit; got: ${classifyStop({ quitSent: false, exit: HISTORICAL_TEARDOWN, wallExceeded: false, forced: false })}`
    );
  });

  it("is wall_timeout when the inner wall was exhausted", () => {
    assert.equal(
      classifyStop({
        quitSent: true,
        exit: CLEAN,
        wallExceeded: true,
        forced: false,
      }),
      "wall_timeout" as const,
      "a wall exhaustion outranks the exit code; evidence is retained and the stop is classified"
    );
  });

  it("is forced when the harness terminated the child", () => {
    assert.equal(
      classifyStop({
        quitSent: true,
        exit: null,
        wallExceeded: false,
        forced: true,
      }),
      "forced" as const
    );
  });

  it("is unproven when nothing was observed at all", () => {
    assert.equal(
      classifyStop({
        quitSent: false,
        exit: null,
        wallExceeded: false,
        forced: false,
      }),
      "unproven" as const
    );
  });
});

describe("decideStop — natural completion requires settled evidence AND a clean exit", () => {
  it("is a natural stop only when every required stimulus is accepted, settled, past the horizon, and exited 0", () => {
    const decision = decideStop({
      ...SETTLED,
      quitSent: true,
      exit: CLEAN,
      lastSettledAtMs: 1000,
      nowMs: 1000 + 3000,
      horizonMs: 3000,
      wallExceeded: false,
      forced: false,
    });

    assert.equal(decision.cause, "clean_quit" as const);
    assert.equal(decision.natural, true);
    assert.deepEqual(decision.missing, []);
  });

  it("never lets a forced stop satisfy natural-stop acceptance", () => {
    const decision = decideStop({
      ...SETTLED,
      quitSent: true,
      exit: null,
      lastSettledAtMs: 1000,
      nowMs: 1000 + 3000,
      horizonMs: 3000,
      wallExceeded: false,
      forced: true,
    });

    assert.equal(decision.cause, "forced" as const);
    assert.equal(
      decision.natural,
      false,
      "a forced termination can never be reported as natural completion"
    );
    assert.equal(decision.usable, false);
  });

  it("never lets a wall timeout satisfy natural-stop acceptance", () => {
    const decision = decideStop({
      ...SETTLED,
      quitSent: false,
      exit: HISTORICAL_TEARDOWN,
      lastSettledAtMs: 1000,
      nowMs: 60_000,
      horizonMs: 3000,
      wallExceeded: true,
      forced: false,
    });

    assert.equal(decision.natural, false);
    assert.equal(decision.usable, false);
    assert.equal(decision.cause, "wall_timeout" as const);
  });

  it("lists the stimuli that are missing acceptance or settlement", () => {
    const decision = decideStop({
      requiredTags: ["S1", "S2"],
      acceptedTags: ["S1"],
      settledTags: ["S1"],
      quitSent: true,
      exit: CLEAN,
      lastSettledAtMs: 1000,
      nowMs: 1000 + 3000,
      horizonMs: 3000,
      wallExceeded: false,
      forced: false,
    });

    assert.equal(
      decision.cause,
      "clean_quit" as const,
      "the process did exit cleanly — the CAUSE is honest"
    );
    assert.equal(
      decision.natural,
      false,
      "but two of two stimuli were not accepted+settled, so it is not natural completion"
    );
    assert.deepEqual(decision.missing, ["accept:S2", "settle:S2"]);
    assert.equal(decision.usable, false);
  });

  it("holds the horizon before the stop is even allowed", () => {
    const decision = decideStop({
      ...SETTLED,
      quitSent: true,
      exit: CLEAN,
      lastSettledAtMs: 1000,
      nowMs: 1000 + 2999,
      horizonMs: 3000,
      wallExceeded: false,
      forced: false,
    });

    assert.ok(
      decision.missing.includes("horizon"),
      `the frozen horizon must be an explicit precondition; got: ${JSON.stringify(decision.missing)}`
    );
    assert.equal(decision.readyToStop, false);
  });

  it("reports unproven idle as a missing precondition rather than assuming it", () => {
    const decision = decideStop({
      ...SETTLED,
      quitSent: true,
      exit: CLEAN,
      lastSettledAtMs: 1000,
      nowMs: 1000 + 3000,
      horizonMs: 3000,
      wallExceeded: false,
      forced: false,
      idleProven: false,
    });

    assert.ok(
      decision.missing.includes("idle_proven"),
      `expected idle_proven; got: ${JSON.stringify(decision.missing)}`
    );
    assert.equal(decision.natural, false);
  });
});
