/**
 * tests/tui/deps-tools.test.ts
 *
 * Tracer bullet: 锁定 TUI 入口工具集必须与 buildHarnessEngine 对齐(11 件)。
 * 失败先行(failing-test-first):重构前是红的(只有 6 件),重构后变绿。
 * 任何入口漏注册的工具都让此测试立即报警。
 */
import { describe, expect, it } from "vitest";
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
// #356 T6 (TUI 接线):buildTuiDeps 与 build-engine chat 同门(surface ∈
// {chat, tui, serve}) → 默认自建 subagentManager → 工具集含
// spawn_subagent + subagent_result 两件 (21→23)。TUI 不装 skill 工具(无
// skillCatalog),所以总数 23 而非 25。
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
  // #356 T6 spawn 工具集 append-only:21→23。
  "spawn_subagent",
  "subagent_result",
];

describe("buildTuiDeps — 工具集必须与 buildHarnessEngine 对齐(23 件)", () => {
  it("装配出完整 23 件工具(含 web + memory + tool_search + 10 LSP + 2 subagent)", () => {
    const deps = buildTuiDeps(makeBundle(), { askUser: createNoAskUser() });
    const names = deps.registry
      .list()
      .map((def) => def.name)
      .sort();
    expect(names).toEqual([...EXPECTED_TOOLSET].sort());
  });

  it("显式断言 web_fetch / web_search / spawn_subagent / subagent_result 都在注册表里", () => {
    // 比 list() 顺序断言更强 — 即使将来顺序变了也不会漏报。
    const deps = buildTuiDeps(makeBundle(), { askUser: createNoAskUser() });
    const names = new Set(deps.registry.list().map((def) => def.name));
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("web_search")).toBe(true);
    expect(names.has("spawn_subagent")).toBe(true);
    expect(names.has("subagent_result")).toBe(true);
  });

  it("IKNOW_WEB_PROXY 非空时,web 工具装配不抛错(fail-fast 在装配时)", () => {
    // 镜像 build-engine.test.ts 的同形断言 — TUI 也需 fail-fast 在装配时。
    expect(() =>
      buildTuiDeps(makeBundle({ proxy: "ftp://bad-proxy:9999" }), {
        askUser: createNoAskUser(),
      })
    ).toThrow(/only http and https|malformed/i);
  });
});
