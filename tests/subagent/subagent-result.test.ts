/**
 * #356 T5 — subagent_result ACI 工具单测（fake SubAgentManager，不真启子进程）。
 *
 * 覆盖票面 11 断言：
 *   1. taskId="unknown" → JSON {status:"not_found"}
 *   2. taskId="running" → JSON {status:"running"}
 *   3. taskId="ok" → completed envelope 透传（status:"ok" + summary + result
 *      + fileRefs/usage 字段）
 *   4. taskId="crashed" → {status:"failed", reason:"crashed", summary}
 *   5. taskId="maxTurnsExceeded" → reason:"maxTurnsExceeded"
 *   6. taskId="timeout" → reason:"timeout"
 *   7. taskId="protocolError" → reason:"protocolError"
 *   8. handler 同步 ≤10ms 返回（performance.now() 前后差）
 *   9. task_id 缺失 → 抛 ToolExecutionError
 *   10. task_id:123（非 string）→ 抛 ToolExecutionError
 *   11. aci 元数据：category:"read-only" / timeoutTier:"fast" / lazy:false
 *
 * 超字段 {task_id:"x", foo:"bar"} 的严格性由 registry 的 ajv strict 校验守门
 * （createAciRegistry 装配时编译 inputSchema，additionalProperties:false），
 * 工具 handler 收的是已校验 input——此处不重复测（依赖 registry 严校验）。
 */
import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";

import { createSubAgentResultTool } from "../../src/harness/subagent/subagent-result-tool.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";

/** fake manager：queryBuffer 按 taskId 映射四态之一；其余成员面 stub。 */
function makeFakeManager(): SubAgentManager {
  return {
    spawn: () => ({ taskId: "fake-id" }),
    queryBuffer: (taskId: string) => {
      switch (taskId) {
        case "unknown":
          return { status: "not_found" };
        case "running":
          return { status: "running" };
        case "ok": {
          const env: SubAgentEnvelope = {
            status: "ok",
            summary: "found the answer",
            result: "42",
            fileRefs: ["/tmp/a.txt", "/tmp/b.txt"],
            usage: { inputTokens: 10, outputTokens: 20 },
          };
          return env;
        }
        case "crashed":
          return {
            status: "failed",
            reason: "crashed",
            summary: "worker crashed",
          };
        case "maxTurnsExceeded":
          return {
            status: "failed",
            reason: "maxTurnsExceeded",
            summary: "turns exhausted",
          };
        case "timeout":
          return {
            status: "failed",
            reason: "timeout",
            summary: "wallclock exceeded",
          };
        case "protocolError":
          return {
            status: "failed",
            reason: "protocolError",
            summary: "bad envelope",
          };
        default:
          return { status: "not_found" };
      }
    },
    waitFor: () => Promise.reject(new Error("not used")),
    shutdown: () => Promise.resolve(),
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    // #358 T7: 接口新增只读枚举面 —— fake 补全保持结构兼容。
    listSubagents: () => [],
  };
}

describe("subagent_result — 正常路径", () => {
  it("unknown taskId → JSON {status:'not_found'}", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const out = tool.handler({ task_id: "unknown" });
    expect(out).toBe(JSON.stringify({ status: "not_found" }));
  });

  it("running taskId → JSON {status:'running'}", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const out = tool.handler({ task_id: "running" });
    expect(out).toBe(JSON.stringify({ status: "running" }));
  });

  it("completed → JSON 含 status:'ok' + summary + result,fileRefs/usage 透传", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const out = tool.handler({ task_id: "ok" });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.status).toBe("ok");
    expect(parsed.summary).toBe("found the answer");
    expect(parsed.result).toBe("42");
    expect(parsed.fileRefs).toEqual(["/tmp/a.txt", "/tmp/b.txt"]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("failed crashed → JSON {status:'failed', reason:'crashed', summary}", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const out = tool.handler({ task_id: "crashed" });
    expect(out).toBe(
      JSON.stringify({
        status: "failed",
        reason: "crashed",
        summary: "worker crashed",
      })
    );
  });

  it("failed maxTurnsExceeded → reason 一致", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const parsed = JSON.parse(
      tool.handler({ task_id: "maxTurnsExceeded" })
    ) as Record<string, unknown>;
    expect(parsed.status).toBe("failed");
    expect(parsed.reason).toBe("maxTurnsExceeded");
    expect(parsed.summary).toBe("turns exhausted");
  });

  it("failed timeout → reason 一致", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const parsed = JSON.parse(tool.handler({ task_id: "timeout" })) as Record<
      string,
      unknown
    >;
    expect(parsed.status).toBe("failed");
    expect(parsed.reason).toBe("timeout");
    expect(parsed.summary).toBe("wallclock exceeded");
  });

  it("failed protocolError → reason 一致", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const parsed = JSON.parse(
      tool.handler({ task_id: "protocolError" })
    ) as Record<string, unknown>;
    expect(parsed.status).toBe("failed");
    expect(parsed.reason).toBe("protocolError");
    expect(parsed.summary).toBe("bad envelope");
  });

  it("handler 同步 ≤10ms 返回", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const t0 = performance.now();
    tool.handler({ task_id: "ok" });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThanOrEqual(10);
  });
});

describe("subagent_result — 非法输入(抛 ToolExecutionError)", () => {
  it("task_id 缺失 → 抛 ToolExecutionError", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    expect(() => tool.handler({})).toThrow(ToolExecutionError);
    expect(() => tool.handler({})).toThrow(/missing or invalid/);
  });

  it("task_id:123（非 string）→ 抛", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    expect(() => tool.handler({ task_id: 123 })).toThrow(ToolExecutionError);
    expect(() => tool.handler({ task_id: 123 })).toThrow(/missing or invalid/);
  });

  it("task_id 空串 → 抛", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    expect(() => tool.handler({ task_id: "" })).toThrow(ToolExecutionError);
  });

  it("input 为 null → 按空对象处理,抛 missing task_id", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    expect(() => tool.handler(null)).toThrow(ToolExecutionError);
  });
});

describe("subagent_result — AciToolDef 元数据", () => {
  it("name = subagent_result,aci read-only/fast/cancel/concurrencySafe/lazy:false", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    expect(tool.name).toBe("subagent_result");
    expect(tool.aci.category).toBe("read-only");
    expect(tool.aci.timeoutTier).toBe("fast");
    expect(tool.aci.interruptBehavior).toBe("cancel");
    expect(tool.aci.isConcurrencySafe).toBe(true);
    expect(tool.aci.lazy).toBe(false);
  });

  it("description 说明父可见短交差字段，不宣称 full envelope 是唯一真值", () => {
    const description = createSubAgentResultTool({
      manager: makeFakeManager(),
    }).description;
    expect(description).toMatch(/parent-visible/i);
    expect(description).toMatch(/short (?:handoff|summary)/i);
    expect(description).toMatch(/summary/i);
    expect(description).toMatch(/paths?/i);
    expect(description).toMatch(/status/i);
    expect(description).toMatch(/stop[_ ]reason/i);
    expect(description).not.toMatch(/full envelope/i);
    expect(description).not.toMatch(/sole ground truth|ground truth/i);
    expect(description).not.toMatch(/Fork|worktree/i);
  });

  it("inputSchema 冻结:required=['task_id'],additionalProperties:false", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const schema = tool.inputSchema as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["task_id"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.isFrozen(tool)).toBe(true);
  });
});
