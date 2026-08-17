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
 *     so every tool (including the 3 already-D9-compliant ones: todo_write,
 *     list_mcp_resources, read_mcp_resource) is exercised.
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
import type { IknowEnv } from "../../../../src/config/env.js";
import type { SubAgentManager } from "../../../../src/harness/subagent/manager.js";
import type { McpManager } from "../../../../src/harness/mcp/manager.js";

/** #483 D9: 12-word blocklist — mirrors tests/harness/aci/tools/todo-write.test.ts:533. */
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

/** Minimal env (only web fields are consumed by the registry factory). */
function makeWebEnv(): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined } };
}

/** Fake SubAgentManager — sufficient for assembly. Mirrors registry.test.ts:51-57. */
const fakeSubagentManager: SubAgentManager = {
  spawn: () => ({ taskId: "fake-id" }),
  queryBuffer: () => ({ status: "not_found" }),
  waitFor: () => Promise.reject(new Error("not used")),
  shutdown: () => Promise.resolve(),
  drainCompleted: () => [],
  listActive: () => [],
  abortTask: () => false,
  // #358 T7: 接口新增只读枚举面 —— fake 补全保持结构兼容。
  listSubagents: () => [],
};

/** Fake McpManager — sufficient for assembly. Mirrors registry.test.ts:63-70. */
const fakeMcpManager: McpManager = {
  start: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
  status: () => [],
  listResources: () => Promise.reject(new Error("fake: list not stubbed")),
  readResource: () => Promise.reject(new Error("fake: read not stubbed")),
} as unknown as McpManager;

describe("#483 D9 — regression guard: every ACI tool description avoids NEGATIVE_PHRASES", () => {
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
  });

  // Sanity: registry assembled with the full 28-tool toolset. If this drifts,
  // the gate below would silently cover a smaller set — surface the drift
  // explicitly so the failure mode is unambiguous.
  it("registry contains the full 28-tool ACI toolset (assembly sanity)", () => {
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

  // Pre-#483 D9 baseline would have included bash's "Don't have a dedicated
  // tool" and a number of imperative "do not" / "never" fragments. After the
  // audit, the only thing we pin is that all 28 tools are positive-trigger
  // phrased — verified structurally by the blocklist assertions above.
  it("toolset size after audit: 28 (full conditional-deps assembly)", () => {
    expect(ACI_TOOLSET_NAMES).toHaveLength(28);
    expect(reg.catalog.all()).toHaveLength(28);
  });
});
