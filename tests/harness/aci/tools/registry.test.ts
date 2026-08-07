/**
 * tests/harness/aci/tools/registry.test.ts
 *
 * `createDefaultAciRegistry` — 11 件 SSOT 工具注册层单元测试
 * （memoryDir 缺席 → 9 件；memoryDir 存在 → 11 件）。
 *
 * 对齐 upstream `create_default_tool_registry()`(tools/__init__.py:48):
 * 单一装配函数返回注册表,所有入口共享。本测试锁 5 边界类:
 *
 *   - 正常路径:返回 AciRegistry,list() 11 工具(带 memoryDir),顺序 append-only
 *   - 空输入:env.web 全空(undefined)→ 直连不抛;sandboxRoot:"" → 不抛
 *   - 非法输入:proxy 非 http/https / 含凭据 → 装配期同步抛 ToolExecutionError
 *   - 溢出/边界:sandboxRoot 指向不存在路径 → 装配期不抛(执行期由 fs 工具越界逻辑拒绝)
 *   - 并发:两次工厂调用返回的 AciRegistry 相互独立(工具闭包隔离)
 *
 * 另锁 Gate 3(SSOT append-only 纪律,S1/D12):`createDefaultAciRegistry()`
 * 实际装配出的工具名与 `ACI_TOOLSET_NAMES` 严格一致(长度 + 顺序 + 成员)。
 * Gate 3 的抛错路径是结构性(derived-from-map),不重构无法从外部触发,
 * 故只锁正向一致;分歧在装配期 by-construction 失败。memory 工具是条件
 * 装配的(对照名单按 memoryDir 镜像过滤)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("memoryDir 存在 → list() 11 工具,顺序 append-only", () => {
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
    expect(reg.catalog.get("tool_search")).toBeDefined();
  });

  it("memoryDir 缺席 → list() 9 工具(8 基线 + tool_search,无 memory 工具)", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
    });
    const names = reg.inner.list().map((d) => d.name);
    expect(names).toEqual(
      [...ACI_TOOLSET_NAMES].filter(
        (n) => n !== "memory_recall" && n !== "memory_save"
      )
    );
    expect(reg.catalog.get("tool_search")).toBeDefined();
    expect(reg.catalog.get("memory_recall")).toBeUndefined();
    expect(reg.catalog.get("memory_save")).toBeUndefined();
  });

  it("Gate 3:ACI_TOOLSET_NAMES 长度 11,前 8 原序 + memory_recall + memory_save + tool_search", () => {
    expect(ACI_TOOLSET_NAMES).toHaveLength(11);
    // 前 8 件原序不变(append-only 纪律)。
    expect(ACI_TOOLSET_NAMES.slice(0, 8)).toEqual([
      "bash",
      "read_file",
      "grep",
      "glob",
      "edit_file",
      "write_file",
      "web_fetch",
      "web_search",
    ]);
    expect(ACI_TOOLSET_NAMES[8]).toBe("memory_recall");
    expect(ACI_TOOLSET_NAMES[9]).toBe("memory_save");
    expect(ACI_TOOLSET_NAMES[10]).toBe("tool_search");
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

describe("createDefaultAciRegistry — onEdit 透传(#251)", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-reg-onedit-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("onEdit → edit_file 写盘后回调被调一次,参数为被修改文件的绝对路径", async () => {
    const file = join(scratch, "a.ts");
    await writeFile(file, "const a = 1;\n", "utf8");
    const calls: string[] = [];
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: scratch,
      onEdit: (f) => calls.push(f),
    });
    const tool = reg.catalog.get("edit_file");
    expect(tool).toBeDefined();
    const result = (await tool!.handler({
      path: file,
      old_str: "const a = 1;",
      new_str: "const a = 2;",
    })) as string;
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(file);
    expect(result).toBe(
      `[edit_file] replaced 1 occurrence(s) in ${join(scratch, "a.ts")}`
    );
    expect(await readFile(file, "utf8")).toBe("const a = 2;\n");
  });

  it("onEdit 未传 → edit_file byte-identical(行为与改动前一致)", async () => {
    const file = join(scratch, "b.ts");
    await writeFile(file, "x = 1\n", "utf8");
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: scratch,
    });
    const tool = reg.catalog.get("edit_file");
    expect(tool).toBeDefined();
    const result = (await tool!.handler({
      path: file,
      old_str: "x = 1",
      new_str: "x = 2",
    })) as string;
    expect(result).toBe(
      `[edit_file] replaced 1 occurrence(s) in ${join(scratch, "b.ts")}`
    );
    expect(await readFile(file, "utf8")).toBe("x = 2\n");
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
