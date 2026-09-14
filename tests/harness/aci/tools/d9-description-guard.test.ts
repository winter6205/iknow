/**
 * #483 D9 description audit — regression guard.
 *
 * Spec: docs/handoff/2026-08-17-wayfinder-440-decisions.md D6/D9 paradigm:
 * tool descriptions must use positive-trigger phrasing (when to use, what
 * to pair it with) plus inline governance constraints (limits / side
 * effects / boundaries), and must NOT contain any NEGATIVE_PHRASES.
 *
 * Scope:
 *   - Assemble createDefaultAciRegistry with ALL conditional deps present
 *     so every tool (including the 5 already-D9-compliant ones: todo_write,
 *     list_mcp_resources, read_mcp_resource, bash_output, bash_stop) is
 *     exercised.
 *   - Iterate every tool from the registry catalog and assert:
 *       1. description length > 0 (sanity)
 *       2. no NEGATIVE_PHRASE appears in any description
 *
 * The guard fails fast if any future description edit accidentally
 * re-introduces an imperative ("do not", "never", …) or a CJK blocklist
 * word ("不要", "禁止", …). Mirrors the #440 T6 D9 style block already
 * pinned in tests/harness/aci/tools/todo-write.test.ts:533-546.
 *
 * Isolation: pure in-memory fixture (no real fs mutations); mkdtemp dirs
 * are scratch anchors only (the tools themselves are not invoked).
 *
 * CI portability: createBashTool calls requireBwrap() at assembly time
 * (bash.ts:45) and the CI runner has no bubblewrap. Mock requireBwrap to
 * a no-op instead of stubbing createBashTool (the registry-workspace-root
 * pattern): the guard must audit the REAL bash description, so the factory
 * stays real and only the host-capability probe is replaced. requireBwrap
 * is assembly-time only — the bash handler never invokes it — and the
 * runner.js mock covers the index.js re-export binding bash.ts consumes.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/harness/sandbox/runner.js")
    >();
  return { ...actual, requireBwrap: () => {} };
});

import {
  createDefaultAciRegistry,
  ACI_TOOLSET_NAMES,
} from "../../../../src/harness/aci/tools/registry.js";
import { createSkillCatalog } from "../../../../src/harness/skill/catalog.js";
import {
  getAgentEntry,
  resolveAgentCatalog,
} from "../../../../src/harness/subagent/catalog.js";
import type { IknowEnv } from "../../../../src/config/env.js";
import type { SubAgentManager } from "../../../../src/harness/subagent/manager.js";
import type { McpManager } from "../../../../src/harness/mcp/manager.js";
import type { BackgroundTaskManager } from "../../../../src/harness/background/manager.js";
import type { CreateWorktreeProvisionFn } from "../../../../src/harness/aci/tools/create-worktree.js";
import type { WorktreeEnterToolDeps } from "../../../../src/harness/aci/tools/enter-worktree.js";
import type { WorktreeExitToolDeps } from "../../../../src/harness/aci/tools/exit-worktree.js";
import type { ListWorktreesToolDeps } from "../../../../src/harness/aci/tools/list-worktrees.js";
import type { RemoveWorktreeToolDeps } from "../../../../src/harness/aci/tools/remove-worktree.js";

/** #483 D9: 12-word blocklist — mirrors tests/harness/aci/tools/todo-write.test.ts:533.
 *
 * 纪律判据（#502 T7）：本表只封禁面向模型的负面祈使（do not / never / 不要…）。
 * 风险/拒绝类描述词（reject / out of scope / guard…）是工具行为的客观约束陈述
 * （web_fetch 的 SSRF guard rejects、edit_file 的 lint rejects、memory_save 的
 * negative-form reject），不面向模型下禁令，且 D9 paradigm（#440 D6/D9）允许
 * 「inline governance constraints」表述；新增此类词会触发四处既有描述越界改
 * 写，超出 T7 范围，故不扩 blocklist。 */
const NEGATIVE_PHRASES: ReadonlyArray<string> = [
  "do not",
  "don't",
  "avoid",
  "should not",
  "shouldn't",
  "never",
  "simple task",
  "trivial",
  "不要",
  "避免",
  "禁止",
  "切勿",
];

/** #502 T7 d9 扩面：正面引导构造（trigger verb）白名单。description 必须
 *  命中至少一个 — 锁写作形态是「何时用 / 与什么配对」而非负面祈使。与
 *  todo-write.test.ts:554-562 的 positive-keys 同思路但放工具集级别。
 *  选词原则：覆盖现有 ACI 工具的动词光谱（use / pair / read / run / fetch
 *  / search / discover / load / list / poll / maintain / capture / delegate
 *  / resolve / apply / create / terminate / return）— 任何 description 命中
 *  之一即过，当前文案均命中（手算已确认，vitest 兜底）。 */
const POSITIVE_TRIGGER_PATTERN =
  /\b(use|pair|read|run|fetch|search|discover|load|list|poll|maintain|capture|delegate|resolve|apply|create|terminate|return)\b/i;

/** Minimal env (only web fields are consumed by the registry factory). */
function makeWebEnv(): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined } };
}

/** Fake SubAgentManager — sufficient for assembly. Mirrors registry.test.ts:51-57. */
const fakeSubagentManager = {
  spawn: () => ({ taskId: "fake-id" }),
  queryBuffer: () => ({ status: "not_found" as const }),
  waitFor: () => Promise.reject(new Error("not used")),
  shutdown: () => Promise.resolve(),
  drainCompleted: () => [],
  listActive: () => [],
  abortTask: () => false,
  // #358 T7: 接口新增只读枚举面 —— fake 补全保持结构兼容。
  listSubagents: () => [],
  // master SubAgentManager 接口扩展:subscribe (mailbox 契约 #361)
  subscribe: () => () => {},
} as unknown as SubAgentManager;

/** Fake McpManager — sufficient for assembly. Mirrors registry.test.ts:63-70. */
const fakeMcpManager: McpManager = {
  start: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
  status: () => [],
  listResources: () => Promise.reject(new Error("fake: list not stubbed")),
  readResource: () => Promise.reject(new Error("fake: read not stubbed")),
} as unknown as McpManager;

/** #502 T4 fake backgroundManager — sufficient for assembly (handler 永不触达)。 */
const fakeBackgroundManager: BackgroundTaskManager = {
  spawn: () => Promise.reject(new Error("fake: spawn not stubbed")),
  status: () => Promise.reject(new Error("fake: status not stubbed")),
  output: () => Promise.reject(new Error("fake: output not stubbed")),
  stop: () => Promise.reject(new Error("fake: stop not stubbed")),
  shutdown: () => Promise.resolve(),
  registerConversationDeletedListener: () => undefined,
  onConversationDeleted: () => undefined,
} as unknown as BackgroundTaskManager;

/** ADR-0037 worktree isolation host fakes —— sufficient for assembly。
 * handler 路径单测在各自工具目录下,本文件只验证 description D9 闸门。 */
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

describe("#483 D9 — regression guard: every ACI tool description avoids NEGATIVE_PHRASES", () => {
  // review C1: 默认路径 ledger-aware 后，spawn_subagent 描述会从
  // createMergedCatalogResolver() 自解析，构造 prose list 时拼上
  // <home>/.iknow/plugins 下所有插件 agent 的 description。本 guard
  // 测的是**工具自身的固定文案**（do not / never 等负面祈使），不
  // 应被本机已装插件 agent 文案污染 —— 显式注入 builtin-only
  // resolver 让 prose list 只含 builtin，与本机环境解耦（registry
  // 装配缝的 `agentCatalog` opt，review C1 接线）。
  const builtinOnlyCatalog = {
    list: () => resolveAgentCatalog(),
    get: (id: string) => getAgentEntry(id),
  };
  // Assemble once for the whole suite. Reusing the same registry across
  // every assertion keeps the test cheap and guarantees a stable tool set.
  const reg = createDefaultAciRegistry({
    env: makeWebEnv(),
    sandboxRoot: "/tmp/root",
    memoryDir: "/tmp/root/memory",
    skillCatalog: createSkillCatalog([]),
    subagentManager: fakeSubagentManager,
    todoDir: "/tmp/root/session-1/todos",
    mcpManager: fakeMcpManager,
    backgroundManager: fakeBackgroundManager,
    // D-α T3:graph overlay 在场 → run_graph 入注册表（描述同受 D9 闸门约束）。
    graphAssembly: { enabled: () => true },
    // worktree isolation (ADR-0037):3 件条件化装配,host 缝在场才入注册表。
    worktreeProvision: fakeWorktreeProvision,
    worktreeEnter: fakeWorktreeEnter,
    worktreeExit: fakeWorktreeExit,
    worktreeList: fakeWorktreeList,
    worktreeRemove: fakeWorktreeRemove,
    agentCatalog: builtinOnlyCatalog,
  });

  // Sanity: the registry assembled with every conditional dep present contains
  // the whole toolset. If this drifts, the gate below would silently cover a
  // smaller set — surface the drift explicitly so the failure mode is
  // unambiguous. (The count itself is pinned by the size test at the end.)
  it("registry contains the full ACI toolset (assembly sanity)", () => {
    const names = reg.catalog.all().map((t) => t.name);
    expect(names).toEqual([...ACI_TOOLSET_NAMES]);
  });

  // One assertion per NEGATIVE_PHRASE keeps the failure message pointed at
  // the offending word. Per-tool coverage lives in the it.each block below.
  it.each(NEGATIVE_PHRASES)(
    `no tool description contains the blocklist phrase "${"%s"}"`,
    (phrase) => {
      const lower = phrase.toLowerCase();
      const offenders = reg.catalog
        .all()
        .filter((t) => t.description.toLowerCase().includes(lower));
      expect(
        offenders,
        `phrase "${phrase}" leaked into: ${offenders
          .map((o) => `${o.name}`)
          .join(", ")}`
      ).toEqual([]);
    }
  );

  it("every tool has a non-empty description (sanity baseline)", () => {
    const empty = reg.catalog.all().filter((t) => t.description.length === 0);
    expect(
      empty,
      `tools with empty description: ${empty.map((o) => o.name).join(", ")}`
    ).toEqual([]);
  });

  // ── #502 T7 d9 扩面（扩张不削弱） ─────────────────────────────────────
  // 既有 blocklist / 全条件装配断言全部保留。

  it("every tool description carries positive-guidance substance (> 30 chars) — d9 扩面", () => {
    const tooShort = reg.catalog
      .all()
      .filter((t) => t.description.length <= 30);
    expect(
      tooShort,
      `descriptions too short to carry positive guidance: ${tooShort
        .map((o) => o.name)
        .join(", ")}`
    ).toEqual([]);
  });

  it("every tool description uses a positive trigger construct (use X / pair with Y / returns…) — d9 扩面", () => {
    const missing = reg.catalog
      .all()
      .filter((t) => !POSITIVE_TRIGGER_PATTERN.test(t.description));
    expect(
      missing,
      `descriptions without a positive trigger phrasing: ${missing
        .map((o) => o.name)
        .join(", ")}`
    ).toEqual([]);
  });

  // T7 核心：bash 顶层 description 必须把「长驻服务 → background:true /
  // bash_output / bash_stop」的正面回路写进模型可见字段（schema 字段描述
  // 只是第二道防线；模型在工具选择阶段读顶层 description）。本断言锁三
  // 件套关键词，RED 在 description 补强前触发，GREEN 在补强后。
  it('bash description documents the background-loop trio ("background: true" / "bash_output" / "bash_stop") — T7 核心', () => {
    const bash = reg.catalog.all().find((t) => t.name === "bash");
    expect(bash).toBeDefined();
    const desc = bash!.description.toLowerCase();
    expect(desc).toContain("background: true");
    expect(desc).toContain("bash_output");
    expect(desc).toContain("bash_stop");
  });

  // Pre-#483 D9 baseline would have included bash's "Don't have a dedicated
  // tool" and a number of imperative "do not" / "never" fragments. After the
  // audit, what this file pins is that every tool in the assembled catalog is
  // positive-trigger phrased (the it.each blocklist assertions higher up) plus
  // that the assembly sanity check above really covers the whole toolset.
  it("toolset size after audit: 43 (full conditional-deps assembly, incl. task worktree discovery/removal; T5 退役 10 lsp_*; disclosure-index-align T2 退役 skill_search)", () => {
    expect(ACI_TOOLSET_NAMES).toHaveLength(43);
    expect(reg.catalog.all()).toHaveLength(43);
  });

  // ── ADR-0084 / D7：写闸与 read 窗的说明书义务（无轨迹集时的 STATIC 锁）─
  // read_file / write_file 本次改了 description 与失败文案，黄金集名册里这两
  // 件没有轨迹集（见 docs/guides/prompt-development.md 与 commit 正文的缺口
  // 登记）。轨迹集缺失期间，至少把「模型可见面必须说清的新契约」钉在
  // STATIC 层：写闸要模型先 read_file、read 窗不得再宣称默认 200 行。
  it("write_file description names read_file as the freshness precondition — ADR-0084 D7", () => {
    const writeFile = reg.catalog.all().find((t) => t.name === "write_file");
    expect(writeFile).toBeDefined();
    const desc = writeFile!.description.toLowerCase();
    expect(desc).toContain("read_file");
    expect(desc).toContain("edit_file");
    // 空文件 / 新建免检必须写在模型可见面，否则模型会对新建也先做一次无谓读。
    expect(desc).toContain("brand-new");
  });

  it("read_file description describes EOF-by-default and the 16000-cp page, not a default line window — ADR-0084 D1c", () => {
    const readFile = reg.catalog.all().find((t) => t.name === "read_file");
    expect(readFile).toBeDefined();
    const desc = readFile!.description.toLowerCase();
    expect(desc).toContain("end of file");
    expect(desc).toContain("16000");
    expect(desc).toContain("offset");
    // 旧契约的默认 200 行不得再出现在模型可见面。
    expect(desc).not.toContain("default 200");
    expect(desc).not.toContain("200 lines");
    // 单行超页预算时的行内截断没有 offset 续读路径 —— 模型可见面必须说清，
    // 否则模型会照续读提示在同一 offset 上打转（ADR-0006 D4 无静默截断）。
    expect(desc).toContain("truncation marker");
    expect(desc).toContain("not reachable via offset paging");
  });

  // symbol-primary-aci T2：符号查询工具的 description 必须按**符号身份**
  // 行文——出现「line N / character M」类必填措辞即回到坐标主路径，spec
  // 「禁止把第几行第几列当作这些工具的主入参」被破坏。
  it("symbol query tool descriptions describe symbol identity, not line/character — T2", () => {
    const symbolTools = [
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
    ];
    const offenders = reg.catalog
      .all()
      .filter((t) => symbolTools.includes(t.name))
      .filter((t) =>
        /\bline\b|\bcharacter\b|0-based|1-based/i.test(t.description)
      );
    expect(
      offenders,
      `coordinate phrasing leaked into: ${offenders.map((o) => o.name).join(", ")}`
    ).toEqual([]);
    // 反向：每件都点名 symbol / symbol_path（identity-first 措辞在场）。
    const withoutIdentity = reg.catalog
      .all()
      .filter((t) => symbolTools.includes(t.name))
      .filter((t) => !/symbol/i.test(t.description));
    expect(withoutIdentity.map((t) => t.name)).toEqual([
      // 诊断按文件提问，无符号身份可谈（spec 列表里它就是文件级工具）。
      "get_diagnostics_for_file",
    ]);
  });
});
