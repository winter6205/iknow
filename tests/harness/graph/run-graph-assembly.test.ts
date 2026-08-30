/**
 * D-α T3 —— `run_graph` 条件装配 + 加性编排段（spec SC2）。
 *
 * 三层分开测，对应 plan 的三条验收：
 *   1. **装配快照**（`createGraphAssembly`）：overlay 是会话级可变 holder，
 *      但工具面必须按 `run()` 冻结 —— 同一 round 内翻键不改本 round。
 *   2. **条件装配**（`ACI_TOOLSET_NAMES` append-only + `createDefaultAciRegistry`
 *      Gate 3 镜像过滤）：没有 graph 能力的装配路径（ask / worker）连
 *      `run_graph` 的名字都不该出现。
 *   3. **加性编排段**（`assembleIdentityContext`）：段落是加性的，不进
 *      `IKNOW_ASSEMBLY_ORDER`；关图时字节级缺席（KV cache 契约）。
 *
 * 最后一层是 build-engine 集成：把 1+2+3 接成「关图 run() 无 run_graph、
 * 开图后下一次 run() 有」。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGraphAssembly,
  type GraphAssembly,
} from "../../../src/harness/graph/assembly.ts";
import {
  createGraphModeContext,
  type GraphModeContext,
} from "../../../src/harness/graph/mode.ts";
import { createRunGraphTool } from "../../../src/harness/graph/run-graph-tool.ts";
import {
  ACI_TOOLSET_NAMES,
  createDefaultAciRegistry,
} from "../../../src/harness/aci/tools/registry.ts";
import { createSkillCatalog } from "../../../src/harness/skill/catalog.ts";
import type { SubAgentManager } from "../../../src/harness/subagent/manager.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import {
  assembleIdentityContext,
  IKNOW_GRAPH_ORCHESTRATION_TEXT,
} from "../../../src/harness/identity/assemble.ts";
import { buildHarnessEngine } from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";

function makeWebEnv(): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined } };
}

/** 装配期够用的 fake manager（handler 路径不在本文件覆盖，见 T4）。 */
const fakeSubagentManager = {
  spawn: () => ({ taskId: "fake-id" }),
  queryBuffer: () => ({ status: "not_found" as const }),
  waitFor: () => Promise.reject(new Error("not used")),
  shutdown: () => Promise.resolve(),
  drainCompleted: () => [],
  listActive: () => [],
  abortTask: () => false,
  listSubagents: () => [],
  // master SubAgentManager 接口扩展:subscribe (mailbox 契约 #361)
  subscribe: () => () => {},
} as unknown as SubAgentManager;

// ── 1. 装配快照 ───────────────────────────────────────────────────────────

describe("createGraphAssembly — per-round 装配快照", () => {
  it("初值取 holder 当前值（settings 默认关 → enabled() false）", () => {
    const mode = createGraphModeContext();
    const assembly = createGraphAssembly(mode);
    expect(assembly.enabled()).toBe(false);
  });

  it("holder 已开时构造 → 首个 round 即为开（settings.graph.enabled=true 路径）", () => {
    const mode = createGraphModeContext({ enabled: true });
    expect(createGraphAssembly(mode).enabled()).toBe(true);
  });

  it("round 内翻 holder 不改本 round 快照；beginRound() 后才生效", () => {
    const mode = createGraphModeContext();
    const assembly: GraphAssembly = createGraphAssembly(mode);

    mode.setEnabled(true);
    expect(assembly.enabled()).toBe(false); // in-flight round 不热替换

    expect(assembly.beginRound()).toBe(true);
    expect(assembly.enabled()).toBe(true);

    mode.setEnabled(false);
    expect(assembly.enabled()).toBe(true); // 同上，本 round 冻结
    expect(assembly.beginRound()).toBe(false);
    expect(assembly.enabled()).toBe(false);
  });

  it("holder 缺席 → 恒关（未接 overlay 的入口零行为变化）", () => {
    const assembly = createGraphAssembly(undefined);
    expect(assembly.enabled()).toBe(false);
    expect(assembly.beginRound()).toBe(false);
  });
});

// ── 2. 条件装配 ───────────────────────────────────────────────────────────

describe("run_graph — ACI 条件装配（Gate 3 镜像过滤）", () => {
  it("ACI_TOOLSET_NAMES 在 run_graph / query_trace 之后 append-only 追加 worktree 3 件 + 10 件符号查询 + 5 件符号改（不重排既有件）", () => {
    // 长度 40;实际 idx（基线实测）:
    //   idx 20 = run_graph
    //   idx 21 = query_trace
    //   idx 22 = create-task-worktree
    //   idx 23 = enter-task-worktree
    //   idx 24 = exit-task-worktree
    //   idx 25 = find_symbol
    //   ...
    //   idx 35-39 = 5 件符号改(rename / replace / insert_before /
    //               insert_after / safe_delete),末位 safe_delete_symbol
    expect(ACI_TOOLSET_NAMES[20]).toBe("run_graph");
    expect(ACI_TOOLSET_NAMES[21]).toBe("query_trace");
    expect(ACI_TOOLSET_NAMES[22]).toBe("create-task-worktree");
    expect(ACI_TOOLSET_NAMES[23]).toBe("enter-task-worktree");
    expect(ACI_TOOLSET_NAMES[24]).toBe("exit-task-worktree");
    expect(ACI_TOOLSET_NAMES[25]).toBe("find_symbol");
    expect(ACI_TOOLSET_NAMES[35]).toBe("rename_symbol");
    expect(ACI_TOOLSET_NAMES[ACI_TOOLSET_NAMES.length - 1]).toBe(
      "safe_delete_symbol"
    );
    expect(ACI_TOOLSET_NAMES.slice(0, 8)).toEqual([
      "bash",
      "read_file",
      "grep",
      "glob",
      "edit_file",
      "write_file",
      "web_fetch",
      "web_search",
    ]);
  });

  it("graphAssembly 缺席 → run_graph 不入注册表（ask / worker 装配路径）", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
    });
    expect(reg.inner.list().map((d) => d.name)).not.toContain("run_graph");
    expect(reg.catalog.get("run_graph")).toBeUndefined();
  });

  it("subagentManager 缺席 → 即便传 graphAssembly 也不入注册表（无编排底座）", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      graphAssembly: { enabled: () => true },
    });
    expect(reg.inner.list().map((d) => d.name)).not.toContain("run_graph");
  });

  it("manager + graphAssembly 同时在场 → run_graph 入注册表（query_trace + 10 件符号查询 + 5 件符号改工具在末位）", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
      graphAssembly: { enabled: () => true },
    });
    const names = reg.inner.list().map((d) => d.name);
    expect(names).toContain("run_graph");
    expect(names[names.length - 1]).toBe("safe_delete_symbol");
    expect(reg.catalog.get("run_graph")).toBeDefined();
  });
});

describe("createRunGraphTool — 工具描述符", () => {
  const tool = createRunGraphTool({
    manager: fakeSubagentManager,
    isEnabled: () => true,
  });

  it("名字 / ACI 元数据与前景 spawn 同形（常驻、非 lazy、unbounded）", () => {
    expect(tool.name).toBe("run_graph");
    expect(tool.aci.lazy).toBe(false);
    expect(tool.aci.timeoutTier).toBe("unbounded");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("schema 要求至少一个节点，且节点带 id / task / deps", () => {
    const schema = tool.inputSchema as {
      properties: {
        nodes: {
          minItems: number;
          items: { properties: Record<string, unknown>; required: string[] };
        };
      };
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["nodes"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.nodes.minItems).toBe(1);
    expect(Object.keys(schema.properties.nodes.items.properties)).toEqual(
      expect.arrayContaining(["id", "task", "deps"])
    );
    expect(schema.properties.nodes.items.required).toEqual(["id", "task"]);
  });

  it("描述不泄漏模块路径（spec SC2:不要求含 src/harness/graph）", () => {
    expect(tool.description).not.toContain("src/harness/graph");
  });

  it("关图时调用 handler → typed 拒绝，零 spawn（EXIT，不静默降级）", async () => {
    let spawned = 0;
    const disabled = createRunGraphTool({
      manager: {
        ...fakeSubagentManager,
        spawn: () => {
          spawned += 1;
          return { taskId: "never" };
        },
      },
      isEnabled: () => false,
    });
    await expect(
      disabled.handler({ nodes: [{ id: "a", task: "t" }] })
    ).rejects.toThrow(/graph mode/i);
    expect(spawned).toBe(0);
  });
});

// ── 3. 加性编排段 ─────────────────────────────────────────────────────────

describe("编排段 —— 加性 assembly 段（不改 IKNOW_ASSEMBLY_ORDER）", () => {
  const baseCtx = {
    cwd: "/tmp/proj",
    userHome: "/tmp/nonexistent-home",
    bootstrapActive: false,
    memoryEnabled: false,
  } as const;

  it("orchestration 缝缺席 → 段缺席（字节级零变化）", async () => {
    const text = await assembleIdentityContext({ ...baseCtx });
    expect(text).toBeDefined();
    expect(text).not.toContain("run_graph");
  });

  it("orchestration() 返回 false → 段缺席", async () => {
    const text = await assembleIdentityContext({
      ...baseCtx,
      orchestration: () => false,
    });
    expect(text).not.toContain("run_graph");
  });

  it("orchestration() 返回 true → 段在场，含 run_graph 且不含模块路径", async () => {
    const text = await assembleIdentityContext({
      ...baseCtx,
      orchestration: () => true,
    });
    expect(text).toContain(IKNOW_GRAPH_ORCHESTRATION_TEXT);
    expect(text).toContain("run_graph");
    expect(text).not.toContain("src/harness/graph");
  });

  it("开关只加尾段：关图输出是开图输出的前缀（KV cache 前缀稳定）", async () => {
    const off = await assembleIdentityContext({ ...baseCtx });
    const on = await assembleIdentityContext({
      ...baseCtx,
      orchestration: () => true,
    });
    expect(on!.startsWith(off!)).toBe(true);
  });
});

// ── 4. build-engine 集成（spec SC2 三条）───────────────────────────────────

describe("buildHarnessEngine — graph 装配快照集成", () => {
  async function withEngine(
    graphMode: GraphModeContext | undefined,
    body: (
      built: Awaited<ReturnType<typeof buildHarnessEngine>>
    ) => void | Promise<void>
  ): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "iknow-graph-asm-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "iknow-graph-asm-cwd-"));
    const built = await buildHarnessEngine({
      env: makeEnv(),
      askUser: createNoAskUser(),
      memory: { enabled: false },
      userHome: home,
      cwd,
      ...(graphMode ? { graphMode } : {}),
    });
    try {
      await body(built);
    } finally {
      await built.shutdown?.();
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  }

  it("graphMode 缺席 → 工具面与 promptTools 都无 run_graph（默认模式零变化）", async () => {
    await withEngine(undefined, (built) => {
      expect(built.deps.registry.list().map((d) => d.name)).not.toContain(
        "run_graph"
      );
      expect(built.deps.promptTools!().map((d) => d.name)).not.toContain(
        "run_graph"
      );
      expect(built.graphAssembly).toBeUndefined();
    });
  });

  it("graph 关闭 → 本次 run() 可见工具名不含 run_graph；开图后下一次 run() 才含", async () => {
    const mode = createGraphModeContext();
    await withEngine(mode, async (built) => {
      const visible = (): ReadonlyArray<string> =>
        built.deps.promptTools!().map((d) => d.name);
      expect(visible()).not.toContain("run_graph");

      // 同一 in-flight round 内翻键 → 本 round 工具面不变（SC2 第三条）。
      mode.setEnabled(true);
      expect(visible()).not.toContain("run_graph");

      // 下一次 run() 的装配快照才露出。
      built.graphAssembly!.beginRound();
      expect(visible()).toContain("run_graph");

      // /graph off 后下一次 run() 不再装（SC3）。
      mode.setEnabled(false);
      built.graphAssembly!.beginRound();
      expect(visible()).not.toContain("run_graph");
    });
  });

  it("编排段随同一快照进出 system 文本", async () => {
    const mode = createGraphModeContext();
    await withEngine(mode, async (built) => {
      expect(await built.deps.system!()).not.toContain("run_graph");
      mode.setEnabled(true);
      built.graphAssembly!.beginRound();
      const on = await built.deps.system!();
      expect(on).toContain("run_graph");
      expect(on).not.toContain("src/harness/graph");
    });
  });
});

function makeEnv(): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-graph-assembly",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
}
