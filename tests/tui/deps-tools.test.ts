/**
 * tests/tui/deps-tools.test.ts
 *
 * #343 T6-A 测试：从 archive/tui-ink/tests/deps-tools.test.ts 迁回 tests/tui/，
 * 改写为 bun:test（D2 裁决：tests/tui/ 由 bun:test 驱动）。
 *
 * #365 T2：buildTuiDeps 委托 buildHarnessEngine({surface:"tui"}) → 装配 SSOT 化。
 * Tracer bullet 升级:锁定 TUI 入口工具面 = buildHarnessEngine 全装配,期望
 * 集从 `ACI_TOOLSET_NAMES` SSOT 派生(本场景下剥 6 件 host 缝条件化工具),
 * 且 onToolEvent 钩子经 deps.executor 在 executor 层真实触发(T1 观测缝验收)。
 * 任何入口漏注册的工具都让此测试立即报警。
 *
 * #337 Phase B：buildTuiDeps 装配 skill catalog → 21→23 件（追加 skill（disclosure-index-align T2 删 skill_search 后只剩 1 件），静态装配经 reg.inner.list() 透出）。skill catalog 即便为空
 * 也会通过 createDefaultAciRegistry 注入 skill 一件
 * （ACI_TOOLSET_NAMES Gate 3 锁）。本测试注入 tmp userHome/cwd（mkdtemp）
 * 隔离真实 ~/.iknow / cwd——worktree 已提交的 .iknow/mcp.json 含真实
 * stdio server，不隔离会触发 subprocess 启动、拖慢且污染测试环境。
 */
import { afterEach, describe, expect, test, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTuiDeps, type TuiToolEvent } from "../../src/tui/deps.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { ACI_TOOLSET_NAMES } from "../../src/harness/aci/tools/registry.js";
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
      fallback: [],
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
    // #378 根因 B: MCP 连接超时(默认 60_000)。
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
  // buildTuiDeps 委托 buildHarnessEngine,只需 env 字段;其余 bundle 字段不读。
  return { env } as unknown as RuntimeBundle;
}

// #365 T2：surface="tui" → build-engine 全装配(skillCatalog +
// subagentManager + mcpManager + backgroundManager 均装配)。期望集
// 从 `ACI_TOOLSET_NAMES` SSOT 派生,本测试场景下被排除的条件化工具:
//   - create-worktree / enter-worktree / exit-worktree:
//     worktreeIsolation host 缝缺(测试 opts 不透传 worktreeIsolation)
//   - list-worktrees / remove-worktree: 同上(同一 isolationHost
//     缝分支下的 worktreeList / worktreeRemove)
// ADR-0041 / plans/model-prefix-layering.md B3:`run_graph` 已常驻注册
// (subagentManager 在场即入注册表,与 graphMode / graphAssembly 是否在场
// 无关) —— handler isEnabled gate 缺席由缺省恒关守门,TUI 不透传 graphMode
// 不影响工具面成员。
// 任何新增件自动继承;append-only 仍由 registry Gate 3 镜像校验。
const EXCLUDED_FOR_TUI_NO_HOST_SEAM: ReadonlyArray<string> = [
  "create-worktree",
  "enter-worktree",
  "exit-worktree",
  "list-worktrees",
  "remove-worktree",
];
const EXPECTED_TUI_TOOLSET = ACI_TOOLSET_NAMES.filter(
  (n) => !EXCLUDED_FOR_TUI_NO_HOST_SEAM.includes(n)
);

describe("buildTuiDeps — 工具集必须与 buildHarnessEngine 对齐(SSOT 派生)", () => {
  // #337 Phase B:tmp fixture 隔离真实 ~/.iknow / cwd(避免 worktree 已提交
  // 的 .iknow/mcp.json 触发真实 stdio subprocess 启动,以及 .iknow/skills
  // 污染 skill scanner 降级行为)。skill 静态装配(Gate 3 锁,disclosure-index-align T2 删 skill_search 后只剩 1 件):
  // skillCatalog 提供即装两件)。
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  test(`装配出 ACI_TOOLSET_NAMES 派生集(surface=tui,SSOT=${EXPECTED_TUI_TOOLSET.length} 件;剥 6 件 host 缝条件化)`, async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-deps-toolset-"));
    roots.push(root);
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
    });
    const names = deps.registry
      .list()
      .map((def) => def.name)
      .sort();
    expect(names).toEqual([...EXPECTED_TUI_TOOLSET].sort());
    // 关键件显式断言:即使 SSOT 重排也确保这些常驻工具在 TUI surface 装配。
    expect(names).toContain("todo_write");
    expect(names).toContain("list_mcp_resources");
    expect(names).toContain("read_mcp_resource");
    expect(names).toContain("bash_output");
    expect(names).toContain("bash_stop");
    expect(names).toContain("query_trace");
    // 旧 lsp_* 工具自 symbol-primary-aci T5 起退役,TUI 表面已不含它们。
    expect(names).not.toContain("lsp_definition");
    expect(names).not.toContain("lsp_diagnostics");
  });

  test("显式断言 web_fetch / web_search / skill 在注册表里,skill_search 不在(SC5)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-deps-explicit-"));
    roots.push(root);
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      userHome: join(root, "home"),
      cwd: root,
    });
    const names = new Set(deps.registry.list().map((def) => def.name));
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("web_search")).toBe(true);
    expect(names.has("skill")).toBe(true);
    // disclosure-index-align T2 / SC5:skill_search 已删,不在注册表。
    expect(names.has("skill_search")).toBe(false);
  });

  test("IKNOW_WEB_PROXY 非空时,web 工具装配抛错(fail-fast 在装配时)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-deps-proxy-"));
    roots.push(root);
    // 镜像 build-engine.test.ts 的同形断言 — TUI 也需 fail-fast 在装配时。
    // #337 Phase B:buildTuiDeps 现在 async,失败经 await 转 rejection。
    await expect(
      buildTuiDeps(makeBundle({ proxy: "ftp://bad-proxy:9999" }), {
        askUser: createNoAskUser(),
        userHome: join(root, "home"),
        cwd: root,
      })
    ).rejects.toThrow(/only http and https|malformed/i);
  });

  it("#558 T2: 默认 TUI 路径(自建 subagentManager)→ deps.system 不含 coordinator 段", async () => {
    // surface="tui" → build-engine 自建 subagentManager,但 #558 T2 起
    // 不再向 createIknowSystemResolver 透传 IKNOW_COORDINATOR_TEXT;引导
    // 落点收敛到 spawn_subagent 工具 description (T1 SSOT)。
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
    });
    expect(deps.subagentManager).toBeDefined();
    const systemText =
      (await (deps.system as () => Promise<string | undefined>)()) ?? "";
    expect(systemText).not.toContain("## Sub-agent coordination");
    expect(systemText).not.toContain("proactively");
    expect(systemText).not.toContain("parallelizable");
    expect(systemText).not.toContain("spawn_subagent");
    expect(systemText).not.toContain("blocks until finished");
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
      // #337 Phase B:userHome/cwd 注入 tmp 隔离真实 ~/.iknow + worktree 已提交
      // 的 .iknow/mcp.json(避免 npx subprocess 启动)。fixture 文件仍在 root
      // 内(read_file 的 cwd 语义 = root)。
      userHome: join(root, "home"),
      cwd: root,
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
      userHome: join(root, "home"),
      cwd: root,
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
