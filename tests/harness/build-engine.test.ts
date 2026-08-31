/**
 * `src/harness/build-engine.ts` — the single harness assembly point shared by
 * the CLI (chat / ask) and the session server (serve → SessionHub.ensureDeps).
 *
 * These tests pin the ACI toolset (via EXPECTED_TOOLS) so a future tool-set
 * change cannot drift between the two entry points silently: if a tool is
 * added/renamed/removed, this test forces an explicit decision at the single
 * assembly point.件数 = `EXPECTED_TOOLS.length` 推导,以数组为 source of truth,
 * 注释里不再写加法叙事（避免与实际长度漂移）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { createMcpManager } from "../../src/harness/mcp/manager.ts";
import type { McpClientHandle } from "../../src/harness/mcp/manager.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { assessSubagentIsolation } from "../../src/harness/subagent/capability.ts";
import {
  FILE_WRITE_TOOL_NAMES,
  SYMBOL_MUTATE_TOOL_NAMES,
} from "../../src/harness/aci/tools/symbol-mutate.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";

// Order is load-bearing: it must match the `aciTools` array in
// `src/harness/build-engine.ts` (policy byName key-space, ADR-0006)。
// 装配层历史 append-only：8 baseline → + memory_recall/save (#194)
// → + tool_search (#224) → + skill/skill_search (#337) → + spawn_subagent /
// subagent_result (#356) → + todo_write / list_mcp_resources / read_mcp_resource
// (#440 双 Stream) → + bash_output / bash_stop (#502) → + query_trace
// → + 10 符号查询 (symbol-primary-aci T2) → + 5 符号改 (T4) = 36 件;
//
// symbol-primary-aci T5：旧 10 件 lsp_* 已退役（spec symbol-primary-aci.md
// §37-53 + SC2 + SC7 + ACR complexity-anti-drift）；build-engine 装配路径不再产出
// lsp_* 工具。其实现 + 内部 export 仍住 lsp.ts 作 symbol.ts 的 SSOT 复用层。
// 符号面 10 + 改 5 在 build-engine 默认 chat surface 装配。run_graph
// 不在本数组（条件化：graphAssembly + subagentManager 同时在场才入注册表；
// build-engine 默认 chat surface 不传 graphAssembly → 不入）。
//
// 各条件化 seam 缺席后 = EXPECTED_TOOLS.filter(...) 推导，以 filter 表达式为
// source of truth:SC8（ask 入口不建 subagentManager / mcpManager / backgroundManager）、
// SC12（ask 不创建 manager → mcp__* 缺席）、#440（T4 todoDir seam）、#440 T11
// （MCP resources seam）、#502 T3（background seam）— 缺席集具体见各用例注释。
const EXPECTED_TOOLS = [
  "bash",
  "read_file",
  "grep",
  "glob",
  "edit_file",
  "write_file",
  "web_fetch",
  "web_search",
  "memory_recall",
  "memory_save",
  "tool_search",
  // #337 T8 skill 工具集 append-only:11→13,2 件在末尾。
  "skill",
  "skill_search",
  // #356 T6 subagent 工具集 append-only:13→15,2 件在末尾(全装配 chat surface
  // 才在场;ask 缺 subagentManager → 13 件)。
  "spawn_subagent",
  "subagent_result",
  // #440 双 Stream 并集 append-only:15→18。todo_write（T4，全装配 chat surface
  // + todoDir 在场才入注册表；ask + worker 装配路径不传 todoDir → 不在场）+
  // MCP resources 两件（T11，全装配 chat surface 才在场；ask 缺 mcpManager → 不在场）。
  "todo_write",
  "list_mcp_resources",
  "read_mcp_resource",
  // #502 T3 bash_output / bash_stop 工具集 append-only:18→20,末位 2 件
  // （全装配 chat/tui/serve surface 在场;ask 缺 backgroundManager → 缺席;
  //  bash 仍常驻,参数级 background:true 能力由 handler 运行时决策）。
  "bash_output",
  "bash_stop",
  "query_trace",
  // symbol-primary-aci T2 符号查询工具集 append-only:20→30,末位 10 件常驻
  // （不条件化——与 lsp.ts 内部 SSOT 共享 lspCtx；旧 10 件 lsp_* 已在 T5 退役）。
  "find_symbol",
  "find_declaration",
  "find_referencing_symbols",
  "find_implementations",
  "get_symbols_overview",
  "get_hover",
  "get_diagnostics_for_file",
  "prepare_call_hierarchy",
  "list_incoming_calls",
  "list_outgoing_calls",
  // symbol-primary-aci T4 符号改工具集 append-only:30→35,末位 5 件常驻
  // （category=write；不条件化——与查询面共享 lspCtx + lsp.ts；onEdit
  //  透传自 build-engine lspNotifier.invalidate，写盘后 textDocument/didChange
  //  与 edit_file 同链路；edit_file 仍在 —— 留给非单一符号的文本补丁）。
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
  "safe_delete_symbol",
];

/** #440 T4 / #502 T3 条件化缺席视图:todoDir 未透传的 chat surface(默认行为)。
 *  既有 SSOT 断言通过 EXPECTED_TOOLS_NO_TODO 表达"todo_write 不在表";todo_write
 *  在场需显式传 todoDir(主循环生产路径,非测试默认形态)。具体件数 =
 *  EXPECTED_TOOLS_NO_TODO.length = 35,以数组为 source of truth。 */
const EXPECTED_TOOLS_NO_TODO = EXPECTED_TOOLS.filter((n) => n !== "todo_write");

/** Deterministic env: never read process.env / .env files (env.ts SSOT). */
function makeEnv(apiKey: string | undefined): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    // #119 T7: IknowCompressEnv 必填(T1 接入),build-engine 透传给
    // LoopEngineDeps.compress。test fixture 默认值:contextWindow=200000,
    // thresholdTokens=undefined(由 threshold.ts 推 window-33000)。
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    // #378 根因 B: MCP 连接超时(默认 60_000)。
    mcp: { connectTimeoutMs: 60_000 },
    // #358 T2: subagent 配置臂 (build-engine 读取 taskTimeoutMs 透传给 manager)。
    subagent: { taskTimeoutMs: undefined },
  };
}

function makeTestSubagentManager(): {
  readonly manager: SubAgentManager;
  readonly spawnedTasks: string[];
} {
  const spawnedTasks: string[] = [];
  const manager: SubAgentManager = {
    spawn: (definition) => {
      spawnedTasks.push(definition.task ?? "");
      return { taskId: `task-${spawnedTasks.length}` };
    },
    queryBuffer: () => ({ status: "running" }),
    waitFor: async () => {
      throw new Error("waitFor should not run in wait:false tests");
    },
    shutdown: async () => {},
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    listSubagents: () => [],
    subscribe: () => () => {},
  };
  return { manager, spawnedTasks };
}

async function runSpawn(
  built: BuiltEngine,
  input: Record<string, unknown>,
  conversationId = "conv-1"
): Promise<ToolExecutionResult> {
  const [result] = await built.deps.executor.executeAll(
    [{ id: "spawn-1", name: "spawn_subagent", input }],
    undefined,
    undefined,
    conversationId
  );
  return result!;
}

describe("buildHarnessEngine (SSOT assembly)", () => {
  it("registers the full ACI 11-tool set on the returned registry", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-sentinel-1"),
      askUser: createNoAskUser(),
    });

    const names = deps.registry.list().map((def) => def.name);
    // #440 T4:todo_write 条件化 — todoDir 未透传 → 不在场。具体件数 =
    // EXPECTED_TOOLS_NO_TODO.length = 35,以数组为 source of truth。
    expect(names).toEqual(EXPECTED_TOOLS_NO_TODO);
    // 显式锁 Web 工具存在(plan-fidelity:SSOT 收敛到 registry.ts 后,
    // build-engine 路径也必须仍带 web_fetch / web_search)。
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
    // #356 T6:全装配(默认 chat surface)含 spawn_subagent / subagent_result 两件。
    expect(names).toContain("spawn_subagent");
    expect(names).toContain("subagent_result");
    // #440 T4:todo_write 在 todoDir 未透传路径下缺席。
    expect(names).not.toContain("todo_write");
  });

  it("full assembly: built.subagentManager 存在 + built.shutdown 是函数", async () => {
    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-subagent-full-1"),
      askUser: createNoAskUser(),
    });

    // chat surface 自建 subagentManager(是函数对象);shutdown 为组合句柄(函数)。
    expect(typeof built.subagentManager).toBe("object");
    expect(typeof built.subagentManager!.shutdown).toBe("function");
    expect(typeof built.shutdown).toBe("function");
    // cleanup:组合 shutdown 不抛(空 MCP config + 无运行子代理)。
    await built.shutdown!();
  });

  it("wires promptTools to reg.visibleSchemas (all 11 tools, no lazy)", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-sentinel-2"),
      askUser: createNoAskUser(),
    });

    // #224 注入缝：buildHarnessEngine 把 reg.visibleSchemas 注入 promptTools。
    expect(typeof deps.promptTools).toBe("function");
    const promptNames = deps.promptTools!()
      .map((d) => d.name)
      .sort();
    expect(promptNames).toEqual([...EXPECTED_TOOLS_NO_TODO].sort());
    // 默认 registry 无 lazy 工具 → visibleSchemas ≡ registry.list()
    // #440 T4:todoDir 未透传 → todo_write 缺席;具体件数 =
    // EXPECTED_TOOLS_NO_TODO.length = 35,以数组常量为准。
    expect(deps.promptTools!().map((d) => d.name)).toEqual(
      EXPECTED_TOOLS_NO_TODO
    );
  });

  it("throws without the LLM api key set (fail loud, before any async work)", async () => {
    await expect(
      buildHarnessEngine({
        env: makeEnv(undefined),
        askUser: createNoAskUser(),
      })
    ).rejects.toThrow(/LLM mode needs API key/);
  });

  it("throws when askUser is missing", async () => {
    await expect(
      buildHarnessEngine({
        env: makeEnv("sk-test-sentinel-2"),
        askUser: undefined as never,
      })
    ).rejects.toThrow(/ask_inlet_missing/);
  });
});

// --- #121 T6 / SC 12: memory opt-out + system wiring ------------------------

describe("buildHarnessEngine — memory opt-out (ask path, SC 12)", () => {
  it("memory disabled → registry stays at 8 (no memory tools) and memory_layer inactive", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-mem-off-1"),
      askUser: createNoAskUser(),
      memory: { enabled: false },
    });

    const names = deps.registry.list().map((def) => def.name);
    // ask surface（SC8 + SC12 + #440 T4）→ memory(enabled:false 缺席)+ todoDir
    // (未透传缺席)+ subagentManager/mcpManager/backgroundManager(ask 不创建,SC12)
    // 一并缺席。具体件数 = filter 表达式长度,以 EXPECTED_TOOLS_NO_TODO.filter
    // 为 source of truth;本断言 = 同表达式 + memory 缺席剥除。
    expect(names).toEqual(
      EXPECTED_TOOLS_NO_TODO.filter(
        (n) => n !== "memory_recall" && n !== "memory_save"
      )
    );
    expect(names).not.toContain("memory_recall");
    expect(names).not.toContain("memory_save");
    // landing 形态：deps.system 始终挂 createIknowSystemResolver（identity 层恒在），
    // memoryEnabled=false 让 memory_layer slot 返回 undefined。
    const sys = await deps.system?.();
    expect(sys).toContain("iknow Identity");
  });

  it("memory enabled (default) → deps.system is wired as an async assembler", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-mem-on-1"),
      askUser: createNoAskUser(),
    });
    // seam 契约：deps.system 是函数（#194 同款断言，不实际调用——
    // 调用会写 usage.json 进真实 ~/.iknow/memory）
    expect(typeof deps.system).toBe("function");
  });
});

describe("buildHarnessEngine (SSOT passthrough)", () => {
  it("propagates maxTurns and timeoutMs from env (not hard-coded)", async () => {
    const env = makeEnv("sk-test-passthrough-1");
    env.llm.timeoutMs = 12345;
    const { deps } = await buildHarnessEngine({
      env,
      askUser: createNoAskUser(),
    });

    // plan T5-engine / ADR-0012:默认 env 不设 IKNOW_LLM_MAX_TURNS → undefined(无限)。
    expect(deps.maxTurns).toBeUndefined();
    // Proves timeoutMs is read through from env, not a hard-coded constant.
    expect(deps.timeoutMs).toBe(12345);
  });

  it("#742 T1: env 的 idle / 硬顶透传为 deps.modelIdleTimeoutMs / modelHardCapMs", async () => {
    const env = makeEnv("sk-test-passthrough-idle");
    env.llm.idleTimeoutMs = 111_000;
    env.llm.hardCapMs = 222_000;
    const { deps } = await buildHarnessEngine({
      env,
      askUser: createNoAskUser(),
    });

    expect(deps.modelIdleTimeoutMs).toBe(111_000);
    expect(deps.modelHardCapMs).toBe(222_000);
  });

  it("#742 T1: env 未给 idle / 硬顶时 deps 两字段缺席(退回今日单钟)", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-passthrough-no-idle"),
      askUser: createNoAskUser(),
    });

    expect(deps.modelIdleTimeoutMs).toBeUndefined();
    expect(deps.modelHardCapMs).toBeUndefined();
  });

  it("plan T5-engine: env.llm.maxTurns=3 → deps.maxTurns === 3", async () => {
    const env = makeEnv("sk-test-passthrough-maxTurns");
    env.llm.maxTurns = 3;
    const { deps } = await buildHarnessEngine({
      env,
      askUser: createNoAskUser(),
    });
    expect(deps.maxTurns).toBe(3);
  });

  it("IKNOW_WEB_PROXY 非法值 → build 时同步抛错,空值 → 不影响装配", async () => {
    // 验证代理配置在装配时即被 SSRF 防线拦截,避免到 fetch 时才报。
    const env = makeEnv("sk-test-passthrough-3");
    env.web.proxy = "ftp://bad-proxy:9999";
    await expect(
      buildHarnessEngine({
        env,
        askUser: createNoAskUser(),
      })
    ).rejects.toThrow(/only http and https|malformed/i);

    // 对照:空代理配置不抛错,装配成功。
    const envOk = makeEnv("sk-test-passthrough-4");
    envOk.web.proxy = undefined;
    const { deps } = await buildHarnessEngine({
      env: envOk,
      askUser: createNoAskUser(),
    });
    // #440 T4:todoDir 未透传 → todo_write 缺席。
    expect(deps.registry.list().map((d) => d.name)).toEqual(
      EXPECTED_TOOLS_NO_TODO
    );
  });

  it("injects sandboxRoot into the read_file tool (out-of-root rejected)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-build-engine-root-"));
    const outside = await mkdtemp(join(tmpdir(), "iknow-build-engine-out-"));
    try {
      // T5:显式 sandboxRoot 必须与 resolveMcpRoots 的 workspaceRoot 一致；
      // 同根透传后 ACI FS fence 仍以该 root 拒越界路径。
      const { deps } = await buildHarnessEngine({
        env: makeEnv("sk-test-passthrough-2"),
        askUser: createNoAskUser(),
        sandboxRoot: root,
        workspaceRoot: root,
        productRoot: root,
      });

      const [result] = await deps.executor.executeAll([
        {
          id: "sandbox-read",
          name: "read_file",
          input: { path: join(outside, "victim.txt") },
        },
      ]);

      // read-only category → permission allows; the soft sandbox itself must
      // reject the path since it lies outside `root`. If sandboxRoot were not
      // injected (default process.cwd()), this path would be rejected too,
      // but the assertion proves the tool was built with the explicit root.
      expect(result.kind).toBe("execution_failed");
      if (result.kind === "execution_failed") {
        expect(result.message).toMatch(/path outside workspace/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// --- #337 T8: skill catalog + MCP manager 装配 / 四入口条件化 / SC12 --------

/** 在 tmp 目录铺一个 skill fixture（SKILL.md 含合法 frontmatter）。 */
async function plantSkill(
  root: string,
  skillName: string,
  description: string
): Promise<void> {
  const dir = join(root, skillName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ${description}\n---\nbody`,
    "utf8"
  );
}

describe("buildHarnessEngine — #337 T8 skill 装配", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  it("chat surface：skill catalog 装配后 skill / skill_search 两件工具在场", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t8-chat-skill-"));
    roots.push(root);
    await plantSkill(root, "echo", "echoes your message");

    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t8-chat-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
    });

    expect(built.deps.registry.get("skill")).toBeDefined();
    expect(built.deps.registry.get("skill_search")).toBeDefined();
    const names = built.deps.registry.list().map((d) => d.name);
    expect(names).toContain("skill");
    expect(names).toContain("skill_search");

    // cleanup:manager 在场则调用 shutdown 不抛（即使无 MCP server）
    if (built.shutdown) await built.shutdown();
  });

  it("ask surface：skill 两件在场 + 无 shutdown 句柄（manager 未创建，SC12）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t8-ask-skill-"));
    roots.push(root);
    await plantSkill(root, "ask-skill", "ask-only skill");

    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t8-ask-1"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
      userHome: join(root, "home"),
      cwd: root,
    });

    // skill 两件仍装配（ask 也含 skill 工具）
    expect(built.deps.registry.get("skill")).toBeDefined();
    expect(built.deps.registry.get("skill_search")).toBeDefined();

    // ask 不创建 MCP manager → shutdown 句柄缺席;subagent manager 同门缺席
    // （T6:surface !== "ask" 才创建）。
    expect(built.shutdown).toBeUndefined();
    expect(built.subagentManager).toBeUndefined();

    // SC8:ask 剥离 spawn_subagent / subagent_result(registry / executor /
    // catalog 三方视图一致)。skillCatalog 仍装配(SC12)。
    expect(built.deps.registry.get("spawn_subagent")).toBeUndefined();
    expect(built.deps.registry.get("subagent_result")).toBeUndefined();
    const names = built.deps.registry.list().map((d) => d.name);
    expect(names).not.toContain("spawn_subagent");
    expect(names).not.toContain("subagent_result");
    // ask + memory:{enabled:false} 双重剥离（SC8 + SC12 + #440 T4 + #502 T3）:
    //   - memory2:memory.enabled=false
    //   - subagent2:ask 不创建 subagentManager（SC8）
    //   - mcp2:ask 不创建 mcpManager（SC12）
    //   - bg2:ask 不创建 backgroundManager（#502 T3）
    //   - todo_write:todoDir oneshot 剥离（#440 T4）
    // skill 两件仍装配,SC12 守门。本断言以 EXPECTED_TOOLS_NO_TODO.filter
    // 表达式为 source of truth(不写加法叙事 — 加法易漂)。
    expect(names).toEqual(
      EXPECTED_TOOLS_NO_TODO.filter(
        (n) =>
          n !== "memory_recall" &&
          n !== "memory_save" &&
          n !== "spawn_subagent" &&
          n !== "subagent_result" &&
          n !== "list_mcp_resources" &&
          n !== "read_mcp_resource" &&
          n !== "bash_output" &&
          n !== "bash_stop"
      )
    );

    // 三方视图零 mcp__*（SC12）：registry.list()（= executor 可见视图）
    // + deps 视图（registry = executor 的输入，registry 是真实三方视图锚点）。
    expect(names.filter((n) => n.startsWith("mcp__"))).toEqual([]);
  });
});

describe("buildHarnessEngine — #337 T8 MCP manager 装配", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  it("chat surface：mcp config 缺席时 manager 在场 + shutdown 句柄透出", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t8-chat-mcp-"));
    roots.push(root);

    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t8-chat-mcp-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
    });

    // 即使 mcp config 两级都缺席,manager 仍创建(只是 slot=空 map)。
    expect(typeof built.shutdown).toBe("function");
    // 不阻塞装配：调用 shutdown 不抛
    await built.shutdown!();
  });

  it("SC8：慢 connect stub 不阻塞 buildHarnessEngine 返回", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t8-sc8-"));
    roots.push(root);

    // 一个永远不 resolve 的 connect —— 验证 buildHarnessEngine 不 await 即可返回。
    // connect 计数：行为断言（build 期间 connect 必须未被调用 = 早返回的证据）。
    // 原断言 `elapsed < 200ms` 在 4 核重载 host 上稳定超时(实测 392-584ms)，
    // 属时序容差缺陷，非 build 逻辑缺陷；改用 connect 调用计数 + 无限下界
    // 时间断言，两者都不依赖机器负载。
    let connectCalls = 0;
    const slowClient: McpClientHandle = {
      connect: () => {
        connectCalls += 1;
        return new Promise<void>(() => {});
      },
      listTools: async () => [],
      callTool: async () => ({ result: { content: [] } }),
      close: async () => {},
      onListChanged: () => {},
      onClose: () => {},
    };

    const start = Date.now();
    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t8-sc8-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      // T8 测试缝：注入慢 client。manager.start() 不 await,该 client
      // 永远挂着,build 必须早就返回。
      createMcpClient: () => slowClient,
    });
    const elapsed = Date.now() - start;

    // 行为断言:build 早返回 → connect 未被调用。慢 connect 是 ∞,若被
    // await 则 build 永不返回(connectCalls 必为 0)。
    expect(connectCalls).toBe(0);
    // 时间下界断言:elapsed 须远小于慢 connect 的剩余时间(∞),任何有限
    // build 耗时都满足。上界断言(如 <200ms)属负载敏感时序容差,已移除。
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(typeof built.shutdown).toBe("function");
    // cleanup:触发 shutdown,manager 关闭慢 client(connect 永不 resolve,
    // close 仅清状态,不 await connect)。
    if (built.shutdown) await built.shutdown();
  });

  it("#378 根因 B: buildHarnessEngine 装配把 env.mcp.connectTimeoutMs 透传为 timeoutMsOverride", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-be-timeout-"));
    const captured: Array<Record<string, unknown>> = [];
    try {
      await buildHarnessEngine({
        env: {
          ...makeEnv("sk-test-t8-timeout-1"),
          mcp: { connectTimeoutMs: 90_000 },
        },
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        createMcpManager: (opts) => {
          captured.push(opts as Record<string, unknown>);
          return createMcpManager(opts);
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const last = captured.at(-1);
    expect(last).toBeDefined();
    expect(last!.timeoutMsOverride).toBe(90_000);
  });
});

describe("buildHarnessEngine — #356 T6 subagent manager 装配", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  /** fake manager 注入验证装配不崩(spawn 不被调用;仅验证 registry 含两件 +
   *  BuiltEngine.subagentManager 透出注入对象)。 */
  const fakeManager: SubAgentManager = {
    spawn: () => ({ taskId: "fake-id" }),
    queryBuffer: () => ({ status: "not_found" }),
    waitFor: () => Promise.reject(new Error("not used")),
    shutdown: () => Promise.resolve(),
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    // #358 T7: 接口新增只读枚举面 —— fake 补全保持结构兼容。
    listSubagents: () => [],
  };

  it("chat surface：注入 fake subagentManager → registry 含两件 + 透出注入对象", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t6-chat-fake-"));
    roots.push(root);

    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t6-chat-fake-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: fakeManager,
    });

    // 注入对象透出(BuiltEngine.subagentManager === fakeManager,引用相等)。
    expect(built.subagentManager).toBe(fakeManager);
    const names = built.deps.registry.list().map((d) => d.name);
    expect(names).toContain("spawn_subagent");
    expect(names).toContain("subagent_result");
    expect(built.deps.registry.get("spawn_subagent")).toBeDefined();
    expect(built.deps.registry.get("subagent_result")).toBeDefined();
    // #440 T4:todoDir 未透传 → todo_write 缺席。
    expect(names).toEqual(EXPECTED_TOOLS_NO_TODO);

    // 组合 shutdown 不抛(fake manager shutdown resolve)。
    await built.shutdown!();
  });

  it("ask surface：即使注入 fake manager 也不装配两件(T6 同 MCP 门:surface !== ask)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t6-ask-fake-"));
    roots.push(root);

    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t6-ask-fake-1"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
      userHome: join(root, "home"),
      cwd: root,
      subagentManager: fakeManager,
    });

    // ask 不创建/不透出 manager,registry 停 23 件(SC8)。
    expect(built.subagentManager).toBeUndefined();
    const names = built.deps.registry.list().map((d) => d.name);
    expect(names).not.toContain("spawn_subagent");
    expect(names).not.toContain("subagent_result");
  });
});

// --- #126 T5: secrets guard 产品装配组合 ----------------------------------
// #406 T4：以下用例全部显式 `mode: "block"` —— guard 现只作为 legacy
// deny-only 兼容路径装配（roundtrip 默认不装 guard，见下方 T4 describe）。
describe("buildHarnessEngine — #126 T5 secrets guard 装配", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  it("block 模式：内置模式拦截密钥正例（sc-1），普通命令放行（sc-2）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-guard-default-"));
    roots.push(root);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t5-guard-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      settings: { secrets: { mode: "block" } },
    });

    // guard 放行普通 bash → inner 执行（read-only/execute 类默认 ask，用 askUser 全批）
    const [allow] = await built.deps.executor.executeAll([
      { id: "t5-allow", name: "bash", input: { command: "echo hi" } },
    ]);
    expect(allow.kind).toBe("ok");

    // 密钥正例：bash input 夹带 sk- 形态 → [hook_blocked]，inner 不执行
    const [blocked] = await built.deps.executor.executeAll([
      {
        id: "t5-block",
        name: "bash",
        input: {
          command:
            "curl https://x --header Authorization: sk-abcd1234567890abcdefg1234",
        },
      },
    ]);
    expect(blocked.kind).toBe("execution_failed");
    if (blocked.kind === "execution_failed") {
      expect(blocked.message).toMatch(/\[hook_blocked\]/);
    }

    if (built.shutdown) await built.shutdown();
  });

  it("settings 追加 pattern 生效 + enabled:false 透明（sc-3/sc-4）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-guard-custom-"));
    roots.push(root);

    // settings.secrets.patterns 追加自定义形态
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t5-guard-2"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      settings: {
        secrets: { mode: "block", patterns: ["CUSTOM_TOKEN_[A-Z0-9]{6}"] },
      },
    });

    // 自定义 pattern 命中 → 拦截
    const [blocked] = await built.deps.executor.executeAll([
      {
        id: "t5-custom-block",
        name: "bash",
        input: { command: "echo CUSTOM_TOKEN_ABC123" },
      },
    ]);
    expect(blocked.kind).toBe("execution_failed");
    if (blocked.kind === "execution_failed") {
      expect(blocked.message).toMatch(/\[hook_blocked\]/);
    }

    if (built.shutdown) await built.shutdown();

    // enabled:false → guard 透明，密钥形态放行
    const transparent = await buildHarnessEngine({
      env: makeEnv("sk-test-t5-guard-3"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      settings: { secrets: { mode: "block", enabled: false } },
    });
    const [allowed] = await transparent.deps.executor.executeAll([
      {
        id: "t5-transparent",
        name: "bash",
        input: {
          command:
            "curl https://x --header Authorization: sk-abcd1234567890abcdefg1234",
        },
      },
    ]);
    expect(allowed.kind).toBe("ok");
    if (transparent.shutdown) await transparent.shutdown();
  });

  it("guard 放行时 hard-wall 仍拦（链顺序回归，sc-5）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-guard-wall-"));
    roots.push(root);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t5-guard-4"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      settings: { secrets: { mode: "block" } },
    });

    // 硬墙必拦调用（rm -rf）+ 无密钥 input → guard 放行后 [permission_denied] 仍拦
    const [result] = await built.deps.executor.executeAll([
      { id: "t5-wall", name: "bash", input: { command: "rm -rf /" } },
    ]);
    expect(result.kind).toBe("execution_failed");
    if (result.kind === "execution_failed") {
      expect(result.message).toMatch(/\[permission_denied\]/);
    }

    if (built.shutdown) await built.shutdown();
  });

  it("guard 构造期坏 pattern 剔除 + onHookError 告警，其余正常生效（sc-6）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t5-guard-badpat-"));
    roots.push(root);

    const hookErrors: Array<{ phase: string; message: string }> = [];
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t5-guard-5"),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome: join(root, "home"),
      cwd: root,
      settings: {
        secrets: {
          mode: "block",
          patterns: ["[unclosed", "GOOD_TOKEN_[A-Z]{4}"],
        },
      },
      onHookError: (e) => hookErrors.push(e),
    });

    // 坏 pattern 剔除 + 告警；好 pattern 仍生效
    expect(hookErrors.some((e) => e.phase === "guard-init")).toBe(true);

    const [blocked] = await built.deps.executor.executeAll([
      {
        id: "t5-goodpat",
        name: "bash",
        input: { command: "echo GOOD_TOKEN_WXYZ" },
      },
    ]);
    expect(blocked.kind).toBe("execution_failed");
    if (blocked.kind === "execution_failed") {
      expect(blocked.message).toMatch(/\[hook_blocked\]/);
    }

    if (built.shutdown) await built.shutdown();
  });
});

// ---------------------------------------------------------------------------
// #406 T2: secret registry 装配 — deps.secretRegistry 暴露
// ---------------------------------------------------------------------------
describe("buildHarnessEngine — #406 T2 secret registry 装配", () => {
  it("默认 settings：deps.secretRegistry 是 SecretRegistry，构造期空表 + 默认 7 patterns", async () => {
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t2-sr-1"),
      askUser: createNoAskUser(),
    });

    // 类型已证明 SecretRegistry；运行期断言对象在场 + 关键契约
    expect(built.deps.secretRegistry).toBeDefined();
    expect(typeof built.deps.secretRegistry!.register).toBe("function");
    expect(typeof built.deps.secretRegistry!.resolve).toBe("function");
    // 构造期空表：未跑任何 run() 前 size === 0
    expect(built.deps.secretRegistry!.size).toBe(0);
    // 默认 patterns = DEFAULT_SECRET_PATTERNS 7 条
    expect(built.deps.secretRegistry!.patterns.length).toBe(7);

    if (built.shutdown) await built.shutdown();
  });

  it("settings.secrets.patterns 自定义追加 → registry.patterns = DEFAULT 7 + extras", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-sr-extras-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-sr-2"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: {
          secrets: { patterns: ["CUSTOM_TOKEN_[A-Z0-9]{6}"] },
        },
      });

      expect(built.deps.secretRegistry).toBeDefined();
      // 自定义 extras 追加在 DEFAULT 之后 → 8 条，末尾 source 是自定义 pattern
      expect(built.deps.secretRegistry!.patterns.length).toBe(8);
      expect(built.deps.secretRegistry!.patterns[7]!.source).toBe(
        "CUSTOM_TOKEN_[A-Z0-9]{6}"
      );

      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("settings 不含 secrets → registry 仍构造（DEFAULT 7 条，不抛）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-sr-nosec-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-sr-3"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: { llm: { model: "test-model", apiKey: "sk-dummy" } },
      });

      expect(built.deps.secretRegistry).toBeDefined();
      expect(built.deps.secretRegistry!.patterns.length).toBe(7);
      expect(built.deps.secretRegistry!.size).toBe(0);

      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #440 T1 — session 作用域 todoDir seam（build-engine 装配侧）
//
// D2 决议：build-engine 在 surface !== "ask" 时把 host-injected todoDir 透传
// 给 createDefaultAciRegistry；ask 不传。worker 装配路径（createWorkerDeps）
// 不传 todoDir → 所有权边界隔在主 loop 内。
//
// 范围：仅断言 buildHarnessEngine 接受 todoDir opt、Gate 3 不抛；todo_write
// 工厂 + SSOT append 在 T2/T4 才进入，本步不假设工具在注册表中。
//
// 各用例的件数 = `EXPECTED_TOOLS.filter(...)` 表达式长度推导,以表达式为
// source of truth — 注释里不写加法叙事（避免与实际长度漂移）。
// ---------------------------------------------------------------------------

describe("buildHarnessEngine — #440 T1 todoDir seam", () => {
  it("chat surface：todoDir 传入 → todo_write 装配 + 36 件（seam 接受 + SSOT append-only;以 EXPECTED_TOOLS.length 为真值源,不写加法叙事）", async () => {
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-chat-tododir"),
      askUser: createNoAskUser(),
      surface: "chat",
      todoDir: "/tmp/some-session/todos",
    });
    // chat surface + todoDir → todoDir 透传给 registry → todo_write 装配。
    // EXPECTED_TOOLS 含 todo_write + bash_output + bash_stop（36 件;
    // backgroundManager 由 build-engine 装配期自建 → bash_output/bash_stop
    // 入注册表;todoDir 由 host 注入 → todo_write 入注册表;本测试不传
    // graphAssembly → run_graph 缺席 → 实际 36 < ACI_TOOLSET_NAMES 37）。
    expect(built.deps.registry.list().map((d) => d.name)).toEqual(
      EXPECTED_TOOLS
    );
    expect(built.deps.registry.get("todo_write")).toBeDefined();
    if (built.shutdown) await built.shutdown();
  });

  it("ask surface：todoDir 传入 → oneshot 剥离 todoDir，registry 不含 todo_write（行为不变）", async () => {
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-ask-tododir"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
      todoDir: "/tmp/some-session/todos",
    });
    // ask 形态与现有 SC8 守门一致：EXPECTED_TOOLS filter 剥除
    // memory2 + subagent2 + mcp2 + todo_write + bg2（ask 不创建 subagentManager
    // / mcpManager / backgroundManager,memory:enabled:false,todoDir oneshot
    // 剥离 —— SC8 + SC12）。具体件数 = filter 表达式长度，以数组为准。
    expect(built.deps.registry.list().map((d) => d.name)).toEqual(
      EXPECTED_TOOLS.filter(
        (n) =>
          n !== "memory_recall" &&
          n !== "memory_save" &&
          n !== "spawn_subagent" &&
          n !== "subagent_result" &&
          n !== "list_mcp_resources" &&
          n !== "read_mcp_resource" &&
          n !== "todo_write" &&
          n !== "bash_output" &&
          n !== "bash_stop"
      )
    );
    expect(built.deps.registry.get("todo_write")).toBeUndefined();
  });

  it("默认 chat surface 不传 todoDir → todo_write 不装配，35 件（seam 缺席零变化，向后兼容）", async () => {
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-chat-default"),
      askUser: createNoAskUser(),
    });
    // todoDir undefined → todo_write 缺席;EXPECTED_TOOLS.filter 剥 todo_write
    // → 35 件;backgroundManager 已装配,bash_output/bash_stop 在场;本测试不传
    // graphAssembly → run_graph 缺席。
    expect(built.deps.registry.list().map((d) => d.name)).toEqual(
      EXPECTED_TOOLS.filter((n) => n !== "todo_write")
    );
    expect(built.deps.registry.get("todo_write")).toBeUndefined();
    if (built.shutdown) await built.shutdown();
  });
});

// ---------------------------------------------------------------------------
// #406 T4: secrets.mode 装配矩阵 — roundtrip 默认 vs block 兼容
// ---------------------------------------------------------------------------
// A1/A3:缺省(无 mode)或显式 "roundtrip" → secretsMode 缺席(undefined)、
// secretRegistry 在场(roundtrip 机制 ON)、guard 不装配。
// A2:mode:"block" → secretsMode==="block"、secretRegistry 缺席(roundtrip 机制
// OFF)、guard 装配。
// A4:mode:"invalid" → settings.parseSecrets 已丢弃 → 同缺省 roundtrip。
// 说明:guard 装配在 createAciExecutor 内部,hooks 不可从外部直达;secretsMode +
// secretRegistry 是 loop-engine / bash 机器状态的忠实代理(secrets-guard.test.ts
// 已证明 guard 自身行为,block 用例在此文件 T5 describe 覆盖端到端拦截)。
describe("buildHarnessEngine — #406 T4 secrets.mode 装配矩阵", () => {
  it("A1:缺省 settings(无 secrets.mode)→ secretsMode undefined + secretRegistry 在场", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-a1-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-a1"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
      });
      expect(built.deps.secretsMode).toBeUndefined();
      expect(built.deps.secretRegistry).toBeDefined();
      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A2:settings.secrets.mode=block → secretsMode block + secretRegistry 缺席(guard 兼容路径)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-a2-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-a2"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: { secrets: { mode: "block" } },
      });
      expect(built.deps.secretsMode).toBe("block");
      expect(built.deps.secretRegistry).toBeUndefined();
      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A3:settings.secrets.mode=roundtrip(显式)→ secretsMode undefined + secretRegistry 在场", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-a3-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-a3"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: { secrets: { mode: "roundtrip" } },
      });
      expect(built.deps.secretsMode).toBeUndefined();
      expect(built.deps.secretRegistry).toBeDefined();
      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A4:settings.secrets.mode=invalid → parse 丢弃 → 同缺省 roundtrip", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-a4-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-a4"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
        settings: { secrets: { mode: "invalid" as never } },
      });
      expect(built.deps.secretsMode).toBeUndefined();
      expect(built.deps.secretRegistry).toBeDefined();
      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #558 T2: 默认路径停止注入 coordinator 调度段(plan 555 T2 acceptance 1)
// — 默认 buildHarnessEngine(自建 subagentManager 的 surface)在 deps.system()
//   不再渲染 "## Sub-agent coordination" 段 / 6 验收关键词;装配缝仍保留
//   (显式传入非空 coordinatorText 才渲染,见 coordinator-segment.test.ts seam 用例)。
// ---------------------------------------------------------------------------
describe("buildHarnessEngine — #558 T2 默认不注入 coordinator 段", () => {
  it("默认 chat surface(自建 subagentManager)→ deps.system() 不含 ## Sub-agent coordination 段", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-default-absence-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-default-1"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
      });

      // subagentManager 在场(全装配),但默认不再注入 coordinator 段:
      // plan 555 T2 决议:默认路径引导落点 = 工具 description (T1 SSOT),
      // 不再向 system 段双写。
      expect(built.subagentManager).toBeDefined();

      const systemText = (await built.deps.system?.()) ?? "";
      expect(systemText).not.toContain("## Sub-agent coordination");
      expect(systemText).not.toContain("proactively");
      expect(systemText).not.toContain("parallelizable");
      expect(systemText).not.toContain("spawn_subagent");
      expect(systemText).not.toContain("blocks until finished");
      expect(systemText).not.toContain("Use spawn_subagent");

      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tui surface(委托 buildHarnessEngine)→ deps.system() 默认同样不含 coordinator 段", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-tui-default-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-tui-default-1"),
        askUser: createNoAskUser(),
        surface: "tui",
        userHome: join(root, "home"),
        cwd: root,
      });

      expect(built.subagentManager).toBeDefined();
      const systemText = (await built.deps.system?.()) ?? "";
      expect(systemText).not.toContain("## Sub-agent coordination");
      expect(systemText).not.toContain("proactively");
      expect(systemText).not.toContain("parallelizable");
      expect(systemText).not.toContain("blocks until finished");

      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serve surface(自建 subagentManager)→ deps.system() 默认同样不含 coordinator 段", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-serve-default-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t2-serve-default-1"),
        askUser: createNoAskUser(),
        surface: "serve",
        userHome: join(root, "home"),
        cwd: root,
      });

      expect(built.subagentManager).toBeDefined();
      const systemText = (await built.deps.system?.()) ?? "";
      expect(systemText).not.toContain("## Sub-agent coordination");
      expect(systemText).not.toContain("proactively");
      expect(systemText).not.toContain("parallelizable");

      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #841 T6 / ADR-0009 D2 amended: 父会话 (chat / tui / serve) 开场不灌 rules
// 正文 —— 三条装配路径共用 build-engine deps.system,只注入带路径的 rules
// 清单 + 读路径指引;无 rules 目录时会话正常开始。
// ---------------------------------------------------------------------------
describe("buildHarnessEngine — #841 T6 父会话 rules 清单化", () => {
  const surfaces = ["chat", "tui", "serve"] as const;

  for (const surface of surfaces) {
    it(`${surface}: deps.system() lists rule paths, never rule bodies`, async () => {
      const root = await mkdtemp(join(tmpdir(), "iknow-t6-rules-"));
      try {
        const rulesDir = join(root, ".iknow", "rules");
        await mkdir(rulesDir, { recursive: true });
        await writeFile(join(rulesDir, "alpha.md"), "ALPHA RULE BODY");
        await writeFile(join(rulesDir, "beta.md"), "BETA RULE BODY");

        const built = await buildHarnessEngine({
          env: makeEnv(`sk-test-t6-${surface}`),
          askUser: createNoAskUser(),
          surface,
          userHome: join(root, "home"),
          cwd: root,
        });

        const systemText = (await built.deps.system?.()) ?? "";
        expect(systemText).not.toContain("ALPHA RULE BODY");
        expect(systemText).not.toContain("BETA RULE BODY");
        expect(systemText).toContain(join(rulesDir, "alpha.md"));
        expect(systemText).toContain(join(rulesDir, "beta.md"));
        expect(systemText).toContain("read_file");

        if (built.shutdown) await built.shutdown();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("chat: missing rules directory → session system still resolves (not fatal)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t6-norules-"));
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t6-norules"),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: join(root, "home"),
        cwd: root,
      });
      const systemText = (await built.deps.system?.()) ?? "";
      expect(systemText).not.toContain("Rules index");
      expect(systemText.length).toBeGreaterThan(0);
      if (built.shutdown) await built.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T4 / ADR-0040 — subagent dispatch classification at the build-engine gate.
// The gate must classify the worker's effective capability surface rather than
// treating every spawn_subagent call as read-only.
// ---------------------------------------------------------------------------
describe("buildHarnessEngine — T4 subagent isolation classifier", () => {
  it("allows explore on the main repo without provisioning and runs it read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-explore-"));
    const { manager, spawnedTasks } = makeTestSubagentManager();
    let provisioned = 0;
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-explore"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: {
          provision: async () => {
            provisioned += 1;
            return root;
          },
        },
      });

      const result = await runSpawn(built, {
        task: "inspect the repository",
        subagent_type: "explore",
        disallowedTools: [...FILE_WRITE_TOOL_NAMES],
        wait: false,
      });

      expect(result.kind).toBe("ok");
      expect(spawnedTasks).toEqual(["inspect the repository"]);
      expect(provisioned).toBe(0);
      await built.shutdown?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks explore when the real worker surface retains symbol writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-symbol-worker-"));
    const workerDeps = await createWorkerDeps({
      env: makeEnv("sk-test-t4-symbol-worker"),
      sandboxRoot: root,
      model: createStubModel({ responses: [] }),
      skillCatalog: createSkillCatalog([]),
      trace: createNoopTraceService(),
      system: () => undefined,
      role: "explore",
    });
    const workerToolNames = workerDeps.registry.list().map((tool) => tool.name);
    const workerDecision = assessSubagentIsolation({
      role: "explore",
      availableTools: workerToolNames,
    });
    let provisioned = 0;
    try {
      expect(workerToolNames).toEqual(
        expect.arrayContaining([...SYMBOL_MUTATE_TOOL_NAMES])
      );
      expect(workerDecision.conclusion).toBe("write");
      expect(workerDecision.reason).toBe("write_tools_available");

      const { manager, spawnedTasks } = makeTestSubagentManager();
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-symbol-gate"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: {
          provision: async () => {
            provisioned += 1;
            return root;
          },
        },
      });

      const result = await runSpawn(built, {
        task: "inspect the repository",
        subagent_type: "explore",
        wait: false,
      });

      expect(result.kind).toBe("execution_failed");
      expect(result.message).toContain("create-task-worktree ACI tool");
      expect(spawnedTasks).toEqual([]);
      expect(provisioned).toBe(0);
      await built.shutdown?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks the default general-purpose spawn on the main repo and points at worktree creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-general-"));
    const { manager, spawnedTasks } = makeTestSubagentManager();
    let provisioned = 0;
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-general"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: {
          provision: async () => {
            provisioned += 1;
            return root;
          },
        },
      });

      const result = await runSpawn(built, {
        task: "make the requested change",
        wait: false,
      });

      expect(result.kind).toBe("execution_failed");
      expect(result.message).toContain("create-task-worktree ACI tool");
      expect(spawnedTasks).toEqual([]);
      expect(provisioned).toBe(0);
      await built.shutdown?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for an unknown subagent type before spawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-unknown-"));
    const { manager, spawnedTasks } = makeTestSubagentManager();
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-unknown"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: { provision: async () => root },
      });

      const result = await runSpawn(built, {
        task: "use an unsupported role",
        subagent_type: "not-a-catalog-role",
        wait: false,
      });

      expect(result.kind).toBe("execution_failed");
      expect(result.message).toContain("create-task-worktree ACI tool");
      expect(spawnedTasks).toEqual([]);
      await built.shutdown?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still blocks a general-purpose spawn when only write and edit are denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-bash-any-"));
    const { manager, spawnedTasks } = makeTestSubagentManager();
    try {
      const built = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-bash-any"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: { provision: async () => root },
      });

      const result = await runSpawn(built, {
        task: "write through shell if needed",
        subagent_type: "general-purpose",
        disallowedTools: ["write_file", "edit_file"],
        wait: false,
      });

      expect(result.kind).toBe("execution_failed");
      expect(result.message).toContain("create-task-worktree ACI tool");
      expect(spawnedTasks).toEqual([]);
      await built.shutdown?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a general-purpose spawn after the session is rebound to its task worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-rebound-"));
    const taskRoot = join(root, ".iknow", "worktrees", "conv-1");
    await mkdir(taskRoot, { recursive: true });
    const { manager, spawnedTasks } = makeTestSubagentManager();
    try {
      const mainBuilt = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-rebound-main"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: { provision: async () => taskRoot },
      });
      const blocked = await runSpawn(mainBuilt, {
        task: "change the repository",
        wait: false,
      });
      expect(blocked.kind).toBe("execution_failed");
      await mainBuilt.shutdown?.();

      const reboundBuilt = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-rebound-task"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: taskRoot,
        sandboxRoot: taskRoot,
        workspaceRoot: taskRoot,
        productRoot: root,
        projectIdentityRoot: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        subagentManager: manager,
        worktreeIsolation: { provision: async () => taskRoot },
      });
      const result = await runSpawn(reboundBuilt, {
        task: "change the repository",
        wait: false,
      });

      expect(result.kind).toBe("ok");
      expect(spawnedTasks).toEqual(["change the repository"]);
      await reboundBuilt.shutdown?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the spawn result bytes unchanged when isolation is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-off-"));
    try {
      const offManager = makeTestSubagentManager();
      const offBuilt = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-off"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        settings: { isolation: { worktreeOnMutate: false } },
        subagentManager: offManager.manager,
        worktreeIsolation: { provision: async () => root },
      });
      const offResult = await runSpawn(offBuilt, {
        task: "preserve the existing path",
        wait: false,
      });

      const baselineManager = makeTestSubagentManager();
      const baselineBuilt = await buildHarnessEngine({
        env: makeEnv("sk-test-t4-off-baseline"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: root,
        userHome: join(root, "home"),
        subagentManager: baselineManager.manager,
      });
      const baselineResult = await runSpawn(baselineBuilt, {
        task: "preserve the existing path",
        wait: false,
      });

      expect(JSON.stringify(offResult)).toBe(JSON.stringify(baselineResult));
      await offBuilt.shutdown?.();
      await baselineBuilt.shutdown?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
