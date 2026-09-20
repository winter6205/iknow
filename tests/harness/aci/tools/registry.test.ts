/**
 * tests/harness/aci/tools/registry.test.ts
 *
 * `createDefaultAciRegistry` — unit tests for the SSOT tool-registry layer. The assembly
 * shape is same-source as ACI_TOOLSET_NAMES; concrete counts are not enumerated in
 * comments (counts drift) — each case treats its `.filter(...)` expression as the source
 * of truth, checked against `ACI_TOOLSET_NAMES.length` and the Gate 3 mirror.
 *
 * The old 10 lsp_* tools are retired (spec symbol-primary-aci.md); their implementation
 * still lives in `lsp.ts` as the SSOT reuse layer for `symbol.ts`, and createLspToolSet
 * is no longer assembled into factories.
 *
 * Aligns with upstream `create_default_tool_registry()` (tools/__init__.py:48): a single
 * assembly function returns the registry, shared by all entry points. Five boundary classes are locked:
 *
 *   - happy path: returns an AciRegistry; list() names = the full `ACI_TOOLSET_NAMES` set
 *     (all conditional seams + subagentManager + worktree host seams present), order append-only.
 *     Note: run_graph is always registered (same gate as subagentManager); graphAssembly
 *     absence does not affect registry membership (the handler's default-off isEnabled guards it)
 *   - empty input: env.web all undefined → constructs without throwing; sandboxRoot "" → no throw
 *   - invalid input: proxy non-http/https or carrying credentials → synchronous ToolExecutionError at assembly
 *   - overflow/boundary: sandboxRoot pointing to a nonexistent path → no assembly-time throw (fs tools reject at execution time)
 *   - concurrency: two factory calls return mutually independent AciRegistries (isolated tool closures)
 *
 * Also locks Gate 3 (SSOT append-only discipline): the tool names actually assembled by
 * `createDefaultAciRegistry()` strictly match `ACI_TOOLSET_NAMES` (length + order + members).
 * Gate 3's throw path is structural (derived-from-map) and cannot be triggered externally
 * without refactoring, so only positive consistency is locked; divergence fails by
 * construction at assembly. memory / skill / subagent / mcp resources tools are
 * conditionally assembled (the comparison list filters as a mirror of memoryDir /
 * skillCatalog / subagentManager / mcpManager presence).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultAciRegistry,
  ACI_TOOLSET_NAMES,
} from "../../../../src/harness/aci/tools/registry.js";
import { createSkillCatalog } from "../../../../src/harness/skill/catalog.js";
import { createLastReadLedgerHost } from "../../../../src/harness/aci/last-read-ledger.js";
import type { IknowEnv } from "../../../../src/config/env.js";
import type { SubAgentManager } from "../../../../src/harness/subagent/manager.js";
import type { McpManager } from "../../../../src/harness/mcp/manager.js";
import type { BackgroundTaskManager } from "../../../../src/harness/background/manager.js";
import type { CreateWorktreeProvisionFn } from "../../../../src/harness/aci/tools/create-worktree.js";
import type { WorktreeEnterToolDeps } from "../../../../src/harness/aci/tools/enter-worktree.js";
import type { WorktreeExitToolDeps } from "../../../../src/harness/aci/tools/exit-worktree.js";
import type { ListWorktreesToolDeps } from "../../../../src/harness/aci/tools/list-worktrees.js";
import type { RemoveWorktreeToolDeps } from "../../../../src/harness/aci/tools/remove-worktree.js";

/** Minimal valid env (web fields only; LLM fields are not consumed by the factories). */
function makeWebEnv(
  overrides: Partial<IknowEnv["web"]> = {}
): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined, ...overrides } };
}

const EXPECTED_TOOLS: readonly string[] = ACI_TOOLSET_NAMES;

/** Fake subagentManager (used only for createDefaultAciRegistry assembly-time assertions that
 * spawn_subagent / subagent_result are present; handler-path unit tests live in
 * tests/subagent/spawn-subagent.test.ts and tests/subagent/subagent-result.test.ts). */
const fakeSubagentManager: SubAgentManager = {
  spawn: () => ({ taskId: "fake-id" }),
  queryBuffer: () => ({ status: "not_found" }),
  waitFor: () => Promise.reject(new Error("not used")),
  shutdown: () => Promise.resolve(),
  drainCompleted: () => [],
  listActive: () => [],
  abortTask: () => false,
  // The interface gained read-only enumeration methods — the fake completes them to stay structurally compatible.
  getCapacity: () => 15,
  listSubagents: () => [],
  // SubAgentManager interface extension: subscribe lets the parent watch subagent state
  // changes (mailbox contract). The fake does not implement the callback mechanism and returns a noop unsubscribe.
  subscribe: () => () => {},
};

/** worktree isolation host fakes — assert conditional assembly only; handler paths live in
 * tests/harness/aci/tools/worktree-lifecycle.test.ts. */
const fakeWorktreeProvision: CreateWorktreeProvisionFn = async () =>
  "/tmp/fake-worktree";
const fakeWorktreeEnter: WorktreeEnterToolDeps["worktreeEnter"] = async () => ({
  path: "/tmp/fake-worktree",
  receipt: "entered task worktree: /tmp/fake-worktree",
});
const fakeWorktreeExit: WorktreeExitToolDeps["worktreeExit"] = async () =>
  "/tmp/fake-main";
const fakeWorktreeList: ListWorktreesToolDeps["worktreeList"] = async () => [];
const fakeWorktreeRemove: RemoveWorktreeToolDeps["worktreeRemove"] =
  async () => ({
    label: undefined,
    conversationId: "fake-conversation",
    path: "/tmp/fake-worktree",
    branch: "iknow/task-fake-conversation",
    head: "fake-head",
    branchDeleted: false,
  });

/** Fake mcpManager (used only for createDefaultAciRegistry assembly-time assertions that
 * list_mcp_resources / read_mcp_resource are present; handler-path unit tests live in
 * tests/harness/aci/tools/list-mcp-resources.test.ts and
 * tests/harness/aci/tools/read-mcp-resource.test.ts). */
const fakeMcpManager: McpManager = {
  start: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
  status: () => [],
  listResources: () => Promise.reject(new Error("fake: list not stubbed")),
  readResource: () => Promise.reject(new Error("fake: read not stubbed")),
} as unknown as McpManager;

/** Fake backgroundManager (used only for createDefaultAciRegistry assembly-time assertions that
 * bash_output / bash_stop are present; handler-path unit tests live in
 * tests/harness/aci/bash-output-stop.test.ts). */
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
  // Full conditional assembly: memoryDir + skillCatalog + subagentManager +
  // todoDir + mcpManager + backgroundManager + graphAssembly all present → list()
  // equals the full length of ACI_TOOLSET_NAMES, order append-only. The 10 lsp_*
  // tools are retired (coordinate surface → symbol surface took over); the SSOT in lsp.ts is unchanged.
  it("memoryDir + skillCatalog + subagentManager + todoDir + mcpManager + backgroundManager + graphAssembly 同时在场 → list() 全量 = ACI_TOOLSET_NAMES 全长,顺序 append-only", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      memoryDir: "/tmp/root/memory",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
      // todo_write is conditionally assembled: joins the registry only when todoDir is present.
      todoDir: "/tmp/root/session-1/todos",
      mcpManager: fakeMcpManager,
      // bash_output / bash_stop are conditionally assembled: join only when backgroundManager is present.
      backgroundManager: fakeBackgroundManager,
      // graph overlay present → run_graph joins the registry.
      graphAssembly: { enabled: () => true },
      // worktree isolation (ADR-0037): conditioned assembly — joins only when the host seams are present.
      worktreeProvision: fakeWorktreeProvision,
      worktreeEnter: fakeWorktreeEnter,
      worktreeExit: fakeWorktreeExit,
      worktreeList: fakeWorktreeList,
      worktreeRemove: fakeWorktreeRemove,
    });
    const names = reg.inner.list().map((def) => def.name);
    expect(names).toEqual([...EXPECTED_TOOLS]);
    expect(reg.catalog.get("web_fetch")).toBeDefined();
    expect(reg.catalog.get("web_search")).toBeDefined();
    expect(reg.catalog.get("memory_recall")).toBeDefined();
    expect(reg.catalog.get("memory_save")).toBeDefined();
    expect(reg.catalog.get("tool_search")).toBeDefined();
    expect(reg.catalog.get("skill")).toBeDefined();
    // skill_search was removed; it is not in ACI_TOOLSET_NAMES.
    expect(reg.catalog.get("skill_search")).toBeUndefined();
    expect(reg.catalog.get("spawn_subagent")).toBeDefined();
    expect(reg.catalog.get("subagent_result")).toBeDefined();
    // todo_write joins the registry when todoDir is present.
    expect(reg.catalog.get("todo_write")).toBeDefined();
    // mcpManager conditional assembly: both tools join when it is present.
    expect(reg.catalog.get("list_mcp_resources")).toBeDefined();
    expect(reg.catalog.get("read_mcp_resource")).toBeDefined();
    // backgroundManager conditional assembly: both tools join when it is present.
    expect(reg.catalog.get("bash_output")).toBeDefined();
    expect(reg.catalog.get("bash_stop")).toBeDefined();
  });

  it("memoryDir + skillCatalog + subagentManager 都缺席 → list() 26 件(8 基线 + tool_search + query_trace + 10 符号查询 + 5 符号改 + list_sessions + get_record,无 memory/skill/spawn/todo/mcp/bg/run_graph/worktree)", () => {
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
          n !== "spawn_subagent" &&
          n !== "subagent_result" &&
          n !== "subagent_stop" &&
          n !== "subagent_continue" &&
          n !== "todo_write" &&
          n !== "list_mcp_resources" &&
          n !== "read_mcp_resource" &&
          n !== "bash_output" &&
          n !== "bash_stop" &&
          // run_graph is always registered — absent from the registry only when
          // subagentManager is absent (graphAssembly absence is guarded by the handler's default-off isEnabled).
          n !== "run_graph" &&
          // worktree isolation (ADR-0037): all of worktreeProvision / worktreeEnter /
          // worktreeExit host seams absent → the worktree tools are absent.
          n !== "create-worktree" &&
          n !== "enter-worktree" &&
          n !== "exit-worktree" &&
          n !== "list-worktrees" &&
          n !== "remove-worktree"
      )
    );
    expect(reg.catalog.get("tool_search")).toBeDefined();
    expect(reg.catalog.get("memory_recall")).toBeUndefined();
    expect(reg.catalog.get("memory_save")).toBeUndefined();
    expect(reg.catalog.get("skill")).toBeUndefined();
    // skill_search: removed.
    expect(reg.catalog.get("skill_search")).toBeUndefined();
    expect(reg.catalog.get("spawn_subagent")).toBeUndefined();
    expect(reg.catalog.get("subagent_result")).toBeUndefined();
    // subagent_stop / subagent_continue share the same gate (absent together).
    expect(reg.catalog.get("subagent_stop")).toBeUndefined();
    expect(reg.catalog.get("subagent_continue")).toBeUndefined();
    // todoDir absent → todo_write absent.
    expect(reg.catalog.get("todo_write")).toBeUndefined();
    // mcpManager absent → list/read absent.
    expect(reg.catalog.get("list_mcp_resources")).toBeUndefined();
    expect(reg.catalog.get("read_mcp_resource")).toBeUndefined();
    // backgroundManager absent → bash_output / bash_stop absent (bash itself is permanent).
    expect(reg.catalog.get("bash_output")).toBeUndefined();
    expect(reg.catalog.get("bash_stop")).toBeUndefined();
  });

  // read_image was appended (permanent) → full length 46. The list order is the contract
  // this test pins: the first 8 keep original order + each append segment locks positions in
  // tail order; any reshuffle goes red.
  it("Gate 3:ACI_TOOLSET_NAMES 长度 46,前 8 原序 + memory_* + tool_search + skill + spawn_subagent + subagent_result + todo_write + list_mcp_resources + read_mcp_resource + bash_output + bash_stop + run_graph + query_trace + 10 符号查询 + 5 符号改 + worktree 3 件 + list_sessions + get_record + list/remove worktree + subagent_stop + subagent_continue + read_image", () => {
    expect(ACI_TOOLSET_NAMES).toHaveLength(46);
    // The first 8 keep original order (append-only discipline).
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
    // The LSP tool set is retired; this segment holds only skill (skill_search was removed,
    // leaving one tool). skill append-only: 1 tool at the tail, no reshuffle of the existing 11.
    expect(ACI_TOOLSET_NAMES.slice(11, 12)).toEqual(["skill"]);
    // skill_search is absent from ACI_TOOLSET_NAMES / visibleSchemas / list.
    expect(ACI_TOOLSET_NAMES).not.toContain("skill_search");
    // spawn_subagent append-only: 1 tool at the tail, no reshuffle of the existing 12.
    expect(ACI_TOOLSET_NAMES.slice(12, 13)).toEqual(["spawn_subagent"]);
    // subagent_result append-only: 1 tool at the tail, no reshuffle of the existing 13.
    expect(ACI_TOOLSET_NAMES.slice(13, 14)).toEqual(["subagent_result"]);
    // todo_write + MCP resources: three tools appended at the tail (segment 14..16),
    // no reshuffle of the existing 14.
    expect(ACI_TOOLSET_NAMES.slice(14, 17)).toEqual([
      "todo_write",
      "list_mcp_resources",
      "read_mcp_resource",
    ]);
    // bash_output / bash_stop append-only: 2 tools at the tail, no reshuffle of the existing 17.
    expect(ACI_TOOLSET_NAMES.slice(17, 19)).toEqual([
      "bash_output",
      "bash_stop",
    ]);
    // run_graph append-only: 1 tool at the tail, no reshuffle of the existing 19.
    expect(ACI_TOOLSET_NAMES.slice(19, 20)).toEqual(["run_graph"]);
    // query_trace append-only: 1 tool at the tail, no reshuffle of the existing 20.
    expect(ACI_TOOLSET_NAMES.slice(20, 21)).toEqual(["query_trace"]);
    // worktree isolation (ADR-0037): three tools append-only at the tail, no reshuffle of the
    // existing 21. The create/enter/exit order matches the workflow sequence.
    expect(ACI_TOOLSET_NAMES.slice(21, 24)).toEqual([
      "create-worktree",
      "enter-worktree",
      "exit-worktree",
    ]);
    // Symbol query tools append-only: 10 at the tail, no reshuffle of the existing 24.
    expect(ACI_TOOLSET_NAMES.slice(24, 34)).toEqual([
      "find_symbol",
      "find_declaration",
      "find_referencing_symbols",
      "find_implementations",
      "get_symbols_overview",
      "get_hover",
      "get_diagnostics_for_file",
      "prepare_call_hierarchy",
      "list_incoming_calls",
      "list_outgoing_calls",
    ]);
    // Symbol edit tools append-only: 5 at the tail, no reshuffle of the existing 34
    // (parallel with the query surface; category=write, coexists with edit_file).
    // list_sessions append-only (index 39): directory-axis read tool, no assembly condition →
    // permanent; the tail position is the Gate 3 order contract.
    // get_record append-only (index 40): content-axis read tool, likewise no assembly
    // condition → permanent. The relative order of the two is the three-axis reading order
    // (directory → line → content), the same criterion as the MCP face's tools/list order.
    expect(ACI_TOOLSET_NAMES.slice(34, 41)).toEqual([
      "rename_symbol",
      "replace_symbol_body",
      "insert_before_symbol",
      "insert_after_symbol",
      "safe_delete_symbol",
      "list_sessions",
      "get_record",
    ]);
    expect(ACI_TOOLSET_NAMES.slice(41, 43)).toEqual([
      "list-worktrees",
      "remove-worktree",
    ]);
    // ADR-0101/0102 append-only: 2 tools at the tail (stop first, continue second),
    // no reshuffle of the existing 43.
    expect(ACI_TOOLSET_NAMES.slice(43, 45)).toEqual([
      "subagent_stop",
      "subagent_continue",
    ]);
    // read_image append-only: 1 permanent tool at the tail (no absence condition), no reshuffle of the existing 45.
    expect(ACI_TOOLSET_NAMES.slice(45, 46)).toEqual(["read_image"]);
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
    // Decision: sandboxRoot validation is deferred to execution time (realpath resolution in
    // read-file.ts throws); assembly time only validates proxy URL syntax.
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
 * Tests for factory deny-list pruning.
 *
 * Factory input `disallowedTools?: ReadonlyArray<string>`:
 *   - dual-surface pruning (inner protocol registry + visibleSchemas model-visible schema)
 *   - lenient mode: a deny name not in available → silently skipped (no throw)
 *   - absent / undefined / empty array → byte-identical backward compatibility
 *   - Gate 3 mirror filter: toolsetNames and factories key sets stay consistent (including deny-name filtering)
 *   - orthogonal composition with existing conditional assembly (memoryDir / skillCatalog / subagentManager)
 *
 * Verification helper: full set − conditionally-absent keys − deny-list, same source as the factory's Gate 3 mirror.
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
    graph?: boolean;
    worktree?: boolean;
    worktreeList?: boolean;
    worktreeRemove?: boolean;
  } = {}
): readonly string[] {
  const conditionallyAbsent = [
    ...(opts.memory ? [] : ["memory_recall", "memory_save"]),
    ...(opts.skill ? [] : ["skill"]),
    ...(opts.subagent ? [] : ["spawn_subagent", "subagent_result"]),
    // stop / continue share the same gate as spawn / result.
    ...(opts.subagent ? [] : ["subagent_stop", "subagent_continue"]),
    ...(opts.todo ? [] : ["todo_write"]),
    ...(opts.mcp ? [] : ["list_mcp_resources", "read_mcp_resource"]),
    ...(opts.bg ? [] : ["bash_output", "bash_stop"]),
    // run_graph is always registered — absent only when subagentManager is absent.
    // graphAssembly absence is guarded by the handler's default-off isEnabled; the tool stays in the registry.
    ...(opts.subagent ? [] : ["run_graph"]),
    // worktree isolation (ADR-0037): joins the registry only when all of worktreeProvision /
    // worktreeEnter / worktreeExit host seams are present.
    ...(opts.worktree
      ? []
      : ["create-worktree", "enter-worktree", "exit-worktree"]),
    ...(opts.worktreeList ? [] : ["list-worktrees"]),
    ...(opts.worktreeRemove ? [] : ["remove-worktree"]),
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
    // The 5 denied tools are absent on both inner and catalog surfaces.
    expect(reg.catalog.get("bash")).toBeUndefined();
    expect(reg.catalog.get("edit_file")).toBeUndefined();
    expect(reg.catalog.get("write_file")).toBeUndefined();
    expect(reg.catalog.get("web_fetch")).toBeUndefined();
    expect(reg.catalog.get("web_search")).toBeUndefined();
    // Tools not denied are still present.
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
    // Unknown names are leniently ignored — every tool except bash remains.
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
    // memory_save is not denied and its conditional seam is present, so it stays (deny and conditional assembly compose orthogonally).
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
    // Full conditional assembly: both registries get todoDir + mcpManager +
    // backgroundManager; assert catalog.all() lengths are independent (closure isolation,
    // shared types never cross-contaminate).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const a = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root-a",
      memoryDir: "/tmp/root-a/memory",
      skillCatalog: createSkillCatalog([]),
      subagentManager: fakeSubagentManager,
      todoDir: "/tmp/root-a/session-a/todos",
      mcpManager: fakeMcpManager,
      backgroundManager: fakeBackgroundManager,
      // run_graph is always registered — graphAssembly presence only decides the value
      // passed through to handler isEnabled, not registry membership.
      graphAssembly: { enabled: () => true },
      worktreeProvision: fakeWorktreeProvision,
      worktreeEnter: fakeWorktreeEnter,
      worktreeExit: fakeWorktreeExit,
      worktreeList: fakeWorktreeList,
      worktreeRemove: fakeWorktreeRemove,
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
      // run_graph is always registered.
      graphAssembly: { enabled: () => true },
      worktreeProvision: fakeWorktreeProvision,
      worktreeEnter: fakeWorktreeEnter,
      worktreeExit: fakeWorktreeExit,
      worktreeList: fakeWorktreeList,
      worktreeRemove: fakeWorktreeRemove,
    });
    expect(a).not.toBe(b);
    expect(a.catalog).not.toBe(b.catalog);
    // Each tool closure holds its own sandboxRoot — assert read_file isolation:
    // (fetch tool defs through catalog without triggering real execution; only registry-node independence is verified)
    expect(a.catalog.all()).toHaveLength(EXPECTED_TOOLS.length);
    expect(b.catalog.all()).toHaveLength(EXPECTED_TOOLS.length);
  });
});

describe("createDefaultAciRegistry — task worktree lifecycle seams", () => {
  it("registers list and remove independently when only their host seams exist", () => {
    const listOnly = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      worktreeList: fakeWorktreeList,
    });
    const removeOnly = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      worktreeRemove: fakeWorktreeRemove,
    });

    expect(listOnly.inner.list().map((tool) => tool.name)).toEqual(
      expectedSurface([], { worktreeList: true })
    );
    expect(listOnly.catalog.get("list-worktrees")?.aci.category).toBe(
      "read-only"
    );
    expect(listOnly.catalog.get("remove-worktree")).toBeUndefined();
    expect(removeOnly.inner.list().map((tool) => tool.name)).toEqual(
      expectedSurface([], { worktreeRemove: true })
    );
    expect(removeOnly.catalog.get("remove-worktree")?.aci.category).toBe(
      "write"
    );
    expect(removeOnly.catalog.get("list-worktrees")).toBeUndefined();
  });

  it("does not register list/remove when only the legacy provision/enter/exit seams exist (OFF-adjacent host shape)", () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
      worktreeProvision: fakeWorktreeProvision,
      worktreeEnter: fakeWorktreeEnter,
      worktreeExit: fakeWorktreeExit,
    });
    const names = reg.inner.list().map((tool) => tool.name);
    expect(names).toEqual(expectedSurface([], { worktree: true }));
    expect(reg.catalog.get("create-worktree")).toBeDefined();
    expect(reg.catalog.get("list-worktrees")).toBeUndefined();
    expect(reg.catalog.get("remove-worktree")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session-scoped todoDir seam (host-injected factory side).
//
// Scope: asserts only that createDefaultAciRegistry accepts the todoDir opt (host
// injection) and Gate 3 does not throw — the todo_write tool factory + SSOT
// append-only assembly belong to later tasks; this seam test does not assume the
// tool is already in the registry (avoiding coupling with SSOT discipline).
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
      // run_graph is always registered — graphAssembly is passed through to the handler
      // isEnabled closure, unrelated to registry membership.
      graphAssembly: { enabled: () => true },
      worktreeProvision: fakeWorktreeProvision,
      worktreeEnter: fakeWorktreeEnter,
      worktreeExit: fakeWorktreeExit,
      worktreeList: fakeWorktreeList,
      worktreeRemove: fakeWorktreeRemove,
    });
    // Full conditional assembly: all 6 conditional seams present → the registry equals the
    // full ACI_TOOLSET_NAMES (the symbol tools replaced the retired lsp_* set).
    expect(reg.inner.list().map((d) => d.name)).toEqual([...EXPECTED_TOOLS]);
  });
});

describe("createDefaultAciRegistry — projectIdentityRoot wiring (grep / glob)", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-reg-identity-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("ON wiring: with opts.projectIdentityRoot set and the engine root rebound to a task worktree, registry-assembled grep and glob reach the identity root", async () => {
    const repo = join(scratch, "repo");
    const task = join(repo, ".iknow", "worktrees", "fix-648--conv-1");
    await mkdir(task, { recursive: true });
    await writeFile(join(repo, "AGENTS.md"), "identity guidance\n", "utf8");

    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: task,
      projectIdentityRoot: repo,
    });

    const grep = reg.catalog.get("grep");
    expect(grep).toBeDefined();
    // The default output face is paths; this case locks "identity root reachability" — line content must be requested explicitly.
    const grepOut = String(
      await grep!.handler({
        pattern: "identity guidance",
        path: repo,
        output: "content",
      })
    );
    expect(grepOut).toMatch(/AGENTS\.md:1:identity guidance/);

    const glob = reg.catalog.get("glob");
    expect(glob).toBeDefined();
    const globOut = String(
      await glob!.handler({ pattern: "AGENTS.md", path: repo })
    );
    expect(globOut).toMatch(/AGENTS\.md/);
  });

  it("OFF wiring: without opts.projectIdentityRoot the registry-assembled grep and glob stay fenced to the engine root and cannot escape to an identity root", async () => {
    const repo = join(scratch, "repo");
    const identity = join(scratch, "identity");
    await mkdir(repo, { recursive: true });
    await mkdir(identity, { recursive: true });
    await writeFile(join(identity, "AGENTS.md"), "identity guidance\n", "utf8");

    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: repo,
    });

    const grep = reg.catalog.get("grep");
    const glob = reg.catalog.get("glob");
    await expect(
      grep!.handler({ pattern: "identity guidance", path: identity })
    ).rejects.toThrow(/path outside workspace/);
    await expect(
      glob!.handler({ pattern: "AGENTS.md", path: identity })
    ).rejects.toThrow(/path outside workspace/);
  });
});

// ADR-0084: last-read ledger wiring at the registry layer. Tool-layer unit tests live in
// write-file-last-read / bash-last-read / read-file; here only assembly facts are pinned —
// without opts.lastReadLedger the registry builds one itself (the gate takes effect by
// default); explicit injection shares across registries (rebind reconstruction keeps read
// memory); without injection registries do not share.
describe("createDefaultAciRegistry — last-read ledger 接线 (ADR-0084)", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aci-reg-last-read-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("默认接线：read_file 成功后 write_file 覆写放行（同一 conversation）", async () => {
    const file = join(scratch, "a.ts");
    await writeFile(file, "original\n", "utf8");
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: scratch,
    });

    await reg.catalog
      .get("read_file")!
      .handler({ path: "a.ts" }, { conversationId: "conv-a" });
    await reg.catalog
      .get("write_file")!
      .handler(
        { path: "a.ts", content: "rewritten\n" },
        { conversationId: "conv-a" }
      );

    expect(await readFile(file, "utf8")).toBe("rewritten\n");
  });

  it("默认接线：未读的非空覆写被拒（闸随默认装配生效，不靠额外注入）", async () => {
    const file = join(scratch, "a.ts");
    await writeFile(file, "original\n", "utf8");
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: scratch,
    });

    await expect(
      reg.catalog
        .get("write_file")!
        .handler(
          { path: "a.ts", content: "clobbered\n" },
          { conversationId: "conv-a" }
        )
    ).rejects.toThrow(/refusing to overwrite a non-empty file/);
    expect(await readFile(file, "utf8")).toBe("original\n");
  });

  it("两次 registry 装配（未注入 host）各自持有一份账本：跨 registry 不隐式共享", async () => {
    const file = join(scratch, "a.ts");
    await writeFile(file, "original\n", "utf8");
    const first = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: scratch,
    });
    const second = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: scratch,
    });

    await first.catalog
      .get("read_file")!
      .handler({ path: "a.ts" }, { conversationId: "conv-a" });
    await expect(
      second.catalog
        .get("write_file")!
        .handler(
          { path: "a.ts", content: "clobbered\n" },
          { conversationId: "conv-a" }
        )
    ).rejects.toThrow(/refusing to overwrite a non-empty file/);
  });

  it("显式注入 host → 跨 registry 共享（rebind 重建后读记忆保留）", async () => {
    const file = join(scratch, "a.ts");
    await writeFile(file, "original\n", "utf8");
    const host = createLastReadLedgerHost();
    const first = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: scratch,
      lastReadLedger: host,
    });
    const second = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: scratch,
      lastReadLedger: host,
    });

    await first.catalog
      .get("read_file")!
      .handler({ path: "a.ts" }, { conversationId: "conv-a" });
    await second.catalog
      .get("write_file")!
      .handler(
        { path: "a.ts", content: "rewritten\n" },
        { conversationId: "conv-a" }
      );

    expect(await readFile(file, "utf8")).toBe("rewritten\n");
  });
});
