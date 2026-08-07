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
];

describe("buildTuiDeps — 工具集必须与 buildHarnessEngine 对齐(11 件)", () => {
  it("装配出完整 11 件工具(含 web_fetch + web_search + memory_recall + memory_save + tool_search)", () => {
    const deps = buildTuiDeps(makeBundle(), { askUser: createNoAskUser() });
    const names = deps.registry
      .list()
      .map((def) => def.name)
      .sort();
    expect(names).toEqual([...EXPECTED_TOOLSET].sort());
  });

  it("显式断言 web_fetch 与 web_search 都在注册表里", () => {
    // 比 list() 顺序断言更强 — 即使将来顺序变了也不会漏报。
    const deps = buildTuiDeps(makeBundle(), { askUser: createNoAskUser() });
    const names = new Set(deps.registry.list().map((def) => def.name));
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("web_search")).toBe(true);
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
