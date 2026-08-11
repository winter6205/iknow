/**
 * tests/tui/deps-tools.test.ts
 *
 * #343 T6-A 测试：从 archive/tui-ink/tests/deps-tools.test.ts 迁回 tests/tui/，
 * 改写为 bun:test（D2 裁决：tests/tui/ 由 bun:test 驱动）。
 *
 * Tracer bullet: 锁定 TUI 入口工具集必须与 buildHarnessEngine 对齐。
 * 失败先行(failing-test-first):重构前是红的(只有 6 件),重构后变绿。
 * 任何入口漏注册的工具都让此测试立即报警。
 *
 * #337 Phase B：buildTuiDeps 装配 skill catalog → 21→23 件（追加 skill /
 * skill_search，静态装配经 reg.inner.list() 透出）。skill catalog 即便为空
 * 也会通过 createDefaultAciRegistry 注入 skill / skill_search 两件
 * （ACI_TOOLSET_NAMES Gate 3 锁）。本测试注入 tmp userHome/cwd（mkdtemp）
 * 隔离真实 ~/.iknow / cwd——worktree 已提交的 .iknow/mcp.json 含真实
 * stdio server，不隔离会触发 subprocess 启动、拖慢且污染测试环境。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTuiDeps } from "../../src/tui/deps.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";

/** 最小合法 RuntimeBundle — buildTuiDeps 只读 env 字段,其余 stub。 */
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
  // buildTuiDeps 解构 { env } = bundle; 其余字段不读。
  return { env } as unknown as RuntimeBundle;
}

// #194 T6 (Layer 4 baseline):TUI 与 build-engine 对齐 → 10 件(含 memory);
// #224 末尾追加 tool_search(11 件)。
const EXPECTED_TOOLSET = [
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
  // #251 LSP 工具集 append-only:11→21,10 件在末尾。
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
  // #337 T5 skill 工具集 append-only:21→23。
  "skill",
  "skill_search",
];

describe("buildTuiDeps — 工具集必须与 buildHarnessEngine 对齐(23 件)", () => {
  // #337 Phase B:tmp fixture 隔离真实 ~/.iknow / cwd(避免 worktree 已提交
  // 的 .iknow/mcp.json 触发真实 stdio subprocess 启动,以及 .iknow/skills
  // 污染 skill scanner 降级行为)。skill/skill_search 静态装配(Gate 3 锁:
  // skillCatalog 提供即装两件),tmp 即使无 skills/mcp.json 仍产 23 件。
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  test("装配出完整 23 件工具(含 web_fetch + web_search + memory_recall + memory_save + tool_search + 10 LSP + skill + skill_search)", async () => {
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
    expect(names).toEqual([...EXPECTED_TOOLSET].sort());
  });

  test("显式断言 web_fetch / web_search / skill / skill_search 都在注册表里", async () => {
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
    expect(names.has("skill_search")).toBe(true);
  });

  test("IKNOW_WEB_PROXY 非空时,web 工具装配不抛错(fail-fast 在装配时)", async () => {
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
});
