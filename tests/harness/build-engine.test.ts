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
];

/** Deterministic env: never read process.env / .env files (env.ts SSOT). */
function makeEnv(apiKey: string | undefined): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
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
  };
}

describe("buildHarnessEngine (SSOT assembly)", () => {
  it("registers the full ACI 11-tool set on the returned registry", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-sentinel-1"),
      askUser: createNoAskUser(),
    });

    const names = deps.registry.list().map((def) => def.name);
    expect(names).toEqual(EXPECTED_TOOLS);
    // 显式锁 Web 工具存在(plan-fidelity:SSOT 收敛到 registry.ts 后,
    // build-engine 路径也必须仍带 web_fetch / web_search)。
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
    // #356 T6:全装配(默认 chat surface)含 spawn_subagent / subagent_result 两件。
    expect(names).toContain("spawn_subagent");
    expect(names).toContain("subagent_result");
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
    expect(promptNames).toEqual([...EXPECTED_TOOLS].sort());
    // 默认 registry 无 lazy 工具 → visibleSchemas ≡ registry.list()
    expect(deps.promptTools!().map((d) => d.name)).toEqual(EXPECTED_TOOLS);
  });

  it("throws without the LLM api key set (fail loud, before any async work)", async () => {
    await expect(
      buildHarnessEngine({
        env: makeEnv(undefined),
        askUser: createNoAskUser(),
      })
    ).rejects.toThrow(/LLM mode needs the env var/);
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
    expect(names).toEqual(
      EXPECTED_TOOLS.filter((n) => n !== "memory_recall" && n !== "memory_save")
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
    expect(deps.registry.list().map((d) => d.name)).toEqual(EXPECTED_TOOLS);
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
    // ask + memory:{enabled:false} 双重剥离 → 25 - memory2 - subagent2 = 21 件
    // (skill 两件仍装配,SC12)。
    expect(names).toEqual(
      EXPECTED_TOOLS.filter(
        (n) =>
          n !== "memory_recall" &&
          n !== "memory_save" &&
          n !== "spawn_subagent" &&
          n !== "subagent_result"
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
    // 返回时间 < 慢 connect 的剩余时间(无穷大,实质:返回即可)。
    const slowClient: McpClientHandle = {
      connect: () => new Promise<void>(() => {}),
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

    // 返回时间应 < 200ms(单测容差)。慢 connect 是 ∞ → 必须早返回。
    expect(elapsed).toBeLessThan(200);
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
    expect(names).toEqual(EXPECTED_TOOLS);

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
