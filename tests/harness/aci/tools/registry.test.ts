/**
 * tests/harness/aci/tools/registry.test.ts
 *
 * `createDefaultAciRegistry` — 30 件 SSOT 工具注册层单元测试
 * （六条件键 memoryDir / skillCatalog / subagentManager / todoDir / mcpManager
 *  / backgroundManager 全部缺席 → 19 件 = 8 基线 + tool_search + 10 LSP；
 *  只 memoryDir → 21 件；memoryDir+skillCatalog → 23 件；三者皆在场 → 25 件；
 *  五者皆在场 → 28 件；六者皆在场 → 30 件 = 全量 #502 T4 末态）。
 *
 * 对齐 upstream `create_default_tool_registry()`(tools/__init__.py:48):
 * 单一装配函数返回注册表,所有入口共享。本测试锁 5 边界类:
 *
 *   - 正常路径:返回 AciRegistry,list() 30 工具(六条件键全在场),顺序 append-only
 *   - 空输入:env.web 全空(undefined)→ 直连不抛;sandboxRoot:"" → 不抛
 *   - 非法输入:proxy 非 http/https / 含凭据 → 装配期同步抛 ToolExecutionError
 *   - 溢出/边界:sandboxRoot 指向不存在路径 → 装配期不抛(执行期由 fs 工具越界逻辑拒绝)
 *   - 并发:两次工厂调用返回的 AciRegistry 相互独立(工具闭包隔离)
 *
 * 另锁 Gate 3(SSOT append-only 纪律,S1/D12):`createDefaultAciRegistry()`
 * 实际装配出的工具名与 `ACI_TOOLSET_NAMES` 严格一致(长度 + 顺序 + 成员)。
 * Gate 3 的抛错路径是结构性(derived-from-map),不重构无法从外部触发,
 * 故只锁正向一致;分歧在装配期 by-construction 失败。memory / skill /
 * subagent / mcp resources 工具是条件装配的(对照名单按 memoryDir /
 * skillCatalog / subagentManager / mcpManager 镜像过滤)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultAciRegistry,
  ACI_TOOLSET_NAMES,
} from "../../../../src/harness/aci/tools/registry.js";
import { createSkillCatalog } from "../../../../src/harness/skill/catalog.js";
import type { IknowEnv } from "../../../../src/config/env.js";
import type { SubAgentManager } from "../../../../src/harness/subagent/manager.js";
import type { McpManager } from "../../../../src/harness/mcp/manager.js";
import type { BackgroundTaskManager } from "../../../../src/harness/background/manager.js";

/** 合法最小 env(仅 web 字段;LLM 字段工厂不消费)。 */
function makeWebEnv(
  overrides: Partial<IknowEnv["web"]> = {}
): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined, ...overrides } };
}

const EXPECTED_TOOLS: readonly string[] = ACI_TOOLSET_NAMES;

/** #356 T4/T5 fake subagentManager（仅用于 createDefaultAciRegistry 装配期断言
 * spawn_subagent / subagent_result 在场；handler 路径单测在
 * tests/subagent/spawn-subagent.test.ts 与 tests/subagent/subagent-result.test.ts）。 */
const fakeSubagentManager: SubAgentManager = {
  spawn: () => ({ taskId: "fake-id" }),
  queryBuffer: () => ({ status: "not_found" }),
  waitFor: () => Promise.reject(new Error("not used")),
  shutdown: () => Promise.resolve(),
  drainCompleted: () => [],
};

/** #440 T11 fake mcpManager（仅用于 createDefaultAciRegistry 装配期断言
 * list_mcp_resources / read_mcp_resource 在场；handler 路径单测在
 * tests/harness/aci/tools/list-mcp-resources.test.ts 与
 * tests/harness/aci/tools/read-mcp-resource.test.ts）。 */
const fakeMcpManager: McpManager = {
  start: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
  status: () => [],
  listResources: () => Promise.reject(new Error("fake: list not stubbed")),
  readResource: () => Promise.reject(new Error("fake: read not stubbed")),
} as unknown as McpManager;

/** #502 T4 fake backgroundManager（仅用于 createDefaultAciRegistry 装配期断言
 * bash_output / bash_stop 在场；handler 路径单测在
 * tests/harness/aci/bash-output-stop.test.ts）。 */
const fakeBackgroundManager: BackgroundTaskManager = {
  spawn: () => Promise.reject(new Error("fake: spawn not stubbed")),
  status: () => Promise.reject(new Error("fake: status not stubbed")),
  output: () => Promise.reject(new Error("fake: output not stubbed")),
  stop: () => Promise.reject(new Error("fake: stop not stubbed")),
  shutdown: () => Promise.resolve(),
  registerConversationDeletedListener: () => undefined,
  onConversationDeleted: () => undefined,
} as unknown as BackgroundTaskManager;

describe("createDefaultAciRegistry — 正常路径", () => {
  // #502 T4 全条件装配：memoryDir + skillCatalog + subagentManager +
  // todoDir + mcpManager + backgroundManager 同时在场 → list() 全量 30 件
  // （28 基线 + bash_output + bash_stop），顺序 append-only。
  it("memoryDir + skillCatalog + subagentManager + todoDir + mcpManager + backgroundManager 同时在场 → list() 全量 30 件,顺序 append-only", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      memoryDir: "/tmp/root/memory",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
      // #440 T4:todo_write 条件化装配,todoDir 在场才入注册表。
      todoDir: "/tmp/root/session-1/todos",
      mcpManager: fakeMcpManager,
      // #502 T4:bash_output / bash_stop 条件化装配,backgroundManager 在场才入注册表。
      backgroundManager: fakeBackgroundManager,
    });
    const names = reg.inner.list().map((def) => def.name);
    expect(names).toEqual([...EXPECTED_TOOLS]);
    expect(reg.catalog.get("web_fetch")).toBeDefined();
    expect(reg.catalog.get("web_search")).toBeDefined();
    expect(reg.catalog.get("memory_recall")).toBeDefined();
    expect(reg.catalog.get("memory_save")).toBeDefined();
    expect(reg.catalog.get("tool_search")).toBeDefined();
    expect(reg.catalog.get("skill")).toBeDefined();
    expect(reg.catalog.get("skill_search")).toBeDefined();
    expect(reg.catalog.get("spawn_subagent")).toBeDefined();
    expect(reg.catalog.get("subagent_result")).toBeDefined();
    // #440 T4:todo_write 在 todoDir 在场时进入注册表。
    expect(reg.catalog.get("todo_write")).toBeDefined();
    // #440 T11:mcpManager 条件化装配,在场时两件入注册表。
    expect(reg.catalog.get("list_mcp_resources")).toBeDefined();
    expect(reg.catalog.get("read_mcp_resource")).toBeDefined();
    // #502 T4:backgroundManager 条件化装配,在场时两件入注册表。
    expect(reg.catalog.get("bash_output")).toBeDefined();
    expect(reg.catalog.get("bash_stop")).toBeDefined();
  });

  it("memoryDir + skillCatalog + subagentManager 都缺席 → list() 19 件(8 基线 + tool_search + 10 LSP,无 memory/skill/spawn/todo/mcp/bg 工具)", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
    });
    const names = reg.inner.list().map((d) => d.name);
    expect(names).toEqual(
      [...ACI_TOOLSET_NAMES].filter(
        (n) =>
          n !== "memory_recall" &&
          n !== "memory_save" &&
          n !== "skill" &&
          n !== "skill_search" &&
          n !== "spawn_subagent" &&
          n !== "subagent_result" &&
          n !== "todo_write" &&
          n !== "list_mcp_resources" &&
          n !== "read_mcp_resource" &&
          n !== "bash_output" &&
          n !== "bash_stop"
      )
    );
    expect(reg.catalog.get("tool_search")).toBeDefined();
    expect(reg.catalog.get("memory_recall")).toBeUndefined();
    expect(reg.catalog.get("memory_save")).toBeUndefined();
    expect(reg.catalog.get("skill")).toBeUndefined();
    expect(reg.catalog.get("skill_search")).toBeUndefined();
    expect(reg.catalog.get("spawn_subagent")).toBeUndefined();
    expect(reg.catalog.get("subagent_result")).toBeUndefined();
    // #440 T4:todoDir 缺席 → todo_write 缺席。
    expect(reg.catalog.get("todo_write")).toBeUndefined();
    // #440 T11:mcpManager 缺席 → list/read 缺席。
    expect(reg.catalog.get("list_mcp_resources")).toBeUndefined();
    expect(reg.catalog.get("read_mcp_resource")).toBeUndefined();
    // #502 T4:backgroundManager 缺席 → bash_output / bash_stop 缺席（bash 常驻）。
    expect(reg.catalog.get("bash_output")).toBeUndefined();
    expect(reg.catalog.get("bash_stop")).toBeUndefined();
  });

  // #502 T4 全条件装配:ACI_TOOLSET_NAMES 长度 30(28 基线 + bash_output +
  // bash_stop),顺序 append-only 不重排既有。
  it("Gate 3:ACI_TOOLSET_NAMES 长度 30,前 8 原序 + memory_* + tool_search + 10 LSP + skill + skill_search + spawn_subagent + subagent_result + todo_write + list_mcp_resources + read_mcp_resource + bash_output + bash_stop", () => {
    expect(ACI_TOOLSET_NAMES).toHaveLength(30);
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
    // #251 LSP 工具集 append-only:11→21,10 件在末尾,不重排既有 11 件。
    expect(ACI_TOOLSET_NAMES.slice(11, 21)).toEqual([
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
    ]);
    // #337 T5 skill 工具集 append-only:21→23,2 件在末尾,不重排既有 21 件。
    expect(ACI_TOOLSET_NAMES.slice(21, 23)).toEqual(["skill", "skill_search"]);
    // #356 T4 spawn_subagent append-only:23→24,末位 1 件,不重排既有 23 件。
    expect(ACI_TOOLSET_NAMES.slice(23, 24)).toEqual(["spawn_subagent"]);
    // #356 T5 subagent_result append-only:24→25,末位 1 件,不重排既有 24 件。
    expect(ACI_TOOLSET_NAMES.slice(24, 25)).toEqual(["subagent_result"]);
    // #440 双 Stream 并集:todo_write (T4) + MCP resources (T11) 三件
    // 末尾 append-only,不重排既有 25 件。
    expect(ACI_TOOLSET_NAMES.slice(25, 28)).toEqual([
      "todo_write",
      "list_mcp_resources",
      "read_mcp_resource",
    ]);
    // #502 T4 bash_output / bash_stop 工具集 append-only:28→30,末位 2 件,
    // 不重排既有 28 件。
    expect(ACI_TOOLSET_NAMES.slice(28, 30)).toEqual([
      "bash_output",
      "bash_stop",
    ]);
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
    })) as { output: string };
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(file);
    expect(result.output).toBe(
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
    })) as { output: string };
    expect(result.output).toBe(
      `[edit_file] replaced 1 occurrence(s) in ${join(scratch, "b.ts")}`
    );
    expect(await readFile(file, "utf8")).toBe("x = 2\n");
  });
});

/**
 * #468 T1 工厂 deny-list 裁剪的测试。
 *
 * 工厂入参 `disallowedTools?: ReadonlyArray<string>`:
 *   - 双面裁剪（inner 协议 registry + visibleSchemas 模型可见 schema）
 *   - 宽容模式：deny 名不在 available → 静默跳过（不抛）
 *   - 缺席 / undefined / 空数组 → byte-identical 向后兼容
 *   - Gate 3 镜像过滤：toolsetNames 与 factories 键集一致（含 deny 名过滤）
 *   - 与既有条件化装配（memoryDir / skillCatalog / subagentManager）正交组合
 *
 * 验证 helper:全量 − 条件化缺席键 − deny-list，与工厂 Gate 3 镜像同源。
 */
function expectedSurface(
  deny: ReadonlyArray<string>,
  opts: {
    memory?: boolean;
    skill?: boolean;
    subagent?: boolean;
    todo?: boolean;
    mcp?: boolean;
    bg?: boolean;
  } = {}
): readonly string[] {
  const conditionallyAbsent = [
    ...(opts.memory ? [] : ["memory_recall", "memory_save"]),
    ...(opts.skill ? [] : ["skill", "skill_search"]),
    ...(opts.subagent ? [] : ["spawn_subagent", "subagent_result"]),
    ...(opts.todo ? [] : ["todo_write"]),
    ...(opts.mcp ? [] : ["list_mcp_resources", "read_mcp_resource"]),
    ...(opts.bg ? [] : ["bash_output", "bash_stop"]),
  ];
  return [...ACI_TOOLSET_NAMES].filter(
    (n) => !conditionallyAbsent.includes(n) && !deny.includes(n)
  );
}

describe("createDefaultAciRegistry — #468 disallowedTools 裁剪", () => {
  it("deny 5 禁项 → inner/visibleSchemas 双面同集,其余工具在场", () => {
    const deny = ["bash", "edit_file", "write_file", "web_fetch", "web_search"];
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      disallowedTools: deny,
    });
    const expected = expectedSurface(deny);
    const names = reg.inner.list().map((def) => def.name);
    expect(names).toEqual(expected);
    expect(reg.visibleSchemas().map((s) => s.name)).toEqual(expected);
    // 5 禁项 inner + catalog 双面缺席。
    expect(reg.catalog.get("bash")).toBeUndefined();
    expect(reg.catalog.get("edit_file")).toBeUndefined();
    expect(reg.catalog.get("write_file")).toBeUndefined();
    expect(reg.catalog.get("web_fetch")).toBeUndefined();
    expect(reg.catalog.get("web_search")).toBeUndefined();
    // 未被 deny 的工具仍在场。
    expect(reg.catalog.get("read_file")).toBeDefined();
    expect(reg.catalog.get("grep")).toBeDefined();
    expect(reg.catalog.get("tool_search")).toBeDefined();
  });

  it("deny 含未知名工具名 → 宽容忽略,只裁已知项", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      disallowedTools: ["bash", "foo_tool_does_not_exist"],
    });
    const names = reg.inner.list().map((def) => def.name);
    expect(names).not.toContain("bash");
    expect(names).toContain("read_file");
    // 未知名被宽容忽略 — 除 bash 外其余工具全在场。
    expect(names).toEqual(expectedSurface(["bash"]));
    expect(reg.visibleSchemas().map((s) => s.name)).toEqual(names);
  });

  it("deny 空数组 / undefined / 缺省 → 三种形态 byte-identical(向后兼容)", () => {
    const base = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
    });
    const empty = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      disallowedTools: [],
    });
    const undef = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      disallowedTools: undefined,
    });
    const baseNames = base.inner.list().map((d) => d.name);
    const baseVisible = base.visibleSchemas().map((s) => s.name);
    expect(empty.inner.list().map((d) => d.name)).toEqual(baseNames);
    expect(undef.inner.list().map((d) => d.name)).toEqual(baseNames);
    expect(empty.visibleSchemas().map((s) => s.name)).toEqual(baseVisible);
    expect(undef.visibleSchemas().map((s) => s.name)).toEqual(baseVisible);
  });

  it("deny 与条件化装配组合:memoryDir 在场时 deny memory_recall → 双面剔除,memory_save 仍存", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      memoryDir: "/tmp/root/memory",
      disallowedTools: ["memory_recall"],
    });
    const expected = expectedSurface(["memory_recall"], { memory: true });
    const names = reg.inner.list().map((def) => def.name);
    expect(names).toEqual(expected);
    expect(reg.visibleSchemas().map((s) => s.name)).toEqual(expected);
    expect(reg.catalog.get("memory_recall")).toBeUndefined();
    // memory_save 未被 deny,条件化亦在场,故保留(deny 与条件化正交可组合)。
    expect(reg.catalog.get("memory_save")).toBeDefined();
  });

  it("deny 全量实际工具 → inner/visibleSchemas 为空,装配不 crash(Gate 3 镜像一致)", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      disallowedTools: [...ACI_TOOLSET_NAMES],
    });
    expect(reg.inner.list()).toEqual([]);
    expect(reg.visibleSchemas()).toEqual([]);
  });
});

describe("createDefaultAciRegistry — 并发闭包隔离", () => {
  it("两次工厂调用返回的 AciRegistry 相互独立", () => {
    // #502 T4 全条件装配:两 registry 都给 todoDir + mcpManager +
    // backgroundManager → 30 件,验证 catalog.all() 长度独立（闭包隔离,
    // 共享类型不串味）。
    const a = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root-a",
      memoryDir: "/tmp/root-a/memory",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
      todoDir: "/tmp/root-a/session-a/todos",
      mcpManager: fakeMcpManager,
      backgroundManager: fakeBackgroundManager,
    });
    const b = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root-b",
      memoryDir: "/tmp/root-b/memory",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
      todoDir: "/tmp/root-b/session-b/todos",
      mcpManager: fakeMcpManager,
      backgroundManager: fakeBackgroundManager,
    });
    expect(a).not.toBe(b);
    expect(a.catalog).not.toBe(b.catalog);
    // 工具闭包各自持有自己的 sandboxRoot — 断言 read_file 行为隔离:
    // (通过 catalog 拿工具定义,不触发真实执行,仅验证 registry 节点独立)
    expect(a.catalog.all()).toHaveLength(EXPECTED_TOOLS.length);
    expect(b.catalog.all()).toHaveLength(EXPECTED_TOOLS.length);
  });
});

// ---------------------------------------------------------------------------
// #440 T1 — session 作用域 todoDir seam（D2/D6 host 注入的工厂侧）
//
// 范围：只断言 createDefaultAciRegistry 接受 todoDir opt（host 注入）且
// Gate 3 不抛——todo_write 工具工厂 + SSOT append-only 装配属于 T2/T4，
// T1 不假设工具已在注册表中（避免与 SSOT 纪律耦合）。
// ---------------------------------------------------------------------------

describe("createDefaultAciRegistry — #440 T1 todoDir seam", () => {
  it("todoDir:任意字符串 → 装配期不抛（seam 接受；Gate 3 仍通过）", () => {
    expect(() =>
      createDefaultAciRegistry({
        env: makeWebEnv(),
        sandboxRoot: "/tmp/root",
        todoDir: "/tmp/root/some-session/todos",
      })
    ).not.toThrow();
  });

  it("todoDir:undefined / 缺省 → 与既有行为 byte-identical", () => {
    const base = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
    });
    const withUndef = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      todoDir: undefined,
    });
    expect(withUndef.inner.list().map((d) => d.name)).toEqual(
      base.inner.list().map((d) => d.name)
    );
    expect(withUndef.visibleSchemas().map((s) => s.name)).toEqual(
      base.visibleSchemas().map((s) => s.name)
    );
  });

  it("todoDir 与其他条件化装配（memoryDir / skillCatalog / subagentManager / mcpManager / backgroundManager）正交组合", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      memoryDir: "/tmp/root/memory",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
      todoDir: "/tmp/root/session-1/todos",
      mcpManager: fakeMcpManager,
      backgroundManager: fakeBackgroundManager,
    });
    // #502 T4 全条件装配:6 个条件化 seam 全在场 → 30 件全装配(28 基线 +
    // bash_output + bash_stop)。
    expect(reg.inner.list().map((d) => d.name)).toEqual([...EXPECTED_TOOLS]);
  });
});
