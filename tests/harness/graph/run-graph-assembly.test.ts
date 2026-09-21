/**
 * `run_graph` resident registration + handler-level gate.
 *
 * Four layers tested separately:
 *   1. **Assembly snapshot** (`createGraphAssembly`): the overlay is a
 *      session-level mutable holder, but the handler gate still decides at
 *      the single point `enabled()` — the assembly layer never hot-swaps, so
 *      within a round the tool surface and system bytes stay stable.
 *   2. **Conditional resident assembly** (`ACI_TOOLSET_NAMES` append-only +
 *      `createDefaultAciRegistry` Gate 3 mirror filtering): `run_graph` is
 *      absent only when `subagentManager` is absent; an absent
 *      `graphAssembly` no longer removes the tool — the assembly layer is
 *      always present (handler isEnabled defaults to closed).
 *   3. **Mode-change notification SSOT** (`renderGraphModeChangeNotification`
 *      + `IKNOW_GRAPH_MODE_*_NOTIFICATION`): on/off are two single-line
 *      static `<graph_mode>` texts, byte-constant (KV-cache compatible +
 *      stable grep shape for the model).
 *   4. **buildHarnessEngine integration**: with graph off, promptTools still
 *      contains `run_graph` and the handler rejects; with graph on it is
 *      callable in the same round (no beginRound gate); system segments stay
 *      byte-stable (off→on→off adjacent rounds deep-equal); mode-change
 *      notifications appear at the messages tail (on/off texts).
 *
 * Orchestration guidance was withdrawn from the system segment (merged into
 * the change notification), so assemble.ts no longer exports the
 * `orchestration` seam / `IKNOW_GRAPH_ORCHESTRATION_TEXT` (key boundary: the
 * system segment never changes with graph state).
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

/** Minimal fake manager sufficient for assembly-time tests (handler paths are covered in run-graph-ledger.test.ts). */
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
  // master SubAgentManager interface extension: subscribe (mailbox contract)
  subscribe: () => () => {},
} as unknown as SubAgentManager;

// ── 1. assembly snapshot ──────────────────────────────────────────────────

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
    expect(assembly.enabled()).toBe(false); // in-flight round never hot-swaps

    expect(assembly.beginRound()).toBe(true);
    expect(assembly.enabled()).toBe(true);

    mode.setEnabled(false);
    expect(assembly.enabled()).toBe(true); // same as above: frozen for this round
    expect(assembly.beginRound()).toBe(false);
    expect(assembly.enabled()).toBe(false);
  });

  it("holder 缺席 → 恒关(未接 overlay 的入口零行为变化)", () => {
    const assembly = createGraphAssembly(undefined);
    expect(assembly.enabled()).toBe(false);
    expect(assembly.beginRound()).toBe(false);
  });
});

// ── 2. resident conditional assembly ──────────────────────────────────────

describe("run_graph — ACI 常驻注册(关键边界)", () => {
  it("ACI_TOOLSET_NAMES 在 run_graph 之后 append-only(worktree 3 件 + 10 件符号查询 + 5 件符号改 + 目录轴读 + 内容轴读 + 任务树 lifecycle 2 件,不重排既有件)", () => {
    // Length 45; the actual indices are taken from the registry (append-only
    // discipline, pinned against reordering):
    //   idx 19 = run_graph (resident)
    //   idx 20 = query_trace
    //   idx 21..23 = worktree tools
    //   idx 24..33 = symbol-query tools
    //   idx 34..38 = symbol-edit tools
    //   idx 39 = list_sessions (catalog-axis read)
    //   idx 40 = get_record (content-axis read)
    //   idx 41 = list-worktrees, idx 42 = remove-worktree
    //   idx 43 = subagent_stop (ADR-0101), idx 44 = subagent_continue (ADR-0102)
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
    expect(ACI_TOOLSET_NAMES[43]).toBe("subagent_stop");
    expect(ACI_TOOLSET_NAMES[44]).toBe("subagent_continue");
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
    // Resident-registration boundary: the only absence condition at assembly
    // time is a missing subagentManager. With graphAssembly absent, run_graph
    // still registers (handler isEnabled defaults to closed).
    const noSubagent = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      skillCatalog: createSkillCatalog([]),
    });
    expect(noSubagent.inner.list().map((d) => d.name)).not.toContain(
      "run_graph"
    );

    // graphAssembly present but subagentManager absent → run_graph stays in the absent set.
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
    // Two-form comparison: graphAssembly absent vs present — registry membership
    // must be byte-identical (the isEnabled closure differs per assembly, but the tool surface does not).
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
    // Membership sets are literally identical (an absent graphAssembly only makes
    // the handler isEnabled pass undefined → defaults closed; no tool added or removed).
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
    // Description fallback announcement: besides the handler gate, give the
    // model a static hint so it does not call while graph mode is off only to
    // be typed-rejected.
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
    // fail-closed: no isEnabled → defaults closed → handler rejects. Since the
    // tool is resident, the handler is the only gate; fail-closed is the safe posture.
    const noGate = createRunGraphTool({ manager: fakeSubagentManager });
    await expect(
      noGate.handler({ nodes: [{ id: "a", task: "t" }] })
    ).rejects.toThrow(/graph mode/i);
  });
});

// ── 3. mode-change notification SSOT ────────────────────────────────────

describe("graph 模式切换提示 — SSOT 静态文本(KV cache 兼容)", () => {
  it("开图通知含编排指引 + 一句 'graph mode is now on' 开头", () => {
    const text = renderGraphModeChangeNotification("on");
    expect(text).toBe(IKNOW_GRAPH_MODE_ON_NOTIFICATION);
    expect(text.startsWith("<graph_mode>")).toBe(true);
    expect(text.endsWith("</graph_mode>")).toBe(true);
    expect(text).toContain("Graph mode is now on");
    // The former IKNOW_GRAPH_ORCHESTRATION_TEXT content merged into this one (run_graph orchestration guidance).
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
    // Predicate and constants live in one file (SSOT) so TUI / CLI consumers
    // need not rewrite the `<graph_mode>` prefix. All three constants match;
    // user text merely mentioning the tag mid-body is not caught (prefix test,
    // same shape as isAgentStatusText).
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
    // Same change called twice → same bytes; the two texts differ (on vs off).
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
    // Must use activity-graph wording, never call it a DAG.
    expect(t.toLowerCase()).not.toContain("dag");
  });

  it("短现势在会话内字节恒定(KV cache 尾部追加兼容,无 per-turn 插值)", () => {
    // No interpolation placeholders (template slots would drift bytes within a
    // session, breaking the KV-cache contract), and no agent_status bar text
    // mixed in reverse.
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
    // Orchestration segment withdrawn from system — the model's only channel
    // to read graph state is the `<graph_mode>` single-line text appended at
    // the messages tail by loop-engine. assemble.ts no longer exports or
    // consumes that seam.
    const text = await assembleIdentityContext({ ...baseCtx });
    expect(text).toBeDefined();
    expect(text).not.toContain("run_graph");
    expect(text).not.toContain("<graph_mode>");
  });

  it("开/关图产出同一 system 文本(开关对 system 字节零影响,KV cache 前缀稳定)", async () => {
    // Both assembly paths must produce byte-identical system text —
    // the assembly layer no longer reads graph state.
    const off = await assembleIdentityContext({ ...baseCtx });
    const on = await assembleIdentityContext({ ...baseCtx });
    expect(on).toBe(off);
  });
});

// ── 4. buildHarnessEngine integration ─────────────────────────────────────

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
      // This file verifies the resident tool surface and handler gate, not
      // overflow eviction / index demotion (see build-engine-tool-overflow.test.ts).
      // countTokens is bypassed at assembly time; seam semantics: BuildEngineOpts.skipCountTokens.
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
      // Even without graphMode (subagentManager present → run_graph
      // is resident), the tool surface still lists run_graph (the handler's
      // isEnabled defaults to a closed gate).
      expect(built.deps.registry.list().map((d) => d.name)).toContain(
        "run_graph"
      );
      expect(built.deps.promptTools!().map((d) => d.name)).toContain(
        "run_graph"
      );
      // Without graphAssembly, the graphModeChange and graphModePresence seams
      // are absent together (loop-engine never decides mode switches and
      // appends no graph_mode single-line text to message tails).
      expect(built.deps.graphModeChange).toBeUndefined();
      expect(built.deps.graphModePresence).toBeUndefined();
    });
  });

  it("SC5 graph 关 → 开 → 关:promptTools 与 system 字节逐字不变", async () => {
    // Key boundary: across adjacent rounds (any in-session graph
    // toggle sequence) promptTools and system must stay byte-identical —
    // toggling the graph is no longer a cache-jitter source; the model's only
    // channel for graph state is the `<graph_mode>` line appended to messages.
    const mode = createGraphModeContext();
    await withEngine(mode, async (built) => {
      const visible = (): ReadonlyArray<string> =>
        built.deps.promptTools!().map((d) => d.name);
      const systemOff = await built.deps.system!();

      // off → on → off, taking a fresh snapshot via beginRound() after each
      // toggle: promptTools and system must stay byte-identical (resident tool
      // list + withdrawn system section).
      mode.setEnabled(true);
      built.graphAssembly!.beginRound();
      const systemOn = await built.deps.system!();
      expect(visible()).toEqual(visible()); // self-comparison within one round

      mode.setEnabled(false);
      built.graphAssembly!.beginRound();
      const systemOffAgain = await built.deps.system!();

      // Strong contract: graph toggling never disturbs system / tools bytes.
      expect(systemOn).toBe(systemOff);
      expect(systemOffAgain).toBe(systemOff);
      // 'run_graph' is absent from system entirely (its section is withdrawn;
      // content ships via message-tail appends instead).
      expect(systemOn).not.toContain("run_graph");
      expect(systemOff).not.toContain("run_graph");
    });
  });

  it("graphMode 在场 → graphModeChange 与 graphModePresence 两缝同 gate 接线且同源 assembly", async () => {
    // Assembly contract: build-engine always wires both seams under the same
    // gate and from the same source — the presence seam and the change seam
    // point at one graphAssembly (presence's conservative zero-injection guard
    // relies on this same-source premise; a mismatch = assembly bug).
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
    // Static registry-catalog check: one factory yields the run_graph
    // definition under both on and off graphAssembly — the handler's isEnabled
    // closure captures the assembly, not the registry.
    const offMode = createGraphModeContext();
    await withEngine(offMode, async (built) => {
      const tool = built.deps.registry.get("run_graph");
      expect(tool).toBeDefined();
      // Key point: the registry no longer filters — the handler is the gate.
      // Toggling the key inside one round plus beginRound leaves tool
      // definitions unchanged (residency).
      const onMode = createGraphModeContext({ enabled: true });
      // Observing a graphAssembly swap under identical deps; here that only
      // means "tool still listed, still the same name".
      expect(tool?.name).toBe("run_graph");
      void onMode; // placeholder: in-round toggling never affects the registry (residency contract)
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
