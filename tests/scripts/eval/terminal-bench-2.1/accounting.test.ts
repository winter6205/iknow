/**
 * Denominators, spend aggregation and ceiling semantics.
 *
 * Why this matters (issue 1219 requirement 2, required regression 6):
 *  - `validity()` was #1212's duplicated write-only label; rates were computed by hand.
 *    Here `attempted / valid / model-attributable / excluded` are DERIVED from the ledger.
 *  - Invalid and interrupted attempts must STAY visible in `attempted`; the #1212
 *    `runs-aborted/run2-missing-logs-mount` spend was in no ledger at all.
 *  - Cache tokens are spend. #1212's ceiling summed only input+output while
 *    `cache_read_input_tokens=179410` against `input_tokens=15645` went unsurfaced (11.5x).
 *  - Unknown usage is `unknown`, NOT zero, and must not permit further dispatch.
 */
import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";

import {
  aggregateSpend,
  ceilingVerdict,
  classifyAttempt,
  classifyValidity,
  computeDenominator,
  COUNTING_POLICY,
  type ValidityInput,
} from "../../../../scripts/eval/terminal-bench-2.1/accounting.ts";
import type {
  AttemptPhase,
  LedgerRow,
  UsageRecord,
} from "../../../../scripts/eval/terminal-bench-2.1/ledger.ts";
import { cleanupTempRoots } from "./fixtures.ts";

afterAll(cleanupTempRoots);

const VALID_EVIDENCE: ValidityInput = {
  ctrfBytes: 2878,
  resultLine: "7 passed",
  networkFailureMarker: false,
};

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 200,
    cacheReadInputTokens: 900,
    ...overrides,
  };
}

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    attemptId: "attempt-1",
    slotKey: "db-wal-recovery:arm40:40",
    task: "db-wal-recovery",
    arm: "arm40",
    maxTurns: 40,
    phase: "completed" as AttemptPhase,
    recordedAtEpochMs: 1_700_000_000_000,
    attemptStarted: true,
    modelDispatched: true,
    excluded: false,
    usage: usage(),
    reason: "",
    ...overrides,
  };
}

describe("validity classification (derived, never stored)", () => {
  it("accepts retained CTRF, a real result line and no network marker", () => {
    assert.equal(
      classifyValidity(VALID_EVIDENCE).label,
      "VALID",
      "all three clauses hold"
    );
  });

  it("names every failed clause rather than only the first", () => {
    const verdict = classifyValidity({
      ctrfBytes: 0,
      resultLine: "",
      networkFailureMarker: true,
    });

    assert.deepEqual(
      [...verdict.failedClauses],
      ["ctrf", "result_line", "no_network_marker"],
      `expected all three clauses; got: ${JSON.stringify(verdict.failedClauses)}`
    );
    assert.equal(
      verdict.label,
      "INVALID:ctrf,result_line,no_network_marker",
      "label must list them"
    );
  });

  it("rejects a result line that is not a real test count", () => {
    const verdict = classifyValidity({
      ...VALID_EVIDENCE,
      resultLine: "reward written",
    });

    assert.deepEqual(
      [...verdict.failedClauses],
      ["result_line"],
      `expected only result_line; got: ${JSON.stringify(verdict.failedClauses)}`
    );
  });

  it("treats an empty CTRF byte count as a failed clause, not as present", () => {
    assert.equal(
      classifyValidity({ ...VALID_EVIDENCE, ctrfBytes: 0 }).valid,
      false,
      "a zero-byte CTRF is not retained evidence"
    );
  });
});

describe("denominator construction (required regression 6)", () => {
  it("counts invalid and interrupted attempts inside attempted", () => {
    const rows = [
      row({ attemptId: "a-valid", phase: "completed" }),
      row({ attemptId: "a-invalid", phase: "invalid", reason: "ctrf lost" }),
      row({
        attemptId: "a-interrupted",
        phase: "interrupted",
        reason: "SIGKILL",
      }),
    ];
    const evidence = new Map<string, ValidityInput>([
      ["a-valid", VALID_EVIDENCE],
      [
        "a-invalid",
        { ctrfBytes: 0, resultLine: "7 passed", networkFailureMarker: false },
      ],
      ["a-interrupted", VALID_EVIDENCE],
    ]);

    const denominator = computeDenominator(rows, evidence);

    assert.equal(
      denominator.attempted,
      3,
      "an interrupted attempt is still an attempted attempt"
    );
    assert.equal(denominator.valid, 1, "only fully proven attempts are valid");
    assert.equal(denominator.invalid, 1, "the lost-CTRF attempt is invalid");
    assert.equal(
      denominator.interrupted,
      1,
      "the killed attempt is interrupted"
    );
    assert.deepEqual(
      [
        denominator.valid + denominator.invalid + denominator.interrupted,
        denominator.attempted,
      ],
      [3, 3],
      "attempted must equal the sum of its classes"
    );
  });

  it("counts an unfinished intent row as an attempted interrupted attempt", () => {
    const rows = [
      row({ attemptId: "a-killed", phase: "intent", reason: "runner killed" }),
    ];
    const denominator = computeDenominator(
      rows,
      new Map([["a-killed", VALID_EVIDENCE]])
    );

    assert.equal(
      denominator.attempted,
      1,
      "a driver killed mid-dispatch must still be counted"
    );
    assert.equal(
      denominator.interrupted,
      1,
      "an intent with no finalization is interrupted"
    );
  });

  it("separates model-attributable attempts from attempts that never dispatched", () => {
    const rows = [
      row({ attemptId: "a-dispatched", modelDispatched: true }),
      row({
        attemptId: "a-pre-dispatch",
        modelDispatched: false,
        phase: "invalid",
      }),
    ];
    const evidence = new Map([
      ["a-dispatched", VALID_EVIDENCE],
      [
        "a-pre-dispatch",
        { ctrfBytes: 0, resultLine: "", networkFailureMarker: false },
      ],
    ]);

    const denominator = computeDenominator(rows, evidence);

    assert.equal(denominator.attempted, 2, "both attempts were started");
    assert.equal(
      denominator.modelAttributable,
      1,
      "only the attempt that dispatched a model can be blamed on model behaviour"
    );
  });

  it("keeps explicit preflight exclusions out of attempted but visible as excluded", () => {
    const rows = [
      row({ attemptId: "a-ok" }),
      row({
        attemptId: "a-excluded",
        excluded: true,
        modelDispatched: false,
        usage: null,
        reason: "gate:EXCLUDE:glibcxx",
      }),
    ];

    const denominator = computeDenominator(
      rows,
      new Map([["a-ok", VALID_EVIDENCE]])
    );

    assert.equal(
      denominator.attempted,
      1,
      "an exclusion never dispatched and is not an attempt"
    );
    assert.equal(
      denominator.excluded,
      1,
      "the exclusion must stay visible in its own bucket"
    );
    assert.equal(
      denominator.gateFailures,
      1,
      "a pre-dispatch gate failure is counted separately"
    );
  });

  it("reports zero attempts for an empty ledger without inventing rows", () => {
    const denominator = computeDenominator([], new Map());

    assert.equal(denominator.attempted, 0, "an empty ledger has no attempts");
    assert.equal(denominator.valid, 0, "an empty ledger has no valid attempts");
    assert.equal(
      denominator.policyId,
      COUNTING_POLICY.policyId,
      "the frozen policy must be named"
    );
  });

  it("names the counting policy that was frozen before the next run", () => {
    assert.equal(
      COUNTING_POLICY.frozenBeforeNextRun,
      true,
      "the policy must be frozen"
    );
    assert.equal(
      COUNTING_POLICY.unknownUsageIsNotZero,
      true,
      "unknown must never be zero"
    );
    assert.equal(
      COUNTING_POLICY.unknownUsageBlocksDispatch,
      true,
      "unknown usage must block further dispatch"
    );
    assert.equal(
      COUNTING_POLICY.ceilingsEnforcedLive,
      false,
      "ceilings are observed between attempts, which must be disclosed rather than implied"
    );
  });
});

describe("spend aggregation", () => {
  it("sums cache tokens as spend across all four counters", () => {
    const totals = aggregateSpend([
      row({
        attemptId: "a",
        usage: usage({
          inputTokens: 15645,
          outputTokens: 2000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 179410,
        }),
      }),
    ]);

    assert.equal(
      totals.cacheReadInputTokens,
      179410,
      "cache reads must be surfaced, not dropped"
    );
    assert.equal(
      totals.totalTokens,
      15645 + 2000 + 0 + 179410,
      "the total must include cache reads, unlike the #1212 input+output-only ceiling"
    );
  });

  it("aggregates spend from invalid and interrupted attempts as well as valid ones", () => {
    const rows = [
      row({
        attemptId: "a-valid",
        usage: usage({
          inputTokens: 10,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }),
      }),
      row({
        attemptId: "a-invalid",
        phase: "invalid",
        usage: usage({
          inputTokens: 20,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }),
      }),
      row({
        attemptId: "a-interrupted",
        phase: "interrupted",
        usage: usage({
          inputTokens: 30,
          outputTokens: 3,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }),
      }),
    ];

    const totals = aggregateSpend(rows);

    assert.equal(
      totals.inputTokens,
      60,
      "an invalid attempt still spent input tokens"
    );
    assert.equal(
      totals.outputTokens,
      6,
      "an interrupted attempt still spent output tokens"
    );
  });

  it("reports an excluded attempt as zero spend because it never dispatched", () => {
    const totals = aggregateSpend([
      row({ attemptId: "a-excluded", excluded: true, usage: usage() }),
    ]);

    assert.equal(
      totals.totalTokens,
      0,
      "an exclusion dispatched no model and spent nothing"
    );
  });

  it("counts an UNSETTLED intent row as unknown usage rather than skipping it", () => {
    // The #1212 hole: a driver killed mid-attempt left real tokens and no row, so a
    // spend-only reader saw a clean budget. Skipping the unsettled intent here would
    // report that killed run as having COMPLETE usage.
    const rows = [
      row({ attemptId: "a-killed", phase: "intent", usage: null, reason: "" }),
      row({ attemptId: "a-settled", phase: "completed", usage: usage() }),
    ];

    const totals = aggregateSpend(rows);

    assert.deepEqual(
      [...totals.unknownUsageAttempts],
      ["a-killed"],
      `the killed attempt must be unknown usage; got: ${JSON.stringify(totals.unknownUsageAttempts)}`
    );
    assert.equal(
      totals.usageComplete,
      false,
      "usage must be reported incomplete"
    );
  });

  it("counts a settled attempt's usage once even though it has both an intent and a finalization row", () => {
    const rows = [
      row({ attemptId: "a", phase: "intent", usage: null }),
      row({
        attemptId: "a",
        phase: "completed",
        usage: usage({
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }),
      }),
    ];

    const totals = aggregateSpend(rows);

    assert.equal(
      totals.inputTokens,
      100,
      "the intent row must not add a second, unknown usage"
    );
    assert.equal(
      totals.usageComplete,
      true,
      "a settled attempt has known usage"
    );
  });

  it("records unknown usage instead of silently reading it as zero", () => {
    const totals = aggregateSpend([
      row({ attemptId: "a-unknown", usage: null }),
    ]);

    assert.deepEqual(
      [...totals.unknownUsageAttempts],
      ["a-unknown"],
      `expected the attempt to be listed as unknown; got: ${JSON.stringify(totals.unknownUsageAttempts)}`
    );
    assert.equal(
      totals.usageComplete,
      false,
      "usage must be reported incomplete"
    );
  });
});

describe("ceiling semantics against unknown usage (required regression 6)", () => {
  it("refuses further dispatch when any attempt's usage is unknown", () => {
    const spend = aggregateSpend([
      row({ attemptId: "a-known", usage: usage() }),
      row({ attemptId: "a-unknown", usage: null }),
    ]);

    const verdict = ceilingVerdict(spend, usage());

    assert.equal(
      verdict.mayDispatch,
      false,
      "unknown usage must not permit further dispatch"
    );
    assert.ok(
      verdict.reason.includes("unknown is not zero"),
      `reason must state the policy; got: ${JSON.stringify(verdict.reason)}`
    );
  });

  it("permits dispatch while usage stays complete and under the claimed budget", () => {
    const spend = aggregateSpend([
      row({
        attemptId: "a",
        usage: usage({
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }),
      }),
    ]);

    const verdict = ceilingVerdict(spend, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    assert.equal(
      verdict.mayDispatch,
      true,
      "a complete, in-budget run may continue"
    );
    assert.equal(
      verdict.enforcement,
      "observed-between-attempts",
      "enforcement mode must be stated"
    );
  });

  it("counts cache tokens toward the claimed budget", () => {
    const underInputOutputOnly = aggregateSpend([
      row({
        attemptId: "a",
        usage: usage({
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 999_000,
        }),
      }),
    ]);

    const verdict = ceilingVerdict(underInputOutputOnly, {
      inputTokens: 1000,
      outputTokens: 1000,
    });

    assert.equal(
      verdict.mayDispatch,
      false,
      "999k cache reads must consume the budget; an input+output-only sum would have allowed this"
    );
  });

  it("discloses that ceilings are observed between attempts and can overshoot", () => {
    const verdict = ceilingVerdict(aggregateSpend([row()]), usage());

    assert.equal(
      verdict.overshootNote.includes("in-flight"),
      true,
      `the in-flight overshoot must be disclosed; got: ${JSON.stringify(verdict.overshootNote)}`
    );
  });
});

describe("attempt classification", () => {
  it("classifies an interrupted phase as interrupted regardless of evidence", () => {
    assert.equal(
      classifyAttempt(row({ phase: "interrupted" }), VALID_EVIDENCE),
      "interrupted",
      "a killed attempt is not valid"
    );
  });

  it("classifies a completed phase with failed evidence as invalid", () => {
    assert.equal(
      classifyAttempt(row({ phase: "completed" }), {
        ctrfBytes: 0,
        resultLine: "7 passed",
        networkFailureMarker: false,
      }),
      "invalid",
      "reward cannot rescue a completed attempt with no retained CTRF"
    );
  });

  it("classifies a completed phase with full evidence as valid", () => {
    assert.equal(
      classifyAttempt(row({ phase: "completed" }), VALID_EVIDENCE),
      "valid",
      "all clauses hold"
    );
  });

  it("classifies an excluded row as excluded rather than as an attempt", () => {
    assert.equal(
      classifyAttempt(row({ excluded: true }), VALID_EVIDENCE),
      "excluded",
      "an exclusion is not a task outcome"
    );
  });
});
