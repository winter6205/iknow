/**
 * B6 / ADR-0043 §3 — 溢出治理判定函数（纯逻辑）单测。
 *
 * 测四个不变量：
 *   1. **未超阈值**（countTokens 总量 <= 阈值）→ 全部 deferrable 内建件保持
 *      常驻（无 stamp lazy: true），核心件不参与（永不退场）。
 *   2. **超阈值**（countTokens 总量 > 阈值）→ 按退场次序（面积 × 低频）从大
 *      到小逐件退：每退一件重算 countTokens，退出循环当 ≤ 阈值或无可退。
 *   3. **核心件永不退场**（bash / read_file / edit_file / write_file / grep /
 *      glob / spawn_subagent 即使标 deferrable 也不参与退场）。
 *   4. **countTokens 失败 / 缺席** → 跳过本会话（全部 deferrable 内建件保持
 *      常驻，不抛错）。
 *
 * 判定函数是**纯逻辑**：`runOverflowJudge(tools, getCountTokens, threshold)` →
 * `{ retire: string[]; reason: "no_overflow" | "retired" | "countTokens_failed" }`。
 * 测不绑 build-engine（与 build-engine-mcp-startwire.test.ts 的 wire 风格一致
 * —— 这里是判定单测，wire 验证在 build-engine-tool-overflow.test.ts 跑）。
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
    // 预置次序 (B6 plan §3 + ADR-0043 §3):trace 读侧三件 →
    // web_search / web_fetch → 其余低频查询件。锁定 = 测试碰到任意次序漂
    // 移立即红。
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
    // 阈值 100_000;模拟实测 5_000 < 阈值 → 无退场
    const result = await runOverflowJudge({
      tools,
      threshold: 100_000,
      // 实测：tool 列表整体 + system 文本的 token 数（5_000 tok 远低于 100_000）
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
    // 阈值 10_000;模拟"全部 deferrable = 30_000 → 退 1 件后 24_000 → 再退
    // 1 件后 18_000 → 再退 1 件后 12_000 → 再退 1 件后 6_000 ≤ 阈值"。
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
    // 退场次序:query_trace → list_sessions → get_record → web_search
    // (web_fetch 不退,因为退到 web_search 已 ≤ 阈值)
    assert.equal(result.reason, "retired");
    assert.deepEqual(result.retire, [
      "query_trace",
      "list_sessions",
      "get_record",
      "web_search",
    ]);
    // 测量次数:首测 1 次 + 每退 1 件重测 1 次 = 1 + 4 = 5 次
    assert.equal(callIdx, 5);
  });

  it("核心件永不退场:即使被标 deferrable 也不参与判定", async () => {
    const tools: AciToolDef[] = [
      // 即使尝试标 deferrable:true,核心件在退场时跳过(SSR 不变)
      makeTool("bash", { deferrable: true }),
      makeTool("read_file", { deferrable: true }),
      makeTool("edit_file", { deferrable: true }),
      makeTool("write_file", { deferrable: true }),
      makeTool("grep", { deferrable: true }),
      makeTool("glob", { deferrable: true }),
      makeTool("spawn_subagent", { deferrable: true }),
      makeTool("query_trace", { deferrable: true }),
    ];
    // 阈值 1_000;模拟每次都超阈值——但核心件永不参与退场
    const result = await runOverflowJudge({
      tools,
      threshold: 1_000,
      countTokens: async () => 5_000,
    });
    // 全部 deferrable 内建件(仅 query_trace)都退完仍超阈 → retire 含
    // query_trace(仅有的 1 件),但核心件零参与
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
    // 失败 = 跳过,retire 必空(reason 标记以便调用方打 warn)
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
    // 无 deferrable → 退场池为空 → reason:no_overflow(本会话无超限退场
    // 动作,核心件永不退场 → 静默保留;调用方无须 warn,因为池就是空)
    assert.equal(result.reason, "no_overflow");
    assert.deepEqual(result.retire, []);
  });
});
