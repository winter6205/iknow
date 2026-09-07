/**
 * `SessionHub.ensureDeps` integration pin (code-review 2026-08-05).
 *
 * The fix for "serve mode stuck on echo/get_time stubs" is the SSOT
 * delegation in `src/session-api/hub.ts::ensureDeps`. The harness-level
 * test in `tests/harness/build-engine.test.ts` covers the SSOT directly;
 * this test covers the *wiring* — that calling `ensureDeps` on a hub
 * constructed without `deps` (the lazy path serve uses) returns the same
 * ACI 11-tool registry the CLI gets.
 *
 * Uses `createNoAskUser` so the permission middleware is bypassed (it is
 * not exercised here; the CLI path has its own coverage). The test
 * intentionally never calls `postMessage` — that would require a real LLM
 * response. The lookup of the private `ensureDeps` uses a typed escape
 * hatch (`as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }`)
 * rather than exposing internals; if SSOT is moved, this test breaks
 * at the assignment and signals the refactor.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { installTestSettingsSource } from "../_helpers/install-test-settings-source.ts";

// #194 T6 (Layer 4 baseline):扩 memory_recall + memory_save 到 10 件;
// #224 末尾追加 tool_search(11 件;与 tests/harness/build-engine.test.ts
// EXPECTED_TOOLS 同形)。
// #356 T6:build-engine 全装配(surface 默认 chat)自建 subagentManager →
// registry 末尾追加 spawn_subagent / subagent_result(→ 14 件)。
// #440 双 Stream 并集:todo_write(T4) + MCP resources 两件(T11) append-only
// 14→17(serve 走 build-engine 全装配,todoDir + mcpManager 均自建 → 三件在场)。
// #502 T3:serve surface !== "ask" → build-engine 自建 backgroundManager →
// registry 末尾追加 bash_output / bash_stop(→ 19 件,与 build-engine 全装配同形)。
// ADR-0041 / plans/model-prefix-layering.md B3:run_graph 常驻 append-only:
// 19→20,末位 1 件(serve 全装配含 subagentManager → run_graph 入注册表)。
// symbol-primary-aci T5:10 件 lsp_* 已退役,总数由 30 → 25。
// disclosure-index-align T2 / SC5:skill_search 已删,总数由 25 → 24。
// 13..18 与 build-engine.test.ts 的 EXPECTED_TOOLS 同位 —— ssot 真值一致。
const EXPECTED_TOOLS = [
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
  // #337 T5 skill 工具集 append-only:11→12,末尾 1 件(skillCatalog 装配后
  // 静态名单;disclosure-index-align T2 删 skill_search 后只剩 1 件)。
  "skill",
  // #356 T6 subagent 工具集 append-only:12→14,末尾两件(serve 走 build-engine
  // 全装配,subagentManager 自建 → 两件在场)。
  "spawn_subagent",
  "subagent_result",
  // #440 T4 todo_write append-only:14→15,末位 1 件(serve T1-fix 后透传 todoDir →
  // 在场 — 与 build-engine 装配侧一致)。
  "todo_write",
  // #440 T11 MCP resources 工具集 append-only:15→17,末尾两件(serve 走
  // build-engine 全装配,mcpManager 自建 → 两件在场)。
  "list_mcp_resources",
  "read_mcp_resource",
  // #502 T3 bash_output / bash_stop 工具集 append-only:17→19,末位 2 件
  // (serve 走 build-engine 全装配,backgroundManager 自建 → bash_output/bash_stop
  // 入注册表;bash 仍常驻,参数级 background:true 能力由 handler 运行时决策)。
  "bash_output",
  "bash_stop",
  // ADR-0041 / plans/model-prefix-layering.md B3:run_graph 常驻 ——
  // 仅 subagentManager 缺席才不在注册表(graphAssembly 缺席由 handler
  // isEnabled 缺省恒关守门,工具面成员不变)。serve 全装配含 subagentManager
  // → run_graph 入注册表,与 promptTools 邻轮 byte-identical。
  "run_graph",
  "query_trace",
  // symbol-primary-aci T2 符号查询工具集 append-only:20→30,末位 10 件常驻
  //（与 lsp.ts SSOT 共享 lspCtx；旧 10 件 lsp_* 已在 T5 退役）。
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
  // symbol-primary-aci T4 符号改工具集 append-only:30→35,末位 5 件常驻
  //（category=write；不条件化——与查询面共享 lspCtx；onEdit
  //  透传自 build-engine lspNotifier.invalidate，写盘后 textDocument/didChange
  //  与 edit_file 同链路）。
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
  "safe_delete_symbol",
  // trace-mcp-read-side-split T5b list_sessions append-only:35→36,末位 1 件常驻
  //（读侧目录轴,无装配条件 → serve 全装配必在场;与 build-engine 同形)。
  "list_sessions",
  // trace-mcp-read-side-split T6 get_record append-only:36→37,末位再加 1 件常驻
  //（读侧内容轴,与目录轴同样无装配条件 → serve 全装配必在场;三轴顺序 = append
  //  顺序,不重排既有件)。
  "get_record",
];

let baseDir: string;
let store: SessionStore;
let settingsSource: ReturnType<typeof installTestSettingsSource>;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-ensure-deps-"));
  store = new SessionStore(baseDir);
  // #164 第二阶段：IKNOW_LLM_MODEL 已退役，ensureDeps → buildHarnessEngine 装配
  // 路径需要 settings.llm.model + apiKey 来源 → HOME 重定向到 tmp。
  settingsSource = installTestSettingsSource();
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
  settingsSource.restore();
});

describe("SessionHub.ensureDeps (lazy SSOT delegation)", () => {
  it("returns the ACI 24-tool registry (incl. todo_write + run_graph) when serve constructs without deps", async () => {
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
    });
    const ensure = (
      hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
    ).ensureDeps.bind(hub);

    const deps = await ensure();
    const names = deps.registry.list().map((def) => def.name);
    // #440 T1-fix:serve 入口注入 todoDir → todo_write 装配,SSOT 24 件全在场
    // （T5 退役 10 lsp_* 后从 30 → 25;disclosure-index-align T2 删 skill_search 后从 25 → 24;ADR-0041 B3 再 +1 run_graph 常驻 → 25,删 skill_search → 24）。
    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
    expect(names).toContain("todo_write");
    expect(names).toContain("run_graph");
  });
});

// 写根 trailer（specs/skill-load-write-root.md T3）：serve lazy 装配路径下
// hub 捕获 BuiltEngine.liveTaskRoot，loadSkillBody 调用时机读快照 ——
// Web getSkillBody 后端与 ACI skill() / TUI slash 同一装配口。
describe("SessionHub.loadSkillBody — 写根 trailer（lazy 装配路径）", () => {
  it("build-engine 装配后 loadSkillBody 正文末尾带当前写根", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const skillDir = join(baseDir, "skills-wrt", "wrt-echo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: wrt-echo\ndescription: echo\n---\nbody line\n",
      "utf8"
    );
    // 扫描根注入：IKNOW_SKILL_DIRS 是 scanner 三级通道之一（G1 Q6），
    // tmp fixture 走此通道进 catalog，不依赖 cwd/.iknow 约定。
    const prevSkillDirs = process.env.IKNOW_SKILL_DIRS;
    process.env.IKNOW_SKILL_DIRS = join(baseDir, "skills-wrt");
    let cell: { read(): string } | undefined;
    try {
      const hub = new SessionHub({
        store,
        askUser: createNoAskUser(),
      });
      const load = hub as unknown as {
        ensureDeps: () => Promise<LoopEngineDeps>;
        loadSkillBody: (
          name: string
        ) => Promise<{ name: string; body: string }>;
        liveTaskRoot?: { read(): string };
      };
      await load.ensureDeps();
      // hub 已捕获 BuiltEngine.liveTaskRoot（初值 = 装配期 taskRoot）。
      cell = load.liveTaskRoot;
      assert.ok(cell, "lazy 装配后 hub 必须持有 live taskRoot cell");
      const { body } = await load.loadSkillBody("wrt-echo");
      assert.ok(body.includes("body line"));
      assert.ok(
        body.includes(
          "current write root (for write_file / edit_file / bash cwd):"
        ),
        "正文末尾必须带与 worker prior 同一文案的写根段"
      );
      assert.ok(body.includes(cell.read()));
      assert.ok(body.trimEnd().includes("</skill_files>"));
    } finally {
      if (prevSkillDirs === undefined) {
        delete process.env.IKNOW_SKILL_DIRS;
      } else {
        process.env.IKNOW_SKILL_DIRS = prevSkillDirs;
      }
    }
  });
});
