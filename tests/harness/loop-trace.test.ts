/**
 * LoopTrace.computeTotals: a pure function reducing over turns once at run end.
 *
 * Verifies all-zero totals for empty input and exact per-field sums over a
 * mixed fixture.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { computeTotals } from "../../src/harness/loop-trace.ts";
import type { TurnTrace } from "../../src/harness/loop-trace.ts";

describe("loop-trace computeTotals", () => {
  it("returns all-zero Totals for empty input", () => {
    const t = computeTotals([]);
    assert.equal(t.totalDurationMs, 0);
    assert.equal(t.cancelKindCounts.none, 0);
    assert.equal(t.cancelKindCounts.callerAbort, 0);
    assert.equal(t.cancelKindCounts.timerTimeout, 0);
    assert.equal(t.cancelKindCounts.hostCancel, 0);
    assert.equal(t.toolErrorTotals.ok, 0);
    assert.equal(t.toolErrorTotals.validation_failed, 0);
    assert.equal(t.toolErrorTotals.tool_not_found, 0);
    assert.equal(t.toolErrorTotals.execution_failed, 0);
  });

  it("aggregates mixed-turn fixture across every field exactly", () => {
    const turns: ReadonlyArray<TurnTrace> = [
      {
        turnIndex: 0,
        supplierStop: "success",
        toolCalls: [
          { toolUseId: "t1", toolName: "echo", kind: "ok" },
          {
            toolUseId: "t2",
            toolName: "missing",
            kind: "tool_not_found",
            message: "not registered",
          },
        ],
        durationMs: 120,
        cancelKind: "none",
      },
      {
        turnIndex: 1,
        supplierStop: "truncation",
        toolCalls: [
          {
            toolUseId: "t3",
            toolName: "echo",
            kind: "validation_failed",
            message: "bad input",
          },
        ],
        durationMs: 80,
        cancelKind: "timerTimeout",
      },
      {
        turnIndex: 2,
        supplierStop: "refusal",
        toolCalls: [
          {
            toolUseId: "t4",
            toolName: "boom",
            kind: "execution_failed",
            message: "kaboom",
          },
          { toolUseId: "t5", toolName: "echo", kind: "ok" },
        ],
        durationMs: 200,
        cancelKind: "callerAbort",
      },
    ];
    const totals = computeTotals(turns);
    assert.equal(totals.totalDurationMs, 120 + 80 + 200);
    assert.equal(totals.cancelKindCounts.timerTimeout, 1);
    assert.equal(totals.cancelKindCounts.callerAbort, 1);
    assert.equal(totals.cancelKindCounts.none, 1);
    assert.equal(totals.cancelKindCounts.hostCancel, 0);
    assert.equal(totals.toolErrorTotals.ok, 2);
    assert.equal(totals.toolErrorTotals.validation_failed, 1);
    assert.equal(totals.toolErrorTotals.tool_not_found, 1);
    assert.equal(totals.toolErrorTotals.execution_failed, 1);
  });
});
