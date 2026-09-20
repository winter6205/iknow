/**
 * Unit tests for the overflow-governance judge (pure logic) — ADR-0043 §3.
 *
 * Four invariants:
 *   1. **Below threshold** (countTokens total <= threshold) → all deferrable
 *      built-ins stay resident (no `lazy: true` stamp); core tools never
 *      participate (never retired).
 *   2. **Over threshold** (countTokens total > threshold) → retire one tool
 *      at a time in retirement order (large surface × low frequency),
 *      recomputing countTokens after each, exiting when <= threshold or
 *      nothing is left to retire.
 *   3. **Core tools are never retired** (bash / read_file / edit_file /
 *      write_file / grep / glob / spawn_subagent stay even if marked deferrable).
 *   4. **countTokens failure / absence** → skip for this session (all
 *      deferrable built-ins stay resident, no throw).
 *
 * The judge is **pure logic**: `runOverflowJudge(tools, getCountTokens, threshold)` →
 * `{ retire: string[]; reason: "no_overflow" | "retired" | "countTokens_failed" }`.
 * Not bound to build-engine — this is the judge unit test; wire verification
 * lives in build-engine-tool-overflow.test.ts.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  runOverflowJudge,
  DEFERRABLE_BUILTIN_RETIRE_ORDER,
} from "../../src/harness/aci/tool-overflow.ts";
import type { AciToolDef } from "../../src/harness/aci/types.ts";

function makeTool(
  name: string,
  overrides: Partial<{ deferrable: boolean; lazy: boolean }> = {}
): AciToolDef {
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
      additionalProperties: false,
    },
    handler: async () => "ok",
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
      ...(overrides.deferrable ? { deferrable: true } : {}),
      ...(overrides.lazy ? { lazy: true } : {}),
    },
  });
}

describe("runOverflowJudge — ADR-0043 §3 溢出治理判定", () => {
  it("DEFERRABLE_BUILTIN_RETIRE_ORDER 锁死退场次序:trace 读侧三件 → web → 其余", () => {
    // Preset order (ADR-0043 §3): trace read-side trio →
    // web_search / web_fetch → remaining low-frequency query tools. Pinning it
    // means any order drift turns this test red immediately.
    assert.deepEqual(
      [...DEFERRABLE_BUILTIN_RETIRE_ORDER],
      ["query_trace", "list_sessions", "get_record", "web_search", "web_fetch"]
    );
  });

  it("未超阈值:全部 deferrable 内建件保持常驻,无 stamp lazy", async () => {
    const tools: AciToolDef[] = [
      makeTool("bash"),
      makeTool("read_file"),
      makeTool("query_trace", { deferrable: true }),
      makeTool("list_sessions", { deferrable: true }),
      makeTool("get_record", { deferrable: true }),
      makeTool("web_search", { deferrable: true }),
      makeTool("web_fetch", { deferrable: true }),
    ];
    // threshold 100_000; simulated measurement 5_000 < threshold → no retirement
    const result = await runOverflowJudge({
      tools,
      threshold: 100_000,
      // measurement: tokens of the whole tool list + system text (5_000 tok, far below 100_000)
      countTokens: async () => 5_000,
    });
    assert.equal(result.reason, "no_overflow");
    assert.deepEqual(result.retire, []);
  });

  it("超阈值:按退场次序逐件退,每退一件重算 countTokens 直到 ≤ 阈值", async () => {
    const tools: AciToolDef[] = [
      makeTool("bash"),
      makeTool("read_file"),
      makeTool("query_trace", { deferrable: true }),
      makeTool("list_sessions", { deferrable: true }),
      makeTool("get_record", { deferrable: true }),
      makeTool("web_search", { deferrable: true }),
      makeTool("web_fetch", { deferrable: true }),
    ];
    // threshold 10_000; simulate "all deferrable = 30_000 → after retiring 1: 24_000
    // → 2nd: 18_000 → 3rd: 12_000 → 4th: 6_000 <= threshold".
    const measurements = [30_000, 24_000, 18_000, 12_000, 6_000];
    let callIdx = 0;
    const result = await runOverflowJudge({
      tools,
      threshold: 10_000,
      countTokens: async () => {
        const v = measurements[callIdx];
        callIdx += 1;
        if (v === undefined) throw new Error("countTokens: out of fixtures");
        return v;
      },
    });
    // Retirement order: query_trace → list_sessions → get_record → web_search
    // (web_fetch is not retired, because by web_search the total is already <= threshold)
    assert.equal(result.reason, "retired");
    assert.deepEqual(result.retire, [
      "query_trace",
      "list_sessions",
      "get_record",
      "web_search",
    ]);
    // Measurement count: 1 initial + 1 re-measure per retirement = 1 + 4 = 5
    assert.equal(callIdx, 5);
  });

  it("核心件永不退场:即使被标 deferrable 也不参与判定", async () => {
    const tools: AciToolDef[] = [
      // even with deferrable:true attempted, core tools are skipped at retirement (residency invariant)
      makeTool("bash", { deferrable: true }),
      makeTool("read_file", { deferrable: true }),
      makeTool("edit_file", { deferrable: true }),
      makeTool("write_file", { deferrable: true }),
      makeTool("grep", { deferrable: true }),
      makeTool("glob", { deferrable: true }),
      makeTool("spawn_subagent", { deferrable: true }),
      makeTool("query_trace", { deferrable: true }),
    ];
    // threshold 1_000; simulate over-threshold every time — but core tools never participate
    const result = await runOverflowJudge({
      tools,
      threshold: 1_000,
      countTokens: async () => 5_000,
    });
    // all deferrable built-ins (only query_trace) retired and still over threshold →
    // retire includes query_trace (the sole candidate), but zero core participation
    assert.equal(result.reason, "retired");
    assert.ok(result.retire.includes("query_trace"));
    for (const core of [
      "bash",
      "read_file",
      "edit_file",
      "write_file",
      "grep",
      "glob",
      "spawn_subagent",
    ]) {
      assert.ok(
        !result.retire.includes(core),
        `${core} 永不退场(已参与),实际 retire=${JSON.stringify(result.retire)}`
      );
    }
  });

  it("countTokens 失败 → 跳过本会话,无 stamp lazy", async () => {
    const tools: AciToolDef[] = [
      makeTool("bash"),
      makeTool("query_trace", { deferrable: true }),
      makeTool("list_sessions", { deferrable: true }),
    ];
    const result = await runOverflowJudge({
      tools,
      threshold: 10_000,
      countTokens: async () => {
        throw new Error("API down");
      },
    });
    // failure = skip, retire must be empty (reason is flagged so callers can warn)
    assert.equal(result.reason, "countTokens_failed");
    assert.deepEqual(result.retire, []);
  });

  it("无可退:超阈值但 deferrable 池为空 → 静默不退(返回 reason:no_overflow 但已尽力)", async () => {
    const tools: AciToolDef[] = [
      makeTool("bash"),
      makeTool("read_file"),
      makeTool("grep"),
    ];
    const result = await runOverflowJudge({
      tools,
      threshold: 1_000,
      countTokens: async () => 5_000,
    });
    // no deferrable → retirement pool empty → reason:no_overflow (no over-threshold
    // retirement happened this session; core tools never retire → kept silently;
    // callers need no warn, the pool is simply empty)
    assert.equal(result.reason, "no_overflow");
    assert.deepEqual(result.retire, []);
  });
});
