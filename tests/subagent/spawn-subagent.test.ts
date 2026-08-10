/**
 * #356 T4 — spawn_subagent ACI 工具单测（fake SubAgentManager，不真启子进程）。
 *
 * 覆盖票面 9 断言：
 *   1. handler 返回 JSON {task_id:"..."}，manager.spawn 被调一次（spy）
 *   2. handler ≤50ms 返回（performance.now() 前后差）
 *   3. background:true → 抛 ToolExecutionError，message 含 "background:true"
 *   4. task 缺失 → 抛 ToolExecutionError
 *   5. task:123（非 string）→ 抛 ToolExecutionError
 *   6. disallowedTools 数组透传到 def
 *   7. systemPrompt 字符串透传
 *   8. model 字符串透传
 *   9. maxTurns 整数透传
 *
 * 超字段 {task:"x", foo:"bar"} 的严格性由 registry 的 ajv strict 校验守门
 * （createAciRegistry 装配时编译 inputSchema，additionalProperties:false），
 * 工具 handler 收的是已校验 input——此处不重复测（依赖 registry 严校验）。
 */
import { describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";

import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import type { SubAgentDefinition } from "../../src/harness/subagent/manager.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";

/** fake manager：spawn 固定 taskId + 记录入参 def（spy）；其余成员面 stub。 */
function makeFakeManager() {
  const spawn = vi.fn(
    (_def: SubAgentDefinition): { readonly taskId: string } => ({
      taskId: "fixed-task-id-1",
    })
  );
  const manager: SubAgentManager = {
    spawn,
    queryBuffer: () => ({ status: "not_found" }) as const,
    waitFor: () => Promise.reject(new Error("not used")),
    shutdown: () => Promise.resolve(),
    drainCompleted: () => [],
  };
  return { manager, spawn };
}

describe("spawn_subagent — 正常路径", () => {
  it("返回 JSON {task_id},manager.spawn 被调一次,传入 def 含 task", () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const out = tool.handler({ task: "explore the repo" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "explore the repo" })
    );
    expect(out).toBe(JSON.stringify({ task_id: "fixed-task-id-1" }));
  });

  it("handler 同步 ≤50ms 返回", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const t0 = performance.now();
    tool.handler({ task: "t" });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThanOrEqual(50);
  });
});

describe("spawn_subagent — 非法输入(抛 ToolExecutionError)", () => {
  it("background:true → message 含 'background:true'", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    expect(() => tool.handler({ task: "t", background: true })).toThrow(
      ToolExecutionError
    );
    expect(() => tool.handler({ task: "t", background: true })).toThrow(
      /background:true/
    );
  });

  it("task 缺失 → message 含 'missing or invalid'", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    expect(() => tool.handler({})).toThrow(ToolExecutionError);
    expect(() => tool.handler({})).toThrow(/missing or invalid/);
  });

  it("task:123（非 string）→ 抛", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    expect(() => tool.handler({ task: 123 })).toThrow(ToolExecutionError);
    expect(() => tool.handler({ task: 123 })).toThrow(/missing or invalid/);
  });

  it("task 空串 → 抛", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    expect(() => tool.handler({ task: "" })).toThrow(ToolExecutionError);
  });

  it("input 为 null → 按空对象处理,抛 missing task", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    expect(() => tool.handler(null)).toThrow(ToolExecutionError);
  });
});

describe("spawn_subagent — 可选字段透传到 def", () => {
  it("disallowedTools 数组透传", () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    tool.handler({
      task: "t",
      disallowedTools: ["edit_file", "write_file"],
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "t",
        disallowedTools: ["edit_file", "write_file"],
      })
    );
  });

  it("systemPrompt 字符串透传", () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    tool.handler({ task: "t", systemPrompt: "be a verifier" });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", systemPrompt: "be a verifier" })
    );
  });

  it("model 字符串透传", () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    tool.handler({ task: "t", model: "opus" });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", model: "opus" })
    );
  });

  it("maxTurns 整数透传", () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    tool.handler({ task: "t", maxTurns: 5 });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", maxTurns: 5 })
    );
  });

  it("timeoutMs 整数透传", () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    tool.handler({ task: "t", timeoutMs: 60000 });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", timeoutMs: 60000 })
    );
  });

  it("全字段组合透传(含默认缺省)", () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    tool.handler({
      task: "t",
      systemPrompt: "be concise",
      disallowedTools: ["spawn_subagent"],
      model: "opus",
      maxTurns: 7,
      timeoutMs: 90000,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "t",
        systemPrompt: "be concise",
        disallowedTools: ["spawn_subagent"],
        model: "opus",
        maxTurns: 7,
        timeoutMs: 90000,
      })
    );
  });
});

describe("spawn_subagent — AciToolDef 元数据", () => {
  it("name = spawn_subagent,aci read-only/fast/cancel/concurrencySafe", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    expect(tool.name).toBe("spawn_subagent");
    expect(tool.aci.category).toBe("read-only");
    expect(tool.aci.timeoutTier).toBe("fast");
    expect(tool.aci.interruptBehavior).toBe("cancel");
    expect(tool.aci.isConcurrencySafe).toBe(true);
    expect(tool.aci.lazy).toBe(false);
  });

  it("inputSchema 冻结:required=['task'],additionalProperties:false", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["task"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.isFrozen(tool)).toBe(true);
  });
});
