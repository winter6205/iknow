/**
 * tests/tui/deps-tools.test.ts
 *
 * Locks the TUI entry tool surface = full buildHarnessEngine assembly
 * (buildTuiDeps delegates to it). Expected set is derived from the
 * `ACI_TOOLSET_NAMES` SSOT, minus host-seam-conditional tools excluded in
 * this scenario. Any entry point that drops a registration fails here
 * immediately. Also verifies onToolEvent fires at the executor layer via
 * deps.executor.
 *
 * Tests inject a tmp userHome/cwd (mkdtemp) to isolate the real ~/.iknow
 * and the committed .iknow/mcp.json — without isolation the real stdio MCP
 * server would spawn subprocesses and pollute the test environment.
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

/** Minimal valid RuntimeBundle — buildTuiDeps delegates to build-engine and reads only `env`; the rest is stubbed. */
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
    // IknowCompressEnv is required and passed through by build-engine;
    // fixture uses contextWindow=200000, thresholdTokens derived by default.
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    // MCP connect timeout (default 60_000).
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
  // buildHarnessEngine reads only `env`; other bundle fields are untouched.
  return { env } as unknown as RuntimeBundle;
}

// surface="tui" → build-engine full assembly (skillCatalog + subagentManager +
// mcpManager + backgroundManager). Expected set derives from the
// `ACI_TOOLSET_NAMES` SSOT; conditionally-registered tools excluded here:
//   - create-worktree / enter-worktree / exit-worktree:
//     worktreeIsolation host seam absent (test opts do not pass it)
//   - list-worktrees / remove-worktree: same isolationHost seam branch
// `run_graph` is now always registered whenever subagentManager is present,
// regardless of graphMode / graphAssembly — the handler's absent isEnabled
// gate defaults to closed, so TUI not passing graphMode does not change
// tool-surface membership.
// New tools are inherited automatically; append-only stays mirror-checked by
// the registry's Gate 3 lock.
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
  // tmp fixture isolates the real ~/.iknow / cwd (the committed
  // .iknow/mcp.json would spawn real stdio subprocesses, and .iknow/skills
  // would pollute skill-scanner degradation). skill is statically assembled
  // (Gate 3 lock); skill_search was removed, so skillCatalog adds only it.
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
    // Explicit checks for resident tools that must survive any SSOT reshuffle.
    expect(names).toContain("todo_write");
    expect(names).toContain("list_mcp_resources");
    expect(names).toContain("read_mcp_resource");
    expect(names).toContain("bash_output");
    expect(names).toContain("bash_stop");
    expect(names).toContain("query_trace");
    // Old lsp_* tools retired with symbol-primary-aci; absent from the TUI surface.
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
    // skill_search was deleted; it must not be in the registry.
    expect(names.has("skill_search")).toBe(false);
  });

  test("IKNOW_WEB_PROXY 非空时,web 工具装配抛错(fail-fast 在装配时)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-tui-deps-proxy-"));
    roots.push(root);
    // Mirrors the same assertion in build-engine.test.ts — TUI must also fail fast at assembly.
    // buildTuiDeps is async now, so the failure surfaces as an awaited rejection.
    await expect(
      buildTuiDeps(makeBundle({ proxy: "ftp://bad-proxy:9999" }), {
        askUser: createNoAskUser(),
        userHome: join(root, "home"),
        cwd: root,
      })
    ).rejects.toThrow(/only http and https|malformed/i);
  });

  it("#558 T2: 默认 TUI 路径(自建 subagentManager)→ deps.system 不含 coordinator 段", async () => {
    // surface="tui" → build-engine builds its own subagentManager, but
    // IKNOW_COORDINATOR_TEXT is no longer passed to createIknowSystemResolver;
    // coordination guidance lives solely in the spawn_subagent tool description.
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

// --- onToolEvent observation seam fires at the executor layer -------------

describe("buildTuiDeps — onToolEvent 钩子经 executor 触发(T1 观测缝)", () => {
  test("真实调用 read_file 后 stub onToolEvent 收到含 toolName/toolUseId/kind 的事件", async () => {
    // build-engine's sandbox root = process.cwd() (TUI startup-dir semantics;
    // buildTuiDeps does not pass sandboxRoot). The fixture file must live under
    // cwd or read_file rejects it with "path outside workspace".
    const root = await mkdtemp(join(process.cwd(), ".iknow-tui-hooks-"));
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "hello tui hooks\n", "utf8");

    const events: TuiToolEvent[] = [];
    // Without soleInflightId → undefined → attribution suppressed; inject explicitly so events emit.
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      soleInflightId: () => "conv-1",
      onToolEvent: (event) => {
        events.push(event);
      },
      // tmp userHome/cwd isolate the real ~/.iknow and the committed
      // .iknow/mcp.json (avoid npx subprocess spawn). The fixture file stays
      // inside root (read_file's cwd semantics = root).
      userHome: join(root, "home"),
      cwd: root,
    });

    try {
      const [result] = await deps.executor.executeAll([
        { id: "tui-hook-read", name: "read_file", input: { path: filePath } },
      ]);
      expect(result.kind).toBe("ok");

      // Key assertion: hook fired with attribution conversationId + toolName + toolUseId + kind.
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
