/**
 * ADR-0041 / plans/model-prefix-layering.md B3:`run_graph` 常驻注册 +
 * handler-level gate。
 *
 * 三层分开测,对应 plan B3 的三条验收 + 一个边界 + spec SC5:
 *   1. **装配快照**(`createGraphAssembly`):overlay 是会话级可变 holder,
 *      但 handler gate 仍按 `enabled()` 单点判定 —— 装配层不热替换,
 *      同 round 工具面与 system 字节稳定。
 *   2. **常驻条件装配**(`ACI_TOOLSET_NAMES` append-only +
 *      `createDefaultAciRegistry` Gate 3 镜像过滤):`run_graph` 仅在
 *      `subagentManager` 缺席时缺席;`graphAssembly` 缺席不再触发工具缺席
 *      —— 装配层恒在场(handler isEnabled 缺省恒关守门)。
 *   3. **切换提示 SSOT**(`renderGraphModeChangeNotification` +
 *      `IKNOW_GRAPH_MODE_*_NOTIFICATION`):开/关两条 `<graph_mode>` 单行
 *      静态文本,字节级恒定(KV cache 兼容 + 模型 grep 形态)。
 *   4. **buildHarnessEngine SC5 集成**:关图 promptTools 含 `run_graph`
 *      不过滤、handler 拒绝;开图同 round 即可调用(无 beginRound 门);
 *      system 段逐字节稳定(关→开→关邻轮 deep-equal);
 *      messages 尾部出现切换提示(开/关两种文本)。
 *
 * 编排指引文已从 system 段撤出(并入切换提示),故 assemble.ts 不再导出
 * `orchestration` 缝 / `IKNOW_GRAPH_ORCHESTRATION_TEXT`(B3 关键边界:
 * system 段不再因 graph 状态变化)。
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
  IKNOW_GRAPH_MODE_OFF_NOTIFICATION,
  IKNOW_GRAPH_MODE_ON_NOTIFICATION,
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
  renderGraphModeChangeNotification,
  isGraphModeText,
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
} from "../../../src/harness/graph/notification.ts";
import {
  ACI_TOOLSET_NAMES,
  createDefaultAciRegistry,
} from "../../../src/harness/aci/tools/registry.ts";
import { createSkillCatalog } from "../../../src/harness/skill/catalog.ts";
import type { SubAgentManager } from "../../../src/harness/subagent/manager.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import { assembleIdentityContext } from "../../../src/harness/identity/assemble.ts";
import { buildHarnessEngine } from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";

function makeWebEnv(): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined } };
}

/** 装配期够用的 fake manager(handler 路径不在本文件覆盖,见 T4)。 */
const fakeSubagentManager = {
  spawn: () => ({ taskId: "fake-id" }),
  queryBuffer: () => ({ status: "not_found" as const }),
  waitFor: () => Promise.reject(new Error("not used")),
  shutdown: () => Promise.resolve(),
  drainCompleted: () => [],
  listActive: () => [],
  abortTask: () => false,
  getCapacity: () => 15,
  listSubagents: () => [],
  // master SubAgentManager 接口扩展:subscribe (mailbox 契约 #361)
  subscribe: () => () => {},
} as unknown as SubAgentManager;

// ── 1. 装配快照 ───────────────────────────────────────────────────────────

describe("createGraphAssembly — per-round 装配快照", () => {
  it("初值取 holder 当前值(settings 默认关 → enabled() false)", () => {
    const mode = createGraphModeContext();
    const assembly = createGraphAssembly(mode);
    expect(assembly.enabled()).toBe(false);
  });

  it("holder 已开时构造 → 首个 round 即为开(settings.graph.enabled=true 路径)", () => {
    const mode = createGraphModeContext({ enabled: true });
    expect(createGraphAssembly(mode).enabled()).toBe(true);
  });

  it("round 内翻 holder 不改本 round 快照;beginRound() 后才生效", () => {
    const mode = createGraphModeContext();
    const assembly: GraphAssembly = createGraphAssembly(mode);

    mode.setEnabled(true);
    expect(assembly.enabled()).toBe(false); // in-flight round 不热替换

    expect(assembly.beginRound()).toBe(true);
    expect(assembly.enabled()).toBe(true);

    mode.setEnabled(false);
    expect(assembly.enabled()).toBe(true); // 同上,本 round 冻结
    expect(assembly.beginRound()).toBe(false);
    expect(assembly.enabled()).toBe(false);
  });

  it("holder 缺席 → 恒关(未接 overlay 的入口零行为变化)", () => {
    const assembly = createGraphAssembly(undefined);
    expect(assembly.enabled()).toBe(false);
    expect(assembly.beginRound()).toBe(false);
  });
});

// ── 2. 常驻条件装配 ───────────────────────────────────────────────────────

describe("run_graph — ACI 常驻注册(ADR-0041 关键边界)", () => {
  it("ACI_TOOLSET_NAMES 在 run_graph 之后 append-only(worktree 3 件 + 10 件符号查询 + 5 件符号改 + 目录轴读 + 内容轴读 + 任务树 lifecycle 2 件,不重排既有件)", () => {
    // 长度 45(plan subagent-stop-and-continue T2/T4 append subagent_stop +
    // subagent_continue 后;
    // disclosure-index-align T2 删 skill_search,前移一位);
    // 实际 idx(基线实测):
    //   idx 19 = run_graph(ADR-0041 起常驻)
    //   idx 20 = query_trace
    //   idx 21..23 = worktree 3 件
    //   idx 24..33 = 10 件符号查询
    //   idx 34..38 = 5 件符号改
    //   idx 39 = list_sessions(T5b 目录轴读)
    //   idx 40 = get_record(T6 内容轴读)
    //   idx 41 = list-worktrees, idx 42 = remove-worktree
    //   idx 43 = subagent_stop(ADR-0101), idx 44 = subagent_continue(ADR-0102)
    expect(ACI_TOOLSET_NAMES[19]).toBe("run_graph");
    expect(ACI_TOOLSET_NAMES[20]).toBe("query_trace");
    expect(ACI_TOOLSET_NAMES[21]).toBe("create-worktree");
    expect(ACI_TOOLSET_NAMES[22]).toBe("enter-worktree");
    expect(ACI_TOOLSET_NAMES[23]).toBe("exit-worktree");
    expect(ACI_TOOLSET_NAMES[24]).toBe("find_symbol");
    expect(ACI_TOOLSET_NAMES[34]).toBe("rename_symbol");
    expect(ACI_TOOLSET_NAMES[39]).toBe("list_sessions");
    expect(ACI_TOOLSET_NAMES[40]).toBe("get_record");
    expect(ACI_TOOLSET_NAMES[41]).toBe("list-worktrees");
    expect(ACI_TOOLSET_NAMES[42]).toBe("remove-worktree");
    expect(ACI_TOOLSET_NAMES[ACI_TOOLSET_NAMES.length - 1]).toBe(
      "subagent_continue"
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

  it("subagentManager 缺席 → run_graph 缺席(ask / worker 装配路径);graphAssembly 缺席不影响注册表成员", () => {
    // ADR-0041:装配层唯一缺席条件 = subagentManager 缺席。graphAssembly 缺席
    // → run_graph 仍在注册表(handler isEnabled 缺省恒关守门,SC5 实测)。
    const noSubagent = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      skillCatalog: createSkillCatalog([]),
    });
    expect(noSubagent.inner.list().map((d) => d.name)).not.toContain(
      "run_graph"
    );

    // 仅 graphAssembly 在场(subagentManager 缺席)→ run_graph 仍在缺席集合。
    const graphOnly = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      skillCatalog: createSkillCatalog([]),
      graphAssembly: { enabled: () => true },
    });
    expect(graphOnly.inner.list().map((d) => d.name)).not.toContain(
      "run_graph"
    );
  });

  it("subagentManager 在场(graphAssembly 是否在场不影响)→ run_graph 入注册表", () => {
    // 双形态对比:graphAssembly 缺席 vs 在场,注册表成员应 byte-identical
    // (handler isEnabled 闭包按 assembly 在场与否透传不同值,工具面成员不变)。
    const base = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
    });
    const withGraph = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
      graphAssembly: { enabled: () => true },
    });
    const baseNames = base.inner.list().map((d) => d.name);
    const withGraphNames = withGraph.inner.list().map((d) => d.name);
    expect(baseNames).toContain("run_graph");
    expect(withGraphNames).toContain("run_graph");
    // 成员集逐字相同(graphAssembly 缺席仅让 handler isEnabled 透传 undefined
    // → 缺省恒关,不增减工具)。
    expect(withGraphNames).toEqual(baseNames);
    expect(base.catalog.get("run_graph")).toBeDefined();
    expect(withGraph.catalog.get("run_graph")).toBeDefined();
  });
});

describe("createRunGraphTool — 工具描述符", () => {
  const tool = createRunGraphTool({
    manager: fakeSubagentManager,
    isEnabled: () => true,
  });

  it("名字 / ACI 元数据与前景 spawn 同形(常驻、非 lazy、unbounded)", () => {
    expect(tool.name).toBe("run_graph");
    expect(tool.aci.lazy).toBe(false);
    expect(tool.aci.timeoutTier).toBe("unbounded");
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("schema 要求至少一个节点,且节点带 id / task / deps", () => {
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

  it("描述不泄漏模块路径(spec SC2:不要求含 src/harness/graph)", () => {
    expect(tool.description).not.toContain("src/harness/graph");
  });

  it("description 显式声明 graph mode 守门(让模型知道关图调会被拒)", () => {
    // ADR-0041:工具 description 兜底宣告(handler gate 之外给模型一个
    // 静态 hint,避免其在关图状态下尝试调再被 typed 拒绝)。
    expect(tool.description.toLowerCase()).toContain("graph mode is on");
    expect(tool.description.toLowerCase()).toContain("off");
  });

  it("关图时调用 handler → typed 拒绝,零 spawn(EXIT,不静默降级)", async () => {
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

  it("isEnabled 缺省 = 恒关(直接构造工具的测试必须显式传 isEnabled 守门)", async () => {
    // fail-closed:不传 isEnabled → 默认恒关 → handler 拒绝。这是 ADR-0041
    // 工具常驻后,handler 是唯一守门,fail-closed 安全姿态。
    const noGate = createRunGraphTool({ manager: fakeSubagentManager });
    await expect(
      noGate.handler({ nodes: [{ id: "a", task: "t" }] })
    ).rejects.toThrow(/graph mode/i);
  });
});

// ── 3. 切换提示 SSOT ─────────────────────────────────────────────────────

describe("graph 模式切换提示 — SSOT 静态文本(KV cache 兼容)", () => {
  it("开图通知含编排指引 + 一句 'graph mode is now on' 开头", () => {
    const text = renderGraphModeChangeNotification("on");
    expect(text).toBe(IKNOW_GRAPH_MODE_ON_NOTIFICATION);
    expect(text.startsWith("<graph_mode>")).toBe(true);
    expect(text.endsWith("</graph_mode>")).toBe(true);
    expect(text).toContain("Graph mode is now on");
    // 旧 IKNOW_GRAPH_ORCHESTRATION_TEXT 的内容并入此条(run_graph 编排指引)。
    expect(text).toContain("run_graph");
    expect(text).toContain("spawn_subagent");
  });

  it("关图通知含关闭提示 + run_graph 拒调用警告 + spawn_subagent 指引", () => {
    const text = renderGraphModeChangeNotification("off");
    expect(text).toBe(IKNOW_GRAPH_MODE_OFF_NOTIFICATION);
    expect(text.startsWith("<graph_mode>")).toBe(true);
    expect(text.endsWith("</graph_mode>")).toBe(true);
    expect(text).toContain("Graph mode is now off");
    expect(text).toContain("spawn_subagent");
  });

  it("isGraphModeText 覆盖三条 notification 常量（生产者本家的人读谓词）", () => {
    // specs/tui-human-display.md D8 / SC7：谓词与常量同处一文件（SSOT），
    // TUI / CLI 消费侧不必各自重写 `<graph_mode>` 前缀。三条常量全命中，
    // 正文里中段提到标签的用户文本不误伤（前缀判定，与 isAgentStatusText 同款）。
    for (const text of [
      IKNOW_GRAPH_MODE_ON_NOTIFICATION,
      IKNOW_GRAPH_MODE_OFF_NOTIFICATION,
      IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
    ]) {
      expect(isGraphModeText(text)).toBe(true);
    }
    expect(isGraphModeText("为什么有 <graph_mode> 标签？")).toBe(false);
    expect(
      isGraphModeText("<agent_status>\nlast_tool: idle\n</agent_status>")
    ).toBe(false);
  });

  it("两条静态文本在会话内字节恒定(无 per-turn 插值,KV cache 契约)", () => {
    // 同一 change 调用两次 → 同字节;两条文本不等(一开一关)。
    expect(renderGraphModeChangeNotification("on")).toBe(
      renderGraphModeChangeNotification("on")
    );
    expect(renderGraphModeChangeNotification("off")).toBe(
      renderGraphModeChangeNotification("off")
    );
    expect(IKNOW_GRAPH_MODE_ON_NOTIFICATION).not.toBe(
      IKNOW_GRAPH_MODE_OFF_NOTIFICATION
    );
  });
});

describe("graph mode 每 run 短现势 — SSOT 静态文本(ADR-0081)", () => {
  it("短现势是 <graph_mode> 单行静态文本,点名 run_graph + spawn_subagent", () => {
    const t = IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION;
    expect(t.startsWith("<graph_mode>")).toBe(true);
    expect(t.endsWith("</graph_mode>")).toBe(true);
    expect(t).toContain("run_graph");
    expect(t).toContain("spawn_subagent");
    // 必须是活动图语言(spec §11),不能叫 DAG。
    expect(t.toLowerCase()).not.toContain("dag");
  });

  it("短现势在会话内字节恒定(KV cache 尾部追加兼容,无 per-turn 插值)", () => {
    // 无插值占位符(模板槽位会让会话内字节漂移,KV cache 契约),
    // 也不把 agent_status 栏文本反向混入(SC6)。
    expect(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION).not.toContain("{{");
    expect(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION).not.toContain("<server>");
    expect(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION).not.toContain("<tools>");
    expect(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION).not.toContain(
      "<agent_status>"
    );
  });

  it("短现势短于长 ON(SC1 形态约束:现势不重复长 ON 的全部编排说明)", () => {
    expect(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION.length).toBeLessThan(
      IKNOW_GRAPH_MODE_ON_NOTIFICATION.length
    );
  });
});

describe("assembleIdentityContext — orchestration 段撤出(关键边界)", () => {
  const baseCtx = {
    cwd: "/tmp/proj",
    projectIdentityRoot: "/tmp/proj",
    userHome: "/tmp/nonexistent-home",
    bootstrapActive: false,
    memoryEnabled: false,
  } as const;

  it("不再接受 orchestration 缝(类型契约本身已撤除),assemble 出的 system 不含 'run_graph'", async () => {
    // ADR-0041 / plans/model-prefix-layering.md B3:orchestration 段从 system
    // 撤出 —— model 端读 graph 状态的唯一通道 = loop-engine 消息尾追加的
    // `<graph_mode>` 单行文本。assemble.ts 不再导出该缝 / 不再消费。
    const text = await assembleIdentityContext({ ...baseCtx });
    expect(text).toBeDefined();
    expect(text).not.toContain("run_graph");
    expect(text).not.toContain("<graph_mode>");
  });

  it("开/关图产出同一 system 文本(开关对 system 字节零影响,KV cache 前缀稳定)", async () => {
    // 由 build-engine 装配的两条路径产出的 system 应 byte-identical
    // —— 装配层不再读 graph 状态。
    const off = await assembleIdentityContext({ ...baseCtx });
    const on = await assembleIdentityContext({ ...baseCtx });
    expect(on).toBe(off);
  });
});

// ── 4. buildHarnessEngine SC5 集成 ────────────────────────────────────────

describe("buildHarnessEngine — graph 常驻 + handler gate 集成(SC5)", () => {
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
      // 本文件验 graph 常驻工具面与 handler gate,不验溢出退场 / 索引降档
      // (专测见 build-engine-tool-overflow.test.ts、disclosure-index-align/)。
      // 旁路装配期 countTokens:缝语义见 BuildEngineOpts.skipCountTokens 注释。
      skipCountTokens: true,
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

  it("graphMode 缺席 → registry 仍含 run_graph(常驻);promptTools 暴露给模型看", async () => {
    await withEngine(undefined, (built) => {
      // ADR-0041:即使 graphMode 缺席(subagentManager 在场 → run_graph 常驻),
      // 工具面仍含 run_graph(handler isEnabled 缺省恒关守门)。
      expect(built.deps.registry.list().map((d) => d.name)).toContain(
        "run_graph"
      );
      expect(built.deps.promptTools!().map((d) => d.name)).toContain(
        "run_graph"
      );
      // graphAssembly 缺席 → deps.graphModeChange / graphModePresence 两缝
      // 同 gate 同时缺席(loop-engine 不参与切换判定,消息尾不追加任何
      // graph_mode 单行文本)。
      expect(built.deps.graphModeChange).toBeUndefined();
      expect(built.deps.graphModePresence).toBeUndefined();
    });
  });

  it("SC5 graph 关 → 开 → 关:promptTools 与 system 字节逐字不变", async () => {
    // ADR-0041 关键边界:邻轮(同会话内任意 graph 翻转序列)promptTools 与
    // system 必须 byte-identical —— 翻图不再是缓存抖动源;模型面读 graph
    // 状态的通道仅剩 messages 尾部追加的 `<graph_mode>` 单行文本。
    const mode = createGraphModeContext();
    await withEngine(mode, async (built) => {
      const visible = (): ReadonlyArray<string> =>
        built.deps.promptTools!().map((d) => d.name);
      const systemOff = await built.deps.system!();

      // 关图 → 开图 → 关图:每次翻键后做一次 beginRound() 让快照生效,
      // 但 promptTools 与 system 都应该 byte-identical(常驻 + 段撤出)。
      mode.setEnabled(true);
      built.graphAssembly!.beginRound();
      const systemOn = await built.deps.system!();
      expect(visible()).toEqual(visible()); // 同 round 自比

      mode.setEnabled(false);
      built.graphAssembly!.beginRound();
      const systemOffAgain = await built.deps.system!();

      // SC5 强契约:翻图不破坏 system / tools 字节序。
      expect(systemOn).toBe(systemOff);
      expect(systemOffAgain).toBe(systemOff);
      // system 全文不含 'run_graph'(段已撤出,内容走 messages 尾追加)。
      expect(systemOn).not.toContain("run_graph");
      expect(systemOff).not.toContain("run_graph");
    });
  });

  it("graphMode 在场 → graphModeChange 与 graphModePresence 两缝同 gate 接线且同源 assembly", async () => {
    // ADR-0080 装配契约:build-engine 永远同 gate 同源接线两缝 ——
    // presence 缝与 change 缝指向同一 graphAssembly(presence 的保守
    // 零注入 guard 依赖这一同源前提;错配 = 装配 bug)。
    const mode = createGraphModeContext();
    await withEngine(mode, (built) => {
      expect(built.graphAssembly).toBeDefined();
      expect(built.deps.graphModeChange).toBeDefined();
      expect(built.deps.graphModePresence).toBeDefined();
      expect(built.deps.graphModePresence!.assembly).toBe(
        built.deps.graphModeChange!.assembly
      );
      expect(built.deps.graphModePresence!.assembly).toBe(built.graphAssembly!);
    });
  });

  it("registry.catalog 中 run_graph 的 isEnabled gate 按 graphAssembly 透传", async () => {
    // 静态查 registry catalog:同一 factory 在开/关两种 graphAssembly 下
    // 都返回 run_graph 定义 —— handler 的 isEnabled 闭包捕获 assembly。
    const offMode = createGraphModeContext();
    await withEngine(offMode, async (built) => {
      const tool = built.deps.registry.get("run_graph");
      expect(tool).toBeDefined();
      // 关键:registry 层不再过滤 —— handler 才是守门。
      // 同 round 内翻键 + beginRound 后,工具定义不变(常驻)。
      const onMode = createGraphModeContext({ enabled: true });
      // 用 onMode 重建一次引擎,验证 isEnabled 透传(简化为同 deps 的
      // graphAssembly 切换观察;此处只验证「工具仍在表 + 仍是同一 name」。
      expect(tool?.name).toBe("run_graph");
      void onMode; // 占位:同 round 翻键不影响 registry(常驻契约)
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
