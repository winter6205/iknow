/**
 * tests/tui/deps-tools.test.ts
 *
 * #343 T6-A 测试：从 archive/tui-ink/tests/deps-tools.test.ts 迁回 tests/tui/，
 * 改写为 bun:test（D2 裁决：tests/tui/ 由 bun:test 驱动）。
 *
 * #365 T2：buildTuiDeps 委托 buildHarnessEngine({surface:"tui"}) → 装配 SSOT 化。
 * Tracer bullet 升级:锁定 TUI 入口工具面 = buildHarnessEngine 全装配 25 件
 * (与 tests/harness/build-engine.test.ts 的 EXPECTED_TOOLS 对齐),且 onToolEvent
 * 钩子经 deps.executor 在 executor 层真实触发(T1 观测缝验收)。
 * 任何入口漏注册的工具都让此测试立即报警。
 */
import { describe, expect, test, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTuiDeps, type TuiToolEvent } from "../../src/tui/deps.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";

/** 最小合法 RuntimeBundle — buildTuiDeps 委托 build-engine,只读 env 字段,其余 stub。 */
function makeBundle(
  envOverrides: Partial<IknowEnv["web"]> = {}
): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-test-sentinel-tui",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: {
      searchUrl: undefined,
      proxy: undefined,
      ...envOverrides,
    },
    // #119 T7: IknowCompressEnv 必填(T1 接入),build-engine 透传。test fixture
    // 默认 contextWindow=200000, thresholdTokens 缺省推导。
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
  };
  // buildTuiDeps 委托 buildHarnessEngine,只需 env 字段;其余 bundle 字段不读。
  return { env } as unknown as RuntimeBundle;
}

// #365 T2：surface="tui" → build-engine 全装配 25 件(skillCatalog + subagentManager
// 均装配)。数组与 tests/harness/build-engine.test.ts 的 EXPECTED_TOOLS 对齐(SSOT)。
// 拆分:base 11 件(#194 + #224)→ +10 LSP(#251)= 21 件 → + skill/skill_search
// (#337 T8)= 23 件 → + spawn_subagent/subagent_result (#356 T6)= 25 件。
const EXPECTED_BASE_11 = [
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
];
const EXPECTED_LSP_10 = [
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
];
const EXPECTED_TOOLSET_25 = [
  ...EXPECTED_BASE_11,
  ...EXPECTED_LSP_10,
  "skill",
  "skill_search",
  "spawn_subagent",
  "subagent_result",
];

describe("buildTuiDeps — 工具集必须与 buildHarnessEngine 对齐(25 件)", () => {
  test("装配出完整 25 件工具(surface=tui 全装配:11 base + 10 LSP + skill 2 + subagent 2)", async () => {
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
    });
    const names = deps.registry
      .list()
      .map((def) => def.name)
      .sort();
    expect(names).toEqual([...EXPECTED_TOOLSET_25].sort());
  });

  test("显式断言 web_fetch 与 web_search 都在注册表里", async () => {
    // 比 list() 顺序断言更强 — 即使将来顺序变了也不会漏报。
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
    });
    const names = new Set(deps.registry.list().map((def) => def.name));
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("web_search")).toBe(true);
  });

  test("IKNOW_WEB_PROXY 非空时,web 工具装配抛错(fail-fast 在装配时)", async () => {
    // 镜像 build-engine.test.ts 的同形断言 — TUI 也需 fail-fast 在装配时。
    // buildTuiDeps 现在 async,装配期抛错以 rejects 呈现。
    await expect(
      buildTuiDeps(makeBundle({ proxy: "ftp://bad-proxy:9999" }), {
        askUser: createNoAskUser(),
      })
    ).rejects.toThrow(/only http and https|malformed/i);
  });

  it("coordinatorText 注入(与 build-engine chat 同门):deps.system 含 coordinator 段关键词", async () => {
    // surface="tui" → build-engine 自建 subagentManager 且透传 coordinatorText
    // (IKNOW_COORDINATOR_TEXT),委托后 built.subagentManager 原样透出。
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
    });
    expect(deps.subagentManager).toBeDefined();
    const systemText =
      (await (deps.system as () => Promise<string | undefined>)()) ?? "";
    expect(systemText).toContain("## Sub-agent coordination");
    expect(systemText).toContain("proactively");
    expect(systemText).toContain("parallelizable");
    expect(systemText).toContain("blocks until finished");
  });
});

// --- #365 T2: onToolEvent 观测缝在 executor 层被触发(T1 hooks 透传验收) -----

describe("buildTuiDeps — onToolEvent 钩子经 executor 触发(T1 观测缝)", () => {
  test("真实调用 read_file 后 stub onToolEvent 收到含 toolName/toolUseId/kind 的事件", async () => {
    // buildTuiDeps 委托 build-engine,沙箱根 = process.cwd()(TUI 启动目录语义,
    // buildTuiDeps 不透传 sandboxRoot)。fixture 文件必须落在 cwd 内,否则
    // read_file 以 path outside workspace 拒绝。
    const root = await mkdtemp(join(process.cwd(), ".iknow-tui-hooks-"));
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "hello tui hooks\n", "utf8");

    const events: TuiToolEvent[] = [];
    // soleInflightId 不传 → undefined → 归因抑制;显式注入使事件能发出。
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      soleInflightId: () => "conv-1",
      onToolEvent: (event) => {
        events.push(event);
      },
    });

    try {
      const [result] = await deps.executor.executeAll([
        { id: "tui-hook-read", name: "read_file", input: { path: filePath } },
      ]);
      expect(result.kind).toBe("ok");

      // 关键断言:钩子被触发,事件含归因 conversationId + toolName + toolUseId + kind。
      expect(events.length).toBeGreaterThan(0);
      const event = events[0];
      expect(event.conversationId).toBe("conv-1");
      expect(event.toolName).toBe("read_file");
      expect(event.toolUseId).toBe("tui-hook-read");
      expect(event.kind).toBe("ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("不传 onToolEvent → 装配照常,executor 可调用(零变化)", async () => {
    const root = await mkdtemp(join(process.cwd(), ".iknow-tui-nohooks-"));
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "no hooks\n", "utf8");

    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
    });

    try {
      expect(typeof deps.executor.executeAll).toBe("function");
      const [result] = await deps.executor.executeAll([
        {
          id: "tui-nohooks-read",
          name: "read_file",
          input: { path: filePath },
        },
      ]);
      expect(result.kind).toBe("ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
