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
// registry 末尾追加 spawn_subagent / subagent_result(→ 25 件)。
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
  // #337 T5 skill 工具集 append-only:21→23,末尾两件(skillCatalog 装配后
  // 静态名单;与 ACI_TOOLSET_NAMES 对齐)。
  "skill",
  "skill_search",
  // #356 T6 subagent 工具集 append-only:23→25,末尾两件(serve 走 build-engine
  // 全装配,subagentManager 自建 → 两件在场)。
  "spawn_subagent",
  "subagent_result",
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
  it("returns the ACI 25-tool registry when serve constructs without deps", async () => {
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
    });
    const ensure = (
      hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
    ).ensureDeps.bind(hub);

    const deps = await ensure();
    const names = deps.registry.list().map((def) => def.name);
    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
  });
});
