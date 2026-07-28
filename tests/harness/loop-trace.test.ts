/**
 * 017 A7 LoopTrace.computeTotals:run 结束时一次性从 turns reduce 出来的纯函数。
 *
 * 验证空输入全零,以及混合 fixture 下各 totals 字段精确求和。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { computeTotals } from "../../src/harness/loop-trace.ts";
import type { TurnTrace } from "../../src/harness/loop-trace.ts";

describe("loop-trace computeTotals", () => {
  it("returns all-zero Totals for empty input", () => {
    const t = computeTotals([]);
    assert.equal(t.totalDurationMs, 0);
    assert.equal(t.timeoutHits, 0);
    assert.equal(t.signalAborteds, 0);
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
        timeoutHit: false,
        signalAborted: false,
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
        timeoutHit: true,
        signalAborted: false,
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
        timeoutHit: false,
        signalAborted: true,
      },
    ];
    const totals = computeTotals(turns);
    assert.equal(totals.totalDurationMs, 120 + 80 + 200);
    assert.equal(totals.timeoutHits, 1);
    assert.equal(totals.signalAborteds, 1);
    assert.equal(totals.toolErrorTotals.ok, 2);
    assert.equal(totals.toolErrorTotals.validation_failed, 1);
    assert.equal(totals.toolErrorTotals.tool_not_found, 1);
    assert.equal(totals.toolErrorTotals.execution_failed, 1);
  });
});
