/**
 * Sub-agent worker tool surface end-to-end assertions
 * (declared face = actual face / judge read-only / backward compatibility).
 *
 * Walks the real `createWorkerDeps` assembly path (no stub-registry
 * stand-in), keeping it hermetic with stub-model + noop trace + empty skill
 * catalog — no real LLM calls / no disk writes / no fs scans.
 *
 * Assertion shape (per the established Code Style + Boundaries Always):
 *   - AciRegistry.inner (the executor's actual executable face, a frozen
 *     snapshot at construction, read by loop-engine via deps.registry.list())
 *     + AciRegistry.visibleSchemas (the model-visible promptTools face, read
 *     via deps.promptTools()) stay in sync on both faces — declared face =
 *     actual face is guaranteed by construction (def-list pruning at
 *     registry.ts:280-296 + buildWorkerToolSurface as an idempotent backstop),
 *     not by after-the-fact patching.
 *
 * Worker assembly traits: createWorkerDeps passes no subagentManager /
 * memoryDir / todoDir / mcpManager / backgroundManager / graphAssembly
 * (worker.ts:141-146) -> 9 conditionally-absent tools (see the
 * WORKER_BASE_SURFACE comment below for the roster). This test additionally
 * passes `skillCatalog: createSkillCatalog([])` explicitly so skill /
 * skill_search stay present to keep the full surface assertable. Exact count
 * = WORKER_BASE_SURFACE.length, with the array as source of truth (the old
 * 10 lsp_* tools have retired and are not in WORKER_BASE_SURFACE).
 */

import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import {
  createWorkerDeps,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import { ACI_TOOLSET_NAMES } from "../../src/harness/aci/tools/registry.ts";
import {
  createTodoWriteTool,
  resolveConversationTodoPath,
} from "../../src/harness/aci/tools/todo-write.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import { assessSubagentIsolation } from "../../src/harness/subagent/capability.ts";
import {
  FILE_WRITE_TOOL_NAMES,
  SYMBOL_MUTATE_TOOL_NAMES,
} from "../../src/harness/aci/tools/symbol-mutate.ts";

// ---------------------------------------------------------------------------
// Constants & fixtures
// ---------------------------------------------------------------------------

/**
 * Mirror of the JUDGE_ROLE source of truth (run-classifier-adapter.ts:35-41
 * is module-private, unimportable; drift is guarded by this test).
 *
 * Judge allow-list derivation (fail-closed):
 *   deny = ACI_TOOLSET_NAMES − JUDGE_ALLOWED_BASELINE
 *
 * Same source as the truth: if the JUDGE_ROLE whitelist drifts, this test
 * failing is the explicit signal. Widening the whitelist = an explicit edit
 * to JUDGE_ALLOWED_BASELINE + operator sign-off.
 */
const JUDGE_ALLOWED_BASELINE: ReadonlyArray<string> = Object.freeze([
  "read_file",
  "grep",
  "glob",
]);

/** Mirror = full surface − whitelist baseline (same derivation as run-classifier-adapter). */
const JUDGE_DENY: ReadonlyArray<string> = Object.freeze(
  [...ACI_TOOLSET_NAMES].filter((n) => !JUDGE_ALLOWED_BASELINE.includes(n))
);

/** Minimal test IknowEnv — required by createWorkerDeps typing; no real requests. */
const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: { type: "disabled" },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
};

/**
 * The "full surface" name set after worker assembly (no deny-list). Exact
 * count = `WORKER_BASE_SURFACE.length`, with the array as source of truth
 * (no addition narratives in comments — they drift). The old 10 lsp_* tools
 * retired; WORKER_BASE_SURFACE no longer contains lsp_* names.
 *
 * Conditional absences (not assembled for workers):
 *   - memory_recall / memory_save (no memoryDir)
 *   - spawn_subagent / subagent_result (no subagentManager)
 *   - todo_write (no todoDir)
 *   - list_mcp_resources / read_mcp_resource (no mcpManager)
 *   - bash_output / bash_stop (no backgroundManager)
 *   - run_graph (no graphAssembly)
 *
 * This test injects skillCatalog explicitly so skill counts toward the set
 * (conditional: registered only when skillCatalog is present; after
 * skill_search's removal only 1 remains); exact count is governed by the
 * WORKER_BASE_SURFACE array length.
 */
const WORKER_BASE_SURFACE: ReadonlyArray<string> = Object.freeze([
  "bash",
  "read_file",
  "grep",
  "glob",
  "edit_file",
  "write_file",
  "web_fetch",
  "web_search",
  "tool_search",
  "skill",
  "query_trace",
  // 10 symbol-query tools resident (no manager dependency, share lspCtx with
  // the lsp.ts SSOT; the old 10 lsp_* tools already retired).
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
  // 5 symbol-mutate tools resident (category=write; share lspCtx with the query
  // face; onEdit goes through the worker assembly layer's lspNotifier.invalidate
  // seam — after a disk write, textDocument/didChange follows the same chain as edit_file).
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
  "safe_delete_symbol",
  // Operator ruling: list_sessions joins the worker base surface.
  // Same rationale as query_trace: only the directory axis can answer whether
  // the conversation_id a worker holds really exists; category=read-only, no
  // assembly conditions (every surface builds traceDir), hence unconditional.
  // Placed last = registry.list() follows ACI_TOOLSET_NAMES' append-only order.
  "list_sessions",
  // get_record follows the same operator ruling made for list_sessions: when a
  // worker already holds conversation_id / record_id, only the content axis can
  // answer "what does this record actually look like, should I keep drilling" —
  // without it the worker can only guess from query_trace row projections.
  // category=read-only, no assembly conditions (every surface builds traceDir),
  // hence unconditional. Placed last = registry.list() follows
  // ACI_TOOLSET_NAMES' append-only order.
  "get_record",
  // read_image is resident (category=read-only, no assembly conditions),
  // appended after ACI_TOOLSET_NAMES' tail into the worker base surface;
  // it is not in the default deny list and workers never strip it via disallowedTools.
  "read_image",
]);

// ---------------------------------------------------------------------------
// Parameterized helper — dual-face assertions (inner + visibleSchemas)
// ---------------------------------------------------------------------------

/**
 * Collect both tool-surface name sets after worker assembly (inner protocol
 * registry + promptTools model-visible) and assert:
 *   - every `denied` name is absent on both faces (declared = actual)
 *   - every `kept` name is present on both faces (kept tools are not pruned by mistake)
 *
 * Reused across normal / failure / boundary / judge cases.
 */
function assertSurface(
  deps: LoopEngineDeps,
  denied: readonly string[],
  kept: readonly string[]
): void {
  const innerNames = deps.registry.list().map((t) => t.name);
  const promptNames = deps.promptTools().map((t) => t.name);
  for (const name of denied) {
    assert.ok(
      !innerNames.includes(name),
      `inner.list() 不应含禁项 ${name}（declared = actual）`
    );
    assert.ok(
      !promptNames.includes(name),
      `promptTools() 不应含禁项 ${name}（declared = actual）`
    );
  }
  for (const name of kept) {
    assert.ok(innerNames.includes(name), `inner.list() 应含保留工具 ${name}`);
    assert.ok(promptNames.includes(name), `promptTools() 应含保留工具 ${name}`);
  }
}

/** Hermetic assembly seam: stub-model + empty skill catalog + noop trace + stub system. */
function hermeticOpts(
  extra?: Partial<CreateWorkerDepsOptions>
): CreateWorkerDepsOptions {
  return {
    env: TEST_ENV,
    sandboxRoot: "/tmp/sb",
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A. Happy path — declared deny-list fully effective (declared face = actual face)
// ---------------------------------------------------------------------------

describe("worker tool surface: 正常路径 — declared deny-list 全生效", () => {
  it("deny JUDGE 禁项（allow-list 推导）→ inner+visibleSchemas 双面 = 白名单三件", async () => {
    // Judge allow-list derivation: deny = full surface − {read_file, grep, glob};
    // after assembly both faces hold only the three whitelisted tools.
    // fail-closed: anything outside the whitelist is denied.
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: [...JUDGE_DENY] })
    );
    assertSurface(deps, JUDGE_DENY, ["read_file", "grep", "glob"]);
  });

  it("deny JUDGE 禁项 → 双面集合恰为白名单基线（与 WORKER_BASE_SURFACE - JUDGE_DENY 完全相等）", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: [...JUDGE_DENY] })
    );
    const expected = WORKER_BASE_SURFACE.filter((n) => !JUDGE_DENY.includes(n));
    assert.deepEqual(
      deps.registry.list().map((t) => t.name),
      [...expected]
    );
    assert.deepEqual(
      deps.promptTools().map((t) => t.name),
      [...expected]
    );
  });
});

// ---------------------------------------------------------------------------
// B. Failure path — lenient mode (buildWorkerToolSurface silently skips unknown names)
// ---------------------------------------------------------------------------

describe("worker tool surface: 失败路径 — 未知名宽容忽略（lenient）", () => {
  it("deny 含未知名 → 仅剔除已知名 bash,不抛、其余工具俱在", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        disallowedTools: ["bash", "foo_tool_does_not_exist"],
      })
    );
    // Known entries pruned, unknown names ignored leniently (buildWorkerToolSurface semantics).
    assertSurface(deps, ["bash"], ["read_file", "grep", "glob", "tool_search"]);
  });

  it("deny 全部为未知名 → 不裁剪, 工具面 = 全量面", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        disallowedTools: ["typo_a", "typo_b", "typo_c"],
      })
    );
    const innerNames = deps.registry.list().map((t) => t.name);
    const promptNames = deps.promptTools().map((t) => t.name);
    assert.deepEqual(innerNames, [...WORKER_BASE_SURFACE]);
    assert.deepEqual(promptNames, [...WORKER_BASE_SURFACE]);
  });
});

// ---------------------------------------------------------------------------
// C. Boundaries — undefined / empty / deny-all
// ---------------------------------------------------------------------------

describe("worker tool surface: 边界 — undefined / 空 / deny-all", () => {
  it("undefined → 双面 = WORKER_BASE_SURFACE 全量面", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    assert.deepEqual(
      deps.registry.list().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
    assert.deepEqual(
      deps.promptTools().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
  });

  // T2 / spec Layer 3 item 10 (input-contract row: nested spawn from worker
  // → reject): the worker registry is built without a subagentManager, so
  // `spawn_subagent` / `subagent_result` are structurally absent from both
  // faces — a grandchild spawn cannot even be expressed as a tool call.
  // Asserting the ABSENCE (not a runtime error message) is the stronger pin:
  // it holds no matter what the manager would have decided.
  it("worker 双面都不含 spawn_subagent / subagent_result（嵌套派发结构性不可达）", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    const inner = deps.registry.list().map((t) => t.name);
    const prompt = deps.promptTools().map((t) => t.name);
    assert.equal(inner.includes("spawn_subagent"), false);
    assert.equal(prompt.includes("spawn_subagent"), false);
    assert.equal(inner.includes("subagent_result"), false);
    assert.equal(prompt.includes("subagent_result"), false);
  });

  it("空数组 → 双面 = WORKER_BASE_SURFACE 全量面（与 undefined byte-identical）", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ disallowedTools: [] }));
    assert.deepEqual(
      deps.registry.list().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
    assert.deepEqual(
      deps.promptTools().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
  });

  it("deny 全量实际工具 → inner+promptTools 双面为空, createWorkerDeps 不 crash", async () => {
    // Gate 3 mirror filtering: after denying everything, toolsetNames and the
    // factories key set are empty simultaneously (both = ∅), guaranteed
    // throw-free by construction; the run path can fall back to text-only answers.
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: [...WORKER_BASE_SURFACE] })
    );
    assert.equal(deps.registry.list().length, 0);
    assert.equal(deps.promptTools().length, 0);
  });
});

// ---------------------------------------------------------------------------
// D. Permissions / judge read-only — JUDGE_ROLE allow-list derivation
// ---------------------------------------------------------------------------

describe("worker tool surface: 权限 — 判官只读（allow-list 推导）", () => {
  it("判官面双面恰为白名单三件（inner.list() 与 promptTools() = {read_file, grep, glob}）", async () => {
    // Judge deny = full surface − {read_file, grep, glob}; after assembly both
    // faces hold exactly the three whitelisted tools (fail-closed allow-list).
    // Overlaps semantically with the "A normal" tests but is asserted
    // independently — explicit naming pins this case when the whitelist changes.
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: [...JUDGE_DENY] })
    );
    const innerNames = deps.registry.list().map((t) => t.name);
    const promptNames = deps.promptTools().map((t) => t.name);
    assert.deepEqual(innerNames, [...JUDGE_ALLOWED_BASELINE]);
    assert.deepEqual(promptNames, [...JUDGE_ALLOWED_BASELINE]);
  });

  it("白名单外全部工具在 inner.list() 与 promptTools() 双面均缺席", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: [...JUDGE_DENY] })
    );
    const innerNames = deps.registry.list().map((t) => t.name);
    const promptNames = deps.promptTools().map((t) => t.name);
    for (const denied of JUDGE_DENY) {
      assert.ok(
        !innerNames.includes(denied),
        `判官 inner.list() 不应含 ${denied}`
      );
      assert.ok(
        !promptNames.includes(denied),
        `判官 promptTools() 不应含 ${denied}`
      );
    }
  });

  it("白名单外工具在 reg.catalog 也缺席（catalog 双层防护 / executor + permission middleware）", async () => {
    // Call createDefaultAciRegistry separately to verify the catalog side
    // (registry.inner does not expose catalog directly, but createWorkerDeps
    // already uses createDefaultAciRegistry internally, so here we reach the
    // catalog through the returned registry's inner structure — assert only
    // when catalog is exposed; otherwise lock just the inner + visibleSchemas faces).
    const { createDefaultAciRegistry } =
      await import("../../src/harness/aci/tools/registry.ts");
    const reg = createDefaultAciRegistry({
      env: TEST_ENV,
      sandboxRoot: "/tmp/sb",
      skillCatalog: createSkillCatalog([]),
      disallowedTools: [...JUDGE_DENY],
    });
    // Both faces are already covered via the worker assembly path; catalog is a
    // secondary assertion (shared by the permission middleware and lazy
    // loading — absence there means catalog.get also returns undefined).
    for (const denied of JUDGE_DENY) {
      assert.equal(
        reg.catalog.get(denied),
        undefined,
        `判官 catalog.get(${denied}) 应返回 undefined`
      );
    }
  });
});

describe("worker tool surface: 隔离门禁 — symbol 写工具", () => {
  it("真实 explore worker 工具面不含 symbol 写工具且判为只读", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const workerToolNames = deps.registry.list().map((tool) => tool.name);

    for (const name of SYMBOL_MUTATE_TOOL_NAMES) {
      assert.ok(
        !workerToolNames.includes(name),
        `真实 worker 工具面不应包含 ${name}`
      );
    }

    const decision = assessSubagentIsolation({
      role: "explore",
      availableTools: workerToolNames,
    });
    assert.equal(decision.conclusion, "readonly");
    assert.equal(decision.reason, "write_tools_denied_bash_readonly");
  });

  it("真实 explore worker 工具面不含文件写工具时仍判为只读", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        role: "explore",
        disallowedTools: [...FILE_WRITE_TOOL_NAMES],
      })
    );
    const workerToolNames = deps.registry.list().map((tool) => tool.name);

    for (const name of FILE_WRITE_TOOL_NAMES) {
      assert.ok(
        !workerToolNames.includes(name),
        `真实 worker 工具面不应包含 ${name}`
      );
    }

    const decision = assessSubagentIsolation({
      role: "explore",
      availableTools: workerToolNames,
      disallowedTools: [...FILE_WRITE_TOOL_NAMES],
    });
    assert.equal(decision.conclusion, "readonly");
    assert.equal(decision.reason, "write_tools_denied_bash_readonly");
  });
});

describe("worker tool surface: T3 catalog deny contract", () => {
  it("intentionally narrows an explore worker surface while preserving the role wire bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t3-role-worker-"));
    const payloads: WorkerEnvelope[] = [];
    const manager = createSubAgentManager({
      sandboxRoot: root,
      spawn: (_def, _taskId, payload) => {
        payloads.push(payload);
        return spawnChild(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          {
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
      },
    });

    try {
      // T3-before measurement: the same role/no-parent-deny input exposed
      // edit_file and write_file. Current assembly deliberately consumes the
      // catalog deny because leaving those tools available is a write bypass.
      const deps = await createWorkerDeps(
        hermeticOpts({ sandboxRoot: root, role: "explore" })
      );
      const workerToolNames = deps.registry.list().map((tool) => tool.name);
      assert.ok(!workerToolNames.includes("edit_file"));
      assert.ok(!workerToolNames.includes("write_file"));
      assert.ok(!workerToolNames.includes("rename_symbol"));

      const tool = createSpawnSubAgentTool({ manager });
      await tool.handler({
        title: "explore only",
        task: "explore-only",
        subagent_type: "explore",
        wait: false,
      });

      assert.equal(payloads.length, 1);
      assert.equal(
        JSON.stringify(payloads[0]),
        JSON.stringify({
          task: "explore-only",
          sandboxRoot: root,
          disallowedTools: [...FILE_WRITE_TOOL_NAMES],
          role: "explore",
          // Without isolationOn, manager defaults to isolation OFF +
          // sandboxRoot (non-tree) -> writable_main; byte-equal to the pre-change
          // worker prior shape.
          writeSituation: "writable_main",
        })
      );
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E. Empty / invalid / legacy wire — WorkerEnvelope without disallowedTools
// ---------------------------------------------------------------------------

describe("worker tool surface: 向后兼容 — 旧 wire 无 disallowedTools 字段", () => {
  it("WorkerEnvelope 缺 disallowedTools → createWorkerDeps 透传 undefined → 双面 = 全量面", async () => {
    // Legacy wire carries no disallowedTools field (manager.ts may serialize
    // without a declared deny-list, or an older envelope lacks the field
    // entirely) — simulate with a hand-built envelope.
    const oldEnvelope: WorkerEnvelope = {
      task: "investigate legacy wire",
      sandboxRoot: "/tmp/sb",
    };
    assert.equal(
      oldEnvelope.disallowedTools,
      undefined,
      "测试 fixture: 旧 wire 缺 disallowedTools"
    );
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: oldEnvelope.disallowedTools })
    );
    assert.deepEqual(
      deps.registry.list().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
    assert.deepEqual(
      deps.promptTools().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
  });
});

// ---------------------------------------------------------------------------
// F. Concurrency — N/A (worker assembly is a one-shot synchronous prune at
//    process start; no concurrent window)
// ---------------------------------------------------------------------------

describe("worker tool surface: 并发 N/A — 占位说明", () => {
  it("worker 装配路径同步一次性, 无并发窗口", () => {
    // Comment placeholder — worker assembly = the synchronous
    // createDefaultAciRegistry call inside createWorkerDeps; def-list pruning
    // happens before createAciRegistry(tools) (construction guarantees inner is
    // a frozen snapshot, aci-registry.ts:20). No concurrent window, no concurrency case needed.
    assert.equal(true, true);
  });
});

// ---------------------------------------------------------------------------
// ADR-0085 — worker and parent session share the same ledger (the old
// "worker has no todo_write" contract is superseded by ADR-0085).
//
// New invariants (replacing the old four):
//   1. envelope.todoLedger present -> todo_write **is** on the worker's dual
//      tool surface (not "tool absent" — the model must be able to read the
//      refusal reason for `add`);
//   2. the worker's read / update land on the parent session's ledger (the
//      same todos.md file);
//   3. the worker's `add` is a typed refusal by the tool itself
//      (ToolExecutionError + `[todo_write]` prefix), file untouched;
//   4. two parent sessions' ledgers never cross (one book per conversationId, ids don't mix).
//   5. envelope lacks todoLedger (legacy wire) -> falls back to the absent
//      shape, byte-stable.
// ---------------------------------------------------------------------------

describe("worker tool surface: ADR-0085 SC9 — worker 共用父会话账本", () => {
  it("worker 装配路径不传 memoryDir → memory_recall / memory_save 均缺席(条件化未回退)", async () => {
    const deps = await buildWorkerWithFullSkillCatalog();
    const names = deps.registry.list().map((d) => d.name);
    assert.ok(!names.includes("memory_recall"));
    assert.ok(!names.includes("memory_save"));
  });

  it("envelope.todoLedger 缺席（旧 wire）→ inner + promptTools 双面均不含 todo_write", async () => {
    // Legacy wire / cross-version resume shape: the worker tool surface keeps
    // its pre-ADR-0085 roster, never drifting due to the new field's existence.
    const deps = await buildWorkerWithFullSkillCatalog();
    assertSurface(deps, ["todo_write"], [...WORKER_BASE_SURFACE]);
  });

  it("envelope.todoLedger 在场 → todo_write 在 inner + promptTools 双面（工具在场,非静默缺席）", async () => {
    const todoDir = await mkdtemp(join(tmpdir(), "iknow-sc9-worker-"));
    try {
      const deps = await buildWorkerLedgerDeps({
        todoLedger: { projectDir: todoDir, conversationId: "conv-parent" },
      });
      assertSurface(deps, [], [...WORKER_BASE_SURFACE, "todo_write"]);
      // Dual-face count = base surface + 1 (todo_write is the only increment).
      assert.equal(deps.registry.list().length, WORKER_BASE_SURFACE.length + 1);
    } finally {
      await rm(todoDir, { recursive: true, force: true });
    }
  });

  it("worker read / update 落在父会话账本上（同一个 todos.md）", async () => {
    const todoDir = await mkdtemp(join(tmpdir(), "iknow-sc9-shared-"));
    try {
      const conversationId = "conv-parent-shared";
      // Parent session writes two entries first (parent path = same projectDir + same conversationId).
      const parent = createTodoWriteTool({ todoDir, actor: { canAdd: true } });
      await parent.handler(
        { mode: "add", items: ["parent step 1", "parent step 2"] },
        { conversationId }
      );

      const deps = await buildWorkerLedgerDeps({
        todoLedger: { projectDir: todoDir, conversationId },
      });
      const tool = deps.registry.get("todo_write");
      assert.ok(tool, "worker surface 必须含 todo_write");

      // Worker has no ctx (the worker process executor never synthesizes a
      // conversationId) — the path falls back to deps.actor.conversationId,
      // resolving to the parent ledger.
      const seen = (await tool.handler({ mode: "read" })) as string;
      assert.match(seen, /\[t1\] parent step 1/);
      assert.match(seen, /\[t2\] parent step 2/);

      const receipt = await tool.handler({
        mode: "update",
        id: "t1",
        status: "completed",
      });
      assert.equal(receipt, "Updated t1: status=completed");

      // Parent readback: sees the worker's edits — same ledger (the physical file is the parent session's path).
      const parentView = (await parent.handler(
        { mode: "read" },
        { conversationId }
      )) as string;
      assert.match(parentView, /\[x\] \[t1\] parent step 1/);
      assert.match(
        await readFile(
          resolveConversationTodoPath({
            projectDir: todoDir,
            conversationId,
          }),
          "utf8"
        ),
        /\[x\] \[t1\] parent step 1/
      );
    } finally {
      await rm(todoDir, { recursive: true, force: true });
    }
  });

  it("worker `add` → 工具自身 typed 拒绝（[todo_write] 前缀 + parent-only），文件不动", async () => {
    const todoDir = await mkdtemp(join(tmpdir(), "iknow-sc9-add-"));
    try {
      const conversationId = "conv-parent-add";
      const parent = createTodoWriteTool({ todoDir });
      await parent.handler(
        { mode: "add", item: "parent owns additions" },
        { conversationId }
      );

      const deps = await buildWorkerLedgerDeps({
        todoLedger: { projectDir: todoDir, conversationId },
      });
      const tool = deps.registry.get("todo_write");
      assert.ok(tool);

      await assert.rejects(
        tool.handler({ mode: "add", item: "worker addition" }),
        (err: unknown) => {
          assert.ok(
            err instanceof ToolExecutionError,
            "typed error,非静默丢弃"
          );
          assert.match((err as Error).message, /^\[todo_write\]/);
          assert.match((err as Error).message, /parent-only/);
          return true;
        }
      );

      // The refusal happens before any disk write: the parent ledger holds only the parent session's entry.
      const onDisk = await readFile(
        resolveConversationTodoPath({ projectDir: todoDir, conversationId }),
        "utf8"
      );
      assert.equal(onDisk, "- [ ] [t1] parent owns additions\n");
    } finally {
      await rm(todoDir, { recursive: true, force: true });
    }
  });

  it("两个父会话的账本互不交叉：A 的 worker 读不到也改不到 B 的条目", async () => {
    const todoDir = await mkdtemp(join(tmpdir(), "iknow-sc9-isolation-"));
    try {
      const convA = "conv-aaa";
      const convB = "conv-bbb";
      const parent = createTodoWriteTool({ todoDir });
      await parent.handler(
        { mode: "add", item: "A-item" },
        { conversationId: convA }
      );
      await parent.handler(
        { mode: "add", item: "B-item" },
        { conversationId: convB }
      );

      // A's worker (assembly anchor = A's conversationId).
      const depsA = await buildWorkerLedgerDeps({
        todoLedger: { projectDir: todoDir, conversationId: convA },
      });
      const toolA = depsA.registry.get("todo_write");
      assert.ok(toolA);

      const seenByA = (await toolA.handler({ mode: "read" })) as string;
      assert.match(seenByA, /A-item/);
      assert.ok(!seenByA.includes("B-item"), "A 的 worker 不得看见 B 的账本");

      // A's worker updates using B's id -> in A's ledger t1 is A's own entry,
      // so the criterion here is "B's ledger untouched byte for byte" (id
      // spaces overlap by design; the file axis is the isolation axis).
      await toolA.handler({ mode: "update", id: "t1", status: "completed" });

      const pathA = resolveConversationTodoPath({
        projectDir: todoDir,
        conversationId: convA,
      });
      const pathB = resolveConversationTodoPath({
        projectDir: todoDir,
        conversationId: convB,
      });
      assert.notEqual(pathA, pathB);
      assert.equal(await readFile(pathA, "utf8"), "- [x] [t1] A-item\n");
      assert.equal(
        await readFile(pathB, "utf8"),
        "- [ ] [t1] B-item\n",
        "B 的账本不得被 A 的 worker 触碰"
      );

      // B's worker likewise sees nothing of A beyond none of A's edits.
      const depsB = await buildWorkerLedgerDeps({
        todoLedger: { projectDir: todoDir, conversationId: convB },
      });
      const seenByB = (await depsB.registry.get("todo_write")!.handler({
        mode: "read",
      })) as string;
      assert.ok(!seenByB.includes("A-item"));
      assert.match(seenByB, /B-item/);
    } finally {
      await rm(todoDir, { recursive: true, force: true });
    }
  });
});

/**
 * Walks the real createWorkerDeps assembly: inject stub-model + empty skill
 * catalog so skill is statically present (after skill_search's removal only 1
 * remains), without subagentManager or memoryDir (worker assembly traits).
 * By default no todoLedger — legacy wire form (the pre-ADR-0085 worker tool
 * surface). The return value carries deps.registry (what the executor really
 * sees) + deps.promptTools (what the model sees).
 */
async function buildWorkerWithFullSkillCatalog(
  extra?: Partial<CreateWorkerDepsOptions>
): Promise<LoopEngineDeps> {
  return createWorkerDeps(workerBaseOpts(extra));
}

/** ADR-0085 ledger cases only: assemble a worker registry anchored to the parent session's ledger. */
async function buildWorkerLedgerDeps(extra: {
  readonly todoLedger: { projectDir: string; conversationId: string };
}): Promise<LoopEngineDeps> {
  return buildWorkerWithFullSkillCatalog(extra);
}

/** Minimal hermetic createWorkerDeps opts (stub-model + empty skill + noop trace). */
function workerBaseOpts(
  extra?: Partial<CreateWorkerDepsOptions>
): CreateWorkerDepsOptions {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-worker-t5",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
  return {
    env,
    model: createStubModel({ responses: [] }),
    sandboxRoot: "/tmp/sandbox-worker-t5",
    trace: createNoopTraceService(),
    skillCatalog: createSkillCatalog([]),
    ...extra,
  };
}

/**
 * ADR-0092 — bash + write-tool descriptions: project writes go into taskRoot;
 * scratch writes go to the session tmp dir ($TMPDIR) without needing repo
 * entry. The write-root segment still only names the delivery root.
 */
describe("ADR-0092 — bash / write-tool descriptions name the session tmp", () => {
  it("bash, write_file, and edit_file point scratch writes at the session tmp dir ($TMPDIR)", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    const names = ["bash", "write_file", "edit_file"] as const;
    for (const name of names) {
      const tool = deps.registry.list().find((t) => t.name === name);
      assert.ok(tool, `worker surface missing ${name}`);
      assert.match(
        tool.description,
        /write into the project at taskRoot/i,
        `${name} description must name taskRoot as the project write`
      );
      assert.match(
        tool.description,
        /session tmp dir \(\$TMPDIR/i,
        `${name} description must name the session tmp dir for scratch files`
      );
    }
  });

  it("symbol mutate tools do not carry the fence-write guidance", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    for (const name of SYMBOL_MUTATE_TOOL_NAMES) {
      const tool = deps.registry.list().find((t) => t.name === name);
      assert.ok(tool, `worker surface missing ${name}`);
      assert.doesNotMatch(
        tool.description,
        /write into the project at taskRoot/i,
        `${name} must not reuse bash/write_file fence-write guidance`
      );
      assert.doesNotMatch(
        tool.description,
        /session tmp dir \(\$TMPDIR/i,
        `${name} must not reuse the session-tmp scratch guidance`
      );
    }
  });
});
