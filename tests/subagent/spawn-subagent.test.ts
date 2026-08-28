/**
 * #356 T4 / #361 V1.5 / #556 T3 — spawn_subagent ACI 工具单测（fake
 * SubAgentManager，不真启子进程）。
 *
 * 覆盖票面（#361 前景契约反转后）：
 *   1. wait:false → handler 解析为 {task_id} JSON，manager.spawn 被调一次
 *   2. wait:true(默认) → handler 解析为 envelope（fake waitFor 立即 resolve）
 *   3. background:true → 抛 ToolExecutionError，message 含 "background:true"
 *   4. task 缺失 → 抛 ToolExecutionError
 *   5. task:123（非 string）→ 抛 ToolExecutionError
 *   6. disallowedTools 数组透传到 def
 *   7. systemPrompt 字符串透传
 *   8. model 字符串透传
 *   9. maxTurns 整数透传
 *  10. wait:false → waitFor 不被调用
 *  11. aci 元数据（timeoutTier=unbounded，ACI 不抢 manager per-task 钟）
 *  12. #556 T3/T7: subagent_type 可选参数 → def.role 透传（缺省 = general-purpose）
 *  13. #556 T3: inputSchema.subagent_type enum = catalog ids（运行时派生）
 *  14. #556 T3: description 含 prose list（catalog entries）
 *
 * 超字段 {task:"x", foo:"bar"} 的严格性由 registry 的 ajv strict 校验守门
 * （createAciRegistry 装配时编译 inputSchema，additionalProperties:false），
 * 工具 handler 收的是已校验 input——此处不重复测（依赖 registry 严校验）。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import type { SubAgentDefinition } from "../../src/harness/subagent/manager.ts";
import type {
  QueryBufferResult,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import {
  PER_TASK_TIMEOUT_MS,
  SubAgentAbortError,
  SubAgentWaitTimeoutError,
} from "../../src/harness/subagent/manager.ts";
import { DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS } from "../../src/config/settings.ts";
import { TIMEOUT_TIER_MS } from "../../src/harness/aci/types.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import {
  resolveAgentCatalog,
  getAgentEntry,
} from "../../src/harness/subagent/catalog.ts";

/** ajv 实例（与仓库同款 strict + allErrors + formats）— T3 测 inputSchema 编译。 */
function makeAjv(): Ajv.default {
  const ajv = new Ajv.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv;
}

/** fake manager：spawn 固定 taskId + 记录入参 def（spy）；其余成员面 stub。 */
function makeFakeManager() {
  const spawn = vi.fn(
    (_def: SubAgentDefinition): { readonly taskId: string } => ({
      taskId: "fixed-task-id-1",
    })
  );
  const waitFor = vi.fn(
    async (): Promise<{ status: "ok"; summary: string; result: string }> => ({
      status: "ok",
      summary: "from-fake",
      result: "fake-result",
    })
  );
  const manager: SubAgentManager = {
    spawn,
    queryBuffer: () => ({ status: "not_found" }) as const,
    waitFor,
    shutdown: () => Promise.resolve(),
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    // #358 T7: 接口新增只读枚举面 —— fake 补全保持结构兼容。
    listSubagents: () => [],
  };
  return { manager, spawn, waitFor };
}

describe("spawn_subagent — 正常路径", () => {
  it("wait:false → 返回 JSON {task_id},manager.spawn 被调一次,传入 def 含 task", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const out = await tool.handler({ task: "explore the repo", wait: false });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "explore the repo" })
    );
    expect(out).toBe(JSON.stringify({ task_id: "fixed-task-id-1" }));
  });

  // #361 前景契约（原 sync ≤50ms 断言已删；与 wait:true 默认互斥）。
  it("wait:true(默认)handler 解析为 envelope (foreground contract)", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    // C5：前景臂 tool_result = envelope（对象直返，executor 20000 截断天然复用）。
    const out = await tool.handler({ task: "wait-me" });
    const parsed = out as { status: string; summary: string; result: string };
    expect(parsed.status).toBe("ok");
    expect(parsed.summary).toBe("from-fake");
    expect(parsed.result).toBe("from-fake");
    expect(parsed.result).not.toBe("fake-result");
  });

  it("wait:false → waitFor 不被调用", async () => {
    const { manager, waitFor } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "async-arm", wait: false });
    expect(waitFor).not.toHaveBeenCalled();
  });
});

describe("spawn_subagent — 非法输入(抛 ToolExecutionError)", () => {
  it("background:true → message 含 'background:true'", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await expect(tool.handler({ task: "t", background: true })).rejects.toThrow(
      ToolExecutionError
    );
    await expect(tool.handler({ task: "t", background: true })).rejects.toThrow(
      /background:true/
    );
  });

  it("task 缺失 → message 含 'missing or invalid'", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await expect(tool.handler({})).rejects.toThrow(ToolExecutionError);
    await expect(tool.handler({})).rejects.toThrow(/missing or invalid/);
  });

  it("task:123（非 string）→ 抛", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await expect(tool.handler({ task: 123 })).rejects.toThrow(
      ToolExecutionError
    );
    await expect(tool.handler({ task: 123 })).rejects.toThrow(
      /missing or invalid/
    );
  });

  it("task 空串 → 抛", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await expect(tool.handler({ task: "" })).rejects.toThrow(
      ToolExecutionError
    );
  });

  it("input 为 null → 按空对象处理,抛 missing task", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await expect(tool.handler(null)).rejects.toThrow(ToolExecutionError);
  });
});

describe("spawn_subagent — 可选字段透传到 def", () => {
  it("disallowedTools 数组透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "t",
      disallowedTools: ["edit_file", "write_file"],
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "t",
        disallowedTools: ["edit_file", "write_file"],
      })
    );
  });

  it("systemPrompt 字符串透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "t",
      systemPrompt: "be a verifier",
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", systemPrompt: "be a verifier" })
    );
  });

  it("model 字符串透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", model: "opus", wait: false });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", model: "opus" })
    );
  });

  it("maxTurns 整数透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", maxTurns: 5, wait: false });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", maxTurns: 5 })
    );
  });

  it("timeoutMs 整数透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", timeoutMs: 60000, wait: false });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", timeoutMs: 60000 })
    );
  });

  it("timeoutMs 缺席 → def 省略该字段 (manager 三层链 def ?? taskTimeoutMs ?? 7200s 接管)", async () => {
    // #358 T2 (SC4 消费点证明): 模型未给 timeoutMs 时 handler 不得把常量塞进
    // def.timeoutMs —— 否则链条中段 env.subagent.taskTimeoutMs 永远被顶掉变
    // 死代码。断言 def 上 timeoutMs 为 undefined (spawn 收到缺字段 def, 由
    // manager 侧 effectiveTaskTimeoutMs 决定 SIGTERM / waitFor 缺省)。
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", wait: false });
    const calledDef = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(calledDef.timeoutMs).toBeUndefined();
  });

  it("全字段组合透传(含默认缺省)", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "t",
      systemPrompt: "be concise",
      disallowedTools: ["spawn_subagent"],
      model: "opus",
      maxTurns: 7,
      timeoutMs: 90000,
      wait: false,
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

  it("#357 T1: sandboxRoot 字符串透传到 def", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "t",
      sandboxRoot: "/tmp/work",
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", sandboxRoot: "/tmp/work" })
    );
  });
});

describe("spawn_subagent — AciToolDef 元数据", () => {
  it("name = spawn_subagent,aci read-only/long/cancel/concurrencySafe", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    expect(tool.name).toBe("spawn_subagent");
    expect(tool.aci.category).toBe("read-only");
    // 前景臂寿命归 manager per-task 钟；ACI unbounded=0 不套 long(30min)
    // 提前 abort（long < PER_TASK_TIMEOUT_MS 会砍真任务）。
    expect(tool.aci.timeoutTier).toBe("unbounded");
    expect(TIMEOUT_TIER_MS[tool.aci.timeoutTier]).toBe(0);
    expect(TIMEOUT_TIER_MS.long).toBeLessThan(PER_TASK_TIMEOUT_MS);
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
      properties: Record<string, { type: string }>;
    };
    expect(schema.required).toEqual(["task"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(schema.properties.timeoutMs).toBeDefined();
    expect(schema.properties.timeoutMs.type).toBe("integer");
    const timeoutDesc = (
      tool.inputSchema as {
        properties: Record<string, { description?: string }>;
      }
    ).properties.timeoutMs.description;
    expect(timeoutDesc).not.toMatch(/5\s*min/i);
    expect(timeoutDesc).toMatch(/2\s*h/i);
  });

  it("#357 T1: inputSchema 含 sandboxRoot 字段(string,可选)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as {
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
    expect(schema.properties.sandboxRoot).toBeDefined();
    expect(schema.properties.sandboxRoot.type).toBe("string");
    // 不进 required(可选)
    expect(schema.required).not.toContain("sandboxRoot");
  });
});

describe("spawn_subagent — #357 T1: SubAgentSandboxRootError → ToolExecutionError", () => {
  it("manager.spawn 抛 SubAgentSandboxRootError → handler 转 ToolExecutionError", async () => {
    const { SubAgentSandboxRootError } =
      await import("../../src/harness/errors.ts");
    const { manager, spawn } = makeFakeManager();
    // 让 spawn 每次都抛 typed error(mockImplementationOnce 仅触发一次,改用
    // mockImplementation 让两次 handler 调用都覆盖到,避免第二次回到默认 mock)。
    spawn.mockImplementation(() => {
      throw new SubAgentSandboxRootError({
        parentSandboxRoot: "/parent",
        requested: "/outside",
      });
    });
    const tool = createSpawnSubAgentTool({ manager });
    await expect(
      tool.handler({ task: "t", sandboxRoot: "/outside", wait: false })
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler({ task: "t", sandboxRoot: "/outside", wait: false })
    ).rejects.toThrow(/sandboxRoot/i);
  });
});

/**
 * #557 T1 — spawn_subagent.description = 工具用法 SSOT。
 * 主题以 issue #555 评论为准（何时派、阻塞或并行、wait:false、短交差与容量），
 * 不写嵌套政策（嵌套禁止由代码保证，不在 description 表达）。
 */
describe("spawn_subagent description — 工具用法 SSOT (T1 #557)", () => {
  const fixtureManager = (): SubAgentManager => makeFakeManager().manager;
  let description: string;
  beforeAll(() => {
    description = createSpawnSubAgentTool({
      manager: fixtureManager(),
    }).description;
  });

  it("写入 5 主题：何时用 / 默认阻塞 / 独立并行 / wait:false 轮询 / 短交差与容量", () => {
    // 1. 何时用：multi-step exploration / independent verification / parallelizable work → 派 sub-agent
    expect(description).toMatch(/multi-step exploration/);
    expect(description).toMatch(/independent verification/);
    expect(description).toMatch(/parallelizable work/);
    // 2. 默认阻塞：wait:true → blocks until sub-agent finishes；缺省墙钟 = 2h（PER_TASK），可 timeoutMs 覆盖。禁止再写 5 min（会诱导模型传 300000）。
    expect(description).toMatch(/wait[:\s]*true/i);
    expect(description).toMatch(/blocks? until/i);
    expect(description).toMatch(/parent-visible short handoff/i);
    expect(description).not.toMatch(/5\s*min/i);
    expect(description).toMatch(/2\s*h(?:ours?)?/i);
    expect(description).toMatch(/timeoutMs/i);
    // 3. 并行：同一 turn 多次 spawn_subagent 仅跑相互独立的自包含任务
    expect(description).toMatch(/multiple.*spawn_subagent/s);
    expect(description).toMatch(/one (?:single )?turn/i);
    expect(description).toMatch(/parallel/i);
    expect(description).toMatch(/independent/i);
    expect(description).toMatch(/self-contained/i);
    // 4. wait:false → 立即返回 {task_id},用 subagent_result 轮询
    expect(description).toMatch(/wait[:\s]*false/i);
    expect(description).toMatch(/task_id/i);
    expect(description).toMatch(/subagent_result/i);
    // 5. 父可见短交差与容量：summary / paths / status / stop_reason；超限不排队
    expect(description).toMatch(/summary/i);
    expect(description).toMatch(/paths?/i);
    expect(description).toMatch(/status/i);
    expect(description).toMatch(/stop[_ ]reason/i);
    expect(description).toMatch(
      new RegExp(String(DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS))
    );
    expect(description).toMatch(/at capacity/i);
    expect(description).toMatch(/reduce concurrency/i);
    expect(description).toMatch(/not queued|rather than queued/i);
    expect(description).toMatch(/general-purpose/);
    expect(description).not.toMatch(/sole ground truth|ground truth/i);
    expect(description).not.toMatch(/full result envelope/i);
    expect(description).not.toMatch(/Fork|worktree/i);
  });

  it("不写入嵌套政策(nested / one level / caps at 等措辞)", () => {
    // 嵌套禁止由代码保证,description 不应假装一个语义级 SSOT
    expect(description).not.toMatch(/nested/i);
    expect(description).not.toMatch(/one level/i);
    expect(description).not.toMatch(/caps at/i);
  });
});

/**
 * #556 T3 — subagent_type 参数 + ajv enum (catalog ids 派生) +
 * handler 映射 → def.role。
 *
 * 防御契约 (T3 acceptance):
 *   - subagent_type 缺省 → def.role = general-purpose（与显式 general-purpose 等价）
 *   - subagent_type 已知 → def.role 显式透传 → manager.buildWorkerPayload →
 *     envelope.role → worker 注入 catalog body persona 段 (T2 装配)
 *   - ajv enum = catalog id 列表（运行时 resolveAgentCatalog 派生）
 *   - 未知 subagent_type → ajv fail-fast（在 handler 入口之前被拒）
 *   - description prose list 段：intro + 每 entry 一行 `name: description`
 */
describe("spawn_subagent — #556 T3 subagent_type 参数 + ajv enum", () => {
  it("inputSchema.subagent_type 字段存在 (string + enum = catalog ids 派生)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as {
      properties: Record<
        string,
        { type: string; enum?: ReadonlyArray<string> }
      >;
      required: string[];
    };
    const subagentType = schema.properties.subagent_type;
    expect(subagentType).toBeDefined();
    expect(subagentType.type).toBe("string");
    // enum = catalog ids 派生（运行时不写死字面）
    const expected = resolveAgentCatalog().map((e) => e.id);
    expect(subagentType.enum).toBeDefined();
    expect([...subagentType.enum!]).toEqual(expected);
  });

  it("subagent_type 不进 required (可选参数)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as { required: string[] };
    expect(schema.required).not.toContain("subagent_type");
    // required 仍只 = ["task"]（V1 baseline 保留）
    expect(schema.required).toEqual(["task"]);
  });

  it("ajv 编译: subagent_type='explore' 通过 strict 校验", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const validate = makeAjv().compile(tool.inputSchema);
    expect(validate({ task: "x", subagent_type: "explore" })).toBe(true);
    expect(validate({ task: "x", subagent_type: "general-purpose" })).toBe(
      true
    );
  });

  it("ajv 编译: subagent_type 未知值被 enum 拒绝 (fail-fast, ajv 入口拦截)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const validate = makeAjv().compile(tool.inputSchema);
    expect(validate({ task: "x", subagent_type: "not_a_real_agent" })).toBe(
      false
    );
    // ajv enum 错误: instancePath=/subagent_type, keyword="enum",
    // params.allowedValues = catalog ids (ajv 拒绝原因: not in enum)。
    const errs = validate.errors ?? [];
    const enumErr = errs.find(
      (e) =>
        e.instancePath === "/subagent_type" &&
        (e as { keyword?: string }).keyword === "enum"
    );
    expect(enumErr).toBeDefined();
    // params.allowedValues 含 catalog ids
    const allowed = (enumErr as { params?: { allowedValues?: unknown } })
      ?.params?.allowedValues;
    expect(allowed).toEqual(["explore", "general-purpose"]);
  });

  it("ajv 编译: subagent_type 非 string 类型被拒", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const validate = makeAjv().compile(tool.inputSchema);
    expect(validate({ task: "x", subagent_type: 123 })).toBe(false);
    expect(validate({ task: "x", subagent_type: ["explore"] })).toBe(false);
  });

  it("ajv 编译: 缺 subagent_type 仍合法 (optional)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const validate = makeAjv().compile(tool.inputSchema);
    expect(validate({ task: "x" })).toBe(true);
  });
});

describe("spawn_subagent — #556 T3 handler: subagent_type → def.role", () => {
  it("subagent_type='explore' → def.role = 'explore' (透传 spawn)", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "explore the repo",
      subagent_type: "explore",
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "explore the repo", role: "explore" })
    );
  });

  it("subagent_type='general-purpose' → def.role = 'general-purpose'", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "do anything",
      subagent_type: "general-purpose",
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "general-purpose" })
    );
  });

  it("subagent_type 缺省 → def.role = general-purpose", async () => {
    // T7: 不传 subagent_type 的默认角色必须与显式 general-purpose 一致，
    // 让 worker 注入 persona 并保持完整工具面。
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "no-role", wait: false });
    const calledDef = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(calledDef.role).toBe("general-purpose");
  });

  it("subagent_type 显式传 'general-purpose' 等价于不传", async () => {
    // T7: 两种调用都应走 general-purpose persona 和完整工具面。
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", wait: false });
    await tool.handler({
      task: "t",
      subagent_type: "general-purpose",
      wait: false,
    });
    const def1 = spawn.mock.calls[0][0] as SubAgentDefinition;
    const def2 = spawn.mock.calls[1][0] as SubAgentDefinition;
    expect(def1.role).toBe("general-purpose");
    expect(def2.role).toBe("general-purpose");
    expect(def1.disallowedTools).toBeUndefined();
    expect(def2.disallowedTools).toBeUndefined();
  });

  it("subagent_type + 其他字段组合 → 全部透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "t",
      subagent_type: "explore",
      systemPrompt: "be focused",
      disallowedTools: ["spawn_subagent"],
      model: "opus",
      maxTurns: 4,
      timeoutMs: 60000,
      sandboxRoot: "/tmp/work",
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "t",
        role: "explore",
        systemPrompt: "be focused",
        // #556 T3 + Spec review 收口: parent disallowedTools 与 catalog entry
        // denied union (Set 去重)。explore 的 catalog 默认 [edit_file, write_file]
        // 与 parent [spawn_subagent] merge = [spawn_subagent, edit_file, write_file]。
        disallowedTools: ["spawn_subagent", "edit_file", "write_file"],
        model: "opus",
        maxTurns: 4,
        timeoutMs: 60000,
        sandboxRoot: "/tmp/work",
      })
    );
  });
});

describe("spawn_subagent — #556 T3 spec-review 收口: catalog disallowedTools merge in wire", () => {
  // Spec reviewer (2026-08-20 code-review) High finding:
  //   catalog entry.disallowedTools 未流入 wire,explore 角色的
  //   [edit_file, write_file] deny 不进入 worker tool surface。
  //   修法: handler 在 resolvedRole 解析时捕获 catalog entry,
  //   union(parent disallowedTools, catalog entry.disallowedTools)
  //   后写入 def.disallowedTools (registry.ts Gate 3 deny-list
  //   把 entry 内的工具名从 toolsetNames 剔除)。

  it("subagent_type='explore' 无 parent disallowedTools → def.disallowedTools = catalog 默认 [edit_file, write_file]", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "explore-only",
      subagent_type: "explore",
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.role).toBe("explore");
    expect(def.disallowedTools).toBeDefined();
    expect([...def.disallowedTools!]).toEqual(
      expect.arrayContaining(["edit_file", "write_file"])
    );
    expect(def.disallowedTools).toHaveLength(2);
  });

  it("subagent_type='explore' + parent disallowedTools → union (parent ADD, 不 subtract catalog)", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "explore-with-parent",
      subagent_type: "explore",
      disallowedTools: ["some_extra_tool"],
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.role).toBe("explore");
    expect([...def.disallowedTools!]).toEqual(
      expect.arrayContaining(["edit_file", "write_file", "some_extra_tool"])
    );
    expect(def.disallowedTools).toHaveLength(3);
  });

  it("subagent_type='explore' + parent 重复 deny 同名 → Set 去重", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "dedupe-check",
      subagent_type: "explore",
      disallowedTools: ["edit_file", "another_tool"], // edit_file 已含于 catalog
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.disallowedTools).toHaveLength(3); // edit_file (1) + write_file + another_tool
    expect([...def.disallowedTools!]).toEqual(
      expect.arrayContaining(["edit_file", "write_file", "another_tool"])
    );
  });

  it("subagent_type='general-purpose' 无 catalog denied → def.disallowedTools 缺省 (V1 byte-stable)", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "general",
      subagent_type: "general-purpose",
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.role).toBe("general-purpose");
    expect(def.disallowedTools).toBeUndefined();
  });

  it("subagent_type 不传 + parent disallowedTools → def.disallowedTools = parent", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "v1-baseline",
      disallowedTools: ["some_tool"],
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.role).toBe("general-purpose");
    expect(def.disallowedTools).toEqual(["some_tool"]);
  });

  it("subagent_type 不传 + 无 parent disallowedTools → general-purpose 完整工具面", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "v1-blank",
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.role).toBe("general-purpose");
    expect(def.disallowedTools).toBeUndefined();
  });
});

describe("spawn_subagent — #556 T3 deps.catalog (additive, default = builtin)", () => {
  it("未传 catalog → factory 内部 fallback resolveAgentCatalog, ajv enum 仍 = builtin ids", () => {
    // plan 决议: dist 装配 (registry.ts) 不传 catalog, factory 内部用 default。
    // 此处验证 default 行为: 即使 deps 没显式给 catalog, ajv enum 仍来自
    // resolveAgentCatalog().map(e => e.id) = ['explore', 'general-purpose'].
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as {
      properties: Record<string, { enum?: ReadonlyArray<string> }>;
    };
    expect([...schema.properties.subagent_type.enum!]).toEqual([
      "explore",
      "general-purpose",
    ]);
  });

  it("deps.catalog 显式传 fake resolver → ajv enum + prose list 都由 fake 派生", () => {
    // 测试缝: 注入 fake resolver (list + get 双面), 验证 factory 真的在用
    // deps.catalog 而不是内部默认 (factory 闭包 → list + get 两消费面同时生效)。
    const FAKE_ENTRY = {
      id: "fake_agent",
      description: "fake agent for testing",
      body: "fake body",
    };
    const fakeCatalog = {
      list: () => [FAKE_ENTRY] as const,
      get: (id: string) => {
        if (id === "fake_agent") return FAKE_ENTRY;
        throw new Error("unknown " + id);
      },
    };
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({
      manager,
      catalog: fakeCatalog,
    });
    // enum 由 fake list 派生
    const schema = tool.inputSchema as {
      properties: Record<string, { enum?: ReadonlyArray<string> }>;
    };
    expect([...schema.properties.subagent_type.enum!]).toEqual(["fake_agent"]);
    // prose list 含 fake_agent 行
    expect(tool.description).toMatch(
      /-\s*fake_agent\s*:\s*fake agent for testing/
    );
    // 原 builtin 'explore' 不在 enum / prose (fake 完全替换)
    expect([...schema.properties.subagent_type.enum!]).not.toContain("explore");
    expect(tool.description).not.toMatch(/-\s*explore\s*:/);
  });

  it("deps.catalog 接受 resolver 双面形态 (list + get)", () => {
    // 类型契约: deps.catalog 是 AgentCatalogResolver (双面: list() 返回
    // ReadonlyArray<AgentCatalogEntry>, get(id) 返回 AgentCatalogEntry)。
    // factory 接受该形态, 不要求是 builtinCatalogResolver 同款 frozen。
    const fakeCatalog = {
      list: () => resolveAgentCatalog(),
      get: (id: string) => getAgentEntry(id),
    };
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({
      manager,
      catalog: fakeCatalog,
    });
    expect(tool.name).toBe("spawn_subagent");
  });
});

describe("spawn_subagent description — #556 T3 prose list 段 (catalog entries)", () => {
  const fixtureManager = (): SubAgentManager => makeFakeManager().manager;
  let description: string;
  beforeAll(() => {
    description = createSpawnSubAgentTool({
      manager: fixtureManager(),
    }).description;
  });

  it("含 'Available subagent types' intro 段", () => {
    expect(description).toMatch(/Available subagent types/i);
  });

  it("每个 catalog entry 一行 `name: description`", () => {
    const catalog = resolveAgentCatalog();
    for (const entry of catalog) {
      const re = new RegExp(
        `-\\s*${entry.id}\\s*:\\s*${entry.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
      );
      expect(description).toMatch(re);
    }
  });

  it("prose list 在原描述之后追加 (不动现有 SSOT 段)", () => {
    // 原描述的 "Delegate a self-contained task" 必须仍然出现在 prose
    // list 段之前。
    const introIdx = description.indexOf("Delegate a self-contained task");
    const proseIdx = description.indexOf("Available subagent types");
    expect(introIdx).toBeGreaterThanOrEqual(0);
    expect(proseIdx).toBeGreaterThan(introIdx);
  });
});

describe("spawn_subagent — WaitTimeoutError queryBuffer 分流", () => {
  function managerRejectingWait(opts: {
    readonly buffer: QueryBufferResult;
    readonly err: Error;
  }): SubAgentManager {
    const { manager } = makeFakeManager();
    return {
      ...manager,
      queryBuffer: () => opts.buffer,
      waitFor: async () => {
        throw opts.err;
      },
    };
  }

  it("negative: WaitTimeout + not_found → ToolExecutionError（不谎报 timeout envelope）", async () => {
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: { status: "not_found" },
        err: new SubAgentWaitTimeoutError(),
      }),
    });
    await expect(tool.handler({ task: "t", wait: true })).rejects.toThrow(
      ToolExecutionError
    );
    await expect(tool.handler({ task: "t", wait: true })).rejects.toThrow(
      /not found|gone|unknown/i
    );
  });

  it("exception: WaitTimeout + running → failed timeout envelope（ok 数据）", async () => {
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: { status: "running" },
        err: new SubAgentWaitTimeoutError(),
      }),
    });
    const out = (await tool.handler({ task: "t", wait: true })) as {
      status: string;
      reason?: string;
    };
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("timeout");
  });

  it("exception: WaitTimeout + failed buffer → 原 reason/summary，不合成", async () => {
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: {
          status: "failed",
          reason: "protocolError",
          summary: "child protocol",
        },
        err: new SubAgentWaitTimeoutError(),
      }),
    });
    const out = (await tool.handler({ task: "t", wait: true })) as {
      status: string;
      reason?: string;
      summary?: string;
    };
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("protocolError");
    expect(out.summary).toBe("child protocol");
  });

  it("concurrent: signal.aborted 优先于 WaitTimeoutError → cancelled", async () => {
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: { status: "running" },
        err: new SubAgentWaitTimeoutError(),
      }),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.handler({ task: "t", wait: true }, { signal: controller.signal })
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler({ task: "t", wait: true }, { signal: controller.signal })
    ).rejects.toThrow(/cancel/i);
  });

  it("abort typed error 仍走 cancelled，不经 queryBuffer 合成 timeout", async () => {
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: { status: "running" },
        err: new SubAgentAbortError("fixed-task-id-1"),
      }),
    });
    await expect(tool.handler({ task: "t", wait: true })).rejects.toThrow(
      /cancelled/
    );
  });
});
