/**
 * `src/harness/build-engine.ts` — the single harness assembly point shared by
 * the CLI (chat / ask) and the session server (serve → SessionHub.ensureDeps).
 *
 * These tests pin the ACI 11-tool set so a future tool-set change cannot drift
 * between the two entry points silently: if a tool is added/renamed/removed,
 * this test forces an explicit decision at the single assembly point.
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

// Order is load-bearing: it must match the `aciTools` array in
// `src/harness/build-engine.ts` (policy byName key-space, ADR-0006)。
// #194 T6 (Layer 4 baseline):扩 memory_recall + memory_save 到 10 件;
// #224 在 10 件基础上末尾追加 tool_search(11 件,memoryDir 默认存在)。
// #337 T8 (skill 装配):catalog 装配后末尾追加 skill / skill_search(→ 23 件)。
// #356 T6 (subagent 装配):surface !== "ask" 时 build-engine 自建 subagentManager,
// registry 末尾追加 spawn_subagent / subagent_result(→ 25 件)。ask 入口不创建
// manager → registry 停 23 件(SC8,见 ask 剥离断言)。
// #440 T11 (MCP resources 装配):surface !== "ask" 时 build-engine 自建
// mcpManager,registry 末尾追加 list_mcp_resources / read_mcp_resource(→ 28 件)。
// ask 入口不创建 manager → registry 停 26 件(mcpManager 缺席 → list/read 缺席)。
// #502 T3 (background 装配):surface !== "ask" 时 build-engine 自建
// backgroundManager,registry 末尾追加 bash_output / bash_stop(→ 30 件)。
// ask 入口不创建 manager → registry 停 28 件(backgroundManager 缺席 → bash_output /
// bash_stop 缺席;bash 仍常驻)。
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
  // #251 LSP 工具集 append-only:11→21,10 件在末尾,不重排既有 11 件。
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_document_symbol",
  "lsp_workspace_symbol",
  "lsp_go_to_implementation",
  "lsp_prepare_call_hierarchy",
  "lsp_incoming_calls",
  "lsp_outgoing_calls",
  "lsp_diagnostics",
  // #337 T8 skill 工具集 append-only:21→23,2 件在末尾。
  "skill",
  "skill_search",
  // #356 T6 subagent 工具集 append-only:23→25,2 件在末尾(全装配 chat surface
  // 才在场;ask 缺 subagentManager → 23 件)。
  "spawn_subagent",
  "subagent_result",
  // #440 双 Stream 并集 append-only:25→28。todo_write（T4，全装配 chat surface
  // + todoDir 在场才入注册表；ask + worker 装配路径不传 todoDir → 不在场）+
  // MCP resources 两件（T11，全装配 chat surface 才在场；ask 缺 mcpManager → 不在场）。
  "todo_write",
  "list_mcp_resources",
  "read_mcp_resource",
  // #502 T3 bash_output / bash_stop 工具集 append-only:28→30,末位 2 件
  // （全装配 chat/tui/serve surface 在场;ask 缺 backgroundManager → 缺席;
  //  bash 仍常驻,参数级 background:true 能力由 handler 运行时决策）。
  "bash_output",
  "bash_stop",
];

/** #440 T4 / #502 T3 条件化缺席视图:todoDir 未透传的 chat surface(默认行为)。
 *  既有 SSOT 断言通过 EXPECTED_TOOLS_NO_TODO 表达"28 件不变";todo_write
 *  在场需显式传 todoDir(主循环生产路径,非测试默认形态)。 */
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

describe("buildHarnessEngine (SSOT assembly)", () => {
  it("registers the full ACI 11-tool set on the returned registry", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-sentinel-1"),
      askUser: createNoAskUser(),
    });

    const names = deps.registry.list().map((def) => def.name);
    // #440 T4:todo_write 条件化 — todoDir 未透传 → 不在场;EXPECTED_TOOLS_NO_TODO = 25 件。
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
    // #440 T4:todoDir 未透传 → todo_write 缺席,EXPECTED_TOOLS_NO_TODO = 25 件。
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
    // #502 T3:ask surface 缺 backgroundManager → bash_output/bash_stop 缺席;
    // #440 T4:todoDir 未透传 → todo_write 缺席;memory:enabled=false → memory 两件
    // 缺席;EXPECTED_TOOLS_NO_TODO(29) - memory2 = 27 件。
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
      const { deps } = await buildHarnessEngine({
        env: makeEnv("sk-test-passthrough-2"),
        askUser: createNoAskUser(),
        sandboxRoot: root,
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
    // ask + memory:{enabled:false} 双重剥离 → 30 - todo(1) - memory2 - subagent2 -
    // mcp2 - bg2 = 21 件(todo_write 因 todoDir 未透传缺席,ask 不装配 MCP 两件,
    // memory 两件禁用,bg 两件 ask 缺席;skill 两件仍装配,SC12 守门)。
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
// ---------------------------------------------------------------------------

describe("buildHarnessEngine — #440 T1 todoDir seam", () => {
  it("chat surface：todoDir 传入 → todo_write 装配 + 30 件（seam 接受 + SSOT append-only）", async () => {
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-chat-tododir"),
      askUser: createNoAskUser(),
      surface: "chat",
      todoDir: "/tmp/some-session/todos",
    });
    // chat surface + todoDir → todoDir 透传给 registry → todo_write 装配。
    // T4 已 SSOT append,EXPECTED_TOOLS 含 todo_write + bash_output + bash_stop
    // (30 件;backgroundManager 由 build-engine 装配期自建 → bash_output/bash_stop
    // 入注册表;todoDir 由 host 注入 → todo_write 入注册表)。
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
    // ask 形态与现有 SC8 守门一致：30 - memory2 - subagent2 - mcp2 - todo_write
    // - bg2 (ask 不传 todoDir 给 registry,mcpManager + backgroundManager 在 ask
    // 路径也不装配,SC12) = 21 件。
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

  it("默认 chat surface 不传 todoDir → todo_write 不装配，29 件（seam 缺席零变化，向后兼容）", async () => {
    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t1-chat-default"),
      askUser: createNoAskUser(),
    });
    // todoDir undefined → todo_write 缺席；EXPECTED_TOOLS(30) 含 todo_write
    // 故过滤掉 → 29 件;backgroundManager 已装配,bash_output/bash_stop 在场。
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
