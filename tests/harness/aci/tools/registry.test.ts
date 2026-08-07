/**
 * tests/harness/aci/tools/registry.test.ts
 *
 * `createDefaultAciRegistry` — 10 件 SSOT 工具注册层单元测试。
 *
 * 对齐 upstream `create_default_tool_registry()`(tools/__init__.py:48):
 * 单一装配函数返回注册表,所有入口共享。本测试锁 5 边界类:
 *
 *   - 正常路径:返回 AciRegistry,list() 10 工具,顺序 append-only
 *   - 空输入:env.web 全空(undefined)→ 直连不抛;sandboxRoot:"" → 不抛
 *   - 非法输入:proxy 非 http/https / 含凭据 → 装配期同步抛 ToolExecutionError
 *   - 溢出/边界:sandboxRoot 指向不存在路径 → 装配期不抛(执行期由 fs 工具越界逻辑拒绝)
 *   - 并发:两次工厂调用返回的 AciRegistry 相互独立(工具闭包隔离)
 */
import { describe, expect, it } from "vitest";
import {
  createDefaultAciRegistry,
  ACI_TOOLSET_NAMES,
} from "../../../../src/harness/aci/tools/registry.js";
import type { IknowEnv } from "../../../../src/config/env.js";

/** 合法最小 env(仅 web 字段;LLM 字段工厂不消费)。 */
function makeWebEnv(
  overrides: Partial<IknowEnv["web"]> = {}
): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined, ...overrides } };
}

const EXPECTED_TOOLS: readonly string[] = ACI_TOOLSET_NAMES;

describe("createDefaultAciRegistry — 正常路径", () => {
  it("返回 AciRegistry,list() 10 工具,顺序 append-only", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      memoryDir: "/tmp/root/memory",
    });
    const names = reg.inner.list().map((def) => def.name);
    expect(names).toEqual([...EXPECTED_TOOLS]);
    expect(reg.catalog.get("web_fetch")).toBeDefined();
    expect(reg.catalog.get("web_search")).toBeDefined();
    expect(reg.catalog.get("memory_recall")).toBeDefined();
    expect(reg.catalog.get("memory_save")).toBeDefined();
  });
});

describe("createDefaultAciRegistry — 空输入", () => {
  it("env.web 全空(undefined)→ 直连不抛", () => {
    expect(() =>
      createDefaultAciRegistry({ env: makeWebEnv(), sandboxRoot: "/tmp/root" })
    ).not.toThrow();
  });

  it("sandboxRoot 空串 → 装配不抛", () => {
    expect(() =>
      createDefaultAciRegistry({ env: makeWebEnv(), sandboxRoot: "" })
    ).not.toThrow();
  });
});

describe("createDefaultAciRegistry — 非法输入(fail-fast 装配期)", () => {
  it("proxy 非 http/https → 装配期同步抛", () => {
    expect(() =>
      createDefaultAciRegistry({
        env: makeWebEnv({ proxy: "ftp://bad-proxy:9999" }),
        sandboxRoot: "/tmp/root",
      })
    ).toThrow(/only http and https|malformed/i);
  });

  it("proxy 含凭据 → 装配期同步抛", () => {
    expect(() =>
      createDefaultAciRegistry({
        env: makeWebEnv({ proxy: "http://user:pass@proxy.local:7897" }),
        sandboxRoot: "/tmp/root",
      })
    ).toThrow(/credentials/i);
  });
});

describe("createDefaultAciRegistry — 溢出/边界", () => {
  it("sandboxRoot 指向不存在路径 → 装配期不抛(执行期由 fs 工具拒绝)", () => {
    // 决断见 plans/registry-layer-tui.md 风险节:sandboxRoot 越界延迟到
    // 执行期(resolverealpath read-file.ts 抛),装配期只做 proxy URL 语法校验。
    expect(() =>
      createDefaultAciRegistry({
        env: makeWebEnv(),
        sandboxRoot: "/nonexistent/does/not/exist",
      })
    ).not.toThrow();
  });
});

describe("createDefaultAciRegistry — 并发闭包隔离", () => {
  it("两次工厂调用返回的 AciRegistry 相互独立", () => {
    const a = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root-a",
      memoryDir: "/tmp/root-a/memory",
    });
    const b = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root-b",
      memoryDir: "/tmp/root-b/memory",
    });
    expect(a).not.toBe(b);
    expect(a.catalog).not.toBe(b.catalog);
    // 工具闭包各自持有自己的 sandboxRoot — 断言 read_file 行为隔离:
    // (通过 catalog 拿工具定义,不触发真实执行,仅验证 registry 节点独立)
    expect(a.catalog.all()).toHaveLength(EXPECTED_TOOLS.length);
    expect(b.catalog.all()).toHaveLength(EXPECTED_TOOLS.length);
  });
});
