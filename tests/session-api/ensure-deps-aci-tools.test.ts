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

// #194 T6 (Layer 4 baseline):扩 memory_recall + memory_save 到 10 件;
// #224 末尾追加 tool_search(11 件;与 tests/harness/build-engine.test.ts
// EXPECTED_TOOLS 同形)。
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
];

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-ensure-deps-"));
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("SessionHub.ensureDeps (lazy SSOT delegation)", () => {
  it("returns the ACI 11-tool registry when serve constructs without deps", async () => {
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
